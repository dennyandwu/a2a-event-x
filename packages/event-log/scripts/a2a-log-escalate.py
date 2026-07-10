#!/usr/bin/env python3
"""
a2a-log-escalate.py — TTL Escalation for A2A Event Log v1.1
Scans all events/*.jsonl for v1.1 events without acked/done projection that have
exceeded their ttl_hours. Appends a task.escalated event to events/system.jsonl
(immutable log — does NOT modify original events).

For v1.0 events (specversion missing or '1.0'), falls back to legacy status-check.

Standard library only; no external dependencies.

Usage:
  python3 ~/.openclaw/scripts/a2a-log-escalate.py [--dry-run]
"""

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone, timedelta

BASE_DIR = os.path.expanduser("~/.openclaw/workspace/state/a2a-log")
EVENTS_DIR = os.path.join(BASE_DIR, "events")
# Target file for escalation events
SYSTEM_EVENTS_FILE = os.path.join(EVENTS_DIR, "system.jsonl")


def now_iso() -> str:
    tz_cst = timezone(timedelta(hours=8))
    return datetime.now(tz_cst).isoformat(timespec="seconds")


def today_str() -> str:
    tz_cst = timezone(timedelta(hours=8))
    return datetime.now(tz_cst).strftime("%Y%m%d")


def parse_ts(ts_str: str):
    """Parse ISO 8601 timestamp, return datetime (UTC-aware)."""
    if not ts_str:
        return None
    try:
        ts_str_clean = ts_str.replace("Z", "+00:00")
        return datetime.fromisoformat(ts_str_clean)
    except ValueError:
        return None


def read_events_file(fpath: str) -> list:
    """Read all valid JSON lines from a file."""
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
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError as e:
        sys.stderr.write(f"[escalate] warning: cannot read {fpath}: {e}\n")
    return events


def read_last_seq_from_file(fpath: str) -> int:
    """Read the last seq number from any events file."""
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


def append_to_file(fpath: str, event: dict) -> None:
    """Append a single event to a file."""
    os.makedirs(os.path.dirname(fpath), exist_ok=True)
    with open(fpath, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def write_events_file(fpath: str, events: list) -> None:
    """Overwrite file with events list (legacy v1.0 path only)."""
    with open(fpath, "w", encoding="utf-8") as f:
        for ev in events:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")


def build_projection(events_dir: str) -> dict:
    """
    Build a projection of acknowledged/done events.
    Returns a dict: causation_id → latest event type
    Key format: "seq:{agent}:{seq}"
    """
    projection = {}
    try:
        files = glob.glob(os.path.join(events_dir, "*.jsonl"))
        for fpath in files:
            for ev in read_events_file(fpath):
                causation = ev.get("causation_id")
                if causation and ev.get("type") in ("task.acked", "task.done", "task.escalated", "task.cancelled"):
                    projection[causation] = ev.get("type")
    except Exception:
        pass
    return projection


def main():
    parser = argparse.ArgumentParser(
        description="A2A TTL Escalation v1.1 — appends task.escalated events for expired tasks"
    )
    parser.add_argument(
        "--dry-run",
        dest="dry_run",
        action="store_true",
        help="Report without modifying files",
    )
    args = parser.parse_args()
    dry_run = args.dry_run

    now = datetime.now(timezone.utc)
    pattern = os.path.join(EVENTS_DIR, "*.jsonl")
    files = glob.glob(pattern)

    if not files:
        print(json.dumps({"escalated": 0, "dry_run": dry_run, "message": "No event files found"}))
        return

    # Build projection to check which events already have acked/done/escalated
    projection = build_projection(EVENTS_DIR)

    total_escalated = 0
    details = []

    # Track next seq for system.jsonl escalation events
    system_seq = read_last_seq_from_file(SYSTEM_EVENTS_FILE)

    for fpath in sorted(files):
        agent_name = os.path.splitext(os.path.basename(fpath))[0]
        # Skip system.jsonl itself — don't scan escalation events for re-escalation
        if agent_name == "system":
            continue

        events = read_events_file(fpath)

        for ev in events:
            spec_version = ev.get("specversion", "1.0")
            event_type = ev.get("type", "")

            # Only process task.dispatch events (source events that require ack/done)
            if event_type not in ("task.dispatch", "task.blocked", "task.retry"):
                # v1.0 compat: also check pending status field
                if spec_version == "1.0" and ev.get("status") != "pending":
                    continue
                elif spec_version != "1.0":
                    continue

            ts_str = ev.get("ts")
            ttl_hours = ev.get("ttl_hours", 24)

            if not ts_str:
                continue

            event_ts = parse_ts(ts_str)
            if event_ts is None:
                continue

            # Ensure event_ts is timezone-aware
            if event_ts.tzinfo is None:
                event_ts = event_ts.replace(tzinfo=timezone.utc)

            elapsed_seconds = (now - event_ts).total_seconds()
            ttl_seconds = ttl_hours * 3600

            if elapsed_seconds <= ttl_seconds:
                continue

            seq = ev.get("seq")
            topic = ev.get("topic", "unknown")
            elapsed_hours = elapsed_seconds / 3600

            # Check projection: skip if already acked/done/escalated
            causation_key = f"seq:{agent_name}:{seq}"
            if projection.get(causation_key) in ("task.acked", "task.done", "task.escalated", "task.cancelled"):
                continue

            details.append({
                "file": os.path.basename(fpath),
                "seq": seq,
                "topic": topic,
                "from": ev.get("from"),
                "to": ev.get("to"),
                "ts": ts_str,
                "ttl_hours": ttl_hours,
                "elapsed_hours": round(elapsed_hours, 2),
                "causation_id": causation_key,
            })

            if not dry_run:
                # v1.1: Append task.escalated to system.jsonl (immutable log)
                system_seq += 1
                correlation_id = ev.get("correlation_id") or f"workflow-{topic}-{today_str()}"

                escalated_event = {
                    "specversion": "1.1",
                    "seq": system_seq,
                    "ts": now_iso(),
                    "from": "system",
                    "to": ["issac"],  # notify PMO
                    "topic": topic,
                    "type": "task.escalated",
                    "event_class": "business",
                    "priority": ev.get("priority", "P1"),
                    "correlation_id": correlation_id,
                    "causation_id": causation_key,
                    "routing": {
                        "prev": agent_name,
                        "next": "issac",
                        "next_task": "escalation review",
                        "merge_wait": "none",
                        "cycle": "none",
                        "result_channel": "993271843777691700",
                    },
                    "meta": {
                        "idempotency_key": f"escalate-{causation_key}-{today_str()}",
                        "attempt": 1,
                        "max_attempts": 1,
                    },
                    "payload": {
                        "ref_seq": seq,
                        "ref_from": agent_name,
                        "elapsed_hours": round(elapsed_hours, 2),
                        "ttl_hours": ttl_hours,
                        "original_type": event_type,
                    },
                    "ttl_hours": 24,
                }

                append_to_file(SYSTEM_EVENTS_FILE, escalated_event)
                # Update projection to avoid double-escalation in same run
                projection[causation_key] = "task.escalated"

            total_escalated += 1

    result = {
        "escalated": total_escalated,
        "dry_run": dry_run,
        "scanned_files": len(files),
        "escalation_target": "events/system.jsonl",
        "details": details,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
