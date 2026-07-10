#!/usr/bin/env python3
"""
a2a-backlog-watchdog.py — A2A Event Log 独立看门狗
====================================================
P0-1 of A2A-EventLog-整体优化方案-v2.0 (draft-6, 4.0-1)。

原则:零 token、不经 A2A 通道、不依赖 gateway。
巡检项:
  1. 各 agent pending 积压(数量 + 最老事件年龄)
  2. 关键 producer 事件产出速率(连续 N 小时零产出)
  3. launchd 关键服务加载状态("写了没开"是已证实的失败模式,D4)
  4. gateway FD 占用数(FD 泄漏 → exec spawn EBADF → 唤醒失效,07-04~06 已证实)
告警:直发 Discord webhook(~/.openclaw/config/notify-webhook.url)。
反骚扰:同一告警键 60 分钟冷却;恢复时发一条 resolved;每日 09:00-10:00 窗口发 heartbeat。

用法:
  a2a-backlog-watchdog.py            # 单次巡检(由 launchd StartInterval 驱动)
  a2a-backlog-watchdog.py --dry-run  # 巡检但不发送,打印将发送的内容
  a2a-backlog-watchdog.py --test     # 发送一条测试告警验证 webhook

作者: Claude (P0 implementation) | 2026-07-07
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
A2A_LOG = HOME / ".openclaw" / "scripts" / "a2a-log.py"
EVENTS_DIR = HOME / ".openclaw" / "workspace" / "state" / "a2a-log" / "events"
WEBHOOK_FILE = HOME / ".openclaw" / "config" / "notify-webhook.url"
STATE_FILE = HOME / ".openclaw" / "state" / "a2a-watchdog-state.json"

# ---------------- 配置 ----------------
# pending 巡检对象与阈值
PENDING_AGENTS = ["issac", "ansen", "elon2", "satoshi2", "wiki"]
PENDING_COUNT_WARN = 5          # pending 条数阈值
PENDING_AGE_WARN_MIN = 30       # 最老 pending 年龄阈值(分钟)

# 产出速率:producer 文件 -> 允许的最大静默小时数
PRODUCER_SILENCE_HOURS = {
    "automation-runner": 2,     # 常态每 15 分钟一条
    "issac": 8,
    "ansen": 24,
    "cron": 30,
}

# launchd 关键服务(必须处于已加载状态)
CRITICAL_SERVICES = [
    "ai.openclaw.gateway",
    "ai.openclaw.a2a-signal-consumer",
    "ai.openclaw.a2a-watcher-oc",
    "ai.openclaw.automation-runner",
    "ai.openclaw.headless-bridge",
    "ai.openclaw.pipeline-executor",
    "com.openclaw.a2a-backlog-watchdog",  # 自检
]

# gateway FD 阈值
FD_WARN = 6000
FD_CRIT = 9000

ALERT_COOLDOWN_S = 3600         # 同一告警键冷却
HEARTBEAT_WINDOW = (9, 10)      # 本地时区每日心跳窗口 [9:00,10:00)
PENDING_TIMEOUT_S = 90
# --------------------------------------


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1))
    os.replace(tmp, STATE_FILE)


def send_webhook(content: str, dry_run: bool = False) -> bool:
    if dry_run:
        log(f"DRY-RUN would send:\n{content}")
        return True
    try:
        url = WEBHOOK_FILE.read_text().strip()
        req = urllib.request.Request(
            url,
            data=json.dumps({"content": content[:1900]}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "a2a-watchdog/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception as e:
        log(f"ERROR webhook send failed: {e}")
        return False


# ---------------- 巡检 1: pending 积压 ----------------
def check_pending() -> tuple[list[str], dict]:
    alerts, detail = [], {}
    for agent in PENDING_AGENTS:
        try:
            r = subprocess.run(
                [sys.executable, str(A2A_LOG), "pending", "--agent", agent],
                capture_output=True, text=True, timeout=PENDING_TIMEOUT_S,
            )
            d = json.loads(r.stdout)
            count = d.get("count", 0)
            oldest_age_min = 0.0
            oldest_ts = None
            if d.get("events"):
                tss = []
                for e in d["events"]:
                    try:
                        tss.append(datetime.fromisoformat(e["ts"]))
                    except Exception:
                        pass
                if tss:
                    oldest = min(tss)
                    oldest_ts = oldest.isoformat()
                    oldest_age_min = (now_utc() - oldest).total_seconds() / 60
            detail[agent] = {"count": count, "oldest_age_min": round(oldest_age_min)}
            if count >= PENDING_COUNT_WARN or oldest_age_min > PENDING_AGE_WARN_MIN:
                alerts.append(
                    f"⚠️ **pending 积压** `{agent}`: {count} 条,最老 {oldest_age_min/60:.1f}h ({oldest_ts})"
                )
        except Exception as e:
            detail[agent] = {"error": str(e)[:120]}
            alerts.append(f"🔥 **pending 查询失败** `{agent}`: {str(e)[:120]}")
    return alerts, detail


# ---------------- 巡检 2: 产出速率 ----------------
def last_event_ts(fname: str):
    p = EVENTS_DIR / f"{fname}.jsonl"
    if not p.exists():
        return None
    try:
        with open(p, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 16384))
            lines = f.read().decode("utf-8", "ignore").strip().splitlines()
        for line in reversed(lines):
            try:
                return datetime.fromisoformat(json.loads(line)["ts"])
            except Exception:
                continue
    except Exception:
        pass
    return None


def check_production() -> tuple[list[str], dict]:
    alerts, detail = [], {}
    for producer, max_h in PRODUCER_SILENCE_HOURS.items():
        ts = last_event_ts(producer)
        if ts is None:
            alerts.append(f"🔥 **producer 无法读取** `{producer}`")
            detail[producer] = {"error": "unreadable"}
            continue
        silent_h = (now_utc() - ts).total_seconds() / 3600
        detail[producer] = {"silent_h": round(silent_h, 1)}
        if silent_h > max_h:
            alerts.append(
                f"⚠️ **产出停滞** `{producer}`: 已 {silent_h:.1f}h 零事件(阈值 {max_h}h,最后 {ts.isoformat()})"
            )
    return alerts, detail


# ---------------- 巡检 3: launchd 加载状态 ----------------
def check_launchd() -> tuple[list[str], dict]:
    alerts, detail = [], {}
    uid = os.getuid()
    for label in CRITICAL_SERVICES:
        r = subprocess.run(
            ["launchctl", "print", f"gui/{uid}/{label}"],
            capture_output=True, text=True, timeout=15,
        )
        loaded = r.returncode == 0
        detail[label] = "loaded" if loaded else "NOT-LOADED"
        if not loaded:
            alerts.append(f"🔥 **launchd 服务未加载** `{label}`(写了没开 = D4 失败模式)")
    return alerts, detail


# ---------------- 巡检 4: gateway FD ----------------
def check_gateway_fd() -> tuple[list[str], dict]:
    alerts, detail = [], {}
    uid = os.getuid()
    try:
        r = subprocess.run(
            ["launchctl", "print", f"gui/{uid}/ai.openclaw.gateway"],
            capture_output=True, text=True, timeout=15,
        )
        m = re.search(r"^\s*pid = (\d+)", r.stdout, re.M)
        if not m:
            detail["gateway"] = "no-pid"
            return alerts, detail
        pid = m.group(1)
        r2 = subprocess.run(["lsof", "-nP", "-p", pid], capture_output=True, text=True, timeout=60)
        fd_count = max(0, len(r2.stdout.splitlines()) - 1)
        detail["gateway"] = {"pid": int(pid), "fd": fd_count}
        if fd_count >= FD_CRIT:
            alerts.append(
                f"🔥 **gateway FD 危险** pid={pid} fd={fd_count} (≥{FD_CRIT})。"
                f"FD 泄漏→spawn EBADF→唤醒失效链条已在 07-04~06 发生过,建议尽快受控重启"
            )
        elif fd_count >= FD_WARN:
            alerts.append(f"⚠️ **gateway FD 偏高** pid={pid} fd={fd_count} (≥{FD_WARN})")
    except Exception as e:
        detail["gateway"] = {"error": str(e)[:120]}
    return alerts, detail


# ---------------- 主流程 ----------------
def run(dry_run: bool = False) -> int:
    state = load_state()
    sent = state.setdefault("sent", {})
    now = time.time()

    all_alerts: list[tuple[str, str]] = []  # (alert_key, message)
    a1, d1 = check_pending()
    a2, d2 = check_production()
    a3, d3 = check_launchd()
    a4, d4 = check_gateway_fd()
    for msg in a1 + a2 + a3 + a4:
        key = re.sub(r"[0-9]+(\.[0-9]+)?", "#", msg)[:120]  # 数值归一化作为告警键
        all_alerts.append((key, msg))

    summary = {"pending": d1, "production": d2, "launchd": d3, "fd": d4}
    log(f"scan done: {len(all_alerts)} alert(s) | {json.dumps(summary, ensure_ascii=False)}")

    # 冷却过滤后发送
    to_send = [m for k, m in all_alerts if now - sent.get(k, 0) > ALERT_COOLDOWN_S]
    if to_send:
        body = "🐶 **[a2a-watchdog]**\n" + "\n".join(to_send)
        if send_webhook(body, dry_run):
            for k, m in all_alerts:
                if m in to_send:
                    sent[k] = now

    # 恢复通知:上轮有告警、本轮全清
    if not all_alerts and state.get("last_alert_count", 0) > 0:
        send_webhook("🐶 [a2a-watchdog] ✅ 所有巡检项恢复正常", dry_run)
    state["last_alert_count"] = len(all_alerts)

    # 每日心跳
    lh = state.get("heartbeat_ts", 0)
    local_hour = datetime.now().hour
    if HEARTBEAT_WINDOW[0] <= local_hour < HEARTBEAT_WINDOW[1] and now - lh > 20 * 3600:
        hb = (
            f"🐶 [a2a-watchdog] 每日心跳 | pending: "
            + ", ".join(f"{a}:{v.get('count','?')}" for a, v in d1.items())
            + f" | gateway fd: {d4.get('gateway',{}).get('fd','?') if isinstance(d4.get('gateway'),dict) else '?'}"
            + f" | 当前告警: {len(all_alerts)}"
        )
        if send_webhook(hb, dry_run):
            state["heartbeat_ts"] = now

    # 清理过期冷却键
    state["sent"] = {k: v for k, v in sent.items() if now - v < 7 * 86400}
    if not dry_run:
        save_state(state)
    return 0


def main() -> int:
    args = sys.argv[1:]
    if "--test" in args:
        ok = send_webhook("🐶 [a2a-watchdog] 测试告警:webhook 通道正常(P0-1 部署验证)")
        log(f"test alert sent: {ok}")
        return 0 if ok else 1
    return run(dry_run="--dry-run" in args)


if __name__ == "__main__":
    sys.exit(main())
