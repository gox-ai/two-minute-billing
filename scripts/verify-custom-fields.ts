/**
 * SET-4 — Custom fields verify suite.
 *
 * Custom fields are a DISTINCT subsystem from `metadata`: admin-defined, typed
 * fields (business-scoped) surfaced as `cf_<api_name>` on customers/subscriptions.
 * Proves: definition CRUD, per-type coercion, required + enum + unknown-key
 * enforcement, serializer flattening, RLS isolation across businesses, and that
 * archiving stops new writes while existing values still read.
 *
 *   pnpm verify:custom-fields
 */
import { closeDb } from '@/platform/db'
import { createOrganization, createBusiness } from '@/modules/tenancy/service'
import { createCustomer, updateCustomer, getCustomerByPublicId } from '@/modules/customers/service'
import { serializeCustomer } from '@/modules/customers/serialize'
import { createProduct, createPrice } from '@/modules/catalog/service'
import { createSubscription, updateSubscriptionSettings } from '@/modules/subscriptions/service'
import { serializeSubscription } from '@/modules/subscriptions/serialize'
import {
  createDefinition, listDefinitions, updateDefinition, archiveDefinition, getDefinition,
  CustomFieldError,
} from '@/modules/custom-fields/service'

const checks: Array<[string, boolean]> = []
const ok = (n: string, c: boolean) => checks.push([n, c])
async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false } catch (e) { return e instanceof CustomFieldError }
}

const org = await createOrganization({ name: 'CustomFields Org' })
const orgId = org.organization.id
const bizA = await createBusiness({ organizationId: orgId, name: 'Biz A', defaultCurrency: 'USD' })
const bizB = await createBusiness({ organizationId: orgId, name: 'Biz B', defaultCurrency: 'USD' })

// ── Definitions: one of every type on `customer` ────────────────────────────────
const mk = (apiName: string, dataType: 'string' | 'number' | 'boolean' | 'date' | 'enum', extra: Record<string, unknown> = {}) =>
  createDefinition({ organizationId: orgId, businessId: bizA.id, entityType: 'customer', apiName, label: apiName, dataType, ...extra })

await mk('po_number', 'string')
await mk('seats', 'number')
await mk('is_vip', 'boolean')
await mk('renews_on', 'date')
await mk('tier', 'enum', { enumOptions: ['bronze', 'silver', 'gold'], required: true })

const defs = await listDefinitions(orgId, bizA.id, { entityType: 'customer' })
ok('def: 5 customer definitions created', defs.length === 5)
ok('def: enum carries options', (defs.find((d) => d.apiName === 'tier')?.enumOptions as string[] | null)?.length === 3)

// api_name hygiene + config validation
ok('def: rejects cf_ prefix in api_name', await throws(() => mk('cf_bad', 'string')))
ok('def: rejects non-snake api_name', await throws(() => mk('Bad-Name', 'string')))
ok('def: rejects duplicate api_name on same entity', await throws(() => mk('po_number', 'string')))
ok('def: enum without options rejected', await throws(() => mk('grade', 'enum')))

// ── Values on a customer: coercion + flattening ─────────────────────────────────
const cus = await createCustomer({
  organizationId: orgId, businessId: bizA.id, email: 'cf@a.com',
  customFields: { cf_po_number: 'PO-88', cf_seats: '12', cf_is_vip: 'true', cf_renews_on: '2026-09-01T00:00:00Z', cf_tier: 'gold' },
})
const cf = cus.customFields as Record<string, unknown>
ok('value: string stored', cf.po_number === 'PO-88')
ok('value: number coerced from string', cf.seats === 12)
ok('value: boolean coerced from "true"', cf.is_vip === true)
ok('value: date coerced to YYYY-MM-DD', cf.renews_on === '2026-09-01')
ok('value: enum member accepted', cf.tier === 'gold')

const ser = serializeCustomer(cus) as Record<string, unknown>
ok('serialize: flattened cf_ keys present', ser.cf_po_number === 'PO-88' && ser.cf_seats === 12)
ok('serialize: custom_fields object present + distinct from metadata', !!ser.custom_fields && ser.metadata == null)

// ── Enforcement ─────────────────────────────────────────────────────────────────
ok('enforce: required tier missing → reject',
  await throws(() => createCustomer({ organizationId: orgId, businessId: bizA.id, email: 'x@a.com', customFields: { cf_po_number: 'P' } })))
ok('enforce: enum out-of-set → reject',
  await throws(() => createCustomer({ organizationId: orgId, businessId: bizA.id, email: 'y@a.com', customFields: { cf_tier: 'platinum' } })))
ok('enforce: unknown key → reject',
  await throws(() => createCustomer({ organizationId: orgId, businessId: bizA.id, email: 'z@a.com', customFields: { cf_tier: 'gold', cf_nope: 1 } })))
