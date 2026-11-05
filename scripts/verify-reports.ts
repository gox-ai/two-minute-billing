/**
 * The report layer (Phase 3a): the registry, the resolvers, and the one property that makes
 * a catalogue trustworthy — **a report and the dashboard must not disagree.**
 *
 * They read the same ledger, so any disagreement is about WINDOWS, and windows disagree on
 * exactly the edges nobody checks. This is not hypothetical: the first run of this resolver
 * cut its month in UTC while the dashboard cuts it in the business timezone, and on an
 * Asia/Kolkata book the same ledger produced a quick ratio of 5.67× on one screen and 6.09×
 * on the other. The fixture below is deliberately on a non-UTC timezone so that a regression
 * of that kind fails here rather than in someone's board pack.
 *
 *   pnpm verify:reports
 */
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, cancelSubscription } from "@/modules/subscriptions/service";
import { computeBusinessAnalytics, calendarWindows } from "@/modules/metrics/analytics";
import {
  REPORTS,
  REPORT_BY_KEY,
  TAG_LABELS,
  GRANULARITIES,
  acceptsGranularity,
  acceptsAgingInterval,
} from "@/modules/metrics/reports/registry";
import {
  AR_AGING_INTERVALS,
  arAgingLadder,
  arBucketValueError,
} from "@/modules/invoicing/ar-aging";
import {
  resolveReport,
  resolveComparisonWindows,
  ReportError,
  countryStockPath,
  resetCountryStockPath,
  stockPath,
  resetStockPath,
  type ReportComparisonBasis,
} from "@/modules/metrics/reports/resolve";
import { utcDayString, endOfDay } from "@/modules/metrics/snapshots";
import { computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { writeMetricDay } from "@/modules/metrics/daily/write";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import {
  appliedCoupons,
  mrrMovements,
  exchangeRateHistory,
  invoices,
  invoiceLineDiscounts,
  payments,
  subscriptions,
} from "@db/schema";
import { recordExchangeRateObservations } from "@/platform/fx/history";
import { eq } from "drizzle-orm";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Reports Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Reports Biz",
  defaultCurrency: "USD",
  livemode: "test",
  // NON-UTC on purpose — see the header. A UTC fixture cannot see the bug this suite exists
  // to catch.
  timezone: "Asia/Kolkata",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plans" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});

async function sub() {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `rp${Math.random()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  return (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    })
  ).subscription;
}

// Book: 4 × $50 live, 1 × $50 churned.
await sub();
await sub();
await sub();
await sub();
const dead = await sub();
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: dead.id,
  atPeriodEnd: false,
  now: new Date(),
});

const now = new Date();
const run = (key: string, opts: Parameters<typeof resolveReport>[3] = {}) =>
  resolveReport(orgId, biz.id, key, { currency: "USD", now, ...opts });

// ── The registry is well formed ──────────────────────────────────────────────
// Cheap, and it catches the copy-paste that a catalogue of declarations invites.
{
  ok("registry: every key is unique", new Set(REPORTS.map((r) => r.key)).size === REPORTS.length);
  ok(
    "registry: every variant points at a real report",
    REPORTS.every((r) => (r.variants ?? []).every((v) => REPORT_BY_KEY.has(v.key))),
  );
  ok(
    "registry: every movement report declares what it sums — reasons, signed, or a bucketing",
    REPORTS.filter((r) => r.source === "movement").every(
      (r) =>
        r.reasons != null ||
        r.signed ||
        r.bucketing != null ||
        r.cohort != null ||
        r.periodic != null ||
        r.customers != null,
    ),
  );
  ok(
    "registry: every bucketed report declares its bucketing",
    REPORTS.filter((r) => r.shape === "buckets").every((r) => r.bucketing != null),
  );
  ok(
    "registry: every scheduled report declares its measure",
    REPORTS.filter((r) => r.source === "scheduled").every((r) => r.scheduled != null),
  );
  ok(
    "registry: every derived report declares a formula",
    REPORTS.filter((r) => r.source === "derived").every((r) => r.formula != null),
  );
  /**
   * A forward-looking measure needs a forward window.
   *
   * `total_upcoming_renewal_amount` shipped as `shape: "flow"`, so a measure that is in the
   * FUTURE for every live subscription was bucketed over the last twelve months: eleven empty
   * buckets and one accidental hit, $685K reported against $1.44M actually falling due. The
   * whole 117-check suite stayed green through it, because nothing related a report's window
   * to the direction of the thing it measures. This is that check.
   */
  ok(
    "registry: a measure that looks ahead is declared forward, not flow",
    REPORTS.filter((r) => r.metric === "upcoming_renewal_amount").every(
      (r) => r.shape === "forward",
    ),
  );
  ok(
    "registry: every stock report declares a measure",
    REPORTS.filter((r) => r.source === "stock").every((r) => r.measure != null),
  );
}

// ── Tags ─────────────────────────────────────────────────────────────────────
// A report has ONE category — its home in the grouped list — and any number of tags, which
// cut across it ("everything about tax" spans billing and receivables). Tags are a filter,
// never a second grouping: grouping on them would print the catalogue longer than the number
// of reports in it, the same report under five headings.
{
  const known = new Set(Object.keys(TAG_LABELS));
  const unknown = REPORTS.flatMap((r) => (r.tags ?? []).filter((t) => !known.has(t)));
  ok("tags: every tag a report carries is in the vocabulary", unknown.length === 0);

  const used = new Set<string>(REPORTS.flatMap((r) => r.tags ?? []));
  const unused = [...known].filter((t) => !used.has(t));
  if (unused.length > 0) console.log("  ↳ declared but never used:", unused.join(", "));
  ok("tags: every declared tag is actually used", unused.length === 0);

  ok(
    "tags: no report repeats a tag",
    REPORTS.every((r) => new Set(r.tags ?? []).size === (r.tags ?? []).length),
  );
  // A tag that matched everything, or nothing, would be a chip not worth rendering.
  const counts = [...used].map(
    (t) => REPORTS.filter((r) => ((r.tags ?? []) as ReadonlyArray<string>).includes(t)).length,
  );
  ok(
    "tags: every tag narrows the catalogue without emptying it",
    counts.every((n) => n > 0 && n < REPORTS.length),
  );
  // The payload has to carry them, or the client keeps its own copy of the vocabulary — and
  // a copy is how a catalogue offers a filter the engine has dropped.
  const one = await run("total_revenue_leakage");
  ok("tags: a report's answer carries its tags", one.tags.includes("leakage"));
}

// ── Every report answers, in one shape ───────────────────────────────────────
// The whole promise of a registry is that a client can render a report it has never heard
// of, which only holds if every key returns the same envelope.
{
  const results = await Promise.all(REPORTS.map((r) => run(r.key)));
  ok("resolve: every declared report returns an answer", results.length === REPORTS.length);
  ok(
    "resolve: every answer carries the uniform envelope",
    results.every(
      (r) =>
        r.object === "report" &&
        typeof r.key === "string" &&
        typeof r.currency === "string" &&
        Array.isArray(r.points),
    ),
  );
  // A series is owed by exactly the reports that declare one: not a derived rate, not a
  // bucketed breakdown, not the forward book, and not the ones that are explicitly about
  // NOW. Asserted as an equivalence so a report cannot quietly stop drawing.
  const owesSeries = (key: string) => {
    const d = REPORT_BY_KEY.get(key)!;
    return (
      d.source !== "derived" &&
      d.source !== "scheduled" &&
      d.shape !== "buckets" &&
      d.shape !== "cohort" &&
      d.shape !== "periodic" &&
      !d.noSeries
    );
  };
  const seriesOffenders = results
    .filter((r) => (owesSeries(r.key) ? r.points.length === 0 : r.points.length > 0))
    .map((r) => r.key);
  if (seriesOffenders.length > 0) console.log("  ↳ series mismatch:", seriesOffenders.join(", "));
  ok(
    "resolve: a report carries a series exactly when it declares one",
    seriesOffenders.length === 0,
  );
  // Granularity is exactly what cuts a series, so the two predicates must be the same one.
  // If they drift, the catalogue offers a granularity control on a report whose resolver
  // ignores it — the control-that-reaches-nothing failure, in the engine rather than the UI.
  ok(
    "granularity: offered on exactly the reports that draw a series",
    REPORTS.every((r) => acceptsGranularity(r) === owesSeries(r.key)),
  );
  ok(
    "granularity: the payload lists the cuts it accepts, and nothing where it has none",
    results.every((r) =>
      owesSeries(r.key)
        ? r.granularities.length === GRANULARITIES.length
        : r.granularities.length === 0,
    ),
  );
}

// ── The numbers ──────────────────────────────────────────────────────────────
{
  const mrr = await run("total_mrr");
  const arr = await run("total_arr");
  const newMrr = await run("total_new_mrr");
  const churn = await run("total_churn_mrr");
  const net = await run("net_mrr_growth");
  console.log(
    "reports:",
    JSON.stringify({
      mrr: mrr.headline,
      arr: arr.headline,
      new: newMrr.headline,
      churn: churn.headline,
      net: net.headline,
    }),
  );
  ok("numbers: total MRR = 20000 (four live, the churned one out)", mrr.headline === 20000);
  ok("numbers: ARR is MRR × 12", arr.headline === 240000);
  ok("numbers: new MRR counts all five sales", newMrr.headline === 25000);
  ok("numbers: churn MRR states the loss as a POSITIVE amount", churn.headline === 5000);
  ok("numbers: net growth is signed — 25000 − 5000", net.headline === 20000);
}

// ── Agreement with the dashboard ─────────────────────────────────────────────
// The property this suite exists for.
{
  const a = await computeBusinessAnalytics(orgId, biz.id, { range: "12m", currency: "USD", now });
  const mrr = await run("total_mrr");
  const cmrr = await run("total_cmrr");
  const quick = await run("quick_ratio");
  const grr = await run("gross_revenue_retention_rate");
  ok("agreement: total_mrr = the MRR KPI", mrr.headline === a.kpis.mrr.value);
  ok("agreement: total_cmrr = the CMRR KPI", cmrr.headline === a.kpis.cmrr.value);
  ok(
    "agreement: quick ratio = the dashboard's — the same month, in the business timezone",
    quick.headline === a.kpis.retention.quick_ratio_bps,
  );
  ok(
    "agreement: gross retention = the dashboard's",
    grr.headline === a.kpis.retention.gross_retention_bps,
  );
  const expansion = await run("total_expansion_mrr");
  const series = a.series.find((s) => s.key === "total_expansion_mrr")!;
  ok(
    "agreement: a flow report's window total = the dashboard series headline",
    expansion.headline === series.headline.value,
  );
}

// ── The other sources answer too, in the same envelope ───────────────────────
// Invoice, transaction and subscription reports are separate resolvers; the catalogue's
// promise is that a client cannot tell which one answered.
{
  const billing = await run("total_billing");
  const receivables = await run("total_receivables");
  const dunning = await run("dunning_status_summary");
  const errors = await run("payment_error_summary");
  const activeSubs = await run("total_active_subscriptions");
  const customers = await run("total_active_customers");
  const trials = await run("total_subscription_trials");

  ok("sources: an invoice report answers with a series", billing.points.length > 0);
  ok(
    "sources: a bucketed report answers with ROWS and no series",
    receivables.points.length === 0 && (receivables.rows ?? []).length > 0,
  );
  ok(
    "sources: the ageing ladder's rows sum to its headline",
    (receivables.rows ?? []).reduce((n, r) => n + r.value, 0) === receivables.headline,
  );
  ok(
    "sources: a status summary is rows, even when empty of activity",
    dunning.points.length === 0 && Array.isArray(dunning.rows),
  );
  ok("sources: an error summary is rows", Array.isArray(errors.rows));
  ok("sources: a subscription count answers", activeSubs.headline === 4);
  ok("sources: active CUSTOMERS counts people, not subscriptions", customers.headline === 4);
  ok("sources: trials are counted (this fixture has none)", trials.headline === 0);
}

// ── Agreement, again, across the new sources ─────────────────────────────────
{
  const a = await computeBusinessAnalytics(orgId, biz.id, { range: "12m", currency: "USD", now });
  const activeSubs = await run("total_active_subscriptions");
  const paid = await run("total_active_paid_subscriptions");
  const receivables = await run("total_receivables");
  ok(
    "agreement: active subscriptions = the dashboard KPI",
    activeSubs.headline === a.kpis.active_subscriptions.value,
  );
  ok(
    "agreement: active PAID subscriptions = the paying KPI",
    paid.headline === a.kpis.paying_subscriptions.value,
  );
  ok(
    "agreement: receivables = the unpaid-invoices KPI",
    receivables.headline === a.kpis.unpaid_invoices.amount_minor,
  );
  const billing = await run("total_billing");
  const series = a.series.find((s) => s.key === "total_billing")!;
  ok(
    "agreement: total billing = the dashboard series headline",
    billing.headline === series.headline.value,
  );
}

// ── The forward book, and the identity that ties it to CMRR ──────────────────
// A booked cancellation lives on the SUBSCRIPTION (`cancel_at_period_end` / a dated
// `cancel_scheduled_at`), not in `scheduled_changes`. Reading the wrong one reported 0 on a
// book where CMRR was excluding $29.68K/month of exactly these. The identity below is what
// makes that impossible to reintroduce quietly: what CMRR takes out IS what is booked to go.
{
  const leaving = await sub();
  await cancelSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: leaving.id,
    atPeriodEnd: true,
    now: new Date(),
  });
  const a = await computeBusinessAnalytics(orgId, biz.id, {
    range: "12m",
    currency: "USD",
    now: new Date(),
  });
  const scheduledMrr = await resolveReport(orgId, biz.id, "total_scheduled_cancellation_mrr", {
    currency: "USD",
    now: new Date(),
  });
  const scheduledCount = await resolveReport(orgId, biz.id, "total_scheduled_cancellations", {
    currency: "USD",
    now: new Date(),
  });
  ok("forward: one subscription is booked to cancel", scheduledCount.headline === 1);
  ok("forward: its MRR is reported", scheduledMrr.headline === 5000);
  ok(
    "forward: scheduled cancellation MRR = MRR − CMRR, exactly",
    scheduledMrr.headline === a.kpis.mrr.value - a.kpis.cmrr.value,
  );

  // Upgrade vs expansion needs the from-plan; with none recorded, these report nothing
  // rather than silently counting every expansion as an upgrade.
  const upgrade = await resolveReport(orgId, biz.id, "total_upgrade_mrr", {
    currency: "USD",
    now: new Date(),
  });
  ok("forward: upgrade MRR reports only real plan changes", upgrade.headline === 0);
}

// ── The waterfall, and the identity that makes it worth reading ──────────────
// opening + new + expansion + reactivation − contraction − churn + FX = closing, on EVERY
// row. The first cut read opening and closing from the snapshot reader while the middle
// columns came from the ledger, and the row was out by $142.76 on the dev book — snapshots
// backfilled at today's rates against deltas that are what actually moved. One source per
// row, and this check is what keeps it that way.
{
  const w = await run("mrr_movement_summary");
  const t = w.table!;
  const col = (key: string) => t.columns.findIndex((c) => c.key === key);
  const [o, net, cl] = [col("opening"), col("net"), col("closing")];
  console.log("waterfall:", JSON.stringify(t.rows[0]));

  ok("waterfall: a row per month, newest first", t.rows.length === 12);
  // Every shape must expose EXACTLY ONE carrier — points, rows, matrix or table. The CSV
  // route picks a branch per carrier, and a shape with none falls through to an empty file:
  // that is precisely what the waterfall did on its first export.
  const carriers = (r: Awaited<ReturnType<typeof run>>) =>
    [r.points.length > 0, r.rows != null, r.matrix != null, r.table != null].filter(Boolean).length;
  const allShapes = await Promise.all(REPORTS.map((r) => run(r.key)));
  /**
   * Each SHAPE must carry its own kind of answer. Not "every report returns something" — a
   * derived rate over a month with no base is legitimately null, and asserting otherwise
   * would force a 0 that reads as total loss. The contract is per shape:
   * buckets → rows, cohort → matrix, periodic → table.
   */
  const missingCarrier = allShapes
    .filter((r) => {
      const d = REPORT_BY_KEY.get(r.key)!;
      if (d.shape === "buckets") return r.rows == null;
      if (d.shape === "cohort") return r.matrix == null;
      if (d.shape === "periodic") return r.table == null;
      return false;
    })
    .map((r) => r.key);
  if (missingCarrier.length > 0)
    console.log("  ↳ shape with no carrier:", missingCarrier.join(", "));
  ok(
    "shapes: every shape carries its own answer — rows, matrix or table",
    missingCarrier.length === 0,
  );
  ok("waterfall: carries exactly one — its table", carriers(w) === 1 && w.table != null);
  ok("waterfall: fourteen columns, opening through closing", t.columns.length === 14);
  // The movement columns PARTITION the ledger: every row lands in exactly one, which is what
  // makes the row reconcile. A movement counted in two columns (an upgrade that is also
  // expansion) would make the book add up to more than it is.
  //
  // `fx` is deliberately outside that partition: it is not a ledger row at all, it is what
  // the RATE did to the converted total, and in its own currency it is exactly zero.
  const gains = ["new", "free_to_paid", "upgrade", "expansion", "reactivation", "resumed"];
  const losses = ["downgrade", "contraction", "paused", "churn"];
  ok(
    "waterfall: every movement column is either a gain or a loss, none counted twice",
    t.columns
      .map((c) => c.key)
      .filter((k) => !["opening", "closing", "net", "fx"].includes(k))
      .every((k) => gains.includes(k) || losses.includes(k)),
  );
  const idx = (key: string) => t.columns.findIndex((x) => x.key === key);
  const fxCol = idx("fx");
  const offenders = t.rows.filter((r) => {
    const gained = gains.reduce((sum, k) => sum + (r.values[idx(k)] ?? 0), 0);
    const lost = losses.reduce((sum, k) => sum + (r.values[idx(k)] ?? 0), 0);
    return r.values[o]! + gained - lost + (r.values[fxCol] ?? 0) !== r.values[cl]!;
  });
  for (const bad of offenders) console.log("  ↳ does not reconcile:", JSON.stringify(bad));
  ok("waterfall: EVERY row reconciles opening → closing", offenders.length === 0);
  ok(
    "waterfall: net plus FX equals closing minus opening on every row",
    t.rows.every((r) => r.values[net]! + (r.values[fxCol] ?? 0) === r.values[cl]! - r.values[o]!),
  );
  // A single-currency book has nothing for a rate to move. FX must be silent there, or the
  // column would be noise on every business that never left its own currency.
  ok(
    "waterfall: FX is zero on a book that is all in the reporting currency",
    t.rows.every((r) => r.values[fxCol] === 0),
  );

  // The current month's closing figure is the book as it stands, so it must be the MRR KPI —
  // the waterfall and the dashboard cannot be two different books.
  const a = await computeBusinessAnalytics(orgId, biz.id, { range: "12m", currency: "USD", now });
  ok("waterfall: this month's closing = the MRR KPI", t.rows[0]!.values[cl] === a.kpis.mrr.value);
  // The headline IS that closing figure. It was read by hardcoded index once, and widening
  // the table moved the index: the page showed $0.00 for a book worth $855K.
  ok("waterfall: the headline is this month's closing", w.headline === t.rows[0]!.values[cl]);

  const arr = await run("arr_movement_summary");
  ok(
    "waterfall: the ARR variant is the same table times twelve",
    arr.table!.rows[0]!.values[cl] === t.rows[0]!.values[cl]! * 12,
  );
}

// ── Cohorts ──────────────────────────────────────────────────────────────────
// Reconstructed from the ledger: a subscription's MRR at an instant is the sum of its own
// deltas up to it, so a cohort curve is exact for anything the writer recorded.
{
  const cohort = await run("subscription_retention_cohort");
  const money = await run("mrr_retention_cohort");
  const m = cohort.matrix!;
  const thisMonth = m.rows.at(-1)!;
  console.log(
    "cohort:",
    JSON.stringify({
      rows: m.rows.length,
      base: thisMonth.base,
      first: thisMonth.values.slice(0, 2),
    }),
  );

  ok(
    "cohort: the grid is returned with columns and rows",
    m.columns.length === 12 && m.rows.length >= 1,
  );
  // FOUR, not five: the fixture churns one immediately, and a subscription carrying no
  // revenue at the measurement instant is not retained. The cohort counts what survived,
  // not what was signed.
  ok("cohort: this month's intake is the four that survived their own month", thisMonth.base === 4);
  ok("cohort: M0 is 100% of the cohort's own opening", thisMonth.values[0] === 10000);
  // A month that has not begun is null — 0 would read as total churn on a cohort that is
  // simply young, which is the classic way a cohort table lies.
  ok("cohort: future months are null, not zero", thisMonth.values[1] === null);
  ok("cohort: the MRR cohort labels its base as money", money.matrix?.base_kind === "money");
  ok("cohort: the subscription cohort labels its base as a count", m.base_kind === "count");
  ok("cohort: a cohort report draws no series", cohort.points.length === 0);
}

// ── The rest of the catalogue ────────────────────────────────────────────────
{
  const breakdown = await run("churn_breakdown_summary");
  const arps = await run("average_revenue_per_paid_subscription");
  const ltv = await run("lifetime_value_of_a_paid_subscription");
  const total = await run("total_subscriptions");
  const activations = await run("total_activations");
  const renewals = await run("total_upcoming_renewal_amount");

  // Six age buckets, and they account for every cancellation — a breakdown whose parts do
  // not sum to the whole sends the reader looking for the missing rows.
  ok("catalogue: churn breakdown has six age buckets", (breakdown.rows ?? []).length === 6);
  ok(
    "catalogue: its buckets sum to the cancellations",
    (breakdown.rows ?? []).reduce((n, r) => n + r.value, 0) === breakdown.headline,
  );

  // ARPS divides by the PAYING count, not the active one: a free subscription drags the
  // average down without earning anything.
  const a = await computeBusinessAnalytics(orgId, biz.id, { range: "12m", currency: "USD", now });
  ok(
    "catalogue: ARPS = MRR ÷ paying subscriptions",
    arps.headline === Math.round(a.kpis.mrr.value / a.kpis.paying_subscriptions.value),
  );
  ok("catalogue: LTV is reported once something has ended", ltv.headline != null);

  // The one count that does NOT filter by status — which is what makes it different from
  // the active count beside it.
  /**
   * Total subscriptions ignores BOTH status and time — that is the whole point of it beside
   * the active count. Compared against a live instant, not the fixture's frozen `now`: this
   * suite pins `now` before the later subscriptions exist, so the active count measured
   * there legitimately predates them. (That mismatch is what this check caught first, and
   * the expectation was wrong, not the report.)
   */
  const live = await computeBusinessAnalytics(orgId, biz.id, {
    range: "12m",
    currency: "USD",
    now: new Date(),
  });
  const cancelled = (await run("churn_breakdown_summary")).headline!;
  ok(
    "catalogue: total subscriptions = the live ones plus the cancelled ones",
    total.headline === live.kpis.active_subscriptions.value + cancelled,
  );
  ok("catalogue: activations are counted", activations.headline != null);
  ok("catalogue: upcoming renewals answer with a series", renewals.points.length > 0);
}

// ── A signup is an ACCOUNT, not a subscription ───────────────────────────────
// One customer with two subscriptions signed up once. The fixture above gives every
// subscription its own customer, so the distinction only shows with a deliberate second
// subscription on an existing customer.
{
  const before = (await run("total_signups")).headline!;
  const shared = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `shared${Math.random()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: shared,
    token: "tok_4242",
  });
  for (let i = 0; i < 2; i++) {
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: shared.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    });
  }
  const after = (await run("total_signups")).headline!;
  ok("signups: two subscriptions on one customer count as ONE signup", after === before + 1);
}

