import type { FastifyInstance, FastifyReply } from "fastify";
import { loadBillingRulesRow, missingReason } from "@/modules/subscriptions/billing-rules-config";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { z } from "zod";
import { LIMITS, clientResultField, httpUrl, redirectUrl } from "./limits";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  listInvoicesPage,
  INVOICE_FILTER_OPS,
  INVOICE_FILTER_KINDS,
  INVOICE_SORT_FIELDS,
  getInvoiceWithLines,
  pendingPaymentsForInvoices,
  PaymentActionRequiredError,
  type InvoiceLineInput,
} from "@/modules/invoicing/service";
import {
  captureRefused,
  consumePaymentIntent,
  getPaymentIntent,
  serializePaymentIntent,
  PaymentIntentConflictError,
  PaymentIntentError,
} from "@/modules/payment-intents/service";
import { getPriceByPublicId } from "@/modules/catalog/service";
import { computeLineAmount } from "@/modules/catalog/pricing";
import {
  createManualInvoice,
  voidInvoice,
  writeOffInvoice,
  regenerateInvoice,
  collectInvoiceNow,
  recordOfflinePayment,
  renderInvoiceHtml,
  updateInvoiceFields,
  applyCreditsToInvoice,
  InvoiceOpsError,
} from "@/modules/invoicing/ops";
import { arBucketValueError } from "@/modules/invoicing/ar-aging";
import { SHORTFALL_CHOICES } from "@/modules/subscriptions/collection-rules-config";
import { OFFLINE_EXCESS_CHOICES } from "@/modules/payments/application-config";
import { listRetriesPage, RETRY_SORT_FIELDS, serializeRetry } from "@/modules/invoicing/retries";
import { assembleInvoiceDocument } from "@/modules/invoicing/document";
import { renderInvoicePdf } from "@/modules/invoicing/invoice-pdf";
import { getDunningJourney, serializeDunningJourney } from "@/modules/invoicing/dunning-journey";
import { closeInvoice } from "@/modules/invoicing/pending";
import { stopDunning, pauseDunning, resumeDunning } from "@/modules/subscriptions/dunning";
import { createComment } from "@/modules/comments/service";
import { withTenant } from "@/platform/db";
import { and, eq } from "drizzle-orm";
import { paymentMethods } from "@db/schema";
import { getCustomerByPublicId } from "@/modules/customers/service";
import { getSubscriptionByPublicId } from "@/modules/subscriptions/service";
import { invoiceRefundGatewayAccount } from "@/modules/credit-notes/service";
import type { invoices } from "@db/schema";
import { serializeInvoice } from "@/modules/invoicing/serialize";
import { DebitInProgressError } from "@/modules/payments/pending-debit";
import { dunningPeriodEndsAt, dunningAnchor } from "@/modules/subscriptions/dunning-schedule";
import {
  resolveBusiness,
  badRequest,
  notFound,
  parseListQuery,
  listResponse,
  requirePerm,
  callerHolds,
  refusedByRateLimit,
} from "./helpers";
import { HOUR_WINDOW_MS } from "@/platform/rate-limit";
import { config } from "@/platform/config";
import { parseRequest } from "./strict-params";

/** An operator note on an invoice action, kept as a comment on the invoice. */
const commentField = z.string().trim().min(1).max(LIMITS.notes).optional();

async function commentOnInvoice(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
  body: string | undefined,
) {
  if (!body) return;
  await createComment({
    organizationId: orgId,
    businessId,
    resourceType: "invoice",
    resourceId: invoicePublicId,
    body,
  });
}

/** Whether `pm_…` is one of this customer's saved payment methods. */
async function customerHasPaymentMethod(orgId: string, customerId: string, pmPublicId: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(
        and(eq(paymentMethods.customerId, customerId), eq(paymentMethods.publicId, pmPublicId)),
      )
      .limit(1);
    return !!row;
  });
}

/** Parse an optional JSON body that these routes accepted empty or absent until now. */
const bodyOf = (b: unknown) => (b && typeof b === "object" ? b : {});

/** 409: a debit is still live on the invoice and its gateway did not cancel it. */
function debitInProgress(reply: FastifyReply, e: DebitInProgressError) {
  return reply
    .code(409)
    .send({ error: { type: "conflict_error", code: e.code, message: e.message } });
}

