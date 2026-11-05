/**
 * Proves tax END TO END on real invoices:
 *  - a configured rate is applied from the customer's billing country — tax line added,
 *    total = subtotal + tax, ledger books tax to `tax_payable` (subtotal→revenue);
 *  - India GST produces TWO tax lines intra-state (CGST + SGST/UTGST) and ONE inter-state
 *    (IGST), with per-component `applied_taxes` rows that reconcile to the invoice tax;
 *  - the seller's state, place of supply and treatment are SNAPSHOTTED onto the invoice;
 *  - region/component CRUD, including archive and a 404.
 *
 *   pnpm verify:tax
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  configureIndiaGst,
  createFlatTaxRate,
  getTaxProvider,
  listTaxRegions,
  setTaxRateComponents,
  setTaxRegionEnabled,
  taxMinorFor,
  updateTaxRegion,
} from "@/modules/tax/service";
import { invoices, invoiceLineItems, ledgerEntries, appliedTaxes } from "@db/schema";
import { loadGeoReference } from "@/platform/geo";
import { buildApp } from "@/index";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, cond: boolean) => checks.push([name, cond]);

// A script is its own process: nothing here boots the API, so the geo cache the
// server fills in `buildApp` is empty and every state code we hand to the tax
// service throws GeoNotLoadedError. The India GST section below is entirely
// state-coded, so this is load-bearing, not defensive.
await loadGeoReference();

/* ─────────────── 1. GB VAT end to end (the original assertions) ─────────────── */

const org = await createOrganization({ name: "Tax Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "GBP",
  livemode: "test",
});
await createFlatTaxRate({
  organizationId: orgId,
  businessId: biz.id,
  name: "VAT",
  country: "GB",
  rateBps: 2000,
});

// Customer in GB → taxed; (a customer with no country would be untaxed).
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "t@a.com",
  address: { line1: "1 St", city: "London", postalCode: "EC1", country: "GB" },
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "GBP",
  amountMinor: 10000,
  interval: "month", // £100
});
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});

const { invoice } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub.subscription,
  periodStart: sub.subscription.currentPeriodStart!,
  periodEnd: sub.subscription.currentPeriodEnd!,
});

const detail = await withTenant(orgId, async (tx) => {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1);
  const lines = await tx
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoice.id));
  const led = await tx.select().from(ledgerEntries);
  const bal: Record<string, bigint> = {};
  for (const e of led)
    bal[e.account] =
      (bal[e.account] ?? 0n) + (e.direction === "debit" ? e.amountMinor : -e.amountMinor);
  return { inv: inv!, lines, bal };
});

const taxLine = detail.lines.find((l) => l.kind === "tax");
console.log(
  `GB invoice subtotal=${detail.inv.subtotalMinor} total=${detail.inv.totalMinor} status=${detail.inv.status}`,
);
console.log(`GB tax line: ${taxLine ? taxLine.amountMinor + " — " + taxLine.description : "NONE"}`);
console.log(
  "ledger:",
  Object.fromEntries(Object.entries(detail.bal).map(([k, v]) => [k, v.toString()])),
);

ok("GB: subtotal 10000", Number(detail.inv.subtotalMinor) === 10000);
ok("GB: total 12000 (100 + 20% VAT)", Number(detail.inv.totalMinor) === 12000);
ok("GB: one tax line of 2000", !!taxLine && Number(taxLine.amountMinor) === 2000);
ok("GB: invoice paid", detail.inv.status === "paid");
ok("GB: revenue credited 10000", detail.bal["revenue"] === -10000n);
ok("GB: tax_payable credited 2000", detail.bal["tax_payable"] === -2000n);
ok("GB: cash debited 12000", detail.bal["cash"] === 12000n);
ok("GB: AR clear", (detail.bal["accounts_receivable"] ?? 0n) === 0n);

/* ─────────── 2. India GST end to end — intra-state, then inter-state ─────────── */

const inBiz = await createBusiness({
  organizationId: orgId,
  name: "IN Biz",
  defaultCurrency: "INR",
  livemode: "test",
});
await configureIndiaGst({
  organizationId: orgId,
  businessId: inBiz.id,
  homeStateCode: "TN",
  cgstBps: 900,
  sgstBps: 900,
  registrationNumber: "33AAFCN5032R1Z6",
});
const inProduct = await createProduct({
  organizationId: orgId,
  businessId: inBiz.id,
  name: "Pro IN",
});
const inPrice = await createPrice({
  organizationId: orgId,
  businessId: inBiz.id,
  productId: inProduct.id,
  type: "recurring",
  model: "flat",
  currency: "INR",
  amountMinor: 100000,
  interval: "month", // ₹1000.00
});

