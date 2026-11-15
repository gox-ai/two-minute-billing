/**
 * The source guard: an answer may use the product's source as a reference but never show it.
 *
 * Removed from the answer, whatever the model was told:
 *  - a fenced block with any line that appears in source the turn read;
 *  - an ordinary line (≥ 25 characters) that appears verbatim in that source;
 *  - a file path in the repository (`src/…`, `dashboard/…`, `db/…`);
 *  - a `backticked` camelCase identifier that appears in that source (a function or variable
 *    name). snake_case API field names are documented, so they stay.
 * API examples from the published docs (curl, headers) are not source and stay.
 */

import { maskPans } from "@/platform/logger";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const PATH = /\b(?:src|dashboard|db|scripts)\/[\w./()[\]-]+\.(?:tsx?|sql|json)\b/g;

export interface LeakResult {
  text: string;
  removed: number;
}

export function redactSourceLeaks(answer: string, sources: string[]): LeakResult {
  const corpus = norm(sources.join("\n"));
  const inSource = (line: string) => {
    const l = norm(line);
    return l.length > 0 && corpus.includes(l);
  };
  let removed = 0;
  const out: string[] = [];
  const lines = answer.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      let j = i + 1;
      while (j < lines.length && !/^\s*```/.test(lines[j]!)) j++;
      const block = lines.slice(i + 1, j);
      if (sources.length && block.some((l) => norm(l).length >= 12 && inSource(l))) {
        removed++;
      } else {
        out.push(...lines.slice(i, j + 1));
      }
      i = j;
      continue;
    }
    if (sources.length && norm(line).length >= 25 && inSource(line)) {
      removed++;
      continue;
    }
    out.push(line);
  }
  let text = out.join("\n");
  text = text.replace(PATH, () => {
    removed++;
    return "the product's code";
  });
  if (sources.length) {
    text = text.replace(/`([a-z]+[A-Z][A-Za-z0-9]*)(\(\))?`/g, (m, id: string) => {
      if (!corpus.includes(id)) return m;
      removed++;
      return "an internal step";
    });
  }
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/**
 * The same guard while the answer streams, checked against the source read so far. A line is
 * let through word by word once its start is no longer a run of source text (so the whole line
 * cannot be one), a fenced block once it closes. The whole answer is checked again at the end
 * (`redactSourceLeaks`), which stays the rule.
 */
export class StreamGuard {
  private buf = "";
  /** Characters of the current line already let through. */
  private sent = 0;
  private fence: string[] | null = null;
  private corpus = "";
  private seen = -1;
  constructor(private readonly sources: string[]) {}

  /** Text that is safe to show now. */
  push(delta: string): string {
    if (this.seen !== this.sources.length) {
      this.seen = this.sources.length;
      this.corpus = norm(this.sources.join("\n"));
    }
    this.buf += delta;
    let out = "";
    let at: number;
    while ((at = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, at);
      this.buf = this.buf.slice(at + 1);
      out += this.line(line);
      this.sent = 0;
    }
    return out + this.partial();
  }

  /** What is left at the end of the stream. */
  flush(): string {
    const rest = this.buf;
    this.buf = "";
    let out = rest ? this.line(rest).replace(/\n$/, "") : "";
    this.sent = 0;
    // An unclosed fence is shown only if it is clean.
    if (this.fence) {
      const block = this.check(this.fence.join("\n"));
      this.fence = null;
      out = block + out;
    }
    return out;
  }

  /** Whole words of the open line, once its start is not source text. */
  private partial(): string {
    if (this.fence || !this.buf.trim() || /^\s*`/.test(this.buf)) return "";
    if (this.sent === 0 && this.corpus.includes(norm(this.buf))) return "";
    let end = Math.max(this.buf.lastIndexOf(" "), this.buf.lastIndexOf("\t")) + 1;
    // Never split a `code span`: stop before an open one.
    const ticks = (this.buf.slice(0, end).match(/`/g) ?? []).length;
    if (ticks % 2) end = this.buf.lastIndexOf("`", end - 1);
    if (end <= this.sent) return "";
    const out = this.inline(this.buf.slice(this.sent, end));
    this.sent = end;
    return out;
  }

  private line(line: string): string {
    if (this.fence) {
      this.fence.push(line);
      if (!/^\s*```/.test(line)) return "";
      const block = this.check(this.fence.join("\n"));
      this.fence = null;
      return block ? block + "\n" : "";
    }
    if (this.sent > 0) return this.inline(line.slice(this.sent)) + "\n";
    if (/^\s*```/.test(line)) {
      this.fence = [line];
      return "";
    }
    if (!line.trim()) return line + "\n";
    const r = redactSourceLeaks(line, this.sources);
    if (!r.removed) return line + "\n";
    return r.text ? r.text + "\n" : "";
  }

  /** Paths and source identifiers inside a run of words. */
  private inline(text: string): string {
    let out = text.replace(PATH, "the product's code");
    if (this.sources.length)
      out = out.replace(/`([a-z]+[A-Z][A-Za-z0-9]*)(\(\))?`/g, (m, id: string) =>
        this.corpus.includes(id) ? "an internal step" : m,
      );
    return out;
  }

  private check(block: string): string {
    const r = redactSourceLeaks(block, this.sources);
    return r.removed ? r.text : block;
  }
}

/**
 * The secret guard: text a member sends to our staff (a support request) never carries a
 * credential or a card number, whatever was pasted into it. Removed:
 *  - API keys and webhook secrets (`sk_…`, `rk_…`, `whsec_…`), bearer tokens, JWTs, session
 *    cookies, and `password: …` / `api_key=…` style pairs;
 *  - card numbers (Luhn-valid digit runs), masked to the last four like the logs.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk)_(?:live|test|all|sbox)_[A-Za-z0-9]{6,200}\b/g,
  /\bwhsec_[A-Za-z0-9+/=_-]{8,200}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,500}/gi,
  /\beyJ[A-Za-z0-9_-]{5,2000}\.[A-Za-z0-9_-]{5,2000}\.[A-Za-z0-9_-]{0,2000}/g,
  /\btmb_session=[^;\s]{1,500}/g,
  /\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret|private[_-]?key)(\s*[:=]\s*)["']?[^\s"',;]{4,500}/gi,
];

export function redactSecrets(text: string): LeakResult {
  let removed = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, name?: string, sep?: string) => {
      removed++;
      return typeof name === "string" && typeof sep === "string"
        ? `${name}${sep}[removed]`
        : "[removed]";
    });
  }
  const masked = maskPans(out);
  if (masked !== out) removed++;
  return { text: masked, removed };
}
