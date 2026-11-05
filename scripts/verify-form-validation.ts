/**
 * Dashboard form-validation guard.
 *
 * Two things that are easy to claim and easy to let rot, so both are measured:
 *
 *   § A the two LIMITS tables — `src/api/limits.ts` and `dashboard/lib/limits.ts` —
 *       agree on every number
 *   § B the count of server actions that take TYPED user input without a schema does
 *       not grow (ratcheting budget, like verify:ui and verify:input-bounds)
 *   § C form state re-syncs after a save: no new `useState(prop)` seeds, no raw Radix
 *       control bound to state inside a form (see dashboard/lib/use-default-state.ts)
 *
 * ── WHY § B COUNTS WHAT IT COUNTS ───────────────────────────────────────────────
 * The dashboard already has a good contract: `parseForm(schema, formData)` returns zod
 * field errors, `ActionForm` publishes them through context, and `Field` renders each one
 * against the input that caused it. 34 actions use it. The rest read `formData.get(…)`
 * and hand-roll their checks, so a user who gets one field wrong is told so in a toast
 * that names none of them.
 *
 * But "the rest" is not one population. An action that reads a single hidden id and calls
 * the API — archive, revoke, toggle — has nothing to validate: the id was rendered by us
 * moments earlier, and a schema over it is ceremony that makes the guard noisier without
 * making anything safer. Those are excluded by `MACHINE_KEY` below.
 *
 * This distinction is not pedantry. The first pass of this audit reported "90 ad-hoc
 * actions" and the honest figure was 60 — the same over-count that made W5's triage claim
 * "~65% unbounded" when the real number was 96 of 323. A guard that inflates its own
 * findings is one people learn to discount.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────
 * Not a security control. The server validates every one of these routes with zod and
 * bounds every string (W5, gated at 0). This is about telling a person WHICH field they
 * got wrong, before a round trip.
 *
 *   pnpm verify:form-validation
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * May only ever DECREASE. Lower it in the same commit that converts an action.
 * See § B above for what is counted and what is deliberately not.
 */
const BUDGET = 0;

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

// ── § A · the two limits tables agree ────────────────────────────────────────────
{
  /** `key: 123,` — the shape both files use. Comments and JSDoc are ignored. */
  const parse = (rel: string): Record<string, number> => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const body = src.slice(src.indexOf("LIMITS = {"));
    const out: Record<string, number> = {};
    for (const m of body.matchAll(/^\s{2}([a-zA-Z]+):\s*(\d+),/gm)) out[m[1]!] = Number(m[2]);
    return out;
  };
  const api = parse("src/api/limits.ts");
  const dash = parse("dashboard/lib/limits.ts");

  ok("§A the API limits table was parsed", Object.keys(api).length > 5);
  ok("§A the dashboard limits table was parsed", Object.keys(dash).length > 5);

  // Every key the DASHBOARD declares must match the API. The API may hold extra keys the
  // dashboard has no field for; the reverse would be a bound with no server behind it.
  const mismatched = Object.entries(dash).filter(([k, v]) => api[k] !== v);
  for (const [k, v] of mismatched) {
    console.log(`     ↳ ${k}: dashboard ${v} vs api ${api[k] ?? "(absent)"}`);
  }
  ok("§A every dashboard bound matches the API", mismatched.length === 0);
}

// ── § B · ad-hoc actions taking typed input ──────────────────────────────────────
{
  const ACTION = /export async function (\w*Action)\s*\(/g;
  const GET = /formData\.get\(\s*'([^']+)'/g;

  /**
   * Keys that are ids, hidden routing values, or booleans a button posts. Nothing a human
   * typed, so there is nothing to tell them they got wrong.
   */
  const MACHINE_KEY =
    /^(id|.*_id|biz|business|cus|customer|sub|subscription|inv|invoice|pm|payment_method|cpn|coupon|price|prod|product|item|addon|plan|token|mode|role|op|action|confirm|enabled|active|endpoint|webhook|key|group|region|state|txn|transaction|credit_note|cn|contact|comment|fingerprint|signature|organization|gateway|gwa)$/;

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
    }
    return out;
  };

  const offenders: string[] = [];
  let structured = 0;
  let machineOnly = 0;

  for (const dir of ["dashboard/app", "dashboard/components"]) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("formData")) continue;
      for (const m of src.matchAll(ACTION)) {
        const from = m.index! + m[0].length;
        const next = src.indexOf("\nexport ", from);
        const body = src.slice(from, next === -1 ? undefined : next);
        if (!body.includes("formData")) continue;
        const keys = [...body.matchAll(GET)].map((k) => k[1]!);
        if (body.includes("parseForm(")) {
          structured++;
          continue;
        }
        if (!keys.some((k) => !MACHINE_KEY.test(k))) {
          machineOnly++;
          continue;
        }
        offenders.push(`${file.replace(ROOT, "")}  ·  ${m[1]}`);
      }
    }
  }

  console.log(`  structured (parseForm)     ${structured}`);
  console.log(`  ids/toggles only           ${machineOnly}  (nothing to validate)`);
  console.log(`  ad-hoc with typed input    ${offenders.length} (budget ${BUDGET})`);
  if (offenders.length > BUDGET) {
    console.log("");
    for (const o of offenders.sort()) console.log(`     ↳ ${o}`);
    console.log("");
    console.log("  Use parseForm(schema, formData) and return actionError(msg, { errors }).");
    console.log("  The form then renders each message against the field that caused it —");
    console.log("  see components/form/action-form.tsx and components/form/field.tsx.");
  }
  ok(`§B ad-hoc typed-input actions ≤ ${BUDGET}`, offenders.length <= BUDGET);
  if (offenders.length < BUDGET) {
    console.log(
      `   ↳ lower BUDGET to ${offenders.length} in this commit — the ratchet only turns one way.`,
    );
  }
}

