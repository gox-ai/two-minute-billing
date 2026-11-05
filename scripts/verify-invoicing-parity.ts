/**
 * Invoice + credit-note fields the dashboard and API depend on (added 2026-08-01).
 *
 * Every assertion here exists because the field was missing or wrong before, and
 * all of them fail SILENTLY in production:
 *  - a serializer key the dashboard reads under a different name renders nothing
 *    (exactly how "Credits applied" was dead from the day it was written — the
 *    page read `applied_credit_minor`, the API emitted `credits_applied_minor`);
 *  - `channel` is derived from ambient context, so it breaks the moment a
 *    creation path forgets it;
 *  - `recordOfflinePayment` wrote the ledger but no `transactions` row, so the
 *    money log disagreed with the ledger and an invoice paid by cash looked
 *    unpaid on the timeline.
 *
 *   pnpm verify:invoicing-parity
 */
import { and, eq } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { runWithEventContext } from "@/platform/event-context";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer, updateCustomer } from "@/modules/customers/service";
import {
  createManualInvoice,
  voidInvoice,
  recordOfflinePayment,
  updateInvoiceFields,
} from "@/modules/invoicing/ops";
import { getInvoiceWithLines } from "@/modules/invoicing/service";
import { serializeInvoice } from "@/modules/invoicing/serialize";
import { issueRefundableCreditNote, getCreditNoteDetail } from "@/modules/credit-notes/service";
import { serializeCreditNote } from "@/modules/credit-notes/serialize";
import { assembleCreditNoteDocument } from "@/modules/credit-notes/document";
import { renderInvoicePdf } from "@/modules/invoicing/invoice-pdf";
import { createComment, listComments, deleteComment } from "@/modules/comments/service";
import { transactions } from "@db/schema";

