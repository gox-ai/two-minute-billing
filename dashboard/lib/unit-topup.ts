// Automatic top-up for a credit unit with no money value (0527): the form's conversion to
// the API body, its checks, and the labels of the customer's card. Pure, relative imports.
import { currencyExponent, toMajorInput } from "./money";
import { money } from "./format";
import { creditsLabel, type UnitNames } from "./meter-credit-cost";

export const LIMIT_WINDOWS = ["hour", "day", "week", "month"] as const;
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];
export type PurchaseLimits = Partial<
  Record<LimitWindow, { count?: number | null; amount_minor?: number | null }>
>;

export const LIMIT_WINDOW_LABEL: Record<LimitWindow, string> = {
  hour: "Last 60 minutes",
  day: "Calendar day",
  week: "Last 7 days",
  month: "Calendar month",
};

/** The fields of `auto_topup` that a top-up in units uses. */
export interface UnitTopupConfig {
  id: string;
  currency: string;
  unit: string | null;
  trigger: "threshold" | "schedule";
  method: "fixed" | "target";
  threshold_units?: string | null;
  pack_price?: string | null;
  pack_quantity?: number | null;
  target_units?: string | null;
  purchase_limits?: PurchaseLimits | null;
  monthly_cap_minor: number;
  max_runs_per_day: number;
  payment_method: string | null;
  status: "active" | "disabled";
  disabled_reason: string | null;
  disabled_at: string | null;
}

/** A run of `GET …/auto_topup/runs`, with the fields this card reads. */
export interface UnitTopupRun {
  id: string;
  auto_topup?: string | null;
  status: string;
  amount_minor: number;
  currency: string;
  charge_after: string | null;
  decline_code: string | null;
  /** Failed charge tries of this run. */
  attempts?: number;
  failure_message: string | null;
  created_at: string;
}

export interface UnitTopupDraft {
  pack_price: string;
  method: "" | "fixed" | "target";
  pack_quantity: string;
  target_units: string;
  threshold_units: string;
  monthly_cap: string;
  max_runs_per_day: string;
  payment_method: string;
  limits: Record<LimitWindow, { count: string; amount: string }>;
}

const emptyLimits = () =>
  Object.fromEntries(LIMIT_WINDOWS.map((w) => [w, { count: "", amount: "" }])) as Record<
    LimitWindow,
    { count: string; amount: string }
  >;

/** The form's starting values. A new top-up preselects the one pack there is. */
export function unitTopupDraft(
  cfg: UnitTopupConfig | null | undefined,
  packs: ReadonlyArray<{ value: string }>,
  currency: string,
): UnitTopupDraft {
  const limits = emptyLimits();
  for (const w of LIMIT_WINDOWS) {
    const l = cfg?.purchase_limits?.[w];
    if (!l) continue;
    limits[w] = {
      count: l.count != null ? String(l.count) : "",
      amount: toMajorInput(l.amount_minor ?? null, currency),
    };
  }
  return {
    pack_price: cfg?.pack_price ?? (packs.length === 1 ? packs[0]!.value : ""),
    method: cfg ? cfg.method : "",
    pack_quantity: cfg?.pack_quantity != null ? String(cfg.pack_quantity) : "1",
    target_units: cfg?.target_units ?? "",
    threshold_units: cfg?.threshold_units ?? "",
    monthly_cap: toMajorInput(cfg?.monthly_cap_minor ?? null, currency),
    max_runs_per_day: String(cfg?.max_runs_per_day ?? 3),
    payment_method: cfg?.payment_method ?? "",
    limits,
  };
}

/** Credits as typed, at the unit's precision. Null when not a plain decimal that fits. */
export function unitsText(text: string, decimals: number, allowZero: boolean): string | null {
  const t = text.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m || (m[2] ?? "").length > decimals) return null;
  if (!allowZero && !/[1-9]/.test(t)) return null;
  return t;
}

/** A money amount in major units → minor, exactly. Null when not a positive amount. */
export function majorText(text: string, currency: string): number | null {
  const t = text.trim();
  const exp = currencyExponent(currency);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m || (m[2] ?? "").length > exp) return null;
  const n = Number(m[1]! + (m[2] ?? "").padEnd(exp, "0"));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const wholeIn = (t: string, lo: number, hi: number) =>
  /^\d+$/.test(t.trim()) && Number(t) >= lo && Number(t) <= hi ? Number(t) : null;

/** The error key of one purchase limit field. */
export const limitKey = (w: LimitWindow, f: "count" | "amount") => `limit_${w}_${f}`;

