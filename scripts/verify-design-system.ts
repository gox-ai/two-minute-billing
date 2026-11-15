/**
 * Design-system guard.
 *
 * The dashboard's "toy" feel came from a primitives layer that was never
 * finished, so ~70 screens improvised: 66 native `<select>`, 31 native
 * checkboxes, 21 native radios, and type as small as 9px. Styled primitives now
 * exist for every one of those, so this check keeps the sweep from silently
 * regressing.
 *
 * It reports a BUDGET rather than pass/fail-on-any-hit, because the migration is
 * incremental: the budget only ever ratchets DOWN. If you legitimately reduce a
 * count, lower the budget in the same commit — that is the point.
 *
 *   pnpm verify:ui
 */
import { parse } from "@babel/parser";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const ROOTS = ["dashboard/app", "dashboard/components"];

/** Current known counts. These may only ever go DOWN. */
const BUDGET: Record<string, number> = {
  "native <select>": 0,
  "native checkbox": 0,
  "native radio": 0,
  "type below 12px": 0,
  "hardcoded palette": 0,
  "client call on server": 0,
  "date without timezone": 0,
  "off-pattern date": 15,
  "off-scale radius": 2,
  "plain in-app link": 0,
  "bare ResizeObserver": 6,
  "lower-case placeholder": 4,
  "table without phone": 40,
  "off-token motion": 2,
  "native title tooltip": 78,
  "stock placeholder name": 0,
  "toast richColors": 0,
  "contraction in UI text": 7,
  "off-glossary verb": 29,
  "British spelling": 11,
  "angle-bracket nav path": 1,
};

type Rule = { name: string; why: string } & (
  | { re: RegExp }
  // `match` counts hits itself — used where a plain regex can't express "below
  // 12", e.g. a numeric fontSize/font-size value that isn't a Tailwind class.
  | { match: (src: string) => number }
);

