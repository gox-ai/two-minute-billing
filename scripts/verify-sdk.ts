/**
 * Proves the TypeScript SDK against the real server (booted in-process): drives
 * the full flow — org → business → product → price → customer → payment method →
 * subscription (billed) → invoice — entirely through the typed client.
 *
 *   pnpm verify:sdk
 */
import { buildApp } from '@/index'
import { closeDb } from '@/platform/db'
import { createOrganization } from '@/modules/tenancy/service'
import { Tmbilling, TmbillingError } from '../sdk/index'

const app = await buildApp({ logger: false })
await app.listen({ port: 0, host: '127.0.0.1' })
const addr = app.server.address() as { port: number }
const baseUrl = `http://127.0.0.1:${addr.port}`

// Mint an org + key (admin action), then use only the SDK from here on.
const org = await createOrganization({ name: 'SDK Org' })
const tmb = new Tmbilling({ apiKey: org.secret, baseUrl })

const me = await tmb.me()
console.log('me:', me.id, me.name)

const biz = await tmb.businesses.create({ name: 'Acme', default_currency: 'USD', livemode: 'test' })
const product = await tmb.products.create(biz.id, { name: 'Pro' })
const price = await tmb.prices.create(biz.id, {
  product: product.id, model: 'flat', currency: 'USD', amount_minor: 4900, interval: 'month',
})
const customer = await tmb.customers.create(biz.id, { email: 'sdk@a.com', first_name: 'SDK', last_name: 'User' })
const pm = await tmb.paymentMethods.create(biz.id, customer.id, { token: 'tok_4242' })
const sub = await tmb.subscriptions.create(biz.id, customer.id, { items: [{ price: price.id, quantity: 1 }] })
const invoices = await tmb.invoices.list(biz.id)

console.log(`biz=${biz.id} product=${product.id} price=${price.id}`)
console.log(`customer=${customer.id} pm=${pm.brand}/${pm.last4}`)
console.log(`sub=${sub.id} status=${sub.status} latest_invoice=${JSON.stringify(sub.latest_invoice)}`)
console.log(`invoices=${invoices.data.length} first=${invoices.data[0]?.status}/${invoices.data[0]?.total_minor}`)

// Typed error handling: a bad key must raise TmbillingError(401).
let unauthorized = false
try {
  await new Tmbilling({ apiKey: 'sk_test_bogus', baseUrl }).me()
} catch (e) {
  unauthorized = e instanceof TmbillingError && e.status === 401
}
console.log('bad key → TmbillingError 401:', unauthorized)

await app.close()

const pass =
  me.id.startsWith('org_') &&
  biz.id.startsWith('biz_') &&
  price.amount_minor === 4900 &&
  pm.last4 === '4242' &&
  sub.status === 'active' &&
  sub.latest_invoice?.total_minor === 4900 &&
  invoices.data.length === 1 &&
  invoices.data[0]?.status === 'paid' &&
  unauthorized

console.log('')
console.log(pass ? '✅ SDK: PASS' : '❌ SDK: FAIL')
await closeDb()
process.exit(pass ? 0 : 1)
