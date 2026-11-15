import { describe, expect, it } from "vitest";
import { listDirection } from "@/modules/customer-portal/plan-change";
import { portalPauseTerms } from "@/api/customer-portal-routes";

type PriceRow = Parameters<typeof listDirection>[1];
const price = (amount: number | null, interval = "month", model = "flat") =>
  ({
    type: "recurring",
    model,
    amountMinor: amount == null ? null : BigInt(amount),
    interval,
    intervalCount: 1,
  }) as unknown as PriceRow;

describe("portal plan list direction", () => {
  it("compares single prices per month", () => {
    expect(listDirection({ price: price(2900), quantity: 1 }, price(7900))).toBe("upgrade");
    expect(listDirection({ price: price(7900), quantity: 1 }, price(2900))).toBe("downgrade");
  });
  it("a longer billing period is an upgrade", () => {
    expect(listDirection({ price: price(7900), quantity: 1 }, price(29000, "year"))).toBe(
      "upgrade",
    );
  });
  it("gives no direction for a price with no single rate (stairstep, tiered)", () => {
    expect(
      listDirection({ price: price(2900), quantity: 1 }, price(null, "month", "stairstep")),
    ).toBeNull();
    expect(
      listDirection({ price: price(null, "month", "stairstep"), quantity: 1 }, price(2900)),
    ).toBeNull();
  });
});

describe("portal pause terms", () => {
  it("defaults: pause now, a resume bills now", () => {
    expect(portalPauseTerms(null)).toEqual({ starts: "now", resume_charge: "now" });
  });
  it("reads the business pause config", () => {
    expect(
      portalPauseTerms({
        pauseConfig: { pause_option: "end_of_term", charges_on_resume: "add_to_unbilled_charges" },
      }),
    ).toEqual({ starts: "end_of_term", resume_charge: "next_invoice" });
    // The retired value reads as the next invoice.
    expect(
      portalPauseTerms({ pauseConfig: { charges_on_resume: "next_renewal" } }).resume_charge,
    ).toBe("next_invoice");
  });
});