/** Bill one customer in `stateCode` and report the invoice's tax shape. */
async function billIn(stateCode: string, treatment?: string) {
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: inBiz.id,
    email: `in-${stateCode}-${treatment ?? "def"}@a.com`,
    address: { line1: "1 Rd", city: "X", postalCode: "600001", country: "IN", stateCode },
    ...(treatment ? { taxTreatment: treatment } : {}),
  } as never);
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: inBiz.id,
    customer: cus,
    token: "tok_4242",
  });
  const s = await createSubscription({
    organizationId: orgId,
    businessId: inBiz.id,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: inPrice, quantity: 1 }],
  });
  const { invoice: inv } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: inBiz.id,
    subscription: s.subscription,
    periodStart: s.subscription.currentPeriodStart!,
    periodEnd: s.subscription.currentPeriodEnd!,
  });
  return withTenant(orgId, async (tx) => {
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
    const lines = await tx
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, inv.id));
    const taxes = await tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, inv.id));
    return { inv: row!, taxLines: lines.filter((l) => l.kind === "tax"), taxes };
  });
}

const intra = await billIn("TN");
const intraNames = intra.taxLines.map((l) => l.description).sort();
console.log(
  `\nIN intra (TN→TN): total=${intra.inv.totalMinor} taxLines=[${intraNames.join(" | ")}]`,
);
console.log(
  `  applied_taxes: ${intra.taxes.map((t) => `${t.name} ${t.rateBps}bps ${t.amountMinor}`).join(", ")}`,
);
console.log(
  `  snapshot: seller=${intra.inv.sellerStateCode} pos=${intra.inv.placeOfSupplyCode} treatment=${intra.inv.taxTreatment}`,
);

ok("IN intra: total 118000 (1000 + 18%)", Number(intra.inv.totalMinor) === 118000);
ok("IN intra: TWO tax lines (CGST + SGST/UTGST)", intra.taxLines.length === 2);
ok(
  "IN intra: lines named CGST and SGST/UTGST",
  intraNames.join(",") === "CGST (9.00%),SGST/UTGST (9.00%)",
);
ok(
  "IN intra: each tax line is 9000",
  intra.taxLines.every((l) => Number(l.amountMinor) === 9000),
);
ok(
  "IN intra: applied_taxes reconcile to 18000",
  intra.taxes.reduce((s, t) => s + t.amountMinor, 0n) === 18000n,
);
ok(
  "IN intra: applied_taxes carry component ids",
  intra.taxes.every((t) => t.taxComponentId !== null),
);
ok("IN intra: seller state snapshotted as TN", intra.inv.sellerStateCode === "TN");
ok("IN intra: place of supply snapshotted as TN", intra.inv.placeOfSupplyCode === "TN");
ok("IN intra: treatment snapshotted as default", intra.inv.taxTreatment === "default");

const inter = await billIn("KA");
const interNames = inter.taxLines.map((l) => l.description);
console.log(
  `\nIN inter (TN→KA): total=${inter.inv.totalMinor} taxLines=[${interNames.join(" | ")}]`,
);
console.log(
  `  applied_taxes: ${inter.taxes.map((t) => `${t.name} ${t.rateBps}bps ${t.amountMinor}`).join(", ")}`,
);

ok("IN inter: total 118000 — same as intra", Number(inter.inv.totalMinor) === 118000);
ok("IN inter: ONE tax line", inter.taxLines.length === 1);
ok("IN inter: line named IGST 18%", interNames[0] === "IGST (18.00%)");
ok("IN inter: tax line is 18000", Number(inter.taxLines[0]?.amountMinor) === 18000);
ok("IN inter: place of supply snapshotted as KA", inter.inv.placeOfSupplyCode === "KA");
ok("IN inter: seller state still TN", inter.inv.sellerStateCode === "TN");

/* ───────── 3. A zero-rated export invoice states WHY, and taxes nothing ───────── */

const inRegions = await listTaxRegions(orgId, inBiz.id);
const inRegion = inRegions.find((r) => r.region.country === "IN")!;
await updateTaxRegion({
  organizationId: orgId,
  businessId: inBiz.id,
  regionPublicId: inRegion.region.publicId,
  patch: { exportZeroRatedEnabled: true, exportZeroRatedNote: "Export of service — zero rated" },
});
const zero = await billIn("KA", "export_zero_rated");
console.log(
  `\nIN export zero-rated: total=${zero.inv.totalMinor} taxLines=${zero.taxLines.length} note=${zero.inv.taxNote}`,
);
console.log(
  `  applied_taxes: ${zero.taxes.map((t) => `${t.name}/${t.taxabilityReason}`).join(", ")}`,
);
ok("IN zero-rated: total equals subtotal (no tax added)", Number(zero.inv.totalMinor) === 100000);
ok("IN zero-rated: no tax line item", zero.taxLines.length === 0);
ok(
  "IN zero-rated: applied_taxes records the reason",
  zero.taxes.some((t) => t.taxabilityReason === "zero_rated"),
);
ok(
  "IN zero-rated: note snapshotted onto the invoice",
  zero.inv.taxNote === "Export of service — zero rated",
);
ok("IN zero-rated: treatment snapshotted", zero.inv.taxTreatment === "export_zero_rated");

/* ──────────────────────── 4. Region + component CRUD ─────────────────────────── */

