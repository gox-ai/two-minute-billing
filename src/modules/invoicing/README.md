# invoicing — invoice generation, lifecycle, dunning transitions

> Source: `src/modules/invoicing/` · Routes: `src/api/invoice-routes.ts` · Schema: `db/schema/invoices.ts`
> Layer: billing (see docs/architecture/architecture.json)

## Purpose

Turns a subscription period (or a manual request) into an invoice, runs the full pricing pipeline,
manages the status lifecycle and dunning transitions, and offers the lifecycle ops (close,
void, write-off, regenerate, collect, offline payment, HTML render). This is where discounts, tax,
credits, rounding, and collection come together.

## Responsibilities

- Generate invoices from subscription periods (`billSubscriptionPeriod`) or line sets (`createInvoiceFromLines`); manual invoices.
- Run the pipeline: assemble lines (+usage arrears, +unbilled sweep) → stacked discounts (pre-tax) →
  tax per line + withholding → round-off → apply the 3 customer balances (post-tax) → collect.
- Lifecycle ops: `close` (pending), `void`, write-off (via adjustment CN), `regenerate`, collect-now,
  record offline payment; clock-driven due-date transitions.
- Render printable HTML; list/read invoices + their lines.

## Data model

`db/schema/invoices.ts` — `invoices` (status `pending|posted|payment_due|not_paid|paid|voided` +
internal `credited`; `dunning_status`; `amount_due_minor`, `total_minor`, `written_off`; Net-D due
date; `attemptCount`/`nextAttemptAt`) + invoice line items (`recurring|proration|usage|one_time|rounding`).

## Public surface (service entry points)

| Function                                                           | What it does                              |
| ------------------------------------------------------------------ | ----------------------------------------- |
| `billSubscriptionPeriod` / `createInvoiceFromLines`                | generation                                |
| `createManualInvoice`                                              | one-off invoice                           |
| `closeInvoice` / `runAutoClosePending`                             | pending → finalize                        |
| `voidInvoice` / `writeOffInvoice` / `regenerateInvoice`            | lifecycle ops                             |
| `collectInvoiceNow` / `collectInvoice` / `recordOfflinePayment`    | collection                                |
| `runInvoiceDueTransitions`                                         | posted → payment_due/not_paid at due date |
| `postCreditApplications` / `roundingDeltaFor` / `isAutoCollectOn`  | pipeline helpers                          |
| `renderInvoiceHtml`                                                | printable document                        |
| `listInvoices` / `getInvoiceWithLines` / `listPaymentsForBusiness` | read                                      |
| `importArchivalInvoice`                                            | migration path                            |

## API routes

