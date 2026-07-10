---
title: "A2A Spec — Event Schema v2.0"
date: 2026-07-07
status: active
version: "2.0"
tags: [proj-012, a2a, spec]
---

# A2A Event Schema v2.0(人读版)

> **机器权威**:`a2a-toolkit/schema/a2a-event-v2.schema.json` + `tests/test_contract_v2.py`(16/16 green @2026-07-07)。文档与测试不一致时以测试为准。
> 本文清偿 06-20 对账文档列出的 9 项欠账,取代 A2A-Event-Protocol.md(v1.1, 2026-03-29)成为现行契约描述。

## 事件类型(22 类,清偿欠账 #1)

- **business**:`task.dispatch / acked / done / blocked / escalated / cancelled / retry / retry_exhausted / delivered`、`result.partial`、`info.sync / decision`、`release.request / review_pass / done`、`reminder.*`
- **control**(`system.` 前缀自动归类):`system.heartbeat / wake / continue / compaction`
- **health**(协议外带,骑 A2A transport):`health.ping / pong`
- 未注册类型:写入门禁 warn 后仍写入(不静默丢弃)。

## 写入门禁(欠账 #2)

Doc-First(仅 business 类):`summary ≤ 200 字符`、payload JSON `≤ 500 字符`,超限必须改传 `doc_path`;白名单豁免字段:`ref_seq / ref_from / pipeline_id / pipeline_name / _idempotency_key`。

## 幂等与因果(欠账 #3/#4)

- `idempotency_key` 格式(代码实测):**`{type}:{agent}:ref:{from}:{seq}`**(旧文档的 `from-{from}-seq-...` 作废)。resolution 事件强制;重复 → `DUPLICATE_SKIP`。
- `causation_id` 格式:`seq:<from>:<seq>`;`task.done` 强制非空。**关闭 dispatch 必须用 `done` 子命令**(自动填 causation + ref),用 `write --type task.done` 会缺因果链导致补偿无限 retry。
- `correlation_id` 自动生成规则:未传入时 = `workflow-<topic>-<YYYYMMDD>`(含日期);done/ack 继承原值,禁止追加后缀(G10/R3)。
- 校验先于幂等:done 的 summary/closeout 校验不通过时,在幂等检查之前就被拒(合约测试确认)。

## Closeout(欠账 #5)

`closeout_policy ∈ {required, optional, none}`;`closeout_target{surface, channel_id, thread_id, session_key, mode}` 由 write 时派生(`inherited_origin / implicit_fallback / explicit_override`)。**P0-4 起:非 Discord 起源的 done 必须先同步回写 origin surface 成功才提交终态**;失败记 `audit/closeout-failed.jsonl` + webhook 告警;逃生旗标 `--skip-closeout-gate`(使用留审计)。

## Pipeline 与并发(欠账 #6/#7)

- `pipeline_id = pl-<correlation_id>`(自动创建);Executor 匹配用 correlation 前缀匹配。
- 写并发:`_locked_append_event` per-file flock 原子分配 seq。flock 之前时代存在 55 条历史重复 seq(4 文件),v2 DB 以 UNIQUE(source_file,seq) 去重,校验按 distinct seq 对账。

## CLI(欠账 #8)

v1(canonical 写路径):`write / read / ack / done / pending / pending-init-watermark / blocked / cancelled / compensate-dispatches`;`write --dry-run`;`done --skip-closeout-gate`;compensate 输出含 `webhook_sent`(向后兼容新增)。
v2(消费租约层,truth 仍经 v1):`a2a-v2 inbox --claim / ack / done / renew / cancel`(claim_token fencing)。
**注意**:`pending --limit N` 会连 `count` 一起截断——count 语义修正排 v2 切读时处理;机器消费一律不带 --limit(watcher 已改)。

## v2 存储(双写中)

`db/a2a-v2.sqlite`(WAL):`events`(immutable,不含 to/status)+ `deliveries`(per-收件人:status/lease/claim_token/attempt_count)+ `dead_letters`。pending 查 deliveries。JSONL 仍是 canonical,切读见 Spec-Lifecycle 的 G1 门。

## 注册表

- `topics.json`:collapse_key 模板(sop-email-check→message_id 级;ops-auto-alert-*→alert_type+target;触发式→topic 级)。
- `registry-agents.json`:agent 接入方式/拉取周期/SLA/ACL;`test`/`test-agent` 保留给合约测试;retired: satoshi/elon/Elon Musk II/collect。
