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

/** Seed multi-agent demo rows into sqlite for empty-console trials. */
export async function seedDemoData(
  repoRoot: string,
  opts: { reset?: boolean; wipeOnly?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const script = path.join(repoRoot, "packages/event-log/scripts/seed-demo.py");
  if (!fs.existsSync(script)) {
    return {
      status: 503,
      body: { error: "seed_script_missing", path: script },
    };
  }
  const p = eventLogPaths(repoRoot);
  const args: string[] = [];
  if (opts.wipeOnly) args.push("--wipe-only");
  else if (opts.reset) args.push("--reset");
  const r = await runPython(script, args, {
    ...process.env,
    A2A_LOG_HOME: process.env.A2A_LOG_HOME || p.home,
    A2A_V2_DB: process.env.A2A_V2_DB || p.db,
  });
  const body = parseJsonOut(r.stdout, r.stderr);
  return { status: r.ok ? 200 : 400, body };
}

export function eventLogPaths(repoRoot: string) {
  const v2 = path.join(repoRoot, "packages/event-log/a2a-v2.py");
  const v1 = path.join(repoRoot, "packages/event-log/scripts/a2a-log.py");
  const store = path.join(repoRoot, "packages/event-log/a2a_v2_store.py");
  const home = expandHome(
    process.env.A2A_LOG_HOME || "~/.openclaw/workspace/state/a2a-log",
  );
  const db = expandHome(
    process.env.A2A_V2_DB || path.join(home, "db", "a2a-v2.sqlite"),
  );
  // Prefer live home registry/topics; fall back to monorepo copies
  const homeRegistry = path.join(home, "registry-agents.json");
  const homeTopics = path.join(home, "topics.json");
  const registry = fs.existsSync(homeRegistry)
    ? homeRegistry
    : path.join(repoRoot, "packages/event-log/registry-agents.json");
  const topics = fs.existsSync(homeTopics)
    ? homeTopics
    : path.join(repoRoot, "packages/event-log/topics.json");
  const eventsDir = path.join(home, "events");
  let jsonlCount = 0;
  if (fs.existsSync(eventsDir)) {
    try {
      jsonlCount = fs
        .readdirSync(eventsDir)
        .filter((f) => f.endsWith(".jsonl")).length;
    } catch {
      jsonlCount = 0;
    }
  }
  return {
    v1,
    v2,
    store,
    registry,
    topics,
    home,
    db,
    eventsDir,
    auditDir: path.join(home, "audit"),
    backfill: path.join(repoRoot, "packages/event-log/a2a-v2-backfill.py"),
    verify: path.join(repoRoot, "packages/event-log/a2a-v2-verify.py"),
    v1Exists: fs.existsSync(v1),
    v2Exists: fs.existsSync(v2),
    homeExists: fs.existsSync(home),
    dbExists: fs.existsSync(db),
    eventsDirExists: fs.existsSync(eventsDir),
    jsonlCount,
    dataMode: jsonlCount > 0 || (fs.existsSync(db) && fileSize(db) > 500_000)
      ? ("live" as const)
      : ("empty_or_demo" as const),
    syncStatePath: path.join(home, ".a2ax-sync-state.json"),
  };
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function fileMtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

export type SyncState = {
  last_sync_at?: string;
  remote?: string;
  ok?: boolean;
  db_size?: number;
  db_mtime_ms?: number | null;
  jsonl_count?: number;
};

export function readSyncState(repoRoot: string): SyncState | null {
  const p = eventLogPaths(repoRoot);
  try {
    if (!fs.existsSync(p.syncStatePath)) return null;
    return JSON.parse(fs.readFileSync(p.syncStatePath, "utf8")) as SyncState;
  } catch {
    return null;
  }
}

export function writeSyncState(repoRoot: string, state: SyncState): void {
  const p = eventLogPaths(repoRoot);
  try {
    fs.mkdirSync(p.home, { recursive: true });
    fs.writeFileSync(p.syncStatePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

/** Freshness of local Event Log mirror (sync record + file mtimes). */
export function dataFreshness(repoRoot: string): Record<string, unknown> {
  const p = eventLogPaths(repoRoot);
  const sync = readSyncState(repoRoot);
  const dbMtime = p.dbExists ? fileMtimeMs(p.db) : null;
  const dbAgeH =
    dbMtime != null ? (Date.now() - dbMtime) / 3_600_000 : null;
  let newestJsonl: number | null = null;
  if (p.eventsDirExists) {
    try {
      for (const f of fs.readdirSync(p.eventsDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const m = fileMtimeMs(path.join(p.eventsDir, f));
        if (m != null && (newestJsonl == null || m > newestJsonl)) newestJsonl = m;
      }
    } catch {
      /* ignore */
    }
  }
  const jsonlAgeH =
    newestJsonl != null ? (Date.now() - newestJsonl) / 3_600_000 : null;
  const syncAgeH = sync?.last_sync_at
    ? (Date.now() - Date.parse(sync.last_sync_at)) / 3_600_000
    : null;
  const staleThresholdH = Number(process.env.A2AX_STALE_HOURS || 24);
  const stale =
    p.dataMode === "live" &&
    ((syncAgeH != null && syncAgeH > staleThresholdH) ||
      (syncAgeH == null && dbAgeH != null && dbAgeH > staleThresholdH));
  return {
    dataMode: p.dataMode,
    last_sync_at: sync?.last_sync_at ?? null,
    last_sync_ok: sync?.ok ?? null,
    last_sync_remote: sync?.remote ?? null,
    sync_age_hours: syncAgeH != null ? Math.round(syncAgeH * 10) / 10 : null,
    db_mtime: dbMtime != null ? new Date(dbMtime).toISOString() : null,
    db_age_hours: dbAgeH != null ? Math.round(dbAgeH * 10) / 10 : null,
    db_size_bytes: p.dbExists ? fileSize(p.db) : null,
    jsonl_newest_mtime:
      newestJsonl != null ? new Date(newestJsonl).toISOString() : null,
    jsonl_age_hours: jsonlAgeH != null ? Math.round(jsonlAgeH * 10) / 10 : null,
    stale_threshold_hours: staleThresholdH,
    stale: Boolean(stale),
  };
}

/**
 * Live Event Log without A2AX_AUTHORITY → default readonly (laptop mirror safe).
 * A2AX_READONLY=0|false forces write; A2AX_AUTHORITY=1 enables write on live data.
 */
export function resolveReadonlyMode(repoRoot: string): {
  readonly: boolean;
  reason: string;
  authority: boolean;
  dataMode: string;
} {
  const p = eventLogPaths(repoRoot);
  const flag = (name: string) => {
    const v = (process.env[name] || "").trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  };
  const rawRo = (process.env.A2AX_READONLY || "").trim().toLowerCase();
  const explicitRo =
    rawRo !== "" &&
    (rawRo === "0" ||
      rawRo === "false" ||
      rawRo === "no" ||
      rawRo === "off" ||
      flag("A2AX_READONLY"));
  const forceWrite =
    rawRo === "0" || rawRo === "false" || rawRo === "no" || rawRo === "off";
  const authority = flag("A2AX_AUTHORITY");

  if (forceWrite) {
    return {
      readonly: false,
      reason: "A2AX_READONLY=0",
      authority: true,
      dataMode: p.dataMode,
    };
  }
  if (flag("A2AX_READONLY")) {
    return {
      readonly: true,
      reason: "A2AX_READONLY",
      authority: false,
      dataMode: p.dataMode,
    };
  }
  if (authority) {
    return {
      readonly: false,
      reason: "A2AX_AUTHORITY",
      authority: true,
      dataMode: p.dataMode,
    };
  }
  if (p.dataMode === "live") {
    return {
      readonly: true,
      reason: "auto:live-data-without-A2AX_AUTHORITY",
      authority: false,
      dataMode: p.dataMode,
    };
  }
  void explicitRo;
  return {
    readonly: false,
    reason: "default-empty-or-demo",
    authority: true,
    dataMode: p.dataMode,
  };
}

/** rsync Event Log from remote host (default macmini-ts production path). */
export async function syncEventLogFromRemote(
  repoRoot: string,
): Promise<{ status: number; body: unknown }> {
  const p = eventLogPaths(repoRoot);
  const remote =
    process.env.A2AX_SYNC_REMOTE ||
    "macmini-ts:~/.openclaw/workspace/state/a2a-log/";
  const dest = p.home.endsWith("/") ? p.home : `${p.home}/`;
  fs.mkdirSync(p.home, { recursive: true });
  const args = [
    "-az",
    "--exclude",
    "*.jsonl.lock",
    "--exclude",
    "deploy.lock",
    "--exclude",
    "mailbox-shadow",
    "--exclude",
    "bridge-security.sqlite",
    remote,
    dest,
  ];
  const r = await runCmd("rsync", args, process.env, 600_000);
  const after = eventLogPaths(repoRoot);
  const now = new Date().toISOString();
  if (r.ok) {
    writeSyncState(repoRoot, {
      last_sync_at: now,
      remote,
      ok: true,
      db_size: fileSize(after.db),
      db_mtime_ms: fileMtimeMs(after.db),
      jsonl_count: after.jsonlCount,
    });
  } else {
    writeSyncState(repoRoot, {
      last_sync_at: now,
      remote,
      ok: false,
      db_size: fileSize(after.db),
      db_mtime_ms: fileMtimeMs(after.db),
      jsonl_count: after.jsonlCount,
    });
  }
  return {
    status: r.ok ? 200 : 500,
    body: {
      ok: r.ok,
      remote,
      dest: p.home,
      code: r.code,
      stderr: (r.stderr || "").slice(-2000),
      stdout: (r.stdout || "").slice(-500),
      freshness: dataFreshness(repoRoot),
      after: {
        jsonlCount: after.jsonlCount,
        dbExists: after.dbExists,
        dataMode: after.dataMode,
        db_size: fileSize(after.db),
      },
    },
  };
}

/** Run a2a-v2-backfill.py to ingest JSONL → sqlite deliveries. */
export async function backfillV2FromJsonl(
  repoRoot: string,
): Promise<{ status: number; body: unknown }> {
  const p = eventLogPaths(repoRoot);
  if (!fs.existsSync(p.backfill)) {
    return { status: 503, body: { error: "backfill_script_missing", path: p.backfill } };
  }
  if (!p.eventsDirExists) {
    return { status: 400, body: { error: "events_dir_missing", path: p.eventsDir } };
  }
  const r = await runPython(p.backfill, [], {
    ...process.env,
    A2A_LOG_HOME: process.env.A2A_LOG_HOME || p.home,
    A2A_V2_DB: process.env.A2A_V2_DB || p.db,
  }, 600_000);
  return {
    status: r.ok ? 200 : 500,
    body: {
      ok: r.ok,
      code: r.code,
      stdout: (r.stdout || "").slice(-3000),
      stderr: (r.stderr || "").slice(-2000),
      home: p.home,
      db: p.db,
    },
  };
}

function runCmd(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...env } });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
            resolve({
              ok: false,
              code: 124,
              stdout,
              stderr: (stderr || "") + `\n[timeout after ${timeoutMs}ms]`,
            });
          }, timeoutMs)
        : null;
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        code: 1,
        stdout,
        stderr: String(err.message || err),
      });
    });
  });
}

