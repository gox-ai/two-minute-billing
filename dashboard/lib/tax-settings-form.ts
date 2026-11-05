/**
 * Settings → Tax form → the PATCH body. Pure, so the "an unset currency stays unset" rule
 * is unit-tested (`test/unit/tax-settings-form.test.ts`).
 */
export interface TaxSettingsFormPatch {
  tax_behavior_by_currency: Record<string, "inclusive" | "exclusive"> | null;
  tax_rounding: "per_invoice_total" | "per_line";
  seller_tax_ids: Record<string, string> | null;
}

/** Empty "add a country" rows the page renders. */
export const NEW_TAX_ID_ROWS = 3;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export function taxSettingsPatchFromForm(
  fd: FormData,
): { patch: TaxSettingsFormPatch } | { error: string; errors?: Record<string, string> } {
  const byCurrency: Record<string, "inclusive" | "exclusive"> = {};
  for (const c of str(fd, "currencies")
    .split(",")
    .filter((x) => /^[A-Z]{3}$/.test(x))) {
    // An unset currency the operator did not change or tick stays unset.
    if (fd.has(`behavior_${c}_unset`) && str(fd, `behavior_${c}_save`) !== "on") continue;
    const v = str(fd, `behavior_${c}`);
    if (v === "inclusive" || v === "exclusive") byCurrency[c] = v;
  }
  const rounding = str(fd, "tax_rounding");
  if (rounding !== "per_invoice_total" && rounding !== "per_line")
    return { error: "Select how to round tax." };
  const ids: Record<string, string> = {};
  for (const cc of str(fd, "taxid_countries")
    .split(",")
    .filter((x) => /^[A-Z]{2}$/.test(x))) {
    const id = str(fd, `taxid_${cc}`);
    if (id) ids[cc] = id;
  }
  const errors: Record<string, string> = {};
  for (let i = 0; i < NEW_TAX_ID_ROWS; i++) {
    const cc = str(fd, `new_country_${i}`).toUpperCase();
    const id = str(fd, `new_taxid_${i}`);
    if (!cc && !id) continue;
    if (!/^[A-Z]{2}$/.test(cc)) errors[`new_taxid_${i}`] = "Select a country";
    else if (!id) errors[`new_taxid_${i}`] = "Enter the tax ID";
    else ids[cc] = id;
  }
  if (Object.keys(errors).length) return { error: "Correct the highlighted fields.", errors };
  return {
    patch: {
      tax_behavior_by_currency: Object.keys(byCurrency).length ? byCurrency : null,
      tax_rounding: rounding,
      seller_tax_ids: Object.keys(ids).length ? ids : null,
    },
  };
}
