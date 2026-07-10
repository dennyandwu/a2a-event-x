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
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionHub } from "@a2a-event-x/session-hub";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pkgRoot, "../..");
const publicDir = path.join(pkgRoot, "public");

const HOST = process.env.A2AX_HOST || "127.0.0.1";
const PORT = Number(process.env.A2AX_PORT || 8787);

const hub = new SessionHub();
const app = new Hono();

app.use("/api/*", cors({ origin: "*" }));

app.get("/api/health", async (c) => {
  const h = await hub.health();
  return c.json({
    product: "a2a-event-x",
    surface: "bs",
    version: "0.1.0",
    ...h,
    eventLog: {
      a2aLog: fs.existsSync(
        path.join(repoRoot, "packages/event-log/scripts/a2a-log.py"),
      ),
      a2aV2: fs.existsSync(
        path.join(repoRoot, "packages/event-log/a2a-v2.py"),
      ),
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

app.get("/api/events/inbox", async (c) => {
  const agent = c.req.query("agent") || "issac";
  const limit = c.req.query("limit") || "20";
  const claim = c.req.query("claim") === "1";
  // Prefer v2 inbox when available
  const script = path.join(repoRoot, "packages/event-log/a2a-v2.py");
  if (!fs.existsSync(script)) {
    return c.json({
      error: "event_log_missing",
      hint: "packages/event-log/a2a-v2.py not found",
    }, 503);
  }
  const args = ["inbox", "--agent", agent, "--limit", limit];
  if (claim) args.push("--claim");
  try {
    const out = await runPython(script, args);
    try {
      return c.json(JSON.parse(out));
    } catch {
      return c.json({ raw: out });
    }
  } catch (err) {
    return c.json(
      {
        error: "event_log_failed",
        detail: String(err),
      },
      500,
    );
  }
});

app.get("/api/meta", (c) =>
  c.json({
    product: "A2A Event X",
    primarySurface: "browser",
    mcp: "deferred",
    providers: hub.providers(),
    docs: {
      toolkit: "https://github.com/dennyandwu/a2a-toolkit",
      eventX: "https://github.com/dennyandwu/a2a-event-x",
    },
  }),
);

// Static UI (root relative to package so cwd-independent)
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

function runPython(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script, ...args], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `exit ${code}`));
    });
  });
}

console.log(`A2A Event X web → http://${HOST}:${PORT}`);
console.log(`  UI:     http://${HOST}:${PORT}/`);
console.log(`  health: http://${HOST}:${PORT}/api/health`);
console.log(`  (local-first; MCP deferred; CLI is secondary)`);

serve({ fetch: app.fetch, hostname: HOST, port: PORT });
