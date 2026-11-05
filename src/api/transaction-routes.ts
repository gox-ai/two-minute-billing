import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { customers, invoices } from "@db/schema";
import { authenticate } from "@/platform/auth";
import { sweepStalePendingCharges } from "@/modules/payments/stale-pending";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  resolveBusiness,
  badRequest,
  notFound,
  parseListQuery,
  listResponse,
  requirePerm,
} from "./helpers";
import {
  listTransactionsPage,
  TRANSACTION_FILTER_OPS,
  TRANSACTION_FILTER_KINDS,
  TRANSACTION_SORT_FIELDS,
  getTransactionDetailed,
  reconcileTransaction,
  serializeTransaction,
  TransactionError,
  type TransactionDetailed,
} from "@/modules/transactions/service";
import { parseRequest } from "./strict-params";

// `success` / `failure` are the deprecated pre-0321 spellings, still accepted.
const reconcileBody = z.object({
  outcome: z.preprocess(
    (v) => (v === "success" ? "succeeded" : v === "failure" ? "failed" : v),
    z.enum(["succeeded", "failed"]),
  ),
});

/**
 * The WHOLE row, not a hand-copied subset.
 *
 * This used to enumerate every extra by name, which meant a field added to
 * `TransactionDetailed` and to the serializer still came out NULL over HTTP until someone
 * remembered to add it here too — and nothing failed to compile, because the extras type is
 * all-optional. Measured 2026-08-26: `gateway_account` and `reference_payment` were loaded,
 * serialized, and silently dropped at exactly this line.
 *
 * `TransactionDetailed` is a superset of the serializer's extras and every reader is
 * `extra?.field`, so passing the row through is equivalent for the existing fields and
 * self-maintaining for new ones.
 */
const serializeDetailed = (r: TransactionDetailed) => serializeTransaction(r.txn, r);

/**
 * `?invoice=` / `?customer=` as internal ids. `{}` when neither was given; `null` when one
 * names nothing in this business — an empty page, never the whole log.
 */
async function transactionScopeIds(
  organizationId: string,
  businessId: string,
  invoicePid: string | undefined,
  customerPid: string | undefined,
): Promise<{ invoiceId?: string; customerId?: string } | null> {
  if (!invoicePid && !customerPid) return {};
  return withTenant(organizationId, async (tx) => {
    const out: { invoiceId?: string; customerId?: string } = {};
    if (invoicePid) {
      const [row] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePid)))
        .limit(1);
      if (!row) return null;
      out.invoiceId = row.id;
    }
    if (customerPid) {
      const [row] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.businessId, businessId), eq(customers.publicId, customerPid)))
        .limit(1);
      if (!row) return null;
      out.customerId = row.id;
    }
    return out;
  });
}

