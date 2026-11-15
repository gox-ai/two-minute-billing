/**
 * Source files → searchable sections, for the assistant to CHECK how the product behaves.
 * Pure: no file or database access. The assistant never shows these to a member (see
 * `assistant/leaks.ts`); they are a reference, not an answer.
 *
 * A file splits at its top-level declarations and route registrations; a long section splits
 * again at blank lines. `terms` adds what full-text search cannot see in code: identifiers
 * split into words (`createApiKey` → "create api key") and string literals (labels, messages).
 */
import type { DocChunk } from "./chunk";

const MAX = 2000;
const BOUNDARY =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)|^\s{0,4}(?:app|instance|form)\.(get|post|put|patch|delete|route)\(\s*["'`]([^"'`]+)/;

/** `createApiKey`, `api_key_id` → "create api key", "api key id". */
export function splitIdentifier(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_$-]+/g, " ")
    .toLowerCase()
    .trim();
}

export function codeTerms(text: string): string {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g)) {
    if (/[A-Z_]/.test(m[0].slice(1))) ids.add(splitIdentifier(m[0]));
  }
  const strings = [...text.matchAll(/["'`]([^"'`\n]{3,120})["'`]/g)]
    .map((m) => m[1]!)
    .filter((s) => /[a-z]/i.test(s) && !/^[./@]/.test(s));
  return [...ids, ...new Set(strings)].join(" ").slice(0, 4000);
}

export function chunkSource(path: string, text: string): DocChunk[] {
  const lines = text.split("\n");
  const sections: Array<{ name: string | null; lines: string[] }> = [{ name: null, lines: [] }];
  for (const line of lines) {
    const m = BOUNDARY.exec(line);
    if (m) sections.push({ name: m[1] ?? `${m[2]!.toUpperCase()} ${m[3]}`, lines: [line] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  const out: DocChunk[] = [];
  // Small neighbours merge, so a file of one-liners is not a thousand sections.
  let pending: { name: string | null; text: string } | null = null;
  const flush = (s: { name: string | null; text: string }) => {
    const body = s.text.trim();
    if (!body) return;
    for (let i = 0; i < body.length;) {
      let end = Math.min(body.length, i + MAX);
      if (end < body.length) {
        const cut = body.lastIndexOf("\n\n", end);
        if (cut > i + MAX / 2) end = cut;
      }
      const piece = body.slice(i, end).trim();
      out.push({
        source: "code",
        path,
        url: null,
        title: path,
        heading: s.name,
        body: piece,
        terms: codeTerms(piece),
      });
      i = end;
    }
  };
  for (const s of sections) {
    const t = s.lines.join("\n");
    if (pending && pending.text.length + t.length < MAX / 2) {
      pending = { name: pending.name ?? s.name, text: `${pending.text}\n${t}` };
      continue;
    }
    if (pending) flush(pending);
    pending = { name: s.name, text: t };
  }
  if (pending) flush(pending);
  return out;
}

/** Published source that helps the assistant check a flow. Tests, generated files and huge tables stay out. */
export function isIndexedSource(rel: string): boolean {
  if (!/\.(ts|tsx)$/.test(rel) || /\.d\.ts$/.test(rel)) return false;
  if (/(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.tsx?$/.test(rel)) return false;
  if (/generated/.test(rel)) return false;
  // Names the system it imports from by design; kept out so answers never echo it.
  if (rel.startsWith("src/modules/migration/")) return false;
  if (rel === "src/api/openapi.ts" || rel.startsWith("src/api/openapi-")) return false;
  return /^(src|dashboard\/(app|components|lib))\//.test(rel) || /^db\/schema\//.test(rel);
}
