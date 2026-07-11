#!/usr/bin/env python3
from __future__ import annotations
"""
a2a-log.py — A2A Event Log CLI v1.1
Shared inter-agent communication event store.
Standard library only; no external dependencies.

Usage:
  python3 a2a-log.py write  --from <agent> --to <agent[,agent...]> --topic <topic>
                             --type <type> --payload '<json>'
                             [--prev <agent>] [--next <agent|END>] [--next-task <desc>]
                             [--merge-wait <none|all|any>] [--cycle <n/max|none>]
                             [--ttl-hours <n>]
                             [--specversion <ver>] [--correlation-id <id>]
                             [--causation-id <id>] [--priority <P0|P1|P2>]
                             [--event-class <business|control>]
                             [--idempotency-key <key>] [--attempt <n>]
                             [--max-attempts <n>] [--dry-run]
  python3 a2a-log.py read   --agent <agent> [--topic <topic>] [--status <status>]
                             [--limit <n>]
  python3 a2a-log.py ack    --agent <agent> --seq <n> --file <from-agent>
                             [--correlation-id <id>]
  python3 a2a-log.py done   --agent <agent> --seq <n> --file <from-agent>
                             [--summary <text>] [--correlation-id <id>]
  python3 a2a-log.py pending --agent <agent>
"""

import argparse
import fcntl
import fnmatch
import glob
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta

# ── Hook-C deduplication: prevent duplicate wakes within a rolling time window ──
_HOOK_C_SEEN: dict[str, float] = {}
_HOOK_C_TTL_SECONDS = 30


def _hook_c_is_duplicate(event: dict, target_agent: str | None = None) -> bool:
    """Return True if this (from_agent, seq, target_agent) was Hook-C notified within the TTL window.
    
    This prevents ACK/DONE (which re-trigger _hook_notify via cmd_ack/cmd_done)
    from sending duplicate wake signals, while still allowing fan-out to multiple recipients.
    """
    key = f"{event.get('from', '')}:{event.get('seq', '')}:{target_agent or ''}"
    now = time.time()
    last = _HOOK_C_SEEN.get(key, 0)
    if now - last < _HOOK_C_TTL_SECONDS:
        return True
    _HOOK_C_SEEN[key] = now
    # Prune to avoid unbounded growth
    if len(_HOOK_C_SEEN) > 2000:
        cutoff = now - _HOOK_C_TTL_SECONDS * 3
        for k in list(_HOOK_C_SEEN):
            if _HOOK_C_SEEN[k] < cutoff:
                del _HOOK_C_SEEN[k]
    return False


try:
    from a2a_routing import (
        build_closeout_target as routing_build_closeout_target,
        resolve_session_key as routing_resolve_session_key,
        resolve_display_label as routing_resolve_display_label,
        get_session_store_path as routing_get_session_store_path,
        get_home_session_key as routing_get_home_session_key,
        get_context_session_key as routing_get_context_session_key,
    )
except Exception:
    routing_build_closeout_target = None
    routing_resolve_session_key = None
    routing_resolve_display_label = None
    routing_get_session_store_path = None
    routing_get_home_session_key = None
    routing_get_context_session_key = None

# ── Paths ─────────────────────────────────────────────────────────────────────

# Event X / toolkit shared root (override with A2A_LOG_HOME)
BASE_DIR = os.path.expanduser(
    os.environ.get("A2A_LOG_HOME", "~/.openclaw/workspace/state/a2a-log")
)
EVENTS_DIR = os.path.join(BASE_DIR, "events")
CURSORS_DIR = os.path.join(BASE_DIR, "cursors")
ROUTING_RULES_FILE = os.path.join(BASE_DIR, "routing-rules.json")
AUDIT_DIR = os.path.join(BASE_DIR, "audit")
HOOK_C_AUDIT_FILE = os.path.join(AUDIT_DIR, "hook-c.jsonl")

# ── Valid event types ─────────────────────────────────────────────────────────

VALID_TYPES = {
    # Business events
    "task.dispatch",
    "task.acked",
    "task.done",
    "task.blocked",
    "task.escalated",
    "task.cancelled",
    "task.retry",
    "task.retry_exhausted",
    "task.delivered",
    "result.partial",
    "info.sync",
    "info.decision",
    "release.request",
    "release.review_pass",
    "release.done",
    # Control events
    "system.heartbeat",
    "system.wake",
    "system.continue",
    "system.compaction",
}

VALID_CLOSEOUT_POLICIES = {"required", "optional", "none"}
VALID_REVIEW_RESULTS = {"pass", "needs_revision", "blocked"}

# ── Doc-First 阈值 ────────────────────────────────────────────────────────────
DOC_FIRST_SUMMARY_MAX = 200  # 字符数阈值
DOC_FIRST_PAYLOAD_MAX = 500  # payload JSON 总大小阈值（字符数）

# ── Helpers ───────────────────────────────────────────────────────────────────

def now_iso() -> str:
    """Return current time as ISO 8601 with +08:00 timezone."""
    tz_cst = timezone(timedelta(hours=8))
    return datetime.now(tz_cst).isoformat(timespec="seconds")


def parse_iso(ts: str):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def today_str() -> str:
    """Return today as YYYYMMDD in CST."""
    tz_cst = timezone(timedelta(hours=8))
    return datetime.now(tz_cst).strftime("%Y%m%d")


def infer_event_class(event_type: str, override: str = None) -> str:
    """Infer event_class from type. system.* → control, else business. Override allowed."""
    if override:
        return override
    if event_type and event_type.startswith("system."):
        return "control"
    return "business"


def load_routing_rules() -> dict:
    """Load routing-rules.json; return empty dict on failure."""
    try:
        with open(ROUTING_RULES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"topic_routes": {}, "default_route": "993271843777691700"}


def resolve_result_channel(topic: str) -> str:
    """Match topic against routing rules (wildcard). Return channel ID."""
    rules = load_routing_rules()
    for pattern, channel_id in rules.get("topic_routes", {}).items():
        if fnmatch.fnmatch(topic, pattern):
            return channel_id
    return rules.get("default_route", "993271843777691700")


def default_closeout_policy(event_class: str) -> str:
    return "none" if event_class == "control" else "optional"


def _resolve_closeout_policy(event_class: str, override: str | None = None) -> str:
    policy = override or default_closeout_policy(event_class)
    if policy not in VALID_CLOSEOUT_POLICIES:
        raise ValueError(f"invalid closeout_policy: {policy}")
    return policy


def _derive_write_closeout_mode(
    result_channel_arg: str | None,
    origin_context_channel_id: str | None,
) -> str:
    if origin_context_channel_id and not result_channel_arg:
        return "inherited_origin"
    if result_channel_arg:
        return "explicit_override"
    return "implicit_fallback"


def _derive_legacy_closeout_mode(
    result_channel: str | None,
    origin_context_channel_id: str | None,
) -> str:
    if origin_context_channel_id and result_channel == origin_context_channel_id:
        return "inherited_origin"
    if origin_context_channel_id and result_channel and result_channel != origin_context_channel_id:
        return "explicit_override"
    return "implicit_fallback"


def _build_closeout_target(
    channel_id: str | None,
    *,
    mode: str,
    surface: str = "discord",
    thread_id: str | None = None,
) -> dict | None:
    if not channel_id:
        return None

    if routing_build_closeout_target is not None:
        try:
            return routing_build_closeout_target(
                channel_id,
                mode=mode,
                surface=surface,
                thread_id=thread_id,
            )
        except Exception:
            pass

    return {
        "surface": surface,
        "channel_id": str(channel_id),
        "thread_id": str(thread_id) if thread_id else None,
        "mode": mode,
    }


def _normalize_closeout_target(
    existing_target: dict | None,
    *,
    resolved_channel_id: str | None,
    fallback_mode: str,
) -> dict | None:
    if isinstance(existing_target, dict):
        channel_id = (
            existing_target.get("channel_id")
            or existing_target.get("thread_id")
            or resolved_channel_id
        )
        return _build_closeout_target(
            channel_id,
            mode=existing_target.get("mode") or fallback_mode,
            surface=existing_target.get("surface") or "discord",
            thread_id=existing_target.get("thread_id"),
        )

    return _build_closeout_target(resolved_channel_id, mode=fallback_mode)


def _resolve_write_routing_fields(
    *,
    topic: str,
    event_class: str,
    result_channel_arg: str | None,
    origin_context_channel_id: str | None,
    closeout_policy_arg: str | None,
) -> tuple[str, dict | None, str]:
    result_channel = result_channel_arg or origin_context_channel_id or resolve_result_channel(topic)
    closeout_target = _build_closeout_target(
        result_channel,
        mode=_derive_write_closeout_mode(result_channel_arg, origin_context_channel_id),
    )
    closeout_policy = _resolve_closeout_policy(event_class, closeout_policy_arg)
    return result_channel, closeout_target, closeout_policy


