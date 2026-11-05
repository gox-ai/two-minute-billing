import { and, asc, eq, sql, type Column, type SQL } from "drizzle-orm";
import { z } from "zod";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { customFieldDefinitions } from "@db/schema";
import { VersionConflictError } from "@/api/helpers";
import { createLogger } from "@/platform/logger";
import {
  ENUM_OPS,
  NUMBER_OPS,
  BOOL_OPS,
  DATE_OPS,
  TEXT_OPS,
  type FilterKind,
  type FilterSpec,
} from "@/platform/list-query";

const log = createLogger("custom-fields");

/** Entities that support custom fields (v1). */
export const CUSTOM_FIELD_ENTITIES = ["customer", "subscription"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "date",
  "enum",
  "email",
  "long_text",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

// Same email format check used at the API boundary for real email fields
// (`z.string().email()` — see src/api/routes.ts, customer-routes.ts, auth-routes.ts,
// checkout-routes.ts, customer-portal-routes.ts). Reused here instead of a
// hand-rolled regex so a `cf_*` email field is held to the same standard as a
// first-class one.
const emailSchema = z.string().email();

/** Validation error for definition config or value coercion. Routes map to 400. */
export class CustomFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomFieldError";
  }
}

type DefRow = typeof customFieldDefinitions.$inferSelect;

// api_name: lowercase, starts with a letter, no `cf_` prefix (that's the API-facing
// prefix, added at serialize time), so keys never collide with the flattened form.
const API_NAME_RE = /^[a-z][a-z0-9_]*$/;

function assertValidConfig(input: {
  entityType: string;
  apiName: string;
  label: string;
  dataType: string;
  enumOptions?: unknown;
}) {
  if (!(CUSTOM_FIELD_ENTITIES as readonly string[]).includes(input.entityType))
    throw new CustomFieldError(`Unsupported entity_type: ${input.entityType}`);
  if (!API_NAME_RE.test(input.apiName) || input.apiName.length > 50)
    throw new CustomFieldError(
      "api_name must be lowercase snake_case, start with a letter and have 50 characters or fewer",
    );
  if (input.apiName.startsWith("cf_"))
    throw new CustomFieldError(
      "api_name must not include the cf_ prefix. We add the prefix automatically.",
    );
  if (!input.label.trim()) throw new CustomFieldError("label is required");
  if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(input.dataType))
    throw new CustomFieldError(`Unsupported data_type: ${input.dataType}`);
  if (input.dataType === "enum") {
    const opts = input.enumOptions;
    if (!Array.isArray(opts) || opts.length === 0 || !opts.every((o) => typeof o === "string"))
      throw new CustomFieldError("enum data_type requires a non-empty enum_options string array");
  }
}

export async function createDefinition(input: {
  organizationId: string;
  businessId: string;
  entityType: CustomFieldEntity;
  apiName: string;
  label: string;
  dataType: CustomFieldType;
  enumOptions?: string[] | null;
  required?: boolean;
  isPii?: boolean;
  showInPortal?: boolean;
  /** Print this field on the invoice / credit-note document (0240). */
  showOnInvoice?: boolean;
  position?: number;
}): Promise<DefRow> {
  assertValidConfig(input);
  return withTenant(input.organizationId, async (tx) => {
    const dup = await tx
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.businessId, input.businessId),
          eq(customFieldDefinitions.entityType, input.entityType),
          eq(customFieldDefinitions.apiName, input.apiName),
        ),
      )
      .limit(1);
    if (dup.length)
      throw new CustomFieldError(
        `A custom field "${input.apiName}" already exists on ${input.entityType}`,
      );
    const [row] = await tx
      .insert(customFieldDefinitions)
      .values({
        publicId: publicId("cfd"),
        organizationId: input.organizationId,
        businessId: input.businessId,
        entityType: input.entityType,
        apiName: input.apiName,
        label: input.label,
        dataType: input.dataType,
        enumOptions: input.dataType === "enum" ? (input.enumOptions ?? null) : null,
        required: input.required ?? false,
        isPii: input.isPii ?? false,
        showInPortal: input.showInPortal ?? false,
        showOnInvoice: input.showOnInvoice ?? false,
        position: input.position ?? 0,
      })
      .returning();
    return row!;
  });
}

