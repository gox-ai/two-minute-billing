import { reportableCustomer } from "../reportable";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { customers, mrrMovements, subscriptionItems, subscriptions } from "@db/schema";
import {
  billingIntervalOf,
  loadFirstPaidAt,
  loadPlanAtStart,
  signupCohortOf,
} from "../dimension-values";
import { regionOf } from "../regions";
import { businessTimezone } from "@/platform/business-tz";
import { zonedDayEndExclusive, zonedDayStart } from "@/platform/timezones";
import {
  computeSnapshot,
  computeSnapshotByPlan,
  computeSnapshotByCountry,
  computeSnapshotByAttributes,
  snapshotMrrCache,
  endOfDay,
  attachLapses,
  bookAs,
  lapsesForDay,
  ATTRIBUTE_DIMS,
  type AttributeDim,
  type SnapshotAttributeRow,
  type SnapshotCountryRow,
  type SnapshotMrrCache,
  type SnapshotPlanRow,
  type SnapshotRow,
} from "../snapshots";
import { bookScopes, subscriptionInScope } from "../book-scope";
import { resolvePlanProductIds } from "../plan-of";
import { liveAt, MRR_STATUSES, type StockRow } from "../stocks";
import type { MetricDailyRow } from "./write";
import {
  computeInvoiceMeasures,
  INVOICE_FLOW_MEASURES,
  INVOICE_PER_GRAIN_MEASURES,
  INVOICE_MEASURE_DIMS,
  INVOICE_NOW_MEASURES,
  INVOICE_RATIO_MEASURES,
} from "./invoice-measures";
import {
  CASH_MEASURES,
  computePaymentMeasures,
  PAYMENT_MEASURE_DIMS,
  TRANSACTION_MEASURES,
} from "./payment-measures";
import {
  emptyRatioPartial,
  mergeRatioPartials,
  ratioPartial,
  ratioRows,
  RATIO_MEASURE_AGGREGATE,
  RATIO_MEASURE_DIMS,
  RATIO_MEASURES,
} from "./ratio-measures";
import {
  computePaymentMethodMeasures,
  PAYMENT_METHOD_MEASURE_DIMS,
  PAYMENT_METHOD_MEASURES,
} from "./payment-method-measures";
import {
  computeScheduledMeasures,
  SCHEDULED_MEASURE_DIMS,
  SCHEDULED_MEASURES,
} from "./scheduled-measures";
import { churnKindOf } from "../cancellations";
import {
  computeDisputeMeasures,
  DISPUTE_MEASURE_DIMS,
  DISPUTE_MEASURES,
  DISPUTE_READINGS,
} from "./dispute-measures";
import {
  computeCreditMeasures,
  CREDIT_FLOWS,
  CREDIT_MEASURE_DIMS,
  CREDIT_MEASURES,
} from "./credit-measures";
import {
  computeUsageMeasures,
  USAGE_MEASURE_DIMS,
  USAGE_MEASURES,
  USAGE_NO_CURRENCY,
  USAGE_SUMS,
} from "./usage-measures";
import {
  computeOrderMeasures,
  ORDER_MEASURE_DIMS,
  ORDER_MEASURES,
  ORDER_RATIOS,
  ORDER_SUMS,
} from "./order-measures";
import {
  computeExpectedRenewalMeasures,
  EXPECTED_CASH_MEASURE_DIMS,
  EXPECTED_CASH_MEASURES,
} from "./renewal-measures";
import {
  computeCustomerMeasures,
  CUSTOMER_MEASURE_AGGREGATE,
  CUSTOMER_MEASURE_DIMS,
  CUSTOMER_MEASURES,
} from "./customer-measures";
import { MEASURES, measureById, supportsDimension, type Grain, type MeasureDef } from "./measures";

/**
 * Compute every first-cut measure for one business over one period.
 *
 * ⚠️ This function DELEGATES and does not re-derive. The stocks come from `snapshots.ts`,
 * which evaluates the shared predicates in `stocks.ts`; the flows come from the movement
 * ledger. A second implementation of "what is live" would be a second definition, and the
 * whole point of the semantic layer is that there is one.
 *
 * Stocks are read at the period's END — `mrr` for a month is the MRR on its last day, never
 * the sum of its days. Flows are summed ACROSS the period.
 *
 * ── THE REGISTRY IS THE CONTRACT, NOT A DESCRIPTION ─────────────────────────────────
 * The measure list used to be implicit in this file's code and merely RESTATED in
 * `measures.ts`, so flipping `mrr` from `last` to `sum` in the registry changed nothing and
 * every gate stayed green — the writer and its own description could disagree silently,
 * which is the one thing a single registry exists to prevent.
 *
 * So the writer iterates `MEASURES` and dispatches on `source`/`aggregate` through `IMPL`
 * below. A declared measure with no implementation, or one whose implementation follows a
 * different rule than it declares, throws — it can no longer produce nothing quietly.
 */

/** One slice of the book. `cmrrMinor` is only on the attribute slices (`computeSnapshotByAttributes`). */
type StockSliceRow = Omit<SnapshotRow, "currency" | "cmrrMinor"> & { cmrrMinor?: bigint };

/** A stock is a value AT the period's end, taken off a snapshot row. */
interface StockImpl {
  source: "stocks";
  aggregate: "last";
  total: (r: SnapshotRow) => bigint;
  /** Absent when the measure declares no slice dimension. */
  slice?: (r: StockSliceRow) => bigint;
}

/** The stored slices each hand-written source can emit. A measure emits those it declares. */
const STOCK_SLICES: readonly string[] = ["plan", "country", ...ATTRIBUTE_DIMS];
const FLOW_SLICES: readonly string[] = [
  "plan",
  "plan_at_start",
  "country",
  "region",
  "billing_interval",
  "signup_cohort",
  "churn_kind",
];
const BOOK_FLOW_SLICES: readonly string[] = ["billing_interval"];
const slicesOf = (m: MeasureDef): string[] =>
  m.dimensions.filter((d) => d !== "currency" && d !== "business");

/** A flow is the sum of one ledger reason across the period's window. */
interface FlowImpl {
  source: "movements";
  aggregate: "sum";
  /** The `mrr_movements.reason` this measure counts. */
  reason: string;
  /** Losses are stored as POSITIVE magnitudes: every consumer states them as an amount lost. */
  loss?: boolean;
}

/** A subscription, with the two stamps and the unit count the book measures need. */
export interface BookRow extends StockRow {
  trialStart: Date | null;
  activatedAt: Date | null;
  /** Units across the subscription's items — 0 when it has none. */
  quantity: number;
}

/** A stock over the book: what one subscription contributes at the period's end. */
interface BookStockImpl {
  source: "subscriptions";
  aggregate: "last";
  countAt: (s: BookRow, at: Date) => bigint;
}

