---
title: "A2A Event Log — 整体优化方案 (v2.0)"
date: 2026-07-07
author: "Claude (基于 2026-07-06 全链路审计;draft-2/3 吸收 Codex 评审意见)"
status: draft
version: "2.0-draft-6"
tags:
  - proj-012
  - a2a
  - event-log
  - design
---

# A2A Event Log — 整体优化方案 v2.0

> 定位升级:A2A Event Log 不再是 OpenClaw 内部组件,而是**异构 Agent 互操作总线**。任何满足两个条件的 agent——(a) 能读写文件或调用 CLI/HTTP,(b) 能设置 cron/schedule 定时任务——均可接入。共享规则与数据库统一放在 Mac Mini,本文档及后续 spec 在 Obsidian 中版本迭代。
>
> **draft-2 修订原则**:止血与平台升级分离。P0 只做已验证事故的直接修复 + 可见性;协议/存储重构后置,且先契约后实现。

## 〇、变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 2.0-draft-1 | 2026-07-07 | 初稿 |
| 2.0-draft-2 | 2026-07-07 | 吸收评审意见:① P0 加入 Gmail 事故直接修复(seen_ids/closeout、wake 目标校验、pending --limit 1 边缘触发);② supersede 改为 collapse_key 级合并;③ 补全 claim/lease 语义(claim_token/续租/fencing);④ "文档即协议"降级为"文档描述协议,测试与 schema 约束协议";⑤ Bridge 安全模型补 ACL/轮换/审计/防重放;⑥ Phase 重排:先 schema+SQLite 双写,后在 DB 上做 lifecycle;⑦ 外部 agent 矩阵标注"待实测"及 ChatGPT 频率限制 |
| 2.0-draft-3 | 2026-07-07 | 二轮评审定义修正:① A1 更正为"seen_ids 已存在但在 closeout 前推进"——seen_ids 仅作 detected 去重,新增 delivered_ids/summarized_ids 作交付门槛;② closeout→DONE 定义为事务顺序(先回写成功再提交终态),P0 用 audit sidecar 不引入死信表;③ pending count 修复限定向后兼容 CLI 增量;④ events 表改 immutable,to/status/lease 移入 deliveries;⑤ Bridge surface 补齐 claim/done/cancel/renew;⑥ Gmail collapse_key 默认 message_id;⑦ ChatGPT 接入路径改为"待验证";⑧ 新增"P0 非目标 / 兼容性边界"一节 |
| 2.0-draft-4 | 2026-07-07 | 基于实机深度审计(见《A2A-深度审计-历史沿革与文实差异-20260707》)修订:① P0-1 改为优先启用/改造**已存在但未加载**的 a2a-monitor(D4——07-06 积压无告警的直接原因),复用现成 Discord webhook 基建;看门狗巡检项增加"launchd 服务实际加载状态";② P0 新增清理 launchd 失败项(oneshot.update 退出码 127 等);③ P1 契约基线明确为 06-20 对账文档 + 07-03 代码现状,9 项文档欠账清偿列入验收;④ P1 git 收敛改为"以 live 为源 re-import",5 月后无文档组件(automation-runner/followup-runner/protocol-guard/mailbox-shadow/codex-a2a-consumer/health-check)一并纳管;⑤ 新增 Bridge auto-post 判生死决策项;⑥ canonical 文档目录定为 macmini vault Projects/PROJ-012-Agent-Dashboard/ |
| 2.0-draft-5 | 2026-07-07 | 三轮核验 + 升级窗口专项排查(审计 v1.1 §六):① P0-1 修正为"审阅后改造或重写 backlog watchdog"——实测 live a2a-monitor.py 是 inter_session→Discord 同步器而非积压告警器,**不能直接加载了事**;② wake_failed 表述修正为"4 月测试/硬化期历史失败";③ D3 修正为"未进入 canonical 文档体系"(workspace/docs 有零星说明);④ 5/22→6 月排查结论:cron 注册表迁移(06-09)零 enabled 任务丢失(59 个被清理的全部本已 disabled),但 issac 06-12→06-17 停摆 5.9 天、followup-runner 两段空窗——看门狗巡检项增加"各 agent 事件产出速率" |
| 2.0-draft-6 | 2026-07-07 | **issac 07-06 停滞根因定位(EBADF)**:gateway.log 证实 exec spawn EBADF(07-04/05 两度触发 gateway 重启;07-06 16:07/16:14 issac session 内 a2a-log.py 运行失败,16:21 起积压)——A2 修正为"wake 送达≠可执行";P0-7 从"排查根因"改为"清残余积压 + FD 泄漏根治跟踪";看门狗巡检项增加 gateway FD 占用数;确认 session 归档已制度化(每日两跑)但未根治 FD 泄漏(审计 v1.2 §四-3/§六-6) |

