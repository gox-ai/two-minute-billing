/**
 * `mid_term_coupons`: a subscription's coupons on its mid-term invoices.
 *  - skip: only a plan change is discounted (as before the rule);
 *  - unbilled_and_edits: unbilled-charge invoices and edits (term change, plan change);
 *  - all: also item adds, activation, attached-item and ad-hoc charges;
 *  - estimates (change with adds, unbilled invoice_now, cancel's unbilled invoice) equal
 *    the invoices;
 *  - a fixed amount shares its period allowance with the renewal; a `once` coupon spent by
 *    the renewal gives nothing more; a repeating coupon keeps its periods; MRR is unchanged;
 *  - plan_change_coupons=drop is respected; an item-scoped coupon matches no charge line;
 *  - a deferred period booked net of the coupon is not discounted again by the renewal.
 *
 *   pnpm verify:coupons-midterm
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, setItemApplicablePlans } from "@/modules/catalog/service";
import {
  createSubscription,
  changeTermEnd,
  deferFirstPeriodToUnbilledCharges,
} from "@/modules/subscriptions/service";
import {
  addSubscriptionItem,
  addAdHocCharges,
  fireActivationCharges,
  triggerAttachedItemCharge,
  invoiceUnbilledCharges,
  invoiceUnbilledChargesNow,
  estimateInvoiceUnbilledChargesNow,
} from "@/modules/subscriptions/items";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { estimateChange, estimateCancel } from "@/modules/subscriptions/estimate";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import {
  appliedCoupons,
  businesses,
  invoiceLineItems,
  invoices,
  subscriptionItems,
  subscriptions,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean, detail?: unknown) => {
  checks.push([name, pass]);
  if (!pass && detail !== undefined)
    console.log(
      `    ↳ ${name}: ${JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? String(v) : v))}`,
    );
};

const org = await createOrganization({ name: "Mid-term Coupons Org" });
const orgId = org.organization.id;
type Rule = "skip" | "unbilled_and_edits" | "all";
const DAY = 86_400_000;

async function freshBiz(rule: Rule | null) {
  const biz = await createBusiness({
    organizationId: orgId,
    name: `Mid-term ${rule ?? "unset"}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  if (rule)
    await withTenant(orgId, (tx) =>
      tx
        .update(businesses)
        .set({ billingRulesConfig: { mid_term_coupons: rule } })
        .where(eq(businesses.id, biz.id)),
    );
  const ctx = { organizationId: orgId, businessId: biz.id };
  const product = (id: string, kind: "plan" | "addon" | "charge") =>
    createProduct({ ...ctx, name: id, id, kind });
  const recurring = async (id: string, kind: "plan" | "addon", amountMinor: number) =>
    createPrice({
      ...ctx,
      productId: (await product(id, kind)).id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const oneTime = async (id: string, amountMinor: number) =>
    createPrice({
      ...ctx,
      productId: (await product(id, "charge")).id,
      type: "one_time",
      model: "flat",
      currency: "USD",
      amountMinor,
    });
  const basic = await recurring("basic", "plan", 10000);
  const pro = await recurring("pro", "plan", 20000);
  const seats = await recurring("seats", "addon", 2000);
  const setup = await oneTime("setup", 5000);
  await oneTime("onboard", 3000);
  await oneTime("kickoff", 4000);
  await setItemApplicablePlans({
    ...ctx,
    itemPublicId: "onboard",
    planPublicIds: ["basic"],
    applicability: { basic: "optional" },
    config: { basic: { chargeOnEvent: "on_demand" } },
  });
  await setItemApplicablePlans({
    ...ctx,
    itemPublicId: "kickoff",
    planPublicIds: ["basic"],
    applicability: { basic: "optional" },
    config: { basic: { chargeOnEvent: "activation" } },
  });
  return { biz, ctx, basic, pro, seats, setup };
}
type Biz = Awaited<ReturnType<typeof freshBiz>>;

let n = 0;
const loadSub = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );

/** A subscription five days into a period whose renewal invoice took the coupons. */
async function subWith(b: Biz, codes: string[]) {
  const customer = await createCustomer({ ...b.ctx, email: `payer${++n}@example.com` });
  await vaultPaymentMethod({ ...b.ctx, customer, token: "tok_4242" });
  const now = new Date();
  const { subscription } = await createSubscription({
    ...b.ctx,
    customerId: customer.id,
    now,
    startDate: new Date(now.getTime() - 5 * DAY),
    items: [{ price: b.basic, quantity: 1 }],
  });
  for (const code of codes)
    await applyCouponToSubscription({ ...b.ctx, subscriptionId: subscription.id, code, now });
  const sub = await loadSub(subscription.id);
  const { invoice } = await billSubscriptionPeriod({
    ...b.ctx,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  return { sub: await loadSub(sub.id), renewal: invoice };
}

/** The next renewal, as the clock runs it: advance the period, then bill it. */
async function renew(b: Biz, subId: string) {
  const fresh = await withTenant(orgId, async (tx) => {
    const [cur] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subId));
    const start = cur!.currentPeriodEnd!;
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const [row] = await tx
      .update(subscriptions)
      .set({ currentPeriodStart: start, currentPeriodEnd: end })
      .where(eq(subscriptions.id, subId))
      .returning();
    return row!;
  });
  return (
    await billSubscriptionPeriod({
      ...b.ctx,
      subscription: fresh,
      periodStart: fresh.currentPeriodStart!,
      periodEnd: fresh.currentPeriodEnd!,
    })
  ).invoice;
}

