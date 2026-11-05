# payment-intents — on-session 3DS/SCA

> Source: `src/modules/payment-intents/` · Routes: `src/api/payment-intent-routes.ts` · Schema: `db/schema/payment-intents.ts`
> Layer: payments (see docs/architecture/architecture.json)

## Purpose
An intent is a **container of attempts** covering two flows:

- **`purpose: 'payment'`** — a priced authorization captured into an invoice.
- **`purpose: 'setup'`** — a **zero-amount** authorization whose product is a vaulted instrument
  (Stripe `seti_…`). This is the majority of real traffic — every checkout / portal / add-card
  vault is one — and it was unrepresentable before 2026-08-10.

On-session, a buyer completes the gateway's challenge and the server consumes the authorized intent
during create-subscription / collect instead of issuing a bare charge. Off-session `requires_action`
during renewal still falls back to retriable dunning — nobody is present to answer a challenge.

## Responsibilities
- Create an intent + attempt #1, returning the buyer's challenge as a `BuyerAuthorization`.
- Retry — mint attempt N+1, **never** mutating attempt N.
- Authorize the current attempt (real gateways: inbound webhook; test mode only: the force-pass route).
- Consume — capture into an invoice (`payment`) or vault the instrument (`setup`).
- Void an authorized-but-unconsumed intent; hourly expiry sweep → release the hold at the
  gateway, then `expired`.

## Data model
`db/schema/payment-intents.ts` — `payment_intents` (`status`
inited|in_progress|authorized|consumed|expired|**voided**, `purpose`, `attempt_count`, amount,
`max_amount_minor`, currency, gateway_account_id, payment_method_id, invoice_id, subscription_id,
`next_action` jsonb, `expires_at`, `voided_at`).

`db/schema/payment-attempts.ts` — `payment_attempts` (`attempt_number`, `status`
inited|requires_action|authorized|consumed|failed|voided, `id_at_gateway`, `error_code`/`error_text`,
**`trace_id`**). One row per gateway interaction; a failed attempt stays on the timeline forever.

