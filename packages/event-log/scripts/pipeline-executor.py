#!/usr/bin/env python3
from __future__ import annotations
"""
pipeline-executor.py — A2A Pipeline Auto-Routing Engine (PRD v2.0)
PRD: A2A-Pipeline-Executor-PRD.md

Subcommands:
  run     — Scan active pipelines, advance state based on Event Log events (Cron)
  status  — Show current status of all active pipelines
  advance — Manually advance a pipeline step (PMO intervention)
  pause   — Pause a pipeline
  resume  — Resume a paused pipeline

Logic (run):
  1. Load state/pipelines/active/*.json
  2. For each pipeline: read current_step → search Event Log for matching events
     (correlation_id + from=step.agent + type=task.done/task.blocked + ts > step.started_at)
  3. task.done → advance step; if next=END → completed + notify on_complete
  4. task.blocked → on_fail fallback or escalate
  5. Timeout detection via timeout_hours
  6. Idempotency: idempotency_key = pipeline-{id}-step{n}-dispatch
  7. Fan-out: step.agent as array → dispatch to all
  8. max_cycles loop control

Standard library only. Writes to Event Log via subprocess a2a-log.py write.
"""

import argparse
import glob
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

# ── Config ─────────────────────────────────────────────────────────────────────

BASE_DIR       = os.path.expanduser("~/.openclaw/workspace/state")
PIPELINES_DIR  = os.path.join(BASE_DIR, "pipelines")
ACTIVE_DIR     = os.path.join(PIPELINES_DIR, "active")
COMPLETED_DIR  = os.path.join(PIPELINES_DIR, "completed")
TEMPLATES_DIR  = os.path.join(PIPELINES_DIR, "templates")
A2A_LOG_DIR    = os.path.join(BASE_DIR, "a2a-log")
EVENTS_DIR     = os.path.join(A2A_LOG_DIR, "events")
A2A_LOG_SCRIPT = os.path.expanduser("~/.openclaw/scripts/a2a-log.py")
PMO_AGENT      = "issac"
MAX_CYCLES_DEFAULT = 3
DISPATCH_FAILURE_HISTORY_LIMIT = 10
DISPATCH_OUTPUT_PREVIEW_LIMIT = 500

# ── Helpers ────────────────────────────────────────────────────────────────────

def now_iso() -> str:
    tz_cst = timezone(timedelta(hours=8))
    return datetime.now(tz_cst).isoformat(timespec="seconds")


def log(msg: str):
    print(f"[pipeline-executor] {now_iso()} {msg}", flush=True)


def load_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log(f"WARN load_json({path}): {e}")
        return None


def save_json(path: str, data: dict) -> bool:
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.chmod(path, 0o600)
        return True
    except Exception as e:
        log(f"ERROR save_json({path}): {e}")
        return False


def read_jsonl(path: str) -> list:
    events = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return events


def parse_iso(ts: str):
    """Parse ISO datetime string to datetime object (timezone-aware)."""
    if not ts:
        return None
    try:
        # Handle +08:00 suffix
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def ensure_dirs():
    """Ensure pipeline subdirectory structure exists."""
    for d in [ACTIVE_DIR, COMPLETED_DIR, TEMPLATES_DIR]:
        os.makedirs(d, exist_ok=True)


# ── Pipeline loading ───────────────────────────────────────────────────────────

def load_active_pipelines(pipeline_id_filter=None):
    """Load all active pipeline JSON files from active/ subdir."""
    ensure_dirs()
    pattern = os.path.join(ACTIVE_DIR, "*.json")
    pipelines = []
    for path in sorted(glob.glob(pattern)):
        pl = load_json(path)
        if not pl:
            continue
        if pipeline_id_filter and pl.get("id") != pipeline_id_filter:
            continue
        # Skip paused unless explicitly requested
        if not pipeline_id_filter and pl.get("status") not in (
            "active", "paused", "internally_completed", "completed_with_followups"
        ):
            continue
        if pl.get("status") == "paused" and not pipeline_id_filter:
            log(f"Pipeline {pl.get('id')}: status=paused, skipping (use --pipeline to run explicitly)")
            continue
        pl["_path"] = path
        pipelines.append(pl)
    return pipelines


def load_pipeline_by_id(pipeline_id):
    """Load a specific pipeline by ID from active/ or completed/."""
    ensure_dirs()
    for search_dir in [ACTIVE_DIR, COMPLETED_DIR]:
        path = os.path.join(search_dir, f"{pipeline_id}.json")
        if os.path.exists(path):
            pl = load_json(path)
            if pl:
                pl["_path"] = path
                return pl
    # Fallback: glob search
    for search_dir in [ACTIVE_DIR, COMPLETED_DIR]:
        for path in glob.glob(os.path.join(search_dir, "*.json")):
            pl = load_json(path)
            if pl and pl.get("id") == pipeline_id:
                pl["_path"] = path
                return pl
    return None


def load_all_pipelines():
    """Load all pipelines from active/ and completed/."""
    ensure_dirs()
    result = []
    for search_dir in [ACTIVE_DIR, COMPLETED_DIR]:
        for path in sorted(glob.glob(os.path.join(search_dir, "*.json"))):
            pl = load_json(path)
            if pl:
                pl["_path"] = path
                result.append(pl)
    return result


# ── Event log reading ──────────────────────────────────────────────────────────

def load_all_events():
    """Read all agent JSONL event files and merge."""
    events = []
    if not os.path.isdir(EVENTS_DIR):
        return events
    for path in sorted(glob.glob(os.path.join(EVENTS_DIR, "*.jsonl"))):
        for ev in read_jsonl(path):
            events.append(ev)
    return events


def check_idempotency_key_exists(idempotency_key: str, all_events: list) -> bool:
    """Check if an event with given idempotency_key already exists in Event Log."""
    for ev in all_events:
        meta = ev.get("meta", {}) or {}
        if meta.get("idempotency_key") == idempotency_key:
            return True
    return False


# ── Event key helpers ──────────────────────────────────────────────────────────

def event_key(ev: dict) -> str:
    """Build unique key for an event: '{from_agent}:{seq}'."""
    from_agent = ev.get("from", "unknown")
    seq = ev.get("seq", "")
    ts = ev.get("ts", "")
    if seq != "" and seq is not None:
        return f"{from_agent}:{seq}"
    return f"{from_agent}:ts:{ts}"


# ── a2a-log.py dispatch wrapper ────────────────────────────────────────────────

def dispatch_event(
    from_agent: str,
    to_agents: list,
    topic: str,
    event_type: str,
    payload: dict,
    correlation_id: str = None,
    causation_id: str = None,
    prev_agent: str = None,
    next_agent: str = None,
    next_task: str = None,
    priority: str = "P1",
    idempotency_key: str = None,
    result_channel: str = None,
    origin_context_channel_id: str = None,
    closeout_policy: str = None,
    dry_run: bool = False,
) -> dict:
    """
    Write an event via a2a-log.py write (subprocess).
    Returns structured dispatch result on both success and failure.
    """
    to_str = ",".join(to_agents)

    # Embed idempotency_key into payload meta field
    if idempotency_key:
        payload = dict(payload)
        payload["_idempotency_key"] = idempotency_key

    payload_str = json.dumps(payload, ensure_ascii=False)

    cmd = [
        sys.executable, A2A_LOG_SCRIPT,
        "write",
        "--from", from_agent,
        "--to", to_str,
        "--topic", topic,
        "--type", event_type,
        "--payload", payload_str,
        "--priority", priority,
    ]
    if prev_agent:
        cmd += ["--prev", prev_agent]
    if next_agent:
        cmd += ["--next", next_agent]
    if correlation_id:
        cmd += ["--correlation-id", correlation_id]
    if causation_id:
        cmd += ["--causation-id", causation_id]
    if idempotency_key:
        cmd += ["--idempotency-key", idempotency_key]
    if result_channel:
        cmd += ["--result-channel", result_channel]
    if origin_context_channel_id:
        cmd += ["--origin-context-channel-id", origin_context_channel_id]
    if closeout_policy:
        cmd += ["--closeout-policy", closeout_policy]

    if dry_run:
        log(f"[DRY-RUN] dispatch {event_type} → {to_str} | topic={topic} | idem={idempotency_key} | payload={payload_str[:80]}…")
        return {
            "ok": True,
            "returncode": 0,
            "stderr": None,
            "stdout": None,
            "target": to_str,
            "event_type": event_type,
            "topic": topic,
        }

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            stderr_text = (result.stderr or "").strip()
            stdout_text = (result.stdout or "").strip()
            log(
                f"ERROR dispatch_event: rc={result.returncode} stderr={stderr_text!r} stdout={stdout_text!r}"
            )
            return {
                "ok": False,
                "returncode": result.returncode,
                "stderr": stderr_text or None,
                "stdout": stdout_text or None,
                "target": to_str,
                "event_type": event_type,
                "topic": topic,
            }
        log(f"Dispatched {event_type} → {to_str} (topic={topic}, idem={idempotency_key})")
        return {
            "ok": True,
            "returncode": result.returncode,
            "stderr": (result.stderr or "").strip() or None,
            "stdout": (result.stdout or "").strip() or None,
            "target": to_str,
            "event_type": event_type,
            "topic": topic,
        }
    except Exception as e:
        log(f"ERROR dispatch_event: {e}")
        return {
            "ok": False,
            "returncode": None,
            "stderr": str(e),
            "stdout": None,
            "target": to_str,
            "event_type": event_type,
            "topic": topic,
        }


