---
name: session-hub
description: Use A2A Event X MCP tools to list and search local Claude/Codex/OpenClaw/Grok/Antigravity sessions without leaving the agent.
---

# Session Hub (A2A Event X)

When the user asks about **other CLI sessions**, **what Codex/Claude was doing**, or **local chat history across tools**, use the **a2a-event-x** MCP tools:

1. `x_health` — see which providers are available on this machine
2. `x_list_sessions` — list sessions (`provider`, `project`, `limit`)
3. `x_get_messages` — read a session transcript (paginated)
4. `x_search` — full-text search across tools
5. `x_query_events` — pull A2A Event Log inbox for an agent (task bus, not transcripts)

## Do not confuse

| Tool prefix | Meaning |
|-------------|---------|
| `x_*` | Local Session Hub + Event Log **query** (this skill) |
| `a2a_*` | Remote Agent-to-Agent protocol (openclaw-a2a-plugin / gateway) |

## Rules

- Prefer read tools first; do not enable projector writes unless the user asks.
- Summarize transcripts; do not dump huge raw JSON into the user channel.
- Resume hints are suggestions (`claude --resume …`); confirm before running destructive shell.
