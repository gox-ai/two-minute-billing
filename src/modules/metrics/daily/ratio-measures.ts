import { reportableCustomer } from "../reportable";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { mrrMovements, subscriptions } from "@db/schema";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import { subscriptionInScope } from "../book-scope";
import {
  attachLapses,
  bookAs,
  bookShared,
  computeSnapshot,
  earnedAt,
  endOfDay,
  lapsesForDay,
  loadLedgerMrrAt,
  loadReratedMrr,
  sharedRead,
  type SnapshotMrrCache,
  type SnapshotRow,
} from "../snapshots";
import { type StockRow, earningAt, earningFrom, startOf } from "../stocks";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * The derived ratios (Phase 7, group 5).
 *
 * Ten figures that own no facts. Each is arithmetic over the MRR ledger and the book, and
 * each is stored as its TWO HALVES — never as the quotient. `measures.ts` carries the full
 * statement of why, and of what changed about the window; this file is the arithmetic.
 *
 * The four things worth knowing before reading the code:
 *
 *  1. THE OPENING STOCK IS DATED, AND SO IS ITS RATE. Retention and the growth rate divide
 *     by what the period opened with, which is a stock at the window's FIRST instant, not a
 *     flow and not a closing value. It is evaluated at `from` with the same `liveAt`
 *     predicate every other stock uses, so "live" cannot mean one thing here and another on
 *     the MRR line — AND every row in it is valued at what it was EARNING then, never at the
 *     `subscriptions.mrr` column, which is 0 once a subscription has since cancelled and
 *     today's number once it has since changed rate. The numerator comes off the movement
 *     ledger, which is dated correctly; a present-state denominator against a dated
 *     numerator is two different books, and it let the loss exceed the opening without
 *     bound. `loadReratedMrr` is the one loader that answers "what was this earning at
 *     `at`", and a 0 it returns is a real answer — a comped account really was worth
 *     nothing — not a missing value.
 *  2. A CUSTOMER IS COUNTED ONCE. The paying-customer denominator attributes each account
 *     to the single currency carrying most of its recurring revenue. Counting it in every
 *     currency it pays in would make the per-currency denominators sum to more than the
 *     number of customers, and a converted read would then divide by a headcount that does
 *     not exist.
 *  3. RETENTION LOSES ONLY WHAT IT OPENED WITH. Gross and net retention divide by the
 *     cohort that existed at `from`, so the loss in the numerator is restricted to THAT
 *     cohort: a subscription that both arrived and left inside the window was never part of
 *     the opening and cannot reduce what the opening kept. Without the restriction the
 *     numerator counted every departure against an opening it was never in, and the
 *     published figure went negative without bound — on the worst day measured, an opening
 *     of 18,550 against 94,600 of loss, none of it from the opening cohort. The restriction
 *     establishes `opening − loss >= 0`, which is what makes the number a retention RATE.
 *     Net retention restricts its expansion half the same way and for the same reason: a
 *     new account's growth is new business, not the base retaining its value. The growth
 *     RATE does not restrict either half — it is the whole book's movement over the
 *     opening, and new business is precisely what it exists to include.
 *
 *     ⚠️ THE PRICE: gross and net retention NO LONGER FOLD, and they declare
 *     `aggregate: "none"` to say so. A subscription that starts on day 2 of a quarter and
 *     leaves on day 20 is not in the quarter's opening cohort, so the quarter must not
 *     count its loss — but it IS in day 20's opening cohort, so the day must. The day rows
 *     genuinely do not add up to the quarter, and rather than publish a fold that quietly
 *     means something else, each grain is computed against its own opening and stored under
 *     its own `grain`, exactly as the distinct counts are. A grain that was never written
 *     is reported missing rather than guessed at.
 *  4. THE ZERO DENOMINATOR IS STORED, AND PUBLISHES NULL. Nothing opened, nothing churned,
 *     nobody paying — all are measured zeros and they are written as such, because the row
 *     is a record of what was measured and 0 is what was measured. What must never happen is
 *     a quotient: the period had no opening revenue, so it has NO retention rate, and 0% is
 *     a different and false claim (it says everything was lost). The refusal to divide lives
 *     in `ratioValue`, once, rather than in every caller, and it answers null — never 0,
 *     never an Infinity, never a NaN. Storing null halves instead would lose the fact that
 *     the period was measured at all, and a reader rebuilding a longer period out of day
 *     rows needs the zeros to be there.
 */

/** The fourteen, in the order they are written. */
export const RATIO_MEASURES = [
  "gross_revenue_retention",
  "net_revenue_retention",
  "net_mrr_growth_rate",
  "quick_ratio",
  "revenue_per_new_subscription",
  "revenue_lost_per_churned_subscription",
  "revenue_per_paying_subscription",
  "revenue_per_paying_customer",
  "subscription_lifetime_value",
  "customer_lifetime_value",
  "net_new_mrr",
  "gross_mrr_churn_rate",
  "trial_conversion_rate",
  "subscriber_churn_rate",
  "mrr_top10_share",
] as const;

