# payment-methods — vaulted sources, roles, lifecycle

> Source: `src/modules/payment-methods/` · Routes: `src/api/payment-method-routes.ts` · Schema: `db/schema/payment-methods.ts`
> Layer: payments (see docs/architecture/architecture.json)

## Purpose
Manages vaulted payment instruments per customer: vaulting via a gateway token (PCI SAQ-A — we never
store a PAN), roles (primary/backup) for collection ordering, and a status lifecycle with an expiry
sweep. Collection falls back primary → backup on hard decline.

## Responsibilities
- Vault a payment method (or initiate a hosted vault setup); detach.
- Assign roles (primary/backup); set default; set status.
- Daily sweep: cards expiring this month → `expiring`, past → `expired` (+ events).

## Data model
`db/schema/payment-methods.ts` — `payment_methods` (gateway token, `role` primary|backup|none,
`status` valid|expiring|expired|invalid|pending_verification, `gateway_account_id`). No PAN stored.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `vaultPaymentMethod` / `initiateVaultSetup` | vault via token / hosted setup |
| `assignPaymentMethodRole` / `setDefaultPaymentMethod` / `getPaymentRoleIds` | roles |
| `setPaymentMethodStatus` / `paymentSourceSweep` | lifecycle + expiry sweep |
| `detachPaymentMethod` / `listPaymentMethods` | detach / read |
| `assertVaultPreconditions` | the ONE precondition list both add-card entry points check before a gateway is called |

## API routes
| Method · Path | Purpose |
|---|---|
| vault / list / assign_role / set-default / detach | via `payment-method-routes.ts` (6 routes, mounted under customers) |

## Events emitted
`payment_source.added`, `payment_source.deleted`, `payment_source.role_changed` (+ expiring/expired from the sweep).

## Dependencies
- **Upstream (calls into):** events, webhooks.
- **Downstream (called by):** customers, invoicing.

## Invariants & gotchas
- We stay **PCI SAQ-A**: the provider tokenizes the card; we store only the token (ADR-008).
- Collection order: subscription PM → customer primary → customer backup (on hard decline) → fail.
- Assigning primary demotes the previous primary.
- **Deleting a payment source deletes it at the gateway too** (`detachPaymentMethod` →
  `adapter.deletePaymentMethod`). Best-effort: a gateway failure is logged with the provider ids and
  the local row goes anyway — blocking a customer's delete on a gateway outage is worse than an
  orphaned vault entry, but the orphan is real, so the warning is the cleanup trail.
- The gateway delete is **skipped when another `payment_methods` row shares the same
  `provider_payment_method_id`** (no unique index on it — a token can legitimately appear twice via
  re-vault or import), else deleting upstream would break the surviving row.
- For a PayPal wallet vault the delete **cancels the billing agreement** — not reversible. Stripe has
  no hard delete: `detach` IS the deletion (unowned, never chargeable again). **RazorPay refuses to
  delete an ACTIVE mandate** and exposes no cancel API, so a deleted RazorPay payment source can leave
  a live mandate upstream — the adapter raises an actionable error, the local row still goes. Details +
  operator ask in `src/modules/gateway/README.md`.
- **One delete only:** it removes the instrument at the gateway too. There is no local-only variant.
- **`reference_id` names the GATEWAY, never us.** It is
  `<provider_customer_id>/<provider_payment_method_id>` (the `Reference ID` format), token-only for
  gateways with no customer object (PayPal), and `null` when there is no gateway token — in which case
  the caller renders **nothing**. Never substitute `pm_…`: the value's whole purpose is that it can be
  pasted into the gateway's own dashboard, so an internal id under that label is a false statement.
  Anything serializing a payment method must go through `serializePaymentMethods` /
  `serializePaymentMethodWithGateway` so `gateway_account*` is populated too.

## Changelog
- **2026-11-05** — The add-card call's `collect_open_invoices` is stored on the row
  (`payment_methods.collect_open_invoices`, 0502; null = the business rule; a re-vault that
  passes it overwrites it). `applyMandateStatus` reads it when a mandate goes live (webhook,
  paused-mandate sweep), so a pending e-mandate confirmed later collects as the operator asked.
  The first confirmation clears it, so a later resume follows the rule. Not on the view.
  Gate: `verify:gateway` (OCA, 6 checks).
- **2026-11-05** — `POST …/customers/:cus/payment_methods` takes `collect_open_invoices`
  (boolean), which overrides `dunning_config.collect_on_payment_method_update` for one call;
  omitted = the business rule. Operator API only: the portal, checkout and the mandate-confirmed
  webhook keep the business rule. Gate: `verify:create-gating` 10d.
- **2026-11-02** — Card expiry lead days (`reminder_config.card_expiring`): the sweep emits
  `payment_source_expiry_reminder` on each lead day before the card stops working (the first
  instant after its expiry month), deduped on the events log per (card, `expires_at`, lead
  day). For those businesses `payment_source_expiring` still fires once, with `suppress_email`.
- **2026-11-02** — `mandate-currency.ts`: the mandate currency guard, shared by collection and
  payment intents. It applies only where the gateway lists the method in
  `mandateCurrencyAuthoritative` (catalogue copy pinned by `test/unit/dispute-feed.test.ts`).
- **2026-11-02** — `noticeLeadHours` (`notice-duty.ts`) floors a gateway's worst case by the
  instrument's own lead (`preDebitRule(cap, pm.type)`), not the gateway default.
- **2026-11-02** — `recheckPausedMandates` scans under `scanBusinessFilter`: a time-travel step
  polls only its own business's paused mandates, and a real tick skips travelled businesses.
  Unscoped, every step re-asked the gateway about every paused mandate in the database.
- **2026-10-30** — A `setupAuthCharge` marked `firstCharge` (a registration that paid a first
  invoice) queues its refund job 2 hours late (`FIRST_CHARGE_REFUND_DELAY_MS`); the job's
  `booked_payment` check then stands it down once the signup booked the charge.
- **2026-10-29** — **A mandate's auth amount goes back.** A vault whose ref carries
  `setupAuthCharge` (RazorPay's ₹1 card / UPI Autopay registration payment, captured and never
  booked) queues `refund_setup_auth` after commit, keyed per charge (`setup-auth-refund.ts`). The
  job waits while the mandate is `initiated`, refunds through the adapter with the key as its tag,
  finds its own refund on a repeat, never touches a booked payment, and logs
  `setup_auth_refund_failed` at error on the last of 12 attempts (the failed job stays in the
  queue). No ledger posting: the capture was never booked. Proof: `verify:setup-auth-refund`.
- **2026-10-29** — `assertVaultPreconditions` refuses a new setup of a method in
  `live-proof-pending.json` and drops it from the account's list; with no list, it names the
  gateway's other advertised methods so the adapter cannot add it. Saved methods keep charging.