/** A flow over the book: the stamp that decides which period a subscription belongs to. */
interface BookFlowImpl {
  source: "subscriptions";
  aggregate: "sum";
  stamp: (s: BookRow) => Date | null;
}

/** A flow over the customer table. Customer grain — no currency, stored under `XXX`. */
interface CustomerFlowImpl {
  source: "customers";
  aggregate: "sum";
}

/**
 * A measure whose whole GROUP is computed in one pass in a sibling module — the invoice
 * documents, the gateway log and the applied cash, the saved cards. The facts are read once
 * and every window is cut out of that one read, so the entry here carries no function: it
 * states WHICH rule the writer follows, which is what `assertRegistryImplemented` pairs
 * against the registry.
 */
interface GroupImpl {
  source:
    | "invoices"
    | "transactions"
    | "payments"
    | "payment_methods"
    | "disputes"
    | "credits"
    | "usage"
    | "orders"
    | "scheduled"
    | "derived"
    | "customer_grain";
  aggregate: "sum" | "last" | "ratio" | "none";
  /** The stored slices this measure emits. Asserted against the registry's declaration. */
  dims: readonly string[];
  /** Measures with no currency of their own, stored under `XXX`. */
  noCurrency?: boolean;
}

type MeasureImpl =
  | StockImpl
  | FlowImpl
  | BookStockImpl
  | BookFlowImpl
  | CustomerFlowImpl
  | GroupImpl
  | ReadTimeImpl;

/** Composed by the resolver at read time (`fx-measures.ts`); the writer stores nothing. */
interface ReadTimeImpl {
  source: "read_time";
  aggregate: "sum";
}

