/**
 * Tax permutation matrix — drives the resolver directly (one business per case, so
 * regions cannot collide).
 *
 * Original coverage, preserved:
 *  - no customer country → no tax,
 *  - state-specific rate takes precedence over country-wide,
 *  - state mismatch falls back to the country-wide rate,
 *  - rounding (floor of basis-point math),
 *  - no enabled rate is ignored, zero subtotal → 0.
 *
 * New coverage for the component/place-of-supply engine:
 *  - India intra-state resolves CGST + SGST/UTGST; inter-state resolves IGST,
 *  - both branches total the same 18%,
 *  - SEZ/export IGST treatments force inter-state regardless of address,
 *  - zero-rated and reverse-charge treatments tax nothing but say WHY,
 *  - a disabled region is ignored,
 *  - customer exemption short-circuits before any region lookup,
 *  - a `flat` region ignores intra/inter components (and refuses to store them).
 *
 *   pnpm verify:tax-matrix
 */
import { closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import {
  TaxError,
  configureIndiaGst,
  createFlatTaxRate,
  getTaxProvider,
  setTaxRateComponents,
  setTaxRegionEnabled,
  taxMinorFor,
  updateTaxRegion,
} from "@/modules/tax/service";
import { loadGeoReference } from "@/platform/geo";

// No API boot in a script, so the geo cache is empty — and every state-scoped rate
// in the matrix below normalizes its state code through it. See verify-tax.ts.
await loadGeoReference();

const org = await createOrganization({ name: "TaxMatrix" });
const orgId = org.organization.id;
const tax = getTaxProvider();
const checks: Array<[string, boolean]> = [];
let biz = 0;
const newBiz = async () =>
  (await createBusiness({ defaultCurrency: "USD", organizationId: orgId, name: `b${biz++}` })).id;
/** Resolve + total, the two steps the invoice pipeline takes. */
const amountOf = async (
  businessId: string,
  args: {
    country?: string | null;
    stateCode?: string | null;
    treatment?: never | string;
    customerExempt?: boolean;
  },
  base: bigint,
) => {
  const r = await tax.resolve({ organizationId: orgId, businessId, ...(args as object) });
  return { r, taxMinor: taxMinorFor(r, base) };
};

// 1) No country → no tax.
{
  const b = await newBiz();
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "VAT",
    country: "GB",
    rateBps: 2000,
  });
  const { r, taxMinor } = await amountOf(b, { country: null }, 10000n);
  console.log(`no country: tax=${taxMinor} reason=${r.taxabilityReason} (exp 0/no_rate)`);
  checks.push(["no country → 0", taxMinor === 0n && r.taxabilityReason === "no_rate"]);
}

// 2) Country-wide rate applies.
{
  const b = await newBiz();
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "VAT",
    country: "GB",
    rateBps: 2000,
  });
  const { taxMinor } = await amountOf(b, { country: "GB" }, 10000n);
  console.log(`country-wide 20%: tax=${taxMinor} (exp 2000)`);
  checks.push(["country-wide applies", taxMinor === 2000n]);
}

// 3) State override precedence: US country-wide 5% + CA 10%, customer in CA → 10%.
{
  const b = await newBiz();
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "US",
    country: "US",
    rateBps: 500,
  });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "CA",
    country: "US",
    state: "CA",
    rateBps: 1000,
  });
  const { r, taxMinor } = await amountOf(b, { country: "US", stateCode: "CA" }, 10000n);
  console.log(
    `state precedence (CA over US): tax=${taxMinor} name=${r.components[0]?.name} (exp 1000/CA)`,
  );
  checks.push(["state-specific wins", taxMinor === 1000n && r.components[0]?.name === "CA"]);
}

// 4) State mismatch → fall back to country-wide. Customer in TX, only CA + country-wide.
{
  const b = await newBiz();
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "US",
    country: "US",
    rateBps: 500,
  });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "CA",
    country: "US",
    state: "CA",
    rateBps: 1000,
  });
  const { r, taxMinor } = await amountOf(b, { country: "US", stateCode: "TX" }, 10000n);
  console.log(
    `state fallback (TX → country-wide): tax=${taxMinor} name=${r.components[0]?.name} (exp 500/US)`,
  );
  checks.push([
    "state mismatch → country-wide",
    taxMinor === 500n && r.components[0]?.name === "US",
  ]);
}

// 5) Rounding: 8.25% (825 bps) of 999 = floor(82.4175) = 82.
{
  const b = await newBiz();
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "Sales",
    country: "US",
    rateBps: 825,
  });
  const { taxMinor } = await amountOf(b, { country: "US" }, 999n);
  console.log(`rounding 8.25% of 999: tax=${taxMinor} (exp 82, floored)`);
  checks.push(["floors bps math", taxMinor === 82n]);
}

