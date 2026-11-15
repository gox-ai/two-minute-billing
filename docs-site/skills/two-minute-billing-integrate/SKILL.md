---
name: two-minute-billing-integrate
description: Wire Two Minute Billing into an application's code — map app accounts or orders to billing customers, add hosted checkout for subscriptions and one-time purchases, customer-portal routes, a signed and deduplicated webhook handler, and feature gating with entitlement checks. Framework guides for Next.js, Express, Fastify, Hono, NestJS, FastAPI, Django, Rails, Laravel and Go. Use when connecting an app's sign-up, upgrade, buy button, billing page, webhooks or plan-based feature access to Two Minute Billing.
license: MIT
metadata:
  homepage: https://twominutebilling.com
  docs: https://twominutebilling.com/help/developers
---

# Wire billing into the app

The `two-minute-billing` skill's rules hold here: test key only, keys never in the chat, and
`preflight.mjs` before the first write. The catalog comes first (`two-minute-billing-pricing`).

Read the guide for the app's framework before writing code:
`references/frameworks/<nextjs|express|fastify|hono|nestjs|fastapi|django|rails|laravel|go>.md`.
Shared code and the reasons behind it: `references/patterns.md`. For another stack, follow
`patterns.md` with the language's HTTP client.

## What to build

| Piece | Route or module | Done when |
|---|---|---|
| Client | `billing/client` (server only) | `preflight.mjs` passes with the same env |
| Account ↔ customer link | a column on the account | `cus_…` and `sub_…` ids are stored after checkout |
| Subscribe | `POST /billing/subscribe` → checkout session → 303 | Test card `4242 4242 4242 4242` subscribes |
| Buy once (one-time sales) | `POST /billing/buy` → checkout session, `mode: "purchase"` → 303 | The test card pays; the order is marked paid |
| Manage billing | `POST /billing/manage` → portal session → 303 | The portal opens for the signed-in account |
| Webhooks | `POST /webhooks/billing` | `webhook-check.mjs` passes (verify skill) |
| Feature gate | `entitled(sub, key, required?)` | A Starter account is refused a Pro feature |

A store that only sells one-time items (orders, credit packs, downloads) builds Client, Buy once,
Webhooks and, if buyers keep a history, Manage billing. See "One-time purchases" below.

## Link accounts to customers

Pick one and write the choice in a code comment:

- **Checkout creates the customer** (simplest). Send the app's account id in checkout `metadata`
  (`{ app_account_id }`); it lands on the subscription. On `subscription_created`, fetch the
  subscription by the id in the event and read the account id, customer and status from it. Store
  the customer and subscription ids then.
- **The app creates the customer first** — needed for usage billing, where events name the
  customer before any purchase. Create it at sign-up (`tmb.customers.create`), store `cus_…`, and
  add the account id as its usage key (`tmb.usageKeys.add`). To subscribe it through hosted
  checkout, create the session with `mode: "create"` and `customer_id: "cus_…"`: the subscription
  goes to that customer, and the page fills in their billing details. To subscribe it with no
  buyer present (a free plan at sign-up), call `POST /v1/businesses/{biz}/customers/{cus}/subscriptions`
  with `metadata: { app_account_id }`, which lands on the subscription as checkout metadata does.
  A customer with no card is refused (400 `no_chargeable_payment_method`) only when the first
  invoice has an amount due: a USD 0 plan needs no card. Later upgrades use
  checkout `mode: "change"`.

Never key anything on the customer's email: it changes.

A store with guest checkout (no accounts) links **orders**, not accounts: see "One-time purchases".

## Checkout and portal

- Create the session on the server when the user clicks, then redirect (303) to its `url`.
  An API on another origin than the page (a separate frontend calling it with fetch or axios)
  returns `{ url }` as JSON instead, and the page calls `window.location.assign(url)`: fetch and
  axios follow a 303 silently, so the browser never leaves the page.
- Create links per click. Never store, email or log them. A checkout link stays valid until its
  `expires_at` (24 hours by default); a portal link opens **once**, within one hour, so a mail
  scanner that opens it spends it.
- Allow-list the price ids the app offers; never pass a price from the request through unchecked.
- The return page shows "processing" until the webhook arrives. It must not grant access itself.
- A plan change with the buyer present: checkout `mode: "change"` with `subscription`. With no buyer
  present: change the subscription through the API, and preview it first with
  `POST /v1/businesses/{biz}/subscriptions/{sub}/estimate` (a dry run; it changes nothing) so the
  user sees the charge. The estimate takes `changes`, `adds` and `removes` (each item's id and new
  price), not the whole `items` list that checkout and `update_for_items` take.

