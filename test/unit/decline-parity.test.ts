import { describe, it, expect } from "vitest";
import {
  normalizeRazorpayDecline,
  normalizePaypalDecline,
  normalizeStripeDecline,
} from "@/providers/decline-codes";

/**
 * EVERY GATEWAY MUST AGREE ON WHAT IS TERMINAL.
 *
 * Stripe normalized its declines in a five-case switch inside `providers/stripe.ts` that
 * never consulted `TERMINAL`, so the same decline got two answers depending on which
 * gateway reported it. Measured 2026-09-04: `stolen_card`, `lost_card`, `fraudulent`,
 * `pickup_card` and `revocation_of_authorization` were `retriable: true` on Stripe and
 * `false` on RazorPay — a card reported STOLEN was retried through the dunning ladder on
 * one gateway and treated as a hard decline on the other.
 *
 * This test IS the link, the same role `mandate.test.ts` plays for the rail caps: a
 * provider that grows its own normalizer, or a terminal code added to one table and not
 * the shared set, fails here rather than in production dunning.
 */
const NORMALIZERS = {
  razorpay: normalizeRazorpayDecline,
  paypal: normalizePaypalDecline,
  stripe: normalizeStripeDecline,
} as const;

/** The shared terminal vocabulary, spelled the same way by all three gateways. */
const TERMINAL_CODES = [
  "stolen_card",
  "lost_card",
  "fraudulent",
  "pickup_card",
  "revocation_of_authorization",
  // Added to TERMINAL 2026-09-04, resolving the Stripe/RazorPay split — see the note there.
  "expired_card",
] as const;

describe("decline normalization parity across gateways", () => {
  for (const code of TERMINAL_CODES) {
    it(`treats ${code} as terminal on every gateway`, () => {
      for (const [gateway, fn] of Object.entries(NORMALIZERS)) {
        const n = fn(code);
        expect(n.code, `${gateway}: token`).toBe(code);
        expect(n.retriable, `${gateway}: ${code} must NOT be retriable`).toBe(false);
      }
    });
  }

  it("agrees on retriability for every terminal code, gateway to gateway", () => {
    for (const code of TERMINAL_CODES) {
      const answers = Object.values(NORMALIZERS).map((fn) => fn(code).retriable);
      expect(new Set(answers).size, `${code} answered differently by gateway`).toBe(1);
    }
  });

  it("gives an unknown code the same liberal default everywhere", () => {
    for (const [gateway, fn] of Object.entries(NORMALIZERS)) {
      const n = fn("some_code_no_gateway_has_ever_sent");
      expect(n.retriable, `${gateway}: unknown must stay retriable`).toBe(true);
      expect(n.code, `${gateway}: unknown keeps its raw name`).toBe(
        "some_code_no_gateway_has_ever_sent",
      );
    }
  });

  /**
   * The mandate + authentication families, mapped 2026-09-05 from Stripe's DOCUMENTED
   * error-code union (stripe 22.2.2). These arrive as top-level `code`, not
   * `decline_code`, which is why `stripeDeclineReason` falls back to `code`.
   *
   * The point of asserting them is the REMEDY, not the string: a mandate that cannot be
   * used needs a new authorisation, and telling the payer to retry the card instead is a
   * dead end. `mandate_expired` is the token the policy parks with that remedy.
   */
  it("maps Stripe's mandate failures onto the token whose remedy is a NEW mandate", () => {
    for (const code of [
      "india_recurring_payment_mandate_canceled",
      "payment_intent_mandate_invalid",
      "setup_intent_mandate_invalid",
      "billing_invalid_mandate",
    ]) {
      expect(normalizeStripeDecline(code).code, code).toBe("mandate_expired");
    }
  });

  it("maps Stripe's authentication failures to the token whose remedy is the BUYER", () => {
    // This is where an India AFA refusal actually lands. Stripe has no per-cycle
    // equivalent of RazorPay's `card_mandate_current_cycle_allowed_debit_exceeds`, so
    // mapping to a cycle-limit token would tell the payer to wait out a cycle Stripe
    // never mentions.
    for (const code of [
      "authentication_required",
      "payment_intent_authentication_failure",
      "setup_intent_authentication_failure",
    ]) {
      expect(normalizeStripeDecline(code).code, code).toBe("authentication_required");
    }
  });

  it("gives a missing code the same fallback everywhere", () => {
    for (const [gateway, fn] of Object.entries(NORMALIZERS)) {
      for (const raw of [undefined, null, ""]) {
        const n = fn(raw);
        expect(n.code, `${gateway}: ${String(raw)} → charge_failed`).toBe("charge_failed");
        expect(n.retriable).toBe(true);
      }
    }
  });

  /**
   * `expired_card` — the divergence that USED to live here.
   *
   * This slot held a test pinning Stripe's non-retriable `expired_card` against RazorPay's
   * retriable one, with a note saying that whoever added it to the shared `TERMINAL` set
   * should DELETE that test rather than adjust it. That happened, so it is gone and this
   * asserts the resolved behaviour instead: an expired card is a bad instrument on EVERY
   * gateway, which marks the method invalid and moves collection to the backup rather than
   * burning a dunning schedule on a card that cannot succeed on any attempt.
   */
  it("treats expired_card as terminal on every gateway", () => {
    for (const [gateway, fn] of Object.entries(NORMALIZERS)) {
      const n = fn("expired_card");
      expect(n.code, `${gateway}: token`).toBe("expired_card");
      expect(n.retriable, `${gateway}: an expired card cannot be retried`).toBe(false);
    }
  });
});
