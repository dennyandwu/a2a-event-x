const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let sessions = [];
let activeId = null;
/** @type {Array<any>} */
let events = [];
let activeEventIdx = null;
let inboxMeta = { mode: "v2" };
/** @type {any} */
let boardData = null;

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

function setView(name) {
  $$(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#view-agents").classList.toggle("hidden", name !== "agents");
  $("#view-events").classList.toggle("hidden", name !== "events");
  $("#view-sessions").classList.toggle("hidden", name !== "sessions");
  $("#view-paths").classList.toggle("hidden", name !== "paths");
  $("#view-health").classList.toggle("hidden", name !== "health");
  $("#agent-filters").classList.toggle("hidden", name !== "agents");
  $("#event-filters").classList.toggle("hidden", name !== "events");
  $("#session-filters").classList.toggle("hidden", name !== "sessions");
  $("#path-filters").classList.toggle("hidden", name !== "paths");
  if (name === "agents") loadBoard();
  if (name === "health") loadHealth();
  if (name === "paths") loadPaths();
  if (name === "events") ensureAgentsLoaded();
  if (name === "sessions" && !sessions.length) loadSessions().catch(() => {});
}

// ── Agents board (primary) ────────────────────────────────

async function loadBoard() {
  const err = $("#board-error");
  err.classList.add("hidden");
  try {
    boardData = await api("/api/agents/board");
    renderBoard();
  } catch (e) {
    err.textContent = String(e.message || e);
    err.classList.remove("hidden");
    $("#agent-board").innerHTML = "";
  }
}

function renderBoard() {
  if (!boardData) return;
  const hideIdle = $("#hide-idle").checked;
  const hideReserved = $("#hide-reserved").checked;
  const t = boardData.totals || {};
  $("#board-totals").textContent =
    `Σ pending ${t.pending || 0} · claimed ${t.claimed || 0} · acked ${t.acked || 0}` +
    (boardData.db_ok ? "" : " · DB missing");

  if (boardData.error) {
    $("#board-error").textContent = boardData.error;
    $("#board-error").classList.remove("hidden");
  }

  let agents = boardData.agents || [];
  if (hideIdle) agents = agents.filter((a) => a.total_active > 0 || a.dead > 0);
  if (hideReserved) agents = agents.filter((a) => !a.reserved);

  const el = $("#agent-board");
  el.innerHTML = "";
  if (!agents.length) {
    el.innerHTML = `<div class="muted" style="padding:12px">没有可显示的 agent。关闭「隐藏无积压」可看全注册表；或确认 v2 sqlite 有 deliveries。</div>`;
    return;
  }

  for (const a of agents) {
    const card = document.createElement("button");
    card.className = "agent-card" + (a.total_active > 0 ? " has-work" : "");
    const pills = [];
    if (a.pending) pills.push(`<span class="stat pending">pending ${a.pending}</span>`);
    if (a.claimed) pills.push(`<span class="stat claimed">claimed ${a.claimed}</span>`);
    if (a.acked) pills.push(`<span class="stat acked">acked ${a.acked}</span>`);
    if (a.dead) pills.push(`<span class="stat dead">dead ${a.dead}</span>`);
    if (a.done) pills.push(`<span class="stat">done ${a.done}</span>`);
    if (!pills.length) pills.push(`<span class="stat">idle</span>`);

    const samples = (a.sample_pending || [])
      .slice(0, 4)
      .map((s) => {
        const summary =
          (s.payload && (s.payload.summary || s.payload.subject)) ||
          s.topic ||
          s.type ||
          "delivery";
        return `<div class="sample"><b>${escapeHtml(s.status)}</b> · ${escapeHtml(String(summary))} · ${escapeHtml(s.from || "?")}#${escapeHtml(String(s.seq ?? ""))}</div>`;
      })
      .join("");

    card.innerHTML = `
      <div class="ac-head">
        <span class="ac-name">${escapeHtml(a.agent_id)}</span>
        <span class="tag">${escapeHtml(a.host || (a.in_registry ? "registry" : "db-only"))}</span>
      </div>
      <div class="ac-meta">${escapeHtml([a.access, a.sla, a.notes].filter(Boolean).join(" · ") || "—")}</div>
      <div class="pills">${pills.join("")}</div>
      ${
        a.oldest_pending_ts
          ? `<div class="ac-meta">oldest pending: ${escapeHtml(a.oldest_pending_ts)}</div>`
          : ""
      }
      ${samples ? `<div class="samples">${samples}</div>` : ""}
    `;
    card.onclick = () => openAgentInbox(a.agent_id);
    el.appendChild(card);
  }
}

function openAgentInbox(agentId) {
  setView("events");
  ensureAgentsLoaded().then(() => {
    const sel = $("#agent");
    // ensure option exists
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

// ── Registry agents ───────────────────────────────────────

async function ensureAgentsLoaded() {
  const sel = $("#agent");
  if (sel.options.length > 0 && sel.dataset.loaded === "1") return;
  try {
    const data = await api("/api/registry/agents");
    const agents = data.agents || [];
    sel.innerHTML = "";
    for (const a of agents) {
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

// ── Sessions (secondary) ──────────────────────────────────

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

// ── Event Log inbox ───────────────────────────────────────

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
    inboxMeta = { mode: data.mode || (claim ? "v2" : mode), note: data.note };
    const rem = data.count_remaining_pending;
    $("#event-count").textContent =
      `${events.length} shown` +
      (rem != null ? ` · ${rem} remaining` : "") +
      (data.claimed ? " · claimed" : "") +
      ` · ${data.mode || "?"}`;
    $("#event-mode-banner").textContent =
      data.note ||
      (data.mode === "v1"
        ? "v1 JSONL pending — 使用 v1 ACK/DONE"
        : data.mode === "v2"
          ? "v2 sqlite — Claim 后用 token 操作"
          : "");
    activeEventIdx = null;
    renderEventList();
    $("#event-detail").classList.add("empty");
    $("#event-detail").textContent = events.length
      ? "选择一条 delivery"
      : "inbox 为空。回 Agents 看板看整体积压。";
    $("#event-ops").classList.add("hidden");
    toast(events.length ? `已加载 ${events.length} 条 [${data.mode}]` : "无 pending", "ok");
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
    const seq = ev.seq != null ? `seq ${ev.seq}` : "";
    const badge = ev.claim_token ? "🎫" : ev.mode === "v1" || ev.v1 ? "v1" : "v2";
    btn.innerHTML = `
      <div class="row1">
        <span>${escapeHtml(topic)}</span>
        <span class="tag">${escapeHtml(String(badge))} · ${escapeHtml(from)}</span>
      </div>
      <div class="row2">${escapeHtml(seq)} · attempts ${ev.attempt_count ?? 0} · ${escapeHtml(ev.ts || "")}</div>
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
  const hasToken = Boolean(ev.claim_token);
  $("#event-detail-title").textContent = `${ev.type || "event"} · ${ev.topic || ""}`;
  $("#event-detail-meta").textContent = isV1
    ? `v1 · file=${ev.v1?.file || ev.source_file || ev.from} · seq ${ev.seq}`
    : `v2 · ${ev.claim_token ? "token held" : "no token — Claim 后操作"}`;
  const box = $("#event-detail");
  box.classList.remove("empty");
  box.innerHTML = `<pre class="codeblock" style="margin:0;max-height:none">${escapeHtml(JSON.stringify(ev, null, 2))}</pre>`;

  if (hasToken || isV1) {
    $("#event-ops").classList.remove("hidden");
    if (isV1) {
      $("#op-cancel").classList.add("hidden");
      $("#op-renew").classList.add("hidden");
    } else {
      $("#op-cancel").classList.remove("hidden");
      $("#op-renew").classList.remove("hidden");
    }
  } else {
    $("#event-ops").classList.add("hidden");
    toast("v2 只读：点「Claim (v2)」后再操作", "");
  }
}

async function eventOp(op) {
  const ev = events[activeEventIdx];
  if (!ev) return;
  const isV1 = Boolean(ev.v1 || ev.mode === "v1");
  toast(`${op}…`);
  try {
    if (isV1) {
      const file = String(ev.v1?.file || ev.source_file || ev.from || "");
      const seq = String(ev.v1?.seq ?? ev.seq ?? "");
      const agent = $("#agent").value.trim() || String(ev.v1?.agent || "");
      if (op !== "ack" && op !== "done") {
        toast("v1 仅支持 ACK / DONE", "err");
        return;
      }
      const body = { agent, seq, file };
      if (op === "done") {
        const summary = $("#done-summary").value.trim();
        if (summary) body.summary = summary;
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
      if (op === "done") {
        const summary = $("#done-summary").value.trim();
        if (summary) body.summary = summary;
      }
      if (op === "cancel") {
        body.reason = $("#done-summary").value.trim() || "cancelled via Event X UI";
      }
      await api(`/api/events/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    toast(`${op} ok`, "ok");
    if (op === "done" || op === "cancel" || isV1) {
      events.splice(activeEventIdx, 1);
      activeEventIdx = null;
      renderEventList();
      $("#event-ops").classList.add("hidden");
      $("#event-detail").classList.add("empty");
      $("#event-detail").textContent = "已处理，选择下一条";
    } else if (op === "ack") {
      ev._acked = true;
      selectEvent(activeEventIdx);
    } else if (op === "renew") {
      selectEvent(activeEventIdx);
    }
  } catch (e) {
    toast(String(e.message || e), "err");
  }
}

// ── Write path / Health ───────────────────────────────────

async function loadPaths() {
  const data = await api("/api/events/status");
  const cards = $("#paths-cards");
  const ex = data.exists || {};
  const paths = data.paths || {};
  const sql = data.sqlite || {};
  cards.innerHTML = [
    card("A2A_LOG_HOME", paths.A2A_LOG_HOME, ex.home),
    card("events/*.jsonl", `${data.jsonl_count ?? 0} files`, ex.events_dir),
    card(
      "a2a-v2.sqlite",
      sql.ok ? `${sql.events} events · ${sql.deliveries} deliveries` : "missing",
      ex.db,
    ),
    card("a2a-log.py (v1)", paths.A2A_LOG_CLI, ex.v1_script),
    card("a2a-v2.py", paths.v2_script, ex.v2_script),
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
  const t = $("#resume-cmd").textContent;
  try {
    await navigator.clipboard.writeText(t);
    $("#copy-resume").textContent = "已复制";
    setTimeout(() => ($("#copy-resume").textContent = "复制"), 1200);
  } catch {
    /* ignore */
  }
});

// Default view: Agents board
loadBoard();
