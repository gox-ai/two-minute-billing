import { describe, it, expect } from "vitest";
import {
  debitNeedsBuyerAuthentication,
  debitAwaitsBuyerAuthentication,
  AWAITING_AUTHENTICATION_CODE,
} from "@/modules/payment-methods/mandate-afa";
import { classifyDecline } from "@/modules/subscriptions/decline-policy";
import { AFA_REVIVABLE_CODES } from "@/modules/webhooks/inbound";

/**
 * AN OFF-SESSION INDIA AFA DEBIT IS PENDING, NOT FAILED.
 *
 * ── WHAT THIS COST, MEASURED 2026-09-05 ──────────────────────────────────────────────
 * ₹17,736.11 on one payment. An off-session India card debit above the
 * AFA-free ceiling answered `requires_action`; `collectClaimedInvoice` booked a terminal
 * FAILURE. The buyer then completed 3D Secure, Stripe captured the money and announced it
 * TWICE — and both `charge.succeeded` deliveries were dropped, because the settlement path
 * refuses a terminal transaction. The engine held no payment row, a failed transaction and
 * an invoice still `payment_due` for the full amount: money taken with nothing to reconcile
 * from, and invisible to `unapplied_gateway_money` too, since that counts payments the
 * settlement path tagged and none was ever created.
 *
 * RazorPay never had this shape because its AFA debit arrives as `pending` and reaches
 * `bookPending`. Stripe's arrives as `requires_action`, which skipped the entire lifecycle
 * the engine already had: notify (`payment_authentication_required`), settle on completion,
 * age out at 72h (`afa_not_completed`), revive on a late success.
 */
describe("an off-session AFA debit must stay collectable", () => {
  const card = { mandateRail: "card", type: null };

  it("predicts AFA for the exact debit that was lost", () => {
    // ₹17,736.11 — above the ₹15,000 AFA-free ceiling, so the cardholder MUST authenticate.
    expect(debitNeedsBuyerAuthentication(card, "INR", 1_773_611n)).toBe(true);
  });

  it("does NOT predict it below the ceiling — the prediction itself is unchanged", () => {
    // Still the right answer to "will this debit be challenged?" asked in ADVANCE.
    // It is no longer the answer to "was it?" — see the block below.
    expect(debitNeedsBuyerAuthentication(card, "INR", 1_000_000n)).toBe(false);
  });

  it("does not predict it outside INR — the rule is RBI's, not ours", () => {
    expect(debitNeedsBuyerAuthentication(card, "USD", 1_773_611n)).toBe(false);
  });

  it("lets a late success overturn BOTH waiting-on-a-person failures", () => {
    // `afa_not_completed` is the 72-hour sweep's code; `requires_action` is the same event
    // one step earlier and was unrevivable, which is what dropped the ₹17,736.11.
    expect(AFA_REVIVABLE_CODES.has("afa_not_completed")).toBe(true);
    expect(AFA_REVIVABLE_CODES.has("requires_action")).toBe(true);
  });

  it("…and NOT a hard decline, which reporting success is a contradiction not a settlement", () => {
    for (const code of [
      "stolen_card",
      "expired_card",
      "card_declined",
      "mandate_ceiling_exceeded",
    ]) {
      expect(AFA_REVIVABLE_CODES.has(code), code).toBe(false);
    }
  });
});

/**
 * ₹15,000 IS WHERE AFA IS COMPULSORY, NOT WHERE IT BECOMES POSSIBLE.
 *
 * Measured in production 2026-09-09 — INV-100001, ₹885.00:
 * the issuer answered `requires_action` on a mandate that was `rail=card`,
 * `status=confirmed`, ceiling ₹15,000. Nothing was wrong with the authorisation; the debit
 * was 1/17th of its own ceiling. The card had been registered at the AFA-free ceiling by
 * `withMandateHeadroom` precisely so it would renew unattended, and it was challenged
 * anyway.
 *
 * The old code let the amount+rail PREDICTION veto that STATEMENT, and the damage
 * compounded: a terminal failure silenced `applyActionRequired` (it refuses a non-open
 * attempt), so the buyer was never told to authenticate; `retriable ?? true` plus a
 * `requires_action` that matched nothing in the taxonomy armed a dunning ladder where every
 * rung re-asks a question only the buyer can answer.
 */
describe("an issuer may demand authentication at any amount", () => {
  const card = { mandateRail: "card", type: null };
  const stated = { errorCode: AWAITING_AUTHENTICATION_CODE };
  /** ₹885.00 — the production debit, 17× below the AFA-free ceiling. */
  const INV_100001_MINOR = 88_500n;

  it("honours the gateway's statement below the ceiling, where the prediction says no", () => {
    expect(debitNeedsBuyerAuthentication(card, "INR", INV_100001_MINOR)).toBe(false);
    expect(debitAwaitsBuyerAuthentication(stated, card, "INR", INV_100001_MINOR)).toBe(true);
  });

  it("honours it outside INR too — an SCA challenge is not an RBI rule", () => {
    expect(debitAwaitsBuyerAuthentication(stated, card, "EUR", 500n)).toBe(true);
  });

  it("honours it on a rail the AFA prediction excludes", () => {
    // Netbanking authenticates once at registration, so the prediction rightly never
    // fires for it — but if the gateway says this particular debit stopped, it stopped.
    const emandate = { mandateRail: "emandate", type: null };
    expect(debitNeedsBuyerAuthentication(emandate, "INR", 9_999_999n)).toBe(false);
    expect(debitAwaitsBuyerAuthentication(stated, emandate, "INR", 9_999_999n)).toBe(true);
  });

  it("still falls back to the prediction when the gateway stated nothing", () => {
    // RazorPay parks an AFA debit as a plain `pending` with no statement to record.
    // Losing that fallback would have silently un-fixed the ₹17,736.11 case above.
    expect(debitAwaitsBuyerAuthentication({ errorCode: null }, card, "INR", 1_773_611n)).toBe(true);
    expect(debitAwaitsBuyerAuthentication({ errorCode: null }, card, "INR", 1_000_000n)).toBe(
      false,
    );
  });

  it("does not mistake an ordinary decline for a challenge", () => {
    for (const code of ["card_declined", "insufficient_funds", "expired_card", "requires_action"])
      expect(debitAwaitsBuyerAuthentication({ errorCode: code }, card, "INR", 1_000n), code).toBe(
        false,
      );
  });

  it("classifies the challenge as PARK, so no ladder of unanswerable retries is armed", () => {
    // The old failure path stored the raw gateway STATUS, which matched nothing in the
    // taxonomy and fell to `classifyDecline`'s liberal default. That is what armed the
    // 10-Sept retry on INV-100001.
    expect(classifyDecline("requires_action")).toBe("retry");
    expect(classifyDecline(AWAITING_AUTHENTICATION_CODE)).toBe("park");
  });
});