/** Gross of the charge lines and the discount taken off them (both stages). */
async function priced(invoiceId: string) {
  const lines = await withTenant(orgId, (tx) =>
    tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)),
  );
  const [inv] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, invoiceId)),
  );
  const charges = lines.filter((l) => l.kind !== "discount" && l.kind !== "tax");
  const gross = charges.reduce((s, l) => s + l.amountMinor, 0n);
  const documentLevel = -lines
    .filter((l) => l.kind === "discount")
    .reduce((s, l) => s + l.amountMinor, 0n);
  const itemLevel = gross - inv!.subtotalMinor;
  return { gross, discount: itemLevel + documentLevel, total: inv!.totalMinor };
}
const byPublicId = async (publicId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.publicId, publicId)),
    )
  )[0]!;
/** 10% of a line, rounded either way: the stack rounds per stage. */
const isTenPct = (gross: bigint, discount: bigint) =>
  discount === gross / 10n || discount === (gross + 5n) / 10n;
/** The subscription's one applied coupon. */
const appliedRow = async (subId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(appliedCoupons).where(eq(appliedCoupons.subscriptionId, subId)),
    )
  )[0]!;

// ── Every path under every rule ───────────────────────────────────────────────
const discountedUnder: Record<string, Rule[]> = {
  activation: ["all"],
  attached: ["all"],
  adhoc: ["all"],
  add_item: ["all"],
  unbilled: ["unbilled_and_edits", "all"],
  unbilled_now: ["unbilled_and_edits", "all"],
  term_change: ["unbilled_and_edits", "all"],
  plan_change: ["skip", "unbilled_and_edits", "all"],
};
for (const rule of [null, "skip", "unbilled_and_edits", "all"] as const) {
  const b = await freshBiz(rule);
  const label = rule ?? "unset";
  const effective: Rule = rule ?? "skip";
  await createCoupon({
    ...b.ctx,
    code: "PCT10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  const { sub, renewal } = await subWith(b, ["PCT10"]);
  ok(`${label}: the renewal takes 10%`, renewal.totalMinor === 9000n, renewal.totalMinor);
  const mrrBefore = sub.mrr;
  const invoiceIds: Record<string, string> = {};
  const now = new Date();

  await fireActivationCharges({ ...b.ctx, subscriptionId: sub.id, now });
  const kickoff = await withTenant(orgId, (tx) =>
    tx
      .select({ id: invoices.id })
      .from(invoices)
      .innerJoin(invoiceLineItems, eq(invoiceLineItems.invoiceId, invoices.id))
      .where(eq(invoices.subscriptionId, sub.id)),
  );
  invoiceIds.activation = kickoff.find((r) => r.id !== renewal.id)?.id ?? "";

  invoiceIds.attached = (
    await triggerAttachedItemCharge({
      ...b.ctx,
      subscriptionId: sub.id,
      itemPublicId: "onboard",
      now,
    })
  ).invoice.id;

  const adhoc = await addAdHocCharges({
    ...b.ctx,
    subscriptionId: sub.id,
    invoiceNow: true,
    now,
    lines: [{ description: "Setup", amountMinor: 5000, priceId: b.setup.id }],
  });
  invoiceIds.adhoc = adhoc.object === "invoice" ? adhoc.invoice.id : "";

  const queue = () =>
    addAdHocCharges({
      ...b.ctx,
      subscriptionId: sub.id,
      invoiceNow: false,
      now,
      lines: [{ description: "Extra work", amountMinor: 4000 }],
    });
  await queue();
  const cancelEst = await estimateCancel({
    ...b.ctx,
    subscriptionId: sub.id,
    now,
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "none",
    unbilledChargesOption: "invoice",
  });
  const unbilledInv = await invoiceUnbilledCharges({ ...b.ctx, subscriptionId: sub.id, now });
  invoiceIds.unbilled = unbilledInv?.id ?? "";
  ok(
    `${label}: cancel estimate prices the unbilled invoice as raised`,
    BigInt(cancelEst.unbilled_charges.total_minor) === unbilledInv?.totalMinor,
    { est: cancelEst.unbilled_charges.total_minor, inv: unbilledInv?.totalMinor },
  );

  await queue();
  const [est] = await estimateInvoiceUnbilledChargesNow({
    ...b.ctx,
    scope: { subscriptionId: sub.id },
  });
  const [raised] = await invoiceUnbilledChargesNow({ ...b.ctx, scope: { subscriptionId: sub.id } });
  invoiceIds.unbilled_now = raised?.invoice.id ?? "";
  ok(
    `${label}: invoice_now estimate equals the invoice`,
    est?.preview.totalMinor === raised?.invoice.totalMinor &&
      est?.preview.amountDueMinor === raised?.invoice.amountDueMinor,
    { est: est?.preview.totalMinor, inv: raised?.invoice.totalMinor },
  );

  const mrrAfter = (await loadSub(sub.id)).mrr;
  ok(`${label}: mid-term invoices leave MRR alone`, mrrAfter === mrrBefore, {
    mrrBefore,
    mrrAfter,
  });

  const addNow = new Date();
  const addEst = await estimateChange({
    ...b.ctx,
    subscriptionId: sub.id,
    now: addNow,
    changes: [],
    adds: [{ priceId: b.seats.publicId, quantity: 1 }],
  });
  const added = await addSubscriptionItem({
    ...b.ctx,
    subscriptionId: sub.id,
    price: b.seats,
    quantity: 1,
    invoiceImmediately: true,
    now: addNow,
  });
  invoiceIds.add_item = added.invoice?.id ?? "";
  ok(
    `${label}: change estimate with an add equals the add's invoice`,
    BigInt(addEst.total_minor) === added.invoice?.totalMinor,
    { est: addEst.total_minor, inv: added.invoice?.totalMinor },
  );

  const fresh = await loadSub(sub.id);
  const term = await changeTermEnd({
    ...b.ctx,
    subscriptionId: fresh.id,
    termEndsAt: new Date(fresh.currentPeriodEnd!.getTime() + 5 * DAY),
    prorate: true,
    invoiceImmediately: true,
    now: new Date(),
    originToken: `term-change-${label}`,
  });
  invoiceIds.term_change = term.prorationInvoice
    ? (await byPublicId(term.prorationInvoice)).id
    : "";

  const basicItem = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id)),
    )
  ).find((i) => i.priceId === b.basic.id)!;
  const change = await changeSubscription({
    ...b.ctx,
    subscriptionId: sub.id,
    now: new Date(),
    changes: [{ itemId: basicItem.publicId, newPriceId: b.pro.publicId }],
    invoiceImmediately: true,
  });
  invoiceIds.plan_change = change.prorationInvoice?.id ?? "";

  for (const [path, rules] of Object.entries(discountedUnder)) {
    const id = invoiceIds[path];
    if (!id) {
      ok(`${label}: ${path} raised an invoice`, false, invoiceIds);
      continue;
    }
    const p = await priced(id);
    const want = rules.includes(effective);
    ok(
      `${label}: ${path} ${want ? "takes 10%" : "is list price"}`,
      want ? p.discount > 0n && isTenPct(p.gross, p.discount) : p.discount === 0n,
      p,
    );
  }
}

