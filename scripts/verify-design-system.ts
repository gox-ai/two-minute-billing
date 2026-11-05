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
];

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

let failed = false;
for (const rule of [...RULES, CLIENT_CALL]) {
  const total = totals.get(rule.name) ?? 0;
  const budget = BUDGET[rule.name] ?? 0;
  const over = total > budget;
  if (over) failed = true;
  const mark = over ? "FAIL" : total < budget ? "GOOD" : "ok  ";
  console.log(`${mark} ${rule.name.padEnd(21)} ${String(total).padStart(3)} (budget ${budget})`);
  if (over) {
    console.log(`     ↳ ${rule.why}`);
    for (const h of (hits.get(rule.name) ?? []).slice(0, 8))
      console.log(`       ${h.file} ×${h.n}`);
  } else if (total < budget) {
    console.log(`     ↳ budget is stale — lower "${rule.name}" to ${total} in this commit`);
  }
}

if (failed) {
  console.error("\nA design-system or client/server rule regressed. See the hints above.");
  process.exit(1);
}
console.log("\ndesign-system guard: ok");
