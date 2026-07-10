#!/usr/bin/env python3
"""P0-4 patch for a2a-log.py: closeout→DONE 事务顺序。
非 Discord 起源的 done 必须先同步回写 origin surface 成功,才提交 task.done;
失败则保持非终态,记 audit/closeout-failed.jsonl sidecar + 独立 webhook 告警。
Discord 起源与缺 session_key 的路径行为不变。新增向后兼容旗标 --skip-closeout-gate。"""
p = "/Users/0xfg_bot/.openclaw/scripts/a2a-log.py"
s = open(p).read()

# A) 新函数,插在 _notify_non_discord_closeout 之前
anchorA = '''def _notify_non_discord_closeout(event: dict) -> None:'''
newfuncs = '''def _closeout_gate_check(event: dict):
    """P0-4: 非 Discord 起源的 done,先同步回写 origin surface。返回 (needed, ok, detail)。
    needed=False 表示无需门禁(discord 起源 / 无 closeout_target / 缺 session_key,维持既有行为)。"""
    routing = event.get("routing", {}) or {}
    closeout_target = routing.get("closeout_target") or {}
    if not isinstance(closeout_target, dict):
        return (False, True, "no-closeout-target")
    surface = closeout_target.get("surface") or routing.get("origin_surface") or "discord"
    if surface == "discord":
        return (False, True, "discord-surface")
    session_key = closeout_target.get("session_key") or routing.get("origin_session_key")
    if not session_key:
        return (False, True, "missing-session-key")
    payload = event.get("payload", {}) or {}
    summary = payload.get("summary") or "(no summary)"
    msg = (
        "[A2A Closeout] {} from {} | topic: {} | ref: {}\\n"
        "summary: {}\\n"
        "请把这个结果转述给当前用户，并在需要时继续追问或收口。"
    ).format(event.get("type"), event.get("from"), event.get("topic"),
             event.get("causation_id") or "-", summary)
    try:
        r = subprocess.run(
            [shutil.which("openclaw") or "/opt/homebrew/bin/openclaw",
             "sessions", "send", "--session-key", str(session_key), "--message", msg],
            capture_output=True, text=True, timeout=20,
        )
        if r.returncode == 0:
            sys.stderr.write("[closeout-gate] writeback OK -> {} {}\\n".format(surface, session_key))
            return (True, True, "ok")
        return (True, False, "rc={} err={}".format(r.returncode, (r.stderr or r.stdout or "")[:200]))
    except Exception as exc:
        return (True, False, "exception: {}".format(exc))


def _record_closeout_failure(event: dict, detail: str) -> None:
    """P0-4: closeout 失败 → sidecar 记录(不动 schema、不进事件日志)+ 独立 webhook 告警。"""
    try:
        rec = {
            "ts": now_iso(),
            "kind": "closeout_failed",
            "agent": event.get("from"),
            "topic": event.get("topic"),
            "causation_id": event.get("causation_id"),
            "origin_surface": (event.get("routing", {}) or {}).get("origin_surface"),
            "session_key": (event.get("routing", {}) or {}).get("origin_session_key"),
            "detail": detail,
        }
        path = os.path.join(BASE_DIR, "audit", "closeout-failed.jsonl")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\\n")
    except Exception as exc:
        sys.stderr.write("[closeout-gate] sidecar write failed: {}\\n".format(exc))
    try:
        import urllib.request
        with open(os.path.expanduser("~/.openclaw/config/notify-webhook.url")) as f:
            url = f.read().strip()
        content = "🚨 [a2a-closeout] DONE 未提交:origin surface 回写失败 | topic={} ref={} detail={}".format(
            event.get("topic"), event.get("causation_id"), detail[:200])
        req = urllib.request.Request(
            url, data=json.dumps({"content": content[:1900]}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "a2a-closeout/1.0"})
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass


def _notify_non_discord_closeout(event: dict) -> None:'''
assert s.count(anchorA) == 1, "anchorA"
s = s.replace(anchorA, newfuncs)

# B) cmd_done: 门禁前置 + 提交后不再重复 closeout
anchorB = '''    # Atomically assign seq and append to the done agent's file (NOT the source file — immutable log)
    next_seq = _locked_append_event(agent, done_event)
    _hook_notify_recipients_on_write(done_event)
    _notify_non_discord_closeout(done_event)'''
newB = '''    # P0-4: closeout→DONE 事务顺序 —— 非 Discord 起源必须先回写成功,再提交终态
    gate_needed, gate_ok, gate_detail = _closeout_gate_check(done_event)
    if gate_needed and not gate_ok and not getattr(args, "skip_closeout_gate", False):
        _record_closeout_failure(done_event, gate_detail)
        print(json.dumps({
            "status": "closeout_failed",
            "error": "origin surface writeback failed; task.done NOT committed (P0-4 transaction order)",
            "detail": gate_detail,
            "hint": "retry later, or pass --skip-closeout-gate to bypass (failure already audited)",
            "seq": seq,
            "file": source_file,
        }, ensure_ascii=False))
        sys.exit(1)

    # Atomically assign seq and append to the done agent's file (NOT the source file — immutable log)
    next_seq = _locked_append_event(agent, done_event)
    _hook_notify_recipients_on_write(done_event)
    if not gate_needed:
        _notify_non_discord_closeout(done_event)  # 既有路径(discord/缺 key)行为不变;门禁已回写的不重复发'''
assert s.count(anchorB) == 1, "anchorB"
s = s.replace(anchorB, newB)

# C) argparse: --skip-closeout-gate
anchorC = '''    p_done.add_argument("--correlation-id", dest="correlation_id", default=None,
                        help="Override correlation ID (default: inherited from original event)")'''
newC = anchorC + '''
    p_done.add_argument("--skip-closeout-gate", dest="skip_closeout_gate", action="store_true",
                        help="P0-4 escape hatch: commit done even if origin-surface writeback failed (failure is audited)")'''
assert s.count(anchorC) == 1, "anchorC"
s = s.replace(anchorC, newC)

open(p, "w").write(s)
print("P0-4 patches applied (3/3)")
