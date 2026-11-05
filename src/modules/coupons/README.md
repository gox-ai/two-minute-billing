# coupons — coupons, sets, codes, stacked discounts

> Source: `src/modules/coupons/` · Routes: `src/api/coupon-routes.ts` · Schema: `db/schema/coupons.ts`
> Layer: catalog (see docs/architecture/architecture.json)

## Purpose
Owns discounts: coupons (%/fixed, once/forever/repeating), coupon sets of bulk single-use codes, and
the deterministic stacked-discount computation applied during invoice generation. Multiple coupons can
apply to one subscription/invoice, with item constraints.

## Responsibilities
- Coupon CRUD (+ derived status: future/active/expired/archived) with editable
  `redeem_by`/`max_redemptions`/`valid_from`/`invoice_name`.
- Coupon sets + code lifecycle: add codes (generated or explicit), archive a code, delete unused codes.
- Apply/remove a coupon to a subscription; compute stacked discounts per line + invoice.

## Data model
`db/schema/coupons.ts` — coupons (slug id, kind %/fixed, duration, `apply_on`
invoice_amount|each_specified_item, item constraints), coupon sets, coupon codes
(not_redeemed/redeemed/archived), and applied-coupon links (many per subscription).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `createCoupon` / `updateCoupon` / `setCouponActive` / `listCoupons` / `couponStatus` | coupon lifecycle |
| `createCouponSet` / `listCouponSets` / `getCouponSet` / `listCouponSetCodes` | set management |
| `addCouponSetCodes` / `archiveCouponCode` / `deleteUnusedCodes` | code ops |
| `applyCouponToSubscription` / `removeDiscount` / `consumeDiscount` / `restoreDiscountPeriod` | apply/remove |
| `computeDiscount` / `computeStackedDiscounts` / `peekDiscounts` | discount math |

## API routes
| Method · Path | Purpose |
|---|---|
| `PATCH/DELETE /v1/businesses/:biz/coupons/:cpn` | coupon edit/archive |
| `DELETE /v1/businesses/:biz/subscriptions/:sub/discount` | remove applied coupon |
| `GET /v1/businesses/:biz/coupon_sets[/:set][/codes]` | set + codes read |
| `POST /v1/businesses/:biz/coupon_codes/:code/archive` | archive a code |
| `DELETE /v1/businesses/:biz/coupon_sets/:set/unused_codes` | prune unused |
| `POST/GET .../coupons` | create/list (portal-routes) |

## Events emitted
`coupon.created/updated/applied/removed`, `coupon_set.created`.

## Dependencies
- **Upstream (calls into):** catalog, events, webhooks.
- **Downstream (called by):** invoicing, migration, subscriptions, transfer.

## Invariants & gotchas
- **Stacking order (deterministic):** line-level fixed → line-level % → invoice fixed
  → invoice %; within a class, oldest applied first.
- `apply_on: each_specified_item` discounts only matching lines (pre-tax, per line); `invoice_amount`
  applies to the invoice total. Item constraints are per item-type (all/specific/none).
