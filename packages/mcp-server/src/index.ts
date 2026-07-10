#!/usr/bin/env node
/**
 * A2A Event X — MCP server (stdio)
 * Tools: x_health, x_list_sessions, x_get_session, x_get_messages, x_search, x_query_events, x_project_session_event
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionHub, createProjector } from "@a2a-event-x/session-hub";

const hub = new SessionHub();
const projector = createProjector();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

const server = new McpServer({
  name: "a2a-event-x",
  version: "0.1.0",
});

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

server.tool("x_health", "Adapter health, roots, projector status", {}, async () => {
  const h = await hub.health();
  return json({
    ...h,
    projector: { enabled: projector.enabled },
    repoRoot,
  });
});

server.tool(
  "x_list_sessions",
  "List local sessions across Claude Code, Codex, OpenClaw, Grok Build, Antigravity",
  {
    provider: z.string().optional().describe("Filter by provider id"),
    project: z.string().optional().describe("Substring match on project path/title"),
    limit: z.number().int().positive().max(500).optional(),
    since: z.string().optional().describe("ISO timestamp lower bound on updatedAt"),
  },
  async (args) => {
    const sessions = await hub.listSessions({
      provider: args.provider as never,
      project: args.project,
      limit: args.limit ?? 100,
      since: args.since,
    });
    return json({ count: sessions.length, sessions });
  },
);

server.tool(
  "x_get_session",
  "Get one session by id (provider:nativeId or nativeId)",
  {
    session_id: z.string(),
  },
  async (args) => {
    const session = await hub.getSession(args.session_id);
    if (!session) {
      return json({ error: "not_found", session_id: args.session_id });
    }
    return json({ session });
  },
);

server.tool(
  "x_get_messages",
  "Paginated messages for a session",
  {
    session_id: z.string(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(200).optional(),
    max_chars: z.number().int().positive().max(50_000).optional(),
  },
  async (args) => {
    const result = await hub.getMessages(args.session_id, {
      offset: args.offset,
      limit: args.limit,
      maxChars: args.max_chars,
    });
    if (!result) return json({ error: "not_found", session_id: args.session_id });
    return json({
      session: result.session,
      count: result.messages.length,
      messages: result.messages,
    });
  },
);

server.tool(
  "x_search",
  "Search transcript text across providers",
  {
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).optional(),
  },
  async (args) => {
    const hits = await hub.search(args.query, args.limit ?? 20);
    return json({ count: hits.length, hits });
  },
);

server.tool(
  "x_query_events",
  "Proxy read of Event Log v2 inbox (packages/event-log). Requires Python.",
  {
    agent: z.string().describe("Recipient agent id, e.g. issac"),
    claim: z.boolean().optional().describe("If true, claim with lease tokens"),
    limit: z.number().int().positive().max(100).optional(),
  },
  async (args) => {
    const script = path.join(repoRoot, "packages/event-log/a2a-v2.py");
    const argv = ["inbox", "--agent", args.agent, "--limit", String(args.limit ?? 20)];
    if (args.claim) argv.push("--claim");
    const out = await runPython(script, argv);
    return {
      content: [{ type: "text" as const, text: out }],
    };
  },
);

server.tool(
  "x_project_session_event",
  "Optional: project a session lifecycle pointer into Event Log (default refuses unless A2AX_PROJECTOR=1)",
  {
    kind: z.enum([
      "session.opened",
      "session.closed",
      "session.needs_input",
      "session.error",
    ]),
    provider: z.string(),
    session_id: z.string(),
    summary: z.string().max(200),
    payload_json: z.string().optional().describe("JSON object string, keep small"),
  },
  async (args) => {
    let payload: Record<string, unknown> = {};
    if (args.payload_json) {
      try {
        payload = JSON.parse(args.payload_json) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid_payload_json" });
      }
    }
    const day = new Date().toISOString().slice(0, 10);
    const result = await projector.project({
      kind: args.kind,
      provider: args.provider,
      sessionId: args.session_id,
      summary: args.summary,
      payload: { ...payload, provider: args.provider, session_id: args.session_id },
      idempotencyKey: `${args.kind}:${args.provider}:${args.session_id}:${day}`,
    });
    return json(result);
  },
);

async function runPython(script: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("python3", [script, ...args], {
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout || "{}");
      else
        resolve(
          JSON.stringify(
            {
              error: "event_log_proxy_failed",
              code,
              stderr: stderr.slice(0, 2000),
              stdout: stdout.slice(0, 2000),
              hint: "Ensure packages/event-log DB is configured; a2a-log.py may still be missing for writes",
            },
            null,
            2,
          ),
        );
    });
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