/** How each registry entry is materialised. Paired against `MEASURES` on every call. */
const IMPL: Record<string, MeasureImpl> = {
  mrr: {
    source: "stocks",
    aggregate: "last",
    total: (r) => r.mrrMinor,
    slice: (r) => r.mrrMinor,
  },
  // Off the same snapshot rows as `mrr`, so every slice and conversion is mrr's times twelve.
  arr: {
    source: "stocks",
    aggregate: "last",
    total: (r) => r.mrrMinor * 12n,
    slice: (r) => r.mrrMinor * 12n,
  },
  cmrr: {
    source: "stocks",
    aggregate: "last",
    total: (r) => r.cmrrMinor,
    slice: (r) => {
      // Only the attribute pass carries CMRR; the plan/country tables never stored it.
      if (r.cmrrMinor == null) throw new Error("cmrr sliced by a dimension that carries no CMRR");
      return r.cmrrMinor;
    },
  },
  active_subscriptions: {
    source: "stocks",
    aggregate: "last",
    total: (r) => BigInt(r.activeSubscriptions),
    slice: (r) => BigInt(r.activeSubscriptions),
  },
  paying_subscriptions: {
    source: "stocks",
    aggregate: "last",
    total: (r) => BigInt(r.payingSubscriptions),
    slice: (r) => BigInt(r.payingSubscriptions),
  },
  renewing_subscriptions: {
    source: "stocks",
    aggregate: "last",
    total: (r) => BigInt(r.renewingSubscriptions),
    slice: (r) => BigInt(r.renewingSubscriptions),
  },
  mrr_new: { source: "movements", aggregate: "sum", reason: "new" },
  mrr_expansion: { source: "movements", aggregate: "sum", reason: "expansion" },
  mrr_reactivation: { source: "movements", aggregate: "sum", reason: "reactivation" },
  mrr_contraction: { source: "movements", aggregate: "sum", reason: "contraction", loss: true },
  mrr_churn: { source: "movements", aggregate: "sum", reason: "churn", loss: true },
  mrr_paused: { source: "movements", aggregate: "sum", reason: "pause", loss: true },
  mrr_fx_impact: { source: "read_time", aggregate: "sum" },

  // The subscription book. `liveAt` + `MRR_STATUSES` are the SAME predicates the stocks use,
  // so "live" cannot mean one thing here and another on the MRR line.
  subscriptions_total: {
    source: "subscriptions",
    aggregate: "last",
    // Existence, not liveness: a cancelled subscription is still on the book, a future one
    // is not on it yet. That is what makes this different from the active count.
    countAt: (s, at) => (s.createdAt <= at ? 1n : 0n),
  },
  subscription_quantity: {
    source: "subscriptions",
    aggregate: "last",
    // Units are read as they stand NOW — the same limitation the cached MRR carries.
    countAt: (s, at) => (MRR_STATUSES.has(s.status) && liveAt(s, at) ? BigInt(s.quantity) : 0n),
  },
  trials_cumulative: {
    source: "subscriptions",
    aggregate: "last",
    // Cut on the TRIAL's start, so this is the running total of `trials_started` and the two
    // can be plotted on one chart.
    countAt: (s, at) => (s.trialStart != null && s.trialStart <= at ? 1n : 0n),
  },
  trials_active: {
    source: "subscriptions",
    aggregate: "last",
    /**
     * In trial AT that instant — started, not yet over, and not already gone. A different
     * question from `trials_cumulative`, which counts every trial ever begun and never comes
     * back down.
     *
     * A null `trial_end` is an open-ended trial and still counts; it is not a trial that
     * ended at the epoch.
     *
     * ⚠️ `trial_end` is read as it stands NOW — the same limitation the unit count carries.
     * Extending a trial restates the days between the old end and the new one.
     */
    countAt: (s, at) =>
      s.trialStart != null &&
      s.trialStart <= at &&
      (s.trialEnd == null || s.trialEnd > at) &&
      liveAt(s, at)
        ? 1n
        : 0n,
  },
  trials_started: { source: "subscriptions", aggregate: "sum", stamp: (s) => s.trialStart },
  activations: { source: "subscriptions", aggregate: "sum", stamp: (s) => s.activatedAt },
  subscription_cancellations: {
    source: "subscriptions",
    aggregate: "sum",
    stamp: (s) => s.canceledAt,
  },
  customers_created: { source: "customers", aggregate: "sum" },

  // The invoice group. `aggregate` is the promise: the eleven dated by a window are summed,
  // and the two that can only describe the live book take the period's last value.
  ...Object.fromEntries(
    INVOICE_FLOW_MEASURES.map((id): [string, GroupImpl] => [
      id,
      { source: "invoices", aggregate: "sum", dims: INVOICE_MEASURE_DIMS[id] ?? [] },
    ]),
  ),
  ...Object.fromEntries(
    INVOICE_NOW_MEASURES.map((id): [string, GroupImpl] => [
      id,
      { source: "invoices", aggregate: "last", dims: INVOICE_MEASURE_DIMS[id] ?? [] },
    ]),
  ),
  // …and the one stored as two halves. Its numerator and denominator come off the same
  // grouped read as the flows above, so they cannot disagree about which invoices they saw.
  ...Object.fromEntries(
    INVOICE_PER_GRAIN_MEASURES.map((id): [string, GroupImpl] => [
      id,
      { source: "invoices", aggregate: "none", dims: INVOICE_MEASURE_DIMS[id] ?? [] },
    ]),
  ),
  ...Object.fromEntries(
    INVOICE_RATIO_MEASURES.map((id): [string, GroupImpl] => [
      id,
      { source: "invoices", aggregate: "ratio", dims: INVOICE_MEASURE_DIMS[id] ?? [] },
    ]),
  ),

  // The gateway log and the applied cash. TWO sources on purpose — see
  // `payment-measures.ts`: they count different populations and nothing nets them together.
  ...Object.fromEntries(
    TRANSACTION_MEASURES.map((id): [string, GroupImpl] => [
      id,
      { source: "transactions", aggregate: "sum", dims: PAYMENT_MEASURE_DIMS[id] ?? [] },
    ]),
  ),
  ...Object.fromEntries(
    CASH_MEASURES.map((id): [string, GroupImpl] => [
      id,
      { source: "payments", aggregate: "sum", dims: PAYMENT_MEASURE_DIMS[id] ?? [] },
    ]),
  ),

  // The derived ratios: no facts of their own, stored as numerator + denominator.
  ...Object.fromEntries(
    RATIO_MEASURES.map((id): [string, GroupImpl] => [
      id,
      {
        source: "derived",
        // Eight fold out of day rows; gross and net retention are cohort-restricted and
        // cannot, so the writer reads the same map the registry states.
        aggregate: RATIO_MEASURE_AGGREGATE[id] ?? "ratio",
        dims: RATIO_MEASURE_DIMS[id] ?? [],
      },
    ]),
  ),

  /**
   * The customer grain. The `aggregate` is the load-bearing field here: the four window
   * counts declare `none`, which is a promise that they are written at every grain they are
   * served at and never folded up out of days.
   */
  ...Object.fromEntries(
    CUSTOMER_MEASURES.map((id): [string, GroupImpl] => [
      id,
      {
        source: "customer_grain",
        aggregate: CUSTOMER_MEASURE_AGGREGATE[id]!,
        dims: CUSTOMER_MEASURE_DIMS[id] ?? [],
      },
    ]),
  ),

  /**
   * The forward book. As-of-the-run stocks like the cards, but per currency and sliced by a
   * closed horizon — `asOf: "computed_at"` is the whole storage decision for this group.
   */
  ...Object.fromEntries(
    SCHEDULED_MEASURES.map((id): [string, GroupImpl] => [
      id,
      {
        source: "scheduled",
        aggregate: "last",
        dims: SCHEDULED_MEASURE_DIMS[id] ?? [],
      },
    ]),
  ),
  ...Object.fromEntries(
    DISPUTE_MEASURES.map((id): [string, GroupImpl] => [
      id,
      {
        source: "disputes",
        aggregate: (DISPUTE_READINGS as readonly string[]).includes(id) ? "last" : "sum",
        dims: DISPUTE_MEASURE_DIMS[id] ?? [],
      },
    ]),
  ),
  ...Object.fromEntries(
    CREDIT_MEASURES.map((id): [string, GroupImpl] => [
      id,
      {
        source: "credits",
        aggregate: (CREDIT_FLOWS as readonly string[]).includes(id) ? "sum" : "last",
        dims: CREDIT_MEASURE_DIMS[id] ?? [],
      },
    ]),
  ),
  ...Object.fromEntries(
    USAGE_MEASURES.map((id): [string, GroupImpl] => [
      id,
      {
        source: "usage",
        aggregate: (USAGE_SUMS as readonly string[]).includes(id) ? "sum" : "none",
        dims: USAGE_MEASURE_DIMS[id] ?? [],
        ...(USAGE_NO_CURRENCY.has(id) ? { noCurrency: true } : {}),
      },
    ]),
  ),
  ...Object.fromEntries(
    ORDER_MEASURES.map((id): [string, GroupImpl] => [
      id,
      {
        source: "orders",
        aggregate: (ORDER_SUMS as readonly string[]).includes(id)
          ? "sum"
          : (ORDER_RATIOS as readonly string[]).includes(id)
            ? "ratio"
            : "none",
        dims: ORDER_MEASURE_DIMS[id] ?? [],
      },
    ]),
  ),
  ...Object.fromEntries(
    EXPECTED_CASH_MEASURES.map((id): [string, GroupImpl] => [
      id,
      { source: "scheduled", aggregate: "last", dims: EXPECTED_CASH_MEASURE_DIMS[id] ?? [] },
    ]),
  ),

  // The saved cards: as-of-the-run stocks with no currency of their own.
  ...Object.fromEntries(
    PAYMENT_METHOD_MEASURES.map((id): [string, GroupImpl] => [
      id,
      {
        source: "payment_methods",
        aggregate: "last",
        dims: PAYMENT_METHOD_MEASURE_DIMS[id] ?? [],
        noCurrency: true,
      },
    ]),
  ),
};

let paired = false;

/**
 * Refuse a registry the writer does not implement, measure for measure.
 *
 * Both directions, because both are real: an entry added to `measures.ts` and nowhere else
 * would publish a measure that silently returns no rows, and an implementation dropped from
 * the registry would write rows no resolver can read.
 */
