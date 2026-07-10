# Locked decisions (2026-07-11)

## Product stance

**A2A Event X is a standalone product.**  
It must be useful with zero OpenClaw install. OpenClaw (and other agents) are optional *clients* that may call it later via MCP/CLI.

### Delivery order

| Phase | Focus | OpenClaw? |
|-------|--------|-----------|
| **Now** | Ship standalone module: CLI `a2ax` + Session Hub + Event Log package + stdio MCP binary | Not required |
| **Later** | Thin OpenClaw wiring: `mcpServers` entry and/or optional skill | Optional client only |

Do **not** block standalone UX on OpenClaw gateway, plugins, or A2A transport (gateway/plugin stay separate products).

---

## Technical locks

1. **Repo**: independent `a2a-event-x` monorepo; **merges** existing a2a-toolkit / Event Log into `packages/event-log`.
2. **Stack**:
   - **Python 3.9+** for Event Log (existing code + contracts)
   - **TypeScript (Node 20+)** for Session Hub + MCP (`@modelcontextprotocol/sdk`)
   - **CLI `a2ax`**: TS dispatcher → session commands in-process; `a2ax log …` → Python subprocess
3. **Adapters (Phase 1)**: Claude Code · Codex · OpenClaw · Grok Build · Antigravity CLI  
   - “OpenClaw” here means *reading local OpenClaw session stores*, not depending on the gateway process.
4. **Projector (clarified)**:
   - Session Hub **reads** vendor session stores.
   - Event Log **owns** cross-agent task delivery (claim/lease/done).
   - **Projector** = optional bridge that writes session lifecycle pointers *into* Event Log so other agents can pull them.
   - **v0.1: interface + flag, default OFF.**
5. **Names**: package/repo `a2a-event-x`, CLI `a2ax`, MCP tools `x_*`.
6. **MCP is a product surface, not an OpenClaw feature**:
   - Primary consumers today: human + `a2ax` CLI + any MCP host (Claude Desktop, Cursor, etc.).
   - OpenClaw `mcpServers` config is a *later integration recipe*, not a runtime dependency.

---

## Later: OpenClaw MCP inclusion (non-blocking)

When standalone is solid, inclusion means **configuration only** (preferred):

```json
{
  "mcpServers": {
    "a2a-event-x": {
      "command": "node",
      "args": ["/path/to/a2a-event-x/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Optional thin packaging (only if install friction is high):

- npm bin `a2ax-mcp` on PATH
- OpenClaw skill `skills/session-hub` (already scaffolded)
- **Not** a heavy `openclaw.plugin.json` that owns ports/state

Anti-goals for “inclusion”:

- No embedding Event X state inside OpenClaw’s session store
- No forking openclaw-a2a-gateway / openclaw-a2a-plugin into this repo
- No requiring gateway restart for Session Hub to work
