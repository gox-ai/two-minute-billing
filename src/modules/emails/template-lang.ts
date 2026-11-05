/**
 * The merge language for merchant-editable email text.
 *
 *   {{customerName}}                        a value
 *   {{customerName | default: "there"}}     a value, or the fallback when it is empty
 *   {{#if invoiceNumber}}…{{else}}…{{/if}}  a section shown only when the value is present
 *   {{#unless invoiceNumber}}…{{/unless}}   the inverse
 *
 * Deliberately no expressions, loops or helpers: this is billing mail, and every construct
 * here has to be explainable in the editor in one line.
 *
 * ## Security order (body)
 *
 *     sanitize(template) → evaluate sections → sanitize again → fill values (escaped)
 *
 * Sections decide on PRESENCE only and never insert a value, so evaluating them before the
 * fill cannot let a customer-supplied value reach the sanitiser as markup. The second
 * sanitise re-balances anything a section removal left open.
 */
import { escapeHtml, sanitizeEmailHtml } from "./sanitize";

export type TemplateField = "subject" | "heading" | "body" | "footer" | "cta_label";

export interface TemplateIssue {
  field: TemplateField;
  severity: "error" | "warning";
  message: string;
}

type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; key: string; fallback?: string }
  | { kind: "section"; negate: boolean; key: string; then: Node[]; else: Node[] };

/** Any `{{…}}`. What it contains decides whether it is a token or a syntax error. */
const ANY_TAG = /\{\{([^{}]*)\}\}/g;
const VAR_RE = /^\s*(\w+)\s*(?:\|\s*default:\s*"([^"{}<>]*)"\s*)?$/;
const OPEN_RE = /^\s*#(if|unless)\s+(\w+)\s*$/;
const ELSE_RE = /^\s*else\s*$/;
const CLOSE_RE = /^\s*\/(if|unless)\s*$/;

interface Parsed {
  nodes: Node[];
  errors: string[];
}

export function parseTemplate(src: string): Parsed {
  const errors: string[] = [];
  const root: Node[] = [];
  const stack: Array<{
    node: Extract<Node, { kind: "section" }>;
    inElse: boolean;
    word: "if" | "unless";
  }> = [];
  const sink = (): Node[] => {
    const top = stack.at(-1);
    return top ? (top.inElse ? top.node.else : top.node.then) : root;
  };

  let last = 0;
  for (const m of src.matchAll(ANY_TAG)) {
    const at = m.index!;
    if (at > last) sink().push({ kind: "text", text: src.slice(last, at) });
    last = at + m[0].length;
    const inner = m[1]!;
    let r: RegExpMatchArray | null;
    if ((r = inner.match(OPEN_RE))) {
      const node = {
        kind: "section" as const,
        negate: r[1] === "unless",
        key: r[2]!,
        then: [] as Node[],
        else: [] as Node[],
      };
      sink().push(node);
      stack.push({ node, inElse: false, word: r[1] as "if" | "unless" });
    } else if (ELSE_RE.test(inner)) {
      const top = stack.at(-1);
      if (!top) errors.push("{{else}} has no {{#if}} before it.");
      else if (top.inElse) errors.push(`{{#${top.word} ${top.node.key}}} has two {{else}}s.`);
      else top.inElse = true;
    } else if ((r = inner.match(CLOSE_RE))) {
      const top = stack.at(-1);
      if (!top) errors.push(`{{/${r[1]}}} has no {{#${r[1]}}} before it.`);
      else if (top.word !== r[1])
        errors.push(
          `{{/${r[1]}}} closes {{#${top.word} ${top.node.key}}}. Use the matching closing tag.`,
        );
      else stack.pop();
    } else if ((r = inner.match(VAR_RE))) {
      sink().push({ kind: "var", key: r[1]!, ...(r[2] !== undefined ? { fallback: r[2] } : {}) });
    } else {
      errors.push(`We could not read ${m[0]}.`);
      sink().push({ kind: "text", text: m[0] });
    }
  }
  if (last < src.length) sink().push({ kind: "text", text: src.slice(last) });
  for (const open of stack.reverse()) {
    errors.push(`{{#${open.word} ${open.node.key}}} is never closed with {{/${open.word}}}.`);
  }
  return { nodes: root, errors };
}

type Vars = Record<string, unknown>;
const present = (vars: Vars, key: string): boolean => {
  const v = vars[key];
  return typeof v === "string" ? v.trim() !== "" : v != null && v !== false;
};

/** Resolve sections, leaving value tokens in place for the fill. */
function resolveSections(nodes: Node[], vars: Vars): string {
  return nodes
    .map((n) => {
      if (n.kind === "text") return n.text;
      if (n.kind === "var")
        return n.fallback === undefined
          ? `{{${n.key}}}`
          : `{{${n.key} | default: "${n.fallback}"}}`;
      const show = present(vars, n.key) !== n.negate;
      return resolveSections(show ? n.then : n.else, vars);
    })
    .join("");
}

function fillValues(src: string, vars: Vars, escape: boolean): string {
  return src.replace(ANY_TAG, (whole, inner: string) => {
    const r = inner.match(VAR_RE);
    if (!r) return whole;
    const v = vars[r[1]!];
    const s = typeof v === "string" ? v : "";
    // In a body, a line break inside a value stays a line break.
    if (s.trim() !== "") return escape ? escapeHtml(s).replace(/\r?\n/g, "<br>") : s;
    // A fallback is template text, not a value: in the body it has already been through
    // the sanitiser (and cannot hold `<`/`>`), so it is emitted as-is.
    return r[2] ?? "";
  });
}

/**
 * In a rich-text body a section marker usually sits alone in its own paragraph (or line),
 * so the section wraps whole paragraphs. Drop that wrapper so hiding a section does not
 * leave an empty paragraph or a blank line behind.
 */
