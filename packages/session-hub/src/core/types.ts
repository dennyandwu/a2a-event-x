/** Stable provider ids for Session Hub adapters. */
export type ProviderId =
  | "claude-code"
  | "codex"
  | "openclaw"
  | "grok-build"
  | "antigravity-cli"
  | "unknown";

export type SessionStatus = "active" | "idle" | "archived" | "unknown";

export interface ResumeHint {
  kind: "command" | "uri";
  value: string;
}

export interface SessionRef {
  /** Stable id: `${provider}:${nativeId}` */
  id: string;
  provider: ProviderId;
  nativeId: string;
  title?: string;
  projectPath?: string;
  createdAt?: string;
  updatedAt?: string;
  status: SessionStatus;
  resume?: ResumeHint;
  sourcePaths: string[];
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  role: MessageRole;
  ts?: string;
  text: string;
}

export interface PageOpts {
  offset?: number;
  limit?: number;
  maxChars?: number;
}

export interface SearchHit {
  sessionId: string;
  provider: ProviderId;
  snippet: string;
  ts?: string;
}

export interface AdapterHealth {
  ok: boolean;
  detail: string;
  rootPaths: string[];
}

export interface SessionAdapter {
  id: ProviderId;
  discover(): Promise<SessionRef[]>;
  getMessages(nativeId: string, opts?: PageOpts): Promise<Message[]>;
  search?(query: string, limit?: number): Promise<SearchHit[]>;
  health(): Promise<AdapterHealth>;
}

export interface ListSessionsFilter {
  provider?: ProviderId | ProviderId[];
  project?: string;
  status?: SessionStatus;
  since?: string;
  limit?: number;
}
