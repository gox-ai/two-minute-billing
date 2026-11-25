# credits

Credit units, credit grants, holds and the access check (Tier 3 PR 2). Design:
`docs/references/LAGO_SPEC/tier3-design/design-G3.md`.

A **credit grant** is one lot of credit for one customer, in money or in a business's own
**credit unit** ("1 credit = USD 0.01"). Grants are `promotional` (given) or `paid` (sold on an
invoice). Invoices use them in a fixed order, they expire into breakage, and every change is a
**movement**.

## Files
| File | What |
|---|---|
| `units.ts` | Pure conversion: face = round_half_up(units × rate); units = round_half_up(money ÷ rate) at the unit's precision. Rate strings ↔ `minor_per_unit_e12`. |
| `planner.ts` | Pure two-phase drawdown, shared by invoice finalisation, the renewal estimate and the live balance. |
| `service.ts` | Unit CRUD, grant insert/void/expire, movements, ledger postings, invoice draws, give-backs (void, refund, credit), pack-line credit notes, reads. |
| `paid-grant.ts`, `packs.ts`, `plan-credits.ts`, `expiry.ts` | Paid grants: manual, packs, activation at the paid sites, plan credits, expiry pass. |
| `balance.ts`, `holds.ts`, `unit-holds.ts`, `access.ts`, `policy.ts`, `spend-limits.ts`, `usage.ts`, `customer-settings.ts` | Live balance, holds, the access check and its policy ladder, settings validation. |
| `reset-windows.ts`, `credit-clock.ts`, `slices.ts`, `allowance.ts`, `reset-settings.ts` | G3b resets: window arithmetic, the credit clock, exact-window slices, allowance windows, the settings shim. |

## Invariants
- **Remaining = Σ movements** (`credit_grant_movements`, append-only: the app role has SELECT
  and INSERT only). No column stores a balance; `credit_grants.status` is lifecycle.
- A grant closes to exactly 0 units / 0 money / 0 cost. The draw that takes the last of the money
  takes the exact remaining units and cost; a partial draw always leaves at least one unit.
  Cost is cumulative: cost drawn so far = round_half_up(cost_basis × units drawn so far ÷ amount).
- Per customer and currency, ledger `credit_grants_promotional` / `credit_grants_paid` =
  Σ movement money (cost for paid) of grants in that category; open pending grants =
  `credit_grants_pending`.
- Paid credit never exists without an invoice (CHECK `credit_grants_paid_invoice_ck`).
- A pending grant has no movements. Activation writes them.
- Everything that reads remaining and then draws, voids, expires or gives back takes
  `lockCustomerBalances` (7401), the lock the invoice commit and the buckets use.
- A linked allowance cuts its windows with its credits item's `windowContext` and `windowAt`,
  so the pair renews at the same instant, pauses included.
- A credits cursor (`next_credit_reset_at`) is a window start from `windowAt` (at a resume: the
  moved end from `pauseShiftOf`), never an old cursor plus the paused time.

## Units with no money rate (0525)
A unit may have no rate (`credit_units.minor_per_unit_e12` NULL, API `minor_per_unit: null`,
`rated: false`). Its credits are counted in units only. Whether a unit has a rate is locked by
its first grant, with currency and decimals.
- **Grant.** `face_minor = 0` and `unit_rated = false` (copied from the unit at insert; CHECK
  `credit_grants_face_rated_ck`: face is 0 exactly when the unit has no rate). The grant's only
  money is its cost basis.
- **Ledger.** Given credit (manual, plan credits, rollover) posts nothing, at grant, void or
  expiry. Paid credit posts at cost only: Dr revenue / Cr `credit_grants_pending` at the sale,
  pending → `credit_grants_paid` at activation, Dr paid / Cr `credit_breakage` at expiry. No
  discount account.
- **Balance row.** `credit_unit_balances` (customer, unit) → `available_steps` = Σ movement
  units of the customer's grants in the unit that are in the row, less usage taken and not
  settled (0526). `recordGrantMovement` moves it in the movement's transaction
  (`moveUnitBalance`), so every write path keeps it. A pending grant has no movement and is not
  in it. Read: `unitBalanceSteps`. A unit with a rate has no row.
- **Only a meter with a credit cost spends these credits** (§ "Usage paid in credits"). They
  have no face, so the planner, the money balance, holds and the policy ladder's grant rung skip
  them (`hasRate`, `ratedOnly`). `availableUnits` of the live balance reports what the gate
  offers now (`unitBalanceAt`). The money limit on free grants does not apply; the unit has its
  own (`credit_config.unit_grant_limits.<unit>`: `max_units`, `alert_above_units`, in the unit's
  smallest step; `checkUnitGrantLimit`, same refusal, audit row and team notification; a
  PATCH that omits the key keeps it). Settings > Credits has a Maximum and an Alert above
  field for each active unit with no rate. An automatic top-up for such a unit buys a pack
  (§ "Holds, the access check and the top-up in units").

## Usage paid in credits (0526)
A meter may have a **credit cost** in a unit with no rate: "an illustration costs 1 credit, an
edit 0.5". Its usage is paid in credits, with no money rating step and no invoice.

| File | What |
|---|---|
| `credit-cost.ts` | Pure: units due, the three cost layers, the late-event rule, the cumulative cost of a unit draw, settlement allocation. |
| `meter-costs.ts` | `meter_credit_costs` and its API (`PUT/GET/DELETE …/meters/{meter}/credit_cost`). |
| `usage-gate.ts` | The gate at ingest, `gatePolicy`, the void give-back, the event's `credit` entry. |
| `usage-settlement.ts` | `settleCreditUsage`, the grace window of a closed grant, the `settle_credit_usage` pass, the invoice's information line, `GET …/customers/{cus}/credit_usage`. |
| `overage.ts` | Usage beyond the credits (0530): the charges for the period invoice, the one-off invoice and its pass, write-offs, the correcting settlement, the full-refund redraw. |
| `overage-price.ts` | `overagePriceFor`: the meter's own usage price on a live subscription, else the unit's overage price (`unitPoliciesFor`), else none. |

