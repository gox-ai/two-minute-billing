import { mandateCurrencyIsAuthoritative } from "@/providers/gateway-catalog";
import type { ChargeResult } from "@/providers/types";

type Pm = {
  mandateCurrency?: string | null;
  providerKey?: string | null;
  type?: string | null;
};

/** The failure code of {@link mandateCurrencyRefusal}. */
export const MANDATE_CURRENCY_CODE = "mandate_currency_mismatch";

/**
 * A method whose mandate is held in a currency other than `currency`, on a gateway that debits
 * this method only in its stored mandate currency (`capabilities.mandateCurrencyAuthoritative`).
 * False when either currency is unknown, or the gateway does not vouch for the stored one.
 */
export function mandateCurrencyDiffers(pm: Pm, currency: string | null | undefined): boolean {
  return (
    !!currency &&
    !!pm.mandateCurrency &&
    pm.mandateCurrency.toUpperCase() !== currency.toUpperCase() &&
    mandateCurrencyIsAuthoritative(pm.providerKey, pm.type)
  );
}

/**
 * Refuse a debit in a currency other than the mandate's, before any gateway is asked.
 *
 * A mandate is registered in one currency. Sent in another, a gateway may refuse it or may
 * take the same NUMBER in the mandate's currency (₹50 taken for a $50 invoice), so this
 * never reaches the gateway. Not the instrument's fault, so not `invalid`; non-retriable,
 * because a retry in the same currency cannot succeed.
 */
export function mandateCurrencyRefusal(pm: Pm, currency: string): ChargeResult | null {
  if (!mandateCurrencyDiffers(pm, currency)) return null;
  const held = pm.mandateCurrency!.toUpperCase();
  return {
    status: "failed",
    providerChargeId: "",
    failure: {
      code: MANDATE_CURRENCY_CODE,
      // Buyer-facing, like the other mandate refusals in invoicing/collection.ts.
      message:
        `The customer authorized this payment method for payments in ${held} only. ` +
        `This charge is in ${currency.toUpperCase()}. ` +
        `Add a payment method for ${currency.toUpperCase()} payments.`,
      retriable: false,
    },
    raw: { mandate_currency: held, charge_currency: currency.toUpperCase() },
  };
}
