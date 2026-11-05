import { and, asc, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { businesses, metadataKeyRules } from "@db/schema";
import { VersionConflictError } from "@/api/helpers";
import { createLogger } from "@/platform/logger";
import {
  MetadataRuleError,
  checkMetadataWrite,
  assertValidPath,
  assertNoConflict,
  assertValidOptions,
  assertValidBounds,
  type RuleConfigPatch,
  type MetadataRuleEntity,
  type MetadataRuleType,
  type MetadataRuleScope,
} from "./check";

const log = createLogger("metadata-rules");

export * from "./check";

type RuleRow = typeof metadataKeyRules.$inferSelect;

// ── rule CRUD ─────────────────────────────────────────────────────────────────

export async function createRule(
  input: {
    organizationId: string;
    businessId: string;
    entityType: MetadataRuleEntity;
    key: string;
    dataType: MetadataRuleType;
  } & RuleConfigPatch,
): Promise<RuleRow> {
  assertValidPath(input.key);
  if (input.dataType === "enum" && input.enumOptions == null)
    throw new MetadataRuleError("The enum type needs enum_options.", "enum_options");
  // Allowed item values imply string items, so `item_type` can be left out.
  if (input.itemEnumOptions != null && input.itemType == null)
    input = { ...input, itemType: "string" };
  assertValidOptions(input.dataType, input);
  assertValidBounds(input.dataType, input);
  return withTenant(input.organizationId, async (tx) => {
    // Every rule of the entity, archived included: the path is a rule's identity.
    const others = await listRulesTx(tx, input.businessId, {
      entityType: input.entityType,
      includeArchived: true,
    });
    assertNoConflict(input, others);
    const [row] = await tx
      .insert(metadataKeyRules)
      .values({
        publicId: publicId("mkr"),
        organizationId: input.organizationId,
        businessId: input.businessId,
        entityType: input.entityType,
        key: input.key,
        dataType: input.dataType,
        enumOptions: input.dataType === "enum" ? (input.enumOptions ?? null) : null,
        pattern: input.pattern ?? null,
        maxLength: input.maxLength ?? null,
        description: input.description ?? null,
        integerOnly: input.integerOnly ?? false,
        minValue: input.minValue ?? null,
        maxValue: input.maxValue ?? null,
        itemType: input.itemType ?? null,
        itemEnumOptions: input.itemEnumOptions ?? null,
        minItems: input.minItems ?? null,
        maxItems: input.maxItems ?? null,
      })
      .returning();
    log.info("metadata key rule created", {
      businessId: input.businessId,
      rule: row!.publicId,
      entityType: input.entityType,
    });
    return row!;
  });
}

export async function listRulesTx(
  tx: Tx,
  businessId: string,
  opts?: { entityType?: MetadataRuleEntity; includeArchived?: boolean },
): Promise<RuleRow[]> {
  const conds = [eq(metadataKeyRules.businessId, businessId)];
  if (opts?.entityType) conds.push(eq(metadataKeyRules.entityType, opts.entityType));
  if (!opts?.includeArchived) conds.push(eq(metadataKeyRules.archived, false));
  return tx
    .select()
    .from(metadataKeyRules)
    .where(and(...conds))
    .orderBy(asc(metadataKeyRules.entityType), asc(metadataKeyRules.key));
}

export async function listRules(
  organizationId: string,
  businessId: string,
  opts?: { entityType?: MetadataRuleEntity; includeArchived?: boolean },
): Promise<RuleRow[]> {
  return withTenant(organizationId, (tx) => listRulesTx(tx, businessId, opts));
}

export async function getRule(
  organizationId: string,
  businessId: string,
  rulePublicId: string,
): Promise<RuleRow | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(metadataKeyRules)
      .where(
        and(
          eq(metadataKeyRules.businessId, businessId),
          eq(metadataKeyRules.publicId, rulePublicId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Edit a rule. `key`, `entity_type` and `data_type` are immutable. */
export async function updateRule(
  input: {
    organizationId: string;
    businessId: string;
    publicId: string;
    expectedVersion?: number;
    archived?: boolean;
  } & RuleConfigPatch,
): Promise<RuleRow | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [current] = await tx
      .select()
      .from(metadataKeyRules)
      .where(
        and(
          eq(metadataKeyRules.businessId, input.businessId),
          eq(metadataKeyRules.publicId, input.publicId),
        ),
      )
      .limit(1);
    if (!current) return null;
    if (input.expectedVersion !== undefined && current.resourceVersion !== input.expectedVersion)
      throw new VersionConflictError(input.expectedVersion, current.resourceVersion);
    if (current.dataType === "enum" && input.enumOptions === null)
      throw new MetadataRuleError("The enum type needs enum_options.", "enum_options");
    assertValidOptions(current.dataType, input);
    // Judge the bounds on the rule as it will be stored: a patch may change one bound only.
    const pick = <T>(patch: T | undefined, stored: T) => (patch === undefined ? stored : patch);
    assertValidBounds(current.dataType, {
      integerOnly: pick(input.integerOnly, current.integerOnly),
      minValue: pick(input.minValue, current.minValue),
      maxValue: pick(input.maxValue, current.maxValue),
      itemType: pick(input.itemType, current.itemType as RuleConfigPatch["itemType"]),
      itemEnumOptions: pick(input.itemEnumOptions, current.itemEnumOptions as string[] | null),
      minItems: pick(input.minItems, current.minItems),
      maxItems: pick(input.maxItems, current.maxItems),
    });
    // Restoring must not bring back a rule that now contradicts the active ones.
    if (input.archived === false && current.archived) {
      const others = await listRulesTx(tx, input.businessId, {
        entityType: current.entityType as MetadataRuleEntity,
      });
      assertNoConflict(
        current,
        others.filter((o) => o.id !== current.id),
      );
    }

    const set: Partial<typeof metadataKeyRules.$inferInsert> = { updatedAt: new Date() };
    if (input.enumOptions !== undefined) set.enumOptions = input.enumOptions;
    if (input.pattern !== undefined) set.pattern = input.pattern || null;
    if (input.maxLength !== undefined) set.maxLength = input.maxLength;
    if (input.description !== undefined) set.description = input.description || null;
    if (input.integerOnly !== undefined) set.integerOnly = input.integerOnly ?? false;
    if (input.minValue !== undefined) set.minValue = input.minValue;
    if (input.maxValue !== undefined) set.maxValue = input.maxValue;
    if (input.itemType !== undefined) set.itemType = input.itemType;
    if (input.itemEnumOptions !== undefined) set.itemEnumOptions = input.itemEnumOptions;
    if (input.minItems !== undefined) set.minItems = input.minItems;
    if (input.maxItems !== undefined) set.maxItems = input.maxItems;
    if (input.archived !== undefined) set.archived = input.archived;
    if (Object.keys(set).length === 1) return current;
    const [row] = await tx
      .update(metadataKeyRules)
      .set(set)
      .where(eq(metadataKeyRules.id, current.id))
      .returning();
    return row!;
  });
}

/** Archive a rule: it stops applying. Under strict mode its key then counts as unknown. */
export async function archiveRule(
  organizationId: string,
  businessId: string,
  rulePublicId: string,
): Promise<RuleRow | null> {
  log.info("metadata key rule archived", { businessId, rule: rulePublicId });
  return updateRule({ organizationId, businessId, publicId: rulePublicId, archived: true });
}

export function serializeRule(r: RuleRow) {
  return {
    object: "metadata_key_rule" as const,
    id: r.publicId,
    entity_type: r.entityType,
    key: r.key,
    data_type: r.dataType,
    enum_options: (r.enumOptions as string[] | null) ?? null,
    pattern: r.pattern,
    max_length: r.maxLength,
    integer: r.integerOnly,
    min: r.minValue,
    max: r.maxValue,
    item_type: r.itemType,
    item_enum_options: (r.itemEnumOptions as string[] | null) ?? null,
    min_items: r.minItems,
    max_items: r.maxItems,
    description: r.description,
    archived: r.archived,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    version: r.resourceVersion,
  };
}

// ── validation switch and strict mode ─────────────────────────────────────────

/**
 * Per entity: `validation` turns the rules on or off (default off), and `strict` refuses
 * uncovered paths — but only while validation is on. Turning either on changes no stored data.
 */
export interface MetadataRulesConfig {
  customer: { validation: "on" | "off"; strict: boolean };
  subscription: { validation: "on" | "off"; strict: boolean };
}

function readConfig(raw: unknown): MetadataRulesConfig {
  const c = (raw ?? {}) as Partial<
    Record<MetadataRuleEntity, { validation?: unknown; strict?: unknown }>
  >;
  const one = (e: MetadataRuleEntity) => ({
    validation: c[e]?.validation === "on" ? ("on" as const) : ("off" as const),
    strict: c[e]?.strict === true,
  });
  return { customer: one("customer"), subscription: one("subscription") };
}

export async function getRulesConfigTx(tx: Tx, businessId: string): Promise<MetadataRulesConfig> {
  const [b] = await tx
    .select({ config: businesses.metadataRulesConfig })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return readConfig(b?.config);
}

export async function getRulesConfig(
  organizationId: string,
  businessId: string,
): Promise<MetadataRulesConfig> {
  return withTenant(organizationId, (tx) => getRulesConfigTx(tx, businessId));
}

export type MetadataRulesConfigPatch = Partial<
  Record<MetadataRuleEntity, { validation?: "on" | "off"; strict?: boolean }>
>;

export async function setRulesConfig(input: {
  organizationId: string;
  businessId: string;
  patch: MetadataRulesConfigPatch;
}): Promise<MetadataRulesConfig> {
  return withTenant(input.organizationId, async (tx) => {
    const current = await getRulesConfigTx(tx, input.businessId);
    const merge = (e: MetadataRuleEntity) => ({
      validation: input.patch[e]?.validation ?? current[e].validation,
      strict: input.patch[e]?.strict ?? current[e].strict,
    });
    const next: MetadataRulesConfig = {
      customer: merge("customer"),
      subscription: merge("subscription"),
    };
    await tx
      .update(businesses)
      .set({ metadataRulesConfig: next })
      .where(eq(businesses.id, input.businessId));
    log.info("metadata rule settings changed", {
      businessId: input.businessId,
      customerValidation: next.customer.validation,
      customerStrict: next.customer.strict,
      subscriptionValidation: next.subscription.validation,
      subscriptionStrict: next.subscription.strict,
    });
    return next;
  });
}

export function serializeConfig(c: MetadataRulesConfig) {
  return {
    object: "metadata_rule_settings" as const,
    customer: { metadata_validation: c.customer.validation, strict: c.customer.strict },
    subscription: { metadata_validation: c.subscription.validation, strict: c.subscription.strict },
  };
}

// ── write-path enforcement ────────────────────────────────────────────────────

/**
 * Check a `metadata` write on the caller's transaction. `next === undefined` means the write
 * does not touch metadata, so nothing is checked. See `checkMetadataWrite` for the rules.
 */
export async function enforceMetadataRules(
  tx: Tx,
  businessId: string,
  entityType: MetadataRuleEntity,
  next: Record<string, unknown> | null | undefined,
  opts: {
    mode: "create" | "update";
    existing?: Record<string, unknown> | null;
    scope?: MetadataRuleScope;
  },
): Promise<void> {
  const scope = opts.scope ?? "enforce";
  if (scope === "off") return;
  if (next === undefined && opts.mode === "update") return;
  const config = await getRulesConfigTx(tx, businessId);
  // The business's switch: with validation off, writes behave as if no rule existed.
  if (config[entityType].validation !== "on") return;
  const rules = await listRulesTx(tx, businessId, { entityType });
  checkMetadataWrite({
    validation: "on",
    rules,
    strict: config[entityType].strict,
    next: next ?? null,
    existing: opts.existing ?? null,
    mode: opts.mode,
    scope,
  });
}

/**
 * `enforceMetadataRules` in its own transaction, for a route that must refuse a metadata write
 * BEFORE it starts other work it cannot roll back (e.g. `update_for_items`).
 */
export async function assertMetadataAllowed(
  organizationId: string,
  businessId: string,
  entityType: MetadataRuleEntity,
  next: Record<string, unknown> | null | undefined,
  opts: { mode: "create" | "update"; existing?: Record<string, unknown> | null },
): Promise<void> {
  await withTenant(organizationId, (tx) =>
    enforceMetadataRules(tx, businessId, entityType, next, opts),
  );
}
