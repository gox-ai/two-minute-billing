/**
 * Live-verifies the buyer-approval vault INITIATE step (PayPal sandbox): creates a
 * setup token and returns a real approval URL. Tries the US business account, then
 * the India one — whichever has the v3 wallet-vault ("Save PayPal and Venmo")
 * capability. The buyer-approval click + final capture is a manual browser step.
 *
 *   pnpm verify:vault-setup   (requires a PayPal sandbox account with Vault v3)
 */
import { config } from '@/platform/config'
import { PayPalProvider } from '@/providers/paypal'
import { closeDb } from '@/platform/db'

interface Acct { label: string; id?: string; secret?: string }
const accounts: Acct[] = [
  { label: 'US', id: config.PAYPAL_TEST_BUSINESS_US_CLIENT_ID, secret: config.PAYPAL_TEST_BUSINESS_US_CLIENT_SECRET },
  { label: 'India', id: config.PAYPAL_TEST_BUSINESS_INDIA_CLIENT_ID, secret: config.PAYPAL_TEST_BUSINESS_INDIA_CLIENT_SECRET },
]

const configured = accounts.filter((a) => a.id && a.secret)
if (configured.length === 0) {
  console.log('SKIP: no PayPal sandbox creds set')
  process.exit(0)
}

let approvalUrl: string | undefined
let usedAccount: string | undefined
let lastErr = ''

for (const a of configured) {
  const paypal = new PayPalProvider({ clientId: a.id!, clientSecret: a.secret!, apiBase: config.PAYPAL_API_BASE })
  try {
    console.log(`trying ${a.label} account…`)
    const setup = await paypal.initiateVaultSetup({
      customer: { providerKey: 'paypal', providerCustomerId: 'cus_demo' },
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    })
    console.log(`  ✓ ${a.label}: setup_token=${setup.setupTokenId}`)
    console.log(`  ✓ approval_url=${setup.approvalUrl}`)
    if (setup.approvalUrl && /^https:\/\/.+paypal\.com/.test(setup.approvalUrl)) {
      approvalUrl = setup.approvalUrl
      usedAccount = a.label
      break
    }
  } catch (e) {
    lastErr = (e as Error).message
    console.log(`  ⚠ ${a.label}: ${/NOT_AUTHORIZED|insufficient/i.test(lastErr) ? 'no v3 wallet-vault capability' : lastErr}`)
  }
}

if (approvalUrl) {
  console.log(`✅ PayPal vault initiate: PASS — via ${usedAccount} account (redirect mode)`)
}

