/**
 * Payments analytics (P3) — the calendar-relative payments dashboard behind
 * `GET /v1/businesses/:biz/payments_analytics`.
 *
 * Every assertion here exists because the failure mode is SILENT — a payments
 * KPI that is merely plausible is worse than one that is absent:
 *  - a calendar range resolved in UTC puts an Asia/Kolkata business's first 5h30m
 *    of every month in the *previous* month, so "This Month" quietly under-reports
 *    volume and the delta against last month is wrong in both directions;
 *  - a "previous period" that is not the same calendar unit (28 days ago, say)
 *    compares February with a slice of January and the tile still renders;
 *  - a failure rate whose denominator includes indeterminate outcomes
 *    (timeout / needs_attention) overstates declines;
 *  - a breakdown whose rows don't sum to the tile above it is a lie the UI
 *    cannot detect.
 *
 * The book below is fixed, so every expected number is hand-computed in the
 * comments rather than derived from the code under test.
 *
 *   pnpm verify:payments-analytics
 */
import { closeDb, withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { runWithEventContext } from "@/platform/event-context";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import {
  recordTransaction,
  type TransactionStatus,
  type TransactionType,
} from "@/modules/transactions/service";
import { computePaymentsAnalytics } from "@/modules/metrics/payments-analytics";
import { resolveCalendarRange } from "@/modules/metrics/calendar-ranges";
import { businesses, disputes, paymentIntents, paymentMethods } from "@db/schema";
import { eq } from "drizzle-orm";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, passed: boolean) => checks.push([name, passed]);

// ---------------------------------------------------------------------------
// Fixture. `NOW` is 2026-08-14 02:00Z = 2026-08-14 07:30 IST (a Friday), chosen
// so the UTC day/week/month and the Asia/Kolkata (+05:30, no DST) ones disagree.
// ---------------------------------------------------------------------------
const NOW = new Date("2026-08-14T02:00:00.000Z");
const TZ = "Asia/Kolkata";

const org = await createOrganization({ name: "Payments Analytics Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "IST Biz",
  defaultCurrency: "INR",
  livemode: "test",
  timezone: TZ,
});
// Control business in UTC — same calls, different boundaries.
const utcBiz = await createBusiness({
  organizationId: orgId,
  name: "UTC Biz",
  defaultCurrency: "INR",
  livemode: "test",
  timezone: "UTC",
});

const customer = await runWithEventContext({ source: "api", actor: "key_verify" }, () =>
  createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "pa@example.test",
    currency: "INR",
  }),
);

/** Two vaulted methods so the payment-method dimension has two real values. */
const [cardPm, upiPm] = await withTenant(orgId, async (tx) => {
  const mk = (type: string) =>
    tx
      .insert(paymentMethods)
      .values({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        publicId: publicId("pm"),
        providerKey: type === "card" ? "stripe" : "razorpay",
        providerCustomerId: `cus_${type}`,
        providerPaymentMethodId: `pm_${type}`,
        type,
      })
      .returning();
  return [(await mk("card"))[0]!, (await mk("upi"))[0]!];
});

interface Txn {
  type: TransactionType;
  status: TransactionStatus;
  amount: number;
  at: string;
  gateway: string;
  pm: "card" | "upi";
  error?: string;
  currency?: string;
}

/**
 * The book. IST calendar August = [2026-07-31T18:30Z, 2026-08-31T18:30Z).
 *
 * `#1` sits at 2026-07-31T19:00Z — that is 2026-08-01 00:30 **IST**. It belongs
 * to August for this business and to July in UTC; it is the whole tz test.
 */
