import fs from "node:fs/promises";
import path from "node:path";

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(
  root: string,
  opts: { maxDepth?: number; match?: (name: string) => boolean } = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 6;
  const out: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".git") continue;
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (!opts.match || opts.match(ent.name)) out.push(full);
      }
    }
  }

  if (await exists(root)) await walk(root, 0);
  return out;
}

export async function readTextLimited(
  file: string,
  maxBytes = 2_000_000,
): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const stat = await fh.stat();
    const size = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

export function mtimeIso(ms: number): string {
  return new Date(ms).toISOString();
}
