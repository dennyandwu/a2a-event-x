#!/usr/bin/env python3
"""
A2A Bridge v2 — 异构 Agent HTTP 网关(G4a)
===========================================
方案 4.2/4.6(0xFG 批准的安全模型,2026-07-07):
  身份   : X-Bridge-Token → config/bridge-tokens/<agent>.token 一对一映射;
           请求体 from_agent 仅交叉校验,不得自证身份(不符→403+审计)。
  ACL    : 默认拒绝;registry-agents.json 的 acl_write_to 为唯一授权源;
           inbox/租约操作仅限本人。
  暴露面 : 仅绑 Tailscale IP(BRIDGE2_BIND_HOST),不上公网。
  审计   : 全部写操作 → logs/bridge-v2-audit.jsonl(启动时裁剪 >90 天)。
  防重放 : notify 支持 Idempotency-Key(透传 v1 write 幂等门)。
语义零复制:全部委托 a2a-log.py(canonical 写)与 a2a-v2.py(租约),
Bridge 只做认证/ACL/审计/传输。无 token 文件 = 该 agent 不放行(默认关闭)。
"""
from __future__ import annotations

import fnmatch
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

from fastapi import Body, FastAPI, Header, HTTPException, Query, Request
import uvicorn

HOME = os.path.expanduser("~")
SCRIPTS = os.path.join(HOME, ".openclaw", "scripts")
V1 = os.path.join(SCRIPTS, "a2a-log.py")
V2 = os.path.join(SCRIPTS, "a2a-v2.py")
TOKENS_DIR = os.path.join(HOME, ".openclaw", "config", "bridge-tokens")
REGISTRY = os.path.join(HOME, ".openclaw", "workspace", "state", "a2a-log", "registry-agents.json")
AUDIT = os.path.join(HOME, ".openclaw", "logs", "bridge-v2-audit.jsonl")
AUDIT_RETENTION_DAYS = 90
BIND_HOST = os.environ.get("BRIDGE2_BIND_HOST", "100.71.176.10")
BIND_PORT = int(os.environ.get("BRIDGE2_BIND_PORT", "8766"))
PY = "python3"

app = FastAPI(title="A2A Bridge v2", version="2.0.0")


# ---------- 审计 ----------
def audit(agent, action, detail, status, ip=""):
    try:
        os.makedirs(os.path.dirname(AUDIT), exist_ok=True)
        with open(AUDIT, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": datetime.now(timezone.utc).isoformat(),
                "agent": agent, "action": action, "detail": str(detail)[:300],
                "status": status, "ip": ip,
            }, ensure_ascii=False) + "\n")
    except Exception:
        pass


def trim_audit():
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=AUDIT_RETENTION_DAYS)).isoformat()
        if not os.path.exists(AUDIT):
            return
        kept = [l for l in open(AUDIT, encoding="utf-8")
                if (json.loads(l).get("ts", "") >= cutoff)]
        with open(AUDIT + ".tmp", "w", encoding="utf-8") as f:
            f.writelines(kept)
        os.replace(AUDIT + ".tmp", AUDIT)
    except Exception:
        pass


# ---------- 身份与 ACL ----------
def _load_tokens() -> dict:
    m = {}
    if os.path.isdir(TOKENS_DIR):
        for fn in os.listdir(TOKENS_DIR):
            if fn.endswith(".token"):
                try:
                    tok = open(os.path.join(TOKENS_DIR, fn)).read().strip()
                    if tok:
                        m[tok] = fn[:-6]
                except Exception:
                    continue
    return m


def _registry() -> dict:
    try:
        d = json.load(open(REGISTRY))
        return {a["agent_id"]: a for a in d.get("agents", []) if a.get("agent_id")}
    except Exception:
        return {}


def require_agent(request: Request, x_bridge_token: str | None) -> str:
    ip = request.client.host if request.client else ""
    if not x_bridge_token:
        audit("-", "auth", "missing token", 401, ip)
        raise HTTPException(401, "missing X-Bridge-Token")
    agent = _load_tokens().get(x_bridge_token.strip())
    if not agent:
        audit("-", "auth", "invalid token", 403, ip)
        raise HTTPException(403, "invalid token")
    return agent


def check_write_acl(agent: str, targets: list[str]):
    reg = _registry()
    ent = reg.get(agent)
    if ent is None:
        raise HTTPException(403, f"agent {agent} not in registry (default deny)")
    allowed = ent.get("acl_write_to") or []
    for t in targets:
        if not any(fnmatch.fnmatch(t, pat) for pat in allowed):
            raise HTTPException(403, f"ACL deny: {agent} -> {t}")


