# Locked decisions

## Product stance

**A2A Event X is a standalone B/S product.**

| Priority | Surface | Role |
|----------|---------|------|
| **P0** | **Browser UI + HTTP API** (`packages/webapp`) | Primary human interface |
| P1 | Event Log toolkit (`packages/event-log`) | Cross-agent bus (from a2a-toolkit) |
| P2 | CLI `a2ax` | Secondary / scripting only |
| **Later** | MCP stdio | After product complete; optional agent client |
| Later | OpenClaw `mcpServers` wiring | Thin client only |

OpenClaw is **not** required to run Event X.

---

## a2a-toolkit / Event Log

- **GitHub (found):** https://github.com/dennyandwu/a2a-toolkit  
  - Desc: *urDAO A2A Toolkit — Event Log + Hook-C + Pipeline Executor*  
  - Core: `scripts/a2a-log.py` (~2k LOC), Hook-C, pipeline executor, send, monitor  
  - Docs: README in repo; detailed PRD historically in Obsidian `PROJ-012-Agent-Dashboard`  
- **Merged into:** `packages/event-log/scripts/*` (+ p0-fix v2/bridge layer alongside)  
- **Version note:** toolkit repo last updated ~2026-04 (v0.3); p0-fix adds 2026-07 v2 lease/bridge work — keep both until reconciled.

---

## Technical locks

1. **Repo:** independent monorepo `a2a-event-x`.
2. **Stack:**
   - **B/S:** Hono HTTP API + static web UI (local-first, default `127.0.0.1:8787`)
   - **Python** Event Log (toolkit + v2)
   - **TypeScript** Session Hub adapters
3. **Adapters:** Claude Code · Codex · OpenClaw · Grok Build · Antigravity CLI  
   - “OpenClaw” = read local session stores, not gateway dependency
4. **Projector:** optional; default OFF
5. **Names:** `a2a-event-x` · web `a2ax-web` · CLI `a2ax` · MCP tools `x_*` (deferred)
6. **MCP deferred** until B/S + Event Log merge are product-ready

---

## Anti-goals (now)

- Do not treat CLI as primary UX  
- Do not block on OpenClaw / MCP  
- Do not embed state into OpenClaw session store  
- Do not reimplement full A2A transport mesh (see reference deep-dive)

## Research references

Deep analysis of the two **community** A2A integrations named in discovery
(neither is an official `openclaw/*` core project):

- **Doc:** [reference/openclaw-a2a-deep-dive.md](./reference/openclaw-a2a-deep-dive.md)
- **Repos:**
  - https://github.com/win4r/openclaw-a2a-gateway — third-party OpenClaw-hosted **A2A mesh gateway** (win4r)
  - https://github.com/a2anet/openclaw-a2a-plugin — **A2A Net** OpenClaw adapter over `a2a-utils` / standard A2A
