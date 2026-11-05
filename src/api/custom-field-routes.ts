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
  createDefinition,
  listDefinitions,
  getDefinition,
  updateDefinition,
  archiveDefinition,
  serializeDefinition,
  CustomFieldError,
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  type CustomFieldEntity,
} from "@/modules/custom-fields/service";
import { parseRequest } from "./strict-params";

const createBody = z.object({
  entity_type: z.enum(CUSTOM_FIELD_ENTITIES),
  api_name: z.string().min(1).max(50),
  label: z.string().min(1).max(200),
  data_type: z.enum(CUSTOM_FIELD_TYPES),
  enum_options: z.array(z.string().min(1)).optional(),
  required: z.boolean().optional(),
  is_pii: z.boolean().optional(),
  show_in_portal: z.boolean().optional(),
  // Print this field on the invoice/credit-note document (0240). At most
  // MAX_INVOICE_CUSTOM_FIELDS are rendered, ordered by `position`.
  show_on_invoice: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

const updateBody = z.object({
  label: z.string().min(1).max(200).optional(),
  enum_options: z.array(z.string().min(1)).optional(),
  required: z.boolean().optional(),
  is_pii: z.boolean().optional(),
  show_in_portal: z.boolean().optional(),
  show_on_invoice: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
  expected_version: z.number().int().nonnegative().optional(),
});

/**
 * Custom-field DEFINITIONS API (SET-4). Business-scoped config: define the typed
 * fields that then appear as `cf_<api_name>` on customers/subscriptions. Values are
 * set on those entities' own create/update routes.
 */
export async function registerCustomFieldRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/custom_field_definitions",
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
        const row = await createDefinition({
          organizationId: req.organization!.id,
          businessId: business.id,
          entityType: parsed.data.entity_type,
          apiName: parsed.data.api_name,
          label: parsed.data.label,
          dataType: parsed.data.data_type,
          enumOptions: parsed.data.enum_options ?? null,
          required: parsed.data.required,
          isPii: parsed.data.is_pii,
          showInPortal: parsed.data.show_in_portal,
          showOnInvoice: parsed.data.show_on_invoice,
          position: parsed.data.position,
        });
        return reply.code(201).send(serializeDefinition(row));
      } catch (e) {
        if (e instanceof CustomFieldError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/custom_field_definitions",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { entity_type?: string; include_archived?: string };
      if (q.entity_type && !(CUSTOM_FIELD_ENTITIES as readonly string[]).includes(q.entity_type))
        return badRequest(reply, `Unsupported entity_type: ${q.entity_type}`);
      const rows = await listDefinitions(req.organization!.id, business.id, {
        entityType: q.entity_type as CustomFieldEntity | undefined,
        includeArchived: q.include_archived === "true",
      });
      return { object: "list", data: rows.map(serializeDefinition) };
    },
  );

  app.get(
    "/v1/businesses/:biz/custom_field_definitions/:id",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await getDefinition(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, `No such custom field: ${id}`);
      return serializeDefinition(row);
    },
  );

  app.patch(
    "/v1/businesses/:biz/custom_field_definitions/:id",
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
        const row = await updateDefinition({
          organizationId: req.organization!.id,
          businessId: business.id,
          publicId: id,
          expectedVersion: parsed.data.expected_version,
          label: parsed.data.label,
          enumOptions: parsed.data.enum_options,
          required: parsed.data.required,
          isPii: parsed.data.is_pii,
          showInPortal: parsed.data.show_in_portal,
          showOnInvoice: parsed.data.show_on_invoice,
          position: parsed.data.position,
          archived: parsed.data.archived,
        });
        if (!row) return notFound(reply, `No such custom field: ${id}`);
        return serializeDefinition(row);
      } catch (e) {
        if (e instanceof VersionConflictError) return conflict(reply, e.message);
        if (e instanceof CustomFieldError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Archive (soft-disable) — existing values still read; new values rejected.
  app.delete(
    "/v1/businesses/:biz/custom_field_definitions/:id",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await archiveDefinition(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, `No such custom field: ${id}`);
      return serializeDefinition(row);
    },
  );
}
