import type { LineRating } from "@/modules/metering/rating";
import { divHalfUp, FIXED12_SCALE, parseFixed12 } from "@/platform/fixed";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { InvoiceDocument } from "./document";
import { formatMoney, formatDateInTz, formatDateTimeInTz, lineFigures } from "./document";
import { createLogger } from "@/platform/logger";
import { guardedFetch } from "@/platform/egress";

const log = createLogger("invoicing.pdf");

// pdfkit's built-in Helvetica is WinAnsi-only and can't render currency glyphs like ₹
// (U+20B9), so a face has to be bundled and embedded as 'Body'/'Bold'.
//
// NOTO SANS, not DejaVu. DejaVu is ~11% wider and heavier in bold, which made a dense
// invoice read as shouty and pushed long public ids onto a second line; a narrower
// humanist face suits the document. '₹1,234.00' at 10pt measures 45.4pt here against
// DejaVu's 50.9pt.
//
// ⚠️ THE FACE MUST CARRY U+20B9. Liberation Sans was tried first — it is Arial-metric and
// looked right — and it renders the rupee sign as an EMPTY BOX. `widthOfString` does not
// catch that: a missing glyph still advances, so the string measured fine and only a
// rendered page showed the tofu. Check the charset (`fc-query --format='%{charset}'`)
// before swapping this, never the metrics. Bundled under SIL OFL 1.1.
const FONT_DIR = path.join(import.meta.dirname, "assets");
const FONT_REGULAR = path.join(FONT_DIR, "NotoSans-Regular.ttf");
const FONT_BOLD = path.join(FONT_DIR, "NotoSans-Bold.ttf");

/**
 * The logo box the masthead draws into, in points. Rasterisation targets 3× this so the
 * mark stays crisp when the PDF is zoomed or printed.
 */
const LOGO_BOX = { width: 170, height: 48 } as const;

/**
 * One refusal, one log line, one remedy. Returns null so the renderer falls back.
 *
 * The message names the FIX and not just the fact: a merchant reading a support ticket
 * about a missing letterhead needs to know the logo must be re-uploaded as a PNG, which is
 * a different action from "the URL is broken".
 */
function unembeddable(url: string, contentType: string): null {
  log.warn("invoice image is not a format the PDF can embed — no letterhead on this document", {
    url: url.slice(0, 200),
    contentType,
    embeddable: "PNG or JPEG",
    remedy: "upload a PNG or JPEG on Settings → Brand styles",
  });
  return null;
}

/**
 * Best-effort logo loader. pdfkit embeds **PNG and JPEG only**, and that is now the whole
 * list — an SVG is refused rather than converted.
 *
 * ── Why SVG is refused, when it used to be rasterised ───────────────────────
 * It was rasterised through `sharp` precisely because SVG is what merchants uploaded and a
 * dropped logo was silent. That reason is gone: as of 2026-09-09 there is an upload path
 * (`platform/object-store.ts`) that only ever stores PNG/JPEG for a logo or signature, so
 * a merchant has a supported way in. Accepting SVG on the READ side kept a format the org
 * standard rejects (SR-2026-015 — an XML document that can carry script) alive in the one
 * place it was still reachable, and kept `sharp`, a native module, on the invoice path.
 *
 * The cost is named rather than hidden: a business whose `logo_url` still points at an SVG
 * gets **no letterhead** until it uploads a PNG or JPEG, and the warning below says exactly
 * that so the fix is legible from the log alone.
 *
 * Still accepts a `data:` URI as well as an http(s) URL (short timeout), because rows
 * written before the fields were scheme-restricted may hold one. Returns null on anything
 * it cannot draw, so the renderer falls back to the icon and then to the seller name.
 * Never throws.
 */
async function loadLogo(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    if (url.startsWith("data:")) {
      if (/image\/svg/i.test(url.slice(0, 40))) return unembeddable(url, "image/svg+xml");
      const b64 = url.split(",")[1];
      if (!b64) return null;
      return Buffer.from(b64, "base64");
    }
    // Operator-typed URL: no private targets, no redirects (platform/egress.ts).
    const res = await guardedFetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!/png|jpe?g/i.test(ct)) {
      await res.body?.cancel().catch(() => {});
      return unembeddable(url, ct);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    // A missing logo prints the seller's name instead — the invoice is still valid,
    // so this is never fatal, but a business whose logo silently stopped rendering
    // deserves a line explaining why.
    log.warn("invoice image could not be loaded", {
      url: url.slice(0, 200),
      error: (e as Error)?.message,
    });
    return null;
  }
}

/**
 * Status → (label, colour) for the coloured status line under the meta block.
 * Covers BOTH vocabularies, since credit notes share this renderer: invoice
 * statuses (paid/pending/voided/…) and credit-note ones (refund_due/refunded/
 * adjusted). Terminal states render neutral grey, not red — a settled credit
 * note is not an outage.
 */
