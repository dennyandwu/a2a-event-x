#!/usr/bin/env python3
"""A2A routing helpers — context-aware agent/channel/thread mapping.

Rules:
- home_session_key / canonical_session_key = agent default home inbox
- resolved session for a dispatch should prefer current context channel/thread when the target agent already has a session there
- result delivery should normally inherit the origin context, not blindly fall back to the agent home channel
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace"
ROUTING_MAP_PATH = WORKSPACE_DIR / "agents" / "routing-map.json"


@lru_cache(maxsize=1)
def load_routing_map() -> dict[str, Any]:
    with open(ROUTING_MAP_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def _agent_alias_index() -> dict[str, str]:
    data = load_routing_map()
    aliases = dict(data.get("agent_aliases", {}))
    for alias, route in data.get("agents", {}).items():
        aliases.setdefault(alias, alias)
        ocid = route.get("openclaw_agent_id")
        if ocid:
            aliases.setdefault(str(ocid), alias)
    return aliases


def resolve_agent_alias(agent: str) -> str:
    aliases = _agent_alias_index()
    if agent not in aliases:
        raise KeyError(f"Unknown agent alias: {agent}")
    return aliases[agent]


def get_agent_route(agent: str) -> dict[str, Any]:
    alias = resolve_agent_alias(agent)
    data = load_routing_map()
    route = data.get("agents", {}).get(alias)
    if not route:
        raise KeyError(f"Routing entry missing for agent: {agent}")
    return route


@lru_cache(maxsize=32)
def _load_session_store(agent: str) -> dict[str, Any]:
    store_path = Path(get_session_store_path(agent))
    if not store_path.exists():
        return {}
    try:
        with open(store_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def get_home_session_key(agent: str) -> str:
    route = get_agent_route(agent)
    return str(route.get("home_session_key") or route["canonical_session_key"])


def get_context_session_key(agent: str, context_channel_id: str) -> str:
    route = get_agent_route(agent)
    openclaw_agent_id = str(route["openclaw_agent_id"])
    return f"agent:{openclaw_agent_id}:discord:channel:{context_channel_id}"


def is_thread_context(channel_id: Optional[str]) -> bool:
    if not channel_id:
        return False
    thread = load_routing_map().get("threads", {}).get(str(channel_id))
    return isinstance(thread, dict)


def build_closeout_target(
    channel_id: Optional[str],
    *,
    mode: str,
    surface: str = "discord",
    thread_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    if not channel_id:
        return None

    channel_id = str(channel_id)
    resolved_thread_id = str(thread_id) if thread_id else None
    if resolved_thread_id is None and is_thread_context(channel_id):
        resolved_thread_id = channel_id

    return {
        "surface": surface,
        "channel_id": channel_id,
        "thread_id": resolved_thread_id,
        "mode": mode,
    }


def resolve_session_key(agent: str, context_channel_id: Optional[str] = None) -> str:
    if context_channel_id:
        candidate = get_context_session_key(agent, context_channel_id)
        if candidate in _load_session_store(agent):
            return candidate
    return get_home_session_key(agent)


def get_session_key(agent: str) -> str:
    return get_home_session_key(agent)


def get_session_store_path(agent: str) -> str:
    return str(get_agent_route(agent)["session_store_path"])


def get_display_label(agent: str, short: bool = False) -> str:
    route = get_agent_route(agent)
    if short and route.get("display_label_short"):
        return str(route["display_label_short"])
    return str(route["display_label"])


@lru_cache(maxsize=64)
def resolve_display_label(agent: str, context_channel_id: Optional[str] = None, short: bool = False) -> str:
    route = get_agent_route(agent)
    display_name = str(route.get("display_name") or agent)
    if context_channel_id:
        resolved = resolve_session_key(agent, context_channel_id)
        context_key = get_context_session_key(agent, context_channel_id)
        if resolved == context_key:
            data = load_routing_map()
            thread = data.get("threads", {}).get(str(context_channel_id))
            if thread:
                return f"{display_name} @ {thread.get('label')}"
            return f"{display_name} @ channel:{context_channel_id}"
    return get_display_label(agent, short=short)


def get_display_label_for_session_key(session_key: str) -> Optional[str]:
    data = load_routing_map()
    for route in data.get("agents", {}).values():
        if session_key in {route.get("canonical_session_key"), route.get("home_session_key")}:
            return str(route.get("display_label") or route.get("display_label_short") or route.get("display_name"))
    for alias, route in data.get("agents", {}).items():
        parts = str(session_key).split(":")
        if len(parts) >= 5 and parts[0] == "agent" and parts[2] == "discord" and parts[3] == "channel":
            ocid = route.get("openclaw_agent_id")
            if parts[1] == str(ocid):
                context_channel_id = parts[4]
                thread = data.get("threads", {}).get(str(context_channel_id))
                display_name = str(route.get("display_name") or alias)
                if thread:
                    return f"{display_name} @ {thread.get('label')}"
    for thread in data.get("threads", {}).values():
        if session_key in set(thread.get("session_keys", [])):
            return str(thread.get("label"))
    return None


def format_session_label(session_key: str) -> str:
    mapped = get_display_label_for_session_key(session_key)
    if mapped:
        return mapped

    parts = str(session_key).split(":")
    if len(parts) >= 2:
        try:
            return get_display_label(parts[1])
        except Exception:
            pass
        if "subagent" in session_key:
            return f"{parts[1]}/sub-agent"
        return parts[1]
    return session_key


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Inspect A2A routing map")
    parser.add_argument("action", choices=["session-key", "resolve-session-key", "session-store", "label", "resolve-label", "session-label"])
    parser.add_argument("value")
    parser.add_argument("--short", action="store_true")
    parser.add_argument("--context-channel-id", default=None)
    args = parser.parse_args()

    if args.action == "session-key":
        print(get_session_key(args.value))
    elif args.action == "resolve-session-key":
        print(resolve_session_key(args.value, context_channel_id=args.context_channel_id))
    elif args.action == "session-store":
        print(get_session_store_path(args.value))
    elif args.action == "label":
        print(get_display_label(args.value, short=args.short))
    elif args.action == "resolve-label":
        print(resolve_display_label(args.value, context_channel_id=args.context_channel_id, short=args.short))
    elif args.action == "session-label":
        print(format_session_label(args.value))