// ── Counts of the things themselves ──────────────────────────────────────────
// The money reports say how much; these say how many, and each one must agree with the
// summary that splits it. A summary whose rows do not sum to the count beside it sends the
// reader hunting for rows that were never there.
{
  const churn = await run("total_subscription_churn");
  const payments = await run("total_payment_transactions");
  const paymentSummary = await run("payment_transaction_summary");
  const refunds = await run("total_refund_transactions");
  const refundSummary = await run("refund_transactions_summary");
  const failedRefunds = await run("total_failed_refund_transactions");
  console.log(
    "counts:",
    JSON.stringify({
      subscription_churn: churn.headline,
      payments: payments.headline,
      payment_statuses: paymentSummary.rows?.map((r) => `${r.group}=${r.value}`),
      refunds: refunds.headline,
      failed_refunds: failedRefunds.headline,
    }),
  );

  // ONE: the fixture cancels one subscription outright. The other is booked to cancel at
  // period end and has not left yet — `canceled_at` is null, so it is not a cancellation.
  ok("counts: subscription churn counts the cancellations that landed", churn.headline === 1);
  ok(
    "counts: every payment attempt lands in exactly one status row",
    (paymentSummary.rows ?? []).reduce((n, r) => n + r.value, 0) === payments.headline,
  );
  ok(
    "counts: …and the refund summary sums to the refund count the same way",
    (refundSummary.rows ?? []).reduce((n, r) => n + r.value, 0) === refunds.headline,
  );
  // A status summary counts EVERY outcome, an error summary only the failures — so the
  // failure count can never exceed the status rows it is drawn from.
  const failedStatuses = (refundSummary.rows ?? [])
    .filter((r) => r.group !== "succeeded")
    .reduce((n, r) => n + r.value, 0);
  ok(
    "counts: failed refunds are the non-success rows of the summary",
    failedRefunds.headline === failedStatuses,
  );
  ok(
    "counts: a status summary answers with rows and no series",
    paymentSummary.points.length === 0 && Array.isArray(paymentSummary.rows),
  );
}

