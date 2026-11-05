import { reportableCustomer } from "./reportable";
import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businesses } from "@db/schema";
import type { AnalyticsSeries, SeriesPointOut } from "./analytics";
import {
  resolveCalendarRange,
  resolveBuckets,
  bucketKeySql,
  type BucketGranularity,
  type CalendarRange,
  type RangeBucket,
} from "./calendar-ranges";

/**
 * Payments analytics — the read behind the Dashboard tab on
 * `/transactions` and `/payment_intents`.
 *
 * `analytics.ts` is a **subscription-revenue** dashboard (MRR, CMRR, churn,
 * signups) over rolling windows. This is the **payments** dashboard: what the
 * gateways actually did over a calendar period — volume, refunds, chargebacks,
 * declines and why, split by gateway and payment method. It reuses that read's
 * `AnalyticsSeries` shape (`headline.value` / `prev_value` / `prev_label` +
 * `points[]`) so one UI block can consume both, and adds the
 * `headline.change_bps` the payments tiles show as "+63.4% vs Previous Week".
 *
 * ## Definitions (all reproducible from the returned series)
 * | measure | definition |
 * |---|---|
 * | `gross_volume` | Σ `amount_minor` of `type='payment' AND status='succeeded'` |
 * | `refunds` | Σ of `type='refund' AND status='succeeded'` |
 * | `chargebacks` | Σ of `disputes.amount_minor`, by `opened_at` |
 * | `net_volume` | `gross_volume − refunds − chargebacks` |
 * | `transaction_count` | every `transactions` row in the period, any type/status |
 * | `successful_payments` | count of `type='payment' AND status='succeeded'` |
 * | `failed_transactions` | count of FAILED **charge attempts** |
 * | `failed_amount` | Σ `amount_minor` of FAILED charge attempts |
 * | `failure_rate` | failed ÷ (succeeded + failed) charge attempts, in **basis points** |
 * | `pending_payment_intents` | intents created in the period still `inited`/`in_progress` |
 *
 * A **charge attempt** is `type IN ('payment','authorization')` — that is what a
 * merchant means by a decline; a failed *refund* is an operational error, not a
 * decline, so it stays out of the failure family (it is still inside
 * `transaction_count`). FAILED is `status IN ('failed','late_failed')`.
 * `timeout` / `needs_attention` are deliberately in NEITHER the numerator nor
 * the denominator of the failure rate: their outcome is unknown, and counting an
 * unknown as a failure would overstate declines. `voided` and `in_progress`
 * likewise only affect `transaction_count`.
 *
 * ## Aggregation
 * Everything is aggregated **in Postgres** (`GROUP BY`), never by loading rows
 * into JS — `transactions` is the fastest-growing table in the product. Eight
 * grouped queries run per request; each returns at most (dimensions × currencies
 * × 2 periods) rows, which is bounded by the distinct combinations present, not
 * by row count. The current and previous windows are contiguous
 * (`previous.end === current.start`), so both are read in ONE index range scan
 * and separated by a `CASE` on `occurred_at`.
 *
 * ## Money
 * Integer minor units + a currency, always. SQL groups by currency; the JS layer
 * converts into the reporting currency with the business's manual FX rates —
 * the same rule (and the same `converted` / `available_currencies` /
 * `missing_rates` disclosure) as `analytics.ts`. A currency with no rate is
 * excluded from BOTH the money and the counts of a converted roll-up, so a tile
 * never mixes a partial count with a partial sum.
 *
 * `available_currencies` — and therefore `missing_rates` — unions the currencies
 * of ALL THREE money sources (transactions, disputes, payment intents), not just
 * transactions: a dispute is windowed by `opened_at`, so a chargeback in a
 * rateless currency can be the only row of its currency in the period, and the
 * disclosure has to name it or the tile drops real money in silence.
 */

