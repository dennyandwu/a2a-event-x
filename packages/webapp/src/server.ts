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
  eventLogPaths,
  eventLogStatus,
  inboxAuto,
  listAgentDeliveries,
  loadRegistryAgents,
  loadTopics,
  runEventV1,
  runEventV2,
} from "./event-log.js";

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

app.use("/api/*", cors({ origin: "*" }));

function jsonStatus(c: { json: (b: unknown, s?: number) => Response }, status: number, body: unknown) {
  return c.json(body, status as 200);
}

app.get("/api/health", async (c) => {
  const h = await hub.health();
  const status = await eventLogStatus(repoRoot);
  return c.json({
    product: "a2a-event-x",
    product_focus: "multi-agent-interaction",
    surface: "bs",
    version: "0.5.0",
    ...h,
    eventLog: status,
  });
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
  return jsonStatus(c, status, out);
});

app.post("/api/events/ack", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token) return c.json({ error: "token_required" }, 400);
  const { status, body: out } = await runEventV2(repoRoot, [
    "ack",
    "--token",
    token,
  ]);
  return jsonStatus(c, status, out);
});

app.post("/api/events/done", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token) return c.json({ error: "token_required" }, 400);
  const args = ["done", "--token", token];
  if (body.summary) args.push("--summary", String(body.summary));
  const { status, body: out } = await runEventV2(repoRoot, args);
  return jsonStatus(c, status, out);
});

app.post("/api/events/renew", async (c) => {
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
  return jsonStatus(c, status, out);
});

app.post("/api/events/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token) return c.json({ error: "token_required" }, 400);
  const args = ["cancel", "--token", token];
  if (body.reason) args.push("--reason", String(body.reason));
  const { status, body: out } = await runEventV2(repoRoot, args);
  return jsonStatus(c, status, out);
});

/** v1 JSONL ops (no claim token) */
app.post("/api/events/v1/ack", async (c) => {
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
  return jsonStatus(c, status, out);
});

app.post("/api/events/v1/done", async (c) => {
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
  return jsonStatus(c, status, out);
});

app.get("/api/meta", (c) =>
  c.json({
    product: "A2A Event X",
    product_focus: "multi-agent-interaction",
    tagline: "多 Agent 交互管理指挥台",
    primarySurface: "browser",
    defaultView: "agents",
    secondaryModules: ["inbox", "sessions", "write-path"],
    version: "0.5.0",
    mcp: "deferred",
    providers: hub.providers(),
    docs: {
      toolkit: "https://github.com/dennyandwu/a2a-toolkit",
      eventX: "https://github.com/dennyandwu/a2a-event-x",
      reorient: "docs/PRODUCT-REORIENT.md",
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