export interface UnitTopupBody {
  unit: string;
  trigger: "threshold";
  threshold_units: string;
  method: "fixed" | "target";
  pack_price: string;
  pack_quantity?: number;
  target_units?: string;
  monthly_cap_minor: number;
  max_runs_per_day: number;
  payment_method: string | null;
  /** null clears every limit. */
  purchase_limits: PurchaseLimits | null;
}

/**
 * The PUT body of a top-up that buys a pack when the balance falls to a number of credits.
 * The checks match the API's, so a mistake shows on its field before the round trip.
 */
export function unitTopupBody(
  d: UnitTopupDraft,
  ctx: { unit: string; currency: string; decimals: number; packMinor: number | null },
): { ok: true; body: UnitTopupBody } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const dp = ctx.decimals;
  const places =
    dp === 0
      ? "a whole number"
      : `a number with at most ${dp} ${dp === 1 ? "decimal place" : "decimal places"}`;
  if (!d.pack_price) errors.pack_price = "Select a credit pack.";
  const threshold = unitsText(d.threshold_units, dp, true);
  if (threshold === null) errors.threshold_units = `Enter 0 or more, as ${places}.`;
  let quantity: number | null = null;
  let target: string | null = null;
  if (d.method === "fixed") {
    quantity = wholeIn(d.pack_quantity, 1, 1000);
    if (quantity === null) errors.pack_quantity = "Enter a whole number from 1 to 1,000.";
  } else if (d.method === "target") {
    target = unitsText(d.target_units, dp, false);
    if (target === null) errors.target_units = `Enter more than 0, as ${places}.`;
    else if (threshold !== null && Number(target) <= Number(threshold))
      errors.target_units = "Enter more than the balance that starts a top-up.";
  } else errors.method = "Select how much to buy.";
  const cap = majorText(d.monthly_cap, ctx.currency);
  if (cap === null) errors.monthly_cap = "Enter an amount more than 0.";
  else if (ctx.packMinor != null && quantity != null && cap < ctx.packMinor * quantity)
    errors.monthly_cap = `Enter ${money(ctx.packMinor * quantity, ctx.currency)} or more. That is the price of one top-up.`;
  else if (ctx.packMinor != null && cap < ctx.packMinor)
    errors.monthly_cap = `Enter ${money(ctx.packMinor, ctx.currency)} or more. That is the price of one pack.`;
  const runs = wholeIn(d.max_runs_per_day, 1, 10);
  if (runs === null) errors.max_runs_per_day = "Enter a whole number from 1 to 10.";
  const limits: PurchaseLimits = {};
  for (const w of LIMIT_WINDOWS) {
    const { count, amount } = d.limits[w];
    const l: { count?: number; amount_minor?: number } = {};
    if (count.trim()) {
      const c = wholeIn(count, 1, 1000);
      if (c === null) errors[limitKey(w, "count")] = "Enter a whole number from 1 to 1,000.";
      else l.count = c;
    }
    if (amount.trim()) {
      const a = majorText(amount, ctx.currency);
      if (a === null) errors[limitKey(w, "amount")] = "Enter an amount more than 0.";
      else l.amount_minor = a;
    }
    if (l.count != null || l.amount_minor != null) limits[w] = l;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      unit: ctx.unit,
      trigger: "threshold",
      threshold_units: threshold!,
      method: d.method as "fixed" | "target",
      pack_price: d.pack_price,
      ...(d.method === "fixed" ? { pack_quantity: quantity! } : { target_units: target! }),
      monthly_cap_minor: cap!,
      max_runs_per_day: runs!,
      payment_method: d.payment_method || null,
      purchase_limits: Object.keys(limits).length ? limits : null,
    },
  };
}

/** The field an API refusal names (its messages use the API field names). */
export function unitTopupErrorField(message: string): string | null {
  const m = /purchase_limits\.(hour|day|week|month)/.exec(message);
  if (m) return limitKey(m[1] as LimitWindow, "count");
  for (const [needle, field] of [
    ["target_units", "target_units"],
    ["threshold_units", "threshold_units"],
    ["pack_quantity", "pack_quantity"],
    ["monthly_cap_minor", "monthly_cap"],
    ["max_runs_per_day", "max_runs_per_day"],
    ["pack_price", "pack_price"],
    ["credit pack", "pack_price"],
    ["payment method", "payment_method"],
  ] as const)
    if (message.includes(needle)) return field;
  return null;
}

