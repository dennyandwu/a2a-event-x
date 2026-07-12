#!/usr/bin/env node
/**
 * A2A Event X — multi-agent interaction console (B/S)
 * Default surface: agent board (pending/claimed). Sessions are secondary context.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionHub } from "@a2a-event-x/session-hub";
import {
  agentsBoard,
  backfillV2FromJsonl,
  batchDone,
  compensateAgent,
  correlationTimeline,
  eventLogPaths,
  eventLogStatus,
  inboxAuto,
  listAgentDeliveries,
  listCorrelations,
  loadRegistryAgents,
  loadTopics,
  requeueDead,
  runEventV1,
  runEventV2,
  seedDemoData,
  syncEventLogFromRemote,
} from "./event-log.js";
import { readRecentOps, recordOp } from "./ops-audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pkgRoot, "../..");
const publicDir = path.join(pkgRoot, "public");

const HOST = process.env.A2AX_HOST || "127.0.0.1";
const PORT = Number(process.env.A2AX_PORT || 8787);

const paths = eventLogPaths(repoRoot);
if (paths.v1Exists && !process.env.A2A_LOG_CLI) {
  process.env.A2A_LOG_CLI = paths.v1;
}
if (!process.env.A2A_LOG_HOME) {
  process.env.A2A_LOG_HOME = paths.home;
}

const hub = new SessionHub();
const app = new Hono();
const VERSION = "1.1.0";
/** Optional shared secret: set A2AX_TOKEN to require Bearer / X-A2AX-Token on /api/* (health always open). */
const API_TOKEN = process.env.A2AX_TOKEN || "";

app.use("/api/*", cors({ origin: "*" }));

app.use("/api/*", async (c, next) => {
  if (!API_TOKEN) return next();
  const pathName = c.req.path;
  if (pathName === "/api/health" || pathName === "/api/meta") return next();
  const hdr =
    c.req.header("x-a2ax-token") ||
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  if (hdr !== API_TOKEN) {
    return c.json({ error: "unauthorized", hint: "set X-A2AX-Token or Authorization: Bearer" }, 401);
  }
  return next();
});

function jsonStatus(c: { json: (b: unknown, s?: number) => Response }, status: number, body: unknown) {
  return c.json(body, status as 200);
}

app.get("/api/health", async (c) => {
  const h = await hub.health();
  const status = await eventLogStatus(repoRoot);
  const p = eventLogPaths(repoRoot);
  return c.json({
    product: "a2a-event-x",
    product_focus: "multi-agent-interaction",
    surface: "bs",
    version: VERSION,
    landable: true,
    auth: API_TOKEN ? "token" : "open-localhost",
    dataMode: p.dataMode,
    ...h,
    eventLog: status,
    opsAudit: readRecentOps(5),
  });
});

/**
 * Load multi-agent demo data so the console is usable without production dual-write.
 * POST { reset?: true, wipe_only?: true }
 */
