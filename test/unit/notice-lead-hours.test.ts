import { describe, expect, it } from "vitest";
import { noticeLeadHours } from "@/modules/payment-methods/notice-duty";

describe("our own debit notice lead", () => {
  it("is 10 days (+2 h margin) for an ACH debit whose authorization we hold (Reg E 1005.10(d))", () => {
    const ach = { type: "us_bank_account", mandateRail: null, providerKey: "authorizenet" };
    expect(noticeLeadHours(ach, null)).toBe(242);
  });
  it("is 26 h for a mandate rail the gateway does not notify", () => {
    const upi = { type: "upi", mandateRail: "upi", providerKey: "tmtest" };
    expect(noticeLeadHours(upi, null)).toBe(26);
  });
});
