const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let sessions = [];
let activeId = null;
/** @type {Array<any>} */
let events = [];
let activeEventIdx = null;
/** @type {any} */
let boardData = null;

let selectedAgentId = null;
/** @type {Array<any>} */
let agentDeliveries = [];
let selectedDeliveryIdx = null;
let agentStatusFilter = "active";
/** @type {ReturnType<typeof setInterval> | null} */
let autoRefreshTimer = null;
let boardBusy = false;
let lastBoardAt = null;

function setLoading(on) {
  let bar = document.getElementById("global-loading");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "global-loading";
    bar.className = "loading-bar";
    const main = document.querySelector(".main");
    if (main) main.insertBefore(bar, main.firstChild);
  }
  bar.classList.toggle("on", !!on);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data.error || data.detail || text || res.status;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

function fmtTime(d = new Date()) {
  return d.toLocaleTimeString();
}

function setView(name) {
  $$(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#view-agents").classList.toggle("hidden", name !== "agents");
  $("#view-workflows").classList.toggle("hidden", name !== "workflows");
  $("#view-events").classList.toggle("hidden", name !== "events");
  $("#view-sessions").classList.toggle("hidden", name !== "sessions");
  $("#view-paths").classList.toggle("hidden", name !== "paths");
  $("#view-audit").classList.toggle("hidden", name !== "audit");
  $("#view-health").classList.toggle("hidden", name !== "health");
  $("#agent-filters").classList.toggle("hidden", name !== "agents");
  $("#workflow-filters").classList.toggle("hidden", name !== "workflows");
  $("#event-filters").classList.toggle("hidden", name !== "events");
  $("#session-filters").classList.toggle("hidden", name !== "sessions");
  $("#path-filters").classList.toggle("hidden", name !== "paths");
  if (name === "agents") loadBoard();
  if (name === "workflows") loadWorkflows();
  if (name === "health") loadHealth();
  if (name === "paths") loadPaths();
  if (name === "audit") loadAudit();
  if (name === "events") ensureAgentsLoaded();
  if (name === "sessions" && !sessions.length) loadSessions().catch(() => {});
}

function setupAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (!$("#auto-refresh").checked) return;
  const sec = Number($("#auto-refresh-sec").value || 30);
  autoRefreshTimer = setInterval(() => {
    // only auto-refresh when on agents view
    if ($("#view-agents") && !$("#view-agents").classList.contains("hidden")) {
      loadBoard();
    }
  }, Math.max(sec, 5) * 1000);
}

function boardToast(msg, kind) {
  const el = $("#board-toast");
  el.textContent = msg || "";
  el.classList.remove("err", "ok");
  if (kind) el.classList.add(kind);
}

function agentToast(msg, kind) {
  const el = $("#agent-ops-toast");
  el.textContent = msg || "";
  el.classList.remove("err", "ok");
  if (kind) el.classList.add(kind);
}

// ── Agents board ──────────────────────────────────────────

async function loadBoard() {
  if (boardBusy) return;
  boardBusy = true;
  setLoading(true);
  const err = $("#board-error");
  err.classList.add("hidden");
  const btn = $("#refresh-board");
  if (btn) btn.disabled = true;
  try {
    boardData = await api("/api/agents/board");
    lastBoardAt = new Date();
    renderBoard();
    if (selectedAgentId) {
      await loadAgentDetail(selectedAgentId, false);
    }
  } catch (e) {
    err.textContent = String(e.message || e);
    err.classList.remove("hidden");
    $("#agent-board").innerHTML = "";
  } finally {
    boardBusy = false;
    setLoading(false);
    if (btn) btn.disabled = false;
  }
}