def truncate_dispatch_output(value, limit: int = DISPATCH_OUTPUT_PREVIEW_LIMIT):
    if value is None:
        return None
    text = str(value)
    if len(text) <= limit:
        return text
    return f"{text[:limit]}… [truncated {len(text) - limit} chars]"


def get_runtime_dispatch_step(pipeline: dict) -> int:
    steps = pipeline.get("steps") or []
    current_step = pipeline.get("current_step") or 1
    if not steps:
        return current_step
    return max(1, min(current_step, len(steps)))


def record_dispatch_failure(pipeline: dict, step_num: int, dispatch_result: dict, dry_run: bool = False):
    failure = {
        "step": step_num,
        "target": dispatch_result.get("target"),
        "event_type": dispatch_result.get("event_type"),
        "topic": dispatch_result.get("topic"),
        "returncode": dispatch_result.get("returncode"),
        "stderr": truncate_dispatch_output(dispatch_result.get("stderr")),
        "stdout": truncate_dispatch_output(dispatch_result.get("stdout")),
        "at": now_iso(),
    }
    pipeline["last_dispatch_error"] = failure
    history = pipeline.get("dispatch_failures")
    if not isinstance(history, list):
        history = []
    history.append(failure)
    pipeline["dispatch_failures"] = history[-DISPATCH_FAILURE_HISTORY_LIMIT:]
    if not dry_run:
        save_pipeline(pipeline)


def clear_last_dispatch_error(pipeline: dict, dry_run: bool = False):
    if "last_dispatch_error" not in pipeline:
        return
    pipeline.pop("last_dispatch_error", None)
    if not dry_run:
        save_pipeline(pipeline)


def dispatch_ok(result: dict | None) -> bool:
    return bool(result and result.get("ok"))


