# Importing the full a2a-toolkit / a2a-log.py

This directory was seeded from the **p0-fix** snapshot (2026-07-07).

Production still expects:

```text
~/.openclaw/scripts/a2a-log.py   # v1 canonical writer (JSONL dual-write entry)
```

## Re-import checklist (Mac Mini)

```bash
# on the machine that still has live toolkit
PROD_SCRIPTS=~/.openclaw/scripts
PROD_STATE=~/.openclaw/workspace/state/a2a-log

# into this monorepo
cp -n "$PROD_SCRIPTS/a2a-log.py" packages/event-log/
# optional companions if present
for f in a2a_v2_store.py protocol-guard.py; do
  [ -f "$PROD_SCRIPTS/$f" ] && cp -n "$PROD_SCRIPTS/$f" packages/event-log/
done
```

Do **not** copy production `*.sqlite` or token files into git.

After import, update `a2a-v2.py` default `A2A_V1` to:

```python
A2A_V1 = os.environ.get(
    "A2A_LOG_CLI",
    os.path.join(os.path.dirname(__file__), "a2a-log.py"),
)
```
