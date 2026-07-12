# Locked decisions

## Product stance

**A2A Event X is a standalone B/S product for multi-agent interaction management.**

Ultimate goal: **manage agent↔agent work** (visibility, claim/lease, ops), not multi-CLI chat browsing.

| Priority | Surface | Role |
|----------|---------|------|
| **P0** | **Agents board + Inbox** (`packages/webapp`) | Primary **human** interface |
| **P0** | Event Log toolkit (`packages/event-log`) | Cross-agent bus (canonical JSONL + v2 lease) |
| **P1** | **Agent Skill** (`skills/a2a-consumer`) | Teach agents how to pull / claim / done via CLI |
| P2 | Sessions module | Context only (coding CLI history) |
| P3 | CLI `a2ax` | Secondary / scripting (session + log proxy) |

**Locked 2026-07-12:** product = multi-agent interaction console; R1 = agent pending/claimed board; name stays **A2A Event X**.

**Locked 2026-07-12 (update):** **No MCP** in this project. Agent access = **CLI + Skill**; human access = **B/S**. OpenClaw plugins (if any) stay host-side automation only.

OpenClaw is **not** required to run Event X.

---

## a2a-toolkit / Event Log

- **GitHub:** https://github.com/dennyandwu/a2a-toolkit  
- **Merged into:** `packages/event-log/scripts/*` (+ v2 lease / bridge layer)

---

## Technical locks

1. **Repo:** independent monorepo `a2a-event-x`.
2. **Stack:**
   - **B/S:** Hono HTTP API + static web UI (local-first, default `127.0.0.1:8787`)
   - **Python** Event Log (toolkit + v2)
   - **TypeScript** Session Hub adapters (context only)
3. **Adapters:** Claude Code · Codex · OpenClaw · Grok Build · Antigravity CLI  
   - “OpenClaw” = read local session stores, not gateway dependency
4. **Projector:** optional; default OFF
5. **Names:** `a2a-event-x` · web `a2ax-web` · CLI `a2ax`
6. **Out of scope:** MCP server / `mcpServers` wiring / MCP tools as product surface

---

## Anti-goals (now)

- Do not treat CLI as primary **human** UX  
- Do not add MCP as a third business surface  
- Do not block on OpenClaw  
- Do not embed state into OpenClaw session store  
- Do not reimplement full A2A transport mesh (see reference deep-dive)

## Research references

- [reference/openclaw-a2a-deep-dive.md](./reference/openclaw-a2a-deep-dive.md)  
- Community A2A plugins are **not** OpenClaw official core