const BOOK: Txn[] = [
  // --- current period (August, IST)
  {
    type: "payment",
    status: "succeeded",
    amount: 10_000,
    at: "2026-07-31T19:00:00Z",
    gateway: "stripe",
    pm: "card",
  },
  {
    type: "payment",
    status: "succeeded",
    amount: 20_000,
    at: "2026-08-05T06:00:00Z",
    gateway: "stripe",
    pm: "card",
  },
  {
    type: "payment",
    status: "succeeded",
    amount: 30_000,
    at: "2026-08-06T06:00:00Z",
    gateway: "razorpay",
    pm: "upi",
  },
  {
    type: "refund",
    status: "succeeded",
    amount: 5_000,
    at: "2026-08-07T06:00:00Z",
    gateway: "stripe",
    pm: "card",
  },
  {
    type: "payment",
    status: "failed",
    amount: 7_000,
    at: "2026-08-08T06:00:00Z",
    gateway: "stripe",
    pm: "card",
    error: "card_declined",
  },
  {
    type: "payment",
    status: "failed",
    amount: 3_000,
    at: "2026-08-09T06:00:00Z",
    gateway: "razorpay",
    pm: "upi",
    error: "insufficient_funds",
  },
  {
    type: "payment",
    status: "voided",
    amount: 1_000,
    at: "2026-08-10T06:00:00Z",
    gateway: "stripe",
    pm: "card",
  },
  {
    type: "payment",
    status: "timeout",
    amount: 900,
    at: "2026-08-11T06:00:00Z",
    gateway: "razorpay",
    pm: "upi",
  },
  // A USD success with NO configured FX rate — must be excluded from the INR
  // roll-up entirely (money AND count), and disclosed in `missing_rates`.
  {
    type: "payment",
    status: "succeeded",
    amount: 50_000,
    at: "2026-08-12T06:00:00Z",
    gateway: "stripe",
    pm: "card",
    currency: "USD",
  },
  // --- previous period (July, IST)
  {
    type: "payment",
    status: "succeeded",
    amount: 40_000,
    at: "2026-07-15T06:00:00Z",
    gateway: "stripe",
    pm: "card",
  },
];

await runWithEventContext({ source: "api", actor: "key_verify" }, async () => {
  for (const t of BOOK) {
    await recordTransaction({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      type: t.type,
      status: t.status,
      amountMinor: BigInt(t.amount),
      currency: t.currency ?? "INR",
      gatewayKey: t.gateway,
      paymentMethodId: t.pm === "card" ? cardPm.id : upiPm.id,
      errorCode: t.error ?? null,
      occurredAt: new Date(t.at),
    });
  }
});

await withTenant(orgId, async (tx) => {
  // One chargeback in August (IST) — ₹150.00, Stripe.
  await tx.insert(disputes).values({
    publicId: publicId("dsp"),
    organizationId: orgId,
    businessId: biz.id,
    providerKey: "stripe",
    providerDisputeId: "dp_verify_1",
    status: "needs_response",
    amountMinor: 15_000n,
    currency: "INR",
    openedAt: new Date("2026-08-05T07:00:00Z"),
  });
  // A EUR chargeback with NO configured FX rate, and NO EUR transaction behind
  // it in the window (a dispute is keyed by `opened_at`, so it routinely outlives
  // its payment's period). It must be EXCLUDED from chargebacks — and disclosed
  // in `missing_rates`, or the tile drops real money in silence.
  await tx.insert(disputes).values({
    publicId: publicId("dsp"),
    organizationId: orgId,
    businessId: biz.id,
    providerKey: "stripe",
    providerDisputeId: "dp_verify_eur",
    status: "needs_response",
    amountMinor: 90_000n,
    currency: "EUR",
    openedAt: new Date("2026-08-06T07:00:00Z"),
  });
  // Payment intents in August: 2 still pending, 1 consumed.
  for (const [status, at] of [
    ["inited", "2026-08-03T06:00:00Z"],
    ["in_progress", "2026-08-04T06:00:00Z"],
    ["consumed", "2026-08-04T07:00:00Z"],
  ] as const) {
    await tx.insert(paymentIntents).values({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      publicId: publicId("pi"),
      status,
      amountMinor: 9_900n,
      currency: "INR",
      paymentMethodId: cardPm.id,
      createdAt: new Date(at),
    });
  }
});

// ---------------------------------------------------------------------------
// 1. Calendar ranges resolve in the BUSINESS timezone.
// ---------------------------------------------------------------------------
const ranges = await withTenant(orgId, async (tx) => ({
  ist: {
    this_month: await resolveCalendarRange(tx, biz.id, "this_month", NOW),
    last_month: await resolveCalendarRange(tx, biz.id, "last_month", NOW),
    this_week: await resolveCalendarRange(tx, biz.id, "this_week", NOW),
    previous_week: await resolveCalendarRange(tx, biz.id, "previous_week", NOW),
    current_day: await resolveCalendarRange(tx, biz.id, "current_day", NOW),
    yesterday: await resolveCalendarRange(tx, biz.id, "yesterday", NOW),
  },
  utc: {
    this_month: await resolveCalendarRange(tx, utcBiz.id, "this_month", NOW),
    current_day: await resolveCalendarRange(tx, utcBiz.id, "current_day", NOW),
  },
}));

