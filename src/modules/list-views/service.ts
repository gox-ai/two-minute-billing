import { and, asc, eq, isNull, or } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { currentEventContext } from "@/platform/event-context";
import { listViews, type ListViewFilter } from "@db/schema";
import {
  OPS_BY_KIND,
  filterValueError,
  resolveAlias,
  type FilterKind,
} from "@/platform/list-query";
import { createLogger } from "@/platform/logger";
import {
  customFieldFilterFields,
  filterDefinitionsTx,
  type CustomFieldEntity,
} from "@/modules/custom-fields/service";
import type { Tx } from "@/platform/db";
import { arBucketValueError } from "@/modules/invoicing/ar-aging";
import { DUNNING_STATUS_ALIASES } from "@/modules/invoicing/status";
import { TRANSACTION_STATUS_ALIASES } from "@/modules/transactions/status";
import {
  fieldOpsFor,
  LIST_VIEW_VISIBILITY,
  type ListViewEntity,
  type ListViewVisibility,
} from "./entities";

const log = createLogger("list-views");

/**
 * Saved list views, a.k.a. segments. See `db/schema/list-views.ts` for why
 * they are server-side and why `business_id` is nullable.
 *
 * Intentionally NOT evented and NOT ledgered, for the same reason `comments` is not: a
 * view is how an operator looks at the data, never a change to it, and no webhook
 * subscriber should react to someone saving a filter. It IS owned and audited by
 * inspection.
 */
export class ListViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListViewError";
  }
}

/**
 * A name already taken by one of this operator's views on this list, so the route can
 * answer 409 rather than 400 — the request was well-formed, the state conflicts.
 */
export class ListViewNameTakenError extends ListViewError {
  constructor(name: string) {
    super(`You already have a view called '${name}' on this list`);
    this.name = "ListViewNameTakenError";
  }
}

export type ListViewRow = typeof listViews.$inferSelect;

/** Every operator the vocabulary knows, across all column kinds. */
const ALL_OPS = new Set<string>(Object.values(OPS_BY_KIND).flat());

export const MAX_FILTERS_PER_VIEW = 25;
const MAX_NAME_LENGTH = 60;

/**
 * The kind `validateFilters` checks a stored value against — `text`, i.e. arity only.
 * The permissive choice on purpose: it enforces the rules that hold for every column
 * kind without rejecting a value that is legal for some kind we cannot identify here.
 */
const SHAPE_ONLY_KIND: FilterKind = "text";

/**
 * `viewer` is who is asking, so the response can state `is_mine` rather than making the
 * client compare emails. The dashboard would otherwise need the signed-in operator's
 * identity in the BROWSER purely to group the dropdown — and "who am I" is a question
 * only the engine can answer correctly (the actor is resolved from the session, not
 * from anything the client sends).
 */
export function serializeListView(v: ListViewRow, viewer: string | null) {
  return {
    object: "list_view",
    id: v.publicId,
    entity: v.entity,
    name: v.name,
    owner: v.owner,
    /** Only the owner may rename, re-share, default or delete a view. */
    is_mine: viewer != null && v.owner === viewer,
    visibility: v.visibility,
    filters: v.filters,
    search: v.search,
    sort_field: v.sortField,
    sort_desc: v.sortDesc,
    hidden_columns: v.hiddenColumns,
    is_default: v.isDefault,
    created_at: v.createdAt,
    updated_at: v.updatedAt,
  };
}

/**
 * Who is saving. Unlike `comments`' author, there is NO 'system' fallback for a
 * private view: `owner` is the private-visibility key, so filing an unattributable
 * view under a shared sentinel would make one caller's "private" view visible to every
 * other caller that also had no actor. Better to refuse the save.
 */
export function resolveOwner(): string | null {
  return currentEventContext()?.actor ?? null;
}

/**
 * Views visible to one operator on one list: their own, plus everything the
 * organization shares. `businessId` is null for the org-level lists.
 *
 * Not paginated: an operator accumulates a handful of segments per list, never
 * thousands. If that stops being true this moves to the shared cursor helper —
 * see the "pagination-type lie" note in `docs/PROGRESS.md`.
 */