## One-time purchases

For orders, credit packs and anything else paid once. Prices are `type: "one_time"` on products of
kind `charge` (pricing skill). Recipe: https://twominutebilling.com/help/developers/recipes/one-time-purchases.md

1. Create the order in the app first (status pending). If the app records an order only after
   payment, add a table for pending orders and keep the app's fulfilment code: call it when the
   order is paid. Then create the checkout session with
   `mode: "purchase"`, the order's price ids in `items`, and `metadata: { order_id }`. The
   metadata is stored on the invoice the purchase raises. `pass_thru_content` is also returned on
   the session, but only the metadata reaches the invoice.
2. A guest buyer needs no customer up front: the checkout creates one from the email the buyer
   types. For a signed-in buyer who already has a customer, pass `customer_id` (`cus_…`) instead.
3. Coupons: pass the app's codes in `coupons: [...]`, or let the buyer type one on the hosted page,
   which shows a code box only when the business's `allow_customer_coupons` is `true` (see
   below). The coupons themselves go in `coupons` of `billing.catalog.json` (pricing skill).
   Each coupon applies once. An unknown code
   fails the call with 404, one that cannot be used now with 400; show the user why. Do not keep a second coupon system
   for the same sale.
4. Mark the order paid from the webhook: on `invoice_paid`, fetch the invoice by id and read
   `metadata.order_id`. Check `status === "paid"` on the fetched invoice before fulfilling.
5. **A 100%-off purchase** completes with no payment step: its invoice is `paid` with total 0.
   Whether `invoice_paid` fires for a 0 invoice is the business setting
   `billing_rules_config.zero_invoice_paid_event`: `never`, `one_off` (one-time invoices, which
   includes every purchase) or `all`. Unset means `never`. Read it with
   `GET /v1/businesses/{biz}`. A store with 100%-off codes needs `one_off` or `all`, so the
   webhook fulfils free orders too. After the user's yes, set it (and the coupon box) in
   `settings` of `billing.catalog.json` and run the pricing skill's `catalog.mjs`, not a PATCH
   by hand, so the setting is in the repository with the catalog:

   ```json
   "settings": {
     "allow_customer_coupons": true,
     "billing_rules_config": { "zero_invoice_paid_event": "one_off" }
   }
   ```

   The return page also reads the session (`GET …/checkout_sessions/{id}` → `resulting_invoice`)
   and then that invoice, and fulfils when the invoice is `paid`. Fulfilment must be idempotent:
   the page and the webhook can both get there.
6. Tax: the price's `tax_behavior` says whether tax is added or included. Tax is only charged where
   the business has a tax region and registration (pricing skill, "Tax").
7. **Refund a purchase** only after the user's yes for that refund. Fetch the invoice
   (`GET /v1/businesses/{biz}/invoices/{inv}`); each `linked_payments[]` entry with
   `type: "payment"` and `status: "succeeded"` names its `payment` (`pay_…`). Refund that id:
   `POST /v1/businesses/{biz}/payments/{pay}/refund` with `{ "amount_minor": … }` (omit it for the
   full amount). The entry's own `id` is a transaction (`txn_…`); the refund route answers 404
   for it. A refund sends `refund_created` and `credit_note_created`; ask the user whether a
   refunded order loses what it bought, and handle those events if it does.

## Webhooks

The webhook is the source of truth for what a customer has.

1. Verify `Tmbilling-Signature: sha256=<hex>`: HMAC-SHA256 of the **raw** body with the endpoint's
   secret, compared in constant time. Answer `401`, with no detail, on failure.
