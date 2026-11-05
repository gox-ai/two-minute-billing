import { reportableCustomer } from "../reportable";
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { subscriptions } from "@db/schema";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import {
  advancePeriod,
  nextBillingBoundary,
  recurringAmountsForSubs,
} from "@/modules/subscriptions/service";
import { billingModeFor } from "@/modules/subscriptions/billing-mode";
import { cancellationDueAt, horizonBand } from "./scheduled-measures";
import { bookShared, type SnapshotMrrCache } from "../snapshots";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * Expected renewal cash — what the book will bill at its renewal boundaries in the next 90
 * days, as it stands at the run. Part of the forward book (`scheduled-measures.ts`): written
 * only for the period containing the run, sliced by the same closed `horizon` bands.
 *
 * What is counted, per CHARGE (a weekly plan contributes each renewal in the window, so
 * `expected_renewals` counts charges, not subscriptions):
 *  - `active` and `in_trial` subscriptions only. A trial's first charge is its conversion at
 *    `trial_end`; later ones step by the subscription's cadence and anchor, as the clock does.
 *  - Stops at a booked cancellation due at or before the boundary (a non-renewing term
 *    included), and after `remaining_billing_cycles` more charges — the renewal clock
 *    charges while cycles remain and cancels at 0.
 *  - A boundary already passed that the clock has not billed yet is `overdue`, not dropped.
 *  - Valued at `computeRecurringAmount`: one period's recurring items net of every discount
 *    spanning more than one period, before tax, usage excluded. A zero charge is not cash
 *    and is not counted; a subscription whose items recur on another cadence (amount null)
 *    is left out rather than guessed.
 *
 * Limits, stated rather than hidden: a booked plan change is valued at the CURRENT rate
 * (the schedule carries only an MRR estimate), and a multi-period discount is applied to
 * every charge in the window even if it expires inside it.
 */
export const EXPECTED_CASH_MEASURES = ["expected_renewal_cash", "expected_renewals"] as const;

export const EXPECTED_CASH_MEASURE_DIMS: Record<string, readonly DimensionId[]> =
  Object.fromEntries(
    EXPECTED_CASH_MEASURES.map((id) => [id, ["horizon"] as readonly DimensionId[]]),
  );

const HORIZON_DAYS = 90;
const DAY_MS = 86_400_000;
/** A cadence cannot yield more charges than this in 90 days; guards a zero-length period. */
const MAX_CHARGES = 100;

type Cadence = Parameters<typeof advancePeriod>[1];

/** The fields the schedule reads — a subset of the subscription row. */
export interface RenewalScheduleRow {
  status: string;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean | null;
  cancelScheduledAt: Date | null;
  remainingBillingCycles: number | null;
  billingPeriod: number | null;
  billingPeriodUnit: string | null;
  billingAnchorDay: number | null;
}

/** Every renewal charge a live subscription will raise up to `until`, oldest first. */
export function renewalChargesUntil(
  s: RenewalScheduleRow,
  until: Date,
  mode: Parameters<typeof advancePeriod>[4],
): Date[] {
  const unit = (s.billingPeriodUnit ?? "month") as Cadence;
  const count = s.billingPeriod ?? 1;
  const stop = cancellationDueAt(s);
  // As the clock counts: each boundary charges while cycles remain, and 0 cancels there.
  const limit = Math.min(MAX_CHARGES, s.remainingBillingCycles ?? MAX_CHARGES);
  const out: Date[] = [];
  let at = nextBillingBoundary(s);
  while (at != null && at <= until && out.length < limit) {
    if (stop != null && stop <= at) break;
    out.push(at);
    const next = advancePeriod(at, unit, count, s.billingAnchorDay, mode);
    if (next <= at) break;
    at = next;
  }
  return out;
}

export async function computeExpectedRenewalMeasures(input: {
  tx: Tx;
  businessId: string;
  from: Date;
  toExclusive: Date;
  now: Date;
  /** The period's shared reads, from `computeMetricPeriod`. */
  cache?: SnapshotMrrCache;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive, now, cache } = input;
  if (now < from || now >= toExclusive) return [];

  const fields = {
    id: subscriptions.id,
    status: subscriptions.status,
    currency: subscriptions.currency,
    trialEnd: subscriptions.trialEnd,
    currentPeriodEnd: subscriptions.currentPeriodEnd,
    canceledAt: subscriptions.canceledAt,
    cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
    cancelScheduledAt: subscriptions.cancelScheduledAt,
    remainingBillingCycles: subscriptions.remainingBillingCycles,
    billingPeriod: subscriptions.billingPeriod,
    billingPeriodUnit: subscriptions.billingPeriodUnit,
    billingAnchorDay: subscriptions.billingAnchorDay,
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
  // No book, no rows — the rule the rest of the forward book follows.
  if (subs.length === 0) return [];

  const live = subs.filter(
    (s) => (s.status === "active" || s.status === "in_trial") && s.canceledAt == null,
  );
  const amounts = await recurringAmountsForSubs(tx, live);
  const mode = await billingModeFor(tx, businessId);
  const horizonEnd = new Date(now.getTime() + HORIZON_DAYS * DAY_MS);

  /** measure → currency → band ('' = total) → value. */
  const acc = new Map<string, Map<string, Map<string, bigint>>>();
  const add = (measure: string, currency: string, band: string, value: bigint) => {
    const byCurrency = acc.get(measure) ?? new Map<string, Map<string, bigint>>();
    acc.set(measure, byCurrency);
    const byBand = byCurrency.get(currency) ?? new Map<string, bigint>();
    byCurrency.set(currency, byBand);
    byBand.set(band, (byBand.get(band) ?? 0n) + value);
  };
  // Every currency the book bills in gets a total, even a zero one.
  for (const s of subs) {
    for (const m of EXPECTED_CASH_MEASURES) add(m, s.currency.toUpperCase(), "", 0n);
  }

  for (const s of live) {
    const amount = amounts.get(s.id);
    if (amount == null || amount <= 0n) continue;
    const currency = s.currency.toUpperCase();
    for (const at of renewalChargesUntil(s, horizonEnd, mode)) {
      const band = horizonBand(at, now);
      add("expected_renewal_cash", currency, "", amount);
      add("expected_renewal_cash", currency, band, amount);
      add("expected_renewals", currency, "", 1n);
      add("expected_renewals", currency, band, 1n);
    }
  }

  const rows: MetricDailyRow[] = [];
  for (const measure of EXPECTED_CASH_MEASURES) {
    for (const [currency, byBand] of acc.get(measure) ?? []) {
      for (const [band, value] of byBand) {
        rows.push({ measure, dim: band === "" ? "" : "horizon", dimValue: band, currency, value });
      }
    }
  }
  return rows;
}
