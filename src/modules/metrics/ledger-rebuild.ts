/**
 * Rebuild a subscription's MRR ledger from the recurring periods it was actually billed for.
 *
 * For a subscription that has invoices but no `mrr_movements` at all: the movement backfill
 * seeded from the subscription's FINAL rate, and a book that ended on a $0 plan before being
 * cancelled was seeded with nothing — every month it paid is missing from MRR history. Its
 * paid recurring invoice lines still say what it was billed per period, so the ledger can be
 * rebuilt from them. Pure: `scripts/rebuild-ledger-from-invoices.ts` does the reads and writes.
 *
 * Each move is classified by `classifyMrrMove`, the live writer's own rule, so a rebuilt row
 * means what a recorded one would have: a fall to 0 while still live (a move to a free plan)
 * is a contraction, and churn is only the end of revenue on a cancelled subscription.
 */
import { classifyMrrMove, type MrrMovementReason } from "./mrr-movements";

const DAY_MS = 86_400_000;
/** A gap longer than this between two billed periods means revenue stopped in between. */
const GAP_MS = 7 * DAY_MS;

/** One billed recurring period. `monthlyMinor` null = a partial (prorated) period. */
export interface BilledPeriod {
  start: Date;
  end: Date;
  monthlyMinor: bigint | null;
  planProductId: string | null;
}

export interface RebuiltMove {
  reason: MrrMovementReason;
  previousMinor: bigint;
  nextMinor: bigint;
  deltaMinor: bigint;
  occurredAt: Date;
  planProductId: string | null;
  previousPlanProductId: string | null;
}

/**
 * The monthly rate a recurring line bills: its net amount over the months its interval spans,
 * or null when the line is not one interval's charge — well under one (a proration), or far over
 * it (a lump charge an import dated across years; a ten-year line on a ten-year price is fine).
 */
export function monthlyRateOf(line: {
  netMinor: bigint;
  interval: string;
  intervalCount: number;
  start: Date;
  end: Date;
}): bigint | null {
  const n = Math.max(1, line.intervalCount);
  const [months, days] =
    line.interval === "year"
      ? [12 * n, 365 * n]
      : line.interval === "week"
        ? [(7 * n) / 30.4375, 7 * n]
        : line.interval === "day"
          ? [n / 30.4375, n]
          : [n, 30.4375 * n];
  const covered = (line.end.getTime() - line.start.getTime()) / DAY_MS;
  if (covered < 0.8 * days || covered > 1.5 * days) return null;
  return BigInt(Math.round(Number(line.netMinor) / months));
}

/**
 * Blank the rate of every mid-term proration: a period that starts inside an earlier one and
 * ENDS with it is an upgrade billed for the rest of that term, not a rate. The new rate lands
 * at the next full renewal. Ending together is the test — a free plan billed as one ten-year
 * line contains every later period without being their term.
 */
export function withoutMidTermProrations(periods: readonly BilledPeriod[]): BilledPeriod[] {
  return periods.map((p) =>
    periods.some((o) => +o.start < +p.start && Math.abs(+p.end - +o.end) <= DAY_MS)
      ? { ...p, monthlyMinor: null, planProductId: null }
      : p,
  );
}

/**
 * The moves that take this subscription from 0 through its billed periods to `finalMinor`
 * (its stored MRR). Periods sharing a start are summed by the caller.
 */
export function planLedger(input: {
  periods: readonly BilledPeriod[];
  /** Stored status now — decides whether the final fall to its rate is churn. */
  status: string;
  /** The stored MRR the ledger must end on, so Σ delta = mrr holds. */
  finalMinor: bigint;
}): RebuiltMove[] {
  const periods = [...input.periods].sort((a, b) => +a.start - +b.start);
  const moves: RebuiltMove[] = [];
  let current = 0n;
  let plan: string | null = null;
  let priorReason: MrrMovementReason | null = null;

  const move = (next: bigint, at: Date, status: string, nextPlan: string | null) => {
    if (next === current) return;
    const reason = classifyMrrMove({
      previousMinor: current,
      nextMinor: next,
      status,
      priorReason,
      hasPrior: moves.length > 0,
    });
    moves.push({
      reason,
      previousMinor: current,
      nextMinor: next,
      deltaMinor: next - current,
      occurredAt: at,
      planProductId: nextPlan,
      previousPlanProductId: moves.length > 0 ? plan : null,
    });
    current = next;
    plan = nextPlan;
    priorReason = reason;
  };

  // The end of the revenue already paid for: a new rate billed before it takes effect then,
  // and a gap after it means billing stopped. Only PAID periods set it — a free plan billed as
  // one ten-year line must not push a later paid period out to its end.
  let paidEnd: Date | null = null;
  periods.forEach((p, i) => {
    if (paidEnd && p.start.getTime() - paidEnd.getTime() > GAP_MS && current > 0n) {
      move(0n, paidEnd, "active", plan);
    }
    // A partial period carries the rate around it: the one before, else the next full one.
    const rate =
      p.monthlyMinor ??
      (current > 0n
        ? current
        : (periods.slice(i + 1).find((q) => q.monthlyMinor != null)?.monthlyMinor ?? 0n));
    const at = paidEnd && p.start < paidEnd && rate !== current ? paidEnd : p.start;
    move(rate, at, "active", p.planProductId ?? plan);
    if (rate > 0n && (!paidEnd || p.end > paidEnd)) paidEnd = p.end;
  });

  // Revenue ends where the last PAID period ends, at whatever the subscription stores now.
  if (current !== input.finalMinor && paidEnd) {
    move(input.finalMinor, paidEnd, input.finalMinor === 0n ? input.status : "active", plan);
  }
  return moves;
}