export function runPython(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = Number(process.env.A2AX_PYTHON_TIMEOUT_MS || 120_000),
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [script, ...args], {
      env: { ...env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
            resolve({
              ok: false,
              code: 124,
              stdout,
              stderr: (stderr || "") + `\n[timeout after ${timeoutMs}ms]`,
            });
          }, timeoutMs)
        : null;
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0,
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        code: 1,
        stdout,
        stderr: String(err),
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
  try {
    return JSON.parse(fs.readFileSync(p.registry, "utf8"));
  } catch {
    return { agents: [], error: "registry_parse_failed", path: p.registry };
  }
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
    cancelled?: number;
    historical?: number;
    blocked?: number;
    escalated?: number;
    other: number;
    total_active: number;
    total_attention?: number;
    oldest_pending_ts?: string | null;
    sample_pending: Array<Record<string, unknown>>;
  }>;
  totals: Record<string, number>;
  freshness?: Record<string, unknown>;
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
      historical: 0,
      blocked: 0,
      escalated: 0,
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
        cancelled: 0,
        historical: 0,
        blocked: 0,
        escalated: 0,
        other: 0,
        total_active: 0,
        total_attention: 0,
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
      freshness: dataFreshness(repoRoot),
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
    const cancelled = counts.cancelled || 0;
    const historical = counts.historical || 0;
    const blocked = counts.blocked || 0;
    const escalated = counts.escalated || 0;
    const total_active = pending + claimed + acked;
    const total_attention = total_active + dead + blocked + escalated;
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
      cancelled,
      historical,
      blocked,
      escalated,
      other,
      total_active,
      total_attention,
      oldest_pending_ts: parsed.oldest?.[agent_id] ?? null,
      sample_pending: parsed.samples?.[agent_id] || [],
    };
  });

  // sort: most active first, then registry order-ish by pending
  agents.sort((a, b) => {
    if (b.total_attention !== a.total_attention) {
      return b.total_attention - a.total_attention;
    }
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
    freshness: dataFreshness(repoRoot),
  };
}

