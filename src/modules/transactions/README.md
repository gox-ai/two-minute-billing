# transactions — gateway-facing money log + reconcile

> Source: `src/modules/transactions/` · Routes: `src/api/transaction-routes.ts` · Schema: `db/schema/transactions.ts`
> Layer: payments (see docs/architecture/architecture.json)

## Purpose
The gateway-facing record of every money movement (authorization/payment/refund/reversal), with a
status vocabulary that covers the hard cases — `needs_attention`, `timeout`, `late_failed`.
Complements `payments` (engine ledger truth): one payment attempt → one transaction. Provides the
`reconcile` op for stuck/ambiguous outcomes.

## Responsibilities
- Record a transaction alongside each charge/refund attempt (gateway error_code/text, id_at_gateway).
- Set/settle transaction status; find a transaction by gateway charge id.
- Reconcile `needs_attention`/`timeout` — query the gateway or accept an operator verdict; flip
  payment + invoice accordingly.

## Data model
`db/schema/transactions.ts` — `transactions` (`type` authorization|payment|refund|payment_reversal,
`status` in_progress|succeeded|failed|voided|timeout|needs_attention|late_failed (0321; `success`/`failure`/`late_failure` accepted on input only), amount, currency,
gateway_account_id, id_at_gateway, error_code/text, links to invoice/payment/refund/credit_note,
occurred_at/settled_at).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `recordTransaction` | write a gateway-facing attempt |
| `setTransactionStatus` | settle/transition |
| `findTransactionByGatewayCharge` | match inbound webhook to a transaction |
| `reconcileTransaction` | resolve needs_attention/timeout (gateway query or operator verdict) |
| `listTransactions` / `getTransactionByPublicId` / `serializeTransaction` | read |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/businesses/:biz/transactions` | filtered list |
| `POST /v1/transactions/:txn/reconcile` | reconcile a stuck transaction |

## Events emitted
`payment.initiated`, `transaction.needs_attention`, `transaction.reconciled`.

## Dependencies
- **Upstream (calls into):** events, payments, webhooks.
- **Downstream (called by):** invoicing, payment-intents, refunds, webhooks.

## Invariants & gotchas
- Transactions = the **gateway log**; `payments` + `ledger` remain the engine's financial truth.
- `late_failed` (a success that later reverses) reopens the invoice to `payment_due`.
- Serializer lacks a linked `payment` id today (shows invoice + gateway charge id) — a known gap.

## Changelog

- **2026-11-03** — `span_id` (0496): the collection inside `trace_id` that wrote the row, stamped in
  `recordTransaction` from `getSpanId()`. The dashboard's gateway-log link filters on both, so a
  clock-tick transaction shows its own calls, not the whole tick's. Null on older rows.
- **2026-10-28** — `method_type` on the transaction: the referenced payment's `payments.method_type`
  (which method type paid; null when not known).
- **2026-10-26** — `dispute_recording` on the single read of a succeeded payment whose gateway sends no dispute events (`{ payment, available_minor }`, else null) — the dashboard's "Record dispute" gate (disputes `disputeRecordingFor`).
- **2026-10-25** — `transactions.payment_request_id` (0388): a payment request's one charge; `payment_id` is null on it. Operator reconcile of such a transaction settles the request.
- **2026-10-23** — **`unapplied_reason` on a payment row.** A payment that settles after its invoice
  could take it is detached and booked to excess (`markUnapplied`), but its transaction keeps
  `invoice`, so it read as paying a voided invoice. The row now serves the payment's
  `unapplied_gateway_capture` cause; `null` on refunds and applied payments. The dashboard uses it
  to show the refund of that money on the invoice (`reference_payment[is]=`). Gate:
  `verify:late-payment-after-void`.
- **2026-09-30** — **One outcome vocabulary.** `status` stores and returns `succeeded` / `failed` /
  `late_failed` (0321 renames stored rows, adds `transactions_status_ck` and a compatibility trigger
  that maps an old spelling a previous build writes). `TRANSACTION_STATUS_ALIASES` (`status.ts`)
  keeps `success` / `failure` / `late_failure` working on list filters, the flat `?status=`, saved
  views and the reconcile `outcome`. Gate: `verify:status-vocabulary`.
- **2026-09-30** — `payment_method` filter (`pm_…`) and `updated_at` sort + the shared list grammar (`list-query.ts`/`parseListQuery`): set/range values also take a JSON array, date operators take unix seconds (an exact instant for before/after/on_or_*/between bounds; `on=<unix>` is the business-zone day holding it), `offset`/`next_offset` alias `starting_after`/`next_cursor`, and `include_deleted` is accepted (a no-op). No reference-number column exists.

- **2026-09-24** — `?invoice=` / `?customer=` resolve to the internal id and filter on the
  transaction's own FK (`listTransactionsPage`'s `invoiceId` / `customerId`). As a joined public-id
  filter the planner walked the log newest-first looking for one invoice's rows: 1.1–1.9 s on
  production for a single row.

- **2026-09-09** — ✅ **A transaction names its payment intent, and the gateway's fraud verdict.**
  Two facts the money log held and never served. `payment_intent` closes the 🟠 that had the chain
  walkable one way only: the intent→transactions hop worked, the reverse did not, because the
  `paymentIntents` join was marked *filter-only* and `detailedSelect` never read it. `null` there is
  the NORMAL case and the docs say so — an off-session renewal has no authorization ceremony, so
  6,295 of 6,307 transactions in one production book legitimately have none.
  · **`fraud_signal` is deliberately NOT a status.** It is a separate `fraud_status` field rather
  than a `fraud_flag` status value, because writing `fraud_flag` over a `succeeded` destroys the one
  record of whether the money settled. It reads the
  `fraud_warning.created` / `review.opened` / `review.closed` callbacks that were already persisted
  and were reachable only through the platform-wide `early_fraud_warning` ops alert — which counts
  them and cannot say which charge.
  · ⚠️ **`provider_events` must be read on the PLATFORM connection.** It is platform-global and the
  tenant role has no grant: shipped inside `withTenant`, it threw `permission denied for table
  provider_events` and 500'd the entire transaction detail page. Scoping is manual by `businessId`,
  taken off a transaction the caller already read under RLS.
  · **And the single read was missing its join** — the exact failure the query's own comment warns
  about ("a column added there must be reachable from BOTH"). `listTransactionsDetailed` was worse:
  it selects `gatewayAccounts` / `payments` columns it never joined and would throw on first call.
  It has no callers, which is why nobody found out; all three joins added.
  · **Gates:** engine `tsc` 0 · dashboard `tsc` 0 · `verify:ui` 5/5 at 0 · `openapi:coverage` 271/271
  with no field drift · `verify:sdk` PASS · unit **1416/1416**. Both fields proven end to end against
  real rows, and the detail page rendered over CDP for each.
- **2026-09-03** — 🟠 **"Mark this failed" answered 500 on exactly the rows an operator reaches for it.**
  `reconcileTransaction(outcome: 'failed')` on a row carrying `id_at_gateway` for a charge already booked
  crashed on `payments_provider_charge_uq` while the settlement tried to mint a second payment for that
  charge (docs/PROGRESS.md #20). The collision is fixed in `payments/settlement.ts`, which now settles the
  payment that exists — but settling it is not always honest, and this module holds the case where it is
  not: `settlePaymentFailed` claims a `pending` row only, so over a `succeeded` payment it posts nothing,
  returns false, and would leave this function's own `status = 'failed'` standing — a transaction reading
  failure over money that demonstrably moved, in a status no longer in `RECONCILABLE_STATUSES`, so nobody
  could put it right. **Measured, not reasoned:** with the refusal removed the gate reports
  `txn=failure payment=succeeded`. So a `failed` verdict is now REFUSED where the payment already reads
  succeeded, in #17's shape and for its reasons — before the write transaction opens, so no ledger entry
  is reachable, and as a `TransactionError` naming the payment and the charge. Scoped to a reconcilable
  status, so the existing "is `${status}` and cannot be reconciled" refusal keeps coming first and no
  error anyone has seen is reworded. The payment is resolved by the SAME rule the settlement uses (the
  row's own `payment_id`, else the payment holding its charge), because a brake that saw one door only
  would refuse on one row and silently lie on the identical row that names its payment instead. #17's
  row read is hoisted above both brakes — one query, two refusals of one shape.
- **2026-09-03** — 🔴 **The operator's Reconcile panel offered to book ₹22,184.00 of phantom cash, with
  "Succeeded" pre-selected, on a row whose money had already been refunded.** `reconcileTransaction` now
  refuses a `succeeded` verdict when the money it would book has a settled refund against it, and posts
  no ledger entries — the gate asserts the ledger is UNCHANGED, because that was the actual harm (the
  fixture measured +7777 minor units of cash appearing from nothing). New `settledReturnForTransaction`
  resolves the fact even for a row carrying no `id_at_gateway`, `payment_id` or `payment_intent_id`, by
  bridging invoice → intent → `provider_events` → charge → refund: `payment_intents.intent_at_gateway`
  holds the gateway's ORDER id, and the charge id exists on our side only inside the normalized event
  payload. `serialize.ts` exposes `settled_refund` so the panel states the refund instead of asserting
  "the gateway outcome is unknown". **Known, unfixed (#20):** `reconcileTransaction(outcome:'failed')`
  on a row that DOES carry `id_at_gateway` for an already-booked charge 500s on
  `payments_provider_charge_uq`, because `settleTransactionOutcome` mints a second payment against the
  same charge id — so "mark this failed" is unavailable on exactly the rows most likely to need it.

- **2026-08-31** — **Full-depth filters on the money log.** `LIST_FILTERS` went from 12 fields to
  28. Gateway side: `gateway_key` (the serialized name for the legacy `gateway` param, same column),
  `gateway_account`, `reference_payment`, `id_at_gateway`, `error_text`, `retriable`, `trace_id`.
  Instrument: `payment_method_brand` / `payment_method_last4` / `payment_method_type`. Links:
  `subscription`, `credit_note`, `payment_intent` (the intent's `pi_...` public id — a new filter-only
  LEFT JOIN, since the envelope prints no `payment_intent`). Dates: `settled_at`, `updated_at`.
  Payer: `customer_name`, through `accountHolderNameSql` — against the bare legacy `customers.name`
  that filter answered "no transactions" for every customer created with first/last. Sorts added:
  `occurred_at`, `settled_at`, `type`. The count query now mirrors the page read's full join set
  (eight LEFT JOINs on unique PKs, which Postgres drops out of a COUNT that reads none of their
  columns) — otherwise a filter on a joined table is a 500, not a wrong total. Route passes
  `TRANSACTION_FILTER_KINDS` as `filterKinds` (400 on a malformed value, not a cast 500).
  **Not added, no column:** AVS / CVV / fraud-review result, card expiry, card country, issuing bank,
  `amount_unused` / `refunded_amount`, `settlement_currency` and `exchange_rate` — `transactions`
  stores none of them.
- **2026-07-30** — **Paginated money log.** `listTransactionsPage` behind
  `GET /v1/businesses/:biz/transactions` (keyset + index `transactions_business_created_idx`,
  migration 0131). This list was **capped at 50 rows with no next page** — the toolbar read
  "50 Transactions" over 611 in the local dataset, so the rest of the money was invisible. Now
  `limit`/`starting_after`/`q`/`sort_by` (`created_at|amount_minor|status`) + `<field>[<op>]`
  filters; the legacy flat params (`?type=`, `?status=`, `?gateway=`, `?customer=`, `?invoice=`)
  still work and fold into the same filter set. Verify: `verify:list-pagination`.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-10** — `recordTransaction` accepts `paymentIntentId` / `paymentAttemptId` (columns from
  migration 0172). The payment-intents engine stamps both on every transaction it records, success
  or failure, so intent-level failure metrics group by intent instead of being inferred from
  transaction-level data. Both nullable — most transactions have no intent at all.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-22** — **The money log names the payer through `accountHolderName`.** `detailedSelect` used
  `customers.name` alone — our legacy display column, which the API never sets — so every customer
  created with `first_name`/`last_name` was an anonymous row in the one place money is audited. The
  projection now carries the whole name chain and a single `toDetailed` mapper resolves it, shared by
  the paginated list, the capped internal list and the single read: three copies of the precedence rule
  is how a transaction shows a name on one screen and a blank on the next. Free-text `q` also reaches
  first/last/company now. `TransactionDetailed.customerName` is unchanged on the wire — same key, same
  type, now populated.
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-10-21** — Transactions list total counts up to 10,000 and stops (`cappedTotal`, `total_capped`; `total=exact` opts in): an exact count over a large book cost seconds per page.
- **2026-10-30** — `subscription_id` (0402): set only on a charge refused before its invoice existed (reactivation or signup pre-charge), which no invoice could reach. Every join and the `subscription` filter read `coalesce(transactions.subscription_id, invoices.subscription_id)` (`subscriptionOfTransaction`). `verify:create-gating` case 9.
