import { reportableCustomer } from "../reportable";
import { and, eq, lt, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { mrrMovements } from "@db/schema";
import { endOfDay, type SnapshotMrrCache } from "../snapshots";
import { inScope, type BookScope } from "../book-scope";
import { isActiveAt } from "../stocks";
import type { DimensionId } from "./measures";
import {
  accountLives,
  countPayingCustomers,
  earningMrr,
  earningRatesAt,
  readBookWithCustomers,
  type BookSub,
} from "./ratio-measures";
import type { MetricDailyRow } from "./write";

/**
 * The customer grain (Phase 7, group 6) — the eight figures counted in ACCOUNTS.
 *
 * Every group before this one counted events or money, and both are additive: a month is
 * the sum of its days. These count PEOPLE, and a person counted in January and again in
 * February is one person over the two months. That single fact decides everything here.
 *
 * ── THE FOUR WINDOW COUNTS ARE STORED AT EVERY GRAIN THEY ARE SERVED AT ──────────────
 * `customers_new`, `customers_churned`, `customers_moved` and `customer_churn_rate` ask a
 * question about a WINDOW, and there is no arithmetic that turns days into them. They
 * declare `aggregate: "none"`, which is a promise the reader keeps: a grain that was never
 * written is reported as missing, never folded up out of finer rows. `metric_daily` carries
 * `grain` + `period_end` for exactly this, and this group is the first thing to use it.
 *
 * ── THE FOUR INSTANT FIGURES ARE NOT ───────────────────────────────────────────────────
 * `active_customers` and `paying_customers` are distinct counts too, but AT AN INSTANT: a
 * month's figure is the figure on its last day, which is what `last` already means. Nothing
 * is ever re-added, so nobody is ever double-counted, and the measure stays readable across
 * businesses — which `none` would refuse for no gain. `subscriptions_per_customer` and
 * `average_customer_lifetime` divide two such instants and are stored as their two halves.
 *
 * ── A CUSTOMER IS COUNTED ONCE ─────────────────────────────────────────────────────────
 * The convention the ratios established, applied to a whole group: an account is attributed
 * to ONE currency, so the per-currency rows still sum to the number of distinct accounts.
 * The flows attribute by the currency carrying most of the account's recurring-revenue
 * movement; the instant figures by the currency carrying most of what it holds now. The
 * published reports do not do this — asked for one currency they count an account reached by
 * that currency, so running them per currency counts a two-currency account twice. That
 * divergence is asserted by the gate rather than tolerated.
 *
 * ── ONE DEFINITION, NOT TWO ────────────────────────────────────────────────────────────
 * `active_customers` is the customer grain of `active_subscriptions` and uses its predicate;
 * `paying_customers` is the denominator `revenue_per_paying_customer` already divides by and
 * calls the same function; `average_customer_lifetime` is the life
 * `customer_lifetime_value` already multiplies by. Three figures that could have drifted,
 * and cannot.
 */

/** The five that answer for a WINDOW and cannot be folded out of finer rows. */
export const CUSTOMER_DISTINCT_MEASURES = [
  "customers_new",
  "customers_churned",
  "customers_moved",
  "customer_churn_rate",
  "customers_reactivated",
] as const;

/** The four that answer for an INSTANT — a stock, or a ratio of two stocks. */
export const CUSTOMER_INSTANT_MEASURES = [
  "active_customers",
  "paying_customers",
  "subscriptions_per_customer",
  "average_customer_lifetime",
] as const;

/** The nine, in the order they are written. */
export const CUSTOMER_MEASURES = [
  ...CUSTOMER_DISTINCT_MEASURES,
  ...CUSTOMER_INSTANT_MEASURES,
] as const;

/**
 * HOW THE WRITER MATERIALISES EACH ONE — stated here, paired against the registry's own
 * `aggregate` in `assertRegistryImplemented`. Two independent statements, so a registry that
 * relabelled a distinct count as additive would turn the pairing red rather than pass.
 */
export const CUSTOMER_MEASURE_AGGREGATE: Record<string, "none" | "last" | "ratio"> = {
  // Written separately at every grain served, because no fold produces them.
  customers_new: "none",
  customers_churned: "none",
  customers_moved: "none",
  customer_churn_rate: "none",
  customers_reactivated: "none",
  // Taken at the period's last instant, so the last stored row IS the period's answer.
  active_customers: "last",
  paying_customers: "last",
  // Two instants, stored as two halves and divided at read.
  subscriptions_per_customer: "ratio",
  average_customer_lifetime: "ratio",
};

/**
 * The stored slices each emits — none.
 *
 * A head count cannot be cut by plan without saying which plan a two-plan account belongs
 * to, and any answer to that makes the slices stop summing to the total. The published
 * reports refuse the same cut, for the same reason.
 */
export const CUSTOMER_MEASURE_DIMS: Record<string, readonly DimensionId[]> = Object.fromEntries(
  CUSTOMER_MEASURES.map((id) => [id, [] as readonly DimensionId[]]),
);

/** One account's ledger, folded to what the four window counts need. */
interface Account {
  /** The first instant this account ever carried a recurring-revenue movement. */
  firstAt: number;
  /** Per currency: what it opened the window with, what it closed with, and its weight. */
  byCurrency: Map<string, { opening: bigint; closing: bigint; weight: bigint }>;
  movementsInWindow: number;
  churnsInWindow: number;
  /** Revenue gains inside the window — a positive netted move. */
  gainsInWindow: number;
  /** Churn moves BEFORE the window: an account at zero with none of these only paused. */
  churnsBefore: number;
}

export async function computeCustomerMeasures(input: {
  tx: Tx;
  businessId: string;
  /** `[from, toExclusive)` — the period's window, half-open exactly as the flows. */
  from: Date;
  toExclusive: Date;
  /** The period's last day, `YYYY-MM-DD`. The instant figures are read at its end. */
  periodEnd: string;
  /** The business's IANA zone — `periodEnd` is its local calendar date. Null means UTC. */
  zone?: string | null;
  /** The period's shared reads, from `computeMetricPeriod`. */
  cache?: SnapshotMrrCache;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive, periodEnd, zone, cache } = input;
  const closeAt = endOfDay(periodEnd, zone);

  const rows: MetricDailyRow[] = [];
  const push = (
    measure: string,
    currency: string,
    value: bigint | null,
    denominator?: bigint | null,
  ) =>
    rows.push({
      measure,
      dim: "",
      dimValue: "",
      currency,
      value,
      ...(denominator === undefined ? {} : { denominator }),
    });

  await windowCounts(tx, businessId, from, toExclusive, push, cache?.scope);
  const book = await readBookWithCustomers(tx, businessId, cache);
  // Rated AT the close, never off the present column: at a past instant the column reads 0
  // for everyone who has since churned, and they were paying then.
  instantCounts(book, closeAt, await earningRatesAt(tx, businessId, book, closeAt, cache), push);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// The four window counts, off the movement ledger.
// ─────────────────────────────────────────────────────────────────────────────

type Push = (
  measure: string,
  currency: string,
  value: bigint | null,
  denominator?: bigint | null,
) => void;

async function windowCounts(
  tx: Tx,
  businessId: string,
  from: Date,
  toExclusive: Date,
  push: Push,
  /** One slice of the book: its accounts only, each counted in exactly one slice. */
  scope?: BookScope | null,
): Promise<void> {
  /**
   * One grouped read answers all four.
   *
   * Everything the account ever did UP TO the window's end is in scope, because three of the
   * four need history the window itself does not carry: whether this is the first revenue
   * the account ever had, what it held when the window opened, and whether it held anything
   * when the window closed. Bounding the read at `toExclusive` is safe for all three — a
   * movement after the window cannot change any of them.
   */
  // Netted per subscription, instant and reason first, and a net of zero dropped: a restated
  // row (see `repair-backfilled-movement-rates.ts`) cancels the row it corrects, and a
  // subscription whose rows all cancel never carried revenue, so it is no account at all.
  // The writer never appends a zero move, so nothing else nets away.
  const moves = tx
    .select({
      customerId: mrrMovements.customerId,
      currency: mrrMovements.currency,
      occurredAt: mrrMovements.occurredAt,
      reason: mrrMovements.reason,
      delta: sql<string>`sum(${mrrMovements.deltaMinor})`.as("delta"),
    })
    .from(mrrMovements)
    .where(
      and(
        and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
        lt(mrrMovements.occurredAt, toExclusive),
        inScope(sql`${mrrMovements.customerId}`, scope),
      ),
    )
    .groupBy(
      mrrMovements.subscriptionId,
      mrrMovements.customerId,
      mrrMovements.currency,
      mrrMovements.occurredAt,
      mrrMovements.reason,
    )
    .having(sql`sum(${mrrMovements.deltaMinor}) <> 0`)
    .as("moves");

  const grouped = await tx
    .select({
      customerId: moves.customerId,
      currency: moves.currency,
      firstAt: sql<string>`min(${moves.occurredAt})`.as("first_at"),
      opening:
        sql<string>`coalesce(sum(${moves.delta}) filter (where ${moves.occurredAt} < ${from.toISOString()}::timestamptz), 0)`.as(
          "opening",
        ),
      closing: sql<string>`coalesce(sum(${moves.delta}), 0)`.as("closing"),
      weight: sql<string>`coalesce(sum(abs(${moves.delta})), 0)`.as("weight"),
      inWindow:
        sql<string>`count(*) filter (where ${moves.occurredAt} >= ${from.toISOString()}::timestamptz)`.as(
          "in_window",
        ),
      churns:
        sql<string>`count(*) filter (where ${moves.occurredAt} >= ${from.toISOString()}::timestamptz and ${moves.reason} = 'churn')`.as(
          "churns",
        ),
      gains:
        sql<string>`count(*) filter (where ${moves.occurredAt} >= ${from.toISOString()}::timestamptz and ${moves.delta} > 0)`.as(
          "gains",
        ),
      churnsBefore:
        sql<string>`count(*) filter (where ${moves.occurredAt} < ${from.toISOString()}::timestamptz and ${moves.reason} = 'churn')`.as(
          "churns_before",
        ),
    })
    .from(moves)
    .groupBy(moves.customerId, moves.currency);

  const accounts = new Map<string, Account>();
  const held = new Set<string>();
  for (const r of grouped) {
    if (r.customerId == null) continue;
    const c = r.currency.toUpperCase();
    held.add(c);
    const acc =
      accounts.get(r.customerId) ??
      ({
        firstAt: Infinity,
        byCurrency: new Map(),
        movementsInWindow: 0,
        churnsInWindow: 0,
        gainsInWindow: 0,
        churnsBefore: 0,
      } satisfies Account);
    acc.firstAt = Math.min(acc.firstAt, new Date(r.firstAt).getTime());
    acc.byCurrency.set(c, {
      opening: BigInt(r.opening),
      closing: BigInt(r.closing),
      weight: BigInt(r.weight),
    });
    acc.movementsInWindow += Number(r.inWindow);
    acc.churnsInWindow += Number(r.churns);
    acc.gainsInWindow += Number(r.gains);
    acc.churnsBefore += Number(r.churnsBefore);
    accounts.set(r.customerId, acc);
  }

  classifyAccounts(accounts, held, from, toExclusive, push);
}

/**
 * The four counts off per-account folds — shared by the stored path (`windowCounts`, which
 * folds in SQL) and segment analytics (`segmentWindowCounts`, which folds one read in memory
 * for every period), so the two cannot disagree about who is new, moved or lost.
 */
function classifyAccounts(
  accounts: Map<string, Account>,
  held: Set<string>,
  from: Date,
  toExclusive: Date,
  push: Push,
): void {
  if (held.size === 0) return;

  const moved = zeros(held);
  const created = zeros(held);
  const churned = zeros(held);
  const base = zeros(held);
  const lost = zeros(held);
  const reactivated = zeros(held);

  for (const acc of accounts.values()) {
    const currency = principalCurrency(acc.byCurrency);
    /**
     * "Carried recurring revenue" is asked PER CURRENCY and never as a cross-currency sum:
     * adding paise to cents to decide whether an account had revenue is a number that means
     * nothing, and it can cancel to zero on an account that plainly had some.
     */
    const heldAtOpen = [...acc.byCurrency.values()].some((v) => v.opening > 0n);
    const heldAtClose = [...acc.byCurrency.values()].some((v) => v.closing > 0n);

    if (heldAtOpen) base.set(currency, base.get(currency)! + 1n);
    if (acc.movementsInWindow === 0) continue;

    moved.set(currency, moved.get(currency)! + 1n);
    // NEW is the first revenue the account EVER carried, not a `new` movement in the window:
    // an existing account opening a second subscription is expansion of one we already had,
    // and counting it again makes "new customers" a subscription count wearing a name.
    if (acc.firstAt >= from.getTime() && acc.firstAt < toExclusive.getTime()) {
      created.set(currency, created.get(currency)! + 1n);
    }
    // CHURNED is a lost ACCOUNT: something churned in the window and nothing was left at the
    // end of it. Cancelling one of three subscriptions is not a lost account, and a pause is
    // a suspension rather than a departure.
    if (acc.churnsInWindow > 0 && !heldAtClose) {
      churned.set(currency, churned.get(currency)! + 1n);
      if (heldAtOpen) lost.set(currency, lost.get(currency)! + 1n);
    }
    // REACTIVATED: lost before the window (earning nothing at its open, after a churn) and
    // earning again inside it. A return from a pause alone was never a loss.
    if (
      !heldAtOpen &&
      acc.firstAt < from.getTime() &&
      acc.churnsBefore > 0 &&
      acc.gainsInWindow > 0
    ) {
      reactivated.set(currency, reactivated.get(currency)! + 1n);
    }
  }

  for (const currency of [...held].sort()) {
    push("customers_new", currency, created.get(currency)!);
    push("customers_churned", currency, churned.get(currency)!);
    push("customers_moved", currency, moved.get(currency)!);
    /**
     * The rate is stored as its TWO HALVES — accounts lost over the accounts there were to
     * lose — so a base of zero reads as null rather than as 0%. A book with no accounts has
     * no churn rate; "0%" would claim it kept them all.
     *
     * The numerator counts only accounts that were in the base. One that arrived and left
     * inside the same window is in `customers_churned` and not here: it was never ours to
     * keep, and including it can put the rate above 100%.
     */
    push("customer_churn_rate", currency, lost.get(currency)!, base.get(currency)!);
    push("customers_reactivated", currency, reactivated.get(currency)!);
  }
}

/** A netted movement (see `NETTED_KEYS`), as the in-memory fold reads it. */
interface NettedMove {
  customerId: string;
  currency: string;
  at: number;
  reason: string;
  delta: bigint;
}

/**
 * The four window counts for many periods over one population, from ONE read.
 *
 * The stored path folds in SQL once per period; asked for a segment's thirty days that is thirty
 * passes over the ledger. This reads the population's netted movements once and folds each
 * period from memory, through the same `classifyAccounts`.
 */
export async function segmentWindowCounts(
  tx: Tx,
  businessId: string,
  periods: ReadonlyArray<{ t: string; from: Date; toExclusive: Date }>,
  customerIn: SQL,
): Promise<Array<MetricDailyRow & { t: string }>> {
  if (periods.length === 0) return [];
  const last = periods.reduce(
    (m, p) => (p.toExclusive > m ? p.toExclusive : m),
    periods[0]!.toExclusive,
  );
  const read = await tx
    .select({
      customerId: mrrMovements.customerId,
      currency: mrrMovements.currency,
      occurredAt: mrrMovements.occurredAt,
      reason: mrrMovements.reason,
      delta: sql<string>`sum(${mrrMovements.deltaMinor})`,
    })
    .from(mrrMovements)
    .where(
      and(
        and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
        lt(mrrMovements.occurredAt, last),
        sql`${mrrMovements.customerId} in (${customerIn})`,
      ),
    )
    .groupBy(
      mrrMovements.subscriptionId,
      mrrMovements.customerId,
      mrrMovements.currency,
      mrrMovements.occurredAt,
      mrrMovements.reason,
    )
    .having(sql`sum(${mrrMovements.deltaMinor}) <> 0`);
  const moves: NettedMove[] = read
    .filter((r) => r.customerId != null)
    .map((r) => ({
      customerId: r.customerId,
      currency: r.currency.toUpperCase(),
      at: new Date(r.occurredAt).getTime(),
      reason: r.reason,
      delta: BigInt(r.delta),
    }));

  const out: Array<MetricDailyRow & { t: string }> = [];
  for (const p of periods) {
    const fromMs = p.from.getTime();
    const toMs = p.toExclusive.getTime();
    const accounts = new Map<string, Account>();
    const held = new Set<string>();
    for (const mv of moves) {
      if (mv.at >= toMs) continue;
      held.add(mv.currency);
      const acc =
        accounts.get(mv.customerId) ??
        ({
          firstAt: Infinity,
          byCurrency: new Map(),
          movementsInWindow: 0,
          churnsInWindow: 0,
          gainsInWindow: 0,
          churnsBefore: 0,
        } satisfies Account);
      acc.firstAt = Math.min(acc.firstAt, mv.at);
      const c = acc.byCurrency.get(mv.currency) ?? { opening: 0n, closing: 0n, weight: 0n };
      if (mv.at < fromMs) c.opening += mv.delta;
      c.closing += mv.delta;
      c.weight += mv.delta < 0n ? -mv.delta : mv.delta;
      acc.byCurrency.set(mv.currency, c);
      if (mv.at >= fromMs) {
        acc.movementsInWindow++;
        if (mv.reason === "churn") acc.churnsInWindow++;
        if (mv.delta > 0n) acc.gainsInWindow++;
      } else if (mv.reason === "churn") acc.churnsBefore++;
      accounts.set(mv.customerId, acc);
    }
    classifyAccounts(
      accounts,
      held,
      p.from,
      p.toExclusive,
      (measure, currency, value, denominator) =>
        out.push({
          t: p.t,
          measure,
          dim: "",
          dimValue: "",
          currency,
          value,
          ...(denominator === undefined ? {} : { denominator }),
        }),
    );
  }
  return out;
}

const zeros = (keys: Iterable<string>): Map<string, bigint> =>
  new Map([...keys].map((k) => [k, 0n]));

/**
 * The one currency an account is counted in: the one carrying most of its recurring-revenue
 * movement, ties broken by the code so the answer is deterministic.
 *
 * The property this buys is the one that makes a converted read honest — the per-currency
 * counts sum to the number of distinct accounts exactly, rather than to a number inflated by
 * whoever pays in two.
 */
function principalCurrency(byCurrency: Map<string, { weight: bigint }>): string {
  let best = "";
  let bestWeight = -1n;
  for (const [c, v] of [...byCurrency].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (v.weight > bestWeight) {
      best = c;
      bestWeight = v.weight;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// The four instant figures, off the book.
// ─────────────────────────────────────────────────────────────────────────────

function instantCounts(
  book: readonly BookSub[],
  at: Date,
  rates: Map<string, bigint>,
  push: Push,
): void {
  /** Currencies the business actually held by then. One it had not reached writes nothing. */
  const held = new Set<string>();
  for (const s of book) if (s.createdAt <= at) held.add(s.currency.toUpperCase());
  if (held.size === 0) return;

  /**
   * ACTIVE — the customer grain of `active_subscriptions`, on its own predicate.
   *
   * The account lands in the currency carrying most of its recurring revenue, exactly as the
   * paying count does; where an account's live lines all carry nothing, the count of them
   * breaks the tie, and the code breaks that. One rule across the instant figures, so an
   * account is never in USD on one line and EUR on the next.
   */
  const activeSubs = zeros(held);
  const activeByCustomer = new Map<string, Map<string, { mrr: bigint; subs: number }>>();
  for (const s of book) {
    if (!isActiveAt(s, at)) continue;
    const c = s.currency.toUpperCase();
    activeSubs.set(c, (activeSubs.get(c) ?? 0n) + 1n);
    const byCcy =
      activeByCustomer.get(s.customerId) ?? new Map<string, { mrr: bigint; subs: number }>();
    const cur = byCcy.get(c) ?? { mrr: 0n, subs: 0 };
    byCcy.set(c, { mrr: cur.mrr + earningMrr(s, rates), subs: cur.subs + 1 });
    activeByCustomer.set(s.customerId, byCcy);
  }
  const activeCustomers = zeros(held);
  for (const byCcy of activeByCustomer.values()) {
    const c = [...byCcy].sort(
      ([ka, va], [kb, vb]) =>
        (vb.mrr > va.mrr ? 1 : vb.mrr < va.mrr ? -1 : 0) || vb.subs - va.subs || (ka < kb ? -1 : 1),
    )[0]![0];
    activeCustomers.set(c, (activeCustomers.get(c) ?? 0n) + 1n);
  }

  // PAYING — the very function `revenue_per_paying_customer` divides by, so the two figures
  // cannot drift apart into two definitions of "paying".
  const paying = countPayingCustomers(book, at, rates);
  // …and the life `customer_lifetime_value` already multiplies by, as its two halves.
  const lives = accountLives(book, at);

  for (const currency of [...held].sort()) {
    push("active_customers", currency, activeCustomers.get(currency)!);
    push("paying_customers", currency, paying.get(currency) ?? 0n);
    /**
     * Live subscriptions over the accounts holding them — the factor between per-subscription
     * and per-customer revenue. Both halves are instants, so both take the period's last day,
     * and no account is ever counted twice.
     */
    push(
      "subscriptions_per_customer",
      currency,
      activeSubs.get(currency)!,
      activeCustomers.get(currency)!,
    );
    /**
     * The average life, stored as total time and account count rather than as a mean: a
     * quarter's average life is the quarter's own arithmetic over its accounts, never the
     * mean of three months' averages. The quotient is in MILLISECONDS — exact, integer, and
     * stated on the measure rather than left to be guessed.
     *
     * Null, not zero, where nothing has fully ended: an account that has not finished has no
     * length, and "they last no time" is a different claim from "not yet".
     */
    const life = lives.get(currency);
    push("average_customer_lifetime", currency, life?.totalMs ?? null, BigInt(life?.n ?? 0));
  }
}