/** Run a2a-log.py compensate-dispatches for an agent (optional dry-run). */
export async function compensateAgent(
  repoRoot: string,
  opts: {
    agent?: string;
    topic?: string;
    dryRun?: boolean;
    limit?: number;
    staleMinutes?: number;
  },
): Promise<{ status: number; body: unknown }> {
  const args = ["compensate-dispatches", "--limit", String(opts.limit ?? 20)];
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.topic) args.push("--topic", opts.topic);
  if (opts.staleMinutes != null) {
    args.push("--stale-minutes", String(opts.staleMinutes));
  }
  // default dry-run unless explicitly dryRun: false
  if (opts.dryRun !== false) args.push("--dry-run");
  return runEventV1(repoRoot, args);
}

/** Batch v2 done by claim tokens. */
export async function batchDone(
  repoRoot: string,
  tokens: string[],
  summary?: string,
): Promise<{
  ok: boolean;
  results: Array<{ token: string; ok: boolean; body: unknown }>;
}> {
  const results: Array<{ token: string; ok: boolean; body: unknown }> = [];
  for (const token of tokens) {
    const args = ["done", "--token", token];
    if (summary) args.push("--summary", summary);
    const r = await runEventV2(repoRoot, args);
    results.push({
      token: token.slice(0, 8) + "…",
      ok: r.status === 200,
      body: r.body,
    });
  }
  return {
    ok: results.every((x) => x.ok),
    results,
  };
}

