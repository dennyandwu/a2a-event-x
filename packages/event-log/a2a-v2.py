#!/usr/bin/env python3
"""
a2a-v2 — Event Log v2 消费 CLI(P2 实验:租约 + fencing)
=========================================================
pull-first 消费契约(方案 4.3):
  inbox --agent X [--claim] [--lease-s N] [--limit N]
  ack   --token T
  done  --token T [--summary S]     (经 v1 CLI 提交 canonical task.done,单一写路径)
  renew --token T [--extend-s N]
  cancel --token T [--reason R]
规则:claim 颁发一次性 claim_token(fencing);lease 过期自动回滚 pending 且 attempt+1;
attempt≥3 → dead + dead_letters;过期 token 的任何操作被拒(409)。
注意:v2 CLI 仅操作 deliveries 视图;canonical 真相仍是 JSONL(经 a2a-log.py)。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import a2a_v2_store as store

# Prefer monorepo toolkit path; fall back to legacy live path / env override
_A2A_DIR = os.path.dirname(os.path.abspath(__file__))
A2A_V1 = os.environ.get(
    "A2A_LOG_CLI",
    next(
        (
            p
            for p in (
                os.path.join(_A2A_DIR, "scripts", "a2a-log.py"),
                os.path.expanduser("~/.openclaw/scripts/a2a-log.py"),
            )
            if os.path.isfile(p)
        ),
        os.path.join(_A2A_DIR, "scripts", "a2a-log.py"),
    ),
)
MAX_ATTEMPTS = 3


def now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _release_expired(c, agent=None):
    """租约过期 → 回滚 pending,attempt+1;attempt≥MAX → dead + 死信。"""
    q = "SELECT delivery_id, source_file, seq, to_agent, attempt_count FROM deliveries WHERE status='claimed' AND lease_expires_at < ?"
    args = [iso(now())]
    if agent:
        q += " AND to_agent=?"
        args.append(agent)
    for did, src, seq, to_agent, att in c.execute(q, args).fetchall():
        if att + 1 >= MAX_ATTEMPTS:
            c.execute("UPDATE deliveries SET status='dead', attempt_count=attempt_count+1, claim_token=NULL, updated_at=? WHERE delivery_id=?", (iso(now()), did))
            c.execute("INSERT INTO dead_letters (source_file, seq, to_agent, reason, detail) VALUES (?,?,?,?,?)",
                      (src, seq, to_agent, "lease_expired_max_attempts", f"attempts={att+1}"))
        else:
            c.execute("UPDATE deliveries SET status='pending', attempt_count=attempt_count+1, claim_token=NULL, lease_expires_at=NULL, updated_at=? WHERE delivery_id=?", (iso(now()), did))


def _by_token(c, token):
    row = c.execute(
        "SELECT delivery_id, source_file, seq, to_agent, status, lease_expires_at FROM deliveries WHERE claim_token=?",
        (token,)).fetchone()
    if row is None:
        print(json.dumps({"error": "invalid_or_expired_token", "code": 409}))
        sys.exit(1)
    did, src, seq, to_agent, status, lease = row
    if status not in ("claimed", "acked") or (lease and lease < iso(now())):
        print(json.dumps({"error": "token_not_active", "status": status, "code": 409}))
        sys.exit(1)
    return did, src, seq, to_agent, status


def cmd_inbox(a):
    c = store.connect()
    _release_expired(c, a.agent)
    c.commit()
    rows = c.execute(
        """SELECT d.delivery_id, d.source_file, d.seq, d.status, d.attempt_count,
                  e.ts, e.from_agent, e.type, e.topic, e.payload
           FROM deliveries d LEFT JOIN events e
             ON e.source_file=d.source_file AND e.seq=d.seq
           WHERE d.to_agent=? AND d.status='pending'
           ORDER BY d.seq LIMIT ?""",
        (a.agent, a.limit)).fetchall()
    out = []
    for did, src, seq, status, att, ts, frm, etype, topic, payload in rows:
        item = {"source_file": src, "seq": seq, "ts": ts, "from": frm, "type": etype,
                "topic": topic, "attempt_count": att,
                "payload": json.loads(payload) if payload else None}
        if a.claim:
            token = uuid.uuid4().hex
            lease = iso(now() + timedelta(seconds=a.lease_s))
            c.execute("UPDATE deliveries SET status='claimed', claim_token=?, lease_expires_at=?, updated_at=? WHERE delivery_id=? AND status='pending'",
                      (token, lease, iso(now()), did))
            item.update({"claim_token": token, "lease_expires_at": lease})
        out.append(item)
    c.commit()
    total = c.execute("SELECT COUNT(*) FROM deliveries WHERE to_agent=? AND status='pending'", (a.agent,)).fetchone()[0]
    print(json.dumps({"agent": a.agent, "claimed": bool(a.claim), "count_remaining_pending": total, "events": out}, ensure_ascii=False, indent=2))
    c.close()


def cmd_ack(a):
    c = store.connect()
    did, src, seq, to_agent, _ = _by_token(c, a.token)
    r = subprocess.run([sys.executable, A2A_V1, "ack", "--agent", to_agent, "--seq", str(seq), "--file", src],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        print(json.dumps({"error": "v1_ack_failed", "detail": (r.stderr or r.stdout)[:300]}))
        sys.exit(1)
    c.execute("UPDATE deliveries SET status='acked', updated_at=? WHERE delivery_id=?", (iso(now()), did))
    c.commit(); c.close()
    print(json.dumps({"status": "acked", "source_file": src, "seq": seq, "agent": to_agent}))


def cmd_done(a):
    c = store.connect()
    did, src, seq, to_agent, _ = _by_token(c, a.token)
    cmd = [sys.executable, A2A_V1, "done", "--agent", to_agent, "--seq", str(seq), "--file", src]
    if a.summary:
        cmd += ["--summary", a.summary]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        print(json.dumps({"error": "v1_done_failed_or_closeout_gate", "detail": (r.stdout or r.stderr)[:400]}))
        sys.exit(1)
    c.execute("UPDATE deliveries SET status='done', claim_token=NULL, updated_at=? WHERE delivery_id=?", (iso(now()), did))
    c.commit(); c.close()
    print(json.dumps({"status": "done", "source_file": src, "seq": seq, "agent": to_agent, "v1": json.loads(r.stdout or "{}")}))


def cmd_renew(a):
    c = store.connect()
    did, *_ = _by_token(c, a.token)
    lease = iso(now() + timedelta(seconds=a.extend_s))
    c.execute("UPDATE deliveries SET lease_expires_at=?, updated_at=? WHERE delivery_id=?", (lease, iso(now()), did))
    c.commit(); c.close()
    print(json.dumps({"status": "renewed", "lease_expires_at": lease}))


def cmd_cancel(a):
    c = store.connect()
    did, src, seq, to_agent, _ = _by_token(c, a.token)
    cmd = [sys.executable, A2A_V1, "cancelled", "--agent", to_agent, "--seq", str(seq), "--file", src]
    if a.reason:
        cmd += ["--reason", a.reason]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        print(json.dumps({"error": "v1_cancel_failed", "detail": (r.stderr or r.stdout)[:300]}))
        sys.exit(1)
    c.execute("UPDATE deliveries SET status='cancelled', claim_token=NULL, updated_at=? WHERE delivery_id=?", (iso(now()), did))
    c.commit(); c.close()
    print(json.dumps({"status": "cancelled", "source_file": src, "seq": seq}))


def main():
    ap = argparse.ArgumentParser(description="A2A Event Log v2 消费 CLI(租约+fencing;canonical 写仍经 v1)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("inbox"); p.add_argument("--agent", required=True); p.add_argument("--claim", action="store_true")
    p.add_argument("--lease-s", dest="lease_s", type=int, default=3600); p.add_argument("--limit", type=int, default=10)
    p.set_defaults(fn=cmd_inbox)
    p = sub.add_parser("ack"); p.add_argument("--token", required=True); p.set_defaults(fn=cmd_ack)
    p = sub.add_parser("done"); p.add_argument("--token", required=True); p.add_argument("--summary", default=None); p.set_defaults(fn=cmd_done)
    p = sub.add_parser("renew"); p.add_argument("--token", required=True); p.add_argument("--extend-s", dest="extend_s", type=int, default=3600); p.set_defaults(fn=cmd_renew)
    p = sub.add_parser("cancel"); p.add_argument("--token", required=True); p.add_argument("--reason", default=None); p.set_defaults(fn=cmd_cancel)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
