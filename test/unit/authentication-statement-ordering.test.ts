import { describe, expect, it } from "vitest";
import {
  AWAITING_AUTHENTICATION_CODE,
  AUTHENTICATION_NOT_REQUIRED_CODE,
  authenticationWaitMayBeRecorded,
  debitAwaitsBuyerAuthentication,
} from "@/modules/payment-methods/mandate-afa";

/**
 * A GATEWAY'S "NOT NOW" DOES NOT BIND ITS LATER "YES, NOW".
 *
 * Production 2026-09-12, INV-100006: Stripe answered the
 * charge `card_await_notification.customer_approval_required: false` — true at that moment
 * — so the row was booked `authentication_not_required`. Stripe then required 3D Secure,
 * the cardholder began it and stopped, and nothing could correct the row: the negative
 * outranks the rail+amount prediction, and `applyActionRequired` wrote no code at all. The
 * portal offered no Pay-now CTA, `awaiting_authentication` stayed false, and the invoice
 * sat on "waiting for the current attempt to settle".
 */
const CARD_INR = { mandateRail: "card", type: "card" };

describe("a later authentication statement outranks an earlier one", () => {
  it("lets the gateway's YES overwrite its own earlier NO", () => {
    expect(authenticationWaitMayBeRecorded(AUTHENTICATION_NOT_REQUIRED_CODE)).toBe(true);
  });

  it("records the wait on a row that never carried a statement", () => {
    // RazorPay books a plain pending with no statement at all; the sweep's probe may be
    // what discovers the wait, and this handler must be able to record it too.
    expect(authenticationWaitMayBeRecorded(null)).toBe(true);
    expect(authenticationWaitMayBeRecorded(undefined)).toBe(true);
  });

  it("refuses to overwrite a real decline code", () => {
    // Those are terminal verdicts about the attempt, not statements about who is waiting.
    // An out-of-order `requires_action` delivery must not bury one.
    for (const code of [
      "insufficient_funds",
      "mandate_expired",
      "afa_not_completed",
      "card_declined",
      AWAITING_AUTHENTICATION_CODE,
    ])
      expect(authenticationWaitMayBeRecorded(code), code).toBe(false);
  });

  it("and the corrected row is what flips the buyer-facing answer back", () => {
    // The whole point of the overwrite: this predicate drives the portal CTA,
    // `awaiting_authentication`, and the sweep's grace clamp.
    const SMALL = 10_000n; // ₹100 — below the AFA-free ceiling, so the prediction is quiet
    expect(
      debitAwaitsBuyerAuthentication(
        { errorCode: AUTHENTICATION_NOT_REQUIRED_CODE },
        CARD_INR,
        "INR",
        SMALL,
      ),
    ).toBe(false);
    expect(
      debitAwaitsBuyerAuthentication(
        { errorCode: AWAITING_AUTHENTICATION_CODE },
        CARD_INR,
        "INR",
        SMALL,
      ),
    ).toBe(true);
  });
});