| Method · Path                                                              | Purpose                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /v1/businesses/:biz/invoices[/:inv]`                                  | list / detail                                                            |
| `POST /v1/businesses/:biz/invoices`                                        | manual invoice                                                           |
| `POST .../invoices/:inv/{close,pay,regenerate,stop_dunning,pause_dunning}` | lifecycle                                                                |
| `GET .../invoices/:inv/pdf`                                                | download real PDF (pdfkit)                                               |
| `GET .../invoices/:inv/html[?print=1]`                                     | rich print-friendly HTML (`print=1` = viewer chrome + auto print dialog) |

(12 routes; void/write-off/collect also reachable via dashboard actions.)

## Events emitted

`invoice.generated/paid/payment_due/not_paid/voided/closed/pending_created`,
`invoice.dunning_started/exhausted`, `payment.succeeded/failed`, `usage.recorded`.

## Dependencies

- **Upstream (calls into):** audit, catalog, coupons, credit-notes, customers, events, gateway, ledger, metering, payment-methods, subscriptions, tax, transactions, webhooks.
- **Downstream (called by):** credit-notes, customers, migration, payment-intents, payments, subscriptions, webhooks.

## Invariants & gotchas

- **Pipeline order is load-bearing:** lines → discounts (pre-tax) → tax → round-off → balances
  (post-tax) → collect. `unpaid = total − payments − applied_credits − adjustment_CNs − withheld`.
- Write-off is routed through an adjustment credit note (keeps the ledger story consistent), not a bare
  status flip.
- **`cycles_billed` is the only record that an item has been billed, so anything that bills an item
  outside `planSubscriptionPeriodInvoice` must increment it** — `createInvoiceFromLines({ markItemsBilled })`,
  in the invoice's own transaction. The planner rates every non-metered item EVERY period and stops
  only at the item's cycle cap (`billing_cycles`, or an implicit **1** for a `one_time` price), so an
  item that has been charged but never counted gets billed a second time.
- Serializer gaps (backlog): `written_off`, `dunning_status`, per-bucket applied-credit breakdown not emitted
  (aggregate `credits_applied_minor` is).
- Money = integer minor units; ledger append-only.

## Changelog

- **2026-11-05** — `collectOutstandingForNewPaymentMethod` takes `collectOpenInvoices`, a
  per-call override of `collectOnPaymentMethodUpdate` (omitted = the business rule; the config
  is not loaded when it is set). Route field `collect_open_invoices`. Gate: `verify:create-gating` 10d.
- **2026-11-03** — `collectInvoice` runs each collection in its own span (`withSpan`,
  `platform/trace.ts`) under the caller's trace. Gate: `verify:gateway` § C7+ (5b).
- **2026-11-03** — Card caps (`representment.ts` `presentations`): the failed child payments of one payment-request attempt (`metadata.payment_request_attempt`, else the shared `created_at`) count as ONE presentation. Before, a request over N invoices counted N declines per attempt. Other rows count as before. Gate: `verify:settings-payment-application` § 1L.
- **2026-11-03** — Invoice rules (0486, `invoice-rules-config.ts`, `businesses.invoice_rules_config`):
  small invoices (`charge` | `write_off` below a per-currency amount due) and charge timing
  (`at_creation` | `on_due_date`), applied by the renewal (subscriptions/renewal-collection.ts).

- **2026-11-02** — Review fixes (0482): the card limit also binds `chargeBeforeSubscriptionInvoice`
  (API create, hosted checkout signup, reactivation, HubSpot subscribe): with only cards above
  the limit the first charge is `declined` with `card_limit_exceeded` and nothing is created.
  The printed exchange rate is cut to 4 decimal places (`printedRate`); the stored rate is not.
- **2026-11-02** — **Exchange rate on documents, and a card limit per currency (0482).**
  `invoice_customization.common.show_exchange_rate` (default false; a business a person creates
  starts true via `initialDocumentConfig`) prints the issue-time stamp (0228) as
  `meta.exchangeRate` on an invoice or credit note in another currency than the stamp's base
  (`printedExchangeRate`; PDF and HTML). `businesses.card_payment_limits` (`card-limit.ts`): above
  the limit for the invoice's currency, `collectClaimedInvoice` drops card instruments; with none
  left it books `card_limit_exceeded` (`providerKey: 'none'`, non-retriable, in `PARK`,
  `PARK_EVEN_IN_FIXED_MODE` and `NOT_PRESENTED`). Gate: `verify:settings-invoices-org` A, C.
- **2026-11-02** — **The mandate currency guard trusts only gateways that vouch for it.**
  `mandateCurrencyDiffers` / `mandateCurrencyRefusal` (now in `payment-methods/mandate-currency.ts`,
  re-exported here) refuse or skip a method only when its gateway lists the method in
  `capabilities.mandateCurrencyAuthoritative`. RazorPay cards are not listed: their mandates
  register in the order's currency, and older rows hold INR, so a USD RazorPay renewal reaches
  the gateway as before. Cover: `verify:gateway-conformance` (razorpay
  `S14.card-mandate-currency-label`, cashfree `S14.engine-mandate-currency`),
  `verify:engine-gateway-conformance` M1.
- **2026-11-02** — **Pre-debit: a top-up payment names its notice purpose.** Wallet and credit
  top-up payments write `metadata.purpose` (`PAYMENT_PURPOSE_KEY`; the wallet keeps its
  `wallet_topup` marker). `debited()` and the claim's in-flight count match a payment that names
  a purpose to notices of that purpose only, so a wallet debit never retires or frees a credit
  top-up notice of the same amount (a credit payment carries its auto top-up invoice, so the
  invoice rule alone could not tell them apart). Rows without the key keep the invoice rule.

- **2026-11-02** — **Pre-debit notices: per-rail rules, retries, debit day.** The gate reads lead
  time and debits per notice through `preDebitRule(cap, pm.type)` (PayU: card 24 h / 1, UPI 25 h /
  4). A notice that already carried a succeeded or settling debit (same method and amount, after
  the notice) is retired, so only failed debits use its retries. `sendGatewayNotice` passes
  `max(debitAt, its own lead)` as `debitAt`, so an adapter on the real clock names the right debit
  day under time travel.

- **2026-11-02** — **Pre-debit notices: one invoice per notice, one claim at a time (audit).** The
  claim binds an invoice notice to the invoice it debits (`invoice_id = coalesce(…)`), so a notice
  the reminders pass sent ahead (no invoice) never covers a second invoice of the same amount; a
  notice is retired only by a debit of its own invoice (a used notice with no invoice, from before
  this, by any invoice's). The claim takes `pg_advisory_xact_lock` per payment method (namespace
  7405) and is refused while a debit claimed under the notice is not booked failed, so two
  concurrent debits (top-ups) never share one. A lost claim waits an hour instead of replacing
  notices. A retry under a used notice must start an hour before the notice ends. Superseding
  leaves another invoice's notice alone. `applyGatewayNoticeUpdate` floors a late `sent` by the
  instrument's rail.

- **2026-11-01** — **Meter lines (0454, Tier 3 G1/G2).** The period planner rates a meter item
  through `rateMeterItem` (`metering/meter-rating.ts`): one `kind='usage'` line per value
  combination ("<price> · <group values>", `quantity` 1, `unit_amount_minor` = amount, the truth in
  `quantity_decimal` / `unit_amount_decimal`), plus late lines "Usage from <period>: …" dated to the
  old window (late = re-rate of that window − what its lines billed; only a positive difference
  bills). The minimum true-up lifts the window's lines summed. Before rating, one cutoff per meter
  commits in its own transaction (`takeMeterCutoff` → `takeUsageCutoff`; a preview only peeks);
  the finalize transaction writes the pointer (`usage_through`, `cutoff_generation`, `cutoff_at`)
  and recurring level snapshots (`commitMeterRating`), so a rollback loses nothing. Every line
  insert passes the decimals (the 0454 trigger fills them on every other write path); the
  serializer returns `quantity_decimal` / `unit_amount_decimal` on every line and falls back to the
  integers for rows written before 0454. A window with no usage still writes one zero line, and
  each window's first line keeps `rating.pricing` (rate card included), so late usage re-rates at
  the price that window had. Late usage is found by receive time (events received since the last
  cutoff, rollups above its generation), never by scanning event time. A settled meter charge
  carries its rating onto the line. Cover: `verify:rate-cards`, `verify:usage-late`.

- **2026-10-31** — **Renewals see a phone saved by hosted checkout.** `loadChargeContact` falls
  back to the billing-address phone, as `providerContact` already did. Checkout saves the phone
  there only, so renewal charges and pre-debit notices went without one (Razorpay off-session
  refuses a charge without it).
- **2026-10-30** — **First charge at signup on a notice rail** (decided 2026-10-24). When the
  primary instrument needs a gateway pre-debit notice, `chargeBeforeSubscriptionInvoice` charges
  nothing and answers `deferred`, buyer present or not: the callers (API create, hosted checkout,
  HubSpot) commit the invoice with no charge, so `collectPeriodInvoice` sends the notice through
  `preDebitGate` and defers it like a renewal. A reactivation is refused
  (`pre_debit_notice_required`). Not an on-session payment at the gateway: PayU's hosted payment
  captures at once, its webhook beat the buyer's return, and the capture (no invoice yet) was
  refunded as unmatched (measured 2026-10-30). `verify:pre-debit-notices` (i).
  Hosted checkout on a gateway whose registration can collect the first invoice
  (`setupCollectsFirstCharge`, PayU) pays once at registration instead: the completion books
  the setup intent's `first_charge_minor` as the pre-invoice charge (checkout README).
  `preDebitGate`: a notice the gateway refuses as final (`retriable: false`, e.g. a revoked
  mandate) is booked in the gateway's class and not retried; an invalid instrument whose last
  notice was refused gets no further notice, and a renewal reuses a reminders-pass notice that
  was refused as final (`mandate_expired`, `payment_method_not_found`) instead of sending a
  second one. `verify:pre-debit-notices` (d2, d3).

- **2026-10-28** — Every payment insert writes `payments.method_type` through `methodTypeOf`
  (payments/method-type.ts): renewals (`bookSuccess`, `bookPending`), declines and the prepaid
  signup. `recordFailedPayment` takes a required `methodType`.
- **2026-10-26** — `recordOfflinePayment`, `applyCreditsToInvoice` and an operator `voidInvoice`
  (`cancelPendingDebit: true`, set by the route) cancel a pending debit at its gateway first, or
  refuse with 409 `debit_in_progress` (`payments/pending-debit.ts`). `applyCreditsToInvoice` checks
  the credit before it cancels anything. Automated voids keep `voidBlocker`'s refusal. Automatic
  credit (`applyCreditOnFile`) skips an invoice with a debit in flight, so credit is never drawn on
  top of a live debit.
- **2026-10-26** — **Pre-debit notices: the gateway's own timing** (gateway-neutral).
  `preDebitGate` asks `adapter.checkPreDebitNotice` (optional) before it counts a debit: a
  later executable time or a notice still in delivery defers the debit (nothing booked, the
  notice not counted); a failed notice is retired and a new one sent. `applyGatewayNoticeUpdate`
  moves an unused `sent` notice LATER when the gateway states a later earliest debit, never
  earlier. A charge the gateway refused only as too early (`PRE_DEBIT_NOT_DUE_CODE`) gives its
  debit back to the notice (`releaseGatewayNotice`) and `chargeWithMethod` defers; a caller that
  booked before the call (`beforeGatewayCall`) keeps the failure, and `representment.ts` does not
  count it as a presentation. `sendGatewayNotice` passes `description` ("Invoice <number>" or
  "Wallet top-up"). Gate: `verify:pre-debit-notices` (m, n, o; tmtest credentials
  `pre_debit_check_late_hours`, `pre_debit_not_due_hours`).
- **2026-10-26** — `collectInvoice` passes the invoice's due date to the adapter as the due
  day in the business's timezone (`ChargeInput.invoiceDueDate`, `YYYY-MM-DD`, via
  `chargeWithMethod`); the operator's Collect now does not.
  GoCardless then collects on the due date when the mandate's notice period allows; other
  gateways ignore it.
- **2026-10-25** — Dunning reads the customer's named policy (0386): every dunning config read here goes through `loadEffectiveDunningConfig` (customer policy over business config), and `dunningNotHeldSql` reads `minimum_amounts` from `coalesce(policy.config, business.dunning_config)`. `claimCollection` / `releaseCollection` are exported for payment requests (0388). `invoice_customization.receipt.numbering` is resolved as `receiptNumbering` (0387).
- **2026-10-24** — Invoice detail lines carry `creditable_minor`: what a credit note can still
  credit on the line, tax-inclusive (`credit-notes/line-cap.ts`, loaded in `relations.ts`).
- **2026-10-24** — `dunningHoldFor` (per-row) and `dunningNotHeldSql` (scan filter, no join
  needed) decide whether a customer's exclusion or the business's per-currency minimum holds an
  invoice. `collectInvoice`'s failure site, offline enrolment at raise and at the due date, and the
  offline reminder ladder use them (see subscriptions README, same date). The dunning journey
  reports `projection_note: "customer_excluded" | "below_minimum"`. Every dunning step measured
  from the due date (retry offsets, dunning period, offline reminders and deadline, the reported
  `dunning_period_ends_at`) now reads `dunningAnchor(inv)` = `due_date + dunning_held_ms`, so a
  lifted exclusion pushes them later; the due date itself never moves.

- **2026-10-24** — **Minimum spend true-up.** `planSubscriptionPeriodInvoice` adds a
  "Minimum spend adjustment: <price>" line when an item's period line (fixed or metered) is
  below its snapshot's `minimumAmountMinor`. Metered items with no usage owe the whole minimum.
  The minimum is prorated by window ÷ one full period of the price's cycle from the window start
  (half-up), capped at 1. One-time prices never get one. Metered detection uses
  `isMeteredPrice`, so `graduated_percentage` with an aggregation bills in arrears like
  `percentage`. Gate: `verify:minimum-spend`.
- **2026-10-24** — **Pre-debit notices carry a purpose** (0362: `invoice` | `wallet_topup`).
  `preDebitGate` reads, retires and supersedes only notices of its own purpose, so a wallet
  top-up never spends or replaces the notice an invoice waits on, and the reverse.
  `chargeWithMethod` takes `preDebit: { purpose: "wallet_topup" }` and a `beforeGatewayCall`
  hook that runs after every pre-flight refusal and the gate. A top-up's refused notice drops
  "We will try again" from its message, because nothing retries a top-up.
- **2026-10-24** — **Free units come off each period.** `planSubscriptionPeriodInvoice` rates
  fixed and metered items with the item's `free_quantity` (10 seats, 3 free, 100 each → 700). The
  line keeps the full quantity and states the rate (`unitRate`), so `quantity × unit` exceeds the
  amount on such a line. Usage lines state the rate too, not `amount / qty`. Gate:
  `verify:free-quantity`.
- **2026-10-24** — **Gateway pre-debit notices gate invoice collection** (`pre-debit.ts`, 0360
  `pre_debit_notices`). On a rail the adapter lists in `capabilities.preDebitNotice`,
  `chargeWithMethod` (invoice collection only — the pre-invoice signup charge is not gated) needs a
  `sent` notice that is executable, unexpired, not used up (`maxDebitsPerNotice`, counted before the
  debit) and, when `exactAmount`, for exactly the amount due. Otherwise it supersedes what no longer
  fits, sends a new notice (`notifyUpcomingDebit`) and the primary DEFERS: nothing is booked,
  `next_attempt_at` = executable time + 10 min (1 h recheck while `pending`; a pending notice is
  replaced after 6 h), `CollectionDeferredError` (a `CollectionInFlightError`, so every automated
  caller backs off; Collect now / reactivation show its message). A backup that must wait yields; if
  it was the last, the primary's decline governs and is booked once. A refused notice books a
  retriable `pre_debit_notice_failed`, which `representment.ts` does not count as a network
  presentation. The due pass now also picks up a `posted` invoice whose deferred `next_attempt_at`
  is due before its net-terms due date (auto-collect only). `pre_debit_notice.updated` webhooks
  land in `applyGatewayNoticeUpdate`: pending → sent (executable = max(stated, created + lead)),
  unused → failed; unknown refs ignored. Gate: `verify:pre-debit-notices`.
- **2026-10-27** — **Ship-to frozen at issue.** Subscription invoices (period finalize, and the
  pending-draft close via `coalesce`, so an operator's draft edit wins) and `createInvoiceFromLines`
  write `invoices.shipping_address` from `shipToSnapshot`: the subscription's own address, else the
  customer's default. Before this the column was only set by an operator edit and readers fell back
  to the customer's LIVE address, so editing an address restated old paid orders. Tax still follows
  the billing address.
- **2026-10-13** — **An issued invoice keeps what it printed.** At issue the invoice now freezes
  the bill-to address (with `state_code`), the buyer's GSTIN / VAT id (`customer_tax_id`), the
  seller's name, address and registration (`seller_name`, `seller_address`, `seller_tax_id`,
  `seller_tax_country`), the price type, the printed notes, the net terms and `finalized_at`
  (0335–0337); `''` = none on file then, NULL = issued earlier and readers fall back to live
  settings. A customer edit, a re-registration or a switch of issuer no longer rewrites an issued
  invoice or its credit notes. The detail API adds `taxes[]`, per-line tax, credit notes, applied
  credit, `linked_payments`, `write_off_amount_minor`, `amount_adjusted_minor`, `first_invoice`
  and `recurring`; every invoice gains `updated_at` / `resource_version`, kept by the
  `invoices_touch` trigger. Backfill: `scripts/backfill-invoice-issue-snapshot.ts`. Regression:
  `verify:india-invoice`, `verify:invoicing-parity`, `verify:invoice-pdf`.

- **2026-10-03** — The issuer lookup and seller block moved out of `assembleInvoiceDocument` into exported `resolveDocumentIssuer` / `documentSeller`, which credit notes now use too. Invoice output unchanged. Unit: `test/unit/document-seller.test.ts`.
- **2026-10-03** — Credit on file is applied before a card on every charge of an open invoice: `collectInvoiceNow` (Collect now / Retry / portal Pay now), the due-date collect in `due.ts`, and `collectOutstandingForNewPaymentMethod` (reports `paid_with_credit` when credit settles it). Previously only the customer's collect_payment did. Gate: `verify:collect-credit-first`.
- **2026-10-03** — Voiding an imported invoice now returns the refundable credit it consumed to `refundable_credit_balance` (dr `opening_balance`). Its credit was netted into opening AR, so the mirror reversed nothing and the released note showed credit no flow could spend. Gate: `verify:void-imported-credit`.
- **2026-09-30** — `dunning_status` says `succeeded`, not `success` (0321 renames stored rows and
  re-creates `invoices_dunning_status_ck`). `DUNNING_STATUS_ALIASES` keeps `success` matching on
  the `dunning_status` filter and in saved views; archival import maps the source's spelling.
- **2026-09-30** — `collectInvoiceNow` refuses a `paymentMethodOverrideId` that is not the
  invoice customer's (`InvoiceOpsError` → 400) before charging; `isCustomerPaymentMethod` in `collection.ts`.
* **2026-09-30** — `recurring[is]=true|false` filter (the invoice's own `subscription_id` FK) + the shared list grammar (`list-query.ts`/`parseListQuery`): set/range values also take a JSON array, date operators take unix seconds (an exact instant for before/after/on_or_*/between bounds; `on=<unix>` is the business-zone day holding it), `offset`/`next_offset` alias `starting_after`/`next_cursor`, and `include_deleted` is accepted (a no-op here: invoices are never deleted). `ar_bucket` sets split via `splitMulti`. No `updated_at` or void-reason column exists, so neither is filterable.

* **2026-09-30** — `BillSubscriptionPeriodInput.preview` (`excludePendingCharges`,
  `ignoreCreditBalances`) for the renewal estimate's query flags. Such a plan is marked
  `previewOnly` and `commitSubscriptionPeriodInvoice` refuses it; nothing else passes it.
* **2026-09-29** — **A void refuses money on the invoice (`voidBlocker`).** A net payment (after
  refunds), one in flight, or tax withheld blocks `voidInvoice` with a message naming the amount.
  The void reversed the invoice but not the payment, so a partly paid invoice voided with the
  customer's cash stranded — no credit, no refund (reproduced: 4000 paid on 10000, voided clean).
  Dunning's final action "void" catches the refusal and the invoice stays `not_paid`; "Void them"
  at cancel leaves it open with a warning. The invoice page hides Void when money is on it.

* **2026-09-29** — **Dunning journey (`dunning-journey.ts`, `GET …/invoices/:inv/dunning_journey`).**
  Every attempt (transaction id, refusal, instrument, presented or refused pre-flight, trigger:
  clock / dashboard / portal / new payment method / offline, and whether it used a schedule slot),
  the dunning events around them, and a forecast built by running `planFailureRearm` forward from
  the latest decline with the business's config and the rail's NPCI cap. The invoice page's
  Payments section renders it as one timeline, with refunds and reversals merged in from the
  transaction list.

* **2026-09-29** — **NPCI rail rules at presentment.** `presentationBlock` takes `invoiceId` and,
  on every path (manual included), refuses a mandate already presented 1 + `networkRetryCap(rail)`
  times for that invoice (UPI 3, NACH/e-mandate 2) or, on NACH/e-mandate, within 3 days of its last
  return. Booked with `provider_key = 'none'` as `network_retry_limit` / `network_retry_too_soon`
  (retriable). Our own pre-flight mandate refusals don't count as presentations. This is what stops
  `scheduleTail`'s deadline attempt going past the cap: it is refused and dunning ends at the
  period's close.

* **2026-09-29** — **A decline code no longer blocks a card.** `NO_REPRESENT` and the
  `no_represent` presentation block are gone: gateways' do-not-retry signals proved unreliable (a
  card refused `incorrect_number`/do_not_try_again declined generically on its next attempt).
  `presentationBlock` is now the per-card caps only, applied to automatic attempts; a manual collect
  always reaches the gateway. `credentials_changed_at` is still stamped but nothing reads it.

* **2026-09-25** — **Card-network presentment rules (`representment.ts`).** `collectInvoice` never
  presents a card whose last decline is in `NO_REPRESENT` (Visa Category 1, Mastercard no-retry,
  MAC 03/21, restricted/expired/invalid-number, lost/stolen) until `payment_methods.credentials_changed_at`
  (0294, stamped by a re-vault or card-updater change) or a later success; a blocked primary hands
  to the backup, else a refusal is booked with `provider_key = 'none'` and no gateway call. Every
  path, manual included. Automatic re-attempts (`retryInvoice`, the park deadline) also respect
  per-card caps: 10 declines/24h and 15/30d across invoices and same-fingerprint copies; over the
  cap the retry is deferred to when the window reopens.

* **2026-09-24** — Retries nav badge (`activeOnly`) now counts the "Needs attention" segment,
  so a paid invoice is never in it. A manual collect on an invoice already in dunning closes
  the chase (`dunningFieldsOnSettle`), which the attempt-count check alone missed.
* **2026-09-21** — **Exhaustion is dated now (0282).** `recordFailedPayment` and the offline
  window close in `due.ts` stamp `invoices.dunning_exhausted_at` alongside
  `dunning_status='exhausted'`, as do the three other writers that exhaust an invoice. ⚠️ NULL
  means UNKNOWN, never "not exhausted": the column was added unbackfilled on purpose, so every
  invoice exhausted before it carries the status and no date. `dunning_status` still answers
  *whether*; this answers only *when*. Read the two as one question and a decade of exhaustions
  counts as zero. Why it exists: recovery has carried `paid_at` all along, so the two halves of a
  recovery rate could never be dated into the same period — see `src/modules/metrics/README.md`.
  Also `gateway_account_unavailable` is `retriable: false` now and parks rather than running the
  ladder to exhaustion; `src/modules/subscriptions/README.md` has the reasoning.

* **2026-09-15** — `loadInvoicePublicId` added, for event payloads that hold an invoice's
  internal id and need the public one to be enrichable. Same reason as
  `loadCustomerPublicId`.
- **2026-09-12 (latest)** — **A backup must be a different CARD, not merely a different row.**
  `usableBackup(primary, backup)` (exported, pure) returns null when the backup shares the primary's
  `instrumentFingerprint` — retrying the same physical card against the same decline is not a
  fallback. Also `mandateRefusal` gained an opt-in 4th parameter `gatewayOffersAfaAboveMax`:
  collection passes it (Stripe will carry an AFA link above the mandate max, so the refusal is not
  terminal there), checkout deliberately does not.
- **2026-09-09** — **`loadLogo` no longer rasterises SVG; it refuses it.** `rasterizeSvg` and
  the `sharp` import are gone from `invoice-pdf.ts`, and both the `data:` and the http branch
  now return through one `unembeddable()` helper that logs the content type AND the remedy
  ("upload a PNG or JPEG on Settings → Brand styles"). pdfkit's embeddable list is the whole
  list again: PNG and JPEG.
  - **Why the earlier decision reversed.** Rasterisation was added *because* SVG was what
    merchants uploaded and a dropped logo was silent (see the 2026-09-0x entry that added it —
    left in place, it was right at the time). That reason is gone: there is now an upload path
    (`platform/object-store.ts`) that stores only PNG/JPEG for a logo or signature, so a
    merchant has a supported way in. Keeping SVG on the read side preserved a format the org
    standard rejects (SR-2026-015) in the one place it was still reachable, and kept a native
    module on the invoice-rendering path.
  - ⚠️ **Named cost, not a silent one:** a business whose `logo_url` still points at an SVG
    gets **no letterhead** until it uploads a PNG or JPEG. Measured at the time of the change:
    23 businesses held an SVG image URL, 22 of them the `Invoice PDF Org` test fixture and
    **one real merchant** (`logo_url` and `icon_url` both `.svg`). That one needs
    a re-upload.
  - The `data:` branch SURVIVES for PNG/JPEG: the image columns are scheme-restricted now, so a
    `data:` value can only be a row written before that, and those must still render.
  - `verify:invoice-pdf`'s assertion pair was inverted accordingly — "a PNG logo is embedded" /
    "an SVG logo is REFUSED, not converted" / "…and a refused logo still renders the document".
    The PNG it tests with is encoded inline by `tinyPng` (truecolour, 8-bit, `zlib.crc32`), so
    the gate depends on no fixture file and no image library — a failure there can only mean
    embedding broke.
  - ✅ **`sharp` was REMOVED from `package.json` on 2026-09-09**, once it had no importers left
    anywhere in `src/` or `scripts/`. Two things were checked first, because both would have
    made removal unsafe: **the dashboard uses no `next/image`** (all three mentions are comments
    explaining why not), so Next's image optimiser is not a second consumer; and the peer
    worktree that also lists it (`.claude/worktrees/ui-review`) carries its own `package.json`
    and installs its own `node_modules`, so it is unaffected.
- **2026-09-08** — **The signature is pinned to a bottom CORNER, and which corner is a
  setting.** It was drawn in the content flow (after the notes, before the contact line), so on a
  short invoice it signed itself halfway up the page. Both the signature block and the contact
  line are now anchored to the foot of the page, with the signature in `bottom_right` (default)
  or `bottom_left`.
  * The band is MEASURED first and the content flow checked against it, so line items that reach
    into the footer push the whole band to a fresh page instead of being drawn over. That check is
    why the block is drawn last — it has to know where the content actually ended.
  * The HTML view is a flowing page rather than a fixed A4 sheet, so there "bottom" means after
    the content and only the SIDE carries over (`.signature--left` / `--right`). Said out loud
    because the two outputs are otherwise held to being identical.
  * pdfkit's image `align` accepts only `center` / `right`; left is the default and is expressed
    by omitting the option, not by naming it.
  * `verify:invoice-pdf` **89 → 93**: the default corner, the other corner reaching the document,
    the PDF rendering with the band in the left corner, and the HTML marking the side.
- **2026-09-08** — **UNITS and UNIT PRICE are on the invoice.** Reported as "units
  missing our invoice pdf". `chargeLines` has carried
  `quantity` and `unitAmountMinor` all along and neither was ever printed, so a line read
  `Additional Connections … ₹4,700.00` with nothing saying it was `5 × ₹940.00`. Both columns
  now render in the PDF and the HTML view — Description, [HSN/SAC], Units, Unit price,
  [Discount], Amount.
  * **UNCONDITIONAL, unlike HSN/SAC and Discount.** Gating them on "some line has a quantity
    above 1" was the tempting consistent choice and is wrong: a quantity of 1 still answers the
    question the reader is asking, and a column that appears on only some invoices makes two
    invoices look like different documents, so both print always. ⚠️ This DOES change the
    layout of every existing invoice, deliberately.
  * PDF column widths rebalanced to fit six columns (amount 0.28→0.20 of the content width,
    discount 0.22→0.17, HSN/SAC 0.16→0.12), verified by rendering the WIDEST case — HSN/SAC and
    Discount both present, an 80-character description, 1250 units and 7-figure money — and
    rasterising it, because the suites assert presence and not geometry.
  * 🔴 **That render exposed a latent overlap bug and it is the more interesting half.** The
    description was MEASURED in `Body` and DRAWN in `Bold`. Bold is wider, so a description that
    Bold wrapped onto an extra line got a row height computed for one line fewer and its last
    line printed over the row divider and into the next description. Invisible until these two
    columns cut the description column from ~56% of the content width to ~27%, which turned
    wrapping from rare into normal. `heightOfString` now uses the font the text is drawn in.
  * `verify:invoice-pdf` **84 → 89 checks**: both heads present, the head ORDER (numbers under
    the wrong caption is the failure that matters), per-line quantity and unit price in the HTML,
    and `units × unit price === gross line amount` — the column is only worth having if the
    arithmetic it exposes reconciles.
- **2026-09-08** — **The merchant decides what goes ON the invoice.** One nullable
  `businesses.invoice_customization` jsonb + a pure resolver
  (`customization.ts`, modelled on `resolveCreditsFlexibility`) governs the document title
  (`INVOICE` / `TAX INVOICE`), which fields print, the seller-address layout, a signature, and
  the number FORMAT. Consumed at exactly one place — `assembleInvoiceDocument` — which nulls
  suppressed fields so `renderInvoicePdf` and `renderInvoiceHtml` gained **no** settings
  dependency and cannot drift. Credit notes inherit all of it free (`CreditNoteDocument` IS
  `InvoiceDocument`). `InvoiceDocument` gained `title`, `shipTo`, `customFields`, `signature`,
  `paymentInstructions`, `meta.relatedInvoiceDate`, `meta.creditNoteNumbers` and
  `seller`/`billTo`.`taxRegLabel`; `billTo.id`, `subscription.id` and `meta.status` became
  nullable, which is what made the compiler point at every render site.
  * **Absence is the contract.** A null / absent / malformed key resolves to exactly the
    pre-0239 rendering, so no existing document changed. That is why the three fields never
    printed before (shipping address, credit-note number, custom fields) default to FALSE while
    everything already on the page defaults to TRUE. `verify:invoice-pdf` 51 → **84 checks**,
    pinning every toggle in BOTH directions plus "clearing the column restores the default" —
    a default-only test would pass against a resolver that ignored the column entirely.
  * **NO periodic number reset, deliberately.** `invoices_business_number_uq` (0058) makes
    `(business_id, number)` unique in Postgres, so a counter returning to 1 each period
    reproduces a used number and the invoice INSERT fails **on the billing path** — an outage,
    not a validation error. Dropping reset removes the whole failure class: a monotonic counter
    cannot collide however the prefix changes. Numbering kept the useful half — dynamic prefix
    (13 formats, stamped in the BUSINESS timezone), separators and increment.
  * **`nextInvoiceNumber` is two statements now, and the split is the point.** Only the COUNTER
    is contended, so the format is read separately and the bump stays one atomic
    `UPDATE … RETURNING`. Composing in SQL would have meant re-implementing the resolver's
    clamps as jsonb casts — a second source of truth — and a malformed `increment` would raise
    a cast error while billing instead of falling back.
  * 🔴 **Fixed on the way: `GSTIN :` was HARDCODED at all four tax-id sites** (seller + buyer,
    PDF + HTML). Written when this was believed an India-only product; it is sold into India,
    the US and the EU, so a German seller's VAT number printed captioned "GSTIN".
    `taxRegLabelFor(country)` → GSTIN (IN) / VAT (EU-27 + GB/NO/CH/IS/LI) / "Tax ID" (US and
    unknown), resolved in the assemblers. ⚠️ **This one DOES change existing documents** for any
    non-Indian seller — the previous output was simply wrong.
  * `show_payment_stub` hides the payments FOOTER and deliberately not
    `totals.amountPaidMinor`: that is a term of the arithmetic the document prints, and an
    invoice whose ladder stops reconciling is worse than one showing a payment the merchant
    wanted hidden. Asserted.
  * Payment instructions are their own table (0241, `payment-instructions.ts` +
    `payment-instruction-service.ts`), closing the "No per-currency payment instructions on
    invoices" gap. Its `preferred_offline` mode falls back to showing ALL when the
    customer's rail matches nothing — an invoice nobody can pay is the worse failure.
  * Notes and the signature caption stay **plain text**, deliberately: these
    interpolate into a customer-facing PDF and HTML view, and merchant-editable markup there is
    an injection surface.
- **2026-09-08** — The invoice states WHICH discount reduced it, and the Amount column
  is NET. Reported as "discount from coupon is not clear here":
  an item-level coupon is netted into `subtotal_minor` and attributed per line, so the money
  always added up — but the Amount column printed the GROSS line, leaving Σ lines visibly larger
  than Sub Total with nothing naming the gap, and the coupon's code lived only in
  `invoice_line_discounts.label` and was printed nowhere. Both are answered now:
  `amountMinor − itemLevelDiscountMinor` in the Amount column (so Σ Amount IS Sub Total), plus a
  "DISCOUNT" footer on the PDF/HTML and a "Discount details" card on the operator page.
  `serializeInvoice`'s `discounts[]` gained `source`, `coupon_code` and `line_item_ids`;
  `InvoiceDocument` gained `discountDetails` and a per-line `itemLevelDiscountMinor`. All three
  discount kinds are distinguished, because `label` cannot: a MANUAL discount is labelled
  "Discount" only because that is `peekDiscounts`' default invoice name. A coupon-set redemption
  prints the code the CUSTOMER holds, recovered by joining `coupon_set_codes.applied_coupon_id`
  — no migration needed, the back-link was already written. Document-level stays as it was: it
  has its own ladder row, and netting it into a line would double-count it.
- **2026-09-07** — The invoice page shows OPEN INTENTS, read-only. A buyer part-way
  through Pay now (or one who walked away) writes no transaction and no `payments` row, so
  "Payments and credits" could not see one and an operator had no way to know a checkout was
  already open at the gateway for that invoice. Shown as its own group above the money, and
  deliberately NOT folded into `payment_in_flight`: that flag takes "Collect now" away and its
  banner claims a debit "has been accepted by the gateway", neither of which is true of an open
  intent — pressing Collect now RESUMES it. `pendingPaymentsForInvoices`' note names this page as
  one of two still needing an intent-aware branch; this is the read-only half. The intents list
  gained an `invoice` filter (public id, resolved in the service) which returns an EMPTY page for
  an unknown id rather than dropping the clause — mutation-tested, because dropping it renders
  another invoice's checkout as belonging to this one.
- **2026-09-07 (latest)** — Gateway descriptions name the FLOW: `Renewal`, `Manual collection`,
  `Portal payment`, `New subscription`, ahead of the invoice number, plan and email
  (`ChargeFlow` in `charge-description.ts`). The INTENT path sent no description at all and fell
  back to the adapter's `"Card authorization"` placeholder; it now builds one from the invoice or
  the subscription. ⚠️ Not "PayNow" — `paynow` is a Stripe payment METHOD (Singapore), and these
  labels reach the payer's receipt, not just our dashboard. `setupChargeDescription` covers the
  VAULT paths, which had no description at all on Stripe and only RazorPay's generic default
  elsewhere: `Payment method setup · up to ₹15,000.00 per charge · a@b.com`, with no flow label
  because none is true of an object that moves no money.
- **2026-09-07 (latest)** — A FIFTH mandate pre-flight: `mandateMissingRefusal`, for an
  instrument that is mandate-bound and carries no mandate reference. The other four each read a
  mandate fact and bow out when their field is absent, so an instrument missing the mandate
  entirely satisfied all four and the debit reached Stripe — which refused it AFTER creating the
  PaymentIntent, leaving the orphan `orphaned_gateway_intents` reported twice on 2026-09-06/07. A
  refusal raised here creates no gateway object, so there is nothing to strand. Placed FIRST in the
  chain: it is the only one whose buyer-facing message is true in that state. Gated on the new
  `perDebitMandateReference` capability (Stripe only) **and** the instrument already carrying
  `mandate_status = 'missing'` — which the collection path WRITES the first time this gateway
  refuses a debit for a missing mandate. So it is learned, never derived: three attempts to infer
  it from our own data were each wrong (the pm row refused every tmtest fixture; the row test
  covered none of the 13 migrated rows, which are bare; the currency would decline an
  international card billed in INR). Zero false declines by construction, at one round trip per
  instrument. `mandate_missing` is in `PARK` and `PARK_EVEN_IN_FIXED_MODE`.

- **2026-09-06** — ✅ **#99: the invoice document — what it says, and how it is set.** The
  billing period was the SUBSCRIPTION's current one whenever the invoice had none of its own,
  which is every imported invoice (an imported document carries no top-level period; it lives on
  the line items). It now falls back to the invoice's own line span — 1,109 of 1,123 real imported rows
  recover their true period with no backfill — and prints nothing when neither exists.
  `nextBillingDate` came from the subscription ALWAYS and is now the invoice's own period end.
  Both renderers reconcile: an imported invoice carries no credit application while its
  `amount_due` arrives net of one, so `total − deductions − due` prints as "Credits" with a
  note beneath, no date claimed. Countries print as names via `Intl` (NOT `@/platform/geo` —
  that registry is cold outside a warmed API). The PDF geometry was reset:
  right-aligned summary labels, rules bracketing Amount Due only, bracketed column heads, short
  section rules, 7pt tracked micro-labels, parties in ink. Font DejaVu → **Noto Sans**;
  ⚠️ Liberation Sans was tried first and renders ₹ as an EMPTY BOX — `widthOfString` does not
  catch a missing glyph, check the charset. ~~SVG logos rasterise through sharp (density BEFORE
  resize).~~ **No longer true from 2026-09-09** — `loadLogo` refuses SVG and `sharp` is gone;
  see this changelog's 2026-09-09 entry. Still live and unsnapshotted: the seller block and bill-to GSTIN — deliberately, see
  PROGRESS. `verify:invoice-pdf` 23 → 43.
- **2026-09-06 (latest)** — `UNDER_RETRY` no longer lists VOIDED invoices. Its dunning arm was
  `dunning_status IS NOT NULL` with no status filter, so a dunned-then-voided invoice stayed on the
  Retries screen forever — 122 of 476 rows on the real book. Fixed as a predicate rather than a
  sweep: the row is truthful (voiding does not erase a dunning history) and a sweep would be undone
  by the next void. `paid` deliberately stays — a recovered invoice is a successful retry.
- **2026-09-04** — Parking an invoice now stamps `invoices.dunning_parked_at` (0232). It is
  the anchor `parkedDunningDeadline` measures a parked window from — a park has no retry to count
  down from, and the due date it used to borrow was long past for every already-parked row. Only
  meaningful while `dunning_status='parked'`; never cleared on the way out, because every park site
  overwrites it. Full decision: `src/modules/subscriptions/README.md`, `docs/PROGRESS.md` #59.

- **2026-09-04** — 🔴 **`voidInvoice` now releases the credit-note allocations the invoice consumed,
  and ends a LIVE dunning chase (#57).** The ledger half was always right — the compensating
  `invoice_void` entry mirrors `credit_applied`, so the bucket gets its money back — and every
  denormalised satellite was left behind, which read as ₹0 available on the credit note and REFUSED
  to refund the customer their own money. `releaseAllocationsForVoidedInvoice` (credit-notes) is
  called inside the void's transaction, and the `invoice.void` audit row now records
  `credit_released_minor`. Full reasoning, and why the rows are deleted rather than reversed, in
  `src/modules/credit-notes/README.md`.
  * **The dunning half, same root:** the claim set `next_attempt_at: null` and never touched
    `dunning_status`, so a voided invoice kept reading `in_progress` — 41 such rows on this box. The
    clock cannot act on them (`runDunningPass` needs `next_attempt_at IS NOT NULL`; the offline
    reminder scan and `sweepStrandedRetries` both require `status = 'payment_due'` — all three
    checked, not assumed), but `listRetriesPage`'s `UNDER_RETRY` is `… or dunning_status is not null`
    with no status filter, so they DID show on the /retries screen.
  * **Only `in_progress` and `parked` are ended, to `stopped`** — NOT
    `dunningFieldsOnCreditSettle(inv)`, which was the first attempt and is wrong here: it rewrites
    ANY chased invoice, and dunning's own final action voids from `not_paid` + `exhausted` (203 such
    rows on this box, 168 with a real failed attempt). `exhausted` is terminal and TRUE, and
    overwriting it broke three existing `verify:dunning-offline` checks — measured, not reasoned.
    A never-chased invoice keeps its null, so a void cannot invent a collections history.
  * `verify:apply-credits` 9E (a live chase is stopped) + 9L (an exhausted one is preserved); 9L is
    killed by reusing the broad helper.

- **2026-09-03** — 🟠 **`pendingPaymentsForInvoices` could not see a buyer's checkout**, because it
  selects `payments.status = 'pending'` and an intent-only checkout has no payment row until its capture
  settles. That is why the change screen's in-flight-debit warning stayed silent while a downgrade
  credited an invoice out from under a buyer who was mid-payment. It now unions live `payment_intents`
  (`purpose='payment'`, `in_progress`/`authorized`, unexpired) and reports `kind: "payment" | "intent"`.
  **The union is OPT-IN (`includeIntents`), and that is load-bearing:** of the three callers, the portal
  hides "Pay now" whenever it sees something in flight — while the collect route RESUMES a live
  `in_progress` intent with the same gateway order — so unioning it there would take the button away in
  the one state where pressing it is correct, and the `AbandonAuthenticationButton` beside it keys on a
  transaction an intent does not have. `kind` exists for the same reason: the existing copy "they can
  release it from their billing portal" is false for an intent. See #16 in `docs/PROGRESS.md`.

- **2026-09-02** — **`exchange_rate` / `exchange_rate_base` are filterable.** Added to
  `LIST_FILTERS`, so `?exchange_rate[is_present]=false` answers "which invoices can a converted
  report not account for" — the question the snapshot creates. `kind: "number"` accepts decimals,
  so `exchange_rate[gt]=95` works on a rate as well as on money. The openapi mirror test caught
  the two fields being undocumented within seconds of adding them, which is what it is for.

- **2026-09-02** — **Invoices now carry the exchange rate that applied when they were finalized.**
  `exchange_rate` + `exchange_rate_base` (0228, nullable, CHECKed both-or-neither and `> 0`),
  reported as STRINGS from `numeric(20,10)` — a JSON number would round `94.953741` to
  `94.95374099999999`. `exchange-rate.ts` resolves them: `1` for a document in the business's own
  default currency (parity is a fact there), the configured `businesses.exchange_rates` entry for a
  foreign one, and **null — never 1 — when no usable rate exists**. Stamped at FINALIZE via
  `invoiceValues`, which the close path also writes, so a long-lived `pending` draft is stamped at
  close rather than carrying a week-old rate; resolved once at plan time for the same reason
  `creditLimits` is. The archival importer takes the source document's own rate or leaves null.
  Reporting/audit only — nothing in the billing path reads it.

- **2026-09-01** — **An explicit apply-credits action, because Credits Flexibility needed one.**
  `POST /v1/businesses/:biz/invoices/:inv/apply_credits` (`applyCreditsToInvoice`, this module's
  `ops.ts`) draws a customer's refundable / excess credit onto ONE named invoice on an operator's
  say-so. One action rather than two, because our credit lives in buckets rather than documents.
  * **Why it had to ship with 0219.** `planCreditApplication` and `collect_payment` both obey the
    business's Credits Flexibility grid, so "Do not auto-apply" left a merchant with **no way to
    apply credit at all** — the setting stopped deferring automatic application and started
    abolishing application. That hole was opened and closed the same week.
  * **DECISION: an explicit apply IGNORES the ceilings**, both the site grid and the
    per-subscription maxima. Every mode in that grid is phrased about AUTO-application, and the
    subscription fields are a maximum up to which credit may be *auto-applied*: a
    ceiling on what the engine may do unprompted is not a statement that the money is unspendable,
    and the operator invoking this route is the decision the ceiling exists to defer to. The
    mirror-image argument is why `collect_payment` still obeys them — there the caller says "settle
    these invoices" and the engine still picks the buckets. The line is *who chose the money*.
  * **What is NOT waived**, because none of it is a preference: the invoice's outstanding balance,
    the bucket balance, the currency, the invoice being open and finalized, tenancy, and the
    `lockCustomerBalances` + `FOR UPDATE` pair. An EXPLICIT amount that does not fit is **refused,
    never clamped**. `promotional_minor` is not a field and the body schema is `.strict()` so
    reaching for it is a 400 rather than a silently stripped no-op — promotional credit is pre-tax
    and cannot be applied to a finalized document without re-cutting its tax.
  * Settling by credit posts `dunning_status: 'stopped'`, not `'success'` (`dunningFieldsOnCreditSettle`
    — no cash arrived), allocates the refundable draw FIFO to the funding credit notes, and emits
    `invoice_paid` / `invoice_updated` / `customer_updated` once each whichever bucket paid.
  * Gate: `scripts/verify-apply-credits.ts` (`pnpm verify:apply-credits`, 43 checks), registered in
    `verify-all.sh`. §2 is the load-bearing one — it asserts the ceilings are ignored AND that
    automatic application still obeys them against the same fixture.
  * API-only for now: no dashboard affordance yet (see the suite's header for the shape).

- **2026-09-01** — **`unit_amount_minor` is the CONTRACTED RATE, forward only.** It carried three
  conventions at once: `amount ÷ quantity` on renewal and prorated-charge lines, `= amount` on "Unused
  time on X ×qty" and discount/tax/rounding rows, and a genuine contracted rate on every imported
  invoice (the importer reads `unit_amount ?? amount`, which is only meaningful where the source keeps
  them independent). A credit that needs to know what a customer was billed AT therefore could not cite it.
  * The model: `unit_amount` is the rate, `amount` is the slice charged, and the period
    columns explain the gap. **`unit × qty ≠ amount` on a prorated line is correct**, not a defect.
  * `createLineItems` honours a caller-supplied `contractedUnitMinor` and otherwise falls back to
    `amount ÷ quantity`. That one division was defining the column for most of the table — the ~20
    values `proration.ts` computes were being DISCARDED there. The fallback stays deliberately: a
    document-level discount row or a rounding delta has no contracted rate to state, and inventing one
    would be a fourth convention.
  * Renewal lines now STATE the rate (`computeLineAmount(ratable, 1)`); on a full period the two
    coincide, which is why it is the reference case, but it also keeps tiered/percentage models honest,
    where "one unit" is what the model says rather than an average of the line.
  * FORWARD ONLY, no backfill. Rows before today are mixed and cannot be back-derived — a prorated line
    never recorded its own rate and the item's snapshot has usually moved since. `db/schema/invoices.ts`
    now documents all of this; the absence of that docblock is why it drifted.
  * ⚠️ This does NOT license the credit-basis fix: reading this column over-credits by ₹16,920 in the
    deferred shape, because `settleQueued` already carries the delta (measured). Gated by
    `scripts/probe-unit-rate-semantics.ts`.

- **2026-09-01** — **Net terms are one rule for every invoice.** `createInvoiceFromLines` ignored the
  chain, so a Net-30 customer got 30 days on their renewal and ZERO on the proration invoice a mid-term
  change raised — then was dunned on it immediately, contradicting the terms they were sold.
  `netTermDaysFrom` (subscription → customer → business) is now shared with the period path. `0` means
  "no terms at this level" and falls through, which is why it is `||` and never `??` — a future tidy to
  `??` would silently make a stored `0` beat the level above it, so `test/unit/net-terms.test.ts` pins it.
  Such invoices are born `posted` and `due.ts` moves them on the date.

- **2026-08-31 (night)** — **An offline invoice is enrolled in dunning as raised, and a
  credit-settled invoice stops claiming a payment succeeded.** ⚠️ This SUPERSEDES the 2026-08-19
  `dun_offline_invoices` entry below, which describes the old semantics (window opened at the DUE DATE,
  flag off by default, `posted → not_paid`).
  * THE MODEL: an `auto_collection: off` unpaid invoice is `payment_due` +
    **`dunning_status: in_progress`** + `next_retry_at = date + first retry offset` + NO dunning
    attempt **as raised**, with `due_date` equal to the invoice date at net-0. Ours said `not_paid`,
    `dunning_status` null, `due_date` NULL, and `attempt_count` 1 — four wrong writes in one branch,
    and the proration invoice disagreed with our own
    renewal invoice on the same customer. Now: enrolment at RAISE (`enrolOfflineInvoiceInDunning`),
    `due_date` defaulting to the invoice date, and a new `send_invoice` failure-rearm action that writes
    NOTHING — no status, no dunning fields, no attempt — because with auto-collection off no charge was
    ever made. `'offline'` survives for its other meaning (dunning off while auto-collect is ON, where a
    charge really did fail, so `not_paid` is honest). `dun_offline_invoices` now defaults **ON**.
  * ⚠️ **The due-date scan had to move with it.** With `due_date` defaulting to the invoice date, the old
    scan would have flipped every offline invoice to `not_paid` immediately — the exact opposite.
    An offline invoice now stays `payment_due` for the whole window and becomes `not_paid` only at
    EXHAUSTION. The old structural shield ("nothing acts on `next_attempt_at` unless the row is
    `payment_due`/`posted`, and this row is `not_paid`") is void now that the row IS `payment_due`; it is
    replaced by explicit `autoCollectionOnSql()` filters in both retry passes. That filter belongs in the
    SQL `WHERE`, not per row: both scans are LIMIT-bounded and ordered, so on the dev DB's 1163-row
    backlog the offline invoice fell off the page and its window never closed.
  * **Blast radius of the default flip** (approved explicitly): `businesses.dunning_config` is jsonb with
    no column default, so the rows affected are those where it is NULL or omits the key — a business that
    ever saved the Dunning form has an explicit boolean and keeps its choice, but a PATCH without the key
    counts, since `updateBusiness` replaces the jsonb wholesale. Audit with
    `SELECT id, name FROM businesses WHERE dunning_config IS NULL OR NOT (dunning_config ? 'dun_offline_invoices')`.
    Those businesses begin sending `invoice_overdue` reminders (default ladder `[1,3,5,7]` days from the
    due date, so up to 4 mails per invoice). Nothing is voided, written off or cancelled unless
    `dunning_period_days` is set — it is null by default, so for them the flip is reminders only. Existing
    `not_paid` offline invoices are NOT retro-enrolled; no backfill was asked for or done.
  * **`dunningFieldsOnCreditSettle`** (in `status.ts`) replaces `dunningFieldsOnSettle` where an
    adjustment drives `amount_due` to zero. `success` was a lie there and had shipped as one: ten live
    invoices on `sub_XXXXXXXXXXXXXXXXXXXXXX01` read `status: paid, dunning_status: success` while their
    only payment attempt had FAILED — all zeroed by adjustment notes. The right answer: `paid` with
    `paid_at` = the adjustment's timestamp, `amount_paid` staying **0**, `next_retry_at` dropped, and
    `dunning_status` **`stopped`**. The chase ended; it did not succeed.
  * `verify:dunning-offline` 26 → **46 checks**. Assertions that encoded the old behaviour were changed
    rather than deleted, each listed in `docs/PROGRESS.md` — including two that only ever passed by
    accident of a clean DB (they asserted a SYSTEM-WIDE counter) and one, `verify-invoices-v2` § W, whose
    old expectation *was* the bug.
- **2026-08-31** — **The invoice list filters on 33 fields, up from 14**, and one of the 14 was
  lying. Ours made the operator export to a spreadsheet to ask "which invoices are actually owed
  money", "which are stuck in dunning", "which were written
  off", "which quote this PO". Added: `dunning_status`, `channel`, `written_off`, `subtotal_minor`,
  `promotional_discount_minor`, `credits_applied_minor`, `amount_paid_minor`, `withholding_minor`,
  `period_start`, `due_date`, `paid_at`, `voided_at`, `expected_payment_date`, `po_number`,
  `seller_state_code`, `place_of_supply_code`, `tax_treatment`, `tax_note`. Sorts gained `number`,
  `subtotal_minor`, `period_start`, `due_date`, `paid_at` (plain single columns; `created_at`
  remains the only keyset path).
  - **`amount_due_minor` filtered the raw column and therefore answered the wrong question.** That
    column is the ISSUE-TIME collectible and is deliberately never decremented as cash lands — the
    trap `invoiceOutstanding` and the schema comment both warn about, and the majority of `paid`
    rows carry a non-zero value in it. So `?amount_due_minor[gt]=0`, i.e. "show me what is owed",
    returned every settled invoice in the business. It now compares the same expression
    `serializeInvoice` prints: `greatest(coalesce(column, total − promo) − succeeded payments, 0)`,
    zeroed for written-off and voided. Same failure mode as the raw `period_end` filter fixed
    earlier; the two other derived money fields (`credits_applied_minor` = refundable + excess only,
    `amount_paid_minor` = the `payments` aggregate) were built on the printed expression from the
    start, and `promotional_discount_minor` takes the SERIALIZED name rather than the column's.
  - `INVOICE_FILTER_KINDS` (`kindsFromSpecs`) is now passed to `parseListQuery`, so a malformed
    value — `amount_due_minor[between]=10`, `paid_at[on]=31/08/2026` — is a 400 naming the shape
    instead of a 500 out of the Postgres cast. Both allow-lists derive from `listFilters(tz)` rather
    than `LIST_FILTERS`, so the conditional `period_end` spec can never be a field the route accepts
    but cannot validate.
  - Not added, for want of a column: `updated_at`, `amount_adjusted`, `write_off_amount`
    (we keep only the boolean), `round_off_amount`, `price_type`, `payment_owner`, `vat_number`,
    `business_entity_id`, `deleted`. "Recurring vs one-off" needs no field of its own —
    `subscription[is_present]=false` is that question, and a second name for one predicate is how
    two filters that read alike start disagreeing.
> ⚠️ **Entries before 2026-08-29 were written when nothing was in production**, and several justify a
> breaking change on exactly that ground (e.g. the 2026-07-14 `amount_due_minor` meaning change:
> "allowed: nothing in prod"). That premise died on 2026-08-29, when the billing clock took a
> 46-minute PRODUCTION outage — tmbilling bills real customers under pm2, and per the India vendor
> split every new Indian customer lands here. Those entries are correct as HISTORY and are left
> exactly as written; do not read them as current licence. A breaking schema or API change now needs
> a migration and a deploy story.

- **2026-08-30** — **The status vocabularies are now enforced by Postgres** (`0218`), and two stale
  schema comments are gone. `invoices.status`, `invoices.dunning_status` and `credit_notes.status`
  were plain `text` with no CHECK, on a table carrying none at all — while `api_keys_kind_ck`,
  `businesses_billing_mode_ck` and two others constrain the same shape elsewhere. The cost was
  already recorded in `status.ts:44`: `parked` is written by `settlement.ts` and `dunning.ts` every
  day and was **missing from the `DunningStatus` union**, and nothing caught it because the column
  was free text. `credited` was the mirror image — declared, unwritable, and filtered on by five
  readers as though that were protection. The allowed lists were established from three independent
  sources that had to agree (the canonical unions; every ORM write site, brace-matched so a
  neighbouring `.set()` could not leak literals in; `SELECT DISTINCT` on the local DB) plus the
  importer's closed `mapInvoiceStatus` switch. `pending` is allowed although no local row holds it —
  five sites write it. Constraints were added VALIDATED, not `NOT VALID`, so the migration itself is
  the check on those lists; `convalidated = true` on all three.
  - Two comment fixes in `db/schema/invoices.ts` found while in there. `payment_due` was described
    as "a charge failed and dunning is retrying" — it is also the status an invoice with **no due
    date is BORN in**, which is the common case, not the exception. And `amount_due_minor` said only "amount actually due"; it is an
    **issue-time snapshot that is never decremented**, so most `paid` rows carry a non-zero value
    while the live figure is derived in `serialize.ts`. Reading the column as an outstanding balance
    has already misled a reader.
  - Gates: `verify:dunning`, `verify:dunning-smart`, `verify:dunning-offline`,
    `verify:dunning-nonretriable`, `verify:invoice-ops`, `verify:stale-pending`,
    `verify:migration-history`, `verify:invariants` — all pass, and between them they drive every
    writer of the three columns. Rejection proved directly: `status='credited'`,
    `dunning_status='bogus'` and a bad credit-note status are all refused by name.

- **2026-08-29 (later)** — **`runInvoiceDueTransitions` and `runAutoClosePending` moved to
  `log.recurringError`.** Now that both record per-invoice failures into `clock_ticks.errors`
  (entry above), suppressing the repeat is safe: an invoice failing its due-date transition on
  every one-minute tick logged 1,440 identical stacks a day for one cause. The first occurrence
  logs in full, later ones are counted, and the durable record is unaffected — suppression is for
  the log, never for the record.

- **2026-08-29** — **The printed tax was bigger than the tax charged, on 36 invoices.** Both
  writers of the synthetic `tax` line items summed only the POSITIVE `applied_taxes` rows
  (`if (r.inclusive || r.amountMinor <= 0n) continue`), while `additiveTaxMinor` — and therefore
  `total_minor` — nets every row. So any invoice carrying a REVERSAL printed the charge's tax and
  swallowed the credit's: an "Unused time" proration credit on the renewal path, and — on
  `createInvoiceFromLines`, which passes every line to `computeInvoiceTax` — the document-level
  discount line too. Measured: INV-3213's rows −164124 / +164124 / −16920 / +33840 net to ₹169.20
  of IGST against a LINE that said ₹1,979.64; INV-4317 printed ₹5,455.01 against ₹5,390.71.
  **No money moved** — `total_minor`, `amount_due_minor`, the payments and the ledger were right
  throughout, which is exactly why nothing but a document invariant could see it. What is wrong is
  what the customer receives: the lines do not sum to the total, and on an Indian GST invoice they
  state an input credit the buyer cannot claim.
  The `<= 0n` guard arrived with the GST component vector (`07070ee`) and was copied to the second
  writer by the inclusive-tax fix (`fe3b2f8`); the invoices only appeared once the 08-27/08-28
  journey runs started producing INR prorations and document-level discounts at scale.
  Now: rows are summed SIGNED per component, a component whose charges and reversals cancel gets no
  line, and a net-negative component gets a negative line so the document still adds up.
  `verify:tax-lines` gained four assertions (confirmed to fail with the fix reverted), a new ops
  invariant `tax_lines_match_applied_taxes` watches the identity directly, and
  `scripts/repair-tax-line-items.ts` re-derived the 37 documents already written — repairing only
  where the repaired lines sum EXACTLY to the invoice's own total, and naming anything else rather
  than guessing at it.

- **2026-08-29** — **Invoice lines are ordered plan-first, then by AMOUNT ASCENDING — one rule,
  `orderDocumentLines`, shared with the proration path.** It closes two defects at once. (1) The
  order FLAPPED across runs: `planSubscriptionPeriodInvoice` ordered items
  `plan-first, createdAt, id`, and two add-ons attached in the SAME transaction share a `createdAt`,
  so a random uuid decided — three identical offline replays returned 0 fail, 8 fail, 0 fail
  with no code change between them. (2) Add-ons belong cheapest first. Insertion order and
  alphabetical are both ruled out by a document reading `[plan, gds 5527200,
connections 9024000]` where connections was added FIRST and also sorts first alphabetically; unit
  amount is ruled out too (connections is 902400/unit × 10). Amount is what both bugs want: stable
  across runs AND the order a reader expects. It cannot live in the query's `ORDER BY`, which sorts
  `subscription_items` before any amount exists, so the decision moved onto the computed lines; the
  `ORDER BY` stays only to make the rating walk deterministic. CREDIT lines deliberately keep their
  exact index — no fixture carries an invoice with a negative line at all, so ascending amount
  would sweep every credit to the front of the document on a guess. A ZERO line is a charge and does
  sort (a free `Additional Connections`, say). Ad-hoc `unbilled_charges` folded onto a
  renewal stay appended after the recurring lines. 12 fail → **0**; the rule itself is pinned by
  `test/unit/invoice-line-order.test.ts`.
- **2026-08-28** — **The operator collect route lost the same intent race the portal did.** Two
  settlers reach for one payment intent by design: whoever posts the second leg with
  `payment_intent`, and `intent.authorized` reaching `harvestInvoiceIntent` in the inbound webhook
  (which exists because the browser sometimes never comes back). The webhook side answers
  `processed`/`ignored` when it loses; this route threw `Intent already consumed`, mapped it to a
  400, and showed an operator a failure for money captured a moment earlier. Now reported as the
  OUTCOME the intent produced — the invoice, with `payment_error` only when money is still owed —
  checked BEFORE the consume and caught AROUND it, because the race lands either side of the read. An
  intent consumed into a DIFFERENT invoice stays a hard 400: nothing there paid this one. Identical
  treatment to the portal's `POST /portal/v1/invoices/:inv/collect`, and its regression test sits
  beside the portal's in `verify:customer-portal` precisely so one cannot be fixed while the other
  quietly regresses. Both mutation-tested.
  Note `POST /v1/businesses/:biz/subscriptions` (intent path) does NOT share this race: the webhook
  only harvests intents that name an invoice, and a subscription-create intent has none yet.
- **2026-08-25** — **Promotional credit is a PRE-TAX DISCOUNT on the invoice document, not an applied
  credit.** The engine has always applied it before tax (it shrinks the taxable base —
  `resolvePeriodInvoiceMoney`, and the same clamp loop in `createInvoiceFromLines`), but the document
  reported it below the total as `credits_applied`. On a promo invoice that made the document
  unreadable: `subtotal 2791800`, one line "IGST (18.00%) 322524", `total 3114324` — and 18% of
  2791800 is 502524, not 322524. The taxable value the tax was actually charged on (1791800) appeared
  nowhere, which an India GST tax invoice is required to state (CGST Rules r.46(m)–(n)).
  The model, read off real imported documents rather than inferred: one with
  `sub_total 4189900, total 0, credits_applied 0` carries
  `discounts[0] = { entity_type: "promotional_credits", description: "Promotional Credits",
amount: 4189900 }`; `credits_applied` is reserved for the POST-tax buckets
  (`sub_total 25474000, total 30059320, credits_applied 4902664,
