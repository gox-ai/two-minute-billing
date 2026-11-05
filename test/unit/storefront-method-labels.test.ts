import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUYER_METHOD_TYPES } from "@/providers/method-types";
// Relative, not `@/…`: these live in the dashboard app and the root `@/` alias points at src/.
import { instrumentLabel } from "../../dashboard/lib/instrument-label";

describe("storefront method chooser", () => {
  const source = readFileSync(
    new URL("../../dashboard/app/(storefront)/method-choice.tsx", import.meta.url),
    "utf8",
  );
  it.each([...BUYER_METHOD_TYPES])("offers %s", (m) => {
    // A missing option hides a rail the server offers (PayPal on Braintree was unselectable).
    expect(source).toMatch(new RegExp(`value: "${m}"|debit\\("${m}"`));
  });
});

describe("instrumentLabel", () => {
  it("names a bank debit by its type, not its raw id", () => {
    expect(instrumentLabel({ type: "payto", last4: "78" })).toBe("PayTo •••• 78");
    expect(instrumentLabel({ type: "au_becs_debit", last4: "3456" })).toBe(
      "Direct debit (BECS Australia) •••• 3456",
    );
    expect(instrumentLabel({ type: "us_bank_account" })).toBe("Direct debit (ACH)");
  });

  it("capitalizes a lower-case brand", () => {
    expect(instrumentLabel({ type: "card", brand: "visa", last4: "4242" })).toBe("Visa •••• 4242");
  });

  it("keeps the wallet and mandate names", () => {
    expect(instrumentLabel({ type: "paypal" })).toBe("PayPal account");
    expect(instrumentLabel({ type: "upi", mandateRail: "upi" })).toBe("UPI Autopay");
  });
});