- Item constraints are create-only today (updateBody doesn't accept edits — a known backend gap).
- **`coupon_set_codes.status` has THREE values** — `not_redeemed | redeemed | archived`. Never derive
  availability as `total - redeemed`: that counts archived codes as still redeemable. `listCouponSets`
  returns each population counted directly off the status.

## Changelog
- **2026-11-03** — `applyCouponToSubscription({ requireItemMatch })`: an `each_specified_item` coupon that
  matches none of the subscription's current items is refused (same rule as `couponMatchesLine`).
  The `/subscriptions/:sub/discount` route sets it; plan changes do not (items move after).
- **2026-11-03** — `peekDiscounts` `pending.dropCodes`: price as though these coupons were removed
  (a plan change under `plan_change_coupons`).
- **2026-10-01** — **Estimates refuse what the apply refuses.** `couponUsableRefusal(coupon, now)`
  (inactive / not yet valid / expired / at `max_redemptions`) is the one check behind
  `applyCouponToSubscription`, `refusePendingCouponCodes` (used by `peekCouponCodes` and
  `peekDiscounts`' pending codes, plus up front in `estimateChange`) and checkout's
  `assertCouponUsableAtCheckout`. Peeks take `now` (default `businessWallClock`). Messages now name
  the code ("Coupon X has expired"). Unknown/inactive codes are still skipped by peeks. Coupons
  already attached are not re-checked: an expired attached coupon keeps discounting invoices.
- **2026-10-01** — **Discount given is net of credit notes.** `couponStats` returns per currency
  gross (`invoice_line_discounts`, non-voided invoices), reversed and given = gross − reversed;
  the stats route adds `discount_gross` / `discount_reversed` beside `discount_given`. Attribution
  (`couponDiscountReversed`): a non-voided note item linked to a line reverses that line's coupon
  discount × item / (amount − discount); a note with no linked item reverses the invoice's lines by
  (total + returned credits) / invoice total; half-up per item, capped at the line's discount.
  `verify:catalog-stats` checks it against a raw-SQL reference (mutation-tested on the void filter).
- **2026-09-30** — **Estimates honour the per-customer cap.** `customerLimitRefusal` is the one
  count behind `applyCouponToSubscription` and every preview: `peekCouponCodes` (given the payer)
  and `peekDiscounts`' pending codes (the subscription's customer) throw `CouponError`, so the
  signup, change and reactivate estimates answer 400 with the apply's words, and a checkout page
  that knows its payer refuses the code at mint / buyer entry. A new-customer checkout has no one
  to count and still accepts it; completion's apply is the check there.
- **2026-09-30** — **Per-customer cap, usage stats, redemption history, set rename.**
  `coupons.max_redemptions_per_customer` (0302, nullable, no backfill) is checked in
  `applyCouponToSubscription` — the one path every signup, checkout and dashboard apply goes
  through; importers are not refused. Every `applied_coupons` row counts (removed too), under
  an advisory lock per (coupon, customer). It is a cap, not a rule, so it stays editable after
  redemption. `couponStats` (redemptions + discount given per currency from
  `invoice_line_discounts`, voided invoices excluded), `listCouponRedemptionsPage` (keyset on
  `(created_at, public_id)`, index `applied_coupons_coupon_created_idx`), `renameCouponSet`
  (`PATCH /coupon_sets/:set`). Coupon and coupon-set writes now write audit rows
  (`coupon.create/update/archive/restore`, `coupon_set.create/rename/add_codes/archive_code/
  delete_unused_codes`). Gate: `verify:catalog-stats`.
- **2026-09-30** — `listCouponSetCodes` returns each code's `subscriptionPublicId` (via its
  applied coupon), serialized as `subscription` on `coupon_code`; null until redeemed. Locked by
  `verify:coupon-sets`.
- **2026-09-07** — **The discount was locked on every coupon, including ones nothing had ever
  used.** `updateCoupon` took name / validity / max-redemptions only, and the dashboard's Edit form
  replaced its whole Discount section with a warning that the discount "may be linked to
  subscriptions/invoices" — a *maybe*, on coupons with `times_redeemed = 0`, which is why it read as
  bureaucracy. Measured in the dev DB: of 10,090 coupons in the largest org, **3** had an active
  discount. The rest were frozen for nothing, and a typo caught before launch meant cloning.
  Now the rule is: **`times_redeemed === 0` → every field editable; once redeemed, only
  name / invoice name / valid-till / max-redemptions.** `RULE_FIELDS` names the protected columns
  once so the service and the route cannot drift, and the 400 quotes the redemption count.
  - **Why the gate is real and not ceremony.** An `applied_coupons` row with `source='coupon'`
    stores no snapshot: `peekDiscounts` re-reads `kind`/`percent_off_bps`/`amount_off_minor`/
    `apply_on` off `coupons` on every invoice. Editing a redeemed coupon would silently re-price
    the future invoices of every subscription carrying it. `times_redeemed` never decreases
    (removing a discount does not decrement it), so it answers "has this ever been used" rather
    than "is it in use now" — the safer of the two questions.
  - **Validated against the row the patch would PRODUCE, not the patch.** `{kind:'fixed_amount'}`
    alone used to be storable and would have left a coupon that discounts nothing; it is now a 400.
    Switching kinds also clears the other kind's column, because `computeDiscount` branches on
    `kind` alone and a stale sibling reads as a contradiction in the API response.
  - Moving `apply_on` off `each_specified_item` **deletes the scoping rows** — the matcher can
    never consult them again, so keeping them would have the API report a scope the coupon has not
    got. The detail page drops its per-kind "Change" links once a coupon is redeemed, since the
    engine would refuse them.
