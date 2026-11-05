/**
 * Proves the REAL Stripe adapter end-to-end against Stripe's TEST API: vault a
 * card, then bill a subscription period (real PaymentIntent), and check the
 * invoice is paid + the ledger balances. Also exercises a refund.
 *
 *   pnpm verify:stripe        (requires STRIPE_TEST_SECRET_KEY in .env)
 */
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { config } from "@/platform/config";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { getProvider } from "@/providers/registry";
import { createGatewayAccount } from "@/modules/gateway/service";
import { ledgerEntries, payments } from "@db/schema";

if (!config.STRIPE_TEST_SECRET_KEY) {
  console.log("SKIP: STRIPE_TEST_SECRET_KEY not set");
  process.exit(0);
}

const org = await createOrganization({ name: "Stripe Org" });
const orgId = org.organization.id;
// livemode: 'test' is LOAD-BEARING, and its absence is what made this suite fail.
// `createBusiness` defaults to LIVE, and since the test/live partition gate landed a
// live business may not be charged through test credentials — so the collect refused
// before the adapter was ever called: a `failed` payment, no charge id, and not one
// request to `/v1/payment_intents`. The gate is correct; this setup was exploiting the
// hole it closed. The account's own livemode is DERIVED from the business, never
// passed in.
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
// A `gateway_accounts` row is REQUIRED to charge. Vaulting resolves an adapter from the
// bare provider NAME (env credentials), but collection routes through
// `selectGatewayAccount`, which has no row to find — so vaulting succeeded while every
// charge was declined `gateway_account_unavailable`.
await createGatewayAccount({
  organizationId: orgId,
  businessId: biz.id,
  gatewayKey: "stripe",
  label: "Stripe Test",
  credentials: { secret_key: config.STRIPE_TEST_SECRET_KEY },
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "stripe-test@example.com",
  firstName: "Stripe",
  lastName: "Tester",
  // Name + address required for India-export compliance on cross-border charges.
  address: {
    line1: "1 Test St",
    city: "San Francisco",
    state: "CA",
    postalCode: "94107",
    country: "US",
  },
});

console.log("vaulting card via Stripe (tok_visa)...");
const pm = await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_visa",
  provider: "stripe",
});
console.log(
  `  vaulted: ${pm.providerKey} ${pm.brand} ****${pm.last4} (provider_pm=${pm.providerPaymentMethodId.slice(0, 12)}…)`,
);

const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 2500,
  interval: "month",
});

const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
  defaultPaymentMethodId: pm.id,
});

console.log("billing first period (real Stripe charge $25.00)...");
const { invoice, payment } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub.subscription,
  periodStart: sub.subscription.currentPeriodStart!,
  periodEnd: sub.subscription.currentPeriodEnd!,
});
console.log(`  invoice ${invoice.publicId} status=${invoice.status} total=${invoice.totalMinor}`);
console.log(
  `  payment status=${payment?.status} provider_charge=${payment?.providerChargeId?.slice(0, 14)}…`,
);

// Ledger check (scoped to this org).
const ledger = await withTenant(orgId, async (tx) => {
  const rows = await tx.select().from(ledgerEntries);
  const bal: Record<string, bigint> = {};
  for (const r of rows) {
    const signed = r.direction === "debit" ? r.amountMinor : -r.amountMinor;
    bal[r.account] = (bal[r.account] ?? 0n) + signed;
  }
  return bal;
});
console.log(
  "  ledger:",
  Object.fromEntries(Object.entries(ledger).map(([k, v]) => [k, v.toString()])),
);

// Refund the charge directly via the adapter.
let refundOk = false;
if (payment?.status === "succeeded" && payment.providerChargeId) {
  const stripe = getProvider("stripe");
  const refund = await stripe.refund({
    providerChargeId: payment.providerChargeId,
    idempotencyKey: `refund_${payment.publicId}`,
  });
  refundOk = refund.status === "succeeded";
  console.log(`  refund: ${refund.status} (${refund.providerRefundId.slice(0, 14)}…)`);
}

const stripeCharged =
  payment?.status === "succeeded" &&
  !!payment.providerChargeId?.startsWith("pi_") &&
  invoice.status === "paid";
const ledgerOk =
  ledger["cash"] === 2500n &&
  (ledger["accounts_receivable"] ?? 0n) === 0n &&
  ledger["revenue"] === -2500n;

// A card whose issuer demands 3DS on every payment, charged off-session as the signup does.
// Buyer present → the challenge (and the refused intent is cancelled); renewal → a decline.
const sdk = new Stripe(config.STRIPE_TEST_SECRET_KEY);
const authCus = await sdk.customers.create({
  name: "Auth Tester",
  address: {
    line1: "1 Test St",
    city: "San Francisco",
    state: "CA",
    postal_code: "94107",
    country: "US",
  },
});
const authPm = await sdk.paymentMethods.attach("pm_card_authenticationRequired", {
  customer: authCus.id,
});
const authCharge = (by: "customer" | "merchant") =>
  getProvider("stripe").charge({
    amountMinor: 2500n,
    currency: "USD",
    customer: { providerKey: "stripe", providerCustomerId: authCus.id },
    paymentMethod: {
      providerKey: "stripe",
      providerPaymentMethodId: authPm.id,
      display: { type: "card" },
    },
    idempotencyKey: `auth_${by}_${authCus.id}`,
    initiator: { by, recurring: true },
  });
const buyer = await authCharge("customer");
const buyerPi = buyer.providerChargeId
  ? await sdk.paymentIntents.retrieve(buyer.providerChargeId)
  : null;
const renewal = await authCharge("merchant");
const renewalPi = renewal.providerChargeId
  ? await sdk.paymentIntents.retrieve(renewal.providerChargeId)
  : null;
console.log(`  3DS card, buyer present: ${buyer.status} (intent ${buyerPi?.status})`);
console.log(
  `  3DS card, renewal: ${renewal.status} ${renewal.failure?.code} (intent ${renewalPi?.status})`,
);
const authOk =
  buyer.status === "requires_action" &&
  buyerPi?.status === "canceled" &&
  renewal.status === "failed" &&
  renewal.failure?.code === "authentication_required" &&
  renewalPi?.status === "requires_payment_method";

const pass = pm.providerKey === "stripe" && stripeCharged && ledgerOk && refundOk && authOk;
console.log("");
console.log(pass ? "✅ STRIPE ADAPTER: PASS" : "❌ STRIPE ADAPTER: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
