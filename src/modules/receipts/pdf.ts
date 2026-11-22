import { eq } from "drizzle-orm";
import { businesses } from "@db/schema";
import { withTenant } from "@/platform/db";
import {
  addressCountry,
  bizAddressLines,
  formatDateInTz,
  formatMoney,
  signatureBlock,
  type InvoiceDocument,
} from "@/modules/invoicing/document";
import { resolveInvoiceCustomization, taxRegLabelFor } from "@/modules/invoicing/customization";
import {
  contactLine,
  drawFooterBand,
  drawMasthead,
  loadMasthead,
  openDocumentPdf,
} from "@/modules/invoicing/pdf-branding";
import type { Receipt, ReceiptSnapshot } from "./service";

type Business = typeof businesses.$inferSelect;

export interface ReceiptBranding {
  logoUrl: string | null;
  iconUrl: string | null;
  signature: InvoiceDocument["signature"];
  contact: string;
}

/**
 * The marks a receipt prints. Logo and icon come from the snapshot; a snapshot taken
 * before it carried them falls back to the business's current ones. Signature and
 * contact are always current, as on the invoice.
 */
export function receiptBranding(
  snapBusiness: ReceiptSnapshot["business"],
  current: Pick<
    Business,
    "logoUrl" | "iconUrl" | "supportEmail" | "website" | "invoiceCustomization"
  > | null,
): ReceiptBranding {
  const frozen = "logo_url" in snapBusiness || "icon_url" in snapBusiness;
  return {
    logoUrl: frozen ? (snapBusiness.logo_url ?? null) : (current?.logoUrl ?? null),
    iconUrl: frozen ? (snapBusiness.icon_url ?? null) : (current?.iconUrl ?? null),
    signature: signatureBlock(resolveInvoiceCustomization(current)),
    contact: contactLine(current?.supportEmail ?? null, current?.website ?? null),
  };
}

/**
 * The receipt PDF. Amounts, payer and allocations print from the frozen snapshot only.
 * A record of money received on a date — not a tax invoice, so it prints no tax lines.
 * Reads the business row for the branding, so every caller gets it.
 */
export async function renderReceiptPdf(r: Receipt): Promise<Buffer> {
  const [biz] = await withTenant(r.organizationId, (tx) =>
    tx.select().from(businesses).where(eq(businesses.id, r.businessId)).limit(1),
  );
  const snap = r.snapshot as ReceiptSnapshot;
  return drawReceiptPdf(r, receiptBranding(snap.business, biz ?? null));
}

