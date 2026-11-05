/**
 * PayPal WALLET (billing-agreement) off-session verification — the last PayPal leg
 * that had never been run.
 *
 * `verify:paypal-live` and `verify:paypal-tunnel` both vault a **card** setup token,
 * because a card token comes back APPROVED with no browser step. A **wallet** vault
 * (`usage_type: MERCHANT`) cannot: PayPal requires the buyer to approve the billing
 * agreement in a browser, so it was written off as untestable. Everything AFTER the
 * approval is scriptable though — and that is the part we actually need to trust:
 * that a buyer-approved wallet can be charged **off-session, with no buyer present**.
 *
 * This suite automates all of it and pauses for exactly one human action: open the
 * printed approval URL and approve as a PayPal **sandbox personal (buyer)** account.
 * It then polls PayPal until the setup token flips to APPROVED and continues:
 *
 *   initiateVaultSetupForBusiness (engine) → [human approves] → poll until APPROVED
 *   → vaultPaymentMethod (engine) → assert it vaulted as a WALLET, not a card
 *   → subscription billed through the ENGINE (billSubscriptionPeriod → collectInvoice)
 *   → assert cash booked with no buyer present → refund → assert the ledger reverses
 *   → delete the wallet vault at PayPal (cancels the billing agreement)
 *
 * Why it matters beyond PayPal-US: a PayPal **India** merchant cannot vault cards at
 * all (403 NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE), so the wallet billing agreement is
 * the ONLY off-session route there. Until this ran, that route was unproven.
 *
 * ## Running it
 * ```
 * pnpm verify:paypal-wallet
 * # …then open the printed URL and approve with a sandbox buyer account
 * PAYPAL_APPROVAL_WAIT_MS=900000 pnpm verify:paypal-wallet   # wait longer
 * ```
 * Sandbox only — refuses a non-sandbox PAYPAL_API_BASE. Trivial amounts ($9 / $4).
 */
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { config } from '@/platform/config'
import { withTenant, closeDb } from '@/platform/db'
import { createOrganization, createBusiness } from '@/modules/tenancy/service'
import { createCustomer } from '@/modules/customers/service'
import { createGatewayAccount } from '@/modules/gateway/service'
import {
  initiateVaultSetupForBusiness,
  vaultPaymentMethod,
  detachPaymentMethod,
} from '@/modules/payment-methods/service'
import { createProduct, createPrice } from '@/modules/catalog/service'
import { createSubscription } from '@/modules/subscriptions/service'
import { billSubscriptionPeriod } from '@/modules/invoicing/service'
import { refundPayment } from '@/modules/refunds/service'
import { ledgerEntries, payments } from '@db/schema'

const checks: [string, boolean, string?][] = []
const ok = (n: string, c: boolean, detail?: string) => {
  checks.push([n, c, detail])
  console.log(`  ${c ? '✅' : '❌'} ${n}${detail ? ` — ${detail}` : ''}`)
}
const warns: string[] = []
const warn = (m: string) => {
  warns.push(m)
  console.log(`  ⚠️  ${m}`)
}

const US_ID = config.PAYPAL_TEST_BUSINESS_US_CLIENT_ID
const US_SECRET = config.PAYPAL_TEST_BUSINESS_US_CLIENT_SECRET
if (!US_ID || !US_SECRET) {
  console.log('⊘ SKIP verify:paypal-wallet — PAYPAL_TEST_BUSINESS_US_CLIENT_ID/SECRET not set')
  process.exit(0)
}
if (!/sandbox/.test(config.PAYPAL_API_BASE)) {
  console.error(`REFUSING: PAYPAL_API_BASE=${config.PAYPAL_API_BASE} is not the sandbox`)
  process.exit(1)
}

const APPROVAL_WAIT_MS = Number(process.env.PAYPAL_APPROVAL_WAIT_MS ?? 600_000)
/** Resume with an ALREADY-APPROVED setup token (skips the mint + wait). */
const RESUME_TOKEN = process.env.PAYPAL_SETUP_TOKEN
const POLL_MS = 5_000
const CHARGE_MINOR = 900n // $9.00
const REFUND_MINOR = 400n // $4.00
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Raw sandbox call — used only to poll the setup token and re-read independently.
 *
 * Never throws on a non-JSON body: PayPal answers some vault reads with **204 and an
 * empty body** (measured on deleted payment tokens 2026-07-31, and seen while polling
 * an unapproved setup token), and a `JSON.parse('')` there would abort the whole run
 * mid-poll. Callers get `{status, json: {}}` and decide.
 */
