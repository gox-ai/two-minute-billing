# customer-portal — buyer self-serve payment-method portal (P14 slice)

> Source: `src/modules/customer-portal/` · Routes: `src/api/customer-portal-routes.ts` · Schema: `db/schema/portal.ts`
> Layer: product surface (see docs/architecture/architecture.json)

## Purpose
Lets a BUYER manage their own payment methods without operator involvement. An
operator mints a short-lived, customer-scoped portal session; the buyer opens
`/portal/s/<token>` (dashboard app), which hands the token to an HttpOnly cookie and
redirects to a clean `/portal`, and lists/adds/defaults/removes cards through
the `/portal/v1/*` routes — a separate trust boundary where the org API key
never reaches the buyer's browser.

## Responsibilities
- Mint + resolve customer-scoped portal sessions (`pstk_…` bearer tokens, 72h TTL).
- The buyer-facing `/portal/v1/*` API surface (thin auth wrapper over the
  payment-methods service — no duplicate PM logic).

## Data model
`portal_sessions` — org/business/customer FKs, `public_id` (`psess_…`), and **two
credentials** (0193):

- `access_token_hash` + `access_expires_at` + `consumed_at` — the **entry** credential
  (`pstk_…`) that appears in the link. One hour, **single-use**; `POST /portal/v1/session`
  spends it. `/portal/v1/*` does not accept it.
- `token_hash` — the **session** credential (`psst_…`) minted BY that exchange and held
  only in the buyer's HttpOnly cookie. NULL before the exchange and again after logout.

Plus `status` (`created` → `logged_in` → `logged_out`), the audit trail `login_at` /
`login_ip` / `logout_at` / `logout_ip`, `created_by` (minting api key), `expires_at`
(ceiling on the SESSION, not the link), `last_used_at`, and `revoked_at` — the operator
kill switch, written ONLY by `revokePortalSession` and filtered on by BOTH readers, so one
write ends the link and the session together. Every token is
SHA-256'd; neither plaintext is ever stored. RLS org-isolation like every tenant table.
No `resource_version` (no OCC) — the service stamps `updated_at`.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `createPortalSession({org,biz,customer,createdBy,kind})` | Mint session → `{publicId, accessToken, accessExpiresAt, expiresAt}` (entry token shown once) |
| `exchangePortalAccessToken(pstk, ip)` | Spend the single-use entry credential → a `psst_…` session, or null for every failure alike |
| `logoutPortalSession(psst, ip)` | The BUYER ends their own session — clears `token_hash` |
| `revokePortalSession({org,biz,customer,sessionPublicId})` | The OPERATOR kills the session: one `revoked_at` write ends BOTH credentials. Idempotent (reports the original stamp); null → the route's 404 |
| `resolvePortalSession(token)` | Hash lookup (unexpired, unrevoked) → `{organizationId, businessId, customerId}` or null; bumps `last_used_at`. Base-db read (spans orgs, like API-key auth) |
| `getPortalCustomer(ctx)` / `getPortalBusiness(ctx)` | Tenant-scoped rows for the session's customer / business |

## API routes
| Method · Path | Purpose |
|---|---|
| `POST /v1/businesses/:biz/customers/:cus/portal_sessions` | (org key) Mint a portal link — returns the single-use entry token + `url` (when `PORTAL_BASE_URL` set), `access_expires_at` (1h, or 5 days with `link_kind: 'email'`) and `expires_at` (72h, the SESSION it will mint) |
| `POST /v1/businesses/:biz/customers/:cus/portal_sessions/:id/revoke` | (org key, `ops`) Kill the link AND the session it opened — one `revoked_at` write, honoured by both readers. Orthogonal to `status`; idempotent (same `revoked_at` on a second call); one 404 for cross-tenant / cross-business / cross-customer / unknown |
| `POST /portal/v1/session` | **(NO auth, 0193)** Spend the entry token for a session token. Single-use; one 401 for expired/spent/revoked/unknown alike. Throttled per IP |
| `POST /portal/v1/logout` | (portal token) End the session — clears the credential, stamps `logout_at` |
| `GET /portal/v1/me` | (portal token) Customer + business display info |
| `GET /portal/v1/payment_methods` | List the session customer's PMs |
| `POST /portal/v1/payment_methods/setup` | Begin add-card via the business's **default gateway** (`initiateVaultSetupForBusiness`) — Stripe→`client_secret`, PayPal→`approval_url`, RazorPay→`checkout`, tmtest→fake `client_secret` |
| `POST /portal/v1/payment_methods` | Complete vault (`pm_…` / approved setup token / tmtest magic token) |
| `POST /portal/v1/payment_methods/:pm/default` | Set default |
| `DELETE /portal/v1/payment_methods/:pm` | Detach |
| `GET /portal/v1/invoices` | (portal token) List the session customer's invoices (#10c) |
| `GET /portal/v1/invoices/:inv` | Invoice detail (with lines); ownership-guarded to the session customer |
| `GET /portal/v1/invoices/:inv/pdf` | Stream the invoice PDF (reuses `assembleInvoiceDocument`+`renderInvoicePdf`); ownership-guarded |
| `GET /portal/v1/shipping_addresses` | (0360) The session customer's live shipping addresses |
| `POST /portal/v1/shipping_addresses` | Add one (line1, city, country; region + postal where the country has them). 403 when the business's checkout hides `shipping.address` and the customer has no book |
| `PATCH /portal/v1/shipping_addresses/:addr` | Edit fields and/or `is_default: true`; another customer's id → 404 |
| `POST /portal/v1/shipping_addresses/:addr/archive` | Archive ("Remove" in the UI); 409 with the engine's message while a live subscription ships to it, or to it as the default |
| `POST /portal/v1/subscriptions/:sub/shipping_address` | `{ address_id: "addr_…" \| null }` — set the ship-to; own subscription only, not cancelled. `GET /portal/v1/subscriptions` carries `shipping_address_id` + `shipping_address` |

Auth: `authenticatePortal` (src/platform/auth.ts) — separate token namespace
from org keys; each token only ever reaches its own customer (customer resolved
from the token, never from a URL param). Coverage note: `/portal/v1/*` is
outside the `/v1/` OpenAPI-coverage sweep; only the mint route is in openapi.ts.

## Events emitted
None yet (PM vault/detach flows emit their usual payment-method events with
`actor = psess_…` via the event context).

## Dependencies
- **Upstream (calls into):** payment-methods (vault/list/default/detach/setup), customers/businesses tables (reads).
- **Downstream (called by):** platform/auth (`authenticatePortal`), dashboard `app/portal/[token]/*` + customer-page "Portal link" action.

## Self-serve access — a typed code, never a link

**Built in Phase 4 (2026-11-03) as the shape this section asked for:** `storefront_config.portal_email_code`
(off for existing businesses) puts an email field on the signed-out portal card. The customer gets a
6-digit code by email (`emails/sign-in-code.ts`, a SYSTEM email type) and TYPES it
(`login-code.ts`, `POST /portal/v1/login/request` + `/verify`). Codes are hashed, single-use, 10
minutes, 5 wrong tries; the request never says whether the email has an account; rate limits per IP
and per address (5 codes an hour); Turnstile when configured. The logged email row is masked. Still
no emailed sign-in LINK — the reasoning below is why.

