/**
 * Feature-rich invoice PDF/HTML export (Tier-1):
 *  - assembleInvoiceDocument resolves seller/billTo/meta + grouped charge,
 *    discount, tax, and rounding lines from the stored line items,
 *  - renderInvoicePdf emits a real pdfkit PDF (%PDF- magic, non-trivial size),
 *  - renderInvoiceHtml mirrors the PDF (business name, tax reg id, total).
 *
 * Scenario: an INR business (address + GSTIN + support email + nearest-unit
 * rounding) bills an India customer a ₹100 recurring plan with a 10% forever
 * coupon and 18% GST → subtotal 10000, discount 1000, GST 1620 on the
 * discounted base, pre-round 10620 → rounded to 10600 (rounding −20).
 *
 *   pnpm verify:invoice-pdf
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import { assembleInvoiceDocument, formatMoney } from "@/modules/invoicing/document";
import { assembleCreditNoteDocument } from "@/modules/credit-notes/document";
import { issueCreditNote } from "@/modules/credit-notes/service";
import { renderInvoicePdf } from "@/modules/invoicing/invoice-pdf";
import { renderInvoiceHtml } from "@/modules/invoicing/ops";
import { subscriptions, invoices, businesses, organizations } from "@db/schema";
import zlib from "node:zlib";

const org = await createOrganization({ name: "Invoice PDF Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Acme Billing Pvt Ltd",
  defaultCurrency: "INR",
  livemode: "test",
});
await updateBusiness(orgId, biz.publicId, {
  address: {
    line1: "4th Floor, Tech Park",
    line2: "MG Road",
    city: "Bengaluru",
    state: "Karnataka",
    postal_code: "560001",
    country: "IN",
  },
  supportEmail: "support@acme.example",
  website: "https://acme.example",
  taxRegistrationNumber: "29ABCDE1234F1Z5",
  invoiceRounding: "nearest_unit",
  defaultInvoiceNotes: "Thank you for your business. Payment due within terms.",
});

// 18% GST for India (place of supply = customer's IN address).
await createFlatTaxRate({
  organizationId: orgId,
  businessId: biz.id,
  name: "GST",
  country: "IN",
  rateBps: 1800,
});

const product = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Pro Plan",
  kind: "plan",
});
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "INR",
  amountMinor: 10000,
  interval: "month",
}); // ₹100

const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  firstName: "Rahul",
  lastName: "Sharma",
  email: "rahul@buyer.example",
  address: {
    line1: "221B Residency Rd",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560025",
    country: "IN",
  },
  vatNumber: "29ZZZZZ9999Z1Z9",
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
  items: [{ price, quantity: 1 }],
});
await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "SAVE10",
  kind: "percentage",
  percentOffBps: 1000,
  durationType: "forever",
});
await applyCouponToSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: subscription.id,
  code: "SAVE10",
  now: new Date(),
});

// Bill a fresh period → invoice carries the coupon discount + GST + rounding.
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
if (!doc) {
  console.error("assembleInvoiceDocument returned null");
  await closeDb();
  process.exit(1);
}

const pdf = await renderInvoicePdf(doc);
const html = await renderInvoiceHtml(orgId, biz.id, invoice.publicId);

// Both renderers format money through the document model's canonical formatMoney
// (symbol-prefixed + thousands-grouped, e.g. ₹1,485.62 — ebf2434). Assert against
// that, and pin the expected form so a silent format change still trips a check.
const formattedTotal = formatMoney(doc.totals.totalMinor, doc.totals.currency);

const checks: Array<[string, boolean]> = [
  ["seller.name resolved", doc.seller.name === "Acme Billing Pvt Ltd"],
  ["seller.taxRegId (GSTIN) resolved", doc.seller.taxRegId === "29ABCDE1234F1Z5"],
  ["seller address lines present", doc.seller.addressLines.length >= 2],
  ["billTo.name resolved", doc.billTo.name === "Rahul Sharma"],
  ["billTo.taxRegId resolved from vat_number", doc.billTo.taxRegId === "29ZZZZZ9999Z1Z9"],
  ["≥1 charge line", doc.chargeLines.length >= 1],
  ["≥1 tax line (GST)", doc.taxLines.length >= 1],
  ["discountTotal > 0", doc.totals.discountTotalMinor > 0n],
  ["tax line labelled from description", /GST/.test(doc.taxLines[0]?.label ?? "")],
  ["rounding line captured (−20)", doc.totals.roundingMinor === -20n],
  ["totals.totalMinor present (10600)", doc.totals.totalMinor === 10600n],
  ["totals.amountDueMinor present", typeof doc.totals.amountDueMinor === "bigint"],
  ["notes carried through", !!doc.meta.notes && doc.meta.notes.includes("Thank you")],
  ["PDF starts with %PDF-1.", pdf.subarray(0, 7).toString("latin1").startsWith("%PDF-1.")],
  ["PDF non-trivial (> 3000 bytes)", pdf.length > 3000],
  ["HTML contains business name", !!html && html.includes("Acme Billing Pvt Ltd")],
  ["HTML contains tax reg id", !!html && html.includes("29ABCDE1234F1Z5")],
  ["total formats as ₹106.00 (symbol + 2dp)", formattedTotal === "₹106.00"],
  ["HTML contains formatted total", !!html && html.includes(formattedTotal)],
  [
    "HTML labels the currency code somewhere (Amount Due (INR))",
    !!html && html.includes(`Amount Due (${doc.totals.currency})`),
  ],
  // Amount-due regression guard (the bug: due used to render the ISSUE-TIME
  // collectible, ignoring payments, so a paid invoice printed the full amount due).
  // This invoice is auto-collected at billing, so it's already paid here.
  ["amount paid > 0 (auto-collected at billing)", doc.totals.amountPaidMinor > 0n],
  ["paid invoice → amount due 0", doc.totals.amountDueMinor === 0n],
  [
    "amount paid + amount due reconciles to total",
    doc.totals.amountPaidMinor + doc.totals.amountDueMinor === doc.totals.totalMinor,
  ],
];

console.log(
  `invoice ${invoice.publicId}: subtotal=${doc.totals.subtotalMinor} discount=${doc.totals.discountTotalMinor} tax=${doc.totals.taxTotalMinor} rounding=${doc.totals.roundingMinor} total=${doc.totals.totalMinor} due=${doc.totals.amountDueMinor}`,
);
console.log(`PDF bytes=${pdf.length}; formatted total=${formattedTotal}`);

/**
 * ── A period-less invoice must not borrow TODAY's cycle ──────────────────────
 *
 * An imported invoice object carries no top-level period — it lives on the line items —
 * so every imported invoice has `invoices.period_start` NULL (1,927 rows, 2026-09-06).
 * The document used to fall back to the SUBSCRIPTION's current period, which printed
 * today's cycle on a settled document from a year ago. Simulated here by clearing the
 * invoice's period and renewing the subscription underneath it.
 */
