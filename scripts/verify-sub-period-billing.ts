/**
 * Monthly usage billing inside a longer term (0383/0384). What regresses without each check:
 *  - a boundary is billed twice, skipped, or its window overlaps the next (usage billed
 *    twice or never);
 *  - the renewal re-bills the term from its start instead of from the usage cursor;
 *  - two concurrent ticks raise two invoices for one boundary;
 *  - catch-up after downtime bills months out of order or in one lump;
 *  - backdated usage lands in a month already billed;
 *  - regenerating a monthly usage invoice bills the plan fee;
 *  - removing a metered item settles from the term start, not the cursor;
 *  - a term-end cancel re-bills months already billed;
 *  - the feature is accepted where it cannot work (day cadence, add-on, pending invoices);
 *  - with the flag off, anything changes.
 *
 *   pnpm verify:sub-period-billing
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { cancelSubscriptionWithOptions, createSubscription } from "@/modules/subscriptions/service";
import { removeSubscriptionItem } from "@/modules/subscriptions/items";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { recordUsage } from "@/modules/metering/service";
import { regenerateInvoice, voidInvoice } from "@/modules/invoicing/ops";
import {
  invoiceLineItems,
  invoices,
  subscriptionItems,
  subscriptions,
  unbilledCharges,
} from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;
const errName = (p: Promise<unknown>) =>
  p.then(
    () => "fulfilled",
    (e: Error) => `${e?.name}: ${e?.message}`,
  );

async function main() {
  const org = await createOrganization({ name: `Sub Period Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Sub Period Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // Auto-collection off: invoices stay open, so one can be voided and regenerated.
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `sub-period-${RUN}@example.com`,
    autoCollection: "off",
  });
  const plan = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Annual",
    id: `annual-${RUN}`,
    kind: "plan",
  });
  const meter = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Calls",
    id: `calls-${RUN}`,
    kind: "addon",
  });
  const priceArgs = { organizationId: orgId, businessId: biz.id, currency: "USD" };
  const splitPlan = await createPrice({
    ...priceArgs,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    amountMinor: 1_200_000,
    interval: "year",
    billUsageMonthly: true,
  });
  const plainPlan = await createPrice({
    ...priceArgs,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    amountMinor: 1_200_000,
    interval: "year",
  });
  const monthlyUsage = await createPrice({
    ...priceArgs,
    productId: meter.id,
    type: "recurring",
    model: "usage",
    usageAggregation: "sum",
    amountMinor: 200,
    interval: "month",
  });
  const yearlyUsage = await createPrice({
    ...priceArgs,
    productId: meter.id,
    type: "recurring",
    model: "usage",
    usageAggregation: "sum",
    amountMinor: 200,
    interval: "year",
  });

  // ── Refused where it cannot work ───────────────────────────────────────────
  ok(
    "a monthly plan price cannot bill usage monthly",
    (
      await errName(
        createPrice({
          ...priceArgs,
          productId: plan.id,
          type: "recurring",
          model: "flat",
          amountMinor: 100,
          interval: "month",
          billUsageMonthly: true,
        }),
      )
    ).startsWith("CatalogError"),
  );
  ok(
    "a day-cadence plan price cannot bill usage monthly",
    (
      await errName(
        createPrice({
          ...priceArgs,
          productId: plan.id,
          type: "recurring",
          model: "flat",
          amountMinor: 100,
          interval: "day",
          intervalCount: 365,
          billUsageMonthly: true,
        }),
      )
    ).startsWith("CatalogError"),
  );
  ok(
    "an add-on price cannot carry the flag",
    (
      await errName(
        createPrice({
          ...priceArgs,
          productId: meter.id,
          type: "recurring",
          model: "flat",
          amountMinor: 100,
          interval: "year",
          billUsageMonthly: true,
        }),
      )
    ).startsWith("CatalogError"),
  );
  const subscribe = (
    start: Date,
    items: Array<{ price: typeof splitPlan; quantity: number }>,
    extra: Record<string, unknown> = {},
  ) =>
    createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: new Date(),
      startDate: start,
      items,
      ...extra,
    }).then((r) => r.subscription);
  const now = new Date();
  const monthStart = (back: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  ok(
    "pending invoices + monthly usage is refused",
    (
      await errName(
        subscribe(
          monthStart(1),
          [
            { price: splitPlan, quantity: 1 },
            { price: monthlyUsage, quantity: 1 },
          ],
          { createPendingInvoices: true },
        ),
      )
    ).startsWith("SubscriptionError"),
  );
  ok(
    "a monthly usage price on a yearly term without the flag is still refused",
    (
      await errName(
        subscribe(monthStart(1), [
          { price: plainPlan, quantity: 1 },
          { price: monthlyUsage, quantity: 1 },
        ]),
      )
    ).startsWith("SubscriptionError"),
  );

  // ── Fixtures ───────────────────────────────────────────────────────────────
  // A: 13 months ago → B1..B11, the renewal T1, then B'1 (the 1st of this month).
  const T0 = monthStart(13);
  const a = await subscribe(T0, [
    { price: splitPlan, quantity: 1 },
    { price: monthlyUsage, quantity: 1 },
  ]);
  // E: 12 months ago, cancelled at term end.
  const E0 = monthStart(12);
  const e = await subscribe(E0, [
    { price: splitPlan, quantity: 1 },
    { price: monthlyUsage, quantity: 1 },
  ]);
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: e.id,
    now: new Date(),
    cancelOption: "end_of_term",
  });
  // D: flags off (golden), 12 months ago, yearly usage.
  const d = await subscribe(E0, [
    { price: plainPlan, quantity: 1 },
    { price: yearlyUsage, quantity: 1 },
  ]);
  ok(
    "the flag is copied from the plan price, with the first sub-period",
    a.billUsageMonthly &&
      a.currentSubPeriodStart?.getTime() === T0.getTime() &&
      a.currentSubPeriodEnd?.getTime() === monthStart(12).getTime(),
    `${a.currentSubPeriodStart?.toISOString()} ${a.currentSubPeriodEnd?.toISOString()}`,
  );
  ok("flags off → no sub-period", !d.billUsageMonthly && d.currentSubPeriodEnd == null);

  const usageItem = async (subId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subId)),
      )
    ).find((i) => i.priceId === monthlyUsage.id || i.priceId === yearlyUsage.id)!;
  const aItem = await usageItem(a.id);
  const eItem = await usageItem(e.id);
  const dItem = await usageItem(d.id);
  const record = (itemId: string, quantity: number, at: Date) =>
    recordUsage({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionItemId: itemId,
      quantity,
      timestamp: at,
    });
  // Month k of the first term carries k units; the new term's first month 100.
  for (let k = 1; k <= 12; k++) {
    await record(aItem.id, k, new Date(monthStart(14 - k).getTime() + 2 * DAY));
    await record(eItem.id, k, new Date(monthStart(13 - k).getTime() + 2 * DAY));
  }
  await record(aItem.id, 100, new Date(monthStart(1).getTime() + 2 * DAY));
  await record(dItem.id, 5, new Date(E0.getTime() + 2 * DAY));
  await record(dItem.id, 7, new Date(monthStart(1).getTime() + 2 * DAY));

  // ── Catch-up: one boundary per subscription per tick; the first two ticks race ──
  const tick = () =>
    runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  const tickErrors: unknown[] = [];
  const first = await Promise.all([tick(), tick()]);
  for (const t of first) tickErrors.push(...t.errors);
  for (let i = 0; i < 16; i++) tickErrors.push(...(await tick()).errors);
  ok("no tick recorded a failure", tickErrors.length === 0, JSON.stringify(tickErrors));

  const invoicesOf = (subId: string) =>
    withTenant(orgId, (tx) => tx.select().from(invoices).where(eq(invoices.subscriptionId, subId)));
  const linesOf = (invoiceId: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)),
    );
  const isSub = (i: typeof invoices.$inferSelect) =>
    (i.metadata as { sub_period?: unknown } | null)?.sub_period != null;

  const aInvs = (await invoicesOf(a.id)).sort(
    (x, y) => x.periodStart!.getTime() - y.periodStart!.getTime(),
  );
  const aSub = aInvs.filter(isSub);
  ok("A: one monthly usage invoice per boundary (11 + 1)", aSub.length === 12, String(aSub.length));
  const keys = aInvs.filter((i) => i.opensPeriod).map((i) => i.periodStart!.getTime());
  ok("A: clock invoice keys are unique", new Set(keys).size === keys.length);
  let contiguous = true;
  let qtyOk = true;
  let fixedOnSub = false;
  for (let k = 1; k <= 11; k++) {
    const inv = aSub.find((i) => i.periodStart!.getTime() === monthStart(13 - k).getTime());
    const lines = inv ? await linesOf(inv.id) : [];
    const usage = lines.filter((l) => l.kind === "usage");
    if (lines.some((l) => l.kind === "recurring")) fixedOnSub = true;
    if (
      usage.length !== 1 ||
      usage[0]!.periodStart!.getTime() !== monthStart(14 - k).getTime() ||
      usage[0]!.periodEnd!.getTime() !== monthStart(13 - k).getTime()
    )
      contiguous = false;
    if (usage[0]?.quantity !== k) qtyOk = false;
  }
  ok("A: each month's window starts where the last ended", contiguous);
  ok("A: each month bills exactly its own usage", qtyOk);
  ok("A: monthly usage invoices carry no plan fee", !fixedOnSub);
  const renewal = aInvs.find(
    (i) => !isSub(i) && i.periodStart!.getTime() === monthStart(1).getTime(),
  );
  const rLines = renewal ? await linesOf(renewal.id) : [];
  const rUsage = rLines.filter((l) => l.kind === "usage");
  ok(
    "A: the renewal bills the plan fee and only the last month's usage",
    rLines.some((l) => l.kind === "recurring" && l.amountMinor === 1_200_000n) &&
      rUsage.length === 1 &&
      rUsage[0]!.quantity === 12 &&
      rUsage[0]!.periodStart!.getTime() === monthStart(2).getTime(),
    rUsage.map((l) => `${l.quantity}@${l.periodStart?.toISOString()}`).join(","),
  );
  let total = 0;
  for (const inv of aInvs)
    for (const l of await linesOf(inv.id)) if (l.kind === "usage") total += l.quantity;
  ok("A: Σ billed usage = Σ recorded usage", total === 78 + 100, String(total));
  const [aNow] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, a.id)),
  );
  ok(
    "A: the cursor is the 1st of this month, the next boundary next month",
    aNow!.currentSubPeriodStart?.getTime() === monthStart(0).getTime() &&
      aNow!.currentSubPeriodEnd?.getTime() === monthStart(-1).getTime(),
  );
  const before = (await invoicesOf(a.id)).length;
  await tick();
  ok("A: another tick raises nothing", (await invoicesOf(a.id)).length === before);

  // ── Backdated usage into a billed month ────────────────────────────────────
  const late = await errName(
    recordUsage({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionItemId: aItem.id,
      quantity: 1,
      timestamp: new Date(monthStart(3).getTime() + DAY),
      checkWindow: true,
    }),
  );
  ok("usage dated in a billed month is refused", late.startsWith("UsageOutsideWindowError"), late);

  // ── Regenerate a monthly usage invoice ─────────────────────────────────────
  const third = aSub.find((i) => i.periodStart!.getTime() === monthStart(10).getTime())!;
  await voidInvoice(orgId, biz.id, third.publicId);
  const regen = await regenerateInvoice(orgId, biz.id, third.publicId);
  const regenLines = await linesOf(regen.invoice.id);
  ok(
    "a regenerated monthly usage invoice re-bills its window and no plan fee",
    isSub(regen.invoice) &&
      regenLines.every((l) => l.kind !== "recurring") &&
      regenLines.find((l) => l.kind === "usage")?.quantity === 3,
    regenLines.map((l) => `${l.kind}:${l.quantity}`).join(","),
  );

  // ── Removing the metered item settles from the cursor ─────────────────────
  await record(
    aItem.id,
    4,
    new Date(Math.max(monthStart(0).getTime() + 1000, Date.now() - 60_000)),
  );
  await removeSubscriptionItem({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: a.id,
    itemPublicId: aItem.publicId,
    now: new Date(),
  });
  const settled = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(unbilledCharges)
      .where(
        and(
          eq(unbilledCharges.subscriptionId, a.id),
          eq(unbilledCharges.entityType, "usage_settlement"),
        ),
      ),
  );
  ok(
    "removal settles only the open month",
    settled.length === 1 &&
      settled[0]!.periodStart?.getTime() === monthStart(0).getTime() &&
      settled[0]!.quantity === 4,
    settled.map((s) => `${s.quantity}@${s.periodStart?.toISOString()}`).join(","),
  );

  // ── Term-end cancel bills only the last window ─────────────────────────────
  const eInvs = await invoicesOf(e.id);
  const eSub = eInvs.filter(isSub);
  const final = eInvs.find(
    (i) => !isSub(i) && i.periodStart!.getTime() === E0.getTime() && !i.opensPeriod,
  );
  const finalUsage = final ? (await linesOf(final.id)).filter((l) => l.kind === "usage") : [];
  ok("E: 11 monthly usage invoices before the term end", eSub.length === 11, String(eSub.length));
  ok(
    "E: the term-end cancel bills only the last month",
    finalUsage.length === 1 &&
      finalUsage[0]!.quantity === 12 &&
      finalUsage[0]!.periodStart!.getTime() === monthStart(1).getTime(),
    finalUsage.map((l) => `${l.quantity}@${l.periodStart?.toISOString()}`).join(","),
  );

  // ── Flags off: unchanged ───────────────────────────────────────────────────
  const dInvs = await invoicesOf(d.id);
  const dRenewal = dInvs.find((i) => i.periodStart!.getTime() === monthStart(0).getTime());
  const dUsage = dRenewal ? (await linesOf(dRenewal.id)).filter((l) => l.kind === "usage") : [];
  ok("D: no monthly usage invoices", !dInvs.some(isSub));
  ok(
    "D: the renewal bills the whole term's usage from the term start",
    dUsage.length === 1 &&
      dUsage[0]!.quantity === 12 &&
      dUsage[0]!.periodStart!.getTime() === E0.getTime(),
    dUsage.map((l) => `${l.quantity}@${l.periodStart?.toISOString()}`).join(","),
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
console.log(pass ? "\n✅ SUB-PERIOD-BILLING: PASS" : "\n❌ SUB-PERIOD-BILLING: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
