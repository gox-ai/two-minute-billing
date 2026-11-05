/**
 * Proves the refund flow: partial refund, then refund the remainder, then reject
 * an over-refund. Checks the ledger nets correctly (charged X, refunded X → cash 0,
 * refunds account = X) and the cumulative-refund guard holds.
 *
 *   pnpm verify:refund
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  refundPayment,
  listRefunds,
  RefundError,
  refundGatewayAccount,
} from "@/modules/refunds/service";
import { gatewayAccounts, ledgerEntries, transactions } from "@db/schema";
import { randomUUID } from "node:crypto";

const org = await createOrganization({ name: "Refund Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "r@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month", // $100
});
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});
const { payment } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub.subscription,
  periodStart: sub.subscription.currentPeriodStart!,
  periodEnd: sub.subscription.currentPeriodEnd!,
});
if (!payment || payment.status !== "succeeded") {
  console.log("❌ no succeeded payment");
  process.exit(1);
}

const bal = (account: string) =>
  withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.account, account));
    return rows.reduce(
      (s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor),
      0n,
    );
  });

console.log(
  `payment ${payment.publicId} = ${payment.amountMinor} (cash after charge = ${await bal("cash")})`,
);

// 1) Partial refund $30.
const r1 = await refundPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: payment.publicId,
  amountMinor: 3000,
  reason: "partial",
});
console.log(`partial refund: ${r1.amountMinor} status=${r1.status}; cash now ${await bal("cash")}`);

// 2) Refund the remaining $70 (default = remainder).
const r2 = await refundPayment({
  organizationId: orgId,
  businessId: biz.id,
  paymentPublicId: payment.publicId,
});
console.log(
  `remainder refund: ${r2.amountMinor}; cash now ${await bal("cash")}; refunds acct ${await bal("refunds")}`,
);

// 3) Over-refund must be rejected.
let overRejected = false;
try {
  await refundPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: payment.publicId,
    amountMinor: 1,
  });
} catch (e) {
  overRejected = e instanceof RefundError;
}
console.log(`over-refund rejected: ${overRejected}`);

const allRefunds = await listRefunds(orgId, payment.id);
const cash = await bal("cash");
const refundsAcct = await bal("refunds");

// 4) Adapter resolution without a payment method: a one-off intent capture or an import
// leaves none, and the env-keyed fallback is unset in production.
const resolved = await withTenant(orgId, async (tx) => {
  const [charge] = await tx
    .select({ gwa: transactions.gatewayAccountId })
    .from(transactions)
    .where(and(eq(transactions.paymentId, payment.id), eq(transactions.type, "payment")));
  const base = { businessId: biz.id, paymentMethodId: null, providerKey: payment.providerKey };
  const viaCharge = await refundGatewayAccount(tx, { ...base, paymentId: payment.id });
  const viaOnlyAccount = await refundGatewayAccount(tx, { ...base, paymentId: randomUUID() });
  const [acc] = await tx.select().from(gatewayAccounts).where(eq(gatewayAccounts.id, charge!.gwa!));
  await tx.insert(gatewayAccounts).values({
    organizationId: orgId,
    businessId: biz.id,
    publicId: `gwa_verify_${randomUUID()}`,
    gatewayKey: acc!.gatewayKey,
    label: "second",
    livemode: acc!.livemode,
    credentialsEnc: acc!.credentialsEnc,
  });
  const ambiguous = await refundGatewayAccount(tx, { ...base, paymentId: randomUUID() });
  return {
    chargeGwa: charge?.gwa,
    viaCharge: viaCharge?.id,
    viaOnlyAccount: viaOnlyAccount?.id,
    ambiguous,
  };
});
const resolutionOk =
  !!resolved.chargeGwa &&
  resolved.viaCharge === resolved.chargeGwa &&
  resolved.viaOnlyAccount === resolved.chargeGwa &&
  resolved.ambiguous === null;
console.log(
  `adapter resolution without a payment method: ${JSON.stringify({ ...resolved, ambiguous: resolved.ambiguous?.id ?? null })}`,
);

const pass =
  resolutionOk &&
  r1.amountMinor === 3000n &&
  r1.status === "succeeded" &&
  r2.amountMinor === 7000n && // remainder of $100 - $30
  allRefunds.length === 2 &&
  cash === 0n && // charged 10000, refunded 10000
  refundsAcct === 10000n && // contra-revenue accumulates the full refund
  overRejected;

console.log("");
console.log(pass ? "✅ REFUND: PASS" : "❌ REFUND: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