export async function listDefinitions(
  organizationId: string,
  businessId: string,
  opts?: { entityType?: CustomFieldEntity; includeArchived?: boolean },
): Promise<DefRow[]> {
  return withTenant(organizationId, async (tx) => listDefinitionsTx(tx, businessId, opts));
}

/** Same as listDefinitions but on the caller's transaction (for write-path validation). */
export async function listDefinitionsTx(
  tx: Tx,
  businessId: string,
  opts?: { entityType?: CustomFieldEntity; includeArchived?: boolean },
): Promise<DefRow[]> {
  const conds = [eq(customFieldDefinitions.businessId, businessId)];
  if (opts?.entityType) conds.push(eq(customFieldDefinitions.entityType, opts.entityType));
  if (!opts?.includeArchived) conds.push(eq(customFieldDefinitions.archived, false));
  return tx
    .select()
    .from(customFieldDefinitions)
    .where(and(...conds))
    .orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.createdAt));
}

export async function getDefinition(
  organizationId: string,
  businessId: string,
  defPublicId: string,
): Promise<DefRow | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.businessId, businessId),
          eq(customFieldDefinitions.publicId, defPublicId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function updateDefinition(input: {
  organizationId: string;
  businessId: string;
  publicId: string;
  expectedVersion?: number;
  // Mutable fields only — entity_type / api_name / data_type are immutable (they
  // define how stored values are interpreted; changing them would corrupt reads).
  label?: string;
  enumOptions?: string[] | null;
  required?: boolean;
  isPii?: boolean;
  showInPortal?: boolean;
  /** Print this field on the invoice / credit-note document (0240). */
  showOnInvoice?: boolean;
  position?: number;
  archived?: boolean;
}): Promise<DefRow | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [current] = await tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.businessId, input.businessId),
          eq(customFieldDefinitions.publicId, input.publicId),
        ),
      )
      .limit(1);
    if (!current) return null;
    if (input.expectedVersion !== undefined && current.resourceVersion !== input.expectedVersion)
      throw new VersionConflictError(input.expectedVersion, current.resourceVersion);

    const set: Partial<typeof customFieldDefinitions.$inferInsert> = {};
    if (input.label !== undefined) {
      if (!input.label.trim()) throw new CustomFieldError("label is required");
      set.label = input.label;
    }
    if (input.enumOptions !== undefined) {
      if (current.dataType !== "enum")
        throw new CustomFieldError("enum_options only applies to enum fields");
      if (!Array.isArray(input.enumOptions) || input.enumOptions.length === 0)
        throw new CustomFieldError("enum_options must be a non-empty string array");
      set.enumOptions = input.enumOptions;
    }
    if (input.required !== undefined) set.required = input.required;
    if (input.isPii !== undefined) set.isPii = input.isPii;
    if (input.showInPortal !== undefined) set.showInPortal = input.showInPortal;
    if (input.showOnInvoice !== undefined) set.showOnInvoice = input.showOnInvoice;
    if (input.position !== undefined) set.position = input.position;
    if (input.archived !== undefined) set.archived = input.archived;
    if (Object.keys(set).length === 0) return current;
    const [row] = await tx
      .update(customFieldDefinitions)
      .set(set)
      .where(eq(customFieldDefinitions.id, current.id))
      .returning();
    return row!;
  });
}

/** Archive (soft-disable) a definition: rejects new values, existing values still read. */
export async function archiveDefinition(
  organizationId: string,
  businessId: string,
  defPublicId: string,
): Promise<DefRow | null> {
  // Archiving hides the field from every form that collects it — worth a line when
  // values later stop arriving for a field that "still exists".
  log.log("custom field definition archived", { businessId: businessId, definition: defPublicId });
  return updateDefinition({ organizationId, businessId, publicId: defPublicId, archived: true });
}

