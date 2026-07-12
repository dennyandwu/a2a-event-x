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
/** @type {{ readonly?: boolean, authority?: boolean, dataMode?: string, version?: string } | null} */
let appMeta = null;

function isReadonly() {
  return Boolean(appMeta?.readonly);
}

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
    if (data.error === "readonly") {
      throw new Error(
        data.message || "只读模式：禁止变更。请在 Mac Mini 权威机操作，或取消 A2AX_READONLY。",
      );
    }
    const msg = data.error || data.detail || data.message || text || res.status;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

function ensureReadonlyBanner() {
  let el = document.getElementById("readonly-banner");
  if (!isReadonly()) {
    if (el) el.remove();
    document.body.classList.remove("is-readonly");
    return;
  }
  document.body.classList.add("is-readonly");
  if (!el) {
    el = document.createElement("div");
    el.id = "readonly-banner";
    el.className = "readonly-banner";
    const main = document.querySelector(".main");
    if (main) main.insertBefore(el, main.firstChild);
  }
  const reason = appMeta?.readonly_reason || "";
  el.innerHTML =
    `<strong>只读模式</strong> · claim / done / requeue 已禁用（同步仍可用）。` +
    ` 权威可写：Mac Mini 上 <code>A2AX_AUTHORITY=1</code>。` +
    (reason ? ` · <span class="muted">${escapeHtml(reason)}</span>` : "") +
    (appMeta?.dataMode ? ` · data=${escapeHtml(appMeta.dataMode)}` : "");
}

async function loadAppMeta() {
  try {
    appMeta = await api("/api/meta");
  } catch {
    try {
      appMeta = await api("/api/health");
    } catch {
      appMeta = null;
    }
  }
  ensureReadonlyBanner();
  const foot = document.querySelector(".sidebar-foot .muted");
  if (foot && appMeta?.version) {
    foot.textContent = `v${appMeta.version} · ${isReadonly() ? "只读" : "可写"} · 交互优先`;
  }
}

function fmtTime(d = new Date()) {
  return d.toLocaleTimeString();
}

/** @type {"paths"|"audit"|"health"} */
let systemTab = "paths";

const SYSTEM_TAB_LABELS = {
  paths: "Write Path · 存储拓扑",
  audit: "Ops Audit · 操作审计",
  health: "Health · 健康检查",
};

function setSystemTab(tab) {
  if (!["paths", "audit", "health"].includes(tab)) tab = "paths";
  systemTab = tab;
  $$("#system-subnav .nav-sub-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.systemTab === tab),
  );
  $$("#system-tabs .stab").forEach((b) =>
    b.classList.toggle("active", b.dataset.systemTab === tab),
  );
  $("#system-panel-paths")?.classList.toggle("hidden", tab !== "paths");
  $("#system-panel-audit")?.classList.toggle("hidden", tab !== "audit");
  $("#system-panel-health")?.classList.toggle("hidden", tab !== "health");
  if ($("#system-tab-label")) {
    $("#system-tab-label").textContent = `运维 · ${SYSTEM_TAB_LABELS[tab] || tab}`;
  }
  if (tab === "paths") loadPaths();
  if (tab === "audit") loadAudit();
  if (tab === "health") loadHealth();
}

function refreshSystem() {
  if (systemTab === "paths") return loadPaths();
  if (systemTab === "audit") return loadAudit();
  return loadHealth();
}