## 一、现状诊断

### 1.1 已验证事故的直接根因(P0 对象)

这一类不需要协议重构,修 adapter 和消费端即可:

| # | 根因 | 事故表现 |
|---|------|---------|
| A1 | Gmail adapter 状态语义错误:`seen_ids`(detected 去重)在 ACK/DONE closeout 之前推进,被误当作 delivered 门槛——"已检测"被记成"已交付",漏投被稳定记住 | Gmail 事故(已验证) |
| A2 | **wake 送达 ≠ 可执行**:目标 session 可能失效;更已证实的形态是 session 存活但 exec 层故障(spawn EBADF,FD 泄漏家族)——收到唤醒也跑不动 a2a CLI 去 ack | 07-06 issac 停滞实锤为后者:16:07/16:14 a2a-log.py 在其 session 内运行失败,16:21 起积压;Hook-C wake_sent 全程正常(审计 v1.2 §四-3) |
| A3 | `pending --limit 1` 边缘触发:多条积压时只感知一条,清一条才见下一条 | 积压消化极慢、watcher 计数抖动 |
| A4 | ACK/DONE closeout 无校验:done 未回写 origin surface 或写错目标 | 任务闭环断裂,发起方无感知 |
| A5 | 补偿(compensate-dispatches)重试耗尽后静默停止 | 2026-07-06 issac 积压 19 条达 7 小时,20 候选/0 动作 |
| A6 | **系统内无任何在运行的积压告警器**:a2a-monitor plist 未加载,且 live 脚本实为 inter_session→Discord 同步器,并非积压告警 | 积压 7 小时、僵尸 2 个月均无告警(审计 D4 修订版) |

### 1.2 系统性缺陷(v2 平台升级对象)

| # | 问题 | 证据 |
|---|------|------|
| S1 | 告警走 A2A 自身通道,循环依赖 | ansen 的 ops-auto-alert-* 积压近 2 个月无人知晓 |
| S2 | 周期任务无合并语义 | sop-email-check 每 15 分钟一条,消费一停线性积压 |
| S3 | 文件扫描式存储,归档从未执行 | cron.jsonl 15MB/1.8万行;archive/ 自 3-28 为空;0 字节 sqlite 为搁置的迁移 |
| S4 | 三套唤醒机制重叠(hook-c/watcher/signal-consumer) | cooldown 互避,故障时责任不清 |
| S5 | 跨机访问两套半成品(SSH 轮询 vs 闲置的 Bridge) | Bridge 自 4-21 后零生产流量,目标硬编码 elon2 |
| S6 | 代码与文档/仓库双重漂移 | git repo 停在 04-26(2457 行) vs live 07-03(2724 行);协议 doc 停在 03-29,代码 22 个事件类型 doc 只载 7 个(06-20 对账确认 9 项欠账) |

**结论**:A 类问题眼前正在造成失败,必须在 P0 内以最小改动修复;S 类问题决定平台上限,走 P1-P3,不得以 S 类重构为由推迟 A 类修复。

## 二、设计目标与原则

**目标**:任何异构 agent(Codex、ChatGPT、OpenClaw、Claude Code、Claude Cowork、Claude Chat 等)以统一契约收发事件;Mac Mini 为唯一事实源。

**五条原则**:

1. **数据契约优先于实现** — 事件 schema、生命周期、幂等规则是标准;各 agent 的接入工具只是适配器。
2. **Pull-first, push-optional** — 轮询收件箱是普适机制(每个 agent 用自己的 cron/schedule 拉取);唤醒/推送只是本机 agent 的加速器,任何 agent 不依赖唤醒也能正常工作。
3. **单一写路径** — 所有写操作必须在 Mac Mini 本机执行(CLI via SSH,或 HTTP API)。**严禁通过 SSHFS/网络挂载直接写事件文件**(flock 跨网络不可靠,是数据损坏隐患)。
4. **失败必须可见** — 每条投递有 owner、租约截止、死信去向;告警通道独立于 A2A 自身。
5. **文档描述协议,测试与 schema 约束协议** — Obsidian 文档是人读权威;机器权威是版本化 schema 文件、迁移脚本、状态机测试和 CLI/Bridge 合约测试(随代码入 git)。文档与测试不一致时,以测试为准并回改文档。