def _inherit_routing_fields(original: dict) -> dict:
    topic = original.get("topic", "unknown")
    original_routing = original.get("routing", {}) or {}
    result_channel = (
        original_routing.get("result_channel")
        or original_routing.get("origin_context_channel_id")
        or resolve_result_channel(topic)
    )
    origin_context_channel_id = original_routing.get("origin_context_channel_id")
    closeout_target = _normalize_closeout_target(
        original_routing.get("closeout_target"),
        resolved_channel_id=result_channel,
        fallback_mode=_derive_legacy_closeout_mode(result_channel, origin_context_channel_id),
    )
    closeout_policy = _resolve_closeout_policy(
        original.get("event_class") or "business",
        original_routing.get("closeout_policy"),
    )
    return {
        "prev": original.get("from", "unknown"),
        "next": "END",
        "next_task": None,
        "merge_wait": "none",
        "cycle": "none",
        "result_channel": result_channel,
        "origin_context_channel_id": origin_context_channel_id,
        "closeout_target": closeout_target,
        "closeout_policy": closeout_policy,
    }


def events_file(agent: str) -> str:
    return os.path.join(EVENTS_DIR, f"{agent}.jsonl")


def cursors_file(agent: str) -> str:
    return os.path.join(CURSORS_DIR, f"{agent}.json")


