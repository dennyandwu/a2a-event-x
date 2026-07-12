#!/usr/bin/env bash
set -euo pipefail
BASE="${A2AX_URL:-http://127.0.0.1:8787}"
echo "smoke $BASE"
H=$(curl -sf "$BASE/api/health")
echo "$H" | python3 -c "import sys,json;d=json.load(sys.stdin); assert d.get('ok') is not False; print('health ok', d.get('version'), 'readonly', d.get('readonly'), d.get('dataMode') or '')"
B=$(curl -sf "$BASE/api/agents/board")
echo "$B" | python3 -c "import sys,json;d=json.load(sys.stdin); t=d.get('totals')or{}; print('board totals', t); print('agents', len(d.get('agents')or[]))"
I=$(curl -sf "$BASE/api/interactions?limit=5")
echo "$I" | python3 -c "import sys,json;d=json.load(sys.stdin); print('workflows', d.get('summary') or len(d.get('correlations')or[]))"
# readonly should reject claim
CODE=$(curl -s -o /tmp/a2ax-smoke-claim.json -w '%{http_code}' -X POST "$BASE/api/events/claim" \
  -H 'content-type: application/json' -d '{"agent":"issac","limit":1}' || true)
if [[ "${A2AX_EXPECT_READONLY:-}" == "1" ]]; then
  test "$CODE" = "403" || { echo "expected claim 403 in readonly, got $CODE"; cat /tmp/a2ax-smoke-claim.json; exit 1; }
  echo "readonly claim blocked (403) ok"
else
  echo "claim probe http $CODE (set A2AX_EXPECT_READONLY=1 to assert 403)"
fi
echo "smoke passed"