- **2026-09-07** — **CAT-2 item constraints were write-once and invisible.** They had always been
  stored (`createCoupon`) and enforced (`couponMatchesLine`), but nothing could read them back: no
  serializer emitted `item_constraints`, and there is only ONE coupon read endpoint —
  `portal-routes.ts`'s list, which the dashboard's `getCoupon` searches for a single row. So a
  coupon's plan/addon/charge scope could be set at create and never seen again. Worse, the
  dashboard's Edit and Clone forms seeded the editor from a hardcoded all/all/all constant, so
  **opening a scoped coupon and saving re-scoped it to the entire catalog** — the form posted a
  default it had never read.
  - `listCouponConstraints(orgId, couponIds)` is the read side, one query per page. A kind with no
    row stays absent rather than being materialised as `all`, because the matcher reads a missing
    row as an implicit `none` and the API must not disagree with it.
  - `updateCoupon` now replaces the rows WHOLESALE (delete + insert inside the same tenant tx),
    matching `createCoupon`'s convention — a kind you omit loses its row. Scope is editable even
    though the discount math is not: narrowing it only moves FUTURE invoices, and issued ones are
    immutable documents.
  - Rejected with a `CouponError` → 400 when `apply_on` is not `each_specified_item`, rather than
    storing rows the matcher would then ignore. The route body also caps the array at 3 and refuses
    a duplicate `item_kind`, which `coupon_item_constraints_uq` would otherwise turn into a 500.
  - The list serializer was missing `code`, `apply_on`, `invoice_name`, `valid_from`, `redeem_by`
    and `duration_in_periods` as well; the dashboard's coupon detail page was printing em-dash
    fallbacks over all six. `metadata` was the seventh — 35,332 imported coupons carry one, the
    column has existed since the table did, and neither create nor update accepted it. Both do now
    (replace, not merge, like `updateProduct`).
- **2026-08-22** — **Manual discount was refused on every in-trial subscription, and said so as a
  warning.** `applyManualDiscount` guarded on `sub.status !== 'active' && sub.status !== 'trialing'`
  — and `'trialing'` is a value that column NEVER holds. Ours is `in_trial`
  (`StoredSubscriptionStatus`); `trialing` is Stripe's word, correct only inside
  `modules/migration/*`. The column is `text`, so nothing type-checked it and the rule silently
  narrowed to "active only". It surfaced as *"Subscription updated (0 step(s)) — warnings: manual
  discount failed"* on a page whose own status chip read **In Trial**. The stale schema comment on
  `subscriptions.status` (`trialing | active | past_due | paused | canceled` — wrong four ways) is
  what it was written against; both are fixed, and the allowed set is now typed
  `readonly StoredSubscriptionStatus[]`, so that typo is a build error. Note
  `applyCouponToSubscription` has no status guard at all, so coupons always worked in trial — the two
  paths disagreed.
- **2026-08-22** — **`peekCouponCodes`**: price coupon CODES against a set of lines with no
  subscription in existence, for the new-subscription estimate. Deliberately shares
  `computeStackedDiscounts` with `peekDiscounts` rather than approximating it — the stacking order and
  item-constraint matching are what `verify:coupons` pins, and a second implementation would drift.
  Peek only: resolves and prices, never redeems, and skips an unknown code rather than throwing (the
  create call is where a bad code must refuse, and it does, with a 400).
- **2026-08-10** — **The line-level / invoice-level split is now a REPORTING distinction too, not just
  a tax one** (`0169`). `computeStackedDiscounts` always computed both stages — `lineDiscountByIndex`
  for `each_specified_item` coupons and a proportional spread for `invoice_amount` ones — but threw the
  invoice-level per-line spread away and returned one summed total. `sub_total` depends on
  exactly that split (item-level nets INTO it, document-level applies TO it), so the split now reaches
  the invoice: `itemLevelMinor`, `invoiceLevelByIndex` and `shares` (one entry per line × coupon ×
  scope). `DiscountRow` gained `documentLevelMinor`, because a coupon can contribute to BOTH stages and
  only the document-level part still needs an aggregate discount line.
  The two hand-copied structural return types on `computeStackedDiscounts`/`peekDiscounts` were replaced
  by one named `DiscountStack` — they had already drifted once, and `peekDiscounts` spreads the result
  straight through, so a field added to one silently missed the other.
  **No math changed**: `totalMinor` is identical, so tax, totals and the ledger are untouched. Pinned by
  8 new cases in `test/unit/discount.test.ts` (including "MONEY DOES NOT MOVE" across every scope mix)
  and end-to-end in `verify:coupons`, which previously had NO coverage of a *matching* item-level
  coupon — only `verify-warmup-g`'s constrained-coupon-matching-nothing case.
- **2026-08-08** — **Repeating and limited-period discounts now net into MRR.** The rule moved from
  "`forever` only" to a broader one — a discount restates MRR when it spans more than one billing
  period — and lives in `discountsForMrr` (subscriptions/service.ts), keyed off the new
  `applied_coupons.total_periods` (migration 0158). Consequences here: coupon apply and
  `removeDiscount` recompute the cached `mrr` for any non-`once` coupon (previously only `forever`),
  and `consumeDiscount` / `restoreDiscountPeriod` — which never touched MRR — now recompute on the
  active↔exhausted edge, since that is when a netting discount actually starts or stops applying.
  The intermediate decrements deliberately do NOT recompute: `total_periods` does not move, which is
  what keeps this from needing a recompute on every renewal (the objection that kept the old rule).
  Both apply paths write `total_periods` alongside `remaining_periods`.