// ── § C · form state that survives a save ────────────────────────────────────────
// A save re-renders the page with new props and React 19 resets the form. State seeded
// with a bare `useState(prop)` ignores the new props (stale value, posted back on the next
// save); a raw Radix control in a form follows the reset back to its mount-time value.
// `useDefaultState` / the styled primitives handle both — see lib/use-default-state.ts.
{
  /**
   * May only ever DECREASE. What remains was triaged as safe: dialogs that re-seed on
   * open, create forms, effect-resynced state, non-server seeds (nav, sort, clock), plus
   * the in-flight subscription change form. Convert one, lower this.
   */
  const SEEDED_BUDGET = 40;
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".tsx")) out.push(p);
    }
    return out;
  };
  const SEED = /useState(?:<[^>]*>)?\(\s*(?:\(\)\s*=>\s*)?(?:new \w+\()?([A-Za-z_]\w*)/g;
  const RAW = /<(Select|Switch|Checkbox|RadioGroup)\s[^>]*?\b(value|checked)=\{(?!""\})/g;
  const seeded: string[] = [];
  const raw: string[] = [];
  for (const dir of ["dashboard/app", "dashboard/components"]) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, "utf8");
      if (!src.includes('"use client"') && !src.includes("'use client'")) continue;
      const rel = file.replace(ROOT, "");
      // Destructured params of any component/hook in the file: `({ a, b = 1, c: d })`.
      const params = new Set<string>(["props"]);
      for (const m of src.matchAll(/\(\s*\{([^}]*)\}\s*:/g))
        for (const p of m[1]!.split(",")) {
          const n = p
            .split("=")[0]!
            .split(":")
            .pop()!
            .trim()
            .replace(/^\.\.\./, "");
          if (/^\w+$/.test(n)) params.add(n);
        }
      for (const m of src.matchAll(SEED)) {
        const id = m[1]!;
        if (id === "defaultOpen") continue; // disclosure state, not server data
        if (params.has(id) || /^(default|initial)[A-Z]/.test(id))
          seeded.push(`${rel}:${src.slice(0, m.index).split("\n").length}  ·  ${id}`);
      }
      // Only forms React resets: a server action (`<ActionForm>` / `<form action=…>`).
      if (src.includes("<ActionForm") || /<form\b[^>]*\baction=/.test(src))
        for (const m of src.matchAll(RAW))
          raw.push(`${rel}:${src.slice(0, m.index).split("\n").length}  ·  <${m[1]} ${m[2]}=…>`);
    }
  }
  console.log(`  useState seeded from props ${seeded.length} (budget ${SEEDED_BUDGET})`);
  console.log(`  raw Radix control in a form ${raw.length} (budget 0)`);
  if (seeded.length > SEEDED_BUDGET) for (const o of seeded.sort()) console.log(`     ↳ ${o}`);
  for (const o of raw)
    console.log(`     ↳ ${o}  — use SelectField/SwitchField/CheckboxField/RadioField`);
  ok(
    `§C useState seeded from props ≤ ${SEEDED_BUDGET} (use useDefaultState)`,
    seeded.length <= SEEDED_BUDGET,
  );
  ok(
    "§C no raw Radix Select/Switch/Checkbox/RadioGroup bound to state inside a form",
    raw.length === 0,
  );
  if (seeded.length < SEEDED_BUDGET)
    console.log(`   ↳ lower SEEDED_BUDGET to ${seeded.length} — the ratchet only turns one way.`);
}

console.log("");
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ FORM VALIDATION: PASS" : "❌ FORM VALIDATION: FAIL");
process.exit(pass ? 0 : 1);
