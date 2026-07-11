/**
 * Append-only ops audit JSONL for multi-agent console mutations.
 * Default: ~/.a2a-event-x/audit/ops.jsonl  (override A2AX_AUDIT_PATH)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AuditOp =
  | "claim"
  | "ack"
  | "done"
  | "batch_done"
  | "renew"
  | "cancel"
  | "requeue_dead"
  | "compensate"
  | "v1_ack"
  | "v1_done"
  | "demo_seed";

export interface AuditEntry {
  ts: string;
  op: AuditOp | string;
  ok: boolean;
  agent?: string;
  detail?: Record<string, unknown>;
  error?: string;
  duration_ms?: number;
}

function auditPath(): string {
  if (process.env.A2AX_AUDIT_PATH) {
    return process.env.A2AX_AUDIT_PATH.startsWith("~/")
      ? path.join(os.homedir(), process.env.A2AX_AUDIT_PATH.slice(2))
      : process.env.A2AX_AUDIT_PATH;
  }
  return path.join(os.homedir(), ".a2a-event-x", "audit", "ops.jsonl");
}

export function recordOp(entry: Omit<AuditEntry, "ts"> & { ts?: string }): void {
  try {
    const full: AuditEntry = {
      ts: entry.ts || new Date().toISOString(),
      op: entry.op,
      ok: entry.ok,
      agent: entry.agent,
      detail: entry.detail,
      error: entry.error,
      duration_ms: entry.duration_ms,
    };
    // never log full claim tokens
    if (full.detail && typeof full.detail === "object") {
      const d: Record<string, unknown> = { ...full.detail };
      if (typeof d.token === "string") {
        d.token = d.token.slice(0, 8) + "…";
      }
      if (Array.isArray(d.tokens)) {
        const toks = d.tokens as unknown[];
        d.tokens = toks.map((t) =>
          typeof t === "string" ? t.slice(0, 8) + "…" : t,
        );
        d.token_count = toks.length;
      }
      full.detail = d;
    }
    const file = auditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(full) + "\n", "utf8");
  } catch {
    // audit must never break ops
  }
}

export function readRecentOps(limit = 100): {
  path: string;
  count: number;
  entries: AuditEntry[];
} {
  const file = auditPath();
  if (!fs.existsSync(file)) {
    return { path: file, count: 0, entries: [] };
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const slice = lines.slice(-limit);
  const entries: AuditEntry[] = [];
  for (const line of slice) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      /* skip */
    }
  }
  entries.reverse();
  return { path: file, count: lines.length, entries };
}
