# bulk-import — import billing data from files

> Source: `src/modules/bulk-import/` · Routes: `src/api/import-routes.ts` · Schema: `db/schema/migration.ts` (`import_runs`, `import_rows`)
> Layer: tooling (see docs/architecture/architecture.json)

## Purpose
Self-serve import of a business's catalog, coupons, customers (with saved-card references),
subscriptions and their history (invoices, credit notes, payments and refunds, usage) from CSV
files (one per entity) or our JSON file. Upload → check → review → start
→ results → undo. Writes go through the migration engine (`modules/migration/import.ts`), so a
file import has the engine's guarantees: it never charges, each subscription renews for the
first time at its current term end, and re-runs are idempotent on the file's ids.

## Responsibilities
- Read CSV (RFC 4180, `,` `;` or tab, BOM) and our JSON file into `import_rows` at upload, so
  no object store is needed.
- Map columns to fields automatically (field keys and recognised header names, an entity
  prefix such as `customers.email` dropped, a trailing `(UTC)` dropped); a caller changes the
  mapping and checks again.
- Check every row (the `import_check` job): per-cell errors, duplicates, rows of one
  subscription that disagree, references to the other files or to the business, renewal dates,
  test-business limits. The review summary: rows per file (new, existing, invalid, excluded),
  MRR per currency, saved cards at connected and not-connected gateways, renewals, blockers
  and warnings.
- Run (the `import_run` job): check again, adopt the business's own records the rows refer to,
  then call the engine with a `StagedSource`; per-row results from the engine's `onRecord`.
- Undo (the `import_undo` job): reverse the opening ledger entries the run posted, then delete
  what it created; refused once billing touched it.
- The errors/results file: the uploaded file with `import_errors` (and `import_result`) added.

## Data model
`import_runs` (0550): one per upload. `status` uploaded → checking → checked → queued →
running → succeeded | partially_failed | failed → undoing → undone; `discarded` for a run that
never started. `files` (entity, filename, headers, mapping, rows), `options`, `summary` (the
check), `result` (the run), lease (`lease_token`, `heartbeat_at`, `lease_count`), who uploaded,
started and undid it. One queued/running/undoing run per business (partial unique index).
`import_rows`: one per data row — `raw` cells by column name, `parsed` values, `errors` and
`warnings` (`{ column, field, message }`), `state` at the check, `outcome` after the run.
`import_records.run_id` (0550): the run that created the target. Undo deletes only those.

