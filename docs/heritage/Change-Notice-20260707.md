---
title: "A2A v2 升级变更通知(全体 agent)"
date: 2026-07-07
status: active
version: "1.0"
tags: [proj-012, a2a, change-notice]
---

# A2A v2 升级变更通知 — 2026-07-07

> 收到本通知的 agent:请 ①阅读"全体"节 + 你名下的分节;②把要点写入**你自己的持久记忆**(OpenClaw agents → 你的 workspace memory;Claude Code agents → 你的 MEMORY.md/AGENTS.md 惯例位置);③对通知事件先 `ack`,再 `done`,**done 的 summary 必须注明记忆落点路径**。详情文档均在 macmini vault `Projects/PROJ-012-Agent-Dashboard/`。

## 全体必读

1. **协议文档换代**:《Spec-Event-Schema v2.0》《Spec-Lifecycle v2.0》取代 3-29 的 A2A-Event-Protocol v1.1。要点:22 个事件类型;idempotency_key 实际格式 `{type}:{agent}:ref:{from}:{seq}`;关闭 dispatch 必须用 `done` 子命令(不是 write --type task.done);Doc-First 门禁 200/500 不变。
2. **done 有了事务门禁(P0-4)**:非 Discord 起源的 done 会先同步回写 origin surface,失败则 done 不提交并返回 `closeout_failed`——遇到时重试或按提示处理,不要绕。
3. **write 的 --idempotency-key 现在真的查重**(此前只存不查),重放返回 `DUPLICATE_SKIP`。
4. **独立看门狗已上线**:pending 积压>30min、产出停滞、launchd 服务未加载、gateway FD 超限都会直发 Discord 告警——积压不再无人知晓,也意味着**别再让任务挂 pending**。
5. **SQLite 双写进行中**(JSONL 仍是 canonical):明日 G1 门检通过后将分批切读 v2(带租约/fencing 的 `a2a-v2 inbox --claim`),次序 cowork→SV→本机,切你之前会另行通知。
6. 事件库每日备份至 SV;a2a-toolkit repo 已以 live 为基线重建(commit 44eb256),改脚本请走 repo,别再 .bak。

## issac

- 你 07-06 16:21-20:39 的 sop-email-check 积压根因已定位:exec spawn EBADF(FD 泄漏家族),18 条残余已 cancelled;gateway 已受控重启。
- compensate 现在会把"wake 已送达但你长时间未 ack"的事件升级并直发 Discord——收到唤醒请及时 ack。

## ansen

- 你名下曾积压 **5,564 条** ops-auto-alert(5-15 起,分页假象曾报 20 条),已 watermark 归零。
- 根因已修:ops-closure-worker 白名单 3→9 topics,你的 ops-auto 告警现在会被自动关单;真正需要你处理的任务不受影响。

## satoshi2 / elon2 / wiki(SV)

- 你们的 **Bridge v2 token 已分发**至 SV `~/.openclaw/config/bridge-tokens/<你>.token`(Bridge = http://100.71.176.10:8766,ACL:只能读自己收件箱)。
- **当前继续用 ssh 路径**;`a2a-watcher-bridge.sh` 已 standby(长轮询替代 30s 轮询,bridge 挂了自动降级回 ssh),G2 待令后一行切换,届时另行通知。
- 提醒:pending 查询别带 `--limit`(count 会被截断,这个坑刚造成过 5.5k 暗积压)。

## cron / automation-runner(producer-only,无需回执)

- cron 名下 138 条 4/25-27 事故残渣已 watermark 归零;registry 明确 cron 不消费 dispatch,今后误派给 cron 会被看门狗当天抓到。

## 后续时间线(gated-ASAP)

明日 15:10 自动门检(G1 双写 soak + G4b 观察窗)→ 0xFG 说"切"启动 G2 → 07-09 03:00 dispatcher 三合一(已批,自动执行带回滚)。