export async function listListViews(
  organizationId: string,
  businessId: string | null,
  entity: ListViewEntity,
  owner: string | null,
): Promise<ListViewRow[]> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(listViews)
      .where(
        and(
          eq(listViews.entity, entity),
          // `= NULL` is never true, so the org-level case needs IS NULL rather than a
          // parameterised comparison — otherwise every org-level list reads as empty.
          businessId == null ? isNull(listViews.businessId) : eq(listViews.businessId, businessId),
          owner == null
            ? eq(listViews.visibility, "everyone")
            : or(eq(listViews.owner, owner), eq(listViews.visibility, "everyone")),
        ),
      )
      // Shared-then-mine would reorder as people save; name order is stable and is what
      // the dropdown renders.
      .orderBy(asc(listViews.name)),
  );
}

/**
 * Which lists carry custom fields, and under which `custom_field_definitions.entity_type`.
 *
 * Only these two entities have a `custom_fields` jsonb column (v1 of the subsystem), so
 * only these two can hold a `cf_*` filter in a view.
 */
const CUSTOM_FIELD_ENTITY_FOR: Partial<Record<ListViewEntity, CustomFieldEntity>> = {
  customers: "customer",
  subscriptions: "subscription",
};

/**
 * The `cf_<api_name> → operators` allow-list for one list, or `{}` when the list has no
 * custom fields.
 *
 * A view's filters are validated against a STATIC per-module map, and a custom field is
 * created at runtime — so without this, saving "INR customers where cf_plan_tier is
 * enterprise" was refused as an unknown field, and the whole point of making custom
 * fields filterable would have died at the Save step.
 *
 * Read on the caller's transaction so the definitions and the write are one consistent
 * view of the world: a definition deleted between the check and the insert would
 * otherwise leave a stored view naming a field that no longer exists.
 *
 * `businessId` null means an org-level list, which by definition has no business whose
 * definitions could apply.
 */
async function customFieldOps(
  tx: Tx,
  entity: ListViewEntity,
  businessId: string | null,
): Promise<Record<string, readonly string[]>> {
  const cfEntity = CUSTOM_FIELD_ENTITY_FOR[entity];
  if (!cfEntity || !businessId) return {};
  const defs = await filterDefinitionsTx(tx, businessId, cfEntity);
  return Object.fromEntries(customFieldFilterFields(defs).map((f) => [f.id, f.ops]));
}

/**
 * Validate a view's filter set against the list it belongs to.
 *
 * A view is stored once and applied for months, so this is the only moment the
 * operator is present to be told something is wrong. An unchecked view fails much
 * later and much worse: the list either 400s on open, or — if the field is dropped
 * somewhere along the way — renders unfiltered rows under a name that promises they
 * are filtered.
 *
 * Returns a caller-facing message, or null when the set is usable.
 */
export function validateFilters(
  entity: ListViewEntity,
  filters: ListViewFilter[],
  /**
   * Per-business fields the static map cannot know — `cf_*`, from `customFieldOps`.
   * Merged ON TOP of the static allow-list rather than replacing it.
   */
  extraOps: Record<string, readonly string[]> = {},
): string | null {
  if (filters.length > MAX_FILTERS_PER_VIEW) {
    return `A view may hold at most ${MAX_FILTERS_PER_VIEW} filters.`;
  }
  const base = fieldOpsFor(entity);
  // A browser-filtered list has no engine allow-list at all, and no custom fields
  // either — so `null` stays `null` and the field check stays skipped.
  const allowed = base ? { ...base, ...extraOps } : null;
  for (const f of filters) {
    if (!f.field || typeof f.field !== "string") return "Every filter needs a field.";
    if (!f.op || typeof f.op !== "string") return `Filter on '${f.field}' needs an operator.`;
    if (typeof f.value !== "string") return `Filter on '${f.field}' needs a string value.`;

    if (allowed) {
      const ops = Object.hasOwn(allowed, f.field) ? allowed[f.field] : undefined;
      if (!ops) {
        return `'${f.field}' is not filterable on ${entity}. Filterable: ${Object.keys(allowed).sort().join(", ")}`;
      }
      if (!ops.includes(f.op)) {
        return `Operator '${f.op}' is not supported on '${f.field}'. Supported: ${ops.join(", ")}`;
      }
      // Only the shapes that are wrong for EVERY kind: a `between` with one bound, an
      // `in` with no members, an `is_present` that is not a boolean. The kind-specific
      // half (is this a number? a date?) is the route's `filterKinds` check when the
      // view is applied — the per-field kind is not exported, and guessing one from the
      // operator would reject valid views (`gt` is legal on a date as well as a number).
      const problem = filterValueError(SHAPE_ONLY_KIND, f.op, f.value);
      if (problem) return `Invalid value for '${f.field}[${f.op}]': ${problem}`;

      /**
       * The one field with a closed vocabulary worth checking HERE: `ar_bucket` compares a
       * derived ageing-rung NAME, so a typo saves happily and then 400s on every open of a
       * view someone named. Saving is the only moment the operator is present to be told.
       */
      if (entity === "invoices" && f.field === "ar_bucket") {
        const bad = arBucketValueError(f.op, f.value);
        if (bad) return `Invalid value for 'ar_bucket[${f.op}]': ${bad}`;
      }
    } else if (!ALL_OPS.has(f.op)) {
      // A browser-filtered list. Its own `filterFields` is the field authority, but the
      // operator vocabulary is global, so a nonsense op is still catchable here.
      return `Unknown operator '${f.op}'.`;
    }
  }
  return null;
}

