# metadata-rules — checks on customer and subscription metadata (0332)

> Source: `src/modules/metadata-rules/` (`check.ts` pure, `service.ts` storage + enforcement) ·
> Routes: `src/api/metadata-rule-routes.ts` · Schema: `db/schema/metadata-rules.ts`,
> `businesses.metadata_rules_config` · Layer: customer (business-scoped config)

## Purpose
A business can describe the `metadata` its integrations write on customers and subscriptions:
a type per key or nested path, with optional limits. Every write of that metadata is checked
**while the business's switch is on**. This is NOT custom fields (`modules/custom-fields`): those
are typed values in their own `custom_fields` column. Here the caller's raw `metadata` JSON is only
checked — never converted or rewritten.

**Every path is optional.** A rule checks a value only when it is present and not null. A
business that needs a mandatory value uses a custom field, which has `required`.

## Data model
- `metadata_key_rules` (`mkr_…`, org RLS): `entity_type` (customer | subscription), `key` (a dot
  path, immutable), `data_type` (string | number | boolean | date | email | enum | object | array,
  immutable), `enum_options`, `pattern`, `max_length`, `description`, `archived`; number options
  `integer_only`, `min_value`, `max_value`; array options `item_type`, `item_enum_options`,
  `min_items`, `max_items` (0333).
  Unique on (business, entity_type, key).
- `businesses.metadata_rules_config` (jsonb, NULL = off):
  `{ customer: { validation: 'on'|'off', strict: bool }, subscription: { … } }`.

## Rules
- **The switch.** `metadata_validation` per entity, default `off`. Off: writes behave as if no rule
  existed; strict is ignored. On: rules apply, plus strict if set. Turning it on never touches
  stored data — it judges later writes only.
- **Paths.** 1 to 5 dot-separated segments of `[A-Za-z0-9_-]`, each up to 64 characters. No `[]`
  segment in v1. A missing intermediate means the path is absent (passes). An intermediate that
  exists but is not an object fails the rule on that path ("cannot be checked").
- **object / array.** `object` asserts a plain JSON object; `array` asserts a JSON array, and its
  items are checked only when `item_type` / `item_enum_options` / `min_items` / `max_items` is set.
  No rule can sit below an array.
- **Number bounds (0333).** `integer` (whole numbers only), `min` and `max` (inclusive, finite).
  Allowed on `number` rules only. `min > max` is refused at create AND on a PATCH that moves one
  bound past the stored other one (the service judges the merged config).
- **Array items (0333).** `item_type` string | number | boolean; `item_enum_options` needs string
  items (create defaults `item_type` to string when only the values are given); `min_items` /
  `max_items` inclusive. A failure names the index: `"limit_overrides.scheduling"[1] must be one
  of: …`. Allowed on `array` rules only. A DB CHECK backs the type pairing and the bound order.
- **Conflicts are refused at create (and restore).** The same path twice (archived included);
  a rule below an ancestor whose rule is not `object`; a non-`object` rule at a path with rules
  below it.
- **Merge rule.** Customer and subscription writes REPLACE `metadata` wholesale, nested objects
  included; nothing is deep-merged. So the validator walks exactly the object that will be stored.
- **Existing records.** A rule is judged only when the value at its path differs from the stored
  one. A value stored before the rule existed, and sent back unchanged, passes — an old record can
  still be edited.
- **Strict mode, level by level.** The top level is always checked. A nested object is checked when
  a rule sits strictly below it. At a checked level each key must be covered — its own rule, or an
  ancestor of a rule path (`billing` is covered by `billing.po`). An uncovered key whose value is new
  or changed is refused. Inside a key whose rule has nothing below it (an `object` with no child
  rules, an `array`, a scalar) content is free-form.
- **Errors.** `MetadataRuleError` carries `statusCode` 400 and `param: "metadata"`, so it is a 400
  that names the field from any route, through the global error handler.