const crud = await createFlatTaxRate({
  organizationId: orgId,
  businessId: biz.id,
  name: "GST",
  country: "IN",
  rateBps: 1800,
});
// Replacing the vector is how a rate is "edited" — it is one decision, not N rows.
const edited = await setTaxRateComponents({
  organizationId: orgId,
  businessId: biz.id,
  regionPublicId: crud.regionPublicId,
  components: [{ name: "GST (IN)", rateBps: 500 }],
});
const archived = await setTaxRegionEnabled(orgId, biz.id, crud.regionPublicId, false);
const missing = await setTaxRegionEnabled(orgId, biz.id, "txg_nope", false);
const listed = await listTaxRegions(orgId, biz.id);
console.log(
  `\ncrud: edited=${edited[0]?.name}/${edited[0]?.rateBps}bps; archived enabled=${archived?.enabled}; 404=${missing === null}; regions=${listed.length}`,
);
ok(
  "crud: vector replaced",
  edited.length === 1 && edited[0]?.rateBps === 500 && edited[0]?.name === "GST (IN)",
);
ok("crud: region archived", archived?.enabled === false);
ok("crud: unknown region → null", missing === null);
ok("crud: two regions listed (GB + IN)", listed.length === 2);

// ── State-scoped components need a state CODE, and say so when they don't get one ──
// Regression guard. The scalar engine matched a free-text state NAME against the
// customer's free-text `state`; place of supply is now an ISO-3166-2 code compared
// against `state_code`. A caller that still supplies only the display name therefore
// resolves NO place of supply, a state-scoped component never applies, and the tax
// silently becomes 0 — a wrong number, not an error. This shipped in scripts/seed.ts
// (US-CA 7.25% stopped applying) and was caught by probing, not by a suite; these
// assertions are here so it cannot come back unnoticed.
const usBiz = await createBusiness({
  organizationId: orgId,
  name: "US Co",
  defaultCurrency: "USD",
});
await createFlatTaxRate({
  organizationId: orgId,
  businessId: usBiz.id,
  name: "US-CA Sales Tax",
  country: "US",
  state: "CA",
  rateBps: 725,
});
const provider = getTaxProvider();
const noCode = await provider.resolve({
  organizationId: orgId,
  businessId: usBiz.id,
  country: "US",
  stateCode: null,
});
const withCode = await provider.resolve({
  organizationId: orgId,
  businessId: usBiz.id,
  country: "US",
  stateCode: "CA",
});
const lowerCode = await provider.resolve({
  organizationId: orgId,
  businessId: usBiz.id,
  country: "US",
  stateCode: "ca",
});
console.log(
  `\nstate-scope: noCode=${noCode.taxabilityReason}/${taxMinorFor(noCode, 50000n)}; ` +
    `withCode=${withCode.taxabilityReason}/${taxMinorFor(withCode, 50000n)}; lowercase=${taxMinorFor(lowerCode, 50000n)}`,
);
ok(
  "state scope: a state CODE resolves the component (7.25% of 50000 = 3625)",
  taxMinorFor(withCode, 50000n) === 3625n,
);
ok("state scope: state code is case-insensitive", taxMinorFor(lowerCode, 50000n) === 3625n);
ok(
  "state scope: no state code → zero, and the reason is honest (no_rate, not standard_rated)",
  taxMinorFor(noCode, 50000n) === 0n && noCode.taxabilityReason === "no_rate",
);

/* ───── State registration DELETE: the region in the path must be its parent ───── */
{
  const app = await buildApp({ logger: false });
  const regBiz = await createBusiness({
    organizationId: orgId,
    name: "Reg Co",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const R = `/v1/businesses/${regBiz.publicId}/tax_regions`;
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `reg-${Math.random()}` },
    });
  const inRegion = (await call("POST", R, { country: "IN", home_state_code: "TN" })).json()
    .id as string;
  const usRegion = (await call("POST", R, { country: "US" })).json().id as string;
  const reg = (
    await call("PUT", `${R}/${inRegion}/state_registrations`, {
      state_code: "KA",
      registration_number: "29AAFCN5032R1Z1",
    })
  ).json();
  const wrongParent = await call("DELETE", `${R}/${usRegion}/state_registrations/${reg.id}`);
  const kept = (await call("GET", `${R}/${inRegion}`)).json().state_registrations as Array<{
    id: string;
  }>;
  ok("state registration: DELETE under another region → 404", wrongParent.statusCode === 404);
  ok(
    "state registration: …and the registration survives",
    kept?.some((r) => r.id === reg.id) === true,
  );
  const rightParent = await call("DELETE", `${R}/${inRegion}/state_registrations/${reg.id}`);
  ok(
    "state registration: DELETE under its own region still deletes",
    rightParent.statusCode === 200 && rightParent.json().deleted === true,
  );
  await app.close();
}

let pass = true;
console.log("");
for (const [n, good] of checks) {
  console.log(`  ${good ? "✓" : "✗"} ${n}`);
  if (!good) pass = false;
}
console.log("");
console.log(`${checks.length} checks`);
console.log(pass ? "✅ TAX: PASS" : "❌ TAX: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