/**
 * HOW EACH ONE RE-AGGREGATES — the field the writer and the reader share.
 *
 * Eight of the ten are stored once, daily, and folded at read. Gross and net retention are
 * NOT: their numerator is restricted to the cohort the period opened with, and that cohort
 * is a different set at every grain (see note 3 above). They declare `none`, which is the
 * same promise the distinct counts make — computed and stored at every grain they are
 * served at, never folded out of days. `compute.ts` reads this map for its writer-side
 * declaration and `measures.ts` states the same value, so a reader that folded one of these
 * would be reading a row the writer never claimed was foldable.
 */
export const RATIO_MEASURE_AGGREGATE: Record<string, "ratio" | "none" | "sum"> = {
  gross_revenue_retention: "none",
  net_revenue_retention: "none",
  net_mrr_growth_rate: "ratio",
  quick_ratio: "ratio",
  revenue_per_new_subscription: "ratio",
  revenue_lost_per_churned_subscription: "ratio",
  revenue_per_paying_subscription: "ratio",
  revenue_per_paying_customer: "ratio",
  subscription_lifetime_value: "ratio",
  customer_lifetime_value: "ratio",
  // A plain signed flow: no quotient, so it sums like any movement.
  net_new_mrr: "sum",
  gross_mrr_churn_rate: "ratio",
  mrr_top10_share: "ratio",
  trial_conversion_rate: "ratio",
  // Its base is an opening stock PLUS a flow — no fold rebuilds that from day rows.
  subscriber_churn_rate: "none",
};

/**
 * The stored slices each emits — none.
 *
 * Deliberate, and the same refusal the published reports make: a ratio sliced by plan needs
 * BOTH halves sliced the same way, and the opening stock is not stored per plan on the
 * movement ledger. A plan split that divided a plan's churn by the whole book's opening
 * revenue would look like a breakdown and be arithmetic nonsense.
 */
export const RATIO_MEASURE_DIMS: Record<string, readonly DimensionId[]> = Object.fromEntries(
  RATIO_MEASURES.map((id) => [id, [] as readonly DimensionId[]]),
);

/** Gains and losses, by the ledger reason each carries. `resume` is a reactivation. */
const GAIN_REASONS = new Set(["new", "expansion", "reactivation", "resume"]);
const LOSS_REASONS = new Set(["contraction", "churn", "pause"]);
/** What "churned" means for the per-churn average: the subscription LEFT. */
const DEPARTURE_REASONS = new Set(["churn", "pause"]);

/** One month, for a lifetime expressed in months. The same 30 days the reports use. */
export const MONTH_MS = 30 * 86_400_000;

export interface BookSub extends StockRow {
  customerId: string;
  /** The cached PRESENT rate. Never a historical answer — ask `earningRatesAt` for that. */
  mrr: bigint | null;
  /** 0271: the rate it last carried while earning. Null where it was never recorded. */
  lastEarningMrr: bigint | null;
}

interface Half {
  value: bigint | null;
  denominator: bigint;
}

/** What one period's ratios are built from, before any division. Additive across book slices. */
export interface RatioPartial {
  /** The opening stock, per currency — see note 1 at the top of the file. */
  opening: Map<string, bigint>;
  led: Map<string, Led>;
  /** Paying customers at the close, each in one currency. */
  payingCustomers: Map<string, bigint>;
  /** Per currency: the ten largest paying customers' MRR at the close, largest first, and all of it. */
  concentration: Map<string, { top: bigint[]; total: bigint }>;
  /** Subscriptions ended by the close: their lives summed, and how many. */
  subLives: Map<string, { totalMs: bigint; n: number }>;
  /** Accounts fully ended by the close (`accountLives`). */
  accountLives: Map<string, { totalMs: bigint; n: number }>;
  trials: Map<string, TrialHalves>;
}

/** Per currency, the window's ledger: the signed net, the gained and lost magnitudes, two counts. */
interface Led {
  net: bigint;
  gained: bigint;
  lost: bigint;
  /** Of `lost`, the part the OPENING COHORT gave up. Retention's only loss. */
  lostFromOpening: bigint;
  /** Expansion, reactivation and resume — but only the OPENING COHORT's. Net retention's
   *  only gain: anyone else growing is new business. */
  expansionFromOpening: bigint;
  newMrr: bigint;
  newCount: bigint;
  departed: bigint;
  departedCount: bigint;
  /** Churn plus contraction, as a positive magnitude. Pause is not churn. */
  churnAndContraction: bigint;
}

const TOP_CUSTOMERS = 10;