const billed = doc.chargeLines.find((l) => l.period)?.period ?? null;
await withTenant(orgId, (tx) =>
  tx
    .update(invoices)
    .set({ periodStart: null, periodEnd: null })
    .where(eq(invoices.id, invoice.id)),
);
const renewedStart = fresh.currentPeriodEnd!;
const renewedEnd = new Date(renewedStart.getTime() + 365 * 86_400_000);
await withTenant(orgId, (tx) =>
  tx
    .update(subscriptions)
    .set({ currentPeriodStart: renewedStart, currentPeriodEnd: renewedEnd })
    .where(eq(subscriptions.id, subscription.id)),
);
const orphan = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
checks.push(
  ["fixture: the charge line carries a period to fall back to", billed !== null],
  [
    "a period-less invoice shows its LINE period",
    orphan?.subscription?.periodStart?.getTime() === billed?.start.getTime(),
  ],
  [
    "…and NOT the subscription's renewed cycle",
    orphan?.subscription?.periodStart?.getTime() !== renewedStart.getTime(),
  ],
  [
    "next billing date is THIS invoice's period end, not the subscription's",
    orphan?.subscription?.nextBillingDate?.getTime() === billed?.end.getTime(),
  ],
);

/**
 * ── The document must ADD UP, and read like a document ───────────────────────
 *
 * An IMPORTED invoice carries no credit application — the import adapter reads neither
 * `applied_credits` nor `credits_applied` — while its `amount_due` arrives
 * already NET of one. Production showed Total ₹58,054.82 above Amount Due ₹52,414.64
 * with ₹5,640.18 unexplained between them.
 *
 * Built on an UNCOLLECTED invoice on purpose: on a fully-paid one the payments row
 * already explains every rupee, so an unexplained residual cannot exist and the first
 * version of this test passed for the wrong reason.
 */
