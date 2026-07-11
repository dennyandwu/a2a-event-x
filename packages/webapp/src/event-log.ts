/**
 * Event Log proxy: v2 (claim/lease) + v1 (JSONL pending) + registry/status.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function eventLogPaths(repoRoot: string) {
  const v2 = path.join(repoRoot, "packages/event-log/a2a-v2.py");
  const v1 = path.join(repoRoot, "packages/event-log/scripts/a2a-log.py");
  const store = path.join(repoRoot, "packages/event-log/a2a_v2_store.py");
  const registry = path.join(repoRoot, "packages/event-log/registry-agents.json");
  const topics = path.join(repoRoot, "packages/event-log/topics.json");
  const home = expandHome(
    process.env.A2A_LOG_HOME || "~/.openclaw/workspace/state/a2a-log",
  );
  const db = expandHome(
    process.env.A2A_V2_DB || path.join(home, "db", "a2a-v2.sqlite"),
  );
  return {
    v1,
    v2,
    store,
    registry,
    topics,
    home,
    db,
    eventsDir: path.join(home, "events"),
    auditDir: path.join(home, "audit"),
    v1Exists: fs.existsSync(v1),
    v2Exists: fs.existsSync(v2),
    homeExists: fs.existsSync(home),
    dbExists: fs.existsSync(db),
    eventsDirExists: fs.existsSync(path.join(home, "events")),
  };
}

export function runPython(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [script, ...args], {
      env: { ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function parseJsonOut(stdout: string, stderr: string): unknown {
  const text = (stdout || stderr || "").trim();
  if (!text) return { error: "empty_output" };
  try {
    return JSON.parse(text);
  } catch {
    // try last JSON object in output
    const i = text.lastIndexOf("{");
    if (i >= 0) {
      try {
        return JSON.parse(text.slice(i));
      } catch {
        /* fallthrough */
      }
    }
    return { raw: text.slice(0, 4000) };
  }
}

export async function runEventV2(
  repoRoot: string,
  args: string[],
): Promise<{ status: number; body: unknown }> {
  const p = eventLogPaths(repoRoot);
  if (!p.v2Exists) {
    return {
      status: 503,
      body: { error: "event_log_missing", hint: "a2a-v2.py not found" },
    };
  }
  const result = await runPython(p.v2, args, {
    ...process.env,
    A2A_LOG_CLI: process.env.A2A_LOG_CLI || p.v1,
    A2A_LOG_HOME: process.env.A2A_LOG_HOME || p.home,
    A2A_V2_DB: process.env.A2A_V2_DB || p.db,
  });
  const body = parseJsonOut(result.stdout, result.stderr);
  if (!result.ok) {
    return {
      status: 400,
      body:
        typeof body === "object" && body
          ? body
          : {
              error: "event_log_failed",
              code: result.code,
              detail: (result.stderr || result.stdout).slice(0, 2000),
            },
    };
  }
  return { status: 200, body };
}

export async function runEventV1(
  repoRoot: string,
  args: string[],
): Promise<{ status: number; body: unknown }> {
  const p = eventLogPaths(repoRoot);
  if (!p.v1Exists) {
    return {
      status: 503,
      body: { error: "a2a_log_missing", hint: "scripts/a2a-log.py not found" },
    };
  }
  const result = await runPython(p.v1, args, {
    ...process.env,
    A2A_LOG_HOME: process.env.A2A_LOG_HOME || p.home,
  });
  const body = parseJsonOut(result.stdout, result.stderr);
  if (!result.ok) {
    return {
      status: 400,
      body:
        typeof body === "object" && body
          ? body
          : {
              error: "v1_failed",
              code: result.code,
              detail: (result.stderr || result.stdout).slice(0, 2000),
            },
    };
  }
  return { status: 200, body };
}

/** Normalize v1 pending events for UI (add source_file, mode). */
export function normalizeV1Pending(
  agent: string,
  body: unknown,
): {
  agent: string;
  mode: "v1";
  claimed: false;
  count_remaining_pending: number;
  events: Record<string, unknown>[];
} {
  const b = (body || {}) as { events?: unknown[]; count?: number };
  const events = (b.events || []).map((ev) => {
    const e = (ev || {}) as Record<string, unknown>;
    const from = String(e.from || "");
    const seq = e.seq;
    return {
      ...e,
      source_file: e._source_file || e.source_file || from,
      mode: "v1",
      claim_token: null,
      // v1 ops keys
      v1: {
        agent,
        seq,
        file: e._source_file || e.source_file || from,
      },
    };
  });
  return {
    agent,
    mode: "v1",
    claimed: false,
    count_remaining_pending: b.count ?? events.length,
    events,
  };
}