export async function computeRatioMeasures(input: {
  tx: Tx;
  businessId: string;
  /** `[from, toExclusive)` — the period's window, half-open exactly as the flows. */
  from: Date;
  toExclusive: Date;
  /** The period's last day, `YYYY-MM-DD`. The stocks are read at its end. */
  periodEnd: string;
  /** The business's IANA zone — `periodEnd` is its local calendar date. Null means UTC. */
  zone?: string | null;
  /** The run's instant. A scheduled trial end later today has not happened yet. */
  now?: Date;
  /** The period's shared reads, from `computeMetricPeriod`. */
  cache?: SnapshotMrrCache;
}): Promise<MetricDailyRow[]> {
  const close = await computeSnapshot(
    input.tx,
    input.businessId,
    input.periodEnd,
    input.cache,
    input.zone,
  );
  return ratioRows(await ratioPartial(input), close);
}

/**
 * Everything the ratios need from the book and the window's ledger, for the slice of the book
 * `cache.scope` names (the whole book without one). The closing stock is NOT here: it is the
 * snapshot reader's, and the caller hands it to `ratioRows`.
 */
export async function ratioPartial(input: {
  tx: Tx;
  businessId: string;
  from: Date;
  toExclusive: Date;
  periodEnd: string;
  zone?: string | null;
  now?: Date;
  cache?: SnapshotMrrCache;
}): Promise<RatioPartial> {
  const { tx, businessId, from, toExclusive, periodEnd, zone, cache } = input;
  const now = input.now ?? new Date();
  const closeAt = endOfDay(periodEnd, zone);

  const book = await readBookWithCustomers(tx, businessId, cache);

  // ── The opening stock, per currency ───────────────────────────────────────────────────
  // At `from` itself — the window's first instant, which is the previous period's close —
  // and every row valued at the rate IT held then. See note 1 at the top of the file.
  // The previous period's CLOSE (its last millisecond, read inclusively like every close), not
  // `from`: a movement stamped at `from` is this window's flow and must not also be its opening.
  const openAt = new Date(from.getTime() - 1);
  const openingRates = await earningRatesAt(tx, businessId, book, openAt, cache);
  const opening = new Map<string, bigint>();
  /**
   * WHO the opening stock was — not just what it was worth.
   *
   * Retention divides by this cohort, so it may only be reduced by this cohort. The set is
   * the exact population the sum above is taken over, built in the same pass, so the
   * denominator and the numerator's restriction cannot come from two different readings of
   * the book.
   */
  const openingCohort = new Set<string>();
  // A subscription with ledger rows is in the cohort only if its balance then was above zero:
  // `earningAt` reads TODAY's status, so a line paused at the opening and resumed since would
  // otherwise count its resume as the base's own growth. The status test stays for rows the
  // ledger never saw (a comped line earns 0 and writes nothing).
  const ledgerAtOpen = await loadLedgerMrrAt(tx, businessId, openAt, cache);
  for (const s of book) {
    const earned = earningMrr(s, openingRates);
    if (earned === 0n && (ledgerAtOpen.has(s.id) || !earningAt(s, openAt))) continue;
    const c = s.currency.toUpperCase();
    opening.set(c, (opening.get(c) ?? 0n) + earned);
    openingCohort.add(s.id);
  }

  // Paying CUSTOMERS, each in one currency only — see the note at the top of the file, and
  // rated at the close, so someone who has since churned is still counted for the periods
  // they were paying in.
  const closingRates = await earningRatesAt(tx, businessId, book, closeAt, cache);
  const payingCustomers = countPayingCustomers(book, closeAt, closingRates);
  const concentration = topCustomerLists(book, closingRates, TOP_CUSTOMERS);

  // ── The ledger, across the window ─────────────────────────────────────────────────────
  /**
   * Grouped by SUBSCRIPTION as well as by reason, because retention has to ask of every
   * loss whether the opening cohort owned it. One scan still, and the per-reason totals
   * below are summed back out of these groups rather than read from a second query — two
   * queries over the same rows is how a numerator and its restriction come to disagree.
   * Only the slice's own subscriptions: each movement is counted in exactly one slice.
   */
  const movements = await tx
    .select({
      reason: mrrMovements.reason,
      currency: mrrMovements.currency,
      subscriptionId: mrrMovements.subscriptionId,
      delta: sql<string>`coalesce(sum(${mrrMovements.deltaMinor}), 0)`.as("delta"),
    })
    .from(mrrMovements)
    .where(
      and(
        and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
        gte(mrrMovements.occurredAt, from),
        lt(mrrMovements.occurredAt, toExclusive),
        subscriptionInScope(sql`${mrrMovements.subscriptionId}`, businessId, cache?.scope),
      ),
    )
    .groupBy(mrrMovements.reason, mrrMovements.currency, mrrMovements.subscriptionId);

  const led = new Map<string, Led>();
  for (const r of movements) {
    const c = r.currency.toUpperCase();
    // `delta_minor` is SIGNED on the ledger — a loss is already negative — so the net is a
    // plain sum and a magnitude is its absolute value. Nothing here re-signs anything.
    const delta = BigInt(r.delta);
    const l = ledFor(led, c);
    // Was this subscription part of what the window opened with? Only its movements may
    // touch retention — see note 3 at the top of the file.
    const opened = openingCohort.has(r.subscriptionId);
    l.net += delta;
    if (GAIN_REASONS.has(r.reason)) l.gained += delta;
    if (LOSS_REASONS.has(r.reason)) {
      l.lost += -delta;
      if (opened) l.lostFromOpening += -delta;
    }
    if (r.reason === "expansion" || r.reason === "reactivation" || r.reason === "resume") {
      if (opened) l.expansionFromOpening += delta;
    }
    // Counted per SUBSCRIPTION, by its net for the reason: a trial books `new` and reverses it
    // at trial start, so counting ledger rows put every unconverted trial in the denominator.
    if (r.reason === "new") {
      l.newMrr += delta;
      if (delta > 0n) l.newCount += 1n;
    }
    if (DEPARTURE_REASONS.has(r.reason)) {
      l.departed += -delta;
      if (delta < 0n) l.departedCount += 1n;
    }
    if (r.reason === "churn" || r.reason === "contraction") l.churnAndContraction += -delta;
  }

  // The trial and subscriber book: currencies the business held a subscription in by the
  // window's end, which may include one that never carried revenue (trials only).
  const trials = trialAndSubscriberHalves(
    await readTrialBook(tx, businessId, cache),
    from,
    toExclusive,
    now,
  );

  return {
    opening,
    led,
    payingCustomers,
    concentration,
    // The lifetimes, as at the period's end.
    subLives: subscriptionLives(book, closeAt),
    accountLives: accountLives(book, closeAt),
    trials,
  };
}