// ── The Account Summary, and the rule it reconciles on ───────────────────────
// Net = Gross billing − Discounts + Taxes − Credit notes − Written off, which is the same
// statement as "the billed document totals, less credit notes and write-offs". Asserted on
// EVERY row: a billing summary that does not add up is worse than no billing summary, and
// the columns that cannot be a term of a monthly net (voided, recovered) are deliberately
// not in the table.
{
  const s = await run("account_summary");
  const t = s.table!;
  const col = (key: string) => t.columns.findIndex((c) => c.key === key);
  const [gross, disc, tax, cn, wo, net] = [
    col("gross_billing"),
    col("discounts"),
    col("taxes"),
    col("credit_notes"),
    col("written_off"),
    col("net"),
  ];
  console.log("account summary:", JSON.stringify(t.rows[0]));

  ok("account summary: a row per month, newest first", t.rows.length === 12);
  ok("account summary: six columns, gross through net", t.columns.length === 6);
  ok(
    "account summary: carries its table and no series",
    s.points.length === 0 && s.table != null && s.rows == null,
  );
  const offenders = t.rows.filter(
    (r) =>
      r.values[net] !==
      r.values[gross]! - r.values[disc]! + r.values[tax]! - r.values[cn]! - r.values[wo]!,
  );
  for (const bad of offenders) console.log("  ↳ does not reconcile:", JSON.stringify(bad));
  ok("account summary: EVERY row reconciles to its net", offenders.length === 0);
  // The other form of the same rule: gross − discounts + taxes IS what was billed at the
  // document total, so the twelve rows must sum to the Total Billing report over the same
  // twelve months. Two answers to "what did we bill" is the failure this layer exists to
  // prevent.
  const billed = t.rows.reduce(
    (n, r) => n + r.values[gross]! - r.values[disc]! + r.values[tax]!,
    0,
  );
  const billing = await run("total_billing");
  ok("account summary: its billed total = the Total Billing report", billed === billing.headline);
  ok("account summary: the headline is this month's net", s.headline === t.rows[0]!.values[net]);
}

