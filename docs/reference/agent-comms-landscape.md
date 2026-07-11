---
title: "历史调研中的 Agent 互通 / A2A 开源地图（非 OpenClaw 为主）"
date: 2026-07-12
status: active
tags: [research, a2a, agent-comms, landscape]
note: >
  纠正「调研只谈 OpenClaw 插件」的偏差：本会话第一轮调研与 PROJ-012 材料里，
  大量相关项目与 OpenClaw 无关。OpenClaw 插件是后续单独点名的两条链接。
---

# Agent 互通 / A2A 开源地图

## 0. 调研材料分了几层（容易混）

| 层 | 问题 | 本会话里出现过的例子 | 是否 OpenClaw |
|----|------|----------------------|---------------|
| **A. 本机 Session 管理** | 多 CLI 并行 session 列表/切换 | Agent Deck, AoE, CCManager, Agent Sessions, agenttrace | 否（部分可索引 OpenClaw 历史） |
| **B. 本机 Agent 消息总线** | 多 CLI agent 互发消息/事件 | **hcom** | **否** |
| **C. 开放协议 A2A** | 跨厂商 agent 发现与 Task 协作 | **a2aproject/A2A**, a2a-js/sdk, **a2anet/a2a-utils**, a2a-mcp | **否**（协议层） |
| **D. 协议 × 宿主适配** | 把 A2A 接到某个 runtime | win4r gateway, a2anet openclaw-plugin | 是（仅宿主适配） |
| **E. 自研 Event Log** | 异构 agent pull-first 任务总线 | **dennyandwu/a2a-toolkit**、本 monorepo Event Log | **否**（OpenClaw 只是接入方之一） |

你记得「有 A2A / agent 交流开源、不是 openclaw based」——对应的是 **B + C + E**，不是 **D**。

点名要参考的两个 `openclaw-a2a-*` 链接属于 **D 层**，容易盖住前面的 **B/C**。

---

## 1. 非 OpenClaw：协议与标准（C 层）

### 1.1 [a2aproject/A2A](https://github.com/a2aproject/A2A)

- **是什么**：Google 发起、现 Linux Foundation 生态下的 **Agent2Agent 开放规范**
- **核心概念**：Agent Card · Message/Part · Task · Artifact · JSON-RPC/HTTP/SSE（及多语言 SDK）
- **与 Event X**：标准 **远程协作** 模型；Event Log 的 delivery 状态机是 **另一套本地契约**，不要混称「实现了 A2A」

### 1.2 官方 / 主流 SDK（实现协议，无 OpenClaw 依赖）

