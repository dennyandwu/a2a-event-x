#!/usr/bin/env python3
"""
A2A Message Monitor — 方案三 (JSONL 监听)
监听 OpenClaw inter_session 消息并同步到 Discord 频道。

作者: Ansen (运维主管)
版本: 1.0.0
"""

import json
import os
import sys
import time
import glob
import logging
import requests
from pathlib import Path
from datetime import datetime, timezone, timedelta

from a2a_routing import format_session_label

# === 配置 ===
AGENTS_DIR = Path.home() / ".openclaw" / "agents"
CURSOR_FILE = Path.home() / ".openclaw" / "a2a-cursor.json"
DISCORD_CHANNEL_ID = "1477264532954026086"
POLL_INTERVAL = 3  # 秒
MAX_DISCORD_MSG_LEN = 1900  # Discord 2000 char limit with margin
LOG_FILE = "/tmp/openclaw/a2a-monitor.log"
# Dedup: keep last N message hashes to prevent re-sending on cursor reset
DEDUP_MAX = 500

# 从 openclaw.json 读取 bot token
OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"

# 时区
CST = timezone(timedelta(hours=8))

# === 日志 ===
os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("a2a-monitor")


def get_bot_token() -> str:
    """从 openclaw.json 读取 default (Issac) bot token — 有 sync 频道权限"""
    with open(OPENCLAW_CONFIG) as f:
        config = json.load(f)
    return config["channels"]["discord"]["accounts"]["default"]["token"]


def load_cursors() -> dict:
    """加载文件读取游标 {filepath: byte_offset}"""
    if CURSOR_FILE.exists():
        try:
            with open(CURSOR_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            log.warning("游标文件损坏，重新初始化")
    return {}


def save_cursors(cursors: dict):
    """保存文件读取游标"""
    tmp = str(CURSOR_FILE) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cursors, f, indent=2)
    os.rename(tmp, str(CURSOR_FILE))


def load_session_map() -> dict:
    """加载所有 agents 的 session key → sessionId 映射"""
    session_map = {}  # sessionId → sessionKey
    for sessions_json in AGENTS_DIR.glob("*/sessions/sessions.json"):
        try:
            with open(sessions_json) as f:
                data = json.load(f)
            for key, val in data.items():
                sid = val.get("sessionId")
                if sid:
                    session_map[sid] = key
        except (json.JSONDecodeError, IOError):
            continue
    return session_map


def file_to_session_key(filepath: str, session_map: dict) -> str:
    """从 JSONL 文件路径推导目标 session key"""
    # 文件名是 sessionId.jsonl
    basename = os.path.basename(filepath).replace(".jsonl", "")
    # 去掉可能的时间戳前缀 (2026-02-27T20-26-36-696Z_uuid)
    if "_" in basename and len(basename) > 40:
        basename = basename.split("_", 1)[1]
    return session_map.get(basename, f"unknown:{basename}")


def format_session_name(session_key: str) -> str:
    """美化 session key 显示，优先走 canonical routing map。"""
    return format_session_label(session_key)


def send_discord_message(token: str, content: str):
    """发送消息到 Discord 频道"""
    url = f"https://discord.com/api/v10/channels/{DISCORD_CHANNEL_ID}/messages"
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
    }
    # 截断过长消息
    if len(content) > MAX_DISCORD_MSG_LEN:
        content = content[: MAX_DISCORD_MSG_LEN - 20] + "\n... (已截断)"

    try:
        resp = requests.post(url, headers=headers, json={"content": content}, timeout=10)
        if resp.status_code == 429:
            retry_after = resp.json().get("retry_after", 5)
            log.warning(f"Discord rate limited, retry after {retry_after}s")
            time.sleep(retry_after)
            resp = requests.post(url, headers=headers, json={"content": content}, timeout=10)
        if resp.status_code not in (200, 201):
            log.error(f"Discord API error: {resp.status_code} {resp.text[:200]}")
        else:
            log.info(f"Discord 消息发送成功")
    except requests.RequestException as e:
        log.error(f"Discord 请求失败: {e}")


def normalize_content(content: str, prov: dict | None = None) -> str:
    """将内部控制消息改写成更清晰的人类可读标记。"""
    text = (content or "").strip()
    if text == "Continue where you left off. The previous model attempt failed or timed out.":
        source_tool = (prov or {}).get("sourceTool", "unknown")
        return (
            "⚠️ [LLM failover] 上一轮模型尝试失败或超时，运行时正在自动续跑/切换模型继续处理。"
            f"\nsourceTool: {source_tool}"
        )
    return text


def should_skip_content(content: str, prov: dict | None = None) -> bool:
    """过滤内部控制消息，避免转发到 Discord。"""
    text = (content or "").strip()
    if not text:
        return True

    if text in ("NO_REPLY", "REPLY_SKIP", "ANNOUNCE_SKIP"):
        return True

    # announce step / internal completion wrapper，不应该外泄到同步频道
    if text.startswith("Agent-to-agent announce step"):
        return True
    if "[Internal task completion event]" in text:
        return True
    if "OpenClaw runtime context (internal):" in text:
        return True
    if "A completed subagent task is ready for user delivery" in text:
        return True

    # sourceTool 为 announce/sessions_send 时，进一步拦截常见控制文本
    source_tool = (prov or {}).get("sourceTool", "")
    if source_tool in ("subagent_announce", "sessions_send"):
        if text.startswith("Stats: runtime ") and "Action:" in text:
            return True

    return False