- **Cost.** `meter_credit_costs`: the meter's own row (no product, no subscription), a row per
  plan (`product_id`) and a row per subscription. The most specific wins: subscription, plan,
  meter (`resolveCreditCost`; the customer's live subscriptions, oldest first). Every row of a
  meter names one unit. Only a `count` meter or a `sum` that is not recurring. A meter is paid
  in credits or in money: the PUT refuses a meter that a price bills, and a price refuses a
  meter with a credit cost (`meterForPrice`).
- **Units due.** round_half_up(quantity × credits per unit) to a step of the unit, per event.
- **The gate.** Ingest loads the cost with its meters (two left joins on the read it already
  makes; a meter with no cost adds no query and no lock). For an event of such a meter,
  `gateCreditUsage` runs in the transaction that stores the event: it locks the customer's
  `credit_unit_balances` row (`FOR UPDATE`, customers and units in a fixed order), decides the
  events in order, updates the row once and writes one `credit_usage_events` row per event and
  meter. An event is accepted or refused whole, for every meter that counts it. The row is
  never below 0 under `block`.
- **A grant pays only while its window contains the instant.** The row holds only grants that
  have started and are not past their expiry. A grant whose first movement is written before its
  start is marked `credit_grants.out_of_balance` and is not in the row. Before the gate decides,
  it probes for a grant that starts or ends at or before `now` (`unitBalanceDue`, one indexed
  read). If there is one, it takes the customer lock and `bringUnitBalanceToNow`: a started
  grant comes in; for a grant past its expiry, usage is settled and the grant is closed by
  `closeExpiredGrant`, the same function the expiry pass runs (what is left moves to its grace
  row, or is booked out). A grant whose close fails is only marked `out_of_balance`
  (logged, `credit_grant_close_at_gate_failed`). No pass has to run in between.
- **A term plan grant pays until its renewal runs.** The renewal runs some minutes after the
  term end, so a term plan grant stays in the row past its expiry while its subscription is
  `active`, still in that term (`current_period_end` = the grant's expiry) and nothing ends or
  pauses it at that boundary (`awaitsRenewal`: no `cancel_at_period_end`, no scheduled cancel
  or pause at or before it, billing cycles left). The renewal then closes it
  (`settlePlanCycles`: rollover, grace row, expiry) and grants the new term. Usage accepted in
  between is drawn from that grant (`paysUntil` in `allocateUnitDraws`). The wait is bounded:
  the business's usage close wait + `RENEWAL_WAIT_LIMIT_MS` (1 hour, the time after which the
  back office pages a late renewal). After it, or when the subscription does not renew at the
  boundary, the gate marks the grant `out_of_balance` at once and it stops paying; a late
  renewal logs `credit_term_grant_renewal_overdue` at error level. A reset-window grant is not
  covered: the gate closes the old window and the clock grants the next.
- **Not enough credit.** The policy is read only then. The event is refused, but it is
  **stored**, with a `refused` row (reason `insufficient_credit`) and a `credit_usage_refused`
  event that carries the `policy`; the route answers 402 and a repeat of the key answers 402
  again. Before refusing, the gate applies § "Usage beyond the credits": `bill` with a money
  price bills the rest, and inside the overdraft floor the rest goes below zero. `bill` with no
  money price refuses as `block` does: usage is never given away. A customer with no live
  subscription is always `block`
  (`gatePolicy`); a subscriber follows the ladder, and a live grant in the unit with
  `on_exhausted: block` is its grant rung. An event that settles a hold in the unit
  (`ingestUsageEventsTx` with `coveredUnitId`) is never refused for that unit.
- **A refused event is cost, not usage.** The gate sets `usage_events.refused_at` in the
  transaction that stores the event. Every read and fold of usage quantity leaves such an
  event out (`countsAsUsage` in `metering/usage-sql.ts`); the daily cost fold keeps its cost.
  A capture that pays the event clears the mark.
- **Late events.** `credit_config.late_event_grace_hours` (unset = 12, 0 = off). An event that
  arrives within the window of its timestamp is paid first by a grant that was live at that
  timestamp and closed since; any other event is paid by the balance at receipt. An event older
  than 35 days is refused by ingest as before (`timestamp_too_old`, every meter). `backfill:
  true` records the usage and spends nothing (`skipped`, reason `backfill`).
- **A closed grant.** When a grant in a unit that pays usage expires, `bookGrantRemainder` first
  settles (`settleOwnUnitFirst`), then moves what is left out of the balance row into
  `credit_grant_grace` and leaves the grant `active` until `locks_at` = the close + the window.
  Late events take from that row and stay `pending`. The pass then draws them (a `late`
  settlement), books the rest out (`expire`, breakage for paid credit) and sets `locked_at`. A
  void closes the window at once. A unit that pays no meter expires as before.
- **Settlement.** `settleCreditUsage(customer, unit, cutoff)`: under `lockCustomerBalances` and
  the balance row, it draws the `taken` rows from the grants in the drawdown order (a grant pays
  usage received inside its life; `allocateUnitDraws`), writes one `credit_usage_settlements`
  row per meter, one `draw` movement per grant (`settlement_id`) and, for paid credit, Dr
  `credit_grants_paid` / Cr `revenue` at the cost of the units drawn (source `credit_usage`, the
  settlement id). Given credit posts nothing. No discount, no AR, no tax. The rows are marked
  `settled`, so a second run finds nothing. Callers: the `settle_credit_usage` pass (usage
  received before the top of the hour), the period invoice (everything, before the invoice is
  written), and every path that reads what a grant has left (expire, void, rollover, a pack
  credit note).
- **The balance row.** `available_steps` = Σ movement units of the grants that are not
  `out_of_balance` − units `taken` or `pending` − what open grace rows hold. `held_steps` =
  Σ `remaining_units` of the holds with status `held`; `pinned_steps` = the part of it that
  closed grants keep (Σ `credit_grant_grace.held_steps`). The gate offers `available_steps −
  max(held_steps − pinned_steps, 0)`, never below 0. Back-office invariant `credit_unit_balance_matches_grants`
  (critical) checks both.
- **Lock order** (every path, in this order):
  0. `usage_rollup_state` (the fold's lock): only an event void, and a capture by key that
     pays a refused event;
  1. the customer lock, `lockCustomerBalances` (7401);
  2. grant rows and `credit_holds` rows (`FOR UPDATE`);
  3. `credit_unit_balances` rows, by unit id;
  4. `credit_grant_grace` rows, then `credit_usage_events` rows.
  Settlement, a hold create, capture, release and expiry, a grant void and the expiry and
  grace passes take 1 first. The
  gate and an event void take only 3 and 4; when a grant is due, the gate takes 1 before 3. If
  a grant becomes due between its probe and the row lock, it takes 1 only if free
  (`pg_try_advisory_xact_lock`), else it offers nothing for that request.
- **The invoice.** The period invoice of the customer's oldest subscription gets one line per
  meter, kind `credit_usage`, amount 0: "Illustrations: 120. Paid with 120 credits." It covers
  the usage received since the subscription's last such line, up to the period boundary
  (`rating.credit_usage` holds the meter, the unit, the quantity and the credits). The line
  is information: the PDF and the HTML invoice print it under "Usage paid with credits" with no
  amount, outside the line-item table; it is written after tax and has no tax row. The
  dashboard's invoice page still lists it as a line with a 0 amount (not changed yet).
- **A void.** `voidUsageEvent` gives back credits that no settlement drew, and a correcting
  settlement gives back what a settlement drew (§ "Usage beyond the credits").

### Usage beyond the credits (0530)
`overage.ts`, `overage-price.ts`, `splitEventUnits` in `credit-cost.ts`; the settings are the
§ "Settings for usage past the credits" tables.
- **Three states of a unit of usage, one per unit.** `covered`: credits pay it (`units` of a
  part with `source` balance or grace). `billed`: money pays it (`units_uncovered` on part 0,
  `overage_basis` meter | unit, `overage_price_id` or `overage_rate_e12`; it never enters the
  balance row). `overdraft`: taken below zero and not billed (a part with `source` overdraft,
  status `taken`; the row is below zero by it). An overdraft part ends `settled` (a grant paid
  it), `billed` (a one-off invoice, `overage_invoice_id`; its units leave the row) or
  `forgiven` (`zero_reason`). `credit_usage_events_overage_ck` keeps one state per unit.
- **The gate's order** when an event needs more than the row offers: credits first; then
  under `bill` with a money price the rest is billed; else the rest may take the row down to
  the overdraft floor (default 0) as an overshoot; past it the event is refused whole. An event
  that settles a hold is never refused: its rest is billed or is an overshoot past the floor.
  `block` never bills money.
- **The money price.** `overagePriceFor`: the meter's own usage price (a rate, not event
  amounts) on the customer's oldest live subscription wins; else the unit's price per credit;
  else none. A meter may now have a credit cost and a usage price: `meterForPrice` refuses
  only a price that bills event amounts, the credit-cost PUT refuses a meter whose price is on
  a subscription, and the DELETE refuses while a price on a subscription bills the meter.
  `rateMeterItem` never bills a credit-cost meter from its quantity, and the period invoice
  skips its meter price.
- **Before the invoice.** `planOverage` is the one rating: `chargeCreditOverage` writes its
  result, `previewCreditOverage` only reads it (no lock, no write). The planner's
  `creditOverage: "preview"` adds those lines to a plan that cannot be committed (the renewal
  estimate with `include_usage_so_far`, the renewal's collectability probe); `"omit"` leaves
  them out (the default estimate). `creditUsageSoFar` feeds `current_usage.credit_usage`;
  `overageSpend` is the share of the spend measure (billed or not, never an overshoot).
- **The invoice path.** `chargeCreditOverage` runs in its own transaction just before the
  period invoice is planned (not for a preview, an interim or a late-usage invoice): per meter
  and price, the uncovered quantity received before the period boundary becomes one pending
  charge (`unbilled_charges.entity_type` `credit_overage`; the meter price rates the quantity
  with its rate, tiers, package and free units; the unit's price is units × price, half up).
  The planner takes it as a usage line: taxed and discounted as its price, or as a taxable
  charge for the unit's price. Only the customer's oldest live subscription carries it. The
  information line states only the quantity credits paid.
- **Repay first.** The row already offers grants − overshoot, so a new grant or top-up pays an
  overshoot first. Settlement then draws the overshoot parts (`repayOvershootParts`, after the
  covered usage, oldest first, whole or in part) from the grants live now. Units billed in
  money never enter the row, so no grant ever repays them.
- **Floor and reset.** `resolveOverdraftLimit`: customer, then plan, then unit, then 0. The
  reset rule is the unit's `negative_at_reset` (`unitPoliciesFor`). A plan grant in the unit (`insertCreditGrant`, source `plan_cycle`) first writes
  off the overshoot when the reset rule is `forgive` (reason `plan_reset`); `carry` (default)
  lets the grant pay it.
- **No subscription.** `credit_config.no_subscription_usage` (`block` unset, or `as_subscriber`)
  and `no_subscription_overdraft`. Under the unset `needs_payment_method`, the floor is above 0
  only with the unit's price, a saved payment method (`valid` or `expiring`) and no overage
  invoice that is open or written off; `always` needs only the price, `never` keeps it at 0. The
  `bill_credit_overage` pass bills the overshoot (and uncovered units that no period invoice
  carried) on one one-off invoice per customer and unit, once the oldest item is
  `no_subscription_invoice_after_days` old (unset 30),
  or at once after the customer is archived or their last subscription was cancelled. A void
  of that invoice forgives the parts (`invoice_voided`); a write-off keeps them billed and the
  floor at 0.
- **Void after settlement.** `correctSettledUsage`: a `correction` settlement per settlement
  and meter (unique on event, meter, settlement); a `restore` movement on each grant it drew,
  or a restore grant for a grant that closed (expiry: `restore_expiry_months`, unset 12, or
  `never`); Dr revenue / Cr
  credit_grants_paid at the cost returned. A billed money part refuses the void (409), as a
  billed event on a money meter does: issue a credit note.
- **Pack refund.** `pack_refund: full` on a credit note (stored in `credit_notes.pack_refund`;
  the writers' `packRefund`), for an active pack in a unit with no rate (`fullRefundable`): the
  line is capped by the line, the unused cost is voided as before, and the used units are drawn again from the customer's other grants (a `redraw` settlement, as far as
  the row offers past the holds) with revenue at their cost; the rest is written off
  (`full_refund`). The note's own revenue debit reverses the pack's recognised revenue.
- **Paid void with no refund.** `voidCreditGrant({ withoutRefund: { reason } })` (service only):
  Dr credit_grants_paid / Cr credit_breakage at the cost left, a `void` movement with no invoice,
  the reason in the `credit.zero_out` audit row. The roll-forward and the grant's activity read
  it as breakage. A `reason` (void reasons) can be stored with it.
- **Per-unit basis.** `grants_credit.unit_cost_basis` (per cycle, a unit with no rate): a term
  grant written with its invoice is paid credit, cost = units × basis half up, Dr revenue / Cr
  credit_grants_paid; recognised on use, breakage at expiry. Not for a grant that waits for its
  invoice, a reset window or carried credit; the cap "basis ≤ plan fee" is not checked yet.
- **Audit.** Every write-off and zero-out writes `credit.zero_out` with a reason code.

### Holds, the access check and the top-up in units (0527)
`unit-holds.ts`. A customer with no subscription uses all of it, under `block` unless
`no_subscription_usage: as_subscriber`.
- **Access check.** For a meter with a credit cost, `checkAccess` answers in units from
  `unitBalanceView` (the gate's figure at the instant). `no_subscription` is skipped;
  `not_entitled` only when a live subscription has a feature for the meter. The estimate is
  `estimate_quantity` (× the cost that applies) or `estimate_units`; with none, one event of a
  `count` meter, else one step. The answer adds `credits` (`unit`, `credits_per_unit`,
  `cost_source`, `estimate`, `available`, `held`, `unsettled`, `remaining`). `on_exhausted` is
  `unitPolicy` (source `no_subscription` for a pack-only buyer). Short is decided as the gate
  decides it (`shortTerms` + `splitEventUnits`): allowed when it would be billed or stay inside
  the floor.
- **Balance shape.** `available_units[]` of the access check (the balance API) carries
  `held_units` and `unsettled_units` for a unit with no rate; the portal `held_amount` and
  `unsettled_amount`. Available stays what the gate allows now. Each such entry also carries
  `on_exhausted` (`unitShortOutcome`: the gate's rules with no meter): `policy`, `source`,
  `billed` (`all` / `some` / `none` of the meters with a cost in the unit) and
  `overdraft_units`. The top-level `on_exhausted` is the money policy only.
- **Create.** `quantity` or `units` on a meter with a credit cost (`amount_minor` is 400).
  Under the customer lock: the row is made exact, then `in_flight_limit` (`block` only; the
  share and `in_flight_applies` on units), then `insufficient_credit`, then `held_steps +=
  units` and the hold row (`unit_id`, `amount_units`, `remaining_units`, `amount_minor = 0`).
- **Capture** (`captureUnitHold`). What the hold reserves goes back, then the event takes its
  own units in the same transaction. More than reserved takes what the row offers; the rest is
  billed in money or is an overshoot (§ "Usage beyond the credits"), hold `overdraft: true`.
  With `credit_config.capture_over_hold: cap_at_hold` it takes at most the reserved units: the
  rest is forgiven (`zero_reason: hold_cap`, `credits_past_hold` on the event, an audit row).
  `usage_event_id` of an event that paid at ingest: only the reservation moves. Of an event
  the gate refused: it is paid now from the row (`taken`, `received_at` = the capture,
  `refused_at` cleared, folded if the fold had passed it).
- **Leases.** `final: false` on a capture keeps the hold open with `remaining_units` = what the
  step did not use; a step that leaves nothing closes it. `captured_units` adds up.
  `POST …/credit_holds/{hold}/extend` moves the expiry later (`extendCreditHold`). The share
  and the balance count a lease by `remaining_units`. A hold in money has neither.
- **Release, expiry.** Both give back what is still reserved. A hold stops reserving at its
  expiry: `unitBalanceDue` probes for a lapsed hold and `bringUnitBalanceToNow` ends it
  (`expireLapsedUnitHolds`), as does the `expire_credit_holds` pass.
- **A hold pins its grants.** When a grant closes (`beforeOwnUnitGrantChange`) and the open
  holds need more than the grants that stay, the grant keeps that part: its grace row gets
  `held_steps` (`pinFor`), the balance row `pinned_steps`, and `locks_at` is at least the last
  hold's expiry (an extend moves it). With no late-event window the row covers no late event
  and only keeps the pin. A capture takes the pinned units first, as `pending` grace parts,
  so the grant's `late` settlement draws them. Late events take only `available_steps −
  held_steps` of a grace row. A release or expiry lets the pin go (`settlePins`): the units
  stay in the grace row and are booked out with the grant, never spendable. Capture by key of
  a refused event does not use pinned units.
- **A hold in money** (no meter, or a meter with no credit cost) covers nothing of a meter
  with a credit cost: the gate decides the event of its capture. Short = 402
  `insufficient_credit`, no event stored, the hold stays open.
- **Automatic top-up** (`usage-controls/auto-topup.ts`, its README). A named pack price, a
  pack count or "recharge to N units", a threshold in units that the gate checks in its own
  take (`topup_threshold_steps`, `topup_due_at` on the balance row), one run in flight,
  `purchase_limits`, retries of a soft decline. No credit on promise: while a run is open or
  waits for a try, an event the balance does not cover is refused. The grant comes from the
  pack line (source `purchase`, the pack's `expires_after`), so it has no `auto_top_up_run`.
- **Portal.** `credit_config.portal_auto_topup` (unset = off) lets the buyer enable and
  disable such a top-up: `GET /portal/v1/credits` `auto_topups[]`, `POST
  /portal/v1/credits/auto_topup`.

Gotchas:
- Settlement draws a demand from a grant that was live when the event arrived. A draw from a
  grant outside its window logs `credit_usage_settlement_fallback` at error level: the gate
  rules it out, except for a grant written in the same instant as an event in flight.
- The balance is one number per unit: the gate does not read a grant's `applicability`.
  Settlement prefers grants that cover the meter and falls back to any grant
  (`credit_usage_settlement_scope_fallback`, a warning).
- A credit note on a pack line in a unit with no rate voids the units that are left after
  settlement, in proportion to the cost not yet used (`voidPackUnitsForCreditNote`).
- `credit_usage_settlements.seq` is the unique key per customer and meter. Two settlements can
  share a `window_start` on a frozen test clock.

## Settings for usage past the credits, and credit reports (0528, 0529)
The gate, the plan reset and settlement read them (0530, § "Usage beyond the credits").
"Unset = today": no row reads as no overage price, `carry` and an overdraft limit of 0.

| File | What |
|---|---|
| `settings-rules.ts` | Pure: `pickOverdraftLimit`, `pickOveragePrice`, `overageMinorFor`, `policiesIssue`, `voidReasonIssue`, the roll-forward fold. No import of `service.ts`, so unit tests load it alone. |
| `unit-policies.ts` | `credit_unit_policies` (overage price per credit, `negative_at_reset`) and the unit's own overdraft row; the policy fields of the credit unit object; `credit_unit_updated` on a change. |
| `overdraft.ts` | `credit_overdraft_limits` in three layers and `resolveOverdraftLimit` (customer → plan of the oldest live subscription with a row → unit → 0). |
| `void-reasons.ts` | `credit_grant_void_reasons`: the closed list, written in the void's transaction, append-only. |
| `pack-refund.ts` | The guard of a full refund of a pack line that has no re-draw. |
| `reports.ts` | The deferred revenue roll-forward, one grant's activity, runway in units, refused demand. |

- **Overage price** (`overage_minor_per_unit`): money for one credit past the balance, minor units
  ×10^12 like a rate, only on a unit with no rate (a unit with a rate bills through its prices;
  the two exclude each other both ways). Rule for the gate: a meter's own usage price wins over
  the unit's overage price (`pickOveragePrice`); neither = the usage is refused.
- **Overdraft limit** (`overdraft_limit`, plan and customer overrides): a floor on the balance in
  the unit's smallest step, not an amount per window. Only for a unit with no rate (the money
  overdraft stays `credit_config.overdraft_limit_minor`). A plan row needs a product of kind
  `plan`. The gate calls `resolveOverdraftLimit` inside its take.
- **Negative balance at a plan reset** (`negative_balance_at_reset`): `carry` (default) or
  `forgive`. Only for a unit with no rate.
- **Void reasons**: `POST …/void` takes `{ reason, note }` (optional; `other` needs a note); the
  grant object returns `void_reason` or null. Voiding a PAID grant without a refund: see
  § "Usage beyond the credits" (service only, not in the API yet).
- **Full refund of a pack** (`pack_refund: full` on a credit note): the line cap becomes the whole
  line. The unused cost is voided as before; the note's credit adjustment reverses the revenue of
  the used part. The used credits are first drawn again from other grants and only the rest is
  written off: an active pack in a unit with no rate has that re-draw (§ "Usage beyond the
  credits"). Any other pack has none, so its full refund is refused while another live grant in
  the unit has units left. "Credited by credit notes" (`credited_minor`) stays the note amount.
- **Roll-forward**: paid grants only, at cost, by movement kind: grant/activate = sold,
  draw/restore = recognised, expire = breakage, void = refunds (a void with no invoice, paid
  credit voided without a refund, is breakage), rollovers = other. Every customer
  counts, so Σ closing per currency = the `credit_grants_paid` ledger account. Months in the
  business time zone.
- **Refused demand** reads `credit_usage_events` with status `refused`; no usage total, allowance
  or settlement reads those rows.

## Drawdown (design §3.3–3.4)
Eligible: `active`, same currency, live in the usage line's window, applicability matches.
Only `usage` lines that are not true-ups are covered. Order inside a phase: **restore grants →
priority asc → soonest expiry (none last) → promotional before paid → oldest effective_at → id**.
1. **Pre-tax:** promotional and `taxed_at_purchase` grants pay each usage line at its value after
   coupons. Per line, they lower that line's tax base (`TaxableLine.preTaxCreditMinor`).
2. The promotional bucket, on what the grants left.
3. Tax, once.
4. **Post-tax:** `taxed_at_use` money grants pay the line's rest plus the tax charged on it, as
   money. No gross-up.
5. Refundable, then excess.

## Ledger (design §4)
| Event | Posting |
|---|---|
| Promotional grant | Dr `promotional_credit` / Cr `credit_grants_promotional` (face) |
| Draw, promotional | Dr `credit_grants_promotional` / Cr AR (face), source `credit_applied` |
| Draw, paid | Dr `credit_grants_paid` (cost) + Dr `credit_grant_discount` (face − cost) / Cr AR |
| Expire / void, promotional | Dr `credit_grants_promotional` / Cr `promotional_credit` |
| Expire, paid | Dr `credit_grants_paid` / Cr `credit_breakage` (cost) |
| Give-back on refund or credit | Dr `credit_adjustments` (face) / Cr the grant account (face, or cost + discount) |
| Pack-line credit note | Dr `credit_grants_paid` / Cr `revenue` (cost), plus a `void` movement |

Draws post with source `credit_applied` and the invoice's id, so an invoice void's mirror
reverses them; the void then only writes the movements.

## Give-backs
`restoreGrantDraws` returns an invoice's draws (all, or an amount spread in proportion to what
each grant still has out), capped at what the invoice drew less what it already gave back. A
live grant takes its units back. An expired or voided one gives them to a **new** grant with the
same category, cost, unit, treatment and applicability, `source = restore`, drawn first, expiring
after `credit_config.restore_expiry_months` (unset 12; `never` = no expiry). Callers: invoice void (no posting; the mirror did it), `refundInvoiceViaCreditNote`
(all), a cash refund (amount × grant-paid ÷ cash collected), the cancellation and change credits
(`splitCreditByFunding`'s `grants` slice, documented on the note as a `credit_grants` discount).
Grant-paid value never becomes cash.

## Gotchas
- **Grants apply to period invoices and interim (threshold) invoices** (`resolvePeriodInvoiceMoney`):
  grants before tax, the money balance after tax, as on any period invoice. An interim invoice
  takes no coupon and no minimum (those apply on the period's final invoice), and plan credits
  never run on it (`isOwnTermInvoice` is false). `createInvoiceFromLines` (manual, one-time,
  "invoice unbilled charges now") takes none. Gate: `verify:threshold-invoicing` §4.
- The change estimate reads each source invoice's grant columns and outstanding draws, so its
  `splitCreditByFunding` gives the same `credit_grants` slice as the booking
  (`credit_returned_to_grants_minor`). One shape still differs between preview and booking, for
  the promotional bucket too: a downgrade whose new charge nets the credit (the booking splits the
  net credit, the preview the gross). Grants follow the bucket rule exactly in both
  (`verify:credit-grants` §7).
- `taxed_at_use` with a custom unit is refused: a unit drawn after tax would buy less than its face.
- A unit is locked by its first grant: currency, rate and decimals then refuse a change (409).

## Changelog
- **2026-11-14 (engine choices as settings)** — six fixed rules of the credits release are now
  `credit_config` keys, resolved by `resolveCreditEngineRules` (`policy.ts`); unset = the rule
  before: `trial_usage` (`refuse` | `overdraft_only` | `as_paid`), `no_subscription_usage`
  (`block` | `as_subscriber`), `no_subscription_overdraft` (`needs_payment_method` | `always` |
  `never`), `no_subscription_invoice_after_days` (1–90, 30; read per business in the
  `bill_credit_overage` scan), `restore_expiry_months` (1–120 or `never`, 12; one resolver
  `restoreExpiresAt` for the correction and the invoice give-back) and `capture_over_hold`
  (`debt` | `cap_at_hold`: a capture of a hold in units takes at most what the hold reserves; the
  rest is a `forgiven` overdraft part with `zero_reason: hold_cap`, an audit `credit.zero_out`
  row and `credits_past_hold` on the usage event). A trial or pack-only overshoot needs the
  unit's overage price, so one with no paid subscription is always invoiceable. A PATCH that
  omits a key keeps it. Gates: `verify:credit-overage` § 11, `verify:credit-holds-units` § 3b,
  `test/unit/credit-engine-rules.test.ts`.
- **2026-11-13 (0530, usage beyond the credits)** — § "Usage beyond the credits": money
  overage on a credit-cost meter (the meter's price wins, else the unit's price), the three
  states of a unit of usage, the overdraft floor, repay first, the reset rule, the one-off
  invoice pass `bill_credit_overage`, void after settlement (`correction`), `packRefund: "full"`
  (`redraw`), a paid void with no refund, `grants_credit.unit_cost_basis`. Automatic top-up
  retries are configurable and on by default (usage-controls README). With no overage price,
  floor 0, no basis and no option, behaviour is as before, except that a hold-covered event's
  rest is now an overshoot the next grant pays, and a void after settlement is corrected
  instead of refused. Gates: `verify:credit-overage`, `test/unit/credit-overage.test.ts`.
  On the settings track: the gate reads `unitPoliciesFor` and `resolveOverdraftLimit` (plan layer
  included), `pack_refund: full` runs the re-draw, a paid void with no invoice reads as breakage
  in the reports.
- **2026-11-13 (dashboard, credit screens)** — The operator reaches every credits choice that
  had only the API: the meter page's Credit cost card sets the unit, the cost and a cost per
  plan (`PUT/DELETE …/credit_cost`; the subscription overrides go back unchanged and stay
  API only), and removes the cost after a confirm. Customer > Usage controls lists an
  automatic top-up for each active unit with no rate: pack, threshold, fixed packs or
  recharge to N, monthly cap, top-ups per day, payment method, `purchase_limits`, its state
  (a declined try waiting for a retry, the reason it is off) and Enable / Disable. Settings >
  Credits sets `portal_auto_topup` and `late_event_grace_hours`. The meter's events list shows
  an event refused for credit and each event's `credit` entry. A lease in units shows what it
  reserved and captured. Still API only: a schedule trigger for a top-up in units, extending a
  hold. Cover: `test/unit/dashboard-credit-screens.test.ts`.
- **2026-11-13 (0527, holds, the access check and the top-up in units)** — § "Holds, the
  access check and the top-up in units": `unit-holds.ts`, `credit_unit_balances.held_steps`,
  `credit_holds.unit_id` / `amount_units` / `remaining_units` / `captured_units`, leases
  (`final: false`, extend), pinned grants (`pinned_steps`, `credit_grant_grace.held_steps`),
  `held_units` / `unsettled_units` on balances, the portal switch, `unitBalanceView`, `unitPolicy`
  (source `no_subscription`), `refusesWhenShort`. `coveredByHold` on ingest is now
  `coveredUnitId`; a hold in money no longer covers an event of a meter with a credit cost.
  An event refused for credit is cost and not usage (`usage_events.refused_at`). No backfill:
  no production data exists for meters with a credit cost. A unit with a rate, a meter with no
  credit cost, money holds and money top-ups are unchanged. Gates:
  `verify:credit-holds-units`, `verify:credits-gate` § 7, `test/unit/credit-holds-units.test.ts`.
- **2026-11-13 (0528, 0529, step 6 settings and step 7 reports)** — § "Settings for usage past
  the credits": the overage price, the overdraft limit in three layers, the negative balance at a
  plan reset, void reasons, the full refund of a pack; reports: deferred revenue roll-forward,
  grant activity, runway in units (`credit_runway?unit=`), refused demand. `voidCreditGrant`
  takes `reason`. Gates: `verify:credit-settings-reports`,
  `test/unit/credit-settings-reports.test.ts`.
- **2026-11-13 (dashboard)** — Settings > Credits sets `credit_config.unit_grant_limits`: a
  Maximum and an Alert above field for each active unit with no rate, typed in whole units.
  The invoice page shows the `credit_usage` lines in their own block, "Usage paid with
  credits", with no amount, and a credit note does not list them.
- **2026-11-13 (0526, exact gate)** — A grant pays only while its window contains the instant
  of the gate: `credit_grants.out_of_balance`, `bringUnitBalanceToNow`, `unitBalanceDue`,
  `unitBalanceAt` (the live balance's `availableUnits`), `closeExpiredGrant` shared by the
  expiry pass and the gate. `bill` refuses a short event as `block` does until the overage price
  exists (`OVERAGE_IN_MONEY`); `credit_usage_refused` carries `policy`. Free grants in a unit
  with no rate: `credit_config.unit_grant_limits`. One lock order (§ "Usage paid in credits");
  the expiry pass and the grace pass now take the customer lock before the grant row. The
  window fallback of settlement logs at error level. Gates: `verify:credits-own-unit`,
  `verify:credits-gate`.
- **2026-11-13 (0526, term grants at the renewal)** — A term plan grant of a subscription that is
  due to renew pays until the renewal runs, bounded by `RENEWAL_WAIT_LIMIT_MS` past the usage
  close wait (`awaitsRenewal`, `paysUntil`). The live balance lists a unit whose only grant
  waits for its renewal. Gate: `verify:credits-gate` § 10.
- **2026-11-13 (0526, usage paid in credits)** — § "Usage paid in credits": the credit cost of a
  meter in three layers, the gate at ingest (atomic take, `block` refuses and stores the event,
  `credit_usage_refused`), late events (grace window, `backfill`), settlement each hour and in
  the period invoice with revenue at the cost of the units drawn, the grace window of a closed
  grant, the information line. `recordGrantMovement` takes `settlementId`; `bookGrantRemainder`
  returns null while an expiry waits in its grace window; the expiry pass no longer waits for an
  open usage window for a unit with no rate. `credit_config.late_event_grace_hours`. A unit with
  a rate, and a meter with no credit cost, are unchanged. `liveBalance.availableUnits` takes
  off the units that usage took and no settlement drew yet. A grant in its grace window does
  not roll over; the expiry pass grants and rolls the due windows of a window grant in a unit
  with no rate before it books the rest. Gates: `verify:credits-own-unit`,
  `test/unit/credit-usage-own-unit.test.ts`, invariants `credit_unit_balance_matches_grants`
  (now critical) and `credit_paid_cost_matches_ledger`.
- **2026-11-13 (0525, credit units with no rate)** — A credit unit may have no money rate
  (§ "Units with no money rate"): nullable `minor_per_unit_e12`, `credit_grants.unit_rated`,
  the face CHECK, and the real-time balance row `credit_unit_balances`, moved by every grant
  movement. Given credit in such a unit posts nothing; paid credit posts at its cost basis.
  Rollovers (term and reset window) carry units with face 0. `units.ts` gained `hasRate`,
  `unitRate`, `isUnrated`; `balance.ts` gained `unitsLeftAfterDraw` and `ratedOnly`. A unit with
  a rate is unchanged. Gates: `verify:credit-units`, `test/unit/credit-units-without-rate.test.ts`,
  back-office invariant `credit_unit_balance_matches_grants`.
- **2026-11-13 (credits follow the money)** —
  - **Downgrade.** `applyPlanChangeCredits` takes a change applied at or after the term end as
    on the term boundary. Under `next_window`, a change on a window start with no old grant
    running starts the new price at that window (it used to skip it: a term-end downgrade paid
    for the lower plan with no credits for a window). Under `full` / `prorated` at the term end
    the renewal grants the new plan's first window whole. `on_downgrade` takes `prorated`.
  - **`plan_credits.grant_when: invoice_paid`.** `applyPlanCredits` (given the period invoice)
    and the credit clock (`planGrantStart`) write the period's grants `pending` against the unpaid
    term invoice. In the invoice run, before the invoice row exists, a window waits
    (`awaitingInvoiceOf`); any other reader waits out a term younger than an hour with no
    invoice. `activatePaidCreditGrants` → `activatePendingPlanGrants`: opens the grant (promotional
    posting + `grant` movement), keeps its window, voids one whose window ended. A pending grant
    has no movements, so the balance, the access check and holds do not count it.
  - **`plan_credits.on_unpaid_cancel: void_unused`.** The dunning cancel calls
    `voidUnpaidPlanCredits`: pending plan grants are voided always; with `void_unused`, so is the
    rest of each plan grant from the oldest unpaid period on (rollovers stay).
  - **`credit_config.in_flight_applies: other_holds_open`.** `inFlightRefused` skips the share
    when no other hold is open. A PATCH that omits the key keeps it (`keepInFlightApplies`).
  - Unset = before, for each key. A business a person creates starts with `on_downgrade:
    prorated`, `on_unpaid_cancel: void_unused` and `in_flight_applies: other_holds_open`.
  - Gate: `verify:credits-follow-money`.
- **2026-11-13** — A plan change at the instant the old plan's grant started (a frozen test
  clock: signup and upgrade at one simulated time) answered 500: ending the grant at the change set
  `expires_at = effective_at`, which `credit_grants_expiry_ck` refuses. Such a grant is now booked
  out at once (`bookGrantRemainder`, expire) and marked `ended_by_change`; older grants still end
  at the change. `in_flight_limit` message now says what failed: the open holds and this amount are
  more than the part of the balance holds can use. `verify:plan-change-same-instant`.
- **2026-11-12 (0520)** — `paidCreditCostBasisMinor` (line − its discount shares − inclusive
  tax) is the one cost basis for packs, the automatic top-up and manual paid grants (no coupon on
  those). A 100% coupon activates the grant at raise with cost 0. Promotional credit counts a pack
  after its discount. Portal: `POST /portal/v1/credits/quote` and `coupon` on `/purchase`. A flat
  pack bought × 2 now charges two packs, as it grants two. Gate: `verify:credit-packs`.
- **2026-11-03** — Credit scope (2.55): applicability `{ kind: "meters", meters: [key] }` on grants and packs, and `credit_config.credit_scope` (prices or meters) that narrows every all-usage grant. `scope.ts` resolves both when grants load for a draw (`loadPlannerGrants`, `loadBalanceSnapshot`), so the planner and the access check see only `metered`/`prices`; an unresolved meter scope covers nothing. Unset = every usage line, as before. 2.54 (paid credit only after payment) is already the rule for every paid grant (`createPendingPackGrants` writes `pending`, `activatePaidCreditGrants` needs `paid`); no setting added. Gate: `verify:settings-payment-application` § 5.
- **2026-11-01 (0460–0467, PR 2)** — Module created: units, grants, movements, two-phase drawdown
  in the period invoice and the renewal estimate, expiry/void postings, invoice-void restore, the
  pack-line credit-note cap, refund and credit give-backs. Gates: `verify:credit-grants`,
  `test/unit/credits-planner.test.ts`.

## Packs, plan credits, holds and the access check (PR 2, step 4–5)
| File | What it does |
|---|---|
| `packs.ts` | `grants_credit` validation for prices; `createPendingPackGrants` (one pending grant per pack line, in the invoice transaction, + Dr revenue / Cr credit_grants_pending at cost); `activatePaidCreditGrants` (pending → active at the paid time, `activate` movement, Dr pending / Cr paid; the status flip is the once-only guard); the `activate_credit_grants` backstop pass; `assertTopUpLimits` |
| `paid-grant.ts` | `createManualPaidGrant` (C4): a manual invoice with one credit line, the pending grant in its `inTx` hook, and with `mark_paid` `recordOfflinePaymentInTx` + activation in the same transaction |
| `plan-credits.ts` | `applyPlanCredits`, run by `commitSubscriptionPeriodInvoice` after the period's draw: roll over the closing cycle grant, expire the rest and lapsed rolled grants, grant the new cycle; `source_ref` = item + period start, so a re-run grants once |
| `expiry.ts` | the `expire_credit_grants` pass: books an expired grant only once no open usage window starts before its expiry |
| `usage.ts` | `ratedUnbilledUsage` (the next invoice's window, rated through `rateMeterItem` / `rateMeteredItem` up to now), `meterUsageThisPeriod`, `liveSubscriptionForMeter` |
| `balance.ts` | `liveBalance` (§3.5): grants left after a simulated drawdown through `planGrantApplication`, less open holds; `available` also subtracts usage no grant covers and adds the overdraft limit |
| `policy.ts` | the C2 ladder `effectivePolicy`, the in-flight rule, the access codes and their STE messages |
| `holds.ts` | create (under lock 7401), capture (event ingested in the same transaction, `captured_minor` = the money it added), release, list, the `expire_credit_holds` pass; hold events only when an endpoint lists them (`webhooks/subscribed-types.ts`) |
| `access.ts` | `checkAccess` (§3.9): one repeatable-read snapshot, no writes |
| `spend-limits.ts` | the `SpendLimitEvaluator` hook; PR 2 ships the no-op |
| `customer-settings.ts` | zod for `businesses.credit_config` and `customers.credit_settings` |

Gotchas:
- Activation is called after every `invoice_paid` emit (13 sites today, not 8). A new path that marks an invoice paid must call `activatePaidCreditGrants`; the pass catches a miss within a tick.
- The in-flight rule and `insufficient_credit` apply only under the `block` policy. With `bill` a hold only records.
- Holds, the access check, the balance and a manual grant's default `effective_at` read the business clock (`stampNow`: a travel step's pin or the request's time-travel pin). The `expire_credit_holds` pass takes the tick's `now` and `scanBusinessFilter`.
- Plan credits do not run for pending-invoice billing (the period's usage is drawn at close).
- Cycle 1 is granted when the first period becomes billable: with the signup invoice (`isOwnTermInvoice`), at signup when `invoice_immediately: false` defers it (`grantCurrentCycle` in `deferFirstPeriodToUnbilledCharges`), and for a trial at the first paid period (the conversion renewal bills the term; design §3.6 is silent, so a trial grants nothing). `source_ref` keeps every path to one grant per cycle.

- **2026-11-01 (PR 2, steps 4–5)** — Packs and activation at every paid path, manual paid grants, plan credits with rollover, top-up limits, `liveBalance`, holds, the access check, the three passes. Routes: `src/api/credit-hold-routes.ts`, `src/api/portal-credit-routes.ts`. Gates: `verify:credit-packs`, `verify:credit-holds`, `verify:usage-access`, `verify:usage-access-bench`.
- **2026-11-02 (PR 2 fixes)** — Business clock for holds, the access check, the portal balance and grant stamps; the hold expiry pass follows the clock scope. A refundable credit note on a grant-funded invoice gives the grants' share back (`credit_grants` discount, total = the cash part). The pack-line `void` movement carries its invoice. Gates: `verify:usage-access` §5–6, `verify:credit-grants` §8, `verify:credit-packs` §4.
- **2026-11-02 (PR 2)** — Cycle 1 on a deferred first period (`grantCurrentCycle`). Gate: `verify:credit-packs` §4 signup.
- **2026-11-02 (follow-up)** — A pack must be a one-time price of an add-on or a charge: price create and update refuse a plan's price (`validatePriceGrantsCredit` takes the product kind), the portal lists only one-time pack prices of non-plan products, and the price form hides the pack card on a plan's one-time price. Gate: `verify:credit-packs` §2.
- **2026-11-02 (follow-up)** — The portal's pack entry names its `unit` (null for money), so a money pack reads as money ("€20.00 of credit"). Dashboard helpers `packCreditLabel` and `movementCells` (`dashboard/lib/credits.ts`): the Transactions table's Units and Value cells use one formatter and one minus sign. Gates: `test/unit/dashboard-credit-labels.test.ts`, `verify:credit-packs` §2.
- **2026-11-02 (Tier 3 PR 3)** — The default `SpendLimitEvaluator` is the usage-controls one (loaded on first use); `setSpendLimitEvaluator(null)` restores it. `SpendLimitHit` gained `id`, `scope` (customer | subscription | property), `property_key`/`property_value`, `interval`, `mode`, `set_by`, `source`, `amount_minor`, `open_holds_minor`, `resets_at`, `status`. `meterFeature` is exported for % usage alerts. Gate: `verify:spend-limits`, `verify:usage-access`.
- **2026-11-03 (0495, security)** — `credit_config.grant_limits.<CUR>` `{ max_minor, alert_above_minor }` (`grant-limits.ts`): a free grant (wallet `granted` top-up, promotional credit, promotional credit grant on its money value) above `max_minor` is refused with a 400; above `alert_above_minor` it is audited (`credit.large_grant`) and mailed when the `large_grants` team alert is on. Unset = no limit. Settings > Credits. Gate: `verify:grant-limits`.
- **2026-11-04 (G3b, 0497)** — Resets: plan credits and allowances renew on their own clock. `reset-windows.ts` (pure: every window × anchor, the business time zone, the rules), `credit-clock.ts` (one grant per item, price and window start; the `plan_credit_resets` job on `next_credit_reset_at`; `ensureCreditWindows` before the balance, holds, the access check and the invoice read grants; rollover per window on what the window's own usage leaves; plan changes, pause and resume), `slices.ts` (a usage line split at reset-window grant edges; the planner's `exactWindow` grants draw only from slices inside their window), `allowance.ts` (a meter allowance counts its reset window and returns `resets_at`; an upgrade per `allowances.on_upgrade`), `reset-settings.ts` (the §6 settings shim). `applyPlanCredits` grants `term` items only; the expiry pass books reset-window grants. `meterUsageThisPeriod` is replaced by `allowanceUse`. The access check returns `renews_at` and `entitlement.resets_at`; the portal balance `renews_at`. Gates: `verify:plan-credit-resets`, `test/unit/credit-reset-windows.test.ts`.
- **2026-11-04 (G3b gaps)** — **Same as the credits is a link.** An allowance's `reset` may be `{ same_as_credits: true }` (`normalizeAllowanceReset`); `resolveAllowanceReset` turns it, at read time, into the per-cycle credits reset of the subscription's own item for the plan (an active price first; none = `term`), so `meterFeature`, the access check, the entitlement check and `effectiveEntitlements` follow a later change of the price's reset. `creditsLinkRefusal` refuses the link on a plan with no active per-cycle price or with active prices on different schedules (`resetKey`); `linkedAllowanceConflict` refuses a price create, update or restore that splits a linked plan's schedule (catalog). **Calendar pause shift:** `on_pause: shift` no longer skips a calendar item. The window open at the pause runs on by the paused time (its grant's expiry moves); `reset_state.calendar_shifts[item]` holds that window, and `windowAt` runs the next window from the moved end to the next calendar boundary (covered boundaries skipped), then the calendar. That short window follows `first_window` (price override ?? business setting) like a partial first window: full, prorated over its calendar window (`calendarWindowOfShort` + `prorateForRest`, rounded half-up), or nothing until the next full window. Only for the price it was cut for; a resume that starts a new term clears it. Gates: `verify:plan-credit-resets` §8b, §10; `test/unit/credit-reset-windows.test.ts`.
- **2026-11-04** — **Prorated credit amounts round half-up** to a whole step of the unit (`prorateForRest` uses `divHalfUp`): the partial first window, the short window after a calendar pause shift and an upgrade's `prorated` grant. They rounded down before; 100 credits for 20 of 30 days is now 67, not 66.
- **2026-11-04 (G3b allowance pause)** — **Allowances apply pause shifts.** `pauseShiftOf` (pure) cuts the window open at a shifted pause with its moved end; the clock's resume stores it for every reset item (`reset_state.pause_windows`, both anchors), and `windowAt` honors it on both anchors, so a subscription-anchor window keeps its start. A linked allowance (`resolveAllowanceSchedule` → `creditsItem`, carried by `meterFeature`) counts in its credits item's `windowContext`: same windows, same `resets_at` as the credits' next window start. **Decision (user, 2026-11-04):** an allowance with its own reset follows `plan_credits.on_pause`. `shift` moves it by the paused time with the credits' rules (subscription anchor: `shift_ms`; calendar: the open window runs on, then a short window to the next boundary; no amount, so `first_window` does not apply); `skip` and `keep_granting` leave its windows unchanged, because an allowance grants nothing. Its moved window is `reset_state.allowance_shifts[feature]` (`allowancePauseShifts` at the resume; kept only for the `resetKey` it was cut for; cleared by a resume that starts a new term). No migration. Gates: `verify:plan-credit-resets` §11; `test/unit/credit-reset-windows.test.ts`.
- **2026-11-04 (G3b pause follow-ups)** — **Month ends:** a pause shift moves every subscription-anchor boundary on by `shift_ms` (`anchoredWindow` steps the unshifted anchor, then adds the shift). It used to step from the shifted anchor, while the resume moved the cursor by cursor + paused time: on a 29th/30th anchor the two disagreed. For example, a 30 April start and a 5-day pause gave an open window ending 4 June but a next window [5 May, 5 June), a second month of credits for overlapping time. The resume now sets the cursor to the moved end from `pauseShiftOf` on both anchors. A 31st anchor was not affected. **Key name:** `reset_state.pause_windows` (item → price, start, end) replaces `calendar_shifts`; the old key is read as a fallback and carried into the new one at the next resume, never written. **Legacy resumes** (`shift_ms` with no `pause_windows`): `loadLegacyPauses` rebuilds the term's shifted pauses from the `subscription_paused`/`subscription_resumed` events (the last one takes the rest of `shift_ms`), and `foldPauseShifts` (pure) replays them, so the window open at that pause keeps its start for credits items and allowances alike. When the events do not account for `shift_ms`, it logs a warning and the windows step from the shift total, as before. `reset_state` keeps no pause instant after a resume (`paused_at` is cleared). Gates: `verify:plan-credit-resets` §11 (a), (b), (d), (e); unit tests.
- **2026-11-04 (G3b pause at the term start)** — A resume starts a new term only when `current_period_start` is strictly after the pause. Before, a pause at the term-start instant (a signup or a renewal boundary) counted as a new term, so a `shift` resume did not move the windows and cleared the stored pause windows. The other pause comparisons were checked and are correct at that instant: the open-grant match, the window at the pause, the skip gate and the cursor skip. Gate: `verify:plan-credit-resets` §8c.
- **2026-11-04 (G3b resume decides the new term)** — `onSubscriptionResumed` takes `{ startedNewTerm }` from the resume (`!inTerm`) and no longer compares dates. A day-anchored business floors a new term's start to midnight, so a pause at midnight followed by an out-of-term resume the same day gave a new term starting at the pause instant, and the shift was kept. The only caller is `resumeSubscriptionWithOptions`, which every resume path uses (API, portal, scheduled resume, `resumeSubscription`), so there is no fallback. Gate: `verify:plan-credit-resets` §8c.
- **2026-11-05** — `applyPlanChangeCredits` takes `overrides` (`ResetOverrides`, `withResetOverrides` in `reset-settings.ts`): one change's own `plan_credits` / `allowances` rules from `POST …/change`, over the business's. `planChangeResetScope` says whether a change moves a plan that grants credits per cycle or changes a meter allowance (the change estimate's `change_policy.plan_credits` / `allowances`). Gate: `verify:plan-credit-resets` §9b.
- **2026-11-13** — `applyPlanCredits` is `settlePlanCycles` (rollover + expiry of term cycle grants that ended by the period start; locks them; a second run finds none) then `grantPlanCycle` (the new cycle, `grant_when: invoice_paid` pending, windows and activation). A held renewal invoice (usage grace) grants at the renewal and settles at its close. `ratedUnbilledUsage` also rates a held invoice's closed window (lines marked `held`); the access check's period usage leaves those out. Cover: `verify:usage-grace`, `verify:credit-packs`, `verify:plan-credit-resets`, `verify:credits-follow-money`.
- **2026-11-13 (0525 review)** — The portal lists a grant by its units left (a grant in a unit with
  no rate has no face and was skipped) and returns `rated` on a unit balance and `unit_rated` on a
  grant; the portal card shows such a unit in its own row, outside the money figure. `POST
  credit_units` needs `minor_per_unit`: a rate, or an explicit `null` for a unit with no rate; a
  missing field is 400 as before. 0525 adds its two checks NOT VALID and validates them apart.
  Cover: `verify:credit-units`.
- **2026-11-13 (0525 design review)** — Portal `GET /portal/v1/credits`: `transactions` now lists
  the movements of a unit with no rate too (the `unit_rated = true` filter is gone) and each line
  carries `units`, `unit`, `unit_name`, `unit_plural_name`, `decimals`, `unit_rated` (additive;
  `face_minor` is 0 for such a unit). `POST credit_units` without `minor_per_unit` answers 400 with
  what to send; OpenAPI lists the field as required. Dashboard: the unit form creates a unit with
  no money value (`minor_per_unit: null`); the customer Credits card and the portal card lead with
  units, not a money figure of 0, when only such credit is held, and list each figure with its own
  grants (`balanceView`, `creditRows`, `historyAmount`). Cover: `verify:credit-units`,
  `test/unit/credit-units-no-value-views.test.ts`.
- **2026-11-13 (overage before the invoice)** — Money overage shows before it is billed:
  `previewCreditOverage` (same rating as the charge, read-only), `creditUsageSoFar`,
  `overageSpend`; `creditLinesFrom` and `coveredCreditUsage` split out of
  `insertCreditUsageLines`. The renewal estimate no longer queues the charge. Gate:
  `verify:credit-overage` § 10 (estimate = invoice under exclusive and inclusive tax, a
  percentage and a fixed coupon, `grant_when: invoice_paid`; row counts unchanged by a read).
- **2026-11-14** — Plan credits for `failed_change_charge` (`subscriptions/change-revert.ts`).
  `revertPlanChangeCredits`: a change reverted after its invoice failed for good voids the
  plan-credit grants the change opened and gives the old price's grants back as they were (old
  expiry and metadata); a grant whose end is already booked (a same-instant change books it at
  once) returns as a `source: restore` grant with what it had left, to the same expiry, for
  promotional plan credit only (its expiry posted to promotional expense). Under
  `grant_when: invoice_paid` a mid-term change's grant is now held too (`changeGrantStart`: pending
  with no invoice yet); `settleHeldChangeGrants` then links it to the change invoice, opens it when
  that invoice is paid or there is none, and voids it when the invoice is voided. This holds under
  every `failed_change_charge` value. Gate: `verify:change-invoice-revert` §5.
- **2026-11-15** — `activatePaidCreditGrants` also hands a paid invoice to `onInvoicePaid`
  (`subscriptions/pending-change.ts`): a change held for that invoice applies after the commit.
- **2026-11-16** — Team alerts removed: a grant above the alert amount queues the "Large free
  credit grant" notification (`modules/notifications`); `verify:grant-limits` checks the queue row
  and the bell row.
- **2026-11-24** — The balance API states, per unit with no rate, what happens to usage past
  its credits (`available_units[].on_exhausted`, `unitShortOutcome`, sharing `unitTerms` with
  `shortTerms`). The customer Credits page showed the money policy for every unit, so it read
  "Bill usage" for a unit the gate refuses (#445). `verify:credit-overage` checks it agrees
  with the gate.