`transactions` carries `payment_intent_id` + `payment_attempt_id` on every path.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `createPaymentIntent` | create intent + attempt #1, return the challenge |
| `retryPaymentIntent` | mint attempt N+1 (legal only when the latest attempt failed) |
| `authorizePaymentIntent` | drive the current attempt to `authorized` |
| `consumePaymentIntent` | capture into an invoice, or vault the instrument |
| `voidPaymentIntent` | release an authorized, unconsumed intent |
| `expirePaymentIntents` | hourly expiry sweep |
| `listPaymentIntentsPage` · `listAttemptsForIntent` · `getCurrentAttempt` | reads |
| `findPaymentIntentByGatewayIntentId` · `failPaymentIntentFromGateway` · `markPaymentIntentVoidedFromGateway` | inbound-webhook entry points |
| `serializePaymentIntent` · `serializePaymentIntentRow` · `serializePaymentAttempt` | API serialization |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/businesses/:biz/payment_intents` | list (`?status=` `?purpose=`, keyset) |
| `POST .../payment_intents` | create (`purpose`, zero-amount legal for `setup`) |
| `GET .../payment_intents/:pi` | fetch + `attempts[]` |
| `GET .../payment_intents/:pi/attempts` | attempts only |
| `POST .../payment_intents/:pi/authorize` | **test mode only** — force-pass the challenge |
| `POST .../payment_intents/:pi/retry` | new attempt |
| `POST .../payment_intents/:pi/void` | release the authorization |
| `POST .../payment_intents/:pi/consume` | consume (`invoice` optional — a setup intent has none) |

## Events emitted
`payment_intent_created/authorized/consumed/failed/voided/expired`,
`payment_attempt_created/failed`, `payment_succeeded`, `invoice_paid`.

## Dependencies
- **Upstream (calls into):** events, gateway, invoicing, ledger, payment-methods, transactions, webhooks.
- **Downstream (called by):** subscriptions + invoicing (consume on create/collect), checkout,
  customer-portal and payment-methods (add-card → a `setup` intent via `src/api/vault-setup.ts`),
  webhooks/inbound (gateway-driven authorization).

## Invariants & gotchas
- Intents expire (~1h) against the **business** clock, not wall-clock, so time-travelled test
  businesses expire in simulated time. Consume promptly; an expired intent must be recreated.
- **Idempotency keys are attempt-scoped** (`pi_consume_<pid>_a<n>`). Reusing the create key on a
  retry makes the gateway hand back the FAILED intent instead of opening a new authorization.
- A **decline is data, not an exception** — adapters return `IntentRef.failure` / consume's
  `failure`; the attempt goes `failed` while the intent stays `inited` so it remains retriable.
  Persisting the gateway's bare status instead loses the decline silently.
- `payment_intents` has **no `failed` status**. "Open intent + failed latest attempt" is the state
  `retryPaymentIntent` requires.
- **RazorPay cannot void.** `capabilities.intentVoid: false`; `voidPaymentIntent` fails by name
  rather than substituting a refund, which would move real money for a payment that never settled.
  The expiry sweep therefore cannot release a RazorPay hold either — it lapses on RazorPay's own
  timetable. That is unavoidable; being SILENT about it was not. WARN `intent_hold_abandoned` +
  `hold_release` on `payment_intent_expired` is the trail.
- **Expiry is not just a status change.** An `authorized` intent holds buyer money, so the sweep
  releases it at the gateway first and books a `payment_reversal`. The absence of that transaction
  is what keeps `voidPaymentIntent` reachable on an `expired` intent — do not turn that back into
  a flat refusal.
- Off-session `requires_action` on renewal remains retriable dunning (a hosted Pay-Now page is still
  future work).

## Changelog

- **2026-11-03** — An attempt is a SPAN of its caller's trace, not a trace of its own
  (`attemptSpan`). Each attempt mints `pi-…` as `payment_attempts.span_id` (0496); later calls
  on it (fetch, void, consume) join that span; `trace_id` is the request or job that made it,
  so the API request log's gateway link finds an intent's calls again. The attempt link
  filters on `span_id`. Older attempts: their per-attempt trace id stands in for the span.
- **2026-11-02** — Create and retry refuse a saved mandate in another currency before the
  gateway (`mandate_currency_mismatch`, same rule as collection), and send the method as
  `providerPaymentMethodRef` with the mandate we hold. Cover: `verify:engine-gateway-conformance` M1.
- **2026-10-30** — `first_charge_minor` (0403) on a `setup` intent: what its registration also
  collects as a first invoice (`CreatePaymentIntentInput.firstChargeMinor`, passed to the adapter
  only when `capabilities.setupCollectsFirstCharge` lists every requested method; a retry
  re-sends it). `amount_minor` stays 0 on setup intents.

- **2026-10-29** — A `setup` intent for a method in `live-proof-pending.json` is refused
  (`method_not_offered`); `hostedWallet` on such a gateway answers `wallet_not_offered`. A
  `payment` with a saved method is not checked. `pendingMethods: {}` lets conformance prove one.
- **2026-10-28** — `createPaymentIntent({ hostedWallet: "apple_pay" })` (buyer-picks pay-now only;
  refused with `wallet_not_offered` on a gateway without `applePayHosted`). An `only` page stamps
  `payment_attempts.method_used = apple_pay` at create. `repointAttemptAtGateway` (compare-and-set)
  serves the webhook's `gatewayIntentId`.
- **2026-10-28** — `applyClientResult` stores `FetchedIntent.methodUsed` on the attempt
  (`payment_attempts.method_used`, 0398) with the new gateway id; `finishPaymentConsume` books
  it when the capture result names no method (Adyen and Checkout.com captures: Google Pay).
- **2026-10-28** — Both consume inserts write `payments.method_type` (`methodTypeFor`: the gateway's
  `methodUsed`, else the intent's saved method). The raw `metadata.payment_method_used` stays, as
  it keeps names the column folds (`apple_pay`, `ideal`).
- **2026-10-28** — An intent with no payment method to route from (setup, or a buyer-present
  payment) passes its `purpose` to `selectGatewayAccount`, so it routes only to a gateway that can
  do it. `assertSupportsPurpose` stays as the guard for a pinned account, through the shared
  `allowsIntentPurpose` reading; its message is unchanged.
- **2026-10-26** — Both `adapter.createIntent` sites compute the intent's expiry before the call and pass it as `CreateIntentInput.expiresAt`, so a gateway page can close with the intent (Cashfree `order_expiry_time`). The stored `expires_at` is the same value.
- **2026-10-26** — **`authorizeFromGateway`: catch an unfinished intent up before refusing it.**
  Exported for callers that gate on `authorized` before consume (hosted checkout leg 2). Runs
  consume's own poll (`confirmAuthorizationWithGateway`): authorized or captured at confirm →
  `authorizePaymentIntent`, returns the intent; anything else (an unasked capture, a failed read, no
  `intentStatus`, a setup intent) → null. **`authorizePaymentIntent` no longer walks back a consume:**
  its UPDATE skips consumed/expired/voided rows and throws `PaymentIntentError("Intent is no longer
  open")`, so a webhook racing a leg-2 consume answers `ignored`.
- **2026-10-25** — **`resumeVerdictFromGateway`: read an open intent before a buyer resumes it.**
  For adapters that declare `intentStatus`: `authorized`/`consumed` → `settle` (the caller runs
  consume; the atomic `authorized → consumed` claim still books it once), `voided` → `closed` (our
  row goes through `markPaymentIntentVoidedFromGateway`), anything else or a failed read → `open`.
  Other adapters always get `open`. Used by the portal Pay now resume.
- **2026-10-25** — **A pay-now can take money the gateway captured at the buyer's confirm.**
  Stripe pay-now intents were all manual capture, which limits Elements to methods that can be
  held, so bank debits and redirect methods never appeared. A buyer-picks intent WITH an invoice
  now passes `captureOnConfirm`; Stripe captures non-card methods at confirm (cards and Link stay
  authorize-then-capture). Consume books that money instead of capturing it: the probe accepts
  `FetchedIntent.capturedOnConfirm` (`consumed` + flag ⇒ authorize through the one writer, then
  consume), and the adapter answers a refused capture by reading the intent (`succeeded` /
  `pending`). Stripe now declares `intentStatus`, so the buyer's leg 2 no longer waits for the
  authorization webhook, the expiry sweep polls Stripe rows (and logs
  `intent_captured_unbooked_at_expiry`), and an operator void of a never-authorized Stripe intent
  no longer books a reversal. Webhook safety net: a marked `payment_intent.succeeded`/`processing`
  fans out to `intent.authorized` (`captureState`) first; an invoice that no longer owes exactly the
  amount goes through `reconcileUnmatchedCapture` (book, refund the excess), never the void path.
  Checkout purchases with no invoice keep manual capture.
- **2026-09-30** — The list accepts `offset` as an alias of `starting_after`, matching the `next_offset` the shared envelope now returns while `has_more`.

- **2026-09-07** — ✅ **A refused authorization is booked as a TRANSACTION, on create AND on
  retry.** 13152c64 gave a create-time refusal an intent and an attempt; neither is a row anyone
  reads. The invoice lists transactions, the customer's Transactions tab lists transactions, and the
  gateway's own id lives on one. `bookRefusedTransaction` is now called from the create site and
  BOTH retry branches, the twin path that had the identical gap. ⚠️ This was NOT the cause of the
  2026-09-06/07 orphans — those came through `charge()`, which books its transactions (#63) and was
  missing only the gateway id; verified on the invoices themselves.
  Gateway-agnostic by construction: whether an id survives a refusal is the adapter's business
  (Stripe returns the PaymentIntent it kept, RazorPay the stranded order, PayPal nothing, because
  nothing is left), and this books whatever came back, including nothing. `payment` purpose only —
  a refused `setup` moved no money. An INDETERMINATE outcome still books nothing at all.
  The RENEWAL path is `charge()`, not this module: it already booked the refusal (#63) but threw
  the stranded PaymentIntent id away — fixed in `src/providers/stripe.ts` in the same change.
- **2026-09-07** — ✅ **A buyer-present sheet no longer inherits a mandate's authentication
  window.** `intentTtlMs` gave an on-session INR card debit above ₹15,000 the card rail's 96 hours,
  on the strength of the issuer's AFA link (measured 2026-08-13 — on a MANDATE debit, which is what
  it still covers). The portal's "Pay now" has no such link: the buyer types a card into the
  gateway's own sheet and clears 3DS inline, so an abandoned checkout sat on its invoice for days
  through `liveIntentForInvoice`. `letBuyerChooseMethod` — already the flag that withholds the
  stored instrument from the adapter — now withholds it from the deadline too, and the intent takes
  `ON_SESSION_TTL_MS`. It is rule 3 of the decision list, ahead of the
  `BUYER_PRESENT_SYNCHRONOUS_RAILS` test and not after: the mode passes no instrument and no
  `methodTypes`, so the rail arrives unknown and the rail test would have diverted it to the 72h
  default, leaving the hour unreachable. Overtaking that test costs nothing — the asynchronous case
  it protects is a mandate registration, and every `setup` intent has already returned at rule 1.
  Keyed on the flag alone, never the gateway: Stripe Elements, RazorPay's overlay and a PayPal
  approval are all buyer-present. On PayPal it is also the safer clock — an approval URL dies on
  PayPal's own ~3h timer, so a 96h TTL could hand out a resume link that is already dead.

- **2026-09-07** — ✅ **#101: a gateway that rejects the request is still an outcome.** Anything that
  THROWS out of an adapter's `createIntent` is now booked as `gateway_request_rejected`,
  non-retriable, and then RETHROWN — the row is a record, not a verdict, so an engine bug still
  reaches the caller. Adapters return genuine declines as data, so a throw is by definition our
  side. Measured 2026-09-06: a Collect now Stripe refused booked NOTHING — no intent, no attempt
  (`payment_attempts.payment_intent_id` is NOT NULL, so it had nowhere to live), no transaction —
  and the failure survived only in `gateway_request_logs`. It covers RazorPay and PayPal, neither of
  which has a try/catch in `createIntent`, without guessing a single error code; there is no
  evidence base to guess from (1 stored `BAD_REQUEST_ERROR` between them).
  ⚠️ `ProviderIndeterminateError` is re-thrown untouched: a timeout is not a rejection, and a
  definite failure booked over an unknown state is worse than none.
  The test seam is a tmtest CREDENTIAL (`create_intent_fault`), not a magic amount — a magic amount
  ending in 21 hijacked an unrelated `4321` fixture and crashed `verify:gateway`; only one two-digit
  suffix is unused across `scripts/`.

- **2026-09-06** — ✅ **#97: a buyer-present intent no longer needs a stored instrument.**
  `letBuyerChooseMethod` withholds the saved method from the adapter — the buyer types a card into the
  gateway's own sheet — so naming one decided nothing they saw, and still refused them when it sat on
  an account that could not take the invoice's currency (production, `does not handle INR`). The ctx
  branch now keys on whether an INSTRUMENT exists rather than on the purpose, and routes through
  `selectGatewayAccount`; the provider-customer lookup does the same, so it no longer dereferences
  `ctx.pm!` (fixed in `retryPaymentIntent` too, which would have crashed retrying such an intent).
  Off-session still requires a token — there is nothing to charge without one. No migration:
  `payment_method_id` was already nullable, `consumePaymentIntent` never reads it, and both readers were
  already null-guarded.

- **2026-09-04** — ✅ **#42: a gateway condition we cannot resolve had no HTTP shape.** #32 made
  PayPal's `voidIntent` THROW when it cannot establish which authorization to void; nothing wrapped
  that throw, so the operator's Void action answered `500 {"type":"api_error","message":"Internal
  server error"}` — measured on the portal leg too, where a buyer saw the same sentence.
  - New `ProviderIndeterminateError` (`providers/types.ts`), the deliberate **mirror** of
    `ProviderRefusalError`: a refusal is a request a human must change → **400**; this is a fact we
    could not establish, nobody did anything wrong and retry is right → **502** via the new
    `badGateway` helper (`api/helpers.ts`), body `{error:{type:"gateway_error",message,retriable:
    true}}`. Named for INDETERMINACY, not unavailability: it carries exactly the meaning
    `VoidIntentResult.held === undefined` carries one layer down — "cannot say", never "nothing was
    held".
  - Mapped at four route sites and no more: create, retry and **void** in `payment-intent-routes.ts`
    (the void route is where #32's throw actually lands and was catching only `PaymentIntentError`)
    and the portal `collect` in `customer-portal-routes.ts`, where the adapter's gateway-resource
    sentence is logged and replaced with buyer-safe wording rather than forwarded (#28a's rule).
  - ⚠️ **The message describes our KNOWLEDGE, not the money.** "We could not confirm whether the
    hold was released" ≠ "the hold was not released"; the second is #21 re-entering through the
    error channel. Both the adapter sentence and the buyer replacement are asserted against a
    phrasing predicate, and the buyer wording deliberately does NOT borrow #28a's "nothing has been
    charged" — that claim is available only when the gateway was never reached.
  - **Idempotency: a 502 leaves the caller's key REPLAYABLE, and it was already right.**
    `idempotencyOnSend` decides from the ROW's own status, not the status code: a non-2xx whose
    request wrote nothing durable DELETEs the `in_progress` row, and `voidPaymentIntent` makes no
    durable write before the adapter call (`heldBeforeVoid` and the account read are selects, which
    assign no xid). `pnpm verify:gateway` asserts the row is gone AND that the same key retried
    afterwards re-executes for real → `200 voided`. A `side_effects` request would instead go
    terminal `failed` and replay the failure forever — correct for a write that landed, and not
    reachable on the void path.
  - ⚠️ **The RETRY route is the opposite case, measured.** `retryPaymentIntent` records the failed
    attempt N+1 before rethrowing (on purpose — the timeline must not lose a real gateway
    interaction), so a 502 there HAS side effects: the key goes terminal `failed` and the caller's
    retry replays the stored 502 even after the gateway recovers; only a NEW key gets through. That
    is the idempotency contract working as designed, not a fault of #42's, and all three steps are
    asserted in `pnpm verify:gateway` so the consequence is visible if either half changes. "A 502
    is always replayable" is therefore false in general — it holds where the request wrote nothing.

- **2026-09-04** — ✅ **#36: a SETUP refusal promised an invoice that cannot exist.** Found while
  explaining why widening #23's poll was *not* worth doing. `confirmAuthorizationWithGateway` is
  hardcoded to `not_authorized` for `purpose: 'setup'`, so a stale setup row reaches the refusal
  without the gateway being asked — and the sentence it threw was written for a payment: *"…it will be
  applied to this invoice on its own once it arrives."* A setup intent has no invoice; its product is a
  vaulted instrument. It told someone saving a card to wait for a document that will never exist. The
  expiry refusal had the same fault (*"start a new payment"*). Both are now chosen by purpose.

  The **money clause stays on both** wordings: a setup intent can still have taken a real verification
  debit (RazorPay's e-mandate registration is a ₹1–5 charge with its own refund lifecycle), and an
  expired intent may hold live funds — that is #15. Claiming nothing was taken would be the same
  confident falsehood these defects are about. The error CODES are unchanged; only the sentence shown
  to a person was false.

  ⚠️ Reachable from the OPERATOR consume route, which has no self-authorize wrapper the way
  `completeVaultFromIntent` does — that wrapper is why #28 found the buyer's path unreachable. Asserted
  on the WORDS, deliberately: the code was already right, so a code assertion would have passed
  throughout and proved nothing. Three mutations prove the checks are orthogonal — reverting the
  wording kills both copy assertions and not the code one; a vague-but-invoice-free wording kills only
  the "names what they were doing" check; changing the code kills only the code check.

- **2026-09-04** — ✅ **#28: the two leaking gateway messages were an UNAPPLIED CONVENTION, not a hard
  problem.** This module already documents "`message` on the consume path is written FOR THE PAYER —
  assert on the code, show the message to the person"; `assertIntentGatewayUsable`'s throw sites had
  never been updated to follow it. Codes stay stable (`gateway_account_inactive`, `gateway_mode_mismatch`,
  `gateway_account_missing`); the message is now one true, non-blaming, config-agnostic sentence, with a
  `log.error` at the throw site carrying the real account id and mode to the existing structured-log
  surface. A second leak the filing never named was found at the collect route, which forwarded
  `GatewayRouterError` verbatim — including *"Multiple gateway accounts match INR; set a default gateway
  account"*, instructing a BUYER to change our configuration. Fixed at the one buyer-facing route,
  because those errors are legitimately raw on the operator routes that share them.

  ✅ **Setup-consume staleness: NOT REACHABLE, and that is measured.** `completeVaultFromIntent` calls
  `authorizePaymentIntent` itself before consuming, and a race is absorbed by an existing refusal-catch
  plus a 2s wait loop — an older mechanism than #23's poll. Proven by building #23's exact race shape
  for setup and then MUTATING OUT the self-authorize block, at which point the same test failed exactly
  as #23's pre-fix payment path did.

  ⚠️ **Still real for callers that bypass that wrapper**: the operator route
  `POST /v1/businesses/:biz/payment_intents/:pi/consume`, `checkout/service.ts`, and
  `webhooks/inbound.ts:1559` can consume a stale-but-actually-authorized setup intent and still hit the
  false "not authorized" refusal. Widening the poll needs `purpose` threaded through `fetchIntent` plus
  a decision about the India e-mandate verification-charge refund lifecycle — its own brief.

- **2026-09-04** — 🟠 **A void booked a full-amount `payment_reversal` for a hold that never
  existed (#21).** `voidPaymentIntent` refuses only `consumed`/`voided`/`expired`-with-a-reversal,
  so it reached the gateway on an `in_progress` checkout and recorded a release of money the buyer's
  bank never took — 63 of the 102 intent reversals in the dev database are exactly that shape
  (₹1,530.00, all tmtest; zero on razorpay, structurally, because `intentVoid: false` throws first).
  `heldBeforeVoid` now asks the gateway BEFORE the release (the release itself moves the gateway's
  row, so the order is load-bearing) and the transaction is written only where a hold existed:
  `authorized_at` counts as our own record of one, `authorized` is the only gateway answer that
  does, and a gateway that cannot be asked keeps today's behaviour. Gate: `verify:stale-pending` §T,
  red-before-green, mutation-tested in three runs. ⚠ Stripe/PayPal are unfixed by construction —
  they can void a `requires_action` intent and declare no `intentStatus`.
- **2026-09-03** — 🔴 **`releaseHoldBeforeExpiry` trusted OUR status, which is the one thing a late
  webhook leaves stale.** It opened with `if (pi.status !== "authorized") return { outcome: "not_held" }`,
  so at expiry it made no gateway call and concluded nothing was held — while the buyer's ₹22,184.00 sat
  authorized at RazorPay for 21 minutes with the invoice unpaid, the buyer blocked from paying, and
  nothing alerting. The adapter contract had `createIntent` / `consumeIntent` / `voidIntent` and nothing
  that ASKED. Now `fetchIntent?` exists (RazorPay + tmtest only, capability-gated; Stripe and PayPal
  deliberately absent — they do not have this bug and four adapters is four times the surface for no
  measured gain) and the release path polls instead of assuming. Aged `in_progress` intents also join the
  held-money alert, thresholded at `ON_SESSION_TTL_MS` (1h) — derived, not chosen: it is the shortest
  deadline the engine ever gives an intent, and create→authorize latency over the 122 intents that ever
  authorized here is p50 0.5ms / p95 114ms / worst 23m16s, so an hour is 2.5× the slowest real
  authorization. The rail TTL was rejected: at up to 7 days it would have kept this ₹22,184.00 silent for
  95 hours. Also new: `closeIntentForReturnedCharge`. See #15 and #17 in `docs/PROGRESS.md`.

- **2026-08-31 (night)** — **The TTL is rail-aware, `authorized_at` is finally written, and a late
  authorization can be revived.** All three come from one measured failure
  (`scripts/probe-late-authorization.ts`): our flat `INTENT_TTL_MS = 1 hour` expires the intent, the
  webhook counts `expired` as terminal, and a bank approval arriving afterwards is DROPPED — leaving a
  live hold against an unpaid invoice, or a live mandate with no `payment_methods` row (a customer
  registered for debits the engine cannot see). Production evidence: INV-5510 carries two RazorPay
  orders, the second `authorized` with a real payment and zero engine rows.
  * **`ttl.ts`** — one hour is right for exactly one shape: an on-session CARD, buyer in front of the
    challenge (and `expirePaymentIntents` still says do not shorten it). Every other
    case takes its rail's window — emandate/NACH 7d (up to 2 working days to authorize, T+1 token
    confirmation on HDFC/SBI, a weekend inside that), card 96h (past the 72h INR AFA link's own expiry),
    UPI 48h, 72h default. A `setup` intent NEVER takes the hour: its product is a registered mandate and
    that is asynchronous on every INR rail. ⚠️ Being on-session does not make a BANK synchronous — the
    first cut of the rule gated the hour on the session alone and `verify:gateway` C7-TTL caught an
    on-session e-mandate still being given an hour, which is the exact bug the file exists to remove.
    The table is a deliberate COPY of `stale-pending.ts`'s `RAIL_GRACE_HOURS` (sharing it closes an
    import cycle) pinned by `verify:stale-pending` § N, which compares them rail by rail.
  * **`authorized_at`** was never written by ANY code — schema declaration plus one reader
    (`intent_hold_not_abandoned`, whose predicate requires it non-null), so that invariant was
    permanently green: measured NULL platform-wide, including on an intent that provably held money. Now
    stamped `coalesce(authorized_at, now())` at every transition into `authorized`, per migration 0217's
    documented contract. Coalesce rather than assignment because several writers RE-ENTER `authorized`
    when a consume claim is released; a bare `new Date()` would rewrite the moment the buyer's money was
    first held to the moment a capture was refused.
  * **`reviveIntentForLateAuthorization`** — `expired` is our clock's opinion, not the gateway's, so it
    is the one terminal state worth revisiting. Compare-and-set on `status = 'expired'` (gateways
    redeliver; two copies must not both revive), refuses `consumed` and — importantly — `voided`, because
    a void means we asked the gateway to hand the money BACK. It reopens only the attempt the sweep failed
    with `intent_expired`, never a genuine decline, and pushes `expires_at` off the BUSINESS wall clock
    so a time-travelled business does not get an intent that is already expired again.
- **2026-08-30** — **expiry stops abandoning the buyer's money, and three smaller money-path
  defects around it.**
  - **The expiry sweep now RELEASES the hold before it writes the intent off.** This was the
    critical one. `expirePaymentIntents` set `status = 'expired'`, failed the open attempts and
    emitted the event — and made no gateway call at all, while `voidPaymentIntent` had done the
    right thing since 2026-08-10 with nothing wiring it in. An `authorized` intent holds REAL
    buyer money, and it is reachable straight from the portal's Pay now: every time
    `harvestInvoiceIntent` answers `ignored` (the gateway has not posted the authorization yet,
    or the invoice's outstanding drifted so the consume's exact-amount check refuses) the intent
    sits `authorized` with funds held, and an hour later we abandoned them silently. New
    `releaseHoldBeforeExpiry` runs before the row goes terminal, only for `authorized` intents
    (nothing else holds anything) and only where `capabilities.intentVoid` — and it **never
    throws**: this is a platform-wide sweep, so a gateway that is down must not strand every
    other tenant's rows behind one bad row. A real release books the same `payment_reversal`
    transaction `voidPaymentIntent` books, so Gateway Activity reads identically however the
    hold came to be released. `expirePaymentIntents` now returns `{ expired, released, abandoned }`.
  - **RazorPay's unreleasable hold is now LOUD instead of silent.** `intentVoid: false` is honest
    — there is no cancel call, and faking one with a refund would move real money for a payment
    that never settled — so the hold lapses on RazorPay's timetable and nothing here can change
    that. What changed is that it is no longer invisible: WARN `intent_hold_abandoned` with the
    amount, currency, customer, invoice and gateway-account ids, plus `hold_release` on the
    `payment_intent_expired` event so a webhook consumer sees it too. (An invariant check
    for stranded holds is proposed but not written.)
  - **`voidPaymentIntent` refuses an `expired` intent only when the hold is accounted for.** The
    flat refusal was the second half of the same bug: the sweep abandoned the hold and this
    closed the one API that could release it. It now refuses when a `payment_reversal` exists
    (a second void could only fail, and re-closing a terminal row rewrites why it closed) and
    lets the release through when none does — which is exactly the residual case, a sweep whose
    gateway call failed. `INTENT_TTL_MS` is untouched: 1 hour is still the right deadline, and the
    release is what was missing, not the deadline.
  - **`finishPaymentConsume` no longer books against a stale amount.** The invoice validation and
    the atomic `authorized → consumed` claim commit in one transaction, the capture runs OUTSIDE
    it, and the booking ran in a third — writing `paid` and a cash/AR pair for `dueMinor` as read
    BEFORE the capture. An adjustment note or another settler landing in that window over-credited
    `accounts_receivable` by the difference. Now the invoice is re-read `FOR UPDATE` inside the
    booking transaction and the outstanding re-resolved. `commitSubscriptionPeriodInvoice`'s shape
    (re-resolve under a lock, then refuse) does not transfer — the money is already captured, so
    refusing would roll back its only record — so this follows `settlePaymentSucceeded`'s instead:
    apply what the invoice can absorb, DETACH the payment and hold the surplus as the customer's
    excess payment (then draw it straight back down onto the invoice, because `collectInvoice`
    does not draw credit and the next dunning retry would otherwise charge twice). An invoice that
    grew instead keeps the cash and stays open — `invoice_paid` fires only when it actually settles.
    That overshoot was MEASURED on the async twin; this is its synchronous twin and had no guard.
  - **Two paths stopped walking past the gateway router's currency guard.** `router.ts` is explicit
    that its contract is "no silent fallback", and its `override` branch validates `handlesCurrency`
    AND `handlesMethod`. `resolvePinnedAccount` checked ownership / `active` / livemode and nothing
    else — fed by the buyer-controlled `gateway_account` field on `POST /checkout/v1/setup` and
    `POST /portal/v1/payment_methods/setup` — and `resolveAccountForPm` returned the payment
    method's own vaulting account on sight, so a Pay now on a USD invoice against a card vaulted on
    an INR-only RazorPay account routed there with nobody checking. Both now re-enter
    `selectGatewayAccount` as an `override`, which is the branch that exists for exactly this: the
    pin is honoured (the vaulted token lives at that gateway and nowhere else) and made to prove it
    handles the currency and the instrument. The refusal is ours (`no_gateway_for_currency`, naming
    the account) instead of RazorPay's domestic-rails error. The S6 disabled-account fallthrough is
    unchanged.
  - **`display.type` is read off the payment method instead of hardcoded `'card'`** at both
    `createIntent` call sites — the latent bug the 2026-08-28 entry below flags. Adapters fall back
    to `methodTypes ?? [paymentMethod.display.type]`, so a UPI mandate or a bank debit asked the
    gateway for a card checkout. The coupling that deferred it ("should land with an intent mode
    that pins no instrument") is resolved: that mode shipped as `letBuyerChooseMethod`, which
    sidesteps the fallback by withholding `paymentMethod` entirely — leaving this wrong for every
    other caller.
  - **Measured, not reasoned about.** Three throwaway probes drove the paths no suite reaches:
    a real tmtest hold released by the sweep (`released=1`, `payment_reversal` booked, the void
    then refused by name); a gateway forced to throw, proving two rows still expire, count as
    `abandoned`, book no reversal, and stay recoverable through `voidPaymentIntent`; a card
    vaulted on an INR-only account refused for USD on BOTH bypass paths with
    `no_gateway_for_currency`; the adapter told `display.type=upi` for a UPI instrument; and a
    concurrent settler landing mid-capture leaving AR relieved by 15000 (not the captured 20000),
    cash 20000, 5000 as excess credit, the payment detached. **Mutation-tested**: restoring the
    unconditional AR credit turns that last one red at −35000 and trips `invoice_not_overpaid`.
  - `verify:gateway` · `verify:customer-portal` (86) · `verify:checkout` (266) · `verify:portal` ·
    `verify:vault-setup` · `verify:webhook-inbound` · `verify:concurrent-collect` ·
    `verify:ledger` · `verify:invariants` (89) · `verify:multicurrency` · `verify:stale-pending` ·
    `verify:e2e` — all PASS.
- **2026-08-28** — **`letBuyerChooseMethod`: mint a payment intent that pins no rail**, so the buyer
  picks inside the gateway's own sheet. Withholds BOTH `paymentMethod` and `methodTypes` from the
  adapter, and the two gateways then do the right thing unaided: RazorPay's `selectRail` returns
  undefined for a one-off payment with no rail requested, so the order pins no `method` and Checkout
  offers whatever the merchant enabled (its own comment calls that the correct outcome — no mandate is
  being registered, so nothing is bound to a rail); Stripe's `confirm` is `Boolean(paymentMethod)`, so
  the intent is created UNCONFIRMED with a client_secret, which is how a buyer picks in Elements, with
  `payment_method_types` omitted so the account's automatic methods apply.
  ⚠️ `methodTypes: []` is NOT a way to express this, and the flag exists because of it: RazorPay would
  read an empty list as "no rail requested" and behave, but Stripe's `input.methodTypes ? …` is truthy
  for `[]` and would send `payment_method_types: []`, which it rejects. A flag that says what it means,
  rather than an empty list that means it by accident.
  The payment METHOD is still resolved and recorded — it routes to a gateway account and it is what
  the intent row points at. Only the CHECKOUT is unpinned.
  ⚠️ **Latent, untouched:** `display: { type: 'card' as const }` at both `createIntent` call sites
  hardcodes the rail hint, so any caller relying on the adapter's
  `methodTypes ?? [paymentMethod.display.type]` fallback gets `card` whatever the instrument is. That
  is what the 2026-08-14 "all three rails answered method=card" note was really diagnosing; pinning
  the rail hid it, and this flag sidesteps it by withholding `paymentMethod` entirely. It still needs
  fixing for every other caller.
- **2026-08-22** — **A `setup` consume no longer tries to release a hold that never existed.**
  `finishSetupConsume` called `adapter.voidIntent` unconditionally, so EVERY Stripe add-card logged
  `POST /v1/setup_intents/{id}/cancel → 400 setup_intent_unexpected_state` (Stripe refuses to cancel a
  succeeded SetupIntent) and PayPal — whose `setup` intent is a `/v3/vault/setup-tokens` approval, not
  an order — would have voided against an id it never had. RazorPay was skipped only because it
  reports `intentVoid: false`. A setup intent is created with `amountMinor: 0n` on every adapter:
  there is nothing to give back. Caught-and-warned, so no buyer ever saw it — it wasted a round-trip
  and made Gateway Activity read as if add-cards were failing. The 0-amount `payment_reversal` row
  went with it: with no release attempted, a row typed `payment_reversal` asserted a gateway
  interaction that never happened. `voidPaymentIntent` still releases a real `payment` hold.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).

- **2026-08-01** — **list route** (`listPaymentIntentsPage` + `serializePaymentIntentRow` →
  `GET /v1/businesses/:biz/payment_intents`). There had never been one — create / get-by-id /
  authorize / consume only — so the dashboard could only be a create-and-inspect form with no
  Payment Intents list at all. Cursor-paginated per GUIDE §3.4 on a new keyset index (migration `0140`;
  the table had none because it had never been listed). `?status=` narrows in SQL. The row serializer
  joins customer + gateway + card, which the list's columns need and the single-intent shape lacks.

- **2026-08-10** — **the intent becomes a CONTAINER of attempts, with two purposes** (engine
  rewrite over migrations `0170`–`0172`).
  - **Attempts.** Every gateway-touching operation mints or resolves a `payment_attempts` row.
    `retryPaymentIntent` mints attempt N+1 and **never mutates attempt N** — that is what
    "Payment Attempts: 2" means, and the old flat row overwrote the failed try. `attempt_count` is
    bumped in the same tx as the insert (denormalised because a keyset list can't run a correlated
    COUNT — GUIDE §3.4). `authorize`/`consume`/`void` all act on the CURRENT (highest-numbered)
    attempt, not the container.
  - **`purpose: 'setup'`.** A zero-amount vault authorization (Stripe `seti_…`) — the majority of
    real intents at the gateway, previously unrepresentable. It has NO payment method to route from,
    so it goes straight through `selectGatewayAccount` (`resolveAccountForPm` is unusable without a
    PM); consuming it moves no money and touches no invoice/ledger — the `ProviderPaymentMethodRef`
    is handed to `payment-methods.persistVaultedPaymentMethod`, the single writer of a vaulted row,
    and the authorization is then voided when `capabilities.intentVoid`. A refused setup is DATA
    (`ConsumeIntentResult.failure`), not an exception: the attempt fails and the intent stays retriable.
  - **`voidPaymentIntent`.** Releases an authorized, unconsumed intent → `status = 'voided'` +
    `voided_at`, current attempt `voided`, a `payment_reversal` transaction. A gateway without a true
    void (**RazorPay**) fails by name with `PaymentIntentVoidUnsupportedError` — substituting a refund
    would post real money movement for a payment that never settled.
  - **Trace correlation.** Each attempt carries a `pi-…` trace id (`newTraceId('pi')`), and every
    gateway call for that attempt runs inside `withTraceContext` with it. This is the ONLY key
    joining an attempt to `gateway_request_logs` (platform-global, no RLS → no FK across the tenant
    boundary), and the per-attempt "View Request/Response Logs" link depends on it.
  - **Transactions** now carry `payment_intent_id` + `payment_attempt_id` on every path, success and
    failure — intent-level analytics stop being faked from transaction-level data.
  - **Preserved unchanged:** the atomic `authorized → consumed` claim (409 on loss), the exact
    amount/currency match against the invoice's amount due, the collectible-invoice check, the
    active + livemode-matched gateway account check, claim release on gateway error, the full
    booking (payment + double-entry ledger + txn + invoice → paid + `payment_succeeded` /
    `invoice_paid`), the S6 disabled-vaulting-account fallthrough, and the `businessWallClock`
    expiry comparison for time-travelled businesses.
  - **Events:** `payment_intent_consumed`, `payment_intent_failed`, `payment_intent_voided`,
    `payment_attempt_created`, `payment_attempt_failed`.
  - **Follow-ups:** all closed in the same session except the column comment on
    `payment_intents.status`, which still omits `voided`.

- **2026-08-10** — **a setup intent can now be PINNED to a gateway account and carry a mandate
  ceiling** — the last two things that kept add-card off the intent path.
  - **`CreatePaymentIntentInput.gatewayAccountId`.** Pins the intent to a `gwa_…` account instead of
    routing through `selectGatewayAccount`. Checkout and the customer portal let the BUYER choose the
    gateway and vault on that same account at completion; with no override, a multi-gateway business
    sent the buyer to the wrong gateway or hit `ambiguous_gateway`, so `beginVaultSetup` could only
    take the intent path when the router independently agreed. Validated with the consume path's own
    three checks — business-owned, `active`, livemode-matched — not a new set. Honoured for
    `purpose: 'payment'` too, where it likewise replaces routing.
  - **`CreatePaymentIntentInput.maxAmountMinor`** (`setup` only; rejected for `payment`, which
    registers no mandate). The per-debit ceiling a mandate rail demands up front. The engine
    hard-zeroes a setup intent's `amountMinor`, which used to be the field the RazorPay adapter read
    as the ceiling — so a mandate silently fell back to the adapter default (₹10,000) and larger
    debits failed at charge time. Threaded into `adapter.createIntent` at BOTH call sites.
  - **It persists** — `payment_intents.max_amount_minor` (0174, nullable bigint). `retryPaymentIntent`
    creates a NEW gateway intent, i.e. a NEW mandate registration, from the stored row alone; a
    ceiling held only in the create request would vanish on retry and reintroduce the exact bug.
    The retry path reads it back; `serializePaymentIntent` exposes it as `max_amount_minor`, and the
    create route accepts it under that name (the deliberate "not accepted" comment there is gone —
    the field now reaches a real column).
  - **`src/api/vault-setup.ts`** takes the intent path for every add-card that has a gateway account
    and a currency, RazorPay included, passing the pinned account and `deriveMandateCeiling` (now
    exported from payment-methods — one derivation, two entry points). It also mirrors the
    preconditions `initiateVaultSetupForBusiness` enforces (RazorPay contact, gateway method-type
    allow-list), since the intent path no longer goes through it. Three fallbacks remain and are
    real: `legacyProviderKey` (an ENV-configured provider has no `gateway_accounts` row to pin), no
    resolvable currency, and a gateway that returns a setup intent with no buyer challenge.

- **2026-08-10** — **authorization stops being a fiction** (webhook dispatch + the three real
  gateways). Until now the ONLY route to `authorized` was a test-mode endpoint that force-passed a
  fake tmtest challenge; Stripe, PayPal and RazorPay implemented no intent methods at all, so the
  whole feature was simulator-only.
  - **All three gateways implement `createIntent`/`consumeIntent`** (+ `voidIntent` except RazorPay)
    by generalizing the vault-setup calls that already existed — Stripe `setupIntents.create`,
    PayPal `/v3/vault/setup-tokens`, RazorPay `createMandateOrder`. `initiateVaultSetup` and
    `vaultPaymentMethod` became thin wrappers over the same helpers, so their request bytes are
    unchanged. `charge()` is untouched on all three: the intent path authorizes with manual capture
    (`capture_method:'manual'` / `intent:'AUTHORIZE'` / `payment_capture: 0`) and captures on
    consume, while off-session renewals keep charging immediately.
  - **New `intent.*` normalized events** — `authorized`, `failed`, `voided`, `setup_succeeded`,
    `setup_failed`. Deliberately NOT folded into the `charge.*` vocabulary: an authorization is a
    HOLD, so `amount_capturable_updated → charge.succeeded` books cash that was never captured, a
    cancel → `charge.failed` reverses cash never booked and re-arms dunning, and `setup_intent.* →
    payment_method.updated` hands the card-updater a card-less payload and blanks a stored card.
  - **`NormalizedProviderEvent.providerIntentId`** is its own field because a RazorPay intent is
    keyed by ORDER id while the payment webhook carries a PAYMENT id — correlating through
    `providerChargeId` would resolve the wrong object or none.
  - **Dispatch** correlates `providerIntentId` → `payment_intents.intent_at_gateway` (indexed by
    `0173`) and acts on the CURRENT attempt. Replay-safe four ways: the existing
    `(provider_key, provider_event_id)` dedup; state-guarded branches (PayPal sends both
    `ORDER.APPROVED` and `AUTHORIZATION.CREATED` → authorizes once); a gateway-id match against the
    current attempt, so stale news from attempt N-1 cannot touch attempt N after a retry; and
    unknown-intent → `ignored`, never a throw, so a CLI test event cannot cause endless redelivery.
  - **RazorPay `payment.authorized` demoted** from `charge.succeeded` to `intent.authorized`. Under
    `payment_capture: 0` an authorization is a hold, and the map had long contradicted this file's
    own charge path ("Treating `authorized` as succeeded booked cash the gateway had not captured
    yet"). Settlement still arrives via `payment.captured` / `order.paid`.

- **2026-08-10** — **the flows actually consume intents.** This README claimed since 2026-07-06 that
  "the server consumes the authorized intent during create-subscription/collect"; it was never true
  — no caller existed outside the route, a dashboard tool and a test script. Now:
  - `POST …/subscriptions`, `POST …/invoices/:inv/{collect,retry}` and `POST /checkout/v1/complete`
    accept `payment_intent`. Create-subscription commits the invoice with `collect: false` and then
    settles it by consuming — an intent is consumed INTO an invoice, so the charge-first order had
    to invert. Every check runs before any write, so a bad intent leaves nothing behind.
  - **On-session vs off-session is declared, never inferred.** New `CollectionSession` parameter,
    defaulting to off-session. Only the hosted checkout (structurally — the buyer is on the page)
    and an explicit `on_session: true` set it; an operator pressing "Collect now" is not the buyer.
    On-session `requires_action` now mints an intent and returns its challenge, recording nothing —
    no failed payment, no dunning, no attempt-count bump. **Off-session dunning is byte-identical**:
    the branch is additive, above the existing code, and every existing caller omits the parameter.
  - Add-card via checkout / portal / operator API goes through `src/api/vault-setup.ts` → a `setup`
    intent, so each one becomes a visible row. Existing response fields are unchanged;
    `payment_intent` + `next_action` are additive.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-22** — **`customer_name` on the intent row is resolved, not the legacy column.** The
  projection already carried first/last for the Customer Information card but still passed
  `customers.name` through as the display name, so the list and the detail card were nameless for any
  customer created through the API. `toIntentRow` now resolves the name with `accountHolderName`, and
  the company joins the projection to complete that chain — a company-only buyer (a business with no
  named contact) rendered nameless without it. `customer_company` is deliberately NOT added to the wire:
  the name now covers the nameless case, and a new response field would need an openapi entry plus an
  SDK regeneration for a field no screen reads yet.
- **2026-09-01** — **the expiry sweep stopped voiding SETUP intents.** `finishSetupConsume` was
  cleaned of an unconditional `voidIntent` in 041e35cb (a `setup` intent is created with
  `amountMinor: 0n` on every adapter, so Stripe answered `400 setup_intent_unexpected_state` on
  every add-card); the SAME failing call survived in `releaseHoldBeforeExpiry`, which gated on
  `status === 'authorized'` alone. Status was the wrong test: `finishSetupConsume`'s catch path
  writes `authorized` on a setup intent DELIBERATELY, to record that the buyer's authorization
  existed, so a setup whose local persist failed and was never retried reached the hourly sweep
  and got cancelled at the gateway an hour later.

  Measured across the whole dev database before shipping: **no setup intent has ever reached
  `expired` with `authorized_at` set** — 512 expired setups, all `authorized_at IS NULL`, i.e.
  expired out of `in_progress` where the status guard already skipped them. So this is a latent
  path, not an observed one, which is why it is a guard plus a gate and not a data fix
  (`scripts/probe-zero-due-debits.ts` § B is the measurement).

  Answers `not_held`, never `unsupported`: an `unsupported` verdict raises the abandoned-buyer-funds
  WARN, and there are no funds. Gated by `verify:gateway` § **C7-REL**, which expires a payment
  intent and a setup intent side by side and asserts the payment still books exactly one
  `payment_reversal` while the setup books none — mutation-tested, and reverting the guard fails 3
  of its 6 assertions INCLUDING the reversal count, because tmtest really does void the zero-amount
  charge.

- **2026-09-03 — #23: `consumePaymentIntent` asks the gateway before refusing the buyer's own
  callback, and every refusal a payer can read is now written for a payer.**

  Measured 17:47 on a deliberate failure test (Pay now → cancel the subscription mid-checkout →
  complete the payment at RazorPay). A **successful** payment showed the buyer
  `"Intent is in_progress; complete the challenge first"`. State at that moment: intent
  `pi_XXXXXXXXXXXXXXXXXXXXXX02` (₹22,184.00, order `order_XXXXXXXXXXXX01`) still `in_progress`,
  `authorized_at` NULL, its attempt `requires_action`, **zero inbound webhooks since 17:15**. The
  buyer's browser posts leg 2 the moment the gateway's sheet closes; the gateway's `authorized`
  webhook is a separate, slower delivery. So arriving first is the ORDINARY case, and refusing on
  our own row told someone who had just paid to go and pay again.

  This is #15's root cause on a surface #15 did not cover, and it is fixed the same way, in the
  same file, on purpose — `confirmAuthorizationWithGateway` follows B1's three rules from
  `releaseHoldBeforeExpiry`: `fetchIntent` and `capabilities.intentStatus === true` are checked
  together; `authorized` is the only answer that means proceed (`unknown` is not an answer about
  money, `consumed` belongs to the charge path); and every failure returns null so a gateway's bad
  day becomes a sentence rather than a 500. Scoped to `purpose: 'payment'` — the setup consume in
  `vault-setup.ts` has the same theoretical staleness but its own ₹1–5 refund lifecycle, and
  widening it needs its own measurement (A1 scoped #17's guard for the same reason).

  When the poll says `authorized` the row is flipped through **`authorizePaymentIntent`** — the
  writer the inbound webhook uses — never a second local UPDATE. That is the whole lesson of
  #15/#17, and it is what carries the coalesced `authorized_at` stamp, the attempt reopen and the
  `payment_intent_authorized` event, so subscribers see the sequence they would have seen had the
  callback been on time. The gate asserts it by the stamp: mutating the flip to an inline UPDATE
  reddens exactly one assertion and nothing else.

  **Structural change:** the adapter is needed before the status check, and it used to be resolved
  *below* it inside the same `withTenant` block that CLAIMS the intent. Rather than add a second
  select, `loadIntentGateway` reads account + business mode + adapter **once** and never throws;
  `assertIntentGatewayUsable` does the refusing, in the order those refusals were already in. So
  hoisting the read reorders no error anyone (or any gate) has seen: a broken gateway account on a
  zero-due invoice still reports the invoice first, and an unresolvable adapter is rethrown
  verbatim at the point `resolveAdapter` used to be called.

  **Copy.** `customer-portal-routes.ts` maps every `PaymentIntentError` from this module to
  `badRequest(reply, e.message)`, so these sentences are read by buyers. Rules taken from B2's
  zero-due copy in that route rather than invented: no internal vocabulary; conditional phrasing
  where we cannot know whether they finished ("if you have just completed it" is true in both
  worlds); and claim only the MECHANISM — "returned to you automatically" is what
  `refundUnappliedExcess` does, whereas "we have refunded you" would be false when the sentence is
  written. `Intent already consumed` is deliberately **left alone**: `customer-portal-routes.ts`
  and `invoice-routes.ts` both match `/already consumed/i` to convert the webhook race into a
  SUCCESS, so a payer never reads it — rewording it would show a red error for captured money.

  `PaymentIntentError` gained an optional `code`, because `verify:gateway`'s
  `reviveConsumeError !== "Intent expired"` was one copy edit away from passing forever. It now
  keys on `intent_expired`. Assert on the code; show the message to the person.

  The poll returns a THREE-way verdict, not a boolean, and that was a correction found by
  re-reading the ask rather than by testing: the first implementation lumped a gateway answer of
  `consumed` in with "nothing is authorized", which would have told a person whose money had
  ALREADY been captured that we had not heard from their bank — the same confident falsehood as
  `complete the challenge first`, about money that had actually left their account. `consumed` is
  now its own verdict (`captured_at_gateway`), logged at WARN as the reconciliation gap it is
  (`intent_captured_at_gateway_unbooked`) and answered with "Your payment has reached us and is
  being applied to this invoice."

  Gated by `verify:customer-portal` § **#23** — 24 assertions driving the REAL second leg over
  HTTP as the buyer, because the string is the defect. Red first (11 failing, reproducing the
  production sentence verbatim), then mutation-tested in seven runs: removing the poll reddens A;
  reading `unknown` as authorized reddens C; accepting any gateway answer reddens B and C;
  restoring the old sentence reddens all five copy assertions; a second local writer reddens only
  the `authorized_at` assertion; the old settled-invoice string reddens D; and removing the
  `consumed` verdict reddens E on exactly the two assertions that catch the lie. Fixtures move our row
  and the gateway's row **separately** and never through `TmtestProvider.resolveChallenge`, which
  drives both and would erase the divergence that IS the defect (A1 lost a #17 fixture that way);
  `#23-A: authorized_at is NULL before leg 2` is the assertion that would announce it.
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-30** — `POST /payment_intents` exposes `gateway_account` (`gwa_…`), the existing `gatewayAccountId` pin: validated by `resolvePinnedAccount`, never ignored.
- **2026-10-16** — A capture the gateway holds (`ChargeResult.status: 'pending'` — PayPal
  `PENDING_REVIEW`, an eCheck hold) is booked as money in flight: a `pending` payment plus an
  `in_progress` transaction, the intent stays `consumed`, dunning is parked. It was booked as a
  failed capture, so the later `charge.succeeded` found a `failed` row and was ignored — buyer
  charged, invoice open, no ledger entry. `captureRefused()` is the one predicate for "the
  capture was refused" (anything but `succeeded`/`pending`); every consume caller uses it.
  Gates: `verify:checkout-purchase` (review) and `verify:customer-portal` (#review).
- **2026-10-24** — `applyClientResult` hands a `mode: 'sdk'` browser result to the adapter's
  `submitClientResult` and writes the outcome through the webhook writers (`authorized` →
  `authorizePaymentIntent`, refusal → `failPaymentIntentFromGateway`); a new gateway id is
  stored on the attempt. Already past the challenge → `past_challenge`, no gateway call; no
  `submitClientResult` → `client_result_unsupported`. `consumePaymentIntent(…, {clientResult})`
  applies it first and throws `PaymentIntentError(failure.code)` on a refusal. `client_result`
  is accepted by the consume, invoice collect/retry, portal Pay now, checkout complete and
  subscription create routes (checkout and subscription create apply it before their
  `authorized` check). `next_action` may now carry `sdk` / `formPost` (stored verbatim).
  Return/cancel URLs go through `gatewayReturnUrl`. Gate: `verify:gateway-sdk-modes`.
- **2026-11-01 (Tier 3 PR 2)** — Settling an invoice through a payment intent activates its pending credit grants (`activatePaidCreditGrants`).
- **2026-11-02** — An intent's `expires_at` (create and retry) is counted from `businessWallClock`, the clock `consumePaymentIntent` checks it against. Counted from the real clock, every intent in a business travelled past real time was expired at birth ("took too long to complete"). Gate: `verify:gateway` C7-TT.
- **2026-11-04** — `createPaymentIntent` books a refusal from the vault step (`ensureProviderCustomer`) exactly like a `createIntent` rejection: intent + failed `gateway_request_rejected` attempt, then rethrown; a `ProviderIndeterminateError` is rethrown with nothing booked. `assertIntentCurrency` (public route only) refuses a currency outside the business default, its currency list and the named invoice's or subscription's currency. `amount_minor` and `max_amount_minor` at most 10^12. tmtest credential `ensure_customer_fault` (`reject` / `indeterminate`). Gate: `verify:gateway` C63+ and PI currency.
