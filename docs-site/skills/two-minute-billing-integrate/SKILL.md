---
name: two-minute-billing-integrate
description: Wire Two Minute Billing into an application's code — map app accounts or orders to billing customers, add hosted checkout for subscriptions and one-time purchases, customer-portal routes, a signed and deduplicated webhook handler tested locally with tmb listen, feature gating with entitlement checks, and the subscription lifecycle from the app (cancel, pause, resume, reactivate, seat changes, one-off charges, refunds). Framework guides for Next.js, Express, Fastify, Hono, NestJS, FastAPI, Django, Rails, Laravel and Go. Use when connecting an app's sign-up, upgrade, buy button, billing page, cancel or seat flows, webhooks or plan-based feature access to Two Minute Billing.
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
| Webhooks | `POST /webhooks/billing` | Every line of `tmb listen` shows a 2xx for the events `tmb trigger` causes, and `webhook-check.mjs` passes (verify skill) |
| Feature gate | `entitled(sub, key, required?)` | A Starter account is refused a Pro feature |
| Cancel, pause, resume (if the app offers them) | the portal, or the app's own routes | A cancel at term end shows "Ends on …"; undoing it removes the notice |
| Seats (per-seat plans only) | on seat add or remove | The quantity changes and the charge matches the estimate shown |

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

   An app that gives or takes away access also handles the events in "Events that change access"
   below.
5. **Test on the local machine first. No tunnel and no registered endpoint are necessary.** While
   the app runs, start `tmb listen`. It does not stop by itself: run it in the background, or ask
   the user to run it in their own terminal.

   ```bash
   npx @two-minute-billing/cli listen --forward http://localhost:<port>/webhooks/billing \
     --env-file <env file>
   ```

   It reads `TMBILLING_URL`, `TMBILLING_API_KEY`, `TMBILLING_BUSINESS_ID` and
   `TMBILLING_WEBHOOK_SECRET` (from the environment, else `--env-file`, else `./.env`), refuses a
   key that is not a test key, and never prints a key or the secret. It does not start when
   `TMBILLING_WEBHOOK_SECRET` is not set: until an endpoint is registered, the user sets it to any
   value in the env file, and the app and `listen` both read it. Every two seconds it sends each
   new event of the business to the loopback URL with the body, `Tmbilling-Signature` and
   `Tmbilling-Event-Id` that an endpoint gets, and prints one line per event with the app's status.
   `--since 10m` also sends the last ten minutes of events; `--events a,b` sends only those types.

   Then cause real events in another terminal:

   ```bash
   npx @two-minute-billing/cli trigger purchase --env-file <env file>        # invoice_paid, payment_succeeded
   npx @two-minute-billing/cli trigger payment-failed --env-file <env file>  # payment_failed
   npx @two-minute-billing/cli trigger subscription --env-file <env file>    # subscription_created
   ```

   Each makes a new test customer (`trigger+…@example.com`) with a test card and uses the first
   active price of the correct type (or `--price`); it stops when the business has none. That
   customer is linked to no app account and its subscription has no `app_account_id`: the handler
   must answer 2xx and skip it, not fail. Done when every `listen` line shows `→ 2xx`.
6. **Register a public endpoint when the app is deployed**, or to test the engine's own delivery
   (its retries and the `/deliveries` log), which needs a URL the engine can reach: a tunnel or a
   deployed test environment. Ask the user which. Register it after the user says yes, with the
   script that keeps the signing secret out of the chat. It is returned once; the script writes
   it to the env file and never prints it:

   ```bash
   node --env-file=<env file> <this skill>/scripts/register-webhook.mjs \
     --url https://<public host>/webhooks/billing --business biz_… \
     --events subscription_created,subscription_changed,subscription_canceled,invoice_paid,payment_failed \
     --env-file-out <env file>
   ```

   Add to `--events` every type the handler handles: the pending-change trio for a plan-changing
   app, and the events of "Events that change access". `tmb listen` forwards every event unless
   it gets `--events`, so the handler can work locally and still miss events on a deployed
   endpoint whose list leaves them out. With no `--events`, the endpoint gets every event. Unknown
   event types fail with 400. Do not call `POST /v1/webhook_endpoints` yourself: its response
   holds the secret. If the env file is not writable, give `--env-file-out` a separate untracked
   file (git-ignored), and load both files: the app with both, scripts with two `--env-file`
   flags. The registered secret replaces the local value: restart the app and `listen` to read it.

`webhook-check.mjs` in `two-minute-billing-verify` proves the signature check and the dedupe with
a sample event posted to the running app's route, with no engine events needed.