const iso = (d: Date) => d.toISOString();
const DAY = 86_400_000;

// IST August starts 2026-08-01 00:00 +05:30 = 2026-07-31T18:30Z.
ok(
  "this_month start resolves in the business tz (IST → 2026-07-31T18:30Z)",
  iso(ranges.ist.this_month.current.start) === "2026-07-31T18:30:00.000Z",
);
ok(
  "this_month end resolves in the business tz (IST → 2026-08-31T18:30Z)",
  iso(ranges.ist.this_month.current.end) === "2026-08-31T18:30:00.000Z",
);
ok(
  "the same call on a UTC business gives the UTC month (2026-08-01T00:00Z)",
  iso(ranges.utc.this_month.current.start) === "2026-08-01T00:00:00.000Z",
);
ok(
  "current_day is the IST day, not the UTC day (2026-08-13T18:30Z)",
  iso(ranges.ist.current_day.current.start) === "2026-08-13T18:30:00.000Z",
);
ok(
  "current_day on the UTC business is the UTC day",
  iso(ranges.utc.current_day.current.start) === "2026-08-14T00:00:00.000Z",
);
ok("resolved range reports the timezone it used", ranges.ist.this_month.timezone === TZ);

// Week start is the business's `week_start`, default Sunday. 2026-08-14 is a Friday.
ok(
  "this_week starts on the local Sunday by default (2026-08-08T18:30Z = Sun 9 Aug IST)",
  iso(ranges.ist.this_week.current.start) === "2026-08-08T18:30:00.000Z",
);
{
  const mondayWeek = await withTenant(orgId, async (tx) => {
    await tx.update(businesses).set({ weekStart: "monday" }).where(eq(businesses.id, biz.id));
    const r = await resolveCalendarRange(tx, biz.id, "this_week", NOW);
    await tx.update(businesses).set({ weekStart: "sunday" }).where(eq(businesses.id, biz.id));
    return r;
  });
  ok(
    "…and on the local Monday when week_start = 'monday' (2026-08-09T18:30Z = Mon 10 Aug IST)",
    iso(mondayWeek.current.start) === "2026-08-09T18:30:00.000Z" &&
      iso(mondayWeek.previous.start) === "2026-08-02T18:30:00.000Z",
  );
}

// ---------------------------------------------------------------------------
// 2. The previous period is the correct comparable.
// ---------------------------------------------------------------------------
for (const [name, r] of Object.entries(ranges.ist)) {
  ok(
    `${name}: previous.end === current.start (windows tile, no gap/overlap)`,
    iso(r.previous.end) === iso(r.current.start),
  );
}
// July has 31 days; August has 31. Both windows are whole calendar months.
ok(
  "this_month previous period is the whole of July (31 days)",
  ranges.ist.this_month.previous.end.getTime() - ranges.ist.this_month.previous.start.getTime() ===
    31 * DAY,
);
ok(
  "this_month previous period starts at the IST July boundary",
  iso(ranges.ist.this_month.previous.start) === "2026-06-30T18:30:00.000Z",
);
ok(
  "last_month's current window IS this_month's previous window",
  iso(ranges.ist.last_month.current.start) === iso(ranges.ist.this_month.previous.start) &&
    iso(ranges.ist.last_month.current.end) === iso(ranges.ist.this_month.previous.end),
);
ok(
  "previous_week's current window IS this_week's previous window",
  iso(ranges.ist.previous_week.current.start) === iso(ranges.ist.this_week.previous.start),
);
ok(
  "yesterday's current window IS current_day's previous window",
  iso(ranges.ist.yesterday.current.start) === iso(ranges.ist.current_day.previous.start),
);
ok(
  "week windows are exactly 7 days",
  ranges.ist.this_week.current.end.getTime() - ranges.ist.this_week.current.start.getTime() ===
    7 * DAY,
);