const RULES: Rule[] = [
  {
    name: "native <select>",
    re: /<select[\s>]/g,
    why: "use <Select> from @/components/ui/select (it accepts `name`, so it still posts in a form)",
  },
  {
    name: "native checkbox",
    re: /type=["']checkbox["']/g,
    why: 'use <Checkbox> from @/components/ui/checkbox (supports checked="indeterminate")',
  },
  {
    name: "native radio",
    re: /type=["']radio["']/g,
    why: "use <RadioGroup> / <RadioOption> from @/components/ui/radio-group",
  },
  {
    // Two shapes: a Tailwind arbitrary value (`text-[10px]`), and a numeric
    // fontSize/font-size below 12 — the shape a chart library (ECharts, SVG
    // attrs, inline `style`) actually uses, and a plain text scan never sees a
    // rendered SVG `font-size` attribute, only the source that set it.
    name: "type below 12px",
    match: (src) => {
      let n = (src.match(/text-\[(?:[0-9]|1[01])px\]/g) ?? []).length;
      // The quote is not optional decoration: `style={{ fontSize: '8px' }}` is the
      // idiomatic React spelling and slipped through while the numeric forms were caught.
      for (const m of src.matchAll(/\bfontSize\s*[:=]\s*\{?\s*['"]?\s*(\d+(?:\.\d+)?)/g)) {
        if (Number(m[1]) < 12) n++;
      }
      for (const m of src.matchAll(/\bfont-size\s*[:=]\s*['"]?\s*(\d+(?:\.\d+)?)(?:px)?/g)) {
        if (Number(m[1]) < 12) n++;
      }
      return n;
    },
    why: "12px is the scale floor for a surface operators read all day; use text-xs and add tracking (or, for a chart library, fontSize: 12+)",
  },
  {
    // A pinned palette step does not follow the theme, and each one needed its own
    // hand-written `dark:` variant — which is how the app ended up with two status
    // chip systems that had drifted apart.
    name: "hardcoded palette",
    re: /\b(?:bg|text|border|ring|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b/g,
    why: "use the semantic tokens: success / warning / destructive / info (+ -soft), or muted-foreground / border",
  },
  {
    // Every date and time an operator reads is in the BUSINESS timezone. Without `tz` the
    // formatters fall back to UTC, and a time that reads as local is off by hours.
    name: "date without timezone",
    match: (src) => {
      let n = 0;
      for (const m of src.matchAll(
        /\b(?:fmtDate|fmtDateTime|fmtDateShort|fmtDateTimeShort|fmtDateTimeSec)\(/g,
      )) {
        let depth = 1;
        let args = 1;
        for (let i = m.index + m[0].length; i < src.length && depth > 0; i++) {
          const c = src[i]!;
          if ("([{".includes(c)) depth++;
          else if (")]}".includes(c)) depth--;
          else if (c === "," && depth === 1) args++;
        }
        if (args < 2) n++;
      }
      return n;
    },
    why: "pass the business timezone: fmtDateTime(iso, tz). Pages read it from the business (`timezone`); pass it down to client components as a prop",
  },
  {
    // Two radii: controls `rounded-md` (8px), containers `rounded-xl` (14px). The app had
    // five in use (4, 6, 8, 10, 14) — dialogs, menus and settings cards at 10, checkboxes
    // and copy buttons at 4. Counted inside string literals only, so prose is not a hit.
    name: "off-scale radius",
    match: (src) => {
      let n = 0;
      for (const m of src.matchAll(/(["'`])(?:(?!\1)[^\n])*\1/g)) {
        if (/[.,] /.test(m[0])) continue; // prose ("halves rounded up. For example"), not classes
        n += (m[0].match(/(?<=[\s"'`])rounded(?:-lg|-sm|-\[[^\]]*\])?(?=[\s"'`])/g) ?? []).length;
      }
      return n;
    },
    why: "use rounded-md (controls, 8px) or rounded-xl (containers, 14px); a deliberate exception carries a one-line comment",
  },
  {
    // A plain <a> to a page of the app makes the browser load a new document: the shell
    // remounts, and the assistant's panel, its draft and every piece of client state go with
    // it. Counted: an <a> whose href is not an external literal and that does not open a new
    // tab, download a file, or say it wants a document request (`data-document-link`: a file
    // endpoint, a route that redirects off the app, the "Reload" link).
    name: "plain in-app link",
    match: (src) => plainInAppLinks(src),
    why: 'use <Link> from "next/link" (or `asChild` with it); for a file or a deliberate full request add `data-document-link`',
  },
  {
    // While the assistant's panel moves or its edge is dragged, the page's width changes on
    // every frame. A bare observer redraws on each one (a chart redraw cost 9 late frames
    // per move); the helper waits and runs once when the page has settled.
    name: "bare ResizeObserver",
    re: /new ResizeObserver\(/g,
    why: "use observeSettledResize from @/lib/settled-resize, so the work runs once after a panel move",
  },
  {
    // A placeholder is an example of a value, never the label. "description", "qty",
    // "optional", "key" each stood in for a missing label on a form the owner rejected.
    // Counted: a placeholder that starts lower-case and is not an example ("e.g. …"), an
    // address, a URL or an identifier pattern.
    name: "lower-case placeholder",
    match: (src) =>
      (src.match(/placeholder="[a-z][^"]*"/g) ?? []).filter(
        (m) =>
          !/placeholder="(e\.g\.|https?:|[a-z0-9._-]+@|[a-z0-9]+[_-][a-z0-9_-]*"|[a-z]{2,4}_)/.test(
            m,
          ),
      ).length,
    why: "give the field a visible label (Field, or a column header over repeated rows) and make the placeholder an example in sentence case, or drop it",
  },
  {
    // Every plain table says what it does on a phone: `stack` (rows become blocks) or
    // `scroll` (it keeps its columns and scrolls inside its card). Unsaid, it overflows.
    name: "table without phone",
    match: (src) => (src.match(/<Table(?=[\s>])(?![^>]*\bphone=)/g) ?? []).length,
    why: 'add phone="stack" or phone="scroll" to the <Table> (components/ui/table.tsx)',
  },
  {
    // Motion runs on the tokens in globals.css (--dur-*, --ease-*). A literal duration or
    // curve in a class string or a script drifts from every other move on the screen.
    name: "off-token motion",
    re: /\bduration-(?:\d+|\[)|\bease-(?:\[|in-out\b|linear\b|in\b)|cubic-bezier\(/g,
    why: "use a motion token: the bare `transition-*` utilities already run on --dur-fast / --ease-out; for more, an `animate-*` utility or `var(--dur-…)` / `var(--ease-…)`",
  },
  {
    // The browser's own tooltip: late, unstyled, absent on touch and for keyboards.
    name: "native title tooltip",
    re: /<(?:button|a|span|div|th|td|p|li|img|input|label)\b[^>]*\stitle=/g,
    why: "use <Tooltip> (components/ui/tooltip.tsx); for a truncated value use IdText / MiddleEllipsis, which carry their own",
  },
  {
    // Stock placeholder names read as a template, in demo data and in examples alike.
    name: "stock placeholder name",
    re: /\b(?:Acme|Globex|Initech|Contoso|John Doe|Jane Doe|Example Corp|Lorem ipsum)\b/g,
    why: "invent a specific, plausible name (the demo data's style: Larkspur Freight, Halyard Analytics)",
  },
  {
    // Toasts are ours (components/ui/sonner.tsx): the library's colour set is not.
    name: "toast richColors",
    re: /<[A-Z]\w*\b[^>]*\srichColors\b/g,
    why: "remove it; tones come from our tokens in components/ui/sonner.tsx",
  },
];

/** `<a>` opening tags that navigate inside the app with a full document request. */
function plainInAppLinks(src: string): number {
  let n = 0;
  for (const m of src.matchAll(/<a(?=[\s>])/g)) {
    // The opening tag ends at the first `>` outside braces and strings.
    let i = m.index + 2;
    let depth = 0;
    let quote = "";
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (depth === 0 && (c === '"' || c === "'")) quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(m.index, i + 1);
    const href = /\bhref=(\{[^]*?\}(?=[\s/>])|"[^"]*"|'[^']*')/.exec(tag)?.[1];
    if (!href) continue; // no href (a spread, or an anchor without a destination)
    if (/^["'].*\$\{/.test(href)) continue; // an HTML snippet in a template string, not JSX
    if (/^["'{`\s]*(?:https?:|mailto:|tel:|#)/.test(href.replace(/^\{\s*/, ""))) continue;
    if (/\btarget=|\bdownload\b|data-document-link/.test(tag)) continue;
    n++;
  }
  return n;
}

function walk(dir: string, out: string[] = [], ext = /\.tsx$/): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out, ext);
    else if (ext.test(p)) out.push(p);
  }
  return out;
}

/**
 * Server code calling (or reading a member of) a non-component export of a
 * `"use client"` module. It type-checks, and React throws at render time — the portal
 * crashed in production this way, on one buyer's branch only. Server code = modules
 * reachable from a route entry or a "use server" file without crossing a "use client"
 * boundary. Passing such an export as a prop is legal, so only call sites count.
 */
const CLIENT_CALL = {
  name: "client call on server",
  why: 'move the helper to a module with no "use client" and import it from both sides',
};

function clientCallsOnServer(): Array<{ file: string; n: number }> {
  const all = walk("dashboard", [], /\.tsx?$/).filter((f) => !f.endsWith(".d.ts"));
  const src = new Map(all.map((f) => [f, readFileSync(f, "utf8")]));
  const directive = (s: string) =>
    /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use (client|server)["']/.exec(s)?.[1];
  const resolve = (from: string, spec: string) => {
    const base = spec.startsWith("@/")
      ? join("dashboard", spec.slice(2))
      : spec.startsWith(".")
        ? join(dirname(from), spec)
        : null;
    if (!base) return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`])
      if (src.has(c)) return c;
    return null;
  };
  // A component (PascalCase) renders fine across the boundary; ALL_CAPS and camelCase do not.
  const isValue = (name: string) => !(/^[A-Z]/.test(name) && /[a-z]/.test(name));

  const clientValues = new Map<string, Set<string>>();
  for (const [f, s] of src) {
    if (directive(s) !== "client") continue;
    const names = new Set<string>();
    for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var)\s+([\w$]+)/g))
      if (m[1] && isValue(m[1])) names.add(m[1]);
    if (names.size) clientValues.set(f, names);
  }

  const imports = (f: string) =>
    [
      ...(src.get(f) ?? "").matchAll(
        /(?:import|export)\s+(type\s+)?(?:([^'";]*?)\s+from\s+)?["']([^"']+)["']/g,
      ),
    ].map((m) => ({ typeOnly: !!m[1], clause: m[2] ?? "", target: resolve(f, m[3] ?? "") }));

  const ENTRY =
    /^(page|layout|template|default|not-found|global-not-found|forbidden|unauthorized|route|loading|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.tsx?$/;
  const queue = all.filter((f) => {
    const d = directive(src.get(f) ?? "");
    if (d === "server") return true;
    return (
      d !== "client" &&
      (f === "dashboard/proxy.ts" || (f.startsWith("dashboard/app/") && ENTRY.test(basename(f))))
    );
  });
  const server = new Set(queue);
  while (queue.length) {
    for (const { target } of imports(queue.pop() ?? "")) {
      if (!target || server.has(target) || directive(src.get(target) ?? "") === "client") continue;
      server.add(target);
      queue.push(target);
    }
  }

  const out: Array<{ file: string; n: number }> = [];
  for (const f of server) {
    const body = src.get(f) ?? "";
    let n = 0;
    for (const { typeOnly, clause, target } of imports(f)) {
      const exported = target ? clientValues.get(target) : undefined;
      if (typeOnly || !exported) continue;
      for (const part of (/\{([^}]*)\}/.exec(clause)?.[1] ?? "").split(",")) {
        const [imported, local = imported] = part.trim().split(/\s+as\s+/);
        if (!imported || imported.startsWith("type ") || !exported.has(imported) || !local)
          continue;
        const use = new RegExp(
          `(?<![\\w$.])${local.replace(/\$/g, "\\$")}\\s*(?:\\(|\\?\\.|\\.|\\[)`,
          "g",
        );
        n += (body.match(use) ?? []).length;
      }
    }
    if (n) out.push({ file: f, n });
  }
  return out;
}

/**
 * One date shape ("10 Nov 2026", `lib/format-date.ts`). Counts the old dashed shape
 * ("09-Nov-2026"), en-GB's four-letter "Sept", and locale formatting that bypasses the helper.
 */
const OFF_DATE = {
  name: "off-pattern date",
  why: "format dates with fmtDate / fmtDateTime / fmtRange / fmtAxisDate from @/lib/format-date",
};
const OFF_DATE_RE = /\d{2}-[A-Z][a-z]{2,3}-\d{4}|\bSept\b|toLocaleDateString\(/g;

function offPatternDates(): Array<{ file: string; n: number }> {
  const out: Array<{ file: string; n: number }> = [];
  for (const file of ["dashboard/app", "dashboard/components", "dashboard/lib"].flatMap((r) =>
    walk(r, [], /\.tsx?$/),
  )) {
    // The formatter itself, and the span that keeps a date on one line: both must know the shape.
    if (
      file === "dashboard/lib/format-date.ts" ||
      file === "dashboard/components/patterns/nowrap-dates.tsx"
    )
      continue;
    const n = (readFileSync(file, "utf8").match(OFF_DATE_RE) ?? []).length;
    if (n) out.push({ file, n });
  }
  return out;
}

/**
 * House words (CLAUDE.md, "In-app text follows ASD-STE100"), scanned in the text a user reads:
 * JSX text and string literals, parsed, so comments, imports, object keys, class strings,
 * comparisons and type literals never count. `.ts` too: server actions return the errors.
 */
type TextRule = { name: string; why: string; test: (text: string) => boolean };

const BRITISH = [
  "recognis",
  "organis",
  "colour",
  "behaviour",
  "licence",
  "analys(?:e|ed|es|ing)\\b",
  "catalogue",
  "favourite",
  "cheque",
  "authoris",
  "customis",
  "finalis",
  "summaris",
  "prioritis",
  "optimis",
  "initialis",
  "normalis",
  "categoris",
  "centre",
];

const TEXT_RULES: TextRule[] = [
  {
    // `'s` is left alone (a possessive), except after the pronouns that make it "is"/"us".
    name: "contraction in UI text",
    test: (t) =>
      /\b[A-Za-z]+(?:n't|'re|'ll|'ve|'d)\b|\bI'm\b|\b(?:[Ii]t|[Tt]hat|[Tt]here|[Hh]ere|[Ww]hat|[Ww]ho|[Ww]here|[Hh]ow|[Ll]et|[Hh]e|[Ss]he)'s\b/.test(
        t,
      ),
    why: 'write it out: "do not", "you are", "it is" (no contractions in product text)',
  },
  {
    // The base form only: "fixed price", "verified domain" are adjectives, not the verb.
    name: "off-glossary verb",
    test: (t) =>
      /(?<!\b(?:a|the|this|that) )\b(?:[Ff]ix|[Rr]epair|[Vv]erify|[Vv]alidate|[Pp]ick|[Cc]hoose)\b(?![-_/.]\w)/.test(
        t,
      ),
    why: "use the house verb: correct (not fix/repair), check (not verify/validate), select (not pick/choose)",
  },
  {
    // "cancelled" / "cancelling" stay: that is the API status value.
    name: "British spelling",
    test: (t) => new RegExp(`\\b(?:${BRITISH.join("|")})`, "i").test(t),
    why: "American English: recognize, organization, color, behavior, license, analyze, catalog, favorite, check",
  },
  {
    name: "angle-bracket nav path",
    test: (t) => /\b[A-Z][\w&]*(?: [\w&]+)* > [A-Z]/.test(t),
    why: 'write a navigation path with an arrow: "Settings → Credits"',
  },
];

/** JSX attributes and object keys whose string value is code, never text. */
const CODE_ATTR =
  /^(?:className|class|href|src|id|key|type|name|variant|size|role|htmlFor|style|target|rel|inputMode|autoComplete|pattern|side|align|method|encType|value|defaultValue|tone|icon|as|form|accept|lang|dir|mode|kind|status|state|data-.*|aria-(?:controls|describedby|labelledby|owns|current|live|haspopup))$/;
const CLASS_FN = /^(?:cn|clsx|cva|cx|twMerge|tv)$/;

type TextHit = { file: string; line: number; text: string };

/** The texts a user can read in one file, each with its line. */
function uiTexts(src: string): Array<{ text: string; line: number; literal: boolean }> {
  let ast: unknown;
  try {
    ast = parse(src, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true });
  } catch {
    return [];
  }
  type N = { type: string; loc?: { start: { line: number } }; [k: string]: unknown };
  const out: Array<{ text: string; line: number; literal: boolean }> = [];
  const nameOf = (n: unknown): string => {
    const x = n as N | undefined;
    if (!x) return "";
    if (x.type === "Identifier" || x.type === "JSXIdentifier") return String(x.name);
    if (x.type === "JSXNamespacedName") return `${nameOf(x.namespace)}:${nameOf(x.name)}`;
    if (x.type === "StringLiteral") return String(x.value);
    if (x.type === "MemberExpression") return nameOf(x.object);
    return "";
  };
  // "tree" when everything under this position is code (a class list, a key, a comparison);
  // "literal" when only a string placed directly here is (a path passed to a call).
  const codeSlot = (parent: N | undefined, key: string): "tree" | "literal" | false => {
    if (!parent) return false;
    switch (parent.type) {
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        return key === "source" ? "tree" : false;
      case "ImportDeclaration":
      case "ImportExpression":
      case "TSLiteralType":
      case "TSEnumMember":
      case "TSExternalModuleReference":
      case "TSImportType":
        return "tree";
      case "SwitchCase":
        return key === "test" ? "tree" : false;
      case "ObjectMethod":
        return key === "key" ? "tree" : false;
      case "ObjectProperty":
      case "ClassProperty":
        return key === "key" || CODE_ATTR.test(nameOf(parent.key)) ? "tree" : false;
      case "JSXAttribute":
        return CODE_ATTR.test(nameOf(parent.name)) ? "tree" : false;
      case "MemberExpression":
      case "OptionalMemberExpression":
        return key === "property" ? "tree" : false;
      case "BinaryExpression":
        return /^[!=]==?$/.test(String(parent.operator)) || parent.operator === "in"
          ? "tree"
          : false;
      case "CallExpression":
      case "NewExpression": {
        const callee = parent.callee as N;
        const fn = callee.type === "Identifier" ? String(callee.name) : nameOf(callee.property);
        const obj = callee.type === "MemberExpression" ? nameOf(callee.object) : "";
        if (CLASS_FN.test(fn) || obj === "console") return "tree";
        return (
          /^(?:require|import|get|getAll|has|set|delete|append|querySelector|querySelectorAll|getItem|setItem|removeItem|includes|startsWith|endsWith|split|replace|replaceAll|addEventListener|removeEventListener|redirect|push|revalidatePath|fetch|api|apiFetch)$/.test(
            fn,
          ) && "literal"
        );
      }
      default:
        return false;
    }
  };
  const visit = (node: N, parent: N | undefined, key: string, code: boolean) => {
    const line = node.loc?.start.line ?? 0;
    if (node.type === "JSXText") {
      const text = String(node.value).replace(/\s+/g, " ").trim();
      if (text) out.push({ text, line, literal: false });
      return;
    }
    const slot = codeSlot(parent, key);
    if (slot === "tree") code = true;
    const literal = node.type === "StringLiteral" || node.type === "TemplateLiteral";
    if (literal && (code || slot === "literal")) return;
    if (node.type === "StringLiteral") {
      out.push({ text: String(node.value), line, literal: true });
      return;
    }
    if (node.type === "TemplateLiteral") {
      if (parent?.type === "TaggedTemplateExpression") return; // sql``, css``
      const quasis = node.quasis as Array<{ value: { cooked?: string } }>;
      out.push({ text: quasis.map((q) => q.value.cooked ?? "").join("{}"), line, literal: true });
    }
    for (const k of Object.keys(node)) {
      if (k === "loc" || k.endsWith("Comments") || k === "extra") continue;
      const v = node[k];
      for (const c of Array.isArray(v) ? v : [v])
        if (c && typeof c === "object" && typeof (c as N).type === "string")
          visit(c as N, node, k, code);
    }
  };
  visit((ast as { program: N }).program, undefined, "", false);
  return out;
}

function textRuleHits(): Map<string, TextHit[]> {
  const out = new Map<string, TextHit[]>(TEXT_RULES.map((r) => [r.name, []]));
  const list = ROOTS.flatMap((r) => walk(r, [], /\.tsx?$/)).filter(
    (f) => !f.endsWith(".d.ts") && !/\.(?:test|spec)\.tsx?$|__tests__/.test(f),
  );
  for (const file of list) {
    const texts = uiTexts(readFileSync(file, "utf8"));
    for (const { text, line, literal } of texts) {
      // A single lower-case token or a path in a string literal is a code value ("cheque").
      if (literal && /^(?:[a-z][\w.:/-]*|\/\S*)$/.test(text)) continue;
      const t = text.replace(/&apos;|&#39;|&rsquo;|[’‘]/g, "'").replace(/&gt;/g, ">");
      for (const rule of TEXT_RULES)
        if (rule.test(t)) out.get(rule.name)?.push({ file, line, text: t.slice(0, 70) });
    }
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));
// Maps rather than index signatures: this repo compiles with
// noUncheckedIndexedAccess, so every bracket read on a Record is `| undefined`.
const hits = new Map<string, Array<{ file: string; n: number }>>();
const totals = new Map<string, number>();

for (const rule of RULES) {
  hits.set(rule.name, []);
  totals.set(rule.name, 0);
}
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const rule of RULES) {
    const n = "re" in rule ? (src.match(rule.re) ?? []).length : rule.match(src);
    if (n) {
      hits.get(rule.name)?.push({ file, n });
      totals.set(rule.name, (totals.get(rule.name) ?? 0) + n);
    }
  }
}

const serverHits = clientCallsOnServer();
hits.set(CLIENT_CALL.name, serverHits);
totals.set(
  CLIENT_CALL.name,
  serverHits.reduce((a, h) => a + h.n, 0),
);

const dateHits = offPatternDates();
hits.set(OFF_DATE.name, dateHits);
totals.set(
  OFF_DATE.name,
  dateHits.reduce((a, h) => a + h.n, 0),
);

const textHits = textRuleHits();
for (const [name, list] of textHits) totals.set(name, list.length);

// `pnpm verify:ui -- --show "<rule>"` lists every hit of a text rule, to judge or burn it down.
const showArg = process.argv.indexOf("--show");
const show = showArg > 0 ? process.argv[showArg + 1] : undefined;

let failed = false;
for (const rule of [...RULES, CLIENT_CALL, OFF_DATE, ...TEXT_RULES]) {
  const total = totals.get(rule.name) ?? 0;
  const budget = BUDGET[rule.name] ?? 0;
  const over = total > budget;
  if (over) failed = true;
  const mark = over ? "FAIL" : total < budget ? "GOOD" : "ok  ";
  console.log(`${mark} ${rule.name.padEnd(23)} ${String(total).padStart(3)} (budget ${budget})`);
  if (over) {
    console.log(`     ↳ ${rule.why}`);
    for (const h of (hits.get(rule.name) ?? []).slice(0, 8))
      console.log(`       ${h.file} ×${h.n}`);
  } else if (total < budget) {
    console.log(`     ↳ budget is stale — lower "${rule.name}" to ${total} in this commit`);
  }
  const lines = textHits.get(rule.name) ?? [];
  for (const h of rule.name === show ? lines : over ? lines.slice(0, 8) : [])
    console.log(`       ${h.file}:${h.line}  "${h.text}"`);
}

if (failed) {
  console.error("\nA design-system or client/server rule regressed. See the hints above.");
  process.exit(1);
}
console.log("\ndesign-system guard: ok");
