/**
 * Proves the JSON-file migration source: validation rejects bad files, and a
 * valid file imports plans/customers/subscriptions (+ linked card) with the same
 * guarantees — no charge on import, payment continuity, idempotent re-run.
 *
 *   pnpm verify:migrate-json
 */
import { eq, inArray } from 'drizzle-orm'
import { withTenant, closeDb } from '@/platform/db'
import { createOrganization, createBusiness } from '@/modules/tenancy/service'
import { JsonFileSource } from '@/modules/migration/json-file'
import { importFromSource } from '@/modules/migration/import'
import { runBillingClockTick } from '@/modules/subscriptions/renewal'
import { runWithClockScope } from '@/platform/clock'
import { subscriptions, invoices, payments, paymentMethods } from '@db/schema'

const fails: string[] = []
const check = (n: string, c: boolean) => { console.log(`  ${c ? '✓' : '✗'} ${n}`); if (!c) fails.push(n) }

// 1) Validation rejects malformed files (bad currency, missing fields, bad date).
let threw = false
try {
  new JsonFileSource({ plans: [{ id: 'p', name: 'P', amountMinor: 100, currency: 'DOLLARS', interval: 'month' }], customers: [], subscriptions: [] })
} catch { threw = true }
check('rejects invalid file (currency length)', threw)

threw = false
try {
  new JsonFileSource({ plans: [], customers: [], subscriptions: [{ id: 's', customerId: 'c', planId: 'p', currentTermEnd: 'not-a-date' }] })
} catch { threw = true }
check('rejects invalid file (bad date)', threw)

// 2) A valid file (one card-bearing customer with a closed term, one future).
const past = new Date(Date.now() - 60 * 60_000).toISOString()
const future = new Date(Date.now() + 30 * 24 * 3600_000).toISOString()
const fileObj = {
  plans: [{ id: 'pro', name: 'Pro', amountMinor: 4900, currency: 'usd', interval: 'month', intervalCount: 1 }],
  customers: [
    { id: 'c_carol', email: 'carol@x.com', name: 'Carol', paymentMethod: { provider: 'tmtest', providerCustomerId: 'tmcus_c', providerPaymentMethodId: 'tmpm_c', brand: 'visa', last4: '4242' } },
    { id: 'c_dave', email: 'dave@x.com', name: 'Dave' },
  ],
  subscriptions: [
    { id: 's_carol', customerId: 'c_carol', planId: 'pro', quantity: 1, status: 'active', currency: 'usd', currentTermEnd: past },
    { id: 's_dave', customerId: 'c_dave', planId: 'pro', quantity: 1, status: 'active', currency: 'usd', currentTermEnd: future },
  ],
}
const source = new JsonFileSource(fileObj, 'json')
check('currency normalized to upper', (await source.listCatalog()).prices[0]!.currency === 'USD')

const org = await createOrganization({ name: 'JSON Migrate Org' })
const orgId = org.organization.id
const biz = await createBusiness({ organizationId: orgId, name: 'Biz', defaultCurrency: 'USD', livemode: 'test' })

const r1 = await importFromSource({ organizationId: orgId, businessId: biz.id, source })
console.log(`  import: prices=${JSON.stringify(r1.counts.prices)} customers=${JSON.stringify(r1.counts.customers)} pms=${JSON.stringify(r1.counts.payment_methods)} subs=${JSON.stringify(r1.counts.subscriptions)}`)
check(
  'imported 1 plan, 2 customers, 1 pm, 2 subs',
  r1.counts.prices?.created === 1 && r1.counts.customers?.created === 2 && r1.counts.payment_methods?.created === 1 && r1.counts.subscriptions?.created === 2,
)

const snap = await withTenant(orgId, async (tx) => ({
  invCount: (await tx.select().from(invoices).where(eq(invoices.businessId, biz.id))).length,
  payCount: (await tx.select().from(payments).where(eq(payments.businessId, biz.id))).length,
  pms: await tx.select().from(paymentMethods).where(eq(paymentMethods.businessId, biz.id)),
  subs: await tx.select().from(subscriptions).where(eq(subscriptions.businessId, biz.id)),
}))
check('no charge on import (0 invoices, 0 payments)', snap.invCount === 0 && snap.payCount === 0)
check('Carol card linked + default', snap.pms.length === 1 && snap.pms[0]!.role === 'primary')

// 3) Payment continuity: tick → Carol's closed-term sub charges.
// SCOPED to this script's own business. An unscoped tick scans every org in the
// database, and it is bounded twice over — TICK_SCAN_LIMIT rows, TICK_PASS_BUDGET_MS
// of wall clock — so inside `verify:all`, where ~20 earlier suites have left their
// own due subscriptions behind, Carol sits at the back of a backlog and the pass can
// stop before reaching her. That failed as "Carol renewal charged", which reads like
// a billing bug and is really the harness billing other people's fixtures until it
// runs out of budget. Standalone it always passed, because the backlog was empty.
await runWithClockScope({ onlyBusinessId: biz.id, now: new Date() }, () => runBillingClockTick(new Date()))
const carolSub = snap.subs.find((s) => s.currentPeriodEnd! <= new Date())!
const after = await withTenant(orgId, async (tx) => {
  const invs = await tx.select().from(invoices).where(eq(invoices.subscriptionId, carolSub.id))
  const ids = invs.map((i) => i.id)
  const pays = ids.length ? await tx.select().from(payments).where(inArray(payments.invoiceId, ids)) : []
  return { invs, pays }
})
check('Carol renewal charged (paid invoice + payment)', after.invs.length === 1 && after.invs[0]!.status === 'paid' && after.pays.length === 1)

// 4) Idempotent re-run.
const r2 = await importFromSource({ organizationId: orgId, businessId: biz.id, source })
check(
  're-run idempotent (nothing re-created)',
  Object.values(r2.counts).every((c) => c.created === 0),
)

console.log('')
console.log(fails.length === 0 ? '✅ JSON MIGRATION: PASS' : `❌ JSON MIGRATION: FAIL (${fails.join(', ')})`)
await closeDb()
process.exit(fails.length === 0 ? 0 : 1)
