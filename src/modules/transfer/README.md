# transfer — configuration transfer + sample data

> Source: `src/modules/transfer/` · Routes: `src/api/transfer-routes.ts` · Schema: `db/schema/transfer.ts`
> Layer: tooling (see docs/architecture/architecture.json)

## Purpose
A promote-to-live mechanism: a job that copies **catalog, coupons, tax, settings, company profile and
email sending** between two businesses of one organization (test↔live, live↔live), with a
field-by-field preview first, plus test-business sample-data tools. Never transfers
customers/subscriptions/invoices/gateway creds/keys/webhooks/email templates.

## Responsibilities
- Preview a transfer: per pair, every field from → to (secrets masked), the tax plan, the blockers,
  and a `plan_digest` (`plan.ts`).
- Run a transfer job copying the selected sections source → destination; report per-section counts.
  Optionally the test twins in the same run (test pair first).
- Sample data: create/delete demo content on a test business.
- Reap stuck transfer jobs.

## Data model
`db/schema/transfer.ts` — transfer job rows (sections, direction, wipe flag, status, per-object report).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `previewTransfer` | the field-by-field plan of each pair; writes nothing |
| `listTransfers` | past runs, newest first, twins nested; per business or organization-wide |
| `runTransfer` | preflight (blockers, live-override checks), then one transaction per pair |
| `getTransfer` | job status + per-object report |
| `createSampleData` / `deleteSampleData` | test-business sample content |
| `reapStuckTransfers` | recover stalled jobs |

## API routes
| Method · Path | Purpose |
|---|---|
| `POST /v1/businesses/:biz/transfer_configurations/preview` | preview a transfer (no writes) |
| `POST /v1/businesses/:biz/transfer_configurations` | run a transfer |
| `GET /v1/businesses/:biz/transfer_configurations` | history (`scope`, cursor paging) |
| `GET .../transfer_configurations/:job` | job status |
| `POST/DELETE /v1/businesses/:biz/sample_data` | sample data (test-only) |

## Events emitted
None.

## Dependencies
- **Upstream (calls into):** audit, auth (roles), catalog, coupons, customers, emails (SMTP/SES
  secret envelopes), invoicing (numbering separators), tax.
- **Downstream (called by):** none.

## Invariants & gotchas
- **Asymmetry:** `wipe_destination` is only honored when the destination is a **test** business.
  A **live** destination is merge-only: catalog and coupons skip what exists, tax creates only new
  profiles, and settings / company profile / email sending / numbering write nothing.
- **Live override** writes those four (plus tax updates) into a live destination. All of: a
  signed-in owner or admin (`operatorRole`; an API key can never grant it), `confirm` equal to the
  destination's name, and a `plan_digest` that still matches the plan rebuilt under a row lock.
  Catalog and coupons stay merge-only even then. Audit action `transfer.live_override`, with every
  field's before/after (secrets as `••••`).
- **Never copied by any section:** name, currency, the number prefixes (only `numbering` sets them,
  after a clash check), counters, branding, contact details, timezone, email templates, the email
  `subjectPrefix`/`footerNote`, and the storefront `default_return_url` / `default_cancel_url` /
  `portal_link_error_html` (they point at the destination's own site).
- **Tax components are updated in place** by `(state_code, name)`: `applied_taxes.tax_component_id`
  is ON DELETE SET NULL, so a delete + re-insert detaches issued invoices. A destination-only
  component that an issued invoice uses blocks a live run.
- Every pair re-plans after writing; a difference left over rolls the pair back.
- **One run per destination at a time**: the job insert locks the destination row(s) and refuses
  (409) while a `running` job younger than the reaper cutoff targets them.
- **Blockers carry their section** (`{ section, message }`), so a caller can leave that section
  out and preview again. A clear-first (`wipe_destination`, test only) is planned too: the preview
  reports `clear_first` and `objects.deleted`; the post-write self-check re-plans without it.
- **Never** transfers customers, subscriptions, invoices, payments, gateway accounts, API keys, webhooks.
- Requires an `all`-mode key / portal admin (spans both partitions).

## Changelog
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-05** — The `tax_rates` section now copies the whole FOUR-LEVEL tax configuration —
  profiles → regions → components → state registrations — matched on natural keys (profile name,
  region country, component state+name, registration state) since every level's `public_id` is
  globally unique. A region's component vector is replaced WHOLESALE rather than merged row by row:
  a dest keeping a stale `IGST 1800` beside a freshly copied `CGST 900 + SGST 900` would tax an
  inter-state supply at a rate nobody configured, so `skip_existing` skips a region entirely.
  Clearing the section deletes the profiles and lets the cascade do the rest.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-10-04** — The `attached_items` section copies attached charges as well as add-ons
  (column `item_product_id`, 0324).
- **2026-10-16** — The dashboard preselects the business's other mode (its twin) as the destination.
- **2026-10-22** — `copyTaxRates` and the settings field list (`COPIED_SETTINGS_FIELDS`,
  `settingsFrom`) are exported, so the ops script `scripts/copy-business-settings.ts` reuses
  them instead of a second copy. Behaviour unchanged; the live-destination guard is untouched.
- **2026-10-22** — The ops script's logic moved into the product and the script was retired.
  New: `previewTransfer` + `POST …/transfer_configurations/preview`, sections `company_profile` and
  `email_sending` (opt-in), `numbering`, `include_test_twins`, and the audited `live_override`
  (0358 adds `live_override`, `plan_digest`, `options`, `twin_of` to the job row). Behaviour
  changes: the settings copy no longer copies the source's prefixes or its storefront return/cancel
  URLs and portal error text; tax components are reconciled in place instead of replaced.
  Same day: history (`listTransfers`, `GET …/transfer_configurations`), the one-run-per-destination
  check, section-tagged blockers, and clear-first in the preview. The dashboard became a
  check-then-copy flow with a "Past copies" table.
- **2026-10-25** — The live override is granted by the `transfers:live_override` permission
  (owner and admin among fixed roles) instead of a hard-coded role list; routes pass
  `operatorPermissions`.
- **2026-11-03 (slice F)** — A settings copy keeps the destination's `dunning_config.plan_policies` (dunning policies are not copied).
- **2026-11-03 (0489)** — The company-profile section also copies `tax_settings`.
