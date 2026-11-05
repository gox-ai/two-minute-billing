/**
 * Security: an inbound webhook is processed ONLY if it is genuinely signed.
 *
 * An inbound webhook is a money-moving instruction from outside — `charge.succeeded` marks an
 * invoice paid. Signature verification is the entire trust boundary on that path, so this suite
 * exists to prove the boundary is real in both directions.
 *
 * ── WHY THIS SUITE GREW (2026-08-28) ────────────────────────────────────────────
 * It used to post ONLY bogus signatures and assert 400. That is half a test, and the missing
 * half is the dangerous one: **a verifier that rejected everything would have passed it.** A
 * webhook path that refuses valid events is not "secure", it is broken — invoices silently stop
 * being marked paid — and nothing here could tell the two apart. Every negative case below is
 * now paired with a POSITIVE control that must be ACCEPTED.
 *
 * It also only ever exercised Stripe. Razorpay and PayPal use completely different schemes
 * (shared-secret HMAC over the raw body; RSA against a certificate PayPal names in a header),
 * so Stripe passing said nothing whatsoever about the other two.
 *
 * ── WHAT IS AND IS NOT COVERED ──────────────────────────────────────────────────
 * Everything here is local: no network, no real provider call. That is a deliberate limit and
 * it costs one case — a genuine PayPal-signed transmission cannot be manufactured offline, so
 * PayPal has negatives and no positive control. Its negatives are still worth locking: the
 * cert-URL host pin is what stops a caller pointing verification at a certificate they own.
 *
 *   pnpm verify:webhook-security
 */
import { createHmac } from 'node:crypto'
import { buildApp } from '@/index'
import { closeDb } from '@/platform/db'
import { createOrganization, createBusiness } from '@/modules/tenancy/service'
import { createGatewayAccount } from '@/modules/gateway/service'

const app = await buildApp({ logger: false })

const checks: [string, boolean, string][] = []
const ok = (name: string, pass: boolean, detail = '') => checks.push([name, pass, detail])

const org = await createOrganization({ name: 'Webhook Security Co' })
const biz = await createBusiness({
  organizationId: org.organization.id, name: 'WS Biz', defaultCurrency: 'USD', livemode: 'test',
})

/** Two Stripe accounts with DIFFERENT secrets, so "signed, but by someone else" is testable. */
const STRIPE_SECRET_A = 'whsec_websecurity'
const STRIPE_SECRET_B = 'whsec_a_different_account_entirely'
const acct = await createGatewayAccount({
  organizationId: org.organization.id, businessId: biz.id, gatewayKey: 'stripe',
  label: 'Stripe (security probe)',
  credentials: { secret_key: 'sk_test_websecurity', webhook_secret: STRIPE_SECRET_A },
})

const RZP_SECRET_A = 'rzpwhsec_websecurity'
const RZP_SECRET_B = 'rzpwhsec_someone_else'
const rzpAcct = await createGatewayAccount({
  organizationId: org.organization.id, businessId: biz.id, gatewayKey: 'razorpay',
  label: 'Razorpay (security probe)',
  credentials: { key_id: 'rzp_test_websecurity', key_secret: 'x', webhook_secret: RZP_SECRET_A },
})

const paypalAcct = await createGatewayAccount({
  organizationId: org.organization.id, businessId: biz.id, gatewayKey: 'paypal',
  label: 'PayPal (security probe)',
  credentials: { client_id: 'ppclient', client_secret: 'ppsecret', webhook_id: 'WH-websecurity' },
})

async function post(path: string, headers: Record<string, string>, body: string) {
  const res = await app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  })
  return res.statusCode
}

/**
 * The refusal REASON, not just the status — and § C cannot do without it.
 *
 * ⚠ This exists because the first version of § C passed for the wrong reason, and the mutation
 * test is what exposed it. Deleting PayPal's cert-URL host pin outright left all five pin
 * assertions GREEN: with the pin gone, verification goes on to FETCH the attacker's certificate,
 * that fetch fails, and the request is refused anyway — same 400, completely different control.
 * A status code cannot tell "we refused to look at that host" from "we looked and the network
 * said no", so asserting on the status alone was asserting nothing about the pin.
 */
