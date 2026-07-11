#!/usr/bin/env python3
"""
Seed realistic multi-agent demo data into a2a-v2.sqlite for Event X console trial.

Does NOT touch production JSONL by default (sqlite only), so it's safe for UI demos.
Idempotent: rows use source_file='demo' and can be wiped with --reset.

  python3 packages/event-log/scripts/seed-demo.py
  python3 packages/event-log/scripts/seed-demo.py --reset
  A2A_V2_DB=/path/to/db python3 .../seed-demo.py
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser(
    os.environ.get("A2A_LOG_HOME", "~/.openclaw/workspace/state/a2a-log")
)
DB = os.environ.get("A2A_V2_DB", os.path.join(HOME, "db", "a2a-v2.sqlite"))
SOURCE = "demo"


def now(offset_min: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=offset_min)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    c = sqlite3.connect(DB)
    c.execute("PRAGMA journal_mode=WAL")
    # ensure base tables (match a2a_v2_store)
    c.executescript(
        """
CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  from_agent TEXT,
  type TEXT NOT NULL,
  topic TEXT,
  event_class TEXT,
  priority TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  idempotency_key TEXT,
  payload TEXT,
  routing TEXT,
  raw TEXT NOT NULL,
  inserted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_file, seq)
);
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  seq INTEGER NOT NULL,
  to_agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  claim_token TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_file, seq, to_agent)
);
"""
    )
    return c


def reset_demo(c: sqlite3.Connection) -> int:
    c.execute("DELETE FROM deliveries WHERE source_file=?", (SOURCE,))
    c.execute("DELETE FROM events WHERE source_file=?", (SOURCE,))
    # also remove legacy single test row so board isn't stuck on one synthetic item
    c.execute("DELETE FROM deliveries WHERE source_file='test'")
    c.execute("DELETE FROM events WHERE source_file='test'")
    return c.total_changes


def insert_event(
    c: sqlite3.Connection,
    *,
    seq: int,
    ts: str,
    from_agent: str,
    to_agents: list[str],
    etype: str,
    topic: str,
    corr: str,
    summary: str,
    priority: str = "P2",
    causation: str | None = None,
    deliveries: list[tuple[str, str, int, str | None]] | None = None,
    # deliveries: (to_agent, status, attempt_count, claim_token|None)
) -> None:
    payload = {"summary": summary}
    routing = {"prev": "none", "next": "END", "origin_surface": "demo"}
    raw = {
        "specversion": "1.1",
        "seq": seq,
        "ts": ts,
        "from": from_agent,
        "to": to_agents,
        "topic": topic,
        "type": etype,
        "event_class": "business",
        "priority": priority,
        "correlation_id": corr,
        "causation_id": causation,
        "routing": routing,
        "meta": {"idempotency_key": f"demo:{corr}:{seq}", "demo": True},
        "payload": payload,
    }
    c.execute(
        """INSERT OR REPLACE INTO events
           (source_file, seq, ts, from_agent, type, topic, event_class, priority,
            correlation_id, causation_id, idempotency_key, payload, routing, raw)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            SOURCE,
            seq,
            ts,
            from_agent,
            etype,
            topic,
            "business",
            priority,
            corr,
            causation,
            f"demo:{corr}:{seq}",
            json.dumps(payload, ensure_ascii=False),
            json.dumps(routing, ensure_ascii=False),
            json.dumps(raw, ensure_ascii=False),
        ),
    )
    if deliveries is None:
        deliveries = [(a, "pending", 0, None) for a in to_agents]
    for to_agent, status, attempts, token in deliveries:
        lease = None
        if status in ("claimed", "acked") and token:
            lease = now(60)
        c.execute(
            """INSERT OR REPLACE INTO deliveries
               (source_file, seq, to_agent, status, claim_token, lease_expires_at,
                attempt_count, updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                SOURCE,
                seq,
                to_agent,
                status,
                token,
                lease,
                attempts,
                ts,
            ),
        )


def seed(c: sqlite3.Connection) -> dict:
    # Realistic multi-agent interaction scenarios
    scenarios = []

    # 1) Email pipeline: automation → issac + ansen
    corr = "workflow-email-daily-20260712"
    insert_event(
        c,
        seq=101,
        ts=now(-120),
        from_agent="automation-runner",
        to_agents=["issac", "ansen"],
        etype="task.dispatch",
        topic="sop-email-check",
        corr=corr,
        summary="日检：汇总未读邮件并起草摘要",
        priority="P1",
        deliveries=[
            ("issac", "pending", 0, None),
            ("ansen", "claimed", 1, uuid.uuid4().hex),
        ],
    )
    insert_event(
        c,
        seq=102,
        ts=now(-90),
        from_agent="ansen",
        to_agents=["issac"],
        etype="task.acked",
        topic="sop-email-check",
        corr=corr,
        summary="ansen 已接手邮件日检",
        causation="seq:demo:101",
        deliveries=[("issac", "pending", 0, None)],
    )
    scenarios.append(corr)

    # 2) Deploy gate: satoshi2 implements, elon2 reviews, wiki docs
    corr = "workflow-deploy-g1-cutover"
    insert_event(
        c,
        seq=201,
        ts=now(-200),
        from_agent="issac",
        to_agents=["satoshi2", "elon2", "wiki"],
        etype="task.dispatch",
        topic="ops-deploy-gate",
        corr=corr,
        summary="G1 双写可信切读：补齐 verify 与回滚文档",
        priority="P0",
        deliveries=[
            ("satoshi2", "claimed", 1, uuid.uuid4().hex),
            ("elon2", "pending", 0, None),
            ("wiki", "acked", 1, uuid.uuid4().hex),
        ],
    )
    insert_event(
        c,
        seq=202,
        ts=now(-30),
        from_agent="satoshi2",
        to_agents=["elon2"],
        etype="result.partial",
        topic="ops-deploy-gate",
        corr=corr,
        summary="实现完成，等待 elon2 review",
        causation="seq:demo:201",
        deliveries=[("elon2", "pending", 0, None)],
    )
    scenarios.append(corr)

    # 3) Ops alert stuck / dead-letter path
    corr = "workflow-ops-alert-fd-leak"
    insert_event(
        c,
        seq=301,
        ts=now(-400),
        from_agent="cron",
        to_agents=["ansen", "issac"],
        etype="task.dispatch",
        topic="ops-auto-alert-fd",
        corr=corr,
        summary="gateway FD 占用过高，请排查 EBADF",
        priority="P0",
        deliveries=[
            ("ansen", "dead", 3, None),
            ("issac", "pending", 2, None),
        ],
    )
    scenarios.append(corr)

    # 4) Research handoff cowork → issac → satoshi2
    corr = "workflow-research-a2a-landscape"
    insert_event(
        c,
        seq=401,
        ts=now(-60),
        from_agent="cowork",
        to_agents=["issac"],
        etype="task.dispatch",
        topic="research-a2a",
        corr=corr,
        summary="整理非 OpenClaw 的 A2A/agent 互通开源清单",
        priority="P2",
        deliveries=[("issac", "claimed", 0, uuid.uuid4().hex)],
    )
    insert_event(
        c,
        seq=402,
        ts=now(-20),
        from_agent="issac",
        to_agents=["satoshi2"],
        etype="task.dispatch",
        topic="research-a2a",
        corr=corr,
        summary="请 satoshi2 补 hcom 与 a2a-utils 对照表",
        causation="seq:demo:401",
        deliveries=[("satoshi2", "pending", 0, None)],
    )
    scenarios.append(corr)

    # 5) completed workflow (shows done in totals)
    corr = "workflow-bridge-v2-smoke"
    insert_event(
        c,
        seq=501,
        ts=now(-500),
        from_agent="automation-runner",
        to_agents=["issac"],
        etype="task.dispatch",
        topic="bridge-smoke",
        corr=corr,
        summary="Bridge v2 smoke 已完成",
        deliveries=[("issac", "done", 1, None)],
    )
    scenarios.append(corr)

    c.commit()
    ev = c.execute(
        "SELECT COUNT(*) FROM events WHERE source_file=?", (SOURCE,)
    ).fetchone()[0]
    de = c.execute(
        "SELECT COUNT(*) FROM deliveries WHERE source_file=?", (SOURCE,)
    ).fetchone()[0]
    by = c.execute(
        """SELECT status, COUNT(*) FROM deliveries WHERE source_file=? GROUP BY status""",
        (SOURCE,),
    ).fetchall()
    return {
        "ok": True,
        "db": DB,
        "source_file": SOURCE,
        "events": ev,
        "deliveries": de,
        "by_status": {s: n for s, n in by},
        "workflows": scenarios,
        "note": "Demo data is sqlite-only (source_file=demo). Point A2A_LOG_HOME at production for real data.",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="Wipe demo rows only, then seed")
    ap.add_argument("--wipe-only", action="store_true", help="Wipe demo rows, do not reseed")
    args = ap.parse_args()
    c = connect()
    if args.reset or args.wipe_only:
        n = reset_demo(c)
        c.commit()
        if args.wipe_only:
            print(json.dumps({"ok": True, "wiped": n, "db": DB}, ensure_ascii=False, indent=2))
            return
    out = seed(c)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