- **2026-08-07** — 🟠 **A `forever` MANUAL discount never reached the cached `mrr` column.**
  `recomputeSubscriptionMrr` `innerJoin`ed `coupons` to find the discounts to net, so every
  `source='manual'` row (no `coupon_id`) was invisible to it — and `applyManualDiscount` never called
  it at all. A subscription whose standalone discount cancels its whole amount therefore reported
  full gross MRR while billing 0. Surfaced by an import (subscription-level `discounts[]` imported
  as manual rows — `src/modules/migration/README.md`, 2026-08-07), where the correct MRR for
  `AzqSMvTEg2eJtJsY` is 0 and we reported $1,892.83.
  - The join is now a `leftJoin`, and the "does this discount restate steady-state revenue?" rule
    lives in one exported place, `foreverDiscountsForMrr` (`subscriptions/service.ts` — renamed
    `discountsForMrr` on 2026-08-08), shared by the
    engine, the importer and the reconciler: coupon rows net when `duration_type='forever'`, manual
    rows net when they are unlimited (`remaining_periods IS NULL`) — a time-boxed manual discount
    does not, exactly like a repeating coupon.
  - ⚠️ **The rule itself is wrong**, and it is knowingly left in place, because fixing it is
    bigger than this change. Measured 2026-08-07 on one 12900/mo subscription per case: a
    **repeating** 20%/2-period coupon and a **limited_period** 20%/6-month discount should BOTH
    report `10320` (× 0.8) where we report the gross `12900`; `forever` (× 0.9 / 0) and `one_time`
    (unchanged) are already right. So any discount that reduces more than ONE upcoming invoice
    should net. Closing it needs (a) an MRR recompute wherever `consumeDiscount` decrements
    `remaining_periods` — every renewal — or the column drifts stale, and (b) a duration type on
    manual rows, since `remaining_periods = 1` cannot distinguish our `once` from an imported
    `limited_period` in its last period.
    **Superseded 2026-08-08** — both blockers were dissolved by keying the rule off a new
    `total_periods` (the span, which never moves) instead of `remaining_periods` (the countdown):
    (a) the column only needs recomputing when a discount starts or ends, not every renewal, and
    (b) a `once` discount and a `limited_period` one in its final period both correctly stop netting
    at span ≤ 1, so no duration type on manual rows is needed. See this changelog's 2026-08-08 entry
    and the full note on `discountsForMrr`.
  - `applyManualDiscount` now recomputes MRR for a `forever` discount, and `removeDiscount` does the
    same when the row it removed was an unlimited manual one.
  - **Invoicing was already correct** and is unchanged: `peekDiscounts` `leftJoin`s and projects
    manual rows from their `manual_*` columns, so invoicing, `estimateRenewal`, `estimateChange` and
    `items.ts` all apply them. This was a reporting bug on top of a missing import, not a second
    billing bug. Note `peekDiscounts` still hardcodes `applyOn: 'invoice_amount'` for manual rows —
    there is no per-item manual discount, which is why the importer refuses an imported
    `apply_on: specific_item_price`.
- **2026-08-05** — 🟠 **Archived codes were advertised as still available.** `listCouponSets` returned
  only `totalCount` + `redeemedCount`, so every consumer computed availability as `total - redeemed` —
  which is really *not_redeemed + archived*. A code deliberately withdrawn via `archiveCouponCode` was
  therefore shown as redeemable, and two list segments inherited it: **With Unredeemed Codes** matched a
  set whose only remaining codes were archived, and **Fully Redeemed** could never match a set whose
  remainder was archived rather than redeemed, so an exhausted-by-archiving set appeared in no
  exhausted view at all.
  - `CouponSetWithCounts` gains `archivedCount` + `notRedeemedCount`, both from `count(...) filter
    (where status = …)` in the same grouped query (the `coupon_set_codes_set_idx` on
    `(couponSetId, status)` already supports it, so no new index and no extra round trip).
  - **Counted directly, not subtracted.** `notRedeemedCount` is its own filter rather than
    `total - redeemed - archived` so that adding a fourth status can never silently inflate it.
  - Serializer emits `archived_count` + `unredeemed_count` (`coupon-routes.ts`), and the OpenAPI
    `CouponSet` schema requires both. Dashboard: Unredeemed reads the server figure, new **Archived
    Codes** (neutral — archived is a terminal state) and **Created At** columns, and a new
    **No Codes Left** segment, which is where an archived-out set now lands.
  - Gate: `verify:coupon-sets` **+6 checks** (18 total). The run prints the wrong answer beside the
    right one — `archived=2 unredeemed=47 (subtraction would say 49)` — so the check can go red.
    Segment behaviour proven in the browser on a purpose-built all-archived set: it is absent from
    "With Unredeemed Codes", absent from "Fully Redeemed", and present in "No Codes Left".