// ---------------------------------------------------------------------------
// 3. Measures over the fixed book (this_month, INR roll-up).
// ---------------------------------------------------------------------------
const pa = await computePaymentsAnalytics(orgId, biz.id, { range: "this_month", now: NOW });
const s = (key: string) => pa.series.find((x) => x.key === key)!;

ok("range + timezone echoed", pa.range === "this_month" && pa.timezone === TZ);
ok(
  "period labels are calendar-relative",
  pa.period.label === "This Month" && pa.previous_period.label === "Last Month",
);
ok("granularity for a month is day", pa.granularity === "day");
ok("31 day buckets for August", s("gross_volume").points.length === 31);
ok("reporting currency is the business default", pa.currency === "INR");
ok("USD has no FX rate → disclosed in missing_rates", pa.missing_rates.includes("USD"));
// A rateless currency that appears ONLY in disputes (or only in intents) must be
// disclosed too: it is excluded from the chargeback money exactly like a
// transaction currency is, and the UI warning is built from this list alone.
ok(
  "a rateless currency seen only in disputes is disclosed in missing_rates",
  pa.missing_rates.includes("EUR"),
);
ok(
  "available_currencies covers transactions AND disputes",
  pa.available_currencies.join(",") === "EUR,INR,USD",
);
ok(
  "the EUR chargeback is excluded from chargebacks (no rate), not converted at 1:1",
  s("chargebacks").headline.value === 15_000,
);

// gross = 10000 + 20000 + 30000 (USD 50000 excluded: no rate)
ok(
  "gross_volume = 60000 (the Aug-1-IST txn counts, USD excluded)",
  s("gross_volume").headline.value === 60_000,
);
ok("gross_volume prev = 40000 (July)", s("gross_volume").headline.prev_value === 40_000);
// (60000 - 40000) / 40000 = +50% = 5000 bps
ok("gross_volume change_bps = +5000 (=+50%)", s("gross_volume").headline.change_bps === 5_000);
ok("refunds = 5000", s("refunds").headline.value === 5_000);
ok("chargebacks = 15000 (from disputes)", s("chargebacks").headline.value === 15_000);
// 60000 - 5000 - 15000
ok("net_volume = 40000", s("net_volume").headline.value === 40_000);
// #1..#8 minus the USD row = 8
ok(
  "transaction_count = 8 (all types/statuses, USD excluded)",
  s("transaction_count").headline.value === 8,
);
ok("successful_payments = 3", s("successful_payments").headline.value === 3);
ok("failed_transactions = 2", s("failed_transactions").headline.value === 2);
ok("failed_amount = 10000 (7000 + 3000)", s("failed_amount").headline.value === 10_000);
// 2 failed / (2 failed + 3 succeeded charge attempts) = 40.00% — the voided and
// timeout rows are in transaction_count but NOT in this denominator.
ok(
  "failure_rate = 4000 bps (2 / (2+3)), voided+timeout excluded",
  s("failure_rate").headline.value === 4_000,
);
ok(
  "failure_rate prev = 0 bps (July had 1 success, 0 failures)",
  s("failure_rate").headline.prev_value === 0,
);
ok(
  "pending_payment_intents = 2 (inited + in_progress, consumed excluded)",
  s("pending_payment_intents").headline.value === 2,
);

// Every series carries the shared shape the Home read uses.
ok(
  "every series has headline.value/prev_value/prev_label + points[]",
  pa.series.every(
    (x) =>
      typeof x.headline.value === "number" &&
      typeof x.headline.prev_value === "number" &&
      x.headline.prev_label === "Last Month" &&
      Array.isArray(x.points) &&
      x.points.length === 31,
  ),
);

// Points are bucketed in the BUSINESS tz: #1 (2026-07-31T19:00Z) is Aug 1 IST.
const firstBucket = s("gross_volume").points[0]!;
ok("first bucket is 2026-08-01 (business tz)", firstBucket.t === "2026-08-01");
ok(
  "the 2026-07-31T19:00Z payment lands in the Aug-1 bucket (tz-correct)",
  firstBucket.v === 10_000,
);
const pointSum = s("gross_volume").points.reduce((a, p) => a + p.v, 0);
ok("gross_volume points sum to the headline", pointSum === s("gross_volume").headline.value);
ok(
  "transaction_count points sum to the headline",
  s("transaction_count").points.reduce((a, p) => a + p.v, 0) ===
    s("transaction_count").headline.value,
);

