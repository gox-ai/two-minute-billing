import { describe, expect, it } from "vitest";
// Relative, not `@/…`: the root `@/` alias points at src/.
import { fieldLabel, storefrontErrorText } from "../../dashboard/lib/storefront-error";

describe("storefront actions never show a status line or a 500 text", () => {
  it("a 5xx or a body with no message gives no text, so the action's own sentence applies", () => {
    expect(storefrontErrorText(502, undefined, true)).toBeUndefined();
    expect(
      storefrontErrorText(500, { error: { message: "Internal server error" } }, false),
    ).toBeUndefined();
    expect(storefrontErrorText(400, undefined, false)).toBeUndefined();
    expect(storefrontErrorText(404, { error: {} }, true)).toBeUndefined();
  });

  it("a 4xx message passes", () => {
    expect(
      storefrontErrorText(400, { error: { message: "Select the box to accept the terms." } }, true),
    ).toBe("Select the box to accept the terms.");
  });

  it("checkout names each field reason by its form label, never the request key", () => {
    const body = {
      error: {
        message: "shipping_address.postal_code: …",
        details: {
          shipping_address: ['"1" is not a valid ZIP code for United States'],
          email: ["Enter a valid email address"],
        },
      },
    };
    expect(storefrontErrorText(400, body, true)).toBe(
      'Shipping address: "1" is not a valid ZIP code for United States; Email: Enter a valid email address',
    );
    // The portal shows the reasons alone.
    expect(storefrontErrorText(400, body, false)).toBe(
      '"1" is not a valid ZIP code for United States; Enter a valid email address',
    );
  });

  it("an unknown key reads as words", () => {
    expect(fieldLabel("tax_registration_number")).toBe("Tax ID");
    expect(fieldLabel("billing_address")).toBe("Billing address");
    expect(fieldLabel("purchase_order_ref")).toBe("Purchase order ref");
    expect(fieldLabel("address.state_code")).toBe("Address state code");
  });
});
