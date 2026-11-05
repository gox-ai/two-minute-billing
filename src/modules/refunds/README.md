# refunds — refund execution

> Source: `src/modules/refunds/` · Routes: `src/api/refund-routes.ts` · Schema: `db/schema/payments.ts` (`refunds`)
> Layer: payments (see docs/architecture/architecture.json)

## Purpose
Executes refunds (full or partial) against a prior payment through the gateway adapter, records the
refund + a gateway transaction, and posts the reversing ledger entries. Refundable credit notes route
their payouts through here.

## Responsibilities
- Refund a payment (full/partial) via the adapter; write the refund + transaction + ledger.
- List refunds.

## Data model
`db/schema/payments.ts` — `refunds` (links to the original payment, amount, currency, status, gateway ref).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `refundPayment` | execute a refund via the adapter; record refund + transaction + ledger |
| `listRefunds` | read |

## API routes
| Method · Path | Purpose |
|---|---|
| refund a payment | via `refund-routes.ts` (1 route; also reachable through credit-note refund) |

## Events emitted
`refund.created`, `refund.failed`.

## Dependencies
- **Upstream (calls into):** events, ledger, transactions, webhooks.
- **Downstream (called by):** credit-notes.

## Invariants & gotchas
- Refunds post **compensating ledger entries** (append-only) — never mutate the original payment's entries.
- A refund produces a gateway `transaction` (type `refund`); partial refunds are supported.

## Changelog