/** Requeue dead deliveries back to pending (local ops). */
export async function requeueDead(
  repoRoot: string,
  opts: { agent?: string; deliveryId?: number; limit?: number },
): Promise<{ ok: boolean; requeued: number; error?: string }> {
  const p = eventLogPaths(repoRoot);
  if (!p.dbExists) return { ok: false, requeued: 0, error: "sqlite missing" };
  const script = `
import json, sqlite3
from datetime import datetime, timezone
db = ${JSON.stringify(p.db)}
agent = ${JSON.stringify(opts.agent || null)}
did = ${JSON.stringify(opts.deliveryId ?? null)}
limit = ${opts.limit ?? 20}
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
c = sqlite3.connect(db)
n = 0
if did is not None:
  cur = c.execute(
    """UPDATE deliveries SET status='pending', claim_token=NULL, lease_expires_at=NULL,
        attempt_count=0, updated_at=? WHERE delivery_id=? AND status='dead'""",
    (now, did),
  )
  n = cur.rowcount
else:
  if agent:
    ids = [r[0] for r in c.execute(
      "SELECT delivery_id FROM deliveries WHERE to_agent=? AND status='dead' ORDER BY updated_at ASC LIMIT ?",
      (agent, limit),
    ).fetchall()]
  else:
    ids = [r[0] for r in c.execute(
      "SELECT delivery_id FROM deliveries WHERE status='dead' ORDER BY updated_at ASC LIMIT ?",
      (limit,),
    ).fetchall()]
  for i in ids:
    cur = c.execute(
      """UPDATE deliveries SET status='pending', claim_token=NULL, lease_expires_at=NULL,
          attempt_count=0, updated_at=? WHERE delivery_id=? AND status='dead'""",
      (now, i),
    )
    n += cur.rowcount
c.commit()
print(json.dumps({"requeued": n}))
`;
  const r = await runPython("-c", [script], {
    ...process.env,
    A2A_V2_DB: process.env.A2A_V2_DB || p.db,
  });
  if (!r.ok) return { ok: false, requeued: 0, error: r.stderr || r.stdout };
  try {
    const body = JSON.parse(r.stdout) as { requeued: number };
    return { ok: true, requeued: body.requeued };
  } catch {
    return { ok: false, requeued: 0, error: "parse failed" };
  }
}

