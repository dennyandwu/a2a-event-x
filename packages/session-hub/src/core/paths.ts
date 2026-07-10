import os from "node:os";
import path from "node:path";

export function home(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function a2axHome(): string {
  return (
    process.env.A2AX_HOME ||
    path.join(home(), ".a2a-event-x")
  );
}

export function expandUser(p: string): string {
  if (p.startsWith("~/")) return path.join(home(), p.slice(2));
  if (p === "~") return home();
  return p;
}

/** Default roots per provider (overridable via env / config later). */
export const DEFAULT_ROOTS: Record<string, string[]> = {
  "claude-code": [path.join(home(), ".claude", "projects")],
  codex: [path.join(home(), ".codex", "sessions")],
  openclaw: [path.join(home(), ".openclaw", "agents")],
  "grok-build": [
    path.join(home(), ".grok", "sessions"),
    path.join(home(), ".grok"),
  ],
  "antigravity-cli": [
    path.join(home(), ".antigravity"),
    path.join(home(), ".config", "antigravity"),
  ],
};
