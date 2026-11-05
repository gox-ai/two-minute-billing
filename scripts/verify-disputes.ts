/**
 * Disputes / chargebacks (Tier-1) — full lifecycle + LEDGER.
 *
 * For two independently-charged, PAID invoices we drive:
 *   created → funds_withdrawn → { won | lost }
 * and assert the append-only ledger (ADR-004) in every branch:
 *   - funds_withdrawn: dr disputed_funds / cr cash (cash clawed back), invoice STILL paid,
 *   - won:            dr cash / cr disputed_funds (reversal; net dispute cash = 0),
 *   - lost:           dr dispute_losses / cr disputed_funds (asset realized to expense).
 * Plus: replay of funds_withdrawn (new event id) does NOT double-post, and every
 * posted ledger transaction balances (Σdebit = Σcredit per currency).
 *
 *   pnpm verify:disputes
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { withTenant, closeDb } from '@/platform/db'
import { createOrganization, createBusiness } from '@/modules/tenancy/service'
import { createGatewayAccount } from '@/modules/gateway/service'
import { createCustomer } from '@/modules/customers/service'
import { vaultPaymentMethod } from '@/modules/payment-methods/service'
import { createProduct, createPrice } from '@/modules/catalog/service'
import { createSubscription } from '@/modules/subscriptions/service'
import { billSubscriptionPeriod } from '@/modules/invoicing/service'
import { accountBalance } from '@/modules/ledger/service'
import { handleProviderEvent } from '@/modules/webhooks/inbound'
import { ledgerEntries, invoices, disputes } from '@db/schema'
import type { NormalizedProviderEvent } from '@/providers/types'

const checks: [string, boolean][] = []
const ok = (name: string, cond: boolean) => checks.push([name, cond])

/**
 * `provider_events` dedups on (provider_key, provider_event_id) PLATFORM-GLOBALLY,
 * not per org — so hardcoded event ids made this suite pass only on a DB that had
 * never run it: on every later run the first delivery came back `duplicate` and the
 * whole lifecycle silently no-op'd. Salt the ids per run.
 */
const RUN = randomUUID().slice(0, 8)

const org = await createOrganization({ name: 'Disputes Co' })
const orgId = org.organization.id
const biz = await createBusiness({ organizationId: orgId, name: 'D Biz', defaultCurrency: 'USD', livemode: 'test' })
await createGatewayAccount({ organizationId: orgId, businessId: biz.id, gatewayKey: 'tmtest', label: 'TM Test', credentials: {} })
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: 'Pro' })
const price = await createPrice({
  organizationId: orgId, businessId: biz.id, productId: product.id,
  type: 'recurring', model: 'flat', currency: 'USD', amountMinor: 10000, interval: 'month',
})

async function makePaidPayment(email: string) {
  const customer = await createCustomer({ organizationId: orgId, businessId: biz.id, email })
  await vaultPaymentMethod({ organizationId: orgId, businessId: biz.id, customer, token: 'tok_4242' })
  const sub = await createSubscription({
    organizationId: orgId, businessId: biz.id, customerId: customer.id, now: new Date(), items: [{ price, quantity: 1 }],
  })
  const { payment } = await billSubscriptionPeriod({
    organizationId: orgId, businessId: biz.id, subscription: sub.subscription,
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!, periodEnd: sub.subscription.currentPeriodEnd!,
  })
  return payment!
}

const bal = (account: string) => accountBalance(orgId, biz.id, account, 'USD')
const invoiceStatus = (invoiceId: string) =>
  withTenant(orgId, async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1))[0]?.status)

const disputeEv = (over: Partial<NormalizedProviderEvent> & Pick<NormalizedProviderEvent, 'providerEventId' | 'type' | 'providerDisputeId'>): NormalizedProviderEvent => ({
  providerChargeId: undefined, disputeReason: 'fraudulent', disputeStatus: null,
  disputeAmountMinor: 10000n, disputeCurrency: 'USD', evidenceDueBy: new Date(Date.now() + 7 * 864e5),
  occurredAt: new Date(), raw: {}, ...over,
})

