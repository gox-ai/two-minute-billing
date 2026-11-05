/**
 * Robustness: error-envelope consistency + route reachability + abuse inputs.
 *  - unknown route → 404 with {error:{type,message}},
 *  - malformed JSON body → clean 400 (not a 500 leak),
 *  - every OpenAPI-documented path is REACHABLE (no silent 404 from route drift),
 *  - oversized / wrong-type fields rejected with 400, not 500,
 *  - no response leaks a stack trace.
 *
 *   pnpm verify:robustness
 */
import { buildApp } from '@/index'
import { closeDb } from '@/platform/db'
import { createOrganization } from '@/modules/tenancy/service'
import { openapiDocument } from '@/api/openapi'

const app = await buildApp({ logger: false })
const org = await createOrganization({ name: 'Robustness Org' })
const AUTH = { authorization: `Bearer ${org.secret}` }
const checks: Array<[string, boolean]> = []
const ok = (n: string, c: boolean) => checks.push([n, c])
const hasErrShape = (body: string) => {
  try { const j = JSON.parse(body); return !!j.error?.type && typeof j.error?.message === 'string' } catch { return false }
}
const leaksStack = (body: string) => /at \w+ \(|node_modules|\.ts:\d+|Error:/.test(body)

// 1) unknown route → 404 envelope
const nf = await app.inject({ method: 'GET', url: '/v1/does-not-exist', headers: AUTH })
ok('unknown route → 404', nf.statusCode === 404)
ok('404 has error envelope', hasErrShape(nf.body))

// 2) malformed JSON → 400 (not 500)
const bad = await app.inject({ method: 'POST', url: '/v1/businesses', headers: { 'idempotency-key': crypto.randomUUID(), ...AUTH, 'content-type': 'application/json' }, payload: '{not valid json' })
ok('malformed JSON → 400', bad.statusCode === 400)
ok('malformed JSON no stack leak', !leaksStack(bad.body))

// 3) wrong-type field → 400
const wrongType = await app.inject({ method: 'POST', url: '/v1/businesses', headers: { ...AUTH, 'idempotency-key': crypto.randomUUID() }, payload: { name: 12345 } })
ok('wrong-type field → 400', wrongType.statusCode === 400 && hasErrShape(wrongType.body))

// 4) oversized field → 400 (name max 200)
const huge = await app.inject({ method: 'POST', url: '/v1/businesses', headers: { ...AUTH, 'idempotency-key': crypto.randomUUID() }, payload: { name: 'x'.repeat(5000) } })
ok('oversized field → 400', huge.statusCode === 400)

// 5) missing auth → 401 envelope (not 500)
const noAuth = await app.inject({ method: 'GET', url: '/v1/me' })
ok('no auth → 401 envelope', noAuth.statusCode === 401 && hasErrShape(noAuth.body))

// 6) route reachability: every OpenAPI GET path with no params should respond (not 404).
//    (Param paths are covered by the feature suites; here we hit the no-param GETs.)
const paths = Object.keys(openapiDocument.paths)
const noParamGets = paths.filter((p) => !p.includes('{') && (openapiDocument.paths as Record<string, { get?: unknown }>)[p]?.get)
let reachable = 0
for (const p of noParamGets) {
  const r = await app.inject({ method: 'GET', url: p, headers: AUTH })
  // reachable = NOT a 404 (200/401/503 all mean the route exists & is wired)
  if (r.statusCode !== 404) reachable++
  else console.log(`  ! unreachable documented path: GET ${p}`)
}
ok(`all ${noParamGets.length} no-param GET paths reachable`, reachable === noParamGets.length)

// 7) A subscription referencing a non-existent price → clean error, never a stack leak.
const bizR = await app.inject({ method: 'POST', url: '/v1/businesses', headers: { ...AUTH, 'idempotency-key': crypto.randomUUID() }, payload: { name: 'R' } })
const biz = JSON.parse(bizR.body).id
const cusR = await app.inject({ method: 'POST', url: `/v1/businesses/${biz}/customers`, headers: { ...AUTH, 'idempotency-key': crypto.randomUUID() }, payload: { email: 'r@a.com' } })
const cus = JSON.parse(cusR.body).id
const badSub = await app.inject({ method: 'POST', url: `/v1/businesses/${biz}/customers/${cus}/subscriptions`, headers: { ...AUTH, 'idempotency-key': crypto.randomUUID() }, payload: { items: [{ price: 'price_nonexistent' }] } })
ok('bad reference → clean envelope, no leak', badSub.statusCode === 404 && hasErrShape(badSub.body) && !leaksStack(badSub.body))

// 8) The global 500 handler itself: an unmatched body that slips past zod into a
//    downstream type error must still produce a clean 500 envelope (no stack leak).
//    Force it: vault a payment method for a customer that exists but with a token
//    tmtest accepts — then a refund of a non-existent payment id.
//    404 since 2026-08-28: `RefundError` carries a `code: 'not_found'` and the route
//    maps it to `notFound`, so a missing payment answers like every other missing
//    per-business object instead of like a malformed request. The assertion here is
//    about the ENVELOPE (shape, no stack) — the status is pinned by verify:bola.
const badRefund = await app.inject({ method: 'POST', url: `/v1/businesses/${biz}/payments/pay_nope/refund`, headers: { ...AUTH, 'idempotency-key': crypto.randomUUID() }, payload: {} })
ok('refund of missing payment → clean 404', badRefund.statusCode === 404 && hasErrShape(badRefund.body) && !leaksStack(badRefund.body))

await app.close()
let pass = true
for (const [n, c] of checks) { console.log(`  ${c ? '✓' : '✗'} ${n}`); if (!c) pass = false }
console.log('')
console.log(pass ? '✅ ROBUSTNESS: PASS' : '❌ ROBUSTNESS: FAIL')
await closeDb()
process.exit(pass ? 0 : 1)
