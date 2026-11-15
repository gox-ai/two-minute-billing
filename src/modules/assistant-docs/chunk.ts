/**
 * Markdown → searchable sections. Pure: no file or database access.
 *
 * A page splits at its `##` and `###` headings; a long section splits again at paragraph
 * boundaries. MDC component lines (`::name`, `:::`) are dropped and inline components keep
 * only their text, so the index holds what a reader sees.
 */

export interface DocChunk {
  source: "help" | "api" | "engine" | "ui" | "code";
  path: string;
  url: string | null;
  title: string;
  heading: string | null;
  body: string;
  /** Extra search words the body hides (split identifiers, screen labels). */
  terms?: string | null;
  /** Search notes (help): a context sentence, then the phrases people use, one per line. */
  notes?: string | null;
  /** Key of this section's embedding (help and API sections). */
  embedHash?: string | null;
}

const MAX_SECTION = 1600;

export function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (kv && kv[2]) meta[kv[1]!] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

/** Text a reader sees: no MDC component lines or slot markers (`#docs`), no inline component
 * syntax, no HTML comments. */
export function readableMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((l) => !/^\s*:{2,}/.test(l) && !/^#[a-z][\w-]*\s*$/.test(l))
    .join("\n")
    .replace(/:[a-z][\w-]*\{[^}]*\}/g, "")
    .replace(/\[([^\]]+)\]\{[^}]*\}/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Nuxt Content's heading id: lowercase, punctuation out, spaces to hyphens. */
export function headingAnchor(h: string): string {
  return h
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** `help/02.guides/03.recover-failed-payments.md` → `/help/guides/recover-failed-payments`. */
export function contentPathToUrl(rel: string): string {
  const parts = rel
    .replace(/\.md$/, "")
    .split("/")
    .map((p) => p.replace(/^\d+\./, ""));
  if (parts[parts.length - 1] === "index") parts.pop();
  return `/${parts.join("/")}`;
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_SECTION) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\n+/)) {
    if (cur && cur.length + para.length + 2 > MAX_SECTION) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${para}` : para.slice(0, MAX_SECTION * 2);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A generated API reference page: its operation (`::api-operation{method path}`) becomes the
 * opening text, and the example responses are dropped (sample JSON, not documentation).
 */
function apiPage(body: string, title: string): { lead: string | null; body: string } {
  const op = /::api-operation\{method="(\w+)" path="([^"]+)"\}/.exec(body);
  const trimmed = body.replace(/^#response\s*$[\s\S]*$/m, "");
  if (!op) return { lead: null, body: trimmed };
  const seo = /^seo:\n(?:\s+.*\n)*?\s+description:\s*"?(.*?)"?\s*$/m.exec(body)?.[1] ?? "";
  // The request fields belong with the operation: "what does X take" is the common question.
  const fields = /^## Body\s*$([\s\S]*?)(?=^## )/m.exec(trimmed)?.[1]?.trim() ?? "";
  const lead = `${op[1]} ${op[2]}\n${title}. ${seo}${fields ? `\n\nRequest body:\n${fields}` : ""}`;
  return { lead: lead.trim(), body: trimmed };
}

export function chunkMarkdown(
  md: string,
  opts: { source: DocChunk["source"]; path: string; url: string | null; fallbackTitle: string },
): DocChunk[] {
  const parsed = parseFrontmatter(md);
  const meta = parsed.meta;
  const api = opts.source === "api" ? apiPage(md, meta.title || opts.fallbackTitle) : null;
  const text = readableMarkdown(api ? parseFrontmatter(api.body).body : parsed.body);
  const firstH1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const title = meta.title || firstH1 || opts.fallbackTitle;
  const chunks: DocChunk[] = [];
  const push = (heading: string | null, sectionBody: string) => {
    const clean = sectionBody.replace(/^#\s+.+$/m, "").trim();
    if (!clean && !heading) return;
    for (const piece of splitLong(clean || heading || "")) {
      chunks.push({
        source: opts.source,
        path: opts.path,
        url: opts.url && heading ? `${opts.url}#${headingAnchor(heading)}` : opts.url,
        title,
        heading,
        body: piece,
      });
    }
  };
  const lines = text.split("\n");
  let heading: string | null = null;
  let buf: string[] = api?.lead ? [api.lead] : meta.description ? [meta.description] : [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence ? /^#{2,3}\s+(.+)$/.exec(line) : null;
    if (h) {
      push(heading, buf.join("\n"));
      heading = h[1]!.replace(/[`*]/g, "").trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  push(heading, buf.join("\n"));
  return chunks;
}
