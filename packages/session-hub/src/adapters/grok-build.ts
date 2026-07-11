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
import { extractGenericMessage, humanTitleFromPath } from "./title-utils.js";

/**
 * Grok Build — sessions under ~/.grok/sessions/<encoded-cwd>/*.jsonl
 */
export class GrokBuildAdapter implements SessionAdapter {
  id = "grok-build" as const;
  constructor(
    private roots: string[] = [DEFAULT_ROOTS["grok-build"][0]].filter(Boolean),
  ) {}

  async health(): Promise<AdapterHealth> {
    const present: string[] = [];
    for (const r of this.roots) {
      if (await exists(r)) present.push(r);
    }
    return {
      ok: present.length > 0,
      detail: present.length
        ? `found ${present.length} root(s)`
        : "no ~/.grok/sessions — configure adapter roots",
      rootPaths: present,
    };
  }

  async discover(): Promise<SessionRef[]> {
    const sessions: SessionRef[] = [];
    for (const root of this.roots) {
      if (!(await exists(root))) continue;
      const files = await walkFiles(root, {
        maxDepth: 5,
        match: (n) =>
          n.endsWith(".jsonl") ||
          (n.endsWith(".json") &&
            (n.includes("session") ||
              n.includes("chat") ||
              n.includes("history") ||
              n === "updates.json" ||
              n === "events.json")),
      });
      for (const file of files) {
        if (file.includes("node_modules")) continue;
        // skip noisy internal logs that are not chat transcripts
        const base = path.basename(file);
        if (base === "events.jsonl" || base === "events.json") continue;

        const st = await fs.stat(file);
        if (st.size < 32) continue;
        const rel = path.relative(root, file).replace(/\\/g, "/");
        const nativeId = rel.replace(/\.(jsonl|json)$/, "");
        const title = humanTitleFromPath(file, nativeId);
        sessions.push({
          id: `grok-build:${nativeId}`,
          provider: "grok-build",
          nativeId,
          title,
          projectPath: path.dirname(file),
          updatedAt: mtimeIso(st.mtimeMs),
          createdAt: mtimeIso(st.birthtimeMs || st.mtimeMs),
          status: "unknown",
          resume: {
            kind: "command",
            value: `grok # open session in Grok Build TUI — id ${path.basename(path.dirname(file))}`,
          },
          sourcePaths: [file],
        });
      }
    }
    return sessions.sort((a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    );
  }

  async getMessages(nativeId: string, opts: PageOpts = {}): Promise<Message[]> {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    const maxChars = opts.maxChars ?? 4000;
    const hit = (await this.discover()).find((s) => s.nativeId === nativeId);
    if (!hit?.sourcePaths[0]) return [];
    const text = await readTextLimited(hit.sourcePaths[0]);
    const messages: Message[] = [];
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const m = extractGenericMessage(row);
        if (!m) continue;
        messages.push({
          role: m.role,
          ts: m.ts,
          text: m.text.slice(0, maxChars),
        });
      } catch {
        /* skip */
      }
    }
    if (!messages.length && text.trim().startsWith("{")) {
      try {
        const row = JSON.parse(text) as Record<string, unknown>;
        const items = (row.messages || row.items || []) as unknown[];
        for (const it of items) {
          if (!it || typeof it !== "object") continue;
          const m = extractGenericMessage(it as Record<string, unknown>);
          if (!m) continue;
          messages.push({
            role: m.role,
            ts: m.ts,
            text: m.text.slice(0, maxChars),
          });
        }
      } catch {
        /* skip */
      }
    }
    return messages.slice(offset, offset + limit);
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const q = query.toLowerCase();
    const hits: SearchHit[] = [];
    for (const s of await this.discover()) {
      if (hits.length >= limit) break;
      const file = s.sourcePaths[0];
      if (!file) continue;
      try {
        const text = await readTextLimited(file, 500_000);
        const idx = text.toLowerCase().indexOf(q);
        if (idx >= 0) {
          hits.push({
            sessionId: s.id,
            provider: "grok-build",
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
