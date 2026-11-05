/**
 * Proves subscription lifecycle controls:
 *  - cancel(at_period_end) → stays active, then the billing clock cancels it at term end,
 *  - pause → status paused, and the clock does NOT bill a paused sub,
 *  - resume → back to active,
 *  - cancel(immediate) → canceled now.
 *
 *   pnpm verify:lifecycle
 */
import { eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
} from "@/modules/subscriptions/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { subscriptions, invoices } from "@db/schema";

const org = await createOrganization({ name: "Lifecycle Org" });
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
  email: "l@a.com",
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
  amountMinor: 1000,
  interval: "month",
});

const mkSub = async () =>
  (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    })
  ).subscription;

const getStatus = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );
const invCount = (subId: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.subscriptionId, subId))).length,
  );
const backdate = (id: string) =>
  systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: new Date(Date.now() - 60_000) })
    .where(eq(subscriptions.id, id));

// --- cancel at period end → clock cancels at term ---
const a = await mkSub();
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: a.id,
  atPeriodEnd: true,
  now: new Date(),
});
const aMid = await getStatus(a.id);
await backdate(a.id);
await runBillingClockTick(new Date());
const aEnd = await getStatus(a.id);
console.log(
  `cancel@period_end: after flag status=${aMid.status} cancel_at_period_end=${aMid.cancelAtPeriodEnd}; after clock status=${aEnd.status}`,
);

// --- pause → not billed by clock → resume ---
const b = await mkSub();
await pauseSubscription({ organizationId: orgId, businessId: biz.id, subscriptionId: b.id });
const bPaused = await getStatus(b.id);
const bInvBefore = await invCount(b.id);
await backdate(b.id);
await runBillingClockTick(new Date());
const bInvAfter = await invCount(b.id);
await resumeSubscription({ organizationId: orgId, businessId: biz.id, subscriptionId: b.id });
const bResumed = await getStatus(b.id);
console.log(
  `pause: status=${bPaused.status}; invoices ${bInvBefore}->${bInvAfter} (no new bill); resume status=${bResumed.status}`,
);

// --- immediate cancel ---
const c = await mkSub();
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: c.id,
  atPeriodEnd: false,
  now: new Date(),
});
const cCanceled = await getStatus(c.id);
console.log(`cancel immediate: status=${cCanceled.status}`);

const pass =
  aMid.status === "active" &&
  aMid.cancelAtPeriodEnd === true &&
  aEnd.status === "cancelled" &&
  bPaused.status === "paused" &&
  bInvAfter === bInvBefore &&
  bResumed.status === "active" &&
  cCanceled.status === "cancelled";

console.log("");
console.log(pass ? "✅ LIFECYCLE: PASS" : "❌ LIFECYCLE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
