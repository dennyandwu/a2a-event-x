const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let sessions = [];
let activeId = null;

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${t}`);
  }
  return res.json();
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

async function loadEvents() {
  const agent = $("#agent").value.trim() || "issac";
  $("#events-out").textContent = "加载中…";
  try {
    const data = await api(`/api/events/inbox?agent=${encodeURIComponent(agent)}&limit=30`);
    $("#events-out").textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    $("#events-out").textContent = String(e.message || e);
  }
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

$$(".nav").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("#refresh").addEventListener("click", loadSessions);
$("#provider").addEventListener("change", loadSessions);
$("#project").addEventListener("keydown", (e) => e.key === "Enter" && loadSessions());
$("#search").addEventListener("keydown", (e) => e.key === "Enter" && doSearch());
$("#load-events").addEventListener("click", loadEvents);
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
