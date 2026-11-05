/**
 * Migration 0245 — the checkout field matrix (`resolveCheckoutFieldConfig`). Defaults are
 * today's `checkoutCustomerBody` zod contract, field by field, and only an explicit member
 * of `"show" | "hide" | "mandatory"` may opt out of a field's own default — checked by
 * literal membership, never by truthiness, so a malformed value must resolve to that
 * field's default and never to a LOOSER state than it (a typo on a `mandatory` field must
 * not silently make it optional).
 */
import { describe, it, expect } from "vitest";
import {
  resolveCheckoutFieldConfig,
  isRequired,
  isHidden,
  DEFAULT_CHECKOUT_FIELD_CONFIG,
  type CheckoutFieldKey,
} from "@/modules/checkout/field-config";

/** Every key the matrix governs, and the state today's zod contract gives it. */
const EXPECTED_DEFAULTS: Record<CheckoutFieldKey, "show" | "hide" | "mandatory"> = {
  "customer.first_name": "show",
  "customer.last_name": "show",
  "customer.email": "show",
  "customer.phone": "show",
  "customer.company": "show",
  "customer.tax_registration_number": "show",
  "billing.line1": "mandatory",
  "billing.line2": "show",
  "billing.line3": "show",
  "billing.city": "mandatory",
  "billing.state": "show",
  "billing.state_code": "mandatory",
  "billing.postal_code": "mandatory",
  "billing.country": "mandatory",
  "invoice.po_number": "hide",
  "shipping.address": "hide",
};

describe("DEFAULT_CHECKOUT_FIELD_CONFIG — matches today's zod contract field by field", () => {
  it("has exactly the documented keys", () => {
    expect(Object.keys(DEFAULT_CHECKOUT_FIELD_CONFIG).sort()).toEqual(
      Object.keys(EXPECTED_DEFAULTS).sort(),
    );
  });

  for (const [key, expected] of Object.entries(EXPECTED_DEFAULTS)) {
    it(`${key} defaults to ${expected}`, () => {
      expect(DEFAULT_CHECKOUT_FIELD_CONFIG[key as CheckoutFieldKey]).toBe(expected);
    });
  }

  it("line1, city, state_code, postal_code and country are mandatory by default (0334)", () => {
    const mandatory = Object.entries(DEFAULT_CHECKOUT_FIELD_CONFIG)
      .filter(([, v]) => v === "mandatory")
      .map(([k]) => k)
      .sort();
    expect(mandatory).toEqual([
      "billing.city",
      "billing.country",
      "billing.line1",
      "billing.postal_code",
      "billing.state_code",
    ]);
  });

  it("shipping.address defaults to hide — never collected before 0360", () => {
    expect(DEFAULT_CHECKOUT_FIELD_CONFIG["shipping.address"]).toBe("hide");
  });

  it("po_number defaults to hide — never collected before 0243", () => {
    expect(DEFAULT_CHECKOUT_FIELD_CONFIG["invoice.po_number"]).toBe("hide");
  });
});

describe("resolveCheckoutFieldConfig — null/absent/malformed business", () => {
  it("null business resolves to the full default", () => {
    expect(resolveCheckoutFieldConfig(null)).toEqual(DEFAULT_CHECKOUT_FIELD_CONFIG);
  });

  it("undefined business resolves to the full default", () => {
    expect(resolveCheckoutFieldConfig(undefined)).toEqual(DEFAULT_CHECKOUT_FIELD_CONFIG);
  });

  it("a business with no checkoutFieldConfig key resolves to the full default", () => {
    expect(resolveCheckoutFieldConfig({})).toEqual(DEFAULT_CHECKOUT_FIELD_CONFIG);
  });

  it("an explicit null checkoutFieldConfig resolves to the full default", () => {
    expect(resolveCheckoutFieldConfig({ checkoutFieldConfig: null })).toEqual(
      DEFAULT_CHECKOUT_FIELD_CONFIG,
    );
  });

  it("a wholly malformed blob (wrong shape) resolves to the full default", () => {
    expect(resolveCheckoutFieldConfig({ checkoutFieldConfig: "not_an_object" })).toEqual(
      DEFAULT_CHECKOUT_FIELD_CONFIG,
    );
    expect(resolveCheckoutFieldConfig({ checkoutFieldConfig: 42 })).toEqual(
      DEFAULT_CHECKOUT_FIELD_CONFIG,
    );
    expect(resolveCheckoutFieldConfig({ checkoutFieldConfig: [] })).toEqual(
      DEFAULT_CHECKOUT_FIELD_CONFIG,
    );
  });
});

