/**
 * Invoice rules (0486), stored in `businesses.invoice_rules_config`:
 *
 *   { small_invoice_action?, small_invoice_thresholds?: { CUR: minor }, charge_timing? }
 *
 * Pure resolver: null, absent or out-of-range values resolve to what the engine did before the
 * column, so an untouched business is unchanged. Both rules apply to an auto-collected renewal
 * invoice (subscriptions/renewal-collection.ts).
 */

/** "Roll into the next invoice" is not offered: the ledger has no carried-debit balance. */
export const SMALL_INVOICE_ACTIONS = ["charge", "write_off"] as const;
export type SmallInvoiceAction = (typeof SMALL_INVOICE_ACTIONS)[number];

/** "Customer chooses" is not offered: the customer portal has no control for it yet. */
export const CHARGE_TIMINGS = ["at_creation", "on_due_date"] as const;
export type ChargeTiming = (typeof CHARGE_TIMINGS)[number];

export interface InvoiceRulesConfig {
  /** Default `charge`: every amount due is charged. */
  smallInvoiceAction: SmallInvoiceAction;
  /** For `write_off`: per currency, the amount due (minor units) below which we write off. */
  smallInvoiceThresholds: Record<string, number>;
  /** Default `at_creation`: an auto-collected invoice is charged when it is created. */
  chargeTiming: ChargeTiming;
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

function obj(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** `{ CUR: positive integer }`; anything else is dropped. Codes are upper-cased. */
function amounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(raw) ?? {})) {
    if (/^[A-Za-z]{3}$/.test(k) && typeof v === "number" && Number.isSafeInteger(v) && v > 0)
      out[k.toUpperCase()] = v;
  }
  return out;
}

/** Takes the business ROW (Drizzle's camelCase), like the other resolvers. */
export function resolveInvoiceRulesConfig(
  biz: { invoiceRulesConfig?: unknown } | null | undefined,
): InvoiceRulesConfig {
  const cfg = obj(biz?.invoiceRulesConfig);
  return {
    smallInvoiceAction: pick(cfg?.small_invoice_action, SMALL_INVOICE_ACTIONS, "charge"),
    smallInvoiceThresholds: amounts(cfg?.small_invoice_thresholds),
    chargeTiming: pick(cfg?.charge_timing, CHARGE_TIMINGS, "at_creation"),
  };
}

/** The resolved config in the API's snake_case. */
export function serializeInvoiceRulesConfig(c: InvoiceRulesConfig) {
  return {
    small_invoice_action: c.smallInvoiceAction,
    small_invoice_thresholds: { ...c.smallInvoiceThresholds },
    charge_timing: c.chargeTiming,
  };
}

/** A PATCH body's keys over the stored blob. A threshold map replaces the stored one. */
export function mergeInvoiceRulesConfig(
  stored: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(obj(stored) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] =
      k === "small_invoice_thresholds" && obj(v)
        ? Object.fromEntries(Object.entries(obj(v)!).map(([c, n]) => [c.toUpperCase(), n]))
        : v;
  }
  return out;
}

/** The write-off limit for a currency, or null when small invoices are charged. */
export function smallInvoiceLimit(cfg: InvoiceRulesConfig, currency: string): number | null {
  return cfg.smallInvoiceAction === "write_off"
    ? (cfg.smallInvoiceThresholds[currency.toUpperCase()] ?? null)
    : null;
}

/**
 * What a renewal's collection step does with a committed, auto-collected invoice:
 *  - `write_off`: 0 < amount due < the currency's small-invoice limit;
 *  - `wait_for_due_date`: `on_due_date` and a due date after now (net terms);
 *  - `charge`: everything else (today).
 */
export function collectionDecision(
  cfg: InvoiceRulesConfig,
  inv: { status: string; amountDueMinor: bigint | null; currency: string; dueDate: Date | null },
  now: Date,
): "charge" | "write_off" | "wait_for_due_date" {
  const due = inv.amountDueMinor ?? 0n;
  if (inv.status === "paid" || due <= 0n) return "charge";
  const limit = smallInvoiceLimit(cfg, inv.currency);
  if (limit != null && due < BigInt(limit)) return "write_off";
  if (cfg.chargeTiming === "on_due_date" && inv.dueDate && inv.dueDate.getTime() > now.getTime())
    return "wait_for_due_date";
  return "charge";
}

/** True when either collection rule can change what a renewal charges. */
export function collectionRulesActive(cfg: InvoiceRulesConfig, currency: string): boolean {
  return cfg.chargeTiming === "on_due_date" || smallInvoiceLimit(cfg, currency) != null;
}
