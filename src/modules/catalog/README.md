# catalog — product groups, products, prices, attachments

> Source: `src/modules/catalog/` · Routes: `src/api/catalog-routes.ts` · Schema: `db/schema/catalog.ts`
> Layer: catalog (see docs/architecture/architecture.json)

## Purpose
Owns *what you sell*: product groups, products (`kind` = plan/addon/charge),
prices (per currency × interval, all pricing models), attached items (addons/charges on a plan), and
differential (per-parent-plan) pricing. Also produces the price **snapshot** that freezes rating onto
a subscription item at attach time.

## Responsibilities
- CRUD + soft-archive for product groups, products, prices.
- Attach addons/charges to plans with applicability (mandatory/recommended/optional) and, for charges,
  `charge_on_event`/`charge_once`/`default_quantity`.
- Differential price overrides (flat/per_unit/tiers) per parent plan.
- Slug id generation/validation (CAT-0), mandatory-addon resolution, price snapshotting + line rating.

## Data model
`db/schema/catalog.ts` — `product_groups`, `products`, `prices`, attached-items, differential prices.
**Catalog + coupon resources use user-provided slug ids** (`^[a-z0-9][a-z0-9._-]{1,99}$`, lower,
**unique per business, immutable** — CAT-0), merging the old random `public_id` + `code`. Pricing
models: `flat | per_unit | tiered | volume | package | percentage | usage | stairstep`. Tiers stored
as jsonb on the price. Rating fields become immutable once referenced by a live subscription.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `create/update/setActive/list ProductGroup` · `getProductGroupByPublicId` | product-group lifecycle |
| `create/update/setActive/list Product` · `getProductByPublicId` | product lifecycle |
| `create/update/setActive/list Price` · `getPriceByPublicId` | price lifecycle |
| `setItemApplicablePlans` / `listItemApplicablePlans` | plan↔addon/charge attachment |
| `setDifferentialPrice` / `listDifferentialPrices` / `resolveDifferential(Amount)` | per-plan overrides |
| `snapshotPrice` / `ratableFromSnapshot` / `computeLineAmount` | freeze + rate a line |
| `resolveMandatoryAttachedItems` / `findMandatoryItemIds` | mandatory auto-include |
| `slugify` / `validateSlug` / `insertOrSlugConflict` | slug id helpers (409 on collision) |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET/PATCH/DELETE /v1/businesses/:biz/products[/:prod]` | product CRUD |
| `GET/PATCH/DELETE /v1/businesses/:biz/product_groups[/:grp]` | group CRUD |
| `GET/PUT /v1/businesses/:biz/products/:prod/applicable_plans` | attachment config |
| `GET/PUT /v1/businesses/:biz/products/:prod/differential_prices` | differential prices |
| `GET/PATCH/DELETE /v1/businesses/:biz/prices[/:price]` | price CRUD |

(19 routes total — see the route file.)

## Events emitted
`product.created/updated`, `price.created/updated`, `product_group.created/updated`,
`attached_item.created/updated/deleted`, `differential_price.set`.

## Dependencies
- **Upstream (calls into):** audit, events, webhooks.
- **Downstream (called by):** coupons, invoicing, metrics, migration, subscriptions, transfer.

## Invariants & gotchas
- Slug ids are immutable (PATCH of id → 400); duplicate slug → 409; auto-slugged from name if omitted.
- We keep **price snapshots** (not plan versioning): live subs are immune to later catalog edits.
- We support the full spread of pricing models (usage, package, percentage) — deliberate.

## Changelog
- **2026-11-03 (0484)** — Portal-only quantity limits. `attached_items.min_quantity`,
  `max_quantity`, `quantity_step`, `customer_can_change_quantity` (in `AttachedItemLink`, the
  applicable_plans `config` and the attached_item object; min > max refused) and
  `prices.portal_min_quantity / portal_max_quantity` (seat limits of a per-unit plan price).
  Defaults = no limit. Only the portal reads them (`customer-portal/plan-change.ts`); staff and
  the API set any quantity. Cover: `verify:portal-plan-changes`.
- **2026-10-24** — **Tier lists are checked on every write (closes B11), graduated percentage,
  minimum spend (0372).** `tierListIssues` (pricing.ts): tiers start at the first unit, each ends
  above the one before (no zero width), only the last is unbounded and it must be. Price create
  (route zod), price update (service, against the stored model; `tiers: null` on a tier model is
  refused) and differential prices refuse a bad list with a 400 whose `details.tiers` names the
  tier (`TierListError`). Stored rows are never re-checked. New model `graduated_percentage`:
  tiers `{ upToMinor, rateBps, flatAmountMinor }` over a money base; tier i holds (previous bound,
  bound], a reached tier adds its flat once, rounded half-up once on the total; metered when it
  has a `usage_aggregation` (`isMeteredPrice`). New `prices.minimum_amount_minor` (recurring only,
  snapshotted, scaled with the cadence multiple); `proratedMinimum` / `minimumTrueUp` do the math.
  Differential tiers never reach a `graduated_percentage` price (they carry no rate): both
  `setDifferentialPrice` with tiers and creating such a price under existing differential tiers
  for the same currency and interval are a 400 on `tiers`.
  Gates: `verify:price-tiers`, `verify:minimum-spend`.
- **2026-10-24** — **`free_quantity` is rated.** It was stored on prices and items and read by no
  rating code, so the free units were billed. `computeLineAmount` now takes `freeQuantity` off the
  quantity before the model rates the rest (`billableQuantity`; per-unit, usage, tiered, volume,
  stairstep, package — not flat or percentage). Tier tables rate the billable count from the first
  tier. `snapshotPrice` freezes the price's value; `ratableFromSnapshot(snap, itemFreeQuantity)`
  takes the item's value (required argument, so every caller decides) and `effectiveFreeQuantity`
  owns the precedence: item (0 included) → price snapshot → 0. `ratableForItem` rates an item
  row; `unitRate` states the rate with free units ignored. Gate: `verify:free-quantity`.
- **2026-10-18** — **Product image (0347).** `products.image_url`, set ONLY by
  `POST /v1/businesses/:biz/products/:prod/image` (manager; base64 JSON like `brand_images`; PNG,
  JPEG, GIF or WebP by leading bytes, never SVG; 5 MB) and cleared by `DELETE` on the same path. The
  route stores and sets in one call, so the column only ever holds a URL we stored; the replaced or
  removed object is deleted best-effort. Own counter: `RATE_LIMIT_PRODUCT_IMAGE_UPLOADS_PER_ORG`
  (300/hour), because a catalogue setup uploads one per product. **`redirect_url` is now live and
  validated** (`redirectUrl()`: no javascript:/data:/vbscript:/file:/blob:; "" clears) — it was
  stored and read by nothing. `enabled_for_checkout` / `enabled_in_portal` are still stored and still
  read by nothing; the dashboard no longer offers them. Gate: `verify:payment-links` (image, redirect).
- **2026-10-04** — **Charges attach to plans.** `setItemApplicablePlans` (was
  `setAddonApplicablePlans`) accepts a `charge` as well as an `addon`. A charge needs a one-time
  price, is `mandatory` or `optional` (never `recommended`), is always `charge_once` and never
  cycle-capped, and cannot use `applies_to_all`. `attached_items.addon_product_id` →
  `item_product_id` (0324); `listItemApplicablePlans`, `resolveMandatoryAttachedItems`,
  `findMandatoryItemIds` renamed to match. The applicable-plans responses name the product `item`.
  Dashboard labels now say "product group" and "price", matching the schema.
- **2026-09-30** — **Usage stats + audit rows.** `stats.ts`: `productStats` / `priceStats` /
  `productGroupStats` (`GET …/products/:prod/stats`, `…/prices/:price/stats`,
  `…/product_groups/:grp/stats`). Active = stored `active` + `in_trial`, deleted excluded; MRR is
  each subscription's stored net `mrr` apportioned to its items by gross recurring amount
  (largest remainder), so items sum back to the subscription and products to the business.
  Per currency. Product, price and product-group create/update/archive/restore now write audit
  rows via `auditRowChange` (none were written before). Gate: `verify:catalog-stats`.
- **2026-09-24** — **Catalog-wide reads.** `listApplicablePlansForBusiness` /
  `listDifferentialPricesForBusiness` (`GET /v1/businesses/:biz/applicable_plans`,
  `…/differential_prices`) answer every add-on in three queries. The subscription screens made one
  request per add-on (~49 on a production catalog, 3.6k calls in three days on production), each queued
  ~240 ms behind the others. Same results as the per-add-on reads, checked add-on by add-on.
- **2026-08-25** — **The catalog ROUTES now accept the same case-preserving slug id the SERVICE
  always did.** `src/api/catalog-routes.ts` validated caller-supplied `id` with a lowercase-only
  `^[a-z0-9][a-z0-9._-]{0,99}$`, while `validateSlug()` here has accepted
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` since the id-stable migration. Imported ids are often mixed-case
  (`platform-pro-v202607-USD-Monthly`), so the public API could not express a migrated id at all —
  contradicting `createPriceBody`'s own comment that "a caller migrating a catalog must be able to
  keep its ids". The only thing creating them was `src/modules/migration/import.ts`, which calls this
  service directly and bypasses the route. Widened the route regex (products, product groups, prices)
  and the OpenAPI `pattern` to match `validateSlug`.
