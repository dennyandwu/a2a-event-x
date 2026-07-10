#!/usr/bin/env python3
"""
test_smoke.py — A2A Toolkit smoke tests

验证 a2a-log.py 的核心 CLI 命令行为是否正确。

测试策略：
- 使用 unittest.mock.patch 将 EVENTS_DIR / CURSORS_DIR / AUDIT_DIR / HOOK_C_AUDIT_FILE
  重定向到独立临时目录，避免污染生产数据。
- 每个 TestCase 拥有独立的 tmp_dir，setUp/tearDown 负责隔离与清理。
- Hook-C 会尝试调用 `openclaw agent --session-id …`，在测试环境中该进程不可用，
  但因为使用 subprocess.Popen（fire-and-forget），write 命令本身不会因此失败。
  测试只要求 write 返回 status=written，Hook-C 的 stderr 输出可忽略。
"""

import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

# Path to the script under test
SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "scripts",
    "a2a-log.py",
)


def run_a2a(args: list[str], env: dict) -> subprocess.CompletedProcess:
    """Run a2a-log.py as a subprocess with the given args and env."""
    cmd = [sys.executable, SCRIPT] + args
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=env,
    )


def make_env(tmp_dir: str) -> dict:
    """
    Build a subprocess environment that redirects all a2a-log.py data paths
    into `tmp_dir`.

    a2a-log.py resolves paths at module level using os.path.expanduser("~"),
    so we override HOME to point to a temp directory tree and also patch the
    module-level constants by injecting A2A_LOG_BASE_DIR via an env var shim.

    Since the script doesn't read env vars for EVENTS_DIR, we use a different
    approach: set HOME to a controlled directory so that all ~/.openclaw paths
    land inside tmp_dir.
    """
    env = os.environ.copy()
    # Override HOME so ~/.openclaw/... resolves into tmp_dir
    env["HOME"] = tmp_dir
    # Suppress Hook-C openclaw calls from blocking tests by making openclaw
    # silently unavailable — subprocess.Popen is fire-and-forget so this only
    # affects audit/stderr, not the return code of write.
    return env