### Events that change access

Grant and remove access on these, never on the return page. Fetch the subscription by
`content.subscription.id` and sync from it, as for `subscription_changed`. API status values:
`future`, `in_trial`, `active`, `non_renewing`, `paused`, `cancelled`.

| Event | Fires when | The app |
|---|---|---|
| `subscription_activated` | The subscription becomes `active`: at creation with no trial, at a future start date, or when a trial converts | Grants the paid plan |
| `subscription_trial_ending` | `reminder_config.trial_ending` days before the trial ends (default 3); `content.subscription.trial_end`, `lead_days` | May show a notice; access does not change |
| `subscription_cancel_scheduled` | A cancel with `cancel_option: end_of_term`. Status `non_renewing` | Keeps access; shows "Ends on" + the fetched `canceled_at`. A `specific_date` cancel sends `subscription_change_scheduled` (`change_type: "cancel"`) instead, with the same `canceled_at` |
| `subscription_scheduled_cancellation_removed`, `subscription_reactivated` | A pending cancel is undone; `subscription_reactivated` also when a cancelled subscription restarts | Removes the notice; grants access again |
| `subscription_canceled` | The subscription ends: an immediate cancel, the date of a scheduled one, or the dunning final action | Removes access |
| `subscription_paused` | A pause takes effect (now or on its date), a trial that ends paused, or the dunning final action `pause` | Removes or limits access |
| `subscription_resumed` | A paused subscription resumes (now or on its date) | Grants access again |
| `invoice_dunning_exhausted`, `invoice_not_paid` | Retries ran out unpaid (`invoice_not_paid` also when an invoice the customer pays themselves passes its due date) | Shows "Pay now" (portal `action: "pay_invoice"`). Does not remove access itself: the business's `dunning_config.final_action.subscription` (`cancel` by default; or `cancel_at_term_end`, `pause`, `stop_charging`, `retain`) sends its own subscription event |
| `payment_source_expiring` | Once per card, when it enters its printed expiry month. `content.payment_source` has `customer`, `brand`, `last4` | Asks for a new card: a portal session with `action: "update_card"` |

Do not remove access on `payment_failed`: dunning retries first. Recipe:
https://twominutebilling.com/help/developers/recipes/failed-payments.md

### Catch up on missed events

After downtime, or as a nightly job, read the events the handler may have missed and run each
through the same handler code, deduplicated on the event `id` exactly as on
`Tmbilling-Event-Id`:

`GET /v1/businesses/{biz}/events?occurred_after=<ISO time>&sort_by[asc]=occurred_at&limit=100`

Filters: `type` (repeat it for several types), `resource_type`, `resource_id`, `occurred_after`,
`occurred_before`. The default order is newest first. Page with `starting_after=<next_cursor>`
while `has_more` is true. Each event has `id`, `event_type`, `occurred_at` and `content`, the same
as a delivery. Skip events with `imported: true` (history from a migration).
`GET /v1/events/{evt}` returns one event with its `webhook_deliveries` (status, attempts, last
response), to see why a delivery failed.

## Feature gating

Ask at the point of the action, and gate on the feature key, never on the plan id:

`GET /v1/businesses/{biz}/subscriptions/{sub}/entitlements/{key}/check?required=N`
→ `{ entitled, reason, value, used }`.

For menus and badges, read `GET …/subscriptions/{sub}/entitlements` once per session and cache it.
When the check cannot be reached, fail closed for paid features, and say so in the code.

## Cancel, pause, resume, reactivate

**First, see if the portal can do it.** "Manage billing" then needs no new code. Each portal task
is a business setting in `storefront_config` (dashboard: Settings → Checkout and Settings → Customer portal). Read them with
`GET /v1/businesses/{biz}`; ask the user before changing one.

| Buyer task in the portal | Setting (default) |
|---|---|
| Cards, invoices (pay, download), billing details | always on (`allow_invoice_payment`, `allow_invoice_download`: `true`) |
| Cancel | `allow_cancel_subscription` (`false`); takes effect at `cancel_timing` (`end_of_term`) |
| Pause and resume | `allow_pause_resume` (`false`) |
| Undo a pending cancel | `allow_reactivate` (`false`) |
| Restart an ended subscription (through a checkout that charges first) | `allow_restart` (`false`) |
| Change plan, seats, add-ons | `allow_plan_changes` (`false`), `seat_changes` (`off`, `increase`, `both`), `allow_addon_changes` (`false`) |

