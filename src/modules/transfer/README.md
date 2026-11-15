# transfer — configuration transfer + sample data

> Source: `src/modules/transfer/` · Routes: `src/api/transfer-routes.ts` · Schema: `db/schema/transfer.ts`
> Layer: tooling (see docs/architecture/architecture.json)

## Purpose
A promote-to-live mechanism: copies **catalog (incl. meters, credit units, rate cards), coupons,
tax, settings, company profile and email sending** between two businesses of one organization
(test↔live, live↔live). The dashboard path is asynchronous: a persisted **plan** (one item per
object or setting, with its action and diff) that the member reviews, then an **apply** that the
`transfer_run` job runs item by item with persisted progress. The legacy synchronous run stays
for the API. Plus test-business sample-data tools. Never transfers customers/subscriptions/
invoices/gateway creds/keys/webhooks/email templates, and never any secret.

## Responsibilities
- Preview a transfer: per pair, every field from → to (secrets masked), the tax plan, the blockers,
  and a `plan_digest` (`plan.ts`).
- Run a transfer job copying the selected sections source → destination; report per-section counts.
  Optionally the test twins in the same run (test pair first).
- Sample data: create/delete demo content on a test business.
- Reap stuck transfer jobs.

## Data model
`db/schema/transfer.ts` — `transfer_configurations`: one row per run. `run_kind` `sync` (legacy:
status running/succeeded/failed, per-section report) or `async` (0517: status planned → queued →
running → succeeded | partially_failed | failed | cancelled, or superseded; conflict policy,
validation, counts, who planned/started/cancelled, timings, the runner's lease).
`transfer_items` (0517): one row per object or setting of an async plan — action, exclusion,
dependencies, diff, messages, fingerprint, status, skip reason, error, and `replaced` (the
destination values an update replaced: the undo record). Unique `(transfer_id, pair, key)`.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `previewTransfer` | the field-by-field plan of each pair; writes nothing |
| `listTransfers` | past runs, newest first, twins nested; per business or organization-wide |
| `runTransfer` | preflight (blockers, live-override checks), then one transaction per pair |
| `getTransfer` | job status + per-object report |
| `createSampleData` / `deleteSampleData` | test-business sample content |
| `reapStuckTransfers` | fail a crashed sync run; re-queue a stalled async run (`requeueStalledRuns`) |
| `createTransferPlan` (`runs.ts`) | plan both pairs as items and store them; supersedes the pair's open plan |
| `getTransferRun` / `currentTransferRun` | a run with its summary and (unless `items: false`) its items with their effective (dependency) state / the open plan or active run of a source |
| `listTransferItems` | one page of a run's items in plan order; section, result, status and label filters in SQL |
| `setItemExclusions` | leave items out of an open plan, or put them back |
| `applyTransferPlan` | re-validate (blockers, drift, live override), skip what does not write, queue the job |
| `cancelTransferRun` / `retryTransferRun` | stop after the current item / re-queue failed + dependency-skipped items only |
| `runTransferJob` (`runner.ts`) | the `transfer_run` task: lease, drift check, per-item transaction, finish, audit, email |
| `planPairItems` (`items.ts`) / `applyItem` (`apply.ts`) | plan one pair as items / apply one item |
| `graph.ts` | pure rules: order, dependency blocking, live-override need, counts, result per item, run summary, end state (unit-tested) |

## API routes
| Method · Path | Purpose |
|---|---|
| `POST /v1/businesses/:biz/transfer_configurations/preview` | preview a transfer (no writes) |
| `POST /v1/businesses/:biz/transfer_configurations` | run a transfer |
| `GET /v1/businesses/:biz/transfer_configurations` | history (`scope`, cursor paging) |
| `GET .../transfer_configurations/:job` | job status; an async run with its `summary` and items (items and blockers for an all-mode caller; `items=none` leaves the items out) |
| `GET .../transfer_configurations/:job/items` | one page of an async run's items (`section`, `result`, `status`, `q`, `limit` ≤ 500, `starting_after`); all-mode only |
| `POST .../transfer_configurations/plans` | build and store a plan (async) |
| `POST .../transfer_configurations/:job/items` | leave items out / put them back (open plan only) |
| `POST .../transfer_configurations/:job/apply` | validate again and queue (202); `confirm` = destination name when live records change |
| `POST .../transfer_configurations/:job/retry` | re-queue failed items only (202) |
| `POST .../transfer_configurations/:job/cancel` | stop after the current item |
| `POST/DELETE /v1/businesses/:biz/sample_data` | sample data (test-only) |

## Events emitted
None.

## Dependencies
- **Upstream (calls into):** audit, auth (roles), catalog, coupons, customers, emails (deployment mailer for the end-of-run email), invoicing (numbering separators), tax.
- **Downstream (called by):** the worker (`transfer_run`, `reap_transfers`), assistant-tools (`get_transfer_status`).

## Invariants & gotchas
- **Async apply is per item, never all-or-nothing.** Each item's write and its `done` commit in
  one transaction, so a killed worker leaves each item applied or not; the next runner resumes.
  One runner per run (lease token + heartbeat, stale after 90s); the clock's `reap_transfers` pass
  re-queues a run whose heartbeat stopped. A failed item skips its dependants
  (`skip_reason = dependency`); a failed twin item skips the whole live pair.
- **Validation runs three times**: at plan, at apply (full re-plan; any fingerprint or action that
  moved → 409 "check the changes again"), and at every lease (items still to apply). Blockers stop
  the apply; warnings do not. Rules: `items.ts` and `plan.ts`, listed in `docs/PROGRESS.md`.
- **Conflict policy per section**: `skip` | `update`; test default update, live default skip. Any
  update/delete on a live destination needs `transfers:live_override` + the typed name. A live
  price or meter that live subscriptions bill from cannot take a billing change (blocked item).
- **References are remapped by natural key**: a product's tax profile by name, a price's meter by
  key and credit unit by key, a rate card with its price. A coupon's `times_redeemed` starts at 0.
- **Secrets are never copied** (both paths): SMTP/SES credentials stay with each business. A copied
  enabled transport the destination has no credential for blocks a live destination, warns a test one.
- One active async run per destination (unique partial index + a check covering the twin destination
  and a running sync run).
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
- **2026-11-10 (0517, feat/transfer-async)** — Async transfers: persisted plans with item-level
  actions, diffs, dependencies, exclusions and per-section conflict policy; validation with
  blockers and warnings, re-checked at apply and at job start; the `transfer_run` job (lease,
  resume, cancel, retry failed only, one active run per destination); audit `transfer.apply` /
  `transfer.cancel` / `transfer.retry` / `transfer.run` | `transfer.live_override`; email to the
  member who started it; undo record (`transfer_items.replaced`). Meters, credit units and rate
  cards are copied; tax-profile and meter references are remapped (they pointed at the source's
  rows). Behaviour changes on BOTH paths: SMTP/SES secrets are no longer copied; a coupon's
  `times_redeemed` is no longer copied. Billy reads status through `get_transfer_status`.
- **2026-11-10** — Async transfer hardening (`verify:transfer-async`): a test destination without
  the credential gets a copied SMTP/SES transport switched off (an enabled one broke
  `businesses_*_config_ck`); switching one transport on switches the other off in the same write;
  differential prices match on currency too (key `dprice:<addon>@<plan>@<cur>@<interval>`, in
  the sync copy as well); a clear-first the destination's rows refuse is blocked at plan time
  (probed in a rolled-back savepoint) and every item of a cleared section depends on its clear;
  an unexpected item error shows a neutral message (detail in the log); the runner frees its
  lease on an error; the clock re-queue no longer passes a `Date` in raw SQL; a retry of live
  updates needs `confirm`; a drift 409 carries `code: "transfer_drift"`; the list takes
  `run_kind` and `direction`; the gateway warning shows once per currency.
- **2026-11-12** — A plan stores its items in INSERTs of 500 rows, and every update by item id
  binds the ids as ONE `uuid[]` parameter (`itemIdIn`). One INSERT of every item bound 16
  parameters per item: a business with 5,044 coupons (~10.6k items, ~170k parameters) made the
  plan 500 with `Maximum call stack size exceeded` in the query builder, and anything past 65,535
  parameters is refused by Postgres anyway. The exclude and apply scans use Sets (they were
  quadratic). `verify:transfer-async` s: a 5,000-coupon plan stores, excludes, applies, reads back.
- **2026-11-12 (feat/transfer-plan-paging)** — Large plans page instead of shipping whole. A run
  view carries `summary`: counts per result (new, updated, deleted, unchanged, kept, blocked, left
  out, by `resultOf`), the same per pair × section with the progress of the queued items,
  `retryable`, and the open blockers with their messages. `?items=none` (GET and every write
  route) leaves the items out; the default response is unchanged. New
  `GET …/:job/items` pages them in `seq` order with `section`, `result` (a kind or `changes`),
  `status` (`queued`, `open`, `done`, `failed`, `skipped`), `q` (label, case-insensitive, `%`/`_`
  literal) and `limit` (100, max 500). Filters run in SQL on `(transfer_id, seq)`; the effective
  blocked set comes from one scan of the light columns (no diff), bound as one `text[]`. No
  migration. The dashboard loads the counts and the first page only (5,000-item run: see
  PROGRESS for the bytes) and pages with "Show more".

- **2026-11-12 (feat/transfer-plan-paging, redesign)** — `result=changes` is now exactly the
  items that write: `new`, `updated` and `deleted` (it used to be every result but `unchanged`,
  so blocked, kept and left-out items were in it). Each `summary.sections[]` carries `applied`:
  the done items by result (`new`, `updated`, `deleted`), so a finished run reports what it
  wrote, not what it planned. The dashboard page is three URL tabs (`?tab=copy|history|test`):
  a From/To route band with the destination picker, a read-only step bar driven by the run
  status, section cards with the "in both" choice inline, outcome tabs with counts, a section
  list, an opened row showing only the changed fields, blocked items pinned with "Leave out
  blocked items", one sticky action bar; "Repeat" is `?tab=copy&repeat=<id>` and "View"
  `?tab=copy&run=<id>`. `verify:transfer-async` s: changes lists only writes and drops
  left-out items; `applied` counts the copied coupons.
