#!/usr/bin/env python3
"""
A2A v2.0 双通道消息发送库
用法:
  python3 a2a-send.py --method task.dispatch --from issac --to ansen --thread thread_001 \
    --params '{"title":"任务描述","priority":"P1","ack_required":true}'
  python3 a2a-send.py --method task.dispatch --from issac --to ansen --thread thread_001 \
    --params '{"title":"任务描述","priority":"P1"}' --dry-run
"""

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone, timedelta

from a2a_routing import get_display_label

REGISTRY_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "../workspace/agents/registry.json"
)

A2A_SYNC_CHANNEL = "1477264532954026086"
WORKSPACE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../workspace")


def load_registry() -> dict:
    with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_agent(registry: dict, agent_id: str) -> dict:
    rel_path = registry["agents"].get(agent_id)
    if not rel_path:
        raise ValueError(f"Agent '{agent_id}' not found in registry")
    agent_path = os.path.join(WORKSPACE_DIR, rel_path)
    with open(agent_path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_session_key(agent_id: str, session_key: str, channel_id: str) -> str:
    """强制使用 agent 固定 session key，防止按活跃会话误路由。"""
    canonical = f"agent:{agent_id}:discord:channel:{channel_id}"
    if not session_key:
        return canonical

    expected_suffix = f":discord:channel:{channel_id}"
    if not str(session_key).endswith(expected_suffix):
        print(
            f"[WARN] session_key mismatch for {agent_id}: {session_key} (expect *{expected_suffix}), force canonical",
            file=sys.stderr,
        )
        return canonical

    if str(session_key).startswith("agent:main:") and agent_id not in ("main", "issac"):
        print(
            f"[WARN] invalid session_key prefix for {agent_id}: {session_key}, force canonical",
            file=sys.stderr,
        )
        return canonical

    return session_key


def build_message(method: str, from_agent: str, to_agent: str, thread_id: str, params: dict, session_key: str = "") -> dict:
    """构造 A2A v2.0 标准消息体"""
    now = datetime.now(tz=timezone(timedelta(hours=8)))
    # C1 fix: 使用 agent+时间戳ms+随机后缀，消除碰撞风险
    msg_id = f"msg_{from_agent}_{int(time.time()*1000)}_{uuid.uuid4().hex[:6]}"
    return {
        "v": "2.0",
        "id": msg_id,
        "method": method,
        "from": from_agent,
        "to": to_agent,
        "thread_id": thread_id,
        "timestamp": now.isoformat(),
        # C2 fix: 携带 session_key 供接收方验证 from 身份（短期方案）
        # TODO: 中期加 HMAC 签名（用 shared secret 对消息体签名，防伪造）
        "_session_key": session_key,
        "params": params
    }


def format_human_readable(method: str, from_agent: str, to_agent: str, thread_id: str, params: dict) -> str:
    """构造人类可读摘要（用于 A2A 同步频道）"""
    summary_keys = ["title", "priority", "status", "ack_required", "description", "reason", "error_code"]
    summary_lines = []
    for k in summary_keys:
        if k in params:
            summary_lines.append(f"  {k}: {params[k]}")
    extra = [(k, v) for k, v in params.items() if k not in summary_keys]
    for k, v in extra[:3]:
        summary_lines.append(f"  {k}: {v}")

    summary = "\n".join(summary_lines) if summary_lines else "  (no params)"

    try:
        from_label = get_display_label(from_agent, short=True)
    except Exception:
        from_label = from_agent
    try:
        to_label = get_display_label(to_agent, short=True)
    except Exception:
        to_label = to_agent

    return (
        f"📨 [A2A v2.0] {method}\n"
        f"FROM: {from_label} ({from_agent})\n"
        f"TO: {to_label} ({to_agent})\n"
        f"Thread: {thread_id}\n"
        f"{summary}"
    )


def run_cmd(cmd: list, dry_run: bool = False) -> tuple[bool, str]:
    """运行 shell 命令，返回 (success, output)"""
    if dry_run:
        print(f"  [DRY-RUN] {' '.join(cmd)}", file=sys.stderr)
        return True, f"dry-run-ok"
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            return True, result.stdout.strip()
        else:
            return False, result.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, "command timed out"
    except Exception as e:
        return False, str(e)


def send_a2a(
    method: str,
    from_agent: str,
    to_agent: str,
    thread_id: str,
    params: dict,
    dry_run: bool = False
) -> dict:
    registry = load_registry()
    target = load_agent(registry, to_agent)

    # C2: 同时加载发送方的 session_key，嵌入消息供接收方验证身份
    from_agent_data = load_agent(registry, from_agent) if from_agent in registry.get("agents", {}) else {}
    from_channel_id = from_agent_data.get("channels", {}).get("discord", {}).get("channel_id", "")
    from_session_key_raw = from_agent_data.get("session_key", "")
    from_session_key = normalize_session_key(from_agent, from_session_key_raw, from_channel_id) if from_channel_id else from_session_key_raw

    target_channel_id = target.get("channels", {}).get("discord", {}).get("channel_id", "")
    target_session_key_raw = target.get("session_key", "")
    target_session_key = normalize_session_key(to_agent, target_session_key_raw, target_channel_id) if target_channel_id else target_session_key_raw

    msg = build_message(method, from_agent, to_agent, thread_id, params, session_key=from_session_key)
    msg_json = json.dumps(msg, ensure_ascii=False)
    human_text = format_human_readable(method, from_agent, to_agent, thread_id, params)

    result = {
        "ok": False,
        "id": msg["id"],
        "method": method,
        "from": from_agent,
        "to": to_agent,
        "thread_id": thread_id,
        "a2a_sent": False,
        "discord_sent": False,
        "dry_run": dry_run,
        "errors": []
    }

    # 通道 1: openclaw sessions send（主通道，失败则标记失败）
    print(f"[A2A] 通道1: sessions send → {target_session_key}", file=sys.stderr)
    ok1, out1 = run_cmd(
        ["openclaw", "sessions", "send", "--session-key", target_session_key, "--message", msg_json],
        dry_run=dry_run
    )
    if ok1:
        result["a2a_sent"] = True
    else:
        result["errors"].append(f"sessions send failed: {out1}")
        print(f"  [WARN] 通道1失败: {out1}", file=sys.stderr)

    # C4 fix: 通道 2 Discord 改为 best-effort，失败不影响整体结果
    # 区分 a2a_sent / discord_sent，接收方可独立判断各通道状态
    print(f"[A2A] 通道2: discord sync → {A2A_SYNC_CHANNEL}", file=sys.stderr)
    try:
        ok2, out2 = run_cmd(
            ["openclaw", "message", "send",
             "--channel", "discord",
             "--target", A2A_SYNC_CHANNEL,
             "--message", human_text],
            dry_run=dry_run
        )
        if ok2:
            result["discord_sent"] = True
        else:
            result["discord_sent"] = False
            result["discord_error"] = out2
            print(f"  [WARN] 通道2失败（best-effort，不影响结果）: {out2}", file=sys.stderr)
    except Exception as e:
        result["discord_sent"] = False
        result["discord_error"] = str(e)
        print(f"  [WARN] 通道2异常（best-effort，不影响结果）: {e}", file=sys.stderr)

    # ok 以 A2A 主通道为准（Discord 是审计副本，非必要通道）
    result["ok"] = result["a2a_sent"]
    return result


def main():
    parser = argparse.ArgumentParser(
        description="A2A v2.0 消息发送工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument("--method", required=True, help="A2A 方法名，如 task.dispatch")
    parser.add_argument("--from", dest="from_agent", required=True, help="发送方 agent_id")
    parser.add_argument("--to", dest="to_agent", required=True, help="接收方 agent_id")
    parser.add_argument("--thread", dest="thread_id", required=True, help="Thread ID")
    parser.add_argument("--params", default="{}", help="JSON 格式的参数")
    parser.add_argument("--dry-run", action="store_true", help="不真正发送，仅模拟")
    parser.add_argument("--pretty", action="store_true", help="美化 JSON 输出")

    args = parser.parse_args()

    try:
        params = json.loads(args.params)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"params JSON parse error: {e}"}))
        sys.exit(1)

    try:
        result = send_a2a(
            method=args.method,
            from_agent=args.from_agent,
            to_agent=args.to_agent,
            thread_id=args.thread_id,
            params=params,
            dry_run=args.dry_run
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)

    indent = 2 if args.pretty else None
    print(json.dumps(result, ensure_ascii=False, indent=indent))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
