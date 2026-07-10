#!/usr/bin/env python3
"""P1 patch: a2a-log.py canonical 追加成功后 best-effort 双写 v2 SQLite。"""
p = "/Users/0xfg_bot/.openclaw/scripts/a2a-log.py"
s = open(p).read()

anchor = '''            ev_clean = {k: v for k, v in event.items() if k != "_source_file"}
            with open(fpath, "a", encoding="utf-8") as f:
                f.write(json.dumps(ev_clean, ensure_ascii=False) + "\\n")

            return next_seq'''
new = '''            ev_clean = {k: v for k, v in event.items() if k != "_source_file"}
            with open(fpath, "a", encoding="utf-8") as f:
                f.write(json.dumps(ev_clean, ensure_ascii=False) + "\\n")

            # P1: v2 SQLite 双写(只写不读)。best-effort —— 任何失败不得影响 canonical 写。
            try:
                import importlib
                _scripts_dir = os.path.dirname(os.path.abspath(__file__))
                if _scripts_dir not in sys.path:
                    sys.path.insert(0, _scripts_dir)
                _v2 = importlib.import_module("a2a_v2_store")
                _v2.record_event(agent, ev_clean)
            except Exception as _v2_exc:
                try:
                    sys.stderr.write("[v2-dual-write] skipped: {}\\n".format(_v2_exc))
                except Exception:
                    pass

            return next_seq'''
assert s.count(anchor) == 1, "anchor not found or not unique"
open(p, "w").write(s.replace(anchor, new))
print("P1 dual-write patch applied")