- **2026-08-23** — **New `realignSnapshotToCycle` + `deAlignSnapshotFromCycle`.**
  `alignSnapshotToCycle` scales from `snap.interval`, so it is not idempotent across a CHANGE of
  cycle: handed an already-×12 yearly snapshot and a monthly cycle, `cadenceMultiple` returns null
  (1 month does not divide 12 months) and the snapshot comes back untouched — ₹9,024 **per month**.
  Re-aligning therefore rewinds first, through the `cadenceMultiple` / `catalogInterval` /
  `catalogIntervalCount` the forward step records. Division is exact (the forward step is a
  multiplication by the same integer).
  ⚠️ It rewinds the EFFECTIVE amount, never `catalogAmountMinor`: a differential add-on's catalog
  list price is 0 and the real figure lives in the override, so reconstructing from the catalog
  would silently zero the item. Measured on the real catalog, where the connections add-on is ₹0
  base with a ₹752 per-plan differential.
- **2026-08-22** — **`applies_to_all` round-trips.** `GET …/applicable_plans` reported it and the PUT
  could not set it, so a caller that GET-edited-PUT the same document silently dropped the field.
  `setItemApplicablePlans` now takes `appliesToAll` (omitted = leave alone; sending only `plans` is
  editing the link set, not clearing the flag) and returns it. The OpenAPI request body was
  documenting `plans` alone while the route already accepted `applicability` and `config` — all three
  are documented now.
