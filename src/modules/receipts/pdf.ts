import path from "node:path";
import PDFDocument from "pdfkit";
import { bizAddressLines, formatDateInTz, formatMoney } from "@/modules/invoicing/document";
import type { Receipt, ReceiptSnapshot } from "./service";

// Same bundled face as the invoice PDF: it carries U+20B9 (see `invoicing/invoice-pdf.ts`).
const FONT_DIR = path.join(import.meta.dirname, "..", "invoicing", "assets");
const FONT_REGULAR = path.join(FONT_DIR, "NotoSans-Regular.ttf");
const FONT_BOLD = path.join(FONT_DIR, "NotoSans-Bold.ttf");

/**
 * The receipt PDF, from the frozen snapshot only. A record of money received on a date —
 * not a tax invoice, so it prints no tax lines.
 */
export async function renderReceiptPdf(r: Receipt): Promise<Buffer> {
  const snap = r.snapshot as ReceiptSnapshot;
  const tz = snap.business.timezone || "UTC";
  const pdf = new PDFDocument({ size: "A4", margin: 40, compress: false });
  pdf.registerFont("Body", FONT_REGULAR);
  pdf.registerFont("Bold", FONT_BOLD);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  const money = (m: bigint | number) => formatMoney(BigInt(m), r.currency);
  const left = pdf.page.margins.left;
  const right = pdf.page.width - pdf.page.margins.right;
  const width = right - left;
  const half = width / 2;

  const top = pdf.y;
  pdf.font("Bold").fontSize(20).fillColor("#111111").text("RECEIPT", left, top, {
    width,
    align: "right",
  });
  pdf
    .font("Bold")
    .fontSize(10)
    .text(snap.business.name, left, top + 4, { width: half });
  pdf.font("Body").fontSize(8.5);
  for (const l of bizAddressLines(snap.business.address)) pdf.text(l, { width: half });
  if (snap.business.tax_registration_number)
    pdf.text(`Tax ID: ${snap.business.tax_registration_number}`, { width: half });
  if (snap.business.email) pdf.text(snap.business.email, { width: half });

  let y = Math.max(pdf.y, top + 40) + 18;
  const meta: Array<[string, string]> = [
    ["Receipt number", r.number ?? "Not numbered yet"],
    ["Date paid", formatDateInTz(r.paidAt, tz)],
    ["Payment method", snap.method],
    ["Amount paid", money(r.amountMinor)],
  ];
  pdf.font("Bold").fontSize(9).text("RECEIVED FROM", left, y, { width: half });
  pdf.font("Body").fontSize(8.5);
  if (snap.payer.name) pdf.text(snap.payer.name, { width: half });
  for (const l of bizAddressLines(snap.payer.address)) pdf.text(l, { width: half });
  if (snap.payer.email) pdf.text(snap.payer.email, { width: half });
  if (snap.payer.tax_id) pdf.text(`Tax ID: ${snap.payer.tax_id}`, { width: half });
  const payerBottom = pdf.y;
  let my = y;
  for (const [k, v] of meta) {
    pdf
      .font("Body")
      .fontSize(8.5)
      .text(k, left + half, my, { width: half / 2 });
    pdf.font("Bold").text(v, left + half + half / 2, my, { width: half / 2, align: "right" });
    my += 14;
  }

  y = Math.max(payerBottom, my) + 24;
  pdf.font("Bold").fontSize(9).text("APPLIED TO", left, y, { width });
  y = pdf.y + 4;
  pdf.moveTo(left, y).lineTo(right, y).strokeColor("#dddddd").stroke();
  y += 6;
  for (const a of snap.allocations) {
    const label = a.invoice
      ? `Invoice ${a.invoice_number ?? a.invoice}`
      : "Customer credit (applies to future invoices)";
    pdf
      .font("Body")
      .fontSize(9)
      .text(label, left, y, { width: width * 0.7 });
    pdf.text(money(a.amount_minor), left + width * 0.7, y, { width: width * 0.3, align: "right" });
    y = pdf.y + 6;
  }
  pdf.moveTo(left, y).lineTo(right, y).strokeColor("#dddddd").stroke();
  y += 8;
  pdf
    .font("Bold")
    .fontSize(10)
    .text("Total paid", left, y, { width: width * 0.7 });
  pdf.text(money(r.amountMinor), left + width * 0.7, y, { width: width * 0.3, align: "right" });
  pdf.end();
  return done;
}