const ledFor = (led: Map<string, Led>, c: string): Led => {
  let l = led.get(c);
  if (!l) {
    l = {
      net: 0n,
      gained: 0n,
      lost: 0n,
      lostFromOpening: 0n,
      expansionFromOpening: 0n,
      newMrr: 0n,
      newCount: 0n,
      departed: 0n,
      departedCount: 0n,
      churnAndContraction: 0n,
    };
    led.set(c, l);
  }
  return l;
};

/** A partial with nothing in it, to fold slices into — never one slice's own maps, which are shared. */
export const emptyRatioPartial = (): RatioPartial => ({
  opening: new Map(),
  led: new Map(),
  payingCustomers: new Map(),
  concentration: new Map(),
  subLives: new Map(),
  accountLives: new Map(),
  trials: new Map(),
});

const addLives = (
  into: Map<string, { totalMs: bigint; n: number }>,
  from: ReadonlyMap<string, { totalMs: bigint; n: number }>,
) => {
  for (const [c, v] of from) {
    const cur = into.get(c);
    into.set(c, { totalMs: (cur?.totalMs ?? 0n) + v.totalMs, n: (cur?.n ?? 0) + v.n });
  }
};

/**
 * Fold one slice's partial into `into` (from `emptyRatioPartial`). Every part is a sum over subscriptions or over
 * accounts, and a slice holds whole accounts, so the fold is exact; the top ten are re-cut
 * from the union of each slice's ten.
 */
export function mergeRatioPartials(into: RatioPartial, p: RatioPartial): RatioPartial {
  for (const [c, v] of p.opening) into.opening.set(c, (into.opening.get(c) ?? 0n) + v);
  for (const [c, v] of p.led) {
    const l = ledFor(into.led, c);
    for (const k of Object.keys(v) as Array<keyof Led>) l[k] += v[k];
  }
  for (const [c, v] of p.payingCustomers)
    into.payingCustomers.set(c, (into.payingCustomers.get(c) ?? 0n) + v);
  for (const [c, v] of p.concentration) {
    const cur = into.concentration.get(c);
    into.concentration.set(
      c,
      cur
        ? {
            top: [...cur.top, ...v.top].sort(desc).slice(0, TOP_CUSTOMERS),
            total: cur.total + v.total,
          }
        : v,
    );
  }
  addLives(into.subLives, p.subLives);
  addLives(into.accountLives, p.accountLives);
  for (const [c, h] of p.trials) {
    const cur = into.trials.get(c);
    into.trials.set(c, {
      converted: (cur?.converted ?? 0n) + h.converted,
      ended: (cur?.ended ?? 0n) + h.ended,
      churned: (cur?.churned ?? 0n) + h.churned,
      base: (cur?.base ?? 0n) + h.base,
    });
  }
  return into;
}

const desc = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);