// ── Customer grain: a customer with three subscriptions counts ONCE ──────────
// The ledger carries `customer_id`, so these are a grouping of movements we already hold.
// The whole property worth checking is the de-duplication.
{
  const before = (await run("total_new_customers")).headline!;
  const many = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `many${Math.random()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: many,
    token: "tok_4242",
  });
  for (let i = 0; i < 3; i++) {
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: many.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    });
  }
  const after = await run("total_new_customers");
  const moved = await run("total_customers_with_movement");
  const churned = await run("total_churned_customers");
  console.log(
    "customers:",
    JSON.stringify({ new: after.headline, moved: moved.headline, churned: churned.headline }),
  );
  ok(
    "customers: three subscriptions on one customer count as ONE new customer",
    after.headline === before + 1,
  );
  ok(
    "customers: every customer that moved is counted once, and all of them are new here",
    moved.headline === after.headline,
  );
  // ONE: the subscription cancelled outright belonged to a customer with nothing else. The
  // one booked to cancel at period end has not churned, and a customer who cancels one of
  // several subscriptions is not a lost account.
  ok(
    "customers: churn at customer grain is a LOST ACCOUNT, not a cancelled subscription",
    churned.headline === 1,
  );
  ok("customers: the count draws a series", after.points.length > 0);
}

// ── Granularity: a second control, not a second range ────────────────────────
// `range` says how far back; `granularity` says how finely. The re-cut must be a finer view
// of the SAME window — otherwise the same report totals differently at two granularities
// and neither figure can be trusted.
{
  const monthly = await run("total_new_mrr", { range: "12m" });
  const daily = await run("total_new_mrr", { range: "12m", granularity: "day" });
  const weekly = await run("total_new_mrr", { range: "12m", granularity: "week" });
  console.log(
    "granularity:",
    JSON.stringify({
      month: monthly.points.length,
      week: weekly.points.length,
      day: daily.points.length,
    }),
  );

  ok("granularity: a range preset still implies its own cut", monthly.granularity === "month");
  ok(
    "granularity: an override re-cuts the series",
    daily.granularity === "day" && daily.points.length > 300,
  );
  ok(
    "granularity: the window total is identical at every cut",
    daily.headline === monthly.headline && weekly.headline === monthly.headline,
  );
  ok(
    "granularity: and so is the sum of the points — the same window, cut finer",
    daily.points.reduce((n, p) => n + p.v, 0) === monthly.points.reduce((n, p) => n + p.v, 0) &&
      weekly.points.reduce((n, p) => n + p.v, 0) === monthly.points.reduce((n, p) => n + p.v, 0),
  );
  // Coarser than the preset, too: sixty days by month is a legitimate question.
  const coarse = await run("total_new_mrr", { range: "daily", granularity: "month" });
  const fine = await run("total_new_mrr", { range: "daily" });
  ok(
    "granularity: a coarser cut of a short range keeps its window",
    coarse.headline === fine.headline && coarse.points.length < fine.points.length,
  );

  // Refused, not ignored, wherever there is no series to re-cut: the reader would otherwise
  // believe the table had been cut differently when nothing had happened.
  const refusals: Array<[string, string]> = [
    ["account_summary", "a periodic table"],
    ["mrr_movement_summary", "a waterfall"],
    ["mrr_retention_cohort", "a cohort grid"],
    ["total_receivables", "an ageing ladder"],
    ["quick_ratio", "a derived rate"],
    ["total_cards_expired", "a count about now"],
  ];
  const notRefused: string[] = [];
  for (const [key, what] of refusals) {
    try {
      await run(key, { granularity: "day" });
      notRefused.push(`${key} (${what})`);
    } catch (e) {
      if (!(e instanceof ReportError)) notRefused.push(`${key} threw the wrong error`);
    }
  }
  if (notRefused.length > 0)
    console.log("  ↳ accepted granularity it cannot honour:", notRefused.join(", "));
  ok("granularity: refused by every shape with no series to re-cut", notRefused.length === 0);

  let badValue = false;
  try {
    await run("total_new_mrr", { granularity: "fortnight" });
  } catch (e) {
    badValue = e instanceof ReportError;
  }
  ok("granularity: an unknown cut is a named refusal", badValue);
}

// ── The ageing ladder's rung width ───────────────────────────────────────────
// A reader who collects weekly cannot read a 30-day ladder, and one on annual terms cannot
// read it either. The width is a control; what must not move is the total, because
// re-bucketing moves rows between rungs and cannot change how much is owed.
{
  const standard = await run("receivables_aging_summary");
  ok(
    "aging_interval: the default ladder is unchanged, rung for rung",
    (standard.rows ?? []).map((r) => r.group).join("|") ===
      "Current|1–30 days|31–60 days|61–90 days|91–120 days|121–150 days|151–180 days|181–365 days|365+ days",
  );
  ok(
    "aging_interval: the default answer names the ladder it used",
    standard.aging_interval === "standard",
  );
  ok(
    "aging_interval: asking for the standard ladder by name is the same ladder",
    (await run("receivables_aging_summary", { agingInterval: "standard" })).rows
      ?.map((r) => r.group)
      .join("|") === (standard.rows ?? []).map((r) => r.group).join("|"),
  );

  for (const interval of ["7", "15", "30", "60"] as const) {
    const report = await run("receivables_aging_summary", { agingInterval: interval });
    const ladder = arAgingLadder(interval);
    ok(
      `aging_interval: ${interval}-day rungs print that ladder, ending at a year and an open tail`,
      (report.rows ?? []).map((r) => r.group).join("|") === ladder.labels.join("|") &&
        ladder.edges[ladder.edges.length - 1] === 365 &&
        ladder.labels[ladder.labels.length - 1] === "365+ days",
    );
    ok(
      `aging_interval: ${interval}-day rungs sum to the same total as the standard ladder`,
      (report.rows ?? []).reduce((n, r) => n + r.value, 0) === standard.headline,
    );
    // Every rung the report can print must be a rung the drill-down filter accepts, or the
    // figure links to nothing.
    ok(
      `aging_interval: every ${interval}-day rung is an accepted filter value`,
      (report.rows ?? []).every((r) => arBucketValueError("is", r.group) == null),
    );
  }
  // Uniform rungs are NOT the standard ladder: the standard one steps monthly to six months
  // and then takes a single stride to a year, which a generator must not quietly replace.
  ok(
    "aging_interval: 30-day rungs are a different ladder from the standard one",
    arAgingLadder("30").labels.join("|") !== arAgingLadder("standard").labels.join("|"),
  );

  const refused = async (key: string, interval: string) => {
    try {
      await run(key, { agingInterval: interval });
      return null;
    } catch (e) {
      return e instanceof ReportError ? e.message : null;
    }
  };
  const bad = await refused("receivables_aging_summary", "45");
  ok(
    "aging_interval: a width outside the set is refused by name",
    bad != null && bad.includes("45"),
  );
  const wrongReport = await refused("dunning_status_summary", "15");
  ok(
    "aging_interval: refused on a report that is not an ageing ladder",
    wrongReport != null && wrongReport.includes("aging_interval"),
  );
  ok(
    "aging_interval: offered on exactly the ageing ladders",
    REPORTS.filter((r) => acceptsAgingInterval(r))
      .map((r) => r.key)
      .join(",") === "total_receivables,receivables_aging_summary",
  );
  ok(
    "aging_interval: the payload lists the widths it accepts, and nothing where it has none",
    (await run("total_receivables")).aging_intervals.length === AR_AGING_INTERVALS.length &&
      (await run("dunning_status_summary")).aging_intervals.length === 0,
  );
}

// ── Comparison on the record (4a) ────────────────────────────────────────────
/**
 * The trap: a month-to-date figure against a COMPLETE previous month is a guaranteed false
 * drop — worst on the 2nd, invisible by the 28th. So every check here is about the PAIR of
 * windows rather than about a number: they must tile, they must be cut the same way, and
 * the payload must say which way that was.
 */
{
  const BASES: ReportComparisonBasis[] = [
    "month_to_date",
    "complete_month",
    "period_to_date",
    "complete_period",
    "point_in_time",
  ];
  const comparable = REPORTS.filter((r) => r.comparable);
  console.log(
    `comparison: ${comparable.length} of ${REPORTS.length} reports declare a previous period`,
  );

  // Declared only where a previous period EXISTS. A forward projection has none, an
  // as-of-now stock has none, and a bucketed/cohort/periodic answer is its rows.
  const badFamily = comparable
    .filter(
      (r) =>
        r.shape === "forward" ||
        r.shape === "buckets" ||
        r.shape === "cohort" ||
        r.shape === "periodic" ||
        r.noSeries === true ||
        (r.source === "derived" && r.shape === "stock"),
    )
    .map((r) => r.key);
  if (badFamily.length > 0) console.log("  ↳ cannot have a previous period:", badFamily.join(", "));
  ok("comparison: declared only on a family that has a previous period", badFamily.length === 0);

  // Declared exactly where it is carried — the same equivalence the series check uses, so a
  // client can offer the control on the strength of the declaration alone.
  const all = await Promise.all(REPORTS.map((r) => run(r.key)));
  const declaredMismatch = all
    .filter((r) => (REPORT_BY_KEY.get(r.key)!.comparable === true) !== (r.comparison != null))
    .map((r) => r.key);
  if (declaredMismatch.length > 0) console.log("  ↳ mismatch:", declaredMismatch.join(", "));
  ok(
    "comparison: a report carries one exactly when it declares one",
    declaredMismatch.length === 0,
  );

  // Carried means COMPLETE: a comparison whose basis cannot be stated is not shipped.
  const incomplete = all
    .filter((r) => r.comparison != null)
    .filter((r) => {
      const c = r.comparison!;
      return (
        typeof c.prev_label !== "string" ||
        c.prev_label.length === 0 ||
        !BASES.includes(c.basis) ||
        (c.prev_value !== null && typeof c.prev_value !== "number") ||
        (c.change_bps !== null && typeof c.change_bps !== "number")
      );
    })
    .map((r) => r.key);
  if (incomplete.length > 0) console.log("  ↳ incomplete comparison:", incomplete.join(", "));
  ok("comparison: every one carried states a value, a period and a basis", incomplete.length === 0);

  // The windows themselves. One calendar means the previous window ENDS where the current
  // one starts — no gap to lose a movement in, no overlap to count one twice.
  const windows = await Promise.all(
    comparable.map(
      async (r) =>
        [
          r.key,
          (await resolveComparisonWindows(orgId, biz.id, r.key, { currency: "USD", now }))!,
        ] as const,
    ),
  );
  const notTiling = windows
    .filter(([, w]) => w.previous.end.getTime() !== w.current.start.getTime())
    .map(([k]) => k);
  if (notTiling.length > 0) console.log("  ↳ windows do not tile:", notTiling.join(", "));
  ok(
    "comparison: the previous window ends where the current one starts — one calendar",
    notTiling.length === 0,
  );

  // Like to like. A calendar window's only slack is a leap day; anything more means one
  // side was cut where the other was not.
  const elapsed = (w: { start: Date; cut: Date }) => w.cut.getTime() - w.start.getTime();
  const DAY_MS = 86_400_000;
  const lopsided = windows
    .filter(([, w]) => Math.abs(elapsed(w.current) - elapsed(w.previous)) > DAY_MS)
    .map(([k]) => k);
  if (lopsided.length > 0) console.log("  ↳ uneven elapsed span:", lopsided.join(", "));
  ok("comparison: both sides cover the same elapsed span", lopsided.length === 0);

  const mixed = windows
    .filter(([, w]) => w.current.cut < w.current.end !== w.previous.cut < w.previous.end)
    .map(([k]) => k);
  if (mixed.length > 0) console.log("  ↳ partial vs complete:", mixed.join(", "));
  ok("comparison: a partial period is never compared against a complete one", mixed.length === 0);

  // The basis is not decoration: it has to agree with how the pair was actually cut.
  const misstated = windows
    .filter(([, w]) => {
      const toDate = w.basis === "month_to_date" || w.basis === "period_to_date";
      const partial = w.current.cut < w.current.end;
      return w.basis === "point_in_time" ? false : toDate !== partial;
    })
    .map(([k]) => k);
  if (misstated.length > 0) console.log("  ↳ basis disagrees with the cut:", misstated.join(", "));
  ok("comparison: the stated basis is the one the pair was cut on", misstated.length === 0);

  // The derived rates are quoted over the last COMPLETE month, which must be the month the
  // DASHBOARD means — the timezone bug this suite exists for, now on the comparison too.
  const cal = await withTenant(orgId, (tx) => calendarWindows(tx, "Asia/Kolkata", now));
  const quickWindows = (await resolveComparisonWindows(orgId, biz.id, "quick_ratio", {
    currency: "USD",
    now,
  }))!;
  ok(
    "comparison: a derived rate's window IS the dashboard's last complete month",
    quickWindows.current.start.getTime() === cal.lastMonth.start.getTime() &&
      quickWindows.current.end.getTime() === cal.lastMonth.end.getTime(),
  );
  ok(
    "comparison: …and it compares a complete month against a complete month",
    quickWindows.basis === "complete_month" &&
      quickWindows.previous.cut.getTime() === quickWindows.previous.end.getTime(),
  );
  // Labelled by the month it COVERS. On a book east of UTC the start of a local August is
  // 31 July in UTC, so a label taken from the edge printed the wrong month.
  const quick = await run("quick_ratio");
  ok(
    "comparison: a month window is labelled by the month it covers, not its UTC edge",
    (quick.window_label ?? "").startsWith(cal.thisMonth.label) === false &&
      (quick.window_label ?? "").startsWith(cal.lastMonth.label),
  );

  // Null, never 0, where there is no base: this book has nothing in the window before last.
  const newMrr = await run("total_new_mrr");
  ok(
    "comparison: no base means a null change, not a flat 0",
    newMrr.comparison?.prev_value === 0 && newMrr.comparison?.change_bps === null,
  );
  ok(
    "comparison: a flow over a range window states it is period-to-date",
    newMrr.comparison?.basis === "period_to_date",
  );
  const mrrCmp = (await run("total_mrr")).comparison;
  ok(
    "comparison: a stock states the instant it was read at",
    mrrCmp?.basis === "point_in_time" && /\d{4}$/.test(mrrCmp.prev_label),
  );
  ok(
    "comparison: a forward projection carries none",
    (await run("total_cmrr")).comparison === undefined,
  );

  // Every range, because the shift is expressed in the preset's own vocabulary — 12 months
  // for the monthly preset, 13 weeks and 60 days for the others. A shift stated in one unit
  // for a window cut in another is how the pair stops tiling.
  const ranges = ["daily", "3m", "6m", "12m"] as const;
  const perRange = await Promise.all(
    ranges.map(
      async (range) =>
        [
          range,
          (await resolveComparisonWindows(orgId, biz.id, "total_new_mrr", {
            currency: "USD",
            now,
            range,
          }))!,
        ] as const,
    ),
  );
  const rangeOffenders = perRange
    .filter(
      ([, w]) =>
        w.previous.end.getTime() !== w.current.start.getTime() ||
        Math.abs(
          w.current.cut.getTime() -
            w.current.start.getTime() -
            (w.previous.cut.getTime() - w.previous.start.getTime()),
        ) > 86_400_000,
    )
    .map(([r]) => r);
  if (rangeOffenders.length > 0) console.log("  ↳ range:", rangeOffenders.join(", "));
  ok("comparison: the pair tiles and matches at every range", rangeOffenders.length === 0);
}

// ── The clip, on a book built to catch it ────────────────────────────────────
/**
 * The property the whole of 4a exists for, measured rather than asserted: money that landed
 * in the previous window but AFTER the point the current window reaches must not be in the
 * comparison. Unclipped, this book would report 10000 as its previous New MRR and a halving
 * that never happened.
 */
{
  const cmpBiz = await createBusiness({
    organizationId: orgId,
    name: "Comparison Biz",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "Asia/Kolkata",
  });
  const cmpProduct = await createProduct({
    organizationId: orgId,
    businessId: cmpBiz.id,
    name: "Plans",
  });
  const cmpPrice = await createPrice({
    organizationId: orgId,
    businessId: cmpBiz.id,
    productId: cmpProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const sale = async (at: Date) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: cmpBiz.id,
      email: `cmp${Math.random()}@a.com`,
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: cmpBiz.id,
      customer: c,
      token: "tok_4242",
    });
    await createSubscription({
      organizationId: orgId,
      businessId: cmpBiz.id,
      customerId: c.id,
      now: at,
      items: [{ price: cmpPrice, quantity: 1 }],
    });
  };

  // Placed off the RESOLVED windows rather than off a guessed date, so the fixture cannot
  // drift with the day of the month this runs on.
  const w = (await resolveComparisonWindows(orgId, cmpBiz.id, "total_new_mrr", {
    currency: "USD",
    now,
  }))!;
  const afterTheClip = new Date((w.previous.cut.getTime() + w.previous.end.getTime()) / 2);
  const beforeTheClip = new Date((w.previous.start.getTime() + w.previous.cut.getTime()) / 2);
  ok(
    "clip: the previous window really is cut short of its end",
    w.previous.cut.getTime() < w.previous.end.getTime() && afterTheClip > w.previous.cut,
  );

  await sale(beforeTheClip); // counts in the comparison
  await sale(afterTheClip); // must NOT: the current window has not reached this far
  await sale(now); // the current figure — two sales, so the change is not a coin flip
  await sale(now);

  const r = await resolveReport(orgId, cmpBiz.id, "total_new_mrr", { currency: "USD", now });
  console.log("clip:", JSON.stringify({ headline: r.headline, comparison: r.comparison }));
  ok("clip: the current window counts the sale inside it", r.headline === 10000);
  ok(
    "clip: the comparison counts only what the current window has reached",
    r.comparison?.prev_value === 5000,
  );
  ok("clip: …so the change is the real one, +100%", r.comparison?.change_bps === 10000);
  const stock = await resolveReport(orgId, cmpBiz.id, "total_mrr", { currency: "USD", now });
  ok(
    "clip: a stock reads the book at the earlier instant, not the earlier window's end",
    stock.headline === 20000 && stock.comparison?.prev_value === 5000,
  );
}

// ── group_by, and refusing what it cannot do ─────────────────────────────────
{
  const byPlan = await run("total_new_mrr", { groupBy: "plan" });
  ok("group_by: a plan breakdown is returned", (byPlan.rows ?? []).length === 1);
  ok("group_by: …and sums to the headline", (byPlan.rows ?? [])[0]?.value === byPlan.headline);

  // A breakdown the data cannot support is REFUSED, not returned empty: an empty breakdown
  // reads as "no activity" when the truth is "wrong question".
  let refused = false;
  try {
    await run("quick_ratio", { groupBy: "plan" });
  } catch (e) {
    refused = e instanceof ReportError;
  }
  ok("group_by: an unsupported breakdown is refused, not silently empty", refused);

  // Currency is a dimension wherever the rows carry one. Its amounts stay in their OWN
  // currency: converting first and then labelling the row with the source currency would
  // print dollars under another code.
  const byCcy = await run("total_new_mrr", { groupBy: "currency" });
  ok("group_by: currency is offered on a movement report", (byCcy.rows ?? []).length === 1);
  ok("group_by: …and names the currency it is in", (byCcy.rows ?? [])[0]?.group === "USD");
  const billingByCcy = await run("total_billing", { groupBy: "currency" });
  ok("group_by: an invoice report groups by currency too", Array.isArray(billingByCcy.rows));

  let unknown = false;
  try {
    await run("no_such_report");
  } catch (e) {
    unknown = e instanceof ReportError;
  }
  ok("catalogue: an unknown key is a named refusal", unknown);
}

// ── Customer grain: what an ACCOUNT is worth (4d) ────────────────────────────
/**
 * A subscription-grain book cannot say what an account is worth, and the one way to get
 * that wrong is to let a customer with three subscriptions count as three. So this fixture
 * is built around that: a four-account book where one account holds three subscriptions,
 * another has ended across two, and the numbers only come out if the de-duplication holds.
 *
 * Its own business, so the figures are exact rather than "whatever the earlier sections
 * left behind" — and every timestamp is explicit, because an account's LIFETIME is the span
 * between two of them and a fixture that leans on wall-clock drift cannot pin it.
 */
{
  const ccBiz = await createBusiness({
    organizationId: orgId,
    name: "Customer Grain Biz",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "Asia/Kolkata",
  });
  const ccProduct = await createProduct({
    organizationId: orgId,
    businessId: ccBiz.id,
    name: "Plans",
  });
  const priceAt = (amountMinor: number) =>
    createPrice({
      organizationId: orgId,
      businessId: ccBiz.id,
      productId: ccProduct.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const p50 = await priceAt(5000);
  const p200 = await priceAt(20000);

  const T = new Date();
  const ago = (days: number) => new Date(T.getTime() - days * 86_400_000);
  const account = async (label: string) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: ccBiz.id,
      email: `cc-${label}-${Math.random()}@a.com`,
      firstName: label,
      lastName: "Account",
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: ccBiz.id,
      customer: c,
      token: "tok_4242",
    });
    return c;
  };
  const sell = async (customerId: string, price: typeof p50, at: Date) =>
    (
      await createSubscription({
        organizationId: orgId,
        businessId: ccBiz.id,
        customerId,
        now: at,
        items: [{ price, quantity: 1 }],
      })
    ).subscription;
  const kill = (subscriptionId: string, at: Date) =>
    cancelSubscription({
      organizationId: orgId,
      businessId: ccBiz.id,
      subscriptionId,
      atPeriodEnd: false,
      now: at,
    });

  // A holds THREE subscriptions — the account the whole section exists to count once.
  const A = await account("multi");
  await sell(A.id, p50, ago(30));
  await sell(A.id, p50, ago(30));
  await sell(A.id, p50, ago(30));
  // B is the big account; C and G are ordinary ones. G predates the 3m window, which is
  // what gives the churn rate a base to divide by.
  const B = await account("big");
  await sell(B.id, p200, ago(30));
  const C = await account("small");
  await sell(C.id, p50, ago(30));
  const G = await account("old");
  await sell(G.id, p50, ago(200));
  // D ended on its only subscription; E ended across TWO, 60 days apart — so its ACCOUNT
  // outlived either subscription. F ended inside the 3m window from outside it.
  const D = await account("gone");
  await kill((await sell(D.id, p50, ago(30))).id, ago(30));
  const E = await account("gone-twice");
  const e1 = await sell(E.id, p50, ago(60));
  const e2 = await sell(E.id, p50, ago(10));
  await kill(e1.id, T);
  await kill(e2.id, T);
  const F = await account("gone-recently");
  await kill((await sell(F.id, p50, ago(200))).id, ago(30));

  const ccNow = new Date();
  const cc = (key: string, opts: Parameters<typeof resolveReport>[3] = {}) =>
    resolveReport(orgId, ccBiz.id, key, { currency: "USD", now: ccNow, ...opts });

  // Live book: A 15000, B 20000, C 5000, G 5000 — six subscriptions, four accounts.
  const mrr = await cc("total_mrr");
  const activeSubs = await cc("total_active_subscriptions");
  const activeCust = await cc("total_active_customers");
  const paying = await cc("total_paying_customers");
  const perSub = await cc("average_revenue_per_paid_subscription");
  const perCust = await cc("average_revenue_per_paying_customer");
  const perHead = await cc("average_subscriptions_per_customer");
  console.log(
    "customer grain:",
    JSON.stringify({
      mrr: mrr.headline,
      subs: activeSubs.headline,
      customers: activeCust.headline,
      paying: paying.headline,
      arps: perSub.headline,
      arpc: perCust.headline,
      subs_per_customer: perHead.headline,
    }),
  );

  ok(
    "grain: the fixture's live book is 45000 across six subscriptions",
    mrr.headline === 45000 && activeSubs.headline === 6,
  );
  /**
   * THE identity. Six subscriptions, four accounts — and A's three count as one. Stated
   * against the subscription count rather than against a literal, so the check fails if
   * either side drifts.
   */
  ok(
    "grain: a customer with three subscriptions counts ONCE — 4 accounts, not 6",
    activeCust.headline === 4 && paying.headline === 4 && activeSubs.headline === 6,
  );
  ok("grain: paying customers never exceed active ones", paying.headline! <= activeCust.headline!);
  ok("grain: subscriptions per customer states the factor — 6 ÷ 4", perHead.headline === 1.5);
  // ARPU is per SUBSCRIPTION, ARPC per ACCOUNT, and the gap between them is exactly that
  // factor. If the de-duplication broke, these two would collapse onto each other.
  ok("grain: ARPC = MRR ÷ paying CUSTOMERS", perCust.headline === Math.round(45000 / 4));
  ok("grain: ARPS = MRR ÷ paying SUBSCRIPTIONS", perSub.headline === Math.round(45000 / 6));
  ok(
    "grain: …so the per-account figure is the per-subscription one times the factor",
    perCust.headline === Math.round(perSub.headline! * 1.5),
  );

  // ── Lifetime, at account grain ────────────────────────────────────────────
  // E's account ran 60 days across two subscriptions of 60 and 10 — so an account-grain
  // average cannot equal a subscription-grain one, and this pins that it does not.
  const accountLife = await cc("average_customer_lifetime");
  const subLife = await cc("average_lifetime_of_a_paid_subscription");
  const ltv = await cc("lifetime_value_of_a_customer");
  console.log(
    "customer lifetime:",
    JSON.stringify({
      account: accountLife.headline,
      subscription: subLife.headline,
      ltv: ltv.headline,
    }),
  );
  // Three ended ACCOUNTS — 0, 2.0 and 5.67 months — against four ended subscriptions.
  ok(
    "lifetime: an account's life is measured over the accounts that ENDED",
    accountLife.headline === 2.6,
  );
  ok(
    "lifetime: account grain is not subscription grain — E lived 60 days across two subs of 60 and 10",
    subLife.headline === 2.0 && accountLife.headline !== subLife.headline,
  );
  ok(
    "lifetime: customer LTV is per-account revenue times the per-account life",
    ltv.headline === Math.round(perCust.headline! * accountLife.headline!),
  );

  // ── Concentration ─────────────────────────────────────────────────────────
  /**
   * The founder's question, and the two properties that make the answer readable: the bands
   * do not overlap, so they SUM to total MRR, and every running total is therefore a share
   * that cannot exceed 100%.
   */
  const conc = await cc("customer_concentration");
  const bandRows = conc.rows ?? [];
  const bandSum = bandRows.reduce((n, r) => n + r.value, 0);
  const shares = bandRows.map((_, i) =>
    Math.round((bandRows.slice(0, i + 1).reduce((n, r) => n + r.value, 0) / mrr.headline!) * 10000),
  );
  console.log(
    "concentration:",
    JSON.stringify({
      rows: bandRows.map((r) => [r.group, r.value]),
      cumulative_bps: shares,
    }),
  );
  ok(
    "concentration: six disjoint bands, answered as rows",
    bandRows.length === 6 && conc.points.length === 0,
  );
  ok("concentration: the bands sum to total MRR, exactly", bandSum === mrr.headline);
  ok("concentration: …and to the report's own headline", bandSum === conc.headline);
  ok(
    "concentration: no running total exceeds 100% — the top-N share is bounded",
    shares.every((b) => b <= 10000) && shares[shares.length - 1] === 10000,
  );
  ok(
    "concentration: the largest account is B's 20000, not the sum of A's three subscriptions",
    bandRows[0]?.value === 20000,
  );

  const top = await cc("top_customers_by_mrr");
  const topRows = top.rows ?? [];
  ok(
    "concentration: the named rows sum to total MRR too",
    topRows.reduce((n, r) => n + r.value, 0) === mrr.headline,
  );
  ok(
    "concentration: four accounts, largest first",
    topRows.length === 4 && topRows[0]?.value === 20000,
  );
  ok(
    "concentration: A appears ONCE, worth all three of its subscriptions",
    topRows.filter((r) => r.value === 15000).length === 1,
  );
  ok(
    "concentration: each row names the account it is",
    topRows.every((r) => r.group.length > 0),
  );

  const bands = await cc("customers_by_mrr_band");
  const bandCounts = bands.rows ?? [];
  console.log("mrr bands:", JSON.stringify(bandCounts.map((r) => [r.group, r.value])));
  ok(
    "bands: every account lands in exactly one band — they sum to the account count",
    bandCounts.reduce((n, r) => n + r.value, 0) === activeCust.headline,
  );
  ok(
    "bands: the label names the currency the edges are in",
    bandCounts.some((r) => r.group.includes("USD")),
  );

  // ── Churn, at account grain ───────────────────────────────────────────────
  // Four subscriptions were cancelled; three ACCOUNTS were lost. The gap is E, which lost
  // two subscriptions and one account.
  const cancels = await cc("total_subscription_churn");
  const lost = await cc("total_churned_customers");
  ok(
    "churn: four cancelled subscriptions are THREE lost accounts",
    cancels.headline === 4 && lost.headline === 3,
  );
  /**
   * The rate's base is the book as the window OPENED, so it is only the accounts we had to
   * lose. Over 3 months: G and F were already on the book, F went — 50%. E's own churn is
   * out of both halves, because E was not on the book when the window opened.
   */
  const rate3m = await cc("customer_churn_rate", { range: "3m" });
  console.log("customer churn rate:", JSON.stringify({ bps: rate3m.headline }));
  ok(
    "churn: the rate divides by the accounts the window OPENED with — 1 of 2",
    rate3m.headline === 5000,
  );
  // A rate with no base is null, never 0: over 12 months nothing was on the book when the
  // window opened, and 0% would claim every account was kept.
  const rate12m = await cc("customer_churn_rate", { range: "12m" });
  ok("churn: no base, no rate — null rather than 0%", rate12m.headline === null);

  // ── Reachability ──────────────────────────────────────────────────────────
  // A declaration nothing can resolve is worse than a missing one, and the catalogue's
  // promise is that every key answers in the same envelope.
  const CUSTOMER_GRAIN = [
    "total_new_customers",
    "total_churned_customers",
    "total_customers_with_movement",
    "customer_churn_rate",
    "total_active_customers",
    "total_paying_customers",
    "average_subscriptions_per_customer",
    "average_revenue_per_paying_customer",
    "average_customer_lifetime",
    "lifetime_value_of_a_customer",
    "customer_concentration",
    "top_customers_by_mrr",
    "customers_by_mrr_band",
    "total_signups",
  ];
  ok(
    "catalogue: every customer-grain key is declared",
    CUSTOMER_GRAIN.every((k) => REPORT_BY_KEY.has(k)),
  );
  const answers = await Promise.all(CUSTOMER_GRAIN.map((k) => cc(k)));
  ok(
    "catalogue: every one of them answers in the uniform envelope",
    answers.every(
      (r) => r.object === "report" && Array.isArray(r.points) && typeof r.currency === "string",
    ),
  );
  // They are findable the way a reader looks for them: the `customers` chip.
  ok(
    "catalogue: every customer-grain report carries the customers tag",
    CUSTOMER_GRAIN.every((k) => (REPORT_BY_KEY.get(k)!.tags ?? []).includes("customers")),
  );
  /**
   * ⚠️ A distinct count does not sum across buckets: a customer who moved in March and
   * again in April is ONE customer in the window and one in each of two points. The window
   * figure is the one to read, and this pins that the two genuinely differ rather than
   * letting a reader discover it by adding the columns up.
   */
  const moved = await cc("total_customers_with_movement", { range: "3m" });
  ok(
    "grain: a distinct count is NOT the sum of its buckets — the window figure is the one to read",
    moved.headline! <= moved.points.reduce((n, p) => n + p.v, 0),
  );
}

// ── Slicing a report by a customer ATTRIBUTE (4c) ────────────────────────────
/**
 * Two names, kept apart on purpose. `list_views` owns "segment" for a saved filter set over
 * a LIST; what is built here is a **customer filter** — a predicate over the customers a
 * metric is computed from — answered over stored **dimensions**. One word for both would
 * make it impossible to tell which one a screen means.
 *
 * The properties this section pins:
 *  - Σ over every value of a dimension = the unsliced figure, EXACTLY, for a flow AND for a
 *    stock, with the Unknown bucket (no country on file) carrying its share.
 *  - a predicate the stored dimensions cannot express is REFUSED by name, never answered
 *    slowly — the whole reason the dimension is stored rather than the filter.
 *  - a sliced STOCK reads the stored rows. A check on the number alone would pass on the
 *    rebuild too, so the path taken is counted.
 *
 * Its own business, single-currency, so the identity is exact rather than exact-to-rounding
 * across two FX conversions.
 */
{
  const geoBiz = await createBusiness({
    organizationId: orgId,
    name: "Geo Biz",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "Asia/Kolkata",
  });
  const geoProduct = await createProduct({
    organizationId: orgId,
    businessId: geoBiz.id,
    name: "Geo Plan",
  });
  const geoPrice = await createPrice({
    organizationId: orgId,
    businessId: geoBiz.id,
    productId: geoProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const geoSub = async (country: string | null) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: geoBiz.id,
      email: `geo${Math.random()}@a.com`,
      ...(country ? { address: { country } } : {}),
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: geoBiz.id,
      customer: c,
      token: "tok_4242",
    });
    return (
      await createSubscription({
        organizationId: orgId,
        businessId: geoBiz.id,
        customerId: c.id,
        now: new Date(),
        items: [{ price: geoPrice, quantity: 1 }],
      })
    ).subscription;
  };
  // Book: 2 × DE, 1 × FR, and one customer with NO country on file — the bucket the
  // identity below is false without.
  await geoSub("DE");
  await geoSub("DE");
  await geoSub("FR");
  await geoSub(null);

  const geo = (key: string, opts: Parameters<typeof resolveReport>[3] = {}) =>
    resolveReport(orgId, geoBiz.id, key, { currency: "USD", now: new Date(), ...opts });

  // ── A FLOW: joined to the customer at read time, no stored dimension needed ──
  {
    const total = await geo("total_new_mrr", { range: "daily" });
    const split = await geo("total_new_mrr", { range: "daily", groupBy: "country" });
    const rows = split.rows ?? [];
    console.log("flow by country:", JSON.stringify(rows));
    ok("flow: a country breakdown is returned", rows.length === 3);
    ok(
      "flow: the customer with no country is an Unknown ROW, not a dropped movement",
      rows.some((r) => r.group === "Unknown" && r.group_id === null && r.value === 5000),
    );
    ok(
      "flow: DE carries both of its sales",
      rows.find((r) => r.group_id === "DE")?.value === 10000,
    );
    ok(
      "Σ segments = total (flow): the country rows sum to the unsliced headline, EXACTLY",
      rows.reduce((n, r) => n + r.value, 0) === total.headline,
    );

    // The same figures, for customers in Germany — the question that had no answer.
    const de = await geo("total_new_mrr", { range: "daily", customerFilter: "country:DE" });
    ok(
      "filter: a flow narrowed to one country answers that country's figure",
      de.headline === 10000,
    );
    ok("filter: …and echoes the filter it was narrowed by", de.customer_filter === "country:DE");
    const unknown = await geo("total_new_mrr", {
      range: "daily",
      customerFilter: "country:unknown",
    });
    ok("filter: the Unknown bucket is addressable, not just visible", unknown.headline === 5000);
    const all = await geo("total_new_mrr", {
      range: "daily",
      customerFilter: "country:DE,FR,unknown",
    });
    ok(
      "Σ segments = total (flow, via the filter): every value together = the unsliced figure",
      all.headline === total.headline,
    );
  }

  // ── A STOCK: summed from the stored rows, never rebuilt per slice ────────────
  {
    // The stored day the read is supposed to use — today, because the fixture was created
    // now; the 5-minute pass writes today in the product.
    const today = utcDayString(new Date());
    const dayRows = await withTenant(orgId, (tx) =>
      computeMetricPeriod(tx, geoBiz.id, "day", today, new Date(), {
        timezone: "UTC",
        measures: new Set(["mrr"]),
      }),
    );
    await writeMetricDay({
      organizationId: orgId,
      businessId: geoBiz.id,
      grain: "day",
      periodEnd: today,
      rows: dayRows,
    });
    ok(
      "stock: the day's per-country rows are stored (DE, FR, Unknown)",
      dayRows.filter((r) => r.measure === "mrr" && r.dim === "country").length === 3,
    );

    const total = await geo("total_mrr", { range: "daily" });
    resetCountryStockPath();
    const split = await geo("total_mrr", { range: "daily", groupBy: "country" });
    const rows = split.rows ?? [];
    console.log("stock by country:", JSON.stringify(rows));
    ok("stock: a country breakdown is returned", rows.length === 3);
    ok(
      "stock: the Unknown bucket appears, or the slice stops summing to the book",
      rows.some((r) => r.group === "Unknown" && r.value === 5000),
    );
    ok(
      "Σ segments = total (stock): the country rows sum to the unsliced headline, EXACTLY",
      rows.reduce((n, r) => n + r.value, 0) === total.headline,
    );
    /**
     * The check the number alone cannot make. A sliced stock that rebuilt the book per
     * bucket would report the same figures and cost what the snapshots exist to avoid, so
     * the path taken is counted: every read served from a stored row, none rebuilt.
     */
    ok(
      "stock: the sliced read is served from stored rows",
      countryStockPath.fromSnapshot > 0 && countryStockPath.reconstructed === 0,
    );

    const de = await geo("total_mrr", { range: "daily", customerFilter: "country:DE" });
    ok(
      "filter: a stock narrowed to one country reads that country's stored rows",
      de.headline === 10000,
    );
    const all = await geo("total_mrr", {
      range: "daily",
      customerFilter: "country:DE,FR,unknown",
    });
    ok(
      "Σ segments = total (stock, via the filter): every value together = the unsliced figure",
      all.headline === total.headline,
    );
  }

  // ── What is refused, and why it says so ─────────────────────────────────────
  {
    const refusal = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return null;
      } catch (e) {
        return e instanceof ReportError ? e.message : null;
      }
    };

    // A predicate over an attribute we do not store is refused BY NAME — never answered by
    // rebuilding the book per slice, which is slowest on the book big enough to need it.
    const m1 = await refusal(() =>
      geo("total_new_mrr", { range: "daily", customerFilter: "signup_source:ads" }),
    );
    ok(
      "refusal: an inexpressible predicate names the field and the dimensions that exist",
      m1 != null && m1.includes("signup_source") && m1.includes("country"),
    );

    // Declared per report: CMRR has no stored country dimension, so it refuses rather than
    // answering from a table that does not hold it.
    const m2 = await refusal(() => geo("total_cmrr", { customerFilter: "country:DE" }));
    ok(
      "refusal: a report with no stored country dimension says so by name",
      m2 != null && m2.includes("country"),
    );
    const m3 = await refusal(() => geo("total_cmrr", { groupBy: "country" }));
    ok(
      "refusal: group_by names the cut asked for, not just the ones on offer",
      m3 != null && m3.includes("country"),
    );
    const m4 = await refusal(() =>
      geo("total_new_mrr", { range: "daily", customerFilter: "country" }),
    );
    ok("refusal: a malformed filter is refused with its shape spelled out", m4 != null);
  }

  // The catalogue declares the dimension only where it can honour it.
  ok(
    "registry: country is declared only on movement flows and the stocks the table stores",
    REPORTS.filter((r) => r.dimensions.includes("country")).every(
      (r) =>
        (r.source === "movement" && r.shape === "flow" && r.customers == null) ||
        (r.source === "stock" && r.measure !== "cmrr"),
    ),
  );
}

// ── FX: the rate's share of a converted move, and the promise not to restate ──
//
// A converted total moves for two reasons a reader cannot otherwise tell apart: the book
// changed, or the rate did. 42% of subscriptions on the measured book are in a currency
// other than the business default, so on a mixed book that ambiguity is most of the
// movement. The waterfall's FX column separates them — and the FIRST thing checked here is
// that adding it changed no figure that already existed.
{
  const fxOrg = await createOrganization({ name: "FX Org" });
  const fxOrgId = fxOrg.organization.id;
  const fxBiz = await createBusiness({
    organizationId: fxOrgId,
    name: "FX Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const fxProduct = await createProduct({
    organizationId: fxOrgId,
    businessId: fxBiz.id,
    name: "FX Plans",
  });
  const fxPrice = (currency: string, amountMinor: number) =>
    createPrice({
      organizationId: fxOrgId,
      businessId: fxBiz.id,
      productId: fxProduct.id,
      type: "recurring",
      model: "flat",
      currency,
      amountMinor,
      interval: "month",
    });
  const fxSub = async (currency: string, amountMinor: number, at: Date) => {
    const c = await createCustomer({
      organizationId: fxOrgId,
      businessId: fxBiz.id,
      email: `fx${Math.random()}@a.com`,
    });
    await vaultPaymentMethod({
      organizationId: fxOrgId,
      businessId: fxBiz.id,
      customer: c,
      token: "tok_4242",
    });
    return (
      await createSubscription({
        organizationId: fxOrgId,
        businessId: fxBiz.id,
        customerId: c.id,
        now: at,
        items: [{ price: await fxPrice(currency, amountMinor), quantity: 1 }],
      })
    ).subscription;
  };

  const MONTH_NAMES = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const addMonths = (d: Date, n: number) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const thisMonthStart = monthStart(now);

  // The book: one subscription per currency, all opened two months ago so every one of them
  // is in the OPENING balance of the month a rate later moves in.
  //   USD 100.00 — the reporting currency, which no rate can move
  //   EUR 100.00 — the one with a rate
  //   GBP 100.00 — NO rate configured, which must exclude it rather than count it at par
  const twoMonthsAgo = new Date(addMonths(thisMonthStart, -2).getTime() + 36e5);
  await fxSub("USD", 10000, twoMonthsAgo);
  await fxSub("EUR", 10000, twoMonthsAgo);
  await fxSub("GBP", 10000, twoMonthsAgo);
  await updateBusiness(fxOrgId, fxBiz.publicId, { exchangeRates: { EUR: 0.9 } });

  const fxRun = (key: string) => resolveReport(fxOrgId, fxBiz.id, key, { currency: "ALL", now });

  /**
   * The waterfall as it was BEFORE any of this: every instant converted at the CURRENT
   * rate, which is what `convert` has always done. Computed here from the ledger rather
   * than from another reading of the report, so the comparison is against the arithmetic,
   * not against itself.
   *
   * The fixture has no trials and no plan changes, so a movement's column is its reason.
   */
  const controlWaterfall = async (rates: Record<string, number>) => {
    const rows = await withTenant(fxOrgId, (tx) =>
      tx
        .select({
          reason: mrrMovements.reason,
          currency: mrrMovements.currency,
          deltaMinor: mrrMovements.deltaMinor,
          occurredAt: mrrMovements.occurredAt,
        })
        .from(mrrMovements)
        .where(eq(mrrMovements.businessId, fxBiz.id)),
    );
    const conv = (minor: number, ccy: string): number | null => {
      if (ccy.toUpperCase() === "USD") return minor;
      const r = rates[ccy.toUpperCase()];
      return r != null && r > 0 ? Math.round(minor / r) : null;
    };
    const columnOf = (reason: string) =>
      reason === "resume"
        ? "resumed"
        : reason === "pause"
          ? "paused"
          : ["new", "expansion", "contraction", "reactivation"].includes(reason)
            ? reason
            : "churn";
    const out: Array<{
      period: string;
      opening: number;
      closing: number;
      cols: Map<string, number>;
    }> = [];
    for (let i = 0; i < 12; i++) {
      const start = addMonths(thisMonthStart, -i);
      const end = addMonths(start, 1);
      const closeAt = new Date(Math.min(end.getTime() - 1, now.getTime()));
      const stock = (at: Date) =>
        rows.reduce(
          (n, m) => (m.occurredAt > at ? n : n + (conv(Number(m.deltaMinor), m.currency) ?? 0)),
          0,
        );
      const cols = new Map<string, number>();
      for (const m of rows) {
        if (m.occurredAt < start || m.occurredAt > closeAt) continue;
        const v = conv(Math.abs(Number(m.deltaMinor)), m.currency);
        if (v == null) continue;
        const k = columnOf(m.reason);
        cols.set(k, (cols.get(k) ?? 0) + v);
      }
      out.push({
        period: `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
        opening: stock(new Date(start.getTime() - 1)),
        closing: stock(closeAt),
        cols,
      });
    }
    return out;
  };

  // ── 1. No restatement ──────────────────────────────────────────────────────
  // History is EMPTY at this point, so every instant falls back to the current rate. Take
  // the table, seed the history from those same current rates, take it again: the two must
  // be identical, digit for digit, or seeding the log repriced the past.
  const before = (await fxRun("mrr_movement_summary")).table!;
  const seeded = await withTenant(fxOrgId, (tx) =>
    recordExchangeRateObservations(tx, { organizationId: fxOrgId, businessId: fxBiz.id }),
  );
  ok("fx: seeding the history records the rates standing now", seeded === 0 || seeded === 1);
  const seededRows = await withTenant(fxOrgId, (tx) =>
    tx
      .select({ currency: exchangeRateHistory.currency, rate: exchangeRateHistory.rate })
      .from(exchangeRateHistory)
      .where(eq(exchangeRateHistory.businessId, fxBiz.id)),
  );
  ok(
    "fx: the seeded observation is EUR at the rate the business holds now",
    seededRows.length === 1 &&
      seededRows[0]!.currency === "EUR" &&
      Number(seededRows[0]!.rate) === 0.9,
  );

  const after = (await fxRun("mrr_movement_summary")).table!;
  ok(
    "fx: seeding the rate history restates NOTHING — the waterfall is byte-identical",
    JSON.stringify(before.rows) === JSON.stringify(after.rows),
  );

  // …and both agree with the arithmetic that was there before the column existed.
  const control = await controlWaterfall({ EUR: 0.9 });
  const at = (key: string) => after.columns.findIndex((c) => c.key === key);
  const mismatches = after.rows.filter((r, i) => {
    const c = control[i]!;
    if (r.values[at("opening")] !== c.opening) return true;
    if (r.values[at("closing")] !== c.closing) return true;
    for (const k of [
      "new",
      "expansion",
      "contraction",
      "reactivation",
      "resumed",
      "paused",
      "churn",
    ]) {
      if ((r.values[at(k)] ?? 0) !== (c.cols.get(k) ?? 0)) return true;
    }
    return false;
  });
  for (const m of mismatches) console.log("  ↳ restated:", JSON.stringify(m));
  ok(
    "fx: every converted figure equals conversion at the CURRENT rate, computed independently",
    mismatches.length === 0,
  );
  ok(
    "fx: with no rate change, FX is zero on every row",
    after.rows.every((r) => r.values[at("fx")] === 0),
  );

  // A currency with no rate is EXCLUDED, not counted at parity: $100 USD + €100 at 0.9
  // ($111.11) and nothing for the GBP subscription.
  ok(
    "fx: a currency with no usable rate is excluded, never counted at par",
    after.rows[0]!.values[at("closing")] === 10000 + Math.round(10000 / 0.9),
  );

  // ── 2. The identity, across a real rate change ─────────────────────────────
  // EUR was 0.9 from before this book existed; it becomes 0.8 at the first instant of this
  // month. Nothing in the book moved this month, so every movement column is 0 and the
  // whole change in the converted total IS the rate.
  await withTenant(fxOrgId, (tx) =>
    tx.insert(exchangeRateHistory).values([
      {
        organizationId: fxOrgId,
        businessId: fxBiz.id,
        currency: "EUR",
        baseCurrency: "USD",
        rate: "0.9",
        effectiveFrom: addMonths(thisMonthStart, -6),
      },
      {
        organizationId: fxOrgId,
        businessId: fxBiz.id,
        currency: "EUR",
        baseCurrency: "USD",
        rate: "0.8",
        effectiveFrom: thisMonthStart,
      },
    ]),
  );
  const moved = (await fxRun("mrr_movement_summary")).table!;
  const row0 = moved.rows[0]!;
  const openEur = Math.round(10000 / 0.9);
  const closeEur = Math.round(10000 / 0.8);
  console.log(
    "fx waterfall:",
    JSON.stringify({
      opening: row0.values[at("opening")],
      fx: row0.values[at("fx")],
      net: row0.values[at("net")],
      closing: row0.values[at("closing")],
    }),
  );
  ok(
    "fx: opening converts at the rate in force then, closing at the rate in force now",
    row0.values[at("opening")] === 10000 + openEur &&
      row0.values[at("closing")] === 10000 + closeEur,
  );
  ok(
    "fx: the FX column is exactly what the rate did — the USD subscription contributes none",
    row0.values[at("fx")] === closeEur - openEur,
  );
  ok(
    "fx: opening + every flow + FX = closing, EXACTLY, across a rate change",
    moved.rows.every(
      (r) =>
        r.values[at("opening")]! + r.values[at("net")]! + r.values[at("fx")]! ===
        r.values[at("closing")]!,
    ),
  );
  // The month before the change saw no rate move, so its FX must be silent — otherwise the
  // column would smear one month's rate change across the whole table.
  ok(
    "fx: a period with no rate change still reads zero",
    moved.rows.slice(1).every((r) => r.values[at("fx")] === 0),
  );
  // Scoped to one currency there is no conversion at all, so there is nothing for a rate to
  // move: the FX column must be silent rather than reporting on a book it did not convert.
  const scoped = (
    await resolveReport(fxOrgId, fxBiz.id, "mrr_movement_summary", { currency: "EUR", now })
  ).table!;
  ok(
    "fx: a single-currency report converts nothing, so FX is zero",
    scoped.rows.every((r) => r.values[at("fx")] === 0),
  );
}

