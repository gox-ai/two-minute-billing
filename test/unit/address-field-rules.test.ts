/**
 * 0334 — portal field matrix, tax locks, and the config-driven address completeness check
 * shared by hosted checkout and the portal.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { primeGeoReference } from "@/platform/geo";
import {
  DEFAULT_PORTAL_FIELD_CONFIG,
  NO_ADDRESS_FIELD_LOCKS,
  addressFieldLockViolation,
  addressFieldLocksFor,
  addressRequirementIssues,
  billingDetailsComplete,
  billingDetailsMissing,
  isPortalKeyLocked,
  mergePortalAddress,
  resolvePortalFieldConfig,
  withAddressFieldLocks,
  buyerFieldConfig,
} from "@/modules/checkout/address-field-rules";
import { filledLine1 } from "@/modules/payment-methods/export-street";
import { resolveCheckoutFieldConfig } from "@/modules/checkout/field-config";

beforeAll(() => {
  primeGeoReference(
    JSON.parse(readFileSync(resolve(process.cwd(), "db/seed-data/geo.json"), "utf8")),
  );
});

const fields = (issues: Array<{ field: string }>) => issues.map((i) => i.field);

describe("resolvePortalFieldConfig", () => {
  it("defaults: only the name, country, postal code and state are required", () => {
    const cfg = resolvePortalFieldConfig(null);
    expect(cfg).toEqual(DEFAULT_PORTAL_FIELD_CONFIG);
    const required = Object.entries(cfg)
      .filter(([, v]) => v === "mandatory")
      .map(([k]) => k)
      .sort();
    expect(required).toEqual([
      "billing.country",
      "billing.postal_code",
      "billing.state_code",
      "customer.first_name",
    ]);
  });

  it("accepts read_only and keeps valid values", () => {
    const cfg = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.line1": "read_only", "customer.phone": "show" },
    });
    expect(cfg["billing.line1"]).toBe("read_only");
    expect(cfg["customer.phone"]).toBe("show");
  });

  it("a malformed value falls back to that key's default", () => {
    const cfg = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.postal_code": "sometimes" },
    });
    expect(cfg["billing.postal_code"]).toBe("mandatory");
    expect(resolvePortalFieldConfig({ portalFieldConfig: [] })).toEqual(
      DEFAULT_PORTAL_FIELD_CONFIG,
    );
  });

  it("billing.country may be hidden; only a lock brings it back", () => {
    const cfg = resolvePortalFieldConfig({ portalFieldConfig: { "billing.country": "hide" } });
    expect(cfg["billing.country"]).toBe("hide");
    expect(withAddressFieldLocks(cfg, addressFieldLocksFor(["vat"]))["billing.country"]).toBe(
      "mandatory",
    );
  });

  it("hide and read_only keys are locked to the stored value; show/mandatory are not", () => {
    const cfg = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.line2": "hide", "billing.line1": "read_only" },
    });
    expect(isPortalKeyLocked(cfg, "billing.line2")).toBe(true);
    expect(isPortalKeyLocked(cfg, "billing.line1")).toBe(true);
    expect(isPortalKeyLocked(cfg, "billing.city")).toBe(false);
    expect(isPortalKeyLocked(cfg, "customer.company")).toBe(false);
  });
});

describe("tax locks", () => {
  it("no live region → no locks", () => {
    expect(addressFieldLocksFor([])).toEqual({
      country: false,
      state_code: false,
      gateway_address: false,
      gateway_street_fill: false,
    });
  });
  it("any region → country; a gst region → state_code too", () => {
    expect(addressFieldLocksFor(["vat"])).toEqual({
      country: true,
      state_code: false,
      gateway_address: false,
      gateway_street_fill: false,
    });
    expect(addressFieldLocksFor(["flat", "gst"])).toEqual({
      country: true,
      state_code: true,
      gateway_address: false,
      gateway_street_fill: false,
    });
  });

  it("forces locked keys to mandatory at runtime", () => {
    const stored = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "billing.country": "show", "billing.state_code": "hide" },
    });
    const eff = withAddressFieldLocks(stored, {
      country: true,
      state_code: true,
      gateway_address: false,
      gateway_street_fill: false,
    });
    expect(eff["billing.country"]).toBe("mandatory");
    expect(eff["billing.state_code"]).toBe("mandatory");
    expect(stored["billing.country"]).toBe("show"); // input not mutated
  });

  it("refuses a save that loosens a locked key", () => {
    const loose = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.country": "read_only", "billing.state_code": "show" },
    });
    expect(
      addressFieldLockViolation(loose, {
        country: true,
        state_code: false,
        gateway_address: false,
        gateway_street_fill: false,
      }),
    ).toBe("Billing country must stay required while tax is set up.");
    const stateOnly = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.state_code": "show" },
    });
    expect(
      addressFieldLockViolation(stateOnly, {
        country: true,
        state_code: true,
        gateway_address: false,
        gateway_street_fill: false,
      }),
    ).toBe("State must stay required while GST is set up.");
    expect(
      addressFieldLockViolation(stateOnly, {
        country: true,
        state_code: false,
        gateway_address: false,
        gateway_street_fill: false,
      }),
    ).toBeNull();
  });
});

describe("addressRequirementIssues", () => {
  const checkoutDefaults = resolveCheckoutFieldConfig(null);
  const fullUs = {
    line1: "1 Main St",
    city: "Austin",
    state_code: "TX",
    postal_code: "78701",
    country: "US",
  };

  it("defaults: a complete US address passes", () => {
    expect(addressRequirementIssues(checkoutDefaults, fullUs)).toEqual([]);
  });

  it("defaults: region and postal code are required where the country has them", () => {
    const issues = addressRequirementIssues(checkoutDefaults, {
      line1: "1 Main St",
      country: "US",
    });
    expect(fields(issues)).toEqual(["state_code", "postal_code"]);
  });

  it("defaults: state OR state_code satisfies the region requirement", () => {
    const { state_code: _sc, ...noCode } = fullUs;
    expect(addressRequirementIssues(checkoutDefaults, { ...noCode, state: "Texas" })).toEqual([]);
  });

  it("defaults: no region asked where the country has no subdivisions", () => {
    const issues = addressRequirementIssues(checkoutDefaults, {
      line1: "1 Main St",
      city: "Gibraltar",
      postal_code: "GX11 1AA",
      country: "GI",
    });
    expect(fields(issues)).not.toContain("state_code");
  });

  it("defaults: no postal code asked where the country has none", () => {
    const issues = addressRequirementIssues(checkoutDefaults, {
      line1: "1 Main St",
      city: "Dubai",
      state_code: "DU",
      country: "AE",
    });
    expect(fields(issues)).not.toContain("postal_code");
  });

  it("defaults: only country is required without one, blank counts as missing", () => {
    expect(fields(addressRequirementIssues(checkoutDefaults, { country: "  " }))).toEqual([
      "country",
    ]);
  });

  it("show makes a field optional: city may be blank", () => {
    const cfg = resolveCheckoutFieldConfig({ checkoutFieldConfig: { "billing.city": "show" } });
    const { city: _c, ...noCity } = fullUs;
    expect(addressRequirementIssues(cfg, noCity)).toEqual([]);
  });

  it("hide is never required", () => {
    const cfg = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "billing.postal_code": "hide", "billing.line1": "hide" },
    });
    const { postal_code: _p, line1: _l, ...rest } = fullUs;
    expect(addressRequirementIssues(cfg, rest)).toEqual([]);
  });

  it("mandatory contact fields are required", () => {
    const cfg = resolvePortalFieldConfig({ portalFieldConfig: { "customer.phone": "mandatory" } });
    expect(fields(addressRequirementIssues(cfg, fullUs))).toEqual(["first_name", "phone"]);
    expect(
      addressRequirementIssues(cfg, { ...fullUs, first_name: "Pat", phone: "+15125550100" }),
    ).toEqual([]);
  });

  it("messages name the country's own labels", () => {
    const [issue] = addressRequirementIssues(checkoutDefaults, {
      line1: "1 MG Road",
      city: "Chennai",
      state_code: "TN",
      country: "IN",
    });
    expect(issue?.field).toBe("postal_code");
    expect(issue?.message).toMatch(/ is required for India\.$/);
  });
});

describe("mergePortalAddress", () => {
  const stored = {
    first_name: "Pat",
    last_name: "Stored",
    company: null,
    phone: "+15125550100",
    line1: "1 Old St",
    line2: "Suite 9",
    line3: null,
    city: "Austin",
    state: "Texas",
    state_code: "TX",
    postal_code: "78701",
    country: "US",
  };
  const incoming = {
    first_name: "Pat",
    last_name: "New",
    phone: "+15125550100",
    line1: "2 New St",
    line2: "Changed",
    city: "Sacramento",
    state_code: "CA",
    postal_code: "95814",
    country: "US",
  };

  it("hidden and read-only keys keep the stored value", () => {
    const cfg = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.line2": "hide", "customer.last_name": "read_only" },
    });
    const { address, keptAny } = mergePortalAddress(cfg, stored, incoming);
    expect(keptAny).toBe(true);
    expect(address.line2).toBe("Suite 9");
    expect(address.last_name).toBe("Stored");
    expect(address.line1).toBe("2 New St");
  });

  it("an editable region takes name and code together; a missing name comes from the code", () => {
    const cfg = resolvePortalFieldConfig({ portalFieldConfig: { "billing.state": "read_only" } });
    const { address } = mergePortalAddress(cfg, stored, incoming);
    expect(address.state_code).toBe("CA");
    expect(address.state).toBe("California"); // never the stored "Texas"
  });

  it("the region is kept only when both keys are locked", () => {
    const cfg = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.state": "hide", "billing.state_code": "read_only" },
    });
    const { address } = mergePortalAddress(cfg, stored, incoming);
    expect([address.state, address.state_code]).toEqual(["Texas", "TX"]);
  });

  it("nothing locked → the body wins and keptAny is false", () => {
    const cfg = resolvePortalFieldConfig({ portalFieldConfig: { "billing.state": "show" } });
    const { address, keptAny } = mergePortalAddress(cfg, stored, incoming);
    expect(keptAny).toBe(false);
    expect(address.line2).toBe("Changed");
    expect(address.line3).toBeNull();
  });
});

describe("billingDetailsComplete / billingDetailsMissing", () => {
  const defaults = resolvePortalFieldConfig(null);
  const us = { country: "US", postal_code: "94103", state_code: "CA" };
  it("defaults: a name, country and postal code are enough; line 1 and city are not asked", () => {
    expect(billingDetailsComplete(defaults, true, us)).toBe(true);
    expect(billingDetailsMissing(defaults, true, { country: "US" })).toEqual([
      "state_code",
      "postal_code",
    ]);
    expect(billingDetailsMissing(defaults, false, us)).toEqual(["first_name"]);
    expect(billingDetailsMissing(defaults, true, {})).toEqual(["country"]);
  });
  it("a mandatory postal code blocks, except where the country has none", () => {
    expect(billingDetailsComplete(defaults, true, { country: "US", state_code: "CA" })).toBe(false);
    expect(billingDetailsComplete(defaults, true, { country: "AE", state_code: "DU" })).toBe(true);
  });
  it("a field counts only where the config makes it mandatory", () => {
    const cfg = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.line1": "mandatory", "billing.postal_code": "show" },
    });
    expect(billingDetailsMissing(cfg, true, { country: "US", state_code: "CA" })).toEqual([
      "line1",
    ]);
    const hidden = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.line1": "hide", "billing.country": "show" },
    });
    expect(billingDetailsComplete(hidden, true, { postal_code: "94103" })).toBe(true);
  });
  it("a tax-forced country still blocks", () => {
    const cfg = withAddressFieldLocks(
      resolvePortalFieldConfig({ portalFieldConfig: { "billing.country": "show" } }),
      { country: true, state_code: false, gateway_address: false, gateway_street_fill: false },
    );
    expect(billingDetailsComplete(cfg, true, {})).toBe(false);
  });
});

describe("gateway street rule (Stripe India: a foreign card needs name + line1)", () => {
  const cfg = DEFAULT_PORTAL_FIELD_CONFIG;
  const rules = { streetRequiredOutside: "IN" };
  const us = { country: "US", postal_code: "94103", state_code: "CA", first_name: "Ana" };

  it("asks a buyer outside the account's country for line 1", () => {
    expect(billingDetailsMissing(cfg, true, us, rules)).toEqual(["line1"]);
    expect(addressRequirementIssues(cfg, us, rules)[0]?.message).toBe(
      "Address line 1 is required for United States.",
    );
  });

  it("leaves a buyer in the account's country and a gateway without the rule alone", () => {
    const india = { country: "IN", postal_code: "560001", state_code: "KA", first_name: "Ana" };
    expect(billingDetailsMissing(cfg, true, india, rules)).toEqual([]);
    expect(billingDetailsMissing(cfg, true, us)).toEqual([]);
  });

  it("is satisfied by line 1, and does not report it twice when the config requires it", () => {
    expect(billingDetailsMissing(cfg, true, { ...us, line1: "1 Market St" }, rules)).toEqual([]);
    const strict = { ...cfg, "billing.line1": "mandatory" as const };
    expect(billingDetailsMissing(strict, true, us, rules)).toEqual(["line1"]);
  });
});

describe("gateway address lock (a gateway needs name, street and country)", () => {
  const locks = addressFieldLocksFor([], { streetRequiredOutside: "IN" });

  it("comes from the gateway rule, not from tax", () => {
    expect(locks).toEqual({
      country: false,
      state_code: false,
      gateway_address: true,
      gateway_street_fill: false,
    });
    expect(addressFieldLocksFor(["gst"]).gateway_address).toBe(false);
  });

  it("keeps country required and first name + line 1 editable at runtime", () => {
    const loose = {
      ...DEFAULT_PORTAL_FIELD_CONFIG,
      "customer.first_name": "hide" as const,
      "billing.line1": "read_only" as const,
      "billing.country": "hide" as const,
    };
    const eff = withAddressFieldLocks(loose, locks);
    expect(eff["customer.first_name"]).toBe("show");
    expect(eff["billing.line1"]).toBe("show");
    expect(eff["billing.country"]).toBe("mandatory");
    const required = { ...DEFAULT_PORTAL_FIELD_CONFIG, "billing.line1": "mandatory" as const };
    expect(withAddressFieldLocks(required, locks)["billing.line1"]).toBe("mandatory");
  });

  it("refuses a settings save that hides them, and allows optional", () => {
    const hidden = { ...DEFAULT_PORTAL_FIELD_CONFIG, "billing.line1": "hide" as const };
    expect(addressFieldLockViolation(hidden, locks)).toMatch(/must stay visible/);
    const noCountry = { ...DEFAULT_PORTAL_FIELD_CONFIG, "billing.country": "show" as const };
    expect(addressFieldLockViolation(noCountry, locks)).toMatch(/country must stay required/);
    expect(addressFieldLockViolation(DEFAULT_PORTAL_FIELD_CONFIG, locks)).toBeNull();
  });
});

describe("gateway address lock with the street fill on", () => {
  const locks = addressFieldLocksFor([], { streetRequiredOutside: "IN", streetFill: true });
  const lineHidden = { ...DEFAULT_PORTAL_FIELD_CONFIG, "billing.line1": "hide" as const };

  it("is set only with the gateway rule", () => {
    expect(locks.gateway_street_fill).toBe(true);
    expect(addressFieldLocksFor([], { streetFill: true }).gateway_street_fill).toBe(false);
  });

  it("lets line 1 hide and keeps postal code and city editable", () => {
    expect(addressFieldLockViolation(lineHidden, locks)).toBeNull();
    const loose = {
      ...lineHidden,
      "billing.postal_code": "hide" as const,
      "billing.city": "read_only" as const,
    };
    const eff = withAddressFieldLocks(loose, locks);
    expect(eff["billing.line1"]).toBe("hide");
    expect(eff["billing.postal_code"]).toBe("show");
    expect(eff["billing.city"]).toBe("show");
    expect(addressFieldLockViolation(loose, locks)).toMatch(
      /postal code and city must stay visible/,
    );
  });

  it("asks a foreign buyer with line 1 hidden for the postal code, never line 1", () => {
    const cfg = withAddressFieldLocks(lineHidden, locks);
    const rules = { streetRequiredOutside: "IN", streetFill: true };
    const issues = addressRequirementIssues(cfg, { country: "US", first_name: "Ana" }, rules);
    expect(issues.map((i) => i.field)).toContain("postal_code");
    expect(issues.map((i) => i.field)).not.toContain("line1");
    const us = { country: "US", postal_code: "94103", state_code: "CA", first_name: "Ana" };
    expect(addressRequirementIssues(cfg, us, rules)).toEqual([]);
  });
});

describe("email-only buyer details (no tax, no gateway rule)", () => {
  const emailOnly = Object.fromEntries(
    Object.keys(DEFAULT_PORTAL_FIELD_CONFIG).map((k) => [k, "hide"]),
  ) as typeof DEFAULT_PORTAL_FIELD_CONFIG;

  it("keeps a hidden country and asks for no name or address", () => {
    expect(resolvePortalFieldConfig({ portalFieldConfig: emailOnly })["billing.country"]).toBe(
      "hide",
    );
    expect(billingDetailsMissing(emailOnly, false, {})).toEqual([]);
    expect(addressFieldLockViolation(emailOnly, NO_ADDRESS_FIELD_LOCKS)).toBeNull();
  });

  it("still asks for the name when only the address is hidden", () => {
    const noAddress = { ...emailOnly, "customer.first_name": "mandatory" as const };
    expect(billingDetailsMissing(noAddress, false, {})).toEqual(["first_name"]);
  });

  it("a tax region still forces the country back", () => {
    const tax = addressFieldLocksFor(["vat"]);
    expect(withAddressFieldLocks(emailOnly, tax)["billing.country"]).toBe("mandatory");
    expect(addressFieldLockViolation(emailOnly, tax)).toMatch(/country must stay required/);
  });
});

describe("fill line 1 for an export (storefront_config.fill_export_street)", () => {
  const cfg = DEFAULT_PORTAL_FIELD_CONFIG;
  const fill = { streetRequiredOutside: "IN", streetFill: true };
  it("asks a buyer abroad for the postal code, not the street", () => {
    const missing = billingDetailsMissing(cfg, true, { country: "US", first_name: "Ana" }, fill);
    expect(missing).toContain("postal_code");
    expect(missing).not.toContain("line1");
    expect(
      billingDetailsMissing(
        cfg,
        true,
        { country: "US", postal_code: "94103", state_code: "CA" },
        fill,
      ),
    ).toEqual([]);
  });
  it("falls back to the street when the postal code is hidden", () => {
    const hidden = { ...cfg, "billing.postal_code": "hide" as const };
    expect(billingDetailsMissing(hidden, true, { country: "US", state_code: "CA" }, fill)).toEqual([
      "line1",
    ]);
  });
});

describe("filledLine1", () => {
  const base = {
    country: "US",
    addressLine1: null,
    city: "San Francisco",
    state: "California",
    postalCode: "94103",
  };
  it("uses city and state for a buyer abroad with no street", () => {
    expect(filledLine1(base, "IN")).toBe("San Francisco, California");
  });
  it("keeps a typed street, an Indian buyer and a business that did not opt in unchanged", () => {
    expect(filledLine1({ ...base, addressLine1: "1 Market St" }, "IN")).toBeUndefined();
    expect(filledLine1({ ...base, country: "IN" }, "IN")).toBeUndefined();
    expect(filledLine1(base, null)).toBeUndefined();
  });
  it("falls back to the postal code when there is no city or state", () => {
    expect(filledLine1({ ...base, city: null, state: null }, "IN")).toBe("94103");
  });
});

describe("street lines 2 and 3 follow line 1 on the buyer's page", () => {
  it("hides them with a hidden line 1, and leaves the stored config alone", () => {
    const stored = {
      ...DEFAULT_PORTAL_FIELD_CONFIG,
      "billing.line1": "hide" as const,
      "billing.line2": "mandatory" as const,
      "billing.line3": "show" as const,
    };
    const eff = buyerFieldConfig(stored, NO_ADDRESS_FIELD_LOCKS);
    expect(eff["billing.line2"]).toBe("hide");
    expect(eff["billing.line3"]).toBe("hide");
    expect(stored["billing.line2"]).toBe("mandatory");
  });

  it("keeps them when a lock shows line 1 again, or line 1 is only read-only", () => {
    const stored = { ...DEFAULT_PORTAL_FIELD_CONFIG, "billing.line1": "hide" as const };
    const gateway = addressFieldLocksFor([], { streetRequiredOutside: "IN" });
    expect(buyerFieldConfig(stored, gateway)["billing.line2"]).toBe(stored["billing.line2"]);
    const readOnly = { ...DEFAULT_PORTAL_FIELD_CONFIG, "billing.line1": "read_only" as const };
    expect(buyerFieldConfig(readOnly, NO_ADDRESS_FIELD_LOCKS)["billing.line2"]).toBe(
      readOnly["billing.line2"],
    );
  });
});
