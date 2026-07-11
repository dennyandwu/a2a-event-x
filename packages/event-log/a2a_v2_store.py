#!/usr/bin/env python3
"""
a2a_v2_store — A2A Event Log v2 SQLite 存储层(P1:双写只写不读)
================================================================
被 a2a-log.py 的 _locked_append_event 以 best-effort 方式调用:
canonical 写入(JSONL)成功后,同步落一份到 SQLite。本层任何失败
都不得阻塞 canonical 写(调用方 try/except 包裹)。

数据模型(方案 4.1,评审确认版):
  events     — immutable 事件本体(不含 to/status)
  deliveries — 按收件人一行:status/lease/claim_token/attempt_count
  dead_letters — 死信
读路径切换(P2)前,本库仅作校验与 v2 CLI 试点用。
"""
from __future__ import annotations

import json
import os
import sqlite3

# Unified env (Event X B/S + toolkit share the same state root):
#   A2A_LOG_HOME  — state root (default ~/.openclaw/workspace/state/a2a-log)
#   A2A_V2_DB     — explicit sqlite path override
BASE_DIR = os.path.expanduser(
    os.environ.get("A2A_LOG_HOME", "~/.openclaw/workspace/state/a2a-log")
)
DB_PATH = os.environ.get(
    "A2A_V2_DB",
    os.path.join(BASE_DIR, "db", "a2a-v2.sqlite"),
)

RESOLUTION_STATUS = {
    "task.acked": "acked",
    "task.done": "done",
    "task.cancelled": "cancelled",
    "task.blocked": "blocked",
    "task.escalated": "escalated",
}
TERMINAL = {"done", "cancelled", "dead", "superseded", "historical"}
DELIVERY_TYPES = {"task.dispatch", "task.update", "task.retry"}

_SCHEMA = """
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
CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic);
CREATE INDEX IF NOT EXISTS idx_events_corr ON events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);

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
CREATE INDEX IF NOT EXISTS idx_deliv_agent_status ON deliveries(to_agent, status);

CREATE TABLE IF NOT EXISTS dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_file TEXT, seq INTEGER, to_agent TEXT,
  reason TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=5)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=5000")
    c.executescript(_SCHEMA)
    return c


def _ref_of(ev: dict):
    """解析 resolution 事件指向的原始 dispatch:(ref_from, ref_seq) 或 (None, None)。"""
    p = ev.get("payload") or {}
    rf, rs = p.get("ref_from"), p.get("ref_seq")
    if rf and rs is not None:
        try:
            return str(rf), int(rs)
        except (TypeError, ValueError):
            pass
    cid = ev.get("causation_id") or ""
    if cid.startswith("seq:"):
        parts = cid.split(":")
        if len(parts) == 3:
            try:
                return parts[1], int(parts[2])
            except ValueError:
                pass
    # escalation payload 变体
    if p.get("dispatch_from") and p.get("dispatch_seq") is not None:
        try:
            return str(p["dispatch_from"]), int(p["dispatch_seq"])
        except (TypeError, ValueError):
            pass
    return None, None


def apply_event(c: sqlite3.Connection, source_file: str, ev: dict) -> None:
    """插入事件 + 维护 deliveries。幂等(UNIQUE ignore / 终态不回退)。"""
    p = ev.get("payload")
    r = ev.get("routing")
    c.execute(
        """INSERT OR IGNORE INTO events
           (source_file, seq, ts, from_agent, type, topic, event_class, priority,
            correlation_id, causation_id, idempotency_key, payload, routing, raw)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            source_file, ev.get("seq"), ev.get("ts"), ev.get("from"), ev.get("type"),
            ev.get("topic"), ev.get("event_class"), ev.get("priority"),
            ev.get("correlation_id"), ev.get("causation_id"),
            (ev.get("meta") or {}).get("idempotency_key"),
            json.dumps(p, ensure_ascii=False) if p is not None else None,
            json.dumps(r, ensure_ascii=False) if r is not None else None,
            json.dumps(ev, ensure_ascii=False),
        ),
    )

    etype = ev.get("type")
    if etype in DELIVERY_TYPES:
        for to_agent in ev.get("to") or []:
            if not to_agent or to_agent == "END":
                continue
            c.execute(
                """INSERT OR IGNORE INTO deliveries (source_file, seq, to_agent, status)
                   VALUES (?,?,?,'pending')""",
                (source_file, ev.get("seq"), to_agent),
            )
    elif etype in RESOLUTION_STATUS:
        rf, rs = _ref_of(ev)
        if rf is not None:
            new_status = RESOLUTION_STATUS[etype]
            resolver = ev.get("from")
            resolved_by = "{}:{}".format(source_file, ev.get("seq"))
            # 终态不被非终态覆盖;acked 只从 pending/claimed 进入
            if new_status in TERMINAL:
                cond = "status NOT IN ('done','cancelled','dead')"
            else:
                cond = "status IN ('pending','claimed','escalated','blocked','acked')"
            # 优先精确匹配 resolver 的 delivery,否则该 dispatch 的全部未终态 delivery
            cur = c.execute(
                "UPDATE deliveries SET status=?, resolved_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
                "WHERE source_file=? AND seq=? AND to_agent=? AND " + cond,
                (new_status, resolved_by, rf, rs, resolver),
            )
            if cur.rowcount == 0 and new_status in ("done", "cancelled"):
                c.execute(
                    "UPDATE deliveries SET status=?, resolved_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
                    "WHERE source_file=? AND seq=? AND " + cond,
                    (new_status, resolved_by, rf, rs),
                )


def record_event(source_file: str, ev: dict) -> None:
    """入口:canonical 追加成功后调用。独立连接,自动提交。"""
    c = connect()
    try:
        apply_event(c, source_file, ev)
        c.commit()
    finally:
        c.close()
