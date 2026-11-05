# wallet — legacy top-up audit trail

> Source: `src/modules/wallet/` · Routes: `src/api/wallet-routes.ts` · Schema: `db/schema/wallet.ts`
> Layer: customer (see docs/architecture/architecture.json)

## Purpose
The original single-balance wallet, now **folded into the customer 3-balance model**: paid top-ups map
to excess payments, granted top-ups to promotional credits. `walletTopups` remains as an audit trail;
new balance logic lives in `customers`. Retained for history and migration fidelity.

## Responsibilities
- Record a wallet top-up (`topUpWallet`) and expose its running balance (`walletBalance`).

## Data model
`db/schema/wallet.ts` — `wallet_topups` (creditType paid|granted, amount, currency). Balance is ledger-derived.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `topUpWallet` | record a top-up (paid → excess, granted → promotional) |
| `walletBalance` | derived balance |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET/POST /v1/businesses/:biz/.../wallet` | read / top-up (2 routes) |

## Events emitted
`wallet.topped_up` (both kinds), plus `customer.promotional_credits_added` for a
`granted` top-up only — that kind credits the promotional bucket, so it is a promotional-credit
movement as well as a wallet record. A `paid` top-up credits `excess_payment_balance` and emits
no per-bucket twin (none exists; `customer.excess_payment_recorded` means money received offline).
A paid top-up's charge also emits `payment.succeeded` or `payment.failed` (customer ref, no invoice),
from `payments/settlement`.

## Dependencies
- **Upstream (calls into):** customers, events, gateway, invoicing (`collection.ts`), ledger, payments (`settlement.ts`), transactions, webhooks.
- **Downstream (called by):** migration, payments (`settlePaymentSucceeded` → `creditSettledTopUp`).

## Invariants & gotchas
- The wallet has **no separate spendable balance** — it feeds the customer buckets. New work should use
  the `customers` balance ops, not this module.
- `GET /v1/…/wallet` and `walletBalance` have **no remaining caller** — the dashboard now reads
  `customer.balances` (three buckets, per currency). Do not reintroduce them for display:
  `walletBalance` returns `promotional + excess`, and summing those two reads as refundable when
  half of it isn't. `POST /v1/…/wallet/topup` is still live and is still the **only** path that
  charges a card into the excess bucket (`type: 'paid'`); the dashboard reaches it from the
  *Record excess payment* dialog's "charge the card on file" source.
- A paid top-up charges like invoice collection: `resolveChargeCandidates` (primary, then
  chargeable backups) and `chargeWithMethod`. Each attempt is a `pending` payment marked
  `metadata.wallet_topup` BEFORE the gateway call; the wallet is credited only when
  `settlePaymentSucceeded` claims it pending → succeeded. A pending or indeterminate answer
  returns 400 with the in-progress message and leaves the payment for the webhook, the
  stale-pending sweep or an operator reconcile, which credit it then.

## Changelog
- **2026-10-28** — A top-up's pending payment writes `payments.method_type` from the charged method.
- **2026-07-31** — Dashboard fully migrated off this module for *display*. The inline "Wallet
  top-up" form and its `promotional + excess` balance line are gone; credits are managed from the
  customer detail action rail (`Manage credits` / `Record excess payment`); there is no in-body
  credits form. `topUpWallet type: 'paid'` is retained and still reached from
  the UI — it is the only card-charging credit path. `GET /wallet` now has no dashboard caller.
- **2026-07-27** — Paid top-up now passes the customer's email + phone into `adapter.charge`
  (`ChargeInput.email/phone`) and the payment method's own `display.type` rather than a hardcoded
  `'card'` — same fix as `collectInvoice`, needed for RazorPay off-session charges. See
  `src/modules/gateway/README.md`.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-24** — **A `granted` top-up now ALSO emits `customer.promotional_credits_added`.**
  It credits the promotional bucket, but only `wallet.topped_up` said so, so a consumer tracking the
  promotional balance over webhooks saw the manual grant/deduct, the invoice draw and the credit-note
  restore (all added in `336260c`) but not this one. Emitted through the shared
  `emitPromotionalCreditMovement` in `customers/balances.ts`, inside the same transaction as the ledger
  posting and `wallet.topped_up`, so the payload matches every other promotional movement. `paid`
  top-ups are deliberately untouched — they credit excess, which has no per-bucket event type, and
  reusing `customer.excess_payment_recorded` would misreport a card charge as offline money received.
- **2026-10-24** — **Paid top-ups charge the right card and always leave a record.** The
  charge took the customer's newest payment method by `created_at`, ignoring `role` and
  `status`, so an expired or removed card could be charged over a valid primary. And it called
  the gateway before any write: a throw, a pending or an indeterminate answer booked nothing, and
  a success followed by a failed insert took money with no record. It now selects through
  `resolveChargeCandidates` (falling back to backups on a decline, `shouldTryBackup`), charges
  through `chargeWithMethod`, books the payment `pending` first, and settles it through
  `payments/settlement`. Every attempt also books a transaction, and `payment_succeeded` /
  `payment_failed` now fire for top-up charges. `granted` top-ups are unchanged.
  `verify:wallet` §4–8.
- **2026-10-24** — **Paid top-ups wait for a gateway pre-debit notice.** On a rail that needs
  one (`capabilities.preDebitNotice`), `paidTopUp` passes `preDebit: { purpose: "wallet_topup" }`
  to `chargeWithMethod`. The first debit then sends a notice and books nothing: the pending
  payment is booked in `beforeGatewayCall`, which runs only once the gate has passed. The caller
  gets a `WalletError` with `retryAfter` (the API sends `error.retry_after`), and a retry with
  the same amount after that time charges under the notice. A backup that must wait yields to
  the next candidate. There is still no automatic top-up, so nothing retries on its own.
  `verify:pre-debit-notices` (k).
- **2026-11-03 (0495, security)** — A `granted` top-up is checked against `credit_config.grant_limits` (refused above the maximum; audited and alerted above the alert amount). Paid top-ups keep `top_up_limits`. Gate: `verify:grant-limits`.
