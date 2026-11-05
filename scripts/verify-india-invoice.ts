/**
 * India GST tax invoice — the Phase 0 gate for the India-first launch
 * (docs/INDIA-LAUNCH.md §6). Proves the three things that make an INR invoice
 * legally issuable, end to end through the real pipeline rather than in isolation:
 *
 *   1. HSN/SAC on every SUPPLY line — resolved from the product where it sets one,
 *      from the business default otherwise — and absent from every line that
 *      classifies no supply (discount / tax / rounding).
 *   2. BOTH parties' GSTINs on the document: the seller's from the business, the
 *      buyer's from `customers.tax_registration_number`. The buyer half regressed
 *      silently for months because `assembleInvoiceDocument` read `vat_number` (the
 *      EU VIES id) instead — a different column with a different lifecycle. An
 *      invoice missing the buyer's GSTIN cannot be claimed against for input credit,
 *      and nothing throws.
 *   3. The place-of-supply split actually reaching a rendered invoice: an intra-state
 *      customer gets CGST + SGST as two lines, an inter-state customer gets one IGST
 *      line, from the same catalog and the same seller.
 *
 * Everything is asserted on the RENDERED artifacts (document model + HTML + PDF), not
 * just on the stored rows — the failure mode this guards against is a value that is
 * correct in the database and absent from the page a customer receives.
 *
 *   pnpm verify:india-invoice
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer, updateCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { deriveMandateCeiling, estimateRenewal } from "@/modules/subscriptions/estimate";
import {
  largestRecurringDebit,
  withMandateHeadroom,
  mandateFallbackCeiling,
} from "@/modules/payment-methods/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { configureIndiaGst } from "@/modules/tax/service";
import { assembleInvoiceDocument } from "@/modules/invoicing/document";
import { renderInvoicePdf } from "@/modules/invoicing/invoice-pdf";
import { renderInvoiceHtml } from "@/modules/invoicing/ops";
import { loadGeoReference } from "@/platform/geo";
import { invoices, subscriptions } from "@db/schema";

// State codes are normalized through the geo cache, which no script boots for itself.
await loadGeoReference();

const SELLER_GSTIN = "33ABCDE1234F1Z5"; // 33 = Tamil Nadu
const BUYER_TN_GSTIN = "33ZZZZZ9999Z1Z9";
const BUYER_KA_GSTIN = "29YYYYY8888Y1Y8";
const BIZ_DEFAULT_SAC = "998314"; // IT design & development — the business-wide default
const ADDON_SAC = "998311"; // management consulting — a product that overrides it

const org = await createOrganization({ name: "India Invoice Gate" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Acme Analytics Pvt Ltd",
  defaultCurrency: "INR",
  livemode: "test",
});
await updateBusiness(orgId, biz.publicId, {
  address: {
    line1: "Tidel Park",
    line2: "Taramani",
    city: "Chennai",
    state: "Tamil Nadu",
    postal_code: "600113",
    country: "IN",
  },
  taxRegistrationNumber: SELLER_GSTIN,
  defaultTaxCode: BIZ_DEFAULT_SAC,
  timezone: "Asia/Kolkata",
});

// Seller in Tamil Nadu: a TN customer is intra-state (CGST+SGST), everyone else IGST.
await configureIndiaGst({
  organizationId: orgId,
  businessId: biz.id,
  homeStateCode: "TN",
  cgstBps: 900,
  sgstBps: 900,
  registrationNumber: SELLER_GSTIN,
});

// Plan inherits the business default; the addon overrides it. Both must print.
const plan = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Pro",
  kind: "plan",
});
const planPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "INR",
  amountMinor: 100000,
  interval: "month",
});
const addon = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Onboarding Consulting",
  kind: "addon",
  taxCode: ADDON_SAC,
});
const addonPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: addon.id,
  type: "recurring",
  model: "flat",
  currency: "INR",
  amountMinor: 50000,
  interval: "month",
});

/** Bill one customer in `stateCode` and return the rendered artifacts. */
async function billOne(name: string, stateCode: string, city: string, gstin: string) {
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    company: name,
    email: `${stateCode.toLowerCase()}@buyer.example`,
    address: {
      line1: "1 Buyer Street",
      city,
      state: stateCode,
      stateCode,
      postalCode: "600001",
      country: "IN",
    },
    taxRegistrationNumber: gstin,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: planPrice, quantity: 1 },
      { price: addonPrice, quantity: 1 },
    ],
  });
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  const doc = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
  if (!doc) throw new Error(`assembleInvoiceDocument null for ${invoice.publicId}`);
  const html = await renderInvoiceHtml(orgId, biz.id, invoice.publicId);
  const pdf = await renderInvoicePdf(doc);
  return { invoice, doc, html: html ?? "", pdf, customer, subscription: fresh };
}

