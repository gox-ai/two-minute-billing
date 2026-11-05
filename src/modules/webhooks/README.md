# webhooks — outbox, endpoints, delivery, inbound provider events

> Source: `src/modules/webhooks/` · Routes: `src/api/routes.ts` (`/v1/webhook_endpoints/*`) · Schema: `db/schema/tenancy.ts` (`webhook_endpoints`), `db/schema/platform.ts` (`webhook_deliveries`)
> Layer: foundation (see docs/architecture/architecture.json)

## Purpose
Implements the outbox pattern (ADR-007): `emitEvent` writes the immutable event **and** a delivery row
per matching endpoint in the *same transaction* as the state change, then the billing clock delivers
+ retries asynchronously with HMAC signatures. Also manages customer webhook endpoints and handles
inbound provider events.

## Responsibilities
- `emitEvent(tx, …)` — write event + fan out `webhook_deliveries` to enabled, subscribed endpoints.
- Deliver pending deliveries with retry/backoff + HMAC signature (`deliverPending`, clock-driven).
- Endpoint CRUD, secret rotation, per-endpoint `event_types[]` subscription, delivery history.
- Redelivery — clones the delivery row and calls the subscriber **inline**, returning a live
  request/response transcript — and test-send (canned sample payload, writes no delivery row).
- `handleProviderEvent` — entry for normalized inbound provider events.

## Data model
`db/schema/tenancy.ts` — `webhook_endpoints` (url, secret, enabled, `livemode`, `event_types` jsonb =
null→all, description); `db/schema/platform.ts` — `webhook_deliveries` (event_id, endpoint_id, attempts, status, next_attempt_at,
last_response_status). HMAC-signed payloads; ~6 attempts with backoff.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `emitEvent(tx, {organizationId, businessId?, type, data, source?, actor?, resource?})` | write event + deliveries in the caller's tx |
| `deliverPending` | deliver queued deliveries (called by the billing clock) |
| `createEndpoint` / `updateEndpoint` / `deleteEndpoint` / `rotateSecret` | endpoint management |
| `listEndpoints` / `getEndpoint` / `listDeliveriesPage` | read (the delivery log is cursor-paged and filterable) |
| `redeliverDelivery` / `redeliverLatest` | resend one delivery SYNCHRONOUSLY → settled row + live transcript |
| `attemptDelivery` | one attempt: sign, POST, judge, re-schedule — shared by the clock and Resend |
| `testSendEndpoint` | canned sample payload, no delivery row |
| `handleProviderEvent` | process a normalized inbound provider event |
| `listEvents` / `signPayload` | helpers |

## API routes
| Method · Path | Purpose |
|---|---|
| endpoint CRUD, rotate, deliveries, redeliver, test-send | registered via `webhook-routes.ts` (mounted in `routes.ts`) |

## Events emitted
`payment.failed`, `transaction.late_failure` (from inbound reconciliation paths). Note: it *writes*
every module's events via `emitEvent`, but those are owned by the emitting module.

## Dependencies
- **Upstream (calls into):** audit, events, invoicing, ledger, payments, subscriptions, transactions.
- **Downstream (called by):** every module that emits events.

## Invariants & gotchas
- `emitEvent` **must run inside `withTenant`** in the same transaction as the state change — that's
  what makes the outbox atomic (no event without the change, no change without the event).
- Fan-out filter: endpoint enabled ∧ business-scope match ∧ **partition match** ∧ (`event_types`
  null ∨ contains type).
- **Endpoints are partitioned.** `webhook_endpoints.livemode` is the endpoint's test/live side;
  scoped endpoints derive it from their business (`webhook_endpoints_business_livemode_fk` makes
  that structural), it is immutable after creation, and re-scoping must stay in the same partition.
  An event belongs to its business's partition and only reaches endpoints on that side.
- **Org-level events (no business) still go to every enabled endpoint, in both partitions.** They
  are about the organization itself and nothing simulated is org-level — Time Travel and sample
  data are business-scoped and always test — so there is no fake data to withhold.
- The partition filter **fails closed**: an event whose business row cannot be read enqueues
  nothing rather than broadcasting to both sides.
- We sign every delivery with HMAC; unlimited endpoints.
- **No private targets, no redirects** (`platform/egress.ts`). An endpoint URL that is or
  resolves to loopback, RFC 1918, link-local/metadata, CGNAT, multicast/reserved or IPv6
  loopback/ULA/link-local (IPv4-mapped included) is refused at save (`EndpointValidationError`)
  and again at connect time inside the socket's DNS lookup, so a rebinding answer cannot slip
  between check and dial. Refused at send = `failed` terminally, no breaker entry. A 3xx is a
  failed attempt and is never followed. `last_error` holds a fixed sentence, never the raw
  network error. `WEBHOOK_ALLOW_PRIVATE_TARGETS=TRUE` lifts the address check (self-hosted, dev);
  `scripts/lib/verify-run.ts` sets it for every suite, `verify:webhook-ssrf` turns it back on.
- **Partner integrations are not endpoints** (since 2026-10-27). They live in
  `modules/integrations` with their own connections, outbox and history.
- **A bulk requeue queues one replay per EVENT, not per failed row.** An endpoint that failed,
  was fixed and was replayed accumulates a failed row per cycle, and the `NOT EXISTS` guard
  cannot see rows the same INSERT is producing — so without the `DISTINCT ON (event_id)` a
  history of two failures sends the event twice. The partner's own event-id dedup answers the
  second (409 → delivered), so nothing is double-credited, but the call is wasted.
- **A REPLAY inserts a new delivery and RETIRES the original as `superseded`.** Both replay
  paths clone rather than mutate, so without the retirement one event shows as two live
  failures and the old one stays red forever — visually identical to a delivery that still
  needs attention, which is what made a freshly-fixed integration look broken. `superseded` is
  terminal and benign, so it renders neutral like `skipped`; both are declared in
  `StatusBadge`'s map rather than left to fall through to grey by accident.

## Changelog

- **2026-11-05** — `applyMandateStatus` passes the method's stored `collect_open_invoices`
  (0502) to `collectOutstandingForNewPaymentMethod` when a mandate goes live; null keeps
  `collect_on_payment_method_update`. Gate: `verify:gateway` (OCA).
- **2026-10-29** — **A booked capture is not an alarm.** `reconcileUnmatchedCapture` re-checks,
  with no business scope, before it alerts (`captureAccountedFor`): a payment or transaction with
  the charge id, a consumed intent whose ref matches, or a setup auth (a `setup` intent with no
  amount, or an order tagged with a customer id) logs `unmatched_capture_accounted_for` at info.
  Cause: a gateway account shared by two businesses delivers every event to each, and the
  business that does not own the charge always missed it. A truly unbooked capture still logs
  `unmatched_capture_ours_unattributed` and keeps its row; `unappliedGatewayMoney` excludes the
  customer-tagged setup auths too. Proof: `verify:setup-auth-refund`.
- **2026-10-28** — `handleProviderEvent`: a re-run of an existing row holds the per-event advisory
  lock (`providerEventLockKey`) and reads the outcome under it; a first delivery takes no lock.
  `InboundContext.reprocess` is replaced by `rerunIf(outcome)` (default: `error` only; GW-7 replay
  adds `ignored`, the stored-delivery job adds NULL). The job no longer takes its own lock.

- **2026-10-29** — `reconcileChargeFailed`: a `charge.failed` with `debit_cancelled` on an
  in-flight transaction goes to `bookDebitCancelledAtGateway` (payments), not the dunning path.