function statusChip(status: string): { label: string; color: string } {
  switch (status) {
    case "paid":
    case "refunded":
      return { label: status === "paid" ? "PAID" : "REFUNDED", color: "#1a7f37" };
    case "voided":
      return { label: "VOID", color: "#888888" };
    case "adjusted":
      return { label: "ADJUSTED", color: "#888888" };
    case "pending":
      return { label: "PENDING", color: "#9a6700" };
    case "refund_due":
      return { label: "REFUND DUE", color: "#9a6700" };
    default:
      return { label: "NOT PAID", color: "#cf222e" };
  }
}

/**
 * Render an A4 invoice PDF from an assembled {@link InvoiceDocument}.
 * Uses the bundled Noto Sans (embedded as 'Body'/'Bold') so currency symbols like
 * ₹ render correctly — pdfkit's base-14 Helvetica can't encode them.
 * Money is formatted symbol-prefixed (₹1,485.62) and dates in the business
 * timezone; nothing is recomputed here.
 *
 * Layout (mirrors the HTML view in ops.ts):
 *   ┌ logo ─────────────────────────────────── INVOICE ┐
 *   │ seller (name/addr/GSTIN)   Invoice # / Date / Amount / Customer ID / status │
 *   │ ── divider ──                                     │
 *   │ BILLED TO                  SUBSCRIPTION (id/period/next billing)             │
 *   │ ── divider ──                                     │
 *   │ DESCRIPTION [HSN/SAC] UNITS UNIT PRICE [DISCOUNT] AMOUNT (CUR) │  (paginates)
 *   │                         Sub Total … Amount Due    │
 *   │ PAYMENTS: … was paid on … by …                    │
 *   └ support · website ────────────────────────────────┘
 */
/**
 * Wording that differs between an invoice and a credit note. The LAYOUT is
 * deliberately shared: they are the same brand artifact, and forking the
 * renderer would let the two drift apart the first time either is restyled.
 */
export interface DocumentLabels {
  /**
   * Prefix for the meta block: "<prefix> #", "<prefix> Date", "<prefix> Amount".
   *
   * ⚠️ The big word top-right is NOT here — it is `doc.title`, resolved from the
   * business's customization (0239). It moved because it is the one piece of document
   * wording a merchant can change, and a second copy in the caller's labels would let
   * the PDF and the HTML disagree about what the document is called.
   */
  metaPrefix: string;
  /** Bottom-line label — what the reader still owes, or is owed. */
  closing: string;
}

const INVOICE_LABELS: DocumentLabels = {
  metaPrefix: "Invoice",
  closing: "Amount Due",
};

