import type {
  ListSessionsFilter,
  Message,
  PageOpts,
  ProviderId,
  SearchHit,
  SessionAdapter,
  SessionRef,
} from "./core/types.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";
import { OpenClawAdapter } from "./adapters/openclaw.js";
import { GrokBuildAdapter } from "./adapters/grok-build.js";
import { AntigravityAdapter } from "./adapters/antigravity.js";

export class SessionHub {
  private adapters: SessionAdapter[];

  constructor(adapters?: SessionAdapter[]) {
    this.adapters =
      adapters ??
      [
        new ClaudeCodeAdapter(),
        new CodexAdapter(),
        new OpenClawAdapter(),
        new GrokBuildAdapter(),
        new AntigravityAdapter(),
      ];
  }

  async health() {
    const adapters = [];
    for (const a of this.adapters) {
      const h = await a.health();
      adapters.push({
        provider: a.id,
        ...h,
      });
    }
    return {
      ok: adapters.some((a) => a.ok),
      adapters,
      projectorDefault: "off",
    };
  }

  async listSessions(filter: ListSessionsFilter = {}): Promise<SessionRef[]> {
    let all: SessionRef[] = [];
    const providers = filter.provider
      ? new Set(
          Array.isArray(filter.provider) ? filter.provider : [filter.provider],
        )
      : null;

    for (const a of this.adapters) {
      if (providers && !providers.has(a.id)) continue;
      try {
        all = all.concat(await a.discover());
      } catch (err) {
        // adapter failures are non-fatal
        console.error(`[a2ax] adapter ${a.id} discover failed:`, err);
      }
    }

    // de-dupe: prefer source file path, then stable id
    // (nested roots e.g. ~/.grok and ~/.grok/sessions scan the same files)
    const byKey = new Map<string, SessionRef>();
    for (const s of all) {
      const key = s.sourcePaths[0] || s.id;
      const prev = byKey.get(key);
      if (!prev || (s.updatedAt || "") > (prev.updatedAt || "")) {
        byKey.set(key, s);
      }
    }
    all = [...byKey.values()];

    if (filter.project) {
      const p = filter.project.toLowerCase();
      all = all.filter(
        (s) =>
          (s.projectPath || "").toLowerCase().includes(p) ||
          (s.title || "").toLowerCase().includes(p),
      );
    }
    if (filter.status) {
      all = all.filter((s) => s.status === filter.status);
    }
    if (filter.since) {
      all = all.filter((s) => (s.updatedAt || "") >= filter.since!);
    }
    all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    if (filter.limit && filter.limit > 0) all = all.slice(0, filter.limit);
    return all;
  }

  async getSession(sessionId: string): Promise<SessionRef | null> {
    const all = await this.listSessions();
    return (
      all.find((s) => s.id === sessionId || s.nativeId === sessionId) ?? null
    );
  }

  async getMessages(
    sessionId: string,
    opts?: PageOpts,
  ): Promise<{ session: SessionRef; messages: Message[] } | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;
    const adapter = this.adapters.find((a) => a.id === session.provider);
    if (!adapter) return { session, messages: [] };
    const messages = await adapter.getMessages(session.nativeId, opts);
    // openclaw nativeId is agent/session — adapters handle both forms
    if (!messages.length && session.nativeId.includes("/")) {
      const only = session.nativeId.split("/").pop()!;
      const alt = await adapter.getMessages(only, opts);
      return { session, messages: alt };
    }
    return { session, messages };
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    for (const a of this.adapters) {
      if (!a.search) continue;
      try {
        const part = await a.search(query, limit);
        hits.push(...part);
      } catch (err) {
        console.error(`[a2ax] adapter ${a.id} search failed:`, err);
      }
      if (hits.length >= limit) break;
    }
    return hits.slice(0, limit);
  }

  providers(): ProviderId[] {
    return this.adapters.map((a) => a.id);
  }
}