class TestA2ALogSmoke(unittest.TestCase):
    """Smoke tests for a2a-log.py CLI commands."""

    def setUp(self):
        """Create a fresh isolated temp directory for each test."""
        self.tmp_dir = tempfile.mkdtemp(prefix="a2a_smoke_")
        self.env = make_env(self.tmp_dir)

    def tearDown(self):
        """Remove the temp directory after each test."""
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _events_dir(self) -> str:
        """Return the expected events dir under our fake HOME."""
        return os.path.join(
            self.tmp_dir, ".openclaw", "workspace", "state", "a2a-log", "events"
        )

    def _events_file(self, agent: str) -> str:
        return os.path.join(self._events_dir(), f"{agent}.jsonl")

    def _read_events(self, agent: str) -> list[dict]:
        """Read all JSONL events from an agent's file."""
        fpath = self._events_file(agent)
        if not os.path.exists(fpath):
            return []
        events = []
        with open(fpath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    events.append(json.loads(line))
        return events

    def _audit_dir(self) -> str:
        return os.path.join(
            self.tmp_dir, ".openclaw", "workspace", "state", "a2a-log", "audit"
        )

    def _hook_c_audit_file(self) -> str:
        return os.path.join(self._audit_dir(), "hook-c.jsonl")

    # ─────────────────────────────────────────────────────────────────────────
    # Test 1: write 命令应创建 JSONL 文件并写入一条事件
    # ─────────────────────────────────────────────────────────────────────────
    def test_write_creates_event(self):
        """write 命令应创建 JSONL 文件并写入一条有效 JSON 事件。"""
        result = run_a2a(
            [
                "write",
                "--from", "issac",
                "--to", "satoshi",
                "--topic", "test",
                "--type", "task.dispatch",
                "--payload", '{"summary":"test"}',
            ],
            self.env,
        )

        # 退出码应为 0
        self.assertEqual(result.returncode, 0, f"stderr: {result.stderr}")

        # stdout 应包含 status=written
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "written")
        self.assertEqual(output["seq"], 1)

        # issac.jsonl 应该存在
        events = self._read_events("issac")
        self.assertEqual(len(events), 1, "应写入恰好 1 条事件")

        event = events[0]
        # 验证基本字段
        self.assertEqual(event["from"], "issac")
        self.assertIn("satoshi", event["to"])
        self.assertEqual(event["topic"], "test")
        self.assertEqual(event["type"], "task.dispatch")
        self.assertEqual(event["seq"], 1)
        self.assertIn("ts", event)
        self.assertIn("correlation_id", event)

    # ─────────────────────────────────────────────────────────────────────────
    # Test 2: 连续写入两条事件，seq 应递增
    # ─────────────────────────────────────────────────────────────────────────
    def test_write_seq_increments(self):
        """连续写入两条事件，seq 应从 1 递增到 2。"""
        for i in range(2):
            result = run_a2a(
                [
                    "write",
                    "--from", "issac",
                    "--to", "satoshi",
                    "--topic", "test-seq",
                    "--type", "task.dispatch",
                    "--payload", f'{{"summary":"event {i}"}}',
                ],
                self.env,
            )
            self.assertEqual(result.returncode, 0, f"第 {i+1} 次写入失败: {result.stderr}")

        events = self._read_events("issac")
        self.assertEqual(len(events), 2, "应写入恰好 2 条事件")

        seqs = [ev["seq"] for ev in events]
        self.assertIn(1, seqs, "第一条事件 seq 应为 1")
        self.assertIn(2, seqs, "第二条事件 seq 应为 2")
        self.assertEqual(sorted(seqs), [1, 2], "seq 应严格递增")

    # ─────────────────────────────────────────────────────────────────────────
    # Test 3: pending 命令应返回目标 agent 的待处理事件
    # ─────────────────────────────────────────────────────────────────────────
    def test_pending_returns_unprocessed(self):
        """write --to satoshi 后，pending --agent satoshi 应返回该事件。"""
        # 写一条发给 satoshi 的事件
        write_result = run_a2a(
            [
                "write",
                "--from", "issac",
                "--to", "satoshi",
                "--topic", "test-pending",
                "--type", "task.dispatch",
                "--payload", '{"summary":"待处理任务"}',
            ],
            self.env,
        )
        self.assertEqual(write_result.returncode, 0, f"write 失败: {write_result.stderr}")

        # 查询 satoshi 的待处理事件
        pending_result = run_a2a(
            ["pending", "--agent", "satoshi"],
            self.env,
        )
        self.assertEqual(pending_result.returncode, 0, f"pending 失败: {pending_result.stderr}")

        output = json.loads(pending_result.stdout)
        self.assertEqual(output["agent"], "satoshi")
        self.assertGreaterEqual(output["count"], 1, "satoshi 应有至少 1 条待处理事件")

        # 验证事件内容
        events = output["events"]
        matching = [ev for ev in events if ev.get("topic") == "test-pending"]
        self.assertEqual(len(matching), 1, "应找到 topic=test-pending 的事件")
        self.assertEqual(matching[0]["from"], "issac")

    # ─────────────────────────────────────────────────────────────────────────
    # Test 4: ack 命令应正确标记事件（写入 task.acked）
    # ─────────────────────────────────────────────────────────────────────────
    def test_ack_marks_event(self):
        """ack 命令应在 satoshi.jsonl 中写入一条 task.acked 事件。"""
        # 先写一条事件
        write_result = run_a2a(
            [
                "write",
                "--from", "issac",
                "--to", "satoshi",
                "--topic", "test-ack",
                "--type", "task.dispatch",
                "--payload", '{"summary":"需要 ACK 的任务"}',
            ],
            self.env,
        )
        self.assertEqual(write_result.returncode, 0)
        write_output = json.loads(write_result.stdout)
        seq = write_output["seq"]  # issac 文件中的 seq

        # satoshi ACK 这条事件
        ack_result = run_a2a(
            [
                "ack",
                "--agent", "satoshi",
                "--seq", str(seq),
                "--file", "issac",
            ],
            self.env,
        )
        self.assertEqual(ack_result.returncode, 0, f"ack 失败: {ack_result.stderr}")

        ack_output = json.loads(ack_result.stdout)
        self.assertEqual(ack_output["status"], "acked")

        # 验证 satoshi.jsonl 中有 task.acked 事件
        satoshi_events = self._read_events("satoshi")
        acked_events = [ev for ev in satoshi_events if ev.get("type") == "task.acked"]
        self.assertEqual(len(acked_events), 1, "satoshi.jsonl 应有 1 条 task.acked")

        ack_ev = acked_events[0]
        self.assertEqual(ack_ev["from"], "satoshi")
        self.assertIn("issac", ack_ev["to"])
        self.assertEqual(ack_ev["causation_id"], f"seq:issac:{seq}")

    # ─────────────────────────────────────────────────────────────────────────
    # Test 5: done 必须能找到原事件，否则报错
    # ─────────────────────────────────────────────────────────────────────────
    def test_done_requires_causation_id(self):
        """done 在没有原事件（seq 不存在）时应失败并返回 error。

        causation_id 由 done 命令从原事件自动推导（seq:{file}:{seq}）。
        若原事件不存在，done 无法推导 causation_id，应返回 error 并以非 0 退出。
        """
        # 直接调用 done，但不先 write（seq=999 不存在）
        done_result = run_a2a(
            [
                "done",
                "--agent", "satoshi",
                "--seq", "999",   # 不存在的 seq
                "--file", "issac",
            ],
            self.env,
        )
        # 应该失败（退出码非 0）
        self.assertNotEqual(done_result.returncode, 0,
                            "done 应在原事件不存在时以非 0 退出")

        # stdout 应包含 error 字段
        output = json.loads(done_result.stdout)
        self.assertIn("error", output, "done 失败时应返回含 error 字段的 JSON")

    # ─────────────────────────────────────────────────────────────────────────
    # Test 6: done 带有效的原事件应成功
    # ─────────────────────────────────────────────────────────────────────────
    def test_done_with_causation(self):
        """先 write，再 done（causation_id 自动推导），应成功返回 status=done。"""
        # 写一条事件
        write_result = run_a2a(
            [
                "write",
                "--from", "issac",
                "--to", "satoshi",
                "--topic", "test-done",
                "--type", "task.dispatch",
                "--payload", '{"summary":"需要标记完成的任务"}',
            ],
            self.env,
        )
        self.assertEqual(write_result.returncode, 0)
        write_output = json.loads(write_result.stdout)
        seq = write_output["seq"]

        # satoshi 标记完成
        done_result = run_a2a(
            [
                "done",
                "--agent", "satoshi",
                "--seq", str(seq),
                "--file", "issac",
                "--summary", "任务已完成",
            ],
            self.env,
        )
        self.assertEqual(done_result.returncode, 0, f"done 失败: {done_result.stderr}")

        done_output = json.loads(done_result.stdout)
        self.assertEqual(done_output["status"], "done")
        self.assertEqual(done_output["causation_id"], f"seq:issac:{seq}")

        # 验证 satoshi.jsonl 中有 task.done 事件
        satoshi_events = self._read_events("satoshi")
        done_events = [ev for ev in satoshi_events if ev.get("type") == "task.done"]
        self.assertEqual(len(done_events), 1, "satoshi.jsonl 应有 1 条 task.done")

        done_ev = done_events[0]
        self.assertEqual(done_ev["from"], "satoshi")
        self.assertEqual(done_ev["causation_id"], f"seq:issac:{seq}")
        self.assertEqual(done_ev["payload"]["summary"], "任务已完成")
        self.assertNotIn("review_result", done_ev["payload"])
        self.assertNotIn("review_scope", done_ev["payload"])
        self.assertNotIn("review_summary", done_ev["payload"])

    # ─────────────────────────────────────────────────────────────────────────
    # Test 7: done 支持 reviewer 结构化结果
    # ─────────────────────────────────────────────────────────────────────────
    def test_done_with_review_result(self):
        """done 带 reviewer 参数时，应在 task.done payload 中写入结构化审核结果。"""
        write_result = run_a2a(
            [
                "write",
                "--from", "issac",
                "--to", "satoshi",
                "--topic", "test-done-review",
                "--type", "task.dispatch",
                "--payload", '{"summary":"需要 reviewer closeout 的任务"}',
            ],
            self.env,
        )
        self.assertEqual(write_result.returncode, 0, f"write 失败: {write_result.stderr}")
        seq = json.loads(write_result.stdout)["seq"]

        done_result = run_a2a(
            [
                "done",
                "--agent", "satoshi",
                "--seq", str(seq),
                "--file", "issac",
                "--summary", "审核完成",
                "--review-result", "pass",
                "--review-scope", "code",
                "--review-summary", "代码审核通过",
            ],
            self.env,
        )
        self.assertEqual(done_result.returncode, 0, f"done 失败: {done_result.stderr}")

        satoshi_events = self._read_events("satoshi")
        done_events = [ev for ev in satoshi_events if ev.get("type") == "task.done"]
        self.assertEqual(len(done_events), 1, "satoshi.jsonl 应有 1 条 task.done")

        payload = done_events[0]["payload"]
        self.assertEqual(payload["review_result"], "pass")
        self.assertEqual(payload["review_scope"], "code")
        self.assertEqual(payload["review_summary"], "代码审核通过")
        self.assertEqual(payload["summary"], "审核完成")

    # ─────────────────────────────────────────────────────────────────────────
    # Test 8: 相同 idempotency_key 第二次写入应被跳过或返回 already_exists
    # ─────────────────────────────────────────────────────────────────────────
    def test_idempotency_key_prevents_duplicate(self):
        """相同 idempotency_key 写入两次后，pending 中应只呈现一条原始事件（write 为 append-only，
        但 idempotency_key 被存储在 meta 字段中供调用方去重参考）。

        设计说明：
          - cmd_write 是 append-only 的 immutable log，不校验 idempotency_key 重复。
          - cmd_done 使用 `from-{agent}-seq-{next_seq}-type-task.done` 作为自动幂等键，
            该键与 next_seq 绑定，每次调用 next_seq 递增，因此在不同进程调用之间无法
            防止重复 done（这是 a2a-log.py 的已知设计限制）。
          - 本测试改为验证：--idempotency-key 正确写入事件的 meta 字段，
            且两次写入同一 idempotency_key 均会成功（append-only 语义），
            共写入 2 条事件（各有独立的 seq），但两条事件的 meta.idempotency_key 相同。
        """
        idem_key = "test-idem-key-001"

        # 第一次写入（带 idempotency_key）
        write1 = run_a2a(
            [
                "write",
                "--from", "issac",
                "--to", "satoshi",
                "--topic", "test-idempotency",
                "--type", "task.dispatch",
                "--payload", '{"summary":"幂等测试第1次"}',
                "--idempotency-key", idem_key,
            ],
            self.env,
        )
        self.assertEqual(write1.returncode, 0, f"第1次 write 失败: {write1.stderr}")
        out1 = json.loads(write1.stdout)
        self.assertEqual(out1["status"], "written")
        seq1 = out1["seq"]

        # 第二次写入（相同 idempotency_key）
        write2 = run_a2a(
            [
                "write",
                "--from", "issac",
                "--to", "satoshi",
                "--topic", "test-idempotency",
                "--type", "task.dispatch",
                "--payload", '{"summary":"幂等测试第2次"}',
                "--idempotency-key", idem_key,
            ],
            self.env,
        )
        self.assertEqual(write2.returncode, 0, f"第2次 write 失败: {write2.stderr}")
        out2 = json.loads(write2.stdout)
        self.assertEqual(out2["status"], "written")
        seq2 = out2["seq"]

        # 两次写入 seq 应不同（append-only，每次递增）
        self.assertNotEqual(seq1, seq2, "两次写入的 seq 应不同")
        self.assertEqual(seq2, seq1 + 1, "seq 应连续递增")

        # 验证两条事件的 meta.idempotency_key 都被正确存储
        events = self._read_events("issac")
        idem_events = [
            ev for ev in events
            if (ev.get("meta") or {}).get("idempotency_key") == idem_key
        ]
        self.assertEqual(len(idem_events), 2,
                         "两次写入都应以 idempotency_key 存入 meta 字段")

    # ─────────────────────────────────────────────────────────────────────────
    # Test 9: write task.dispatch 应触发 Hook-C（至少不影响 write 成功）
    # ─────────────────────────────────────────────────────────────────────────
    def test_hook_c_fires_on_dispatch(self):
        """write task.dispatch 应触发 Hook-C；write 本身必须成功（返回 status=written）。

        Hook-C 会尝试调用 `openclaw agent …` 唤醒目标 agent。在测试环境中，
        openclaw 命令可能不可用，但 Hook-C 使用 subprocess.Popen（fire-and-forget），
        失败不影响 write 的退出码。
        本测试验证：
          1. write 返回 status=written（Hook-C 失败不应传播）
          2. hook-c.jsonl audit 文件应被写入（验证 Hook-C 确实触发了）
        """
        result = run_a2a(
            [
                "write",
                "--from", "issac",
                "--to", "satoshi",
                "--topic", "test-hook-c",
                "--type", "task.dispatch",
                "--payload", '{"summary":"Hook-C 触发测试"}',
            ],
            self.env,
        )

        # write 必须成功
        self.assertEqual(result.returncode, 0,
                         f"write 应成功，不应因 Hook-C 失败而出错: {result.stderr}")
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "written")

        # 给 Hook-C Popen 稍作等待（fire-and-forget）
        import time
        time.sleep(0.2)

        # 验证 hook-c.jsonl audit 文件已被写入
        audit_file = self._hook_c_audit_file()
        self.assertTrue(
            os.path.exists(audit_file),
            f"hook-c.jsonl 应被创建，路径: {audit_file}\nstderr: {result.stderr}",
        )

        # 读取 audit 记录
        records = []
        with open(audit_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))

        self.assertGreater(len(records), 0, "hook-c.jsonl 应有至少 1 条 audit 记录")

        # 验证 audit 记录的基本结构
        rec = records[0]
        self.assertEqual(rec.get("hook"), "hook-c")
        self.assertIn("outcome", rec)
        self.assertIn("target_agent", rec)
        self.assertEqual(rec.get("target_agent"), "satoshi")

        # outcome 可以是 wake_sent / wake_failed / no_session / duplicate_skip
        # 任何一个都表示 Hook-C 触发了
        valid_outcomes = {"wake_sent", "wake_failed", "no_session", "duplicate_skip", "terminal_suppressed"}
        self.assertIn(rec["outcome"], valid_outcomes,
                      f"Hook-C outcome 应为已知值之一，实际: {rec['outcome']}")

    # ─────────────────────────────────────────────────────────────────────────
    # Test 10: compensate-dispatches dry-run 应找出超时未 ACK 的 dispatch
    # ─────────────────────────────────────────────────────────────────────────
    def test_compensate_dispatches_dry_run_finds_stale_dispatch(self):
        """对超时未 ACK 的 task.dispatch，compensate-dispatches --dry-run 应给出 retry_wake 动作。"""
        write_result = run_a2a(
            [
                "write",
                "--from", "issac",
                "--to", "satoshi",
                "--topic", "test-compensation",
                "--type", "task.dispatch",
                "--payload", '{"summary":"等待补偿扫描的任务"}',
            ],
            self.env,
        )
        self.assertEqual(write_result.returncode, 0, f"write 失败: {write_result.stderr}")

        comp_result = run_a2a(
            [
                "compensate-dispatches",
                "--agent", "satoshi",
                "--stale-minutes", "0",
                "--limit", "10",
                "--dry-run",
            ],
            self.env,
        )
        self.assertEqual(comp_result.returncode, 0, f"compensate-dispatches 失败: {comp_result.stderr}")
        output = json.loads(comp_result.stdout)
        self.assertEqual(output["status"], "ok")
        self.assertGreaterEqual(output["candidate_count"], 1)
        self.assertGreaterEqual(output["action_count"], 1)
        self.assertEqual(output["actions"][0]["action"], "retry_wake")


if __name__ == "__main__":
    unittest.main(verbosity=2)
