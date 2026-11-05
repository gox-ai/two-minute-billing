import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_TYPES,
  type Block,
  type ReleaseNote,
  type ReleaseType,
  type Span,
} from "@/lib/release-note-types";

/**
 * Release notes are MARKDOWN FILES IN THE REPO (`dashboard/content/releases/*.md`) — not rows
 * in a table. They ship with the deploy that contains the work they describe, and they get
 * reviewed in the same PR, which is the only mechanism that keeps a note and its feature from
 * drifting apart. The cost is that publishing one needs a deploy; that is the trade we chose.
 *
 * The renderer below is a deliberate SUBSET of markdown — headings, paragraphs, lists, fenced
 * code, and inline code/bold/italic/links. It exists so the page needs no markdown dependency
 * and no `dangerouslySetInnerHTML`: blocks are parsed to data here and rendered as React
 * elements in `components/release-note-body.tsx`, so nothing an author writes can inject markup.
 * If a note needs something this cannot express, widen the subset here — do not reach for raw HTML.
 */

export type { Block, ReleaseNote, ReleaseType, Span } from "@/lib/release-note-types";

const DIR = join(process.cwd(), "content", "releases");

/**
 * Inline markup. Ordered so a code span wins: backticks suppress everything inside them,
 * which is what lets a note write `**` or `_` as literal text.
 *
 * Italic is `_x_` only. `*x*` was left out on purpose — it collides with `**x**` and needs
 * lookahead to disambiguate, for a form nobody writing these notes will miss.
 */
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

const INLINE = /`([^`]+)`|\*\*([\s\S]+?)\*\*|_([^_]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g;

function parseInline(src: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    const at = m.index;
    if (at > last) spans.push({ kind: "text", text: src.slice(last, at) });
    if (m[1] !== undefined) spans.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) spans.push({ kind: "strong", spans: parseInline(m[2]) });
    else if (m[3] !== undefined) spans.push({ kind: "em", spans: parseInline(m[3]) });
    else if (m[4] !== undefined && m[5] !== undefined)
      spans.push({ kind: "link", href: m[5], spans: parseInline(m[4]) });
    last = at + m[0].length;
  }
  if (last < src.length) spans.push({ kind: "text", text: src.slice(last) });
  return spans;
}

function parseBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push({ kind: "p", spans: parseInline(para.join(" ").trim()) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```"))
        buf.push(lines[i] ?? "");
      blocks.push({ kind: "pre", text: buf.join("\n") });
      continue;
    }

    if (trimmed === "") {
      flushPara();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      // The note's own title lives in frontmatter and renders as the card heading, so a
      // body heading is always a SUBheading — `#` and `##` both land on h2.
      blocks.push({
        kind: "h",
        level: (heading[1] ?? "").length >= 3 ? 3 : 2,
        spans: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    const numbered = NUMBERED.exec(trimmed);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? "ul" : "ol";
      const raw: string[] = [];
      while (i < lines.length) {
        const line2 = lines[i] ?? "";
        const t = line2.trim();
        const m = kind === "ul" ? BULLET.exec(t) : NUMBERED.exec(t);
        if (m) {
          raw.push(m[1] ?? "");
          i++;
          continue;
        }
        // A hanging-indent continuation belongs to the item above it. Indentation is
        // REQUIRED (markdown's lazy continuation is not supported): without that rule a
        // paragraph written straight after a list, with no blank line, is swallowed by it.
        if (raw.length > 0 && t !== "" && /^\s/.test(line2) && !t.startsWith("```")) {
          raw[raw.length - 1] = `${raw[raw.length - 1]} ${t}`;
          i++;
          continue;
        }
        break;
      }
      i--;
      const items = raw.map(parseInline);
      blocks.push(kind === "ul" ? { kind: "ul", items } : { kind: "ol", items });
      continue;
    }

    para.push(trimmed);
  }
  flushPara();
  return blocks;
}

/** Minimal `key: value` frontmatter. No nesting — these notes need none. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw.replace(/\r\n/g, "\n"));
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    meta[kv[1] ?? ""] = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(m[0].length) };
}

function isReleaseType(v: string): v is ReleaseType {
  return (RELEASE_TYPES as readonly string[]).includes(v);
}

function parseNote(slug: string, raw: string): ReleaseNote {
  const { meta, body } = parseFrontmatter(raw);
  const title = meta.title ?? "";
  const date = meta.date ?? "";
  const type = meta.type ?? "";
  if (!title) throw new Error(`release note ${slug}.md: missing \`title\``);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error(
      `release note ${slug}.md: \`date\` must be YYYY-MM-DD, got ${date || "(none)"}`,
    );
  if (!isReleaseType(type))
    throw new Error(
      `release note ${slug}.md: \`type\` must be one of ${RELEASE_TYPES.join(" / ")}, got ${type || "(none)"}`,
    );
  return {
    slug,
    title,
    type,
    date,
    version: meta.version || undefined,
    summary: meta.summary || undefined,
    tags: (meta.tags ?? "")
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    blocks: parseBlocks(body),
  };
}

let cached: ReleaseNote[] | null = null;

/**
 * Every note, newest first.
 *
 * A malformed file THROWS in development so the author sees it immediately, and is skipped
 * in production — a typo in one note must not take the page down, and a page that silently
 * shows nothing is a worse failure than one entry going missing.
 */
export function listReleaseNotes(): ReleaseNote[] {
  if (cached && process.env.NODE_ENV === "production") return cached;
  let files: string[];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const notes: ReleaseNote[] = [];
  for (const file of files) {
    const slug = file.slice(0, -3);
    try {
      notes.push(parseNote(slug, readFileSync(join(DIR, file), "utf8")));
    } catch (err) {
      if (process.env.NODE_ENV !== "production") throw err;
      console.error(`[release-notes] skipped ${file}:`, err);
    }
  }
  notes.sort((a, b) =>
    a.date === b.date ? b.slug.localeCompare(a.slug) : b.date.localeCompare(a.date),
  );
  cached = notes;
  return notes;
}
