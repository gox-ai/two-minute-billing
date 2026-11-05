# checkout — hosted checkout (#10d) + hosted plan change (#10b)

Source: `src/modules/checkout/` · Routes: `src/api/checkout-routes.ts` · Schema: `db/schema/checkout.ts`
Layer: product surface (customer-facing storefront)

## Purpose
A public, hosted subscribe flow. An operator (or the API) mints a short-lived, **price-scoped**
checkout session; the buyer opens `/checkout/s/<token>` (storefront app), which hands the token to an
`HttpOnly` cookie and redirects to a clean `/checkout`, enters their details (billing address,
and a shipping address when the business's `shipping.address` switch is on), adds a
card, and a subscription is created — all through `/checkout/v1/*` routes that authenticate on THIS
token only. The org API key never reaches the buyer's browser (mirrors the customer-portal trust
boundary). Raw card data never touches us — vaulting goes through the provider adapter (PCI SAQ-A).

**Two modes.** `mode='create'` (default) is the flow above. `mode='change'` targets an **existing**
subscription and, on completion, applies the session's items onto it (plan swap / quantity change /
add-ons — upsert by default, or a full replace with `replace_items_list`) and applies its coupons —
the upgrade/downgrade surface.

Both modes carry a **list of items** plus **coupons**.

