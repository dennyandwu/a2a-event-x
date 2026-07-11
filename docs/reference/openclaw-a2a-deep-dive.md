---
title: "调研参考：openclaw-a2a-gateway × openclaw-a2a-plugin 深度解析"
date: 2026-07-12
status: active
tags: [research, a2a, openclaw, design-reference]
sources:
  - https://github.com/win4r/openclaw-a2a-gateway (v1.5.1, MIT, ~540★)
  - https://github.com/a2anet/openclaw-a2a-plugin (v0.2.0, Apache-2.0, ~26★)
related:
  - ../DECISIONS.md
  - A2A Event X B/S product (this monorepo)
---

# 两个 OpenClaw A2A 参考项目深度解析

> 调研阶段选定的两份参考实现。二者都是 **OpenClaw 插件 + 官方 A2A 协议（@a2a-js/sdk）**，解决的是 **跨实例 agent 线上互通**，不是本机 multi-CLI session 浏览器。  
> 本文目的：抽出**可迁移的设计思路**，明确**不可照搬的边界**，指导 A2A Event X 的后续演进。

---

## 0. 一句话对照

| | **openclaw-a2a-gateway** (win4r) | **openclaw-a2a-plugin** (a2anet) | **A2A Event X（本项目）** |
|--|----------------------------------|----------------------------------|---------------------------|
| 问题 | 多台 OpenClaw 如何互相发现、路由、抗故障通信 | OpenClaw 如何作为 A2A client/server 收发消息与文件 | 本机多厂商 session/消息 + 本地 Event Log 如何被人用浏览器管 |
| 协议 | A2A v0.3 + **自研 mesh 扩展** | 标准 A2A（薄封装 a2a-utils） | 自有 Event Log 契约 + Session Hub；**不实现 A2A 传输** |
| 主表面 | 独立端口 18800 网关 + CLI/devtools | 挂在 OpenClaw gateway HTTP + `a2a_*` tools | **B/S :8787**（MCP 后置） |
| 耦合 OpenClaw | 强（plugin + agent dispatch） | 强（plugin SDK / reply pipeline） | **弱**（独立产品；OpenClaw 只是可选 client） |

---

## 1. openclaw-a2a-gateway（win4r）

### 1.1 定位

生产向 **双向 A2A 网关插件**：

- 对外暴露标准发现与传输：`/.well-known/agent-card.json`、`/a2a/jsonrpc`、`/a2a/rest`、gRPC(port+1)
- 对内把 inbound 请求 **dispatch 进本机 OpenClaw agent**
- 对 peer 提供静态 peers 配置 + **DNS-SD / mDNS 发现** + 健康检查 + 熔断/重试
- 自带 **JSONL audit**、metrics、task 持久化与 TTL 清理
- 可选「生物启发式」：Hill 亲和路由、四态熔断、Michaelis–Menten 软限流、Quorum 感知发现

仓库规模：`src/` ~7.8k 行 TS + 大量测试（compat / resilience / file security / multi-round…）。

### 1.2 架构分层（从代码结构反推）

```
                    ┌─────────────────────────────────────┐
                    │  index.ts — Express + gRPC 装配面    │
                    │  Agent Card · JSON-RPC · REST · gRPC │
                    └───────────────┬─────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
   OpenClawAgentExecutor     QueueingAgentExecutor      FileTaskStore
   (调 OpenClaw 跑一轮)       (并发/队列/饱和延迟)      (tasks 磁盘持久化)
          │
          ▼
   PeerHealth · Retry · TransportFallback · CircuitBreaker
          │
          ▼
   RoutingRules (+ optional Hill affinity)
          │
          ▼
   A2AClient → peer Agent Card URL
```

**内部扩展**（`src/internal/`，**明确声明不是 A2A 标准**）：

| 模块 | 设计意图 |
|------|----------|
| `envelope` | 自定义 `a2a/v1` 信封 |
| `transport` | `/a2a/v1/inbox` + `X-A2A-*` 头 |
| `security` | HMAC-SHA256 网关间签名（标准 A2A 多用 OAuth/API Key） |
| `outbox` | Outbox + 指数退避 |
| `idempotency` | SHA-256 去重 |
| `metrics` | 协议指标 |

文档原话：标准 A2A surface 由 SDK 处理；internal 模块是 **OpenClaw gateway mesh 的可靠性扩展**。