async function raw(method: string, path: string): Promise<{ status: number; json: any }> {
  const basic = Buffer.from(`${US_ID}:${US_SECRET}`).toString('base64')
  const tokRes = await fetch(`${config.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  const tokText = await tokRes.text()
  const tok = (parseOrEmpty(tokText) ?? {}) as { access_token?: string }
  const res = await fetch(`${config.PAYPAL_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
  })
  return { status: res.status, json: parseOrEmpty(await res.text()) ?? {} }
}

function parseOrEmpty(text: string): any | undefined {
  const t = text.trim()
  if (!t) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

const acct = (orgId: string, account: string) =>
  withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.account, account))
    return rows.reduce((s, r) => s + (r.direction === 'debit' ? r.amountMinor : -r.amountMinor), 0n)
  })

async function main(): Promise<boolean> {
  // ── setup ─────────────────────────────────────────────────────────────────
  console.log('\n── setup ──')
  const org = await createOrganization({ name: 'PayPal Wallet Co' })
  const orgId = org.organization.id
  const biz = await createBusiness({
    organizationId: orgId, name: 'PPW Biz', defaultCurrency: 'USD', livemode: 'test',
  })
  const gwa = await createGatewayAccount({
    organizationId: orgId, businessId: biz.id, gatewayKey: 'paypal', label: 'PayPal Sandbox (US)',
    credentials: { client_id: US_ID!, client_secret: US_SECRET!, api_base: config.PAYPAL_API_BASE },
  })
  ok('gateway account created with real sandbox credentials', Boolean(gwa.publicId))

  const customer = await createCustomer({
    organizationId: orgId, businessId: biz.id, email: `ppw-${Date.now()}@example.invalid`,
    firstName: 'Wallet', lastName: 'Buyer',
  })
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: 'Wallet Plan' })
  const price = await createPrice({
    organizationId: orgId, businessId: biz.id, productId: product.id,
    type: 'recurring', model: 'flat', currency: 'USD', amountMinor: Number(CHARGE_MINOR), interval: 'month',
  })

  // ── resume path: consume a setup token that was already approved ──────────
  // The approval is a HUMAN step, so the window can lapse (mine did — the operator
  // approved a link from an earlier run whose process had already exited). Rather
  // than throw away a perfectly good approval, take the token id and skip straight
  // to the exchange. Also guards against resuming with a CARD token and believing
  // the wallet path was proven.
  if (RESUME_TOKEN) {
    console.log('\n── resuming with a pre-approved setup token ──')
    const { status, json } = await raw('GET', `/v3/vault/setup-tokens/${RESUME_TOKEN}`)
    ok(`setup token ${RESUME_TOKEN} is APPROVED (status=${json?.status ?? `HTTP_${status}`})`,
      json?.status === 'APPROVED')
    ok(`…and it is a WALLET agreement, not a card (usage_type=${json?.payment_source?.paypal?.usage_type})`,
      json?.payment_source?.paypal?.usage_type === 'MERCHANT')
    if (json?.status !== 'APPROVED' || json?.payment_source?.paypal?.usage_type !== 'MERCHANT') return false
    return await afterApproval({ orgId, biz, gwa, customer, price, setupTokenId: RESUME_TOKEN })
  }

  // ── the wallet setup token + its approval link ────────────────────────────
  console.log('\n── wallet vault setup (usage_type MERCHANT) ──')
  const { setup } = await initiateVaultSetupForBusiness({
    organizationId: orgId, businessId: biz.id, customer,
    returnUrl: 'https://example.invalid/paypal/return',
    cancelUrl: 'https://example.invalid/paypal/cancel',
    gatewayAccountId: gwa.publicId,
  })
  ok('engine minted a wallet setup token', Boolean(setup.setupTokenId), setup.setupTokenId)
  ok('setup returned a buyer-approval redirect (not a client_secret)',
    setup.mode === 'redirect' && Boolean(setup.approvalUrl))
  if (!setup.approvalUrl) return false

  console.log(`
${'═'.repeat(72)}
  ACTION REQUIRED — approve the billing agreement in a browser.

  ${setup.approvalUrl}

  Log in with a PayPal SANDBOX PERSONAL (buyer) account and approve. This is the
  one step production also does in a browser; everything after it is automated.
  Waiting up to ${Math.round(APPROVAL_WAIT_MS / 60000)} minutes…
${'═'.repeat(72)}
`)

  // ── poll PayPal until the buyer approves ──────────────────────────────────
  const deadline = Date.now() + APPROVAL_WAIT_MS
  let approved = false
  let lastStatus = 'unknown'
  const seen = new Map<string, number>() // status/HTTP code → count, for a compact trace
  while (Date.now() < deadline) {
    const { status, json } = await raw('GET', `/v3/vault/setup-tokens/${setup.setupTokenId}`)
    // A read can come back non-200 or bodiless (PayPal does this intermittently);
    // that is "no news", not a verdict — keep polling rather than aborting.
    const observed: string = json?.status ?? `HTTP_${status}`
    seen.set(observed, (seen.get(observed) ?? 0) + 1)
    if (json?.status) lastStatus = json.status
    if (lastStatus === 'APPROVED') {
      approved = true
      break
    }
    process.stdout.write(observed === 'PAYER_ACTION_REQUIRED' ? '·' : `[${observed}]`)
    await sleep(POLL_MS)
  }
  console.log(`\n  poll trace: ${[...seen].map(([k, v]) => `${k}×${v}`).join(', ')}`)
  ok(`buyer approved the billing agreement (status=${lastStatus})`, approved)
  if (!approved) {
    warn(`setup token never reached APPROVED within ${Math.round(APPROVAL_WAIT_MS / 60000)}m — ` +
      'nothing after this point could run. Re-run and approve the printed URL.')
    return false
  }

  return await afterApproval({ orgId, biz, gwa, customer, price, setupTokenId: setup.setupTokenId })
}

