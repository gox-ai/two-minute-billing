/**
 * Subscription soft delete.
 *
 * The check that matters is the third one: a DELETED active subscription must not be
 * billed by the clock, proven against a CONTROL subscription that is identical except for
 * the delete and that renews in the same tick. Without the control the test passes
 * whenever the tick does nothing at all, which is the way this fails silently — and it
 * fails in the direction that charges a customer for a subscription the merchant removed.
 *
 *   pnpm verify:subscription-delete
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod, setDefaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  deleteSubscription,
  getSubscriptionByPublicId,
  listSubscriptions,
  listSubscriptionsPage,
} from "@/modules/subscriptions/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import {
  createCheckoutSession,
  resolveCheckoutSession,
  completeCheckout,
} from "@/modules/checkout/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { subscriptions, invoices, events, auditLogs } from "@db/schema";

const org = await createOrganization({ name: "SubDelete Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const product = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});
const customer = await createCustomer({ ...ctx, email: "del@a.com" });
// The control subscription has to actually RENEW, and a cardless renewal cancels at the
// boundary instead — which is how the first run of this suite failed.
const card = await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
await setDefaultPaymentMethod(orgId, customer.id, card.publicId);

const checks: Array<[string, boolean]> = [];
const now = new Date();

const invoiceCount = (subId: string): Promise<number> =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.subscriptionId, subId))
      ).length,
  );
const rawRow = (subId: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1))[0] ??
      null,
  );
const newSub = async () => {
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now,
    items: [{ price, quantity: 1 }],
  });
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  return subscription;
};

// 1) It disappears from every read, and the row is still there.
{
  const sub = await newSub();
  const deleted = await deleteSubscription({ ...ctx, subscriptionId: sub.id, now });
  const byId = await getSubscriptionByPublicId(orgId, biz.id, sub.publicId);
  const list = await listSubscriptions(orgId, biz.id);
  const page = await listSubscriptionsPage(orgId, biz.id, {});
  const row = await rawRow(sub.id);
  checks.push(
    ["delete returns the stamped row", deleted?.deletedAt != null],
    ["deleted subscription: lookup by public id returns null", byId === null],
    ["deleted subscription: absent from listSubscriptions", !list.some((x) => x.id === sub.id)],
    [
      "deleted subscription: absent from the paginated list",
      !page.data.some((r) => r.subscription.id === sub.id),
    ],
    ["the row itself survives", row != null && row.deletedAt != null],
    // The status it held is the record of what was deleted. A delete that rewrote it to
    // 'cancelled' would claim an ending that never happened.
    ["status is left untouched", row?.status === sub.status],
    ["deleted_by records an actor", typeof row?.deletedBy === "string"],
  );

  // …and its money is untouched.
  checks.push(["the invoice it raised survives", (await invoiceCount(sub.id)) === 1]);

  // A second delete is a no-op, not an error, and emits nothing further.
  const again = await deleteSubscription({ ...ctx, subscriptionId: sub.id, now });
  const evs = await withTenant(orgId, async (tx) =>
    tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.businessId, biz.id), eq(events.type, "subscription_deleted"))),
  );
  const audits = await withTenant(orgId, async (tx) =>
    tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.businessId, biz.id), eq(auditLogs.action, "subscription.delete"))),
  );
  checks.push(
    ["deleting twice is a no-op", again === null],
    ["exactly one subscription_deleted event", evs.length === 1],
    ["exactly one subscription.delete audit row", audits.length === 1],
  );
}

// 2) The clock does not bill a deleted subscription — and the control proves the tick
//    would have. Both are active, both are due, one is deleted.
{
  const doomed = await newSub();
  const control = await newSub();
  await deleteSubscription({ ...ctx, subscriptionId: doomed.id, now });

  const before = { doomed: await invoiceCount(doomed.id), control: await invoiceCount(control.id) };
  // Scoped to THIS business: an unscoped future-dated tick sweeps every subscription in
  // the local database, which once cancelled 41 unrelated ones.
  const at = new Date(now.getTime() + 40 * 86_400_000);
  await runWithClockScope({ onlyBusinessId: biz.id, now: at }, () => runBillingClockTick(at));
  const after = { doomed: await invoiceCount(doomed.id), control: await invoiceCount(control.id) };

  checks.push(
    ["CONTROL: a live subscription renews in this tick", after.control > before.control],
    ["a deleted subscription raises no renewal invoice", after.doomed === before.doomed],
  );
}

// 3) A checkout CHANGE link cannot reach a deleted subscription — and the completion path
//    is re-checked, because a link outlives the subscription it points at.
{
  const sub = await newSub();
  const session = await createCheckoutSession({
    ...ctx,
    mode: "change",
    subscriptionId: sub.publicId,
    items: [{ price: price.publicId, quantity: 2 }],
  });
  await deleteSubscription({ ...ctx, subscriptionId: sub.id, now });

  let mintErr: string | null = null;
  try {
    await createCheckoutSession({
      ...ctx,
      mode: "change",
      subscriptionId: sub.publicId,
      items: [{ price: price.publicId, quantity: 2 }],
    });
  } catch (e) {
    mintErr = (e as Error).message;
  }

  let completeErr: string | null = null;
  try {
    const resolved = await resolveCheckoutSession(session.token);
    await completeCheckout(resolved!, {} as never);
  } catch (e) {
    completeErr = (e as Error).message;
  }
  checks.push(
    ["a change session cannot be minted against a deleted subscription", mintErr != null],
    // The message matters: any other refusal (no customer, no payment method) would pass a
    // bare "it threw" check while the guard was missing.
    [
      "completing a link minted BEFORE the delete is refused",
      completeErr === "This subscription no longer exists",
    ],
  );
  if (completeErr !== "This subscription no longer exists")
    console.log(`     (completion threw: ${completeErr})`);
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ SUBSCRIPTION DELETE: PASS" : "❌ SUBSCRIPTION DELETE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