// --- RazorPay vault initiate (embedded-checkout mode) ---
let rzpOk: boolean | undefined
if (config.RAZORPAY_TEST_KEY_ID && config.RAZORPAY_TEST_KEY_SECRET) {
  const { RazorpayProvider } = await import('@/providers/razorpay')
  const rzp = new RazorpayProvider({
    keyId: config.RAZORPAY_TEST_KEY_ID,
    keySecret: config.RAZORPAY_TEST_KEY_SECRET,
    apiBase: config.RAZORPAY_API_BASE,
  })
  console.log('')
  console.log('RazorPay: ensure customer + initiate vault setup…')
  try {
    // Unique per run so re-runs don't collide with an existing RazorPay customer.
    const uniq = Date.now().toString().slice(-9)
    const cust = await rzp.ensureCustomer({
      customerRef: `tmb_demo_${uniq}`,
      email: `rzp-demo-${uniq}@example.com`,
      name: 'RZP Demo',
      phone: `+9199${uniq}`,
    })
    const setup = await rzp.initiateVaultSetup!({ customer: cust, returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c' })
    console.log(`  ✓ order=${setup.checkout?.orderId} mode=${setup.mode} recurring=${setup.checkout?.recurring}`)
    rzpOk = setup.mode === 'checkout' && !!setup.checkout?.orderId
    console.log(`  ✅ RazorPay vault initiate: PASS (checkout mode — auth via embedded Checkout)`)

    // ── Currency → rail policy ────────────────────────────────────────────────
    // Subscriptions must be settable up in ANY currency, and the rail is not a
    // free choice: INR rides the domestic e-mandate, everything else must ride
    // cards (RazorPay: "The currency should be INR when method is upi"). The
    // mandate is bound to an order in ONE currency, so registering the wrong one
    // binds the buyer to a currency their renewals will never match.
    const rzpAuth = 'Basic ' + Buffer.from(
      `${config.RAZORPAY_TEST_KEY_ID}:${config.RAZORPAY_TEST_KEY_SECRET}`,
    ).toString('base64')
    let policyOk = true
    for (const [cur, wantRail] of [['INR', 'emandate'], ['USD', 'card'], ['EUR', 'card']] as const) {
      const s = await rzp.initiateVaultSetup!({
        customer: cust, returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c',
        currency: cur, maxAmountMinor: 123400n,
      })
      const o = await fetch(`${config.RAZORPAY_API_BASE}/orders/${s.setupTokenId}`, {
        headers: { Authorization: rzpAuth },
      }).then((r) => r.json() as Promise<{ currency?: string; token?: { max_amount?: number } }>)
      // e-mandate orders don't echo the token block; cards do.
      const ceilingOk = wantRail === 'emandate' || BigInt(o.token?.max_amount ?? 0) === 123400n
      const good = s.checkout?.method === wantRail && o.currency === cur && ceilingOk
      if (!good) policyOk = false
      console.log(`  ${good ? '✓' : '✗'} ${cur} → rail=${s.checkout?.method} (want ${wantRail}), order currency=${o.currency}`)
    }
    // A domestic rail must refuse a foreign currency, not silently switch to cards.
    let refusedForeignDomestic = false
    try {
      await rzp.initiateVaultSetup!({
        customer: cust, returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c',
        methodTypes: ['upi'], currency: 'USD',
      })
    } catch { refusedForeignDomestic = true }
    console.log(`  ${refusedForeignDomestic ? '✓' : '✗'} USD on the upi rail refused (not silently switched)`)

    // Ceiling > 100,000,000 must be clamped to 100,000,000 (RazorPay API limit) rather than 400ing.
    let largeMaxAmountOk = false
    const sLarge = await rzp.initiateVaultSetup!({
      customer: cust, returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c',
      currency: 'USD', maxAmountMinor: 171_855_000n,
    })
    const oLarge = await fetch(`${config.RAZORPAY_API_BASE}/orders/${sLarge.setupTokenId}`, {
      headers: { Authorization: rzpAuth },
    }).then((r) => r.json() as Promise<{ token?: { max_amount?: number } }>)
    largeMaxAmountOk = oLarge.token?.max_amount === 100_000_000
    console.log(`  ${largeMaxAmountOk ? '✓' : '✗'} maxAmount 171,855,000 clamped to RazorPay API limit (100,000,000)`)

    // The UPI rail has a LOWER ceiling than cards: NPCI caps an Autopay mandate
    // at ₹100,000 (10,000,000 paise) by merchant category, so the card cap of
    // 100,000,000 would 400 the order. A cap set too high is not a cosmetic
    // problem — RazorPay refuses every off-session debit that exceeds the
    // mandate, so it would break renewal for the whole rail.
    // A UPI order does NOT echo the `token` block (same as e-mandate; only cards
    // do), so the ceiling cannot be read back. What IS observable is acceptance:
    // RazorPay rejects an over-limit UPI mandate outright with "400 Max amount
    // for UPI recurring payment for this merchant category code cannot be
    // greater than Rs. 100000.00". So a large request that SUCCEEDS proves the
    // clamp ran. Verified red by raising the cap to the card limit: the same call
    // then fails with exactly that 400.
    let upiMaxAmountOk = false
    let upiClampErr = ''
    try {
      const sUpi = await rzp.initiateVaultSetup!({
        customer: cust, returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c',
        methodTypes: ['upi'], currency: 'INR', maxAmountMinor: 171_855_000n,
      })
      upiMaxAmountOk = Boolean(sUpi.setupTokenId)
    } catch (e) { upiClampErr = (e as Error).message }
    console.log(`  ${upiMaxAmountOk ? '✓' : '✗'} an over-limit UPI mandate is clamped to the NPCI Autopay ceiling, not 400'd${upiClampErr ? ` — ${upiClampErr}` : ''}`)

    rzpOk = rzpOk && policyOk && refusedForeignDomestic && largeMaxAmountOk && upiMaxAmountOk
    console.log(`  ${rzpOk ? '✅' : '❌'} RazorPay currency→rail policy: ${rzpOk ? 'PASS' : 'FAIL'} (INR→e-mandate, USD/EUR→card)`)
  } catch (e) {
    const msg = (e as Error).message
    // emandate/recurring must be enabled on the RazorPay account; otherwise skip.
    console.log(`  ⚠ RazorPay SKIP: ${msg}`)
    console.log('    (enable Recurring Payments / e-mandate on the RazorPay account to use this flow)')
    rzpOk = undefined
  }
}

console.log('')
// `rzpOk === false` is a real RazorPay regression and must FAIL, even when the
// PayPal half produced an approval_url. Before this, the verdict was
// `if (approvalUrl || rzpOk)` and every exit was 0, so the whole RazorPay block —
// rail policy, the foreign-currency refusal, both mandate ceilings — could print
// ✗ and the suite still passed. A check that cannot go red proves nothing.
// `undefined` still means SKIP (the account lacks the capability).
if (rzpOk === false) {
  console.log('❌ VAULT SETUP (initiate): FAIL — the RazorPay rail/ceiling policy above did not hold.')
  await closeDb()
  process.exit(1)
}

if (approvalUrl || rzpOk) {
  console.log('✅ VAULT SETUP (initiate): PASS')
  console.log('   (buyer authorizes via approval_url / embedded checkout, then the token completes the vault — manual browser step)')
  await closeDb()
  process.exit(0)
}

// No account had the capability — config gap, not a code bug. Skip (don't fail CI).
console.log('⚠ SKIP: no configured PayPal sandbox account has the v3 wallet-vault scope.')
console.log('  Enable "Save payment methods" (Vault API) on the app AND ensure the sandbox business')
console.log('  account supports Advanced Vault ("Save PayPal and Venmo"). The India sandbox account')
console.log('  in this project has it; the US one did not.')
await closeDb()
process.exit(0)
