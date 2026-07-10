#!/usr/bin/env python3
"""P0-6 patch for a2a-log.py: compensate-dispatches 重试耗尽/唤醒无响应 → 强制独立告警 + watermark 语义对齐。"""
p = "/Users/0xfg_bot/.openclaw/scripts/a2a-log.py"
s = open(p).read()

# 1) helper after _append_escalation_for_compensation
anchor1 = '''    next_seq = _locked_append_event("cron", escalation_event)
    _hook_notify_recipients_on_write(escalation_event)
    return {"status": "escalated", "seq": next_seq}
'''
helper = anchor1 + '''

def _compensation_webhook_alert(escalations: list, dry_run: bool = False) -> bool:
    """P0-6: 补偿升级时直发 Discord webhook(独立于 A2A 通道,防循环依赖)。best-effort,失败不阻塞。"""
    if dry_run or not escalations:
        return False
    try:
        import urllib.request
        url_path = os.path.expanduser("~/.openclaw/config/notify-webhook.url")
        with open(url_path) as f:
            url = f.read().strip()
        lines = [
            "- {}:{} -> {} topic={} age={}m attempts={} last={}".format(
                e.get("from"), e.get("seq"), e.get("target_agent"), e.get("topic"),
                e.get("age_minutes"), e.get("attempts"), e.get("last_outcome"))
            for e in escalations[:10]
        ]
        content = "🚨 [a2a-compensate] dispatch 补偿升级(重试耗尽/唤醒无响应):\\n" + "\\n".join(lines)
        req = urllib.request.Request(
            url,
            data=json.dumps({"content": content[:1900]}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:
        print("[warn] compensation webhook failed: {}".format(exc), file=sys.stderr)
        return False
'''
assert s.count(anchor1) == 1, "anchor1"
s = s.replace(anchor1, helper)

# 2) watermark gate in candidate loop
anchor2 = '''            if target_agent and to_agent != target_agent:
                continue

            attempts = _hook_c_attempts_for_event(ev, to_agent, audit_records)'''
gate = '''            if target_agent and to_agent != target_agent:
                continue

            # P0-6: respect pending watermark — watermark 之下的历史事件不参与补偿(与 pending/Hook-C 语义一致)
            wm = _compensate_wm_cache.get(to_agent)
            if wm is None:
                wm = _load_watermark(to_agent)
                _compensate_wm_cache[to_agent] = wm
            try:
                if int(ev_seq) <= int(wm.get(ev_from, -1)):
                    continue
            except (TypeError, ValueError):
                pass

            attempts = _hook_c_attempts_for_event(ev, to_agent, audit_records)'''
assert s.count(anchor2) == 1, "anchor2"
s = s.replace(anchor2, gate)

# 2b) init cache
anchor2b = '''    candidates = []
    actions = []
'''
assert s.count(anchor2b) == 1, "anchor2b"
s = s.replace(anchor2b, anchor2b + "    _compensate_wm_cache = {}\n")

# 3) decision block
anchor3 = '''    for candidate, event in candidates:
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
        elif retryable:'''
newdec = '''    escalated_now = []
    for candidate, event in candidates:
        retryable = candidate["last_outcome"] in (None, "no_session", "wake_failed", "duplicate_skip")
        # P0-6: wake 已送达但长时间无人 ACK —— 不再静默跳过,升级并独立告警
        wake_sent_stale = (
            candidate["last_outcome"] == "wake_sent"
            and candidate["age_minutes"] >= max(stale_minutes * 3, 30)
        )
        if (candidate["attempts"] >= max_retries and candidate["last_outcome"] in ("no_session", "wake_failed")) or wake_sent_stale:
            if wake_sent_stale:
                reason = f"wake_sent but no ACK for {candidate['age_minutes']}m (consumer stalled)"
            else:
                reason = f"dispatch stale > {stale_minutes}m and Hook-C failed {candidate['attempts']} times"
            result = _append_escalation_for_compensation(
                event,
                candidate["target_agent"],
                candidate["attempts"],
                reason,
                dry_run=dry_run,
            )
            actions.append({**candidate, "action": "escalate", "result": result})
            if result.get("status") == "escalated":
                escalated_now.append(candidate)
        elif retryable:'''
assert s.count(anchor3) == 1, "anchor3"
s = s.replace(anchor3, newdec)

# 4) webhook + output key
anchor4 = '''    print(json.dumps({
        "status": "ok",
        "stale_minutes": stale_minutes,'''
newout = '''    webhook_sent = _compensation_webhook_alert(escalated_now, dry_run=dry_run)

    print(json.dumps({
        "status": "ok",
        "webhook_sent": webhook_sent,
        "stale_minutes": stale_minutes,'''
assert s.count(anchor4) == 1, "anchor4"
s = s.replace(anchor4, newout)

open(p, "w").write(s)
print("all 5 patches applied")
