/**
 * Threshold invoicing (design G5 §3.7), end to end on meter prices:
 *  - tiered usage billed as 2 interim invoices + the final one sums exactly to the whole period;
 *    concurrent checks make one interim invoice; usage_through does not move until period end;
 *  - a late event before the mark still bills at period end (`usageWindowStart` ignores interim
 *    lines); interim and final lines carry usage to date and billed before;
 *  - a voided interim invoice is re-billed; a volume item never bills early; a subscription
 *    override wins and turns it off; a two-step list fails the CHECK;
 *  - coupons: none on an interim invoice, the whole period's on the final one; a fixed discount
 *    larger than the final invoice is credited on the last interim invoice;
 *  - credit grants pay an interim invoice before tax, as on a period invoice;
 *  - on arrival: a dirty mark makes the interim invoice on the next `usage_controls_check`;
 *  - two interim invoices on a pre-debit notice rail are both charged after the lead.
 *
 *   pnpm verify:all:fresh -- --suite threshold-invoicing
 */
import { and, eq } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { startTimeTravel, travelForward } from "@/modules/time-travel/service";
import { runDunningPass } from "@/modules/subscriptions/dunning";
import { runInvoiceDueTransitions } from "@/modules/invoicing/due";
import { createSubscription } from "@/modules/subscriptions/service";
import { applyManualDiscount } from "@/modules/coupons/service";
import { addSubscriptionItem, removeSubscriptionItem } from "@/modules/subscriptions/items";
import { createPromotionalGrant } from "@/modules/credits/service";
import { voidInvoice } from "@/modules/invoicing/ops";
import { assembleInvoiceDocument, lineFigures } from "@/modules/invoicing/document";
import { usageWindowStart } from "@/modules/subscriptions/usage-window";
import { runUsageControlsCheck } from "@/modules/usage-controls/check";
import {
  deleteUsageThreshold,
  listUsageThresholds,
  putPlanUsageThreshold,
  putSubscriptionUsageThreshold,
  raiseInterimInvoice,
  runUsageThresholdInvoices,
  serializeUsageThresholds,
} from "@/modules/usage-controls/threshold-invoicing";
import {
  creditNotes,
  customerMeterBilling,
  events,
  invoices,
  preDebitNotices,
  subscriptionItems,
  timeTravels,
  unbilledCharges,
  usageControlDirty,
  usageInvoiceThresholds,
} from "@db/schema";
import {
  checker,
  createTestMeter,
  invoicesOf,
  meterBusiness,
  newCustomer,
  sendEvent,
  setTerm,
  tick,
  usageLines,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const H = 3_600_000;
const E = new Date(Math.floor((Date.now() - 4 * H) / 60_000) * 60_000);
const S = new Date(E.getTime() - 24 * H);
const at = (h: number) => new Date(S.getTime() + h * H);

type Biz = Awaited<ReturnType<typeof meterBusiness>>;

async function setup(name: string) {
  const b = await meterBusiness(name);
  const meter = await createTestMeter(b.ids, { aggregation: "sum" });
  await putPlanUsageThreshold({
    ...b.ids,
    productPublicId: b.product.publicId,
    currency: "USD",
    amountMinor: 500n,
  });
  return { ...b, meter };
}
let pn = 0;
const priceOf = (b: Biz & { meter: { key: string } }, p: Record<string, unknown>) =>
  createPrice({
    ...b.ids,
    productId: b.product.id,
    id: `ti-${++pn}-${Date.now()}`,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    meter: b.meter.key,
    ...p,
  } as Parameters<typeof createPrice>[0]);
async function subscribe(b: Biz, price: { id: string }, term = { start: S, end: E }) {
  const customer = await newCustomer(b.ids, `ti${++pn}`);
  const created = await createSubscription({
    ...b.ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: price as never, quantity: 1 }],
  });
  await setTerm(created.subscription.id, term.start, term.end);
  return { customer, sub: created.subscription };
}
const send = (
  b: Biz & { meter: { eventName: string } },
  customerId: string,
  t: Date,
  tokens: number,
) => sendEvent(b.ids, { customerId, eventName: b.meter.eventName, at: t, properties: { tokens } });
const raise = (b: Biz, subscriptionId: string, now: Date) =>
  raiseInterimInvoice({ ...b.ids, subscriptionId, now });