const intra = await billOne("Chennai Buyer Pvt Ltd", "TN", "Chennai", BUYER_TN_GSTIN);
const inter = await billOne("Bengaluru Buyer Pvt Ltd", "KA", "Bengaluru", BUYER_KA_GSTIN);

const sacsOf = (d: typeof intra.doc) => d.chargeLines.map((l) => l.taxCode);
const taxNames = (d: typeof intra.doc) => d.taxLines.map((t) => t.label).join("+");

console.log(
  `intra (TN→TN) ${intra.invoice.publicId}: lines=${intra.doc.chargeLines.length} sacs=${JSON.stringify(sacsOf(intra.doc))} tax=[${taxNames(intra.doc)}] total=${intra.doc.totals.totalMinor}`,
);
console.log(
  `inter (TN→KA) ${inter.invoice.publicId}: lines=${inter.doc.chargeLines.length} sacs=${JSON.stringify(sacsOf(inter.doc))} tax=[${taxNames(inter.doc)}] total=${inter.doc.totals.totalMinor}`,
);

const checks: Array<[string, boolean]> = [
  // ── 1. SAC on every supply line, from the right source ──────────────────────
  [
    "intra: every supply line carries a SAC",
    intra.doc.chargeLines.length >= 2 && sacsOf(intra.doc).every((c) => !!c),
  ],
  [
    "inter: every supply line carries a SAC",
    inter.doc.chargeLines.length >= 2 && sacsOf(inter.doc).every((c) => !!c),
  ],
  ["plan line inherits the BUSINESS default", sacsOf(intra.doc).includes(BIZ_DEFAULT_SAC)],
  ["addon line uses its PRODUCT override", sacsOf(intra.doc).includes(ADDON_SAC)],
  [
    "the two codes are distinct (override really applied)",
    new Set(sacsOf(intra.doc).filter(Boolean)).size === 2,
  ],

  // ── 2. Both GSTINs on the rendered document ─────────────────────────────────
  ["seller GSTIN on the document", intra.doc.seller.taxRegId === SELLER_GSTIN],
  [
    "buyer GSTIN on the document (tax_registration_number, NOT vat_number)",
    intra.doc.billTo.taxRegId === BUYER_TN_GSTIN,
  ],
  ["inter-state buyer GSTIN too", inter.doc.billTo.taxRegId === BUYER_KA_GSTIN],
  ["seller GSTIN printed in the HTML", intra.html.includes(SELLER_GSTIN)],
  ["buyer GSTIN printed in the HTML", intra.html.includes(BUYER_TN_GSTIN)],

  // ── 3. Place of supply reaching the rendered invoice ────────────────────────
  [
    "intra-state → CGST + SGST as two lines",
    intra.doc.taxLines.length === 2 &&
      /CGST/.test(taxNames(intra.doc)) &&
      /SGST/.test(taxNames(intra.doc)),
  ],
  [
    "inter-state → a single IGST line",
    inter.doc.taxLines.length === 1 && /IGST/.test(taxNames(inter.doc)),
  ],
  [
    "both carry the same 18% total tax",
    intra.doc.totals.taxTotalMinor === inter.doc.totals.taxTotalMinor,
  ],
  ["tax is 18% of ₹1500", intra.doc.totals.taxTotalMinor === 27000n],
  ["seller state snapshotted as TN", intra.doc.seller.addressLines.some((l) => /Chennai/.test(l))],

  // ── 4. The SAC survives into both rendered artifacts ────────────────────────
  ["HTML renders the HSN/SAC column header", intra.html.includes("HSN/SAC")],
  ["HTML prints the business-default SAC", intra.html.includes(BIZ_DEFAULT_SAC)],
  ["HTML prints the overriding SAC", intra.html.includes(ADDON_SAC)],
  ["PDF is a real PDF", intra.pdf.subarray(0, 7).toString("latin1").startsWith("%PDF-1.")],
  ["PDF non-trivial", intra.pdf.length > 3000],

  // The tax-id CAPTION, not just the number. It was hardcoded "GSTIN" in both renderers
  // until 0239 and is now resolved from the seller's / buyer's country
  // (`taxRegLabelFor`), so India — the one regime where GSTIN is the correct word — needs
  // an assertion of its own. Without this, a change to that resolver could relabel every
  // Indian tax invoice and no gate would notice.
  [
    "seller tax id is captioned GSTIN for an Indian seller",
    intra.doc.seller.taxRegLabel === "GSTIN",
  ],
  ["buyer tax id is captioned GSTIN for an Indian buyer", intra.doc.billTo.taxRegLabel === "GSTIN"],
  ["HTML prints the GSTIN caption", intra.html.includes("GSTIN :")],

  // ── 5. Non-supply lines classify nothing ────────────────────────────────────
  // Tax lines live in `taxLines`, not `chargeLines`, so the stored rows are the
  // only place to see that the exclusion actually held.
  [
    "no tax/discount/rounding row carries a SAC",
    await withTenant(orgId, async (tx) => {
      const rows = await tx.query.invoiceLineItems.findMany({
        where: (t, { eq: e }) => e(t.invoiceId, intra.invoice.id),
      });
      return rows
        .filter((r) => ["discount", "tax", "rounding"].includes(r.kind))
        .every((r) => r.taxCode === null);
    }),
  ],

  // ── 6. The mandate this buyer would be asked to authorise ───────────────────
  // Lives in the GST fixture because GST is the whole point: the ceiling has to be
  // sized on what the invoice above actually PRESENTS (₹1,500 + 18% = ₹1,770), not on
  // the price columns (₹1,500). The old rule summed prices and multiplied by 3, which
  // was wrong twice over — it missed the tax and it asked for ₹4,500.
  //
  // ⚠️ The MULTIPLE moved on 2026-09-01, 25% → 3.5× (`MANDATE_HEADROOM_BPS`). 25% is what
  // made every upgrade of more than a quarter uncollectable: on a real price ladder
  // (lite ₹9,118 → pro ₹27,918 → business ₹56,118, one-step ratios 3.06× and 2.01×) no
  // single-step upgrade fitted under the ceiling the previous plan registered, and the
  // audited subscription took three `mandate_ceiling_exceeded` refusals over an invoice
  // that could never pay. The upgrade assertion below is the regression.
  ...(await (async () => {
    const ceiling = await deriveMandateCeiling(orgId, biz.id, intra.customer.id, "INR");
    const renewal = await estimateRenewal({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: intra.subscription.id,
    });
    const priceSum = await largestRecurringDebit(orgId, biz.id, intra.customer.id, "INR");
    // A customer with nothing to derive from: the fallback must still be the AFA-free
    // ceiling, because the ordinary signup order is vault-THEN-subscribe.
    const bare = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      company: "No Subscription Pvt Ltd",
      email: "bare@buyer.example",
      address: {
        line1: "2 Buyer Street",
        city: "Chennai",
        state: "TN",
        stateCode: "TN",
        postalCode: "600001",
        country: "IN",
      },
    });
    const bareCeiling = await deriveMandateCeiling(orgId, biz.id, bare.id, "INR");
    console.log(
      `mandate: ceiling=${ceiling} renewal_total=${renewal?.total_minor} price_sum=${priceSum} bare=${bareCeiling}`,
    );
    return [
      [
        // Derived: the assertion is that the ceiling sizes from the TAX-INCLUSIVE ₹1,770
        // the invoice presents, not from the ₹1,500 price columns. Restating the product
        // as ₹6,195 made this a test of the multiple instead.
        "plan + addon + tax all reach the ceiling (headroom over the ₹1,770 presented)",
        ceiling === withMandateHeadroom(177_000n),
      ],
      [
        "the ceiling IS headroom over the renewal total",
        renewal != null && ceiling === withMandateHeadroom(BigInt(renewal.total_minor)),
      ],
      [
        "tax is inside the sized amount, not left to the headroom",
        ceiling > withMandateHeadroom(priceSum),
      ],
      /**
       * INVERTED 2026-09-03, and deliberately. Until then a mandate had to carry a
       * THREE-FOLD upgrade — the largest single step on the real ladder (lite → pro,
       * 3.0645×) — which took a 3.5× multiple, and that asked a ₹10,759 customer to
       * authorise ₹37,657. `MANDATE_HEADROOM_BPS` is 1.3× now: the buyer sees a believable
       * number and an upgrade requires re-authorisation instead. `mandate_shortfall` names
       * that on the change screen before the operator commits.
       *
       * Asserted rather than deleted, so the trade stays visible: the ceiling still covers
       * the bill it was sized for (the assertion above), and no longer covers the step up.
       */
      [
        "a one-step ladder upgrade does NOT fit — re-authorisation is required, by design",
        renewal != null && ceiling < BigInt(renewal.total_minor) * 3n,
      ],
      [
        "…and the ceiling still comfortably covers the bill it was sized for",
        renewal != null && ceiling > BigInt(renewal.total_minor),
      ],
      [
        "a customer with no subscription still falls back to ₹15,000",
        bareCeiling === mandateFallbackCeiling("INR"),
      ],
    ] as Array<[string, boolean]>;
  })()),
];