- **2026-10-28** — `listVaultGatewaysForBusiness(…, purpose)`: `setup` (default) as before;
  `payment` lists the accounts that take a payment now, for the portal's Pay now chooser
  (`GET /portal/v1/payment_methods/gateways?purpose=payment`). The setup test reads an absent
  `intentPurposes` as both, like the contract says. The vault route asks the router for `setup`.
- **2026-10-26** — `mandate_status_at` (0395): when the gateway event that set `mandate_status` happened. `applyMandateStatus` does not apply an older event; a poll stamps now. A replaced GoCardless mandate moves the row to the new `provider_payment_method_id`.
- **2026-09-14 (latest)** — **Those stored instrument facts now leave the database.** `0250`/`0251`
  landed the columns two days earlier and nothing read them back: `serializePaymentMethod` emitted
  brand/last4/expiry and stopped, so every API consumer, the buyer portal and both operator screens
  were blind to the issuer, the funding type and the capabilities we had already paid a gateway call
  for. The serializer now carries an **`instrument`** null-object — `funding`, `sub_type`,
  `issuer_country`, `issuer_name`, `fingerprint`, `supports_international`, `supports_recurring`,
  `three_d_secure_supported` — shaped like `mandate` and `avs_check` beside it: the object is null
  when the gateway reported none of it, and a null FIELD inside means that one fact is unknown.
  Additive only; nothing was renamed or removed.
  - ⚠️ **A null `issuer_country` is UNKNOWN, never "not India"** — `debitNeedsBuyerAuthentication`
    reads it that way, so a consumer that treats the absence as a negative inverts the AFA rule.
    The dashboard says "Not reported" on a card rather than leaving the row out, because the answer
    changes what a renewal does and `pnpm repair:pm-details` is what fills it in.
  - ⚠️ `supports_international` is a usage CAPABILITY, not an origin. The two are different
    questions and the column comment has said so since 0251; the serialized names keep them apart.
  - ⚠️ **`is_default` is not a third role.** It is `role === "primary"` (this file, line ~65) and
    `setDefaultPaymentMethod` is a one-line alias for `assignPaymentMethodRole(…, "primary")` —
    "default" is the pre-C6 name, kept on the API because integrators hold it. The operator
    dashboard was rendering `Primary`, `Backup` **and** `Default` as if there were three, with the
    third chip guarded by `is_default && role !== "primary"` — unreachable by construction — and a
    `Set default` button posting what `Make primary` posts. Both removed.
  - **Every SURFACE says `Primary` now** (2026-09-14). The buyer portal and checkout said "Default"
    where the dashboard said "Primary", for this one field, and the portal row rendered "Make
    default" beside "Make backup" — a pair whose first half has no opposite. One word per role,
    matching `role` and `/assign_role`, so an operator reading a payer's screen needs no
    translation. Copy only: `is_default` and `POST …/payment_methods/:pm/default` are unchanged,
    and so is every behaviour.
  - `PaymentMethod` in `src/api/openapi.ts` documented the block, and **`mandate` and `avs_check`
    with it** — both had shipped undocumented, so the published schema had been describing a
    thinner object than the API returns. `pnpm sdk:generate` re-ran.
- **2026-09-12** — **The instrument facts every gateway already hands us are now STORED**
  (`0250`, `0251`): `issuer_country`, `instrument_funding`, `issuer_name`, `instrument_fingerprint`,
  `instrument_sub_type`, `supports_recurring`, `supports_international`, `three_d_secure_supported`,
  plus a partial index on `(organization_id, instrument_fingerprint)`. ⚠️ **`iin`/`bin` are
  deliberately absent** — that is the PAN prefix and we stay SAQ-A. These columns are not a card
  concept: netbanking, UPI, wallet and direct debit carry them too.
  - **Two gates on the India AFA prediction** (`mandate-afa.ts`). `INR_AFA_FREE_CEILING_MINOR`
    (₹15,000) is where AFA is **compulsory**, not where an issuer *may* ask, so the age-based stamp
    below that line is gone; and RBI binds **Indian-issued cards**, not INR-denominated debits, so a
    non-`IN` `issuerCountry` exits early. `authenticationWaitMayBeRecorded()` is the replacement for
    the inference — it says whether a gateway STATEMENT may overwrite the recorded code.
  - **Re-adding a card adopts the existing row** instead of creating a second one: fingerprint
    match scoped to the same customer + `providerKey` + `gatewayAccountId`, recording
    `metadata.superseded_tokens`. `pnpm repair:pm-details` backfills all of the above (dry-run by
    default; fills only nulls; stamps `metadata.instrument_details_checked_at`).
- **2026-09-07** — `MANDATE_MISSING_STATUS` (`'missing'`): the instrument needs a mandate on
  this gateway and has none. Written by `collectInvoice` from a refusal it actually received, never
  guessed — our columns cannot tell a migrated India card from a plain card-on-file (all 13 migrated
  Stripe rows are bare). `mandateChargeability` gives it its own answer, kept apart from `none`
  (nothing reported) and `dead` (a mandate that existed and ended). ⚠️ Deliberately NOT in
  `MANDATE_NORMALISED_STATUSES`: that list is the vocabulary the ADAPTERS emit and the four status
  sets partition it (asserted in `mandate.test.ts`), and this status is ours.

- **2026-09-06** — ✅ **#97: vaulting could pick a gateway that cannot charge the card.**
  `vaultPaymentMethod` read `customers.currency` raw, and that column is usually null, so routing was
  skipped for most customers and the business default came back whatever currency it settles in — a
  token that fails at its first renewal and can never be moved. It now resolves the currency the way
  `api/vault-setup.ts` already does (explicit → live subscriptions → business default).
  `listVaultGatewaysForBusiness` returned `created_at DESC`, so the provider both storefronts preselect
  was whichever account was configured LAST while a `setup` with no explicit account vaulted on the
  business default — the two disagreed; the default now comes first. Its currency filter was a
  hand-rolled copy of the router's and now calls the shared `handlesCurrency`.