function coerce(def: DefRow, raw: unknown): unknown {
  if (raw === null) return null;
  switch (def.dataType as CustomFieldType) {
    case "string":
    // `long_text` is storage- and validation-identical to `string` (both are
    // unbounded text in the JSONB value column) — it differs only in the
    // dashboard control (textarea vs single-line input): `long_text` is purely
    // a UI affordance over the same text type.
    case "long_text":
      return typeof raw === "string" ? raw : String(raw);
    case "email": {
      const s = typeof raw === "string" ? raw : String(raw);
      if (!emailSchema.safeParse(s).success)
        throw new CustomFieldError(`cf_${def.apiName} must be a valid email address`);
      return s;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new CustomFieldError(`cf_${def.apiName} must be a number`);
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === 1 || raw === "1") return true;
      if (raw === "false" || raw === 0 || raw === "0") return false;
      throw new CustomFieldError(`cf_${def.apiName} must be a boolean`);
    }
    case "date": {
      const d = new Date(raw as string | number | Date);
      if (Number.isNaN(d.getTime())) throw new CustomFieldError(`cf_${def.apiName} must be a date`);
      return d.toISOString().slice(0, 10); // YYYY-MM-DD
    }
    case "enum": {
      const opts = (def.enumOptions as string[] | null) ?? [];
      if (typeof raw !== "string" || !opts.includes(raw))
        throw new CustomFieldError(`cf_${def.apiName} must be one of: ${opts.join(", ")}`);
      return raw;
    }
    default:
      throw new CustomFieldError(`Unknown data_type ${def.dataType}`);
  }
}

/** Strip a leading `cf_` so callers may pass either `cf_foo` or `foo`. */
function baseKey(k: string): string {
  return k.startsWith("cf_") ? k.slice(3) : k;
}

/**
 * Validate + coerce a bag of custom-field inputs against this business's active
 * definitions for `entityType`, and MERGE onto any existing stored values.
 * Runs on the caller's RLS tx so it sees in-flight definitions.
 *
 * - Unknown / archived keys are rejected.
 * - Each value is coerced to its declared type (enum membership enforced).
 * - `null` clears a key (rejected if the field is required).
 * - mode 'create': every active required field must end up with a value, unless
 *   `skipRequired` — hosted checkout collects no custom fields, so it cannot satisfy them.
 *   Supplied values are still validated.
 * Returns the object to persist in the entity's `custom_fields` column (or null
 * if there is nothing to store), or `undefined` to leave the column untouched.
 */