## 三、目标架构

```
┌─────────────────────── 接入层(适配器,按能力选一)───────────────────────┐
│ 本机 agent (OpenClaw)        → a2a CLI 直连 + dispatcher 加速唤醒        │
│ 有 SSH 的 agent (Claude Code@SV / Codex) → ssh macmini "a2a ..."        │
│ 仅 HTTP/MCP 的 agent (ChatGPT / Claude Chat / Cowork) → Bridge v2 API   │
└──────────────────────────────────────────────────────────────────────┘
┌─────────────────────── 协议层(共享契约)──────────────────────────────┐
│ 事件 schema v2 · 生命周期状态机 · collapse/dedupe · agent registry     │
│ 机器权威:schema 文件 + 状态机测试 + 合约测试(git)                      │
└──────────────────────────────────────────────────────────────────────┘
┌─────────────────────── 存储层(Mac Mini 单一事实源)────────────────────┐
│ SQLite (WAL) 主库 · JSONL append-only 审计导出 · 月度归档               │
└──────────────────────────────────────────────────────────────────────┘
┌─────────────────────── 治理层 ────────────────────────────────────────┐
│ 独立看门狗(零 token) · 死信表 · 补偿升级 · 每日备份到 SV                │
└──────────────────────────────────────────────────────────────────────┘
```

## 四、核心改造项

### 4.0 P0:已验证事故修复(不动协议、不动存储)

1. **独立看门狗**(零 token):**审阅现有 a2a-monitor.py 后改造或重写为真正的 pending backlog watchdog——不得直接加载现有脚本当作积压告警**(实测 live 版本是 inter_session→Discord 同步器,与 Version-History 描述不符;"a2a-monitor plist 未加载"作为 launchd 巡检缺口的样本保留)。要求:直发 Discord webhook(复用 macmini notify-discord.sh / SV notify-webhook.url 现成基建),不经 A2A;每 5 分钟统计各 agent pending 数/最老事件年龄/组件心跳;巡检项必须包含 **launchd 关键服务实际加载状态**("写了没开"是已证实的失败模式)、**各 agent 事件产出速率**(升级窗口排查证明:issac 06-12→06-17 停摆 5.9 天,仅看 pending 数不够,连续 N 小时零产出也要告警)与 **gateway FD 占用数**(FD 泄漏 → exec spawn EBADF → 唤醒失效的链条已被 07-04~06 日志证实,阈值告警比事后归档有效);看门狗每日自报 heartbeat。
2. **Gmail adapter 状态门槛修复**:`seen_ids` 仅作 detected 去重,**不得作为 delivered/summarized 成功门槛**;新增/修正 `delivered_ids`/`summarized_ids`,只在可见摘要产出且 DONE 成功后推进(crash-safe 原子写)。语义:同一邮件在 DONE 前可被重新发现/补偿,靠 `message_id`/collapse_key 防重复展示;DONE 后才进入 delivered。
3. **wake 目标校验**:唤醒前校验目标 session 存活且身份匹配;失效则按 registry 重新解析目标或转告警,不对旧 session 空唤醒。
4. **ACK/DONE closeout 事务顺序**:**先确认 origin surface 回写成功,再提交 DONE**;回写失败则保持非终态,记 `closeout_failed` 到 audit/incident sidecar 文件 + 告警。P0 不引入 v2 死信表,不动 schema。
5. **修复 `pending --limit 1` 边缘触发(仅向后兼容增量)**:新增可选参数(如 `--include-count`)或 watcher 内部改用独立 count 查询,以水位而非单条判断;**不改变现有 CLI 输出结构,不破坏现有消费者**。
6. **补偿闭环**:compensate-dispatches 重试耗尽 → 强制 Discord 告警 + 标记 escalated,禁止静默停止。
7. **一次性清理与 FD 根治跟踪**:ansen 5-15 僵尸积压 ack/cancel 归零;issac 07-06 残余 18 条 sop-email-check 积压清零。停滞**根因已定位**:exec spawn EBADF(FD 泄漏家族;07-04/05 两度触发 gateway 重启,07-06 16:07/16:14 a2a-log.py 在 issac session 内运行失败)——立 incident 报告,并将"FD 泄漏根治"与 06-28 FD retention 文档的迁移清单合并跟踪(session 归档每日两跑只是治标)。
8. **launchd 卫生**:卸载失败残留 `ai.openclaw.oneshot.update-20260702`(退出码 127);排查 wiki-lint 与 cron-session-retention 的退出码 1。