- **2026-09-01 (later)** — **The ceiling is now per-business, and the sweep no longer silences the
  webhook to silence the mail.** Two of "what the mandate and column work left behind"
  (`docs/PROGRESS.md`).
  * **`MANDATE_HEADROOM_BPS` and `SMALLEST_RAIL_CEILING_CAP_MINOR` were one exported constant apiece.**
    Added `businesses.mandate_config` (migration 0221) and `resolveMandateHeadroomConfig` —
    mirrors `resolveDunningConfig`: a nested `{ headroom_bps?, rail_ceiling_cap_minor? }` settings
    object, each key overriding independently, absent or malformed falling back to the platform
    constant. `withMandateHeadroom` takes the resolved config as an optional second argument
    (`= DEFAULT_MANDATE_HEADROOM_CONFIG`), so every existing call site — none of which pass one —
    behaves byte-identically. Wiring the resolved config into `deriveMandateCeiling`
    (`subscriptions/estimate.ts`) and `checkout/service.ts`'s mandate-sizing probe is a patch for
    those files' owners; this only ships the resolver and the backward-compatible signature.
  * **The mandate-expiry backlog cutover (F-45) stopped silencing the webhook.** It used to skip
    `emitEvent` outright for the pre-cutover cohort — the only lever available before
    `emails/outbox.ts` grew a `suppress_email` envelope check — so a webhook subscriber never heard
    about those demotions either. The sweep now emits `payment_source_expired` unconditionally for
    every real transition and stamps `suppress_email: true` only when `notify` is false, so a
    subscriber hears about every demotion and the customer is mailed about only the ones worth
    mailing. `ExpiryDecision.notify` now governs the mail alone, not the event.
  * **`mandate_spent` surfaced to the operator.** The customer detail page's payment-method "Status"
    row now appends a neutral, muted note when the mandate is spent — a used single-use mandate is
    refused by the charge pre-flight without ever writing `payment_methods.status = 'invalid'`
    (nothing is wrong with the instrument), so the primary status badge read "Valid" with no hint
    that the instrument could never be charged again. The badge itself is unchanged — not branded as
    faulty — the note just states the honest consequence next to it.
