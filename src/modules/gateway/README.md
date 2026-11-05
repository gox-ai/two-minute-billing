# gateway — gateway accounts, router, inbound webhooks, request-log inspector

> Source: `src/modules/gateway/` · Routes: `src/api/gateway-routes.ts` · Schema: `db/schema/gateway.ts`
> Layer: payments (see docs/architecture/architecture.json)

## Purpose
The multi-tenant gateway layer: per-business gateway accounts with encrypted credentials, a router that
selects the right account by currency × payment-method type, and inbound provider-webhook ingestion +
reconciliation. Adapters are resolved from DB rows via `src/providers/registry.ts`, never imported directly.

## Responsibilities
- Gateway account CRUD (creds encrypted via `platform/secrets`), health-check (`verify`), default flag.
- Route a (business, currency, method type) to a gateway account; no silent fallback.
- Ingest inbound provider webhooks, dedup, reconcile (settle in-progress; late-failure reopens invoice).
- Serve the gateway-webhooks inspector.

## Data model
`db/schema/gateway.ts` — `gateway_accounts` (`gateway_key`, label, `livemode`, `credentials_enc`,
`currencies`, `method_types`, status) + inbound provider-event rows (payload, outcome, error). Livemode
must match the business's livemode; tmtest is the only gateway allowed on test businesses without real creds.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `selectGatewayAccount(tx, {businessId, currency, methodType, override?})` | router (no silent fallback) — **the** Smart Routing entry point |
| `getWebhookEndpointInfo` / `provisionWebhookEndpoint` (`webhook-endpoint.ts`) | per-account Notification URL + secret ownership |
| `ingestGatewayWebhook` | inbound normalize + dedup + reconcile; an errored event also queues our retry job |
| `storeGatewayWebhook` / `processStoredGatewayWebhook` | answer-first store + the `process_gateway_webhook` job (25 tries, ≈4 days) |
| `requeueStrandedGatewayWebhooks` | clock pass `gateway_webhook_retries`: queue the job for errored rows no job will reach |
| `listGatewayWebhooks` / `getGatewayWebhook` | inbound inspector |
| `listGatewayRequestLogs` / `getGatewayRequestLog` (`activity.ts`) | outbound gateway-activity inspector |
| `listGatewayCatalog` | the gateway catalogue (`GET /v1/gateways`), built from `providers/gateway-catalog.ts` |

(Account CRUD + verify handled in the route layer over the tenancy/registry.)

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/gateways` | the gateways an account can be created for: names, credential fields, methods, webhook-secret ownership |
| `POST/GET/PATCH/DELETE /v1/businesses/:biz/gateway_accounts[/:gwa]` | account CRUD |
| `POST .../gateway_accounts/:gwa/verify` | adapter health-check |
| `GET .../gateway_webhooks[/:id]` | inbound inspector |
| `GET .../gateway_requests[/:id]` | outbound gateway-activity inspector (`?gateway=&source=&limit=&before=`) |

## Events emitted
`gateway_account.created/updated/deleted`.

## Dependencies
- **Upstream (calls into):** events, webhooks.
- **Downstream (called by):** invoicing, payment-intents, tenancy.

## Invariants & gotchas
- Credentials are **encrypted at rest** (AES-256-GCM, `v1:` prefix) and never echoed in responses.
- **No silent fallback:** an unmapped currency/method raises rather than picking an arbitrary account;
  with >1 match, the business default resolves the tie.
- `gateway_accounts.livemode` must equal `business.livemode`; live businesses cannot hold tmtest accounts.
  Derived at create and re-checked at charge time in the router, `resolveChargeAdapter` and payment
  intents — the whole partition is gated by `pnpm verify:testlive`.
- **Our own webhook retry (Phase 6a).** A delivery whose handler errors answers 502 AND queues
  `process_gateway_webhook` (key `gwhook:<gateway>:<business>:<sha of ids>`, not while a job under
  that key is live), so recovery no longer depends on the gateway's retry schedule. Every re-run
  of an existing `provider_events` row (redelivery, job, GW-7 replay) holds the advisory lock
  `pe:<gateway>:<business>:<event>` and reads the outcome under it, so one event books once. The
  last failed try appends "We stopped the automatic retries…" to the row's `error` and logs
  `gateway_webhook_retries_exhausted`; the job stays exhausted in the queue (critical in the
  back-office error feed). The clock pass queues errored route rows (last 30 days, 5 min grace,
  50 per tick, oldest first) that no job names and that carry no exhausted note.
- `gateway_request_logs` writes are **fire-and-forget** — a logging failure must never fail a payment.
  The table is platform-global (no RLS; adapters run outside tenant transactions) and every read is
  org-guarded in the service layer. Secrets are redacted at capture time; never log raw PANs/keys.
- Calls routed via the legacy `getProvider(key)` env-singleton (some verify scripts) carry no
  business/gateway-account context → those log rows have null provenance. Production flows resolve
  via `resolveAdapter(gatewayAccountRow)`, which binds the ALS context. That singleton is built from
  `*_TEST_*` env vars only, so it is a **test-mode facility**: `resolveChargeAdapter` refuses it for a
  live business rather than charging a real customer against a sandbox.

## Webhook endpoint ownership

**tmbilling owns the webhook verification material — the operator is never asked for a signing
secret.** Implemented in `webhook-endpoint.ts`:

⚠️ **We self-register the endpoint via each adapter's API**, so there is nothing for the operator to
paste for Stripe or PayPal.

| Gateway | Mode | How the material is obtained |
|---|---|---|
| `stripe` | `self_provisioned` | Adapter calls `webhookEndpoints.create` → stores the `whsec_…` Stripe mints. Idempotent: an existing endpoint for the same URL is deleted + recreated (Stripe reveals a secret only at creation). |
| `paypal` | `self_provisioned` | Adapter creates the notification webhook → stores its `webhook_id` (PayPal verifies via API, no shared secret). Reuses an existing endpoint for the same URL. |
| `razorpay` | `self_provisioned`, falling back to `paste_required` | **We generate** the shared secret (at account creation), then register the endpoint carrying it via `POST /v1/webhooks` — RazorPay's merchant API *does* manage webhooks and accepts a caller-chosen secret. If registration fails the same secret is shown for pasting. |
| `gocardless` | `secret_in` | No endpoint API. The operator creates the endpoint in the GoCardless dashboard and pastes the secret GoCardless shows (`operator_pasted`). |
| `tmtest` | `not_applicable` | In-process; no external endpoint. |

RazorPay API shapes, all verified live 2026-07-27 (each is a 404/400 trap):
- `events` must be a **map** of name → 1. An array makes RazorPay read the array *indices* as event
  names ("Invalid event name: 1"). There is **no `*` wildcard** — every name is validated, so we
  subscribe to exactly what we consume.
- Update is **PUT** `/webhooks/:id`. PATCH and POST to that path are both 404. PUT needs the full
  object (`url` at minimum) — a partial body is rejected with "url: cannot be blank".
- There is **no DELETE** verb; `active: false` is the only removal, so we send `active: true` on
  provisioning to revive a disabled endpoint.
- Duplicate URLs are **accepted** — RazorPay will happily register the same URL twice and then
  double-deliver every event, so `provisionWebhookEndpoint` looks the URL up and updates in place.
- The URL's host is **resolved**, so a placeholder `WEBHOOK_BASE_URL` like `…example.invalid` is
  rejected outright. That's the main reason the paste fallback exists.

Mode is derived from stored state: a `webhook_endpoint_id` in the credentials blob means registration
succeeded.

The Notification URL carries the gateway account's public id so inbound events attribute to the
exact account. **One shape for every gateway:**

```
{WEBHOOK_BASE_URL}/v1/gateway_webhooks/<gateway>?id=<gwa_…>
```

**Simplified 2026-08-01 — the two older shapes are gone, not deprecated.** `?id=` resolves the
business through `acc.businessId`, so `/v1/gateway_webhooks/<gateway>/<biz>` carried a segment
`ingestGatewayWebhook` never read, and Stripe's separate `/v1/webhooks/stripe` was purely historical
(it delegated to the same ingest). Both routes, the `businessPublicId` fallback, and Stripe's
pre-gateway-accounts env-global branch (`STRIPE_WEBHOOK_SECRET`) were **deleted**, and the endpoints
already registered at Stripe/PayPal/RazorPay were migrated to the new URL first. Consequences worth
knowing:
- An inbound request with **no `?id=`** is now refused `404 gateway_account_not_specified` rather than
  guessing "the single active account of this key" — which silently picked one once a business had
  more than one account per gateway.
- Re-run `WEBHOOK_BASE_URL=… pnpm tsx scripts/setup-dev-gateways.ts` after changing the base URL; it
  re-registers (PayPal *adopts* a matching endpoint rather than duplicating).
- Deleting a gateway account removes its registration at the gateway (`removeWebhookEndpointOnDelete`,
  2026-10-25): only the one whose URL is this account's notification URL. RazorPay has **no
  DELETE**, so it is switched off (`PUT active:false`) and the operator deletes it. Never touch
  endpoints you did not register — the same sandbox gateway accounts may also serve other systems.

Requires **`WEBHOOK_BASE_URL`** = the public origin this API is reachable at. Locally that means a
tunnel (`stripe listen --forward-to …`, ngrok) — gateways cannot reach localhost. API surface:
`GET|POST /v1/businesses/:biz/gateway_accounts/:gwa/webhook_endpoint` (`?reveal=true` to include a
paste-required secret; `{force:true}` to re-register / rotate).

### Webhook freshness windows

A maximum age is enforced only on a delivery timestamp the gateway signs **per delivery attempt**,
never on the event time in the body: operators resend old events from the gateway's dashboard to
recover, and the per-event dedup (`provider_events`, unique on gateway + business + event id)
already stops a replayed delivery. A stale delivery is refused on the same path as a bad
signature (400, nothing stored). The dedup lasts forever: past `gateway_logs_days` the retention
sweep strips a row's `payload`, `headers`, `normalized` and `error` but keeps its key, type,
outcome and times. A stripped `error` row has no `normalized` left, so nothing re-runs it: not
the queue, not a replay, and not a gateway resend (the resend conflicts on the key and the stored
job skips a row with no `normalized`). Settle such an event by hand.

| Gateway | Signed per-attempt timestamp | Window |
|---|---|---|
| Stripe | yes, `t=` in `Stripe-Signature`, re-signed on every retry ([docs](https://docs.stripe.com/webhooks#preventing-replay-attacks)) | `STRIPE_WEBHOOK_TOLERANCE_S` = 300 s past; no future limit (only Stripe can sign one) |
| Cashfree | `x-webhook-timestamp` is signed; retries are not documented as re-signed | `CASHFREE_WEBHOOK_MAX_AGE_MS` = 6 h past, 5 min future |
| PayPal | `transmission_time` is signed; a retry or resend is not documented as re-signed ([webhooks](https://developer.paypal.com/api/rest/webhooks/), notifications v1 spec, read 2026-10-28) | none |
| CyberSource | `t=` in `v-c-signature` is signed; not documented as the signing time | none |
| Adyen, Authorize.net, Braintree, Checkout.com, GoCardless, Mollie, Razorpay, Square, PayU | no delivery timestamp is signed (only body fields, and Square's URL); a signed time in the body (Braintree `timestamp`, PayU `eventDate`) is the event's | none |

Tests: `stripe-webhook-freshness.test.ts`, `verify:cashfree`, conformance row
`S12.stale-signed-refused` (Stripe, Cashfree).

## Payment intents — capabilities and the inbound `intent.*` vocabulary

An intent is a buyer **authorization**, not a charge: money is HELD, and the engine redeems the hold
later with `consumeIntent`. Everything in this section exists because that distinction is the one a
webhook mapping is most tempted to blur.

### Per-gateway intent capabilities

| Gateway | `intents` | `intentPurposes` | `intentVoid` | The gateway object behind an intent |
|---|---|---|---|---|
| `stripe` | ✅ | `payment`, `setup` | ✅ `paymentIntents.cancel` | manual-capture PaymentIntent (`pi_…`) / SetupIntent (`seti_…`) |
| `paypal` | ✅ | `payment`, `setup` | ✅ authorization void | v2 checkout order (`intent: AUTHORIZE`) / vault setup-token |
| `razorpay` | ✅ | `payment`, `setup` | ⛔ **false** | order with `payment_capture: 0` / mandate registration order |
| `gocardless` | ✅ | `setup` only | ⛔ false (no holds) | Billing Request (`BRQ…`) completed on the hosted flow; consumed into a mandate (`MD…`) |
| `cashfree` | ✅ | `payment`, `setup` | ⛔ **false** | PG order (auto-captured) / ON_DEMAND subscription (`tms_…`) |
| `tmtest` | ✅ | `payment`, `setup` | ✅ (simulated) | in-process charge row of kind `intent` / `setup_intent` |

⚠️ **`intentVoid: false` on RazorPay is a real limitation, not a missing implementation.** RazorPay
has no "release the hold" call: an authorized payment is either **captured** or **left to lapse**. The
only API that would look like a void is a refund — and refunding a payment that never settled posts
real money movement for money we never took. So the adapter deliberately does **not** implement
`voidIntent`, `voidPaymentIntent` raises `PaymentIntentVoidUnsupportedError` naming the gateway, and
the UI hides the control rather than offering one that cannot work. A RazorPay intent nobody consumes
simply expires (our 1h TTL, then the gateway's own).

### The `intent.*` event vocabulary

`NormalizedProviderEvent['type']` carries six intent terms — `intent.authorized`, `intent.failed`,
`intent.voided`, `intent.setup_succeeded`, `intent.setup_failed`, `intent.requires_action` — and they
are **deliberately separate from every `charge.*` term**. Each money word would lie:

- `charge.succeeded` for an authorization ⇒ `reconcileChargeSucceeded` settles the transaction and
  **books cash for money still only on hold**;
- `charge.failed` for a void ⇒ reverses cash that was **never booked** and re-arms dunning on an
  invoice the merchant themselves stepped away from;
- `payment_method.updated` for a `setup_intent.*` ⇒ hands the automatic card-updater a **card-less
  payload**, blanking a stored instrument's brand/last4/expiry;
- `intent.failed` for a challenge ⇒ **fails an attempt the buyer can still complete**.
  `intent.requires_action` (added 2026-08-21) is the one that is *none* of the others: nothing is
  authorized, nothing failed, nothing was voided — the money is waiting on a person. It carries
  `actionType` and `actionDeadline`, and it exists because the requirement can arrive **after** our
  call returned (dynamic 3DS, an issuer soft-decline upgraded to a challenge, and the RBI pre-debit
  window). The synchronous half of that story is unchanged: `charge()` / `createIntent()` still return
  `status: 'requires_action'` with a `nextAction` when the challenge is known at call time.

Correlation is `providerIntentId` → `payment_intents.intent_at_gateway` (indexed by
`payment_intents_gateway_intent_idx`, migration **0173**). It is its own field, not a reuse of
`providerChargeId`, because **a RazorPay intent is keyed by the ORDER id while its payment webhook
carries a PAYMENT id** — correlating through the charge id would look up the wrong object, or nothing.
An authorized-but-unconsumed intent has no `transactions` row at all, which is why the charge-path
lookup on `id_at_gateway` can never reach one.

### Webhook map (what each gateway sends → what we call it)

| Gateway | Provider event | Normalized | `providerIntentId` |
|---|---|---|---|
| stripe | `payment_intent.amount_capturable_updated` | `intent.authorized` | the `pi_…` (also emitted as `providerChargeId` — after capture it *is* our `id_at_gateway`) |
| stripe | `payment_intent.canceled` | `intent.voided` | the `pi_…` |
| stripe | `setup_intent.succeeded` | `intent.setup_succeeded` | the `seti_…` (+ `providerPaymentMethodId`) |
| stripe | `setup_intent.setup_failed` | `intent.setup_failed` | the `seti_…` |
| stripe | `setup_intent.canceled` | `intent.voided` *(added 2026-08-21)* | the `seti_…` |
| stripe | `payment_intent.requires_action` | `intent.requires_action` *(added 2026-08-21)* | the `pi_…` (+ `providerChargeId`) |
| stripe | `setup_intent.requires_action` | `intent.requires_action` *(added 2026-08-21)* | the `seti_…` |
| stripe | `payment_intent.processing` **iff** `processing.card.customer_notification.approval_requested` | `intent.requires_action` *(added 2026-08-21)*, else dropped | the `pi_…` |
| stripe | `charge.expired` | `intent.voided` *(was `charge.failed`)* | `payment_intent` off the **Charge**, not `obj.id` |
| stripe | `payment_intent.succeeded` / `.payment_failed` | **unchanged** — `charge.succeeded` / `charge.failed` | — |
| paypal | `CHECKOUT.ORDER.APPROVED` | `intent.authorized` | `resource.id` (the order id) |
| paypal | `PAYMENT.AUTHORIZATION.CREATED` | `intent.authorized` | `supplementary_data.related_ids.order_id`, else the `up` link's tail |
| paypal | `PAYMENT.AUTHORIZATION.VOIDED` | `intent.voided` *(was `charge.failed`)* | same as above |
| paypal | `VAULT.PAYMENT-TOKEN.CREATED/UPDATED` | **unchanged** — `payment_method.updated` | — |
| razorpay | `payment.authorized` | `intent.authorized` *(promoted from `unknown`)* | `payload.order.entity.id`, else `payload.payment.entity.order_id` |
| razorpay | `payment.captured` / `order.paid` | **unchanged** — `charge.succeeded` | — |
| gocardless | `billing_requests.fulfilled` | `intent.setup_succeeded` (+ `providerPaymentMethodId` = mandate) | `links.billing_request` |
| gocardless | `billing_requests.cancelled` / `.failed` | `intent.setup_failed` | `links.billing_request` |
| tmtest | `intent.*` (synthetic) | verbatim | `data.provider_intent_id` |

Two demotions/promotions worth naming out loud:

- **`payment.authorized` (RazorPay) was `unknown`, and before that `charge.succeeded`.** The
  `charge.succeeded` mapping was wrong in the direction that costs money — it settled a payment on the
  strength of a hold, contradicting `charge()` in the same file, which has always refused to call
  `authorized` a success. It is now `intent.authorized`: the same fact, told to the object that can
  act on it. `payment.captured` / `order.paid` keep `charge.succeeded` — those genuinely carry
  settlement.
- **`PAYMENT.AUTHORIZATION.VOIDED` (PayPal) moved OFF `charge.failed`.** A released authorization is
  not a failed charge; no money ever moved, so failing a "charge" would drag the invoice back into
  dunning over a hold the merchant dropped on purpose.

Stripe's `payment_intent.succeeded` / `.payment_failed` stay money events **because of manual
capture**: under `capture_method: 'manual'` the success fires at CAPTURE time, which is exactly when
the money moves.

A third demotion, **2026-08-21**: **`charge.expired` (Stripe) moved OFF `charge.failed`** — the same
mistake as the PayPal one above, found by auditing Stripe's list against its own docs ("Occurs
whenever an uncaptured charge expires"). A lapsed hold is `intent.voided`. It is the one intent event
whose `data.object` is a **Charge**, so its intent id is `payment_intent`; reading `obj.id` would have
handed the engine a `ch_…` to look up in `intent_at_gateway` and matched nothing, silently.

And one **removal**: `invoice.payment_succeeded` / `invoice.payment_failed` were mapped onto
`charge.succeeded` / `charge.failed` and are now unmapped. The engine owns invoicing (locked decision
1) and never calls Stripe's Invoices API, so those events can only describe **someone else's**
objects — another system's, on a shared account mid-migration, which `enabled_events: ['*']` delivers
to us in full. Only id correlation stopped them being read as our money. Exactly the argument for dropping
RazorPay's `subscription.*` (INDIA-LAUNCH §4b): a safety net is not a design.

> ⚠️ `enabled_events: ['*']` is **not** literally every Stripe event. Types marked *Selection
> required* are, per Stripe's reference, "created only when at least one webhook is listening for
> it. A webhook set to listen to all events doesn't satisfy this requirement." Verified 2026-08-21,
> those are `issuing_authorization.request`, `identity.verification_session.redacted` and
> `reporting.report_type.updated` — none of which we consume, so the wildcard is correct today. It
> stops being correct the moment we need one, and the fix is to name it explicitly.

### Dispatch (`webhooks/inbound.ts` → payment-intents engine)

`handleProviderEvent` resolves the intent from `providerIntentId`, then acts on its **current
attempt** via the engine (`authorizePaymentIntent`, `failPaymentIntentFromGateway`,
`markPaymentIntentVoidedFromGateway`) — never with raw SQL, so attempt bookkeeping, tenant scoping and
the `payment_intent_*` events stay in one place. Replay/ordering rules:

- **An intent id we don't know is a no-op** (`ignored`), never a throw — the same rule the charge
  handlers apply to an unknown charge id. A provider CLI test event, or a delivery that beats our own
  `createIntent` write, must not answer non-2xx and put the gateway into an endless redelivery loop.
- Distinct events can say the same thing — PayPal sends **both** `CHECKOUT.ORDER.APPROVED` and
  `PAYMENT.AUTHORIZATION.CREATED` for one authorization — so each branch is state-guarded and answers
  `ignored` when the intent already is (or is past) the state the event announces.
- A callback whose intent id is **not the current attempt's** `id_at_gateway` is ignored:
  `retryPaymentIntent` opens a NEW gateway intent, and stale news from attempt N-1 must not authorize
  or fail attempt N.
- `intent.failed` fails the **attempt**, not the container: `payment_intents` has no `failed` status
  (0172), and "open intent whose latest attempt failed" is exactly the state `retryPaymentIntent`
  requires. Marking the container failed would make a recoverable 3DS decline look terminal.
- `intent.voided` does **not** call the gateway back (that is `voidPaymentIntent`, for a void *we*
  initiate) and books **no** `payment_reversal` transaction — otherwise a merchant-initiated void
  echoed back as a webhook would be double-counted.

## Recurring-charge matrix — what can actually renew

**The table that decides what we can sell.** Every cell measured against live sandboxes on
**2026-08-01** by charging a *vaulted* instrument **off-session** (no buyer present) — not by reading
capabilities, not by creating an order, not by registering a mandate. All three have repeatedly looked
like success while the money could not move.

| gateway | method | INR | USD | EUR | GBP | evidence |
|---|---|---|---|---|---|---|
| **Stripe** | card | ✅ | ✅ | ✅ | ✅ | `pi_1TzYuC…` / `…uE` / `…uG` / `…uH`, all `succeeded` **synchronously** |
| **Stripe** | ACH (`us_bank_account`) | ⛔ | ⛔ | ⛔ | ⛔ | SetupIntent refused: *"payment method type … is invalid"* — not enabled on this account |
| **Stripe** | SEPA (`sepa_debit`) | ⛔ | ⛔ | ⛔ | ⛔ | *"available to Stripe accounts in other regions"* — ours is `country=IN` |
| **PayPal** | card (vaulted) | ❌ | ✅ | ✅ | ✅ | `53294914G…` / `6KW20931K…` / `76K37237V…`; INR → `CURRENCY_NOT_SUPPORTED` |
| **PayPal** | wallet (billing agreement) | ❌ | ✅ | ? | ? | `verify:paypal-wallet` (15/15). USD only — EUR/GBP each need a separate browser approval |
| **RazorPay** | card — **domestic** | ✅ ≤₹15,000 | ⛔ | ⛔ | ⛔ | renewal proven; non-INR refused at *registration* (*"Currency is not supported"*). ⚠️ **ABOVE ₹15,000 it STALLS, it does not refuse** — ₹56,118 accepted then never captured — four runs, still `created` 30+ min on. See “Pro-priced INR” below |
| **RazorPay** | card — **international** | ❌ | ❌ | ❌ | ❌ | mandate registers + confirms, then every debit → `recurring_payment_not_enabled` (measured 2026-07-30). ⚠️ **Not re-measurable since 2026-08-19** — International Payments is live-only, so the test key 403s every international BIN; see operator ask 3 |
| **RazorPay** | UPI Autopay | ✅ | ⛔ | ⛔ | ⛔ | Registered → debited → settled by webhook. **At a PRO PRICE (2026-08-19):** ₹56,118 collected off-session (captures in 2–5 min). Ceiling is ₹1,00,000 on this MCC, *not* ₹15,000 |
| **RazorPay** | netbanking e-mandate | ✅ | ⛔ | ⛔ | ⛔ | **PROVEN 2026-08-13** (₹13,870) and **at a PRO PRICE 2026-08-19** — ₹56,118 off-session, captured in seconds. **The only rail that bills a Pro-priced INR plan.** Registration is an auth link — but it is *scriptable*, see below |
| **RazorPay** | wallet | ⛔ | ⛔ | ⛔ | ⛔ | **no recurring rail exists at RazorPay** — the adapter now refuses it (see below) |

✅ works · ❌ the provider refuses · ⛔ not possible on this rail/account · ⚠️ untested · ? not measured

### Pro-priced INR: which rail can actually bill ₹56,118 (measured 2026-08-19)

`pnpm verify:razorpay-pro-amounts` exists because every other RazorPay proof ran at ₹1–₹50, and every
ceiling that decides this question sits far above that. It runs Pro monthly (₹56,118) and Pro annual
(₹5,61,180) across all three rails × pay-now and auto-collect.

| | pay now | auto-collect |
|---|---|---|
| netbanking e-mandate | ✅ | ✅ **seconds** — the rail to use |
| UPI Autopay | ✅ | ✅ 2–5 min |
| card | ✅ any amount | ❌ **stalls at `created`** |

**The card rail's failure is the dangerous one.** `charge()` returns `pending` with a real correlatable
payment id, so the engine books a pending payment against the invoice — and the debit never captures.
That is the shape of a debit silently waiting for an AFA nobody will perform, and only the stale-pending
sweep resolves it. (2026-08-13 the same rule produced a clean
`card_mandate_current_cycle_allowed_debit_exceeds` refusal instead. A refusal we can classify; a hang we
cannot. Assume either.) **Consequence: route INR autopay above ₹15,000 to netbanking e-mandate.**

**⚠️ The ANNUAL price cannot be collected at all — and it is not a rail limit.** RazorPay refuses
₹5,61,180 at **order creation**: *"Amount exceeds maximum amount allowed."* This account's per-payment
maximum is **₹5,00,000** (measured by bisection). It is rail-blind, so card, UPI and netbanking all fail
identically and no mandate or retry works around it. New operator ask 7.

**A UPI mandate ceiling is CLAMPED to the rail cap — and that is correct, though late.** Ask for
₹5,61,180 on UPI and `createMandateOrder` sends ₹1,00,000 (NPCI's cap for this MCC). Do **not** "fix"
this by refusing: `deriveMandateCeiling` requests the next renewal's tax-inclusive total plus
`MANDATE_HEADROOM_BPS`, which can exceed the cap while the debit it must carry sits under it — refusing
would deny a UPI mandate to plans the rail can actually collect for. The cap is the best ceiling the rail
can carry. Since 2026-08-27 (headroom ×3 on a pre-tax price → 25% on the tax-inclusive total) the band
where the clamp bites starts around **₹67,800/month** at 18% GST rather than ~₹28,250.

It also fails safely: `vaultPaymentMethod` persists the ceiling read off the **token** (the clamped value,
not the request), and `mandateRefusal` in `invoicing/collection.ts` parks any debit above it with
`mandate_ceiling_exceeded`, non-retriable, without calling the gateway. `verify:razorpay-pro-amounts` sees
a raw `order_failed` instead only because it calls `adapter.charge()` directly and bypasses that guard.
The real cost is **timing** — a plan that genuinely outgrows the rail cap surfaces at the first renewal
rather than at registration. Open item.

**✅ `order_failed` is now mapped** (`gateway_limit_exceeded` → `park`, also in
`PARK_EVEN_IN_FIXED_MODE`). It is what RazorPay returns when the ACCOUNT per-payment maximum is exceeded —
which **nothing pre-flight can catch**, since the engine does not know that limit exists, so the debit
really reaches the gateway. Unmapped it took the liberal `retry` default and burned the dunning schedule.
Deliberately not folded into `mandate_ceiling_exceeded`: that one tells the customer to re-authorize at a
higher ceiling, which does nothing when the mandate is already fine and the *account* is the limit.

**Netbanking e-mandate registration is NOT browser-only.** `POST /payments/create/emandate` is 404, and
this README previously concluded that only a real browser could register one. It cannot: `POST
/payments/create/ajax` with `method: 'emandate'`, `auth_type: 'netbanking'` and the `bank_account[…]`
block, posted against the order the auth-link invoice wraps, reaches `recurring: true, status:
"confirmed"`. `scripts/lib/razorpay-checkout.ts` → `emandateRegister`. Two traps:

- **The test bank page has TWO verdict fields**, `success` and `emandate_success`, for its three buttons
  (Success · *"Payment successful but e-Mandate failed"* · Failure). Setting only `success` clicks the
  MIDDLE one: payment `captured`, real token id, token `recurring: false, status: "rejected", "Rejected
  by bank"`. The first debit then fails *"The bank_account field is required when method is emandate"* —
  which looks like an adapter bug and is not one.
- Test account details are load-bearing: an invented account number is accepted by the request and then
  rejected by the bank. Use RazorPay's documented `1112220041` / `HDFC0000053`.

**What this means commercially.** **Stripe is the only multi-currency recurring gateway we have** —
the same Indian account renews INR, USD, EUR *and* GBP. PayPal covers non-INR but **never** INR.
RazorPay is **INR-only for recurring** on both of its working rails. So non-INR subscriptions run on
Stripe or PayPal; INR subscriptions run on Stripe or RazorPay; only Stripe covers both ends alone.

Settlement timing differs and the engine must not assume otherwise: **Stripe card renewals settle
synchronously**, while **RazorPay card + UPI renewals return `pending`** and settle by webhook, and a
**PayPal capture can sit `PENDING_REVIEW`** (see the PayPal section — reading the *order* status
instead of the *capture* status is how we once booked cash for money PayPal had not released).

Three traps this table exists to stop anyone re-learning:
- **`wallet` had no rail and silently became a netbanking mandate.** `method_types: ['wallet']` fell
  through `initiateVaultSetup`'s `else` to `emandate`, so the buyer saw a bank screen and a bank token
  was vaulted while the stored type said wallet — the same silent-wrong-instrument bug the card branch
  was fixed for, surviving because wallets hit the fallback rather than a branch. Now refused with an
  actionable message, and removed from the dashboard's payment-methods picker.
- **Registration is not capability.** RazorPay international cards register mandates in every currency
  and can never be debited; that gap is invisible until you charge.
- **A provider-enforced limit can disappear.** RazorPay used to refuse non-INR on UPI Autopay; it now
  accepts and returns `pending`. We enforce the INR-only rails ourselves — see the changelog.

## Conformance suite

Every adapter is held to the shared scenarios in `verify:gateway-conformance`. Adding an adapter
means adding its fixture module: recipe in `scripts/conformance/README.md`; open gaps in
`src/providers/conformance/known-gaps.json`.

## Live sandbox validation

**Naming convention.** Suites that hit exactly one gateway are named for it —
`verify:<gateway>` (cheap smoke, runs inside `verify:all`, skips without creds),
`verify:<gateway>-live` (real money against the sandbox), `verify:<gateway>-tunnel` (the provider's
own servers delivering to us). Only genuinely multi-gateway suites keep a generic name
(`verify:gateway-live`, `verify:webhook-inbound`). Before this convention, Stripe's live and tunnel
suites were called `verify:engine-live` and `verify:webhook-tunnel`, which read as gateway-agnostic
and made Stripe look less covered than RazorPay; they are now `verify:stripe-live` and
`verify:stripe-tunnel` (renamed 2026-07-27, no behavior change).

`pnpm verify:gateway-live` exercises the real adapters against provider sandboxes (skips any gateway
whose `*_TEST_*` creds are absent, and refuses non-test keys). Covers Stripe
customer→vault→charge→refund→webhook-provision, plus RazorPay/PayPal connectivity + customer/order.

`pnpm verify:webhook-e2e` closes the **inbound** half. It provisions a real endpoint at Stripe to
obtain a genuine `whsec_`, makes a real charge + refund, then delivers webhook payloads signed with
**Stripe's own signing implementation** (`generateTestHeaderString`) to the real HTTP route. Run it
with `WEBHOOK_BASE_URL` set (any URL — the payloads are delivered directly, so the URL never has to
receive traffic):

```
WEBHOOK_BASE_URL=https://tmbilling-e2e.example.invalid pnpm verify:webhook-e2e
```

