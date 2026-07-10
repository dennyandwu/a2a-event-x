---
title: "A2A Event X — Session Hub + Event Projection"
date: 2026-07-11
status: draft
version: "0.1.0"
tags:
  - proj-012
  - a2a
  - session-hub
  - mcp
  - design
related:
  - A2A-EventLog-整体优化方案-v2.0.md
  - Spec-Event-Schema.md
  - Spec-Lifecycle.md
  - 2026-07-10-a2a-v2-hardening-design.md
  - openclaw-a2a-gateway (win4r)
  - openclaw-a2a-plugin (a2anet)
---

# A2A Event X

## 0. 一句话

**A2A Event X** = 本地 **Session Hub**（统一读各厂商 CLI/桌面 session + 消息列表）+ 可选 **事件投影**（把 session 生命周期与关键消息边界投影进现有 **A2A Event Log**），以 **独立 stdio MCP** 为第一接入面；OpenClaw 只是 client，不是 owner。

命名含义：

| 片段 | 含义 |
|------|------|
| **A2A** | 与 PROJ-012 总线、协议生态同域；异构 agent 互操作 |
| **Event** | 以可查询事件 / 时间线为真源，不绑某家 UI |
| **X** | eXtension / cross-tool / next layer — **不是** 再造一套 A2A 传输协议 |

---

## 1. 与现有组件的边界（必须先钉死）

```
┌──────────────────────────────────────────────────────────────────┐
│  Clients: OpenClaw · Claude · Codex · Grok · TUI · ChatGPT …     │
└─────────────────────────────┬────────────────────────────────────┘
                              │ MCP / HTTP / CLI
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  ★ A2A Event X  (本项目)                                          │
│  · Session adapters (read/index local stores)                     │
│  · Session Hub API (list / messages / search / resume hints)      │
│  · Event projector (optional write into Event Log)                │
│  · stdio MCP server  (+ optional thin Bridge routes later)        │
└───────────────┬──────────────────────────────┬───────────────────┘
                │ read-only / hooks            │ write via existing
                ▼                              ▼
┌───────────────────────────┐    ┌─────────────────────────────────┐
│  Vendor local stores      │    │  A2A Event Log (PROJ-012)        │
│  ~/.claude · ~/.codex     │    │  a2a-log / a2a-v2 · SQLite+JSONL │
│  ~/.openclaw · Grok …     │    │  pull-first · claim/lease        │
│  (truth for transcripts)  │    │  (truth for cross-agent tasks)   │
└───────────────────────────┘    └─────────────────────────────────┘
                ▲
                │ (do NOT own)
┌───────────────┴──────────────────────────────────────────────────┐
│  openclaw-a2a-gateway / openclaw-a2a-plugin                       │
│  · Agent Card · message/send · tasks/* · peer mesh                │
│  · 解决的是「OpenClaw ↔ remote agent 线上传输」                    │
│  · Event X 不替代它们；最多观察/投影它们产生的副作用               │
└──────────────────────────────────────────────────────────────────┘
```

| 组件 | 职责 | Event X 关系 |
|------|------|-------------|
| **A2A Event Log (PROJ-012)** | 异构 agent 任务总线：dispatch/claim/ack/done | Event X **只调用** CLI/HTTP；**不复制** 状态机 |
| **openclaw-a2a-gateway** | OpenClaw 插件：A2A v0.3 网关、peer、路由、审计 JSONL | 参考其 observability/audit 思路；**不 fork** 进 Event X |
| **openclaw-a2a-plugin** | OpenClaw 插件：`a2a_*` tools + inbound Agent Card | 参考 tool 面设计；Event X 的 MCP tools **平行** 存在 |
| **Agent Deck / hcom / Agent Sessions** | 第三方 harness / history | 可作 adapter 后端或对照；不硬依赖 |
| **OpenClaw gateway** | 本机 agent 运行时 | 通过 `mcpServers` 挂 Event X；session store 走 adapter |

### 非目标

- 不实现完整 A2A JSON-RPC 传输（gateway/plugin 已做）。
- 不把 Event Log 状态机搬进 Event X。
- 不强制所有 CLI 走 Event X 才能跑（adapters 失败降级，只读探测）。
- 不做公网暴露；若加 HTTP，默认 Tailscale-only（对齐 Bridge 安全模型）。
- 不在 Phase 0–1 做「向任意 live PTY send_keys」（安全面过大，后置）。

---

## 2. 产品目标

### Goals

