# payments — charge-outcome settlement

> Source: `src/modules/payments/` · Routes: none (invoked by invoicing/gateway) · Schema: `db/schema/payments.ts`
> Layer: payments (see docs/architecture/architecture.json)

## Purpose
Applies the outcome of a charge attempt to the engine: on success, mark the payment, post ledger
entries, and move the invoice to `paid`; on failure, record the failed attempt and advance dunning.
`payments` is the engine ledger truth for collection (paired 1:1 with a gateway `transaction`).

## Responsibilities
- Settle a succeeded charge (payment row + ledger + invoice `paid`).
- Settle a failed charge (failed attempt + dunning entry + invoice `payment_due`).
- Bridge a transaction outcome into the invoice/ledger state.
- Attribute collected cash (and refunds) to the invoice LINES it settled — `attribution.ts`,
  derived, nothing stored.

## Data model
`db/schema/payments.ts` — `payments` (charge attempts, amount, currency, status, links to invoice +
transaction) and `refunds`. Balances derived from the ledger, not stored here; the
payment→line-item split is derived from `invoice_line_items` and likewise not stored.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `settlePaymentSucceeded` | payment row + ledger + invoice → paid |
| `settlePaymentFailed` | failed attempt + dunning advance + invoice → payment_due |
| `settleTransactionOutcome` | apply a transaction result to invoice/ledger |
| `attributePaymentsForBusiness` | every payment + refund of a business, with its cash placed on the invoice lines it settled |
| `attributeInvoicePayments` | the same, for ONE invoice |
| `allocateProRata` | the pure integer allocator (Σ shares = the amount, exactly) |
| `cancelPendingDebit` / `clearPendingDebits` (`pending-debit.ts`) | ask the gateway to stop a pending debit; book its answer, or refuse the operator action |

## API routes
`POST /v1/businesses/:biz/payments/:pay/cancel_pending_debit` (`payments:refund`, in
`refund-routes.ts`). Everything else is invoked by invoicing (collection), gateway (inbound
reconciliation), and payment-intents.

## Events emitted
`payment.succeeded/failed`, `invoice.paid/payment_due/not_paid`, `invoice.dunning_started/exhausted`.

## Dependencies
- **Upstream (calls into):** events, invoicing, ledger, subscriptions, webhooks.
- **Downstream (called by):** transactions, webhooks.

## Invariants & gotchas
- One charge attempt → one `payments` row **and** one gateway `transaction` row (different concerns).
- **Σ allocations for a payment = the payment amount, exactly, in minor units** (`attribution.ts`).
  A pro-rata share almost never divides, so the leftover units go to the lines with the largest
  absolute remainder, ties by document order — never to a fixed bucket, never to tax.
- All money postings go through `ledger.postEntries` (balanced, append-only); invoice status changes
  ride the same transaction as the ledger entries.

## Changelog
- **2026-11-03** — Stale-pending, AFA recheck and abandon: the gateway status poll joins the
  charge's own span (`joinSpan(txn.spanId)`), so the charge's gateway-log link shows the checks
  that settled it.
- **2026-11-03** — Payment application settings (`application-config.ts`, `billing_rules_config.payment_application`: 2.51, 2.66, 2.69). `settlePaymentSucceeded`'s overshoot branch refunds the part no invoice took after commit when `excess_payment = refund` (`refundUnappliedExcess`, bank debits still held); unset = credit, as before. Gate: `verify:settings-payment-application` § 4.
- **2026-11-02** — `attributePaymentsForBusiness` is a reporting read: it leaves out payments and
  refunds of customers excluded from reporting (0482, `metrics/reportable.ts`).
- **2026-11-02** — **The orphan detector ignores reads.** `ORPHAN_LOG_WHERE` requires
  `method = 'POST'`: RazorPay's `getPayment` logs its GET as `charge`, so a script that read and
  refunded existing payments paged `orphaned_gateway_intents` at 10. `verify:orphaned-intents`.
- **2026-10-31** — **The stale-pending sweep asks only about charges.** `sweepStalePendingCharges`
  selected every `in_progress` transaction with a gateway id, refunds included, and called
  `fetchChargeStatus` with a refund's id (measured on PayU: ~30 status calls in 5 s against a
  60/min limit during a time-travel jump). It now selects `type = 'payment'` only; refunds have
  their own sweep. `verify:stale-pending` X.
- **2026-10-28** — **The stale-pending sweep books a gateway-cancelled debit like the webhook.**
  `applyChargeVerdict` routes a `debit_cancelled` verdict to `bookDebitCancelledIn` (the
  webhook's booking, now runnable in the caller's transaction): invoice stays `payment_due`,
  dunning `stopped`, no `invoice_not_paid`, no refund, no cash. A later webhook is a no-op.
  GoCardless `cancelled` + cause `payment_cancelled` now reports `debit_cancelled` (webhook and
  status read). `adapterForTransaction` moved to `transaction-adapter.ts` and
  `UNAPPLIED_CAPTURE_KEY` to `unapplied-capture-key.ts`: `stale-pending` loads on its own again.
  Conformance rows `S10.echeck-swept-before-webhook` (Authorize.net),
  `S10.cancel-swept-before-webhook` and `S10.dashboard-cancel-webhook` (GoCardless).