/** One ledger movement as the lapse planner reads it. */
export interface LedgerMove {
  occurredAt: Date;
  reason: MrrMovementReason;
  deltaMinor: bigint;
}

/** A lapse the planner closes, and the rows that close it. */
export interface PlannedLapse {
  from: Date;
  to: Date;
  rows: Array<{
    reason: MrrMovementReason;
    previousMinor: bigint;
    nextMinor: bigint;
    deltaMinor: bigint;
    occurredAt: Date;
  }>;
}

/**
 * Zero the ledger across every stretch the subscription was not billed for at all.
 *
 * A lapse is a stretch BETWEEN two covered periods (covered = a recurring line on any invoice
 * that was not voided — an unpaid one is dunning, which still counts) longer than `graceMs`,
 * while the ledger says it earned. Revenue before the first covered period is a trial, handled
 * elsewhere; a gap still open at the end is left alone so the stored rate is untouched.
 *
 * For each lapse: `churn` −B at its start, each movement inside it countered, `reactivation`
 * +B′ where billing resumes (B′ = the balance the ledger had just before). Σ is unchanged.
 */
export function planLapses(input: {
  coverage: ReadonlyArray<{ start: Date; end: Date }>;
  moves: readonly LedgerMove[];
  graceMs?: number;
}): PlannedLapse[] {
  const grace = input.graceMs ?? GAP_MS;
  const spans = [...input.coverage].sort((a, b) => +a.start - +b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && +s.start <= last.end) last.end = Math.max(last.end, +s.end);
    else merged.push({ start: +s.start, end: +s.end });
  }
  const moves = [...input.moves].sort((a, b) => +a.occurredAt - +b.occurredAt);
  const balanceAt = (t: number, inclusive: boolean) =>
    moves.reduce(
      (a, m) => (+m.occurredAt < t || (inclusive && +m.occurredAt === t) ? a + m.deltaMinor : a),
      0n,
    );

  const out: PlannedLapse[] = [];
  for (let i = 0; i + 1 < merged.length; i++) {
    const from = merged[i]!.end;
    const to = merged[i + 1]!.start;
    if (to - from <= grace) continue;
    const opening = balanceAt(from, true);
    const inside = moves.filter((m) => +m.occurredAt > from && +m.occurredAt < to);
    const closing = balanceAt(to, false);
    // Only a gap that EARNED: a running balance above zero somewhere in it. Movements that cancel
    // out (pairs left by other repairs) earn nothing, and countering them would never settle.
    const perInstant = new Map<number, bigint>();
    for (const m of inside)
      perInstant.set(+m.occurredAt, (perInstant.get(+m.occurredAt) ?? 0n) + m.deltaMinor);
    let running = opening;
    let earned = opening > 0n;
    for (const [, d] of [...perInstant].sort((x, y) => x[0] - y[0])) {
      running += d;
      if (running > 0n) earned = true;
    }
    if (!earned) continue;
    const rows: PlannedLapse["rows"] = [];
    if (opening !== 0n) {
      rows.push({
        reason: "churn",
        previousMinor: opening,
        nextMinor: 0n,
        deltaMinor: -opening,
        occurredAt: new Date(from),
      });
    }
    for (const m of inside) {
      if (m.deltaMinor === 0n) continue;
      rows.push({
        reason: m.reason,
        previousMinor: 0n,
        nextMinor: 0n,
        deltaMinor: -m.deltaMinor,
        occurredAt: m.occurredAt,
      });
    }
    if (closing !== 0n) {
      rows.push({
        reason: "reactivation",
        previousMinor: 0n,
        nextMinor: closing,
        deltaMinor: closing,
        occurredAt: new Date(to),
      });
    }
    out.push({ from: new Date(from), to: new Date(to), rows });
  }
  return out;
}