const interimsOf = (subId: string) =>
  systemDb
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, subId), eq(invoices.purpose, "usage_interim")))
    .orderBy(invoices.createdAt);
const linesOf = async (orgId: string, subId: string, invId: string) =>
  usageLines((await invoicesOf(orgId, subId)).find((x) => x.inv.id === invId)?.lines ?? []);
const sum = (xs: Array<{ amountMinor: bigint }>) =>
  xs.reduce((a, l) => a + Number(l.amountMinor), 0);
const collect = (b: Biz) =>
  runWithClockScope({ onlyBusinessId: b.biz.id }, () => runUsageThresholdInvoices(new Date()));
const rating = (l: { rating: unknown }) =>
  (l.rating ?? {}) as { cumulative_minor?: number; billed_before_minor?: number };

// ── 1. Two interim invoices + the final one sum exactly; idempotent; late usage ────────
console.log("1. interim, interim, final");
{
  const b = await setup("Threshold sums");
  // 10 × 100, then 50 a unit.
  const price = await priceOf(b, {
    model: "tiered",
    meterTiers: [
      { up_to: "10", unit_amount_decimal: "100" },
      { up_to: null, unit_amount_decimal: "50" },
    ],
  });
  const { customer, sub } = await subscribe(b, price);
  await send(b, customer.id, at(1), 4);
  const below = await raise(b, sub.id, at(2));
  check("400 unbilled is below the 500 threshold: no invoice", below.outcome === "below", below);
  await send(b, customer.id, at(3), 4);
  const racing = await Promise.all(Array.from({ length: 5 }, () => raise(b, sub.id, at(4))));
  const first = await interimsOf(sub.id);
  check(
    "5 concurrent checks at 800 unbilled raise ONE interim invoice (origin token)",
    first.length === 1 &&
      racing.filter((r) => r.outcome === "raised").length === 1 &&
      first[0]!.originToken === `uti:${sub.publicId}:${S.toISOString()}:1`,
    racing.map((r) => r.outcome),
  );
  check(
    "the interim invoice bills 800 (8 × 100)",
    first[0]?.subtotalMinor === 800n,
    first[0]?.subtotalMinor,
  );
  const [item] = await systemDb
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, sub.id));
  const [pointer] = await systemDb
    .select()
    .from(customerMeterBilling)
    .where(eq(customerMeterBilling.customerId, customer.id));
  check(
    "usage_billed_through = the cut; the meter's usage_through does not move",
    item?.usageBilledThrough?.getTime() === at(4).getTime() && pointer?.usageThrough == null,
    { through: item?.usageBilledThrough, pointer: pointer?.usageThrough },
  );
  await send(b, customer.id, at(5), 5);
  check("1,150 to date, 350 unbilled: below", (await raise(b, sub.id, at(6))).outcome === "below");
  await send(b, customer.id, at(7), 6);
  check(
    "1,450 to date, 650 unbilled: raised",
    (await raise(b, sub.id, at(8))).outcome === "raised",
  );
  const both = await interimsOf(sub.id);
  const l2 = await linesOf(b.orgId, sub.id, both[1]!.id);
  check(
    "the second interim line: usage to date 1,450 · billed before 800 · this invoice 650",
    sum(l2) === 650 &&
      rating(l2[0]!).cumulative_minor === 1450 &&
      rating(l2[0]!).billed_before_minor === 800,
    l2.map((l) => [l.amountMinor, l.rating]),
  );
  // A late event before the mark: still accepted, billed at period end.
  await send(b, customer.id, at(2), 2);
  const start = await withTenant(b.orgId, (tx) => usageWindowStart(tx, item!.id));
  check(
    "usageWindowStart ignores interim lines: late usage before the mark is still open",
    start?.start.getTime() === S.getTime(),
    start,
  );
  await collect(b);
  check(
    "the pass collects both interim invoices",
    (await interimsOf(sub.id)).every((i) => i.status === "paid"),
    (await interimsOf(sub.id)).map((i) => i.status),
  );
  await tick(b.biz.id);
  const all = await invoicesOf(b.orgId, sub.id);
  const final = all.find(
    (x) => x.inv.purpose == null && x.inv.periodStart?.getTime() === E.getTime(),
  );
  const fl = usageLines(final?.lines ?? []);
  check(
    "the final invoice bills the rest: 1,550 − 1,450 = 100 (late usage included)",
    sum(fl) === 100 &&
      rating(fl.find((l) => rating(l).cumulative_minor != null) ?? fl[0]!).cumulative_minor ===
        1550 &&
      rating(fl.find((l) => rating(l).cumulative_minor != null) ?? fl[0]!).billed_before_minor ===
        1450,
    fl.map((l) => [l.amountMinor, l.rating]),
  );
  check(
    "the interim line shows its 11 units and says what this invoice bills",
    Number(l2[0]!.quantityDecimal) === 11 && l2[0]!.description.endsWith("· this invoice $6.50"),
    [l2[0]!.quantityDecimal, l2[0]!.description],
  );
  const doc2 = await assembleInvoiceDocument(b.orgId, b.biz.id, both[1]!.publicId);
  const fig = doc2 ? lineFigures(doc2.chargeLines[0]!, "USD") : null;
  check(
    "the PDF prints the interim line as the dashboard does: 11 units at $0.5909 (rounded average)",
    fig?.quantity === "11" && fig.unitPrice === "$0.5909",
    fig,
  );
  check(
    "the interim PDF's period runs to the cut, and the next bill is the term's end",
    doc2?.subscription?.periodStart?.getTime() === S.getTime() &&
      doc2.subscription.periodEnd?.getTime() === at(8).getTime() &&
      doc2.subscription.nextBillingDate?.getTime() === E.getTime(),
    doc2?.subscription,
  );
  check(
    "the final line says what interim invoices billed and what this invoice bills",
    fl.some((l) =>
      l.description.endsWith("· billed on interim invoices $14.50 · this invoice $1.00"),
    ),
    fl.map((l) => l.description),
  );
  check(
    "Σ interim + final = the single-invoice amount (21 tokens tiered: 800 + 650 + 100 = 1,550)",
    Number(both[0]!.subtotalMinor) + Number(both[1]!.subtotalMinor) + sum(fl) === 1550,
  );
  const [after] = await systemDb
    .select()
    .from(customerMeterBilling)
    .where(eq(customerMeterBilling.customerId, customer.id));
  check(
    "the final invoice moves usage_through to the period end",
    after?.usageThrough?.getTime() === E.getTime(),
  );
  const reached = await systemDb
    .select()
    .from(events)
    .where(and(eq(events.type, "usage_threshold_reached"), eq(events.resourceId, sub.publicId)));
  check("usage_threshold_reached once per interim invoice", reached.length === 2, reached.length);
  const rd =
    Object.values(reached[0]!.data as Record<string, Record<string, unknown>>).find(
      (v) => v && typeof v === "object" && "billed_through" in v,
    ) ?? {};
  const [row] = await serializeUsageThresholds(b.orgId, await listUsageThresholds(b.ids));
  check(
    "times are ISO 8601, as in every other response: the event and the threshold",
    typeof rd.period_start === "string" &&
      typeof rd.billed_through === "string" &&
      typeof row?.created_at === "string",
    { data: reached[0]!.data, created_at: row?.created_at },
  );
}

