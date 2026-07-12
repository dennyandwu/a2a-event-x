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
echo "Done. Restart Event X if it was already running."
echo "Laptop mirror tip: A2AX_READONLY=1 npm run web   # or: npm run web:ro"
echo "Authority (Mac Mini): unset A2AX_READONLY before claim/done."