/** Same type sizes and inks as the invoice wherever the two share an element. */
export async function drawReceiptPdf(r: Receipt, brand: ReceiptBranding): Promise<Buffer> {
  const snap = r.snapshot as ReceiptSnapshot;
  const tz = snap.business.timezone || "UTC";
  const logo = await loadMasthead(brand.logoUrl, brand.iconUrl);
  const { pdf, done } = openDocumentPdf();
  const money = (m: bigint | number) => formatMoney(BigInt(m), r.currency);
  const left = pdf.page.margins.left;
  const right = pdf.page.width - pdf.page.margins.right;
  const contentW = right - left;
  const colW = contentW * 0.5;
  const metaX = left + contentW * 0.52;

  // ── Masthead · RECEIPT ───────────────────────────────────────────────────
  const top = pdf.y;
  drawMasthead(pdf, logo, left, top);
  pdf
    .font("Bold")
    .fontSize(20)
    .fillColor("#111111")
    .text("RECEIPT", left, top, { width: contentW, align: "right" });

  // ── Seller (left) + receipt meta (right) ─────────────────────────────────
  let y = top + (logo ? 62 : 46);
  const sellerTop = y;
  const line = { width: colW, lineGap: 2 };
  pdf.font("Body").fontSize(8.5).fillColor("#111111").text(snap.business.name, left, y, line);
  for (const l of bizAddressLines(snap.business.address)) pdf.text(l, line);
  // The footer already carries the support email when it is set.
  if (snap.business.email && !brand.contact.includes(snap.business.email))
    pdf.text(snap.business.email, line);
  if (snap.business.tax_registration_number) {
    pdf.moveDown(0.5);
    pdf
      .font("Body")
      .fontSize(8.5)
      .fillColor("#111111")
      .text(`${taxRegLabelFor(addressCountry(snap.business.address))} : `, {
        continued: true,
      });
    pdf.font("Bold").text(snap.business.tax_registration_number);
  }
  const sellerBottom = pdf.y;

  const kv = (label: string, value: string, at?: number) => {
    pdf
      .font("Body")
      .fontSize(8.5)
      .fillColor("#444444")
      .text(`${label}   `, metaX, at, { continued: true, width: right - metaX, lineGap: 3 });
    pdf.font("Bold").fontSize(8.5).fillColor("#111111").text(value);
  };
  kv("Receipt #", r.number ?? "Not numbered yet", sellerTop);
  kv("Date Paid", formatDateInTz(r.paidAt, tz));
  kv("Payment Method", snap.method);
  kv("Amount Paid", money(r.amountMinor));
  const metaBottom = pdf.y;

  y = Math.max(sellerBottom, metaBottom) + 14;
  pdf
    .moveTo(left, y)
    .lineTo(left + 46, y)
    .strokeColor("#bbbbbb")
    .lineWidth(0.8)
    .stroke();
  y += 16;

  // ── Received from ────────────────────────────────────────────────────────
  pdf
    .font("Bold")
    .fontSize(7)
    .fillColor("#666666")
    .text("RECEIVED FROM", left, y, { width: colW, characterSpacing: 0.8 });
  pdf.moveDown(0.35);
  pdf.font("Body").fontSize(8.5).fillColor("#111111");
  if (snap.payer.name) pdf.text(snap.payer.name, left, undefined, line);
  for (const l of bizAddressLines(snap.payer.address)) pdf.text(l, left, undefined, line);
  if (snap.payer.email) pdf.text(snap.payer.email, left, undefined, line);
  if (snap.payer.tax_id)
    pdf.text(
      `${taxRegLabelFor(addressCountry(snap.payer.address))} : ${snap.payer.tax_id}`,
      left,
      undefined,
      line,
    );
  y = pdf.y + 16;

  // ── Applied to (paginates) ───────────────────────────────────────────────
  pdf.font("Bold").fontSize(9.5);
  const amountColW = Math.max(
    contentW * 0.2,
    ...snap.allocations.map((a) => pdf.widthOfString(money(a.amount_minor)) + 10),
  );
  const amountX = right - amountColW;
  const descW = amountX - left - 8;
  const drawHeader = (yy: number): number => {
    pdf
      .moveTo(left, yy - 7)
      .lineTo(right, yy - 7)
      .strokeColor("#cccccc")
      .lineWidth(0.8)
      .stroke();
    pdf.font("Bold").fontSize(7).fillColor("#666666");
    pdf.text("APPLIED TO", left, yy, { width: descW, characterSpacing: 0.8 });
    pdf.text(`AMOUNT (${r.currency})`, amountX, yy, {
      width: amountColW,
      align: "right",
      characterSpacing: 0.8,
    });
    const hb = pdf.y + 8;
    pdf.moveTo(left, hb).lineTo(right, hb).strokeColor("#cccccc").lineWidth(0.8).stroke();
    return hb + 5;
  };
  const bottomLimit = () => pdf.page.height - pdf.page.margins.bottom - 30;

  y = drawHeader(y + 10);
  for (const a of snap.allocations) {
    const label = a.invoice
      ? `Invoice ${a.invoice_number ?? a.invoice}`
      : "Customer credit (applies to future invoices)";
    const rowH = Math.max(
      pdf.font("Bold").fontSize(9.5).heightOfString(label, { width: descW }),
      14,
    );
    if (y + rowH > bottomLimit()) {
      pdf.addPage();
      y = drawHeader(pdf.page.margins.top);
    }
    pdf.font("Bold").fontSize(9.5).fillColor("#111111").text(label, left, y, { width: descW });
    pdf.text(money(a.amount_minor), amountX, y, { width: amountColW, align: "right" });
    y += rowH + 12;
    pdf
      .moveTo(left, y - 6)
      .lineTo(right, y - 6)
      .strokeColor("#e5e5e5")
      .lineWidth(0.6)
      .stroke();
  }

  // ── Total paid: the closing row, bracketed like the invoice's Amount Due ─
  if (y + 46 > bottomLimit()) {
    pdf.addPage();
    y = pdf.page.margins.top;
  }
  const labelLeft = left + contentW * 0.3;
  pdf.font("Bold").fontSize(13);
  const sumColW = Math.max(amountColW, pdf.widthOfString(money(r.amountMinor)) + 4);
  const sumX = right - sumColW;
  y += 20;
  pdf
    .moveTo(labelLeft, y - 4)
    .lineTo(right, y - 4)
    .strokeColor("#cccccc")
    .lineWidth(0.8)
    .stroke();
  pdf.fillColor("#111111").text("Total Paid", labelLeft, y, {
    width: sumX - 12 - labelLeft,
    align: "right",
  });
  pdf.text(money(r.amountMinor), sumX, y, { width: sumColW, align: "right" });
  y += 20;
  pdf
    .moveTo(labelLeft, y + 3)
    .lineTo(right, y + 3)
    .strokeColor("#cccccc")
    .lineWidth(0.8)
    .stroke();
  pdf.y = y + 3;

  await drawFooterBand(pdf, { signature: brand.signature, contact: brand.contact });
  pdf.end();
  return done;
}