function renderBoard() {
  if (!boardData) return;
  const hideIdle = $("#hide-idle").checked;
  const hideReserved = $("#hide-reserved").checked;
  const q = ($("#agent-filter")?.value || "").trim().toLowerCase();
  const sort = $("#agent-sort")?.value || "active";
  const t = boardData.totals || {};
  const autoOn = $("#auto-refresh")?.checked;
  $("#board-totals").innerHTML =
    (autoOn ? `<span class="pulse-dot" title="auto-refresh"></span>` : "") +
    `Σ pending ${t.pending || 0} · claimed ${t.claimed || 0} · acked ${t.acked || 0} · dead ${t.dead || 0}` +
    (boardData.db_ok ? "" : " · DB missing");
  if ($("#board-updated")) {
    $("#board-updated").innerHTML = lastBoardAt
      ? `更新于 ${escapeHtml(fmtTime(lastBoardAt))} · <span class="kbd">r</span> 刷新`
      : "";
  }

  if (boardData.error) {
    $("#board-error").textContent = boardData.error;
    $("#board-error").classList.remove("hidden");
  }

  let agents = boardData.agents || [];
  if (hideIdle) agents = agents.filter((a) => a.total_active > 0 || a.dead > 0);
  if (hideReserved) agents = agents.filter((a) => !a.reserved);
  if (q) {
    agents = agents.filter(
      (a) =>
        a.agent_id.toLowerCase().includes(q) ||
        (a.host || "").toLowerCase().includes(q) ||
        (a.notes || "").toLowerCase().includes(q) ||
        (a.owner || "").toLowerCase().includes(q),
    );
  }
  agents = [...agents].sort((a, b) => {
    if (sort === "name") return a.agent_id.localeCompare(b.agent_id);
    if (sort === "pending") return (b.pending || 0) - (a.pending || 0) || a.agent_id.localeCompare(b.agent_id);
    if (sort === "dead") return (b.dead || 0) - (a.dead || 0) || a.agent_id.localeCompare(b.agent_id);
    // active default
    if (b.total_active !== a.total_active) return b.total_active - a.total_active;
    if (b.pending !== a.pending) return b.pending - a.pending;
    return a.agent_id.localeCompare(b.agent_id);
  });

  const el = $("#agent-board");
  el.innerHTML = "";
  if (!agents.length) {
    el.innerHTML = `<div class="muted" style="padding:12px">没有可显示的 agent。关闭「隐藏无积压」可看全注册表。</div>`;
    return;
  }

  for (const a of agents) {
    const card = document.createElement("div");
    card.className =
      "agent-card" +
      (a.total_active > 0 || a.dead > 0 ? " has-work" : "") +
      (selectedAgentId === a.agent_id ? " active" : "");
    // reuse .item.active border via custom
    if (selectedAgentId === a.agent_id) {
      card.style.boxShadow = "0 0 0 1px rgba(91,157,255,0.35) inset";
      card.style.borderColor = "var(--accent)";
    }

    const pills = [];
    if (a.pending) pills.push(`<span class="stat pending">pending ${a.pending}</span>`);
    if (a.claimed) pills.push(`<span class="stat claimed">claimed ${a.claimed}</span>`);
    if (a.acked) pills.push(`<span class="stat acked">acked ${a.acked}</span>`);
    if (a.dead) pills.push(`<span class="stat dead">dead ${a.dead}</span>`);
    if (a.done) pills.push(`<span class="stat">done ${a.done}</span>`);
    if (!pills.length) pills.push(`<span class="stat">idle</span>`);

    const samples = (a.sample_pending || [])
      .slice(0, 3)
      .map((s) => {
        const summary =
          (s.payload && (s.payload.summary || s.payload.subject)) ||
          s.topic ||
          s.type ||
          "delivery";
        const corr = s.correlation_id
          ? ` · <span class="linkish" data-corr="${escapeHtml(s.correlation_id)}">wf</span>`
          : "";
        return `<div class="sample"><b>${escapeHtml(s.status)}</b> · ${escapeHtml(String(summary))}${corr}</div>`;
      })
      .join("");

    card.innerHTML = `
      <div class="ac-head">
        <span class="ac-name">${escapeHtml(a.agent_id)}</span>
        <span class="tag">${escapeHtml(a.host || (a.in_registry ? "registry" : "db-only"))}</span>
      </div>
      <div class="ac-meta">${escapeHtml([a.access, a.sla].filter(Boolean).join(" · ") || "—")}</div>
      <div class="pills">${pills.join("")}</div>
      ${
        a.oldest_pending_ts
          ? `<div class="ac-meta">oldest pending: ${escapeHtml(a.oldest_pending_ts)}</div>`
          : ""
      }
      ${samples ? `<div class="samples">${samples}</div>` : ""}
      <div class="card-actions">
        <button class="btn ghost btn-detail" type="button">详情</button>
        ${
          a.pending > 0
            ? `<button class="btn btn-claim" type="button">Claim ${Math.min(a.pending, 10)}</button>`
            : ""
        }
      </div>
    `;
    card.querySelector(".btn-detail").onclick = (e) => {
      e.stopPropagation();
      selectAgent(a.agent_id);
    };
    const claimBtn = card.querySelector(".btn-claim");
    if (claimBtn) {
      claimBtn.onclick = async (e) => {
        e.stopPropagation();
        claimBtn.disabled = true;
        try {
          await claimAgent(a.agent_id, Math.min(a.pending, 10));
        } finally {
          claimBtn.disabled = false;
        }
      };
    }
    card.querySelectorAll("[data-corr]").forEach((node) => {
      node.onclick = (e) => {
        e.stopPropagation();
        setView("workflows");
        openWorkflow(node.getAttribute("data-corr"));
      };
    });
    card.onclick = () => selectAgent(a.agent_id);
    el.appendChild(card);
  }
}