ok('enforce: non-numeric for number field → reject',
  await throws(() => createCustomer({ organizationId: orgId, businessId: bizA.id, email: 'w@a.com', customFields: { cf_tier: 'gold', cf_seats: 'lots' } })))

// ── Update merges + clears (required cannot be cleared) ─────────────────────────
const upd = await updateCustomer({ organizationId: orgId, businessId: bizA.id, customerPublicId: cus.publicId, customFields: { cf_po_number: 'PO-99' } })
const ucf = upd!.customFields as Record<string, unknown>
ok('update: provided key changed', ucf.po_number === 'PO-99')
ok('update: untouched keys preserved (merge)', ucf.tier === 'gold' && ucf.seats === 12)
const cleared = await updateCustomer({ organizationId: orgId, businessId: bizA.id, customerPublicId: cus.publicId, customFields: { cf_seats: null } })
ok('update: null clears a non-required key', (cleared!.customFields as Record<string, unknown>).seats === undefined)
ok('update: clearing a required key → reject',
  await throws(() => updateCustomer({ organizationId: orgId, businessId: bizA.id, customerPublicId: cus.publicId, customFields: { cf_tier: null } })))

// ── Subscriptions round-trip ────────────────────────────────────────────────────
await createDefinition({ organizationId: orgId, businessId: bizA.id, entityType: 'subscription', apiName: 'region', dataType: 'enum', label: 'Region', enumOptions: ['us', 'eu'] })
const prod = await createProduct({ organizationId: orgId, businessId: bizA.id, name: 'Plan' })
const price = await createPrice({ organizationId: orgId, businessId: bizA.id, productId: prod.id, type: 'recurring', model: 'flat', currency: 'USD', amountMinor: 1000, interval: 'month' })
const subCus = await createCustomer({ organizationId: orgId, businessId: bizA.id, email: 'sub@a.com', customFields: { cf_tier: 'silver' } })
const { subscription } = await createSubscription({
  organizationId: orgId, businessId: bizA.id, customerId: subCus.id, now: new Date(Date.UTC(2026, 0, 1)),
  items: [{ price, quantity: 1 }], customFields: { cf_region: 'eu' },
})
ok('sub: create stored + flattened cf', (subscription.customFields as Record<string, unknown>).region === 'eu'
  && (serializeSubscription(subscription, bizA) as Record<string, unknown>).cf_region === 'eu')
const subUpd = await updateSubscriptionSettings({ organizationId: orgId, businessId: bizA.id, subscriptionPublicId: subscription.publicId, customFields: { cf_region: 'us' } })
ok('sub: settings update changes cf', (subUpd!.customFields as Record<string, unknown>).region === 'us')
ok('sub: unknown cf on subscription rejected',
  await throws(() => updateSubscriptionSettings({ organizationId: orgId, businessId: bizA.id, subscriptionPublicId: subscription.publicId, customFields: { cf_nope: 1 } })))

// ── RLS / scope isolation: Biz A defs invisible to Biz B ────────────────────────
const bDefs = await listDefinitions(orgId, bizB.id, { entityType: 'customer' })
ok('scope: business B sees none of A\'s definitions', bDefs.length === 0)
ok('scope: same api_name can be defined independently in B',
  !!(await createDefinition({ organizationId: orgId, businessId: bizB.id, entityType: 'customer', apiName: 'po_number', dataType: 'string', label: 'PO' })))
ok('scope: B cannot set A-only field on its customer',
  await throws(() => createCustomer({ organizationId: orgId, businessId: bizB.id, email: 'b@b.com', customFields: { cf_tier: 'gold' } })))

// ── Archive: rejects new values, existing values still read ─────────────────────
const poDef = defs.find((d) => d.apiName === 'po_number')!
await archiveDefinition(orgId, bizA.id, poDef.publicId)
ok('archive: definition marked archived', (await getDefinition(orgId, bizA.id, poDef.publicId))!.archived === true)
const readBack = await getCustomerByPublicId(orgId, bizA.id, cus.publicId)
ok('archive: existing stored value still reads', (readBack!.customFields as Record<string, unknown>).po_number === 'PO-99')
ok('archive: setting archived field rejected',
  await throws(() => updateCustomer({ organizationId: orgId, businessId: bizA.id, customerPublicId: cus.publicId, customFields: { cf_po_number: 'PO-100' } })))

// ── updateDefinition guards ──────────────────────────────────────────────────────
const enumDef = defs.find((d) => d.apiName === 'tier')!
const relabeled = await updateDefinition({ organizationId: orgId, businessId: bizA.id, publicId: enumDef.publicId, label: 'Account Tier' })
ok('def-update: label edit applied', relabeled!.label === 'Account Tier')

let pass = true
for (const [n, c] of checks) { console.log(`  ${c ? '✓' : '✗'} ${n}`); if (!c) pass = false }
console.log('')
console.log(pass ? '✅ CUSTOM FIELDS: PASS' : '❌ CUSTOM FIELDS: FAIL')
await closeDb()
process.exit(pass ? 0 : 1)
