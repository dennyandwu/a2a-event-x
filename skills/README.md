# Skills (agent-facing)

This project **does not ship MCP**. Agents learn surfaces via skills + CLI.

| Skill | Audience | Purpose |
|-------|----------|---------|
| [`a2a-consumer`](./a2a-consumer/SKILL.md) | **All bus agents** | inbox → claim → ack/done on Event Log |
| [`session-hub`](./session-hub/SKILL.md) | Coding assistants | Local CLI session history (context only) |

## Install into an agent workspace

Copy or symlink into the agent’s skill directory, e.g.:

```bash
# Claude Code project / user skills (paths vary by setup)
ln -sf /path/to/a2a-event-x/skills/a2a-consumer ~/.claude/skills/a2a-consumer

# Or paste SKILL.md content into agent MEMORY / AGENTS.md with a short pointer
```

OpenClaw agents: add a short pointer in agent instructions to run the consumer loop with their `agent_id`.
