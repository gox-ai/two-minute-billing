/**
 * Mail words for usage-control events (ASD-STE100), built from the event payload so the
 * outbox needs no usage-controls state.
 */
import { formatMoney } from "@/platform/currency";

const INTERVAL_WORD: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  period: "billing period",
};
const INTERVAL_NOW: Record<string, string> = {
  day: "today",
  week: "this week",
  month: "this month",
  period: "this billing period",
};

type Payload = Record<string, unknown>;
const obj = (v: unknown): Payload => (v && typeof v === "object" ? (v as Payload) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : undefined;

function valueText(kind: string, currency: string | undefined, v: unknown): string {
  const n = num(v);
  if (n === undefined) return "";
  if (kind === "credit_runway") return n === 1 ? "1 day" : `${n} days`;
  if ((kind === "spend" || kind === "credit_balance") && currency && typeof v === "number")
    return formatMoney(n, currency);
  return String(v);
}

/** Vars for `usage_alert` from a `usage_alert_triggered` payload. */
export function usageAlertMailVars(raw: Payload, formatDate: (d: Date) => string) {
  const a = obj(raw.usage_alert);
  const t = obj(raw.threshold);
  const kind = str(a.kind) ?? "";
  const cur = str(a.currency);
  const interval = str(a.interval) ?? "";
  const meter = str(a.meter);
  const pct = t.unit === "percent" ? `${num(t.value)}%` : null;
  const thresholdText = valueText(kind, cur, raw.threshold_value);
  let summary: string;
  switch (kind) {
    case "spend":
      summary = pct
        ? `You used ${pct} of your ${INTERVAL_WORD[interval] ?? ""} spend limit`
        : `Your spend ${INTERVAL_NOW[interval] ?? ""} reached ${thresholdText}`;
      break;
    case "usage_quantity":
      summary = pct
        ? `You used ${pct} of your ${INTERVAL_WORD[interval] ?? ""} allowance for ${meter ?? "usage"}`
        : `Your usage of ${meter ?? "a meter"} ${INTERVAL_NOW[interval] ?? ""} reached ${thresholdText}`;
      break;
    case "credit_balance":
      summary = pct
        ? `Your credit balance fell to ${pct} of your credit`
        : `Your credit balance fell to ${thresholdText}`;
      break;
    default:
      summary = `Your credit can run out in ${thresholdText} or less`;
  }
  const resets = str(raw.resets_at);
  const ref = raw.reference_value;
  return {
    alertSummary: summary.replace(/\s+/g, " ").trim(),
    usageValue: valueText(kind, cur, raw.value),
    ...(ref != null && kind !== "credit_runway" ? { limitValue: valueText(kind, cur, ref) } : {}),
    ...(resets && (kind === "spend" || kind === "usage_quantity")
      ? { resetDate: formatDate(new Date(resets)) }
      : {}),
  };
}

/** Vars for `spend_limit_reached`. */
export function spendLimitMailVars(raw: Payload, formatDate: (d: Date) => string) {
  const l = obj(raw.spend_limit);
  const cur = str(l.currency) ?? "USD";
  const resets = str(raw.resets_at);
  return {
    usageValue: formatMoney(num(raw.spent_minor) ?? 0, cur),
    limitValue: formatMoney(num(l.amount_minor) ?? 0, cur),
    intervalLabel: INTERVAL_WORD[str(l.interval) ?? ""] ?? "",
    ...(resets ? { resetDate: formatDate(new Date(resets)) } : {}),
    ...(raw.mode === "hard" ? { hardLimit: "yes" } : {}),
  };
}