// ── Scenario 1: LOST ───────────────────────────────────────────────────────────
{
  const payment = await makePaidPayment('lost@a.com')
  const charge = payment.providerChargeId!
  const dpId = 'dp_lost_1'
  const cashAfterCharge = await bal('cash')

  await handleProviderEvent('tmtest', disputeEv({ providerEventId: `ev_l_created_${RUN}`, type: 'dispute.created', providerDisputeId: dpId, providerChargeId: charge }), { businessId: biz.id })
  const [row0] = await withTenant(orgId, (tx) => tx.select().from(disputes).where(eq(disputes.providerDisputeId, dpId)).limit(1))
  ok('lost: dispute recorded on created', !!row0 && row0.status === 'needs_response')
  ok('lost: no ledger on created', (await bal('disputed_funds')) === 0n && (await bal('cash')) === cashAfterCharge)
  ok('lost: correlated to payment', row0?.paymentId === payment.id && row0?.invoiceId === payment.invoiceId)

  await handleProviderEvent('tmtest', disputeEv({ providerEventId: `ev_l_withdrawn_${RUN}`, type: 'dispute.funds_withdrawn', providerDisputeId: dpId, providerChargeId: charge }), { businessId: biz.id })
  ok('lost: disputed_funds +10000 after withdrawal', (await bal('disputed_funds')) === 10000n)
  ok('lost: cash clawed back 10000', (await bal('cash')) === cashAfterCharge - 10000n)
  ok('lost: invoice still PAID', (await invoiceStatus(payment.invoiceId!)) === 'paid')
  const [row1] = await withTenant(orgId, (tx) => tx.select().from(disputes).where(eq(disputes.providerDisputeId, dpId)).limit(1))
  ok('lost: status under_review + funds_withdrawn flag', row1?.status === 'under_review' && row1?.fundsWithdrawn === 'true')

  // Replay funds_withdrawn under a NEW event id → flag guard blocks double-post.
  await handleProviderEvent('tmtest', disputeEv({ providerEventId: `ev_l_withdrawn_replay_${RUN}`, type: 'dispute.funds_withdrawn', providerDisputeId: dpId, providerChargeId: charge }), { businessId: biz.id })
  ok('lost: replay does NOT double-post', (await bal('disputed_funds')) === 10000n && (await bal('cash')) === cashAfterCharge - 10000n)

  await handleProviderEvent('tmtest', disputeEv({ providerEventId: `ev_l_lost_${RUN}`, type: 'dispute.lost', providerDisputeId: dpId, providerChargeId: charge, disputeStatus: 'lost' }), { businessId: biz.id })
  ok('lost: disputed_funds cleared to 0', (await bal('disputed_funds')) === 0n)
  ok('lost: dispute_losses realized 10000', (await bal('dispute_losses')) === 10000n)
  ok('lost: cash stays gone', (await bal('cash')) === cashAfterCharge - 10000n)
  const [row2] = await withTenant(orgId, (tx) => tx.select().from(disputes).where(eq(disputes.providerDisputeId, dpId)).limit(1))
  ok('lost: status lost + closed', row2?.status === 'lost' && row2?.closedAt != null)
}

// ── Scenario 2: WON ──────────────────────────────────────────────────────────
{
  const payment = await makePaidPayment('won@a.com')
  const charge = payment.providerChargeId!
  const dpId = 'dp_won_1'
  const cashAfterCharge = await bal('cash')
  const disputedBefore = await bal('disputed_funds')

  await handleProviderEvent('tmtest', disputeEv({ providerEventId: `ev_w_created_${RUN}`, type: 'dispute.created', providerDisputeId: dpId, providerChargeId: charge }), { businessId: biz.id })
  await handleProviderEvent('tmtest', disputeEv({ providerEventId: `ev_w_withdrawn_${RUN}`, type: 'dispute.funds_withdrawn', providerDisputeId: dpId, providerChargeId: charge }), { businessId: biz.id })
  ok('won: disputed_funds +10000 after withdrawal', (await bal('disputed_funds')) === disputedBefore + 10000n)
  ok('won: cash clawed back 10000', (await bal('cash')) === cashAfterCharge - 10000n)

  await handleProviderEvent('tmtest', disputeEv({ providerEventId: `ev_w_won_${RUN}`, type: 'dispute.won', providerDisputeId: dpId, providerChargeId: charge, disputeStatus: 'won' }), { businessId: biz.id })
  ok('won: reversal — disputed_funds back to baseline', (await bal('disputed_funds')) === disputedBefore)
  ok('won: net dispute cash zero (cash restored)', (await bal('cash')) === cashAfterCharge)
  const [row] = await withTenant(orgId, (tx) => tx.select().from(disputes).where(eq(disputes.providerDisputeId, dpId)).limit(1))
  ok('won: status won + funds flag cleared', row?.status === 'won' && row?.fundsWithdrawn === 'false' && row?.closedAt != null)
}

// ── Global: every posted ledger transaction balances (Σdr = Σcr per currency) ──
{
  const allEntries = await withTenant(orgId, (tx) => tx.select().from(ledgerEntries))
  const byTxn = new Map<string, Map<string, bigint>>()
  for (const e of allEntries) {
    const m = byTxn.get(e.transactionId) ?? new Map<string, bigint>()
    m.set(e.currency, (m.get(e.currency) ?? 0n) + (e.direction === 'debit' ? e.amountMinor : -e.amountMinor))
    byTxn.set(e.transactionId, m)
  }
  let allBalanced = true
  for (const m of byTxn.values()) for (const net of m.values()) if (net !== 0n) allBalanced = false
  ok(`every ledger transaction balances (${byTxn.size} txns)`, allBalanced)
}

let pass = true
for (const [n, c] of checks) { console.log(` ${c ? '✓' : '✗'} ${n}`); if (!c) pass = false }
console.log('')
console.log(pass ? '✅ DISPUTES: PASS' : '❌ DISPUTES: FAIL')
await closeDb()
process.exit(pass ? 0 : 1)
