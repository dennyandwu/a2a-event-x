# A2A Event X

**多 Agent 交互管理指挥台**（本地优先 B/S）。

产品目标不是「多 CLI 聊天浏览器」，而是：**看见、调度、审计多个 agent 之间的任务与交互**。

| 优先级 | 模块 | 角色 |
|--------|------|------|
| **主线** | Event Log + **Agent 看板** | pending / claimed / acked / 操作闭环 |
| 主线 | Workflows · Inbox | correlation 时间线；单 agent claim / ack / done |
| 上下文 | Sessions | coding CLI 历史（侧栏二级） |
| 运维 | **系统**（Write Path / Ops Audit / Health） | 存储拓扑 · 操作审计 · 健康检查（非日常调度） |
| 后置 | MCP | 产品完成后再做 |

名称固定：**A2A Event X**。

## Quick start

```bash
git clone https://github.com/dennyandwu/a2a-event-x.git
cd a2a-event-x
npm install
npm run web
```

打开 **http://127.0.0.1:8787/**  

默认页：**Agents 看板** → 点击 agent 进入详情 / Inbox。

本机若无生产 dual-write 数据，看板会空。可：

1. 顶栏点 **「加载演示数据」**（写入 sqlite `source_file=demo` 的 5 条跨 agent 工作流），或  
2. `python3 packages/event-log/scripts/seed-demo.py --reset`，或  
3. 设置 `A2A_LOG_HOME` 指向 Mac Mini 等生产 Event Log 目录后重启。

## 架构

```
B/S 指挥台
  Agents 看板 · Inbox · Write Path
        ↓
Event Log (a2a-toolkit v1 + v2 lease)
        ↓
Sessions（上下文，非主线）
```

## 关键 API

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/agents/board` | **按 agent 的 pending/claimed 看板** |
| GET | `/api/agents/:id/deliveries` | agent 详情积压 |
| POST | `/api/demo/seed` | 加载/清除演示数据 `{ reset, wipe_only }` |
| POST | `/api/events/batch-done` | 批量 DONE |
| POST | `/api/events/requeue-dead` | dead → pending |
| POST | `/api/events/compensate` | 补偿 dry-run |
| GET | `/api/interactions` | workflow 列表 |
| GET | `/api/interactions/:id` | workflow 时间线 |
| GET | `/api/ops/audit` | 操作审计 JSONL 最近条目 |
| GET | `/api/events/inbox` | 单 agent inbox（`mode=auto\|v2\|v1`） |

| POST | `/api/events/claim\|ack\|done\|…` | 交互操作 |
| GET | `/api/events/status` | 写路径拓扑 |
| GET | `/api/sessions` | 附属 session 列表 |

## Event Log

上游 toolkit：https://github.com/dennyandwu/a2a-toolkit  

环境见 `packages/event-log/config.env.example`（`A2A_LOG_HOME` / `A2A_LOG_CLI` / `A2A_V2_DB`）。

## 产品决策

- [docs/PRODUCT-REORIENT.md](docs/PRODUCT-REORIENT.md) — 目标与偏离纠正  
- [docs/DECISIONS.md](docs/DECISIONS.md) — 锁定决策  
- [docs/reference/](docs/reference/) — A2A / agent 互通调研  

## License

MIT（脚手架）。Toolkit 脚本保留上游条款。
