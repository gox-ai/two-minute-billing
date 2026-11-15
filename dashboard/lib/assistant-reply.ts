// Billy's replies and composer, the pure parts: the markdown blocks an answer is drawn from,
// its plain-text copy, table layout, the slash menu's trigger and filter, and the step
// summary. Relative imports only: root unit tests load it.

export type Align = "left" | "right";

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][]; align: Align[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "quote"; text: string }
  | { kind: "para"; text: string };

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*(\d{1,4})[.)]\s+/;
const ROW = /^\s*\|.*\|\s*$/;
const DIVIDER = /^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;

const cellsOf = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

const startsBlock = (l: string, next: string | undefined) =>
  FENCE.test(l) ||
  HEADING.test(l) ||
  QUOTE.test(l) ||
  BULLET.test(l) ||
  NUMBERED.test(l) ||
  RULE.test(l) ||
  (ROW.test(l) && next !== undefined && DIVIDER.test(next));

/** "$1,204.00", "−₹12.50", "18%", "1,204", "42 USD": a figure, so its column aligns right. */
const FIGURE =
  /^[−+-]?\s?(?:[A-Z]{3}\s|[A-Z]{0,2}[^\p{L}\d\s]{1,2})?\s?\d[\d,.\s]*(?:%|\s?[A-Z]{3})?$/u;
const EMPTY_CELL = /^(?:—|–|-|n\/a)?$/i;

export function isFigure(cell: string): boolean {
  return FIGURE.test(plainInline(cell).trim());
}

/** Right-align a column whose head row says so, or whose every filled cell is a figure. */
export function columnAlign(divider: string[], rows: string[][], cols: number): Align[] {
  return Array.from({ length: cols }, (_, j) => {
    const d = divider[j] ?? "";
    if (/^\s*-+:\s*$/.test(d)) return "right";
    if (/^\s*:-+\s*$/.test(d) || /^\s*:-+:\s*$/.test(d)) return "left";
    const filled = rows
      .map((r) => plainInline(r[j] ?? "").trim())
      .filter((c) => !EMPTY_CELL.test(c));
    return filled.length > 0 && filled.every((c) => FIGURE.test(c)) ? "right" : "left";
  });
}

/** Four columns or more do not fit a 320px panel: that table scrolls with its first column held. */
export const WIDE_TABLE_COLUMNS = 4;
export const isWideTable = (head: string[]) => head.length >= WIDE_TABLE_COLUMNS;

/** The answer's markdown as blocks. An unclosed fence (still streaming) is code to the end. */
export function parseAnswer(md: string): Block[] {
  const lines = md.replace(/\r/g, "").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || RULE.test(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ kind: "code", lang: fence[1] || null, text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(lines[i++]!.replace(QUOTE, ""));
      out.push({ kind: "quote", text: body.join(" ").trim() });
      continue;
    }
    const num = NUMBERED.exec(line);
    if (num || BULLET.test(line)) {
      const ordered = !!num;
      const marker = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (marker.test(l)) items.push(l.replace(marker, ""));
        // An indented line under an item carries on that item.
        else if (items.length && /^\s{2,}\S/.test(l) && !startsBlock(l, lines[i + 1]))
          items[items.length - 1] += ` ${l.trim()}`;
        else break;
        i++;
      }
      out.push({ kind: "list", ordered, start: ordered ? Number(num![1]) : 1, items });
      continue;
    }
    if (ROW.test(line) && i + 1 < lines.length && DIVIDER.test(lines[i + 1]!)) {
      const head = cellsOf(line);
      const divider = cellsOf(lines[i + 1]!);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && ROW.test(lines[i]!)) {
        const r = cellsOf(lines[i++]!);
        rows.push(Array.from({ length: head.length }, (_, j) => r[j] ?? ""));
      }
      out.push({ kind: "table", head, rows, align: columnAlign(divider, rows, head.length) });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      (!para.length || !startsBlock(lines[i]!, lines[i + 1]))
    ) {
      para.push(lines[i++]!.trim());
    }
    out.push({ kind: "para", text: para.join(" ") });
  }
  return out;
}

/** Inline marks off: **bold**, `code` and [label](url) read as their text. */
export function plainInline(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1");
}

/** A table as tab-separated lines, so it pastes into a spreadsheet as cells. */
export function tableText(head: string[], rows: string[][]): string {
  return [head, ...rows].map((r) => r.map((c) => plainInline(c)).join("\t")).join("\n");
}

/** The answer as plain text for the clipboard: no marks, tables tab-separated. */
export function answerPlainText(md: string): string {
  return parseAnswer(md)
    .map((b) => {
      switch (b.kind) {
        case "heading":
        case "quote":
        case "para":
          return plainInline(b.text);
        case "code":
          return b.text;
        case "list":
          return b.items
            .map((it, j) => `${b.ordered ? `${b.start + j}.` : "-"} ${plainInline(it)}`)
            .join("\n");
        case "table":
          return tableText(b.head, b.rows);
      }
    })
    .join("\n\n");
}

// ── Composer ─────────────────────────────────────────────────────────────────────

/** The slash menu opens on "/" at the start of a line, after spaces at most. */
const SLASH = /(?:^|\n)[ \t]*\/([^\n/]{0,40})$/;

/** The text typed after the "/" before the caret, or null when the menu is not open. */
export function slashQuery(beforeCaret: string): string | null {
  const m = SLASH.exec(beforeCaret);
  return m ? m[1]! : null;
}

/** The text before the caret without the "/query" that opened the menu. */
export function dropSlash(beforeCaret: string): string {
  return beforeCaret.replace(/(^|\n)[ \t]*\/[^\n/]{0,40}$/, "$1");
}

/** Every typed word starts a word of the label or of its keywords. */
export function filterCommands<T extends { label: string; keywords?: string[] }>(
  items: T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((it) => {
    const own = [it.label, ...(it.keywords ?? [])]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    return words.every((w) => own.some((o) => o.startsWith(w)));
  });
}

export const MESSAGE_MAX_CHARS = 4000;
/** The count shows from here on, not before. */
export const CHARS_WARN_AT = 3600;

/** "312 characters left" once the question is close to the limit, else null. */
export function charsLeftNote(length: number, max = MESSAGE_MAX_CHARS, warnAt = CHARS_WARN_AT) {
  if (length < warnAt) return null;
  const left = Math.max(0, max - length);
  return left === 1 ? "1 character left" : `${left.toLocaleString("en-US")} characters left`;
}

// ── Steps and turns ──────────────────────────────────────────────────────────────

/** "Used 3 steps" or "Used 3 steps, 1 failed". */
export function stepsSummary(steps: Array<{ phase: string }>): string {
  const n = steps.length;
  const failed = steps.filter((s) => s.phase === "error").length;
  const used = `Used ${n} ${n === 1 ? "step" : "steps"}`;
  return failed ? `${used}, ${failed} failed` : used;
}

/**
 * Questions with no answer after them: a turn that failed or stopped is not stored, so a
 * reloaded chat holds the question alone.
 */
export function unansweredQuestions(messages: Array<{ role: string }>): Set<number> {
  const out = new Set<number>();
  messages.forEach((m, i) => {
    if (m.role === "user" && messages[i + 1]?.role !== "assistant") out.add(i);
  });
  return out;
}