// 6) No rate configured → 0; 7) zero subtotal → 0.
{
  const b = await newBiz();
  const r0 = await amountOf(b, { country: "GB" }, 10000n);
  console.log(`no rate configured: tax=${r0.taxMinor} (exp 0)`);
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "VAT",
    country: "GB",
    rateBps: 2000,
  });
  const rz = await amountOf(b, { country: "GB" }, 0n);
  console.log(`zero subtotal: tax=${rz.taxMinor} (exp 0)`);
  checks.push(["no rate → 0", r0.taxMinor === 0n], ["zero subtotal → 0", rz.taxMinor === 0n]);
}

// 8) A DISABLED region is ignored entirely.
{
  const b = await newBiz();
  const flat = await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "VAT",
    country: "GB",
    rateBps: 2000,
  });
  await setTaxRegionEnabled(orgId, b, flat.regionPublicId, false);
  const { r, taxMinor } = await amountOf(b, { country: "GB" }, 10000n);
  console.log(`disabled region: tax=${taxMinor} reason=${r.taxabilityReason} (exp 0/no_rate)`);
  checks.push(["disabled region ignored", taxMinor === 0n && r.taxabilityReason === "no_rate"]);
}

// 9) Customer exemption short-circuits before any region lookup.
{
  const b = await newBiz();
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "VAT",
    country: "GB",
    rateBps: 2000,
  });
  const { r, taxMinor } = await amountOf(b, { country: "GB", customerExempt: true }, 10000n);
  console.log(
    `exempt customer: tax=${taxMinor} reason=${r.taxabilityReason} (exp 0/customer_exempt)`,
  );
  checks.push([
    "exempt → customer_exempt",
    taxMinor === 0n && r.taxabilityReason === "customer_exempt",
  ]);
}

/* ───────────────────────────── India GST ───────────────────────────── */

// 10) Intra-state → CGST + SGST/UTGST as two components. 11) Inter-state → one IGST.
// 12) Both branches total the same 18%.
{
  const b = await newBiz();
  await configureIndiaGst({
    organizationId: orgId,
    businessId: b,
    homeStateCode: "TN",
    cgstBps: 900,
    sgstBps: 900,
    registrationNumber: "33AAFCN5032R1Z6",
  });
  const intra = await amountOf(b, { country: "IN", stateCode: "TN" }, 100000n);
  const inter = await amountOf(b, { country: "IN", stateCode: "KA" }, 100000n);
  console.log(
    `IN intra (TN→TN): ${intra.r.components.map((c) => `${c.name} ${c.rateBps}`).join(", ")} tax=${intra.taxMinor}`,
  );
  console.log(
    `IN inter (TN→KA): ${inter.r.components.map((c) => `${c.name} ${c.rateBps}`).join(", ")} tax=${inter.taxMinor}`,
  );
  const intraNames = intra.r.components
    .map((c) => c.name)
    .sort()
    .join("+");
  checks.push(
    ["intra-state → CGST + SGST/UTGST", intraNames === "CGST+SGST/UTGST"],
    ["intra-state totals 18%", intra.taxMinor === 18000n],
    [
      "inter-state → single IGST",
      inter.r.components.length === 1 && inter.r.components[0]!.name === "IGST",
    ],
    ["inter-state totals 18%", inter.taxMinor === 18000n],
    ["both branches total the same", intra.taxMinor === inter.taxMinor],
    ["intraState flag set correctly", intra.r.intraState === true && inter.r.intraState === false],
    ["supplying-state GSTIN resolved", intra.r.registrationNumber === "33AAFCN5032R1Z6"],
  );

  // 13) Cess stacks on BOTH branches.
  await configureIndiaGst({
    organizationId: orgId,
    businessId: b,
    homeStateCode: "TN",
    cgstBps: 900,
    sgstBps: 900,
    cessBps: 100,
    registrationNumber: "33AAFCN5032R1Z6",
  });
  const cIntra = await amountOf(b, { country: "IN", stateCode: "TN" }, 100000n);
  const cInter = await amountOf(b, { country: "IN", stateCode: "KA" }, 100000n);
  console.log(`with 1% Cess: intra=${cIntra.taxMinor} inter=${cInter.taxMinor} (exp 19000 both)`);
  checks.push(
    ["Cess applies intra-state", cIntra.taxMinor === 19000n],
    ["Cess applies inter-state", cInter.taxMinor === 19000n],
  );
}