async function claimAgent(agentId, limit = 10) {
  boardToast(`Claiming ${agentId} ×${limit}…`);
  try {
    const data = await api("/api/events/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agentId, limit }),
    });
    const n = (data.events || []).length;
    boardToast(`Claimed ${n} for ${agentId}`, "ok");
    await loadBoard();
    await selectAgent(agentId);
    // switch filter to claimed
    agentStatusFilter = "claimed";
    $$(".stab").forEach((b) => b.classList.toggle("active", b.dataset.st === "claimed"));
    await loadAgentDetail(agentId, true);
  } catch (e) {
    boardToast(String(e.message || e), "err");
  }
}

async function selectAgent(agentId) {
  selectedAgentId = agentId;
  selectedDeliveryIdx = null;
  renderBoard();
  $("#agent-detail-title").textContent = agentId;
  $("#agent-claim").classList.remove("hidden");
  $("#agent-select-all").classList.remove("hidden");
  $("#agent-batch-done").classList.remove("hidden");
  $("#agent-requeue-dead").classList.remove("hidden");
  $("#agent-compensate").classList.remove("hidden");
  $("#agent-compensate-run").classList.remove("hidden");
  $("#agent-open-inbox").classList.remove("hidden");
  await loadAgentDetail(agentId, true);
}

function statusQueryForFilter(filter) {
  if (filter === "active") return "pending,claimed,acked";
  return filter;
}

async function loadAgentDetail(agentId, reloadList) {
  const meta = (boardData?.agents || []).find((a) => a.agent_id === agentId);
  $("#agent-detail-meta").textContent = meta
    ? [meta.host, meta.access, meta.sla, meta.notes].filter(Boolean).join(" · ") +
      ` · p${meta.pending}/c${meta.claimed}/a${meta.acked}/d${meta.dead}`
    : "";

  if (meta?.pending > 0) {
    $("#agent-claim").textContent = `Claim ${Math.min(meta.pending, 10)}`;
    $("#agent-claim").disabled = false;
  } else {
    $("#agent-claim").textContent = "Claim";
    $("#agent-claim").disabled = true;
  }
  $("#agent-requeue-dead").disabled = !(meta?.dead > 0);
  $("#agent-batch-done").disabled = false;

  if (!reloadList) return;

  agentToast("加载 deliveries…");
  try {
    const st = statusQueryForFilter(agentStatusFilter);
    const data = await api(
      `/api/agents/${encodeURIComponent(agentId)}/deliveries?status=${encodeURIComponent(st)}&limit=50`,
    );
    agentDeliveries = data.deliveries || [];
    renderAgentDeliveries();
    agentToast(`${agentDeliveries.length} deliveries`, "ok");
    $("#agent-ops").classList.add("hidden");
    $("#agent-delivery-detail").classList.add("empty");
    $("#agent-delivery-detail").textContent = agentDeliveries.length
      ? "勾选 claimed 可 Batch DONE；点行查看详情"
      : "该筛选下无 delivery";
  } catch (e) {
    agentDeliveries = [];
    renderAgentDeliveries();
    agentToast(String(e.message || e), "err");
  }
}

function renderAgentDeliveries() {
  const el = $("#agent-delivery-list");
  el.innerHTML = "";
  if (!agentDeliveries.length) {
    el.innerHTML = `<div class="muted" style="padding:12px">无 delivery</div>`;
    return;
  }
  agentDeliveries.forEach((d, i) => {
    const row = document.createElement("div");
    row.className = "item" + (i === selectedDeliveryIdx ? " active" : "");
    row.style.cursor = "pointer";
    const summary =
      (d.payload && (d.payload.summary || d.payload.subject)) || d.topic || d.type || "delivery";
    const canBatch = d.claim_token && (d.status === "claimed" || d.status === "acked");
    row.innerHTML = `
      <div class="row1">
        <span style="display:flex;align-items:center;gap:6px;min-width:0">
          ${
            canBatch
              ? `<input type="checkbox" class="chkbox batch-chk" data-i="${i}" ${d._selected ? "checked" : ""} />`
              : `<span style="width:14px"></span>`
          }
          <span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(String(summary))}</span>
        </span>
        <span class="st-badge ${escapeHtml(d.status || "")}">${escapeHtml(d.status || "?")}</span>
      </div>
      <div class="row2">${escapeHtml(d.from || "?")} · seq ${escapeHtml(String(d.seq ?? ""))} · att ${d.attempt_count ?? 0}${d.claim_token ? " · 🎫" : ""}${d.correlation_id ? " · " + escapeHtml(d.correlation_id) : ""}</div>
    `;
    const chk = row.querySelector(".batch-chk");
    if (chk) {
      chk.onclick = (e) => e.stopPropagation();
      chk.onchange = () => {
        d._selected = chk.checked;
      };
    }
    row.onclick = () => selectDelivery(i);
    el.appendChild(row);
  });
}

