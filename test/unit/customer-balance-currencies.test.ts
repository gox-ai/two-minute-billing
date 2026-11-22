import { describe, expect, it } from "vitest";
import {
  EXCESS_PAYMENT,
  foldBucketBalances,
  PROMOTIONAL_CREDIT,
  REFUNDABLE_CREDIT,
} from "@/modules/customers/balances-read";

describe("foldBucketBalances: which currencies the customer API lists", () => {
  it("lists a currency whose credit is used up, with zeros", () => {
    expect(foldBucketBalances([{ currency: "INR", account: EXCESS_PAYMENT, bal: "0" }])).toEqual({
      INR: { promotional: 0, refundable: 0, excess: 0 },
    });
  });

  it("does not list a currency with no ledger rows", () => {
    const out = foldBucketBalances([{ currency: "USD", account: PROMOTIONAL_CREDIT, bal: 2500 }]);
    expect(Object.keys(out)).toEqual(["USD"]);
    expect(foldBucketBalances([])).toEqual({});
  });

  it("puts each bucket in its slot, 0 for a bucket with no rows, and sorts by currency", () => {
    const out = foldBucketBalances([
      { currency: "USD", account: REFUNDABLE_CREDIT, bal: "700" },
      { currency: "INR", account: EXCESS_PAYMENT, bal: "569900" },
      { currency: "USD", account: PROMOTIONAL_CREDIT, bal: "0" },
    ]);
    expect(Object.keys(out)).toEqual(["INR", "USD"]);
    expect(out.INR).toEqual({ promotional: 0, refundable: 0, excess: 569900 });
    expect(out.USD).toEqual({ promotional: 0, refundable: 700, excess: 0 });
  });

  it("never reports a negative bucket", () => {
    expect(
      foldBucketBalances([{ currency: "EUR", account: PROMOTIONAL_CREDIT, bal: "-5" }]).EUR,
    ).toEqual({ promotional: 0, refundable: 0, excess: 0 });
  });
});
