# A2A Event X — Go-Live (v1.2)

本地优先的多 Agent 交互指挥台 **落地清单**。

## 验收定义（v1.0+）

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

## 权威机 vs 笔记本镜像（必读）

| 角色 | 机器 | 用法 |
|------|------|------|
| **权威 (authority)** | **Mac Mini**（Event Log 本机路径） | `A2AX_AUTHORITY=1 npm run web`（或 `npm run web:authority`） |
| **镜像 (mirror)** | 开发本机 rsync 副本 | **默认只读**（live 数据自动 readonly）；也可 `npm run web:ro` |

生产目录在 **Mac Mini**（示例）：

```text
0xfg_bot@macmini-ts:~/.openclaw/workspace/state/a2a-log/
  events/*.jsonl     # 权威事件
  db/a2a-v2.sqlite   # claim / delivery 状态
  registry-agents.json
```

Agent（OpenClaw / Claude Code）**已直接**消费该 Event Log；指挥台是给人看的，不是再给 agent 上 Skill。

### 方式 A — 笔记本：同步 + 只读（推荐日常）

```bash
# 需本机 SSH 配置 Host macmini-ts
./scripts/sync-event-log.sh   # 或 npm run sync:log

export A2A_LOG_HOME="$HOME/.openclaw/workspace/state/a2a-log"
npm run web                   # live 数据默认只读（无需手写 A2AX_READONLY）
# 或显式: npm run web:ro
```

只读下仍允许 **`POST /api/data/sync`** 刷新镜像。看板会显示 **同步龄 / 是否过期**。

### 方式 B — 控制台同步

1. 打开 **系统 → Write Path**
2. 点 **「从 Mac Mini 同步真数据」**
3. 镜像机请用 `web:ro`，勿在副本上 backfill/claim（只读会拦）

### 方式 C — Mac Mini 权威可写

```bash
# 在 Mac Mini 上 clone 本仓库，指向本机 a2a-log（默认路径即可）
export A2AX_AUTHORITY=1
npm run web
# 或: npm run web:authority
# → 对人：可操作；对 agent：继续走既有 Event Log 协议
```

### 方式 D — 直接指目录

```bash
export A2A_LOG_HOME=/path/to/a2a-log
export A2A_V2_DB=$A2A_LOG_HOME/db/a2a-v2.sqlite
# 镜像务必：
export A2AX_READONLY=1
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
| **`A2AX_READONLY`** | `1` 强制只读；`0` 强制可写；**未设置且 live 数据 → 自动只读** |
| **`A2AX_AUTHORITY`** | `1`：live 数据也可写（Mac Mini 权威机） |
| `A2AX_STALE_HOURS` | 同步/数据过期阈值阈值（默认 24） |
| `A2AX_SYNC_REMOTE` | rsync 源（默认 macmini-ts 生产路径） |
| `A2AX_AUDIT_PATH` | ops audit JSONL |

## 安全注意

1. **默认只绑 localhost**；不要对公网裸暴露。
2. 局域网共享时设置 `A2AX_TOKEN`，并考虑 `A2AX_HOST=0.0.0.0` 仅在可信网。
3. **rsync 副本 + 只读**：笔记本用 `A2AX_READONLY=1`，避免 claim 只改本地 sqlite、与 Mac Mini 权威状态分叉。
4. **可写操作只在权威机**（Mac Mini 本机 Event Log）。
5. Agent 继续走既有协议；指挥台不替代 agent 消费路径。

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
- **v1.2**：`A2AX_READONLY` 只读模式 + 权威/镜像分工文档  
- **v1.3**：live 默认只读、同步新鲜度、blocked/escalated/historical 看板、系统页可读化、CI  
- 后续：Mac Mini 常驻部署（可选）；Skill 推广仍延后