- **2026-10-29** — **A debit cancelled at the gateway books like our own cancel.**
  `bookDebitCancelledAtGateway`: a `charge.failed` with `debit_cancelled` on an in-flight
  transaction (a void in the gateway's own dashboard) books failed / `debit_cancelled` with no
  ledger posting, no refund and no dunning re-arm, and stops automatic collection on the invoice.
  Audit purpose `gateway`.
- **2026-10-28** — **`payments.method_type` (0397): which method type paid.** `method-type.ts`:
  `methodTypeOf(result, savedMethod)` = the gateway's `methodUsed` mapped onto `METHOD_TYPES`
  (`apple_pay`/`google_pay` → `card`, `cash_app_pay` → `wallet`, `ach_debit` →
  `us_bank_account`; an unmapped answer is null, never the saved type), else the saved method's
  type. `methodTypeFor(tx, …)` reads the saved type by id when only that is at hand. Written at
  every insert that books a gateway attempt: invoicing (prepaid signup, `bookSuccess`,
  `bookPending`, superseded decline, `recordFailedPayment` — now a required argument),
  collection's declined signup, both intent-consume inserts, `settlement.ts` (the late booking
  and `settleUnmatchedGatewayCapture`), wallet top-ups and payment-request children. Not written
  on offline payments or archival imports. The migration backfills from
  `metadata.payment_method_used`, else the saved method, skipping imported rows.
- **2026-10-27** — **Lost answers on a gateway with no lookup (`replayGate`, `lost-answer.ts`).**
  An adapter with `capabilities.locateByReplay` (Adyen) finds a lost charge by resending it under
  the same key, which makes it if the gateway never received it. The sweep calls it only for an
  invoice collection inside the key window, on an open invoice owing exactly that amount with no
  other pending payment or live intent and a usable instrument, holding the collection claim, and
  passes `replay` (initiator, email). Otherwise it alerts for an operator, on every pass.
- **2026-10-27** — **Lost answers: the instrument, and adoption by lookup (`lost-answer.ts`).**
  `locateCharge` also gets the charged instrument (`paymentMethod.providerPaymentMethodId`), for
  gateways that scope charges by it (Cashfree reads a payment under its mandate), and the id a
  stranded row already holds (`providerChargeId`).
  `adoptLostAnswerByLookup`: a `charge.*` event that matched no row and no ownership ref asks
  `locateCharge` about the business's newest open lost answers (at most 5, same amount when the
  event has one) and adopts the one the gateway names with the event's charge id. For gateways
  whose charges cannot carry our ref.
- **2026-10-27** — **A stranded handle that is not the charge is looked up, then adopted.** A
  `timeout` row holding what the adapter kept (`resolveStranded`) is first asked by reference
  when the adapter has `locateCharge`: a different charge id (Razorpay's payment behind its order
  id) is adopted by `adoptChargeId`, which replaces the handle, and booked. The same id, or none
  found, goes on to `fetchChargeStatus(id)` (entry below); a stranded row is never failed as
  "not created", because the gateway holds an object.
- **2026-10-26** — **A pending debit is cancelled, or the operator action is refused (`pending-debit.ts`).**
  Recording an offline payment, applying credit and an operator's void used to leave a bank debit
  live, and it collected on top. `clearPendingDebits` now asks the gateway first
  (`cancelPendingCharge`): `cancelled` books the payment `failed` / `debit_cancelled` (no ledger
  posting, no payer email, no dunning re-arm — `settlePaymentFailed({ rearmDunning: false })`) and
  stops automatic collection on the invoice; a debit the gateway already settled is booked as such;
  `not_cancelable` / no support refuses with `DebitInProgressError` (409 `debit_in_progress`). An
  in-transaction re-check (`assertNoPendingDebit`) refuses a debit that starts meanwhile. A later
  gateway `charge.failed` for the cancelled debit is `ignored` (transaction already terminal). Every
  cancel writes a `payment.cancel_pending_debit` audit row. Payment-request children are not
  guarded (an overshoot there settles as credit). Gate: `verify:pending-debit-guard`.
- **2026-10-25** — Payment requests (0388): `payments.payment_request_id` marks a child payment (no charge id; the request holds it). `settleTransactionOutcome` settles a transaction that names a request through `settleRequestTransaction`, so webhooks, the stale sweep and operator reconcile reach the request; `settleUnmatchedGatewayCapture` settles a processing request that holds the charge and otherwise books the money as credit, never on an invoice. Child `payment_succeeded` events carry `payment_request`. Async settlement reads the customer's dunning policy (0386).
- **2026-10-24** — The async-settlement failure site passes the dunning hold (`dunningHoldFor`):
  an excluded customer, or an outstanding amount below the currency minimum, does not START
  dunning. An invoice already in dunning keeps its schedule.
- **2026-09-18 (latest)** — **Tax inside a tax-INCLUSIVE price is backed out of the revenue
  bucket.** On an inclusive-priced line the tax sits inside the line's own amount and the document
  carries no `kind='tax'` line for it, so it landed in `recurring`/`one_time` and those cash
  figures — now on five default dashboards — read high by the tax inside them. `attribution.ts`
  splits such a line into TWO weights: its amount net of tax under its own bucket, and the tax
  under `tax`. Money only moves between buckets, so **Σ allocations = the payment** still holds by
  construction, a partial payment's share of an inclusive line is split the same way its cash was,
  and a refund reverses both halves.
  * **The amount comes from `applied_taxes`**, the per-line breakdown the total was actually
    computed from — already backed out of ONE combined rate per component pool, which is the only
    way an India GST component vector closes. Recomputing a rate here would be a second, weaker
    answer. A document's inclusive tax is its applied tax less what its tax LINES printed: zero on
    an exclusive document, which is therefore byte-identical to before.
  * **Carve-outs, not guesses.** An imported invoice has tax lines and no `applied_taxes`, so
    nothing is backed out of it. A line priced inclusive by a region-level override rather than by
    its own price is recovered only when it is the whole document's tax.
  * Gate: `verify:payment-allocation` §4c — a pure inclusive document (120.00 collected → 100.00
    recurring + 20.00 tax), a mixed one (inclusive plan + exclusive setup fee → tax 30.00), an
    exclusive control that must not move, a partial payment and a full refund netting to zero in
    every bucket. **165 ok** (was 107).
