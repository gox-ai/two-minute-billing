import { reportableSubscription } from "../reportable";
import { reportableCustomer } from "../reportable";
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { scheduledChanges, subscriptions } from "@db/schema";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import { isBookedToStop, liveAt, type StockRow } from "../stocks";
import { bookShared, type SnapshotMrrCache } from "../snapshots";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * The forward book (Phase 7, group 7) — what is already booked to happen and has not.
 *
 * ── BI-TEMPORAL, ANSWERED WITH THE COLUMNS WE HAVE ────────────────────────────────────
 * These seven are the only measures whose answer depends on WHEN YOU ASK as well as which
 * period you ask about: a change booked today for next month is scheduled today, still
 * scheduled next week, and gone the moment it lands. That is as-of × target, and
 * `metric_daily`'s key carries one time axis.
 *
 * `period_end` IS THE AS-OF DATE. All seven declare `asOf: "computed_at"` — the convention
 * `receivables_outstanding` and the card counts established — and are written ONLY for the
 * period containing the run. A past period gets NO row, never a fabricated 0. The writer
 * runs daily, so a day-grain as-of history accumulates forward for free: each row says what
 * was booked as at that day.
 *
 * THE TARGET WINDOW RIDES ON `dim`/`dim_value`, as a closed `horizon` dimension, rather than
 * becoming a second time axis. A closed set means the domain is ours and the bands partition
 * the population, so the slices sum to the unsliced figure. (The AR ageing rungs are chosen
 * at read time, which is exactly why that one stayed a reconstruction.)
 *
 * ⚠️ HISTORY BEGINS THE DAY THE WRITER STARTS, and no backfill can reconstruct it: the
 * schedule rows that have since applied are gone, and a cancellation that happened left no
 * record of the day it was booked. `supportsCompare` is false for the same reason.
 *
 * ── WHAT THE FIGURES ARE ──────────────────────────────────────────────────────────────
 * The plan-change figures come from `scheduled_changes.mrr_delta_minor`, an estimate priced
 * ONCE when the change was booked: gross of discounts, rated from the catalogue of that
 * moment, never restated. The measures carry that limit in their descriptions rather than
 * presenting an estimate as a measurement.
 *
 * A booked CANCELLATION is not in `scheduled_changes` at all — this engine records it on the
 * subscription, as `cancel_at_period_end` or a dated `cancel_scheduled_at`. So the same
 * predicate CMRR uses answers here (`isBookedToStop`), minus the ones already gone. Two
 * answers to one question is the failure this layer exists to prevent.
 *
 * A TRIAL ENDING is booked in the same sense: `trial_end` is a date already on the
 * subscription, so "trials ending in the next 30 days" is the same forward question the plan
 * changes ask and takes the same bands. It is deliberately NOT `trials_active` with a horizon
 * bolted on — that one is dated by the period it describes and carries real history, while
 * this one can only describe the instant of the run. Its unsliced total and `trials_active`
 * at today are the same population read two ways, which the gate pins.
 *
 * ── CURRENCY ──────────────────────────────────────────────────────────────────────────
 * Per currency, in minor units, taken from the SUBSCRIPTION the change belongs to. A
 * subscription holds exactly one currency, so nothing needs the group-5/6 tie-break that
 * attributes a multi-currency account to one of them; the per-currency rows already sum to
 * the whole forward book.
 */

/** The seven, in the order they are written. */
export const SCHEDULED_MEASURES = [
  "scheduled_upgrade_mrr",
  "scheduled_downgrade_mrr",
  "scheduled_upgrades",
  "scheduled_downgrades",
  "scheduled_cancellation_mrr",
  "scheduled_cancellations",
  "trials_ending",
] as const;

