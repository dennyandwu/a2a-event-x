import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterHealth,
  Message,
  PageOpts,
  SearchHit,
  SessionAdapter,
  SessionRef,
} from "../core/types.js";
import { DEFAULT_ROOTS } from "../core/paths.js";
import {
  exists,
  mtimeIso,
  readTextLimited,
  walkFiles,
} from "./fs-utils.js";

/**
 * Claude Code stores per-project JSONL transcripts under ~/.claude/projects/
 * Path segments are often encoded project roots; files are *.jsonl sessions.
 */
export class ClaudeCodeAdapter implements SessionAdapter {
  id = "claude-code" as const;
  constructor(private roots: string[] = DEFAULT_ROOTS["claude-code"]) {}

  async health(): Promise<AdapterHealth> {
    const present: string[] = [];
    for (const r of this.roots) {
      if (await exists(r)) present.push(r);
    }
    return {
      ok: present.length > 0,
      detail: present.length
        ? `found ${present.length} root(s)`
        : "no ~/.claude/projects root",
      rootPaths: present,
    };
  }

  async discover(): Promise<SessionRef[]> {
    const sessions: SessionRef[] = [];
    for (const root of this.roots) {
      if (!(await exists(root))) continue;
      const files = await walkFiles(root, {
        maxDepth: 5,
        match: (n) => n.endsWith(".jsonl"),
      });
      for (const file of files) {
        const st = await fs.stat(file);
        const nativeId = path.basename(file, ".jsonl");
        const projectDir = path.dirname(file);
        const projectHint = path.basename(projectDir);
        sessions.push({
          id: `claude-code:${nativeId}`,
          provider: "claude-code",
          nativeId,
          title: projectHint,
          projectPath: projectDir,
          updatedAt: mtimeIso(st.mtimeMs),
          createdAt: mtimeIso(st.birthtimeMs || st.mtimeMs),
          status: "unknown",
          resume: {
            kind: "command",
            value: `claude --resume ${nativeId}`,
          },
          sourcePaths: [file],
        });
      }
    }
    sessions.sort((a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    );
    return sessions;
  }

  async getMessages(nativeId: string, opts: PageOpts = {}): Promise<Message[]> {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    const maxChars = opts.maxChars ?? 4000;
    const all = await this.discover();
    const hit = all.find((s) => s.nativeId === nativeId);
    if (!hit?.sourcePaths[0]) return [];
    const text = await readTextLimited(hit.sourcePaths[0]);
    const lines = text.split("\n").filter(Boolean);
    const messages: Message[] = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const role = inferClaudeRole(row);
        const body = extractClaudeText(row);
        if (!body) continue;
        messages.push({
          role,
          ts: typeof row.timestamp === "string" ? row.timestamp : undefined,
          text: body.slice(0, maxChars),
        });
      } catch {
        // skip bad lines
      }
    }
    return messages.slice(offset, offset + limit);
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const q = query.toLowerCase();
    const hits: SearchHit[] = [];
    const sessions = await this.discover();
    for (const s of sessions) {
      if (hits.length >= limit) break;
      const file = s.sourcePaths[0];
      if (!file) continue;
      try {
        const text = await readTextLimited(file, 500_000);
        const idx = text.toLowerCase().indexOf(q);
        if (idx >= 0) {
          hits.push({
            sessionId: s.id,
            provider: "claude-code",
            snippet: text.slice(Math.max(0, idx - 40), idx + q.length + 80),
            ts: s.updatedAt,
          });
        }
      } catch {
        /* skip */
      }
    }
    return hits;
  }
}

function inferClaudeRole(row: Record<string, unknown>): Message["role"] {
  const t = String(row.type || row.role || "");
  if (t.includes("user") || t === "human") return "user";
  if (t.includes("assistant") || t.includes("ai")) return "assistant";
  if (t.includes("tool")) return "tool";
  if (t.includes("system")) return "system";
  return "assistant";
}

function extractClaudeText(row: Record<string, unknown>): string {
  if (typeof row.message === "string") return row.message;
  if (typeof row.content === "string") return row.content;
  if (row.message && typeof row.message === "object") {
    const m = row.message as Record<string, unknown>;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((c) =>
          typeof c === "object" && c && "text" in c
            ? String((c as { text: unknown }).text)
            : "",
        )
        .filter(Boolean)
        .join("\n");
    }
  }
  if (typeof row.text === "string") return row.text;
  return "";
}