/** Statuses that mean the gateway accepted the attempt. */
const SUCCESS_STATUS = "succeeded";
/** Statuses that mean the gateway refused it (a decline we can attribute). */
const FAILED_STATUSES = new Set(["failed", "late_failed"]);
/** Transaction types that represent an attempt to take money. */
const CHARGE_TYPES = new Set(["payment", "authorization"]);
/** Payment-intent statuses still awaiting the buyer or the gateway. */
const PENDING_INTENT_STATUSES = new Set(["inited", "in_progress"]);

const UNKNOWN = "unknown";

export interface PaymentsBreakdownRow {
  key: string;
  label: string;
  /** Transactions in this slice (any type/status) — Σ = `transaction_count`. */
  count: number;
  prev_count: number;
  /** Gross volume in this slice — Σ = `gross_volume`. Minor units, reporting currency. */
  amount_minor: number;
  prev_amount_minor: number;
  /** Failed charge attempts in this slice — Σ = `failed_transactions`. */
  failed_count: number;
  prev_failed_count: number;
  /** Share of `transaction_count`, in basis points. */
  share_bps: number;
}

export interface ErrorDetailRow {
  /** The gateway's `error_code`, or `unknown` when it gave none. */
  error_code: string;
  label: string;
  /** Failed charge attempts with this cause — Σ = `failed_transactions`. */
  count: number;
  prev_count: number;
  /** Their amount — Σ = `failed_amount`. Minor units, reporting currency. */
  amount_minor: number;
  prev_amount_minor: number;
  /** Share of `failed_transactions`, in basis points. */
  share_bps: number;
}

export interface PaymentsAnalyticsFilters {
  /** `transactions.gateway_key` (`unknown` selects rows with none). */
  gateway: string | null;
  /** `payment_methods.type` — card / upi / … (`unknown` selects rows with none). */
  payment_method: string | null;
}

