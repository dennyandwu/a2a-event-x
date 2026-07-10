#!/usr/bin/env python3
"""P1 backfill:把现有 JSONL 全量导入 v2 SQLite,并按 watermark 标记 historical。
两遍扫描:pass1 插入全部事件 + dispatch deliveries;pass2 按 ts 序应用 resolution;
pass3 watermark 之下的 pending → historical。幂等可重跑。"""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a2a_v2_store as store

BASE = store.BASE_DIR
EVENTS = os.path.join(BASE, "events")
WATERMARKS = os.path.join(BASE, "watermarks")


def iter_events(fp):
    src = os.path.basename(fp)[:-6]
    with open(fp, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield src, json.loads(line)
            except json.JSONDecodeError:
                continue


def main():
    c = store.connect()
    files = sorted(glob.glob(os.path.join(EVENTS, "*.jsonl")))
    n_ev = 0
    resolutions = []
    # pass1: events + dispatch deliveries
    for fp in files:
        for src, ev in iter_events(fp):
            et = ev.get("type")
            if et in store.RESOLUTION_STATUS:
                resolutions.append((ev.get("ts") or "", src, ev))
                # 仍需插入事件本体
                p, r = ev.get("payload"), ev.get("routing")
                c.execute(
                    """INSERT OR IGNORE INTO events
                       (source_file, seq, ts, from_agent, type, topic, event_class, priority,
                        correlation_id, causation_id, idempotency_key, payload, routing, raw)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (src, ev.get("seq"), ev.get("ts"), ev.get("from"), et,
                     ev.get("topic"), ev.get("event_class"), ev.get("priority"),
                     ev.get("correlation_id"), ev.get("causation_id"),
                     (ev.get("meta") or {}).get("idempotency_key"),
                     json.dumps(p, ensure_ascii=False) if p is not None else None,
                     json.dumps(r, ensure_ascii=False) if r is not None else None,
                     json.dumps(ev, ensure_ascii=False)))
            else:
                store.apply_event(c, src, ev)
            n_ev += 1
            if n_ev % 5000 == 0:
                c.commit()
                print(f"  ... {n_ev} events", flush=True)
    c.commit()
    # pass2: resolutions in ts order
    resolutions.sort(key=lambda x: x[0])
    for _, src, ev in resolutions:
        store.apply_event(c, src, ev)
    c.commit()
    # pass3: watermark → historical
    n_hist = 0
    for wf in glob.glob(os.path.join(WATERMARKS, "*.json")):
        agent = os.path.basename(wf)[:-5]
        try:
            wm = json.load(open(wf)).get("watermarks", {})
        except Exception:
            continue
        for src, max_seq in wm.items():
            cur = c.execute(
                "UPDATE deliveries SET status='historical', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
                "WHERE to_agent=? AND source_file=? AND seq<=? AND status='pending'",
                (agent, src, int(max_seq)))
            n_hist += cur.rowcount
    c.commit()
    ne = c.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    nd = c.execute("SELECT COUNT(*) FROM deliveries").fetchone()[0]
    byst = dict(c.execute("SELECT status, COUNT(*) FROM deliveries GROUP BY status").fetchall())
    print(json.dumps({"scanned": n_ev, "db_events": ne, "db_deliveries": nd,
                      "historical_marked": n_hist, "by_status": byst}, ensure_ascii=False))
    c.close()


if __name__ == "__main__":
    main()
