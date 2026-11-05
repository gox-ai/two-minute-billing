/**
 * SaaS metrics verification — builds a known book of subscriptions and asserts
 * exact MRR/ARR/ARPU, subscriber counts, multi-currency separation, and 30-day
 * churn movement. Then the Business Home analytics payload off the same book:
 * bucket shapes, currency scoping, the voluntary/involuntary churn split, and
 * the invariants that tie the series back to the KPIs.
 *
 *   pnpm verify:metrics
 */
import { eq } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer, listCustomersPage } from "@/modules/customers/service";
import type { ListFilter } from "@/platform/list-query";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscription,
  listSubscriptionsPage,
} from "@/modules/subscriptions/service";
import { computeBusinessMetrics } from "@/modules/metrics/service";
import { computeBusinessAnalytics, type AnalyticsRange } from "@/modules/metrics/analytics";
import { publicId } from "@/platform/ids";
import { customers, subscriptions, transactions } from "@db/schema";

const org = await createOrganization({ name: "Metrics Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plans" });

// Prices: $50/mo (USD), $1200/yr (USD, = $100/mo), €30/mo (EUR), usage (excluded).
const usdMonthly = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});
const usdAnnual = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 120000,
  interval: "year",
});
const eurMonthly = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "EUR",
  amountMinor: 3000,
  interval: "month",
});
const usagePrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "usage",
  currency: "USD",
  amountMinor: 5,
  interval: "month",
  usageAggregation: "sum",
});