/** Recent correlation workflows + detail timeline (includes historical done). */
export async function listCorrelations(
  repoRoot: string,
  limit = 80,
): Promise<{
  ok: boolean;
  correlations: Array<Record<string, unknown>>;
  summary?: Record<string, number>;
  error?: string;
}> {
  const p = eventLogPaths(repoRoot);
  if (!p.dbExists) {
    return { ok: false, correlations: [], error: "sqlite missing" };
  }
  const script = `
import json, sqlite3
db = ${JSON.stringify(p.db)}
limit = ${Math.min(Math.max(limit, 1), 200)}
c = sqlite3.connect(db)
c.row_factory = sqlite3.Row
rows = c.execute(
  """SELECT correlation_id,
            COUNT(*) AS event_count,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts,
            GROUP_CONCAT(DISTINCT type) AS types,
            GROUP_CONCAT(DISTINCT from_agent) AS from_agents,
            GROUP_CONCAT(DISTINCT topic) AS topics
     FROM events
     WHERE correlation_id IS NOT NULL AND correlation_id != ''
     GROUP BY correlation_id
     ORDER BY MAX(ts) DESC
     LIMIT ?""",
  (limit,),
).fetchall()
out = []
for r in rows:
  st = c.execute(
    """SELECT d.status, COUNT(*) AS n
       FROM deliveries d
       JOIN events e ON e.source_file=d.source_file AND e.seq=d.seq
       WHERE e.correlation_id=?
       GROUP BY d.status""",
    (r["correlation_id"],),
  ).fetchall()
  by_status = {x["status"]: x["n"] for x in st}
  pending = by_status.get("pending", 0)
  claimed = by_status.get("claimed", 0)
  acked = by_status.get("acked", 0)
  done = by_status.get("done", 0)
  dead = by_status.get("dead", 0)
  cancelled = by_status.get("cancelled", 0)
  active = pending + claimed + acked
  terminal = done + cancelled
  total_d = sum(by_status.values()) or 0
  # phase for history / triage
  if dead > 0:
    phase = "problem"
  elif active > 0 and terminal > 0:
    phase = "mixed"   # in-flight + some done history
  elif active > 0:
    phase = "active"
  elif terminal > 0 or total_d == 0:
    phase = "history"  # fully terminal (done/cancelled) — keep for postmortem
  else:
    phase = "other"
  to_agents = c.execute(
    """SELECT GROUP_CONCAT(DISTINCT d.to_agent)
       FROM deliveries d
       JOIN events e ON e.source_file=d.source_file AND e.seq=d.seq
       WHERE e.correlation_id=?""",
    (r["correlation_id"],),
  ).fetchone()[0]
  out.append({
    "correlation_id": r["correlation_id"],
    "event_count": r["event_count"],
    "first_ts": r["first_ts"],
    "last_ts": r["last_ts"],
    "types": r["types"],
    "topics": r["topics"],
    "from_agents": r["from_agents"],
    "to_agents": to_agents,
    "delivery_status": by_status,
    "counts": {
      "pending": pending, "claimed": claimed, "acked": acked,
      "done": done, "dead": dead, "cancelled": cancelled,
      "active": active, "terminal": terminal, "deliveries": total_d,
    },
    "phase": phase,
  })
# sort: problem → active/mixed → other → history; within group last_ts desc
from collections import defaultdict
rank = {"problem": 0, "active": 1, "mixed": 1, "other": 2, "history": 3}
buckets = defaultdict(list)
for x in out:
  buckets[rank.get(x["phase"], 9)].append(x)
ordered = []
for k in sorted(buckets.keys()):
  ordered.extend(sorted(buckets[k], key=lambda x: x.get("last_ts") or "", reverse=True))
summary = {
  "total": len(ordered),
  "active": sum(1 for x in ordered if x["phase"] in ("active", "mixed")),
  "problem": sum(1 for x in ordered if x["phase"] == "problem"),
  "history": sum(1 for x in ordered if x["phase"] == "history"),
}
print(json.dumps({"correlations": ordered, "summary": summary}))
`;
  const r = await runPython("-c", [script], {
    ...process.env,
    A2A_V2_DB: process.env.A2A_V2_DB || p.db,
  });
  if (!r.ok) {
    return { ok: false, correlations: [], error: r.stderr || r.stdout };
  }
  try {
    const body = JSON.parse(r.stdout) as {
      correlations: Array<Record<string, unknown>>;
      summary?: Record<string, number>;
    };
    return {
      ok: true,
      correlations: body.correlations,
      summary: body.summary,
    };
  } catch {
    return { ok: false, correlations: [], error: "parse failed" };
  }
}

