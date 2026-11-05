# segments

Customer **segments**: a saved, named POPULATION, defined as a filter set over customer
attributes. Phase 7 of the reports programme, and what "compare segments" charts a
metric across.

## ⚠️ The vocabulary, which is load-bearing

Three words, three things, and they may not be swapped:

| word          | means                                                     | owned by                               |
| ------------- | --------------------------------------------------------- | -------------------------------------- |
| **view**      | a saved filter over a LIST of rows on a screen              | `modules/list-views`                   |
| **attribute** | a stored dimension a report is computed by or filtered on   | `modules/metrics/reports`, and here    |
| **segment**   | a named population, compared on a metric                    | this module                            |

A view and a segment are both "a saved filter", which is exactly why they need
different words: the first narrows a screen, the second decides who a figure is
_about_. `docs/PROGRESS.md` § 4c settled it before a line of this was written. The word
"view" appears nowhere in this module; the metrics module calls a report dimension an
attribute and never a segment; the word "segment" is this module's alone.

(The one place the collision survives is `list_views`' own prose, which still describes
itself as "a saved list view, or segment" in its schema comment and README. That file
is not this module's to change — flagged rather than edited.)

## Why it exists

Every report answered for the whole business. "The same figures, for customers in
Germany" or "for the accounts over $250 a month" had no answer, and an operator who
wanted one rebuilt the same five filter rows every morning on the customers list, then
had nowhere to keep them.

## How it works

**One filtering path, not two.** A segment's predicate is stored as `field / op / value`
triples in exactly the grammar the customer list API takes (`?<field>[<op>]=<value>`),
and it is handed to `listCustomersPage` unchanged. What validates a write is the list's
own allow-list — `CUSTOMER_FILTER_OPS` / `CUSTOMER_FILTER_KINDS`, merged with the
business's `cf_*` custom fields, which is the same pair `list-views/entities.ts`
validates a saved view against. A hand-kept second copy would drift, and the drift shows
up as a segment that 400s months after it was saved.

**The count and the money come from the same conditions as the rows.**
`customerSegmentTotals` and `listCustomersPage` both build their WHERE through
`customerFilterConditions`, so the summary above a table can never disagree with the
table. A screen that sums the page it happened to load is quietly wrong on any business
with a fifty-first customer.

**MRR is returned BY CURRENCY, always.** `subscriptions.mrr` is minor units of each
subscription's own currency, so one figure over a mixed book adds cents to paise. A
segment that filters on `mrr` must resolve to a single currency — pin one with a
`currency` filter, or the segment is refused by name. A single-currency book needs no
such filter, which keeps "High MRR" usable out of the box on the common case.

**A refusal names the attribute and says why.** `REFUSED_ATTRIBUTES` in `attributes.ts`
carries a sentence per attribute we do not have, because "High LTV is refused: no
per-customer lifetime value is stored, `customer_lifetime_value` is a book-level ratio"
is something an operator can act on and "invalid filter" is not. The alternative —
answering by reconstructing the book per segment on every read — is what § 4c refused,
and it is slowest on exactly the book big enough to need segmenting.

## The starter library

Ten definitions ship in `starters.ts`: **Active customers · Trialing · Delinquent ·
Cancelled customers · Annual plans · High MRR · Low MRR · Multi-subscription · Recent
signups · Recently cancelled**. An empty segment list teaches nobody what the feature is
for.

They are **code, not seeded rows**: a business created tomorrow has them, a starter
cannot be half-deleted, and improving a definition is a code change rather than a data
migration. They are read-only; Duplicate copies one into a stored segment the operator
owns, and `starter_key` records where it came from so a later improvement to the starter
does not silently rewrite somebody's copy.

Two thresholds are numbers and they are stated rather than hidden: `High MRR` and
`Low MRR` compare **minor units** (25,000 and 5,000), so the same round number is $250
on a USD book and ₹250 on an INR one. The screen formats the threshold in the resolved
currency rather than printing a symbol the definition does not carry.

## What is NOT filterable, and why

- **LTV / lifetime value** — no per-customer figure is stored. `customer_lifetime_value`
  is a book-level ratio (average revenue ÷ churn rate), so putting it on a customer row
  would repeat one number for everybody and call it theirs. The approved design carried
  an LTV column; it is **omitted** rather than faked.
- **total paid** — would have to be summed over every transaction on every read.
- **plan** — a plan is a property of the subscription, not the customer. Filter by
  `subscription_billing_period_unit` for the cycle, or segment the subscriptions list.
- **usage, health score, last login** — not recorded at the customer grain at all.

One trap worth knowing: `subscription_status` is an EXISTS over the STORED
`subscriptions.status`, which never holds `non_renewing` — that value is derived at the
API boundary. The attribute registry deliberately omits it from that field's options and
points at `non_renewing_subscription_count`, which counts the derived status.

## Surface

| route                                                    | notes                                                 |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `GET  /v1/businesses/:biz/customer_segments`             | starters first, then saved                            |
| `GET  /v1/businesses/:biz/customer_segments/attributes`  | the filter builder's field list, served not mirrored  |
| `GET  /v1/businesses/:biz/customer_segments/:seg`        |                                                       |
| `GET  /v1/businesses/:biz/customer_segments/:seg/customers` | one page + `total` + `mrr_by_currency`             |
| `POST /v1/businesses/:biz/customer_segments`             | `Idempotency-Key`                                     |
| `PATCH /v1/businesses/:biz/customer_segments/:seg`       | `Idempotency-Key`; a starter is read-only             |
| `DELETE /v1/businesses/:biz/customer_segments/:seg`      | `Idempotency-Key`; a starter cannot be deleted        |

Tenant-scoped like everything else: `organization_id` + `business_id`, with RLS
(`org_isolation`) on `customer_segments`. `business_id` is NOT NULL here, unlike
`list_views.business_id`, because a customer belongs to exactly one business and there
is no org-level customer population for a NULL to mean.

Gate: `pnpm verify:segments`.

## Changelog

- **2026-11-03** — A filter field is matched against own keys only: `constructor` on preview was a 500, now a 400.

- **2026-09-30** — Members list accepts `offset` (alias of `starting_after`, for `next_offset`). Preview still refuses `include_deleted`: it hides archived customers and cannot widen.

- **2026-09-24** — **Preview evaluates the population once, not three times.** `resolveSegment`
  counted it twice (the list's first-page total and `customerSegmentTotals`) and filtered it a
  third time for MRR; with per-customer subscription counts each pass walks every customer.
  `segmentTotals` now materializes `customerPopulationSql` once for both the count and the MRR,
  with `jit = off` (compiling cost as much as running at book scale), and the list is asked for
  its first page through its own `o:0` cursor so it skips its count. Answers unchanged.

- **2026-09-23** — **High/Low MRR work on multi-currency books.** The `mrr` refusal is no longer
  "several currencies" but "a held currency with no rate" (`mrrFilterRefusal`, shared with the
  customer list): thresholds are minor units of the business's default currency, converted
  per subscription. `verify:segments` §E proves it on a USD/INR/EUR book, mutation-tested.

- **2026-09-25** — **"Coupon or discount used" attribute** (`has_used_discount`, bool, `is`).
  An EXISTS over `applied_coupons` joined to the customer's subscriptions, any status and either
  source (coupon or manual), so a removed or used-up discount still counts. Added to the
  customer list's own `VIRTUAL_FILTERS`, so the list API, saved views and segments share it.
  Covered by `verify:metric-dimensions` §3, mutation-tested.

- **2026-09-23** — **Segments answer measures.** `segmentPopulation` resolves a segment for
  analytics with the same checks `resolveSegment` makes. `segment=` on `/v1/analytics` and the
  batch, and `segment_id` on dashboard tiles (0276), answer the ledger-derived measures for that
  population; see `metrics/daily/segment-series.ts`. Membership is today's. A tile's segment is
  resolved when the tile is SAVED (and still on read), and the list carries `answerable` +
  `refusal` per segment for that business (`segmentRefusals`) — an unpinned `mrr` threshold on a
  multi-currency book (the High/Low MRR starters) is a dead end, and now says so up front.

- **2026-09-22** — created. Phase 7. Adds `customer_segments` (migration 0272), the
  starter library, the attribute registry with named refusals, and the
  `reports/customers` screen. Three customer attributes were added to the list's own
  allow-list to make the starters expressible — `mrr`, `subscription_billing_period_unit`
  and `subscription_cancelled_at` (the first date-kind virtual filter, which is why
  `existsDateCondition` exists in `platform/list-query.ts`) — and
  `customerFilterConditions` was extracted in `customers/service.ts` so the totals and
  the rows are answered by one condition builder.
- **2026-11-05** — `segment_facts.last_order_at` (the last one-time order); the segment table shows "Last order <date>" for a buyer with no subscription.
