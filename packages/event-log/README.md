# packages/event-log

**A2A Event Log** — merged from the production toolkit.

## Upstream (source of truth)

| Source | URL | What it is |
|--------|-----|------------|
| **a2a-toolkit** | https://github.com/dennyandwu/a2a-toolkit | urDAO A2A Toolkit — Event Log + Hook-C + Pipeline Executor (private) |
| p0-fix snapshot | local PROJ-012 hardening | v2 store / bridge / watchdog / schema (2026-07) |

### Toolkit layout (imported)

```
scripts/
├── a2a-log.py           # Event Log CLI + Hook-C (canonical write path)
├── a2a-send.sh / .py    # standard send entry
├── a2a_routing.py
├── pipeline-executor.py
├── pipeline_utils.py
├── a2a-projector.py
├── a2a-monitor.py
└── a2a-log-escalate.py
```

Upstream README: [docs-upstream/a2a-toolkit-README.md](docs-upstream/a2a-toolkit-README.md)

### v2 / bridge (p0-fix layer)

- `a2a-v2.py`, `a2a_v2_store.py` — claim / lease consumer CLI  
- `bridge_v2.py` — HTTP bridge  
- `a2a-event-v2.schema.json`, `registry-agents.json`, `topics.json`  
- patches / verify / backfill helpers  

## Runtime data (not in git)

- Live state historically under `~/.openclaw/workspace/state/a2a-log/`
- Tokens / secrets never committed

## CLI

```bash
# Canonical write (toolkit)
python3 packages/event-log/scripts/a2a-log.py --help

# v2 inbox / claim
python3 packages/event-log/a2a-v2.py inbox --agent issac
```

Via product server (B/S): open Event Log tab → inbox API proxies `a2a-v2.py`.