// ── A fixed amount shares the period's allowance with the renewal ──────────────
{
  const b = await freshBiz("all");
  await createCoupon({
    ...b.ctx,
    code: "FIX120",
    kind: "fixed_amount",
    amountOffMinor: 12000,
    currency: "USD",
    durationType: "forever",
  });
  const { sub, renewal } = await subWith(b, ["FIX120"]);
  const charge = async () => {
    const r = await addAdHocCharges({
      ...b.ctx,
      subscriptionId: sub.id,
      invoiceNow: true,
      now: new Date(),
      lines: [{ description: "Setup", amountMinor: 5000, priceId: b.setup.id }],
    });
    return r.object === "invoice" ? r.invoice.totalMinor : -1n;
  };
  const first = await charge();
  const second = await charge();
  const row = await appliedRow(sub.id);
  ok("fixed: the renewal takes 10000 of 12000", renewal.totalMinor === 0n, renewal.totalMinor);
  ok("fixed: a mid-term charge takes the 2000 left", first === 3000n, first);
  ok("fixed: the next one gets nothing", second === 5000n, second);
  ok("fixed: the period used 12000", row.periodUsedMinor === 12000n, row.periodUsedMinor);
  const next = await renew(b, sub.id);
  ok("fixed: the next period has the full amount again", next.totalMinor === 0n, next.totalMinor);
}