- **2026-11-03** — `refundPayment` runs in its own span (`ensureSpan`; a refund inside a
  collection keeps the collection's). The credit-note payout sweep refunds many credit notes
  under one tick trace, so a refund transaction's gateway-log link showed them all.
- **2026-11-03** — `reverseRefund` of a credit-note payout (contra `refunds_payable`, transaction
  stamped with the note) also gives that amount back to the note as credit, once, when the gateway
  confirmed the failure; a refund only not found is flagged (`not_found_state`). A later gateway answer
  for a flagged refund (success in `charge.refunded` / refund records, or `refund.failed`) goes through
  `answerUnconfirmedRefundTx`, which decides under the customer-balance lock on the refund's current
  state; a success that loses its settle claim to the stale sweep asks again. The not-found sweep's
  `reverseRefund({ onlyPending })` claims only a `pending` refund.
- **2026-11-03** — `refundUnappliedExcess` moved here from `webhooks/inbound.ts` (unchanged) so settlement can call it. `ownUnappliedExcess`: what one overpayment can give back of its OWN money (what it credited less what its invoice absorbed — `metadata.overpay_absorbed_minor` / `overpay_absorb_entry` (that absorb's ledger entry), set by the overshoot path — less every later draw on the bucket in entry-id time; other overpayments' absorbs and refunds are not charged to it; never more than the bucket). `refundableExcess` also nets the recorded absorb out of `held`, so an operator refund of an overpayment is capped at its own rest too. On top, `nonCardHeld` (excess from every source that is not provably a card, less those sources' own refunds and recorded absorbs; draws are taken from card money first) caps every card refund of a recorded overpayment — automatic, portal and operator — at `bucket − nonCardHeld`, so bank-debit or offline excess in the same bucket never leaves through a card refund; `refundExcessPayment({ ownLeftoverOnly })` and the automatic `excess_payment = refund` path use it. `listCustomerOverpayments` / `refundCustomerOverpayment`: the customer's `async_overpay` payments on a known, non-bank-debit instrument that still hold credit, refunded whole on request (2.69 `customer_chooses`, portal `GET /portal/v1/overpayments`, `POST …/:pay/refund`; bank debits are left out).
- **2026-10-25** — A payment-request child (no charge id) refunds part of the request's charge: `refundPayment` resolves the charge id and provider through the request and `refundGatewayAccount` the request's gateway account. `chargeAlreadyReturned` sums the children's refunds for a request charge. `refunds/stale-pending.ts` (`fetchRefundStatus`) is unchanged.
- **2026-10-26** — **A lost refund answer is not a refusal.** `refundPayment` catches
  `ProviderIndeterminateError` from the adapter and books the refund as accepted (`pending`, no
  gateway id, transaction `in_progress`, ledger posted) instead of releasing the reservation, so
  a retry cannot refund the same money twice. It is resolved by the `refund.processed` /
  `refund.failed` webhook, matched on the refund's public id that the adapter stamps
  (`ownershipRef`), or by `sweepStalePendingRefunds` after one hour through the new optional
  adapter method `locateRefund`: found → id adopted, then settled / reversed / left; not found →
  reversed (`refund_not_created`). Only rows that have a refund transaction are swept, so a bare
  reservation is never "reversed". Proof: `verify:webhook-inbound` "lost refund" checks.

- **2026-09-29** — **A refund reaches the gateway that took the charge** (`refundGatewayAccount`).
  The account is resolved from the charge transaction, then the payment method, then the
  business's only active account for the provider; two such accounts return null. A payment with
  no payment method (one-off intent capture, import) used to fall to the env-keyed adapter and
  fail with "Stripe is not configured".
- **2026-09-24** — **Excess credit is refunded as excess, never as revenue** (`excess.ts`).
  `refundExcessPayment` draws what a payment left on the customer's excess balance into
  `excess_refund_pending` under the customer lock, then pays out against it; a `RefundError`
  returns it to credit, an unknown outcome keeps it reserved (`excess_refund_pending_clears`).
  Capped by what the payment still holds AND the customer's bucket. `POST /payments/:pay/refund`
  routes a payment on no invoice here and refuses one with neither booking; the webhook's
  automatic excess refund uses the same path. `reverseRefund` now reverses against the account
  the refund's own posting debited — it always credited `refunds`, which re-recognised
  contra-revenue for credit-note and excess payouts and left their liabilities cleared.
  `verify:excess-refund` (28), mutation-tested for the contra account and the customer lock.
- **2026-09-03** — 🟢 **`chargeAlreadyReturned`** — one implementation of "has the money behind this
  gateway charge already come back?", because two that disagreed would be worse than none: each caller
  would be individually defensible while the pair let a refunded charge be booked as revenue. Matches on
  the gateway CHARGE id rather than a foreign key, since `payments` has no `payment_intent_id` and the
  capture records no transaction — the charge id is the one identifier every side carries. Counts
  SUCCEEDED refunds only: a `pending` refund is money that has NOT come back, and counting it would
  invert the very error this prevents. Consumed by the `intent.authorized` staleness guard and by
  `reconcileTransaction`'s refusal of a `succeeded` verdict. See #17 in `docs/PROGRESS.md`.

- **2026-08-29b** — **The sweeper backstop: a settlement webhook that never arrives.** The
  webhook path above resolves an accepted refund only if the callback is delivered. A
  mis-provisioned endpoint or an outage during the window stranded it for ever — and unlike a
  stranded charge the failure is silent, because the money has already left our books and the
  ledger is *right*: the customer is simply never told, and the operator gets no signal.
  - **`fetchRefundStatus?()`** joins `fetchChargeStatus?()` on the adapter interface, implemented
    for all three providers plus the test gateway — RazorPay (`GET /refunds/{id}`, where
    **`processed`** is the settled state, matching the `refund.processed` webhook it mirrors),
    Stripe (`refunds.retrieve`) and PayPal (`GET /v2/payments/refunds/{id}`). All three are
    deliberately **more conservative than their own `refund()` mapping**: only an explicitly
    terminal failure counts as failed, because this poll drives a ledger REVERSAL and an
    unrecognised status must never unwind money that is still in flight. A non-2xx throws rather
    than mapping to `failed` — "we could not ask" is not "it was refused".
  - **`sweepStalePendingRefunds`** (`refunds/stale-pending.ts`) mirrors the charge sweep: oldest
    first, `TICK_SCAN_LIMIT`-bounded, business-scoped, its own clock pass before dunning. Grace is
    **14 days**, set from the slowest ordinary rail (card issuers quote up to 10 working days) so a
    healthy refund is never polled. It never decides an outcome — a gateway still saying `pending`
    is left alone however old the refund is.
  - **`settleRefund` / `reverseRefund` moved to `refunds/settlement.ts`**, so the webhook and the
    sweep drive the identical path — the same reason `payments/settlement.ts` exists. Both are
    conditional updates keyed on the status they expect, so a webhook racing a sweep resolves the
    refund exactly once and the loser posts nothing. `reverseRefund` also fails the refund's
    transaction, which the webhook path had not been doing.
  - Gate: `verify:refund-settlement` grew from 23 to **37 checks** — fresh refund not examined,
    aged refund examined but left alone while the gateway says pending, a lost-webhook settlement
    swept (asserting **no** second ledger posting), a gateway refusal swept into a reversal, and a
    repeat sweep changing nothing.
- **2026-08-29** — **ACCEPTED is the commit point, and settlement is now wired.** A refund the
  provider only accepted (`status: 'pending'` — the ordinary case on cards and bank rails, 5–10
  working days) was in a broken triangle: the row said `pending`, the ledger held **nothing**, the
  emitted `refund_created` event claimed a hardcoded `status: 'succeeded'`, and nothing anywhere
  ever moved it to settled. Committed money was therefore invisible to the ledger indefinitely, and
  the customer was emailed "your refund has been issued" a week early.
  - **The ledger now books on acceptance** (`committed = result.status !== 'failed'`), covering the
    contra/cash pair, the promotional-credit restoration and the refunded credit note. Safe because
    the inverse already existed: `refund.failed` posts a `refund_reversal`. Its guard used to read
    "`pending` never posted ledger lines to undo" and now reverses a pending booking too.
    Deferring instead would have meant replaying that whole block at settlement from creation-time
    inputs (`contraAccount`, `creditNoteId`, `bucketsRestoredByCaller`) that the row does not store.
  - **The settlement webhook was already arriving and being thrown away.** RazorPay
    `refund.processed`, PayPal `PAYMENT.CAPTURE.REFUNDED` and Stripe `charge.refunded` all normalise
    to `charge.refunded`; `applyRefund` found our row by `provider_refund_id` and returned `ignored`
    — correct for an already-settled row, wrong for a pending one. It now settles a pending row via
    a conditional `UPDATE … WHERE status = 'pending'` (so a redelivery or a future sweep cannot
    double-emit), reconciles the transaction to `succeeded`, and emits the new **`refund_settled`**
    event. No ledger work: acceptance already booked it.
  - `refund_created` carries the **real** status, so `emailTypeForEvent` can split it:
    `pending` → `refund_initiated`, else `refund_issued`; `refund_settled` → `refund_issued`.
  - Fixed alongside: the out-of-band refund cap counted only `succeeded` prior refunds, so an
    external refund arriving while one of ours was in flight saw an overstated remaining balance and
    could book against the same money twice. It now counts everything but `failed`.
  - Gate: **`pnpm verify:refund-settlement` (23 checks)** — drives accept → settle → confirm and
    accept → refuse → reverse, asserting the ledger books once and only once. Reachable at all
    because the test gateway grew a magic amount (**minor units ending in 17 → accepted, unsettled**,
    beside the existing `13 → failure`); before it, every refund settled synchronously and none of
    this path could be executed.
- **2026-08-28** — `RefundError` carries an optional `code: 'not_found'`, set only at the payment
  lookup miss (`No such payment: …`). `refund-routes.ts` maps that one code to 404; every other
  `RefundError` stays a 400. Fixes a convention gap measured by `verify:bola`: this route answered
  400 for a payment id that is not in your business, where 20+ sibling per-business routes answered
  404. Never a disclosure (the body was byte-identical to a made-up id) but a 400 meant the caller
  reached the engine. Structural on purpose — a `startsWith('No such')` branch would come undone the
  next time someone rephrased the message. Widening the code to a validation refusal would turn a
  400 into a 404; `verify:bola`'s positive control (the owner over-refunding their own payment must
  still be 400) is what refuses that.
- **2026-08-28** — `contraAccount` accepts `excess_payment_balance`. Same idea as the credit-note
  payout's `refunds_payable`: money booked as a liability to the customer rather than as revenue, so
  paying it back clears that liability. Used by the duplicate-capture refund
  (`settleAbandonedCapture` → `reconcileAbandonedCapture`), where `refunds` would invent a
  contra-revenue entry for revenue that was never recognised. It also falls outside
  `isDirectRevenueRefund`, so the credit-note capacity guard and the `refunded` credit note are both
  correctly skipped — there is no invoice behind this money to credit.
- **2026-08-25** — **A direct payment refund ignored what credit notes already claim on the
  invoice**, so it could pay out cash no payment backed. `refundPayment`'s only ceiling was the
  payment's own gateway remaining (`amountMinor − prior succeeded refunds`), which knows nothing
  about an open refundable credit note covering the same invoice. Measured: a 1,000.00
  invoice ended up with 8.00 paid out **plus 997.00 still claimed** — 1,005.00 of exposure against
  1,000.00 collected. `refundableCapacityForInvoice` already returned the right number (**0
  available**); nothing on this path called it.
  - Now a **direct revenue refund** is additionally capped at that capacity, and refuses with a
    message pointing at the credit note.
  - **A credit-note payout is exempt and must stay exempt**: `refundCreditNote` →
    `payOutRefundsPayable` re-enters `refundPayment`, and that path DRAWS DOWN the claim rather than
    adding a second one. The predicate is `contraAccount === 'refunds' && !creditNoteId` — catching
    the payout too would deadlock the very flow the error message recommends.
  - Gate: `scripts/probe-refund-past-cn-capacity.ts` (exits 1 while exposure exceeds cash collected).
- **2026-07-15** — A **succeeded refund of an invoice-linked payment** now also issues a
  `refunded` credit note documenting the money returned
  (`credit-notes/service.ts::createRefundedCreditNote`, emits `credit_note_created` + `invoice_updated`).
  Created in the SAME tx as the refund row. Guards keep money booked exactly once and avoid a loop
  with the inverse flow: skipped when `contraAccount === 'refunds_payable'` or `creditNoteId` is set
  (i.e. the refund is itself a refundable-CN payout). The CN books NO ledger of its own — this
  function already books dr `refunds` / cr `cash`. Standalone (non-invoice) payment refunds unchanged.
  (`credit-notes/service` imported dynamically to avoid a static import cycle.)
- **2026-07-15** — `refund_created` payload now carries the invoice public id (when the payment is
  invoice-linked), so emit-time event enrichment attaches the invoice/customer/subscription
  snapshots (previously the bare `{refund}` payload enriched nothing and downstream consumers
  couldn't correlate the refund to a customer).
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-07-13** — `refundPayment` now records a failed `refund` transaction + `refund_failed` event
  even when provider/adapter *resolution* itself throws (previously only a provider-side decline was
  recorded — an unresolved provider surfaced as a bare, unrecorded exception). Error messages now
  name the payment's public id. The `mock` provider fallback is gone; an unconfigured provider throws.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-10-25** — `excessHeldByPayment` counts `excess_payment_reversal` (a reversed payment request child giving back its credit), so a reversed payment cannot be refunded from excess again.
- **2026-10-26** — A Stripe refund raised in the gateway dashboard is now booked with its gateway
  refund id in every webhook API version, so `refund.failed` can reverse it; our own pending
  refund settles from a succeeded `refund.updated` / `charge.refund.updated`.
- **2026-10-26** — `ProviderIndeterminateError` from `adapter.refund` keeps the reservation `pending` (it still claims the amount, so nobody can refund twice), is logged as `refund_gateway_indeterminate`, and the route answers 502 retriable instead of 500.
- **2026-10-26** — Gateway plan 3d: the adapter contract on `refund()` now states the three
  outcomes — an answer, `ProviderRefusalError` (nothing created: the reservation is released),
  `ProviderIndeterminateError` (maybe created: it stays). Per-refund `refunds[]` records reverse a
  `failed` refund by id and adopt a lost-answer refund by our tag (webhooks README).
  `verify:engine-gateway-conformance` § R, § C1.
- **2026-11-02 (0481)** — `POST …/payments/:pay/refund` refuses without `reason` when `billing_rules_config.required_reasons.refund` is on. Gate: `verify:settings-billing-rules`.
- **2026-11-03 (settings slice F)** — `reverseRefund` honours `billing_rules_config.declined_refund`. `block` (default) is unchanged. `issue_credit` (new businesses): for a revenue refund of an invoice payment, the refund's documenting credit note reopens as `refund_due` and dr `refunds` / cr refundable credit is booked, so the customer keeps the money as credit and the note claims the invoice's refund capacity. `refund_failed` carries `credited_minor` and `credit_note`. Gate: `verify:settings-dunning-p2`.
- **2026-11-03 (0487, slice F review)** — The reopened credit note is found by `credit_notes.refund_id` (set by `createRefundedCreditNote`). A direct refund of a payment whose declined refund was reopened as credit pays that note out first through `refundCreditNote`; asking for more than the credit is refused.
- **2026-11-03 (slice F re-review)** — `reverseRefund({gatewayConfirmed})`: issue_credit only for a failure the gateway reported (refund webhooks, payment-request refund hook, poll found failed); `refund_not_created` keeps block. `payOutReopenedCredit` relies on `refundCreditNote`'s customer-balance lock and availability check.
- **2026-11-04** — A refused refund records the gateway's reason. PayPal and RazorPay throw
  `ProviderRefusalError` on a definite 4xx (was `failed` with the reason only in `raw`).
  `RefundResult.failureMessage` feeds `errorText` on the `refund_failed` path; the fallback is
  "The payment gateway refused the refund."
- **2026-11-05 (0501)** — `refunds.on_decline` (null = the business rule): `refundPayment({ onDecline })` stores it on the reservation, and `reverseRefund` reads it before `billing_rules_config.declined_refund` (`declineOutcome`), so an async gateway decline honours the call's choice. Route field `on_decline` on `POST …/payments/:pay/refund` (revenue refunds only; held excess always returns to credit, and credit-note payouts keep their own decline handling). Gate: `verify:settings-dunning-p2` (2.15 per call).
