/**
 * A refused or cancelled try on a hosted Square link reaches the open intent with its
 * reason, a cancelled hold is not a gateway fault, and a refused token is our setup.
 */
import { describe, it, expect } from "vitest";
import {
  chargeResultFromPayment,
  normalizeSquareNotification,
  squareAccessFailure,
  SQUARE_HOSTED_PREFIX,
  type SquareNotification,
  type SquarePayment,
} from "@/providers/square";

const payment = (over: Partial<SquarePayment> = {}): SquarePayment => ({
  id: "PXXXXXXXXXXXXXXXXXXXXXXX01",
  status: "FAILED",
  location_id: "LXXXXXXXXXXX1",
  order_id: "OXXXXXXXXXXXXXXXXXXXXXXX01",
  amount_money: { amount: 5000, currency: "USD" },
  ...over,
});

const note = (p: SquarePayment) =>
  ({
    type: "payment.updated",
    created_at: "2026-10-28T10:00:00Z",
    data: { type: "payment", id: p.id, object: { payment: p } },
  }) as SquareNotification;

const HOSTED = { hostedRef: "pi_XXXXXXXXXXXXXXXXXXXXXXXX" };

describe("square hosted link: a try that did not pay", () => {
  it("FAILED → charge.failed on the link's intent id with the decline", () => {
    const p = payment({
      card_details: {
        errors: [{ code: "INSUFFICIENT_FUNDS", category: "PAYMENT_METHOD_ERROR" }],
      },
    });
    const [ev] = normalizeSquareNotification(note(p), "e1", null, HOSTED);
    expect(ev?.type).toBe("charge.failed");
    expect(ev?.providerIntentId).toBe(`${SQUARE_HOSTED_PREFIX}${p.order_id}`);
    expect(ev?.ownership).toBe("ours");
    expect(ev?.ownershipRef).toBe(HOSTED.hostedRef);
    expect(ev?.failureCode).toBe("insufficient_funds");
    expect(ev?.providerFailureCode).toBe("INSUFFICIENT_FUNDS");
  });

  it("CANCELED → payment_abandoned, not a decline", () => {
    const [ev] = normalizeSquareNotification(
      note(payment({ status: "CANCELED" })),
      "e2",
      null,
      HOSTED,
    );
    expect(ev?.type).toBe("charge.failed");
    expect(ev?.failureCode).toBe("payment_abandoned");
  });

  it("an open try on the link is still not an event", () => {
    const [ev] = normalizeSquareNotification(
      note(payment({ status: "APPROVED" })),
      "e3",
      null,
      HOSTED,
    );
    expect(ev?.type).toBe("unknown");
  });
});

describe("square CANCELED read back", () => {
  it("is payment_abandoned for a buyer on a hosted page", () => {
    const r = chargeResultFromPayment(payment({ status: "CANCELED" }), { buyerPresent: true });
    expect(r.failure?.code).toBe("payment_abandoned");
  });

  it("is an expired hold otherwise, retriable", () => {
    const r = chargeResultFromPayment(payment({ status: "CANCELED" }));
    expect(r.failure?.code).toBe("intent_expired");
    expect(r.failure?.retriable).toBe(true);
  });
});

describe("square access refusals", () => {
  it("a known auth code keeps its own rule", () => {
    const f = squareAccessFailure({ code: "ACCESS_TOKEN_REVOKED" });
    expect(f.code).toBe("gateway_request_rejected");
    expect(f.ruleId).toBe("square.code.access_token_revoked");
  });

  it("an unknown 403 code is still our setup, with Square's code kept", () => {
    const f = squareAccessFailure({ code: "SOMETHING_NEW" });
    expect(f.code).toBe("gateway_request_rejected");
    expect(f.providerCode).toBe("SOMETHING_NEW");
  });
});
