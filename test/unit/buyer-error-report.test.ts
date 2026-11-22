import { describe, expect, it } from "vitest";
// Relative: the root `@/` alias points at src/.
import {
  activeIntentNow,
  buildBuyerErrorReport,
  clearActiveIntent,
  redact,
  setActiveGateway,
  setActiveIntent,
  surfaceOf,
} from "../../dashboard/lib/buyer-error-report";
import { razorpayClientReason, stripeClientFailure } from "../../dashboard/lib/gateway-errors";
import { RETRY_IN_FORM } from "../../src/providers/payer-wording";

describe("buildBuyerErrorReport", () => {
  it("finds the gateway signal behind the text it built", () => {
    const shown = stripeClientFailure(
      "We could not confirm your payment.",
      {
        type: "card_error",
        code: "card_declined",
        decline_code: "do_not_honor",
        message: "Declined.",
      },
      RETRY_IN_FORM,
    );
    expect(buildBuyerErrorReport(shown, { step: "pay", page: "/checkout" })).toEqual({
      text: shown,
      step: "pay",
      page: "/checkout",
      gateway: "stripe",
      type: "card_error",
      code: "card_declined",
      decline_code: "do_not_honor",
      param: null,
      gateway_message: "Declined.",
      field_error: false,
      payment_intent: null,
    });
  });

  it("finds a noted reason inside a longer text, and marks a field error", () => {
    const reason = razorpayClientReason({ reason: "payment_failed", description: "Theirs" });
    const r = buildBuyerErrorReport(`We could not take your payment. ${reason} Try again.`);
    expect(r?.gateway).toBe("razorpay");
    expect(r?.decline_code).toBe("payment_failed");
    const field = stripeClientFailure(
      "We could not save your payment method.",
      { type: "validation_error", message: "Your card number is incomplete." },
      RETRY_IN_FORM,
    );
    expect(buildBuyerErrorReport(field)?.field_error).toBe(true);
  });

  it("falls back to the open gateway, and to nothing for an empty text", () => {
    setActiveGateway("adyen");
    expect(buildBuyerErrorReport("A text with no note.")?.gateway).toBe("adyen");
    setActiveGateway(null);
    expect(buildBuyerErrorReport("A text with no note.")?.gateway).toBeNull();
    expect(buildBuyerErrorReport("  ")).toBeNull();
  });

  it("names the intent the page is confirming, and only a pi_ id", () => {
    setActiveIntent("pi_XXXXXXXXXXXX01");
    expect(buildBuyerErrorReport("A text.")?.payment_intent).toBe("pi_XXXXXXXXXXXX01");
    setActiveIntent("cus_XXXXXXXXXXXX01");
    expect(buildBuyerErrorReport("A text.")?.payment_intent).toBeNull();
    setActiveIntent(null);
  });

  it("a finished flow clears its intent; a failure keeps it for the report", async () => {
    setActiveIntent("pi_XXXXXXXXXXXX01");
    clearActiveIntent("pi_XXXXXXXXXXXX02");
    expect(activeIntentNow()).toBe("pi_XXXXXXXXXXXX01");
    // A gateway form that fails keeps the intent: its refusal is reported next.
    // A computed path: the root typecheck cannot resolve the dashboard's `@/` imports in it.
    const sdkPath = "../../dashboard/lib/gateway-sdk";
    const { openGatewaySdk } = (await import(sdkPath)) as {
      openGatewaySdk: (
        sdk: { provider: string; params: Record<string, unknown> },
        context: { businessName: string; purpose: "setup" | "payment" },
      ) => Promise<{ status: string }>;
    };
    const failed = await openGatewaySdk(
      { provider: "no_such_gateway", params: {} },
      { businessName: "Juniper Ceramics", purpose: "setup" },
    );
    expect(failed.status).toBe("failed");
    expect(activeIntentNow()).toBe("pi_XXXXXXXXXXXX01");
    clearActiveIntent();
    expect(activeIntentNow()).toBeNull();
    expect(buildBuyerErrorReport("A later text.")?.payment_intent).toBeNull();
  });

  it("never sends a card number or an email address, and caps the text", () => {
    expect(redact("Card 4242 4242 4242 4242 for buyer@example.com")).toBe(
      "Card [number] for [email]",
    );
    expect(buildBuyerErrorReport("x".repeat(5000))?.text.length).toBe(1000);
  });
});

describe("surfaceOf", () => {
  it("names the storefront surface of a path", () => {
    expect(surfaceOf("/checkout")).toBe("checkout");
    expect(surfaceOf("/portal/invoices")).toBe("portal");
    expect(surfaceOf("/checkouts")).toBeNull();
    expect(surfaceOf("/businesses/biz_1")).toBeNull();
  });
});