amount_paid 25156656`). This is the INVOICE twin of the credit-note document model in
  `d116c1e`/`9516832` — the same typed-discount shape, one document over.
  - `serializeInvoice` now reports `total_minor = total_minor − promotional_credits_applied_minor`,
    `credits_applied_minor = refundable + excess`, a new always-present
    `promotional_discount_minor`, the slice inside `document_level_discount_minor`, and a
    `discounts[]` entry typed `promotional_credits`. Every `discounts[]` entry now carries
    `entity_type`. The stated identity `subtotal − document_level_discount + tax = total` holds again,
    and `amount_due = total − withholding − credits − paid` still does: 2791800 − 1000000 + 322524 =
    2114324, minus 0 credits and 2114324 paid = 0.
  - `assembleInvoiceDocument` synthesises the slice at the head of `discountLines` (above the tax
    rows) and reports `totals.totalMinor` net of it; `totals.creditsApplied` lost its `promotional`
    member, and the HTML (`ops.ts`) and PDF (`invoice-pdf.ts`) renderers lost the row that printed it
    below the Total — carrying it in both places would subtract the same money twice.
  - `invoice_generated` / `invoice_closed` carry the same net `total_minor`. One field name, one
    number: a webhook and a GET disagreeing about `total_minor` for one invoice is a reconciliation
    bug waiting to be written by a consumer.
  - The list filter and sort on `total_minor` moved to the same expression the response prints
    (`reportedTotalMinor`), so `?total_minor[gt]=…` cannot answer a question about a number the caller
    never saw.
  - **The COLUMN `invoices.total_minor` is deliberately unchanged** — it stays the GROSS taxed claim,
    which is exactly what `accounts_receivable` is debited at issue. Redefining it is a much larger
    change than it looks, and it lands squarely in three files this work was fenced out of:
    `credit-notes/service.ts:281` and `:561` derive `taxedGross = total − promotionalCreditsApplied`;
    `subscriptions/proration.ts:754`/`:820` derive `netBase = total − bookedTax` and `:764` prorates
    `shares × total / listBase`; `subscriptions/cancellation-credit.ts:299-301` uses `total` as the
    proration base. Each would silently double-subtract the promo. The ledger would also need AR
    decoupled from `total`, and `ops/invariants.ts`'s `invoice_total_consistent` reconciles
    `total_minor` against Σ line items — a promo discount LINE would be needed there too, which needs
    a migration. Presentation is therefore derived at the edge, exactly the split
    `amount_due_minor` already uses (stored = issue-time collectible, reported = remaining balance).
  - **No cash moved.** Same fixture before and after: invoice row (`total_minor 3114324`,
    `amount_due_minor 2114324`, `promotional_credits_applied_minor 1000000`), line items, and all
    nine ledger postings byte-identical (`invoice` dr AR 3114324 / cr revenue 2791800 / cr tax_payable
    322524; `credit_applied` dr promotional_credit_balance 1000000 / cr AR 1000000; `payment` dr cash
    2114324 / cr AR 2114324). API `amount_paid_minor 2114324` and `amount_due_minor 0` unchanged.
- **2026-08-24** — **An invoice drawing promotional credit now emits `customer_promotional_credits_deducted`.**
  `postCreditApplications` posted `dr promotional_credit_balance / cr accounts_receivable` and said
  nothing, so the one event that reports that balance falling only ever fired from the explicit
  deduct API — a consumer reconciling promo credit over webhooks watched it drop silently every time
  an invoice was funded by it. Emission is via the shared
  `emitPromotionalCreditMovement` in `customers/balances.ts` so the payload matches the manual grant
  and deduct exactly, and it carries the invoice's public id at the top level. Emitted from inside
  `postCreditApplications` itself, so all three call sites — `billSubscriptionPeriod`,
  `createInvoiceFromLines`, and `collectPayment` (which always passes `promotional: 0n`, hence a
  no-op there) — are covered by construction, and a future fourth cannot forget. Deliberately NOT
  gated on `suppressCreditDrawEvents`: that flag suppresses the DERIVED `customer_changed` +
  `invoice_updated` that belong to `invoice_generated`, while the promotional-credit movement is
  still emitted on the same draws. Only the promotional bucket is reported; refundable
  and excess have no per-bucket event type.
- **2026-08-24** — **"View / print" now opens a print tab, not a bare HTML page.** It hands you a
  paper-shaped document with the print dialog already up; it used to open the raw HTML render, so
  printing took two more clicks and the page never looked like the thing about to come out of the
  printer. Two changes:
  - The document now **pins its own paper**: `@page{size:A4 portrait;margin:12mm}`, and `@media print`
    drops the old `body{padding:24px}` so 12mm is the ONLY margin. Without a `@page` size Chrome
    prints whatever orientation the operator last chose — a landscape invoice, with the summary
    stranded and the Payments block pushed onto a second page (measured on INV-14).
  - `renderInvoiceHtml` takes `{ print }` (plumbed through `GET .../invoices/:inv/html?print=1` and
    the dashboard's BFF proxy, which forwards that one flag and nothing else): screen-only chrome —
    the document on an A4 sheet over a grey backdrop, a sticky toolbar with the invoice number and a
    Print button, and a load handler that opens the dialog once (200 ms delay; printing mid-load
    drops the logo from page 1). The sheet is 210×297mm with the same 12mm padding the `@page` rule
    prints, so the preview is WYSIWYG. `@media print` hides the toolbar and flattens the sheet, so
    the two views put identical ink on paper and the PDF↔HTML mirror still holds.
    Verified over CDP: `.bar { display: none }` and the sheet's padding/margin/shadow reset under print
    media; the on-screen sheet measures 794×1123px (A4 at 96dpi); `Page.printToPDF` with
    `preferCSSPageSize` is **one portrait page** for both INV-16 and the previously two-page INV-14.
- **2026-08-23** — **`applied_taxes` did not reconcile on an invoice with a negative line.**
  `createInvoiceFromLines` taxed the invoice on `discountedSubtotal - promoApplied` (the net) while
  `recordLineTaxes` re-derived each component from its OWN base — the POSITIVE lines only. On a
  proration invoice carrying a "Remaining time on …" charge plus an "Unused time on …" credit the
  two differ by the credit line's tax. Measured on a real invoice: header ₹261.98 against
  Σ`applied_taxes` ₹1,571.92, a ₹1,309.94 overstatement in the one table a GSTR-1 export reads.
  The customer was charged correctly throughout — only the per-component breakdown was wrong.
  Two changes, both about having ONE source of truth: the per-component amounts are now computed
  once in the caller and drive BOTH the synthetic tax line items and the rows (passed in as
  `componentAmounts`), and the allocation runs over SIGNED lines
  (`allocateTaxAcrossSignedLines`, tax/service.ts) so the credit line carries negative tax.
  Verified on a live proration invoice: `+11,699,060 → IGST 2,105,830` and
  `−749,940 → IGST −134,989`, summing to the header's `1,970,841` exactly.
  **Scope limits, deliberately not widened here.** (1) `computeInvoiceTax` — the OTHER
  `applied_taxes` writer, used by `commitSubscriptionPeriodInvoice` — still has the same
  `positive` filter. No failing case was measured on that path (its lines come from a period plan;
  discount and tax rows are inserted separately and never reach the tax input), so it is left alone
  rather than changed blind. (2) Historical rows are NOT rewritten. In the local DB 26 exclusive-tax
  invoices with a negative line carry overstated rows (₹2,841.81 in total); whether `applied_taxes`
  — an audit record — should be backfilled at all is a separate decision.
  ⚠️ **The reconciliation invariant is `Σ applied_taxes == total − subtotal` for EXCLUSIVE tax
  only.** Under inclusive pricing the tax sits inside the line amounts and no tax line item is
  added, so the header difference is 0 while the rows hold the backed-out tax — correct by design,
  and 32 such invoices in the local DB look like violations if the qualifier is dropped. The new
  `verify:tax-lines` check is scoped accordingly.

> Marker legend: **✅** a severe (money / data-integrity) bug — found, fixed and gated in that entry ·
> **🟠** a correctness or concurrency bug · **🟢** a follow-up / cleanup. Severe entries read 🔴 until
> 2026-08-17; the red dot was scanning as an OPEN defect when every one of them was closed. An entry
> with work still outstanding says so in words ("Known, unfixed", "Not verified") — never by its marker.

- **2026-08-22** — ✅ **The invoice was addressed to the wrong person, and the address block printed no
  person at all.** "BILLED TO" prints the BILLING ADDRESS CONTACT (name, then company, then the
  street lines); the customer-level name appears nowhere on the document. We printed
  `customers.name` — a column our importer synthesises — and never read the
  `billing_first_name` / `billing_last_name` /
  `billing_company` columns on any surface, so a company paying through its accounts-payable contact
  got an invoice naming whichever individual signed up. `document.ts` now resolves `billTo.name` via
  the single `customers/names.ts` chain (`invoiceContactName`), and `customerAddressLines` /
  the new `snapshotAddressLines` emit the contact name and company ABOVE the street lines, which no
  builder did before — a merchant could fill in a billing contact and it would print nowhere. The
  name is suppressed as an address line when it equals the separately-rendered `billTo.name`, so the
  ordinary one-person customer does not stutter. ⚠️ When the invoice HAS a `billing_address`
  snapshot, the printed name comes from THAT snapshot's contact and the live customer row is not
  consulted at all. The first cut resolved the header from the live row while the block below it came
  from the snapshot, which put two different names on one document the instant a customer changed
  their billing contact after issue — new in the header, old as an address line, and the de-dup guard
  unable to fire because they differ. One source per document or none: `billToName` is that decision,
  it is what `credit-notes/document.ts` calls too, and `test/unit/invoice-billto.test.ts` pins it. A
  contact-less snapshot (street lines only, the shape `verify:invoicing-parity` writes) still falls
  through to the customer, so taking an address snapshot never blanks a name that was printing
  before. The three address builders are now exported and
  `credit-notes/document.ts` imports them instead of keeping its own copies, which had already
  drifted (the credit-note snapshot builder silently dropped `line3`). Both renderers are flow-laid
  (`pdf.y`, no fixed-height box; the HTML `.billto` div has no height), so the extra lines push the
  band down rather than clip. `serialize.ts`'s `customerBillingAddress` — the invoice's
  `billing_address` in EVERY API response — had the same inversion and now uses `billingContact`;
  its `phone` moved to `billing_phone ?? phone`, matching `customers/serialize.ts`, which already
  maps `billing_phone` to `address.phone` (the same key in the same shape must mean the same column).
  Gated by `verify:invoice-pdf`, `verify:invoices-v2`, `verify:invoicing-parity`, `verify:customers`
  and `test/unit/invoice-billto.test.ts`.

- **2026-08-19** — 🟢 **Auto-collect-off invoices can now have a DEADLINE (`dun_offline_invoices`).** Until
  now the due-date pass ended an offline invoice's story: `posted → not_paid`, `dunning_status` null,
  and nothing ever touched it again — so the final action a merchant configured under "At the end of
  the dunning period" could never fire for one, and there was no way to express "invoice them, let
  them pay in the portal, give up after N days". `runInvoiceDueTransitions` now opens a window
  instead (`dunning_status = in_progress`, deadline in `next_attempt_at`) and a second scan in the
  same pass applies the final action when it closes. **No charge is ever attempted** — that is what
  auto-collect-off means, and `verify:dunning-offline` asserts it on the invoice's payment-row count
  rather than on its status. The invoice stays `not_paid`, an OPEN status, so the portal's Pay-now
  works for the whole window; the expiry re-reads and re-validates everything (paid? auto-collection
  switched back on? flag revoked?) rather than trusting the state it saw at open time, and marks
  `exhausted` with a compare-and-set before acting so two overlapping ticks cannot both void.
  Deliberately in the DUE pass, not `runDunningPass` — that exists to retry charges, and routing an
  offline invoice through it would attempt the very charge this rules out. Reusing `next_attempt_at`
  is safe because every pass that acts on it (`runDunningPass`, `sweepStrandedRetries`, this pass's
  own first scan) also requires `status` `payment_due`/`posted`. Off by default; needs
  `dunning_period_days`, since offline invoices have no retries to end a window.
  `verify:dunning-offline` — 26 checks.

- **2026-08-17** — ✅ **The charge idempotency key no longer rides the DUNNING counter, so a second
  "Collect now" is a real charge.** The key is `inv_<id>_attempt_<N>_<pm>` and `N` was
  `attempt_count + 1` — the column M12 deliberately freezes for human attempts. Two presses on the same
  invoice and card therefore rebuilt the SAME key, the gateway replayed the first outcome (tmtest does
  this on purpose, to catch exactly this), and the engine booked a second `payments` row for a charge
  that never happened: three manual collects → **one** gateway charge, three failure rows. A buyer who
  had just topped up their account saw the original decline on every press until the clock's automatic
  retry moved the counter. `N` now comes from **`bookedAttemptsForInvoice`** (the invoice's `payments`
  rows — attempts actually booked, never deleted, so it only climbs). Format unchanged (it was then
  parsed by `providers/shadow`, since removed), and the automatic sequence is the same as before
  (1, 2, …). Two behaviours are intentional: offline payments inflate `N` (it must
  be unique per attempt, not match an operator-visible attempt number), and an attempt that reached the
  gateway but crashed before booking leaves `N` unmoved so the retry REPLAYS — one charge beats two when
  our own record of the outcome is missing. Concurrent clicks are still serialized by the collection
  claim, not by this key. Gate: `verify:invoice-ops` (three collects ⇒ three `payments` rows + three
  distinct `id_at_gateway`; confirmed failing with the old key).
- **2026-08-17** — **The `invoice.collect` audit row records the SCHEDULE, not just the status.**
  `attempt_count` stopped being the field that moves once a manual attempt began holding the counter
  still (M12), so a "Collect now" that declined left `status` / `attempt_count` / `amount_due_minor`
  all identical and the Activity Log drill-in showed an operator action with an empty diff. The row
  now also carries `dunning_status` and `next_attempt_at` on both sides — what a failed collection
  actually moves, and the same pair `invoice.stop_dunning` / `invoice.pause_dunning` already record,
  so all three read alike. Asserted by `verify:audit` (`diffed('invoice.collect')`, which demands a
  side that genuinely differs). ⚠️ Still a plain snapshot pair — no payment id is invented for it;
  the attempt's outcome is the `payment_failed` / `payment_succeeded` event.
- **2026-08-10** — **Collection learned whether a buyer is present.** `collectInvoice` and
  `chargeBeforeSubscriptionInvoice` take an optional `session: 'on_session' | 'off_session'` that
  defaults to **off-session** — the billing clock, the dunning pass, renewals,
  collect-on-payment-method-update and the operator "Collect now" all omit it, so `requires_action`
  stays a retriable dunning failure with code `requires_action`, unchanged. Only a caller that knows a
  buyer is at the other end passes `on_session`; then a `requires_action` mints a payment intent +
  attempt (`intentForOnSessionChallenge`) and hands back its `next_action` instead of failing:
  `collectInvoice` throws `PaymentActionRequiredError` (nothing recorded — no failed payment, no
  transaction, no dunning, invoice untouched) and `chargeBeforeSubscriptionInvoice` returns
  `{ kind: 'action_required' }`. The buyer completes the challenge and the intent is CONSUMED into the
  invoice (`POST …/invoices/:inv/collect { payment_intent }`, or a create-subscription retry carrying
  `payment_intent`), which is what finally makes the payment-intents module's long-standing claim —
  "the server consumes the authorized intent instead of a bare charge" — true. The on/off distinction
  is never inferred: it is structural (hosted checkout) or declared by the caller.
- **2026-08-10** — **`subtotal_minor` is a two-stage waterfall, not one gross figure** (`0169`).
  The field is pre-discount for a DOCUMENT-level discount and POST-discount for an ITEM-level one,
  decided by the coupon's `apply_on`. We stored a single gross subtotal with every discount as an
  aggregate contra line, so a 100%-off item-level coupon reported 9900 where the waterfall reports
  0: identical money, two conventions, and a real difference in a public API field for anyone
  migrating in.

      subtotal_minor = Σ line amount_minor − Σ(item_level shares)
      total_minor    = subtotal_minor − Σ(document_level shares) + tax (± rounding)

  What moved: `invoice_line_items.discount_minor` (BOTH stages) and `invoice_line_discounts`
  (one row per line × coupon × **scope**).
  Aggregate `kind='discount'` lines now carry the **document-level portion only**; a line for the full
  amount would subtract the item-level part twice, since it is already inside the subtotal. A coupon
  can straddle both stages, so that is a per-row amount (`DiscountRow.documentLevelMinor`) rather than
  a filter on the coupon.
  ⚠️ **Redemption is NOT gated on the discount line existing.** An item-level-only coupon now produces
  no aggregate line, and `consumeDiscount` still runs — otherwise a `repeating`/`once` item-level
  coupon would discount every renewal forever, with a correct-looking invoice each time.
  ⚠️ **Attribution ≠ stage.** Both stages are attributed per line: a document-level 2580 hangs on a
  `line_item_id` while `sub_total` still reports 12900. `scope` is what the
  subtotal depends on; collapsing the two makes the subtotal unreproducible from the rows beneath it.
  **No money moved** — `total`, `amount_due`, tax and every ledger posting derive from
  `discountedSubtotal`, which is unchanged. Asserted in `verify:coupons` (item-level and document-level
  15% both total 8500, subtotals 8500 vs 10000) and in `test/unit/discount.test.ts`. Existing rows
  migrated by `scripts/backfill-invoice-line-discounts.ts` (dry-run by default; 52/391 invoices on the
  imported book, 0 skipped) — it also repaired the imported invoice that held subtotal 10965 AND a
  −1935 line, netting 9030 against a total of 10965.

- **2026-08-09** — **A billing period ends when the term does.** `period_end` — on the invoice, on
  each line, and on each credit-note item — reported the stored EXCLUSIVE boundary while the
  subscription's own `current_period_end` reported the inclusive one. For an invoice covering
  26-Jul→25-Aug that meant `period_end: 26-Aug T00:00`, and the invoice list rendered **"26 Aug"** —
  a day the period does not bill for — beside a subscription saying the 25th. Two answers for one
  boundary in the same payload family. All three now go through `inclusivePeriodEnd`, which defers
  to `inclusiveBoundary` (see `subscriptions/README.md`), so they agree by construction.
  `serializeInvoice`/`serializeCreditNote` take the business row as `biz` to decide it; omitting it
  reports the raw exclusive instant, which is the pre-existing behaviour rather than a
  wrong-but-plausible conversion. `loadInvoiceSnapshot`/`loadCreditNoteSnapshot` load it themselves
  so a webhook payload states the same period the REST read does, and the credit-note LIST route
  passes it for the same reason the detail route does — the list loads items too, so without it one
  boundary had two answers one route apart. The ad-hoc charge endpoint's `unbilled_charge.period_end`
  echoes the same convention as the invoice line that charge becomes once billed.

  **The `period_end` list filter follows the reported value, not the column.** A filter has to
  narrow on what the caller can see: with the row storing 26-Aug 00:00 and the list showing
  "25 Aug", filtering the raw column for the 25th matched nothing — and the dashboard offers exactly
  that filter. `listFilters()` swaps in a comparable expression that mirrors the reporting rule term
  for term, local-midnight guard included. Sorting still uses the raw column: the shift is
  order-preserving, so it cannot change a sequence.

- **2026-08-09** — **`collectInvoice` collects once.** The clock's auto-collection and the shadow
  poller's bucket-2 replay reach it from separate job queues, and every guard inside it
  (`invoiceOutstanding`, the pending-attempt check) is a read-then-act — two arrivals in the same
  window each read _"nothing collected yet"_ and both charged. On INV-65615 that booked ONE gateway
  charge as TWO payments with two cash/AR postings: `Amount paid -$30.00` against a $15.00 total.
  Two defences, because they cover different failures:
  - **`invoices.collecting_at`** — a conditional-UPDATE claim taken before the first guard reads
    anything; losers get `CollectionInFlightError`. Same idiom `due.ts` and `dunning.ts` already
    used on `next_attempt_at`, moved down to the chokepoint that sees _every_ collector rather than
    just the pass that owns the lease. This is the load-bearing half: racers holding different stale
    attempt counts build different idempotency keys, the gateway does **not** deduplicate, and the
    customer is charged twice for real — which no index can undo.
  - **`payments_provider_charge_uq`** — one gateway charge books at most one payment, so a
    deduplicated replay cannot post a second cash/AR pair. Partial on three counts, each guarding a
    live path: no id at all (never reached a gateway), `''` (RazorPay/PayPal return an empty id on
    some failures), and `provider_key = 'offline'` (`recordPayment` stores the METHOD NAME here, so
    a business's cash payments all share the value `cash` by design).
  - Losing the claim is _not_ a failure: `dunning.ts` returns `still_failing`, `due.ts` skips the
    row, the shadow reports `in_flight`, and `collectInvoiceNow` refuses with an `InvoiceOpsError`
    rather than a 500. Reporting a failed charge instead would arm a retry against a live attempt.
  - `pnpm verify:concurrent-collect` — 5 concurrent collectors → 1 charge, 4 refused, cash debited
    exactly once. Asserts the ledger, not just the row count: the bug doubled the money while the
    payment count still looked plausible.
  - ⚠️ **Deploy the migration BEFORE the code.** `bookSuccess`'s `ON CONFLICT` names
    `payments_provider_charge_uq` explicitly, and Postgres raises _"no unique or exclusion
    constraint matching the ON CONFLICT specification"_ when it is absent — so this code against a
    database where `0162` has not run makes **every successful collection throw**, not just the
    racing ones. That is worse than the bug it fixes. It bites hardest where the migration ABORTS
    (existing duplicates) and someone restarts the workers anyway: run
    `pnpm repair:duplicate-payments --write`, re-run `db:migrate`, and only then deploy.
- **2026-08-10** — `importArchivalInvoice` now **arms an imported `payment_due` invoice** the source
  gave no `next_retry_at` for. A source that leaves that field unset between ladder steps imports an
  invoice with a position (`attempt_count`) and no schedule — and _no clock pass selects
  that shape_: `runInvoiceDueTransitions` scans `posted`, `runDunningPass` requires
  `next_attempt_at IS NOT NULL`, and `sweepStrandedRetries` requires `dunning_status = 'in_progress'`.
  The invoice was therefore never charged again: no attempt, no transaction, and Payment Due shown
  forever on an invoice the source was still collecting.
  Defaults to the DUE DATE, not `now`, so a cutover reproduces the source's timing instead of firing
  the whole imported book at import o'clock; `dunning_status` is defaulted to `in_progress` alongside,
  or the first crash between claim and outcome drops the row back into the same unreachable state.
  Skipped when the source's ladder is over (`stopped` / `exhausted` / `success`) — resuming a
  deliberately paused ladder charges a card nobody asked us to charge, which is worse than the bug.
  Pre-fix rows: `scripts/sql/backfill-orphaned-dunning-invoices.sql` (guarded on the absence of a
  pending payment, so genuine async parks are left alone).
- **2026-08-06** — `importArchivalInvoice` accepts the source's **dunning position**
  (`attemptCount` / `nextAttemptAt` / `status`) and stamps it onto `attempt_count`,
  `next_attempt_at` and `dunning_status` — but only for still-collectible invoices; a settled
  document has no ladder left to resume. Without this an imported open invoice starts at
  `attempt_count = 0`, so an invoice the source already failed three times gets a fresh four attempts
  and cancels roughly two weeks late.
- **2026-08-05** — Tax went from a single scalar to a COMPONENT VECTOR. `PeriodInvoiceFinalizePlan`
  carries a `taxResolution` (was `rateInfo: {rateBps, name, taxRateId}`); both invoice paths emit ONE
  TAX LINE ITEM PER COMPONENT, so an India GST invoice shows CGST and SGST/UTGST separately — a
  merged "GST (18.00%)" line is not a valid tax invoice. `recordLineTaxes` writes one
  `applied_taxes` row per component per line. Invoices now freeze the determination:
  `seller_state_code` · `place_of_supply_code` · `tax_treatment` · `tax_note`, all NULLABLE and null
  on historical rows — a default would assert a determination that never happened, and
  `seller_state_code` is what decided CGST+SGST vs IGST. Place of supply reads `customers.state_code`
  (a subdivision CODE), not the free-text `state` the scalar engine compared. Tax line amounts are
  summed from the exclusive `applied_taxes` rows, so the lines and the per-line breakdown agree by
  construction. Migration `0146`; see `src/modules/tax/README.md` for the determination order.
- **2026-08-04** — ✅ **An invoice could be collected TWICE, and the surplus vanished.**
  `recordOfflinePayment` and `collectInvoice` both read the stored `amount_due_minor` as "what's
  outstanding". That column is net of CREDIT applications only — it is deliberately never decremented
  by cash (`serializeInvoice` subtracts `paidMinor` from it for display), so **part-payments left it at
  the full total**. Three offline part-payments that added up to INV-2309's ₹67,484.20 therefore left
  the invoice OPEN, and the next blank-amount "mark as paid" read the full total as due and took it
  again — ₹134,968.40 collected on a ₹67,484.20 invoice, booked entirely to `accounts_receivable`, so
  the payer's surplus appeared nowhere on the customer.
  - **One helper now owns the question**: `invoiceOutstanding(tx, inv)` = stored collectible − Σ
    succeeded payments, floored at 0. `recordOfflinePayment`, `collectInvoice` and
    `customers/collect.ts` all go through it. The stored column still moves only on credit
    application — decrementing it on cash would double-count every payment at serialization.
  - **Money above the balance becomes customer credit, not an over-application.**
    `recordOfflinePayment` splits `applied = min(amount, outstanding)` / `excess = amount − applied`:
    the invoice-scoped payment row and the cash/AR posting carry `applied`, while `excess` posts
    cash → `excess_payment_balance` (customer-dimensioned, same as `recordExcessPayment`) and emits
    `customer_excess_payment_recorded`. The route returns `excess_credited_minor`; the `transactions`
    money-log row keeps the FULL cash received, because that is what arrived.
  - A settled invoice now refuses further offline payments outright, and `collectInvoice` settles
    (rather than re-charges) an invoice whose cash already covers it.
  - Existing bad rows: `pnpm repair:overpaid` (dry run) / `--write` — re-allocates payments oldest-first,
    detaches or splits the surplus, and posts one compensating AR → `excess_payment_balance` entry per
    invoice. `cash` is untouched: that money really did arrive. Regression checks live in
    `scripts/verify-invoice-ops.ts` (§5b/§5c).
- **2026-08-03** — ✅ **A `one_time` price attached as a subscription item is billed ONCE, not by
  every renewal.** `planSubscriptionPeriodInvoice` rates every non-metered item from its snapshot
  each period, and the only brake was the item-level `billing_cycles` cap — which neither
  `addSubscriptionItem` nor `createSubscription` ever sets. So a ₹5,000 onboarding fee attached as
  an item was re-billed at full price on **every renewal, forever**; the fix earlier the same day
  (charge the FULL amount instead of a prorated slice) made the first charge correct and left the
  recurrence untouched. A `one_time` price now carries an **implicit cap of one cycle**:
  `cycleCap = item.billingCycles ?? (snap.type === 'one_time' ? 1 : null)`, read off the same frozen
  `price_snapshot` the amount is rated from. Three consequences that drove the shape:
  - **Derived, not written.** Setting `billing_cycles = 1` at attach time would only fix items
    attached from now on; deriving the cap from the price type also stops every item **already**
    attached, with no data migration, and leaves one source of truth instead of a column that can
    disagree with the price it snapshots. An EXPLICIT `billing_cycles` still wins.
  - **It cannot skip a fee that was never charged**, because it gates on `cycles_billed`, which is
    incremented only by an invoice that actually billed the item. Both paths where the period
    invoice IS the first bill keep working and are now asserted: attached at create (first invoice
    bills 5000 + 3000 = 8000) and attached during a trial (`addSubscriptionItem` defers, the
    trial-end conversion invoice bills the full 3000 — exactly what that deferral promises).
  - **A charge raised outside the planner has to report the cycle it consumed**, or the next
    renewal sees an unbilled one-time item and bills it again. New
    `createInvoiceFromLines({ markItemsBilled })` increments `cycles_billed` for those items
    **inside the invoice transaction** — the fee and the record that it was charged commit together.
    Only `addSubscriptionItem`'s one-time branch passes it; a prorated RECURRING add passes nothing
    (its slice is part of a cycle the renewal still bills, and consuming a cycle would eat one from
    a legitimate `billing_cycles` cap).
    The item **stays attached** and visible on the subscription — it is part of the composition, it
    just stops being re-rated. Nothing detaches it, and no ledger row was touched.
    Gate: `verify:renewal` grew Case 3 + Case 4 (Time-Travel-driven, real renewal pipeline).
    **Confirmed RED first, twice.** With the cap disabled: `renewal charge lines=[recurring:5000 |
one_time:3000]` and the same again on renewal #2 — recurring forever. With the cap but WITHOUT
    `markItemsBilled`: renewal #1 still `[recurring:5000 | one_time:3000]`, renewal #2 clean — proving
    both halves are load-bearing. Green: `[recurring:5000]` on both renewals, item still attached, and
    the attach charge still the full 3000 (not the ~2419 a proration would be).
- **2026-08-03** — 🟢 **Follow-up on the entry above: this file's inline `cycleCap` expression now
  calls the shared helper.** `subscriptions/proration.ts`'s term-reset branch and `subscriptions/