export async function renderInvoicePdf(
  doc: InvoiceDocument,
  labels: DocumentLabels = INVOICE_LABELS,
): Promise<Buffer> {
  // The wordmark first, then the square icon: a mark the customer recognises beats no
  // mark. Both go through the same PNG/JPEG gate, so an SVG icon falls through to the
  // seller's name exactly as before.
  const logo = (await loadLogo(doc.seller.logoUrl)) ?? (await loadLogo(doc.seller.iconUrl));

  // compress:false keeps content streams human-inspectable (support/debugging).
  const pdf = new PDFDocument({ size: "A4", margin: 40, compress: false });
  pdf.registerFont("Body", FONT_REGULAR);
  pdf.registerFont("Bold", FONT_BOLD);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  const cur = doc.totals.currency;
  const tz = doc.seller.timezone;
  const money = (m: bigint) => formatMoney(m, cur);
  const date = (d: Date | null) => formatDateInTz(d, tz);

  const left = pdf.page.margins.left;
  const right = pdf.page.width - pdf.page.margins.right;
  const contentW = right - left;
  const colW = contentW * 0.5; // left column width for the two-column bands
  const metaX = left + contentW * 0.52; // right column start

  // ── Header: logo (or seller name) left · INVOICE right ────────────────────
  const top = pdf.y;
  // The masthead is the logo, or the seller's name set like one. A NULL logoUrl used to
  // draw nothing at all here, so the page opened with a lone right-aligned "INVOICE" and
  // the seller first appeared halfway down. The document opens with the merchant.
  let drewMasthead = false;
  if (logo) {
    try {
      pdf.image(logo, left, top, { fit: [LOGO_BOX.width, LOGO_BOX.height] });
      drewMasthead = true;
    } catch (e) {
      log.warn("invoice logo could not be rendered — falling back to the seller name", {
        error: (e as Error)?.message,
      });
    }
  }
  // No 16pt fallback heading: the masthead is the LOGO alone, with the seller's name set
  // at body size in the block beneath. A big name here wrapped onto two lines and shouted
  // over the document.
  pdf
    .font("Bold")
    .fontSize(20)
    .fillColor("#111111")
    .text(doc.title, left, top, { width: contentW, align: "right" });

  // ── Seller (left) + invoice meta (right) ─────────────────────────────────
  let y = top + (logo ? 62 : 46);
  const sellerTop = y;
  // One ink for the whole party block — the seller name is the same size and weight as
  // the address, not a heading. Grey-on-white body text was the other half of why ours
  // read as a draft.
  pdf
    .font("Body")
    .fontSize(8.5)
    .fillColor("#111111")
    .text(doc.seller.name, left, y, { width: colW, lineGap: 2 });
  for (const l of doc.seller.addressLines) pdf.text(l, { width: colW, lineGap: 2 });
  if (doc.seller.taxRegId) {
    pdf.moveDown(0.5);
    pdf
      .font("Body")
      .fontSize(8.5)
      .fillColor("#111111")
      .text(`${doc.seller.taxRegLabel} : `, { continued: true });
    pdf.font("Bold").text(doc.seller.taxRegId);
  }
  const sellerBottom = pdf.y;

  // Label in ink, value in bold — meta labels are readable text, not the near-white #888
  // ours used, which made half the header disappear on screen.
  const kv = (label: string, value: string) => {
    pdf
      .font("Body")
      .fontSize(8.5)
      .fillColor("#444444")
      .text(label, metaX, undefined, { continued: true, width: right - metaX, lineGap: 3 });
    pdf.font("Bold").fontSize(8.5).fillColor("#111111").text(value);
  };
  // First meta row anchors at the top of the band; the rest flow beneath it.
  pdf
    .font("Body")
    .fontSize(8.5)
    .fillColor("#444444")
    .text(`${labels.metaPrefix} #   `, metaX, sellerTop, {
      continued: true,
      width: right - metaX,
      lineGap: 3,
    });
  pdf.font("Bold").fontSize(8.5).fillColor("#111111").text(doc.meta.number);
  kv(`${labels.metaPrefix} Date   `, date(doc.meta.issuedDate));
  kv(`${labels.metaPrefix} Amount   `, money(doc.totals.totalMinor));
  if (doc.billTo.id) kv("Customer ID   ", doc.billTo.id);
  // A credit note's "Invoice date" — the date of the document being credited. Sits with
  // the invoice reference (`poNumber`) that names it.
  if (doc.meta.relatedInvoiceDate) kv("Invoice Date   ", date(doc.meta.relatedInvoiceDate));
  if (doc.meta.creditNoteNumbers.length)
    kv("Credit Note   ", doc.meta.creditNoteNumbers.join(", "));
  if (doc.meta.exchangeRate) {
    const fx = doc.meta.exchangeRate;
    kv("Exchange Rate   ", `1 ${fx.base} = ${fx.rate} ${fx.currency}`);
  }
  // Suppressed status draws NOTHING, not a blank line: an empty coloured row reads as a
  // rendering fault rather than as a choice.
  if (doc.meta.status) {
    const chip = statusChip(doc.meta.status);
    pdf.moveDown(0.4);
    pdf
      .font("Bold")
      .fontSize(9.5)
      .fillColor(chip.color)
      .text(chip.label, metaX, undefined, { width: right - metaX });
  }
  const metaBottom = pdf.y;

  // A SHORT rule: it separates the seller from the parties without cutting the page in
  // half, which a full-width line did four times over.
  y = Math.max(sellerBottom, metaBottom) + 14;
  pdf
    .moveTo(left, y)
    .lineTo(left + 46, y)
    .strokeColor("#bbbbbb")
    .lineWidth(0.8)
    .stroke();
  y += 16;

  // ── Billed To (left) + Subscription (right) ──────────────────────────────
  const bandTop = y;
  // Section labels get SIZE 7 with tracking rather than 9pt grey. An uppercase micro-label
  // is a label because it is small and spaced, not because it is faint.
  const sectionLabel = (text: string, x: number, yy: number, w: number) =>
    pdf
      .font("Bold")
      .fontSize(7)
      .fillColor("#666666")
      .text(text, x, yy, { width: w, characterSpacing: 0.8 });
  sectionLabel("BILLED TO", left, bandTop, colW);
  pdf.moveDown(0.35);
  pdf
    .font("Body")
    .fontSize(8.5)
    .fillColor("#111111")
    .text(doc.billTo.name, left, undefined, { width: colW, lineGap: 2 });
  for (const l of doc.billTo.addressLines) pdf.text(l, { width: colW, lineGap: 2 });
  if (doc.billTo.email) pdf.text(doc.billTo.email, { width: colW, lineGap: 2 });
  if (doc.billTo.taxRegId)
    pdf.text(`${doc.billTo.taxRegLabel} : ${doc.billTo.taxRegId}`, { width: colW, lineGap: 2 });
  // SHIPPED TO, under the bill-to block in the same column. Only drawn when the business
  // turned the field on AND an address exists, so the band keeps its shape otherwise.
  if (doc.shipTo.name || doc.shipTo.addressLines.length) {
    pdf.moveDown(0.6);
    sectionLabel("SHIPPED TO", left, pdf.y, colW);
    pdf.moveDown(0.35);
    pdf.font("Body").fontSize(8.5).fillColor("#111111");
    if (doc.shipTo.name) pdf.text(doc.shipTo.name, left, undefined, { width: colW, lineGap: 2 });
    for (const l of doc.shipTo.addressLines) pdf.text(l, { width: colW, lineGap: 2 });
  }
  const billBottom = pdf.y;

  let subBottom = bandTop;
  // Every row inside is independently toggleable, so a band with nothing left to say is
  // dropped entirely rather than drawn as a lone "SUBSCRIPTION" heading.
  const subHasContent =
    !!doc.subscription &&
    (!!doc.subscription.id ||
      (!!doc.subscription.periodStart && !!doc.subscription.periodEnd) ||
      !!doc.subscription.nextBillingDate);
  if (doc.subscription && subHasContent) {
    const s = doc.subscription;
    sectionLabel("SUBSCRIPTION", metaX, bandTop, right - metaX);
    pdf.moveDown(0.35);
    const srow = (label: string, value: string) => {
      pdf
        .font("Body")
        .fontSize(8.5)
        .fillColor("#444444")
        .text(label, metaX, undefined, { continued: true, width: right - metaX, lineGap: 3 });
      pdf.font("Bold").fontSize(8.5).fillColor("#111111").text(value);
    };
    if (s.id) srow("ID   ", s.id);
    if (s.periodStart && s.periodEnd)
      srow("Billing Period   ", `${date(s.periodStart)} to ${date(s.periodEnd)}`);
    if (s.nextBillingDate) srow("Next Billing Date   ", date(s.nextBillingDate));
    subBottom = pdf.y;
  }

  y = Math.max(billBottom, subBottom) + 16;

  // ── Merchant-picked custom fields ────────────────────────────────────────
  // Capped at three by the assembler, so this is at most three short rows. Drawn only
  // when non-empty, the same rule the Discount and HSN/SAC columns follow.
  if (doc.customFields.length) {
    for (const f of doc.customFields) {
      pdf
        .font("Body")
        .fontSize(8.5)
        .fillColor("#444444")
        .text(`${f.label}   `, left, y, { continued: true, width: contentW, lineGap: 3 });
      pdf.font("Bold").fontSize(8.5).fillColor("#111111").text(f.value);
      y = pdf.y;
    }
    y += 10;
  }

  // ── Line-item table: Description [| HSN/SAC] | Units | Unit price [| Discount] | Amount ─
  // The DISCOUNT column appears only when some line carries one, so an undiscounted
  // invoice renders exactly as it did before per-line attribution existed (0169) — and
  // a discounted one shows WHICH line was discounted, instead of only an aggregate
  // below the subtotal.
  //
  // HSN/SAC is conditional on exactly the same terms and for the same reason: it is
  // required on an India GST invoice and meaningless everywhere else, so an invoice
  // outside that regime keeps the layout it had. It sits directly after the description
  // because it qualifies the SUPPLY — putting it among the right-aligned money columns
  // would read as an amount.
  const anyLineDiscount = doc.chargeLines.some((l) => l.discountMinor !== 0n);
  const anyTaxCode = doc.chargeLines.some((l) => !!l.taxCode);
  /**
   * UNITS and UNIT PRICE are UNCONDITIONAL, unlike HSN/SAC and DISCOUNT above.
   *
   * Both print on every invoice — they are the columns that make a line legible:
   * `5 × ₹940.00 = ₹4,700.00` answers "why is this the amount" where a lone
   * total does not. Gating them on "some line has a quantity above 1" was the tempting
   * consistent choice and is the wrong one — a quantity of 1 is still the answer to a
   * question the reader is asking, and a column that appears only on some invoices makes
   * the two look like different documents.
   *
   * ⚠️ This DOES change the layout of every existing invoice, deliberately: the data was
   * in `chargeLines` all along (`quantity`, `unitAmountMinor`) and simply never printed.
   */
  const amountColW = contentW * 0.2;
  const amountX = right - amountColW;
  const discColW = anyLineDiscount ? contentW * 0.17 : 0;
  const discX = amountX - discColW;
  const unitPriceColW = contentW * 0.17;
  const unitPriceX = discX - unitPriceColW;
  const unitsColW = contentW * 0.08;
  const unitsX = unitPriceX - unitsColW;
  const sacColW = anyTaxCode ? contentW * 0.12 : 0;
  const sacX = unitsX - sacColW;
  const descW = sacX - left - 8;
  const drawHeader = (yy: number): number => {
    // A rule ABOVE the heads as well as below — the column heads are bracketed, and
    // without the upper line the table had no top edge and floated under the parties.
    pdf
      .moveTo(left, yy - 7)
      .lineTo(right, yy - 7)
      .strokeColor("#cccccc")
      .lineWidth(0.8)
      .stroke();
    pdf.font("Bold").fontSize(7).fillColor("#666666");
    const head = (t: string, x: number, w: number, align: "left" | "right" = "left") =>
      pdf.text(t, x, yy, { width: w, align, characterSpacing: 0.8 });
    head("DESCRIPTION", left, descW);
    if (anyTaxCode) head("HSN/SAC", sacX, sacColW);
    head("UNITS", unitsX, unitsColW, "right");
    head("UNIT PRICE", unitPriceX, unitPriceColW, "right");
    if (anyLineDiscount) head("DISCOUNT", discX, discColW, "right");
    head(`AMOUNT (${cur})`, amountX, amountColW, "right");
    const hb = pdf.y + 8;
    pdf.moveTo(left, hb).lineTo(right, hb).strokeColor("#cccccc").lineWidth(0.8).stroke();
    return hb + 5;
  };
  const bottomLimit = () => pdf.page.height - pdf.page.margins.bottom - 30;

  y = drawHeader(y + 10);
  for (const line of doc.chargeLines) {
    /**
     * Measured in the SAME font it is drawn in. It used to measure in `Body` and draw in
     * `Bold`, which is wider — so a description that Bold wrapped onto an extra line got
     * a row height computed for one line fewer, and its last line printed over the row
     * divider and into the next description.
     *
     * Latent until the UNITS / UNIT PRICE columns narrowed this column from ~56% of the
     * content width to ~27%: wrapping was rare before and is now normal, which is what
     * turned a font mismatch into visible overlap.
     */
    const descH = pdf.font("Bold").fontSize(9.5).heightOfString(line.description, { width: descW });
    const detail = ratingDetail(line.rating ?? null, money);
    const detailH = detail.length * 11;
    const rowH = Math.max(descH, 14) + detailH;
    if (y + rowH > bottomLimit()) {
      pdf.addPage();
      y = drawHeader(pdf.page.margins.top);
    }
    pdf
      .font("Bold")
      .fontSize(9.5)
      .fillColor("#111111")
      .text(line.description, left, y, { width: descW });
    detail.forEach((d, i) => {
      pdf
        .font("Body")
        .fontSize(8)
        .fillColor("#666666")
        .text(d, left + 8, y + Math.max(descH, 14) + i * 11, { width: right - left - 8 });
    });
    if (anyTaxCode) {
      // '—' rather than blank on a line that classifies no supply (discount/tax/rounding),
      // matching how the discount column distinguishes "none" from "not applicable".
      pdf
        .font("Body")
        .fontSize(10)
        .fillColor("#444444")
        .text(line.taxCode ?? "—", sacX, y, { width: sacColW });
    }
    // Quantity and the per-unit rate. Right-aligned with the money columns because both
    // are figures the reader multiplies.
    pdf
      .font("Body")
      .fontSize(9.5)
      .fillColor("#444444")
      .text(lineFigures(line, cur).quantity, unitsX, y, { width: unitsColW, align: "right" });
    pdf
      .font("Body")
      .fontSize(9.5)
      .fillColor("#444444")
      .text(lineFigures(line, cur).unitPrice, unitPriceX, y, {
        width: unitPriceColW,
        align: "right",
      });
    if (anyLineDiscount) {
      // Negative-signed for display; stored positive. A line with no discount prints '—'
      // rather than a 0, which would read as a discount that happened to be nothing.
      pdf
        .font("Body")
        .fontSize(10)
        .fillColor("#444444")
        .text(line.discountMinor === 0n ? "—" : money(-line.discountMinor), discX, y, {
          width: discColW,
          align: "right",
        });
    }
    // NET of the item-level discount, which makes Σ(Amount) = Sub Total readable rather
    // than merely derivable. The
    // document-level stage is NOT folded in: it applies to the subtotal, not to a line,
    // and prints as its own row in the summary below.
    pdf
      .font("Bold")
      .fontSize(9.5)
      .fillColor("#111111")
      .text(money(line.amountMinor - line.itemLevelDiscountMinor), amountX, y, {
        width: amountColW,
        align: "right",
      });
    y += rowH + 12;
    pdf
      .moveTo(left, y - 6)
      .lineTo(right, y - 6)
      .strokeColor("#e5e5e5")
      .lineWidth(0.6)
      .stroke();
  }

  // ── Summary (right-aligned) ──────────────────────────────────────────────
  const t = doc.totals;
  type SumRow = {
    label: string;
    value: bigint;
    muted?: boolean;
    bold?: boolean;
    big?: boolean;
    /** Set on the closing row: drawn smaller than the label. */
    unit?: string;
  };
  // 'Sub Total', two words — the same spelling our HTML renderer uses two files over.
  // The PDF used to disagree with its own sibling.
  const sumRows: SumRow[] = [{ label: "Sub Total", value: t.subtotalMinor }];
  for (const d of doc.discountLines)
    sumRows.push({
      label: d.description || "Discount",
      value: d.amountMinor < 0n ? d.amountMinor : -d.amountMinor,
      muted: true,
    });
  for (const tx of doc.taxLines) sumRows.push({ label: tx.label || "Tax", value: tx.amountMinor });
  if (t.roundingMinor !== 0n) sumRows.push({ label: "Rounding", value: t.roundingMinor });
  sumRows.push({ label: "Total", value: t.totalMinor, bold: true });
  if (t.withholdingMinor !== 0n)
    sumRows.push({ label: "Withholding (TDS)", value: -t.withholdingMinor, muted: true });
  // Promotional credit is PRE-tax and already sits in the discount rows above the
  // Total (2026-08-25) — a row here as well would subtract it twice.
  if (t.creditsApplied.refundable !== 0n)
    sumRows.push({ label: "Refundable credits", value: -t.creditsApplied.refundable, muted: true });
  if (t.creditsApplied.excess !== 0n)
    sumRows.push({ label: "Excess payments", value: -t.creditsApplied.excess, muted: true });
  if (t.amountPaidMinor !== 0n) sumRows.push({ label: "Payments", value: -t.amountPaidMinor });
  /**
   * THE DOCUMENT MUST ADD UP.
   *
   * An IMPORTED invoice carries no credit application — the import adapter reads neither
   * `applied_credits` nor `credits_applied`, and `SourceInvoice` has no field for them —
   * while `amount_due` comes across already net of the credit. So the page showed
   * Total ₹58,054.82 and Amount Due ₹52,414.64 with ₹5,640.18 unexplained between them,
   * which is exactly the arithmetic a reader checks first.
   *
   * The residual is not invented: it is `total − (what the rows above already deduct) −
   * amount due`, all stored values. It is labelled "Credits", and no DATE is claimed for
   * it, because we did not import one.
   */
  const explainedAfterTotal =
    t.withholdingMinor + t.creditsApplied.refundable + t.creditsApplied.excess + t.amountPaidMinor;
  const unexplainedCredit = t.totalMinor - explainedAfterTotal - t.amountDueMinor;
  if (unexplainedCredit > 0n)
    sumRows.push({ label: "Credits", value: -unexplainedCredit, muted: true });
  sumRows.push({ label: labels.closing, unit: cur, value: t.amountDueMinor, big: true });

  /**
   * The summary block:
   *  · labels RIGHT-aligned against the money column, not left-aligned across a gap
   *  · a BREATH before Total rather than a rule above it
   *  · the only rules bracket Amount Due, above and below
   *  · "(CUR)" set smaller than the words beside it
   */
  const amountColRight = right;
  const labelRight = amountX - 12;
  const labelLeft = left + contentW * 0.3;
  if (y + sumRows.length * 17 + 26 > bottomLimit()) {
    pdf.addPage();
    y = pdf.page.margins.top;
  }
  y += 10;
  for (const r of sumRows) {
    // A breath between the tax rows and Total.
    if (r.bold) y += 8;
    if (r.big) {
      y += 10;
      pdf
        .moveTo(labelLeft, y - 4)
        .lineTo(amountColRight, y - 4)
        .strokeColor("#cccccc")
        .lineWidth(0.8)
        .stroke();
    }
    const size = r.big ? 13 : r.bold ? 10 : 9;
    const ink = r.muted ? "#555555" : "#111111";
    pdf
      .font(r.bold || r.big ? "Bold" : "Body")
      .fontSize(size)
      .fillColor(ink);

    // A wrapping label used to be drawn over the row beneath it — the advance was fixed
    // whatever the label measured (a credit note's "Promotional Credits Returned"
    // collided in 2026-08-25). Only the OVERFLOW past the first line is added, so every
    // single-line row keeps its exact advance.
    const labelW = labelRight - labelLeft;
    const extraLines =
      pdf.heightOfString(r.label, { width: labelW }) - pdf.heightOfString("X", { width: labelW });
    if (r.unit) {
      // Two runs, right-aligned together: pdfkit's `align` works on a single run, so the
      // pair is measured and placed by hand. The smaller run is pushed DOWN onto the same
      // baseline — pdfkit anchors text at the TOP of the line box, so without the offset
      // "(INR)" floats above the words it belongs to.
      const unitText = ` (${r.unit})`;
      const unitSize = size - 4;
      pdf.font("Bold").fontSize(size);
      const wMain = pdf.widthOfString(r.label);
      pdf.font("Bold").fontSize(unitSize);
      const wUnit = pdf.widthOfString(unitText);
      const startX = labelRight - (wMain + wUnit);
      pdf.font("Bold").fontSize(size).fillColor(ink).text(r.label, startX, y, { lineBreak: false });
      pdf
        .font("Bold")
        .fontSize(unitSize)
        .fillColor(ink)
        .text(unitText, startX + wMain, y + (size - unitSize) * 0.72, { lineBreak: false });
    } else {
      pdf.text(r.label, labelLeft, y, { width: labelW, align: "right" });
    }
    pdf
      .font(r.bold || r.big ? "Bold" : "Body")
      .fontSize(size)
      .fillColor(ink);
    pdf.text(money(r.value), amountX, y, { width: amountColW, align: "right" });
    y += (r.big ? 20 : 16) + Math.max(0, extraLines);
    if (r.big) {
      pdf
        .moveTo(labelLeft, y + 3)
        .lineTo(amountColRight, y + 3)
        .strokeColor("#cccccc")
        .lineWidth(0.8)
        .stroke();
      y += 8;
    }
  }

  // ── Payments footer + contact ────────────────────────────────────────────
  y = Math.max(y + 8, pdf.y + 8);
  if (doc.payments.length > 0) {
    if (y + doc.payments.length * 14 + 20 > bottomLimit()) {
      pdf.addPage();
      y = pdf.page.margins.top;
    }
    pdf
      .moveTo(left, y)
      .lineTo(left + 46, y)
      .strokeColor("#bbbbbb")
      .lineWidth(0.8)
      .stroke();
    y += 10;
    pdf
      .font("Bold")
      .fontSize(7)
      .fillColor("#666666")
      .text("PAYMENTS", left, y, { width: contentW, characterSpacing: 0.8 });
    y = pdf.y + 3;
    pdf.font("Body").fontSize(8.5).fillColor("#111111");
    for (const p of doc.payments) {
      pdf.text(
        `We received ${money(p.amountMinor)} on ${formatDateTimeInTz(p.paidAt, tz)} through ${p.method}.`,
        left,
        y,
        { width: contentW },
      );
      y = pdf.y + 2;
    }
  }

  // ── Credits footer ───────────────────────────────────────────────────────
  // No date is stated: the buckets carry none, and an imported credit brought no
  // application time with it.
  const creditTotal =
    t.creditsApplied.refundable +
    t.creditsApplied.excess +
    (unexplainedCredit > 0n ? unexplainedCredit : 0n);
  /**
   * DISCOUNT — the only place the printed invoice says WHICH coupon reduced it. The
   * Amount column absorbs the item-level stage and the summary carries the document-level
   * one, so the money always added up; what it never said was why. An item-level coupon
   * left no trace on the document at all.
   *
   * Same block shape as CREDITS below, deliberately — two footnotes about the same
   * invoice should not look like two different kinds of statement.
   */
  if (doc.discountDetails.length > 0) {
    if (y + 34 + doc.discountDetails.length * 12 > bottomLimit()) {
      pdf.addPage();
      y = pdf.page.margins.top;
    }
    pdf
      .moveTo(left, y)
      .lineTo(left + 46, y)
      .strokeColor("#bbbbbb")
      .lineWidth(0.8)
      .stroke();
    y += 10;
    pdf
      .font("Bold")
      .fontSize(7)
      .fillColor("#666666")
      .text("DISCOUNT", left, y, { width: contentW, characterSpacing: 0.8 });
    y = pdf.y + 3;
    pdf.font("Body").fontSize(8.5).fillColor("#111111");
    for (const d of doc.discountDetails) {
      // The percentage is EFFECTIVE — this discount against what those lines cost before
      // it. Not the coupon's configured percent, which is a different number once a fixed
      // amount or a second coupon in the waterfall is involved, and would not reconcile
      // with the figure printed beside it.
      const base = d.lineNumbers.reduce(
        (sum, n) => sum + (doc.chargeLines[n - 1]?.amountMinor ?? 0n),
        0n,
      );
      const pct =
        base > 0n ? ` (${((Number(d.amountMinor) / Number(base)) * 100).toFixed(2)}%)` : "";
      // "Manual discount: Discount" is what the naive join produced — the engine's default
      // invoice name for a manual discount is the word "Discount", so the kind prefix
      // below already says it. Drop the name when it adds nothing.
      const named = d.code ?? (d.label && d.label !== "Discount" ? d.label : null);
      const where =
        d.lineNumbers.length > 0
          ? ` applied on line item${d.lineNumbers.length > 1 ? "s" : ""} ${d.lineNumbers
              .map((n) => `#${n}`)
              .join(", ")}`
          : " applied to this invoice";
      // Named only for a MANUAL discount. A coupon reads as one from its code, and the
      // promotional slice's own label already says what it is — but "Discount − ₹250"
      // with no code looks like a coupon whose name went missing.
      const subject =
        d.source === "manual"
          ? named
            ? `Manual discount ${named}`
            : "Manual discount"
          : (named ?? "Discount");
      pdf.text(`${subject}${where} − ${money(d.amountMinor)}${pct}.`, left, y, {
        width: contentW,
      });
      y = pdf.y + 2;
    }
    y += 2;
  }

  if (creditTotal > 0n) {
    if (y + 34 > bottomLimit()) {
      pdf.addPage();
      y = pdf.page.margins.top;
    }
    pdf
      .moveTo(left, y)
      .lineTo(left + 46, y)
      .strokeColor("#bbbbbb")
      .lineWidth(0.8)
      .stroke();
    y += 10;
    pdf
      .font("Bold")
      .fontSize(7)
      .fillColor("#666666")
      .text("CREDITS", left, y, { width: contentW, characterSpacing: 0.8 });
    y = pdf.y + 3;
    pdf.font("Body").fontSize(8.5).fillColor("#111111");
    pdf.text(`We applied a credit of ${money(creditTotal)} to this invoice.`, left, y, {
      width: contentW,
    });
    y = pdf.y + 2;
  }

  const contact = [doc.seller.supportEmail, doc.seller.website].filter(Boolean).join("   ·   ");
  if (doc.meta.notes) {
    pdf
      .font("Body")
      .fontSize(8.5)
      .fillColor("#666666")
      .text(doc.meta.notes, left, y + 6, { width: contentW });
  }

  // ── Payment instructions ─────────────────────────────────────────────────
  // Where an offline payer sends the money. Empty for every business that has not
  // configured any, so the document is unchanged by default.
  if (doc.paymentInstructions.length > 0) {
    for (const pi of doc.paymentInstructions) {
      const needed = 30 + (pi.description ? 14 : 0) + pi.fields.length * 12;
      if (pdf.y + needed > bottomLimit()) {
        pdf.addPage();
        pdf.y = pdf.page.margins.top;
      }
      let piY = pdf.y + 12;
      pdf
        .moveTo(left, piY)
        .lineTo(left + 46, piY)
        .strokeColor("#bbbbbb")
        .lineWidth(0.8)
        .stroke();
      piY += 10;
      pdf
        .font("Bold")
        .fontSize(7)
        .fillColor("#666666")
        .text(pi.title.toUpperCase(), left, piY, { width: contentW, characterSpacing: 0.8 });
      if (pi.description) {
        pdf
          .font("Body")
          .fontSize(8.5)
          .fillColor("#555555")
          .text(pi.description, left, pdf.y + 3, { width: contentW });
      }
      for (const f of pi.fields) {
        pdf
          .font("Body")
          .fontSize(8.5)
          .fillColor("#444444")
          .text(`${f.label}   `, left, pdf.y + 2, { continued: true, width: contentW });
        pdf.font("Bold").fontSize(8.5).fillColor("#111111").text(f.value);
      }
    }
  }

  /**
   * ── Footer band: signature in a bottom CORNER, contact centred beneath it ──
   *
   * Both are PINNED to the foot of the page rather than following the content flow. A
   * signature that trails the last line signs itself halfway up a short invoice, which is
   * not where a signature belongs on a printed document — and it is what the merchant
   * asked for: "extreme bottom right".
   *
   * The band is measured first, then the flow is checked against it: if the line items
   * already reach into the band, the whole band moves to a fresh page rather than being
   * drawn over them. That check is why the signature is drawn LAST — it needs to know
   * where the content actually ended.
   */
  const pageFloor = () => pdf.page.height - pdf.page.margins.bottom;
  const contactH = contact ? 14 : 0;

  let sigImage: Buffer | null = null;
  if (doc.signature?.imageUrl) sigImage = await loadLogo(doc.signature.imageUrl);

  const sigW = contentW * 0.34;
  const sigImageH = sigImage ? 38 : 0;
  const capH = doc.signature?.caption
    ? pdf.font("Body").fontSize(8.5).heightOfString(doc.signature.caption, { width: sigW })
    : 0;
  const sigBlockH = doc.signature ? sigImageH + (sigImageH && capH ? 4 : 0) + capH : 0;
  // 10pt of air between the last content line and the band, and between band and footer.
  const bandH = sigBlockH + (sigBlockH ? 10 : 0) + contactH;

  if (bandH > 0 && pdf.y + 10 > pageFloor() - bandH) {
    pdf.addPage();
  }

  if (doc.signature) {
    // The corner. `bottom_left` and `bottom_right` differ only in this x and the text
    // alignment, which is the whole reason the setting is one enum rather than a layout.
    const sigX = doc.signature.position === "bottom_left" ? left : right - sigW;
    const align = doc.signature.position === "bottom_left" ? "left" : "right";
    // The same 10pt gap `bandH` reserved above, applied here: without it the caption sat
    // 2pt off the contact line and the two read as one smudged block.
    let sigY = pageFloor() - contactH - 10 - sigBlockH;
    if (sigImage) {
      try {
        // pdfkit's image `align` takes only 'center' | 'right'; left IS the default, so
        // it is expressed by omitting the option rather than by naming it.
        pdf.image(sigImage, sigX, sigY, {
          fit: [sigW, sigImageH],
          ...(align === "right" ? { align: "right" as const } : {}),
        });
        sigY += sigImageH + 4;
      } catch (e) {
        // A signature image that will not embed must not take the caption down with it.
        log.warn("invoice signature image could not be rendered — printing the caption only", {
          error: (e as Error)?.message,
        });
      }
    }
    if (doc.signature.caption) {
      pdf
        .font("Body")
        .fontSize(8.5)
        .fillColor("#444444")
        .text(doc.signature.caption, sigX, sigY, { width: sigW, align });
    }
  }

  if (contact) {
    pdf
      .font("Body")
      .fontSize(8.5)
      .fillColor("#999999")
      .text(contact, left, pageFloor() - contactH + 2, { width: contentW, align: "center" });
  }

  pdf.end();
  return done;
}

/**
 * The rows printed under a usage line: one per tier, then the level for a carried metric.
 * Tier amounts add up to the line amount.
 */
export function ratingDetail(
  rating: LineRating | null,
  money: (minor: bigint) => string,
): string[] {
  if (!rating) return [];
  const n = (v: number | string) => Number(v).toLocaleString("en-US");
  // A meter line's tiers carry `amount` (Fixed12 minor, unrounded) and a decimal rate.
  const tiers = rating.tiers as Array<
    (typeof rating.tiers)[number] & { amount?: string; unit_amount_minor?: number }
  >;
  const rows = tiers.map((t) => {
    const range = t.to == null ? `${n(t.from)} and more` : `${n(t.from)} to ${n(t.to)}`;
    const parts = [
      ...(t.unit_amount_minor ? [`${n(t.units)} × ${money(BigInt(t.unit_amount_minor))}`] : []),
      ...(t.flat_amount_minor ? [`${money(BigInt(t.flat_amount_minor))} flat`] : []),
    ];
    const amount =
      t.amount_minor != null
        ? BigInt(t.amount_minor)
        : divHalfUp(parseFixed12(String(t.amount ?? "0")), FIXED12_SCALE);
    return `Units ${range}: ${parts.join(" + ") || n(t.units)} = ${money(amount)}`;
  });
  if (rating.free_quantity > 0)
    rows.unshift(`Free units: ${n(Math.min(rating.free_quantity, rating.quantity))}`);
  if (rating.level)
    rows.push(
      `Level at period start ${n(rating.level.carried_in)}, highest ${n(rating.level.peak)}, at period end ${n(rating.level.closing)}`,
    );
  return rows;
}
