# payment-requests

Ask one customer for several open invoices at once (0388): one gateway charge for the live
total (`mode=charge`) or one link they pay once (`mode=link`). Created by an operator or the
API (`origin: manual`), by the clock when a business combines due retries (`dunning`, setting
2.51), or by the customer in the portal (`portal`).

## Bookkeeping

- Each invoice gets an ordinary **child payment** (`payments.payment_request_id`) with **no
  charge id**. The request holds the charge id (`payment_requests.provider_charge_id`, unique
  per business) and the attempt's one `transactions` row (`payment_request_id`, `payment_id`
  null). So `payments_provider_charge_uq` and the one-charge-one-payment resolvers stay true.
- Application order everywhere: `coalesce(due_date, created_at)`, `created_at`, `id` —
  ascending, or descending with `payment_application.invoice_order = newest_first` (fixed in
  `position` at creation). Credit on
  file first (`applyCreditOnFile`, Credits Flexibility ceilings), then cash; cash fills each
  invoice before the next.
- The live amount is recomputed on every read and charge: an invoice paid, voided or written
  off meanwhile is marked `settled_elsewhere`; when all drop out the request is canceled.
- Charge: lease every invoice (`claimCollection`, id order), refuse over a pending payment,
  apply credit, book one pending child per invoice and the request `processing` before the
  gateway call, one `chargeWithMethod` with `initiator` merchant (API/dashboard) or customer
  (portal), idempotency key `preq_…_attempt_n_pm`. Success settles every child through
  `settlePaymentSucceeded` (an invoice that shrank takes the overshoot path → excess credit)
  and writes one receipt. A decline fails the children as manual attempts (no dunning retry
  spent), reopens the request with `last_payment_error` and mails the link.
  Pending/requires_action/indeterminate → `processing`; the children's pending rows block
  dunning, Collect now and Pay now through the existing guards.
- Manual-payment (auto-collection off) invoices are refused for `mode=charge`. Pre-debit-notice
  rails are refused for a charge in v1 (use the link).
- Offline payment on a request: allocated in order, child payments `offline`, one transaction,
  one receipt; over-amount refused.

## Where gateway events find the request (`gateway-hooks.ts`)

| path | hook |
|---|---|
| webhook success/failure, stale sweep, operator reconcile | `settleTransactionOutcome` → `settleRequestTransaction` (a transaction with `payment_request_id`) |
| late failure (reversal) | `webhooks/inbound.ts` → `reverseRequestCharge`: invoice children reversed (AR/cash), invoices reopen; a no-invoice child gives back the credit it still holds (excess → cash; credit already spent → AR, logged); request reopens |
| gateway refund (`charge.refunded`, no payment row) | `applyRequestChargeRefund`: spread newest invoice first, each capped at its child |
| dispute | `disputes/service.ts` correlate → `requestDisputeTarget` (newest child the amount reaches) |
| child refund (`refundPayment`) | charge id + account resolved through the request |
| `chargeAlreadyReturned` | sums the children's refunds |
| unmatched capture | `settleUnmatchedGatewayCapture`: a processing request settles; otherwise the money is customer credit, never an invoice |
| capture after a failed (AFA) request charge | webhook `reconcileChargeSucceeded` or the AFA recheck sweep → `reconcileLateRequestCapture` → `settleLateRequestCapture`: fresh children pay the invoices still owed, newest first; the rest is refunded. Refused when the webhook's captured amount differs: the transaction is re-coded `capture_amount_mismatch` (both amounts and the old code in `error_text`), so the sweep, which has no amount to compare, and redeliveries skip it; the transaction's failed → succeeded flip makes it idempotent. If the request now holds another charge, booked as credit and refunded |

## API

```
POST /v1/businesses/:biz/customers/:cus/payment_requests  { invoices[], mode, payment_method?, email? }
GET  /v1/businesses/:biz/payment_requests[?customer&status]   GET …/:preq
POST …/:preq/charge | record_payment | cancel | send
Portal: GET /portal/v1/requests, GET /portal/v1/requests/:preq, POST /portal/v1/requests/:preq/pay
```
Events: `payment_request_created|paid|payment_failed|canceled|expired`; child
`payment_succeeded` carries `payment_request`. Expiry: tick pass `expire_payment_requests`
(30 days).

