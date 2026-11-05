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
  addressFieldLockViolation,
  addressFieldLocksFor,
  addressRequirementIssues,
  billingDetailsComplete,
  isPortalKeyLocked,
  mergePortalAddress,
  resolvePortalFieldConfig,
  withAddressFieldLocks,
} from "@/modules/checkout/address-field-rules";
import { resolveCheckoutFieldConfig } from "@/modules/checkout/field-config";

beforeAll(() => {
  primeGeoReference(
    JSON.parse(readFileSync(resolve(process.cwd(), "db/seed-data/geo.json"), "utf8")),
  );
});

const fields = (issues: Array<{ field: string }>) => issues.map((i) => i.field);

describe("resolvePortalFieldConfig", () => {
  it("defaults to the old portal form: first name, phone and the address core required", () => {
    const cfg = resolvePortalFieldConfig(null);
    expect(cfg).toEqual(DEFAULT_PORTAL_FIELD_CONFIG);
    const required = Object.entries(cfg)
      .filter(([, v]) => v === "mandatory")
      .map(([k]) => k)
      .sort();
    expect(required).toEqual([
      "billing.city",
      "billing.country",
      "billing.line1",
      "billing.postal_code",
      "billing.state_code",
      "customer.first_name",
      "customer.phone",
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
    const cfg = resolvePortalFieldConfig({ portalFieldConfig: { "billing.city": "sometimes" } });
    expect(cfg["billing.city"]).toBe("mandatory");
    expect(resolvePortalFieldConfig({ portalFieldConfig: [] })).toEqual(
      DEFAULT_PORTAL_FIELD_CONFIG,
    );
  });

  it("billing.country is never hidden", () => {
    const cfg = resolvePortalFieldConfig({ portalFieldConfig: { "billing.country": "hide" } });
    expect(cfg["billing.country"]).toBe("mandatory");
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
    expect(addressFieldLocksFor([])).toEqual({ country: false, state_code: false });
  });
  it("any region → country; a gst region → state_code too", () => {
    expect(addressFieldLocksFor(["vat"])).toEqual({ country: true, state_code: false });
    expect(addressFieldLocksFor(["flat", "gst"])).toEqual({ country: true, state_code: true });
  });

  it("forces locked keys to mandatory at runtime", () => {
    const stored = resolveCheckoutFieldConfig({
      checkoutFieldConfig: { "billing.country": "show", "billing.state_code": "hide" },
    });
    const eff = withAddressFieldLocks(stored, { country: true, state_code: true });
    expect(eff["billing.country"]).toBe("mandatory");
    expect(eff["billing.state_code"]).toBe("mandatory");
    expect(stored["billing.country"]).toBe("show"); // input not mutated
  });

  it("refuses a save that loosens a locked key", () => {
    const loose = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.country": "read_only", "billing.state_code": "show" },
    });
    expect(addressFieldLockViolation(loose, { country: true, state_code: false })).toBe(
      "Billing country must stay required while tax is set up.",
    );
    const stateOnly = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.state_code": "show" },
    });
    expect(addressFieldLockViolation(stateOnly, { country: true, state_code: true })).toBe(
      "State must stay required while GST is set up.",
    );
    expect(addressFieldLockViolation(stateOnly, { country: true, state_code: false })).toBeNull();
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

  it("defaults: city, region and postal code are required where the country has them", () => {
    const issues = addressRequirementIssues(checkoutDefaults, {
      line1: "1 Main St",
      country: "US",
    });
    expect(fields(issues)).toEqual(["city", "state_code", "postal_code"]);
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

  it("defaults: line1 and country are required, blank counts as missing", () => {
    expect(fields(addressRequirementIssues(checkoutDefaults, { line1: "  " }))).toEqual([
      "line1",
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
    const cfg = resolvePortalFieldConfig(null); // first name + phone mandatory
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

describe("billingDetailsComplete", () => {
  const defaults = resolvePortalFieldConfig(null);
  it("defaults: needs a name, line1 and country", () => {
    expect(billingDetailsComplete(defaults, true, { line1: "1 Main", country: "US" })).toBe(true);
    expect(billingDetailsComplete(defaults, true, { line1: null, country: "US" })).toBe(false);
    expect(billingDetailsComplete(defaults, false, { line1: "1 Main", country: "US" })).toBe(false);
  });
  it("an optional or hidden line1/country cannot block", () => {
    const cfg = resolvePortalFieldConfig({
      portalFieldConfig: { "billing.line1": "hide", "billing.country": "show" },
    });
    expect(billingDetailsComplete(cfg, true, { line1: null, country: null })).toBe(true);
  });
  it("a tax-forced country still blocks", () => {
    const cfg = withAddressFieldLocks(
      resolvePortalFieldConfig({ portalFieldConfig: { "billing.country": "show" } }),
      { country: true, state_code: false },
    );
    expect(billingDetailsComplete(cfg, true, { line1: "1 Main", country: null })).toBe(false);
  });
});
