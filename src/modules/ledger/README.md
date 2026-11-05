# ledger — append-only double-entry money truth

> Source: `src/modules/ledger/` · Routes: none (internal module) · Schema: `db/schema/ledger.ts`
> Layer: foundation (see docs/architecture/architecture.json)

## Purpose
The single source of financial truth. Every invoice, payment, refund, credit, proration, and balance
movement is recorded as immutable double-entry ledger lines. Balances are **derived** from the ledger
by summing entries — never stored-and-mutated. This is ADR-004.

## Responsibilities
- Post balanced double-entry transactions (`postEntries`).
- Derive account balances on demand (`accountBalance`).

## Data model
`db/schema/ledger.ts` — `ledger_entries`: `(organization_id, business_id, transaction_id, account,
direction[debit|credit], amount_minor, currency, source_type, source_id, created_at)`. Money is
integer **minor units** + ISO currency. Accounts are plain strings (e.g. `accounts_receivable`,
`revenue`, `promotional_credit_balance`, `refundable_credit_balance`, `excess_payment_balance`,
`excess_refund_pending` (excess credit reserved for a payout in flight),
`credit_adjustments`, `bad_debt`).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `postEntries({ organizationId, businessId, customerId?, sourceType, sourceId, lines }, tx?)` | posts balanced lines; asserts Σdebits = Σcredits **per currency**; returns `{ transactionId }`. Pass `tx` to join the caller's transaction. |
| `accountBalance` | derive the balance of an account (per currency) from entries |

## API routes
None (internal module — consumed by invoicing, payments, credit-notes, customers, refunds, wallet, etc.).

## Events emitted
None.

## Dependencies
- **Upstream (calls into):** none.
- **Downstream (called by):** credit-notes, customers, invoicing, migration, payment-intents, payments, refunds, subscriptions, wallet, webhooks.

## Invariants & gotchas
- **Append-only.** Never `UPDATE`/`DELETE` a ledger row — post a compensating entry instead.
- `postEntries` **rejects unbalanced** input (Σdebits must equal Σcredits per currency) — a design
  guard; if a balance is hard to make balance, the accounting model is wrong, not the guard.
- New balance *types* = new **accounts**, never a mutated running total (e.g. the 3-balance split).

## Changelog
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-09-30** — `postEntries` takes an optional `occurredAt`, stamped as `created_at` on every line — for a backdated offline payment. Omitted = now, as before.
- **2026-10-22** — `transaction_id` is a UUIDv7 (`uuidv7()`, was `randomUUID()`): postings append to
  the end of its index instead of a random page (D4.10). Existing ids unchanged.
- **2026-10-27** — Invoice (`source_type = invoice`) and payment (`payment`) postings now carry
  `customer_id`, as refunds, credit notes, reversals and disputes already did. New entries only:
  the ledger is append-only, so earlier rows keep a null customer. No reader groups these accounts
  by customer today. `verify:refund-reconciliation` §7.