async function sub(price: typeof usdMonthly, extraUsage = false) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `m${Math.random()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const items = extraUsage
    ? [
        { price, quantity: 1 },
        { price: usagePrice, quantity: 1 },
      ]
    : [{ price, quantity: 1 }];
  return (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items,
    })
  ).subscription;
}

// Book: 2× USD monthly ($50), 1× USD annual ($100/mo), 1× EUR monthly (€30), 1× USD monthly + usage.
await sub(usdMonthly);
await sub(usdMonthly);
await sub(usdAnnual);
await sub(eurMonthly);
const withUsage = await sub(usdMonthly, true); // usage must NOT add to MRR
// 1 canceled USD monthly (churn this window).
const churned = await sub(usdMonthly);
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: churned.id,
  atPeriodEnd: false,
  now: new Date(),
});
// 1 more canceled by dunning — analytics must file this as INVOLUNTARY churn.
const dunned = await sub(usdMonthly);
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: dunned.id,
  atPeriodEnd: false,
  now: new Date(),
  cancelReason: "not_paid",
});

const m = await computeBusinessMetrics(orgId, biz.id, new Date());
const usd = m.currencies.find((c) => c.currency === "USD")!;
const eur = m.currencies.find((c) => c.currency === "EUR")!;

// USD active MRR: 2×5000 + 1×10000(annual/12 = 10000) + 1×5000(withUsage, usage excluded) = 25000.
//   (churned one is canceled → excluded.)
console.log("USD:", JSON.stringify(usd));
console.log("EUR:", JSON.stringify(eur));
console.log("subscribers:", JSON.stringify(m.subscribers));
console.log("movement:", JSON.stringify(m.movement_30d));

const checks: Array<[string, boolean]> = [
  ["USD MRR = 25000", usd.mrr_minor === 25000],
  ["USD ARR = 300000", usd.arr_minor === 300000],
  ["USD active = 4", usd.active === 4],
  ["USD ARPU = 6250 (25000/4)", usd.arpu_minor === 6250],
  ["EUR MRR = 3000 (separate currency)", eur.mrr_minor === 3000],
  ["usage excluded from MRR", usd.mrr_minor === 25000], // would be >25000 if usage leaked in
  ["active count = 5", m.subscribers.active === 5],
  ["cancelled count = 2", m.subscribers.cancelled === 2],
  ["churned subs in window = 2", m.movement_30d.canceled_subscriptions === 2],
  ["churned MRR USD = 10000", m.movement_30d.churned_mrr_minor["USD"] === 10000],
  ["new subs in window = 7", m.movement_30d.new_subscriptions === 7],
];

void withUsage;

// ---------------------------------------------------------------------------
// Business Home analytics off the same book.
// ---------------------------------------------------------------------------
const now = new Date();
const a = await computeBusinessAnalytics(orgId, biz.id, { range: "daily", currency: "ALL", now });
const usdOnly = await computeBusinessAnalytics(orgId, biz.id, {
  range: "daily",
  currency: "USD",
  now,
});
const eurOnly = await computeBusinessAnalytics(orgId, biz.id, {
  range: "daily",
  currency: "EUR",
  now,
});
const s = (an: typeof a, key: string) => an.series.find((x) => x.key === key)!;

const SHAPES: Array<[AnalyticsRange, string, number]> = [
  ["daily", "day", 60],
  ["3m", "week", 13],
  ["6m", "week", 26],
  ["12m", "month", 12],
];
const shapes = await Promise.all(
  SHAPES.map(async ([range, gran, count]) => {
    const r = await computeBusinessAnalytics(orgId, biz.id, { range, currency: "USD", now });
    return r.granularity === gran && s(r, "total_billing").points.length === count;
  }),
);

console.log(
  "analytics kpis:",
  JSON.stringify(a.kpis.mrr),
  JSON.stringify(a.kpis.active_subscriptions),
);
console.log(
  "analytics currencies:",
  a.currency,
  a.available_currencies,
  "missing:",
  a.missing_rates,
);

const SERIES_KEYS = [
  "total_billing",
  "total_new_billing",
  "voluntary_cancellation_mrr",
  "involuntary_cancellation_mrr",
  "total_payments",
  "total_refunds",
  "total_mrr",
  "total_cmrr",
  "total_signups",
  "total_activations",
  "subscription_churn_rate",
  "total_credit_notes_amount",
];

const analyticsChecks: Array<[string, boolean]> = [
  ["analytics: all 12 series present", SERIES_KEYS.every((k) => a.series.some((x) => x.key === k))],
  ["analytics: bucket count + granularity per range", shapes.every(Boolean)],
  // The business has no EUR rate, so the ALL roll-up reports USD and flags EUR.
  ["analytics: ALL reports the default currency", a.currency === "USD"],
  ["analytics: EUR flagged as missing a rate", a.missing_rates.includes("EUR")],
  ["analytics: currencies offered = EUR, USD", a.available_currencies.join(",") === "EUR,USD"],
  // Currency scoping.
  ["analytics: USD-scoped MRR = 25000", usdOnly.kpis.mrr.value === 25000],
  ["analytics: EUR-scoped MRR = 3000", eurOnly.kpis.mrr.value === 3000],
  ["analytics: USD-scoped active = 4", usdOnly.kpis.active_subscriptions.value === 4],
  ["analytics: EUR-scoped active = 1", eurOnly.kpis.active_subscriptions.value === 1],
  ["analytics: scoped currency reports no missing rates", usdOnly.missing_rates.length === 0],
  // Series ↔ KPI invariants: the reconstruction must land on the point-in-time value.
  [
    "analytics: last total_mrr point = MRR KPI",
    s(usdOnly, "total_mrr").points.at(-1)!.v === usdOnly.kpis.mrr.value,
  ],
  [
    "analytics: first total_cmrr point = CMRR KPI",
    s(usdOnly, "total_cmrr").points[0]!.v === usdOnly.kpis.cmrr.value,
  ],
  ["analytics: MRR KPI = point-in-time metrics MRR", usdOnly.kpis.mrr.value === usd.mrr_minor],
  [
    "analytics: CMRR of a fully-renewing book = MRR",
    usdOnly.kpis.cmrr.value === usdOnly.kpis.mrr.value,
  ],
  ["analytics: total_cmrr projects forward", s(usdOnly, "total_cmrr").forward === true],
  // Churn split: the plain cancel is voluntary, the dunning cancel is not.
  [
    "analytics: voluntary cancellation MRR = 5000",
    s(usdOnly, "voluntary_cancellation_mrr").headline.value === 5000,
  ],
  [
    "analytics: involuntary cancellation MRR = 5000",
    s(usdOnly, "involuntary_cancellation_mrr").headline.value === 5000,
  ],
  // 2 cancels ÷ (0 live at window start + 7 started in it) = 2857 bps.
  [
    "analytics: churn rate = 2857 bps",
    s(usdOnly, "subscription_churn_rate").headline.value === 2857,
  ],
  [
    "analytics: churn headline is a percent",
    s(usdOnly, "subscription_churn_rate").headline.kind === "percent",
  ],
  // Counts. Signups are CUSTOMERS (one per subscription here).
  ["analytics: signups = 7 customers", s(a, "total_signups").headline.value === 7],
  [
    "analytics: signups KPI matches the series",
    a.kpis.signups_this_month.count <= 7 && s(a, "total_signups").headline.value === 7,
  ],
  // No money has moved on this book — every flow series must be flat at 0.
  [
    "analytics: no billing/payments/refunds/credit notes yet",
    ["total_billing", "total_payments", "total_refunds", "total_credit_notes_amount"].every(
      (k) => s(a, k).headline.value === 0 && s(a, k).points.every((p) => p.v === 0),
    ),
  ],
  [
    "analytics: no unpaid invoices",
    a.kpis.unpaid_invoices.count === 0 && a.kpis.unpaid_invoices.amount_minor === 0,
  ],
  // Plan mix: one product, so one row at 100%.
  ["analytics: plan mix total = 5 live", a.subscriptions_by_plan.total === 5],
  [
    "analytics: single plan row at 100%",
    a.subscriptions_by_plan.rows.length === 1 && a.subscriptions_by_plan.rows[0]!.pct_bps === 10000,
  ],
  ["analytics: plan row names the product", a.subscriptions_by_plan.rows[0]!.plan === "Plans"],
  ["analytics: USD plan mix excludes the EUR sub", usdOnly.subscriptions_by_plan.total === 4],
];
checks.push(...analyticsChecks);

// ── CMRR is COMMITTED MRR, not a second copy of MRR (2026-09-17) ──────────────
// It printed the MRR figure verbatim on every business measured, because "still live
// at t", evaluated at t = now, IS the MRR predicate. The two rows below are the whole
// difference: a booked cancellation stops being committed when it is BOOKED, and a
// signed subscription that has not started yet is committed already.
//
// Amounts are deliberately unequal ($50 leaving, $100/mo arriving) so the two figures
// cannot agree by accident — which is exactly how the old bug survived.
{
  const leaving = await sub(usdMonthly); // +$50 MRR, then booked to stop
  await cancelSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: leaving.id,
    atPeriodEnd: true,
    now: new Date(),
  });

  const futureCus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `future${Math.random()}@a.com`,
  });
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: futureCus.id,
    now: new Date(),
    startDate: new Date(Date.now() + 7 * 24 * 3600 * 1000), // $1200/yr = $100/mo
    items: [{ price: usdAnnual, quantity: 1 }],
  });

  const after = await computeBusinessAnalytics(orgId, biz.id, {
    range: "daily",
    currency: "USD",
    now: new Date(),
  });
  console.log(
    "cmrr probe:",
    JSON.stringify({ mrr: after.kpis.mrr.value, cmrr: after.kpis.cmrr.value }),
  );
  checks.push(
    // Earning: the 25000 book + the leaver still running. The future one earns nothing.
    ["cmrr: MRR = 30000 — counts the leaver, not the signing", after.kpis.mrr.value === 30000],
    // Committed: the 25000 book − the leaver (0) + the signing (10000).
    ["cmrr: CMRR = 35000 — drops the leaver, counts the signing", after.kpis.cmrr.value === 35000],
    ["cmrr: the two are no longer the same number", after.kpis.cmrr.value !== after.kpis.mrr.value],
    // The forward series must agree with the KPI it heads.
    [
      "cmrr: first forward point = CMRR KPI",
      s(after, "total_cmrr").points[0]!.v === after.kpis.cmrr.value,
    ],
  );
}

// ── The active count answers "how many are PAYING" (2026-09-17) ───────────────
// A fully-discounted subscription is active and contributes nothing, so the plain count
// overstates the book it is read as. Both figures are reported: the paying subset is the
// headline, the total sits under it.
{
  const { applyManualDiscount } = await import("@/modules/coupons/service");
  const free = await sub(usdMonthly);
  await applyManualDiscount({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: free.id,
    kind: "percentage",
    percentOffBps: 10000, // 100% off — active, MRR 0
    durationType: "forever",
    now: new Date(),
  });
  const after = await computeBusinessAnalytics(orgId, biz.id, {
    range: "daily",
    currency: "USD",
    now: new Date(),
  });
  console.log(
    "paying probe:",
    JSON.stringify({
      active: after.kpis.active_subscriptions.value,
      paying: after.kpis.paying_subscriptions.value,
      renewing: after.kpis.renewing_subscriptions.value,
      mrr: after.kpis.mrr.value,
    }),
  );
  checks.push(
    [
      "paying: the 100%-off subscription still counts as ACTIVE",
      after.kpis.active_subscriptions.value === 6,
    ],
    ["paying: …but not as paying", after.kpis.paying_subscriptions.value === 5],
    // The leaver booked above still bills $50: paying, but not renewing.
    [
      "paying: the non-renewing leaver is paying but not renewing",
      after.kpis.paying_subscriptions.value - after.kpis.renewing_subscriptions.value === 1,
    ],
    ["paying: and it adds nothing to MRR", after.kpis.mrr.value === 30000],
  );
}

// ── Business-timezone calendar windows + net "Received" ────────────────────────────
// A separate book, on `Asia/Kolkata` (UTC+5:30), probed at instants that fall inside
// the 5h30m every day where the local date and the UTC date disagree. The strip used
// to cut these windows with `utcDay`/`utcMonth`, so for that whole slice it filed
// yesterday's money and signups under "Today" and zeroed "Yesterday" — and on the 1st
// of a month, filed last month's under "this month".
const tzBiz = await createBusiness({
  organizationId: orgId,
  name: "IST Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "Asia/Kolkata",
});
/** A customer stamped at an exact instant, so signup counts are deterministic. */
async function customerAt(at: Date) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: tzBiz.id,
    email: `tz${Math.random()}@a.com`,
  });
  await systemDb.update(customers).set({ createdAt: at }).where(eq(customers.id, c.id));
  return c;
}
/** A settled payment/refund at an exact instant. */
async function txnAt(type: "payment" | "refund", amountMinor: number, at: Date) {
  await systemDb.insert(transactions).values({
    organizationId: orgId,
    businessId: tzBiz.id,
    publicId: publicId("txn"),
    type,
    status: "succeeded",
    amountMinor: BigInt(amountMinor),
    currency: "USD",
    occurredAt: at,
  });
}

// 2026-08-10 in Asia/Kolkata runs 2026-08-09T18:30Z → 2026-08-10T18:30Z.
const IST_AUG10_0100 = new Date("2026-08-09T19:30:00Z"); // 01:00 IST on the 10th
const IST_AUG10_2300 = new Date("2026-08-10T17:30:00Z"); // 23:00 IST on the 10th
const IST_AUG09_2300 = new Date("2026-08-09T17:30:00Z"); // 23:00 IST on the 9th — YESTERDAY
const IST_JUL31_2300 = new Date("2026-07-31T17:30:00Z"); // 23:00 IST on Jul 31 — LAST MONTH

await customerAt(IST_AUG10_0100); // today  (UTC would call this the 9th)
await customerAt(IST_AUG09_2300); // yesterday
await customerAt(IST_JUL31_2300); // last month
await txnAt("payment", 10_000, IST_AUG10_0100); // today: $100 in …
await txnAt("refund", 2_500, IST_AUG10_0100); // … less $25 refunded → $75 net
await txnAt("payment", 4_000, IST_AUG09_2300); // yesterday: $40
await txnAt("payment", 7_000, IST_JUL31_2300); // last month: $70 in …
await txnAt("refund", 1_000, IST_JUL31_2300); // … less $10 → $60 net
// Two years before the probe — far outside every window the page reads. `Net Payments`
// says "all time" on its face, so it must still count this; every dated figure must not.
// The row reads are bounded to the chart window now, and this is the row that proves the
// all-time figure is not being served from them.
await txnAt("payment", 50_000, new Date("2024-01-15T00:00:00Z")); // $500, pre-window

// Probed at 02:00 IST on the 10th — 20:30Z on the 9th, i.e. inside the gap.
const ist = await computeBusinessAnalytics(orgId, tzBiz.id, {
  currency: "USD",
  now: new Date("2026-08-09T20:30:00Z"),
});
// Probed at 01:00 IST on Aug 1 — 19:30Z on Jul 31, where UTC still says July.
const istMonthEdge = await computeBusinessAnalytics(orgId, tzBiz.id, {
  currency: "USD",
  now: new Date("2026-07-31T19:30:00Z"),
});

checks.push(
  // Day boundary: the local day, not the UTC one.
  ["tz: signups today = 1 (local day, not UTC)", ist.kpis.signups_today.count === 1],
  ["tz: signups yesterday = 1", ist.kpis.signups_today.yesterday === 1],
  ["tz: revenue today = $75 net of the refund", ist.kpis.revenue_today.received_minor === 7500],
  ["tz: revenue yesterday = $40", ist.kpis.revenue_today.yesterday_minor === 4000],
  // Month boundary: at 01:00 IST on Aug 1 the local month is August, while UTC still
  // says July — so July's $60 must sit under "Last month", not under "this month".
  // (The window is the whole calendar month, so this probe at its start still counts
  // the rows stamped later in August. Real rows are never in the future; the synthetic
  // ones here are, which is why the assertion is on WHICH month each figure reports.)
  [
    "tz: at 01:00 IST on Aug 1 this month is August, not July",
    istMonthEdge.kpis.revenue_this_month.received_minor === 11500,
  ],
  ["tz: … and July is last month", istMonthEdge.kpis.signups_this_month.last_month === 1],
  [
    "tz: … with July revenue net of its refund ($60)",
    istMonthEdge.kpis.revenue_this_month.last_month_minor === 6000,
  ],
  // Month totals from inside August: 2 signups (Aug 9 + Aug 10), $115 net received.
  ["tz: signups this month = 2", ist.kpis.signups_this_month.count === 2],
  ["tz: signups last month = 1", ist.kpis.signups_this_month.last_month === 1],
  ["tz: revenue this month = $115 net", ist.kpis.revenue_this_month.received_minor === 11500],
  ["tz: revenue last month = $60 net", ist.kpis.revenue_this_month.last_month_minor === 6000],
  // "Received" must mean the same thing as the Net Payments KPI above it.
  // $175 inside the windows + $500 from two years before them. Bounding the read that
  // feeds this — which is what the window-scoped rows would do — reports $175 and fails.
  [
    "tz: net payments (all time) = $675, including the pre-window $500",
    ist.kpis.net_payments_minor === 67500,
  ],
  [
    "tz: … while revenue this month ignores it",
    ist.kpis.revenue_this_month.received_minor === 11500,
  ],
  ["tz: … and revenue today ignores it", ist.kpis.revenue_today.received_minor === 7500],
);

// `windows` carries the list filters the strip deep-links with. They must name the
// LOCAL dates, or a link opens a list whose total contradicts the figure clicked.
// `after X` = `>= X + 1 day`, `before Y` = `< Y`, so August is (Jul 31, Sep 1).
checks.push(
  ["tz: windows.today is the local date", ist.windows.today.on === "2026-08-10"],
  ["tz: windows.yesterday is the local date", ist.windows.yesterday.on === "2026-08-09"],
  [
    "tz: windows.this_month bounds August",
    ist.windows.this_month.after === "2026-07-31" && ist.windows.this_month.before === "2026-09-01",
  ],
  [
    "tz: windows.last_month bounds July",
    ist.windows.last_month.after === "2026-06-30" && ist.windows.last_month.before === "2026-08-01",
  ],
);

// The list behind each signup link must total exactly the figure it was clicked from
// — the whole point of shipping the figure as a link rather than as coloured text.
const signupLinks: Array<[string, number, ListFilter[]]> = [
  [
    "today",
    ist.kpis.signups_today.count,
    [{ field: "created_at", op: "on", value: ist.windows.today.on }],
  ],
  [
    "yesterday",
    ist.kpis.signups_today.yesterday,
    [{ field: "created_at", op: "on", value: ist.windows.yesterday.on }],
  ],
  [
    "this month",
    ist.kpis.signups_this_month.count,
    [
      { field: "created_at", op: "after", value: ist.windows.this_month.after },
      { field: "created_at", op: "before", value: ist.windows.this_month.before },
    ],
  ],
  [
    "last month",
    ist.kpis.signups_this_month.last_month,
    [
      { field: "created_at", op: "after", value: ist.windows.last_month.after },
      { field: "created_at", op: "before", value: ist.windows.last_month.before },
    ],
  ],
];
for (const [label, figure, filters] of signupLinks) {
  const page = await listCustomersPage(orgId, tzBiz.id, { filters, limit: 1 });
  checks.push([
    `link: customers "${label}" list total = the ${figure} on the strip`,
    page.total === figure,
  ]);
}

// ── Plan mix: grouped by the PLAN item, and each row links to a list that agrees ──
// The book above has one plan product and no add-ons, so it cannot catch the bug this
// covers: the panel took `items[0]` from an UNORDERED query, so a subscription whose
// add-on row came back first was filed under the ADD-ON. Measured on a real book, that
// put `platform-additional-connections-v202604` (an add-on) on the panel as a plan and
// reported the real plan one short.
// Its OWN business: adding customers/subscriptions to `tzBiz` would move the signup
// and revenue counts the timezone assertions above pin down.
const mixBiz = await createBusiness({
  organizationId: orgId,
  name: "Mix Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const addonProduct = await createProduct({
  organizationId: orgId,
  businessId: mixBiz.id,
  name: "Extra Seats",
  kind: "addon",
});
const planProduct = await createProduct({
  organizationId: orgId,
  businessId: mixBiz.id,
  name: "Team Plan",
});
const planPrice = await createPrice({
  organizationId: orgId,
  businessId: mixBiz.id,
  productId: planProduct.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 9000,
  interval: "month",
});
const addonPrice = await createPrice({
  organizationId: orgId,
  businessId: mixBiz.id,
  productId: addonProduct.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 500,
  interval: "month",
});
// Two subscriptions on the same plan; one also carries the add-on.
for (const withAddon of [false, true]) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: mixBiz.id,
    email: `pm${Math.random()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: mixBiz.id,
    customer: c,
    token: "tok_4242",
  });
  await createSubscription({
    organizationId: orgId,
    businessId: mixBiz.id,
    customerId: c.id,
    now: new Date(),
    items: withAddon
      ? [
          { price: planPrice, quantity: 1 },
          { price: addonPrice, quantity: 1 },
        ]
      : [{ price: planPrice, quantity: 1 }],
  });
}