// ---------------------------------------------------------------------------
// 4. Every breakdown sums to its total.
// ---------------------------------------------------------------------------
const gw = pa.breakdowns.gateways;
const pm = pa.breakdowns.payment_methods;
const err = pa.breakdowns.error_details;
const sum = <T>(rows: T[], pick: (r: T) => number) => rows.reduce((a, r) => a + pick(r), 0);

ok(
  "gateway breakdown counts sum to transaction_count",
  sum(gw, (r) => r.count) === s("transaction_count").headline.value,
);
ok(
  "gateway breakdown amounts sum to gross_volume",
  sum(gw, (r) => r.amount_minor) === s("gross_volume").headline.value,
);
ok(
  "gateway breakdown failures sum to failed_transactions",
  sum(gw, (r) => r.failed_count) === s("failed_transactions").headline.value,
);
ok(
  "gateway breakdown previous counts sum to the previous transaction_count",
  sum(gw, (r) => r.prev_count) === s("transaction_count").headline.prev_value,
);
ok(
  "payment-method breakdown counts sum to transaction_count",
  sum(pm, (r) => r.count) === s("transaction_count").headline.value,
);
ok(
  "payment-method breakdown amounts sum to gross_volume",
  sum(pm, (r) => r.amount_minor) === s("gross_volume").headline.value,
);
ok(
  "error breakdown counts sum to failed_transactions",
  sum(err, (r) => r.count) === s("failed_transactions").headline.value,
);
ok(
  "error breakdown amounts sum to failed_amount",
  sum(err, (r) => r.amount_minor) === s("failed_amount").headline.value,
);
ok(
  "breakdown shares sum to 10000 bps",
  Math.abs(sum(gw, (r) => r.share_bps) - 10_000) <= gw.length,
);

// Hand-computed slices: stripe = #1,2,4,5,7 (5 rows, 30000 gross, 1 failure);
// razorpay = #3,6,8 (3 rows, 30000 gross, 1 failure).
const stripe = gw.find((r) => r.key === "stripe")!;
const razorpay = gw.find((r) => r.key === "razorpay")!;
ok(
  "stripe slice = 5 txns / 30000 gross / 1 failure",
  stripe.count === 5 && stripe.amount_minor === 30_000 && stripe.failed_count === 1,
);
ok(
  "razorpay slice = 3 txns / 30000 gross / 1 failure",
  razorpay.count === 3 && razorpay.amount_minor === 30_000 && razorpay.failed_count === 1,
);
ok(
  "gateway rows are labelled, not raw keys",
  stripe.label === "Stripe" && razorpay.label === "RazorPay",
);
ok(
  "error causes are the gateway codes",
  err
    .map((r) => r.error_code)
    .sort()
    .join(",") === "card_declined,insufficient_funds",
);
ok(
  "card_declined = 1 / 7000",
  err.find((r) => r.error_code === "card_declined")!.amount_minor === 7_000,
);
ok(
  "payment-method keys are the vaulted types",
  pm
    .map((r) => r.key)
    .sort()
    .join(",") === "card,upi",
);
ok(
  "filter options are not narrowed by the (absent) filter",
  pa.options.gateways
    .map((o) => o.key)
    .sort()
    .join(",") === "razorpay,stripe" &&
    pa.options.payment_methods
      .map((o) => o.key)
      .sort()
      .join(",") === "card,upi",
);

// ---------------------------------------------------------------------------
// 5. Filters.
// ---------------------------------------------------------------------------
const onlyStripe = await computePaymentsAnalytics(orgId, biz.id, {
  range: "this_month",
  now: NOW,
  gateway: "stripe",
});
const sS = (k: string) => onlyStripe.series.find((x) => x.key === k)!;
ok("gateway filter echoed", onlyStripe.filters.gateway === "stripe");
ok(
  "gateway=stripe → gross 30000 / 5 txns",
  sS("gross_volume").headline.value === 30_000 && sS("transaction_count").headline.value === 5,
);
// stripe: 1 failure / (1 failure + 2 successes) = 33.33%
ok("gateway=stripe → failure_rate 3333 bps", sS("failure_rate").headline.value === 3_333);
ok(
  "gateway=stripe → chargebacks still 15000 (dispute provider_key matches)",
  sS("chargebacks").headline.value === 15_000,
);
ok(
  "gateway=stripe → only stripe in the breakdown",
  onlyStripe.breakdowns.gateways.map((r) => r.key).join(",") === "stripe",
);
ok("gateway filter does not narrow the options list", onlyStripe.options.gateways.length === 2);