- **2026-07-27** — `applyCouponToSubscription` takes an optional `deferEventsTo` buffer (see
  `events/README.md`): `coupon_applied` / `subscription_changed` are appended to it instead of
  emitted, so the auto-collect-ON signup can withhold every event until its first charge clears.
  Omit it and behaviour is byte-identical. A signup refused after a coupon was applied has its
  `times_redeemed` bump rolled back and any claimed coupon-set code released
  (`deleteProvisionalSubscription`).
- **2026-07-27** — New export `findCouponByCode({org,biz,code})`: resolves a plain coupon code OR a
  coupon-set code's parent coupon and returns the row, **without redeeming anything**. Added because
  `applyCouponToSubscription` deliberately CLAIMS a single-use coupon-set code as part of applying it,
  so it can never be used to pre-validate a code — doing so would burn the code on an existence check.
  Hosted checkout validates every coupon at mint — a bogus coupon 404s when the page is created —
  and that check must be read-only. No behavior change to any existing path.
- **2026-07-15** — `applyCouponToSubscription`/`removeDiscount` now recompute the subscription's
  cached `mrr` (`recomputeSubscriptionMrr`, subscriptions module) when the affected coupon is
  `durationType='forever'` — only forever coupons net into subscription MRR (`once`/`repeating`
  never net, so applying/removing them is a no-op for MRR).
- **2026-07-15** — A post-signup `applyCouponToSubscription` now also emits `subscription_changed`
  (the coupon list is part of the subscription). New `atSignup` flag suppresses it in the signup
  flow — signup coupons fold into `subscription_created`, and emitting there produced spurious
  events.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).

- **2026-08-27** — `applyCouponToSubscription` takes `suppressSubscriptionChanged`, for a caller that
  will emit the ONE summary event for a composite edit itself. `atSignup` already expressed this for
  the signup flow (those coupons fold into `subscription_created`); this is the same idea for an
  edit that also moves items. The hosted CHANGE checkout applies N coupons and then reconciles items,
  and each half emitted its own `subscription_changed`: measured, one press of "Confirm change" with
  two coupons and a plan swap fired **three**, and a coupon-only change fired **two**. `coupon_applied`
  is never suppressed — the per-coupon fact is real and unduplicated; only the subscription-level
  summary has to be single.
- **2026-09-30** — **API parity, additive (0315).** `max_redemptions_per_customer` (counted across the customer's subscriptions, checked after the atomic bump so concurrent applies serialise on the coupon row); `price_ids` on a `specific` item constraint (a line matches its product OR its price — every rating path now carries `pricePublicId` on its discount lines); `GET /coupons/:cpn`; coupon sets take a caller `id` + `metadata`, `PATCH` (name, metadata) and `DELETE` = archive (stamps `archived_at`, archives unredeemed codes, refuses new codes); `GET /coupon_codes` (cross-set, paged) and `GET /coupon_codes/:code`; opt-in paging on the coupon, set and set-code lists. `invoice_notes` not added: no coupon text reaches the invoice document today.
- **2026-10-08** — `removeDiscountInTx` runs a removal on the caller's transaction; `removeDiscount` wraps it. A removal is a price change, so it now emits one `subscription_changed` (not `settings_only`, carrying `coupon_removed`) unless the caller suppresses it — `/change` (its own summary event), checkout (one event per edit) and the reactivation rollback do. `peekDiscounts` takes `pending.removeActive` to price as if the active discounts were gone.
- **2026-11-03 (0495)** — `applied_coupons.entered_by_customer` marks a code the customer entered (portal, or checkout at signup); `customer-cap.ts` counts them against `businesses.max_customer_coupon_codes`. Operator discounts never count.
- **2026-11-04** — The API refuses a new coupon code (and a code added to a set) outside `^[A-Za-z0-9_-]+$` (`couponCodeField`, `src/api/limits.ts`); the dashboard form checks the same rule. Stored codes, imported ones included, still apply, read and update. Generated set codes already fit. Gate: `verify:strict-params` § F.
