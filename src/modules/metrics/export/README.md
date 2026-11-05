# metrics/export — the rows behind a figure

A report answers "what did we bill this quarter". The next question a finance team asks is
"which invoices", and until this module the only way to ask it was the list API with
hand-built filters — which does not know what window the report used. Two windows, one
number: they agree until they do not, on exactly the edges nobody checks.

So the contract here is an equality, not a route:

> **Σ `reporting_amount_minor` over the exported rows = the headline of the report the
> dataset declares, exactly, in integer minor units.**

`scripts/verify-raw-export.ts` is that equality, asserted per dataset.

## How it holds

- **The window comes from `buildBuckets`** — the report layer's own bucket builder, reached
  through `exportWindow()`. Never re-derived from the range name; a second copy of the range
  arithmetic is how an export ends up explaining a number it does not equal.
- **The filters are the report's filters.** `invoices` takes the billed statuses
  `total_billing` sums; `payments`/`refunds` take successful transactions of that type;
  `mrr_movements` takes every movement, signed, as `net_mrr_growth` does.
- **A row no exchange rate reaches is excluded**, because the report excludes it. Including
  it unconverted would break the equality it exists to prove; the per-currency totals leave
  it out too, so nothing silently half-counts it.

## Currency

Every money column stays in the currency it was earned in. Beside it the row carries
`reporting_currency`, `reporting_rate` (units of the row's currency per one of the reporting
currency; null when they are the same) and `reporting_amount_minor` — the converted figure
the report actually summed. A reader can therefore check the conversion, not just accept it.

`totals_by_currency` is per currency and there is **no total across them**. A mixed-currency
raw sum adds paise to cents and is true of nothing.

## Bounding

Keyset pagination on `(timestamp, id)` — the sort instant plus the row id — so page 600 costs
what page 1 costs and a page is a range scan on an index the table already carries. A page is
capped at `MAX_PAGE`. The CSV is an async generator that walks the same cursor, so at most one
page exists in memory whatever the tenant's size: the real book carries thousands of payments
on a single business, and an export that concatenates them all holds the whole answer before
it sends a byte.

The cursor carries the instant as **Postgres' own text**, not as a JS `Date`: the column keeps
microseconds and a `Date` keeps milliseconds, so a round-tripped cursor truncates and `>` then
re-reads every row inside that millisecond. Found on the real book, where it duplicated
invoices across a page boundary and put the export 263,606 minor units ABOVE the report it
exists to equal. `verify:raw-export` pins the cursor against the database's own rendering.

An empty window returns the header and no rows. A file with no header reads as a broken
export; a header with nothing under it reads as a quiet period, which is what it is.

## Changelog

- **2026-10-24** — **CSV cells cannot run as formulas.** Text that starts with `= + - @`, a tab or a
  carriage return gets a leading `'`; numbers and plain decimals (`-12.50`) are unchanged. All engine
  CSV (raw export and `?format=csv` reports) goes through `platform/csv.ts`; the dashboard's
  exports use `dashboard/lib/csv.ts`, the same rule. Test: `test/unit/csv-formula-injection.test.ts`.
- **2026-09-18** — Module added. Four datasets (`mrr_movements`, `invoices`, `payments`,
  `refunds`), each reconciling with `net_mrr_growth`, `total_billing`, `total_payments` and
  `total_refunds`. Routes: `GET /v1/businesses/:biz/raw_export` (the catalogue) and
  `GET /v1/businesses/:biz/raw_export/:dataset` (the rows, JSON pages or streamed CSV).
