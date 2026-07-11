/**
 * Thin proxy helpers around packages/event-log Python CLIs.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function eventLogPaths(repoRoot: string) {
  const v2 = path.join(repoRoot, "packages/event-log/a2a-v2.py");
  const v1 = path.join(repoRoot, "packages/event-log/scripts/a2a-log.py");
  const store = path.join(repoRoot, "packages/event-log/a2a_v2_store.py");
  return {
    v1,
    v2,
    store,
    v1Exists: fs.existsSync(v1),
    v2Exists: fs.existsSync(v2),
  };
}

export function runPython(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [script, ...args], {
      env: {
        ...env,
        // Ensure monorepo v1 is preferred when set by server
        A2A_LOG_CLI:
          env.A2A_LOG_CLI ||
          path.join(path.dirname(script), "scripts", "a2a-log.py"),
      },
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

export async function runEventV2(
  repoRoot: string,
  args: string[],
): Promise<{ status: number; body: unknown }> {
  const { v2, v2Exists, v1 } = eventLogPaths(repoRoot);
  if (!v2Exists) {
    return {
      status: 503,
      body: { error: "event_log_missing", hint: "a2a-v2.py not found" },
    };
  }
  const result = await runPython(v2, args, {
    ...process.env,
    A2A_LOG_CLI: process.env.A2A_LOG_CLI || v1,
  });
  if (!result.ok) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(result.stdout || result.stderr);
    } catch {
      /* ignore */
    }
    return {
      status: 400,
      body:
        parsed || {
          error: "event_log_failed",
          code: result.code,
          detail: (result.stderr || result.stdout).slice(0, 2000),
        },
    };
  }
  try {
    return { status: 200, body: JSON.parse(result.stdout) };
  } catch {
    return { status: 200, body: { raw: result.stdout } };
  }
}