### Why not a link (history)
There is **no way for a buyer to let themselves in**. Every portal link is minted by an
operator or an integration (`POST …/portal_sessions`), or by the email outbox on the one
button an automated email renders. A buyer who has lost their link asks the business for
another; the portal's expired card says exactly that and points nowhere.

This is a decision, and the reasoning is the part worth keeping — it was carried on
`requestPortalMagicLink`, which shipped a working page (`/portal/request`), a form, a
server action and an unauthenticated `POST /portal/v1/request_link` while its own
docstring claimed to be dormant. All of that was **deleted on 2026-08-30**:

- **An emailed link cannot be single-use.** Mail clients and security scanners PREFETCH
  links, so a one-time link is routinely spent before the human clicks it — and the buyer
  meets "this link has expired" having done nothing wrong. Portal entry credentials are
  single-use by design (0193), because the path we actually use is an integration minting
  a link and redirecting a user it has already authenticated, which nothing prefetches.
  The self-serve flow is the one case where that guarantee and the delivery channel are
  in direct conflict.
- **Do not email a portal link at all.** The two workable paths are an SSO redirect
  (never emailed) and a one-time **PASSWORD the customer types**. A typed code cannot be
  prefetched, because opening the mail does not spend it. That is the shape to build if we
  want a self-serve path — not a longer-lived link, and not a reusable one.
- The deleted mint also passed **no `kind`**, so a single-use *emailed* link took the
  one-hour `api` window instead of the five days `PORTAL_EMAIL_ACCESS_TTL_MS` exists for.
  Worth noting only because it shows the flow was never actually exercised.

Do not re-add a link-shaped self-serve entry. `dashboard/lib/storefront-session.ts`
carries the same argument from the browser side.

## Invariants & gotchas
- The org API key must NEVER satisfy `/portal/v1/*`, and a portal token must
  never satisfy `/v1/*` — enforced by distinct resolvers; asserted in
  `verify:customer-portal`.
- Dashboard portal pages must not import `dashboard/lib/api.ts` (org-key
  client) — they use `dashboard/lib/portal-api.ts`.
- Stripe completion: a pm confirmed via SetupIntent is already attached;
  provider `vaultPaymentMethod` treats re-attach as a no-op but refuses a pm
  attached to a DIFFERENT provider customer.

## Changelog
- **2026-11-05** — Security fixes. Resume is open to a customer only for a pause they took from
  the pause offer (`subscriptions.pause_source = retention_offer`, 0493); a later business pause
  stays the business's. The retention coupon is refused by the portal and checkout coupon boxes
  (`retention-coupon.ts`, by coupon id); only an accepted offer applies it. A held add-on the
  portal does not offer (hidden, archived, not on the plan) can only be removed (`remove_only`).
  The sign-in code email goes through the `portal_sign_in_code_send` job, the code encrypted in
  the payload, so the request's timing does not show whether the email has an account.
- **2026-11-04** — Phase 4b. Single-action links (`actions.ts`): `POST …/portal_sessions` takes
  `action` (`pay_invoice` | `update_card` | `change_plan` | `cancel_subscription`) + `object`; the
  object must be the customer's; a task the business turned off (`portal_actions`) opens the portal
  home, never an error. The task travels as `forward_url` (`/portal?tab=…&pay_invoice=…`, `add_card=1`,
  `change=…`, `cancel=…`) and the portal opens it (focus Pay now; open add card / change plan /
  cancel); the full portal stays open (user decision). `GET /portal/v1/session/peek` describes a link
  without spending it (kind, task, branding only; no-store, no-referrer). Emailed links land on
  `/portal/continue/<token>`, whose POST button spends them. `/me` returns `return_url`
  (link `redirect_url` → `portal_return_url`, https only → `default_return_url`) for "Back to".
- **2026-11-03** — Plan change: `reset_term` (business `plan_change_term`) and
  `credit_handling` / `credit_handling_options` on the preview; the apply takes `credit_handling`
  under `downgrade_credit: customer_chooses` and returns `credit_refunds`. No portal UI for the
  credit selection yet.
- **2026-11-03 (0485)** — Phase 4a. Sign-in by email code (`login-code.ts`, `portal_login_codes`,
  `POST /portal/v1/login/request|verify`, `link_notice.email_code`, `findPortalBusiness`). Per-business
  lifetimes: `portal_link_hours` (API link, 1–24, null = 1 h), `portal_email_link_days` (1–14, null
  = 5 days), `portal_session_hours` (1–168, null = 72 h; stamped at exchange). Hide settings
  (`portal_hide_cancelled_subscriptions`, `portal_hide_zero_invoices`, `portal_hide_voided_invoices`)
  filter in the list queries; an invoice with an amount due always shows. Gate: `verify:portal-access`.
- **2026-11-03** — Engine side of three "customer chooses" settings (no portal screen yet): `POST /portal/v1/pay_invoices` (`invoices` omitted = Pay all, needs `several_due_invoices = customer_chooses`; with `invoices` = the customer's selection, needs `invoice_order = customer_chooses`; one charge with a saved method, 403 otherwise), `GET /portal/v1/overpayments` and `POST /portal/v1/overpayments/:pay/refund` (`excess_payment = customer_chooses`). `GET /portal/v1/requests` hides the clock's `dunning` requests.
- **2026-11-03** — Plan-change preview returns `priced_at` + `quote` (hash of every amount it
  shows: due today, deferred, credit, tax, next recurring, effective date). Apply takes both:
  it re-prices at `priced_at` (at most 15 minutes old, never in the future) and refuses with
  409 when the quote moved. `expected_total_minor` stays required for API callers.
- **2026-11-03** — Plan changes follow the catalogue: an add-on is offered per plan by
  `listApplicableAddonsForPlan` (options carry `addons[].rules` keyed by plan price; absent = not
  on that plan), a mandatory one cannot be removed, a new one must apply to the final plan, and on
  a plan switch an add-on the new plan does not take must be removed in the same change
  (auto-included mandatory items excepted — the engine swaps those). Limits from 0484: add-on
  min/max/step and "customer can change quantity"; seats per plan price (`seats.by_plan`), else
  `seat_min/seat_max`. Cancel flow fixes: an offer-paused subscription can resume even with
  pause/resume off, its card shows `paused.resumes_at`, and a paused subscription cancels now
  (the engine has no term end to cancel a paused one at). Flow returns `status` and `can_undo`.
- **2026-11-02** — **Cancel flow with offers (storefront Phase 3).** `retention.ts`: `GET
  /portal/v1/subscriptions/:sub/cancel_flow` (reason mode + reasons + offers + timing) and `POST
  …/retention_offer {offer, months?, reason_code?}`. Offers, each a real engine action: pause
  (`pauseSubscriptionWithOptions` with a `resumeDate`; months fixed, chosen by the customer up to
  a maximum, or no end date), a cheaper plan (`scheduleChange` at the term end; now in a trial),
  a coupon (`applyCouponToSubscription`), a contact link. Settings (`storefront_config`):
  `cancel_reason` (off | optional | required; portal only — staff cancels follow Billing rules),
  `retention_pause`, `retention_pause_months`, `retention_pause_choice`,
  `retention_downgrade_price`, `retention_coupon`, `retention_contact_url`, `retention_offer_once`.
  Unset = today's flow: an optional reason, no offers. The cancel route refuses a missing reason
  when required and records each cancellation; offers taken and cancellations go to
  `retention_events` (0483), read by "offer once" and the `cancellation_saves` report. UI: the
  cancel dialog is three steps (reason → offers → confirm) with "Cancel subscription" on each.
  Gate: `verify:portal-retention` 22/22.
- **2026-11-03** — Plan changes follow the business's plan-change rules (`billing_rules_config`
  upgrade/downgrade proration, gate, timing) through `resolveChangePolicy`; no code change here.
  Proration no longer reads `default_prorate_on_change`: unset = prorated. A gated change shows
  "Pay your open invoices before you change your plan." in `change_options` and refuses 409.