/**
 * THE CLOSED HORIZON SET — how far off the booked change is, measured from the instant of
 * the run.
 *
 * Six bands, and they PARTITION: every booked change lands in exactly one, so the slices sum
 * to the total. The three rungs the question is usually asked in (30 / 60 / 90 days) are cut
 * disjointly rather than cumulatively, because cumulative bands cannot sum.
 *
 * `overdue` and `undated` exist because the population contains both and neither is "later":
 * a change whose date has passed but which the clock has not applied yet is still booked, and
 * a cancellation at period end on a subscription with no period end on file has no date at
 * all. Folding either into a rung would put a number in a window it is not in.
 */
export const HORIZON_BANDS = ["overdue", "1_30", "31_60", "61_90", "90_plus", "undated"] as const;

export type HorizonBand = (typeof HORIZON_BANDS)[number];

const DAY_MS = 86_400_000;

/** Which band a booked change falls in, as at `now`. Null date is `undated`, not `90_plus`. */
export function horizonBand(effectiveAt: Date | null, now: Date): HorizonBand {
  if (effectiveAt == null) return "undated";
  const ms = effectiveAt.getTime() - now.getTime();
  if (ms <= 0) return "overdue";
  const days = ms / DAY_MS;
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

/** The stored slices each measure emits — paired against the registry's declaration. */
export const SCHEDULED_MEASURE_DIMS: Record<string, readonly DimensionId[]> = Object.fromEntries(
  SCHEDULED_MEASURES.map((id) => [id, ["horizon"] as readonly DimensionId[]]),
);

/** When a booked cancellation is due. `cancel_scheduled_at` is dated; period end may not be. */
export function cancellationDueAt(s: {
  cancelScheduledAt: Date | null;
  cancelAtPeriodEnd: boolean | null;
  currentPeriodEnd: Date | null;
}): Date | null {
  if (s.cancelScheduledAt != null) return s.cancelScheduledAt;
  if (s.cancelAtPeriodEnd === true) return s.currentPeriodEnd;
  return null;
}

export async function computeScheduledMeasures(input: {
  tx: Tx;
  businessId: string;
  from: Date;
  toExclusive: Date;
  /** The instant the run happens at. These six describe that instant and no other. */
  now: Date;
  /** The period's shared reads, from `computeMetricPeriod`. */
  cache?: SnapshotMrrCache;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive, now, cache } = input;
  // A past period cannot be answered — what was booked then is gone — so it is left alone.
  if (now < from || now >= toExclusive) return [];

  const fields = {
    id: subscriptions.id,
    status: subscriptions.status,
    currency: subscriptions.currency,
    mrr: subscriptions.mrr,
    canceledAt: subscriptions.canceledAt,
    cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
    cancelScheduledAt: subscriptions.cancelScheduledAt,
    currentPeriodEnd: subscriptions.currentPeriodEnd,
    trialStart: subscriptions.trialStart,
    trialEnd: subscriptions.trialEnd,
    // For `liveAt` — the same predicate `trials_active` uses, so the two cannot disagree.
    createdAt: subscriptions.createdAt,
    startDate: subscriptions.startDate,
    startedAt: subscriptions.startedAt,
  };
  const subs = cache
    ? await bookShared(tx, businessId, fields, cache)
    : await tx
        .select(fields)
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

  // A business with no book writes NOTHING — the rule the card counts follow. A row of
  // zeros would claim a forward book was inspected when there is none to inspect.
  if (subs.length === 0) return [];

  const changes = await tx
    .select({
      type: scheduledChanges.type,
      mrrDeltaMinor: scheduledChanges.mrrDeltaMinor,
      effectiveAt: scheduledChanges.effectiveAt,
      subscriptionId: scheduledChanges.subscriptionId,
    })
    .from(scheduledChanges)
    .where(
      and(
        eq(scheduledChanges.businessId, businessId),
        eq(scheduledChanges.status, "scheduled"),
        reportableSubscription(scheduledChanges.subscriptionId),
      ),
    );

  const subById = new Map(subs.map((s) => [s.id, s]));

  /** measure → currency → band ('' = the unsliced total) → value. */
  const acc = new Map<string, Map<string, Map<string, bigint>>>();
  const add = (measure: string, currency: string, band: string, value: bigint) => {
    const byCurrency = acc.get(measure) ?? new Map<string, Map<string, bigint>>();
    acc.set(measure, byCurrency);
    const byBand = byCurrency.get(currency) ?? new Map<string, bigint>();
    byCurrency.set(currency, byBand);
    byBand.set(band, (byBand.get(band) ?? 0n) + value);
  };

  // Every currency the book holds gets a total, even an empty one: nothing booked in a
  // currency we do bill in is a measured zero, and it is the answer to the question.
  const currencies = new Set(subs.map((s) => s.currency.toUpperCase()));
  for (const measure of SCHEDULED_MEASURES) {
    for (const currency of currencies) add(measure, currency, "", 0n);
  }

  for (const c of changes) {
    // A change on a deleted subscription answers for a book that no longer has it.
    const sub = subById.get(c.subscriptionId);
    if (!sub) continue;
    // Only a plan change moves a rate by being booked; cancel/pause/resume carry no
    // estimate and a null delta is not a delta of zero.
    if (c.type !== "change" || c.mrrDeltaMinor == null) continue;
    const delta = BigInt(c.mrrDeltaMinor);
    if (delta === 0n) continue;
    const currency = sub.currency.toUpperCase();
    const band = horizonBand(c.effectiveAt, now);
    const up = delta > 0n;
    const mrr = up ? "scheduled_upgrade_mrr" : "scheduled_downgrade_mrr";
    const count = up ? "scheduled_upgrades" : "scheduled_downgrades";
    // A loss is stated as a positive amount, like every other loss in this catalogue.
    const amount = up ? delta : -delta;
    add(mrr, currency, "", amount);
    add(mrr, currency, band, amount);
    add(count, currency, "", 1n);
    add(count, currency, band, 1n);
  }

  for (const s of subs) {
    // Already gone: that is churn, and it is somebody else's measure.
    if (s.canceledAt != null) continue;
    if (!isBookedToStop(s as unknown as StockRow)) continue;
    const currency = s.currency.toUpperCase();
    const band = horizonBand(cancellationDueAt(s), now);
    const mrr = BigInt(s.mrr ?? 0n);
    add("scheduled_cancellation_mrr", currency, "", mrr);
    add("scheduled_cancellation_mrr", currency, band, mrr);
    add("scheduled_cancellations", currency, "", 1n);
    add("scheduled_cancellations", currency, band, 1n);
  }

  /**
   * Trials with an end date still ahead, banded by how far off it is.
   *
   * `liveAt(now)` and the trial window are the same predicates `trials_active` uses, so the
   * unsliced total here and that measure's figure for today cannot disagree. A trial with no
   * end on file is running but is not ENDING, so it is left out rather than banded `undated`:
   * an open-ended trial is not a date we failed to record.
   */
  for (const s of subs) {
    const t = s as unknown as { trialStart: Date | null; trialEnd: Date | null };
    if (t.trialStart == null || t.trialStart > now) continue;
    if (t.trialEnd == null || t.trialEnd <= now) continue;
    // Read without lapses, as this reader always has; a shared row may carry them.
    if (!liveAt({ ...(s as unknown as StockRow), lapses: null }, now)) continue;
    const currency = s.currency.toUpperCase();
    add("trials_ending", currency, "", 1n);
    add("trials_ending", currency, horizonBand(t.trialEnd, now), 1n);
  }

  const rows: MetricDailyRow[] = [];
  for (const measure of SCHEDULED_MEASURES) {
    for (const [currency, byBand] of acc.get(measure) ?? []) {
      for (const [band, value] of byBand) {
        rows.push({
          measure,
          dim: band === "" ? "" : "horizon",
          dimValue: band,
          currency,
          value,
        });
      }
    }
  }
  return rows;
}
