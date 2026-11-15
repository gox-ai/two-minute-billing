/**
 * Customer coupons (0520): a coupon attached to a customer discounts their invoices.
 *  - API: apply, list on the customer, a duplicate refused, remove;
 *  - `customer_coupons` = fallback vs stack, on a renewal with and without a subscription
 *    coupon, and on a one-off invoice with an invoice coupon;
 *  - one-off invoice, purchase preview = create, automatic top-up (cost basis net);
 *  - once / repeating / forever count per discounted invoice; an invoice it did not
 *    discount does not count; a void gives the use back;
 *  - a fixed amount in another currency discounts nothing and spends nothing;
 *  - an item-scoped customer coupon discounts only its items;
 *  - MRR nets forever/repeating customer coupons (fallback: only with no own coupon), and a
 *    PATCH of `customer_coupons` restates it.
 *
 *   pnpm verify:coupons-customer
 */
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  recomputeSubscriptionMrr,
  recurringAmountsForSubs,
} from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, previewInvoiceFromLines } from "@/modules/invoicing/service";
import { createManualInvoice, voidInvoice } from "@/modules/invoicing/ops";
import {
  createCoupon,
  applyCouponToSubscription,
  applyCouponToCustomer,
  removeCustomerDiscount,
  listCustomerDiscounts,
  CouponError,
} from "@/modules/coupons/service";
import { loadActiveDiscounts } from "@/modules/metrics/mrr";
import { startTimeTravel } from "@/modules/time-travel/service";
import { createRunFor, putAutoTopup } from "@/modules/usage-controls/auto-topup";
import {
  appliedCoupons,
  businesses,
  coupons,
  creditGrants,
  customers,
  invoiceLineItems,
  invoices,
  subscriptions,
  timeTravels,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean, detail?: unknown) => {
  checks.push([name, pass]);
  if (!pass && detail !== undefined)
    console.log(
      `    ↳ ${name}: ${JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? String(v) : v))}`,
    );
};

const org = await createOrganization({ name: "Customer Coupon Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };

const plan = await createProduct({ ...ctx, name: "Plan" });
const planPrice = await createPrice({
  ...ctx,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});
const widget = await createProduct({ ...ctx, name: "Widget", kind: "charge" });
const widgetPrice = await createPrice({
  ...ctx,
  productId: widget.id,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
});

const pct = (
  code: string,
  bps: number,
  durationType: "once" | "forever" | "repeating",
  n?: number,
) =>
  createCoupon({
    ...ctx,
    code,
    kind: "percentage",
    percentOffBps: bps,
    durationType,
    ...(n ? { durationInPeriods: n } : {}),
  });
await pct("C10", 1000, "forever");
await pct("SUB5", 500, "forever");
await pct("INV5", 500, "once");
await pct("ONCE20", 2000, "once");
await pct("REP15", 1500, "repeating", 2);
await createCoupon({
  ...ctx,
  code: "EUR5",
  kind: "fixed_amount",
  amountOffMinor: 500,
  currency: "EUR",
  durationType: "once",
});
await createCoupon({
  ...ctx,
  code: "WID20",
  kind: "percentage",
  percentOffBps: 2000,
  durationType: "forever",
  applyOn: "each_specified_item",
  itemConstraints: [
    { itemKind: "charge", constraintType: "specific", productIds: [widget.publicId] },
  ],
});

const setMode = (mode: "fallback" | "stack", bizId = biz.id) =>
  systemDb
    .update(businesses)
    .set({
      billingRulesConfig: sql`coalesce(${businesses.billingRulesConfig}, '{}'::jsonb) || ${JSON.stringify({ customer_coupons: mode })}::jsonb`,
    })
    .where(eq(businesses.id, bizId));

let n = 0;
const mkCustomer = () => createCustomer({ ...ctx, email: `cc${++n}@example.com` });
async function mkSub(customer: typeof customers.$inferSelect) {
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  return (
    await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [{ price: planPrice, quantity: 1 }],
    })
  ).subscription;
}
/** Advance one period and bill it, as the renewal does. */
async function renew(sub: typeof subscriptions.$inferSelect) {
  const fresh = await withTenant(orgId, async (tx) => {
    const [cur] = await tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
    const start = cur!.currentPeriodEnd!;
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const [adv] = await tx
      .update(subscriptions)
      .set({ currentPeriodStart: start, currentPeriodEnd: end })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return adv!;
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  return invoice;
}
const widgetLine = { description: "Widget", amountMinor: 10000n, priceId: widgetPrice.id };
const oneOff = (
  customer: typeof customers.$inferSelect,
  opts: {
    codes?: string[];
    currency?: string;
    lines?: Array<{ description: string; amountMinor: bigint; priceId?: string }>;
    customerCoupons?: boolean;
  } = {},
) =>
  createManualInvoice({
    ...ctx,
    customerId: customer.id,
    currency: opts.currency ?? "USD",
    lines: opts.lines ?? [widgetLine],
    ...(opts.codes ? { coupons: { codes: opts.codes } } : {}),
    ...(opts.customerCoupons === false ? { customerCoupons: false } : {}),
  }).then((r) => r.invoice);
const applyTo = (customer: typeof customers.$inferSelect, code: string) =>
  applyCouponToCustomer({ ...ctx, customerId: customer.id, code });
const custRow = async (customerId: string, code: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select({ ac: appliedCoupons })
        .from(appliedCoupons)
        .innerJoin(coupons, eq(coupons.id, appliedCoupons.couponId))
        .where(
          and(
            eq(appliedCoupons.customerId, customerId),
            eq(appliedCoupons.scope, "customer"),
            eq(coupons.code, code),
          ),
        ),
    )
  )[0]?.ac;
const mrrOf = async (subId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select({ mrr: subscriptions.mrr }).from(subscriptions).where(eq(subscriptions.id, subId)),
    )
  )[0]!.mrr;
