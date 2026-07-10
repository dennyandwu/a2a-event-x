#!/usr/bin/env python3
"""
pipeline_utils.py — Pipeline 公共工具模块

A2A v2.0 Pipeline 脚本共享工具函数，消除跨脚本重复代码（W12 修复）。

用法：
    from pipeline_utils import load_registry, get_agent, get_channel, read_discord_channel, parse_timestamp

版本: v1.0 | 创建: 2026-03-22 | 维护: Issac PMO
背景: 修复 Elon 审计 W12 — 4个脚本存在 200+ 行重复代码
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from typing import Optional

try:
    from a2a_routing import get_session_key as routing_get_session_key
except Exception:
    routing_get_session_key = None

# ─── 路径常量 ────────────────────────────────────────────────────────────────

WORKSPACE_DIR = os.path.expanduser("~/.openclaw/workspace")
AGENTS_DIR = os.path.join(WORKSPACE_DIR, "agents")
REGISTRY_FILE = os.path.join(AGENTS_DIR, "registry.json")
THREADS_DIR = os.path.join(WORKSPACE_DIR, "threads")

# ─── Registry 操作 ────────────────────────────────────────────────────────────

def load_registry() -> dict:
    """
    加载 Agent Registry 索引文件。

    Returns:
        registry dict，含 agents / channels / error_codes 等字段

    Raises:
        FileNotFoundError: registry.json 不存在
        json.JSONDecodeError: JSON 格式异常
    """
    if not os.path.exists(REGISTRY_FILE):
        raise FileNotFoundError(f"Registry not found: {REGISTRY_FILE}")
    with open(REGISTRY_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def get_agent(agent_id: str) -> dict:
    """
    通过 agent_id 从 Registry 加载 Agent Card。

    Args:
        agent_id: 如 "ansen", "elon", "issac", "satoshi"

    Returns:
        agent dict，含 session_key / channels / accept_methods 等字段

    Raises:
        KeyError: agent_id 不在 registry 中
        FileNotFoundError: agent.json 文件不存在
    """
    registry = load_registry()
    if agent_id not in registry.get("agents", {}):
        raise KeyError(f"Agent '{agent_id}' not found in registry. "
                       f"Available: {list(registry['agents'].keys())}")

    agent_path = registry["agents"][agent_id]
    # agent_path 可能是相对路径（相对于 WORKSPACE_DIR）
    if not os.path.isabs(agent_path):
        agent_path = os.path.join(WORKSPACE_DIR, agent_path)

    if not os.path.exists(agent_path):
        raise FileNotFoundError(f"Agent file not found: {agent_path}")

    with open(agent_path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_channel(channel_name: str) -> str:
    """
    通过频道名获取 Discord 频道 ID（从 registry.channels）。

    Args:
        channel_name: 如 "a2a_sync", "pmo_patrol", "ceo", "changes", "ops"

    Returns:
        频道 ID 字符串

    Raises:
        KeyError: channel_name 不在 registry.channels 中
    """
    registry = load_registry()
    channels = registry.get("channels", {})
    if channel_name not in channels:
        raise KeyError(f"Channel '{channel_name}' not found in registry. "
                       f"Available: {list(channels.keys())}")
    return channels[channel_name]


def get_session_key(agent_id: str) -> str:
    """
    获取 Agent 的 canonical session_key，用于 sessions_send。

    优先走 routing-map.json，避免不同脚本各自硬编码或展示错位；
    routing helper 不可用时再回退到 agent card。
    """
    if routing_get_session_key is not None:
        try:
            return routing_get_session_key(agent_id)
        except Exception:
            pass

    agent = get_agent(agent_id)
    session_key = agent.get("session_key")
    if not session_key:
        raise ValueError(f"Agent '{agent_id}' has no session_key configured")
    return session_key


def get_discord_channel_id(agent_id: str) -> str:
    """
    获取 Agent 的 Discord 频道 ID。

    Args:
        agent_id: Agent 标识符

    Returns:
        Discord 频道 ID 字符串
    """
    agent = get_agent(agent_id)
    try:
        return agent["channels"]["discord"]["channel_id"]
    except KeyError:
        raise ValueError(f"Agent '{agent_id}' has no discord channel configured")


# ─── Discord 操作 ──────────────────────────────────────────────────────────────

def read_discord_channel(channel_id: str, limit: int = 50) -> list[dict]:
    """
    读取 Discord 频道最近消息（调用 openclaw message CLI）。

    Args:
        channel_id: Discord 频道 ID
        limit: 最多读取条数，默认 50

    Returns:
        消息列表，每条含 id / content / author / timestamp 等字段
        失败时返回空列表（避免阻断主流程）
    """
    try:
        result = subprocess.run(
            ["openclaw", "message", "read",
             "--channel", channel_id,
             "--limit", str(limit),
             "--format", "json"],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode != 0:
            print(f"[pipeline_utils] read_discord_channel failed: {result.stderr}",
                  file=sys.stderr)
            return []
        return json.loads(result.stdout) if result.stdout.strip() else []
    except subprocess.TimeoutExpired:
        print(f"[pipeline_utils] read_discord_channel timeout for channel {channel_id}",
              file=sys.stderr)
        return []
    except (json.JSONDecodeError, Exception) as e:
        print(f"[pipeline_utils] read_discord_channel error: {e}", file=sys.stderr)
        return []


# ─── 时间工具 ─────────────────────────────────────────────────────────────────

CST = timezone(timedelta(hours=8))


def now_cst() -> datetime:
    """返回当前 CST (Asia/Shanghai) 时间。"""
    return datetime.now(tz=CST)


def now_iso() -> str:
    """返回当前 CST 时间的 ISO 8601 字符串。"""
    return now_cst().isoformat()


def parse_timestamp(ts: str) -> Optional[datetime]:
    """
    解析 ISO 8601 时间字符串为 datetime（带时区）。

    支持格式：
    - "2026-03-21T09:00:00+08:00"
    - "2026-03-21T09:00:00Z"
    - "2026-03-21T09:00:00" （假设 CST）

    Args:
        ts: 时间字符串

    Returns:
        带时区的 datetime，解析失败返回 None
    """
    if not ts:
        return None
    # 替换 Z → +00:00 以兼容 Python 3.10 以下
    ts_clean = ts.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(ts_clean)
        # 无时区信息时假设 CST
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=CST)
        return dt
    except ValueError:
        return None


def minutes_since(ts: str) -> Optional[float]:
    """
    计算距给定时间戳已过去多少分钟。

    Args:
        ts: ISO 8601 时间字符串

    Returns:
        分钟数（float），解析失败返回 None
    """
    dt = parse_timestamp(ts)
    if dt is None:
        return None
    delta = now_cst() - dt
    return delta.total_seconds() / 60


# ─── JSON 文件操作 ────────────────────────────────────────────────────────────

def load_json(path: str, default=None):
    """
    安全加载 JSON 文件，文件不存在或解析失败时返回 default。

    Args:
        path: 文件路径（支持 ~ 展开）
        default: 默认值（默认为 None）

    Returns:
        解析后的 Python 对象，或 default
    """
    path = os.path.expanduser(path)
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"[pipeline_utils] load_json failed ({path}): {e}", file=sys.stderr)
        return default


def save_json(path: str, data, indent: int = 2) -> bool:
    """
    原子写入 JSON 文件（先写临时文件再 rename）。

    Args:
        path: 目标文件路径
        data: 可序列化的 Python 对象
        indent: JSON 缩进层级

    Returns:
        True 表示成功，False 表示失败
    """
    path = os.path.expanduser(path)
    tmp_path = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
        os.replace(tmp_path, path)
        return True
    except OSError as e:
        print(f"[pipeline_utils] save_json failed ({path}): {e}", file=sys.stderr)
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        return False


# ─── A2A 消息辅助 ─────────────────────────────────────────────────────────────

def make_msg_id(agent_id: str, seq: int = 0) -> str:
    """
    生成符合 A2A v2.0 规范的消息 ID（C1 修复）。

    格式: msg_{agent}_{timestamp_ms}_{seq}

    Args:
        agent_id: 发送方 agent_id
        seq: 序列号（同一批次内区分）

    Returns:
        消息 ID 字符串
    """
    ts_ms = int(now_cst().timestamp() * 1000)
    return f"msg_{agent_id}_{ts_ms}_{seq:03d}"


def build_a2a_message(
    method: str,
    from_agent: str,
    to_agent: str,
    params: Optional[dict] = None,
    thread_id: Optional[str] = None,
    ref: Optional[str] = None,
    seq: int = 0
) -> dict:
    """
    构建 A2A v2.0 标准消息体。

    Args:
        method: 消息类型，格式 domain.action（如 "task.dispatch"）
        from_agent: 发送方 agent_id
        to_agent: 接收方 agent_id
        params: 消息参数 dict
        thread_id: 关联 Thread ID
        ref: 引用的上游消息 ID
        seq: 同批次序列号

    Returns:
        完整的 A2A v2.0 消息 dict
    """
    msg = {
        "a2a": "2.0",
        "id": make_msg_id(from_agent, seq),
        "method": method,
        "from": from_agent,
        "to": to_agent,
        "timestamp": now_iso(),
    }
    if thread_id:
        msg["thread_id"] = thread_id
    if params:
        msg["params"] = params
    if ref:
        msg["ref"] = ref
    return msg


# ─── 便捷导出 ─────────────────────────────────────────────────────────────────

__all__ = [
    # Registry
    "load_registry",
    "get_agent",
    "get_channel",
    "get_session_key",
    "get_discord_channel_id",
    # Discord
    "read_discord_channel",
    # 时间
    "now_cst",
    "now_iso",
    "parse_timestamp",
    "minutes_since",
    # JSON 文件
    "load_json",
    "save_json",
    # A2A 消息
    "make_msg_id",
    "build_a2a_message",
    # 路径常量
    "WORKSPACE_DIR",
    "AGENTS_DIR",
    "THREADS_DIR",
    "REGISTRY_FILE",
]


# ─── 自测（直接运行时）────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== pipeline_utils self-test ===\n")

    # 测试 load_registry
    try:
        reg = load_registry()
        print(f"✅ load_registry: version={reg.get('version')}, agents={list(reg['agents'].keys())}")
    except Exception as e:
        print(f"❌ load_registry: {e}")

    # 测试 get_agent
    for aid in ["issac", "ansen", "elon", "satoshi"]:
        try:
            agent = get_agent(aid)
            print(f"✅ get_agent({aid}): role={agent.get('role')}, "
                  f"accept_methods={agent.get('accept_methods')}")
        except Exception as e:
            print(f"❌ get_agent({aid}): {e}")

    # 测试 get_channel
    for ch in ["a2a_sync", "changes"]:
        try:
            cid = get_channel(ch)
            print(f"✅ get_channel({ch}): {cid}")
        except Exception as e:
            print(f"❌ get_channel({ch}): {e}")

    # 测试时间工具
    print(f"✅ now_iso: {now_iso()}")
    ts = "2026-03-21T09:00:00+08:00"
    dt = parse_timestamp(ts)
    mins = minutes_since(ts)
    print(f"✅ parse_timestamp: {dt}")
    print(f"✅ minutes_since: {mins:.1f} min" if mins is not None else "❌ minutes_since: None")

    # 测试消息构建
    msg = build_a2a_message(
        method="task.dispatch",
        from_agent="issac",
        to_agent="ansen",
        params={"title": "测试任务", "priority": "P1"},
        thread_id="thread_test_001"
    )
    print(f"✅ build_a2a_message: id={msg['id']}, method={msg['method']}")
    print("\n=== self-test done ===")
