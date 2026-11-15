/**
 * Builds the docs index from the files on disk: help pages and API reference pages
 * (`docs-site/content/help`), and the module READMEs (`src/modules/*\/README.md`).
 *
 * Rebuilt only when the content hash changes, inside one transaction under an advisory
 * lock, so two API processes starting together build it once and a reader never sees a
 * half-built index. A directory that is not on disk (a slim image) is skipped.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { assistantDocChunks, assistantDocIndex } from "@db/schema";
import { clearSearchCache } from "./search";
import { chunkMarkdown, contentPathToUrl, type DocChunk } from "./chunk";
import { chunkSource, isIndexedSource } from "./code";
import { EMBED_SETTINGS, embedHash } from "./vectors";

const log = createLogger("assistant-docs");

export const HELP_ORIGIN = "https://twominutebilling.com";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function walk(dir: string, out: string[] = [], ext = /\.md$/): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out, ext);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

export interface SourceFile {
  source: DocChunk["source"];
  rel: string;
  text: string;
  url: string | null;
}

export function collectSources(root = ROOT): SourceFile[] {
  const files: SourceFile[] = [];
  const content = join(root, "docs-site/content");
  for (const abs of walk(join(content, "help")).sort()) {
    const rel = relative(content, abs);
    files.push({
      source: rel.includes("/50.api-reference/") ? "api" : "help",
      rel,
      text: readFileSync(abs, "utf8"),
      url: `${HELP_ORIGIN}${contentPathToUrl(rel)}`,
    });
  }
  const modules = join(root, "src/modules");
  if (existsSync(modules)) {
    for (const name of readdirSync(modules).sort()) {
      const abs = join(modules, name, "README.md");
      if (existsSync(abs)) {
        files.push({
          source: "engine",
          rel: `src/modules/${name}/README.md`,
          text: readFileSync(abs, "utf8"),
          url: null,
        });
      }
    }
  }
  // The dashboard map: one section per screen.
  const map = join(root, "src/modules/assistant-docs/dashboard-map.generated.json");
  if (existsSync(map))
    files.push({ source: "ui", rel: "dashboard-map", text: readFileSync(map, "utf8"), url: null });
  // The published source, to check how the product behaves. Never shown to a member.
  for (const dir of [
    "src",
    "dashboard/app",
    "dashboard/components",
    "dashboard/lib",
    "db/schema",
  ]) {
    for (const abs of walk(join(root, dir), [], /\.tsx?$/).sort()) {
      const rel = relative(root, abs);
      if (isIndexedSource(rel))
        files.push({ source: "code", rel, text: readFileSync(abs, "utf8"), url: null });
    }
  }
  return files;
}

interface MapScreen {
  route: string;
  scope: "biz" | "org";
  label: string;
  section: string;
  controls: string[];
  /** Controls by the card they sit in (null = outside any card). Absent in an older map. */
  groups?: Array<{ title: string | null; controls: string[] }>;
}

/** A card with fewer controls shares a section with its neighbours; a bigger one splits. */
const SCREEN_MIN = 6;
const SCREEN_MAX = 40;

/**
 * Screen sections, one per card: where the screen is, which card, and its controls. A card is
 * what a member sees as one place ("Subscription configurations"), so its controls embed and
 * rank together, and find_screen can name the card.
 */
export function screenChunks(json: string): DocChunk[] {
  return (JSON.parse(json) as MapScreen[]).flatMap((s) => {
    // `first`: the card the section opens with (null = page-level controls), for its heading.
    const parts: Array<{ first: string | null; cards: string[]; controls: string[] }> = [];
    for (const g of s.groups ?? [{ title: null, controls: s.controls }]) {
      for (let i = 0; i < Math.max(1, g.controls.length); i += SCREEN_MAX) {
        const piece = g.controls.slice(i, i + SCREEN_MAX);
        const prev = parts.at(-1);
        if (
          prev &&
          (prev.controls.length < SCREEN_MIN || piece.length < SCREEN_MIN) &&
          prev.controls.length + piece.length <= SCREEN_MAX
        ) {
          if (g.title && !prev.cards.includes(g.title)) prev.cards.push(g.title);
          prev.controls.push(...piece);
        } else parts.push({ first: g.title, cards: g.title ? [g.title] : [], controls: piece });
      }
    }
    return parts.map(({ first, cards, controls }) => ({
      source: "ui" as const,
      path: s.route,
      url: s.route,
      title: `${s.section} › ${s.label}`,
      heading: first ? `${s.label} › ${first}` : s.label,
      body: `Screen: ${s.label}\nIn: ${s.section}\nPath: ${s.route}\n${cards.length ? `Cards: ${cards.join(" · ")}\n` : ""}On this screen: ${controls.join(" · ") || "(no labelled controls)"}`,
      terms: [s.label, s.section, ...cards, ...controls].join(" "),
    }));
  });
}

/** Bump when chunking changes, so the index rebuilds even if no document changed. */
const INDEX_VERSION = "6";

export function contentHash(files: SourceFile[], notes = ""): string {
  const h = createHash("sha256").update(`v${INDEX_VERSION}\0${EMBED_SETTINGS}\0`);
  for (const f of files) h.update(f.rel).update("\0").update(f.text).update("\0");
  return h.update(notes).digest("hex");
}

/**
 * Search notes per help section (`section-notes.json`): one sentence placing the section in its
 * page, and the words people use when this section is their answer ("emails keep bouncing").
 * They go into `notes`, so a member's own wording finds a section whose text never uses it.
 * Written once per docs change by `scripts/docs-section-notes.ts`; a section without a note
 * is still indexed, from its own text.
 */