2. Deduplicate on `Tmbilling-Event-Id` with a unique key in the app's database. A repeat answers 2xx.
3. Answer 2xx fast; do slow work in the app's job queue.
4. Handle at least `subscription_created`, `subscription_changed`, `subscription_canceled` (one
   "l"), `invoice_paid`, `payment_failed` (a one-time store: `invoice_paid`, `payment_failed`).
   An event's `content` is a short summary — the resource's id and status, plus a few fields such
   as `amount_minor` — not the whole object. Fetch the resource by id for anything else. Events can
   arrive out of order: compare `occurred_at` before overwriting newer state.

   An app that changes plans also handles the change that waits for payment ("Errors and
   retries"). Each event's `content.pending_change` has `id`, `invoice` and `expires_at`:
   - `subscription_pending_change_created`: show "Your change waits for payment" with a way to
     pay, until `expires_at`. Do not grant the new plan.
   - `subscription_pending_change_applied`: the change is in place. `subscription_changed` also
     comes; sync the plan from the fetched subscription and remove the notice.
   - `subscription_pending_change_expired`: nothing changed, and its invoice is voided. Remove the
     notice. `pending_change.reason` is `expired`, `replaced` (a newer change), `cancelled`,
     `voided` or `moved` (the subscription changed first; a payment made goes back as credit).
5. Register the endpoint after the user says yes, with the script that keeps the signing secret
   out of the chat. It is returned once; the script writes it to the env file and never prints it:

   ```bash
   node --env-file=<env file> <this skill>/scripts/register-webhook.mjs \
     --url https://<public host>/webhooks/billing --business biz_… \
     --events subscription_created,subscription_changed,subscription_canceled,invoice_paid,payment_failed \
     --env-file-out <env file>
   ```

   A plan-changing app adds `subscription_pending_change_created`,
   `subscription_pending_change_applied` and `subscription_pending_change_expired` to `--events`.
   `tmb listen` forwards every event unless it gets `--events`, so the handler can work locally
   and still miss events on a deployed endpoint whose list leaves them out. With no `--events`,
   the endpoint gets every event. Unknown event types fail with 400. Do not call `POST /v1/webhook_endpoints` yourself: its
   response holds the secret. If the env file is not writable, give `--env-file-out` a separate
   untracked file (git-ignored), and load both files: the app with both, scripts with two
   `--env-file` flags.

Local development needs no tunnel to test the handler: `webhook-check.mjs` in
`two-minute-billing-verify` signs events and posts them to the local route. Deliveries from the
engine itself need a public URL; ask the user which tunnel they use, if any.

## Feature gating

Ask at the point of the action, and gate on the feature key, never on the plan id:

`GET /v1/businesses/{biz}/subscriptions/{sub}/entitlements/{key}/check?required=N`
→ `{ entitled, reason, value, used }`.

For menus and badges, read `GET …/subscriptions/{sub}/entitlements` once per session and cache it.
When the check cannot be reached, fail closed for paid features, and say so in the code.

## Errors and retries

A subscription created by API while the buyer is on the app's own page sends `on_session: true`.
A card that needs 3-D Secure then answers `402` `requires_action` with `payment_intent` and
`next_action`; the buyer completes `next_action`, and the app sends the same create again with
`payment_intent`. Without `on_session` the challenge is a refusal (a server-to-server signup).

**A plan change can answer `402` and change nothing.** With the business setting
`billing_rules_config.failed_change_charge: apply_when_paid` (a new business has it), a change,
`update_for_items` or `POST …/items` whose invoice is not paid at once is held. The `402` has
`error.type: "payment_error"`, `error.code` `payment_failed` (or `requires_action`), and
`pending_change: { id, invoice, expires_at, payment_in_progress }` (in the SDK: `err.body`). The
subscription stays on its old plan, and `GET …/subscriptions/{sub}` shows `pending_change`.
Do not grant the new plan. Tell the buyer that the plan did not change yet and that they must pay
before `expires_at` (in their timezone). Then give them a way to pay that same invoice:

- after they add a working card, send the same request again: it collects that invoice, never a
  second one;
- a portal session, where **Pay** on the invoice completes the change;
- a checkout `mode: "change"` with the same items: the page shows the change that waits and its
  amount.

`payment_in_progress: true` means a slow payment is still running: say the plan changes when it
completes. `requires_action` with `on_session: true` carries `payment_intent` and `next_action`:
complete it, then `POST …/invoices/{inv}/collect` with the `payment_intent`. Unpaid at
`expires_at`, the change expires and its invoice is voided. Other values of the setting:
`revert` (a hard decline undoes the change, `402` with no `pending_change`), `start_dunning` (the
default when unset) and `next_renewal` (the change applies at once and the invoice is retried).
Recipe: https://twominutebilling.com/help/developers/recipes/plan-changes.md

The SDK throws `TmbillingError` (`status`, `type`, `message`, `body`). Retry `rate_limit_error` and
network failures with the **same** idempotency key (`{ idempotencyKey }` on SDK writes). Never
retry `invalid_request_error`. A test key asking for a live business gets `404`, by design.

Next: `two-minute-billing-usage` if anything is metered, else `two-minute-billing-verify`.