async function refusalReason(path: string, headers: Record<string, string>, body: string) {
  const res = await app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  })
  let message = ''
  try {
    message = (JSON.parse(res.body) as { error?: { message?: string } }).error?.message ?? ''
  } catch {
    message = res.body.slice(0, 200)
  }
  return { status: res.statusCode, message }
}

/**
 * The positive controls carry an event type this engine does NOT map.
 *
 * That is the point, not a shortcut: the assertion is about the SIGNATURE, and a mapped
 * money-moving event would drag invoice correlation and ledger posting into the result. A 500
 * from downstream handling would then read as "signature rejected", and a green run would
 * depend on fixture state that has nothing to do with authenticity.
 */
const UNMAPPED_STRIPE = JSON.stringify({ id: 'evt_ws_positive', type: 'customer.updated', data: { object: {} } })
const UNMAPPED_RZP = JSON.stringify({ event: 'customer.updated', payload: {} })

const stripeUrl = (id: string) => `/v1/gateway_webhooks/stripe?id=${id}`
const rzpUrl = (id: string) => `/v1/gateway_webhooks/razorpay?id=${id}`

/** Stripe's scheme: `t=<unix>,v1=<hmac-sha256(secret, "<t>.<payload>")>`. */
const stripeSig = (secret: string, payload: string, atSeconds = Math.floor(Date.now() / 1000)) =>
  `t=${atSeconds},v1=${createHmac('sha256', secret).update(`${atSeconds}.${payload}`).digest('hex')}`

/** Razorpay's scheme: hex HMAC-SHA256 of the RAW body, nothing else. */
const rzpSig = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload).digest('hex')

const accepted = (s: number) => s >= 200 && s < 300

// ── § A · Stripe ─────────────────────────────────────────────────────────────────
{
  const url = stripeUrl(acct.publicId)

  // THE POSITIVE CONTROL. Without this the whole section passes for a verifier that
  // refuses everything, which is a broken payment path rather than a secure one.
  const valid = await post(url, { 'stripe-signature': stripeSig(STRIPE_SECRET_A, UNMAPPED_STRIPE) }, UNMAPPED_STRIPE)
  ok('§A stripe: a CORRECTLY signed event is ACCEPTED', accepted(valid), `status ${valid}`)

  const tampered = await post(url, { 'stripe-signature': 't=1,v1=deadbeef' }, UNMAPPED_STRIPE)
  ok('§A stripe: a garbage signature is refused (400)', tampered === 400, `status ${tampered}`)

  const missing = await post(url, {}, UNMAPPED_STRIPE)
  ok('§A stripe: NO signature header is refused (400)', missing === 400, `status ${missing}`)

  // Signed correctly, then the body changed. This is the attack the signature exists to stop,
  // and it is distinct from "garbage signature": every byte here is well-formed.
  const sig = stripeSig(STRIPE_SECRET_A, UNMAPPED_STRIPE)
  const swapped = JSON.stringify({ id: 'evt_ws_positive', type: 'charge.succeeded', data: { object: {} } })
  const bodySwap = await post(url, { 'stripe-signature': sig }, swapped)
  ok('§A stripe: a valid signature over a DIFFERENT body is refused (400)', bodySwap === 400, `status ${bodySwap}`)

  // Signed perfectly — by another account. Cross-tenant authenticity: holding one business's
  // webhook secret must not let you post events into another's.
  const foreign = await post(url, { 'stripe-signature': stripeSig(STRIPE_SECRET_B, UNMAPPED_STRIPE) }, UNMAPPED_STRIPE)
  ok("§A stripe: signed with ANOTHER account's secret is refused (400)", foreign === 400, `status ${foreign}`)

  // Validly signed, but old. Stripe's SDK enforces a 5-minute tolerance; without it a captured
  // event could be replayed forever.
  const stale = await post(
    url,
    { 'stripe-signature': stripeSig(STRIPE_SECRET_A, UNMAPPED_STRIPE, Math.floor(Date.now() / 1000) - 3600) },
    UNMAPPED_STRIPE,
  )
  ok('§A stripe: a validly signed but STALE event is refused (replay window)', stale === 400, `status ${stale}`)

  // Attribution. A request that names no account cannot be verified against any secret, and one
  // that names a missing account must not fall back to "some account of that gateway".
  const noAccount = await post('/v1/gateway_webhooks/stripe', { 'stripe-signature': 't=1,v1=deadbeef' }, UNMAPPED_STRIPE)
  ok('§A stripe: an un-attributable request is refused (404), not guessed at', noAccount === 404, `status ${noAccount}`)
  const unknown = await post(stripeUrl('gwa_does_not_exist'), { 'stripe-signature': 't=1,v1=deadbeef' }, UNMAPPED_STRIPE)
  ok('§A stripe: an unknown gateway account is refused (404)', unknown === 404, `status ${unknown}`)
}

