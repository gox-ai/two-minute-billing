import { describe, expect, it } from "vitest";
import { buyerTextLeaks, foreignSentences, sentencesOf } from "@/modules/ops/buyer-error-leak";
import {
  BUYER_GENERIC_REFUSAL,
  NOT_YET_APPROVED_TEXT,
  PAYER_LEAD,
  PAYMENT_ALREADY_IN_PROGRESS,
  RETRY_IN_FORM,
} from "@/providers/payer-wording";
import { PAYER_REASON_WITHHELD, PAYER_SAFE_INTERNAL_FAILURE } from "@/providers/decline-codes";
// Relative: the root `@/` alias points at src/.
import {
  acceptFailure,
  adyenNoResult,
  braintreeFailure,
  cashfreeFailure,
  microformFailure,
  razorpayClientReason,
  refusalMessage,
  squareTokenFailure,
  stripeClientFailure,
} from "../../dashboard/lib/gateway-errors";

/** The text a Stripe.js 3DS failure put on screen on 2026-11-17. */
const STRIPE_3DS_TEXT =
  "We are unable to authenticate your payment method. Please choose a different payment method and try again.";

describe("buyerTextLeaks", () => {
  it("the 2026-11-17 Stripe sentence is a leak, alone or after our lead", () => {
    expect(buyerTextLeaks(STRIPE_3DS_TEXT)).toBe(true);
    expect(buyerTextLeaks(`${PAYER_LEAD.confirm} ${STRIPE_3DS_TEXT} ${RETRY_IN_FORM}`)).toBe(true);
    expect(foreignSentences(`${PAYER_LEAD.confirm} ${STRIPE_3DS_TEXT}`)).toEqual(
      sentencesOf(STRIPE_3DS_TEXT),
    );
  });

  it("our replacement for that failure is clean", () => {
    const shown = stripeClientFailure(
      PAYER_LEAD.confirm,
      {
        type: "invalid_request_error",
        code: "payment_intent_authentication_failure",
        message: STRIPE_3DS_TEXT,
      },
      RETRY_IN_FORM,
    );
    expect(shown).not.toContain("unable to authenticate");
    expect(buyerTextLeaks(shown)).toBe(false);
  });

  it("every gateway helper's text is clean", () => {
    const texts = [
      stripeClientFailure(
        PAYER_LEAD.payment,
        { code: "card_declined", decline_code: "insufficient_funds" },
        RETRY_IN_FORM,
      ),
      stripeClientFailure(
        PAYER_LEAD.setup,
        { type: "api_error", message: "Something odd." },
        RETRY_IN_FORM,
      ),
      refusalMessage(
        PAYER_LEAD.payment,
        razorpayClientReason({ reason: "payment_failed" }),
        "Try again.",
      ),
      refusalMessage(PAYER_LEAD.payment, razorpayClientReason(null), "Try again."),
      braintreeFailure("setup", new Error("Some Drop-in text")),
      adyenNoResult("Refused", "payment"),
      adyenNoResult("Weird", "setup"),
      squareTokenFailure({
        status: "Error",
        errors: [{ type: "UNKNOWN", message: "Their words" }],
      })!,
      acceptFailure(
        { messages: { message: [{ code: "E_WC_21", text: "Their words" }] } },
        false,
        "Juniper Ceramics",
      ),
      cashfreeFailure("order", new Error("x")),
      cashfreeFailure("subscription", new Error("x")),
      refusalMessage(PAYER_LEAD.payment, PAYER_REASON_WITHHELD, "Select Pay $12.00 to try again."),
      refusalMessage(PAYER_LEAD.payment, PAYER_SAFE_INTERNAL_FAILURE, "Try again."),
      BUYER_GENERIC_REFUSAL,
    ];
    for (const t of texts) expect([t, buyerTextLeaks(t)]).toEqual([t, false]);
  });

  it("the checkout's second-completion and not-yet-approved texts are ours", () => {
    const inProgress = refusalMessage(
      "We could not complete your purchase.",
      PAYMENT_ALREADY_IN_PROGRESS,
      "Select Confirm payment to try again.",
    );
    // The engine's sentence already gives the next step: never a second one.
    expect(inProgress).toBe(`We could not complete your purchase. ${PAYMENT_ALREADY_IN_PROGRESS}`);
    const texts = [
      inProgress,
      `We could not complete your purchase yet. ${NOT_YET_APPROVED_TEXT.reason} ${NOT_YET_APPROVED_TEXT.retryDialog}`,
      `We could not confirm your payment yet. ${NOT_YET_APPROVED_TEXT.reason} ${NOT_YET_APPROVED_TEXT.retryReturn}`,
    ];
    for (const t of texts) expect([t, buyerTextLeaks(t)]).toEqual([t, false]);
  });

  it("a gateway's field instruction is a field error, not a leak", () => {
    const stripe = stripeClientFailure(
      PAYER_LEAD.setup,
      { type: "validation_error", message: "Your card number is incomplete." },
      RETRY_IN_FORM,
    );
    expect(buyerTextLeaks(stripe)).toBe(true);
    expect(buyerTextLeaks(stripe, { fieldError: true })).toBe(false);
    const microform = microformFailure({
      details: [{ location: "number", message: "Their own field text" }],
    });
    expect(buyerTextLeaks(microform, { fieldError: true })).toBe(false);
  });

  it("an unknown sentence anywhere is a leak", () => {
    expect(buyerTextLeaks(`${PAYER_LEAD.payment} Your card was declined.`)).toBe(true);
    expect(buyerTextLeaks("An unknown error occurred.")).toBe(true);
  });
});