/** The stored rows, from a whole book's partial and its closing snapshot. */
export function ratioRows(p: RatioPartial, close: readonly SnapshotRow[]): MetricDailyRow[] {
  // MRR and the paying count are DELEGATED to the snapshot reader rather than re-derived:
  // a second definition of "paying" is exactly what the semantic layer exists to prevent.
  const closingMrr = new Map<string, bigint>();
  const closingPaying = new Map<string, bigint>();
  for (const r of close) {
    closingMrr.set(r.currency, r.mrrMinor);
    closingPaying.set(r.currency, BigInt(r.payingSubscriptions));
  }
  const subLife = new Map<string, number | null>();
  for (const [c, l] of p.subLives)
    subLife.set(c, l.n > 0 ? Number(l.totalMs) / MONTH_MS / l.n : null);
  const customerLife = new Map<string, number | null>();
  for (const [c, l] of p.accountLives) {
    customerLife.set(
      c,
      l.n > 0 ? Math.round((Number(l.totalMs) / l.n / MONTH_MS) * 10) / 10 : null,
    );
  }

  /**
   * Which currencies get a row: any the business had revenue in at either edge of the
   * window, or moved revenue in across it. A currency it has never touched writes nothing —
   * the same rule the stocks follow, for the same reason.
   */
  const held = new Set<string>([...p.opening.keys(), ...closingMrr.keys(), ...p.led.keys()]);

  const rows: MetricDailyRow[] = [];
  const push = (measure: string, currency: string, half: Half) =>
    rows.push({
      measure,
      dim: "",
      dimValue: "",
      currency,
      value: half.value,
      denominator: half.denominator,
    });

  for (const currency of held) {
    const open = p.opening.get(currency) ?? 0n;
    const l = ledFor(p.led, currency);
    const mrr = closingMrr.get(currency) ?? 0n;
    const paying = closingPaying.get(currency) ?? 0n;
    const heads = p.payingCustomers.get(currency) ?? 0n;

    /**
     * Retention is stored as the period's own ratio — what the opening cohort still had
     * over what it opened with — so a single stored row divides to that period's rate and
     * nothing else does. Both halves are about ONE population, and the numerator can
     * therefore never leave [0, opening] for gross retention: the cohort cannot lose more
     * than it had. Neither figure folds; each grain is written against its own opening.
     */
    push("gross_revenue_retention", currency, {
      value: open - l.lostFromOpening,
      denominator: open,
    });
    push("net_revenue_retention", currency, {
      value: open + l.expansionFromOpening - l.lostFromOpening,
      denominator: open,
    });
    // The growth rate is the WHOLE book's movement over the opening — new business
    // included, which is the difference between growing and retaining — so it restricts
    // neither half, stays additive, and is still folded out of day rows.
    push("net_mrr_growth_rate", currency, { value: l.net, denominator: open });
    // Both halves are flows here, so both simply sum.
    push("quick_ratio", currency, { value: l.gained, denominator: l.lost });
    push("revenue_per_new_subscription", currency, {
      value: l.newMrr,
      denominator: l.newCount,
    });
    push("revenue_lost_per_churned_subscription", currency, {
      value: l.departed,
      denominator: l.departedCount,
    });
    // …and both halves are stocks here, so both take the period's last day.
    push("revenue_per_paying_subscription", currency, { value: mrr, denominator: paying });
    push("revenue_per_paying_customer", currency, { value: mrr, denominator: heads });
    const conc = p.concentration.get(currency);
    push("mrr_top10_share", currency, {
      value: conc ? conc.top.reduce((x, y) => x + y, 0n) : 0n,
      denominator: conc?.total ?? 0n,
    });
    /**
     * A lifetime value is revenue-per-head times a life. The life is folded INTO the
     * numerator so the stored pair is still a plain ratio a reader can divide; a null life
     * makes the numerator null — "nothing has ended yet", which is not the same claim as a
     * lifetime value of zero.
     */
    const months = subLife.get(currency);
    push("subscription_lifetime_value", currency, {
      value: months == null ? null : BigInt(Math.round(Number(mrr) * months)),
      denominator: paying,
    });
    const heads_months = customerLife.get(currency);
    push("customer_lifetime_value", currency, {
      value: heads_months == null ? null : BigInt(Math.round(Number(mrr) * heads_months)),
      denominator: heads,
    });
    // Every reason, signed — so it equals the MRR change the growth rate divides.
    rows.push({ measure: "net_new_mrr", dim: "", dimValue: "", currency, value: l.net });
    push("gross_mrr_churn_rate", currency, { value: l.churnAndContraction, denominator: open });
  }

  for (const [currency, h] of p.trials) {
    push("trial_conversion_rate", currency, { value: h.converted, denominator: h.ended });
    push("subscriber_churn_rate", currency, { value: h.churned, denominator: h.base });
  }

  return rows;
}

