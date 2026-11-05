import { describe, expect, it } from "vitest";
import { taxSettingsPatchFromForm } from "../../dashboard/lib/tax-settings-form";

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe("Settings → Tax form", () => {
  it("a save that only adds a tax ID leaves the per-currency price type unset", () => {
    const r = taxSettingsPatchFromForm(
      form({
        currencies: "USD,INR",
        behavior_USD: "exclusive",
        behavior_USD_unset: "1",
        behavior_INR: "exclusive",
        behavior_INR_unset: "1",
        tax_rounding: "per_invoice_total",
        taxid_countries: "",
        new_country_0: "DE",
        new_taxid_0: "DE123456789",
      }),
    );
    expect(r).toEqual({
      patch: {
        tax_behavior_by_currency: null,
        tax_rounding: "per_invoice_total",
        seller_tax_ids: { DE: "DE123456789" },
      },
    });
  });

  it("writes a currency the operator changed or ticked, and keeps a saved one", () => {
    const r = taxSettingsPatchFromForm(
      form({
        currencies: "USD,INR,EUR",
        behavior_USD: "inclusive", // changed: no _unset marker
        behavior_INR: "exclusive",
        behavior_INR_unset: "1",
        behavior_INR_save: "on",
        behavior_EUR: "inclusive", // saved before
        tax_rounding: "per_line",
      }),
    );
    expect("patch" in r && r.patch.tax_behavior_by_currency).toEqual({
      USD: "inclusive",
      INR: "exclusive",
      EUR: "inclusive",
    });
  });

  it("refuses a new tax ID with no country", () => {
    const r = taxSettingsPatchFromForm(
      form({ currencies: "", tax_rounding: "per_line", new_taxid_1: "X1" }),
    );
    expect("errors" in r && r.errors).toEqual({ new_taxid_1: "Select a country" });
  });
});
