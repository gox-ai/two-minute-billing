import { and, desc, eq, sql, type AnyColumn } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { mrrMovements } from "@db/schema";
import { exchangeRateColumns, loadIssueRate } from "@/modules/invoicing/exchange-rate";
import { resolvePlanProductId } from "./plan-of";

/**
 * The MRR movement ledger's writer and its taxonomy (Phase 1 of the revenue reporting
 * work — see `src/modules/metrics/README.md`).
 *
 * `subscriptions.mrr` is a stock: it says what a subscription earns now and cannot say how
 * it got there. Expansion, contraction, retention and the quick ratio are all flow
 * questions, and the analytics module could only ever see two events per subscription —
 * its start and its cancellation — because it reconstructed everything from lifecycle
 * timestamps. An upgrade, a downgrade, a pause and a 100%-off coupon were invisible.
 *
 * One writer, one rule: a row is appended whenever the stored MRR actually moves, so
 * **Σ delta over a window = the change in MRR across it**. Every reason exists to keep that
 * identity true — including `pause` and `resume`, which a reporting definition might not
 * count as churn but which a ledger cannot simply drop.
 */
export type MrrMovementReason =
  | "new"
  | "expansion"
  | "contraction"
  | "churn"
  | "reactivation"
  | "pause"
  | "resume";

/** Reasons that ADD recurring revenue, for the ratios that need the distinction. */
export const GAIN_REASONS: readonly MrrMovementReason[] = ["new", "expansion", "reactivation"];
/** Reasons that REMOVE it. `pause` sits here: a paused subscription bills nothing. */
export const LOSS_REASONS: readonly MrrMovementReason[] = ["contraction", "churn", "pause"];

/**
 * Classify a move. The inputs are what the writer already knows: the two amounts, the
 * subscription's status AFTER the transition, and whether this subscription has moved
 * before.
 *
 * The status test only decides between the ways revenue can reach zero, because that is
 * the only place the amounts are ambiguous: a subscription can fall to 0 by being
 * cancelled, by being paused, or by being handed a 100%-off coupon while it happily keeps
 * running — and the last of those is a contraction, not churn.
 */
export function classifyMrrMove(input: {
  previousMinor: bigint;
  nextMinor: bigint;
  /** The subscription's status as stored AFTER the change that caused this move. */
  status: string;
  /** The most recent reason recorded for this subscription, or null for its first move. */
  priorReason: MrrMovementReason | null;
  /** True when this subscription has any earlier movement at all. */
  hasPrior: boolean;
}): MrrMovementReason {
  const { previousMinor, nextMinor, status, priorReason, hasPrior } = input;
  if (nextMinor > previousMinor) {
    if (previousMinor > 0n) return "expansion";
    // From zero. A resumed pause is not new business and not a win-back; separating the
    // two is what stops a paused-then-resumed book reading as churn and reacquisition.
    if (priorReason === "pause") return "resume";
    return hasPrior ? "reactivation" : "new";
  }
  if (nextMinor > 0n) return "contraction";
  if (status === "paused") return "pause";
  if (status === "cancelled") return "churn";
  // Still live, still a customer, now worth nothing — a full discount, or every paid item
  // removed. Churn would claim a customer we still have.
  return "contraction";
}

/**
 * Append one movement, if the amount moved at all.
 *
 * Takes the caller's transaction, always: the movement must commit with the write that
 * caused it, or the ledger records revenue that was rolled back. Returns the reason
 * recorded, or null when nothing moved.
 */
