# disputes — chargebacks / disputes (gateway-driven or hand-recorded, ledgered)

> Source: `src/modules/disputes/` · Routes: `src/api/dispute-routes.ts` · Schema: `db/schema/disputes.ts`
> Layer: payments (see docs/architecture/architecture.json)

## Purpose
Tracks card-network disputes / chargebacks and owns their **money side** on the append-only ledger
(ADR-004). Gateway disputes are created and moved **only** by the inbound gateway-webhook pipeline.
The one exception is a gateway with no dispute feed (`capabilities.disputeFeed: false`: Authorize.net,
tmtest): its chargebacks never reach us, so a person records them and their outcome
(`operator.ts`, `source='operator'`). Both paths post through the same `applyDisputeTransition`.
One `disputes` row per dispute, keyed idempotently by `(organization_id, provider_dispute_id)`; an
operator row's key is its own public id.

## Responsibilities
- `handleDisputeEvent(ev, ctx)` — process a normalized `dispute.*` event: upsert the row, drive its
  lifecycle status, and post the balanced ledger entries for the cash movement.
- `recordOperatorDispute` / `recordDisputeOutcome` — the hand-recorded path (see below).
- Read: `listDisputes`, `getDispute`, `serializeDispute`.

## Data model
`db/schema/disputes.ts` — `disputes` (publicId `dsp_…`, org/business/customer/payment/invoice ids,
providerKey, providerDisputeId [unique per org], providerChargeId, `status`
needs_response|under_review|won|lost|closed, reason, amountMinor + currency, `fundsWithdrawn`
`'true'|'false'` flag, evidenceDueBy, openedAt, closedAt, `source` gateway|operator,
`processorReference` — 0394).

## Ledger (accounts are free-form strings — `disputed_funds`, `dispute_losses`)
| Event | Posting | State |
|---|---|---|
| `dispute.created` | *none* | status `needs_response` |
| `dispute.funds_withdrawn` | `dr disputed_funds / cr cash` | `fundsWithdrawn='true'`, status `under_review` |
| `dispute.won` / `dispute.funds_reinstated` | `dr cash / cr disputed_funds` (reversal) | `fundsWithdrawn='false'`, status `won` |
| `dispute.lost` (funds withdrawn) | `dr dispute_losses / cr disputed_funds` | status `lost` |
| `dispute.lost` (funds never withdrawn) | `dr dispute_losses / cr cash` | status `lost` |
| `dispute.closed` | *none* | status `closed` (unless already won/lost) |
| `dispute.won` after `lost` / `closed` | `dr cash / cr dispute_losses` (what the loss booked) | status `won` |
| `dispute.won` with `disputeAmountWonMinor` | reinstate only that; the rest `dr dispute_losses` | status `won` |

Amounts come from what the dispute already posted (its own ledger lines), not from the row.
Cash taken by every dispute on a payment (or on all children of a payment request) is capped
at collected − refunds not failed − cash other disputes took; a late-failure reversal takes
none of the cash a dispute already holds or expensed (it moves that to receivable).

All postings run through `postEntries` (balanced Σdr=Σcr) inside `withTenant`, in the same tx as the
row update + event emit.