/** The book with the activation stamp, read apart so the shared book keeps its own reading. */
interface TrialRow extends StockRow {
  activatedAt: Date | null;
}

const trialFields = {
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

async function readTrialBook(
  tx: Tx,
  businessId: string,
  cache?: SnapshotMrrCache,
): Promise<TrialRow[]> {
  if (cache) return bookShared(tx, businessId, trialFields, cache);
  return tx
    .select(trialFields)
    .from(subscriptions)
    .where(
      and(
        and(eq(subscriptions.businessId, businessId), reportableCustomer(subscriptions.customerId)),
        notDeleted(),
      ),
    );
}

/** Statuses a subscriber can hold, now or at a past instant. Same pair the active count uses. */
const SUBSCRIBER_STATUSES = new Set(["active", "cancelled"]);

/**
 * When a subscription became a subscriber — past any trial — or null if it never did: a trial
 * cancelled before converting, or an open-ended one never activated.
 */
export function subscriberFrom(s: TrialRow): Date | null {
  if (!SUBSCRIBER_STATUSES.has(s.status)) return null;
  if (s.trialStart == null) return startOf(s);
  const stop = s.canceledAt;
  const a = s.activatedAt;
  const converted = a != null && a >= s.trialStart && (stop == null || a < stop);
  if (s.trialEnd == null) return converted ? a : null;
  if (stop != null && stop <= s.trialEnd && !converted) return null;
  return earningFrom(s);
}

/**
 * Per currency: trials converted and ended, and subscribers lost over those there were to lose.
 *
 * A trial ends at the earliest of its end date, its activation and its cancellation; its
 * conversion is dated by the activation alone. Nothing after `now` has happened yet.
 */
/** Per currency: trials converted over trials ended, subscribers lost over those there were. */
export interface TrialHalves {
  converted: bigint;
  ended: bigint;
  churned: bigint;
  base: bigint;
}

export function trialAndSubscriberHalves(
  book: readonly TrialRow[],
  from: Date,
  toExclusive: Date,
  now: Date,
): Map<string, TrialHalves> {
  const inWindow = (t: Date | null): t is Date =>
    t != null && t >= from && t < toExclusive && t <= now;
  const out = new Map<string, TrialHalves>();
  for (const s of book) {
    if (s.createdAt >= toExclusive) continue;
    const c = s.currency.toUpperCase();
    const h = out.get(c) ?? { converted: 0n, ended: 0n, churned: 0n, base: 0n };
    out.set(c, h);

    if (s.trialStart != null) {
      const trialStart = s.trialStart;
      const activated = s.activatedAt != null && s.activatedAt >= trialStart ? s.activatedAt : null;
      if (inWindow(activated)) h.converted += 1n;
      let endedAt: Date | null = null;
      for (const t of [s.trialEnd, activated, s.canceledAt]) {
        if (t != null && t >= trialStart && (endedAt == null || t < endedAt)) endedAt = t;
      }
      if (inWindow(endedAt)) h.ended += 1n;
    }

    // Opening subscribers plus those who became one inside the window; only they can churn.
    const since = subscriberFrom(s);
    if (since == null) continue;
    const stop = s.canceledAt;
    const opening = since <= from && (stop == null || stop > from);
    const joined = inWindow(since) && since > from && (stop == null || stop > since);
    if (!opening && !joined) continue;
    h.base += 1n;
    if (inWindow(stop)) h.churned += 1n;
  }
  return out;
}

const bookWithCustomerFields = {
  id: subscriptions.id,
  customerId: subscriptions.customerId,
  status: subscriptions.status,
  currency: subscriptions.currency,
  mrr: subscriptions.mrr,
  lastEarningMrr: subscriptions.lastEarningMrr,
  createdAt: subscriptions.createdAt,
  startDate: subscriptions.startDate,
  startedAt: subscriptions.startedAt,
  canceledAt: subscriptions.canceledAt,
  cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
  cancelScheduledAt: subscriptions.cancelScheduledAt,
  cancelBookedAt: subscriptions.cancelBookedAt,
  currentPeriodEnd: subscriptions.currentPeriodEnd,
  trialEnd: subscriptions.trialEnd,
  trialStart: subscriptions.trialStart,
  billingPeriod: subscriptions.billingPeriod,
  billingPeriodUnit: subscriptions.billingPeriodUnit,
  remainingBillingCycles: subscriptions.remainingBillingCycles,
};

/** The book, with the customer each subscription belongs to. One query, never per row. */
export function readBookWithCustomers(
  tx: Tx,
  businessId: string,
  cache?: SnapshotMrrCache,
): Promise<BookSub[]> {
  return sharedRead(cache, "bookWithCustomers", async () => {
    const rows = cache
      ? await bookAs(tx, businessId, bookWithCustomerFields, cache)
      : await tx
          .select(bookWithCustomerFields)
          .from(subscriptions)
          .where(
            and(
              and(
                eq(subscriptions.businessId, businessId),
                reportableCustomer(subscriptions.customerId),
              ),
              notDeleted(),
            ),
          );
    return attachLapses(rows, await lapsesForDay(tx, businessId, cache));
  });
}

/**
 * What every row in the book was EARNING at `at`, per subscription id.
 *
 * The whole of the historical correction lives in this one call. `subscriptions.mrr` is a
 * cache of the present: it reads 0 for anything since cancelled and today's number for
 * anything since re-rated, so summing it at a past instant measures today's book and dates
 * it yesterday. `loadReratedMrr` answers for the instant asked — the stored last-earning
 * rate where 0271 recorded one, else re-rated from the subscription's own items.
 *
 * The ledger balance at `at` where the subscription has ledger rows (`earnedAt`), so a later
 * rate change is not projected backwards. A missing entry means it earned nothing then.
 */
export function earningRatesAt(
  tx: Tx,
  businessId: string,
  book: readonly BookSub[],
  at: Date,
  cache?: SnapshotMrrCache,
): Promise<Map<string, bigint>> {
  const rate = async () => {
    const rated = await loadReratedMrr(tx, businessId, book as BookSub[], at, cache);
    return earnedAt(book, await loadLedgerMrrAt(tx, businessId, at, cache), rated, at);
  };
  if (!cache) return rate();
  // Keyed by the book too: the rating depends on which columns its rows carry.
  const byInstant = ratesByBook.get(book) ?? new Map<number, Promise<Map<string, bigint>>>();
  ratesByBook.set(book, byInstant);
  let p = byInstant.get(at.getTime());
  if (!p) byInstant.set(at.getTime(), (p = rate()));
  return p;
}
const ratesByBook = new WeakMap<object, Map<number, Promise<Map<string, bigint>>>>();

/** One row's earnings out of that map. */
export const earningMrr = (s: BookSub, rates: Map<string, bigint>): bigint => rates.get(s.id) ?? 0n;

/**
 * Customers carrying recurring revenue at an instant, counted ONCE each.
 *
 * Valued at what each line was earning AT `at`, not at the present column: at a past instant
 * the column reads 0 for everyone who has since churned, which dropped them from the count
 * and inflated `revenue_per_paying_customer` for every past period.
 *
 * The currency a customer lands in is the one carrying most of its revenue, ties broken by
 * the currency code so the answer is deterministic. The consequence is the property that
 * makes a converted read honest: summing the per-currency denominators gives the number of
 * distinct paying customers exactly, not a number inflated by whoever pays in two.
 */
export function countPayingCustomers(
  book: readonly BookSub[],
  at: Date,
  /** Rates AT `at`, from `earningRatesAt`. Required: the column would exclude the churned. */
  rates: Map<string, bigint>,
): Map<string, bigint> {
  const perCustomer = new Map<string, Map<string, bigint>>();
  for (const s of book) {
    const mrrMinor = earningMrr(s, rates);
    if (mrrMinor <= 0n) continue;
    const c = s.currency.toUpperCase();
    const byCcy = perCustomer.get(s.customerId) ?? new Map<string, bigint>();
    byCcy.set(c, (byCcy.get(c) ?? 0n) + mrrMinor);
    perCustomer.set(s.customerId, byCcy);
  }
  const out = new Map<string, bigint>();
  for (const byCcy of perCustomer.values()) {
    let best: string | null = null;
    let bestAmount = -1n;
    for (const [c, amount] of [...byCcy].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (amount > bestAmount) {
        best = c;
        bestAmount = amount;
      }
    }
    if (best) out.set(best, (out.get(best) ?? 0n) + 1n);
  }
  return out;
}

/**
 * Per currency: the MRR of the `n` largest paying customers, largest first, and of all of them.
 * Both come off the same per-customer sums, so the share cannot pass 100%. A customer paying in
 * two currencies ranks in each.
 */
export function topCustomerLists(
  book: readonly BookSub[],
  rates: Map<string, bigint>,
  n: number,
): Map<string, { top: bigint[]; total: bigint }> {
  const byCcy = new Map<string, Map<string, bigint>>();
  for (const s of book) {
    const mrrMinor = earningMrr(s, rates);
    if (mrrMinor <= 0n) continue;
    const c = s.currency.toUpperCase();
    const perCustomer = byCcy.get(c) ?? new Map<string, bigint>();
    perCustomer.set(s.customerId, (perCustomer.get(s.customerId) ?? 0n) + mrrMinor);
    byCcy.set(c, perCustomer);
  }
  const out = new Map<string, { top: bigint[]; total: bigint }>();
  for (const [c, perCustomer] of byCcy) {
    const amounts = [...perCustomer.values()].sort(desc);
    out.set(c, { top: amounts.slice(0, n), total: amounts.reduce((x, y) => x + y, 0n) });
  }
  return out;
}

/** A subscription's own start — the term where there is one, else when it appeared. */
export const startOfSub = (s: BookSub): Date => s.startedAt ?? s.startDate ?? s.createdAt;

/**
 * The lives of the subscriptions that had ENDED by `at`, per currency: summed in milliseconds
 * (exact, so any order of summing gives one answer) and counted — the two halves of the average.
 *
 * Only ended subscriptions have a life to measure. Including the living would report a young
 * book as short-lived, and a currency with nothing ended yet has no average: "not yet" and
 * "they last no time" are different statements.
 */
function subscriptionLives(
  book: readonly BookSub[],
  at: Date,
): Map<string, { totalMs: bigint; n: number }> {
  const out = new Map<string, { totalMs: bigint; n: number }>();
  for (const s of book) {
    if (s.canceledAt == null || s.canceledAt > at) continue;
    const c = s.currency.toUpperCase();
    const acc = out.get(c) ?? { totalMs: 0n, n: 0 };
    acc.totalMs += BigInt(s.canceledAt.getTime() - startOfSub(s).getTime());
    acc.n += 1;
    out.set(c, acc);
  }
  return out;
}

/** Statuses that mean the account is still there — a pause suspends, it does not end. */
export const OPEN_STATUSES = new Set(["future", "in_trial", "active", "paused"]);

/**
 * How long each FULLY ENDED account ran, summed — the two halves of the average life.
 *
 * Account grain: a customer's life runs from their first subscription starting to their
 * last one cancelling, however many sat in between. An account with anything still open has
 * no length yet and is in neither half. Returned as a total and a count rather than a mean,
 * because `average_customer_lifetime` stores exactly those two halves and dividing early
 * would make a quarter the mean of its months.
 *
 * The account's currency is the one most of its subscriptions were denominated in, so an
 * account is measured once rather than once per currency.
 *
 * Memoized per book and instant: the result is shared, so callers must not mutate it.
 */
export function accountLives(
  book: readonly BookSub[],
  at: Date,
): Map<string, { totalMs: bigint; n: number }> {
  let memo = livesByBook.get(book);
  if (!memo) livesByBook.set(book, (memo = { accounts: accountsOf(book), byAt: new Map() }));
  let out = memo.byAt.get(at.getTime());
  if (out) return out;
  out = new Map<string, { totalMs: bigint; n: number }>();
  memo.byAt.set(at.getTime(), out);
  const atMs = at.getTime();
  for (const acc of memo.accounts) {
    // Cancelled after the instant asked about — the account was still running then.
    if (acc.open || acc.lastCancel == null || acc.lastCancel > atMs) continue;
    if (acc.first === Infinity) continue;
    const cur = out.get(acc.currency) ?? { totalMs: 0n, n: 0 };
    cur.totalMs += BigInt(Math.max(0, acc.lastCancel) - acc.first);
    cur.n += 1;
    out.set(acc.currency, cur);
  }
  return out;
}

interface Account {
  /** Anything in a still-open status: open at every instant. */
  open: boolean;
  first: number;
  /** Latest `canceledAt` of any of its subscriptions; the account ended there if it is past. */
  lastCancel: number | null;
  currency: string;
}

const livesByBook = new WeakMap<
  readonly BookSub[],
  { accounts: Account[]; byAt: Map<number, Map<string, { totalMs: bigint; n: number }>> }
>();

/** The instant-independent half of `accountLives`, once per book. */
function accountsOf(book: readonly BookSub[]): Account[] {
  const perCustomer = new Map<
    string,
    { open: boolean; first: number; lastCancel: number | null; byCcy: Map<string, number> }
  >();
  for (const s of book) {
    const c = s.currency.toUpperCase();
    const acc = perCustomer.get(s.customerId) ?? {
      open: false,
      first: Infinity,
      lastCancel: null,
      byCcy: new Map<string, number>(),
    };
    if (OPEN_STATUSES.has(s.status)) acc.open = true;
    acc.first = Math.min(acc.first, startOfSub(s).getTime());
    if (s.canceledAt != null) {
      const t = s.canceledAt.getTime();
      // An invalid date compares false both ways, which always read as "still running".
      if (Number.isNaN(t)) acc.open = true;
      else acc.lastCancel = Math.max(acc.lastCancel ?? -Infinity, t);
    }
    acc.byCcy.set(c, (acc.byCcy.get(c) ?? 0) + 1);
    perCustomer.set(s.customerId, acc);
  }
  return [...perCustomer.values()].map((a) => ({
    open: a.open,
    first: a.first,
    lastCancel: a.lastCancel,
    currency: [...a.byCcy].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]![0],
  }));
}