export function normalizeV2Inbox(
  body: unknown,
  claimed: boolean,
): {
  agent: string;
  mode: "v2";
  claimed: boolean;
  count_remaining_pending: number;
  events: Record<string, unknown>[];
} {
  const b = (body || {}) as {
    agent?: string;
    claimed?: boolean;
    count_remaining_pending?: number;
    events?: Record<string, unknown>[];
  };
  const events = (b.events || []).map((e) => ({
    ...e,
    mode: "v2",
    source_file: e.source_file,
  }));
  return {
    agent: b.agent || "",
    mode: "v2",
    claimed: Boolean(b.claimed ?? claimed),
    count_remaining_pending: b.count_remaining_pending ?? events.length,
    events,
  };
}

export async function inboxAuto(
  repoRoot: string,
  opts: {
    agent: string;
    limit: string;
    claim: boolean;
    mode: "auto" | "v2" | "v1";
    leaseS?: string;
    topic?: string;
  },
): Promise<{ status: number; body: unknown }> {
  const wantV2 = opts.mode === "auto" || opts.mode === "v2";
  const wantV1 = opts.mode === "auto" || opts.mode === "v1";

  if (wantV2) {
    const args = [
      "inbox",
      "--agent",
      opts.agent,
      "--limit",
      opts.limit,
      "--lease-s",
      opts.leaseS || "3600",
    ];
    if (opts.claim) args.push("--claim");
    const v2 = await runEventV2(repoRoot, args);
    if (v2.status === 200) {
      const norm = normalizeV2Inbox(v2.body, opts.claim);
      // auto fallback when empty and not claiming (claim only works on v2)
      if (
        opts.mode === "auto" &&
        !opts.claim &&
        norm.events.length === 0 &&
        wantV1
      ) {
        const v1 = await runEventV1(repoRoot, [
          "pending",
          "--agent",
          opts.agent,
          "--limit",
          opts.limit,
          ...(opts.topic ? ["--topic", opts.topic] : []),
        ]);
        if (v1.status === 200) {
          const n1 = normalizeV1Pending(opts.agent, v1.body);
          if (n1.events.length > 0) {
            return {
              status: 200,
              body: {
                ...n1,
                fallback_from: "v2_empty",
                note: "v2 sqlite 无 pending，已回退 v1 JSONL pending（无 claim_token，用 v1 ack/done）",
              },
            };
          }
        }
      }
      return {
        status: 200,
        body: {
          ...norm,
          note: opts.claim
            ? "v2 claim — use claim_token for ack/done/renew/cancel"
            : "v2 inbox",
        },
      };
    }
    if (opts.mode === "v2") return v2;
  }

  if (wantV1) {
    if (opts.claim) {
      return {
        status: 400,
        body: {
          error: "claim_requires_v2",
          hint: "JSONL v1 无 lease；请用 mode=v2 或先确保 sqlite 双写",
        },
      };
    }
    const v1 = await runEventV1(repoRoot, [
      "pending",
      "--agent",
      opts.agent,
      "--limit",
      opts.limit,
      ...(opts.topic ? ["--topic", opts.topic] : []),
    ]);
    if (v1.status !== 200) return v1;
    return {
      status: 200,
      body: {
        ...normalizeV1Pending(opts.agent, v1.body),
        note: "v1 JSONL pending — ack/done 用 /api/events/v1/*",
      },
    };
  }

  return { status: 400, body: { error: "no_mode" } };
}

export function loadRegistryAgents(repoRoot: string): unknown {
  const p = eventLogPaths(repoRoot);
  if (!fs.existsSync(p.registry)) return { agents: [] };
  return JSON.parse(fs.readFileSync(p.registry, "utf8"));
}

export type RegistryAgent = {
  agent_id: string;
  host?: string;
  access?: string;
  owner?: string;
  sla?: string;
  notes?: string;
  reserved?: string;
  pilot?: boolean;
  pull_interval_s?: number | null;
};

/**
 * Agent kanban board: registry agents × delivery status counts from v2 sqlite.
 * Also includes agents that appear only in DB (not in registry).
 */