**P0 非目标 / 兼容性边界(硬约束)**:

- 不改事件 schema、不改 JSONL 结构、不引入 v2 死信表(closeout_failed 等记 audit/incident sidecar);
- 不破坏现有 CLI 输出(只允许向后兼容的可选参数);
- 不伪造 ack/done——补偿只能重投或告警,不得代替消费者确认;
- 允许改动的范围仅限四类:adapter 本地状态、watcher 查询方式、wake 目标校验、告警可见性。超出即属 P1+,停手走契约流程。

### 4.1 存储:先契约后迁移

- **P1 先定稿 schema v2**(JSON Schema 文件入 git)+ 状态机测试,再开 SQLite 双写(只写不读,与 JSONL 比对一致性)。
- 数据模型职责分离:`events` 表存 **immutable** 事件本体(payload/topic/collapse_key/from,不含 to/status);`deliveries` 表按收件人一行存 `to_agent/status/lease_expires_at/claim_token/attempt_count`(天然支持多收件人,状态互不干扰);`dead_letters` 死信表。**pending 查询主要查 deliveries**。
- **复杂生命周期(claim/collapse/TTL)一律在 DB 上实现,不在 JSONL 上硬做**——避免在脆弱的文件扫描之上再造第二套复杂逻辑。
- 迁移四步:双写 → 一致性校验 → 切读 → JSONL 降级为 append-only 审计导出。WAL + busy_timeout=5s。

### 4.2 接入:三种适配器,同一契约

- **a2a CLI v2**:唯一直接读写者。git 收敛方向 = **以 live 脚本(07-03 版,2724 行)为源 re-import 进 a2a-toolkit repo**(repo 停在 04-26/2457 行,不是合并而是重建基线),废除 .bak 补丁流;5 月后无文档组件(automation-runner、followup-runner、protocol-guard、mailbox-shadow、codex-a2a-consumer、health-check A/B/C)一并纳入 repo,各补一页式设计说明;合约测试覆盖 CLI 输出格式。
- **Bridge auto-post 判生死(决策项)**:auto-post 子系统自 04-24 停摆(bridge-posted-seqs.json 无更新);若 v2 采用长轮询则正式废除并删除 posted-seqs 机制,不留半死代码。
- **Bridge v2 (HTTP)**:废除硬编码目标,补 `to_agent`;**完整 surface**(与租约/安全模型对齐):`POST /v1/notify`、`GET /v1/inbox/{agent}?wait=30`(长轮询)、`POST /v1/events/{id}/claim | ack | done | cancel`、`POST /v1/leases/{claim_token}/renew`;幂等键防重。
- **MCP 适配(可选)**:thin wrapper 包 Bridge API,供 Claude Chat/Cowork 以 connector 方式接入。
- **接入门槛(写进 spec)**:新 agent 只需 ①有定时能力 ②能调 CLI 或 HTTP,即可完成 注册 → 拉取 → 处理 → ack 全流程。

### 4.3 消费模型:pull-first + 完整租约语义

每个 agent 自带定时任务:`a2a inbox --agent X --claim` → 处理 → `ack/done`。租约字段与规则:

| 要素 | 定义 |
|------|------|
| `claim_token` | 领取时颁发的一次性 fencing token;后续 ack/done/renew 必须携带,token 不匹配一律拒绝(防过期 worker 写回) |
| `lease_expires_at` | 租约到期时间。初值 = max(拉取周期 × 2, 任务类型基准值);LLM 长任务用类型基准值 |
| `renew` | `a2a lease renew --token T`:长耗时任务处理中续租;续租需 token 有效 |
| `attempt_count` | 每次租约过期回滚 +1;达上限(默认 3)进死信 + 告警 |
| 过期重投 | 租约过期事件回到 pending 可被他人领取;旧 worker 此后携旧 token 的 done **必须被拒**(fencing),防双重执行结果冲突 |
| ack 后 done 前失败 | ack 表示"已收到并开始处理",仍占用租约;done 前租约过期同样回滚重投。真正终态只有 done/cancelled/dead |

macmini 本机的 hook-c/watcher/signal-consumer **三合一为单个 dispatcher 守护进程**(仅作为本机 OpenClaw agent 的加速唤醒,不承担正确性责任)。

### 4.4 生命周期治理:collapse_key 级合并

