# A2A Event X

**多 Agent 交互管理指挥台**（本地优先 B/S）· **v1.3**

产品目标不是「多 CLI 聊天浏览器」，而是：**看见、调度、审计多个 agent 之间的任务与交互**。

| 优先级 | 模块 | 角色 |
|--------|------|------|
| **主线** | Event Log + **Agent 看板** | pending / claimed / acked / 操作闭环 |
| 主线 | Workflows · Inbox | agent 传递过程 + correlation；claim / ack / done |
| 上下文 | Sessions | coding CLI 历史 |
| 后置 | Skill（可选） | 现有 OpenClaw/Claude agents **已遵循 Event Log 协议**；Skill 待指挥台完全落地后再考虑 |
| 运维 | **系统**（数据源 / Write Path / Ops Audit / Health） | 真数据同步 · 拓扑 · 审计 |

## Quick start

```bash
git clone https://github.com/dennyandwu/a2a-event-x.git
cd a2a-event-x
npm install
npm run web
```

打开 **http://127.0.0.1:8787/**

默认页：**Agents 看板**。

### 真数据（生产 Event Log）

```bash
# 笔记本镜像（live 数据默认只读）
npm run sync:log
npm run web

# Mac Mini 权威可写
# A2AX_AUTHORITY=1 npm run web
# 或: npm run web:authority
```

或控制台 **系统 → Write Path →「从 Mac Mini 同步真数据」**。详见 [docs/GO-LIVE.md](docs/GO-LIVE.md)。

### 无生产数据时

顶栏 **「加载演示数据」**（sqlite `source_file=demo`）。

## 架构

```
B/S 指挥台 (Agents · Workflows · Inbox)
        ↓
Event Log  A2A_LOG_HOME
  events/*.jsonl   (canonical)
  db/a2a-v2.sqlite (claim / lease)
        ↓
Sessions（上下文，非主线）
```

## 关键 API

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/agents/board` | 按 agent pending/claimed 看板 |
| GET | `/api/agents/:id/deliveries` | agent 积压 |
| GET | `/api/interactions` | workflow 列表（含历史 done） |
| GET | `/api/interactions/:id` | 时间线 / 传递过程数据 |
| POST | `/api/data/sync` | rsync 生产 Event Log |
| POST | `/api/data/backfill` | JSONL → sqlite |
| POST | `/api/demo/seed` | 演示数据 |
| POST | `/api/events/claim\|ack\|done\|…` | 交互操作 |
| GET | `/api/ops/audit` | 操作审计 |
| GET | `/api/events/status` | 写路径 / 数据源 |

## 环境

见 `packages/event-log/config.env.example` 与 [docs/GO-LIVE.md](docs/GO-LIVE.md)。

## 产品决策

- [docs/PRODUCT-REORIENT.md](docs/PRODUCT-REORIENT.md)
- [docs/DECISIONS.md](docs/DECISIONS.md)
- [docs/GO-LIVE.md](docs/GO-LIVE.md) — **落地与真数据**
- [docs/reference/](docs/reference/) — A2A / agent 互通调研

## License

MIT（脚手架）。Toolkit 脚本保留上游条款。