def normalize_review_result(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    aliases = {
        "passed_with_concerns": "needs_revision",
        "needs_revision": "needs_revision",
        "pass": "pass",
        "passed": "pass",
        "blocked": "blocked",
    }
    return aliases.get(text, text)


# ── Pipeline state helpers ─────────────────────────────────────────────────────

def get_step_history_entry(pipeline: dict, step_num: int, agent=None):
    """Get in-progress step_history entry for step_num."""
    for rec in pipeline.get("step_history", []):
        if rec.get("step") == step_num:
            if agent is None or rec.get("agent") == agent:
                if rec.get("result") is None:
                    return rec
    return None


def count_cycles_for_step(pipeline: dict, step_num: int) -> int:
    """Count how many times step_num has been completed/attempted."""
    count = 0
    for rec in pipeline.get("step_history", []):
        if rec.get("step") == step_num:
            count += 1
    return count


def mark_step_started(pipeline: dict, step: dict, ts: str):
    """Add step_history entry for a step that just started."""
    step_num = step["step"]
    agent = step["agent"] if isinstance(step["agent"], str) else str(step["agent"])
    # Don't duplicate if already present
    for rec in pipeline.get("step_history", []):
        if rec.get("step") == step_num and rec.get("result") is None:
            return
    pipeline.setdefault("step_history", []).append({
        "step": step_num,
        "agent": agent,
        "started": ts,
        "completed": None,
        "result": None,
        "processed_events": [],
    })
    # Update steps[].started_at
    for s in pipeline.get("steps", []):
        if s.get("step") == step_num and not s.get("started_at"):
            s["started_at"] = ts


def mark_step_done(pipeline: dict, step_num: int, agent: str, ts: str, result: str, ev_key: str):
    """Mark a step as completed in step_history."""
    for rec in pipeline.get("step_history", []):
        if rec.get("step") == step_num and rec.get("result") is None:
            rec["completed"] = ts
            rec["result"] = result
            if ev_key and ev_key not in rec.get("processed_events", []):
                rec.setdefault("processed_events", []).append(ev_key)
            return
    # Edge case: no in-progress record
    pipeline.setdefault("step_history", []).append({
        "step": step_num,
        "agent": agent,
        "started": ts,
        "completed": ts,
        "result": result,
        "processed_events": [ev_key] if ev_key else [],
    })
    # Update steps[].completed_at, result
    for s in pipeline.get("steps", []):
        if s.get("step") == step_num:
            s["completed_at"] = ts
            s["result"] = result


def save_pipeline(pipeline: dict, dry_run: bool = False) -> bool:
    path = pipeline.get("_path")
    if not path:
        log(f"ERROR: no _path for pipeline {pipeline.get('id')}")
        return False
    if dry_run:
        log(f"[DRY-RUN] Would save pipeline {pipeline['id']} → {path}")
        return True
    save_data = {k: v for k, v in pipeline.items() if not k.startswith("_")}
    return save_json(path, save_data)


def move_to_completed(pipeline: dict, dry_run: bool = False) -> bool:
    """Move pipeline file from active/ to completed/."""
    pl_id = pipeline.get("id", "unknown")
    src_path = pipeline.get("_path", "")
    if not src_path or COMPLETED_DIR in src_path:
        return True  # already in completed

    dest_path = os.path.join(COMPLETED_DIR, os.path.basename(src_path))

    if dry_run:
        log(f"[DRY-RUN] Would move {pl_id}: active/ → completed/")
        return True

    try:
        save_data = {k: v for k, v in pipeline.items() if not k.startswith("_")}
        save_json(dest_path, save_data)
        os.remove(src_path)
        pipeline["_path"] = dest_path
        log(f"Moved pipeline {pl_id} → completed/")
        return True
    except Exception as e:
        log(f"ERROR move_to_completed {pl_id}: {e}")
        return False


# ── Notification helpers ───────────────────────────────────────────────────────

def resolve_closeout_target(pipeline: dict) -> dict | None:
    """Resolve structured closeout target with legacy fallback compatibility."""
    on_complete = pipeline.get("on_complete") or {}
    final_delivery = on_complete.get("final_delivery") or {}
    delivery_target = pipeline.get("delivery_target") or {}

    for candidate in (
        final_delivery.get("closeout_target"),
        delivery_target.get("closeout_target"),
    ):
        if isinstance(candidate, dict) and candidate.get("channel_id"):
            return candidate

    explicit_target = delivery_target.get("channel")
    origin_context_channel_id = pipeline.get("origin_context_channel_id") or final_delivery.get("origin_context_channel_id")
    inherit_context = final_delivery.get("inherit_context", bool(origin_context_channel_id))

    if explicit_target and origin_context_channel_id and explicit_target != origin_context_channel_id:
        return {
            "surface": "discord",
            "channel_id": explicit_target,
            "thread_id": None,
            "mode": "explicit_override",
        }

    if inherit_context and origin_context_channel_id:
        return {
            "surface": "discord",
            "channel_id": origin_context_channel_id,
            "thread_id": None,
            "mode": "inherited_origin",
        }

    fallback_target = (
        final_delivery.get("channel")
        or pipeline.get("result_channel")
        or explicit_target
        or on_complete.get("channel")
    )
    if fallback_target:
        return {
            "surface": "discord",
            "channel_id": fallback_target,
            "thread_id": None,
            "mode": "implicit_fallback",
        }

    return None


def resolve_closeout_policy(pipeline: dict) -> str:
    """Resolve closeout policy with sane defaults for human-visible delivery."""
    on_complete = pipeline.get("on_complete") or {}
    final_delivery = on_complete.get("final_delivery") or {}
    policy = final_delivery.get("closeout_policy")
    if policy in {"required", "optional", "none"}:
        return policy

    if final_delivery.get("human_summary_required", True) and resolve_closeout_target(pipeline):
        return "required"
    return "optional"


def resolve_delivery_channel(pipeline: dict) -> str | None:
    """Resolve human-visible delivery target.

    Precedence:
      1. explicit delivery_target.channel
      2. origin_context_channel_id when final_delivery.inherit_context=true
      3. final_delivery.channel
      4. pipeline.result_channel
      5. on_complete.channel
    """
    closeout_target = resolve_closeout_target(pipeline)
    if isinstance(closeout_target, dict) and closeout_target.get("channel_id"):
        return closeout_target.get("channel_id")

    on_complete = pipeline.get("on_complete") or {}
    final_delivery = on_complete.get("final_delivery") or {}
    explicit_target = (pipeline.get("delivery_target") or {}).get("channel")
    origin_context_channel_id = pipeline.get("origin_context_channel_id") or final_delivery.get("origin_context_channel_id")
    inherit_context = final_delivery.get("inherit_context", bool(origin_context_channel_id))

    if explicit_target:
        return explicit_target
    if inherit_context and origin_context_channel_id:
        return origin_context_channel_id
    return (
        final_delivery.get("channel")
        or pipeline.get("result_channel")
        or on_complete.get("channel")
    )


def notify_on_complete(pipeline: dict, dry_run: bool = False) -> bool:
    """
    Send completion notification via Event Log (task.done to notify_list).

    Returns True if final delivery is pending (status should be internally_completed).
    Returns False if no delivery needed (can go straight to completed).
    """
    on_complete = pipeline.get("on_complete") or {}
    notify_list = on_complete.get("notify", [])
    if not notify_list:
        log(f"Pipeline {pipeline['id']}: no on_complete.notify configured")
        return False

    steps = pipeline.get("steps", [])
    step_history = pipeline.get("step_history", [])

    # Calculate elapsed
    first_started = None
    last_completed = None
    for rec in step_history:
        s = parse_iso(rec.get("started"))
        c = parse_iso(rec.get("completed"))
        if s and (first_started is None or s < first_started):
            first_started = s
        if c and (last_completed is None or c > last_completed):
            last_completed = c

    elapsed = "unknown"
    if first_started and last_completed:
        delta = last_completed - first_started
        hours = int(delta.total_seconds() // 3600)
        minutes = int((delta.total_seconds() % 3600) // 60)
        elapsed = f"{hours}h{minutes}m"

    tmpl = on_complete.get("message_template",
                           "Pipeline {id} 全部完成 ✅ 共 {total_steps} 步，耗时 {elapsed}")
    message = tmpl.format(
        id=pipeline.get("id", ""),
        total_steps=len(steps),
        elapsed=elapsed,
    )

    # Final delivery config: where to send human-visible summary
    final_delivery = on_complete.get("final_delivery") or {}
    delivery_channel = resolve_delivery_channel(pipeline)
    human_summary_required = final_delivery.get("human_summary_required", True)
    closeout_target = resolve_closeout_target(pipeline)
    closeout_policy = resolve_closeout_policy(pipeline)

    # Collect step summaries from step_history done events
    step_summaries = []
    for rec in step_history:
        step_num = rec.get("step", "?")
        agent = rec.get("agent", "?")
        result = rec.get("result", "?")
        step_summaries.append(f"Step {step_num} ({agent}): {result}")

    payload = {
        "summary": message,
        "pipeline_id": pipeline["id"],
        "pipeline_name": pipeline.get("name", pipeline["id"]),
        "topic": pipeline.get("topic", ""),
        "total_steps": len(steps),
        "elapsed": elapsed,
        "step_history": step_history,
        "step_summaries": step_summaries,
        "origin_context_channel_id": pipeline.get("origin_context_channel_id"),
        "result_channel": pipeline.get("result_channel") or delivery_channel,
        # Final delivery metadata for PMO to act on
        "final_delivery": {
            "channel": delivery_channel,
            "origin_context_channel_id": pipeline.get("origin_context_channel_id"),
            "inherit_context": final_delivery.get("inherit_context", bool(pipeline.get("origin_context_channel_id"))),
            "closeout_target": closeout_target,
            "closeout_policy": closeout_policy,
            "human_summary_required": human_summary_required,
            "template": final_delivery.get("template"),
        },
    }

    idempotency_key = f"pipeline-{pipeline['id']}-complete-notify"

    # Idempotency check: skip if already notified
    all_events_for_check = load_all_events()
    if check_idempotency_key_exists(idempotency_key, all_events_for_check):
        log(f"Pipeline {pipeline['id']}: complete-notify already sent (idem={idempotency_key}), skipping")
        # Still return delivery status — the notification was sent before
        if human_summary_required and delivery_channel:
            return True
        return False

    dispatch_result = dispatch_event(
        from_agent="pipeline-executor",
        to_agents=notify_list,
        topic=pipeline.get("topic", "pipeline"),
        event_type="task.done",
        payload=payload,
        correlation_id=pipeline.get("correlation_id"),
        priority="P1",
        idempotency_key=idempotency_key,
        result_channel=delivery_channel,
        origin_context_channel_id=pipeline.get("origin_context_channel_id"),
        closeout_policy=closeout_policy,
        dry_run=dry_run,
    )
    if dispatch_ok(dispatch_result):
        clear_last_dispatch_error(pipeline, dry_run=dry_run)
        delivery_label = f" → delivery_channel={delivery_channel}" if delivery_channel else ""
        log(f"Pipeline {pipeline['id']} completed → notified {notify_list}{delivery_label}")
    else:
        record_dispatch_failure(
            pipeline,
            get_runtime_dispatch_step(pipeline),
            dispatch_result,
            dry_run=dry_run,
        )
        log(f"ERROR: Pipeline {pipeline['id']}: complete-notify dispatch failed")
        # Keep pipeline in active/ for compensation rather than marking it fully completed.
        return True

    # Check if final delivery is needed
    if human_summary_required and delivery_channel:
        if not dry_run:
            pipeline["delivery_status"] = "pending"
            pipeline["delivery_attempts"] = 0
            pipeline["max_delivery_attempts"] = 3
            pipeline["last_delivery_error"] = None
        log(f"Pipeline {pipeline['id']} → internally_completed "
            f"(pending final delivery to {delivery_channel})")
        return True  # Caller should set internally_completed, NOT completed

    return False  # No delivery needed, can complete normally


def escalate_to_pmo(pipeline: dict, step: dict, reason: str, dry_run: bool = False):
    """Escalate pipeline step to PMO."""
    pipeline_id = pipeline.get("id", "unknown")
    step_num = step.get("step", "?")

    payload = {
        "summary": f"🚨 Pipeline {pipeline_id} step {step_num} escalated: {reason}",
        "pipeline_id": pipeline_id,
        "pipeline_name": pipeline.get("name", pipeline_id),
        "topic": pipeline.get("topic", ""),
        "step": step_num,
        "agent": step.get("agent"),
        "task": step.get("task"),
        "reason": reason,
    }

    idempotency_key = f"pipeline-{pipeline_id}-step{step_num}-escalate"

    dispatch_result = dispatch_event(
        from_agent="pipeline-executor",
        to_agents=[PMO_AGENT],
        topic=pipeline.get("topic", "pipeline"),
        event_type="task.escalated",
        payload=payload,
        correlation_id=pipeline.get("correlation_id"),
        priority="P0",
        idempotency_key=idempotency_key,
        result_channel=resolve_delivery_channel(pipeline),
        origin_context_channel_id=pipeline.get("origin_context_channel_id"),
        closeout_policy=resolve_closeout_policy(pipeline),
        dry_run=dry_run,
    )
    if dispatch_ok(dispatch_result):
        clear_last_dispatch_error(pipeline, dry_run=dry_run)
        log(f"ESCALATED pipeline {pipeline_id} step {step_num} → {PMO_AGENT}: {reason}")
    else:
        record_dispatch_failure(pipeline, step_num, dispatch_result, dry_run=dry_run)
        log(f"ERROR: Pipeline {pipeline_id}: failed to escalate step {step_num} to {PMO_AGENT}")


# ── Timeout detection ──────────────────────────────────────────────────────────

def check_step_timeout(pipeline: dict, step: dict, dry_run: bool = False) -> bool:
    """Check if current step has exceeded timeout_hours. Returns True if timed out."""
    timeout_hours = step.get("timeout_hours")
    if not timeout_hours:
        return False

    step_num = pipeline.get("current_step", 1)
    # Find step started_at from step_history
    started_at = None
    for rec in pipeline.get("step_history", []):
        if rec.get("step") == step_num and rec.get("result") is None:
            started_at = rec.get("started")
            break
    # Also check steps[].started_at
    if not started_at:
        started_at = step.get("started_at")

    if not started_at:
        return False

    started_dt = parse_iso(started_at)
    if not started_dt:
        return False

    tz_cst = timezone(timedelta(hours=8))
    now_dt = datetime.now(tz_cst)
    elapsed_hours = (now_dt - started_dt).total_seconds() / 3600

    if elapsed_hours >= timeout_hours:
        log(f"Pipeline {pipeline.get('id')} step {step_num}: TIMEOUT ({elapsed_hours:.1f}h >= {timeout_hours}h)")

        # Write task.escalated event
        on_timeout = pipeline.get("on_timeout") or {}
        notify_list = on_timeout.get("notify", [PMO_AGENT])

        idempotency_key = f"pipeline-{pipeline['id']}-step{step_num}-timeout"

        payload = {
            "summary": f"⏰ Pipeline {pipeline.get('id')} step {step_num} TIMEOUT ({elapsed_hours:.1f}h / {timeout_hours}h limit)",
            "pipeline_id": pipeline.get("id"),
            "step": step_num,
            "agent": step.get("agent"),
            "task": step.get("task"),
            "elapsed_hours": round(elapsed_hours, 2),
            "timeout_hours": timeout_hours,
            "started_at": started_at,
        }

        dispatch_result = dispatch_event(
            from_agent="pipeline-executor",
            to_agents=notify_list,
            topic=pipeline.get("topic", "pipeline"),
            event_type="task.escalated",
            payload=payload,
            correlation_id=pipeline.get("correlation_id"),
            priority="P0",
            idempotency_key=idempotency_key,
            result_channel=resolve_delivery_channel(pipeline),
            origin_context_channel_id=pipeline.get("origin_context_channel_id"),
            closeout_policy=resolve_closeout_policy(pipeline),
            dry_run=dry_run,
        )
        if dispatch_ok(dispatch_result):
            clear_last_dispatch_error(pipeline, dry_run=dry_run)
        else:
            record_dispatch_failure(pipeline, step_num, dispatch_result, dry_run=dry_run)
            log(f"ERROR: Pipeline {pipeline.get('id')}: timeout escalation dispatch failed for step {step_num}")

        if not dry_run:
            pipeline["status"] = "timeout"
            save_pipeline(pipeline)

        return True
    return False


# ── [v2.1 第二层防线] Event Log 补偿查找 ─────────────────────────────────────────

# Elon 建议1: 匹配 blocked/cancelled，不只是 done
COMPENSATABLE_TYPES = {"task.done", "task.blocked", "task.cancelled"}


def find_matching_done(correlation_id: str, agent: str, started_at: str, strict: bool = False) -> dict | None:
    """
    在所有 agent 的 events/*.jsonl 中搜索匹配的完成事件（补偿同步）。
    匹配条件：
      - type in {task.done, task.blocked, task.cancelled}
      - correlation_id 匹配（prefix 模式：pipeline-id 可匹配 pipeline-id-20260329）
      - from == agent
      - ts > started_at（如果 started_at 非空）

    Args:
      correlation_id: Pipeline correlation ID to match
      agent: Expected sender agent
      started_at: ISO timestamp — only events after this are considered
      strict: If True, require exact correlation_id match (default: prefix match)
    """
    if not os.path.isdir(EVENTS_DIR):
        return None

    for events_file in sorted(glob.glob(os.path.join(EVENTS_DIR, "*.jsonl"))):
        for ev in read_jsonl(events_file):
            ev_type = ev.get("type", "")
            if ev_type not in COMPENSATABLE_TYPES:
                continue
            if ev.get("from") != agent:
                continue
            ev_corr = ev.get("correlation_id") or ""
            if correlation_id:
                if strict:
                    match = (ev_corr == correlation_id)
                else:
                    match = ev_corr.startswith(correlation_id) or correlation_id.startswith(ev_corr)
                if not match:
                    continue
            if started_at:
                ev_ts = ev.get("ts", "")
                if ev_ts and ev_ts <= started_at:
                    continue
            return ev
    return None


# ── Main pipeline processor ────────────────────────────────────────────────────

def _check_delivery_confirmation(pipeline: dict, all_events: list, dry_run: bool = False):
    """
    Check if a task.delivered event exists for an internally_completed pipeline.
    If found, promote to completed and move to completed/.
    If delivery stalled > 1 hour, escalate to PMO.
    """
    pl_id = pipeline.get("id", "unknown")
    pl_corr = pipeline.get("correlation_id", "")
    delivery_status = pipeline.get("delivery_status", "pending")

    if delivery_status == "delivered":
        # Already confirmed, just needs to be moved
        log(f"Pipeline {pl_id}: delivery confirmed → completed")
        if not dry_run:
            pipeline["status"] = "completed"
            save_pipeline(pipeline)
            move_to_completed(pipeline)
        return

    # Search for task.delivered event matching this pipeline
    for ev in all_events:
        if ev.get("type") != "task.delivered":
            continue
        ev_corr = ev.get("correlation_id", "")
        if pl_corr and ev_corr and ev_corr != pl_corr:
            # Allow prefix match
            if not (ev_corr.startswith(pl_corr) or pl_corr.startswith(ev_corr)):
                continue
        # Check payload for pipeline_id match
        ev_payload = ev.get("payload", {}) or {}
        if ev_payload.get("pipeline_id") == pl_id or ev_corr == pl_corr:
            log(f"Pipeline {pl_id}: found task.delivered event → promoting to completed")
            if not dry_run:
                pipeline["status"] = "completed"
                pipeline["delivery_status"] = "delivered"
                pipeline["delivered_at"] = ev.get("ts", now_iso())
                pipeline["delivered_by"] = ev.get("from", "unknown")
                save_pipeline(pipeline)
                move_to_completed(pipeline)
            return

    # No delivery confirmation found
    log(f"Pipeline {pl_id}: internally_completed, delivery_status={delivery_status}, "
        f"no task.delivered event yet")

    # Check if pipeline has been internally_completed for too long (> 1 hour)
    step_history = pipeline.get("step_history", [])
    last_completed = None
    for rec in step_history:
        c = parse_iso(rec.get("completed"))
        if c and (last_completed is None or c > last_completed):
            last_completed = c

    if last_completed:
        tz_cst = timezone(timedelta(hours=8))
        now_dt = datetime.now(tz_cst)
        elapsed_hours = (now_dt - last_completed).total_seconds() / 3600
        if elapsed_hours > 1.0:
            # Escalate: delivery stalled for > 1 hour
            idempotency_key = f"pipeline-{pl_id}-delivery-stalled"
            # Check if already escalated
            already_escalated = check_idempotency_key_exists(idempotency_key, all_events)
            if not already_escalated:
                log(f"Pipeline {pl_id}: delivery stalled for {elapsed_hours:.1f}h → escalating to PMO")
                dispatch_result = dispatch_event(
                    from_agent="pipeline-executor",
                    to_agents=[PMO_AGENT],
                    topic=pipeline.get("topic", "pipeline"),
                    event_type="task.escalated",
                    payload={
                        "summary": f"⚠️ Pipeline {pl_id} final delivery 停滞 {elapsed_hours:.1f}h",
                        "pipeline_id": pl_id,
                        "delivery_status": delivery_status,
                        "delivery_channel": resolve_delivery_channel(pipeline),
                        "origin_context_channel_id": pipeline.get("origin_context_channel_id"),
                    },
                    correlation_id=pl_corr,
                    priority="P0",
                    idempotency_key=idempotency_key,
                    result_channel=resolve_delivery_channel(pipeline),
                    origin_context_channel_id=pipeline.get("origin_context_channel_id"),
                    closeout_policy=resolve_closeout_policy(pipeline),
                    dry_run=dry_run,
                )
                if dispatch_ok(dispatch_result):
                    clear_last_dispatch_error(pipeline, dry_run=dry_run)
                else:
                    record_dispatch_failure(
                        pipeline,
                        get_runtime_dispatch_step(pipeline),
                        dispatch_result,
                        dry_run=dry_run,
                    )
                    log(f"ERROR: Pipeline {pl_id}: failed to dispatch delivery-stalled escalation")


def process_pipeline(pipeline: dict, all_events: list, dry_run: bool = False, strict: bool = False):
    """Process a single pipeline: check events, advance state if needed."""
    pl_id    = pipeline.get("id", "unknown")
    pl_name  = pipeline.get("name", pl_id)
    pl_topic = pipeline.get("topic", "")
    pl_corr  = pipeline.get("correlation_id", "")
    pl_status = pipeline.get("status", "active")
    steps    = pipeline.get("steps", [])

    if not steps:
        log(f"Pipeline {pl_id}: no steps defined, skipping")
        return

    if pl_status == "completed":
        log(f"Pipeline {pl_id}: already completed, skipping")
        return

    if pl_status == "internally_completed":
        # Check for task.delivered event confirming final delivery
        _check_delivery_confirmation(pipeline, all_events, dry_run)
        return

    if pl_status == "paused":
        log(f"Pipeline {pl_id}: paused, skipping")
        return

    if pl_status == "timeout":
        log(f"Pipeline {pl_id}: timed out, skipping")
        return

    if pl_status == "completed_with_followups":
        log(f"Pipeline {pl_id}: completed_with_followups (followup_status="
            f"{pipeline.get('followup_status', '?')}), skipping auto-advance")
        return

    current_step_num = pipeline.get("current_step", 1)
    if current_step_num > len(steps):
        if pl_status not in ("completed", "internally_completed"):
            log(f"Pipeline {pl_id}: current_step={current_step_num} > total={len(steps)} → marking completed")
            pending_delivery = notify_on_complete(pipeline, dry_run=dry_run)
            if pending_delivery:
                if not dry_run:
                    pipeline["status"] = "internally_completed"
                    save_pipeline(pipeline)
                # Do NOT move_to_completed — stay in active/ waiting for delivery confirmation
            else:
                if not dry_run:
                    pipeline["status"] = "completed"
                    save_pipeline(pipeline)
                    move_to_completed(pipeline)
        return

    current_step = steps[current_step_num - 1]
    # Auto-complete if current step is already done (step.done written but current_step not advanced)
    if current_step.get("completed_at") and current_step.get("next") == "END":
        if pl_status not in ("completed", "internally_completed"):
            log(f"Pipeline {pl_id}: step {current_step_num} already done, next=END → marking completed")
            pending_delivery = notify_on_complete(pipeline, dry_run=dry_run)
            if pending_delivery:
                if not dry_run:
                    pipeline["status"] = "internally_completed"
                    pipeline["current_step"] = current_step_num + 1
                    save_pipeline(pipeline)
                # Do NOT move_to_completed — stay in active/ waiting for delivery confirmation
            else:
                if not dry_run:
                    pipeline["status"] = "completed"
                    pipeline["current_step"] = current_step_num + 1
                    save_pipeline(pipeline)
                    move_to_completed(pipeline)
        return


    step_agent   = current_step.get("agent")
    step_task    = current_step.get("task", "")
    step_next    = current_step.get("next", "END")
    step_on_fail = current_step.get("on_fail")
    step_max_cycles = current_step.get("max_cycles", MAX_CYCLES_DEFAULT)
    step_started_at = current_step.get("started_at")

    # Normalise agent to list for fan-out support
    if isinstance(step_agent, str):
        step_agents = [step_agent]
    elif isinstance(step_agent, list):
        step_agents = step_agent
    else:
        log(f"Pipeline {pl_id} step {current_step_num}: invalid agent field, skipping")
        return

    # Ensure step has started entry in history
    step_has_history = any(
        r.get("step") == current_step_num and r.get("result") is None
        for r in pipeline.get("step_history", [])
    )
    if not step_has_history and not dry_run:
        mark_step_started(pipeline, current_step, now_iso())
        save_pipeline(pipeline)

    # Check timeout BEFORE looking for events
    if check_step_timeout(pipeline, current_step, dry_run=dry_run):
        return

    # [v2.1 第二层防线] 如果 current_step.completed_at 为 None，检查 Event Log 补偿
    # 这覆盖第一层 hook 失败的场景（correlation_id 不匹配、文件锁、crash 等）
    if current_step.get("completed_at") is None:
        compensation_event = find_matching_done(
            correlation_id=pl_corr,
            agent=step_agents[0] if len(step_agents) == 1 else step_agents[0],
            started_at=current_step.get("started_at") or step_started_at,
            strict=strict,
        )
        if compensation_event:
            comp_ts = compensation_event.get("ts", now_iso())
            comp_type = compensation_event.get("type", "task.done")
            comp_result = "done" if comp_type == "task.done" else comp_type.replace("task.", "")
            comp_doc_path = (compensation_event.get("payload") or {}).get("doc_path")
            log(f"[补偿同步] Pipeline {pl_id} step {current_step_num}: "
                f"Event Log 有 {comp_type}，第一层 hook 漏了，补偿回写")
            if not dry_run:
                current_step["completed_at"] = comp_ts
                current_step["result"] = comp_result
                if comp_doc_path:
                    current_step["result_doc_path"] = comp_doc_path
                pipeline["steps"][current_step_num - 1] = current_step
                save_pipeline(pipeline)
            # 继续走正常流程（relevant_events 会匹配到这个事件并推进）

    # Build a set of already-processed event keys from step_history
    processed_keys = set()
    for rec in pipeline.get("step_history", []):
        for k in rec.get("processed_events", []):
            processed_keys.add(k)

    # Parse step.started_at for time-based filtering
    started_at_dt = parse_iso(step_started_at)
    if not started_at_dt:
        # Check step_history for started time
        for rec in pipeline.get("step_history", []):
            if rec.get("step") == current_step_num and rec.get("result") is None:
                started_at_dt = parse_iso(rec.get("started"))
                break

    # Find matching events:
    # - correlation_id matches pipeline.correlation_id (if set)
    # - from in step_agents
    # - type = task.done or task.blocked
    # - ts > step.started_at (if available)
    # - not already processed
    # R4/R5: task.acked does NOT advance pipeline — only task.done/task.blocked do
    relevant_events = []
    for ev in all_events:
        ev_type = ev.get("type", "")
        if ev_type not in ("task.done", "task.blocked", "task.cancelled"):
            continue

        ev_from = ev.get("from", "")
        if ev_from not in step_agents:
            continue

        # topic match
        ev_topic = ev.get("topic", "")
        if ev_topic and pl_topic and ev_topic != pl_topic:
            continue

        # correlation_id match (if both set)
        ev_corr = ev.get("correlation_id", "")
        if pl_corr and ev_corr and ev_corr != pl_corr:
            continue

        # time filter
        if started_at_dt:
            ev_ts = parse_iso(ev.get("ts", ""))
            if ev_ts and ev_ts <= started_at_dt:
                continue

        # idempotency: skip already-processed
        ekey = event_key(ev)
        if ekey in processed_keys:
            continue

        relevant_events.append(ev)

    if not relevant_events:
        log(f"Pipeline {pl_id} step {current_step_num}/{len(steps)} "
            f"({'/'.join(step_agents)} → {step_task}): no new events")
        return

    # Process first matching event (one per cycle for safety)
    ev = relevant_events[0]
    ekey = event_key(ev)
    ev_type = ev.get("type")
    ev_ts = ev.get("ts", now_iso())
    ev_from = ev.get("from", step_agents[0])

    log(f"Pipeline {pl_id} step {current_step_num}: matched event type={ev_type} "
        f"from={ev_from} key={ekey}")

    if ev_type == "task.done":
        # ── Advance to next step ───────────────────────────────────────────────

        if not dry_run:
            mark_step_done(pipeline, current_step_num, ev_from, ev_ts, "done", ekey)

        # Check for review_result in done event payload → followup mechanism
        ev_payload_done = ev.get("payload", {}) or {}
        review_result = normalize_review_result(ev_payload_done.get("review_result"))
        if review_result in ("needs_revision", "blocked"):
            log(f"Pipeline {pl_id}: review={review_result}, setting followup_status=pending")
            if not dry_run:
                pipeline["followup_status"] = "pending"
                pipeline["followup_concerns"] = ev_payload_done.get("concerns", [])
                pipeline["followup_review_result"] = review_result
                pipeline["status"] = "completed_with_followups"
                pipeline["current_step"] = current_step_num + 1
                save_pipeline(pipeline)
                # Keep in active/ — do NOT move to completed
            return

        if step_next == "END":
            log(f"Pipeline {pl_id}: step {current_step_num} done → next=END → COMPLETED")
            pending_delivery = notify_on_complete(pipeline, dry_run=dry_run)
            if pending_delivery:
                if not dry_run:
                    pipeline["status"] = "internally_completed"
                    pipeline["current_step"] = current_step_num + 1
                    save_pipeline(pipeline)
                # Do NOT move_to_completed — stay in active/ waiting for delivery confirmation
            else:
                if not dry_run:
                    pipeline["status"] = "completed"
                    pipeline["current_step"] = current_step_num + 1
                    save_pipeline(pipeline)
                    move_to_completed(pipeline)
            return

        # Advance: determine next step
        next_step_num = current_step_num + 1
        next_step_def = steps[next_step_num - 1] if next_step_num <= len(steps) else None

        next_agents = step_next if isinstance(step_next, list) else [step_next]
        next_task = next_step_def.get("task", "") if next_step_def else ""
        next_next = next_step_def.get("next", "END") if next_step_def else "END"

        idempotency_key = f"pipeline-{pl_id}-step{next_step_num}-dispatch"

        # Check idempotency
        if check_idempotency_key_exists(idempotency_key, all_events):
            log(f"Pipeline {pl_id}: dispatch for step {next_step_num} already exists "
                f"(idem={idempotency_key}), skipping duplicate")
            if not dry_run:
                pipeline["current_step"] = next_step_num
                save_pipeline(pipeline)
            return

        # Get doc_path from upstream event
        ev_payload = ev.get("payload") or {}
        doc_path = None
        if isinstance(ev_payload, dict):
            doc_path = ev_payload.get("doc_path") or ev_payload.get("result_doc_path")

        # Get next step doc_path from step definition
        step_doc_path = next_step_def.get("doc_path") if next_step_def else None
        task_detail = next_step_def.get("task_detail", "") if next_step_def else ""

        # Keep step-dispatch payload doc-first safe: a2a-log.py rejects payloads >500 chars
        # without doc_path. The longer bookkeeping fields below are either redundant with the
        # event envelope/meta or are only useful for debugging, so we keep the dispatch payload
        # intentionally compact.
        payload = {
            "summary": f"[Pipeline 自动流转] {pl_name} 步骤 {next_step_num}: {next_task}",
            "task": next_task,
            "pipeline_id": pl_id,
            "pipeline_step": next_step_num,
            "total_steps": len(steps),
        }
        if task_detail:
            payload["task_detail"] = task_detail
        if step_doc_path:
            payload["doc_path"] = step_doc_path
        elif doc_path:
            payload["upstream_result_doc"] = doc_path

        # For each next agent (fan-out): dispatch separately
        success = True
        for na in next_agents:
            idem_key_agent = f"{idempotency_key}" if len(next_agents) == 1 else f"{idempotency_key}-{na}"
            dispatch_result = dispatch_event(
                from_agent="pipeline-executor",
                to_agents=[na],
                topic=pl_topic,
                event_type="task.dispatch",
                payload=payload,
                correlation_id=pl_corr,
                causation_id=ekey,
                prev_agent=ev_from,
                next_agent=next_next if isinstance(next_next, str) else None,
                next_task=next_task,
                priority="P1",
                idempotency_key=idem_key_agent,
                result_channel=resolve_delivery_channel(pipeline),
                origin_context_channel_id=pipeline.get("origin_context_channel_id"),
                dry_run=dry_run,
            )
            if not dispatch_ok(dispatch_result):
                success = False
                record_dispatch_failure(pipeline, next_step_num, dispatch_result, dry_run=dry_run)
                log(f"ERROR: failed to dispatch to {na}")

        if success:
            clear_last_dispatch_error(pipeline, dry_run=dry_run)
            if not dry_run:
                pipeline["current_step"] = next_step_num
                # Mark next step as started
                if next_step_def:
                    mark_step_started(pipeline, next_step_def, now_iso())
                save_pipeline(pipeline)
            log(f"Pipeline {pl_id}: advanced step {current_step_num} → {next_step_num} | agents={next_agents}")
        else:
            log(f"ERROR: Pipeline {pl_id}: dispatch failed for step {next_step_num}")

    elif ev_type == "task.blocked":
        # ── Handle failure / on_fail fallback ────────────────────────────────

        cycles = count_cycles_for_step(pipeline, current_step_num)
        if step_max_cycles is not None and cycles >= step_max_cycles:
            log(f"Pipeline {pl_id} step {current_step_num}: max_cycles={step_max_cycles} reached "
                f"(cycles={cycles}) → escalating")
            if not dry_run:
                mark_step_done(pipeline, current_step_num, ev_from, ev_ts, "max_cycles_exceeded", ekey)
                pipeline["status"] = "failed"
                save_pipeline(pipeline)
            escalate_to_pmo(pipeline, current_step,
                            reason=f"max_cycles={step_max_cycles} exceeded (cycles={cycles})",
                            dry_run=dry_run)
            return

        if step_on_fail is None:
            log(f"Pipeline {pl_id} step {current_step_num}: task.blocked + no on_fail → escalating")
            if not dry_run:
                mark_step_done(pipeline, current_step_num, ev_from, ev_ts, "blocked", ekey)
                pipeline["status"] = "failed"
                save_pipeline(pipeline)
            escalate_to_pmo(pipeline, current_step, reason="no on_fail handler", dry_run=dry_run)
            return

        # Dispatch back to on_fail agent(s)
        fail_agents = step_on_fail if isinstance(step_on_fail, list) else [step_on_fail]
        idempotency_key = f"pipeline-{pl_id}-step{current_step_num}-fail-{cycles}"

        ev_payload = ev.get("payload") or {}
        doc_path = ev_payload.get("doc_path") if isinstance(ev_payload, dict) else None
        fail_reason = ev_payload.get("reason", "task.blocked") if isinstance(ev_payload, dict) else "task.blocked"

        payload = {
            "summary": f"[Pipeline 回退] {pl_name} 步骤 {current_step_num} 失败 → 回退到 {step_on_fail}",
            "task": step_task,
            "task_detail": current_step.get("task_detail", ""),
            "pipeline_id": pl_id,
            "pipeline_name": pl_name,
            "pipeline_step": current_step_num,
            "total_steps": len(steps),
            "reason": fail_reason,
            "failed_agent": ev_from,
            "failed_step": current_step_num,
            "doc_path": doc_path,
            "cycles": cycles,
            "max_cycles": step_max_cycles,
        }

        dispatch_result = dispatch_event(
            from_agent="pipeline-executor",
            to_agents=fail_agents,
            topic=pl_topic,
            event_type="task.dispatch",
            payload=payload,
            correlation_id=pl_corr,
            causation_id=ekey,
            prev_agent=ev_from,
            next_agent=ev_from,  # will return to same step after fix
            priority="P1",
            idempotency_key=idempotency_key,
            result_channel=resolve_delivery_channel(pipeline),
            origin_context_channel_id=pipeline.get("origin_context_channel_id"),
            dry_run=dry_run,
        )

        if dispatch_ok(dispatch_result):
            clear_last_dispatch_error(pipeline, dry_run=dry_run)
            if not dry_run:
                mark_step_done(pipeline, current_step_num, ev_from, ev_ts, "failed_back", ekey)
                save_pipeline(pipeline)
            log(f"Pipeline {pl_id} step {current_step_num}: blocked → dispatched back to on_fail={step_on_fail}")
        else:
            record_dispatch_failure(pipeline, current_step_num, dispatch_result, dry_run=dry_run)
            log(f"ERROR: Pipeline {pl_id}: failed to dispatch on_fail for step {current_step_num}")

    elif ev_type == "task.cancelled":
        # ── Handle cancelled task ────────────────────────────────────────────
        log(f"Pipeline {pl_id} step {current_step_num}: task.cancelled by {ev_from}")
        if not dry_run:
            mark_step_done(pipeline, current_step_num, ev_from, ev_ts, "cancelled", ekey)
            pipeline["status"] = "cancelled"
            save_pipeline(pipeline)
            move_to_completed(pipeline)
        # Notify PMO
        escalate_to_pmo(pipeline, current_step, reason="agent cancelled task", dry_run=dry_run)


# ── Subcommand: diagnose ───────────────────────────────────────────────────────

def _diagnose_pipeline(pipeline: dict, all_events: list) -> dict:
    """
    Analyse a single pipeline and return a diagnosis dict with step details,
    timeout info, and a human-readable conclusion + recommendation.
    """
    pl_id = pipeline.get("id", "unknown")
    pl_corr = pipeline.get("correlation_id", "")
    steps = pipeline.get("steps", [])
    current_step_num = pipeline.get("current_step", 1)
    total_steps = len(steps)
    tz_cst = timezone(timedelta(hours=8))
    now_dt = datetime.now(tz_cst)

    step_diags = []

    for i, step in enumerate(steps):
        step_num = step.get("step", i + 1)
        agent = step.get("agent", "?")
        agent_str = agent if isinstance(agent, str) else "+".join(agent)
        task = step.get("task", "?")
        agents_list = [agent] if isinstance(agent, str) else agent

        # Determine step status from history
        hist_entries = [r for r in pipeline.get("step_history", []) if r.get("step") == step_num]
        last_hist = hist_entries[-1] if hist_entries else None

        if last_hist and last_hist.get("result") is not None:
            # Completed step
            result = last_hist.get("result", "done")
            started = last_hist.get("started")
            completed = last_hist.get("completed")
            elapsed_str = ""
            if started and completed:
                s = parse_iso(started)
                c = parse_iso(completed)
                if s and c:
                    total_secs = (c - s).total_seconds()
                    h = int(total_secs // 3600)
                    m = int((total_secs % 3600) // 60)
                    elapsed_str = f"{h}h{m}m"
            icon = "✅" if result == "done" else "❌"
            step_diags.append({
                "step_num": step_num,
                "agent": agent_str,
                "task": task,
                "status": result,
                "icon": icon,
                "elapsed": elapsed_str,
                "details": [],
                "timeout_exceeded": False,
            })
        elif step_num == current_step_num:
            # Current active step — dig into events
            started_at = step.get("started_at")
            if not started_at and last_hist:
                started_at = last_hist.get("started")

            # Search for relevant events for this step/agent/correlation
            has_acked = False
            has_done = False
            has_blocked = False
            last_activity_ts = None
            last_activity_type = None

            last_acked_ts = None
            for ev in all_events:
                if ev.get("from") not in agents_list:
                    continue
                ev_corr = ev.get("correlation_id", "")
                if pl_corr and ev_corr and ev_corr != pl_corr:
                    # Allow prefix match
                    if not (ev_corr.startswith(pl_corr) or pl_corr.startswith(ev_corr)):
                        continue
                if started_at:
                    if ev.get("ts", "") <= started_at:
                        continue
                ev_type = ev.get("type", "")
                ev_ts = ev.get("ts", "")
                if ev_type == "task.acked":
                    has_acked = True
                    if not last_acked_ts or ev_ts > last_acked_ts:
                        last_acked_ts = ev_ts
                    if not last_activity_ts or ev_ts > last_activity_ts:
                        last_activity_ts = ev_ts
                        last_activity_type = "task.acked"
                elif ev_type == "task.done":
                    has_done = True
                    if not last_activity_ts or ev_ts > last_activity_ts:
                        last_activity_ts = ev_ts
                        last_activity_type = "task.done"
                elif ev_type == "task.blocked":
                    has_blocked = True
                    if not last_activity_ts or ev_ts > last_activity_ts:
                        last_activity_ts = ev_ts
                        last_activity_type = "task.blocked"
                elif ev_type == "task.cancelled":
                    has_blocked = True  # treat cancelled similarly for diagnosis
                    if not last_activity_ts or ev_ts > last_activity_ts:
                        last_activity_ts = ev_ts
                        last_activity_type = "task.cancelled"
                elif ev_type in ("task.dispatch",):
                    if not last_activity_ts or ev_ts > last_activity_ts:
                        last_activity_ts = ev_ts
                        last_activity_type = ev_type

            # Elapsed calculation
            elapsed_str = ""
            if started_at:
                s = parse_iso(started_at)
                if s:
                    total_secs = (now_dt - s).total_seconds()
                    h = int(total_secs // 3600)
                    m = int((total_secs % 3600) // 60)
                    elapsed_str = f"{h}h{m}m"

            # Timeout check
            timeout_hours = step.get("timeout_hours")
            timeout_exceeded = False
            timeout_str = ""
            if timeout_hours and started_at:
                s = parse_iso(started_at)
                if s:
                    elapsed_h = (now_dt - s).total_seconds() / 3600
                    timeout_exceeded = elapsed_h >= timeout_hours
                    exceeded_label = " (⏰ EXCEEDED)" if timeout_exceeded else ""
                    timeout_str = f"{timeout_hours}h{exceeded_label}"

            details = []
            if not has_done and not has_blocked:
                details.append("⚠️ 无 task.done/blocked/cancelled 事件")
            # ACK-without-DONE detection
            if has_acked and not has_done and not has_blocked:
                if last_acked_ts:
                    acked_dt = parse_iso(last_acked_ts)
                    if acked_dt:
                        ack_elapsed_secs = (now_dt - acked_dt).total_seconds()
                        ack_elapsed_h = ack_elapsed_secs / 3600
                        ack_h = int(ack_elapsed_secs // 3600)
                        ack_m = int((ack_elapsed_secs % 3600) // 60)
                        if ack_elapsed_h > 2:
                            details.append(
                                f"🚨 ACK 后超过 2h 未完成 (ACK at {last_acked_ts}, elapsed {ack_h}h{ack_m}m)"
                            )
                        else:
                            details.append(
                                f"⚠️ ACK'd 但未完成 (ACK at {last_acked_ts}, elapsed {ack_h}h{ack_m}m)"
                            )
            if last_activity_ts and last_activity_type:
                details.append(f"最后活动: {last_activity_type} at {last_activity_ts}")
            if timeout_str:
                details.append(f"Timeout: {timeout_str}")

            last_dispatch_error = pipeline.get("last_dispatch_error") or {}
            if last_dispatch_error and last_dispatch_error.get("step") == step_num:
                rc = last_dispatch_error.get("returncode")
                target = last_dispatch_error.get("target")
                details.append(
                    f"🚨 最近一次 dispatch 失败: target={target} rc={rc} at {last_dispatch_error.get('at')}"
                )
                if last_dispatch_error.get("stderr"):
                    details.append(f"stderr: {last_dispatch_error.get('stderr')}")

            step_diags.append({
                "step_num": step_num,
                "agent": agent_str,
                "task": task,
                "status": "in_progress",
                "icon": "🔵",
                "elapsed": elapsed_str,
                "details": details,
                "timeout_exceeded": timeout_exceeded,
                "has_acked": has_acked,
                "has_done": has_done,
                "has_blocked": has_blocked,
                "last_acked_ts": last_acked_ts,
                "last_activity_ts": last_activity_ts,
                "last_activity_type": last_activity_type,
            })
        else:
            # Pending step
            step_diags.append({
                "step_num": step_num,
                "agent": agent_str,
                "task": task,
                "status": "pending",
                "icon": "⬜",
                "elapsed": "",
                "details": [],
                "timeout_exceeded": False,
            })

    # Build diagnosis conclusion
    conclusion = ""
    recommendation = ""
    current_diag = next(
        (d for d in step_diags if d["step_num"] == current_step_num), None
    )
    if current_diag:
        agent_str = current_diag["agent"]
        task_str = current_diag["task"]
        has_acked = current_diag.get("has_acked", False)
        has_done = current_diag.get("has_done", False)
        has_blocked = current_diag.get("has_blocked", False)
        timeout_exceeded = current_diag.get("timeout_exceeded", False)

        last_acked_ts_curr = current_diag.get("last_acked_ts")
        if pipeline.get("status") == "completed":
            conclusion = "Pipeline 已完成"
            recommendation = "无需处理"
        elif pipeline.get("status") == "completed_with_followups":
            review_result = pipeline.get("followup_review_result", "?")
            concerns = pipeline.get("followup_concerns", [])
            concerns_str = "; ".join(str(c) for c in concerns) if concerns else "（无详细信息）"
            conclusion = f"Pipeline 已完成但有待跟进事项 (review={review_result})"
            recommendation = f"处理 followup concerns: {concerns_str}"
        elif has_blocked:
            conclusion = f"Step {current_step_num} 被阻塞 — {agent_str} 报告 task.blocked"
            recommendation = "检查阻塞原因，修复后重新分配或手动 advance"
        elif has_done:
            conclusion = f"Step {current_step_num} 已完成但 pipeline 未推进"
            recommendation = "运行 pipeline-executor.py run 推进状态"
        elif has_acked and timeout_exceeded:
            conclusion = f"Step {current_step_num} 卡住 — {agent_str} 已 ACK 但未完成，且超时"
            recommendation = "PMO 介入或手动 advance"
        elif has_acked and last_acked_ts_curr:
            # ACK-without-DONE: check elapsed since ACK
            acked_dt = parse_iso(last_acked_ts_curr)
            if acked_dt:
                tz_cst = timezone(timedelta(hours=8))
                now_dt_c = datetime.now(tz_cst)
                ack_elapsed_h = (now_dt_c - acked_dt).total_seconds() / 3600
                if ack_elapsed_h > 2:
                    conclusion = (
                        f"Step {current_step_num} ⚠️ ACK'd 但未完成 — "
                        f"{agent_str} ACK 后超过 2h 无进展 ({ack_elapsed_h:.1f}h)"
                    )
                    recommendation = "PMO 介入，检查 agent 是否卡住，考虑手动 advance"
                else:
                    conclusion = f"Step {current_step_num} 进行中 — {agent_str} 已 ACK，等待完成"
                    recommendation = f"继续等待或检查 {agent_str} 状态"
            else:
                conclusion = f"Step {current_step_num} 进行中 — {agent_str} 已 ACK，等待完成"
                recommendation = f"继续等待或检查 {agent_str} 状态"
        elif has_acked:
            conclusion = f"Step {current_step_num} 进行中 — {agent_str} 已 ACK，等待完成"
            recommendation = f"继续等待或检查 {agent_str} 状态"
        elif timeout_exceeded:
            conclusion = f"Step {current_step_num} 超时 — {agent_str} 未响应"
            recommendation = f"PMO 介入，检查 {agent_str} 是否在线"
        else:
            conclusion = f"Step {current_step_num} 等待 {agent_str} 响应"
            recommendation = "等待 ACK 或检查消息是否已送达"

    return {
        "pipeline_id": pl_id,
        "status": pipeline.get("status", "?"),
        "current_step": current_step_num,
        "total_steps": total_steps,
        "correlation_id": pl_corr,
        "step_diags": step_diags,
        "conclusion": conclusion,
        "recommendation": recommendation,
    }


def cmd_diagnose(args):
    """Diagnose active pipelines: show step status, events, timeout, and conclusions."""
    pl_filter = getattr(args, "pipeline", None)
    output_json = getattr(args, "output_json", False)

    pipelines = load_active_pipelines(pl_filter)
    if not pipelines and pl_filter:
        pl = load_pipeline_by_id(pl_filter)
        if pl:
            pipelines = [pl]

    if not pipelines:
        if output_json:
            print(json.dumps([], ensure_ascii=False, indent=2))
        else:
            print(f"No active pipelines found in {ACTIVE_DIR}")
        return

    all_events = load_all_events()
    tz_cst = timezone(timedelta(hours=8))
    now_str = datetime.now(tz_cst).isoformat(timespec="seconds")

    if output_json:
        # JSON output mode: return list of diagnosis dicts
        results = []
        for pipeline in pipelines:
            diag = _diagnose_pipeline(pipeline, all_events)
            results.append(diag)
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return

    print(f"\n{'═'*63}")
    print(f"  Pipeline Diagnostics — {now_str}")
    print(f"{'═'*63}")

    for pipeline in pipelines:
        diag = _diagnose_pipeline(pipeline, all_events)
        pl_id = diag["pipeline_id"]
        status = diag["status"]
        current_step = diag["current_step"]
        total_steps = diag["total_steps"]
        corr = diag["correlation_id"]

        print(f"\nPipeline: {pl_id}")
        print(f"  Status: {status} | Step {current_step}/{total_steps}")
        print(f"  Correlation: {corr}")
        print()

        for sd in diag["step_diags"]:
            step_num = sd["step_num"]
            agent = sd["agent"]
            task = sd["task"]
            icon = sd["icon"]
            elapsed = sd["elapsed"]
            details = sd.get("details", [])

            elapsed_part = f" ({elapsed})" if elapsed else ""
            status_label = sd["status"]
            if status_label == "in_progress":
                status_label = f"in_progress (elapsed {elapsed})" if elapsed else "in_progress"
                elapsed_part = ""

            print(f"  {icon} Step {step_num}: {agent} → {task} {icon} {status_label}{elapsed_part}")
            for detail in details:
                print(f"    {detail}")

        if diag["conclusion"]:
            print(f"\n  诊断: {diag['conclusion']}")
        if diag["recommendation"]:
            print(f"  建议: {diag['recommendation']}")

    print(f"\n{'═'*63}\n")


# ── Subcommand: run ────────────────────────────────────────────────────────────

def cmd_run(args):
    """Main run: load active pipelines, process each."""
    dry_run   = args.dry_run
    pl_filter = getattr(args, "pipeline", None)
    strict    = getattr(args, "strict_mode", False)

    if dry_run:
        log("=== DRY-RUN mode: no files modified, no events dispatched ===")

    pipelines = load_active_pipelines(pl_filter)
    if not pipelines and pl_filter:
        pl = load_pipeline_by_id(pl_filter)
        if pl:
            pipelines = [pl]

    if not pipelines:
        log(f"No active pipelines found in {ACTIVE_DIR}")
        return

    log(f"Loaded {len(pipelines)} pipeline(s): {[pl['id'] for pl in pipelines]}")

    all_events = load_all_events()
    log(f"Loaded {len(all_events)} events from {EVENTS_DIR}")

    for pipeline in pipelines:
        log(f"--- Processing: {pipeline['id']} "
            f"(status={pipeline.get('status')}, "
            f"step={pipeline.get('current_step')}/{len(pipeline.get('steps', []))}) ---")
        try:
            process_pipeline(pipeline, all_events, dry_run=dry_run, strict=strict)
        except Exception as e:
            import traceback
            log(f"ERROR processing pipeline {pipeline.get('id')}: {e}")
            traceback.print_exc()

    log("Run complete.")


# ── Subcommand: status ─────────────────────────────────────────────────────────

def cmd_status(args):
    """Print status of all active (and recent) pipelines."""
    all_pipelines = load_all_pipelines()

    if not all_pipelines:
        print("No pipelines found.")
        return

    active = [p for p in all_pipelines if p.get("status") == "active"]
    paused = [p for p in all_pipelines if p.get("status") == "paused"]
    internally_completed = [p for p in all_pipelines if p.get("status") == "internally_completed"]
    completed_with_followups = [p for p in all_pipelines if p.get("status") == "completed_with_followups"]
    completed = [p for p in all_pipelines if p.get("status") == "completed"]
    failed = [p for p in all_pipelines if p.get("status") in ("failed", "timeout")]

    print(f"\n{'='*70}")
    print(f"  Pipeline Status — {now_iso()}")
    print(f"  Active: {len(active)} | Paused: {len(paused)} | "
          f"Pending Delivery: {len(internally_completed)} | "
          f"With Followups: {len(completed_with_followups)} | "
          f"Completed: {len(completed)} | Failed: {len(failed)}")
    print(f"{'='*70}")

    def print_pipeline(pl, prefix=""):
        pl_id = pl.get("id", "?")
        pl_name = pl.get("name", pl_id)
        pl_status = pl.get("status", "?")
        steps = pl.get("steps", [])
        current_step_num = pl.get("current_step", 1)
        total_steps = len(steps)

        status_icon = {
            "active": "🔵",
            "paused": "⏸️ ",
            "completed": "✅",
            "failed": "❌",
            "timeout": "⏰",
            "internally_completed": "📬",
            "completed_with_followups": "📋",
        }.get(pl_status, "❓")

        print(f"\n{prefix}{status_icon}  {pl_id}")
        if pl_name != pl_id:
            print(f"{prefix}    Name: {pl_name}")
        print(f"{prefix}    Status: {pl_status} | Step {min(current_step_num, total_steps)}/{total_steps}")

        for i, step in enumerate(steps):
            step_num = step.get("step", i + 1)
            agent = step.get("agent", "?")
            task = step.get("task", "?")
            next_s = step.get("next", "END")

            # Find history entry
            hist = None
            for rec in pl.get("step_history", []):
                if rec.get("step") == step_num:
                    hist = rec
                    # Prefer the last entry for this step
            if hist:
                result = hist.get("result") or "in_progress"
            elif step_num == current_step_num and pl_status == "active":
                result = "in_progress"
            elif step_num < current_step_num:
                result = "done"
            else:
                result = "pending"

            step_icon = {
                "done": "✅",
                "in_progress": "🔵",
                "failed_back": "🔄",
                "blocked": "❌",
                "max_cycles_exceeded": "❌",
                "pending": "⬜",
            }.get(result, "⬜")

            elapsed = ""
            if hist:
                if hist.get("started") and hist.get("completed"):
                    s = parse_iso(hist["started"])
                    c = parse_iso(hist["completed"])
                    if s and c:
                        h = int((c - s).total_seconds() // 3600)
                        m = int(((c - s).total_seconds() % 3600) // 60)
                        elapsed = f" ({h}h{m}m)"
                elif hist.get("started"):
                    s = parse_iso(hist["started"])
                    if s:
                        tz_cst = timezone(timedelta(hours=8))
                        now_dt = datetime.now(tz_cst)
                        h = int((now_dt - s).total_seconds() // 3600)
                        m = int(((now_dt - s).total_seconds() % 3600) // 60)
                        elapsed = f" (elapsed {h}h{m}m)"

            agent_str = agent if isinstance(agent, str) else "+".join(agent)
            print(f"{prefix}    {step_icon} Step {step_num}: {agent_str} → {task}{elapsed}  [next: {next_s}]")

    all_events_for_diag = load_all_events()

    def print_pipeline_with_diag(pl, prefix=""):
        print_pipeline(pl, prefix)
        # Diagnostic summary for active pipelines
        if pl.get("status") == "active":
            diag = _diagnose_pipeline(pl, all_events_for_diag)
            conclusion = diag.get("conclusion", "")
            if conclusion:
                print(f"{prefix}    ⚠️  {conclusion}")

    if active:
        print("\n── ACTIVE ────────────────────────────────────────────────────────────")
        for pl in active:
            print_pipeline_with_diag(pl)

    if paused:
        print("\n── PAUSED ────────────────────────────────────────────────────────────")
        for pl in paused:
            print_pipeline(pl)

    if completed_with_followups:
        print("\n── COMPLETED WITH FOLLOWUPS 📋 ───────────────────────────────────────")
        for pl in completed_with_followups:
            print_pipeline(pl)
            followup_status = pl.get("followup_status", "?")
            review_result = pl.get("followup_review_result", "?")
            concerns = pl.get("followup_concerns", [])
            print(f"    📋 Followup: status={followup_status}, review={review_result}")
            if concerns:
                for c in concerns:
                    print(f"       • {c}")

    if completed:
        print("\n── COMPLETED ─────────────────────────────────────────────────────────")
        for pl in completed:
            print_pipeline(pl)

    if failed:
        print("\n── FAILED/TIMEOUT ────────────────────────────────────────────────────")
        for pl in failed:
            print_pipeline(pl)

    print(f"\n{'='*70}\n")


# ── Subcommand: advance ────────────────────────────────────────────────────────

def cmd_advance(args):
    """PMO manually advances a pipeline step."""
    pl_id  = args.pipeline
    step_n = args.step
    result = args.result

    pl = load_pipeline_by_id(pl_id)
    if not pl:
        print(f"ERROR: pipeline '{pl_id}' not found in active/ or completed/")
        sys.exit(1)

    steps = pl.get("steps", [])
    if step_n < 1 or step_n > len(steps):
        print(f"ERROR: step {step_n} out of range (1-{len(steps)})")
        sys.exit(1)

    current_step_num = pl.get("current_step", 1)
    if step_n != current_step_num:
        print(f"WARN: Pipeline current_step={current_step_num}, you specified step={step_n}. Proceeding anyway.")

    step_def = steps[step_n - 1]
    agent = step_def.get("agent", "unknown")
    agent_str = agent if isinstance(agent, str) else "+".join(agent)
    task = step_def.get("task", "")
    step_next = step_def.get("next", "END")

    ts = now_iso()
    mark_step_done(pl, step_n, agent_str, ts, result, f"manual-advance-{ts}")

    print(f"Advanced pipeline '{pl_id}' step {step_n} ({agent_str} → {task}) → result={result}")

    if result == "done":
        if step_next == "END":
            pl["current_step"] = step_n + 1
            pending_delivery = notify_on_complete(pl, dry_run=False)
            if pending_delivery:
                pl["status"] = "internally_completed"
                save_pipeline(pl)
                # Do NOT move_to_completed — stay in active/ waiting for delivery confirmation
                print(f"Pipeline '{pl_id}' → INTERNALLY_COMPLETED (pending final delivery)")
            else:
                pl["status"] = "completed"
                save_pipeline(pl)
                move_to_completed(pl)
                print(f"Pipeline '{pl_id}' → COMPLETED")
        else:
            next_step_num = step_n + 1
            pl["current_step"] = next_step_num
            if next_step_num <= len(steps):
                mark_step_started(pl, steps[next_step_num - 1], ts)
            save_pipeline(pl)
            next_agents = step_next if isinstance(step_next, list) else [step_next]
            next_step_def = steps[next_step_num - 1] if next_step_num <= len(steps) else None
            next_task = next_step_def.get("task", "") if next_step_def else ""
            print(f"Pipeline '{pl_id}' → step {next_step_num} | agents={next_agents} | task={next_task}")
    else:
        save_pipeline(pl)
        print(f"Step marked as {result}. Pipeline remains at step {current_step_num}.")


# ── Subcommand: pause ──────────────────────────────────────────────────────────

def cmd_pause(args):
    """Pause an active pipeline."""
    pl_id = args.pipeline
    pl = load_pipeline_by_id(pl_id)
    if not pl:
        print(f"ERROR: pipeline '{pl_id}' not found")
        sys.exit(1)

    if pl.get("status") != "active":
        print(f"WARN: pipeline '{pl_id}' is {pl.get('status')}, not active. Pausing anyway.")

    pl["status"] = "paused"
    save_pipeline(pl)
    print(f"Pipeline '{pl_id}' paused.")


# ── Subcommand: resume ─────────────────────────────────────────────────────────

def cmd_resume(args):
    """Resume a paused pipeline."""
    pl_id = args.pipeline
    pl = load_pipeline_by_id(pl_id)
    if not pl:
        print(f"ERROR: pipeline '{pl_id}' not found")
        sys.exit(1)

    if pl.get("status") != "paused":
        print(f"WARN: pipeline '{pl_id}' is {pl.get('status')}, not paused. Resuming anyway.")

    pl["status"] = "active"
    save_pipeline(pl)
    print(f"Pipeline '{pl_id}' resumed.")


# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="A2A Pipeline Auto-Routing Executor (PRD v2.0)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Subcommands:
  run      Scan active pipelines and auto-dispatch based on Event Log
  status   Show current status of all pipelines
  diagnose Show detailed diagnostics for active pipelines (step events, timeouts)
  advance  Manually advance a pipeline step (PMO intervention)
  pause    Pause a pipeline
  resume   Resume a paused pipeline

Examples:
  python3 pipeline-executor.py run
  python3 pipeline-executor.py run --dry-run
  python3 pipeline-executor.py run --pipeline proj-012-v1.0.2
  python3 pipeline-executor.py status
  python3 pipeline-executor.py diagnose
  python3 pipeline-executor.py diagnose --pipeline proj-012-v1.0.2
  python3 pipeline-executor.py advance --pipeline proj-012-v1.0.2 --step 2 --result done
  python3 pipeline-executor.py pause --pipeline proj-012-v1.0.2
  python3 pipeline-executor.py resume --pipeline proj-012-v1.0.2
        """,
    )

    sub = parser.add_subparsers(dest="command")

    # ── run ──
    run_p = sub.add_parser("run", help="Scan and advance pipelines")
    run_p.add_argument("--dry-run", action="store_true", help="Print actions without modifying state")
    run_p.add_argument("--pipeline", metavar="ID", help="Process only specified pipeline ID")
    run_p.add_argument("--strict-mode", action="store_true",
                       help="Require exact correlation_id match (default: prefix match)")

    # ── status ──
    sub.add_parser("status", help="Show pipeline status")

    # ── advance ──
    adv_p = sub.add_parser("advance", help="Manually advance a pipeline step")
    adv_p.add_argument("--pipeline", required=True, metavar="ID", help="Pipeline ID")
    adv_p.add_argument("--step", required=True, type=int, metavar="N", help="Step number to advance")
    adv_p.add_argument("--result", default="done",
                       choices=["done", "blocked", "failed", "cancelled"],
                       help="Result to record (default: done)")

    # ── diagnose ──
    diag_p = sub.add_parser("diagnose", help="Diagnose active pipelines (step status, timeouts, conclusions)")
    diag_p.add_argument("--pipeline", metavar="ID", default=None,
                        help="Diagnose only specified pipeline ID (default: all active)")
    diag_p.add_argument("--json", dest="output_json", action="store_true",
                        help="Output as JSON for PMO API")

    # ── pause ──
    pause_p = sub.add_parser("pause", help="Pause a pipeline")
    pause_p.add_argument("--pipeline", required=True, metavar="ID", help="Pipeline ID")

    # ── resume ──
    resume_p = sub.add_parser("resume", help="Resume a paused pipeline")
    resume_p.add_argument("--pipeline", required=True, metavar="ID", help="Pipeline ID")

    args = parser.parse_args()

    if args.command == "run":
        cmd_run(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "diagnose":
        cmd_diagnose(args)
    elif args.command == "advance":
        cmd_advance(args)
    elif args.command == "pause":
        cmd_pause(args)
    elif args.command == "resume":
        cmd_resume(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