export interface ListViewInput {
  organizationId: string;
  businessId: string | null;
  entity: ListViewEntity;
  name: string;
  visibility?: ListViewVisibility;
  filters?: ListViewFilter[];
  search?: string | null;
  sortField?: string | null;
  sortDesc?: boolean | null;
  hiddenColumns?: string[] | null;
  isDefault?: boolean;
  /** Overrides the ambient actor — for scripts and tests only. */
  owner?: string | null;
}

/** Renamed enum values, by entity and field — a view is stored in the current spelling. */
const VALUE_ALIASES: Partial<
  Record<ListViewEntity, Record<string, Readonly<Record<string, string>>>>
> = {
  transactions: { status: TRANSACTION_STATUS_ALIASES },
  invoices: { dunning_status: DUNNING_STATUS_ALIASES },
};

function normalizeFilterValues(entity: ListViewEntity, filters: ListViewFilter[]) {
  const byField = VALUE_ALIASES[entity];
  if (!byField) return filters;
  return filters.map((f) => {
    const aliases = Object.hasOwn(byField, f.field) ? byField[f.field] : undefined;
    if (!aliases || f.op === "is_present") return f;
    const value = f.value
      .split(",")
      .map((v) => resolveAlias(aliases, v.trim()))
      .join(",");
    return { ...f, value };
  });
}

export async function createListView(input: ListViewInput): Promise<ListViewRow> {
  const name = input.name.trim();
  if (!name) throw new ListViewError("A view needs a name");
  if (name.length > MAX_NAME_LENGTH)
    throw new ListViewError(`A view name may be at most ${MAX_NAME_LENGTH} characters`);

  const visibility = input.visibility ?? "private";
  if (!LIST_VIEW_VISIBILITY.includes(visibility))
    throw new ListViewError(`Unknown visibility '${visibility}'`);

  const owner = input.owner ?? resolveOwner();
  // See `resolveOwner`: an unattributable private view would be shared with every other
  // unattributable caller, which is the opposite of what the word promises.
  if (!owner) throw new ListViewError("We cannot find the owner of this view");

  const filters = normalizeFilterValues(input.entity, input.filters ?? []);

  // Mirrors `list_views_not_empty_check` so the caller gets a sentence instead of a
  // constraint name. A view that narrows and orders nothing sits in the dropdown
  // claiming to be a segment and does nothing.
  if (filters.length === 0 && !input.search && !input.sortField && !input.hiddenColumns) {
    throw new ListViewError(
      "A view must carry at least a filter, a search, a sort or a column choice",
    );
  }

  return withTenant(input.organizationId, async (tx) => {
    // Inside the transaction, because the custom-field half of the allow-list is a READ
    // (see `customFieldOps`) and must be the same view of the world as the insert.
    const problem = validateFilters(
      input.entity,
      filters,
      await customFieldOps(tx, input.entity, input.businessId),
    );
    if (problem) throw new ListViewError(problem);

    if (input.isDefault) await clearDefault(tx, input, owner);
    try {
      const [row] = await tx
        .insert(listViews)
        .values({
          organizationId: input.organizationId,
          businessId: input.businessId,
          publicId: publicId("view"),
          entity: input.entity,
          name,
          owner,
          visibility,
          filters,
          search: input.search ?? null,
          sortField: input.sortField ?? null,
          sortDesc: input.sortDesc ?? null,
          hiddenColumns: input.hiddenColumns ?? null,
          isDefault: input.isDefault ?? false,
        })
        .returning();
      return row!;
    } catch (e) {
      throw nameConflict(e, name);
    }
  });
}