- **2026-10-28** — `applyIntentEvent`: an `intent.authorized` with `gatewayIntentId` re-points the
  current attempt from `providerIntentId` to it before authorizing (a hosted page's payment), and
  the staleness guard accepts an attempt already re-pointed to that id.
- **2026-10-28** — Answer-first inbound deliveries (Adyen, `webhook.processAfterAnswer`): the
  route stores verified events (outcome NULL) and a `process_gateway_webhook` job in one
  transaction, then answers. The job calls `handleProviderEvent` with `reprocess: true` per stored
  row under a per-event advisory lock and throws while any event errors, so the queue retries. The
  dedup rule is unchanged: NULL stays "in flight" for redeliveries.
- **2026-10-28** — Merge of the integrations move with the egress guard: `postOnce`
  (`platform/http-delivery.ts`) sends through `guardedFetch`, so webhook and integration
  deliveries keep the no-private-target, no-redirect rule; a refused target is terminal and
  skips the breaker on both outboxes.
- **2026-10-28** — 0363 drops the legacy partner columns `transform`, `credentials_enc` and
  `transform_config` (and their check constraint) from `webhook_endpoints`.
- **2026-10-28** — 0362 deletes the partner rows moved in 0361 and their delivery history; the
  fan-out and endpoint reads no longer filter on `transform`, and the deploy bridge is gone.
- **2026-10-27** — **Partner integrations moved out** to `modules/integrations` (0361). Removed
  `transforms/`, the `transform` / `credentials` / `api_key` / `transform_config` request fields
  and the `transform` response field, and `/v1/integrations` (now served by the integrations
  routes). The HTTP attempt, backoff and error clipping moved to `platform/http-delivery.ts`,
  shared with the integrations outbox.
- **2026-10-27** — `resolveChargeEventTransaction`: after the ownership-ref match, an unmatched
  `charge.*` event (not `foreign`) tries `adoptLostAnswerByLookup` (payments README), so a
  gateway's own event books a charge whose create answer was lost even when the charge cannot
  carry our ref (Cashfree subscription payments).
  A plain async `charge.failed` now also writes the gateway's code or reason
  (`providerFailureCode`) to the transaction's `error_text`, not only to the payment.
- **2026-10-27 (fix)** — **An out-of-band refund is booked once, however the webhooks arrive.**
  `applyRefund`'s running-total path decided outside any lock, so two deliveries processed at the
  same moment each saw nothing recorded and both booked (measured live: $30 on a $25 payment), and
  one refund delivered twice at once was booked twice. It now locks the payment row, re-reads the
  refunds and re-checks the refund id inside the booking transaction. `verify:refund-reconciliation`
  §5–6.
- **2026-10-26** — Main → development merge: the two SSRF guards are one. Delivery, Resend, test
  send and the invoice logo use `guardedFetch` (`platform/egress.ts`: address check in the connect
  lookup, embedded IPv4 checked, no redirects); create/update use `checkPublicUrl`. Opt-out is
  `WEBHOOK_ALLOW_PRIVATE_TARGETS` (`verify-all.sh` exports it). `platform/outbound.ts` and
  `ALLOW_PRIVATE_OUTBOUND_URLS` have no callers left.
- **2026-10-26** — `reconcileChargeSucceeded` books a same-amount capture on a `failed` or `late_failed` payment for a gateway with catalogue `settlement.lateCaptureAfterFailure` (GoCardless; RazorPay on main), through `reconcileAbandonedCapture`. `applyMandateUpdate` re-points a replaced mandate (`replacementPaymentMethodId`; an existing row for the new id wins and the old one is retired) and refreshes the bank display (`paymentMethodDisplay`). `applyMandateStatus` skips an event older than `payment_methods.mandate_status_at` (0395).
- **2026-10-25** — A late request capture refused for an amount mismatch re-codes the transaction from its AFA code to `capture_amount_mismatch` under the row lock (`refuseMismatchedRequestCapture`), so neither the AFA recheck sweep nor a redelivery books it later.
- **2026-10-25** — Payment requests (0388) in `inbound.ts`: `charge.refunded` with no payment row spreads over a request's children (`applyRequestChargeRefund`); a reversal of a request's charge reverses every child and reopens the invoices (`reverseRequestCharge`); a capture after a failed (AFA) request charge is booked as credit and refunded. The async-failure path reads the customer's dunning policy (0386).
- **2026-10-24** — **Endpoint changes are audited** (B13). `createEndpoint`, `updateEndpoint`,
  `deleteEndpoint` and `rotateSecret` write `webhook_endpoint.create|update|delete|rotate_secret` in
  the same transaction. The row holds the URL's origin only (a receiver may carry a token in the
  path or query), never the signing secret or partner credentials; an update records changed fields
  plus `url_changed` / `credentials_replaced` flags. Checked by `verify:api-keys` § B.
- **2026-10-24** — A payment reversal that reopens an invoice checks the dunning hold
  (`dunningHoldFor`) before it restarts dunning, on both the auto-collect and the offline branch.
- **2026-10-26** — **An event the adapter could not read is an error, not a guess.**
  `NormalizedProviderEvent.unresolved` (set by Stripe when the read of an event's object at our
  API version fails): `handleProviderEvent` throws it before any handler, so the row records
  `error` with that message, nothing is booked, and the route answers 502 for a redelivery.
  Proof: `verify:stripe-any-version`.
- **2026-10-26** — **Inbound money events, gateway conformance.** `applyRefund` books only against
  a `succeeded` payment (else `refund_on_unsettled_payment`, ignored) and adopts the gateway id of
  a lost-answer refund matched by `ownershipRef`; `reverseFailedRefund` does the same. A `charge.*`
  event that matches no charge id falls back to a `timeout` payment transaction recorded under the
  event's intent id and adopts the real charge id (`resolveChargeEventTransaction`). A capture of a
  `failed` transaction is booked through `reconcileAbandonedCapture` when the gateway declares
  `settlement.lateCaptureAfterFailure` and the amount matches (new `NormalizedProviderEvent.amountMinor`).
  Proof: `verify:webhook-inbound`.
- **2026-10-13** — **A refused card setup says why.** Stripe's `setup_intent.setup_failed` now carries
  `last_setup_error` through the adapter (`failureCode`, `providerFailureCode`, new `failureMessage`),
  and the `intent.setup_failed` handler stores that code and sentence on the attempt instead of a
  bare `setup_failed`. The buyer's browser confirms a setup with Stripe directly, so the webhook is
  the only place the reason exists. Without a reason it still reads `setup_failed`. Regression:
  `test/unit/stripe-setup-failed-reason.test.ts`, `verify:gateway` C7+.
- **2026-10-13** — **A setup intent's capture is not a lost capture.** `reconcileUnmatchedCapture`
  read `!pi.amountMinor` as "no usable intent", so the zero-amount capture that registers a mandate
  fell into the unattributed branch and logged `unmatched_capture_ours_unattributed` at error. It
  is now ignored with an info-level `setup_capture_ignored`; the vault-setup path settles the intent.