// ── Leakage on a multi-currency book ─────────────────────────────────────────
// `invoice_line_discounts` carries no currency of its own — the amount is in the INVOICE's
// currency. Summed raw, paise land in the same total as cents, and a currency filter that
// is never applied looks exactly like one that is. A single-currency fixture cannot see
// either: converting and not converting give the same answer when everything is already in
// the reporting currency. This book is three currencies, one of them with no rate at all.
{
  const lkOrg = await createOrganization({ name: "Leakage Org" });
  const lkOrgId = lkOrg.organization.id;
  const lkBiz = await createBusiness({
    organizationId: lkOrgId,
    name: "Leakage Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const lkProduct = await createProduct({
    organizationId: lkOrgId,
    businessId: lkBiz.id,
    name: "Leakage Plans",
  });
  // Non-integer on purpose: a round rate hides per-row rounding, which is the whole
  // difference between the summary and the headline variant. No GBP rate — deliberate.
  const INR_RATE = 83.5;
  await updateBusiness(lkOrgId, lkBiz.publicId, { exchangeRates: { INR: INR_RATE } });

  // One subscription per currency, 10% off forever, billed once so the discount is written
  // to `invoice_line_discounts` by the real path rather than inserted by hand.
  const lkDiscounted = async (currency: string, amountMinor: number, code: string) => {
    const price = await createPrice({
      organizationId: lkOrgId,
      businessId: lkBiz.id,
      productId: lkProduct.id,
      type: "recurring",
      model: "flat",
      currency,
      amountMinor,
      interval: "month",
    });
    const customer = await createCustomer({
      organizationId: lkOrgId,
      businessId: lkBiz.id,
      email: `lk${Math.random()}@a.com`,
    });
    await vaultPaymentMethod({
      organizationId: lkOrgId,
      businessId: lkBiz.id,
      customer,
      token: "tok_4242",
    });
    const created = await createSubscription({
      organizationId: lkOrgId,
      businessId: lkBiz.id,
      customerId: customer.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    });
    await createCoupon({
      organizationId: lkOrgId,
      businessId: lkBiz.id,
      code,
      kind: "percentage",
      percentOffBps: 1000,
      durationType: "forever",
    });
    await applyCouponToSubscription({
      organizationId: lkOrgId,
      businessId: lkBiz.id,
      subscriptionId: created.subscription.id,
      code,
      now: new Date(),
    });
    // Bill the NEXT period, as a renewal does — billing the period again would ask the
    // engine to re-invoice what it has already invoiced.
    const fresh = await withTenant(lkOrgId, async (tx) => {
      const [cur] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, created.subscription.id))
        .limit(1);
      const start = cur!.currentPeriodEnd!;
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      const [advanced] = await tx
        .update(subscriptions)
        .set({ currentPeriodStart: start, currentPeriodEnd: end })
        .where(eq(subscriptions.id, created.subscription.id))
        .returning();
      return advanced!;
    });
    await billSubscriptionPeriod({
      organizationId: lkOrgId,
      businessId: lkBiz.id,
      subscription: fresh,
      periodStart: fresh.currentPeriodStart!,
      periodEnd: fresh.currentPeriodEnd!,
    });
  };
  await lkDiscounted("USD", 10000, "LKUSD10"); // $100.00 → $10.00 off
  await lkDiscounted("INR", 800000, "LKINR10"); // ₹8,000.00 → ₹800.00 off
  await lkDiscounted("GBP", 50000, "LKGBP10"); // £500.00 → £50.00 off, and NO GBP rate

  // The raw book, read independently of the resolver.
  const lkRows = await withTenant(lkOrgId, (tx) =>
    tx
      .select({ amountMinor: invoiceLineDiscounts.amountMinor, currency: invoices.currency })
      .from(invoiceLineDiscounts)
      .innerJoin(invoices, eq(invoiceLineDiscounts.invoiceId, invoices.id))
      .where(eq(invoiceLineDiscounts.businessId, lkBiz.id)),
  );
  const rawIn = (c: string) =>
    lkRows.filter((r) => r.currency === c).reduce((n, r) => n + Number(r.amountMinor), 0);
  const rawAll = lkRows.reduce((n, r) => n + Number(r.amountMinor), 0);
  // Converted the way the resolver must: row by row, GBP dropped for want of a rate.
  const lkConv = (r: (typeof lkRows)[number]): number | null =>
    r.currency === "USD"
      ? Number(r.amountMinor)
      : r.currency === "INR"
        ? Math.round(Number(r.amountMinor) / INR_RATE)
        : null;
  const lkExpected = lkRows.reduce((n, r) => n + (lkConv(r) ?? 0), 0);
  const lkRun = (currency: string) =>
    resolveReport(lkOrgId, lkBiz.id, "revenue_leakage_summary", { currency, now: new Date() });
  const lkAll = await lkRun("ALL");
  console.log(
    "leakage:",
    JSON.stringify({
      rawAll,
      usd: rawIn("USD"),
      inr: rawIn("INR"),
      gbp: rawIn("GBP"),
      all: lkAll.headline,
      expected: lkExpected,
    }),
  );

  ok(
    "leakage: the fixture really is multi-currency, with money in a currency that has no rate",
    rawIn("USD") > 0 && rawIn("INR") > 0 && rawIn("GBP") > 0,
  );
  // Summed raw this would be paise added to cents. The inequality is the check that a
  // conversion happened at all; the equality says it is the RIGHT conversion.
  ok("leakage: the summary is NOT the raw cross-currency sum", lkAll.headline !== rawAll);
  ok(
    "leakage: every discount is converted from its invoice's currency",
    lkAll.headline === lkExpected,
  );
  // The GBP discount must not appear at all — not at par, not raw, not as a group of its
  // own. A headline check alone would let it hide behind a coincidence of sums.
  console.log("leakage rows:", JSON.stringify(lkAll.rows));
  ok(
    "leakage: an amount in a currency with no rate is excluded, never counted raw",
    lkAll.rows!.length === 2 &&
      lkAll.rows!.every((r) => r.value !== rawIn("GBP")) &&
      lkAll.headline !== lkExpected + rawIn("GBP"),
  );
  // Scoped, the report answers in that currency and converts nothing — so each answer is
  // the raw sum of exactly that currency's rows, and nothing else's.
  for (const c of ["USD", "INR", "GBP"] as const) {
    ok(
      `leakage: currency=${c} returns only the money actually in ${c}`,
      (await lkRun(c)).headline === rawIn(c),
    );
  }

  // The summary and the headline variant read the same money by different routes: the
  // summary converts each discount ROW, `total_revenue_leakage` converts each INVOICE's
  // discount total. Per-row rounding therefore costs at most one minor unit per converted
  // row — anything beyond that is a real divergence, not rounding.
  const lkTotal = await resolveReport(lkOrgId, lkBiz.id, "total_revenue_leakage", {
    currency: "ALL",
    now: new Date(),
  });
  const lkTolerance = lkRows.filter((r) => lkConv(r) != null).length;
  console.log(
    "leakage: summary vs headline:",
    JSON.stringify({
      summary: lkAll.headline,
      total: lkTotal.headline,
      tolerance: lkTolerance,
    }),
  );
  ok(
    "leakage: the summary agrees with total_revenue_leakage within per-row rounding",
    lkAll.headline != null &&
      lkTotal.headline != null &&
      Math.abs(lkAll.headline - lkTotal.headline) <= lkTolerance,
  );
}