app.post("/api/demo/seed", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const { status, body: out } = await seedDemoData(repoRoot, {
    reset: Boolean(body.reset),
    wipeOnly: Boolean(body.wipe_only),
  });
  recordOp({
    op: "demo_seed",
    ok: status === 200,
    detail: out as Record<string, unknown>,
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

/**
 * Pull production Event Log via rsync (A2AX_SYNC_REMOTE, default macmini-ts:…/a2a-log/).
 * Requires network + SSH. Does not auto-mutate remote.
 */
app.post("/api/data/sync", async (c) => {
  const t0 = Date.now();
  const { status, body: out } = await syncEventLogFromRemote(repoRoot);
  recordOp({
    op: "data_sync",
    ok: status === 200,
    detail: out as Record<string, unknown>,
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

/**
 * Ingest events/*.jsonl into a2a-v2.sqlite (a2a-v2-backfill.py).
 * Use when JSONL exists but board is empty / sqlite stale.
 */
app.post("/api/data/backfill", async (c) => {
  const t0 = Date.now();
  const { status, body: out } = await backfillV2FromJsonl(repoRoot);
  recordOp({
    op: "data_backfill",
    ok: status === 200,
    detail: out as Record<string, unknown>,
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

/** Recent ops audit (mutations) */
app.get("/api/ops/audit", (c) => {
  const limit = Number(c.req.query("limit") || 100);
  return c.json(readRecentOps(limit));
});

/** Agent kanban: pending / claimed / acked per agent */
app.get("/api/agents/board", async (c) => {
  return c.json(await agentsBoard(repoRoot));
});

/** Deliveries for one agent (detail drawer) */
app.get("/api/agents/:id/deliveries", async (c) => {
  const agentId = decodeURIComponent(c.req.param("id"));
  const statusQ = c.req.query("status") || "pending,claimed,acked,dead";
  const statuses = statusQ
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = Number(c.req.query("limit") || 50);
  return c.json(
    await listAgentDeliveries(repoRoot, agentId, { status: statuses, limit }),
  );
});

/** Batch DONE for multiple claim tokens */
app.post("/api/events/batch-done", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const tokens = Array.isArray(body.tokens)
    ? body.tokens.map(String).filter(Boolean)
    : [];
  if (!tokens.length) return c.json({ error: "tokens_required" }, 400);
  if (tokens.length > 50) return c.json({ error: "max_50_tokens" }, 400);
  const summary =
    typeof body.summary === "string" ? body.summary : undefined;
  const out = await batchDone(repoRoot, tokens, summary);
  recordOp({
    op: "batch_done",
    ok: out.ok,
    agent: body.agent ? String(body.agent) : undefined,
    detail: { tokens, summary, results: out.results },
    duration_ms: Date.now() - t0,
  });
  return c.json(out);
});

/** Requeue dead → pending */
app.post("/api/events/requeue-dead", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const out = await requeueDead(repoRoot, {
    agent: body.agent ? String(body.agent) : undefined,
    deliveryId:
      body.delivery_id != null ? Number(body.delivery_id) : undefined,
    limit: body.limit != null ? Number(body.limit) : 20,
  });
  recordOp({
    op: "requeue_dead",
    ok: out.ok,
    agent: body.agent ? String(body.agent) : undefined,
    detail: {
      delivery_id: body.delivery_id,
      requeued: out.requeued,
    },
    error: out.error,
    duration_ms: Date.now() - t0,
  });
  return c.json(out);
});

/** compensate-dispatches (default dry-run; set dry_run:false + confirm:"EXECUTE" to run) */
app.post("/api/events/compensate", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false;
  if (!dryRun && body.confirm !== "EXECUTE") {
    return c.json(
      {
        error: "confirm_required",
        hint: 'Set dry_run:false and confirm:"EXECUTE" for real compensate',
      },
      400,
    );
  }
  const { status, body: out } = await compensateAgent(repoRoot, {
    agent: body.agent ? String(body.agent) : undefined,
    topic: body.topic ? String(body.topic) : undefined,
    dryRun,
    limit: body.limit != null ? Number(body.limit) : 20,
    staleMinutes:
      body.stale_minutes != null ? Number(body.stale_minutes) : undefined,
  });
  recordOp({
    op: "compensate",
    ok: status === 200,
    agent: body.agent ? String(body.agent) : undefined,
    detail: { dry_run: dryRun, result: out },
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

/** Correlation / workflow list (includes historical done/cancelled) */
app.get("/api/interactions", async (c) => {
  const limit = Number(c.req.query("limit") || 80);
  return c.json(await listCorrelations(repoRoot, limit));
});

/** Correlation timeline */
app.get("/api/interactions/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  return c.json(await correlationTimeline(repoRoot, id));
});

app.get("/api/sessions", async (c) => {
  const provider = c.req.query("provider") || undefined;
  const project = c.req.query("project") || undefined;
  const limit = Number(c.req.query("limit") || 100);
  const since = c.req.query("since") || undefined;
  const sessions = await hub.listSessions({
    provider: provider as never,
    project,
    limit,
    since,
  });
  return c.json({ count: sessions.length, sessions });
});

app.get("/api/sessions/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const session = await hub.getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  return c.json({ session });
});

app.get("/api/sessions/:id/messages", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const offset = Number(c.req.query("offset") || 0);
  const limit = Number(c.req.query("limit") || 80);
  const maxChars = Number(c.req.query("max_chars") || 6000);
  const result = await hub.getMessages(id, { offset, limit, maxChars });
  if (!result) return c.json({ error: "not_found" }, 404);
  return c.json({
    session: result.session,
    count: result.messages.length,
    messages: result.messages,
  });
});

app.get("/api/search", async (c) => {
  const q = c.req.query("q") || "";
  if (!q.trim()) return c.json({ error: "q_required" }, 400);
  const limit = Number(c.req.query("limit") || 30);
  const hits = await hub.search(q, limit);
  return c.json({ count: hits.length, hits });
});

app.get("/api/registry/agents", (c) => {
  return c.json(loadRegistryAgents(repoRoot));
});

app.get("/api/registry/topics", (c) => {
  return c.json(loadTopics(repoRoot));
});

app.get("/api/events/status", async (c) => {
  return c.json(await eventLogStatus(repoRoot));
});

/** Inbox with auto v2→v1 fallback */
app.get("/api/events/inbox", async (c) => {
  const agent = c.req.query("agent") || "issac";
  const limit = c.req.query("limit") || "20";
  const claim = c.req.query("claim") === "1";
  const mode = (c.req.query("mode") || "auto") as "auto" | "v2" | "v1";
  const leaseS = c.req.query("lease_s") || "3600";
  const topic = c.req.query("topic") || undefined;
  const { status, body } = await inboxAuto(repoRoot, {
    agent,
    limit,
    claim,
    mode,
    leaseS,
    topic,
  });
  return jsonStatus(c, status, body);
});

app.post("/api/events/claim", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const agent = String(body.agent || "issac");
  const limit = String(body.limit ?? 10);
  const leaseS = String(body.lease_s ?? 3600);
  const { status, body: out } = await inboxAuto(repoRoot, {
    agent,
    limit,
    claim: true,
    mode: "v2",
    leaseS,
  });
  const n =
    out && typeof out === "object" && Array.isArray((out as { events?: unknown[] }).events)
      ? (out as { events: unknown[] }).events.length
      : 0;
  recordOp({
    op: "claim",
    ok: status === 200,
    agent,
    detail: { limit, claimed: n },
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

app.post("/api/events/ack", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token) return c.json({ error: "token_required" }, 400);
  const { status, body: out } = await runEventV2(repoRoot, [
    "ack",
    "--token",
    token,
  ]);
  recordOp({
    op: "ack",
    ok: status === 200,
    detail: { token, result: out },
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

app.post("/api/events/done", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token) return c.json({ error: "token_required" }, 400);
  const args = ["done", "--token", token];
  if (body.summary) args.push("--summary", String(body.summary));
  const { status, body: out } = await runEventV2(repoRoot, args);
  recordOp({
    op: "done",
    ok: status === 200,
    detail: { token, summary: body.summary, result: out },
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

app.post("/api/events/renew", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token) return c.json({ error: "token_required" }, 400);
  const extend = String(body.extend_s ?? 3600);
  const { status, body: out } = await runEventV2(repoRoot, [
    "renew",
    "--token",
    token,
    "--extend-s",
    extend,
  ]);
  recordOp({
    op: "renew",
    ok: status === 200,
    detail: { token, extend_s: extend },
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

app.post("/api/events/cancel", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token) return c.json({ error: "token_required" }, 400);
  const args = ["cancel", "--token", token];
  if (body.reason) args.push("--reason", String(body.reason));
  const { status, body: out } = await runEventV2(repoRoot, args);
  recordOp({
    op: "cancel",
    ok: status === 200,
    detail: { token, reason: body.reason, result: out },
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

/** v1 JSONL ops (no claim token) */
app.post("/api/events/v1/ack", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const agent = String(body.agent || "");
  const seq = String(body.seq ?? "");
  const file = String(body.file || "");
  if (!agent || !seq || !file) {
    return c.json({ error: "agent_seq_file_required" }, 400);
  }
  const { status, body: out } = await runEventV1(repoRoot, [
    "ack",
    "--agent",
    agent,
    "--seq",
    seq,
    "--file",
    file,
  ]);
  recordOp({
    op: "v1_ack",
    ok: status === 200,
    agent,
    detail: { seq, file, result: out },
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

app.post("/api/events/v1/done", async (c) => {
  const t0 = Date.now();
  const body = await c.req.json().catch(() => ({}));
  const agent = String(body.agent || "");
  const seq = String(body.seq ?? "");
  const file = String(body.file || "");
  if (!agent || !seq || !file) {
    return c.json({ error: "agent_seq_file_required" }, 400);
  }
  const args = ["done", "--agent", agent, "--seq", seq, "--file", file];
  if (body.summary) args.push("--summary", String(body.summary));
  const { status, body: out } = await runEventV1(repoRoot, args);
  recordOp({
    op: "v1_done",
    ok: status === 200,
    agent,
    detail: { seq, file, summary: body.summary, result: out },
    duration_ms: Date.now() - t0,
  });
  return jsonStatus(c, status, out);
});

app.get("/api/meta", (c) =>
  c.json({
    product: "A2A Event X",
    product_focus: "multi-agent-interaction",
    tagline: "多 Agent 交互管理指挥台",
    primarySurface: "browser",
    defaultView: "agents",
    secondaryModules: ["inbox", "sessions", "write-path", "ops-audit"],
    version: VERSION,
    agentAccess: "cli+skill",
    landable: true,
    auth: API_TOKEN ? "token" : "open-localhost",
    data: {
      home: paths.home,
      dataMode: paths.dataMode,
      jsonlCount: paths.jsonlCount,
      syncRemote: process.env.A2AX_SYNC_REMOTE || "macmini-ts:~/.openclaw/workspace/state/a2a-log/",
    },
    providers: hub.providers(),
    docs: {
      toolkit: "https://github.com/dennyandwu/a2a-toolkit",
      eventX: "https://github.com/dennyandwu/a2a-event-x",
      reorient: "docs/PRODUCT-REORIENT.md",
      goLive: "docs/GO-LIVE.md",
    },
  }),
);

app.use("/*", serveStatic({ root: publicDir }));
app.get("*", async (c) => {
  const index = path.join(publicDir, "index.html");
  if (fs.existsSync(index)) return c.html(fs.readFileSync(index, "utf8"));
  return c.text("UI missing: packages/webapp/public/index.html", 500);
});

console.log(`A2A Event X — multi-agent interaction console → http://${HOST}:${PORT}`);
console.log(`  board:  http://${HOST}:${PORT}/api/agents/board`);
console.log(`  inbox:  /api/events/*  · sessions secondary`);

serve({ fetch: app.fetch, hostname: HOST, port: PORT });