export function assertRegistryImplemented(): void {
  const wrong: string[] = [];
  for (const m of MEASURES) {
    const impl = IMPL[m.id];
    if (!impl) {
      wrong.push(`${m.id}: declared in the registry, the writer has no implementation for it`);
      continue;
    }
    if (impl.source !== m.source) {
      wrong.push(`${m.id}: registry says source=${m.source}, the writer reads ${impl.source}`);
    }
    if (impl.aggregate !== m.aggregate) {
      wrong.push(
        `${m.id}: registry says aggregate=${m.aggregate}, the writer materialises it as ${impl.aggregate}`,
      );
    }
    /**
     * The hand-written sources emit exactly the slices a measure declares, from a fixed set
     * each can compute. A declared slice outside that set would answer empty.
     */
    if (!("dims" in impl)) {
      const declared = slicesOf(m);
      const can =
        impl.source === "stocks"
          ? STOCK_SLICES
          : impl.source === "movements"
            ? FLOW_SLICES
            : impl.source === "subscriptions" && impl.aggregate === "sum"
              ? BOOK_FLOW_SLICES
              : [];
      const unknown = declared.filter((d) => !can.includes(d));
      if (unknown.length > 0) {
        wrong.push(
          `${m.id}: the registry declares ${unknown.join(", ")}, the writer never slices by it`,
        );
      }
      if (impl.source === "stocks" && declared.length > 0 !== (impl.slice != null)) {
        wrong.push(
          declared.length > 0
            ? `${m.id}: registry declares a slice dimension the writer has no slice value for`
            : `${m.id}: the writer has a slice value, the registry declares no slice dimension`,
        );
      }
    }
    /**
     * A DIMENSION DECLARED IS A DIMENSION EMITTED.
     *
     * `country` was once declared on a measure nothing ever sliced, and the golden gate
     * structurally could not see it: every answer it compared was the unsliced total. Only
     * a check that reads the registry against the writer catches that, so the invoice
     * group states the slices it writes and they are compared here, both ways.
     *
     * `currency` and `business` are excluded because neither is a stored slice — every row
     * carries both as its own column, and the reader groups by them.
     */
    // A delegated group states the slices it writes; everything else is checked above.
    const group = "dims" in impl ? impl : null;
    if (group) {
      const declared = m.dimensions.filter((d) => d !== "currency" && d !== "business");
      const emitted = group.dims;
      const missing = declared.filter((d) => !emitted.includes(d));
      const extra = emitted.filter((d) => !(declared as readonly string[]).includes(d));
      if (missing.length > 0) {
        wrong.push(
          `${m.id}: the registry declares ${missing.join(", ")}, the writer never slices by it`,
        );
      }
      if (extra.length > 0) {
        wrong.push(
          `${m.id}: the writer slices by ${extra.join(", ")}, the registry declares no such dimension`,
        );
      }
    }
    /**
     * `currency: "none"` is a CLAIM about the storage — the row goes under `XXX` — so the
     * writer states it too and the two are paired. Customer counts and saved cards are the
     * grains that have no currency of their own; everything else is money or a
     * subscription-grain count and carries one.
     */
    /**
     * `aggregate: "ratio"` is a promise about STORAGE — two halves, divided at read — and
     * the fold is the promise about how each half re-aggregates. A ratio without one would
     * be summed by default, which is the exact mistake that makes a quarter the mean of its
     * months; a fold on anything else would be read by nobody.
     */
    if ((m.aggregate === "ratio") !== (m.ratio != null)) {
      wrong.push(
        m.aggregate === "ratio"
          ? `${m.id}: aggregate=ratio but declares no fold for its numerator and denominator`
          : `${m.id}: declares a ratio fold but its aggregate is ${m.aggregate}`,
      );
    }
    const noCurrency = impl.source === "customers" || group?.noCurrency === true;
    if ((m.currency === "none") !== noCurrency) {
      wrong.push(
        `${m.id}: registry says currency=${m.currency}, the writer stores it ${noCurrency ? "under XXX" : "per currency"}`,
      );
    }
  }
  for (const id of Object.keys(IMPL)) {
    if (!measureById(id)) wrong.push(`${id}: the writer implements it, the registry does not`);
  }
  if (wrong.length > 0) {
    throw new Error(
      `the measure registry and its writer disagree — one of them is wrong:\n  ${wrong.join("\n  ")}`,
    );
  }
  paired = true;
}

const implFor = (m: MeasureDef): MeasureImpl => IMPL[m.id]!;

/**
 * The first day of the period whose last day is `periodEnd`, INCLUSIVE.
 *
 * `periodEnd` must be a real period end on the business's calendar (`periodEndOf`), so the
 * start follows from it alone: a week is the six days before, a quarter or year starts on the
 * 1st of the month two or eleven back. That is what lets a Sunday week or an April fiscal year
 * need no calendar here. Month arithmetic lands on the 1st, never subtracts from day 31.
 */
