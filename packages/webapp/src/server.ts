#!/usr/bin/env node
/**
 * A2A Event X — B/S primary surface
 * Local-first HTTP API + static web UI
 *
 *   A2AX_HOST=127.0.0.1 A2AX_PORT=8787 npm run start -w @a2a-event-x/webapp
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionHub } from "@a2a-event-x/session-hub";
import { eventLogPaths, runEventV2 } from "./event-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pkgRoot, "../..");
const publicDir = path.join(pkgRoot, "public");

const HOST = process.env.A2AX_HOST || "127.0.0.1";
const PORT = Number(process.env.A2AX_PORT || 8787);

// Prefer monorepo a2a-log.py unless user overrides
const paths = eventLogPaths(repoRoot);
if (paths.v1Exists && !process.env.A2A_LOG_CLI) {
  process.env.A2A_LOG_CLI = paths.v1;
}

const hub = new SessionHub();
const app = new Hono();

app.use("/api/*", cors({ origin: "*" }));

app.get("/api/health", async (c) => {
  const h = await hub.health();
  const home = process.env.A2A_LOG_HOME || "~/.openclaw/workspace/state/a2a-log";
  return c.json({
    product: "a2a-event-x",
    surface: "bs",
    version: "0.2.0",
    ...h,
    eventLog: {
      a2aLog: paths.v1Exists,
      a2aV2: paths.v2Exists,
      a2aLogCli: process.env.A2A_LOG_CLI || paths.v1,
      a2aLogHome: home,
      a2aV2Db: process.env.A2A_V2_DB || `${home}/db/a2a-v2.sqlite`,
    },
  });
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

/** Event Log — inbox (optional auto-claim) */
app.get("/api/events/inbox", async (c) => {
  const agent = c.req.query("agent") || "issac";
  const limit = c.req.query("limit") || "20";
  const claim = c.req.query("claim") === "1";
  const leaseS = c.req.query("lease_s") || "3600";
  const args = ["inbox", "--agent", agent, "--limit", limit, "--lease-s", leaseS];
  if (claim) args.push("--claim");
  const { status, body } = await runEventV2(repoRoot, args);
  return c.json(body, status as 200);
});

/** Claim pending deliveries for agent */
app.post("/api/events/claim", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const agent = String(body.agent || "issac");
  const limit = String(body.limit ?? 10);
  const leaseS = String(body.lease_s ?? 3600);
  const { status, body: out } = await runEventV2(repoRoot, [
    "inbox",
    "--agent",
    agent,
    "--limit",
    limit,
    "--lease-s",
    leaseS,
    "--claim",
  ]);
  return c.json(out, status as 200);
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
  return c.json(out, status as 200);
});

app.post("/api/events/done", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token) return c.json({ error: "token_required" }, 400);
  const args = ["done", "--token", token];
  if (body.summary) args.push("--summary", String(body.summary));
  const { status, body: out } = await runEventV2(repoRoot, args);
  return c.json(out, status as 200);
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
  return c.json(out, status as 200);
});

app.post("/api/events/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!token) return c.json({ error: "token_required" }, 400);
  const args = ["cancel", "--token", token];
  if (body.reason) args.push("--reason", String(body.reason));
  const { status, body: out } = await runEventV2(repoRoot, args);
  return c.json(out, status as 200);
});

app.get("/api/meta", (c) =>
  c.json({
    product: "A2A Event X",
    primarySurface: "browser",
    version: "0.2.0",
    mcp: "deferred",
    providers: hub.providers(),
    docs: {
      toolkit: "https://github.com/dennyandwu/a2a-toolkit",
      eventX: "https://github.com/dennyandwu/a2a-event-x",
    },
  }),
);

// Static UI
app.use(
  "/*",
  serveStatic({
    root: publicDir,
  }),
);
app.get("*", async (c) => {
  const index = path.join(publicDir, "index.html");
  if (fs.existsSync(index)) return c.html(fs.readFileSync(index, "utf8"));
  return c.text("UI missing: packages/webapp/public/index.html", 500);
});

console.log(`A2A Event X web → http://${HOST}:${PORT}`);
console.log(`  UI:     http://${HOST}:${PORT}/`);
console.log(`  health: http://${HOST}:${PORT}/api/health`);
console.log(`  event:  claim/ack/done/renew/cancel under /api/events/*`);
console.log(`  (local-first; MCP deferred; CLI is secondary)`);

serve({ fetch: app.fetch, hostname: HOST, port: PORT });