/**
 * Clear this operator's existing default on this list, so `list_views_default_uq` sees
 * one row at a time. Runs in the same transaction as the write that sets the new one —
 * two statements outside a transaction would leave the operator with no default if the
 * second failed.
 */
async function clearDefault(
  tx: Tx,
  scope: { organizationId: string; businessId: string | null; entity: string },
  owner: string,
): Promise<void> {
  await tx
    .update(listViews)
    .set({ isDefault: false })
    .where(
      and(
        eq(listViews.entity, scope.entity),
        scope.businessId == null
          ? isNull(listViews.businessId)
          : eq(listViews.businessId, scope.businessId),
        eq(listViews.owner, owner),
        eq(listViews.isDefault, true),
      ),
    );
}

/**
 * Postgres 23505 on the name index → a typed conflict; anything else re-thrown.
 *
 * Two layers have to be seen through, and missing either one turned a fixable "you
 * already have a view by that name" into a raw 500 with a full SQL dump:
 *
 *  - **Drizzle wraps** the driver error, so `code` lives on `.cause`, not on the error
 *    it hands back. The outer object is a `DrizzleQueryError` whose message is the query.
 *  - **`postgres-js` names the field `constraint_name`**, where `node-postgres` uses
 *    `constraint`. This codebase uses postgres-js (`src/platform/db.ts`), but the
 *    verify suites and any future driver swap are why both are read.
 *
 * Caught by `scripts/verify-list-views.ts`, which asserts the ERROR CLASS rather than
 * just that the insert failed.
 */
