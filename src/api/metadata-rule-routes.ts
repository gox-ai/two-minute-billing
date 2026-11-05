import type { FastifyInstance, FastifyReply } from "fastify";
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
  createRule,
  listRules,
  getRule,
  updateRule,
  archiveRule,
  serializeRule,
  getRulesConfig,
  setRulesConfig,
  serializeConfig,
  MetadataRuleError,
  METADATA_RULE_ENTITIES,
  METADATA_RULE_TYPES,
  METADATA_ITEM_TYPES,
  RULE_LIMITS,
  type MetadataRuleEntity,
} from "@/modules/metadata-rules/service";
import { parseRequest } from "./strict-params";
import { observedMetadataKeys, OBSERVED_LIMITS } from "@/modules/metadata-rules/observed";

const enumOptions = z
  .array(z.string().min(1).max(RULE_LIMITS.enumOption))
  .max(RULE_LIMITS.enumOptions);

const bound = z
  .number()
  .finite()
  .min(-RULE_LIMITS.bound)
  .max(RULE_LIMITS.bound)
  .nullable()
  .optional();
const itemCount = z.number().int().min(0).max(RULE_LIMITS.items).nullable().optional();
/** Number and array options, shared by create and update. Cross-field checks live in the service. */
const boundsFields = {
  integer: z.boolean().nullable().optional(),
  min: bound,
  max: bound,
  item_type: z.enum(METADATA_ITEM_TYPES).nullable().optional(),
  item_enum_options: enumOptions.nullable().optional(),
  min_items: itemCount,
  max_items: itemCount,
};
const boundsOf = (d: {
  integer?: boolean | null;
  min?: number | null;
  max?: number | null;
  item_type?: (typeof METADATA_ITEM_TYPES)[number] | null;
  item_enum_options?: string[] | null;
  min_items?: number | null;
  max_items?: number | null;
}) => ({
  integerOnly: d.integer,
  minValue: d.min,
  maxValue: d.max,
  itemType: d.item_type,
  itemEnumOptions: d.item_enum_options,
  minItems: d.min_items,
  maxItems: d.max_items,
});

const createBody = z.object({
  entity_type: z.enum(METADATA_RULE_ENTITIES),
  // A dot path; segments and depth are checked by the service.
  key: z
    .string()
    .min(1)
    .max(RULE_LIMITS.segment * RULE_LIMITS.depth + RULE_LIMITS.depth),
  data_type: z.enum(METADATA_RULE_TYPES),
  enum_options: enumOptions.optional(),
  pattern: z.string().max(RULE_LIMITS.pattern).nullable().optional(),
  max_length: z.number().int().min(1).max(RULE_LIMITS.maxLength).nullable().optional(),
  description: z.string().max(RULE_LIMITS.description).nullable().optional(),
  ...boundsFields,
});

const updateBody = z.object({
  enum_options: enumOptions.nullable().optional(),
  pattern: z.string().max(RULE_LIMITS.pattern).nullable().optional(),
  max_length: z.number().int().min(1).max(RULE_LIMITS.maxLength).nullable().optional(),
  description: z.string().max(RULE_LIMITS.description).nullable().optional(),
  archived: z.boolean().optional(),
  expected_version: z.number().int().nonnegative().optional(),
  ...boundsFields,
});

const entitySettings = z
  .object({
    metadata_validation: z.enum(["on", "off"]).optional(),
    strict: z.boolean().optional(),
  })
  .refine((v) => v.metadata_validation !== undefined || v.strict !== undefined, {
    message: "Give metadata_validation, strict, or both",
  });
const settingsBody = z.object({
  customer: entitySettings.optional(),
  subscription: entitySettings.optional(),
});

/** A refused rule config, with the field it names. */
function refuse(reply: FastifyReply, e: MetadataRuleError) {
  return reply
    .code(400)
    .send({ error: { type: "invalid_request_error", message: e.message, param: e.param } });
}