def read_last_seq(agent: str) -> int:
    """Read the last seq number from an agent's events file."""
    fpath = events_file(agent)
    if not os.path.exists(fpath):
        return 0
    last_seq = 0
    try:
        with open(fpath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                    seq = ev.get("seq", 0)
                    if isinstance(seq, int) and seq > last_seq:
                        last_seq = seq
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return last_seq


def read_events_file(agent: str) -> list:
    """Read all valid events from an agent's events file."""
    fpath = events_file(agent)
    events = []
    if not os.path.exists(fpath):
        return events
    try:
        with open(fpath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                    ev["_source_file"] = agent  # track which file it came from
                    events.append(ev)
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return events


def append_event(agent: str, event: dict) -> None:
    """Append a single event to an agent's events file (immutable log)."""
    fpath = events_file(agent)
    os.makedirs(EVENTS_DIR, exist_ok=True)
    ev_clean = {k: v for k, v in event.items() if k != "_source_file"}
    with open(fpath, "a", encoding="utf-8") as f:
        f.write(json.dumps(ev_clean, ensure_ascii=False) + "\n")


def _locked_append_event(agent: str, event: dict) -> int:
    """Atomically read last seq, assign next seq, and append event with file lock.

    Uses fcntl.flock(LOCK_EX) on a per-agent .lock file to ensure that
    read_last_seq → seq assignment → append_event is an atomic unit, even
    when multiple processes write to the same agent's JSONL concurrently.

    Returns the assigned seq number.
    """
    fpath = events_file(agent)
    lock_path = fpath + ".lock"
    os.makedirs(EVENTS_DIR, exist_ok=True)

    with open(lock_path, "w") as lock_fd:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            # Read last seq while holding lock
            last_seq = read_last_seq(agent)
            next_seq = last_seq + 1
            event["seq"] = next_seq

            # Append while still holding lock
            ev_clean = {k: v for k, v in event.items() if k != "_source_file"}
            with open(fpath, "a", encoding="utf-8") as f:
                f.write(json.dumps(ev_clean, ensure_ascii=False) + "\n")

            return next_seq
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)


def append_audit_record(file_path: str, record: dict) -> None:
    """Append one lightweight audit record to a JSONL file."""
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _write_hook_c_audit(
    event: dict,
    target_agent: str,
    outcome: str,
    resolution: dict | None = None,
    command_hint: str | None = None,
    error: str | None = None,
) -> None:
    """Record Hook-C delivery observability without polluting canonical business events."""
    routing = event.get("routing", {}) or {}
    closeout_target = routing.get("closeout_target")
    if isinstance(closeout_target, str):
        closeout_target = {
            "channel_id": closeout_target,
            "mode": "legacy_string",
        }

    record = {
        "ts": now_iso(),
        "hook": "hook-c",
        "outcome": outcome,
        "event": {
            "from": event.get("from"),
            "seq": event.get("seq"),
            "type": event.get("type"),
            "topic": event.get("topic"),
            "correlation_id": event.get("correlation_id"),
        },
        "target_agent": target_agent,
        "routing": {
            "origin_context_channel_id": routing.get("origin_context_channel_id"),
            "result_channel": routing.get("result_channel"),
            "closeout_policy": routing.get("closeout_policy"),
            "closeout_target": closeout_target,
        },
        "delivery": {
            "command_hint": command_hint,
            "requested_context_channel_id": (resolution or {}).get("requested_context_channel_id"),
            "resolution_mode": (resolution or {}).get("resolution_mode"),
            "fallback_reason": (resolution or {}).get("fallback_reason"),
            "no_session_reason": (resolution or {}).get("no_session_reason"),
            "session_key": (resolution or {}).get("session_key"),
            "session_id": (resolution or {}).get("session_id"),
            "label": (resolution or {}).get("label"),
            "home_session_key": (resolution or {}).get("home_session_key"),
            "context_session_key": (resolution or {}).get("context_session_key"),
        },
    }
    if error:
        record["error"] = error

    try:
        append_audit_record(HOOK_C_AUDIT_FILE, record)
    except Exception as audit_error:
        sys.stderr.write(f"[hook-c] AUDIT ERROR: {audit_error}\n")


def write_events_file(agent: str, events: list) -> None:
    """Overwrite an agent's events file with the given list (legacy use only)."""
    fpath = events_file(agent)
    os.makedirs(EVENTS_DIR, exist_ok=True)
    with open(fpath, "w", encoding="utf-8") as f:
        for ev in events:
            # Remove internal tracking field before writing
            ev_clean = {k: v for k, v in ev.items() if k != "_source_file"}
            f.write(json.dumps(ev_clean, ensure_ascii=False) + "\n")


def find_event_by_seq(agent: str, seq: int) -> "dict | None":
    """Find a specific event by seq in an agent's events file."""
    events = read_events_file(agent)
    for ev in events:
        if ev.get("seq") == seq:
            return ev
    return None


def update_cursor(agent: str, source_file: str, seq: int) -> None:
    """Update the read cursor for an agent."""
    fpath = cursors_file(agent)
    os.makedirs(CURSORS_DIR, exist_ok=True)
    try:
        with open(fpath, "r", encoding="utf-8") as f:
            cursor = json.load(f)
    except Exception:
        cursor = {"last_seq": {}, "updated_at": None}

    last_seq = cursor.get("last_seq", {})
    if not isinstance(last_seq, dict):
        last_seq = {}

    # Update if the new seq is greater than the stored one
    current = last_seq.get(source_file, 0)
    if seq > current:
        last_seq[source_file] = seq

    cursor["last_seq"] = last_seq
    cursor["updated_at"] = now_iso()

    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(cursor, f, ensure_ascii=False, indent=2)


def load_cursor(agent: str) -> dict:
    """Load cursor for agent; return default if missing."""
    fpath = cursors_file(agent)
    try:
        with open(fpath, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"last_seq": {}, "updated_at": None}


def all_agent_files() -> list:
    """Return list of agent names from events/*.jsonl files."""
    pattern = os.path.join(EVENTS_DIR, "*.jsonl")
    files = glob.glob(pattern)
    agents = [os.path.splitext(os.path.basename(f))[0] for f in files]
    return agents


def read_jsonl_file(path: str) -> list:
    records = []
    if not os.path.exists(path):
        return records
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return records


def _resolved_event_keys(all_events: list) -> set:
    resolved = set()
    for ev in all_events:
        if ev.get("type") not in ("task.acked", "task.done", "task.blocked", "task.cancelled"):
            continue
        cid = ev.get("causation_id", "")
        if cid and cid.startswith("seq:"):
            resolved.add(cid[4:])
        payload = ev.get("payload", {}) or {}
        if isinstance(payload, dict):
            ref_from = payload.get("ref_from", "")
            ref_seq = payload.get("ref_seq", "")
            if ref_from and ref_seq:
                resolved.add(f"{ref_from}:{ref_seq}")
    return resolved


def _load_hook_c_audit_records() -> list:
    return read_jsonl_file(HOOK_C_AUDIT_FILE)


def _hook_c_attempts_for_event(event: dict, target_agent: str, audit_records: list) -> list:
    matched = []
    for rec in audit_records:
        ev = rec.get("event", {}) or {}
        if rec.get("target_agent") != target_agent:
            continue
        if ev.get("from") != event.get("from") or ev.get("seq") != event.get("seq"):
            continue
        if ev.get("type") != event.get("type") or ev.get("topic") != event.get("topic"):
            continue
        if (ev.get("correlation_id") or "") != (event.get("correlation_id") or ""):
            continue
        matched.append(rec)
    matched.sort(key=lambda r: r.get("ts", ""))
    return matched


def _append_escalation_for_compensation(event: dict, target_agent: str, attempts: int, reason: str, dry_run: bool = False) -> dict:
    causation_id = f"seq:{event.get('from')}:{event.get('seq')}"
    idempotency_key = f"compensate-{event.get('from')}-{event.get('seq')}-{target_agent}-escalate"
    existing = _find_existing_by_idempotency("cron", idempotency_key)
    if existing is not None:
        return {"status": "already_exists", "seq": existing.get("seq")}

    escalation_event = {
        "specversion": "1.1",
        "seq": None,
        "ts": now_iso(),
        "from": "cron",
        "to": ["issac"],
        "topic": event.get("topic", "unknown"),
        "type": "task.escalated",
        "event_class": "business",
        "priority": "P0",
        "correlation_id": event.get("correlation_id") or f"workflow-{event.get('topic', 'unknown')}-{today_str()}",
        "causation_id": causation_id,
        "routing": event.get("routing", {}) or {},
        "meta": {
            "idempotency_key": idempotency_key,
            "attempt": attempts,
            "max_attempts": attempts,
        },
        "payload": {
            "summary": f"🚨 dispatch compensation escalated: {target_agent} 未 ACK，已重试 {attempts} 次",
            "target_agent": target_agent,
            "dispatch_from": event.get("from"),
            "dispatch_seq": event.get("seq"),
            "reason": reason,
            "source": "cron-compensation",
        },
        "ttl_hours": 24,
    }
    if dry_run:
        return {"status": "dry_run_escalate", "event": escalation_event}
    next_seq = _locked_append_event("cron", escalation_event)
    _hook_notify_recipients_on_write(escalation_event)
    return {"status": "escalated", "seq": next_seq}

# ── Commands ──────────────────────────────────────────────────────────────────

# ── Doc-First 白名单字段 ─────────────────────────────────────────────────────
DOC_FIRST_ALLOWED_FIELDS = {
    "summary", "doc_path", "task", "task_detail", "reason",
    "ref_seq", "ref_from", "pipeline_id", "pipeline_name", "_idempotency_key",
}


def _enforce_doc_first(payload: dict, payload_str: str, event_class: str, dry_run: bool = False) -> dict:
    """
    Doc-First 校验：仅对 event_class == 'business' 的事件生效。
    1. 如果 summary 超过 DOC_FIRST_SUMMARY_MAX 字符：
       - 无 doc_path → 拒绝（sys.exit(1)）；dry_run 时只警告不拒绝
       - 有 doc_path → 自动截断 summary 并警告
    2. 如果整个 payload JSON 超过 DOC_FIRST_PAYLOAD_MAX 字符且无 doc_path → 拒绝；dry_run 时只警告
    3. 对非白名单字段中的字符串值，如果超过 DOC_FIRST_SUMMARY_MAX 且无 doc_path → stderr 警告（不拒绝）
    返回（可能被截断的）payload dict。
    """
    if event_class != "business":
        return payload

    summary = payload.get("summary")
    doc_path = payload.get("doc_path")

    # 规则 1：summary 长度校验
    if summary is not None and len(summary) > DOC_FIRST_SUMMARY_MAX:
        if not doc_path:
            if dry_run:
                sys.stderr.write(
                    "[doc-first] DRY-RUN: would reject — summary exceeds 200 chars, provide doc_path\n"
                )
            else:
                print(json.dumps({"error": "doc-first: summary exceeds 200 chars, provide doc_path"}))
                sys.exit(1)
        else:
            # 截断 summary 到 200 字符并追加省略号
            payload = dict(payload)
            payload["summary"] = summary[:DOC_FIRST_SUMMARY_MAX] + "…"
            sys.stderr.write("[doc-first] summary truncated to 200 chars, full content at doc_path\n")

    # 规则 2：payload 总大小校验（使用截断后的 payload 重新序列化）
    current_payload_str = json.dumps(payload, ensure_ascii=False)
    if len(current_payload_str) > DOC_FIRST_PAYLOAD_MAX and not payload.get("doc_path"):
        if dry_run:
            sys.stderr.write(
                "[doc-first] DRY-RUN: would reject — payload exceeds 500 chars, provide doc_path for long content\n"
            )
        else:
            print(json.dumps({"error": "doc-first: payload exceeds 500 chars, provide doc_path for long content"}))
            sys.exit(1)

    # 规则 3：非白名单字段超长 → stderr 警告（不拒绝，避免破坏现有功能）
    if not doc_path:
        for field, value in payload.items():
            if field in DOC_FIRST_ALLOWED_FIELDS:
                continue
            if isinstance(value, str) and len(value) > DOC_FIRST_SUMMARY_MAX:
                sys.stderr.write(
                    f"[doc-first] WARN: non-whitelisted field '{field}' has string value "
                    f"({len(value)} chars > {DOC_FIRST_SUMMARY_MAX}); consider providing doc_path\n"
                )

    return payload


def _auto_create_pipeline(event: dict) -> None:
    """
    Auto-create a minimal 2-step pipeline when a task.dispatch event with routing.next != END is written.
    Called after append_event in cmd_write. Failures are silent (stderr only).
    """
    try:
        correlation_id = event.get("correlation_id")
        topic = event.get("topic", "unknown")
        routing = event.get("routing", {})
        result_channel = routing.get("result_channel") or resolve_result_channel(topic)
        origin_context_channel_id = routing.get("origin_context_channel_id") or None
        closeout_target = _normalize_closeout_target(
            routing.get("closeout_target"),
            resolved_channel_id=result_channel,
            fallback_mode=_derive_legacy_closeout_mode(result_channel, origin_context_channel_id),
        )
        closeout_policy = _resolve_closeout_policy(
            event.get("event_class") or "business",
            routing.get("closeout_policy"),
        )
        next_agent = routing.get("next", "END")
        to_agents = event.get("to", [])
        payload = event.get("payload", {}) or {}
        ts = event.get("ts", now_iso())

        # Derive step 1 task description
        step1_task = (
            payload.get("summary")
            or payload.get("task")
            or topic
        )

        # Ensure active dir exists
        pipelines_active_dir = os.path.expanduser(
            "~/.openclaw/workspace/state/pipelines/active"
        )
        os.makedirs(pipelines_active_dir, exist_ok=True)

        # Check for existing pipeline with same correlation_id (idempotency)
        # Check both active/ and completed/ directories
        import glob as _glob
        pipelines_completed_dir = os.path.expanduser(
            "~/.openclaw/workspace/state/pipelines/completed"
        )
        for search_dir in [pipelines_active_dir, pipelines_completed_dir]:
            if not os.path.isdir(search_dir):
                continue
            for existing_path in _glob.glob(os.path.join(search_dir, "*.json")):
                try:
                    with open(existing_path, "r", encoding="utf-8") as f:
                        existing = json.load(f)
                    if existing.get("correlation_id") == correlation_id:
                        sys.stderr.write(
                            f"[auto-pipeline] already exists: {existing.get('id')} "
                            f"(correlation_id={correlation_id})\n"
                        )
                        return
                except Exception:
                    continue

        # [P0 fix] Build pipeline ID from correlation_id to avoid topic+date collisions
        # when the same topic fires multiple times on the same day from different contexts.
        pipeline_id = f"pl-{correlation_id}"
        pipeline_name = f"{topic} (auto)"

        step1_agent = to_agents[0] if to_agents else "unknown"

        steps = [
            {
                "step": 1,
                "agent": step1_agent,
                "task": step1_task,
                "task_detail": "",
                "doc_path": None,
                "next": next_agent,
                "on_fail": None,
                "max_cycles": None,
                "timeout_hours": None,
                "started_at": ts,
                "completed_at": None,
                "result": None,
                "result_doc_path": None,
            },
            {
                "step": 2,
                "agent": next_agent,
                "task": "后续处理",
                "task_detail": "",
                "doc_path": None,
                "next": "END",
                "on_fail": None,
                "max_cycles": None,
                "timeout_hours": None,
                "started_at": None,
                "completed_at": None,
                "result": None,
                "result_doc_path": None,
            },
        ]

        pipeline = {
            "$schema": "pipeline-v1",
            "id": pipeline_id,
            "name": pipeline_name,
            "topic": topic,
            "correlation_id": correlation_id,
            "created_at": ts,
            "created_by": "a2a-log.py:auto-pipeline",
            "template": "auto-generated",
            "status": "active",
            "result_channel": result_channel,
            "origin_context_channel_id": origin_context_channel_id,
            "delivery_target": {
                "channel": result_channel,
                "origin_context_channel_id": origin_context_channel_id,
            },
            "current_step": 1,
            "steps": steps,
            "on_complete": {
                "notify": ["issac"],
                # [P0 fix] was hard-coded to resolve_result_channel("pmo-notify") → silent misroute to PMO
                "channel": result_channel,
                "message_template": "Pipeline {id} 全部完成 ✅ 共 {total_steps} 步，耗时 {elapsed}",
                "final_delivery": {
                    "channel": result_channel,
                    "inherit_context": bool(origin_context_channel_id),
                    "closeout_target": closeout_target,
                    "closeout_policy": closeout_policy,
                    "human_summary_required": True,
                    "template": None,
                },
            },
            "on_timeout": {
                "notify": ["issac"],
                # [P0 fix] was hard-coded to resolve_result_channel("pno-notify")
                "channel": result_channel,
                "escalate": True,
            },
            "step_history": [
                {
                    "step": 1,
                    "agent": step1_agent,
                    "started": ts,
                    "completed": None,
                    "result": None,
                    "processed_events": [],
                }
            ],
        }

        dest_path = os.path.join(pipelines_active_dir, f"{pipeline_id}.json")
        with open(dest_path, "w", encoding="utf-8") as f:
            json.dump(pipeline, f, ensure_ascii=False, indent=2)
        os.chmod(dest_path, 0o600)

        sys.stderr.write(f"[auto-pipeline] Created {pipeline_id} in active/\n")

    except Exception as e:
        sys.stderr.write(f"[auto-pipeline] ERROR: {e}\n")


def cmd_write(args):
    """Write a new event to the from-agent's events file (v1.1 format)."""
    from_agent = args.frm
    to_agents = [a.strip() for a in args.to.split(",") if a.strip()]
    topic = args.topic
    event_type = args.type
    dry_run = args.dry_run

    # Validate event type
    if event_type not in VALID_TYPES:
        sys.stderr.write(f"[warn] Unknown event type: {event_type}. Proceeding anyway.\n")

    # Parse payload JSON
    try:
        payload = json.loads(args.payload) if args.payload else {}
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid --payload JSON: {e}"}))
        sys.exit(1)

    # Infer event_class early (needed for doc-first validation)
    event_class = infer_event_class(event_type, args.event_class)

    # ── Doc-First 校验（dry-run 也执行，以便发现问题）─────────────────────────
    payload_str = json.dumps(payload, ensure_ascii=False)
    payload = _enforce_doc_first(payload, payload_str, event_class, dry_run=dry_run)

    # Resolve closeout routing: explicit override > inherited origin > topic fallback
    result_channel, closeout_target, closeout_policy = _resolve_write_routing_fields(
        topic=topic,
        event_class=event_class,
        result_channel_arg=args.result_channel,
        origin_context_channel_id=args.origin_context_channel_id,
        closeout_policy_arg=getattr(args, "closeout_policy", None),
    )

    # Resolve correlation_id: use provided or auto-generate
    correlation_id = args.correlation_id
    if not correlation_id:
        correlation_id = f"workflow-{topic}-{today_str()}"

    # Build v1.1 event (no status/read_by/acked_by/done_at fields)
    # seq will be assigned atomically by _locked_append_event
    event = {
        "specversion": args.specversion or "1.1",
        "seq": None,  # placeholder; assigned atomically below
        "ts": now_iso(),
        "from": from_agent,
        "to": to_agents,
        "topic": topic,
        "type": event_type,
        "event_class": event_class,
        "priority": args.priority or "P1",
        "correlation_id": correlation_id,
        "causation_id": args.causation_id or None,
        "routing": {
            "prev": args.prev or "none",
            "next": args.next if args.next else "END",
            "next_task": args.next_task or None,
            "merge_wait": args.merge_wait or "none",
            "cycle": args.cycle or "none",
            "result_channel": result_channel,
            "origin_context_channel_id": args.origin_context_channel_id or None,
            "closeout_target": closeout_target,
            "closeout_policy": closeout_policy,
        },
        "meta": {
            "idempotency_key": args.idempotency_key or None,
            "attempt": args.attempt if args.attempt is not None else 1,
            "max_attempts": args.max_attempts if args.max_attempts is not None else 3,
        },
        "payload": payload,
        "ttl_hours": args.ttl_hours if args.ttl_hours is not None else 24,
    }

    if dry_run:
        # For dry-run, compute seq non-atomically (read-only, no lock needed)
        event["seq"] = read_last_seq(from_agent) + 1
        print(json.dumps({"status": "dry_run", "event": event}, ensure_ascii=False, indent=2))
        return

    # Atomically assign seq, append to file (immutable log — never overwrite)
    next_seq = _locked_append_event(from_agent, event)
    _hook_notify_recipients_on_write(event)

    # Auto-create pipeline if task.dispatch + routing.next != END (idempotent)
    routing_next = event.get("routing", {}).get("next", "END")
    if event_type == "task.dispatch" and routing_next not in ("END", "none", None, ""):
        _auto_create_pipeline(event)

    print(json.dumps({
        "status": "written",
        "seq": next_seq,
        "file": f"events/{from_agent}.jsonl",
        "correlation_id": correlation_id,
    }))


def cmd_read(args):
    """Read events addressed to --agent, with optional filters."""
    agent = args.agent
    topic_filter = getattr(args, "topic", None)
    status_filter = getattr(args, "status", None)
    limit = getattr(args, "limit", 20) or 20

    # Collect all events from all agent files
    all_events = []
    agent_files = all_agent_files()
    for source_agent in agent_files:
        evs = read_events_file(source_agent)
        all_events.extend(evs)

    # Filter: agent must be in 'to' list
    filtered = [
        ev for ev in all_events
        if agent in ev.get("to", [])
    ]

    # Optional filters
    if topic_filter:
        filtered = [ev for ev in filtered if ev.get("topic") == topic_filter]

    # v1.0 compat: status filter only applies to events that have status field
    if status_filter:
        filtered = [ev for ev in filtered if ev.get("status") == status_filter]

    # Sort ascending by ts
    filtered.sort(key=lambda ev: ev.get("ts", ""))

    # Apply limit
    filtered = filtered[:limit]

    # Update cursor: track max seq per source file seen
    cursor_updates = {}
    for ev in filtered:
        src = ev.get("_source_file", ev.get("from", "unknown"))
        seq = ev.get("seq", 0)
        current = cursor_updates.get(src, 0)
        if seq > current:
            cursor_updates[src] = seq

    for src_file, max_seq in cursor_updates.items():
        update_cursor(agent, src_file, max_seq)

    # Strip internal field before output
    output = [{k: v for k, v in ev.items() if k != "_source_file"} for ev in filtered]

    print(json.dumps({
        "agent": agent,
        "events": output,
        "count": len(output),
    }, ensure_ascii=False, indent=2))


def cmd_ack(args):
    """ACK an event: append a task.acked event to the ack agent's file (v1.1 immutable log)."""
    agent = args.agent          # the agent doing the ACK
    seq = args.seq
    source_file = args.file     # the agent whose file contains the original event

    # Look up the original event to inherit correlation_id
    original = find_event_by_seq(source_file, seq)
    if original is None:
        print(json.dumps({"error": f"seq={seq} not found in events/{source_file}.jsonl"}))
        sys.exit(1)

    # Inherit correlation_id from original (or use override)
    correlation_id = getattr(args, "correlation_id", None) or original.get("correlation_id")
    if not correlation_id:
        correlation_id = f"workflow-{original.get('topic', 'unknown')}-{today_str()}"

    causation_id = f"seq:{source_file}:{seq}"

    ack_event = {
        "specversion": "1.1",
        "seq": None,  # assigned atomically by _locked_append_event
        "ts": now_iso(),
        "from": agent,
        "to": [source_file],
        "topic": original.get("topic", "unknown"),
        "type": "task.acked",
        "event_class": "business",
        "priority": original.get("priority", "P1"),
        "correlation_id": correlation_id,
        "causation_id": causation_id,
        "routing": _inherit_routing_fields(original),
        "meta": {
            "idempotency_key": None,
            "attempt": 1,
            "max_attempts": 3,
        },
        "payload": {
            "ref_seq": seq,
            "ref_from": source_file,
        },
        "ttl_hours": 24,
    }

    # Atomically assign seq and append to the ACK agent's file (NOT the source file — immutable log)
    next_seq = _locked_append_event(agent, ack_event)
    _hook_notify_recipients_on_write(ack_event)

    print(json.dumps({
        "status": "acked",
        "seq": next_seq,
        "file": f"events/{agent}.jsonl",
        "agent": agent,
        "causation_id": causation_id,
        "correlation_id": correlation_id,
    }))


def _pipeline_sync_on_done(done_event: dict) -> None:
    """
    [v2.1 第一层防线] 在 cmd_done 写入 Event Log 之后，自动同步 pipeline JSON。
    失败静默（try/except），不影响主流程。
    使用原子写（write tmp + rename）防竞态。
    """
    try:
        correlation_id = done_event.get("correlation_id")
        if not correlation_id:
            return

        pipelines_active_dir = os.path.expanduser(
            "~/.openclaw/workspace/state/pipelines/active"
        )
        if not os.path.isdir(pipelines_active_dir):
            return

        pattern = os.path.join(pipelines_active_dir, "*.json")
        from_agent = done_event.get("from", "")
        event_ts = done_event.get("ts", "")
        doc_path = (done_event.get("payload") or {}).get("doc_path")

        for pipeline_path in glob.glob(pattern):
            try:
                with open(pipeline_path, "r", encoding="utf-8") as f:
                    pipeline = json.load(f)
            except Exception:
                continue

            if pipeline.get("correlation_id") != correlation_id:
                continue

            # 找到匹配的 pipeline，检查 current_step
            steps = pipeline.get("steps", [])
            current_step_num = pipeline.get("current_step", 1)
            if current_step_num < 1 or current_step_num > len(steps):
                continue

            step = steps[current_step_num - 1]
            # 匹配条件：step.agent == event.from && step.completed_at == null
            if step.get("agent") != from_agent:
                continue
            if step.get("completed_at") is not None:
                continue

            # 更新 step 字段
            step["completed_at"] = event_ts
            step["result"] = "done"
            step["result_doc_path"] = doc_path
            pipeline["steps"][current_step_num - 1] = step

            # 原子写：写 tmp + rename
            tmp_path = pipeline_path + ".tmp"
            try:
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(pipeline, f, ensure_ascii=False, indent=2)
                os.rename(tmp_path, pipeline_path)
                print(
                    f"[pipeline-sync] Updated {pipeline.get('id')} step {current_step_num}"
                )
                # Hook-B: 最后一步完成后立即触发 executor
                if step.get("next") == "END" or current_step_num >= len(steps):
                    _hook_trigger_executor_on_final_step(
                        done_event, pipeline.get("id", "")
                    )
            except Exception:
                # 清理 tmp 文件
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
                raise
            break  # 找到一个匹配就退出

    except Exception:
        # 失败静默，不影响 done 写入
        pass


def _pipeline_sync_on_blocked(blocked_event: dict) -> None:
    """
    [v2.1 第一层防线] 在 cmd_blocked 写入 Event Log 之后，自动同步 pipeline JSON。
    将 current step 标记为 result="blocked"。
    失败静默（try/except），不影响主流程。
    使用原子写（write tmp + rename）防竞态。
    """
    try:
        correlation_id = blocked_event.get("correlation_id")
        if not correlation_id:
            return

        pipelines_active_dir = os.path.expanduser(
            "~/.openclaw/workspace/state/pipelines/active"
        )
        if not os.path.isdir(pipelines_active_dir):
            return

        pattern = os.path.join(pipelines_active_dir, "*.json")
        from_agent = blocked_event.get("from", "")
        event_ts = blocked_event.get("ts", "")

        for pipeline_path in glob.glob(pattern):
            try:
                with open(pipeline_path, "r", encoding="utf-8") as f:
                    pipeline = json.load(f)
            except Exception:
                continue

            if pipeline.get("correlation_id") != correlation_id:
                continue

            steps = pipeline.get("steps", [])
            current_step_num = pipeline.get("current_step", 1)
            if current_step_num < 1 or current_step_num > len(steps):
                continue

            step = steps[current_step_num - 1]
            if step.get("agent") != from_agent:
                continue
            if step.get("completed_at") is not None:
                continue

            step["completed_at"] = event_ts
            step["result"] = "blocked"
            pipeline["steps"][current_step_num - 1] = step

            tmp_path = pipeline_path + ".tmp"
            try:
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(pipeline, f, ensure_ascii=False, indent=2)
                os.rename(tmp_path, pipeline_path)
                print(
                    f"[pipeline-sync] Updated {pipeline.get('id')} step {current_step_num} → blocked"
                )
                # Hook-B: 最后一步 blocked 后立即触发 executor（处理 on_fail/escalation）
                if step.get("next") == "END" or current_step_num >= len(steps):
                    _hook_trigger_executor_on_final_step(
                        blocked_event, pipeline.get("id", "")
                    )
            except Exception:
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
                raise
            break

    except Exception:
        pass


def _pipeline_sync_on_cancelled(cancelled_event: dict) -> None:
    """
    [v2.1 第一层防线] 在 cmd_cancelled 写入 Event Log 之后，自动同步 pipeline JSON。
    将 current step 标记为 result="cancelled"。
    失败静默（try/except），不影响主流程。
    使用原子写（write tmp + rename）防竞态。
    """
    try:
        correlation_id = cancelled_event.get("correlation_id")
        if not correlation_id:
            return

        pipelines_active_dir = os.path.expanduser(
            "~/.openclaw/workspace/state/pipelines/active"
        )
        if not os.path.isdir(pipelines_active_dir):
            return

        pattern = os.path.join(pipelines_active_dir, "*.json")
        from_agent = cancelled_event.get("from", "")
        event_ts = cancelled_event.get("ts", "")

        for pipeline_path in glob.glob(pattern):
            try:
                with open(pipeline_path, "r", encoding="utf-8") as f:
                    pipeline = json.load(f)
            except Exception:
                continue

            if pipeline.get("correlation_id") != correlation_id:
                continue

            steps = pipeline.get("steps", [])
            current_step_num = pipeline.get("current_step", 1)
            if current_step_num < 1 or current_step_num > len(steps):
                continue

            step = steps[current_step_num - 1]
            if step.get("agent") != from_agent:
                continue
            if step.get("completed_at") is not None:
                continue

            step["completed_at"] = event_ts
            step["result"] = "cancelled"
            pipeline["steps"][current_step_num - 1] = step

            tmp_path = pipeline_path + ".tmp"
            try:
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(pipeline, f, ensure_ascii=False, indent=2)
                os.rename(tmp_path, pipeline_path)
                print(
                    f"[pipeline-sync] Updated {pipeline.get('id')} step {current_step_num} → cancelled"
                )
                # Hook-B: 最后一步 cancelled 后立即触发 executor（处理 on_fail/escalation）
                if step.get("next") == "END" or current_step_num >= len(steps):
                    _hook_trigger_executor_on_final_step(
                        cancelled_event, pipeline.get("id", "")
                    )
            except Exception:
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
                raise
            break

    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────────
# Hook-A & Hook-B: event-first 实时激活层（v2.2）
# ─────────────────────────────────────────────────────────────────────────────────

def _hook_escalate_on_blocked(blocked_event: dict) -> None:
    """
    Hook-A: 当 task.blocked 写入后，如果关联 active pipeline，
    立即写 task.escalated 通知 PMO。使用与 pipeline-executor 相同的
    idempotency key 规则避免双触发。
    """
    try:
        correlation_id = blocked_event.get("correlation_id")
        if not correlation_id:
            return

        from_agent = blocked_event.get("from", "")
        reason = (blocked_event.get("payload") or {}).get("reason", "task.blocked")
        topic = blocked_event.get("topic", "unknown")

        # Find matching active pipeline
        pipelines_active_dir = os.path.expanduser(
            "~/.openclaw/workspace/state/pipelines/active"
        )
        if not os.path.isdir(pipelines_active_dir):
            return

        for pipeline_path in glob.glob(os.path.join(pipelines_active_dir, "*.json")):
            try:
                with open(pipeline_path, "r", encoding="utf-8") as f:
                    pipeline = json.load(f)
            except Exception:
                continue

            if pipeline.get("correlation_id") != correlation_id:
                continue

            pl_id = pipeline.get("id", "unknown")
            current_step = pipeline.get("current_step", 1)

            # Same idempotency key as pipeline-executor's escalate_to_pmo
            idempotency_key = f"pipeline-{pl_id}-step{current_step}-escalate"

            # Check if already escalated (scan all event files)
            events_dir = os.path.expanduser(
                "~/.openclaw/workspace/state/a2a-log/events"
            )
            already_exists = False
            if os.path.isdir(events_dir):
                for ef in glob.glob(os.path.join(events_dir, "*.jsonl")):
                    try:
                        with open(ef, "r", encoding="utf-8") as fh:
                            for line in fh:
                                line = line.strip()
                                if not line:
                                    continue
                                try:
                                    ev = json.loads(line)
                                    meta = ev.get("meta", {}) or {}
                                    if meta.get("idempotency_key") == idempotency_key:
                                        already_exists = True
                                        break
                                except Exception:
                                    pass
                        if already_exists:
                            break
                    except Exception:
                        pass

            if already_exists:
                sys.stderr.write(
                    f"[hook-a] escalation already exists (key={idempotency_key})\n"
                )
                return

            # Write escalation event (seq assigned atomically by _locked_append_event)
            escalation_event = {
                "specversion": "1.1",
                "seq": None,  # assigned atomically below
                "ts": now_iso(),
                "from": "pipeline-executor",
                "to": ["issac"],
                "topic": topic,
                "type": "task.escalated",
                "event_class": "business",
                "priority": "P0",
                "correlation_id": correlation_id,
                "causation_id": f"seq:{from_agent}:{blocked_event.get('seq', '')}",
                "routing": {
                    "prev": from_agent,
                    "next": "END",
                    "next_task": None,
                    "merge_wait": "none",
                    "cycle": "none",
                    "result_channel": resolve_result_channel(topic),
                },
                "meta": {
                    "idempotency_key": idempotency_key,
                    "attempt": 1,
                    "max_attempts": 3,
                },
                "payload": {
                    "summary": f"🚨 [Hook-A] Pipeline {pl_id} step {current_step} blocked: {reason}",
                    "pipeline_id": pl_id,
                    "step": current_step,
                    "agent": from_agent,
                    "reason": reason,
                    "source": "hook-a-realtime",
                },
                "ttl_hours": 24,
            }
            _locked_append_event("pipeline-executor", escalation_event)
            _hook_notify_recipients_on_write(escalation_event)
            sys.stderr.write(
                f"[hook-a] Escalated {pl_id} step {current_step} → issac\n"
            )
            break  # Only match first pipeline

    except Exception as e:
        sys.stderr.write(f"[hook-a] ERROR: {e}\n")


def _hook_trigger_executor_on_final_step(event: dict, pipeline_id: str) -> None:
    """
    Hook-B: 当最后一步完成/blocked/cancelled 时，立即触发 pipeline-executor run。
    使用 subprocess 异步执行（不阻塞调用方）。
    """
    try:
        executor_script = os.path.expanduser("~/.openclaw/scripts/pipeline-executor.py")
        if not os.path.exists(executor_script):
            return
        # Fire and forget — don't wait for result
        subprocess.Popen(
            [sys.executable, executor_script, "run", "--pipeline", pipeline_id],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        sys.stderr.write(f"[hook-b] Triggered executor run for {pipeline_id}\n")
    except Exception as e:
        sys.stderr.write(f"[hook-b] ERROR: {e}\n")


def _resolve_target_session(agent: str, context_channel_id: str | None = None) -> dict:
    """Resolve target session metadata for Hook-C delivery audit."""
    result = {
        "agent": agent,
        "requested_context_channel_id": context_channel_id,
        "session_key": None,
        "session_id": None,
        "label": None,
        "home_session_key": None,
        "context_session_key": None,
        "resolution_mode": None,
        "fallback_reason": None,
        "no_session_reason": None,
    }

    if routing_resolve_session_key is None or routing_get_session_store_path is None:
        result["resolution_mode"] = "routing_unavailable"
        result["no_session_reason"] = "routing_helpers_unavailable"
        return result

    try:
        if routing_get_home_session_key is not None:
            try:
                result["home_session_key"] = routing_get_home_session_key(agent)
            except Exception:
                result["home_session_key"] = None

        if context_channel_id and routing_get_context_session_key is not None:
            try:
                result["context_session_key"] = routing_get_context_session_key(agent, context_channel_id)
            except Exception:
                result["context_session_key"] = None

        session_key = routing_resolve_session_key(agent, context_channel_id=context_channel_id)
        result["session_key"] = session_key

        if routing_resolve_display_label is not None:
            try:
                result["label"] = routing_resolve_display_label(agent, context_channel_id=context_channel_id, short=True)
            except Exception:
                result["label"] = None

        context_session_key = result.get("context_session_key")
        home_session_key = result.get("home_session_key")
        if context_channel_id and context_session_key and session_key == context_session_key:
            result["resolution_mode"] = "context_match"
        elif session_key and home_session_key and session_key == home_session_key:
            result["resolution_mode"] = "home_fallback"
            result["fallback_reason"] = "context_session_missing" if context_channel_id else "no_context_channel"
        elif session_key:
            result["resolution_mode"] = "resolved"
        else:
            result["resolution_mode"] = "unresolved"
            result["no_session_reason"] = "session_key_unresolved"
            return result

        store_path = routing_get_session_store_path(agent)
        if not store_path or not os.path.exists(store_path):
            result["no_session_reason"] = "session_store_missing"
            return result

        with open(store_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            result["no_session_reason"] = "invalid_session_store"
            return result

        entry = data.get(session_key, {}) or {}
        if not entry:
            result["no_session_reason"] = "session_entry_missing"
            return result

        result["session_id"] = entry.get("sessionId")
        if not result["session_id"]:
            result["no_session_reason"] = "session_id_missing"
        return result
    except Exception as e:
        result["resolution_mode"] = "resolve_error"
        result["no_session_reason"] = "resolver_exception"
        result["error"] = str(e)
        return result


# Hook-C: Event Log write 后立即唤醒下游读取 pending（v2.3）
def _hook_notify_recipients_on_write(event: dict) -> None:
    """After canonical Event Log write, best-effort notify recipients to read pending.

    This is the primary realtime trigger. Heartbeat remains the fallback/patrol layer.
    It does NOT change Event Log as source of truth; it only accelerates consumption.
    """
    try:
        if event.get("event_class") != "business":
            return

        to_agents = [a for a in (event.get("to") or []) if a and a != "END"]
        if not to_agents:
            return

        from_agent = event.get("from", "unknown")
        event_type = event.get("type", "unknown")
        topic = event.get("topic", "unknown")
        routing = event.get("routing", {}) or {}
        context_channel_id = routing.get("origin_context_channel_id") or routing.get("result_channel")

        for target_agent in to_agents:
            resolution = _resolve_target_session(target_agent, context_channel_id=context_channel_id)
            session_key = resolution.get("session_key")
            session_id = resolution.get("session_id")
            label = resolution.get("label")

            # [P0] Skip duplicate wake within TTL — note: mainly protects same-process retries
            if _hook_c_is_duplicate(event, target_agent=target_agent):
                sys.stderr.write(
                    f"[hook-c] DUPLICATE skip {event_type} {from_agent}:{event.get('seq')} "
                    f"→ {target_agent} (within {_HOOK_C_TTL_SECONDS}s)\n"
                )
                _write_hook_c_audit(event, target_agent, "duplicate_skip", resolution=resolution)
                continue

            # [P0 UX fix] task.done/task.blocked/task.cancelled are not visible in `pending`
            # because cmd_pending intentionally filters terminal events. Use `read --topic` instead.
            # task.acked is useful for audit but too noisy as a wake source, so suppress it.
            if event_type in ("task.acked", "task.delivered"):
                # acked: audit trail only, too noisy as a wake source
                # delivered: terminal pipeline event, pipeline already closed, no wake needed
                sys.stderr.write(
                    f"[hook-c] skip wake for {event_type} {from_agent}:{event.get('seq')} → {target_agent} (terminal/noise reduction)\n"
                )
                _write_hook_c_audit(event, target_agent, "terminal_suppressed", resolution=resolution)
                continue

            if event_type in ("task.done", "task.blocked", "task.cancelled"):
                command_hint = f"a2a-log.py read --agent {target_agent} --topic {topic}"
            else:
                command_hint = f"a2a-log.py pending --agent {target_agent}"

            if not session_id:
                sys.stderr.write(
                    f"[hook-c] no sessionId for {target_agent} (session_key={session_key}) — fallback to heartbeat/poll\n"
                )
                _write_hook_c_audit(event, target_agent, "no_session", resolution=resolution, command_hint=command_hint)
                continue

            wake_msg = (
                f"[Event Log Wake] 新 {event_type} from {from_agent} | "
                f"topic: {topic} | 执行 {command_hint}"
            )
            try:
                subprocess.Popen(
                    [
                        "openclaw",
                        "agent",
                        "--session-id",
                        session_id,
                        "--message",
                        wake_msg,
                        "--timeout",
                        "30",
                        "--json",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                )
                _write_hook_c_audit(event, target_agent, "wake_sent", resolution=resolution, command_hint=command_hint)
            except Exception as wake_error:
                _write_hook_c_audit(
                    event,
                    target_agent,
                    "wake_failed",
                    resolution=resolution,
                    command_hint=command_hint,
                    error=str(wake_error),
                )
                raise

            if label:
                sys.stderr.write(
                    f"[hook-c] Wake → {target_agent} [{label}] ({session_key} | sessionId={session_id})\n"
                )
            else:
                sys.stderr.write(
                    f"[hook-c] Wake → {target_agent} ({session_key} | sessionId={session_id})\n"
                )

    except Exception as e:
        sys.stderr.write(f"[hook-c] ERROR: {e}\n")


def _find_existing_by_idempotency(agent: str, idempotency_key: str) -> "dict | None":
    """Scan agent's events file for an event with matching idempotency_key. Returns the event or None."""
    events = read_events_file(agent)
    for ev in events:
        meta = ev.get("meta", {})
        if isinstance(meta, dict) and meta.get("idempotency_key") == idempotency_key:
            return ev
    return None


def cmd_done(args):
    """Mark an event as done: append a task.done event to the done agent's file (v1.1 immutable log)."""
    agent = args.agent          # the agent marking done
    seq = args.seq
    source_file = args.file
    summary = getattr(args, "summary", None)
    review_result = getattr(args, "review_result", None)
    review_scope = getattr(args, "review_scope", None)
    review_summary = getattr(args, "review_summary", None)

    if (review_scope or review_summary) and not review_result:
        print(json.dumps({
            "error": "--review-result is required when --review-scope or --review-summary is provided"
        }))
        sys.exit(1)

    if review_result and review_result not in VALID_REVIEW_RESULTS:
        print(json.dumps({
            "error": f"invalid --review-result: {review_result}"
        }))
        sys.exit(1)

    # Look up the original event to inherit correlation_id
    original = find_event_by_seq(source_file, seq)
    if original is None:
        print(json.dumps({"error": f"seq={seq} not found in events/{source_file}.jsonl"}))
        sys.exit(1)

    # Inherit correlation_id from original (or use override)
    correlation_id = getattr(args, "correlation_id", None) or original.get("correlation_id")
    if not correlation_id:
        correlation_id = f"workflow-{original.get('topic', 'unknown')}-{today_str()}"

    # [R-违规检测] causation_id is mandatory for task.done
    causation_id = f"seq:{source_file}:{seq}"

    # Auto-generate idempotency_key using a temporary seq estimate for dedup check only.
    # The real seq is assigned atomically by _locked_append_event below.
    # We pre-read to build the idempotency key for the duplicate check before acquiring the lock.
    _pre_seq = read_last_seq(agent) + 1
    next_seq = _pre_seq  # will be overwritten after atomic lock
    idempotency_key = f"from-{agent}-seq-{next_seq}-type-task.done"

    # [R-重复防护] Check for duplicate done before writing
    existing = _find_existing_by_idempotency(agent, idempotency_key)
    if existing is not None:
        print(json.dumps({
            "status": "already_exists",
            "seq": existing.get("seq"),
            "file": f"events/{agent}.jsonl",
            "causation_id": causation_id,
            "correlation_id": correlation_id,
            "idempotency_key": idempotency_key,
        }))
        return

    done_payload = {
        "ref_seq": seq,
        "ref_from": source_file,
    }
    if summary:
        done_payload["summary"] = summary
    if review_result:
        done_payload["review_result"] = review_result
        if review_scope:
            done_payload["review_scope"] = review_scope
        if review_summary:
            done_payload["review_summary"] = review_summary

    done_event = {
        "specversion": "1.1",
        "seq": None,  # assigned atomically by _locked_append_event
        "ts": now_iso(),
        "from": agent,
        "to": [source_file],
        "topic": original.get("topic", "unknown"),
        "type": "task.done",
        "event_class": "business",
        "priority": original.get("priority", "P1"),
        "correlation_id": correlation_id,
        "causation_id": causation_id,
        "routing": _inherit_routing_fields(original),
        "meta": {
            "idempotency_key": idempotency_key,
            "attempt": 1,
            "max_attempts": 3,
        },
        "payload": done_payload,
        "ttl_hours": 24,
    }

    # Atomically assign seq and append to the done agent's file (NOT the source file — immutable log)
    next_seq = _locked_append_event(agent, done_event)
    _hook_notify_recipients_on_write(done_event)

    # [v2.1 第一层防线] 写入 Event Log 之后，自动同步 pipeline（失败静默）
    _pipeline_sync_on_done(done_event)

    print(json.dumps({
        "status": "done",
        "seq": next_seq,
        "file": f"events/{agent}.jsonl",
        "causation_id": causation_id,
        "correlation_id": correlation_id,
        "idempotency_key": idempotency_key,
    }))


def cmd_blocked(args):
    """Mark an event as blocked: append a task.blocked event to the agent's file (v1.1 immutable log)."""
    agent = args.agent          # the agent reporting blocked
    seq = args.seq
    source_file = args.file
    reason = args.reason

    # Look up the original event to inherit correlation_id
    original = find_event_by_seq(source_file, seq)
    if original is None:
        print(json.dumps({"error": f"seq={seq} not found in events/{source_file}.jsonl"}))
        sys.exit(1)

    # Inherit correlation_id from original (or use override)
    correlation_id = getattr(args, "correlation_id", None) or original.get("correlation_id")
    if not correlation_id:
        correlation_id = f"workflow-{original.get('topic', 'unknown')}-{today_str()}"

    causation_id = f"seq:{source_file}:{seq}"
    _pre_seq = read_last_seq(agent) + 1
    next_seq = _pre_seq  # will be overwritten after atomic lock
    idempotency_key = f"from-{agent}-seq-{next_seq}-type-task.blocked"

    blocked_payload = {
        "ref_seq": seq,
        "ref_from": source_file,
        "reason": reason,
    }

    blocked_event = {
        "specversion": "1.1",
        "seq": None,  # assigned atomically by _locked_append_event
        "ts": now_iso(),
        "from": agent,
        "to": [source_file],
        "topic": original.get("topic", "unknown"),
        "type": "task.blocked",
        "event_class": "business",
        "priority": original.get("priority", "P1"),
        "correlation_id": correlation_id,
        "causation_id": causation_id,
        "routing": _inherit_routing_fields(original),
        "meta": {
            "idempotency_key": idempotency_key,
            "attempt": 1,
            "max_attempts": 3,
        },
        "payload": blocked_payload,
        "ttl_hours": 24,
    }

    # Atomically assign seq and append to the agent's file (immutable log)
    next_seq = _locked_append_event(agent, blocked_event)
    _hook_notify_recipients_on_write(blocked_event)

    # [v2.1 第一层防线] 自动同步 pipeline（失败静默）
    _pipeline_sync_on_blocked(blocked_event)
    # [v2.2 Hook-A] blocked 后立即 escalate（失败静默）
    _hook_escalate_on_blocked(blocked_event)

    print(json.dumps({
        "status": "blocked",
        "seq": next_seq,
        "file": f"events/{agent}.jsonl",
        "causation_id": causation_id,
        "correlation_id": correlation_id,
        "idempotency_key": idempotency_key,
        "reason": reason,
    }))


def cmd_cancelled(args):
    """Mark an event as cancelled: append a task.cancelled event to the agent's file (v1.1 immutable log)."""
    agent = args.agent          # the agent reporting cancellation
    seq = args.seq
    source_file = args.file
    reason = getattr(args, "reason", None)

    # Look up the original event to inherit correlation_id
    original = find_event_by_seq(source_file, seq)
    if original is None:
        print(json.dumps({"error": f"seq={seq} not found in events/{source_file}.jsonl"}))
        sys.exit(1)

    # Inherit correlation_id from original (or use override)
    correlation_id = getattr(args, "correlation_id", None) or original.get("correlation_id")
    if not correlation_id:
        correlation_id = f"workflow-{original.get('topic', 'unknown')}-{today_str()}"

    causation_id = f"seq:{source_file}:{seq}"
    _pre_seq = read_last_seq(agent) + 1
    next_seq = _pre_seq  # will be overwritten after atomic lock
    idempotency_key = f"from-{agent}-seq-{next_seq}-type-task.cancelled"

    cancelled_payload = {
        "ref_seq": seq,
        "ref_from": source_file,
    }
    if reason:
        cancelled_payload["reason"] = reason

    cancelled_event = {
        "specversion": "1.1",
        "seq": None,  # assigned atomically by _locked_append_event
        "ts": now_iso(),
        "from": agent,
        "to": [source_file],
        "topic": original.get("topic", "unknown"),
        "type": "task.cancelled",
        "event_class": "business",
        "priority": original.get("priority", "P1"),
        "correlation_id": correlation_id,
        "causation_id": causation_id,
        "routing": _inherit_routing_fields(original),
        "meta": {
            "idempotency_key": idempotency_key,
            "attempt": 1,
            "max_attempts": 3,
        },
        "payload": cancelled_payload,
        "ttl_hours": 24,
    }

    # Atomically assign seq and append to the agent's file (immutable log)
    next_seq = _locked_append_event(agent, cancelled_event)
    _hook_notify_recipients_on_write(cancelled_event)

    # [v2.1 第一层防线] 自动同步 pipeline（失败静默）
    _pipeline_sync_on_cancelled(cancelled_event)

    print(json.dumps({
        "status": "cancelled",
        "seq": next_seq,
        "file": f"events/{agent}.jsonl",
        "causation_id": causation_id,
        "correlation_id": correlation_id,
        "idempotency_key": idempotency_key,
    }))


def cmd_pending(args):
    """Pending projection: business events addressed to --agent with no task.done/task.acked in chain."""
    agent = args.agent
    topic_filter = getattr(args, "topic", None)
    limit = getattr(args, "limit", 20) or 20

    # Collect all events from all agent files
    all_events = []
    agent_files = all_agent_files()
    for source_agent in agent_files:
        evs = read_events_file(source_agent)
        all_events.extend(evs)

    # Step 1: Build set of resolved event keys.
    resolved_keys = _resolved_event_keys(all_events)

    # Step 2: Filter to business events addressed to agent that are NOT yet resolved
    pending = []
    for ev in all_events:
        if agent not in ev.get("to", []):
            continue
        ev_type = ev.get("type", "")
        # Skip control events — only show business events
        if ev_type in ("task.done", "task.acked", "task.failed", "info.sync_done"):
            continue
        # Check if this event's source is resolved
        ev_from = ev.get("from", "")
        ev_seq = ev.get("seq", "")
        if ev_from and ev_seq and f"{ev_from}:{ev_seq}" in resolved_keys:
            continue
        pending.append(ev)

    # Optional topic filter
    if topic_filter:
        pending = [ev for ev in pending if ev.get("topic") == topic_filter]

    # Sort ascending by ts
    pending.sort(key=lambda ev: ev.get("ts", ""))

    # Apply limit
    pending = pending[:limit]

    # Update cursor
    cursor_updates = {}
    for ev in pending:
        src = ev.get("_source_file", ev.get("from", "unknown"))
        seq = ev.get("seq", 0)
        if seq > cursor_updates.get(src, 0):
            cursor_updates[src] = seq
    for src_file, max_seq in cursor_updates.items():
        update_cursor(agent, src_file, max_seq)

    output = [{k: v for k, v in ev.items() if k != "_source_file"} for ev in pending]
    print(json.dumps({
        "agent": agent,
        "events": output,
        "count": len(output),
    }, ensure_ascii=False, indent=2))


def cmd_compensate_dispatches(args):
    """Retry stale task.dispatch wake or escalate after repeated Hook-C failures."""
    target_agent = getattr(args, "agent", None)
    topic_filter = getattr(args, "topic", None)
    stale_minutes = getattr(args, "stale_minutes", 10)
    limit = getattr(args, "limit", 20)
    max_retries = getattr(args, "max_retries", 3)
    dry_run = bool(getattr(args, "dry_run", False))

    all_events = []
    for source_agent in all_agent_files():
        all_events.extend(read_events_file(source_agent))
    resolved_keys = _resolved_event_keys(all_events)
    audit_records = _load_hook_c_audit_records()
    tz_cst = timezone(timedelta(hours=8))
    now_dt = datetime.now(tz_cst)

    candidates = []
    actions = []

    for ev in all_events:
        if ev.get("type") != "task.dispatch":
            continue
        if topic_filter and ev.get("topic") != topic_filter:
            continue
        ev_from = ev.get("from", "")
        ev_seq = ev.get("seq", "")
        if ev_from and ev_seq and f"{ev_from}:{ev_seq}" in resolved_keys:
            continue
        ev_dt = parse_iso(ev.get("ts", ""))
        if not ev_dt:
            continue
        age_minutes = (now_dt - ev_dt.astimezone(tz_cst)).total_seconds() / 60
        if age_minutes < stale_minutes:
            continue

        for to_agent in ev.get("to", []) or []:
            if not to_agent or to_agent == "END":
                continue
            if target_agent and to_agent != target_agent:
                continue

            attempts = _hook_c_attempts_for_event(ev, to_agent, audit_records)
            last_outcome = attempts[-1].get("outcome") if attempts else None
            candidate = {
                "from": ev_from,
                "seq": ev_seq,
                "target_agent": to_agent,
                "topic": ev.get("topic"),
                "correlation_id": ev.get("correlation_id"),
                "age_minutes": round(age_minutes, 1),
                "attempts": len(attempts),
                "last_outcome": last_outcome,
            }
            candidates.append((candidate, ev))
            if len(candidates) >= limit:
                break
        if len(candidates) >= limit:
            break

    for candidate, event in candidates:
        retryable = candidate["last_outcome"] in (None, "no_session", "wake_failed", "duplicate_skip")
        if candidate["attempts"] >= max_retries and candidate["last_outcome"] in ("no_session", "wake_failed"):
            reason = f"dispatch stale > {stale_minutes}m and Hook-C failed {candidate['attempts']} times"
            result = _append_escalation_for_compensation(
                event,
                candidate["target_agent"],
                candidate["attempts"],
                reason,
                dry_run=dry_run,
            )
            actions.append({**candidate, "action": "escalate", "result": result})
        elif retryable:
            if dry_run:
                actions.append({**candidate, "action": "retry_wake", "result": {"status": "dry_run_retry"}})
            else:
                _hook_notify_recipients_on_write(event)
                actions.append({**candidate, "action": "retry_wake", "result": {"status": "retried"}})

    print(json.dumps({
        "status": "ok",
        "stale_minutes": stale_minutes,
        "max_retries": max_retries,
        "candidate_count": len(candidates),
        "action_count": len(actions),
        "actions": actions,
    }, ensure_ascii=False, indent=2))

# ── Argument parsing ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="A2A Event Log CLI v1.1 — shared inter-agent communication store"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # ── write ──
    p_write = subparsers.add_parser("write", help="Write an event to the log (v1.1)")
    p_write.add_argument("--from", dest="frm", required=True, help="Sender agent ID")
    p_write.add_argument("--to", required=True, help="Recipient agent(s), comma-separated")
    p_write.add_argument("--topic", required=True, help="Topic identifier (e.g. proj-012-dashboard)")
    p_write.add_argument("--type", required=True, help="Event type (e.g. task.dispatch)")
    p_write.add_argument("--payload", default="{}", help="JSON payload string")
    p_write.add_argument("--prev", default=None, help="Previous node in DAG routing")
    p_write.add_argument("--next", default="END", help="Next node in DAG routing (default: END)")
    p_write.add_argument("--next-task", dest="next_task", default=None, help="Description of next task")
    p_write.add_argument("--merge-wait", dest="merge_wait", default="none",
                         choices=["none", "all", "any"], help="Merge-wait strategy")
    p_write.add_argument("--cycle", default="none", help="Cycle indicator (e.g. 0/3 or none)")
    p_write.add_argument("--ttl-hours", dest="ttl_hours", type=int, default=24,
                         help="TTL in hours before auto-escalation (default: 24)")
    # v1.1 new fields
    p_write.add_argument("--specversion", default="1.1", help="Spec version (default: 1.1)")
    p_write.add_argument("--correlation-id", dest="correlation_id", default=None,
                         help="Workflow correlation ID (auto-generated if not provided)")
    p_write.add_argument("--causation-id", dest="causation_id", default=None,
                         help="Causation ID pointing to upstream event (format: seq:{agent}:{seq})")
    p_write.add_argument("--priority", default="P1", choices=["P0", "P1", "P2"],
                         help="Priority level (default: P1)")
    p_write.add_argument("--event-class", dest="event_class", default=None,
                         choices=["business", "control"],
                         help="Event class (auto-inferred from type if not set)")
    p_write.add_argument("--idempotency-key", dest="idempotency_key", default=None,
                         help="Idempotency key for deduplication")
    p_write.add_argument("--result-channel", dest="result_channel", default=None,
                         help="Explicit result delivery channel/thread id (overrides topic routing)")
    p_write.add_argument("--origin-context-channel-id", dest="origin_context_channel_id", default=None,
                         help="Origin Discord channel/thread id where this task was started")
    p_write.add_argument("--closeout-policy", dest="closeout_policy", default=None,
                         choices=sorted(VALID_CLOSEOUT_POLICIES),
                         help="Closeout policy (default: business=optional, control=none)")
    p_write.add_argument("--attempt", type=int, default=1,
                         help="Attempt number (default: 1)")
    p_write.add_argument("--max-attempts", dest="max_attempts", type=int, default=3,
                         help="Max attempts (default: 3)")
    p_write.add_argument("--dry-run", dest="dry_run", action="store_true",
                         help="Print event without writing")

    # ── read ──
    p_read = subparsers.add_parser("read", help="Read events addressed to an agent")
    p_read.add_argument("--agent", required=True, help="Agent ID to read events for")
    p_read.add_argument("--topic", default=None, help="Filter by topic")
    p_read.add_argument("--status", default=None,
                        help="Filter by status (v1.0 compat; v1.1 events use projection)")
    p_read.add_argument("--limit", type=int, default=20, help="Max events to return (default: 20)")

    # ── ack ──
    p_ack = subparsers.add_parser("ack", help="Acknowledge an event (appends task.acked to agent's file)")
    p_ack.add_argument("--agent", required=True, help="Agent doing the ACK")
    p_ack.add_argument("--seq", required=True, type=int, help="Event seq number in source file")
    p_ack.add_argument("--file", required=True, help="Source agent file name (without .jsonl)")
    p_ack.add_argument("--correlation-id", dest="correlation_id", default=None,
                       help="Override correlation ID (default: inherited from original event)")

    # ── done ──
    p_done = subparsers.add_parser("done", help="Mark an event as done (appends task.done to agent's file)")
    p_done.add_argument("--agent", required=True, help="Agent marking done")
    p_done.add_argument("--seq", required=True, type=int, help="Event seq number in source file")
    p_done.add_argument("--file", required=True, help="Source agent file name (without .jsonl)")
    p_done.add_argument("--summary", default=None, help="Optional completion summary")
    p_done.add_argument("--review-result", dest="review_result", default=None,
                        choices=sorted(VALID_REVIEW_RESULTS),
                        help="Optional structured review result")
    p_done.add_argument("--review-scope", dest="review_scope", default=None,
                        help="Optional structured review scope (e.g. code|sit|security)")
    p_done.add_argument("--review-summary", dest="review_summary", default=None,
                        help="Optional structured review summary")
    p_done.add_argument("--correlation-id", dest="correlation_id", default=None,
                        help="Override correlation ID (default: inherited from original event)")

    # ── pending ──
    p_pending = subparsers.add_parser("pending", help="List pending events for an agent")
    p_pending.add_argument("--agent", required=True, help="Agent ID")
    p_pending.add_argument("--topic", default=None, help="Filter by topic")
    p_pending.add_argument("--limit", type=int, default=20, help="Max events to return")

    # ── blocked ──
    p_blocked = subparsers.add_parser("blocked", help="Mark an event as blocked (appends task.blocked to agent's file)")
    p_blocked.add_argument("--agent", required=True, help="Agent reporting the block")
    p_blocked.add_argument("--seq", required=True, type=int, help="Event seq number in source file")
    p_blocked.add_argument("--file", required=True, help="Source agent file name (without .jsonl)")
    p_blocked.add_argument("--reason", required=True, help="Reason for being blocked")
    p_blocked.add_argument("--correlation-id", dest="correlation_id", default=None,
                           help="Override correlation ID (default: inherited from original event)")

    # ── cancelled ──
    p_cancelled = subparsers.add_parser("cancelled", help="Mark an event as cancelled (appends task.cancelled to agent's file)")
    p_cancelled.add_argument("--agent", required=True, help="Agent reporting the cancellation")
    p_cancelled.add_argument("--seq", required=True, type=int, help="Event seq number in source file")
    p_cancelled.add_argument("--file", required=True, help="Source agent file name (without .jsonl)")
    p_cancelled.add_argument("--reason", default=None, help="Optional reason for cancellation")
    p_cancelled.add_argument("--correlation-id", dest="correlation_id", default=None,
                             help="Override correlation ID (default: inherited from original event)")

    # ── compensate-dispatches ──
    p_comp = subparsers.add_parser("compensate-dispatches", help="Retry stale task.dispatch wake or escalate after repeated Hook-C failures")
    p_comp.add_argument("--agent", default=None, help="Only compensate dispatches targeting this agent")
    p_comp.add_argument("--topic", default=None, help="Optional topic filter")
    p_comp.add_argument("--stale-minutes", dest="stale_minutes", type=int, default=10, help="Only consider dispatches older than N minutes")
    p_comp.add_argument("--max-retries", dest="max_retries", type=int, default=3, help="Escalate after N failed wake/no_session attempts")
    p_comp.add_argument("--limit", type=int, default=20, help="Max stale dispatches to process")
    p_comp.add_argument("--dry-run", action="store_true", help="Report candidate actions without writing events or retrying wake")

    args = parser.parse_args()

    dispatch = {
        "write":     cmd_write,
        "read":      cmd_read,
        "ack":       cmd_ack,
        "done":      cmd_done,
        "pending":   cmd_pending,
        "blocked":   cmd_blocked,
        "cancelled": cmd_cancelled,
        "compensate-dispatches": cmd_compensate_dispatches,
    }

    fn = dispatch.get(args.command)
    if fn:
        fn(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
