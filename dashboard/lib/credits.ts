// Credit units, grants and holds: shared shapes and pure helpers (client-safe, no API calls).
// Shapes follow design G3 § 7. The API wrappers live in `lib/api/credits.ts`.

import { currencyExponent } from "./money";
import type { Reset } from "./reset";
import { money } from "./format";
import type { PermissionKey } from "./permissions.generated";
import { resolveTopupRetry, type TopupRetryResolved } from "./topup-retry";

export type CreditOnExhausted = "block" | "bill";
export type CreditTaxTreatment = "taxed_at_purchase" | "taxed_at_use";
export type CreditCategory = "paid" | "promotional";
export type CreditApplicability =
  | { kind: "metered" }
  | { kind: "prices"; prices: string[] }
  | { kind: "meters"; meters: string[] };

/** Credit scope (2.55): a business-wide narrowing of grants that pay all usage. */
export type CreditScope = Exclude<CreditApplicability, { kind: "metered" }>;

/** New with PR 2; cast until `permissions:generate` lists it. */
export const CREDIT_HOLDS_MANAGE = "credit_holds:manage" as PermissionKey;

export interface CreditUnit {
  object: "credit_unit";
  /** The slug key: unique per business, fixed after create. */
  id: string;
  name: string;
  plural_name: string;
  currency: string;
  /** Minor units of `currency` per 1 unit, as a decimal string (≤ 12 dp). Null = no rate. */
  minor_per_unit: string | null;
  /** 0–4: grant amounts are whole numbers of 10^-decimals units. */
  decimals: number;
  /** True after the first grant in this unit: currency, rate and decimals are then fixed. */
  locked: boolean;
  locked_at: string | null;
  status: "active" | "archived";
  created_at: string;
  resource_version?: number;
}

/** Money is the implicit unit: `unit = null`, amounts in minor units. */
export interface UnitInfo {
  key: string | null;
  name: string;
  plural: string;
  decimals: number;
  currency: string;
  /** False for a unit with no money rate: its credit has no money value. Absent = rated. */
  rated?: boolean;
}

export function unitInfo(units: CreditUnit[], key: string | null, currency: string): UnitInfo {
  if (key == null) return { key: null, name: currency, plural: currency, decimals: 0, currency };
  const u = units.find((x) => x.id === key);
  return u
    ? {
        key,
        name: u.name,
        plural: u.plural_name,
        decimals: u.decimals,
        currency: u.currency,
        rated: u.minor_per_unit != null,
      }
    : { key, name: key, plural: key, decimals: 0, currency };
}

/** A unit amount as a number only: "1,250". Not for money. */
export function unitCount(amount: number, info: Pick<UnitInfo, "decimals">): string {
  return (amount / 10 ** info.decimals).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: info.decimals,
  });
}

/**
 * What a hold reserves now: money, or credits for a hold in units ("10 credits"). A lease
 * that captured a step reserves only `remaining_units`; `ofTotal` then adds what it held
 * at first ("700 of 900 credits").
 */
export function holdAmount(
  h: {
    amount_minor: number;
    currency: string;
    unit?: string | null;
    units?: string | null;
    remaining_units?: string | null;
  },
  units: CreditUnit[],
  opts: { ofTotal?: boolean } = {},
): string {
  if (!h.unit || h.units == null) return money(h.amount_minor, h.currency);
  const info = unitInfo(units, h.unit, h.currency);
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: info.decimals });
  const total = Number(h.units);
  const now = h.remaining_units != null ? Number(h.remaining_units) : total;
  const name = (n: number) => (n === 1 ? info.name : info.plural);
  if (opts.ofTotal && now !== total) return `${fmt(now)} of ${fmt(total)} ${name(total)}`;
  return `${fmt(now)} ${name(now)}`;
}

/**
 * The steps of a lease in units, under its amount: what it reserved at first and what its
 * captures took so far. Empty for a hold in money and for a hold with no capture yet.
 */
