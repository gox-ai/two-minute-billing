# subscriptions — the subscription engine + billing clock

> Source: `src/modules/subscriptions/` · Routes: `src/api/subscription-routes.ts` · Schema: `db/schema/subscriptions.ts`, `scheduled-changes.ts`, `unbilled-charges.ts`
> Layer: billing (see docs/architecture/architecture.json)

## Purpose

The heart of the platform: owns subscription state and the durable billing clock. Creates and mutates
subscriptions (change/cancel/pause/resume with full option sets), schedules future changes, drives
renewals + dunning each tick, computes estimates, and manages ad-hoc + unbilled charges. The engine —
not any provider — owns period boundaries, proration, and lifecycle.

## Responsibilities

- Create subscriptions (incl. `future`-dated, trials, mandatory-addon expansion, calendar anchor, backdating).
- Change/cancel/pause/resume with option sets (credit/unbilled/AR/refundable handling, reason codes).
- Scheduled changes (change/cancel/pause/resume) applied by the clock; remove scheduled cancellation.
- `runBillingClockTick`: apply scheduled changes → renew due subs → dunning pass → deliver webhooks.
- Dunning (retries + configurable final action); estimates for create/change; dues snapshot; `change_term_end`.
- Ad-hoc charges, attached-item charges (`charge_on_event`), unbilled-charge invoicing.

## Data model

`subscriptions` (status `future|in_trial|active|non_renewing|paused|cancelled`, `remaining_billing_cycles`,
`mrr`, period boundaries, `auto_collection`, `cancelAtPeriodEnd`, reason codes) · `subscription_items`
(price + quantity + **`price_snapshot`** jsonb frozen at attach) · `scheduled_changes`
(`change|cancel|pause|resume`, effective_at) · `unbilled_charges` · `renewal_skips` (one row per
skipped renewal boundary, `scheduled|applied|cancelled|void`, source, the usage invoice it raised).

## Public surface (service entry points)

| Function                                                                                                                     | What it does      |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `createSubscription` / `listSubscriptions` / `getSubscriptionDetail`                                                         | lifecycle + read  |
| `changeSubscription` / `estimateChange` / `estimateNewSubscription` / `estimateCancel`                                       | change + dry-run  |
| `cancelSubscriptionWithOptions` / `pauseSubscriptionWithOptions` / `resumeSubscriptionWithOptions`                           | option-set ops    |
| `reactivateSubscription` / `reactivateSubscriptionInTerm` / `removeScheduledCancellation` / `changeTermEnd`                  | lifecycle         |
| `scheduleChange` / `listScheduledChanges` / `cancelScheduledChange` / `applyDueScheduledChanges`                             | scheduling        |
| `runBillingClockTick` / `runDunningPass` / `runRemindersPass` / `sweepStrandedRetries`                                       | clock passes      |
| `addSubscriptionItem` / `removeSubscriptionItem` / `addAdHocCharge` / `triggerAttachedItemCharge` / `invoiceUnbilledCharges` | items + charges   |
| `subscriptionDues` / `computeSubscriptionMrr` / `issueProratedCreditForUnusedTerm` / `planCancellationCredit`                | derived + credits |
| `deleteSubscription`                                                                                                         | soft delete       |
| `skipRenewal` / `unskipRenewal` / `listUpcomingRenewals` / `listRenewalSkips` / `renewalSkipViews` (`renewal-skips.ts`)      | skipped renewals  |

## API routes

20 routes — list/get/delete, `estimate`, `cancel_estimate`, customer `subscription_estimate`, items
add/remove, charges + `trigger_charge`, `unbilled_charges`, `schedule` + `scheduled_changes`
(+ delete), `reactivate`, `skip_renewal` / `unskip_renewal` / `upcoming_renewals` / `renewal_skips`.
(Cancel/pause/resume/change are wired via the dashboard actions + these endpoints.)

## Events emitted

`subscription.created/started/activated/changed/renewed/canceled/deleted/paused/resumed/reactivated/
scheduled_cancellation_removed/trial_ending/renewal_skipped/skip_scheduled/scheduled_skip_removed`, `invoice.dunning_stopped`, `customer.credits_restored`.

## Dependencies

- **Upstream (calls into):** audit, catalog, coupons, credit-notes, customers, events, invoicing, ledger, metering, metrics, tax, webhooks.
- **Downstream (called by):** invoicing, migration, ops, payments, webhooks.

## Invariants & gotchas

- **Billing-clock tick order:** apply scheduled changes → renewals → dunning → deliver webhooks
  (graphile-worker, ~every minute; each tick recorded via `ops`/`clock_ticks`).
- Dunning is invoice-side — a subscription can survive `not_paid` when the final action is `retain`.
- Item rating uses the **`price_snapshot`**, so live subs are immune to later catalog edits.
- Money = integer minor units; ledger append-only; `mrr` cached column excludes usage/one-time.
- **`mrr` is a WRITE-side rule, never a display one, and a trial stores 0.** The column is filtered
  and sorted in SQL (`LIST_FILTERS`/`LIST_SORTS`), so anything the serializer or a cell adjusts is
  invisible to the query that decides which rows come back — that is exactly how trial MRR came to
  disagree with itself. Persist the truth: `recomputeSubscriptionMrr` stores 0 while `in_trial`, and
  **every transition into a live paid status must call it again** (trial-end conversion, future start,
  resume, reactivate) or a converted subscription reports 0 forever.
- Time-travelled test businesses are skipped by the real tick and driven only by `travel_forward`.
- **The inclusive term end is read-side only, and the write side must mirror it.** The API serves a
  day-anchored `current_period_end` as `…T23:59:59` while storage keeps the exclusive next
  boundary, so any write that ACCEPTS a term-end instant must pass it through `normalizeTermEnd`
  first — otherwise a read-modify-write persists the inclusive value and the term walks off
  midnight one cycle at a time (`change_term_end` did exactly that until 2026-07-31).
- **A `one_time` item is charged once, prorated never, and credited never.** FIVE paths must agree
  and each used to decide for itself: the renewal planner skips it once its cycle is spent, a
  mid-term add charges the FULL fee (and records the cycle via `markItemsBilled`, since it bills
  outside the planner), a **term reset** neither re-charges a spent one nor credits its "unused
  time", a **removal** credits nothing at all, and a **non-reset change** to the item's own
  price/quantity charges the full fee (once) and credits nothing — that last one via the shared
  `nonResetItemProration` (`proration.ts`), which `estimateChange` calls too so the preview cannot
  drift. Ask `isCycleCapExhausted` (`catalog/pricing.ts`)
  whether a cycle is left — never re-derive `billing_cycles ?? (one_time → 1)`. Any path that bills
  a one-off outside `planSubscriptionPeriodInvoice` owes `markItemsBilled`, or the next renewal
  bills it again.
- **Billing mode lives in `billing-mode.ts`, never inline.** Where a term starts
  (`anchor_granularity`) and how mid-term money is measured (`proration_granularity`) are two
  INDEPENDENT axes; ask `alignTermStart` / `prorationBoundary` / `prorationWindowStart` rather than
  testing the columns. A wrong boundary does not throw, it bills the wrong amount.

- **A composition edit is ONE call, and its documents must say so.** `/change` carries all
  three lists — `changes`, `adds`, `removes` — applied in one transaction and folded into ONE
  invoice plus at most one credit note. Never send an edit as several requests: doing so bills
  a full term for lines the next request removes and then credits them back, and it splits one
  collectable charge into two, either of which can breach a per-debit mandate ceiling that the
  whole edit would have fitted under (measured 2026-08-24 — see the Changelog). The
  single-line routes remain for callers that genuinely hold one line.
- **Two ways to edit items, and they mean different things.** `/change` speaks in DELTAS against
  item ids the caller already holds; `/update_for_items` takes a DESIRED LIST and works out the
  swap/quantity/add/remove itself. Prefer the latter for any
  caller that holds a configuration rather than a diff — otherwise it re-implements the reconcile
  client-side, slightly differently each time. Both, plus the change-mode checkout, share
  `reconcile.ts` so a given list means the same thing on every surface, including across the
  minutes between a buyer-facing preview and the completion that follows it.
- **Removal is never inferred from an item list.** An omitted line is ambiguous — "leave it alone"
  and "take it off" post identically — so it takes a flag: `replace_items_list` declares the whole
  list exhaustive, `mandatory_items_to_remove` names individual prices under upsert. Defaulting to
  removal would strip add-ons from every caller that only meant to add one. The plan is never a
  removal candidate under either (a subscription with no plan bills nothing).

## Changelog
- **2026-11-04** — Credit and allowance reset settings (design-G3b § 6) in `billing_rules_config`
  (no migration): `plan_credits.{on_upgrade, on_downgrade, first_window, on_pause,
  on_cancel_at_period_end}` and `allowances.on_upgrade`, read through
  `resolveBillingRulesConfig().planCredits / .allowances`. Each default is the recommended option,
  because no business used resets before. Settings → Billing rules → Credit and allowance resets.
  The engine that reads them is G3b's (copy-lago).
- **2026-11-03** — Collect pump: the tick stamps `invoices.collect_trace_id` (0496) when it
  hands an invoice over (batch numbering, dunning pass); the pump charges under that trace,
  so a tick's trace includes the charges it delegated. Each charge is its own span.
- **2026-11-05** — `pauseSubscription` / `pauseSubscriptionWithOptions` take `source`
  (`operator` default | `retention_offer`) and write `subscriptions.pause_source` (0493); a deferred
  pause carries it in its scheduled-change payload.
- **2026-11-03** — `estimateChange` previews `downgrade_credit: refund` (and the portal's
  `creditChoice`): `refunded_to_payment_method_minor`, a `payment_method` credit destination, and
  only the kept part on the balance and in the next renewal (`gatewayRefundableTotalMinor`).
- **2026-11-03** — Resume re-anchoring keeps a manually set billing day and the old day when the
  month clamps it (`pickResumeAnchor`), and moves pending renewal skips to the matching upcoming
  renewal on the new day (`moveSkipsToNewAnchor`).
- **2026-11-03** — Lifecycle settings (`lifecycle-config.ts`, keys in `billing_rules_config`,
  each unset = today): `plan_change_term` (callers pass `resetTermForPolicy`; a quantity-only
  edit never resets), `plan_change_coupons` (`plan-change-coupons.ts`, applied in
  `changeSubscription` before it bills and priced by `estimateChange` via `peekDiscounts`'
  `dropCodes`), `downgrade_credit` (`changeSubscription` wraps `applyChange` and refunds the
  change's credit notes one card or bank payment per call, `gatewayOnly`; the rest stays as
  credit; `customer_chooses` takes the portal's `credit_handling`), `reactivation_charges`
  (cancelled subscriptions only). Bug fixes for every business: a reactivation with no body
  anchors its new term on the reactivation day (it kept the old day: a wrong-length term at
  full price); undoing a pending cancel through `/reactivate` no longer prices a fresh term
  (it threw a 500); a resume after the paid term ended starts a full period on the resume day
  (it ended on the old billing day, shorter or longer than a period, billed in full).
- **2026-11-03** — Several due invoices, one charge (2.51, `dunning-combined.ts`): with `payment_application.several_due_invoices = combined`, `retryInvoice` charges the customer's other retries due now (same currency, same first card, not held, not in an open request) in one `dunning`-origin payment request. Only when every instrument is a card with no mandate and no pre-debit notice and the total is inside the card limit; else, and on any refusal before the charge, one charge each (claimed siblings get their retry instant back). Exhausted invoices get the final action as on a single retry. Gate: `verify:settings-payment-application` § 1.
- **2026-11-03** — `renewal-collection.ts` (0486): with a collection rule active and auto-collection on,
  the renewal commits with `collect: false` and `settleCollection` writes off an amount due below the
  small-invoice limit, leaves a net-terms invoice `posted` for the due-date pass (`on_due_date`), or
  collects as before. Unset, the renewal call is unchanged.

- **2026-11-03** — `resumeSubscriptionWithOptions` cancels the subscription's LATER scheduled
  `resume` rows (a pause with an end date) in the resume transaction; rows due now belong to the
  applier. A left-over row was moot on an active subscription but would end a later pause early.
- **2026-11-03** — `ItemAdd.autoIncluded` / `ItemAdd.billingCycles`: a caller can name a
  CAT-3 mandatory add-on as an explicit add (stamped `auto_included`, cycle cap carried), so
  `estimateChange` prices it. `changeSubscription({ refuseUnrequestedItems })` throws in the
  plan phase, before any write or charge, when the engine would still add a mandatory add-on
  or remove an auto-included one the request did not name. Defaults unchanged. Known gap:
  `estimateChange` itself does not resolve mandatory add-ons, so a caller that does not name
  them gets a preview without them (the portal names them; operator screens do not yet).
- **2026-11-03** — Plan-change rules in `billing_rules_config` (no migration): `upgrade_proration` /
  `downgrade_proration` (prorated | none; unset = prorated, which is what an omitted `prorate`
  always did), `upgrade_gate` / `downgrade_gate` (off | invoices_paid; customer-level open
  invoices with `amount_due > 0`), `upgrade_timing` / `downgrade_timing` (now | end_of_term |
  customer_chooses | null). Null timing keeps each source's own default: portal upgrade now /
  downgrade at term end, dashboard/API caller's choice, default now. In trial every change is now
  (an operator under customer_chooses may still defer). `resolveChangePolicy` reads them;
  `/change` gains `timing` (omitted = the rule; end_of_term schedules) and refuses a gated change
  409 `invoices_unpaid`; `/schedule` checks gate + timing at scheduling; `/estimate` returns
  `change_policy`; the scheduled applier prorates per direction (`directionOfItemEdit`). The
  portal's plan changes no longer read `default_prorate_on_change` (term-end changes only, as in
  production). Not built: un-sliced "full" proration, and a charge-first upgrade gate.
  Review fixes: `directionOfItemEdit` rates every line from its snapshot with
  `computeSubscriptionMrr` (cycle-aligned add-ons, tiered/volume at quantity) and applies the
  booking's differential resolution; `/change` treats `at`/`reset_term`/`prorate`/
  `invoice_immediately`/`metadata`/a discount without `timing` as `now` when allowed; `POST …/items`,
  `DELETE …/items/:id`, `update_for_items`, checkout change mode and HubSpot are gated and timed
  too (they apply now only). Added and removed items always prorate (proration.ts ~3711), so the
  proration rule covers changed lines only. Gate: `verify:settings-plan-change-rules`.
- **2026-11-02** — `change-policy.ts`: `resolveChangePolicy({business, subscription, direction, source})` → timings, default timing, gate, proration per direction, invoice timing; `changeDirection` (longer period = upgrade). One place for every source (portal, dashboard, API, scheduled); today's body has no gate. Filled by the billing-rule settings 2.3 / 2.4 / 2.38 (tmb-settings).

- **2026-11-02** — `card_limit_exceeded` (0482, the business's card limit) is a park-class code in
  `PARK` and `PARK_EVEN_IN_FIXED_MODE`, like `no_payment_method`.
- **2026-11-02** — `reminder_config` gains `payment_due`, `pause`, `resume` (`[]` = Off, the
  default; up to 3 lead days) and `card_expiring` (`"expiry_month"` default, or up to 3 lead
  days). `runRemindersPass` sections 5–6 emit `invoice_payment_due_reminder` (open invoice,
  money due, auto-collection off) and `subscription_pause_reminder` / `_resume_reminder`
  (scheduled `pause` / `resume` rows), once per (record, date, lead day). A business a person
  creates starts with `NEW_BUSINESS_REMINDER_CONFIG` (`initialReminderConfig`); keys keep the
  defaults. Proven by `pnpm verify:settings-reminders`.
- **2026-11-02** — **Pause locks are enforced.** `pause_config.locked` was stored but advisory. The
  pause and resume routes now refuse (400) an explicit option that differs from a locked default
  (`lockedOverrides` / `lockedOverrideMessage` in `pause-config.ts`); sending the default or omitting
  it passes. Scheduled, chargeback and portal pauses call the service directly and are not gated.
  The dashboard Pause dialog now preselects the business defaults (it hardcoded "Immediately" and
  "Continue retries", which overrode them) and shows locked fields read-only. `verify:pause-locks`.
- **2026-11-02** — The reminders pass reads the gateway notice lead per rail (`preDebitRule`),
  so a PayU card notice goes out 24 h + margin ahead and a UPI one 25 h + margin.

- **2026-11-01** — **One live subscription bills a meter; usage closes after the period (0454).**
  `syncMeterBilling` (`meter-billing.ts`) runs in the transaction of every attach path — create,
  reactivate, add item, plan change / scheduled-change apply — after the items are written: it
  freezes each meter price's rate card onto the item snapshot and takes `customer_meter_billing`.
  A row owned by another live subscription that still has a price on the meter → 409
  `MeterBillingConflictError`; a cancelled, deleted or meterless owner passes the row (and its
  pointer) on, so late usage follows the customer. Renewal: `usageCloseReached` is ONE predicate
  in both due scans (inline and fan-out) — a subscription that owns a meter row is due once the
  business clock passes the boundary + 6 min + `businesses.usage_close_delay_minutes`, capped at
  +30 (gated on the business clock, not the fold watermark; billing reads the unfolded tail raw).
  Removing a meter item mid-period (also a term reset or an immediate cancel) settles it in
  `settleMeteredUsage`: a cutoff at the removal, one `usage_settlement` charge per combination
  carrying its line `rating` (`unbilled_charges.rating`, 0454), and the pointer moved to the
  removal, so the usage bills once. `current_usage` shows a meter item's total so far (exact, no
  fold grace); per-combination rows and its projection come with 1b.
  Cover: `verify:usage-late`, `verify:rate-cards`.

- **2026-10-30** — **Past retry slot → a day later, not now.** `nextRetryAt` used to clamp a slot
  already behind the failure to the failure instant, so an invoice first charged a day after its
  due date was re-presented on the next dunning tick (two refusals 58 s apart). It now lands at
  `from + 1 day`; the slot is still not skipped.
- **2026-10-25** — Named dunning policies (0386): `resolveDunningConfig(biz, policyConfig?)` overlays a policy's per-invoice keys (`DUNNING_POLICY_KEYS`); `dunningPolicyConfigJson` stores the full set. Dunning, renewal, reactivation and estimate read the customer-aware loader (`dunning-policies/effective.ts`). The tick re-requests receipt numbering (0387).
- **2026-10-24** — **Dunning holds: customer exclusion and a per-currency minimum.**
  `DunningConfig.minimumAmounts` (`dunning_config.minimum_amounts`, `{ "USD": 500 }`, minor units,
  positive integers only; empty = none) and `dunningHoldReason`. A held invoice (customer
  `dunning_excluded`, or OUTSTANDING due — `invoiceOutstanding`, not the total — below its
  currency's minimum) is never started: the failure sites pass `dunningApplies: false` only while
  `dunning_status` is null. Already in dunning, it keeps its schedule and every pass skips it —
  `runDunningPass` (both branches) and the offline ladder via `dunningNotHeldSql()` in the WHERE,
  `retryDueInvoice` (pump entry) before the claim, both parked sweeps per row and in SQL. Lifting
  the MINIMUM resumes it as `resumeDunning` does (a passed step runs on the next pass). Lifting a
  customer EXCLUSION does not run overdue steps: dunning time is frozen while excluded, so every
  remaining retry, reminder, deadline and final action moves later by the exclusion's length
  (stored instants shifted; due-date anchored steps read `dunningAnchor` = due date +
  `invoices.dunning_held_ms`, 0373). Gates:
  `verify:dunning` K/L, `verify:dunning-offline` 12–15, `test/unit/dunning-hold.test.ts`.

- **2026-10-24** — `addInterval` / `Interval` moved to `interval.ts` (re-exported from
  `service.ts`) so invoicing can size a full period without importing this module. Every
  "is this metered" check (quantity guard, MRR, proration settle, estimates, renewal skips) uses
  `isMeteredPrice`, which also covers the new `graduated_percentage` model.
- **2026-10-24** — `creditOneInvoice` passes `taxAtInvoiceRate` on its notes. Credit notes now
  reverse each credited line's own tax when every item names a line (credit-notes README, same
  date); our linked items are PRE-tax with the tax on a separate item, so they keep the invoice
  rule the tax item round-trips with. The one change here: a note that fully credits its invoice
  now reverses all remaining tax, which can differ from its tax item by earlier notes' rounding.

- **2026-10-24** — **`free_quantity` lowers the bill.** Every path that rates an item now passes
  the item's `free_quantity` (catalog `ratableFromSnapshot`/`ratableForItem`): first invoice,
  renewal, quantity/price changes and term resets, add/remove credits, the change-term-end
  re-rate, `estimateChange`/`estimateNewSubscription`/`estimateReactivate`, cached MRR
  (`computeSubscriptionMrr`, `computeRecurringAmount`). A change keeps the item's value; an added
  item has none, so the price's applies. `subscription_estimate` and `reactivate_estimate` now
  accept `items[].free_quantity`. Gate: `verify:free-quantity`.
- **2026-10-24** — **Pre-debit notices through the gateway** (`reminders.ts` § 4). For a default
  payment method on a rail its gateway account's adapter covers with `capabilities.preDebitNotice`,
  the pass sends the GATEWAY notice (`sendGatewayNotice`) once the boundary is within
  `minLeadHours` + 2 h (scan widened to 4 days), for the renewal estimate's `amount_due_minor`,
  keyed on (instrument, boundary, amount, currency); one notice per (instrument, boundary) in any
  state, and no estimate means no notice (the collection gate then sends one and defers). Our
  `subscription_pre_debit_notification` is skipped on those rails and on `gatewayNotifiesPayer`
  rails; every other mandate rail keeps the email unchanged. New result field `gatewayPreDebit`.
- **2026-10-27** — **Ship-to.** `subscriptions.shipping_address_id` (0360) points at one of the
  customer's address-book rows; null = the customer's default. Settable on create and on
  `PATCH /subscriptions/:sub` (`shipping_address_id`, null clears); the address must be this
  customer's and not archived (`resolveAssignableAddress`). Detail reads add `shipping_address_id`
  and the resolved `shipping_address` (`resolveShipTo`: own row → default → null).
- **2026-10-21** — **Skip a renewal.** `renewal_skips` (0355) names upcoming renewal boundaries to
  skip (any of the next 12; skips and undos close 48 h before, so the 48 h pre-debit notice can
  never miss an undone skip). At a skipped boundary `renewSubscription` → `renewSkipped`: the period
  advances in the same claim that marks the skip applied, `remaining_billing_cycles` is NOT
  decremented (a fixed term extends), the plan invoice is planned with `skipFixed` (metered usage
  and pending one-time charges only; no invoice at all when there are none), and
  `subscription_renewal_skipped` replaces `subscription_renewed`; MRR does not move. Placed before
  the no-card gate: a skip charges nothing recurring. Refused on trials, paused/cancelling
  subscriptions and pending-invoice billing. The renewal reminder is not sent for a skipped
  boundary; the pre-debit notice is sent only when metered usage will still be debited, without
  the fixed amount. `voidPassedSkips` (each tick, within the clock scope) voids a skip whose
  boundary passed a day ago unapplied. `next_billing_at` steps over skips; `skipped_renewals` lists
  them; the audit snapshot carries them. Portal: `storefront_config.allow_skip_renewal` +
  `skip_renewal_limit` (per 12 months; operators uncapped). Gate: `verify:subscription-skip` (36),
  mutation-checked on the clock branch, `skipFixed` and the reminder filter.

- **2026-10-08** — `updateSubscriptionSettings` emits ONE `subscription_changed` (envelope `settings_only: true`) when a field really changes, and writes nothing for a no-op. It used to emit nothing, so metadata and settings edits reached no webhook. `applyItemOperations` takes `metadata` and writes it in its summary transaction, so items + metadata are one event that carries the new value; `update_for_items` passes it there instead of a second write.
- **2026-10-04** — Attached charges bill like `charge_once` add-ons: a mandatory
  `subscription_creation`/`trial_start` charge folds into the first invoice, `activation` fires
  once per subscription, `on_demand` via `trigger_charge` (`triggerAttachedItemCharge` now takes
  `itemPublicId` and accepts a charge). A plan change does not fire the new plan's signup charge
  (`charge_once` items are skipped there). `subscription_charge_log.addon_product_id` →
  `item_product_id` (0324). Gate: `verify:attached-charges`.
- **2026-10-03** — Dunning retries (`retryInvoice` and the parked deadline attempt) apply credit on file before the card; an invoice credit settles returns `recovered` without a charge.
- **2026-10-03** — **Lost, stolen and seized cards are held for a new card, not cancelled.**
  `lost_card` / `stolen_card` / `pickup_card` moved from `TERMINATE` to the new `HOLD_FOR_NEW_CARD`;
  `classifyDecline` parks them and smart-mode `planFailureRearm` parks them even with
  `parkHardDeclines` off (ahead of the armed-retry guard, like any park). The parked deadline is the
  ordinary one (`parkedDunningDeadline`, 30 days with no period), and `sweepExpiredParkedDunning`
  skips the deadline charge when the card it would present is the one that failed with a held code.
  The method is still marked invalid; `collectionRank` now ranks them as a park. Fixed mode
  unchanged. `fraudulent`, `revocation_of_authorization`, `debit_not_authorized` still terminate.
  Root cause: a single `pickup_card` decline exhausted dunning and cancelled a long-standing
  subscription two seconds after its first attempt.

- **2026-09-30** — `include_deleted=true` lists soft-deleted subscriptions too, each carrying `deleted: true` (`SubscriptionListFilters.includeDeleted`); absent, unchanged.

- **2026-09-30** — API parameter parity (lifecycle + estimates), all optional, absent = unchanged.
  Reactivate: `reactivate_from` (checkout's guard + backdating policy), `payment_intent`
  (consumed into the fresh term's invoice; a refused capture re-cancels under the
  require-charge gate, else dunning owns the invoice), `payment_initiator=customer`
  (on-session pre-charge → 402 `requires_action`). Cancel/cancel_estimate:
  `end_of_billing_term` (= `end_of_term`), `include_cancellation_day_in_billing`
  (whole-day proration only; `false` prorates from the start of the billing day). Pause
  `resume_date`, `unbilled_charges_handling=no_action`; resume `resume_option=specific_date`
  (options ride on the `resume` payload); `remove_scheduled_cancellation.billing_cycles`;
  `coupon_ids[]` (≤1); create/PATCH `payment_method` (the existing per-sub pin); PATCH
  `net_term_days`; renewal_estimate flags via a preview-only plan (`commit` refuses it);
  estimate `change_option=specific_date`. Gated by `verify:subscription-api-params`.
- **2026-09-30** — `cancelAtBoundary` stamps top-level `ended_trial: true` on a trial-end cancel,
  so a cardless trial's `no_card` cancellation mails `trial_expired`, not the non-payment notice.
- **2026-09-29** — Reactivation with `requireSuccessfulChargeOnReactivation` charges FIRST
  (`chargeReactivationFirst`, priced by `estimateReactivate`); a decline raises no invoice, emits
  no events and keeps the cancellation. The charge's idempotency key is per reactivation term.
- **2026-09-29** — Cancel preview: with `void`, an open invoice `voidBlocker` refuses carries
  `void_blocked` (the reason), is not counted in `void_minor`, and the dialog says it stays open.

- **2026-09-29** — **NACH 3-day gap.** `RAIL_MIN_RETRY_GAP_DAYS` (nach, emandate: 3) floors every
  retry via `railRetryNotBefore`, beside the code and network floors. A floor past the period end
  lands on the deadline, which `presentationBlock` then refuses, so the period still decides the end.

- **2026-09-29** — **Parking is opt-in (`dunning_config.park_hard_declines`, default off).** Off,
  `planFailureRearm` retries every park-class decline on the schedule (smart `PARK` +
  `RETRY_THEN_PARK`, fixed `PARK_EVEN_IN_FIXED_MODE`) and the final action runs when it is spent;
  `TERMINATE` still exhausts at once. With no dunning period, a card decline that would have parked
  keeps the `PARKED_GRACE_DAYS` window as its deadline; a mandate rail does not (that attempt would
  pass NPCI's cap). Why: a prod `incorrect_number`/do-not-try-again card declined generically on the
  next attempt, and an `authentication_required` park succeeded off-session 18h later. The parked
  sweep, reminders and deadline still serve invoices already parked and businesses that opt in.
- **2026-09-27** — **A discount stack nets the same whatever order it is read in.**
  `netMrrForDiscounts` applied discounts in row order and both callers read them unordered, so a
  fixed + percentage pair stored 2019 at write and recomputed to 2012. Fixed amounts now net
  before percentages (the invoice stack's order), and the recompute reads by `created_at`.
  Existing rows change only on their next recompute; `scripts/repair-drifted-mrr.ts` restates any
  the invariant flags.
- **2026-09-27** — **Dunning cancels date from the business clock.** The exhaustion cancel took
  `canceled_at`, the no-card check and the churn movement from the wall clock, so under the Time
  Travel (or a late tick) involuntary churn landed in the wrong period. All three now use
  `businessNow(businessId)`; identical in production outside a travel.
- **2026-09-27** — **Cancels keep the stop's booking date.** Every terminal cancel (term end,
  trial/no-card boundary, dunning, immediate) writes `cancel_booked_at = frozenStopBooking(before,
  canceledAt)` as it clears the pending-cancel flags; reactivation and removing a scheduled
  cancellation null it. Existing rows: `scripts/backfill-cancel-booked-at.ts`.
- **2026-09-25** — **The park deadline attempt follows the presentment rules.** `NO_DEADLINE_ATTEMPT`
  is gone: the sweep charges only if `firstPresentable` finds a card that may be presented (not
  blocked by `NO_REPRESENT` unless changed or newly added, and under the per-card caps); otherwise
  the window closes without a charge. `retryInvoice` defers a capped retry to the window's reopening.
- **2026-09-25** — **Adaptive retry timing (`adaptive-schedule.ts`).** Opt-in
  `dunning_config.adaptive_timing`, smart mode only: `planFailureRearm` takes `adaptiveTiming` +
  `timezone` and, for a classed decline on a non-mandate instrument, schedules by class instead of
  the offsets — transient faults in hours, insufficient funds on the next payday, generic refusals
  a few local days apart before `RETRY_THEN_PARK` parks them. Day-based attempts land at 10:00
  business-local, never past due + 30 days, and `scheduleTail` still enforces the dunning period.
  All three failure writers pass it. Mandate rails and unclassed codes keep the offsets.
  "Local" is the card's issuer country (`retryZoneFor`, zones from the seeded
  `countries.timezones`) when known. Separately, `networkRetryAfterMs` floors the next attempt in both modes when the
  network stated a wait (`failure.retryAfterMs`).
- **2026-09-25** — **Smart mode retries a generic refusal before parking it.** `card_declined`
  and `do_not_honor` left `PARK` for `RETRY_THEN_PARK`: they follow the merchant's schedule and
  park on the fourth failed attempt (`RETRY_THEN_PARK_ATTEMPTS`), or when the schedule is spent,
  instead of exhausting. Parking on the first one meant smart mode never retried the most common
  decline. Checked in `planFailureRearm` next to the disposition, so a manual attempt on an armed
  schedule still returns `paused`. Fixed mode is unchanged. The refusals that name the CARD
  (blocked, not enrolled, wrong type) moved to `card_restricted`, which still parks at once.
- **2026-09-24** — **Count batch + one-time charges read.** The list's WHERE is now
  `subscriptionListConditions`, shared by the page read and `countSubscriptions`
  (`POST …/subscriptions/count`), so a count and its drill-down cannot disagree. The cancellations
  report asked ~25 counts as full list reads. `GET …/subscriptions/:sub/one_time_charges` replaces
  the detail screen fetching up to 100 invoices in full to read their one-time lines.
- **2026-09-24** — **Reactivation applies a coupon / manual discount before billing.** The
  reactivate route takes `coupon_code` / `manual_discount` and applies them in `reactivateAndBill`'s
  `beforeBill`; a refused charge removes them; a throw from `beforeBill` now re-cancels, so nothing
  is left live and unbilled. `estimateReactivate` takes `couponCodes` / `manualDiscount` as pending.
- **2026-09-24** — **`createSubscription` takes an exact `trialEnd`** (route `trial_end`), in place
  of `trialDays` and refused alongside it. A named end, so it aligns with `alignTrialEnd`: 23:59:59
  of that day on a day-anchored business, the instant itself otherwise. Must be after the start.
- **2026-09-24** — **`reactivateAndBill` (`reactivate.ts`).** The reactivate route's sequence —
  card pre-check, rebuild, bill the fresh term, refuse and re-cancel on a failed charge, adopt a
  stranded invoice into dunning on a THROWN charge, fire activation charges — moved out of
  `subscription-routes.ts` so a reactivating checkout runs the same code. `termStart` backdates the
  term (the caller clears it against the backdating policy); `beforeBill` is where a checkout
  applies coupons. Behaviour of the route is unchanged (create-gating, subscription-ops,
  subscriptions-v2, mrr-movements, idempotency-race, time-travel all green).
- **2026-09-23** — **Two writes that bypassed the movement ledger.** `reactivateSubscriptionWithOptions`
  wrote `mrr` inline, so the reactivation never reached `mrr_movements` (the ledger's Σ delta fell
  short of `mrr`) and it stored the list rate over a surviving discount. It now calls
  `recomputeSubscriptionMrr`, which rates net and appends the `reactivation` row
  (`verify:mrr-movements`, 3 checks, red on the old code). Separately, `retryInvoice` set
  `status = 'active'` whenever a dunning retry collected, which revived a subscription cancelled or
  paused mid-dunning at a rate of 0. The write is gone: an active subscription in dunning is still
  `active` (`verify:dunning` case J).
- **2026-09-23** — **`dunning_config.no_payment_method_at_renewal`** (`follow_final_action` |
  `cancel`, default `follow_final_action`). With `cancel`, the renewal gate cancels a cardless
  auto-collect subscription at the boundary (reason `no_card`, no invoice) even when the final
  action is `retain`; card declines still follow the final action. Applies to existing
  subscriptions at their next renewal. Settings → Dunning toggle; `verify:cardless-renewal` §7–8.
- **2026-09-21** — **A parked invoice gets a reminder ladder (`sweepParkedReminders`, 0283).**
  Every other dunning state talks to the payer BY ATTEMPTING — a retried invoice mails
  `payment_failed` on each failed charge, so its schedule doubles as its contact ladder. A park
  attempts nothing by definition, so it sent one notice and then nothing for the whole window,
  after which the final action cancels a subscription whose customer was told once, up to thirty
  days earlier. The rungs are the merchant's own `retryDays` measured from `dunning_parked_at`
  (one cadence in the product, not a second invented one), re-derived by `nextParkedReminderAt`
  on each advance rather than counted — `attempt_count` cannot index them because a park makes
  no attempts.
  ⚠️ **The rungs are in `dunning_next_reminder_at`, never `next_attempt_at`.** A parked invoice
  is auto-collect-ON, so a rung in that column would be picked up and CHARGED by `runDunningPass`
  — re-presenting the debit parking exists to stop — and would hide the row from
  `sweepExpiredParkedDunning`, which scans `next_attempt_at IS NULL`. One column cannot carry
  both meanings.
  ⚠️ **And it must not ring at or past the deadline.** Written without that guard, the gate went
  green while a reminder fired a YEAR past it: "settle by *date*" delivered after *date*, to a
  customer the same tick would cancel. `nextParkedReminderAt` refuses to SCHEDULE such a rung,
  but that says nothing about one armed earlier that only came due now, and the scan matches on
  `<= now` alone. The ordinary tick hides it — the expiry sweep runs first and the row is no
  longer parked — which is exactly the danger: it made the safety a property of the ORDER of two
  passes rather than of this one. Past the deadline the pass clears the rung and sends nothing.
  The rung is advanced under a conditional update BEFORE the event is emitted, so two overlapping
  ticks cannot both mail and a crash between the two costs a reminder rather than sending one
  every tick forever.

- **2026-09-21** — **A park ends with an ATTEMPT, not just an expiry.** `sweepExpiredParkedDunning`
  charged nothing at all — right for every day of the window and wrong on its last one, which is
  the distinction `scheduleTail` already draws for a retried invoice. Fixed mode has had that
  deadline attempt since the dunning period shipped (`planFailureRearm` arms a park with a
  configured period as a retry at the deadline); smart mode returns `parked` before the schedule is
  consulted and never reached it, and neither did a fixed-mode park on a business with no period
  configured — which is most of them. The attempt is not futile: a merchant-side fault the operator
  has since fixed, a mandate cycle that has since rolled over, and a card repaired at the issuer
  are all collectable, and nothing else would ever re-collect them. `NO_DEADLINE_ATTEMPT`
  (`decline-policy.ts`) carves out `network_do_not_retry`, where a re-present draws network fines;
  it is a DENYLIST because the failure this module keeps recording is an allowlist grown one code
  at a time and never swept.
  ⚠️ **Deliberately in the sweep and not in `planFailureRearm`.** Routing a smart park through
  `scheduleTail` sets `dunning_status='in_progress'`, and `merchantSideParks` (`ops/alerts.ts`)
  filters on `'parked'` — it would have silently disabled the alert its own docblock calls the only
  thing between a merchant-side fault and a silent cancellation. No claim is taken either:
  `collectInvoice` takes its own (`claimCollection`), so two overlapping ticks cannot both charge.
  Also: `gateway_account_unavailable` now parks in both modes and alerts as merchant-side. It was
  unclassified and `retriable`, so it ran the full ladder and exhausted — cancelling a subscription
  over our own gateway configuration. Its call site is `retriable: false` to reach the carve-out;
  nothing is marked invalid, because that path throws before the charge and `isHardDecline` never
  sees a result. And every exhaustion writer now stamps `dunning_exhausted_at` (0282) — see
  `src/modules/metrics/README.md` for why a recovery rate needed it.

- **2026-09-21** — **`last_earning_mrr` (0271): the rate a subscription carried while it earned.**
  `recomputeSubscriptionMrr` writes it beside `mrr` on every recompute that lands in an earning
  status, and leaves it ALONE on the branch that zeroes `mrr` for `cancelled` / `paused` /
  `in_trial` — that branch is exactly where the figure must survive. `createSubscription` and
  `reactivateSubscription` mirror it in their inline writes (a create that never recomputes would
  otherwise record nothing), and the importer records the netted figure it already computes, for a
  cancelled or paused row included. Why: analytics re-rated churned rows from their surviving items
  and the discounts do not survive a cancellation, so every comped account was valued at list price
  in every past bucket — see `src/modules/metrics/README.md` for the measurement. `paused` and
  `in_trial` deliberately do NOT read it back: a paused subscription earns nothing NOW, which is the
  2026-08-19 ruling and is what its own `mrr` says; the column only keeps what a later cancellation
  would otherwise destroy.

- **2026-09-17** — **Subscriptions can be DELETED, and it is a soft delete in any status.**
  `subscriptions.deleted_at` + `deleted_by` (0253), `deleteSubscription`,
  `DELETE /v1/businesses/:biz/subscriptions/:sub`, and a rail control on the detail page.
  **A hard delete was never available to us**: `invoices.subscription_id` is ON DELETE SET NULL,
  so removing the row would leave paid invoices and their append-only ledger entries with nothing
  to attach them to, while coupons, entitlements, scheduled changes, unbilled charges and checkout
  sessions cascaded away. So the row stays and a stamp hides it — reads 404, lists omit it, and
  every clock scan skips it — while its invoices, payments and ledger entries are untouched and an
  unpaid invoice stays payable and stays in dunning, because the debt is real whatever happened to
  the subscription that raised it. **No status is written and no cancellation is emitted**
  (a product decision, 2026-09-17): deleting an ACTIVE subscription stops billing it with no final
  invoice and no credit for unused time, so the dialog says exactly that and points at cancel for
  anyone who wants the term closed out. `status` is left alone deliberately — it records what was
  deleted rather than claiming an ending that never happened.
  The filter is one shared symbol, `notDeleted()` in `deleted-sql.ts`, because the failure mode is
  a scan that forgets it: that fails silently and bills a customer for a subscription the merchant
  removed. Applied to the lookups, both list paths, all three renewal scans (+ the inner re-reads,
  so a delete racing a tick cannot bill), the four reminder scans, the scheduled-change applier,
  metrics/analytics, the MRR drift invariant, the four portal reads and the customer MRR rollups.
  Gate: `verify:subscription-delete` (13 checks). It is **mutation-tested and the first shape of it
  was wrong** — removing the filter from the renewal scan alone did NOT redden it, because
  `loadRenewalCtx` catches the same case; only removing BOTH does, which is the honest reading of a
  defence-in-depth pair. The suite's CONTROL subscription also earned its place on the first run:
  it did not renew, because a cardless renewal cancels at the boundary, and without it "the deleted
  one raised no invoice" would have passed for the wrong reason.

* **2026-09-15** — `customer_credits_restored` (`cancellation-credit.ts`) now names the
  `customer` whose credits moved, as a PUBLIC id. Its resource type is `customer` and the
  payload named only the invoice, so the event enriched nothing at all; the plan's
  `customerId` is the internal uuid, which resolves just as quietly to nothing.
- **2026-09-15** — **A "Payment Method" filter group on the subscriptions list.** Twelve
  EXISTS fields over the subscription's CUSTOMER (`payment_method_*`), so they answer "does the payer
  hold any instrument matching" — deliberately a different question from `default_payment_method`,
  which is the one card THIS subscription is pinned to. Both are kept because operators ask both.
  The generic `VirtualFilter` / `existsFieldCondition` machinery moved from `customers/service.ts`
  into `platform/list-query.ts` so this module could use it instead of growing a third mechanism
  beside `plan` and `addon`. `apiStatusSql` moved out to `./status-sql.ts` — the customers list
  needs the same derivation for its subscription counts, and a direct import between the two
  services would close a cycle.
- **2026-09-11 (latest)** — **The renewal pass is bounded-concurrent; it was serial.** Each renewal
  is one gateway round trip and the loop awaited each before starting the next, so throughput was
  `TICK_PASS_BUDGET_MS ÷ latency` and nothing more principled: measured from
  `gateway_request_logs`, Stripe `payment_intent` means 593ms over 14,216 real calls and Razorpay
  `charge` 681ms over 15,126, giving **25 and 22 renewals per tick**. It never reached
  `TICK_SCAN_LIMIT` — the row cap is a red herring, the budget binds an order of magnitude earlier.
  Now `runBounded` (`platform/concurrency.ts`) with `TICK_RENEWAL_CONCURRENCY`, **defaulting to 1 so
  the deploy is byte-for-byte the old behaviour** until a deployment states otherwise. Safe without
  new locking: `renewSubscription` already claims the period advance with a compare-and-swap, and
  the gateway call happens outside the DB transaction, so a 600ms round trip never holds a
  connection. The deadline still bites between subscriptions only — work already begun completes,
  because a renewal must stay atomic. ⚠️ Raising it alone does nothing past 500/tick;
  `TICK_SCAN_LIMIT`, `TICK_PASS_BUDGET_MS` and the pg pool (`db.ts`, `max: 10`) all have to move
  with it, and the real ceiling is the gateway's PER-ACCOUNT rate limit — per business here, since
  each Business carries its own credentials. 1577 unit tests green, tsc 0, lint 0 errors.
- **2026-09-08** — Three pure config resolvers landed for the Billing LogIQ policy
  defaults (migration `0242`): `unbilled-charges-config.ts`, `pause-config.ts`,
  `backdating-config.ts`. Each is the credits-flexibility pattern — a nullable jsonb on
  `businesses`, one pure resolver, only an explicit VALID value opting out of the default.
  **Now WIRED**, and behaviour is unchanged for an unconfigured business because every default
  is the value its call site already resolved (whole unit suite green, 1143 tests, no
  regressions): `cancelSubscriptionWithOptions` takes both cancel enums plus the `cancelAt`
  backdating guard — it already read the business row, and `withSub`'s `business` is a narrow
  type that cannot carry the config · `defaultInvoiceImmediately(org, biz, event)` now resolves
  `unbilled_charges_config` and is called from `proration.ts` (`onChange`) and `items.ts`
  (`onOneTimeCharge` when `isOneTime`, else `onChange`) · the create route resolves `onCreate` ·
  pause/resume in this file, where every default means *pass no argument* · `isBackdateAllowed`
  guards `start_date` and `at`. Backdating is bounded at last — that gap is closed.
  ⚠️ **`pause_option`'s route zod went from `.default("immediately")` to `.optional()`.** A zod
  default is indistinguishable from a caller's explicit choice, so it masked the business default
  completely. Worth looking for that shape wherever else a site default is meant to apply.
  Wiring then WITHDREW nine keys, each a control with no enforcement point to reach: unbilled
  `on_reactivate` / `on_trial_to_active` (real operations, but reactivation has no
  invoice-now-vs-defer concept and trial conversion bills inside `renewal.ts`) · pause
  `pause_duration` / `resume_option` (no engine parameter at all) · `specific_date` and
  `billing_cycles` off `pause_option` (their meaning needs a per-call argument, so as a site
  default `specific_date` would THROW rather than do nothing) · backdating `reactivate` /
  `one_time` (neither accepts a past-dated instant — the only ones are `start_date`, `at`,
  `cancel_at`).
  Three defaults in the original spec were WRONG and are recorded here because each would
  have moved money on businesses that never opened a screen:
  · `charges_on_resume` had two values, and **neither could express an omitted argument** —
    `resumeSubscriptionWithOptions` runs neither branch, billing the resumed period at its
    next renewal. Hence a third value, `next_renewal`, which is the default and means *pass
    no `chargesHandling` at all*. Its sibling is spelled `add_to_unbilled_charges` to match
    `ResumeChargesHandling`; the shorter spelling matched nothing.
  · `dunning_on_pause` defaulted to `stop`, but `pauseSubscriptionWithOptions` acts only on
    `=== "stop"`, so an omitted argument lets retries CONTINUE.
  · `on_change` / `on_one_time_charge` defaulted to `invoice_immediately`, but both resolve
    `defaultInvoiceImmediately()` (`proration.ts`), whose `?? false` over a
    `NOT NULL DEFAULT false` column means an untouched business DEFERS them. They now
    **inherit** that column rather than hardcoding either answer — the same fallback idiom
    `requireSuccessfulChargeOnReactivation` uses, and it preserves a merchant's existing
    setting instead of discarding it.
  The matrix is **five** events, not eight: `on_term_extend`, `on_advance_charge`
  and `on_future_to_active` govern operations this engine does not have, so they were dropped
  rather than shipped as controls reaching nothing.
  `backdating-config.ts` also exports the pure predicate `isBackdateAllowed`, called from
  nowhere yet. Backdating is currently UNBOUNDED, and the predicate is
  timezone-explicit on purpose: a cut-off day is a calendar-day question in the BUSINESS
  timezone, and it biases to allow on an unparseable date rather than refuse work.
- **2026-09-08** — `Estimate` gained **`discount_lines`**, the named twin of `tax_lines`.
  `discount_minor` was a lump sum, so every surface quoting an estimate could show a total already
  NET of a discount beside line items that were GROSS, with nothing naming the difference. The
  buyer's portal was the visible case: plan lines summing to ₹13,818 above a next payment of
  ₹10,758.86. Populated in `estimateRenewal` from `plan.discountRows` plus the promotional slice,
  so the rows sum to `discount_minor` — the promo has to be included or they fall short by exactly
  it. Additive; `discount_minor` is unchanged and no caller had to move.
- **2026-09-07** — The reactivation payment gate is its own setting. It used to read
  `dunningConfig.collectOnPaymentMethodUpdate`, one control overloaded for both "charge a new card
  now" and "refuse a reactivation whose charge fails". Now
  `requireSuccessfulChargeOnReactivation`, which **falls back to the
  old field when absent** — that fallback is the whole migration, and it matters most for a
  business that had turned collection off: reading the new key as "default ON" would have switched
  the refusal back on for exactly those. `resolveDunningConfig` owns the fallback so the engine and
  every screen resolve it the same way.
- **2026-09-06** — A namespaced error taxonomy sits over the canonical codes
  (`platform/error-taxonomy.ts`, #69 stage 4). `resolveStoredErrorId` in `providers/decline-codes.ts`
  maps any stored failure code — ours, a raw provider spelling, or an imported one — to
  `gateway.<family>.<code>` using eleven families, or to `billing.<family>.<code>` when the
  engine raised it rather than a gateway. Nothing stored changes; the id is derived. What this
  module gains is that `classifyDecline`'s inputs are now filed on an axis a report can group by.
- **2026-09-06** — Decline overrides gained a SECOND level: a setting on the canonical
  code, covering every rule that produces it (0234). `rank()` is the one place the four tiers live
  — rule+account · rule+all · code+account · code+all — and both the engine and the settings screen
  resolve through it; the winner takes the whole answer rather than merging field-by-field, so a
  rule a merchant deliberately set back cannot be overwritten by the code above it. Because the
  engine's override query matches on the code arm with or without a rule id, the 32 codes no rule
  names are now governed too. Two defects fixed in passing: the screen computed `retriable ?? true`
  where the engine computes `?? !TERMINAL.has(code)` (four rules displayed the wrong answer — both
  now call the exported `builtInDeclineAnswer`), and `orphanedDeclineOverrides` checked only
  `decline_rule_id`, which would have reported every code-level row as orphaned.
- **2026-09-05** — Reactivation's payment gate is configurable, on an existing
  control rather than a new one. *"The subscription is enabled only after payment
  collection"* is gated on the Billing LogIQ toggle **"Payment collection when payment method is
  added"** (on by default) — the toggle we already carry as
  `dunning_config.collect_on_payment_method_update`. Checking that before designing
  is what killed the migration I had planned: our default was already right. With it ON
  a reactivation whose charge fails is refused, voided and re-cancelled (unchanged); with it OFF
  the reactivation stands and the unpaid invoice goes to dunning. One control carries both
  effects, so the dunning settings row states both — a control that hides
  half of what it does breaks the same rule as one that does nothing. ⚠️ NOT applied to
  subscription CREATE: a failed initial charge there is unestablished, and mirroring an unverified
  behaviour is how a guess becomes a rule. `verify:create-gating` cases 9 and 10 pin both
  positions. See `docs/PROGRESS.md` #62, and #63 for a still-unexplained failed reactivation that
  left a subscription active on an unpaid invoice.
- **2026-09-04** — 🔴 **A parked invoice could never close, so a subscription served for
  free indefinitely.** `sweepExpiredParkedDunning` gated on `PARKED_WITH_DEADLINE`, an allowlist of
  the declines a customer can clear. It reached 4 of `PARK`'s 13 codes and `expired_card` was not
  one of them — the textbook dunning case, parked forever. 50 of 52 parked invoices on the dev book
  could never close; `recurring_not_enabled` alone held 35 subs / ₹19,85,025, oldest parked
  2025-07-24. The set had been grown one code at a time and never swept back over the card declines.
  Decision (the user, 2026-09-04): **a park is a dunning state and every dunning state ends** —
  whether closing cancels stays `finalAction.subscription`. `PARKED_WITH_DEADLINE` is gone;
  `MERCHANT_SIDE_PARK` replaces it and gates an ops alert, not an exemption. ⚠️ Removing the gate
  alone would have exhausted all 50 stale parks on the next tick, because the deadline was anchored
  on the DUE DATE — so `0232` adds `dunning_parked_at`, re-anchors the window on the park (what the
  clock actually measures) and backfills `now()`, which is the rollout. `PARK` is now exported so a
  test can enumerate it: a code added later cannot arrive unasserted, which is how `expired_card`
  was missed. See `docs/PROGRESS.md` #59, and #60 for the two follow-ups (the ops alert, and
  `mandate_cycle_limit_exceeded` self-clearing at the cycle boundary).
- **2026-09-03** — 🟠 **The cancel estimate could not see a live buyer checkout, so the
  operator got no warning when a cancellation cleared a debt someone was mid-way through paying.**
  `debits_in_flight` existed on the CHANGE estimate only; `CancelEstimate` had no such field.
  Predicted and then confirmed by a deliberate test: Pay now at 17:47:08, cancel ten seconds later,
  payment completed afterwards — no warning at any point, and the capture arrived later, was booked
  as excess and auto-refunded three seconds after landing. Now carried on `CancelEstimate` using the
  SAME `pendingPaymentsForInvoices(..., { includeIntents: true })` helper and `DebitInFlight` type the
  change path uses, and widened to `account_receivables_handling = write_off` — warning only on the
  credit would have warned less on the more destructive action. The copy deliberately does NOT name
  the gateway: the estimate carries no `capabilities.intentVoid`, and a label the screen cannot verify
  is the one CLAUDE.md forbids. `schedule_payment_collection` is knowingly uncovered — collecting over
  a live checkout is a second DEBIT, not a cleared debt, and the warning's sentence would be false of
  it (#27). See #22 in `docs/PROGRESS.md`.

- **2026-09-03** — 🔴 **A cancel after ANY mid-term plan change over-credited, and the excess
  was all CASHABLE.** `termInvoices` selected by period OVERLAP with the current term, and its docblock's
  stated safety ("the previous term's period_end equals this term's period_start") holds only when terms
  tile end-to-start — a mid-term change starts a new term at the change instant while the old invoice
  keeps a window running past it. Measured on `sub_XXXXXXXXXXXXXXXXXXXXXX01`: **26** invoices overlapped
  (₹12,71,775.46) where **8** actually started at the term start, the estimate's chosen primary was an
  invoice from three plan changes earlier, and the dialog offered ₹81,419.20 (₹59,235.20 of it payable
  out) where ₹32,943.24 was owed. Now `periodStart >= termStart && periodStart < termEnd` — NOT `==`,
  because a mid-term add-on invoice does not carry the term's start and must survive. **Two further
  defects surfaced, both found by the new gate rather than by reading:** the adjustment branch capped its
  cash slice at `cashAvailable` alone, which on an invoice funded by recycled credit cut it to ₹0 and
  UNDER-credited by ₹10,759.24; and `planDeliveredMinor` omitted `refundableCreditNoteMinor` on that
  branch, so the reported figure never counted a note the writer has issued since 2026-08-26. A rejected
  fix is worth recording: selecting on "still carries uncredited charge" would have OVER-selected —
  three superseded invoices carry real uncredited charge for time the customer USED before each change.
  14 assertions in `verify:invariants`, mutation-tested individually. See #19 in `docs/PROGRESS.md`.

- **2026-09-01** — **D3 CLOSED, and it was never an estimate defect: the BOOKING dropped a
  credit note it had already written.** `creditOneInvoice` answered `adj ?? refundable`, so an
  invoice legitimately carrying BOTH an adjustment note (the debt it relieves) and a refundable note
  (the cashable overflow) reported only the adjustment. It now returns `CreditNote[]` — both, in
  write order — and the three call sites in `issueCurrentTermCredit` / `creditAcrossInvoices` collect
  them. `verify:credit-chain-gateway` § 9's own DB count had been reporting the discrepancy on every
  run (*"business went from 5 to 10 notes"* beside a returned list of 4); nobody read the two lines
  together, and the ₹9,420.18 the preview was accused of over-quoting was exactly the missing note.
  The preview was right share for share and gross for gross — 990639 / 1935484 / 1537507 / 5802047
  pre-tax and 1168954 / 2283871 / 1814258 / 6846415 gross on BOTH sides. Beyond the suite: the
  `/change` response told a customer about the adjustment and not about the refundable credit the
  same change had just granted them. § 9's document-set assertion moved with it, from a COUNT
  (*"exactly ONE note per credited invoice"*, which only passed because a note was invisible) to at
  most ONE note **of each kind** per invoice — strictly stronger, and still falsifiable by the M1
  duplicate-note shape. Two notes on one invoice is the correct outcome for a part-paid invoice: a
  refundable note for the paid-above-new-value slice ($80 − $75 = $5) plus an adjustment note for
  the original unpaid amount ($10).
- **2026-09-01** — **A freed EXCESS PAYMENT reaches the preview POST-tax, and it must never move a
  tax basis.** The `freedPromoMinor` fix below deliberately left open whether the `freedExcessMinor`
  slice should reduce the taxable base the same way. **It must not, and that is measured, not
  argued**: four arms differ only in what part-funds invoice #1 — nothing / cash / an excess
  payment / a promotional grant, the last as the POSITIVE CONTROL so that a null result is readable
  at all. An excess payment is an
  unapplied PAYMENT TRANSACTION (`type=payment`, `amount_unused`), and the `excess` arm came out
  **byte-identical to `cash`** on every figure:
  invoice #1 `amount_paid` 3647.20 with no `discounts` row and IGST 1641.24 = 18% of the FULL
  9118.00; the freed slice returned as a refundable note of 3090.82 + 556.35 tax, also 18%; and on
  the replacement invoice it came back as post-tax `credits_applied` 3647.20 with tax still 18% of
  the whole 27918.00. The `promo` arm moved the basis on all three rows (a `promotional_credits`
  discount row, and a note whose tax is 18% of `sub_total − discounts`). So
  `grossCreditOnInvoice`'s promo-only `creditsAmountDue` gate is **correct as it stands** —
  extending it to `excessAppliedMinor` would have been a real regression. What WAS missing is the
  post-tax leg: the booking restores the freed excess to the excess bucket before raising the
  proration invoice and that invoice draws it down, while the preview read the STORED bucket.
  `estimate.ts` now widens `planCreditApplication`'s balances by `routed.freedExcessMinor` (and only
  that phase — the pre-tax promotional simulation is untouched). Measured on
  `verify:credit-chain-gateway`: § 9 `amount_due_minor` ₹1,88,202.45 → ₹1,72,010.40, matching the
  invoice's issued collectible exactly; § 8 ₹67,129.25 → ₹51,767.72.
- **2026-09-01** — **D2's residue is NOT a tax basis and NOT a split of one gross — the engine holds
  TWO definitions of an invoice's credit capacity.** Filed here rather than fixed, because which one
  is right is not established. `creditAcrossInvoices` (the allocator, which `estimate.ts` mirrors)
  clamps to `min(due + creditable + recycled, ceiling)`; `clampToCapacity` (the single-invoice path
  § 8 takes) clamps only to `remainingCreditableAgainstInvoice`. On § 8's INV-4 that is 3939628
  against 4272209 — the preview drops 281849 of pre-tax credit as `unplacedMinor`, the booking writes
  the full 4272209 and then `splitCreditByFunding` STRANDS 148423 of it on nobody. The stranding
  suggests the funding cap is the binding one, but settling it needs its own measurement (does a
  credit shrink because the invoice was funded by recycled credit, on an invoice that already carries
  a note?). ₹1,841.58 is the whole of what is left of D2.
- **2026-09-01** — **The change PREVIEW under-stated promotional credit on a promo-funded
  chain: it applied none of the grant the same change hands back, and it reported the credit note's
  GROSS where the document prints its total.** Booking untouched — it was already
  correct. Measured on scenario `dA`
  (LITE-INR part-funded by a ₹3,647.20 promotional grant, then three chained plan changes) against
  the control `dAc` (identical chain, grant removed): **20 estimate mismatches → 0**, control stayed
  at 0, and `dB` (term reset over three invoices) stayed at 0.
  * **It failed to APPLY.** `creditOneInvoice` returns the promo-funded slice of a credit to the
    promotional bucket (`restoreBucketFundedSlices`) *before* the proration invoice is raised, and
    that invoice then draws it PRE-tax. The preview priced the promotional draw from the STORED
    balance — which is 0, the grant having been spent on the source invoice — because the block ran
    ABOVE the credit side. It is now computed after `routed`, and `simulatePromotionalDiscount` takes
    `routed.freedPromoMinor` as credit this same change frees. Per preview: `discount_minor` 0 →
    364720, `tax_minor` −65650 (18% IGST on it), `total_minor` −430370.
  * **…and the cap was the wrong quantity.** It was `net − discount`, i.e. charges MINUS the credit
    lines, so a change whose credit outweighs its charges capped the promo at 0. The negative lines
    never reach the invoice (they become a credit note), so the invoice's real promo cap is its own
    discounted CHARGE subtotal, which is what it now is. `dA` step 8 proves it: a ₹9,118.00 charge
    is discounted by the full grant while ₹61,915.54 is credited.
  * **It failed to REPORT.** `credit_note_total_minor` carried the note's GROSS. A slice returned to
    the promotional or excess bucket is a DISCOUNT ROW on the note
    (`total = sub_total − discounts + tax`; CN-188 is sub_total ₹41,899.00, one
    `promotional_credits` discount of ₹41,899.00, total ₹0.00), so the note's printed total EXCLUDES
    it. The field is now that printed total; the gross is
    `credit_note_total_minor + credit_returned_to_buckets_minor`, which is what the five legs sum to.
    `verify-credit-chain-gateway`'s own assertion ("credit_note_total_minor == Σ the notes this
    change actually raised") had been saying so all along — it is what D2 and D3 are filed against,
    and both moved: **D2 ₹39,396.28 → ₹24,034.75 against a booked ₹24,579.51** (a ₹14,816.77 gap
    down to ₹544.76) and **D3 ₹1,21,134.98 → ₹1,04,942.93 against ₹95,522.75** (₹25,612.23 down to
    ₹9,420.18). Neither closed, so neither left `KNOWN_ESTIMATE_DEFECTS`; the residue on both is the
    preview and the booking splitting one gross differently between the cashable leg and the EXCESS
    bucket (§8: ours 24034.75/15361.53, booked 24579.51/14816.77 — the same ₹544.76 either way).
    Deliberately NOT touched: whether EXCESS payment should also reduce a taxable base is a
    different question from whether promotional credit should, and it was not measured here.
- **2026-09-01** — **Cumulative credit notes could exceed the invoice they credit (M1),
  the change PREVIEW grossed its credit up on a blended ratio over the wrong invoice set, and
  `prorate: false` was honoured by the plan swap and ignored by the re-rate that follows it.**
  * **M1, the money one.** `creditAcrossInvoices` built each invoice's capacity as
    `due + creditableCapacityForInvoice + recycled`, where `recycled` is what the customer's own
    promotional / excess / refundable balance settled. That last term was added RAW, so it re-offered
    exactly the value a full-value note had already reversed:
    `creditableCapacityForInvoice` correctly reports 0 for a fully credited invoice and `recycled`
    overrode it. Cash-funded invoices were safe only because their `recycled` is 0 — which is why the
    earlier fix on `sub_QYsquS` looked complete. Measured read-only on the dev database 2026-09-01:
    **52 invoices carried non-voided notes summing past their total, ₹1,23,250.81 over**, earliest
    2026-08-24; INV-5511 (₹66,219.24) carried ₹76,238.26, including *"Unused time on BUSINESS plan"*
    for the window 08-31 → 09-29 issued TWICE.     `db/schema/credit-notes.ts` claimed this invariant
    ("Cumulative credit notes can never exceed the invoice total (enforced in the service)")
    and nothing enforced it where a term credit was PLACED. **That comment was itself corrected
    2026-09-01**: the real ceiling on REFUNDABLE notes is the invoice's PAID amount,
    cumulative and UNNETTED, and ADJUSTMENT notes do
    not consume that ceiling. It is now enforced at both writers inside `lockInvoiceCredit`,
    which makes these four reader clamps an optimisation rather than the enforcement. New ceiling
    `remainingCreditableAgainstInvoice` (credit-notes/service) = `total − Σ non-voided note totals`,
    clamped into all FOUR sites that build the same term: `creditAcrossInvoices`,
    `termInvoiceCanAbsorb`, the preview's per-invoice `capacityMinor` and the preview's F-40 reset
    gate. It is a `min`, not a new capacity model — on a first credit the ceiling IS the invoice
    total, so the credit-funded case `recycled` exists for is byte-identical. Reproduced and pinned by
    `probe-estimate-vs-booked-change-chain` (chained changes, each crediting an invoice the previous
    one funded with credit): before, INV-2 total ₹66,219.24 carried ₹99,328.86; after, the chain's
    last step raises ONE note of ₹66,219.24 instead of two halves, one of which had no room.
    **Not** fixed by widening `creditableCapacityForInvoice` — that re-breaks the chained-change
    case, and the
    defect was a term added beside it, not the term itself.
  * **M1, THE SECOND DOOR — the ceiling was right and its UNITS were wrong.** A peer
    falsification test (`scripts/verify-credit-cap-invariant.ts`: seven chained changes so every
    invoice after the first carries a non-zero `refundable_credits_applied_minor`, then two
    `resetTerm: true` changes) still reproduced over-crediting on the clamped tree —
    **INV-4 66,219.24 carrying 66,616.56, INV-7 64,011.94 carrying 64,480.77, ₹866.15 over**.
    Diagnosed before changing anything, by instrumenting every placement path:
    `creditAcrossInvoices` distributes the **PRE-TAX** list total (that is what
    `creditOneInvoice` takes) but clamped each share against a **GROSS** capacity — `due +
    creditable headroom + recycled`, and now the ceiling too. A share clamped AT the cap was
    then grossed up past it, by exactly the invoice's tax fraction and not as a rounding
    artefact: INV-4's ceiling of 220731 admitted a 220731 pre-tax share written as 260463
    (+39732 = 18.000%), INV-7's 260463 → 307346 (+46883 = 18.000%), summing to the 86615
    observed. The mismatch predates M1 and was simply too permissive to bind until a ceiling
    existed. Fixed by converting the cap **once**, into the units being distributed, with
    `preTaxCreditFitting` — which inverts `grossCreditOnInvoice` against the map itself rather
    than by one division, because three half-up steps make the forward map a step function
    whose inverse a division misses by a unit or two. That extraction also removes the second
    copy of the gross-up arithmetic: `estimate.ts` now calls the same
    `grossCreditOnInvoice`. **Red-then-green proven:** reverting only the conversion returns
    the test to exit 1 with the identical 397.32 / 468.83 / 866.15.
    **The mismatch predates M1** and that is the more useful half: `capacityMinor` has always
    been gross while the distributed total has always been pre-tax, so it was ~15% too
    permissive from the day it was written and simply never bound, because nothing capped
    anything. The ceiling did not introduce the bug; it made a cap bind for the first time.
    A guard that has never bound has never been tested either.
  * **The two allocator-bypassing paths, now measured rather than argued.** `targetPriceIds`
    resolving to a SINGLE invoice, and the newest-live fallback, both credit one invoice
    directly and had no capacity check of any kind. The first version of that guard was placed
    on the structural argument alone; `scripts/probe-single-invoice-credit-cap.ts` now supplies
    the red-first evidence — **path A: INV-1 ₹38,843.24 carrying ₹41,900.00 (+₹3,056.76);
    path B: INV-3 ₹32,943.24 carrying ₹35,900.00 (+₹2,956.76)** — both green with the clamp and
    both returning with it disabled. ⚠ The FIRST cut of that fixture was GREEN: a manual note
    eating the invoice's value is not enough, because `creditOneInvoice`'s paid branch caps its
    cashable slice at `refundableCapacityForInvoice` — the PAYOUT question, which subtracts only
    a note's OUTSTANDING claim. ALLOCATING the prior note elsewhere zeroes that claim and the
    invoice reports its whole value available again, which is exactly the gap
    `creditableCapacityForInvoice` exists for. Two constructions do NOT reach path B and the
    record is worth as much as the fixture: an item added with `invoice_immediately: false` nets
    its credit to zero against the cancelled queued charge, and a null `price_id` on a supply
    line is reachable only through `invoicing/import.ts`. What works is invoicing the item and
    then VOIDING that invoice.
  * **Behaviour change worth knowing:** `preTaxCreditFitting` returning less than the caller
    wanted does not leave the remainder owed. The allocator re-places it onto an invoice with
    headroom first, and anything still unplaced becomes `unplacedMinor`, which
    `creditAcrossInvoices` DROPS. That was always the contract; what is new is that it is now
    REACHABLE, where the gross capacity never bound. `estimate.ts` reports the same quantity as
    the `stranded` leg of `credit_destinations`.
  * **The preview's credit gross-up (🟡 filed 2026-08-31, closed).** `estimateChange` computed the
    note's worth as ONE blended ratio over every non-void invoice, `rawCreditBase × Σ total / Σ
    listBase`, then distributed that gross. The booking does the opposite order and over a different
    set: `issueCurrentTermCredit` targets the invoices that CHARGED the credited prices
    (`invoicesChargingPrices`), distributes the PRE-TAX list total, and grosses each share on its own
    ledger. Under India GST the two cannot agree, because an invoice's booked tax is a component
    vector: ₹8,814.07 of base is CGST 9% + SGST 9%, each rounded half-up (79327 + 79327 = **158654**)
    where one blended 18% gives **158653**. Blend that invoice with two whose components land on .00
    and the extra paisa averages away — booked note ₹10,400.61 against a quoted ₹10,400.60, and the
    preview asked for a paisa of cash the booking never wanted. Half-up on the blended ratio was
    measured first and does NOT fix it (the fraction is below .5); the loss is the blend. The preview
    now (a) records the credited price ids on every negative line and resolves the same target set,
    falling through to the whole term exactly where `wholeTerm` does, and (b) reproduces
    `creditOneInvoice`'s three rounded steps — discount rescale, refund rescale, half-up tax reversal
    — instead of the closed form `preTax × inv.total / listBase`, which is exact only in real
    arithmetic. All five chain steps now match to the paisa and the probe's tolerance is 0.
    `total_minor` stays the NET quote, untouched: its fourteen assertions are
    unmoved.
  * **`prorate: false`, one flag and two answers.** The F-17 "AND BILL THE MOVE" block carried no
    `prorate_` guard, so a change promising no prorated artefacts still booked `+₹18,800 "Remaining
    time on Additional Connections"` and credited `₹30,080` for the re-rated add-on while the PLAN's
    own proration was correctly suppressed (`verify:rerate-accounting` S7). Which side is right is a
    behavioural question, not an arithmetic one, so it was measured rather than reasoned about: two
    identical subscriptions differing
    only in `prorate`. With `prorate=true` the change raised invoice 3193 (BUSINESS ₹56,118 +
    connections ₹470) and CN-727 (PRO ₹27,918 + connections ₹752); with `prorate=false` it raised **no
    invoice, no credit note and no add-on line anywhere**. The differential re-rate must be suppressed
    along with everything else. The BILLING is now guarded; the
    SNAPSHOT merge stays outside it, as it does for the reset guard, because that is what makes the
    subscription renew at the new contracted rate. S7's residual moved −₹18,800
    → −₹7,520, both unasserted, and the new one is the honest plan-line gap without the add-on's
    prorated pair inflating it.
  * **The stranded leg now has coverage, without a fixture that strands.** Three constructions were
    built and none stranded — `termCapacity` caps the grant at what can be placed, before routing —
    so instead `probe-estimate-vs-booked-change-chain` asserts all FIVE legs against the booking's own
    decomposition: `adjustment` = Σ adjustment-note totals, `buckets` = Σ `credit_note_discounts` of
    type promotional/excess, `refundable` = Σ refundable-note totals, and `stranded` as the residual
    against the gross. A second scenario (a promotional-credit-funded UNPAID term, downgraded on day
    2) drives the adjustment and bucket legs, which the cash-paid chain cannot reach. **The 400265
    figure PROGRESS attributed to a booking stranding is not a stranding at all** — it is the
    pre-clamp `freedExcess` overshoot (2400265 restored against 2000000 ever drawn), documented at
    `verify-proration.ts` E3 and `credit-routing.ts`. That is why it could not be reproduced as one.
  * **Found by the new fixture and NOT fixed here:** on a promo-funded unpaid term the preview
    ignores the promotional credit the change RESTORES being spent again on the invoice the same
    change raises — quoting ₹10,065.11 of cash where the booking collects ₹0 (promotional discount
    ₹8,529.75). The routing block depends only on the source invoices, so it could be hoisted above
    the promo draw and its `freedPromo` / `freedExcess` added to the available buckets; that moves the
    most heavily asserted block in `estimate.ts` and is a different defect from this session's, so it
    is filed with the fixture that finds it rather than bundled.
- **2026-09-01** — **A parked invoice's dunning deadline no longer borrows the retry
  schedule's tail.** `PARKED_WITH_DEADLINE` gained the three customer-clearable mandate refusals
  (`mandate_expired`, `mandate_ceiling_exceeded`, `mandate_spent`) beside `afa_not_completed`, and the
  fallback used when a business has configured no `dunning_period_days` — which is every business that
  has never opened the Dunning settings form — moved from day 7 of `[1,3,5,7]` to `PARKED_GRACE_DAYS`
  (30). The two clocks measure different things: a retried invoice at the tail has had four charge
  attempts, a parked one has had **zero**, and its clock measures how long the CUSTOMER has to clear
  the refusal at their bank. The principle holds and the number does not carry over: a dunning
  period is required with no unlimited option, the period ends and the final action fires regardless
  of decline class, and 3DS failures are retried only the day before it ends — but a
  merchant-typed period supplies no default. An explicit
  `dunning_period_days` still wins in both directions. Day 7 is now asserted STILL PARKED in
  `verify:dunning-smart` (21/21) and `test/unit/decline-policy.test.ts` (16), so reverting the
  constant fails a test.
- **2026-09-01** — **A re-cut queued charge no longer throws away the customer's half, and
  the unused-time credit basis was cleared by measurement rather than changed on reasoning.**
  * **The money bug (fixed).** `applyUnbilledChargeSettlements` re-queued a settlement's surviving
    slice only `if (keptMinor > 0n)` — an assumption that every `unbilled_charges` row is a CHARGE.
    It is not: a change applied with `invoice_immediately: false` whose net is positive queues BOTH
    halves of its proration, and the unused-time half is NEGATIVE (measured,
    `scripts/probe-settle-queued-semantics.ts` §B: `-45120.00 "Unused time on Additional Connections
    ×60"` beside `+28200.00 "Remaining time on …"`). Re-cut one of those partway through its window
    — a mid-term removal or quantity cut — and the guard voided the row and never re-queued the
    negative survivor. Measured (`scripts/verify-rerate-accounting.ts` S4, deferred downgrade at
    day 10, add-on removed at day 20): the `+9400.00` survivor was re-queued and the `-15040.00` one
    dropped, leaving the subscription's net booked position at **₹86,198.01 against ₹71,158.00 owed
    for the time actually held — ₹15,040 over-billed**, named by no document. The skip is now
    exactly `=== 0n`: a slice worth nothing is not worth a row; a slice worth anything, either sign,
    belongs to whoever it is worth it to. S4 now closes to the paisa and no other shape moved (S2
    went from 1 paisa out to exact).
  * **The credit basis (measured, deliberately NOT changed).** PROGRESS's open item proposed rating a
    removal's unused-time credit off the newest BILLED invoice line instead of the item's
    `price_snapshot`, which a plan change has already re-priced. Twelve shapes were measured against
    the invariant *net booked == owed for the time held* (`verify-rerate-accounting.ts`):
    immediate and deferred, both directions of the differential, term reset, `prorate: false`, a
    quantity move in the same call, a 752→470→752 round trip, and a change surviving a renewal.
    **Eleven of twelve close to the paisa on the CURRENT basis**, and the twelfth (`prorate: false`)
    diverges only by the plan proration that flag suppresses by design. The snapshot is right because
    the change accounts for its own re-rate — F-17's "AND BILL THE MOVE" block and the reset charge
    loop both do — so the snapshot IS what the customer holds. The billed-line basis would have
    over-credited ₹16,920 in the immediate shape and ₹62,040-against-₹45,120 in the deferred one.
    The ₹16,920 loss recorded on `sub_XXXXXXXXXXXXXXXXXXXXXX03` is residue of the era before those
    two fixes (2026-08-28, 2026-08-31), not live behaviour.
  * **Recorded, not fixed:** `prorate: false` is honoured on the plan swap and IGNORED by the F-17
    re-rate pair (proration.ts ~3475 carries no `prorate_` guard), so a change that promises no
    prorated credits or charges still books them for a re-rated add-on. One flag, two answers. It
    costs nobody money — the add-on side is arithmetically correct either way — but it is a
    behavioural question worth its own item. Measured in S7.
- **2026-08-31** — **A prorated credit note now says WHICH PERIOD it hands back, and says it
  the same way on every path.** Three defects in one document, all measured before being touched:
  * **The window.** Credit-note items reached the writer with `period_start`/`period_end` NULL on the
    change path, and with the SOURCE LINE'S window — the whole term, including the part the customer
    used — on the multi-invoice split path. Both are visible side by side in live INR data
    (`sub_XXXXXXXXXXXXXXXXXXXXXX01`: CN-1689 no period, CN-1741 the whole term). A note must stamp
    the CREDITED window and nothing else: measured 2026-08-31
    (CN-723 → `date_from` = the change date, `date_to` =
    the OLD term end, on a term billed 31-Aug → 25-Sep). `issueCurrentTermCredit.creditedPeriod`
    carries it now, derived ONCE by `changeCreditedPeriod` so the downgrade, upgrade-side and
    term-reset builders cannot disagree — it is the same pair of instants the AMOUNTS were cut on, so
    a note can no longer claim a window its own money does not match. The END is the OLD term end
    even on a reset (the new term is what gets CHARGED).
  * **The wording.** The change path appended `— prorated credit` to the charge line's own text, so
    one operation produced three strings — "Unused time on BUSINESS plan ×1", "Unused time on PRO
    plan", "… ×1 — prorated credit". All three paths now go through `creditedDescription`, which is
    also **idempotent**: its input is sometimes a charge line to re-point and sometimes an
    already-credit-worded line, and routing the change path through it first produced
    **"Unused time on Unused time on BUSINESS ×1"** (caught by `probe-unpaid-plan-change.ts` the same
    day — the same double-prefix shape this file records shipping once before). Our phrasing is
    deliberately our own and stays that way; being internally inconsistent was never part of the
    decision.
  * **The link.** A credit-note line carries `reference_line_item_id` → the source INVOICE line
    (its `entity_type`/`entity_id` point at the *price*, not the line). Ours was NULL on the change
    path. `linkItemsToLines` resolves it from the item's `priceId`, and ONLY where exactly one
    positive line on that invoice charged that price — an invoice can carry two lines for one price
    (a scale-up bills the delta beside the original), and a guess would point the document at the
    wrong supply, which is worse than the honest NULL.
  Cancellation notes get the same treatment (`CancellationCreditPlan.creditedFrom/creditedTo`), with
  `creditOption: 'full'` stamping the WHOLE billed window rather than the tail, because that option
  reverses the entire invoice. ⚠ The *cancellation* path was **not** separately measured — it follows
  the change rule by construction, not by observation. Item removal passes its window too; its line
  WORDING is deliberately left alone (`<handle> — prorated credit for unused time`) because
  `dashboard/lib/estimate-lines.ts` and the SDK docs describe that exact string.
  Verified end to end by `scripts/probe-unpaid-plan-change.ts`: item period 04-Sep → 30-Sep (the
  credited tail) against a source line still reading 31-Aug → 30-Sep, description
  "Unused time on BUSINESS ×1", `invoice_line_item_id` resolved.
- **2026-08-31** — **`estimateChange` now reports WHERE the whole credit note went, not just two
  of its legs.** Adds `credit_applied_to_this_invoice_minor`, `credit_returned_to_buckets_minor`,
  `credit_stranded_minor` and `invoice_total_minor`, so a ladder — *Invoice total →
  Credit applied → Total due now* — can be rendered without any client-side arithmetic.
  * **Why it could not be derived.** The tempting
    `credit_note_total_minor − credit_applied_to_open_invoices_minor` equals the applied slice
    EXACTLY on the unpaid-term shape everything was debugged against (₹88,664.44 − ₹22,098.13 =
    ₹66,566.31), because the other three legs are all 0 there. On a downgrade it over-quotes by
    the credit that overflows to the balance — measured at **88736** in `verify:estimates`. Two of
    the legs (`planOpenInvoiceCreditRouting`'s `strandedMinor` and
    `distributeCreditAcrossInvoices`'s `unplacedMinor`, the latter previously discarded at the
    call site) were not exposed at all, so no caller could have got it right even in principle.
    It is also what `credit-routing.ts`'s header forbids — "Neither may re-implement them" — a
    client subtraction being a fourth definition of the split.
  * **`invoice_total_minor` is reported, not inferred.** `subtotal_minor` is the NET of the charge
    and credit lines and goes NEGATIVE on a downgrade (−75,200 against an invoice of ₹52,354.24),
    and `total_minor` is already net of the credit applied — so the obvious reconstruction
    `subtotal + tax` has the wrong sign, not merely the wrong precision.
  * **The identity, asserted.** `verify:estimates` gains
    `creditLegsAccountForTheNote`, run on every fixture that issues a note:
    `gross = appliedHere + refundableAdded + toOpenInvoices + returnedToBuckets + stranded`.
    Mutation-tested by implementing the naive derivation — it fails the downgrade fixture and
    passes the unpaid-term one, which is the whole point, so a guard asserts the two fixtures
    actually diverge (by 88736) rather than only ever agreeing.
  * **Follow-up the same day, for the dialog we actually render.** The netted ladder above is not
    the right shape: the charges table is PURE (total = gross charges, the credit
    never enters it) and credits are a named PROSE section that states the credit TYPE
    ("Prorated **Adjustment** Credits"), the specific invoice ("#58") and the period. Four more
    fields, so three surfaces don't each guess:
    * `credit_destinations[]` — one entry per destination, each `kind`-labelled
      (`adjustment` | `refundable` | `bucket_restore` | `stranded`) and, for an adjustment,
      carrying the invoice's PRINTED number. ⚠ The kind is deliberately not inferable from
      which scalar is non-zero: one change can raise BOTH an adjustment and a refundable note
      (PRORATION.md:347-348), which is exactly the case an inference mislabels. Entries sum to
      `credit_note_total_minor` by construction.
    * `credited_period_start` / `credited_period_end` — the unused window, which we stated
      nowhere.
    * `invoice_subtotal_minor` — the row above tax, so a pure charges table needs no
      arithmetic. NOT `invoice_total_minor − tax_minor` (equal only while the promotional
      discount is 0) and NOT `subtotal_minor` (net of the credit lines, negative on a
      downgrade).
  * **A promo-funded fixture, closing a gap this file had documented as untested.** Both
    existing fixtures leave `buckets` and `stranded` at 0, so the conservation identity had
    never exercised a bucket restore — the shape `estimate.ts`'s own comment flagged with "NO
    test covers that shape today". `verify:estimates` now bills a term settled entirely from
    the promotional bucket: the whole ₹10,000 credit returns to that bucket, is reported as a
    `bucket_restore` destination, and none of it becomes refundable — the rule
    `credit-routing.ts` exists to hold. Mutation-tested: mislabelling the adjustment as
    refundable and dropping the invoice number both fail.
  * ⚠ **Still uncovered: the `stranded` leg** — and the shape that reaches it is NOT the one
    first assumed. Working the open branch's own identity (`excess = overBase + (E + R + C)`,
    in `planOpenInvoiceCreditRouting`'s clamp comment) through the routing gives
    `stranded = max(cashPAID − cashRETAINED, 0)`: `fundedRest` counts cash still retained,
    while the identity's `C` is cash ever paid. A promo-funded invoice therefore strands
    NOTHING — `overBase = promo − unusedGap ≤ promo` always, so `freedPromo = overBase` and the
    residual cancels exactly. The reachable shape is a term whose cash is not fully retained:
    a **TDS-withheld** invoice (`withholdingMinor` — "total − withholding: what can actually be
    collected/credited against"), which is precisely what `credit-routing.ts`'s header names.
    Until a fixture exists, conservation is measured on four legs of five and prose rendering a
    stranded slice is unverified.
  * ⚠ The companion ladder check `invoiceTotal − creditApplied − balanceApplied == amountDue` is
    weaker than it looks: `amount_due_minor` is floored at 0, so wherever the credit outruns the
    invoice the floor absorbs an overstated credit and it passes anyway. Written down in the
    helper so nobody mistakes it for the guard.

- **2026-08-31 (locks)** — **A subscription change could mint refundable credit past the cash ever
  collected, racing a manual credit note. 1875 on 1500, measured.** `creditOneInvoice` is read-then-act
  on money — it reads the invoice's booked tax, its outstanding, its refundable and creditable capacity,
  decides a split against them, then writes notes and ledger entries — and `proration.ts` took **neither**
  `lockCustomerBalances` nor `lockInvoiceCredit`. Two transactions at READ COMMITTED cannot see each
  other's uncommitted `credit_notes` rows, so a CHANGE and a concurrent MANUAL note each read the full
  capacity and each passed its own cap. They shared no lock: the manual paths take `lockInvoiceCredit`
  inside `issueRefundableCreditNote`, and the change path reaches the uncapped
  `createRefundableCreditNote` primitive instead — which the 2026-08-31 open-invoice fix made true of
  BOTH branches, widening a hole ad8c149 had already opened on the paid one.
  `changeSubscription`'s optimistic lock does not close it: it serialises changes to the SUBSCRIPTION,
  not credits against the INVOICE.
  **The docblock lied, which is why this survived.** `lockInvoiceCredit`'s own lock-order paragraph
  asserted that *"`cancellation-credit.ts` and `proration.ts` take `lockCustomerBalances` and then call
  these functions"*. True of the former (it does, twice, at lines 753 and 802); `proration.ts` appears
  nowhere in a repo-wide grep for it. A docblock asserting an invariant is not the invariant — the
  paragraph now says so, and names itself as the example.
  **Fixed in the documented order, the one already running in production.** `lockCustomerBalances` then
  `lockInvoiceCredit` at the top of `creditOneInvoice`, inside the caller's transaction, covering both
  branches. Verified before adding rather than assumed: no path anywhere takes the invoice lock and then
  a customer lock (the CN issue functions take only the invoice one; `voidCreditNote`,
  `refundCreditNote` and the promotional-credit mutators take only the customer one), so there is no
  cycle. Advisory locks are re-entrant per transaction, so `cancellation-credit.ts` — which already
  holds the customer lock — is unaffected. The customer lock also removes the multi-invoice question:
  `creditAcrossInvoices` calls this once per invoice, and serialising the two changes outright means the
  SEQUENCE of invoice locks can never be interleaved. ⚠ It is an advisory *xact* lock, so it is worth
  nothing without the caller's transaction; all four call sites pass one (the apply phase opens it at
  `withTenant`), which the atomicity contract already required.
  Gate: `verify:concurrent-credit-note` § 5 — a change and a full-amount manual note fired at one paid
  invoice, asserting the BUCKET and never the row count, and accepting either serialised outcome
  (change first → the manual cap refuses the rest; manual first → the change's funding split clamps to
  0). **Mutation-tested: remove the locks and it reports `minted 1875 of 1500 collected`** — 375 of
  invented cash-refundable credit, the change's prorated slice of one seat. With them, 1500.
  Gates: typecheck clean, lint 0 errors, unit 759/762 (the 3 are `shadow-compare`, pre-existing and
  diagnosed separately). The whole concurrency family for deadlocks —
  `concurrent-credit-note|concurrent-credit-apply|concurrent-refund|concurrent-collect|
  concurrent-dispute|idempotency-race` — plus `proration|proration-matrix|credit|credit-notes|
  subscriptions-v2|invoices-v2|estimates|checkout|change-atomicity|update-for-items|wallet|refund|
  lifecycle|renewal|dunning`, all pass with no assertion moved.

- **2026-08-31 (4a)** — **The credit-routing arithmetic is now a pure module, and `estimate.ts` calls
  the same function this file books from.** `credit-routing.ts` holds the two decisions that used to
  be interleaved with the database reads that feed them: DISTRIBUTION (`distributeCreditAcrossInvoices`
  — pro-rata by base with largest-remainder, clamped to each invoice's capacity, re-placed across
  headroom, residual dropped) and per-invoice ROUTING (`planOpenInvoiceCreditRouting` →
  `{adjustment, freedPromo, freedExcess, cashable, stranded}`). Zero imports: no DB, no schema, no
  sibling module. `creditAcrossInvoices` and `creditOneInvoice` call it; the estimate calls it to
  predict what they will do.
  **Why, in two measurements.** (1) `estimateChange` could not ask these questions, so it re-derived
  them and disagreed with the booking — the checkout promising "₹17,010.12 credited to your balance"
  on a change that delivers ₹0, because the apply spends the credit on the term's outstanding debt
  first. Modelling it a second time only moves the disagreement; the sibling session's own stopgap
  clamp is marked TEMPORARY pending this. (2) The arithmetic was not unit-testable: the `freedExcess`
  overshoot (2400265 restored against 2000000 ever drawn) is PURE arithmetic that nonetheless took
  three attempts at a full DB fixture — a term invoice, an excess payment, a declining card, a
  goodwill note, a downgrade — because it was only reachable through `changeSubscription`.
  **The extraction immediately earned itself.** A conservation grid over 1000+ input combinations
  found that `freedPromo` could exceed the overflow it is taken from, reporting more placed than it
  was given. Unreachable through a real invoice — substituting the identity gives
  `excess = overBase + (E + R + C)`, so `overBase <= excess` while E, R, C are non-negative — but
  that is *precisely* an incidental upstream identity, the thing that cost 400265 the first time.
  `freedPromo` is now clamped to `excess` as well: a no-op on every real shape, and what makes
  conservation unconditional. Same lesson, one level up.
  Gates: `test/unit/credit-routing.test.ts` 21 assertions in 675ms with no database, mutation-tested
  in both halves — restore the unclamped split and the E3 case plus the grid fail; remove the
  distributor's re-placement pass and its own case fails. Behaviour-neutral by measurement:
  `verify:proration|proration-matrix|credit|credit-notes|subscriptions-v2|invoices-v2|estimates|
  checkout|change-atomicity|update-for-items|wallet|refund|lifecycle` all pass with no assertion
  moved, § E1–E4 byte-identical, and the sibling session's `estimates` 226/0 and `checkout` 338/0
  unaffected. Typecheck clean, lint 0 errors.

- **2026-08-31 (latest)** — **A change against an OPEN invoice funded from the customer's own
  REFUNDABLE balance was refused with a 500.** The open branch of `creditOneInvoice` splits the
  prorated credit into an adjustment for what is still owed plus an overflow, and the 2026-08-25
  entry below says of that overflow "with no payment on the invoice that remainder is zero". That
  holds only if PROMOTIONAL credit is the sole non-cash funding an open invoice can carry — and it
  is not. `refundable_credits_applied_minor` and `excess_payments_applied_minor` settle an open
  invoice POST-tax, so an invoice part-covered from the customer's refundable balance whose card leg
  then FAILED has `excess > 0`, `promoApplied = 0` and `paidMinor = 0` at once. The whole remainder
  went to `issueRefundableCreditNote`, whose `paidMinor <= 0` guard fires **before** its cap, and the
  `CreditNoteError` took the entire subscription change down as a `ProrationError`.
  Measured on the dashboard 2026-08-31, checkout `/complete` → **500**: INV-4705, total 9161992,
  refundable credit applied 6952179, one FAILED payment, 2209813 still due; a day-2 term-reset change
  credited 8866444 of unused time, so **6656631** overflowed past the debt onto a guard that wanted
  cash. This is **ad8c149's defect one branch along** — that commit fixed the PAID branch and the
  2026-08-25 entry fixed the open branch's PROMO slice; nobody fixed the open branch's
  refundable/excess slices — and it gets ad8c149's answer: return each funding slice to the bucket it
  came from, never refuse for want of cash. The excess-payments share now goes back through the same
  `restoreBucketFundedSlices` call the promo slice already uses (and is declared on the adjustment
  note as an `excess_payments` discount row beside the promotional one, keeping the identity
  `total = sub_total − discounts + tax`); recycled refundable credit plus real cash is ONE cashable
  note through `createRefundableCreditNote`, exactly as `split.refundable` is on the paid branch.
  Split pro-rata between the two: past the debt there is no rule saying which of them funded the
  units being handed back — the promo slice is the one exception and was already taken above at its
  own non-pro-rata rate (`discountedTotal − taxedBase`). Bypassing the guard is safe for the reason
  the paid branch already gives: the cap is the clamp to `refundableApplied + cashAvailable` (the
  cancellation cap, read from the same `refundableCapacityForInvoice`, so a slice already refunded or
  credited away cannot be handed back twice), and the status check is `issueCurrentTermCredit`'s
  `live` filter. A residual past the clamp is credited to nobody, the way the paid branch strands a
  TDS-withheld residual — it is money this invoice never received.
  **The first cut of this shipped a money bug, caught in peer review.** It divided the overflow by
  `excessApplied + refundableApplied + cashAvailable` and clamped only the CASHABLE leg, on the
  assumption that `overflowRest <= fundedRest` always holds. It does not, and the excess leg was then
  `> excessApplied` — money `restoreBucketFundedSlices` posts to the LEDGER, so invented money in the
  excess bucket, not a documentary discount row. Constructed and measured: a 2791800 term with
  2000000 from an excess payment, card declined, a 500000 goodwill adjustment against the still-open
  invoice, then a downgrade to a near-zero plan restored **2400265** against 2000000 ever drawn —
  400265 out of nothing. Reachable with **no promotional credit at all**: a prior note on the invoice
  subtracts from `refundableCapacityForInvoice` AND from what is outstanding, so it widens
  `overflowRest` and narrows `fundedRest` at once.
  The identity the assumption leaned on is real but INCIDENTAL — with no prior notes and no refunds
  `due = taxedGross − E − R − C` makes `overflowRest` collapse to exactly `E + R + C`, for the promo
  regime too, because `freedPromo = discountedTotal − taxedBase` is chosen to leave precisely that.
  Tight, zero headroom, and stated nowhere the split can see. So the overflow is now clamped to
  `fundedRest` **before** it is split, and both legs are within their own source by construction.
  The shared `splitCreditByFunding` gets that property from dividing by the invoice total, which is
  the wrong denominator here — it would attribute part of the overflow to the `due` slice, which
  nothing funded, and strand it.
  **The split is the documented one, and it applies to a partially paid invoice** (checked after the
  fix). Worked example, "Plan quantity downgrade (partially paid invoice)" — $90 term, $80 received,
  $10 due, quantity reduced mid-term — states the split this branch computes, from the other
  direction: *a refundable credit note for $80 − $75 = $5* plus *an adjustment credit note for the
  original unpaid amount of $10*. So the OUTSTANDING amount goes on an adjustment note and
  everything past it on a refundable one, **against a partially paid invoice** — which is precisely
  what the `paidMinor <= 0` guard was refusing. Our adjustment leg reproduces that $10.00 exactly;
  gated as § E4 below. The same rule fixes the branch structure itself: while the current term's
  invoice is in a Payment Due or Not Paid state the credits generated are ADJUSTMENT; once it is
  Paid they are REFUNDABLE. Manual creation says it a third time — on a partially paid invoice you
  can either adjust the due amount for the unpaid amount or provide credits against the paid amount
  — so both note types against ONE partially paid invoice is the intended shape, not an edge case we
  invented.
  Regression evidence, in two places. The gate is **`verify:proration` § E** (E1 refundable-funded,
  E2 excess-funded, E3 the overshoot, E4 the documented split), hand-computed against a
  31-day term: PRO 3100 → 1600 credited, LITE 620 → 320 charged, 1100 owed. Mutation-tested both ways — restore the cash-gated entry point
  and E1 fails (`the change applies at all: false`); restore the unclamped split and E3 fails
  (`restored=2400265 applied=2000000`). `scripts/probe-change-open-credit-funded.ts` is the narrative
  version (a ₹27,918 term, ₹20,000 from the refundable balance, card declined, downgraded on day 16 →
  adjustment ₹7,918.00 + refundable ₹6,491.29), plus an excess-funded twin.
  ⚠ **Also not fixed, and pre-existing**: `issueRefundableCreditNote`'s FOURTH job,
  `lockInvoiceCredit` ("five concurrent full-amount notes minted 7500 of cash-refundable credit on
  1500 of collected cash without it"). `proration.ts` takes no invoice-credit lock at all, so the
  paid branch already bypassed it and this is the second such call site — and the cap is read from
  `refundableCapacityForInvoice` outside any lock, a TOCTOU window against a concurrent manual credit
  note on the same invoice. `changeSubscription`'s optimistic lock does not close it: it serialises
  changes to the SUBSCRIPTION, not credits against the INVOICE. Filed in `docs/PROGRESS.md` rather
  than fixed here — adding a lock to one of two sibling call sites is worse than neither.
  ⚠ **Known and NOT fixed here**: the checkout/`estimateChange` preview still quotes the WHOLE credit
  as balance credit (the screen promised "₹17,010.12 credited to your balance"), where the apply
  spends 2209813 of it relieving the open invoice's debt. That is the `fallbackCreditLines`
  limitation the 2026-08-24 estimate entry already names — the split is not determinable without
  replaying the apply phase's creditability check.
  Gates: typecheck clean; lint 0 errors; `verify:proration|proration-matrix|credit|credit-notes|
  subscriptions-v2|invoices-v2|estimates|refund|offline-refund|tax|change-atomicity|update-for-items|
  wallet|events|audit|checkout` all pass, no assertion moved.
  Unit tests: 733–734 of 737, with 3–4 FLAKY pre-existing failures that vary run to run —
  `shadow-compare` (3), `currency-exponent` and `provider-customer-sync`. Measured on a CLEAN tree
  (stash, two runs: 4 failed both times, same files), so none of them is ours. Worth its own item:
  a suite whose failure set changes between runs is not a baseline. ⚠ The first draft of this entry
  said "the 3 failures are shadow-compare" — that was one sample of a flaky set, taken while the disk
  was also filling to 100% and failing test writes. Re-measure before quoting it.
- **2026-08-31 (latest)** — **Custom fields are filterable on the list, as `cf_<api_name>`.** Same
  gap as on customers: the subscriptions list could not filter on them.
  `subscriptionCustomFieldFilterSet(defs)` builds specs/ops/kinds off the `custom_fields` jsonb
  column (mode-independent, unlike `listFilters` — a jsonb value has no term-boundary convention),
  and `GET /v1/businesses/:biz/subscriptions` merges its `ops`/`kinds` OVER
  `SUBSCRIPTION_FILTER_OPS` / `SUBSCRIPTION_FILTER_KINDS` per request; the exported maps keep their
  contents because `modules/list-views/entities.ts` reads them. **One definitions read per request**
  — the route needs the ops before `parseListQuery` will accept `cf_region[starts_with]=ap`, the
  service needs the specs while building the query, so the rows travel down as
  `SubscriptionListFilters.customFieldDefs` rather than being read again. The specs join the real
  columns in the SAME `filterConditions` call with the same `mode.timezone`, and land in the same
  `conds` array the first-page `count(*)` reuses, so the total narrows with the page.

- **2026-08-31** — **The subscriptions list filters on 38 fields, and every one of them
  compares the value the response PRINTS.** `LIST_FILTERS` offered 12 columns of a possible
  ~30, so the questions an operator actually asks — who renews next week, who cancelled and why,
  who is on Net-30, who has a coupon, whose card is the customer's rather than their own — had no
  answer short of an export. Widened to every genuinely-backed column on `subscriptions` plus the
  two already joined off `customers`, and the `*_OPS` tables came free: `list-query.ts` derives them
  from the column map, so each field picked up `in`/`not_in`/`between`/`in_last`/`in_next`/
  `is_present` in the same commit.
  - **Three filters were lying, and the fix is the same in each: filter the SERIALIZER's expression,
    not the raw column.**
    - `status` compared `subscriptions.status`, which never holds `non_renewing` — that value is
      derived at the API boundary (`apiSubscriptionStatus`). So `status[is]=non_renewing` matched
      **nothing at all** while the list rendered "Non-renewing" pills on those very rows, and
      `status[is]=active` returned them under a label the response contradicts. Now filtered (and
      sorted) through `apiStatusSql`, the SQL twin of that function. ⚠ `status[is]=active` therefore
      **excludes non-renewing rows** from now on, which is what the pill beside them says.
    - `current_period_*` ignored the two conventions the serializer applies: a trialling
      subscription reports **no term at all** (both fields null), and a day-anchored
      business reports a term end **inclusively** (`…T23:59:59`) where we store the exclusive next
      midnight. Date filters bucket by the business day, so the second one is a whole day wide: a
      term stored 04-Aug 00:00 IST prints "03-Aug 23:59:59" and `current_period_end[on]=<the date
      the row itself shows>` came back **empty**. Same shape as the timezone bug `business-tz.ts`
      documents, one convention further out.
    - `canceled_at` had no filter at all, and the obvious one (the bare column) would have missed
      every cancellation that has not happened yet — most of the book an operator asks about. It is
      a three-way coalesce at the API edge (actual cancel → pending `specific_date` cancel → the
      term end a `non_renewing` subscription will cancel on) and is filtered as one.
  - **New: `next_billing_at`** — the one date that answers "who renews in the next 7 days?" across
    every status, and the only one that is right for a trialling subscription. `nextBillingAtSql`
    mirrors `nextBillingAt`, NULL included: `non_renewing`/`paused`/`cancelled` have no next
    billing, and a filter that answered one would return rows the response says have none.
  - New plain columns: `start_date`, `started_at`, `activated_at`, `trial_start`, `cancel_reason`,
    `cancel_reason_code`, `billing_period`, `billing_period_unit`, `remaining_billing_cycles`,
    `auto_collection`, `create_pending_invoices`, `net_term_days`, `po_number`, `invoice_notes`,
    `updated_at`, `customer_company`, `customer_phone`.
  - New subquery-backed fields, each over an **indexed** FK: `default_payment_method` (the public id
    the API prints, not the uuid column — comparing `pm_…` against a uuid matches nothing),
    `coupon` (the ACTIVE discount's code; a manual discount carries none, so
    `coupon[is_present]=true` means "discounted by a coupon"), `has_scheduled_changes`,
    `plan_quantity` (scoped to `kind = 'plan'`, so an add-on's quantity can't answer for it), and
    the virtual `addon` — `planCondition` generalized to `itemProductCondition(op, value, kind?)`,
    which also gains `is_present` ("has any add-on at all"). `plan` keeps its exact old behaviour.
  - The route now passes `SUBSCRIPTION_FILTER_KINDS` (`kindsFromSpecs`), so a malformed VALUE —
    `mrr[between]=1000`, `created_at[on]=31/08/2026` — answers **400 naming the shape** instead of
    reaching the Postgres cast as a 500.
  - Sorts: `updated_at`, `next_billing_at`, `activated_at`, `started_at`, `trial_end`. All plain
    per-row values; nothing reaches through the customers join or into a subquery.
  - `listSubscriptionsPage` reads the business's `billingModeFor` where it read
    `businessTimezone` — the same single primary-key lookup, but the term-end convention comes with
    it, which is what the boundary filters compare against.
  - **Not added, for want of a backing column:** business entity / channel (no column anywhere on
    `subscriptions`), `total_dues_minor` / `due_invoices_count` / `due_since` (computed by
    `subscriptionDues` over invoices, and not serialized on the list at all), `billing_anchor_day`
    (a real column, but the API never serializes it, so a filter on it could not agree with any
    field), and offline/payment-method-type filters (the type lives on `payment_methods`, which the
    list does not join).
- **2026-08-31 (later still)** — **A SCHEDULED change carries the whole composition edit.**
  `POST …/schedule` stored `payload.changes` only, so the change screen refused to defer any edit
  that added or removed a line ("Scheduled changes can only modify existing lines — remove
  added/removed lines or apply immediately"). Nothing below the
  API required the limit: `changeSubscription` has taken `changes` + `adds` + `removes` in ONE
  transaction since 2026-08-24, `estimateChange` already previewed all three, and
  `scheduled_changes.payload` is `jsonb` — so widening it needed **no migration**, only the fields
  and the pass-through.
  - `scheduleChange` takes `adds`/`removes`, persists them under the new `ScheduledItemWork` shape,
    and the applier replays all three into one `changeSubscription` call. Rows scheduled before this
    have neither key and read as the changes-only edit they were.
  - The `type: 'change'` guard is now "at least one item change, **add or remove**" — an adds-only or
    removes-only schedule is a legal edit.
  - **New: a schedule-time preflight** (`preflightItemWork`). A scheduled row is applied by the clock
    with nobody watching, so an apply-time refusal surfaces only as `last_error` on a change that
    never happened. Unknown item id, unknown price, wrong currency, and the same item in both
    `changes` and `removes` are refused while the operator is still on the screen, and **no row is
    written**. Deliberately NOT checked: the added price's cadence — it is validated against the
    POST-change cycle, which depends on the `changes` in the same edit, so re-deriving it here would
    refuse the very edit this work supports. Cadence stays an apply-time refusal.
  - Verified: `pnpm verify:scheduled-changes`, 53 checks (was 25) (§ 9-12 are new — the composition edit lands
    as **one invoice with three lines**, the removal folded in as a negative line rather than a
    separate credit note; adds-only and removes-only schedules; the six preflight refusals; and the
    first-ever HTTP coverage of `POST …/schedule`, which pins the hand-written
    `price`→`priceId` / `unit_price_minor`→`customAmountMinor` mapping). Both halves mutation-tested:
    dropping `adds`/`removes` at apply time fails 7 checks, dropping the custom-price mapping fails 1.

- **2026-08-31 (later)** — **The last two UTC-calendar month sites: a month-unit TRIAL, and the
  proration DENOMINATOR.** `97fe44d8` moved five term-boundary sites from `addInterval` (which clamps
  on the UTC calendar) to `advancePeriod` (the business one) and deliberately left these two for a
  separate decision. Both were measured broken on an `Asia/Kolkata`, day-anchored business and both
  are fixed the same way.
  - **`createSubscription`, trial end.** A plan's `trial_period` with `trial_period_unit = 'month'`
    is month arithmetic. A 1-month trial starting 31 Jan IST ended `2026-02-28T23:59:59` local — an
    exclusive boundary of **1 March** — because `addInterval` clamped `min(30, 28)` off the UTC start
    day (30 Jan). Correct is 28 Feb, which the row's own `billingAnchorDay = 31` already implied.
    31 Aug behaved the same (1 Oct, should be 30 Sep). `inclusiveBoundary` runs immediately after and
    does **not** rescue this — it backs off one second, never a day. The anchor passed is the trial's
    own start day-of-month read in the business zone, **not** `billingAnchorDay`: that is resolved
    further down and may be an explicit calendar anchor or the customer's `billing_date`, neither of
    which has anything to do with trial length. `trial_days`, and day/week trial units, are plain day
    arithmetic and unaffected.
  - **`prorateTermChange`, the daily-rate denominator.** The fallback used when the term carries no
    invoice (`billedLenMs` null — e.g. a future-dated subscription) measured the nominal interval with
    `addInterval`. Here the wrong calendar moves **money**, not a date: a term running 31 Oct → 30 Nov
    IST is 30 days, but measured from its UTC start it clamped to 30 Nov and read 31, so a one-day
    extension of a 30000/mo plan billed **967 instead of 1000** — a 30-day term's day charged at a
    31-day term's rate. The fallback now uses `advancePeriod` with `sub.billingAnchorDay` and the
    business mode, i.e. the same calendar and anchor that produced the stored boundary it stands in
    for, so the two can no longer disagree. `billingModeFor` is read inside the transaction that was
    already open, so this costs no extra round trip. Unchanged when the term WAS billed.
  - `addInterval` is no longer imported by `proration.ts` at all, with a comment at the import saying
    why — every date this module derives lives on the business calendar.
  - Covered by two new `verify-proration` blocks (4 trial cases, 3 denominator cases), each with
    controls that must NOT move (a mid-month day, a 30-day `trial_days`, two genuinely-31-day terms).
    Mutation-tested against the pre-fix code: 3 of the 7 fail, the 4 controls hold. Green:
    `verify:proration`, `verify:proration-matrix`, `verify:estimates`, `verify-checkout`,
    `verify:customers`, `verify-trial-end`, `verify-time-travel`, `tsc --noEmit`, `pnpm lint`.
- **2026-08-31 (later)** — **`creditAcrossInvoices` stopped dropping the source invoice line's id.**
  It spells each credit note out from the credited invoice's own lines, but built its
  `InvoiceCreditPart.lines` as `{description, amountMinor}` — so the `il_…` never reached
  `CreditNoteItemInput.invoiceLineItemPublicId`, and every credit-note item landed with
  `period_start` / `period_end` / `invoice_line_item_id` NULL. The receiving plumbing had worked since
  2026-08-01; only the hand-off was missing. `rescaleCreditItems` needed nothing but a generic
  signature — it already spread (`{...i, amountMinor}`), so the field survives the money scaling
  untouched. Full account, including what stays NULL on purpose, in `credit-notes/README.md`.

- **2026-08-31** — **A credit note stopped saying "Unused time on BUSINESS plan - Prorated Charges".**
  A term-reset credit note is spelled out from the source invoice's OWN line descriptions
  (`issueCurrentTermCredit` → `creditAcrossInvoices`), so the re-wording helper has to cope with every
  phrasing a charge line can carry. There are two — ours, `"Remaining time on BUSINESS plan ×1"`, and
  the imported form, `"BUSINESS plan - Prorated Charges"`, which the importer preserves verbatim and
  which our own same-cadence proration also emits — and only the PREFIX form was handled. Blind prefixing
  had already produced "Unused time on Remaining time on X" once and been fixed; the suffix form then
  survived the same rewrite and shipped. Measured on CN-1324 (2026-08-30), whose three lines all read
  that way: a credit for the unused portion of some *charges*, which is not a thing.
  - `credited` was a closure inside `creditAcrossInvoices`; it is now the exported
    `creditedDescription`, which strips **both** affixes, anchored (`^` / `$`) so a plan whose name
    contains either phrase survives. Both are stripped independently rather than either/or: nothing
    emits both today, but a line that ever did would otherwise keep one.
  - Pinned by `test/unit/credited-description.test.ts` (6 cases), for the same reason the
    forced-reset label guard went into `verify-proration-matrix`: no end-to-end suite asserts
    proration-line WORDING, so none of them can see a wording regression at all. Mutation-tested — 2
    of the 6 fail against the prefix-only version.
  - Our proration wording deliberately names the quantity and says which side of the proration a
    line is; this is about that wording being coherent.

- **2026-08-30 (later)** — **A forced same-cadence term reset stopped calling its full-term charge
  "Prorated Charges".** The label was gated on `frequencyChanged`, but `resetTerm` is
  `input.resetTerm === true || frequencyChanged` — and both label sites live inside the `else` of
  `if (!resetTerm)`, so `frequencyChanged` was simply the wrong variable: only ONE of the two ways in
  got the plain label. A forced reset with no cadence change — **what the hosted checkout sends** —
  charged a whole new term at full list price and labelled it as a prorated slice.

  **Measured before changing anything**, because the existing comment cited two cases that do not
  cover this one (cadence change → plain; same cadence, NO reset → suffix kept). Since the suffix is
  kept on same-cadence prorations, it was entirely possible it belonged here too, in which
  case our output was already correct and "fixing" it would have INTRODUCED the defect. Measured 15
  days into a 31-day term, `lite-monthly-7 → basic-monthly-24`:

  | case | term after | invoice | line description |
  | ---- | ---------- | ------- | ---------------- |
  | `force_term_reset=true` | **RESTARTS** 08-29 → 09-29 | 2400 (full) | `BASIC … Monthly Plan` |
  | control, no reset | unchanged 08-14 → 09-14 | 1239 (prorated) | `BASIC … Monthly Plan - Prorated Charges` |

  The amounts reproduce the 2026-08-22 matrix (1239 / 2400) exactly, which is what says the
  measurement hit the intended two cells. So the earlier cadence-change case was **right for the wrong
  reason**: it is the RESET that drops the suffix, not the frequency change.

  **Why the term had to be backdated.** The 2026-08-22 entry below already records that every
  plan-swap journey swaps in the same instant the subscription is created, "where a reset-to-now is
  indistinguishable from no reset, and the money matches too". At zero elapsed the two cases share
  both the amount AND the period, and the label question cannot be answered. The measurement
  therefore IMPORTS its subscriptions (`import_for_items`) with a term that began 15 days ago.

  **A guard now exists**, in `verify-proration-matrix`'s forced-reset case: no end-to-end suite
  asserts proration-line WORDING, so none of them could see a label regression — that blind spot is
  how this drifted in the first place. Mutation-tested: the new assertion reports
  `"Plans - Prorated Charges"` against the old code and `"Plans"` against the new.

- **2026-08-30** — **`estimateChange` quoted a CHARGE for a downgrade.** A change raises two
  documents; `total_minor` was `net + invoiceTax`, mixing a subtotal net of the credit with a tax
  gross of it, so the credit note's own tax was in neither term and every credited change
  over-quoted by exactly that amount. Measured: add-on qty 60 → 59 at ₹752 under 18% GST previewed
  `+7234.24` against a booked credit of `887.36`. `total_minor` is now
  `(invoice total) − (credit note total)`, which also happens to be exactly right for
  `fallbackCreditLines` (for a flat rate `r·chargeBase − r·creditBase = r·net`), so the special
  case the old note apologised for is gone. `immediate_charge` follows `total > 0`, not `net > 0`.
  `tax_minor`/`tax_lines` are unchanged — they describe the INVOICE — and two fields were added:
  `refundable_credit_added_minor` (what the note exceeds the invoice by, i.e. what goes back on the
  balance) and `next_renewal` (the post-change renewal invoice, tax and coupons in, net of that
  credit). `next_renewal` is rated by `rateFullTermComposition`, extracted verbatim from the
  in-trial branch, which already computed exactly this and had no second caller. ⚠️ A
  `verify-estimates` assertion was actively defending the old value; see PROGRESS.md for why its
  stated reason did not hold.

- **2026-08-29 (later)** — **the sibling passes join the repeat suppression.** Once
  `startFutureSubscriptions`, `healUnbilledFirstPeriods`, `runDunningPass`,
  `sweepStrandedRetries` and `sweepExpiredParkedDunning` each gained an `errors.push` into
  `clock_ticks.errors` (entry above), the precondition `verify:logging` enforces was satisfied
  and all five moved from `log.error` to `log.recurringError`. An item stuck in a broken state
  now logs once an hour carrying `repeatsSuppressed`, instead of 1,440 identical stacks a day,
  while `clock_ticks.errors` keeps the per-item record on every single tick regardless. This
  supersedes the "sibling passes deliberately still use `log.error`" note in the entry above.

- **2026-08-29** — **A plan change's invoice now orders its lines the way the renewal invoice does**
  — plan first, then charges by amount ascending, through the shared `orderDocumentLines`
  (invoicing/service.ts, where the rule is argued). `rows.sort` in the read phase
  put the plan first and tie-broke on `price.publicId`: stable across runs, but ALPHABETICAL where
  the rule is amount-ascending. A term-reset invoice built here ordered `[plan, connections, gds]`
  where the amounts want `[plan, gds 5527200, connections 9024000]`. An item sort cannot know
  amounts, so the ordering moved to the apply phase, onto `billableLines`, just before
  `createInvoiceFromLines`; `rows.sort` keeps the one job it can do (a deterministic build walk, and
  the stable order equal-amount lines fall back to). ESTIMATES were deliberately NOT changed: their
  preview lines are index-aligned with `chargeableItems` for `each_specified_item` coupon
  attribution, and they carry internal labels (`recurring (platform-pro-…) ×1`) rather than the
  invoice's, so they are not trying to be the document.
- **2026-08-28** — **`parked` meant "forever", and now it has a deadline.** `planFailureRearm` returns
  `parked` for a refusal that is not a payment-method decline: `next_attempt_at = null`,
  `dunning_status = 'parked'`, invoice open, subscription retained. But `runDunningPass` scans
  `WHERE next_attempt_at IS NOT NULL`, so from that moment **nothing in the clock ever looked at the
  row again** — the dunning period never ended, `applyDunningFinalAction` never fired, and a live
  subscription sat on an invoice nobody was collecting, indefinitely. Parking was not
  dunning-without-retries; it was dunning switched off. New `sweepExpiredParkedDunning` (a tick pass,
  after `runDunningPass`) closes that window using the SAME terminal shape (`not_paid` +
  `dunning_status = 'exhausted'`) and the SAME final action a retry-exhausted invoice reaches, so the
  two are indistinguishable downstream. It never retries and never charges — re-presenting an AFA
  debit just opens another 72-hour authentication window.
  Scoped by `PARKED_WITH_DEADLINE`, an explicit allow-list of the parks the CUSTOMER can clear —
  `afa_not_completed` today. `recurring_not_enabled` and `gateway_limit_exceeded` stay parked forever
  on purpose: they are merchant-side, and cancelling someone's subscription over our own gateway
  configuration would punish them for our bug. `mandate_ceiling_exceeded` is left out because giving
  it a cancellation deadline is a product decision nobody has made.
  The deadline itself is `parkedDunningDeadline`, and it is never null: `dunningPeriodDays` is null by
  default, so honouring that as "no deadline" would have made the whole sweep a no-op on most
  businesses (caught by `verify:stale-pending` case E, not by reading). It falls back to the retry
  schedule's last offset — **when dunning would have finished anyway** — so no business gets a
  deadline it had not already implied. "Never cancel" remains expressible, as
  `finalAction.subscription = 'retain'`: a decision about what closing DOES, not about whether the
  window closes.
- **2026-08-25** — **A same-cadence UPGRADE now credits the old term with a credit note and bills
  the new term at FULL price**, instead of netting both onto one invoice with a negative line
  (Root 2 of the full-suite run, 34 failures). The correct shape is
  `lines=1 · total=59700 · creditsApplied=29700 · creditNotes=1`; we reported
  `lines=2 · lines[0]=-29700 · total=30000 · creditsApplied=0`.
  - **It was not presentation — netting LOST A DISCOUNT.** Once credit and charge are one lump the
    percentage has nothing to land on: `59700 − 29700 = 30000` where the correct charge is
    `(59700 × 0.9) − 26730 = 27000`. Measured overcharges of +3000, +5970 and +96000 across three
    fixtures.
    `scripts/probe-upgrade-credit-note-shape.ts` reproduces both shapes and gates them.
  - **Same mechanism as the `net < 0` downgrade branch**: issue the credit inside the apply
    transaction so `createInvoiceFromLines(applyCredit)` draws it onto the new full-price invoice,
    and the coupon lands on the charge before the credit does.
  - **⚠ PRICE SWAPS ONLY, and that limit is measured, not assumed.** Moving a per-unit add-on
    ×1 → ×4 raises ONE invoice for `150.00 qty=3 "… - Prorated Charges"` — no credit note, no negative line, no
    credits_applied. A quantity change bills the ADDED UNITS; our netting already lands on the
    same total. Generalising would have broken that and would have "fixed"
    `verify-change-atomicity`'s 19500-delta fixture, which is correct as written. The first attempt
    DID generalise and turned that gate red — the fixture was the warning, not the bug.
  - Separable from the lines alone: a swap credits price X and charges price Y; a quantity change
    credits and charges the SAME price. Only a negative line whose price is not among the charges
    becomes a note, so a mixed edit keeps each half in its own shape.
  - Falls back to the old netting byte-for-byte when no creditable invoice exists
    (`issueCurrentTermCredit` returns none) or when the change is not invoiced immediately.
  - **Not fixed here:** the monthly → yearly case is a TERM RESET and takes the `resetCreditItems`
    path; it still reports 15 failures and needs its own measurement.
- **2026-08-25** — **Four cancellation money failures were reported only in the response body; they
  are logged now.** `cancelSubscriptionWithOptions` and `applyCancelMoneyHandling` deliberately do not
  throw when a side-effect of an immediate cancel fails — the subscription is already cancelled, so a
  throw would 500 a cancellation that happened, and the caller's retry is then refused by the `already
cancelled` guard. The failure instead goes onto `warnings[]` and comes back with a 200. That part is
  right; what was missing is that a response body is **not a record**. The dashboard renders the
  warning once in a toast and keeps nothing, and neither `invoicing/ops.ts` (no logging anywhere in
  the file) nor `cancellation-credit.ts` logged one frame up, so a cancellation credit that was never
  issued or a refundable credit note that never paid out left **no server-side trace at all**.
  Now: `cancel_credit_not_issued`, `cancel_writeoff_failed` and `cancel_refund_failed` at ERROR
  (money the customer is owed, or AR the operator asked to clear, in the wrong state), and
  `cancel_collect_failed` at WARN — a refused collection is the expected outcome there and dunning
  still owns the invoice, so it is a record, not an alert. Each line carries the subscription, the
  business and the invoice/credit-note id, on top of the `service`/`traceId` every module logger adds.
  These four never looked like a bare `catch {}`, which is why the 2026-08-19 logging sweep did not
  reach them — the error _was_ handled, just into a variable nobody persisted. `verify:logging` now
  enforces the general rule over source: **a `catch` that reports a failure by pushing onto a
  warnings/errors array must also log** (8 such sites today, all logged; negative-tested by stripping
  one log and confirming the gate names the exact file:line and exits 1).
- **2026-08-25** — **Every estimate now reports the promotional slice the way the INVOICE does: a
  pre-tax discount, not a post-tax credit** (closes the gap `30fcbd6` left open — that commit moved
  the invoice document and was fenced out of this file, so preview and invoice disagreed about the
  same money for an hour). `estimateChange`, `estimateRenewal`, `estimateNewSubscription` and
  `estimateCancel`'s unbilled-charges preview all changed together, because they are four previews of
  the same `resolvePeriodInvoiceMoney` balance split (D1).
  - **What moved.** `total_minor` is now NET of the promotional slice (the invoice's own `total`);
    `credits_applied_minor` is refundable + excess ONLY; `discount_minor` carries the slice (the role
    `document_level_discount_minor` plays on the invoice), and the new `promotional_discount_minor`
    names it — mirroring `serializeInvoice` field for field. `promotional_credits_applied_minor` stays
    as the BALANCE-side view of the same money, the way the `invoices` column does beside the
    document. So `subtotal − discount + tax = total` now holds on an estimate as it does on an invoice.
  - **And the tax base moved with it**, which is the money half. `simulateCreditApplication` computed
    tax first and subtracted the promo afterwards; the invoice subtracts it FIRST and taxes the
    remainder. Split into `simulatePromotionalDiscount` (pre-tax, capped exactly as
    `resolvePeriodInvoiceMoney`'s `promoCap`) + `planCreditApplication` (post-tax) so the order is the
    engine's. Measured on an IGST-18% mid-term add of ₹27,918 against a ₹10,000 grant
    (`scripts/probe-estimate-vs-invoice-promo.ts`): the preview quoted `tax 502524 · total 3294324 ·
credits_applied 1000000 · amount_due 2294324` where the invoice raised `tax 322524 · total
2114324 · credits_applied 0 · amount_due 2114324`. All seven fields now agree, in both the
    promo-only round and a round carrying a promo slice AND a post-tax excess bucket on one document
    (`911800 − 400000 → tax 92124 · total 603924 · credits_applied 500000 · due 103924`).
  - **The promo CAP is unchanged** (`net`, floored at 0) and deliberately so: a change whose
    unused-time credits outweigh its charges collects nothing now, and the promo the apply then draws
    for the new-term invoice comes out of the credit note that same change issues — money the customer
    does not hold at preview time. `7302b70`'s "tax the charges, not the net" is intact; this narrows
    that base by the promo, it does not re-net it.
  - **Dashboard**: the change dialog, the change/create breakdown tables and the cancel dialog all
    grew a "Promotional credits" row ABOVE tax; "Account credits applied" moved BELOW tax, which is
    where the post-tax buckets are actually applied. Without them the tables jumped from a subtotal to
    an amount due that was smaller by an amount nothing on screen named.
- **2026-08-25** — **An adjustment credit past the taxed base frees promotional credit; the
  cancellation credit prorates the same basis the change credit does** (D-cn-cap; the ledger/document
  half and the full arithmetic are in `src/modules/credit-notes/README.md`, which carries the numbers).
  The two gaps b4dc962 recorded, closed together because they are one cause. b4dc962 established that an
  adjustment comes off the TAXED slice because the promo goes on funding the RETAINED supply — true only
  while the credit fits inside the taxed base.
  - `creditOneInvoice`'s OPEN branch: when the note exceeds the amount due, the overflow is now split.
    `discountedTotal − taxedBase` is supply the PROMOTIONAL credit paid for and goes back to that bucket
    through `restoreBucketFundedSlices` (the paid branch's own mechanism), declared on the note as a
    `promotional_credits` discount row; the remainder is the CASH paid into the invoice and still becomes
    a refundable CN, as before. Before this, the whole overflow went to `issueRefundableCreditNote`,
    which refuses an invoice with no succeeded payment — measured on
    `scripts/probe-adjust-over-taxed-base.ts`, a day-2 downgrade of the ₹27,918 promo-funded term was
    **refused outright**; it now applies, due 0, `tax_payable` 0, 909942 freed.
  - `planCancellationCredit`'s ADJUSTMENT branch: an open, promo-funded invoice prorates `netBase` (the
    supply) and grosses up at the statutory `bookedTax / (netBase − promo)` instead of prorating
    `inv.totalMinor`, whose untaxed promo slice it was crediting as though it were money. Measured
    (`scripts/probe-cancel-unpaid-promo-basis.ts`): a mid-term cancel credited 1506931 and left 607393
    due where 520296 is owed — 87097 short, the same `rate × promo × unused/term` residual the change
    path shed a commit earlier; now 1594028 / 520296. The two paths agree on the same unused time, which
    is the point. Past the taxed base the plan carries a `promotionalRestoreMinor` and the issuer writes
    the restore + discount row in ONE customer-locked transaction, re-planning inside the lock exactly as
    the paid branch does so two concurrent cancels cannot restore twice.
  - `planDeliveredMinor` counts an adjustment's freed promotional credit — both halves reach the
    customer, one as debt they no longer owe and one as balance they can spend, and the cancel PREVIEW
    reads this figure.
  - Gated on `promotionalCreditsAppliedMinor > 0` on an OPEN invoice throughout, so with no promotional
    credit applied every branch is the old one and no fixture moved.
  - Gates: `pnpm test` 490/490; `tsc` clean; `verify:credit-notes|credit|proration|proration-matrix|
invoices-v2|subscriptions-v2|estimates|tax|refund|offline-refund|audit|change-atomicity|
update-for-items|subscription-ops` all PASS; every `scripts/probe-*.ts` keeps its verdict
    (`probe-cancel-after-change-credit` invoice #1 gains 0, `probe-cancel-multi-invoice` shortfall ₹0.00,
    `probe-adjust-unpaid-promo-tax` RESIDUAL 0, `probe-change-promo-tax-retention` PASSES).
- **2026-08-25** — **`creditOneInvoice`'s tax line now uses the invoice's TAXABLE base when the credit
  lands on an unpaid invoice** (D-cn-cap; the ledger half is in `src/modules/credit-notes/README.md`,
  which carries the full arithmetic). On a PAID invoice the credit reverses the whole gross and the
  bucket-funded slices go back to their buckets, so the promo slice is credited too and the note's tax
  is the BLENDED `bookedTax / netBase`. On an OPEN invoice the note is an ADJUSTMENT: it reduces
  amount **due** and returns nothing to the promotional bucket, so the promo goes on funding the
  supply the customer keeps and every credited unit comes off the TAXED slice — the reversal is the
  STATUTORY `bookedTax / (netBase − promotional_credits_applied)` on the base actually released.
  Measured (`scripts/probe-adjust-unpaid-promo-tax.ts`): a mid-term downgrade of an unpaid promo-funded
  ₹27,918 term left **92903** of IGST standing on cancelled time; it is now 0. The pair still
  round-trips with `issueAdjustmentCreditNote`, whose denominator moved to the taxed gross in the same
  change — the two denominators are the two halves of one identity and had to move together. With no
  promotional credit applied the two bases are the same number, so every existing fixture is
  byte-identical.
- **2026-08-25** — **A bucket-funded credit note now says so on the document, and a zero-cashable
  one is WRITTEN instead of skipped** (0186 populate; the credit-note half is in
  `src/modules/credit-notes/README.md`). Both places that split a credit by how the invoice was
  funded — `creditOneInvoice` (`proration.ts`) and the split path of
  `issueProratedCreditForUnusedTerm` (`cancellation-credit.ts`) — now pass
  `createRefundableCreditNote` a `subtotalMinor` (`sub_total`: the gross reversal) and typed
  `discounts[]` rows for the slices handed back to the promotional / excess buckets, worded
  "Promotional Credits Returned" / "Excess Payments Returned". `total_minor` is untouched:
  it stays the CASHABLE claim.
  - **The identity** is `total = sub_total − discounts + tax`, and it now holds by
    CONSTRUCTION: `subtotal_minor = refundable + promotional + excess − (the tax line the note
carries)`. Written that way rather than as the raw pre-tax gross so it stays exact in the one
    case where it otherwise would not — a term invoice part-funded by TDS withholding, where
    `splitCreditByFunding`'s `cashPaid + refundableApplied` cap clamps `refundable` below its
    pro-rata share and the withheld residual is credited to nobody. The note then reports the gross
    it actually DELIVERED instead of claiming a reversal that never reached the customer. Whenever
    the cap does not bind it is exactly `discountedTotal`, the pre-tax gross credit. Measured on
    `scripts/probe-change-promo-tax-retention.ts` (which now prints the note's subtotal, its
    discount rows and this arithmetic): 2791800 − 1000000 + 322524 = 2114324 = `split.refundable`.
  - **`if (split.refundable <= 0n) return null` is gone**, and so is the `cashableItems.length === 0`
    twin. A reversal funded entirely from the buckets — gross recorded, the returned
    slice as a discount, `total_minor` 0 — is now representable. A note is still refused when
    nothing moved at all (no cashable slice AND no bucket slice: a term settled by neither cash nor
    credit). `scripts/probe-change-credit-funded.ts`: subtotal 61935, `promotional_credits` 61935,
    total 0.
  - **No double-posting.** `restoreBucketFundedSlices` posts the bucket movement, as it always did;
    the discount rows are DOCUMENTARY and `createRefundableCreditNote` posts nothing for them (and
    nothing at all when the note's total is 0). Evidence: on the credit-funded probe the business's
    ledger holds exactly ONE `change_credit_restore` transaction of 61935 to
    `promotional_credit_balance` and ZERO rows sourced at the credit note, and the measured
    promotional delta is 61935 − 15484 (the new term's draw) = 46451 = ₹464.51, the same figure the
    probe reported before this change.
  - Cancellation carries no tax line of its own (its credit is prorated off the invoice's
    tax-INCLUSIVE total), so its `+ tax` term is nil and its subtotal is simply cashable + returned.
    Its note's items stay the cashable line, so a wholly bucket-funded cancellation credit has none.
    _(Still no tax LINE, but as of 2026-08-25 an UNPAID promo-funded invoice no longer prorates the
    tax-inclusive total: it prorates the SUPPLY and grosses up at the statutory rate. See the
    2026-08-25 entry below.)_
  - Gates: `pnpm test` 490/490; root + dashboard `tsc --noEmit` clean; `verify:credit-notes`,
    `verify:credit`, `verify:change-atomicity`, `verify:proration`, `verify:proration-matrix`,
    `verify:invoices-v2`, `verify:subscriptions-v2`, `verify:estimates`, `verify:tax`,
    `verify:refund`, `verify:offline-refund`, `verify:audit`, `verify:rls` all PASS; all five probes
    keep their verdicts (`probe-cancel-multi-invoice` shortfall ₹0.00,
    `probe-change-promo-tax-retention` PASSES with `tax_payable` 0).
- **2026-08-24** — **Removing (or shrinking) an item now settles the charge it queued, not just the one
  it was invoiced.** Closes the OPEN item at the foot of this changelog — the charge side of 840670d.
  An add made without `invoice_immediately` (the default since 0109) is not invoiced: its prorated
  charge is queued as a pending `unbilled_charge` covering `[added .. currentPeriodEnd]`, folded into
  the next renewal. Removing the item left that row behind, so the renewal billed a line for an item
  the customer no longer held, over a window running past the day they gave it up. Measured
  (`scripts/probe-remove-item-unbilled-orphan.ts`, kept as the before/after evidence): a ₹600/mo add-on
  added 11-Aug and removed 21-Aug on an Aug term queued ₹406.45 for `11-Aug..1-Sep`; ten days were held,
  ₹193.55 was owed, and the 1-Sep renewal invoiced the full ₹406.45.
  - **It sometimes netted right by accident, never by mechanism.** With no invoice having charged that
    price, `issueCurrentTermCredit` falls back to "the newest live invoice" — the PLAN's — and issued a
    REFUNDABLE note there for the same tail. Equal amounts, so the net cancelled. It stops cancelling
    the moment either half moves: with the term itself deferred there is no live invoice at all and
    nothing was credited (**₹212.90** over-billed); on a cheap plan the fallback note is capped at that
    invoice's cash (**₹100.00** of the ₹212.90, **₹112.90** over-billed). And when it did cancel, it
    cancelled by handing over refundable _cash_ drawn from a payment that never charged the add-on —
    withdrawable, leaving the renewal charge standing.
  - **The line drawn: re-cut, never blanket-void.** A charge for time the customer DID hold is owed and
    is still billed. `planRemovedItemUnbilledSettlements` (proration.ts) voids the queued row and
    re-queues the slice `[periodStart .. removal)`; the slice beyond the removal is dropped, and the
    clawback is subtracted from the credit the same removal was about to issue for that same span, so
    the remainder is handed back exactly ONCE — by cancelling an unraised charge where nothing was
    collected, by a credit note where something was. A deferred add and an invoiced one now net to the
    same money, which is what makes the Invoicing Option a timing choice rather than a pricing one.
  - **A one-time fee is untouched.** It names no service window (`addSubscriptionItem` stamps none), so
    there is no span to re-cut — matching the standing ruling that a `one_time` item is charged once,
    prorated never and credited never, invoiced or queued.
  - **The PARTIAL case is real: a quantity REDUCED, not removed.** The item survives, so part of the
    queued charge is genuinely owed. `changeSubscription`'s credit/recharge pair settles that
    arithmetically — but only if the credit can actually be issued, and it lands on the same
    newest-live fallback and the same cap. Measured (probe scenario F): an add-on ×10 queued at
    ₹4,064.52 and cut to ×4 mid-term owed a net ₹1,277.42 back and issued **₹1,000.00** — the plan
    invoice's entire cash — silently keeping ₹277.42, while the queued ×10 charge stood in full. So a
    CHANGED item settles too, against its OLD price: ×10 survives for `[added .. change)` (₹1,935.49),
    the ×4 remainder is charged (₹851.61), total ₹2,787.10 = exactly what was held, and no credit note
    is needed at all. Applied to both doors onto a removal (`DELETE …/items/:id` and `update_for_items`'s
    `removes`) and to both the non-reset and term-reset branches, for the items a call actually touches.
  - `estimateChange` mirrors the netting line for line, or the preview quotes a credit the booking will
    not issue. Ownership of a queued row is `price_id` + an `entity_type` of `plan_item_price` /
    `addon_item_price` — the two only a subscription-item booking writes; a Quick Charge is `adhoc` or
    `charge_item_price` and can never be mistaken for one. **OPEN:** `unbilled_charges` has no
    `subscription_item_id`, which would make that exact rather than inferred (deliberately not carrying
    a migration here). **OPEN:** a term reset still credits an UNTOUCHED item's whole unused term while
    that item's own deferred charge stays queued — the same class, but not a rule about the item that
    changed.
  - Fixture moved, with numbers: `verify:change-atomicity` G asserted "the credit note is the add-on
    term value (500)" on an add that was never invoiced — it was asserting the defect (the queued 500
    stayed pending AND a 500 refundable note was drawn off the plan's invoice). It now asserts the
    queued 500 is cancelled and no note is owed; `assertRemovalOutcome`'s invariant widened from "never
    deleted without its CREDIT" to "never deleted leaving the money it owed UNSETTLED", where settled
    means a credit note _or_ a cancelled queued charge. F (invoiced, multi-invoice) is unchanged.
- **2026-08-24** — **A grossed downgrade credit no longer outruns the charge that offsets it**, and the
  credit note's tax ITEM now agrees with its ledger. Two fixes in `proration.ts`:
  - **Gross only when the offsetting charge is invoiced NOW.** Grossing (this same day, above) splits
    one net credit into a full-term credit plus a charge for the time kept — but that charge only
    becomes an invoice when `invoice_immediately` resolves true, and
    `businesses.default_invoice_immediately` ships **false**, in which case the charge is queued as an
    unbilled charge for the next renewal. So the customer got the whole unused term back as _cashable_
    refundable credit while the time they kept was not billed at all. Caught by `verify:credit`: a
    3000/mo term for 3 seats, paid in cash, downgraded to 1 seat at mid-term left refundable **1500**
    plus a 500 unbilled charge, where netting leaves **1000** and nothing outstanding. The two agree on
    the net position only once the unbilled charge is billed (it was, at renewal: a 1500 invoice, fully
    covered, balance 0) — but refundable credit is cashable _on demand_ before then, so 500 of money
    still owed to us sat in a bucket the customer could ask back. Nothing is traded away: the bucket +
    tax win from grossing is earned entirely ON the second invoice (the returned promotional credit has
    to re-apply to it pre-tax), so with no second invoice there is no gain, only the exposure.
    `invoiceImmediately` is now resolved _before_ the apply transaction, since the shape decision inside
    it depends on the answer. Same hazard as the `termInvoiceCanAbsorb` clamp, signs swapped.
  - **The `Tax reversal on credited time` item is no longer pro-rated with the supply lines.**
    Promotional credit is applied PRE-tax, so the promo-funded slice bore no tax and ALL of the credited
    tax belongs to the cashable slice — which is what `createRefundableCreditNote`'s ledger reversal now
    books (`total × bookedTax / (invoiceTotal − promotionalApplied)`, 51395fc). `creditOneInvoice` was
    still rescaling the tax line alongside the supply lines, so on the promo scenario the note read
    1895361 time + **218963** tax against a ledger reversing **322524** — 103561 misattributed on a
    document whose total, balances and ledger were all correct. The tax line is now carried over whole
    (clamped only by the slice) and only the supply lines are rescaled, to `refundable − tax`, keeping
    largest-remainder so they still sum exactly: **1791800 time + 322524 tax = 2114324**, and the note's
    net is exactly the taxable base credited. The two layers agree by construction — substituting the
    funding split into the ledger's formula reduces it to this line's own `discountedTotal × bookedTax /
netBase`. Untaxed invoices book zero tax, so every USD fixture
    is byte-identical. Gates: 490/490 unit tests; typecheck clean; `verify:credit` (now green, at 1000)
    `|proration|proration-matrix|invoices-v2|subscriptions-v2|estimates|credit-notes|tax|refund|
offline-refund|audit|events|outbound-webhooks` all pass, no assertion moved; all four probes keep
    their verdicts (`probe-change-promo-tax-retention` still PASSES with `tax_payable` 0).
- **2026-08-24** — **Restoring a promo-funded slice now ALSO emits `customer_promotional_credits_added`.**
  `restoreBucketFundedSlices` emitted only `customer_credits_restored` — our own multi-bucket summary
  (promotional + excess in one payload, keyed on the invoice). That is not the promotional-credit
  movement event. Measured: no movement event on the cancellation restore, nor on either
  change-path restore. `customer_credits_restored` is KEPT and still fires exactly once — this ADDS the
  specific event beside it rather than renaming anything, since existing consumers read the summary.
  Emitted through the shared `emitPromotionalCreditMovement` in `customers/balances.ts`, so the
  payload is identical to a manual grant plus a top-level `invoice`. Emitting it inside the helper
  rather than at its call sites means both callers are covered — `issueProratedCreditForUnusedTerm`
  here and `creditOneInvoice` in `proration.ts` — without touching the latter. The excess bucket gets
  no twin event: `customer_excess_payment_recorded` means offline money RECEIVED, so reusing it for a
  restore would report a refund as income.
- **2026-08-24** — **ad8c149 was incomplete: an invoice funded from the customer's REFUNDABLE balance
  still refused the change.** That commit routed the promotional and excess slices back to their
  buckets, but the recycled REFUNDABLE slice kept going through `issueRefundableCreditNote`, which
  guards on `paidMinor <= 0` ("Refundable credit notes require a paid invoice") **before** it reaches
  its cap. Zero cash + a non-zero refundable draw means `split.refundable > 0` while `paidMinor` is 0,
  so the guard threw and the whole subscription change rolled back. Found on a chain where ₹350.07
  of cash was topped up and the change should have applied; we refused it.
  Now calls `createRefundableCreditNote` directly — the same call `cancellation-credit.ts` makes, and
  why cancelling such a subscription always worked while changing it did not. Bypassing the guard is
  safe because both of its jobs are already done upstream: `splitCreditByFunding` has clamped the
  amount to `cashPaid + refundableApplied` (the cancellation cap), and `issueCurrentTermCredit`
  filters `live` to exclude voided/credited/pending invoices, so this branch has a paid or
  partially-paid invoice by construction.
  Regression-tested by `scripts/probe-change-refundable-funded.ts`, which fails with the exact error
  when the fix is reverted. ⚠ Note the DIRECTION matters and the first version of that probe was
  worthless because of it: an upgrade has `net > 0` and books the credit as a negative INVOICE LINE,
  never reaching `creditOneInvoice`. Only a downgrade takes the credit-note path where the guard lives.
- **2026-08-24** — **A mid-term change stamped the raw instant as its service period, not the billing
  day.** The proration invoice took `periodStart: plan.resetTerm ? plan.resetStart : now`, so only the
  TERM-RESET branch was aligned; a SAME-CADENCE change took `now` and recorded a period starting
  19:50:52 on a day the customer was billed for in full. The right stamp is
  `2026-08-24T00:00 IST` where we stamped `2026-08-24T19:50:52 IST` — the same day, differently
  floored. Not an outside preference: our own reset path already made this decision, so one business
  answered the same question two ways depending on whether the interval changed.
  The AMOUNTS were never wrong — `prorationNow` already fed them, which is why 9118 × 16/31 = 4706.06
  both before and after. What was wrong is the recorded window, and every later proration inherited
  the sliver: at cancel a full day should have been withheld (2377) where we withheld ~4h (266).
  Fixed by stamping `plan.prorationNow` — the SAME value the amounts use, now carried on the plan
  rather than recomputed — at both invoice sites. `prorationWindowStart` (not `alignTermStart`) is the
  right helper: it keys off proration granularity and returns `now` unchanged for `exact` businesses.
  Verified with `scripts/probe-change-line-dayalign.ts`: day-anchored period start 19:50:52 → 00:00:00
  with amounts unmoved, and an instant-anchored control that does not shift.
- **2026-08-24** — **The change estimate under-quoted tax by netting the credit into the tax base.**
  `estimateChange` summed ALL its lines — charges plus the negative unused-time credits — and taxed
  the result, so with the credit exceeding the charge `net` went negative, the `net > 0n` guard
  suppressed tax entirely, and the dialog showed a plan change with **no tax line at all**. On apply
  those negative lines do not land on the invoice: `issueCurrentTermCredit` turns them into a CREDIT
  NOTE that reverses its own booked tax, and `createInvoiceFromLines` **throws** on a negative
  subtotal — so the shape being previewed could not exist as an invoice. Now taxes the POSITIVE lines
  only. `total` still nets, so `amount_due_minor` is unchanged; only the tax base moved. The bite is
  the partial case: charges 9118 against a 5000 credit quoted 18% of 4118 (741) where the invoice
  charges 18% of 9118 (1641) and applies the credit post-tax. Known over-quote: the
  `fallbackCreditLines` path (proration.ts), where a credit genuinely IS booked as negative invoice
  lines — it needs an invoice that exists but is uncreditable AND a credit smaller than the charge,
  and is not determinable from the estimate without replaying the apply phase's creditability check.
- **2026-08-24** — **A change to a subscription whose invoice was paid with CREDIT was refused outright.**
  `creditOneInvoice`'s paid branch issued a refundable CN for the whole credit regardless of how the
  invoice was funded, so an invoice settled by the customer's own promotional/excess credit hit the
  cash-only cap in `issueRefundableCreditNote` and threw `Refundable credit N exceeds refundable paid
amount 0` — rolling the ENTIRE change back. The operator could not change the plan at all.
  **The change must still apply.** An invoice funded entirely by promotional credit issues CN-188
  `refundable` with **sub_total ₹41,899.00 / total ₹0.00**, and returns the promotional slice to the
  promotional balance (83,798 + 41,899 − 525 = 1,25,172).
  **Fix:** `splitCreditByFunding` + `restoreBucketFundedSlices` extracted from `cancellation-credit.ts`
  (which already did this for cancels) and reused by `creditOneInvoice`, so both paths owe the customer
  the same money. Bucket-funded slices go back to their own buckets — promotional must never become
  cashable — only the cash + recycled-refundable slice becomes a refundable CN, and nothing is refused
  for want of cash. The allocator's capacity now counts the recycled slice, so such invoices stop being
  skipped (retiring the loud log added the same day).
  Mirrored, measured with `scripts/probe-change-credit-funded.ts`: ₹1,200 invoice paid wholly by promo
  credit, plan changed mid-term ₹1,200 → ₹300 on day 16 of 31 → **applied**, promotional balance
  **+₹464.51** = 16/31×1200 credited back (₹619.35) less 16/31×300 charged (₹154.84). Same shape as the
  +41,899 − 525 above.
  ⚠ **Known gap:** the note ought to be written at GROSS with a zero cashable total; our `credit_notes`
  row has no gross/cashable split, so when the cashable slice is zero we write no note at all. The money
  is right, the document is less detailed. Tracked in `D-cn-cap`.
- **2026-08-24** — **A spent invoice stayed in the term set and refused an entire subscription change.**
  `issueCurrentTermCredit`'s candidate set filters on status and a non-zero total, which is not the same
  as having room left: an invoice whose cash was fully refunded AND fully credited is still `paid` with
  a non-zero total, so it was allocated a share that `issueRefundableCreditNote` then REFUSED — rolling
  the whole change back. Measured on `sub_XXXXXXXXXXXXXXXXXXXXXX02`: two ₹3,73,800.40 invoices for one
  term (the second raised by an earlier attempt), the first fully refunded + fully credited (room ₹0),
  the even split handing it ₹1,86,900.20 — exactly the operator-visible `Refundable credit 18690020
exceeds refundable paid amount 0`. Fix: capacity is asked with the newly exported
  `refundableCapacityForInvoice` — **the same function the guard enforces**, so allocator and refusal
  cannot disagree — zero-room invoices drop out, and each share is clamped to its invoice's room with
  the excess re-placed on invoices that have headroom. After: 1 of 2 fundable, the full credit lands on
  the invoice with ₹3,73,800.40 of room.
  ⚠ **Known residual (`D-cn-cap`):** capacity measures CASH, so an invoice settled by APPLIED CREDIT
  also reports 0 and is skipped — correct when the money was already returned, wrong when it was paid in
  credit, and indistinguishable by cash alone. That case now logs loudly rather than passing in silence;
  returning it properly needs `cancellation-credit.ts`'s funding split ported into `creditOneInvoice`.
- **2026-08-24** — **A cancellation credited one invoice and silently dropped the rest of the term.**
  `cancellation-credit.ts` resolved the term with `period_start = sub.current_period_start` and then
  kept ONE row (`rows.find`), so any invoice raised mid-term was invisible to it — a mid-term add-on
  carries the CHANGE date as its `period_start`, not the term's. Measured with
  `scripts/probe-cancel-multi-invoice.ts`: an Aug 1–Sep 1 term, ₹1,200 base invoice plus a ₹309.68
  add-on invoice raised Aug 16, both paid in cash, cancelled Aug 21 → **one** credit note for ₹425.81
  (exactly 11/31 of the base invoice) and the add-on invoice never looked at. `cnCap` clamps without
  erroring, so the customer just lost it. This is the same defect `proration.ts` fixed for term resets
  (its D1 comment: "This used to credit a single invoice … A term billed across several invoices then
  could not be credited at all") and never ported here; the whole term must be credited.
  **Fix, additive — no signature changed:** new `termInvoices()` takes every live invoice whose billing
  window OVERLAPS the term (primary first), `planCancellationCredit` gained an optional `invoice` so
  omitting it resolves the primary exactly as before, new `planCancellationCredits()` returns one plan
  per invoice, the issuer loops and still returns the primary's note, and `estimate.ts` sums across
  parts so the preview cannot drift from the issuer.
  **Semantics chosen:** each invoice is prorated over ITS OWN window, not the subscription's — an
  invoice owes back the unused fraction of what IT charged for. The add-on invoice billed Aug 16–Sep 1,
  so 11 of its 16 days are unused (₹212.90), not 11/31 of it (₹109.89, which is what D1's single
  term-wide fraction would give). For the primary invoice the windows coincide, so the single-invoice
  path every existing scenario exercises is unchanged — after: 2 notes, ₹425.81 + ₹212.91, shortfall
  ₹0.00. Overlap is also deliberately NARROWER than `proration.ts`'s set, which applies no period
  filter at all. Gated by `verify:invoices-v2`, `verify:subscriptions-v2`, `verify:estimates`,
  `verify:credit-notes`, `verify:proration`.
- **2026-08-24** — **One edit, four requests, five documents — and a charge the bank refused.**
  `POST …/change` could not carry adds or removes (its own doc comment said so), so a single
  operator edit — move a monthly plan to its yearly price, remove the Looker Studio add-on,
  remove the old monthly connections line, add connections on its yearly price — went out as
  FOUR requests and produced FIVE documents: an invoice billing a full **year** of two lines
  the very next request removed (₹279,296.56 = LITE 91,180 + Looker 55,272 + Connections
  90,240 + IGST), two credit notes handing them straight back (−₹65,220.96, −₹106,483.20), a
  second invoice for the added line (₹110,920.00), and the unused-term credit (−₹47,251.92).
  The net, ₹171,260.48, was **arithmetically correct**, which is why this survived so long.
  Two things were still wrong:
  - **It could not COLLECT.** The ₹110,920 invoice alone exceeded that customer's ₹97,572
    per-debit e-mandate ceiling, so the bank refused it. Splitting one collectable charge into
    two turns a payable edit into a dunning case — the net being right is no comfort when
    neither half can be taken.
  - **The whole edit belongs in ONE `update_for_items` (`replace_items_list=true`), raising ONE
    invoice.** Billing a year for lines we are about to remove, then crediting them
    back, was an artefact of the ORDER our requests went out in, not of anything owed.

  `changeSubscription` now takes `adds` and `removes` beside `changes`, applies all three in
  ONE transaction, and folds every line into the SAME `createInvoiceFromLines` call — one
  invoice, at most one credit note. The machinery was already there and was extended, not
  rebuilt: `inserts` and `removals` existed for CAT-3 mandatory expansion and plan-swap
  removal and already folded into that one invoice; they are now fed from the request too.
  The reset branch's charge loop, its cadence re-validation and its snapshot re-alignment all
  skip a removed item — that single `continue` is what stops an edit from billing a year of
  something it removes in the same breath — while the reset CREDIT still covers the whole
  term, removed items included, because the customer really did pay for them.
  - **No money rule was re-invented.** An add is priced exactly as `addSubscriptionItem`
    prices it (currency guard, custom-price overridability, `effectiveAddSnapshotTx` so a ₹0
    list price with a per-plan differential still resolves to the differential, full fee for a
    `one_time` price with `markItemsBilled` for its cycle) and a removal credited exactly as
    `removeSubscriptionItem` credits it (nothing for a `one_time` item, billed or not).
    Mandatory add-ons, cycle caps and `recomputeSubscriptionMrr` are unchanged.
  - **The cadence guard for an ADD is checked against the POST-change cycle** (`postCycle`,
    the first pass added earlier the same day), not the cadence the subscription is leaving.
    That is the whole point: a yearly add-on on a plan that becomes yearly in the same call is
    legal, and validating it against the outgoing monthly cadence refused exactly the edit
    this work exists to support. With no plan price change `postCycle` is the current cadence,
    so every other add is validated as before.
  - **No proration window moved and no amount changed.** `changes` and `adds`/`removes` were
    genuinely measured from different boundaries until 2026-08-23; today both are
    `prorationWindowStart(now, currentPeriodStart, bizMode)` — the same expression in
    `changeSubscription`, in `items.ts` (`itemProrationWindowStart`) and twice over in
    `estimateChange` (`prorationNow`, `itemWindowStart`, kept as separate locals so a future
    divergence stays visible). Folding adds into `/change` therefore moves no number, which
    the acceptance test pins by replaying the same edit the old way: **187,097 both ways**, 1
    document vs 5 (`verify:estimates` § 5). The `SubscriptionEstimateRequest` description in
    OpenAPI still claimed the old split and was corrected.
  - **New refusals, each mirroring one the single-line route already had:** the same item may
    not appear in both `changes` and `removes` (they ask for opposite money and whichever loop
    reached it first would decide which), and a removal is refused when the add-on is
    mandatory for the **post-change** plan set — measured against the plan the customer is
    moving TO, which is what lets one atomic call do what three could not.
  - A removes-only call that detaches exactly ONE item stays money-identical to
    `DELETE …/items/:id`, including crediting the invoice that actually charged that item
    rather than the newest live one — otherwise the refundable cap could refuse through
    `/change` what the standalone route performs. With several removals, or a removal mixed
    with changes/adds, no single invoice owns the credit and the newest-live heuristic every
    other `/change` downgrade uses applies.
  - `changeSubBody` lost `changes.min(1)` and gained the estimate's own `adds`/`removes`
    shapes plus its refine ("at least one of changes, adds or removes"), so an adds-only or
    removes-only edit is a legal call and the two bodies now describe the SAME request.
    `POST …/items` and `DELETE …/items/:id` are untouched and keep working for callers that
    hold one line.
  - **Still to do:** `reconcile.ts`'s `applyItemOperations` continues to drive
    `changeSubscription` → `addSubscriptionItem` → `removeSubscriptionItem` in sequence, so
    `/update_for_items` and the change-mode checkout still produce the multi-document shape
    even though the engine no longer has to. Folding them onto the atomic call is the obvious
    next step and was left out of this change deliberately (it moves buyer-facing checkout
    behaviour). Also unchanged: the CAT-3 mandatory-expansion lines still prorate from raw
    `now` rather than the proration window, and `estimateChange` does not preview mandatory
    expansion at all — both predate this work.

- **2026-08-24** — **A cadence guard was reading the cycle the subscription is LEAVING, and the
  preview was not reading it at all.** Two failures of one idea, both found from a real operator
  edit: move a monthly plan to its yearly price _and_ move each add-on to its own yearly price, in
  one change.
  - **The apply refused it.** `cadenceMismatch` is right — an item may bill more often than the
    cycle (folded ×N) and never less often — but `changeSubscription` handed it
    `sub.billingPeriodUnit`, the cadence _before_ the change. Per item, "yearly add-on,
    still-monthly subscription" is indistinguishable from the illegal direction, so a legal edit
    (no yearly item sits on a monthly cycle once it lands) was rejected. Worse, the answer depended
    on **array order**: `[{addon→yearly},{plan→yearly}]` refused, the same two changes reversed went
    through. One end state, two answers, decided by JSON ordering.
  - **The preview quoted it anyway.** `estimateChange`'s _changes_ loop never called
    `cadenceMismatch` at all — only its _adds_ loop did — so it returned HTTP 200 and a number the
    confirm then threw on. Measured on the live API before the fix: a yearly add-on swapped onto a
    monthly subscription previewed `total_minor 4891572` with a line _"Remaining time on
    …-INR-Yearly ×1 4606000"_ — a whole year rated inside a monthly term, 12× the truth.
    Both now resolve the post-change **plan** cadence in a FIRST PASS over `input.changes`, before any
    single item is validated, and rate and check every non-plan item against that `postCycle`. A
    separate pass is what makes array order irrelevant. With no plan price change it resolves to the
    subscription's current cadence, so every same-cadence path is byte-identical. Prices are looked up
    once and reused, so the pass costs no extra queries, and it raises nothing — a bad item id, an
    unknown price and a currency clash are all still reported by the main loop in the caller's order.
    `estimateChange` also re-expresses an ADD's snapshot with `realignSnapshotToCycle` when the cycle
    moved, because `effectiveAddSnapshotTx` folds against the cycle it reads from the DB (the outgoing
    one) while `addSubscriptionItem` will run _after_ the change; `realign` and not `align` because the
    forward scale is not idempotent across a change of cycle — it rewinds through the recorded
    `cadenceMultiple` first (`deAlignSnapshotFromCycle`), which is also why aligning straight to
    `postCycle` cannot double-scale a folded item.
    The post-loop `frequencyChanged` re-validation stays as the backstop. `verify-estimates` gained a
    TWO-AXIS block that pins the combination, the order-independence, `estimate == booked`, and — the
    assertion that would have caught all of this in seconds — that a yearly add-on on a subscription
    which _stays_ monthly is still refused **by both** the estimate and the apply, with the same
    message.
- **2026-08-23** — **D1: a term billed across several invoices is now credited once PER INVOICE.**
  `issueCurrentTermCredit` credited a single invoice — "the newest live" — and
  `createRefundableCreditNoteForInvoice` caps at THAT invoice's cash. So once a mid-term quantity
  change had raised a second, small proration invoice, a whole-term credit could not fit anywhere and
  **every later plan change was refused for the rest of the term**: `Refundable credit 4902646
exceeds refundable paid amount 171746`. The credit has to be SPLIT per invoice: with multiple
  invoices present for the billing cycle, one note per invoice — CN-182 ₹47,251.92 vs invoice #2165
  and CN-183 ₹1,774.72 vs #2166, both applied to #2167.
  The per-invoice body moved to `creditOneInvoice` unchanged — every rule in it (coupon scaling, tax
  reversal from the ledger, adjustment-vs-refundable) is per-invoice, so it had to move as a unit.
  The outer function now walks the term's live invoices oldest-first and credits each **from its own
  line items**, scaled by how much of the term is being credited. Deriving the lines from the invoice
  rather than slicing the caller's list is what keeps the documents honest: the proration invoice
  charged only the add-on delta, and a credit note against it must not carry a line for a plan it
  never billed. Returns `CreditNote[]`; `changeSubscription`'s result gains `creditNotes` and keeps
  `creditNote` as the first. `removeSubscriptionItem` is untouched — it passes
  `targetInvoicePublicId`, which still credits exactly the invoice it resolved.
- **2026-08-23** — **A mid-term change prorates from the CURRENT billing day, not the next one.**
  `/change` measured both the credit and the charge from `prorationBoundary`, so an immediate upgrade
  lost one day of the added units. Measured mid-term (day 16 of a 31-day term,
  connections 10→12): the right shape is ONE delta line, qty 2, period **23-Aug → 07-Sep**, ₹776.26 =
  1504 × **16/31** — the change day counts, and the line's own period says so. We produced
  1504 × 15/31 = ₹727.74. Now `prorationWindowStart`, in `proration.ts` and `estimate.ts` together.
  Both sides of a change share the one window, so the net is `(new − old) × window` — the same shape
  as that single delta line, which is why matching the window is the whole fix and the
  credit-and-rebill structure was never the problem.
  **`cancellation-credit.ts` deliberately keeps `prorationBoundary`**: on a cancellation the customer
  genuinely keeps the day they cancel in, which is the case that boundary was written for.
  The original audit could not settle this — it measured on the term's FIRST day, where the
  answer is 31/31 either way. `verify:billing-mode` § B5 now asserts it mid-term, on a whole-day
  business (with `exact` proration both windows collapse to `now` and the case is vacuous).
- **2026-08-23** — **A monthly add-on was billed ONE MONTH for a whole yearly term** (finding I,
  ₹149,930 per subscription-year on the measured subscription). A term reset changes the
  subscription's cadence but leaves every other item where it was, so a monthly add-on ends up on a
  yearly plan — and the reset branch charged `computeLineAmount(itemSnapshot)`, one period of the
  item's OWN cadence. The monthly price has to be multiplied by 12; `alignSnapshotToCycle` has
  implemented exactly that rule since 2026-08-05 and its own doc comment describes this case. The
  reset branch simply never called it. It now re-aligns every recurring item onto the new cycle via
  `realignSnapshotToCycle`, and **persists** the result — probe 2 had confirmed the renewal repeats
  the shortfall otherwise, so the invoice half alone would have left the leak recurring every year.
  Verified end to end: subtotal **254,740.00**, right to the paisa
  (lite 91,180 + connections 12×9,024 + gds 55,272), on the change invoice AND the renewal.
  **The `frequencyChanged` refusal is retired.** It blocked a cadence change whenever any item was
  already folded, and its own comment named the reason: "re-deriving all of them mid-change is real
  work … refuse the combination for now rather than mis-bill it. Tracked in PROGRESS as follow-up."
  That is the follow-up. Yearly→monthly now rewinds correctly (₹9,024/yr → ₹752/mo — the exact 12×
  overcharge the refusal existed to prevent) instead of being rejected.
  What still refuses, now per-item and by name: a model with no single scalable amount (tiered,
  package, percentage) has no unambiguous ×12, and billing one period of twelve is a silent
  under-charge, so `cadenceMismatch` is raised for it on a cadence change.
  **`estimate.ts` needed the same mirror, and its absence was invisible.** `verify:estimates`
  asserts estimate == booking on every shape it covers — and had no cadence-change shape, so it
  passed while the preview quoted $650 against a $1,200 apply. Both now carry the fold and the
  suite carries the case.
- **2026-08-23** — **A yearly subscription could renew after ONE MONTH, billed the full year.**
  `loadRenewalCtx` (`renewal.ts:567`) read the renewal cadence with `limit 1` over the recurring
  items — **unordered, and with no plan filter** — so the interval came from whichever item
  Postgres happened to return, and the subscription's own `billing_period`/`billing_period_unit`
  (correct throughout) was ignored. Harmless while every item shares a cadence; a monthly→yearly
  plan change produces exactly the mixed state that breaks it, because the monthly add-ons keep
  their monthly price on the now-yearly plan (the open finding I). Measured: a term reset from an
  08-Aug subscription renewed **2027-08-23 → 2027-09-08, 16 days, invoiced ₹98,700 — the full
  yearly amount**. The cadence now comes from the SUBSCRIPTION and no item gets a vote.
  Same query fed `trial_end_action` off the same arbitrary row, which is the same class of harm:
  an ADD-ON carrying `cancel_subscription` could cancel a subscription whose plan says convert.
  It is a plan-price setting and is now resolved from the PLAN item, falling back to
  the first recurring item for a legitimately plan-less (add-on-only) subscription.
  **Second half, same root event:** `billing_anchor_day` was written once at create
  (`service.ts:742`) and never updated, so after a term reset it still named the OLD day of the
  month and `advancePeriod` re-aligned every later renewal onto it — a 351-day "year"
  (2027-08-23 → 2028-08-**08**). `changeSubscription`'s reset branch now re-anchors to the new
  term start's local day, exactly as `createSubscription` does for a fresh term.
  Progression across the two fixes: **16 days → 351 days → 366 days.**
  Found by probe 2, not by the audit — the audit never advanced the
  clock past a change. **Note the testing lesson:** the natural end-to-end regression case (plan +
  add-on, reset, renew) catches the ANCHOR half deterministically but the CADENCE half only when
  the coin lands badly — with both a plan and an add-on present, `limit 1` returned the plan and
  the assertion passed against the broken code (observed while checking). `verify:renewal-matrix`
  therefore carries a second, deterministic case: every item monthly, the subscription yearly, so
  whichever row wins is a month. It reports 30d against the old code and 365d with the fix.
- **2026-08-23** — **A 14-day trial ran 15 days.** `createSubscription` computed the trial's
  EXCLUSIVE boundary (`addInterval(alignTermStart(now), 'day', n)` — already a local midnight,
  because `now` was floored first) and then passed it through **`alignTrialEnd`**, which advances to
  the NEXT local midnight before backing off a second. So every day-anchored trial gained 24h:
  a 23-Aug 00:00 IST signup ended 06-Sep 23:59:59 where 05-Sep 23:59:59 is right — the same plan's
  estimate puts `next_billing_at` at 06-Sep 00:00.
  Now `inclusiveBoundary`, which just subtracts the second. Affects a `trial_days` request and a
  plan's configured `trial_period` identically — both arms feed the one line.
  **The obvious fix was wrong.** Adding `normalizeTermEnd`'s midnight guard _inside_ `alignTrialEnd`
  (the first thing I tried, and what the audit's plan proposed) would have broken the other two
  callers: `reactivateSubscription` and `editTrialEnd` are handed a day an operator NAMED — or the
  `…T23:59:59` a client read back from us — and both must land on the end of THAT day. Verified:
  `alignTrialEnd` is idempotent across both of those input shapes, and a day early with the guard.
  The two helpers take genuinely different things, so the call site moved and `alignTrialEnd` kept
  its contract, now stated explicitly in its doc comment.
  Why the suite never caught it: `verify-billing-mode`'s "natural conversion" case already created a
  `trialDays: 7` day-anchored subscription, but every assertion was about the CONVERSION boundary
  (term starts at local midnight, one second after trial end, …) — all of which are true of an
  8-day trial too. Three assertions added on the trial's own LENGTH; confirmed they report
  `8.0000 days` against the old code while the four pre-existing ones still pass.
- **2026-08-22** — **A same-cadence plan swap no longer resets the term, and `prorate` is real.**
  `resetTerm` was `input.resetTerm || frequencyChanged || isPlanSwap`; the `isPlanSwap` arm is gone.
  `force_term_reset` **defaults to false** and applies only when the cadence matches; a
  DIFFERENT cadence always resets, which is what `frequencyChanged` still does.

  Measured 15 days into a 31-day term (the whole matrix, not a doc reading):

  | scenario                         | term     | charge            | credit                  |
  | -------------------------------- | -------- | ----------------- | ----------------------- |
  | same cadence, default            | no reset | prorated new 1239 | prorated unused old 361 |
  | same cadence, `prorate:false`    | no reset | none              | none                    |
  | same cadence, `force_term_reset` | RESET    | full new 2400     | prorated unused old 361 |
  | freq change, default             | RESET    | full new 6000     | prorated unused old 361 |
  | freq change, `prorate:false`     | RESET    | full new 6000     | none                    |

  ONE rule covers every cell: **`prorate: false` suppresses the PRORATED artefacts only.** A full
  new-term charge caused by a reset is not a prorated artefact, so it survives — which is why the
  "free term" this was blocked on never existed.

  **Why it went unnoticed for six weeks.** The 2026-07-14 decision cited a fixture that swaps in the
  SAME INSTANT the subscription is created — where a reset-to-now is indistinguishable from no reset,
  and the money matches too (prorated new = full new, unused old = full old at zero elapsed). The
  suite structurally could not see the behaviour it was cited for. My own first probe had the
  identical blind spot until I backdated the term.

  Fallout was three assertions in `verify:proration-matrix`, all encoding the old rule, now carrying
  the arithmetic above — including `swap @end`, which used to charge a customer a full extra term 1ms
  before their existing one ended. The whole matrix is pinned there so it cannot drift back.
  ⚠️ `estimate.ts` mirrors this and must change in lockstep; `verify:estimates`' estimate == booking
  assertion is what catches it if not.

- **2026-08-22** — **`remaining_billing_cycles` is editable** (`PATCH …/subscriptions/:sub`). It was
  display-only for the right reason — the route took only auto_collection / po_number /
  invoice_notes / custom_fields, so an editor would have been a dead control — which is also why
  `verify:subscriptions-v2` had to `UPDATE` the column directly to test the engine at all.
  Semantics unchanged and load-bearing: the value counts cycles AFTER the current one, `0` derives
  `non_renewing` and cancels at term end, `null` renews forever, and during a trial it counts the
  PAID cycles still to come. The editor is a mode select plus a number, because one box cannot say
  "forever" — blank would have to mean either unlimited or no-change, on a field where guessing wrong
  ends a paying subscription early. Omitting the key still leaves the cap alone; that is asserted
  (SUB-4b) alongside set / 0 / clear.
- **2026-08-22** — **The signup estimate priced no discount at all**, and taxed the wrong base.
  `estimateNewSubscription` declared `couponCode` and never read it, `discount_minor` was hardcoded 0,
  and the route parsed `coupon_ids` then dropped it — four broken links counting the dashboard, so
  fixing any one changed nothing. It also computed tax on the UNDISCOUNTED subtotal while
  `invoicing/service.ts` taxes the discounted one, so a discounted signup was overstated twice.
  Now priced through the same stacker the invoice uses and gated as **estimate == billed**.
- **2026-08-22** — **A manual discount now applies AT SIGNUP** (`discount` on `createSubBody`), beside
  `coupon_ids` and before the first invoice is planned. It used to be a second HTTP call the dashboard
  made after create returned — by which point the first invoice was raised and collected — so the
  discount an operator set at signup reached the NEXT renewal, and a failure surfaced only as a
  warning. This is the last survivor of the pattern the `coupon_ids` comment describes having already
  fixed for coupons. Measured: a discount passed to `subscription_for_items` lands on the first invoice
  (700 → −175 → 525). Singular rather than an array, because the engine allows one discount per
  subscription and refuses a second.
- **2026-08-22** — `listSubscriptionsForBusiness`/`…Page` project `customerCompany` + `customerPhone`
  off the joined row (no extra query), so the list can render the four-line Customer Info
  cell. The columns existed the whole time; the projection just never selected them.

> Marker legend: **✅** a severe (money / data-integrity) bug — found, fixed and gated in that entry ·
> **🟠** a correctness or concurrency bug · **🟢** a follow-up / cleanup. Severe entries read 🔴 until
> 2026-08-17; the red dot was scanning as an OPEN defect when every one of them was closed. An entry
> with work still outstanding says so in words ("Known, unfixed", "Not verified") — never by its marker.

- **2026-08-21** — 🟠 **`update_for_items`: a desired-item-list API, and the reconcile logic moved
  out of checkout.** A consumer that auto-upgrades a trialing customer who crosses a plan limit had no way
  to express that against us without diffing the subscription itself and emitting its own
  change/add/remove calls. `POST /v1/businesses/:biz/subscriptions/:sub/update_for_items` takes the
  list and reconciles server-side, with `replace_items_list`, `mandatory_items_to_remove`,
  `prorate` and `invoice_immediately`. The swap/add/remove planner it needed already
  existed inside `checkout/service.ts`, so it moved to `reconcile.ts` and both surfaces now share
  one definition rather than two that could drift — the checkout's 114 assertions were re-run
  unchanged to prove the extraction was behaviour-preserving. Removal order is load-bearing and
  documented there: swap FIRST, so `removeSubscriptionItem`'s mandatory-add-on guard (CAT-3)
  answers for the plan the customer is moving TO. Gate: `pnpm verify:update-for-items` (32
  assertions, through the real server), including that a trial plan swap raises **no invoice** and
  leaves the subscription `in_trial` — an "upgrade" that bills mid-trial is the bug, not a detail.
- **2026-08-19c** — 🟢 **Cancellation estimates** (`POST …/:sub/cancel_estimate`). The cancel path moves money four ways — invoice or delete
  pending unbilled charges, credit the unused term, handle open invoices, refund refundable credit
  notes — and an operator picked all five options and confirmed with no preview, on an append-only
  ledger where a mistake needs compensating entries rather than an undo. `estimateCancel`
  (`estimate.ts`) prices all four under a given option set, resolving omissions from the SAME business
  defaults the cancel resolves and mirroring its guards, so a preview refuses exactly what the cancel
  refuses. To stop the preview drifting from the credit it predicts, `issueProratedCreditForUnusedTerm`
  was split: `planCancellationCredit` now does every read and every arithmetic decision (returning a
  `CancellationCreditPlan`), and the issuer only writes what the plan says — the estimate calls the same
  planner. The issuer's semantics are unchanged, except that the split path now recomputes the plan
  INSIDE the `lockCustomerBalances` transaction (it previously loaded the term invoice outside the lock),
  and the planner reads the billing mode with `billingModeFor(tx, …)` rather than opening a second pool
  connection while that row lock is held. Three things the preview surfaces that were invisible before:
  an `end_of_term` cancel runs **no** money handling at all — not now, not at term end (`renewal.ts`
  flips the status and stops) — so every other option is silently dropped and `warnings` now says which;
  the unbilled-charges invoice is raised OPEN moments before the AR step reads open invoices, so
  `unbilled_charges_option: 'invoice'` + `write_off` bills the charges and immediately writes them off;
  and the refundable slice of a cancellation credit is minted before the refund step and matches its
  query, so `prorate` + `schedule_refund` returns the unused term as CASH rather than account credit.
  Also fixed in passing: `default_unbilled_on_cancel` ships `'no_action'`, which is not a member of
  `UnbilledChargesOption` — the cancel path casts it and matches neither branch, leaving the charges
  pending — so the estimate normalises it to "none" and warns, instead of echoing back an option value
  the API does not accept. Dashboard: a "What this cancellation does" rail in the cancel dialog, fed
  from ONE `posted` object that the hidden inputs also read, so the preview cannot describe a different
  cancellation from the one the button submits. Cover: 25 new assertions in `verify:estimates`
  (estimate == the credit actually issued on both the unpaid/adjustment and paid/split paths, wrote
  nothing, already-credited idempotency, projected unbilled invoice == the one raised, write-off net of
  the adjustment credit, business-default resolution, and all four guards).

- **2026-08-19b** — 🟠 **A PAUSED subscription reports `mrr` 0.** It raises no invoices while paused, so
  it earns nothing — but it kept its full rate, and three surfaces then disagreed about what that meant:
  `reportingMrrBySubscription` takes the stored value for every non-cancelled status and so COUNTED it,
  `migration/reconcile.ts` totals ACTIVE + NON_RENEWING and so EXCLUDED it, and the subscriptions list
  blanked the cell while its own `mrr` filter and sort ran in SQL against the stored column (so
  `mrr[gt]=0` returned rows rendering as `—`). All four read that column, so `recomputeSubscriptionMrr`
  zeroing on `paused` is the single change that reconciles them, and `pauseSubscription` now calls it in
  the same transaction as the status write. Safe because it is reversible by construction: both resume
  paths already recompute after writing `active`, so the rate is restated from the items with no
  separate restore path to drift. The dashboard cell now renders the stored figure verbatim for every
  status. Existing rows: the existing `pnpm mrr:backfill` picks them up. `verify:subscriptions-v2` § GR7d.
- **2026-08-19b** — 🟠 **`addSubscriptionItem` takes `invoice_immediately`.** `/change` honoured the
  option while `POST …/items` always invoiced, so a composition edit applied as three calls could defer
  its changes and charge its adds — which is why the change form refused "add to unbilled charges"
  outright whenever a line was being added, rather than state a total it could not honour. The add now
  queues an `unbilled_charge` on the deferred branch (the same `addAdHocCharges` path `/change` uses,
  carrying the same service window and the same one-time cycle bookkeeping), resolves the same business
  default when omitted, and the response carries `unbilled_charges` so a caller can tell "queued" from
  "nothing was owed". The refusal UI is deleted rather than left dead. `verify:addons-charges`, 7 new
  assertions.
- **2026-08-19** — ✅ **A future-dated cardless subscription no longer bills uncollectibly.** Sibling of
  the trial-end hole closed 2026-08-11, same root cause: create-time gating
  (`assertChargeableForAutoCollect`) refuses a cardless auto-collect-ON subscription that charges
  immediately and EXEMPTS trials, future starts and auto-collect-off. The trial exemption got an owner
  at the boundary it deferred to; the future-start one never did. `startFutureSubscriptions` activated
  and called `billSubscriptionPeriod` with no card check, so the invoice failed `no_payment_method`
  after **booking MRR and AR to the append-only ledger** and sending `invoice_issued` +
  `payment_failed` — then died ~4 dunning retries later as involuntary churn. A conversion and a churn
  that both never happened, settled by a compensating void.
  **The remedy is deliberately NOT the trial's.** A trial expiring cardless is a customer who never
  subscribed, so it cancels. A future-dated start is one the merchant scheduled, so it **activates**
  (its term is genuinely running) and simply **raises no invoice**.
  `resolveTrialEndCancel`'s collectability half is now the shared `isUncollectableAutoCollect`
  (auto-collect on ∧ no payment method at all ∧ planned `amountDue > 0`, with the pending-invoice
  exemption moved inside it), wrapped as `isFirstPeriodUncollectable` for the two first-period callers.
  The second caller matters as much as the first: `healUnbilledFirstPeriods` re-probes, so it does not
  undo the skip one tick later — and becomes the RETRY, billing the first period on the first tick
  after a payment method appears, with no manual step. Eight assertions in `pnpm verify:trial-end` § 9
  cover the whole cycle plus the two teeth (auto-collect-off and zero-amount future starts must still
  be invoiced).
- **2026-08-19** — 🟠 **`businesses.default_invoice_immediately` now governs the operation its own
  settings row advertises.** Settings › Billing LogIQ › Update subscription offers _"Invoice
  plan-change charges immediately"_, with help text promising that OFF means charges "accumulate as
  unbilled and are billed at the next renewal" — and `changeSubscription` never read the column
  (only `changeTermEnd` did). The screen described the opposite of what the engine did, on a
  money-moving setting. An omitted `invoice_immediately` now resolves the column (operator ruling,
  2026-08-19); an explicit value still wins.
  The column ships **false**, so this DID flip the default for callers that omit the field. Every
  caller that means "invoice now" regardless of the business preference now says so, and each for its
  own reason: the **scheduled-change applier** (the change page promises a landed scheduled change
  invoices, and `scheduled_changes` has no column to carry a choice), **hosted checkout** (the buyer
  is at a payment page that quoted them a figure), and eleven `verify:*` suites that
  assert on `prorationInvoice` — they test proration mechanics, not the settings default, which now
  has its own coverage in `verify:proration` § D (both directions, option omitted).
  Found while wiring it: the SDK's `subscriptions.change` body type omitted `invoice_immediately` and
  `reset_term` entirely, so an SDK consumer could not ask for either. The change form now **preselects
  the business's default** rather than a hardcoded "Immediately" (verified over CDP in both directions).
- **2026-08-19** — 🟢 **`default_prorate_on_change`'s settings row is scoped to TERM-END changes**, which
  is all it has ever governed. It claimed plan changes, and the sibling fix above made it worth checking
  whether that was a wiring gap. It is not: `resetTerm = input.resetTerm || frequencyChanged ||
isPlanSwap`, so **every plan swap forces a term reset**, and suppressing proration on a reset restarts
  the term while charging and crediting nothing — a free term. The equivalent capability
  (immediate plan change, no proration) does not exist here; ours is scheduling the change at term end,
  which the help text now names.
  **⚠️ SUPERSEDED 2026-08-22 — both halves of that reasoning were wrong.** A same-cadence plan swap
  does not reset the term (`force_term_reset` defaults to false), and
  `prorate: false` on a reset still charges the full new term, so there is no free term. Measured, not
  read. `isPlanSwap` is gone from the condition and `prorate` is a real parameter — see the entry at the
  top of this Changelog. Kept here because the reasoning is instructive: it was sound given what the
  suite could see, and the suite could not see it. Per Rule 0 the control was narrowed rather than left lying, and the
  capability is filed under PROGRESS § 🕗 Backend-blocked with the two implementable options and the
  observation that the trial gate (`billsAtTrialEnd`, which drops every money artefact while still
  applying the composition change) is the shape the non-reset half would take.
- **2026-08-19** — 🟢 **`DunningConfig.dunOfflineInvoices` + `offlineDunningDeadline()`.** A new opt-in flag
  of our own that lets an AUTO-COLLECT-OFF invoice reach the configured
  final action instead of sitting `not_paid` forever — see the invoicing README for the mechanism.
  `offlineDunningDeadline` is the single place the rule lives: it returns null unless the flag is on,
  `dunningAppliesTo` passes, AND `dunningPeriodDays` is set. That last condition is the honest part —
  an offline invoice is never retried, so the period is the only thing that can close its window, and
  without one the flag must change nothing rather than park an invoice `in_progress` that no pass will
  resolve. The settings screen renders a warning in that state instead of a toggle that silently
  no-ops. `planFailureRearm` is untouched: it still returns `offline` for auto-collect-off, because
  this path is driven by the CLOCK reaching a deadline, not by a failed charge.

- **2026-08-18c** — 🟠 **Dunning could present a mandate debit more times than the network allows.**
  NPCI permits one attempt plus **three** retries on UPI Autopay and e-NACH; the default schedule is
  four retries and the API accepts eight. Beyond the cap the debit is rejected by the NETWORK, and
  that rejection is unmapped — `charge_failed`, retriable — so the engine would keep retrying and
  cancel the subscription for its own scheduling error. `NETWORK_RETRY_CAP` + `capRetryDaysForRail`
  truncate the schedule per instrument inside `planFailureRearm` (both branches); an absent rail is
  uncapped, because card and non-Indian instruments are outside the rule. Truncated rather than
  refused at save: the cap is per RAIL and the setting is per BUSINESS, so refusing would make a
  mixed-rail business unconfigurable — the Dunning screen warns instead, naming the retries that will
  really run. ⚠️ `MAX_ATTEMPTS` was NOT the limit and never has been (only `verify-dunning.ts`
  consumes it); exhaustion comes from `nextRetryAt` running off the resolved list, and the export now
  says so. **Known, unfixed:** the cap bounds the schedule only — a manual Pay-now spends a network
  presentation without touching `attempt_count`, so the two counters drift.
- **2026-08-18b** — 🟠 **A plan upgrade could outgrow the mandate in silence.** The per-debit ceiling
  is derived ONCE, at vault time, and nothing on the change path re-read it. Measured: a ₹5,000/mo
  customer on the ₹15,000 fallback upgraded to ₹28,215/mo — the change was accepted, MRR updated, and
  the proration invoice it raised was refused **on the spot** with `mandate_ceiling_exceeded`. It
  parks and the instrument stays `valid` (the ceiling carve-out doing its job), so nothing is
  destroyed, but the customer is on the expensive plan with an unpayable invoice and no one is told.
  No rail lets a ceiling be raised in place, so the only remedy is a fresh authorisation — which
  derives ₹84,645 here and lets `collect_on_payment_method_update` sweep the parked invoices.
  `estimateChange` and `estimateRenewal` now carry `mandate_shortfall` (both, because a mid-term
  proration can clear the ceiling while every later renewal is refused); the change form warns rather
  than blocks; and the customer page offers "Ask to re-authorize". **Known, unfixed:** the estimate
  is the fixed-charge floor, so a metered plan can still cross the ceiling on usage alone.
- **2026-08-18** — ✅ **The NPCI pre-debit notice quoted a metric, not the charge.** It carried
  `subscriptions.mrr` — monthly-NORMALIZED — so a ₹1,20,000/year mandate was notified for **₹10,000**
  against a ₹1,20,000 debit, and every GST renewal understated by the whole tax amount. Legally the
  amount is the strictest field in that notice. It read correctly for monthly plans, which is why a
  live check of 14 notices passed while the numbers were wrong: MRR and the monthly charge are the
  same figure. Now quotes `estimateRenewal` (preferring `amount_due_minor` — what actually leaves the
  payer's bank), which is the calculator the renewal itself uses rather than a third parallel one.
  Usage stays excluded and is documented as such: an estimate cannot know a period that has not
  happened, so a metered INR plan may debit more than its notice said — an open question for operator
  ask 2, not an arithmetic fix. `verify:email-reminders` 27 → 35, the yearly case being the guard a
  monthly-only test could never provide. **Known, unfixed:** the notice covers renewals only; dunning
  retries, collect-on-payment-method-update, operator Collect now and one-time invoices all debit a
  mandate without one.
- **2026-08-17** — **Swept every severity-marked entry in this file, `invoicing/README.md` and
  `gateway/README.md` for open residue: none left, the four stale "Known, unfixed" blocks now say so,
  and a fixed severe bug reads ✅ instead of ✅** (legend at the top of each Changelog; the red dot had
  come to look like an open defect, which is what prompted this). Each marked a
  money/severity bug that its own entry fixed, but three of them trailed lists of deliberately-deferred
  follow-ups, and later work closed those without ever coming back to retract the note — so the file
  advertised nine open defects that no longer existed. Each was re-checked **against the code**, not
  against the changelog: the `one_time` reset-preview trio in `estimate.ts`, the mandatory-add-on cycle
  hole (unreachable by construction — `resolveMandatoryAttachedItems` only picks a `one_time` price on the
  `chargeOnce` branch), the non-reset proration path (now the shared `nonResetItemProration`), the
  planner's inline cap rule (now `isCycleCapExhausted`), `removeSubscriptionItem`'s `one_time` credit
  and its single-transaction + 409/400 mapping, idempotency on both item routes, and the OpenAPI 400/409
  for `DELETE …/items/:item`. Closure notes with the evidence are inline at each block. Gates re-run
  green as the behavioural half of the check: `verify:change-atomicity` (cases H/I), `addons-charges`,
  `estimates`, `proration`, `proration-matrix`, `subscriptions-v2`, `trial-change`, `scheduled-changes`,
  `idempotency-race`. Nothing to fix in code — the defect was the doc, and a stale "unfixed" list is not
  harmless: it is an invitation to redo finished work, or to assume a real gap is already known.
- **2026-08-17** — ✅ **A single "Collect now" could exhaust dunning and cancel the subscription
  before the clock had attempted once.** `planFailureRearm` reads `newAttemptCount` as the INDEX into
  the retry offsets, and the M12 manual-attempt rule (a human "Collect now" / portal "Pay now" does
  not advance `attempt_count`) means the FIRST manual attempt on a never-dunned invoice arrives with
  **0**. `nextRetryAt(0)` is null — "no such offset" — which `scheduleTail` cannot tell apart from
  "the schedule is spent", so one declined manual click landed `not_paid` / `exhausted` with
  `next_attempt_at` null: no retry ever armed, and for a subscription invoice the final action
  cancelled the subscription on the spot. It also silently skipped the whole retry schedule the
  business configured. `planFailureRearm` now schedules from `max(newAttemptCount, 1)` — an attempt
  HAS just failed, so the next step is the schedule's first offset (still anchored on the due date,
  still clamped to `now` when that slot has passed). Every automatic path arrives with ≥ 1, so this
  is a no-op for them, and a genuinely spent schedule still exhausts. Found by `verify:audit`
  (declines a one-time invoice collected by hand, then expects `payment_due`), which crashed on
  `pauseDunning` refusing a `not_paid` invoice rather than reporting the wrong state; regression
  covered in `test/unit/dunning-schedule.test.ts` ("an attempt that did not advance the counter
  still arms the schedule", incl. smart mode and the guards ahead of it).
- **2026-08-09** — **One inclusive-boundary rule, at one second.** A day-anchored term is stored
  exclusively (`…T00:00:00` of the following day) and reported inclusively (`…T23:59:59`, the last
  instant it covers). That conversion existed in two places with two different back-offs:
  `alignTrialEnd` subtracted a **second**, `serialize.ts` subtracted a **millisecond** — so our own
  `trial_end` and `current_period_end` landed on different instants and neither was a boundary
  anyone reasons about. Both now go through **`inclusiveBoundary`** in `billing-mode.ts`, the single
  place the conversion lives, at a whole second. Consequences:
  - `current_period_end` and the `non_renewing` `canceled_at` fallback move `…59.999` → `…59.000`.
  - `subscription_renewed` / `subscription_changed` event data now carries the **reported** term end
    rather than the stored one — a consumer reconciling an event against `GET /v1/subscriptions/:id`
    saw the boundary move by a second.
  - `normalizeTermEnd` is unchanged and still absorbs the read-modify-write (any non-midnight
    instant rounds up), so the change is invisible to the term-end dialog.
  - **Only a LOCAL MIDNIGHT is converted.** "The last instant of the final day" is only true of a
    boundary that is a day boundary. Term ends on a day-anchored business always are, so the guard
    is a no-op there — but a period end can be an arbitrary instant a caller chose
    (`POST /v1/invoices`, the ad-hoc charge endpoint), with no write-side normalization forcing it
    to midnight. Without the guard, posting `12:00:00` read back as `11:59:59` and re-posting it
    walked it a second per cycle — the very drift `normalizeTermEnd` exists to absorb, one field
    over. A non-midnight instant is now reported exactly as stored.
    Storage stays exclusive — `next_period_start === current_period_end` is what all the period
    arithmetic depends on. Guarded by `verify:billing-mode` §B2.
- **2026-08-08** — **Cancellation audit: four more defects** (migration 0160). Follow-on from the
  scheduled-cancellation work below, from auditing the rest of the cancel surface.
  1. **A cancelled subscription kept its full MRR.** `recomputeSubscriptionMrr` specifies
     `CANCELLED → 0` and says to call it after the status write — and _none_ of the three writers
     of `status='cancelled'` did (`cancelSubscription`, the renewal term-end branch, the dunning
     give-up). Measured: a 5000/mo subscription reported `cancelled 5000n` on both paths. Since
     `subscriptions.mrr` became the single authority (the 10.3× fix), that meant the API and the
     detail page reported live MRR for a churned subscription, `mrr[gt]=0` returned it as
     revenue-bearing, and the **shadow reconcile mismatched on every cancellation**.
     Business totals were unaffected (`getBusinessMetrics` sums LIVE only, and
     `reportingMrrBySubscription` re-derives churned rates) — which is why it survived: the totals
     were right while every row was wrong. Fixed at all three sites; 0160 backfills.
  2. **`end_of_term` cancel on a PAUSED subscription silently never happened.** The renewal scan is
     `status IN ('in_trial','active')`, so the flag was never acted on — measured 30 days past term
     end, still paused, with the API reporting plain `paused` (non_renewing folds only over
     `active`). Now refused with a message naming the two options that _do_ work. `specific_date`
     is unaffected — the scheduled-changes pass acts on any status — and that is asserted.
  3. **The dunning cancel emitted `status: 'canceled'`** (one l) where the stored enum and every
     other emitter use `'cancelled'`, so a webhook consumer switching on that field mishandled
     exactly the involuntary churn it most wants to catch.
  4. **The immediate-cancel side-effects could 500 an already-cancelled subscription.** Steps 3–5
     (cancellation credit, AR handling, refundable refunds) run in their own transactions after the
     status write; a throw skipped the audit row and returned 500, and the retry was refused by the
     `already cancelled` guard — so the customer's credit could never be issued through the API.
     `writeOffInvoice` was unwrapped, so one bad invoice stranded the rest of the loop. Each step is
     now isolated and reported: the cancellation stands, the audit row is always written, and a
     `warnings[]` array (surfaced on the API response and logged) names what did not complete.
     **Not fixed:** genuine atomicity across cancel+credit — every helper opens its own
     `withTenant`, and the gateway-touching steps cannot sit inside a transaction anyway.
     Also, from checking MRR on the _change_ path (verified correct — upgrade, downgrade, cadence
     change, quantity, custom price, discounted and deferred-invoicing all restate it): a plan-swap
     **downgrade on a term that was never invoiced corrupted the subscription**. The unused-time credit
     exceeded the new plan's charge, the no-creditable-invoice fallback booked it as negative invoice
     lines, and `createInvoiceFromLines` threw a bare `Error` _after_ the apply transaction had
     committed — leaving the subscription swapped onto the cheaper plan, MRR restated, with no invoice
     and no credit note, behind a 500. The decision moved **inside** the apply transaction: a term with
     no invoice at all owes nothing, so the credit is dropped and the new plan bills alone; an invoice
     that exists but cannot be credited (pending/voided) raises a `ProrationError`, which rolls the
     change back and returns a 400 naming the reason. Covered by GR7a–GR7c in `verify:subscriptions-v2`.
- **2026-08-08** — **Scheduled cancellation: made visible, and made its failures visible**
  (migration 0159). Two defects with one shape — a cancellation nobody could see.
  1. A cancellation could be scheduled two ways and only one was reflected on the subscription.
     `end_of_term` sets `cancel_at_period_end`, which derives `non_renewing`; `specific_date` wrote
     only a `scheduled_changes` row, so the subscription serialized as plain `active` with
     `canceled_at: null` — the status pill said Active, the `cancel_at_period_end` filter missed it,
     and the pending cancel showed only in the `/scheduled_changes` sub-resource. New
     `subscriptions.cancel_scheduled_at` (a column, not a join — `serializeSubscription` runs per row
     on lists, and the filter needs something indexable) now feeds `apiSubscriptionStatus` and
     `canceled_at`, with the scheduled instant taking precedence over the term-end fallback.
     `scheduleChange` owns the write so the invariant holds for every caller; `cancelScheduledChange`,
     `removeScheduledCancellation`, `reactivateSubscription` and an immediate cancel all clear it.
  2. `removeScheduledCancellation` knew only about the flag and threw _"Subscription has no scheduled
     cancellation"_ at a subscription that visibly had one — a `specific_date` cancel was creatable
     through `/cancel` but undoable only through `DELETE /scheduled_changes/{sch}`. It now withdraws
     the executing row **in the same transaction** as the column clear (a flag clear alone would be
     cosmetic — the clock acts on the row), and so does `reactivate`.
  3. `applyDueScheduledChanges` isolated per-row failures with a bare `catch {}`: no log, no
     `TickError`, and the only counter was successes — so 3-of-8 applying was byte-identical to
     3-due-3-applied and the ops table drew a healthy green line. The row stayed `scheduled` and was
     re-scanned every 60s forever. A scheduled **cancel** failing that way meant the customer was
     never cancelled and kept being billed, with the complaint as the first signal. Failures are now
     recorded (`attempts` / `last_error` / `failed_at`, terminal `status='failed'` after 5 attempts),
     logged, and pushed into `clock_ticks.errors` like the renewal pass's. `applyOne` returns an
     outcome instead of throwing-or-nothing: `moot` (intent already satisfied) closes as applied,
     `unapplicable` goes terminal immediately — the `change` type had no status guard at all, so
     against a cancelled subscription it threw into the swallow and spun forever.
     Also: `cancel_at` in the past is rejected (it was accepted, reported as "scheduled", then fired a
     minute later as a late immediate cancel); the due scan is ordered + capped at `TICK_SCAN_LIMIT`
     with a `capped` flag like the renewal pass; `nextTerm` returns null only when the scheduled cancel
     actually precedes the term end (a cancel scheduled beyond it genuinely does renew first).
- **2026-08-08** — **The MRR discount rule changed**, closing the KNOWN GAP that
  `foreverDiscountsForMrr` carried. A discount nets into MRR when it **spans more than one billing
  period**, not only when it is perpetual — so a repeating coupon and a limited-period discount both
  restate the rate, and only a one-off leaves it alone. Renamed to `discountsForMrr` /
  `netMrrForDiscounts`. The rule reads a new `applied_coupons.total_periods` (migration 0158, null =
  unlimited) rather than `remaining_periods`: the latter counts DOWN, so a 6-period discount in its
  last period reads 1 and would stop netting one renewal early — and the cached column would need
  recomputing on every renewal to track the countdown. Because `total_periods` never moves, the
  column only has to be recomputed when a discount **starts or ends**, which is what made this
  tractable; `consumeDiscount` and `restoreDiscountPeriod` now recompute on exactly those edges.
  `discountsForMrr` falls back to the coupon's `duration_type` when `total_periods` is null, so a
  row written before the column existed cannot read a `once` coupon as forever.
- **2026-08-08** — `recomputeSubscriptionMrr` stores **0 for `cancelled`** as well as `in_trial`.
  The importer had always written 0 for a cancelled subscription, so an engine-cancelled
  subscription and an imported one disagreed on the same screen. Reports that
  need the rate a churned subscription _carried_ re-derive it from its surviving items — see
  `reportingMrrBySubscription` (metrics/mrr.ts).
- **2026-08-07** — **The change screen finally has its `Invoicing Options`: `/change` takes
  `invoice_immediately`.** `changeSubBody` accepted only `changes` / `at` / `reset_term`, so the
  whole section was un-buildable and the page silently invoiced every change. `false` now books the
  SAME proration lines as `unbilled_charges` — through `addAdHocCharges`, the one booking path, not
  a second `unbilled_charges` writer. Three things that path had to learn, each a real hole:
  - `markItemsBilled` on the DEFERRED branch (it only ever reached `createInvoiceFromLines`). A
    change onto a `one_time` price charges the fee in full; queue it without consuming the cycle and
    the renewal folds the unbilled charge in **and** rates the item again — the one-off billed twice.
    Bumped inside the insert's transaction, same rule as the invoice path.
  - an explicit `entityType`, because these lines carry PLAN and ADD-ON price ids and the ad-hoc
    derivation (`priceId ⇒ charge_item_price`) would have filed a plan proration under the wrong
    entity type. Resolved from the product kind → `plan_item_price` / `addon_item_price`. No migration:
    `entity_type` is a plain text column (0134) with no CHECK.
  - a refusal when the queued set nets NEGATIVE (a term reset with no prior invoice to credit
    against). The immediate branch already refuses it — `createInvoiceFromLines` will not mint a
    negative invoice — and deferring would push the failure onto a later renewal instead.
    **Omitting the field still means "invoice now".** `businesses.default_invoice_immediately` is
    advertised on Settings → Billing LogIQ → Update subscription as governing exactly this, and
    `changeTermEnd` does read it — but it ships `false`, so consulting it here would silently turn
    every existing caller's proration invoice into an unbilled charge (twelve `verify:*` scripts, the
    detail page's quick change). Filed as a defect rather than
    flipped blind; it needs those suites re-run. The dashboard sends the value explicitly either way.
    Credits are unaffected on both branches: a downgrade's credit note and a term reset's unused-time
    credit are issued immediately — only the CHARGE moves. **UI:** the section preselects
    _Invoice immediately_ (what the engine does when the field is omitted), and
    refuses "add to unbilled charges" combined with ADDED lines — those go through `POST /items`, which
    has no invoicing option, so half the edit would defer and no single figure could state the outcome.
    Same treatment the page already gives a scheduled change with added lines. Threading the option
    through `POST /items` would remove the restriction.
- **2026-08-06** — **`dunning_config.skip_retries_for_hard_failures`** (default `true` = unchanged
  behaviour). Settings → Dunning offers "Skip retries for hard failures"; we had
  modelled only the ON case, so a site running it OFF retried hard declines on its custom schedule
  while we terminated dunning immediately. Found by transcribing a live site's config for the shadow
  run (`docs/shadow/`), where it would have produced a systematic dunning mismatch attributable to
  a setting we did not have. Honoured in `planFailureRearm`'s FIXED branch only — smart mode drives
  disposition from the decline code itself, which is its entire purpose.
- **2026-08-05** — **Lifecycle audit coverage went from one action to twelve (0149).**
  `subscription.cancel` was the ONLY audited subscription action; create, activate, renew, change,
  update, pause, resume, reactivate, remove-scheduled-cancellation, change-term-end, change-trial-end
  and end-trial now all write rows with full before/after snapshots — on the resource whose
  lifecycle history matters most. New `modules/subscriptions/audit.ts` holds the shared
  wrapper (`auditSubscription`, `auditedSubscriptionUpdate`, `subscriptionSnapshot`,
  `snapshotSubscriptionById`); hand-writing the pattern at fourteen call sites is how the
  changed-field map and the snapshot drift apart. Snapshots include the ITEMS: a plan or quantity
  change IS an item change, so a row-only snapshot would report a quantity increase as no change at
  all. Every before-snapshot is taken inside the mutating transaction and BEFORE the writes (in
  `proration.ts`, after the optimistic lock — so a conflict leaves no audit row and the context is the
  state the change actually applied to). `pauseSubscriptionWithOptions` delegates to
  `pauseSubscription`, so only the latter audits; `resumeSubscriptionWithOptions` does NOT delegate and
  audits separately. `renewal.ts` audits activation and renewal even though the billing clock performs
  them — actor `billing_clock`, source `scheduled_job`, IP null.
- **2026-08-05** — `next_billing_at` no longer reports a day-anchored trial's end raw. A day-anchored
  trial deliberately ends at the LAST moment of its final day (…T23:59:59 local —
  `alignTrialEnd`), but this field names the instant the invoice is _raised_: the first instant of the
  next term, one second later, which is also what the trial-end renewal writes as the new term start.
  Reported raw, a trialing legacy subscription showed "Next billing on 03-Aug 23:59" for a term that
  begins 04-Aug 00:00. The trial branch now goes through `normalizeTermEnd`, so `TermEndConvention`
  carries `timezone` alongside `anchorGranularity`. Exact midnights and instant-anchored businesses
  are untouched; `current_period_end` keeps its inclusive read convention.
- **2026-08-05** — ✨ **A shorter-cadence item is now FOLDED into the subscription's cycle instead of
  refused** — the "billing cycle for addons" divisor rule. `cadenceMismatch` demanded an
  exact interval match, so a monthly add-on on a yearly plan was rejected outright; the item's period
  only has to **divide** the cycle, and it is then re-rated — ₹475/mo "Additional Connections" prints
  as **one unit at ₹5,700** on an `Aug 04 2026 – Aug 03 2027` period, next billing date a year out,
  not billed monthly. New
  `cadenceMultiple` + `alignSnapshotToCycle` (`catalog/pricing.ts`, beside `computeLineAmount`) do
  the work: at snapshot time the amount is scaled and the `interval`/`intervalCount` re-expressed on
  the subscription's cycle, with `cadenceMultiple` / `catalogInterval` kept for provenance. Because
  every downstream reader rates the snapshot, invoicing, `recurringChargeMinor`, proration, cycle
  caps and MRR all follow with no change of their own — and MRR's normalization turns ₹5,700/year
  back into ₹475/month rather than inflating 12×. Composition order matters:
  **differential/override supplies the rate → cadence multiple scales it → quantity**.
  - **The rule is one-directional.** A LONGER-cadence item (yearly add-on on a monthly plan) is
    still an error — the cycle would end before the item's period does, which is the original 12×
    overcharge the guard was written for (see the 2026-08-02 cadence entry). Non-divisors (5-month
    item, 12-month cycle) are refused either way, as is a cross-family pairing (day/week vs
    month/year), since a month is not exactly 30 days.
  - **Scaling is limited to flat/per-unit.** A tier table, package size or percentage has no
    unambiguous ×N, so those still require an exact match and say so in the refusal.
  - **Applied on every write path** — create, reactivate (which never had the cadence guard at all),
    `addSubscriptionItem` via `effectiveAddSnapshotTx`, and non-plan items on `changeSubscription` —
    plus their estimate mirrors. The PLAN item is deliberately never aligned: its own interval _is_
    the candidate new cycle, and the frequency-change/term-reset detection reads it.
  - **Known limitation, deliberate:** a plan frequency change is REFUSED while a folded item is on
    the subscription. The folded snapshot holds a per-cycle amount the new cycle invalidates
    (₹5,700 billed monthly is a 12× overcharge), and re-deriving every item mid-change fights the
    immutable-snapshot design — so it fails loudly with instructions instead. Re-alignment is
    tracked in PROGRESS. Mandatory auto-included add-ons also still resolve on an exact cadence
    match only (`resolveMandatoryAttachedItems`), so a mandatory add-on priced solely on a shorter
    cadence is skipped/rejected as before rather than folded.
  - Cover: 8 assertions in `verify:estimates` (fold amount, snapshot shape, MRR non-inflation,
    estimate == billed, both refusal directions) + 2 in `verify:addons-charges` for the add-item
    path, alongside the three pre-existing longer-cadence rejection cases, which still pass unchanged.
- **2026-08-04** — 🟠 **Day-anchored terms drifted off local midnight in five places.** Reported from
  the UI: a midnight-aligned IST business showed _trial ends 22:26 · next billing 03-Sept 22:26_.
  The invariant this module owes a day-anchored business is that **every term boundary is a local
  midnight** — and five writers of those boundaries did not ask `billing-mode.ts` about it:
  1. `editTrialEnd` — both paths. `immediately` stamped raw `now`; the explicit-date path skipped
     `alignTrialEnd`. `immediately` now FLOORS to the start of the local day the trial is ended in
     (not the next midnight: the operator asked to activate and bill now, so `now` must fall inside
     the term it opens; whole-day granularity then makes today the first billed day), clamped to
     `trial_start`.
  2. `calendarAnchorFor` — a customer's billing date ("the 15th") was built at **00:00 UTC**, i.e.
     05:30 IST, and `advancePeriod` preserves the time of day, so the offset was permanent, not a
     one-off: every renewal off midnight and every whole-day proration credit a fraction of a day.
     It now takes the business timezone and returns local midnight.
  3. `advancePeriod` — re-aligned on the UTC calendar against `billing_anchor_day`, which was itself
     read as a UTC day-of-month. On a +05:30 business a term starting 4-Aug 00:00 IST is 3-Aug 18:30Z,
     so the anchor said "the 3rd" and an unaligned start renewed a DAY EARLY. The anchor day is now
     the LOCAL day of the month and the advance re-aligns on the local calendar
     (`midnightOnDateInTz` / `localDatePartsInTz`, new in `platform/clock.ts`). The `mode` parameter is
     **required** so no call site can fall back to UTC by omission. UTC businesses: unchanged.
  4. `reactivateSubscription` — an incoming `trial_end` bypassed `alignTrialEnd` (the same day-early
     bug as #1), and `trial_start`/`start_date` were stamped raw while the term used the aligned start.
  5. The trial→active conversion (`renewal.ts`, both the clock path and the elapsed-trial recovery in
     `startFutureSubscriptions`) — a day-anchored trial deliberately ends at 23:59:59 local, so the
     term it opened started a second before midnight and every later boundary inherited it. The
     boundary now rounds up via `normalizeTermEnd` (an exact midnight passes through, so ordinary
     renewals are byte-identical), `estimateRenewal` mirrors it, and `healUnbilledFirstPeriods`'
     `current_period_start = trial_end` signature gained a `+ 1 second` arm so that heal can still fire
     on a day-anchored business.
     Also: `start_date` is stored ALIGNED at create and at reactivate, so a `future` sub no longer sits
     unstarted over a term of its own that has already begun, and the heal's `current_period_start =
start_date` arm can match at all on a day-anchored business.
     **Existing data:** rows created before this on a non-UTC business hold the old UTC-day anchor (one
     short of the local day they meant) and therefore now re-anchor a day earlier. Reseed dev, or
     recompute `billing_anchor_day` from `current_period_start`; not run here — it is a data decision.
     Gate: `verify:billing-mode` Part **B3** (both trial-end paths land on midnight; the click instant
     falls inside the term it opened; millisecond mode still exact) and Part **B4** (a billing-date anchor
     is local midnight on the day asked for, the day-31 clamp re-aligns on the LOCAL calendar, and a UTC
     business is untouched).
- **2026-08-04** — 🟠 **The new-subscription estimate under-priced differential add-ons**, so the
  create page previewed an add-on at **0.00** while the subscription it booked charged the real
  amount. A per-plan add-on price is a catalog list price of **0** with the amount
  held per (add-on, plan, currency, interval); `createSubscription` has resolved that for explicitly
  requested add-ons since CAT-7, but `estimateNewSubscription` kept its own copy of the rule
  that covered only the **mandatory** auto-included ones and rated everything else straight off the
  catalog row. On an imported catalog (every add-on list price 0, ₹475/mo in a differential)
  the rail, the "See breakdown" dialog and the confirm dialog all agreed on ₹0.00 and all three were
  wrong — and the tax base was short by the same amount. The rule now lives in ONE exported helper,
  `applyExplicitDifferentials` (`catalog/service.ts`), called by both paths, and the estimate rates
  through `ratableFromSnapshot(snapshotPrice(…))` — the same snapshot the booked item freezes —
  instead of the bare catalog price. Two adjacent holes closed with it: an explicit
  `unit_price_minor` was dropped by all three layers of the estimate path (form → action → route,
  though the route already parsed it), and the estimate now mirrors create's overridable-model /
  non-negative guards so a preview refuses what the confirm would refuse. Verified on the imported
  catalog: differential fills in (₹475), an explicit override still wins over it, negative rejected.
- **2026-08-04** — 🟠 **The NON-RESET change path stopped prorating a `one_time` item**, closing
  note **(c)** of the 2026-08-03 "one_time fee charged ONCE, refunded NEVER" entry — the fifth and
  last path that decided the one-time rule for itself. `changeSubscription`'s `!resetTerm` branch
  time-sliced BOTH sides of every changed item, keyed on nothing but "is this an item": a 5000
  setup fee re-priced or re-quantified at the midpoint of a 31-day term credited ~2500 of "unused
  time" it never bought and charged ~2500 of a fee that is not a slice of anything. The decision
  now lives in ONE exported pure function, `nonResetItemProration` (`proration.ts`, next to
  `prorate`): the OLD side of a `one_time` item is credited **nothing**, unconditional on
  `cycles_billed` (an already-paid fee is not unused time; a never-billed one has nothing paid to
  hand back), and the NEW side is charged the **full** fee while its single cycle is unspent and
  nothing once it is spent — gated on the shared `isCycleCapExhausted` (`catalog/pricing.ts`), not
  on the price type, so a fee attached but not yet invoiced is still legitimately owed in full.
  Recurring items are byte-identical, including `unitAmountMinor` (the one-time line divides by
  quantity like the reset branch does; the recurring line keeps its long-standing unit == amount).
  **`estimateChange` calls the same function** rather than mirroring it. Its non-reset loop was a
  hand-written copy of the same arithmetic, so fixing only the booking would have re-opened the
  preview-vs-booking drift this pair exists to prevent (a 5000 one-off would have previewed 2500
  against a 5000 charge — precisely the shape of the mid-term-add bug fixed 2026-08-03).
  The charge carries the three obligations every one-off raised outside
  `planSubscriptionPeriodInvoice` owes: the plain `priceLabel()` (never "… - Prorated Charges"),
  `kind: 'one_time'`, and the item id on the line's `oneTimeItemId` so
  `createInvoiceFromLines({ markItemsBilled })` records the consumed cycle **inside the invoice
  transaction** — otherwise the next renewal sees a never-billed one-off and bills it again. That
  field already existed for the term-reset line; it is simply no longer reset-only.
  One edge, decided by copying rather than re-reasoning: a price SWAP that changes an item's TYPE is
  judged by the POST-change type against the item's existing `cycles_billed`, so a recurring item
  that has billed a cycle and is swapped onto a `one_time` price is charged nothing. That is the
  term-reset charge loop's rule verbatim.
  Gate: 8 new cases in `test/unit/proration.test.ts` (pure, no DB), **confirmed RED first** — with
  the one-time rule disabled 6 of the 8 fail, reporting the pre-fix `2500` on both sides of a 5000
  fee at the term midpoint. `pnpm typecheck` clean; `pnpm vitest run test/unit` 147/147.
  **Note (b) of the same entry — the `one_time` MANDATORY attached add-on — was investigated and is
  NOT REAL; no code was changed for it.** The claim needs a mandatory attached item with
  `chargeOnce = false` resolving to a `one_time` price, and `resolveMandatoryAttachedItems`
  (`catalog/service.ts`, price selection unchanged since 2026-07-04) cannot produce that pair: a
  one_time price is picked only on the `chargeOnce` branch, and `chargeOnce = false` matches against
  `recurringRows`, which is filtered to `type === 'recurring'` and yields nothing at all when the
  add-on has no recurring price (skipped, warned and audited). `changeSubscription`'s insert loop
  also `continue`s on `chargeOnce` before that. So every item it auto-inserts is recurring, carries
  no implicit one-cycle cap, and is correctly re-rated each renewal — there is no unrecorded cycle.
  The proof is written into the loop as a comment, with what it would owe if that selection ever
  changes, so it is not re-investigated a third time.
- **2026-08-04** — 🟠 **A trialing subscription now STORES `mrr = 0`, so the screen, the API, the
  filter and the sort finally agree.** MRR is `$0.00` for an `in_trial` subscription; we reported the
  full plan rate. The dashboard cell had been patched to
  render `0.00` for `in_trial` — but `mrr` is **filtered and sorted in SQL** against the cached
  column (`LIST_FILTERS` / `LIST_SORTS`), so `mrr[gt]=0` still returned rows the screen showed as
  `0.00` and a DESC MRR sort ranked a trialing 107900 **above** an active 12900 by a number nobody
  could see. Zeroing it in `serialize.ts` would not have fixed that either: the SQL never sees the
  serialized value. So the rule lives on the **write** side, in one place —
  `recomputeSubscriptionMrr` reads the row's `status` and persists 0 when it is `in_trial`, which
  means every existing caller (coupon apply/remove, `addSubscriptionItem`/`removeSubscriptionItem`,
  `changeSubscription`) inherits it without knowing it exists. The two paths that write `mrr` inline
  because there is no row to update yet — `createSubscription` and
  `reactivateSubscriptionWithOptions` — got the same one-line branch. `serialize.ts` stays a straight
  read of the column, with a comment saying why nothing may be adjusted there.
  **The load-bearing half is the conversion, not the zero.** A trial that converts must be restated
  to the real rate at that instant, or every converted subscription reports 0 MRR forever — worse
  than the bug being fixed. `renewSubscription` (renewal.ts) now calls the recompute **inside the
  same transaction as the status write**, immediately after it, so `active` and the real rate commit
  together (the recompute reads the status off the row, so the ordering is the whole trick).
  `startFutureSubscriptions` got it too, and needs no direction-specific rule: it crosses the trial
  boundary both ways (`future`→`in_trial` must go to 0, `future`→`active` after a trial elapsed
  during clock downtime must be the real rate) and the status-driven recompute answers both. Three
  more transitions out of a trial-era 0 were closed the same way — `resumeSubscription`,
  `resumeSubscriptionWithOptions` (`pauseSubscription` has **no** status guard, so a sub can be
  paused mid-trial) and `reactivateSubscription` (a sub cancelled mid-trial). Each carries the
  recomputed value onto the row it returns, because the recompute runs after `.returning()` and the
  caller serializes that object.
  **What each status stores** (unchanged except `in_trial`): `active` → the real monthly-normalized
  rate, net of `forever` coupons; `in_trial` → **0**; `non_renewing` → the real rate (it is stored
  `active` + `cancel_at_period_end`, and it _is_ still generating revenue until term end);
  `paused` / `cancelled` → whatever was last written, never zeroed on the transition; `future` → the
  rate it will bill at (it has not started, but nothing was asked to change there, and the start pass
  now restates it either way). Two inconsistencies found and deliberately **not** changed, because
  both would move a reported number: (a) the list renders `—` for `non_renewing`, `paused`,
  `cancelled` and `future`, so an `mrr[gt]=0` filter still returns rows the screen leaves blank — the
  same class of bug as this one, but for `non_renewing` the honest fix is to SHOW the figure (it is
  still earning) rather than to zero storage, so it needs a ruling per status, not a sweep; (b) the migration importer (`migration/import.ts`) still stores the full rate for an
  imported trial (it only zeroes `cancelled`), so the two write paths now disagree — and it cannot
  be changed alone, because `migration/reconcile.ts` builds its expected-MRR total from source subs
  **including `trialing`** and would start reporting a false shortfall.
  Gate: `verify:trial-change` § F (five-layer agreement) + § G (the conversion, driven by the **Time
  Travel** — nothing but the clock moves), 20 new checks. **RED first, both halves separately:**
  with the zero disabled, `stored=107900 api=107900 … mrr[gt]=0 hit=true … sort DESC rank trial=2
active(12900)=4` (9 checks red); with only the conversion recompute disabled,
  `F conversion: status=active stored=0 api=0 (expect 107900)` and `G … mrr=0 (expect 5000)`
  (6 checks red). Also proven over real HTTP on :4000 — `GET …/subscriptions/:id` → `mrr: 0`,
  `?mrr[gt]=0` excludes it, `?mrr[is]=0` includes it, `?sort_by[desc]=mrr` puts every trial at 0
  below the cheapest active row. Suites green: `trial-change`, `renewal`, `renewal-matrix`,
  `subscriptions-v2`, `subscription-ops`, `addons-charges`, `change-atomicity`, `coupons`,
  `time-travel`, `metrics`, `migration`, `e2e`, `list-pagination`,
  `scheduled-changes`, `proration`, `invoices-v2`, `customers`, `lifecycle`, `multicurrency`;
  `openapi:coverage` 201/201, `verify:ui` 5×0.
  **Existing rows need a one-off backfill — not run here (operator decision).** 70 `in_trial` rows
  in the local DB still hold a plan rate (all 70 are > 0):
  `UPDATE subscriptions SET mrr = 0 WHERE status = 'in_trial' AND mrr <> 0;` — it bumps
  `resource_version` + `updated_at` via the `bump_row_version` trigger, which is correct (the
  resource did change) but will 409 an in-flight optimistic lock; add `, updated_at = updated_at` to
  keep the timestamp (0144 makes the trigger respect an explicit value). Until it runs, those rows
  over-report in all five layers _consistently_ — which is why the display coercion was removed
  rather than kept as a mask.
  **Consumers of the cached column, and whether a business number moves:** the subscriptions list
  (cell + filter + sort), the subscription detail "Total MRR" row, the customer detail "MRR" row and
  its per-subscription "MRR" row (`getCustomerFinancials` sums the column over `active`+`in_trial`)
  — all now report 0 for a trial, which is the point. `deriveEffectiveCurrency` reads the same
  query's `currencyWeight`: a trial still _pins_ its currency (the key is added unconditionally) but
  now weighs 0, so a customer holding a trial in one currency and an active sub in another resolves
  to the active one — arguably more correct, but it is a behaviour change. **`/metrics`, the home KPI
  strip and the metrics page do NOT read this column** — `computeBusinessMetrics` and
  `metrics/analytics.ts` rate items directly (the column is only an analytics fallback for item-less
  imported rows), so no MRR/ARR/ARPU/CMRR figure changes. `migration/reconcile.ts` does read it — see
  (b) above.
- **2026-08-03** — 🟢 **`estimate.ts` stopped re-deriving the one-time cycle-cap rule in THREE
  places and calls the shared `isCycleCapExhausted` (`catalog/pricing.ts`) in all of them** — the
  fifth+sixth+seventh path this rule has to hold for (see the invariant above; the other four are the
  renewal planner, a mid-term add, a term reset, and a removal — all in `proration.ts`/`items.ts`/
  `invoicing/service.ts`). Landed in two passes the same day:
  1. The **in-trial branch** of `estimateChange` used to gate on `item.billingCycles != null &&
item.cyclesBilled >= item.billingCycles` only — no implicit cap for a `one_time` snapshot with
     no explicit `billing_cycles`. Harmless TODAY only because an in-trial item's `cycles_billed` is
     always 0 (both versions agree), but a second hand-written copy is exactly how a preview quietly
     stops matching the booking the moment that stops being true.
  2. Once `proration.ts`'s TERM RESET branch stopped re-charging/crediting an already-billed one-time
     fee (see the entry below, same day), the **preview disagreed with the booking on money** — the
     exact defect this pair exists to prevent. `estimate.ts`'s reset branch was charging **and**
     crediting the fee where the booking now does neither, so a plan-swap preview was off by the fee
     TWICE. Fixed to mirror the booking exactly: the reset credit loop skips a `one_time` item
     unconditionally (no unused time to hand back), the reset charge loop gates a `one_time` item on
     `isCycleCapExhausted` (charged only while its one cycle is unspent), and the non-reset `removes`
     branch previews **zero** credit for removing a one-time item (billed or not — an invoiced one-off
     is refunded only by an explicit credit note, never by detaching the item).
     `itemCycleCap`/`isCycleCapExhausted` live in `catalog/pricing.ts` (where `PriceSnapshot` already
     lives) as the one shared home — every caller (`invoicing/service.ts`'s renewal planner,
     `proration.ts`'s reset branch, and all three `estimate.ts` branches) now reads the same function;
     `invoicing/service.ts`'s own inline expression was the last copy and has been switched over too
     (see `invoicing/README.md`'s matching entry). Verified preview == booking for: a mid-term one-time
     add (5000, `verify:addons-charges`), an in-trial one-time add (case H, `verify:trial-change` — the
     in-trial preview includes the fee at full price, and the trial-end conversion invoice matches it
     exactly), a recurring mid-term add (stays prorated, not full price), a TERM RESET over a
     subscription carrying an already-billed one-time fee (preview net 10000 == booked invoice 11000
     minus booked credit 1000, `verify:addons-charges`, scaled version of `verify:change-atomicity`
     case H's 480000/20000), and a removal of an already-billed one-time item (preview credit 0 ==
     booked credit note `null`). All green; `verify:estimates`, `verify:proration`, `verify:proration-
matrix`, `verify:subscriptions-v2`, `verify:renewal`, `verify:invoices-v2` and
     `verify:change-atomicity` (cases H/I) unaffected.
- **2026-08-03** — ✅ **A `one_time` fee is charged ONCE and refunded NEVER by a composition edit.**
  Two money defects, the last two of the "one-time price as a subscription item" class, closing notes
  **(a)** and the "Adjacent, NOT fixed" paragraph of the entries below.
  **(1) A TERM RESET re-charged an already-paid one-time fee AND credited its unused time.**
  `changeSubscription`'s reset branch has two loops — credit the unused time of ALL current items,
  charge the FULL new-term price for ALL post-change items — and both keyed on nothing but "is this
  an item". A `one_time` fee is neither: it was already invoiced, and it never bought a span of time
  to have a remainder of. So a plain monthly→yearly swap on a subscription carrying a 3000 setup fee
  produced **two** wrong money lines from one plan change — invoice 483000 instead of 480000, credit
  note 23000 instead of 20000. Neither line is owed. The credit loop now skips a `one_time` item
  **unconditionally** (an already-paid fee is not unused time; a never-billed one has nothing paid to
  credit), and the charge loop skips it only when its single cycle is **spent**, gated on the SHARED
  cap rule `isCycleCapExhausted` (`catalog/pricing.ts`) — not on the price type — so a fee attached
  but not yet billed (a signup that deferred its first invoice) is still legitimately charged in
  full. When the reset DOES charge one, it carries the same obligations `addSubscriptionItem`'s
  one-time branch carries: the plain `priceLabel()` (never "… - Prorated Charges"), `kind: 'one_time'`,
  and — the part that is easy to miss — `markItemsBilled` on `createInvoiceFromLines`, so the cycle it
  consumes is recorded **inside the invoice transaction** and no later renewal bills the fee again.
  The ids are collected from the POST-filter `billableLines`, so a dropped mandatory-add-on line can
  never mark an item the invoice didn't bill. Recurring items are byte-identical on both loops.
  **(2) Removing a `one_time` item now credits NOTHING — a money ruling, recorded in the code.**
  An invoiced one-time fee is not refunded by detaching the item. The operator's route to giving a one-off back is an
  explicit credit note / refund, a deliberate act with its own reason code, not a side effect of
  editing the subscription's composition. Before this, `removeSubscriptionItem` time-prorated the
  credit for every item, so once the add path started charging a one-off in full (entry below) a
  mid-term add-then-remove **lost the customer money**: 5000 charged, ~2500 handed back halfway
  through the term. Deliberately unconditional on `cycles_billed`, and the never-billed half was the
  worse of the two — with no invoice line for the fee's price, `targetInvoicePublicId` resolves to
  null and the credit falls back to the newest live invoice, i.e. it would have been funded out of
  the PLAN's payment. A RECURRING item's removal credit is untouched.
  Gate: `verify:change-atomicity` cases **H** (billed fee, term reset) and **I** (the control: an
  UNBILLED fee is still charged in full and its cycle recorded), `verify:addons-charges` +8 checks
  (billed removal, and the in-trial unbilled removal). **Confirmed RED first:** pre-fix H reported
  `invoice=483000 lines=[usd-year-per_unit:480000 onboarding-setup:3000] credit=23000` and the
  removal reported `charged=5000 credit note=2500 notes 0→1 balance=2500`; green after,
  `invoice=480000 lines=[usd-year-per_unit:480000] credit=20000` and `credit note=none balance=0`.
  The optimistic lock and the one-transaction atomicity on both paths are untouched, and no gateway
  call moved inside a transaction. Suites green: `change-atomicity`, `addons-charges`, `proration`,
  `proration-matrix`, `trial-change`, `subscriptions-v2`, `credit-notes`, `renewal`,
  `scheduled-changes`, `billing-mode`.
  **Known, unfixed (reported, not guessed at):**
  (a) **`estimateChange`'s term-reset preview still credits and charges the fee** (`estimate.ts`,
  owned elsewhere), so a plan-swap preview now drifts from the booking by the fee **twice** — a
  spurious credit line and a spurious charge line — and its `removes` branch still previews a
  prorated credit for a `one_time` item. It needs the same three edits: skip `one_time` in the reset
  credit loop, gate the reset charge loop on `isCycleCapExhausted` (it already imports it for the
  in-trial branch), and preview 0 for a removed `one_time` item.
  (b) A **`one_time` MANDATORY attached add-on** auto-inserted by a term reset (`chargeOnce=false`, so
  it is not skipped) is charged in full and its cycle is NOT recorded — the insert's item id only
  exists inside the apply transaction, after the lines were built — so a renewal would bill it again.
  Same class as the fixed one, different (and much narrower) trigger.
  (c) The NON-reset proration path still prorates a change to a `one_time` item's own price/quantity.
  Out of the brief's scope, and no shipped UI reaches it, but the arithmetic is wrong there too.
  (d) `invoicing/service.ts`'s planner still spells the cap rule out inline rather than calling
  `isCycleCapExhausted`, which its own doc comment claims is the single source of truth. One-line
  change in a file this work did not own.
  **→ ALL FOUR CLOSED, re-verified against the code 2026-08-17** (a sweep of every severity-marked
  entry here — the notes had gone stale, which is its own hazard: the next reader re-chases finished
  work).
  (a) `estimate.ts` skips `one_time` in the reset credit loop (`(oldSnap?.type ?? r.price.type) ===
'one_time'`), gates the reset charge on `isCycleCapExhausted`, and previews 0 for a removed
  `one_time` item — all three edits present. (b) is **unreachable by construction**, and now says so
  in code: `resolveMandatoryAttachedItems` matches a `one_time` price only on the `chargeOnce` branch
  (`catalog/service.ts`), and with `chargeOnce = false` the match comes from `recurringRows` (filtered
  to `type === 'recurring'`), so every snapshot the reset inserts is recurring — `proration.ts`'s
  mandatory loop carries the reasoning plus what it would owe if that selection ever changes.
  (c) the non-reset path now routes through the shared **`nonResetItemProration`** (`proration.ts`),
  which credits a `one_time` item nothing and charges it in full while its single cycle is unspent.
  (d) `planSubscriptionPeriodInvoice` calls `isCycleCapExhausted`; the inline copy is gone.
- **2026-08-03** — ✅ **A mid-term one-time add now reports the billing cycle it consumed**, closing
  note **(b)** of the "one-time price added mid-term" entry below (the fee was re-billed by every
  renewal). The cap itself lives in `invoicing/` — a `one_time` snapshot now carries an implicit
  one-cycle cap in `planSubscriptionPeriodInvoice` — but that cap gates on `cycles_billed`, and
  `addSubscriptionItem` raises its charge OUTSIDE the planner (it must: the charge collects from a
  gateway and cannot be held inside a transaction), so it alone knows the cycle was spent. It now
  passes `markItemsBilled: [item.id]` to `createInvoiceFromLines`, which increments `cycles_billed`
  **inside the invoice transaction** — the fee and the record that it was charged commit together, so
  a crash between them cannot re-bill the customer. Only the one-time branch passes it: a prorated
  RECURRING add is a slice of a cycle the renewal still bills, and consuming a cycle there would eat
  one from a legitimate `billing_cycles` cap. Proven RED with each half disabled in turn — with the
  planner cap alone, renewal #1 still billed `one_time:3000` (only #2 was clean), because the item
  looked never-billed. Nothing else in this module changed: the item stays attached, the trial
  deferral still defers (and the trial-end conversion invoice still bills the full fee — now
  asserted), and `removeSubscriptionItem`'s credit is untouched, so note (a) below still stands.
  Gate: `verify:renewal` Cases 3 + 4 (Time-Travel-driven), plus `verify:addons-charges`,
  `verify:subscriptions-v2`, `verify:invoices-v2`, `verify:proration`, `verify:trial-change`,
  `verify:billing-mode`, `verify:time-travel`, `verify:change-atomicity`, `verify:catalog-v2`,
  `verify:credit-notes`, `verify:scheduled-changes` all pass.
  **Adjacent, NOT fixed** (money semantics, and it lives in `proration.ts`): a **term-reset**
  `changeSubscription` charges the FULL new-term price for every post-change item, `one_time`
  included — so a plan swap re-charges a setup fee that was already paid (and credits its "unused
  time" as if it bought a span of time). A one-time charge must not be re-charged on a plan
  change. The renewal path is now correct; that path needs the same `snapshot.type` branch the add
  path got, plus a ruling on whether the reset credit should exist at all.
  **→ CLOSED by the entry above** ("A `one_time` fee is charged ONCE and refunded NEVER by a
  composition edit", same day): the reset credit loop skips `one_time` unconditionally and the reset
  charge loop gates on `isCycleCapExhausted`. Re-verified in `proration.ts` 2026-08-17.
- **2026-08-03** — **✅ money fix: `POST …/items` and `DELETE …/items/:item` now carry idempotency.**
  These two were the **only** subscription write routes without the `idempotency` preHandler and the
  `idempotencyOnSend` hook — a violation of locked decision #5, not a nice-to-have. Because
  `subscription_items` has only a _partial_ unique index (auto-included mandatory items), nothing
  else stopped a duplicate: measured before the fix, a retried `POST …/items` with the **same
  `Idempotency-Key` and the same payload** took the subscription from 1 item to 2 to **3** and its
  invoices from 1 to 2 to **3** — a real double-charge on a plain client retry. Both routes now use
  the same `{ preHandler: [authenticate, idempotency], onSend: idempotencyOnSend }` shape as
  `/change`. After: items `1→2→2`, invoices `1→2→2`, the duplicate replays the stored 201
  (`Idempotent-Replayed: true`, same `si_` id), and the same key with a _different_ payload is a
  **409**, matching `/change`. Two things worth keeping in mind next time:
  - **The pair is atomic — never ship one half.** The preHandler alone leaves the in-progress row
    un-finalized, so the key 409s forever and an honest retry can never land; the onSend alone
    finalizes a record nothing created. Worse than having neither.
  - **`DELETE` was never a double-_credit_ risk, and that is not why it needed this.** The second
    delete could not credit twice — the item was already gone, so it failed with `400 No such
subscription item`. The bug there was the _answer_: a client whose response was lost got told its
    request was invalid when the removal had in fact succeeded and issued its credit note. It now
    replays the 200 with the original `cn_` id. (Proven: credit notes `0→1→1` both before and after;
    only the second status changed, 400 → 200 replayed.)
  - Early returns inherit the same-day `platform/reply-guard.ts` fix and were re-checked over real
    HTTP on :4000 with a key present — 404 bogus business, 404 bogus subscription, 400 unknown item
    — each replied once, left the process alive, stored **no** `idempotency_keys` row, and did not
    poison the key for a retry.
    Locked down by `pnpm verify:idempotency-race` § C (40 checks, was 23). Suites re-run green:
    `addons-charges`, `subscription-ops`, `subscriptions-v2`, `change-atomicity`, `credit-notes`;
    `openapi:coverage` 201/201, `verify:sdk` PASS.
- **2026-08-03** — **Signup invoicing is now a real choice: `invoice_immediately` on create.**
  The create page carried _signup_ copy ("generate an invoice immediately, or add
  them to unbilled charges") over `create_pending_invoices`, which governs **renewals** — the field
  relabel landed earlier the same day; this is the missing backend so the control has something
  behind it. `createSubBody` takes `invoice_immediately` (boolean, defaults to true when omitted, so
  every existing caller is unchanged). `false` skips the first invoice entirely and queues the
  first period as a **pending unbilled charge** via the new
  `deferFirstPeriodToUnbilledCharges(...)`, which rides on the next invoice this subscription
  raises. Deliberately the same mechanism `resumeSubscriptionWithOptions` already uses for
  `charges_handling='add_to_unbilled_charges'` (`recurringChargeMinor` + `addAdHocCharge`), so
  "defer these charges" means one thing everywhere — and because `recurringChargeMinor` peeks the
  subscription's active coupons, a **signup coupon discounts the deferred amount too** (proven:
  3000, not 4000). Three things fall out of it and are easy to get wrong:
  - `chargesNow` must go false, or a card-less signup that collects nothing would still be refused
    by `assertChargeableForAutoCollect`. Verified both ways: deferred + auto-collect ON + no card →
    201; the same request invoicing now → 400.
  - the response carries `deferred_charge` instead of `latest_invoice` — a caller that only ever
    read `latest_invoice` would otherwise have no way to see that money is owed.
  - it is **not persisted**. It describes what to do at signup, not durable state, which is also
    why `businesses.default_invoice_immediately` is NOT consulted: that default governs
    change/term-change proration, and reading it here would recreate exactly the
    "screen says one thing, engine does another" bug the relabel just fixed.
    Known fidelity limit, shared with resume and written down so it isn't rediscovered: an unbilled
    charge folds back as a single `one_time`, taxable, tax-exclusive line with
    `productKind='charge'`, so a deferred plan period loses its product identity on the invoice it
    lands on and an item-scoped coupon applied _later_ will not match it. Fixing that means teaching
    `unbilled_charges` to carry the line's product kind + taxability (an invoicing-module change).
    Gated by 14 new `verify:subscriptions-v2` checks, and those run **over HTTP against the app booted
    in-process** (the verify:sdk trick) because both signup money decisions live in the route, not a
    service — the older `SIGNUPCPN` block only _mirrors_ the route's ordering. The new block includes
    the real end-to-end signup-coupon assertion (first invoice 3000, not 4000) and proves the deferred
    period rides on the next invoice at **8000, not 4000**.
- **2026-08-03** — **A one-time price added mid-term is charged in FULL, and a removal can no
  longer credit against a stale term.** Two defects in `items.ts`, both on the `POST /items` /
  `DELETE /items/:id` pair.
  **(1) ✅ `addSubscriptionItem` time-prorated a `one_time` price.** The amount was
  `billsAtTrialEnd(sub) ? 0n : prorate(…)` — a ternary whose only guard was the TRIAL case, never
  the price TYPE. A one-time price buys no span of time, so there is no unused remainder to slice:
  a ₹5,000 one-off added halfway through a monthly term billed **≈₹2,500**, and the line was
  labelled `"<price> - Prorated Charges"` with `kind: 'proration'` and a service period spanning
  the rest of the term. Every OTHER one-time path in the same file already billed the full amount
  as `kind: 'one_time'` — the activation-charge path, `triggerAttachedItemCharge`, and
  `addAdHocCharges` — so this was the lone dissenter, and it silently under-billed real money on
  every mid-term one-off. It now branches on `snapshot.type` (the price type frozen at attach by
  `catalog/pricing.snapshotPrice`, so the decision reads the same immutable record the amount is
  rated from — no new plumbing), charges the full computed amount, labels the line with the plain
  `priceLabel()` and `kind: 'one_time'`, and passes **no** `periodStart`/`periodEnd` (a one-time fee
  covers no service window, so `date_from`/`date_to` stay blank, and
  `fireActivationCharges` / `triggerAttachedItemCharge` already pass none). Recurring adds are
  byte-identical — the whole-day/exact proration window is untouched.
  **The TRIAL case deliberately still defers, and this is a choice, not an omission:** a one-time
  add during a trial charges nothing now and is billed in full by the trial-end conversion invoice.
  `planSubscriptionPeriodInvoice` rates every non-metered item from its snapshot and already labels
  a `one_time` snapshot `kind: 'one_time'` (`invoicing/service.ts`), so **nothing is lost by
  waiting** — the money arrives whole, one invoice later. Deferring keeps it consistent with the
  other charges that ride a trial (`fireActivationCharges` fires on the trial→active transition,
  i.e. at trial end), keeps `billsAtTrialEnd` a single unqualified predicate, and keeps
  `estimateChange`'s in-trial preview — full price, `immediate_charge: false`, `due_at_trial_end` —
  _exactly true_. Charging during the trial would have made the shipped preview a lie. The one
  sanctioned way to take money mid-trial stays what it was: an explicit one-time charge
  with `invoice_immediately`, through `addAdHocCharges`.
  `estimateChange` shares this arithmetic by design, so its add branch got the same one-line
  branch (full amount + plain label). Without it the preview quoted 2500 for a 5000 booking — the
  same preview-vs-booking drift the estimate work earlier today existed to close.
  **(2) 🟠 `removeSubscriptionItem` had no optimistic lock.** `changeSubscription`'s apply phase
  has taken the CP-0 `resource_version` lock since 2026-07-29 (Bugs #8); this path took none, while
  doing exactly the same thing — reading the term window `currentPeriodStart..currentPeriodEnd` and
  pricing a prorated credit against it in a LATER transaction. Two removals of different items, or
  a removal racing `/change`, therefore each priced a credit off the same stale snapshot: a change
  that term-resets moves the window and already credits the whole old term, so a removal holding
  the pre-reset window credits unused time on that same span a second time. The identical
  conditional write is now the FIRST statement of the removal's transaction
  (`UPDATE subscriptions SET updated_at = … WHERE id = … AND resource_version = <the version read>`),
  so the loser blocks on the winner's row lock, matches 0 rows and throws **`ProrationConflictError`
  → 409 retryable** before anything is written — no delete, no MRR write, no event, no credit note.
  The `DELETE …/items/:item` route gained the `ProrationConflictError → conflict(409)` arm **above**
  its `ProrationError → 400` arm, since the former is a subclass and would otherwise have been
  swallowed into "your request was invalid" when the correct answer is "retry". This **composes
  with** today's atomicity fix rather than replacing it: the lock decides whether the call may
  write, the transaction decides that everything it writes lands together. No gateway call moved
  inside the transaction.
  **`addSubscriptionItem` deliberately did NOT get the lock.** The lock exists to stop two writers
  booking money off one stale snapshot for ONE economic event (double-credit / double-charge); two
  concurrent adds are two DIFFERENT economic events, each pricing only its own new item's snapshot,
  and neither can re-bill or re-credit what the other did — there is nothing to double. Its real
  residual exposure is different in kind (a concurrent term-reset `/change` can move the window
  after the add read it, so the add prorates against a term that no longer exists) and a lock cannot
  close it: the CHARGE is deliberately issued OUTSIDE the transaction, from the pre-lock read, so
  locking would serialize only the insert while leaving the mis-priced charge intact. Meanwhile the
  cost is real — a legitimate parallel two-add composition edit would start returning 409 for one of
  them. See "Known, unfixed" below for what the add path actually needs.
  Gate: `verify:addons-charges` grew 13 checks. **Confirmed RED first** against the pre-fix code —
  10 failed, reporting `one-time mid-term add: invoice total=2500 (full 5000, prorated would be
2500), line kind=proration desc="Onboarding setup - Prorated Charges" period=set; estimate=2500`
  and `stale removal: outcome=SUCCEEDED (no lock) items left=1 (exp 2) credit=500 (exp 0)`. Green
  after: `total=5000 … kind=one_time desc="Onboarding setup" period=null; estimate=5000` and
  `outcome=ProrationConflictError items left=2 credit=0`. The lock proof is **deterministic**, not a
  timing race: a gated concurrent transaction bumps `resource_version` and is held open so the
  removal's conditional UPDATE provably blocks and then matches 0 rows (a plain
  `Promise.allSettled` pair is kept alongside it, but it can simply serialize and prove nothing).
  A control check asserts a RECURRING mid-term add is still prorated. `verify:subscription-ops`,
  `verify:subscriptions-v2`, `verify:proration`, `verify:proration-matrix`, `verify:trial-change`,
  `verify:credit-notes`, `verify:change-atomicity`, `verify:catalog-v2`, `verify:checkout`,
  `verify:time-travel`, `verify:hardening-h`, `verify:invoices-v2`,
  `verify:scheduled-changes`, `verify:billing-mode`, `verify:sdk` and `openapi:coverage` all pass.
  **Known, unfixed (reported, not guessed at — money semantics):**
  (a) `removeSubscriptionItem` still PRORATES the credit for a `one_time` item, so now that the add
  charges the full fee, a mid-term add-then-remove no longer nets to zero (charge 5000, credit
  ~2500). Both defensible readings are money decisions nobody has ruled on — one is _no_ credit (a
  one-time fee already invoiced is not refunded by detaching the item), the symmetric one is the
  _full_ fee back — so it was left alone rather than guessed.
  (b) A `one_time` price attached as a subscription ITEM is re-billed by **every renewal**:
  `planSubscriptionPeriodInvoice` rates all non-metered items each period and only an item-level
  `billing_cycles` cap stops it, which neither `addSubscriptionItem` nor `createSubscription` sets.
  Pre-existing, and it lives in `invoicing/`.
  (c) `POST …/items` and `DELETE …/items/:item` are the only subscription write routes with **no
  `idempotency` middleware** (contrast `/change`), so a duplicated client request double-adds and
  double-charges. The optimistic lock does not fix that — dedup is idempotency's job.
  (d) The OpenAPI entry for `DELETE …/items/:item` documents only 200/404, not the 400 (landed
  earlier today) or the new 409. Not added here because closing it means `pnpm sdk:generate`, and
  `src/api/invoice-routes.ts` + `sdk/` are mid-edit by parallel work — regenerating would bake in a
  half-finished route surface.
  **→ ALL FOUR CLOSED, re-verified 2026-08-17.** (a) `removeSubscriptionItem` credits a `one_time`
  item **nothing**, billed or not (`items.ts`, the ruling recorded there: an invoiced fee comes back
  only through an explicit credit note) — so the add-then-remove nets to zero again. (b) the renewal
  planner honours the implicit one-cycle cap through `isCycleCapExhausted`, and every path that bills
  a one-off outside the planner threads `markItemsBilled` so the cycle is recorded in the invoice's
  own transaction. (c) both item routes carry the full `{ preHandler: [authenticate, idempotency],
onSend: idempotencyOnSend }` pair (`subscription-routes.ts`), gated by `verify:idempotency-race` § C.
  (d) the OpenAPI entry documents 200/400/404/**409**, with the 409 spelling out both causes (stale
  credit vs reused Idempotency-Key).
- **2026-08-03** — **Removing an item can no longer delete it without the credit it owes**
  — the last member of the class fixed on `changeSubscription` earlier the same day, closing the
  "Known, unfixed" note in that entry. `removeSubscriptionItem` deleted the item (plus the cached-MRR
  recompute and the `subscription_changed` event) in one transaction and called
  `issueCurrentTermCredit` in ANOTHER, and `DELETE /v1/businesses/:biz/subscriptions/:sub/items/:id`
  mapped only `SubscriptionError`. So a removal whose credit the refundable cap legitimately refuses
  returned **500 `api_error` with the item already gone** — the customer lost the item AND the unused
  time they were owed, and the status invited a retry of a removal that can never succeed.
  Reproducible without any exotic state: an add-on scaled up after it was first charged has only ever
  been billed the DELTA, so its own charge invoice (the `targetInvoicePublicId` the removal resolves
  by price id) holds less refundable cash than a full term of the item is worth — 1→40 units at
  500 bills 19500, while removing it owes 20000.
  The deletion, the MRR recompute, the event AND the credit now run on ONE `withTenant` handle
  (`issueCurrentTermCredit`'s optional `tx`, via `withTenantTx`), and the refusal is translated at the
  MODULE boundary by the SHARED `rethrowCreditNoteErrorAsProration` — now exported from
  `proration.ts` rather than duplicated — so the route, the dashboard action and any future
  scheduled applier all report the same **400 `invalid_request_error`**: `"This change cannot be
applied: the prorated credit it owes could not be issued — Refundable credit 20000 exceeds
refundable paid amount 19500"`. No gateway call moved inside the transaction: issuing an
  adjustment/refundable credit note only books ledger rows (the payout is a separate explicit
  operation), which is why the removal credit CAN be threaded while the add/change CHARGE cannot.
  **`addSubscriptionItem` did NOT have this hole** — it owes no credit, only a charge, so there is no
  credit-note refusal to be atomic with and the charge must stay outside a transaction. It did have
  the milder split: the item insert committed in one transaction and the cached-MRR recompute + event
  in a second, so a failure between them left the item on the subscription with `mrr` (what the
  subscriptions list shows, sorts and filters on) still describing the previous item set and no event
  to reconcile from. Those three writes are now one transaction; the prorated charge stays outside,
  unchanged.
  Gate: `pnpm verify:change-atomicity` grew cases **F** (refused removal) and **G** (credited
  removal), asserting the same binary invariant as the `/change` cases via a new
  `assertRemovalOutcome` — a removal either succeeds AND credits, or fails 4xx AND leaves the item in
  place; "deleted without its credit" is its own failing check. **Confirmed RED first:** against the
  pre-fix code 8 of the new checks failed, reporting `F refused removal: status=500 type=api_error
item 40→null mrr 40000→20000`. Green after the fix: `item 40→40 mrr 40000→40000`, `resource_version`
  unmoved. `verify:addons-charges`, `verify:subscription-ops`, `verify:credit-notes`,
  `verify:proration`, `verify:trial-change`, `verify:subscriptions-v2`, `verify:scheduled-changes`,
  `verify:catalog-v2` all pass.
- **2026-08-03** — **A downgrade can no longer commit without the credit it owes, and `/change`
  finally recomputes the cached `mrr`.** Two defects, both on `changeSubscription`.
  **(1) The item change and its credit were not atomic — and the failure surfaced as a 500.**
  The item update committed in the apply transaction; `issueCurrentTermCredit` then opened its
  OWN transaction. That credit can legitimately be REFUSED — `issueRefundableCreditNote` caps new
  refundable credit at the cash still refundable on the source invoice, and the source invoice is
  picked as the NEWEST live invoice, so after any small prior proration a full-term downgrade
  credit trivially exceeds it (the residual hole documented in `issueCurrentTermCredit`, tracked
  as D1). When it was refused the subscription was left **downgraded with nothing credited**: the
  customer silently lost money they were owed, and because `CreditNoteError` matched neither
  `ProrationError` nor `ProrationConflictError` in the route's catch, the caller got
  `500 api_error "Internal server error"` — an invitation to retry a change that can never
  succeed. Reproduced at qty 6→5 (500 + quantity committed); 5→6 returned 200.
  **Both** credit paths — the `net < 0` downgrade credit AND the term-reset unused-term credit —
  now run on the apply transaction's handle, so the composition change and the credit commit or
  roll back together. The charge side deliberately stays outside it: `createInvoiceFromLines`
  collects from a gateway, and a network call must never be held open inside a DB transaction.
  Threading required a new `withTenantTx(orgId, tx | null, fn)` in `platform/db.ts` (reuse the
  handle, or open one) plus an optional `tx` on `issueAdjustmentCreditNote` /
  `issueRefundableCreditNote` / `issueCurrentTermCredit` — omit it and every existing caller is
  byte-identical. **Why threading rather than a pre-flight:** a feasibility check would have to
  re-derive the discount scaling, the tax gross-up, the adjustment/refundable split and the cap,
  i.e. a second copy of the arithmetic that decides whether real money moves — and it could not
  see the post-apply line set anyway (a conflicted mandatory-addon insert drops a positive line,
  so a change can cross into `net < 0` only after the apply). One code path decides and books.
  A refused credit is re-raised as a `ProrationError` (`rethrowCreditNoteErrorAsProration`), so
  every caller — route, scheduled-change applier, dashboard — gets **400 `invalid_request_error`**
  carrying the real reason: `"This change cannot be applied: the prorated credit it owes could not
be issued — Refundable credit 20000 exceeds refundable paid amount 500"`.
  **(2) `subscriptions.mrr` was never recomputed here.** `recomputeSubscriptionMrr`'s own doc
  comment claimed "item composition changes already recompute inline at their own call sites", but
  proration.ts contained no MRR reference at all — so every quantity / price / cadence change left
  the cached column reporting the pre-change revenue (measured: an add-on 6→7 at 20000/unit left
  `mrr` exactly 20000 low). That column is serialized (`serialize.ts`) as the MRR column of the
  subscriptions list and is filterable/sortable, so this was a wrong revenue figure on screen after
  every change, not merely a stale cache. It now runs inside the apply transaction, **after** the
  item writes and the term-reset cadence write — `computeSubscriptionMrr` normalizes each item's
  snapshot interval to a monthly figure, so a monthly→yearly swap restates MRR and must be read
  post-write. The misleading comment is corrected and now lists the call sites exhaustively.
  Gate: new **`pnpm verify:change-atomicity`** (28 checks, driven over real HTTP through the SDK
  because the status code is half the bug). Its central assertion is binary — a quantity decrease
  either succeeds AND issues a credit note, or fails 4xx AND leaves the subscription unchanged;
  "committed without a credit" is its own failing check. **Confirmed RED first:** against the
  pre-fix code 10 checks failed, reporting `status=500 type=api_error qty 6→5` (committed) and
  stale MRR on the downgrade, upgrade and frequency-change cases.
  **Known, unfixed (same class, different path):** `removeSubscriptionItem` (items.ts) still
  deletes the item in one transaction and issues its credit in another, and its route has no
  `CreditNoteError` mapping either — a refused removal credit is still a 500 with the item gone.
  Not fixed here to keep this change to the `/change` path.
  **→ CLOSED the same day** by "Removing an item can no longer delete it without the credit it owes"
  (entry below): the delete, the MRR recompute, the event and the credit all run on ONE `withTenant`
  handle, and `DELETE …/items/:item` maps `ProrationConflictError → 409` above `ProrationError → 400`
  (the refusal is re-raised at the module boundary by `rethrowCreditNoteErrorAsProration`, so there is
  no `CreditNoteError` left to map). Re-verified in `items.ts` + `subscription-routes.ts` 2026-08-17.
- **2026-08-03** — **`estimateChange` now prices ADDS and REMOVES, not just modified lines.**
  Its input resolved every entry via `rows.find(r => r.item.publicId === change.itemId)` and threw
  `No such subscription item` otherwise, so it could not _express_ an add or a removal. But the
  dashboard applies a composition edit as up to three calls — `/change`, `POST /items` per add,
  `DELETE /items/:id` per remove — so the preview covered one third of what the operator was
  confirming, and the confirm dialog said **"No immediate charge for this change"** while the apply
  credited unused time. New optional `adds` / `removes` inputs; the route gets its own
  `estimateSubBody` (every list defaults to `[]`, at least one must be non-empty) so a removal-only
  estimate is expressible — `changeSubBody` keeps `changes.min(1)` because `/change` itself still
  accepts nothing else.
  **The two proration windows are not interchangeable.** A change prorates from `prorationBoundary`
  (the start of the NEXT billing day, so the customer keeps a full final day); an add/remove prorates
  from `prorationWindowStart` (the start of the CURRENT one, so a same-day add bills the full term and
  a same-day add-then-remove nets to zero). Each operation keeps its own window here, mirroring where
  it is actually booked — sharing one would put every preview a day off the invoice.
  A differential add-on is resolved through the **same** code as the booking: `effectiveAddSnapshotTx`
  is now exported from `items.ts` and used by both. A parallel calculation here would preview ₹0.00
  and then bill ₹475.00, since a differential's catalog list price _is_ 0.
  In-trial adds/removes fold into the trial-end preview instead (added items at full term price,
  removed items excluded) — the in-trial branch builds its lines from the DB rows, so without this an
  added item would have been missing from the preview and a removed one would still have appeared.
  Gate: `verify:addons-charges` gained an estimate-vs-booking journey, **confirmed RED first** — with
  the new handling stubbed out it reported `preview total=0 lines=0; booked=1000` for an add and
  `preview credit=0; booked credit=1000` for a removal; green, both match to the minor unit.
- **2026-08-03** — **A change made DURING A TRIAL no longer charges or credits anything.**
  A trial term is stored AS the current term (`currentPeriodEnd = trialEnd`), so
  `prorate(amount, now, currentPeriodStart, currentPeriodEnd)` sliced the new price across **trial
  days** and billed that slice immediately — money taken during a free trial, for a fraction of time
  the customer never paid for. Every status guard on these paths checked only `cancelled` —
  `changeSubscription` and `estimateChange` had one each, `addSubscriptionItem` /
  `removeSubscriptionItem` had none at all, so a trial was simply invisible to the money math.
  New single predicate `billsAtTrialEnd(sub)` (`proration.ts`) now gates all four money paths —
  `changeSubscription`, `addSubscriptionItem`, `removeSubscriptionItem`, and the preview twin
  `estimateChange`. Gating means **skip the money, keep the change**: item updates/inserts/removals
  and the post-change cadence all still apply, but the read phase returns empty line/credit lists so
  the apply phase books `{ prorationInvoice: null, creditNote: null, payment: null }`. The full new
  composition is first billed once, when the trial converts (`renewSubscription` →
  `billSubscriptionPeriod`, which reads the CURRENT item set — verified, it already billed the new
  composition and needed no change).
  Two consequences worth naming: (a) a term-reset swap in trial must NOT re-anchor
  `current_period_start/end`, because that window IS the trial — a monthly→yearly swap moved the
  trial end a YEAR out and the sub stayed `in_trial` until then, since the clock renews off
  `current_period_end`; it now only re-cadences (`billingPeriod`/`billingPeriodUnit`) and the
  post-trial term is one new interval from trial end. (b) The estimate must agree with the booking, so
  it no longer previews a proration it will not charge: in trial it prices the **full post-change
  composition** as the trial-end conversion will raise it (snapshot-rated, exhausted cycle caps and
  metered items skipped, coupons applied peek-only), reports `immediate_charge: false` with
  `amount_due_minor` and all credit buckets at 0, and flags the new `Estimate.due_at_trial_end`
  (ISO trial end, null/absent otherwise). Credit buckets are reported as zero rather than simulated
  because the customer's balance at trial end is not knowable now.
  Regression cover: `verify:trial-change` (34 checks — journey, add, remove, term-reset swap, plus an
  ACTIVE-subscription guard that must still prorate immediately). Confirmed RED first: against the
  pre-fix code 15 of the 34 checks failed — a real proration invoice AND a card payment were taken
  mid-trial, and the term-reset swap pushed the trial end a year out.
- **2026-08-03** — **A subscription now refuses recurring items that bill on a different cadence.**
  A subscription has exactly one cycle (`billing_period` + `billing_period_unit`) and every recurring
  item is rated against it — there is no per-item cadence anywhere in the engine. Currency was
  validated on every path; the interval was not, and `createSubscription` simply took the cadence
  from **the first recurring price it found**. So a monthly plan plus a yearly add-on was accepted
  and the add-on billed its YEARLY amount every month — a silent 12× overcharge with no error and
  nothing on the invoice to reveal it. Worse, the cycle depended on the order the caller happened to
  list the items in. New `cadenceMismatch()` guard (returns a reason rather than throwing, because
  the callers raise different error types) is applied on create, `addSubscriptionItem`, and
  `changeSubscription`. Plan items are deliberately exempt on the change path: changing a _plan's_
  interval is a frequency change, which resets the term rather than being an error. Regression
  cover: three cases in `verify:addons-charges`.
- **2026-08-02** — **Differential add-ons are now priced when the caller asks for them explicitly.**
  `createSubscription` resolved a plan-scoped differential (CAT-7) only for the MANDATORY
  add-ons it auto-includes; an add-on named in `input.items` was passed through untouched. Such an
  add-on is modelled as a catalog list price of **0** with the real amount held per
  `(add-on, plan, currency, interval)`, so those items froze a `price_snapshot` of 0 and billed
  nothing — permanently, because the snapshot is immutable once written. A ₹475.00/mo add-on
  invoiced ₹0.00 and contributed 0 to MRR. Now each requested add-on without an explicit
  `unit_price_minor` resolves its differential the same way the mandatory ones do (an explicit
  override still wins), and `mrr` rates the **effective** amount — which also fixes a pre-existing
  case where an explicit override was excluded from MRR. Items created through the _import_ path
  were never affected; it captured the source override correctly.
  Also: the create **response** reported the requested price rather than the persisted one, so it
  claimed `unit_price_minor: 0` for an item billing 475.00 — it now reads the snapshot. That same
  view indexed `resolved[idx]` positionally, which walked off the end as soon as the engine appended
  a mandatory add-on. `SubscriptionItemView` gained `catalog_amount_minor` so a UI can show what an
  overridden price replaced.
- **2026-08-01** — **P4 (dunning.ts only):** `stopDunning` / `pauseDunning` now write
  `invoice.stop_dunning` / `invoice.pause_dunning` audit rows inside their existing transaction.
  Halting or deferring collection on a live debt is an operator decision with money consequences and
  was previously evented but not attributable; the diff carries `dunning_status` and the
  `next_attempt_at` that moved. (Invoice-scoped ops that happen to live in this module because the
  dunning schedule does — the audit vocabulary is `invoice.*`, matching the resource.)
- **2026-07-31** — **One-time charges: array form, catalog origin, service period.**
  `addAdHocCharges` (plural) is now the implementation and takes N lines; `addAdHocCharge` stays as a
  thin wrapper for the existing callers (the single-charge body, and resume's
  `add_to_unbilled_charges`). With `invoiceNow` the lines bill as **one** invoice — one call per
  charge would raise one invoice each, meaning separate documents, collection attempts and credit
  draws. Deferring still yields one `unbilled_charges` row per charge, inserted in a single
  transaction (a partial insert would strand some and lose the rest silently).
  `POST /v1/businesses/:biz/subscriptions/:sub/charges` accepts either the original single-charge
  body or `charges[]`, plus `price` / `quantity` / `period_start` / `period_end` per charge; an array
  body gets a list response, the single body keeps its object response.
  `unbilled_charges` gained `period_start`, `period_end`, `price_id`, `quantity` and `entity_type`
  (`adhoc` | `charge_item_price`), migration `0134`. This closes the gap the old
  `add-charge-card.tsx` documented: a catalog-picked charge previously kept no link to its price.
  **UI change to know about:** the subscription takeover now preselects _Invoice immediately_ — a
  user-approved flip of our defer-by-default. The API's `invoice_now` still
  defaults to `false`, so the wire is always explicit.
- **2026-07-31** — **Billing mode split into two axes; all three modes now expressible.**
  `businesses.term_alignment` (`anniversary` | `calendar_day`) became
  `anchor_granularity` (`instant` | `day`) × `proration_granularity` (`exact` | `whole_day`),
  migration `0135_billing_mode_axes.sql` (backfill: `anniversary`→instant/exact,
  `calendar_day`→day/whole_day; `term_alignment` dropped; a CHECK constraint pins the three legal
  pairs). **Why:** one "billing mode" setting hides three. Day-based was REDEFINED on
  2026-05-19 — sites created on/after that date keep the exact start timestamp and only prorate by
  whole days, so one flag could express the first and third modes but not the middle one.
  New `billing-mode.ts` owns all four boundary decisions (`alignTermStart`, `alignTrialEnd`,
  `prorationBoundary`, `prorationWindowStart`) that were previously seven inline
  `termAlignment === 'calendar_day'` checks, each with its own copy of the tz math.
  `prorationBoundary` is the generalization: a billing day runs from the TERM START's time-of-day
  (a 10:00 term puts a 09:00 cancellation in the previous billing day), which for
  day-anchored terms is local midnight and therefore reduces to the previous `startOfNextDayInTz`
  behavior byte-for-byte. All 22 verify suites unchanged.
  Also: `serializeSubscription` now takes the business and reports `current_period_end` (and the
  `non_renewing` `canceled_at` fallback) **inclusively** — `…T23:59:59` — for day-anchored
  businesses; storage stays exclusive so period arithmetic is untouched. The parameter is REQUIRED rather than optional so the compiler names every call site
  instead of letting a new one silently pick the wrong convention.
  New `pnpm verify:billing-mode` covers all three modes end-to-end plus the rejected 4th pair.
  **Follow-up the same day:** driving the change-term-end dialog over CDP showed the inclusive
  read had no write-side mirror — `datetime-local`'s minute precision turned the served
  `…T18:29:59.999Z` into `…T18:29:00.000Z` on submit, so each open walked the boundary back 60s.
  `normalizeTermEnd` now rounds a day-anchored term end up to the next local midnight unless it
  already is one, and `changeTermEnd` applies it BEFORE its validations and its
  already-at-target no-op check (otherwise re-submitting an unchanged end re-prorated).
- **2026-07-30** — **`estimateRenewal` + `GET /v1/businesses/:biz/subscriptions/:sub/renewal_estimate`**
  — the "Next Billing Amount". Delegates to `planSubscriptionPeriodInvoice`, the documented
  read-only half of `billSubscriptionPeriod`, so the estimate is _by construction_ whatever the
  billing clock will invoice (tax, coupons, rounding). **Do not reimplement the money here** — the
  dashboard previously summed `unit_price × quantity` and understated every renewal on a taxed
  business by the whole tax amount. Anchors the next term with `advancePeriod(…, billingAnchorDay)`
  exactly as `renewSubscription` does, or a short month drifts the estimate off the real billing
  date. **Metered items are excluded on purpose** (no `usagePeriod` → `planSubscriptionPeriodInvoice`
  skips them): future usage is unknown, so this is the fixed-charge floor. Returns `null` when there
  is no next term (cancelling, `remaining_billing_cycles === 0`, or not active/in_trial).
- **2026-07-30** — **`default_payment_method` is now serialized** on
  `GET /v1/businesses/:biz/subscriptions/:sub`. `subscriptions.default_payment_method_id` has always
  existed and collection **prefers it over the customer's primary**
  (`src/modules/invoicing/collection.ts`), but nothing exposed it, so no API consumer could tell which
  card a subscription actually charges — and the dashboard fell back to the customer's primary (or an
  arbitrary first row), displaying a card the engine would not charge. `getSubscriptionDetail` now
  resolves the uuid → public id (`defaultPaymentMethodPublicId`, queried only when the column is set)
  and `serializeSubscription` emits it via `extra.default_payment_method`. The field is **omitted, not
  null**, when the caller didn't resolve it, so the list serializer — which does not join payment
  methods — can't be misread as "this subscription has no override". `null` genuinely means no
  override. `verify:subscriptions-v2` + `verify:subscription-ops` pass.
  Still unexposed: `payment_methods.gateway_account_id` (a `Gateway account` row);
  emitting it needs a join threaded through every `serializePaymentMethod` caller.
- **2026-07-30** — **Paginated subscriptions list.** `listSubscriptionsPage` replaces the unbounded
  `listSubscriptionsForBusiness` behind `GET /v1/businesses/:biz/subscriptions`: keyset on
  `(created_at DESC, public_id DESC)` (index `subscriptions_business_created_idx`, migration 0131),
  `limit`/`starting_after`/`q`/`sort_by[asc|desc]` over `created_at|current_period_end|mrr|status`,
  and `<field>[<op>]` filters incl. the **virtual `plan`** field (EXISTS over items → price →
  product). Item views are now loaded for **the page** — the old version fetched every item row of
  every subscription in the business on every request. `?customer=` also takes a comma-separated
  **set** of ids, which is how the paginated customers list hydrates its Subscription Info column.
  `listSubscriptionsForBusiness` stays as the internal unpaginated read. Verify:
  `verify:list-pagination`.
- **2026-07-29** — **Subscription `public_id` uniqueness is now PER BUSINESS (Bugs #11).** Same defect as
  customers: `subscriptions_public_id_uq` was global while the id-stable importer stamps the imported
  subscription id verbatim. Migration `0127` replaces it with `subscriptions_biz_public_id_uq` on
  `(business_id, public_id)`. `loadSubscriptionSnapshot(tx, subPublicId, businessId)` now requires the
  business id; all other `subscriptions.publicId` predicates were already business-scoped (audited).
- **2026-07-29** — **Concurrent `changeSubscription` calls no longer double-bill (Bugs #8, `verify:hardening-h`
  H3).** The read phase prices a change in one transaction and the apply phase writes it in another, so two
  simultaneous identical plan swaps both priced the same stale state and both invoiced it (plan charge AND
  auto-included mandatory add-on, twice). The apply transaction now opens with an **optimistic lock** on
  `subscriptions.resource_version` (a conditional `UPDATE … WHERE resource_version = <the version the read
phase saw>`, the column the `bump_row_version` trigger maintains): exactly one UPDATE can match, and the
  loser — which blocks on the winner's row lock, then re-evaluates and matches 0 rows — throws the new
  **`ProrationConflictError`** (a `ProrationError` subclass → **409**, retryable) before anything is applied,
  so no items move, no invoice is raised and no ledger row is written. A retry re-reads the post-swap state
  and correctly prorates to a no-op. Separately, the pre-existing "skipped mandatory add-on insert → drop its
  proration line" guard was **dead**: it matched a `'Mandatory add-on '` description prefix this code never
  emits (the line carries the customer-facing price label). Lines now carry an `autoIncludedAddon` flag and
  the drop keys off that, which still covers an add-on inserted by another path between read and apply.
- **2026-07-27** — **A refused auto-collect-ON signup now leaves NOTHING.**
  `createSubscription` takes an optional `deferEventsTo` buffer: with it, `subscription_created` /
  `_started` / `_activated` are appended to the buffer instead of emitted, and the caller emits
  them only once the first charge is known good (a delivered webhook can't be unsent, so the event
  must never be written first). Omit it and behaviour is byte-identical. New
  `deleteProvisionalSubscription` hard-deletes such a never-announced subscription — items, applied
  coupons (rolling back `times_redeemed` and un-claiming any coupon-set code), one-time charges,
  then the row (the rest cascades). It asserts first that NO invoice, ledger entry or payment
  references the subscription and throws `ProvisionalDeleteError` if any does; the ledger is
  append-only and is never touched. Replaces the old compensate-after-the-fact path (void the
  invoice + cancel the sub), which left a `cancelled` sub, a `voided` invoice and six webhooks.
- **2026-07-27** — **Scheduling an end-of-term change now SUPERSEDES the pending one instead of stacking.**
  `scheduleChange` inserted unconditionally, so a merchant who changed their mind before renewal ended up
  with TWO `scheduled_changes` rows carrying the same `effectiveAt`. The subscription detail returns only
  the newest, so the stack was invisible in every state assertion — including `verify:scheduled-changes`,
  which has covered scheduled changes since iteration 12. Two pending changes race at
  renewal: PRO scheduled to BUSINESS (64900) and then to BASIC (6900) could renew onto either. The only
  symptom was a doubled `subscription_scheduled_changes_removed` event — the
  DB rows confirmed it. Superseded **silently** (only the new schedule is reported; emitting a removal
  event would trade one event mismatch for another) and scoped to the **same type**, since a pending
  cancel and a pending change are different intents.
- **2026-07-27** — **A cadence change no longer calls its full charge "Prorated Charges".** A billing-frequency
  change (monthly → yearly) starts a genuinely new term and charges the FULL new-term price, so the
  `… - Prorated Charges` suffix was wrong on it — a full $1188 annual charge is not a prorated slice.
  Now conditioned on `frequencyChanged`: plain label on a cadence change, suffix retained on a
  same-cadence swap that charges within the existing term. Both shapes are covered: plain "PRO plan"
  on a cadence change, "BUSINESS plan - Prorated Charges" on a same-cadence swap. Inert for every
  frozen fixture — none of the others changes cadence. The whole `frequencyChanged` term-length branch
  (`addInterval` to an annual boundary, full-price charge, unused-month credit) was confirmed correct
  at the same time — it had simply never been tested.
- **2026-07-27** — **A discounted subscription can be changed again.** `issueCurrentTermCredit`
  credited the unused term at **list** price while the customer had only paid the discounted amount,
  so the credit exceeded cash collected and the refundable-CN guard threw
  `Refundable credit … exceeds refundable paid amount …` on **any** upgrade/downgrade of a
  coupon-bearing subscription. It now scales the credit by the source invoice's own booked coupon
  discount (`discounts` ledger debit — same drift-proof basis as the M2 tax reversal, not a re-derived
  coupon rate). The DISCOUNTED figure is credited: 12900 plan paid at 11610 → credit 11610.
  The total is rounded once and distributed largest-remainder across items —
  rounding each half-up independently overshoots (two 6450 items at 15% → 10966 vs a 10965 base) and
  re-trips the same guard. `changeSubscription` also passes `applyCoupons` so the change invoice
  carries the subscription's coupons (see `invoicing/README.md`).
  **Known limit:** the scale is off the invoice's face value, while the guard caps at cash actually
  collected — a term paid partly with promotional credit, reduced by TDS withholding, or already
  partly refunded can still exceed it. Clamping would under-credit; the fix is a split credit (D1).
- **2026-07-21** — **Smart / decline-aware dunning** (Tier-1 gaps M10 + M11), OPT-IN.
  New `decline-policy.ts` `classifyDecline(code)` → `'retry' | 'park' | 'terminate'` maps the
  engine's normalized decline codes (soft → retry; card_declined/do_not_honor/expired_card/
  incorrect_cvc/incorrect_number/authentication_required → park; stolen/lost/fraudulent/
  pickup_card/revocation_of_authorization → terminate; unmapped → retry). `planFailureRearm`
  (dunning-schedule.ts) gains `mode?: 'fixed'|'smart'` + `declineCode?` and a new
  `{action:'parked'}` rearm: in `smart` mode a park-class decline keeps the invoice
  `payment_due`/`dunning_status='parked'`/`next_attempt_at=null` and does NOT cancel the sub;
  a terminate-class decline exhausts. `fixed` (default) is byte-identical to before. Applied at
  all three rearm consumers (invoicing `recordFailedPayment`, payments `settlePaymentFailed`,
  webhooks reversal path) — each passes its site's normalized decline code (failureCode /
  errorCode / reversal `data.code`). Parked invoices un-park via the existing
  `collectOnPaymentMethodUpdate` path (they stay `payment_due`, so no query change needed) and
  are skipped by `runDunningPass`/`sweepStrandedRetries` (no auto-retry). `DunningConfig.mode`
  reads `dunning_config.mode` (only `'smart'` enables it). New `verify:dunning-smart` (4 cases);
  `verify:dunning` + `verify:invoices-v2` unchanged.
- **2026-07-21** — Two gaps (found via the M2 work): (1) `createSubscription` +
  `changeSubscription` now reject `quantity !== 1` on quantity-invariant price models (`flat`/`on_off`,
  `percentage`) — a validation error is owed there; tm used to silently ignore quantity (billed
  correctly but accepted nonsense). (2) `applyDunningFinalAction` (dunning.ts) cancel-reason: `no_card` only
  when the customer has no non-expired card on file (no PM rows or all expired); a present-but-`invalid`
  (declining) card → `not_paid` (was conflated with no-card because the tmtest gateway marks a hard-declined
  card `invalid` on verification). Matches "Cancelled – No Card" semantics; `verify:invoices-v2` W-case
  green, `verify:dunning` Case C (true no-card) unchanged.
- **2026-07-21** — Audit **M2** fixed: `issueCurrentTermCredit` (proration.ts) now reverses the
  proportional **tax** booked on the credited time when a downgrade/removal issues a prorated credit —
  it grosses the credit up by `total × bookedTax / netBase` (bookedTax read from the source invoice's
  `tax_payable` ledger), so the credit-note total = base + reversed tax. Untaxed
  invoices book zero tax → no-op (USD paths byte-identical). Proven on an India GST plan downgrade.
  Follow-ups: paid-downgrade refundable-CN path does not reduce
  `tax_payable` (pre-existing design); the helper mutates the caller's `input.items` array (latent).
- **2026-07-15** — Prorated invoice line descriptions (proration.ts new-term/mandatory-add-on,
  items.ts add-on add) now use the `"{external_name} - Prorated Charges"` label via
  the shared `priceLabel()` helper (`@/modules/catalog/pricing`), instead of slug-built
  `"{slug} ×{qty} (new term)"`. Description strings only — no amount/proration-math change. Closed the
  invoice line-description warn class (45→0).
- **2026-07-15** — Two engine fixes:
  - **Item add/remove now recompute cached `mrr`.** `addSubscriptionItem`/`removeSubscriptionItem`
    call `recomputeSubscriptionMrr` (previously only create/reactivate + coupon apply/remove did),
    so the cached column tracks item composition. `computeSubscriptionMrr` is now **snapshot-aware**:
    it rates from each item's `price_snapshot` when present (falling back to the live catalog price
    for snapshot-less items like migration import). A differentially-priced add-on has a catalog base
    of 0 with the resolved amount (4900) frozen only in the snapshot — rating from the live price
    dropped that revenue. per_unit items multiply by qty via `computeLineAmount`. MRR = 18300
    after plan(12900)+A(4900)+B(500), 13400 after removing A.
  - **Removal credit now targets the item's own charge invoice.** `issueCurrentTermCredit`
    (`proration.ts`) took a new optional `targetInvoicePublicId`. `removeSubscriptionItem` resolves
    the removed item's charge invoice by its price id (newest live invoice carrying a line for that
    price) and passes it, instead of the newest-live-invoice heuristic. Fixes `CreditNoteError:
Refundable credit 4900 exceeds refundable paid amount 500` — the credit was targeting add-on B's
    500 invoice instead of add-on A's fully-paid 4900 invoice. Over-credit guard is unchanged (only
    the basis it checks against was corrected).
- **2026-07-15** — `addSubscriptionItem`/`removeSubscriptionItem` now emit `subscription_changed`
  (the item list is part of the subscription, so the event fires on both add and remove).
- **2026-07-15** — Day-aligned item add/remove proration for `calendar_day` businesses. `addSubscriptionItem` and `removeSubscriptionItem` (`items.ts`) prorated
  from the exact add/remove instant → a same-day-as-term-start add-on billed 4900 (partial day) with
  line `dateFrom` = the add timestamp; the FULL term (5000) is owed with `dateFrom` = term start,
  because a whole-day proration window makes same-day-as-term-start collapse to the whole term.
  New `prorationWindowStart` helper floors the window start (`from`) to start-of-day in the business
  timezone via the existing `startOfDayInTz` (no hand-rolled TZ math) when `term_alignment='calendar_day'`
  (as of 2026-07-31: when `proration_granularity='whole_day'`);
  `anniversary` businesses keep exact-timestamp proration. Both the add-charge (`prorate` + invoice
  `periodStart`) and the removal-credit `prorate` use the SAME floored `from`, so a same-day add+remove
  nets to zero and the removal credit note is a whole 5000 (was 4900). Closed the entire
  5000-vs-4900 cascade (subtotal/total/amountPaid/line amount/`dateFrom`/transaction/credit-note
  totals). The cached `subscriptions.mrr` was gross plan MRR only; MRR is reported net of
  _permanent_ recurring discounts. New `netMrrForForeverCoupons` + `recomputeSubscriptionMrr` (service.ts): percentage
  forever coupons net multiplicatively (bps, round half up); fixed-amount forever coupons subtract
  their per-period amount after monthly normalization (`monthlyNormalizedMinor`, extracted in
  `metrics/mrr.ts`). Coupons module calls the recompute on apply/remove when the coupon is
  `forever`. **Duration rule, measured:** applying a fresh 20%/2-period `repeating` coupon to a sub
  already carrying a forever 10% leaves `mrrMinor` at 11610 = 12900×0.9 — so `once` AND `repeating`
  (limited-period) coupons do NOT net into MRR; a time-boxed discount is a temporary invoice
  reduction, not a steady-state MRR restatement. Only `forever` nets.
- **2026-07-14** — Coupon-at-signup (subscribe route): the create-subscription
  endpoint accepts `coupon_ids[]` and applies them (`applyCouponToSubscription`) after the sub is
  created and BEFORE `billSubscriptionPeriod`, so the FIRST invoice is discounted (peekDiscounts).
  Previously coupons could only be applied post-create (future invoices only).
- **2026-07-14** — `serialize.ts`: a `non_renewing` subscription now reports `canceled_at` as the
  scheduled cancel date (current term end) instead of null, matching the `cancelled_at` convention
  for a scheduled end-of-term cancel. Derived at the API boundary; the stored `canceledAt` column
  still records only actual cancellation.
- **2026-07-14** — Term-reset applies to ALL plan swaps, up OR down (`isPlanSwap`, was
  `isPlanUpgrade`). A downgrade swap now also charges the full new plan on a fresh term + credits
  the full old term via a credit note (net-0 new invoice, remainder refundable).
  Quantity/tier changes still excluded (prorated).
- **2026-07-14** — Plan-upgrade term-reset + credit-note model (`proration.ts`).
  A plan SWAP to a more-expensive plan (`isPlanUpgrade`; quantity/tier changes excluded) now
  term-resets: it charges the FULL new plan on a fresh term (start floored to start-of-day for
  calendar_day) and credits the unused old term. When a prior term invoice exists, the credit is a
  CREDIT NOTE (`issueCurrentTermCredit`) applied to the new invoice (creditsApplied); if no prior
  invoice exists it falls back to negative invoice lines so the credit is never lost. Downgrades and
  quantity/tier changes keep the prorated path. Found + closed in testing (13→0).
- **2026-07-14** — Calendar-day term alignment (per-business opt-in). New
  `businesses.term_alignment` (`anniversary` default | `calendar_day`) — superseded 2026-07-31 by
  `anchor_granularity`/`proration_granularity`, see that entry. For `calendar_day`:
  `createSubscription` floors the term start to start-of-day in `businesses.timezone` (via
  `startOfDayInTz`, `src/platform/clock.ts`); `issueProratedCreditForUnusedTerm` credits by whole
  days (proration boundary advanced to next local midnight); immediate `cancelSubscription` floors
  `canceledAt` + shortens `currentPeriodEnd` to the cancel day (`cancelWithOptions` credits from
  the pre-cancel sub so the credit is unaffected). `anniversary` (default) is unchanged. Found +
  closed in testing (the term/proration/cancel cluster, 32→5 fails).
- **2026-07-13** — Reactivation gated like create: when it bills a fresh term immediately with
  auto-collection ON, a usable card is required up front (`assertChargeableForAutoCollect`) — no card
  → 400; a card that fails the charge voids the invoice + re-cancels the sub → 402. Trials and
  auto-collect-off reactivations stay exempt. Dunning-exhaust cancellation (`applyDunningFinalAction`)
  now records a distinct `no_card` reason when the customer has no usable card on file (vs `not_paid`).
  Verified by `verify:create-gating` (reactivate cases) + `verify:dunning` (no-card exhaustion).
- **2026-07-13** — Bug fix: `changeSubscription`'s upgrade (net > 0) branch hand-rolled the
  proration invoice + ledger, bypassing customer credit balances entirely — an upgrade charged
  the card in full even when the customer held refundable/promotional/excess credit (the
  `/estimate` preview already applied credits, so the real invoice diverged from the preview).
  Root cause: the branch never called `createInvoiceFromLines` (the shared engine
  `billSubscriptionPeriod`'s second call site and `prorateTermChange`'s extension path already
  use). Fixed by routing the upgrade invoice through `createInvoiceFromLines({ applyCredit: true,
... })`, same as `addSubscriptionItem`/`triggerAttachedItemCharge`/ad-hoc charges already did —
  no new helper needed, the reusable one already existed and just wasn't wired in here.
- **2026-07-13** — `changeSubscription`/`estimateChange`: TERM RESET (`reset_term`,
  auto-triggered by a plan frequency change) — credits unused time on ALL items and charges the
  FULL new-term price for all post-change items, restarting `current_period_start/end` and
  `billing_period(_unit)` from now via `addInterval`. Renewal is a scan of `current_period_end`
  (no per-subscription job), so moving the column on reset is itself the reschedule.
- **2026-07-13** — estimate: simulates credit-balance application (credits_applied_minor / amount_due_minor).
- **2026-07-06** — As-built baseline documented (post phases 0→H).
- **2026-07-13** — Creation gating (API route): creating with auto-collection ON and an
  immediate first charge (no trial, start ≤ now) requires a usable card —
  `assertChargeableForAutoCollect` (payment-methods) checks presence + gateway verification and
  refuses creation up front (400 `payment_error`). If the first charge itself FAILS, creation is
  refused with 402: the first invoice is voided and the subscription cancelled (`not_paid`).
  Trials, future starts, and auto-collection-off are exempt. `verify:create-gating` (8 checks).
- **2026-08-10** — `reminders.ts`: the clock's reminder pass now emits two more time-relative
  warnings besides `subscription_trial_ending` — `subscription_renewal_reminder` (active,
  actually-renewing subs, 5 days before `current_period_end`) and
  `subscription_cancellation_reminder` (5 days before a pending cancellation, either
  `cancel_scheduled_at` or the term end implied by `cancel_at_period_end` /
  `remaining_billing_cycles = 0`). A `non_renewing` sub gets the cancellation warning, never a
  renewal one. Dedup is now PER OCCURRENCE for the recurring kinds: the emitted event carries the
  target date as a top-level `renewal_at` / `cancel_at` key (top-level because `buildEventContent`
  overwrites `data.subscription` with a full snapshot) and the dedup query matches on it, so a
  renewal reminder fires once per TERM, every term — the old (type, resource) dedup would have
  fired it once in the subscription's lifetime. `runRemindersPass` returns per-kind counts
  (`trialEnding` / `renewal` / `cancellation`) with `reminded` as the total; the offsets are module
  constants (per-business configurability is not wired yet). `verify:email-reminders` (27 checks).
- **2026-08-11** — `renewal.ts`: a trial no longer always converts. `resolveTrialEndCancel` runs
  before the activate write and returns a cancel reason, or null to convert:
  - `trial_end_action = 'cancel_subscription'` on the plan price → `trial_ended`, unconditionally.
    The field was settable via the API and offered in the price form since CP-5 while **nothing
    read it** — the subscription activated and billed regardless (dead control).
  - auto-collection ON with no payment method row at all AND a non-zero amount due → `no_card`.
    This closes the hole the 2026-07-13 create-time gating left open by design: creation refuses a
    cardless auto-collect-on subscription that bills immediately but exempts trials, and until now
    nothing re-checked at the trial boundary. Activating first was not merely a wasted retry — it
    booked full MRR, posted AR to the append-only ledger and sent invoice_issued + payment_failed,
    then dunning unwound all of it days later as involuntary churn, leaving a conversion and a
    churn in the metrics that never happened. The trial itself was the grace period dunning would
    otherwise have provided.

  Deliberately NOT cancelled, all verified: auto-collect **off** (send-invoice — a missing card is
  the arrangement, not a failure), pending-invoice mode (nothing owed at the boundary yet), a
  zero-amount invoice, and one a credit balance covers. The last two are why the gate probes the
  real money via the read-only `planSubscriptionPeriodInvoice` instead of testing card presence —
  a free plan, a 100%-off coupon and a credit-covered period all need no card, ever. An expired or
  previously-declined card is left to try and fail into dunning (narrower than the `no_card` reason
  `applyDunningFinalAction` derives, which also counts an all-expired customer — shared reason
  string, different test for reaching it). `activated_at` stays NULL on both cancel paths: it is
  the discriminator `isTrialExpiryCancellation` (shadow/classify.ts) uses to separate an engine
  trial-expiry from a person cancelling mid-trial. `editTrialEnd({ immediately })` inherits all of
  this, since it reuses `renewSubscription`.

  **`startFutureSubscriptions` no longer converts trials.** It held a SECOND trial conversion for
  the case where the clock was down longer than the trial lasted — activating the sub and advancing
  it to the first paid period itself ("this path replaces that renewal"), which bypassed the gate
  entirely and would have left `trial_end_action` half-dead. A subscription with a trial now always
  starts `in_trial`, even on an already-elapsed boundary; it is then due in the same tick's renewal
  scan and converts through the one gate. The hand-rolled period advance, day-anchored round-up and
  `remaining_billing_cycles` decrement are all deleted with it — `renewSubscription` already does
  each, and the decrement existed here _because_ the renewal was skipped (G review blocker), so
  keeping both would now bill a cycle short. `verify:trial-end` covers both directions of that case
  (cardless → `no_card` with no invoice; carded → converts once, cap 1 → 0). `verify:trial-end`
  (28 checks).

- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-21** — 🟠 **`edit_trial_end { immediately: true }` refuses instead of silently cancelling.**
  Ending a trial by hand reuses `renewSubscription`, which is right for the billing but wrong for the
  answer: an auto-collecting subscription with NO payment method hits
  `resolveTrialEndCancel` → `no_card` and is CANCELLED, so an operator clicking "end trial now" to
  activate a customer got a cancellation and an involuntary-churn record instead. The right answer is
  a refusal ("Cannot change the subscription as there is no valid card on file"). `editTrialEnd`
  now probes first, via the new `isTrialConversionUncollectable` in `renewal.ts`, and throws before
  writing anything; the natural (clock) trial end still converts-then-cancels, because a scheduled
  boundary has nobody to tell. The probe reuses the renewal's own `isUncollectableAutoCollect` over
  the window the conversion would open, so pending-invoice mode, a free first term and
  auto-collection-off all stay collectable and are NOT refused. `renewSubscription`'s context load is
  factored out as `loadRenewalCtx` so probe and conversion read the same snapshot.
  `verify:subscriptions-v2` ET6 (refused, boundary unmoved, nothing invoiced or cancelled) and ET7
  (send-invoice model still converts).
- **2026-08-21** — `TIME_WARP_TOLERANCE_MS` is now **exported**, and
  `assertScopedIfTimeWarped`'s refusal message reports the overshoot in a readable unit.
  It used to divide by `86_400_000` unconditionally, so every warp under ~12h printed
  **"0 day(s) ahead of real time"** — a refusal that claims it happened zero days ahead
  reads as a false positive, which is exactly how the deliberate 61s warp in
  `verify:clock-obs` § 7 presented in a CI log. Now: `90.0s ahead of real time
(tolerance 60s)`.
  The export exists because that suite **induces this guard on purpose** (proving one
  throwing pass cannot abort a tick) and had hardcoded `Date.now() + 61_000` against the
  private 60s constant. That left **one second** of margin, and it failed in the
  counter-intuitive direction: the guard only fires while `now` is still more than the
  tolerance ahead, so a loaded runner that burned a second between building the date and
  reaching the guard got a renewal pass that SUCCEEDED — and the four assertions requiring
  a failed pass then failed. Demonstrated, not theorised: with 1.5s elapsed the old form
  yields `renewal pass = ok`. The suite now derives the warp as
  `TIME_WARP_TOLERANCE_MS + 30_000`, which keeps it small enough that every other pass in
  the tick still behaves normally (the reason it is not simply days ahead).
- **2026-08-21b** — **`update_for_items` is now in the OpenAPI spec.** The route shipped in the entry
  above but was never added to `src/api/openapi.ts`, so `pnpm openapi:coverage` was red at 247/248 —
  the one gate whose whole job is catching exactly this. Documented with the semantics that are easy
  to get wrong from the signature alone: `items` is the DESIRED end state rather than a delta;
  `prorate: false` is applied by DEFERRING the money (there is no separate no-proration mode), which
  is why it pairs with `invoice_immediately`; and the `applied` block in the response exists so a
  caller can tell a removal the CAT-3 mandatory guard REFUSED from one that was never requested.
  `sdk/openapi.json` + `sdk/schema.d.ts` regenerated. Coverage back to 248/248.
- **2026-08-22** — **`customer_name` resolves and FILTERS over the whole name chain.** The list row built
  its name from `customers.name` (legacy, API-never-set) even though the same projection already pulled
  company and phone, and the `customer_name` filter compared that same column — so a subscription
  belonging to "Priya Raghunathan" was both nameless in the list and unreachable by
  `customer_name[contains]=priya`. The projection adds first/last (one join, no extra query) and
  resolves through `accountHolderName`; the filter compares `accountHolderNameSql`, the SQL mirror of
  the same chain, so it matches the string the row renders — including the `first last` form, which
  exists in no single column. Free-text `q` covers the name columns too. `customer_company` still ships
  separately for the four-line Customer Info cell; a company-only customer therefore resolves its name
  to the company, and the cell may print it twice — the dashboard's call, not the API's.

- **2026-08-24** — **A removal/downgrade credit now spans EVERY invoice that charged the item.**
  `issueCurrentTermCredit`'s item-specific path resolved ONE invoice — "the newest live", or for a
  single removal "the one that charged this item" (`targetInvoicePublicId`, 305117a) — and
  `splitCreditByFunding` then clamped the credit to THAT invoice's cash, dropping the rest with no
  error and no log. A term routinely bills one item across several invoices: an add-on subscribed at
  qty 1 (charged 500 on its own invoice) and scaled to qty 40 (whose invoice collects only the 19500
  delta) is worth 20000 on removal, and we issued a single note for 19500. A 6→5 plan downgrade on a
  term that also carried a 500 add-on proration credited **500** of the 20000 owed — against the
  add-on's invoice, a document that never billed the plan. Both measured 2026-08-24.
  EVERY invoice that billed the item must be credited, each from its own lines: on the same removal
  shape (add-on 560/unit; invoice 2189 charged 560, invoice 2190 charged the 21840 delta) that is
  CN-202 560.00 → 2189 (qty 1 × 560) and CN-203 21840.00 → 2190 (qty 39 × 560), summing to 22400 —
  the full 40-unit term value, applied rather than refused.
  So `targetInvoicePublicId` (one invoice) became **`targetPriceIds`** (the prices being credited):
  the credit is placed across every live invoice that charged them, by what each one actually billed
  for them (NET of its own proration credits — a qty upgrade's invoice charged +20000 and credited
  −500, and 19500 is both what it collected and what it can fund), each note spelled out on that
  invoice's own lines. `changeSubscription` derives the prices from the credit LINES themselves, so
  every downgrade is attributed, not just the removes-only shape that had a special case. Placement —
  capacity, largest-remainder, the clamp-and-re-place — moved into one shared `creditAcrossInvoices`
  used by the term-wide (D1) split too, so the two cannot drift; `termInvoiceCanAbsorb` asks the same
  set. Single-invoice terms are byte-identical (verified: five frozen fixtures unchanged).
  `removeSubscriptionItem` returns `creditNotes` (all of them) alongside `creditNote` (the largest).
  Fixtures: `verify:change-atomicity` A/F now assert the OUTCOME — applied, credited in FULL, spanning
  both invoices — scoped to the SUBSCRIPTION (the suite shares one business, so a per-business
  credit-note dump misattributes notes between scenarios); the refusal half of the invariant moved to
  a new case J (a mandatory add-on cannot be detached → 400, `resource_version` unmoved).
  OPEN: an add whose proration was never invoiced leaves a **pending unbilled charge** behind when the
  item is removed — the customer is still billed at renewal for time they no longer have.
  (CLOSED 2026-08-24 — see the entry at the head of this changelog.)

- **2026-08-25** — **A cancellation no longer re-credits unused time a mid-term change already
  returned.** `planCancellationCredit` prorated each term invoice's FULL `total_minor` with no memory
  of credit already issued against it. A mid-term change returns the FIRST invoice's remaining term and
  bills the rest of it on a NEW invoice, and `termInvoices` (rightly) keeps both — so cancelling
  afterwards credited the first one all over again. Measured 2026-08-25
  (`scripts/probe-cancel-after-change-credit.ts`): a ₹27,918 promo-funded INR/IGST term swapped to
  ₹9,118 on day 0 credits invoice #1 in full (3114324 = 1000000 promo + 2114324 cash) and bills
  invoice #2 for 911800. Cancelling an hour later credited invoice #2 its 30/31 = **882387** (right)
  **and invoice #1 another 3013862**, restoring 967741 of promotional credit the customer had already
  been handed back and minting a 2046121 refundable note against cash already committed. Promotional
  ended at 1938328 against the correct 970587 — a constant **+967741** that persisted to the end of
  the run. Only ONE note is owed there: 882387 against invoice #2, zero cashable, invoice #1
  untouched.
  **Fix:** the planner subtracts what non-voided notes with a `TERM_CREDIT_REASONS` code
  (`subscription_change`, `term_change` — the paths that hand back unused time) already returned against
  that invoice, measured as each note's cashable `total_minor` plus the bucket slices it routed back
  (0186's typed discounts), which is the same tax-inclusive unit as the prorated base. A cancellation's
  OWN notes are excluded — `priorCreditNote` / `priorRestore` already guard the idempotent replay, and
  counting them would turn it into a silent no-op.
  Subtracting from the CREDIT, not clamping to the invoice's uncredited remainder, is the load-bearing
  choice: it makes the rule monotone in `now` (an earlier change returned `prorate(base, changeDate) ≥
prorate(base, now)`, so a later cancel can only reach zero). A remainder clamp still over-credits a
  MID-term change — scenario B of the probe: a day-11 change leaves 1105083 of invoice #1 uncredited,
  and a day-20 cancel handed back 1004621 of it for time the customer had already used. Both scenarios
  now add exactly 0 to invoice #1.
  Nothing about the multi-invoice rules changed: `termInvoices` still credits every invoice that
  charged into the term (`probe-cancel-multi-invoice` shortfall ₹0.00), and `issueCurrentTermCredit`'s
  `targetPriceIds` split is untouched (`verify:change-atomicity` F still credits 20000 across two notes).

- **2026-08-26 — a trial has no term, at every WRITE site too.** The 2026-08-25 modelling change
  made `current_period_start/end` nullable so a trialling subscription reports `trial_*` OR
  `current_term_*`, never both. Nullability turns every unguarded _read_ into
  a compile error; it says nothing about the code that _writes_ a term, which stayed type-correct
  while stamping one onto a subscription that must not have it. Five such paths were closed, each
  found by a failing run rather than by the compiler:
  `createSubscription`'s INSERT (set the term unconditionally — the earlier null-ing edit had landed
  on `reactivateSubscription`, so every API-created trial kept a term); `cancelSubscription`'s
  day-anchored truncation (wrote an END with no START on a trial — half a term, a period beginning
  nowhere); both branches of `editTrialEnd` (still mirroring the
  boundary onto `current_period_end`, the original conflation); `renewSubscription`'s prior-period
  probe (asked `requireTerm` while advancing a converting trial — the one shape it exists to
  advance); and the change planner, which computed its money math with `requireTerm` and only then
  checked `billsAtTrialEnd`, throwing on figures it was about to discard.
  The last two were fixed by ORDERING, not by asserting — the invariant held, the code just asked
  before it was true. `termOrNull(sub)` now sits beside `requireTerm(sub)` for the paths that
  legitimately serve both shapes: assert when the caller already knows, ask when it genuinely
  doesn't. Inside the change planner a trialling subscription binds a ZERO-LENGTH window rather than
  an invented date, so every prorated slice is 0 — which is the actual rule (nothing was billed, so
  nothing is owed either way) and cannot leak a wrong number into a real charge.
  `verify:subscriptions-v2` ET1/ET2 and `verify:trial-change` were pinning the old mirror and now
  assert the term's ABSENCE; `due_at_trial_end` is checked against the `trial_end` it is named after.

- **2026-08-27** — `metadata` is writable on three surfaces, each with a different
  and deliberately-stated guarantee. **`POST …/change`** applies it inside the change's own
  transaction — folded into the optimistic-lock CLAIM, so it inherits the same `resource_version`
  check and commits with the item operations, the proration invoice and the credit note, or with
  none of them. **`PATCH …/subscriptions/:sub`** is the metadata-only edit, for mirroring a flag when
  nothing moves and nothing is charged. **`POST …/update_for_items`** takes it too, but writes it
  only AFTER the reconcile — that endpoint is multi-step by design (one `changeSubscription`, then an
  add per addition, then a remove per removal, each folding its own proration), so no placement can
  make it atomic. Last is therefore the safe order: a refused item operation writes no metadata, so a
  subscription is never flagged for something it was not billed for; the mirror case is logged at
  error rather than swallowed. All three REPLACE wholesale rather than merging, matching the create
  path. Motivated by a core-destination switch, where the items decide what a
  customer is BILLED for and the metadata decides what they are SERVED — the reason that operation
  refused every other vendor until this existed.

- **2026-08-27** — `applyItemOperations` emits **ONE** `subscription_changed` for the whole reconcile,
  not one per leg. It drives up to three primitives (`changeSubscription`, then an add per addition,
  then a remove per removal) and each emitted its own — correct in isolation, since the event does
  fire for a standalone `POST …/items` and `DELETE …/items/:id` — so a destination switch, which is a
  change plus an add plus a remove, produced **three identical events for one buyer action** (observed
  2026-08-27). The legs now take `deferEventsTo` and buffer; one summary event is emitted at the end,
  carrying `items_changed` / `items_added` / `items_removed` so a consumer gets what the three said
  between them. Read back from the row, because the legs move `status`, the term and `resource_version`.
  - **"One per change" is not claimed as a universal rule** — the argument is narrower: three
    identical events differing only by which internal step raised them are not actionable.
  - A leg failing PART WAY flushes the buffered per-leg events instead of the summary. Those legs are
    committed (each runs in its own transaction, which is what lets each fold its own proration), so
    their events must land or state has moved with nobody told — and on that path there is no single
    coherent outcome to summarise.
  - An empty reconcile emits nothing.

- **2026-08-27** — **`deriveMandateCeiling` lives here now**, because sizing a mandate honestly is a
  billing projection: the largest `estimateRenewal().total_minor` across the customer's renewing
  subscriptions in that currency (tax in, discounts applied) plus 25% headroom. It moved out of
  `payment-methods/service.ts`, whose price-column sum missed tax and read 0 for tiered / volume /
  stairstep / percentage prices — see that module's changelog for the full argument.
  - **`total_minor`, not `amount_due_minor`.** `amount_due` is net of the customer's credit balance,
    which is a one-off: size a mandate against a renewal a ₹5,000 credit happens to be paying down
    and the renewal after it — full price, no credit left — is refused. The shortfall WARNING is the
    opposite question and correctly uses `amount_due`.
  - Capped at the 10 largest subscriptions by cached MRR (each one plans an invoice, and this runs on
    an add-card request); anything dropped is logged rather than silently ignored.
  - `mandate_shortfall.reauthorized_ceiling_minor` is now `withMandateHeadroom(amount)` — headroom
    over the charge in hand. It used to `max()` that against `deriveMandateCeiling`, which could only
    ever quote a LARGER number by picking up some other subscription, i.e. the exact shock the 25%
    decision exists to avoid.
  - What it still cannot see: **metered usage**, which does not exist until the period is rated. A
    usage-heavy subscription is sized on its fixed component; `mandateRefusal` stays the backstop.
  - Proven end to end in `verify:india-invoice` (plan ₹1,000 + addon ₹500 + 18% GST → ₹1,770 →
    ceiling ₹2,212.50), which also pins the no-subscription fallback at ₹15,000.

- **2026-08-27** — `Estimate.tax_lines`: `tax_minor` broken into the rows the invoice will print, via
  `taxLinesForBase` (flat-base paths: change, in-trial change, new subscription) and
  `taxLinesFromRows` (the renewal, which already has a computed `InvoiceTax`). Sums exactly to
  `tax_minor`; empty when there is no tax to name. Every buyer-facing preview was showing one lump
  "Tax" row against an invoice that itemises GST.

- **2026-08-27** — **The renewal boundary had no cardless veto.** `isUncollectableAutoCollect` guarded
  trial-end and first-period boundaries from the start and was never wired to a renewal, so an active
  auto-collect subscription with no payment method rolled its term, raised an invoice, booked a
  `no_payment_method` failure and emailed `payment_failed` — then dunning unwound all of it days later
  as involuntary churn. Measured on a shadow run: **48 subscriptions where nothing should have
  been raised at the boundary and we transacted**, still recurring at 2026-08-26 18:40.
  - **The remedy is the business's own dunning final action, not a new policy.** An active
    subscription that cannot pay is exactly what `final_action.subscription` already decides;
    deciding it again at the boundary would override a merchant who chose `retain`. So the gate asks
    the configured question early instead of after four impossible retries: `cancel` → cancel here
    with reason `no_card`, nothing raised; `retain` → raise the
    invoice so the dues stay on the books, but commit it with `collect: false`.
  - **Why `collect: false` and not an attempt.** With no payment method `collectInvoice` cannot reach
    a gateway at all — it records `no_payment_method` without calling one — so the boundary attempt
    only ever produced a failed payment row and an email. Dunning owns the retries from there, which
    is what `retain` means. It does NOT suppress dunning: the first real attempt is simply the
    schedule's, not a duplicate at the boundary.
  - **Known cost of the cancel branch:** it does not bill the just-ended period's metered usage, which
    the probe has just priced into `amountDue`. Deliberate — the alternative is raising an invoice
    solely so it can fail — but it is revenue we stop invoicing. A merchant who wants that receivable
    configures `retain`.
  - `cancelUnconvertedTrial` became **`cancelAtBoundary`** with an `expectStatus` the caller supplies,
    shared by both boundaries. The guarded claim must compare against the row the decision was made
    on, or two overlapping ticks both cancel and both emit `subscription.canceled`. `activatedAt` is
    untouched in both directions and that is load-bearing: NULL means a trial that never converted
    (`isTrialExpiryCancellation`), present means an ordinary end-of-term cancellation.
  - `verify:cardless-renewal` — 26 checks, in `verify:all`'s CORE list. Four are teeth (send-invoice,
    carded, zero-amount, credit-covered) because a gate reading card presence alone would cancel
    every send-invoice customer on the book. **Mutation-tested**: disabling the gate fails 7 checks
    and reproduces the pre-fix symptom exactly — term rolled, invoice raised, failed payment booked.
  - The credit-covered case also settles the neighbouring triage question: the probe prices the
    customer's credit buckets through `planSubscriptionPeriodInvoice`, so a renewal that promotional
    credit would settle is already collectable here.
    ⚠️ **Correction (same day):** this bullet originally ended "what is missing is that
    `migration/import.ts` never imports them". That is FALSE — `import.ts:1452` imports
    `promoCreditBalances` through `topUpWallet`. The claim came from a case-sensitive grep for
    `balances` that could not match `promoCreditBalances`. The real defect was in the shadow's own
    snapshot, which hardcoded `balances: []` on our side; see `shadow/README.md` 2026-08-27.

- **2026-08-29** — **per-item clock failures are now RECORDED, not just logged.**
  `startFutureSubscriptions` and `healUnbilledFirstPeriods` returned `void`, and
  `runDunningPass` / `sweepStrandedRetries` / `sweepExpiredParkedDunning` returned counters
  only, so an item that threw was isolated (right) and then left no trace anywhere durable
  (wrong). The tick row said the pass ran, the counters said it did nothing, and the reason
  lived in a log line that rotates away — a subscription whose trial silently failed to
  start its paid term looked identical to one whose trial simply hasn't ended.
  * All five now return `TickError[]`, which `jobs.ts` merges into `clock_ticks.errors` —
    the mechanism the renewal loop and scheduled changes already used (SCHED-1).
  * `runBillingClockTick` therefore declares its `errors` list before the two sub-passes
    rather than beside the renewal loop.
  * **Consequence:** a tick is unhealthy on `errors.length > 0`, so failures in these passes
    now mark the tick unhealthy where they used to pass silently. That is the point, but it
    will show up as more `tick_unhealthy` than before. `TICK_ERROR_CAP` already bounds the
    jsonb on a mass-failure tick.
  * `renewal_pass_failed` moved to `log.recurringError`: the clock is `* * * * *`, so a
    subscription stuck in a broken state logged 1,440 identical stacks a day. Safe only
    because `errors.push` keeps the durable record. **At the time this shipped the sibling
    passes deliberately stayed on `log.error`** — the durable record above is what later
    let them move too; see the 2026-08-29 (later) entry.

- **2026-08-30 — `mandate_spent` classified (F-43).** The new pre-flight refusal in
  `modules/invoicing/collection.ts` is non-retriable, so an unclassified code would have exhausted
  dunning on the FIRST attempt in fixed mode — the measured failure documented in `planFailureRearm`,
  where the invoice dies and the subscription stays live and unpaid forever. Added to `PARK` and to
  `PARK_EVEN_IN_FIXED_MODE` (the customer's instrument is not declined, it is un-authorized, and our
  own pre-flight is what refused). Deliberately NOT added to `PARKED_WITH_DEADLINE`, tied by a test
  to `mandate_ceiling_exceeded`'s membership so the two re-authorise-to-recover refusals cannot
  drift apart by accident.

- **2026-08-31 — Reactivation now re-anchors the term it opens.**
  `reactivateSubscriptionWithOptions` restarts a term at `now` and may change the cadence in the
  same call, but it passed the **pre-cancellation** `billing_anchor_day` to `advancePeriod` and
  never wrote a new one. `advancePeriod` takes the result's day-of-month **entirely** from that
  argument, so the boundary landed on the old day of the month. Measured: a sub anchored on the
  8th, reactivated on the 23rd onto a yearly price, ran `2026-08-23 → 2027-08-08` — **350 days**,
  and the reactivate route bills the stored term via `billSubscriptionPeriod`, so a **full year was
  charged for 350 days of service**. The anchor now comes from the new term's own start
  (`reactivatedAnchorDay`), the same rule `createSubscription` uses for a fresh term and
  `changeSubscription`'s reset uses for a restarted one (`resetAnchorDay`) — and it is **persisted**,
  so the boundary and the stored anchor agree by construction rather than by comment.
  * Written for the **trial** branch too: a reactivation into a trial opens its first paid term at
    the trial end and `renewSubscription` anchors that term off this column, so keeping the stale
    value would have pushed the same bad boundary one conversion downstream. A trialling *create*
    anchors to the signup day the same way.
  * **`resumeSubscription` was deliberately NOT changed**, and looks identical at a glance. It also
    restarts a term at `now` with the old anchor, but ends it on the customer's **already
    paid-through** boundary (`23-Aug → 08-Sep` on an 8th-anchored monthly sub) — the sticky anchor
    doing its job. Moving it would re-bill a date the customer already paid for. The short term
    there is correct; the short term here was not.
  * Same defect family as the term-reset bug fixed earlier the same day (`resetAnchorDay`,
    `proration.ts` + `estimate.ts`); this is the sibling path that fix did not reach. Guarded by
    `verify:subscription-ops` § 4b, which asserts both the full-year span and the moved anchor.

- **2026-09-01 · `max_refundable_credits_usage_minor` / `max_excess_payment_usage_minor` (0219).**
  The subscription half of Credits Flexibility
  (`billing_overrides[max_refundable_credits_usage]` / `[max_excess_payment_usage]`): the most of each
  credit bucket that may be AUTO-applied to one invoice raised for this subscription, in minor units.
  Null = no subscription cap (the default and today's behaviour); 0 = never. Combined with
  `businesses.credits_flexibility` by taking the TIGHTER ceiling, so a subscription cap narrows the
  site setting but can never re-enable a bucket the site switched off. Settable on create and on
  `PATCH /v1/businesses/:biz/subscriptions/:sub`; **no dashboard control yet** — the business-level
  screen says so rather than rendering one that does not post anywhere. See
  `modules/customers/credits-flexibility.ts`.

- **2026-09-01 · `effectiveAddSnapshotTx` takes an optional `postPlanProductId` (`items.ts`).** An add-on
  ADDED in the same edit as a plan change was priced at the plan the subscription was leaving.
  `resolveDifferentialForAddTx` looks the plan up in `subscription_items`, which during a change still
  holds the outgoing one — while CHANGED lines already resolved against `postPlanProductId`. So one edit
  used two different plans depending on whether a line was modified or attached, and `items.ts`'s own
  docblock stated the rule it broke: *"the CHANGE path must resolve against the plan the subscription
  will have AFTER the change."* The adds branch was even already post-change-aware for CADENCE — post
  for cycle, pre for plan.
  * Now: `postPlanProductId` present → resolve against that plan; absent → the stored-plan lookup, so
    `addSubscriptionItem` (an add with no plan change) is unchanged and passes nothing. Both change call
    sites in `proration.ts` and `estimate.ts` pass it. The override lives ON the shared resolver
    deliberately — `estimate.ts` notes that sharing it is what stops preview and booking drifting, and
    two hand-maintained copies is how the asymmetry arose.
  * **Real money and recurring, not a preview glitch:** the frozen `price_snapshot` comes from the same
    resolver, so the next term billed the wrong rate too (measured: 10 × ₹900 where 10 × ₹600 is
    contracted). Direction flips on a downgrade, so it over-charged one way and under-charged the other.
  * **Measured, not assumed:** such an add-on rates at the POST-change plan in BOTH directions, with a
    no-change control landing on the old plan. Gated by `verify:proration` § G (6 assertions + 2
    controls, red before the fix, 8/8 after with no edit to them).
  * Adds now travel inside the single `/change` call rather than a separate `POST …/items` after it —
    the one route where this defect cannot appear, which is why it went unseen for so long.
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-27** — Resume bills by the term, on one path. Billing is in advance, so
  `resumeSubscriptionWithOptions` now splits on `now < current_period_end`:
  * **In-term:** status → active, `current_period_*` KEPT, no invoice or unbilled charge whatever
    `charges_handling` says. Previously the term restarted at `now`, discarding the paid remainder and
    opening a fresh uncharged term.
  * **Out-of-term** (or no term): term restarts at `now` and is ALWAYS billed —
    `invoice_immediately` or `add_to_unbilled_charges`; omitted → `pause_config.charges_on_resume`,
    whose default is now `invoice_immediately`. Previously the omitted default (`next_renewal`) ran
    neither branch: every resumed term was free (a yearly resume = a free year).
  * `next_renewal` is a deprecated alias: the resolver and the settings route read it as
    `add_to_unbilled_charges`; the settings API still accepts it, stores and returns the alias target.
  * `resumeSubscription` is now a thin alias of the core. The customer-portal resume used it and only
    flipped status, so an out-of-term portal resume kept a past `current_period_end` and the next tick
    back-billed the paused span; it now calls the core on the business clock. Scheduled
    (`billing_cycles`) resumes already used the core with `invoice_immediately`.
  * `mrr_earning_without_billing` no longer exempts a resume movement (every resume bills its term).
  * Gated by `verify:subscriptions-v2` § RES (in-term, default, legacy alias, scheduled) and
    `verify:customer-portal` (out-of-term portal resume, no back-billing); red before, green after.
- **2026-09-28** — Smart dunning with multiple backups. `firstPresentable` now skips a card at its per-card cap the same way it skips a `NO_REPRESENT` card, so a capped primary hands over to a backup; the retry is deferred only when EVERY candidate is capped (to the soonest cap to lift), and the deadline attempt runs if any card is presentable. The disposition of a run that declined on several cards comes from the most recoverable decline (`collectionRank`: retry < park < terminate) — an expired primary plus a stolen backup parks instead of terminating. No fallback after `revocation_of_authorization` / `debit_not_authorized` / `fraudulent` (`STOP_FALLBACK` in invoicing/collection.ts).
- **2026-09-28** — `recurring_amount_minor` on the subscription list and detail responses: one billing period's charge for the recurring (non-usage) items, net of discounts spanning > 1 period (`discountsForMrr`), fixed amounts per period then percentages half-up, pre-tax. Not zeroed for trial/paused; null when cancelled or when an item's cadence differs from the subscription's. Pure `computeRecurringAmount` sits beside `netMrrForDiscounts`, which now shares `applyStagedDiscounts` (behaviour unchanged); `recurringAmountsForSubs` loads a list page in two queries. Read-only, no migration. Unit test: `test/unit/recurring-amount.test.ts`.
- **2026-09-30** — Unbilled charges at business level (`src/api/usage-routes.ts`): `GET /v1/businesses/:biz/unbilled_charges` (scope `subscription`/`customer`, filters `status`, `created_at`, keyset paging; `period_end` in the invoice-line convention), `DELETE …/unbilled_charges/:id` (`deleteUnbilledCharge`: pending → `voided`, 409 when billed or already voided; no ledger entry exists to reverse), `POST …/unbilled_charges/invoice_now` (`invoiceUnbilledChargesNow`: one invoice per subscription, raised and collected like `/charges` `invoice_now: true`, charges claimed inside the invoice transaction) and `POST …/invoice_now_estimate` (`estimateInvoiceUnbilledChargesNow` over `previewInvoiceFromLines`, carrying credit balances across subscriptions). The existing sub-level list, `/charges` and cancel's `invoiceUnbilledCharges` are unchanged. Proof: `verify:usage-api` §2–3.
- **2026-09-30** — `pauseDunning` records the schedule it replaces in `invoices.dunning_pause` (0308; a re-pause keeps the original). New `resumeDunning` restores `next_attempt_at` + `dunning_status` while the pause still stands, emits `invoice_updated` and audits `invoice.resume_dunning`.
- **2026-09-30** — `invoiceUnbilledCharges` (cancel / pause `invoice` handling) carries each charge's quantity (so unit price = amount ÷ quantity) and service period onto its line, and claims exactly the charges it read inside the invoice transaction (`markUnbilledChargesBilled`) — a charge queued meanwhile stays pending instead of being marked billed off-invoice; one billed/deleted meanwhile rolls the invoice back (`UnbilledChargesChangedError`). No `priceId` on the line, so tax and totals are unchanged; still `collect: false`. Proof: `verify:usage-api` §4.
- **2026-10-03** — A scheduled pause (end of term / specific date) now lands through `pauseSubscriptionWithOptions` with `pauseOption: "immediately"`, so `pause_config.unbilled_on_pause` and `dunning_on_pause` apply when it takes effect, exactly as for an immediate pause; the caller's explicit `unbilled_charges_handling` / `dunning_handling` are stored in `scheduled_changes.payload.pause` and win when it lands (`verify:subscriptions-v2` PCFG). The Unbilled charges settings page gains a "Follow" choice for `on_change` / `on_one_time_charge` that leaves the key unset, so saving it no longer takes those events away from `default_invoice_immediately` (UCFG).
- **2026-10-03** — `storedPayerDeclineMessage` filters failures read back from storage (business-wide code-level overrides only — the payment row has no rule id); the parked reminder's `decline_message` is payer-filtered; `gateway_error` / `gateway_account_unavailable` are always hidden from payers unless an override shows them.
- **2026-10-05** — GET (detail) emits `revenue_to_date_minor`, `revenue_paid_invoices_count`, `revenue_since` — cash collected on this subscription's invoices net of refunds (`collectedRevenue`).
- **2026-10-08 (0332)** — `createSubscription`, `updateSubscriptionSettings` and `changeSubscription` (before the optimistic-lock claim) check `metadata` against the business's metadata rules; `update_for_items` checks before any item moves. Scope per caller via `metadataRules`.
- **2026-10-08** — `changeSubscription` and `estimateChange` take `removeDiscount` (`remove_discount` on `/change` and `/estimate`): the active discount is removed inside the change's transaction BEFORE `couponCode`/`manualDiscount` and before the proration invoice, so that invoice bills undiscounted and a remove + add swaps the discount in one edit. The estimate prices the same order at all three points (trial end, proration, renewal). `verify:estimates` § 10b asserts estimate == booking for percentage, fixed, repeating (one period used) and a swap. A scheduled change refuses it, as it refuses a coupon.
- **2026-10-11** — **In-term reactivation** (`in-term-reactivation.ts`, `reactivateSubscriptionInTerm`). A subscription dunning cancelled (`cancel_reason` `no_card`/`not_paid`), reactivated before its term ends with the same lines and no `trial_end`/`reactivate_from`/payment fields, continues that term: no invoice, `start_date` and the term kept (so the first-period heal stays off), the term's invoice keeps its balance. Eligible only while that invoice exists and is not voided. With `requireSuccessfulChargeOnReactivation` and auto-collection on, the open invoice is collected once first and a failure refuses. Opt-in via `allowInTerm` — the operator route sets it, the reactivating checkout does not (its page quotes a fresh term). `estimateReactivate` reports it as `in_term_reactivation`. Gate: `verify:reactivation-in-term`.
- **2026-10-11** — **`term` on reactivation** (`ReactivationTerm`). `reactivateAndBill` takes `term`: `auto` continues the current term when eligible, `continue` refuses with `IN_TERM_REFUSAL` when not, `new` always opens a fresh billed term; omitted = `new` (the reactivating checkout). Replaces `allowInTerm`. The operator route sends `auto` unless the body has `term`; `estimateReactivate` honours it and always reports `in_term_available`, so the Reactivate screen's Term choice stays visible after "Start a new term today" is selected.
- **2026-10-11** — `subscriptionDues` subtracts cash payments (`paidTotals`). It summed the stored `amount_due_minor`, which is net of credits only, so a part-paid invoice showed its whole balance: the subscription page said ₹52,414.64 due where the customer page (and the invoice) said ₹419.64. The HubSpot card's dues had the same defect and the same fix.
- **2026-10-11** — `estimateChange`'s term-reset credit capacity reads the live outstanding (`invoiceOutstanding`), as the booking's `invoiceOutstandingDue` does; it read the stored column, so on a part-paid open invoice the preview could promise more credit than the booking places (only when the capacity is what caps the credit). No dedicated fixture.
- **2026-10-21** — Behind `RENEWAL_FANOUT` (default off): the tick queues `renew_subscription` jobs (per-business share, interleaved run_at, topped up to `RENEWAL_FANOUT_LIMIT`) instead of renewing inline. Behind `RENEWAL_BATCH_NUMBERING`: the `collect` worker role runs `collect-pump.ts` over `collect_due_at`, and dunning retries go to the same pump. The renewal period claim and its invoice commit in one transaction (see invoicing). Failed-payment booking reads the payment method's rail on the outer transaction (pool deadlock).
- **2026-10-22** — The pipeline drains whatever the flags say: the tick re-requests numbering for
  any invoice left `awaiting_number`, and a billing worker always runs the collection pump (every
  second with `RENEWAL_BATCH_NUMBERING`, every minute without), so switching batch numbering off
  mid-peak strands nothing. `COLLECT_LANES` sets the pump's charges in flight (default
  `WORKER_CONCURRENCY`). Switch-on steps: `deploy/README.md` § Switching on the renewal pipeline.
- **2026-10-24** — A term-end cancel (`cancel_at_period_end`, or `remaining_billing_cycles`
  reaching 0) now raises one final invoice for the closing term: its metered usage in arrears and
  its pending unbilled charges, no recurring fee (`cancelAtTermEnd`, renewal.ts). Before, the
  branch only flipped the status, so both were never invoiced. The cancel is the period claim
  inside the invoice transaction; a window a pending draft already owns is not re-billed; nothing
  owed → no invoice. The cancel estimate's end_of_term warnings now say this. Cover:
  `verify:term-end-final-invoice`.
- **2026-10-24** — `POST …/subscriptions/:sub/usage` carries the idempotency pair and passes `checkWindow` to `recordUsage`: the accepted window is the one the next renewal or the open pending invoice bills (`priorCovered` included). Details in the metering README.
- **2026-10-24** — Reminder lead days are per business (0376, `businesses.reminder_config`,
  resolver `reminder-config.ts`): a list of 1–90 days, at most 5, for `trial_ending`, `renewal`,
  `renewal_yearly` and `cancellation`; defaults 3 / 5 / 30 / 5 as before. The pass sends only
  the smallest lead day reached, once per (subscription, kind, occurrence, lead day), and stamps
  `lead_days` on the event; an event from before 0376 counts as the default lead. A lead day that
  passed before its list changed (`changed_at`) is not sent late. Mandate and gateway pre-debit
  notices are unchanged. `runRemindersPass(now)` lost its unused window overrides. Gate:
  `verify:email-reminders` (cases 6–10, time-travelled), `test/unit/reminder-config.test.ts`.
- **2026-10-24** — The first-period paths (`startFutureSubscriptions`, `healUnbilledFirstPeriods`) bill with `opensPeriod`, and a `PeriodAlreadyBilledError` counts as billed: overlapping ticks raised one invoice per tick before (3 concurrent ticks, 3 invoices). Renewals and skipped renewals are marked too; there a conflict throws and is recorded on the tick, because the claim should have prevented it. Removing an item (any path) now detaches its usage records instead of deleting them (metering README, 0371). Cover: `verify:period-uniqueness`, `verify:usage-item-removal`.
- **2026-10-25** — **A metered item never takes a fixed or prorated charge.** Add item, remove item, mid-term price swap, term reset (charge and unused-time credit), attached-item charges, `recurringChargeMinor`, the change-term-end total and the `estimateChange` mirrors rate through `fixedChargeMinor`, which is 0 for a metered price. Before this, a `usage` price added mid-term charged one unit's rate prorated, and a metered tier price billed its first-tier flat fee as a fixed charge (T0: `verify:metered-fixed-paths`, red on every path before). **Open-window usage is settled** (`usage-settlement.ts`, `settleMeteredUsage`): item removal, a term reset and an immediate cancel rate `[usageWindowStart, until)` and queue a `usage_settlement` unbilled charge (+ prorated minimum); the plan-swap removal of a metered mandatory add-on moved to it from an inline line. Skipped in a trial and while a pending invoice is open. `usage-window.ts` holds the usage windows (`termUsageWindow`, `pendingInvoiceUsageWindow`, `usageWindowStart` moved from metering); the four renewal sites call it. `renewal-skips` uses `meteredPriceSql`; the MRR-for-term guard uses `isMeteredPrice`. Cover: `verify:metered-fixed-paths`, `verify:usage-item-removal`.
- **2026-10-25** — **Usage so far** (`current-usage.ts`, read-only, nothing stored). `currentUsage` rates each live metered item over the window the next invoice bills (`usageWindowForNextInvoice` in `usage-window.ts`: an open pending draft's stored window, else the term, billed by the renewal, a pending invoice or the term-end invoice; null in a trial, cancelled, or when the term's own invoice covered it) through `rateMeteredItem`, adds pending `usage_settlement` charges (the next invoice bills them), and taxes the lines with `previewInvoiceFromLines` at zero balances. No minimum true-up so far, no coupons or credits. A time-weighted item measures to now. Projection (`usage-projection.ts`, opt-in, null before 10% of the window): a sum/count extends linearly (bigint ceil), a level holds, time-weighted holds the closing level; the projected quantity is rated, plus the minimum true-up for the window. In a trial, `trial` reports units only. `currentUsageForCustomer`: ≤50 metered subscriptions, totals per currency. One `current_usage_computed` log line per read (items, records, duration). `estimateRenewal({ includeUsageSoFar })` passes the window as `usagePeriod` when the renewal bills it; default unchanged. `renewal.ts`'s `priorPeriodCovered` calls the shared `termCoveredByPriorInvoice`. Cover: `verify:current-usage` (view = invoice at the boundary for the renewal, true-ups, settled usage, the term-end invoice and a pending close), `test/unit/current-usage-projection.test.ts`.
- **2026-10-25** — **Monthly usage billing inside a longer term, and a minimum commitment per term (0383–0385).** `bill_usage_monthly` (plan price default, frozen on the subscription; 2+ month terms in months or years; refused with pending invoices) cuts the term at `B_k = advancePeriod(term start, month, k)` (`sub-periods.ts`). `current_sub_period_start` is the usage cursor; `renewSubscription` bills the earliest due boundary first (`billSubPeriod`: usage since the cursor + queued charges, no plan fee, keyed `(subscription, B_k)` with `opens_period`, `metadata.sub_period`/`usage_window`; the claim moves the sub-period in the invoice transaction), and a split subscription whose term is not due returns. The due scan and the fan-out each gained a `current_sub_period_end` branch. `termUsageWindow` starts at the cursor when it lies inside the term and takes `until`; `usageWindowStart` follows it. A monthly metered price fits a split term (`cadenceMismatch` `monthlyUsage`). Term writers set the sub-period and the commitment segments from the new term (`newTermFields`): create, renewal, skip, reactivate (both), resume out of term, term reset; `changeTermEnd` caps the sub-period. **Commitment** (`commitment.ts`): `commitment_amount_minor` + `commitment_segments` (time-weighted, one half-up rounding); counted = recurring/proration/usage lines of the term before discounts and tax, less plan-change and cancellation credit notes scaled to the supply they reverse; goodwill notes do not count. The renewal, the term-end cancel and the skip raise a "Minimum commitment adjustment" plan line (coupons apply); a skipped term is waived (empty segments), a paused one never reaches a true-up. An immediate cancel (after its credit note) and a term reset book a `commitment` unbilled charge (one per term, 0385 index); the cancel's unbilled-charges option invoices or deletes it. A plan swap moves an un-overridden commitment to the new plan's, from now; a plan swap that changes `bill_usage_monthly` mid-term is refused. `GET/POST …/subscriptions/:sub/commitment`. Cover: `verify:sub-period-billing`, `verify:commitment`, `test/unit/sub-periods-commitment.test.ts`.
- **2026-10-28** — The pre-debit notice also covers an ACH debit under our authorization
  (`us_bank_account` on an `achAuthorization: "ours"` gateway): sent from 12 days before the
  debit (Reg E 1005.10(d): at least 10 days for a varying amount), `mandate_rail: "ach"`, the
  reference is the newest `payment_method_authorizations` id. `verify:email-reminders` case 5c.
- **2026-10-30** — Reactivation refusal text: "We did not reactivate the subscription. The payment failed (<code>): <reason>. The subscription stays cancelled." The normalized code leads because the reason is often the gateway's generic buyer copy. The dashboard no longer prefixes its own sentence. The refused pre-charge's transaction now carries the subscription (see transactions README, 0402).
- **2026-11-01** — Subscription item JSON (REST and event snapshot) carries `selling_price` (`{markup_percent, rates[]}`) when the item has its own selling price, so the dashboard Edit price dialog starts from it. Absent otherwise.
- **2026-11-01** — Per-customer selling price on a `model_price_list` item (`selling-price.ts`, `PATCH …/subscriptions/:sub/items/:item`, audited `subscription.selling_price_change`): markup and per-combination rows into `price_snapshot.sellingOverride`; a catalog edit never moves it. `current-usage.ts`: meter items list `combinations[]` (segments, cost with `usage_margin:view`), `unpriced_models`, and a projection (linear on sum/count quantity, held level otherwise, linear on amount for event_amount/event_cost, the remaining quantity priced on the dated list pro rata by time); projected amounts carry `estimate: true`. Settlement lines carry their cost to the invoice line. Cover: `verify:model-price-billing` (T10), `verify:usage-margin` (M5, M6).
- **2026-11-01** — `current_usage` meter items add `unpriced_keys[]` (`provider`, `model`, `token_type`): the list key of each default-rate combination where the meter names a token type, so "Set your cost" can prefill it.
- **2026-11-01 (Tier 3 PR 2)** — `splitCreditByFunding` returns a `grants` slice (credit × grant-paid ÷ base, capped at what the invoice still has drawn) that never becomes cash; cancellation and change credits give it back to the grants (`restoreGrantDraws`) and document it as a `credit_grants` discount. The renewal estimate reports `grant_credits_pre_tax_minor` / `grant_credits_post_tax_minor`. Gate: `verify:credit-grants`.
- **2026-11-02** — `createSubscription` refuses past a test business's subscription limit (`tenancy/test-limits.ts`, 400 `test_business_limit_reached`). Live businesses are not limited.
- **2026-11-02 (0481)** — `billing_rules_config` (`billing-rules-config.ts`, pure resolver; absent = today). Trial end: a plan price without `trial_end_action` follows `trial_end_action` (activate | cancel | pause; pause = `pauseAtTrialEnd`, no invoice, a resume bills the first term); `editTrialEnd(immediately)` passes `endTrialNow` and always activates. A `specific_date` cancel's credit defaults to `specific_date_cancel_final_period` (absent → `default_credit_option_for_cancel`). `failed_change_charge: next_renewal` pauses dunning on a failed change invoice until the term ends (`holdFailedChangeCharge`). `mandate_revoked`: `planFailureRearm` parks (`request_new_mandate`) or exhausts a `revocation_of_authorization` / `debit_not_authorized` decline, and `applyDunningFinalAction` swaps the subscription half for cancel now / cancel at term end / pause. Gate: `verify:settings-billing-rules`.
- **2026-11-02 (0481, review fixes)** — Revoked mandates: with `mandate_revoked` other than `follow_dunning`, `presentationBlock` refuses a PM whose last presented attempt was a revocation (every path, until a success or a re-vault; `collectInvoice` books a `provider_key='none'` refusal) and the park deadline treats revocation codes as a dead card. The end-action override reads `invoices.dunning_exhausted_code` (written by the three failed-charge writers), not the newest failed row. Async exhaustion (settlement, webhook reversal) runs the revoked-mandate action after commit (`scheduleRevokedMandateAction`). The parked sweep runs the end action when its own deadline attempt exhausts the invoice. `failed_change_charge`: the hold is now `invoices.retry_hold_until`, set at creation and honoured by all three writers (`heldRetry`), and skipped on a term reset. Gate: `verify:settings-billing-rules` (56 checks).
- **2026-11-02 (0481, second review)** — The revoked-mandate block clears on `payment_methods.authorized_at` (stamped on a same-card re-vault onto a new token and on a mandate going live) as well as `credentials_changed_at`. A late-failure reversal keeps `failure_code = 'late_failure'` (disputes read it) and stores its normalised decline in `payments.reversal_code`; the block and the park deadline's dead-card test read it. Every exhaust write now sets `dunning_exhausted_code` (null when no decline ended dunning). `resumeDunning` clears `retry_hold_until`. `payment_failed` and `invoice_payment_due` publish the retry date actually written. Deliberate change: the park deadline sweep now runs the end action when its own attempt ends dunning, under `follow_dunning` too. Gate: `verify:settings-billing-rules` (64 checks).
- **2026-11-03 (settings slice F)** — Dunning end action (2.17): `final_action.subscription` adds `cancel_at_term_end`, `pause` (resumed by hand, billing as today's manual resume) and `stop_charging` (auto-collection off); term end and pause need an active subscription, else cancel now; a revoked-mandate action that cannot apply falls back to the configured end action. Dunning never pauses a subscription set to cancel (deliberate change, also for `mandate_revoked = pause`). `resumeSubscriptionWithOptions` updates only from `paused`. Adaptive cadence (2.59): `dunning_config.adaptive_cadence`; a custom generic list parks after its length + 1 attempts. Schedules by method (2.48): `retries_by_method` {card, bank_debit ≤5, offline} via `dunningMethodKind` / `retryDaysForMethod` in `planFailureRearm`, parked reminders, offline reminders and reactivation; with a card or bank-debit schedule set, a switched instrument kind is indexed by its own attempts (`priorMethods`), capped at the longest list. `collection-rules-config.ts` holds 2.12 / 2.15. "Resume automatically when paid" was built and deferred to Phase 3 (see PROGRESS). Gate: `verify:settings-dunning-p2`.
- **2026-11-03 (0489)** — `estimateTax` passes `customers.tax_behavior` (an inclusive customer is quoted no
  tax on top) and the taxed line amounts, so per-line tax rounding previews what the invoice books. Wired at
  the signup, reactivation, trial, change and renewal-forward call sites. Gate: `verify:tax-settings` A2, B.
- **2026-11-03 (0489, review)** — `taxedLineAmounts`: every `estimateTax` site passes the taxed lines net of
  their item-level coupon, in the split the invoice books (signup/reactivation, trial change, change charges,
  credit lines on an unbilled term, renewal forward, unbilled-charges cancel). Gross amounts made per-line
  rounding differ by a minor unit. Gate: `verify:tax-settings` F1–F3.
- **2026-11-03 (0489, browser check)** — An inclusive customer's estimate reports the tax inside the
  total (`estimateTax.inclusiveTaxMinor` in `tax_minor`, no `tax_lines`), as the invoice books it; it was
  quoted 0. Gate: `verify:tax-settings` G (US sales tax and VAT).
- **2026-11-03 (settings open bugs)** — `POST …/estimate` returns `priced_at` and `quote`;
  `POST …/change` takes both (`price-quote.ts`, shared with the portal), only on a change applied now
  without `at` (else 400): books at `priced_at` (≤ 15 min), 409 `param: "quote"` when an amount moved or
  a renewal came after `priced_at`. Neither field = as before. `estimateRenewal` prices a scheduled change that lands at or before the
  renewal (`itemsAfterScheduledChange`: `estimateChange`'s item plan plus CAT-3, rated through
  `planSubscriptionPeriodInvoice({ items })`), names it in `estimate.scheduled_change`; a pause, two
  changes or a term-reset change give null + `onUnpriced` (`unpriced_scheduled_change` on the route),
  `ignore_scheduled_changes=false` 400s on those only, `true` prices today's items. A removal of a
  mandatory add-on is unpriced too. Our notices, mandate sizing, AFA and `mandate_shortfall` use
  `estimateRenewalCeiling` (the higher of today's and the post-change items); the proactive gateway
  notice on an exact-amount rail uses the expected amount. Gates:
  `verify:settings-plan-change-rules` Q, `verify:scheduled-changes` 13, `verify:subscription-api-params`.
- **2026-11-03** — `event_cost_or_list` items take a customer selling price like `model_price_list`; current usage projects them linearly on the amount, like `event_cost`.
- **2026-11-04 (G3b, 0497)** — Plan changes apply the plan credit rules (`applyPlanChangeCredits`: upgrade full / prorated / next window, downgrade full / next window) and note allowance upgrades in `subscriptions.reset_state`. Pause and resume call the credit clock (`onSubscriptionPaused` / `onSubscriptionResumed`: skip, keep granting, shift). Gate: `verify:plan-credit-resets` §6–8.
- **2026-11-04 (G3b)** — `resumeSubscriptionWithOptions` passes `{ startedNewTerm: !inTerm }` to `onSubscriptionResumed`, so the credits clock does not guess a new term from dates. Gate: `verify:plan-credit-resets` §8c.
- **2026-11-04** — Every subscription route that takes an item `quantity` caps it at `LIMITS.quantity` (1,000,000). Gate: `verify:strict-params` § F.
- **2026-11-05** — `reactivateAndBill` / `estimateReactivate` take `onChargeFailure` (`refuse` | `dun`), which overrides `requireSuccessfulChargeOnReactivation` for one call (`requiresChargeOnReactivation`, `in-term-reactivation.ts`). A `dun` reactivation whose charge fails returns `paymentError`. Route field `on_charge_failure`. Gate: `verify:create-gating` 10c.
- **2026-11-05** — `POST …/customers/:cus/subscriptions` takes `on_charge_failure` (`refuse` | `dun`, default `refuse`). `dun` skips the charge-first refusal: the first invoice is committed and collected as a renewal is, so a decline leaves the subscription active, the invoice open in dunning, and the 201 carries `payment_error`. `dun` with `on_session` or `payment_intent` is a 400 (`on_charge_failure_conflict`). Gate: `verify:create-gating` 2b.
- **2026-11-05** — A signup paid by an authorized intent whose capture is refused hands its invoice (committed with `collect: false`) to dunning via `handUncollectedInvoiceToDunning`, shared with the reactivation intent path. Before, it was left `payment_due` with no dunning owner. Gate: `verify:create-gating` 2c.
- **2026-11-05** — `POST …/change` takes per-call rules; each omitted one is the business rule. `on_charge_failure` (`start_dunning` | `next_renewal`) → `changeSubscription({ failedChangeCharge })`; `coupons` (`keep` | `drop` | `keep_if_valid`) → `planChangeCoupons` (`couponsLeftBehind({ rule })`); `downgrade_credit` (`credit_balance` | `refund`) → `downgradeCredit` (`refundChangeCredit({ override })`, wins over `customer_chooses`); `plan_credits` / `allowances` → `resetOverrides` (`applyPlanChangeCredits`). `plan_credits` replaces `on_upgrade`, and `on_downgrade` too unless `prorated`; on a downgrade `prorated` and any `allowances` are 400. A change at the end of the term refuses all five (400, the `nowOnly` list): the scheduled change follows the rules when it lands. `/estimate` takes `coupons` and `downgrade_credit` (`estimateChange`'s `planChangeCoupons` / `downgradeCredit`) and reports `change_policy.coupons`, `on_charge_failure`, `plan_credits` and `allowances` (null when nothing applies, `planChangeResetScope`). Gates: `verify:settings-billing-rules` 2.40, `verify:settings-lifecycle` 2.65 / 2.72, `verify:plan-credit-resets` §9b.
- **2026-11-05** — Per-call plan credit rules. `pauseSubscriptionWithOptions` / `pauseSubscription` take `planCreditsOnPause` (route `plan_credits.on_pause`; not a `pause_config` lock key): stored as `reset_state.pause_rule` with the pause, dropped at resume, carried by a deferred pause in `ScheduledPauseOptions`. `cancelSubscriptionWithOptions` takes `planCreditsOnCancelAtPeriodEnd` (route `plan_credits.on_cancel_at_period_end`, end_of_term and specific_date): stored as `reset_state.cancel_rule` tied to `cancel_booked_at`, so a later cancel does not inherit it. The credit clock reads both before the business rule (`pauseRuleOf`, `cancelRuleOf`). Gate: `verify:plan-credit-resets` §12.
- **2026-11-05** — `final_period` on `…/cancel` and `…/cancel_estimate` (specific_date only, not with `credit_option_for_current_term_charges`; 400 otherwise, `cancelOverrideProblem`) maps to the credit option as the business rule does. The cancel estimate now resolves an omitted specific_date credit from `specific_date_cancel_final_period`, as the cancel does (it read `default_credit_option_for_cancel`). `…/schedule` takes no cancel or pause options, so neither field. Gate: `verify:settings-billing-rules` 2.8.