- **2026-09-18** — **Payments are attributable to LINE ITEMS, and nothing was stored to do
  it.** `payments`/`transactions` are invoice-level, so an invoice mixing a renewal with a setup fee,
  a proration and tax could say how much was BILLED as recurring (`invoice_line_items.kind`) and
  nothing at all about how much of the CASH was. `attribution.ts` derives it.
  * **DECISION: derive, store nothing.** A `payment_line_allocations` table and a denormalised
    split on the payment row both lose on write-site coverage — there are thirteen
    `insert(payments)` sites across invoicing, payments, payment-intents, wallet and the archival
    importer, and a stored split missing the INTENT path is missing the buyer's own checkout. It is
    also derivable with nothing lost: `ops/invariants.ts:invoice_total_consistent` already holds
    `total = Σ line.amount_minor − Σ item-level discounts` at critical severity, so each line's
    signed contribution is a fact on disk. And a stored row would go stale the first time
    `regenerateInvoice` replaced an invoice's lines, with no writer responsible for repairing it.
    No migration, no new table, no RLS policy — deliberately.
  * **PRO-RATA, not a priority.** Nothing in this engine gives one line of an invoice seniority
    over another (no per-line dunning, no per-line write-off, no instruction on the payment), and a
    priority rule would make the recurring share of a half-paid invoice 100% until the plan line was
    covered — overstating recurring cash on exactly the dunning-stressed invoices a revenue report is
    asked about. Pro-rata also COMPOSES: two partial payments attribute the same as one payment of
    their sum, so an invoice settled in instalments tells the same story as one settled at once.
  * **The remainder is absorbed by the line that was owed most of it.** Each line takes its share
    truncated toward zero; the leftover units (strictly fewer than the number of lines) go one at a
    time to the largest absolute remainder, ties by `seq`. Sign-safe, so a negative line — a
    document-level discount, an "Unused time" credit, a net-negative tax component — takes a negative
    share and the total still closes exactly.
  * **Refunds run the SAME allocator** over the same weights with a negative amount, so a net figure
    cannot be assembled from two rules that disagree and a fully refunded payment nets to zero in
    every bucket. Cash with nothing to sit on (no invoice, no lines, or weights summing to zero) is
    reported as `unattributed` rather than guessed at or dropped.
  * Buckets mirror `invoice_line_items.kind` one-for-one. `recurringMinor = recurring + proration`;
    `nonRecurringMinor = one_time` ONLY, matching the billing-side one-off convention so the cash and
    billed figures are comparable; metered `usage` is its own third bucket, because it recurs without
    being a fixed fee and neither answer is right for every reader.
  * Gate: `scripts/verify-payment-allocation.ts` (`pnpm verify:payment-allocation`, **98 checks**),
    registered in `verify-all.sh`. The invariant is asserted on every attribution the suite produces
    — full payment, indivisible partial payment and its remainder, a four-kind mixed document, a tax
    line beside a negative discount line at exactly half paid, both refunds, and an orphaned payment.
- **2026-09-12** — **The stale-pending PROBE IS REMOVED, and it was never the fix.**
  `stale-pending.ts` used to stamp `authentication_required` on any debit still open past a short
  window. That inference is unsound — a gateway's "not now" does not bind its later "yes, now" — and
  on RazorPay it is actively wrong: **Late Authorisation** polls the bank for up to **3 days** and
  authorises retroactively, with no AFA sub-state in their enum and no `payment.pending` webhook.
  Clamp, stamp and `AUTHENTICATION_PROBE_HOURS` are gone; `graceHours` is now
  `needsAfa ? min(rail, AFA_ABANDON_HOURS) : graceHoursFor(...)`, and `SWEEP_SELECTION_GRACE_HOURS`
  + `RAIL_GRACE_HOURS` are exported so a test asserts the real table rather than a re-typed copy.
  - ⚠️ **Two bugs were cancelling each other.** The selection floor (48h) sat far outside the probe's
    window (15 min), so rows aged out of selection before the probe could fire. Fixing the floor
    alone — the first thing recommended here — would have ARMED the inference and told buyers their
    bank was waiting on them for every healthy debit still open at 15 minutes. Production confirms
    the starvation: 0 RazorPay rows below ₹15,000 carry `authentication_required`.
- **2026-09-07** — `orphaned_gateway_intents` GAINED A SECOND POPULATION and is no longer
  Stripe-only. `intent.created` is emitted by Stripe alone and no new webhook fixes that — neither
  RazorPay nor PayPal sends one for an object merely created — so the detector now also reads our own
  `gateway_request_logs`: a 2xx `charge`/`create_intent`/`create_setup_intent` whose response named an
  id, past the same grace period, with nothing local naming it. ⚠️ The trace clause is what makes it
  usable and it was MEASURED: reading a null trace as reportable put 342 rows in on the dev database
  (568 unmatched by id — 530 RazorPay orders, 38 PayPal captures — of which every one carrying a trace
  was correctly excluded, count ZERO), because RazorPay creates an order then a payment and we record
  the payment. Trace now required; population reads 0 of 14,100 logged creates. Rows carry a `source`
  (`webhook` | `request_log`) — one is looked up by event id, the other only by trace. `scripts/void-
  orphaned-intent.ts` is the matching operator lever, and refuses any id we hold a record of.
- **2026-09-07** — A VOID CLEARS `orphaned_gateway_intents`. The predicate asked only
  whether we hold a local row, never what the intent's state at the gateway is — so an operator who
  did exactly what the alert text prescribes ("either void it or let the capture arrive") watched the
  count stay put until the 7-day lookback rolled past, with no second action available and a handled
  orphan indistinguishable from a new one. Two production intents sat amber that way on 2026-09-06.
  Now excluded once a later `intent.voided` names the same intent, correlated through
  `normalized.providerIntentId` so `charge.expired` (payload object = a Charge) works too. ⚠️ Stripe
  is the only adapter emitting `intent.created`, so this detector is Stripe-only in practice; the
  file says what a RazorPay equivalent would have to add in the same change.
