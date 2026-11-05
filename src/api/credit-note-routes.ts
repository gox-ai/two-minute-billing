import type { FastifyInstance } from "fastify";
import { missingReason } from "@/modules/subscriptions/billing-rules-config";
import { z } from "zod";
import { LIMITS } from "./limits";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  issueAdjustmentCreditNote,
  issueRefundableCreditNote,
  refundCreditNote,
  resolveUnconfirmedCnPayout,
  recordOfflineCnRefund,
  getCreditNoteDetail,
  OFFLINE_REFUND_METHODS,
  voidCreditNote,
  listCreditNotesPage,
  CREDIT_NOTE_FILTER_OPS,
  CREDIT_NOTE_FILTER_KINDS,
  CREDIT_NOTE_SORT_FIELDS,
  creditNoteSpendable,
  CreditNoteError,
} from "@/modules/credit-notes/service";
import { serializeCreditNote } from "@/modules/credit-notes/serialize";
import { getCustomerByPublicId } from "@/modules/customers/service";
import {
  assembleCreditNoteDocument,
  creditNoteTaxLines,
  creditNoteTaxTotal,
} from "@/modules/credit-notes/document";
import { renderInvoicePdf } from "@/modules/invoicing/invoice-pdf";
import {
  resolveBusiness,
  badRequest,
  notFound,
  parseListQuery,
  listResponse,
  requirePerm,
} from "./helpers";
import { parseRequest } from "./strict-params";

/**
 * Status mapping for a `CreditNoteError` raised by a route that ADDRESSES a credit note
 * by its `:cn` path parameter.
 *
 * A credit note that is not in this business is a 404, like every other per-business
 * route; everything else the service refuses ("Only refundable credit notes can be
 * refunded", "Credit note is voided", "Refund amount must be positive", "Refund N
 * exceeds available M", "Cannot void a credit note that has been refunded to cash") is a
 * genuine bad request and stays a 400.
 *
 * Discriminated on `CreditNoteError.code`, not on the message text — the message is what
 * the caller reads, `code` is what the route branches on. Pinned by
 * `scripts/verify-bola.ts`, which asserts these routes answer 404 for a foreign credit-note
 * id AND that no new 400 appears on any sibling.
 */
function creditNoteError(reply: Parameters<typeof badRequest>[0], e: CreditNoteError) {
  if (e.code === "not_found") return notFound(reply, e.message);
  return badRequest(reply, e.message);
}

const REASON_CODES = [
  "write_off",
  "subscription_change",
  "subscription_cancellation",
  "chargeback",
  "other",
] as const;

const createBody = z.object({
  invoice: z.string().max(LIMITS.id).min(1),
  kind: z.enum(["adjustment", "refundable"]),
  reason_code: z.enum(REASON_CODES).optional(),
  reason: z.string().max(500).optional(),
  /** A note to the customer, stored on the credit note. */
  customer_notes: z.string().trim().min(1).max(LIMITS.notes).optional(),
  // `invoice_line_item` is optional but strongly preferred: it is what lets the
  // credit note inherit the credited line's SERVICE PERIOD, printed under each
  // item. Without it the item still books correctly, it just cannot say which
  // period it reversed.
  items: z
    .array(
      z.object({
        description: z.string().max(LIMITS.description).min(1),
        amount_minor: z.number().int().positive(),
        invoice_line_item: z.string().max(LIMITS.id).min(1).optional(),
        // The window this item credits. Omit → the credited line's own period.
        period_start: z.string().datetime().optional(),
        period_end: z.string().datetime().optional(),
      }),
    )
    .max(LIMITS.lineItems)
    .min(1),
});

