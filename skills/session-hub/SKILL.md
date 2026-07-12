---
name: session-hub
description: List and search local Claude/Codex/OpenClaw/Grok/Antigravity coding sessions via a2ax CLI or Event X Sessions UI. Context only — not the multi-agent task bus.
---

# Session Hub (context only)

Use when the user asks about **local coding CLI history** (what Claude/Codex did), not about **agent task handoffs**.

## Preferred

1. Human UI: open **A2A Event X** → **Sessions** (`http://127.0.0.1:8787/`)
2. CLI:
   ```bash
   a2ax health
   a2ax list --provider claude-code --limit 20
   a2ax messages <session_id> --limit 50
   a2ax search "keyword"
   ```

## Multi-agent tasks

For pending/claim/done on the Event Log bus, use **`a2a-consumer`** skill and `a2a-v2.py` / `a2a-log.py` — **not** Session Hub.

## Rules

- Sessions are **context**, not the product mainline.
- Prefer summarize transcripts; avoid dumping huge JSON to the user.
- Resume commands (`claude --resume …`) are suggestions; confirm before destructive shell.