// ── 2. Void, volume, override, CHECK ────────────────────────────────────────────────
console.log("2. void, volume, override, shape");
{
  const b = await setup("Threshold shape");
  const price = await priceOf(b, { unitAmountDecimal: "100" });
  const { customer, sub } = await subscribe(b, price);
  await send(b, customer.id, at(1), 8);
  await raise(b, sub.id, at(2));
  const [v] = await interimsOf(sub.id);
  await voidInvoice(b.orgId, b.biz.id, v!.publicId, {});
  await raise(b, sub.id, at(3));
  const after = await interimsOf(sub.id);
  check(
    "a voided interim invoice is re-billed in full",
    after.length === 2 && after[1]!.subtotalMinor === 800n && after[0]!.status === "voided",
    after.map((i) => [i.status, i.subtotalMinor]),
  );

  const volume = await priceOf(b, {
    model: "volume",
    meterTiers: [
      { up_to: "10", unit_amount_decimal: "100" },
      { up_to: null, unit_amount_decimal: "50" },
    ],
  });
  const vs = await subscribe(b, volume);
  await send(b, vs.customer.id, at(1), 20);
  const vr = await raise(b, vs.sub.id, at(2));
  check(
    "a volume item never bills early",
    vr.outcome === "below" && (await interimsOf(vs.sub.id)).length === 0,
    vr,
  );

  const os = await subscribe(b, price);
  await send(b, os.customer.id, at(1), 8);
  await putSubscriptionUsageThreshold({
    ...b.ids,
    subscriptionPublicId: os.sub.publicId,
    amountMinor: 2_000n,
  });
  check(
    "an override of 2,000 wins over the plan's 500",
    (await raise(b, os.sub.id, at(2))).outcome === "below",
  );
  await putSubscriptionUsageThreshold({
    ...b.ids,
    subscriptionPublicId: os.sub.publicId,
    amountMinor: null,
  });
  check("an override of null turns it off", (await raise(b, os.sub.id, at(2))).outcome === "off");
  await deleteUsageThreshold({ ...b.ids, subscriptionPublicId: os.sub.publicId });
  check(
    "without the override the plan's amount applies again",
    (await raise(b, os.sub.id, at(2))).outcome === "raised",
  );

  let refused = false;
  try {
    await systemDb.insert(usageInvoiceThresholds).values({
      ...b.ids,
      scope: "subscription",
      subscriptionId: vs.sub.id,
      currency: "USD",
      steps: [
        { amount_minor: 100, recurring: true },
        { amount_minor: 200, recurring: true },
      ] as never,
    });
  } catch {
    refused = true;
  }
  check("a steps list of length 2 is refused by the CHECK", refused);
}