function setView(name) {
  $$(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#view-agents").classList.toggle("hidden", name !== "agents");
  $("#view-workflows").classList.toggle("hidden", name !== "workflows");
  $("#view-events").classList.toggle("hidden", name !== "events");
  $("#view-sessions").classList.toggle("hidden", name !== "sessions");
  $("#view-system")?.classList.toggle("hidden", name !== "system");
  $("#system-subnav")?.classList.toggle("hidden", name !== "system");
  $("#agent-filters").classList.toggle("hidden", name !== "agents");
  $("#workflow-filters").classList.toggle("hidden", name !== "workflows");
  $("#event-filters").classList.toggle("hidden", name !== "events");
  $("#session-filters").classList.toggle("hidden", name !== "sessions");
  $("#system-filters")?.classList.toggle("hidden", name !== "system");
  if (name === "agents") loadBoard();
  if (name === "workflows") loadWorkflows();
  if (name === "system") setSystemTab(systemTab);
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

/** Load / wipe multi-agent demo rows (sqlite source_file=demo). */
async function seedDemo(opts = {}) {
  const reset = opts.reset !== false && !opts.wipeOnly;
  const wipeOnly = Boolean(opts.wipeOnly);
  const label = wipeOnly ? "清除演示" : "加载演示数据";
  boardToast(`${label}…`);
  setLoading(true);
  try {
    const body = wipeOnly ? { wipe_only: true } : { reset: true };
    const out = await api("/api/demo/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (wipeOnly) {
      boardToast(`已清除演示行 · wiped ${out.wiped ?? "?"}`, "ok");
    } else {
      const by = out.by_status || {};
      const nWf = (out.workflows || []).length;
      boardToast(
        `演示就绪 · ${out.deliveries || 0} deliveries (p${by.pending || 0}/c${by.claimed || 0}/d${by.dead || 0})` +
          (nWf ? ` · Workflows×${nWf}` : "") +
          " · 点卡片 Claim / DONE，或开 Workflows",
        "ok",
      );
      if ($("#hide-idle")) $("#hide-idle").checked = true;
    }
    await loadBoard();
  } catch (e) {
    boardToast(String(e.message || e), "err");
  } finally {
    setLoading(false);
  }
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
  const fr = boardData.freshness || appMeta?.freshness || {};
  const autoOn = $("#auto-refresh")?.checked;
  $("#board-totals").innerHTML =
    (autoOn ? `<span class="pulse-dot" title="auto-refresh"></span>` : "") +
    `Σ p${t.pending || 0} · c${t.claimed || 0} · a${t.acked || 0}` +
    ` · blk${t.blocked || 0} · esc${t.escalated || 0} · ☠${t.dead || 0}` +
    ` · hist${t.historical || 0} · ✓${t.done || 0}` +
    (boardData.db_ok ? "" : " · DB missing");
  if ($("#board-updated")) {
    $("#board-updated").innerHTML = lastBoardAt
      ? `更新于 ${escapeHtml(fmtTime(lastBoardAt))} · <span class="kbd">r</span> 刷新`
      : "";
  }
  const fb = $("#freshness-banner");
  if (fb) {
    if (fr && (fr.last_sync_at || fr.db_age_hours != null || fr.stale)) {
      fb.classList.remove("hidden");
      fb.className =
        "banner " + (fr.stale ? "stale-warn" : "muted");
      const parts = [];
      if (fr.last_sync_at) parts.push(`上次同步 ${escapeHtml(String(fr.last_sync_at))}`);
      else parts.push("无同步记录（CLI sync 或控制台同步后会写入）");
      if (fr.sync_age_hours != null) parts.push(`同步龄 ${fr.sync_age_hours}h`);
      if (fr.db_age_hours != null) parts.push(`sqlite mtime 龄 ${fr.db_age_hours}h`);
      if (fr.stale) parts.push("⚠ 可能过期 — 建议 npm run sync:log");
      fb.innerHTML = parts.join(" · ");
    } else {
      fb.classList.add("hidden");
    }
  }

  if (boardData.error) {
    $("#board-error").textContent = boardData.error;
    $("#board-error").classList.remove("hidden");
  }

  let agents = boardData.agents || [];
  if (hideIdle) {
    agents = agents.filter(
      (a) =>
        (a.total_attention || 0) > 0 ||
        (a.total_active || 0) > 0 ||
        (a.dead || 0) > 0 ||
        (a.blocked || 0) > 0 ||
        (a.escalated || 0) > 0,
    );
  }
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
    if (sort === "blocked") return (b.blocked || 0) - (a.blocked || 0) || a.agent_id.localeCompare(b.agent_id);
    // attention default
    const ba = b.total_attention ?? b.total_active ?? 0;
    const aa = a.total_attention ?? a.total_active ?? 0;
    if (ba !== aa) return ba - aa;
    if (b.pending !== a.pending) return b.pending - a.pending;
    return a.agent_id.localeCompare(b.agent_id);
  });

  const el = $("#agent-board");
  el.innerHTML = "";
  const tAll =
    (t.pending || 0) +
    (t.claimed || 0) +
    (t.acked || 0) +
    (t.dead || 0) +
    (t.blocked || 0) +
    (t.escalated || 0) +
    (t.done || 0);
  if (!agents.length) {
    const noWork = tAll === 0;
    el.innerHTML = noWork
      ? `<div class="empty-state">
          <div class="empty-title">本机几乎没有可调度的交互数据</div>
          <p class="empty-body">
            Event X 的主线是<strong>多 Agent 交互看板</strong>（pending / claimed / dead / workflow），
            不是 Session 列表。当前 sqlite 里没有生产 dual-write 流量时，看板会空。
          </p>
          <ul class="empty-list">
            <li>点「加载演示数据」→ 注入 5 条跨 agent 工作流，立刻试用 Claim / Batch DONE / Workflows</li>
            <li>或把 <code>A2A_LOG_HOME</code> 指到 Mac Mini 生产目录再重启</li>
            <li>关闭「隐藏无积压」可先看完整 agent 注册表</li>
          </ul>
          <div class="empty-actions">
            <button type="button" class="btn" id="empty-seed">加载演示数据</button>
            <button type="button" class="btn ghost" id="empty-show-all">显示全部 agent</button>
          </div>
        </div>`
      : `<div class="empty-state compact">
          <div class="empty-title">筛选后无 agent</div>
          <p class="empty-body">关闭「隐藏无积压」或清空筛选，可看全注册表 / 全部状态。</p>
          <div class="empty-actions">
            <button type="button" class="btn ghost" id="empty-show-all">显示全部 agent</button>
          </div>
        </div>`;
    const seedBtn = el.querySelector("#empty-seed");
    if (seedBtn) seedBtn.onclick = () => seedDemo({ reset: true });
    const showAll = el.querySelector("#empty-show-all");
    if (showAll) {
      showAll.onclick = () => {
        $("#hide-idle").checked = false;
        renderBoard();
      };
    }
    return;
  }

  for (const a of agents) {
    const card = document.createElement("div");
    card.className =
      "agent-card" +
      ((a.total_attention || a.total_active || 0) > 0 || a.dead > 0 ? " has-work" : "") +
      (a.blocked || a.escalated ? " has-attention" : "") +
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
    if (a.blocked) pills.push(`<span class="stat blocked">blocked ${a.blocked}</span>`);
    if (a.escalated) pills.push(`<span class="stat escalated">escalated ${a.escalated}</span>`);
    if (a.dead) pills.push(`<span class="stat dead">dead ${a.dead}</span>`);
    if (a.historical) pills.push(`<span class="stat historical">hist ${a.historical}</span>`);
    if (a.done) pills.push(`<span class="stat done">done ${a.done}</span>`);
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
  if (filter === "active") return "pending,claimed,acked,blocked,escalated";
  return filter;
}

async function loadAgentDetail(agentId, reloadList) {
  const meta = (boardData?.agents || []).find((a) => a.agent_id === agentId);
  $("#agent-detail-meta").textContent = meta
    ? [meta.host, meta.access, meta.sla, meta.notes].filter(Boolean).join(" · ") +
      ` · p${meta.pending}/c${meta.claimed}/a${meta.acked}` +
      `/blk${meta.blocked || 0}/esc${meta.escalated || 0}/☠${meta.dead}` +
      `/h${meta.historical || 0}/✓${meta.done || 0}`
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
    const entries = data.entries || [];
    $("#audit-path").textContent = `${data.path || ""} · total ${data.count ?? 0} lines · showing ${entries.length}`;
    const tl = $("#audit-timeline");
    if (tl) {
      if (!entries.length) {
        tl.innerHTML = `<div class="muted" style="padding:12px">暂无操作审计（claim/done/sync 后会出现）</div>`;
      } else {
        tl.innerHTML = entries
          .map((e) => {
            const ok = e.ok !== false;
            const detail = e.detail
              ? escapeHtml(
                  typeof e.detail === "string"
                    ? e.detail
                    : JSON.stringify(e.detail).slice(0, 180),
                )
              : "";
            return `<div class="audit-row ${ok ? "ok" : "err"}">
              <div class="ar-op">${escapeHtml(e.op || "?")}${e.agent ? ` · <b>${escapeHtml(e.agent)}</b>` : ""}</div>
              <div class="ar-meta">${escapeHtml(e.ts || "")}${e.duration_ms != null ? ` · ${e.duration_ms}ms` : ""} · ${ok ? "ok" : "fail"}</div>
              ${detail ? `<div class="ar-detail">${detail}</div>` : ""}
              ${e.error ? `<div class="ar-detail err">${escapeHtml(String(e.error))}</div>` : ""}
            </div>`;
          })
          .join("");
      }
    }
    const raw = $("#audit-out");
    if (raw) raw.textContent = JSON.stringify(entries, null, 2);
  } catch (e) {
    const tl = $("#audit-timeline");
    if (tl) tl.innerHTML = `<div class="muted">${escapeHtml(String(e.message || e))}</div>`;
    $("#audit-out").textContent = String(e.message || e);
  }
}

