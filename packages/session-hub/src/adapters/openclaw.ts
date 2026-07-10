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
import { DEFAULT_ROOTS, home } from "../core/paths.js";
import {
  exists,
  mtimeIso,
  readTextLimited,
  walkFiles,
} from "./fs-utils.js";

/**
 * OpenClaw sessions:
 *   ~/.openclaw/agents/<agentId>/sessions/sessions.json
 *   ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
 */
export class OpenClawAdapter implements SessionAdapter {
  id = "openclaw" as const;
  constructor(
    private roots: string[] = [
      ...DEFAULT_ROOTS.openclaw,
      path.join(home(), ".openclaw-autoclaw", "agents"),
    ],
  ) {}

  async health(): Promise<AdapterHealth> {
    const present: string[] = [];
    for (const r of this.roots) {
      if (await exists(r)) present.push(r);
    }
    return {
      ok: present.length > 0,
      detail: present.length
        ? `found ${present.length} agents root(s)`
        : "no openclaw agents dir",
      rootPaths: present,
    };
  }

  async discover(): Promise<SessionRef[]> {
    const sessions: SessionRef[] = [];
    for (const root of this.roots) {
      if (!(await exists(root))) continue;
      let agents: string[] = [];
      try {
        agents = await fs.readdir(root);
      } catch {
        continue;
      }
      for (const agentId of agents) {
        const sessDir = path.join(root, agentId, "sessions");
        if (!(await exists(sessDir))) continue;

        // Prefer sessions.json index when present
        const indexPath = path.join(sessDir, "sessions.json");
        if (await exists(indexPath)) {
          try {
            const raw = await readTextLimited(indexPath, 5_000_000);
            const index = JSON.parse(raw) as Record<string, unknown>;
            const entries = Array.isArray(index)
              ? index
              : Array.isArray(index.sessions)
                ? index.sessions
                : Object.entries(index).map(([k, v]) =>
                    typeof v === "object" && v
                      ? { id: k, ...(v as object) }
                      : { id: k },
                  );
            for (const ent of entries as Record<string, unknown>[]) {
              const nativeId = String(ent.id || ent.sessionId || "");
              if (!nativeId) continue;
              const jsonl = path.join(sessDir, `${nativeId}.jsonl`);
              sessions.push({
                id: `openclaw:${agentId}:${nativeId}`,
                provider: "openclaw",
                nativeId: `${agentId}/${nativeId}`,
                title: String(ent.label || ent.title || `${agentId}:${nativeId}`),
                projectPath: sessDir,
                updatedAt:
                  typeof ent.updatedAt === "string"
                    ? ent.updatedAt
                    : typeof ent.updatedAt === "number"
                      ? new Date(ent.updatedAt).toISOString()
                      : undefined,
                status: "unknown",
                resume: {
                  kind: "command",
                  value: `openclaw sessions --agent ${agentId}`,
                },
                sourcePaths: (await exists(jsonl)) ? [jsonl, indexPath] : [indexPath],
              });
            }
            continue;
          } catch {
            // fall through to file walk
          }
        }

        const files = await walkFiles(sessDir, {
          maxDepth: 2,
          match: (n) => n.endsWith(".jsonl"),
        });
        for (const file of files) {
          const st = await fs.stat(file);
          const nativeId = path.basename(file, ".jsonl");
          sessions.push({
            id: `openclaw:${agentId}:${nativeId}`,
            provider: "openclaw",
            nativeId: `${agentId}/${nativeId}`,
            title: `${agentId}:${nativeId}`,
            projectPath: sessDir,
            updatedAt: mtimeIso(st.mtimeMs),
            createdAt: mtimeIso(st.birthtimeMs || st.mtimeMs),
            status: "unknown",
            resume: {
              kind: "command",
              value: `openclaw sessions --agent ${agentId}`,
            },
            sourcePaths: [file],
          });
        }
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
    const all = await this.discover();
    const hit = all.find((s) => s.nativeId === nativeId || s.id.endsWith(`:${nativeId}`));
    if (!hit) return [];
    const jsonl = hit.sourcePaths.find((p) => p.endsWith(".jsonl"));
    if (!jsonl) return [];
    const text = await readTextLimited(jsonl);
    const messages: Message[] = [];
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const roleRaw = String(row.role || row.type || "");
        const role: Message["role"] = roleRaw.includes("user")
          ? "user"
          : roleRaw.includes("tool")
            ? "tool"
            : roleRaw.includes("system")
              ? "system"
              : "assistant";
        let body = "";
        if (typeof row.content === "string") body = row.content;
        else if (typeof row.text === "string") body = row.text;
        else if (typeof row.message === "string") body = row.message;
        if (!body) continue;
        messages.push({
          role,
          ts: typeof row.timestamp === "string" ? row.timestamp : undefined,
          text: body.slice(0, maxChars),
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
      const file = s.sourcePaths.find((p) => p.endsWith(".jsonl"));
      if (!file) continue;
      try {
        const text = await readTextLimited(file, 500_000);
        const idx = text.toLowerCase().indexOf(q);
        if (idx >= 0) {
          hits.push({
            sessionId: s.id,
            provider: "openclaw",
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
