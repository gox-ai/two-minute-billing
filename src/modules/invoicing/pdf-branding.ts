/**
 * The branding every PDF document shares: fonts, the logo masthead, and the footer band
 * (signature + contact line). Invoices, credit notes and receipts draw through these, so
 * a restyle of one cannot leave the others behind.
 */
import path from "node:path";
import PDFDocument from "pdfkit";
import type { InvoiceDocument } from "./document";
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
 * A new A4 document with 'Body'/'Bold' registered, and the promise of its bytes.
 * compress:false keeps content streams human-inspectable (support/debugging).
 */
export function openDocumentPdf(): { pdf: PDFKit.PDFDocument; done: Promise<Buffer> } {
  const pdf = new PDFDocument({ size: "A4", margin: 40, compress: false });
  pdf.registerFont("Body", FONT_REGULAR);
  pdf.registerFont("Bold", FONT_BOLD);
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  return { pdf, done };
}

/**
 * The logo box the masthead draws into, in points. Rasterisation targets 3× this so the
 * mark stays crisp when the PDF is zoomed or printed.
 */
export const LOGO_BOX = { width: 170, height: 48 } as const;

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
export async function loadLogo(url: string | null): Promise<Buffer | null> {
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
 * The wordmark first, then the square icon: a mark the customer recognises beats no
 * mark. Both go through the same PNG/JPEG gate, so an SVG icon falls through to the
 * seller's name exactly as before.
 */
export async function loadMasthead(
  logoUrl: string | null,
  iconUrl: string | null,
): Promise<Buffer | null> {
  return (await loadLogo(logoUrl)) ?? (await loadLogo(iconUrl));
}

/**
 * The masthead is the LOGO alone, drawn into {@link LOGO_BOX} at (x, y). With no logo it
 * draws nothing: the seller's name prints at body size in the party block beneath, which
 * the caller places lower (`top + 46` against `top + 62`). A big name here wrapped onto
 * two lines and shouted over the document. Returns whether the image was drawn.
 */
export function drawMasthead(
  pdf: PDFKit.PDFDocument,
  logo: Buffer | null,
  x: number,
  y: number,
): boolean {
  if (!logo) return false;
  try {
    pdf.image(logo, x, y, { fit: [LOGO_BOX.width, LOGO_BOX.height] });
    return true;
  } catch (e) {
    log.warn("invoice logo could not be rendered — falling back to the seller name", {
      error: (e as Error)?.message,
    });
    return false;
  }
}

/** "support@… · https://…", or "" when the business has neither. */
export function contactLine(supportEmail: string | null, website: string | null): string {
  return [supportEmail, website].filter(Boolean).join("   ·   ");
}

/**
 * ── Footer band: signature in a bottom CORNER, contact centred beneath it ──
 *
 * Both are PINNED to the foot of the page rather than following the content flow. A
 * signature that trails the last line signs itself halfway up a short invoice, which is
 * not where a signature belongs on a printed document — and it is what the merchant
 * asked for: "extreme bottom right".
 *
 * The band is measured first, then the flow (`pdf.y`) is checked against it: if the
 * content already reaches into the band, the whole band moves to a fresh page rather than
 * being drawn over it. That check is why the band is drawn LAST — it needs to know where
 * the content actually ended.
 */
export async function drawFooterBand(
  pdf: PDFKit.PDFDocument,
  band: { signature: InvoiceDocument["signature"]; contact: string },
): Promise<void> {
  const { signature, contact } = band;
  const left = pdf.page.margins.left;
  const right = pdf.page.width - pdf.page.margins.right;
  const contentW = right - left;
  const pageFloor = () => pdf.page.height - pdf.page.margins.bottom;
  const contactH = contact ? 14 : 0;

  let sigImage: Buffer | null = null;
  if (signature?.imageUrl) sigImage = await loadLogo(signature.imageUrl);

  const sigW = contentW * 0.34;
  const sigImageH = sigImage ? 38 : 0;
  const capH = signature?.caption
    ? pdf.font("Body").fontSize(8.5).heightOfString(signature.caption, { width: sigW })
    : 0;
  const sigBlockH = signature ? sigImageH + (sigImageH && capH ? 4 : 0) + capH : 0;
  // 10pt of air between the last content line and the band, and between band and footer.
  const bandH = sigBlockH + (sigBlockH ? 10 : 0) + contactH;

  if (bandH > 0 && pdf.y + 10 > pageFloor() - bandH) {
    pdf.addPage();
  }

  if (signature) {
    // The corner. `bottom_left` and `bottom_right` differ only in this x and the text
    // alignment, which is the whole reason the setting is one enum rather than a layout.
    const sigX = signature.position === "bottom_left" ? left : right - sigW;
    const align = signature.position === "bottom_left" ? "left" : "right";
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
    if (signature.caption) {
      pdf
        .font("Body")
        .fontSize(8.5)
        .fillColor("#444444")
        .text(signature.caption, sigX, sigY, { width: sigW, align });
    }
  }

  if (contact) {
    pdf
      .font("Body")
      .fontSize(8.5)
      .fillColor("#999999")
      .text(contact, left, pageFloor() - contactH + 2, { width: contentW, align: "center" });
  }
}
