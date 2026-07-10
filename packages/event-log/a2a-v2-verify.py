#!/usr/bin/env python3
"""P1 一致性校验:JSONL(canonical) vs v2 SQLite。输出 JSON;diff 非零时退出码 1。"""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a2a_v2_store as store

EVENTS = os.path.join(store.BASE_DIR, "events")


def jsonl_stats(fp):
    n, mx = 0, -1
    with open(fp, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            n += 1
            try:
                q = json.loads(line).get("seq")
                if isinstance(q, int) and q > mx:
                    mx = q
            except json.JSONDecodeError:
                pass
    return n, mx


def main():
    c = store.connect()
    report, diffs = {}, 0
    for fp in sorted(glob.glob(os.path.join(EVENTS, "*.jsonl"))):
        src = os.path.basename(fp)[:-6]
        jn, jmax = jsonl_stats(fp)
        row = c.execute("SELECT COUNT(*), COALESCE(MAX(seq),-1) FROM events WHERE source_file=?", (src,)).fetchone()
        dn, dmax = row
        ok = (jn == dn and jmax == dmax)
        if not ok:
            diffs += 1
        report[src] = {"jsonl": {"count": jn, "max_seq": jmax}, "db": {"count": dn, "max_seq": dmax}, "ok": ok}
    pend = dict(c.execute("SELECT to_agent, COUNT(*) FROM deliveries WHERE status='pending' GROUP BY to_agent").fetchall())
    print(json.dumps({"files": report, "diff_files": diffs, "db_pending_by_agent": pend}, ensure_ascii=False, indent=1))
    c.close()
    sys.exit(1 if diffs else 0)


if __name__ == "__main__":
    main()