// ── Workflows ─────────────────────────────────────────────

/** @type {Array<any>} */
let workflowListCache = [];
/** @type {Record<string, number>|null} */
let workflowSummary = null;

const WORKFLOW_PHASE_LABEL = {
  active: "进行中",
  mixed: "进行中+历史",
  problem: "有问题",
  history: "历史",
  other: "其他",
};

function workflowPhaseOf(w) {
  if (w.phase) return w.phase;
  const st = w.delivery_status || w.counts || {};
  const dead = st.dead || 0;
  const active = (st.pending || 0) + (st.claimed || 0) + (st.acked || 0);
  const terminal = (st.done || 0) + (st.cancelled || 0);
  if (dead) return "problem";
  if (active && terminal) return "mixed";
  if (active) return "active";
  if (terminal) return "history";
  return "other";
}

function renderWorkflowList() {
  const el = $("#workflow-list");
  if (!el) return;
  const phaseFilter = $("#workflow-phase")?.value || "all";
  const q = ($("#workflow-filter")?.value || "").trim().toLowerCase();
  let list = workflowListCache.slice();

  if (phaseFilter === "active") {
    list = list.filter((w) => ["active", "mixed"].includes(workflowPhaseOf(w)));
  } else if (phaseFilter === "problem") {
    list = list.filter((w) => workflowPhaseOf(w) === "problem");
  } else if (phaseFilter === "history") {
    list = list.filter((w) => workflowPhaseOf(w) === "history");
  }
  // phaseFilter === "all" keeps history + active + problem

  if (q) {
    list = list.filter((w) => {
      const hay = [
        w.correlation_id,
        w.topics,
        w.types,
        w.from_agents,
        w.to_agents,
        workflowPhaseOf(w),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  const sum = workflowSummary || {};
  if ($("#workflow-summary")) {
    $("#workflow-summary").textContent =
      `显示 ${list.length}/${workflowListCache.length}` +
      (sum.total != null
        ? ` · 进行中 ${sum.active || 0} · 问题 ${sum.problem || 0} · 历史 ${sum.history || 0}`
        : "");
  }

  el.innerHTML = "";
  if (!list.length) {
    el.innerHTML = `<div class="muted" style="padding:12px">${
      workflowListCache.length
        ? "当前筛选无结果 — 可切换「全部（含历史）」查看 done 终态流程"
        : "暂无 correlation 数据"
    }</div>`;
    return;
  }

  // optional section headers when showing all
  let lastSection = "";
  for (const w of list) {
    const phase = workflowPhaseOf(w);
    const section =
      phase === "problem"
        ? "问题"
        : phase === "history"
          ? "历史终态"
          : "进行中";
    if (phaseFilter === "all" && section !== lastSection) {
      lastSection = section;
      const head = document.createElement("div");
      head.className = "wf-section";
      head.textContent = section;
      el.appendChild(head);
    }

    const btn = document.createElement("button");
    btn.className =
      "item wf-item phase-" +
      phase +
      (activeWorkflowId === w.correlation_id ? " active" : "");
    const st = w.delivery_status || {};
    const c = w.counts || {};
    const pills = [];
    if (st.pending || c.pending) pills.push(`p${st.pending || c.pending || 0}`);
    if (st.claimed || c.claimed) pills.push(`c${st.claimed || c.claimed || 0}`);
    if (st.acked || c.acked) pills.push(`a${st.acked || c.acked || 0}`);
    if (st.done || c.done) pills.push(`✓${st.done || c.done || 0}`);
    if (st.dead || c.dead) pills.push(`☠${st.dead || c.dead || 0}`);
    if (st.cancelled || c.cancelled) pills.push(`∅${st.cancelled || c.cancelled || 0}`);
    const topic = (w.topics || "").split(",")[0] || "";
    btn.innerHTML = `
      <div class="row1">
        <span class="wf-phase-tag phase-${phase}">${escapeHtml(WORKFLOW_PHASE_LABEL[phase] || phase)}</span>
        <span class="wf-id">${escapeHtml(w.correlation_id)}</span>
        <span class="tag">${w.event_count} evt</span>
      </div>
      <div class="row2">${escapeHtml(w.last_ts || "")}${topic ? ` · ${escapeHtml(topic)}` : ""} · ${escapeHtml(pills.join(" ") || "—")}</div>
      <div class="row2 wf-agents">${escapeHtml([w.from_agents, w.to_agents].filter(Boolean).join(" → ") || "")}</div>
    `;
    btn.onclick = () => openWorkflow(w.correlation_id);
    el.appendChild(btn);
  }
}

async function loadWorkflows() {
  const el = $("#workflow-list");
  el.innerHTML = `<div class="muted" style="padding:12px">加载…</div>`;
  try {
    const data = await api("/api/interactions?limit=80");
    workflowListCache = data.correlations || [];
    workflowSummary = data.summary || null;
    renderWorkflowList();
  } catch (e) {
    el.innerHTML = `<div class="muted" style="padding:12px">${escapeHtml(String(e.message || e))}</div>`;
  }
}

/** @type {string|null} */
let activeWorkflowId = null;
/** @type {Array<any>} */
let activeWorkflowRows = [];

function parseCausation(cid) {
  if (!cid) return null;
  const s = String(cid);
  let m = s.match(/seq:([^:]+):(\d+)/i);
  if (m) return { source_file: m[1], seq: Number(m[2]) };
  m = s.match(/seq:(\d+)/i);
  if (m) return { seq: Number(m[1]) };
  m = s.match(/(?:^|[^\d])(\d{1,9})$/);
  if (m) return { seq: Number(m[1]) };
  return null;
}

/** Group flat delivery rows → event nodes for flow graph. */
function buildFlowNodes(rows) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const r of rows) {
    const key = `${r.source_file || "?"}::${r.seq ?? r.event_id ?? "?"}`;
    if (!map.has(key)) {
      const summary =
        (r.payload && (r.payload.summary || r.payload.subject)) || r.topic || r.type || "";
      map.set(key, {
        key,
        event_id: r.event_id,
        source_file: r.source_file,
        seq: r.seq,
        ts: r.ts,
        from: r.from,
        type: r.type,
        topic: r.topic,
        causation_id: r.causation_id,
        summary,
        deliveries: [],
      });
    }
    const node = map.get(key);
    if (r.to_agent || r.delivery_id) {
      node.deliveries.push({
        delivery_id: r.delivery_id,
        to_agent: r.to_agent || "?",
        status: r.delivery_status || r.status || "unknown",
        attempt_count: r.attempt_count,
        lease_expires_at: r.lease_expires_at,
        has_token: r.has_token,
      });
    }
    // keep earliest ts / first causation
    if (r.ts && (!node.ts || r.ts < node.ts)) node.ts = r.ts;
    if (r.causation_id && !node.causation_id) node.causation_id = r.causation_id;
  }
  const nodes = [...map.values()].sort((a, b) => {
    if (a.ts && b.ts && a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return (a.seq || 0) - (b.seq || 0);
  });

  // resolve parent keys via causation
  const bySeqFile = new Map();
  const bySeq = new Map();
  for (const n of nodes) {
    bySeqFile.set(`${n.source_file}::${n.seq}`, n.key);
    if (!bySeq.has(n.seq)) bySeq.set(n.seq, n.key);
  }
  for (const n of nodes) {
    n.parentKey = null;
    const c = parseCausation(n.causation_id);
    if (!c) continue;
    if (c.source_file != null && c.seq != null) {
      n.parentKey = bySeqFile.get(`${c.source_file}::${c.seq}`) || bySeq.get(c.seq) || null;
    } else if (c.seq != null) {
      n.parentKey = bySeq.get(c.seq) || null;
    }
    if (n.parentKey === n.key) n.parentKey = null;
  }

  // layout levels (BFS from roots; fallback order)
  const children = new Map(nodes.map((n) => [n.key, []]));
  for (const n of nodes) {
    if (n.parentKey && children.has(n.parentKey)) children.get(n.parentKey).push(n.key);
  }
  const levelOf = new Map();
  const roots = nodes.filter((n) => !n.parentKey || !map.has(n.parentKey));
  const queue = roots.map((n) => n.key);
  roots.forEach((n) => levelOf.set(n.key, 0));
  while (queue.length) {
    const k = queue.shift();
    const lv = levelOf.get(k) || 0;
    for (const ch of children.get(k) || []) {
      const next = lv + 1;
      if (!levelOf.has(ch) || levelOf.get(ch) < next) {
        levelOf.set(ch, next);
        queue.push(ch);
      }
    }
  }
  // orphans without parent link still ordered by index
  nodes.forEach((n, i) => {
    if (!levelOf.has(n.key)) levelOf.set(n.key, i);
  });

  const byLevel = new Map();
  for (const n of nodes) {
    const lv = levelOf.get(n.key) || 0;
    n.level = lv;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(n);
  }
  const colW = 240;
  const rowH = 170;
  const padX = 28;
  const padY = 24;
  for (const [lv, list] of byLevel) {
    list.forEach((n, i) => {
      n.x = padX + lv * colW;
      n.y = padY + i * rowH;
      n.w = 200;
      n.h = 88 + Math.max(n.deliveries.length, 1) * 28;
    });
  }
  const maxX = Math.max(...nodes.map((n) => n.x + n.w), 400) + padX;
  const maxY = Math.max(...nodes.map((n) => n.y + n.h), 200) + padY;
  return { nodes, width: maxX, height: maxY };
}

function flowStatusRollup(nodes) {
  const counts = {
    pending: 0,
    claimed: 0,
    acked: 0,
    done: 0,
    dead: 0,
    cancelled: 0,
    other: 0,
  };
  for (const n of nodes) {
    for (const d of n.deliveries) {
      const st = d.status || "other";
      if (st in counts) counts[st] += 1;
      else counts.other += 1;
    }
  }
  return counts;
}

function renderWorkflowFlow(rows) {
  const canvas = $("#workflow-flow");
  const legend = $("#workflow-legend");
  if (!rows.length) {
    canvas.classList.add("empty");
    canvas.innerHTML = "空流程";
    legend?.classList.add("hidden");
    return;
  }
  const { nodes, width, height } = buildFlowNodes(rows);
  const counts = flowStatusRollup(nodes);
  canvas.classList.remove("empty");
  legend?.classList.remove("hidden");

  const nodeByKey = new Map(nodes.map((n) => [n.key, n]));
  const edges = nodes
    .filter((n) => n.parentKey && nodeByKey.has(n.parentKey))
    .map((n) => {
      const p = nodeByKey.get(n.parentKey);
      const x1 = p.x + p.w;
      const y1 = p.y + Math.min(p.h, 48);
      const x2 = n.x;
      const y2 = n.y + Math.min(n.h, 48);
      const mid = (x1 + x2) / 2;
      const live =
        n.deliveries.some((d) => d.status === "claimed" || d.status === "pending") ||
        p.deliveries.some((d) => d.status === "claimed" || d.status === "pending");
      return { d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`, live };
    });

  const activeN = counts.pending + counts.claimed + counts.acked;
  const histN = counts.done + (counts.cancelled || 0);
  const phaseHint =
    counts.dead > 0
      ? "phase:problem"
      : activeN > 0
        ? "phase:active"
        : histN > 0
          ? "phase:history"
          : "phase:other";
  const statsHtml = `<div class="flow-stats">
    <span class="wf-phase-tag ${phaseHint.replace(":", "-")}">${
      counts.dead > 0 ? "有问题" : activeN > 0 ? "进行中" : "历史终态"
    }</span>
    <span><b>${nodes.length}</b> steps</span>
    <span>pending <b>${counts.pending}</b></span>
    <span>claimed <b>${counts.claimed}</b></span>
    <span>acked <b>${counts.acked}</b></span>
    <span>done <b>${counts.done}</b></span>
    <span>dead <b>${counts.dead}</b></span>
    ${histN && activeN ? `<span class="muted">含历史完成步 ${histN}</span>` : ""}
    ${!activeN && histN ? `<span class="muted">全部终态 · 可回溯排障</span>` : ""}
  </div>`;

  const svgPaths = edges
    .map((e) => `<path class="${e.live ? "is-active" : ""}" d="${e.d}" />`)
    .join("");

  const nodesHtml = nodes
    .map((n) => {
      const hasDead = n.deliveries.some((d) => d.status === "dead");
      const hasLive = n.deliveries.some(
        (d) => d.status === "claimed" || d.status === "pending" || d.status === "acked",
      );
      const allTerminal =
        n.deliveries.length > 0 &&
        n.deliveries.every((d) => d.status === "done" || d.status === "cancelled");
      const dels =
        n.deliveries
          .map((d) => {
            const pulse =
              d.status === "claimed" || d.status === "acked"
                ? `<span class="flow-pulse" title="in flight"></span>`
                : "";
            const mark =
              d.status === "done" ? "✓ " : d.status === "cancelled" ? "∅ " : "";
            return `<div class="flow-del ${escapeHtml(d.status)}">
              <span class="fd-agent">${pulse}${escapeHtml(d.to_agent)}</span>
              <span class="fd-st">${mark}${escapeHtml(d.status)}</span>
            </div>`;
          })
          .join("") || `<div class="flow-del"><span class="muted">no delivery</span></div>`;
      return `<div class="flow-node ${hasDead ? "has-dead" : ""} ${hasLive ? "has-live" : ""} ${allTerminal ? "is-history" : ""}"
        style="left:${n.x}px;top:${n.y}px;width:${n.w}px"
        data-key="${escapeHtml(n.key)}" title="seq ${n.seq}">
        <div class="fn-type">${escapeHtml(n.type || "event")}${allTerminal ? ` <span class="fn-hist-badge">历史</span>` : ""}</div>
        <div class="fn-sum">${escapeHtml(String(n.summary || ""))}</div>
        <div class="fn-meta">seq ${escapeHtml(String(n.seq ?? "—"))} · from ${escapeHtml(n.from || "?")}${
          n.causation_id ? ` · ← ${escapeHtml(String(n.causation_id))}` : ""
        }</div>
        <div class="fn-dels">${dels}</div>
      </div>`;
    })
    .join("");

  canvas.innerHTML = `${statsHtml}
    <div class="flow-inner" style="width:${width}px;height:${height}px">
      <svg class="flow-svg" width="${width}" height="${height}">
        <defs>
          <marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="rgba(139,155,176,0.8)" />
          </marker>
        </defs>
        ${svgPaths}
      </svg>
      ${nodesHtml}
    </div>`;
}

/**
 * Agent-to-agent handoff history (what the user wants for triage).
 * One row per delivery: from → to · type · status · summary · time
 * Includes done / cancelled / dead so full history is visible.
 */
function buildHandoffSteps(rows) {
  const steps = rows
    .filter((r) => r.to_agent || r.delivery_id || r.from)
    .map((r, i) => {
      const summary =
        (r.payload && (r.payload.summary || r.payload.subject)) || r.topic || r.type || "";
      return {
        i: i + 1,
        ts: r.ts || "",
        from: r.from || "?",
        to: r.to_agent || "—",
        type: r.type || "event",
        topic: r.topic || "",
        status: r.delivery_status || r.status || "event",
        summary: String(summary),
        seq: r.seq,
        causation_id: r.causation_id,
        attempt_count: r.attempt_count || 0,
        lease_expires_at: r.lease_expires_at,
        delivery_id: r.delivery_id,
      };
    })
    .sort((a, b) => {
      if (a.ts && b.ts && a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
      return (a.seq || 0) - (b.seq || 0) || (a.delivery_id || 0) - (b.delivery_id || 0);
    });
  steps.forEach((s, idx) => {
    s.i = idx + 1;
  });
  return steps;
}

/** Compact path of agents in order of first appearance along the handoff chain. */
function agentPathSummary(steps) {
  const path = [];
  const seen = new Set();
  for (const s of steps) {
    for (const a of [s.from, s.to]) {
      if (!a || a === "?" || a === "—") continue;
      if (!seen.has(a)) {
        seen.add(a);
        path.push(a);
      }
    }
  }
  return path;
}

function renderWorkflowHandoffs(rows) {
  const box = $("#workflow-handoffs");
  if (!box) return;
  box.classList.remove("empty");
  const steps = buildHandoffSteps(rows);
  if (!steps.length) {
    box.innerHTML = `<div class="muted" style="padding:12px">无 agent 传递记录</div>`;
    return;
  }
  const path = agentPathSummary(steps);
  const nHist = steps.filter((s) => s.status === "done" || s.status === "cancelled").length;
  const nLive = steps.filter((s) =>
    ["pending", "claimed", "acked"].includes(s.status),
  ).length;
  const nDead = steps.filter((s) => s.status === "dead").length;

  const pathHtml = path.length
    ? `<div class="handoff-path">
        <span class="muted">参与 agent</span>
        ${path
          .map(
            (a, i) =>
              `${i ? `<span class="hp-arrow">→</span>` : ""}<span class="hp-agent">${escapeHtml(a)}</span>`,
          )
          .join("")}
        <span class="muted hp-counts">· ${steps.length} 次传递 · 进行中 ${nLive} · 终态 ${nHist} · dead ${nDead}</span>
      </div>`
    : "";

  // Group concurrent fan-out (same seq) under one "wave"
  let lastSeq = null;
  const parts = [];
  for (const s of steps) {
    if (s.seq !== lastSeq) {
      lastSeq = s.seq;
      parts.push(
        `<div class="handoff-wave">seq ${escapeHtml(String(s.seq ?? "—"))} · ${escapeHtml(s.type || "")}${
          s.causation_id
            ? ` <span class="muted">← ${escapeHtml(String(s.causation_id))}</span>`
            : ""
        }</div>`,
      );
    }
    const terminal = s.status === "done" || s.status === "cancelled";
    const live = ["pending", "claimed", "acked"].includes(s.status);
    parts.push(`
      <div class="handoff-step st-${escapeHtml(s.status)} ${terminal ? "is-terminal" : ""} ${live ? "is-live" : ""}">
        <div class="hs-idx">#${s.i}</div>
        <div class="hs-main">
          <div class="hs-agents">
            <span class="hs-from" title="from">${escapeHtml(s.from)}</span>
            <span class="hs-pipe">
              <span class="hs-line"></span>
              <span class="hs-type">${escapeHtml(s.type)}</span>
              <span class="hs-line"></span>
              <span class="hs-chev">▶</span>
            </span>
            <span class="hs-to" title="to">${escapeHtml(s.to)}</span>
            <span class="hs-status st-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>
          </div>
          <div class="hs-sum">${escapeHtml(s.summary)}</div>
          <div class="hs-meta">
            ${escapeHtml(s.ts || "—")}${s.topic ? ` · ${escapeHtml(s.topic)}` : ""}
            ${s.attempt_count ? ` · attempt ${s.attempt_count}` : ""}
            ${s.lease_expires_at ? ` · lease ${escapeHtml(s.lease_expires_at)}` : ""}
          </div>
        </div>
      </div>
    `);
  }

  box.innerHTML = pathHtml + `<div class="handoff-list">${parts.join("")}</div>`;
}

function renderWorkflowTimeline(rows) {
  const box = $("#workflow-timeline");
  box.classList.remove("empty");
  box.innerHTML = "";
  if (!rows.length) {
    box.innerHTML = `<div class="muted">空</div>`;
    return;
  }
  for (const e of rows) {
    const div = document.createElement("div");
    const st = e.delivery_status || "event";
    div.className = `tl-item ${escapeHtml(String(st))}`;
    const summary =
      (e.payload && (e.payload.summary || e.payload.subject)) || e.topic || e.type || "";
    div.innerHTML = `
      <div class="tl-head">${escapeHtml(e.from || "?")} → ${escapeHtml(e.to_agent || "—")} · ${escapeHtml(e.type || "?")} · ${escapeHtml(String(summary))}</div>
      <div class="tl-meta">${escapeHtml(e.ts || "")} · ${escapeHtml(String(st))} · seq ${escapeHtml(String(e.seq ?? ""))}${
        e.causation_id ? ` · cause ${escapeHtml(String(e.causation_id))}` : ""
      }</div>
    `;
    box.appendChild(div);
  }
}

async function openWorkflow(cid) {
  activeWorkflowId = cid;
  $("#workflow-title").textContent = cid;
  const box = $("#workflow-timeline");
  const flow = $("#workflow-flow");
  const btn = $("#refresh-workflow-detail");
  if (btn) btn.classList.remove("hidden");
  box.classList.remove("empty");
  flow.classList.remove("empty");
  box.innerHTML = `<div class="muted">加载时间线…</div>`;
  flow.innerHTML = `<div class="muted" style="padding:24px">加载流程图…</div>`;
  const hoLoad = $("#workflow-handoffs");
  if (hoLoad) {
    hoLoad.classList.remove("empty");
    hoLoad.innerHTML = `<div class="muted" style="padding:12px">加载 agent 传递过程…</div>`;
  }
  try {
    const data = await api(`/api/interactions/${encodeURIComponent(cid)}`);
    const events = data.events || [];
    activeWorkflowRows = events;
    $("#workflow-meta").textContent = `${events.length} delivery rows · ${fmtTime(new Date())}`;
    if (!events.length) {
      flow.classList.add("empty");
      flow.textContent = "空";
      box.innerHTML = `<div class="muted">空</div>`;
      const ho = $("#workflow-handoffs");
      if (ho) {
        ho.classList.add("empty");
        ho.textContent = "无传递记录";
      }
      $("#workflow-legend")?.classList.add("hidden");
      return;
    }
    renderWorkflowHandoffs(events);
    renderWorkflowFlow(events);
    renderWorkflowTimeline(events);
    // keep list selection highlight
    renderWorkflowList();
  } catch (err) {
    flow.classList.add("empty");
    flow.textContent = String(err.message || err);
    box.innerHTML = `<div class="muted">${escapeHtml(String(err.message || err))}</div>`;
    const ho = $("#workflow-handoffs");
    if (ho) {
      ho.classList.remove("empty");
      ho.innerHTML = `<div class="muted">${escapeHtml(String(err.message || err))}</div>`;
    }
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

function dataToast(msg, kind) {
  const el = $("#data-op-toast");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("err", "ok");
  if (kind) el.classList.add(kind);
}

async function loadPaths() {
  const data = await api("/api/events/status");
  const ex = data.exists || {};
  const paths = data.paths || {};
  const sql = data.sqlite || {};
  const fr = data.freshness || {};
  const nJsonl = data.jsonl_count ?? 0;
  const nEv = sql.events || 0;
  const isLive = nJsonl > 0 || nEv > 100;
  const by = sql.by_status || {};
  const banner = $("#data-mode-banner");
  if (banner) {
    banner.className =
      "banner " + (fr.stale ? "stale-warn" : isLive ? "ok-ish" : "muted");
    const frLine = fr.last_sync_at
      ? `上次同步 ${fr.last_sync_at}${fr.sync_age_hours != null ? ` (${fr.sync_age_hours}h 前)` : ""}`
      : "尚无同步时间戳";
    banner.textContent = isLive
      ? `数据源：生产/实库 · JSONL ${nJsonl} · events ${nEv} · del ${sql.deliveries ?? 0}` +
        ` · p${by.pending ?? 0}/blk${by.blocked ?? 0}/☠${by.dead ?? 0}/hist${by.historical ?? 0}` +
        ` · ${frLine}${fr.stale ? " · ⚠ 可能过期" : ""}` +
        (isReadonly() ? " · 只读" : " · 可写")
      : `数据源：空或仅 demo · JSONL ${nJsonl} · events ${nEv}。可同步真数据或加载演示。`;
  }
  $("#paths-cards").innerHTML = [
    card("A2A_LOG_HOME", paths.A2A_LOG_HOME, ex.home),
    card("events/*.jsonl", `${nJsonl} files`, ex.events_dir && nJsonl > 0),
    card(
      "a2a-v2.sqlite",
      sql.ok ? `${sql.events} events · ${sql.deliveries} deliveries` : "missing",
      ex.db && sql.ok,
    ),
    card(
      "新鲜度",
      fr.stale
        ? `过期 · sync ${fr.sync_age_hours ?? "?"}h`
        : fr.last_sync_at
          ? `ok · ${fr.sync_age_hours ?? "?"}h`
          : `db 龄 ${fr.db_age_hours ?? "?"}h`,
      !fr.stale && isLive,
    ),
    card("a2a-log.py", paths.A2A_LOG_CLI, ex.v1_script),
  ].join("");
  $("#paths-out").textContent = JSON.stringify(data, null, 2);
}

async function syncProdData() {
  if (
    !confirm(
      "将通过 rsync 从 A2AX_SYNC_REMOTE（默认 macmini-ts 生产 a2a-log）拉到本机 A2A_LOG_HOME。\n" +
        "可能覆盖本地文件。本机建议 A2AX_READONLY=1，勿在副本上 claim/done。\n继续？",
    )
  ) {
    return;
  }
  dataToast("同步中（可能需 1–2 分钟）…");
  setLoading(true);
  try {
    const out = await api("/api/data/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    dataToast(
      out.ok
        ? `同步完成 · JSONL ${out.after?.jsonlCount ?? "?"} · mode ${out.after?.dataMode || ""}`
        : `同步失败 · ${out.stderr || out.error || "error"}`,
      out.ok ? "ok" : "err",
    );
    await loadPaths();
    if (out.ok) await loadBoard().catch(() => {});
  } catch (e) {
    dataToast(String(e.message || e), "err");
  } finally {
    setLoading(false);
  }
}

async function backfillData() {
  if (isReadonly()) {
    dataToast("只读模式禁止 backfill（会改 sqlite）。请在可写权威机执行，或取消 A2AX_READONLY。", "err");
    return;
  }
  if (
    !confirm(
      "运行 a2a-v2-backfill：把 events/*.jsonl 导入 sqlite。大库可能较慢。继续？",
    )
  ) {
    return;
  }
  dataToast("backfill 运行中…");
  setLoading(true);
  try {
    const out = await api("/api/data/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    dataToast(out.ok ? "backfill 完成" : `backfill 失败 · ${(out.stderr || "").slice(0, 200)}`, out.ok ? "ok" : "err");
    await loadPaths();
    if (out.ok) await loadBoard().catch(() => {});
  } catch (e) {
    dataToast(String(e.message || e), "err");
  } finally {
    setLoading(false);
  }
}

function card(title, val, ok) {
  return `<div class="card"><h3>${escapeHtml(title)}</h3><div class="val ${ok ? "ok" : "bad"}">${escapeHtml(String(val))}${ok ? " ✓" : " ✗"}</div></div>`;
}

async function loadHealth() {
  try {
    const [health, meta] = await Promise.all([api("/api/health"), api("/api/meta")]);
    appMeta = { ...meta, ...health, readonly: health.readonly ?? meta.readonly };
    ensureReadonlyBanner();
    const fr = health.freshness || meta.freshness || {};
    const el = health.eventLog || {};
    const sql = el.sqlite || {};
    const adapters = health.adapters || [];
    const cards = $("#health-cards");
    if (cards) {
      cards.innerHTML = [
        card("版本", health.version || meta.version || "?", true),
        card(
          "模式",
          health.readonly ? `只读 · ${health.readonly_reason || ""}` : "可写 · authority",
          !health.readonly,
        ),
        card(
          "数据",
          `${health.dataMode || "?"} · events ${sql.events ?? "?"} · del ${sql.deliveries ?? "?"}`,
          health.dataMode === "live" || (sql.events || 0) > 0,
        ),
        card(
          "新鲜度",
          fr.stale
            ? `过期 ${fr.sync_age_hours ?? fr.db_age_hours ?? "?"}h`
            : fr.last_sync_at
              ? `sync ${fr.sync_age_hours ?? "?"}h 前`
              : `db 龄 ${fr.db_age_hours ?? "—"}h`,
          !fr.stale,
        ),
        card(
          "Adapters",
          adapters.filter((a) => a.ok).length + "/" + adapters.length + " ok",
          adapters.every((a) => a.ok),
        ),
        card("Agent 接入", health.agentAccess || meta.agentAccess || "event-log-protocol", true),
      ].join("");
    }
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
$("#demo-seed")?.addEventListener("click", () => seedDemo({ reset: true }));
$("#demo-wipe")?.addEventListener("click", () => {
  if (confirm("清除 sqlite 中 source_file=demo（及 test）行？不影响生产 JSONL。")) {
    seedDemo({ wipeOnly: true });
  }
});
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
$("#refresh-system")?.addEventListener("click", () => refreshSystem());
$("#btn-data-sync")?.addEventListener("click", () => syncProdData());
$("#btn-data-backfill")?.addEventListener("click", () => backfillData());
$("#btn-data-refresh")?.addEventListener("click", () => loadPaths());
$("#audit-show-raw")?.addEventListener("click", () => {
  const raw = $("#audit-out");
  if (!raw) return;
  raw.classList.toggle("hidden");
  $("#audit-show-raw").textContent = raw.classList.contains("hidden")
    ? "显示原始 JSON"
    : "隐藏原始 JSON";
});
$$("#system-subnav .nav-sub-item").forEach((b) => {
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    systemTab = b.dataset.systemTab || "paths";
    setView("system");
  });
});
$$("#system-tabs .stab").forEach((b) => {
  b.addEventListener("click", () => setSystemTab(b.dataset.systemTab));
});
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
$("#workflow-phase")?.addEventListener("change", renderWorkflowList);
$("#workflow-filter")?.addEventListener("input", renderWorkflowList);
$("#refresh-workflow-detail")?.addEventListener("click", () => {
  if (activeWorkflowId) openWorkflow(activeWorkflowId);
});

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

$("#copy-resume").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#resume-cmd").textContent);
    $("#copy-resume").textContent = "已复制";
    setTimeout(() => ($("#copy-resume").textContent = "复制"), 1200);
  } catch {
    /* ignore */
  }
});

loadAppMeta().finally(() => loadBoard());
