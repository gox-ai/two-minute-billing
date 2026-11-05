import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { chargeResultFromPaymentIntent } from "@/providers/stripe";
import {
  AWAITING_AUTHENTICATION_CODE,
  AUTHENTICATION_NOT_REQUIRED_CODE,
  debitAwaitsBuyerAuthentication,
  debitNeedsBuyerAuthentication,
} from "@/modules/payment-methods/mandate-afa";

/**
 * `requires_action` IS NOT "THE BUYER MUST ACT".
 *
 * Measured 2026-09-10 by `verify:stripe-india-afa-live`, end to end against a real
 * sandbox mandate: a ₹100 India e-mandate debit came back `requires_action` carrying
 * `next_action.card_await_notification = { charge_attempt_at, customer_approval_required:
 * false }` — Stripe serving the RBI pre-debit notification and saying outright that
 * nobody has to authenticate it. Five minutes later it SUCCEEDED, untouched.
 *
 * The engine read only the status, stamped `AWAITING_AUTHENTICATION_CODE`, and the portal
 * offered that buyer a Pay-now approval CTA for the whole window — on a payment that
 * needed nothing and then collected itself. Taking that CTA would have charged them a
 * second time while the mandate debit was still in flight.
 */
const pi = (next: Stripe.PaymentIntent.NextAction | null) =>
  ({ id: "pi_x", status: "requires_action", next_action: next }) as Stripe.PaymentIntent;

const CARD_INR = { mandateRail: "card", type: "card" };

describe("the India pre-debit notification is not an authentication request", () => {
  it("carries Stripe's statement through the adapter instead of flattening it", () => {
    const r = chargeResultFromPaymentIntent(
      pi({
        type: "card_await_notification",
        card_await_notification: {
          charge_attempt_at: 1789025035,
          customer_approval_required: false,
        },
      } as unknown as Stripe.PaymentIntent.NextAction),
    );
    expect(r.status).toBe("requires_action");
    expect(r.nextAction?.type).toBe("card_await_notification");
    expect(r.nextAction?.data).toEqual({ approvalRequired: false, chargeAttemptAt: 1789025035 });
  });

  it("passes the positive statement through just as literally", () => {
    const r = chargeResultFromPaymentIntent(
      pi({
        type: "card_await_notification",
        card_await_notification: { charge_attempt_at: 1, customer_approval_required: true },
      } as unknown as Stripe.PaymentIntent.NextAction),
    );
    expect(r.nextAction?.data.approvalRequired).toBe(true);
  });

  it("says NOTHING when Stripe said nothing — absent is not false", () => {
    // A 3DS redirect carries no such flag, and inventing `false` there would silence a
    // challenge that really does need the buyer.
    const r = chargeResultFromPaymentIntent(
      pi({ type: "redirect_to_url", redirect_to_url: { url: "https://x", return_url: null } }),
    );
    expect(r.nextAction?.data).toEqual({});
  });

  it("lets the negative statement BEAT the prediction, above the AFA-free ceiling", () => {
    // The prediction is amount-aware, so it only says "yes" on its own ABOVE ₹15,000.
    // That is precisely where a written negative is load-bearing: leaving the row silent
    // would let the guess re-assert what Stripe just denied.
    const BIG = 2_000_000n; // ₹20,000
    expect(debitNeedsBuyerAuthentication(CARD_INR, "INR", BIG)).toBe(true);
    expect(
      debitAwaitsBuyerAuthentication(
        { errorCode: AUTHENTICATION_NOT_REQUIRED_CODE },
        CARD_INR,
        "INR",
        BIG,
      ),
    ).toBe(false);
    expect(debitAwaitsBuyerAuthentication({ errorCode: null }, CARD_INR, "INR", BIG)).toBe(true);
  });

  it("and BELOW the ceiling it is the stamped code that has to stop — the prediction is already quiet", () => {
    // INV-100001's shape, and the one measured on 2026-09-10: ₹100. The guess says no,
    // so the only thing that ever lit the CTA was `bookPending` stamping the positive
    // code off the bare `requires_action` status. Writing the negative instead is what
    // fixes this amount.
    const SMALL = 10_000n; // ₹100
    expect(debitNeedsBuyerAuthentication(CARD_INR, "INR", SMALL)).toBe(false);
    expect(
      debitAwaitsBuyerAuthentication(
        { errorCode: AWAITING_AUTHENTICATION_CODE },
        CARD_INR,
        "INR",
        SMALL,
      ),
    ).toBe(true);
    expect(
      debitAwaitsBuyerAuthentication(
        { errorCode: AUTHENTICATION_NOT_REQUIRED_CODE },
        CARD_INR,
        "INR",
        SMALL,
      ),
    ).toBe(false);
  });

  it("still believes the positive statement whatever the amount", () => {
    for (const amt of [10_000n, 2_000_000n])
      expect(
        debitAwaitsBuyerAuthentication(
          { errorCode: AWAITING_AUTHENTICATION_CODE },
          CARD_INR,
          "INR",
          amt,
        ),
      ).toBe(true);
  });
});