estimate.ts`'s in-trial and term-reset preview branches gained the SAME cap check the same day
  (a one-time fee must not be re-charged, credited, or previewed as either) and put it in one place:
  `itemCycleCap`/`isCycleCapExhausted` in `catalog/pricing.ts` (where `PriceSnapshot` already lives).
  This module's own `const cycleCap = item.billingCycles ?? (snap.type === 'one_time' ? 1 : null)`
  was the ORIGINAL of the rule and, once the other two call sites existed, its only remaining
  duplicate — swapped to `isCycleCapExhausted(item.billingCycles, snap.type, item.cyclesBilled)`,
  same behaviour, one fewer place the rule can drift. `verify:renewal` (Case 3 + 4, unchanged)
  confirms it still stops the one-time fee from re-billing.
- **2026-08-02** — `importArchivalInvoice` stamps its **line items** with the invoice's own issue
  date, not the import clock. The document already carried `createdAt: input.date`; its lines did
  not, so every historical line read as created today.
- **2026-08-01** — **P4: the money ops are audited.** `invoice.void` + `invoice.update` were the only
  audit rows this module wrote, so the Activity Log drill-in had nothing to open. Added
  `invoice.close`, `invoice.collect`, `invoice.write_off` (written on the credit-note path it routes
  through, so both rows land in one tx), `invoice.record_payment` and `invoice.regenerate`, each with a
  changed-field before/after diff. `billSubscriptionPeriod` gained an optional `auditWrite(invoice)`
  callback so close/regenerate can write **inside the finalize transaction** — a callback because the
  `after` side is only knowable there (the finalized status; for a regenerate, the new invoice's id).
  It is absent for the clock's renewal and a signup's first invoice: those have no actor to record.
  `invoice.collect` is the one row written after the fact, not in-tx — `collectInvoice` is shared with
  the dunning pass, and auditing inside it would stamp every machine retry as an operator action.
  `invoice.regenerate` hangs off the **voided** invoice (where the operator pressed the button), diffed
  as `regenerated_into: null → inv_…`.
- **2026-07-31** — **Per-line service period + catalog-priced manual lines.**
  `InvoiceLineInput` gained `periodStart`/`periodEnd`; `insertLines` prefers the per-line value and
  falls back to the invoice-level args, so subscription-period and proration callers are unchanged.
  One invoice can now carry several charges each covering a different span — which is what a
  repeated ad-hoc charge produces, and what revenue recognition needs.
  `POST /v1/businesses/:biz/invoices` lines now accept `price` (a catalog Charge price, rated via
  `computeLineAmount` when no `amount_minor` is given — so tiered/volume/stairstep work, not just
  flat), `period_start` and `period_end`.
  Guards: `period_end` before `period_start`, and a price whose currency isn't the invoice's.
  **Fixed a silent loss:** folding an unbilled charge into a renewal hardcoded `priceId: null` and
  overwrote the charge's period with the renewal's, so a catalog-picked charge lost its origin and a
  charge covering another span was misreported. Both now carry through.
- **2026-07-30** — **Paginated invoices list.** `listInvoicesPage` behind
  `GET /v1/businesses/:biz/invoices` — keyset on `(created_at DESC, public_id DESC)` (index
  `invoices_business_created_idx`, migration 0131), plus `q`, `sort_by` over
  `created_at|total_minor|status|period_end`, and `<field>[<op>]` filters (status, currency,
  imported, amounts, dunning attempts, dates, customer/subscription). **`paidTotals` now runs for
  the page only** — it previously aggregated succeeded payments across every invoice in the
  business, on the fastest-growing table in the product. `listInvoices` remains the internal
  unpaginated read. Verify: `verify:list-pagination`.
- **2026-07-27** — **Charge-before-invoice for the auto-collect-ON signup.** New
  `collection.ts` holds the payment-method / gateway-account selection and the single charge
  attempt that `collectInvoice` used to inline (`resolveChargeCandidates`, `resolveChargeAdapter`,
  `chargeWithMethod`, `isHardDecline`, `loadChargeContact`) — `collectInvoice` now calls them, so
  there is exactly one copy of that logic. Built on it: `chargeBeforeSubscriptionInvoice` charges a
  brand-new subscription's first period BEFORE anything is persisted-and-visible (writes nothing
  except a failed payment + failure transaction + `payment_failed` on a decline), and
  `refundPreInvoiceCharge` puts the money back when the invoice can't be committed.
  `commitSubscriptionPeriodInvoice` gained two opts: `preEvents` (deferred events emitted at the
  top of the invoice tx, so state + every event commit atomically and in the un-deferred order)
  and `charge` (an already-completed charge — books the payment, cash/AR ledger, transaction and
  `paid` status inside the invoice tx and never charges again). Guarded by
  `ChargeAmountMismatchError`: the locked re-resolve of `amountDue` must equal what was charged, or
  the whole transaction rolls back untouched and the caller refunds. Renewals, dunning,
  auto-collect-OFF and the reactivate path are unchanged.
- **2026-07-27** — **`billSubscriptionPeriod` split into a read-only `plan` half and a write-only
  `commit` half** (pure structural refactor, zero behaviour change). New exports:
  `planSubscriptionPeriodInvoice(input) → PeriodInvoicePlan` (lines, coupon stack, tax, credit
  application, totals, due date, resulting status — **no writes, no events**),
  `commitSubscriptionPeriodInvoice(plan, opts) → { invoice, payment }` (every insert/update, the
  ledger postings, all events, optional collection), plus the `PeriodInvoicePlan` /
  `PeriodInvoiceMoney` types and the pure `resolvePeriodInvoiceMoney(plan, balances)`.
  `billSubscriptionPeriod` is now `commit(await plan(input))` with an unchanged signature; no caller
  changed. One thing does not separate cleanly: the credit buckets **must** be read inside the write
  txn under `lockCustomerBalances` (over-draw guard), so `commit` re-runs the _pure_
  `resolvePeriodInvoiceMoney` against the locked buckets. With no concurrent draw it returns exactly
  `plan.money`; under a race it is the existing guard, unchanged.
- **2026-07-27** — **An unpaid invoice with no due date is now born `payment_due`, not `posted`.**
  `posted` means "finalized but **not yet due**" — Net-D — and `due.ts` only ever scans invoices that
  _have_ a due date, so an invoice without one sat at `posted` permanently with no code path able to
  advance it. Such an invoice is `payment_due` from the moment it is raised (the
  auto-collection-off branch). Two sites: `billSubscriptionPeriod`
  and `createInvoiceFromLines`; Net-D invoices are unchanged. No behavioural fallout — the only code
  branching on `posted` is `due.ts` (which never saw these) and `credit-notes/service.ts` (already made
  the same distinction); five `verify-invoices-v2` assertions were stale labels and now expect
  `payment_due`. Semantics written down in `status.ts`.
- **2026-07-27** — **`payment_failed` now carries `status`, `amount_minor` and `currency`** at all three
  emission sites (synchronous charge, dunning retry, async late failure). It carried none of them while
  its own `payment_succeeded` sibling carried all three — so a consumer could not tell how much had
  failed without a second API call, and a migrating integration lost the amount outright.
- **2026-07-27** — `createInvoiceFromLines` gained an opt-in **`applyCoupons`**: the shared
  line-invoice engine had no coupon step at all, so every proration invoice charged **list** price
  where a plan change must be billed with the same coupons that discounted the original term
  (a 64900 upgrade on a 10%-forever sub is 58410). Discount comes off the subtotal before tax,
  one line per coupon, booked as a `discounts` contra-revenue debit — the same shape
  `billSubscriptionPeriod` books, which is what lets `issueCurrentTermCredit` read it back later.
  Consumes the redemption when the coupon actually discounts (a `once` coupon applied mid-term is
  still `active`, so skipping this would discount the change invoice AND the next renewal).
  **Off by default** — ad-hoc charges, add-on adds and manual invoices stay list-priced and
  byte-identical; only the plan-change path opts in. **Silently skipped when any line is negative**:
  the non-reset proration path nets credit lines against charge lines in one invoice, and
  `computeStackedDiscounts` floors lines at 0, so the coupon would come off the GROSS charge against a
  NET subtotal — a 550 discount on a 500 subtotal, i.e. an unbalanced ledger entry thrown after the
  item updates already committed. Netting a coupon across credit lines needs a decided model first.
- **2026-07-27** — `collectInvoice` now passes the customer's **email + phone** into `adapter.charge`
  (`ChargeInput.email/phone`) and the payment method's **own** `display.type` instead of a hardcoded
  `'card'`. Both were RazorPay-fatal: its off-session endpoint refuses a charge with no contact
  ("The contact field is required."), and a hardcoded `'card'` mislabels a UPI Autopay mandate to any
  adapter that branches on the method type. The existing customer lookup (previously auto-collection
  only) was widened to fetch all three fields in the same query. See `src/modules/gateway/README.md`.
- **2026-07-21** — Feature-rich invoice export (Tier-1). New `document.ts`
  (`assembleInvoiceDocument`) builds ONE presentation model (seller / bill-to /
  meta / charge·discount·tax·rounding line groups + fully-derived totals, money
  kept as minor-unit bigint) that feeds BOTH a real pdfkit PDF (`invoice-pdf.ts`,
  `renderInvoicePdf` — A4, header/bill-to/meta/paginated line table with repeating
  header/summary box/footer, Helvetica-only) and the rewritten `renderInvoiceHtml`
  (rich print-friendly HTML mirroring the PDF). Tax/discount/rounding are grouped
  from stored `invoice_line_items.kind`; amount-paid = succeeded-payment sum.
  `GET .../invoices/:inv/pdf` now returns `application/pdf` (attachment);
  `GET .../invoices/:inv/html` added for the HTML view. Verify: `verify:invoice-pdf`.
  **Review fix (same day):** `amountDueMinor` now mirrors the serializer's canonical
  semantics — remaining balance = `max(0, issue-time-due − amount-paid)`, and `0` for
  voided/written-off — so a paid invoice no longer prints the full amount as due; and the
  Withholding (TDS) row moved below **Total** (Total is the gross face amount; withholding
  is a deduction toward the amount due). `verify:invoice-pdf` now asserts paid+due reconciles.
- **2026-07-15** — Invoice base-line descriptions use the human name (`price.externalName ?? price.name
?? slug`) instead of the synthetic `${model} (${slug}) ×${qty}`, so the label is the item price's
  `external_name`. Quantity remains in the structured line field.
- **2026-07-14** — Invoice money fields: serializer now emits
  `credits_applied_minor` (sum of the three applied-credit buckets) and `amount_paid_minor`
  (succeeded-payment sum, threaded from `listInvoices`/`getInvoiceWithLines` via `paidMinor`;
  status-derived fallback elsewhere), and `amount_due_minor` changed meaning from issue-time due
  to REMAINING due (0 when paid/written-off/voided). Breaking API change (allowed:
  nothing in prod).
- **2026-07-13** — Added `collectOutstandingForNewPaymentMethod` (Billing LogIQ collect-on-PM-update):
  collects a customer's open `payment_due` invoices (oldest-first, auto-collect-ON only) against a
  newly added card, reusing `collectInvoice`'s override path. Called from the add-card route.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).

- **2026-08-01** — New invoice fields: `voided_at` (stamped inside the atomic void claim), `po_number`,
  `expected_payment_date` (a collections FORECAST — nothing in the engine reads it, so it can never
  move a dunning date), `channel`, and per-invoice `billing_address`/`shipping_address` SNAPSHOTS.
  New `updateInvoiceFields` + `PATCH /v1/businesses/:biz/invoices/:inv` (undefined=leave, null=clear;
  audited as `invoice.update`). Serializer now emits all of the above plus `written_off`,
  `dunning_status`, `customer_name`/`customer_email`, and resolves the address as
  snapshot-else-customer with `*_is_snapshot` so callers know which they got. The PDF/HTML document
  prefers the snapshot address and the real `po_number` column over the old `metadata.po_number`.
  ✅ **Fixed:** `recordOfflinePayment` wrote `payments` + the ledger but no `transactions` row, so the
  money log silently omitted every offline payment (the offline _refund_ path always recorded one).
- **2026-08-01** — **Retries** (`retries.ts` + `GET /v1/businesses/:biz/retries`) — the "invoices
  under retry" view. A dedicated read, not a filter on the invoices list: every column that makes
  it useful (last error, refusing gateway, failed card, retriability) lives on the invoice's latest
  FAILED transaction, so the dashboard would otherwise N+1 across the page. That lookup is batched per
  page like `paidTotals`, served by `transactions_invoice_failure_idx`.
  The predicate is **unsettled AND (attempted OR retry armed), OR dunning has touched it** — NOT
  `dunning_status IS NOT NULL` (written by the dunning pass, so it showed 0 rows while 22 invoices sat
  unpaid) and NOT every `payment_due` row (pulled in invoices never charged at all). Ordered by
  `next_attempt_at` ASC NULLS LAST: "what is retried next", with the nothing-scheduled rows — the ones
  needing a human — at the end rather than hidden.
- **2026-08-06** — ✅ **Fixed:** `resolveChargeAdapter`'s legacy env-registry fallback had no mode
  check, so a **live** business with no `gateway_accounts` row charged through `src/providers/registry`
  — which is built from `STRIPE_TEST_SECRET_KEY` / `PAYPAL_TEST_BUSINESS_US_*` / `RAZORPAY_TEST_KEY_ID`
  and nothing else. A real customer's card would have been charged against a sandbox and reported as
  succeeded: the one direction the test/live partition exists to prevent. All three existing mode
  guards (the router, the vaulting-account branch, payment intents) sit on the gateway-account path and
  never saw this branch. Now `gateway_not_found` for a live business; test businesses keep the
  fallback. The business livemode is read in the same round trip that checks for accounts, so the
  guard costs no extra query. New gate: **`pnpm verify:testlive`** (`scripts/verify-testlive.ts`, in
  `verify:all`) pins the whole partition — key scoping (cross-mode reads 404, never 403, so key mode
  cannot enumerate the other partition), create/mint restrictions, `livemode` immutability, gateway
  accounts inheriting their business's mode, tmtest refused on live, this fallback refusal, a
  corrupted mode-mismatched account still refusing to charge, and sample-data/Time-Travel being
  test-only.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-22** — **`customer_name` is resolved, not read out of one column — on the list, the retries
  screen and the filter.** Every surface here built that string from `customers.name`, our own legacy
  display column that the API never populates (the importer synthesises it; nothing else writes it). So
  a customer created through the API with `first_name`/`last_name` was BLANK in the Customer column of
  the invoices and Retries lists, and — worse — invisible to `customer_name[contains]`, which compared
  the same empty column. An operator typing the name they could see on screen got "no invoices".
  `listInvoicesPage` and `listRetriesPage` now select the whole name chain and resolve it through
  `accountHolderName`; `serializeInvoice`'s detail branch resolves the joined customer row the same way
  (`customer_name` is the operator-facing identity — the PRINTED contact is still `invoiceContactName`,
  and the two disagree on purpose); the `customer_name` filter compares `accountHolderNameSql`, the SQL
  mirror of that chain, so the filter matches what the list displays. Free-text `q` reaches
  first/last/company too. No migration and no index change: `customers.name` never had an index, and a
  leading-wildcard ILIKE could not have used one — the predicate is extra CPU on rows the join already
  visits, not a new scan.

- **2026-08-29** — **`runInvoiceDueTransitions` and `runAutoClosePending` report their per-item
  failures.** Both isolated a failing invoice and then only logged it, so an invoice silently
  failing its due-date transition every minute was invisible until a customer asked why they
  were never charged. Both now return `TickError[]` (with the new `invoice` subject) which
  `jobs.ts` merges into `clock_ticks.errors`, and both report a `failed` counter beside the
  work they did. `verify:logging` locks the pair together: a pass that COUNTS its failures
  must also record them, or the tick row contradicts its own counter.

- **2026-08-30** — **A mandate the bank has not confirmed yet is refused before the gateway, and the
  refusal does not spend a dunning attempt (F-11).** `payment_methods.mandate_status` was written by
  the vault and by `applyMandateUpdate`, and then read for DISPLAY only — it appeared nowhere in
  collection, so `mandateRefusal` gated on the CEILING alone. `applyMandateUpdate` handles the two
  ENDS of the mandate lifecycle correctly (a dead status flips the instrument to `invalid`; a resume
  restores it) and deliberately leaves the middle alone, which is where the money is: a netbanking
  e-mandate is `initiated` from the moment the buyer finishes at their bank until the bank confirms —
  HDFC and SBI take until T+1 — and for that whole window the instrument is not chargeable while the
  row looks perfectly healthy. An invoice falling due inside it was charged against an unconfirmed
  mandate, refused at the gateway, and burned one of the customer's scheduled retries.
  `mandatePendingRefusal` (`collection.ts`) now refuses locally, after adapter resolution so the
  attempt is still attributed to the gateway account that would have taken it, and AFTER the ceiling
  check — both can be true of one instrument and the ceiling is the more useful answer, since its
  remedy is also the pending one's. It is `retriable: true`, the opposite of a ceiling breach and for
  the opposite reason: this refusal clears ITSELF when the bank confirms.
  * **The expensive half is the dunning attempt, and the count hold alone does not fix it.**
    `recordFailedPayment` advances `attempt_count` on every non-manual failure and that counter is
    the INDEX into the retry offsets, so a refusal booked the ordinary way costs a retry. Holding it
    still the way a manual attempt does is not enough here: the offsets are absolute from the DUE
    DATE and `nextRetryAt` clamps a past candidate to `now`, so re-planning with an unchanged count
    schedules the next attempt for immediately — a hot loop mailing the payer once per tick.
    `mandatePendingBackoff` supplies the explicit wait that goes with the hold (12h, applied ONLY on
    the `retry` branch of `planFailureRearm`, so a merchant's stop, a pause window, an offline
    invoice, a parked or an exhausted schedule all keep their disposition), and CAPS it at 3 —
    otherwise a mandate the buyer abandoned at their bank stays `initiated` for ever, the invoice
    never dunns, never exhausts, the final action never fires and the subscription stays active and
    unpaid, which is exactly the "parking is dunning switched OFF" failure `PARKED_WITH_DEADLINE`
    was written to end. Past the cap it books as an ordinary retriable failure and the schedule takes
    over. The deferral count is derived from the `payments` rows carrying the code, not stored — same
    discipline as `bookedAttemptsForInvoice` — and the count query runs only for that code, so no
    ordinary decline pays for a round trip it cannot use.
  * Gated on `capabilities.mandates`: `false` (PayPal — a `usage_type: MERCHANT` billing agreement
    has no mandate status to read back) can never refuse, `undefined` is read as unknown and NOT as
    false. An UNKNOWN status refuses nothing either — `spent` is real today and belongs to none of
    the three canonical sets. Gate: `test/unit/mandate.test.ts`, whose two halves are mutation-paired
    — blinding the guard reds 5 assertions, an always-refusing guard reds 4 disjoint ones, blinding
    the deferral reds the backoff, and removing its cap reds the give-up case.

- **2026-08-30 — F-43: `mandateSpentRefusal`, the third mandate pre-flight.** A debit against a
  single-use mandate that has already carried its one debit is refused before the gateway sees it,
  with `mandate_spent`. Ordered after `mandateRefusal` (ceiling) and beside `mandatePendingRefusal`;
  the two liveness answers are mutually exclusive, so the order is documentation, not precedence.
  * `retriable: false` — unlike `mandate_pending` it does not fix itself, and unlike
    `mandate_ceiling_exceeded` not even a smaller debit succeeds.
  * Exempt from `isHardDecline` (now a set, `NOT_THE_INSTRUMENTS_FAULT`, holding it alongside
    `mandate_ceiling_exceeded`): our own pre-flight refused it, no issuer said a word about the
    card, and `invalid` is where a bank's verdict belongs. NOT exempt from `shouldTryBackup` — the
    backup may carry a live mandate.
  * `decline-policy.ts` classifies it `park` and carries it in `PARK_EVEN_IN_FIXED_MODE`; without
    that a fixed-mode business exhausts dunning on the FIRST attempt (the measured ₹66,025 failure
    in `planFailureRearm`). Deliberately NOT in `PARKED_WITH_DEADLINE`, for the same reason
    `mandate_ceiling_exceeded` is not — a cancellation deadline is a product decision nobody has made.
  * Gates: `test/unit/mandate.test.ts` (mutation-paired — blinding the classification reds 8,
    an always-refusing guard reds the live/pending/dead case) and `scripts/verify-gateway.ts`,
    which proves no tmtest charge is made at all.

- **2026-08-31** — **A soft decline from a card we had already written off blocked the
  backup.** `shouldTryBackup` was `status === 'failed' && retriable === false`. That half
  is right: `retriable: true` means "this same card will work later", and dunning is
  built on that promise — it re-tries the same instrument on a schedule rather than
  burning a second one on a temporary problem. But the promise is INCOHERENT when the
  card's own row says `invalid`: we have already concluded it cannot be charged, so
  "later" is a statement we do not believe. Dunning spent every scheduled retry on it
  while a designated backup sat unused, and the invoice aged out. It now takes the
  instrument as a second argument and treats a retriable refusal from an `invalid` card
  as grounds to fall through.
  ⚠️ This does NOT make `invalid` mean "not collectable" — nothing filters on it, and a
  DESIGNATED primary is still offered first whatever its status. That is deliberate and
  is the one place `invalid` is knowingly ignored: it is our BELIEF and it goes stale (a
  reissued card behind the same token, a mis-classified transient decline), and nothing
  revalidates an instrument except one narrow un-pause path — so charging it is the only
  route back for a card written off by mistake. The two halves are complementary: the
  designated primary keeps its second chance, and `shouldTryBackup` stops that costing
  the fallback.
  **Also:** `pickPrimaryCandidate` extracted (pure, over newest-first rows) and fixed.
  With nobody designated it used to take `rows[0]` — the newest, regardless of status
  AND regardless of the backup. A dead card beat a live one for no reason anyone chose,
  and the newest card can BE the designated backup, which promotes it out of its own slot
  and leaves the customer one candidate where they had arranged two. Extracted so the
  rule that decides where a customer's money comes from is testable without a database
  fixture; it was previously exercised only incidentally, by fixtures with a single card.
  14 unit tests, mutation-tested in BOTH directions — blinding the fix reddens only its
  own case, making it always-fire reddens the two "never reaches the backup" cases, and
  reverting the ordering reddens exactly the four cases describing new behaviour while
  the three that were already true stay green.

- **2026-09-01 · Credits Flexibility threaded through both invoice builders (0219).** Refundable
  credits and excess payments now honour per-business ceilings. `PeriodInvoiceFinalizePlan` carries a
  `creditLimits` field resolved ONCE at plan time (from `businesses.credits_flexibility` + the
  subscription's own maxima) so `commitSubscriptionPeriodInvoice`'s second, under-the-lock call to
  `resolvePeriodInvoiceMoney` cannot use different ceilings from the ones quoted — resolving twice is
  how a plan/commit divergence gets manufactured. `createInvoiceFromLines` resolves its own via
  `loadCreditApplicationLimits`, outside the invoice transaction (it is a settings read, and it does
  not depend on the amount), and only when `applyCredit` is set.
  · **`subscriptionId` decides the invoice class.** Recurring and one-time invoices are configured
  separately; an invoice raised for a subscription — proration, mid-term item add, renewal —
  is part of that subscription's recurring billing, so it reads the `recurring` slots. One with no
  subscription behind it reads `one_time`.
  · Defaults are unlimited, so every existing path is byte-identical; see
  `modules/customers/credits-flexibility.ts` for the argument and `verify:credits-flexibility` for
  the proof (with `verify:invoices-v2` / `verify:proration` re-run unchanged).
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-28** — **Any decline now reaches the backup, not only a hard one.** `shouldTryBackup`
  is `status === 'failed'`: a primary that refuses for insufficient funds (or any soft reason)
  falls through to the customer's backup in the same run — renewal, dunning retry and Collect
  now alike (an explicit payment-method override still charges only that method). Only
  `isHardDecline` marks the primary `invalid`, so a soft decline leaves it first in line for
  the next charge. When the primary declines softly and the backup then hard-declines, the
  primary's retriable failure is booked as the governing one so dunning retries instead of
  parking; the backup's attempt is kept as a superseded decline. Pending, 3DS and
  indeterminate outcomes never fall through. Proof: `verify:gateway` C6 soft-decline cases.
  **Multiple backups:** `resolveChargeCandidates` now returns `{ primary, backups[] }`
  (`chargeOrder` flattens it). `orderBackups` takes every `role = 'backup'` card that is
  `valid`/`expiring`, valid first, newest first, never the same fingerprint twice, and caps
  the run at `MAX_INSTRUMENTS_PER_RUN` (3) — a burst of declines across one customer's cards
  reads as card testing to gateway fraud screens. A `none` card is never charged, not even as
  the first candidate. Only the first soft decline is held back to govern dunning.
  `runChargingChosenCardOnly` (AsyncLocalStorage) drops the backups for an on-session flow
  where the buyer picked the card — hosted checkout uses it.
- **2026-09-28** — Declines from a multi-card run are booked in CHARGE order. The governing decline used to be booked after every superseded one, so a run that tried primary → amex → visa read in the payment history as amex, visa, then the primary (seen on production after #175). Those before the governing decline are booked first, then it, then the rest; which decline governs is unchanged. Proof: `verify:gateway` "attempts are booked in the order the cards were charged".
- **2026-09-30** — `createInvoiceFromLines` takes optional `markUnbilledChargesBilled`: those unbilled charges flip `pending` → `billed` inside the invoice transaction, and if any is no longer pending the invoice rolls back with `UnbilledChargesChangedError`. Absent, nothing changes. New read-only `previewInvoiceFromLines` mirrors its money steps (per-line tax, promo pre-tax with the clamp, withholding, refundable/excess post-tax; no coupons) for the unbilled-charges `invoice_now_estimate`; `verify:usage-api` asserts the preview equals the invoice raised.
- **2026-09-30** — API parity, optional params (absent = unchanged): `POST /invoices/:inv/pay` takes `date` (backdates the payment row, its transaction, its ledger postings via `postEntries.occurredAt`, and `paid_at`; future or pre-invoice dates are 400), `reference` (stored as the transaction's `id_at_gateway`, as offline credit-note refunds store theirs) and `comment`. `collect`/`retry` take `payment_method` (that method only, via `paymentMethodOverrideId`) and `comment`. `void` takes `void_reason_code` (new `invoices.void_reason_code`, 0308) and `comment`; `write_off`, `stop_dunning`, `pause_dunning`, `close` take `comment` (kept as an invoice comment). New `resume_dunning`. `apply_credits` takes `credit_notes[]` (draw only those refundable notes, in order). Retrieve takes `line_items_limit`/`line_items_offset`; PDF takes `disposition_type`. Manual create takes `po_number` and `payment_method` (with `collect`). Suite: `verify:invoice-api-params`.
- **2026-10-03** — `payment_failed.message` follows the business's Tell-the-customer override on every emitter (`payerDeclineMessage`), including `recordFailedPayment`, which had no filter; the override gate keys on `code`, not only `ruleId`, so code-level overrides reach normalised declines (message AND `retriable`). Round-off unit = `minorScale(currency)` (JPY no-op, KWD 1000); `unit` is now required. Proof: `verify:decline-overrides` §9b, `verify:invoices-v2` E6.
- **2026-10-05** — A `mandate_expired` decline whose stored mandate end date has NOT passed (the gateway killed the mandate) marks the method `invalid` via `isDeadMandateDecline`, matching a dead-mandate webhook. The event carries `invalid_reason: "mandate"`, so the customer gets the renew-authorization email, not "add a new card". Our own end-date pre-flight is unchanged (the sweep demotes it to `expired`). PayPal `AGREEMENT_ALREADY_CANCELLED` now maps to `payment_method_not_found` (the agreement is the instrument) and its failure message is the rule's sentence instead of the raw JSON.
- **2026-10-16** — Invoice `number` sort orders by the numeric suffix (`documentNumberSortKey`), so INV-10 follows INV-9. `/retries` takes `sort_by[asc|desc]` over `RETRY_SORTS` (invoice, customer, amount_due, retry_status, next_attempt_at, attempts, retry_started_at); default stays `next_attempt_at` asc on the keyset path, any other sort pages by offset. Proof: `verify:list-pagination`.
- **2026-10-21** — Renewal invoices take their number after lines, taxes and ledger. The period claim runs INSIDE the invoice transaction (`commit…({ claim })`), so a crash can no longer leave a period advanced with no invoice. Behind `RENEWAL_BATCH_NUMBERING` (default off): invoices commit unnumbered (`awaiting_number`, 0349), `number_invoices` numbers up to `INVOICE_NUMBER_BATCH` per counter update (`batch-number.ts`, `number-queue.ts`) and sets `collect_due_at` for the collect pump. `chargeWithMethod` paces per gateway account when `GATEWAY_CHARGES_PER_S` > 0 (default 0 = off).
- **2026-10-23** — When an attempt finds that dunning does not apply (the `offline` plan), the invoice moves to `not_paid` AND drops a live `dunning_status` (`in_progress`/`parked`, `isLiveDunning` in `status.ts`) to NULL. It kept `in_progress`, so the invoice showed "In progress" beside "Dunning ended" and counted as live dunning in lists, reports and the Retries badge. Migration 0359 clears existing rows (176 local).
- **2026-10-24** — The invoice PDF fetches `logo_url` / `icon_url` / the signature image through `guardedFetch` (`platform/egress.ts`): no private or reserved addresses, no redirects. A refused image falls back exactly like an unreachable one. Opt-out `WEBHOOK_ALLOW_PRIVATE_TARGETS`.
- **2026-10-24** — **One live invoice opens each period (0370).** `invoices.opens_period` marks the billing clock's invoice for a period boundary (renewal, skipped renewal, first period, first-period heal); `invoices_opens_period_uq` allows one non-voided such invoice per (subscription, period_start). `commitSubscriptionPeriodInvoice(plan, { opensPeriod })` / `billSubscriptionPeriod(input, opts)` set it; a conflict rolls back and throws `PeriodAlreadyBilledError`. Request paths (signup, reactivate, resume, regenerate) and the term-end arrears invoice stay unmarked: they may share a period_start. Cover: `verify:period-uniqueness`.
- **2026-10-25** — **Usage lines are rated through `rateMeteredItem` (metering) and carry `rating` (0380).** The planner's metered branch measures with the recurring level and weighted_sum rules and stores how the line was rated (model, aggregation, quantities, tier rows, level); `GET /invoices/:id` returns it as `lines[].rating`, and the PDF prints the tier rows and level under the line. Zero usage still writes no usage line under any model (the minimum true-up stays). A measured quantity above the `integer` line column throws `UsageQuantityTooLargeError`. The pending-charge fold bills an `entity_type = 'usage_settlement'` row (`USAGE_SETTLEMENT`) as a `usage` line with its price's tax flags and coupon matching; other rows stay taxable + exclusive `one_time`. `pending.ts` reads its window from `subscriptions/usage-window.ts`. Cover: `verify:usage-pricing`, `verify:recurring-usage`, `verify:usage-item-removal`.
- **2026-10-25** — **Line `adjustment` (0385) and the commitment true-up.** `invoice_line_items.adjustment` marks a true-up line: `minimum_spend` (the planner's per-price minimum) or `commitment`; serialized on lines. The planner takes `commitment` (`CommitmentInput`) and adds one "Minimum commitment adjustment" plan line for the shortfall, counting this invoice's own lines of the closing term; the commit re-counts under the claim and throws `CommitmentMovedError` if the counted fees moved. A `commitment` unbilled charge folds in as a plan line (`createInvoiceFromLines` carries `adjustment` too). `BillSubscriptionPeriodInput.metadata` is stored on a fresh invoice; monthly usage invoices store `sub_period` + `usage_window`, the read reports `sub_period`, and regenerate replays them (usage only, no plan fee). The renewal estimate shows the true-up.
- **2026-10-27** — **A reversed payment's refunds stay settled.** `paidTotals` adds the refunds
  (not failed) of a `failed` payment to the succeeded sum, and `dunningNotHeldSql` mirrors it. A
  late reversal takes back only what the payment still held, so a refunded-then-reversed invoice
  reopens for amount − refunds, matching AR (user decision). Gate:
  `verify:engine-gateway-conformance` § V1.
- **2026-11-01** — Meter usage lines write `cost_minor` / `cost_basis` (0458) from the rating; a settlement's cost rides `rating.settlement_cost` until invoiced (`takeSettlementCost`). `serializeInvoice({ showCost })`: cost fields and `segments[].model_cost_override_id` only for `usage_margin:view` (`publicRating`). Cover: `verify:usage-margin`.
- **2026-11-01 (0466, Tier 3 PR 2)** — Credit grants on the period invoice: `resolvePeriodInvoiceMoney(plan, balances, grants)` draws pre-tax grants before the promotional bucket and post-tax grants before refundable (see `credits/README.md`); the commit posts the draws (`postGrantDraws`) under lock 7401 and writes `grant_credits_pre_tax_minor` / `grant_credits_post_tax_minor`. `total_minor` (serializer, document, list SQL) nets the pre-tax slice like promo; `credits_applied_minor` adds the post-tax slice. Void gives the draws back and voids pending grants the invoice sold. `createInvoiceFromLines` takes no grants. Gate: `verify:credit-grants`.
- **2026-11-01 (Tier 3 PR 2, packs)** — A pack line (price `grants_credit.kind = "pack"`, or a line with `creditPack`) takes no promotional credit and creates a pending credit grant in the invoice transaction; a `taxed_at_use` pack line is zero-rated (`prepaid_credit`), in `createInvoiceFromLines` and `previewInvoiceFromLines` alike. Every `invoice_paid` site calls `activatePaidCreditGrants`. `createInvoiceFromLines` / `createManualInvoice` take `inTx`; `recordOfflinePaymentInTx` is the in-transaction half of `recordOfflinePayment`. `commitSubscriptionPeriodInvoice` runs `applyPlanCredits` for the subscription's own term. Gate: `verify:credit-packs`.
- **2026-11-02 (Tier 3 PR 2)** — `isOwnTermInvoice`: the plan-credits guard is null-safe (a trialing first bill has no period). Gate: `verify:credit-packs` §4.
- **2026-11-02 (0481)** — `recordFailedPayment` passes `billing_rules_config.mandate_revoked` to `planFailureRearm`; on `request_new_mandate` a newly parked revoked-mandate invoice sends the customer a `payment_method_request` (best-effort, sync collect path only). `POST …/void` refuses without `void_reason_code` when `required_reasons.void_invoice` is on. Gate: `verify:settings-billing-rules`.
- **2026-11-03 (settings slice F)** — `recordOfflinePayment`: a part payment that leaves a shortfall at or below `billing_rules_config.partial_payment_write_off[currency]` writes it off in the same transaction with an adjustment credit note (reason `payment_shortfall`, booked to `credit_adjustments`) and the invoice is paid; the audit row carries `shortfall_written_off_minor`. The failure writer and the dunning loaders pass the subscription (plan policy) and the method schedule / cadence. Gate: `verify:settings-dunning-p2`.
- **2026-11-03 (slice F re-review)** — The dunning journey passes `priorMethods`, so the preview follows the instrument-switch rule.
- **2026-11-03 (0489)** — The three tax builders (`resolvePeriodInvoiceMoney`, `createInvoiceFromLines`,
  `previewInvoiceFromLines`) pass `customers.tax_behavior` to the resolver and decide inclusiveness with
  `lineIsInclusive`. `sellerAtIssue` takes the destination country (the customer's, or a manual invoice's
  `country`): a seller tax ID set for it in `tax_settings.seller_tax_ids` is frozen as `seller_tax_id`, with
  that country as `seller_tax_country` (so the label follows it). Gate: `verify:tax-settings` A–D.
- **2026-11-03** — `planSubscriptionPeriodInvoice({ items })`: preview only, rates the given rows
  instead of the stored items (the renewal estimate after a scheduled change).
- **2026-11-04 (G3b)** — Period invoices grant due reset windows (`ensureCreditWindows`) before they read grants, in the plan and again under the customer lock in the commit, and split meter usage lines at reset-window grant edges (`ComputedLine.grantSlices`, `credits/slices.ts`) so each window's grant pays only its own usage. The line itself is unchanged. Gate: `verify:plan-credit-resets` §2.
- **2026-11-04** — Manual invoice lines: `amount_minor` at most 10^12 (`LIMITS.amountMinor`), `quantity` at most 1,000,000. Gate: `verify:strict-params` § F.
- **2026-11-04** — `serializeInvoice` returns `metadata` through `publicMetadata`
  (`platform/public-metadata.ts`): an imported invoice's `metadata.source_payload` (the raw source
  record) stays stored and is no longer returned by the API. Gate: `verify:migration-history`.
- **2026-11-05** — `recordOfflinePayment` takes `shortfall` (`write_off` | `leave_due`) and `excess` (`credit` | `refund`) for one call; route fields on `POST …/invoices/:inv/pay`. `leave_due` never writes off; `write_off` keeps the business amount and percent caps and is refused (400, nothing booked) when the shortfall does not fit — decided before any write (`offlineShortfallWriteOff`). Omitted shortfall = the rule. `excess: refund` books the excess as credit, then draws it straight back (dr `excess_payment_balance` / cr cash, source `excess_refund_reserve`) with a succeeded offline `refund` transaction; response `excess_refunded_minor`. Omitted excess = `credit`, as before (`payment_application.excess_payment` governs gateway payments only). Gates: `verify:settings-dunning-p2` (2.12 per call), `verify:settings-payment-application` 4H.