async function batchDoneSelected() {
  if (!selectedAgentId) return;
  const tokens = agentDeliveries
    .filter((d) => d._selected && d.claim_token)
    .map((d) => d.claim_token);
  if (!tokens.length) {
    agentToast("请先勾选带 token 的 claimed/acked 项", "err");
    return;
  }
  const summary = $("#aop-summary").value.trim() || undefined;
  agentToast(`Batch DONE ×${tokens.length}…`);
  try {
    const data = await api("/api/events/batch-done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens, summary }),
    });
    const okN = (data.results || []).filter((r) => r.ok).length;
    agentToast(`Batch DONE ${okN}/${tokens.length}`, okN === tokens.length ? "ok" : "err");
    await loadBoard();
    await loadAgentDetail(selectedAgentId, true);
  } catch (e) {
    agentToast(String(e.message || e), "err");
  }
}

async function requeueDeadForAgent() {
  if (!selectedAgentId) return;
  if (!confirm(`将 ${selectedAgentId} 的 dead 重新入队为 pending？`)) return;
  agentToast("Requeue dead…");
  try {
    const data = await api("/api/events/requeue-dead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: selectedAgentId, limit: 50 }),
    });
    agentToast(`requeued ${data.requeued ?? 0}`, data.ok ? "ok" : "err");
    await loadBoard();
    agentStatusFilter = "pending";
    $$(".stab").forEach((b) => b.classList.toggle("active", b.dataset.st === "pending"));
    await loadAgentDetail(selectedAgentId, true);
  } catch (e) {
    agentToast(String(e.message || e), "err");
  }
}

async function compensateDryRun() {
  if (!selectedAgentId) return;
  agentToast("compensate dry-run…");
  try {
    const data = await api("/api/events/compensate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: selectedAgentId, dry_run: true, limit: 20 }),
    });
    $("#agent-delivery-detail").classList.remove("empty");
    $("#agent-delivery-detail").innerHTML = `<pre class="codeblock" style="margin:0;max-height:none">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    agentToast("compensate dry-run 结果见下方", "ok");
  } catch (e) {
    agentToast(String(e.message || e), "err");
  }
}

async function compensateExecute() {
  if (!selectedAgentId) return;
  const a = prompt(
    `将对该 agent 执行 REAL compensate（会写事件/重试 wake）。\nAgent: ${selectedAgentId}\n\n请输入 EXECUTE 确认：`,
  );
  if (a !== "EXECUTE") {
    agentToast("已取消（未输入 EXECUTE）", "err");
    return;
  }
  if (!confirm(`再次确认：对 ${selectedAgentId} 执行 compensate-dispatches？`)) {
    agentToast("已取消", "");
    return;
  }
  agentToast("compensate EXECUTE…");
  try {
    const data = await api("/api/events/compensate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: selectedAgentId,
        dry_run: false,
        confirm: "EXECUTE",
        limit: 20,
      }),
    });
    $("#agent-delivery-detail").classList.remove("empty");
    $("#agent-delivery-detail").innerHTML = `<pre class="codeblock" style="margin:0;max-height:none">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    agentToast("compensate 已执行，结果见下方", "ok");
    await loadBoard();
  } catch (e) {
    agentToast(String(e.message || e), "err");
  }
}

async function loadAudit() {
  try {
    const data = await api("/api/ops/audit?limit=80");
    $("#audit-path").textContent = `${data.path || ""} · total ${data.count ?? 0} lines`;
    $("#audit-out").textContent = JSON.stringify(data.entries || [], null, 2);
  } catch (e) {
    $("#audit-out").textContent = String(e.message || e);
  }
}

// ── Workflows ─────────────────────────────────────────────

async function loadWorkflows() {
  const el = $("#workflow-list");
  el.innerHTML = `<div class="muted" style="padding:12px">加载…</div>`;
  try {
    const data = await api("/api/interactions?limit=40");
    const list = data.correlations || [];
    el.innerHTML = "";
    if (!list.length) {
      el.innerHTML = `<div class="muted" style="padding:12px">暂无 correlation 数据</div>`;
      return;
    }
    for (const w of list) {
      const btn = document.createElement("button");
      btn.className = "item";
      const st = w.delivery_status || {};
      const stStr = Object.entries(st)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      btn.innerHTML = `
        <div class="row1">
          <span>${escapeHtml(w.correlation_id)}</span>
          <span class="tag">${w.event_count} evt</span>
        </div>
        <div class="row2">${escapeHtml(w.last_ts || "")} · ${escapeHtml(w.from_agents || "")} · ${escapeHtml(stStr)}</div>
      `;
      btn.onclick = () => openWorkflow(w.correlation_id);
      el.appendChild(btn);
    }
  } catch (e) {
    el.innerHTML = `<div class="muted" style="padding:12px">${escapeHtml(String(e.message || e))}</div>`;
  }
}

