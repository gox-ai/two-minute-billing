/**
 * A subscription that ends at term end (cancel at period end, or its last billing cycle)
 * still bills what the closing period owes in arrears. Run on Time Travel (the real clock
 * pipeline, scoped to the test business). What regresses without each check:
 *  - the closing period's metered usage is never invoiced;
 *  - a pending unbilled charge stays pending on the cancelled subscription forever;
 *  - the final invoice charges the plan again for a period that never starts;
 *  - a term end with nothing owed raises an empty invoice;
 *  - a later tick bills the same closing period twice.
 *
 *   pnpm verify:term-end-final-invoice
 */
import { and, eq, sql } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { cancelSubscription, createSubscription } from "@/modules/subscriptions/service";
import { addAdHocCharge } from "@/modules/subscriptions/items";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { recordUsage } from "@/modules/metering/service";
import { startTimeTravel, travelForward } from "@/modules/time-travel/service";
import {
  events,
  invoiceLineItems,
  invoices,
  subscriptions,
  subscriptionItems,
  unbilledCharges,
} from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const DAY = 86_400_000;
const G = new Date("2027-03-01T00:00:00.000Z");
const APR = new Date("2027-04-01T00:00:00.000Z");
const RUN = Math.random().toString(36).slice(2, 8);