// 14–17) Region-gated treatments.
{
  const b = await newBiz();
  const { region } = await configureIndiaGst({
    organizationId: orgId,
    businessId: b,
    homeStateCode: "TN",
    cgstBps: 900,
    sgstBps: 900,
    registrationNumber: "33AAFCN5032R1Z6",
  });
  await updateTaxRegion({
    organizationId: orgId,
    businessId: b,
    regionPublicId: region.publicId,
    patch: {
      sezIgstEnabled: true,
      sezIgstNote: "SEZ supply with payment of IGST",
      exportZeroRatedEnabled: true,
      exportZeroRatedNote: "Export of service — zero rated",
      reverseChargeEnabled: true,
      showReverseChargeNote: true,
      reverseChargeNote: "Tax payable by recipient under RCM",
    },
  });

  // SEZ IGST forces inter-state even for a customer in the seller's OWN state.
  const sez = await amountOf(b, { country: "IN", stateCode: "TN", treatment: "sez_igst" }, 100000n);
  console.log(
    `SEZ IGST (TN→TN): components=${sez.r.components.map((c) => c.name).join(",")} tax=${sez.taxMinor} note=${sez.r.taxNote}`,
  );
  checks.push(
    [
      "sez_igst forces IGST despite same state",
      sez.r.components.length === 1 && sez.r.components[0]!.name === "IGST",
    ],
    ["sez_igst still totals 18%", sez.taxMinor === 18000n],
    ["sez_igst carries its note", sez.r.taxNote === "SEZ supply with payment of IGST"],
  );

  const exp = await amountOf(
    b,
    { country: "IN", stateCode: "KA", treatment: "export_zero_rated" },
    100000n,
  );
  console.log(
    `export zero-rated: tax=${exp.taxMinor} reason=${exp.r.taxabilityReason} note=${exp.r.taxNote}`,
  );
  checks.push(
    ["export_zero_rated → 0", exp.taxMinor === 0n],
    [
      "export_zero_rated reason is zero_rated, not no_rate",
      exp.r.taxabilityReason === "zero_rated",
    ],
    ["export_zero_rated carries its note", exp.r.taxNote === "Export of service — zero rated"],
  );

  const rc = await amountOf(
    b,
    { country: "IN", stateCode: "KA", treatment: "reverse_charge" },
    100000n,
  );
  console.log(
    `reverse charge: tax=${rc.taxMinor} reason=${rc.r.taxabilityReason} note=${rc.r.taxNote}`,
  );
  checks.push(
    ["reverse_charge → 0", rc.taxMinor === 0n],
    ["reverse_charge has its own reason", rc.r.taxabilityReason === "reverse_charge"],
    [
      "reverse_charge note printed when shown",
      rc.r.taxNote === "Tax payable by recipient under RCM",
    ],
  );

  // The note is suppressed when the region says not to show it — the tax still zeroes.
  await updateTaxRegion({
    organizationId: orgId,
    businessId: b,
    regionPublicId: region.publicId,
    patch: { showReverseChargeNote: false },
  });
  const rcHidden = await amountOf(
    b,
    { country: "IN", stateCode: "KA", treatment: "reverse_charge" },
    100000n,
  );
  checks.push([
    "reverse_charge note hidden on request",
    rcHidden.r.taxNote === null && rcHidden.taxMinor === 0n,
  ]);
}

// 18) A non-GST region REFUSES intra/inter components rather than silently ignoring them.
{
  const b = await newBiz();
  const flat = await createFlatTaxRate({
    organizationId: orgId,
    businessId: b,
    name: "VAT",
    country: "GB",
    rateBps: 2000,
  });
  let refused = false;
  try {
    await setTaxRateComponents({
      organizationId: orgId,
      businessId: b,
      regionPublicId: flat.regionPublicId,
      components: [{ name: "CGST", rateBps: 900, appliesTo: "intra" }],
    });
  } catch (e) {
    refused = e instanceof TaxError;
  }
  console.log(`flat region rejects intra component: ${refused}`);
  checks.push(["flat region refuses intra/inter components", refused]);
}

// 19) A place-of-supply state override wins over the GST default vector.
{
  const b = await newBiz();
  const { region } = await configureIndiaGst({
    organizationId: orgId,
    businessId: b,
    homeStateCode: "TN",
    cgstBps: 900,
    sgstBps: 900,
    registrationNumber: "33AAFCN5032R1Z6",
  });
  // Karnataka override at 2.5% + 2.5% intra / 5% inter.
  await setTaxRateComponents({
    organizationId: orgId,
    businessId: b,
    regionPublicId: region.publicId,
    stateCode: "KA",
    components: [
      { name: "CGST", rateBps: 250, appliesTo: "intra" },
      { name: "SGST/UTGST", rateBps: 250, appliesTo: "intra" },
      { name: "IGST", rateBps: 500, appliesTo: "inter" },
    ],
  });
  const ka = await amountOf(b, { country: "IN", stateCode: "KA" }, 100000n);
  const tn = await amountOf(b, { country: "IN", stateCode: "TN" }, 100000n);
  console.log(
    `KA override: tax=${ka.taxMinor} (exp 5000 IGST) · TN default: tax=${tn.taxMinor} (exp 18000)`,
  );
  checks.push(
    ["state override applies to that state", ka.taxMinor === 5000n],
    ["state override does not leak to other states", tn.taxMinor === 18000n],
  );
}

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(`${checks.length} checks`);
console.log(pass ? "✅ TAX MATRIX: PASS" : "❌ TAX MATRIX: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