const MARKER = String.raw`\{\{\s*(?:#(?:if|unless)\s+\w+|else|\/(?:if|unless))\s*\}\}`;
const MARKER_PARA = new RegExp(String.raw`<p>\s*(${MARKER})\s*</p>`, "g");
const MARKER_LINE = new RegExp(String.raw`(^|<br>)(${MARKER})<br>`, "g");
function unwrapMarkers(html: string): string {
  return html.replace(MARKER_PARA, "$1").replace(MARKER_LINE, "$1$2");
}

/** Plain text: subject, heading, button label. The caller escapes where it lands. */
export function renderText(src: string, vars: Vars): string {
  const { nodes } = parseTemplate(src);
  return fillValues(resolveSections(nodes, vars), vars, false);
}

/** The HTML body. See the security order in the file header. */
export function renderBody(src: string, vars: Vars): string {
  const clean = unwrapMarkers(sanitizeEmailHtml(src));
  const { nodes } = parseTemplate(clean);
  return dropEmptyLines(fillValues(sanitizeEmailHtml(resolveSections(nodes, vars)), vars, true));
}

/**
 * A line or paragraph that held only an empty value disappears instead of leaving a gap, so
 * `{{note}}` on its own line needs no `{{#if}}`: empty paragraphs go, runs of breaks shrink
 * to one blank line, and breaks at either end are trimmed.
 */
function dropEmptyLines(html: string): string {
  return html
    .replace(/<p>(?:\s|<br>)*<\/p>/g, "")
    .replace(/(?:<br>\s*){3,}/g, "<br><br>")
    .replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, "");
}

/** A value alone on its line or in its paragraph: `dropEmptyLines` removes it when empty. */
const LINE_START = /(?:^|\n|<br>|<p>)\s*$/;
const LINE_END = /^\s*(?:$|\n|<br>|<\/p>)/;
function standaloneVars(nodes: Node[]): Set<Node> {
  const out = new Set<Node>();
  nodes.forEach((n, i) => {
    if (n.kind === "section") {
      standaloneVars(n.then).forEach((x) => out.add(x));
      standaloneVars(n.else).forEach((x) => out.add(x));
      return;
    }
    if (n.kind !== "var") return;
    const prev = nodes[i - 1];
    const next = nodes[i + 1];
    const before = !prev || (prev.kind === "text" && LINE_START.test(prev.text));
    const after = !next || (next.kind === "text" && LINE_END.test(next.text));
    if (before && after) out.add(n);
  });
  return out;
}

/** Tag balance of a sanitised fragment — a section must not open a tag it doesn't close. */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)(p|h1|h2|ul|ol|li|a|b|strong|i|em|u)\b[^>]*>/g)) {
    if (!m[1]) stack.push(m[2]!);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

function* walk(nodes: Node[], guards: Set<string>): Generator<[Node, Set<string>]> {
  for (const n of nodes) {
    yield [n, guards];
    if (n.kind === "section") {
      // Inside `{{#if x}}` the value is known present; inside its else / an unless it is not.
      yield* walk(n.then, n.negate ? guards : new Set([...guards, n.key]));
      yield* walk(n.else, n.negate ? new Set([...guards, n.key]) : guards);
    }
  }
}

/**
 * Everything wrong with one field, for the editor and for save.
 *
 * Errors block a save: syntax the engine cannot read, a variable this email never has, a
 * section that would break the formatting around it. Warnings do not: a sometimes-empty
 * variable used bare is legal, but it is how "invoice  for $10" ships.
 */
export function checkField(
  field: TemplateField,
  src: string,
  vars: ReadonlyArray<{ key: string; always: boolean }>,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const err = (message: string) => issues.push({ field, severity: "error", message });
  const html = field === "body" || field === "footer";
  const { nodes, errors } = parseTemplate(html ? unwrapMarkers(sanitizeEmailHtml(src)) : src);
  errors.forEach(err);
  const byKey = new Map(vars.map((v) => [v.key, v]));
  const unknown = new Set<string>();
  const loose = new Set<string>();
  const alone = html ? standaloneVars(nodes) : new Set<Node>();
  for (const [n, guards] of walk(nodes, new Set())) {
    if (n.kind === "text") continue;
    if (!byKey.has(n.key)) {
      unknown.add(n.key);
      continue;
    }
    if (n.kind === "section") {
      if (html && (!balanced(sectionHtml(n.then)) || !balanced(sectionHtml(n.else))))
        err(
          `The {{#${n.negate ? "unless" : "if"} ${n.key}}} section starts and ends in different paragraphs or formatting. Put each marker on a line of its own, or keep both inside one paragraph.`,
        );
      continue;
    }
    if (
      !byKey.get(n.key)!.always &&
      n.fallback === undefined &&
      !guards.has(n.key) &&
      !alone.has(n)
    )
      loose.add(n.key);
  }
  if (unknown.size) {
    err(
      `${[...unknown].map((k) => `{{${k}}}`).join(", ")} ${unknown.size === 1 ? "is not" : "are not"} available in this email.`,
    );
  }
  for (const k of loose) {
    issues.push({
      field,
      severity: "warning",
      message: `{{${k}}} is sometimes empty. Put it on a line of its own, give it a fallback, or wrap it in {{#if ${k}}}…{{/if}}. We remove a line that is empty.`,
    });
  }
  return issues;
}

/** The markup a section branch contributes, with nested sections fully expanded. */
function sectionHtml(nodes: Node[]): string {
  return nodes
    .map((n) =>
      n.kind === "text"
        ? n.text
        : n.kind === "var"
          ? ""
          : sectionHtml(n.then) + sectionHtml(n.else),
    )
    .join("");
}