def process_line(line: str, filepath: str, session_map: dict):
    """解析 JSONL 行，返回 A2A 消息或 None"""
    try:
        d = json.loads(line)
    except json.JSONDecodeError:
        return None

    msg = d.get("message", {})
    if msg.get("role") != "user":
        return None

    prov = msg.get("provenance", {})
    if prov.get("kind") != "inter_session":
        return None

    # 提取消息内容
    content = ""
    for c in msg.get("content", []):
        if c.get("type") == "text":
            content = c["text"]
            break

    # 跳过空消息和内部控制消息
    if should_skip_content(content, prov):
        return None

    content = normalize_content(content, prov)

    source_key = prov.get("sourceSessionKey", "unknown")
    target_key = file_to_session_key(filepath, session_map)
    timestamp = d.get("timestamp", "")

    return {
        "source": source_key,
        "target": target_key,
        "timestamp": timestamp,
        "content": content,
        "msg_id": d.get("id", ""),
    }


def format_discord_message(a2a_msg: dict) -> str:
    """格式化为 Discord 消息"""
    src = format_session_name(a2a_msg["source"])
    tgt = format_session_name(a2a_msg["target"])

    # 解析时间戳
    ts_str = a2a_msg["timestamp"]
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        ts_display = dt.astimezone(CST).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, AttributeError):
        ts_display = ts_str

    content = a2a_msg["content"]

    return f"**[{src} → {tgt}]** `{ts_display}`\n{content}"


def _msg_hash(line: str) -> str:
    """Generate a short hash for dedup."""
    import hashlib
    return hashlib.sha256(line.encode("utf-8", errors="replace")).hexdigest()[:16]


# In-memory dedup set (survives across poll cycles within one process run)
_seen_hashes: set = set()


def scan_jsonl_files(cursors: dict, session_map: dict, bot_token: str) -> dict:
    """扫描所有 JSONL 文件，处理新增内容（含去重保护）"""
    global _seen_hashes
    new_cursors = dict(cursors)
    jsonl_files = list(AGENTS_DIR.glob("*/sessions/*.jsonl"))

    for filepath in jsonl_files:
        fp = str(filepath)
        file_size = filepath.stat().st_size
        offset = new_cursors.get(fp, 0)

        # 文件未变化
        if file_size == offset:
            continue

        # 文件缩小（被 compaction 重写）→ 跳到末尾，只读新内容
        # BUG FIX: 之前重置为 0 导致全文重读 → 30+ 次重复发送
        if file_size < offset:
            log.info(f"文件缩小（compaction?），跳到末尾: {fp} (was {offset}, now {file_size})")
            new_cursors[fp] = file_size
            continue

        # 增量读取
        try:
            with open(filepath, "r") as f:
                f.seek(offset)
                new_content = f.read()
                new_offset = f.tell()
        except IOError as e:
            log.warning(f"读取文件失败 {fp}: {e}")
            continue

        # 逐行处理（含 hash 去重）
        sent_count = 0
        dedup_count = 0
        for line in new_content.splitlines():
            if not line.strip():
                continue

            # Dedup check: skip if we've already seen this exact line
            h = _msg_hash(line)
            if h in _seen_hashes:
                dedup_count += 1
                continue
            _seen_hashes.add(h)

            a2a_msg = process_line(line, fp, session_map)
            if a2a_msg:
                discord_msg = format_discord_message(a2a_msg)
                log.info(f"A2A: {a2a_msg['source']} → {a2a_msg['target']}")
                send_discord_message(bot_token, discord_msg)
                sent_count += 1

        if dedup_count > 0:
            log.info(f"Dedup: skipped {dedup_count} duplicate lines in {fp}")

        new_cursors[fp] = new_offset

    # Trim dedup set to prevent unbounded growth
    if len(_seen_hashes) > DEDUP_MAX * 2:
        # Keep only the most recent half (approximate LRU)
        excess = len(_seen_hashes) - DEDUP_MAX
        for _ in range(excess):
            _seen_hashes.pop()

    return new_cursors


def initialize_cursors() -> dict:
    """首次运行时，将所有现有文件的游标设到末尾（只监听新消息）"""
    cursors = {}
    for filepath in AGENTS_DIR.glob("*/sessions/*.jsonl"):
        cursors[str(filepath)] = filepath.stat().st_size
    return cursors


def main():
    log.info("=== A2A Monitor 启动 ===")

    bot_token = get_bot_token()
    log.info(f"Bot token 已加载 (len={len(bot_token)})")

    # 加载或初始化游标
    cursors = load_cursors()
    if not cursors:
        log.info("首次运行，初始化游标到文件末尾")
        cursors = initialize_cursors()
        save_cursors(cursors)
        log.info(f"已跟踪 {len(cursors)} 个 JSONL 文件")

    # 主循环
    while True:
        try:
            session_map = load_session_map()
            new_cursors = scan_jsonl_files(cursors, session_map, bot_token)

            if new_cursors != cursors:
                cursors = new_cursors
                save_cursors(cursors)

        except KeyboardInterrupt:
            log.info("收到中断信号，退出")
            save_cursors(cursors)
            break
        except Exception as e:
            log.error(f"扫描异常: {e}", exc_info=True)

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