const { invoice: openInv } = await createInvoiceFromLines({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  currency: "INR",
  lines: [{ description: "Imported-shape charge", amountMinor: 10_000_00n, quantity: 1 }],
});
const openDoc0 = await assembleInvoiceDocument(orgId, biz.id, openInv.publicId);
const CREDIT = 500_00n;
await withTenant(orgId, (tx) =>
  tx
    .update(invoices)
    .set({ amountDueMinor: openDoc0!.totals.totalMinor - CREDIT })
    .where(eq(invoices.id, openInv.id)),
);
const credited = await assembleInvoiceDocument(orgId, biz.id, openInv.publicId);
const creditedHtml = (await renderInvoiceHtml(orgId, biz.id, openInv.publicId)) ?? "";
const creditedPdf = await renderInvoicePdf(credited!);
const shownCredit = formatMoney(CREDIT, credited!.totals.currency);
checks.push(
  ["fixture: the credited invoice is uncollected", credited!.totals.amountPaidMinor === 0n],
  ["a credit with no bucket still prints a Credits row", creditedHtml.includes("<td>Credits</td>")],
  [
    "…for the exact unexplained amount",
    creditedHtml.includes(formatMoney(-CREDIT, credited!.totals.currency)),
  ],
  ["…and a CREDITS note naming it", creditedHtml.includes(`We applied a credit of ${shownCredit}`)],
  ["the credited invoice still renders a PDF", creditedPdf.length > 1000],
  [
    "summary reconciles: total − credit = amount due",
    credited!.totals.totalMinor - CREDIT === credited!.totals.amountDueMinor,
  ],
  // A bare alpha-2 is neither human- nor officer-readable.
  ["country prints as a NAME, not a code", doc.seller.addressLines.includes("India")],
  ["…and no bare country code remains", !doc.seller.addressLines.includes("IN")],
  ["party names are not rendered as links", !creditedHtml.includes("color:var(--accent)")],
);

/**
 * A valid solid-colour PNG, encoded by hand.
 *
 * Deliberately not a fixture file and not an image library: this gate asserts that pdfkit
 * EMBEDS a PNG, and a dependency on either would mean a failure here could also mean "the
 * asset moved" or "the native module did not build". Truecolour, 8-bit, filter 0 — the
 * simplest encoding pdfkit accepts. `zlib.crc32` is Node 22+.
 */