/**
 * Metadata key rules (0332). Business-scoped config: the keys a business allows in customer and
 * subscription `metadata`, checked on every write to those records.
 */
export async function registerMetadataRuleRoutes(app: FastifyInstance) {
  const base = "/v1/businesses/:biz/metadata_key_rules";

  app.post(
    base,
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      try {
        const row = await createRule({
          organizationId: req.organization!.id,
          businessId: business.id,
          entityType: d.entity_type,
          key: d.key,
          dataType: d.data_type,
          enumOptions: d.enum_options,
          pattern: d.pattern,
          maxLength: d.max_length,
          description: d.description,
          ...boundsOf(d),
        });
        return reply.code(201).send(serializeRule(row));
      } catch (e) {
        if (e instanceof MetadataRuleError) return refuse(reply, e);
        throw e;
      }
    },
  );

  app.get(
    base,
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { entity_type?: string; include_archived?: string };
      if (q.entity_type && !(METADATA_RULE_ENTITIES as readonly string[]).includes(q.entity_type))
        return badRequest(reply, `Unsupported entity_type: ${q.entity_type}`);
      const rows = await listRules(req.organization!.id, business.id, {
        entityType: q.entity_type as MetadataRuleEntity | undefined,
        includeArchived: q.include_archived === "true",
      });
      return { object: "list", data: rows.map(serializeRule) };
    },
  );

  app.get(
    `${base}/:id`,
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await getRule(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, `No such metadata key rule: ${id}`);
      return serializeRule(row);
    },
  );

  app.patch(
    `${base}/:id`,
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
      const d = parsed.data;
      try {
        const row = await updateRule({
          organizationId: req.organization!.id,
          businessId: business.id,
          publicId: id,
          expectedVersion: d.expected_version,
          enumOptions: d.enum_options,
          pattern: d.pattern,
          maxLength: d.max_length,
          description: d.description,
          archived: d.archived,
          ...boundsOf(d),
        });
        if (!row) return notFound(reply, `No such metadata key rule: ${id}`);
        return serializeRule(row);
      } catch (e) {
        if (e instanceof VersionConflictError) return conflict(reply, e.message);
        if (e instanceof MetadataRuleError) return refuse(reply, e);
        throw e;
      }
    },
  );

  // Archive: the rule stops applying. Stored values are untouched.
  app.delete(
    `${base}/:id`,
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await archiveRule(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, `No such metadata key rule: ${id}`);
      return serializeRule(row);
    },
  );

  // Keys already in use, for suggestions. A read like listing the records themselves, so any
  // authenticated caller of this business may ask; values come back only for keys with few,
  // short values (see `observed.ts`), so no ids or free text leave the database.
  app.get(
    "/v1/businesses/:biz/metadata_observed_keys",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { entity_type?: string };
      if (!q.entity_type || !(METADATA_RULE_ENTITIES as readonly string[]).includes(q.entity_type))
        return badRequest(reply, "entity_type must be customer or subscription");
      const data = await observedMetadataKeys(
        req.organization!.id,
        business.id,
        q.entity_type as MetadataRuleEntity,
      );
      return {
        object: "list",
        entity_type: q.entity_type,
        sample_size: OBSERVED_LIMITS.sampleRows,
        data: data.map((k) => ({ object: "metadata_observed_key", ...k })),
      };
    },
  );

  const settings = "/v1/businesses/:biz/metadata_rule_settings";

  app.get(
    settings,
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      return serializeConfig(await getRulesConfig(req.organization!.id, business.id));
    },
  );

  app.patch(
    settings,
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(settingsBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      const one = (v: typeof d.customer) =>
        v ? { validation: v.metadata_validation, strict: v.strict } : undefined;
      const config = await setRulesConfig({
        organizationId: req.organization!.id,
        businessId: business.id,
        patch: { customer: one(d.customer), subscription: one(d.subscription) },
      });
      return serializeConfig(config);
    },
  );
}