// ── The ageing ladder is NET OF CASH (F-18) ──────────────────────────────────
// `amount_due_minor` is the issue-time collectible and is never decremented as cash lands,
// so an ageing ladder that sums it raw reports settled invoices as still owed. Business Home
// already nets; the report did not, and the two screens disagreed by every payment ever
// applied. The oracle is Business Home's own unpaid-invoices figure — one definition of
// outstanding, asserted to hold on a book that actually has part-payments on it.
{
  const DAY_MS = 86_400_000;
  const before = await run("total_receivables");
  const rungOf = (r: { rows?: Array<{ group: string; value: number }> }, label: string) =>
    r.rows?.find((x) => x.group === label)?.value ?? 0;

  const payer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "ar-net@example.test",
  });
  let arSeq = 0;
  const seedInvoice = async (i: {
    status: string;
    totalMinor: number;
    overdueDays: number;
    paid?: { amountMinor: number; status: string };
  }) => {
    const id = await withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(invoices)
        .values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: payer.id,
          publicId: `inv_arnet_${++arSeq}_${Date.now()}`,
          status: i.status,
          currency: "USD",
          subtotalMinor: BigInt(i.totalMinor),
          totalMinor: BigInt(i.totalMinor),
          amountDueMinor: BigInt(i.totalMinor),
          dueDate: new Date(now.getTime() - i.overdueDays * DAY_MS),
        })
        .returning({ id: invoices.id });
      if (i.paid) {
        await tx.insert(payments).values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: payer.id,
          invoiceId: row!.id,
          publicId: `pay_arnet_${++arSeq}_${Date.now()}`,
          status: i.paid.status,
          amountMinor: BigInt(i.paid.amountMinor),
          currency: "USD",
          providerKey: "offline",
        });
      }
      return row!.id;
    });
    return id;
  };

  // Part-paid: $100 billed, $40 collected, 45 days overdue. Still owes $60 on the 31–60 rung.
  await seedInvoice({
    status: "payment_due",
    totalMinor: 10_000,
    overdueDays: 45,
    paid: { amountMinor: 4_000, status: "succeeded" },
  });
  // Settled in full but the status row never moved. Not receivable, whatever it says.
  await seedInvoice({
    status: "not_paid",
    totalMinor: 5_000,
    overdueDays: 10,
    paid: { amountMinor: 5_000, status: "succeeded" },
  });
  // A FAILED payment collects nothing: the whole $30 is still owed, on the 1–30 rung.
  await seedInvoice({
    status: "posted",
    totalMinor: 3_000,
    overdueDays: 10,
    paid: { amountMinor: 3_000, status: "failed" },
  });
  // Overpaid by $5. Floored at zero — an overpayment is not negative receivables.
  await seedInvoice({
    status: "payment_due",
    totalMinor: 2_000,
    overdueDays: 10,
    paid: { amountMinor: 2_500, status: "succeeded" },
  });

  const after = await run("total_receivables");
  const GROSS = 10_000 + 5_000 + 3_000 + 2_000;
  const NET = 6_000 + 0 + 3_000 + 0;
  ok(
    `ar net: the four invoices add ${NET} to the ladder, not the ${GROSS} their amount_due says (${(after.headline ?? 0) - (before.headline ?? 0)})`,
    (after.headline ?? 0) - (before.headline ?? 0) === NET,
  );
  ok(
    `ar net: the part-paid invoice sits on 31–60 days at its remaining $60 (${rungOf(after, "31–60 days") - rungOf(before, "31–60 days")})`,
    rungOf(after, "31–60 days") - rungOf(before, "31–60 days") === 6_000,
  );
  ok(
    `ar net: a FAILED payment collects nothing — the 1–30 rung still carries the whole $30 (${rungOf(after, "1–30 days") - rungOf(before, "1–30 days")})`,
    rungOf(after, "1–30 days") - rungOf(before, "1–30 days") === 3_000,
  );
  ok(
    "ar net: a settled invoice and an overpaid one contribute nothing, and nothing goes negative",
    (after.rows ?? []).every((r) => r.value >= 0),
  );
  ok(
    "ar net: the rungs still sum to the headline",
    (after.rows ?? []).reduce((n, r) => n + r.value, 0) === after.headline,
  );

  // The oracle. Business Home nets applied cash; the ladder must say the same number.
  const home = await computeBusinessAnalytics(orgId, biz.id, {
    range: "12m",
    currency: "USD",
    now,
  });
  ok(
    `ar net: the ladder agrees with the unpaid-invoices KPI on a part-paid book (${after.headline} vs ${home.kpis.unpaid_invoices.amount_minor})`,
    after.headline === home.kpis.unpaid_invoices.amount_minor,
  );
  ok(
    "ar net: …and that agreement is worth something — the KPI is below the gross collectible",
    home.kpis.unpaid_invoices.amount_minor < (before.headline ?? 0) + GROSS,
  );

  // A rebuilt ladder is the same money, re-rung: the interval is a read-time parameter, and
  // netting must not have become a property of one rung width.
  for (const interval of ["7", "30", "60"] as const) {
    const re = await run("total_receivables", { agingInterval: interval });
    ok(
      `ar net: the ${interval}-day ladder nets to the same total (${re.headline})`,
      re.headline === after.headline,
    );
  }
}