To open the portal on one task, create the portal session with `action` (`cancel_subscription`,
`change_plan`, `pay_invoice`, `update_card`) and `object` (the `sub_…` or `inv_…`). A task the
business turned off opens the portal home.

**From the app's own screen**, all `POST /v1/businesses/{biz}/subscriptions/{sub}/<call>`, each
write with an `Idempotency-Key`. Preview first and show the result; sync state from the events
("Events that change access"), not from the response alone.

| Call | Body | Notes |
|---|---|---|
| `cancel_estimate` | the `cancel` options; `{}` = the business defaults | Writes nothing. `net_collect_minor`, `net_refund_minor`, `net_credit_minor`, `warnings` |
| `cancel` | `cancel_option`: `end_of_term`, `immediately` or `specific_date` + `cancel_at` | **Always send `cancel_option`**: omitted, it is the business `default_cancel_option`, else `immediately`. `end_of_term` on a paused subscription is 400. Money options in "Refunds and credit notes". A business can require `cancel_reason_code` (400 without). `warnings` in a 200 = a side effect that did not complete; the cancel stands |
| `reactivate` | `{}` | Undoes a pending cancel (`remove_scheduled_cancellation` also does, for an `active` one) |
| `reactivate_estimate`, then `reactivate` | `items: [{ price, quantity }]` (required on the estimate) | Restarts a `cancelled` subscription. `{}` restarts it on its items. The new term is invoiced and collected unless `trial_end` or `charges_handling: "add_to_unbilled_charges"`. With `on_charge_failure: "refuse"`, a failed charge answers 402 and it stays cancelled. Buyer present: `payment_initiator: "customer"` |
| `pause` | `pause_option`: `immediately`, `end_of_term`, `specific_date` + `pause_date`, or `billing_cycles` + `skip_billing_cycles`; optional `resume_date` | Omitted options use the business `pause_config`; a locked option is 400. Not for a `cancelled`, `paused` or `future` subscription. Nothing is billed while paused |
| `resume` | `resume_option`: `immediately` or `specific_date` + `resume_date` | Inside the paid term, nothing is charged. After it ended, a new term starts and is billed: `charges_handling` `invoice_immediately` or `add_to_unbilled_charges` (omitted: `pause_config.charges_on_resume`) |

## Seats

For a per-seat (`per_unit`) plan, the seat count is the item's `quantity`. When the app adds or
removes a seat:

1. Fetch the subscription; take the per-seat item's `id` (`si_…`) from `items`.
2. Preview: `POST …/subscriptions/{sub}/estimate` with
   `{ "changes": [{ "item": "si_…", "quantity": 6 }] }`. Show the amount. Keep its `quote` and
   `priced_at`.
3. Apply: `POST …/subscriptions/{sub}/change` with the same `changes`, plus the estimate's
   `quote` and `priced_at` (409 with `param: "quote"` when the amounts moved: preview again), and
   `invoice_immediately: true` to charge now. Omitted, it is the business
   `default_invoice_immediately` (off by default): the prorated charge waits as an unbilled
   charge on the next renewal invoice.

Business rules, unless the call sends its own value: a seat add is an upgrade, a removal a
downgrade. `prorate` follows `billing_rules_config.upgrade_proration` / `downgrade_proration`
(unset: prorated, from the start of the current billing day); `timing` follows `upgrade_timing` /
`downgrade_timing` (unset: `now`); a removal's credit follows `downgrade_credit`. With
`upgrade_gate: "invoices_paid"`, an add is refused with 409 `invoices_unpaid` while the customer
has an unpaid invoice. A
seat add that charges now can answer 402 under `apply_when_paid`: see "Errors and retries".
`update_for_items` with the desired `items: [{ price, quantity }]` is the same change without
item ids.

## One-off charges on a subscription

A setup fee or an extra: `POST …/subscriptions/{sub}/charges` with
`{ "description": "…", "amount_minor": 5000, "invoice_now": true }`, or a one-time catalog price
instead: `{ "price": "…", "quantity": 1 }` (same currency as the subscription). Several lines on
one invoice: `{ "charges": [ … ], "invoice_now": true }`.

- `invoice_now: true` raises and collects an invoice now (`invoice` in the 201).
- `invoice_now` omitted or `false` queues a `pending` unbilled charge, billed on the next renewal
  invoice. List them with `GET …/subscriptions/{sub}/unbilled_charges`. Bill them now with
  `POST /v1/businesses/{biz}/unbilled_charges/invoice_now` `{ "subscription": "sub_…" }` (or
  `customer`); preview with `…/unbilled_charges/invoice_now_estimate` and the same body. Delete a
  pending one with `DELETE /v1/businesses/{biz}/unbilled_charges/{id}` (409 once billed).