It proves: a Stripe-signed payload is accepted while a wrong-secret **and** a tampered payload are
rejected (400); `?id=gwa_…` attributes the event to the right business; every event is persisted to
`provider_events` with an outcome and replays dedupe; `charge.refunded` **reconciles and books** the
out-of-band refund against the payment; and the dispute lifecycle
(created → funds_withdrawn → closed/won) upserts and resolves against a real PaymentIntent id.

**Correlation gotcha:** both `applyRefund` and `handleDisputeEvent` correlate on the **`payments`**
table via `provider_charge_id` — a transaction row alone is not enough. Without a matching payment,
a refund webhook is (correctly) `ignored` as "not one of our charges" and a dispute is recorded
best-effort against the webhook's business.

`pnpm verify:stripe-tunnel` closes the **transport** leg — it proves Stripe's own servers reach us
and that the events they actually emit are verified, attributed and reconciled. Needs a public tunnel:

```
# terminal 1 — API on a free port
PORT=4444 pnpm tsx src/index.ts
# terminal 2 — expose it
ngrok http 4444
# terminal 3 — run against the tunnel origin
WEBHOOK_BASE_URL=https://<id>.ngrok-free.app pnpm verify:stripe-tunnel
```

It registers a real Stripe endpoint at that URL, makes a real charge, issues a **real refund**, then
polls `provider_events` until **Stripe delivers `charge.refunded` on its own** — asserting it verified,
attributed to the business, reconciled (`outcome=processed`) and **booked the refund**. It then charges
Stripe's self-disputing test token (`tok_createDispute`) and waits for the genuine `charge.dispute.*`
chain. The Stripe endpoint is deleted afterwards so the sandbox isn't left with a dead URL.
**Verified passing 2026-07-25** against a live ngrok tunnel (9/9).

Caveat: the API process must share the script's `DATABASE_URL` (default), since the assertions read
rows written by that process. Free ngrok URLs rotate on restart — re-run provisioning after a restart.

Still NOT covered, and why:
- **Stripe's async `in_progress → settled` transition**, which needs a method that settles
  asynchronously (ACH/SEPA). Card charges settle synchronously, so their
  `payment_intent.succeeded` webhook is correctly a no-op. Blocked on ACH/SEPA activation
  (ACH is US-only; the test account is Indian). *The transition itself is no longer unproven —
  RazorPay's UPI Autopay rail exercises it end-to-end; see `verify:razorpay-live` below.*
- ~~**PayPal wallet charges**~~ — no longer uncovered: `pnpm verify:paypal-wallet` (added 2026-07-31)
  drives the whole billing-agreement path through the engine and pauses for the single browser
  approval, which is the only step that genuinely cannot be scripted. See the PayPal section below.

### RazorPay off-session money path — `pnpm verify:razorpay-live`

The one rail whose **mandate can be registered from a script**, which makes RazorPay's whole
off-session path unattended-testable. 15/15 **verified passing 2026-07-27**:

`ensureCustomer` → UPI Autopay mandate → recurring token → `adapter.charge()` off-session →
poll until the debit captures at RazorPay → `normalizeWebhook` maps the settlement event back to our
charge id. Then `verify:webhook-inbound` proves the engine-side half (pending payment +
`in_progress` transaction → settled, cash booked).

Which mandate rail, and what each costs:

| Rail | Headless? | Notes |
|---|---|---|
| **UPI Autopay** (`methodTypes: ['upi']`) | ✅ yes | RazorPay auto-approves the `success@razorpay` test VPA, so `initiateUpiAutopayCollect` registers a mandate with no browser. **Debits are asynchronous.** |
| e-mandate / netbanking (default) | ❌ no | Needs RazorPay's embedded Checkout. `POST /payments/create/emandate` does **not exist** (404) — there is no server-side auth endpoint. |
| card recurring | ❌ blocked | Needs RazorPay to enable recurring-payments-on-cards per merchant. Without it a card token mints `recurring: false` and the charge is refused: *"the seller does not support recurring payments"*. |

Two shapes that cost real debugging time:
- `recurring: '1'` goes at the **top level** of `POST /payments/create/upi`. Putting it under
  `upi.type` instead is accepted, captures the auth amount, and silently mints **no token** — it reads
  as a mysteriously tokenless success.
- The UPI mandate auth order needs a **non-zero** amount ≥ ₹1 (e-mandate registers at 0);
  1 paise is rejected with *"Order amount less than minimum amount allowed"*.

### RazorPay subscriptions in any currency — the design

Rail choice is **derived from the subscription currency**, not left to the caller, because RazorPay's
rails disagree about which currencies they accept and picking wrong binds the buyer to a mandate their
renewals can never match:

> ⚠️ **Superseded 2026-08-12 for the unpinned INR row.** An INR mandate with no rail pinned is now
> **refused**, not defaulted to e-mandate — that made the least-proven rail the silent default for
> every INR subscription (its off-session debit has never been measured; see the ⚠️ in the recurring
> matrix above). The business pins one on the gateway account's `method_types`, which the dashboard
> already collects. When SEVERAL are permitted the order is UPI → card → netbanking, cheapest-risk
> first; see the comment in `selectRail`. Every other row below is unchanged.

| subscription currency | rail | why |
|---|---|---|
| **INR** | ~~e-mandate (netbanking)~~ **refused unless pinned** | see the note above |
| INR, if `methodTypes: ['upi']` | UPI Autopay | opt-in; ₹1 auth, async debits |
| INR, if `methodTypes: ['card']` | card | ₹1 auth; RBI AFA applies |
| **USD / EUR / any non-INR** | **card** | the only international rail RazorPay offers |
| non-INR + a domestic rail asked for | **refused** | *"The currency should be INR when method is upi"* |

`initiateVaultSetupForBusiness` resolves the currency **explicit → customer → business default** and
passes it to `initiateVaultSetup`, which registers the mandate order in that currency.

**Mandate ceiling is derived from the INVOICE, not from a price column and not from a constant.**
`deriveMandateCeiling` (in `subscriptions/estimate.ts` — it is a billing projection) takes the largest
`estimateRenewal().total_minor` across the customer's renewing subscriptions in that currency — tax
included, discounts applied — plus **25%** (`MANDATE_HEADROOM_BPS`). Two fallbacks, in order: the pre-tax
`largestRecurringDebit` proxy when no estimate can be produced, then 100,000 minor units (₹15,000 in INR)
when there is nothing to infer from at all. Never a *floor* over a real derivation: 100,000 means ₹1,000
as well as $1,000, and would ask a $49 subscriber to authorise $1,000.

It sizes from `total_minor` rather than `amount_due_minor` deliberately — `amount_due` is net of the
customer's credit balance, a one-off, so sizing against a credit-funded renewal gets the NEXT one refused.
The headroom is 25% (was ×3 before 2026-08-27) because the base figure now carries tax: the buyer sees this
number in the mandate modal and on their portal, and ×3 on top of a tax-inclusive total would read as
reserving three times the plan. What it cannot see is metered usage, which does not exist until the period
is rated; `mandateRefusal` stays the backstop there. Observed at 18% GST: ₹2,595 → ₹3,828 · ₹27,918 → ₹41,179.

The off-session charge needs no rail-specific code: `charge()` maps `captured → succeeded` and
everything else to `pending`, so a synchronous card debit books cash immediately while an async
UPI/e-mandate debit waits for `payment.captured` — which the inbound webhook path already settles.

**What is proven, and the line that matters (2026-07-30, `verify:razorpay-live` 58/58).**
Registration is not the capability — **being able to debit off-session is.** Split by the CARD'S
ORIGIN, not by currency:

| Mandate | Registers? | Off-session renewal? |
|---|---|---|
| **Domestic** (Indian-issued) card, INR | ✅ OTP challenge | ✅ accepted (`pending`, async capture) |
| **Domestic** card, USD/EUR | ❌ `Currency is not supported` | — |
| **International** card, INR / USD / EUR | ✅ 3DS, token reads `recurring: true`, `recurring_details.status: confirmed` | ❌ `recurring_payment_not_enabled` |
| **UPI Autopay**, INR | ✅ auto-approved test VPA | ✅ accepted |

⚠️ **Therefore non-INR SUBSCRIPTIONS are not possible on RazorPay today** — a non-INR mandate requires
an international card, and international cards cannot be debited off-session on this merchant
(operator ask 3). Non-INR **one-time** card payments are unaffected and proven: 5 published cards ×
INR/USD/EUR, domestic and international, including the OTP/3DS branch, each refunded through our
adapter.

> ⚠️ **2026-08-19 — the international HALF of the table above is no longer re-measurable in test, and
> the "proven" one-time claim is stale for the two INTERNATIONAL cards.** International Payments is
> enabled on the **LIVE** account but **not** on the test key (confirmed by the account owner in the
> RazorPay dashboard). Consequences, measured the same day:
> - `/v1/preferences?key_id=rzp_test_…` has **no `methods.international`** — 35 other method keys are
>   present, so its absence is the account answering, not a parsing accident.
> - Every international BIN (`5104…0008`, `5104…5558`, `4012…1881`) gets an **edge 403 with an nginx
>   HTML page** at `/payments/create/ajax` — *including in INR*. Domestic BINs return 200 in the same
>   session, so it tracks the CARD, not currency, load, or our request shape.
> - The likely trigger is the **Re-KYC** the account completed in early August: international worked in
>   test on 2026-07-30, and capabilities are pulled during re-verification. It came back for live only.
>
> **What this does and does not change.** The 2026-07-30 measurements were taken while test
> international WAS enabled, so they remain valid history — non-INR subscriptions are still blocked, and
> Stripe remains the answer. What is gone is our ability to RE-PROVE it: three of the five one-time
> "proven" cards are international and currently cannot transact at all. **Do not re-measure this on the
> live key** — `verify:razorpay-live` refuses non-test keys by design, and this is not a question worth
> real money. Get test mode enabled (operator ask 3) and re-run.
>
> `verify:razorpay-live` now reports these as **INCONCLUSIVE / NOT MEASURED** rather than as failures,
> and will print a loud **FINDING CHANGED** if an international renewal ever succeeds.

Note the trap in that table: the international refusal is `recurring_payment_not_enabled` — the *same
text* an ineligible test card produces. It is only authoritative here because the card is RazorPay's
own subscriptions fixture, 3DS completed, the token is `confirmed`, and a domestic mandate takes a
renewal with the identical request shape.

> ⏱️ **A test-mode card token is only valid for 3 DAYS.** RazorPay: *"In test mode, you can perform a
> subsequent debit only within 3 days of token creation, as card tokens are valid for 3 days only."*
> So a card-rail renewal test that passed last week and "fails" today has probably just expired its
> token — re-register the mandate before concluding anything about the adapter. Does not apply to UPI
> Autopay, whose mandate carries its own `expire_at` (we register ~10 years out).
>
> **Use RazorPay's published test cards and nothing else** —
> https://razorpay.com/docs/payments/payments/test-card-details. `4111111111111111` is on none of
> their lists: it captures (flagged `international: true`, which is how the domestic path went
> untested for days) but is **ineligible for recurring**, and RazorPay reports that as
> `recurring_payment_not_enabled` — an error naming *merchant* configuration for a *card* problem.
> That cost this project a three-day phantom go-live blocker and a nearly-sent support ticket.
> Mandate-eligible fixtures live in `TEST_CARDS` in `scripts/verify-razorpay-live.ts`.

### ✅ SOLVED 2026-08-13 — netbanking e-mandate registers via an AUTH LINK, not Checkout

**The rail was never broken; we were reaching for the wrong authorization surface.** `initiateVaultSetup`
returns a Checkout descriptor (an order id to open in `checkout/embedded`) for all three rails. That is
right for card and UPI. For e-mandate, Checkout renders **"No payment methods available"** — it offers
no methods for this rail at all.

Ruled out one at a time, each against the live sandbox:

| attempt | result |
|---|---|
| `method=emandate`, no bank | no methods |
| `method=emandate` + `bank=HDFC` (one of the 59 the account supports) | no methods |
| same, with **₹1** instead of ₹0 (Checkout showed "Amount payable ₹1") | no methods — **so the amount was not the cause** |
| `POST /v1/subscription_registration/auth_links` | ✅ hosted page renders the real mandate form |

`GET /v1/methods` confirms the account is fully enabled: `recurring.emandate` lists **297 banks**, 59 of
them supporting the `netbanking` auth type. Nothing was misconfigured.

**What works, exactly:**

```
POST /v1/subscription_registration/auth_links
{ "customer": {...}, "type": "link",
  "amount": 0,                                  ← MUST be 0 for this rail
  "currency": "INR", "description": "...",
  "subscription_registration": {
    "method": "emandate", "auth_type": "netbanking",
    "max_amount": 2700000, "expire_at": <unix>,
    "bank_account": { "beneficiary_name": …, "account_number": …,
                      "account_type": "savings", "ifsc_code": … } },
  "receipt": "...", "expire_by": <unix> }
→ { id: "inv_…", status: "issued", short_url: "https://rzp.io/rzp/…" }
```

⚠️ **`amount: 0` is required here, and it is the opposite of the other two rails** (UPI needs ≥ ₹1, card
needs a ₹1 floor). A ₹1 auth link renders but **fails at Authenticate** — "Payment could not be
completed", with no payment created on the order, because ₹1 is a real debit the sandbox bank refuses.
₹0 is a pure mandate registration and succeeds.

⚠️ **`bank_account` should be supplied at creation.** Without it the buyer must type account number and
IFSC by hand; with it they only authenticate. Test values from RazorPay's own SDK docs:
`1121431121541121` / `HDFC0000001` / Gaurav Kumar / savings.

The buyer approves → `payment.method: emandate`, `status: captured`, amount 0 → the token is minted and
`recurring_details.status` is **`confirmed` immediately** in sandbox (no T+1 wait, contrary to the
HDFC/SBI guidance for production). `describeRazorpayToken` maps it to `bank_transfer` with the bank in
`brand`, and the off-session debit then behaves like any other rail.

**Shipped in the adapter 2026-08-13** (`verify:razorpay-emandate-live` **25/25**, registration *and*
off-session debit). `initiateVaultSetup` and `createIntent({purpose:'setup'})` branch on the rail:
netbanking calls `createEmandateAuthLink` and returns `mode: 'redirect'` + `approvalUrl`, which the
portal's add-card page already handles (it has branched on `redirect` for PayPal since day one — no UI
change was needed). `vaultPaymentMethod` accepts a third token shape, `inv_…`, and `consumeIntent`
branches on it too.

Two things that shape the code and are easy to get wrong:

- **The mandate config is on the ORDER the link wraps, not the invoice.** `GET /invoices/:id` returns
  status / amount / short_url / payment_id and nothing about the mandate; `token.method`,
  `auth_type`, `max_amount` and `currency` live on `order_id`. Asserting them on the invoice passes
  vacuously against `undefined`.
- **Charge the customer the TOKEN belongs to.** The link mints its own customer, so
  `vaultPaymentMethod` returns it in `providerCustomerId` and `persistVaultedPaymentMethod` adopts it
  — the same mechanism as the Stripe stale-SetupIntent path. Charging the caller's customer instead
  fails at the gateway with the unhelpful `NA — No db records found.`

Resume the suite from the link rather than a payment id — the un-resumed run prints it:
`RZP_EMANDATE_LINK=inv_… pnpm verify:razorpay-emandate-live`.

### ⚠️ MEASURED 2026-08-13 — the ₹15,000 ceiling is CARD/UPI only; netbanking clears it

**Read this before the section below, which measured only the card rail and was written too broadly.**

The ₹15,000 additional-factor threshold is a property of the **card** e-mandate framework (and NPCI's
UPI Autopay cap). **Netbanking e-mandate is not subject to it.** Measured against one mandate with a
₹1,70,145 ceiling, off-session, same account, same day:

| rail | debit | outcome |
|---|---|---|
⚠️ **The card rows below are a DIFFERENTIAL, not an absolute — read the caveat.**

Capture is not settlement. A card payment goes `created → authorized → captured`, and only then
**settles to the merchant's bank T+3** (observed: captured Sun 19:04, settlement processed Wed 09:00).
The engine books cash at CAPTURE, so the payout delay never touches payment or
invoice status and no `stale_pending` grace period refers to it.

**Open question, deliberately not closed here.** The operator reports that card capture itself can
take up to 3 days on this rail. If that is right, a large debit sitting in `created` may be *delayed*
rather than *blocked*, and the card row below would read "slow", not "gated". What keeps the row
meaningful is that it is a differential measured on ONE mandate on ONE day:

* ₹13,870 → **captured within minutes** (twice, on two different card mandates)
* ₹28,215 and ₹56,715 → **`created`, no `authorized_at` at all, hours later**

A uniform 3-day capture cannot explain the small debits capturing in minutes. But it *could* explain
the large ones eventually landing, so **"cannot be collected" is not proven — only "is not collected
promptly, while a smaller debit on the same mandate is."**

**To settle it, re-read these three days later** (they cost nothing to check): the ₹28,215 and
₹56,715 debits, and the ₹1,000 × 3 cycle probe. If the large pair captures, the
₹15,000 story for cards is wrong and this section needs rewriting. If they expire uncaptured while the
₹1,000 trio captures, it is confirmed.

⚠️ **The ₹1,000 × 3 probe is also unresolved for the same reason.** It exists to separate the RBI
AMOUNT rule from a per-cycle COUNT limit (our card mandates register `frequency: 'monthly'`, and the
error says "maximum allowed **debits** in current cycle"). All three were accepted rather than
refused, which argues against a hard count limit — a count limit should refuse #2 outright, the way
₹28,215 is refused — but none had captured when the run was stopped. **RazorPay documents neither the
error code nor the rule**, so this cannot be closed from docs either; add it to operator ask 6.