export async function validateAndCoerce(
  tx: Tx,
  businessId: string,
  entityType: CustomFieldEntity,
  input: Record<string, unknown> | null | undefined,
  opts: {
    mode: "create" | "update";
    existing?: Record<string, unknown> | null;
    skipRequired?: boolean;
  },
): Promise<Record<string, unknown> | null | undefined> {
  const defs = await listDefinitionsTx(tx, businessId, { entityType, includeArchived: true });
  const activeByName = new Map<string, DefRow>();
  const anyByName = new Map<string, DefRow>();
  for (const d of defs) {
    anyByName.set(d.apiName, d);
    if (!d.archived) activeByName.set(d.apiName, d);
  }

  const merged: Record<string, unknown> = { ...(opts.existing ?? {}) };

  if (input && typeof input === "object") {
    for (const [rawKey, rawVal] of Object.entries(input)) {
      const key = baseKey(rawKey);
      const active = activeByName.get(key);
      if (!active) {
        if (anyByName.has(key))
          throw new CustomFieldError(`Custom field "${key}" is archived, so you cannot set it`);
        throw new CustomFieldError(`Unknown custom field: ${key}`);
      }
      // An empty string means CLEAR, for every data_type — normalized BEFORE coerce
      // because coerce is type-strict and only `string` survived a blank: `number`
      // turned '' into a silent 0 (Number('') === 0 is finite), while `date`, `enum`
      // and `boolean` threw. That made "clear this field" work for exactly one of
      // five types, and made any HTML form that posts its empty inputs unusable.
      const value = rawVal === "" ? null : coerce(active, rawVal);
      if (value === null || value === "") {
        if (active.required)
          throw new CustomFieldError(`cf_${key} is required, so you cannot clear it`);
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }

  if (opts.mode === "create" && !opts.skipRequired) {
    for (const d of activeByName.values()) {
      if (d.required && (merged[d.apiName] === undefined || merged[d.apiName] === null))
        throw new CustomFieldError(`cf_${d.apiName} is required`);
    }
  }

  // Nothing provided and no existing values → leave column untouched on update,
  // store null on create.
  if (input === undefined && opts.mode === "update") return undefined;
  return Object.keys(merged).length ? merged : null;
}

/** Flatten stored values to the API-facing `{ cf_<name>: value }` shape. */
export function flattenForApi(
  customFields: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (customFields && typeof customFields === "object") {
    for (const [k, v] of Object.entries(customFields)) out[`cf_${k}`] = v;
  }
  return out;
}

// ── Filtering on custom fields ────────────────────────────────────────────────

/**
 * A custom field's `data_type` → the filter kind that governs its operators.
 *
 * `email` and `long_text` are text: an email field wants `contains`/`ends_with`
 * ("@example.com"), and a textarea wants the same. `enum` is its own kind so the operator
 * list is the closed-set one (`is one of`, no `starts_with`) and the UI can offer the
 * definition's own `enum_options` instead of a free-text box.
 */
export const FILTER_KIND_BY_DATA_TYPE: Record<CustomFieldType, FilterKind> = {
  string: "text",
  long_text: "text",
  email: "text",
  enum: "enum",
  number: "number",
  boolean: "bool",
  date: "date",
};

export const OPS_BY_DATA_TYPE: Record<CustomFieldType, readonly string[]> = {
  string: TEXT_OPS,
  long_text: TEXT_OPS,
  email: TEXT_OPS,
  enum: ENUM_OPS,
  number: NUMBER_OPS,
  boolean: BOOL_OPS,
  date: DATE_OPS,
};

/**
 * The comparable SQL for one custom field's value, read out of the entity's
 * `custom_fields` jsonb.
 *
 * ⚠ Every non-text kind is behind a GUARDED cast, and that guard is the whole point.
 * `->>` yields text, so a `number` field has to be cast to compare — and a bare
 * `(custom_fields->>'x')::numeric` fails the WHOLE QUERY on a single row whose value
 * isn't numeric. `validateAndCoerce` makes that unlikely for values written through the
 * API, but not impossible: the field's `data_type` can be changed after values exist,
 * and the importers write `custom_fields` from foreign data. One bad
 * row must narrow itself out, not 500 the list for the whole business.
 *
 * A guarded cast yields NULL for an unparseable value, which every operator in
 * `filterSql` already treats correctly (it is "not present", and the negations admit it).
 */
function comparableValue(column: Column | SQL, apiName: string, dataType: CustomFieldType): SQL {
  const raw = sql`(${column} ->> ${apiName})`;
  switch (FILTER_KIND_BY_DATA_TYPE[dataType]) {
    case "number":
      // Integers and decimals, optionally signed. Anything else → NULL.
      return sql`(CASE WHEN ${raw} ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ${raw}::numeric END)`;
    case "bool":
      return sql`(CASE WHEN ${raw} IN ('true', 'false') THEN ${raw}::boolean END)`;
    case "date":
      // A leading ISO day is enough — `::timestamptz` parses both `2026-08-31` and a
      // full instant, and `filterSql`'s date operators bucket by the business day either
      // way. The guard only has to exclude values Postgres would refuse outright.
      return sql`(CASE WHEN ${raw} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN ${raw}::timestamptz END)`;
    default:
      return raw;
  }
}

/** One definition, as the list layer needs to see it. */
export interface CustomFieldFilterField {
  /** The filter field id — `cf_<api_name>`, the same name the API serializes. */
  id: string;
  label: string;
  kind: FilterKind;
  dataType: CustomFieldType;
  ops: readonly string[];
  /** For `enum` fields: the definition's own allowed values. */
  options: string[] | null;
}

/**
 * `cf_<api_name>` → `FilterSpec`, for one entity's definitions on one business.
 *
 * Keyed by the API-facing name so a filter, a saved view, a URL and the serialized
 * response all say `cf_plan_tier` — `flattenForApi` produces exactly the same key.
 *
 * ARCHIVED definitions are included on purpose. Archiving rejects new values but
 * existing ones still read (see `archiveDefinition`), so a field that has been retired
 * is precisely the one an operator needs to filter on to find and clean up the rows
 * that still carry it.
 */
export function customFieldFilterSpecs(
  defs: DefRow[],
  column: Column | SQL,
): Record<string, FilterSpec> {
  const out: Record<string, FilterSpec> = {};
  for (const d of defs) {
    const dataType = d.dataType as CustomFieldType;
    if (!(dataType in FILTER_KIND_BY_DATA_TYPE)) continue; // a data_type this build doesn't know
    out[`cf_${d.apiName}`] = {
      column: comparableValue(column, d.apiName, dataType),
      kind: FILTER_KIND_BY_DATA_TYPE[dataType],
    };
  }
  return out;
}

/**
 * The same definitions described for a CLIENT, so the dashboard can render a real filter
 * row — label, operators, and an enum's options — without hard-coding fields that are
 * per-business and created at runtime.
 *
 * This is the one place the engine legitimately owns presentation as well as existence:
 * a custom field's label and allowed values are admin-defined data, not UI knowledge.
 */
export function customFieldFilterFields(defs: DefRow[]): CustomFieldFilterField[] {
  const out: CustomFieldFilterField[] = [];
  for (const d of defs) {
    const dataType = d.dataType as CustomFieldType;
    if (!(dataType in FILTER_KIND_BY_DATA_TYPE)) continue;
    out.push({
      id: `cf_${d.apiName}`,
      label: d.label,
      kind: FILTER_KIND_BY_DATA_TYPE[dataType],
      dataType,
      ops: OPS_BY_DATA_TYPE[dataType],
      options:
        dataType === "enum" && Array.isArray(d.enumOptions) ? (d.enumOptions as string[]) : null,
    });
  }
  return out;
}

/**
 * Load one entity's definitions and return everything the list layer needs: the SQL
 * specs, the per-field operator allow-list, the kinds for value validation, and the
 * client-facing descriptions.
 *
 * One call, because a route needs the ops and kinds BEFORE parsing the query while the
 * service needs the specs while building it, and two round trips could disagree if a
 * definition were created between them.
 */
export interface CustomFieldFilterSet {
  specs: Record<string, FilterSpec>;
  ops: Record<string, readonly string[]>;
  kinds: Record<string, FilterKind>;
  fields: CustomFieldFilterField[];
}

export function customFieldFilterSet(defs: DefRow[], column: Column | SQL): CustomFieldFilterSet {
  const fields = customFieldFilterFields(defs);
  return {
    specs: customFieldFilterSpecs(defs, column),
    ops: Object.fromEntries(fields.map((f) => [f.id, f.ops])),
    kinds: Object.fromEntries(fields.map((f) => [f.id, f.kind])),
    fields,
  };
}

/**
 * Definitions for filtering, including archived ones. A separate helper so the
 * include-archived decision is made once and explained once, rather than at each of the
 * four call sites (two services, two routes) — where one of them would eventually differ
 * and a field would be filterable on the list but rejected by the route.
 */
export async function filterDefinitionsTx(
  tx: Tx,
  businessId: string,
  entityType: CustomFieldEntity,
): Promise<DefRow[]> {
  return listDefinitionsTx(tx, businessId, { entityType, includeArchived: true });
}

export async function filterDefinitions(
  organizationId: string,
  businessId: string,
  entityType: CustomFieldEntity,
): Promise<DefRow[]> {
  return withTenant(organizationId, async (tx) => filterDefinitionsTx(tx, businessId, entityType));
}

export type { DefRow as CustomFieldDefinitionRow };

export function serializeDefinition(d: DefRow) {
  return {
    object: "custom_field_definition",
    id: d.publicId,
    entity_type: d.entityType,
    api_name: d.apiName,
    cf_name: `cf_${d.apiName}`,
    label: d.label,
    data_type: d.dataType,
    enum_options: d.enumOptions ?? null,
    /**
     * How this field behaves as a LIST FILTER, stated here rather than derived by each
     * client.
     *
     * A custom field is created at runtime and is per-business, so no dashboard can
     * hard-code it — the filter builder has to be told. Emitting the kind and the
     * operator list on the definition means the `data_type → operators` mapping exists
     * exactly once (`OPS_BY_DATA_TYPE`, beside the SQL that implements it) instead of
     * being copied into every consumer, which is the duplication that already left five
     * lists offering narrower operator sets than their endpoints accepted.
     *
     * `null` for a `data_type` this build does not know, so an older client is told
     * "not filterable" rather than being handed an empty operator list to render.
     */
    filter_kind: FILTER_KIND_BY_DATA_TYPE[d.dataType as CustomFieldType] ?? null,
    filter_ops: OPS_BY_DATA_TYPE[d.dataType as CustomFieldType] ?? null,
    required: d.required,
    is_pii: d.isPii,
    show_in_portal: d.showInPortal,
    show_on_invoice: d.showOnInvoice,
    position: d.position,
    archived: d.archived,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
    resource_version: d.resourceVersion,
  };
}
