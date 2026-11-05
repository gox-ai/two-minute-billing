# metering — usage ingestion + aggregation

> Source: `src/modules/metering/` · Routes: `meter-routes.ts`, `usage-event-routes.ts` (and the older usage paths) · Schema: `db/schema/usage.ts`, `db/schema/meters.ts`, `db/schema/usage-events.ts`
> Layer: billing (see docs/architecture/architecture.json)

## Purpose
Ingests usage records idempotently and aggregates them for usage-priced subscription items, so metered
billing can bill in arrears at period close. The aggregated quantity feeds the invoice pipeline.

## Responsibilities
- Record usage events (idempotent by caller-supplied id).
- Aggregate usage over a period per aggregation function (sum/max/last/count/min/avg/unique).

## Data model
`db/schema/usage.ts` — `usage_records` (subscription item, quantity, timestamp, idempotency). Aggregation
function comes from the price (`usageAggregation`).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `recordUsage` | idempotent usage ingestion for a subscription item (`operation` add/remove) |
| `aggregateUsage` | one window aggregate, no carried level (tests and legacy callers) |
| `aggregateMeteredQuantity` (`measure.ts`) | the billed quantity for any aggregation, recurring and weighted_sum included |
| `measureMetered` (`measure.ts`) | the same with the level; dispatches on a `MeterSource` (`item` today) |
| `rateMeteredItem` / `rateSubscriptionUsage` (`rating.ts`) | measure, then price (`rateMeteredQuantity`); the one rating path for invoicing, settlement and usage views |
| `recurringLevel` / `timeWeightedLevel` (`levels.ts`) | pure level math |
| `createMeter` / `updateMeter` / `archiveMeter` / `addUsageKey` / `removeUsageKey` (`meters.ts`) | meters and customer usage keys; a used meter changes only its name |
| `ingestUsageEvents` / `voidUsageEvent` (`ingest.ts`) | validate, dedup by (business, key), store in one transaction; `registerIngestHook` runs after the insert |
| `listUsageEvents` (`events-list.ts`) | the event list API, newest received first |
| `runUsageFold` / `foldBusiness` (`fold.ts`) | the `usage_fold` cron: matching, 15-minute rollups, backfill; `registerFoldHook` runs in each fold transaction |
| `readMeterUsage` / `readMeterEvents` / `takeUsageCutoff` (`read.ts`) | exact reads: rollups inside the window, raw edges and tail |
| `rateMeterItem` (`meter-rating.ts`) | rates a meter price per combination of group values, plus late usage (builder B) |
| `ensurePartition` / `requireUsagePartitions` (`partitions.ts`) | monthly partitions on demand and the boot check |
| `runUsageRetention` (`archive.ts`) | archive, then drop, partitions older than `USAGE_EVENTS_LIVE_MONTHS` |
| `runUnmatchedNotice` (`notice.ts`) | the hourly `usage_event_unmatched` notice |

## API routes
Recorded via `POST …/subscriptions/:sub/usage` (`subscription-routes.ts`); listed, retrieved and deleted via `…/usages` (`usage-routes.ts`).

## Events emitted
`usage.recorded` (emitted from the invoicing/metering path; throttled per aggregation window, not per record).

## Dependencies
- **Upstream (calls into):** none.
- **Downstream (called by):** invoicing, subscriptions.

## Invariants & gotchas
- Usage bills **in arrears** at period close; the aggregated quantity becomes the item quantity.
- Idempotent ingestion — a repeat with the same `idempotency_key` and the same values returns the
  first record; different values throw `UsageIdempotencyConflictError` (409). The route also runs the
  request-level idempotency middleware; a body key with no header becomes `usage:<item>:<key>`.
- The API refuses (`checkWindow`, `UsageOutsideWindowError` → 400) a timestamp no future invoice
  bills: before the current term start (lowered to an open pending invoice's `usage_window.start`,
  raised to a closed pending window's end or a finalized usage line's end), before the subscription
  start, or more than 5 minutes after `stampNow` (the time-travel clock applies). Direct service
  callers skip the check. During a trial the window starts at the trial start.
- A usage record outlives its item: removing the item detaches it (`subscription_item_id` null,
  `subscription_id`/`price_id` set, 0371). Readers resolve both through `coalesce(record, item)`.
- Prepaid credit lots with expiry (usage drawn from lots) are **not** modeled — a deferred item.