// ── 3. Coupons only on the final invoice; the excess is credited on the last interim ───
console.log("3. discounts");
{
  const b = await setup("Threshold discounts");
  const price = await priceOf(b, { unitAmountDecimal: "1" });
  const pct = await subscribe(b, price);
  await applyManualDiscount({
    ...b.ids,
    subscriptionId: pct.sub.id,
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
    now: new Date(),
  });
  await send(b, pct.customer.id, at(1), 600);
  await raise(b, pct.sub.id, at(2));
  const [i1] = await interimsOf(pct.sub.id);
  check(
    "a 20% coupon makes no discount on the interim invoice",
    i1?.subtotalMinor === 600n && i1?.totalMinor === 600n,
    { sub: i1?.subtotalMinor, total: i1?.totalMinor },
  );
  await send(b, pct.customer.id, at(3), 400);
  await collect(b);
  const fixed = await subscribe(b, price);
  await applyManualDiscount({
    ...b.ids,
    subscriptionId: fixed.sub.id,
    kind: "fixed_amount",
    amountOffMinor: 500,
    currency: "USD",
    durationType: "forever",
    now: new Date(),
  });
  await send(b, fixed.customer.id, at(1), 900);
  await raise(b, fixed.sub.id, at(2));
  await send(b, fixed.customer.id, at(3), 100);
  await collect(b);
  await tick(b.biz.id);
  const pf = (await invoicesOf(b.orgId, pct.sub.id)).find(
    (x) => x.inv.purpose == null && x.inv.periodStart?.getTime() === E.getTime(),
  );
  check(
    "the final invoice carries the whole period's discount: 20% × 1,000 = 200 on 400 usage",
    sum(usageLines(pf?.lines ?? [])) === 400 && pf?.inv.totalMinor === 200n,
    { total: pf?.inv.totalMinor, lines: pf?.lines.map((l) => [l.kind, l.amountMinor]) },
  );
  const ff = (await invoicesOf(b.orgId, fixed.sub.id)).find(
    (x) => x.inv.purpose == null && x.inv.periodStart?.getTime() === E.getTime(),
  );
  check(
    "a fixed 500 discount on a 100 final invoice takes it to 0, 400 left over",
    ff?.inv.totalMinor === 0n &&
      (ff?.inv.metadata as Record<string, unknown> | null)?.interim_excess_minor === "400",
    { total: ff?.inv.totalMinor, meta: ff?.inv.metadata },
  );
  await collect(b);
  const [fi] = await interimsOf(fixed.sub.id);
  const notes = await systemDb.select().from(creditNotes).where(eq(creditNotes.invoiceId, fi!.id));
  check(
    "the excess (400) is a credit note on the last interim invoice, once",
    notes.length === 1 && notes[0]!.totalMinor === 400n,
    notes.map((n) => [n.kind, n.totalMinor]),
  );
  await collect(b);
  check(
    "a second pass credits nothing more",
    (await systemDb.select().from(creditNotes).where(eq(creditNotes.invoiceId, fi!.id))).length ===
      1,
  );
}