// ── A past bucket is rated at the rate it CARRIED, whichever arm answers ─────
//
// `subscriptions.mrr` is 0 once a row is cancelled, so a reconstruction that summed the
// column charged every past bucket for a churn that happened after it: last year's MRR fell
// when something churned today, and the fall was invisible wherever the stored arms answered.
// This is the file's own contract made checkable — an incomplete cache may make a read
// slower, never change its answer — so the two arms are asked the SAME day and must return
// one number.
{
  const armBiz = await createBusiness({
    organizationId: orgId,
    name: "Arms Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const armProduct = await createProduct({
    organizationId: orgId,
    businessId: armBiz.id,
    name: "Arms Plan",
  });
  const armPrice = await createPrice({
    organizationId: orgId,
    businessId: armBiz.id,
    productId: armProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const DAY = 86_400_000;
  const startedAt = new Date(Date.now() - 120 * DAY);
  const churnedAt = new Date(Date.now() - 20 * DAY);
  /** The day both arms can answer: after the start, before the churn. */
  const day = new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10);
  const at = endOfDay(day);

  const armSub = async (comped: boolean) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: armBiz.id,
      email: `arm${Math.random()}@a.com`,
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: armBiz.id,
      customer: c,
      token: "tok_4242",
    });
    const s = (
      await createSubscription({
        organizationId: orgId,
        businessId: armBiz.id,
        customerId: c.id,
        // Created ON its start, so the engine dates the ledger there too: a row backdated
        // after the fact has a ledger that says it started today.
        now: startedAt,
        items: [{ price: armPrice, quantity: 1 }],
      })
    ).subscription;
    // Park the term so a live worker never renews a subscription dated months back.
    await withTenant(orgId, (tx) =>
      tx
        .update(subscriptions)
        .set({ currentPeriodEnd: new Date(Date.now() + 365 * DAY) })
        .where(eq(subscriptions.id, s.id)),
    );
    if (comped) {
      // Worth nothing while it was earning — the case a re-rate from the surviving items
      // gets wrong, because the discount does not survive the cancellation.
      const code = `ARMFREE${Math.floor(Math.random() * 1e6)}`;
      await createCoupon({
        organizationId: orgId,
        businessId: armBiz.id,
        code,
        kind: "percentage",
        percentOffBps: 10000,
        durationType: "forever",
      });
      await applyCouponToSubscription({
        organizationId: orgId,
        businessId: armBiz.id,
        subscriptionId: s.id,
        code,
        now: startedAt,
      });
    }
    await withTenant(orgId, (tx) =>
      tx
        .update(subscriptions)
        .set({ createdAt: startedAt, startDate: startedAt, startedAt })
        .where(eq(subscriptions.id, s.id)),
    );
    await cancelSubscription({
      organizationId: orgId,
      businessId: armBiz.id,
      subscriptionId: s.id,
      atPeriodEnd: false,
      now: churnedAt,
    });
    await withTenant(orgId, (tx) =>
      tx.update(subscriptions).set({ canceledAt: churnedAt }).where(eq(subscriptions.id, s.id)),
    );
    return s.id;
  };
  const payerId = await armSub(false);
  const compedId = await armSub(true);
  // The discount does not outlive the account it was on — true of an imported book, and the
  // reason re-rating a churned row from its surviving items reports a comped account at its
  // list price. The rate it was recorded with while earning is the only honest source.
  await withTenant(orgId, (tx) =>
    tx
      .update(appliedCoupons)
      .set({ status: "removed" })
      .where(eq(appliedCoupons.subscriptionId, compedId)),
  );

  const stateOf = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select({
            mrr: subscriptions.mrr,
            lastEarningMrr: subscriptions.lastEarningMrr,
            status: subscriptions.status,
          })
          .from(subscriptions)
          .where(eq(subscriptions.id, id)),
      )
    )[0]!;
  const payer = await stateOf(payerId);
  const comped = await stateOf(compedId);
  ok(
    "history fixture: both rows churned, and the column they used to be summed from is 0",
    payer.status === "cancelled" && comped.status === "cancelled" && Number(payer.mrr) === 0,
  );
  ok(
    `history fixture: the payer's earning rate is recorded (${payer.lastEarningMrr}), and the comped one's is a real zero (${comped.lastEarningMrr})`,
    Number(payer.lastEarningMrr) === 5000 && Number(comped.lastEarningMrr) === 0,
  );

  const arm = (key: string) => resolveReport(orgId, armBiz.id, key, { currency: "USD", now: at });

  // ── The common case in production: nothing stored for this business at all ──
  resetStockPath();
  const rebuiltMrr = await arm("total_mrr");
  const rebuiltPaid = await arm("total_active_paid_subscriptions");
  console.log(
    `arms: rebuilt ${day} → mrr=${rebuiltMrr.headline} paid=${rebuiltPaid.headline} (store hits ${stockPath.fromStore}, book loads ${stockPath.bookLoads})`,
  );
  ok(
    "history: with nothing stored, the day is answered by the reconstruction alone",
    stockPath.fromStore === 0 && stockPath.bookLoads > 0,
  );
  /**
   * 5000, and only 5000, pins all three failures at once: 0 is the churn-zeroed column,
   * 10000 is the comped row re-rated to its list price, 5000 is what the book was worth.
   */
  ok(
    `history: a churned payer still carries its rate on a past day, and a churned comped account carries nothing (${rebuiltMrr.headline})`,
    rebuiltMrr.headline === 5000,
  );
  ok(
    "history: …and the paid COUNT says the same — one payer, the comped row not counted",
    rebuiltPaid.headline === 1,
  );
  /**
   * The customer denominator is reconstructed at every instant — no stored row can give it
   * back — so it is the one head count that must rate the past for itself.
   */
  const rebuiltArpc = await arm("average_revenue_per_paying_customer");
  ok(
    `history: revenue per paying customer counts the head that was paying then (${rebuiltArpc.headline})`,
    rebuiltArpc.headline === 5000,
  );

  // ── The same day, now stored: the cache may be slower, never different ──────
  const rows = await withTenant(orgId, (tx) => computeMetricPeriod(tx, armBiz.id, "day", day));
  await writeMetricDay({
    organizationId: orgId,
    businessId: armBiz.id,
    grain: "day",
    periodEnd: day,
    rows,
  });
  resetStockPath();
  const storedMrr = await arm("total_mrr");
  const storedPaid = await arm("total_active_paid_subscriptions");
  console.log(
    `arms: stored ${day} → mrr=${storedMrr.headline} paid=${storedPaid.headline} (store hits ${stockPath.fromStore})`,
  );
  ok("history: the stored day is now served from the semantic layer", stockPath.fromStore > 0);
  ok(
    `history: both arms return ONE figure for the same day (${storedMrr.headline} vs ${rebuiltMrr.headline})`,
    storedMrr.headline === rebuiltMrr.headline,
  );
  ok(
    `history: …and the same count (${storedPaid.headline} vs ${rebuiltPaid.headline})`,
    storedPaid.headline === rebuiltPaid.headline,
  );
}

