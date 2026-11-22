import { describe, it, expect } from "vitest";
import {
  payerNeedsNewMethod,
  payerDeclineMessage,
  payerRefusal,
  declineHiddenFromPayer,
  PAYER_SAFE_INTERNAL_FAILURE,
  PAYER_REASON_WITHHELD,
} from "@/providers/decline-codes";
import { roundingDeltaFor } from "@/modules/invoicing/service";
import { minorScale } from "@/platform/currency";

const FALLBACK = "no reason given";
// A code a built-in rule hides, and one no rule hides.
const OURS = "gateway_request_rejected";
const THEIRS = "insufficient_funds";

describe("payerDeclineMessage follows the business's Tell-the-customer override", () => {
  it("fixtures: one code hidden by default, one shown", () => {
    expect(declineHiddenFromPayer(OURS)).toBe(true);
    expect(declineHiddenFromPayer(THEIRS)).toBe(false);
  });

  it("no override = built-in behaviour", () => {
    expect(payerDeclineMessage({ code: OURS, message: "raw request error" }, FALLBACK)).toBe(
      PAYER_SAFE_INTERNAL_FAILURE,
    );
    // The gateway's own words never reach the payer: our sentence for the code does.
    const ours = payerDeclineMessage({ code: THEIRS }, FALLBACK);
    expect(ours).toMatch(/^Your bank declined the payment because/);
    expect(payerDeclineMessage({ code: THEIRS, message: "Insufficient funds." }, FALLBACK)).toBe(
      ours,
    );
  });

  it("override hide → show reveals the message", () => {
    expect(
      payerDeclineMessage({ code: OURS, message: "Our sentence", exposedToPayer: true }, FALLBACK),
    ).toBe("Our sentence");
  });

  it("override show → hide withholds it without blaming anyone", () => {
    expect(
      payerDeclineMessage(
        { code: THEIRS, message: "Insufficient funds.", exposedToPayer: false },
        FALLBACK,
      ),
    ).toBe(PAYER_REASON_WITHHELD);
    // Still ours: keeps the "problem on our side" copy.
    expect(
      payerDeclineMessage({ code: OURS, message: "raw", exposedToPayer: false }, FALLBACK),
    ).toBe(PAYER_SAFE_INTERNAL_FAILURE);
  });
});

describe("engine-minted failures carry our text and stay hidden", () => {
  it("gateway_error and gateway_account_unavailable are ours", () => {
    for (const code of ["gateway_error", "gateway_account_unavailable"]) {
      expect(declineHiddenFromPayer(code)).toBe(true);
      expect(payerDeclineMessage({ code, message: "TypeError: cannot read 'id'" }, FALLBACK)).toBe(
        PAYER_SAFE_INTERNAL_FAILURE,
      );
    }
  });

  it("an override can still show them", () => {
    expect(
      payerDeclineMessage(
        { code: "gateway_error", message: "Try again shortly.", exposedToPayer: true },
        FALLBACK,
      ),
    ).toBe("Try again shortly.");
  });
});

describe("round-off unit follows the currency's decimals", () => {
  it("JPY (0 decimals) is a no-op", () => {
    expect(minorScale("JPY")).toBe(1n);
    expect(roundingDeltaFor("nearest_unit", 1049n, minorScale("JPY"))).toBe(0n);
  });

  it("USD rounds to 100 minor", () => {
    expect(roundingDeltaFor("nearest_unit", 1049n, minorScale("USD"))).toBe(-49n);
    expect(roundingDeltaFor("nearest_unit", 1050n, minorScale("USD"))).toBe(50n);
  });

  it("KWD (3 decimals) rounds to 1000 minor", () => {
    expect(minorScale("KWD")).toBe(1000n);
    expect(roundingDeltaFor("nearest_unit", 10499n, minorScale("KWD"))).toBe(-499n);
    expect(roundingDeltaFor("nearest_unit", 10500n, minorScale("KWD"))).toBe(500n);
  });

  it("off is off", () => {
    expect(roundingDeltaFor("none", 1049n, 100n)).toBe(0n);
  });
});

describe("payerRefusal gives a present buyer one opening and one next step", () => {
  const LEAD = "We could not start your subscription.";
  const NEXT = "Try again, or use a different payment method.";
  const openings = (m: string) => m.match(/We could not/g)?.length;

  it("wraps a gateway reason", () => {
    expect(payerRefusal(LEAD, "Your card was declined")).toBe(
      `${LEAD} Your card was declined. We did not charge you. ${NEXT}`,
    );
  });
  it("our own fault: no second opening, and no different payment method", () => {
    const m = payerRefusal(LEAD, PAYER_SAFE_INTERNAL_FAILURE);
    expect(m).toBe(
      "We could not start your subscription because of a problem on our side. Your payment method is fine. We did not charge you. Try again in a few minutes.",
    );
    expect(openings(m)).toBe(1);
  });
  it("a withheld reason only repeats the lead, so it is dropped", () => {
    expect(payerRefusal(LEAD, PAYER_REASON_WITHHELD)).toBe(
      `${LEAD} We did not charge you. ${NEXT}`,
    );
  });
  it("a reason that opens 'We could not' takes the place of the lead", () => {
    const m = payerRefusal(LEAD, "We could not reach your bank.");
    expect(m).toBe(`We could not reach your bank. We did not charge you. ${NEXT}`);
    expect(openings(m)).toBe(1);
  });
  it("a reason that carries its next step gets no second one", () => {
    expect(payerRefusal(LEAD, "The card has expired. Contact your bank.")).toBe(
      `${LEAD} The card has expired. Contact your bank. We did not charge you.`,
    );
  });
});

describe("payerNeedsNewMethod", () => {
  it("leads with a new method only when the same one cannot succeed", () => {
    for (const c of [
      "expired_card",
      "lost_card",
      "STOLEN_CARD",
      "mandate_expired",
      "bank_account_closed",
    ])
      expect(payerNeedsNewMethod(c)).toBe(true);
    for (const c of [
      "insufficient_funds",
      "authentication_required",
      "incorrect_cvc",
      "processing_error",
      null,
    ])
      expect(payerNeedsNewMethod(c)).toBe(false);
  });
});
