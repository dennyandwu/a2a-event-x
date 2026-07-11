---
title: "产品重新对齐：多 Agent 交互管理"
date: 2026-07-12
status: locked
tags: [product, strategy, multi-agent]
decisions:
  product: multi-agent-interaction-console
  r1: agent-pending-claimed-board
  name: A2A Event X
locked_at: 2026-07-12
---

# 产品重新对齐

## 0. 已锁定（2026-07-12）

1. 产品 = **多 Agent 交互管理指挥台**；Sessions 仅为附属上下文。  
2. R1 优先：**按 agent 的 pending / claimed 看板**（已实现 v0.4 `/api/agents/board` + 默认 UI）。  
3. 名称继续：**A2A Event X**。

## 1. 终极目标（你说的）

**多 Agent 交互管理** — 能看见、调度、审计 **多个 agent 之间** 的协作，而不是主要看某个 CLI 里聊了什么。

典型能力应包括：

| 能力 | 含义 |
|------|------|
| **交互可见** | 谁发给谁、什么任务、卡在哪、租约/重试/死信 |
| **交互可操作** | claim / ack / done / cancel / 转派 / 补偿 |
| **多 agent 身份** | registry、ACL、SLA、接入方式（CLI/SSH/HTTP） |
| **跨会话关联** | correlation / pipeline / 同一 workflow 下的多 agent 接力 |
| **人机指挥台** | B/S 上「交互与任务」是主界面，不是 transcript 浏览器 |
| （可选）实时协作 | 类 hcom 的互发消息 / 观察 |
| （可选）标准互通 | 类 A2A Task 的远程 agent |

## 2. 当前落地实际做成了什么

**A2A Event X v0.1–0.3 主叙事 = 本机多 CLI Session Hub + 附带 Event Log 操作**

| 已做 | 更贴近… |
|------|----------|
| Sessions 列表 / 消息 / 搜索 | 多 **工具** 历史浏览器 |
| Grok/Claude/Codex adapters | 个人 coding 会话 UX |
| Event Log inbox claim/ack/done | ✅ 多 agent **交互** 的一角 |
| Write Path / registry 下拉 | ✅ 交互基础设施的运维面 |
| MCP 后置、独立 B/S | 产品形态 OK，**主题偏了** |

### 偏离点（诚实结论）

1. **主页默认 Sessions** → 用户第一眼是「聊天记录」，不是「agent 协作图」。  
2. **Session Hub 工作量占比过高** → 容易做成 Agent Sessions / agenttrace 竞品。  
3. **Event Log 仍像附属 Tab** → 而 PROJ-012 / a2a-toolkit 的真正核心（异构 agent 总线）被挤到第二位。  
4. **「交互」缺少一等模型** — 缺：交互时间线、pipeline 视图、agent 拓扑、跨 agent correlation 聚合。

**可保留的资产（没有白做）：**

- B/S 壳 + API 分层  
- Event Log v1/v2 代理、claim 操作、registry/status  
- Session adapters 作为 **上下文侧栏**（某次交互关联了哪个 coding session）  

## 3. 目标架构（重新置顶）

```
                    ┌──────────────────────────────────┐
                    │  指挥台 B/S（人）                  │
                    │  Interactions · Agents · Pipelines │
                    └───────────────┬──────────────────┘
                                    │
                    ┌───────────────▼──────────────────┐
                    │  Multi-Agent Interaction Core      │
                    │  Event Log (dispatch/claim/done)   │
                    │  correlation / pipeline / registry │
                    └───────┬─────────────┬────────────┘
           adapters │             │ adapters
    ┌───────────────▼──┐   ┌──────▼──────────────┐
    │ Coding sessions  │   │ 可选：hcom / A2A      │
    │ (上下文，非主线)  │   │ 实时或标准远程互通    │
    └──────────────────┘   └─────────────────────┘
```

**主对象从 Session 换成 Interaction（或 Delivery / Workflow）。**

## 4. 建议的产品命名与一句话

- 对外一句话：**「多 Agent 交互与任务指挥台」**（本地优先，可挂异构 agent）  
- 技术名可仍叫 A2A Event X / 或更贴目标的名字（如 **Agent Desk / Interaction Hub**）— 命名可另议  
- **Session Hub = 模块**，不是产品定义  

## 5. 重新对齐后的路线（建议）

### Phase R0 — 叙事与默认 UI（0.5–1 天）

- 默认进入 **Interactions / Inbox**，Sessions 降为次级导航  
- README / DECISIONS：终极目标写死为 multi-agent interaction  
- 健康页突出 **agent 维度 pending / dead / lease**

### Phase R1 — 交互一等模型（核心）

- **Interaction 视图**：按 `correlation_id` / `pipeline_id` 聚合多条 delivery  
- **Agent 视图**：每个 agent 的 pending、claimed、SLA、最近交互  
- **时间线**：同一 workflow 的 dispatch→ack→done 链  
- API：`/api/interactions`, `/api/agents/:id/stats`

### Phase R2 — 操作闭环

- 转派、批量 claim、dead-letter 处理、补偿入口（对接 toolkit）  
- 操作审计 JSONL（参考 gateway audit 形状）  
- 非 localhost 鉴权  

### Phase R3 — 可选扩展（仍服务「交互」）

- hcom 事件投影进 Event Log（实时协作 → 可审计交互）  
- 标准 A2A 适配（对外被调用 / 调用远端）— **可选**  
- Session 附件：某 delivery 关联的 coding session 一键打开  

### 明确降级 / 不做（现阶段）

- 不做「最好的多 CLI 聊天浏览器」功能竞赛  
- 不把 MCP 当主交付  
- 不优先 Grok transcript 美化（除非服务交互排障）  

## 6. 与已有资产的映射

| 资产 | 新角色 |
|------|--------|
| `packages/event-log` | **Core** |
| `packages/webapp` Event Log / Write Path | **Core UI** 加深 |
| `packages/session-hub` | **Context module** |
| openclaw-a2a-* 调研 | 仅当需要标准远程 A2A 时 |
| hcom 调研 | 实时交互层的参考，可后接 |
| a2a-toolkit | 总线权威实现 |

## 7. 需要你拍板的 3 件事

1. **是否确认**：产品一句话 = 「多 Agent 交互管理指挥台」，Session 仅为附属？  
2. **第一优先级 R1**：先做 **correlation 聚合时间线**，还是 **按 agent 的 pending 看板**？  
3. **命名**：继续 `A2A Event X`，还是改显示名（仓库可暂不改）？  

拍板后按 R0→R1 改默认 UI 与 API，停止加码 Session Hub 主线。