## Public surface
| Function | What it does |
|---|---|
| `handleDisputeEvent(ev, ctx)` | process a normalized `dispute.*` event (idempotent) |
| `listDisputes` / `getDispute` / `serializeDispute` | read + serialize |
| `recordOperatorDispute` (operator.ts) | record a chargeback by hand: `created` + `funds_withdrawn` in one tx |
| `recordDisputeOutcome` (operator.ts) | `won` → `funds_reinstated` + `won`; `lost` → `lost` |
| `disputeRecordingFor` (operator.ts) | is the action offered on a payment, and the cap |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/businesses/:biz/disputes` | list (filter `status`, `open`, `payment`) |
| `GET /v1/businesses/:biz/disputes/:id` | fetch one |
| `POST /v1/businesses/:biz/payments/:pay/disputes` | record a dispute by hand (`payments:refund`) |
| `POST /v1/businesses/:biz/disputes/:id/outcome` | `won` / `lost` on a hand-recorded dispute (`payments:refund`) |

## Events emitted
`dispute_created`, `dispute_funds_withdrawn`, `dispute_funds_reinstated`, `dispute_won`,
`dispute_lost`, `dispute_closed`.

## Dependencies
- **Upstream (calls into):** ledger, events, payments/transactions (correlation), tenancy.
- **Downstream (called by):** webhooks (`inbound.ts` routes `dispute.*` here).

## Invariants & gotchas
- **Idempotency is two-layered:** the provider-event dedup in `handleProviderEvent` blocks exact
  replays; the per-dispute `fundsWithdrawn` flag + `status` guard blocks a *double clawback* if a
  gateway re-sends `funds_withdrawn` under a new event id.
- **The invoice is deliberately left untouched on `funds_withdrawn`.** A paid invoice stays paid —
  reopening it would wrongly re-trigger dunning. The chargeback lives on the dispute row + the ledger.
- **Correlation:** `providerChargeId` → `payments.provider_charge_id` (best; yields payment/invoice/
  customer) → `transactions.id_at_gateway` → the inbound webhook's business (best-effort scoping). An
  entirely unscoped dispute (no org determinable) is logged and dropped.

- **Hand-recorded disputes are refused** on a gateway that reports disputes (`operatorRecordsDisputes`
  reads `GatewayDefinition.disputeFeed`, pinned to the adapters by `test/unit/dispute-feed.test.ts`)
  and on a payment that already has a gateway-reported dispute, so one chargeback is never booked
  twice. Amount ≤ captured − refunds (not failed) − disputes (not won), read under the payment's
  `FOR UPDATE` lock. The reverse case (a gateway dispute arriving after a hand record) cannot
  happen on a no-feed gateway; tmtest can do both and is the only place it would double-book.

## Changelog
- **2026-11-03** — Chargeback policy fixes (every business with a policy): the actions run (they
  passed the subscription's PUBLIC id and always failed); a policy cancel takes none of the cancel
  money defaults (no credit, refund, collection or write-off); the cascade skips the customer's
  other cancelled or paused subscriptions; an action is skipped only when the subscription is
  already in a state at least as strong, and a person's pause scheduled later, and every scheduled
  resume after the policy's pause starts, is withdrawn with one `subscription_scheduled_change_removed`. Only new transitions act; nothing is retroactive.
  Reinstating on a won dispute is deferred (PROGRESS).
- **2026-10-26** — **Record dispute (0394).** A person records a chargeback the gateway cannot report
  (`POST …/payments/:pay/disputes`) and its outcome (`POST …/disputes/:id/outcome`), both
  `payments:refund`, idempotent, audited (`dispute.record`, `dispute.mark_won|mark_lost`). The
  webhook switch moved into `applyDisputeTransition` unchanged, so both paths post identical lines
  (`verify:dispute-recording` compares them). `source` + `processor_reference` columns; the list
  takes `payment=`; serialized `provider_dispute_id` is null on an operator row. Dashboard: a
  Disputes card on the payment's transaction page and the outcome buttons in the list drawer.
- **2026-10-25** — A dispute on a payment request's charge (0388) correlates to the newest child the disputed amount reaches (`requestDisputeTarget`); the ledger still posts the dispute amount.
- **2026-07-21** — Module created (Tier-1 final item): full dispute lifecycle + ledger, read API,
  dashboard Disputes log, `verify:disputes`. Review hardening: `lost` guards against an already-`won`
  dispute (a contradictory won→lost no longer books an erroneous loss), and a `closed` event arriving
  while funds are still withdrawn realizes the loss (`dr dispute_losses / cr disputed_funds`) so the
  held asset can't dangle — the ledger self-reconciles under any event order.

- **2026-08-29** — **`dispute_late_funds_withdrawn` is `error`, not `warn`.** A `funds_withdrawn`
  clawback arriving after the case reached `won`/`lost`/`closed` posts nothing — deliberately,
  because posting it once double-credited 3000 for a 1500 chargeback plus a phantom 1500
  `disputed_funds` asset. Posting nothing stays correct; the point of the level is that a real
  gateway notice about real money was accepted and discarded, and this line is the only record
  it arrived. Pinned by `verify:logging`.
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-28** — `GET /v1/businesses/:biz/disputes` takes `open=true` (only `needs_response` / `under_review`, `OPEN_DISPUTE_STATUSES`) and `sort=evidence_due_by` (soonest evidence deadline first, none last; pages by offset because a nullable deadline has no clean keyset). Default order is unchanged. `verify:list-pagination` covers both, including the paged contract under the deadline order.
- **2026-10-08** — The chargeback policy's `stop_collecting` flip emits `customer_updated`, and only when `auto_collection` was not already off.
- **2026-10-26** — New `dispute.updated` transition: refreshes an open case between `needs_response` and `under_review`, posts nothing, and opens the case (event + "initiated" policy) when it is the first word we receive. A loss on a payment already taken back by a late-failure reversal (`failure_code = late_failure`) posts no second cash credit.
- **2026-10-26** — **Dispute money (gateway plan 3d).** A win after a loss credits the loss back
  once. `disputeAmountWonMinor` makes a win partial. Two disputes on one payment, a refund then a
  dispute, and a reversal before or after a withdrawal never take more cash than the payment holds
  (`cashLeftForDispute`, under the payment row lock). The outcome route accepts a gateway dispute
  when the gateway never sends a final state (`disputeFinalState: false`, Mollie). The dashboard drawer still shows the outcome buttons on hand-recorded rows only.
  `applyDisputeTransition` takes `{ disputeStatus, amountWonMinor }`. `verify:engine-gateway-conformance` § D.
- **2026-10-27** — `absorbDisputesIntoReversal(tx, scope, paymentIds, capMinor)`: absorbs the
  disputes on every given payment (a request's children too), at most `capMinor` in all — what
  the payments still hold after refunds. Called by `payments/late-reversal.ts`.
  `verify:engine-gateway-conformance` § V2, § V4.
- **2026-10-27** — **`outcome_settable_by_operator` on the dispute (gateway plan 3f, UI).**
  `disputeOutcomeSettableByOperator(row)`: open status AND (`source: operator` OR the catalogue's
  `disputeFinalState: false`), the same rules `recordDisputeOutcome` enforces. The dashboard drawer
  and the transaction page's Disputes card show "Mark as won / Mark as lost" from this field
  (no gateway names in the UI), with a note on gateway disputes that the gateway does not send the
  result. The confirmation text follows `funds_withdrawn`. `verify:dispute-recording` § O,
  `test/unit/dispute-outcome-settable.test.ts`.
- **2026-10-27** — **Polled and early chargebacks (3g).** A dispute read by the settlement poll
  (`requirePayment`) that matches none of this business's payments is ignored: a poll reads the
  whole API key, and Mollie's booked two other businesses' chargebacks. `funds_withdrawn` on a
  payment still pending with nothing to take throws (retried) instead of marking it withdrawn
  with no ledger. `verify:settlement-report-poll` §8; conformance `S11.chargeback-*` (GoCardless).
