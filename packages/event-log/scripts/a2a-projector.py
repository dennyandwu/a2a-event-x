#!/usr/bin/env python3
"""
a2a-projector.py — A2A Event Projector (Event Sourcing → Snapshot Rebuild)

Reads all events from a2a-events.jsonl (and archives) and rebuilds the task
snapshot dictionary. Backward-compatible: tasks with no events are preserved
as-is from the existing a2a-tasks.json.

Usage:
  python3 a2a-projector.py                         # print rebuilt snapshot to stdout
  python3 a2a-projector.py --output /path/to.json  # write to file
  python3 a2a-projector.py --verify                # compare with existing a2a-tasks.json
  python3 a2a-projector.py --dry-run               # print without writing
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ─── Paths ─────────────────────────────────────────────────────────────────────
HOME = Path.home()
EVENTS_FILE   = HOME / ".openclaw" / "workspace" / "state" / "patrol" / "a2a-events.jsonl"
ARCHIVE_DIR   = HOME / ".openclaw" / "workspace" / "state" / "patrol" / "a2a-events-archive"
TASKS_FILE    = HOME / ".openclaw" / "workspace" / "state" / "patrol" / "a2a-tasks.json"

# ─── Status priority (higher index = higher priority) ──────────────────────────
STATUS_PRIORITY = {
    "created": 0,
    "acked": 1,
    "in_progress": 2,
    "done": 3,
    "blocked": 4,
    "escalated": 5,
    "result_notified": 6,
}

def _status_rank(status: str) -> int:
    return STATUS_PRIORITY.get(status, -1)


# ─── Event loading ─────────────────────────────────────────────────────────────

def _load_archive_events() -> list:
    """Load all events from archive files in chronological order."""
    events = []
    if not ARCHIVE_DIR.exists():
        return events

    # Sort archive files by name (YYYY-MM.jsonl → chronological)
    archive_files = sorted(ARCHIVE_DIR.glob("*.jsonl"))
    for archive_file in archive_files:
        events.extend(_read_jsonl(archive_file))

    return events


def _read_jsonl(path: Path) -> list:
    """Read all valid JSON lines from a .jsonl file."""
    events = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for lineno, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError as e:
                    print(f"[projector] Warning: invalid JSON on line {lineno} of {path}: {e}", file=sys.stderr)
    except OSError:
        pass  # file not found → return empty
    return events


def load_all_events(events_file: Path = None) -> list:
    """Load all events: archives first, then current events file, sorted by ts."""
    target = events_file or EVENTS_FILE
    all_events = _load_archive_events() + _read_jsonl(target)
    # Sort by ts (ascending = chronological)
    all_events.sort(key=lambda e: e.get("ts", 0))
    return all_events


# ─── Projection ────────────────────────────────────────────────────────────────

def _ts_to_iso(ts_ms: int) -> str:
    """Convert Unix milliseconds to ISO 8601 string with +08:00 offset."""
    tz_cst = timezone(timedelta(hours=8))
    try:
        dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=tz_cst)
        return dt.strftime("%Y-%m-%dT%H:%M:%S+08:00")
    except (OSError, OverflowError, ValueError):
        return None


def project_events(events: list) -> dict:
    """
    Apply events in order to build task snapshot dict.

    Returns:
        dict: { taskId: { ...fields } }

    State machine transitions:
        task.created       → initialize fields from payload
        task.acked         → ack_received=true, ack_received_at=ts
        task.in_progress   → status=in_progress
        task.done          → completed_at=ts, result_summary=payload.summary, status=done
        task.blocked       → status=blocked, blocking_reason=payload.reason
        task.escalated     → escalation_count += 1, last_reminder_at=ts
        task.result_notified → result_notified=true, result_notified_at=ts
    """
    snapshot = {}

    for evt in events:
        evt_type = evt.get("type", "")
        task_id  = evt.get("taskId", "")
        ts_ms    = evt.get("ts", 0)
        by       = evt.get("by", "")
        payload  = evt.get("payload", {}) or {}

        if not task_id:
            continue

        # Ensure task entry exists
        if task_id not in snapshot:
            snapshot[task_id] = {
                "from": None,
                "to": None,
                "task": None,
                "dispatched_at": None,
                "type": "a2a_dispatch",
                "ack_status": "none",
                "session_key": None,
                "resolved_session_key": None,
                "origin_context_channel_id": None,
                "result_channel": None,
                "completed_at": None,
                "result_notified": False,
                "result_notified_at": None,
                "result_summary": None,
                "ack_received": False,
                "ack_received_at": None,
                "escalation_count": 0,
                "last_reminder_at": None,
                "status": "created",
                "blocking_reason": None,
                "_from_events": True,
            }

        task = snapshot[task_id]

        if evt_type == "task.created":
            # Initialize core fields from payload
            task["from"]         = payload.get("from", task["from"])
            task["to"]           = payload.get("to", task["to"])
            task["task"]         = payload.get("task", task["task"])
            task["dispatched_at"]= _ts_to_iso(ts_ms) if not task["dispatched_at"] else task["dispatched_at"]
            task["priority"]     = payload.get("priority", task.get("priority"))
            task["prev"]         = payload.get("prev", task.get("prev"))
            task["next"]         = payload.get("next", task.get("next"))
            task["next_task"]    = payload.get("next_task", task.get("next_task"))
            task["session_key"]  = payload.get("session_key", task["session_key"])
            task["resolved_session_key"] = payload.get("resolved_session_key", task.get("resolved_session_key"))
            task["origin_context_channel_id"] = payload.get("origin_context_channel_id", task.get("origin_context_channel_id"))
            task["result_channel"] = payload.get("result_channel", task.get("result_channel"))
            task["status"]       = "created"
            task["ack_status"]   = "none"

        elif evt_type == "task.acked":
            task["ack_received"]    = True
            task["ack_received_at"] = _ts_to_iso(ts_ms)
            task["ack_status"]      = "acked"

        elif evt_type == "task.in_progress":
            task["status"] = "in_progress"

        elif evt_type == "task.done":
            task["completed_at"]    = _ts_to_iso(ts_ms)
            task["result_summary"]  = payload.get("summary", task.get("result_summary"))
            task["status"]          = "done"

        elif evt_type == "task.blocked":
            task["status"]          = "blocked"
            task["blocking_reason"] = payload.get("reason", task.get("blocking_reason"))

        elif evt_type == "task.escalated":
            task["escalation_count"] = (task.get("escalation_count") or 0) + 1
            task["last_reminder_at"] = _ts_to_iso(ts_ms)

        elif evt_type == "task.result_notified":
            task["result_notified"]    = True
            task["result_notified_at"] = _ts_to_iso(ts_ms)

    return snapshot


# ─── Merge with baseline ───────────────────────────────────────────────────────

def load_baseline_tasks() -> dict:
    """Load existing a2a-tasks.json as backward-compat baseline."""
    try:
        with open(TASKS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("data", {}).get("tasks", {})
    except (OSError, json.JSONDecodeError):
        return {}


def merge_with_baseline(projected: dict, baseline: dict) -> dict:
    """
    Merge projected snapshot with baseline.
    - Tasks with event history: use projected version
    - Tasks without event history: preserve baseline as-is
    - Tasks in both: projected takes precedence for event-driven fields
    """
    merged = {}

    # Start with all baseline tasks
    for task_id, task in baseline.items():
        merged[task_id] = dict(task)

    # Apply projected tasks on top
    for task_id, task in projected.items():
        if task_id in merged:
            # Merge: projected fields override baseline for known event-driven fields
            base = dict(merged[task_id])
            # Only update fields that events actually set
            evt_driven_fields = [
                "ack_received", "ack_received_at", "ack_status",
                "completed_at", "result_summary", "result_notified", "result_notified_at",
                "status", "blocking_reason", "escalation_count", "last_reminder_at",
            ]
            for field in evt_driven_fields:
                if field in task and task[field] is not None:
                    base[field] = task[field]
            # Also update create-time fields if they were None in baseline
            for field in ["from", "to", "task", "dispatched_at", "priority", "prev", "next", "next_task"]:
                if field in task and task[field] is not None and base.get(field) is None:
                    base[field] = task[field]
            merged[task_id] = base
        else:
            # New task only in events → add to merged (strip internal marker)
            new_task = {k: v for k, v in task.items() if k != "_from_events"}
            merged[task_id] = new_task

    return merged


# ─── Verification ──────────────────────────────────────────────────────────────

def _diff_tasks(projected: dict, existing: dict) -> list:
    """
    Compare projected snapshot with existing a2a-tasks.json tasks.
    Returns list of diff entries describing discrepancies.
    """
    diffs = []

    all_keys = set(projected.keys()) | set(existing.keys())

    for task_id in sorted(all_keys):
        proj_task = projected.get(task_id)
        exist_task = existing.get(task_id)

        if proj_task is None:
            diffs.append({
                "taskId": task_id,
                "issue": "only_in_existing",
                "detail": "Task exists in a2a-tasks.json but has no events",
            })
            continue

        if exist_task is None:
            diffs.append({
                "taskId": task_id,
                "issue": "only_in_events",
                "detail": "Task has events but not in a2a-tasks.json",
            })
            continue

        # Both exist: compare key fields
        compare_fields = [
            "from", "to", "task", "completed_at", "result_notified",
            "result_summary", "ack_received", "ack_received_at",
            "status", "blocking_reason", "escalation_count",
        ]
        for field in compare_fields:
            pval = proj_task.get(field)
            eval_ = exist_task.get(field)
            # Normalize None and missing
            if pval != eval_:
                diffs.append({
                    "taskId": task_id,
                    "field": field,
                    "issue": "mismatch",
                    "projected": pval,
                    "existing": eval_,
                })

    return diffs


# ─── Main ──────────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    tz_cst = timezone(timedelta(hours=8))
    return datetime.now(tz_cst).strftime("%Y-%m-%dT%H:%M:%S+08:00")


def main():
    parser = argparse.ArgumentParser(
        description="A2A Event Projector — rebuild snapshot from event log"
    )
    parser.add_argument(
        "--output", default=None,
        help="Output file path (default: stdout)"
    )
    parser.add_argument(
        "--verify", action="store_true",
        help="Compare projected snapshot with existing a2a-tasks.json"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print output but do not write to file"
    )
    parser.add_argument(
        "--events-file", dest="events_file", default=None,
        help=f"Override events file path (default: {EVENTS_FILE})"
    )

    args = parser.parse_args()

    # Load and project events
    custom_events_file = Path(args.events_file) if args.events_file else None
    events = load_all_events(custom_events_file)
    projected = project_events(events)

    # Merge with baseline for backward-compat
    baseline = load_baseline_tasks()
    merged = merge_with_baseline(projected, baseline)

    # Build output structure (same format as a2a-tasks.json)
    output_data = {
        "updatedAt": _now_iso(),
        "updatedBy": "a2a-projector",
        "version": 1,
        "data": {
            "tasks": merged,
        },
        "_projector_meta": {
            "events_processed": len(events),
            "tasks_from_events": len(projected),
            "tasks_from_baseline": len(baseline),
            "tasks_total": len(merged),
        },
    }

    # Verification mode
    if args.verify:
        print(f"[projector] Events processed: {len(events)}", file=sys.stderr)
        print(f"[projector] Tasks in events:  {len(projected)}", file=sys.stderr)
        print(f"[projector] Tasks in baseline: {len(baseline)}", file=sys.stderr)
        print(f"[projector] Tasks in merged:   {len(merged)}", file=sys.stderr)

        diffs = _diff_tasks(merged, baseline)
        if not diffs:
            print("[projector] ✅ Snapshot is consistent with event log (no diffs)")
        else:
            print(f"[projector] ⚠️  Found {len(diffs)} diff(s):")
            for d in diffs:
                print(f"  [{d['taskId']}] {d['issue']}", end="")
                if d.get("field"):
                    print(f" field={d['field']} projected={d.get('projected')!r} existing={d.get('existing')!r}", end="")
                if d.get("detail"):
                    print(f" — {d['detail']}", end="")
                print()

        # Also print summary JSON
        print(json.dumps({
            "status": "verified",
            "events_processed": len(events),
            "tasks_projected": len(projected),
            "tasks_baseline": len(baseline),
            "tasks_merged": len(merged),
            "diff_count": len(diffs),
            "diffs": diffs[:20],  # cap output
        }, ensure_ascii=False, indent=2))
        return

    # Output
    output_json = json.dumps(output_data, ensure_ascii=False, indent=2)

    if args.output and not args.dry_run:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = out_path.with_suffix(".json.tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(output_json)
        tmp_path.replace(out_path)
        print(f"[projector] Written to {out_path}", file=sys.stderr)
    else:
        print(output_json)


if __name__ == "__main__":
    main()