// ── Retention: only the opening cohort moves it, on Business Home as in reports ─────
// Two lines open last month at 5000 each; one churns inside it. A third starts mid-month
// and churns too: it was never in the base, so GRR = NRR = 5000 / 10000 on both screens.
{
  const cBiz = await createBusiness({
    organizationId: orgId,
    name: "Cohort Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cProduct = await createProduct({
    organizationId: orgId,
    businessId: cBiz.id,
    name: "Cohort Plan",
  });
  const cPrice = await createPrice({
    organizationId: orgId,
    businessId: cBiz.id,
    productId: cProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const DAY = 86_400_000;
  const cNow = new Date();
  const monthStart = Date.UTC(cNow.getUTCFullYear(), cNow.getUTCMonth() - 1, 1);
  const line = async (start: number, churn: number | null) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: cBiz.id,
      email: `cohort${Math.random()}@example.com`,
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: cBiz.id,
      customer: c,
      token: "tok_4242",
    });
    const startedAt = new Date(start);
    const s = (
      await createSubscription({
        organizationId: orgId,
        businessId: cBiz.id,
        customerId: c.id,
        now: startedAt,
        items: [{ price: cPrice, quantity: 1 }],
      })
    ).subscription;
    await withTenant(orgId, (tx) =>
      tx
        .update(subscriptions)
        .set({
          createdAt: startedAt,
          startDate: startedAt,
          startedAt,
          currentPeriodEnd: new Date(cNow.getTime() + 365 * DAY),
        })
        .where(eq(subscriptions.id, s.id)),
    );
    if (churn != null) {
      const churnedAt = new Date(churn);
      await cancelSubscription({
        organizationId: orgId,
        businessId: cBiz.id,
        subscriptionId: s.id,
        atPeriodEnd: false,
        now: churnedAt,
      });
      await withTenant(orgId, (tx) =>
        tx.update(subscriptions).set({ canceledAt: churnedAt }).where(eq(subscriptions.id, s.id)),
      );
    }
  };
  await line(monthStart - 60 * DAY, null);
  await line(monthStart - 40 * DAY, monthStart + 10 * DAY);
  await line(monthStart + 5 * DAY, monthStart + 15 * DAY);

  const home = await computeBusinessAnalytics(orgId, cBiz.id, {
    range: "12m",
    currency: "USD",
    now: cNow,
  });
  const rep = (key: string) => resolveReport(orgId, cBiz.id, key, { currency: "USD", now: cNow });
  const grr = (await rep("gross_revenue_retention_rate")).headline;
  const nrr = (await rep("net_revenue_retention_rate")).headline;
  const r = home.kpis.retention;
  console.log(
    `cohort: home grr=${r.gross_retention_bps} nrr=${r.net_retention_bps} · reports grr=${grr} nrr=${nrr}`,
  );
  ok(
    `retention cohort: Business Home GRR leaves out the mid-month line (${r.gross_retention_bps})`,
    r.gross_retention_bps === 5000,
  );
  ok(
    `retention cohort: Business Home NRR leaves it out too (${r.net_retention_bps})`,
    r.net_retention_bps === 5000,
  );
  ok(
    `retention cohort: reports agree (${grr} / ${nrr})`,
    grr === r.gross_retention_bps && nrr === r.net_retention_bps,
  );
  ok(
    `retention cohort: the quick ratio still counts every move, 5000 new over 10000 lost (${r.quick_ratio_bps})`,
    r.quick_ratio_bps === 5000,
  );
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
