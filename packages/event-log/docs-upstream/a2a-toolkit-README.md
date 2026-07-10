# A2A Toolkit

> urDAO 多 Agent 系统的核心通讯与编排基础设施

**Event Log** — Immutable append-only 事件总线（消息的唯一 source of truth）  
**Hook-C** — 事件写入后的即时唤醒机制（主触发器）  
**Pipeline Executor** — 多步骤工作流自动编排引擎  
**A2A Send** — 标准化消息发送入口

## 文件结构

```
scripts/
├── a2a-log.py           # Event Log CLI + Hook-C（核心，~1900行）
├── a2a-send.sh          # 标准 A2A 发送入口
├── a2a-send.py          # Python 发送封装
├── a2a_routing.py       # Context-Aware Routing 解析
├── pipeline-executor.py # Pipeline 编排引擎（~1960行）
├── pipeline_utils.py    # Pipeline 工具函数
├── a2a-projector.py     # Event → 快照投影器
├── a2a-monitor.py       # Event Log 健康检查
└── a2a-log-escalate.py  # TTL 超时升级

tests/
└── test_smoke.py        # Smoke test（write/ack/done/pending/Hook-C）

docs/
└── (PRD 和设计文档在 Obsidian Vault 中维护)
```

## 快速上手

```bash
# 写入事件
python3 scripts/a2a-log.py write --from issac --to satoshi --topic test --type task.dispatch --payload '{"summary":"test"}'

# 查询待处理
python3 scripts/a2a-log.py pending --agent satoshi

# 运行测试
python3 -m pytest tests/ -v
```

## 版本

当前版本：**v0.3**（Context Routing + Hook-C）

详细版本历史见 `Obsidian Vault/Projects/PROJ-012-Agent-Dashboard/A2A-Toolkit-Version-History.md`

## 协议

私有仓库，仅限 urDAO 内部使用。