export async function registerInvoiceRoutes(app: FastifyInstance) {
  /**
   * List invoices — paginated, filtered and sorted server-side (§3.4 of
   * docs/GUIDE.md). Filters, by group (`LIST_FILTERS` in invoicing/service.ts is the
   * authority, and every operator in `INVOICE_FILTER_OPS` comes from the field's kind):
   *
   *   identity   `id`, `number`, `po_number`, `customer`, `customer_name`,
   *              `customer_email`, `subscription`
   *   state      `status`, `dunning_status`, `ar_bucket`, `channel`, `imported`,
   *              `written_off`
   *   money      `subtotal_minor`, `total_minor`, `promotional_discount_minor`,
   *              `credits_applied_minor`, `amount_paid_minor`, `amount_due_minor`,
   *              `withholding_minor`, `attempt_count`
   *   dates      `created_at`, `period_start`, `period_end`, `due_date`, `paid_at`,
   *              `voided_at`, `next_attempt_at`, `dunning_exhausted_at`,
   *              `expected_payment_date`
   *   tax        `seller_state_code`, `place_of_supply_code`, `tax_treatment`, `tax_note`
   *
   * Every money and period field narrows on the expression the response PRINTS, not the
   * stored column, wherever the two differ — `amount_due_minor` is the live balance and
   * `period_end` the inclusive boundary, both derived in SQL (see the `reported*`
   * expressions). `INVOICE_FILTER_KINDS` is what turns a malformed value into a 400 that
   * names the shape instead of a 500 from the Postgres cast.
   *
   * Sort: `created_at` (default, the only keyset path) / `number` / `status` /
   * `subtotal_minor` / `total_minor` / `period_start` / `period_end` / `due_date` /
   * `paid_at`. `?customer=cus_…` and
   * `?subscription=sub_…` are convenience scopes to one customer/subscription —
   * each resolves the public id to its tenant-scoped internal id and filters on
   * the invoice's own FK column (cheaper than the generic `subscription[eq]=`
   * filter, which joins on `subscriptions.public_id`). A neither-of-these bare
   * query param, or any other unrecognised one, is a 400 rather than a silent
   * no-op — a filter that looks accepted but does nothing is worse than an error
   * (`parseListQuery`'s `bareParams` allow-list, at the source in `helpers.ts`).
   */
  app.get(
    "/v1/businesses/:biz/invoices",
    { preHandler: [authenticate, requirePerm("invoices:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: INVOICE_FILTER_OPS,
        filterKinds: INVOICE_FILTER_KINDS,
        sortFields: INVOICE_SORT_FIELDS,
        bareParams: ["customer", "subscription"],
      });
      if (!q) return;
      /**
       * `ar_bucket`'s vocabulary, which `filterKinds` cannot check: the value is a rung NAME,
       * and a name that is not a rung at all would narrow to nothing under a 200. The rung's
       * boundaries come from the name, so a ladder built at any rung width drills through
       * here — what is refused is a name no ladder could print.
       */
      for (const f of q.filters) {
        if (f.field !== "ar_bucket") continue;
        const problem = arBucketValueError(f.op, f.value);
        if (problem) return badRequest(reply, `Invalid value for 'ar_bucket[${f.op}]': ${problem}`);
      }
      let customerId: string | undefined;
      const cusParam = (req.query as { customer?: string }).customer;
      if (cusParam) {
        const cus = await getCustomerByPublicId(req.organization!.id, business.id, cusParam);
        if (!cus) return { object: "list", data: [], has_more: false, next_cursor: null, total: 0 };
        customerId = cus.id;
      }
      let subscriptionId: string | undefined;
      const subParam = (req.query as { subscription?: string }).subscription;
      if (subParam) {
        const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subParam);
        if (!sub) return { object: "list", data: [], has_more: false, next_cursor: null, total: 0 };
        subscriptionId = sub.id;
      }
      const page = await listInvoicesPage(req.organization!.id, business.id, {
        ...q,
        customerId,
        subscriptionId,
      });
      return listResponse(page, (r) =>
        serializeInvoice(r.invoice, {
          biz: business,
          customer: r.customerPublicId,
          subscription: r.subscriptionPublicId,
          paidMinor: r.paidMinor,
          customerName: r.customerName,
          customerEmail: r.customerEmail,
        }),
      );
    },
  );

  // The one gateway account a refund of this invoice goes through (the refund dialogs
  // show its balance). `gateway_account: null` = none, or several took the payments.
  app.get(
    "/v1/businesses/:biz/invoices/:inv/refund_gateway_account",
    { preHandler: [authenticate, requirePerm("invoices:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const inv = (req.params as { inv: string }).inv;
      const acc = await invoiceRefundGatewayAccount(req.organization!.id, business.id, inv);
      if (acc === undefined)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the invoice ${inv}.`,
          },
        });
      return {
        object: "refund_gateway_account",
        invoice: inv,
        gateway_account: acc ? { id: acc.id, label: acc.label, gateway_key: acc.gatewayKey } : null,
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/invoices/:inv",
    { preHandler: [authenticate, requirePerm("invoices:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const invId = (req.params as { inv: string }).inv;
      /**
       * `line_items_limit` / `line_items_offset` page the `lines` array (offset is the
       * `line_items_next_offset` a previous page returned). Absent → every line, as before.
       */
      const lq = req.query as { line_items_limit?: string; line_items_offset?: string };
      let linePage: { limit: number; offset: number } | null = null;
      if (lq.line_items_limit != null || lq.line_items_offset != null) {
        const limit = lq.line_items_limit != null ? Number(lq.line_items_limit) : 100;
        const offset = lq.line_items_offset != null ? Number(lq.line_items_offset) : 0;
        if (!Number.isInteger(limit) || limit < 1 || limit > 300)
          return badRequest(reply, "line_items_limit must be an integer from 1 to 300");
        if (!/^\d+$/.test(lq.line_items_offset ?? "0") || !Number.isSafeInteger(offset))
          return badRequest(reply, "line_items_offset must be a line_items_next_offset value");
        linePage = { limit, offset };
      }
      const found = await getInvoiceWithLines(req.organization!.id, business.id, invId);
      if (!found) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `We could not find the invoice ${invId}.`,
          },
        });
      }
      /**
       * `payment_in_flight` — a debit is already working on this invoice.
       *
       * On the RETRIEVE only, never the list: it is one extra query for one invoice,
       * where a list would pay it per row. The operator screen needs it for the same
       * reason the buyer's does — collection is refused while an attempt is live, so
       * an enabled "Collect now" is a control that cannot do what it says. Unlike the
       * buyer's, the operator's did not even error: it returned 200 with the invoice
       * unchanged, which reads as success.
       */
      const inFlight = await pendingPaymentsForInvoices(req.organization!.id, [found.invoice.id]);
      const view = serializeInvoice(found.invoice, {
        biz: business,
        // The engine's own answer, not the UI's: once the retry offsets are spent, a period
        // still in the future buys one more attempt at the deadline (`scheduleTail`).
        dunningPeriodEndsAt: dunningPeriodEndsAt(
          await withTenant(req.organization!.id, (tx) =>
            loadEffectiveDunningConfig(tx, {
              businessId: business.id,
              customerId: found.invoice.customerId,
              subscriptionId: found.invoice.subscriptionId,
            }),
          ),
          dunningAnchor(found.invoice),
        ),
        customer: found.customerPublicId,
        subscription: found.subscriptionPublicId,
        lines: found.lines,
        discountShares: found.discountShares,
        discountSources: found.discountSources,
        relations: found.relations,
        paidMinor: found.paidMinor,
        customerRow: found.customer,
        showCost: callerHolds(req, "usage_margin:view"),
      });
      const paged =
        linePage && Array.isArray(view.lines)
          ? {
              lines: view.lines.slice(linePage.offset, linePage.offset + linePage.limit),
              line_items_next_offset:
                linePage.offset + linePage.limit < view.lines.length
                  ? String(linePage.offset + linePage.limit)
                  : null,
            }
          : {};
      return {
        ...view,
        ...paged,
        payment_in_flight: inFlight.has(found.invoice.id),
        awaiting_authentication: inFlight.get(found.invoice.id)?.awaitingAuthentication ?? false,
      };
    },
  );

  /**
   * Update the operator-editable fields on an invoice — the "Update PO Number"
   * and "Update address" rail actions.
   *
   * NOTHING HERE TOUCHES MONEY OR THE ENGINE. `po_number` is a buyer reference,
   * `expected_payment_date` is a collections forecast (deliberately NOT
   * `due_date`, which is the contractual term that drives dunning), and the
   * addresses are a per-invoice snapshot. Sending `null` clears a field; omitting
   * it leaves it untouched, so a caller editing only the PO number cannot blank
   * the address by accident.
   */
  const invoiceAddress = z.object({
    first_name: z.string().max(150).nullable().optional(),
    last_name: z.string().max(150).nullable().optional(),
    email: z.string().max(320).nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    company: z.string().max(200).nullable().optional(),
    line1: z.string().max(300).nullable().optional(),
    line2: z.string().max(300).nullable().optional(),
    line3: z.string().max(300).nullable().optional(),
    city: z.string().max(150).nullable().optional(),
    state: z.string().max(150).nullable().optional(),
    state_code: z.string().max(10).nullable().optional(),
    postal_code: z.string().max(30).nullable().optional(),
    country: z.string().length(2).nullable().optional(),
  });
  const invoicePatchBody = z.object({
    po_number: z.string().max(200).nullable().optional(),
    expected_payment_date: z.coerce.date().nullable().optional(),
    billing_address: invoiceAddress.nullable().optional(),
    shipping_address: invoiceAddress.nullable().optional(),
  });
  app.patch(
    "/v1/businesses/:biz/invoices/:inv",
    {
      preHandler: [authenticate, requirePerm("invoices:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(invoicePatchBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const invId = (req.params as { inv: string }).inv;
      try {
        const updated = await updateInvoiceFields(req.organization!.id, business.id, invId, {
          poNumber: parsed.data.po_number,
          expectedPaymentDate: parsed.data.expected_payment_date,
          billingAddress: parsed.data.billing_address,
          shippingAddress: parsed.data.shipping_address,
        });
        if (!updated) return notFound(reply, `We could not find the invoice ${invId}.`);
        return serializeInvoice(updated.invoice, {
          biz: business,
          customer: updated.customerPublicId,
          subscription: updated.subscriptionPublicId,
          lines: updated.lines,
          paidMinor: updated.paidMinor,
          customerRow: updated.customer,
        });
      } catch (e) {
        if (e instanceof InvoiceOpsError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * Invoices under retry — the dashboard's Retries screen.
   *
   * A dedicated read rather than a filter on the invoices list: the useful columns
   * (last error, refusing gateway, failed card, retriability) come from the
   * invoice's latest FAILED transaction, which the dashboard would otherwise have
   * to fetch per row.
   */
  app.get(
    "/v1/businesses/:biz/retries",
    { preHandler: [authenticate, requirePerm("invoices:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as {
        limit?: string;
        starting_after?: string;
        active?: string;
        state?: string;
        "sort_by[asc]"?: string;
        "sort_by[desc]"?: string;
      };
      // Validated against the union, not cast to it: an unknown `state` must fall back to
      // the whole set, never index `RETRY_STATE` with a string the screen made up.
      const state = (["attention", "recovered", "given_up", "all"] as const).find(
        (s) => s === q.state,
      );
      const sortDesc = q["sort_by[desc]"] != null;
      const sortBy = q["sort_by[desc]"] ?? q["sort_by[asc]"];
      const sortField = RETRY_SORT_FIELDS.find((f) => f === sortBy);
      if (sortBy != null && !sortField) {
        return badRequest(
          reply,
          `Cannot sort by '${sortBy}'. Sortable: ${RETRY_SORT_FIELDS.join(", ")}`,
        );
      }
      const page = await listRetriesPage(req.organization!.id, business.id, {
        limit: q.limit ? Number(q.limit) : undefined,
        startingAfter: q.starting_after,
        // `active=true` narrows to retries still moving, which is what a COUNT should mean.
        // The nav badge is its only caller.
        activeOnly: q.active === "true",
        // `state` is what the SCREEN's segments use — a partition of the same set.
        state,
        sortField,
        sortDesc,
      });
      return listResponse(page, serializeRetry);
    },
  );

  // Create a manual / one-off invoice.
  /**
   * A manual-invoice line, in two shapes:
   *  - `price` set   → a catalog **charge-item** line. `amount_minor` is optional; omit
   *                    it and the line is rated from the price.
   *  - `price` unset → an **ad-hoc** line, amount typed by the operator.
   * `period_start`/`period_end` scope the line's service period (revenue recognition).
   */
  const manualLine = z
    .object({
      description: z.string().min(1).max(500).optional(),
      // Non-negative (audit L5). A negative amount used to pass validation and then fail
      // deep in the money path as a 500 on attacker-supplied input. A credit against an
      // invoice is a credit note, never a negative line — so there is no case to admit.
      amount_minor: z.number().int().nonnegative().max(LIMITS.amountMinor).optional(),
      quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
      price: z.string().max(LIMITS.id).min(1).optional(),
      period_start: z.string().datetime().optional(),
      period_end: z.string().datetime().optional(),
    })
    .refine((l) => l.price != null || (l.description != null && l.amount_minor != null), {
      message: "A line needs either `price`, or both `description` and `amount_minor`",
    });
  const manualBody = z.object({
    customer: z.string().max(LIMITS.id).min(1),
    currency: z.string().length(3).optional(),
    lines: z.array(manualLine).min(1),
    collect: z.boolean().default(false),
    net_days: z.number().int().positive().optional(),
    apply_tax: z.boolean().default(false),
    po_number: z.string().max(200).optional(),
    /** With `collect: true`: charge this saved method (`pm_…`) only. */
    payment_method: z.string().max(LIMITS.id).min(1).optional(),
  });
  app.post(
    "/v1/businesses/:biz/invoices",
    {
      preHandler: [authenticate, requirePerm("invoices:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(manualBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const customer = await getCustomerByPublicId(
        req.organization!.id,
        business.id,
        parsed.data.customer,
      );
      if (!customer)
        return notFound(reply, `We could not find the customer ${parsed.data.customer}.`);
      const pm = parsed.data.payment_method;
      if (pm) {
        // Without `collect` nothing is charged, so the method would reach nothing.
        if (!parsed.data.collect)
          return badRequest(reply, "payment_method applies only with collect: true");
        if (!(await customerHasPaymentMethod(req.organization!.id, customer.id, pm)))
          return notFound(reply, `We could not find the payment method ${pm} for this customer.`);
      }
      const currency =
        parsed.data.currency ?? customer.currency ?? business.defaultCurrency ?? "USD";
      // Resolve catalog-priced lines up front so a bad price id fails the whole
      // request before any invoice exists (a partially-built invoice can't be undone
      // without a compensating ledger entry).
      const lines: InvoiceLineInput[] = [];
      for (const l of parsed.data.lines) {
        const period = {
          periodStart: l.period_start ? new Date(l.period_start) : null,
          periodEnd: l.period_end ? new Date(l.period_end) : null,
        };
        if (period.periodStart && period.periodEnd && period.periodEnd < period.periodStart) {
          return badRequest(reply, "period_end cannot be before period_start");
        }
        if (l.price == null) {
          lines.push({
            description: l.description!,
            amountMinor: BigInt(l.amount_minor!),
            quantity: l.quantity,
            kind: "one_time",
            ...period,
          });
          continue;
        }
        const price = await getPriceByPublicId(req.organization!.id, business.id, l.price);
        if (!price) return notFound(reply, `We could not find the price ${l.price}.`);
        if (price.currency !== currency) {
          return badRequest(
            reply,
            `Price ${l.price} is in ${price.currency}, not the invoice currency ${currency}`,
          );
        }
        const quantity = l.quantity ?? 1;
        // An explicit amount still wins — a charge-item's price may be overridden
        // on the invoice — but the default is the catalog's own rated amount.
        const amountMinor =
          l.amount_minor != null
            ? BigInt(l.amount_minor)
            : // A `prices` row already satisfies RatablePrice (see its doc comment).
              computeLineAmount(price, quantity);
        lines.push({
          description: l.description ?? price.name ?? l.price,
          amountMinor,
          quantity,
          priceId: price.id,
          kind: "one_time",
          ...period,
        });
      }
      try {
        const { invoice } = await createManualInvoice({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: customer.id,
          currency,
          lines,
          collect: parsed.data.collect,
          netDays: parsed.data.net_days,
          applyTax: parsed.data.apply_tax,
          country: customer.country,
          state: customer.state,
          ...(parsed.data.po_number ? { poNumber: parsed.data.po_number } : {}),
          ...(pm ? { paymentMethodOverrideId: pm } : {}),
        });
        return reply.code(201).send(serializeInvoice(invoice, { biz: business }));
      } catch (e) {
        if (e instanceof InvoiceOpsError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Invoice lifecycle ops. Every body field is optional: an empty body behaves as before.
  const lifecycle = <B extends z.ZodTypeAny>(
    path: string,
    perm: "invoices:void" | "invoices:manage",
    body: B,
    run: (
      orgId: string,
      bizId: string,
      inv: string,
      b: z.infer<B>,
    ) => Promise<typeof invoices.$inferSelect>,
  ) =>
    app.post(
      path,
      {
        preHandler: [authenticate, requirePerm(perm), idempotency],
        onSend: idempotencyOnSend,
      },
      async (req, reply) => {
        const business = await resolveBusiness(req, reply);
        if (!business) return;
        const parsed = parseRequest(body, bodyOf(req.body));
        if (!parsed.success) return badRequest(reply, parsed.error);
        const invId = (req.params as { inv: string }).inv;
        try {
          const inv = await run(req.organization!.id, business.id, invId, parsed.data);
          await commentOnInvoice(
            req.organization!.id,
            business.id,
            invId,
            (parsed.data as { comment?: string }).comment,
          );
          return serializeInvoice(inv, { biz: business });
        } catch (e) {
          if (e instanceof DebitInProgressError) return debitInProgress(reply, e);
          if (e instanceof InvoiceOpsError) return badRequest(reply, e.message);
          throw e;
        }
      },
    );

  lifecycle(
    "/v1/businesses/:biz/invoices/:inv/void",
    "invoices:void",
    z.object({
      comment: commentField,
      // Free text, stored on the invoice as `void_reason_code`.
      void_reason_code: z.string().trim().min(1).max(100).optional(),
    }),
    async (org, biz, inv, b) => {
      const noReason = missingReason(
        await loadBillingRulesRow(org, biz),
        "void_invoice",
        b.void_reason_code,
      );
      if (noReason) throw new InvoiceOpsError(noReason);
      return voidInvoice(org, biz, inv, {
        voidReasonCode: b.void_reason_code,
        comment: b.comment,
        cancelPendingDebit: true,
      });
    },
  );
  lifecycle(
    "/v1/businesses/:biz/invoices/:inv/write_off",
    "invoices:void",
    z.object({ comment: commentField }),
    (org, biz, inv) => writeOffInvoice(org, biz, inv),
  );

  // Stop / pause / resume dunning (E3).
  lifecycle(
    "/v1/businesses/:biz/invoices/:inv/stop_dunning",
    "invoices:manage",
    z.object({ comment: commentField }),
    (org, biz, inv) => stopDunning(org, biz, inv),
  );
  lifecycle(
    "/v1/businesses/:biz/invoices/:inv/pause_dunning",
    "invoices:manage",
    z.object({ until: z.string().datetime(), comment: commentField }),
    (org, biz, inv, b) => pauseDunning(org, biz, inv, new Date(b.until)),
  );
  // Undo a pause: the retry schedule the pause replaced comes back.
  lifecycle(
    "/v1/businesses/:biz/invoices/:inv/resume_dunning",
    "invoices:manage",
    z.object({ comment: commentField }),
    (org, biz, inv) => resumeDunning(org, biz, inv),
  );

  // Regenerate a voided invoice → a fresh invoice for the same period (E6).
  app.post(
    "/v1/businesses/:biz/invoices/:inv/regenerate",
    {
      preHandler: [authenticate, requirePerm("invoices:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const invId = (req.params as { inv: string }).inv;
      try {
        const { invoice, payment } = await regenerateInvoice(
          req.organization!.id,
          business.id,
          invId,
        );
        return reply.code(201).send({
          ...serializeInvoice(invoice, { biz: business }),
          payment: payment ? { id: payment.publicId, status: payment.status } : null,
        });
      } catch (e) {
        if (e instanceof InvoiceOpsError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Close a pending invoice → finalize (discount/tax/credits/collect) (E2).
  app.post(
    "/v1/businesses/:biz/invoices/:inv/close",
    {
      preHandler: [authenticate, requirePerm("invoices:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const invId = (req.params as { inv: string }).inv;
      const parsed = parseRequest(z.object({ comment: commentField }), bodyOf(req.body));
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const { invoice, payment } = await closeInvoice(req.organization!.id, business.id, invId);
        await commentOnInvoice(req.organization!.id, business.id, invId, parsed.data.comment);
        return {
          ...serializeInvoice(invoice, { biz: business }),
          payment: payment ? { id: payment.publicId, status: payment.status } : null,
        };
      } catch (e) {
        if (e instanceof InvoiceOpsError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Collect now / dunning "retry now" (same action, two names).
  //
  // Three shapes, all optional and all backwards-compatible with an empty body:
  //  - `payment_intent: pi_…` — the buyer already authorized this amount (3DS/UPI
  //    mandate done): CONSUME that intent instead of issuing a bare charge. The
  //    engine's atomic claim is what prevents a double capture, so a concurrent
  //    consume surfaces here as a 409 rather than being re-guarded.
  //  - `on_session: true` — the buyer is present, so a `requires_action` comes back
  //    as a `next_action` to complete, not a dunning failure.
  //  - neither — an operator "Collect now": unchanged, off-session, dunning as before.
  const collectBody = z.object({
    payment_intent: z.string().max(LIMITS.id).min(1).optional(),
    /** What the buyer's browser SDK returned for `payment_intent`'s `mode: 'sdk'` challenge. */
    client_result: clientResultField().optional(),
    on_session: z.boolean().optional(),
    return_url: redirectUrl().optional(),
    cancel_url: redirectUrl().optional(),
    /** Charge this payment method only (one of the invoice customer's; no backups). */
    payment_method_id: z.string().max(LIMITS.id).min(1).optional(),
    comment: commentField,
  });
  for (const verb of ["collect", "retry"]) {
    app.post(
      `/v1/businesses/:biz/invoices/:inv/${verb}`,
      {
        preHandler: [authenticate, requirePerm("invoices:collect"), idempotency],
        onSend: idempotencyOnSend,
      },
      async (req, reply) => {
        const business = await resolveBusiness(req, reply);
        if (!business) return;
        const invId = (req.params as { inv: string }).inv;
        // Every field is optional and this route took no body at all until now, so a
        // caller that posts nothing (or something unrelated) must behave exactly as
        // before rather than start 400ing.
        const parsed = parseRequest(
          collectBody,
          req.body && typeof req.body === "object" ? req.body : {},
        );
        if (!parsed.success) return badRequest(reply, parsed.error);
        // Each call is a real charge attempt at the gateway.
        if (
          (await refusedByRateLimit(
            req,
            reply,
            {
              scope: "invoice_collect",
              keys: [
                {
                  // Scoped to the caller's business: an id alone would let another org use it up.
                  kind: "resource",
                  value: `${business.id}:${invId}`,
                  limit: config.RATE_LIMIT_COLLECTS_PER_INVOICE,
                },
              ],
              windowMs: HOUR_WINDOW_MS,
            },
            "You tried to collect this invoice too many times in one hour. Try again later.",
          )) ||
          (await refusedByRateLimit(
            req,
            reply,
            {
              scope: "invoice_collect_org",
              keys: [
                {
                  kind: "organization",
                  value: req.organization!.id,
                  limit: config.RATE_LIMIT_COLLECTS_PER_ORG,
                },
              ],
            },
            "Too many collection requests. Wait a minute and try again.",
          ))
        )
          return;
        if (parsed.data.payment_method_id && parsed.data.payment_intent)
          return badRequest(
            reply,
            "Pass payment_intent OR payment_method_id, not both. An intent already names its method.",
          );
        try {
          if (parsed.data.payment_intent) {
            const piId = parsed.data.payment_intent;
            const invoice = await getInvoiceWithLines(req.organization!.id, business.id, invId);
            if (!invoice) return notFound(reply, `We could not find the invoice ${invId}.`);
            // Same business (getPaymentIntent is business-scoped) AND same customer:
            // an intent authorized by one buyer must never settle another's invoice.
            const intent = await getPaymentIntent(req.organization!.id, business.id, piId);
            if (!intent) return notFound(reply, `We could not find the payment intent ${piId}.`);
            if (intent.customerId && intent.customerId !== invoice.invoice.customerId) {
              return badRequest(reply, `Payment intent ${piId} belongs to a different customer`);
            }
            /**
             * ── LOSING THE RACE IS NOT A FAILURE ────────────────────────────────────
             *
             * Same race the portal's Pay now hits, and the same fix. Two settlers reach for
             * one intent by design: whoever posts this second leg, and `intent.authorized`
             * reaching `harvestInvoiceIntent` in the inbound webhook — which exists because
             * the browser sometimes never comes back. The webhook side answers `processed`
             * / `ignored` when it loses; this side threw `Intent already consumed` and the
             * operator was shown a 400 for money captured a moment earlier.
             *
             * Reported as the OUTCOME the intent produced, not the collision. Checked BEFORE
             * the consume and caught AROUND it, because the race lands either side of our
             * read. An intent consumed into a DIFFERENT invoice stays a hard 400 — nothing
             * there paid this one.
             */
            const settledElsewhere = async () => {
              if (intent.invoiceId && intent.invoiceId !== invoice.invoice.id) {
                return badRequest(reply, `Payment intent ${piId} paid a different invoice.`);
              }
              const seen = await getInvoiceWithLines(req.organization!.id, business.id, invId);
              const settledInv = seen?.invoice ?? invoice.invoice;
              const view = serializeInvoice(settledInv, { biz: business });
              /**
               * The guard above already refused an intent consumed into a DIFFERENT invoice,
               * so getting here means it was consumed into THIS one — which is settlement,
               * asserted by the settlement itself. It used to re-read the balance instead and
               * could call a paid invoice unpaid; the buyer-portal twin did exactly that to a
               * real customer twice (INV-7849/7850, 3DS India cards). Same treatment here,
               * with the status kept as a second signal for a row that has no intent link.
               */
              const settled =
                settledInv.status === "paid" ||
                settledInv.writtenOff ||
                settledInv.status === "voided";
              return {
                ...view,
                payment_intent: serializePaymentIntent(intent),
                ...(!settled && view.amount_due_minor > 0
                  ? {
                      payment_error: {
                        code: "capture_failed",
                        // All we know here is the balance — see the portal route's twin.
                        message:
                          "This payment did not settle the invoice. There is still an amount due.",
                      },
                    }
                  : {}),
              };
            };
            if (intent.status === "consumed") return settledElsewhere();

            let consumed;
            try {
              consumed = await consumePaymentIntent(
                req.organization!.id,
                business.id,
                piId,
                invId,
                parsed.data.client_result ? { clientResult: parsed.data.client_result } : undefined,
              );
            } catch (e) {
              // Only the collision. Voided / expired / amount-mismatch stay genuine 400s
              // and fall through to the outer catch unchanged.
              if (e instanceof PaymentIntentConflictError) return settledElsewhere();
              if (e instanceof PaymentIntentError && /already consumed/i.test(e.message))
                return settledElsewhere();
              throw e;
            }
            if (!consumed) return notFound(reply, `We could not find the payment intent ${piId}.`);
            await commentOnInvoice(req.organization!.id, business.id, invId, parsed.data.comment);
            const fresh = await getInvoiceWithLines(req.organization!.id, business.id, invId);
            // No `payment` key on this branch, deliberately: the engine books the
            // capture itself and the invoice's own `status`/`amount_due` above are the
            // settled fact. Inventing a payment stub here would be a field that looks
            // like a payment id and is not one.
            return {
              ...serializeInvoice(fresh?.invoice ?? invoice.invoice, { biz: business }),
              payment_intent: serializePaymentIntent(consumed.intent),
              ...(captureRefused(consumed.charge)
                ? {
                    payment_error: {
                      code: consumed.charge.failure?.code ?? "capture_failed",
                      message:
                        consumed.charge.failure?.message ?? "We could not capture the payment.",
                    },
                  }
                : {}),
            };
          }
          const { invoice, payment } = await collectInvoiceNow(
            req.organization!.id,
            business.id,
            invId,
            {
              ...(parsed.data.on_session ? { session: "on_session" as const } : {}),
              ...(parsed.data.return_url ? { returnUrl: parsed.data.return_url } : {}),
              ...(parsed.data.cancel_url ? { cancelUrl: parsed.data.cancel_url } : {}),
              ...(parsed.data.payment_method_id
                ? { paymentMethodOverrideId: parsed.data.payment_method_id }
                : {}),
              ...(parsed.data.comment ? { comment: parsed.data.comment } : {}),
            },
          );
          await commentOnInvoice(req.organization!.id, business.id, invId, parsed.data.comment);
          return {
            ...serializeInvoice(invoice, { biz: business }),
            payment: payment ? { id: payment.publicId, status: payment.status } : null,
          };
        } catch (e) {
          // On-session challenge: not an error the caller can fix — the buyer completes
          // `next_action` and re-posts with `payment_intent`. 200, because the invoice
          // is untouched and the collection is simply not finished yet.
          if (e instanceof PaymentActionRequiredError) {
            const view = serializePaymentIntent(e.intent);
            return reply.code(200).send({
              object: "invoice_collection",
              invoice: invId,
              status: "action_required",
              payment_intent: view,
              next_action: view.next_action,
            });
          }
          if (e instanceof PaymentIntentConflictError) {
            return reply.code(409).send({
              error: {
                type: "conflict_error",
                code: "payment_intent_conflict",
                message: e.message,
              },
            });
          }
          if (e instanceof PaymentIntentError) return badRequest(reply, e.message);
          if (e instanceof InvoiceOpsError) return badRequest(reply, e.message);
          throw e;
        }
      },
    );
  }

  // Record an offline / manual payment (or mark-paid by omitting amount).
  const payBody = z.object({
    amount_minor: z.number().int().positive().optional(),
    method: z.string().max(50).optional(),
    /** When the money arrived, if not now. Not in the future, not before the invoice. */
    date: z.coerce.date().optional(),
    /** The payer's reference (cheque no., wire ref), kept as the transaction's `id_at_gateway`. */
    reference: z.string().trim().min(1).max(100).optional(),
    comment: commentField,
    /** A part payment's shortfall, for this call. Omitted = the business rule. */
    shortfall: z.enum(SHORTFALL_CHOICES).optional(),
    /** Money above the amount due: kept as credit (omitted) or recorded as returned. */
    excess: z.enum(OFFLINE_EXCESS_CHOICES).optional(),
  });
  app.post(
    "/v1/businesses/:biz/invoices/:inv/pay",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(payBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const invId = (req.params as { inv: string }).inv;
      try {
        const { invoice, payment, excessMinor, excessRefundedMinor } = await recordOfflinePayment({
          organizationId: req.organization!.id,
          businessId: business.id,
          invoicePublicId: invId,
          amountMinor: parsed.data.amount_minor,
          method: parsed.data.method,
          occurredAt: parsed.data.date,
          reference: parsed.data.reference,
          comment: parsed.data.comment,
          ...(parsed.data.shortfall ? { shortfall: parsed.data.shortfall } : {}),
          ...(parsed.data.excess ? { excess: parsed.data.excess } : {}),
        });
        await commentOnInvoice(req.organization!.id, business.id, invId, parsed.data.comment);
        return {
          ...serializeInvoice(invoice, { biz: business }),
          payment: {
            id: payment.publicId,
            status: payment.status,
            amount_minor: Number(payment.amountMinor),
          },
          // Money received above the outstanding balance, credited to the customer's
          // excess-payment bucket rather than applied here. 0 for the normal case.
          excess_credited_minor: excessMinor,
          // Money above the balance recorded as returned to the payer (`excess: refund`).
          excess_refunded_minor: excessRefundedMinor,
        };
      } catch (e) {
        if (e instanceof DebitInProgressError) return debitInProgress(reply, e);
        if (e instanceof InvoiceOpsError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * Apply the customer's credit to THIS invoice, on purpose.
   *
   * Credits and payments apply in ONE action, because our credit lives in buckets rather
   * than in documents. It is the
   * deliberate counterpart to auto-application: it does NOT consult the business's Credits
   * Flexibility grid or the subscription's maxima, because those govern what the engine may
   * do unprompted, and this is an operator saying otherwise. The reasoning is written out in
   * full on `applyCreditsToInvoice`.
   *
   * Three shapes:
   *  - `{}` — apply as much refundable, then excess, as the invoice can absorb;
   *  - `{ amount_minor }` — the same, capped at that much across both buckets;
   *  - `{ refundable_minor?, excess_minor? }` — exact amounts per bucket.
   *
   * An explicit amount that does not fit is REFUSED, not clamped. `promotional_minor` is
   * not a field: promotional credit is pre-tax and cannot be applied to a finalized
   * document without re-cutting its tax.
   */
  const applyCreditsBody = z
    .object({
      refundable_minor: z.number().int().min(0).optional(),
      excess_minor: z.number().int().min(0).optional(),
      amount_minor: z.number().int().positive().optional(),
      comment: z.string().max(LIMITS.notes).optional(),
      /** Draw only from these refundable credit notes, in this order. */
      credit_notes: z
        .array(z.object({ id: z.string().max(LIMITS.id).min(1) }).strict())
        .min(1)
        .max(100)
        .optional(),
    })
    // `.strict()`, alone among our route schemas, and on purpose: zod SILENTLY STRIPS
    // unknown keys, so a caller reaching for `promotional_minor` — the one bucket this
    // action deliberately cannot touch — would otherwise get a 200 reporting an
    // application that ignored the field they cared about. A money route must not accept
    // an instruction it does not carry out.
    .strict();
  app.post(
    "/v1/businesses/:biz/invoices/:inv/apply_credits",
    {
      preHandler: [authenticate, requirePerm("credit_notes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(
        applyCreditsBody,
        req.body && typeof req.body === "object" ? req.body : {},
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const invId = (req.params as { inv: string }).inv;
      // A real 404 for an unknown invoice. The sibling ops surface it as a 400 through
      // InvoiceOpsError; this route is new, so it can answer correctly rather than inherit
      // that.
      const found = await getInvoiceWithLines(req.organization!.id, business.id, invId);
      if (!found) return notFound(reply, `We could not find the invoice ${invId}.`);
      try {
        const applied = await applyCreditsToInvoice({
          organizationId: req.organization!.id,
          businessId: business.id,
          invoicePublicId: invId,
          refundableMinor: parsed.data.refundable_minor,
          excessMinor: parsed.data.excess_minor,
          amountMinor: parsed.data.amount_minor,
          comment: parsed.data.comment,
          ...(parsed.data.credit_notes
            ? { creditNotePublicIds: parsed.data.credit_notes.map((c) => c.id) }
            : {}),
        });
        return {
          ...serializeInvoice(applied.invoice, { biz: business }),
          applied: {
            refundable_minor: Number(applied.appliedRefundableMinor),
            excess_minor: Number(applied.appliedExcessMinor),
            total_minor: Number(applied.appliedRefundableMinor + applied.appliedExcessMinor),
          },
          // What the customer has left in this invoice's currency, so a caller does not have
          // to re-read the customer to show the outcome.
          customer_balance_after: {
            currency: applied.invoice.currency,
            refundable_minor: Number(applied.balanceAfter.refundable),
            excess_minor: Number(applied.balanceAfter.excess),
          },
        };
      } catch (e) {
        if (e instanceof DebitInProgressError) return debitInProgress(reply, e);
        if (e instanceof InvoiceOpsError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Every attempt so far, and what dunning will do next if each retry fails.
  app.get(
    "/v1/businesses/:biz/invoices/:inv/dunning_journey",
    { preHandler: [authenticate, requirePerm("invoices:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const invId = (req.params as { inv: string }).inv;
      const journey = await getDunningJourney({
        organizationId: req.organization!.id,
        business,
        invoicePublicId: invId,
      });
      if (!journey) return notFound(reply, `We could not find the invoice ${invId}.`);
      return serializeDunningJourney(journey);
    },
  );

  // Real PDF invoice (attachment) — assembled document → pdfkit.
  app.get(
    "/v1/businesses/:biz/invoices/:inv/pdf",
    { preHandler: [authenticate, requirePerm("invoices:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const invId = (req.params as { inv: string }).inv;
      // `disposition_type=inline` opens in the browser; the default stays a download.
      const disposition = (req.query as { disposition_type?: string }).disposition_type;
      if (disposition != null && disposition !== "inline" && disposition !== "attachment")
        return badRequest(reply, "disposition_type must be inline or attachment");
      const doc = await assembleInvoiceDocument(req.organization!.id, business.id, invId);
      if (!doc) return notFound(reply, `We could not find the invoice ${invId}.`);
      const buffer = await renderInvoicePdf(doc);
      const filename = `invoice-${(doc.meta.number || invId).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
      return reply
        .header("content-type", "application/pdf")
        .header(
          "content-disposition",
          `${disposition === "inline" ? "inline" : "attachment"}; filename="${filename}"`,
        )
        .send(buffer);
    },
  );

  // Rich, print-friendly HTML invoice (mirrors the PDF). `?print=1` adds the
  // print-mode viewer chrome (paper sheet + toolbar + auto print dialog) that the
  // dashboard's "View / print" action opens; the paper output is the same either way.
  app.get(
    "/v1/businesses/:biz/invoices/:inv/html",
    { preHandler: [authenticate, requirePerm("invoices:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const invId = (req.params as { inv: string }).inv;
      const printParam = (req.query as { print?: string }).print;
      const print = printParam === "1" || printParam === "true";
      const html = await renderInvoiceHtml(req.organization!.id, business.id, invId, { print });
      if (!html) return notFound(reply, `We could not find the invoice ${invId}.`);
      return reply.header("content-type", "text/html; charset=utf-8").send(html);
    },
  );
}
