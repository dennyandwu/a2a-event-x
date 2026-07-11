import path from "node:path";

/** Decode URI components and collapse noisy path segments into a short title. */
export function humanTitleFromPath(filePath: string, fallback: string): string {
  try {
    const base = path.basename(filePath).replace(/\.(jsonl|json)$/i, "");
    const parent = path.basename(path.dirname(filePath));
    const decodedParent = safeDecode(parent);
    const decodedBase = safeDecode(base);

    // Grok sessions often live under encoded cwd: %2FUsers%2F.../chat_history
    const shortParent = shortenPathish(decodedParent);
    if (
      decodedBase === "chat_history" ||
      decodedBase === "updates" ||
      decodedBase === "events" ||
      decodedBase === "history"
    ) {
      return `${shortParent} · ${decodedBase}`;
    }
    if (shortParent && shortParent !== "." && shortParent !== decodedBase) {
      return `${shortParent} · ${decodedBase}`;
    }
    return decodedBase || fallback;
  } catch {
    return fallback;
  }
}

export function safeDecode(s: string): string {
  let out = s;
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

function shortenPathish(s: string): string {
  if (!s) return s;
  // absolute path → last 2 segments
  if (s.includes("/") || s.includes("\\")) {
    const parts = s.split(/[/\\]/).filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join("/");
    return parts[parts.length - 1] || s;
  }
  // long opaque id → first 8
  if (s.length > 24 && /^[0-9a-f-]{20,}$/i.test(s)) return s.slice(0, 8) + "…";
  if (s.length > 40) return s.slice(0, 18) + "…" + s.slice(-8);
  return s;
}

/** Best-effort extract text from heterogeneous JSONL rows (Grok / AGY / generic). */
export function extractGenericMessage(row: Record<string, unknown>): {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  ts?: string;
} | null {
  const roleRaw = String(row.role || row.type || row.author || "");
  let role: "user" | "assistant" | "system" | "tool" = "assistant";
  if (/user|human|prompt/i.test(roleRaw)) role = "user";
  else if (/tool|function/i.test(roleRaw)) role = "tool";
  else if (/system/i.test(roleRaw)) role = "system";

  let text = "";
  if (typeof row.content === "string") text = row.content;
  else if (typeof row.text === "string") text = row.text;
  else if (typeof row.message === "string") text = row.message;
  else if (typeof row.prompt === "string") text = row.prompt;
  else if (typeof row.response === "string") text = row.response;
  else if (row.message && typeof row.message === "object") {
    const m = row.message as Record<string, unknown>;
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .map((c) =>
          typeof c === "object" && c && "text" in c
            ? String((c as { text: unknown }).text)
            : typeof c === "string"
              ? c
              : "",
        )
        .filter(Boolean)
        .join("\n");
    }
  } else if (Array.isArray(row.content)) {
    text = row.content
      .map((c) =>
        typeof c === "object" && c && "text" in c
          ? String((c as { text: unknown }).text)
          : typeof c === "string"
            ? c
            : "",
      )
      .filter(Boolean)
      .join("\n");
  } else if (typeof row.data === "string") text = row.data;

  if (!text.trim()) return null;
  const ts =
    typeof row.timestamp === "string"
      ? row.timestamp
      : typeof row.ts === "string"
        ? row.ts
        : typeof row.createdAt === "string"
          ? row.createdAt
          : undefined;
  return { role, text, ts };
}
