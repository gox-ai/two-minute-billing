/**
 * 0245 — read the gateway's AVS/CVC verdict off a Stripe payment method and never
 * blank a captured one on a quieter refresh.
 *
 * `describeStripePaymentMethod` (`src/providers/stripe.ts`) is the ONE parse site —
 * both `vaultPaymentMethod` and `consumeIntent`'s setup branch return its output
 * verbatim as `ProviderPaymentMethodRef.display`. `mergedAvsFields`
 * (`src/modules/payment-methods/service.ts`) is the one merge site used by
 * `persistVaultedPaymentMethod`'s refresh path.
 *
 * NULL means "the gateway told us nothing" and must stay distinguishable from a
 * real verdict — never coerced into a string like "unchecked".
 */
import { describe, it, expect } from "vitest";
import type Stripe from "stripe";
import { describeStripePaymentMethod } from "@/providers/stripe";
import { mergedAvsFields } from "@/modules/payment-methods/service";
import type { ProviderPaymentMethodRef } from "@/providers/types";

/** Minimal `card`-type PaymentMethod, `checks` shaped like the caller supplies. */
function cardPm(checks?: Partial<Stripe.PaymentMethod.Card.Checks> | null): Stripe.PaymentMethod {
  return {
    type: "card",
    card: {
      brand: "visa",
      last4: "4242",
      exp_month: 12,
      exp_year: 2030,
      checks: checks ?? null,
    },
  } as unknown as Stripe.PaymentMethod;
}

describe("0245 · describeStripePaymentMethod reads back the AVS/CVC verdict", () => {
  it("stays undefined (not coerced) when Stripe reports no checks at all", () => {
    const d = describeStripePaymentMethod(cardPm(null));
    expect(d.avsLine1Check).toBeUndefined();
    expect(d.avsPostalCheck).toBeUndefined();
    expect(d.cvcCheck).toBeUndefined();
    // No verdict arrived, so no capture time either — a stamped `avsCheckedAt`
    // here would assert "checked" for a payload that said nothing.
    expect(d.avsCheckedAt).toBeUndefined();
  });

  it("stays undefined when `checks` is present but every field is null (not attempted)", () => {
    const d = describeStripePaymentMethod(
      cardPm({
        address_line1_check: null,
        address_postal_code_check: null,
        cvc_check: null,
      }),
    );
    expect(d.avsLine1Check).toBeUndefined();
    expect(d.avsPostalCheck).toBeUndefined();
    expect(d.cvcCheck).toBeUndefined();
    expect(d.avsCheckedAt).toBeUndefined();
  });

  it("round-trips each verdict verbatim, lowercased", () => {
    const d = describeStripePaymentMethod(
      cardPm({
        address_line1_check: "pass",
        address_postal_code_check: "FAIL",
        cvc_check: "Unavailable",
      }),
    );
    expect(d.avsLine1Check).toBe("pass");
    expect(d.avsPostalCheck).toBe("fail");
    expect(d.cvcCheck).toBe("unavailable");
    expect(d.avsCheckedAt).toBeInstanceOf(Date);
  });

  it("carries a mixed pass/fail/unchecked result independently per field", () => {
    const d = describeStripePaymentMethod(
      cardPm({
        address_line1_check: "unchecked",
        address_postal_code_check: "pass",
        cvc_check: null,
      }),
    );
    expect(d.avsLine1Check).toBe("unchecked");
    expect(d.avsPostalCheck).toBe("pass");
    expect(d.cvcCheck).toBeUndefined();
    expect(d.avsCheckedAt).toBeInstanceOf(Date);
  });

  it("never touches AVS/CVC fields for a non-card instrument", () => {
    const d = describeStripePaymentMethod({
      type: "us_bank_account",
      us_bank_account: { bank_name: "Test Bank", last4: "6789" },
    } as unknown as Stripe.PaymentMethod);
    expect(d.avsLine1Check).toBeUndefined();
    expect(d.avsPostalCheck).toBeUndefined();
    expect(d.cvcCheck).toBeUndefined();
    expect(d.avsCheckedAt).toBeUndefined();
  });
});

describe("0245 · mergedAvsFields never blanks a captured verdict on a quieter refresh", () => {
  const existing = {
    avsLine1Check: "pass",
    avsPostalCheck: "pass",
    cvcCheck: "fail",
    avsCheckedAt: new Date("2026-08-01T00:00:00Z"),
  };

  function vaultedWith(
    display: Partial<ProviderPaymentMethodRef["display"]>,
  ): Pick<ProviderPaymentMethodRef, "display"> {
    return { display: { type: "card", ...display } };
  }

  it("keeps the existing verdict when the refresh's payload carried no `checks`", () => {
    const merged = mergedAvsFields(vaultedWith({}), existing);
    expect(merged).toEqual(existing);
  });

  it("takes the fresher verdict when the refresh actually reports one", () => {
    const checkedAt = new Date("2026-09-08T00:00:00Z");
    const merged = mergedAvsFields(
      vaultedWith({
        avsLine1Check: "fail",
        avsPostalCheck: "fail",
        cvcCheck: "pass",
        avsCheckedAt: checkedAt,
      }),
      existing,
    );
    expect(merged).toEqual({
      avsLine1Check: "fail",
      avsPostalCheck: "fail",
      cvcCheck: "pass",
      avsCheckedAt: checkedAt,
    });
  });

  it("merges field-by-field — a partial refresh doesn't blank the fields it didn't report", () => {
    const merged = mergedAvsFields(vaultedWith({ cvcCheck: "pass" }), existing);
    expect(merged).toEqual({
      avsLine1Check: "pass", // kept from existing
      avsPostalCheck: "pass", // kept from existing
      cvcCheck: "pass", // taken from the fresher readback
      avsCheckedAt: existing.avsCheckedAt, // no new capture time reported
    });
  });

  it("stays all-null when there was never a captured verdict to begin with", () => {
    const noneCaptured = {
      avsLine1Check: null,
      avsPostalCheck: null,
      cvcCheck: null,
      avsCheckedAt: null,
    };
    const merged = mergedAvsFields(vaultedWith({}), noneCaptured);
    expect(merged).toEqual(noneCaptured);
  });
});
