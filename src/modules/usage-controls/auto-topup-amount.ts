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

export interface PackTopupInput {
  trigger: AutoTopupTrigger;
  /** In the unit's smallest step. */
  thresholdSteps: bigint | null;
  /** What the gate offers now: grants in their window, less unsettled usage and open holds. */
  balanceSteps: bigint;
  /** One purchase of the config: the pack's credits × the config's quantity, and its price. */
  packSteps: bigint;
  packMinor: bigint;
  /** "Recharge to N units": whole purchases to reach at least this. Null = one purchase. */
  targetSteps?: bigint | null;
  minMinor: bigint | null;
  maxMinor: bigint | null;
  afaCapMinor: bigint | null;
  monthlyCapMinor: bigint;
  usedThisMonthMinor: bigint;
}

export type PackTopup =
  | { kind: "run"; purchases: bigint; amountMinor: bigint }
  | { kind: "none" }
  | { kind: "skip"; reason: "monthly_cap" };

/**
 * A top-up of a unit with no rate buys whole packs. Threshold: when the balance is at or
 * below the threshold, the smallest number of purchases that lands above it. Schedule: one
 * purchase. With a target: the purchases that reach at least the target, rounded up. The
 * limits are in money and never split a pack; `none` when a limit is below the price of one
 * purchase.
 */
export function packTopup(i: PackTopupInput): PackTopup {
  if (i.packSteps <= 0n || i.packMinor <= 0n) return { kind: "none" };
  let k = 1n;
  if (i.trigger === "threshold" && i.balanceSteps > i.thresholdSteps!) return { kind: "none" };
  if (i.targetSteps != null) {
    const need = i.targetSteps - i.balanceSteps;
    if (need <= 0n) return { kind: "none" };
    k = (need + i.packSteps - 1n) / i.packSteps;
  } else if (i.trigger === "threshold") {
    k = (i.thresholdSteps! - i.balanceSteps) / i.packSteps + 1n;
  }
  if (i.minMinor != null && k * i.packMinor < i.minMinor)
    k = (i.minMinor + i.packMinor - 1n) / i.packMinor;
  for (const cap of [i.maxMinor, i.afaCapMinor])
    if (cap != null && k * i.packMinor > cap) k = cap / i.packMinor;
  if (k < 1n || (i.minMinor != null && k * i.packMinor < i.minMinor)) return { kind: "none" };
  const left = i.monthlyCapMinor - i.usedThisMonthMinor;
  if (k * i.packMinor > left) k = left > 0n ? left / i.packMinor : 0n;
  if (k < 1n || (i.minMinor != null && k * i.packMinor < i.minMinor))
    return { kind: "skip", reason: "monthly_cap" };
  return { kind: "run", purchases: k, amountMinor: k * i.packMinor };
}

export type PurchaseWindow = "hour" | "day" | "week" | "month";
export type PurchaseLimits = Partial<
  Record<PurchaseWindow, { count?: number; amount_minor?: number }>
>;

/**
 * The first window whose limit a new purchase of `amountMinor` would pass, or null. `runs`
 * are the config's runs that count (open or succeeded). Hour and week are the last 60 minutes
 * and 7 days; day and month start at `dayStart` and `monthStart` (the business's calendar).
 */
export function purchaseLimitHit(input: {
  limits: PurchaseLimits | null | undefined;
  runs: ReadonlyArray<{ createdAt: Date; amountMinor: bigint }>;
  amountMinor: bigint;
  now: Date;
  dayStart: Date;
  monthStart: Date;
}): PurchaseWindow | null {
  const from: Record<PurchaseWindow, number> = {
    hour: input.now.getTime() - 3_600_000,
    day: input.dayStart.getTime(),
    week: input.now.getTime() - 7 * 86_400_000,
    month: input.monthStart.getTime(),
  };
  for (const w of ["hour", "day", "week", "month"] as const) {
    const lim = input.limits?.[w];
    if (!lim) continue;
    const mine = input.runs.filter((r) => r.createdAt.getTime() >= from[w]);
    if (lim.count != null && mine.length >= lim.count) return w;
    const used = mine.reduce((s, r) => s + r.amountMinor, 0n);
    if (lim.amount_minor != null && used + input.amountMinor > BigInt(lim.amount_minor)) return w;
  }
  return null;
}

/** A soft decline of an automatic top-up for a unit with no rate is tried again. */
/**
 * Retries of a soft decline (0530): delays in hours, each from the try before. At most 5
 * tries (4 delays), all inside 72 hours. Default: the second try 4 hours after the first,
 * the third 12 hours later.
 */
export const TOPUP_RETRY = {
  defaultHours: [4, 12] as readonly number[],
  maxTries: 5,
  windowHours: 72,
} as const;

/** Why a list of retry delays is refused, or null. In-app text (ASD-STE100). */
export function topupRetryHoursIssue(hours: readonly number[]): string | null {
  if (hours.length > TOPUP_RETRY.maxTries - 1)
    return `Enter ${TOPUP_RETRY.maxTries - 1} delays or fewer. A top-up tries ${TOPUP_RETRY.maxTries} times at most`;
  if (hours.some((h) => !Number.isInteger(h) || h < 1))
    return "Enter each delay as a whole number of hours, 1 or more";
  if (hours.reduce((a, h) => a + h, 0) > TOPUP_RETRY.windowHours)
    return `The delays must add up to ${TOPUP_RETRY.windowHours} hours or less`;
  return null;
}

/**
 * The retry delays for a decline on this kind of payment method: its own list, else the
 * business list, else the default. Empty when the business turned retries off.
 */
export function topupRetryHours(
  cfg:
    | {
        auto_topup_retries?: boolean;
        auto_topup_retry_hours?: number[];
        auto_topup_retry_hours_by_method?: Partial<Record<"card" | "bank_debit", number[]>>;
      }
    | null
    | undefined,
  methodKind: "card" | "bank_debit" | null,
): readonly number[] {
  if (cfg?.auto_topup_retries === false) return [];
  return (
    (methodKind && cfg?.auto_topup_retry_hours_by_method?.[methodKind]) ||
    cfg?.auto_topup_retry_hours ||
    TOPUP_RETRY.defaultHours
  );
}

/** When the next try runs after `failedTries` failed, or null when no try is left. */
export function nextTopupTryAt(input: {
  failedTries: number;
  now: Date;
  hours: readonly number[];
}): Date | null {
  const delay = input.hours[input.failedTries - 1];
  if (delay == null || input.failedTries >= TOPUP_RETRY.maxTries) return null;
  return new Date(input.now.getTime() + delay * 3_600_000);
}
