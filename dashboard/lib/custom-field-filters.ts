// Custom fields as filter rows for the list builder. Pure translation, no fetching —
// the definitions come from `listCustomFieldDefinitions` in a server component and are
// handed to the (client) table as a prop.
import type { ListFilterField, ListFilterType } from "@/components/patterns/list-filters";
import type { CustomFieldDefinition } from "@/lib/api/custom-fields";

/** The picker section every custom field is filed under. */
export const CUSTOM_FIELD_GROUP = "Custom fields";

/**
 * The engine's filter kind → the builder's field type.
 *
 * The two vocabularies are close but not identical, so this is the one translation that
 * has to exist client-side. `money` is deliberately unreachable: it means integer minor
 * units with one exponent for every row, and a custom `number` field is whatever the
 * admin meant — a seat count, a percent, a contract year. Rendering one as money would
 * multiply the operator's input by 100 before sending it.
 */
const TYPE_BY_FILTER_KIND: Record<
  NonNullable<CustomFieldDefinition["filter_kind"]>,
  ListFilterType
> = {
  text: "text",
  enum: "select",
  number: "number",
  bool: "boolean",
  date: "date",
};

/**
 * Definitions → filter fields, to append to a list's own `filterFields`.
 *
 * Nothing here is invented. `cf_name`, `label`, `filter_ops` and an enum's options all
 * come off the definition the engine serialized, which is built from the same
 * `FILTER_KIND_BY_DATA_TYPE` / `OPS_BY_DATA_TYPE` tables as the SQL and the route's
 * operator allow-list (`customFieldFilterSet`, src/modules/custom-fields/service.ts).
 * So every operator offered is one the endpoint accepts — `filter_ops` is used verbatim
 * and never widened.
 *
 * Skipped rather than defaulted, because a filter row that 400s on apply reads as
 * "search is broken":
 *   - `filter_kind` null — this engine build does not consider the field's `data_type`
 *     filterable, so the route would reject the row.
 *   - no `filter_ops` — we would have to guess the operator list, which is the guessing
 *     this metadata exists to remove.
 *   - an `enum` with no options — the value control would be an empty picker.
 */
export function customFieldFilterFields<T>(defs: CustomFieldDefinition[]): ListFilterField<T>[] {
  const out: ListFilterField<T>[] = [];
  for (const d of defs) {
    if (!d.filter_kind || !d.filter_ops || d.filter_ops.length === 0) continue;
    const type = TYPE_BY_FILTER_KIND[d.filter_kind];
    const options = (d.enum_options ?? []).map((v) => ({ value: v, label: v }));
    if (type === "select" && options.length === 0) continue;
    out.push({
      id: d.cf_name,
      label: d.label,
      type,
      group: CUSTOM_FIELD_GROUP,
      serverOps: d.filter_ops,
      ...(type === "select" ? { options } : {}),
      // Archiving rejects NEW values; the ones already stored still read and still
      // filter, which is exactly why a retired field stays offered. Said out loud so an
      // operator does not read the row as a leftover.
      ...(d.archived
        ? {
            hint: "Archived. It accepts no new values. Rows that already have a value still match.",
          }
        : {}),
      // The label is the admin's, so the API name is the other thing they might type.
      keywords: `custom field ${d.api_name}`,
    });
  }
  return out;
}