RazorPay names the card refusal explicitly once the debit is placed through the engine:
**`card_mandate_current_cycle_allowed_debit_exceeds`** — *"Maximum allowed debits in current cycle
exceeded"*. Since 2026-09-03 it maps to its **own** code, `mandate_cycle_limit_exceeded`, and no
longer shares `mandate_ceiling_exceeded` with our per-charge pre-flight (defect #14).

**What is now settled, and what is not.** The open question above — amount rule or count rule — is
still not fully answered, but one half of it IS, measured on one card
mandate (max **₹37,657.34**):

| when | amount | outcome |
|---|---|---|
| 31-Aug 16:17 | ₹32,943.24 | **succeeded** |
| 31-Aug 17:59 | ₹33,276.00 | `afa_not_completed` |
| 31-Aug 18:01 | ₹33,276.00 | **succeeded** — same amount, once AFA was completed |
| 02-Sep 20:29 | ₹2,787.79 | **succeeded** |
| 03-Sep 11:50 | ₹22,184.00 | **refused**, "Maximum allowed debits in current cycle exceeded" |
| 03-Sep 12:56 | ₹22,184.00 | **refused**, same words |

₹22,184.00 was refused while ₹33,276.00 had already gone through on the same mandate, comfortably
inside its ceiling. So it is **not an amount rule of any kind** — not the mandate limit, and not "a
debit over ₹15,000 cannot be taken", since two such debits succeeded here. The earlier reading in
`test/unit/mandate.test.ts` ("no retry interval makes ₹28,215 fit under ₹15,000") is therefore wrong
and has been replaced. A count limit reached after three debits in the cycle is the best remaining
fit, but **RazorPay still documents neither the code nor the rule**, so that is a fit and not a fact —
keep it on operator ask 6.

The REMEDY follows regardless of which it is, which is why the split could ship without closing the
question: it is not a bigger mandate and not AFA, so smart dunning **parks** it (`decline-policy.ts`,
in `PARK` and in `PARK_EVEN_IN_FIXED_MODE`) rather than retrying inside a cycle where nothing can
succeed. The code is `retriable: true` — the instrument is fine and a later debit works — and the
subscription must not be cancelled for it. (A raw-API debit instead sits silently in `created` — same
rule, less helpful surface.)

Every cell below is MEASURED — one mandate per rail, a ₹13,870 control on each so the debit amount is
the only variable:

| rail | ₹13,870 (control) | ₹28,215 (Pro) | ₹56,715 (Business) |
|---|---|---|---|
| **card** (ceiling ₹1,70,145) | captured | **`created`, still uncaptured >1h** | **`created`, still uncaptured >1h** |
| **UPI Autopay** (ceiling ₹84,645) | captured ~180s | **captured ~180s** | **captured ~180s** |
| **netbanking** (ceiling ₹1,70,145) | captured | **captured ~20s** | **captured ~20s** |

**Only the CARD rail is gated.** UPI Autopay and netbanking both carry the full price list.

| plan | INR/month | card | UPI | netbanking |
|---|---|---|---|---|
| `platform-lite-v202607` | ₹9,215 | ✅ | ✅ | ✅ |
| `platform-pro-v202607` | ₹28,215 | ❌ AFA | ✅ | ✅ |
| `platform-business-v202607` | ₹56,715 | ❌ AFA | ✅ | ✅ |

⚠️ **The UPI row contradicts NPCI's published ₹15,000 cap for general-category Autopay, and was
briefly written here as a ❌ on the strength of that document before anyone charged it.** Measurement
won, but treat it as a *sandbox* result: RazorPay's test mode clearly models the AFA gate for cards
(it is the whole reason the card row stalls) yet let both high-value UPI debits through, which may
mean it does not simulate the NPCI cap rather than that the cap does not apply. **Confirm on the live
account before pricing around it** — folded into operator ask 6.

This makes the netbanking adapter work (auth-link authorization, above) the highest-value item for the
India rollout rather than a completeness nicety: it is the only rail that can sell Pro and Business.

### ⚠️ MEASURED 2026-08-13 — a debit above ₹15,000 does NOT auto-capture (CARD rail)

**The single most important number for the India rollout, and it is not a mandate limit.**

RBI's e-mandate framework lets an instrument be debited without re-authentication only up to
**₹15,000**. That is a limit on the DEBIT, not on the mandate: RazorPay happily registers a card
mandate at ₹1,70,145 (cap is ₹10,00,000; UPI's is ₹1,00,000). Registering a bigger mandate does not
buy a bigger unattended debit.

Measured on the custom recurring API (`POST /payments/create/recurring`), same account, same
published domestic subscriptions card, same day:

| debit | amount | mandate ceiling | gateway outcome |
|---|---|---|---|
| Platform Pro | ₹28,215 | ₹84,645 | **`created`** — still uncaptured after ~25 min |
| Platform Business | ₹56,715 | ₹1,70,145 | **`created`** — still uncaptured |
| **control** | ₹13,870 | ₹84,645 | **`captured`** |
| card | ₹13,870 | ₹15,000 | `captured` |
| UPI Autopay | ₹13,870 | ₹15,000 | `captured` |

The **control is the point**: the same mandate that cannot take ₹28,215 takes ₹13,870 minutes later.
The variable is the debit crossing ₹15,000 — not the ceiling, not the card, not the account. A
high-value debit is *accepted* (a payment is created, no error) and then parks awaiting the buyer's
additional-factor authentication, which is exactly what the RBI framework describes.

**Commercially, on a v202607 price list:**

| plan | INR/month | auto-renews on an Indian mandate? |
|---|---|---|
| `platform-lite-v202607` | ₹9,215 | ✅ yes (+₹4,655/destination still fits: ₹13,870) |
| `platform-pro-v202607` | ₹28,215 | ❌ every renewal needs buyer authentication |
| `platform-business-v202607` | ₹56,715 | ❌ every renewal needs buyer authentication |

No amount of engine work changes this — it is the rail. The options are commercial: bill those tiers
annually on a rail that permits it, put them on a non-Indian instrument (Stripe card), or accept a
per-debit authentication step. **The engine already behaves correctly**: such a debit is booked
`pending` + `in_progress` (not a failure), so dunning does not retry it and no instrument is blamed.
What is missing is telling the CUSTOMER to authenticate — see operator ask 6, which this measurement
turns from a documentation question into a product one.

### Operator asks — RazorPay (send to RazorPay support before go-live)

Evidence gathered 2026-07-27, revised 2026-07-30, against test key `rzp_test_T3sPGWlObQqF9Q`.
**Ask 2 is the one that blocks subscription billing.**

| # | Ask | Blocks | Evidence |
|---|---|---|---|
| ~~1~~ | ~~Enable **recurring payments on cards**~~ **NARROWED 2026-07-30 — send ask 3 instead** | nothing for INR | Domestic-card mandates register and take renewals fine; the blanket refusal we recorded came from an ineligible test card. What remains is international-card recurring → ask 3. |
| ~~2~~ | ~~**NPCI pre-debit notification** obligation for UPI Autopay via the custom recurring API~~ **ANSWERED 2026-10-26 from RazorPay's docs** | nothing | RazorPay's UPI recurring docs ("Create subsequent payments"): RazorPay sends the pre-debit notice and, by default, debits 25 hours after it is delivered. We send no notice of our own |
| **3** | **Enable International Payments in TEST mode** — it is on for LIVE only. *Then* re-ask the recurring question below | **all non-INR subscriptions, and any re-measurement of them** | ⚠️ **Superseded 2026-08-19 — read the note under the table.** International Payments is enabled on the LIVE account but NOT on `rzp_test_…`: `/v1/preferences` for the test key has no `methods.international`, and every international BIN gets an edge **403** at `/payments/create/ajax`. The original finding (a confirmed international-card mandate refused on every off-session debit with `recurring_payment_not_enabled`, in INR *and* USD/EUR — card origin, not currency) was measured 2026-07-30 when test international WAS enabled. It stands as a historical measurement but **cannot be re-verified until test mode is enabled** |
| 4 | Confirm whether **S2S** is required for server-side card auth in production | our card mandate flow | `/payments/create/ajax` works in test |
| **7** | **Raise the account's MAXIMUM PAYMENT AMOUNT** — it is ₹5,00,000, below the annual Pro price | **every annual INR plan, on every rail** | measured 2026-08-19 by bisecting order creation. ₹5,61,180 is refused at `POST /orders` with *"Amount exceeds maximum amount allowed."* — before a rail is chosen, so card, UPI and netbanking fail identically and no mandate or retry avoids it. Per-merchant RazorPay setting, raised by support |
| **5** | **How do we CANCEL a recurring token?** An active mandate cannot be deleted. **2026-10-26:** RazorPay's UPI tokens doc now documents `PUT /customers/:c/tokens/:t/cancel` (initiated / confirmed / paused tokens; answers `cancellation_initiated`) — our 2026-07-31 probes used POST. Not built yet | deleting a payment source / GDPR erasure leaves a live, chargeable mandate at RazorPay | measured 2026-07-31 — see below. **Mitigated 2026-08-14**: the survivor is now recorded durably in the audit log as `customer.payment_method_orphaned_at_gateway`, with the gateway ids and the manual remedy, so an erasure leaves an actionable trail instead of a log line. It still does not let us cancel one |
| **6** | **What happens to a >₹15,000 debit on the CUSTOM recurring API?** Who sends the AFA link, how long is it valid, and how far ahead must we initiate | **any INR plan priced above ₹15,000** | RBI caps unauthenticated e-mandate debits at ₹15,000 on all three rails. RazorPay's published guidance ("the bank sends a pre-debit notification, then an AFA link valid 72h"; their *Subscriptions* product initiates the debit 36h early) is written for **Subscriptions**, not for `POST /payments/create/recurring`, and their RBI page says "you do not need to make any integration changes" — which cannot be true for a custom integration that owns its own schedule (2026-08-12) |
| **7** | **Enable the UPI COLLECT flow** — the account reports `upi: { intent: true }` only | **any buyer-initiated UPI payment on the web** | `GET /v1/methods` (2026-08-14). Intent-only renders a QR and app deep-links; no VPA field, and nothing in test mode can scan the QR. The UPI *mandate* still collects fine off-session, so this bites only where the mandate cannot: an invoice above its ₹1,00,000 ceiling, and any "Pay now" a UPI customer presses |
| 8 | Confirm the **production netbanking bank list** | one-off netbanking payments by major-bank customers | `GET /v1/methods` lists 64 banks on the test key, and **HDFC, ICICI, SBI and Axis are all absent** (Canara / Federal / IDFC FIRST / Indusind / Yes Bank are present). The e-mandate list is a different, larger set (297 banks, 59 mandate-capable), which is why the HDFC fixture registers a mandate but cannot pay a one-off invoice |

Copy-pasteable:

> **3. Please enable recurring payments on INTERNATIONAL cards for this account.**
> Domestic-card mandates work end to end on this key: `POST /v1/orders` (`method: card`, `token:
> {max_amount, expire_at, frequency}`) → `POST /v1/payments/create/ajax` (`recurring=1`, test card
> **4718 6091 0820 4366**) → OTP → payment `captured`, token `recurring: true`,
> `recurring_details.status: confirmed` → `POST /v1/payments/create/recurring` **accepted**.
> With an international card (**5104 0155 5555 5558**, from your *Test Cards for Subscriptions*
> table) the mandate registers and confirms identically — 3DS completed, token
> `recurring_details.status: confirmed` — but every off-session debit is refused:
> ```json
> { "error": { "code": "BAD_REQUEST_ERROR", "step": "payment_initiation",
>   "reason": "recurring_payment_not_enabled", "source": "business",
>   "description": "Your payment was not successful as the seller does not support recurring payments." } }
> ```
> This happens in **INR as well as USD/EUR**, so it tracks the card's origin rather than the
> presentment currency. One-time international-card payments in INR/USD/EUR succeed on the same key
> (International Payments is enabled), and domestic-card recurring succeeds — so please confirm
> whether recurring on international cards can be enabled, and what agreement/activation it needs.
> Also please confirm whether the same applies on the **live** account.
>
> **7. Please enable the UPI COLLECT flow on this account.**
> `GET /v1/methods` reports `upi: { intent: true }` with no `collect`, so RazorPay Checkout offers only
> a QR — there is no "UPI ID" field for the buyer to type a VPA into, and a test-mode QR cannot be
> scanned. That makes a buyer-initiated UPI payment impossible on the web. UPI Autopay *mandates* are
> unaffected and collect normally off-session. Please confirm whether collect can be enabled, and
> whether the same restriction applies on the live account.
>
> **2. UPI Autopay pre-debit notification — what is our obligation on the custom recurring API?**
> NPCI requires the payer be notified ~24h before each Autopay debit. RazorPay sends this for the
> RazorPay Subscriptions product, but we use the custom recurring API
> (`POST /v1/payments/create/recurring`) and can find no notification endpoint —
> `/v1/tokens/:id/notifications`, `/v1/payments/:id/notify` and `/v1/notifications` all return 404.
> The sandbox debits happily without one. Please confirm: (a) is the notification raised by RazorPay
> automatically for custom-API recurring debits, (b) if not, which endpoint should we call and what
> lead time is enforced, or (c) must we move to RazorPay Subscriptions to be compliant?
>
> **3. International payments + international recurring.**
> In test mode we capture cards in USD and EUR with `international: true`, and refunds work. Please
> confirm (a) International Payments is enabled on our **live** account, (b) the currency list, (c)
> settlement — INR conversion vs multi-currency EEFC, and (d) crucially, whether **recurring/
> off-session** charges are permitted on international cards once ask 1 is enabled, or whether
> card-on-file renewals are restricted to domestic INR.
>
> **4. S2S enablement.** We drive card auth server-side via `POST /v1/payments/create/ajax`
> (`key_id` in the body). It works in test. Please confirm whether production requires S2S
> enablement or whether the embedded Checkout is mandatory for card mandates.
>
> **5. How do we cancel a recurring token from the API?**
> `DELETE /v1/customers/:cust/tokens/:token` on a confirmed UPI Autopay mandate is refused:
> ```json
> { "error": { "code": "BAD_REQUEST_ERROR", "reason": "invalid_request",
>   "description": "The token you're trying to delete is still active in our systems. Please ensure the token is cancelled before proceeding to delete the same." } }
> ```
> …but we can find no way to cancel it. All 404 `no Route matched`: `POST /v1/tokens/:t/cancel`,
> `POST /v1/customers/:c/tokens/:t/cancel`, `POST /v1/tokens/:t/status`,
> `POST /v1/customers/:c/tokens/:t/status`, `DELETE /v1/tokens/:t`, and
> `PATCH /v1/customers/:c/tokens/:t`. `PUT /v1/customers/:c/tokens/:t` exists and returns 200 on an
> empty body, but rejects both `status` and `recurring` with *"…is/are not required and should not be
> sent"*. Please confirm the supported way for a merchant to cancel a recurring token/mandate
> server-side — or confirm that it can only be revoked by the payer (UPI app) / from the dashboard.
>
> **6. How does a debit ABOVE ₹15,000 behave on the CUSTOM recurring API?**
> We call `POST /v1/payments/create/recurring` directly rather than using RazorPay Subscriptions,
> because our billing engine owns the schedule. RBI caps unauthenticated e-mandate debits at
> ₹15,000, and your Subscriptions documentation says the issuing bank sends a pre-debit notification
> followed by an AFA link valid 72 hours, with the debit initiated 36 hours ahead. Your RBI
> card-mandate page says "you do not need to make any integration changes at your end", which cannot
> be the whole story for a custom integration. Please confirm, **for the custom recurring API
> specifically**: (a) is the pre-debit notification and AFA link raised automatically by the issuing
> bank when we call `create/recurring`, or must the merchant trigger it; (b) how far ahead of the
> intended debit date must that call be made; (c) what does the payment entity look like while it
> waits for AFA — which `status`, for how long, and do we get a webhook on both outcomes; (d) does
> the same answer hold for UPI Autopay (UPI PIN re-entry above ₹15,000) and for netbanking
> e-mandate?

What each unblocks for us: **1** → card renewals (currently only UPI Autopay can renew, and it is
INR-only); **2** → legal clearance to run UPI Autopay in production at all; **3** → USD/EUR
subscription renewals rather than just one-time international payments; **5** → a payment-source
delete (and GDPR erasure) that actually stops the mandate instead of leaving it live at RazorPay;
**6** → whether an INR plan above ₹15,000 can renew at all without us building a lead-time step, and
how long the engine must tolerate a debit sitting pending (the per-rail grace periods in
`modules/payments/stale-pending.ts` are set from published figures, not measured ones).

### Deleting a vaulted instrument at the gateway (`deletePaymentMethod`)

`detachPaymentMethod` calls the adapter so a deleted payment source does not survive upstream — see
`src/modules/payment-methods/README.md` for the engine-side rules (best-effort, shared-token guard).
Per-gateway reality, all measured live 2026-07-31 (`pnpm verify:gateway-delete-live`, 11/11):

| gateway | call | proven outcome |
|---|---|---|
| **Stripe** | `POST /v1/payment_methods/:id/detach` | ✅ re-read shows `customer: null` — Stripe has no hard delete, detach IS the deletion (never chargeable or re-attachable again). Re-detach resolves. |
| **PayPal** | `DELETE /v3/vault/payment-tokens/:id` | ✅ re-read of a deleted token returns **204 with no body** — *not* 404, on the same endpoint/auth/id that returned 200 + a body moments earlier. So "gone" is "no token body", not a status code. Re-delete resolves. |
| **RazorPay** | `DELETE /v1/customers/:c/tokens/:t` | ⚠️ an **active mandate is refused** (operator ask 5 above) — the adapter raises an actionable error and the local row still goes. An unknown-but-well-formed id resolves (idempotent); a *malformed* id still throws (caller bug). Positive path asserted in `verify:razorpay-live` step 8. |

**Our delete is remote.** Removing a payment method also removes it at the gateway; there is no
local-only variant that drops our row and leaves the gateway's. The call is idempotent when the
source is already gone at the gateway.

**Echo webhooks are a safe no-op.** Deleting upstream makes the gateway send us
`payment_method.detached` (Stripe) / `token.cancelled` (RazorPay) / `VAULT.PAYMENT-TOKEN.*` (PayPal)
for a row we already removed. The lookup misses, so the delivery persists to `provider_events` with
`outcome=ignored` — no error, nothing to reconcile.

**Out-of-band detaches are handled (2026-08-19).** The same `payment_method.detached` event arriving
for a row we *still hold* means an operator deleted the card in the gateway's own dashboard. That
token can never be charged again, so `applyPaymentMethodDetached` marks the instrument **`invalid`** —
the same status a hard decline or a dead mandate applies, which is what takes it out of
`resolveChargeCandidates` and moves collection onto the customer's backup. Previously the row stayed
`valid` and stayed selectable, so the next renewal picked it, hard-declined, and armed dunning against
a customer who had done nothing wrong. The row is **not** deleted (a dead token is not a reason to lose
the instrument a payment was collected on) and the card display fields are left as they were. A repeat
detach of an already-`invalid` method emits nothing. Covered by `pnpm verify:card-updater` § B.
RazorPay's equivalent is `token.cancelled`, handled on the mandate path (`DEAD_MANDATE_STATUSES`).
Since **2026-08-21** Stripe reaches that same path too, via `mandate.updated`: `status: inactive`
normalizes to `cancelled`, so a revoked mandate marks the instrument `invalid` exactly as a RazorPay
revocation does. ⚠️ Only for a **multi-use** mandate — Stripe's `inactive` also means "previously
used", which on a `single_use` mandate is ordinary completion, and treating that as a revocation would
invalidate a perfectly good card. The adapter reports it as `spent`, which is not a dead status.

### PayPal — `pnpm verify:paypal-live` + `pnpm verify:paypal-tunnel`

**Verified passing 2026-07-27** (15/15 and 16/16). Until then no money had ever moved through
PayPal: `verify:paypal` only proved OAuth and that PayPal accepted our order *shape*.

**Why it stayed untested, and how it got unblocked.** PayPal's wallet vault
(`usage_type: MERCHANT`) requires the buyer to approve in a browser — not scriptable, so the leg
was written off as untestable. But a **card** setup token comes back `APPROVED` immediately, with
no approval step. In production that token is minted by PayPal's hosted fields **in the browser**
(the PAN never reaches us — locked decision #8 holds); the suites mint it directly with a published
test card to stand in for that single browser step, and everything after — exchange, charge,
refund, webhook — is the real production path.

Three adapter bugs, none of them visible without moving real money:
- **A vaulted card could not be charged at all.** `charge` hardcoded
  `payment_source: { paypal: { vault_id } }`, so a card vault id came back `422
  MISMATCHED_VAULT_ID_TO_PAYMENT_SOURCE`. It now dispatches on the method's own type.
- **Every vault was mislabelled `paypal`.** `vaultPaymentMethod` returned a hardcoded
  `display.type`, discarding the brand/last4/expiry PayPal returns — and since `charge` dispatches
  on that type, the mislabel was what made the card uncharageable in the first place.
- **Out-of-band refunds were silently dropped.** On `PAYMENT.CAPTURE.REFUNDED` the resource is the
  **refund**, so `resource.id` is a refund id; the capture id our payment is keyed on appears only
  in the `up` link (PayPal sends no `supplementary_data` here). We were sending the refund id as
  `providerChargeId`, so a refund issued in PayPal's dashboard verified, matched nothing, and landed
  `ignored` — money left PayPal and the ledger never learned. Now correlated, with the cumulative
  `total_refunded_amount` (Stripe's `amount_refunded` semantics).

⚠️ **A refund tmbilling issues itself correctly lands `ignored`** — `applyRefund` finds the existing
`refunds` row and declines to double-post. Only an **out-of-band** refund reconciles to `processed`,
which is why `verify:paypal-tunnel` refunds straight at PayPal rather than through `refundPayment`.
An engine-initiated refund would pass while correlation was completely broken.

**The two sandbox accounts are not equivalent** (measured 2026-07-27; sandbox behavior, confirm
against a real merchant account before relying on it):

| | card vault (headless) | wallet vault (approval) | INR |
|---|---|---|---|
| US business | ✅ | ✅ | — |
| India business | ❌ `403 NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE` | ✅ | ❌ `422 CURRENCY_NOT_SUPPORTED` |

So a PayPal **India** merchant cannot take INR at all (export-only — PayPal withdrew from domestic
Indian payments in 2021) and cannot vault cards, which leaves the buyer-approved **wallet billing
agreement** as the only route to off-session subscriptions there. `verify:paypal-live` asserts both
restrictions so we hear about it from a failing test if PayPal ever lifts them.

⚠️ **PayPal sandbox delivery is not reliable, and a non-delivery looks exactly like a rejection.**
Observed 2026-07-31: the suite passed 16/16, then the *same* suite on the *same* tunnel delivered
nothing within its 10-minute budget 40 minutes later. Diagnose it with the **ngrok inspector**
(`curl -s 127.0.0.1:4040/api/requests/http`) — because a transmission that fails verification is
deliberately *not* written to `provider_events`, "PayPal never sent it" and "PayPal sent it and we
rejected it" are indistinguishable from the DB alone. Zero inbound requests at the tunnel ⇒ PayPal
never sent it; requests with a 400 ⇒ our verification refused it. Note the suite **deletes its
endpoint on exit**, so a late delivery has nowhere to land — re-run rather than wait.

### PayPal wallet / billing agreement — `pnpm verify:paypal-wallet`

The route the two suites above deliberately skip. Both vault a **card** setup token, because a card
token returns `APPROVED` immediately; a **wallet** vault (`usage_type: MERCHANT`) needs the buyer to
approve the billing agreement in a browser, so it was written off as untestable. Everything *after*
the approval is scriptable — and that is the part worth trusting: **that a buyer-approved wallet can
be charged off-session with no buyer present.**

```
pnpm verify:paypal-wallet          # prints an approval URL, then waits
PAYPAL_APPROVAL_WAIT_MS=1200000 pnpm verify:paypal-wallet    # longer window
```

One human action: open the printed URL and approve as a PayPal **sandbox personal (buyer)** account
(Developer dashboard → Testing Tools → Sandbox Accounts). The suite polls
`GET /v3/vault/setup-tokens/:id` until PayPal flips it to `APPROVED`, then runs unattended:
engine vault → `billSubscriptionPeriod` → `collectInvoice` off-session → independent re-read of the
capture from PayPal → `refundPayment` → ledger assertions → **delete the billing agreement** (the only
suite that exercises `deletePaymentMethod` on a *wallet* token rather than a card).

**Verified passing 2026-07-31** (15/15). Its first run found a real correctness bug — see below.

⚠️ **A PayPal ORDER goes `COMPLETED` while its CAPTURE is still `PENDING`.** The wallet charge came
back with order status `COMPLETED` and capture `status: PENDING`, `status_details.reason:
PENDING_REVIEW` — PayPal had **not** released the money and could still `DENY` it. `charge` read only
the *order* status, so the engine marked the payment `succeeded` and **booked cash for money under
review**, leaving nothing for the webhook to settle. It now dispatches on the **capture's** status:
`COMPLETED` → succeeded, `PENDING` → **pending** (payment parked, transaction `in_progress`, settled
later by `PAYMENT.CAPTURE.COMPLETED` → `charge.succeeded` or `.DENIED` → `charge.failed`, both already
mapped inbound), `DECLINED`/`FAILED` → failed with a normalized code. Same async shape as RazorPay UPI
Autopay and Stripe ACH/SEPA.

Why it hid for so long: **card captures complete synchronously**, so `verify:paypal-live` and
`verify:paypal-tunnel` — which both vault *cards* — always saw `COMPLETED`. Only a wallet payment that
tripped review could expose it. The same lesson as the RazorPay rails above: proving one rail proves
nothing about another.

Three more gotchas encoded in it:
- **Assert the vault TYPE.** `charge` sends a wallet under `payment_source.paypal` and a card under
  `payment_source.card`; the wrong key is rejected `422 MISMATCHED_VAULT_ID_TO_PAYMENT_SOURCE`. A
  wallet silently typed as a card would be uncharageable — the exact bug found on 2026-07-27.
- **Never `JSON.parse` a PayPal vault read unguarded.** PayPal returns **bodiless** responses on some
  vault reads (204 on a deleted payment token; intermittently while polling an unapproved setup
  token). The first run of this suite aborted mid-poll on `JSON.parse('')`; a bodiless or non-200 read
  is now "no news", not a verdict, and the poll prints a status trace. That trace immediately earned
  its keep: a real run logged `PAYER_ACTION_REQUIRED×77, HTTP_503×1, APPROVED×1` — PayPal threw a
  transient 503 mid-poll and the run absorbed it instead of dying.
- **The approval is a HUMAN step, so make it resumable.** `PAYPAL_SETUP_TOKEN=<approved id>` skips the
  mint + wait and goes straight to the exchange — otherwise an approval that lands after the process
  exited is wasted (which is exactly what happened first time). It re-asserts `status=APPROVED` **and**
  `usage_type=MERCHANT`, so resuming with a card token can't be mistaken for proving the wallet path.
- **"Gone" is not one status code.** A deleted *wallet* token read back **404**, while deleted *card*
  tokens read back **204** the same day. Assert "no token body", never a specific code.

Why it matters beyond PayPal-US: a PayPal **India** merchant cannot vault cards at all
(`403 NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`), so the wallet billing agreement is the *only* off-session
route there — see the account matrix below.

### RazorPay transport — `pnpm verify:razorpay-tunnel`

The leg neither suite above covers: RazorPay's **own servers** reaching us, and the **engine**
settling on what they send. **Verified passing 2026-07-27** (16/16) over a live ngrok tunnel.

```
# terminal 1 — API (dev on :4000 is fine; it must share this script's DATABASE_URL)
pnpm dev
# terminal 2
ngrok http 4000
# terminal 3
WEBHOOK_BASE_URL=https://<id>.ngrok-free.app pnpm verify:razorpay-tunnel
```

It creates a gateway account with the real test credentials, **self-registers the endpoint at
RazorPay** pointed at the tunnel, mints a UPI Autopay mandate, then bills a subscription through the
real engine (`billSubscriptionPeriod` → `collectInvoice`) — asserting the async debit is parked
`pending` with a correlatable `pay_…` — and waits for RazorPay to deliver `payment.captured` on its
own, ending with payment → `succeeded`, transaction → `succeeded` + `settled_at`, and cash booked.

Two design points learned the hard way here:
- Transport is asserted on the **mandate's** events (`token.confirmed`, the ₹1 auth capture), which
  arrive within ~a minute, *separately* from the debit's settlement event. Otherwise a slow debit
  looks identical to broken delivery — which is exactly how the first run misreported itself.
- If the debit hasn't settled inside the wait budget, the endpoint is deliberately **left active**
  (with instructions) rather than torn down, since deactivating would kill the very delivery being
  waited for. The engine settles whenever the webhook lands, which is production behavior.

Running the **engine** path rather than the adapter alone is what caught the 40-char `receipt` cap —
`verify:razorpay-live` passes with a short hand-made idempotency key, while every real
`collectInvoice` key is ~68 chars and 400'd at order creation.

**NPCI pre-debit notification.** NPCI requires the payer be notified ~24h before each UPI Autopay
debit. RazorPay sends that notice itself on the recurring API and, by default, debits 25 hours after
it is delivered (UPI recurring docs, "Create subsequent payments"). That is why a UPI debit stays
`pending` for a day. The engine sends no notice of its own.

⚠️ **Sandbox flakiness to expect.** RazorPay's test mode intermittently answers refunds with a generic
`400 "invalid request sent"` for minutes at a time — observed alongside unrelated `500`s on token
minting, with the *same* payments refunding fine on retry. Do not read it as a missing account
capability (refunds are enabled and live-proven here). `verify:razorpay-live` reports a refund failure
as a warning, not a suite failure, for exactly this reason.

`pnpm verify:stripe-live` is the **engine-level** charge-and-refund proof (operational cutover item
#1) — not the adapter in isolation. It bills a real subscription via `billSubscriptionPeriod` →
`collectInvoice` against a live Stripe gateway account, then refunds via `refundPayment`, asserting:
invoice → `paid`; payment `succeeded` carrying a real `pi_…`; a `transaction` row bound to that gateway
account; ledger `dr cash / cr accounts_receivable` and its reversal (**cash nets to 0**); every ledger
transaction balances per currency; no pending payment left behind. It also re-reads the PaymentIntent
and refund **from Stripe** to confirm the amounts match. **Verified passing 2026-07-25** (19/19).

`pnpm verify:webhook-inbound` covers the **other two gateways**, which verify differently:

- **RazorPay** — `x-razorpay-signature` is `HMAC-SHA256(raw body, shared secret)`, and tmbilling
  *generates* that secret, so the test produces byte-identical signatures to RazorPay's. Full
  coverage, no tunnel: valid HMAC accepted; **wrong-secret and tampered body rejected (400)**;
  `refund.processed` reconciled **and booked**; replay deduped; **`payment.captured` settles an async
  UPI Autopay debit** (pending payment + `in_progress` transaction → succeeded/success with
  `settled_at`); dispute lifecycle (created → won) creates and resolves the dispute row with
  normalized amount/currency.
- **PayPal** — there is *no* shared secret; `normalizeWebhook` calls PayPal's
  `/v1/notifications/verify-webhook-signature`, which RSA-verifies against PayPal's cert. A forged
  payload therefore **cannot** be made to verify, so only the negative path is testable head-lessly —
  which is the security-critical half. The test provisions a real `webhook_id` (so the rejection is
  about the signature, not missing config) and asserts a forged transmission is **never 200**, returns
  400, and is **not written to `provider_events`**.
  For the PayPal **positive** path use `verify:paypal-tunnel` — PayPal's own servers deliver genuinely
  signed events to a tunnel, which verify, attribute and reconcile (re-confirmed 16/16 on 2026-07-31:
  `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED` → `outcome=processed`,
  `VAULT.PAYMENT-TOKEN.CREATED`). The webhook simulator (`POST /v1/notifications/simulate-event`) is
  **not** needed and was never used. What remains headless-only-negative is *this* suite, by necessity.

**Verified passing 2026-07-25** (18/18). This also promoted RazorPay's dispute mapping from
"defensive, never exercised" to actually tested.

Known live findings:
- **Indian Stripe accounts** require a customer **name + billing address** for cross-border charges
  (India-exports rule) — a charge without an address 400s.
- **ACH/SEPA must be activated per Stripe account** (ACH is US-only). The adapter maps the method
  types correctly, but an account that hasn't enabled them rejects the SetupIntent — the live script
  reports that as SKIP, not a failure.
- Off-session **PayPal charges need an interactive vault approval**, so they aren't head-less
  scriptable; validate them via the tunnel runbook above. **RazorPay is no longer in this bucket** —
  UPI Autopay is scriptable (see `verify:razorpay-live`); only its *card* rail needs the merchant flag.

## Changelog

- **2026-11-03** — `gateway_request_logs.span_id` (0496), written by `providers/http.ts` from the
  ambient span, and a `span_id` list filter. One tick trace holds many charges; the span is one charge.
- **2026-11-03** — `providerFetch` (11 gateways) and the Stripe SDK fetch never follow a redirect: a
  3xx throws as a transport failure with an UNKNOWN outcome, so credentials never reach another host.

- **2026-11-03** — `GET …/webhook_endpoint?reveal=true` needs `gateways:manage`. The shared secret authenticates inbound webhooks, so a `gateways:view` key could forge one. The dashboard already asked for `gateways:manage`.
- **2026-11-03** — Cashfree refuses a subscription refund under 1 unit before the call (Cashfree
  answers 400 "refundAmount : must be greater than or equal to 1"). USD/EUR charge, refund and
  failed renewal proven live with the sandbox's Simulate Payment API (branch
  `feat/cashfree-intl-subscriptions`).
- **2026-11-02** — **Mandate currency authority; audit fixes.** `mandateCurrencyAuthoritative`
  (capability + catalogue copy): Cashfree, PayU, GoCardless and tmtest list every method; RazorPay
  UPI and netbanking; Adyen and Mollie SEPA; Stripe and the rest none. RazorPay stores a card
  mandate's currency from its registration payment (`pay_…` vault, setup-intent consume) and
  leaves it unset when unknown, so a token event never writes INR on a card.
  `internationalCurrencies` is shared by the edit check and the migration. Cashfree INR pay now
  reads a phone without `+` as Indian again. The create form shows the international switch.
- **2026-11-02** — **International payments switch; Cashfree USD/EUR audit fixes.** A gateway
  whose catalogue entry has `internationalSwitch` (Razorpay, Cashfree) gives each account
  `international_enabled` (0480): off, `handlesCurrency` routes only the domestic currency, for
  setup and pay now. Accounts that existed before 0480 are backfilled on; new ones start off. The
  API and the dashboard expose it; a currency list naming another currency is refused while it
  is off. Cashfree: a mandate with no currency on record is INR; under 1 USD/EUR is refused
  locally; a foreign mandate phone without `+` takes the customer's country; an India-issued card
  on a USD/EUR mandate is refused and the mandate cancelled; mandate removal reads the rail from
  Cashfree (or the stored rail), never the display type; Cashfree's own debit notice counts for
  INR only (`gatewayNotifiesPayerCurrencies`).
- **2026-11-02** — **Cashfree card mandates in USD and EUR.** `intentCurrencies.setup` is INR,
  USD, EUR; USD and EUR are card only (`cashfreeMandateProblem`; `currencyBoundMethods` keeps UPI
  and eNACH on INR). The mandate's plan, ceiling, charge and subscription refund use its own
  currency; the ₹15,000 card/UPI cap stays INR only; a non-INR payer keeps a `+` phone. Mandate
  removal still cancels payments first; a card PENDING or any INITIALIZED payment left on a
  CANCELLED subscription is no longer reported as chargeable (Cashfree FAQ + support
  2026-11-02). Proven live through the engine (GATEWAY_BEHAVIOUR_NOTES §3.10).
- **2026-11-02** — **PayU notice rules by rail, from PayU's integration support (2026-11-02).**
  `ProviderCapabilities.preDebitNotice.byMethod` overrides the lead time and debits per notice for
  one rail; `preDebitRule(cap, method)` is the one reader (gate, reminders, notice updates; no rail
  = the longest lead). PayU: cards 24 h and one debit; UPI 25 h (a re-notice after the retries
  waits 25 h) and first try + three retries under one notice. A same-day retry reuses the notice
  (same invoice number, new txnid); a later day sends a new one. The engine now passes its own
  lead floor as `debitAt`, so a time-travelled notice names the right debit day. New rule
  `payu.message.amount_not_pre_debit` ("Recurring amount does not match pre-debit amount") →
  `gateway_request_rejected`. Rows `S1.upi-failed-debit-then-retry`, `S1.notice-lead-by-rail`,
  `S12.upi-mandate-webhook-uat-exception`.

- **2026-10-31** — **MGA follows ISO 4217 (2 decimals) in the engine too.** The engine table said 0
  (Stripe's view) while the dashboard stores ISO minor units, so emails, PDFs and Checkout.com,
  Adyen and Razorpay conversion read an MGA amount 100x too high. `currencyExponent("MGA")` is now 2
  on both sides; Stripe, which takes MGA in whole units, converts in `toStripeAmount` and refuses a
  fraction. MGA is back on the Stripe, Razorpay and Checkout.com currency lists. Test:
  `stripe-amount.test.ts`, `currency-exponent.test.ts`, `gateway-currencies.test.ts`.
- **2026-10-31** — **Each gateway has a currency list.** New catalogue fields `currencies` and
  `currencyConditions` (12 offered gateways; CyberSource and tmtest have none = any currency):
  the gateway's documented list less withdrawn ISO codes, sanctioned markets and codes the
  adapter cannot convert exactly (MGA everywhere; LAK on Braintree; HUF and TWD on Mollie). PayU =
  INR, Cashfree = the six order currencies. `assertGatewayCurrencies` refuses an account currency
  the gateway does not take on create/update ("We could not save the gateway account. <Gateway>
  does not take <CODES>. …"), keeping codes the account already holds. `handlesCurrency` now reads
  a null account list as "what the gateway takes", so the router, the storefront offers and
  `resolveDefaultAccountForBusiness` skip an open account for a currency off its gateway's list;
  an explicit account list is unchanged. `GET /v1/gateways` returns `currencies`; the dashboard
  picker offers business ∩ gateway currencies, and the help guides and the overview table render
  the lists (`gen:gateway-guides`, `<!-- generated:currencies -->`). Pinned by
  `test/unit/gateway-currencies.test.ts` and `gateway-account-currencies.test.ts`.

- **2026-10-31** — **Removing a Cashfree mandate cancels the payments raised on it.** Cancelling
  the subscription left its scheduled payments INITIALIZED (measured), so a removed mandate could
  still be debited. `deletePaymentMethod` lists the subscription's payments, cancels each one that
  is not SUCCESS, FAILED or CANCELLED (`.../payments/{pid}/manage` CANCEL), cancels the
  subscription, then checks again. A payment that stays live, or a list that cannot be read,
  throws, so `detachPaymentMethod` records the mandate as still chargeable instead of dropping
  it. Rows `S10.mandate-cancel-cancels-queued-debits` and
  `S10.mandate-cancel-uncancellable-debit-is-recorded`; proven live in the sandbox.
- **2026-10-30** — **Cashfree pay now in USD, EUR, GBP, AED and JPY; mandates stay INR.**
  `capabilities.currencies` = the order currencies (`CASHFREE_ORDER_EXPONENTS`: JPY 0 decimals,
  the rest 2). Amounts go through `cashfreeAmount` / `cashfreeMinor` (exponent-aware; an amount
  with more decimals than its currency reads as unknown, since Cashfree does not check refund
  decimals). An order under 1 whole unit, or in another currency (KWD and BHD are not enabled),
  is refused before any call. The captured amount comes from the ORDER (`PAYMENT_SUCCESS_WEBHOOK`
  `data.order`), never the payment: an Indian card on a 1 USD order pays 95.16 INR. Order refunds
  are taken in the order currency; a refund in another currency is refused; the default full
  refund is the order amount less refunds not failed. Non-INR orders accept an international
  phone (`+<8–15 digits>`). New catalogue field `intentCurrencies` (Cashfree: `setup` INR,
  `payment` the six): `gatewayAllowsPurpose(key, purpose, currency)` drops the gateway in the
  router and in `listVaultGatewaysForBusiness`, and `effectiveMethodTypes` offers nothing for a
  currency the purpose does not take — so USD pay now offers Cashfree cards and a USD mandate
  never routes to Cashfree. Card is no longer in Cashfree's `currencyBoundMethods`. Measured
  facts: `docs/references/GATEWAY_BEHAVIOUR_NOTES.md` §3.10.
  Independent-audit fixes: disputes are booked in the order currency (`disputeMoney`: a blank
  currency takes the order's; a dispute in the payment's currency on a converted payment is
  scaled to the order; any other mismatch is `unresolved`). An order refund event always carries
  its running total or is `unresolved`, because the engine books a full refund when the total is
  absent (order or list unreadable, too many decimals, a refund in another currency).
  `cashfreeOrderPhone`: a `+` number outside India keeps its country code on any order.
  Live-proof fixes: `cashfreeRemarks` (Cashfree takes letters, digits, `.`, `-`, `_` only in
  `payment_remarks`; every mandate charge with a description was refused); `parseCashfreeJson`
  keeps ids above 2^53 exact; a paid order maps to `intent.authorized` (`captureState:
  succeeded`), so the engine books it through the intent with its method. Checkout: the
  gateway offer and `beginVaultSetup` use the session's currency (`resolveSessionCurrency`),
  and a pinned gateway that cannot save in that currency is refused by name (400).
- **2026-10-30** — **PayU UPI: audit fixes (still `live-proof-pending`).** Contract:
  `preDebitNotice.oneOpenPerMandate`, `withdrawPreDebitNotice`, `capabilities.mandateCeilingCapMinor`
  (+ `GatewayDefinition.mandateCeilingCapMinor`), `notifyUpcomingDebit` `failure.final`. PayU: UPI
  notices withdrawn with `action: Delete`; E9254/E9256 → `pre_debit_cycle_open`, E9263 →
  `pre_debit_not_due`, E9260 / bad mandateSeqNo → `gateway_request_rejected`; `status: "QC"` is
  final; UPI first payment above ₹15,000 refused; NPCI hours kept out of `executableAfter` + 30 min
  and refused live in `charge()`; mandate webhook ids carry status and pause dates, receipt time
  orders them, `key` optional. GATEWAY_BEHAVIOUR_NOTES §11.18. Rows S1.upi-amount-changed-after-notice,
  S1.upi-notice-expired-unused, S1.upi-failed-debit-then-retry, S1.upi-two-debits-one-cycle,
  S1.upi-notice-qc-revoked, S3.upi-first-charge-over-15000, S12.upi-pause-resume-pause.
- **2026-10-30** — **PayU UPI Autopay (UPI SI).** `payu.upi` leaves `live-proof-pending` (net
  banking stays) — reverted by the audit entry above until the live re-proof. Adapter: signed UPI mandate webhooks (JSON or form, hash
  `status|action|authpayuid|dateTime|amount|endDate|salt`) book `payment_method.mandate_updated`
  (`pause` → paused, `revoked` → cancelled); `setupCollectsFirstCharge` lists `upi`; decline rule
  `payu.message.mandate_already_revoked` ("Mandate is already revoked" → `mandate_expired`).
  Live proof on the test MID: first payment at registration, notice for the exact amount, debit
  `in progress` then settled by webhook, revoke → refused notice → payment method invalid
  (GATEWAY_BEHAVIOUR_NOTES §11.18). Conformance rows S1.upi-debit-pending-then-settled,
  S12.upi-mandate-forged, S13.upi-mandate-form-post; `verify:payu` H2.

- **2026-10-30** — **A gateway account routes only its business's currencies.**
  `assertBusinessCurrencies` (service): create and update refuse a currency that is neither the
  business default nor in its currency list, naming it. A business with no list allows any
  currency; a code the account already holds is kept, so an older account still saves. The
  dashboard's currency field offers only the business's currencies (`businessCurrencyOptions`).
- **2026-10-30** — **PayU cards to the release gate (steps 1–3).** Research in
  `docs/references/GATEWAY_BEHAVIOUR_NOTES.md` §11. Adapter (`providers/payu.ts`): a card or UPI
  debit without a pre-debit notice is refused before `si_transaction`; an answer with no
  `details` is a failure only when a decline rule names it (`Invalid Hash.`), else
  `ProviderIndeterminateError` with the txnid stranded; HTTP 408/409/425/429/5xx are
  indeterminate; a lost debit answer is re-read once by txnid; a failed pre-check read no longer
  stops the debit; `locateCharge` reads the
  key-made txnid; the ₹1 registration is reported as `setupAuthCharge` (PayU: the merchant
  refunds it); a refund PayU refused and does not list is a `ProviderRefusalError` (also
  `error_code` 226, which answers status 1 and queues nothing); REJECTED refunds are failed;
  refund posts check the merchant key, carry every listed refund as `refunds` (a token-less
  dashboard refund is keyed `rq<request id>`), and are `unresolved` when PayU cannot be asked;
  `autoRefund` is a late reversal; payment posts carry `amountMinor`; an email over 50 characters
  is left out of the debit; the health check names the fix. Catalogue: `lateCaptureAfterFailure`,
  menu label "Developer". Conformance fixtures `scripts/conformance/fixtures/payu.ts` (the
  `pending` exclusion is gone); the harness collects a notice-gated bill after its lead time.
  Every PayU method is in `live-proof-pending.json` (card until step 4; UPI AutoPay is not enabled
  on the test account; net banking is not proven), and `gatewayOffered` is now false for a
  gateway whose every method is pending. Engine: a signup's first charge on a notice rail
  (decided 2026-10-24) is not taken at once: `chargeBeforeSubscriptionInvoice` answers `deferred`,
  buyer present or not, and the invoice is committed and collected through `preDebitGate`; a
  reactivation is refused (`pre_debit_notice_required`). Live proof (2026-10-30) fixes: a notice
  `Retrieve` carries `requestId` (PayU refuses it without); a notice or debit refused because the
  mandate is not active / "not enrolled for SI" is `mandate_expired`, not retriable.
  **The registration pays the first invoice** (user decision 2026-10-30; design in
  `docs/references/GATEWAY_BEHAVIOUR_NOTES.md` §11.14): capability `setupCollectsFirstCharge`
  (PayU: card), `CreateIntentInput.firstChargeMinor`, `payment_intents.first_charge_minor`
  (0403). A create-mode checkout's setup intent carries the amount due; PayU registers for that
  amount (udf3 `tmfirst`, ceiling ≥ it) and reports it as `setupAuthCharge.firstCharge`; the
  checkout completion (buyer or webhook, one claim) books it as the first invoice's payment, and
  the setup refund job waits 2 h and stands down when it finds the charge booked. A registration
  PayU paid without a mandate (E755) is refunded at once. tmtest: `setup_first_charge=card`.
  Notice rails: `preDebitGate` keeps a final notice refusal's class (non-retriable,
  `mandate_expired`), so the instrument leaves collection, and sends no more notices to an
  invalid instrument whose last notice was refused. Gates: `verify:payu`,
  `verify:pre-debit-notices` (i, d2), `verify:checkout` (first charge).
  Independent audit fixes (GATEWAY_BEHAVIOUR_NOTES §11.16): first-charge claim shared with the
  setup refund (`payment_intents.first_charge_claim`, `setupChargeState`); unmandated
  registration refunded through `refund_setup_auth`; setup refunds watched to a final state and
  re-issued on FAILURE; PayU refund pending codes and a one-day grace for an unlisted refund
  (`fetchRefundStatus.requestedAt`); notice refusals confirmed with `fetchMandate` (paused →
  parked, revived by the sweep); no debit after a failed `verify_payment`; long emails refused.
  Conformance rows S1.notice-refusal-paused-then-resumed, S3.first-charge-refunded-then-completed,
  S4.unmandated-registration-refund-durable, S4.setup-refund-failure-retried,
  S4.refund-absent-grace, S7.retry-prior-read-fails, S8.refund-226-pending.
  Setup guide `docs-site/…/12.payu.md` (nine H2s, Permissions table, test-mode screenshots
  `payu-api-keys.webp`, `payu-webhooks.webp`); the card method hint names the 48-hour notice; a
  gateway with no logo file shows its name (`hasPartnerLogo`) instead of crashing the page.

- **2026-10-29** — **Gateway CSP hosts on the storefront routes only.** `dashboard/next.config.mjs`
  adds the `GATEWAY_*` host lists to the CSP of `/checkout`, `/portal`, `/buy` and `/pricing`
  only, where every SDK loader is imported. The operator dashboard's CSP fell from 4.5 KB to
  0.7 KB: its headers had passed nginx's 4 KB `proxy_buffer_size` and returned 502. A new
  gateway still adds its hosts to those lists; `verify:security` § C2 checks them on the
  storefront CSP and holds each route class under an 8 KB header budget.
- **2026-10-29** — **RazorPay gives the mandate auth amount back.** Card and UPI Autopay mandate
  orders keep `payment_capture: true` (RazorPay's recurring guides generate the token after the
  auth is captured) and now carry `notes.tmbilling_setup`, because a UPI order's fetch omits its
  `token` block. `vaultPaymentMethod` (`pay_…`) and the setup `consumeIntent` report the captured
  ₹1 as `setupAuthCharge`; the engine refunds it (`refund_setup_auth`). Only a payment of the auth
  amount on a mandate order qualifies. Proven in test mode 2026-10-29: card and UPI saves through
  the engine ended `refunded`, and the UPI mandate debited after its refund. Conformance row
  `S3.setup-auth-refunded`; existing captures: `scripts/refund-razorpay-setup-auths.ts`.
- **2026-10-29** — **PayU and CyberSource ported onto development as "Coming soon".** Both
  adapters (built 2026-10-25, before vendor sign-off) moved onto the current contract. Each has a
  `pending` entry in `conformance/exclusions.json`, so `GET /v1/gateways` lists it with
  `available: false`, the dashboard shows a "Coming soon" card with no connect action, and
  `POST …/gateway_accounts` refuses it. No conformance fixtures yet; the exclusion says why.
  Setup guide stubs `12.payu.md` / `13.cybersource.md` carry the generated regions.
  - **PayU** (`providers/payu.ts`, key `payu`). India, INR only, plain HTTP: hosted checkout
    `_payment` + `postservice` commands, host from the account's mode (`test.payu.in` /
    `secure.payu.in` + `info.payu.in`). Credentials `merchant_key`, `merchant_salt` (v1). Buyer
    flow `form_post` + `buyerReturnByPost`. Renewals: SI mandates (`si=1`, ADHOC) on card, UPI
    Autopay and net banking; the registration's `mihpayid` is the mandate, vaulted as
    `<card|upi|nb>:<authpayuid>`; only `payment_source: sist` vaults (E755 →
    `recurring_not_enabled`). `preDebitNotice` card + UPI / 48 h / 1 debit / exact →
    `pre_debit_SI`, then `si_transaction`. One-off pay now: hosted checkout, never vaulted,
    `methodUsed` from `mode` (NB → `bank_transfer`, as Razorpay and Cashfree). Ids: txnid
    `tmsu…` setup / `tmpy…` one-off / `tmrc…` renewal; refund id `<txnid>:<token>`. A renewal
    asks `verify_payment` before debiting; a lost answer is `ProviderIndeterminateError`.
    Webhooks `credential` (salt) + `accountIdInPath`: payment posts are reverse-hash checked;
    refund and net banking mandate JSON are read back before use; disputes are unsigned →
    `disputeFeed: false`. Decline table `PAYU_CODE_TABLE` / `PAYU_RULES`. Waits on PayU: the
    live mandate pre-debit test is not complete.
  - **CyberSource** (`providers/cybersource.ts`, key `cybersource`). REST with HTTP Signature
    (HMAC-SHA256, base64-decoded secret). Credentials `organization_id`, `key_id` (UUID),
    `shared_secret` (44 chars), shape-checked in the factory. TMS customer + payment instrument
    per card. Buyer flow `sdk`: Microform v2 (`cybersource-microform-dialog.tsx`, CSP hosts
    `testflex`/`flex.cybersource.com`) → transient token → zero-amount CIT authorization with
    `TOKEN_CREATE` (setup) or an authorization captured on consume (payment). Stored-credential
    fields from `ChargeInput.initiator`. Idempotency: `clientReferenceInformation.code`; a
    DUPLICATE_REQUEST is resolved by Transaction Search (lags ~5–6 s, reads retry ~9 s, then
    `ProviderIndeterminateError`). Webhooks `provider_minted`: subscribe the URL, mint a digital
    signature key (`keyId:key`), `v-c-signature` checked; no freshness window (see the table
    above). `disputeFeed: false` (no dispute webhook). eCheck (`us_bank_account`) is pay-now
    only (`payNowOnlyMethods`) and listed in `live-proof-pending.json`: the Microform dialog
    takes cards only and shows no ACH authorization text. Decline table
    `CYBERSOURCE_CODE_TABLE` / `CYBERSOURCE_RULES`. Waits on the CyberSource
    merchant setup for its live tests.
  - Dropped from the WIPs: `payments.metadata.payment_method_used` (Phase 5's
    `payments.method_type` stores `methodUsed`), the duplicate `ChargeResult.methodUsed`, and
    unused env names. Gates: `verify:payu`, `verify:cybersource` (offline, in verify:all);
    `verify:payu-live`, `verify:cybersource-live` (sandbox, not in verify:all).

- **2026-10-29** — **Phase 4 availability flag.** `GET /v1/gateways` adds `available` and
  `unavailable_reason` per gateway and per `method_types` entry. A gateway with open conformance
  gaps (`conformanceGaps`) is not offered: `POST …/gateway_accounts` refuses it ("We could not
  connect <Gateway>. It is not available yet.", `assertGatewayOffered`, route only; seeds and
  harnesses still create). A method in `src/providers/conformance/live-proof-pending.json` leaves
  `effectiveMethodTypes` and `hostedApplePayOffered`. Existing accounts and saved methods keep
  charging, refunding and taking webhooks. Gate: `verify:gateway-availability`.
- **2026-10-28** — **Phase 6a: our own retry for failed inbound webhooks, every gateway.**
  `ingestGatewayWebhook` queues `process_gateway_webhook` for the events whose handler errored
  (shared `queueStoredDelivery` with `storeGatewayWebhook`: same job key and live-job rule) and
  still answers 502. The per-event lock moved into `handleProviderEvent`, so a redelivery, the job
  and a replay serialise on it. The job gets graphile's attempt count; the last failed try marks
  the rows (`RETRIES_EXHAUSTED_NOTE`) and logs at error. New clock pass `gateway_webhook_retries`
  (`requeueStrandedGatewayWebhooks`) with partial index `provider_events_error_received_idx`
  (0401). `StoredDeliveryJob.gatewayAccountId` may be NULL (account not in the row's URL).
  Proven by `verify:webhook-retry` (a–d) and the generic conformance row
  `S11.errored-retried-by-us` (11 gateways).
- **2026-10-28** — **Webhook freshness windows; a pin migration cannot be re-provisioned over.**
  `STRIPE_WEBHOOK_TOLERANCE_S` (300 s) is passed to `constructEvent` explicitly, so an SDK upgrade
  cannot change it; a stale delivery signed with the main secret is refused as stale instead of
  being retried against the next secret. PayPal gets no window (re-signing is not documented).
  While `webhook_secret_next` is set (an endpoint replacement in progress), re-provisioning a
  Stripe webhook is refused. Retention now strips old `provider_events` instead of deleting them,
  so the dedup outlives the period. See "Webhook freshness windows".
- **2026-10-29** — **Authorize.net: pending eCheck cancel, voids, gateway text.** Declares
  `pendingDebitCancel`: `cancelPendingCharge` voids an unsettled debit and reads it back; a
  settled or captured one answers `already_final`. A `voided` transaction reads as `failed`
  `debit_cancelled`, not retriable (it read as a retriable approval). `payment.void.created` on
  an eCheck maps to `charge.failed` `debit_cancelled` (was `charge.refunded`, which left the
  payment pending); a card void stays a refund. `unescapeAuthorizenetText` decodes HTML entities
  in gateway text ("and&#47;or"). Conformance S10 rows bill an eCheck through the fake.

- **2026-10-28** — **Apple Pay on the gateways' hosted pages (plan 5i).** Our one storefront
  domain serves Stripe's Apple Pay association file, so for any other gateway pay-now Apple Pay
  runs on the gateway's own page: `CreateIntentInput.hostedWallet: "apple_pay"` answers
  `mode: "redirect"`. Catalogue flag `applePayHosted` (`only` | `with_cards`). Adyen: a one-time
  payment link (`allowedPaymentMethods: ["applepay"]`, `manualCapture`, intent `adypl_<link>`);
  its AUTHORISATION carries `paymentLinkId`. Checkout.com: a Hosted Payments Page
  (`allow_payment_methods: ["applepay"]`, `capture: false`, reference `th-<intent>`, intent
  `ckoh_<reference>`). Square: a payment link with Apple Pay on (cards stay on; intent
  `sqh_<order>`); a completed payment without our reference makes one order read. New event
  field `gatewayIntentId`: `applyIntentEvent` re-points the attempt to the payment the page
  made, then consume captures or books it. Square's Web Payments SDK no longer offers Apple Pay
  and Square no longer registers wallet domains (`walletDomains` off). Braintree: no hosted
  page, so no Apple Pay. Portal gateway list adds `apple_pay_hosted`; collect takes `wallet`.
  Pay now only; nothing is saved for renewals. Not proven live: Apple Pay needs Safari and an
  Apple sandbox tester.
- **2026-10-28** — **Adyen SEPA Direct Debit (plan 5g) and answer-first webhooks (Phase 6).**
  Adyen declares `sepa_debit` (EUR-bound, `settlement.asyncMethods`); setup sessions add
  `sepadirectdebit` in EUR when the account offers it; a stored SEPA method vaults as `sepa_debit`
  with `mandate.rail = sepa_core` (our pre-debit email) and the setup pspReference as the mandate
  reference (a third element in the `adypm_` id); renewals send `type: sepadirectdebit` with
  ContAuth (`locateCharge` gets the method type from `lost-answer`). A SEPA `CHARGEBACK` splits by
  reason code: MD01/MD06 = dispute lost at once, every other code = bank return
  (`charge.failed` + `lateReversal`, invoice reopens). `CANCEL_OR_REFUND` cancel on our `tmf:`
  refund books the refund. New catalogue flag `webhook.processAfterAnswer` (Adyen): the route
  verifies the HMAC, stores the `provider_events` rows and queues `process_gateway_webhook` in one
  transaction, answers `200 [accepted]`, and the job applies them (`storeGatewayWebhook`,
  `processStoredGatewayWebhook`). Decided: no webhook-only reconciliation flag
  (`docs/references/GATEWAY_BEHAVIOUR_NOTES.md` §7). Not proven live: SEPA is not enabled on the
  test merchant account.
- **2026-10-28** — **Google Pay on pay-now for Adyen and Checkout.com (plan 5d).** Pay-now
  sessions only: Adyen `allowedPaymentMethods: ["scheme", "googlepay"]`, Checkout.com Flow
  `enabled_payment_methods: ["card", "googlepay"]`; setup sessions stay card-only (no wallet is
  saved for renewals). The token rides the card rail, so authorise → capture / void / refund
  are unchanged (Adyen lists refunds, partial refunds and separate captures for Google Pay).
  `submitClientResult` reports `FetchedIntent.methodUsed` (Adyen session result
  `payments[].paymentMethod.type`; Checkout.com `source.card_wallet_type` on a `card` source,
  now also in `chargeResultFromPayment`); the engine keeps it on `payment_attempts.method_used`
  (0398) and books it when the capture names no method. Catalogue: card hints and notes say
  what to enable; `walletDomains` (`GET /v1/gateways` `wallet_domains`, Stripe and Square,
  unit-tested against `registerWalletDomain`) now gates the dashboard's wallet-domain card
  instead of `gateway_key === "stripe"`. Dialog titles read "Pay" on pay-now. Apple Pay stays
  out (5i). Conformance: `S13.googlepay-notification` (Adyen), `S13.googlepay-source`
  (Checkout.com). Live proof with Google Pay pending (5d live).
- **2026-10-28** — **Braintree: PayPal, Venmo, 3D Secure and the account updater (gateway plan
  5e).** `capabilities.methods` = card, paypal, venmo (catalogue binds Venmo to USD). The intent
  carries the offered methods (`t` in the synthetic id, `methods` in the sdk params, from
  `methodTypes`, default cards); Drop-in shows only those (`card: false`, `paypal` vault flow for
  setup / checkout flow for pay-now, `venmo` with `allowDesktop`, `threeDSecure` with a create
  fallback for merchants without it). Every nonce is read first (`node(id: nonce)`): a type the
  intent did not offer is refused before anything is vaulted or held, and a card's 3D Secure
  result is checked against Braintree's "reject if 3DS is required" list plus "shift possible but
  not shifted" (`braintreeThreeDSecureFailure`, rule `braintree.category.three_d_secure_not_shifted`
  → `authentication_required`). Renewals stay merchant-initiated (`paymentInitiator`), no 3DS.
  Webhooks: `payment_method_revoked_by_customer` / `granted_payment_method_revoked` →
  `payment_method.detached` (by `global-id`, else `idsFromLegacyIds` on the token);
  `account_updater_daily_report` → fetches the CSV (link valid one week), takes `New account
  number` / `New expiry date` rows, re-reads each card and emits `payment_method.updated` (token
  unchanged); a failed fetch throws so Braintree redelivers. PayPal refunds measured in the
  sandbox: a sale is SETTLING at once, partial refunds work immediately, a void is refused
  (91504) and `reverseTransaction` returns a Refund; SETTLEMENT_PENDING PayPal sales are voidable.
  `orderId` capped at 127 (PayPal's limit). 91577 / 91517 (method not on for the merchant
  account) → `gateway_request_rejected`. CSP: PayPal SDK, `c.paypal.com`, Cardinal Songbird and
  frames, Cardinal's `centinelapi` hosts (named: `connect-src` takes no new wildcard). Gates: `verify:braintree` 175/175, `verify:braintree-live`
  35/35, 7 new conformance rows. Live proof of the browser flows and real webhooks is open.
- **2026-10-28** — **GoCardless extra schemes (gateway plan 5c).** BECS (`au_becs_debit`, AUD),
  BECS NZ (`nz_becs_debit`, NZD), PAD (`acss_debit`, CAD), Autogiro (SEK), Betalingsservice
  (DKK) and PayTo (`payto`, AUD) join Bacs, SEPA and ACH: scheme map, capabilities, catalogue
  options with timing hints. AUD has two rails: the caller's method wins, none → BECS. The
  hosted page collects the Swedish and Danish identity numbers (BankID / `collect_customer_details`,
  measured), so we send none. A Canadian customer's company goes as `company_name` (Business
  PAD; `EnsureCustomerInput.company`). PayTo sends `purpose_code` (new optional credential
  `payto_purpose_code`, default `retail`, validated when the adapter is built), a description and
  `constraints.max_amount_per_payment` = the derived mandate ceiling; a setup without a ceiling
  is refused. The mandate's `consent_parameters.max_amount_per_payment` is stored as the ceiling,
  so the engine refuses a larger renewal (`mandate_ceiling_exceeded`) without calling GoCardless.
  `gatewayNotifiesPayer` drops PayTo (no scheme notice; our reminder goes). Gates:
  `verify:gocardless` (extra-scheme section), conformance rows `S1.scheme.*`, `S2.scheme.*`,
  `S1.payto-over-ceiling`, `verify:gocardless-live` (BECS, BECS NZ, PAD, Betalingsservice end to
  end; Autogiro and PayTo up to the hosted page). Facts: `GATEWAY_BEHAVIOUR_NOTES.md` §1.10.
- **2026-10-28** — **Every adapter reports `ChargeResult.methodUsed`** from the payment it already reads,
  so `payments.method_type` (0397) records what paid on renewals too. Mapped onto `METHOD_TYPES`
  (wallet names kept: `apple_pay`, `google_pay`). Stripe: expanded `latest_charge`
  `payment_method_details.type` (+ `card.wallet.type`), else an expanded PaymentMethod, else the
  intent's only `payment_method_types` entry (`nz_bank_account` → `nz_becs_debit`). RazorPay: the
  payment entity's `method` (`netbanking`/`emandate`/`nach` → `bank_transfer`; EMI, pay-later
  unknown); the recurring-create handshake carries none. Cashfree: subscription payment rail
  (`authorization_details`), PG order `payment_group`. PayPal: the order's `payment_source` key
  (a capture resource has none; consume reads the order). GoCardless: payment `scheme`.
  Checkout.com: `source.type`. Braintree: `paymentMethodSnapshot.__typename`. Authorize.net:
  `accountType` (`eCheck` → `us_bank_account`, a brand → `card`) and the read-back `payment`
  block. Adyen: `paymentMethod.type` (only on `Authorised`; `scheme` → `card`). Capture responses
  of Adyen and Checkout.com name no method, so a consume there leaves it unknown. tmtest sets
  none: the engine falls back to the saved method's type.
- **2026-10-28** — **Routing by purpose (gateway plan 5b).** `selectGatewayAccount` takes an
  optional `purpose` (`payment` | `setup`) and drops accounts whose gateway cannot do it before
  the default breaks a tie: a GoCardless account (setup only) no longer catches a pay-now as the
  business default or makes it `ambiguous_gateway` beside a paying gateway. The override branch
  and purpose-less calls (renewals) are unchanged. The catalogue mirrors
  `capabilities.intentPurposes` as `GatewayDefinition.intentPurposes` (pinned to every adapter by
  `test/unit/dispute-feed.test.ts`) and adds `payNowOnlyMethods` (RazorPay `wallet`), which
  `effectiveMethodTypes(row, currency, "setup")` leaves out. `GET /v1/gateways` returns
  `intent_purposes`; the dashboard's "No default gateway" warning counts only accounts that take
  payments. One reading of `intentPurposes` everywhere: absent or empty = both
  (`allowsIntentPurpose` in `providers/types.ts`).
- **2026-10-27** — **Catalogue text corrected for the setup guides (`docs/gateway-setup-guides`).**
  Adyen's credential hint lists every role our calls need (Merchant PAL, Checkout webservice,
  Merchant Recurring, API tokenise payment details — `GET /storedPaymentMethods` — and
  Management API — Webhooks read and write). Authorize.net's hint uses the new Merchant
  Interface path and says the Transaction Details API must be on (reconciliation and
  lost-answer lookup fail without it). Razorpay menu is "Account & Settings"; second credential
  fields get "on the same page" hints; Cashfree says which Secret Key the webhook needs; the
  Braintree placeholder no longer uses a stock name.

- **2026-10-27** — **Authorize.net and Braintree join the settlement-report poll
  (`fix/settlement-poll-anet-braintree`).** Authorize.net (`settlementReport: { 360, 48 }`):
  `getSettledBatchList` from 24 h before the window (UTC dates), `getTransactionList` per batch
  (1000 a page, 25 pages, then it throws), `getTransactionDetails` only for a `settlementError`
  / `returnedItem` row carrying our reference → `charge.failed` + `lateReversal`, or
  `refund.failed` for our refund; ids `anet_settle_<transId>_<status>`. Braintree
  (`settlementReport: { 60, 24 }`): `search.refunds` created in the window (a Control Panel card
  refund has no webhook) and failed refunds 7 days back → `charge.refunded` on our sale with the
  refund's own record; `search.transactions` `SETTLEMENT_DECLINED` with our `orderId` prefix,
  7 days back → `charge.failed` + `lateReversal` (card sales have no transaction webhook
  either). 50 a page, 40 pages, then it throws. Conformance: `S9.settlement-error-after-success`
  passes (known gap removed); new rows `S4.refund-settlement-error` (Authorize.net),
  `S3.dashboard-refund-no-webhook`, `S4.voided-refund-polled`,
  `S9.card-settlement-declined-polled` (Braintree). The Authorize.net fake now batches by
  settlement day and filters by settlement date.
- **2026-10-27** — **Adyen lost answers: `locateCharge` by same-key replay (`fix/adyen-lost-answer`).**
  Checkout has no payment lookup, so `locateCharge` resends the original `/payments` body under
  the same `Idempotency-Key`: a processed request answers its first response, one Adyen never
  received is made then. New capability `locateByReplay: { keyValidMs }` (6 days; keys live 7–14)
  and `locateCharge` input `replay` (`initiator`, `email`). The sweep (`payments/lost-answer.ts`
  `replayGate`) replays only an invoice collection (`inv_…` ref and key) inside the window, on an
  open invoice that owes exactly that amount, with no other pending payment or live intent and a
  usable instrument, under the invoice's collection claim; anything else → operator alert. Never
  from a webhook or a stranded-id row. Answers naming no payment, 704, any 4xx and network errors
  throw, so it never returns null. `S7.locate-found` passes; `S7.locate-none` is n/a for Adyen
  (a replay cannot end "not created"), replaced by `S7.replay-creates-once`, `S7.replay-not-owed`, `S7.replay-instrument-gone`,
  `S7.replay-in-flight`. Technical cancel by reference was rejected: it cannot cancel an
  auto-captured payment and reports only by webhook.
- **2026-10-27** — **Cashfree conformance fixes (gateway plan 3f Cashfree, `fix/cashfree-3f`).**
  All 15 Cashfree rows of `verify:gateway-conformance` pass; `known-gaps.json` lists none.
  - `SUBSCRIPTION_REFUND_STATUS` sends `refunds[]` with each refund's own amount (a dashboard
    partial refund was booked as a full one); a SUCCESS without an id or amount is `unresolved`.
  - Payment events carry `amountMinor`, and the catalog sets `lateCaptureAfterFailure`: a payment
    Cashfree retries after FAILED (same payment id) is booked.
  - Debit creates go through `classifyGatewayHttp`: 408/409/429/5xx/network are retried with the
    same key (at most 3 tries, 20 s; `x-ratelimit-retry` honoured up to 3 s), then the payment our
    id names is read, then `ProviderIndeterminateError`. Raise-a-Charge leaves no id (the sweep's
    `locateCharge` finds it); a controlled execution stamps its id (the notice named that
    payment, so the debit key cannot rebuild it). Refund 408/409/429 → `pending`.
  - `locateCharge`: one read of the payment the row holds (`providerChargeId`, new optional
    input), else of the one named by the mandate and the key; 404 → null.
  - Webhook versions: `x-webhook-version` must be 2023-08-01, 2025-01-01 or 2026-01-01 (every
    version Cashfree's webhook pages document, read 2026-10-27); any other, or none, is recorded
    `unresolved` and never parsed. 2023-08-01's `failureDetails.failureReason` is read, and a
    subscription failure keeps Cashfree's reason as the attempt's error text.
  - Health check: `HealthCheckInput.recentWebhooks` (this account's latest 20 deliveries, from
    `verifyGatewayAccount`) feeds a `webhook_version` row: failed when a delivery is on a version
    we do not read, or not on 2025-01-01 (Payments tab) / 2026-01-01 (Subscriptions tab).
- **2026-10-27** — **Mollie conformance fixes (gateway plan 3f).** Creates go through
  `classifyGatewayHttp`: 408/409/429/5xx/network retry under the same key (3 tries, waiting
  `Retry-After` when sent, never a wait over 10 s), then a lookup by our metadata, then
  `ProviderIndeterminateError`; a 409 is never a refusal (charge or refund; a refund is found by
  its `tmbilling_idem`). `locateCharge` pages `/payments` back to `createdAfter` and matches our
  idempotency key (the ref is shared by every attempt on an invoice). Refund events carry
  `refunds[]` with each refund's own `amount`, not the payment's running `amountRefunded`;
  failures set `lateReversal`. Webhook catch-up rides the settlement-report poll
  (`settlementReport: { intervalMinutes: 60, maxWindowHours: 48 }`): `pollSettlements` reads
  `/refunds` (7 days before the window) and `/chargebacks` (created or reversed in the window,
  180 days back), `embed=payment`, our payments only, mapped as the webhook would. A pay-later
  one-off left `authorized` is captured on consume (`POST /payments/{id}/captures`); its later
  `paid` adds `charge.succeeded` (`tr_…:captured`) to settle the pending capture.
  `fetchChargeStatus` refuses an empty id. Gates: `verify:mollie`, `verify:gateway-conformance`.
- **2026-10-27** — **A replaced webhook secret lives as long as the gateway retries.** Catalogue
  `webhookRetryDays` (Adyen: 30, "retries for up to 30 days", never re-signed) sets how long the
  previous secret still verifies (`previousWebhookSecretMs`); others keep 24 h. Test:
  `test/unit/webhook-secret-window.test.ts`.
- **2026-10-27** — **Adyen conformance fixes (gateway plan 3f, `fix/adyen-conformance`).** Amounts
  convert between our ISO minor units and Adyen's units both ways (CLP and ISK 2 decimals, CVE and
  IDR 0; an amount Adyen cannot express is refused). REFUND and CANCEL_OR_REFUND send one
  `refunds[]` record at that refund's own amount; a REFUND without an amount is never a full
  refund. Money calls retry a lost answer, 408/409/429/5xx and `transient-error: true` under the
  same key; error 704 is indeterminate. CAPTURE carries `providerIntentId`; EXPIRE voids the
  hold; SETTLED_REVERSED is `charge.reversed` with `lateReversal`. Disputes: events after
  CHARGEBACK_REVERSED (second chargeback, pre-arbitration, scheme arbitration) are a second case
  (`<psp>:second`), because the reversal books the first case won; DISPUTE_DEFENSE_PERIOD_ENDED
  is lost, ISSUER_RESPONSE_TIMEFRAME_EXPIRED and the arbitration verdicts map. Catalogue
  `disputeFinalState: false`: an accept in the Customer Area sends no webhook. No
  `locateCharge`: Adyen has no payment lookup (S7.locate-* stay open).
