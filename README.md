# A2A Event X

**Standalone B/S product** for multi-agent session browsing and A2A Event Log.

Primary UX is a **local web app** (browser + HTTP API), not the terminal.

| Layer | Package | Role |
|-------|---------|------|
| **Web UI + API** | `packages/webapp` | Human product surface |
| **Session Hub** | `packages/session-hub` | Read Claude / Codex / OpenClaw / Grok / Antigravity sessions |
| **Event Log** | `packages/event-log` | Merged [a2a-toolkit](https://github.com/dennyandwu/a2a-toolkit) + v2 lease/bridge |
| CLI | `packages/cli` | Secondary / scripts |
| MCP | `packages/mcp-server` | **Deferred** until product is complete |

## Quick start (B/S)

```bash
git clone https://github.com/dennyandwu/a2a-event-x.git
cd a2a-event-x
npm install
npm run build
npm run web
```

Open **http://127.0.0.1:8787/**

- **Sessions** — list / filter / open messages / copy resume hint  
- **Event Log** — pull agent inbox (`a2a-v2`)  
- **Health** — adapter roots + toolkit presence  

```bash
# optional bind (e.g. Tailscale)
A2AX_HOST=0.0.0.0 A2AX_PORT=8787 npm run web
```

## a2a-toolkit (Event Log) source

| | |
|--|--|
| **Repo** | https://github.com/dennyandwu/a2a-toolkit *(private)* |
| **Description** | urDAO A2A Toolkit — Event Log + Hook-C + Pipeline Executor |
| **Canonical CLI** | `packages/event-log/scripts/a2a-log.py` |
| **Upstream README** | `packages/event-log/docs-upstream/a2a-toolkit-README.md` |

Additional 2026-07 hardening (v2 claim/lease, bridge) lives next to it as `a2a-v2.py`, `bridge_v2.py`, etc.

## Architecture

```
Browser  ──HTTP──►  webapp (:8787)
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     Session Hub   Event Log    (later MCP)
     adapters      a2a-log.py
                   a2a-v2.py
```

## API (v0.1)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | adapters + toolkit flags |
| GET | `/api/sessions` | `?provider=&project=&limit=` |
| GET | `/api/sessions/:id` | session metadata |
| GET | `/api/sessions/:id/messages` | paginated messages |
| GET | `/api/search?q=` | cross-tool search |
| GET | `/api/events/inbox?agent=` | Event Log inbox proxy |

## Deferred

- **MCP** server packaging and OpenClaw `mcpServers` wiring  
- Projector auto-write into Event Log  
- Full UI for claim/ack/done (inbox JSON first)  

## License

MIT for Event X scaffolding. Toolkit scripts retain urDAO/private project terms as upstream.
