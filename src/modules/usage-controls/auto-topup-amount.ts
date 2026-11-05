/**
 * Automatic top-up arithmetic (design G5 §3.6). Pure: no DB, no clock.
 */
import type { AutoTopupMethod, AutoTopupSchedule, AutoTopupTrigger } from "@db/schema";

export interface TopupAmountInput {
  trigger: AutoTopupTrigger;
  method: AutoTopupMethod;
  thresholdMinor: bigint | null;
  amountMinor: bigint | null;
  targetMinor: bigint | null;
  /** B: live balance. */
  balanceMinor: bigint;
  /** F: open runs not yet granted. */
  openMinor: bigint;
  /** Per-purchase limits (`credit_config.top_up_limits`). */
  minMinor: bigint | null;
  maxMinor: bigint | null;
  /** ₹15,000 on an INR card / UPI mandate; null elsewhere. */
  afaCapMinor: bigint | null;
  monthlyCapMinor: bigint;
  /** Σ runs this calendar month in notice_sent | charging | pending | succeeded. */
  usedThisMonthMinor: bigint;
}

export type TopupAmount =
  | { kind: "run"; amountMinor: bigint }
  | { kind: "none" }
  | { kind: "skip"; reason: "monthly_cap" };

export function topupAmount(i: TopupAmountInput): TopupAmount {
  const have = i.balanceMinor + i.openMinor;
  let amount: bigint;
  if (i.trigger === "threshold") {
    const t = i.thresholdMinor!;
    if (have > t) return { kind: "none" };
    if (i.method === "fixed") {
      const a = i.amountMinor!;
      // The smallest k ≥ 1 with have + k·a > t: lands strictly above the threshold.
      const k = (t - have) / a + 1n;
      amount = (k < 1n ? 1n : k) * a;
    } else amount = i.targetMinor! - have;
  } else amount = i.method === "fixed" ? i.amountMinor! : i.targetMinor! - have;
  if (amount <= 0n) return { kind: "none" };

  if (i.minMinor != null && amount < i.minMinor) amount = i.minMinor;
  if (i.maxMinor != null && amount > i.maxMinor) amount = i.maxMinor;
  if (i.afaCapMinor != null && amount > i.afaCapMinor) amount = i.afaCapMinor;
  const left = i.monthlyCapMinor - i.usedThisMonthMinor;
  if (amount > left) amount = left;
  if (amount <= 0n || (i.minMinor != null && amount < i.minMinor))
    return { kind: "skip", reason: "monthly_cap" };
  return { kind: "run", amountMinor: amount };
}

/** The lowest threshold that covers `leadHours` of usage at `burnMinorPerDay` (rounded up). */
export function leadCoverMinor(leadHours: number, burnMinorPerDay: bigint): bigint {
  if (leadHours <= 0 || burnMinorPerDay <= 0n) return 0n;
  const num = BigInt(Math.round(leadHours * 1000)) * burnMinorPerDay;
  const den = 24n * 1000n;
  return (num + den - 1n) / den;
}

/**
 * The schedule slot due at `day` (a calendar day `YYYY-MM-DD` in the business time zone), or
 * null. A monthly day past month end fires on the last day. `weekday` is ISO (1 = Monday).
 */
export function scheduleSlotOn(schedule: AutoTopupSchedule, day: string): string | null {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  if (schedule.every === "week") {
    const iso = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
    return iso === schedule.weekday ? day : null;
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d === Math.min(schedule.day, last) ? day : null;
}