| 项目 | 说明 |
|------|------|
| [@a2a-js/sdk](https://github.com/a2aproject/a2a-js) 等 | 多语言 A2A client/server |
| 各云厂商 A2A 适配 | Azure Foundry / Bedrock AgentCore 等生产接入（实现方） |

### 1.3 [a2anet/a2a-utils](https://github.com/a2anet/a2a-utils) + [a2anet/a2a-mcp](https://github.com/a2anet/a2a-mcp)

- **是什么**：**A2A Net** 的通用工具库 + **MCP 封装**，用 A2A 调远程 agent
- **关键点**：OpenClaw 插件只是 wrapper；**库本身不依赖 OpenClaw**
- **可借鉴**：`A2ASession` / TaskStore / 大 artifact 最小化 + view 工具形状

### 1.4 其他协议族（同属「agent 互通标准」，非 OpenClaw）

| 协议 | 侧重 |
|------|------|
| **MCP**（Anthropic → LF） | Agent ↔ **工具/上下文**（不是 agent↔agent） |
| **ACP**（IBM 等 Agentic Communication） | 另一路 agent 协作消息标准（与 Google A2A 并列出现在 2025–26 协议讨论中） |
| **AG-UI** 等 | Agent ↔ 用户事件流 |

---

## 2. 非 OpenClaw：本机 agent 交流实现（B 层）

### 2.1 [aannoo/hcom](https://github.com/aannoo/hcom) ⭐ 本会话调研重点

- **是什么**：跨终端 **coding agent 消息/观察/spawn 总线**
- **接入**：Claude Code / Codex / Gemini / Cursor / OpenCode / Antigravity…（**hooks + SQLite**，不绑 OpenClaw）
- **模型**：`agent → hooks → db → hooks → other agent`；mid-turn 注入；TUI dashboard
- **与 Event X / Toolkit 的相似处**：
  - 本地事实源（SQLite）
  - 事件流 / 状态订阅
  - 异构 CLI 一等公民
- **差异**：
  - hcom 偏 **实时协作与 PTY 观察**
  - Event Log 偏 **任务 dispatch + claim/lease + 跨机 pull**
  - Event X B/S 偏 **session 历史 + Event Log 人机操作**

### 2.2 本会话还列过、但是「session 管理」不是「消息协议」（A 层）

这些 **不是 A2A**，但是「多 agent 一起干活」的调研邻居：

| 项目 | 角色 |
|------|------|
| [agent-deck](https://github.com/asheshgoplani/agent-deck) | 多 CLI session TUI |
| [agent-of-empires](https://github.com/agent-of-empires/agent-of-empires) | tmux + worktree 调度 |
| [ccmanager](https://github.com/kbwo/ccmanager) | 无 tmux 的多 assistant 管理 |
| [agent-sessions](https://github.com/jazzyalex/agent-sessions) | 本机多产品 transcript 浏览器 |
| [agenttrace](https://github.com/luoyuctl/agenttrace) | 跨 CLI session 日志/成本 TUI |

---

## 3. 非 OpenClaw：你们自己的 Event Log（E 层）

### 3.1 [dennyandwu/a2a-toolkit](https://github.com/dennyandwu/a2a-toolkit)

- **是什么**：urDAO **异构 agent 事件总线**（JSONL + Hook-C + pipeline），**不是** Google A2A 传输实现
- **原则（heritage 文档）**：契约优先 · pull-first · 单一写路径 · 失败可见
- **OpenClaw 关系**：只是多种接入方式之一（CLI 本地 / SSH / Bridge HTTP）

### 3.2 A2A Event X monorepo

- Session Hub（多 CLI 历史）+ Event Log（toolkit）+ B/S
- **独立产品**；OpenClaw 非必需

---

## 4. OpenClaw *based* 适配（D 层，仅对照）

| 项目 | 说明 |
|------|------|
| win4r/openclaw-a2a-gateway | 社区 A2A mesh 网关，宿主 = OpenClaw |
| a2anet/openclaw-a2a-plugin | A2A Net 的 OpenClaw 宿主适配 |

这两条是你后来 **显式链接** 要参考的；**不能代表**「历史调研里全部 A2A 材料」。

---

## 5. 对 Event X 更有用的非 OpenClaw 参考（建议优先级）

| 优先级 | 项目 | 学什么 |
|--------|------|--------|
| **P0** | **a2a-toolkit（自己）** | 契约、lease、pull-first、Bridge |
| **P0** | **hcom** | 异构 CLI 钩子、本地 SQLite 事件、TUI/实时协作形状 |
| **P1** | **a2aproject/A2A + a2a-utils** | 标准名词边界；Task/Card/Artifact 与自家 delivery 的映射/隔离 |
| **P1** | **Agent Sessions / agenttrace** | 本机 transcript 索引 UX（B/S 已部分覆盖） |
| **P2** | OpenClaw 宿主插件 | 仅当「要被标准 A2A 远端调用」时再做适配层 |

---

## 6. 一句话纠正

- 历史调研 **确实** 覆盖了大量 **非 OpenClaw** 的 agent 交流 / session 材料（hcom、标准 A2A、自研 toolkit、各类 session harness）。  
- 后来「参考两个 openclaw-a2a-*」是 **D 层宿主适配**，不应挤掉 **B/C/E**。  
- Event X 血统上更接近 **E（toolkit）+ A/B（session + 可选 hcom 思想）**，而不是再做一个 OpenClaw A2A 插件。