export interface SectionNote {
  context: string;
  asks: string[];
  /** Hash of the section text the note was written for; a mismatch means the note is stale. */
  hash?: string;
}
export type SectionNotes = Record<string, SectionNote>;

const NOTES_FILE = "src/modules/assistant-docs/section-notes.json";

export function readSectionNotes(root = ROOT): { text: string; notes: SectionNotes } {
  const abs = join(root, NOTES_FILE);
  if (!existsSync(abs)) return { text: "", notes: {} };
  const text = readFileSync(abs, "utf8");
  return { text, notes: JSON.parse(text) as SectionNotes };
}

/**
 * A noted section's stable key: a help section's URL under /help/, a screen section's
 * `screen:<route>`; `~n` for the nth section sharing it.
 */
export function sectionKeys(chunks: DocChunk[]): Array<string | null> {
  const seen = new Map<string, number>();
  return chunks.map((c) => {
    if ((c.source !== "help" && c.source !== "ui") || !c.url) return null;
    const base =
      c.source === "ui" ? `screen:${c.url}` : c.url.replace(/^https?:\/\/[^/]+\/help\/?/, "");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}~${n}` : base;
  });
}

/** The text a note was written for, hashed so a changed section shows as stale. */
export function sectionHash(c: Pick<DocChunk, "heading" | "body">): string {
  return createHash("sha256")
    .update(`${c.heading ?? ""}\0${c.body}`)
    .digest("hex")
    .slice(0, 12);
}

function applyNotes(chunks: DocChunk[], notes: SectionNotes): DocChunk[] {
  const keys = sectionKeys(chunks);
  return chunks.map((c, i) => {
    const n = keys[i] ? notes[keys[i]!] : undefined;
    if (!n) return c;
    return { ...c, notes: [n.context, ...n.asks].filter(Boolean).join("\n") };
  });
}

/** Module READMEs: the reader-facing parts only, not the changelog. */
function engineText(text: string): string {
  return text.split(/^## Changelog\b/m)[0]!;
}

/** Postgres text cannot hold NUL; a source file can (a binary-ish fixture, a test vector). */
const NUL = String.fromCharCode(0);
const strip = (s: string) => s.replaceAll(NUL, "");
const noNul = (c: DocChunk): DocChunk => ({
  ...c,
  body: strip(c.body),
  terms: c.terms == null ? null : strip(c.terms),
  notes: c.notes == null ? null : strip(c.notes),
  heading: c.heading == null ? null : strip(c.heading),
});

export function buildChunks(files: SourceFile[], notes: SectionNotes = {}): DocChunk[] {
  return applyNotes(buildRaw(files), notes)
    .map(noNul)
    .map((c) => ({ ...c, embedHash: embedHash(c) }));
}

function buildRaw(files: SourceFile[]): DocChunk[] {
  return files.flatMap((f) =>
    f.source === "ui"
      ? screenChunks(f.text)
      : f.source === "code"
        ? chunkSource(f.rel, f.text)
        : chunkMarkdown(f.source === "engine" ? engineText(f.text) : f.text, {
            source: f.source,
            path: f.rel,
            url: f.url,
            fallbackTitle: f.rel.split("/").slice(-2, -1)[0] ?? f.rel,
          }),
  );
}

/** Rebuild the index if the content changed. Returns what it did. */
export async function ensureDocsIndex(root = ROOT): Promise<{ rebuilt: boolean; chunks: number }> {
  const files = collectSources(root);
  const notes = readSectionNotes(root);
  const hash = contentHash(files, notes.text);
  const [state] = await systemDb
    .select()
    .from(assistantDocIndex)
    .where(eq(assistantDocIndex.id, 1));
  if (state?.contentHash === hash) return { rebuilt: false, chunks: state.chunks };
  const chunks = buildChunks(files, notes.notes);
  const rebuilt = await systemDb.transaction(async (tx) => {
    const [lock] = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtext('assistant_docs_index')) as ok`,
    )) as unknown as Array<{ ok: boolean }>;
    if (!lock?.ok) return false;
    const [again] = await tx.select().from(assistantDocIndex).where(eq(assistantDocIndex.id, 1));
    if (again?.contentHash === hash) return false;
    await tx.delete(assistantDocChunks);
    for (let i = 0; i < chunks.length; i += 500) {
      const batch = chunks.slice(i, i + 500);
      try {
        await tx.insert(assistantDocChunks).values(batch);
      } catch (e) {
        // The driver's message is the whole query; say which section and why instead.
        const cause =
          (e as { cause?: { message?: string } }).cause?.message ?? String(e).slice(0, 200);
        throw new Error(`docs index: a batch from ${batch[0]!.path} failed: ${cause}`);
      }
    }
    await tx
      .insert(assistantDocIndex)
      .values({ id: 1, contentHash: hash, chunks: chunks.length, indexedAt: new Date() })
      .onConflictDoUpdate({
        target: assistantDocIndex.id,
        set: { contentHash: hash, chunks: chunks.length, indexedAt: new Date() },
      });
    return true;
  });
  if (rebuilt) clearSearchCache();
  if (rebuilt)
    log.info("docs index rebuilt", {
      event: "assistant_docs_indexed",
      chunks: chunks.length,
      files: files.length,
    });
  return { rebuilt, chunks: chunks.length };
}