- **2026-09-01** — **The ceiling fits an upgrade, and a lapsed mandate is refused and demoted.**
  * **Ceiling: 1.25× → 3.5×**, clamped at the smallest rail cap (NPCI's ₹1,00,000 for UPI Autopay) and
    never below the sized amount. Derived, not chosen: the INR monthly ladder (₹9,118 → ₹27,918 → ₹56,118) has
    one-step ratios of 3.0645× and 2.0101×, so 2× and 3× each miss a step and 1.25× missed both — which
    is why every upgrade above +25% was refused `mandate_ceiling_exceeded` and the subscription sat
    unpayable (INV-5381, INV-5440, INV-5443). The clamp is what keeps the generosity free: without it a
    ₹66,219 debit asks for ₹2,31,767, RazorPay clamps to ₹1,00,000 anyway, and `railsOverCeilingCap`
    would withdraw UPI Autopay from buyers UPI can serve. **No AFA implication** — that threshold
    compares the DEBIT, never the ceiling, pinned by a test looping both sizings.
  * **Expiry is now enforced at the charge path** (`mandateHasExpired`, a separate axis from
    `mandateChargeability` so that vocabulary keeps its partition), ahead of the ceiling check, because
    the ceiling's message promises a smaller charge would work — false on a lapsed mandate.
  * **The sweep read ONE expiry fact and there are two.** `upi`/`emandate` rows have no printed expiry
    and were excluded from the candidate query outright; card-rail mandates entered but were judged on
    their printed date — 01/2099 on every row measured — so they always answered "no transition".
    RazorPay overrides `expire_at` on the CARD rail with end-of-day-IST instants, and **115 of 137 card
    mandates were already past their stored expiry while still reporting `confirmed`**.
    Measured consequence, with a healthy sibling present: `collection would charge THE LAPSED MANDATE`.
  * **The pre-cutover backlog is demoted SILENTLY** (`MANDATE_EXPIRY_NOTICE_FROM`, a fixed instant). A
    `first_seen_at` column was considered and rejected on merit: it would record when our sweep happened
    to run, so a restored snapshot or a paused clock would stamp a different date for the identical
    mandate and the payer's mail would follow our ops history instead of their bank's. Idempotency is
    the status transition (`expired` leaves the `('valid','expiring')` filter), not the cutover.
  * ⚠️ **A new auto-collect subscription is now refused at create time** when the customer's only
    instrument has a lapsed mandate (`assertChargeableForAutoCollect` filters `expired`). Correct, new.
  * The ceiling is ONE exported constant, not per-business — a `businesses` column and settings row is
    the next step. Gated by `verify:mandate-expiry-sweep` (25/25) and `test/unit/mandate.test.ts`.
- **2026-08-22** — **The vaulted name is now the BILLING name, not our invented display column.**
  `providerCustomerDetails` sent `customers.name` — a column our importer synthesises — and
  never looked at `billing_first_name` / `billing_last_name` /
  `billing_company`, so a company paying through an accounts-payable contact was vaulted at the
  gateway under whichever individual signed up. It now uses `invoiceContactName`
  (`customers/names.ts`), the same chain the invoice PDF prints, so the vault and the document the
  payment settles can never disagree — which is what an India export-rule check and a chargeback
  reconciliation both compare. ⚠️ `phone` is untouched and still `phone ?? billingPhone`: RazorPay
  needs the PRIMARY number for the recurring-mandate contact, the opposite order to the address, which
  is why `billingContact` deliberately carries no phone at all. ⚠️ `ensureProviderCustomer` pushes
  `updateCustomer` on reuse, so an existing provider customer is RENAMED at the gateway on its owner's
  next setup — intended (the name was wrong), but it is a visible change on the provider side.
- **2026-08-17b** — **The AFA rule moved to a LEAF module** (`mandate-afa.ts`, zero imports), because
  `transactions/serialize.ts` needs it and that file exists to break the cycle
  serialize → service → events/emit → events/content → serialize. `payment-methods/service` imports
  `events/emit`, so importing the predicate from there would have closed the same cycle by a different
  door. `service.ts` re-exports all four symbols, so every existing importer is unchanged and this
  module is still the one place to look for mandate rules.
- **2026-08-17** — **The ₹15,000 AFA rule now decides something.** `requiresAfaPerDebit` had existed
  since 2026-08-12, was unit-tested, and was **called by nothing** — the engine knew the rule and
  acted on it nowhere. Above the threshold a card debit was sent, accepted, and parked as an
  ordinary slow settlement, indistinguishable from a healthy netbanking one because RazorPay reports
  both as `created`. Nobody told the customer, and a renewal they could have approved in 30 seconds
  became involuntary churn.

  Two things were missing, not one. The threshold is about the **amount**; whether a rail has to stop
  and ask is about **how that rail authenticates** — and conflating them gets both wrong.
  `RAILS_NEEDING_PER_DEBIT_AFA` + `debitNeedsBuyerAuthentication` separate them:
  - **card** needs it — measured with a control on one mandate: ₹13,870 captured, ₹28,215 and
    ₹56,715 sat in `created` indefinitely.
  - **netbanking e-mandate does not** — measured: ₹66,025 off-session against a real HDFC mandate,
    captured and settled (`pay_XXXXXXXXXXXX23`). **This is the only rail that renews unattended above
    ₹15,000**, which makes it the answer for any plan priced there.
  - **UPI is listed on inference, not evidence.** The only datum above the threshold is a ₹66,025
    *sandbox* debit that settled, and `success@razorpay` auto-approves. Asymmetric costs decide it: a
    needless notice is noise, a missing one is a silent stall.
  - An **unknown** rail is not assumed to need it — this drives customer-facing mail.

  The state is **derived, never stored**: the same predicate answers at booking time and in the
  stale-pending sweep, so the two cannot disagree about what an attempt is.

- **2026-08-12** — **The mandate an instrument was registered under is now STORED, and enforced
  before the gateway is called** (migration `0179`, six `mandate_*` columns on `payment_methods`).
  `deriveMandateCeiling` computed a per-debit ceiling, handed it to the adapter, and threw it away;
  the adapter then read the real one back from the provider's token entity — to learn the method
  type — and discarded that too. So at debit time the engine knew the rail but not its limit.

  RazorPay enforces `max_amount` per debit, and the two numbers genuinely differ:
  `createMandateOrder` clamps the request to `MAX_UPI_MANDATE_MAX_AMOUNT` (₹1,00,000) or
  `MAX_MANDATE_MAX_AMOUNT` (₹10,00,000) before sending it, and the buyer's bank can register lower
  still. An upgrade, a quantity bump or tax becoming applicable then pushes a renewal past a ceiling
  derived months earlier, and the refusal is **indistinguishable from an ordinary decline**: dunning
  retries on a schedule, the backup instrument gets burned, the pm can be marked `invalid` — and
  none of it can succeed, because the mandate itself is what has to change.
  - `ProviderMandate` on `ProviderPaymentMethodRef` (provider-agnostic — Stripe's India e-mandate,
    SEPA and ACH have the same shape); RazorPay populates it in `vaultPaymentMethod` from the token
    entity it already fetches. **Stored as the provider reports it, never as we asked.**
  - `mandateRefusal` (`invoicing/collection.ts`) fails an over-ceiling debit as
    `mandate_ceiling_exceeded` **before** spending a gateway call, with a message naming the ceiling
    and the remedy. `park` in smart dunning: recoverable, but only by the customer re-authorizing.
  - ⚠️ **A null ceiling means UNKNOWN, not unlimited** — no mandate rail, a provider that does not
    report the field, or a row vaulted before 0179. The pre-flight SKIPS the check rather than
    assuming headroom, and the dashboard prints "Not reported" rather than leaving a suggestive gap.
  - **`token.confirmed` / `.rejected` / `.cancelled` / `.paused` are handled** (new
    `payment_method.mandate_updated` event → `applyMandateUpdate`). They were already in RazorPay's
    subscription list, so they had been arriving and landing `unknown` since the rail was built. Both
    directions matter: a netbanking token confirms **T+1** (HDFC/SBI) and this is how we learn it went
    live, while a buyer revoking a UPI mandate in their app is the *only* notice we ever get —
    RazorPay exposes no cancel route to poll (operator ask 5). A dead mandate marks the pm `invalid`;
    a confirmation deliberately does **not** flip it back to `valid`, which would undo a legitimate
    `invalid` set by the card updater or a hard decline.
  - **`INR_AFA_FREE_CEILING_MINOR` + `requiresAfaPerDebit`** put RBI's ₹15,000 rule in code instead of
    a comment. `largestRecurringDebit` is split out of `deriveMandateCeiling` because the two answer
    different questions — the ceiling is 3× the debit, so testing the *ceiling* against the threshold
    would flag an ordinary ₹6,000 plan whose ₹18,000 ceiling clears it. The dashboard shows the
    mandate facts and deliberately shows **no** AFA warning: that card knows the ceiling, not the
    debit.
- **2026-08-07** — **`reference_id` is now the GATEWAY's reference, and `gateway_account` is
  exposed.** The API returned no `reference_id` at all and both detail screens rendered our internal
  `pm_…` under the `Reference ID` label — a field that claims to be a gateway reference while
  showing a tmbilling id. The value is the composite
  `<gateway customer id>/<gateway token id>`, e.g. `cust_XXXXXXXXXXXX01/token_XXXXXXXXXXXX03`.
  `serializePaymentMethod` now derives it from the payment_methods row's own
  `provider_customer_id` + `provider_payment_method_id` — the authoritative pair, since the stale-
  SetupIntent path re-points `provider_customer_id` on the pm row and it can differ from the
  `provider_customers` mapping. It is the exact inverse of what the importer parses, so
  imported rows round-trip byte-for-byte. **PayPal** is token-only: it mints no customer, so its
  adapter stores OUR `cus_…` in `provider_customer_id` and emitting that half would smuggle an
  internal id into a gateway field. `null` when there is no token at all — the UI then drops the row
  rather than filling it. Same pass adds `gateway_account` (`gwa_…`) + `gateway_account_label`
  (the "Gateway account  Razorpay-1" row) via one batched `gateway_accounts` lookup; new async
  `serializePaymentMethods` / `serializePaymentMethodWithGateway` wrappers do the join, and every API
  + portal route uses them. The dashboard's `Type: Card` row is gone.
- **2026-08-05** — **Audited (0149).** `vaultPaymentMethod`, `detachPaymentMethod` and
  `assignPaymentMethodRole` write audit rows scoped to the **customer**, not to the payment method: a
  detached card has no page left to drill into, and the customer's Activity Log is where anyone looks
  for "who added a card to this account". The diff names the instrument (`visa •••• 4242`) because once
  the gateway delete succeeds nothing else can tell you which card it was. Detach is audited even when
  GDPR erasure drives it in a loop — brand and last4 are not personal data, and the removal still has
  to be reconcilable.
- **2026-07-31** — **Deleting a payment source now deletes it at the gateway.** `detachPaymentMethod`
  was a pure local DELETE, and `clearPersonalData`'s CUST-7 "gateway-delete" was a no-op: it called an
  optional `adapter.deletePaymentMethod?.()` that **no real adapter implemented**, inside a bare
  `catch {}`. So every deleted card — including after a GDPR erasure — stayed vaulted and chargeable at
  Stripe/RazorPay/PayPal. Implemented on all three adapters (Stripe `payment_methods/:id/detach`,
  RazorPay `DELETE /customers/:c/tokens/:t`, PayPal `DELETE /v3/vault/payment-tokens/:id`, all
  idempotent per the contract); the gateway delete now lives in `detachPaymentMethod` so every
  surface (API, portal, GDPR erasure) gets it, and `clearPersonalData` no longer duplicates it.
  Guarded by the shared-token check above. See `verify:payment-source-delete` (offline, 11/11) and
  `verify:gateway-delete-live` (real sandboxes, 11/11).
- **2026-07-30 (fix)** — A gateway refusing a buyer-supplied token surfaced as a 500 "Internal server
  error" on every vault surface (operator, portal, checkout) — the most common cause being a PayPal
  setup token whose approval expired, was cancelled, or was already exchanged. `vaultPaymentMethod`
  now wraps a failing `provider.vaultPaymentMethod` in **`PaymentMethodVaultError`** (actionable
  message; the provider's own text on `.detail`), which the three routes map to 400 and log at warn.
  Config/adapter faults still 500 as before — this only covers the token the caller handed us.
- **2026-07-21** — Automatic card updater: the inbound pipeline now handles the provider
  card-reissue webhook (`payment_method.updated`) by refreshing the stored brand/last4/expiry on the
  matching `payment_methods` row and setting `status='valid'` (a reissued card supersedes an
  expiring/expired one), then emitting `payment_source_updated`. Adapter mapping in
  `stripe.ts` (`payment_method.automatically_updated`); RazorPay/PayPal defensive (no first-class
  reissue webhook). See `verify:card-updater`.
- **2026-07-14 (fix)** — RazorPay add-card 500'd (*"The contact field is required for recurring links"*):
  `providerCustomerDetails` never forwarded the customer's phone, so the RazorPay provider customer had no
  `contact` and the e-mandate auth-order failed. The mapper now sends `phone` (primary → `billing_phone`
  fallback), and `initiateVaultSetupForBusiness` throws `PaymentMethodConfigError` (→ 400) when a RazorPay
  vault is attempted for a customer with no phone, instead of letting the provider 500.
- **2026-07-13** — Added `listVaultGatewaysForBusiness` (active, vault-capable gateway accounts) and a
  `gatewayAccountId` option on `initiateVaultSetupForBusiness` (vault through a specific gateway instead
  of the business default; validates active + vault support). Powers the customer-portal gateway picker.
- **2026-07-13** — Billing LogIQ "collect on payment method update": vaulting a card now fires
  `collectOutstandingForNewPaymentMethod` (best-effort) to charge the customer's open auto-collect
  `payment_due` invoices against the new card; the add-card response includes `collected_invoices`.
  Gated per-business by `dunning_config.collect_on_payment_method_update` (default on).
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-07-13** — `vaultPaymentMethod`'s no-provider-given path no longer falls back to the removed
  `mock` provider; it resolves the business's default/most-recent active gateway account
  (`resolveDefaultAccountForBusiness`) and throws a clear error if the business has none configured.
- **2026-07-13** — Buyer-side vaulting (P14 slice): Stripe `initiateVaultSetup` (SetupIntent →
  `client_secret` mode on `VaultSetupRef`, publishable key via creds/`STRIPE_TEST_PUBLISHABLE_KEY`);
  tmtest fake `client_secret` setup; new `initiateVaultSetupForBusiness` resolves the business's
  default gateway account (used by the customer portal). Stripe vault completion tolerates a
  SetupIntent-attached pm (no-op re-attach) but rejects pms attached to another provider customer.
  Operator setup route now accepts `provider: 'stripe'`.
- **2026-07-13 (fix)** — SetupIntent completion against a real Stripe gateway 500'd: `ensureCustomer`
  creates a fresh Stripe customer per call, so setup + completion used different customers and the
  attach hit the cross-customer guard. Vault now adopts the pm's existing Stripe customer when its
  `metadata.tmbilling_ref` matches our customer (`VaultPaymentMethodInput.customerRef`), and the row
  stores the adopted `providerCustomerId` (`ProviderPaymentMethodRef.providerCustomerId`) so future
  off-session charges use the right customer.
- **2026-07-13 (fix 2)** — Duplicate provider customers + India-exports: new `provider_customers`
  mapping (migrations 0115 + 0116 backfill) — one provider customer per customer × provider ×
  gateway account, created once via `ensureProviderCustomer` and REUSED (previously every
  `ensureCustomer` call minted a fresh Stripe customer). On reuse, adapters implementing the new
  optional `updateCustomer` (Stripe) get current name/address pushed — Indian Stripe accounts
  require them on SetupIntent confirm (export regulations). Both setup paths now send the full
  address; the importer seeds the mapping from source `reference_id` gateway customers.
- **2026-07-13** — `assertChargeableForAutoCollect` + `NoChargeablePaymentMethodError`: presence +
  provider verification check used by subscription-creation gating.
- **2026-08-10** — `persistVaultedPaymentMethod` extracted from `vaultPaymentMethod` (same body:
  the row insert, stale-provider-customer adoption, `payment_source_added` + `customer_updated`,
  audit entry), and `ensureProviderCustomer` exported. A `setup` payment intent arrives with the
  instrument **already vaulted** — `consumeIntent` hands back the `ProviderPaymentMethodRef` and
  there is no token left to exchange — so payment-intents calls in here rather than growing a
  second writer of `payment_methods`. Behaviour of `vaultPaymentMethod` is unchanged.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-21** — `persistVaultedPaymentMethod` is **idempotent on the provider's own id for the
  instrument** (`customer × provider_key × provider_payment_method_id`), enforced by
  `payment_methods_provider_pm_uq` (0183). Two paths vault one instrument by design — the buyer's
  browser completing the add-card, and `harvestSetupIntent` doing it from the gateway's webhook for
  the buyer who never comes back — and only the second was going through the payment intent's atomic
  claim, so both wrote: measured on RazorPay UPI, `token_XXXXXXXXXXXX02` became two rows 15s apart
  and the portal listed one mandate twice. A second arrival now REFRESHES the row it finds from the
  fresher readback (mandate status, ceiling, display fields — never blanking what the new ref is
  silent about) and returns it, with no second `payment_source_added` / `customer_updated` / audit
  entry, because nothing was added. Deduping in the writer rather than at the call sites is what
  makes it hold for every gateway and every flow. The portal's completion route also gained a
  `payment_intent` shape so the browser and the webhook contend for one claim in the first place.

- **2026-08-27** — the expiry sweep's `payment_source_expiring` / `payment_source_expired` events now
  carry **`customer`, `type` and `brand`** alongside the expiry fields, matching what
  `payment_source_added` has always emitted. They previously named only the card
  (`id`, `last4`, `exp_month`, `exp_year`), and the missing `customer` was not cosmetic: a subscriber
  could not tell WHOSE card had lapsed. A webhook adapter that resolves the account from the customer
  returned null for every one of these events — the sweep transitioned cards correctly for
  weeks while not one customer was ever told, and nothing failed loudly enough to notice. `type` and
  `brand` are the other half: without them a consumer cannot say "Visa ending 4242" in the mail it
  sends about the event. The candidate query gained an `innerJoin` on `customers` for the PUBLIC id
  alone (`payment_methods.customer_id` is an internal uuid no consumer can look anything up by),
  joined rather than fetched per row because this is the cross-tenant pass that already scans every
  business.

- **2026-08-27** — **the mandate headroom is 25%, and the ceiling is no longer sized here.**
  `MANDATE_HEADROOM = 3n` became `MANDATE_HEADROOM_BPS = 12_500n` + `withMandateHeadroom()`
  (ceil-rounded, so a ceiling is never a rupee short of the debit it was sized for), and
  `deriveMandateCeiling` moved to `subscriptions/estimate.ts`. Both halves of one decision:
  * The buyer READS this number — RazorPay states it in the mandate modal at registration, and the
    portal now prints it on the saved instrument ("Up to ₹15,000.00 per charge"). ×3 read as
    reserving three times the plan: ₹7,785 of authorisation for a ₹3,062 debit on a ₹2,595 plan.
  * 25% is only safe on a **tax-inclusive** base, which is why the two changes are one. The old
    input was `largestRecurringDebit` — a sum of `prices.amount_minor × quantity` that missed tax
    entirely (18% GST alone would have eaten 1.18 of a 1.25 multiplier), ignored the item's frozen
    `price_snapshot` (so a custom `unit_price_minor` override was invisible), and read **0** for
    every tiered / volume / stairstep / percentage price and near-0 for metered ones. Sizing now
    asks `estimateRenewal` what the next invoice will actually present.
  * `largestRecurringDebit` stays, for the two jobs it is still honest at: the buyer-facing AFA
    advice (`expected_debit_minor`, which asks "is this spend near ₹15,000" and must not plan an
    invoice per subscription on a page load) and the fallback when no estimate can be produced. It
    also gained the `status` filter it always claimed to have — a cancelled ₹50,000 plan was
    inflating both the ceiling and that advice. `paused` stays IN: a pause is expected to end.
  * `initiateVaultSetupForBusiness` no longer derives the ceiling itself — it takes one.
    `beginVaultSetup` derives it ONCE and passes the same number, with the same currency, down
    both the intent path and the legacy path. They used to derive separately, and the legacy path
    resolved its own currency without consulting live subscriptions, so the same buyer could reach
    the gateway with a different ceiling depending on which path served them.
  * Same entry, the rail caps: `MANDATE_RAIL_MAX_CEILING_MINOR` + `railsOverCeilingCap` joined the
    leaf (`mandate-afa.ts`), because NPCI's ₹1,00,000 UPI Autopay registration cap is a property of
    the RAIL, like the AFA threshold beside it. `providers/razorpay.ts` keeps its own copies —
    providers are a lower layer and must not import from modules — and `test/unit/mandate.test.ts`
    pins the two together, so the test is the link. Used to STEER (the checkout points a buyer whose
    plan needs more at netbanking or a card), never to block: all three rails still collect smaller
    debits.
  * Same entry, **the first usable instrument now becomes the customer's `primary`**. It was left at the
    schema default of `none`, so a buyer who had just added their only card was shown "Default payment
    method: None on file" directly above that card, and collection fell through to "newest valid" — the
    same instrument by luck rather than by intent. An existing primary is never demoted here; that
    stays an explicit act. Read and write share the vault transaction, because two concurrent vaults
    would otherwise both see "no primary" and both claim it (there is no partial unique index).

- **2026-08-30** — **one precondition list for add-card, and the settlement guard finally runs on the
  path buyers take.** `assertSettlementReachable` refuses to register a mandate on a LIVE
  async-settlement gateway account with no webhook endpoint — the state where the buyer authorises,
  the gateway debits real money, and no invoice is ever marked paid. It had exactly one call site,
  inside `initiateVaultSetupForBusiness`, which is the LEGACY fallback. Both buyer surfaces (customer
  portal, hosted checkout) go through `beginVaultSetup`'s INTENT path, whose own preflight was a
  hand-copied subset: gateway active, RazorPay contact, method-type allow-list — three of the four,
  and the missing one was the only one with money behind it. The four are now
  `assertVaultPreconditions` here, called by both; the copy is gone. Two `verify:gateway` checks pin
  it, one of them on `beginVaultSetup` itself asserting an EMPTY `gateway_request_logs` for the
  account — the message alone proves nothing, because the legacy fallback raises the same words one
  gateway round-trip later. Both were mutation-tested red.
  * Same entry, the rule became **method-aware** — see `gateway/README.md` for the shape and why.
  * Same entry, `WEBHOOK_BASE_URL` unset is now its own refusal. `getWebhookEndpointInfo().configured`
    only means "we hold verification material for this account"; with no public base URL there is no
    address for the gateway to POST to at all, and the account's credentials look perfectly configured
    in that state. ⚠️ `configured` remains a PROXY either way: a RazorPay endpoint the operator pasted
    by hand at the gateway is not observable from here, and conversely `createGatewayAccount` mints a
    `webhook_secret` for every RazorPay account at birth — so the guard's real trigger is an account
    whose credentials were REPLACED without one (`updateGatewayAccount` overwrites the blob wholesale),
    which is what a key rotation does.
  * Same entry, **the requested method type is now validated against the adapter's
    `capabilities.methods`**, not just against the `gateway_accounts.method_types` column. That column
    is free-form jsonb, so `upi` could be stored on a Stripe account: Stripe's capabilities exclude it,
    `handlesMethod` in the router matches a charge on the pm's canonical type and could never route it,
    and the add-card either 400'd at the gateway or silently fell back to a card. Refused with the same
    actionable `PaymentMethodConfigError`. Card presentations (`wallet`, `apple_pay`, `google_pay`,
    `link`) count as satisfied wherever the gateway declares `card` — Stripe deliberately omits them
    from `capabilities.methods` (they ARE cards; listing them would let an operator store an unroutable
    `method_types`) while the buyer-facing `method_type` enum accepts `wallet`.

- **2026-08-30** — **`assertChargeableForAutoCollect` stopped promising a gateway verification nothing
  performed.** Its docstring advertised two checks; the second — "the gateway verifies it, when the
  adapter supports verification" — was `tmtest`-only. Every real adapter fell out at
  `if (!provider.verifyPaymentMethod) return`, so the suites exercised a step production never ran and
  the docstring gave live operators a guarantee no live customer ever got. Deleted, along with the
  provider resolution that existed only to reach it (which also removes a `gateway_accounts` read and
  an adapter build from the subscription-CREATE hot path). It was NOT pushed down into the real
  adapters instead: on Stripe/RazorPay/PayPal there is no free answer to "is this saved instrument
  still good" — a retrieve reports what was vaulted, not what the issuer would authorise today, so a
  truthful probe is a zero- or minimal-amount authorisation, a real gateway round-trip in the create
  path. That is a decision to take deliberately, at add-card time, and it
  needs an adapter that implements `verifyPaymentMethod` plus a test that can go red.
  `verifyPaymentMethod` stays in the provider contract; nothing in the engine calls it now.

- **2026-08-30** — **F-14: `updateCustomer` is implemented on RazorPay, and the identity sync can no
  longer fail a payment.** `ensureProviderCustomer` pushes our current identity onto a REUSED provider
  customer via `provider.updateCustomer?.(…)` — optional chaining, and only Stripe implemented it. On
  RazorPay that was a dead end, not a cosmetic gap: `createEmandateAuthLink` reads `contact` off
  **RazorPay's own** customer record and refuses without one, while `assertVaultPreconditions` refuses
  up front unless a phone exists **locally**. So a customer whose RazorPay mirror was minted before a
  phone existed was permanently unable to register a mandate — adding the phone (portal billing
  details, or checkout's "Edit billing details") satisfied the local gate, changed nothing at the
  gateway, and left the buyer blocked by an error naming an operator action they had already
  performed. The escape hatch built for that exact error could not clear it.
  * **What RazorPay actually allows, measured live in test mode (2026-08-30), not assumed.** The edit
    verb is **`PUT /customers/{id}`**. `PATCH` is not routed at all — valid id, bogus id and empty body
    alike answer `404 {"message":"no Route matched with those values"}`, so there is no PATCH fallback
    to write. `PUT` accepts `name`, `email`, `contact`, `gstin`; it **silently ignores** `notes`,
    `shipping_address` and unknown keys (no error, no effect) — which also means the create-time
    ownership binding cannot be repaired *or forged* through this endpoint. An empty body is a `200`
    no-op; an unknown id is `400 "The id provided does not exist"`.
  * ⚠️ **`contact: ""` is ACCEPTED and BLANKS the stored contact.** Every field is therefore sent only
    when non-empty — a blank would destroy the very mandate the sync exists to enable. Do not
    "simplify" the guards into an unconditional spread; a test goes red if you do.
  * **The duplicate check is on the `(email, contact)` PAIR** — not email, not contact, not name.
    ⚠️ Corrected 2026-08-30: this bullet previously said "on EMAIL, not contact", inferred from a PUT
    that carried all three fields, so the contact matched too and the PAIR is what actually collided.
    Re-measured directly: `PUT {email}` alone to an email another customer holds returns **200** when
    the resulting pair is new, and `PUT {contact}` alone likewise; only a colliding PAIR returns
    `400 "Customer already exists for the merchant"`. Since one PUT carries all three fields, a
    contested pair would take the CONTACT down with it — losing the only field a mandate cannot be
    registered without. So a refusal is retried with the contact alone, which by that
    measurement is a much smaller target — it drops the half of the pair most likely to have caused the collision. It is NOT collision-proof: another customer holding exactly `(our email, that contact)` still 400s, which is why a failed retry is logged rather than thrown.
  * **The sync is best-effort at the ENGINE, for every adapter.** `ensureProviderCustomer` is on the
    hot path of every vault *and* every charge, and `providerFetch` THROWS on a transport failure, so
    a slow gateway on an endpoint nobody is waiting for could have turned a renewal into a dunning
    attempt. The `try`/`catch` lives here rather than in each adapter so the guarantee also covers
    Stripe's `customers.update`, which rejects on any API error. Adapters may still handle their own
    refusals more intelligently; that is not what makes it safe.
  * **The local gate was left alone, deliberately.** `assertVaultPreconditions` fires only when there
    is no phone **anywhere**, which no sync could repair — so it is still the right gate, and making it
    attempt a sync would add a gateway round-trip to the one case that cannot benefit. The repair
    happens where it belongs: `ensureProviderCustomer` runs immediately before `initiateVaultSetup` on
    the legacy path and before `createIntent({purpose:'setup'})` on the intent path both surfaces
    actually take, so by the time the auth link is built the phone is already at RazorPay.
  * **PayPal deliberately does NOT implement it** — and there is a comment there saying so, plus a test
    asserting the absence, so it does not read as an oversight and get "fixed" with an empty method.
    `ensureCustomer` returns our own `cus_…`; Vault v3 stores no customer resource. The nearest thing,
    `customer.merchant_customer_id`, is write-once on the setup TOKEN and is the ownership binding
    `assertSetupTokenBelongsTo` verifies — untouched.
  * `createEmandateAuthLink`'s refusal was reworded: reaching it now means either no phone anywhere or
    a sync RazorPay refused, so it names the `update_customer` call in Gateway Activity instead of
    telling an operator to do what they already did.
  * Pinned by `test/unit/provider-customer-sync.test.ts` (10 cases). Four mutations, all red:
    `PUT`→`PATCH` (5 red), deleting the adapter method — the pre-fix state (6 red), unconditional field
    spread (2 red), and removing the engine `try`/`catch` (exactly 1 red, the guard case, everything
    else green).

- **2026-08-30** — **The mandate STATUS vocabulary is canonical here, and the rail ceiling caps
  finally say which currency they are in.** Two changes to the leaf `mandate-afa.ts`, both about a
  value that carried no denomination of its own.
  * **The status sets moved in (F-11).** `DEAD_MANDATE_STATUSES` was private to
    `modules/webhooks/inbound.ts` and `MANDATE_LIVE_STATUSES` was declared again in the buyer portal,
    so the charge-time guard that now needs them (`invoicing/collection.ts`, `mandatePendingRefusal`)
    would have been a third copy. All three sets — LIVE, PENDING, DEAD — plus `mandateChargeability`
    live here; `inbound.ts` imports the dead set rather than declaring it. The adapters make this
    possible: RazorPay reports `recurring_details.status` and `describeStripeMandate` maps Stripe's
    three onto the SAME words, so `initiated` is the one value both normalise a waiting mandate to.
    ⚠️ They are NOT a partition — a status in none of them is UNKNOWN and must be treated as a claim
    we cannot make, never folded into the nearest neighbour (`spent`, a used single-use Stripe
    mandate, is exactly such a status). ⚠️ The portal's copy stays and must be kept in step by hand:
    `dashboard/` is a separate package whose `@/*` resolves inside itself and cannot import this file.
  * **`railsOverCeilingCap` takes an optional currency (F-24).** `MANDATE_RAIL_MAX_CEILING_MINOR` is
    documented "in minor units of INR" and the function compared against it blind, while
    `resolveSessionMandateRequirement` (`modules/checkout/service.ts`) passes a ceiling in the
    SESSION's currency. A USD session needing more than 10,000,000 minor (~$100k) reported `upi` over
    cap for a business with no Indian rail at all, and the checkout told the buyer "UPI Autopay
    cannot be approved for $X per charge — your bank caps it lower": no bank in that session caps
    anything and there was no UPI on offer to be capped. It now SKIPS on a currency mismatch, the
    same discipline `mandateRefusal` applies one file over rather than inventing an FX rate at the
    comparison site, and `MANDATE_RAIL_CEILING_CURRENCY` names the denomination. The parameter is
    optional so the existing call site cannot change meaning underneath itself — **it still has to
    pass the session currency, which is a one-argument change in a file this change did not own.**
    Until it does, a non-INR session keeps the old wrong answer rather than acquiring a new one.

- **2026-08-30 — F-43: `spent` was a status in no set, so nothing acted on it.** The mandate
  vocabulary in `mandate-afa.ts` gained a FOURTH set, `MANDATE_SPENT_STATUSES`, and
  `mandateChargeability` a fourth answer. `spent` (a used single-use Stripe mandate, reported
  deliberately by `describeStripeMandate` because Stripe's `inactive` means REVOKED on a
  `multi_use` mandate and merely "previously used" on a single-use one) belonged to none of the
  three sets, so the pending guard did not refuse it, `applyMandateUpdate` did not invalidate on
  it, and collection went on debiting an authorization that had already been used — while the
  buyer portal, which treats every unrecognised status as over, had already told the payer it was
  finished.
  * It is deliberately NOT in `DEAD_MANDATE_STATUSES`. That set is an INSTRUCTION, not a label —
    `applyMandateUpdate` writes `payment_methods.status = 'invalid'` for everything in it — and
    nothing was refused here: the mandate did exactly what the buyer authorised, once. More
    decisively, joining it would not have fixed anything, because `resolveChargeCandidates` does
    not filter on `payment_methods.status` at all, so the debit would still have been attempted.
    What stops it is the charge pre-flight `mandateSpentRefusal` (modules/invoicing/collection).
  * The four sets are now a **partition of `MANDATE_NORMALISED_STATUSES`** — every status either
    adapter emits lands in exactly one — while `mandateChargeability` stays OPEN, answering
    `unknown` for anything outside. `test/unit/mandate.test.ts` asserts both halves, so a fifth
    normalised word added without classifying it goes red instead of silently becoming `unknown`.
  * `mandateBecameLive(before, after)` also lives here now — the transition predicate F-42 uses.
  * ⚠️ The buyer portal's copy of this vocabulary (`portal-chrome.tsx`) still agrees: it already
    renders `spent` as `dead`, which is what the engine now enforces. No dashboard edit needed.

- **2026-08-31** — **Promoting the backup used to destroy the backup slot.**
  `assignPaymentMethodRole` always demoted the incumbent to `none`, so the single most
  likely buyer action — "Make default" on the card that IS the backup — left the account
  with a primary and NO fallback. `resolveChargeCandidates` builds `[primary, backup]`
  and collection tries the second before dunning begins, so this silently removed the
  whole second-chance path, with no event distinguishing it from an ordinary promotion.
  Assigning a role to a card that already holds the OTHER designated role is now a
  **swap**: the incumbent takes the vacated role. Both directions, because demoting your
  primary to backup without promoting the old backup would leave you with no primary —
  worse than the state you started in. Everything else is unchanged: an UNDESIGNATED
  card still demotes the incumbent to `none` (there is no third slot to move them to),
  and re-assigning a card the role it already has is still a no-op.
  The swapped-out card gets its **own** `payment_source_role_changed` event and audit
  row — a consumer reading only the assigned card's event would believe the account
  still had whatever it had before. Mutation-tested in `verify:customer-portal`
  (113 → 118): forcing `demoteTo = "none"` reddens exactly the two swap assertions and
  leaves "promoting the backup makes it primary" green, because that half always worked.
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-28** — **One primary, any number of backups.** A newly vaulted card is `primary`
  if the customer has no valid primary, else `backup` (was `none`). `none` now means
  "removed from automatic collection". Making a card primary moves the old primary to
  `backup` (was `none`); demoting the primary directly throws `PrimaryDemotionError` (409 on
  the operator and portal routes) so a customer with cards always has one. The portal now
  accepts `none` (Remove backup). Migration 0297 turns existing `none` rows into backups
  unless the card's latest audited role change was an explicit `none`. The importer maps
  non-primary cards to `backup`.
- **2026-09-28** — Vaulting a card while the primary is not `valid` used to add a SECOND primary (the old one was never demoted). The old primary now steps down to `backup` in the same transaction, with a `payment_source_role_changed` event and an audit row (`swapped_with` the new card); collection skips it while it is `invalid`/`expired`. Migration 0299 repairs existing duplicates, keeping the newest primary — the one collection already charged first.
- **2026-09-30** — `GET …/payment_methods/:pm`; list takes optional `type`/`status` and `limit`/`starting_after` (no params = the full list, same shape). `POST …/payment_methods/permanent_token` (`attachVaultedPaymentMethod`) attaches an instrument already in the gateway vault: confirmed through the new optional adapter method `fetchVaultedPaymentMethod` (Stripe, RazorPay, tmtest), gateway customer must match the customer's mapping, row written by `persistVaultedPaymentMethod`, nothing charged. `POST …/:pm/delete_local` (`deletePaymentMethodLocally`) removes our row only, 409 while a live subscription pays with it or a payment on it is pending, and audits the instrument as still chargeable at the gateway. DELETE is unchanged.
- **2026-10-21** — Card-expiry sweep fetches only rows that will transition, 1,000 per tick, on two partial indexes (0348); it loaded every card each tick. `getPaymentRoleIds(…, outer)` reads on the caller's transaction (pool deadlock under load).
- **2026-10-24** — Add-card for `sdk` / `form_post` gateways: `vault_setup` adds `sdk` and `form_post` (`{action, fields}`); `completeVaultFromIntent` takes `clientResult` (portal `POST /portal/v1/payment_methods` and checkout complete's `setup_intent` pass `client_result`) and refuses with `VaultSetupIntentError` 400 on a decline or a pending answer instead of self-authorizing. Both `initiateVaultSetup` paths hand the adapter `gatewayReturnUrl(...)`. Gate: `verify:gateway-sdk-modes`.
- **2026-10-27** — `assertVaultPreconditions` refuses recurring setup without a person's name
  when the catalogue sets `recurringNeedsName` (Cashfree). `beginVaultSetup` rethrows a
  `ProviderRefusalError` instead of sending the same refused request down the legacy path; the
  API, checkout and portal add-card routes answer it 400. `verify:gateway` NAME.
- **2026-10-28** — **The payer's ACH authorization (0400 `payment_method_authorizations`).**
  `ach-authorization.ts` renders the versioned text (`ACH_AUTHORIZATION_TEXT_VERSION`) the
  storefront shows for an `achAuthorization: "ours"` gateway; checkout and portal completion
  send `ach_authorization: { text_version, accepted }`; `completeVaultFromIntent` renders it
  again with the business and payer, and `persistVaultedPaymentMethod` writes the evidence (full
  text, time, IP, user agent, payer name and email) in the transaction that writes the method.
  A `us_bank_account` on such a gateway without it is refused (`AchAuthorizationRequiredError`)
  and removed at the gateway. The table is append-only by grant (SELECT, INSERT) and has no
  foreign key to the method or customer, so deleting them keeps the proof.