## Data model
`checkout_sessions` — org/business FKs, `mode` (`create|change`), `coupon_codes` (jsonb `string[]`),
`subscription_id` (change mode: the target), `public_id` (`cosess_…`), `token_hash` (SHA-256;
`cstk_…` token returned once, never stored), `status` (`open|completing|completed`),
`resulting_customer_id` / `resulting_subscription_id` (captured on completion), `expires_at`,
`revoked_at` (the operator's kill switch — see `revokeCheckoutSession`), `completed_at`. RLS org-isolation like every tenant table.
A CHECK constraint (`checkout_sessions_mode_target_ck`) keeps the pairing honest at the DB level:
`create` ⇒ `subscription_id IS NULL`, `change` ⇒ `subscription_id IS NOT NULL`.

`checkout_session_items` — the item list (0..n): `checkout_session_id`, `price_id` (real FK),
`quantity`, `position` (preserves the operator's order; item 0 is the primary/plan line). Unique on
`(session, price)` — a repeated price is a quantity, not two lines. Written once at mint and never
updated, so the buyer cannot alter what they were sent to buy. A change session may legitimately have
**zero** items (a coupon-only page is valid); a create session must have at least one.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `createCheckoutSession({org,biz,items?/priceId?,quantity?,coupons?,mode?,subscriptionId?,createdBy?})` | Mint → `{publicId, token, url, expiresAt}` (token shown once). Resolves + validates **every price and coupon at mint**; `mode='change'` also validates the target (exists, in this business, not cancelled, currency matches) and **pins its customer** |
| `resolveCheckoutSession(token)` | Base-`db` (cross-org) token resolve + the ordered item list; rejects expired/revoked; completed still resolves for idempotent replay |
| `revokeCheckoutSession({org,biz,sessionPublicId})` | Kill a leaked link: stamps `revoked_at`, after which the resolver refuses the token and **every** `/checkout/v1/*` route answers 401. Idempotent (a second call keeps the original stamp); null when the session isn't this business's. Deliberately allowed on a `completed` session — that ends the `/complete` replay too |
| `getCheckoutView(ctx)` | Business name + **all item lines** (name/amount/quantity/kind) + coupons + status. In change mode also the **current** plan, an `estimateChange` **proration preview**, `hasPaymentMethod`, and `hasUnpreviewedAdditions` |
| `setCheckoutCustomer(ctx,{email,address,taxRegistrationNumber?,shippingAddress?})` | Create a FRESH customer (never reuse by email — public link); a re-post updates that same customer. `shippingAddress` writes the default address-book entry (replaced in place on a re-post; `null` archives it). **Refused in change mode** (the customer is pinned) |
| `completeCheckout(ctx,{paymentMethodToken?,gatewayAccountId?})` | Create mode: vault card → `createSubscription` → apply coupons (`atSignup`) → **bill the first period** (voids + cancels on a declined card). Change mode: optionally vault + make default → apply coupons → `changeSubscription` for swaps/quantities → `addSubscriptionItem` for additions. Marks completed; idempotent replay without re-charging |

### API routes
- `POST /v1/businesses/:biz/checkout_sessions {price?|items?, quantity?, coupons?, mode?, subscription?}` —
  operator mint (org-key auth + idempotency). `price`+`quantity` is single-item sugar for `items`;
  pass one or the other, not both. `mode='change'` requires `subscription` (`sub_…`); `create` rejects
  it. Documented in OpenAPI, so it's in the generated SDK.
- `POST /v1/businesses/:biz/checkout_sessions/:id/revoke` — operator revoke (`requirePerm('ops')`,
  matching the mint: a role that can hand out a payable link must be able to kill one). Idempotent,
  no body, 404 for an id that isn't this business's. **Revoked ≠ spent:** revoked is refused by the
  RESOLVER, so all routes 401; spent (`completed`) is a 409 on the mutating buyer routes only.
- `GET /checkout/v1/session` · `POST /checkout/v1/customer` · `POST /checkout/v1/setup` · `POST /checkout/v1/complete` — buyer surface (`authenticateCheckout` token auth; `/setup` 400s until a customer is set; `/complete` idempotency-keyed, and its `token` is optional in change mode).

## Dependencies
- **Upstream (calls into):** catalog (`getPriceByPublicId`), customers (create/reuse), payment-methods (`vaultPaymentMethod`, vault setup), subscriptions (`createSubscription`), platform/clock (`businessWallClock`).
- **Downstream (called by):** platform/auth (`authenticateCheckout`), storefront `dashboard/app/(storefront)/checkout/[token]/*`, and the operator dashboard "Hosted checkout" card on the product detail page (mints per-price links).

## Invariants & gotchas
- Org API key must never satisfy `/checkout/v1/*`; the checkout token must never satisfy `/v1/*` — distinct resolvers.
- Storefront pages must not import `dashboard/lib/api.ts` (org-key client) — they use `dashboard/lib/checkout-api.ts`.
- The engine owns subscription state; checkout only orchestrates create/change. Money is integer minor units.
- **A change-mode link must never be able to repoint the customer.** The customer is pinned from the
  target subscription at mint time and `setCheckoutCustomer` hard-refuses in change mode — otherwise
  anyone holding the public link could graft the subscription onto a customer they control, or
  overwrite the real customer's name/address.
- A plan change re-points the **existing plan item's** price (never adds a second plan) — that's how
  `changeSubscription` models a swap. The plan item is the one whose price's product is `kind='plan'`.
- **Item semantics default to upsert.** Per requested line: same price already on
  the sub → quantity change; a `plan` line with a different price → swap the existing plan item;
  otherwise → add the item. By default, items the session doesn't mention are **left alone**.
- **`replace_items_list: true` opts into the exhaustive reading**: the
  posted list is the WHOLE subscription and unlisted **non-plan** items are **removed** on completion.
  Needed by any caller whose UI expresses removal by omitting a line — without it a buyer who
  deselects an add-on is shown a successful change and keeps being billed for it. Two guards:
  the **plan is never a removal candidate** (a subscription without a plan is broken, not
  downgraded), and an **empty item list is refused**, because an exhaustive list of
  nothing is far more often a caller that forgot the items than one that means "strip every add-on".
  Removals run **after** the plan swap, so `removeSubscriptionItem`'s mandatory-add-on guard (CAT-3)
  tests the plan the buyer is moving *to*. Removals are priced by their own engine call, so the
  view reports `hasUnpreviewedRemovals` rather than letting the quoted figure imply it covers them.
- **`reset_term: true`** restarts the term at the change date instead
  of prorating into the current one. Note a plan swap or frequency change already forces a reset, so
  this only bites on quantity/add-on-only changes.
- Swaps/quantity changes are sent to `changeSubscription` in **one** call so the engine prorates the
  whole set together (one credit note + one invoice), rather than once per line.
- **Coupons are applied BEFORE items bill**, in both modes: `peekDiscounts` reads the *active* coupons
  when an invoice is raised, so a coupon applied afterwards would miss the very invoice the buyer just
  consented to. Create mode uses `atSignup: true` (folded into `subscription_created`); change
  mode uses the default so `subscription_changed` is emitted.
- `estimateChange` can only simulate changes to items ALREADY on the subscription, so the preview
  excludes newly **added** items. The view sets `hasUnpreviewedAdditions` and the storefront says so —
  never show a total the buyer will be billed past.
- ⚠️ **A discounted subscription currently cannot be changed at all.** `issueCurrentTermCredit` credits
  the LIST price while only the discounted amount was paid, so the engine throws
  `Refundable credit N exceeds refundable paid amount M`. Pre-existing engine bug (reproducible with no
  checkout involved) — see `docs/PROGRESS.md`. Until it's fixed, a change-mode link against a
  coupon-bearing subscription will fail on completion.
- Change mode makes `paymentMethodToken` optional (reuse the vaulted card); **create mode still
  requires it**. Auto-collection is always on, so the view reports `hasPaymentMethod` and the
  storefront asks for a card when there is none.
- Changing to the price the plan is *already* on is a no-op success (a double-submit is harmless).

## Changelog
- **2026-11-05** — `/checkout/v1/setup` takes `consent` (the same answers as `/complete`) and keeps
  it on the session (`setup_consent`, 0494). `completeCheckoutForSetupIntent` runs
  `resolveCheckoutConsent` on it and refuses without it; on success it records the consent as at
  `/setup`. `assertCouponUsableAtCheckout` refuses the business's retention coupon.
- **2026-11-03** — Change mode applies `plan_change_term` when the session did not set
  `reset_term` (stored false is read as unset).
- **2026-11-03** — Change mode follows the business's plan-change rules (`resolveChangePolicy`,
  source `checkout`): a gated change or one the timing rule sends to the term end is refused at
  completion, before any write; the preview and the apply prorate by the direction's rule. The
  page does not warn before confirm yet.
- **2026-11-02** — A one-time purchase above the business card limit answers the buyer as a
  `CheckoutError` (400, `purchaseIntentRefusal`); any other `PaymentIntentError` there is a
  configuration fault and stays a 500.
- **2026-11-02** — **One-page layout and the bot check (Phase 1).** The view carries `layout` and
  `wallets_first`. With `one_page` (create and purchase; plan changes keep their review step) the
  storefront shows the details form and the payment section together: the form saves itself
  (debounced, only when valid and changed) and the payment methods open once the session has a
  customer. Bot check: each refused payment (decline, refused card, unpaid with a failure) counts
  against the client IP (`countEvent`, scope `checkout_payment_failure`, 24 h window in
  `public_rate_limit_counters`, independent of `RATE_LIMIT_ENABLED`). At
  `bot_check_after_failures` or more, `/complete` needs `bot_check_token`, verified by
  `verifyTurnstile` (400 `bot_check_required` / `bot_check_failed`); with no
  `TURNSTILE_SECRET_KEY` the check is skipped, as on sign-up. The storefront shows the widget
  (needs `NEXT_PUBLIC_TURNSTILE_SITE_KEY`) and sends its token on the next try.
- **2026-11-02** — **Consent at checkout, and recommended settings for new businesses (Phase 1).**
  New `storefront_config` keys: `checkout_layout` (`steps|one_page`), `wallets_first`,
  `recurring_consent`, `require_terms` + `terms_url` + `privacy_url` (terms are not required
  until a URL resolves), `marketing_consent`, `bot_check_after_failures`. The resolver defaults
  stay today's behaviour; `initialStorefrontConfig` writes `NEW_BUSINESS_STOREFRONT_CONFIG` only
  for a business a signed-in operator creates (`req.hasOperator`): the org's first key is
  dashboard-kind, and integrations and suites that create businesses with it keep the defaults.
  The view gains `consent { recurring_text, terms_url, privacy_url, terms_required,
  marketing_offered }`; `recurring_text` is the exact sentence ("I agree that <business> charges
  me <taxed recurring total> every <period> until I cancel.", from `projectRecurringPayment`).
  `/complete` takes `consent { recurring, terms, marketing }`, refuses a missing required box
  (400) before any money moves (`resolveCheckoutConsent`), and on success records the text,
  time, terms time and IP on the session and the opt-in on the customer
  (`recordCheckoutConsent`, migration 0479). Known gap: a netbanking mandate completed by the
  setup-intent webhook (buyer gone) records no consent. Gate: `verify:checkout-consent` 18/18.
- **2026-11-02** — **Step tracking for the conversion report (0478).** `checkout_sessions` gains
  `first_viewed_at`, `details_submitted_at`, `payment_attempt_count`, `payment_failure_count`,
  `last_payment_failure`, `layout` (`steps|one_page`) and `device_class` (`mobile|tablet|desktop`).
  `POST /checkout/v1/viewed {layout, device_class}` stamps the first view once (the storefront posts
  it on mount; device class from pointer and width). `/customer` stamps details once. `/complete`
  counts one attempt per non-replayed post: a failure when the result carries `payment_error` or an
  unpaid invoice WITH a recorded failure, when the first charge is declined
  (`CheckoutPaymentRefusedError`, a `CheckoutError` subclass, so still a 400), or when the gateway
  refuses the card (`PaymentMethodVaultError`). A 3DS challenge and a `processing` debit are neither.
  Read by the metrics reports `checkout_conversion` and `checkout_payment_failures`.
  Gate: `verify:checkout-funnel` 31/31.
- **2026-10-31** — **A phone typed before the country is kept.** The details step asks for the
  phone above the country, and `PhoneField` stopped following the country once a number was
  typed, so the dial code stayed empty and the phone posted as "". PayU then refused the setup
  for a missing phone. `dialForCountry` now fills an empty dial code from the country.
- **2026-10-31** — **A signup offers gateways and saves its method in the plan's currency.**
  `resolveSessionCurrency` (the items' price currency) now comes first in `/checkout/v1/gateways`
  and is passed to `beginVaultSetup` as `currency`. A USD plan on an INR-default business was
  offered Cashfree and opened an INR mandate sized from the USD amount. A pinned gateway that
  cannot save in that currency is refused by name with a 400 (`GatewayRouterError`).
- **2026-10-30** — **The mandate ceiling uses the business's headroom.**
  `resolveSessionMandateRequirement` sized with the default multiple and ignored
  `mandate_config.headroom_bps`, so the hosted checkout asked for a different ceiling than
  `deriveMandateCeiling`. It now reads the business config. The storefront payment step shows
  "Authorize UPI Autopay" for UPI on any gateway and the ceiling line for PayU as well as
  RazorPay. A gateway's own rail cap (`gatewayRailCapMinor`, PayU UPI ₹15,000): the gateway
  list leaves the rail out when the debit is above it, `/checkout/v1/setup` refuses it (400),
  and the ceiling asked for and shown is the lower of the two. The payment step says "a payment
  method" unless a card is selected, and the over-cap alert names only rails on the page.
- **2026-10-30** — **The registration pays the first invoice.** On a gateway whose
  `capabilities.setupCollectsFirstCharge` lists the method (PayU cards), `/checkout/v1/setup` in
  create mode passes the projected amount due (`checkoutFirstChargeMinor`) as the setup
  intent's `firstChargeMinor`, before the buyer leaves. The create completion
  (`registrationFirstCharge`) books that registration as the first invoice's payment when the
  intent is consumed into the same payment method and the amount still matches; otherwise the
  usual path runs and the registration is refunded by its delayed setup refund. The buyer and
  the webhook (`completeCheckoutForSetupIntent`) contend on the session claim as before.
  `verify:checkout` (first charge).
- **2026-10-26** — **The setup-intent webhook leaves the checkout to a buyer still on the page.**
  `completeCheckoutForSetupIntent` waits up to 5 s (`BUYER_GRACE_MS`) and skips if the session
  changes meanwhile. With a live webhook, Stripe's `setup_intent.succeeded` won the claim after
  a 3DS card save, so the webhook ran the first charge with nobody to show the challenge to
  (`on_session_intent_failed`: no `return_url`), booked a decline and the buyer's own
  /complete got "Another request is already completing this checkout".
- **2026-10-26** — **The Stripe challenge dialog uses the card the buyer just added.** When the
  402's intent already carries a card and waits for 3DS, `StripeIntentForm` shows one Confirm
  payment button (`confirmCardPayment` with that card, an in-page bank check) instead of an
  empty card form. A failed check falls back to the card form. Applies to the portal's Pay now
  sheet too. Leg 2 still needs our intent `authorized`: on a branch without the gateway read on
  leg 2, a buyer who confirms before the webhook lands is refused until it does.
- **2026-10-26** — **The payment dialog says why leg 2 failed.** A refused leg 2 behind the Stripe
  dialog (purchase, first charge, plan change; same hook) was only a toast in the page corner,
  with the engine's raw sentence, while the dialog stayed unchanged. `usePaymentChallenge` now
  hands the refusal back to `StripeIntentForm`, which shows it in an error `Alert` inside the
  dialog and stays open: "We could not complete your purchase. <reason> Select Confirm payment to
  try again." "Complete the payment step first" / "…the authentication first" are first retried
  4 times (2.5 s steps, as the `?pay=return` leg does), then read "…yet. Your bank may still be
  sending us the approval…". The regex still matches the engine's unchanged text. Field errors and
  card declines stay in Stripe's own element, not in the `Alert`. Storefront only; no engine change.
- **2026-10-26** — **Leg 2 asks the gateway before it refuses.** `completePurchase` ("Complete the
  payment step first.") and the subscription first-charge leg 2 ("…Complete the authentication
  first.") call `authorizeFromGateway` when our intent is not yet `authorized`, so a late or lost
  webhook no longer strands a buyer whose money the gateway holds (Stripe, RazorPay, tmtest). Other
  gateways, and an intent the gateway has not authorized, get the same refusal as before; the
  storefront's retry on those texts stays. Gates: `verify:checkout-purchase` and `verify:checkout`
  "lost webhook" checks.
- **2026-10-22** — **Display-only plans.** A product with `metadata.pricing_page = "display_only"`
  (`isDisplayOnly`) is never sold: `createCheckoutSession` and `createPaymentLink` refuse its
  prices, however the request was made. The public pricing page lists its active prices under
  `display_plans` (name, description, currency, amount_minor, interval, `limit_minor` from the
  price's `metadata.volume_limit_minor`), with no link. Our Free plan uses it; a tenant's own $0
  prices are untouched.
- **2026-10-18** — Buyers see product images: `image_url` on checkout `items`, payment-link
  `offer.lines`, pricing-page cards and portal purchase items (through the invoice line's price).
  The view's `redirect_url` falls back to the product's after-payment page — the plan's, else the
  first line's, http(s) only — when the session or link names none.
- **2026-10-16** — A purchase whose capture the gateway holds for review completes as
  `unpaid_invoice.state: 'processing'` ("Payment in progress"); one left open shows "Payment not
  received", never "Payment received". The storefront retries a payment return up to 4 times
  when the engine answers "Complete the payment step first" / "…the authentication first" — the
  gateway's approval webhook can land ~15 s after the buyer is back. Both texts are matched; do
  not reword them.
- **2026-10-16** — **Payment links, cart, due-today, reminders (E2–E6).** `payment-links.ts` + `payment_links`/`payment_link_items` (0345): a reusable public link; `POST /checkout/v1/links/:plink/open` (per-IP `RATE_LIMIT_PAYMENT_LINK_PER_IP`, 15 min) mints each visitor their own session (`checkout_sessions.payment_link_id`) in `create` if any price recurs, else `purchase`; a flat price may not take a quantity above 1 (it ignores quantity). `GET /checkout/v1/pricing/:biz` is the public pricing page (links with `show_on_pricing_page`). E3: `POST /checkout/v1/items` changes one line within the link's `min_quantity`/`max_quantity`/`optional` (`setCheckoutItemQuantity`); the view's `offer` lists each line's limits. E4: `dueToday` on create-mode views — the first invoice incl. one-time items and tax (`estimateNewSubscription`), or `trial`. E5: `listCustomerPurchases` + `GET /portal/v1/purchases`. E6: `reminders.ts` `sendCheckoutReminders` (billing tick pass `checkout_reminders`): 1 h after the buyer leaves and 24 h after that, opted-in businesses only (`email_config.types.checkout_reminder === true`), a resume token per reminder (`resume_token_hash`, 0346; the newest link works), the session kept open 48 h. Gates: `verify:payment-links` 33/33, `verify:checkout-reminders` 15/15, `verify:checkout-purchase` 35/35.
- **2026-10-16** — **`mode: 'purchase'` (E1): one-time items, a paid invoice, no subscription.** Mint refuses recurring prices, plan products, coupons (no invoice-level coupon path yet) and metadata — the catalogue itself still allows any kind/type pair, because existing clients create them; `customer_id` pins a known customer (`customer_pinned`, 0344 — the page may edit their address, never their email). Completion (`completePurchase`) authorises a payment intent BEFORE any invoice exists — on the saved method when the buyer kept one, else `letBuyerChooseMethod` — then raises the invoice (`createManualInvoice`, tax on) and consumes the intent into it; a failed capture voids it. So an abandoned or declined attempt leaves no invoice, email or dunning behind. `resulting_invoice_id` (0344), `invoice_id` on `/complete`, `resulting_invoice` on retrieve, `purchase` block on the view (`previewInvoiceFromLines` total, tax once the address is known). `storefront_config.one_time_save_payment_method` never|always|ask (default ask). Gate: `verify:checkout-purchase` 32/32.
- **2026-10-16** — `payment_started_at` (0343): stamped once by `markCheckoutPaymentStarted` when the buyer first reaches `/checkout/v1/setup` or `/complete`. With `created_at`, `last_used_at`, `resulting_customer_id` and `completed_at` it gives the `checkout_funnel` report (metrics). Gate: `verify:checkout-funnel`.
- **2026-10-08** — A change session's metadata goes through `applyItemOperations`, so its `subscription_changed` carries it (and a metadata-only change suppresses the coupon summary, keeping one event). Reactivation writes metadata only when it differs and announces it with a `settings_only` `subscription_changed`.
- **2026-10-03** — `StorefrontConfig.portalLinkErrorHtml` (`portal_link_error_html`, ≤5000
  chars): the portal's link-error message, sanitised on read via `emails/sanitize` (new
  checkout → emails dependency). Consumed by customer-portal.
- **2026-10-03** — Hosted checkout no longer enforces Required custom fields (it collects none;
  `skipRequiredCustomFields: true` on its `createCustomer`/`createSubscription`). `getCheckoutView`
  adds `field_config` (the resolved field matrix) and `collect_po_number`; the hosted page now
  hides Hidden fields, requires Required ones and renders a PO number field sent as `po_number`.
  First name, line 1, city, state, postal code and country cannot be hidden on the hosted page
  (`dashboard/lib/checkout-field-rules.ts`): the address completeness rule and the invoice name need them.
- **2026-10-01** — `assertCouponUsableAtCheckout` also refuses a coupon that is not yet valid,
  expired or at its redemption limit (`couponUsableRefusal`, business clock) — at mint and in the
  buyer's coupon box. `getCheckoutView` adds `coupon_refusals` (code → message) for session codes
  still to be applied that completion would refuse, and prices every figure without them; the
  hosted page shows the messages under the coupon chips.
- **2026-09-30** — `assertCouponUsableAtCheckout` takes the page's payer and refuses a coupon they
  have used as often as it allows (`customerLimitRefusal`, shared with the apply). A new-customer
  page has no payer yet and is unchanged.
- **2026-09-24** — **Reactivation through checkout, and the hosted-page return path.** `reactivate`
  lets a change session target a CANCELLED subscription (required for one, refused otherwise); on
  completion the items merge as a change would (`mergeReactivationItems`: a kept line keeps its
  custom rate) and `reactivateAndBill` — the same function the operator reactivate route now
  calls — rebuilds, applies coupons before the invoice, bills the fresh term, and refuses on a
  failed charge per `requireSuccessfulChargeOnReactivation` (cancelled again, session reopened).
  `reactivate_from` backdates the term: past only, not before the cancellation, and cleared by the
  backdating policy's new `reactivate` action. The view quotes the fresh term (`estimateReactivate`)
  and carries `change.reactivation`. Also `replace_coupon_list` (both change flavours; an already
  active code is skipped so a retry does not stack it), `redirect_url` / `cancel_url` (http(s),
  on the view), `pass_thru_content`, and `GET /v1/businesses/:biz/checkout_sessions/:id`.
  Migration 0279. `verify:checkout` 369/369, incl. decline → retry → billed-equals-quoted.
- **2026-09-17** — **A `change` session cannot reach a DELETED subscription, checked at mint AND at
  completion.** Subscriptions became deletable today (soft delete — see `subscriptions/README.md`),
  and a change link outlives the subscription it points at: a session minted before the delete and
  completed after it would have repointed the payment method, moved the items, applied the coupons
  and raised the change invoice against a subscription nothing can see. `completePlanChange` now
  re-reads the target through `notDeleted()` and refuses with "This subscription no longer exists"
  before any write; the mint and the change PREVIEW filter the same way. Covered by two checks in
  `verify:subscription-delete`, the completion one asserting the exact message — a bare "it threw"
  would have passed on an unrelated refusal, and the mutation run proved that: with the guard
  disabled the flow ran on past it into item resolution.
- **2026-09-09** — **Buyer-surface preferences (0243, `storefront_config`).** New pure resolver
  `storefront-config.ts` (`resolveStorefrontConfig`, modelled on `resolveCreditsFlexibility` /
  `resolveInvoiceCustomization`) reads `businesses.storefront_config`, four independent switches, all
  defaulting to today's behaviour.
  - **`hide_zero_value_lines`** — `getCheckoutView` now drops a line item whose FINAL amount (the
    same figure `priceAmountSummary` renders, differential-resolved) is a real `0n`; `null`
    (usage/tiered, no single rate) is never treated as zero. The portal's twin filters
    `GET /portal/v1/subscriptions` in `customer-portal-routes.ts` the same way. Deliberately separate
    from the printed-document flag in `invoice_customization` — see the resolver's docblock.
  - **`collect_po_number`** — `checkoutCompleteBody` grew an optional `po_number` (same shape/limit
    as `subscription-routes.ts`'s), reaching `subscriptions.po_number`: straight into
    `createSubscription` on create mode, a direct `UPDATE` alongside the payment-method repoint on
    change mode (`completePlanChange`). **Does NOT reach the resulting invoice** — no code path
    copies a subscription's `po_number` onto the invoice it raises (verified: `invoicing/service.ts`
    never touches that column when building one), and wiring it would mean either editing the
    invoicing module or hooking a post-commit write into `completeCheckout`'s multi-branch
    charge/decline control flow — not attempted without integration coverage. Flagged for a follow-up
    rather than reached across blind.
  - **`default_return_url` / `default_cancel_url`** — `POST /checkout/v1/setup`'s `return_url` /
    `cancel_url` are now OPTIONAL (were required on every call). New pure
    `resolveCheckoutRedirect(config, explicit)` is the single choke point deciding the pair: the
    call's own value always wins, the config fills a gap, and **either leg missing everywhere returns
    `null`**, which the route turns into a 400 — an add-card flow must never begin with nowhere to
    send the buyer back. `/checkout/v1/complete`'s identically-named pair is untouched: already
    optional, with a documented (and acceptable) "no `experience_context`" fallback.
  - URLs are sanitised harder than the write-time schema: `storefront_config` on `updateBusinessBody`
    validates with plain `.url()`, not the scheme-restricted `httpUrl()` (src/api/limits.ts) the rest
    of the API uses for stored redirect targets — so the resolver itself rejects anything but
    http/https, catching a `javascript:`/`data:` URL regardless of what got written.
- **2026-09-08** — **The buyer can enter a coupon code (0238).** `checkout_sessions.coupon_codes`
  has been first-class since 0125, but only the merchant could set it: `coupon_ids[…]` is resolved
  AT MINT and the column was never written again. Two new session-token routes —
  `POST /checkout/v1/coupon` and `DELETE /checkout/v1/coupon` — make it editable by the person
  actually paying.
  - **Nothing downstream changed.** `getCheckoutView` already prices the estimate from these codes
    and `completeCheckout` already applies them, so there is no second application path to keep in
    step. That is the whole reason this was small.
  - The mint-time check moved out into `assertCouponUsableAtCheckout`, so a code a merchant could
    not have attached is refused with the same words when a buyer types it. It stays READ-ONLY:
    `findCouponByCode` never claims a single-use coupon-set code, and claiming one on a page the
    buyer may abandon would burn it. Validity, redemption cap and item constraints are still
    enforced at completion — the page must not promise a discount it will not honour.
  - Gated on `businesses.allow_customer_coupons`, **off by default**, read per request rather than
    carried on the context: the setting can be switched off while a page is open, and the answer
    that matters is the one at the moment of the write. 403, not 404 — the route exists.
  - Idempotent by construction (re-adding a code is a no-op, so is removing an absent one), which
    is why these two carry no `Idempotency-Key`: a key would make the buyer's second, deliberate
    attempt after fixing a typo replay the first one's failure.
  - Both answer with the **re-priced view**, so the page shows the new total from one round trip.
    The UI still `router.refresh()`es rather than rendering that payload directly — a discount moves
    the recurring total and the change preview, and chips patched locally beside figures from the
    previous render is the parity-that-lies failure.
- **2026-08-31** — **the change-review card quoted prices nobody is paying.** Both the removed
  rows and the current-plan row read the CATALOG; the credit printed beneath them comes from
  invoice lines that rated from `subscription_items.price_snapshot`. Two numbers, two sources, one
  card that could not be made to add up.
  * **The ₹0.00 row.** `removedItems` called `priceAmountSummary(price)` with no effective amount,
    so a differential add-on read its catalog column — `amount_minor = 0` (CAT-7) — and rendered
    **₹0.00 / month** struck through, while the totals block quoted **₹88,664.44** "Credit for
    unused time": a credit 2.7× the whole displayed plan price, beside a line claiming the item was
    free. The sibling call for the items list already resolved the rate; this mapping was added
    later and was left behind.
  * **The real source is the snapshot, not the differential.** Resolving the live differential
    cleared the ₹0.00 but still quoted the catalog — the price that by construction does NOT rate a
    live subscription (`updatePrice`: "Edits apply to NEW subscriptions only"). Removed rows now
    render from the item's frozen `price_snapshot`, with the differential kept only as a fallback
    for an item that has none. The same trap sat one row up on `currentPlan`: a plan is never
    differential so it never showed ₹0, but any grandfathered subscription was quoted today's list
    price — now it renders its snapshot too.
  * **The whole snapshot is rendered, not just its amount.** `alignSnapshotToCycle` may have
    re-expressed an item on the *subscription's* cadence (a ₹475/month add-on on a yearly plan is
    stored as ₹5,700 / year), so taking the amount from the snapshot and the interval from the
    catalog row would have printed ₹5,700 / month — a 12× lie replacing the ₹0.00 one.
    `priceAmountSummary` and the new `snapshotAmountSummary` now share one `amountSummary`
    renderer, and snapshots are keyed by ITEM, not price: the mandatory-item index permits a manual
    item at the same price, so a price-keyed map could hand one item's frozen rate to the other.
  * **The differential fallback resolves against the OUTGOING plan.** Not the `planProductId` used
    for the items list, which deliberately prefers the session's new plan line because an item being
    **added** is priced against the plan the subscription will have after the change. A removal is
    credited at the rate it was billed at.
  * 8 new checks in `verify:checkout` (347 total): a plan swap that also drops a differential
    add-on, with the two plans given different differential rates, then both catalog figures moved
    after the subscription exists. All four mutations were run — dropping the effective amount
    reproduces `$0.00 / month`; resolving against the incoming plan quotes `$9,999.00` where
    `$3,760.00` was billed; ignoring either snapshot quotes the repriced catalog — each fails the
    checks that cover it.
- **2026-08-30** — **the checkout's details step overwrote billing details it never showed.**
  `getCheckoutView` now returns a `customer` block (address, tax registration number, and — create
  mode only — email), so the storefront's "Your details" form can prefill instead of rendering blank.
  * **This is a data-loss fix, not a convenience.** `POST /checkout/v1/customer` REPLACES the
    address (`applyAddress` sets every column to `?? null`, as `setCheckoutCustomer`'s own note
    says), and the form is reachable a second time through the card step's **"Edit billing
    details"** — the path a buyer takes precisely when a gateway has just refused them. Rendered
    blank, a buyer who filled only the required fields silently nulled company, address lines 2/3,
    state, last name and `tax_registration_number` on the real customer row. For an Indian B2B buyer
    that is their GSTIN gone, and every later invoice loses the input tax credit the field's own
    help text promises. It hit both modes: change mode (customer pinned, real data) and create mode
    (the round-trip re-posts and updates the customer this session already minted).
  * The frontend could not have fixed itself — `CheckoutView` carried no customer at all. The
    portal's equivalent form has always prefilled (`billing-details.tsx` passes
    `me.customer.address`); this surface was ported from it without the data, the same way the
    commit bar and the rail chooser were ported without theirs.
  * **SECURITY — a deliberate, narrow widening of a PUBLIC link.** Always the session's own
    `resulting_customer_id`, never a lookup, so no enumeration and no echo of a stranger's record —
    the two properties `setCheckoutCustomer`'s note protects. The link already has WRITE access to
    exactly this row (that is what `updateCheckoutCustomerDetails` exists for: a buyer mid-change
    has to supply the phone number RazorPay will not vault a card without), and a form that can
    overwrite what it cannot show is the bug. `email` is create-mode only: a change link's customer
    predates it and its email is pinned and uneditable, so the field is not rendered and not sent.
    Residual, stated plainly: a leaked change link now discloses the buyer's billing address, phone
    and tax registration number, where before it disclosed the plan only —
    `POST /v1/businesses/:biz/checkout_sessions/:id/revoke` is the lever.
  * Reuses the `billingAddress` serializer (now exported) rather than a second hand-rolled mapping,
    so what the view emits cannot drift from the `address` body this very form posts back.
  * 6 new checks in `verify:checkout` (297 total): absent before the session has a customer;
    create mode prefills the address AND the email; change mode prefills the address and the tax
    number; change mode does **not** put the pinned email on the wire.

- **2026-08-30** — **`/checkout/v1/complete` can say where a redirect challenge returns the buyer
  (F-45).** `chargeBeforeSubscriptionInvoice` had taken `returnUrl`/`cancelUrl` since the on-session
  intent was added and `completeCheckout` passed neither, so a first charge that came back
  `requires_action` in REDIRECT mode minted a PayPal order with no `experience_context`: the buyer
  approved the payment and PayPal had nowhere to send them. The same dead end the netbanking
  e-mandate rail documents, except that one is a measured provider defect and this was a field we
  never sent.
  * `return_url` / `cancel_url` on `checkoutCompleteBody`, **optional** (unlike `/setup`, where they
    are required). Most completions that reach this route can never redirect anywhere — a change-mode
    confirm on a card already on file, a Stripe `client_secret` challenge, a RazorPay sheet, the
    replay POST with an empty body — and requiring a URL from all of them to fix one arm would turn a
    sale into a 400. Omitted = exactly today's behaviour.
  * They reach ONE place: the `chargeBeforeSubscriptionInvoice` call on the create path. The consume
    path is settling an authorization the buyer already completed, and the **replay path answers from
    the stored result before the CAS claim**, so neither reads them — asserted, because the hosted
    page's return leg re-posts `/complete` and a reload re-posts it against a `completed` session.
  * The hosted page's redirect arm is now an ORDINARY SAME-TAB REDIRECT to `?pay=return`, the
    charge-side twin of `?setup=return`. It used to open a new tab and hold this one, because there
    was no way back; the two are mutually exclusive, since a `return_url` plus a new tab returns the
    buyer into the SECOND tab onto an empty checkout that invites them to pay twice. The new-tab panel
    survives only as the fallback for a browser whose sessionStorage cannot carry the stash — decided
    before leg 1 posts, where no `return_url` is sent either.
  * `awaitingMandate` (RazorPay netbanking e-mandate, a vault SETUP whose `auth_links` ignores
    `callback_url`) is a DIFFERENT code path and is untouched. It must stay that way.
  * 7 new checks in `verify:checkout` (291 total). The pair is asserted at the ADAPTER boundary —
    it is handed to `createIntent` and never persisted, so no row or response can witness it — driven
    by a real `requires_action` charge (tmtest `4000000000003155`), with a no-pair control, URL
    validation, and the replay contract.
- **2026-08-28** — **`revoked_at` got its writer: `POST /v1/businesses/:biz/checkout_sessions/:id/revoke`.**
  The column had been on the table, and honoured by `resolveCheckoutSession`, with nothing in the
  product ever setting it. That is two problems in one: an operator whose checkout link had leaked had
  no lever at all, and a guard no code path exercises is a guard nobody would notice breaking. A
  checkout link is PUBLIC by construction — minted, mailed, forwarded, then sitting in an inbox for
  the rest of `CHECKOUT_SESSION_TTL_HOURS` — so waiting the TTL out was the only remedy on offer.
  * `requirePerm('ops')`, matching the MINT rather than something stricter: `ops` can hand out a link
    that takes a buyer's money, so `ops` must be able to kill one, and revocation is the fail-SAFE
    direction (the same reasoning `POST /v1/api_keys/:id/revoke` records for carrying no step-up).
  * **Revoked is not spent.** Revocation is upstream of the `isSpent` gate: the resolver returns null,
    so `authenticateCheckout` never authenticates the request and EVERY route — the readable
    `/session` and `/invoice` included — answers 401. `isSpent` only 409s the mutating routes on a
    `completed` session. Revoking a completed session is therefore allowed on purpose, and is the most
    valuable case: it ends the idempotent `/complete` replay that a leaked spent link still retained.
  * Idempotent like `revokeApiKey` — a second revoke reports the ORIGINAL `revoked_at` rather than
    moving the moment the link died — and it leaves `status` alone, because the lifecycle and the kill
    switch are orthogonal.
  * **26 new checks in `verify:checkout` (240 → 266)**, in the two halves the portal's equivalent uses
    (`verify-customer-portal.ts`): a token ALREADY IN FLIGHT stops working, and a link NEVER OPENED
    cannot be entered at all (checkout is single-token, so those are the halves rather than two
    credentials). Each with its positive control — a sibling link minted alongside stays alive, and
    the rightful operator can still revoke after four authorization refusals — plus cross-business,
    cross-tenant, unknown-id, the one-row-only DB check, and the 200→401 / 409→401 / 201→401 flips on
    a completed link. Mutation-tested twice: blinding the resolver to `revoked_at` fails 7 of them,
    and stopping the writer from writing it fails 9.
- **2026-08-28** — **A REPLAYED completion no longer reports a plain success over an unpaid invoice.**
  `completeCheckout`'s already-completed branch returned the subscription and customer ids and nothing
  else, so a second POST reported success even when the first had left an invoice uncollected. A
  second POST is ordinary — the redirect leg's own "Try again" is exactly that — so re-posting turned
  "your plan changed, payment outstanding" into a green "You're all set" over an open invoice: the
  same misreport `unpaidInvoice` was added to end, reached through a second door.
  Bounded by `completed_at`, which is what makes it precise rather than a guess: the invoice this
  checkout raised was created DURING the completion, so it is the newest open one at or before that
  stamp, and a renewal raised days later is correctly ignored. A session with no `completed_at` reports
  nothing rather than guessing. The state is read LIVE rather than remembered, so a buyer who has since
  paid gets the success they earned and one whose async debit has since failed gets the real reason —
  strictly better than the fresh path's snapshot. Mutation-tested in `verify:checkout`.
- **2026-08-28b** — **The checkout could not tell a buyer what they would pay.** Two holes, one symptom.
  (1) The change preview ran `estimateChange` with `changes` only and was gated on `changes.length > 0`
  — from when the estimator could simulate nothing else. It grew `adds`/`removes` for the dashboard's
  composition editor and this caller was left behind, so an **add-on-only change produced no preview at
  all**: no subtotal, no tax, no amount due, just catalog per-month prices and a Confirm button. A swap
  that also added an item quoted a total that excluded the addition, under a footnote admitting it.
  `getCheckoutView` now prices the whole operation, and `hasUnpreviewedAdditions` /
  `hasUnpreviewedRemovals` (and the footnote they fed) are gone — nothing is unpreviewed any more.
  (2) There was no per-period total on either mode. The page said one could not be computed from the
  pre-formatted `item.amount` strings, which was true — but the figure was already being computed a
  function below, by `resolveSessionMandateRequirement`, and discarded. New `projectRecurringPayment`
  returns it as `nextPayment` (subtotal, tax, `taxLines`, total, amount due, `excludesUsage`), rendered
  as the same "includes CGST (9.00%)" strip the portal's plan card ends with. It differs from the
  mandate sizer on two points, both deliberate: **coupons are priced in** (a quote must equal the
  charge; a ceiling must outlive the coupon) and **only recurring lines count** (a one-time fee is
  collected once, by the immediate invoice). Null rather than zero whenever it cannot be stated
  honestly — no customer yet, no recurring line, an estimator refusal. It also reports
  `includesExistingItems`, because the projection covers the whole subscription while the page lists
  only the lines the session touches — unsaid, the difference is an unexplained amount on a screen
  asking for money. `verify:checkout` 196/196
  (its two "flags unpreviewed…" assertions replaced by ones asserting the quote now exists and carries
  the addition's charge / the removal's credit); `verify:estimates` PASS.
- **2026-08-28** — **A payment still in flight is no longer reported as a refusal.** `completePlanChange`
  decided the buyer's outcome from "is there an open invoice with money due", which is the same shape
  three different things leave behind. An async debit — UPI Autopay, an e-mandate presentation, ACH —
  is answered `created` by the gateway and settles by webhook seconds to days later; `collectInvoice`
  books it as an `in_progress` transaction and deliberately leaves the invoice open while it waits. The
  buyer was told **"We could not collect INR 15,528.80"**, with no reason attached because no failure
  had been recorded — for money that was moving, and often seconds before it arrived. `unpaidInvoice`
  now carries `state`, derived in `collectionOutcomeFor` from the invoice's **newest** payment
  transaction (newest, so an invoice that failed and is now mid-retry cannot read as failed and
  in-flight at once): `processing` for the unsettled statuses, `outstanding` with a failure for a real
  refusal, `outstanding` without one when nothing was ever attempted (auto-collection off, no
  instrument) — which is not "we could not collect" either. New `GET /checkout/v1/invoice` re-reads
  that state, scoped to the session's own customer so a public link cannot read a stranger's invoice;
  the done screen polls it for ~20s before saying anything, and most of these settle inside that
  window. `pnpm verify:checkout` covers the processing arm end-to-end (in-flight → poll → paid), the
  ownership refusal, and keeps the mandate-ceiling refusal as the `outstanding` control.
- **2026-08-21** — **A change checkout can now REMOVE what the buyer took off.** `mode='change'` was
  upsert-only, so a buyer who deselected a destination add-on posted a list that merely omitted it —
  the line stayed on the subscription and kept billing, behind a page that said the change succeeded.
  Removal cannot be inferred from an item list, so it is now an explicit opt-in:
  `replace_items_list` declares the list exhaustive and removes unlisted **non-plan**
  items, and `reset_term` restarts the term at the change date. Both live on the session, not the
  completion call, so the buyer-facing preview and the completion are computed from the same input —
  a page that quotes one figure and charges another is the failure this avoids. The plan is never a
  removal candidate and an empty exhaustive list is refused (see § Item semantics for why).
  Migration `0182`.
  `pnpm verify:checkout` (111 assertions) covers removal, plan survival, both refusals,
  and keeps the pre-existing upsert-by-default arm as the control.
- **2026-08-10** — **A checkout is on-session by construction, so 3DS no longer kills the signup.**
  `completeCheckout` charges the first period with `session: 'on_session'` (the buyer is on the page
  that made the request — no flag, nothing inferred). A `requires_action` now throws
  `CheckoutActionRequiredError` carrying a real payment intent: the provisional subscription is
  discarded and the session claim released exactly as for a decline, and `POST /checkout/v1/complete`
  answers **402** with `payment_intent` + `next_action`. The buyer completes the challenge and re-posts
  `/complete` with `payment_intent`, which commits the first invoice (`collect: false`) and CONSUMES
  the intent into it rather than charging the card a second time. `POST /checkout/v1/setup` also
  records the add-card as a zero-amount `setup` intent where that changes nothing about the gateway
  call (`src/api/vault-setup.ts`) — same response fields, plus `payment_intent`/`next_action`.
- **2026-07-30 (fix 2)** — Hosted checkout also had no `mode: 'checkout'` branch, so a RazorPay
  business's buyers were shown the tmtest token box instead of the mandate modal. `CardStep` now
  opens RazorPay's embedded Checkout (shared `lib/razorpay-checkout.ts`) and completes with the
  payment id it returns; `POST /checkout/v1/setup` asks for the card rail explicitly.
- **2026-07-30 (fix)** — Hosted checkout had the same dead end as the portal: a redirect-mode vault
  setup (PayPal approval) sent the buyer off-site and `?setup=return` did nothing, so the checkout
  could never be completed with a wallet. `checkout-flow.tsx` now stashes the pending setup before
  the hop out and, on return, completes with the approved token (`Finishing setup…` state → done
  step, or an error toast back to the card step). `POST /checkout/v1/complete` answers 400 (not 500)
  when the gateway refuses the token (`PaymentMethodVaultError`).
- **2026-07-28** — **A declined first charge now leaves NOTHING** (Bugs #5).
  `completeCheckout`'s `mode: 'create'` path stopped compensating after the fact. It was
  `createSubscription` → `applyCouponToSubscription` → `billSubscriptionPeriod` → on a failed payment
  `voidInvoice` + `cancelSubscription` + throw, which left a `cancelled` subscription, a `voided` invoice
  and a full phantom webhook trail led by `subscription_created` — so an integration that provisions on
  that event provisioned for a signup that never happened. It now mirrors the operator create route
  (`src/api/subscription-routes.ts`): lifecycle events are buffered via `deferEventsTo`, the first invoice
  is **planned read-only** (`planSubscriptionPeriodInvoice`), the planned amount is charged
  (`chargeBeforeSubscriptionInvoice`), and only then is anything persisted
  (`commitSubscriptionPeriodInvoice(plan, { preEvents, charge })`). A decline deletes the provisional row
  (`deleteProvisionalSubscription`), discards the buffer and throws a `CheckoutError` carrying the
  gateway's reason; a `ChargeAmountMismatchError` refunds first, then does the same.
  Checkout-specific details: (1) the charge-first path is gated on
  `isAutoCollectOn(subscription.autoCollection, customer.autoCollection)` — a send-invoice buyer is
  invoiced and never charged, and a decline can therefore never delete a subscription that should exist
  with an unpaid invoice; (2) every refusal throws from inside the existing try, so the "release the
  claim" catch returns the session to `open` and the buyer retries the same link — the session is never
  marked `completed` on a refusal; (3) the provisional row is deleted *before* the buffer is dropped, so
  a subscription that outlives a failed delete is still announced by the catch's flush. `mode: 'change'`
  is untouched. Covered by `verify:checkout` (100 passed / 0 failed).
- **2026-07-27** — **Multi-item + coupon checkout, and the first period is now actually BILLED.**
  Migration `0125_checkout_items_and_coupons.sql`: new `checkout_session_items` child table (real price
  FKs + `position`), `coupon_codes` on the session, and the single-item `price_id`/`quantity` columns
  dropped after migrating existing rows into the child table. Mint accepts `items[]` + `coupons[]`
  (with `price`/`quantity` kept as sugar — that's what the dashboard's per-price link sends), and
  validates **every price and coupon at mint**: many items + many coupons, coupon-only change pages,
  and addon-only item lists are all accepted; bogus prices/coupons 404 at mint.
  New `findCouponByCode` in the coupons
  module (read-only: `applyCouponToSubscription` *claims* single-use set codes, so it can't pre-validate).
  🐞 **Fixed a revenue bug:** completing a checkout previously created an `active` subscription with
  **no invoice and no charge** — the buyer got the product free until the next renewal tick. Create mode
  now bills the first period like the operator route, and refuses the signup when that first charge
  declines. `verify:checkout` 52 → **86**.
  **Correction (2026-07-28):** the refusal was described here as void-the-invoice +
  cancel-the-subscription. That compensating behaviour was itself a defect — a declined signup must
  leave *no* subscription, *no* invoice and *no* events — fixed by the entry above.
- **2026-07-27** — **Hosted checkout for an EXISTING subscription (#10b).** New `mode` (`create|change`)
  + `subscription_id` on `checkout_sessions` (migration `0124_checkout_change_mode.sql`, additive with a
  CHECK on the pairing; existing rows default to `create`). Change mode validates the target at mint
  (exists / in-business / not cancelled / currency matches), **pins the customer** and refuses
  `setCheckoutCustomer`, exposes an `estimateChange` proration preview + `hasPaymentMethod` on the view,
  makes the card token optional when one is vaulted, and completes by calling `changeSubscription` on the
  plan item — so the existing subscription is CHANGED, never duplicated. Storefront renders current→new
  plan with the preview and a Confirm step (no details step). Operator mint route added to OpenAPI (it was
  the only route missing) → SDK regenerated. `verify:checkout` 23 → **52**.
  **Why:** a migrated upgrade/downgrade path needs a hosted page that changes an EXISTING
  subscription, which had no tmbilling equivalent — the adapter was
  mapping it to a new-subscription checkout, which would have created a SECOND subscription
  (double-billing) instead of upgrading. Known gap: multi-item sessions (plan + add-ons in one
  checkout) are not supported — add-ons are managed through the items API.
- **2026-07-22** — Initial build (#10d). Schema + migration `0122_checkout_sessions.sql` (RLS + GRANT),
  service, `/checkout/v1/*` routes, `authenticateCheckout`, storefront flow. Verify: `verify:checkout`.
  **Security hardening (post-review, same day):** (1) `completeCheckout` now claims the session
  atomically (`open`→`completing` compare-and-set) before any charge, so concurrent `/complete` calls
  can't double-subscribe (reverts to `open` on failure so the buyer can retry); (2) the shared
  `idempotency` middleware now resolves the tenant from the portal/checkout session (previously read
  `req.organization`, which buyer-token routes never set — it 500'd on a key and no-op'd without one);
  (3) `setCheckoutCustomer` never reuses a customer by email on this public link (was an enumeration /
  PII-echo / account-graft vector) — always creates a fresh customer.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-21** — `completeCheckout` accepts `paymentMethodId`: an instrument the ROUTE already
  vaulted by consuming the setup intent the checkout began (`api/vault-setup.completeVaultFromIntent`),
  taking precedence over `paymentMethodToken` and satisfying create mode's "an instrument is required"
  rule without one. Why the route does it that way: the gateway's own webhook harvests that same setup
  intent for the buyer who approves and never comes back, and only going through the intent's atomic
  `authorized -> consumed` claim keeps the two from each vaulting the instrument — measured
  2026-08-21 on the portal's equivalent path, both wrote and one UPI mandate became two payment
  methods 15s apart. The service does not re-vault what it is handed.
- **2026-08-24** — `CheckoutChangePreview` now carries **`dueAtTrialEnd`** (from `estimateChange`'s
  `due_at_trial_end`), because `immediateCharge: false` is ambiguous: it is a CREDIT on a downgrade and
  a DEFERRED CHARGE inside a trial. The storefront had only the flag, so it read the trial case as the
  credit case and told a trialing buyer upgrading LITE → PRO *"Credited to your balance ₹28,215.00"* —
  the new plan's full price, presented as money received. The engine was right throughout
  (`amount_due_minor: 0`, no invoice, empty balance); only the page lied. Found by driving the real
  buyer page over CDP on an India path, not by review — the preview's own numbers look correct in
  isolation, and it is the pairing of a positive `totalMinor` with `immediateCharge: false` that is only
  legible as a bug once something has to render it. `verify:checkout` (125) now pins the whole shape:
  the flag, the zero due now, a POSITIVE total, and that completing keeps the trial and raises no
  invoice. Mutation-checked — dropping the field fails exactly one assertion.

- **2026-08-26 (security, W1)** — **The checkout session token is no longer in the URL.** The minted
  link is now `/checkout/s/<token>`: an exchange route that moves the token into an `HttpOnly` cookie
  and 307s to a clean `/checkout`. This surface is where it mattered most — the card step injects a
  gateway SDK from a third-party host, so with the token in the path it went to that host as a
  `Referer` on the very request that loads the payment form (CWE-598).
  The token no longer reaches the browser: the actions under
  `dashboard/app/(storefront)/checkout/(session)/` read the cookie themselves. `GET
  /checkout/v1/session` now also returns `id` — the session's PUBLIC id — so the storefront has a
  non-secret key for its per-tab redirect stash, which used to be keyed on the token itself. Full
  reasoning, and the residual this does NOT fix, are in `dashboard/lib/storefront-session.ts`.

- **2026-08-27** — a checkout session can carry **`metadata`**, written onto the resulting
  subscription on completion. Valid in both modes. Fourth
  member of the deferred-intent set alongside `coupon_codes`, `replace_items_list` and `reset_term`,
  and it exists because a change whose ITEMS and whose FLAG are one decision cannot be sent as two
  calls: a tmbilling plan change commits asynchronously (hosted page, buyer authenticates past the
  RBI ₹15,000 AFA ceiling), so writing the flag first serves something nobody paid for and writing
  it after is a second thing that can fail on its own. `completePlanChange` applies it LAST — after
  the coupon, the item operations and the proration invoice have all succeeded — so an abandoned
  page or a refused charge writes nothing. Create-mode passes it straight to `createSubscription`,
  where the provisional-subscription cleanup already covers a failed signup. NULL ≠ `{}` end to end:
  absent means "no opinion", `{}` means "clear it", and collapsing them would make every checkout
  wipe its subscription's metadata. Migration `0199`.

- **2026-08-27** — **a change checkout now sizes the mandate for the plan it is selling**, and refuses
  to let the buyer confirm a change their bank would decline. New
  `resolveSessionMandateRequirement(ctx)`, shared by the change VIEW (which gates the confirm step on
  it) and `POST /checkout/v1/setup` (which registers with it) — one number, or the page would
  recommend a ceiling different from the one the gateway is asked for.
  * **The defect.** The ceiling came from `deriveMandateCeiling`, which reads the customer's CURRENT
    subscriptions. On a change checkout that is the plan the buyer is LEAVING: a ₹10,799 → ₹56,118
    upgrade registered a ₹15,000 mandate, the proration invoice was refused with
    `mandate_ceiling_exceeded`, and "Use a different card" — the only remedy offered — re-registered
    it just as small. The change had already been applied by then, so the buyer was on the expensive
    plan with an unpayable invoice and nothing on screen said so.
  * **Two debits, one mandate.** The ceiling covers the larger of what is collected NOW (the
    proration, or the first invoice for a signup) and every RENEWAL after it, projected over the
    post-change composition. The renewal usually wins: on the upgrade above, today's proration is
    ₹51,844.74 after the unused-time credit while every month after it is ₹66,219.24.
  * **`projectedComposition` is not `ctx.items`.** Without `replace_items_list` a change session names
    only the items the buyer is TOUCHING — an untouched add-on stays attached and keeps billing, so
    sizing from the session's items alone would miss it. The keep/replace rules mirror
    `planItemOperations` exactly, because the composition this predicts is the one that call books.
  * **Sized on the STICKER composition** — `estimateNewSubscription` is called with no coupon codes. A
    coupon is temporary and the mandate has to outlive it: a 30%-off code expiring would take the
    renewal past a ceiling sized under it, and a 100%-off first month would size the mandate at zero.
  * **Re-registration, not "update".** No rail lets a ceiling be raised (RazorPay exposes no route),
    so the only mechanism is a fresh authorisation. When the instrument on file cannot carry the
    change, the card step joins the step rail and "Confirm change" is not rendered at all; the old
    instrument is NOT removed, because a smaller mandate is still a valid backup for smaller invoices
    (`isHardDecline` already relies on that). `collect_on_payment_method_update` (default on) settles
    whatever was parked once the new one lands.
  * **Gated on data, never on country.** The view carries `mandate` only when a ceiling could be
    sized, each element carries its own honest condition (the "you'll approve up to X" line requires
    the RazorPay rail — telling a Stripe cardholder they are approving automatic payments would
    describe an authorisation their card does not have), and the refusal test is `mandateRefusal`
    itself, so a null ceiling or a currency mismatch skips exactly as it does at debit time.
  * The card step's AFA advice now reads `mandate.largestDebitMinor` in preference to the gateway
    list's `expected_debit_minor`, which reads existing subscriptions and so was advising about the
    plan being left behind — two contradictory figures on one screen.
  * 14 new checks in `verify:checkout` (139 total), covering no-mandate, too-small, sufficient,
    foreign-currency, and the view's own gate.
  * **Completion now reports what it could not collect.** `CheckoutResult.unpaidInvoice`
    (`unpaid_invoice` on the wire) — id, amount due, currency, and the recorded failure — set when
    the change applied but its invoice is still open. Read from the newest OPEN invoice raised for
    that subscription since an instant captured just before billing (so an older unpaid invoice is
    never blamed on this change) plus the latest `transactions` row with `status='failed'`, which is
    where a `mandate_ceiling_exceeded` pre-flight refusal is recorded too. Reported alongside success
    rather than raised, because the plan really did change — the storefront now shows "Your plan
    changed — payment is still outstanding" with the amount and the invoice id, and the toast follows
    the outcome instead of always saying "Plan updated". The signup path's existing `payment_error`
    was on the wire but dropped by the storefront for the same reason; it is now typed and carried.
  * **`GET /checkout/v1/gateways` now carries the sizing**, so the CARD step can state the ceiling
    before RazorPay's own sheet does: `required_mandate_ceiling_minor`, `rails_over_cap` and
    `debit_currency` join `expected_debit_minor` — which is itself now sized from the SESSION rather
    than from the customer's existing subscriptions. That fixes both surfaces at once: a change
    checkout was advising about the plan being left behind, and a SIGNUP had no subscriptions at all,
    so the figure was 0 and a ₹56,118 buyer was told nothing about a rail that stops and asks on every
    debit above ₹15,000. The card step reads these rather than `view.change.mandate`, deliberately: the
    view is server-rendered on page load, when a create-mode session has no customer yet, so a signup
    buyer would always have seen null. `debit_currency` replaces the storefront's inference that a
    non-null AFA limit meant INR.
  * **2026-08-27 (bug) — a netbanking e-mandate threw the buyer's checkout away.** RazorPay's
    `subscription_registration/auth_links` ignores `callback_url` (measured three times 2026-08-14 and
    documented on `createEmandateAuthLink`), so the buyer ends on RazorPay's own "MANDATE REGISTRATION
    COMPLETED" screen and is never sent back. Both buyer surfaces were navigating THE SAME TAB to that
    link, so on this one rail the tab never came back: the mandate registered, `harvestSetupIntent`
    vaulted the instrument from the webhook — and on the CHECKOUT, `/checkout/v1/complete` was never
    posted, so the buyer authorised an auto-debit and received no subscription while the session sat
    open until it expired. (On the portal the webhook alone finishes the job, so only the portal itself
    was lost.)
    * Fix: for that rail only (`razorpay` + `bank_transfer`), the authorization opens in a NEW tab and
      ours holds the setup intent. Both surfaces render a waiting panel; the checkout's carries
      "I've authorised — continue", which completes through the intent — whose atomic claim already
      makes the buyer and the webhook harvest contend for one instrument, so pressing it after the
      webhook has landed is a no-op on the vault and simply finishes the checkout.
    * The panel always renders the URL as a **`target=_blank` anchor**, and `window.open` is only an
      optimisation on top. A blocked popup is therefore a non-event: falling back to navigating this
      tab (the first version of this fix) would have recreated the dead end. `window.open` is still
      called synchronously inside the click, because a popup blocker judges by the user gesture and
      the gesture is gone once the server action resolves.
    * Verified over CDP with trusted input events (a scripted `.click()` is not a user gesture, so it
      blocks the popup and hid the real behaviour once): our tab stays on `/checkout`, the RazorPay
      link opens beside it, no console errors.
    * ⚠️ STILL OPEN: nothing completes the checkout server-side. A buyer who authorises and never
      returns leaves a vaulted mandate and no subscription. The fix is to store the setup intent on
      `checkout_sessions` and complete from the harvest — see PROGRESS.
  * **2026-08-27 (three buyer-facing corrections, all reported from a real INR test run).**
    * **A differential add-on rendered ₹0.00 / month.** `priceAmountSummary` read
      `prices.amount_minor`, which is 0 for a differential price (CAT-7 — the real rate lives per
      plan+currency+interval), so the item list showed a free add-on that the panel below priced at
      ₹3,760. The view now resolves each add-on through `resolveDifferentialAgainstPlanTx` against the
      plan the session will END UP with (its own plan line, else the subscription's — the distinction
      that helper was split out for), and a tiered differential falls back to naming the model rather
      than claiming zero.
    * **"billed to the card already on file" named nothing.** `change.paymentMethod` now carries the
      instrument that would actually be charged — the subscription's default, else the customer's
      newest valid one, the order `resolveChargeCandidates` uses — and the confirm step says "billed to
      Visa •••• 4366". `instrumentLabel` moved to `chrome.tsx` and the portal's `methodLabel` delegates
      to it, so the two buyer surfaces cannot name one card two ways.
    * **The tax row is itemised as the invoice itemises it** — `preview.taxLines`, rendered as
      "IGST (18.00%)" / "CGST (9.00%)" + "SGST/UTGST (9.00%)", with the single "Tax" row kept only as
      the fallback for a tax with no component vector.
  * **2026-08-27 (found by a CDP render, not by a test) — a HYDRATION mismatch on six-figure INR.**
    The flow's local `money()` called `toLocaleString(undefined, …)`, so Node grouped ₹2,54,129.52 in
    en-IN while the browser produced 254,129.52 and React discarded the whole tree
    ("Hydration failed because the server rendered text didn't match the client"). Pinned to `'en'`,
    matching `lib/format.ts`. Identical below ₹1,00,000, which is why it hid until the mandate lines
    started quoting large numbers.
  * **The add-payment-method step reads as a payment step, not as our routing table.** The gateway
    KEY (`RAZORPAY` / `TMTEST`) is no longer rendered to buyers, the single-gateway picker is omitted
    on the portal too (it already was on checkout), "Select mandate type for Razorpay" became "Pay
    future invoices from", the options are named for what they are ("Credit or debit card", "UPI
    Autopay", "Bank account · Netbanking e-Mandate · approved once with your bank"), and the grey well
    is gone — a filled box inside a card inside a section was a third surface for one radio group.
  * **2026-08-27 — "Manage cards", and the card a checkout bills becomes the customer's default.**
    * The change flow offered two doors: confirm on whatever the engine picks, or add a NEW card. A
      buyer holding two cards — one whose mandate cannot carry the new plan, one that can — could only
      get through by adding a third. New `GET /checkout/v1/payment_methods` (same serializer as the
      portal, so each row carries its mandate ceiling — the field that makes the list worth showing)
      and `payment_method` on `/complete`, resolved by `resolveHeldPaymentMethod`.
    * That resolver lives in the SERVICE, not the route: it is a session invariant on a public link, and
      "does not exist" and "belongs to someone else" deliberately answer identically so the link cannot
      become an oracle for real payment-method ids. An `invalid` instrument is refused here rather than
      by collection, which would find out after the change had been applied.
    * **The instrument a checkout will bill is assigned the customer's `primary` role**, via
      `assignPaymentMethodRole` (which demotes the previous one in the same transaction and writes the
      audit row). A subscription default alone was not enough — another subscription, a dunning retry
      and an ad-hoc collection all resolve through the customer's primary, so a buyer who re-authorised
      because the old ceiling was too small left every other path pointed at the card that cannot pay.
      The old instrument is demoted, never deleted: a smaller mandate is still a valid backup for
      smaller invoices, which is what `isHardDecline` relies on.
    * **"Manage cards" is no longer a one-way door.** It replaced the whole Confirm section with no
      return path (reported 2026-08-27), so a buyer who just wanted to re-read the proration was
      stranded on the payment step. The card step now carries "← Back to review" whenever it was reached
      from there — same shape as `detailsReturnTo`, for the same reason. The add-a-method block is also
      hidden while a saved card is selected, so the "Add a new payment method" option actually does
      something visible.

- **2026-08-27 — a checkout the buyer cannot come back to is now finished by the WEBHOOK.**
  Migration `0200` adds `checkout_sessions.setup_payment_intent`; `POST /checkout/v1/setup` records
  the `pi_…` it began, and `harvestSetupIntent` (webhooks/inbound.ts) calls the new
  `completeCheckoutForSetupIntent` once the gateway's own event has produced a vaulted instrument.
  * **The gap it closes.** RazorPay's `subscription_registration/auth_links` ignores `callback_url`,
    so a netbanking e-mandate buyer ends on RazorPay's "MANDATE REGISTRATION COMPLETED" screen and is
    never sent back. The harvest already vaulted the instrument with no browser involved — but
    nothing posted `/complete`, so the buyer authorised an auto-debit and received **no
    subscription**, with the session open until its TTL. The new-tab fix earlier the same day helps
    a buyer who is still there; this one covers the buyer who closed the tab.
  * **Idempotent by construction, not by a new flag.** `completeCheckout` already claims the session
    with an atomic `open → completing` compare-and-set and replays a completed one, so the browser
    and the webhook contend exactly as they already do for the instrument itself; whichever arrives
    second is a no-op. A redelivered gateway event answers `skipped`.
  * **It never throws.** An errored webhook makes the gateway redeliver the whole event and re-run
    the vault half, so a checkout that legitimately refuses (declined first charge, a coupon that
    expired meanwhile) is logged — `checkout_webhook_completion_failed` — and swallowed. A success
    logs `checkout_completed_by_webhook`, carrying `unpaidInvoice` when the change applied but its
    invoice did not collect: on this path nobody is watching the screen that would have said so.
  * `contextFromSessionRow` was split out of `resolveCheckoutSession` because this path reaches a
    session by the intent it began rather than by a bearer token, and a second definition of "what a
    checkout session means" is how the two would drift.
  * A setup intent with no session behind it — every portal add-card — is a quiet `skipped`.
  * 8 new checks in `verify:checkout` (173 total): nothing exists before the harvest, the
    subscription exists after it with no browser involved and is billed to the harvested
    instrument, the session is marked completed, a redelivery is skipped rather than replayed, and
    an unrelated intent is a no-op.
- **2026-09-28** — A card the buyer enters or picks on the checkout page is the ONLY card charged: `completeCheckout` runs inside `runChargingChosenCardOnly`, so a decline is shown to the buyer instead of being settled on an older saved card (which, since every non-primary card became a backup, the fallback would otherwise reach).
- **2026-09-30** — Create-mode mint prefill: `customer[email, tax_registration_number]` and `billing_address[…]` stored in `checkout_sessions.prefill` (0320) and served as the view's `customer` until the buyer submits; change mode rejects them. Retrieve returns `customer_prefill`/`billing_address_prefill` when set.
- **2026-10-08 (0332)** — A session's `metadata` is checked against the business's metadata rules when the operator mints it (types only, no strict). Completion writes it unchecked: the buyer cannot fix it.
- **2026-10-08** — A session that replaces the coupon list removes the dropped coupons with `subscription_changed` suppressed unless nothing later in the edit announces one (no items moving, no coupon applied after it), so a swap still emits one event.
- **2026-10-09 (0334)** — Address requiredness follows the field matrix: `addressRequirementIssues` (`address-field-rules.ts`) replaces the unconditional completeness refinement and `firstMissingMandatoryAddressField`. Defaults now say what was enforced: `billing.city`/`state_code`/`postal_code` `mandatory` (region/postal only where the country has them); 0334 rewrote stored `show`/`hide` on those (and `hide` on line1) to `mandatory`. `billing.country` never resolves to `hide`. Live tax regions force country (any) and state_code (GST) to `mandatory` at runtime (`withAddressFieldLocks`); the view's `field_config` is that effective matrix and `billing_details_complete` counts line1/country only where it requires them. Also hosts the portal matrix (`resolvePortalFieldConfig`, `mergePortalAddress`) used by customer-portal.
- **2026-10-25** — `storefront_config` gains `portal_show_usage` (default true) and `portal_show_usage_projection` (default false), resolved by `resolveStorefrontConfig`, accepted by the business PATCH, and switched on Settings → Hosted pages → Usage.
- **2026-10-27 (0360)** — Shipping address at checkout. New matrix key `shipping.address` (`show | hide | mandatory`, default `hide`), a section switch: `POST /checkout/v1/customer` takes `shipping_address` (billing shape + `addressRefinement`); `hide` ignores it, `mandatory` refuses a details post without one and a completion whose customer has no default ship-to (the email-only API path), and a sent one must hold line1, city, country and region/postal where the country has them (`SHIPPING_ADDRESS_REQUIREMENTS`). It becomes the default entry of the session-created customer's address book (`setDefaultShippingFromLegacy` via the customer write); a `show` details post without one archives it. Create-mode completion pins the subscription to it (`shippingAddressPublicId`); a purchase leaves it as the customer's default, which the invoice snapshots. A customer the session did not create (change mode, a known-customer purchase) is never written: the view forces the key to `hide` and the buyer changes it in the portal. The view's `customer.shipping_address` round-trips the entry. Storefront: "Ship to my billing address" (mandatory) and "Add a shipping address" (optional) checkboxes; operator setting on Checkout and portal fields. Checks: 17 in `verify:checkout`, 3 in `verify:checkout-purchase`.
- **2026-11-01 (Tier 3 PR 2)** — A purchase with credit-pack lines must stay inside `credit_config.top_up_limits`, checked at mint (`createCheckoutSession`) and at complete. Portal "Buy credits" opens a purchase session pinned to the customer (`POST /portal/v1/credits/purchase`). Gate: `verify:credit-packs`.
- **2026-11-03 (0495)** — The buyer coupon box is capped by `businesses.max_customer_coupon_codes` (default 1 for every business; deliberate change from no limit). `checkout_sessions.customer_coupon_codes` lists the codes the buyer entered; merchant codes do not count; the update is conditional on the count. Removing a code frees its slot. Gate: `verify:checkout` (0495 block).
- **2026-11-04** — Checkout session and payment link quantities (`quantity`, `min_quantity`, `max_quantity`) are capped at `LIMITS.quantity` (1,000,000). Gate: `verify:strict-params` § F.
