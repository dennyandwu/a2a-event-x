# A2A Event X

**Standalone product:** Session Hub + Event Log for heterogeneous AI agents.

Unified local view of **Claude Code · Codex · OpenClaw · Grok Build · Antigravity CLI** sessions and messages, exposed as:

- **CLI** `a2ax` (primary human interface)
- **stdio MCP** binary (any MCP host — Claude Desktop, Cursor, etc.)
- **Event Log** (merged from PROJ-012 / a2a-toolkit snapshot) under `packages/event-log`

### Product order

1. **Now** — ship and use **A2A Event X alone** (no OpenClaw required).
2. **Later** — optionally point OpenClaw’s `mcpServers` at this MCP binary (thin client wiring only).

> OpenClaw is an optional **client**, not the owner. Event Log stays pull-first and decoupled.

## Why two layers?

| Layer | Owns | Question it answers |
|-------|------|---------------------|
| **Session Hub** | Read-only index of vendor CLI/desktop transcripts | “What sessions/messages do I have on this machine?” |
| **Event Log** | Cross-agent task bus (claim / lease / ack / done) | “What work is assigned between agents?” |
| **Projector** (optional, default OFF) | Pointers from Session Hub → Event Log | “Should other agents see that a coding session opened?” |

See [docs/DECISIONS.md](docs/DECISIONS.md) for locked product decisions, and [docs/heritage/](docs/heritage/) for prior Event Log design.

## Quick start

```bash
git clone https://github.com/dennyandwu/a2a-event-x.git
cd a2a-event-x
npm install
npm run build

# Session Hub
node packages/cli/dist/index.js health
node packages/cli/dist/index.js list --limit 20
node packages/cli/dist/index.js search "TODO"

# MCP (stdio) — wire into OpenClaw / Claude Desktop
node packages/mcp-server/dist/index.js

# Event Log v2 consumer (Python)
python3 packages/event-log/a2a-v2.py --help
```

### Later: optional OpenClaw (or any agent) as MCP client

Not required for day-to-day use. When you want an agent to *query* this product:

```json
{
  "mcpServers": {
    "a2a-event-x": {
      "command": "node",
      "args": ["/absolute/path/to/a2a-event-x/packages/mcp-server/dist/index.js"]
    }
  }
}
```

See [docs/DECISIONS.md](docs/DECISIONS.md) § “Later: OpenClaw MCP inclusion”.
## MCP tools (`x_*` — avoids clash with `a2a_*` remote tools)

| Tool | Purpose |
|------|---------|
| `x_health` | Adapter + projector status |
| `x_list_sessions` | Multi-provider session list |
| `x_get_session` | Metadata + resume hint |
| `x_get_messages` | Paginated transcript |
| `x_search` | Cross-tool text search |
| `x_query_events` | Proxy Event Log v2 inbox |
| `x_project_session_event` | Optional lifecycle write (default off) |

## Repository layout

```
a2a-event-x/
├── packages/
│   ├── event-log/       # Python — merged a2a-toolkit / PROJ-012 snapshot
│   ├── session-hub/     # TypeScript — adapters + hub
│   ├── mcp-server/      # TypeScript — MCP stdio
│   └── cli/             # TypeScript — a2ax
├── docs/
│   ├── DECISIONS.md
│   └── heritage/        # prior specs & design
└── skills/session-hub/  # OpenClaw / agent skill
```

### Event Log import status

`packages/event-log` currently contains the **2026-07-07 p0-fix snapshot** (v2 store, bridge, watchdog, schema, registry).

**Missing (must re-import from production Mac Mini):**

- `a2a-log.py` — v1 **canonical write path** (referenced as `~/.openclaw/scripts/a2a-log.py`)

Live DB paths (not in git): `~/.openclaw/workspace/state/a2a-log/`

## Security

- Session adapters are **read-only** on vendor stores.
- Projector defaults **off**; never auto-writes Event Log in v0.1.
- Do not commit tokens, production SQLite, or JSONL.

## License

MIT (Session Hub / monorepo scaffolding). Heritage Event Log components retain their original project terms where noted.