- **合并粒度是 collapse_key,不是 topic**。topic 注册时声明是否可折叠及 key 模板,例如:
  - `sop-email-check` → `collapse_key = source + mailbox + message_id`(**默认按 message_id**;仅明确声明为"线程摘要"的任务才用 thread_id,防止线程内不同新邮件被误合并):同一封邮件的重复检查事件才折叠,不同邮件各自独立;
  - `ops-auto-alert-*` → `collapse_key = alert_type + target`:同一告警对象只留最新;
  - 纯"触发式巡检"(事件不承载业务对象,只是叫醒)→ `collapse_key = topic` 整体折叠。
- 折叠只作用于 **pending 且未被 claim** 的旧事件(标记 superseded 并链到新事件),已领取的不动。
- TTL 到期 → `escalated`(告警一次)→ 再一个 TTL → `auto-cancelled` + 死信记录。杜绝"两个月僵尸"。
- 月度归档任务:上月终态事件移入 `archive/YYYY-MM`。

### 4.5 独立看门狗(零 token)

见 4.0-1,P0 即上线;P2 后增加租约过期率、死信增速、collapse 命中率指标。

### 4.6 注册与安全(Bridge v2 前置条件)

- `agent registry`:agent_id、接入方式、token、owner、拉取周期、SLA、ACL。
- **身份**:token 在服务端一对一绑定 agent_id,请求体中的 `agent_id`/`from_agent` 仅作交叉校验,**不得自证身份**;不匹配即 403 并审计。
- **ACL**:registry 声明每个 agent 可写给谁(to 白名单)、可读谁的收件箱(默认仅自己);Bridge/CLI 统一执行。
- **轮换**:token 支持双活轮换(新旧并行一个宽限期),泄露可单独吊销。
- **审计**:所有写操作(notify/ack/done/cancel)记审计日志(who/what/when/from_ip),入库不落敏感 payload。
- **防重放**:写请求携带幂等键 + 时间戳,服务端在重放窗口(如 10 分钟)内去重拒绝。
- 全部限定 Tailscale 内网,不暴露公网;SSH 路径沿用密钥。

## 五、异构 Agent 接入矩阵(能力均为**待实测**,以试点验证为准)

| Agent | 读写能力 | 定时能力 | 推荐接入路径 | 已知限制(截至 2026-07) |
|-------|---------|---------|-------------|----------------------|
| OpenClaw agents (macmini) | 本机文件/CLI | launchd/hook | CLI 直连 + dispatcher 唤醒 | 无 |
| Claude Code (SV) | SSH shell | cron/watcher 脚本 | ssh → CLI(现状保留,后迁 Bridge 长轮询) | 已验证可用 |
| Codex | SSH/shell | cron | ssh → CLI | 待实测 |
| Claude Cowork | MCP(desktop-commander/SSH) | scheduled tasks | ssh → CLI 或 Bridge HTTP | schedule 粒度受产品限制,待实测 |
| Claude Chat | MCP connector | scheduled tasks | Bridge HTTP(经 MCP 适配) | 同上,待实测 |
| ChatGPT | **待验证**的 connector/custom MCP/Workspace Agent 路径 | scheduled tasks | Bridge HTTP(路径待验证) | **官方限制:Tasks ≤1 次/小时、无 webhook、不支持 GPTs**;Workspace Agents 可 schedule/API trigger,但需 Business/Enterprise + 管理员配置,且 API 触发目前不返回 run id/response。不假设普通 Scheduled Tasks 能稳定调用任意 Bridge HTTP;SLA 按小时级定义 |

参考:[Scheduled Tasks in ChatGPT](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt)、[ChatGPT Workspace Agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business)。

**统一心跳契约**:每个接入 agent 按自身拉取周期写 `health.pong`;看门狗据 registry 中的周期判定失联。**各 agent 的 SLA = 其拉取周期,不承诺接近 OpenClaw 本机的实时性。**

## 六、文档与版本迭代规范

- **canonical 目录 = macmini vault `Projects/PROJ-012-Agent-Dashboard/`**(项目全部历史文档所在地:Version-History、Event-Protocol、06-20 对账等)。本方案及后续 spec 在该目录迭代;其他 vault 中的副本一律标注"镜像,以 macmini 为准",消除双 vault 分裂(审计 D6)。
- **人读权威**:上述 Obsidian 目录,frontmatter 版本化 + Changelog。
- **机器权威**:a2a-toolkit repo 中的 schema 文件(JSON Schema)、迁移脚本、状态机单元测试、CLI/Bridge 合约测试。**协议变更 = schema/测试变更 + 文档同步**,只改文档不算协议变更。
- 文档结构:总纲(本文)、Spec-Event-Schema、Spec-Lifecycle(状态机/租约/collapse/TTL)、Spec-Agent-Onboarding、PRD-Bridge-v2、Registry-Agents、Runbook-Ops、Changelog。