function nameConflict(e: unknown, name: string): unknown {
  type PgError = { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
  for (
    let cur: unknown = e, depth = 0;
    cur != null && depth < 4;
    cur = (cur as PgError).cause, depth++
  ) {
    const err = cur as PgError;
    if (err.code !== "23505") continue;
    const constraint = err.constraint ?? err.constraint_name;
    // A 23505 with no constraint name is still this insert's only unique index that a
    // caller can collide with by accident — the public id is minted, not supplied.
    if (constraint == null || constraint === "list_views_name_uq")
      return new ListViewNameTakenError(name);
  }
  return e;
}

export interface ListViewPatch {
  name?: string;
  visibility?: ListViewVisibility;
  filters?: ListViewFilter[];
  search?: string | null;
  sortField?: string | null;
  sortDesc?: boolean | null;
  hiddenColumns?: string[] | null;
  isDefault?: boolean;
}

/**
 * Edit a view. Returns null when no view with this id is EDITABLE by this operator.
 *
 * Only the owner may edit or delete, including for a shared view: a segment the whole
 * organization has come to rely on must not be silently redefined by whoever opened it
 * last. The dashboard offers Duplicate on someone else's view instead, which makes a
 * copy the operator does own.
 *
 * Null covers both "no such view" and "not yours" on purpose — distinguishing them
 * would tell one operator that another has a private view by that id.
 */
export async function updateListView(
  organizationId: string,
  viewPublicId: string,
  owner: string | null,
  patch: ListViewPatch,
): Promise<ListViewRow | null> {
  if (!owner) throw new ListViewError("We cannot find the owner of this view");
  const name = patch.name?.trim();
  if (patch.name != null && !name) throw new ListViewError("A view needs a name");
  if (name && name.length > MAX_NAME_LENGTH) {
    throw new ListViewError(`A view name may be at most ${MAX_NAME_LENGTH} characters`);
  }
  if (patch.visibility && !LIST_VIEW_VISIBILITY.includes(patch.visibility)) {
    throw new ListViewError(`Unknown visibility '${patch.visibility}'`);
  }

  return withTenant(organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(listViews)
      .where(and(eq(listViews.publicId, viewPublicId), eq(listViews.owner, owner)))
      .limit(1);
    if (!existing) return null;

    // Validated against the view's OWN entity — a patch cannot move a view to another
    // list, so the field allow-list to check against is never in doubt.
    if (patch.filters) {
      const entity = existing.entity as ListViewEntity;
      const problem = validateFilters(
        entity,
        patch.filters,
        await customFieldOps(tx, entity, existing.businessId),
      );
      if (problem) throw new ListViewError(problem);
    }

    if (patch.isDefault) {
      await clearDefault(
        tx,
        { organizationId, businessId: existing.businessId, entity: existing.entity },
        owner,
      );
    }

    try {
      const [row] = await tx
        .update(listViews)
        // `updated_at`/`resource_version` are bumped by the bump_row_version trigger.
        // Every field is applied only when present, so a partial PATCH cannot blank a
        // sort or a search the caller did not mention.
        .set({
          ...(name ? { name } : {}),
          ...(patch.visibility ? { visibility: patch.visibility } : {}),
          ...(patch.filters
            ? { filters: normalizeFilterValues(existing.entity as ListViewEntity, patch.filters) }
            : {}),
          ...(patch.search !== undefined ? { search: patch.search } : {}),
          ...(patch.sortField !== undefined ? { sortField: patch.sortField } : {}),
          ...(patch.sortDesc !== undefined ? { sortDesc: patch.sortDesc } : {}),
          ...(patch.hiddenColumns !== undefined ? { hiddenColumns: patch.hiddenColumns } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
        })
        .where(eq(listViews.id, existing.id))
        .returning();
      return row ?? null;
    } catch (e) {
      throw nameConflict(e, name ?? existing.name);
    }
  });
}

/**
 * Hard-delete a view. Safe to delete for real, like a comment and unlike every
 * financial record here: a view posts nothing and reverses nothing.
 *
 * Owner-scoped for the same reason `updateListView` is.
 */
export async function deleteListView(
  organizationId: string,
  viewPublicId: string,
  owner: string | null,
): Promise<boolean> {
  if (!owner) throw new ListViewError("We cannot find the owner of this view");
  return withTenant(organizationId, async (tx) => {
    const deleted = await tx
      .delete(listViews)
      .where(and(eq(listViews.publicId, viewPublicId), eq(listViews.owner, owner)))
      .returning({ id: listViews.id });
    log.log("list view deleted", { view: viewPublicId, found: deleted.length > 0 });
    return deleted.length > 0;
  });
}

/**
 * Copy a view — including someone else's shared one — so the operator owns the copy.
 *
 * This is what makes owner-only editing tolerable: the answer to "I want this shared
 * segment, but with INR too" is a view of your own, not a redefinition of everybody's.
 * The copy starts `private` regardless of the original's visibility; re-sharing is a
 * separate, deliberate act.
 */
export async function duplicateListView(
  organizationId: string,
  viewPublicId: string,
  owner: string | null,
  name?: string,
): Promise<ListViewRow | null> {
  if (!owner) throw new ListViewError("We cannot find the owner of this view");
  return withTenant(organizationId, async (tx) => {
    const [src] = await tx
      .select()
      .from(listViews)
      .where(
        and(
          eq(listViews.publicId, viewPublicId),
          // Visible to this operator — their own, or shared with the organization.
          or(eq(listViews.owner, owner), eq(listViews.visibility, "everyone")),
        ),
      )
      .limit(1);
    if (!src) return null;

    const wanted = (name ?? `${src.name} (copy)`).trim().slice(0, MAX_NAME_LENGTH);
    try {
      const [row] = await tx
        .insert(listViews)
        .values({
          organizationId,
          businessId: src.businessId,
          publicId: publicId("view"),
          entity: src.entity,
          name: wanted,
          owner,
          visibility: "private",
          filters: src.filters,
          search: src.search,
          sortField: src.sortField,
          sortDesc: src.sortDesc,
          hiddenColumns: src.hiddenColumns,
          isDefault: false,
        })
        .returning();
      return row!;
    } catch (e) {
      throw nameConflict(e, wanted);
    }
  });
}

/**
 * Resolve a view's filters for a caller applying it server-side (a deep link, or an
 * API consumer replaying a saved segment). Returns null when the operator cannot see it.
 */
export async function getListView(
  organizationId: string,
  viewPublicId: string,
  owner: string | null,
): Promise<ListViewRow | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(listViews)
      .where(
        and(
          eq(listViews.publicId, viewPublicId),
          owner == null
            ? eq(listViews.visibility, "everyone")
            : or(eq(listViews.owner, owner), eq(listViews.visibility, "everyone")),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}