// ── § B · Razorpay — a different scheme entirely ─────────────────────────────────
//
// Stripe passing proves nothing here: this is a hex HMAC over the raw body with no timestamp,
// compared with `timingSafeEqual`. It had no coverage at all before this.
{
  const url = rzpUrl(rzpAcct.publicId)

  const valid = await post(url, { 'x-razorpay-signature': rzpSig(RZP_SECRET_A, UNMAPPED_RZP) }, UNMAPPED_RZP)
  ok('§B razorpay: a CORRECTLY signed event is ACCEPTED', accepted(valid), `status ${valid}`)

  const tampered = await post(url, { 'x-razorpay-signature': 'deadbeef' }, UNMAPPED_RZP)
  ok('§B razorpay: a garbage signature is refused (400)', tampered === 400, `status ${tampered}`)

  const missing = await post(url, {}, UNMAPPED_RZP)
  ok('§B razorpay: NO signature header is refused (400)', missing === 400, `status ${missing}`)

  const sig = rzpSig(RZP_SECRET_A, UNMAPPED_RZP)
  const swapped = JSON.stringify({ event: 'payment.captured', payload: {} })
  const bodySwap = await post(url, { 'x-razorpay-signature': sig }, swapped)
  ok('§B razorpay: a valid signature over a DIFFERENT body is refused (400)', bodySwap === 400, `status ${bodySwap}`)

  const foreign = await post(url, { 'x-razorpay-signature': rzpSig(RZP_SECRET_B, UNMAPPED_RZP) }, UNMAPPED_RZP)
  ok("§B razorpay: signed with ANOTHER account's secret is refused (400)", foreign === 400, `status ${foreign}`)

  // The comparison is length-then-timingSafeEqual, so a signature of the wrong LENGTH takes a
  // different branch from one of the right length. Both must refuse.
  const short = await post(url, { 'x-razorpay-signature': 'ab' }, UNMAPPED_RZP)
  ok('§B razorpay: a wrong-LENGTH signature is refused, not crashed on', short === 400, `status ${short}`)
}