- **2026-08-21** — Five additive price gaps closed on the price record — migration
  migration 0184. (1) `POST
  /prices` now accepts `id`: `createPrice` had always taken a caller-named slug, but the
  route's zod body had no `id` field, so nothing could ever reach it — auto-derivation
  stays the default, a collision is a
  409 like every other CAT-0 resource. (2) `prices.show_description_in_quotes`, the
  sibling to the invoices flag — **storage + API only**: there is no quotes module and no
  quote renderer to honour it, so the flag exists to survive an import and a round-trip
  rather than to change output (its `show_description_in_invoices` sibling is likewise
  read by nothing today). (3) `prices.tax_code` — HSN/SAC at the price level.
  Precedence is now **price → product → business default**
  (`__taxCodeForLine` in `invoicing/service.ts`, extended and re-pinned by
  `test/unit/tax-compute.test.ts`); the level is not redundant, since one product sold as
  a hosted subscription (SAC 998314, a service) and as a downloadable licence (a goods
  HSN) is one product with two codes. A null price code changes nothing, so 0181's
  behaviour is unchanged. (4) `prices.sku` / `accounting_code` /
  `accounting_category_code` — accounting detail, exposed **flat** (three optional
  scalars, and flat is our API style). Deliberately inert: nothing in the engine reads
  them and `accounting_code` is **not** a `ledger_accounts` handle — see the comment on
  the columns before wiring anything to them. (5) `comments` now accepts
  `resource_type: 'product' | 'price'`, and `createComment` gained the
  existence-and-ownership check the table's FK-free design had always been missing — a
  `resource_id` that names no record **in this business** is a 404 (new
  `CommentResourceNotFoundError`) instead of a note pinned to a typo. That check applies
  to the original four types too, which is a behaviour change for them.
