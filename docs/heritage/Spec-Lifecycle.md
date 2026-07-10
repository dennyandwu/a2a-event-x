---
title: "A2A Spec — Lifecycle v2.0(状态机/租约/折叠/TTL)"
date: 2026-07-07
status: active
version: "2.0"
tags: [proj-012, a2a, spec]
---

# A2A Lifecycle v2.0

> 机器权威:`a2a_v2_store.py` + `a2a-v2.py` + `tests/test_contract_v2.py`。

## Delivery 状态机(per 收件人)

```
                    ┌──────────── lease 过期(attempt+1)────────────┐
                    ▼                                              │
 dispatch ──► pending ──claim──► claimed ──ack──► acked ──done──► done
                │                   │                              (终态)
                │                   └─ renew(续租,token 校验)
                ├──► superseded(collapse:仅 pending 且未 claim)   (终态)
                ├──► cancelled                                     (终态)
                ├──► escalated ──(再一个 TTL)──► auto-cancelled
                └──► historical(watermark 重置)                   (终态)
 attempt ≥ 3 ────► dead + dead_letters + webhook 告警              (终态)
```

- **ACK ≠ DONE**(G10 铁律不变):pipeline 推进只看 done。
- 终态不可被非终态覆盖(store 层强制)。

## 租约(claim/lease)

| 要素 | 规则 |
|------|------|
| claim_token | claim 时颁发,一次性 fencing token;ack/done/renew/cancel 必须携带;token 不匹配/过期 → 409 拒绝 |
| lease_expires_at | 默认 3600s(`--lease-s` 可调);LLM 长任务先 claim 短租 + 处理中 renew |
| 过期回滚 | claimed 且 lease 过期 → 回 pending,attempt_count+1,token 作废;**旧 worker 携旧 token 的任何写回必须被拒**(已验证) |
| attempt ≥ 3 | → dead + dead_letters + 独立告警 |
| ack 后 done 前失败 | 仍占租约;过期同样回滚重投 |

## 折叠(collapse)

- 粒度 = `topics.json` 注册的 collapse_key,**不是 topic**;
- 只折叠 **pending 且未被 claim** 的旧事件 → 标 superseded 并链到新事件;
- enforcement 于 G1 后随 v2 切读启用(当前为声明 + 注册表)。

## TTL 与补偿

- TTL 到期 → escalated(告警一次)→ 再一个 TTL → auto-cancelled + 死信。
- compensate-dispatches(P0-6 后):尊重 pending watermark;`wake_sent` 且 stale ≥ max(3×stale_minutes, 30m) → 升级 + **直发 webhook**(不再静默);升级幂等(`compensate-{from}-{seq}-{target}-escalate`)。

## 门(gated-ASAP,无日历排期)

| 门 | 条件(可追溯的外部约束) | 状态 @2026-07-07 |
|----|--------------------------|------------------|
| **G0 止血** | P0 全项 + watchdog 在线 | ✅ 已过 |
| **G1 双写可信** | ① 合约测试全绿(合成流量覆盖全部写路径);② 真实混合流量 soak ≥ 24h 且 verify 零 diff(约束:hook-c/pipeline/compensate/closeout 各路径只在其自然节奏上发生,最慢的日级路径 = 归档/retention 任务在 05:10/17:00 触发,需跨一个完整日周期);③ watchdog 每小时自动 verify 无告警 | ①✅ ②③ 进行中(自动监督,无需人工等待) |
| **G2 切读** | G1 过 + pending 语义对照(v1 pending vs v2 deliveries 连续零语义 diff)→ 消费者逐个切 `a2a-v2 inbox`(次序:cowork→SV agents→本机) | 待 G1 |
| **G3 生命周期启用** | G2 过 → collapse/TTL→dead 在 DB 上启用;JSONL 降级审计 | 待 G2 |
| **G4a Bridge v2** | 安全模型经 0xFG 确认(2026-07-07"全部同意":32B token/默认拒绝 ACL/仅 Tailscale/审计 90 天) | ✅ 已过:8766 上线,安全用例 6/6,HTTP 全闭环验收通过 |
| **G4b dispatcher 收敛** | 观察 issac 一个活跃日 wake 行为(人驱动,不可压缩);观察窗 2026-07-07 14:00 起,自动门检 07-08 15:10 | 观察中 |