// ── `once` and `repeating` ─────────────────────────────────────────────────────
{
  const b = await freshBiz("all");
  await createCoupon({
    ...b.ctx,
    code: "ONCE10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "once",
  });
  await createCoupon({
    ...b.ctx,
    code: "REP10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "repeating",
    durationInPeriods: 3,
  });
  const adhoc = async (subId: string) => {
    const r = await addAdHocCharges({
      ...b.ctx,
      subscriptionId: subId,
      invoiceNow: true,
      now: new Date(),
      lines: [{ description: "Setup", amountMinor: 5000, priceId: b.setup.id }],
    });
    return r.object === "invoice" ? r.invoice.totalMinor : -1n;
  };

  const once = await subWith(b, ["ONCE10"]);
  ok("once: the renewal takes it", once.renewal.totalMinor === 9000n, once.renewal.totalMinor);
  const onceMid = await adhoc(once.sub.id);
  ok("once: spent by the renewal, so a mid-term charge is list price", onceMid === 5000n, onceMid);

  const rep = await subWith(b, ["REP10"]);
  const before = (await appliedRow(rep.sub.id)).remainingPeriods;
  const m1 = await adhoc(rep.sub.id);
  const m2 = await adhoc(rep.sub.id);
  const after = (await appliedRow(rep.sub.id)).remainingPeriods;
  ok("repeating: mid-term charges take 10%", m1 === 4500n && m2 === 4500n, { m1, m2 });
  ok("repeating: they spend no period", before === 2 && after === 2, { before, after });
  const r2 = await renew(b, rep.sub.id);
  const r3 = await renew(b, rep.sub.id);
  const r4 = await renew(b, rep.sub.id);
  ok(
    "repeating: exactly 3 periods are discounted",
    r2.totalMinor === 9000n && r3.totalMinor === 9000n && r4.totalMinor === 10000n,
    [r2.totalMinor, r3.totalMinor, r4.totalMinor],
  );
}