### 1.3 关键设计模式

#### (1) 传输与领域分离

- 传输：JSON-RPC / REST / gRPC **三绑定 + 自动 fallback**（成功率 × 延迟评分）
- 领域：Task 状态机、Agent Card skills、OpenClaw agentId 路由

**对 Event X 的启示：**  
B/S API、CLI、（未来）MCP 应是 **同一 Session Hub / Event Log 领域模型** 的多个绑定，而不是三套业务逻辑。

#### (2) 持久化 Task + TTL + 恢复

- `FileTaskStore`：每 task 一文件，`write tmp → rename`（Windows 上有 EPERM 回退）
- `task-cleanup` / `task-recovery`：过期清理、崩溃后恢复 stale task

**对 Event X 的启示：**  
已有 deliveries/lease；继续强化 **崩溃可恢复、终态 TTL、审计与业务状态分离**（gateway 把 audit JSONL 与 task store 分开——与我们 Event Log 的「JSONL 审计 + SQLite 投递状态」同构）。

#### (3) 可观测性一等公民

- `AuditLogger`：append-only JSONL，`inbound|outbound` × `task|security`
- `/a2a/metrics`：可选 bearer
- structured logs 开关

**对 Event X 的启示：**  
Write Path 页已起步；应固定 **安全事件 / 操作事件** 写入可查询 audit（例如 UI 上 ACK/DONE 的本地 audit.jsonl），与 toolkit 的 hook-c audit 对齐而不混库。

#### (4) 路由：规则优先，评分可选

- 默认：priority 排序，**首个匹配**
- 可选：Hill 方程对 skills/tags/pattern/successRate 打分

**对 Event X 的启示：**  
Session 侧暂不需要 Hill；Event Log 侧 topic→agent 已有 registry。可借鉴 **「简单规则默认 + 可选打分」** 的渐进复杂度，避免一上来 over-engineer。

#### (5) 韧性：健康检查 · 重试 · 熔断 · 软限流

- PeerHealth 周期拉 Agent Card
- Retry 指数退避
- CircuitBreaker 可配 softThreshold / desensitizedCapacity（四态）
- Saturation：接近并发上限时 **渐进 delay** 而非直接 429

**对 Event X 的启示：**  
对 v1/v2 CLI subprocess 调用应：超时、错误结构化、UI toast 可见；对远程（若未来桥接）再引入熔断。**本地 B/S 优先保证调用面的失败可见，而不是静默失败。**

#### (6) 安全：入站 token 轮换 + 文件 SSRF 面

- `security.token` / `tokens[]` 零停机轮换
- URI allowlist、MIME allowlist、大小限制

**对 Event X 的启示：**  
当前 local-first 默认 `127.0.0.1`；若 `A2AX_HOST=0.0.0.0` 或 Tailscale 暴露，应 **立即** 加 bearer（可抄 gateway 的 multi-token 模型），且 resume 命令/路径勿在 UI 泄露 secrets。

#### (7) 人机接口分层

- 插件跑网关
- `cli/`：health / card / send / stream / discover / bench / trace
- `skill/`：教 agent 如何用 exec 调 a2a-send（TOOLS.md 模板）

**对 Event X 的启示：**  
我们已选 **B/S 主界面**；CLI 次要。仍可借鉴 skill：**用短文档告诉 agent 何时打开 Event X / 如何调 HTTP API**（MCP 完成后再统一）。

### 1.4 不宜照搬

- 独立 18800 端口 A2A 服务（Event X 不是 A2A 传输网关）
- 生物启发式整包默认开启（复杂度高、默认应关闭）
- 深度绑定 OpenClaw agent dispatch（违背独立产品原则）

---

## 2. openclaw-a2a-plugin（a2anet）

### 2.1 定位

**协议对齐优先的社区插件**（`@a2anet/openclaw-a2a-plugin`）：

- **Outbound**：6 个 `a2a_*` tools，背后是 `@a2anet/a2a-utils`（与 A2A MCP Server 同源）
- **Inbound**：在 OpenClaw gateway 上挂 Agent Card + JSON-RPC（`/a2a`、`/a2a/<agentId>`），经 `OpenClawExecutor` 进入 OpenClaw reply pipeline
- 安全默认：**inbound 必须 API key**（可 `allowUnauthenticated`，但不推荐）
- CLI：`openclaw a2a generate-key / list-keys`
- 多 agent 托管：一个 gateway 多个 `/a2a/<agentId>`