async function main() {
  const org = await createOrganization({ name: `Term End Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Term End Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `term-end-${RUN}@example.com`,
    autoCollection: "on",
    address: { country: "US" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const plan = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Box",
    id: `box-${RUN}`,
    kind: "plan",
  });
  const monthly = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const meter = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Extras",
    id: `extras-${RUN}`,
    kind: "addon",
  });
  const usagePrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: meter.id,
    type: "recurring",
    model: "usage",
    usageAggregation: "sum",
    currency: "USD",
    amountMinor: 100,
    interval: "month",
  });

  await startTimeTravel({ orgId, bizId: biz.id, genesisTime: G });
  const subscribe = async () => {
    const c = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: G,
      items: [
        { price: monthly, quantity: 1 },
        { price: usagePrice, quantity: 1 },
      ],
    });
    await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: c.subscription,
      periodStart: c.subscription.currentPeriodStart!,
      periodEnd: c.subscription.currentPeriodEnd!,
    });
    return c.subscription;
  };
  const sub = (id: string) =>
    withTenant(
      orgId,
      async (tx) => (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!,
    );
  const invoicesOf = (id: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, id)).orderBy(invoices.createdAt),
    );
  const linesOf = (invoiceId: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)),
    );
  const usageItemOf = async (subId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(subscriptionItems)
          .where(
            and(
              eq(subscriptionItems.subscriptionId, subId),
              eq(subscriptionItems.priceId, usagePrice.id),
            ),
          ),
      )
    )[0]!;
  const eventCount = (type: string, publicId: string) =>
    systemDb
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.type, type), sql`${events.data}::text like ${`%${publicId}%`}`))
      .then((r) => r[0]?.n ?? 0);

  const a = await subscribe(); // cancel at period end, usage + a pending charge
  const b = await subscribe(); // cancel at period end, nothing owed
  const c = await subscribe(); // last billing cycle, usage only

  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: (await usageItemOf(a.id)).id,
    quantity: 7,
    timestamp: new Date(G.getTime() + 10 * DAY),
  });
  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: (await usageItemOf(c.id)).id,
    quantity: 3,
    timestamp: new Date(G.getTime() + 20 * DAY),
  });
  const charge = await addAdHocCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: a.id,
    description: "Setup work",
    amountMinor: 1200,
    invoiceNow: false,
    now: new Date(G.getTime() + 12 * DAY),
  });
  const chargeId = charge.object === "unbilled_charge" ? charge.charge.id : null;
  ok("the charge is queued, not invoiced", chargeId != null);

  for (const s of [a, b])
    await cancelSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s.id,
      atPeriodEnd: true,
      now: new Date(G.getTime() + 15 * DAY),
    });
  await withTenant(orgId, (tx) =>
    tx.update(subscriptions).set({ remainingBillingCycles: 0 }).where(eq(subscriptions.id, c.id)),
  );

  await travelForward({ orgId, bizId: biz.id, toTime: new Date(APR.getTime() + DAY) });

  // ── Cancel at period end, with usage and a pending charge ─────────────────
  const a1 = await sub(a.id);
  ok("the subscription is cancelled at term end", a1.status === "cancelled", a1.status);
  ok(
    "…and its term does not move on",
    a1.currentPeriodEnd?.getTime() === APR.getTime(),
    a1.currentPeriodEnd?.toISOString(),
  );
  const invA = await invoicesOf(a.id);
  ok("one final invoice is raised", invA.length === 2, String(invA.length));
  const finalA = invA[1];
  const linesA = finalA ? await linesOf(finalA.id) : [];
  const usageLine = linesA.find((l) => l.kind === "usage");
  ok(
    "it bills the closing period's usage",
    usageLine?.quantity === 7 && usageLine.amountMinor === 700n,
    JSON.stringify(linesA.map((l) => [l.kind, l.quantity, String(l.amountMinor)])),
  );
  ok(
    "…over the closing period",
    usageLine?.periodStart?.getTime() === G.getTime() &&
      usageLine.periodEnd?.getTime() === APR.getTime(),
  );
  ok(
    "it bills the pending charge",
    linesA.some((l) => l.kind === "one_time" && l.amountMinor === 1200n),
  );
  ok("it does not charge the plan again", !linesA.some((l) => l.kind === "recurring"));
  ok(
    "the final invoice covers the closing period",
    finalA?.periodStart?.getTime() === G.getTime() && finalA.periodEnd?.getTime() === APR.getTime(),
  );
  ok("the final invoice is collected", finalA?.status === "paid", finalA?.status);
  const [chargeRow] = chargeId
    ? await withTenant(orgId, (tx) =>
        tx.select().from(unbilledCharges).where(eq(unbilledCharges.id, chargeId)),
      )
    : [];
  ok("the charge is marked billed", chargeRow?.status === "billed", chargeRow?.status);
  ok(
    "the final invoice emits invoice_generated",
    finalA ? (await eventCount("invoice_generated", finalA.publicId)) === 1 : false,
  );
  ok(
    "the subscription emits one subscription_canceled",
    (await eventCount("subscription_canceled", a.publicId)) === 1,
  );
  ok(
    "it emits no subscription_renewed",
    (await eventCount("subscription_renewed", a.publicId)) === 0,
  );

  // ── Cancel at period end with nothing owed ────────────────────────────────
  const b1 = await sub(b.id);
  ok("a term end with nothing owed still cancels", b1.status === "cancelled", b1.status);
  ok("…and raises no invoice", (await invoicesOf(b.id)).length === 1);

  // ── The last billing cycle ────────────────────────────────────────────────
  const c1 = await sub(c.id);
  ok("the last billing cycle cancels", c1.status === "cancelled", c1.status);
  const invC = await invoicesOf(c.id);
  const linesC = invC[1] ? await linesOf(invC[1].id) : [];
  ok(
    "…and bills its usage on one final invoice",
    invC.length === 2 &&
      linesC.length === 1 &&
      linesC[0]?.kind === "usage" &&
      linesC[0].amountMinor === 300n,
    JSON.stringify(linesC.map((l) => [l.kind, String(l.amountMinor)])),
  );

  // ── A later tick bills nothing more ───────────────────────────────────────
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(APR.getTime() + 40 * DAY) });
  ok(
    "later ticks raise no second final invoice",
    (await invoicesOf(a.id)).length === 2 && (await invoicesOf(c.id)).length === 2,
  );
}

try {
  await main();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
}

console.log("");
let pass = true;
for (const [n, c, detail] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}${!c && detail ? `  (${detail})` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ TERM-END FINAL INVOICE: PASS" : "\n❌ TERM-END FINAL INVOICE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
