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
 * Antigravity CLI — best-effort local store discovery.
 */
export class AntigravityAdapter implements SessionAdapter {
  id = "antigravity-cli" as const;
  constructor(private roots: string[] = DEFAULT_ROOTS["antigravity-cli"]) {}

  async health(): Promise<AdapterHealth> {
    const present: string[] = [];
    for (const r of this.roots) {
      if (await exists(r)) present.push(r);
    }
    return {
      ok: present.length > 0,
      detail: present.length
        ? `found ${present.length} root(s)`
        : "no antigravity config root — install CLI or set roots",
      rootPaths: present,
    };
  }

  async discover(): Promise<SessionRef[]> {
    const sessions: SessionRef[] = [];
    for (const root of this.roots) {
      if (!(await exists(root))) continue;
      const files = await walkFiles(root, {
        maxDepth: 6,
        match: (n) =>
          n.endsWith(".jsonl") ||
          n.endsWith(".json") ||
          n.includes("session") ||
          n.includes("history"),
      });
      for (const file of files) {
        const st = await fs.stat(file);
        if (st.size < 16) continue;
        const rel = path.relative(root, file).replace(/\\/g, "/");
        const nativeId = rel.replace(/\.(jsonl|json)$/, "") || path.basename(file);
        sessions.push({
          id: `antigravity-cli:${nativeId}`,
          provider: "antigravity-cli",
          nativeId,
          title: humanTitleFromPath(file, nativeId),
          projectPath: path.dirname(file),
          updatedAt: mtimeIso(st.mtimeMs),
          createdAt: mtimeIso(st.birthtimeMs || st.mtimeMs),
          status: "unknown",
          resume: {
            kind: "command",
            value: `agy # resume ${path.basename(file)}`,
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
        const text = await readTextLimited(file, 300_000);
        const idx = text.toLowerCase().indexOf(q);
        if (idx >= 0) {
          hits.push({
            sessionId: s.id,
            provider: "antigravity-cli",
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