依赖：`@a2a-js/sdk` + `@a2anet/a2a-utils`；peer `openclaw >= 2026.4.8`。

### 2.2 架构分层

```
Outbound path:
  LLM tool call a2a_send_message
       → A2ATools (a2a-utils)
       → A2ASession + JSONTaskStore + LocalFileStore
       → remote Agent Card URL (HTTP)

Inbound path:
  POST /a2a  (JSON-RPC, optional SSE stream)
       → A2AHttpHandlers (auth: API key → sender label)
       → DefaultRequestHandler + OpenClawExecutor
       → OpenClaw inbound-reply-dispatch
       → agent session (per sender label + context_id)

Persistence:
  outbound: <state>/a2a/outbound/tasks|files
  inbound:  <state>/a2a/inbound[/agentId]/tasks|files
```

### 2.3 关键设计模式

#### (1) 薄插件 + 厚共享库

Outbound tools **几乎无业务代码**：只做 OpenClaw tool 注册格式适配，逻辑在 `a2a-utils`。

**对 Event X 的启示：**  
Session Hub 与 Event Log 已是 packages；B/S 应继续变薄。未来 MCP 只是 **另一个薄绑定**，禁止在 MCP 里复制 claim 逻辑。

#### (2) 工具面「够用且可分页」

Outbound 六件套：

| Tool | 角色 |
|------|------|
| `a2a_get_agents` | 发现已配置 peer |
| `a2a_get_agent` | skills 详情 |
| `a2a_send_message` | 发消息/文件，拿 context_id/task_id |
| `a2a_get_task` | 长任务轮询 |
| `a2a_view_text_artifact` | 大文本分段读 |
| `a2a_view_data_artifact` | 结构化数据按 path/rows 读 |

+ 入站 `a2a_update_agent_card` 热更新卡片。

**对 Event X 的启示（已部分采用）：**

- Session：`list / get / messages(offset,limit,max_chars) / search`
- Event：`inbox / claim / ack / done / renew / cancel` + **status / registry**
- 大 transcript **必须分页与截断**（plugin 的 artifact 最小化 = 同一原则）

#### (3) 身份与会话隔离

- Inbound API key 带 **label** → 作为 sender 身份进入 OpenClaw
- 会话键：`sender label + context_id` → 多对话并行
- 多 agent：`/a2a/<agentId>` 路径段 = OpenClaw agentId

**对 Event X 的启示：**  
Event Log 的 `from/to agent` + claim_token fencing 已对齐「身份绑定操作」。UI 操作必须 **agent 维度**（已有 registry 下拉）；未来若多用户 B/S，key→label 模型可直接抄。

#### (4) 安全默认拒绝

无 key 时 **拒绝所有 inbound** 并打印 generate-key 指引，而不是默认开放。

**对 Event X 的启示：**  
写路径状态页已显示「是否存在」；若绑定非 localhost，默认应 **无 token 拒绝 POST 写操作**（claim/ack/done）。

#### (5) 配置 schema 即产品文档

`openclaw.plugin.json` 的 `configSchema` + `uiHints` 让 OpenClaw UI 能渲染配置表单。

**对 Event X 的启示：**  
B/S 可增加「设置」页：A2A_LOG_HOME、默认 agent、mode=auto/v2/v1、是否允许 claim——用 **一份 JSON schema** 驱动前后端校验。

#### (6) 测试策略

- 单测：auth / agent-card / tools / registration
- e2e：outbound / multi-agent inbound / openclaw-latest

**对 Event X 的启示：**  
优先补 **合约测试**：inbox 归一化、v2→v1 fallback、registry 解析；B/S 用 supertest 打 `/api/events/*`。

### 2.4 不宜照搬

- 强制 OpenClaw plugin 生命周期（Event X 独立产品）
- 以 LLM tools 为主 UX（我们以人类 B/S 为主）
- 远程 A2A Task 语义替换本地 Event Log 状态机（两套模型：标准 Task vs 我们的 delivery lease）

---

## 3. 两者对比矩阵

