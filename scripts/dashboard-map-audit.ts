/**
 * Audits the dashboard map screen by screen, independently of how the generator walked it:
 *
 * - chrome: no control is read only from the screen's breadcrumb or page title;
 * - headings: no control is read only from a heading (a card or section title);
 * - code: no control is a CSS class string or an identifier;
 * - rendered: every control's words are in a file the screen renders (the page, the files it
 *   imports and uses, three levels down) or in the catalogue its `data-map-options` names.
 *
 * Run by `verify:dashboard-map`; the rules are pinned by test/unit/dashboard-map-audit.test.ts.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "@babel/parser";
import { OPTION_SOURCES, codeLike, type LabelKind, type Screen } from "./generate-dashboard-map";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DASH = join(ROOT, "dashboard");

export interface Finding {
  route: string;
  rule: "chrome" | "heading" | "code" | "rendered";
  label: string;
}

type Node = { type: string; [k: string]: unknown };

function resolveSpec(from: string, spec: string): string | undefined {
  if (!/^(@\/|\.{1,2}\/)/.test(spec)) return undefined;
  const base = spec.startsWith("@/") ? join(DASH, spec.slice(2)) : resolve(dirname(from), spec);
  return [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")].find(
    (c) => existsSync(c) && statSync(c).isFile(),
  );
}

const textCache = new Map<string, { text: string; deps: string[] }>();
/** A file's text, and the files it imports AND uses outside its import lines. */
function read(file: string): { text: string; deps: string[] } {
  const hit = textCache.get(file);
  if (hit) return hit;
  const text = readFileSync(file, "utf8");
  const ast = parse(text, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    errorRecovery: true,
  }) as unknown as { program: { body: Node[] } };
  const body = ast.program.body;
  const code = body
    .filter((d) => d.type !== "ImportDeclaration")
    .map((d) => text.slice(d.start as number, d.end as number))
    .join("\n");
  const deps: string[] = [];
  for (const d of body) {
    if (d.type !== "ImportDeclaration") continue;
    const target = resolveSpec(file, (d.source as Node).value as string);
    if (!target) continue;
    const used = (d.specifiers as Node[]).some((sp) =>
      new RegExp(`\\b${(sp.local as Node).name as string}\\b`).test(code),
    );
    if (used) deps.push(target);
  }
  const out = { text, deps };
  textCache.set(file, out);
  return out;
}

/** The text of every file a page renders or reads, `depth` imports down. */
export function renderedText(page: string, depth = 3): string {
  const seen = new Set<string>();
  let level = [page];
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = [];
    for (const f of level) {
      if (seen.has(f)) continue;
      seen.add(f);
      next.push(...read(f).deps);
    }
    level = next;
  }
  return [...seen].map((f) => read(f).text).join("\n");
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** True when the label, or every word of it (a label built from a template), is in `text`. */
export function inText(label: string, text: string): boolean {
  if (text.includes(label)) return true;
  const have = new Set(words(text));
  return words(label).every((w) => have.has(w));
}

/** What the walk read each label as: control, option, heading, crumb or title. */
export type Kinds = Map<string, Set<LabelKind>>;

/**
 * One screen's findings. A label can be both a heading and a control ("Add codes" titles a
 * dialog and labels its button): only a control read from nothing but chrome or headings fails.
 */
export function auditScreen(s: Screen, opts: { kinds?: Kinds; text?: string }): Finding[] {
  const out: Finding[] = [];
  const options = new Set(s.options);
  const controls = new Set([...s.controls, ...s.groups.flatMap((g) => g.controls)]);
  for (const c of controls) {
    const k = opts.kinds?.get(c);
    const acted = !k || k.has("control") || k.has("option");
    if (!acted && (k!.has("crumb") || k!.has("title")))
      out.push({ route: s.route, rule: "chrome", label: c });
    else if (!acted) out.push({ route: s.route, rule: "heading", label: c });
    if (codeLike(c)) out.push({ route: s.route, rule: "code", label: c });
    if (opts.text !== undefined && !options.has(c) && !inText(c, opts.text))
      out.push({ route: s.route, rule: "rendered", label: c });
  }
  return out;
}

/** Every finding on every screen. `files` maps a route to its page file. */
export function auditMap(
  screens: Screen[],
  kinds: Map<string, Kinds>,
  files: Map<string, string>,
): Finding[] {
  const sources = Object.values(OPTION_SOURCES)
    .map((o) => readFileSync(join(ROOT, o.file), "utf8"))
    .join("\n");
  return screens.flatMap((s) => {
    const page = files.get(s.route);
    return auditScreen(s, {
      kinds: kinds.get(s.route),
      text: page ? `${renderedText(page)}\n${s.options?.length ? sources : ""}` : undefined,
    });
  });
}