export async function agentsBoard(repoRoot: string): Promise<{
  ok: boolean;
  product_focus: string;
  db_ok: boolean;
  db_path: string;
  agents: Array<{
    agent_id: string;
    in_registry: boolean;
    host?: string;
    access?: string;
    owner?: string;
    sla?: string;
    notes?: string;
    reserved?: boolean;
    counts: Record<string, number>;
    pending: number;
    claimed: number;
    acked: number;
    done: number;
    dead: number;
    other: number;
    total_active: number;
    oldest_pending_ts?: string | null;
    sample_pending: Array<Record<string, unknown>>;
  }>;
  totals: Record<string, number>;
  error?: string;
}> {
  const p = eventLogPaths(repoRoot);
  const reg = loadRegistryAgents(repoRoot) as {
    agents?: RegistryAgent[];
    retired?: string[];
  };
  const retired = new Set(reg.retired || []);
  const regMap = new Map<string, RegistryAgent>();
  for (const a of reg.agents || []) {
    if (a.agent_id) regMap.set(a.agent_id, a);
  }

  const emptyTotals = () =>
    ({
      pending: 0,
      claimed: 0,
      acked: 0,
      done: 0,
      dead: 0,
      cancelled: 0,
      other: 0,
    }) as Record<string, number>;

  if (!p.dbExists) {
    // registry-only empty board
    const agents = [...regMap.values()]
      .filter((a) => !retired.has(a.agent_id))
      .map((a) => ({
        agent_id: a.agent_id,
        in_registry: true,
        host: a.host,
        access: a.access,
        owner: a.owner,
        sla: a.sla,
        notes: a.notes || a.reserved,
        reserved: Boolean(a.reserved),
        counts: emptyTotals(),
        pending: 0,
        claimed: 0,
        acked: 0,
        done: 0,
        dead: 0,
        other: 0,
        total_active: 0,
        oldest_pending_ts: null,
        sample_pending: [] as Array<Record<string, unknown>>,
      }));
    return {
      ok: true,
      product_focus: "multi-agent-interaction",
      db_ok: false,
      db_path: p.db,
      agents,
      totals: emptyTotals(),
      error: "sqlite missing — board shows registry only",
    };
  }

  const script = `
import json, os, sqlite3
db = ${JSON.stringify(p.db)}
c = sqlite3.connect(db)
c.row_factory = sqlite3.Row

# counts per agent per status
rows = c.execute(
  "SELECT to_agent, status, COUNT(*) AS n FROM deliveries GROUP BY to_agent, status"
).fetchall()
by = {}
for r in rows:
  ag = r["to_agent"] or "?"
  st = r["status"] or "other"
  by.setdefault(ag, {})
  by[ag][st] = r["n"]

# oldest pending ts + samples
samples = {}
oldest = {}
for ag in by:
  o = c.execute(
    """SELECT e.ts FROM deliveries d
       LEFT JOIN events e ON e.source_file=d.source_file AND e.seq=d.seq
       WHERE d.to_agent=? AND d.status='pending'
       ORDER BY COALESCE(e.ts, d.updated_at) ASC LIMIT 1""",
    (ag,),
  ).fetchone()
  oldest[ag] = o["ts"] if o and o["ts"] else None
  sm = c.execute(
    """SELECT d.delivery_id, d.source_file, d.seq, d.status, d.attempt_count,
              d.lease_expires_at, e.ts, e.from_agent, e.type, e.topic, e.payload, e.correlation_id
       FROM deliveries d
       LEFT JOIN events e ON e.source_file=d.source_file AND e.seq=d.seq
       WHERE d.to_agent=? AND d.status IN ('pending','claimed','acked')
       ORDER BY CASE d.status WHEN 'claimed' THEN 0 WHEN 'acked' THEN 1 ELSE 2 END,
                COALESCE(e.ts, d.updated_at) ASC
       LIMIT 8""",
    (ag,),
  ).fetchall()
  samples[ag] = []
  for s in sm:
    payload = None
    try:
      payload = json.loads(s["payload"]) if s["payload"] else None
    except Exception:
      payload = s["payload"]
    samples[ag].append({
      "delivery_id": s["delivery_id"],
      "source_file": s["source_file"],
      "seq": s["seq"],
      "status": s["status"],
      "attempt_count": s["attempt_count"],
      "lease_expires_at": s["lease_expires_at"],
      "ts": s["ts"],
      "from": s["from_agent"],
      "type": s["type"],
      "topic": s["topic"],
      "correlation_id": s["correlation_id"],
      "payload": payload,
    })

print(json.dumps({"by": by, "oldest": oldest, "samples": samples}))
`;

  const r = await runPython("-c", [script], {
    ...process.env,
    A2A_LOG_HOME: process.env.A2A_LOG_HOME || p.home,
    A2A_V2_DB: process.env.A2A_V2_DB || p.db,
  });
  if (!r.ok) {
    return {
      ok: false,
      product_focus: "multi-agent-interaction",
      db_ok: true,
      db_path: p.db,
      agents: [],
      totals: emptyTotals(),
      error: (r.stderr || r.stdout).slice(0, 2000),
    };
  }

  let parsed: {
    by: Record<string, Record<string, number>>;
    oldest: Record<string, string | null>;
    samples: Record<string, Array<Record<string, unknown>>>;
  };
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    return {
      ok: false,
      product_focus: "multi-agent-interaction",
      db_ok: true,
      db_path: p.db,
      agents: [],
      totals: emptyTotals(),
      error: "failed to parse board query",
    };
  }

  const agentIds = new Set<string>([
    ...regMap.keys(),
    ...Object.keys(parsed.by || {}),
  ]);
  for (const id of retired) agentIds.delete(id);

  const totals = emptyTotals();
  const agents = [...agentIds].map((agent_id) => {
    const countsRaw = parsed.by[agent_id] || {};
    const counts = emptyTotals();
    let other = 0;
    for (const [st, n] of Object.entries(countsRaw)) {
      if (st in counts) counts[st] = n;
      else {
        other += n;
        counts.other += n;
      }
    }
    const pending = counts.pending || 0;
    const claimed = counts.claimed || 0;
    const acked = counts.acked || 0;
    const done = counts.done || 0;
    const dead = counts.dead || 0;
    const total_active = pending + claimed + acked;
    for (const k of Object.keys(totals)) {
      totals[k] = (totals[k] || 0) + (counts[k] || 0);
    }
    const meta = regMap.get(agent_id);
    return {
      agent_id,
      in_registry: Boolean(meta),
      host: meta?.host,
      access: meta?.access,
      owner: meta?.owner,
      sla: meta?.sla,
      notes: meta?.notes || meta?.reserved,
      reserved: Boolean(meta?.reserved),
      counts,
      pending,
      claimed,
      acked,
      done,
      dead,
      other,
      total_active,
      oldest_pending_ts: parsed.oldest?.[agent_id] ?? null,
      sample_pending: parsed.samples?.[agent_id] || [],
    };
  });

  // sort: most active first, then registry order-ish by pending
  agents.sort((a, b) => {
    if (b.total_active !== a.total_active) return b.total_active - a.total_active;
    if (b.pending !== a.pending) return b.pending - a.pending;
    return a.agent_id.localeCompare(b.agent_id);
  });

  return {
    ok: true,
    product_focus: "multi-agent-interaction",
    db_ok: true,
    db_path: p.db,
    agents,
    totals,
  };
}