async function openWorkflow(cid) {
  $("#workflow-title").textContent = cid;
  const box = $("#workflow-timeline");
  box.classList.remove("empty");
  box.innerHTML = `<div class="muted">加载时间线…</div>`;
  try {
    const data = await api(`/api/interactions/${encodeURIComponent(cid)}`);
    const events = data.events || [];
    $("#workflow-meta").textContent = `${events.length} rows`;
    if (!events.length) {
      box.innerHTML = `<div class="muted">空</div>`;
      return;
    }
    box.innerHTML = "";
    for (const e of events) {
      const div = document.createElement("div");
      const st = e.delivery_status || "event";
      div.className = `tl-item ${escapeHtml(String(st))}`;
      const summary =
        (e.payload && (e.payload.summary || e.payload.subject)) || e.topic || e.type || "";
      div.innerHTML = `
        <div class="tl-head">${escapeHtml(e.type || "?")} · ${escapeHtml(String(summary))}</div>
        <div class="tl-meta">${escapeHtml(e.ts || "")} · from ${escapeHtml(e.from || "?")} → ${escapeHtml(e.to_agent || "—")} · ${escapeHtml(String(st))} · seq ${escapeHtml(String(e.seq ?? ""))}</div>
      `;
      box.appendChild(div);
    }
  } catch (err) {
    box.innerHTML = `<div class="muted">${escapeHtml(String(err.message || err))}</div>`;
  }
}

function selectDelivery(i) {
  selectedDeliveryIdx = i;
  renderAgentDeliveries();
  const d = agentDeliveries[i];
  if (!d) return;
  const box = $("#agent-delivery-detail");
  box.classList.remove("empty");
  const corrLink = d.correlation_id
    ? `<div style="padding:8px 0"><span class="linkish" id="goto-corr">打开 workflow ${escapeHtml(d.correlation_id)}</span></div>`
    : "";
  const deadBtn =
    d.status === "dead"
      ? `<div style="padding:4px 0"><button class="btn danger ghost" id="requeue-one" type="button">Requeue 此条 dead</button></div>`
      : "";
  box.innerHTML =
    corrLink +
    deadBtn +
    `<pre class="codeblock" style="margin:0;max-height:none">${escapeHtml(JSON.stringify(d, null, 2))}</pre>`;

  const gl = $("#goto-corr");
  if (gl) {
    gl.onclick = () => {
      setView("workflows");
      openWorkflow(d.correlation_id);
    };
  }
  const rq = $("#requeue-one");
  if (rq) {
    rq.onclick = async () => {
      rq.disabled = true;
      try {
        const data = await api("/api/events/requeue-dead", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delivery_id: d.delivery_id }),
        });
        agentToast(`requeued ${data.requeued ?? 0}`, data.ok ? "ok" : "err");
        await loadBoard();
        await loadAgentDetail(selectedAgentId, true);
      } catch (e) {
        agentToast(String(e.message || e), "err");
      } finally {
        rq.disabled = false;
      }
    };
  }

  if (d.claim_token && (d.status === "claimed" || d.status === "acked")) {
    $("#agent-ops").classList.remove("hidden");
  } else if (d.status === "pending") {
    $("#agent-ops").classList.add("hidden");
    agentToast("pending 需先 Claim 再 ACK/DONE", "");
  } else if (d.status === "dead") {
    $("#agent-ops").classList.add("hidden");
    agentToast("dead-letter：可 Requeue 此条，或批量 Requeue dead / Compensate", "");
  } else {
    $("#agent-ops").classList.add("hidden");
  }
}

function selectAllClaimable() {
  let n = 0;
  for (const d of agentDeliveries) {
    if (d.claim_token && (d.status === "claimed" || d.status === "acked")) {
      d._selected = true;
      n++;
    }
  }
  renderAgentDeliveries();
  agentToast(n ? `已全选 ${n} 条` : "没有可批量 DONE 的项", n ? "ok" : "err");
}