- **2026-11-02** — **Plan, seat and add-on changes (storefront Phase 2).** `plan-change.ts`:
  `GET /portal/v1/subscriptions/:sub/change_options`, `POST …/change/preview`, `POST …/change`
  (`expected_total_minor` must equal the preview's `total_minor`, else 409), `DELETE
  …/scheduled_change`. What a customer may pick = each product's `enabled_in_portal`; what they
  may do = `storefront_config` (`allow_plan_changes`, `seat_changes` + `seat_min`/`seat_max`,
  `allow_addon_changes`, `shorter_period`, `charge_upgrade`, `change_statuses`,
  `allow_cancel_scheduled_change`). Timing, the gate and proration come from
  `subscriptions/change-policy.ts` (`resolveChangePolicy`, shared with every source). Direction:
  a longer billing period is an upgrade, a shorter one a downgrade, else the monthly recurring
  amount decides. Today's policy: upgrade now, downgrade at the end of the term. A "now" change
  runs ONE `changeSubscription` (changes + adds + removes, one invoice); "end_of_term" is a
  `scheduleChange` at `current_period_end`. The invoice timing is resolved once (portal setting,
  else `unbilled_charges_config.on_change`) and passed to both the estimate and the apply, so a
  deferred charge previews as "Added to your next invoice". `GET /portal/v1/subscriptions`
  carries `plan_change { allowed, scheduled }`. UI: `portal-change-plan.tsx` (Change plan dialog,
  Withdraw change). In trial every change applies now. Gate: `verify:portal-plan-changes` 35/35.

- **2026-11-02** — **Cancel, pause, resume and keep are on the portal page.** The four routes and
  their `storefront_config` switches existed, but the page rendered no buttons. `GET
  /portal/v1/subscriptions` now carries `actions: { cancel: {timing, reasons} | null, pause,
  resume, reactivate }` (`portalSubscriptionActions`): the business's switch AND a state the
  route accepts (pause: active and not cancelling; resume: paused; reactivate: cancelling;
  cancel: not ended and not already cancelling). The plan card renders `PortalLifecycle`, one link
  per offered action; cancel opens a dialog that states the timing and offers the business's
  cancel reason codes (optional). `verify:customer-portal` +5 checks.
- **2026-10-25** — `GET /portal/v1/receipts`, `GET /portal/v1/receipts/:rcpt/pdf` (numbered receipts, ownership in the query); `GET /portal/v1/requests`, `GET /portal/v1/requests/:preq`, `POST /portal/v1/requests/:preq/pay` (charges a saved method with `initiator: customer`).
- **2026-10-27 (0360)** — **Shipping addresses in the portal.** Buyer routes over the address book
  (`modules/customers/addresses.ts`): list, add, edit, make default, archive, and set a
  subscription's ship-to. All scoped to the session customer. Requiredness is fixed (line1, city,
  country, region + postal where the country has them), not the billing `portal_field_config`.
  Add is open when the checkout matrix shows `shipping.address` or the customer already has a book;
  `/portal/v1/me` carries `business.collects_shipping_address`. `GET /portal/v1/subscriptions` adds
  `shipping_address_id` (null = follows the default) and the resolved `shipping_address`. UI: a
  "Shipping addresses" section under Billing details and "Ships to … Change" on each plan card.
  The buyer word for archive is **Remove** (no portal restore; restore is operator-only).
- **2026-10-25** — **Pay now no longer reopens a form that cannot load.** On a second click over
  a live intent, `POST /portal/v1/invoices/:inv/collect` asks the gateway first
  (`resumeVerdictFromGateway`): money already authorized or captured is booked through the same
  leg-2 path as the re-post (`settleIntent`) and the paid invoice comes back; a cancelled intent is
  voided and a new one minted; only an intent that still needs the buyer replays its action. A
  locally `authorized` intent on such a gateway is now booked instead of refused. The storefront's
  Stripe form shows an error on Elements `loaderror` instead of loading forever.
- **2026-10-25** — **Every Stripe Elements confirm carries a return URL.** Pay now
  (`/portal?pay=return`), add-card (`/portal?setup=return`) and the checkout's card step and
  first-charge challenge (`/checkout?setup=return`, `?pay=return`) pass `return_url` and write the
  return stash before confirming, so a method that redirects can come back and finish. A
  `processing` bank debit is pending, not a failure. A return with `redirect_status=failed` shows
  "Payment not received" instead of retrying leg 2.
- **2026-10-16** — **A redirect "Pay now" is followed until it settles.** `GET
  /portal/v1/invoices/:inv` now carries `payment_in_flight`. The return leg (`payment-return.tsx`)
  retries "did not tell us yet" up to 4 times, then shows a "Payment in progress" card and reads the
  invoice every 3 s for 2 min: paid → "Payment received", in flight then gone → "Payment not
  received". While it is in flight the invoice's "Pay now" is held off client-side
  (`markPaymentProcessing`), because the webhook can still be mid-capture — no payment row yet —
  when the list re-renders. A pay response for a held capture is "We are confirming your payment",
  never "Payment received". The return leg must NOT change the URL: on Next 16 that re-keys the page
  segment and the next refresh does a full page reload, which drops the card.
- **2026-10-14** — **Save billing details shows the reason it failed.** The portal client read only
  `error.message`, which was "Invalid request body", so a buyer whose phone was refused never
  learned which field was wrong and could not add a card. It now shows the field reasons, and a
  refused body on any `/portal/v1/*` route is recorded in `buyer_request_rejections` for ops.
- **2026-10-03** — **A business's own message for a buyer who cannot get in.**
  `storefront_config.portal_link_error_html` (rich text, sanitised on read with the email
  allowlist) replaces the body of the "This link is invalid or has expired" card for every
  failure: expired, spent, revoked or unknown link, no cookie, rejected session. Sign-out keeps
  its own card. `POST /portal/v1/session` now returns `business` on success AND on a 401 for a
  real-but-dead link (never for an unknown token), and the storefront remembers it in a
  non-secret `tmb_portal_biz` cookie; public `GET /portal/v1/link_notice/:biz` (rate-limited)
  returns the brand + message. Accepted cost: a dead link now reveals whose it was.
  `verify:portal-link-notice`.
- **2026-09-17** — **The portal's coupon box is now add AND remove, one discount at a time.**
  - `DELETE /portal/v1/subscriptions/:sub/coupon` takes the buyer's coupon back off, gated on the
    same `allow_customer_coupons` switch as the apply route — one switch governs the whole box
    rather than half of it. This REVERSES the "add only" decision below, and the reasoning that
    replaces it: only a COUPON-sourced discount can be lifted (an operator's manual discount answers
    403 — the buyer never asked for it and could not put it back), and with one discount at a time
    a buyer who typed the wrong code would otherwise have no way out. The residual risk is stated
    rather than designed away: a merchant-granted coupon CAN be removed here and the buyer needs the
    code to restore it; a merchant who cannot accept that turns the box off.
  - **One discount per subscription from the portal.** The apply route refuses a second code
    (400) while one is live. The engine still stacks coupons (CAT-1) and an operator still may —
    this ceiling lives in the portal routes, not in the coupons service.
  - **The control lives on the discount line**, not in a footer: the Next payment block already
    itemises the discount by name, and a footer repeating the code printed it twice on one card.
    Removal is confirmed (`ConfirmDialog`, `brand`) because it is one-way from the buyer's side.
  - `GET /portal/v1/subscriptions` reports `discount: { id, coupon, source, removable } | null`, so
    the page shows the applied code with Remove instead of an entry box that would refuse. The
    buyer is never shown "Have a coupon code?" while a discount is live.
  - 11 checks in `verify:customer-portal` pin all of it, including the manual-discount refusal and
    both routes answering 403 with the switch off.
- **2026-09-08** — **A customer can apply a coupon to their own subscription (0238).**
  `POST /portal/v1/subscriptions/:sub/coupon`, gated on `businesses.allow_customer_coupons` (off by
  default). Buyer-facing coupon entry carries a risk, written here where it lives: a code is only
  as private as the coupon makes it — anyone who
  learns the string can apply it, and the only limits are the ones ON the coupon (`valid_from`,
  `redeem_by`, `max_redemptions`, CAT-2 item constraints). A merchant needing a code confined to one
  customer wants a coupon SET, not this flag off.
  - **Scoped to the session's own customer**, not just the business: the subscription id comes off
    the URL, so without `customerId` in the predicate one buyer could discount another's
    subscription. `verify:bola` is what pins that shape.
  - **Add only.** Removal is deliberately not offered: a buyer cannot tell a code they typed from
    one the merchant granted, so an "X" beside the wrong one throws away something we did not give
    them. Removing a discount stays an operator action.
  - Answers with the **re-estimated next payment**, so the page states the new figure instead of
    saying "applied" and leaving the buyer to work out what changed. The box renders only on a
    subscription that will actually be billed again — a discount on a plan that will not renew
    changes nothing, and a box that takes a code and appears to do nothing is worse than none.
  - `CouponError` → 400 with the engine's own sentence. A buyer has no operator to ask and no log
    to read, so "could not apply" would leave them stuck.
- **2026-08-30** — **`revoked_at` got its writer, and a dead self-serve flow got deleted.** Two items
  from the same audit, both about a portal surface saying something that was not true.
  * **F-9 — `POST /v1/businesses/:biz/customers/:cus/portal_sessions/:id/revoke`.**
    `portal_sessions.revoked_at` had been on the table and filtered on by BOTH readers
    (`exchangePortalAccessToken` and `resolvePortalSession`) with nothing in the product ever
    setting it. Two defects in one: an operator whose link had leaked — a forwarded mail, a shared
    inbox, an offboarded employee still holding a live cookie — had no lever at all, and a guard no
    code path exercises is a guard nobody would notice breaking. `POST /portal/v1/logout` was never
    that lever: it needs the buyer's own `psst_…`. The identical hole was closed for
    `checkout_sessions` on 2026-08-28 and this mirrors that design rather than inventing a second one.
    - `requirePerm('ops')`, **matching the MINT rather than something stricter**: `ops` can hand out a
      link that reaches a buyer's stored cards and invoices, so `ops` must be able to kill one.
      Anything higher is a role that can create the exposure and not close it, and revocation is the
      fail-SAFE direction (the reasoning `POST /v1/api_keys/:id/revoke` records for carrying no step-up).
    - **ONE write, BOTH credentials** — the place this differs from checkout, which has one. 0193 gave
      the portal a single-use `pstk_…` entry token and the `psst_…` session it mints, and revocation
      has to end both. It does, because both readers already filter `isNull(revoked_at)`: a link never
      opened cannot be exchanged (its usual single 401), and a session already in flight stops
      resolving, so every `/portal/v1/*` route — the readable ones included — answers 401.
    - **Deliberately does NOT also clear `token_hash`** (which is what `logoutPortalSession` does).
      The row is the audit trail an operator revoked against, and blanking the credential it names
      weakens that for nothing. It would also make the guard untestable: with the hash gone, blinding
      a reader to `revoked_at` would still fail closed, so the mutation proving the mechanism could
      never go red. The guard is the mechanism, and it is asserted as the mechanism.
    - **Revoked is not logged out.** `status` is untouched: `created → logged_in → logged_out` answers
      "was this link ever opened"; revocation is a kill switch beside that lifecycle, not a step in it.
      All three states are revocable. Idempotent — a second call reports the ORIGINAL `revoked_at`
      rather than moving the moment the session died — and cross-tenant, cross-business, cross-customer
      and unknown-id all take one 404, so an operator learns nothing about ids that are not theirs.
    - **`verify:customer-portal` 86 → 108 checks**, in the two halves the checkout suite names, which
      are literal here: a session ALREADY IN FLIGHT stops working (on `/me`, on a READ route and on a
      MUTATING one) and a link NEVER OPENED cannot be exchanged at all — each with its positive
      control (a sibling session minted alongside stays alive; the rightful operator can still revoke
      after four authorization refusals). MUTATION-TESTED three ways: blinding `resolvePortalSession`
      to `revoked_at` fails 5, blinding `exchangePortalAccessToken` fails 3, and stopping the writer
      from writing it fails 8.
  * **F-10a — `/portal/request` and `POST /portal/v1/request_link` are gone.** The docstring on
    `requestPortalMagicLink` said the flow was "DORMANT, AND MUST STAY THAT WAY… Nothing links to
    `/portal/request` today". **That was false**: the page, the form, the server action and the
    unauthenticated route all shipped and worked. It was wrong a second way — the mint passed no
    `kind`, so a single-use *emailed* link took the one-hour `api` window rather than the five days
    `PORTAL_EMAIL_ACCESS_TTL_MS` exists for, which shows the flow was never exercised. Deleted rather
    than left reachable: the page, `portalRequestLink`, `requestLinkAction`, the route, the service
    function, its `renderPortalMagicLinkEmail` template, and `verify:portal` (the suite existed only
    to test it). **The reasoning survives as § "Self-serve access" above** — an emailed link cannot be
    single-use because mail scanners prefetch it, and the answer is a typed one-time PASSWORD.
    That argument is why the flow must not come back link-shaped, and it outlives the code.
    ⚠️ `emails/outbox.ts`'s `portalEntryUrl` produced `/portal/request?business=…` and feeds
    `{{portalUrl}}`, a merge variable offered to merchants for EVERY template. Left alone it would have
    mailed a 404. It now returns `${PORTAL_BASE_URL}/portal`: a live cookie lands the buyer in their
    portal, and a dead one gets the portal's own truthful expired card. It could NOT simply return
    undefined — `blocksFor` builds an email's action button only when `portalUrl` is set, so that would
    have silently removed "Pay now" and "Update payment method" from every billing email.
  * **F-16 — `GET /portal/v1/payment_methods/gateways` returns `method_types`.** It mapped only
    `{id, gateway_key, label}` while the checkout's equivalent returned the rails, and
    `dashboard/lib/portal-api.ts` already typed the field and `add-card.tsx` already read it — so the
    portal fell through to a hardcoded `['card','upi','bank_transfer']` guess and could offer UPI or
    netbanking on a RazorPay account with neither enabled: a control that does nothing, discovered
    only at the gateway's own sheet. `listVaultGatewaysForBusiness` already returned `methodTypes`;
    this passes it through. Asserted on every row, because null (no restriction) and absent (the bug)
    are different answers.
- **2026-08-28** — **A retry inside the gateway's own sheet was applied server-side and never shown.**
  Reported: the first attempt fails, the buyer retries inside RazorPay, it succeeds and redirects back
  — and neither the portal nor checkout reflects it, until a manual page refresh does.
  Two client-side defects, both in the redirect-RETURN leg:
  **1. The stash was destroyed by the failed return.** `pending-vault-setup` (sessionStorage) holds the
  setup token and the `pi_…` the return leg completes through. The portal cleared it unconditionally
  after the attempt and checkout cleared it *before* even attempting — so a buyer who came back a
  SECOND time (having retried inside the sheet) had no token and no intent to complete with, and could
  only be told to start again for a method the gateway had just approved. Now cleared on success and on
  cancel only.
  **2. The view refreshed only on success.** Our leg failing does not mean the instrument is not there:
  the gateway's webhook harvest is the documented other completer for that same intent
  (`completeVaultFromIntent` waits ~2s for it, then gives up), and it can land after we have given up.
  The portal now calls `router.refresh()` on both outcomes, and the failure toast says "not confirmed
  HERE yet… it will appear in a moment" rather than claiming failure — because the refresh it fires may
  already be painting the card the toast is apologising for. This is what made a manual reload look
  like the thing that fixed it.
  Verified in a browser by injecting a stash that cannot complete and driving `?setup=return`:
  MUTATION-checked, the old unconditional clear leaves the stash `absent` and the fix leaves it
  `PRESENT`. ⚠️ The RazorPay retry itself could NOT be reproduced here — no live gateway — so this fixes
  the mechanism the code shows, not a reproduced root cause.
- **2026-08-28** — **Pay now lets the BUYER choose the method, and the "by card" label added earlier
  today is therefore gone.** The intent is now minted with `letBuyerChooseMethod`, so the gateway's own
  sheet offers whatever the merchant has enabled instead of the single rail of whichever instrument we
  resolved. A customer holding a card and a UPI mandate previously got whichever their default happened
  to be, with no way to use the other.
  **This supersedes the label entry below, which described shipped behaviour that no longer exists.**
  That label answered "which method will Pay now open?" while the answer was one rail we chose for
  them. It is not any more, so naming a rail would be a claim the checkout does not honour — worse than
  saying nothing. The sheet itself is the honest answer and it arrives one click later. `railLabel` and
  the `pay_now` field went with it rather than being left as a primitive with no consumer.
  What the label work left behind and kept: `resolveBuyerPayMethod`, still the single definition of
  which instrument a buyer-present payment resolves to — it decides gateway ROUTING and what the intent
  row records, even though it no longer decides the rail.
  Guarded by a MUTATION-TESTED assertion on a UPI-default customer: restoring `methodTypes:
  [usable.type]` prints `↳ rail still pinned to: upi` and turns it red. `upi` is in tmtest's
  `CHECKOUT_RAILS` and `card` is not, which is what makes the pin observable at all.
- **2026-08-28** — **Pay now says what it will open, before it opens it.** A buyer could not tell which
  of their saved methods the button would use, and the answer is not guessable: it is their DEFAULT
  (not the newest), and it decides which rail the checkout even offers. `GET /portal/v1/me` now carries
  `pay_now: { method_type }`, and the portal prints it under the button as "by UPI" / "by card".
  Two decisions worth keeping:
  **The RAIL, never the card.** RazorPay's Checkout cannot be pointed at a vaulted token — its adapter
  says so outright — so the saved card is not what pays there; it only decides which rail the buyer
  re-authorizes on, and they enter an instrument in the sheet. Stripe DOES confirm against the saved
  token. "Visa •••• 4242" would therefore be true on one gateway and false on the other; the rail is
  true on both, and it is the thing the buyer actually wants to know. `railLabel` is deliberately
  separate from `instrumentLabel`, which names the card, so neither can drift into the other's job.
  **Resolved server-side**, by the same `resolveBuyerPayMethod` the collect route mints its intent
  with. Deriving it client-side from the payment-method list would have been right until the pick rule
  changed, and then it would lie on the one screen where the buyer is deciding whether to press.
  No confirmation dialog: one that only restates the next screen is a speed bump, and this is visible
  *before* the click rather than after it. A dialog earns its place only if it lets the buyer CHANGE
  the rail — which needs the unpinned-instrument intent mode still open below.
  Measured in a browser, not eyeballed: 12px (the floor), `--muted-foreground`, right-aligned with the
  button, no console errors. Mutation-tested — deriving `pay_now` from "newest valid" turns it red.
- **2026-08-28** — **"Intent already consumed" was shown to a buyer whose payment had just SUCCEEDED.**
  Two settlers reach for one payment intent by design: the buyer's browser posts leg 2 of Pay now, and
  `intent.authorized` reaches `harvestInvoiceIntent` in the inbound webhook — which exists precisely
  because the browser sometimes never comes back (measured 2026-08-14: a ₹20,000 Pay now authorized at
  RazorPay, the tab lost, the money left held at the gateway). The webhook side has always handled
  losing the race gracefully (`PaymentIntentConflictError` → `processed`, `PaymentIntentError` →
  `ignored`). The BUYER's side did not: `consumePaymentIntent` throws `Intent already consumed`, the
  route mapped `PaymentIntentError` to a 400, and the person who had just paid got a red error for
  money captured a moment earlier.
  The identical race was found and fixed on the ADD-CARD side — `vault-setup.ts` says it in as many
  words: *"Lost the claim to the webhook harvest … the instrument IS recorded, which is the outcome
  this function exists to produce — resolve the row the intent names instead of calling it a
  failure."* The money side never got the same treatment; this is that treatment. The consumed case is
  checked BEFORE the consume and caught AROUND it (the race can land either side of our read), and the
  route now reports the OUTCOME the intent produced — the invoice, with a `payment_error` only when
  money is genuinely still owed. An intent consumed into a DIFFERENT invoice stays a hard 400: that is
  not a race, nothing there paid this invoice.
  Guarded by a MUTATION-TESTED assertion that reproduces the exact toast
  (`400 {"message":"Intent already consumed"}`) when the guard is removed.
  ⚠️ `POST /portal/v1/session` is throttled **per IP** at `RATE_LIMIT_AUTH_PER_IP` (30/min). Buyers
  behind one NAT or corporate proxy share that bucket and can throttle each other out of their billing
  portal. Not changed here — flagged. `verify:customer-portal` now raises it, because every request in
  a suite comes from 127.0.0.1 and the cap surfaced as intermittent `401 Missing portal token` on
  unrelated assertions.
- **2026-08-28** — **Pay now always opens a real-time checkout, and quotes the amount the buyer is
  actually shown.** Two things were wrong with the same handler.
  **(1) It sometimes debited the mandate instead.** A saved UPI mandate that could carry the amount
  was charged directly, because RazorPay's UPI checkout on an `upi: { intent: true }` account renders
  a QR that nothing in TEST MODE can scan, and the mandate was measured collecting ₹66,025 in under
  two seconds. That optimised the test environment at the buyer's expense — a QR is an ordinary
  real-time UPI flow for someone holding a phone — and above ₹15,000 it actively defeated the button:
  `mandateRefusal` gates on the mandate's CEILING only, so a ₹50,000 invoice on a ₹1,00,000 mandate
  sailed through, while `debitNeedsBuyerAuthentication` counts `upi` among the rails needing per-debit
  AFA over ₹15,000. The debit was booked `in_progress`, the invoice row flipped to "Waiting for your
  bank", and Pay now was blocked behind the in-flight guard — the buyer put into the exact limbo the
  button exists to escape. A mandate debit is asynchronous on every rail RazorPay has, so even the
  happy path is "Payment processing…", not the confirmation someone pressing Pay now is asking for.
  ⚠️ Trade accepted: a UPI buyer on an intent-only TEST account now gets a QR they cannot scan and can
  only dismiss. That is a test-environment gap, not a production one, and it is the honest failure —
  the old behaviour hid it by silently charging a different rail.
  **(2) It followed the newest instrument, not the customer's default.** `listPaymentMethods` orders
  `created_at DESC` and the route took the first `valid` row, so adding a second instrument silently
  repointed Pay now at it — overriding the "Set default" the buyer had used on that same screen
  (`setDefaultPaymentMethod` writes `role: 'primary'`). It matters more now that Pay now no longer
  debits the mandate: `methodTypes` is derived from this pick, so the chosen instrument no longer just
  pays, it decides which rail the checkout will even offer — and a UPI-rail pick hands a card-holding
  buyer a UPI-only modal. Now primary-first with a fallback to the latest, the same rule
  `resolveChargeCandidates` uses for automatic collection, so the button and the clock agree about
  which instrument is the customer's. Filtered to `valid` first, which collection does not need to do
  and a buyer-facing checkout does: an invalid primary must fall through to something payable rather
  than open a checkout on a dead card. Guarded by a MUTATION-TESTED assertion — reverting the one line
  turns it red.
  **(3) It quoted `total_minor`, not the collectible.** `total_minor` is the gross taxed claim;
  `amount_due_minor` is net of the promotional slice, the refundable/excess credit applied at
  generation, and TDS withheld. Measured on a ₹10,000 invoice carrying ₹2,000 of promotional credit:
  the portal displayed ₹8,000 due and leg 1 minted an intent for ₹10,000 — which
  `consumePaymentIntent` then REFUSED, because it re-derives the outstanding via `invoiceOutstanding`
  and demands equality. So the buyer completed their bank's challenge and only then hit "Intent amount
  … does not match invoice amount due …": not an overcharge, a dead button, after the OTP. The same
  lesson is written down inside `consumePaymentIntent` for the part-paid case; it was fixed there and
  never here. `verify:customer-portal` now puts credit on an invoice and pays it.
- **2026-08-22** — **`/portal/v1/me` carries `business.timezone`.** The portal renders invoice dates
  and sits outside the `(dashboard)` tree, so there is no `BusinessTzProvider` to read — without this
  field `fmtDate` fell back to UTC and showed a different issue date than the invoice PDF for any
  business east of Greenwich, on the one screen where a customer is reading their own invoice. The
  checkout session payload got the same field for its renewal date. Deliberately no provider out
  here: a buyer surface renders a handful of dates, and an explicit `tz` argument is harder to forget
  than a context that silently defaults. A NEW date on either route must pass it. Gated in
  `verify:customer-portal` and `verify:checkout`.
- **2026-07-30 (fix 2)** — **RazorPay add-card showed a test-token box, not a card form.** The
  storefront had no `mode: 'checkout'` branch at all, so RazorPay's embedded-Checkout descriptor fell
  through to the tmtest fallback. Now opened via `dashboard/lib/razorpay-checkout.ts`. Two backend
  parts went with it: the setup route asks for `methodTypes: ['card']` (without it an INR customer
  was sent down RazorPay's **netbanking e-mandate** rail), and `GET /portal/v1/me` now returns the
  customer-level `phone` so Checkout's contact step is prefilled. Completion posts the payment id
  Checkout returns — the adapter resolves it to the mandate token.
- **2026-07-30 (fix)** — **Redirect-mode add-payment-method never completed.** The portal began a
  real vault setup and sent the buyer to PayPal's approval page, but dropped the setup token and the
  chosen gateway on the way out, and `/portal/<token>?setup=return` was a page that never read its
  query — so an approved buyer landed back on an unchanged portal. The storefront now stashes the
  pending setup (`dashboard/lib/pending-vault-setup.ts`) before leaving and exchanges it on return
  (`portal/[token]/setup-return.tsx`), vaulting on the **same** `gateway_account` the setup ran on.
  No API change; `POST /portal/v1/payment_methods` now answers 400 (not 500) when the gateway
  refuses the token. The success path still needs a human PayPal sandbox approval to prove.
- **2026-07-22** — **Portal invoices (#10c)** + **self-serve magic links (#10a)**. Invoices:
  read-only `GET /portal/v1/invoices`(+`/:inv`,`/:inv/pdf`), all scoped/ownership-guarded to the
  session customer (a buyer can't fetch another customer's invoice by id). Magic links: public
  `POST /portal/v1/request_link` (`requestPortalMagicLink`) resolves business→org at system level,
  finds the customer by email, mints a session, and enqueues a `portal_magic_link` email **bypassing
  the per-business opt-in** (transactional). Always 200 (no existence leak) + per-customer 60s
  throttle. New buyer surfaces live under the **storefront route group** `dashboard/app/(storefront)/portal/*`
  (separate root layout — dashboard chrome can never wrap the portal). Verify: `verify:portal` (7).
- **2026-07-13** — Gateway picker: new `GET /portal/v1/payment_methods/gateways` lists the business's
  active, vault-capable gateway accounts; the portal shows them as a choice before add-card, and
  `POST /portal/v1/payment_methods/setup` now accepts `gateway_account` to vault through the buyer's
  pick (unknown/inactive → 400). Verified by `verify:customer-portal` (gateway list + chosen + bad-gw).
  **Follow-up fix:** completion (`POST /portal/v1/payment_methods`) also takes `gateway_account` and vaults
  on the SAME gateway the setup ran on — without it, completion fell back to the business default and
  looked the `pm_…` up on the wrong Stripe account (silent add-card failure, then a re-confirm loop on a
  spent SetupIntent). The Stripe portal step now also recovers from `setup_intent_unexpected_state` by
  retrieving the already-succeeded intent instead of re-confirming.
- **2026-07-13** — Module created (P14 slice): portal_sessions (migration 0114),
  mint + resolve, `/portal/v1/*` surface, buyer pages, `verify:customer-portal`
  (20 checks) (`feat/billing-logiq`).
- **2026-07-13** — Buyer billing details: `/portal/v1/me` now returns address +
  `billing_details_complete`; new `PATCH /portal/v1/me` (name + billing address only). The portal
  add-card flow collects them first when missing (Indian-gateway export rule).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-21** — Buyer-managed billing address (frontend only; no engine change). `PATCH
  /portal/v1/me` had accepted a full address since 2026-07-13, but the only UI that posted it was the
  add-card gate — reachable solely while `billing_details_complete` was false, so the address became
  uneditable the moment it was first saved. The portal now has a **Billing details** section
  (`dashboard/app/(storefront)/portal/[token]/billing-details.tsx`): read view + `Edit`, auto-opened
  while the details are missing. The gate is now a pointer to it instead of a duplicate form, and both
  go through the one `portalUpdateMeAction`, so the required set (name + line1 + country) cannot
  diverge. The `BalanceCard` strip no longer reprints the full address — it summarises, the section
  owns it. ⚠️ `billing_details_complete` is still `name && addressLine1 && country`: **`state` is not
  required anywhere**, so this surfaces the field that decides CGST+SGST vs IGST without compelling it
  (INDIA-LAUNCH §4).
- **2026-08-22** — **The buyer stops typing their name twice.** The portal and hosted-checkout forms
  each asked for a required "Full name" (→ `customers.name`) directly above a contact block headed
  "Contact (shown on invoices)" (→ `billing_*`). Both were the buyer's name, and the heading was the
  lie: `customers.name` is our own invention, and the name printed on an invoice is the **billing
  address contact**. The "Full name" field is gone from both surfaces; the contact block is the
  name, with
  first name required there via `AddressFields`' new opt-in `requireContactName` (default false, so the
  operator forms are untouched) and a truthful heading passed by the buyer callers only.
  - `billing_details_complete` is now **`hasBillingName(customer) && addressLine1 && country`** in both
    `customer-portal-routes.ts` and `checkout-routes.ts` (was `Boolean(name && …)`). Any of the three
    chains satisfies it — address contact, account holder, legacy `name` — which it had to, since no
    buyer form writes `name` any more; the old gate would have declared every new buyer incomplete with
    no field left to fix it with. **(2026-08-23: `customers.name` is deprecated and the `name` arm is
    gone — the gate is address contact → account holder. A legacy-only row now fails it and is asked
    for a name, which is correct: the buyer has a form for first/last/company and none for `name`.)**
  - `PATCH /portal/v1/me` (⚠️ 2026-08-23: `name` removed from the body entirely) rejects an update that would leave the customer
    with **no usable billing name at all**. The check lives in the HANDLER, not the zod schema:
    `address` REPLACES the whole address, so whether a patch strips the last name depends on the row as
    much as the body, and a refinement cannot see the row. An address-only patch stays legal for a
    customer whose account-holder first/last is already set.
  - `/portal/v1/me` now also returns the account-holder columns (`first_name`, `last_name`, `company`).
    Without them the buyer surface's only customer-level name was `name`, so a customer with first/last
    set was greeted by email address.
  - Names on buyer surfaces are resolved by helper, never inline: `accountHolderName` for the person
    (magic-link greeting, page header, RazorPay `prefill.name` — greeting a buyer as "Accounts Payable"
    because that is who receives their invoices is worse than showing no name) and `invoiceContactName`
    for "Billed to" (the portal line and the PDF now cannot disagree). Engine helpers:
    `src/modules/customers/names.ts`; dashboard mirror: `dashboard/lib/names.ts`, which also absorbed
    `addressName` from `lib/api/invoices.ts` (re-exported under its old name so operator callers are
    unchanged).
  - ⚠️ Still true from the entry above: **`state` is not required anywhere**, so the field that decides
    CGST+SGST vs IGST is surfaced but not compelled (INDIA-LAUNCH §4).

- **2026-08-26 (security, W1)** — **The portal session token is no longer in the URL.** The link we
  mail is now `/portal/s/<token>`: an exchange route that moves the token into an `HttpOnly` cookie
  and 307s to a clean `/portal`. A URL path segment is not a private place (CWE-598) — it leaks through the `Referer` on every cross-origin subresource, browser
  history, proxy access logs, and any link a buyer forwards. The leak here was live rather than
  theoretical: the card step injects a gateway SDK from a third-party host, so the token travelled
  to RazorPay on the request that loads the payment form.
  The token now never reaches the browser at all — the server actions under
  `dashboard/app/(storefront)/portal/(session)/` read the cookie themselves instead of taking it as
  an argument or a hidden field, and `lib/pending-vault-setup.ts` is keyed on the customer's public
  id rather than the token. Reasoning, and the residual this does NOT fix (the emailed link is still
  a reusable bearer credential for 72h), are in `dashboard/lib/storefront-session.ts`.
  `POST /portal/v1/request_link` is also throttled now — per client address AND per RECIPIENT, since
  the harm of mail flooding lands on the inbox whoever asked for it. It still answers 200 either
  way: a 429 would tell a caller the address is being treated specially, which is exactly what the
  route's always-200 contract exists to deny.

- **2026-08-26 (security, 0193)** — **The portal link is a one-time ticket, not the session.**
  A portal session now holds TWO credentials: a `pstk_…` **entry** token that appears in the
  link and is good for ONE HOUR and ONE USE, and a `psst_…` **session** token minted by
  `POST /portal/v1/session` and held only in the buyer's HttpOnly cookie. A link left in an
  inbox, a chat log or a proxy access log is now worth nothing.
  - Single-use is enforced in the exchange UPDATE's own WHERE clause, not by a read-then-write:
    a double-click would otherwise pass an existence check twice and mint two sessions.
  - Every failure — expired, spent, revoked, unknown, malformed — answers ONE 401. The route is
    unauthenticated, so distinguishing them would be a free oracle for testing guessed tokens.
  - `status`, `login_at`/`login_ip` and `logout_at`/`logout_ip` are recorded. This answers the
    support question their `retrieve` answers and ours could not: was this link ever opened.
  - `POST /portal/v1/logout` added, and it CLEARS `token_hash` rather than only setting a status
    — a cookie kept after logout must authenticate nothing without depending on every future
    reader remembering to check a flag.
  - ⚠️ **Fixed here, broken by the W1 commit**: the operator mint route built its `url` inline and
    still returned `/portal/<token>`, which is a 404 after the storefront route move. The
    magic-link path had been updated and this one had not — the same value composed in two places.
  - The dormant self-serve magic link must NOT be promoted while the entry token is single-use:
    mail scanners prefetch links and would spend them before the human clicks. The emailed case
    needs a one-time PASSWORD the customer types, which cannot be prefetched. See the warning
    on `requestPortalMagicLink`.

- **2026-08-27** — `POST /v1/businesses/{biz}/customers/{cus}/portal_sessions` accepts an optional
  **`link_kind: 'api' | 'email'`**. `api` stays the default and stays one hour — right for the shape
  the route was built for, where an integration mints a link and immediately redirects a user who is
  already looking at a screen. `email` buys the same **five days** `emails/outbox.ts` already gives
  tmbilling's own mail, and exists because an hour is simply wrong for a link that goes into a message
  a human reads later: payment-failure or card-expiry mail that embeds an API-minted link would
  send every recipient who did not open their mail within the hour to a dead one. Callers should read
  `access_expires_at` rather than assume either window — that is why it is returned, and
  a "you have N days" line in those emails should be derived from it.
  ⚠ This widens the window only. The entry credential is still spent by the first GET of
  `/portal/s/<token>`, and mail clients and security scanners PREFETCH links — so an emailed link can
  arrive already burned. That hazard applies to every emailed link tmbilling sends today (see the
  argument in `dashboard/lib/storefront-session.ts`, which reasons about API links specifically); it
  is not made worse here and is not addressed here.

- **2026-08-27** — **`GET /portal/v1/subscriptions`**: the portal had no subscription data at all, so a
  customer who had just signed up opened it to "You're all paid up" over "No invoices yet" and could
  not see their plan, their add-ons, the amount or the date — the two facts a billing portal exists to
  state. Per subscription: items (from each item's FROZEN `price_snapshot`, so a differential add-on
  shows its real rate rather than the catalog's 0), the pre-tax recurring subtotal, term/trial dates,
  and `next_payment` — `estimateRenewal`'s tax-inclusive total, its date and its GST split, i.e. the
  figures the invoice itself will carry.
  * `next_payment` is **null** when there will not be one (cancelling, cycle cap spent).
    `estimateRenewal` returns null in exactly those cases, so the absence is the engine's answer rather
    than a second rule here, and the page says "This plan will not renew" instead of inventing a date.
  * `mandate_shortfall` rides along on that same estimate. It was declined as its own portal feature on
    cost — a whole invoice plan per page load to catch a rare state — and the cost disappeared once the
    estimate was being loaded anyway for the panel above it.
  * Capped at the 10 newest subscriptions per page load (each one plans an invoice); anything dropped is
    logged rather than silently missing.

- **2026-08-31** — **The buyer could name the card that pays FIRST, and nothing else.**
  The portal had `POST /portal/v1/payment_methods/:pm/default` and no way to designate a
  **backup** — the instrument collection falls back to before dunning begins. So the
  second slot was operator-only and invisible: the list rendered `is_default` and threw
  `role` away, even though `serializePaymentMethods` has always sent it and
  `portal-api.ts` has always typed it. Both roles belong to the customer in their own
  portal — and it was the buyer, who owns the cards, who could not act.
  New `POST /portal/v1/payment_methods/:pm/role`, mirroring the operator route.
  `/default` stays: it is the older shape, an un-updated client must not break, and it is
  exactly `role: 'primary'` — the sugar `setDefaultPaymentMethod` has always been.
  ⚠️ `none` is deliberately REFUSED here, unlike the operator route. Unassigning leaves
  an account with no primary, which is worth being able to create deliberately from the
  back office and has no buyer-facing reason to exist — a buyer wanting a different card
  first says so by naming that card. Asserted (400) in `verify:customer-portal`.
  The control is hidden on the default and on the current backup (assigning a card the
  role it already holds does nothing) and with one method on file, since two are needed
  before either role means anything.
- **2026-09-30** — Mint takes `redirect_url` (logout destination, returned by `/portal/v1/logout`) and `forward_url` (one of `PORTAL_FORWARD_PATHS`, returned by the exchange) — 0319 columns. `getPortalSession` + `GET …/portal_sessions/:id` (no credential). Buyer cancel takes `end_of_term` (must match the business's `cancel_timing`, else 400), and `reason_code` (must be an offered cancellation reason).
- **2026-10-09 (0334)** — `PATCH /portal/v1/me` follows `businesses.portal_field_config` (show/hide/mandatory/read_only; defaults = the old form: first name, phone, line1, city, state_code, postal_code, country). Hidden and read-only keys keep the stored value (`mergePortalAddress`); state + state_code are one region, kept only when both are locked, and a new code without a name gets the name from the code. line1/country are no longer hard-required by zod. `/portal/v1/me` carries `field_config` (effective, tax locks applied) and `address_field_locks`; `billing_details_complete` counts line1/country only where the config requires them.
- **2026-10-23** — `canCancelAtGateway` moved to `dashboard/app/(storefront)/portal/(session)/gateway-cancel.ts` (no `"use client"`). The server-rendered portal called it from the client module `pay-now-instead.tsx`, which React refuses at runtime: every buyer with an owed invoice awaiting bank approval got a server error page.
- **2026-10-25** — `GET /portal/v1/subscriptions/:sub/usage`: usage so far on the buyer's own subscription (`currentUsage`, no ids or minimum). One 404 for another customer's subscription, an unknown id, or `storefront_config.portal_show_usage = false` (default true). The projection follows `portal_show_usage_projection` (default false); no query parameter turns it on. The list adds `has_metered_items`; it computes no usage. The portal page loads usage per metered subscription inside Suspense.
- **2026-11-03** — The plan-change quote (`QUOTE_TTL_MS`, `quotedInstant`, `quoteOf`, the 409 text)
  moved to `subscriptions/price-quote.ts`, shared with `POST …/change`. Same hash, same rule.
- **2026-11-03 (security)** — Four fixes from the pre-release audit.
  - Plan change: the direction (upgrade or downgrade) comes from `directionOfItemEdit`, the
    engine's rating that the API and checkout use. A tiered, volume, snapshot or differential
    price counted as 0 before, so a customer could pass the upgrade gate or get the downgrade
    timing and proration on a dearer plan.
  - Retention: `acceptRetentionOffer` holds a per-customer advisory lock (namespace 7406) across
    the check, the action and the record, so parallel requests cannot take two offers when
    `retention_offer_once` is on. The discount answer carries `summary`, never the coupon code.
  - Sign-in code: a try is claimed (`attempts < 5`, atomic) before the compare and given back on a
    right code, so parallel guesses cannot share one count. The per-email request limit runs after
    the bot check, so requests without a token cannot use up a customer's hourly quota.
  Gates: `verify:portal-plan-changes`, `verify:portal-retention`, `verify:portal-access`.
- **2026-11-03 (0495)** — The portal coupon cap is `businesses.max_customer_coupon_codes` and counts codes the customer entered (under a subscription row lock). At 1 it keeps the one-discount rule (operator discounts block the box); above 1 buyer codes stack up to the cap. The list returns `discounts[]` and `coupon_codes_left`; `DELETE …/coupon?code=` removes one named code. Gate: `verify:customer-portal` (0495 block).
