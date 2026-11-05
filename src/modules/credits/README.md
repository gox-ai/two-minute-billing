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
| `balance.ts`, `holds.ts`, `access.ts`, `policy.ts`, `spend-limits.ts`, `usage.ts`, `customer-settings.ts` | Live balance, holds, the access check and its policy ladder, settings validation. |
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
in 12 months. Callers: invoice void (no posting; the mirror did it), `refundInvoiceViaCreditNote`
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