1. **一个 MCP / 一个 CLI**：列出本机已登陆的 Claude / Codex / Grok / OpenClaw 等 **session 列表**。
2. **统一消息列表**：按 session 分页读 transcript；跨工具全文搜索。
3. **Resume 提示**：返回可执行的 resume 命令 / session id（只读提示，不劫持进程）。
4. **可选投影到 Event Log**：session 创建、结束、needs_input、error 等变成 `info.sync` / control 类事件（或新注册的 `session.*` 类型，经 schema 门禁）。
5. **与 OpenClaw 解耦**：Event Log 与 Session Hub 都可在无 OpenClaw 时工作。

### Non-goals（v0.1）

- 统一各厂商计费/配额 UI（可引用 Agent Sessions 思路，后置）。
- 多机实时协作 mesh（那是 gateway + Event Log 的事）。
- 桌面 GUI（优先 MCP + CLI；macOS Agent Sessions 可并行使用）。

---

## 3. 从参考实现「借什么」

### 3.1 借自 openclaw-a2a-plugin

| 借鉴 | 落到 Event X |
|------|----------------|
| 清晰的 outbound tool 集（list / get / send / get_task） | MCP tools：`x_list_sessions` · `x_get_session` · `x_get_messages` · `x_search` · `x_query_events` |
| Agent Card 作为 **发现文档** | `x_describe` / resource `a2a-event-x://card` 描述能力与 adapter 健康度 |
| 大 artifact 最小化 + view 工具 | 长 transcript 默认截断 + `offset/limit` / `character_range` |
| 按方向隔离存储路径 | Event X 索引缓存 vs 只读 vendor paths 分离 |

### 3.2 借自 openclaw-a2a-gateway

| 借鉴 | 落到 Event X |
|------|----------------|
| JSONL audit trail | 投影写 Event Log 前，本地可选 `~/.a2a-event-x/audit.jsonl` |
| metrics endpoint 思路 | CLI `a2ax status` / MCP `x_health`（adapter 延迟、错误率） |
| Bearer + 多 token 轮换（若未来 HTTP） | 与 Bridge v2 同一套 token 模型，**不要** 自创 |
| Durable task store 边界 | Event X **不** 存 task lifecycle；只存 session **索引缓存** |
| skill/TOOLS.md 模板 | 提供 OpenClaw skill：`session-hub` 告诉 agent 何时 list/search |

### 3.3 借自你方 PROJ-012

| 借鉴 | 落到 Event X |
|------|----------------|
| Pull-first | MCP 读是 pull；投影是可选 write |
| `idempotency_key` | 投影事件强制 key：`session.{kind}:{provider}:{session_id}:{ts_bucket}` |
| ACL / agent registry | 投影 `from` 必须是 `registry-agents.json` 中的 agent |
| Doc-First / summary 限制 | 投影 payload 只放指针（path/session_id），不塞全文 |
| 单一写路径 | 投影只经 `a2a-log.py write` 或 Bridge v2；禁止直接改 JSONL |

---

## 4. 架构

### 4.1 包结构（建议 monorepo）

```
a2a-event-x/
├── README.md
├── package.json                 # 或 pyproject — 建议 TypeScript MCP + Python adapters 二选一；见 §7
├── openclaw.plugin.json         # 可选：薄 OpenClaw plugin 只注册 mcpServers / skill
├── packages/
│   ├── core/                    # domain types, no I/O
│   │   ├── session.ts           # SessionRef, Message, ProviderId
│   │   └── events.ts            # projection event builders
│   ├── adapters/                # one module per provider
│   │   ├── claude-code.ts
│   │   ├── codex.ts
│   │   ├── openclaw.ts
│   │   ├── grok.ts              # stub until paths known
│   │   └── types.ts
│   ├── index/                   # sqlite cache of discovered sessions
│   ├── mcp-server/              # stdio MCP entry
│   ├── cli/                     # a2ax list | show | search | status
│   └── projector/               # optional: fs watch + a2a-log write
├── skills/
│   └── session-hub/SKILL.md
├── schema/
│   └── session-index-v1.schema.json
└── tests/
```

### 4.2 核心类型

```ts
type ProviderId =
  | "claude-code" | "claude-desktop"
  | "codex-cli" | "codex-desktop"
  | "openclaw"
  | "grok-cli" | "grok-desktop"
  | "cursor-cli" | "gemini-cli" | "opencode"
  | "unknown";

interface SessionRef {
  id: string;                 // stable: `${provider}:${nativeId}`
  provider: ProviderId;
  nativeId: string;
  title?: string;
  projectPath?: string;
  createdAt?: string;         // ISO
  updatedAt?: string;
  status: "active" | "idle" | "archived" | "unknown";
  resume?: { kind: "command" | "uri"; value: string };
  sourcePaths: string[];      // transcript files read
}

interface Message {
  role: "user" | "assistant" | "system" | "tool";
  ts?: string;
  text: string;
  raw?: unknown;              // optional, omitted in default MCP responses
}
```