// ── 4. Credit grants pay an interim invoice before tax (the PR 3 decision) ─────────────
console.log("4. grants on interim invoices");
{
  const b = await setup("Threshold grants");
  const price = await priceOf(b, { unitAmountDecimal: "1" });
  const s = await subscribe(b, price);
  await createPromotionalGrant({
    ...b.ids,
    customerPublicId: s.customer.publicId,
    currency: "USD",
    amount: 300n,
    effectiveAt: new Date(S.getTime() - H),
  });
  await send(b, s.customer.id, at(1), 600);
  await raise(b, s.sub.id, at(2));
  const [i] = await interimsOf(s.sub.id);
  check(
    "a promotional grant pays 300 of the interim invoice before tax; 300 is due",
    i?.grantCreditsPreTaxMinor === 300n && i?.amountDueMinor === 300n,
    { pre: i?.grantCreditsPreTaxMinor, due: i?.amountDueMinor },
  );
}

// ── 5. On arrival: the dirty mark makes the interim invoice on the next check ───────────
console.log("5. on arrival");
{
  const b = await setup("Threshold arrival");
  const price = await priceOf(b, { unitAmountDecimal: "1" });
  const now = new Date();
  const s = await subscribe(b, price, {
    start: new Date(now.getTime() - 2 * H),
    end: new Date(now.getTime() + 22 * H),
  });
  await send(b, s.customer.id, new Date(now.getTime() - H), 600);
  await systemDb
    .insert(usageControlDirty)
    .values({ customerId: s.customer.id, ...b.ids })
    .onConflictDoNothing();
  await runWithClockScope({ onlyBusinessId: b.biz.id }, () => runUsageControlsCheck());
  const [i] = await interimsOf(s.sub.id);
  check(
    "usage_controls_check raises the interim invoice from the dirty mark (raw read, no fold)",
    i?.subtotalMinor === 600n,
    i?.subtotalMinor,
  );
}

// ── 5b. An interim invoice reads usage to now: no fold grace ───────────────────────────
console.log("5b. interim cuts at now");
{
  const b = await setup("Threshold live");
  const price = await priceOf(b, { unitAmountDecimal: "1" });
  const now = new Date();
  const term = { start: new Date(now.getTime() - 2 * H), end: new Date(now.getTime() + 22 * H) };
  const mark = (customerId: string) =>
    systemDb
      .insert(usageControlDirty)
      .values({ customerId, ...b.ids })
      .onConflictDoNothing();
  const check1 = () =>
    runWithClockScope({ onlyBusinessId: b.biz.id }, () => runUsageControlsCheck());
  const usage = (customerId: string, at: Date, tokens: number, receivedMs: number) =>
    sendEvent(b.ids, {
      customerId,
      eventName: b.meter.eventName,
      at,
      properties: { tokens },
      receivedMs,
    });
  // 450 received 10 minutes ago, 100 received now: 550 crosses 500.
  const s = await subscribe(b, price, term);
  await send(b, s.customer.id, new Date(now.getTime() - H), 450);
  await usage(s.customer.id, new Date(now.getTime() - 60_000), 100, Date.now());
  await mark(s.customer.id);
  await check1();
  const [i1] = await interimsOf(s.sub.id);
  check(
    "the next check raises the interim invoice for all 550, usage received a moment ago included",
    i1?.subtotalMinor === 550n,
    i1?.subtotalMinor,
  );
  // A late event: received after that cut (which reads to now + 1 s), timed before it. The
  // next interim invoice bills it, once.
  await new Promise((r) => setTimeout(r, 1_500));
  await usage(s.customer.id, new Date(now.getTime() - 2 * 60_000), 100, Date.now());
  await usage(s.customer.id, new Date(now.getTime() - 30_000), 500, Date.now());
  await mark(s.customer.id);
  await check1();
  const both = await interimsOf(s.sub.id);
  check(
    "the late 100 is billed once, on the next interim invoice: 550 + 600 = all 1,150",
    both.length === 2 &&
      both[1]!.subtotalMinor === 600n &&
      both.reduce((a, i) => a + Number(i.subtotalMinor), 0) === 1150,
    both.map((i) => i.subtotalMinor),
  );
  // A burst received now from no usage: invoiced on the same check.
  const burst = await subscribe(b, price, term);
  await usage(burst.customer.id, new Date(now.getTime() - 60_000), 600, Date.now());
  await mark(burst.customer.id);
  await check1();
  check(
    "a burst received now is invoiced on the next check",
    (await interimsOf(burst.sub.id))[0]?.subtotalMinor === 600n,
    (await interimsOf(burst.sub.id)).map((i) => i.subtotalMinor),
  );
}