describe("malformed per-field values fall back to that field's OWN default — never a looser state", () => {
  it("a mandatory field (billing.line1) with an unknown string stays mandatory, not show", () => {
    const cfg = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "billing.line1": "sometimes" },
    });
    expect(cfg["billing.line1"]).toBe("mandatory");
  });

  it("a mandatory field (billing.country) with a non-string value stays mandatory", () => {
    const cfg = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "billing.country": true },
    });
    expect(cfg["billing.country"]).toBe("mandatory");
  });

  it("a mandatory field with a number value stays mandatory", () => {
    const cfg = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "billing.line1": 1 },
    });
    expect(cfg["billing.line1"]).toBe("mandatory");
  });

  it("a hide-default field (invoice.po_number) with an unknown string stays hidden, not mandatory", () => {
    const cfg = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "invoice.po_number": "sometimes" },
    });
    expect(cfg["invoice.po_number"]).toBe("hide");
  });

  it("a show-default field (customer.phone) with a malformed value stays show", () => {
    const cfg = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "customer.phone": "please" },
    });
    expect(cfg["customer.phone"]).toBe("show");
  });

  it("a stale fourth state (e.g. read_only) is not a valid member and falls back", () => {
    const cfg = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "billing.postal_code": "read_only" },
    });
    expect(cfg["billing.postal_code"]).toBe("mandatory");
  });

  it("one malformed key does not perturb resolution of the others", () => {
    const cfg = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "billing.line1": 123, "customer.email": "mandatory" },
    });
    expect(cfg["billing.line1"]).toBe("mandatory"); // its own default, unperturbed
    expect(cfg["customer.email"]).toBe("mandatory"); // the valid neighbour still applies
    expect(cfg["billing.country"]).toBe("mandatory"); // untouched keys keep their default
  });
});

describe("every valid state round-trips for every key", () => {
  const states = ["show", "hide", "mandatory"] as const;
  for (const key of Object.keys(EXPECTED_DEFAULTS) as CheckoutFieldKey[]) {
    for (const state of states) {
      if (key === "billing.country" && state === "hide") continue;
      it(`${key} → ${state}`, () => {
        const cfg = resolveCheckoutFieldConfig({ checkoutFieldConfig: { [key]: state } });
        expect(cfg[key]).toBe(state);
      });
    }
  }
});

describe("isRequired / isHidden", () => {
  it("isRequired is true only for mandatory", () => {
    const cfg = resolveCheckoutFieldConfig(null);
    expect(isRequired(cfg, "billing.line1")).toBe(true);
    expect(isRequired(cfg, "billing.country")).toBe(true);
    expect(isRequired(cfg, "customer.email")).toBe(false);
    expect(isRequired(cfg, "invoice.po_number")).toBe(false);
  });

  it("isHidden is true only for hide", () => {
    const cfg = resolveCheckoutFieldConfig(null);
    expect(isHidden(cfg, "invoice.po_number")).toBe(true);
    expect(isHidden(cfg, "billing.line1")).toBe(false);
    expect(isHidden(cfg, "customer.email")).toBe(false);
  });

  it("a field can never be both required and hidden", () => {
    for (const key of Object.keys(EXPECTED_DEFAULTS) as CheckoutFieldKey[]) {
      const cfg = resolveCheckoutFieldConfig({ checkoutFieldConfig: { [key]: "mandatory" } });
      expect(isRequired(cfg, key) && isHidden(cfg, key)).toBe(false);
    }
  });
});

describe("billing.country is never hidden (0334)", () => {
  it("a stored hide resolves to the default", () => {
    const cfg = resolveCheckoutFieldConfig({ checkoutFieldConfig: { "billing.country": "hide" } });
    expect(cfg["billing.country"]).toBe("mandatory");
  });
  it("show is kept", () => {
    const cfg = resolveCheckoutFieldConfig({ checkoutFieldConfig: { "billing.country": "show" } });
    expect(cfg["billing.country"]).toBe("show");
  });
});
