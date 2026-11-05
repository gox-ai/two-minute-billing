/**
 * The billing document a message is ABOUT, rendered as a PDF attachment.
 *
 * Billing notifications carry the invoice and credit-note mail carries the credit note; we
 * attached neither until 0211, and only invoices after it. Shared by the
 * outbox (automatic mail) and adhoc-service (an operator pressing "Send invoice") because the
 * two must not diverge: an operator forwarding a document by hand is the LAST place it would
 * be acceptable for the document to be missing.
 *
 * Rendered at send time rather than stored: a PDF is tens of kilobytes that would otherwise
 * sit in every queued row, and the document can legitimately change between enqueue and send
 * (a payment lands, a credit note applies). The attachment therefore matches the document as
 * it stands when the mail actually leaves.
 */
import type { MailAttachment } from "@/providers/mailer";
import { createLogger } from "@/platform/logger";

const log = createLogger("emails.attachments");

/** Filenames reach a recipient's disk, so strip anything that is not plainly safe there. */
function safeName(prefix: string, name: string): string {
  return `${prefix}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}

/**
 * The invoice PDF, addressed by PUBLIC id.
 *
 * ⚠️ `assembleInvoiceDocument` takes a public id while `email_messages.invoice_id` holds the
 * internal uuid (a real FK). Passing the uuid returns null and sends the mail with no PDF —
 * silently, which is the one outcome this whole area must not have. Callers holding the uuid
 * resolve the public id first; this signature only accepts the public one so the mistake is
 * not expressible here.
 */
export async function invoicePdf(
  organizationId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<MailAttachment[]> {
  // Lazily imported: the emails module is loaded by the event sink at startup, and pulling
  // pdfkit onto that path would cost every process that only ever enqueues mail.
  const { assembleInvoiceDocument } = await import("@/modules/invoicing/document");
  const { renderInvoicePdf } = await import("@/modules/invoicing/invoice-pdf");
  const doc = await assembleInvoiceDocument(organizationId, businessId, invoicePublicId);
  if (!doc) {
    // Send WITHOUT the document rather than stalling the queue for ever on one that is not
    // coming back. The warning is the record that it happened.
    log.warn("[mailer] invoice could not be assembled — sending without the PDF", {
      invoice: invoicePublicId,
    });
    return [];
  }
  return [
    {
      filename: safeName("invoice", doc.meta.number || invoicePublicId),
      content: await renderInvoicePdf(doc),
      contentType: "application/pdf",
    },
  ];
}

/**
 * The credit-note PDF.
 *
 * Same renderer as an invoice with different labels — a credit note's bottom line is what the
 * customer is still OWED, so it reads "Amount Available", not "Amount Due". The labels are
 * repeated from `credit-note-routes.ts` deliberately rather than exported from it: a route
 * module is not a place to import from a send path, and three words are cheaper than the
 * dependency. If they ever gain a fourth field, that is the moment to share them properly.
 */
export async function creditNotePdf(
  organizationId: string,
  businessId: string,
  creditNotePublicId: string,
): Promise<MailAttachment[]> {
  const { assembleCreditNoteDocument } = await import("@/modules/credit-notes/document");
  const { renderInvoicePdf } = await import("@/modules/invoicing/invoice-pdf");
  const doc = await assembleCreditNoteDocument(organizationId, businessId, creditNotePublicId);
  if (!doc) {
    log.warn("[mailer] credit note could not be assembled — sending without the PDF", {
      creditNote: creditNotePublicId,
    });
    return [];
  }
  return [
    {
      filename: safeName("credit-note", doc.meta.number || creditNotePublicId),
      // `title` comes from the document (the merchant's setting), not from here.
      content: await renderInvoicePdf(doc, {
        metaPrefix: "Credit Note",
        closing: "Amount Available",
      }),
      contentType: "application/pdf",
    },
  ];
}

/**
 * The numbered receipt behind a `payment_receipt` mail (0387): the receipt of the payment
 * the event names, or of the payment request it names. No numbered receipt yet → no
 * attachment, never a stall.
 */
export async function receiptPdfForEvent(
  organizationId: string,
  businessId: string,
  eventId: string,
): Promise<MailAttachment[]> {
  const { withTenant } = await import("@/platform/db");
  const { and, desc, eq } = await import("drizzle-orm");
  const { events, payments, paymentRequests, receipts } = await import("@db/schema");
  const row = await withTenant(organizationId, async (tx) => {
    const [ev] = await tx.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!ev) return null;
    const data = (ev.data ?? {}) as Record<string, { id?: unknown } | undefined>;
    if (ev.type === "payment_request_paid") {
      const pid = typeof data.payment_request?.id === "string" ? data.payment_request.id : null;
      if (!pid) return null;
      const [r] = await tx
        .select({ receipt: receipts })
        .from(receipts)
        .innerJoin(paymentRequests, eq(paymentRequests.id, receipts.paymentRequestId))
        .where(and(eq(paymentRequests.businessId, businessId), eq(paymentRequests.publicId, pid)))
        .orderBy(desc(receipts.createdAt))
        .limit(1);
      return r?.receipt ?? null;
    }
    const pid = typeof data.payment?.id === "string" ? data.payment.id : null;
    if (!pid) return null;
    const [r] = await tx
      .select({ receipt: receipts })
      .from(receipts)
      .innerJoin(payments, eq(payments.id, receipts.paymentId))
      .where(and(eq(payments.businessId, businessId), eq(payments.publicId, pid)))
      .limit(1);
    return r?.receipt ?? null;
  });
  // Unnumbered (the batch job runs within seconds) → no attachment rather than a draft.
  if (!row?.number) return [];
  const { renderReceiptPdf } = await import("@/modules/receipts/pdf");
  try {
    return [
      {
        filename: safeName("receipt", row.number ?? row.publicId),
        content: await renderReceiptPdf(row),
        contentType: "application/pdf",
      },
    ];
  } catch (e) {
    log.warn("[mailer] receipt could not be rendered — sending without it", {
      receipt: row.publicId,
      error: (e as Error)?.message,
    });
    return [];
  }
}