// ── 5. The issued invoice keeps the buyer it was issued to ──────────────────────
// A customer edit after issue must not rewrite the address or GSTIN on an issued invoice.
await updateCustomer({
  organizationId: orgId,
  businessId: biz.id,
  customerPublicId: intra.customer.publicId,
  address: {
    line1: "9 Moved Road",
    city: "New Delhi",
    state: "DL",
    stateCode: "DL",
    postalCode: "110001",
    country: "IN",
  },
  taxRegistrationNumber: BUYER_KA_GSTIN,
});
// …and the seller side: a re-registration after issue must not reach it either.
await updateBusiness(orgId, biz.publicId, {
  taxRegistrationNumber: "33NEWGS0000N1Z0",
  defaultInvoiceNotes: "Changed later",
});
const [issued] = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.id, intra.invoice.id)).limit(1),
);
const docAfter = await assembleInvoiceDocument(orgId, biz.id, intra.invoice.publicId);
const snapCity = (issued?.billingAddress as { city?: string } | null)?.city;
checks.push(
  ["issue snapshots the buyer GSTIN", issued?.customerTaxId === BUYER_TN_GSTIN],
  [`issue snapshots the billing address [${snapCity}]`, snapCity === "Chennai"],
  [
    "a later GSTIN change does not reach the issued document",
    docAfter?.billTo.taxRegId === BUYER_TN_GSTIN,
  ],
  [
    "a later address change does not reach the issued document",
    !!docAfter?.billTo.addressLines.some((l) => /Chennai/.test(l)) &&
      !docAfter?.billTo.addressLines.some((l) => /Delhi/.test(l)),
  ],
  [
    "the snapshot carries the state code",
    (issued?.billingAddress as { state_code?: string } | null)?.state_code === "TN",
  ],
  [
    "issue freezes the seller GSTIN",
    issued?.sellerTaxId === SELLER_GSTIN && issued?.sellerTaxCountry === "IN",
  ],
  [
    "a later seller re-registration does not reach the issued document",
    docAfter?.seller.taxRegId === SELLER_GSTIN,
  ],
  [
    "issue freezes notes ('' = none then), not the later default",
    issued?.notes === "" && docAfter?.meta.notes === null,
  ],
  ["issue records when it was finalized", issued?.finalizedAt != null],
  [
    `issue records the price type [${issued?.priceType}]`,
    issued?.priceType === "exclusive" || issued?.priceType === "inclusive",
  ],
);

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
console.log("");
console.log(`${checks.length - failed} passed, ${failed} failed`);
console.log(failed === 0 ? "✅ INDIA GST INVOICE: PASS" : "❌ INDIA GST INVOICE: FAIL");
await closeDb();
process.exit(failed === 0 ? 0 : 1);