## Writers (scope per call)
| Writer | Scope |
|---|---|
| API / dashboard: customer create + update, subscription create + settings PATCH, `/change`, `update_for_items` | `enforce` |
| `update_for_items` | checked BEFORE any item moves (`assertMetadataAllowed`) — its metadata write runs after the items |
| `/change` | checked inside the write transaction, before the optimistic-lock claim |
| Checkout session mint (operator API) | `supplied_only` — types, no strict |
| Hosted checkout completion (customer + subscription create, change/reactivate write) | `off` (mint already checked; the buyer cannot fix it) / `supplied_only` for the bare customer |
| HubSpot app (customer `hubspot_contact_id`, subscription `hubspot_deal_id`) | `supplied_only` |
| HubSpot inbound sync, customer portal | do not write metadata |
| Importer (`modules/migration`), sample data | `off` — stored verbatim |

## Public surface
| Function | What it does |
|---|---|
| `enforceMetadataRules(tx, biz, entity, next, {mode, existing, scope})` | the write-path check, on the caller's tx |
| `assertMetadataAllowed(…)` | the same, in its own tx, for a route that must refuse before other work |
| `checkMetadataWrite` / `checkValue` / `assertNoConflict` (`check.ts`) | pure, unit-tested |
| `createRule` / `listRules` / `getRule` / `updateRule` / `archiveRule` | rule CRUD |
| `getRulesConfig` / `setRulesConfig` | the switch and strict mode |

## API routes
| Method · Path | Purpose |
|---|---|
| `POST/GET /v1/businesses/:biz/metadata_key_rules` | create / list (`entity_type`, `include_archived`) |
| `GET/PATCH/DELETE /v1/businesses/:biz/metadata_key_rules/:id` | get / edit / archive |
| `GET/PATCH /v1/businesses/:biz/metadata_rule_settings` | `{ customer: { metadata_validation, strict }, subscription: { … } }` |
| `GET /v1/businesses/:biz/metadata_observed_keys?entity_type=` | paths in use, for suggestions (`observed.ts`) |

Writes need `admin` and an `Idempotency-Key`. Gated by `pnpm verify:metadata-rules` (in
`verify:all`) and `test/unit/metadata-rules.test.ts`.

## Changelog
- **2026-10-08** — **The dashboard editor and suggestions.**
  - `GET …/metadata_observed_keys` reads the newest 5,000 records of the entity (top-level keys and
    one level under objects): row count, dominant type, distinct count. Values come back only for a
    path with ≤ 20 distinct values that are all short scalars (≤ 64 chars), so ids and free text
    never leave the database. Cached per (business, entity) for 5 minutes. Read-only, so any
    authenticated caller of the business may ask, like reading the records themselves. Measured on
    dev: ~10 ms uncached, ~0.01 ms cached. Pure cut-offs in `observed-shape.ts`.
  - The customer edit and subscription change screens replace the JSON textarea with an editor:
    one control per rule (enum → select, boolean → three-state select, number → bounded input,
    array with item values → chips, object → group), key/value rows with key and value
    suggestions for everything else, and an "Edit as JSON" view. The browser runs THIS module's
    `check.ts` (imported by `dashboard/lib/metadata-rules-check.ts`), so a refusal shows on the
    field before the save, in the API's own words.
  - Settings → Metadata rules lists observed paths with no rule; "Create rule" pre-fills the dialog.
  - Gated by `verify:metadata-rules` § P and `test/unit/metadata-{editor,observed}.test.ts`.
- **2026-10-08 (0333)** — Number rules gain `integer`, `min`, `max`; array rules gain `item_type`,
  `item_enum_options`, `min_items`, `max_items`. Additive columns, so a rule without them behaves as
  before. Proved on the `limit_overrides` shape in `verify:metadata-rules` § O.
- **2026-10-08 (0332)** — Module created: dot-path rules, object/array types, conflict refusal,
  strict mode per level, the `metadata_validation` switch (default off), every path optional.
