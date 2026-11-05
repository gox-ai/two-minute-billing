// Usage controls: shared shapes and labels (client-safe, no API calls). API wrappers are in
// `lib/api/usage-controls.ts`.
import { money } from "@/lib/format";

export type LimitInterval = "day" | "week" | "month" | "period";
export type AlertKind = "usage_quantity" | "spend" | "credit_balance" | "credit_runway";
export type AlertThreshold = { value: number; unit: "minor" | "units" | "percent" | "days" };
export type AutoTopupTrigger = "threshold" | "schedule";
export type AutoTopupMethod = "fixed" | "target";
export type AutoTopupSchedule =
  | { every: "week"; weekday: number }
  | { every: "month"; day: number };

export const INTERVAL_LABEL: Record<LimitInterval, string> = {
  day: "Day",
  week: "Week (Monday to Sunday)",
  month: "Calendar month",
  period: "Billing period",
};
export const INTERVAL_SHORT: Record<LimitInterval, string> = {
  day: "per day",
  week: "per week",
  month: "per month",
  period: "per billing period",
};

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  usage_quantity: "Usage quantity",
  spend: "Spend",
  credit_balance: "Credit balance",
  credit_runway: "Credit runway",
};

export const ALERT_STATE_TONE = {
  armed: "gray",
  triggered: "tan",
  resolved: "green",
} as const;
export const ALERT_STATE_LABEL = { armed: "Armed", triggered: "Triggered", resolved: "Resolved" };

export const RUN_STATUS_LABEL: Record<string, string> = {
  created: "Created",
  notice_sent: "Notice sent",
  charging: "Charging",
  pending: "Payment pending",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const DISABLED_REASON_LABEL: Record<string, string> = {
  payment_declined: "The last payment was declined.",
  operator: "Turned off by you.",
  customer: "Turned off by the customer.",
};

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** "80%", "$400.00", "1,000 units", "3 days". */
export function thresholdLabel(t: AlertThreshold, currency: string | null): string {
  switch (t.unit) {
    case "percent":
      return `${t.value}%`;
    case "minor":
      return money(t.value, currency ?? "USD");
    case "days":
      return `${t.value} ${t.value === 1 ? "day" : "days"}`;
    default:
      return `${t.value.toLocaleString()} units`;
  }
}

export function runwayLabel(days: number | null): string {
  if (days == null) return "Not enough usage to estimate";
  if (days < 1) return "Runs out in less than a day";
  return days === 1 ? "Runs out in about 1 day" : `Runs out in about ${days} days`;
}

/**
 * Hours of usage a threshold covers at the current burn: "covers about N hours of usage at
 * the current rate". Null when burn is unknown or 0.
 */
export function coverHours(thresholdMinor: number, burnPerDay: number | null | undefined) {
  if (!burnPerDay || burnPerDay <= 0) return null;
  return Math.floor((thresholdMinor * 24) / burnPerDay);
}

export { topupLeadInputs } from "./topup-lead";

/** The smallest threshold that covers `leadHours` of burn (rounded up to a minor unit). */
export function leadCoverMinor(leadHours: number, burnPerDay: number): number {
  return Math.ceil((leadHours * burnPerDay) / 24);
}

export function scheduleLabel(s: AutoTopupSchedule | null): string {
  if (!s) return "—";
  return s.every === "week"
    ? `Every ${WEEKDAYS[s.weekday - 1] ?? "week"}`
    : `Every month on day ${s.day}`;
}

/** Whether "Preview a rate change" applies: a usage price that bills from a rate. */
export function canPreviewRateChange(p: {
  metered?: boolean;
  meter?: string | null;
  amount_source?: string | null;
  model: string;
}): boolean {
  if (!p.metered) return false;
  if (p.meter) return (p.amount_source ?? "rate") === "rate";
  return ["usage", "per_unit", "tiered", "volume", "stairstep"].includes(p.model);
}