## 七、实施路线图(draft-2 重排:先止血,再契约,再存储,再开放)

| Phase | 内容 | 验收标准 |
|-------|------|---------|
| **P0 止血 + 事故修复(1-3 天)** | 独立看门狗(改造/重写 backlog watchdog,详 4.0-1);Gmail adapter delivered/summarized 门槛修复(4.0-2);wake 目标 session 校验;closeout→DONE 事务顺序(4.0-4);pending count 向后兼容增量(4.0-5);补偿耗尽→强制告警;launchd 卫生(4.0-8);清 ansen 僵尸 + issac 停滞根因报告。**边界:见"P0 非目标"** | 积压>30min 或任一 agent 连续 N 小时零产出必有 Discord 告警;Gmail:未 DONE 邮件可被重新发现且不重复展示,DONE 后才进 delivered;现有 CLI 消费者零破坏;僵尸清零 |
| **P1 契约(第 1-2 周)** | 事件 schema v2 定稿(**基线 = 06-20 对账文档 + 07-03 代码现状**,JSON Schema 入 git)+ 状态机测试;06-20 对账列出的 9 项文档欠账全部清偿(canonical Event-Protocol 更新);SQLite 建库并开双写(只写不读);CLI 以 live 为源 re-import git;topic 注册表(含 collapse_key 模板);`workspace/docs/` 盘点并入基线(legacy《A2A-Communication-Standard v1/v2》显式判废或归档,mail-check-sop.md 等纳管) | 双写一致性校验连续 7 天零 diff;合约测试跑通;canonical 协议文档与代码零已知 drift;全系统只余一个 canonical 文档地 |
| **P2 存储 + 生命周期(第 3-4 周)** | 切读 SQLite;claim/lease(含 fencing)、collapse、TTL→死信在 DB 上实现;月度归档;每日备份到 SV | pending 查询<10ms;租约回滚/fencing 测试通过;备份恢复演练通过 |
| **P3 开放(第 5 周起)** | Bridge v2(含 4.6 完整安全模型);dispatcher 三合一;首个外部 agent 试点(建议 Codex 或 Cowork,ChatGPT 最后);MCP 适配 | 外部 agent 完成注册→claim→ack→done(含 closeout 回写)完整闭环;安全用例(假冒 agent_id/重放/过期 token)全部被拒 |

## 八、风险与对策

1. **SQLite 并发**:WAL 单写者模型;所有写经 CLI/Bridge 串行化,busy_timeout=5s。
2. **SSHFS 遗留路径**:改为只读挂载或撤除,防止绕过单一写路径。
3. **外部 agent 定时粒度受限**(ChatGPT ≤1 次/小时、无 webhook;Claude scheduled tasks 粒度待实测):SLA 按各自拉取周期定义;紧急事件走 Discord 通知人类。
4. **Mac Mini 单点**:P2 起每日快照备份到 SV;Runbook 写明恢复步骤。
5. **迁移期双系统并存**:v1 CLI 保持兼容读;claim/collapse 等新语义只在 v2(DB)路径生效,agent 逐个切换;双写期以 JSONL 为准,切读后以 DB 为准。
6. **P0 与 P1 并行的诱惑**:P0 修复禁止顺手引入 schema 变更,防止止血补丁与契约定稿互相污染。

## 相关文档

- [[A2A-深度审计-历史沿革与文实差异-20260707]] — 本方案 draft-4 修订依据(历史时间线、运行清单、D1-D8 文实差异、错误日志汇总)
- macmini vault `Projects/PROJ-012-Agent-Dashboard/A2A-Toolkit-Version-History.md` — v0.pre 至 v0.3+ 完整版本史
- macmini vault `.../A2A-Event-Protocol-Code-Reconciliation-20260620.md` — 协议/代码对账(9 项文档欠账)
- [[A2A-Bridge-PRD]] — v0.1 Bridge PRD(将被 PRD-Bridge-v2 取代)
- 2026-07-06 审计:issac/ansen 积压、归档缺失、补偿失效的完整证据链
- Gmail 事故复盘(P0-2/3/4/5 的依据,待补链接)