function tinyPng(
  width: number,
  height: number,
  rgb: [number, number, number] = [255, 103, 0],
): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(head));
    return Buffer.concat([len, head, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  // Each scanline is a filter byte followed by RGB triples.
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * ── A PNG logo reaches the page; an SVG is REFUSED ───────────────────────────
 *
 * This pair used to assert the opposite for SVG: it was rasterised through `sharp`, because
 * SVG was what merchants uploaded and a dropped logo was silent. As of 2026-09-09 there is
 * an upload path that stores only PNG/JPEG for a printed asset, so the conversion was
 * removed and SVG is refused on the read side too (SR-2026-015 — the org standard rejects
 * it, and this was the last place it was reachable).
 *
 * Both cases go through a `data:` URI, which keeps the run hermetic AND covers the
 * backward-compatibility path: the image columns are scheme-restricted now, so a `data:`
 * value can only be a row written before that, and those must still render.
 *
 * The PNG is generated here rather than read from a fixture file so the gate depends on no
 * asset and no image library — see `tinyPng`.
 */
const noLogoBytes = (await renderInvoicePdf(doc)).length;

const setLogo = (value: string) =>
  withTenant(orgId, (tx) =>
    tx.update(businesses).set({ logoUrl: value }).where(eq(businesses.id, biz.id)),
  );
const renderWithLogo = async () => {
  const d = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
  return (await renderInvoicePdf(d!)).length;
};

await setLogo(`data:image/png;base64,${tinyPng(240, 64).toString("base64")}`);
const pngBytes = await renderWithLogo();

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64">' +
  '<rect width="240" height="64" fill="#ff6700"/></svg>';
await setLogo(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
const svgBytes = await renderWithLogo();

checks.push(
  ["a PNG logo is embedded", pngBytes > noLogoBytes + 200],
  ["an SVG logo is REFUSED, not converted", svgBytes < noLogoBytes + 200],
  ["…and a refused logo still renders the document", svgBytes > 1000],
);

/**
 * ── The invoice can be issued by the ORGANIZATION ────────────────────────────
 *
 * Several businesses billing under one registered company is the common Indian shape:
 * the GSTIN belongs to the entity, and a buyer claiming input tax credit needs the
 * invoice to name it. `businesses.invoice_issuer = 'organization'` swaps the seller
 * block's NAME, ADDRESS and TAX ID — and nothing else, because brand and contact belong
 * to the business whoever issues the document.
 */
const ORG_GSTIN = "29AAAAA0000A1Z5";
await withTenant(orgId, (tx) =>
  tx
    .update(organizations)
    .set({
      legalName: "Acme Holdings Private Limited",
      address: { line1: "1 Entity Road", city: "Mumbai", state: "Maharashtra", country: "IN" },
      taxRegistrationNumber: ORG_GSTIN,
    })
    .where(eq(organizations.id, orgId)),
);
await withTenant(orgId, (tx) =>
  tx.update(businesses).set({ invoiceIssuer: "organization" }).where(eq(businesses.id, biz.id)),
);
// An invoice already issued keeps the seller it was issued by — the switch reaches only
// documents issued after it (0336/0337).
const issuedBefore = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
checks.push([
  "an invoice issued before the switch keeps its seller",
  issuedBefore?.seller.name === doc.seller.name &&
    issuedBefore?.seller.taxRegId === doc.seller.taxRegId,
]);
const { invoice: afterSwitch } = await createInvoiceFromLines({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  currency: invoice.currency,
  lines: [{ description: "Issuer check", amountMinor: 1_000n, quantity: 1 }],
});
const byOrg = await assembleInvoiceDocument(orgId, biz.id, afterSwitch.publicId);
checks.push(
  [
    "issuer=organization prints the LEGAL name",
    byOrg?.seller.name === "Acme Holdings Private Limited",
  ],
  ["…and the entity's GSTIN", byOrg?.seller.taxRegId === ORG_GSTIN],
  ["…and the entity's address", (byOrg?.seller.addressLines ?? []).includes("1 Entity Road")],
  [
    "…while the BUSINESS keeps brand and contact",
    byOrg?.seller.supportEmail === doc.seller.supportEmail,
  ],
);

// A credit note names the SAME seller as the invoice it reverses, or the two cannot be
// reconciled against one GSTIN.
const orgCn = await issueCreditNote({
  organizationId: orgId,
  businessId: biz.id,
  invoicePublicId: invoice.publicId,
  creditMethod: "balance",
  items: [{ description: "Issuer check", amountMinor: 100 }],
});
const cnByOrg = await assembleCreditNoteDocument(orgId, biz.id, orgCn.publicId);
// Raised AFTER the switch, against an invoice issued BEFORE it: it must still name that
// invoice's seller, or the two documents carry different GSTINs.
checks.push(
  [
    "credit note names the seller of the invoice it reverses",
    cnByOrg?.seller.name === issuedBefore?.seller.name,
  ],
  ["…and that invoice's GSTIN", cnByOrg?.seller.taxRegId === issuedBefore?.seller.taxRegId],
  [
    "…not the issuer switched to since",
    cnByOrg?.seller.taxRegId !== ORG_GSTIN &&
      cnByOrg?.seller.name !== "Acme Holdings Private Limited",
  ],
  ["…while the BUSINESS keeps contact", cnByOrg?.seller.supportEmail === doc.seller.supportEmail],
);

// An entity with nothing filled in must not blank the seller block on a tax document.
await withTenant(orgId, (tx) =>
  tx
    .update(organizations)
    .set({ legalName: null, address: null, taxRegistrationNumber: null })
    .where(eq(organizations.id, orgId)),
);
const emptyOrg = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
checks.push([
  "an EMPTY organization falls back to the business, never a blank seller",
  emptyOrg?.seller.name === doc.seller.name && emptyOrg?.seller.taxRegId === doc.seller.taxRegId,
]);
const cnEmptyOrg = await assembleCreditNoteDocument(orgId, biz.id, orgCn.publicId);
checks.push([
  "…and so does the credit note",
  cnEmptyOrg?.seller.name === doc.seller.name &&
    cnEmptyOrg?.seller.taxRegId === doc.seller.taxRegId,
]);
await withTenant(orgId, (tx) =>
  tx.update(businesses).set({ invoiceIssuer: "business" }).where(eq(businesses.id, biz.id)),
);

/**
 * ── ITEM-LEVEL DISCOUNT: the Amount column is NET, and the document names the coupon ──
 *
 * The fixture above uses an `invoice_amount` coupon, which is DOCUMENT-level: it prints as
 * a row under Sub Total and touches no line, so it cannot see either of the two things
 * this block guards. An `each_specified_item` coupon is the case that was broken — netted
 * into the subtotal, with its code recorded only in the database and printed nowhere.
 *
 * Both renderers used to print the GROSS line amount, so the lines visibly outsummed the
 * Sub Total and nothing on the page said why (reported as "discount from coupon is not
 * clear here"). We net it now. Nothing else asserted the VALUE of
 * that column, which is how a display change to a money document could have gone
 * unnoticed by a green suite.
 */
const ilSub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});
await createCoupon({
  organizationId: orgId,
  businessId: biz.id,
  code: "LINE25",
  kind: "percentage",
  percentOffBps: 2500,
  durationType: "forever",
  applyOn: "each_specified_item",
  // Required for `each_specified_item` to match anything at all.
  itemConstraints: [{ itemKind: "plan", constraintType: "all" }],
});
await applyCouponToSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: ilSub.subscription.id,
  code: "LINE25",
  now: new Date(),
});
const ilFresh = await withTenant(
  orgId,
  async (tx) =>
    (
      await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, ilSub.subscription.id))
        .limit(1)
    )[0]!,
);
const { invoice: ilInvoice } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: ilFresh,
  periodStart: ilFresh.currentPeriodStart!,
  periodEnd: ilFresh.currentPeriodEnd!,
});
const ilDoc = await assembleInvoiceDocument(orgId, biz.id, ilInvoice.publicId);
const ilHtml = await renderInvoiceHtml(orgId, biz.id, ilInvoice.publicId);
const ilLine = ilDoc?.chargeLines[0];
// What the renderers actually print in the Amount column.
const ilNet = ilLine ? ilLine.amountMinor - ilLine.itemLevelDiscountMinor : 0n;
const ilDetail = ilDoc?.discountDetails[0];
checks.push(
  [
    "item-level: the line carries a non-zero itemLevelDiscountMinor",
    (ilLine?.itemLevelDiscountMinor ?? 0n) > 0n,
  ],
  [
    // The whole point: Σ(printed Amount) IS the Sub Total, with nothing for the reader to
    // add up or subtract. A gross column makes this fail by exactly the discount.
    "item-level: Σ net line amounts === subtotal",
    !!ilDoc &&
      ilDoc.chargeLines.reduce((sum, l) => sum + l.amountMinor - l.itemLevelDiscountMinor, 0n) ===
        ilDoc.totals.subtotalMinor,
  ],
  /**
   * The LAST numeric cell of the line row IS the Amount column. Asserted positionally
   * rather than by searching the document, because on this fixture the gross equals the
   * unit price and the net equals the Sub Total — so "does the HTML contain X" is true
   * for both the right and the wrong answer, and only the cell's position separates them.
   */
  [
    "item-level: the HTML line row's Amount cell is NET",
    (() => {
      const row = ilHtml?.match(/<tr>(?:(?!<\/tr>).)*Pro Plan(?:(?!<\/tr>).)*<\/tr>/s)?.[0] ?? "";
      const nums = [...row.matchAll(/<td class="num">([^<]*)<\/td>/g)].map((m) => m[1]);
      return nums.at(-1) === formatMoney(ilNet, ilDoc!.totals.currency);
    })(),
  ],
  ["item-level: discountDetails names the coupon code", ilDetail?.code === "LINE25"],
  ["item-level: discountDetails source is coupon", ilDetail?.source === "coupon"],
  ["item-level: discountDetails points at line #1", ilDetail?.lineNumbers.join(",") === "1"],
  ["item-level: discountDetails scope is item_level", ilDetail?.scope === "item_level"],
  [
    "item-level: HTML carries a DISCOUNT block naming the code",
    !!ilHtml && ilHtml.includes("LINE25"),
  ],
);