export async function correlationTimeline(
  repoRoot: string,
  correlationId: string,
): Promise<{
  ok: boolean;
  correlation_id: string;
  events: Array<Record<string, unknown>>;
  error?: string;
}> {
  const p = eventLogPaths(repoRoot);
  if (!p.dbExists) {
    return {
      ok: false,
      correlation_id: correlationId,
      events: [],
      error: "sqlite missing",
    };
  }
  const script = `
import json, sqlite3
db = ${JSON.stringify(p.db)}
cid = ${JSON.stringify(correlationId)}
c = sqlite3.connect(db)
c.row_factory = sqlite3.Row
rows = c.execute(
  """SELECT e.event_id, e.source_file, e.seq, e.ts, e.from_agent, e.type, e.topic,
            e.correlation_id, e.causation_id, e.payload,
            d.delivery_id, d.to_agent, d.status AS delivery_status, d.attempt_count,
            d.lease_expires_at, d.claim_token
     FROM events e
     LEFT JOIN deliveries d ON d.source_file=e.source_file AND d.seq=e.seq
     WHERE e.correlation_id=?
     ORDER BY e.ts ASC, e.seq ASC, d.delivery_id ASC""",
  (cid,),
).fetchall()
out = []
for s in rows:
  payload = None
  try:
    payload = json.loads(s["payload"]) if s["payload"] else None
  except Exception:
    payload = s["payload"]
  out.append({
    "event_id": s["event_id"],
    "source_file": s["source_file"],
    "seq": s["seq"],
    "ts": s["ts"],
    "from": s["from_agent"],
    "type": s["type"],
    "topic": s["topic"],
    "correlation_id": s["correlation_id"],
    "causation_id": s["causation_id"],
    "payload": payload,
    "delivery_id": s["delivery_id"],
    "to_agent": s["to_agent"],
    "delivery_status": s["delivery_status"],
    "attempt_count": s["attempt_count"],
    "lease_expires_at": s["lease_expires_at"],
    "has_token": bool(s["claim_token"]),
  })
print(json.dumps({"events": out}))
`;
  const r = await runPython("-c", [script], {
    ...process.env,
    A2A_V2_DB: process.env.A2A_V2_DB || p.db,
  });
  if (!r.ok) {
    return {
      ok: false,
      correlation_id: correlationId,
      events: [],
      error: r.stderr || r.stdout,
    };
  }
  try {
    const body = JSON.parse(r.stdout) as { events: Array<Record<string, unknown>> };
    return { ok: true, correlation_id: correlationId, events: body.events };
  } catch {
    return {
      ok: false,
      correlation_id: correlationId,
      events: [],
      error: "parse failed",
    };
  }
}

