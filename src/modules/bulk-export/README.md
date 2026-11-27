# bulk-export — export a business's records as import-ready files

> Source: `src/modules/bulk-export/` · Routes: `src/api/export-routes.ts` · Schema: `db/schema/migration.ts` (`export_runs`, `export_parts`, migration 0552)
> Layer: tooling (see docs/architecture/architecture.json)

## Purpose
Self-serve bulk export of a business: plans and prices, add-ons, coupons, customers (with saved
card references), subscriptions, invoices, credit notes, payments and refunds, and usage, as one
zip of CSV files. Each file has the columns the file import reads (`bulk-import/templates.ts`), so
an export imports into another business as it is. Preview → start → background job → email →
download → files deleted after 7 days.

## Responsibilities
- Choose rows per record type (status, a date field and a range, archived or not), and with
  `include_related` add the records the chosen rows refer to (`writers.ts` `rowSet`): an invoice's
  customer, subscription and prices; a subscription's customer, prices and coupons; a refund's
  payment; a payment's or credit note's invoice. History refers down, never up, so the sets close
  without recursion. The sets are SQL subqueries; nothing is held in memory.
- Preview (no writes): records per file, how many the filters chose and how many came as related,
  the file's columns, and the first 10 rows as the file will have them.
- The `export_run` job: one `REPEATABLE READ` read-only transaction, so every file is the same
  moment; a cursor per file (1,000 rows a fetch); each page compressed and stored in 8 MB parts.
- Download: the zip is assembled from the stored parts with headers written around them (CRC and
  sizes are known when the file is written); one CSV is inflated from its parts. Both stream.
- Email the member who started it, emit `export_completed` / `export_failed`, audit
  `export.start`, `export.run`, `export.download` (each download) and `export.delete`.

## Data model
`export_runs` (0552): status queued → running → succeeded | failed; succeeded → expired (the
clock) | deleted (a member). `entities`, `filters`, `include_related`; `files` (per entity:
name, rows, related, crc, size, compressed, parts); `skipped` (rows the import cannot read, by
reason); `progress` while it runs; `snapshot_at`; `expires_at`; lease columns as in
`import_runs`. One queued or running export per business (partial unique index).
`export_parts`: (run, entity, seq) → raw-deflate bytes.

## Public surface
| Function | What it does |
|---|---|
| `previewExport` (`runs.ts`) | counts and sample rows, in one read-only snapshot |
| `createExportRun` | validate, insert queued, audit, queue `export_run` |
| `getExportRun` / `listExportRuns` / `deleteExportRun` | reads; delete the files now |
| `exportZip` / `exportFile` | the zip or one CSV, as async iterables of buffers |
| `runExportJob` (`runner.ts`) | the job |
| `requeueStalledExports` / `expireExports` | clock passes inside `reap_transfers` |
| `rowSet` / `fileQuery` / `toCells` / `invoiceRows` (`writers.ts`) | rows and their cells |
| `FileWriter` / `localHeader` / `centralDirectory` (`zip.ts`) | storage and the zip format |

## API routes
| Method · Path | Purpose |
|---|---|
| `POST /v1/businesses/:biz/exports/preview` | counts and sample (read scope) |
| `POST /v1/businesses/:biz/exports` | start (202); 409 while one runs |
| `GET /v1/businesses/:biz/exports` | past exports, newest first |
| `GET .../exports/:id` | the export, its files and progress |
| `GET .../exports/:id/file` | the zip |
| `GET .../exports/:id/files/:entity` | one CSV |
| `POST .../exports/:id/delete` | delete the files now |

Permissions: `exports:view` (reads, downloads) and `exports:manage` (start, delete), owner and
admin. Separate from `imports:*`: a role that may import is not always one that may take every
customer's data out.

## Events emitted
`export_completed`, `export_failed` (resource `export`, data `{ export }`).

## Dependencies
- **Upstream:** bulk-import (`ENTITY_FIELDS`: the columns), audit, events, emails, tenancy
  (`notPlatformOrg`).
- **Downstream:** the worker (`export_run`); the clock's `reap_transfers` pass.

## Invariants & gotchas
- **Import-ready.** The first columns of each file are `ENTITY_FIELDS[entity]` in order, in the
  import's formats: amounts in the currency's main unit, instants ISO 8601 UTC, lists with `|`,
  one row per subscription item and per invoice line. Read-only columns come after them
  (`EXTRA_COLUMNS`); the import maps an unknown column to nothing. `verify:bulk-export` proves the
  round trip: A's export imports into B with nothing blocked, and B's export equals A's.
- **History gets new ids on import.** Customers, subscriptions, prices and coupons keep the
  file's ids; invoices, credit notes and payments get new ones (the engine maps them by import
  record). The round trip compares those by their other columns.
- **Invoices.** Lines of kind `tax`, `discount` and `rounding` are not lines in the file: tax lines
  are the tax, and whatever else lies between the lines and the total is the discount (lines −
  discount + tax = total, as the import checks). Tax and discount go on the first line only.
  Drafts and invoices with no charge lines are left out, and counted in `skipped`.
- **Left out, with the reason in `skipped` and the README:** usage prices (a meter; the other
  business must have the price before its usage imports), pricing models the import cannot read,
  subscriptions in a state the import has no word for.
- **An empty file is left out**, because the import refuses a file with no rows; the README
  names the record types that had none.
- **Formula-safe text.** `platform/csv.ts` puts `'` before text that starts with `= + - @`; the
  import drops that `'` (`bulk-import/parse.ts`), so `+14155550100` survives the round trip.
- **One snapshot.** The read transaction stays open while the parts are written in their own
  transactions. It runs on the primary: a long query on a replica can be cancelled by recovery.
- **No zip64.** A file or the archive over 4 GB fails the export with a reason.
- **Expiry follows the platform-org rule:** `expireExports` skips the platform organization.
- **Usage needs a start date**, because it can be very large.

## Changelog
- **2026-11-27 (0552, feat/bulk-export-api)** — Module created: preview, start, background job,
  zip and single-file download, delete, 7-day expiry, related records, email, webhooks
  (`export_completed`, `export_failed`), audit, permissions `exports:view` / `exports:manage`.
  `verify:bulk-export` (45 checks, including the round trip).