// ── Units / unit price columns ──────────────────────────────────────────────
// UNCONDITIONAL, unlike HSN/SAC and Discount: both print on every invoice, and
// `5 × ₹940.00 = ₹4,700.00` is what makes a line legible. They were in `chargeLines`
// (`quantity`, `unitAmountMinor`) all along and simply never rendered — reported as
// "units missing our invoice pdf".
checks.push(
  ["units column: HTML head present", !!html && html.includes(">Units</th>")],
  ["unit price column: HTML head present", !!html && html.includes(">Unit price</th>")],
  [
    // The heads must sit in this order — Description, [HSN/SAC], Units, Unit price,
    // [Discount], Amount — or the numbers land under the wrong captions.
    "line table head order is Description, Units, Unit price",
    (() => {
      const heads = [...(html ?? "").matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
      const table = heads.slice(heads.indexOf("Description"));
      return table.join("|").startsWith("Description|Units|Unit price");
    })(),
  ],
  [
    "each line prints its quantity and unit price in the HTML",
    doc.chargeLines.every(
      (l) =>
        !!html &&
        html.includes(`<td class="num">${l.quantity}</td>`) &&
        html.includes(
          `<td class="num">${formatMoney(l.unitAmountMinor, doc.totals.currency)}</td>`,
        ),
    ),
  ],
  [
    // The column is only worth anything if the arithmetic it exposes holds: a reader
    // multiplying units by unit price must land on the GROSS line amount.
    "units × unit price reconciles to the gross line amount",
    doc.chargeLines.every((l) => BigInt(l.quantity) * l.unitAmountMinor === l.amountMinor),
  ],
);

// ── 0239 document customization ─────────────────────────────────────────────
// The whole feature turns on ONE promise: a business that has never touched the settings
// screen gets exactly the document it got before the column existed. That is asserted
// first, against the invoice already built above (its `invoice_customization` is null).
//
// Then the same invoice is re-assembled with every switch flipped, so each toggle is
// pinned in BOTH directions — a default-only test would pass against a resolver that
// ignored the column entirely.
const defaultDoc = doc;
checks.push(
  ["0239 default: title is INVOICE", defaultDoc.title === "INVOICE"],
  ["0239 default: customer id shows", defaultDoc.billTo.id === customer.publicId],
  ["0239 default: status shows", defaultDoc.meta.status !== null],
  ["0239 default: subscription id shows", !!defaultDoc.subscription?.id],
  ["0239 default: billing period shows", !!defaultDoc.subscription?.periodStart],
  // The three that were never rendered before 0239 must stay off by default, or every
  // existing invoice changes the day this ships.
  ["0239 default: shipping address OFF", defaultDoc.shipTo.addressLines.length === 0],
  ["0239 default: credit note numbers OFF", defaultDoc.meta.creditNoteNumbers.length === 0],
  ["0239 default: custom fields OFF", defaultDoc.customFields.length === 0],
  ["0239 default: no signature", defaultDoc.signature === null],
  ["0239 default: no payment instructions", defaultDoc.paymentInstructions.length === 0],
  ["0239 default: payments footer shows", defaultDoc.payments.length > 0],
  // The seller is Indian in this fixture, so the tax id is captioned GSTIN. The label is
  // resolved per country precisely so a US or EU seller is not told the same thing.
  ["0239 default: seller tax label is GSTIN for IN", defaultDoc.seller.taxRegLabel === "GSTIN"],
  [
    "0239 default: address is the expanded (multi-line) form",
    defaultDoc.seller.addressLines.length >= 2,
  ],
);

// Numbering FORMAT: the default must reproduce the historical `PREFIX-N` exactly.
checks.push(["0239 default numbering is PREFIX-N", /^INV-\d+$/.test(invoice.number ?? "")]);

await updateBusiness(orgId, biz.publicId, {
  invoiceCustomization: {
    common: {
      show_customer_id: false,
      show_subscription_id: false,
      show_customer_info: false,
      show_shipping_info: true,
      show_payment_stub: false,
      address_format: "single_line",
    },
    signature: { caption: "Authorised by Acme" },
    invoice: {
      title: "tax_invoice",
      show_status: false,
      show_billing_period: false,
      show_next_billing: false,
      show_credit_note_number: true,
      show_custom_fields: true,
    },
  },
});
const offDoc = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
const offPdf = offDoc ? await renderInvoicePdf(offDoc) : null;
const offHtml = await renderInvoiceHtml(orgId, biz.id, invoice.publicId);
checks.push(
  ["0239 flipped: title is TAX INVOICE", offDoc?.title === "TAX INVOICE"],
  ["0239 flipped: customer id hidden", offDoc?.billTo.id === null],
  ["0239 flipped: status hidden", offDoc?.meta.status === null],
  ["0239 flipped: subscription id hidden", offDoc?.subscription?.id === null],
  ["0239 flipped: billing period hidden", offDoc?.subscription?.periodStart === null],
  ["0239 flipped: billing address hidden", offDoc?.billTo.addressLines.length === 0],
  ["0239 flipped: customer tax id hidden", offDoc?.billTo.taxRegId === null],
  ["0239 flipped: payments footer hidden", offDoc?.payments.length === 0],
  ["0239 flipped: signature present", offDoc?.signature?.caption === "Authorised by Acme"],
  // The corner defaults to bottom_right without being asked for — the conventional place
  // for a signature, and the value a merchant who only typed a caption should get.
  [
    "0239 flipped: signature defaults to the bottom-right corner",
    offDoc?.signature?.position === "bottom_right",
  ],
  ["0239 flipped: address collapsed to one line", offDoc?.seller.addressLines.length === 1],
  // ⚠️ The totals ladder must NOT lose the payment: hiding the stub hides the FOOTER,
  // not the arithmetic, or the printed document stops adding up.
  ["0239 flipped: totals still carry amount paid", (offDoc?.totals.amountPaidMinor ?? 0n) > 0n],
  // Both renderers must survive every field being suppressed — a hidden status used to
  // be an empty coloured chip, and a fully-suppressed subscription band a bare heading.
  ["0239 flipped: PDF still renders", !!offPdf && offPdf.subarray(0, 5).toString() === "%PDF-"],
  ["0239 flipped: PDF is non-trivial", (offPdf?.length ?? 0) > 3000],
  ["0239 flipped: HTML still renders", !!offHtml && offHtml.includes("</html>")],
  ["0239 flipped: HTML title says TAX INVOICE", !!offHtml && offHtml.includes(">TAX INVOICE<")],
  ["0239 flipped: HTML drops the Customer ID row", !!offHtml && !offHtml.includes("Customer ID")],
  [
    "0239 flipped: HTML carries the signature caption",
    !!offHtml && offHtml.includes("Authorised by Acme"),
  ],
  [
    "0239 flipped: HTML drops the subscription band",
    !!offHtml && !offHtml.includes(">Subscription<"),
  ],
);

// The other corner, and that the PDF still renders with the footer band pinned there.
await updateBusiness(orgId, biz.publicId, {
  invoiceCustomization: {
    signature: { caption: "Authorised by Acme", position: "bottom_left" },
  },
});
const leftDoc = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
const leftPdf = leftDoc ? await renderInvoicePdf(leftDoc) : null;
const leftHtml = await renderInvoiceHtml(orgId, biz.id, invoice.publicId);
checks.push(
  [
    "0239 signature: bottom_left is carried onto the document",
    leftDoc?.signature?.position === "bottom_left",
  ],
  [
    "0239 signature: PDF renders with the block in the left corner",
    !!leftPdf && leftPdf.subarray(0, 5).toString() === "%PDF-",
  ],
  // The HTML view is a flowing page, so the SIDE is what carries over — asserted through
  // the class the renderer emits rather than through geometry it does not control.
  ["0239 signature: HTML marks the left side", !!leftHtml && leftHtml.includes("signature--left")],
);

// Restore, so anything appended after this block sees the fixture it expects.
await updateBusiness(orgId, biz.publicId, { invoiceCustomization: null });
const restoredDoc = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
checks.push([
  "0239 clearing the column returns the document to its default",
  restoredDoc?.title === "INVOICE" && restoredDoc?.billTo.id === customer.publicId,
]);

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
const passed = checks.length - failed;
console.log("");
console.log(`${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "✅ INVOICE PDF: PASS" : "❌ INVOICE PDF: FAIL");
await closeDb();
process.exit(failed === 0 ? 0 : 1);
