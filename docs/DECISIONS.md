# Locked decisions (2026-07-11)

1. **Repo**: independent `a2a-event-x` monorepo; **merges** existing a2a-toolkit / Event Log into `packages/event-log`.
2. **Stack**:
   - **Python 3.9+** for Event Log (existing code + contracts)
   - **TypeScript (Node 20+)** for Session Hub + MCP (`@modelcontextprotocol/sdk`)
   - **CLI `a2ax`**: TS dispatcher → session commands in-process; `a2ax log …` → Python subprocess
3. **Adapters (Phase 1)**: Claude Code · Codex · OpenClaw · Grok Build · Antigravity CLI
4. **Projector (clarified)**:
   - Session Hub **reads** vendor session stores.
   - Event Log **owns** cross-agent task delivery (claim/lease/done).
   - **Projector** = optional bridge that writes session lifecycle pointers *into* Event Log so other agents can pull them.
   - **v0.1: implemented as interface + CLI flag, default OFF.** No automatic writes until Session Hub is solid and `a2a-log.py` is re-imported.
5. **Names**: package/repo `a2a-event-x`, CLI `a2ax`, MCP tools `x_*`.