### 4.3 MCP Tools（v0.1 冻结面）

| Tool | 作用 | 侧写 |
|------|------|------|
| `x_health` | adapter 扫描结果、索引年龄、Event Log 可达性 | 只读 |
| `x_list_sessions` | filter: provider, project, status, since, limit | 只读 |
| `x_get_session` | 单 session 元数据 + resume | 只读 |
| `x_get_messages` | session_id, offset, limit, max_chars | 只读 |
| `x_search` | query, providers?, limit | 只读 |
| `x_query_events` | 调 Event Log `pending/read` 或 Bridge inbox（代理） | 只读代理 |
| `x_project_session_event` | 手动把一条 session 边界投影进 Event Log | **写**（opt-in） |

v0.2+（不进首版）：

- `x_watch` / SSE resource（索引增量）
- `x_resume_open`（spawn terminal — 需显式 allowlist）
- 与 hcom/Agent Deck 的 launch 桥

### 4.4 Adapter 契约

每个 adapter 实现：

```ts
interface SessionAdapter {
  id: ProviderId;
  discover(): Promise<SessionRef[]>;
  getMessages(nativeId: string, opts: PageOpts): Promise<Message[]>;
  search?(query: string, limit: number): Promise<SearchHit[]>;
  health(): Promise<{ ok: boolean; detail: string }>;
}
```

**规则：**

1. 默认 **只读** vendor 文件；不写 `~/.claude` / `~/.codex`。
2. 索引缓存可写：`~/.a2a-event-x/index.sqlite`。
3. 路径可配置；探测失败 = 跳过，不 crash 整个 server。
4. Desktop 与 CLI 分 adapter 或同 adapter 多 root。

### 4.5 本机路径约定（初值，adapter 内可 override）

| Provider | 常见路径 | 备注 |
|----------|----------|------|
| Claude Code | `~/.claude/projects/**` JSONL | 与 Agent Sessions / agenttrace 对齐 |
| Codex | `~/.codex/sessions/**` | CLI + Desktop 可能共仓 |
| OpenClaw | `~/.openclaw/agents/<id>/sessions/` | sessions.json + jsonl |
| Grok | TBD | Phase 1 用 stub + 配置路径 |
| Gemini | `~/.gemini/**` | 可选 |
| Cursor CLI | Cursor local agent storage | 可选 |

### 4.6 投影到 Event Log（可选子系统）

**默认关闭。** 配置 `projector.enabled = true` 后：

| session 观察 | 投影 type（建议） | payload 要点 |
|--------------|-------------------|--------------|
| 新 session 出现 | `info.sync` 或 `session.opened`* | provider, session_id, project |
| transcript 长时间 idle | `system.heartbeat`（慎用） | 或仅 metrics |
| 需要人类输入（若可检测） | `info.decision` / custom | session_id, resume hint |
| session 归档/删除 | `info.sync` | closed_at |

\* 新 type 必须先入 `a2a-event-v2.schema.json` 与合约测试；未注册前只用已有 `info.sync`。

投影写入：

```bash
a2a-log.py write \
  --type info.sync \
  --from session-hub \
  --to <agent> \
  --summary "codex session …" \
  --payload '{"provider":"codex-cli","session_id":"…","path":"…"}' \
  --idempotency-key "session.opened:codex-cli:<id>:<day>"
```

`session-hub` 必须在 `registry-agents.json` 注册。

---

## 5. OpenClaw 接入方式

### 推荐：纯 MCP（方案 A 本义）

```json5
// openclaw / mcp config
{
  mcpServers: {
    "a2a-event-x": {
      command: "a2ax",
      args: ["mcp"],
      env: {
        A2AX_HOME: "~/.a2a-event-x",
        // optional
        A2A_LOG_CLI: "/path/to/a2a-log.py",
      }
    }
  }
}
```

### 可选：薄 OpenClaw plugin

只做三件事（**不要** 再开 18800 端口）：

1. 声明 dependency on MCP server binary  
2. 安装 `skills/session-hub`  
3. （可选）在 gateway hooks 上把 OpenClaw 自己的 `session_start/end` 调 `x_project_session_event`

与 **openclaw-a2a-plugin / gateway 并存**，工具前缀分开：

| 前缀 | 来源 |
|------|------|
| `a2a_*` | openclaw-a2a-plugin（远程 agent） |
| `x_*` / `session_*` | A2A Event X（本地 session + log 查询） |

