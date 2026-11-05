/**
 * Input-bound guard (W5) — every `z.string()` the API accepts must have an upper bound,
 * and every `z.number()` must have a lower one.
 *
 * A source scan with a RATCHETING BUDGET, modelled on `verify:ui`. The number may only
 * ever go down: if you legitimately bound a field, lower the budget in the same commit;
 * if the count goes up, this fails.
 *
 * ── WHY A GATE AND NOT JUST A SWEEP ─────────────────────────────────────────────
 * The sweep was the easy half. SR-2026-014 Finding 4's actual point is that unbounded
 * input is a SHARED ROOT CAUSE — "individual endpoint patches will keep being needed
 * until this is addressed centrally… every new platform endpoint inherits the gap by
 * default, so the problem grows over time." A one-time fix decays; a gate does not.
 *
 * ── WHAT COUNTS AS BOUNDED ──────────────────────────────────────────────────────
 * Not only `.max()`. A field is bounded when its own chain caps the length by any
 * means: `.length(n)`, `.uuid()`, `.datetime()`, `.ip()`, or a `.regex()` whose pattern
 * is ANCHORED and quantified (`^[A-Za-z]{2}$`). Treating those as unbounded would push
 * people to add a redundant `.max()` next to a regex that already settles it, and a
 * guard that cries wolf is a guard people learn to silence.
 *
 * ── WHY SOURCE TEXT AND NOT THE SCHEMAS ─────────────────────────────────────────
 * Zod exposes no reliable public way to ask a built schema "do you have a max?" across
 * versions, and importing every route file to introspect would execute module side
 * effects. Reading source is cruder and cannot be fooled by a value computed at
 * runtime — but nothing here computes a bound at runtime, and if something ever does,
 * the guard failing loudly is the correct outcome.
 *
 * ── WHY NUMBERS TOO (added 2026-08-27, audit L5) ────────────────────────────────
 * `amount_minor: z.number().int().optional()` on the manual-invoice route accepted a
 * NEGATIVE amount, which passed validation and then failed deep in the money path as a
 * 500 on attacker-supplied input. It was the only such field out of 99 — which is the
 * argument for a gate rather than a patch: the convention was already universal, and
 * nothing was holding it there.
 *
 * A field is floored by `.nonnegative()`, `.positive()`, `.min(n)` or `.gte(n)`. A
 * legitimately signed field (an adjustment, a delta) satisfies this by naming its floor
 * explicitly — `.min(-500_00)` — so the rule is "state the floor", not "must be
 * positive". Unbounded-below is the only thing it refuses.
 *
 *   pnpm verify:input-bounds
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * May only ever DECREASE. Currently zero — every string the API accepts is bounded.
 * If you are raising this, you are adding an unbounded field: don't.
 */
const BUDGET = 0

/**
 * May only ever DECREASE. Currently zero — every number the API accepts names a floor.
 * If you are raising this, you are admitting an unbounded-below amount: don't.
 */
const NUM_BUDGET = 0

const API_DIR = new URL('../src/api/', import.meta.url).pathname

/** Chain fragments that settle the length on their own. */
const BOUNDING = ['.max(', '.length(', '.uuid(', '.datetime(', '.ip(', '.emoji(']

/**
 * `field: z.string()` plus its whole chain. One level of nested parens is allowed
 * because `.regex(/…/, 'a message with (parentheses)')` is common and the chain must
 * survive it intact.
 */
const DECL = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*z\.string\(\)((?:\.[a-zA-Z]+\([^()]*(?:\([^()]*\))?[^()]*\))*)/g

/** `field: z.number()` plus its whole chain, same shape as DECL above. */
const NUM_DECL = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*z\.number\(\)((?:\.[a-zA-Z]+\([^()]*(?:\([^()]*\))?[^()]*\))*)/g

/** Chain fragments that name a lower bound. `.min(-n)` counts — stating a floor is the point. */
const FLOORING = ['.nonnegative(', '.positive(', '.min(', '.gte(']

