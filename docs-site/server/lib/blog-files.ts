import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The posts in docs-site/content/blog/, read at build time from the files themselves: the content
 * config splits them into collections, and nuxt.config prerenders the published ones.
 * Only `draft` and `publishAt` are read here; Nuxt Content parses everything else.
 */
export interface BlogFile {
  file: string;
  slug: string;
  draft: boolean;
  /** Epoch ms the post goes live, from `publishAt`; undefined = live when deployed. */
  publishAt?: number;
}

/** An ISO date-time with an explicit offset, so a schedule never depends on the build's zone. */
const PUBLISH_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;

export function parsePublishAt(value: string, file = "post"): number {
  const ms = Date.parse(value);
  if (!PUBLISH_AT.test(value) || Number.isNaN(ms)) {
    throw new Error(
      `${file}: publishAt must look like 2026-11-10T09:00:00-05:00 (with an offset), got "${value}"`,
    );
  }
  return ms;
}

export function blogFiles(dir: string): BlogFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  return names.map((file) => {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, file), "utf8"))?.[1];
    // The whole value: a malformed time must fail the build, never publish at once.
    const raw = front && /^publishAt:[ \t]*(.*)$/m.exec(front)?.[1]?.trim();
    const at = raw ? raw.replace(/^(["'])(.*)\1$/, "$2") : undefined;
    return {
      file,
      slug: file.slice(0, -3),
      draft: !!front && /^draft:\s*true\s*$/m.test(front),
      publishAt: at ? parsePublishAt(at, file) : undefined,
    };
  });
}

/** Still waiting for its `publishAt` at `now`. */
export const isScheduled = (f: BlogFile, now: number) =>
  f.publishAt !== undefined && f.publishAt > now;