/**
 * Everything after the buyer approval — the part that is fully automatable, and the
 * part worth trusting. Split out so a lapsed approval window can be resumed with
 * `PAYPAL_SETUP_TOKEN=<approved id>` instead of asking for a second approval.
 */
async function afterApproval(a: {
  orgId: string
  biz: { id: string }
  gwa: { publicId: string }
  customer: Awaited<ReturnType<typeof createCustomer>>
  price: Awaited<ReturnType<typeof createPrice>>
  setupTokenId: string
}): Promise<boolean> {
  const { orgId, biz, gwa, customer, price } = a

  // ── exchange + vault through the engine ──────────────────────────────────
  console.log('\n── vault ──')
  const pm = await vaultPaymentMethod({
    organizationId: orgId, businessId: biz.id, customer,
    token: a.setupTokenId, gatewayAccountId: gwa.publicId,
  })
  ok('approved setup token exchanged for a permanent vault token', Boolean(pm.providerPaymentMethodId),
    pm.providerPaymentMethodId)
  // The whole point of the type: `charge` sends a wallet vault under
  // `payment_source.paypal` and a card under `payment_source.card`; the wrong key is
  // rejected 422 MISMATCHED_VAULT_ID_TO_PAYMENT_SOURCE.
  ok(`vaulted as a WALLET, not a card (type=${pm.type})`, pm.type === 'paypal')
  ok('payment method bound to the PayPal gateway account', pm.gatewayAccountId != null)

  // ── the off-session charge, through the ENGINE ────────────────────────────
  console.log('\n── off-session charge (no buyer present) ──')
  const cashBefore = await acct(orgId, 'cash')
  const sub = await createSubscription({
    organizationId: orgId, businessId: biz.id, customerId: customer.id, now: new Date(),
    items: [{ price, quantity: 1 }],
  })
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId, businessId: biz.id, subscription: sub.subscription,
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!, periodEnd: sub.subscription.currentPeriodEnd!,
  })
  const [pay] = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, invoice.id)).limit(1))
  ok('the wallet was charged off-session and produced a payment', pay != null)
  ok('payment carries PayPal\'s capture id', Boolean(pay?.providerChargeId), pay?.providerChargeId ?? undefined)

  // What PayPal actually did with the capture decides what our engine MUST have done.
  // A PayPal order flips to COMPLETED on capture, but the capture itself can sit
  // PENDING (`PENDING_REVIEW`, eCheck, manual action) — the money is not released and
  // PayPal may still DENY it. Booking cash there is a real loss of correctness, so
  // assert the two outcomes separately rather than assuming the happy one.
  const cap = await raw('GET', `/v2/payments/captures/${pay!.providerChargeId}`)
  const capStatus = cap.json?.status as string | undefined
  const capReason = cap.json?.status_details?.reason as string | undefined
  ok('PayPal\'s captured amount matches ours',
    cap.json?.amount?.value === '9.00' && cap.json?.amount?.currency_code === 'USD',
    `${cap.json?.amount?.currency_code} ${cap.json?.amount?.value}`)

  const cashAfterCharge = await acct(orgId, 'cash')
  if (capStatus === 'COMPLETED') {
    ok('capture COMPLETED at PayPal → payment succeeded', pay?.status === 'succeeded', pay?.status)
    ok(`capture COMPLETED → cash booked (+${cashAfterCharge - cashBefore})`,
      cashAfterCharge - cashBefore === CHARGE_MINOR)
    ok(`invoice paid (status=${invoice.status})`, invoice.status === 'paid')
  } else if (capStatus === 'PENDING') {
    // The bug this suite found: we used to read the ORDER status only, so a
    // review-held capture was reported succeeded and cash was booked for money
    // PayPal had not released.
    ok(`capture PENDING (${capReason}) → payment parked, NOT succeeded`, pay?.status === 'pending', pay?.status)
    ok('capture PENDING → no cash booked yet', cashAfterCharge - cashBefore === 0n,
      `cash delta ${cashAfterCharge - cashBefore}`)
    ok(`capture PENDING → invoice not marked paid (status=${invoice.status})`, invoice.status !== 'paid')
    warn(`PayPal held this capture for review (${capReason}). Settlement arrives as ` +
      'PAYMENT.CAPTURE.COMPLETED / .DENIED — the inbound path (verify:paypal-tunnel) covers that leg.')
  } else {
    ok(`capture status is one we handle (got ${capStatus})`, false, capReason)
  }
  const settledOk = capStatus === 'COMPLETED'

  // ── refund ────────────────────────────────────────────────────────────────
  // Only meaningful once the money has actually settled. Refunding a capture PayPal
  // is still reviewing would assert nothing about our ledger (there is no cash to
  // reverse), so skip rather than fake a pass.
  console.log('\n── refund ──')
  if (settledOk) {
    const refund = await refundPayment({
      organizationId: orgId, businessId: biz.id, paymentPublicId: pay!.publicId,
      amountMinor: Number(REFUND_MINOR), reason: 'verify:paypal-wallet',
    })
    ok(`partial refund accepted (status=${refund.status})`,
      refund.status === 'succeeded' || refund.status === 'pending')
    const cashAfterRefund = await acct(orgId, 'cash')
    ok(`cash reduced by the refund (${cashAfterCharge - cashAfterRefund})`,
      cashAfterCharge - cashAfterRefund === REFUND_MINOR)
  } else {
    warn('refund leg SKIPPED — the capture never settled, so there is no cash to reverse. ' +
      'Re-run when PayPal does not hold the capture for review (the card suites cover settled refunds).')
  }

  // ── delete the wallet vault (cancels the billing agreement) ───────────────
  console.log('\n── delete the wallet vault ──')
  const vaultId = pm.providerPaymentMethodId
  const beforeDelete = await raw('GET', `/v3/vault/payment-tokens/${vaultId}`)
  ok('vault token readable before delete', beforeDelete.status === 200)
  await detachPaymentMethod(orgId, customer.id, pm.publicId)
  const afterDelete = await raw('GET', `/v3/vault/payment-tokens/${vaultId}`)
  // Measured on cards 2026-07-31: PayPal answers a deleted token with 204, no body.
  ok(`billing agreement GONE at PayPal (status=${afterDelete.status})`,
    afterDelete.status !== 200 && afterDelete.json?.id == null)

  return checks.every(([, c]) => c)
}

let passed = false
try {
  passed = await main()
} catch (e) {
  console.error(`\n❌ threw: ${e instanceof Error ? e.stack : String(e)}`)
}

const failed = checks.filter(([, c]) => !c)
console.log(`\n${'─'.repeat(60)}`)
console.log(`${checks.length - failed.length}/${checks.length} checks passed, ${warns.length} warning(s)`)
if (warns.length) for (const w of warns) console.log(`  ⚠️  ${w}`)
if (failed.length) {
  console.log('\n❌ PAYPAL WALLET: FAIL')
  for (const [n, , d] of failed) console.log(`   - ${n}${d ? ` (${d})` : ''}`)
} else if (passed) {
  console.log('\n✅ PAYPAL WALLET (buyer-approved billing agreement → off-session charge): PASS')
}
await closeDb()
process.exit(passed && !failed.length ? 0 : 1)
