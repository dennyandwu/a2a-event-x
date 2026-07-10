# packages/event-log

Merged from **a2a-toolkit / A2A Event Log (PROJ-012)** snapshot (`p0-fix`, 2026-07-07).

## Status of import

| Component | Present | Notes |
|-----------|---------|-------|
| `a2a-v2.py` + `a2a_v2_store.py` | yes | lease / claim consumer CLI |
| `bridge_v2.py` | yes | HTTP Bridge v2 |
| schema / registry / topics | yes | contract artifacts |
| `a2a-backlog-watchdog.py` | yes | backlog watchdog |
| contract tests / patches | yes | P0/P1 helpers |
| **`a2a-log.py` (v1 canonical write path)** | **missing** | Live path was `~/.openclaw/scripts/a2a-log.py` — not on this machine. **Must re-import from production Mac Mini before dual-write cutover work.** |

## Runtime data (not in git)

- SQLite / JSONL live under `~/.openclaw/workspace/state/a2a-log/`
- Do not commit production DB or tokens

## CLI entry (via monorepo)

```bash
# after install
a2ax log --help          # dispatches to packages/event-log
python3 packages/event-log/a2a-v2.py inbox --agent issac
```