async function agentDeliveryOp(op) {
  const d = agentDeliveries[selectedDeliveryIdx];
  if (!d?.claim_token) {
    agentToast("需要 claim_token — 先点 Claim", "err");
    return;
  }
  agentToast(`${op}…`);
  try {
    const body = { token: d.claim_token };
    if (op === "done") {
      const summary = $("#aop-summary").value.trim();
      if (summary) body.summary = summary;
    }
    if (op === "cancel") {
      body.reason = $("#aop-summary").value.trim() || "cancelled via agent board";
    }
    await api(`/api/events/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    agentToast(`${op} ok`, "ok");
    await loadBoard();
    await loadAgentDetail(selectedAgentId, true);
  } catch (e) {
    agentToast(String(e.message || e), "err");
  }
}

// ── Registry / Inbox (secondary full page) ────────────────

async function ensureAgentsLoaded() {
  const sel = $("#agent");
  if (sel.options.length > 0 && sel.dataset.loaded === "1") return;
  try {
    const data = await api("/api/registry/agents");
    sel.innerHTML = "";
    for (const a of data.agents || []) {
      if (!a.agent_id) continue;
      const opt = document.createElement("option");
      opt.value = a.agent_id;
      opt.textContent = a.reserved
        ? `${a.agent_id} (reserved)`
        : `${a.agent_id}${a.notes ? " — " + a.notes : ""}`;
      sel.appendChild(opt);
    }
    if (!sel.options.length) {
      sel.innerHTML = `<option value="issac">issac</option><option value="test-agent">test-agent</option>`;
    }
    sel.dataset.loaded = "1";
  } catch {
    sel.innerHTML = `<option value="issac">issac</option><option value="test-agent">test-agent</option>`;
    sel.dataset.loaded = "1";
  }
}

function openAgentInbox(agentId) {
  setView("events");
  ensureAgentsLoaded().then(() => {
    const sel = $("#agent");
    if (![...sel.options].some((o) => o.value === agentId)) {
      const opt = document.createElement("option");
      opt.value = agentId;
      opt.textContent = agentId;
      sel.appendChild(opt);
    }
    sel.value = agentId;
    loadEvents(false);
  });
}

// ── Sessions ──────────────────────────────────────────────

async function loadSessions() {
  const provider = $("#provider").value;
  const project = $("#project").value.trim();
  const qs = new URLSearchParams({ limit: "150" });
  if (provider) qs.set("provider", provider);
  if (project) qs.set("project", project);
  const data = await api(`/api/sessions?${qs}`);
  sessions = data.sessions || [];
  $("#session-count").textContent = `${data.count} sessions`;
  renderSessionList();
}

function renderSessionList() {
  const el = $("#session-list");
  el.innerHTML = "";
  if (!sessions.length) {
    el.innerHTML = `<div class="muted" style="padding:12px">没有匹配的 session</div>`;
    return;
  }
  for (const s of sessions) {
    const btn = document.createElement("button");
    btn.className = "item" + (s.id === activeId ? " active" : "");
    btn.innerHTML = `
      <div class="row1">
        <span>${escapeHtml(s.title || s.nativeId)}</span>
        <span class="tag">${escapeHtml(s.provider)}</span>
      </div>
      <div class="row2">${escapeHtml(s.updatedAt || "")} · ${escapeHtml(s.projectPath || s.id)}</div>
    `;
    btn.onclick = () => selectSession(s.id);
    el.appendChild(btn);
  }
}

async function selectSession(id) {
  activeId = id;
  renderSessionList();
  const s = sessions.find((x) => x.id === id);
  $("#detail-title").textContent = s?.title || s?.nativeId || id;
  $("#detail-meta").textContent = s?.id || "";
  const box = $("#messages");
  box.classList.remove("empty");
  box.innerHTML = `<div class="muted">加载消息…</div>`;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}/messages?limit=100`);
    box.innerHTML = "";
    if (!data.messages?.length) {
      box.innerHTML = `<div class="muted">该 session 暂无可解析消息</div>`;
    } else {
      for (const m of data.messages) {
        const div = document.createElement("div");
        div.className = `msg ${m.role || "assistant"}`;
        div.innerHTML = `<div class="who">${escapeHtml(m.role || "?")}${m.ts ? " · " + escapeHtml(m.ts) : ""}</div>${escapeHtml(m.text || "")}`;
        box.appendChild(div);
      }
    }
    if (s?.resume?.value) {
      $("#resume-bar").classList.remove("hidden");
      $("#resume-cmd").textContent = s.resume.value;
    } else {
      $("#resume-bar").classList.add("hidden");
    }
  } catch (e) {
    box.innerHTML = `<div class="muted">加载失败：${escapeHtml(String(e.message || e))}</div>`;
  }
}

async function doSearch() {
  const q = $("#search").value.trim();
  if (!q) return loadSessions();
  const data = await api(`/api/search?q=${encodeURIComponent(q)}&limit=40`);
  const box = $("#messages");
  box.classList.remove("empty");
  box.innerHTML = "";
  $("#detail-title").textContent = `搜索：${q}`;
  $("#detail-meta").textContent = `${data.count} hits`;
  $("#resume-bar").classList.add("hidden");
  if (!data.hits?.length) {
    box.innerHTML = `<div class="muted">无结果</div>`;
    return;
  }
  for (const h of data.hits) {
    const div = document.createElement("div");
    div.className = "msg assistant";
    div.innerHTML = `<div class="who">${escapeHtml(h.provider)} · ${escapeHtml(h.sessionId)}</div>${escapeHtml(h.snippet || "")}`;
    div.style.cursor = "pointer";
    div.onclick = () => selectSession(h.sessionId);
    box.appendChild(div);
  }
}