// ── § C · PayPal — no shared secret, so the cert URL is the trust boundary ───────
//
// PayPal signs with RSA and tells us which certificate to verify against, in a header. The
// adapter pins that URL to a paypal.com host BEFORE fetching it — without the pin, a caller
// points verification at a certificate they control and signs whatever they like.
//
// No positive control: a genuine PayPal-signed transmission cannot be manufactured offline.
// Stated rather than quietly omitted, because an all-negative section is exactly the shape this
// suite was rewritten to distrust.
{
  const url = `/v1/gateway_webhooks/paypal?id=${paypalAcct.publicId}`
  const body = JSON.stringify({ id: 'WH-evt', event_type: 'CUSTOMER.UPDATED', resource: {} })
  const headersFor = (certUrl: string) => ({
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': certUrl,
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-sig': Buffer.from('fakesignature').toString('base64'),
    'paypal-transmission-time': new Date().toISOString(),
  })

  const noHeaders = await post(url, {}, body)
  ok('§C paypal: a transmission with no signature headers is refused', noHeaders === 400, `status ${noHeaders}`)

  const partial = await post(url, { 'paypal-auth-algo': 'SHA256withRSA' }, body)
  ok('§C paypal: PARTIAL transmission headers are refused', partial === 400, `status ${partial}`)

  // The pin, probed the way someone would actually attack it. Each of these is a URL that
  // looks like PayPal to a careless check:
  //   - a host that merely CONTAINS the string
  //   - a subdomain-looking prefix on an attacker domain
  //   - http:// instead of https://
  //   - a userinfo trick, where the real host is after the '@'
  for (const [label, certUrl, expect] of [
    ['a lookalike host (notpaypal.com)', 'https://notpaypal.com/cert.pem', 'host'],
    ['a suffix trick (paypal.com.attacker.test)', 'https://paypal.com.attacker.test/cert.pem', 'host'],
    ['an attacker subdomain (api.paypal.com.evil.test)', 'https://api.paypal.com.evil.test/cert.pem', 'host'],
    ['plain http on the real host', 'http://api.paypal.com/cert.pem', 'url'],
    ['userinfo hiding the real host', 'https://api.paypal.com@attacker.test/cert.pem', 'host'],
  ] as const) {
    const { status, message } = await refusalReason(url, headersFor(certUrl), body)
    // Assert the REASON, not just the 400. See `refusalReason` — the status alone cannot tell
    // the pin refusing to look from a failed fetch of the attacker's certificate, and a pin
    // deleted outright left this whole block green when it only checked the status.
    const byThePin =
      expect === 'host'
        ? /cert_url host is not PayPal/.test(message)
        : /cert_url is not a valid https URL/.test(message)
    ok(
      `§C paypal: cert_url pin rejects ${label} — and rejects it BY THE PIN`,
      status === 400 && byThePin,
      `status ${status}, message ${JSON.stringify(message.slice(0, 120))}`,
    )
  }

  // The complement, and the reason the assertions above are about the pin rather than about
  // PayPal being unreachable: the REAL host gets PAST the pin and fails later, for a different
  // stated reason. Without this, a pin that rejected every URL — including PayPal's own — would
  // satisfy every case above while breaking every genuine webhook.
  const realHost = await refusalReason(url, headersFor('https://api.paypal.com/cert.pem'), body)
  ok(
    "§C paypal: the REAL host gets past the pin (it fails later, not at the pin)",
    realHost.status === 400 && !/cert_url host is not PayPal/.test(realHost.message),
    `message ${JSON.stringify(realHost.message.slice(0, 120))}`,
  )
}

// ── § D · the one that must hold across every provider ───────────────────────────
{
  // Nothing above was processed except the two deliberate positive controls. Stated as its own
  // assertion because it is the property that actually matters: a 400 on the wrong branch and a
  // 200 on the wrong branch are not equally bad.
  const refusalNames = checks.filter(([n]) => !n.includes('ACCEPTED'))
  ok(
    '§D every non-positive case was REFUSED — nothing forged was ever processed',
    refusalNames.every(([, pass]) => pass),
    refusalNames.filter(([, p]) => !p).map(([n]) => n).join('; '),
  )
}

let failed = 0
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
console.log(
  failed === 0
    ? `\n✅ WEBHOOK SECURITY: PASS (${checks.length} checks)`
    : `\n❌ WEBHOOK SECURITY: FAIL — ${failed} of ${checks.length}`,
)
await app.close()
await closeDb()
process.exit(failed === 0 ? 0 : 1)
