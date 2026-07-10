/**
 * Session → Event Log projector (v0.1: default OFF).
 *
 * Clarification for product Q4:
 * - Session Hub reads vendor transcripts (Claude/Codex/OpenClaw/…).
 * - Event Log is the cross-agent task bus (claim/lease/done).
 * - Projector optionally writes *pointers* (session_id, provider, path)
 *   into Event Log so other agents can pull lifecycle signals.
 *
 * Enabling requires:
 *   1. A2AX_PROJECTOR=1 (or --project-events)
 *   2. packages/event-log write path available (a2a-log.py re-imported)
 *   3. agent `session-hub` registered in registry-agents.json
 *
 * This module only defines the interface; no automatic writes in v0.1.
 */

export interface ProjectableSessionEvent {
  kind: "session.opened" | "session.closed" | "session.needs_input" | "session.error";
  provider: string;
  sessionId: string;
  summary: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface Projector {
  enabled: boolean;
  project(event: ProjectableSessionEvent): Promise<{ ok: boolean; detail: string }>;
}

/** No-op projector — safe default. */
export class DisabledProjector implements Projector {
  enabled = false;
  async project(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: "projector disabled (default in v0.1)" };
  }
}

export function createProjector(): Projector {
  if (process.env.A2AX_PROJECTOR === "1" || process.env.A2AX_PROJECTOR === "true") {
    return new SubprocessProjector();
  }
  return new DisabledProjector();
}

/**
 * Stub that will call `a2a-log.py write` once the canonical CLI is vendored.
 * Currently refuses with a clear message.
 */
export class SubprocessProjector implements Projector {
  enabled = true;
  async project(event: ProjectableSessionEvent): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: false,
      detail:
        `projector enabled but a2a-log.py not yet vendored into packages/event-log; ` +
        `would write type=info.sync key=${event.idempotencyKey} summary=${JSON.stringify(event.summary)}`,
    };
  }
}