/**
 * List deliveries for one agent filtered by status (v2 sqlite).
 */
export async function listAgentDeliveries(
  repoRoot: string,
  agentId: string,
  opts: { status?: string[]; limit?: number } = {},
): Promise<{
  ok: boolean;
  agent: string;
  count: number;
  deliveries: Array<Record<string, unknown>>;
  error?: string;
}> {
  const p = eventLogPaths(repoRoot);
  if (!p.dbExists) {
    return {
      ok: false,
      agent: agentId,
      count: 0,
      deliveries: [],
      error: "sqlite missing",
    };
  }
  const statuses = opts.status?.length
    ? opts.status
    : ["pending", "claimed", "acked", "dead"];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const script = `
import json, sqlite3
db = ${JSON.stringify(p.db)}
agent = ${JSON.stringify(agentId)}
statuses = ${JSON.stringify(statuses)}
limit = ${limit}
c = sqlite3.connect(db)
c.row_factory = sqlite3.Row
ph = ",".join("?" * len(statuses))
sql = f"""
SELECT d.delivery_id, d.source_file, d.seq, d.status, d.attempt_count,
       d.claim_token, d.lease_expires_at, d.updated_at,
       e.ts, e.from_agent, e.type, e.topic, e.payload, e.correlation_id, e.causation_id
FROM deliveries d
LEFT JOIN events e ON e.source_file=d.source_file AND e.seq=d.seq
WHERE d.to_agent=? AND d.status IN ({ph})
ORDER BY CASE d.status
  WHEN 'claimed' THEN 0 WHEN 'acked' THEN 1 WHEN 'pending' THEN 2 WHEN 'dead' THEN 3 ELSE 4 END,
  COALESCE(e.ts, d.updated_at) ASC
LIMIT ?
"""
rows = c.execute(sql, [agent, *statuses, limit]).fetchall()
out = []
for s in rows:
  payload = None
  try:
    payload = json.loads(s["payload"]) if s["payload"] else None
  except Exception:
    payload = s["payload"]
  out.append({
    "delivery_id": s["delivery_id"],
    "source_file": s["source_file"],
    "seq": s["seq"],
    "status": s["status"],
    "attempt_count": s["attempt_count"],
    "claim_token": s["claim_token"],
    "lease_expires_at": s["lease_expires_at"],
    "updated_at": s["updated_at"],
    "ts": s["ts"],
    "from": s["from_agent"],
    "type": s["type"],
    "topic": s["topic"],
    "correlation_id": s["correlation_id"],
    "causation_id": s["causation_id"],
    "payload": payload,
    "mode": "v2",
  })
print(json.dumps({"deliveries": out, "count": len(out)}))
`;
  const r = await runPython("-c", [script], {
    ...process.env,
    A2A_LOG_HOME: process.env.A2A_LOG_HOME || p.home,
    A2A_V2_DB: process.env.A2A_V2_DB || p.db,
  });
  if (!r.ok) {
    return {
      ok: false,
      agent: agentId,
      count: 0,
      deliveries: [],
      error: (r.stderr || r.stdout).slice(0, 2000),
    };
  }
  try {
    const body = JSON.parse(r.stdout) as {
      deliveries: Array<Record<string, unknown>>;
      count: number;
    };
    return {
      ok: true,
      agent: agentId,
      count: body.count,
      deliveries: body.deliveries,
    };
  } catch {
    return {
      ok: false,
      agent: agentId,
      count: 0,
      deliveries: [],
      error: "parse failed",
    };
  }
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
  "by_agent_top": [{"agent": r[0], "status": r[1], "n": r[2]} for r in q(
    "select to_agent, status, count(*) as n from deliveries where status in ('pending','claimed','acked','dead','blocked','escalated') group by to_agent, status order by n desc limit 40"
  )],
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
      sync_state: p.syncStatePath,
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
    freshness: dataFreshness(repoRoot),
    write_path_note:
      "Canonical writes go through a2a-log.py → events/<from>.jsonl (+ optional v2 dual-write). Claims only exist in sqlite deliveries.",
  };
}

// silence unused import lint if any
void pathToFileURL;
