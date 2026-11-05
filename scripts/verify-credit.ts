/**
 * Proves customer_balance credits are applied to future invoices:
 *  - downgrade mid-period → customer accrues a credit (negative customer_balance),
 *  - next renewal invoice consumes the credit: amount_due = total − creditApplied,
 *    only amount_due is charged, and the credit balance drops accordingly.
 *
 *   pnpm verify:credit
 */
import { eq, desc } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { customerCreditBalance } from "@/modules/customers/balances";
import { subscriptions, invoices, payments } from "@db/schema";

const org = await createOrganization({ name: "Credit Org" });
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
  email: "c@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Seats" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month", // $10/seat
});

const sub = (
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 3 }], // $30/mo
  })
).subscription;
const item = (await import("@/modules/subscriptions/service")).getSubscriptionItems;

// Bill + collect the current term so the downgrade has a paid source invoice to
// credit against (ADR-009: a credit note requires a source invoice — an
// un-invoiced term is never credited).
await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub,
  periodStart: sub.currentPeriodStart!,
  periodEnd: sub.currentPeriodEnd!,
});

// Downgrade 3→1 at ~50% → credit ≈ (3000−1000)*0.5 = $10 to customer_balance.
const ps = sub.currentPeriodStart!.getTime(),
  pe = sub.currentPeriodEnd!.getTime();
const mid = new Date(ps + Math.floor((pe - ps) / 2));
const items = await item(orgId, sub.id);
await changeSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: sub.id,
  now: mid,
  changes: [{ itemId: items[0]!.publicId, newQuantity: 1 }],
});
const creditAfterDowngrade = await customerCreditBalance(orgId, customer.id, "USD");
console.log(`credit after downgrade: ${creditAfterDowngrade} (expect ~1000)`);

// Renew: monthly charge now $10 (qty 1); credit ~$10 should cover most/all of it.
await systemDb
  .update(subscriptions)
  .set({ currentPeriodEnd: new Date(Date.now() - 60_000) })
  .where(eq(subscriptions.id, sub.id));
await runBillingClockTick(new Date());

const renewal = await withTenant(orgId, async (tx) => {
  const [inv] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, sub.id))
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  const pays = await tx.select().from(payments).where(eq(payments.invoiceId, inv!.id));
  return { inv: inv!, pays };
});
const creditAfterRenewal = await customerCreditBalance(orgId, customer.id, "USD");
const chargedTotal = renewal.pays
  .filter((p) => p.status === "succeeded")
  .reduce((s, p) => s + Number(p.amountMinor), 0);

console.log(
  `renewal invoice: total=${renewal.inv.totalMinor} amount_due=${renewal.inv.amountDueMinor} status=${renewal.inv.status}`,
);
console.log(`charged via provider: ${chargedTotal} (expect 0 — fully covered by credit)`);
console.log(`credit after renewal: ${creditAfterRenewal} (expect ~0)`);

const near = (a: number | bigint, b: number) => Math.abs(Number(a) - b) <= 2;
const pass =
  near(creditAfterDowngrade, 1000) &&
  Number(renewal.inv.totalMinor) === 1000 &&
  near(renewal.inv.amountDueMinor ?? renewal.inv.totalMinor, 0) &&
  renewal.inv.status === "paid" &&
  chargedTotal === 0 &&
  near(creditAfterRenewal, 0);

console.log("");
console.log(pass ? "✅ CUSTOMER CREDIT: PASS" : "❌ CUSTOMER CREDIT: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
