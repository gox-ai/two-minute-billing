// Credit units, grants and holds: shared shapes and pure helpers (client-safe, no API calls).
// Shapes follow design G3 § 7. The API wrappers live in `lib/api/credits.ts`.

import { currencyExponent } from "./money";
import type { Reset } from "./reset";
import { money } from "./format";
import type { PermissionKey } from "./permissions.generated";

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
  /** Minor units of `currency` per 1 unit, as a decimal string (≤ 12 dp). */
  minor_per_unit: string;
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
      }
    : { key, name: key, plural: key, decimals: 0, currency };
}

/** An amount in the unit's smallest step, for people: "1,250 credits" or "$12.50". */
export function fmtUnits(amount: number, info: UnitInfo): string {
  if (info.key == null) return money(amount, info.currency);
  const n = amount / 10 ** info.decimals;
  const text = n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: info.decimals,
  });
  return `${text} ${Math.abs(n) === 1 ? info.name : info.plural}`;
}

/**
 * A movement's Units and Value cells. Both go through `fmtUnits`/`money`, so a money
 * movement reads the same in both, minus sign included.
 */
export function movementCells(
  units: number,
  faceMinor: number,
  info: UnitInfo,
): { units: string; value: string } {
  return { units: fmtUnits(units, info), value: money(faceMinor, info.currency) };
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

/** Where the effective policy came from (access check `on_exhausted.source`), as a sentence. */
export const POLICY_SOURCE_LABEL: Record<string, string> = {
  business_blocking_off: "Blocking is off for the business.",
  customer_override: "The customer override sets this.",
  grant: "A credit grant sets this.",
  plan_price: "The plan price sets this.",
  business_default: "The business default sets this.",
};

/** `credit_config` with the API's defaults (design G3 § 5, 0464) filled in. */
export interface ResolvedCreditConfig {
  hold_default_seconds: number;
  in_flight_share_bps: number;
  blocking_enabled: boolean;
  on_exhausted_default: CreditOnExhausted;
  overdraft_limit_minor: Record<string, number>;
  top_up_limits: Record<string, { min_minor?: number | null; max_minor?: number | null }>;
  /** Free credit an operator gives (0495): refused above `max_minor`, alerted above the other. */
  grant_limits: Record<string, { max_minor?: number | null; alert_above_minor?: number | null }>;
  default_tax_treatment: CreditTaxTreatment | null;
  credit_scope: CreditScope | null;
}

export type CreditConfigInput = Partial<ResolvedCreditConfig> | null | undefined;

export function resolveCreditConfig(c: CreditConfigInput): ResolvedCreditConfig {
  return {
    hold_default_seconds: c?.hold_default_seconds ?? 60,
    in_flight_share_bps: c?.in_flight_share_bps ?? 5000,
    blocking_enabled: c?.blocking_enabled ?? false,
    on_exhausted_default: c?.on_exhausted_default ?? "bill",
    overdraft_limit_minor: c?.overdraft_limit_minor ?? {},
    top_up_limits: c?.top_up_limits ?? {},
    grant_limits: c?.grant_limits ?? {},
    default_tax_treatment: c?.default_tax_treatment ?? null,
    credit_scope: c?.credit_scope ?? null,
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