- **2026-09-04** — Parking an invoice now stamps `invoices.dunning_parked_at` (0232). It is
  the anchor `parkedDunningDeadline` measures a parked window from — a park has no retry to count
  down from, and the due date it used to borrow was long past for every already-parked row. Only
  meaningful while `dunning_status='parked'`; never cleared on the way out, because every park site
  overwrites it. Full decision: `src/modules/subscriptions/README.md`, `docs/PROGRESS.md` #59.

- **2026-09-03** — 🟠 **`settleTransactionOutcome` minted a SECOND payment for a charge that already had
  one, and the unique index turned every such settlement into a 500.** It opened with
  `if (!paymentId) { insert into payments … providerChargeId: txn.idAtGateway }`, so a transaction naming
  a charge a payment already booked violated `payments_provider_charge_uq` and the whole verdict died as
  an unhandled error — measured on an operator `failed` verdict (docs/PROGRESS.md #20). That is the
  ORDINARY state, not a corrupt one: post-#17 the late-authorization path stamps `id_at_gateway` on the
  row it raises while the capture behind it was already booked by `settleUnmatchedGatewayCapture` or by
  the collect path's `bookPending` — two records of one charge, which is what the index is for. New
  `bookedPaymentForCharge` asks the question first and the outcome settles the payment that EXISTS; the
  predicate mirrors the index row for row (NULL, `''` and `provider_key = 'offline'` are outside it, so
  they identify nothing and cannot collide). `settleUnmatchedGatewayCapture` had always done this lookup —
  this is the same question in one place so the two cannot disagree. The collision was never specific to
  the `failed` verdict: the insert sat ABOVE the outcome branch, and a `succeeded` verdict on an
  already-booked charge 500s identically (`#20-D1` measured it), which is why the fix is here and not in
  a verdict branch. Reuse is safe because `settlePayment{Succeeded,Failed}` each claim a `pending` row
  only — and the one thing it must NOT do, stand behind a `failed` verdict over a `succeeded` payment, is
  refused in `reconcileTransaction`. A failure settled against a non-pending row now logs
  `settlement_failure_dropped_not_pending` instead of changing nothing in silence. Gated by 15 new
  `verify:gateway` checks, mutation-tested in two runs.
- **2026-09-03** — 🟠 **A live buyer CHECKOUT on an invoice credited to zero had no policy at all, and
  the docblock said so for the wrong reason.** `abandonZeroDueDebits` keys on
  `transactions.status='in_progress' AND type='payment' AND id_at_gateway IS NOT NULL`, and an intent has
  no transaction row — so a downgrade that zeroed an invoice 47 seconds after the buyer started paying
  was invisible to every pass. The comment ruling `type='authorization'` holds out of scope justified it
  with *"None exist in the measured data"*; that is now **falsified** — four live intents sit on
  zero-owing invoices, ₹1,66,671.60 in total. The out-of-scope REASONING still stands (a hold wants
  releasing at the gateway, not abandoning locally), so a fourth pass `releaseZeroDueIntents` voids where
  the adapter allows it and surfaces where it does not. It deliberately writes **no local mark**: setting
  our intent `voided` would claim the money is back — precisely the stale-status failure above — and a
  `needs_attention` row would assert a gateway hold nobody measured. See #16 in `docs/PROGRESS.md`.

- **2026-08-31 (night, later)** — **An abandoned AFA debit is asked about again, because the recovery
  used to depend on one webhook arriving.** When a buyer tells us in the portal that they will not
  approve a debit — or simply lets the bank's 72-hour authentication link lapse — the attempt is booked
  `afa_not_completed` and the invoice is parked. Abandoning is LOCAL ONLY: RazorPay keeps the debit
  `created` and the buyer can still approve it, including by mistake after saying they would not. That
  capture is real money, and `reconcileAbandonedCapture` has always known what to do with it — but it
  was reachable from the inbound webhook and **nowhere else**, as `settleAbandonedCapture`'s own docblock
  admitted ("if the capture happens AND its webhook never arrives, nothing here fires… it is not
  covered"). The main sweep could not cover it either: it selects `in_progress`, and an abandoned debit
  is `failed`. So one lost delivery meant the customer's money was gone with nothing in our books and
  nothing that would ever look again.
  * `recheckAbandonedAfaDebits` is a second pass in `sweepStalePendingCharges` with the same discipline
    as the first — over-select, ask the gateway via `fetchChargeStatus`, never decide — over
    `failed` + `afa_not_completed` rows with a gateway handle, bounded by
    `AFA_RECHECK_UNTIL_HOURS` (the link's own 72h validity + 24h of settle margin, because an approval
    at hour 71 can be reported later and past the window the debit cannot have captured at all).
  * A `succeeded` answer is NOT settled locally. It goes to `reconcileAbandonedCapture` — the same
    function the webhook calls — so "book it, then give back whatever the invoice could not take" has
    exactly one implementation. That function's first parameter was narrowed from the webhook's own row
    type to the four fields it reads, so the sweep passes its row with **no cast**: a cast there would
    compile happily and hide a shape change forever, which on a money path is the wrong trade.
  * A `failed` or still-`created` answer leaves the row exactly as it is — it is already a terminal
    local failure dunning has been told about, and the customer may have paid another way; rewriting it
    would re-notify and re-park for no new information.
  * Gated by `verify:stale-pending` § O, which drives the capture at the gateway and delivers **no
    webhook at all**. Confirmed to FAIL without the pass (`rechecked=0`, `recovered=0`, invoice
    `payment_due`, payment `failed`), and it asserts a second sweep recovers nothing twice, since the
    `failed → succeeded` claim is the only idempotency guard.

- **2026-08-31 (night)** — **`settleUnmatchedGatewayCapture`: money the gateway reports that we have no
  payment row for.** `settleAbandonedCapture` could only resolve a capture for a debit already recorded
  as `failed`; there are two routine ways to have NO row at all, and both were measured. A second
  checkout on one invoice (INV-5510: two RazorPay orders, `pay_XXXXXXXXXXXX01` real money, zero engine
  rows, three ignored webhooks) and a late authorization past our own intent TTL
  (`probe-late-authorization.ts`). It materialises the missing `payments` row — idempotent on
  `payments_provider_charge_uq`, which is what makes the duplicate deliveries book once — and then
  DELEGATES to `settleAbandonedCapture` rather than copying its rules, so there is exactly one
  implementation of "where does this money go": applied to the invoice when it can absorb the whole
  amount, otherwise detached (`invoice_id = null`, or `paidTotals` would credit an invoice with money not
  applied to it) and held as excess-payment credit, refundable via
  `refundPayment({ contraAccount: 'excess_payment_balance' })`. Refuses outright without a real gateway
  charge id: the unique index excludes NULL/`''`/`offline`, so without one a redelivery would book twice.
  ⚠️ Policy note: `reconcileAbandonedCapture` auto-refunds its excess and this path does not — see
  `docs/PROGRESS.md`, it is a decision, not a drift.
- **2026-08-28** — **A capture for a debit we had abandoned is money, and we were throwing it away.**
  Abandoning an AFA debit is local-only — RazorPay cannot void a `created` recurring payment — so a
  buyer who approves the bank's request after we gave up produces a real capture. `reconcileChargeSucceeded`
  gated on `['in_progress','timeout','needs_attention']` and returned `'ignored'` for anything else, the
  same result code as "a CLI test event that isn't ours": no ledger entry, no event, nothing to
  reconcile from, and a customer charged twice. The engine already models the mirror case
  (`late_failure`, the gateway retracting a success we booked) and had no model at all for the gateway
  CONFIRMING a failure we booked. New `settleAbandonedCapture` is that model.
  Where the money goes is decided by what the invoice can still absorb, **all-or-nothing**: it owes at
  least this much → apply it (very often there is no double payment at all — the buyer abandoned, never
  paid, and the debit landed late, and we were dunning them for money they had paid); anything else →
  the whole capture becomes `excess_payment_balance` and the webhook handler refunds it through
  `refundPayment` with `contraAccount: 'excess_payment_balance'`, so the payout CLEARS the liability
  instead of inventing a contra-revenue entry for revenue never recognised. No partial split, and that
  is correctness not laziness: `invoiceOutstanding` derives what is due from the sum of invoice-linked
  payment rows, so such a row must never carry more than the invoice absorbed — but there is ONE
  gateway charge and `refundPayment` caps at one row's `amountMinor`, so a row shrunk to the applied
  slice could no longer refund the rest.
  Two ordering rules, both load-bearing and both found by review rather than by tests: `due` is measured
  BEFORE the `failed → succeeded` claim (otherwise `paidTotals` counts the very payment being settled,
  an untouched open invoice reads `remaining = 0`, and the capture is refunded instead of paying the
  invoice it was raised for); and the claim is the ONLY idempotency guard, so nothing may write before
  it — including the transaction's own status. A failed refund leaves the money as customer credit, a
  real state the balances panel shows. `pnpm verify:stale-pending` cases J–M drive all four landings
  through the REAL inbound pipeline (`triggerSyntheticEvent` → `advanceTmtest`).
  ⚠️ Reachable only from the inbound webhook: the stale-pending sweep selects `in_progress` rows, so an
  abandoned debit is never re-polled. Capture + a webhook that never arrives is still uncovered.
- **2026-08-28** — **An authentication-pending debit now dies when its bank link does, and the buyer
  can end it themselves.** Two changes, one complaint behind them: an INR debit over ₹15,000 waits on
  the buyer's bank AFA link, and while it waits the invoice is blocked. `AFA_ABANDON_HOURS` was 120 —
  the link's 72-hour life plus two days of margin against a debit capturing after we had called it
  dead. The margin was reasoning about a hazard that the link's own expiry already bounds: past 72h
  the debit cannot be authenticated by anyone, so it cannot capture either, and all the extra two days
  bought was a customer staring at a blocked invoice for a payment that had already died. Now 72h
  exactly, with an AFA debit's rail grace CLAMPED to the same figure — without that clamp a card's
  ordinary 96h grace meant the row would not even be selected at the moment its authentication
  expired, and the deadline would silently have become 96h.
  New `abandonAuthenticationPendingDebit` lets the buyer say "I won't approve this" from the portal
  (`POST /portal/v1/invoices/:inv/abandon_authentication`) instead of waiting out a window measured in
  days for a payment they have already decided against. It ASKS THE GATEWAY FIRST, always — a debit
  that has landed is settled as paid and reported back as such, so `outcome: 'settled'` is a real
  answer and the buyer is told rather than shown a Pay-now button for money they have paid.
  ⚠️ The residual hazard is stated where it lives: RazorPay cannot void a `created` recurring payment,
  so inside 72h the buyer could still approve it and it would capture on top of a portal payment.
  Nothing can prevent that; what changed is that it can no longer be SILENT —
  `settleTransactionOutcome` now logs `settlement_dropped_not_pending` when a gateway success arrives
  for a payment that is no longer pending (the boolean it used to ignore), and the portal's confirm
  tells the buyer to decline the bank's request if it still arrives.
  `pnpm verify:stale-pending` covers both (cases A–C, G–I).
- **2026-08-18** — **The sweep is finally testable, and had never once run unattended.**
  `sweepStalePendingCharges` was referenced by a single script — `verify:razorpay-emandate-live`,
  which skips without real RazorPay credentials — and **tmtest had no `fetchChargeStatus`**, so the
  sweep counted every simulated row `unsupported` and did nothing. Both the sweep and the
  AFA-abandon branch added the day before were therefore unreachable offline: a timeout that fails a
  debit and hands it to dunning, never executed.

  tmtest now implements `fetchChargeStatus`, delegating to `replayResult` — already defined as
  "rebuild the ChargeResult this stored row produced", so the poll can never drift from what
  `charge()` said. New `pnpm verify:stale-pending` (12 checks): an unauthenticated card debit past
  the window is abandoned as `afa_not_completed`, non-retriable, invoice parked, **instrument not
  blamed**; the same debit inside the window is polled and left alone; a **netbanking** debit of the
  same age is never abandoned (the abandon is keyed on the rail, not the clock); and a debit the
  gateway did capture still settles. Case A confirmed non-vacuous by disabling the branch — it loses
  four of its six assertions.

  **Fixed while proving it: a swept failure recorded no retriable classification.**
  `setTransactionStatus` had no way to set the column, so `transactions.retriable` stayed null on
  every failure the sweep discovered — and null there means "not a failure, or predates the column",
  which is what the Retries screen reads for its Hard/Soft column. Both sweep branches now persist it.

- **2026-08-17** — **`stale-pending` may now overrule the gateway, in exactly one case.** Its rule
  was "a gateway that still says pending is left alone, however old the attempt" — right for a slow
  rail, wrong for an RBI additional-factor debit, which waits on a *person*. Once the issuer's AFA
  link expires (72h) that payment can never be authenticated, but RazorPay keeps reporting `created`
  forever, so deferring to it meant the invoice parked permanently with dunning halted.

  Past `AFA_ABANDON_HOURS` (**120h**) such an attempt fails as `afa_not_completed` → non-retriable →
  parks the invoice for the customer (portal Pay now, or a re-authorised mandate), bounded by the
  business's dunning period like any other parked invoice.

  ⚠️ **The 120h is a safety margin, not a schedule.** RazorPay cannot void a payment stuck in
  `created` (`intentVoid: false`; every cancel route 404s — operator ask 5), so failing locally
  carries no gateway-side guarantee. Calling it dead while it could still capture would let the
  customer pay through the portal and the stale debit land on top — the exact double-charge the
  Pay-now guards exist to prevent. Two days late costs nothing; an hour early charges someone twice.

- **2026-07-15** — `payment_succeeded` event resource now carries `status: 'succeeded'`. Added at
  all three emit sites (settlement async path, invoicing sync collect, payment-intents). Event
  metadata only — no ledger or amount impact.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).

- **2026-08-29** — **the two settlement money-integrity findings are `error`, not `warn`.**
  `settlement_dropped_not_pending` (a capture landed on an abandoned debit — the customer paid
  twice and we booked once, and it cannot self-heal because posting cash against a failed
  payment would corrupt the invariant the claim protects) and `payment_settled_overshoot`
  (charged and owed disagreed at settlement; the excess is now credit nobody asked for). Both
  describe state that is wrong RIGHT NOW and needs a human to reconcile, and both sat at `warn`
  among 122 others where nothing could alert on them. `verify:logging` pins the level by event
  name.

- **2026-09-01** — **third pass: a debit still LIVE at the rail against an invoice that owes
  NOTHING is ended.** The buyer-portal report of 2026-08-31 — four invoices reading "Paid", due
  ₹0.00, each inviting the customer to approve their bank's request in the same row. The portal copy
  was fixed first; copy does not cancel a request, so the mandate stayed live and an approval
  outside our UI would still have collected against an invoice owing nothing.

  ⚠️ **"Owes nothing" is NOT `amount_due_minor = 0`, and the original report's headline figure used
  it.** That column is the ISSUE-TIME collectible, moved afterwards by CREDIT applications only —
  cash never touches it, and `db/schema/invoices.ts` warns in as many words that reading it this way
  "has happened". Keying on it would have covered exactly one producer (the adjustment credit note
  the report came from) and missed every invoice settled by MONEY — a buyer paying in the portal, an
  operator recording a cheque — which is the shape where a live debit on top is a genuine DOUBLE
  collection. The pass uses `invoiceOutstanding`'s rule in SQL instead. Caught by the new gate on
  its first run: under the column predicate the pass examined 0 rows against an invoice reading
  `paid` with the column still at its full ₹56,715.

  Re-measured under the correct rule: **212 non-terminal payments on invoices that really owe
  nothing** (was 211 under the column) — 8 INR card debits totalling **₹2,39,087.90** (was 7 /
  ₹2,06,921.10) plus 204 tmtest USD test rows at $18,258.00. The debit the old reading missed is one
  settled by money rather than by a credit note.

  **A sweep, not a hook on the credit note.** "Owes nothing" has many producers — an applied credit
  note, a portal payment, a cheque, customer credit, a write-off, a void — and each is a site that
  can be added later and forgotten, which is how these four survived `pendingPaymentForInvoice` and
  `CollectionInFlightError` already existing on the collection side. A sweep keys on the CONDITION,
  so an unwritten settlement path is covered on the day it ships and the existing backlog is covered
  too. It decides nothing itself: each invoice goes to `abandonAuthenticationPendingDebit`, the same
  function the portal's "I won't approve this" calls, which asks the gateway first.

  `not_authentication` is left alone deliberately — an ordinary slow settlement WILL land on its
  own, and failing it locally would only make the real settlement arrive as
  `settlement_dropped_not_pending`, losing the booking for money that moved.

  Two related corrections in the same pass: `abandonAuthenticationPendingDebit` now filters
  `type = 'payment'` and orders deterministically. With a bare `limit(1)` and no type filter it
  could pick an in-flight REFUND on the same invoice (3 such rows measured) and answer "no debit to
  abandon" for an invoice that has one. A `type = 'authorization'` hold is deliberately out of
  scope: a hold wants RELEASING at the gateway, not abandoning locally.

  This also closes the peer report of "seven held authorisations nothing alerts on" — measured as
  exactly the seven RazorPay rows in this population (₹2,34,087.90), all AFA-eligible, all closed
  here. No second mechanism. Gated by `verify:stale-pending` § **Q** (a real offline payment settles
  the invoice) and § **Q2** (a sub-threshold debit on the same rail is left untouched).

### 2026-09-02 — the settlement sweeps stopped re-asking the same question every minute

The three sweeps in `stale-pending.ts` each ask a gateway about a transaction and, when the answer
changes nothing, record **nothing**. That is the money policy and it stays: the gateway's opinion
outranks the clock's, and inventing an outcome is the one thing a money sweep must never do.

But recording nothing also meant *remembering* nothing, so the next tick asked the identical
question sixty seconds later, forever. Measured on dev 2026-09-02, on **every** tick:

| pass | examined | resolved |
|---|---|---|
| `stale_pending` | 103 | 0 |
| `afa_recheck` | 30 | 0 |
| `zero_due` | 209 | 0 |

The oldest row was nine days old, so it had been asked about roughly thirteen thousand times. At
10.3s of a 10.6s tick this was **98% of the billing clock** — the same disease as the dead SMTP
relay the circuit breaker was built for: cost proportional to the number of BROKEN things rather
than to the work due.

`poll-schedule.ts` adds the memory between attempts: a widening interval per (transaction, pass),
doubling from 60s to a 1h ceiling. Nothing else changes — no verdict is invented, nothing is given
up on, and the **first** poll of any row is still immediate. Only a repeat of an unchanged answer
is deferred. Measured after: **11,460 ms → 47 ms**, 349 polls → 0, with zero terminal writes in
both cases (the gateway had said nothing terminal, so nothing terminal was written).

Three things are worth carrying forward:

- **Per (transaction, PASS), not per transaction.** Two columns on `transactions` was the first
  attempt and it is wrong: `stale_pending` and `zero_due` select overlapping rows, so one shared
  schedule would let the first defer a row by an hour and thereby hide it from the second — and
  `zero_due` exists to release a live debit against an invoice the customer no longer owes. An
  hour of held buyer funds is not a reasonable price for a saved poll.
- **The write is asserted, not assumed.** `deferPolls` swallows its own failures by design
  (bookkeeping about work must never undo the work), which makes a broken write *silent*: the
  sweeps simply keep their old behaviour and everything looks healthy. The RLS policy was first
  written against `app.organization_id` instead of `app.org_id`; `current_setting` returned NULL,
  the comparison was NULL rather than false, and every insert was refused with nothing to show for
  it. `verify:settlement-poll` asserts the ROW EXISTS for exactly this reason.
- **The exponent is clamped, not just the result.** A cap applied after the multiplication never
  runs — that is what took the mail lane down the same day at 51 consecutive failures.

Gated by `verify:settlement-poll` (35 checks). The refunds sweep
(`refunds/stale-pending.ts`) has the same shape and is deliberately **not** converted: it did not
appear in the measured cost, and the table is keyed so it can adopt this without a migration.

## Orphaned gateway intents — 2026-09-05

`orphaned-intents.ts` answers a question nothing else in the engine can ask: **which intents
exist at a gateway that we have no record of?**

Every other reconciliation path starts from a row of ours. A charge correlates to a
transaction, a refund to a payment, and `unapplied_gateway_money` counts tagged **payments**.
An intent minted during a request that timed out — or that crashed between the gateway's
response and our commit — has none of those. Money is armed and the engine is structurally
unable to mention it.

`payment_intent.created` is the only signal that reaches us in that case, and **it was
arriving all along**: 5,245 of them by 2026-09-05, stored as `type='unknown'` because the
adapter had no mapping for it. That is why a query by name returned nothing and read as "our
endpoint is not subscribed to it". It is now named `intent.created`, and the sweep reads both
that and the historical `unknown` rows.

### The grace period is the whole design

The event fires **before our own transaction commits**, so "no local row ⇒ orphan" is
momentarily true of nearly every payment we make. Asked inline, the question answers *orphan*
for all of them; the alert would open at the size of our payment volume and be muted the same
day. `ORPHAN_INTENT_GRACE_MS` is 15 minutes — far past our own commit, and a floor on false
positives rather than a target for detection speed. Noticing real stranded money fifteen
minutes late costs nothing.

The inbound handler therefore records `intent.created` and **does nothing else with it**. The
row is the entire point: the sweep asks the question later, when the answer means something.

### Only `ownership = 'ours'`, and that is correctness

We stamp the ownership tag in the **create call itself**, not after committing — so an intent
minted during a request that then died is tagged `ours` all the same. The tag is positive
evidence that we armed this money, and it is present in exactly the failure being hunted.

`foreign` is another product on a shared merchant account. Rows with **no ownership key at
all** (126 on 2026-09-05, none newer than 2026-09-03) predate the key being recorded on this
event and can never be classified; counting them would open the alert at 126 and never let it
fall — the permanently-red signal people learn to close.

### It reports; it does not reconcile

An intent is not money — it may never be charged — so the honest action is to make it visible,
not to move funds against a row we cannot explain. A capture that *does* arrive already has a
path (`reconcileUnmatchedCapture`). The operator alert is `orphaned_gateway_intents` (warn at 1,
page at 5); its count and its evidence list share one predicate (`ORPHAN_INTENT_WHERE`) so
they cannot drift.

### Changelog
* **2026-09-15** — every `payment_succeeded` / `payment_failed` emitted from `settlement.ts` now
  names its `invoice` (or, on the detached branches, its `customer`). `events/content.ts` can only
  enrich a payment event from `data.payment.invoice` — the transaction loader matches
  `transactions.public_id` and these events carry a `pay_…` — so the old thin payload reached
  consumers as an amount with nobody to attribute it to, and a consumer dropped four settled renewals
  between 09-09 and 09-13 (answered 200, so never redelivered). Pinned by a static EV-1 gate in
  `verify:events`; `webhooks/inbound.ts` is exempt because it names a `txn_…` the loader resolves.
* **2026-09-05** — `payment_intent.created` named in the Stripe adapter (its own normalize
  branch, so it carries `providerIntentId` and **not** a `providerChargeId` for a charge that
  does not exist), recorded-not-acted-on in `webhooks/inbound.ts`, `sweepOrphanedIntents` run
  from the billing clock after the stale-pending passes, `orphanedIntentsAlert` +
  evidence population, and `verify:orphaned-intents`. First real finding: 7 orphans, three of
  which name a real invoice — two of them intents for `inv_XXXXXXXXXXXXXXXXXXXXXX03`, the
  invoice PROGRESS #62 records as unexplained.
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-28** — `stale_pending_swept` no longer fires on `zeroDueStillLive` / `zeroDueIntentsUncancellable` alone: those count rows that are still stuck, so the line repeated every tick until someone intervened. It still fires for anything the sweep actually settled, failed, recovered, closed or voided.
- **2026-10-03** — `settlePaymentFailed`'s `payment_failed.message` (the payer's `declineMessage`) goes through `storedPayerDeclineMessage`: our internal codes stay hidden and a business's code-level "Tell the customer" override applies. The raw text stays on the payment row.
- **2026-10-05** — `revenue.ts`: `collectedRevenue(org, {customerId}|{subscriptionId})` — succeeded payments minus succeeded refunds per currency, paid-invoice count and first payment date. Feeds customer `lifetime_revenue` and subscription `revenue_to_date_minor`.
- **2026-10-21** — Payment attribution and `recurringAmountsForSubs` chunk id lists to 5,000 per statement (Postgres caps a statement at 65,535 parameters).
- **2026-10-23** — `settlement.ts`: an async failure whose plan is `offline` clears a live `dunning_status` when it moves the invoice to `not_paid`, matching `invoicing/service.ts` (migration 0359 backfills).
- **2026-10-24** — `settlePaymentSucceeded`: a payment marked `metadata.wallet_topup` (a paid top-up's charge) credits the wallet through `wallet.creditSettledTopUp` (cash debit, `excess_payment_balance` credit, `wallet_topups` row, `wallet.topped_up`) instead of the cash/AR posting, then emits `payment_succeeded` with the customer ref. The claim makes it once per payment, whether the top-up settles at charge time, by webhook or by the stale-pending sweep.
- **2026-10-24** — Late returns and reversals a gateway reports only in a settlement report now
  reach the same `reconcileChargeFailed` reversal path through the `settlement_reports` clock
  pass (`gateway/settlement-report.ts`). It complements `stale-pending.ts` (pending charges by
  id) and does not touch it. Gate: `verify:settlement-report-poll`.
- **2026-10-25** — `recheckAbandonedAfaDebits` also rechecks a payment request's charge (no payment row): a capture goes to `reconcileLateRequestCapture`, the webhook's path; the transaction's failed → succeeded flip keeps the two from both booking. Gate: `verify:payment-requests` §17.
- **2026-10-26** — **Lost-answer charges resolve (gateway plan 3d, 0396).** A charge whose answer
  was lost is booked `timeout` with no gateway id; the row now keeps `ownership_ref`,
  `idempotency_key` and the gateway account (`lostChargeHandle`, collection.ts). `lost-answer.ts`
  runs inside the stale-pending sweep (pass `lost_answer` on the poll schedule): after 10 min it
  asks the adapter's optional `locateCharge`. Found → the id is adopted on the transaction,
  payment and payment request, and the answer is booked by `applyChargeVerdict` (shared with the
  pending pass; a pending answer moves the row to `in_progress`). Not found 24 h after the
  attempt → failed `gateway_charge_not_created`, retriable, and dunning resumes. No lookup, or no
  ref recorded → left as it is, one `lost_answer_unresolvable` error per row
  (`lostAnswerAlerted`). Before 24 h a lost answer is never a failure. `verify:engine-gateway-conformance` § L.
- **2026-10-27** — **Gateway plan 3f, engine leftovers.** (1) `lost-answer.ts` also takes a
  `timeout` row whose adapter kept a stranded gateway id. Same 10 min grace; it reads
  `fetchChargeStatus(id)`. Terminal → booked by `applyChargeVerdict` under the row lock (the row
  must still be `timeout` with that id, so a webhook first books nothing twice). Non-terminal →
  left `timeout` and asked again; after 24 h it becomes `in_progress` for the pending sweep and
  the webhook (`lost_answer_still_pending`), never failed on our clock. No `fetchChargeStatus` →
  one `lost_answer_unresolvable` (`no_status_lookup`) per row. (2) New `late-reversal.ts`:
  `postLateReversal` takes back what the payments still hold — paid less refunds not failed less
  dispute cash (moved to AR by `absorbDisputesIntoReversal`) — or the gateway's
  `reversalAmountMinor`, capped at that. `verify:engine-gateway-conformance` § L7–L10, § V.
- **2026-11-01 (Tier 3 PR 2)** — The three `invoice_paid` settlement sites activate the invoice's pending credit grants in the same transaction (`activatePaidCreditGrants`). Gate: `verify:credit-packs`.
- **2026-11-02 (0481)** — The async settlement failure passes `billing_rules_config.mandate_revoked` to `planFailureRearm`, so a revoked mandate reported late gets the same disposition.
- **2026-11-03 (settings slice F)** — The async settlement failure passes the plan policy, the method type, `retries_by_method` and `adaptive_cadence` to `planFailureRearm`. Gate: `verify:settings-dunning-p2`.
- **2026-11-05** — `OFFLINE_EXCESS_CHOICES` (`credit` | `refund`): an operator's per-call choice for offline money above the amount due (`recordOfflinePayment({ excess })`). `excess_payment` still governs gateway payments only. Gate: `verify:settings-payment-application` 4H.
- **2026-11-05** — `attribution.ts`: `REVENUE_TYPES`, `revenueLineInfo`, `foldRevenue` (document discount spread over revenue lines with `allocateProRata`) and `billedRevenueByInvoice`, for the `revenue_billed` / `revenue_collected` measures. Existing buckets and their callers are unchanged.
