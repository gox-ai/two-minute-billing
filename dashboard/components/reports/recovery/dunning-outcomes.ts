import type { ReportPayload } from "@/components/reports/report-format";

/**
 * The retry ladder the engine falls back to when a business configures none —
 * `DUNNING_RETRY_DAYS` in `src/modules/subscriptions/dunning-schedule.ts`. Mirrored here
 * so the screen can SAY it is the fallback rather than printing it as a business setting.
 */
export const DUNNING_FALLBACK_RETRY_DAYS = [1, 3, 5, 7];

/**
 * The dunning outcome vocabulary, as `dunning_status_summary` buckets it.
 *
 * The engine emits the raw column value (`resolve.ts`, `bucketing: "dunning_status"`), and
 * the drill filter takes that same raw value — so a row is RELABELLED only after its link
 * has been built, never before.
 */
export const OUTCOME_LABEL: Record<string, string> = {
  in_progress: "Retrying",
  parked: "Waiting for the customer",
  succeeded: "Recovered",
  exhausted: "Retries exhausted",
  stopped: "Stopped by an operator",
};

/** Outcomes in the order a chase moves through them, with the fill each bar part takes. */
export const OUTCOME_FILLS: Array<{ key: string; fill: string }> = [
  { key: "succeeded", fill: "bg-success" },
  { key: "in_progress", fill: "bg-chart-1" },
  { key: "parked", fill: "bg-muted-foreground/40" },
  { key: "exhausted", fill: "bg-destructive" },
  { key: "stopped", fill: "bg-muted-foreground/20" },
];

export function outcomeLabel(group: string): string {
  return OUTCOME_LABEL[group] ?? group.replace(/_/g, " ");
}

/** Outcomes that are still moving — nothing about them is decided yet. */
const UNDECIDED = new Set(["in_progress", "parked"]);

export interface RecoveryTotals {
  /** Every invoice dunning has ever taken in — the opening population of the campaign. */
  everEntered: number;
  /** Settled by being paid. */
  recovered: number;
  /** Still under way, so neither recovered nor lost yet. */
  undecided: number;
  /** Exhausted or stopped — dunning is over and the money did not arrive. */
  lost: number;
  /**
   * Recovered ÷ everEntered, in basis points, or null when there is no population to
   * divide by. A floor rather than a final figure while `undecided > 0`.
   */
  rateBps: number | null;
}

/**
 * Roll the outcome buckets into the three numbers the headline needs.
 *
 * ⚠️ The denominator is `everEntered` — every invoice the campaign has taken in — and not
 * "the ones that finished". The summary applies NO window and counts every invoice dunning
 * has ever touched, so the whole set IS the opening population; dividing by the resolved
 * subset instead would quote a rate against a denominator that shrinks as work arrives.
 * While anything is still undecided the rate can only rise, which is what the screen says.
 */
export function recoveryTotals(
  rows: NonNullable<ReportPayload["rows"]> | undefined,
): RecoveryTotals {
  let everEntered = 0;
  let recovered = 0;
  let undecided = 0;
  for (const r of rows ?? []) {
    everEntered += r.value;
    if (r.group === "succeeded") recovered += r.value;
    else if (UNDECIDED.has(r.group)) undecided += r.value;
  }
  return {
    everEntered,
    recovered,
    undecided,
    lost: everEntered - recovered - undecided,
    rateBps: everEntered > 0 ? Math.round((recovered / everEntered) * 10000) : null,
  };
}