## Public surface
| Function | What it does |
|---|---|
| `createImportRun` (`runs.ts`) | read the files into rows, map columns, queue the check |
| `recheckImportRun` | new mapping or options, check again (before the start only) |
| `startImportRun` | a checked run with no blockers; a live business needs `confirm` = its name |
| `undoImportRun` / `importUndoCheck` | queue the undo / what blocks it now |
| `discardImportRun` | throw away a run that has not started, with its rows |
| `getImportRun` / `listImportRuns` / `listImportRows` / `importRowsCsv` | reads |
| `analyze` (`check.ts`) | pure: rows + business context → row states and the summary (unit-tested) |
| `parseRow` (`parse.ts`), `parseCsv` (`csv-parse.ts`), `autoMap` (`templates.ts`) | pure |
| `StagedSource` (`source.ts`) | a `MigrationSource` over the checked rows |
| `runCheckJob` / `runImportJob` / `runUndoJob` (`runner.ts`) | the three jobs |
| `requeueStalledImports` | clock pass (inside `reap_transfers`): re-queue a run whose runner stopped |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/businesses/:biz/imports/templates/:entity` | a file's template (CSV, or `format=json` with each field's help) |
| `POST /v1/businesses/:biz/imports` | upload (`files[]`: entity, filename, content; `mapping`, `options`); 201, check queued |
| `GET /v1/businesses/:biz/imports` | past imports, newest first |
| `GET .../imports/:id` | the run, its summary and result; `undo_blockers` for a finished run |
| `GET .../imports/:id/rows` | rows (`entity`, `state`, `outcome`, `limit` ≤ 500, `starting_after`) |
| `GET .../imports/:id/files/:entity` | the file with `import_errors` / `import_result` |
| `POST .../imports/:id/check` | check again with a new mapping or options (202) |
| `POST .../imports/:id/start` | start (202); `confirm` for a live business |
| `POST .../imports/:id/undo` | undo (202); 409 with `reasons` when records are in use |
| `POST .../imports/:id/discard` | discard an unstarted run |

Permissions: `imports:view` (reads) and `imports:manage` (writes), owner and admin.

## Events emitted
None of its own. The engine runs with `suppressEmittedEvents`: imported records send no
webhooks and no emails. Audit: `import.upload`, `import.start`, `import.run`, `import.undo`.

## Dependencies
- **Upstream:** migration (engine, `ImportRecordOutcome`, `json-file` schema), audit, tenancy
  (test limits), emails (the end-of-run email to the member who started it).
- **Downstream:** the worker (`import_check`, `import_run`, `import_undo`; the clock's
  `reap_transfers` pass re-queues stalled runs).

## Invariants & gotchas
- **Nothing is written to billing data before the start.** The check reads the business and
  writes only `import_rows` and the run's summary.
- **Checked twice.** The run checks the rows again before it writes (time has passed; the
  business may have changed); a blocker then fails the run with the reason and writes nothing.
- **Source name per business:** `file:<business public id>`. The engine's import ledger is
  org-scoped by source name, so a shared name would make a second business's import skip
  every row (`assertImportLedgerFree`).
- **Adoption:** a record the rows refer to that is in the business but was never imported (a
  price made in the dashboard) gets an import record with no `run_id` before the engine runs,
  so the engine maps to it instead of creating a second one. Undo never deletes it.
- **"Existing" means kept as it is.** A row whose id is in the business is not updated. Update
  needs an engine change (the engine is create-only); it is the next step.
- **Past renewal dates are errors** (the clock would renew and charge at once); within 24
  hours is a warning, and `exclude_renewing_within_24h` leaves those out.
- **Undo checks, the foreign keys do not.** A customer delete cascades to invoices and
  payments, so `undoBlockers` refuses on any invoice, payment, transaction, payment attempt,
  credit note, ledger entry, usage, scheduled or pending change, later subscription or card,
  invoice line of an imported price, outside use of an imported coupon, or a change to an
  imported customer or subscription more than a minute after the run. The delete runs in one
  transaction. `mrr_movements` is append-only to the app role; its rows go with their
  subscription and customer by ON DELETE CASCADE, as in a test-business reset.
- Dates: a date alone is midnight in the business's time zone; a date-time with no offset is
  UTC (the way exports label their columns); unix seconds are accepted.
- Limits: 50,000 rows per file, 50 MB per upload. Not measured at scale yet.
- **History is archival** (the engine's Option A). Paid and void invoices, payments, refunds and
  used credit notes write no ledger entries. An open invoice opens receivables and a refundable
  credit note's available amount opens customer credit (`source_type = 'import'`).
- **Open invoices are not collected unless asked.** The staged source gives an open invoice
  `dunning.status = 'stopped'`, so no clock pass selects it; `collect_open_invoices` leaves the
  engine default (retries armed from the due date). The source may still be collecting it.
- **Undo never deletes ledger rows.** It posts the opposite of each opening entry
  (`source_type = 'import_undo'`, same `source_id`) and then deletes the documents. The run's own
  invoices, payments, credit notes and usage are left out of every activity check; a change to an
  imported invoice, a void or payout of an imported credit note, or a refund of an imported
  payment or credit note blocks the undo.
- **Invoice numbers.** The engine moves the business's next invoice number past the highest
  imported number; the check warns with the new number. Undo does not move it back.
- References for history: a payment or credit note names an invoice in the files or one an
  earlier file import into this business brought (stub, mapped by its import record); usage
  names a subscription in the files or in the business (adopted) and a usage price that is in the
  business (the files cannot create one).

## Changelog
- **2026-11-27 (feat/bulk-export-api)** — The end-of-import email links to the import page
  (`/imports?run=`; it named a page that does not exist). An undo that ends (or is refused) in the
  background emails the member who asked for it (`undone_by_user_id`, `undo_notified_at`, 0552).
  A cell that starts with `'` then `= + - @` is read without the `'`: our CSV writer adds it so a
  spreadsheet does not run the text as a formula, and bulk exports round-trip through it.
- **2026-11-26 (feat/bulk-import-history)** — History files: `invoices` (one row per line),
  `credit_notes`, `payments` (payments and refunds), `usage`. Check: invoice totals, references,
  the `history` summary block, open-invoice and numbering warnings; option
  `collect_open_invoices`. Undo reverses opening entries. `verify:bulk-import` scenario o (12
  checks), 4 unit tests.
- **2026-11-26 (feat/bulk-import-dashboard)** — Dashboard screen Settings › Import data (upload,
  review, start, results, undo, past imports). A running import writes `result.progress`
  (`done`, `total` new records) with its heartbeat every 2 s. Rows are listed, and loaded for the
  check and the run, in file order (entity, row number): ids are uuid v7, random within one insert,
  so ordering by id shuffled a file's rows. `verify:bulk-import` checks the order across pages.
- **2026-11-26 (0550, feat/bulk-import-api)** — Module created: upload, check, review summary,
  start, per-row results, errors/results file, undo, templates, JSON file, permissions, audit,
  end-of-run email. `verify:bulk-import` (55 checks) and `test/unit/bulk-import-check.test.ts`.