export async function registerTransactionRoutes(app: FastifyInstance) {
  /**
   * List transactions (the money log) — paginated, filtered and sorted
   * server-side (§3.4 of docs/GUIDE.md). Filters: `id`, `type`, `status`,
   * `currency`, `gateway`/`gateway_key`, `gateway_account`, `reference_payment`,
   * `id_at_gateway`, `error_code`, `error_text`, `retriable`, `trace_id`,
   * `amount_minor`, `created_at`, `occurred_at`, `settled_at`, `updated_at`,
   * `customer`, `customer_name`, `customer_email`, `invoice`, `subscription`,
   * `credit_note`, `payment_method_brand`, `payment_method_last4`,
   * `payment_method_type`, `payment_intent`.
   *
   * The legacy flat params (`?type=`, `?status=`, `?gateway=`, `?customer=`,
   * `?invoice=`) still work — the dashboard and SDK use them — and are folded
   * into the same filter set. Any other unrecognised query param is a 400
   * (`parseListQuery`'s `bareParams` allow-list in `helpers.ts`), not a silent no-op.
   */
  app.get(
    "/v1/businesses/:biz/transactions",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: TRANSACTION_FILTER_OPS,
        // The VALUE shape too: without it `?amount_minor[between]=100` (one bound) or
        // `?settled_at[on]=31/08/2026` reached the Postgres cast and surfaced as a 500
        // instead of a 400 that names the shape.
        filterKinds: TRANSACTION_FILTER_KINDS,
        sortFields: TRANSACTION_SORT_FIELDS,
        bareParams: ["type", "status", "gateway", "invoice", "customer"],
      });
      if (!parsed) return;
      const q = req.query as Record<string, string | undefined>;
      const flat: Array<[string, string | undefined]> = [
        ["type", q.type],
        ["status", q.status],
        ["gateway", q.gateway],
      ];
      for (const [field, value] of flat) {
        if (value) parsed.filters.push({ field, op: "is", value });
      }
      // `?invoice=` / `?customer=` resolve to the internal id and filter on the transaction's
      // own FK: as a joined public-id filter the planner walked the whole log newest-first
      // looking for one invoice's rows (~1.8s on production).
      const ids = await transactionScopeIds(
        req.organization!.id,
        business.id,
        q.invoice,
        q.customer,
      );
      if (ids === null)
        return { object: "list", data: [], has_more: false, next_cursor: null, total: 0 };
      const page = await listTransactionsPage(req.organization!.id, business.id, {
        ...parsed,
        ...ids,
      });
      return listResponse(page, serializeDetailed);
    },
  );

  app.get(
    "/v1/businesses/:biz/transactions/:txn",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { txn } = req.params as { txn: string };
      const row = await getTransactionDetailed(req.organization!.id, business.id, txn);
      if (!row) return notFound(reply, "Transaction not found");
      return serializeDetailed(row);
    },
  );

  /**
   * Ask the GATEWAY what became of an in-progress charge, now.
   *
   * ⚠️ NOT `/reconcile`, and the difference is the whole point. That route takes an
   * `outcome` in the body: an operator ASSERTING what happened, which is the last resort
   * for a charge the gateway can no longer answer for. This one asserts nothing — it runs
   * the same poll the billing clock runs and books whatever the gateway says. Putting them
   * side by side in a UI without that distinction would invite someone to "fix" a payment
   * by declaring it succeeded.
   *
   * Runs the real pass scoped to one transaction rather than a second poll-and-settle
   * implementation. Targeting bypasses the grace window and the recently-asked deferral:
   * those are the clock's economy, and an operator pressing this has already decided the
   * gateway call is worth making.
   *
   * `ops`, not `admin`: it books only what the gateway reports, so the blast radius is a
   * gateway read and the settlement that would have happened on the next tick anyway.
   */
  app.post(
    "/v1/businesses/:biz/transactions/:txn/sync",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { txn } = req.params as { txn: string };
      const row = await getTransactionDetailed(req.organization!.id, business.id, txn);
      if (!row) return notFound(reply, "Transaction not found");
      if (row.txn.status !== "in_progress") {
        // 409: the request is fine, the row's state is not. A settled transaction has
        // nothing to ask about, and re-polling one would be a gateway call that can only
        // confirm what we already booked.
        return reply.code(409).send({
          error: {
            type: "invalid_request_error",
            message: `You can sync only an in-progress transaction. This one is '${row.txn.status}'.`,
          },
        });
      }
      const result = await sweepStalePendingCharges(new Date(), { onlyTransactionId: row.txn.id });
      const after = await getTransactionDetailed(req.organization!.id, business.id, txn);
      return {
        object: "transaction_sync",
        // What the gateway said, expressed as what the pass did with it. `unsupported`
        // means this adapter cannot be asked at all — never guessed at.
        outcome:
          result.settled > 0
            ? "settled"
            : result.failed > 0
              ? "failed"
              : result.unsupported > 0
                ? "unsupported"
                : "still_pending",
        transaction: after ? serializeDetailed(after) : null,
      };
    },
  );

  app.post(
    "/v1/transactions/:txn/reconcile",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const { txn } = req.params as { txn: string };
      const parsed = parseRequest(reconcileBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await reconcileTransaction({
          organizationId: req.organization!.id,
          txnPublicId: txn,
          outcome: parsed.data.outcome,
        });
        if (!row) return notFound(reply, "Transaction not found");
        return serializeTransaction(row);
      } catch (e) {
        if (e instanceof TransactionError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );
}
