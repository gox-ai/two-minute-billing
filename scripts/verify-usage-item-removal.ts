/**
 * Removing a subscription item keeps its usage records (0371). What regresses without each
 * check:
 *  - the usage an invoice line was rated from is deleted with the item;
 *  - a kept record loses its subscription, or reads as unbilled;
 *  - billed usage becomes deletable, or a kept record is billed again;
 *  - deleting a whole provisional subscription leaves its usage behind;
 *  - removal, a term reset and an immediate cancel drop the open window's usage instead of
 *    settling it, or the settled charge bills with the wrong kind or tax flags.
 *
 *   pnpm verify:usage-item-removal
 */
import { and, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  cancelSubscriptionWithOptions,
  createSubscription,
  deleteProvisionalSubscription,
} from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { removeSubscriptionItem } from "@/modules/subscriptions/items";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { deleteUsage, getUsage, listUsagePage, recordUsage } from "@/modules/metering/service";
import { invoiceLineItems, subscriptionItems, unbilledCharges, usageRecords } from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const MIN = 60_000;
const RUN = Math.random().toString(36).slice(2, 8);

async function main() {
  const org = await createOrganization({ name: `Usage Removal Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Usage Removal Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `usage-removal-${RUN}@example.com`,
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
    name: "Calls",
    id: `calls-${RUN}`,
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
  const subscribe = async () =>
    (
      await createSubscription({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        now: new Date(),
        items: [
          { price: monthly, quantity: 1 },
          { price: usagePrice, quantity: 1 },
        ],
      })
    ).subscription;
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
  const usageLines = (invoiceId: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(invoiceLineItems)
        .where(and(eq(invoiceLineItems.invoiceId, invoiceId), eq(invoiceLineItems.kind, "usage"))),
    );

  // ── Bill usage, then remove the item ──────────────────────────────────────
  const sub = await subscribe();
  const start = sub.currentPeriodStart!;
  const end = sub.currentPeriodEnd!;
  const item = await usageItemOf(sub.id);
  const billed = await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: item.id,
    quantity: 7,
    timestamp: new Date(start.getTime() + MIN),
  });
  // The renewal at `end`: bills the closed period's usage in arrears.
  const next = new Date(end.getTime() + (end.getTime() - start.getTime()));
  const renewal = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: end,
    periodEnd: next,
    usagePeriod: { start, end },
  });
  const line = (await usageLines(renewal.invoice.id))[0];
  ok("the renewal bills the usage", line?.quantity === 7, String(line?.quantity));

  // Recorded after the window was billed; not billed when the item goes.
  const unbilled = await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: item.id,
    quantity: 4,
    timestamp: new Date(end.getTime() + MIN),
  });
  await removeSubscriptionItem({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    itemPublicId: item.publicId,
    now: new Date(),
  });

  const kept = await getUsage(orgId, biz.id, billed.publicId);
  ok("billed usage survives the item's removal", kept != null);
  ok("…still under its subscription", kept?.subscriptionPublicId === sub.publicId);
  ok("…with no item", kept != null && kept.itemPublicId === null, String(kept?.itemPublicId));
  ok("…and its price", kept?.pricePublicId === usagePrice.publicId, String(kept?.pricePublicId));
  ok(
    "…and it still names the invoice that billed it",
    kept?.invoicePublicId === renewal.invoice.publicId,
    String(kept?.invoicePublicId),
  );
  const refused = await deleteUsage(orgId, biz.id, billed.publicId).then(
    () => "deleted",
    (e: Error) => e?.name ?? String(e),
  );
  ok("…and it still cannot be deleted", refused === "UsageInvoicedError", refused);
  ok("unbilled usage survives too", (await getUsage(orgId, biz.id, unbilled.publicId)) != null);
  const listed = await listUsagePage(orgId, biz.id, { subscriptionPublicId: sub.publicId });
  ok(
    "the subscription's usage list still shows both",
    listed.data.length === 2,
    String(listed.data.length),
  );

  // A kept record is never rated again: no item bills it.
  const after = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: next,
    periodEnd: new Date(next.getTime() + (end.getTime() - start.getTime())),
    usagePeriod: { start: end, end: next },
  });
  ok("the next renewal bills no usage", (await usageLines(after.invoice.id)).length === 0);

  // ── Settlement: the open window is billed, not dropped ─────────────────────
  const untaxed = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: meter.id,
    type: "recurring",
    model: "usage",
    usageAggregation: "sum",
    currency: "USD",
    amountMinor: 100,
    interval: "month",
    isTaxable: false,
  });
  const settledOf = (subId: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(unbilledCharges)
        .where(
          and(
            eq(unbilledCharges.subscriptionId, subId),
            eq(unbilledCharges.entityType, "usage_settlement"),
          ),
        ),
    );
  const withUsage = async (qty: number) => {
    const { subscription: s, items } = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: new Date(),
      items: [
        { price: monthly, quantity: 1 },
        { price: untaxed, quantity: 1 },
      ],
    });
    const it = items.find((i) => i.priceId === untaxed.id)!;
    await recordUsage({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionItemId: it.id,
      quantity: qty,
      timestamp: s.currentPeriodStart!,
    });
    return { s, it };
  };
  {
    const { s, it } = await withUsage(5);
    await removeSubscriptionItem({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s.id,
      itemPublicId: it.publicId,
      now: new Date(),
    });
    const settled = await settledOf(s.id);
    ok(
      "removal settles the open window (5 × 100)",
      settled.length === 1 && settled[0]!.amountMinor === 500n && settled[0]!.quantity === 5,
      JSON.stringify(settled.map((c) => Number(c.amountMinor))),
    );
    const end = s.currentPeriodEnd!;
    const renewalOfS = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: s,
      periodStart: end,
      periodEnd: new Date(end.getTime() + (end.getTime() - s.currentPeriodStart!.getTime())),
    });
    const folded = (await usageLines(renewalOfS.invoice.id)).find((l) => l.priceId === untaxed.id);
    ok(
      "…the next renewal bills it as a usage line of its price",
      folded?.amountMinor === 500n && folded.kind === "usage",
      String(folded?.amountMinor),
    );
    ok("…and marks the charge billed", (await settledOf(s.id))[0]?.status === "billed");
  }
  {
    const { s } = await withUsage(3);
    await changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s.id,
      now: new Date(),
      changes: [],
      resetTerm: true,
      invoiceImmediately: true,
    });
    const settled = await settledOf(s.id);
    ok(
      "a term reset settles the old term's usage (3 × 100)",
      settled.length === 1 && settled[0]!.amountMinor === 300n,
      JSON.stringify(settled.map((c) => Number(c.amountMinor))),
    );
  }
  {
    const { s } = await withUsage(2);
    await cancelSubscriptionWithOptions({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s.id,
      now: new Date(),
      cancelOption: "immediately",
      unbilledChargesOption: "invoice",
    });
    const settled = await settledOf(s.id);
    ok(
      "an immediate cancel settles and invoices the open window (2 × 100)",
      settled.length === 1 && settled[0]!.amountMinor === 200n && settled[0]!.status === "billed",
      JSON.stringify(settled.map((c) => [Number(c.amountMinor), c.status])),
    );
  }

  // ── A provisional subscription's delete still takes its usage ─────────────
  const prov = await subscribe();
  const provUsage = await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: (await usageItemOf(prov.id)).id,
    quantity: 2,
    timestamp: new Date(),
  });
  await deleteProvisionalSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: prov.id,
  });
  const left = await systemDb
    .select({ id: usageRecords.id })
    .from(usageRecords)
    .where(eq(usageRecords.publicId, provUsage.publicId));
  ok(
    "deleting a provisional subscription deletes its usage",
    left.length === 0,
    String(left.length),
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
console.log(pass ? "\n✅ USAGE-ITEM-REMOVAL: PASS" : "\n❌ USAGE-ITEM-REMOVAL: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