async function refusal(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof CouponError ? e.message : `not a CouponError: ${String(e)}`;
  }
}

// ── 1. API: apply, list, duplicate, remove ───────────────────────────────────────────
console.log("1. API");
const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${org.secret}` };
const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { ...auth, "idempotency-key": crypto.randomUUID() },
    ...(payload ? { payload } : {}),
  });
const apiCus = await mkCustomer();
{
  const base = `/v1/businesses/${biz.publicId}/customers/${apiCus.publicId}`;
  const r1 = await call("POST", `${base}/discounts`, { coupon: "C10" });
  const d = JSON.parse(r1.body);
  ok(
    "POST discounts → 201 customer_discount",
    r1.statusCode === 201 &&
      d.object === "customer_discount" &&
      d.coupon === "C10" &&
      d.remaining_invoices === null,
    d,
  );
  const r2 = await call("POST", `${base}/discounts`, { coupon: "C10" });
  ok(
    "the same coupon twice → 400",
    r2.statusCode === 400 && /already applied to this customer/.test(r2.body),
    r2.body,
  );
  const r3 = await call("POST", `${base}/discounts`, { coupon: "NOPE" });
  ok("an unknown coupon → 400", r3.statusCode === 400, r3.body);
  const g = JSON.parse((await call("GET", base)).body);
  ok(
    "GET customer lists discounts",
    Array.isArray(g.discounts) && g.discounts.length === 1 && g.discounts[0].id === d.id,
    g.discounts,
  );
  const r4 = await call("DELETE", `${base}/discounts/${d.id}`);
  ok(
    "DELETE discount → removed",
    r4.statusCode === 200 && JSON.parse(r4.body).removed === true,
    r4.body,
  );
  const r5 = await call("DELETE", `${base}/discounts/${d.id}`);
  ok("DELETE again → 404", r5.statusCode === 404, r5.body);
  const g2 = JSON.parse((await call("GET", base)).body);
  ok("GET after remove lists none", g2.discounts?.length === 0, g2.discounts);
  const r6 = await call("POST", `${base}/discounts`, { coupon: "C10" });
  ok("re-apply after remove is allowed", r6.statusCode === 201, r6.body);
}
await app.close();

// ── 2. Fallback vs stack on a renewal ────────────────────────────────────────────────
console.log("2. renewals");
const cusA = await mkCustomer();
const subA = await mkSub(cusA);
await applyTo(cusA, "C10");
ok(
  "duplicate apply is refused (service)",
  /already applied/.test((await refusal(applyTo(cusA, "C10"))) ?? ""),
);
{
  const inv = await renew(subA);
  ok(
    "fallback, no subscription coupon: renewal 10000 → 9000",
    inv.totalMinor === 9000n,
    inv.totalMinor,
  );
}
const cusB = await mkCustomer();
const subB = await mkSub(cusB);
await applyCouponToSubscription({ ...ctx, subscriptionId: subB.id, code: "SUB5", now: new Date() });
await applyTo(cusB, "C10");
{
  const inv = await renew(subB);
  ok(
    "fallback, with a subscription coupon: only it applies → 9500",
    inv.totalMinor === 9500n,
    inv.totalMinor,
  );
  await setMode("stack");
  const inv2 = await renew(subB);
  ok("stack: 5% then 10% → 8550", inv2.totalMinor === 8550n, inv2.totalMinor);
  await setMode("fallback");
}

// ── 3. MRR ───────────────────────────────────────────────────────────────────────────
console.log("3. MRR");
ok(
  "MRR nets a forever customer coupon (no own coupon) → 9000",
  (await mrrOf(subA.id)) === 9000n,
  await mrrOf(subA.id),
);
ok(
  "fallback: own coupon wins in MRR → 9500",
  (await mrrOf(subB.id)) === 9500n,
  await mrrOf(subB.id),
);
await setMode("stack");
await withTenant(orgId, (tx) => recomputeSubscriptionMrr(tx, subB.id));
ok("stack: MRR nets both → 8550", (await mrrOf(subB.id)) === 8550n, await mrrOf(subB.id));
{
  const rec = await withTenant(orgId, (tx) => recurringAmountsForSubs(tx, [subA, subB]));
  ok("recurring amount agrees with MRR", rec.get(subA.id) === 9000n && rec.get(subB.id) === 8550n, [
    ...rec,
  ]);
  const loaded = await withTenant(orgId, (tx) => loadActiveDiscounts(tx, biz.id));
  ok(
    "loadActiveDiscounts merges the customer coupon",
    loaded.get(subA.id)?.length === 1 && loaded.get(subB.id)?.length === 2,
    [loaded.get(subA.id)?.length, loaded.get(subB.id)?.length],
  );
}
await setMode("fallback");
await withTenant(orgId, (tx) => recomputeSubscriptionMrr(tx, subB.id));
{
  // Changing the rule through the API restates the MRR of the customers it affects.
  const app2 = await buildApp({ logger: false });
  const patch = (mode: "fallback" | "stack") =>
    app2.inject({
      method: "PATCH",
      url: `/v1/businesses/${biz.publicId}`,
      headers: { ...auth, "idempotency-key": crypto.randomUUID() },
      payload: { billing_rules_config: { customer_coupons: mode } },
    });
  const r1 = await patch("stack");
  ok(
    "PATCH customer_coupons → stack restates MRR → 8550",
    r1.statusCode === 200 && (await mrrOf(subB.id)) === 8550n,
    [r1.statusCode, await mrrOf(subB.id)],
  );
  const r2 = await patch("fallback");
  ok(
    "PATCH customer_coupons → fallback restates MRR → 9500",
    r2.statusCode === 200 && (await mrrOf(subB.id)) === 9500n,
    [r2.statusCode, await mrrOf(subB.id)],
  );
  ok(
    "subscription with no own coupon is unchanged → 9000",
    (await mrrOf(subA.id)) === 9000n,
    await mrrOf(subA.id),
  );
  await app2.close();
}
{
  const sub2 = await mkSub(cusA);
  ok(
    "a new subscription nets the customer's coupon at creation",
    (await mrrOf(sub2.id)) === 9000n,
    await mrrOf(sub2.id),
  );
  const cusOnce = await mkCustomer();
  const subOnce = await mkSub(cusOnce);
  await applyTo(cusOnce, "ONCE20");
  ok(
    "a once customer coupon does not net",
    (await mrrOf(subOnce.id)) === 10000n,
    await mrrOf(subOnce.id),
  );
  const cusRep = await mkCustomer();
  const subRep = await mkSub(cusRep);
  await applyTo(cusRep, "REP15");
  ok(
    "a repeating customer coupon nets → 8500",
    (await mrrOf(subRep.id)) === 8500n,
    await mrrOf(subRep.id),
  );
}

// ── 4. One-off invoices and purchases ────────────────────────────────────────────────
console.log("4. one-off invoices");
{
  const pre = await previewInvoiceFromLines({
    ...ctx,
    customerId: cusA.id,
    currency: "USD",
    lines: [widgetLine],
  });
  const inv = await oneOff(cusA);
  ok("one-off invoice takes the customer coupon → 9000", inv.totalMinor === 9000n, inv.totalMinor);
  ok(
    "purchase preview equals the invoice",
    pre.totalMinor === inv.totalMinor &&
      pre.amountDueMinor === inv.amountDueMinor &&
      pre.discountMinor === 1000n,
    [pre.totalMinor, pre.amountDueMinor, inv.totalMinor],
  );
  const lines = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoiceLineItems)
      .where(and(eq(invoiceLineItems.invoiceId, inv.id), eq(invoiceLineItems.kind, "discount"))),
  );
  ok(
    "a discount line names the customer coupon",
    lines.length === 1 && lines[0]!.amountMinor === -1000n && /C10/.test(lines[0]!.description),
    lines.map((l) => l.description),
  );
  const opted = await oneOff(cusA, { customerCoupons: false });
  ok("customerCoupons: false stays list-priced", opted.totalMinor === 10000n, opted.totalMinor);
  const withCode = await oneOff(cusA, { codes: ["INV5"] });
  ok("fallback: an invoice coupon wins → 9500", withCode.totalMinor === 9500n, withCode.totalMinor);
  await setMode("stack");
  const stacked = await oneOff(cusA, { codes: ["INV5"] });
  ok("stack: 10% then 5% → 8550", stacked.totalMinor === 8550n, stacked.totalMinor);
  await setMode("fallback");
}

// ── 5. Counting per discounted invoice, void restores ────────────────────────────────
console.log("5. duration counting");
{
  const cusC = await mkCustomer();
  await applyTo(cusC, "ONCE20");
  const i1 = await oneOff(cusC);
  const i2 = await oneOff(cusC);
  const row = await custRow(cusC.id, "ONCE20");
  ok(
    "once: the next invoice only (8000, then 10000)",
    i1.totalMinor === 8000n && i2.totalMinor === 10000n,
    [i1.totalMinor, i2.totalMinor],
  );
  ok(
    "once: exhausted after one invoice",
    row?.status === "exhausted" && row.remainingPeriods === 0,
    row,
  );

  const cusD = await mkCustomer();
  await applyTo(cusD, "REP15");
  const d1 = await oneOff(cusD);
  const blocked = await oneOff(cusD, { codes: ["INV5"] });
  const afterBlocked = await custRow(cusD.id, "REP15");
  ok(
    "repeating: an invoice it did not discount does not count",
    d1.totalMinor === 8500n && blocked.totalMinor === 9500n && afterBlocked?.remainingPeriods === 1,
    [d1.totalMinor, blocked.totalMinor, afterBlocked?.remainingPeriods],
  );
  const d2 = await oneOff(cusD);
  ok(
    "repeating: second discounted invoice → 8500, exhausted",
    d2.totalMinor === 8500n && (await custRow(cusD.id, "REP15"))?.status === "exhausted",
    d2.totalMinor,
  );
  await voidInvoice(orgId, biz.id, d2.publicId);
  const restored = await custRow(cusD.id, "REP15");
  ok(
    "void gives the use back (active, 1 left)",
    restored?.status === "active" && restored.remainingPeriods === 1,
    restored,
  );
  const d3 = await oneOff(cusD);
  const d4 = await oneOff(cusD);
  ok(
    "repeating: after the void, one more discounted invoice, then full price",
    d3.totalMinor === 8500n && d4.totalMinor === 10000n,
    [d3.totalMinor, d4.totalMinor],
  );

  // Renewal counts the same way.
  const cusR = await mkCustomer();
  const subR = await mkSub(cusR);
  await applyTo(cusR, "ONCE20");
  const r1 = await renew(subR);
  const r2 = await renew(subR);
  ok("once on renewals: 8000 then 10000", r1.totalMinor === 8000n && r2.totalMinor === 10000n, [
    r1.totalMinor,
    r2.totalMinor,
  ]);

  // Forever keeps discounting.
  const f = [await oneOff(cusA), await oneOff(cusA)];
  ok(
    "forever: every invoice",
    f.every((i) => i.totalMinor === 9000n),
    f.map((i) => i.totalMinor),
  );
}

// ── 6. Currency mismatch and item scope ──────────────────────────────────────────────
console.log("6. currency and item scope");
{
  const cusE = await mkCustomer();
  await applyTo(cusE, "EUR5");
  const usd = await oneOff(cusE);
  const after = await custRow(cusE.id, "EUR5");
  ok(
    "a EUR fixed coupon does not discount a USD invoice",
    usd.totalMinor === 10000n,
    usd.totalMinor,
  );
  ok(
    "…and does not spend a use",
    after?.status === "active" && after.remainingPeriods === 1,
    after,
  );
  const eur = await oneOff(cusE, {
    currency: "EUR",
    lines: [{ description: "Service", amountMinor: 10000n }],
  });
  ok(
    "it discounts a EUR invoice → 9500 and is spent",
    eur.totalMinor === 9500n && (await custRow(cusE.id, "EUR5"))?.status === "exhausted",
    eur.totalMinor,
  );

  const cusF = await mkCustomer();
  await applyTo(cusF, "WID20");
  const mixed = await oneOff(cusF, {
    lines: [widgetLine, { description: "Setup", amountMinor: 5000n }],
  });
  ok(
    "item-scoped: only the widget line is discounted → 13000",
    mixed.totalMinor === 13000n,
    mixed.totalMinor,
  );
}

// ── 7. Automatic top-up ──────────────────────────────────────────────────────────────
console.log("7. automatic top-up");
{
  const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const tb = await createBusiness({
    organizationId: orgId,
    name: "Top-up",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await startTimeTravel({ orgId, bizId: tb.id, genesisTime: T0 });
  await systemDb
    .update(businesses)
    .set({ creditConfig: { top_up_limits: { USD: { min_minor: 300 } } } })
    .where(eq(businesses.id, tb.id));
  await createCoupon({
    organizationId: orgId,
    businessId: tb.id,
    code: "TOP10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: tb.id,
    email: `topup${Date.now()}@example.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: tb.id,
    customer,
    token: "4242424242424242",
  });
  await applyCouponToCustomer({
    organizationId: orgId,
    businessId: tb.id,
    customerId: customer.id,
    code: "TOP10",
  });
  const at = async <T>(fn: () => Promise<T>) => {
    await systemDb
      .update(timeTravels)
      .set({ simulatedNow: T0 })
      .where(eq(timeTravels.businessId, tb.id));
    return runWithClockScope({ onlyBusinessId: tb.id, now: T0 }, fn);
  };
  const { config } = await at(() =>
    putAutoTopup({
      organizationId: orgId,
      businessId: tb.id,
      customerPublicId: customer.publicId,
      config: {
        trigger: "threshold",
        thresholdMinor: 1_000n,
        method: "fixed",
        amountMinor: 500n,
        monthlyCapMinor: 1_000_000n,
        maxRunsPerDay: 10,
        currency: "USD",
        grant: { tax_treatment: "taxed_at_purchase" },
      },
    }),
  );
  const outcome = await at(() => createRunFor(config, T0));
  const [inv] = await systemDb
    .select()
    .from(invoices)
    .where(and(eq(invoices.customerId, customer.id), eq(invoices.purpose, "credit_purchase")));
  const [grant] = inv
    ? await systemDb.select().from(creditGrants).where(eq(creditGrants.invoiceId, inv.id))
    : [];
  ok(
    "top-up invoice takes the customer coupon (1500 → 1350)",
    outcome === "created" && inv?.totalMinor === 1350n,
    [outcome, inv?.totalMinor],
  );
  ok(
    "top-up grant: full credit, cost basis net of the discount",
    grant?.amount === 1500n && grant.costBasisMinor === 1350n,
    grant && [grant.amount, grant.costBasisMinor],
  );
}