export function loadTopics(repoRoot: string): unknown {
  const p = eventLogPaths(repoRoot);
  if (!fs.existsSync(p.topics)) return { topics: {} };
  return JSON.parse(fs.readFileSync(p.topics, "utf8"));
}

export async function eventLogStatus(repoRoot: string): Promise<unknown> {
  const p = eventLogPaths(repoRoot);
  let jsonlFiles: string[] = [];
  if (p.eventsDirExists) {
    try {
      jsonlFiles = fs
        .readdirSync(p.eventsDir)
        .filter((f) => f.endsWith(".jsonl"));
    } catch {
      jsonlFiles = [];
    }
  }

  let sqlite: Record<string, unknown> = { ok: false };
  if (p.dbExists) {
    try {
      // lightweight stats via python one-liner to avoid native sqlite dep
      const script = `
import json, os, sqlite3
db = ${JSON.stringify(p.db)}
c = sqlite3.connect(db)
def q(sql):
  try: return c.execute(sql).fetchall()
  except Exception as e: return [("err", str(e))]
out = {
  "ok": True,
  "path": db,
  "size_bytes": os.path.getsize(db),
  "events": q("select count(*) from events")[0][0],
  "deliveries": q("select count(*) from deliveries")[0][0],
  "by_status": {r[0]: r[1] for r in q("select status, count(*) from deliveries group by status")},
  "by_agent": [{"agent": r[0], "status": r[1], "n": r[2]} for r in q("select to_agent, status, count(*) from deliveries group by to_agent, status")],
  "dead_letters": q("select count(*) from dead_letters")[0][0],
}
print(json.dumps(out))
`;
      const r = await runPython("-c", [script]);
      if (r.ok) sqlite = parseJsonOut(r.stdout, r.stderr) as Record<string, unknown>;
      else sqlite = { ok: false, error: r.stderr || r.stdout };
    } catch (e) {
      sqlite = { ok: false, error: String(e) };
    }
  }

  return {
    paths: {
      A2A_LOG_HOME: p.home,
      A2A_LOG_CLI: process.env.A2A_LOG_CLI || p.v1,
      A2A_V2_DB: p.db,
      events_dir: p.eventsDir,
      v1_script: p.v1,
      v2_script: p.v2,
    },
    exists: {
      home: p.homeExists,
      events_dir: p.eventsDirExists,
      db: p.dbExists,
      v1_script: p.v1Exists,
      v2_script: p.v2Exists,
    },
    jsonl_files: jsonlFiles,
    jsonl_count: jsonlFiles.length,
    sqlite,
    write_path_note:
      "Canonical writes go through a2a-log.py → events/<from>.jsonl (+ optional v2 dual-write). Claims only exist in sqlite deliveries.",
  };
}

// silence unused import lint if any
void pathToFileURL;
