import { reportableCustomer } from "../reportable";
import { and, eq, lt } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { disputes } from "@db/schema";
import { horizonBand } from "./scheduled-measures";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * Disputes, per currency of the disputed charge.
 *
 * Open = `needs_response` or `under_review`. The two open readings are as at the run (like
 * receivables): written only for the period containing it, and split by `horizon` on the
 * evidence deadline — `overdue` is a deadline already passed, `undated` one the gateway never
 * sent. The flows are dated by the event: opened by `opened_at`, won and lost by `closed_at`.
 * `closed` (withdrawn or accepted) is neither won nor lost and is not counted as either.
 */
export const DISPUTE_READINGS = ["disputes_open", "disputes_open_amount"] as const;
export const DISPUTE_FLOWS = [
  "disputes_opened",
  "disputes_opened_amount",
  "disputes_won",
  "disputes_won_amount",
  "disputes_lost",
  "disputes_lost_amount",
] as const;
export const DISPUTE_MEASURES = [...DISPUTE_READINGS, ...DISPUTE_FLOWS] as const;

export const DISPUTE_MEASURE_DIMS: Record<string, readonly DimensionId[]> = Object.fromEntries(
  DISPUTE_MEASURES.map((id) => [
    id,
    (DISPUTE_READINGS as readonly string[]).includes(id) ? (["horizon"] as const) : [],
  ]),
);

const OPEN = new Set(["needs_response", "under_review"]);

export async function computeDisputeMeasures(input: {
  tx: Tx;
  businessId: string;
  from: Date;
  toExclusive: Date;
  now: Date;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive, now } = input;
  const rows = await tx
    .select({
      status: disputes.status,
      amountMinor: disputes.amountMinor,
      currency: disputes.currency,
      evidenceDueBy: disputes.evidenceDueBy,
      openedAt: disputes.openedAt,
      closedAt: disputes.closedAt,
    })
    .from(disputes)
    .where(
      and(
        eq(disputes.businessId, businessId),
        reportableCustomer(disputes.customerId),
        lt(disputes.openedAt, toExclusive),
      ),
    );
  // No dispute by the period's end: nothing to measure, and a zero would claim otherwise.
  if (rows.length === 0) return [];

  const acc = new Map<string, bigint>();
  const add = (measure: string, currency: string, band: string, value: bigint) => {
    const k = `${measure}\u0000${currency}\u0000${band}`;
    acc.set(k, (acc.get(k) ?? 0n) + value);
  };
  const reading = now >= from && now < toExclusive;
  const inWindow = (at: Date | null) => at != null && at >= from && at < toExclusive;

  for (const d of rows) {
    const currency = d.currency.toUpperCase();
    // Every currency with a dispute gets totals, zero included: a quiet period is measured.
    for (const m of DISPUTE_FLOWS) add(m, currency, "", 0n);
    if (reading) for (const m of DISPUTE_READINGS) add(m, currency, "", 0n);

    const amount = BigInt(d.amountMinor);
    if (inWindow(d.openedAt)) {
      add("disputes_opened", currency, "", 1n);
      add("disputes_opened_amount", currency, "", amount);
    }
    if ((d.status === "won" || d.status === "lost") && inWindow(d.closedAt)) {
      add(`disputes_${d.status}`, currency, "", 1n);
      add(`disputes_${d.status}_amount`, currency, "", amount);
    }
    if (reading && OPEN.has(d.status)) {
      const band = horizonBand(d.evidenceDueBy, now);
      for (const [m, v] of [
        ["disputes_open", 1n],
        ["disputes_open_amount", amount],
      ] as const) {
        add(m, currency, "", v);
        add(m, currency, band, v);
      }
    }
  }

  const out: MetricDailyRow[] = [];
  for (const [k, value] of acc) {
    const [measure, currency, band] = k.split("\u0000") as [string, string, string];
    out.push({ measure, dim: band ? "horizon" : "", dimValue: band, currency, value });
  }
  return out;
}
