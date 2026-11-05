import type { FastifyInstance } from "fastify";
import { authenticate } from "@/platform/auth";
import { kindsFromSpecs, opsFromSpecs } from "@/platform/list-query";
import { listResponse, notFound, parseListQuery, resolveBusiness, requirePerm } from "./helpers";
import {
  getReceipt,
  listReceiptsPage,
  RECEIPT_FILTER_SPECS,
  RECEIPT_SORT_FIELDS,
  serializeReceiptRow,
} from "@/modules/receipts/service";
import { renderReceiptPdf } from "@/modules/receipts/pdf";

/** Receipts (0387): read-only. A receipt is created by the payment, never by a caller. */
export async function registerReceiptRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses/:biz/receipts",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseListQuery(req, reply, {
        filterOps: opsFromSpecs(RECEIPT_FILTER_SPECS),
        filterKinds: kindsFromSpecs(RECEIPT_FILTER_SPECS),
        sortFields: RECEIPT_SORT_FIELDS,
        bareParams: ["customer", "payment", "payment_request", "invoice"],
        includeDeleted: "none",
      });
      if (!q) return;
      const bare = req.query as Record<string, string | undefined>;
      const page = await listReceiptsPage(req.organization!.id, business.id, {
        customerPublicId: bare.customer,
        paymentPublicId: bare.payment,
        paymentRequestPublicId: bare.payment_request,
        invoicePublicId: bare.invoice,
        filters: q.filters,
        search: q.search,
        startingAfter: q.startingAfter,
        limit: q.limit,
        sortDesc: q.sortDesc,
        tz: business.timezone ?? "UTC",
      });
      return listResponse(page, serializeReceiptRow);
    },
  );

  app.get(
    "/v1/businesses/:biz/receipts/:rcpt",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { rcpt } = req.params as { rcpt: string };
      const row = await getReceipt(req.organization!.id, business.id, rcpt);
      if (!row) return notFound(reply, `No such receipt: ${rcpt}`);
      return serializeReceiptRow(row);
    },
  );

  app.get(
    "/v1/businesses/:biz/receipts/:rcpt/pdf",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { rcpt } = req.params as { rcpt: string };
      const row = await getReceipt(req.organization!.id, business.id, rcpt);
      if (!row) return notFound(reply, `No such receipt: ${rcpt}`);
      const buffer = await renderReceiptPdf(row.receipt);
      const name = (row.receipt.number ?? rcpt).replace(/[^A-Za-z0-9._-]/g, "_");
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="receipt-${name}.pdf"`)
        .send(buffer);
    },
  );
}