export function periodStartDate(grain: Grain, periodEnd: string): string {
  if (grain === "day") return periodEnd;
  const d = new Date(`${periodEnd}T00:00:00.000Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  if (grain === "week") {
    d.setUTCDate(d.getUTCDate() - 6);
    return iso(d);
  }
  const back = grain === "month" ? 0 : grain === "quarter" ? 2 : 11;
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)));
}

/**
 * The same first day as an INSTANT, in the business's own calendar.
 *
 * The date arithmetic above is pure calendar work — a `Date` in UTC is just the cheapest
 * way to ask "what is the first of this month". Only here does a date become a moment, and
 * it becomes the moment that day begins for THIS business: a month on a Berlin book starts
 * at local midnight on the 1st, which is 23:00Z on the last of the previous month.
 */
export function periodStart(grain: Grain, periodEnd: string, zone?: string | null): Date {
  return zonedDayStart(periodStartDate(grain, periodEnd), zone);
}

/**
 * The first instant AFTER the period — the exclusive upper bound of its flow window.
 *
 * The window is half-open, `[start, next)`. A closed one on `endOfDay` has both a 1 ms hole
 * (Postgres keeps microseconds; 23:59:59.9995 belongs to no period) and, since the previous
 * period's last instant was also the next one's first, a movement landing exactly on a
 * boundary was counted in BOTH.
 */
export function periodEndExclusive(periodEnd: string, zone?: string | null): Date {
  return zonedDayEndExclusive(periodEnd, zone);
}

export async function computeMetricPeriod(
  tx: Tx,
  businessId: string,
  grain: Grain,
  periodEnd: string,
  /**
   * The instant this run is happening at. Only the measures that can describe nothing but
   * the live book read it — they are written for the period containing it and for no other.
   * A parameter rather than `new Date()` inside, so a gate can pin it.
   */
  now: Date = new Date(),
  /**
   * `onlyNonAdditive` computes JUST the measures that declare `aggregate: "none"`.
   *
   * They are the only ones that need a coarser grain written at all — everything else is
   * stored once, daily, and folded. The cron closes each coarser period with this flag so a
   * month costs one distinct-count pass rather than a second copy of every measure.
   */
  opts: {
    onlyNonAdditive?: boolean;
    /**
     * The business's IANA zone, so `periodEnd` is read as ITS calendar date rather than the
     * UTC one. Resolved here when the caller does not pass it; a caller filling many days
     * for one business passes it so the lookup is paid once rather than once a day.
     */
    timezone?: string | null;
    /**
     * An explicit first day, local calendar date, for a window that is not a calendar period
     * — a rolling "last 30 days" or a custom range. Only the non-additive measures need one:
     * everything else is stored per day and folded.
     */
    periodStart?: string;
    /**
     * Compute ONLY these measures — a restatement that one definition change made necessary.
     * Every read no requested measure needs is skipped; the writer replaces just the
     * (measure, dim) pairs it is handed, so nothing else stored moves.
     */
    measures?: ReadonlySet<string>;
    /**
     * Reads to share with other calls for the SAME `periodEnd` and zone — the rolling windows
     * all end today. Everything in it is either independent of the period or keyed by the
     * instant it answers, and the day-end MRR is the one `periodEnd` names.
     */
    cache?: SnapshotMrrCache;
    /** Customers per book slice (`book-scope.ts`). Gates pass a small one to force slicing. */
    sliceCustomers?: number;
  } = {},
): Promise<MetricDailyRow[]> {
  if (!paired) assertRegistryImplemented();
  /**
   * EVERY boundary below comes from this one value.
   *
   * A period's window is `[local midnight of its first day, local midnight of the day after
   * its last)`. Stored days were cut on the UTC boundary until now, which shifted every
   * figure the product shows by the zone's offset — the windows the reader asks for
   * (today, this month, the retention month) have always been local ones.
   */
  const zone = opts.timezone !== undefined ? opts.timezone : await businessTimezone(tx, businessId);
  const wanted = (m: MeasureDef) =>
    (!opts.onlyNonAdditive || m.aggregate === "none") &&
    (!opts.measures || opts.measures.has(m.id));

  const stocks: Array<[MeasureDef, StockImpl]> = [];
  const flows: Array<[MeasureDef, FlowImpl]> = [];
  const bookStocks: Array<[MeasureDef, BookStockImpl]> = [];
  const bookFlows: Array<[MeasureDef, BookFlowImpl]> = [];
  const customerFlows: MeasureDef[] = [];
  let invoiceMeasures = false;
  let paymentMeasures = false;
  let cardMeasures = false;
  let scheduledMeasures = false;
  // Its own flag: it reads every live subscription's items, which the seven do not need.
  let expectedCashMeasures = false;
  let disputeMeasures = false;
  let creditMeasures = false;
  let usageMeasures = false;
  let orderMeasures = false;
  let ratioMeasures = false;
  let customerMeasures = false;
  for (const m of MEASURES) {
    if (!wanted(m)) continue;
    const impl = implFor(m);
    // The delegated groups first: each is one call over one read, whatever it declares.
    if ("dims" in impl) {
      if (impl.source === "invoices") invoiceMeasures = true;
      else if (impl.source === "payment_methods") cardMeasures = true;
      else if (impl.source === "disputes") disputeMeasures = true;
      else if (impl.source === "credits") creditMeasures = true;
      else if (impl.source === "usage") usageMeasures = true;
      else if (impl.source === "orders") orderMeasures = true;
      else if (impl.source === "scheduled") {
        if ((EXPECTED_CASH_MEASURES as readonly string[]).includes(m.id))
          expectedCashMeasures = true;
        else scheduledMeasures = true;
      } else if (impl.source === "derived") ratioMeasures = true;
      else if (impl.source === "customer_grain") customerMeasures = true;
      else paymentMeasures = true;
    } else if (impl.source === "stocks") stocks.push([m, impl]);
    else if (impl.source === "movements") flows.push([m, impl]);
    else if (impl.source === "customers") customerFlows.push(m);
    else if (impl.source === "read_time") continue;
    else if (impl.aggregate === "last") bookStocks.push([m, impl]);
    else bookFlows.push([m, impl]);
  }

  const rows: MetricDailyRow[] = [];
  const push = (measure: string, dim: string, dimValue: string, currency: string, value: bigint) =>
    rows.push({ measure, dim, dimValue, currency, value });

  // One re-rating of cancelled subscriptions, shared by the total and both slices, so
  // they cannot disagree about the same book. It also carries the reads every group below
  // repeats (the book, the ledger at an instant), so the period pays for each once.
  const mrrCache = opts.cache ?? snapshotMrrCache();

  /**
   * ── The book, one slice at a time (D4.5) ──────────────────────────────────────────────
   * Every group that reads the whole book reads it per slice of customers (`book-scope.ts`)
   * and its answers are summed: a slice holds whole accounts and each subscription is in one
   * slice, so the sums are the whole book's. A business with no more than one slice of
   * customers reads it once, through the caller's own cache, exactly as before.
   */
  const needsBook =
    stocks.length > 0 ||
    bookStocks.length > 0 ||
    bookFlows.length > 0 ||
    scheduledMeasures ||
    expectedCashMeasures ||
    customerMeasures ||
    ratioMeasures;
  const scopes = needsBook ? await bookScopes(tx, businessId, opts.sliceCustomers) : [null];

  // Each slice is emitted only for the stocks that declare it.
  const stocksBy = (dim: string) =>
    stocks.filter(([m, impl]) => impl.slice && supportsDimension(m, dim));
  const byPlanStocks = stocksBy("plan");
  const byCountryStocks = stocksBy("country");
  // billing_interval · region · plan_at_start · signup_cohort — one pass over the book.
  const attrDims = ATTRIBUTE_DIMS.filter((d) => stocksBy(d).length > 0);
  const attrStocks = new Map<AttributeDim, typeof stocks>(attrDims.map((d) => [d, stocksBy(d)]));

  const snapshot = new Map<string, SnapshotRow>();
  const byPlan = new Map<string, SnapshotPlanRow>();
  const byCountryStock = new Map<string, SnapshotCountryRow>();
  const byAttributes = new Map<string, SnapshotAttributeRow>();
  const summed = new Map<string, MetricDailyRow>();
  // The book's own totals, kept apart until every slice has said which currencies it held.
  const bookTotals = new Map<string, MetricDailyRow>();
  const bookHeld = new Set<string>();
  const ratio = emptyRatioPartial();
  const at = endOfDay(periodEnd, zone);
  // `[start, next)` — half-open on the right, so periods tile with no movement counted
  // twice at a boundary and none falling between two of them.
  const from = opts.periodStart
    ? zonedDayStart(opts.periodStart, zone)
    : periodStart(grain, periodEnd, zone);
  const toExclusive = periodEndExclusive(periodEnd, zone);

  for (const scope of scopes) {
    const cache: SnapshotMrrCache = scopes.length === 1 ? mrrCache : { scope };
    if (stocks.length > 0 || ratioMeasures) {
      sumStocks(
        snapshot,
        await computeSnapshot(tx, businessId, periodEnd, cache, zone),
        (r) => r.currency,
      );
    }
    if (byPlanStocks.length > 0) {
      sumStocks(
        byPlan,
        await computeSnapshotByPlan(tx, businessId, periodEnd, cache, zone),
        // `planProductId` is nullable and null is a REAL bucket, not an excluded one.
        (r) => `${r.currency}\u0000${r.planProductId ?? "\u0000"}`,
      );
    }
    if (byCountryStocks.length > 0) {
      sumStocks(
        byCountryStock,
        await computeSnapshotByCountry(tx, businessId, periodEnd, cache, zone),
        (r) => `${r.currency}\u0000${r.country ?? "\u0000"}`,
      );
    }
    if (attrDims.length > 0) {
      sumStocks(
        byAttributes,
        await computeSnapshotByAttributes(tx, businessId, periodEnd, attrDims, cache, zone),
        (r) => `${r.dim}\u0000${r.currency}\u0000${r.key}`,
      );
    }
    if (bookStocks.length > 0 || bookFlows.length > 0) {
      const book = await bookMeasures(
        tx,
        businessId,
        cache,
        at,
        from,
        toExclusive,
        bookStocks,
        bookFlows,
      );
      sumRows(bookTotals, book.totals);
      sumRows(summed, book.rows);
      for (const c of book.held) bookHeld.add(c);
    }
    // ── The forward book ──────────────────────────────────────────────────────────────────
    // As-of-the-run only: a past period gets no row, because what was booked then is gone.
    if (scheduledMeasures) {
      sumRows(
        summed,
        await computeScheduledMeasures({ tx, businessId, from, toExclusive, now, cache }),
      );
    }
    if (expectedCashMeasures) {
      sumRows(
        summed,
        await computeExpectedRenewalMeasures({ tx, businessId, from, toExclusive, now, cache }),
      );
    }
    /**
     * ── The customer grain ──────────────────────────────────────────────────────────────
     * The head counts. Written whole even when only the non-additive four were asked for —
     * one read over the ledger answers all four, and the four instant figures come off a book
     * this function has already paid for. `filterRows` below drops what was not wanted.
     */
    if (customerMeasures) {
      sumRows(
        summed,
        await computeCustomerMeasures({
          tx,
          businessId,
          from,
          toExclusive,
          periodEnd,
          zone,
          cache,
        }),
      );
    }
    if (ratioMeasures) {
      mergeRatioPartials(
        ratio,
        await ratioPartial({ tx, businessId, from, toExclusive, periodEnd, zone, now, cache }),
      );
    }
  }

  sumRows(
    summed,
    [...bookTotals.values()].filter((r) => bookHeld.has(r.currency)),
  );

  // ── Stocks, at the period's end ───────────────────────────────────────────────────────
  // A bucket a slice wrote but the whole book nets to nothing writes no row, as before.
  const closing = [...snapshot.values()].filter(
    (r) => r.mrrMinor !== 0n || r.cmrrMinor !== 0n || r.activeSubscriptions > 0,
  );
  if (stocks.length > 0) {
    for (const r of closing) {
      for (const [m, impl] of stocks) push(m.id, "", "", r.currency, impl.total(r));
    }
  }
  for (const r of byPlan.values()) {
    if (r.mrrMinor === 0n && r.activeSubscriptions === 0) continue;
    const v = r.planProductId ?? "none";
    for (const [m, impl] of byPlanStocks) push(m.id, "plan", v, r.currency, impl.slice!(r));
  }
  for (const r of byCountryStock.values()) {
    if (r.mrrMinor === 0n && r.activeSubscriptions === 0) continue;
    const v = r.country ?? "none";
    for (const [m, impl] of byCountryStocks) push(m.id, "country", v, r.currency, impl.slice!(r));
  }
  for (const r of byAttributes.values()) {
    if (r.mrrMinor === 0n && r.cmrrMinor === 0n && r.activeSubscriptions === 0) continue;
    for (const [m, impl] of attrStocks.get(r.dim)!)
      push(m.id, r.dim, r.key, r.currency, impl.slice!(r));
  }

  // ── Flows, summed across the period ───────────────────────────────────────────────────
  // A reason with no measure — `resume` — is simply absent from this map and is skipped;
  // reactivation carries it.
  const byReason = new Map(flows.map(([m, impl]) => [impl.reason, { id: m.id, loss: impl.loss }]));
  const valueOf = (reason: string, delta: string): bigint => {
    const f = byReason.get(reason)!;
    return f.loss ? -BigInt(delta) : BigInt(delta);
  };

  const window = and(
    and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
    gte(mrrMovements.occurredAt, from),
    lt(mrrMovements.occurredAt, toExclusive),
  );

  const sums =
    flows.length === 0
      ? []
      : await tx
          .select({
            reason: mrrMovements.reason,
            currency: mrrMovements.currency,
            planProductId: mrrMovements.planProductId,
            delta: sql<string>`coalesce(sum(${mrrMovements.deltaMinor}), 0)`.as("delta"),
          })
          .from(mrrMovements)
          .where(window)
          .groupBy(mrrMovements.reason, mrrMovements.currency, mrrMovements.planProductId);

  // Totals and the plan slice come off the same grouped read — one query, two grains of
  // answer, and they cannot disagree because neither is computed twice.
  const flowSlices = (measure: string, dim: string) =>
    supportsDimension(measureById(measure)!, dim);
  const totals = new Map<string, bigint>();
  for (const r of sums) {
    const measure = byReason.get(r.reason)?.id;
    if (!measure) continue;
    const value = valueOf(r.reason, r.delta);
    if (flowSlices(measure, "plan")) {
      push(measure, "plan", r.planProductId ?? "none", r.currency, value);
    }
    const key = `${measure}\u0000${r.currency}`;
    totals.set(key, (totals.get(key) ?? 0n) + value);
  }
  for (const [key, value] of totals) {
    const [measure, currency] = key.split("\u0000") as [string, string];
    push(measure, "", "", currency, value);
  }

  /**
   * A quiet period is a measured ZERO, not a missing row — the reader shows a missing row
   * as "unknown". Once a currency has its first movement, every flow writes its total in it,
   * zero included; before that it writes nothing. Grouped with no instant bound, so a
   * backfill reads it once.
   */
  if (flows.length > 0) {
    const firstMoves = await tx
      .select({
        currency: mrrMovements.currency,
        first: sql<Date>`min(${mrrMovements.occurredAt})`.as("first"),
      })
      .from(mrrMovements)
      .where(
        and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
      )
      .groupBy(mrrMovements.currency);
    const written = new Set([...totals.keys()].map((k) => k.toUpperCase()));
    for (const r of firstMoves) {
      if (new Date(r.first) >= toExclusive) continue;
      for (const [m] of flows) {
        if (!written.has(`${m.id}\u0000${r.currency}`.toUpperCase())) {
          push(m.id, "", "", r.currency, 0n);
        }
      }
    }
  }

  // The country slice, off the customer the movement belongs to. LEFT joined and NULL kept
  // as its own bucket for the same reason the stocks keep it: a customer with no country on
  // file belongs in the breakdown, not out of it, or the slices stop summing to the total.
  const byCountry =
    flows.length === 0
      ? []
      : await tx
          .select({
            reason: mrrMovements.reason,
            currency: mrrMovements.currency,
            country: customers.country,
            delta: sql<string>`coalesce(sum(${mrrMovements.deltaMinor}), 0)`.as("delta"),
          })
          .from(mrrMovements)
          .leftJoin(customers, eq(customers.id, mrrMovements.customerId))
          .where(window)
          .groupBy(mrrMovements.reason, mrrMovements.currency, customers.country);

  // Region folds the country rows, so the two cannot disagree about a customer.
  const regions = new Map<string, bigint>();
  for (const r of byCountry) {
    const measure = byReason.get(r.reason)?.id;
    if (!measure) continue;
    const country = r.country ? r.country.toUpperCase() : "none";
    const value = valueOf(r.reason, r.delta);
    if (flowSlices(measure, "country")) push(measure, "country", country, r.currency, value);
    if (flowSlices(measure, "region")) {
      const key = `${measure}\u0000${r.currency}\u0000${regionOf(r.country)}`;
      regions.set(key, (regions.get(key) ?? 0n) + value);
    }
  }
  for (const [key, value] of regions) {
    const [measure, currency, region] = key.split("\u0000") as [string, string, string];
    push(measure, "region", region, currency, value);
  }

  /**
   * billing_interval · plan_at_start · signup_cohort, attributed at READ time from the
   * subscription and the customer — the ledger row carries none of them. Grouped per
   * subscription so each key is resolved once, then folded.
   */
  const perSubDims = (
    ["billing_interval", "plan_at_start", "signup_cohort", "churn_kind"] as const
  ).filter((d) => flows.some(([m]) => supportsDimension(m, d)));
  if (perSubDims.length > 0) {
    const bySub = await tx
      .select({
        reason: mrrMovements.reason,
        currency: mrrMovements.currency,
        subscriptionId: mrrMovements.subscriptionId,
        customerId: mrrMovements.customerId,
        billingPeriod: subscriptions.billingPeriod,
        billingPeriodUnit: subscriptions.billingPeriodUnit,
        cancelReason: subscriptions.cancelReason,
        delta: sql<string>`coalesce(sum(${mrrMovements.deltaMinor}), 0)`.as("delta"),
      })
      .from(mrrMovements)
      .leftJoin(subscriptions, eq(subscriptions.id, mrrMovements.subscriptionId))
      .where(window)
      .groupBy(
        mrrMovements.reason,
        mrrMovements.currency,
        mrrMovements.subscriptionId,
        mrrMovements.customerId,
        subscriptions.billingPeriod,
        subscriptions.billingPeriodUnit,
        subscriptions.cancelReason,
      );
    const moved = bySub.filter((r) => byReason.has(r.reason));
    // Read for the moved subscriptions and their customers only — never the whole book.
    const movedIds = [...new Set(moved.map((r) => r.subscriptionId))];
    const startPlans = perSubDims.includes("plan_at_start")
      ? await loadPlanAtStart(tx, businessId, { subscriptionIds: movedIds })
      : null;
    const currentPlans = startPlans
      ? await resolvePlanProductIds(
          tx,
          moved.filter((r) => !startPlans.has(r.subscriptionId)).map((r) => r.subscriptionId),
        )
      : null;
    const firstPaid = perSubDims.includes("signup_cohort")
      ? await loadFirstPaidAt(tx, businessId, {
          customerIds: [...new Set(moved.map((r) => r.customerId))],
        })
      : null;

    const folded = new Map<string, bigint>();
    for (const r of moved) {
      const measure = byReason.get(r.reason)!.id;
      const value = valueOf(r.reason, r.delta);
      for (const dim of perSubDims) {
        if (!flowSlices(measure, dim)) continue;
        const v =
          dim === "billing_interval"
            ? billingIntervalOf(r.billingPeriod, r.billingPeriodUnit)
            : dim === "plan_at_start"
              ? (startPlans!.get(r.subscriptionId) ?? currentPlans!.get(r.subscriptionId) ?? "none")
              : dim === "churn_kind"
                ? churnKindOf(r.cancelReason)
                : signupCohortOf(firstPaid!.get(r.customerId), zone);
        const key = `${measure}\u0000${r.currency}\u0000${dim}\u0000${v}`;
        folded.set(key, (folded.get(key) ?? 0n) + value);
      }
    }
    for (const [key, value] of folded) {
      const [measure, currency, dim, v] = key.split("\u0000") as [string, string, string, string];
      push(measure, dim, v, currency, value);
    }
  }

  // ── The book itself, the forward book and the customer grain ────────────────────────
  // Summed across the slices above.
  rows.push(...summed.values());

  // ── The customer table ────────────────────────────────────────────────────────────────
  // Customer grain: no currency and no plan, so one row under `XXX`.
  if (customerFlows.length > 0) {
    const [joined] = await tx
      .select({ n: sql<string>`count(*)` })
      .from(customers)
      .where(
        and(
          and(eq(customers.businessId, businessId), reportableCustomer(customers.id)),
          gte(customers.createdAt, from),
          lt(customers.createdAt, toExclusive),
        ),
      );
    const n = BigInt(joined?.n ?? 0);
    for (const m of customerFlows) push(m.id, "", "", "XXX", n);
  }

  // ── Invoices and receivables ──────────────────────────────────────────────────────────
  if (invoiceMeasures) {
    rows.push(...(await computeInvoiceMeasures({ tx, businessId, from, toExclusive, now })));
  }

  // ── The gateway log and the applied cash ──────────────────────────────────────────────
  // Two families out of one call, and they are NOT reconciled with each other — see
  // `payment-measures.ts` for why that is the point rather than a defect.
  if (paymentMeasures) {
    rows.push(...(await computePaymentMeasures({ tx, businessId, from, toExclusive })));
  }

  // ── Saved cards ───────────────────────────────────────────────────────────────────────
  // As-of-the-run only: a past period gets no row at all.
  if (cardMeasures) {
    rows.push(...(await computePaymentMethodMeasures({ tx, businessId, from, toExclusive, now })));
  }

  if (disputeMeasures) {
    rows.push(...(await computeDisputeMeasures({ tx, businessId, from, toExclusive, now })));
  }
  if (creditMeasures) {
    rows.push(...(await computeCreditMeasures({ tx, businessId, from, toExclusive, now })));
  }
  if (usageMeasures) {
    rows.push(...(await computeUsageMeasures({ tx, businessId, from, toExclusive })));
  }
  if (orderMeasures) {
    rows.push(...(await computeOrderMeasures({ tx, businessId, from, toExclusive })));
  }
  // ── The derived ratios ────────────────────────────────────────────────────────────────
  // Last, because they divide what the groups above measure — and they store BOTH halves.
  if (ratioMeasures) rows.push(...ratioRows(ratio, closing));

  // A delegated group answers its whole family in one pass, so the filter is applied once
  // at the end rather than threaded through five modules.
  if (opts.onlyNonAdditive || opts.measures) {
    return rows.filter((r) => {
      const m = measureById(r.measure);
      return m != null && wanted(m);
    });
  }
  return rows;
}

/**
 * The book's own counts — the ones the movement ledger cannot answer: a trial that started, a
 * subscription that never carried revenue, the units inside one. Read once and bucketed per
 * currency.
 *
 * `totals` are written only for a currency in `held`. The caller applies that rule once over
 * every slice: "held" is a fact about the whole book, and a slice whose own subscriptions in a
 * currency all post-date `at` (a trial dated before its row was created) would drop counts.
 */
async function bookMeasures(
  tx: Tx,
  businessId: string,
  cache: SnapshotMrrCache,
  at: Date,
  from: Date,
  toExclusive: Date,
  bookStocks: ReadonlyArray<[MeasureDef, BookStockImpl]>,
  bookFlows: ReadonlyArray<[MeasureDef, BookFlowImpl]>,
): Promise<{ rows: MetricDailyRow[]; totals: MetricDailyRow[]; held: string[] }> {
  const rows: MetricDailyRow[] = [];
  const totals: MetricDailyRow[] = [];
  const held: string[] = [];
  const push = (measure: string, dim: string, dimValue: string, currency: string, value: bigint) =>
    rows.push({ measure, dim, dimValue, currency, value });
  const total = (measure: string, currency: string, value: bigint) =>
    totals.push({ measure, dim: "", dimValue: "", currency, value });
  const book = await readBook(tx, businessId, cache);
  const byCurrency = new Map<string, BookRow[]>();
  for (const s of book) {
    const ccy = s.currency.toUpperCase();
    const list = byCurrency.get(ccy);
    if (list) list.push(s);
    else byCurrency.set(ccy, [s]);
  }

  for (const [currency, subs] of byCurrency) {
    // A currency the business did not hold yet writes nothing — the same rule the
    // snapshots follow, and for the same reason: a row of zeros would claim otherwise.
    // Once held, a flow writes its count even when it is zero.
    if (subs.some((s) => s.createdAt <= at)) held.push(currency);
    for (const [m, impl] of bookStocks) {
      let n = 0n;
      for (const s of subs) n += impl.countAt(s, at);
      total(m.id, currency, n);
    }
    for (const [m, impl] of bookFlows) {
      let n = 0n;
      const byInterval = new Map<string, bigint>();
      for (const s of subs) {
        const t = impl.stamp(s);
        if (t != null && t >= from && t < toExclusive) {
          n += 1n;
          const k = billingIntervalOf(s.billingPeriod, s.billingPeriodUnit);
          byInterval.set(k, (byInterval.get(k) ?? 0n) + 1n);
        }
      }
      total(m.id, currency, n);
      if (supportsDimension(m, "billing_interval")) {
        for (const [k, v] of byInterval) push(m.id, "billing_interval", k, currency, v);
      }
    }
  }
  return { rows, totals, held };
}

/** The fields a stock row sums. `cmrrMinor` only where the row carries it. */
interface StockSums {
  mrrMinor: bigint;
  cmrrMinor?: bigint;
  activeSubscriptions: number;
  payingSubscriptions: number;
  renewingSubscriptions: number;
}

/** Add one slice's stock rows into the running ones, by bucket. A copy is kept, never the row. */
function sumStocks<T extends StockSums>(
  into: Map<string, T>,
  rows: readonly T[],
  key: (r: T) => string,
): void {
  for (const r of rows) {
    const k = key(r);
    const cur = into.get(k);
    if (!cur) {
      into.set(k, { ...r });
      continue;
    }
    cur.mrrMinor += r.mrrMinor;
    if (cur.cmrrMinor !== undefined) cur.cmrrMinor += r.cmrrMinor!;
    cur.activeSubscriptions += r.activeSubscriptions;
    cur.payingSubscriptions += r.payingSubscriptions;
    cur.renewingSubscriptions += r.renewingSubscriptions;
  }
}

/** A null half is "nothing here" (no account ended in this slice), so it adds as nothing. */
const addHalf = (a: bigint | null | undefined, b: bigint | null | undefined) =>
  a == null ? b : b == null ? a : a + b;

/** Add one slice's rows into the running ones, by stored key. */
function sumRows(into: Map<string, MetricDailyRow>, rows: readonly MetricDailyRow[]): void {
  for (const r of rows) {
    const k = `${r.measure}\u0000${r.dim}\u0000${r.dimValue}\u0000${r.currency}`;
    const cur = into.get(k);
    if (!cur) {
      into.set(k, { ...r });
      continue;
    }
    cur.value = addHalf(cur.value, r.value) ?? null;
    if ("denominator" in r) cur.denominator = addHalf(cur.denominator, r.denominator) ?? null;
  }
}

const bookFields = {
  id: subscriptions.id,
  status: subscriptions.status,
  currency: subscriptions.currency,
  createdAt: subscriptions.createdAt,
  startDate: subscriptions.startDate,
  startedAt: subscriptions.startedAt,
  canceledAt: subscriptions.canceledAt,
  cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
  cancelScheduledAt: subscriptions.cancelScheduledAt,
  cancelBookedAt: subscriptions.cancelBookedAt,
  currentPeriodEnd: subscriptions.currentPeriodEnd,
  trialStart: subscriptions.trialStart,
  trialEnd: subscriptions.trialEnd,
  activatedAt: subscriptions.activatedAt,
  billingPeriod: subscriptions.billingPeriod,
  billingPeriodUnit: subscriptions.billingPeriodUnit,
  remainingBillingCycles: subscriptions.remainingBillingCycles,
};

/** The book, with each subscription's units folded in. One query each, never per row. */
async function readBook(tx: Tx, businessId: string, cache: SnapshotMrrCache): Promise<BookRow[]> {
  const subs = await bookAs(tx, businessId, bookFields, cache);

  const units = await tx
    .select({
      subscriptionId: subscriptionItems.subscriptionId,
      quantity: sql<string>`coalesce(sum(${subscriptionItems.quantity}), 0)`.as("quantity"),
    })
    .from(subscriptionItems)
    .where(
      and(
        eq(subscriptionItems.businessId, businessId),
        subscriptionInScope(sql`${subscriptionItems.subscriptionId}`, businessId, cache.scope),
      ),
    )
    .groupBy(subscriptionItems.subscriptionId);
  const byId = new Map(units.map((u) => [u.subscriptionId, Number(u.quantity)]));

  // `bookAs` copies are this reader's own: add the column in place, not in a second copy.
  const rows = subs as Array<(typeof subs)[number] & { quantity: number }>;
  for (const s of rows) s.quantity = byId.get(s.id) ?? 0;
  return attachLapses(rows, await lapsesForDay(tx, businessId, cache));
}