export async function recordMrrMovement(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    subscriptionId: string;
    customerId: string;
    currency: string;
    previousMinor: bigint;
    nextMinor: bigint;
    status: string;
    /** The business's clock, where the caller has one. */
    occurredAt?: Date;
  },
): Promise<MrrMovementReason | null> {
  if (input.previousMinor === input.nextMinor) return null;

  const [prior] = await tx
    .select({ reason: mrrMovements.reason, planProductId: mrrMovements.planProductId })
    .from(mrrMovements)
    .where(eq(mrrMovements.subscriptionId, input.subscriptionId))
    .orderBy(desc(mrrMovements.occurredAt), desc(mrrMovements.createdAt))
    .limit(1);

  const reason = classifyMrrMove({
    previousMinor: input.previousMinor,
    nextMinor: input.nextMinor,
    status: input.status,
    priorReason: (prior?.reason as MrrMovementReason | undefined) ?? null,
    hasPrior: prior != null,
  });

  // Resolved NOW, not at read time: the answer is "the plan this subscription was on when
  // the money moved", and after a plan change a later join cannot reproduce it — which is
  // exactly the movement it would be explaining.
  const planProductId = await resolvePlanProductId(tx, input.subscriptionId);
  // Where the money came FROM: the plan the last movement landed on. Read from the ledger,
  // not from the items — after a plan change the items describe the destination only, and
  // that change is the movement being explained. Null on a first movement.
  const previousPlanProductId = prior?.planProductId ?? null;

  // The FX rate in force RIGHT NOW, from the same `businesses.exchange_rates` the
  // converted roll-ups read — stamped here because that map is overwritten in place, so a
  // rate edit silently reprices every converted figure in the history. `loadIssueRate` is
  // the one resolver (0228): it returns 1 for a movement already in the business's default
  // currency, where parity is a fact, and NULL — never 1 — when there is no usable rate,
  // because a missing rate and parity are different facts.
  //
  // Recorded only. Nothing reads it yet: the reports still convert at read time, and FX is
  // not a movement reason of its own. One PK-keyed select per movement, in the caller's
  // transaction, so the rate commits with the row it describes.
  const fx = await loadIssueRate(tx, input.businessId, input.currency);

  await tx.insert(mrrMovements).values({
    organizationId: input.organizationId,
    businessId: input.businessId,
    subscriptionId: input.subscriptionId,
    customerId: input.customerId,
    reason,
    planProductId,
    previousPlanProductId,
    currency: input.currency.toUpperCase(),
    previousMrrMinor: input.previousMinor,
    newMrrMinor: input.nextMinor,
    deltaMinor: input.nextMinor - input.previousMinor,
    ...exchangeRateColumns(fx),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
  return reason;
}

/** True when this subscription already has a movement — used by the backfill to skip it. */
export async function hasMrrMovements(tx: Tx, subscriptionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: mrrMovements.id })
    .from(mrrMovements)
    .where(and(eq(mrrMovements.subscriptionId, subscriptionId)))
    .limit(1);
  return row != null;
}

/**
 * The retention ratios, as pure arithmetic over one window's movement.
 *
 * Separate from `analytics.ts` so the formulas can be checked against known numbers
 * instead of against a fixture that has to be staged a month in the past — the arithmetic
 * is where a retention bug hides, and a dashboard that returns *a* number always looks
 * like it works.
 *
 * `new` is absent from both retention rates on purpose: they ask what happened to the base
 * we already had, and new business answers a different question. The quick ratio is the
 * one that wants everything gained over everything lost.
 *
 * Every rate is null when its denominator is zero: a rate over nothing is undefined, and
 * reporting 0% would read as total churn.
 */
export function retentionRates(input: {
  startingMrr: number;
  newMrr: number;
  expansion: number;
  reactivation: number;
  /** Positive magnitudes. */
  contraction: number;
  churn: number;
}): {
  gross_retention_bps: number | null;
  net_retention_bps: number | null;
  quick_ratio_bps: number | null;
} {
  const { startingMrr, newMrr, expansion, reactivation, contraction, churn } = input;
  const lost = contraction + churn;
  const gained = newMrr + expansion + reactivation;
  const rate = (numerator: number): number | null =>
    startingMrr > 0 ? Math.round((numerator / startingMrr) * 10000) : null;
  return {
    gross_retention_bps: rate(startingMrr - lost),
    net_retention_bps: rate(startingMrr + expansion + reactivation - lost),
    quick_ratio_bps: lost > 0 ? Math.round((gained / lost) * 10000) : null,
  };
}

/**
 * The ledger as a row-level reader must see it: rows sharing a subscription, instant and reason
 * summed, and a zero net dropped.
 *
 * A restatement (`scripts/repair-backfilled-movement-rates.ts`) appends the opposite of a wrong
 * row at the same instant. Summed, the pair is the true figure; read row by row, a reader that
 * adds magnitudes counts both. The writer never appends a zero move, so nothing real nets away.
 *
 * Grouped by exactly `mrr_movements_net_idx`'s keys (0277) so the read needs no sort — on the
 * production book 192k rows net to 5k, and sorting them was most of every ledger read. Every
 * other column is constant within a group (a restatement copies them), so it is CARRIED from
 * the group rather than grouped on. Group by `NETTED_KEYS`, filter with `NETS_TO_SOMETHING`,
 * read other columns through `carried`.
 */
export const NETTED_KEYS = [
  mrrMovements.subscriptionId,
  mrrMovements.occurredAt,
  mrrMovements.reason,
] as const;
export const nettedDelta = () => sql<bigint>`sum(${mrrMovements.deltaMinor})`.mapWith(BigInt);
export const NETS_TO_SOMETHING = sql`sum(${mrrMovements.deltaMinor}) <> 0`;
/** A column that is constant within a netted group, read from any of its rows. */
export const carried = <T>(column: AnyColumn) => sql<T>`(array_agg(${column}))[1]`;