/** The state line of a top-up in units, from the config and its newest run. */
export function unitTopupState(
  cfg: Pick<UnitTopupConfig, "id" | "status" | "disabled_reason">,
  runs: ReadonlyArray<UnitTopupRun>,
  opts: {
    /** The tries of the business schedule; null when the kinds of method differ. */
    maxTries?: number | null;
    /** False: no payment method that we can charge. */
    canCharge?: boolean;
  } = {},
): {
  tone: "green" | "gray" | "red" | "tan";
  label: string;
  detail: string | null;
  /** A declined try that the engine tries again at this time. */
  retryAt: string | null;
  failedTries: number;
} {
  const mine = runs.filter((r) => r.auto_topup === cfg.id);
  const last = mine[0];
  const failedTries = last?.attempts ?? 0;
  if (cfg.status === "active") {
    if (opts.canCharge === false)
      return {
        tone: "tan",
        label: "On",
        detail: "We cannot buy credit. The customer has no payment method that we can charge.",
        retryAt: null,
        failedTries: 0,
      };
    if (last && last.status === "created" && failedTries > 0 && last.charge_after)
      return {
        tone: "tan",
        label: "On",
        detail:
          opts.maxTries != null && opts.maxTries > failedTries
            ? `Try ${failedTries} of ${opts.maxTries} was declined. We try again.`
            : `The last payment was declined ${failedTries === 1 ? "1 time" : `${failedTries} times`}. We try again.`,
        retryAt: last.charge_after,
        failedTries,
      };
    return { tone: "green", label: "On", detail: null, retryAt: null, failedTries: 0 };
  }
  switch (cfg.disabled_reason) {
    case "payment_declined":
      return {
        tone: "red",
        label: "Off",
        detail: "The payment was declined. We do not try again.",
        retryAt: null,
        failedTries,
      };
    case "retries_exhausted":
      return {
        tone: "red",
        label: "Off",
        detail: `The payment was declined ${failedTries > 1 ? `${failedTries} times` : "on each try"}.`,
        retryAt: null,
        failedTries,
      };
    case "customer":
      return {
        tone: "gray",
        label: "Off",
        detail: "The customer disabled it in the portal.",
        retryAt: null,
        failedTries,
      };
    default:
      return { tone: "gray", label: "Off", detail: "You disabled it.", retryAt: null, failedTries };
  }
}

/** "When the balance is 50 credits or less". */
export const thresholdLine = (cfg: Pick<UnitTopupConfig, "threshold_units">, unit: UnitNames) =>
  cfg.threshold_units != null
    ? `When the balance is ${creditsLabel(cfg.threshold_units, unit)} or less`
    : "On a schedule";

/** "Buys 2 packs" / "Buys packs until the balance is 5,000 credits or more". */
export function buysLine(
  cfg: Pick<UnitTopupConfig, "method" | "pack_quantity" | "target_units">,
  unit: UnitNames,
): string {
  if (cfg.method === "target" && cfg.target_units != null)
    return `Buys packs until the balance is ${creditsLabel(cfg.target_units, unit)} or more`;
  const q = cfg.pack_quantity ?? 1;
  return q === 1 ? "Buys 1 pack" : `Buys ${q.toLocaleString("en-US")} packs`;
}

/** "$1,000.00 each month · 3 top-ups a day". */
export const capLine = (
  cfg: Pick<UnitTopupConfig, "monthly_cap_minor" | "max_runs_per_day" | "currency">,
) =>
  // No-break spaces and a no-break hyphen inside each half: the line breaks only at the dot.
  `${money(cfg.monthly_cap_minor, cfg.currency)}\u00a0each\u00a0month · ${
    cfg.max_runs_per_day === 1 ? "1\u00a0top\u2011up" : `${cfg.max_runs_per_day}\u00a0top\u2011ups`
  }\u00a0a\u00a0day`;

/** One line per window that has a limit: "Calendar day: 2 purchases, $50.00". */
export function purchaseLimitLines(limits: PurchaseLimits | null | undefined, currency: string) {
  return LIMIT_WINDOWS.flatMap((w) => {
    const l = limits?.[w];
    if (!l || (l.count == null && l.amount_minor == null)) return [];
    const parts = [
      l.count != null ? `${l.count} ${l.count === 1 ? "purchase" : "purchases"}` : null,
      l.amount_minor != null ? money(l.amount_minor, currency) : null,
    ].filter(Boolean);
    return [`${LIMIT_WINDOW_LABEL[w]}: ${parts.join(", ")}`];
  });
}