- **2026-10-27** — **Authorize.net conformance fixes (gateway plan 3f, `fix/authorizenet-conformance`).**
  16 of 17 rows green. `payment.refund.created` sends one `refunds[]` record per refund (its own
  id and amount; the ref read back on ours). `fraud.approved` maps through the transaction's
  status (a held charge the issuer declines is `charge.failed`; still held is `charge.pending`).
  A void of an `authOnlyTransaction` sends `intent.voided` and `charge.refunded`: the engine's
  record decides whether it was captured. `couldNotVoid` reads as captured and a refund resends
  the void (refused: "the money is still captured"). A lost void answer re-reads the charge.
  Reasons 19, 20, 120–122 are unknown outcomes (lookup, then indeterminate). `locateCharge`
  searches our `invoiceNumber` in the unsettled list and every batch settled since the attempt;
  list reads page fully and throw past 25 pages. Our `ownershipRef` rides at the end of
  `order.description` (`[ref:…]`, within 255), so a lost charge's later event is adopted.
  Signature: one key form (hex-decoded Signature Key), either hex case, optional `sha512=`.
  `healthCheck` fails on our webhook set `inactive`. A `settlementError` read is `lateReversal`;
  S9 stays open (no engine pass re-reads captured charges).

- **2026-10-27 (fix)** — **Braintree conformance (gateway plan 3f, `fix/braintree-conformance`).**
  Braintree answers HTTP 200 with an `errorClass`, so `mutate()` reads each class as its HTTP
  twin through `classifyGatewayHttp`: INTERNAL / SERVICE_AVAILABILITY = 5xx, in-flight 915233 =
  409, RESOURCE_LIMIT = a 429 that created nothing. Keyed mutations replay the same
  `apiRequestKey` twice (250/500 ms) and then are indeterminate; RESOURCE_LIMIT is a definite,
  retriable failure. A charge error of no known class is indeterminate, never a plain throw.
  `locateCharge` searches `search { transactions(orderId, createdAt) }` (the pre-2026-07 form,
  valid under the pinned version). Refund / reverse / capture / void: a definite class is a
  `ProviderRefusalError` (91521/91512 say how much Braintree shows as refunded); anything else is
  indeterminate. A VOIDED Refund is failed (a voided sale stays a succeeded full refund). A
  settled credit is `charge.refunded` on its sale with `refunds[]` from the sale's `refunds`
  (Control Panel ones included). `transaction_settlement_declined` on a sale sets `lateReversal`.
  A retrieval's terminal kinds are `dispute.closed`; a pre-arbitration withdraws funds on open;
  `amount-won` → `disputeAmountWonMinor`. A nonce that is not `CreditCardDetails` is refused (and
  removed from the vault, or its authorization voided). A 401/403 is read before the JSON parse.
  Card refunds still send no webhook: see PROGRESS 3f for the open path.
- **2026-10-27** — **Square conformance fixes (gateway plan 3f Square, `fix/square-conformance`).**
  All 12 Square rows of `known-gaps.json` pass and are removed.
  - **Refunds:** `charge.refunded` sends `refunds[]` with the refund's own amount; no running total.
  - **Lost answers:** `reference_id` is `tm-<ownershipRef>-<hex of the key>` (≤40; the old
    `tm`+38 hex when the ref does not fit), so payment events carry `ownershipRef` and a webhook
    adopts a `timeout` row. New `locateCharge`: ListPayments by that reference from
    `createdAfter` for 2 h, filtered by `total`; a window too large to read throws, never null.
    An empty charge id never reads `GET /v2/payments/` (the list).
  - **HTTP classes:** `classifyGatewayHttp` in the transport: 408/409/429/5xx are indeterminate
    (one same-key replay, then a lookup). `IDEMPOTENCY_KEY_REUSED` answers with the payment the
    key made, else indeterminate. Any other refund 4xx (incl. a cancel) is `ProviderRefusalError`.
  - **Events:** payment events carry `providerIntentId` (= payment id) and `amountMinor`; a payment
    at another location is `foreign`. Consume of a CANCELED/FAILED payment returns its failed result.
  - **Webhooks:** a reused subscription is moved to `SQUARE_VERSION` (`api_version` in the check
    and the update).
- **2026-10-27** — **Checkout.com conformance fixes (gateway plan 3f, `fix/checkoutcom-conformance`).**
  All 8 Checkout.com rows are green and deleted from `known-gaps.json`. `dispute_canceled` →
  `dispute.won` (a debited amount is credited back). `payment_capture_declined` sets
  `lateReversal`; `payment_voided` on a charge (booked paid at authorization) is `charge.failed`
  with `lateReversal`, on a hold still `intent.voided`. Money calls go through
  `classifyGatewayHttp`: no answer, 408, 409, 429 or 5xx is sent twice more under the same
  `Cko-Idempotency-Key`, then indeterminate. `locateCharge` searches `GET /payments?reference=`
  and matches the idempotency key a charge now carries in metadata (`tmbilling_key`). 403 on
  refund, capture and void is a refusal (documented "… not allowed"); only 401, and 403
  elsewhere, is a key error. Capture/void 200 ("already captured/voided") is success. The
  documented amount rules (≤ 9 digits; 3-decimal currencies end in 0; CLP ends in 00) refuse
  before sending; a charge returns a definite `gateway_request_rejected`.
