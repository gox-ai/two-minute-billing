// The "Renews" control's model (design G3b §3.1): when plan credits or an allowance renew.
// Plain module, shared by the price form, the entitlement dialog and their actions.

export type ResetEvery =
  | "hour"
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "half_year"
  | "year"
  | "term"
  | "never";

export interface Reset {
  every: ResetEvery;
  count?: number;
  anchor?: "subscription" | "calendar";
}

/** An allowance that renews with the subscription's plan credits (the engine resolves it). */
export interface CreditsLink {
  same_as_credits: true;
}
export type AllowanceReset = Reset | CreditsLink;
export const isCreditsLink = (r: unknown): r is CreditsLink =>
  !!r && typeof r === "object" && (r as Record<string, unknown>).same_as_credits === true;

/**
 * What "Same as the credits" follows on a plan: the one schedule of its active per-cycle
 * prices, or why it cannot. Undefined when no price of the plan grants credits per period.
 */
export type CreditsLinkOption = { reset: Reset | null } | { blocked: string };

export function creditsLinkOption(
  prices: ReadonlyArray<{ active?: boolean; reset: Reset | null | undefined }>,
): CreditsLinkOption | undefined {
  if (!prices.length) return undefined;
  const live = prices.filter((p) => p.active !== false);
  if (!live.length) return { blocked: "No active price of this plan grants credits each period." };
  const labels = new Set(live.map((p) => resetLabel(p.reset)));
  if (labels.size > 1)
    return { blocked: "The prices of this plan renew their credits on different schedules." };
  return { reset: live[0]!.reset ?? null };
}

/** What the control edits. `count` is as typed. */
export interface ResetDraft {
  every: ResetEvery;
  count: string;
  anchor: "subscription" | "calendar";
}

const UNIT: Record<string, [string, string]> = {
  hour: ["hour", "hours"],
  day: ["day", "days"],
  week: ["week", "weeks"],
  month: ["month", "months"],
  quarter: ["quarter", "quarters"],
  half_year: ["half year", "half years"],
  year: ["year", "years"],
};

/** The interval options. Credits do not renew by the hour. */
export function everyOptions(target: "credits" | "allowance", count = "2") {
  const one = count.trim() === "1";
  const unit = (k: string) => {
    const w = UNIT[k]![one ? 0 : 1];
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  return [
    { value: "term", label: "Each billing term" },
    ...(target === "allowance" ? [{ value: "hour", label: unit("hour") }] : []),
    ...["day", "week", "month", "quarter", "half_year", "year"].map((k) => ({
      value: k,
      label: unit(k),
    })),
    { value: "never", label: "Never" },
  ];
}

export const hasCount = (e: ResetEvery) => e !== "term" && e !== "never";

export function draftOf(raw: AllowanceReset | null | undefined): ResetDraft {
  const r = isCreditsLink(raw) ? null : raw;
  return {
    every: r?.every ?? "term",
    count: String(r?.count ?? 1),
    anchor: r?.anchor ?? "subscription",
  };
}

/** The reset to send, null for "each billing term", or an error message. */
export function resetOf(
  d: ResetDraft,
): { ok: true; value: Reset | null } | { ok: false; message: string } {
  if (d.every === "term") return { ok: true, value: null };
  if (d.every === "never") return { ok: true, value: { every: "never" } };
  const n = /^\d+$/.test(d.count.trim()) ? Number(d.count.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 1000)
    return { ok: false, message: "Enter how often it renews, a whole number from 1 to 1,000." };
  return { ok: true, value: { every: d.every, count: n, anchor: d.anchor } };
}

/** "every month", "every 2 weeks, on the calendar", "each billing term", "never". */
export function resetLabel(r: AllowanceReset | null | undefined): string {
  if (isCreditsLink(r)) return "with the credits";
  if (!r || r.every === "term") return "each billing term";
  if (r.every === "never") return "never";
  const n = r.count ?? 1;
  const [one, many] = UNIT[r.every] ?? [r.every, r.every];
  const base = n === 1 ? `every ${one}` : `every ${n} ${many}`;
  return r.anchor === "calendar" ? `${base}, on the calendar` : base;
}