- **2026-08-05** — New `cadenceMultiple` + `alignSnapshotToCycle` in `pricing.ts` — the divisor
  rule for an item whose billing period is SHORTER than the subscription's cycle. The
  multiple is how many times the item's period fits the cycle (monthly item, yearly cycle → 12;
  yearly item, monthly cycle → `null`, which the engine refuses); the aligner scales a flat/per-unit
  amount by it and re-expresses the snapshot on the cycle, keeping `cadenceMultiple` /
  `catalogInterval` / `catalogIntervalCount` for provenance. Lives here beside `computeLineAmount`
  and `itemCycleCap` for the usual reason — it is a rating rule, and every path that freezes a
  subscription item must reach the same answer. Full behaviour + limits:
  `subscriptions/README.md`, same date.
- **2026-08-04** — New `applyExplicitDifferentials` — the CAT-7 rule for pricing an **explicitly
  requested** add-on (plan-scoped differential fills in when the caller gave no `unit_price_minor`;
  an explicit override always wins) moved here as its one shared home, next to `resolveDifferential`
  and `resolveMandatoryAttachedItems`. It was inline in `createSubscription` and simply **absent** from
  `estimateNewSubscription`, which is why the create page could preview a differential add-on at
  0.00 and then book one that charges the real amount — see `subscriptions/README.md`, same date.
  Both paths now call this helper, so a preview and the subscription it books cannot disagree.
- **2026-08-03** — New `itemCycleCap`/`isCycleCapExhausted` in `pricing.ts` — the billing-cycle-cap
  rule for a subscription item (an EXPLICIT `billing_cycles`, else an IMPLICIT cap of 1 for a
  `one_time` price snapshot) moved here, next to `PriceSnapshot`, as its one shared home. Was
  duplicated across `invoicing/service.ts` (the renewal planner), `subscriptions/proration.ts`
  (a term reset must not re-charge or credit an already-billed one-time fee) and `subscriptions/
  estimate.ts` (the in-trial and term-reset previews must agree with both bookings) — all three now
  call this instead of re-deriving the expression. See `subscriptions/README.md` and `invoicing/
  README.md`'s 2026-08-03 entries for the bugs this closed.
- **2026-07-16** — `createPrice` enforces the business's `billing_frequencies` allow-list: a recurring
  price's `(interval, interval_count)` must be enabled for the business (one-time prices and a
  null/empty list are unrestricted), else `CatalogError` → 400.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-09-30** — **API parity, additive.** Opt-in paging on product groups, products and prices (`limit`/`starting_after` → the shared list contract with `field[op]` filters, `sort_by`, `q`; without them the whole set, unchanged). New: `GET/DELETE /differential_prices/:id`, `GET/DELETE /products/:prod/applicable_plans/:plan` (one attachment; the rest of the set is kept), and the plan-side `GET /prices/:price/applicable_addons` (`listApplicableAddonsForPlan`, same three applicability rules as the add-on side). Offset cursor helper in `paging.ts`, shared with coupons.