- **2026-10-27** — **PayPal and Razorpay conformance rows (gateway plan 3f, `fix/paypal-razorpay-3f`).**
  - **PayPal:** HTTP answers go through `classifyGatewayHttp`, and the body is parsed after the
    status: a non-JSON 4xx is a definite refusal; a non-JSON 2xx, a 5xx or a persistent 429 is
    indeterminate (a 429 used to be a retriable failure). `Retry-After` is honoured up to 10 s.
    The vault exchange sends a PayPal-Request-Id (`vault_<setup token>`) and replays a lost
    answer. Captures send `final_capture: true`. HUF and TWD go in whole units (a fraction throws
    before the call). `locateCharge` reads Transaction Search by our `custom_id` tag and amount;
    it returns null only when no untagged row of that amount exists, and it throws on a 403 (the
    app permission is off) with a `paypal_transaction_search_forbidden` error.
  - **Razorpay:** a 408/409/429 on the recurring debit takes the lost-answer path (read the
    order's payments, else indeterminate), as a 5xx did. `locateCharge` lists our orders by
    `receipt` from the attempt and reads their payments.
- **2026-10-27** — **Stripe and GoCardless conformance rows green (gateway plan 3f).** Both
  adapters gain `locateCharge`. Stripe searches PaymentIntents by `tmbilling_ref` and confirms
  "none" with the list API (search lags and is not offered in India); GoCardless lists payments
  in the window (no metadata filter exists). Both match ref, amount and currency inside one hour
  after `createdAfter`, and throw on more than one match. Stripe also: a refund
  `invalid_request_error` (not 409/429) throws `ProviderRefusalError`; a `canceled` refund is
  `refund.failed`; ISK and UGX are sent ×100 and read back ÷100 (Stripe's special cases).
- **2026-10-27** — **`verify:gateway-conformance` (gateway plan 3e).** S1–S14 run against each
  adapter's fixture module (fake API, real engine and webhook route); the suite passes only when
  the failing rows equal `src/providers/conformance/known-gaps.json`. `conformanceGaps(key)`
  (`src/providers/conformance`) is the availability hook. Exemplars: Stripe, GoCardless, Square.
  Coverage gate: a catalog gateway needs a fixture module or a stated exclusion.
- **2026-10-26** — **GoCardless release fixes (`fix/gocardless-ready`), from the independent
  audit plus two defects the live tunnel run found.**
  - **Mandate events:** the event's action sets the status (GoCardless's API can trail its
    webhooks by minutes); no mandate read for a state event. `reinstated` → active.
    `payment_methods.mandate_status_at` (0395) keeps an older event from overwriting a newer
    status: GoCardless delivered a batch newest first (`active, submitted`) live.
  - **`replaced`:** re-points the method to `links.new_mandate` (status, reference and bank
    display from the new mandate) instead of booking it cancelled. A charge refused with
    `mandate_replaced` is retried once on the new mandate under the same key.
  - **`transferred`:** active, with the new bank account's display (`last4`, bank name).
  - **Refund events link only the refund** (measured): `refunds.paid` now reads the refund for
    its payment. It mapped to a `charge.refunded` with no charge id, which the engine ignored,
    so a refund never settled from its webhook and a dashboard refund was never booked.
  - **Due date:** `ChargeInput.invoiceDueDate` is the due day in the business's timezone
    (`YYYY-MM-DD`). ACH is judged against `next_possible_standard_ach_charge_date` and sends
    `faster_ach: false`; a refused `charge_date` is retried once without it.
  - **Success after failure:** catalogue `settlement.lateCaptureAfterFailure` (as RazorPay on
    main), also after `late_failed`: a payment retried in GoCardless's dashboard is booked.
    `charge.succeeded` carries `amountMinor`.
  - **429:** waits for `ratelimit-reset` (≤ 60 s) and retries once; then a definite refusal
    (a failed, retriable charge; a refund `ProviderRefusalError`), indeterminate only when an
    earlier attempt was. Reads retry once too.
  - **Refunds:** a failed payment read before the refund is a refusal (nothing sent, the
    reservation is released). Messages for the 7-day safer refund period (days left from
    `metadata.no_of_days_until_refund_possible`), `available_refund_amount_insufficient`
    (`metadata.available_refund_amount`), and refunds disabled (Dashboard or support).
  - **Webhooks:** 498 on a bad signature (catalogue `webhook.rejectedSignatureStatus`).
    `NormalizeWebhookInput.settledEventIds`: events already settled for the business are
    passed through without gateway reads; the rest map 8 at a time.
  - US `region` → 2-letter state code (unresolvable → omitted).
  - Gates: `verify:gocardless` (offline), new `verify:gocardless-engine` (CORE, DB-backed, fake
    GoCardless API through the real route), `verify:gocardless-live` (waits for simulator
    events; refunds proven in EUR and USD; SKIP only on a refunds-disabled answer).

- **2026-10-26** — **Stripe: a signup card that needs 3DS on every payment gets the challenge.**
  `StripeProvider.charge()` confirms off-session, so a card whose issuer authenticates every
  payment came back `authentication_required` and the signup was refused. With
  `initiator.by: customer` (the buyer is on the page) that refusal now returns `requires_action`
  and cancels the refused PaymentIntent, so `chargeBeforeSubscriptionInvoice` opens its
  on-session challenge. The confirm itself stays off-session: an on-session confirm makes a card
  that was just saved with 3DS ask again (measured). Renewals, dunning and an absent initiator
  keep the decline. India: the off-session confirm still sends `mandate`; the challenge intent
  is on-session and sends none (Stripe accepts it with or without, measured on an active
  e-mandate). `test/unit/stripe-signup-authentication.test.ts`, live checks in `verify:stripe`.
- **2026-10-26** — **`cancelPendingCharge` + `capabilities.pendingDebitCancel`.** Stops a debit the
  gateway has not collected; the verdict is read back from the gateway, never assumed from a 2xx.
  GoCardless (`/payments/{id}/actions/cancel`, `pending_submission` only), Cashfree subscription
  payments (`…/payments/{pid}/manage` `CANCEL`), Mollie (`DELETE /v2/payments/{id}` while
  cancelable), Stripe bank debits while `processing`, tmtest (`4000000000000119` = submitted, not
  cancelable). Catalogue mirror `gatewayCancelsPendingDebits`, pinned by
  `test/unit/pending-debit-cancel.test.ts`.
- **2026-10-26** — **Cashfree conformance fixes (`fix/cashfree-conformance`)**, from an audit
  against Cashfree's docs and OpenAPI v2026-01-01.
  - **UPI lead time 25 h, counted from delivery** (FAQ: "A 25-hour window is required between
    a successful pre-debit notification and the execution of the charge", sandbox and
    production). `minLeadHours: 25`. The `SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS`
    SUCCESS webhook now carries `executableAfter` = `notification_completed_time` + 25 h,
    out of NPCI peak hours. New optional contract method **`checkPreDebitNotice`**: the gate
    (`invoicing/pre-debit.ts`) asks before it counts a debit against a notice. Cashfree's
    reads `GET /subscriptions/payments/{pid}/controlled/notifications/{nid}`: SUCCESS → not
    before delivery + 25 h; FAILED → the notice is retired with `failure_error_code` (else
    `failure_sub_error_code`) and the reason; anything else → wait.
  - **Too early is not a decline.** `execute-mandate` refusals that only say "not yet" ("No
    successful notification", "Payment attempt date cannot be before the scheduled date
    YYYY-MM-DD", a blackout refusal naming a time) return the new
    **`PRE_DEBIT_NOT_DUE_CODE`** (`pre_debit_not_due`) with `retryAfterMs`. The collection
    path gives the debit back to the notice (`releaseGatewayNotice`) and defers. Nothing is
    booked unless the caller booked before the call (wallet top-up).
  - **Disputes** follow the money (FAQ: Cashfree debits the disputed amount when a dispute
    opens, returns it on a win). DISPUTE / CHARGEBACK open → `dispute.created` +
    `dispute.funds_withdrawn` (a RETRIEVAL request: created only); `*_MERCHANT_WON` (and
    `*_REVERSAL`, not in the documented enum) → `dispute.won`; `*_MERCHANT_LOST`,
    `*_MERCHANT_ACCEPTED`, and `*_INSUFFICIENT_EVIDENCE` on DISPUTE_CLOSED → `dispute.lost`.
    INSUFFICIENT_EVIDENCE on an update is open (Cashfree asks for documents again).
    Pre-arbitration and arbitration are their own cases, `<dispute_id>:pre_arbitration` /
    `:arbitration`: they open after a win and take the money again, which the engine would
    refuse on the won row.
  - **Refunds:** `REJECTED` → failed (webhook and read-back). eNACH / pNACH refunds read the
    rail from the subscription when the payment has no `authorization_details` (CHARGE
    payments), so they go INSTANT. `ONHOLD` (measured in the sandbox: "insufficient account
    balance") stays pending.
  - **Mandate ceiling:** card and UPI capped at ₹15,000 (no AFA). A request that allows eNACH
    keeps ₹1 crore; Cashfree then offers eNACH alone above ₹15,000. AFA is arranged with
    Cashfree support and no API reports it, so there is no account setting.
  - **Rejected eNACH mandate:** a FAILED `SUBSCRIPTION_AUTH_STATUS` or AUTH-type
    `SUBSCRIPTION_PAYMENT_FAILED` also emits `payment_method.mandate_updated` (`rejected`),
    because BANK_APPROVAL_PENDING → INITIALIZED fires no status change.
  - **ON_HOLD** (a failed eNACH or card debit) stays `paused`: the instrument is `invalid` and
    `recheckPausedMandates` revives it once Cashfree reports ACTIVE. Recovery is a manual step
    at Cashfree: retry the failed payment in the dashboard (Manage Charges → Retry) or with
    the Manage Payment API (`action: RETRY`). Not automated: RETRY re-presents Cashfree's
    failed payment (same id, same amount), while our dunning books a new attempt per retry.
  - **Pay now orders** take `order_expiry_time` = our intent's expiry (new optional
    `CreateIntentInput.expiresAt`, filled at both `payment-intents` create sites). `intentVoid`
    stays false: `PATCH /orders/{id}` TERMINATED exists, but an order never holds money.
  - Small: `x-request-id` on every call; `customer_name`, `order_note` under 3 characters
    left out, `refund_note` under 3 → "Refund"; a phone that is not 10 digits (after +91 / 0)
    is refused with a readable message; notice `payment_remarks` = the invoice number
    (new optional `description` on `notifyUpcomingDebit`), never our notice id; `psp_note`
    names the ceiling; PG `error_details.error_reason` mapped in `CASHFREE_CODE_TABLE`; the
    latest order payment chosen by `payment_time`, not list position; controlled executions
    fill `capturedAmountMinor`.
  - Catalog: subscription webhooks use version 2026-01-01.
  - Gates: `verify:cashfree` (130 checks), `verify:pre-debit-notices` (m, n, o),
    `verify:gateway-vocabulary`, `verify:cashfree-live`.
- **2026-10-26** — **Phase 3: live proofs and the bugs they found (`fix/gateway-phase3-proofs`).**
  Every run engine-booked, real webhooks through the tunnel, forged deliveries refused.
  - **Refunds a gateway refuses** (`refunds/service.ts`). A `ProviderRefusalError` from
    `adapter.refund()` escaped `refundPayment`: the API answered 500 and the `pending`
    reservation stayed, so the payment could never be refunded in full. Now the refund is
    `failed`, a failed transaction (`refund_refused`) and `refund_failed` are recorded, and
    the caller gets a 400 with the gateway's reason. Hit live by Braintree and GoCardless.
  - **Braintree:** the engine always sends an amount, so the "full refund = void" branch was
    unreachable and an unsettled sale could not be refunded at all. A refused
    `refundTransaction` on an unsettled sale now reads the sale and, when the amount is the
    whole of it, voids it (own `apiRequestKey`). Webhooks proven over the Control Panel
    registration: `check`, `dispute_opened` (chargeback → created + funds withdrawn),
    `dispute_accepted` → lost. The Control Panel offers no transaction kinds (settled,
    refunded), so a card charge or refund sends no webhook; the API answer is the record.
  - **Square:** a failed ACH debit names its reason under `bank_account_details.errors`
    (measured `INSUFFICIENT_FUNDS`); `paymentError` read only `card_details`, so the engine
    booked a generic `charge_failed`. An open chargeback (any non-`INQUIRY_*` state) now also
    emits `dispute.funds_withdrawn`: Square withholds the disputed amount until the bank
    decides. New `registerWalletDomain` (`POST /v2/apple-pay/domains`); Square fetches its
    own association file from the domain root, and its refusal text is returned verbatim.
  - **Cashfree:** `AUTO_REFUND_STATUS_WEBHOOK` (`data.auto_refund`, no merchant `refund_id`,
    sent for successful auto refunds only) → `charge.refunded` on `ord:<order>:<cf_payment_id>`,
    refund id `ordrf:<order>:auto-<cf_refund_id>`, total from the order's refund list (an
    unreadable list counts the auto refund as the total, since it returns the whole
    payment). The setup steps now name the "auto refund" event.
  - **GoCardless:** the refunds-disabled refusal pointed at the dashboard; GoCardless says
    "contact support" (measured 403 `forbidden`). The message now says to ask support.
  - **Invoices raised with `collect` on a notice rail** (`createInvoiceFromLines`): the
    pre-debit deferral escaped as a 500 after the invoice was already raised. Now the invoice
    stands and the clock collects after the notice period, as at renewal.
  - Gates: `verify:square` (ACH reason, chargeback funds, inquiry, wallet domain),
    `verify:braintree` (void fallback), `verify:cashfree` (auto refund ×5),
    `verify:pre-debit-notices` (l), `verify:gateway` REFUSAL-1…4.

- **2026-10-26** — **Adyen Allowed origins check + `capturedAmountMinor`
  (`feat/gateway-adyen-origin-check`).**
  - **Contract.** `healthCheck(input?: HealthCheckInput)` takes `storefrontOrigins` and may
    return named `checks: HealthCheckItem[]` (`ok | failed | unchecked`, `message`, `steps`).
    `verifyGatewayAccount` passes the origin of `PORTAL_BASE_URL` (`storefrontOrigins()`), the
    host every storefront route is served from; the verify route returns `checks`, and the
    dashboard's verify alert lists each check that is not `ok` with its steps.
  - **Adyen.** After the `paymentMethods` probe, reads `GET /me/allowedOrigins` (any Management
    API role) and `GET /me` (the credential's name, for the steps). A storefront origin
    missing from the list fails the account and is named, with the Customer Area steps to
    add it. No Management API role, an unanswered read, or no `PORTAL_BASE_URL` →
    `unchecked`, account stays `ok`. Measured on the test account: an origin not in the list
    gets 403 from the Drop-in's `sessions/{id}/setup` (the allowed one 200), and Adyen's reads
    show an add or remove after up to ~4 s, so the last step says to wait a minute.
  - **`NormalizedProviderEvent.capturedAmountMinor`** on `charge.succeeded`, unset when the
    event does not say what was captured. Filled: Stripe (`payment_intent.amount_received`;
    a Charge's `amount_captured` only when `captured`), RazorPay (`amount` of a captured
    payment), PayPal (capture `amount`, sale `amount.total`, an order's COMPLETED captures in
    one currency), Cashfree (PG and subscription `payment_amount`), GoCardless and Mollie
    (from the payment the adapter already reads back), Braintree (`amount` of a settled
    transaction), Adyen (`CAPTURE`, and `AUTHORISATION` on our `tmc:` charges, which capture
    with the authorisation), Checkout.com (`payment_captured`), Authorize.net (`settleAmount`
    ?? `authAmount` of the read transaction; payload `authAmount` for an unread
    auth-and-capture only), Square (`total_money` of a COMPLETED payment), tmtest
    (`amount_minor`), Cashfree controlled executions (`payment_amount`, filled 2026-10-26).
    Left unset: Checkout.com `payment_approved` (an authorization), Adyen `AUTHORISATION` on a
    foreign reference, an unread
    Authorize.net prior-auth capture, an uncaptured Stripe Charge. No engine code reads it yet.
  - Gates: `verify:adyen` (health check, captured), `verify:adyen-live` (read-only Allowed
    origins step), `capturedAmountMinor` checks in `verify:{cashfree,gocardless,braintree,
    checkoutcom,authorizenet,square,mollie}`, unit `captured-amount` (Stripe, RazorPay,
    PayPal, tmtest, `storefrontOrigins`).

- **2026-10-25** — **Hardening phase 1 (`fix/gateway-hardening`).**
  - **Webhook removal on account delete.** Adapter contract `removeWebhookEndpoint({url})` →
    `{removed, deactivatedOnly?}`; implemented for Stripe, PayPal, RazorPay (switch-off),
    Adyen, Checkout.com, Authorize.net, Square. Catalog `webhook.removalInstructions(url)` for
    the gateways the operator registers by hand (Braintree, GoCardless, Cashfree) and for
    RazorPay. The DELETE route returns `webhook_removal {status, instructions}`
    (`removed | deactivated | not_found | manual | failed | not_applicable`); it runs after the
    delete commits and never fails it. Live-proven on all seven.
  - **Webhook secret fallback.** `webhook_secret_fallback` / `_until` / `_kind` (platform-owned
    credential keys). A rotation keeps the replaced secret for 24 h (`previous`); a RazorPay
    rotation whose PUT failed keeps the sent secret for 7 days (`unconfirmed`) and the first
    delivery it verifies promotes it. `ingestGatewayWebhook` verifies with the stored secret,
    then with the fallback (`resolveAdapterWithWebhookSecret`). Adyen live: an old-key delivery
    verifies inside the window and is refused after it.
  - **Authorize.net** money calls on a profile look up our reference first (unsettled list,
    then the customer's settled list, which holds only settled transactions — measured), so a
    key re-sent after the 8 h duplicate window returns the earlier transaction.
  - **Checkout.com** `fetchRefundStatus` reads `/payments/{charge}/actions`; the contract's
    `fetchRefundStatus` input gains optional `providerChargeId` (the stale-refund sweep passes
    it). **Adyen** sessions carry `countryCode` from `ProviderContact.country` (Drop-in 6
    refuses to start without it).
  - Catalog: `CredentialField.optional` (Braintree `merchant_accounts`), and
    `GET /v1/gateways` exposes `optional` and `webhook_account_id_in_path`.
  - The portal's add-card list offers gateways that vault through a setup intent only (Mollie).
  - Gates: `verify:gateway` WH (fallback, promotion, removal), `verify:authorizenet` (pre-send
    lookup), unit `gateway-catalog`, `storefront-return-params`.

- **2026-10-25** — **Mollie adapter (`providers/mollie.ts`, key `mollie`).** Payments API v2
  over plain HTTP; one credential, `api_key`, whose `test_`/`live_` prefix must match the
  account's mode (the factory refuses a mismatch). Methods `card`, `sepa_debit` (EUR), `paypal`.
  Recurring uses Mollie mandates, never Mollie Subscriptions: a hosted `sequenceType: first`
  payment (`createIntent` setup, `redirect` mode) creates the mandate — cards (with Apple Pay /
  Google Pay, which Mollie refuses by name, so they ride `creditcard`) for EUR 0.00; iDEAL,
  Bancontact, Belfius, KBC, EPS and Pay by Bank make a SEPA mandate for EUR 0.01 (measured: a
  0.00 first payment silently falls back to card). Renewals are `recurring` payments on the
  mandate; `initiator` has no Mollie field. "Pay now" is a hosted `oneoff` with no method and no
  customer, so every enabled method shows and nothing becomes a stored instrument
  (`vaultPaymentMethod` accepts only a paid FIRST payment's mandate, or an `mdt_` of the same
  customer). The method a one-off was paid with is `ChargeResult.methodUsed` (the
  shared contract; stored as `payments.method_type` via `methodTypeOf`, and kept raw in
  `payments.metadata.payment_method_used` on a consume): `card`, `apple_pay`,
  `google_pay`, `sepa_debit`, `paypal`, else Mollie's own method name (`ideal`, `twint`, …). Webhooks: the classic per-payment `webhookUrl` carries only `id=tr_…`, unsigned; the
  adapter fetches the payment (and its refunds and chargebacks) with the API key and trusts only
  that, so a forged id books nothing. Each fact gets a state-derived event id (`tr_…:paid`,
  `re_…:refunded`, `chb_…:created`), so redeliveries dedupe. Catalog secret `credential`; a query
  string is accepted (measured), so no `accountIdInPath`. The URL comes from the new factory
  `ctx.notificationUrl` (built in `registry.ts` by `providers/notification-url.ts`, which
  `buildNotificationUrl` now delegates to); a localhost URL is left out because Mollie refuses
  it. Next-gen signed webhooks: verified (`X-Mollie-Signature`, HMAC-SHA256) when a
  `webhook_secret` exists, then fetched back the same way; not provisioned (the Webhooks API
  answers 403 to an API key; it needs an organization access token) and refund/chargeback
  events are still beta there. Idempotency: Mollie's `Idempotency-Key` (replay measured:
  `idempotent-replayed: true`); a lost answer retries under the same key (409 = in flight),
  then finds the payment by our metadata, else `ProviderIndeterminateError`. SEPA failures carry `bankReasonCode` and are
  flagged reversals (late failure); a chargeback is `dispute.created` + `funds_withdrawn`, a
  reversal `funds_reinstated`. Refund ids are `re_…:tr_…` (Mollie reads a refund under its
  payment). Gates: `verify:mollie` (offline, PROVIDER), `verify:mollie-live` (test API, walks
  Mollie's test-mode pages over HTTP). A card first payment needs a browser (Mollie Components);
  proven once over CDP (2026-10-25). Every setup without a fixed method costs EUR 0.01, also when
  the payer then picks a card (measured). The 0.01 is not booked: consuming the setup refunds it
  (fire-and-forget, one Idempotency-Key per payment), and its refund maps to no event.

- **2026-10-24** — **Adyen adapter (`providers/adyen.ts`, key `adyen`).** Cards over the
  Checkout API v71 and the Management API v3, plain HTTP. Credentials `api_key`, `client_key`,
  `merchant_account`, `live_url_prefix` (live host `<prefix>-checkout-live.adyenpayments.com`;
  a test account types `test`, the field is required by the create form). Customerless
  (`noCustomerIds`): `shopperReference` = our customer ref, carried on the vaulted ref as
  `providerCustomerId`. Buyer flow `mode: 'sdk'`: `createIntent` opens a Checkout session (setup:
  amount 0, `storePaymentMethodMode: enabled`, `Subscription`; payment: `manualCapture`), Drop-in
  6.46.0 (SRI, `adyen-dropin-dialog`) runs card entry and 3DS and returns `sessionResult`;
  `submitClientResult` reads `GET /sessions/{id}?sessionResult=`, which carries the stored token
  and the payment pspReference (measured). Charges: `ContAuth` + `Subscription` (recurring) or
  `UnscheduledCardOnFile` (otherwise / no initiator) with `captureDelayHours: 0`; a stored card
  sent as `Ecommerce` or `CardOnFile` is refused without a CVC (measured, 14_029), so a
  buyer-present server charge is `ContAuth` too. `Idempotency-Key` on every money call (≤ 64,
  replay measured). References carry a kind prefix (`tmc:` charge, `tmp:` intent, `tms:` setup,
  `tmf:` refund…) that marks ownership and routes `AUTHORISATION`. Refunds: partial → `/refunds`,
  full → `/reversals`; always `pending` until the webhook (no GET exists). Webhooks:
  `provider_minted` — `provisionWebhookEndpoint` lists/creates a standard JSON webhook and calls
  `generateHmac` (works with the test key: the credential has "Management API — Webhooks read and
  write"). Each `notificationItems` entry is HMAC-checked (hex-decoded key, Adyen's published
  vector passes); one bad item rejects the delivery; each item keeps the id
  `psp:eventCode:success`. Mapping: AUTHORISATION → charge / intent / setup events by prefix;
  CAPTURE → `charge.succeeded`; CAPTURE_FAILED → `charge.failed` flagged as a reversal;
  CANCELLATION → `intent.voided`; REFUND / REFUND_FAILED / REFUNDED_REVERSED; chargebacks
  (NOTIFICATION_OF_CHARGEBACK → created; CHARGEBACK → created + funds_withdrawn; reversed →
  funds_reinstated; second chargeback / pre-arbitration). Declines: `ADYEN_CODE_TABLE` /
  `ADYEN_RULES` on `refusalReasonCode`, API errors as `api:<errorCode>`, Mastercard advice code
  wait. Gates: `verify:adyen` (offline), `verify:adyen-live` (test account).

- **2026-10-24** — **GoCardless adapter (`src/providers/gocardless.ts`).** Bank Direct Debit
  over plain HTTP (`GoCardless-Version: 2015-07-06`, Bearer token, `Idempotency-Key`); host
  from the account's `livemode`. Rails: Bacs (GBP), SEPA (EUR), ACH (USD), each proven on the
  UK sandbox. Credential `access_token`; webhook secret `operator_pasted` (no endpoint API).
  - **Setup:** `createIntent(setup)` / `initiateVaultSetup` create a Billing Request
    (`mandate_request` with currency + scheme, tagged `tmbilling_ref`) and a hosted flow →
    `mode: 'redirect'`. `consumeIntent` / `vaultPaymentMethod` read the mandate + bank account
    (bank name, account ending in `last4`, scheme in `mandate.rail`); `vaultPaymentMethod`
    refuses another customer's mandate. `billing_requests.fulfilled` → `intent.setup_succeeded`.
  - **Charge:** one Payment on the mandate, `retry_if_possible: false` (dunning is ours), answers
    `pending`. A 409 `idempotent_creation_conflict` returns the earlier payment; a 5xx or a
    transport error is retried once under the same key, then `ProviderIndeterminateError`.
  - **Settlement:** `payments.confirmed` → `charge.succeeded` (skipped as `charge.updated` when the
    payment has since failed — events arrive out of order); `failed` → `charge.failed` flagged as a
    reversal, so a failure after `confirmed` takes the late-failure path; `charged_back` →
    `dispute.created` + `dispute.funds_withdrawn` (amount read from the payment, dispute id
    `<PM>:chargeback`); `chargeback_cancelled` → `dispute.funds_reinstated`; `paid_out` and the
    `*_settled` payout lines are persist-only `charge.updated`. Refund events → `refund.pending` /
    `charge.refunded` (running total from `amount_refunded`) / `refund.failed`. Mandate events →
    `payment_method.mandate_updated` from the mandate's current status.
  - **Webhooks:** hex HMAC-SHA256 of the raw body in `Webhook-Signature`; each event in a batch
    keeps its own `EV…` id. Ownership from `resource_metadata.tmbilling_ref`.
  - **Backstop:** `settlementReport` (60 min / 24 h) — `pollSettlements` reads `GET /events`.
  - `mandates: false` (no per-debit ceiling on these schemes, and GoCardless accepts a debit on a
    pending mandate), `gatewayNotifiesPayer` on every rail (GoCardless sends the advance notice).
  - Refunds send `total_amount_confirmation` = prior refunds + this one; a refused refund is a
    `ProviderRefusalError` naming the cause (refunds disabled on the account, payment not confirmed).
  - Decline table `GOCARDLESS_CODE_TABLE` / `GOCARDLESS_RULES` from `details.cause` and API reasons.
  Gates: `verify:gocardless` (offline, in the PROVIDER group), `verify:gocardless-live` (sandbox,
  not in verify-all), plus fixtures in `verify:webhook-dedup`, `verify:gateway` C3 and
  `verify:gateway-vocabulary`.

- **2026-10-24** — **Braintree adapter** (`providers/braintree.ts`, key `braintree`), cards only,
  over the GraphQL API (`Braintree-Version: 2019-01-01`, Basic auth, sandbox/live host from
  `livemode`; no SDK). Credentials `merchant_id`, `public_key`, `private_key`,
  `merchant_accounts` (`USD` or `USD=acct, EUR=acct`; one currency per merchant account,
  `capabilities.currencies` = its keys, an unmapped currency is refused before any call).
  Ids: customers and cards are GraphQL global ids; charges and refunds are LEGACY ids (what
  webhooks and disputes carry), turned back into `base64("transaction_<id>")` for a mutation.
  Every money mutation sends `apiRequestKey` (Braintree's at-most-once processing): 915233
  (in flight) and a lost connection → `ProviderIndeterminateError`; 915232/915234 stamp the
  transaction they name (`markStrandedObject`) and throw. `orderId` = `tmbilling_ref:<ref>` is
  the ownership tag. Declines come back as a transaction (`PROCESSOR_DECLINED`,
  `GATEWAY_REJECTED`, `FAILED`) and go through `BRAINTREE_CODE_TABLE`/`BRAINTREE_RULES`
  (processor 2000–3000, settlement 4001–4026, gateway rejection reasons; 91518 = card deleted).
  Buyer flow is `mode: 'sdk'`: `createIntent` mints a client token (no customer id, so Drop-in
  cannot vault past our verification) and a stateless `btci_…` id carrying customer, merchant
  account, amount and ref; `submitClientResult` vaults the nonce with verification (setup →
  card global id) or authorizes it (payment → transaction id); `consumeIntent` reads the card
  or captures; `voidIntent` voids (`held` from a pre-read). A full refund is
  `reverseTransaction` (void before settlement); a partial one needs a settled sale, else a 400
  with the remedy. Webhooks: `credential` / `url_only`; `bt_signature` = `public_key|HMAC-SHA1`
  keyed by SHA1(private key), over `bt_payload` with or without its trailing newline. Disputes
  (opened → created, plus `funds_withdrawn` for a chargeback; won; lost/accepted/expired →
  lost), `transaction_settled` → `charge.succeeded`, settlement declined → `charge.failed`
  (sale) or `refund.failed` (credit), `refund_failed`, `transaction_reviewed` →
  `review.closed`; everything else, Braintree subscriptions included, is `unknown`. Event id =
  kind + subject id + timestamp. Storefront: Drop-in 1.48.0 (SRI) in `braintree-dropin-dialog`,
  hosts added to the CSP. Contract: `ChargeInput.initiator` `{by, recurring}` (renewals
  `merchant`/recurring, top-ups `merchant`, signup `customer` on-session) →
  `paymentInitiator` RECURRING / RECURRING_FIRST / UNSCHEDULED (absent = UNSCHEDULED).
  Gates: `verify:braintree` (offline, in PROVIDER), `verify:braintree-live` (sandbox, 25/25).
  Not built then: PayPal through Braintree, 3D Secure, the account updater webhook (built 2026-10-28, 5e).
- **2026-10-24** — **Cashfree adapter (`providers/cashfree.ts`), India, INR only.** Mandates
  are Cashfree Subscriptions with `plan_type: ON_DEMAND` (UPI Autopay, eNACH, card); the
  subscription id (`tms_<16 hex>`, ours) is the vaulted token and `plan_max_amount` the
  ceiling. Buyer authorization is `mode: 'sdk'` (`{kind, sessionId, environment}`) run by
  `dashboard/lib/cashfree-checkout.ts`: `subscriptionsCheckout` leaves the page and Cashfree
  POSTs the buyer back (`buyerReturnByPost`); one-time invoice payments are PG orders paid in
  Cashfree's modal (`createIntent({purpose:'payment'})`, auto-captured, `intentVoid: false`).
  Debits: UPI uses the controlled flow — `preDebitNotice` {upi, 24 h lead, 1 debit per
  notice, exact amount}; `notifyUpcomingDebit` = notify-mandate (accepted = `sent`, a FAILED
  notice arrives as `pre_debit_notice.updated`), `charge()` with the notice = execute-mandate.
  The notice's schedule date and window skip NPCI's UPI peak hours (10:00–13:00,
  17:00–21:30 IST); measured: an execution before the schedule date is refused ("Payment
  attempt date cannot be before the scheduled date"). eNACH and card use Raise-a-Charge
  (T+1 date, T+2 after 21:00 IST; Cashfree notifies the payer, `gatewayNotifiesPayer`).
  Ids carry their parent so a webhook rebuilds them: charge `sub:<payment id>` (the payment id
  is `<subscription id>-<12 hex>`), `ord:<order>:<cf_payment_id>`; refunds `subrf:` / `ordrf:`.
  Webhooks: `credential` / `url_only`, Base64 HMAC-SHA256 of timestamp + raw body with the
  Secret Key, refused outside a 6 h window; dedupe on `x-idempotency-key`, else type + object
  + status + event time. Decline table `CASHFREE_RULES` (free-text failure reasons). The
  account's mode picks `sandbox.cashfree.com` or `api.cashfree.com`. **Contract addition:**
  optional `contact` on `InitiateVaultSetupInput` and `CreateIntentInput`, filled by the engine
  from the customer (`providerContact`), because Cashfree takes email and phone on each
  subscription and order and keeps no customer object. Gates: `verify:cashfree` (offline),
  `verify:cashfree-live` (sandbox; the UPI mandate needs one click on Cashfree's simulator
  page, `CASHFREE_LIVE_WAIT_S` waits for it).
- **2026-10-27 (fix)** — **A Stripe charge whose answer is lost is pending, not failed.**
  `charge()` turns a connection error, 5xx, 429 or 409 (after the SDK's own retries) into
  `ProviderIndeterminateError`, carrying the PaymentIntent id Stripe kept. Before, it threw a plain
  error, collection booked a retriable failure, and the next attempt's new key could charge the
  payer twice. Found by the gateway conformance suite (S7/S8). Test: `stripe-charge-lost-answer`.
- **2026-10-26 (fix)** — **An India debit's pre-debit wait carries its charge time.**
  `intent.requires_action.actionDeadline` reads `next_action.card_await_notification
  .charge_attempt_at` as well as `processing.card.customer_notification.completes_at`. It was null
  on the `card_await_notification` answer, so `authenticate_by` and the intent's
  `nextAction.deadline` were empty. Regression: `stripe-webhook-any-version.test.ts` (captured
  India debit).

- **2026-10-26 (fix)** — **Stripe webhooks book the same money on any API version.** An
  endpoint delivers events in its own API version (an unpinned one in the account default,
  production's is 2020-03-02); the SDK is pinned to `STRIPE_API_VERSION` (2026-05-27.dahlia).
  - `provisionWebhookEndpoint` pins new endpoints to `STRIPE_API_VERSION`. An account allows 3
    distinct non-default endpoint versions; Stripe refuses the 4th with an `invalid_request_error`
    (no code). On that refusal the endpoint is created unpinned and
    `stripe_webhook_endpoint_unpinned` is logged. Existing endpoints are not touched.
  - `normalizeWebhook`: an event below (or above) our version that books money or changes a
    payment method is normalized from its object read by id at our version
    (`charges` / `paymentIntents` / `refunds` / `disputes` / `paymentMethods` / `setupIntents` /
    `mandates.retrieve`). The payload gives only the id, the kind, the type and `created`. No read
    for: an event at our version (same shape); ignored types; record-only types (`charge.updated`,
    `payment_intent.created`, payouts, reserve holds, fraud warnings, reviews); a deleted legacy
    card or source. Cost per event below our version: 1 read (`charge.refunded`: 2, read +
    `refunds.list`).
  - A failed read books nothing: the event carries `unresolved`, `handleProviderEvent` records
    `error`, the route answers 502 and Stripe redelivers. A GW-7 replay of that row fails the same
    way (it re-runs the stored normalized event); Stripe's own redelivery or "Resend" recovers it.
  - Proof: `test/unit/stripe-webhook-any-version.test.ts` and `verify:stripe-any-version` (in
    `verify:all`) on flows captured from the test account at 2017-08-15, 2019-02-19, 2020-03-02,
    2022-11-15 and dahlia, including a refund that failed 68 minutes later and an India card
    e-mandate (setup, mandate active, pre-debit wait, settled debit) (fixture `test/unit/fixtures/stripe-webhook-any-version.json`, ids
    replaced). `lib/stripe-double.ts` stands in for api.stripe.com in route suites.

- **2026-10-26 (fix)** — **Stripe webhooks are correct in both API versions an endpoint can
  render.** An endpoint created without `api_version` receives events in the account default
  (2020-03-02), while the SDK calls the API at 2026-05-27.dahlia.
  - `payment_method.card_automatically_updated` (the pre-2020-08-27 name of the card updater)
    maps to `payment_method.updated`. It was dropped, so a reissued card stayed expired.
  - Refunds book from the Refund object, which is the same in every version: a succeeded
    `refund.created` / `refund.updated` / `charge.refund.updated` normalizes to
    `charge.refunded` with `refunds` (one record per refund id). `charge.refunded` carries
    every refund too: from the embedded `refunds` list (before 2022-11-15), else from
    `refunds.list({ charge, created ≤ event })`. A failed read reports none; the Refund
    events still book. Pending updates stay `unknown`; created-and-pending stays
    `refund.pending`.
  - Decline codes `payment_intent_payment_attempt_expired`, `payment_method_customer_decline`
    (→ `authentication_required`, park) and `payment_method_provider_decline`
    (→ `card_declined`, retry then park).
  - `webhook_secret_next`: an optional second Stripe signing secret, platform-owned (kept on a
    credential update). `normalizeWebhook` accepts either. Prep for replacing the endpoint;
    no endpoint is created or changed here.
  - `verify:stripe-webhook-versions` (in `verify:all`); fixtures in
    `test/unit/fixtures/stripe-webhook-versions.json`.
- **2026-10-26 (fix)** — **RazorPay conformance: refunds, late captures, lost answers.**
  - `refund.processed` now carries the refund id and the payment's running `amount_refunded`.
    Without them a partial refund made `applyRefund` assume a full one and book the rest of
    the payment as a phantom `out_of_band` refund.
  - `payment.failed` followed by `payment.captured` (late authorisation, a UPI payer retry) is
    booked: catalogue `settlement.lateCaptureAfterFailure` (RazorPay only), same-amount capture,
    through `reconcileAbandonedCapture`. Logged as `late_capture_after_failure`.
  - A lost answer (transport error, 5xx, unreadable body, accepted-without-id) on
    `/payments/create/recurring` asks `GET /orders/{id}/payments`; if that cannot answer it throws
    `ProviderIndeterminateError` stamped with the order id. The engine books `timeout`; the
    capture/failure webhook resolves it through `order_id` and adopts the payment id.
    `fetchChargeStatus` accepts an `order_…` id. On refund create the same shape finds the refund
    by our `notes.tmbilling_ref` (`locateRefund`, `GET /payments/{id}/refunds`), else throws
    `ProviderIndeterminateError`.
  - Token statuses `cancellation_initiated` and `expired` normalise to `cancelled` (dead).
  - `refunded` with `captured: false` is not money taken: `fetchChargeStatus` → failed,
    `fetchIntent` → failed (was pending / consumed).
  - Payment-intent order notes keep RazorPay's limits (15 pairs, 256 characters).
  - Comments and catalogue text corrected: the token cancel call is documented (not built), the
    pre-debit notice is RazorPay's, `payment.dispute.under_review` is mapped.
  - Proof: `test/unit/razorpay-conformance.test.ts` (17 of 19 fail on the old adapter),
    `verify:webhook-inbound` (13 new checks fail on the old engine), `verify:razorpay` (real
    refund + payment entities from the test account).

- **2026-10-25 (fix)** — **Stripe pay-now offers every method the account has; PayPal stops
  offering cards.**
  - Stripe: a pay-now PaymentIntent (`CreateIntentInput.captureOnConfirm`) is
    `capture_method: automatic` with `payment_method_options.card|link.capture_method: manual`
    and metadata `tmbilling_capture: on_confirm`. `fetchIntent` exists (`intentStatus: true`) and
    reads `latest_charge` to tell a capture at confirm from one of ours. A server-side confirm with
    no return URL sends `automatic_payment_methods.allow_redirects: never`, because Stripe refuses
    that confirm when the account has a redirect method.
  - PayPal: `capabilities.methods` and the catalogue are `paypal` only. Every vault is a wallet;
    the "Cards" option enabled nothing and showed buyers a card row that saved a wallet. Card
    vaulting needs PayPal's hosted card fields, which are not built. The storefront sends
    `method_type: paypal`, which the setup routes now accept.
- **2026-10-24 (fix)** — **RazorPay webhooks register on create and rotate safely.**
  - A plain `POST …/webhook_endpoint` (the card's "Re-check endpoint") never called RazorPay: the
    secret minted at creation made the account `configured`, so it returned early. Only "Rotate
    secret" registered. Now a `paste_required` account registers on a plain call, with its
    EXISTING secret, so a hand-pasted secret stays valid if registration fails.
  - Account create over the API (`registerWebhookEndpointOnCreate`) registers straight away for
    every gateway with webhook material. Best effort: a failure never fails the create. Skipped
    without `WEBHOOK_BASE_URL`, which keeps tests off the network.
  - Rotation (`force`) registers the new secret FIRST and stores it only once RazorPay accepts it.
    A refused PUT keeps the old secret (RazorPay still holds it) and answers "We could not rotate
    the webhook secret…". RazorPay signs retries of earlier events with the old secret, so those
    retries fail verification after a rotation; we keep no dual-secret window.
  - One event list, `RAZORPAY_WEBHOOK_EVENTS` (gateway-catalog), feeds both the registration and
    the manual steps, which now name each event instead of "select all events". Steps use the
    current menu path (Account & Settings → Website and app settings → Webhooks).
  - The card's toast reads the mode the call returned. Regression: `verify:gateway` WH (stubbed
    RazorPay API).
- **2026-10-24** — **Checkout.com adapter** (`providers/checkoutcom.ts`, key `checkoutcom`,
  display "Checkout.com"; not `checkout`, which is our hosted checkout), cards only, Unified
  Payments API over plain HTTP. Credentials `secret_key`, `public_key`, `processing_channel_id`,
  `api_prefix` (the account host `https://{prefix}.api[.sandbox].checkout.com`; a pasted base
  URL also works) and `default_country`. The key prefix must match the business mode
  (`sk_sbox_`/`pk_sbox_` = test), else `GatewayResolveError`. Money calls send
  `Cko-Idempotency-Key`; a 409 (concurrent duplicate), 429, 5xx or lost connection is
  `ProviderIndeterminateError`; a 401 names the key and the prefix. Amounts convert to
  Checkout.com's own minor units (CLP ×100; JPY full; KWD ×1000). Customers: email required
  (refused before any call); `customer_email_already_exists` reuses that customer; the
  billing country rides customer metadata (`billing_country`), else `default_country`.
  Saving a card: `mode: 'sdk'` with Flow (`checkoutcom-flow-dialog.tsx`); `createIntent` /
  `initiateVaultSetup` open a payment session (setup = amount 0, `payment_type: Recurring`,
  3DS `challenge_requested_mandate`; payment = `Regular`, `capture: false`) and a stateless
  `ckoi_…` id carrying session, customer, currency, amount and ref. `submitClientResult` takes
  `{payment_id}`, reads the payment and accepts it only for this session (or our ref), this
  customer and this amount. The stored card is `src_…`; the initial payment id rides
  `ProviderMandate.reference` with no rail (no notice, not serialised) and becomes
  `previous_payment_id` on merchant-initiated debits. `vaultPaymentMethod` also takes `tok_…`
  (0-amount verification here), `pay_…` and `src_…`. Initiator → `payment_type` /
  `merchant_initiated`: absent → Unscheduled/MIT, merchant+recurring → Recurring/MIT,
  merchant → Unscheduled/MIT, customer+recurring → Recurring/CIT, customer → Regular/CIT.
  `charge()`: 201 Authorized/Captured → succeeded, Declined → failed, 202 with a redirect →
  `requires_action` (`redirect_to_url`, `approvalRequired: true`). Refund = 202 with the refund
  action id (`act_…`) → pending; there is no read by action id, so no `fetchRefundStatus`.
  Holds: `createIntent` with a stored card authorizes `capture: false`; capture and void are
  202. Webhooks: `provider_minted` — `provisionWebhookEndpoint` creates a Workflow (gateway,
  dispute and `vault_rtau` events, scoped to the processing channel) whose webhook action signs
  with a key we generate; we store it as `webhook_secret` and the `wf_…` id. A re-provision
  deletes our earlier workflow for the same URL. `Cko-Signature` = HMAC-SHA256 of the raw body,
  hex (base64 also accepted). Events: captured → `charge.succeeded`; approved →
  `charge.succeeded` (our charge) / `intent.authorized` (our hold) / `charge.pending` (untagged);
  declined and capture-declined → `charge.failed`; refunded → `charge.refunded` (running total);
  refund declined/pending → `refund.failed`/`refund.pending`; voided → `intent.voided`; returned →
  `charge.reversed`; disputes → created (+ `funds_withdrawn` on received) / won / lost / closed;
  `card_updated` → `payment_method.updated` per source. `metadata.tmbilling_ref` = ownership,
  `metadata.tmbilling_kind` = charge / intent / setup. Decline table `CHECKOUTCOM_CODE_TABLE` +
  `CHECKOUTCOM_RULES` (response codes 20xxx/30xxx/4xxxx; `source_id_unknown` = card deleted;
  merchant-setup codes hidden from the payer); Visa/Mastercard network codes and advice waits as
  on Stripe. Gates: `verify:checkoutcom` (offline, in PROVIDER), `verify:checkoutcom-live`
  (sandbox). Not built: wallets and APMs, SEPA/Bacs/ACH, the nominal-amount retry for issuers
  that refuse a 0-amount check.
- **2026-10-25** — **Square adapter (`providers/square.ts`, key `square`)**, REST v2 over plain
  HTTP (`Square-Version` 2026-09-16; host `connect.squareupsandbox.com` / `connect.squareup.com` from
  the account's mode). Credentials `access_token`, `application_id` (sandbox prefix must match the
  mode), `location_id` (one currency per location; another currency fails as
  `gateway_request_rejected`, measured `INVALID_VALUE` on `amount_money.currency`). Renewals:
  Cards API cards on a Square customer (found by `reference_id`), charged with
  `POST /v2/payments` + `customer_details.customer_initiated` from `ChargeInput.initiator` (Square has
  no recurring flag; absent = merchant). Buyer flow `mode: 'sdk'` (Web Payments SDK,
  `square-payments-dialog.tsx`): setup offers cards only (`cnon:` → `POST /v2/cards`); pay-now also
  offers Apple Pay, Google Pay, Cash App Pay and Afterpay (authorized with `autocomplete: false`,
  captured on consume, partial capture by lowering the amount first, all measured) and ACH
  (`autocomplete` must be true, measured: the token waits in a `sqb_` intent id and is debited at
  consume → `pending`, settled by webhook or the sweep). The method paid with rides
  `ChargeResult.methodUsed` into `payments.method_type` (and, raw, into
  `payments.metadata.payment_method_used` on both consume inserts).
  Not reusable, so never saved: Cash App Pay (`CreateCard` from its payment → `INVALID_CARD_DATA`,
  measured), ACH bank on file (`POST /v2/bank-accounts` makes a VERIFIED `bact:` but charging it
  answers `NOT_FOUND`, measured; recurring bank-on-file is gated by Square), Afterpay, and wallet
  tokens (no sandbox token; not stored). Idempotency: every create sends a key derived from ours
  (≤45); a repeat returns the original object (measured, also for declines and refunds); a lost
  answer is replayed once, then looked up by our `reference_id` (`tm` + 38 hex) in the location's
  last day of payments (the list lags by seconds, measured), else `ProviderIndeterminateError`.
  Refunds: captured → `POST /v2/refunds` (any amount; full = total − refunded); uncaptured →
  cancel (full only). Webhooks: `provider_minted`; `provisionWebhookEndpoint` lists subscriptions,
  reuses one with the same URL (retrieve returns `signature_key`, list does not), else creates one;
  HTTPS only (measured `HTTPS_ONLY`); the query string is accepted, so the URL keeps `?id=`.
  Signature `x-square-hmacsha256-signature` = base64 HMAC-SHA256 of URL + raw body with the key
  text (Square's own published vector passes); the route now passes `notificationUrl`
  (`NormalizeWebhookInput`) built by `buildNotificationUrl`. Events: payment.* by status
  (COMPLETED → charge.succeeded, APPROVED → intent.authorized, PENDING → charge.pending, CANCELED →
  intent.voided, FAILED → charge.failed with the decline), refund.* (COMPLETED → charge.refunded,
  PENDING → refund.pending, REJECTED/FAILED → refund.failed), dispute.created/state.updated
  (WON/LOST/ACCEPTED final, others upserted), card.automatically_updated/updated →
  payment_method.updated, card.disabled/forgotten → payment_method.detached. Payload shapes from
  Square's subscription test endpoint; no real delivery received yet. A card cannot be deleted:
  `deletePaymentMethod` disables it. Decline table `SQUARE_CODE_TABLE` / `SQUARE_RULES`. Method
  used: `card`, `apple_pay`, `google_pay`, `cash_app_pay`, `afterpay`, `us_bank_account`. Real
  deliveries through a tunnel matched the test-endpoint shapes and verified (2026-10-25). Gates:
  `verify:square` (offline, PROVIDER), `verify:square-live` (sandbox, headless test tokens).
- **2026-10-24** — **Authorize.net adapter (`providers/authorizenet.ts`, key `authorizenet`),
  cards only**, over the JSON API (no SDK; host `apitest`/`api.authorize.net` from the account's
  mode). Credentials `api_login_id`, `transaction_key`, `signature_key` (128 hex, checked at
  build). Every response starts with a UTF-8 BOM (measured; stripped by the adapter and now by
  `redactBody`); body elements follow the XSD order. CIM: one customer profile per customer
  (`merchantCustomerId` = `boundedProviderKey(ref, 20)`; a duplicate E00039 names the existing
  id), one payment profile per card; the ref carries both ids. Buyer flow `mode: 'sdk'`:
  AcceptUI.js hosted form (SAQ A) with the API Login ID and the Public Client Key read from
  `getMerchantDetails` (nothing for the operator to paste) → nonce → `submitClientResult`
  saves it (`validationMode` liveMode on live, testMode on the sandbox) or authorizes it.
  Stored-credential flags from `ChargeInput.initiator`: merchant+recurring → `recurringBilling`;
  merchant one-off or unknown → `isSubsequentAuth`; customer+recurring →
  `isFirstRecurringPayment` + `recurringBilling`; customer one-off → `isStoredCredentials`. No
  `subsequentAuthInformation`: with profiles the gateway stores the network id. Idempotency
  without a header: `invoiceNumber` = `refId` = `tm` + 18 hex of the key, `duplicateWindow`
  28800 s; a repeat answers reason 11 WITH the original transId, which is read back (measured);
  a lost answer is looked up on the profile by invoice number, else `ProviderIndeterminateError`.
  Refunds decided per transaction: unsettled → void (full only; partial → 400 with the remedy);
  settled card → `refundTransaction` (last 4 + `XXXX`); settled bank debit → refused. Webhooks:
  `credential`; `provisionWebhookEndpoint` registers through the REST API (list → reuse/PUT, or
  POST), and the URL carries the account in the PATH (`webhook.accountIdInPath`; a query string
  is refused, measured) — new route `POST /v1/gateway_webhooks/:gateway/:id`.
  `X-ANET-Signature` = HMAC-SHA512 of the raw body, `sha512=` prefix and hex case optional; the
  hex-decoded key and the key text are both accepted (the webhook form is not measured; the
  response hash uses the hex-decoded key, measured). Events: authcapture / priorAuthCapture →
  charge.*, authorization → intent.*, refund → charge.refunded (original from the refund's
  read), void → charge.refunded / intent.voided / refund.failed by transaction type, fraud.* →
  review.* (+ the outcome), paymentProfile.deleted/updated → payment_method.*; payment events
  read `getTransactionDetails` (payloads carry no type or currency). Event id `anet_<notificationId>`.
  Decline table `AUTHORIZENET_CODE_TABLE` / `AUTHORIZENET_RULES` (reason codes; E00040 →
  `payment_method_not_found`; setup refusals incl. 39 currency and 290 required fields →
  `gateway_request_rejected`). Gates: `verify:authorizenet` (offline, PROVIDER),
  `verify:authorizenet-live` (sandbox). Not built: eCheck (`us_bank_account`), disputes (no API).
- **2026-10-24 (fix)** — **Deleting a gateway account that is still in use is refused (409).**
  `gateway_account_id` has no foreign key, so a delete left saved payment methods, unsettled
  transactions and intents pointing at nothing, and later webhooks for the account were refused
  `gateway_account_not_found`. `deleteGatewayAccount` now counts `GATEWAY_ACCOUNT_DELETE_BLOCKERS`
  (saved payment methods; transactions `in_progress`/`timeout`/`needs_attention`; intents
  `inited`/`in_progress`/`authorized`; open disputes on its payments; succeeded payments of the
  last 120 days, which refunds and chargebacks still need) and throws `GatewayAccountInUseError`,
  whose message names each count and points to status Disabled. A delete that passes also removes
  the account's `provider_customers` rows (read only with the account id). An unexpired
  `pre_debit_notices` row in `pending`/`sent` blocks too (a debit may still run under it). The endpoint at the
  gateway is still not unregistered: the adapter interface has no call for it. `verify:gateway` C1.
- **2026-10-24** — Adapter contract for the next gateways (no new adapter yet).
  `BuyerAuthorization.mode` adds `sdk` (`sdk: {provider, params}`; the browser's answer comes
  back as `client_result` and reaches the optional `submitClientResult`) and `form_post`
  (`formPost: {action, fields}`). `capabilities.buyerReturnByPost` wraps every return URL in
  the storefront's `/gateway-return?next=…` bounce (`providers/buyer-return.ts`). One method
  list in `providers/method-types.ts`. Webhook secret modes add `credential` (endpoint mode
  `url_only`) and `operator_pasted` (`secret_in`); `POST …/webhook_endpoint` takes
  `webhook_secret` for `secret_in` only, merged into the credentials and never echoed. The
  inbound route accepts form-encoded bodies; factories get `livemode`. tmtest simulates both
  modes via the `buyer_auth_mode` credential (`sdk`: nonce `tmtest_ok`/`tmtest_decline`,
  success answers a `tmtx_…` id mapped back to the intent; `form_post`: signed fields to
  `POST /v1/tmtest/form_post`, test businesses only, which posts the buyer back). Unset =
  unchanged. Gate: `verify:gateway-sdk-modes`.
- **2026-10-24** — Settlement-report polling (`settlement-report.ts`, clock pass
  `settlement_reports`, before `dunning`). For each active account whose adapter declares
  `capabilities.settlementReport` and implements `pollSettlements`: due when
  its cursor (`gateway_settlement_cursors`, 0361) is missing or `intervalMinutes` old; reads
  `[cursor − 15 min, min(now, cursor + maxWindowHours))` (first read: the last `maxWindowHours`)
  and feeds each event to `handleProviderEvent` with the account's business, `payload` = the
  event's `raw` and `request_url` = `poll:settlement_report?account=gwa_…&since=…&until=…`. The
  cursor moves (compare-and-swap) only when no event errored; the first `error` stops the window.
  One account throwing never stops the others; an account whose adapter cannot be built is
  counted `unresolvable`. Each cursor move bumps the row's `resource_version`/`updated_at`
  (shared trigger). tmtest: credential `settlement_report: "true"` (15 min / 24 h; `"fault"`
  makes every poll throw) and `TmtestProvider.returnCharge(chargeId, {occurredAt, code})`, reported
  as `charge.failed` with `data.reversal: true` (the late-failure path; R01/R09 retriable). Gate:
  `verify:settlement-report-poll`.
- **2026-10-24** — **Gateway pre-debit notices: inbound + test gateway.** `pre_debit_notice.updated`
  is routed to `applyGatewayNoticeUpdate` (invoicing), matched on the delivering gateway account
  (`InboundContext.gatewayAccountId`, set by `ingestGatewayWebhook`) and the gateway's ref, or on
  business + gateway key when the account is not known (tmtest delivery, replay); replays revive
  `preDebitNotice.executableAfter` as a Date. tmtest credentials: `pre_debit_lead_hours` (turns on
  `preDebitNotice` for card + UPI, exact amount), `pre_debit_valid_hours`, `pre_debit_max_debits`
  (default 4), `pre_debit_mode` `sync` | `async` (answers pending, then a signed
  `pre_debit_notice.updated` webhook), `pre_debit_fault=fail`, `gateway_notifies_payer` (`card,upi`).
  Notices are `tmtest_charges` rows of kind `pre_debit_notice`; a covered charge without a valid one
  is refused `pre_debit_notice_missing`. Unset credentials behave as before. Gate:
  `verify:pre-debit-notices`.
- **2026-10-21 (fix)** — **Inbound events dedupe per business, by the gateway's own event id.**
  RazorPay sends its event id in `x-razorpay-event-id`, which we never read, so the key fell back to
  `<event>_<created_at>`: two payments captured in the same second shared it and the second was
  dropped as a duplicate. And the key was platform-wide, so a gateway account connected in two
  businesses (both URLs receive every event) applied each event in whichever business answered
  first. Now: every adapter implements `webhookEventId()` (gateway id, else a body hash — never
  name + time) and `normalizeWebhook` stamps it; the key is `(provider_key, business_id,
  provider_event_id)` NULLS NOT DISTINCT (0351); `recordGatewayWebhookResponse` is business-scoped;
  a delivery that fans out to repeated ids gets `#2`, `#3`. This retires the 2026-08-01 ops trap
  below: one gateway account may now feed several businesses. Gate: `verify:webhook-dedup`
  (fixture table typed `Record<ProviderKey, …>`, so a new adapter cannot typecheck without one;
  mutation-checked against both halves).
- **2026-10-13** — **Gateway webhooks filter by gateway intent.** `intent` matches
  `normalized->>'providerIntentId'` (`seti_…`, `pi_…`, an order id). Each payment-intent attempt
  row links to its "Webhook events", because a setup refused in the buyer's browser exists only as a
  webhook — the attempt's request log shows just the 200 create. Regression: `verify:gateway` C7+.
- **2026-10-12** — **One definition per gateway.** Which gateways exist, and what differs
  between them, now lives in `src/providers/gateway-catalog.ts` (names, credential fields,
  methods, currency-bound methods, webhook-secret ownership and setup steps, async settlement,
  customer-id and phone quirks) and `src/providers/gateways.ts` (adapter factories). The
  supported-key lists, `ADVERTISED_METHODS`, `settlesAsynchronously`, the webhook-secret sets,
  the vault/setup enums and the OpenAPI enums are derived from it, and decline vocabularies
  register once in `DECLINE_SETS`. New `GET /v1/gateways` serves it to the dashboard, which no
  longer lists gateways itself. Adding a gateway: an adapter, a `ProviderKey` member, a
  catalogue entry, a factory and a decline set — each a compile error when missing.
  `test/unit/gateway-catalog.test.ts` pins that each adapter builds from its own setup fields
  and advertises what the catalogue says. No behaviour change, except that the setup route's
  OpenAPI `provider` enum now lists `stripe`, which the route always accepted.

- **2026-09-25** — **Network no-retry signals.** Stripe: MAC 21 and the `do_not_try_again` advice
  code map to `network_do_not_retry` (as MAC 03 did); a raw `network_decline_code` in Visa
  Category 1 or Mastercard's no-retry list turns a retriable decline into `network_do_not_retry`
  (brand-checked). Newly mapped decline codes that reached the retry default: `stop_payment_order`
  and `revocation_of_all_authorizations` → terminate, `do_not_try_again` → no-retry,
  `invalid_account` / `restricted_card` / `new_account_information_available` → `card_restricted`,
  and four "unknown reason" codes → `card_declined`.
- **2026-09-25 (latest)** — **Network-stated waits (`retryAfterMs`).** `NormalizedDecline` and
  `ChargeResult.failure` carry the minimum wait a network or gateway stated: Stripe reads
  Mastercard MAC 24–30 from `network_advice_code` (Mastercard cards only; the signal now carries
  `cardBrand` from the expanded `latest_charge`), RazorPay reads `duplicate_request` (30 min).
  The decline code is unchanged; dunning uses the wait as a floor.
- **2026-09-25** — **`card_restricted`.** RazorPay's `debit_instrument_blocked`,
  `debit_instrument_inactive`, `card_not_enrolled`, `card_type_invalid` and
  `international_transaction_not_allowed` normalise to it instead of `card_declined`: they
  describe the card, and only a different one pays, so smart mode parks them at once while
  `card_declined` now retries first. Family `payment_method`; retriable is unchanged (not
  terminal), so fixed mode behaves as before. tmtest gains `4000000000000069` → `expired_card`.
- **2026-09-07** — **`shadow` is no longer a gateway key.** The parallel-run adapter
  (`src/providers/shadow/`) went with the shadow programme, so `SUPPORTED_GATEWAY_KEYS` and
  `ProviderKey` drop it and `SIMULATED_GATEWAY_KEYS` is now just `tmtest`. Migration `0236`
  repoints any surviving account to `tmtest` and disables it, rather than deleting a row that
  payments and payment methods point at — `resolveAdapter` would otherwise THROW on it and take
  down every read of that business's gateway list, not just a charge. The live-business guard
  (TL-6 / C9) is unaffected: the repoint target is simulated too.
- **2026-09-06** — ✅ **#97: the currency list was deciding WHO may pay, not just where.** `currencies`
  picks which account to route to; when the account is the one that VAULTED the instrument there is
  nothing to route, because no other account can charge that token — so refusing did not pick a better
  account, it guaranteed no charge at all, on a renewal, into dunning. `selectGatewayAccount` takes
  `tokenBound` for that case (set by `resolveAccountForPm`) and warns instead of throwing. The refusal
  STAYS for `resolvePinnedAccount`, whose `gateway_account` arrives in a public request body, where
  validating the pin is a security control rather than a routing preference. `handlesCurrency` is now
  exported and case-insensitive, because `payment-methods` held a hand-rolled copy that read
  `currencies: []` as "all" where this reads it as "none" — an offered gateway the charge would refuse.
  `resolveDefaultAccountForBusiness` takes a currency, skips a default that cannot handle it, and falls
  back to the newest account that CAN. Both halves mutation-tested in `verify:gateway` (C2+).

- **2026-09-04** — ✅ **#48: a PayPal Refund is its own gateway object and inherited no tag.**
  `RefundInput.ownershipRef` has existed since #31 and the engine passes the `re_…` public id,
  but `refund()` dropped it, so every PayPal Refund we created was untagged. RazorPay stamps
  its refund through `notes` and a source scan locks that; here the field was available and
  unused. Now sent as `custom_id` via `paypalOwnershipTag`.

  ⚠️ The cost was **blindness, not a false accusation**, and the distinction is why this was
  🟡 rather than 🔴: `paypalProvenance` reads an ABSENT `custom_id` as `unknown` — *ignorance,
  never "not ours"* — and only a `custom_id` present WITHOUT our prefix as `foreign`. So an
  untagged refund of ours landed in `unclassified` and could never reach
  `ours_unattributed`, the one population that pages. Note the precondition bites differently
  per adapter: for the key-namespaced two (Stripe, RazorPay) an absent tag means `foreign`;
  for PayPal it means `unknown`.

  ⚠️ **`custom_id` is a documented request-body field on `POST /v2/payments/captures/{id}/refund`**
  — *"The API caller-provided external ID. Used to reconcile API caller-initiated transactions
  with PayPal transactions"*, max 127 chars. Verified against the endpoint schema page, **not** a
  search summary, which claimed the opposite: an unknown field on this call is a refund the
  customer does not get back, so nothing less than the schema is acceptable evidence.

  **No idempotency-key fallback here, unlike `charge()`** — absence reads `unknown` on this
  adapter, which is honest, whereas a key-derived tag would read as OURS and defeat exact-ref
  matching for nothing. Four assertions (three watched red), three mutations each killing a
  distinct set: dropping the tag kills the three positive cases; sending it unconditionally with
  a key fallback kills the absence case; and letting the tag REPLACE the body rather than join it
  kills the amount assertions — which is the one that matters, because a partial refund without
  `amount` becomes a FULL refund at PayPal.

- **2026-09-04** — ✅ **#32: PayPal's `voidIntent` could report `voided: true` while the hold survived —
  and the defect was broader than filed.** The line was `authId = authorization?.id ?? input.intentId`,
  so EVERY unresolved shape posted the ORDER id to `/authorizations/{orderId}/void` and survived only
  because the 404 was forgiven. Worse shape found: an order read successfully with no authorization and
  status `COMPLETED` — a capture-intent order whose money already moved — answered `voided: true`, so
  the engine marked the intent voided while the capture stood.

  The rule now: `voided: true` only when we can point at what ended the checkout. A provably-never-
  authorized order answers `{voided: true, held: false}` with **no HTTP call at all** (PayPal has no
  void-an-order endpoint, so the old round trip could only ever 404). Everything else THROWS rather than
  returning `voided: false`, because both callers read `false` as "the gateway refused" when it was
  never asked. Verified safe: the expiry sweep's call sits in a try/catch documented "caught, never
  rethrown", so a throw is a per-row failure, not an aborted batch.

  ⚠️ The lie had been pinned GREEN by an assertion in #30's own suite (`expect(res.voided).toBe(true)`
  for "neither could be read"). ⚠️ The operator path does NOT wrap the throw, so a raw `Error` reaches a
  500. Converting it to `PaymentIntentError` would be WRONG — that maps to 400 and would blame the
  operator for a gateway condition. ⚠️ `refund()` has the same order-id-into-a-captures-endpoint shape
  but maps a wrong id to `status: "failed"`, so it fails honestly rather than faking success.

- **2026-09-04** — ✅ **RazorPay event names are now probe-verified, TEST MODE ONLY.**
  `scripts/probe-razorpay-event-names.ts` creates one throwaway endpoint PER NAME (`active: false`) so a
  single bad name cannot cost the others, refuses any non-`rzp_test` key, and deletes only endpoints
  carrying its own URL mark. Every run also probes a known-good and a known-nonsense name and **reports
  nothing if those controls misbehave** — a probe that calls everything valid proves nothing. Only
  `refund.created` was added to the canonical list; four other probe-clean names stay unsubscribed
  because they have no handler and would only manufacture `unknown` rows.

  ⚠️ RazorPay DNS-RESOLVES the URL server-side: an `example.invalid` host returns `400 … no such host`
  for every GOOD name, so the first version of the probe would have reported all five inconclusive. The
  name check fires independently (a nonsense name still gets the name error on a bad URL), so only the
  VALID verdict needs a resolvable host.

- **2026-09-04** — ✅ **#31: every gateway call site now passes a real ownership ref, and TWO adapters
  turned out to have a trap in the obvious change.** `initiateVaultSetup` forwards the ref on RazorPay
  (both rails); `stripe.ts`'s `charge()`, `refund()` and `initiateVaultSetup` stamp `ownershipRef`
  instead of the idempotency key, which their comments had already claimed. The idempotency-key
  fallbacks were KEPT: the classifier's "no tag ⇒ not ours" rule is sound only while every object we
  create carries a tag.

  ⚠️ **Two ownership tags are load-bearing AT THEIR VALUE and must not receive the ref.** PayPal's
  setup token is tagged `customer.merchant_customer_id`, which `assertSetupTokenBelongsTo` compares to
  close CWE-598 (a setup-token id travels in a URL, so holding one must not be enough to vault someone
  else's wallet); nothing is lost, because for PayPal `providerCustomerId` IS our own `cus_…`.
  RazorPay's e-mandate auth link is the same shape — `assertAuthLinkBelongsTo` compares its
  `notes.tmbilling_ref` to a provider customer id — which is why the finer ref rides a SECOND key,
  `tmbilling_intent_ref`. Both are now guarded by tests that fail if the ref lands on the checked key.

> Marker legend: **✅** a severe (money / data-integrity) bug — found, fixed and gated in that entry ·
> **🟠** a correctness or concurrency bug · **🟢** a follow-up / cleanup. Severe entries read 🔴 until
> 2026-08-17; the red dot was scanning as an OPEN defect when every one of them was closed. An entry
> with work still outstanding says so in words ("Known, unfixed", "Not verified") — never by its marker.

- **2026-09-03** — 🟠 **`mandate_ceiling_exceeded` was two failures with OPPOSITE remedies wearing
  one code.** RazorPay's `card_mandate_current_cycle_allowed_debit_exceeds` shared the token our own
  pre-flight uses for a per-CHARGE ceiling breach, so every surface told the operator to re-authorize
  at a higher limit when the ceiling had never been the constraint. Both variants appeared within 90
  minutes on the same mandate (max ₹37,657.34): at 11:22 our pre-flight refused ₹3,18,673.16 — a
  genuine breach where raising the ceiling IS the remedy — and at 11:50 and 12:56 RazorPay refused
  ₹22,184.00 for the cycle rule, an amount smaller than the ₹33,276.00 that had already succeeded on
  it. Now `mandate_cycle_limit_exceeded`, `retriable: true`, in `PARK` and `PARK_EVEN_IN_FIXED_MODE`.
  The measurement also **retracted the previous reading of this error** (recorded above and in
  `test/unit/mandate.test.ts`) that it was the RBI ₹15,000 rule: two debits far above ₹15,000
  succeeded on this mandate, so it is not an amount rule at all. Whether it is a count limit is still
  a fit rather than a fact — RazorPay documents neither the code nor the rule. Gated in
  `verify:dunning-nonretriable` and `test/unit/mandate.test.ts`. **Known, unfixed:** whether this code
  should also join `PARKED_WITH_DEADLINE` is a product call — parking without one means no pass ever
  revisits the invoice, so the money is never collected; pairing it with a deadline needs the portal's
  `mandateBlocker` copy to stop saying "re-authorize", which is the same wrong instruction this entry
  removed elsewhere. See #14 in `docs/PROGRESS.md`.

- **2026-08-30** — **credential updates gained a REMOVAL channel; "remove this key" was
  inexpressible.** Same-day follow-up to the partial-merge fix beside it. `updateGatewayAccount` used
  to overwrite `credentials_enc` WHOLESALE, so rotating a RazorPay `key_secret` — an ordinary
  operation — silently destroyed the `webhook_secret` in the same write, leaving an account that
  registers mandates and collects real money nothing will ever mark paid. Preserving the three
  platform-owned keys (`webhook_secret`, `webhook_id`, `webhook_endpoint_id`) on silence fixed that
  and broke the other direction: with omission meaning "keep", nothing could say a key must NOT
  exist. That is not academic — it is the state the `assertVaultPreconditions` guard exists to
  refuse, and the WH-ASYNC fixtures could no longer reproduce it, so the two fixes were mutually
  exclusive until now.
  * **The semantics, in full.** `credentials` REPLACES the operator's keys and PRESERVES the
    platform's three; naming a key is always authoritative, and **`null` names a key in order to say
    it must not exist**. Keep: resend an operator key (omission removes it) / omit a platform key
    (omission preserves it). Change: send `key: "value"`, either class. Remove: omit an operator key,
    or send `key: null` — the only way for a platform key. A nulled key is DELETED, never stored as
    null, so `resolveAdapter`, `getWebhookEndpointInfo` and `serializeGatewayAccount` still read a
    plain absent key and nothing downstream has to tell null from missing. Applied on create too, so
    the "no null ever reaches storage" invariant holds for every blob this module encrypts.
  * **Why `null` and not `remove_keys: []`** — removal is expressed in the same place, and the same
    shape, as the value it removes, so a caller cannot name a key in both channels and leave the
    write ambiguous.
  * **Service-level on purpose.** `credentialsSchema` on the route is
    `z.record(z.string(), z.string().min(1))`, so a null is a 400 and tearing down webhook material
    over a credentials PATCH stays impossible — the endpoint has its own lifecycle route
    (`POST …/webhook_endpoint`, `force: true` rotates). Internal callers and fixtures need the
    channel; the wire does not.
  * Credentials remain write-only: nothing decrypted is logged or returned, asserted by
    `WH-CRED: the update path echoes no credential`. `verify:gateway` **250 → 270** across this
    wave, with WH-CRED and WH-ASYNC green together for the first time. Mutation-tested twice: treating a null as silence
    turns 3 WH-ASYNC + 2 WH-CRED red, and storing nulls instead of deleting them turns the
    "not stored as null" assertion red.
  * Unchanged residual, restated: repointing an existing account at a DIFFERENT merchant (new
    `key_id`, not a rotation) keeps webhook material bound to the old merchant. Re-provision the
    endpoint or create a new account.

- **2026-08-30** — **the `async_gateway_has_webhook` follow-up is CLOSED.** The method-aware entry
  below ends by noting that the ops invariant still read the coarse `ASYNC_SETTLEMENT_GATEWAY_KEYS`
  set, so a live Stripe account pinned to `sepa_debit` with no endpoint was refused a NEW mandate and
  never reported as an EXISTING violation. `asyncGatewayWebhookCheck` now selects `method_types` and
  reasons over `settlesAsynchronously`, and its sample carries the method vector — "a live Stripe
  account has no endpoint" is not actionable without knowing the rail. Covered in `verify:gateway`
  rather than `verify:invariants` (that suite proves SQL checks inside a rolled-back transaction;
  this is a `run` check that scans live rows and decrypts credentials): two live Stripe accounts,
  `sepa_debit` and `card`, asserted on the violation-count DELTA rather than the capped sample, then
  deleted and the count re-asserted. Mutation-tested red against the old gateway-key set.

- **2026-08-30** — **`capabilities.mandates` is now asserted against the implementation** (F-40), the
  way `intentVoid` has been asserted against `voidIntent`. The flag decides how a NULL
  `payment_methods.mandate_max_amount_minor` READS — `true` means the gateway would have told us, so
  a null ceiling is UNKNOWN and worth chasing; `false` means there is no per-debit ceiling on the
  flow we use and nothing will ever fill it — and no consumer can tell a lying flag from an honest
  one. Unlike `intentVoid` there is no adapter METHOD to probe (a mandate is derived inside the vault
  and webhook paths, and deriving a real one needs a live gateway), so the evidence is the module: an
  adapter claiming a mandate model has to construct a `ProviderMandate` somewhere
  (`describeStripeMandate`, `describeRazorpayMandate`), and one denying it never names the type at
  all. Six `verify:gateway` C3 assertions — the iff per adapter, plus "declares it explicitly",
  because absent means UNKNOWN and shipping UNKNOWN on a live adapter is the bug the flag exists to
  prevent. ⚠️ **Nothing reads `capabilities.mandates` yet** — it is declared and documented and has no
  consumer; this assertion is the only thing keeping it honest until one arrives.

- **2026-08-14** — **Buyer "Pay now", rail by rail.** Two operator asks added (**7** UPI collect,
  **8** the production netbanking bank list), both from `GET /v1/methods` on the test key.
  - `ProviderRefusalError` on the provider contract. `selectRail`'s guards produce precise,
    actionable sentences and threw a plain `Error`, so every one of them reached the caller as a
    **500** — a buyer paying a USD invoice at an INR-only account was told "Internal server error"
    while the adapter had already written the fix. Mapped to 400 in the portal and intent routes.
  - `harvestInvoiceIntent` captures an authorized `payment` intent that names an invoice, from the
    webhook. The money-side twin of `harvestSetupIntent`: without it, a buyer who completes the
    challenge and never returns leaves the amount authorized at the gateway with the invoice unpaid
    and nothing retrying it. **Not yet exercised at runtime.**
  - Pay-now passes `methodTypes`, so each rail opens its own checkout instead of every RazorPay
    customer being shown a card form; and a UPI mandate is DEBITED rather than sent to a checkout the
    account cannot render (`upi: { intent: true }` → QR only).
  - Measured: a card and a netbanking payment, both paid.

- **2026-08-10** — **Gateway authorization is real** (Phase 2b). Until now a payment intent could only
  reach `authorized` through a test-mode route that force-passed a fake challenge: four adapters
  created real gateway intents, but their callbacks were **inert**. `handleProviderEvent` dispatched
  only `charge.*` / `payment_method.*` / `dispute.*`, and every one of those handlers correlates via
  `transactions.id_at_gateway` — which an authorized-but-unconsumed intent **has no row in**. A real
  buyer completing 3DS changed nothing in our DB.
  - **Five `intent.*` terms** on `NormalizedProviderEvent`, plus `providerIntentId` as its own
    correlation field, and a dispatch branch that resolves
    `providerIntentId → payment_intents.intent_at_gateway` and acts on the intent's **current
    attempt**. Full map + replay rules: § *Payment intents* above.
  - ⚠️ **No `charge.*` term was reused for any of it**, and two earlier stand-ins were corrected:
    PayPal's `PAYMENT.AUTHORIZATION.VOIDED` moved off `charge.failed` (a released hold is not a failed
    charge — it would reverse cash never booked and re-arm dunning), and RazorPay's `payment.authorized`
    was promoted from the placeholder `unknown` to `intent.authorized`. Stripe's
    `payment_intent.succeeded` / `.payment_failed` stay money events: under manual capture they fire at
    CAPTURE.
  - **Migration 0173** — `payment_intents_gateway_intent_idx` on `intent_at_gateway` (partial, NOT
    NULL). The new correlation lookup ran a sequential scan over every intent on the platform, on the
    hot path of a webhook that must answer 2xx before the gateway starts redelivering.
  - **Stripe declines are returned, not thrown.** `createIntent` answered a declined authorization with
    a `StripeIntentFailure` exception (now deleted — nothing outside the adapter ever caught it);
    it now returns `IntentRef.failure` with the same normalized code/`retriable` flag a failed charge
    carries, and the status Stripe actually reports for the intent it left behind.
  - **RazorPay reads the mandate ceiling from `CreateIntentInput.maxAmountMinor`**, not from a
    positive `amountMinor` on a `setup` intent. One field meaning two things (a charge on the payment
    arm, a per-debit limit on the setup arm) meant a caller who passed an amount by mistake silently
    bound the mandate to it. Absent, `createMandateOrder`'s per-rail default still applies.
  - `intentVoid: false` for RazorPay is documented as a **capability**, not a gap — see the warning in
    § *Payment intents*.
- **2026-08-05** — **Buyer-selectable mandate type in the portal**, plus two correctness fixes found
  reviewing it.
  - The portal's Add-payment-method flow now offers **Card / UPI Autopay / Netbanking e-Mandate** when
    the selected gateway is RazorPay, narrowed to that gateway account's own `method_types`; the radio
    is not rendered for other gateways (they get `card`, as before). `method_type` rides the
    vault-setup routes (`/portal/v1/payment_methods/setup`, checkout's equivalent), and
    `initiateVaultSetupForBusiness` **rejects a method the chosen account does not allow** instead of
    silently substituting one. `listVaultGatewaysForBusiness` also takes a currency and drops accounts
    that cannot transact it (empty `currencies` still means "any").
  - **RazorPay: the UPI rail has its own, lower mandate ceiling.** NPCI caps an Autopay mandate at
    ₹100,000 (10,000,000 paise) by merchant category, so the card cap of 100,000,000 made RazorPay
    reject the order outright. Now clamped per rail.
  - ⚠️ **Two method-type vocabularies — do not merge them.** `capabilities.methods` (and therefore
    `gateway_accounts.method_types`) is the **canonical instrument** vocabulary that Smart Routing
    matches on, and `matchesMethod` (`gateway/router.ts`) compares it against a payment method's
    canonical `type`. `METHOD_TYPE_MAP` is the **request** vocabulary and may be richer. Apple Pay /
    Google Pay / Stripe Link are card presentations — `describeStripePaymentMethod` returns
    `type: 'card'` for them (only the BRAND differs, which is the nice part of this change) — and
    Bacs / BECS / PAD all return `type: 'bank_transfer'`. So listing any of those six as a *method
    type* produces a gateway account **no real charge can ever match**: silently unroutable. They were
    removed from `capabilities.methods` (which also fixed 6 type errors — the union rejects them) and
    from the settings picker, where `gateway-meta.ts`'s own doc comment already forbade them; the
    picker gained one honest `bank_transfer` entry covering all three direct-debit rails. A caller can
    still *request* `bacs_debit` etc. via `method_type`, which is what METHOD_TYPE_MAP is for.
  - ✅ **`verify:vault-setup` could not fail.** The verdict was `if (approvalUrl || rzpOk)` and both
    exits were `process.exit(0)`, so the entire RazorPay block — rail policy, the foreign-currency
    refusal, both mandate ceilings — could print ✗ while the suite reported PASS. `rzpOk === false` now
    exits 1; `undefined` still means SKIP. The new UPI-ceiling check asserts **acceptance** rather than
    reading the ceiling back (a UPI order does not echo the `token` block, only cards do) and was
    proven RED by raising the cap to the card limit: it fails with exactly the documented
    *"400 Max amount for UPI recurring payment … cannot be greater than Rs. 100000.00"*.
  - Not verified: the portal radio's **click path** in a browser — the storefront route needs a live
    magic-link token. Route, validation and adapter behaviour are covered by `verify:vault-setup`
    against the RazorPay sandbox.
- **2026-08-04** — **A hung gateway call now has an upper bound** (`src/providers/http.ts`).
  `providerFetch` — the shared transport for **every** non-Stripe adapter (RazorPay, PayPal) — called
  `fetch` with no `signal`, and `fetch` has no default timeout, so a gateway that accepted the socket
  and never answered held the request open forever, and with it the `Idempotency-Key` lock. Only
  Stripe had a bound, because stripe-node owns its own transport. `PROVIDER_FETCH_TIMEOUT_MS` is now
  `AbortSignal.timeout`-enforced on every `providerFetch` call at **80_000ms** — deliberately
  stripe-node's own `DEFAULT_TIMEOUT` rather than a new number, because that is the bound
  `IDEMPOTENCY_STALE_MS` (5 min ≈ 4x) was derived from, and the derivation only held for Stripe until
  now. The fix is central, not per-adapter: one `signal` in the shared helper covers RazorPay and
  PayPal at once, and a second layer inside an adapter would fight the remap below.
  **Classification is unchanged on purpose.** A timeout logs its `gateway_request_logs` row first
  (status=null, so a timed-out attempt is still visible in Gateway Activity with its gateway,
  operation, URL and duration) and then throws — exactly what Stripe's `StripeConnectionError` already
  did, and what any other network error here already did. No new error class, and **no synthesized
  `failed` ChargeResult**: a timed-out debit may well have gone through, so only the unknown-outcome
  paths (the `timeout` transaction status, inbound reconciliation) may rule on it. The DOMException
  `AbortSignal.timeout` raises says only "The operation was aborted due to timeout", naming neither
  gateway nor call, so it is restated as a plain `Error` naming both plus the bound, with the original
  kept as `cause`.
- **2026-08-01** — **Replay for a webhook whose processing failed** (`POST
  /v1/businesses/:biz/gateway_webhooks/:id/replay`, migration `0143`). A failed delivery is answered
  502 so the gateway redelivers, but every gateway caps its own retries — Stripe gives up after ~3
  days — after which an `outcome='error'` row was terminal: money had moved at the gateway, our ledger
  never learned, and nothing would try again. This is the manual handle for exactly that state.
  **Why a stored `normalized` column rather than re-running the adapter:** replay can never re-verify
  the signature. `headers` is persisted redacted (the signature is masked) and `payload` is parsed
  json, so re-serialising changes the bytes the signature covered. Both are deliberate, which makes
  the *interpretation* the thing that has to be durable — `provider_events.normalized` holds the
  normalized event that delivery produced, which is exactly what `handleProviderEvent` consumes. It is
  written best-effort: a serialization failure lands NULL and the row is simply not replayable,
  because replayability must never cost us a delivery. bigints are encoded as `{__t:'bigint',v:'…'}`
  (JSON has none) by a replacer that walks the whole tree, so a bigint field added anywhere later
  cannot start throwing on the ingest path.
  Deliberately narrow — asserted in `pnpm verify:webhook-retry` (12 checks) and again over real HTTP:
  only `error` replays (**409** with the reason otherwise, since re-running a settled event would
  re-execute handlers that book money); a replay updates the existing row and never creates a second;
  rows predating the column are refused with a reason rather than guessed at; unknown id is 404. The
  dashboard renders Replay **only on errored rows** — an always-visible button would imply settled
  events can be re-run.
- **2026-08-01** — **The inbound webhook log now records the HTTP EXCHANGE (P2).** `provider_events`
  stored what we DID with a callback (type, outcome, error, payload, headers, timings) and nothing
  about the call — the very things (`Status Code · URL · Transaction`) that make the log a debugging
  tool. Migration `0141` adds `response_status`, `request_url` and
  `transaction_public_id` — all nullable, because legacy rows and non-HTTP callers of
  `handleProviderEvent` (verify suites, replays) genuinely have no HTTP context and must stay null.
  Capture: the route builds the URL from `Host` + `req.url` and passes it as `InboundContext.requestUrl`
  (written on insert, refreshed when an errored event is reprocessed); after it decides the reply it
  calls `recordGatewayWebhookResponse` with the status it actually sent (200 / 502), stamping only the
  rows THIS delivery wrote — a replay deduped as `duplicate` never overwrites the exchange of the
  delivery that did the work. The transaction is resolved once in `handleProviderEvent` from
  `ev.providerChargeId` via `transactions_gateway_charge_idx`, so the rule is uniform across refunds /
  settlements / reversals / disputes and stays null for a callback about no charge of ours. Stored as
  the **public id**, not a uuid FK: `serializeGatewayWebhook` is a pure row → object function used by
  both the list and the drill-in, so a uuid would need a join on every read path and a forgotten join
  would render blank — indistinguishable from "no transaction". All three are serialized, filterable
  (`response_status`, `request_url`, `transaction`) and searchable; three columns + three drawer rows
  landed on the dashboard log. Asserted in `verify:webhook-inbound` (the only suite that delivers over
  real HTTP), including that an unknown charge leaves the link NULL rather than borrowing one.
- **2026-08-01** — **Imported gateway accounts keep the SOURCE id, so webhook URLs survive a
  re-import.** The notification URL is `…?id=<gateway account public id>` and that URL is registered
  **in the source gateway's own dashboard**. The importer minted a fresh `gwa_…` per run, so every
  re-import silently invalidated every registered endpoint — the gateway kept
  POSTing an id that no longer existed, each delivery 404'd, and it looked exactly like "the gateway
  stopped sending". Imported accounts now carry the source id verbatim (`gw_…`), the same
  id-stable rule customers and subscriptions already followed. Consequences, both asserted in
  `pnpm verify:import-id-stable`: the id is deterministic from the source, so re-imports need no
  action at Stripe/RazorPay/PayPal; and because `gateway_accounts_public_id_uq` is **global**, the
  same source account cannot be imported into a second business (the importer warns and continues
  rather than duplicating). Where the source exposes no account id the importer synthesises
  `gateway:<name>` — still deterministic, and verified to round-trip through the URL as
  `?id=gateway%3Astripe`.
- **2026-08-01 (security)** — **PayPal webhook signatures are now verified LOCALLY.** Authenticity no
  longer depends on `/v1/notifications/verify-webhook-signature`, which was measured the same day
  answering `SUCCESS` for a transmission signed with base64("fakesignature"). We now check the
  signature ourselves, the way PayPal's own SDKs do: SHA256withRSA over
  `transmission_id|transmission_time|webhook_id|crc32(RAW body)` against the leaf certificate at
  `cert_url` — with the pre-existing gate ensuring that URL is https on a `*.paypal.com` host, so a
  caller cannot nominate a certificate they control. The CRC is over the **exact bytes received**;
  re-serialising the parsed JSON changes whitespace/key order and breaks the signature, which is why
  the raw string is threaded down rather than the object. Certs are cached per URL (PayPal reuses one
  for months), so verification does not add a round-trip per webhook or make accepting their callback
  depend on their API being reachable. Proven both ways against live PayPal: a forged transmission
  that previously returned **200 accepted** now returns **400**, and genuine deliveries still verify,
  attribute and reconcile (`verify:paypal-tunnel`). On failure we log the signed message, cert URL and
  byte counts — a rejected transmission is deliberately not persisted, so without that a
  genuine-but-rejected delivery is indistinguishable from one that never arrived.
- **2026-08-01 (ops trap)** — **Stale webhook registrations steal events.** `provider_events` dedups on
  `(provider_key, provider_event_id)` **platform-globally**, while PayPal delivers every event to
  *every* endpoint registered on the account. Five leftover endpoints from crashed suite runs — all
  pointing at our tunnel with different `?id=` — meant whichever endpoint won the race claimed the
  row, and a suite filtering by *its own* business found nothing and reported "PayPal never
  delivered". Delete stale endpoints at the provider before trusting a per-business assertion; in
  production, do not register more than one endpoint per account for the same events.
- **2026-08-01 (fix)** — **A webhook whose processing failed was answered 200 and stranded.**
  `handleProviderEvent` caught every handler error, wrote `outcome='error'` and returned normally, so
  the route replied **200** — which every gateway reads as "handled" and stops redelivering. A
  transient failure while booking a `charge.refunded` therefore meant the money had moved at the
  gateway, our ledger never learned, and nothing retried; there was no replay job either. Two halves,
  and the first is useless without the second:
  1. the route answers **502** when any handler errored, so the gateway redelivers;
  2. `handleProviderEvent` **reprocesses** a previously-errored event instead of deduping it —
     otherwise the redelivery is swallowed by our own `(provider_key, provider_event_id)` idempotency
     and the retry achieves nothing.
  A **NULL** outcome is deliberately still treated as a duplicate: it means a delivery is in flight,
  and reprocessing concurrently risks double-booking. A row stuck at NULL after a crash is an ops
  concern, visible in the inbound inspector. Pinned by `pnpm verify:webhook-retry` (6 checks,
  including that a settled event is still deduped — idempotency must not regress).
- **2026-08-01** — **Recurring-charge matrix added** (see the section above): every gateway × method ×
  currency measured by charging a vaulted instrument off-session. Headline: **Stripe is the only
  multi-currency recurring gateway** (INR/USD/EUR/GBP on one Indian account); PayPal never does INR;
  RazorPay is INR-only for recurring.
- **2026-08-01 (fix)** — **RazorPay `wallet` silently became a NETBANKING mandate.** `initiateVaultSetup`
  picked its rail with `upi ? … : card ? … : 'emandate'`, so `method_types: ['wallet']` hit the
  fallback: the buyer was shown a bank screen and a bank token was vaulted while the stored method type
  said wallet. Identical in kind to the card bug that branch was written to fix — wallets escaped it by
  falling through rather than matching. RazorPay has **no** recurring rail for wallets (cards, UPI
  Autopay and netbanking e-mandate only), so it now throws with a message naming the three real rails,
  and `wallet` was removed from the dashboard's payment-methods picker rather than left as a control
  that mis-mandates. Found by building the matrix above — the combination had never been exercised.
- **2026-08-01 (fix)** — **RazorPay stopped refusing foreign currency on UPI Autopay; we refuse it
  now.** UPI Autopay and netbanking e-mandate are NPCI *domestic* rails — Indian payer, INR
  presentment and settlement. RazorPay used to enforce that ("Currency is not supported", verified
  2026-07-27); measured today it **accepts** a USD/EUR debit on a UPI mandate and returns `pending`,
  which is worse than refusing: the debit enters async limbo on a rail that cannot settle it, so the
  engine parks a payment that may never resolve instead of taking a clean decline. `charge()` now
  refuses non-INR on `upi`/`bank_transfer` locally, before any network call, with a **terminal**
  `currency_not_supported` (retrying the same instrument in the same currency can never work).
  `initiateVaultSetup` already refused to *register* such a mandate; this closes the same hole at
  charge time, where the instrument's real rail is known. `verify:razorpay-live` now asserts the
  refusal **and its origin** (local + terminal), so a future provider change can't quietly restore
  the limbo.
  Card mandates are unaffected: a **domestic card + INR** mandate registers, vaults and takes
  off-session renewals (re-proven today: payment → token → renewal
  accepted). A domestic card cannot carry a USD/EUR mandate at all
  ("Currency is not supported" at registration), and an international card registers in any currency
  but can never be debited — so **INR card subscriptions work; non-INR card subscriptions do not**.
- **2026-08-01 (security finding, provider-side)** — **PayPal's sandbox verifier rubber-stamps
  forgeries.** `POST /v1/notifications/verify-webhook-signature` returned
  `{"verification_status":"SUCCESS"}` for a transmission whose `transmission_sig` was literally
  base64("fakesignature") with a non-existent cert — so a forged-but-well-formed PayPal webhook was
  accepted. Our adapter was correct (it asks PayPal and honours the answer); PayPal is the one
  failing, and an adapter that only forwards the question inherits that. `normalizeWebhook` now
  applies a **local gate first**: all five `paypal-*` transmission headers must be present, and
  `cert_url` must be https on a `*.paypal.com` host (otherwise a caller picks the certificate that
  "verifies" them). `verify:webhook-inbound` reports the rubber-stamp as a loud WARNING with a
  reproduction command rather than a hard failure — a permanently-red suite gets ignored — and
  asserts the local gate instead. **Real fix, not yet done:** verify the RSA signature ourselves
  (`transmission_id|transmission_time|webhook_id|crc32(body)` against PayPal's cert) so authenticity
  never depends on their verdict. Tracked in `docs/PROGRESS.md`.
- **2026-08-01** — **One webhook URL shape, legacy paths deleted.** See "Webhook endpoint ownership"
  above. `/v1/webhooks/stripe` (incl. its pre-gateway-accounts env-global branch) and
  `/v1/gateway_webhooks/:gateway/:business` are gone, along with `ingestGatewayWebhook`'s
  `businessPublicId` fallback; the endpoints registered at Stripe/PayPal/RazorPay were migrated to
  the new URL **first**, and the superseded ones removed at each provider. Endpoints belonging to
  other systems on the same sandbox accounts were left untouched.
- **2026-08-01 (fix)** — **Stripe logged no request/response detail at all.** Every Stripe row in
  `gateway_request_logs` had all four payload columns null (measured: **174/174**), while RazorPay
  (111 rows) and PayPal (141) stored headers and bodies in full. Cause: Stripe is the one adapter that
  does not use `providerFetch` — stripe-node owns its transport, and its `request`/`response` events
  expose only method/path/status/elapsed. The adapter now hands the SDK a **custom fetch HTTP client**
  (`capturingFetch`, via `Stripe.createFetchHttpClient`) that records the real bytes and hands them to
  the existing `response` handler, which still writes the row. Verified against live Stripe:
  `Authorization: ****`, full request + response headers, full JSON response body.
  Two supporting fixes in `providers/http.ts`: **response headers are now redacted** too (they were
  stored raw, and responses carry `set-cookie`), and **`redactBody` understands form-encoded bodies** —
  Stripe posts `application/x-www-form-urlencoded`, which fell through the JSON parse and would have
  been stored verbatim, defeating key-based masking on exactly the adapter that needs it most.
  We deliberately do not mask `Report-To` / `Reporting-Endpoints` (CSP reporting endpoints, not
  credentials).
- **2026-08-01** — **`gateway_request_logs.trace_id`** (migration `0137`). Request-log rows carried
  no trace id, though the trace platform already existed — `providers/http.ts` simply never stamped
  it. Now taken from the ambient context, so every gateway call made by
  one operation shares an id (measured: an account-verify logs `oauth_token` + `health_check` under
  one `api-…` id). `ingestGatewayWebhook` also opens a `hook-…` trace, which is what makes PayPal's
  own signature-verification call — an outbound request made *during* inbound processing — correlate
  to the delivery that caused it instead of logging orphaned.
- **2026-07-31 (fix)** — **PayPal booked cash for money PayPal had not released.** `charge` decided
  success from the **order** status, but a PayPal order flips to `COMPLETED` on capture while the
  capture itself can be `PENDING` (`PENDING_REVIEW`, eCheck, manual action). A review-held wallet
  payment was therefore recorded `succeeded` with cash booked and no pending state for the webhook to
  settle — a silent loss of correctness on every non-instant PayPal capture. Now dispatches on the
  capture's own status (`PENDING` → parked, settled by the already-mapped
  `PAYMENT.CAPTURE.COMPLETED`/`.DENIED`). Found by the new `verify:paypal-wallet`; invisible to the
  card suites because card captures complete synchronously. Card path re-verified 19/19.
- **2026-07-31** — **`verify:paypal-wallet` added** — the buyer-approved billing-agreement path, the
  last PayPal leg that had never been run (previously written off as untestable because of the browser
  approval). Automates everything except the single approval, and is resumable via
  `PAYPAL_SETUP_TOKEN`. 15/15. Also the only suite exercising `deletePaymentMethod` on a wallet token.
- **2026-07-31 (docs)** — Corrected a **false gap**: "PayPal inbound positive path untested / needs the
  webhook simulator" described the headless `verify:webhook-inbound` suite, not `verify:paypal-tunnel`,
  which has covered genuinely signed PayPal delivery since 2026-07-27 (re-confirmed 16/16 today). The
  simulator is not needed and was never used.
- **2026-07-31** — **`deletePaymentMethod` implemented on all three real adapters.** It was declared
  optional on the contract and implemented only by `tmtest`, so the CUST-7 GDPR "gateway-delete" was
  a silent no-op and every deleted card stayed vaulted and chargeable at Stripe/RazorPay/PayPal. See
  the new "Deleting a vaulted instrument at the gateway" section above for the per-gateway measured
  behavior and RazorPay operator ask 5 (an active mandate
  cannot be deleted and has no cancel API). Proof: `verify:gateway-delete-live` (11/11 against real
  sandboxes), `verify:payment-source-delete` (11/11 offline via tmtest), `verify:razorpay-live` step 8.
  Two things only a live run could find: PayPal reports a deleted vault token as **204, not 404**, and
  Stripe's re-detach error message varies by whether the pm was ever attached (both now tolerated).
- **2026-07-30** — **RazorPay vaulting accepts the id the browser actually has.** `vaultPaymentMethod`
  demanded a `token_…`, but the embedded Checkout hands its handler a PAYMENT id (`pay_…`) — so no
  buyer surface could complete a RazorPay add-card, whatever the UI did. It now resolves a `pay_…`
  via `tokenIdForMandatePayment` (polls: the recurring token is minted asynchronously, near-instant
  for cards, laggy for UPI) and fails loudly if none appears.

  Same day, second pass: **this suite's card coverage was a fiction and its "merchant blocker" was
  stale.** Every "international" card check ran one undocumented number (`4111111111111111`), so no
  Indian-issued card had ever been charged, in any currency — and the mandate attempt used that same
  recurring-ineligible card, which is where `recurring_payment_not_enabled` came from. `docs/PARITY.md`
  had already refuted the merchant-config reading on 2026-07-28; the suite and this README kept
  advertising it. Now: RazorPay's published fixtures only (`TEST_CARDS`), **5 cards × INR/USD/EUR**
  asserting the `international` flag per card, the **OTP/3DS branch** walked (inline challenge +
  `submit_url`, which the old helper couldn't handle at all), and card mandates driven end to end —
  register → token → vault-from-payment-id (brand/last4) → off-session renewal.

  Third pass, same day: **registration proves nothing about debiting.** The renewal above was only ever
  charged in INR; charging the USD/EUR mandates revealed the real boundary — the card's **origin**. A
  *confirmed* international-card mandate (3DS walked, `recurring_details.status: confirmed`) is refused
  on every off-session debit with `recurring_payment_not_enabled`, in INR as well as USD/EUR, while a
  domestic mandate takes the identical request. Hence **non-INR subscriptions are impossible today**
  (operator ask 3) and the suite now pins that refusal per currency. Also fixed: `charge()` discarded
  `failure.providerCode` on every decline — RazorPay's own `error.reason` never reached the engine, and
  our normalization is lossy (several refusals collapse to `processing_error`). **58/58 + 1 warning.**
- **2026-07-27 (g)** — **Card subscriptions can now be set up for INR, USD *and* EUR customers**
  (`verify:razorpay-live`, 33/33 + 1 warn). `createMandateOrder` hardcoded `currency: 'INR'` for every
  rail, so a USD or EUR subscriber was bound to an **INR mandate** — registration looked fine and
  every renewal would have mismatched the mandate currency. `initiateVaultSetup` now takes
  `currency` + `maxAmountMinor` (new optional fields on `InitiateVaultSetupInput`; currency-agnostic
  gateways ignore them), and the engine's `initiateVaultSetupForBusiness` resolves the currency
  explicit → customer → business default.

  Rail selection is now explicit about what RazorPay actually allows:

  | request | result |
  |---|---|
  | `card` + INR/USD/EUR | mandate registered **in that currency** with the given ceiling |
  | no `methodTypes` + non-INR | cards (the only rail that can) |
  | `upi` / `bank_transfer` + non-INR | **refused** with an actionable error |
  | `upi` + INR | UPI Autopay, unchanged |

  A domestic rail + a foreign currency is refused rather than silently promoted to cards — that would
  be the mirror image of the `card` → e-mandate bug fixed in (f): the business asks for one instrument
  and the buyer is shown another. RazorPay states the rule itself: *"The currency should be INR when
  method is upi"*.

  **`max_amount` is no longer a hidden cap.** It was hardcoded at `1000000` minor units, so a plan
  priced above ₹10,000 registered a mandate fine and then failed **every renewal**, because the debit
  exceeded the mandate. Callers pass a ceiling derived from the plan; the constant survives only as a
  fallback. ⚠️ For **INR**, RBI's card e-mandate framework auto-debits without re-authentication only
  up to **₹15,000** — above that each debit needs AFA and stops being off-session, so an INR ceiling
  beyond ₹15,000 buys nothing.

  ~~Still gated on the operator ask in (f)~~ — **not gated at all** (established 2026-07-28 in
  `docs/PARITY.md`, pinned by the suite 2026-07-30): the mandate registers *and* charges per currency;
  the refusal recorded here came from a recurring-ineligible test card.
- **2026-07-27 (f)** — **RazorPay card-mandate rail added** (`verify:razorpay-live`, 28/28 + 1 warn).
  `initiateVaultSetup` sent **anything that wasn't `upi` down the netbanking e-mandate branch**, so a
  business asking for `card` got a bank mandate: the buyer was shown a netbanking screen and a bank
  token was vaulted instead of a card. There is now a real `card` rail — its own order shape
  (`method: 'card'` + token block, ₹1 auth floor; RazorPay rejects amount 0 with "Order amount less
  than minimum amount allowed", and rejects `auth_type: '3ds'` as invalid) — and Checkout is told to
  preselect `card`. Asserted against the gateway, not just our return value.

  ⚠️ **Superseded — this paragraph was wrong** (kept, not deleted: it is the cautionary tale). It
  claimed registration "fails with `recurring_payment_not_enabled` ("the seller does not support
  recurring payments")" and that off-session card renewals were unprovable pending an operator ask.
  `/v1/methods` advertising `recurring.card.credit` was **not** misleading — the merchant really does
  have it. The refusal came from attempting the mandate with `4111111111111111`, which is not one of
  RazorPay's recurring-eligible fixtures. Refuted in `docs/PARITY.md` 2026-07-28; suite corrected
  2026-07-30 (card mandate register → token → vault → renewal, INR + USD/EUR, 54/54).
- **2026-07-27 (e)** — **Currency matrices on all three live suites**, and the bug that fell out of
  charging one card twice. **A vaulted Stripe card was single-use:** `vaultPaymentMethod` attached the
  pm but discarded what `attach()` returned, re-retrieving by the id it passed in — and every
  `retrieve` of a Stripe *shared test token* (`pm_card_visa` & co) mints a **new unattached**
  PaymentMethod, so attach bound a clone while we stored an unattached twin. Stripe allows an
  unattached pm exactly one charge, so charge #1 worked and the rest failed *"may not be used
  again"*. Real Elements `pm_…` ids resolve to themselves, so **no production impact** — but every
  Stripe suite had been testing an unattached single-use card, so a genuine reuse regression could
  never have been caught. Fixed by keeping `attach()`'s return. Also: `verify:stripe-live` no longer
  patches the Stripe customer directly to satisfy the India-export rule — the tmbilling customer
  carries name + address and the suite asserts the **engine** forwarded them.

  Measured currency support — **per rail, not per gateway** (real captures, not order probes):

  | rail | INR | USD | EUR |
  |---|---|---|---|
  | Stripe cards (`country=IN` account) | ✅ | ✅ | ✅ |
  | RazorPay UPI Autopay (domestic) | ✅ | ❌ 400 "Currency is not supported" | ❌ same |
  | RazorPay cards (international) | ✅ | ✅ captured + refunded | ✅ captured + refunded |
  | PayPal US (vaulted card) | ❌ 422 `CURRENCY_NOT_SUPPORTED` | ✅ | ✅ |
  | PayPal India | ❌ 422 | order only (vault 403) | order only (vault 403) |

  **RazorPay is multi-currency; only its domestic rails are not.** With International Payments / an
  export account it accepts 100+ currencies incl. USD/EUR/GBP on **cards**, settling in INR (or to an
  EEFC account in the original currency). UPI Autopay and Netbanking e-mandate are domestic-only —
  presentment and settlement must both be INR — which is why the off-session UPI charge refuses USD.
  The same line holds for card + UPI mandate + Netbanking e-mandate: INR only, with export accounts
  the exception for non-INR. So `capabilities.currencies` is `[]` ("account-configured", as Stripe and PayPal declare)
  and the per-rail truth lives in a comment — **nothing reads that field for routing anyway**:
  `selectGatewayAccount` filters on the gateway_account row's own `currencies`/`method_types`.

  ⚠️ **Measurement trap:** RazorPay creates and persists a **USD order** (`currency: USD`), so
  probing `/orders` implies USD is chargeable when the domestic rail will still refuse it. An order
  is never proof of a chargeable rail — only a charge is. `verify:razorpay-live` pins both halves.

  **The card rail is covered** (`verify:razorpay-live`, 25/25): USD/EUR/INR each captured with
  `international: true` and then partially **refunded through our adapter** (a non-INR refund is
  where a hardcoded currency would surface). Since a card payment normally needs Checkout, the suite
  walks the browser sequence server-side: `/payments/create/ajax` (authenticates with `key_id` in the
  body, **not** Basic auth — Basic 401s there) → DCC page → **`mocksharp`**, RazorPay's test-mode 3DS
  simulator → callback. The simulator's Success button only copies its `data-val` into a hidden
  `success` field, so posting `success=S` is precisely what clicking it does. `mocksharp` is test-mode
  only, and this stand-in covers the browser hop alone.

  ~~**Still open:** off-session/recurring *card* charging.~~ **Closed 2026-07-30** — registration was
  never refused by the merchant, only by our choice of test card; card mandates + renewals are proven
  in INR and USD/EUR. The captures described above are one-time payments; the mandate path is covered
  separately in the 2026-07-30 entry.
- **2026-07-27 (d)** — **PayPal money path + real transport proven** (`verify:paypal-live` 15/15,
  `verify:paypal-tunnel` 16/16) — first money ever moved through PayPal, closing the last untested
  gateway. Unblocked by vaulting a **card** (setup token returns `APPROVED` with no browser step)
  instead of the wallet. Three adapter bugs, all invisible without real money: a vaulted card was
  **uncharageable** (`payment_source` hardcoded to `paypal` → 422 `MISMATCHED_VAULT_ID_TO_PAYMENT_SOURCE`);
  every vault was **mislabelled** `paypal`, discarding brand/last4 and causing that same 422; and
  **out-of-band refunds were silently dropped** (the `PAYMENT.CAPTURE.REFUNDED` resource is the
  refund, so we sent a refund id where the capture id belonged — it verified, matched nothing, and
  landed `ignored`). Also documented that the India sandbox can neither vault cards nor accept INR.
- **2026-07-27 (c)** — **A second gateway hit the same undocumented cap**, so the fix is now shared:
  `boundedProviderKey` in `providers/http.ts`. PayPal rejects a `PayPal-Request-Id` over **65 chars**
  with a bare `422 UNPROCESSABLE_ENTITY` — no field, no issue (docs claim 108; measured live: 65
  passes, 66 fails) — and the engine's `inv_<invoice>_attempt_<n>_<pm>` key is ~69, so **every**
  engine-driven PayPal charge failed. Identical in shape to RazorPay's 40-char `receipt`, and
  identical in why it hid: both adapter-level suites used short hand-made keys. Assume the next
  gateway has its own silent cap.
- **2026-07-27 (b)** — **Real transport proven** (`verify:razorpay-tunnel`): RazorPay's own servers
  deliver `payment.captured` to our endpoint over a tunnel and the **engine** settles the async debit
  (subscription billed via `billSubscriptionPeriod` → `collectInvoice` → `pending` → webhook → paid,
  cash booked). Driving the real engine path — rather than the adapter in isolation — immediately
  exposed three more bugs the adapter-level suite could not see:
  (5) **`ensureCustomer` was not idempotent.** `fail_existing` must be the **string** `'0'`; a numeric
  `0` is silently ignored and the call 400s with *"Customer already exists for the merchant"*. Any
  customer RazorPay already knew (re-seeded DB, second business, migration re-import, retry after a
  partial failure) broke the vault. ⚠️ Refined 2026-08-30: "already knew" means the **`(email,
  contact)` pair**, measured — the same email with a different contact mints a NEW `cust_…` and does
  not collide. So a re-seed whose customer kept both fields hits this; one whose phone changed
  silently gets a second RazorPay customer instead, orphaning any token vaulted against the first.
  The adapter itself had never been fixed.
  (6) **Every engine-driven charge failed at order creation.** RazorPay caps `receipt` at 40 chars;
  `collectInvoice` builds a ~68-char idempotency key (`inv_<invoice>_attempt_<n>_<pm>`), so the order
  400'd with *"receipt: the length must be no more than 40"*. `verify:razorpay-live` had missed it
  entirely because its hand-made key was short — the bug lived exactly in the gap between the adapter
  test and the engine. Now `toRazorpayReceipt` passes short keys through unchanged and deterministically
  compresses longer ones (`tm_` + 36 hex of sha256), so retries still map to one attempt.
  (7) **An order-creation failure was marked a hard decline**, and `collectInvoice` reads
  `retriable: false` as "bad instrument" — so a 4xx from *our own* malformed request would have marked
  the customer's payment method **invalid**. Order creation never references the vaulted token, so it
  can't mean the instrument is bad; it is now always `retriable: true`.
- **2026-07-27 (a)** — **RazorPay off-session money path live-proven via UPI Autopay** (`verify:razorpay-live`,
  15/15) — first time any RazorPay charge or refund actually executed against the gateway. Four adapter
  bugs, all only visible live, every one of which broke off-session collection on its own:
  (1) `charge()` never sent `email`/`contact`, which `/payments/create/recurring` **requires** — every
  off-session charge failed with *"The contact field is required."* Added `email`/`phone` to
  `ChargeInput`, threaded from the customer row at both call sites (`collectInvoice`, wallet top-up),
  with a customer-fetch fallback in the adapter.
  (2) `charge()` read `json.id`, but that endpoint answers with the **signed-handshake** shape
  (`razorpay_payment_id`/`_order_id`/`_signature`) — so `providerChargeId` came back **undefined**, an
  async debit was recorded with no `id_at_gateway`, and the settlement webhook could never correlate
  it. The payment would have stayed pending forever. Now reads `razorpay_payment_id`, and a
  response with no usable id is a hard failure rather than a silent pending.
  (3) `authorized` was mapped to `succeeded`, booking cash the gateway had not captured → now `pending`
  (the terminal state arrives by webhook).
  (4) `vaultPaymentMethod` hardcoded `display: {type:'card'}` → a UPI mandate was stored as a card with
  no last4 and mis-routed by Smart Routing. Now reads the token entity (`describeRazorpayToken`:
  upi/card/emandate/nach/wallet) and **fails loudly** if the token can't be read, rather than guessing
  `card` — the same failure mode the Stripe adapter had.
  Also: UPI Autopay added as a mandate rail (`initiateVaultSetup({methodTypes:['upi']})` +
  `initiateUpiAutopayCollect`/`getPayment` for headless registration); `provisionWebhookEndpoint`
  implemented for RazorPay so it self-registers its endpoint with our secret (was "no provisioning API
  exists" — untrue); `payment.captured` async settlement asserted in `verify:webhook-inbound`, which
  closes the `in_progress → settled` path that was previously blocked on Stripe ACH/SEPA activation.
  Gates: `verify:razorpay-live` 15/15, `verify:webhook-inbound` 21/21, `verify:gateway`,
  `verify:vault-setup`, `verify:refund`, `verify:dunning`, `verify:invoices-v2`, `verify:wallet`,
  126 unit tests, typecheck — all green.
- **2026-07-25 (e)** — **RazorPay + PayPal inbound webhooks tested** (`verify:webhook-inbound`, 18/18).
  Previously only Stripe's inbound path had a signature test (`verify:webhook-security` is Stripe-only),
  so the other two were unverified. RazorPay now has full positive+negative coverage (HMAC signed with
  the secret we generate; refund reconciled + booked; dispute created→won), which promoted its dispute
  mapping from "defensive, never exercised" to tested. PayPal gets the negative path — a forged
  transmission is rejected (400) via a real call to PayPal's verify API and never reaches
  `provider_events`; its positive path needs a tunnel + PayPal's webhook simulator (documented).
- **2026-07-25 (d)** — **Engine-level live charge-and-refund** (`verify:stripe-live`, 19/19). Real
  subscription billed through `billSubscriptionPeriod`/`collectInvoice` against a live Stripe gateway
  account (charged `pi_…` 7700 USD), refunded through `refundPayment`; invoice→paid, transaction bound
  to the account, ledger cash nets to 0, all ledger transactions balance, and the PI + refund amounts
  re-verified against Stripe. **Satisfies operational cutover item #1.**
- **2026-07-25 (c)** — **Real-transport webhook test** (`verify:stripe-tunnel`, 9 assertions,
  verified passing over a live ngrok tunnel). Stripe's own servers delivered `charge.refunded` and the
  `charge.dispute.*` chain to our endpoint; each was verified with the `whsec_` **tmbilling minted
  itself**, attributed to the right business via `?id=gwa_…`, reconciled (`outcome=processed`), and the
  refund was **booked**. Inbound webhooks are now proven end-to-end for Stripe: transport → signature →
  attribution → logging → reconciliation → ledger.
- **2026-07-25 (b)** — **Inbound webhook E2E** (`verify:webhook-e2e`, 23 assertions). Real Stripe
  `whsec_` via our own provisioning + payloads signed with Stripe's own signer, delivered to the real
  route: signature accept/reject (wrong secret, tampered body), `?id=` attribution, `provider_events`
  persistence + replay dedup, `charge.refunded` reconciled **and booked**, full dispute lifecycle
  against a real PaymentIntent. Documented the payments-table correlation gotcha. Not covered: public
  tunnel transport, and the async `in_progress → settled` path (needs ACH/SEPA activation).
- **2026-07-25** — **Production-grade gateway pass (Stripe / RazorPay / PayPal).**
  (1) **Webhook secret ownership** — new `webhook-endpoint.ts` + optional adapter method
  `provisionWebhookEndpoint` (stripe, paypal); RazorPay secret auto-generated in
  `createGatewayAccount`; dashboard Webhooks card rewritten; the Stripe `webhook_secret` credential
  input was **removed** (we mint it). (2) **Per-account webhook attribution** — `ingestGatewayWebhook`
  resolves by gateway-account public id (`?id=`), falling back to business+key; the dedicated Stripe
  route now delegates to the same logged ingest path so Stripe events also land in `provider_events`
  with a business. (3) **Smart Routing wired at charge time** — `collectInvoice.adapterFor` now calls
  the canonical `selectGatewayAccount` when a payment method has no bound account (previously it fell
  straight through to the env registry); `vaultPaymentMethod` routes by customer currency so a method
  isn't vaulted on one gateway and charged on another. (4) **Decline normalization** —
  `src/providers/decline-codes.ts` maps RazorPay/PayPal decline vocabularies into the
  `classifyDecline` tokens so smart dunning can park/terminate them. (5) **Money correctness** — new
  `src/platform/currency.ts` (exponent-aware); PayPal charge/refund/dispute amounts fixed (was
  hardcoded ×100 **and** a hardcoded `currency_code: 'USD'` on partial refunds); `RefundInput.currency`
  added. (6) **Bank debits** — Stripe `capabilities.methods` +`us_bank_account`/`sepa_debit`,
  `InitiateVaultSetupInput.methodTypes`, and PaymentMethod display is now instrument-aware
  (`describeStripePaymentMethod`) instead of always reading `pm.card`. (7) `verify:gateway-live` added;
  10 new `WH:` assertions in `verify:gateway`. (8) **Test-isolation fix** — `verify:disputes` and
  `verify:card-updater` hardcoded `providerEventId`s, but `provider_events` dedups on
  `(provider_key, provider_event_id)` **platform-globally**, so both suites only passed on a DB that
  had never run them: on any later run the first delivery returned `duplicate`, the lifecycle silently
  no-op'd, and every assertion failed. Event ids are now salted per run — all 7 payment suites now
  pass on repeated consecutive runs.
- **2026-07-16** — **Gateway Activity log**: new platform-global
  `gateway_request_logs` table — one row per outbound gateway HTTP call (method, url, status,
  duration, operation, source/actor from `platform/event-context`, redacted request/response
  headers+bodies, 16KB truncation). Capture: `src/providers/http.ts` `providerFetch` (razorpay,
  paypal), stripe via stripe-node `request`/`response` emitters, tmtest synthetic rows;
  business/gateway-account provenance via `src/providers/log-context.ts` ALS, bound by
  `withGatewayLogging` in `registry.resolveAdapter`. Inspector: `activity.ts` +
  `GET .../gateway_requests[/:id]` + dashboard "Gateway Activity" page. Inbound
  `provider_events` now also stores **redacted webhook headers** (shown in the webhook drawer).
  Legacy `getProvider(key)` env-singleton path logs with null business/source (pre-existing path,
  documented gotcha below).
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-07-13** — Removed `mock` from `SUPPORTED_GATEWAY_KEYS` (the mock provider was deleted;
  `tmtest` is the only test gateway now). Added `resolveDefaultAccountForBusiness` (business default
  → most-recent active account) so callers with no explicit gateway account fail loudly instead of
  through an implicit test double.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-21** — **We now identify ourselves to every gateway.** `PROVIDER_APP_NAME`
  (`providers/http.ts`) rides as the `User-Agent` on every `providerFetch` call (RazorPay, PayPal),
  and Stripe gets the same string through the SDK's `appInfo`; before this our calls were anonymous.
  This is the ONLY channel any of these gateways has for "which app is calling" — RazorPay's payment
  entity has no `app_id`/`app_name` and `/payments/create/recurring` accepts none, which is why their
  own SDKs do it through the User-Agent (`razorpay-python`'s `set_app_details({title, version})`
  appends `Title/Version`; `razorpay-node` sends `razorpay-node@<version>`). No version suffix:
  `package.json` says `0.0.0`, and a constant version reads as information when it is not.
  ⚠️ It does **not** fill the *App Name* / *App ID* rows on a RazorPay payment — those belong to a
  registered RazorPay *application* (a Partner OAuth `client_id`), which a key-secret integration does
  not have, so they stay `--`. `providerFetch` also now logs the headers it actually SENT rather than
  the caller's, so Gateway Activity does not under-report the request.
- **2026-08-21** — **Stripe's inbound event map audited against Stripe's own reference**, the way
  RazorPay's was in INDIA-LAUNCH §4b; full write-up in §4c there. Unlike RazorPay (no wildcard, so a
  gap is a missing subscription), Stripe registers `['*']` — every event already arrived and the gap
  was purely in `normalizeWebhook`, so nothing surfaced it: unmapped events were recorded `unknown`
  and dropped. 12 events added, the two load-bearing ones being `mandate.updated` (mandate lifecycle
  on every rail this adapter parses, and the India revocation Stripe otherwise only reports as a
  failed debit) and a conditional `payment_intent.processing` (the RBI 26-hour pre-debit window,
  observed with a real deadline instead of inferred from amount + rail). Also `refund.failed`
  (compensating ledger entry — the ledger is append-only), `charge.dispute.updated` (re-issued
  evidence deadline), `payout.*` → `settlement.*`, and `review.*`/`radar.early_fraud_warning.created`
  persist-only. Three corrections: `invoice.payment_*` unmapped (they described **another system's**
  invoices on a shared account), `charge.expired` → `intent.voided` (a lapsed hold is not a decline),
  and on RazorPay `refund.failed` re-pointed off `charge.failed` (it had aimed
  `reconcileChargeFailed` at the original payment and survived only on a status guard). New normalized
  terms: `intent.requires_action`, `refund.failed`, `settlement.failed`, `fraud_warning.created`,
  `review.opened`/`.closed`. `pnpm verify:webhook-e2e` 26 → 58 assertions.

- **2026-08-30** — **the async-settlement rule is METHOD-AWARE, not gateway-wide.**
  `ASYNC_SETTLEMENT_GATEWAY_KEYS` was `{razorpay}`, justified as "Stripe card renewals settle
  synchronously, so a missing endpoint there costs visibility, not money." True of a plain card,
  false of everything else Stripe declares: its own `capabilities.methods` carries `us_bank_account`,
  `sepa_debit` and `bank_transfer`, which its own comment describes as settling asynchronously
  ("ACH/SEPA take days… the terminal outcome arrives only as an inbound webhook"). On those rails a
  live Stripe account with no endpoint has RazorPay's exact problem — it collects money we can never
  reconcile. Flipping Stripe on wholesale would have been the wrong fix: it would refuse card-only
  add-cards, which are the common case and are genuinely fine. So `settlesAsynchronously(gatewayKey,
  methodTypes)` now decides from the gateway AND the effective method vector (what the caller asked
  for, else the account's `method_types`), with `ASYNC_SETTLEMENT_METHOD_TYPES` listing Stripe's bank
  rails in BOTH vocabularies — the canonical types stored on `gateway_accounts.method_types` and the
  wider request vocabulary the buyer surfaces send (`METHOD_TYPE_MAP` in providers/stripe.ts). Card
  presentations are deliberately absent: they are cards and settle like cards. Pinned by four
  `verify:gateway` WH-ASYNC checks (card allowed, `bank_transfer`/`sepa_debit` refused), mutation-tested
  red against the old gateway-wide rule.
  * ⚠️ Stated rather than hidden: an **Indian Stripe account's e-mandate CARD renewals are async too**
    (Stripe parks an off-session India debit in `payment_intent.processing` for the RBI 26-hour
    pre-debit window). Account country is not on `gateway_accounts` and cannot be known without a
    gateway round-trip, so that case is left to the settlement poll and the ops invariant rather than
    guessed at from the method vector.
  * The rule still lives HERE, next to the endpoint code, rather than being copied into its consumers.
    ⚠️ The two consumers now see DIFFERENT views: the registration guard
    (`assertVaultPreconditions`, payment-methods/service.ts, on both add-card entry points) calls the
    method-aware function; the `async_gateway_has_webhook` invariant still reads the coarse
    `ASYNC_SETTLEMENT_GATEWAY_KEYS` set, because it scans accounts rather than requests and its query
    does not select `method_types`. A live Stripe account pinned to `sepa_debit` with no endpoint is
    therefore refused a NEW mandate but not reported as an existing violation — follow-up in
    the `async_gateway_has_webhook` invariant check.

- **2026-10-30** — Razorpay `razorpay.code.transaction_not_permitted_to_cardholder`: the reason arrives as the sentence "Transaction not permitted to issuer/cardholder" (ISO 57). Unmatched, it was stored as its own code and computed retriable; now `card_restricted`, which parks.

## Wallet domains (Apple Pay, Google Pay, Link) — 2026-09-05

`POST /v1/businesses/:biz/gateway_accounts/:gwa/wallet_domains` registers a storefront domain
with the gateway and returns its per-wallet verdict.

**Why it exists.** Apple Pay paints no button on a domain the gateway has not registered, and it
does so **silently** — no error, no console warning, no failed request. An unregistered domain and
"we do not support Apple Pay" are indistinguishable from outside, which is exactly how a
configuration gap gets recorded as a missing feature.

**Nothing else was missing**, which is why this is one endpoint and not a project:

* An Apple Pay token **is** a card credential to Stripe, so it rides the `card` rail already in
  `payment_method_types` — no new rail, no routing change. `METHOD_TYPE_MAP` folds `apple_pay`,
  `google_pay` and `wallet` onto `card` for the same reason.
* `PaymentElement` is mounted with no `wallets` override, so it surfaces the button on its own.
* Provenance survives the round trip: `describeStripePaymentMethod` reads `card.wallet.type`, so a
  saved instrument reads **"Apple Pay"** rather than a bare card brand.

**The adapter method is optional** (`registerWalletDomain?`) because this is a Stripe-shaped
requirement; gateways without the concept answer **409**, which says "nothing needs doing" rather
than pretending the request was malformed.

**Create-then-validate, always.** `create` throws on a domain the gateway already knows, so an
existing registration is looked up first — an operator pressing the button twice must not see an
error for a domain that is fine. `validate` then runs regardless, because a domain registered
*before* its association file was in place stays inactive until something asks again, and nothing
else ever asks. Validating is also when the gateway fetches the file, which makes this the only
honest check that it is actually being served.

**The domain comes from `PORTAL_BASE_URL`, not from the browser.** `domain` in the request body is
optional and omitting it is the normal case. The storefront is a SEPARATE host from the dashboard in
production (`portal.…` vs `app.…`) and only the engine knows it, so a UI that prefilled its own
hostname would have registered a domain no buyer ever pays on — a registration that succeeds and
leaves the wallet dark, which is worse than one that fails. Local dev hides this completely: both are
`:4100`.

**The operator still has to serve one file**, and no code can do it for them: the association file
belongs at `/.well-known/apple-developer-merchantid-domain-association` on the storefront domain.
The storefront is the dashboard's Next app, so it goes in `dashboard/public/.well-known/`. Its
contents come from the gateway — we deliberately do not synthesise it. When it is missing, the
gateway's own `detail` says so and the card prints that text verbatim rather than rewording it.

### Changelog
* **2026-09-05** — added `registerWalletDomain` to the adapter interface + the Stripe
  implementation, the `wallet_domains` endpoint (admin, idempotency-keyed), and the
  **Apple Pay & Google Pay** card on the gateway account screen (Stripe only). Also added
  `effectiveMethodTypes` here: `method_types` on the row is the OPERATOR's list and is nullable
  (null = everything the gateway can do), so both storefronts were falling back to a hardcoded
  `['card','upi','bank_transfer']` — the Indian set — and would have offered a Stripe buyer UPI.
  It now resolves the operator's list, else `ADVERTISED_METHODS`, minus the rails the currency
  rules out (SEPA is EUR-only, ACH USD-only, and `bank_transfer` is USD-bound on Stripe alone,
  where it folds onto `us_bank_account`).
- **2026-10-19** — tmtest load profile (`src/providers/tmtest/load-profile.ts`, roadmap D4.1),
  off unless `TMTEST_LOAD_PROFILE=TRUE`: every `charge()` waits a log-normal response time
  (`TMTEST_LATENCY_P50_MS` / `_P99_MS`), `TMTEST_DECLINE_RATE` of success-card charges decline
  with production's 30-day code mix (decided by the idempotency key, so a replay answers the
  same), and `TMTEST_RATE_LIMIT_PER_S` throws like a 429 after one backoff. Used by
  `scripts/loadtest/`; nothing else turns it on.
- **2026-10-26** — PayPal conformance. A timeout, 5xx, 408, 409 or 429 on a money call (order
  create+capture, intent read/authorize/capture, refund, void) is replayed with the same
  `PayPal-Request-Id` (waits 1 s, 3 s), then throws `ProviderIndeterminateError` (booked pending,
  never a decline; a 429 that never clears stays a retriable failure). Deleting a `B-` method
  cancels the v1 billing agreement (`POST /v1/billing-agreements/agreements/{id}/cancel`; a
  refusal resolves when the agreement reads cancelled, expired or inactive), and
  `BILLING.SUBSCRIPTION.CANCELLED` on a `B-` id detaches the method. Disputes: UPDATED is the new
  `dispute.updated` (status refresh, no money); RESOLVED maps every outcome code
  (`paypalDisputeTransition`). `PAYMENT.CAPTURE.REVERSED` / `PAYMENT.SALE.REVERSED` are booked by
  `applyChargeReversal` (the open dispute's withdrawal, else the late-failure reversal), and
  `PAYMENT.CAPTURE.DENIED` after COMPLETED sets `lateReversal`. Dead-agreement / payer-account
  codes → `payment_method_not_found`; merchant-account codes → `gateway_account_unavailable` /
  `recurring_not_enabled` / `gateway_request_rejected`. Failure text keeps the issue code, never
  PayPal's description or `debug_id`. v1 `PAYMENT.SALE.REFUNDED` correlates on `sale_id` and is
  sized from `amount.total`. Gate: `verify:paypal` (offline tier, 43 checks).
- **2026-10-27** — **3g live fixes.** Authorize.net webhooks are signed with the Signature Key
  as TEXT (the hex-decoded form is only the response `transHashSha2`): every live delivery was
  rejected on the hex-only check; a key entered in lower case is also tried in upper case.
  Inbound batches are applied in event time (a GoCardless batch listed a chargeback before its
  payment's confirmation). Cashfree's dashboard "Test" ping (no version header) is a signed
  no-op. Cashfree mandate setup needs the customer's name (`recurringNeedsName`; Cashfree
  refuses an email as `customer_name`). PayPal Transaction Search is optional (403 → wait for
  the capture webhook) and "no such charge" needs the report's `last_refreshed_datetime` to
  cover the attempt (it lagged 1.9 h live). The settlement poll marks its events `polled`.
- **2026-10-28** — **Phase 5f: ACH authorization, first on Authorize.net eCheck.** Catalogue
  `achAuthorization` (`gateway`: Stripe, Square, GoCardless show their own text; `ours`:
  Authorize.net) and `setupOnlyMethods` (`effectiveMethodTypes` drops them from a `payment`
  offer); the catalogue API returns `ach_authorization`. Authorize.net offers `us_bank_account`
  (USD): a bank setup asks AcceptUI for bank fields only (`sdk.params.method`), a nonce of the
  other rail is deleted and refused, a bank charge sends no card-on-file flags and books pending
  (profile SEC code WEB, measured). The settlement poll reads eCheck batches back 70 days and
  maps settled sales, settled refunds, returns (`returnedItem`, `chargeback`, NACHA R-codes in
  `AUTHORIZENET_CODE_TABLE`) and `chargebackReversal` (booked by `lateCaptureAfterFailure`). A
  settled eCheck refunds as PPD/CCD with the masked account, within 180 days.
  `pendingDebitCancel` voids an unsettled eCheck (a settled one answers `already_final`).
- **2026-11-04** — RazorPay `ensureCustomer` throws `ProviderRefusalError` on a definite 4xx (bad keys) and `ProviderIndeterminateError` on a lost answer or 408/409/429/5xx, instead of a plain Error (a setup payment intent answered 500). Unit: `test/unit/razorpay-ensure-customer.test.ts`.
- **2026-11-05** — Gateway balance. Optional `PaymentProvider.fetchBalance` (PayPal reads
  `/v1/reporting/balances`, 403 → `not_permitted` with the Transaction search steps).
  `getGatewayAccountBalance` + `GET …/gateway_accounts/:gwa/balance`; never throws, a gateway
  error comes back as `available: false` with a message.
