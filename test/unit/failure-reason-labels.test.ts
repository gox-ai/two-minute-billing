import { describe, expect, it } from "vitest";
import { failureReasonLabel } from "@/modules/metrics/daily/failure-labels";

describe("a stored failure code reads as one sentence, whatever the rail spelled", () => {
  it("resolves raw provider codes to the canonical refusal", () => {
    expect(failureReasonLabel("INSTRUMENT_DECLINED")).toBe("Card declined");
    expect(failureReasonLabel("TRANSACTION_REFUSED")).toBe("Card declined");
    expect(failureReasonLabel("card_declined")).toBe("Card declined");
    expect(failureReasonLabel("BAD_REQUEST_ERROR")).toBe("Gateway request rejected");
    expect(failureReasonLabel("payment_intent_payment_attempt_failed")).toBe(
      "Gateway request rejected",
    );
  });

  it("names the bucket for a missing code, and never blanks an unknown one", () => {
    expect(failureReasonLabel("unspecified")).toBe("No reason given");
    expect(failureReasonLabel("NA")).toBe("No reason given");
    expect(failureReasonLabel("SOME_NEW_CODE")).toBe("Some new code");
  });
});