- **2026-10-25** — **Metered tier models and usage measure (0378).** `isMeteredPrice` = `usage`, or an aggregation on percentage, graduated_percentage, tiered, volume, stairstep or package (`METERABLE_MODELS`; SQL mirror `meteredPriceSql`). Flat/per_unit with an aggregation → 400 on `usage_aggregation`; 0378 cleared the stray values those models carried (they were ignored). New price columns `usage_recurring` (carry the level; sum/last/max/unique/weighted_sum only) and `usage_time_unit` (`hour`|`day`, weighted_sum only, default hour); all three usage fields are fixed after create (PATCH → 400) and frozen into `PriceSnapshot`. Price object adds read-only `metered`. New pure helpers: `rateMeteredQuantity` (amount always equals `computeLineAmount`, plus tier rows), `meteredGrowth` (additive | level | time_weighted), `usagePricingIssues`, `fixedChargeMinor` (0 for a metered price: every quantity-based path calls it). Cover: `verify:usage-pricing`, `test/unit/metered-rating.test.ts`.
- **2026-10-25** — **`bill_usage_monthly` and `commitment_amount_minor` on prices (0383).** Recurring plan prices only (`termBillingIssue`, 400 otherwise); monthly usage billing needs a billing period of 2+ months in months or years. Both are defaults that new subscriptions copy; edits apply to new subscriptions.
- **2026-11-01** — **Meter prices and rate cards (0453, Tier 3 G2).** A price with `meter` bills
  from that meter's events; its `usage_aggregation` / `usage_recurring` / `usage_time_unit` are
  copied from the meter (the API refuses them on a meter price, and refuses meter fields on any
  other price). Models usage | tiered | volume | package. `unit_amount_decimal` (minor units, ≤ 12
  dp, no exponent) per `quantity_divisor` units; meter tiers `{up_to, unit_amount_decimal,
  flat_amount_minor}`; package uses `package_size` (divisor 1). `amount_source` rate |
  event_amount | event_cost (open set) + `markup_percent` (≤ 6 dp, event_cost only); a dynamic
  price has no rate, tiers or card. `rates[]` (≤ 500, `price_rates`): match over a subset of the
  meter's group_by, one row per match; input order = age (created_at steps 1 µs). PATCH replaces
  the card and the rate/markup; meter, amount source and divisor are fixed. Pure math in
  `pricing.ts`: `meterPriceIssues`, `resolveMeterRate` (most properties, then oldest, else the
  price's own numbers), `rateMeterCombination` (Fixed12 from `platform/fixed.ts`, rounded half-up
  once per line; tier rows keep unrounded amounts). `PriceSnapshot.meter/.rates/.unitAmountDecimal/
  .quantityDivisor/.amountSource/.markupPercent`, frozen by `applyMeterPricing` on attach
  (`subscriptions/meter-billing.ts`). Files: `meter-prices.ts` (meter lookup, card writes, views).
  Cover: `verify:rate-cards`, `test/unit/meter-pricing.test.ts`, `test/unit/fixed12.test.ts`.
- **2026-11-01** — `amount_source: model_price_list` (usage model, sum/count meter, default rate required), `markup_base` (list | cost) and `rates[].markup_percent` (a rate is fixed or a markup, never both: `sellingRateIssues`). Snapshot gains `markupBase`, per-rate `markupPercent`, and `sellingOverride` (the item's own selling price). `rateMeterCombination` applies a markup to a usage rate, rounded once. Cover: `verify:model-price-billing`.
- **2026-11-01 (0465, Tier 3 PR 2)** — Price `grants_credit` on create, update (null clears) and the object: a credit pack on a one-time price (a paid pack needs a tax treatment or the business default; a custom unit is taxed at purchase) or credits per cycle with rollover on a recurring price. Validated by `credits/packs.ts`. Gate: `verify:credit-packs`.
- **2026-11-03 (0489)** — `createPrice` without `taxBehavior` takes its currency's value from
  `tax_settings.behavior_by_currency`, else exclusive (as before). Gate: `verify:tax-settings` C.
- **2026-11-03** — `amount_source: event_cost_or_list` (G1c): valid where `model_price_list` is, same markup, markup base, rates and customer override; `billsFromList()` covers both. Cover: `verify:model-price-billing` T15.
- **2026-11-04 (G3b)** — `grants_credit.reset` and `first_window` on a recurring price, checked against the price's term (no hourly credits, no window longer than the term). Saving a reset wakes the price's items for the credit clock. Gate: `verify:plan-credit-resets`.
- **2026-11-04 (G3b gaps)** — A price create, a `grants_credit` update or a restore is refused (CatalogError, 400) when it gives a plan with an allowance linked to its credits (`same_as_credits`) active per-cycle prices on different schedules; the message names the allowance. Gate: `verify:plan-credit-resets` §10.
