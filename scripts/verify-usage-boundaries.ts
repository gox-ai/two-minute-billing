/**
 * Usage metering boundary + dedup permutations (audit gaps):
 *  - window is [start, end): an event exactly at start is INCLUDED, at end EXCLUDED,
 *  - events just inside/outside the window,
 *  - idempotent ingestion: same idempotencyKey records once (no double count),
 *  - zero usage in a window → 0.
 *
 *   pnpm verify:usage-boundaries
 */
import { closeDb } from '@/platform/db'
import { createOrganization, createBusiness } from '@/modules/tenancy/service'
import { createCustomer } from '@/modules/customers/service'
import { createProduct, createPrice } from '@/modules/catalog/service'
import { createSubscription, getSubscriptionItems } from '@/modules/subscriptions/service'
import { recordUsage, aggregateUsage } from '@/modules/metering/service'

const org = await createOrganization({ name: 'UsageBoundaries' })
const orgId = org.organization.id
const biz = await createBusiness({ organizationId: orgId, name: 'Biz', defaultCurrency: 'USD' })
const customer = await createCustomer({ organizationId: orgId, businessId: biz.id, email: 'u@a.com' })
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: 'API' })
const price = await createPrice({ organizationId: orgId, businessId: biz.id, productId: product.id, type: 'recurring', model: 'usage', currency: 'USD', amountMinor: 1, interval: 'month', usageAggregation: 'sum' })
const sub = await createSubscription({ organizationId: orgId, businessId: biz.id, customerId: customer.id, now: new Date(), items: [{ price, quantity: 1 }] })
const item = (await getSubscriptionItems(orgId, sub.subscription.id))[0]!

const start = new Date('2026-03-01T00:00:00Z')
const end = new Date('2026-04-01T00:00:00Z')
const rec = (ts: string, qty: number, key?: string) =>
  recordUsage({ organizationId: orgId, businessId: biz.id, subscriptionItemId: item.id, quantity: qty, timestamp: new Date(ts), idempotencyKey: key })

const checks: Array<[string, boolean]> = []

// Window boundary events.
await rec('2026-02-28T23:59:59Z', 7)  // just before start → excluded
await rec('2026-03-01T00:00:00Z', 10) // exactly at start → INCLUDED (gte)
await rec('2026-03-15T12:00:00Z', 5)  // inside
await rec('2026-04-01T00:00:00Z', 99) // exactly at end → EXCLUDED (lt)
const sum = await aggregateUsage(orgId, item.id, start, end, 'sum')
console.log(`window [start,end): sum=${sum} (exp 15 = 10 at-start + 5 inside; 7 before & 99 at-end excluded)`)
checks.push(['start inclusive, end exclusive', sum === 15n])

// Idempotent dedup: same key recorded twice → counts once.
await rec('2026-03-10T00:00:00Z', 100, 'idem-A')
await rec('2026-03-10T00:00:00Z', 100, 'idem-A') // duplicate
const sumAfterDup = await aggregateUsage(orgId, item.id, start, end, 'sum')
console.log(`after duplicate idem-A (100 once): sum=${sumAfterDup} (exp 115 = 15 + 100 once)`)
checks.push(['idempotent usage dedup', sumAfterDup === 115n])

// Zero usage in a disjoint window.
const zStart = new Date('2027-01-01T00:00:00Z')
const zEnd = new Date('2027-02-01T00:00:00Z')
const zero = await aggregateUsage(orgId, item.id, zStart, zEnd, 'sum')
console.log(`empty window: sum=${zero} (exp 0)`)
checks.push(['empty window → 0', zero === 0n])

let pass = true
for (const [n, ok] of checks) { console.log(`  ${ok ? '✓' : '✗'} ${n}`); if (!ok) pass = false }
console.log('')
console.log(pass ? '✅ USAGE BOUNDARIES: PASS' : '❌ USAGE BOUNDARIES: FAIL')
await closeDb()
process.exit(pass ? 0 : 1)
