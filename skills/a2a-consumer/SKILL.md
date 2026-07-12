---
name: a2a-consumer
description: Consume and complete multi-agent tasks via A2A Event Log CLI (inbox/claim/ack/done). Use when acting as an agent on the Event Log bus, handling pending deliveries, or coordinating handoffs — not for human console UI.
---

# A2A Event Log — Agent Consumer

You are a **participant** on the multi-agent Event Log bus.  
**Humans** use the B/S console (A2A Event X at `http://127.0.0.1:8787/`).  
**You** use **CLI only** — never invent MCP tools; this project has no MCP surface.

## Environment

```bash
export A2A_LOG_HOME="${A2A_LOG_HOME:-$HOME/.openclaw/workspace/state/a2a-log}"
# monorepo paths (adjust if installed elsewhere)
V2="packages/event-log/a2a-v2.py"
V1="packages/event-log/scripts/a2a-log.py"
```

Know **your `agent_id`** (e.g. `issac`, `ansen`, `satoshi2`). Only claim/work deliveries addressed to you.

## Preferred loop (v2 lease)

```bash
# 1) Read inbox (optional claim)
python3 "$V2" inbox --agent YOUR_ID --claim --limit 5

# 2) Work the task (payload.summary / topic / correlation_id)

# 3) Optional progress hold
python3 "$V2" ack --token CLAIM_TOKEN

# 4) Complete (canonical done still goes through v1 path internally)
python3 "$V2" done --token CLAIM_TOKEN --summary "one-line outcome + artifact path if any"

# Stuck / wrong task
python3 "$V2" cancel --token CLAIM_TOKEN --reason "why"
# Renew lease if still working
python3 "$V2" renew --token CLAIM_TOKEN
```

### Rules

1. **Claim before long work** — unclaimed pending may be taken by others or expire differently.
2. **One token, one delivery** — do not reuse claim tokens.
3. **Always terminalize** — every claimed item ends in `done`, `cancel`, or you renew until done. Do not leave claimed forever.
4. **`done --summary` is required discipline** — state result + where memory/artifact landed if relevant.
5. **Preserve `correlation_id`** when writing follow-up events so humans see handoffs in Workflows.
6. **Do not rewrite JSONL by hand**; only `a2a-log.py` / `a2a-v2.py`.
7. **Do not use the B/S claim UI as your primary path** unless the human explicitly asks you to operate the console.

## v1 fallback (no lease)

If v2 is unavailable:

```bash
python3 "$V1" pending --agent YOUR_ID
python3 "$V1" read --agent YOUR_ID --limit 10
python3 "$V1" ack  --agent YOUR_ID --seq SEQ --file SOURCE
python3 "$V1" done --agent YOUR_ID --seq SEQ --file SOURCE --summary "..."
```

## Producing work for others

```bash
python3 "$V1" write --from YOUR_ID --to TARGET_ID \
  --type task.dispatch --topic SOME_TOPIC \
  --correlation-id "workflow-...." \
  --payload '{"summary":"..."}'
```

(Exact flags may vary — run `python3 "$V1" write -h`. Prefer matching existing topic/registry conventions.)

## Human console (for the user, not you)

- Board / handoffs / batch ops: **A2A Event X** → Agents · Workflows  
- Sync prod log: `npm run sync:log` or System → Write Path  
- You may **tell the human** to open the console for multi-agent triage; you still finish your own deliveries via CLI.

## Do not confuse

| Thing | Role |
|-------|------|
| Event Log CLI | **Your** bus |
| A2A Event X B/S | **Human** command console |
| Session Hub / `a2ax list` | Local coding CLI history (context only) |
| Google A2A / openclaw-a2a-plugin | Different protocol stacks — out of scope here |

## Failure modes

| Symptom | Action |
|---------|--------|
| `invalid_or_expired_token` | Re-`inbox --claim`; previous lease lost |
| Lease expiring mid-work | `renew` or finish faster; then `done` |
| Dead letter | Human requeue/compensate in console or ops CLI; do not silently drop |
| Empty inbox | Idle or wrong `agent_id` / `A2A_LOG_HOME` |