// ── plan_change_coupons=drop and an item-scoped coupon ─────────────────────────
{
  const b = await freshBiz("all");
  await createCoupon({
    ...b.ctx,
    code: "PCT10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  const { sub } = await subWith(b, ["PCT10"]);
  const [item] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id)),
  );
  const change = await changeSubscription({
    ...b.ctx,
    subscriptionId: sub.id,
    now: new Date(),
    changes: [{ itemId: item!.publicId, newPriceId: b.pro.publicId }],
    invoiceImmediately: true,
    planChangeCoupons: "drop",
  });
  const p = change.prorationInvoice ? await priced(change.prorationInvoice.id) : null;
  ok("drop: the change invoice is list price", p?.discount === 0n && (p?.gross ?? 0n) > 0n, p);
  const r = await addAdHocCharges({
    ...b.ctx,
    subscriptionId: sub.id,
    invoiceNow: true,
    now: new Date(),
    lines: [{ description: "Setup", amountMinor: 5000, priceId: b.setup.id }],
  });
  ok(
    "drop: the dropped coupon discounts no later charge",
    r.object === "invoice" && r.invoice.totalMinor === 5000n,
  );
}
{
  const b = await freshBiz("all");
  await createCoupon({
    ...b.ctx,
    code: "PLANONLY",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "plan", constraintType: "all" }],
  });
  const { sub, renewal } = await subWith(b, ["PLANONLY"]);
  ok("item-scoped: the plan renewal takes it", renewal.totalMinor === 9000n, renewal.totalMinor);
  const r = await addAdHocCharges({
    ...b.ctx,
    subscriptionId: sub.id,
    invoiceNow: true,
    now: new Date(),
    lines: [{ description: "Setup", amountMinor: 5000, priceId: b.setup.id }],
  });
  ok(
    "item-scoped: a charge line does not match, so no discount",
    r.object === "invoice" && r.invoice.totalMinor === 5000n,
  );
  const added = await addSubscriptionItem({
    ...b.ctx,
    subscriptionId: sub.id,
    price: b.seats,
    quantity: 1,
    invoiceImmediately: true,
    now: new Date(),
  });
  ok(
    "item-scoped: an add-on line does not match either",
    added.invoice != null && (await priced(added.invoice.id)).discount === 0n,
  );
}

// A deferred period booked net of the coupon is discounted once, under every rule.
for (const rule of ["skip", "unbilled_and_edits", "all"] as const) {
  const b = await freshBiz(rule);
  await createCoupon({
    ...b.ctx,
    code: "PCT10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  const { sub } = await subWith(b, ["PCT10"]);
  const deferred = await deferFirstPeriodToUnbilledCharges({
    ...b.ctx,
    subscription: sub,
    now: new Date(),
  });
  const inv = await renew(b, sub.id);
  const p = await priced(inv.id);
  ok(
    `${rule}: a deferred period plus the renewal is 9000 + 9000, the coupon taken once each`,
    inv.totalMinor === 18000n && p.discount === (rule === "skip" ? 1000n : 2000n),
    { deferred: deferred.amountMinor, gross: p.gross, discount: p.discount, total: p.total },
  );
}

let pass = true;
for (const [name, good] of checks) {
  console.log(`  ${good ? "✓" : "✗"} ${name}`);
  if (!good) pass = false;
}
console.log("");
console.log(pass ? "✅ COUPONS-MIDTERM: PASS" : "❌ COUPONS-MIDTERM: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