Gate: `verify:payment-requests`.

## Changelog

- **2026-11-03 (0488)** — `payment_requests.origin`: `manual` (operator/API, every row before), `dunning` (the clock's combined retry, 2.51) or `portal` (the customer's Pay all / selection, `payInvoicesFromPortal`). A `dunning` request counts one dunning attempt per invoice on its first booking, fails each child through `settlePaymentFailed` (each invoice re-arms its own retry; backups re-arm only on the last decline) and closes `canceled`/`payment_failed` with no link mail; a `portal` request also closes on its last decline. Both closes move the lines to `removed`, so the invoices can join a later request or retry. Children carry `metadata.payment_request_attempt`; a late failure passes `retriable` through. Creation sorts by `payment_application.invoice_order` (2.66). The portal list hides `dunning` requests. Gate: `verify:settings-payment-application`.
- **2026-11-02** — No pre-debit-notice rail is charged from a request at ANY position:
  `chargeShares` drops them after the card-limit filter, so neither the card limit nor a card
  decline can fall through to a notice-rail backup. Intended behaviour change: a notice-rail
  backup that was charged after a card decline before is now never charged from a request.
- **2026-11-02** — The card limit is compared to the request's TOTAL, the amount one gateway
  charge takes (`chargeShares`), not to each invoice.
- **2026-11-02** — Card limit (0482): an invoice in the request above the business's card limit
  takes card instruments out of the charge; with none left the charge is refused (400).
- **2026-10-28** — Children write `payments.method_type`: the charged method's type at booking, the
  transaction's saved method on a late authorization.
- **2026-10-25** — Module created (0388).
- **2026-10-25** — A capture after a failed (AFA) request charge now pays the request's invoices still owed (newest first) and refunds only the excess; it was all refunded before.
- **2026-10-25** — A refused late capture (amount mismatch) re-codes its transaction `capture_amount_mismatch`, so the AFA recheck sweep no longer books it at our quoted amount; `settleLateRequestCapture` returns `refused` for a non-AFA code under its row lock.
- **2026-10-25** — A late failure on a request charge no longer books AR for a child with no invoice (overshoot or late-capture excess): it takes back only the credit that child still holds. The AFA recheck sweep now books a request's late capture through the same path as the webhook.
- **2026-10-26** — `applyRequestChargeRefund` takes `refunds[]`: each refund is booked at its own
  amount once per id (an event with no running total booked the whole charge), and a `failed`
  record reverses what that id booked. A lost-answer request charge keeps its ref and key, and the
  lost-answer sweep stamps the found id on the request. `verify:engine-gateway-conformance` § R3, § L6.
- **2026-10-27** — `reverseRequestCharge` takes back what the invoice children still hold
  (after their refunds and the request's disputes), newest first, not each child's full amount;
  it row-locks the children in id order and takes the gateway's stated amount when given.
  `verify:engine-gateway-conformance` § V4.
- **2026-11-02 (0481)** — `reverseRequestCharge` takes the reversal's normalised decline: the child payments store it in `reversal_code`, and each reopened invoice is re-armed through `rearmReversedInvoice` (`webhooks/inbound.ts`, the same `planFailureRearm` as a direct reversal, with `billing_rules_config.mandate_revoked`). Deliberate change: a terminate-class reversal (revoked mandate, fraud) is no longer re-presented the next day, under `follow_dunning` too; stop, pause and offline invoices are honoured as on the direct path. Gate: `verify:settings-billing-rules`.
- **2026-11-03 (0495, security)** — A late failure re-arms an invoice only while it is still `paid` and the reversal leaves an amount owing (`rearmReversedInvoice` locks the row, checks `invoiceOutstanding`, and updates with `status = 'paid'`). An invoice that another payment still pays, or that was voided, stays as it is, and its request line stays closed. Gate: `verify:payment-requests` §18.
