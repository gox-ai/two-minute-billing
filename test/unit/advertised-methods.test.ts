import { describe, it, expect } from "vitest";
import { ADVERTISED_METHODS } from "@/providers/registry";
import { StripeProvider } from "@/providers/stripe";
import { RazorpayProvider } from "@/providers/razorpay";
import { PayPalProvider } from "@/providers/paypal";
import { effectiveMethodTypes } from "@/modules/gateway/service";
import { GATEWAYS, gatewayAllowsPurpose } from "@/providers/gateway-catalog";
import { allowsIntentPurpose } from "@/providers/types";

/**
 * `ADVERTISED_METHODS` duplicates each adapter's `capabilities.methods` so a gateway
 * listing can answer "which rails may I offer?" without constructing a provider (which
 * decrypts credentials). The duplicate is only safe while something fails when it drifts.
 *
 * Constructed with dummy credentials on purpose: `capabilities` is a plain literal field,
 * so nothing here talks to a gateway.
 */
describe("ADVERTISED_METHODS matches what each adapter actually advertises", () => {
  it("stripe", () => {
    const a = new StripeProvider("sk_test_x", "whsec_x", "pk_test_x");
    expect([...ADVERTISED_METHODS.stripe!]).toEqual(a.capabilities.methods);
  });
  it("razorpay", () => {
    const a = new RazorpayProvider({
      keyId: "key_x",
      keySecret: "secret_x",
      apiBase: "https://api.razorpay.com",
    });
    expect([...ADVERTISED_METHODS.razorpay!]).toEqual(a.capabilities.methods);
  });
  it("paypal", () => {
    const a = new PayPalProvider({
      clientId: "id_x",
      clientSecret: "secret_x",
      apiBase: "https://api-m.sandbox.paypal.com",
    });
    expect([...ADVERTISED_METHODS.paypal!]).toEqual(a.capabilities.methods);
  });
});

describe("effectiveMethodTypes", () => {
  const stripe = { gatewayKey: "stripe", methodTypes: null };

  it("falls back to what the gateway can do, never to the Indian set", () => {
    // The bug this replaces: both storefronts guessed ['card','upi','bank_transfer'] when
    // the operator had configured nothing, so a Stripe buyer could be offered UPI.
    expect(effectiveMethodTypes(stripe, "USD")).not.toContain("upi");
  });

  it("offers ACH only in USD and SEPA only in EUR", () => {
    expect(effectiveMethodTypes(stripe, "USD")).toContain("us_bank_account");
    expect(effectiveMethodTypes(stripe, "USD")).not.toContain("sepa_debit");
    expect(effectiveMethodTypes(stripe, "EUR")).toContain("sepa_debit");
    expect(effectiveMethodTypes(stripe, "EUR")).not.toContain("us_bank_account");
  });

  it("leaves an INR Stripe account with card alone — no dead bank row", () => {
    // `bank_transfer` folds onto ACH on Stripe, so it is USD-bound there too. Without
    // that line an INR account renders "Bank account · Netbanking e-Mandate", which is
    // RazorPay's rail and would fail at Stripe.
    expect(effectiveMethodTypes(stripe, "INR")).toEqual(["card"]);
  });

  it("does not touch RazorPay's netbanking, where bank_transfer is a different rail", () => {
    const rzp = { gatewayKey: "razorpay", methodTypes: null };
    expect(effectiveMethodTypes(rzp, "INR")).toEqual(["card", "upi", "wallet", "bank_transfer"]);
  });

  it("offers PayPal its wallet only — it cannot vault a card", () => {
    // A `card` rail here rendered "Credit or debit card" and then saved a PayPal wallet.
    expect(effectiveMethodTypes({ gatewayKey: "paypal", methodTypes: null }, "USD")).toEqual([
      "paypal",
    ]);
  });

  it("an operator's explicit list wins over the adapter's", () => {
    expect(effectiveMethodTypes({ gatewayKey: "stripe", methodTypes: ["card"] }, "USD")).toEqual([
      "card",
    ]);
  });

  it("filters nothing when the currency is unknown", () => {
    // A wrong exclusion hides a rail the buyer can really use; the gateway refusing one
    // it cannot is the cheaper failure.
    expect(effectiveMethodTypes(stripe).length).toBe(4);
  });
});

describe("effectiveMethodTypes for a setup", () => {
  const rzp = { gatewayKey: "razorpay", methodTypes: null };

  it("leaves out a RazorPay wallet, which has no recurring rail", () => {
    expect(effectiveMethodTypes(rzp, "INR", "setup")).toEqual(["card", "upi", "bank_transfer"]);
    expect(effectiveMethodTypes(rzp, "INR", "payment")).toContain("wallet");
  });

  it("leaves out a wallet the operator enabled too", () => {
    const pinned = { gatewayKey: "razorpay", methodTypes: ["wallet", "card"] };
    expect(effectiveMethodTypes(pinned, "INR", "setup")).toEqual(["card"]);
  });

  it("offers only savable rails on Square and Mollie", () => {
    expect(
      effectiveMethodTypes({ gatewayKey: "square", methodTypes: null }, "USD", "setup"),
    ).toEqual(["card"]);
    expect(
      effectiveMethodTypes({ gatewayKey: "mollie", methodTypes: null }, "EUR", "setup"),
    ).toEqual(["card", "sepa_debit", "paypal"]);
  });

  it("every pay-now-only method is one the gateway advertises", () => {
    for (const g of Object.values(GATEWAYS))
      for (const m of g.payNowOnlyMethods ?? []) expect(g.advertisedMethods).toContain(m);
  });
});

describe("intent purposes: one reading", () => {
  it("absent or empty means both", () => {
    expect(allowsIntentPurpose(undefined, "setup")).toBe(true);
    expect(allowsIntentPurpose([], "payment")).toBe(true);
    expect(allowsIntentPurpose(["setup"], "payment")).toBe(false);
  });

  it("GoCardless saves a method but takes no payment now", () => {
    expect(gatewayAllowsPurpose("gocardless", "setup")).toBe(true);
    expect(gatewayAllowsPurpose("gocardless", "payment")).toBe(false);
    expect(gatewayAllowsPurpose("stripe", "payment")).toBe(true);
  });

  it("an unknown key is not filtered", () => {
    expect(gatewayAllowsPurpose("offline", "payment")).toBe(true);
  });
});

describe("Authorize.net eCheck is saved, then charged", () => {
  const anet = { gatewayKey: "authorizenet", methodTypes: null };

  it("offers a bank account to save, in USD only", () => {
    expect(effectiveMethodTypes(anet, "USD", "setup")).toEqual(["card", "us_bank_account"]);
    expect(effectiveMethodTypes(anet, "EUR", "setup")).toEqual(["card"]);
  });

  it("never offers a bank account for a payment now", () => {
    expect(effectiveMethodTypes(anet, "USD", "payment")).toEqual(["card"]);
  });

  it("takes the ACH authorization itself; Stripe, Square and GoCardless show their own", () => {
    expect(GATEWAYS.authorizenet.achAuthorization).toBe("ours");
    for (const k of ["stripe", "square", "gocardless"] as const)
      expect(GATEWAYS[k].achAuthorization).toBe("gateway");
  });
});