- **2026-09-27 (latest)** — **Listing integrations no longer loads the delivery code.** A
  transform's static description (`TransformInfo`: name, label, default URL, events, connect form)
  lives in `<name>-info.ts` and `transforms/catalogue.ts`, which import nothing at runtime.
  `openapi.ts` reads the catalogue, so the API reference — and the SDK generator — load without
  the database layer and its env check (CI's "SDK types in sync" step died on `DATABASE_URL`).
  `index.ts` throws at load if the catalogue and the runtime transforms name different sets.
- **2026-09-24** — **A failed delivery keeps the receiver's reply.** `last_error`
  (0278) holds the first 1,000 characters of a non-2xx response body, the transport error when
  nothing answered, or a transform's build error; NULL once delivered with a 2xx. The clock reads
  that body with a bounded stream read, never `res.text()`, so a huge error page costs a few KB.
  Shown on the event page and the endpoint's delivery log. Prompted by a FirstPromoter signup
  refused 404 on prod, where the row said only "404".
- **2026-09-19** — **Partner transforms: an endpoint can speak someone else's API
  (`0266`, `transforms/`, first one FirstPromoter).** Every endpoint until now received the same
  request — our signed envelope, POSTed where the operator said. An affiliate or analytics
  partner accepts none of that: its own per-event paths, its own field names, an `X-API-KEY`
  rather than a signature. What they DO need is everything this module already is, so the
  transform is three columns on `webhook_endpoints` rather than a second delivery system —
  fan-out inside the state-change transaction, six attempts with backoff, the per-origin
  breaker, the test/live partition and the delivery history all still apply, and `transform IS
  NULL` is every pre-existing row, untouched.

  The four judgements worth knowing, because each was a wrong default:
  **(1)** the sale amount is `subtotal − discountTotal` — pre-tax, and past BOTH discount stages,
  one of which is already inside `subtotal_minor` and one of which is not. Every other version of
  that expression yields a plausible number and pays the wrong commission.
  **(2)** a 409 is DELIVERED. It is the retry finding the commission already recorded, and the
  default rule would file a delivered event as failed after five more attempts.
  **(3)** a 4xx is TERMINAL — one attempt, not six, on a request that will be refused identically
  forever.
  **(4)** an organic signup is SKIPPED, not sent. FirstPromoter requires a referral id on a
  signup and most customers have none, so sending anyway is a 400 and six attempts on the
  majority of traffic.

  ⚠️ The configured field name tolerates a leading `cf_`, the same `baseKey` rule the custom-field
  layer uses: the stored key is bare (`tid`) but `cf_tid` is what the API surface and the Custom
  fields screen both SHOW, so it is the natural thing to copy — and a name that matches nothing
  is indistinguishable from "this customer was not referred".
  ⚠️ **The referral id is a customer CUSTOM FIELD and must be defined before it can be set** —
  `validateAndCoerce` throws `Unknown custom field` otherwise. It originates in the merchant's
  own signup page (`_fprom_tid`), so no amount of engine work can supply it; an endpoint whose
  merchant never wires it through will skip every signup and look exactly like a quiet day.
  ⚠️ The refund call is SCALED by the same net/total ratio the sale used: the refund row is
  gross, so returning it whole would claw back 118% of the commission on an 18% GST invoice.
  ⚠️ Exactly one of `refund_created` / `refund_settled` sends. Both are subscribed because a
  refund born `succeeded` never emits the second, and one accepted `pending` must claw back on
  the money rather than the instruction.
  The operator surface is `/developer` → **Integrations**, and it is catalogue-driven rather
  than per-partner: "Connect integration" opens a DIRECTORY of everything this build can
  connect — mark, name and what it does — and picking one reveals its form, whose credential
  label, extra settings and prerequisite warning all come from `Transform.connect` over
  `GET /v1/integrations`.
  A connected integration is deliberately kept OUT of the endpoints table — there it would show
  a partner base URL as though the operator typed it, and offer a "Rotate secret" that signs
  nothing.
  Gate: `pnpm verify:firstpromoter` (19 checks, hermetic against the dev worker via a time
  travel + `onlyBusinessId` scope), `test/unit/webhook-transforms.test.ts` (10 cases) and
  `pnpm verify:ui`.
- **2026-09-12** — **`applyActionRequired` records the authentication wait inside the same
  transaction as the emit.** INV-100006 sat on `authentication_not_required` while its 3DS step was
  demonstrably incomplete, because the statement that superseded that code arrived on a later event
  and nothing wrote it down. Now, when `authenticationWaitMayBeRecorded(txn.errorCode)` says the
  recorded code may be replaced, the transaction is stamped `AWAITING_AUTHENTICATION_CODE` in the
  same `tx`. Statements are ordered in time and the later one wins. ⚠️ Forward-only: a transaction
  already carrying the stale code keeps it until its `intent.requires_action` is replayed.
- **2026-09-11** — **The drain is bounded-concurrent, and the fair share no longer lies.**
  Same pair as the email outbox and for the same reason: the scan's `rn <= 50` was fixed, so a
  subscriber alone in the queue was held to 50 deliveries a minute despite the comment above it
  promising otherwise. `fairShareFor` now divides the scan by the businesses that actually have
  work due. The loop is `runBounded` on `TICK_EGRESS_CONCURRENCY` (default 1 — a no-op deploy).
  It matters more here than on the email side because failures dominate: **5.61 attempts per
  failed delivery against 1.23 per success**, and with the per-request timeout at
  `min(10_000, deadline - now)` one dead endpoint in a serial loop yielded roughly one delivery
  per pass. Safe because the atomic lease already existed for concurrent scanners. ⚠️ Parallel
  delivery means a subscriber can receive `invoice.paid` before `invoice.created` — Stripe
  does not guarantee order either, but a subscriber that ASSUMED it will notice; if
  that ever matters, shard on the endpoint rather than lowering the concurrency.
- **2026-09-11** — **`webhook_deliveries.duration_ms` (migration `0249`).** `latencyMs`
  was already computed per attempt and RETURNED to the caller, but never stored, so nothing outside
  a single call could say how long a POST takes. Now persisted on all three outcomes (delivered /
  failed / retrying), last attempt only — `attempts` already counts the rest. Nullable, no backfill.
  The reason it matters now: deliveries cost **5.61 attempts when they fail against 1.23 when they
  succeed**, so retries rather than successes dominate the load as volume grows, and with the POST
  timeout at `min(10_000, deadline - now)` a single dead endpoint in a serial loop yields roughly
  one delivery per pass — the 2026-09-01 mechanism. The drain is still serial and still capped by
  `TICK_FAIR_SHARE_PER_BUSINESS` applied as a row cap on the SCAN, so the pass never sees row 51;
  converting that cap to an in-flight limit is the prerequisite for concurrency here. See PROGRESS.
- **2026-09-10** — `applyActionRequired` no longer mails the buyer a second time. It emits
  `payment_authentication_required` when the gateway states a debit is waiting on the buyer, but
  `collectClaimedInvoice` already emitted the same event when it booked that debit pending — and the
  two mails are byte-identical, because the template has no `authenticate_by` var, so the deadline
  this path exists to carry reaches subscribers and the event row, never the mail. It became
  universal on 2026-09-09: below ₹15,000 the old failure booking made the transaction terminal, so
  this handler returned `ignored` and the overlap was hidden. The event still fires — it now carries
  `suppress_email` when a prior one exists for that payment. Kept here as well as in the general
  `enqueueEmails` net because this guard has no time window and so survives a webhook retry that
  arrives minutes later. Pinned by `verify:emails`.

- **2026-09-04** — Parking an invoice now stamps `invoices.dunning_parked_at` (0232). It is
  the anchor `parkedDunningDeadline` measures a parked window from — a park has no retry to count
  down from, and the due date it used to borrow was long past for every already-parked row. Only
  meaningful while `dunning_status='parked'`; never cleared on the way out, because every park site
  overwrites it. Full decision: `src/modules/subscriptions/README.md`, `docs/PROGRESS.md` #59.

- **2026-09-04** — ✅ **#43: the three capture-verdict log event names are now asserted.** They are
  exported as `UNMATCHED_CAPTURE_EVENTS` (frozen, keyed by `CaptureProvenance`) and the three call
  sites index it with the verdict they just computed, so a name cannot be published from two places
  and a verdict cannot be paired with another verdict's name by construction.
  `test/unit/capture-verdict-events.test.ts` locks it two ways, and the difference matters when
  reading a failure: **by value** (the literal strings, the key set, and the map composed with the
  real `classifyUnmatchedCapture`) and **by source text** (that all three sites still index the map,
  that no bare literal survives, that each name is quoted exactly once in the file, and that the
  error/info/warn levels stay in their order). The source half exists because a runtime log
  assertion is not available here — `pino-pretty` runs in a worker thread and writes to the fd
  directly, bypassing `process.stdout.write`, and `reconcileUnmatchedCapture` is module-private and
  DB-backed — so a "capture the logs" test would pass or fail for the wrong reason.
  One more consumer is pinned: `unappliedGatewayMoney`'s remediation sentence names
  `unmatched_capture_ours_unattributed` in prose for the operator to grep, and a rename that misses
  that sentence now fails. ⚠️ What it does NOT catch: a level or guard swap is caught only as source
  text, and nothing here proves what a live delivery actually emitted.

- **2026-09-04** — ✅ **#33/#34/#35: the dropped money events now have names, handlers and a count.** Five
  new `NormalizedProviderEvent` kinds (`charge.pending`, `charge.reversed`, `charge.updated`,
  `refund.pending`, `reserve.hold.updated`). `charge.reversed` and `reserve.hold.updated` route to
  `recordMoneyMovedAgainstUs`: logs at ERROR, returns `ignored`, **posts nothing** — making a dropped
  event visible is the fix; inventing ledger movement is a separate decision with real consequences.

  ⚠️ **A mapping without a branch is INERT, and this is not theoretical — it had already happened.**
  Stripe `payment_method.detached` was in the map from the day the adapter was written with no branch,
  so it fell through to the generic charge return, which sets `providerChargeId` and never
  `providerPaymentMethodId` — the field the dispatcher guards on. Every Stripe detach landed `ignored`
  and no instrument was ever marked invalid from one. (Blast radius measured: ZERO Stripe deliveries of
  that type exist on this box, so it never once fired — real in code, unverified against traffic.) The
  same shape was caught before shipping for PayPal `PAYMENT.REFUND.FAILED` (`reverseFailedRefund` opens
  `if (!ev.providerRefundId) return "ignored"`) and `VAULT.PAYMENT-TOKEN.DELETED`. **Assert that a new
  event reaches its handler's FIELD, never just that the `type` is right.**

  ⚠️ Refused on merit, so nobody "fixes" them: Stripe `payment_method.attached` (its only candidate kind
  marks an instrument `valid` again — it would resurrect a hard-declined card into collection),
  `customer.source.expiring` (legacy `card_…` ids never match our `pm_…`), and PayPal
  `VAULT.PAYMENT-TOKEN.DELETION-INITIATED` (a request, not an outcome). `charge.updated` does NOT carry
  the fee — `balance_transaction` is an id and webhooks do not expand it.

- **2026-09-04** — ✅ **#33/#34/#35: five event types the engine had no word for, and a Stripe
  detach that has never worked.** New `NormalizedProviderEvent["type"]` members —
  `charge.pending`, `charge.reversed`, `charge.updated`, `refund.pending`,
  `reserve.hold.updated` — each with the argument for why no EXISTING term would do written on
  it. `charge.reversed` and `reserve.hold.updated` route to `recordMoneyMovedAgainstUs`, which
  logs `gateway_money_moved_against_us` at error level and **posts nothing**: naming a dropped
  money event is the fix for "no record"; deciding its double-entry treatment is a separate
  design and is not made by whoever maps events. The other three are persist-only by
  construction — the verdict they precede still arrives on its own, and acting on either
  `refund.pending` or `charge.updated` would DOUBLE-BOOK (both gateways send the birth AND the
  completion of one dashboard refund; `charge.updated` fires on a bare metadata edit).

  ⚠️ **A pre-existing defect found while writing the gate, not by reading:** Stripe's
  `payment_method.detached` was in the adapter's map from the start but had **no branch**, so it
  fell through to the generic charge return, which sets `providerChargeId` and never
  `providerPaymentMethodId`. The inbound dispatcher guards on that field, so **every Stripe
  detach has landed `ignored` and no instrument was ever marked invalid from one.** Fixed with
  the branch that also serves the newly-mapped `customer.source.deleted`.

  ⚠️ **`payment_method.attached` is deliberately still UNMAPPED.** The only existing term it
  could take is `payment_method.updated`, whose handler marks the instrument `valid` again — so
  an attach for a method we had already marked `invalid` after a hard decline would resurrect it
  into collection on no evidence it works. A wrong state is worse than an unnamed row. Pinned by
  an assertion so nobody "fixes" it.

  ⚠️ **"No record at all" was overstated in the brief and is worth correcting:**
  `handleProviderEvent` INSERTS every delivery, `unknown` included, before it dispatches. The
  rows existed; what they lacked was a name (so they were unfindable by type in the inspector),
  a handler and a count. That is still a real gap on money moving against us — it is not data
  loss. 17 unit cases in `test/unit/webhook-event-coverage.test.ts` drive the real adapters
  through their real signature paths; 14 mutations applied, each killed a named case.


- **2026-09-04** — ✅ **#31: one WARN became three verdicts at the `!pi` branch of
  `reconcileUnmatchedCapture`.** ours-unattributed → `unmatched_capture_ours_unattributed` (`log.error`),
  foreign → `unmatched_capture_foreign` (`log.info`), unclassified → `unmatched_capture_unattributable`
  (`log.warn`, name RETAINED so existing greps keep working — the three names live in
  `UNMATCHED_CAPTURE_EVENTS`, see #43 above). Every line carries `provenance`,
  `ownership`, `ownershipRef`, `objectCreatedAt`, so a verdict is reconstructible
  from the log alone.

  ⚠️ **`OWNERSHIP_TAGGING_LIVE_AT` was REMOVED 2026-09-04** (Vinay's decision, after production
  measurement: exactly one capture had ever reached the gate and it sat 28 seconds on the pre-rollout
  side, so the gate's entire observed effect was suppressing one genuine verdict). A read absence is
  now `foreign` at any age. **The one rule that did NOT change is the load-bearing one: `unknown` is
  never `foreign`** — only an adapter that read the tags and found ours absent may say `foreign`.
  The removal's cost, recorded rather than implied: an object created before tagging shipped is
  untagged because our own code was not stamping yet, and now reads as another product's money —
  which matters for the legacy tail, since a pre-tagging e-mandate keeps charging for months. If it
  is ever restored, the version to build is a rollout instant the DEPLOY records, not a hand-set
  date. Also fixed here: `reviveNormalizedEvent` never
  revived `providerObjectCreatedAt`, so a replayed event handed a plain ISO string to code the
  contract promises is a `Date`.

  ⚠️ Not proven by any gate: the three event NAMES (these suites have no log sink, so a rename passes
  green) and `resolveCaptureOwnership` (fixtures return before touching a gateway — a live RazorPay
  capture is what would exercise it).

- **2026-09-04** — 🟡 **A capture booked and refunded left its intent open (#26).**
  `reconcileUnmatchedCapture` books the money and never closed the checkout it came from, so the
  intent stayed live to `liveIntentForInvoice` (the buyer is told "a payment is already in progress"
  for a payment that finished and was handed back) and kept feeding `releaseZeroDueIntents` a row
  RazorPay cannot void. It now closes through A1's `closeIntentForReturnedCharge` — one writer, not
  a second closer — scoped to `second_checkout`, i.e. an intent that was still live. Measured: on
  `pi_XXXXXXXXXXXXXXXXXXXXXX02` the late `intent.authorized` did eventually arrive (18:18:23, 7m48s
  after the 18:10:35 capture) and closed it, so the real exposure is that gap, and it is unbounded
  when the authorize never comes. Gate: `verify:stale-pending` §U, red-before-green, mutation-tested.
- **2026-09-03** — 🔴 **A late `intent.authorized` resurrected an intent whose money was already back,
  and raised a false "the gateway holds…" alarm.** RazorPay delivered one payment's events out of order —
  provable from their own timestamped ids: `payment.captured_1788437757` arrived at 12:15:58 and
  `payment.authorized_1788436855`, the EARLIEST, arrived last at 12:22:26, six minutes after we had
  refunded that charge ourselves. The staleness guard read only the intent's own status
  (`consumed`/`voided`), and neither was true because the buyer's browser never posted the second leg —
  so nothing local tied the intent to the payment it produced (`payments` has no `payment_intent_id`, and
  the capture records no transaction at all). It therefore authorized the intent and wrote a
  `needs_attention` row claiming ₹22,184.00 was held. Now it asks whether the charge has already settled
  and been returned, via `chargeAlreadyReturned`. **Scoped to `payment` intents deliberately:** a SETUP
  intent's ₹1–5 registration debit on the India e-mandate rails is routinely refunded WHILE the mandate
  goes live, so treating "the money came back" as historical there would skip `harvestSetupIntent` and
  leave us holding no instrument for a chargeable mandate. See #17 in `docs/PROGRESS.md`.

- **2026-08-31 (night)** — **Three places where the inbound path treated OUR state as the gateway's
  truth, and dropped real money.** All measured before being touched.
  * **`terminal` was three facts wearing one name.** Both authorize cases opened with
    `if (terminal) return "ignored"`, where terminal meant `consumed | expired | voided | voided_at`.
    Right for three of them; wrong for `expired`, which is our clock's opinion — the bank approved and the
    money is real (`probe-late-authorization.ts` A/B: a live hold against an unpaid invoice, or a live
    mandate with no `payment_methods` row). Now split into `settledAlready` / `closedByUs` / `revivable`,
    and an `expired` intent is revived (`reviveIntentForLateAuthorization`) then handled like a live one.
    A lost revive claim falls back to `ignored` — the previous behaviour, reached deliberately.
  * **`if (!txn) return "ignored"` in `reconcileChargeSucceeded` was silent data loss.** INV-5510's
    second payment produced no transaction row, so its `charge.succeeded` — delivered TWICE — was
    dropped, and the money existed nowhere: not in the ledger, not in Transactions, not refundable. Now
    `reconcileUnmatchedCapture` correlates via `providerIntentId` (which the RazorPay adapter's `charge.*`
    branch had never carried, though `payment.entity.order_id` was always in the payload) and books it
    through `settleUnmatchedGatewayCapture`. With no intent match it refuses to guess the customer —
    attributing a payment to the wrong one is worse than the gap — but logs
    `unmatched_capture_unattributable` rather than staying quiet.
  * **`harvestInvoiceIntent` said "yet" about something permanent.** For INV-5510's second order it
    logged "could not be captured from its webhook YET" and returned `ignored`, one second after the
    first payment had settled the invoice — which would never owe that money again. It now tests the
    invoice's outstanding balance BEFORE consuming, and an amount it cannot absorb goes to
    `reconcileUnappliableAuthorization`: release the hold at the gateway (best outcome — the money never
    leaves the buyer), and where the gateway cannot (RazorPay `intentVoid: false`) record a
    `needs_attention` transaction (`authorization_unappliable`) so it emits `transaction.needs_attention`
    and lands in the money log beside the charge. It deliberately does NOT capture-then-refund: taking
    money out to hand it straight back is worse for the buyer than not taking it.
- **2026-08-28** — `charge.succeeded` for an ABANDONED debit is no longer dropped. The status gate in
  `reconcileChargeSucceeded` let anything outside `['in_progress','timeout','needs_attention']` fall
  through to `'ignored'` — indistinguishable from an event that isn't ours — which silently discarded
  real captures of debits given up on by the 72h AFA sweep or by the buyer's portal "I won't approve
  this". New `reconcileAbandonedCapture` books the money (`settleAbandonedCapture`) and then refunds
  whatever the invoice could not take. The refund runs OUTSIDE the settle transaction on purpose: it
  reaches a gateway, and a network round trip inside the transaction holding the invoice lock would
  hold that lock for its duration. A refund failure is logged and swallowed rather than rethrown —
  rethrowing makes the gateway redeliver, and the claim means a redelivery books nothing and retries
  nothing, so the money would be safe but the retry pointless.
- **2026-08-27** — **A first webhook no longer waits for the next cron tick.** Delivery rows were
  always enqueued already due (`next_attempt_at = now()`), but the only thing that drained the
  outbox was the `* * * * *` billing-clock tick — so a first delivery sat **0–60s, ~30s on
  average**, waiting on nothing. `enqueueDeliveries` now also enqueues a `webhook_outbox_nudge`
  job **in the same transaction**, so it commits atomically with the event and graphile-worker's
  insert trigger wakes a worker on commit. **Measured ~40ms commit→POST** (was 0–60s), and a
  rolled-back change enqueues nothing.
  The outbox is unchanged: the POST still happens on the worker, outside the transaction, with the
  same claim + retry + backoff. Only the wait is gone, and cron remains the safety net.
  - The enqueue goes through `public.app_nudge_webhook_outbox()`, a **no-argument SECURITY DEFINER
    wrapper** (migration 0201). `graphile_worker.add_job` is NOT security-definer — it delegates to
    `add_jobs`, so `has_function_privilege` reports true for `tmbilling_app` and the call still
    fails on the table underneath. Granting that role the job tables would let anything reaching it
    enqueue **arbitrary tasks with arbitrary payloads**, i.e. a path out of the RLS sandbox into the
    worker. The wrapper takes no arguments, so the only thing a tenant transaction can express is
    "there is webhook work to drain".
  - Coalesced on a `job_key`, so a burst of events produces ONE nudge. Deliberately **not** on a
    named queue: a queued job misses graphile-worker's insert NOTIFY and falls back to the poll —
    measured **~890ms vs ~37ms**. Serialization was never needed for correctness, because
    `deliverPending` leases every row with an atomic compare-and-swap. Only enqueued when at least one endpoint matched, so an org with no webhooks pays
    nothing. The nudge task re-applies the tick's `runWithClockScope` exclusion — without it a
    nudge would deliver a time-travelled business's webhooks at real `now`.
  - Covered by `verify:outbound-webhooks`, which clears the queue first (a leftover nudge made the
    assertion unfalsifiable) and mutation-tested: deleting the enqueue gives `pending after 13
    events=0` and the suite fails.
- **2026-08-19** — **An out-of-band gateway detach no longer leaves a dead token in collection.**
  `handleProviderEvent` now routes `payment_method.detached` to `applyPaymentMethodDetached`. The event
  arrives in two shapes and only one was ever handled: the **echo** of our own delete (row already
  gone → lookup misses → `ignored`, correct before and unchanged), and an **out-of-band** detach — an
  operator deleting the card in the gateway's dashboard — where we still hold the row. That row stayed
  `valid` and stayed selectable, so the next renewal picked a token the gateway no longer had,
  hard-declined, and armed **dunning against a blameless customer**. It is now marked `invalid`, the
  same status a hard decline or a dead mandate applies, which is what removes it from
  `resolveChargeCandidates` and moves collection to the customer's backup. The row is **not** deleted
  and the card display fields are untouched — a dead token is not a reason to lose the instrument a
  payment was collected on, and local deletion is a deliberate operator action with its own event. A
  repeat detach of an already-`invalid` method returns `ignored` and emits nothing (the status says
  nothing new), so the guard is the handler's own, not just the provider-event dedup. Nine assertions
  in `pnpm verify:card-updater` § B, including the echo no-op. RazorPay's equivalent
  (`token.cancelled`) was already covered on the mandate path via `DEAD_MANDATE_STATUSES`.
- **2026-08-07** — **Outbound webhooks are test/live partitioned** (migration `0152`). `enqueueDeliveries`
  fanned out on `business_id IS NULL OR business_id = event.business_id` and the endpoint had no mode,
  so an **org-wide endpoint received both partitions** — a customer's production consumer saw a sandbox
  business's renewals, including everything Time Travel manufactures, as real. Added
  `webhook_endpoints.livemode` (+
  `webhook_endpoints_livemode_ck`), and a composite FK `(business_id, livemode) → businesses(id, livemode)`
  so a scoped endpoint's mode is *structurally* derived from its business rather than derived by
  convention. Fan-out now also matches the event's business partition (scalar subquery, so no extra
  round trip on the emit path; NULL ⇒ enqueue nothing, i.e. fail closed). Org-level events are
  unchanged — both partitions, because nothing simulated is org-level. Route rules: `livemode` is
  resolved, never guessed (business → key mode → 400 for the one org-wide+`all`-key case that implies
  nothing); a test key cannot create/scope/edit a live endpoint; `livemode` is not patchable and
  re-scoping must stay in-partition. Backfill defaulted org-wide rows to `test` — of the two ways to be
  wrong only "endpoint goes quiet" is noticed, and it is `test` for every row that actually exists.
  `serializeEndpoint` now emits `livemode`, the endpoint LIST is mode-scoped, and every
  `/v1/webhook_endpoints/:id/*` route answers 404 to an out-of-partition key (a test credential
  could otherwise rotate a live endpoint's secret or fire a test POST at a production consumer).
  Pinned by 26 new `pnpm verify:testlive` assertions (§8–§11, 31 → 57); also `getEndpoint()` added
  to `endpoints.ts`.
- **2026-07-21** — `handleProviderEvent` now routes two more normalized event families:
  `payment_method.updated` (automatic card updater → refreshes the vaulted method's brand/last4/
  expiry and flips status back to `valid`, emits `payment_source_updated`) and `dispute.*` (→
  `disputes/service.handleDisputeEvent`). Both stay idempotent via the existing provider-event dedup.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-21** — **Stripe inbound coverage brought up to the RazorPay standard**, plus two mapping
  fixes. RazorPay's event list had been audited event-by-event (INDIA-LAUNCH §4b); Stripe's never had,
  and the gap was not a subscription problem — `enabled_events: ['*']` means every event already
  arrives — it was that `normalizeWebhook` had no entry for them, so they landed `unknown` and were
  dropped. Verified against `docs.stripe.com/api/events/types` on the day.
  New mappings: `mandate.updated` → `payment_method.mandate_updated` (the whole mandate lifecycle,
  previously invisible on every rail this adapter parses — SEPA/BACS/BECS/ACSS/us_bank_account and an
  India recurring card; Stripe's own guidance is that `payment_intent_mandate_invalid` is preventable
  "by checking the mandate status before attempting to charge"); `payment_intent.requires_action` +
  `setup_intent.requires_action` + a conditional `payment_intent.processing` → the new
  `intent.requires_action` (async 3DS, and the RBI 26-hour pre-debit window);
  `setup_intent.canceled` → `intent.voided`; `charge.dispute.updated` → `dispute.created` (the
  re-issued evidence deadline, exactly why RazorPay subscribes `payment.dispute.action_required`);
  `refund.failed`/`refund.updated`/`charge.refund.updated` → the new `refund.failed`;
  `payout.paid`/`.failed` → `settlement.processed`/`settlement.failed`; `review.*` and
  `radar.early_fraud_warning.created` persist-only.
  Two fixes, both behaviour changes: **`invoice.payment_*` unmapped** — we never call Stripe's
  Invoices API, so on a shared account those described invoices we never raised and were being read
  as our money (the mirror of dropping RazorPay's `subscription.*`); and **`charge.expired` →
  `intent.voided`, not `charge.failed`** — an uncaptured charge expiring is a lapsed hold, and calling
  it a decline reversed cash never booked and re-armed dunning. On RazorPay, `refund.failed` was
  re-pointed off `charge.failed`, where it had aimed `reconcileChargeFailed` at the original payment
  and survived only on a status guard — so a refund that never landed was silently dropped.
  New handlers: `applyActionRequired` (correlates the intent table *and* the transaction table,
  because an off-session debit has no `payment_intents` row — routing it through `applyIntentEvent`
  would have dropped the India case) and `reverseFailedRefund` (compensating ledger entry, never an
  edit). Pinned by 32 new `pnpm verify:webhook-e2e` assertions (26 → 58), against real Stripe
  signatures, including both traps: a `single_use` mandate going `inactive` must NOT invalidate the
  instrument, and `processing` without `approval_requested` must stay unmapped.
- **2026-08-21b** — **Every inbound correlation lookup is now provider-scoped, and an ambiguous one
  refuses instead of guessing.** `applyRefund`'s "already booked this provider refund?" check matched
  `refunds.provider_refund_id` across the WHOLE table — no payment, no provider, no org — so once any
  tenant had booked an id, the same id arriving for a different tenant's charge was answered `ignored`
  and that org's genuine out-of-band refund never reached its ledger. Provider refund ids are unique
  only within a provider account; a shared or sandbox account makes the collision ordinary. Scoped to
  `(payment_id, provider_key, provider_refund_id)`.
  Five sibling lookups had the same defect and now share two resolvers — `resolvePaymentByCharge` and
  `resolveTransactionByCharge`: `reconcileChargeSucceeded`, `reconcileChargeFailed`,
  `applyActionRequired`, `reverseFailedRefund`, and the inspector's Transaction column (which could
  label a delivery with another provider's transaction).
  ⚠️ **These cannot be org-scoped and that is by construction** — an inbound webhook arrives with no
  org context, and this lookup is *how* we learn the tenant, so `provider_key` / `gateway_key` is the
  only discriminator that exists before the row is found.
  `resolvePaymentByCharge` selects 2 rows and declines on more than one with a `log.error`, where it
  used to `.limit(1)` and silently choose — booking against another tenant's payment is not something
  a report reader can catch. It returns `ignored` rather than `error` deliberately: `error` makes the
  route answer non-2xx so the gateway redelivers, and an ambiguity never resolves itself.
  `resolveTransactionByCharge` does NOT treat multiple rows as ambiguous — `id_at_gateway` is
  legitimately shared by an authorization and its capture — so newest-first is the tiebreak.
  Pinned by `verify:refund-reconciliation` §4 (a second org booking the id org A already used), which
  was **confirmed to fail against the pre-fix lookup** before being kept. That suite is also now
  idempotent (`RUN` salt), which it had never been.

- **2026-08-27** — `harvestSetupIntent` now also FINISHES the checkout that was waiting on the intent
  (`completeCheckoutForSetupIntent`, modules/checkout). It vaulted the instrument and stopped there,
  which was enough for the portal's add-card but not for a hosted checkout on the netbanking
  e-mandate rail: RazorPay never returns that buyer, so nothing posted `/checkout/v1/complete` and
  the subscription was never created. The call is guarded to `res.paymentMethod` (a `setup` intent's
  vaulted instrument), never throws — an errored webhook would make the gateway redeliver the whole
  event and re-run the vault — and is idempotent against the buyer who does come back, because
  `completeCheckout` claims the session with a compare-and-set. See migration `0200`.

- **2026-08-30 — F-42: a mandate CONFIRMING now collects the customer's open invoices.**
  `applyMandateUpdate` wrote `mandate_status`, emitted `payment_source_updated` and stopped. The
  add-card routes (operator and portal) both call `collectOutstandingForNewPaymentMethod` — Billing
  LogIQ's "collect open invoices when a payment method is added", ON by default — but on the
  netbanking rails the instrument is NOT usable when it is added (an e-mandate is `initiated` until
  the bank confirms at T+1), so that collection runs against something that cannot be charged and
  nobody looked again. F-11 sharpened it: the pending pre-flight now refuses the debit and defers
  12 hours, so a buyer whose bank confirmed an hour later waited for the next backoff tick.
  * Gated on a genuine TRANSITION into a live status (`mandateBecameLive`), computed against the
    stored status re-read under `SELECT … FOR UPDATE` inside the update transaction. Provider-event
    dedup is NOT sufficient on its own: it keys on `provider_event_id`, so two different events
    both asserting `confirmed` both pass, and a delivery whose prior outcome was `error` is
    deliberately let through to run again — which is exactly the redelivery this handler can cause.
  * A resume from `paused` onto a live status triggers too (it is an instrument becoming
    collectable again, the same situation as an add-card); a resume onto `initiated` does not,
    because that instrument is not chargeable and collecting would spend an F-11 deferral.
  * Also gated on the instrument being collectable — the two statuses
    `assertChargeableForAutoCollect` excludes. A mandate can confirm on a method the card updater
    or a hard decline already wrote off, and this handler deliberately does not revalidate on a
    confirmation.
  * BEST-EFFORT, and the stakes are higher than on the add-card routes: an escaping error marks the
    delivery `error`, answers the gateway non-2xx and has the WHOLE event redelivered, mandate
    update and all. Swallowed to a warning.
  * Same change fixed the emitted `payment_source_updated`: it reported `dead ? "invalid" : pm.status`,
    which on the un-pause branch published the OLD `invalid` in the very transaction that wrote
    `valid`. It now reports the status the write actually leaves behind.
  * ⚠️ **KNOWN, OPEN — the collection is UNBOUNDED and runs in the webhook's request window**
    (measured 2026-09-02). Every guard above is about *correctness*, and they hold; none of them
    bounds the *work*. `collectOutstandingForNewPaymentMethod` selects the customer's `payment_due`
    invoices with **no `limit`** and charges them serially, so the time this handler takes is set by
    how many open invoices the customer has, against the gateway's webhook timeout. A timeout is
    safe — the row is committed, so the redelivery's transition test is false and nothing
    re-collects — but the collection is then simply abandoned partway. A cap belongs in the service,
    not here: `api/payment-method-routes.ts` and `api/customer-portal-routes.ts` call it the same
    way. (That function also re-reads the customer's `auto_collection` inside the loop for a value
    keyed on a fixed `customerId`.) Filed in `docs/PROGRESS.md` under the 2026-08-31 double-charge
    list, item 3.

- **2026-09-02** — **Resend is SYNCHRONOUS, and shows what it sent.** Raised by a review of the
  event screen. Three findings, all verified in source first:
  * **It was queued, not sent.** `enqueueDeliveries` was taught to wake the drainer on commit
    (2026-08-27, "the first webhook is sent on commit") and `redeliverDelivery` was never brought
    along — it inserted a pending clone and returned, so a manual Resend waited out the 60s cron
    tick and the screen said `Pending · attempts 0` when the call should already have gone. It
    now POSTs inline and returns the outcome. Routes answer **200, not 202** — 202 promised
    "later", which is now false.
  * **One implementation, not two.** The POST/judge/re-schedule body of `deliverPending` moved into
    a shared `attemptDelivery`, which both the clock and Resend call. Deduplication is the smaller
    reason: a resend with its own copy of the signing or success logic could report green for a
    request the clock would have judged failed, and that is the one thing an "is it working again?"
    button must never do. The clone is inserted **future-dated** so a cron tick cannot claim it in
    the gap between commit and POST (`attemptDelivery` does not re-claim); the attempt then
    overwrites the schedule, so nothing is actually delayed. Crash mid-POST still leaves the row
    for the clock — the outbox guarantee is intact, only the WAIT is gone.
  * **An operator resend does NOT respect an open circuit breaker** (`skipOpenCircuit: false`). The
    breaker protects the clock's pass budget, which one human click does not threaten, and
    refusing would disable the button in the exact moment it is most useful — right after someone
    fixed the receiver. The outcome is still recorded, so a successful resend closes the breaker.
  * **The request/response transcript is LIVE ONLY — deliberately not stored** (our user's call).
    A migration adding five columns to `webhook_deliveries` was written and then withdrawn.
    `DeliveryTranscript` is built, returned in the resend response, rendered, and dropped.
    ⚠️ **This is deliberately narrow, and the limit is worth knowing:** we can only show the call
    you just triggered, never one that ALREADY happened — a background attempt, or one made days
    ago by a retry. Nothing is queryable after the fact, and
    a background attempt's transcript is never captured at all — the durable record of one stays
    what it always was (`status`, `attempts`, `last_response_status`, `last_attempt_at`).
  * **Two shapes for one concept, by decision.** An automatic retry increments `attempts` on the
    existing row; a manual resend still writes a NEW row, keeping the per-resend audit trail. That
    asymmetry is intentional and was put to our user rather than decided here. The event screen
    therefore groups **one card per ENDPOINT** — latest attempt in the card, earlier ones collapsed
    beneath — because the endpoint-level fields are identical by definition across rows, so a card
    per row read as a duplicated card distinguished only by a timestamp.
  * Endpoint **names** are now asked for at create time (`description`, which the API already
    accepted and only the create form omitted). Every endpoint was being born nameless, so the
    event screen headed its cards with a `whe_…` id instead of a readable name.
  * Suites: `verify:webhooks` 21/21. The rewritten redeliver assertions are **inverted** from what
    they said before — `status: 'pending'` and `attempts: 0` were the queued contract and are now
    the shape of a bug. `verify:outbound-webhooks` needed its receiver kept open past the
    redeliver block: `server.close()` ran ~50 lines earlier, which was invisible while resends were
    queued because **the old assertion was satisfied by a resend that never left the process.**

- **2026-09-01** — **a reversal on an OFFLINE (auto-collect-off) invoice no longer writes
  `not_paid`.** `reconcileChargeFailed` is the third writer that calls `planFailureRearm`, and it
  was the last one missing the `send_invoice` action added on 2026-08-31. It fell through to the
  `stopped` else and wrote `not_paid` + `dunning_status: stopped` + `next_attempt_at: null` +
  `attempt_count + 1` — four wrong writes from one unhandled case. `not_paid` is the
  collection-FAILED status and a send-invoice bill has failed no collection; `stopped` claims a
  merchant halt nobody made; the null destroyed the offline REMINDER schedule, which is the only
  thing that tells the payer the bill is outstanding again; and the counter booked a dunning
  attempt that never happened.

  ⚠️ Unlike `invoicing/service.ts`, this branch cannot write NOTHING. There the invoice was already
  in its correct offline state and the honest write was none; here it is `paid` with a `paid_at` and
  the money has just been taken back. So it restores the state the OFFLINE model itself gives an
  unpaid invoice, through that model's own helpers rather than a second guess at them
  (`offlineDunningApplies` + `nextOfflineReminderAt`): `payment_due` + `in_progress` + the next
  reminder instant while offline dunning applies, and `not_paid` when the merchant has opted out —
  exactly the two outcomes `runInvoiceDueTransitions` writes at `posted →`. The ladder is
  time-indexed off the due date, so re-deriving it gives the instants it would have had.

  The reopen event is now chosen from `set.status` rather than from the plan action, so it can never
  describe a transition the row did not take. Gated by `verify:gateway` § **C8-OFF** (9 assertions);
  mutation-tested — forcing the branch off fails 6 of them.

  **The report's second half was already closed and is NOT a defect.** "An offline invoice with
  `collect: true` records a FAILED `payments` row with no dunning attempt behind it" conflates
  two things: an imported `dunning_attempts` count maps to our `attempt_count`
  (the importer sets `attemptCount = dunning_attempts.length`), which the `send_invoice`
  branch already holds at 0. The `payments` row is deliberate — a real gateway charge really was
  attempted and declined, and `transactions` + `gateway_request_logs` carry it; suppressing the
  payment row would leave those two asserting an interaction with no money record behind it.
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-30** — `GET /v1/webhook_endpoints/:id` (list-row shape, no secret) and opt-in `limit`/`starting_after` paging on the list; without them the list is unchanged.
- **2026-10-05** — A rejected/cancelled mandate update that newly invalidates the method also emits `payment_source_invalidated` (`invalid_reason: "mandate"`), so the customer is asked to authorize again; it used to flip the status silently. Paused included.
- **2026-10-21** — `webhook_deliveries.business_id` (0350), copied from the event at enqueue, redeliver and requeue: the egress drain ranks per business without joining `events`. The drain claims its whole pick in one `update … skip locked` and hands unreached rows back at once (it claimed row by row, and concurrent drains raced on every candidate). The outbox nudge runs after commit, one in flight per process (it held one job row locked to commit in every event-emitting transaction).
- **2026-10-24** — SSRF fix. Endpoint URLs to private/reserved addresses are refused at save and at send (the worker checked only the http(s) scheme and `fetch` followed redirects, so a `developer` member could make it POST to localhost, RFC 1918 or cloud metadata and read the answer through Resend). Delivery and test-send go through `guardedFetch` (`platform/egress.ts`: address check pinned in the connect lookup, redirects not followed); a refused row settles `failed`; network errors are stored as fixed sentences. Opt-out `WEBHOOK_ALLOW_PRIVATE_TARGETS`. The invoice logo fetch uses the same guard. `verify:webhook-ssrf`, `test/unit/egress-guard.test.ts`.
- **2026-10-24** — Delivery log paginates and filters. `GET /v1/webhook_endpoints/:id/deliveries` is on the shared list contract (`limit`, `starting_after`, `has_more`, `next_cursor`, `total`), newest first by `(created_at, id)` over the new `webhook_deliveries_endpoint_created_idx` (0377); row 101+ was unreachable before. Filters: `id`, `status`, `event`, `event_type`, `attempts`, `created_at`, `last_attempt_at`, and `http_status[is|in]` with an exact code, a class (`4xx`), a range (`404-412`) or `timeout` (tried, no HTTP response, not delivered). `q` matches the delivery id, the event id or the event's object id. Day filters use the organization's timezone. `limit` defaults to 100 here (the old page size). `listDeliveries` → `listDeliveriesPage`. Dashboard endpoint page renders it as a list with segments and the filter builder. Covered by `verify:webhook-delivery-log` and `verify:list-pagination`.
- **2026-10-25** — `reconcileLateRequestCapture` (inbound.ts): the payment request late-capture branch of `reconcileChargeSucceeded`, exported so the AFA recheck sweep shares it.
- **2026-10-26** — `applyRefund` books per gateway refund id when the event carries `refunds`
  (Stripe): an existing `pending` row settles only when that refund `succeeded`; a refund tagged
  as ours but not yet recorded is left to `refundPayment`; an untagged one is booked out of band
  only once it `succeeded`, under a `FOR UPDATE` on the payment with a re-check, so
  `charge.refunded` and the Refund events cannot book it twice. Events without `refunds`
  (RazorPay, PayPal) keep the cumulative-delta path.
- **2026-10-26** — `charge.reversed` is booked by `applyChargeReversal`: an open dispute on the charge takes it as `dispute.funds_withdrawn`; otherwise it runs the late-failure reversal in `reconcileChargeFailed` (cash out, AR and invoice reopen). A redelivery after `late_failed` is ignored; an unmatched reversal stays alert-only. `NormalizedProviderEvent.lateReversal` lets an adapter send the same reversal as `charge.failed` (PayPal DENIED after COMPLETED).
- **2026-10-26** — **Outbound requests cannot reach a private network (SSRF).** Deliveries, the
  synchronous Resend, the test send and transform requests all go through `outboundFetch`
  (`src/platform/outbound.ts`). It refuses loopback, RFC 1918, link-local (cloud metadata),
  CGNAT, multicast and reserved addresses, checked on the RESOLVED address of every connection
  (redirects and DNS rebinding included). Create and update also refuse such a URL with a 400.
  `ALLOW_PRIVATE_OUTBOUND_URLS=TRUE` turns the guard off (local development, or a self-hosted
  install with internal receivers); `verify-all.sh` sets it for the suites.
- **2026-10-26** — **Gateway plan 3d (engine conformance).** `refunds[]` is the provider-agnostic
  refund path: per refund id under the payment lock, a `failed` record now reverses what that id
  booked, and a record carrying our tag adopts a lost-answer refund of ours and settles it. A
  payment request's charge books each record's own amount (it booked the whole charge when the
  event had no running total). An unmatched `charge.*` is matched to a lost-answer charge
  (`timeout`, no gateway id) by `ownershipRef` (`resolveLostAnswerByRef`, one candidate, amount
  must agree) and the id is adopted; a capture on one the sweep failed as
  `gateway_charge_not_created` is booked through `reconcileAbandonedCapture`. A late-failure
  reversal row-locks the payment and does not take cash a dispute already took
  (`absorbDisputesIntoReversal`). `asksForLateReversal`: `lateReversal` is the flag;
  `raw.data.reversal` still works and is deprecated. `verify:engine-gateway-conformance`.
- **2026-10-27** — A late-failure reversal (`charge.failed` + `lateReversal`, or
  `charge.reversed`) takes what the payment still holds, not its full amount: paid less refunds
  not failed less dispute cash (`payments/late-reversal.ts`). `reversalAmountMinor` on the event
  is used when set, capped at that. The transaction is re-read under lock, so a concurrent
  redelivery posts nothing. `verify:engine-gateway-conformance` § V.
- **2026-10-27** — **Out-of-band refunds (3g).** A refund record skips booking only for a
  refund's own ref (`re_…`): Braintree copies the sale's `inv_…` ref onto a refund made outside
  us, which was ignored. A refund that does not fit only because one of ours is pending throws
  (the gateway redelivers) instead of being dropped; a capped one is logged. Same rule on the
  running-total path. `verify:refund-reconciliation` §8–9.
- **2026-10-27** — **Out-of-band refunds get a refund transaction.** `bookOutOfBandRefund` now
  records one `refund` transaction (linked by `refund_id`, the charge's gateway account), so a
  refund made in the gateway's own dashboard is on the Transactions list and in every refund
  total (`payments-analytics`, reports, lifetime, export, daily measures all read
  `transactions`). `refund.failed` is now scoped to the delivering business: refund ids collide
  across tenants on a shared gateway account and `limit(1)` could reverse another tenant's
  refund. Existing rows: `scripts/backfill-out-of-band-refund-transactions.ts` (dry run by
  default, `--write`, idempotent). `verify:refund-reconciliation` §10.
- **2026-11-01 (Tier 3 PR 2, C5)** — `subscribedEventTypes(tx, org)`: the event types enabled endpoints list explicitly (an all-events endpoint does not count), cached 30 s per org and dropped on any endpoint create, update or delete in this process. Credit-hold events are written only when this set names them. Gate: `verify:credit-holds` §7.
- **2026-11-02 (0481)** — A late failure (reversal) passes `billing_rules_config.mandate_revoked` to `planFailureRearm`, like the other two failure writers.
- **2026-11-02 (0481)** — The reversal re-arm is now `rearmReversedInvoice`, shared with payment-request reversals. A mandate going live stamps `payment_methods.authorized_at` with the event's own time, so a delayed activation cannot clear a later revocation.
- **2026-11-03 (settings slice F)** — The reversal re-arm passes the plan policy, the method type, `retries_by_method` and `adaptive_cadence` to `planFailureRearm`. Gate: `verify:settings-dunning-p2`.
- **2026-11-03 (0495, security)** — `rearmReversedInvoice` restores the `status = 'paid'` guard lost in slice F, for the direct reversal too: it locks the invoice, skips it when it is not `paid` or other money still pays it, and the update is conditional on `paid`. Gate: `verify:payment-requests` §18.