// ── 6. An item removed mid-period settles only what interim invoices did not bill ─────
console.log("6. removal settlement");
{
  const b = await setup("Threshold removal");
  const price = await priceOf(b, { unitAmountDecimal: "1" });
  const now = new Date();
  const s = await subscribe(b, price, {
    start: new Date(now.getTime() - 2 * H),
    end: new Date(now.getTime() + H),
  });
  const flat = await createPrice({
    ...b.ids,
    productId: b.product.id,
    id: `ti-flat-${Date.now()}`,
    type: "recurring",
    model: "flat",
    currency: "USD",
    interval: "month",
    amountMinor: 100,
  });
  await addSubscriptionItem({
    ...b.ids,
    subscriptionId: s.sub.id,
    price: flat,
    quantity: 1,
    invoiceImmediately: false,
    now,
  });
  await send(b, s.customer.id, new Date(now.getTime() - 90 * 60_000), 600);
  await raise(b, s.sub.id, new Date(now.getTime() - 60 * 60_000));
  await send(b, s.customer.id, new Date(now.getTime() - 50 * 60_000), 100);
  const [meterItem] = await systemDb
    .select()
    .from(subscriptionItems)
    .where(
      and(eq(subscriptionItems.subscriptionId, s.sub.id), eq(subscriptionItems.priceId, price.id)),
    );
  await removeSubscriptionItem({
    ...b.ids,
    subscriptionId: s.sub.id,
    itemPublicId: meterItem!.publicId,
    now: new Date(),
  });
  const settled = await systemDb
    .select()
    .from(unbilledCharges)
    .where(
      and(
        eq(unbilledCharges.subscriptionId, s.sub.id),
        eq(unbilledCharges.entityType, "usage_settlement"),
      ),
    );
  check(
    "the removal settles 100: the 600 an interim invoice billed is not billed again",
    (await interimsOf(s.sub.id))[0]?.subtotalMinor === 600n &&
      settled.reduce((a, c) => a + Number(c.amountMinor), 0) === 100,
    settled.map((c) => c.amountMinor),
  );
}