export interface BusinessPaymentsAnalytics {
  as_of: string;
  range: CalendarRange;
  /** IANA zone every boundary was resolved in. */
  timezone: string;
  granularity: BucketGranularity;
  period: { label: string; start: string; end: string };
  previous_period: { label: string; start: string; end: string };
  currency: string;
  converted: boolean;
  available_currencies: string[];
  missing_rates: string[];
  filters: PaymentsAnalyticsFilters;
  /** Filter options, derived from the two periods and NOT narrowed by `filters`. */
  options: {
    gateways: Array<{ key: string; label: string }>;
    payment_methods: Array<{ key: string; label: string }>;
  };
  series: AnalyticsSeries[];
  breakdowns: {
    error_details: ErrorDetailRow[];
    payment_methods: PaymentsBreakdownRow[];
    gateways: PaymentsBreakdownRow[];
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const GATEWAY_LABELS: Record<string, string> = {
  stripe: "Stripe",
  paypal: "PayPal",
  razorpay: "RazorPay",
  tmtest: "TM Test",
};
const METHOD_LABELS: Record<string, string> = {
  card: "Card",
  upi: "UPI",
  paypal: "PayPal",
  wallet: "Wallet",
  netbanking: "Net Banking",
  bank_transfer: "Bank Transfer",
  ach_credit: "ACH Credit",
  direct_debit: "Direct Debit",
};

/**
 * `card_declined` → `Card declined`. Gateways are inconsistent about case
 * (Stripe lower-snake, RazorPay `BAD_REQUEST_ERROR`), so a SHOUTING code is
 * lowercased first — otherwise one gateway's rows shout in the breakdown.
 */
function humanize(key: string): string {
  if (key === UNKNOWN) return "Unknown";
  const normalized = /[a-z]/.test(key) ? key : key.toLowerCase();
  const spaced = normalized.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
const gatewayLabel = (k: string) => GATEWAY_LABELS[k] ?? humanize(k);
const methodLabel = (k: string) => METHOD_LABELS[k] ?? humanize(k);

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

type PeriodTag = "current" | "previous";

interface Totals {
  grossMinor: number;
  refundMinor: number;
  chargebackMinor: number;
  failedMinor: number;
  txnCount: number;
  successfulPayments: number;
  succeededAttempts: number;
  failedAttempts: number;
  pendingIntents: number;
}

const zeroTotals = (): Totals => ({
  grossMinor: 0,
  refundMinor: 0,
  chargebackMinor: 0,
  failedMinor: 0,
  txnCount: 0,
  successfulPayments: 0,
  succeededAttempts: 0,
  failedAttempts: 0,
  pendingIntents: 0,
});

interface Slice {
  count: number;
  grossMinor: number;
  failedCount: number;
  failedMinor: number;
}
const zeroSlice = (): Slice => ({ count: 0, grossMinor: 0, failedCount: 0, failedMinor: 0 });

/** Two-period accumulator keyed by a breakdown dimension. */
class Dimension {
  private readonly rows = new Map<string, Record<PeriodTag, Slice>>();

  add(key: string, period: PeriodTag, patch: Partial<Slice>) {
    let entry = this.rows.get(key);
    if (!entry) {
      entry = { current: zeroSlice(), previous: zeroSlice() };
      this.rows.set(key, entry);
    }
    const s = entry[period];
    s.count += patch.count ?? 0;
    s.grossMinor += patch.grossMinor ?? 0;
    s.failedCount += patch.failedCount ?? 0;
    s.failedMinor += patch.failedMinor ?? 0;
  }

  entries(): Array<[string, Record<PeriodTag, Slice>]> {
    return [...this.rows.entries()];
  }
}

/** Row shapes returned by the grouped queries (postgres-js gives strings for bigint). */
interface DimRow {
  period: PeriodTag;
  currency: string;
  gateway: string;
  method: string;
  error_code: string;
  txn_type: string;
  txn_status: string;
  n: number | string;
  amt: number | string;
}
interface BucketTxnRow {
  bkey: string;
  currency: string;
  txn_type: string;
  txn_status: string;
  n: number | string;
  amt: number | string;
}

const num = (v: number | string | null | undefined) => Number(v ?? 0);

const bps = (curr: number, prev: number): number | null =>
  prev > 0 ? Math.round(((curr - prev) / prev) * 10000) : null;

/** Failure rate in basis points over a determinate attempt population. */
const failureRateBps = (failed: number, succeeded: number): number => {
  const denom = failed + succeeded;
  return denom > 0 ? Math.round((failed / denom) * 10000) : 0;
};

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

export interface PaymentsAnalyticsOptions {
  range?: CalendarRange;
  currency?: string;
  gateway?: string | null;
  paymentMethod?: string | null;
  now?: Date;
}

/**
 * Compute the payments-analytics payload for one business + calendar period.
 *
 * `currency` behaves exactly as on `/analytics`: `ALL` converts every currency
 * into the business default via its manual FX rates (reporting the gaps in
 * `missing_rates`), a specific code scopes every figure — money AND counts — to
 * that currency.
 */
export async function computePaymentsAnalytics(
  organizationId: string,
  businessId: string,
  opts: PaymentsAnalyticsOptions = {},
): Promise<BusinessPaymentsAnalytics> {
  const range: CalendarRange = opts.range ?? "this_month";
  const now = opts.now ?? new Date();
  const gateway = opts.gateway?.trim() ? opts.gateway.trim() : null;
  const paymentMethod = opts.paymentMethod?.trim() ? opts.paymentMethod.trim() : null;

  return withTenant(organizationId, async (tx) => {
    const resolved = await resolveCalendarRange(tx, businessId, range, now);
    const { timezone: tz, granularity, current, previous } = resolved;
    const curStart = current.start.toISOString();
    const curEnd = current.end.toISOString();
    const prevStart = previous.start.toISOString();

    const buckets = await resolveBuckets(tx, current, tz, granularity);

    const [bizRow] = await tx
      .select({
        defaultCurrency: businesses.defaultCurrency,
        exchangeRates: businesses.exchangeRates,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);

    const base = (bizRow?.defaultCurrency ?? "USD").toUpperCase();
    const rates = (bizRow?.exchangeRates as Record<string, number> | null) ?? {};

    // --- Filter options. Deliberately NOT narrowed by the active filter: a
    // dropdown that hides every option but the selected one is a dead end.
    const optionRows = (await tx.execute(sql`
      select distinct
        coalesce(t.gateway_key, ${UNKNOWN}) as gateway,
        coalesce(pm.type, ${UNKNOWN})       as method
      from transactions t
      left join payment_methods pm on pm.id = t.payment_method_id
      where t.business_id = ${businessId}::uuid
        and ${reportableCustomer(sql`t.customer_id`)}
        and t.occurred_at >= ${prevStart}::timestamptz
        and t.occurred_at <  ${curEnd}::timestamptz
    `)) as unknown as Array<{ gateway: string; method: string }>;

    // --- Every currency the period touches. This MUST cover all three sources
    // that carry money here — transactions, disputes and payment intents —
    // because `missing_rates` is derived from it and is the only disclosure the
    // UI has: a rateless currency is dropped from the figures whatever table it
    // came from. Disputes are keyed by `opened_at` and intents by `created_at`,
    // so a chargeback routinely lands in a period holding no transaction in its
    // currency; deriving the list from `transactions` alone silently omitted
    // that money with no warning.
    const currencyRows = (await tx.execute(sql`
      select distinct currency from (
        select t.currency as currency
        from transactions t
        where t.business_id = ${businessId}::uuid
          and ${reportableCustomer(sql`t.customer_id`)}
          and t.occurred_at >= ${prevStart}::timestamptz
          and t.occurred_at <  ${curEnd}::timestamptz
        union all
        select d.currency
        from disputes d
        where d.business_id = ${businessId}::uuid
          and ${reportableCustomer(sql`d.customer_id`)}
          and d.opened_at >= ${prevStart}::timestamptz
          and d.opened_at <  ${curEnd}::timestamptz
        union all
        select coalesce(pi.currency, ${base})
        from payment_intents pi
        where pi.business_id = ${businessId}::uuid
          and ${reportableCustomer(sql`pi.customer_id`)}
          and pi.created_at >= ${prevStart}::timestamptz
          and pi.created_at <  ${curEnd}::timestamptz
      ) c
      where currency is not null
    `)) as unknown as Array<{ currency: string }>;

    const availableCurrencies = [
      ...new Set<string>([base, ...currencyRows.map((r) => r.currency.toUpperCase())]),
    ].sort();

    const requested = (opts.currency ?? "ALL").toUpperCase();
    const scoped =
      requested !== "ALL" && availableCurrencies.includes(requested) ? requested : null;
    const reporting = scoped ?? base;

    /** Convert into the reporting currency; null = not representable (row excluded). */
    const convert = (minor: number, ccy: string): number | null => {
      const c = (ccy ?? reporting).toUpperCase();
      if (scoped) return c === scoped ? minor : null;
      if (c === reporting) return minor;
      const rate = rates[c];
      return rate != null && rate > 0 ? Math.round(minor / rate) : null;
    };
    const missingRates = scoped
      ? []
      : availableCurrencies.filter((c) => c !== reporting && !(rates[c] != null && rates[c] > 0));
    /** Whether a currency's rows count at all under the current scoping. */
    const usable = (ccy: string) => convert(0, ccy) != null;

    // --- Q1: every transaction measure, both periods, all breakdown dimensions.
    const dimRows = (await tx.execute(sql`
      select
        case when t.occurred_at >= ${curStart}::timestamptz then 'current' else 'previous' end as period,
        t.currency                            as currency,
        coalesce(t.gateway_key, ${UNKNOWN})   as gateway,
        coalesce(pm.type, ${UNKNOWN})         as method,
        coalesce(t.error_code, ${UNKNOWN})    as error_code,
        t.type                                as txn_type,
        t.status                              as txn_status,
        count(*)::int                         as n,
        coalesce(sum(t.amount_minor), 0)::bigint as amt
      from transactions t
      left join payment_methods pm on pm.id = t.payment_method_id
      where t.business_id = ${businessId}::uuid
        and ${reportableCustomer(sql`t.customer_id`)}
        and t.occurred_at >= ${prevStart}::timestamptz
        and t.occurred_at <  ${curEnd}::timestamptz
        and (${gateway}::text is null or coalesce(t.gateway_key, ${UNKNOWN}) = ${gateway}::text)
        and (${paymentMethod}::text is null or coalesce(pm.type, ${UNKNOWN}) = ${paymentMethod}::text)
      group by 1, 2, 3, 4, 5, 6, 7
    `)) as unknown as DimRow[];

    const totals: Record<PeriodTag, Totals> = { current: zeroTotals(), previous: zeroTotals() };
    const byGateway = new Dimension();
    const byMethod = new Dimension();
    const byError = new Dimension();

    for (const r of dimRows) {
      if (!usable(r.currency)) continue;
      const count = num(r.n);
      const amount = convert(num(r.amt), r.currency) ?? 0;
      const period = r.period;
      const T = totals[period];
      const isCharge = CHARGE_TYPES.has(r.txn_type);
      const succeeded = r.txn_status === SUCCESS_STATUS;
      const failed = FAILED_STATUSES.has(r.txn_status);

      T.txnCount += count;
      const slice: Partial<Slice> = { count };
      if (succeeded && r.txn_type === "payment") {
        T.grossMinor += amount;
        T.successfulPayments += count;
        slice.grossMinor = amount;
      }
      if (succeeded && r.txn_type === "refund") T.refundMinor += amount;
      if (isCharge && succeeded) T.succeededAttempts += count;
      if (isCharge && failed) {
        T.failedAttempts += count;
        T.failedMinor += amount;
        slice.failedCount = count;
        slice.failedMinor = amount;
        byError.add(r.error_code, period, { count, failedCount: count, failedMinor: amount });
      }
      byGateway.add(r.gateway, period, slice);
      byMethod.add(r.method, period, slice);
    }

    // --- Q2: the same transaction measures per chart bucket (current period).
    const bucketKey = bucketKeySql(sql`t.occurred_at`, tz, granularity);
    const bucketRows = (await tx.execute(sql`
      select ${bucketKey} as bkey,
             t.currency   as currency,
             t.type       as txn_type,
             t.status     as txn_status,
             count(*)::int as n,
             coalesce(sum(t.amount_minor), 0)::bigint as amt
      from transactions t
      left join payment_methods pm on pm.id = t.payment_method_id
      where t.business_id = ${businessId}::uuid
        and ${reportableCustomer(sql`t.customer_id`)}
        and t.occurred_at >= ${curStart}::timestamptz
        and t.occurred_at <  ${curEnd}::timestamptz
        and (${gateway}::text is null or coalesce(t.gateway_key, ${UNKNOWN}) = ${gateway}::text)
        and (${paymentMethod}::text is null or coalesce(pm.type, ${UNKNOWN}) = ${paymentMethod}::text)
      group by 1, 2, 3, 4
    `)) as unknown as BucketTxnRow[];

    const perBucket = new Map<string, Totals>(buckets.map((b) => [b.key, zeroTotals()]));
    for (const r of bucketRows) {
      if (!usable(r.currency)) continue;
      const T = perBucket.get(r.bkey);
      if (!T) continue; // a row outside the generated buckets is impossible; ignore defensively
      const count = num(r.n);
      const amount = convert(num(r.amt), r.currency) ?? 0;
      const isCharge = CHARGE_TYPES.has(r.txn_type);
      const succeeded = r.txn_status === SUCCESS_STATUS;
      const failed = FAILED_STATUSES.has(r.txn_status);
      T.txnCount += count;
      if (succeeded && r.txn_type === "payment") {
        T.grossMinor += amount;
        T.successfulPayments += count;
      }
      if (succeeded && r.txn_type === "refund") T.refundMinor += amount;
      if (isCharge && succeeded) T.succeededAttempts += count;
      if (isCharge && failed) {
        T.failedAttempts += count;
        T.failedMinor += amount;
      }
    }

    // --- Q3/Q4: chargebacks. Disputes carry no payment method of their own, so
    // the method filter reaches them through the disputed payment (null →
    // `unknown`); the gateway filter uses the dispute's own `provider_key`.
    const disputeTotals = (await tx.execute(sql`
      select case when d.opened_at >= ${curStart}::timestamptz then 'current' else 'previous' end as period,
             d.currency as currency,
             count(*)::int as n,
             coalesce(sum(d.amount_minor), 0)::bigint as amt
      from disputes d
      left join payments p on p.id = d.payment_id
      left join payment_methods pm on pm.id = p.payment_method_id
      where d.business_id = ${businessId}::uuid
        and ${reportableCustomer(sql`d.customer_id`)}
        and d.opened_at >= ${prevStart}::timestamptz
        and d.opened_at <  ${curEnd}::timestamptz
        and (${gateway}::text is null or coalesce(d.provider_key, ${UNKNOWN}) = ${gateway}::text)
        and (${paymentMethod}::text is null or coalesce(pm.type, ${UNKNOWN}) = ${paymentMethod}::text)
      group by 1, 2
    `)) as unknown as Array<{
      period: PeriodTag;
      currency: string;
      n: number | string;
      amt: number | string;
    }>;

    for (const r of disputeTotals) {
      if (!usable(r.currency)) continue;
      totals[r.period].chargebackMinor += convert(num(r.amt), r.currency) ?? 0;
    }

    const disputeBucketKey = bucketKeySql(sql`d.opened_at`, tz, granularity);
    const disputeBuckets = (await tx.execute(sql`
      select ${disputeBucketKey} as bkey,
             d.currency as currency,
             coalesce(sum(d.amount_minor), 0)::bigint as amt
      from disputes d
      left join payments p on p.id = d.payment_id
      left join payment_methods pm on pm.id = p.payment_method_id
      where d.business_id = ${businessId}::uuid
        and ${reportableCustomer(sql`d.customer_id`)}
        and d.opened_at >= ${curStart}::timestamptz
        and d.opened_at <  ${curEnd}::timestamptz
        and (${gateway}::text is null or coalesce(d.provider_key, ${UNKNOWN}) = ${gateway}::text)
        and (${paymentMethod}::text is null or coalesce(pm.type, ${UNKNOWN}) = ${paymentMethod}::text)
      group by 1, 2
    `)) as unknown as Array<{ bkey: string; currency: string; amt: number | string }>;

    for (const r of disputeBuckets) {
      if (!usable(r.currency)) continue;
      const T = perBucket.get(r.bkey);
      if (T) T.chargebackMinor += convert(num(r.amt), r.currency) ?? 0;
    }

    // --- Q5/Q6: payment intents. `pending` is a STATUS snapshot over a CREATION
    // window: an intent created before the period and still pending is not
    // counted here, because the period is what the dashboard scopes.
    const intentTotals = (await tx.execute(sql`
      select case when pi.created_at >= ${curStart}::timestamptz then 'current' else 'previous' end as period,
             coalesce(pi.currency, ${base}) as currency,
             pi.status as status,
             count(*)::int as n
      from payment_intents pi
      left join payment_methods pm on pm.id = pi.payment_method_id
      left join gateway_accounts ga on ga.id = pi.gateway_account_id
      where pi.business_id = ${businessId}::uuid
        and ${reportableCustomer(sql`pi.customer_id`)}
        and pi.created_at >= ${prevStart}::timestamptz
        and pi.created_at <  ${curEnd}::timestamptz
        and (${gateway}::text is null or coalesce(ga.gateway_key, ${UNKNOWN}) = ${gateway}::text)
        and (${paymentMethod}::text is null or coalesce(pm.type, ${UNKNOWN}) = ${paymentMethod}::text)
      group by 1, 2, 3
    `)) as unknown as Array<{
      period: PeriodTag;
      currency: string;
      status: string;
      n: number | string;
    }>;

    for (const r of intentTotals) {
      if (!usable(r.currency)) continue;
      if (PENDING_INTENT_STATUSES.has(r.status)) totals[r.period].pendingIntents += num(r.n);
    }

    const intentBucketKey = bucketKeySql(sql`pi.created_at`, tz, granularity);
    const intentBuckets = (await tx.execute(sql`
      select ${intentBucketKey} as bkey,
             coalesce(pi.currency, ${base}) as currency,
             pi.status as status,
             count(*)::int as n
      from payment_intents pi
      left join payment_methods pm on pm.id = pi.payment_method_id
      left join gateway_accounts ga on ga.id = pi.gateway_account_id
      where pi.business_id = ${businessId}::uuid
        and ${reportableCustomer(sql`pi.customer_id`)}
        and pi.created_at >= ${curStart}::timestamptz
        and pi.created_at <  ${curEnd}::timestamptz
        and (${gateway}::text is null or coalesce(ga.gateway_key, ${UNKNOWN}) = ${gateway}::text)
        and (${paymentMethod}::text is null or coalesce(pm.type, ${UNKNOWN}) = ${paymentMethod}::text)
      group by 1, 2, 3
    `)) as unknown as Array<{ bkey: string; currency: string; status: string; n: number | string }>;

    for (const r of intentBuckets) {
      if (!usable(r.currency)) continue;
      if (!PENDING_INTENT_STATUSES.has(r.status)) continue;
      const T = perBucket.get(r.bkey);
      if (T) T.pendingIntents += num(r.n);
    }

    // --- Series.
    const cur = totals.current;
    const prv = totals.previous;
    const points = (pick: (t: Totals) => number): SeriesPointOut[] =>
      buckets.map((b: RangeBucket) => ({
        t: b.t,
        label: b.label,
        v: pick(perBucket.get(b.key) ?? zeroTotals()),
      }));

    const series = (
      key: string,
      label: string,
      kind: "money" | "count" | "percent",
      value: number,
      prevValue: number,
      pick: (t: Totals) => number,
    ): AnalyticsSeries => ({
      key,
      label,
      kind: kind === "percent" ? "percent" : kind,
      headline: {
        kind,
        value,
        prev_value: prevValue,
        prev_label: resolved.prev_label,
        change_bps: bps(value, prevValue),
      },
      points: points(pick),
    });

    const netVolume = (t: Totals) => t.grossMinor - t.refundMinor - t.chargebackMinor;

    const seriesOut: AnalyticsSeries[] = [
      series(
        "gross_volume",
        "Gross Volume",
        "money",
        cur.grossMinor,
        prv.grossMinor,
        (t) => t.grossMinor,
      ),
      series("refunds", "Refunds", "money", cur.refundMinor, prv.refundMinor, (t) => t.refundMinor),
      series(
        "chargebacks",
        "Chargebacks",
        "money",
        cur.chargebackMinor,
        prv.chargebackMinor,
        (t) => t.chargebackMinor,
      ),
      series("net_volume", "Net Volume", "money", netVolume(cur), netVolume(prv), netVolume),
      series(
        "transaction_count",
        "Transactions",
        "count",
        cur.txnCount,
        prv.txnCount,
        (t) => t.txnCount,
      ),
      series(
        "successful_payments",
        "Successful Payments",
        "count",
        cur.successfulPayments,
        prv.successfulPayments,
        (t) => t.successfulPayments,
      ),
      series(
        "failed_transactions",
        "Failed Transactions",
        "count",
        cur.failedAttempts,
        prv.failedAttempts,
        (t) => t.failedAttempts,
      ),
      series(
        "failed_amount",
        "Failed Amount",
        "money",
        cur.failedMinor,
        prv.failedMinor,
        (t) => t.failedMinor,
      ),
      series(
        "failure_rate",
        "Failure Rate",
        "percent",
        failureRateBps(cur.failedAttempts, cur.succeededAttempts),
        failureRateBps(prv.failedAttempts, prv.succeededAttempts),
        (t) => failureRateBps(t.failedAttempts, t.succeededAttempts),
      ),
      series(
        "pending_payment_intents",
        "Pending Payment Intents",
        "count",
        cur.pendingIntents,
        prv.pendingIntents,
        (t) => t.pendingIntents,
      ),
    ];

    // --- Breakdowns. Sorted by the current period, descending — the failing
    // cause / busiest gateway is what the operator is looking for.
    const share = (part: number, whole: number) =>
      whole > 0 ? Math.round((part / whole) * 10000) : 0;

    const breakdownRows = (dim: Dimension, label: (k: string) => string): PaymentsBreakdownRow[] =>
      dim
        .entries()
        .map(([key, e]) => ({
          key,
          label: label(key),
          count: e.current.count,
          prev_count: e.previous.count,
          amount_minor: e.current.grossMinor,
          prev_amount_minor: e.previous.grossMinor,
          failed_count: e.current.failedCount,
          prev_failed_count: e.previous.failedCount,
          share_bps: share(e.current.count, cur.txnCount),
        }))
        .sort(
          (a, b) =>
            b.count - a.count || b.amount_minor - a.amount_minor || a.key.localeCompare(b.key),
        );

    const errorDetails: ErrorDetailRow[] = byError
      .entries()
      .map(([key, e]) => ({
        error_code: key,
        label: humanize(key),
        count: e.current.failedCount,
        prev_count: e.previous.failedCount,
        amount_minor: e.current.failedMinor,
        prev_amount_minor: e.previous.failedMinor,
        share_bps: share(e.current.failedCount, cur.failedAttempts),
      }))
      .sort((a, b) => b.count - a.count || a.error_code.localeCompare(b.error_code));

    const optionList = (keys: string[], label: (k: string) => string) =>
      [...new Set(keys)].sort().map((key) => ({ key, label: label(key) }));

    return {
      as_of: now.toISOString(),
      range,
      timezone: tz,
      granularity,
      period: {
        label: resolved.label,
        start: current.start.toISOString(),
        end: current.end.toISOString(),
      },
      previous_period: {
        label: resolved.prev_label,
        start: previous.start.toISOString(),
        end: previous.end.toISOString(),
      },
      currency: reporting,
      converted: scoped == null && availableCurrencies.length > 1,
      available_currencies: availableCurrencies,
      missing_rates: missingRates,
      filters: { gateway, payment_method: paymentMethod },
      options: {
        gateways: optionList(
          optionRows.map((r) => r.gateway),
          gatewayLabel,
        ),
        payment_methods: optionList(
          optionRows.map((r) => r.method),
          methodLabel,
        ),
      },
      series: seriesOut,
      breakdowns: {
        error_details: errorDetails,
        payment_methods: breakdownRows(byMethod, methodLabel),
        gateways: breakdownRows(byGateway, gatewayLabel),
      },
    };
  });
}

/** Re-exported so a route can validate a range without reaching past this module. */
export { CALENDAR_RANGES, isCalendarRange } from "./calendar-ranges";
export type { CalendarRange, BucketGranularity, Period } from "./calendar-ranges";
