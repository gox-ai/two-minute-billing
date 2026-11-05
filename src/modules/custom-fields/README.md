# custom-fields — admin-defined typed fields (SET-4)

> Source: `src/modules/custom-fields/` · Routes: `src/api/custom-field-routes.ts` ·
> Schema: `db/schema/custom-fields.ts`
> Layer: catalog/config (business-scoped)

## Purpose
Custom fields are a **distinct subsystem from `metadata`**. `metadata` is a free-form JSONB escape
hatch; custom fields are **admin-DEFINED, typed** fields configured per business (in Settings) that
then appear as first-class `cf_<api_name>` values on records and in the API.

**v1 entities:** `customer`, `subscription`. The plumbing is generic (`entity_type` column), so
adding an entity later is config + a couple of write-path wires, not a rebuild.

Need to check the free-form `metadata` instead (types, nested paths, strict mode)? That is
`modules/metadata-rules`. It has no `required`; a mandatory value belongs here.

## Data model
`db/schema/custom-fields.ts` — `custom_field_definitions` (publicId `cfd_…`, org/business,
`entity_type`, `api_name` [unique per (business, entity)], `label`, `data_type`
string|number|boolean|date|enum, `enum_options`, `required`, `is_pii`, `show_in_portal`,
`position`, `archived`, version). **Values** live in a dedicated `custom_fields` JSONB column on
`customers` / `subscriptions` (NOT in `metadata`), keyed by `api_name`.

## Public surface
| Function | What it does |
|---|---|
| `createDefinition` / `listDefinitions` / `updateDefinition` / `archiveDefinition` | definition CRUD (business-scoped). `api_name`/`entity_type`/`data_type` are immutable after create. |
| `validateAndCoerce(tx, businessId, entityType, input, {mode, existing})` | validate + type-coerce a bag of `cf_*` inputs against active definitions, merged onto existing values. Rejects unknown/archived keys, enforces enum membership + `required`. Called by entity create/update services on their tx. |
| `flattenForApi(customFields)` | `{ cf_<name>: value }` for serializers. |
| `serializeDefinition(row)` | API shape for a definition. |

## Rules / gotchas
- `api_name` is stored WITHOUT the `cf_` prefix; the prefix is added only at the API boundary.
  Inputs may use either form (`cf_foo` or `foo`).
- Archived definitions reject NEW values but existing stored values still read.
- Coercion normalizes: numbers→number, booleans accept `true/false/1/0`, dates→`YYYY-MM-DD`,
  enum→must be a member of `enum_options`.
- Validation errors throw `CustomFieldError` → routes map to 400.

## Changelog
- **2026-10-03** — `validateAndCoerce` takes `skipRequired` (create mode only): the Required-presence
  check is skipped, supplied values are still validated. Set by hosted checkout through
  `createCustomer`/`createSubscription`'s `skipRequiredCustomFields`, because the checkout collects
  no custom fields and one Required field used to refuse every signup. Dashboard/API creates still enforce it.
- **2026-08-07** — Added `email` and `long_text` to `CUSTOM_FIELD_TYPES` (was
  `string|number|boolean|date|enum`); we had no equivalent for either. `email` validates with the
  same `z.string().email()` check used at the API boundary for real email fields (routes.ts,
  customer-routes.ts, auth-routes.ts, checkout-routes.ts, customer-portal-routes.ts) rather than a
  new regex. `long_text` is storage/validation-identical to `string` (both are unbounded text in
  the JSONB value column) — it differs only in the dashboard control (`Textarea` vs single-line
  `Input`). `data_type` is a `text`
  column with no CHECK/DB enum (`db/schema/custom-fields.ts`), so no migration was needed. Dashboard:
  `components/customers/custom-fields-fields.tsx` renders `email` as `<Input type="email">` and
  `long_text` as `Textarea`; the "Add a custom field" type dropdown
  (`settings/custom-fields/page.tsx`) gained matching options. NOT done: the 7 missing definitions
  + type drift on 3 existing ones noted in PROGRESS — that's tenant SITE CONFIG data, not a
  type-system gap, and belongs to the import path.
- **2026-07-30** — 🔴 **"Clear a field" now works for every `data_type`, not just `string`.**
  `validateAndCoerce` tested emptiness on the value it got back from `coerce`, and `coerce` is
  type-strict, so only `string` ever reached the clear branch: a blank **`number`** became a silent
  **0** (`Number('') === 0` is finite), and blank **`date`** / **`enum`** / **`boolean`** threw 400.
  That made any HTML form which posts its empty inputs unusable for 4 of 5 types. `''` is now
  normalized to `null` **before** `coerce`, so the existing "clear, unless required" rule applies
  uniformly. Genuinely invalid values still reject. Consumer: the customer edit/create takeovers now
  render one control per active definition (`components/customers/custom-fields-fields.tsx`).
  NB a boolean checkbox posts a hidden `false` before its `true` and the caller takes the LAST value,
  so unchecking stores `false` rather than clearing — without that the merge-onto-existing semantics
  meant a boolean could never be turned back off.
- **2026-08-31** — **custom fields became FILTERABLE** on the customers and subscriptions lists,
  as `cf_<api_name>`. This module now owns the filter half of the subsystem:
  `customFieldFilterSpecs` builds the comparable SQL out of the `custom_fields` jsonb,
  `OPS_BY_DATA_TYPE` / `FILTER_KIND_BY_DATA_TYPE` map a `data_type` to its operator set, and
  `customFieldFilterSet` returns specs + ops + kinds + client descriptions in one call (a route
  needs the ops before parsing the query while the service needs the specs while building it, and
  two reads could disagree if a definition were created between them).
  - `serializeDefinition` now emits **`filter_kind` and `filter_ops`**, so the
    `data_type → operators` mapping lives here, once, beside the SQL that implements it — rather
    than being re-derived by every client. `null` for a `data_type` this build does not know, so an
    older client is told "not filterable" instead of being handed an empty operator list.
  - **Archived definitions are included** in `filterDefinitions`. Archiving rejects NEW values but
    existing ones still read, so a retired field is exactly the one an operator filters on to find
    and clean up the rows that still carry it.
  - ⚠ Every non-text kind is behind a **guarded cast** (`CASE WHEN … ~ '<pattern>' THEN …::type END`).
    `->>` yields text, so a `number` field must be cast to compare, and a bare `::numeric` fails the
    WHOLE query on one row whose value is not numeric — reachable because a definition's `data_type`
    can change after values exist and the importers write `custom_fields` from foreign data. Do not
    "simplify" these to bare casts.
  - Coverage: `pnpm verify:list-views` (every kind × operator against Postgres, six malformed-value
    cases, and the saved-view allow-list including the cross-`entity_type` refusal).

- **2026-07-23** — module created (SET-4). Definitions table + `custom_fields` value columns on
  customer/subscription; validate/coerce write-path; `cf_*` in customer/subscription API +
  business-settings UI; `verify:custom-fields`.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
