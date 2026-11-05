/**
 * Multi-currency correctness:
 *  1. a subscription cannot mix currencies (rejected),
 *  2. a customer_balance credit in one currency does NOT apply to an invoice in
 *     another currency (credit is currency-scoped),
 *  3. ledger balances are tracked per-currency.
 *
 *   pnpm verify:multicurrency
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  getSubscriptionItems,
  SubscriptionError,
} from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod, collectInvoice } from "@/modules/invoicing/service";
import { customerCreditBalance } from "@/modules/customers/balances";

const org = await createOrganization({ name: "MultiCcy Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  defaultCurrency: "USD",
  organizationId: orgId,
  name: "Biz",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "m@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });

const usd = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const eur = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "EUR",
  amountMinor: 5000,
  interval: "month",
});

// 1) Mixed-currency subscription is rejected.
let mixedRejected = false;
try {
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: usd, quantity: 1 },
      { price: eur, quantity: 1 },
    ],
  });
} catch (e) {
  mixedRejected = e instanceof SubscriptionError;
}
console.log(`1) mixed-currency subscription rejected: ${mixedRejected}`);

// 2) Build a USD credit via a downgrade, then bill a separate EUR subscription.
const usdSub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price: usd, quantity: 3 }],
});
const usdItem = (await getSubscriptionItems(orgId, usdSub.subscription.id))[0]!;
// Bill + collect the first USD period: the downgrade credit is a credit note
// against the current-term invoice (paid → refundable CN), so an invoice must
// exist and be paid — with nothing billed, a downgrade correctly credits nothing.
const { invoice: usdInv } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: usdSub.subscription,
  periodStart: usdSub.subscription.currentPeriodStart!,
  periodEnd: usdSub.subscription.currentPeriodEnd!,
});
await collectInvoice({ organizationId: orgId, businessId: biz.id, invoice: usdInv });
const ps = usdSub.subscription.currentPeriodStart!.getTime(),
  pe = usdSub.subscription.currentPeriodEnd!.getTime();
await changeSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: usdSub.subscription.id,
  now: new Date(ps + Math.floor((pe - ps) / 2)),
  changes: [{ itemId: usdItem.publicId, newQuantity: 1 }],
});
const usdCredit = await customerCreditBalance(orgId, customer.id, "USD");
const eurCredit = await customerCreditBalance(orgId, customer.id, "EUR");
console.log(
  `2) credits: USD=${usdCredit} (expect >0), EUR=${eurCredit} (expect 0 — currency-scoped)`,
);

const eurSub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price: eur, quantity: 1 }],
});
const { invoice: eurInv } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: eurSub.subscription,
  periodStart: eurSub.subscription.currentPeriodStart!,
  periodEnd: eurSub.subscription.currentPeriodEnd!,
});
console.log(
  `   EUR invoice: total=${eurInv.totalMinor} amount_due=${eurInv.amountDueMinor} (USD credit must NOT reduce it)`,
);

// 3) Per-currency ledger (revenue) — USD and EUR tracked separately.
const rev = await withTenant(orgId, async (tx) => {
  const { ledgerEntries } = await import("@db/schema");
  const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.account, "revenue"));
  const by: Record<string, bigint> = {};
  for (const r of rows)
    by[r.currency] =
      (by[r.currency] ?? 0n) + (r.direction === "debit" ? r.amountMinor : -r.amountMinor);
  return by;
});
console.log(
  `3) revenue by currency: ${JSON.stringify(Object.fromEntries(Object.entries(rev).map(([k, v]) => [k, v.toString()])))}`,
);

const pass =
  mixedRejected &&
  usdCredit > 0n &&
  eurCredit === 0n &&
  Number(eurInv.totalMinor) === 5000 &&
  Number(eurInv.amountDueMinor) === 5000 && // full EUR, no USD credit applied
  (rev["EUR"] ?? 0n) === -5000n;

console.log("");
console.log(pass ? "✅ MULTI-CURRENCY: PASS" : "❌ MULTI-CURRENCY: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
