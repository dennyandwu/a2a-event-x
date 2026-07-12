# A2A Event X — Go-Live (v1.0)

本地优先的多 Agent 交互指挥台 **落地清单**。

## 验收定义（v1.0）

| 项 | 标准 |
|----|------|
| 主线 UI | Agents 看板 · Workflows（传递过程）· Inbox |
| 操作闭环 | claim / ack / done / batch / requeue / compensate + ops audit |
| 真数据 | 可读 `A2A_LOG_HOME` 下 JSONL + sqlite；可从 Mac Mini rsync |
| 演示 | 无生产数据时「加载演示数据」仍可用 |
| 运维 | 系统 → Write Path / Ops Audit / Health |
| 鉴权 | 默认 localhost 开放；设 `A2AX_TOKEN` 后 API 需 Bearer |

**非 v1.0 / 明确不做**：MCP（已移出本项目）、标准 A2A 远程 mesh 主路径、非本机多租户鉴权产品化、hcom 投影。

**Agent 接入（现状）**：生产侧 OpenClaw / Claude Code 等 **已直接遵循 Event Log 协议**（CLI / Hook / watcher）。本仓库 **不经 MCP**；可选 Skill 草稿见 `skills/`，**待指挥台完全落地后再推广**，不作为当前交付门禁。

## 快速启动

```bash
cd a2a-event-x
npm install
npm run web
# → http://127.0.0.1:8787/
```

## 接生产 Event Log（真数据）

生产目录在 **Mac Mini**（示例）：

```text
0xfg_bot@macmini-ts:~/.openclaw/workspace/state/a2a-log/
  events/*.jsonl     # 权威事件
  db/a2a-v2.sqlite   # claim / delivery 状态
  registry-agents.json
```

### 方式 A — CLI 同步（推荐）

```bash
# 需本机 SSH 配置 Host macmini-ts
./scripts/sync-event-log.sh

# 可选覆盖
export A2AX_SYNC_REMOTE='macmini-ts:~/.openclaw/workspace/state/a2a-log/'
export A2A_LOG_HOME="$HOME/.openclaw/workspace/state/a2a-log"
./scripts/sync-event-log.sh

npm run web
```

### 方式 B — 控制台

1. 打开 **系统 → Write Path**
2. 点 **「从 Mac Mini 同步真数据」**
3. 若仅有 JSONL、看板仍空 → **「JSONL → sqlite backfill」**
4. 回 **Agents** 刷新

### 方式 C — 直接指目录

```bash
export A2A_LOG_HOME=/path/to/a2a-log
export A2A_V2_DB=$A2A_LOG_HOME/db/a2a-v2.sqlite
npm run web
```

## 环境变量

| 变量 | 含义 |
|------|------|
| `A2A_LOG_HOME` | Event Log 根目录（默认 `~/.openclaw/workspace/state/a2a-log`） |
| `A2A_V2_DB` | sqlite 路径 |
| `A2A_LOG_CLI` | a2a-log.py 路径 |
| `A2AX_HOST` / `A2AX_PORT` | 绑定（默认 127.0.0.1:8787） |
| `A2AX_TOKEN` | 若设置，则 `/api/*` 需 `Authorization: Bearer` 或 `X-A2AX-Token` |
| `A2AX_SYNC_REMOTE` | rsync 源（默认 macmini-ts 生产路径） |
| `A2AX_AUDIT_PATH` | ops audit JSONL |

## 安全注意

1. **默认只绑 localhost**；不要对公网裸暴露。
2. 局域网共享时设置 `A2AX_TOKEN`，并考虑 `A2AX_HOST=0.0.0.0` 仅在可信网。
3. **rsync 到本机的是生产副本**；在本机 claim/done 会改**本地 sqlite**，不会自动写回 Mac Mini，除非你把 `A2A_LOG_HOME` 指到实时共享盘或再 rsync 回去（危险，生产操作应在权威机做）。
4. 日常指挥若以 Mac Mini 为准，优先在 **权威机** 上跑 Event X，或只读同步后只做查看。

## 冒烟检查

```bash
curl -s http://127.0.0.1:8787/api/health | python3 -m json.tool | head
curl -s http://127.0.0.1:8787/api/agents/board | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('totals'));print(len(d.get('agents')or[]))"
curl -s 'http://127.0.0.1:8787/api/interactions?limit=5' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('summary'));print([x['correlation_id'] for x in (d.get('correlations')or[])[:3]])"
```

期望（接真数据后）：`totals.pending` 可非零；interactions 有非 `workflow-*-demo` 的 correlation。

## 版本

- **v1.0.0**：主线可演示 + 真数据同步/指向 + 操作闭环 + 传递过程可视化  
- **v1.1**：去掉 MCP；Agent 侧继续走既有 Event Log 协议（非 Skill 强制）  
- 后续：指挥台打磨 / 只读模式 / 权威机部署；**Skill 推广延后**
