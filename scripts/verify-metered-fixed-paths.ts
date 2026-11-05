/**
 * A metered price bills only measured usage, never a fixed or prorated charge on its item
 * quantity. Each path below must book nothing for a `usage` item or a metered `tiered` item
 * (whose first tier has a flat fee):
 *  - the first invoice at create;
 *  - add item mid-term (charge) and remove item (credit);
 *  - a mid-term price swap (credit + charge);
 *  - a term reset (full new-term charge + unused-time credit).
 *
 *   pnpm verify:metered-fixed-paths
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { addSubscriptionItem, removeSubscriptionItem } from "@/modules/subscriptions/items";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  creditNoteItems,
  creditNotes,
  invoiceLineItems,
  invoices,
  subscriptionItems,
  unbilledCharges,
} from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = Math.random().toString(36).slice(2, 8);

async function main() {
  const org = await createOrganization({ name: `Metered Paths Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Metered Paths Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const ctx = { organizationId: orgId, businessId: biz.id };
  const customer = await createCustomer({ ...ctx, email: `metered-paths-${RUN}@example.com` });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });

  const planProd = await createProduct({ ...ctx, name: "Box", kind: "plan" });
  const plan = await createPrice({
    ...ctx,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const plan2 = await createPrice({
    ...ctx,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 9000,
    interval: "month",
  });
  const meterProd = await createProduct({ ...ctx, name: "Metered calls", kind: "addon" });
  const usage = await createPrice({
    ...ctx,
    productId: meterProd.id,
    name: "Calls usage",
    type: "recurring",
    model: "usage",
    usageAggregation: "sum",
    currency: "USD",
    amountMinor: 100,
    interval: "month",
  });
  const tierPrice = (name: string, flat: number) =>
    createPrice({
      ...ctx,
      productId: meterProd.id,
      name,
      type: "recurring",
      model: "tiered",
      usageAggregation: "sum",
      currency: "USD",
      interval: "month",
      tiers: [
        { upToMinor: 1000, unitAmountMinor: 100, flatAmountMinor: flat },
        { upToMinor: null, unitAmountMinor: 50 },
      ],
    });
  const tiered = await tierPrice("Calls tiered", 2500);
  const tiered2 = await tierPrice("Calls tiered two", 4000);
  const metered = [usage, tiered, tiered2];
  const meteredIds = metered.map((p) => p.id);

  /** Every non-usage line, credit item and queued charge booked for a metered price. */
  const meteredMoney = (subId: string) =>
    withTenant(orgId, async (tx) => {
      const lines = await tx
        .select({ kind: invoiceLineItems.kind, amount: invoiceLineItems.amountMinor })
        .from(invoiceLineItems)
        .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
        .where(
          and(
            eq(invoices.subscriptionId, subId),
            inArray(invoiceLineItems.priceId, meteredIds),
            sql`${invoiceLineItems.kind} <> 'usage'`,
          ),
        );
      const credits = await tx
        .select({ description: creditNoteItems.description, amount: creditNoteItems.amountMinor })
        .from(creditNoteItems)
        .innerJoin(creditNotes, eq(creditNoteItems.creditNoteId, creditNotes.id))
        .innerJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
        .where(
          and(
            eq(invoices.subscriptionId, subId),
            sql`${creditNoteItems.description} ilike '%Calls%'`,
          ),
        );
      const queued = await tx
        .select({ amount: unbilledCharges.amountMinor })
        .from(unbilledCharges)
        .where(
          and(
            eq(unbilledCharges.subscriptionId, subId),
            inArray(unbilledCharges.priceId, meteredIds),
          ),
        );
      return [
        ...lines.map((l) => `line ${l.kind} ${l.amount}`),
        ...credits.map((c) => `credit "${c.description}" ${c.amount}`),
        ...queued.map((q) => `queued ${q.amount}`),
      ];
    });
  const itemFor = async (subId: string, priceId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(subscriptionItems)
          .where(
            and(
              eq(subscriptionItems.subscriptionId, subId),
              eq(subscriptionItems.priceId, priceId),
            ),
          ),
      )
    )[0]!;
  /** Create, then raise the first period's invoice as the activation does. */
  const subscribe = async (items: { price: typeof plan; quantity: number }[]) => {
    const { subscription } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items,
    });
    await billSubscriptionPeriod({
      ...ctx,
      subscription,
      periodStart: subscription.currentPeriodStart!,
      periodEnd: subscription.currentPeriodEnd!,
    });
    return subscription;
  };

  // ── First invoice at create ───────────────────────────────────────────────
  const created = await subscribe([
    { price: plan, quantity: 1 },
    { price: usage, quantity: 1 },
    { price: tiered, quantity: 1 },
  ]);
  const atCreate = await meteredMoney(created.id);
  const planLines = await withTenant(orgId, (tx) =>
    tx
      .select({ id: invoiceLineItems.id })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
      .where(and(eq(invoices.subscriptionId, created.id), eq(invoiceLineItems.priceId, plan.id))),
  );
  ok("create: the first invoice bills the plan", planLines.length === 1, String(planLines.length));
  ok("create: no fixed charge for a metered item", atCreate.length === 0, atCreate.join("; "));

  // ── Add item, then remove it ──────────────────────────────────────────────
  const a = await subscribe([{ price: plan, quantity: 1 }]);
  for (const price of [usage, tiered])
    await addSubscriptionItem({
      ...ctx,
      subscriptionId: a.id,
      price,
      quantity: 1,
      now: new Date(),
      invoiceImmediately: true,
    });
  const afterAdd = await meteredMoney(a.id);
  ok("add item: no charge for a metered item", afterAdd.length === 0, afterAdd.join("; "));
  for (const price of [usage, tiered])
    await removeSubscriptionItem({
      ...ctx,
      subscriptionId: a.id,
      itemPublicId: (await itemFor(a.id, price.id)).publicId,
      now: new Date(),
    });
  const afterRemove = (await meteredMoney(a.id)).filter((m) => !afterAdd.includes(m));
  ok("remove item: no credit for a metered item", afterRemove.length === 0, afterRemove.join("; "));

  // ── Mid-term price swap on the metered item ───────────────────────────────
  const b = await subscribe([
    { price: plan, quantity: 1 },
    { price: tiered, quantity: 1 },
  ]);
  const beforeSwap = await meteredMoney(b.id);
  await changeSubscription({
    ...ctx,
    subscriptionId: b.id,
    now: new Date(),
    changes: [{ itemId: (await itemFor(b.id, tiered.id)).publicId, newPriceId: tiered2.publicId }],
    invoiceImmediately: true,
  });
  const afterSwap = (await meteredMoney(b.id)).filter((m) => !beforeSwap.includes(m));
  ok(
    "price swap: no credit or charge for a metered item",
    afterSwap.length === 0,
    afterSwap.join("; "),
  );

  // ── Term reset (forced, with a plan swap) ─────────────────────────────────
  const c = await subscribe([
    { price: plan, quantity: 1 },
    { price: usage, quantity: 1 },
    { price: tiered, quantity: 1 },
  ]);
  const beforeReset = await meteredMoney(c.id);
  await changeSubscription({
    ...ctx,
    subscriptionId: c.id,
    now: new Date(),
    changes: [{ itemId: (await itemFor(c.id, plan.id)).publicId, newPriceId: plan2.publicId }],
    resetTerm: true,
    invoiceImmediately: true,
  });
  const afterReset = (await meteredMoney(c.id)).filter((m) => !beforeReset.includes(m));
  ok(
    "term reset: no new-term charge or unused-time credit for a metered item",
    afterReset.length === 0,
    afterReset.join("; "),
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
console.log(pass ? "\n✅ METERED-FIXED-PATHS: PASS" : "\n❌ METERED-FIXED-PATHS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
