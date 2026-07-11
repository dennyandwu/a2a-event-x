const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let sessions = [];
let activeId = null;

/** @type {Array<any>} */
let events = [];
let activeEventIdx = null;

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
  $("#view-sessions").classList.toggle("hidden", name !== "sessions");
  $("#view-events").classList.toggle("hidden", name !== "events");
  $("#view-health").classList.toggle("hidden", name !== "health");
  $("#session-filters").classList.toggle("hidden", name !== "sessions");
  $("#event-filters").classList.toggle("hidden", name !== "events");
  if (name === "health") loadHealth();
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
      box.innerHTML = `<div class="muted">该 session 暂无可解析消息（或格式待适配）</div>`;
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

// ── Event Log ─────────────────────────────────────────────

function toast(msg, kind) {
  const el = $("#event-toast");
  el.textContent = msg || "";
  el.classList.remove("err", "ok");
  if (kind) el.classList.add(kind);
}

async function loadEvents(claim) {
  const agent = $("#agent").value.trim() || "issac";
  const limit = $("#event-limit").value || "20";
  toast(claim ? "Claiming…" : "Loading…");
  try {
    let data;
    if (claim) {
      data = await api("/api/events/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, limit: Number(limit) }),
      });
    } else {
      data = await api(
        `/api/events/inbox?agent=${encodeURIComponent(agent)}&limit=${encodeURIComponent(limit)}`,
      );
    }
    events = data.events || [];
    const rem = data.count_remaining_pending;
    $("#event-count").textContent =
      `${events.length} shown` +
      (rem != null ? ` · pending left ${rem}` : "") +
      (data.claimed ? " · claimed" : "");
    activeEventIdx = null;
    renderEventList();
    $("#event-detail").classList.add("empty");
    $("#event-detail").textContent = events.length
      ? "选择一条 delivery"
      : "inbox 为空（或 DB 未双写；确认 A2A_LOG_HOME / a2a-v2.sqlite）";
    $("#event-ops").classList.add("hidden");
    toast(
      events.length
        ? `已加载 ${events.length} 条${data.claimed ? "（含 claim_token）" : ""}`
        : "无 pending",
      "ok",
    );
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
    const token = ev.claim_token ? "🎫" : "";
    btn.innerHTML = `
      <div class="row1">
        <span>${escapeHtml(topic)} ${token}</span>
        <span class="tag">${escapeHtml(from)}</span>
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
  $("#event-detail-title").textContent = `${ev.type || "event"} · ${ev.topic || ""}`;
  $("#event-detail-meta").textContent = `${ev.from || "?"} → seq ${ev.seq ?? "?"} ${ev.claim_token ? "· token held" : "· no token"}`;
  const box = $("#event-detail");
  box.classList.remove("empty");
  box.innerHTML = `<pre class="codeblock" style="margin:0;max-height:none">${escapeHtml(JSON.stringify(ev, null, 2))}</pre>`;
  if (ev.claim_token) {
    $("#event-ops").classList.remove("hidden");
  } else {
    $("#event-ops").classList.add("hidden");
    toast("只读视图无 claim_token — 点「Claim 并加载」后才能操作", "");
  }
}

async function eventOp(op) {
  const ev = events[activeEventIdx];
  if (!ev?.claim_token) {
    toast("需要 claim_token", "err");
    return;
  }
  const token = ev.claim_token;
  toast(`${op}…`);
  try {
    let body = { token };
    if (op === "done") {
      const summary = $("#done-summary").value.trim();
      if (summary) body.summary = summary;
    }
    if (op === "cancel") {
      body.reason = $("#done-summary").value.trim() || "cancelled via Event X UI";
    }
    const data = await api(`/api/events/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast(`${op} ok: ${JSON.stringify(data).slice(0, 120)}`, "ok");
    if (op === "done" || op === "cancel" || op === "ack") {
      // remove finished from list for ack keep but mark; for done/cancel remove
      if (op === "done" || op === "cancel") {
        events.splice(activeEventIdx, 1);
        activeEventIdx = null;
        renderEventList();
        $("#event-ops").classList.add("hidden");
        $("#event-detail").classList.add("empty");
        $("#event-detail").textContent = "已处理，选择下一条";
      } else if (op === "ack") {
        ev._acked = true;
        selectEvent(activeEventIdx);
      }
    }
  } catch (e) {
    toast(String(e.message || e), "err");
  }
}

// ── Health ────────────────────────────────────────────────

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
  const t = $("#resume-cmd").textContent;
  try {
    await navigator.clipboard.writeText(t);
    $("#copy-resume").textContent = "已复制";
    setTimeout(() => ($("#copy-resume").textContent = "复制"), 1200);
  } catch {
    /* ignore */
  }
});

loadSessions().catch((e) => {
  $("#session-list").innerHTML = `<div class="muted" style="padding:12px">${escapeHtml(String(e))}</div>`;
});