| 维度 | Gateway (win4r) | Plugin (a2anet) |
|------|-----------------|-----------------|
| 星级/成熟度 | 更高，功能面更广 | 更小，协议更「正统」 |
| SDK 用法 | 自建 Express 装配 + 大量自研 | 重度依赖 a2a-utils |
| 发现 | mDNS / DNS-SD / 静态 peers | 配置里写死 remote card URL |
| 路由 | 规则 + 可选亲和评分 | 基本靠 agent_id 参数 |
| 韧性 | 熔断/重试/健康/软限流 | 超时与 poll 配置为主 |
| 入站 auth | bearer token(s) | labeled API keys（更细身份） |
| 多 agent | routing.defaultAgentId + message.agentId | inbound.agents 多 endpoint |
| 观测 | audit JSONL + metrics | task/file 目录隔离 |
| 哲学 | **mesh 网关 / 运维向** | **标准工具面 / 产品向** |

**互补关系：**  
Plugin ≈ 正确的 **A2A 产品契约与工具形状**；Gateway ≈ 正确的 **运维、韧性、观测、发现**。Event X 应 **学两边的「形状」**，而不实现完整 A2A mesh。

---

## 4. 对 A2A Event X 的设计迁移清单

### 4.1 已对齐或接近

| 参考点 | Event X 现状 |
|--------|----------------|
| 独立于「远程聊天 App」的 agent 互通 | Event Log pull-first |
| 分页/截断大内容 | messages `offset/limit/max_chars` |
| 操作绑定身份 | claim_token + agent |
| 写路径可视化 | Write Path 页 + `/api/events/status` |
| 配置与注册表 | registry-agents / topics |
| 薄绑定多层 surface | hub domain + webapp/cli（MCP 后置） |

### 4.2 建议吸收（按优先级）

| P | 吸收项 | 来源 | 落地建议 |
|---|--------|------|----------|
| P0 | **失败默认可见** | 两者 | subprocess 错误结构化进 API/UI toast；禁止吞异常 |
| P0 | **非 localhost 必须鉴权** | plugin 默认拒绝 | `A2AX_TOKEN` multi-token；无 token 禁 POST |
| P1 | **操作审计 JSONL** | gateway AuditLogger | `~/.a2a-event-x/audit/ops.jsonl` 记 claim/ack/done |
| P1 | **设置页 + JSON schema** | plugin configSchema | 默认 agent、mode、A2A_LOG_HOME |
| P1 | **合约/e2e 测试** | 两者 tests | inbox fallback、v1/v2 ops |
| P2 | **Outbox/幂等** | gateway internal | 若 B/S 代理写 Event Log，写请求带 idempotency-key |
| P2 | **Artifact 式分段读** | plugin view_* | 超长 session 提供 line/char range API |
| P3 | 发现/熔断 | gateway | 仅当 Event X 开始连 **远程** Event Log 时再做 |
| — | A2A JSON-RPC 全实现 | 两者 | **明确不做**（边界） |

### 4.3 概念映射（避免混用名词）

| A2A 标准 / 插件 | Event X / Toolkit |
|-----------------|-------------------|
| Agent Card | registry-agents +（可选）产品自描述 `/api/meta` |
| Task | delivery 行（pending→claimed→acked→done） |
| context_id | correlation_id / session 维度 |
| message/send | `a2a-log.py write` / Bridge notify |
| tasks/get | `a2a-v2 inbox` / get by token |
| API key label | agent_id / from 字段 |
| SSE stream | 未来：B/S 可用 SSE 推 pending 变化（可选） |

---

## 5. 结论

1. **Gateway** 教我们如何做 **可运维的 agent 互通基础设施**（观测、韧性、发现、审计）。  
2. **Plugin** 教我们如何做 **干净的协议边界与工具/配置形状**（薄封装、默认安全、大对象分页、身份 label）。  
3. **Event X** 应继续做 **独立 B/S 产品**：Session Hub + Event Log；从两者借 **形状与纪律**，不借 **A2A 传输栈与 OpenClaw 强耦合**。  
4. 若未来要「被其他 OpenClaw 当远程专家调用」，再 **可选** 增加 A2A inbound 适配层——那时优先复用 **a2a-utils / plugin 模式**，而不是 fork 整份 gateway mesh。

---

## 6. 本地源码快照

分析时浅克隆路径（可删）：

- `/tmp/a2a-ref-analysis/gateway` → win4r/openclaw-a2a-gateway  
- `/tmp/a2a-ref-analysis/plugin` → a2anet/openclaw-a2a-plugin  