// ── 8. Remove ────────────────────────────────────────────────────────────────────────
console.log("8. remove");
{
  const [d] = await withTenant(orgId, (tx) => listCustomerDiscounts(tx, cusA.id));
  const removed = await removeCustomerDiscount({ ...ctx, customerId: cusA.id, discountId: d!.id });
  const again = await removeCustomerDiscount({ ...ctx, customerId: cusA.id, discountId: d!.id });
  ok("remove returns true, then false", removed && !again);
  const inv = await oneOff(cusA);
  ok("after remove: list price", inv.totalMinor === 10000n, inv.totalMinor);
  ok("after remove: MRR back to 10000", (await mrrOf(subA.id)) === 10000n, await mrrOf(subA.id));
}

const allBalanced = await (async () => {
  const rows = (await systemDb.execute(
    sql`select transaction_id from ledger_entries where organization_id = ${orgId}
         group by transaction_id, currency
        having sum(case when direction='debit' then amount_minor else -amount_minor end) <> 0
         limit 5`,
  )) as unknown as unknown[];
  return rows.length === 0;
})();
ok("all ledger transactions balanced", allBalanced);

let pass = true;
for (const [name, good] of checks) {
  console.log(`  ${good ? "✓" : "✗"} ${name}`);
  if (!good) pass = false;
}
console.log("");
console.log(pass ? "✅ COUPONS-CUSTOMER: PASS" : "❌ COUPONS-CUSTOMER: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
