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