const onlyUpi = await computePaymentsAnalytics(orgId, biz.id, {
  range: "this_month",
  now: NOW,
  paymentMethod: "upi",
});
const sU = (k: string) => onlyUpi.series.find((x) => x.key === k)!;
ok(
  "payment_method=upi → gross 30000 / 3 txns",
  sU("gross_volume").headline.value === 30_000 && sU("transaction_count").headline.value === 3,
);
// upi: 1 failure / (1 failure + 1 success) = 50%
ok("payment_method=upi → failure_rate 5000 bps", sU("failure_rate").headline.value === 5_000);
ok(
  "payment_method=upi → chargebacks 0 (the dispute has no upi payment behind it)",
  sU("chargebacks").headline.value === 0,
);
ok(
  "payment_method=upi → pending intents 0 (both are on the card method)",
  sU("pending_payment_intents").headline.value === 0,
);

const bogus = await computePaymentsAnalytics(orgId, biz.id, {
  range: "this_month",
  now: NOW,
  gateway: "nope",
});
ok(
  "an unmatched gateway filter yields zeros, not everything",
  bogus.series.find((x) => x.key === "transaction_count")!.headline.value === 0,
);

// ---------------------------------------------------------------------------
// 6. Currency scoping + other ranges.
// ---------------------------------------------------------------------------
const usd = await computePaymentsAnalytics(orgId, biz.id, {
  range: "this_month",
  now: NOW,
  currency: "USD",
});
ok(
  "currency=USD scopes money AND counts to USD (50000 / 1 txn)",
  usd.series.find((x) => x.key === "gross_volume")!.headline.value === 50_000 &&
    usd.series.find((x) => x.key === "transaction_count")!.headline.value === 1,
);
ok(
  "a scoped read reports no missing rates",
  usd.missing_rates.length === 0 && usd.converted === false,
);

const lastMonth = await computePaymentsAnalytics(orgId, biz.id, { range: "last_month", now: NOW });
ok(
  "last_month current = this_month previous (40000 gross)",
  lastMonth.series.find((x) => x.key === "gross_volume")!.headline.value === 40_000,
);
ok(
  "last_month has 31 buckets (July)",
  lastMonth.series.find((x) => x.key === "gross_volume")!.points.length === 31,
);
ok(
  "last_month period.start === this_month previous_period.start",
  lastMonth.period.start === pa.previous_period.start,
);

const day = await computePaymentsAnalytics(orgId, biz.id, { range: "current_day", now: NOW });
ok(
  "current_day buckets hourly (24 buckets)",
  day.granularity === "hour" &&
    day.series.find((x) => x.key === "gross_volume")!.points.length === 24,
);
ok(
  "hourly bucket labels are wall-clock hours",
  day.series.find((x) => x.key === "gross_volume")!.points[0]!.label === "00:00",
);

const week = await computePaymentsAnalytics(orgId, biz.id, { range: "this_week", now: NOW });
ok(
  "this_week has 7 daily buckets",
  week.series.find((x) => x.key === "gross_volume")!.points.length === 7,
);

// The UTC control business sees none of this book (its own transactions are none),
// proving the read is business-scoped and not org-scoped.
const other = await computePaymentsAnalytics(orgId, utcBiz.id, { range: "this_month", now: NOW });
ok(
  "the read is business-scoped",
  other.series.find((x) => x.key === "transaction_count")!.headline.value === 0,
);

// ---------------------------------------------------------------------------
let pass = true;
for (const [name, okFlag] of checks) {
  console.log(`  ${okFlag ? "✓" : "✗"} ${name}`);
  if (!okFlag) pass = false;
}
console.log("");
console.log(`${checks.filter(([, f]) => f).length}/${checks.length} checks`);
console.log(pass ? "✅ PAYMENTS ANALYTICS: PASS" : "❌ PAYMENTS ANALYTICS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