def run_cli(cmd: list[str], timeout=180) -> dict:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    out = (r.stdout or "").strip()
    try:
        body = json.loads(out) if out else {}
    except json.JSONDecodeError:
        body = {"raw": out[:500]}
    if r.returncode != 0:
        raise HTTPException(409, detail=body if body else {"error": "cli_failed", "stderr": (r.stderr or "")[:300]})
    return body


# ---------- 端点 ----------
@app.get("/health")
def health():
    return {"ok": True, "version": "2.0.0", "host": BIND_HOST, "auth": "required-per-agent-token"}


@app.post("/v1/notify")
def notify(request: Request, body: dict = Body(...),
           x_bridge_token: str | None = Header(None),
           idempotency_key: str | None = Header(None)):
    agent = require_agent(request, x_bridge_token)
    claimed_from = body.get("from_agent")
    if claimed_from and claimed_from != agent:
        audit(agent, "notify", f"from_agent spoof attempt: {claimed_from}", 403, request.client.host)
        raise HTTPException(403, "from_agent does not match token identity")
    to = body.get("to") or []
    if isinstance(to, str):
        to = [t.strip() for t in to.split(",") if t.strip()]
    topic = body.get("topic")
    if not to or not topic:
        raise HTTPException(422, "to and topic required")
    check_write_acl(agent, to)
    cmd = [PY, V1, "write", "--from", agent, "--to", ",".join(to),
           "--topic", str(topic), "--type", str(body.get("type", "task.dispatch")),
           "--payload", json.dumps(body.get("payload") or {}, ensure_ascii=False)]
    if idempotency_key:
        cmd += ["--idempotency-key", idempotency_key]
    res = run_cli(cmd)
    audit(agent, "notify", f"to={to} topic={topic}", 200, request.client.host)
    return res


@app.get("/v1/inbox/{agent_path}")
def inbox(agent_path: str, request: Request,
          x_bridge_token: str | None = Header(None),
          claim: bool = Query(False), limit: int = Query(10),
          lease_s: int = Query(3600), wait: int = Query(0)):
    agent = require_agent(request, x_bridge_token)
    if agent != agent_path:
        audit(agent, "inbox", f"tried to read {agent_path}", 403, request.client.host)
        raise HTTPException(403, "inbox access limited to own agent")
    deadline = time.time() + min(max(wait, 0), 55)
    while True:
        cmd = [PY, V2, "inbox", "--agent", agent, "--limit", str(limit)]
        if claim:
            cmd += ["--claim", "--lease-s", str(lease_s)]
        res = run_cli(cmd)
        if res.get("events") or time.time() >= deadline:
            if claim and res.get("events"):
                audit(agent, "claim", f"n={len(res['events'])}", 200, request.client.host)
            return res
        time.sleep(3)


def _lease_op(op: str, request: Request, token_hdr, body: dict, extra: list[str] = None):
    agent = require_agent(request, token_hdr)
    ctoken = (body or {}).get("claim_token")
    if not ctoken:
        raise HTTPException(422, "claim_token required")
    res = run_cli([PY, V2, op, "--token", ctoken] + (extra or []))
    audit(agent, op, res.get("status", "?"), 200, request.client.host)
    return res


@app.post("/v1/ack")
def ack(request: Request, body: dict = Body(...), x_bridge_token: str | None = Header(None)):
    return _lease_op("ack", request, x_bridge_token, body)


@app.post("/v1/done")
def done(request: Request, body: dict = Body(...), x_bridge_token: str | None = Header(None)):
    extra = ["--summary", body.get("summary", "done via bridge-v2")] if body.get("summary") else []
    return _lease_op("done", request, x_bridge_token, body, extra)


@app.post("/v1/renew")
def renew(request: Request, body: dict = Body(...), x_bridge_token: str | None = Header(None)):
    return _lease_op("renew", request, x_bridge_token, body, ["--extend-s", str(body.get("extend_s", 3600))])


@app.post("/v1/cancel")
def cancel(request: Request, body: dict = Body(...), x_bridge_token: str | None = Header(None)):
    extra = ["--reason", body.get("reason", "cancelled via bridge-v2")]
    return _lease_op("cancel", request, x_bridge_token, body, extra)


if __name__ == "__main__":
    trim_audit()
    print(f"[bridge-v2] binding {BIND_HOST}:{BIND_PORT}; tokens dir {TOKENS_DIR}", file=sys.stderr)
    uvicorn.run(app, host=BIND_HOST, port=BIND_PORT, log_level="info")