避免命名冲突。

---

## 6. 安全模型

1. **本地优先**：MCP stdio 只服务启动它的用户。
2. **transcript 脱敏策略（可配）**：默认不返回 `raw`；可选 redact API keys 模式。
3. **写路径**：仅 projector + 显式 `x_project_session_event`；默认 deny write。
4. **HTTP（若后加）**：复用 Bridge v2 token / Tailscale；禁止公网 Funnel 默认开。
5. **审计**：本地 `audit.jsonl` 记录 MCP tool 调用元数据（session_id、chars 返回量），不含全文 unless debug。

---

## 7. 技术选型建议

| 选项 | 优点 | 缺点 |
|------|------|------|
| **TypeScript (MCP SDK) 全栈** | 与 OpenClaw 生态一致；MCP 成熟 | 解析 Python 生态 a2a-log 需 subprocess |
| **Python 全栈** | 与 a2a-log / Bridge 同语言；复用现成脚本 | MCP Python 生态略碎 |
| **TS MCP + shell 到 a2a-log** | 边界清晰 | 双语言维护 |

**建议 v0.1：TypeScript MCP + subprocess 调 `a2a-log.py` / `a2a-v2.py`**，不 import 其内部模块 — 保持 Event Log 解耦。

---

## 8. 分阶段交付

### Phase 0 — Skeleton（0.5–1 天）

- [ ] repo `a2a-event-x` + `a2ax mcp` hello
- [ ] `x_health` 返回 OK
- [ ] config 文件 `~/.a2a-event-x/config.toml`
- [ ] 本文档入 vault / repo

### Phase 1 — Read path（3–5 天）

- [ ] adapters: `claude-code`, `codex-cli`, `openclaw`
- [ ] `x_list_sessions` / `x_get_messages` / `x_search`
- [ ] sqlite index + 增量 reindex CLI
- [ ] 合约测试：fixture JSONL 不依赖本机真实 history

### Phase 2 — OpenClaw 挂载 + skill（1–2 天）

- [ ] mcpServers 配置样例
- [ ] skill `session-hub`
- [ ] 真实机验收：OpenClaw agent 能列出 Claude/Codex sessions

### Phase 3 — Event Log 投影（2–3 天，可跳过）

- [ ] projector opt-in
- [ ] registry 注册 `session-hub`
- [ ] idempotent `info.sync` 投影 + soak
- [ ] **不阻塞** G1/G2 Event Log 切读门

### Phase 4 — 扩展

- [ ] Grok / Gemini / Cursor adapters
- [ ] Bridge 只读代理 `x_query_events`
- [ ] 与 Agent Deck/hcom 的 resume 桥（allowlist）

---

## 9. 验收标准（v0.1）

1. `a2ax mcp` 可被任意 MCP client 拉起，tools 列表稳定。
2. 在本机有 Claude + Codex 历史时，`x_list_sessions` 返回 ≥1 条且 `provider` 正确。
3. `x_get_messages` 对同一 session 分页稳定、无 OOM（大文件截断）。
4. 未启用 projector 时，**零写入** Event Log 与 vendor 目录。
5. 关闭 OpenClaw 时，CLI `a2ax list` 仍可用。
6. 与已装 `openclaw-a2a-plugin` 工具名无冲突。

---

## 10. 决策记录（ADR 摘要）

| ID | 决策 | 理由 |
|----|------|------|
| ADR-1 | Event X 独立进程，不 fork gateway/plugin | 传输层与 session 索引层生命周期不同 |
| ADR-2 | Event Log 只通过 CLI/HTTP 访问 | 保持 PROJ-012 解耦与单一写路径 |
| ADR-3 | MCP 为第一公民，plugin 可选薄封装 | 方案 A；多 client 复用 |
| ADR-4 | 默认只读 vendor stores | 安全与兼容；避免损坏厂商 session |
| ADR-5 | 投影默认关闭 | 不干扰 G1/G2 双写/切读门 |
| ADR-6 | 工具前缀 `x_` | 避开 `a2a_*` 命名空间 |

---

## 11. 下一步（需你拍板）

1. **仓库位置**：`~/Claude/Projects/a2a-event-x`？还是与 `a2a-toolkit` 同 monorepo？
2. **语言**：确认 TS MCP + subprocess a2a-log（推荐）？
3. **Phase 1 优先 adapter**：Claude + Codex + OpenClaw 是否足够？
4. **投影**：v0.1 完全不做，还是做开关但默认关？
5. **包名 / CLI 名**：`a2a-event-x` / `a2ax` 是否定稿？

拍板后即可 scaffold Phase 0 代码。
