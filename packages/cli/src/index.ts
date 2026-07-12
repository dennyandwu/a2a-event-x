#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionHub } from "@a2a-event-x/session-hub";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function usage(): never {
  console.log(`a2ax — A2A Event X CLI

Usage:
  a2ax health
  a2ax list [--provider <id>] [--project <substr>] [--limit N]
  a2ax show <session_id>
  a2ax messages <session_id> [--limit N]
  a2ax search <query>
  a2ax log <args...>       # proxy to packages/event-log/a2a-v2.py
  a2ax web                 # print B/S console URL hint

Providers: claude-code | codex | openclaw | grok-build | antigravity-cli

Agent consumption: use a2a-v2.py / a2a-log.py (see skills/a2a-consumer).
Human console: http://127.0.0.1:8787/ (npm run web)
`);
  process.exit(1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") usage();

  const hub = new SessionHub();

  if (cmd === "health") {
    console.log(JSON.stringify(await hub.health(), null, 2));
    return;
  }

  if (cmd === "list") {
    const opts: Record<string, string | number> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--provider") opts.provider = rest[++i];
      else if (rest[i] === "--project") opts.project = rest[++i];
      else if (rest[i] === "--limit") opts.limit = Number(rest[++i]);
    }
    const sessions = await hub.listSessions({
      provider: opts.provider as never,
      project: opts.project as string | undefined,
      limit: (opts.limit as number) || 50,
    });
    console.log(JSON.stringify({ count: sessions.length, sessions }, null, 2));
    return;
  }

  if (cmd === "show") {
    const id = rest[0];
    if (!id) usage();
    console.log(JSON.stringify({ session: await hub.getSession(id) }, null, 2));
    return;
  }

  if (cmd === "messages") {
    const id = rest[0];
    if (!id) usage();
    let limit = 50;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--limit") limit = Number(rest[++i]);
    }
    console.log(JSON.stringify(await hub.getMessages(id, { limit }), null, 2));
    return;
  }

  if (cmd === "search") {
    const q = rest.join(" ").trim();
    if (!q) usage();
    console.log(JSON.stringify({ hits: await hub.search(q) }, null, 2));
    return;
  }

  if (cmd === "web") {
    const host = process.env.A2AX_HOST || "127.0.0.1";
    const port = process.env.A2AX_PORT || "8787";
    console.log(`A2A Event X console: http://${host}:${port}/`);
    console.log(`Start: npm run web`);
    return;
  }

  if (cmd === "log") {
    const script = path.join(repoRoot, "packages/event-log/a2a-v2.py");
    const child = spawn("python3", [script, ...rest], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