const mix = (await computeBusinessAnalytics(orgId, mixBiz.id, { currency: "USD" }))
  .subscriptions_by_plan;
const planRow = mix.rows.find((r) => r.plan_id === planProduct.publicId);
const planLink = await listSubscriptionsPage(orgId, mixBiz.id, {
  filters: [
    { field: "plan", op: "is", value: planProduct.publicId },
    { field: "status", op: "is", value: "active" },
  ],
  limit: 1,
});
checks.push(
  ["plan mix: both subscriptions file under the PLAN", planRow?.count === 2],
  [
    "plan mix: the add-on is NOT listed as a plan",
    !mix.rows.some((r) => r.plan_id === addonProduct.publicId),
  ],
  [
    "plan mix: rows sum to the panel total",
    mix.rows.reduce((s, r) => s + r.count, 0) === mix.total,
  ],
  ["link: subscriptions list total = the plan row count", planLink.total === planRow?.count],
);

// The window is the local calendar day, not a rolling 24h: probing 22 hours later,
// at 23:00 IST on the same date, must return the same "today".
const istLate = await computeBusinessAnalytics(orgId, tzBiz.id, {
  currency: "USD",
  now: IST_AUG10_2300,
});
checks.push(
  ["tz: 23:00 IST reports the same local day as 02:00 IST", istLate.kpis.signups_today.count === 1],
  ["tz: … and the same net revenue", istLate.kpis.revenue_today.received_minor === 7500],
);

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ METRICS: PASS" : "❌ METRICS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