/**
 * An anchored, quantified pattern bounds the length as surely as `.max()` does —
 * whether written inline or, as the catalog routes do, as a named constant.
 */
const QUANTIFIED = /\^[^/]*\{\d+(?:,\d*)?\}/

/** `.regex(/^…{0,99}$/, …)` — the pattern written at the call site. */
const INLINE_REGEX = /\.regex\(\s*(\/[^/]*\/)/

/** `.regex(SLUG_RE, …)` — the pattern behind a name. */
const NAMED_REGEX = /\.regex\(\s*([A-Z][A-Z0-9_]*)\b/

/**
 * Resolve `const NAME = /…/` declared in the same file.
 *
 * Worth the extra step rather than demanding a redundant `.max()` beside a regex that
 * already settles the question: a guard that reports a bound field as unbounded is a
 * guard people learn to work around, and the workaround (a second, looser bound next to
 * the real one) is worse than the thing it satisfies.
 */
function boundedByRegex(chain: string, src: string): boolean {
  const inline = INLINE_REGEX.exec(chain)
  if (inline) return QUANTIFIED.test(inline[1]!)
  const named = NAMED_REGEX.exec(chain)
  if (!named) return false
  const decl = new RegExp(`const\\s+${named[1]}\\s*=\\s*(/[^/]*/)`).exec(src)
  return decl ? QUANTIFIED.test(decl[1]!) : false
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const offenders: Array<{ file: string; field: string }> = []
const numOffenders: Array<{ file: string; field: string }> = []
let bounded = 0
let floored = 0

for (const file of walk(API_DIR)) {
  // The table itself defines the bounds; it is not a route body.
  if (file.endsWith('limits.ts')) continue
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(DECL)) {
    const [, field, chain = ''] = m
    if (BOUNDING.some((b) => chain.includes(b)) || boundedByRegex(chain, src)) {
      bounded++
      continue
    }
    offenders.push({ file: file.replace(/.*\/src\//, 'src/'), field: field! })
  }
  for (const m of src.matchAll(NUM_DECL)) {
    const [, field, chain = ''] = m
    if (FLOORING.some((b) => chain.includes(b))) {
      floored++
      continue
    }
    numOffenders.push({ file: file.replace(/.*\/src\//, 'src/'), field: field! })
  }
}

console.log(`  bounded          ${bounded}`)
console.log(`  unbounded        ${offenders.length} (budget ${BUDGET})`)
if (offenders.length > 0) {
  console.log('')
  for (const o of offenders) console.log(`     ↳ ${o.file}  ·  ${o.field}`)
  console.log('')
  console.log('  Bound it with a value from src/api/limits.ts — or, if the shape already')
  console.log('  settles the length (.length / .datetime / an anchored .regex), use that.')
}
console.log(`  floored          ${floored}`)
console.log(`  unfloored        ${numOffenders.length} (budget ${NUM_BUDGET})`)
if (numOffenders.length > 0) {
  console.log('')
  for (const o of numOffenders) console.log(`     ↳ ${o.file}  ·  ${o.field}`)
  console.log('')
  console.log('  Name the floor: .nonnegative() for an amount, .positive() for a quantity,')
  console.log('  or .min(-n) if the field really is signed. Unbounded-below reaches the money')
  console.log('  path as a 500 on input the caller chose (audit L5).')
}
console.log('')
const pass = offenders.length <= BUDGET && numOffenders.length <= NUM_BUDGET
console.log(pass ? '✅ INPUT BOUNDS: PASS' : '❌ INPUT BOUNDS: FAIL')
if (pass && offenders.length < BUDGET) {
  console.log(`   ↳ lower BUDGET to ${offenders.length} in this commit — the ratchet only turns one way.`)
}
if (pass && numOffenders.length < NUM_BUDGET) {
  console.log(`   ↳ lower NUM_BUDGET to ${numOffenders.length} in this commit — the ratchet only turns one way.`)
}
process.exit(pass ? 0 : 1)
