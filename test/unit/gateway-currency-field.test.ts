import { describe, it, expect } from "vitest";
// Relative, not `@/…`: this lives in the dashboard app and the root `@/` alias points at src/.
import { gatewayCurrencyField } from "../../dashboard/lib/business-currencies";

const payu = { display_name: "PayU", currencies: ["INR"] };

describe("gatewayCurrencyField", () => {
  it("offers the business currencies the gateway takes", () => {
    const f = gatewayCurrencyField(["USD", "INR"], payu);
    expect(f.options).toEqual(["INR"]);
    expect(f.help).toContain("PayU does not take USD.");
    expect(f.emptyHint).toContain("No restriction");
  });

  it("says the account cannot take payments when no currency overlaps", () => {
    const f = gatewayCurrencyField(["EUR", "GBP"], payu);
    expect(f.options).toEqual([]);
    expect(f.emptyHint).toBe(
      "PayU takes none of the currencies of this business. This account cannot take payments.",
    );
    expect(f.emptyHint).not.toContain("No restriction");
  });
});