// ── 7. Two interim invoices on a pre-debit notice rail: each is charged after the lead ──
console.log("7. notice rail");
{
  const org = await createOrganization({ name: "Threshold notice rail" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const ids = { organizationId: orgId, businessId: biz.id };
  const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  await startTimeTravel({ orgId, bizId: biz.id, genesisTime: T0 });
  const asOf = async <T>(t: Date, fn: () => Promise<T>): Promise<T> => {
    await systemDb
      .update(timeTravels)
      .set({ simulatedNow: t })
      .where(eq(timeTravels.businessId, biz.id));
    return runWithClockScope({ onlyBusinessId: biz.id, now: t }, fn);
  };
  const acct = await createGatewayAccount({
    ...ids,
    gatewayKey: "tmtest",
    label: "Notice rail",
    credentials: { pre_debit_lead_hours: "24" },
  });
  const product = await createProduct({ ...ids, name: "AI usage" });
  const meter = await createTestMeter(ids, { aggregation: "sum" });
  await putPlanUsageThreshold({
    ...ids,
    productPublicId: product.publicId,
    currency: "INR",
    amountMinor: 50_000n,
  });
  const price = await createPrice({
    ...ids,
    productId: product.id,
    id: `ti-rail-${Date.now()}`,
    type: "recurring",
    model: "usage",
    currency: "INR",
    interval: "month",
    meter: meter.key,
    unitAmountDecimal: "100",
  } as Parameters<typeof createPrice>[0]);
  const customer = await createCustomer({ ...ids, email: `ti-rail-${Date.now()}@example.com` });
  const pm = await vaultPaymentMethod({
    ...ids,
    customer,
    token: "4242424242424242",
    gatewayAccountId: acct.publicId,
  });
  const { subscription: sub } = await asOf(T0, () =>
    createSubscription({
      ...ids,
      customerId: customer.id,
      now: T0,
      items: [{ price, quantity: 1 }],
      defaultPaymentMethodId: pm.id,
    }),
  );
  const h = (n: number) => new Date(T0.getTime() + n * H);
  const usage = (t: Date, tokens: number) =>
    sendEvent(ids, {
      customerId: customer.id,
      eventName: meter.eventName,
      at: t,
      properties: { tokens },
    });
  await usage(h(1), 600);
  await asOf(h(2), () => raiseInterimInvoice({ ...ids, subscriptionId: sub.id, now: h(2) }));
  await asOf(h(2), () => runUsageThresholdInvoices(h(2)));
  await usage(h(3), 700);
  await asOf(h(4), () => raiseInterimInvoice({ ...ids, subscriptionId: sub.id, now: h(4) }));
  await asOf(h(4), () => runUsageThresholdInvoices(h(4)));
  const deferred = await interimsOf(sub.id);
  check(
    "two interim invoices (600 and 700 tokens at ₹1) wait for their notices, nothing charged",
    deferred.length === 2 &&
      deferred[0]!.subtotalMinor === 60_000n &&
      deferred[1]!.subtotalMinor === 70_000n &&
      deferred.every((i) => i.status === "payment_due" && i.nextAttemptAt != null),
    deferred.map((i) => [i.subtotalMinor, i.status, i.nextAttemptAt?.toISOString()]),
  );
  // The retries run every 2 hours for 4 days. Notices that replace each other never mature.
  for (let t = 6; t <= 4 + 96; t += 2)
    await asOf(h(t), async () => {
      await runInvoiceDueTransitions(h(t));
      await runDunningPass(h(t));
    });
  const after = await interimsOf(sub.id);
  const notices = await systemDb
    .select()
    .from(preDebitNotices)
    .where(eq(preDebitNotices.paymentMethodId, pm.id));
  check(
    "both interim invoices are paid after the lead",
    after.every((i) => i.status === "paid"),
    after.map((i) => [i.status, i.attemptCount]),
  );
  check(
    "one notice per interim invoice; neither replaced the other",
    notices.length === 2 && notices.every((n) => n.status !== "superseded"),
    notices.map((n) => [n.status, n.amountMinor]),
  );

  // Time travel runs the on-arrival check: the cron skips a travelled business.
  const c2 = await createCustomer({ ...ids, email: `ti-travel-${Date.now()}@example.com` });
  const { subscription: s2 } = await asOf(h(100), () =>
    createSubscription({ ...ids, customerId: c2.id, now: h(100), items: [{ price, quantity: 1 }] }),
  );
  await sendEvent(ids, {
    customerId: c2.id,
    eventName: meter.eventName,
    at: h(101),
    properties: { tokens: 600 },
  });
  await systemDb
    .insert(usageControlDirty)
    .values({ customerId: c2.id, ...ids })
    .onConflictDoNothing();
  await travelForward({ orgId, bizId: biz.id, toTime: h(124) });
  const travelled = await interimsOf(s2.id);
  check(
    "a time travel step raises the interim invoice from the dirty mark",
    travelled.length === 1 && travelled[0]!.subtotalMinor === 60_000n,
    travelled.map((i) => i.subtotalMinor),
  );
}

await closeDb();
if (fails.length) {
  console.log(`\n❌ THRESHOLD-INVOICING: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("\n✅ THRESHOLD-INVOICING: PASS");
process.exit(0);
