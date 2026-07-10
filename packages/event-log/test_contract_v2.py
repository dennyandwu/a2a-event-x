#!/usr/bin/env python3
"""
A2A v2 合约测试(P1)。直接 python3 运行,零依赖;全部通过退出 0。
使用保留身份 test(producer)/ test-agent(consumer),在生产存储上跑真实全链路:
  v1 write → DB 双写 → v1 pending → v2 claim(fencing)→ v2 ack → v2 done → 终态一致
覆盖:双写一致性、count 不截断、fencing 拒绝、幂等 DUPLICATE、cancelled、renew。
"""
import json
import os
import subprocess
import sys
import uuid

PY = sys.executable
V1 = os.path.expanduser("~/.openclaw/scripts/a2a-log.py")
V2 = os.path.expanduser("~/.openclaw/scripts/a2a-v2.py")
sys.path.insert(0, os.path.expanduser("~/.openclaw/scripts"))
import a2a_v2_store as store

PASS, FAIL = 0, 0


def run(cmd, expect_rc=0):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    return r.returncode, r.stdout, r.stderr


def j(out):
    return json.loads(out)


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def db():
    return store.connect()


def main():
    topic = f"contract-{uuid.uuid4().hex[:8]}"
    print(f"== contract run topic={topic} ==")

    # 1. v1 write dispatch → 双写
    rc, out, _ = run([PY, V1, "write", "--from", "test", "--to", "test-agent",
                      "--topic", topic, "--type", "task.dispatch",
                      "--payload", json.dumps({"summary": "contract dispatch"})])
    d = j(out)
    seq = d.get("seq")
    check("write rc0 + seq", rc == 0 and isinstance(seq, int), out[:120])
    c = db()
    row = c.execute("SELECT type, topic FROM events WHERE source_file='test' AND seq=?", (seq,)).fetchone()
    check("dual-write event row", row == ("task.dispatch", topic), str(row))
    drow = c.execute("SELECT status FROM deliveries WHERE source_file='test' AND seq=? AND to_agent='test-agent'", (seq,)).fetchone()
    check("dual-write delivery pending", drow == ("pending",), str(drow))
    c.close()

    # 2. v1 pending 全量 count(不被 limit 截断)
    rc, out, _ = run([PY, V1, "pending", "--agent", "test-agent"])
    p = j(out)
    check("v1 pending contains", any(e.get("seq") == seq and e.get("from") == "test" for e in p["events"]), str(p["count"]))
    rc, out, _ = run([PY, V1, "pending", "--agent", "test-agent", "--limit", "1"])
    p1 = j(out)
    check("limit caps events not semantics (documented)", len(p1["events"]) <= 1)

    # 3. v2 claim + fencing
    rc, out, _ = run([PY, V2, "inbox", "--agent", "test-agent", "--claim", "--lease-s", "600", "--limit", "50"])
    inbox = j(out)
    mine = [e for e in inbox["events"] if e["seq"] == seq and e["source_file"] == "test"]
    check("v2 claim returns token", len(mine) == 1 and mine[0].get("claim_token"), out[:150])
    token = mine[0]["claim_token"]
    rc2, out2, _ = run([PY, V2, "inbox", "--agent", "test-agent", "--claim", "--limit", "50"])
    inbox2 = j(out2)
    check("claimed 不重复派发", not any(e["seq"] == seq and e["source_file"] == "test" for e in inbox2["events"]))
    rc3, out3, _ = run([PY, V2, "done", "--token", "deadbeef" + "0" * 24])
    check("fencing: 假 token 被拒", rc3 != 0)

    # 4. renew
    rc, out, _ = run([PY, V2, "renew", "--token", token, "--extend-s", "1200"])
    check("renew ok", rc == 0 and j(out)["status"] == "renewed", out[:120])

    # 5. v2 ack → v1 acked 事件存在
    rc, out, _ = run([PY, V2, "ack", "--token", token])
    check("v2 ack ok", rc == 0 and j(out)["status"] == "acked", out[:150])

    # 6. v2 done → v1 task.done + delivery done + pending 清除
    rc, out, _ = run([PY, V2, "done", "--token", token, "--summary", "contract done"])
    check("v2 done ok", rc == 0 and j(out)["status"] == "done", out[:200])
    c = db()
    st = c.execute("SELECT status FROM deliveries WHERE source_file='test' AND seq=? AND to_agent='test-agent'", (seq,)).fetchone()
    check("delivery 终态 done", st == ("done",), str(st))
    c.close()
    rc, out, _ = run([PY, V1, "pending", "--agent", "test-agent"])
    check("v1 pending 已清", not any(e.get("seq") == seq and e.get("from") == "test" for e in j(out)["events"]))

    # 7. 幂等:重复 done → already_exists
    rc, out, _ = run([PY, V1, "done", "--agent", "test-agent", "--seq", str(seq), "--file", "test", "--summary", "dup"])
    check("duplicate done → already_exists", j(out).get("status") == "already_exists", out[:150])

    # 8. cancelled 路径 + 双写终态
    rc, out, _ = run([PY, V1, "write", "--from", "test", "--to", "test-agent",
                      "--topic", topic, "--type", "task.dispatch",
                      "--payload", json.dumps({"summary": "to cancel"})])
    seq2 = j(out)["seq"]
    rc, out, _ = run([PY, V1, "cancelled", "--agent", "test-agent", "--seq", str(seq2), "--file", "test", "--reason", "contract cancel"])
    check("cancelled rc0", rc == 0, out[:120])
    c = db()
    st = c.execute("SELECT status FROM deliveries WHERE source_file='test' AND seq=? AND to_agent='test-agent'", (seq2,)).fetchone()
    check("delivery 终态 cancelled", st == ("cancelled",), str(st))
    c.close()

    print(f"== result: pass={PASS} fail={FAIL} ==")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
