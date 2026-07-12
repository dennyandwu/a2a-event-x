#!/usr/bin/env bash
set -euo pipefail
BASE="${A2AX_URL:-http://127.0.0.1:8787}"
echo "smoke $BASE"
H=$(curl -sf "$BASE/api/health")
echo "$H" | python3 -c "import sys,json;d=json.load(sys.stdin); assert d.get('ok') is not False; print('health ok', d.get('version'), d.get('dataMode') or d.get('eventLog',{}).get('sqlite',{}))"
B=$(curl -sf "$BASE/api/agents/board")
echo "$B" | python3 -c "import sys,json;d=json.load(sys.stdin); t=d.get('totals')or{}; print('board totals', t); print('agents', len(d.get('agents')or[]))"
I=$(curl -sf "$BASE/api/interactions?limit=5")
echo "$I" | python3 -c "import sys,json;d=json.load(sys.stdin); print('workflows', d.get('summary') or len(d.get('correlations')or[]))"
echo "smoke passed"