export async function registerCreditNoteRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/credit_notes",
    {
      preHandler: [authenticate, requirePerm("credit_notes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const noReason = missingReason(business, "create_credit_note", parsed.data.reason_code);
      if (noReason) return badRequest(reply, noReason);
      for (const i of parsed.data.items) {
        if (i.period_start && i.period_end && new Date(i.period_end) < new Date(i.period_start))
          return badRequest(reply, "period_end cannot be before period_start");
      }
      const args = {
        organizationId: req.organization!.id,
        businessId: business.id,
        invoicePublicId: parsed.data.invoice,
        items: parsed.data.items.map((i) => ({
          description: i.description,
          amountMinor: i.amount_minor,
          invoiceLineItemPublicId: i.invoice_line_item ?? null,
          ...(i.period_start ? { periodStart: new Date(i.period_start) } : {}),
          ...(i.period_end ? { periodEnd: new Date(i.period_end) } : {}),
        })),
        reasonCode: parsed.data.reason_code,
        reason: parsed.data.reason,
        ...(parsed.data.customer_notes ? { customerNotes: parsed.data.customer_notes } : {}),
      };
      try {
        const cn =
          parsed.data.kind === "adjustment"
            ? await issueAdjustmentCreditNote(args)
            : await issueRefundableCreditNote(args);
        return reply.code(201).send({
          object: "credit_note",
          id: cn.publicId,
          invoice: parsed.data.invoice,
          kind: cn.kind,
          // The GROSS this note documents, so the create receipt states the same terms the
          // retrieve does. It exceeds the total when a refundable note gives credit grants
          // their share back (a `credit_grants` discount).
          status: cn.status,
          subtotal_minor: Number(cn.subtotalMinor ?? cn.totalMinor),
          total_minor: Number(cn.totalMinor),
          available_minor: Number(creditNoteSpendable(cn)),
          currency: cn.currency,
          // Reported here as well as on the retrieve for the same reason as
          // `subtotal_minor` above: this payload is hand-built rather than run through
          // `serializeCreditNote`, so every field the schema promises has to be added
          // twice or it becomes one that "appears on some responses and not others".
          // Measured 2026-09-02: the row inherited the invoice's rate correctly and the
          // create receipt still reported nothing.
          exchange_rate: cn.exchangeRate ?? null,
          exchange_rate_base: cn.exchangeRateBase ?? null,
          customer_notes: cn.customerNotes ?? null,
        });
      } catch (e) {
        // Create takes its invoice in the BODY, so a missing one is a bad field (400),
        // not a missing addressed resource — the `:cn` routes below are the 404 cases.
        if (e instanceof CreditNoteError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Refund (part of) a refundable credit note to the card / cash.
  app.post(
    "/v1/businesses/:biz/credit_notes/:cn/refund",
    {
      preHandler: [authenticate, requirePerm("credit_notes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      // `reason` was already accepted by the service and simply never exposed.
      const parsed = parseRequest(
        z.object({
          amount_minor: z.number().int().positive().optional(),
          reason: z.string().max(500).optional(),
        }),
        req.body ?? {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const noReason = missingReason(business, "refund", parsed.data.reason);
      if (noReason) return badRequest(reply, noReason);
      try {
        const cn = await refundCreditNote({
          organizationId: req.organization!.id,
          businessId: business.id,
          creditNotePublicId: (req.params as { cn: string }).cn,
          amountMinor: parsed.data.amount_minor,
          reason: parsed.data.reason,
        });
        return {
          object: "credit_note",
          id: cn.publicId,
          status: cn.status,
          refunded_minor: Number(cn.refundedMinor),
          available_minor: Number(creditNoteSpendable(cn)),
        };
      } catch (e) {
        if (e instanceof CreditNoteError) return creditNoteError(reply, e);
        throw e;
      }
    },
  );

  // A payout refund the gateway could not confirm: a person says whether it paid out.
  app.post(
    "/v1/businesses/:biz/credit_notes/:cn/resolve_payout",
    {
      preHandler: [authenticate, requirePerm("credit_notes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(
        z.object({ resolution: z.enum(["return_as_credit", "mark_paid"]) }),
        req.body ?? {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const cn = await resolveUnconfirmedCnPayout({
          organizationId: req.organization!.id,
          businessId: business.id,
          creditNotePublicId: (req.params as { cn: string }).cn,
          resolution: parsed.data.resolution,
        });
        return {
          object: "credit_note",
          id: cn.publicId,
          status: cn.status,
          refunded_minor: Number(cn.refundedMinor),
          available_minor: Number(creditNoteSpendable(cn)),
          payout_unconfirmed_minor: Number(cn.payoutUnconfirmedMinor),
        };
      } catch (e) {
        if (e instanceof CreditNoteError) return creditNoteError(reply, e);
        throw e;
      }
    },
  );

  // Record an OFFLINE refund (cash / check / bank transfer) of a refundable
  // credit note. No gateway call.
  app.post(
    "/v1/businesses/:biz/credit_notes/:cn/record_refund",
    {
      preHandler: [authenticate, requirePerm("credit_notes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(
        z.object({
          amount_minor: z.number().int().positive().optional(),
          method: z.enum(OFFLINE_REFUND_METHODS),
          reference: z.string().max(200).optional(),
          date: z.coerce.date().optional(),
          reason: z.string().max(500).optional(),
        }),
        req.body ?? {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const noReason = missingReason(business, "refund", parsed.data.reason);
      if (noReason) return badRequest(reply, noReason);
      try {
        const cn = await recordOfflineCnRefund({
          organizationId: req.organization!.id,
          businessId: business.id,
          creditNotePublicId: (req.params as { cn: string }).cn,
          amountMinor: parsed.data.amount_minor,
          method: parsed.data.method,
          reference: parsed.data.reference,
          occurredAt: parsed.data.date,
          reason: parsed.data.reason,
        });
        return {
          object: "credit_note",
          id: cn.publicId,
          status: cn.status,
          refunded_minor: Number(cn.refundedMinor),
          available_minor: Number(creditNoteSpendable(cn)),
        };
      } catch (e) {
        if (e instanceof CreditNoteError) return creditNoteError(reply, e);
        throw e;
      }
    },
  );

  // Void a credit note (reverses its ledger; forbidden once refunded/allocated).
  app.post(
    "/v1/businesses/:biz/credit_notes/:cn/void",
    {
      preHandler: [authenticate, requirePerm("credit_notes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      try {
        const cn = await voidCreditNote({
          organizationId: req.organization!.id,
          businessId: business.id,
          creditNotePublicId: (req.params as { cn: string }).cn,
        });
        return { object: "credit_note", id: cn.publicId, status: cn.status };
      } catch (e) {
        if (e instanceof CreditNoteError) return creditNoteError(reply, e);
        throw e;
      }
    },
  );

  /**
   * Credit-note PDF.
   *
   * Shares the invoice renderer with credit-note wording (see DocumentLabels):
   * same layout, so the two documents cannot drift apart visually. The closing
   * line reads "Amount Available", not "Amount Due" — on a credit note the
   * bottom line is what the customer is still owed.
   */
  app.get(
    "/v1/businesses/:biz/credit_notes/:cn/pdf",
    { preHandler: [authenticate, requirePerm("credit_notes:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cnId = (req.params as { cn: string }).cn;
      const doc = await assembleCreditNoteDocument(req.organization!.id, business.id, cnId);
      if (!doc) return notFound(reply, `No such credit note: ${cnId}`);
      // No `title` here: it rides on the document, resolved from the business's
      // customization, so a merchant who chose "REFUND" gets REFUND rather than having
      // it overridden back by the caller.
      const buffer = await renderInvoicePdf(doc, {
        metaPrefix: "Credit Note",
        closing: "Amount Available",
      });
      const filename = `credit-note-${(doc.meta.number || cnId).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="${filename}"`)
        .send(buffer);
    },
  );

  // Single credit note with the Refunds & Allocations timeline.
  app.get(
    "/v1/businesses/:biz/credit_notes/:cn",
    { preHandler: [authenticate, requirePerm("credit_notes:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cnId = (req.params as { cn: string }).cn;
      const detail = await getCreditNoteDetail(req.organization!.id, business.id, cnId);
      if (!detail) {
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such credit note: ${cnId}` },
        });
      }
      return {
        ...serializeCreditNote({ ...detail.view, biz: business }),
        // Cash still reversible through a gateway on this note's invoice. 0 means a
        // gateway refund is impossible (invoice settled by applied credit, or its
        // payments already fully refunded) — the dashboard uses this to offer the
        // gateway control only when it can actually work, instead of failing after
        // the earmark round-trip with a bogus "the gateway declined" message.
        gateway_refundable_minor: Number(detail.gatewayRefundableMinor),
        // `credit_note.discounts[]` (0186). `subtotal_minor` rides on the serializer
        // (list AND detail); this array is DETAIL-ONLY, because it costs its own table read
        // and the invoice read draws the same line for the same reason. Together with
        // `subtotal_minor` they make the note's own arithmetic checkable by a consumer:
        // total_minor = subtotal_minor − Σ discounts[].amount_minor + tax.
        discounts: detail.discounts.map((d) => ({
          object: "credit_note_discount",
          type: d.type,
          amount_minor: Number(d.amountMinor),
          description: d.description ?? null,
        })),
        // The "+ tax" term of that identity, NAMED. A credit note stores neither the
        // amount nor the component names: the amount is the identity rearranged, the names
        // come from the invoice this note references (its `applied_taxes` snapshot), split
        // in the proportion that invoice booked them. Derived by the same two functions the
        // PDF uses — `credit-notes/document.ts` — so a consumer, the dashboard page and the
        // printed memo cannot name the tax three different ways. Detail-only, like
        // `discounts[]`: it costs a second read of the credited invoice's tax rows.
        // Σ amount_minor === total_minor − subtotal_minor + Σ discounts[].amount_minor.
        taxes: (
          await creditNoteTaxLines(
            req.organization!.id,
            detail.view.note.invoiceId,
            creditNoteTaxTotal(detail.view.note, detail.discounts),
          )
        ).map((t) => ({
          object: "credit_note_tax",
          description: t.label,
          amount_minor: Number(t.amountMinor),
        })),
        allocations: detail.allocations.map((a) => ({
          object: "credit_note_allocation",
          invoice: a.invPid,
          amount_minor: Number(a.alloc.amountMinor),
          allocated_at: a.alloc.createdAt,
        })),
        refunds: detail.refundTxns.map((t) => {
          const offline = t.gatewayKey?.startsWith("offline_") ?? false;
          return {
            object: "credit_note_refund",
            transaction: t.publicId,
            status: t.status,
            amount_minor: Number(t.amountMinor),
            currency: t.currency,
            offline,
            method: offline ? t.gatewayKey!.slice("offline_".length) : null,
            gateway_key: offline ? null : t.gatewayKey,
            reference: offline ? t.idAtGateway : null,
            id_at_gateway: offline ? null : t.idAtGateway,
            error_text: t.errorText ?? null,
            occurred_at: t.occurredAt,
          };
        }),
      };
    },
  );

  /**
   * List credit notes — paginated, filtered and sorted server-side (§3.4 of
   * docs/GUIDE.md). Filters: `id`, `number`, `kind`, `status`, `reason_code`,
   * `reason`, `currency`, `channel`, `imported`, `subtotal_minor`, `total_minor`,
   * `allocated_minor`, `refunded_minor`, `available_minor`, `created_at`,
   * `voided_at`, `invoice`, `customer`, `customer_name`, `customer_email`.
   * `?invoice=inv_…` scopes to one invoice, `?customer=cus_…` to one customer —
   * any other unrecognised query param is a 400 (`parseListQuery`'s `bareParams`
   * allow-list in `helpers.ts`), not a silent no-op.
   */
  app.get(
    "/v1/businesses/:biz/credit_notes",
    { preHandler: [authenticate, requirePerm("credit_notes:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: CREDIT_NOTE_FILTER_OPS,
        // The VALUE shape too, not just the field and operator: without it a typo'd
        // `?total_minor[between]=10` or `?voided_at[on]=31/08/2026` reaches Postgres
        // and comes back a 500 instead of a 400 naming the shape.
        filterKinds: CREDIT_NOTE_FILTER_KINDS,
        sortFields: CREDIT_NOTE_SORT_FIELDS,
        bareParams: ["invoice", "customer"],
      });
      if (!q) return;
      const { invoice, customer } = req.query as { invoice?: string; customer?: string };
      let customerId: string | undefined;
      if (customer) {
        const cus = await getCustomerByPublicId(req.organization!.id, business.id, customer);
        if (!cus) return { object: "list", data: [], has_more: false, next_cursor: null, total: 0 };
        customerId = cus.id;
      }
      const page = await listCreditNotesPage(req.organization!.id, business.id, {
        ...q,
        invoicePublicId: invoice,
        customerId,
      });
      // `biz` here for the same reason the detail read passes it: the list loads items too,
      // so without it `line_items[].period_end` came back exclusive from the list and
      // inclusive from the detail — one boundary, two answers, one route apart.
      return listResponse(page, (v) => serializeCreditNote({ ...v, biz: business }));
    },
  );
}