// ── Full-page Inbox ───────────────────────────────────────

function toast(msg, kind) {
  const el = $("#event-toast");
  el.textContent = msg || "";
  el.classList.remove("err", "ok");
  if (kind) el.classList.add(kind);
}

async function loadEvents(claim) {
  await ensureAgentsLoaded();
  const agent = $("#agent").value.trim() || "issac";
  const limit = $("#event-limit").value || "20";
  const mode = $("#event-mode").value || "auto";
  const topic = $("#event-topic").value.trim();
  toast(claim ? "Claiming (v2)…" : "Loading…");
  try {
    let data;
    if (claim) {
      data = await api("/api/events/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, limit: Number(limit) }),
      });
    } else {
      const qs = new URLSearchParams({ agent, limit, mode });
      if (topic) qs.set("topic", topic);
      data = await api(`/api/events/inbox?${qs}`);
    }
    events = data.events || [];
    const rem = data.count_remaining_pending;
    $("#event-count").textContent =
      `${events.length} shown` +
      (rem != null ? ` · ${rem} remaining` : "") +
      (data.claimed ? " · claimed" : "") +
      ` · ${data.mode || "?"}`;
    $("#event-mode-banner").textContent = data.note || "";
    activeEventIdx = null;
    renderEventList();
    $("#event-detail").classList.add("empty");
    $("#event-detail").textContent = events.length ? "选择一条 delivery" : "inbox 为空";
    $("#event-ops").classList.add("hidden");
    toast(events.length ? `已加载 ${events.length} 条` : "无 pending", "ok");
  } catch (e) {
    events = [];
    renderEventList();
    toast(String(e.message || e), "err");
  }
}

function renderEventList() {
  const el = $("#event-list");
  el.innerHTML = "";
  if (!events.length) {
    el.innerHTML = `<div class="muted" style="padding:12px">无事件</div>`;
    return;
  }
  events.forEach((ev, i) => {
    const btn = document.createElement("button");
    btn.className = "item" + (i === activeEventIdx ? " active" : "");
    const topic = ev.topic || ev.type || "event";
    const from = ev.from || "?";
    btn.innerHTML = `
      <div class="row1">
        <span>${escapeHtml(topic)}</span>
        <span class="tag">${ev.claim_token ? "🎫" : ev.mode || "v2"} · ${escapeHtml(from)}</span>
      </div>
      <div class="row2">seq ${escapeHtml(String(ev.seq ?? ""))} · att ${ev.attempt_count ?? 0}</div>
    `;
    btn.onclick = () => selectEvent(i);
    el.appendChild(btn);
  });
}

function selectEvent(i) {
  activeEventIdx = i;
  renderEventList();
  const ev = events[i];
  if (!ev) return;
  const isV1 = Boolean(ev.v1 || ev.mode === "v1");
  $("#event-detail-title").textContent = `${ev.type || "event"} · ${ev.topic || ""}`;
  $("#event-detail-meta").textContent = isV1 ? "v1" : ev.claim_token ? "token held" : "no token";
  const box = $("#event-detail");
  box.classList.remove("empty");
  box.innerHTML = `<pre class="codeblock" style="margin:0;max-height:none">${escapeHtml(JSON.stringify(ev, null, 2))}</pre>`;
  if (ev.claim_token || isV1) {
    $("#event-ops").classList.remove("hidden");
    $("#op-renew").classList.toggle("hidden", isV1);
    $("#op-cancel").classList.toggle("hidden", isV1);
  } else {
    $("#event-ops").classList.add("hidden");
  }
}