export function holdLeaseLines(
  h: {
    unit?: string | null;
    units?: string | null;
    captured_units?: string | null;
    currency: string;
  },
  units: CreditUnit[],
): string[] {
  if (!h.unit || h.units == null || h.captured_units == null || !(Number(h.captured_units) > 0))
    return [];
  const info = unitInfo(units, h.unit, h.currency);
  const fmt = (t: string) => {
    const n = Number(t);
    return `${n.toLocaleString("en-US", { maximumFractionDigits: info.decimals })} ${n === 1 ? info.name : info.plural}`;
  };
  return [`Reserved ${fmt(h.units)}`, `Captured ${fmt(h.captured_units)}`];
}

/**
 * Under the available figure of a unit with no rate: what open holds reserve and what usage
 * took that no settlement drew yet. Available + these = the credit in the grants. A zero
 * line is left out.
 */
export function heldUnsettledRows(
  parts: { held?: number; unsettled?: number },
  info: UnitInfo,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (parts.held) rows.push({ label: "Held by open holds", value: fmtUnits(parts.held, info) });
  if (parts.unsettled)
    rows.push({ label: "Used, not settled yet", value: fmtUnits(parts.unsettled, info) });
  return rows;
}

/** An amount in the unit's smallest step, for people: "1,250 credits" or "$12.50". */
export function fmtUnits(amount: number, info: UnitInfo): string {
  if (info.key == null) return money(amount, info.currency);
  const n = amount / 10 ** info.decimals;
  return `${unitCount(amount, info)} ${Math.abs(n) === 1 ? info.name : info.plural}`;
}

/**
 * The customer's balance card. Credit in a unit with no rate is not part of the money
 * figure: it gets its own rows, and leads the card when the customer holds nothing else.
 */
export function balanceView(
  balance: {
    currency: string;
    available_minor: number;
    grants_minor: number;
    available_units: Array<{
      unit: string;
      units: number;
      held_units?: number;
      unsettled_units?: number;
    }>;
  },
  info: (key: string | null) => UnitInfo,
): {
  lead: "money" | "units";
  /** Rows of the money block: units with a rate. */
  rated: Array<{ unit: UnitInfo; units: number }>;
  /** With what open holds reserve and what is used but not settled yet. */
  unrated: Array<{ unit: UnitInfo; units: number; held?: number; unsettled?: number }>;
} {
  const rows = balance.available_units.map((u) => ({
    unit: info(u.unit === balance.currency ? null : u.unit),
    units: u.units,
    held: u.held_units,
    unsettled: u.unsettled_units,
  }));
  const unrated = rows.filter((r) => r.unit.rated === false);
  const noMoney = balance.grants_minor === 0 && balance.available_minor === 0;
  return {
    lead: noMoney && unrated.some((r) => r.units > 0) ? "units" : "money",
    // Not the money entry (keyed by the currency code): it is credit left after usage but
    // before open holds, so it differs from the available figure, which stands for money.
    rated: rows
      .filter((r) => r.unit.key != null && r.unit.rated !== false)
      .map(({ unit, units }) => ({ unit, units })),
    unrated,
  };
}

/** The Value column says something only when a row has a money value. */
export const hasMoneyValue = (rows: Array<Pick<UnitInfo, "rated">>) =>
  rows.some((r) => r.rated !== false);

/** A unit in a list of units: one with no money value shows no currency. */
export const unitOptionLabel = (
  u: Pick<CreditUnit, "plural_name" | "currency" | "minor_per_unit">,
) => (u.minor_per_unit == null ? u.plural_name : `${u.plural_name} (${u.currency})`);

/**
 * A movement's Units and Value cells. Both go through `fmtUnits`/`money`, so a money
 * movement reads the same in both, minus sign included. A unit with no rate has no value.
 */
export function movementCells(
  units: number,
  faceMinor: number,
  info: UnitInfo,
): { units: string; value: string } {
  return {
    units: fmtUnits(units, info),
    value: info.rated === false ? "—" : money(faceMinor, info.currency),
  };
}

