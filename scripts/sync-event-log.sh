#!/usr/bin/env bash
# Sync production Event Log (JSONL + sqlite) to local A2A_LOG_HOME.
# Default remote: macmini-ts:~/.openclaw/workspace/state/a2a-log/
set -euo pipefail

REMOTE="${A2AX_SYNC_REMOTE:-macmini-ts:~/.openclaw/workspace/state/a2a-log/}"
DEST="${A2A_LOG_HOME:-$HOME/.openclaw/workspace/state/a2a-log}"
DEST="${DEST%/}/"

mkdir -p "$DEST"
echo "rsync $REMOTE → $DEST"
rsync -az --progress \
  --exclude '*.jsonl.lock' \
  --exclude 'deploy.lock' \
  --exclude 'mailbox-shadow' \
  --exclude 'bridge-security.sqlite' \
  "$REMOTE" "$DEST"

echo "---"
if [[ -d "${DEST}events" ]]; then
  echo "jsonl files: $(ls -1 "${DEST}events"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')"
fi
DB="${A2A_V2_DB:-${DEST}db/a2a-v2.sqlite}"
if [[ -f "$DB" ]]; then
  ls -lh "$DB"
  sqlite3 "$DB" "SELECT 'events', COUNT(*) FROM events; SELECT 'deliveries', COUNT(*) FROM deliveries; SELECT status, COUNT(*) FROM deliveries GROUP BY status ORDER BY 2 DESC LIMIT 8;" 2>/dev/null || true
fi

# record sync freshness for Event X status UI
STATE="${DEST}.a2ax-sync-state.json"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DB_SIZE=0
DB_MTIME=0
if [[ -f "$DB" ]]; then
  DB_SIZE=$(stat -f%z "$DB" 2>/dev/null || stat -c%s "$DB" 2>/dev/null || echo 0)
  DB_MTIME=$(stat -f%m "$DB" 2>/dev/null || stat -c%Y "$DB" 2>/dev/null || echo 0)
  DB_MTIME=$((DB_MTIME * 1000))
fi
JSONL_N=$(ls -1 "${DEST}events"/*.jsonl 2>/dev/null | wc -l | tr -d ' ' || echo 0)
export A2AX_SYNC_STATE_PATH="$STATE"
export A2AX_SYNC_NOW="$NOW"
export A2AX_SYNC_REMOTE_REC="$REMOTE"
export A2AX_SYNC_DB_SIZE="$DB_SIZE"
export A2AX_SYNC_DB_MTIME="$DB_MTIME"
export A2AX_SYNC_JSONL_N="$JSONL_N"
python3 - <<'PY'
import json, os
p = os.environ["A2AX_SYNC_STATE_PATH"]
payload = {
    "last_sync_at": os.environ["A2AX_SYNC_NOW"],
    "remote": os.environ["A2AX_SYNC_REMOTE_REC"],
    "ok": True,
    "db_size": int(os.environ.get("A2AX_SYNC_DB_SIZE") or 0),
    "db_mtime_ms": int(os.environ.get("A2AX_SYNC_DB_MTIME") or 0),
    "jsonl_count": int(os.environ.get("A2AX_SYNC_JSONL_N") or 0),
}
with open(p, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
print("wrote", p)
PY

echo "Done. Restart Event X if it was already running."
echo "Laptop: live data defaults to READONLY unless A2AX_AUTHORITY=1"
echo "  npm run web                    # auto-readonly on live mirror"
echo "  A2AX_AUTHORITY=1 npm run web   # write (Mac Mini)"