## Customer details

Keep the customer's billing details in step when the account's own settings change them:
`PATCH /v1/businesses/{biz}/customers/{cus}` with any of `email`, `first_name`, `last_name`,
`company`, `phone`, `address` (`line1`, `line2`, `line3`, `city`, `state`, `state_code`,
`postal_code`, `country` as 2 letters), `tax_registration_number` (the buyer's GSTIN),
`vat_number` (an EU VAT number), `tax_exempt`. Tax is worked out from `address.country` and
`address.state_code` (place of supply), and a B2B invoice prints the buyer's tax ID, so update
them before the next invoice. **`address` replaces the whole address**: send every line, not
only the changed one. A change sends `customer_updated`; a change to the address, `vat_number`,
`tax_exempt` or `company` also sends `customer_billing_info_updated`. Recipe:
https://twominutebilling.com/help/developers/recipes/india-gst-invoices.md

Do not ask for these twice. Hosted checkout already collects name, email, phone, company, tax
registration number and the billing address (line 1, city, state, postal code and country are
mandatory by default; `checkout_field_config` sets each one), and the portal's details page lets
the buyer change them (`portal_field_config`). To prefill checkout, send `customer.email`,
`customer.tax_registration_number` and `billing_address` on the session (`mode: "create"`
without `customer_id`).

## Refunds and credit notes

Every refund needs the user's yes for that refund.

- **On cancel** (`cancel_option: "immediately"`, or carried to a `specific_date`):
  `credit_option_for_current_term_charges` `none`, `prorate` (the unused time) or `full` issues a
  credit note (`credit_note` in the response). `refundable_credits_handling: "schedule_refund"`
  then refunds **every** refundable credit note the customer holds, not only this
  subscription's. `unbilled_charges_option` is `invoice` or `delete`;
  `account_receivables_handling` is `no_action`, `schedule_payment_collection`, `write_off` or
  `void` (open invoices). Omitted options use the business cancel defaults. Read
  `net_refund_minor` from `cancel_estimate` first.
- **A credit note later**: `POST /v1/businesses/{biz}/credit_notes/{cn}/refund` with
  `{ "amount_minor": … }` (omit for all that is available).
- **A subscription invoice's payment**: as for a purchase (step 7 of "One-time purchases"), take
  the `pay_…` from the invoice's `linked_payments[]` and
  `POST /v1/businesses/{biz}/payments/{pay}/refund`. A refund does not change the subscription:
  cancel it too if access must end.

Each refund sends `refund_created`; each credit note `credit_note_created`.

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

## Emails the engine sends

The engine emails the business's customers itself: invoices (`invoice_issued`,
`invoice_overdue`), receipts (`payment_receipt`), `payment_failed`, refunds and credit notes, the
subscription lifecycle (activated, changed, renewed, paused, resumed, canceled), the trial
(started, ending, expired), card expiry, and renewal and cancellation reminders. **Do not build
the app's own receipt, invoice, payment-failed or renewal emails.** The app sends only what is
about its product ("your workspace is now read-only").

- All automatic email is off until the business turns it on: dashboard Settings → Email
  notifications, or `email_config.enabled` on `PATCH /v1/businesses/{biz}`. Then every type is on
  except `checkout_reminder`, `spend_limit_reached` and `subscription_reactivated`, which need
  `email_config.types.<type>: true`. `types.<type>: false` turns one off.
- Read `GET /v1/businesses/{biz}` → `email_config` before writing any billing email. If it is off,
  ask the user to turn it on; do not build a copy.
- One customer opts out with `email_notifications: false` on the customer.
- The links in those emails open the hosted portal. To send them to the app's billing page
  instead, the business sets `email_config.linkTarget: "merchant_url"` and `merchantUrl`.

## Payment links

`POST /v1/businesses/{biz}/payment_links` with `name` and `items` (`price`, `quantity`, optional
`min_quantity`, `max_quantity`, `optional`) returns a reusable public `url`; each visit opens a new
checkout. A recurring price makes a subscription (exactly one plan); one-time prices only make a
purchase. Items cannot change: create a new link. Archive with `PATCH …/payment_links/{plink}`
`{ "active": false }`. A link carries no `metadata`, so the webhook cannot tie its buyer to an app
account or order. Use links for sales-led deals and links sent by hand, not for the app's own
sign-up or buy buttons.

Next: `two-minute-billing-usage` if anything is metered, else `two-minute-billing-verify`.