## Changelog
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-30** — Usage records can be read and corrected: `GET /v1/businesses/:biz/usages` (scope `subscription`/`item`/`price`; filters `usage_date`, `created_at`, `invoiced`, `invoice`; keyset paging), `GET …/usages/:id`, and `DELETE …/usages/:id` (`listUsagePage`, `getUsage`, `deleteUsage`, routes in `src/api/usage-routes.ts`). A record is locked (`UsageInvoicedError` → 409) once a finalized invoice carries a `usage` line whose window holds its timestamp; a `pending` invoice re-aggregates at close, so it does not lock. Optional `note` (≤500 chars, 0305) on create, stored and returned; the create response adds `note` only when set. Proof: `verify:usage-api` §1.
- **2026-10-24** — Usage POST is idempotent end to end and refuses timestamps no invoice will bill. Before, a reused `idempotency_key` with a new quantity answered 201 with the old record, and a backdated timestamp in an invoiced period was stored, never billed and not deletable (409). Now: 409 `idempotency_error` on a changed payload; 400 naming the accepted window for an invoiced period, a time before the subscription start, or more than 5 minutes ahead; 400 `idempotency_required` with neither a header nor a body key. Proof: `verify:usage-api` §1 O–Q, §6–§8.
- **2026-10-24** — **Usage survives item removal (0371).** `usage_records.subscription_item_id` is `ON DELETE SET NULL`; the `subscription_items_detach_usage` trigger (BEFORE DELETE) first copies the item's `subscription_id` and `price_id` onto its records. Deleting the subscription itself still deletes them. The usage API lists a detached record under its subscription with `item: null` (`price` and `invoice` kept), and a billed one still refuses DELETE (409). No renewal rates a detached record: `removeSubscriptionItem` does not settle the current period's usage first (plan-swap removals do). Cover: `verify:usage-item-removal`.
- **2026-10-25** — **Recurring and time-weighted usage (0379).** `usage_records.operation` (`add` default, `remove`): a remove takes a `unique_key` off a unique metric (400 on any other aggregation or without a key); a negative quantity is accepted only for a recurring sum or a weighted_sum price (`usageEventIssue`, `UsageRuleError` → 400); the idempotent replay compares `operation`. A price with `usage_recurring` measures a level from all history before the window end: sum (deltas) and max bill the peak, last bills the closing level, unique bills the peak count of active keys; events at one instant apply together, so a swapped seat counts once; a negative level bills 0 but keeps its value. `weighted_sum` bills ∫ max(0, level) dt in unit-hours or unit-days, rounded half-up once per window. The level belongs to the subscription item (a swap on the item keeps it; a new item starts at 0). Non-recurring `unique` counts keys with an add. `DELETE …/usages/:id` refuses a recurring record before the open window (`UsageLevelLockedError` → 409). `usageWindowStart` moved to `subscriptions/usage-window.ts`. `serializeUsage` adds `operation`. Cover: `verify:recurring-usage`, `test/unit/metered-rating.test.ts`.
- **2026-10-25** — Usage so far is read through this module's rating (`rateMeteredItem`, `measureMetered`) by `subscriptions/current-usage.ts`; routes `GET …/subscriptions/:sub/current_usage` and `GET …/customers/:cus/current_usage` live in `src/api/usage-routes.ts`. Nothing here changed.
- **2026-11-01** — **Usage events and meters (Tier 3 PR 1a, 0450–0452).** Meters (`meters.ts`): sum, count, min, max, avg, last, unique, weighted_sum, with filters and group_by; after the first event or price only `name` changes (409). Ingest (`ingest.ts`, `POST …/usage_events` and `/batch` ≤ 500): one transaction per request, dedup by (business, key) with no timestamp, ±35 days / +5 minutes, numbers read from the JSON source text and refused past 12 decimals (`invalid_value`), never truncated. Per-organization limiter (`platform/ingest-rate.ts`, 100 req/s default, `organizations.ingest_rate_limit_per_second`); ingest skips the per-key counter. Partitions are made on demand for the business clock's month. The `usage_fold` cron (queue `usage_rollups`) matches events whose key now exists, folds 15-minute rollups and backfills new meters; `readMeterUsage` is exact at window edges (rollups inside, raw edges and tail; `splitAt`, per-bucket, cutoff). A void rebuilds the folded bucket from the remaining events (a negative row cannot undo min, max or last). `usage_partitions` (daily) archives partitions past 25 months to `USAGE_ARCHIVE_URL` (S3 or a directory), then drops them; with no target nothing drops. Restore: `pnpm backoffice:restore-usage`. Back-office alerts `usage_archive_stalled` and `usage_fold_lag`. Cover: `verify:meters`, `verify:usage-events`, `verify:usage-archive`, `test/unit/usage-json-source.test.ts`.
- **2026-11-01** — **Browser-check fixes (PR 1a).** `archiveMeter` also refuses while an active price bills from the meter and names it. A late "Usage from" line states its own quantity (units added since the window was billed) and rate (`lateQuantity`): the per-unit rate, or the difference ÷ those units. `PATCH /v1/businesses/:biz` takes `usage_close_delay_minutes` (0–24). Cover: `verify:meters` §3, `verify:usage-late`, `test/unit/meter-price-form.test.ts`.
- **2026-11-02** — **`readMeterUsage` reads only the aggregate columns the meter needs.** sum → `value_sum`, count → `event_count`, min/max → its column, avg → both; only a `last` meter runs the ordered last-value aggregate. The other aggregate fields stay 0 / null; `amountSum`, `costSum` and `uncostedQuantity` are always read, so rated lines are unchanged. At 1M events / 43k rollup rows / 50 combinations the rollup statement went from ~430 ms (a sort that spilled to disk) to ~78 ms serial.
- **2026-11-01** — **Billing from the model price list (Tier 3 PR 1b, 0457–0458).** `price-list-rating.ts`: the `model_price_list` resolver plugs into `rateMeterItem` (`ResolveRate` may now be async; a segment carries its own divisor, markup and `cite`). Selling rate: item override → price rate → price markup, over `markup_base` (list, else your cost | your cost, else list); a list or cost row change splits the line, read once with `splitAt`; each line's `rating.segments[]` cites its `mpr_`/`mco_` row. `lineCost`: Σ event cost + uncosted × your cost (else list), FX for event cost in another currency, rounded once per line → `invoice_line_items.cost_minor/cost_basis` (sum and count meters only; late lines carry none). `meters.price_list` / `cost_currency` on the meter API. `usage-history.ts`: usage by day in the business time zone from bucket rows. Cover: `verify:model-price-billing`, `verify:usage-margin`.
- **2026-11-01** — **Billing from the model price list (Tier 3 PR 1b, 0457–0458).** `price-list-rating.ts`: the `model_price_list` resolver plugs into `rateMeterItem` (`ResolveRate` may now be async; a segment carries its own divisor, markup and `cite`). Selling rate: item override → price rate → price markup, over `markup_base` (list, else your cost | your cost, else list); a list or cost row change splits the line, read once with `splitAt`; each line's `rating.segments[]` cites its `mpr_`/`mco_` row. `lineCost`: Σ event cost + uncosted × your cost (else list), FX for event cost in another currency, rounded once per line → `invoice_line_items.cost_minor/cost_basis` (sum and count meters only). `meters.price_list` / `cost_currency` on the meter API. `usage-history.ts`: usage by day in the business time zone from bucket rows. Cover: `verify:model-price-billing`, `verify:usage-margin`.
- **2026-11-01** — **Late usage matches by period (PR 1b browser check).** A line's `rating.period` is the window rated as one; `rating.window` is its segment. `lateLines` compares, per period and combination, the re-rated total of every segment with Σ of what was billed under any segment (lines before `period` use `window`), so a split period is never billed again, and late usage dated where no line of its period was billed is no longer dropped. One late line per combination; across segments its `rating.segments[]` cites each. Late lines carry cost: the period's cost now − Σ `cost_minor` already billed (unknown when a billed line's cost was unknown). Cover: `verify:model-price-billing` T12, T13.
- **2026-11-01** — **A split period rates as one.** Free units come off the earliest segments once per period and combination; on an additive meter each segment rates its place in the period's running total (`rateMeterCombination` `position`): tiered units by position (a tier's flat fee with its first unit), volume tier from the period total (flat once), packages counted on the total. At one rate a split period bills the same as the whole. Cover: `verify:rate-cards` §4b, `verify:model-price-billing` T14.
- **2026-11-01 (Tier 3 PR 2)** — `ingestUsageEventsTx` stores events in the caller's transaction (a credit-hold capture); call `ensureUsageMonthsFor` first, outside it. `ingestUsageEvents` is unchanged in behaviour.
- **2026-11-02 (Tier 3 PR 2, 0468)** — `readMeterUsage` caches the rolled-up aggregate per process (LRU, 10,000 entries), keyed on the query's inputs and `usage_rollup_state.rollup_version`. Every rollup writer sets the version from `usage_rollup_version_seq` in its own transaction (`bumpRollupVersion`: fold, backfill, late match via `upsertRollups`; void rebuild; meter restart; archive), and the version is read in the same statement as the rollups, so the cache is exact across processes. Gate: `verify:usage-access` §7.
- **2026-11-02 (Tier 3 PR 3)** — Usage controls hook in: `ingest.ts` writes one insert-only `usage_control_dirty` mark per customer when the business has a usage control; `fold.ts` registers the dirty-set backstop as a fold hook. `readMeterUsage` and `rateMeterItem` take `where: {key, value}` (a property spend limit; reads raw), and `rateMeterItem` takes `measureOnly` (no line cost, no late lines).
- **2026-11-03** — **Real cost first (`event_cost_or_list`, design G1c).** `rateCombos`: per combination, the events that carried a `cost` bill it × (1 + markup) on a `part: "reported_cost"` line (`reportedCostLine`; markup = the combination's rate row or customer override, else the price's), and only `uncostedQuantity` bills from the list (`part: "list"`; free units come off it alone); a fixed selling rate wins over both. `MeterCombo.uncostedQuantity`, `lineCost({ part })` counts one part only; late lines hold both parts. `list-drift.ts`: per model over 7 days, reported cost vs the list price of the same tokens (USD only) → `GET /v1/organization/model_prices/drift`. Cover: `verify:model-price-billing` T15.
- **2026-11-04** — Ingest refuses a meter value, `amount` or `cost` outside ±10^12 (`withinMaxMagnitude`, `MAX_AMOUNT_MAGNITUDE` in `platform/fixed.ts`) as `invalid_value`; `POST …/subscriptions/:sub/usage` bounds `quantity` to the same. Gate: `verify:usage-events` §4.