/** A pack offer, as the portal states it: "€20.00 of credit" or "1,000 tokens". */
export function packCreditLabel(p: {
  unit: string | null;
  unit_name: string;
  unit_plural_name: string;
  decimals: number;
  credit_amount: number;
  currency: string;
}): string {
  if (p.unit == null) return `${money(p.credit_amount, p.currency)} of credit`;
  return fmtUnits(p.credit_amount, {
    key: p.unit,
    name: p.unit_name,
    plural: p.unit_plural_name,
    decimals: p.decimals,
    currency: p.currency,
  });
}

/**
 * A typed decimal ("12.5") → the unit's smallest step (1250 at 2 decimals). Null when the
 * text is not a positive number with at most `decimals` places. Money uses the currency's
 * own exponent.
 */
export function toSmallestStep(text: string, decimals: number): number | null {
  const t = text.trim();
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const [whole = "", frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const n = Number(whole + frac.padEnd(decimals, "0"));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Decimals for a grant amount typed in this unit (money → the currency exponent). */
export const amountDecimals = (unitKey: string | null, decimals: number, currency: string) =>
  unitKey == null ? currencyExponent(currency) : decimals;

/**
 * "0.01" major per unit → minor per unit as a decimal string ("1" for USD). String math, so
 * no float error; ≤ 12 dp kept. Null when not a positive decimal.
 */
export function majorRateToMinorDecimal(major: string, currency: string): string | null {
  const t = major.trim();
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const exp = currencyExponent(currency);
  const [whole = "", frac = ""] = t.split(".");
  const digits = whole + frac.padEnd(exp, "0");
  const point = whole.length + exp;
  let intPart = digits.slice(0, point).replace(/^0+(?=\d)/, "");
  let fracPart = digits.slice(point).replace(/0+$/, "");
  if (fracPart.length > 12) return null;
  if (intPart === "") intPart = "0";
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return /^0(?:\.0*)?$/.test(out) ? null : out;
}

/** The most decimal places a money value of one unit can have, in major units of the currency. */
export const maxRateDecimals = (currency: string) => 12 + currencyExponent(currency);

/** One status word for a grant on every page: a grant with nothing left is "Used up". */
export function grantStatusKey(status: string, remainingUnits: number): string {
  if (status === "voided" || status === "expired") return status;
  if (status === "pending") return "not_started";
  return remainingUnits === 0 ? "used_up" : "active";
}

/**
 * The unit form's Money value choice → `minor_per_unit`. Null = no money value, which the
 * API takes on create and on a unit with no grant yet. Undefined = the rate is not correct.
 */
export function unitFormRate(
  noRate: string | undefined,
  rate: string | undefined,
  currency: string,
): string | null | undefined {
  if (noRate === "1") return null;
  return (rate && majorRateToMinorDecimal(rate, currency)) || undefined;
}

/** The inverse, for the edit form: "1" minor per unit (USD) → "0.01". */
export function minorDecimalToMajor(minor: string, currency: string): string {
  const exp = currencyExponent(currency);
  const [whole = "", frac = ""] = minor.split(".");
  const padded = whole.padStart(exp + 1, "0");
  const intPart = padded.slice(0, padded.length - exp);
  const out = `${intPart}.${padded.slice(padded.length - exp)}${frac}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}

/** "1 credit = $0.01", with full precision for a sub-cent rate. */
export function rateSentence(u: Pick<CreditUnit, "name" | "currency" | "minor_per_unit">) {
  if (u.minor_per_unit == null) return "No money value";
  return `1 ${u.name} = ${u.currency} ${minorDecimalToMajor(u.minor_per_unit, u.currency)}`;
}

export const CATEGORY_LABEL: Record<CreditCategory, string> = {
  paid: "Paid",
  promotional: "Promotional",
};

export const SOURCE_LABEL: Record<string, string> = {
  purchase: "Purchase",
  plan_cycle: "Plan credits",
  manual: "Given by hand",
  restore: "Restored",
  auto_top_up: "Automatic top-up",
};

export const TAX_TREATMENT_LABEL: Record<CreditTaxTreatment, string> = {
  taxed_at_purchase: "Taxed at purchase",
  taxed_at_use: "Taxed at use",
};

export const POLICY_LABEL: Record<CreditOnExhausted, string> = {
  block: "Block usage",
  bill: "Bill usage",
};

export const TXN_KIND_LABEL: Record<string, string> = {
  grant: "Granted",
  activate: "Activated",
  draw: "Applied to invoice",
  expire: "Expired",
  void: "Voided",
  restore: "Restored",
  rollover_in: "Rolled over in",
  rollover_out: "Rolled over out",
};

/** A draw made by a usage settlement has no invoice: it paid for usage. */
export const txnKindLabel = (t: { kind: string; settlement?: string | null }) =>
  t.kind === "draw" && t.settlement ? "Used for usage" : (TXN_KIND_LABEL[t.kind] ?? t.kind);

/** Where the effective policy came from (access check `on_exhausted.source`), as a sentence. */
export const POLICY_SOURCE_LABEL: Record<string, string> = {
  business_blocking_off: "Blocking is off for the business.",
  customer_override: "The customer override sets this.",
  grant: "A credit grant sets this.",
  plan_price: "The plan price sets this.",
  business_default: "The business default sets this.",
};

export const IN_FLIGHT_APPLIES = ["always", "other_holds_open"] as const;
export type InFlightApplies = (typeof IN_FLIGHT_APPLIES)[number];

// Engine choices of `credit_config`. Each resolves to the rule from before its key.
export const TRIAL_USAGE = ["refuse", "overdraft_only", "as_paid"] as const;
export type TrialUsage = (typeof TRIAL_USAGE)[number];
export const NO_SUBSCRIPTION_USAGE = ["block", "as_subscriber"] as const;
export type NoSubscriptionUsage = (typeof NO_SUBSCRIPTION_USAGE)[number];
export const NO_SUBSCRIPTION_OVERDRAFT = ["needs_payment_method", "always", "never"] as const;
export type NoSubscriptionOverdraft = (typeof NO_SUBSCRIPTION_OVERDRAFT)[number];
export const AUTO_TOPUP_ON_HARD_DECLINE = ["disable", "keep_enabled"] as const;
export type AutoTopupOnHardDecline = (typeof AUTO_TOPUP_ON_HARD_DECLINE)[number];
export const CAPTURE_OVER_HOLD = ["debt", "cap_at_hold"] as const;
export type CaptureOverHold = (typeof CAPTURE_OVER_HOLD)[number];
/** The API's bounds and the value of an unset key. */
export const NO_SUBSCRIPTION_INVOICE_DAYS = { min: 1, max: 90, default: 30 } as const;
export const RESTORE_EXPIRY_MONTHS = { min: 1, max: 120, default: 12 } as const;

/** `credit_config` with the API's defaults (design G3 § 5, 0464) filled in. */
export interface ResolvedCreditConfig extends TopupRetryResolved {
  hold_default_seconds: number;
  in_flight_share_bps: number;
  /** When the share applies: to every hold, or only while another hold is open. */
  in_flight_applies: InFlightApplies;
  blocking_enabled: boolean;
  on_exhausted_default: CreditOnExhausted;
  overdraft_limit_minor: Record<string, number>;
  top_up_limits: Record<string, { min_minor?: number | null; max_minor?: number | null }>;
  /** Free credit an operator gives (0495): refused above `max_minor`, alerted above the other. */
  grant_limits: Record<string, { max_minor?: number | null; alert_above_minor?: number | null }>;
  /**
   * The same limits for a unit with no money rate, per unit key, in the unit's smallest
   * step. `grant_limits` does not apply to such a unit.
   */
  unit_grant_limits: Record<
    string,
    { max_units?: number | null; alert_above_units?: number | null }
  >;
  default_tax_treatment: CreditTaxTreatment | null;
  credit_scope: CreditScope | null;
  /** Buyers can enable and disable an automatic top-up in units in the portal. */
  portal_auto_topup: boolean;
  /** Usage paid in credits: how long a late event still takes from credit that closed since. */
  late_event_grace_hours: number;
  trial_usage: TrialUsage;
  no_subscription_usage: NoSubscriptionUsage;
  no_subscription_overdraft: NoSubscriptionOverdraft;
  no_subscription_invoice_after_days: number;
  /** Months, or "never". */
  restore_expiry_months: number | "never";
  auto_topup_on_hard_decline: AutoTopupOnHardDecline;
  capture_over_hold: CaptureOverHold;
}

/** `late_event_grace_hours` when the business has not set it; the API's limit. */
export const LATE_EVENT_GRACE_DEFAULT = 12;
export const LATE_EVENT_GRACE_MAX = 24 * 35;

export type CreditConfigInput = Partial<ResolvedCreditConfig> | null | undefined;
export type { TopupRetryResolved };

export function resolveCreditConfig(c: CreditConfigInput): ResolvedCreditConfig {
  return {
    hold_default_seconds: c?.hold_default_seconds ?? 60,
    in_flight_share_bps: c?.in_flight_share_bps ?? 5000,
    in_flight_applies: c?.in_flight_applies ?? "always",
    blocking_enabled: c?.blocking_enabled ?? false,
    on_exhausted_default: c?.on_exhausted_default ?? "bill",
    overdraft_limit_minor: c?.overdraft_limit_minor ?? {},
    top_up_limits: c?.top_up_limits ?? {},
    grant_limits: c?.grant_limits ?? {},
    unit_grant_limits: c?.unit_grant_limits ?? {},
    default_tax_treatment: c?.default_tax_treatment ?? null,
    credit_scope: c?.credit_scope ?? null,
    portal_auto_topup: c?.portal_auto_topup ?? false,
    late_event_grace_hours: c?.late_event_grace_hours ?? LATE_EVENT_GRACE_DEFAULT,
    trial_usage: c?.trial_usage ?? "refuse",
    no_subscription_usage: c?.no_subscription_usage ?? "block",
    no_subscription_overdraft: c?.no_subscription_overdraft ?? "needs_payment_method",
    no_subscription_invoice_after_days:
      c?.no_subscription_invoice_after_days ?? NO_SUBSCRIPTION_INVOICE_DAYS.default,
    restore_expiry_months: c?.restore_expiry_months ?? RESTORE_EXPIRY_MONTHS.default,
    auto_topup_on_hard_decline: c?.auto_topup_on_hard_decline ?? "disable",
    capture_over_hold: c?.capture_over_hold ?? "debt",
    ...resolveTopupRetry(c),
  };
}

export interface CustomerCreditSettings {
  on_exhausted?: CreditOnExhausted | null;
  overdraft_limit_minor?: Record<string, number>;
  override_expires_at?: string | null;
}

/** `prices.grants_credit` (0465). */
export type PriceGrantsCredit =
  | {
      kind: "pack";
      unit: string | null;
      amount: number;
      category: "paid";
      priority?: number;
      expires_after: { days: number } | null;
      applicability?: CreditApplicability;
      tax_treatment?: CreditTaxTreatment | null;
      on_exhausted?: CreditOnExhausted | null;
    }
  | {
      kind: "per_cycle";
      unit: string | null;
      amount: number;
      priority?: number;
      applicability?: CreditApplicability;
      on_exhausted?: CreditOnExhausted | null;
      rollover?: {
        mode: "none" | "carry";
        percent?: number;
        cap?: number | null;
        expire_after_cycles?: number | null;
      };
      /** G3b: when the credits renew; absent = each billing term. */
      reset?: Reset;
      first_window?: "full" | "prorated" | "next_full_window" | null;
    };

/** Default grant priority (design G3 § 3.2): lower draws first. */
export const DEFAULT_PRIORITY = 50;
