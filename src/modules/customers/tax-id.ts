/**
 * Tax-ID (VAT number) validation (CUST-4 / plan §D4).
 *
 * A pluggable validator interface with a `noop` default. A real VIES / tax-authority
 * lookup slots in later without touching callers — the engine only records the
 * resulting status on the customer (`vat_number_status`). The live VIES adapter
 * (vies.ts) is selected by `TAX_ID_VALIDATOR=vies`, and by default on Cloud.
 */
import { config } from "@/platform/config";
import { isCloud } from "@/platform/edition";
import { viesTaxIdValidator } from "./vies";

export type VatNumberStatus = "not_validated" | "valid" | "invalid" | "undetermined";

export interface TaxIdValidator {
  /** Validate a VAT/tax-id for a country. `null` number → 'not_validated'. */
  validate(input: { country: string | null; vatNumber: string | null }): Promise<VatNumberStatus>;
}

/**
 * The default validator: performs no external lookup. A present number is
 * 'undetermined' (we can't confirm it without VIES); an absent one is
 * 'not_validated'. Deterministic and offline — safe for tests and local dev.
 */
export const noopTaxIdValidator: TaxIdValidator = {
  async validate({ vatNumber }) {
    return vatNumber && vatNumber.trim().length > 0 ? "undetermined" : "not_validated";
  },
};

// Explicit override (tests, or a bespoke adapter) always wins over config. When
// unset, the validator is resolved lazily from `TAX_ID_VALIDATOR` on first use —
// so both the API and worker processes pick up the live VIES backend without any
// boot-time wiring.
let override: TaxIdValidator | null = null;
let resolved: TaxIdValidator | null = null;

/** An explicit setting wins; unset, Cloud checks numbers in VIES and other editions do not. */
export function taxIdValidatorChoice(): "noop" | "vies" {
  return config.TAX_ID_VALIDATOR ?? (isCloud() ? "vies" : "noop");
}

export function getTaxIdValidator(): TaxIdValidator {
  if (override) return override;
  if (!resolved) {
    resolved = taxIdValidatorChoice() === "vies" ? viesTaxIdValidator : noopTaxIdValidator;
  }
  return resolved;
}

/** Swap the validator (e.g. in tests, or a bespoke adapter). Overrides config. */
export function setTaxIdValidator(v: TaxIdValidator): void {
  override = v;
  resolved = null;
}