async function eventOp(op) {
  const ev = events[activeEventIdx];
  if (!ev) return;
  const isV1 = Boolean(ev.v1 || ev.mode === "v1");
  toast(`${op}…`);
  try {
    if (isV1) {
      if (op !== "ack" && op !== "done") {
        toast("v1 仅 ACK/DONE", "err");
        return;
      }
      const body = {
        agent: $("#agent").value.trim(),
        seq: String(ev.v1?.seq ?? ev.seq ?? ""),
        file: String(ev.v1?.file || ev.source_file || ev.from || ""),
      };
      if (op === "done" && $("#done-summary").value.trim()) {
        body.summary = $("#done-summary").value.trim();
      }
      await api(`/api/events/v1/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      if (!ev.claim_token) {
        toast("需要 claim_token", "err");
        return;
      }
      const body = { token: ev.claim_token };
      if (op === "done" && $("#done-summary").value.trim()) body.summary = $("#done-summary").value.trim();
      if (op === "cancel") body.reason = $("#done-summary").value.trim() || "cancelled via inbox";
      await api(`/api/events/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    toast(`${op} ok`, "ok");
    events.splice(activeEventIdx, 1);
    activeEventIdx = null;
    renderEventList();
    $("#event-ops").classList.add("hidden");
  } catch (e) {
    toast(String(e.message || e), "err");
  }
}

// ── Paths / Health ────────────────────────────────────────

async function loadPaths() {
  const data = await api("/api/events/status");
  const ex = data.exists || {};
  const paths = data.paths || {};
  const sql = data.sqlite || {};
  $("#paths-cards").innerHTML = [
    card("A2A_LOG_HOME", paths.A2A_LOG_HOME, ex.home),
    card("events/*.jsonl", `${data.jsonl_count ?? 0} files`, ex.events_dir),
    card(
      "a2a-v2.sqlite",
      sql.ok ? `${sql.events} events · ${sql.deliveries} deliveries` : "missing",
      ex.db,
    ),
    card("a2a-log.py", paths.A2A_LOG_CLI, ex.v1_script),
  ].join("");
  $("#paths-out").textContent = JSON.stringify(data, null, 2);
}

function card(title, val, ok) {
  return `<div class="card"><h3>${escapeHtml(title)}</h3><div class="val ${ok ? "ok" : "bad"}">${escapeHtml(String(val))}${ok ? " ✓" : " ✗"}</div></div>`;
}

async function loadHealth() {
  try {
    const [health, meta] = await Promise.all([api("/api/health"), api("/api/meta")]);
    $("#health-out").textContent = JSON.stringify({ meta, health }, null, 2);
  } catch (e) {
    $("#health-out").textContent = String(e.message || e);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ── Wire ──────────────────────────────────────────────────

$$(".nav").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("#refresh-board").addEventListener("click", loadBoard);
$("#hide-idle").addEventListener("change", renderBoard);
$("#hide-reserved").addEventListener("change", renderBoard);
$("#agent-claim").addEventListener("click", () => {
  if (selectedAgentId) claimAgent(selectedAgentId, 10);
});
$("#agent-select-all").addEventListener("click", () => selectAllClaimable());
$("#agent-batch-done").addEventListener("click", () => batchDoneSelected());
$("#agent-requeue-dead").addEventListener("click", () => requeueDeadForAgent());
$("#agent-compensate").addEventListener("click", () => compensateDryRun());
$("#agent-compensate-run").addEventListener("click", () => compensateExecute());
$("#agent-open-inbox").addEventListener("click", () => {
  if (selectedAgentId) openAgentInbox(selectedAgentId);
});
$("#auto-refresh").addEventListener("change", setupAutoRefresh);
$("#auto-refresh-sec").addEventListener("change", setupAutoRefresh);
$("#refresh-audit").addEventListener("click", loadAudit);
$("#agent-filter").addEventListener("input", () => renderBoard());
$("#agent-sort").addEventListener("change", () => renderBoard());

// keyboard: r refresh board, / focus filter (when not in input)
document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "r" || e.key === "R") {
    if (!$("#view-agents").classList.contains("hidden")) {
      e.preventDefault();
      loadBoard();
    }
  }
  if (e.key === "/") {
    if (!$("#view-agents").classList.contains("hidden")) {
      e.preventDefault();
      $("#agent-filter")?.focus();
    }
  }
});
$$(".stab").forEach((b) =>
  b.addEventListener("click", async () => {
    agentStatusFilter = b.dataset.st;
    $$(".stab").forEach((x) => x.classList.toggle("active", x === b));
    if (selectedAgentId) await loadAgentDetail(selectedAgentId, true);
  }),
);
$("#aop-ack").addEventListener("click", () => agentDeliveryOp("ack"));
$("#aop-done").addEventListener("click", () => agentDeliveryOp("done"));
$("#aop-renew").addEventListener("click", () => agentDeliveryOp("renew"));
$("#aop-cancel").addEventListener("click", () => agentDeliveryOp("cancel"));
$("#refresh-workflows").addEventListener("click", loadWorkflows);

$("#refresh").addEventListener("click", loadSessions);
$("#provider").addEventListener("change", loadSessions);
$("#project").addEventListener("keydown", (e) => e.key === "Enter" && loadSessions());
$("#search").addEventListener("keydown", (e) => e.key === "Enter" && doSearch());
$("#load-events").addEventListener("click", () => loadEvents(false));
$("#claim-events").addEventListener("click", () => loadEvents(true));
$("#op-ack").addEventListener("click", () => eventOp("ack"));
$("#op-done").addEventListener("click", () => eventOp("done"));
$("#op-renew").addEventListener("click", () => eventOp("renew"));
$("#op-cancel").addEventListener("click", () => eventOp("cancel"));
$("#refresh-paths").addEventListener("click", loadPaths);
$("#copy-resume").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#resume-cmd").textContent);
    $("#copy-resume").textContent = "已复制";
    setTimeout(() => ($("#copy-resume").textContent = "复制"), 1200);
  } catch {
    /* ignore */
  }
});

loadBoard();
