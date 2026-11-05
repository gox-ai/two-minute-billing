import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  resolveBusiness,
  badRequest,
  notFound,
  conflict,
  VersionConflictError,
  requirePerm,
} from "./helpers";
import {
  createPaymentInstruction,
  listPaymentInstructions,
  getPaymentInstruction,
  updatePaymentInstruction,
  archivePaymentInstruction,
  serializePaymentInstruction,
  PaymentInstructionError,
  PAYMENT_INSTRUCTION_KINDS,
  MAX_INSTRUCTION_FIELDS,
} from "@/modules/invoicing/payment-instruction-service";
import { parseRequest } from "./strict-params";

/**
 * One label/value pair of a bank block. PLAIN TEXT on both halves — this lands on a
 * customer-facing PDF and HTML view, and rich text is exactly the markup surface we
 * decided not to accept here.
 */
const fieldPair = z.object({
  label: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(300),
});

/** ISO-4217. Upper-cased and de-duplicated by the service, so case is not the client's problem. */
const currencyList = z.array(z.string().trim().length(3)).max(50);
/** ISO 3166-1 alpha-2. */
const countryList = z.array(z.string().trim().length(2)).max(100);

const createBody = z.object({
  kind: z.enum(PAYMENT_INSTRUCTION_KINDS),
  section_title: z.string().trim().min(1).max(200),
  section_id: z.string().trim().max(100).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  fields: z.array(fieldPair).max(MAX_INSTRUCTION_FIELDS).optional(),
  // Empty (or absent) = applies to every invoice. See PaymentInstructionSettings.
  currencies: currencyList.optional(),
  countries: countryList.optional(),
  position: z.number().int().min(0).max(1000).optional(),
});

const updateBody = z.object({
  section_title: z.string().trim().min(1).max(200).optional(),
  section_id: z.string().trim().max(100).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  fields: z.array(fieldPair).max(MAX_INSTRUCTION_FIELDS).optional(),
  currencies: currencyList.optional(),
  countries: countryList.optional(),
  position: z.number().int().min(0).max(1000).optional(),
  archived: z.boolean().optional(),
  expected_version: z.number().int().nonnegative().optional(),
});

/**
 * Payment instructions API (0241) — how an offline payer is told where to send the money.
 *
 * `kind` is immutable after creation: it decides which rail the instruction represents,
 * and the `preferred_offline` selection mode keys off it, so changing it in place would
 * silently retarget an instruction customers have already been shown.
 */
export async function registerPaymentInstructionRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/payment_instructions",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await createPaymentInstruction({
          organizationId: req.organization!.id,
          businessId: business.id,
          kind: parsed.data.kind,
          sectionTitle: parsed.data.section_title,
          sectionId: parsed.data.section_id,
          description: parsed.data.description,
          fields: parsed.data.fields,
          currencies: parsed.data.currencies,
          countries: parsed.data.countries,
          position: parsed.data.position,
        });
        return reply.code(201).send(serializePaymentInstruction(row));
      } catch (e) {
        if (e instanceof PaymentInstructionError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/payment_instructions",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { include_archived?: string };
      const rows = await listPaymentInstructions(req.organization!.id, business.id, {
        includeArchived: q.include_archived === "true",
      });
      return { object: "list", data: rows.map(serializePaymentInstruction) };
    },
  );

  app.get(
    "/v1/businesses/:biz/payment_instructions/:id",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await getPaymentInstruction(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, `No such payment instruction: ${id}`);
      return serializePaymentInstruction(row);
    },
  );

  app.patch(
    "/v1/businesses/:biz/payment_instructions/:id",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const parsed = parseRequest(updateBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await updatePaymentInstruction({
          organizationId: req.organization!.id,
          businessId: business.id,
          publicId: id,
          expectedVersion: parsed.data.expected_version,
          sectionTitle: parsed.data.section_title,
          sectionId: parsed.data.section_id,
          description: parsed.data.description,
          fields: parsed.data.fields,
          currencies: parsed.data.currencies,
          countries: parsed.data.countries,
          position: parsed.data.position,
          archived: parsed.data.archived,
        });
        if (!row) return notFound(reply, `No such payment instruction: ${id}`);
        return serializePaymentInstruction(row);
      } catch (e) {
        if (e instanceof VersionConflictError) return conflict(reply, e.message);
        if (e instanceof PaymentInstructionError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Archive (soft-delete) — stops printing, stays readable for already-issued invoices.
  app.delete(
    "/v1/businesses/:biz/payment_instructions/:id",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await archivePaymentInstruction(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, `No such payment instruction: ${id}`);
      return serializePaymentInstruction(row);
    },
  );
}