const org = await createOrganization({ name: "Parity Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "INR",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const checks: Array<[string, boolean]> = [];

const line = (desc: string, amt: number, period?: { start: Date; end: Date }) => ({
  description: desc,
  amountMinor: BigInt(amt),
  kind: "one_time",
  ...(period ? { periodStart: period.start, periodEnd: period.end } : {}),
});

/** Everything runs inside an `api` event context so `currentChannel()` has one. */
await runWithEventContext({ source: "api", actor: "key_verify" }, async () => {
  const customer = await createCustomer({
    ...ctx,
    email: "parity@example.test",
    company: "Parity Co",
    currency: "INR",
  });
  await updateCustomer({
    ...ctx,
    customerPublicId: customer.publicId,
    address: { line1: "1 Test Road", city: "Chennai", state: "Tamil Nadu", country: "IN" },
  });

  // 1) channel + the exact serializer keys the dashboard reads.
  const { invoice } = await createManualInvoice({
    ...ctx,
    customerId: customer.id,
    currency: "INR",
    lines: [line("Parity retainer", 100_000)],
  });
  checks.push(["channel stamped from request provenance", invoice.channel === "api"]);

  const detail0 = await getInvoiceWithLines(orgId, biz.id, invoice.publicId);
  const ser0 = serializeInvoice(detail0!.invoice, {
    customer: detail0!.customerPublicId,
    lines: detail0!.lines,
    paidMinor: detail0!.paidMinor,
    customerRow: detail0!.customer,
    relations: detail0!.relations,
  }) as Record<string, unknown>;
  for (const key of [
    "voided_at",
    "written_off",
    "dunning_status",
    "po_number",
    "expected_payment_date",
    "channel",
    "billing_address",
    "billing_address_is_snapshot",
    "customer_tax_id",
    "shipping_address",
    "credits_applied_minor",
    "amount_paid_minor",
    "customer_name",
    "customer_email",
    // Frozen at issue / change tracking (0336) and the detail read's relations.
    "tax_origin",
    "price_type",
    "notes",
    "net_term_days",
    "finalized_at",
    "updated_at",
    "resource_version",
    "recurring",
    "tax_minor",
    "taxes",
    "first_invoice",
    "amount_adjusted_minor",
    "write_off_amount_minor",
    "adjustment_credit_notes",
    "issued_credit_notes",
    "applied_credits",
    "linked_payments",
  ]) {
    checks.push([`serializer emits \`${key}\``, key in ser0]);
  }
  // Issued invoices freeze the customer's address at issue (0335).
  checks.push([
    "issue takes the snapshot → is_snapshot true",
    ser0.billing_address_is_snapshot === true,
  ]);
  checks.push([
    "the snapshot is the customer's address at issue",
    (ser0.billing_address as { city?: string } | null)?.city === "Chennai",
  ]);

  // 2) PATCH semantics: undefined leaves alone, and one field never clears another.
  await updateInvoiceFields(orgId, biz.id, invoice.publicId, {
    poNumber: "PO-4500123",
    expectedPaymentDate: new Date("2026-09-01T00:00:00Z"),
  });
  const afterPo = await getInvoiceWithLines(orgId, biz.id, invoice.publicId);
  checks.push(["po_number round-trips", afterPo!.invoice.poNumber === "PO-4500123"]);
  checks.push([
    "an edit bumps resource_version and updated_at",
    afterPo!.invoice.resourceVersion > detail0!.invoice.resourceVersion &&
      afterPo!.invoice.updatedAt >= detail0!.invoice.updatedAt,
  ]);
  checks.push(["a manual invoice is not recurring", ser0.recurring === false]);
  checks.push(["the customer's first invoice says so", ser0.first_invoice === true]);
  checks.push(["issue records when it was finalized", ser0.finalized_at != null]);
  checks.push(["expected_payment_date round-trips", afterPo!.invoice.expectedPaymentDate != null]);

  await updateInvoiceFields(orgId, biz.id, invoice.publicId, {
    billingAddress: { line1: "9 Snapshot Way", city: "Mumbai", country: "IN" },
  });
  const afterAddr = await getInvoiceWithLines(orgId, biz.id, invoice.publicId);
  const serAddr = serializeInvoice(afterAddr!.invoice, {
    customerRow: afterAddr!.customer,
  }) as Record<string, unknown>;
  checks.push(["address snapshot taken", serAddr.billing_address_is_snapshot === true]);
  checks.push([
    "snapshot wins over the customer address",
    (serAddr.billing_address as { city?: string }).city === "Mumbai",
  ]);
  checks.push([
    "editing the address did NOT clear the PO number",
    afterAddr!.invoice.poNumber === "PO-4500123",
  ]);

  // 3) Partial offline payment: amount_paid AND the transactions money log.
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    amountMinor: 40_000,
    method: "cash",
  });
  const partly = await getInvoiceWithLines(orgId, biz.id, invoice.publicId);
  const serPaid = serializeInvoice(partly!.invoice, { paidMinor: partly!.paidMinor }) as Record<
    string,
    unknown
  >;
  checks.push([
    "amount_paid_minor reflects the partial payment",
    serPaid.amount_paid_minor === 40_000,
  ]);
  checks.push(["amount_due_minor decremented", serPaid.amount_due_minor === 60_000]);
  checks.push(["a partial payment leaves the invoice open", partly!.invoice.status !== "paid"]);

  const txns = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.businessId, biz.id), eq(transactions.invoiceId, invoice.id))),
  );
  checks.push(["offline payment recorded in the transactions money log", txns.length === 1]);
  checks.push(["offline payment tagged with its method", txns[0]?.gatewayKey === "offline_cash"]);
  const serRel = serializeInvoice(partly!.invoice, { relations: partly!.relations }) as {
    linked_payments?: Array<{ id: string; amount_minor: number; gateway: string | null }>;
  };
  checks.push([
    "linked_payments carries the payment from the money log",
    serRel.linked_payments?.length === 1 &&
      serRel.linked_payments[0]!.amount_minor === 40_000 &&
      serRel.linked_payments[0]!.gateway === "offline_cash",
  ]);

  // 4) Comments.
  const cmt = await createComment({
    ...ctx,
    resourceType: "invoice",
    resourceId: invoice.publicId,
    body: "Chased by email.",
  });
  checks.push(["comment author resolved from context", cmt.author === "key_verify"]);
  checks.push([
    "comment listed against its record",
    (await listComments(orgId, biz.id, "invoice", invoice.publicId)).length === 1,
  ]);
  await deleteComment(orgId, biz.id, cmt.publicId);
  checks.push([
    "comment deleted",
    (await listComments(orgId, biz.id, "invoice", invoice.publicId)).length === 0,
  ]);

  // 5) voided_at is stamped with the status, not left behind.
  const { invoice: toVoid } = await createManualInvoice({
    ...ctx,
    customerId: customer.id,
    currency: "INR",
    lines: [line("To be voided", 5_000)],
  });
  const voided = await voidInvoice(orgId, biz.id, toVoid.publicId);
  checks.push([
    "voided_at stamped with the status",
    voided.status === "voided" && voided.voidedAt != null,
  ]);

  // 6) Credit note: customer exposed, item period inherited, PDF renders.
  const period = { start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-08-31T00:00:00Z") };
  const { invoice: paidInv } = await createManualInvoice({
    ...ctx,
    customerId: customer.id,
    currency: "INR",
    lines: [line("Credited service", 20_000, period)],
  });
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: paidInv.publicId,
    method: "cash",
  });
  const paidDetail = await getInvoiceWithLines(orgId, biz.id, paidInv.publicId);
  const creditedLine = paidDetail!.lines.find((l) => l.line.kind === "one_time")!.line;

  const cn = await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: paidInv.publicId,
    reasonCode: "subscription_change",
    items: [
      {
        description: "Credited service",
        amountMinor: 20_000,
        invoiceLineItemPublicId: creditedLine.publicId,
      },
    ],
  });
  const cnDetail = await getCreditNoteDetail(orgId, biz.id, cn.publicId);
  const serCn = serializeCreditNote(cnDetail!.view) as Record<string, unknown>;
  checks.push(["credit note exposes its customer", serCn.customer === customer.publicId]);
  checks.push(["credit note exposes the customer name", serCn.customer_name === "Parity Co"]);
  checks.push(["credit note channel stamped", serCn.channel === "api"]);
  const creditedDetail = await getInvoiceWithLines(orgId, biz.id, paidInv.publicId);
  const serPaidInv = serializeInvoice(creditedDetail!.invoice, {
    relations: creditedDetail!.relations,
  }) as {
    issued_credit_notes?: Array<{ id: string; total_minor: number }>;
    adjustment_credit_notes?: unknown[];
  };
  checks.push([
    "the invoice lists the refundable note raised against it",
    serPaidInv.issued_credit_notes?.length === 1 &&
      serPaidInv.issued_credit_notes[0]!.id === cn.publicId &&
      serPaidInv.adjustment_credit_notes?.length === 0,
  ]);
  checks.push(["credit note serializer emits `voided_at`", "voided_at" in serCn]);
  checks.push([
    "credit-note item inherited the credited line period",
    (serCn.items as Array<{ period_start: Date | null }>)[0]?.period_start != null,
  ]);

  const doc = await assembleCreditNoteDocument(orgId, biz.id, cn.publicId);
  const pdf = await renderInvoicePdf(doc!, {
    metaPrefix: "Credit Note",
    closing: "Amount Available",
  });
  checks.push(["credit-note title comes from the document", doc!.title === "CREDIT NOTE"]);
  checks.push(["credit-note PDF renders", pdf.length > 3000]);
  checks.push(["credit-note PDF has a PDF header", pdf.subarray(0, 5).toString() === "%PDF-"]);
});

let pass = true;
for (const [name, okFlag] of checks) {
  console.log(`  ${okFlag ? "✓" : "✗"} ${name}`);
  if (!okFlag) pass = false;
}
console.log("");
console.log(pass ? "✅ INVOICING PARITY: PASS" : "❌ INVOICING PARITY: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
