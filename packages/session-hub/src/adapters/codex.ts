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
 * Codex CLI/Desktop session history typically under ~/.codex/sessions
 * (JSON / JSONL rollouts — format varies by version; best-effort parser).
 */
export class CodexAdapter implements SessionAdapter {
  id = "codex" as const;
  constructor(private roots: string[] = DEFAULT_ROOTS.codex) {}

  async health(): Promise<AdapterHealth> {
    const present: string[] = [];
    for (const r of this.roots) {
      if (await exists(r)) present.push(r);
    }
    // also accept ~/.codex without sessions subdir
    const codexHome = path.join(process.env.HOME || "", ".codex");
    if (!present.length && (await exists(codexHome))) present.push(codexHome);
    return {
      ok: present.length > 0,
      detail: present.length ? `found ${present.length} root(s)` : "no ~/.codex",
      rootPaths: present,
    };
  }

  async discover(): Promise<SessionRef[]> {
    const sessions: SessionRef[] = [];
    const roots = [...this.roots];
    const codexHome = path.join(process.env.HOME || "", ".codex");
    if (!roots.includes(codexHome)) roots.push(codexHome);

    for (const root of roots) {
      if (!(await exists(root))) continue;
      const files = await walkFiles(root, {
        maxDepth: 6,
        match: (n) =>
          n.endsWith(".jsonl") ||
          n.endsWith(".json") ||
          n.includes("rollout") ||
          n.includes("session"),
      });
      for (const file of files) {
        // skip huge index/db-ish names
        if (file.endsWith(".sqlite") || file.endsWith(".db")) continue;
        const st = await fs.stat(file);
        if (st.size < 16) continue;
        const nativeId = path.basename(file).replace(/\.(jsonl|json)$/, "");
        sessions.push({
          id: `codex:${nativeId}`,
          provider: "codex",
          nativeId,
          title: nativeId,
          projectPath: path.dirname(file),
          updatedAt: mtimeIso(st.mtimeMs),
          createdAt: mtimeIso(st.birthtimeMs || st.mtimeMs),
          status: "unknown",
          resume: {
            kind: "command",
            value: `codex resume ${nativeId}`,
          },
          sourcePaths: [file],
        });
      }
    }
    // de-dupe by id
    const map = new Map(sessions.map((s) => [s.id, s]));
    return [...map.values()].sort((a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    );
  }

  async getMessages(nativeId: string, opts: PageOpts = {}): Promise<Message[]> {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    const maxChars = opts.maxChars ?? 4000;
    const all = await this.discover();
    const hit = all.find((s) => s.nativeId === nativeId);
    if (!hit?.sourcePaths[0]) return [];
    const text = await readTextLimited(hit.sourcePaths[0]);
    const messages: Message[] = [];

    if (hit.sourcePaths[0].endsWith(".jsonl")) {
      for (const line of text.split("\n").filter(Boolean)) {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          const body =
            (typeof row.content === "string" && row.content) ||
            (typeof row.text === "string" && row.text) ||
            (typeof row.message === "string" && row.message) ||
            "";
          if (!body) continue;
          const roleRaw = String(row.role || row.type || "assistant");
          const role: Message["role"] = roleRaw.includes("user")
            ? "user"
            : roleRaw.includes("tool")
              ? "tool"
              : roleRaw.includes("system")
                ? "system"
                : "assistant";
          messages.push({ role, text: body.slice(0, maxChars) });
        } catch {
          /* skip */
        }
      }
    } else {
      // single JSON blob — best effort
      try {
        const row = JSON.parse(text) as Record<string, unknown>;
        const items = (row.messages || row.items || []) as unknown[];
        if (Array.isArray(items)) {
          for (const it of items) {
            if (!it || typeof it !== "object") continue;
            const m = it as Record<string, unknown>;
            const body = String(m.content || m.text || "");
            if (!body) continue;
            messages.push({
              role: String(m.role || "assistant").includes("user")
                ? "user"
                : "assistant",
              text: body.slice(0, maxChars),
            });
          }
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
            provider: "codex",
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
