---
name: two-minute-billing-verify
description: Prove a Two Minute Billing integration works before go-live, on real test-mode invoices — check the app's webhook route rejects forged events (no tunnel needed), run subscriptions and one-time purchases with test cards that succeed, decline, need 3-D Secure or fail later, move the business clock forward by API to run renewals, trial ends and dunning, prove usage billing, credit refusals and automatic top-up, test a cancel in the customer portal, and compare each invoice with the expected figures field by field, with the tmb command line or its bundled scripts. Use after integrating, after a pricing change, or when asked whether billing is correct.
license: MIT
metadata:
  homepage: https://twominutebilling.com
  docs: https://twominutebilling.com/help/developers/getting-started/test-and-live
---

# Prove it works

A 2xx answer is not proof that the money is right. This skill checks real invoices on a real test
business, with commands that fetch the evidence themselves. Run them with `tmb` (start-here skill,
"The `tmb` command line"). Each one refuses anything but a test key:

```bash
tmb <command> … --env-file <env file>
```

If an install or `npx` is blocked, run the bundled script instead, with the same flags:
`node --env-file=<env file> <this skill>/scripts/<script>.mjs …`. `tmb` passes every flag to
that script unchanged, so the checks and exit codes are the same. Only the env file differs:
`tmb` takes `--env-file <path>` (and loads `./.env` without it), `node` takes `--env-file=<path>`.

| Command (`tmb`) | Script fallback | Checks |
|---|---|---|
| `tmb webhooks test --url http://localhost:<port>/<path>` | `webhook-check.mjs --url …` | The app's route refuses a forged event (401), accepts a signed one (2xx) and accepts a repeat (2xx). Loopback only. |
| `tmb clock start / advance --by 1m / status / stop` | `clock.mjs start / advance … / status / stop` | Moves the test business's clock: renewals, trial ends, invoices, charges and retries due in between run now. `--by` takes `h` (hours), `d`, `w`, `m` (**months**, not minutes) and `y`; the smallest step is `1h`, and `--to <ISO time>` goes to an exact instant. `start --at <ISO time>` starts at another instant. `stop` keeps test data unless `--wipe`. |
| `tmb check --expected e.json --subscription sub_…` (or `--invoice inv_…`, or `--session cosess_…` for a purchase) | `money-check.mjs --expected … --subscription …` | Fetches the invoice and compares each expected field, the tax lines and the metadata; writes evidence with `--report`. |

`tmb clock` and `tmb check` also take `--business biz_…` (default `TMBILLING_BUSINESS_ID`);
`tmb webhooks test` also takes `--type <event type>` (default `customer_updated`).

The expected file holds integers in minor units. Every field is optional except `total_minor`:

```json
{ "currency": "INR", "total_minor": 11682, "subtotal_minor": 9900, "tax_minor": 1782,
  "status": "paid",
  "lines": [{ "price": "photo-set-inr", "amount_minor": 9900 }],
  "taxes": [{ "name": "CGST", "rate_bps": 900, "amount_minor": 891 },
            { "name": "SGST", "rate_bps": 900, "amount_minor": 891 }],
  "metadata": { "order_id": "1042" } }
```

`taxes` lists every tax line the invoice must carry, named as the invoice's `taxes[]` names them
(`rate_bps` optional); a line missing from the file, or from the invoice, is a difference. A sale
that bills no tax (no tax region for the buyer's country) still carries one line,
`{ "name": "Zero-rated", "rate_bps": 0, "amount_minor": 0 }`: list it, or leave `taxes` out.
`metadata` checks only the keys you give.

## Rules for evidence

- Write the **expected** figures from the user's prices and tax rules **before** you look at the
  invoice, and show them to the user. Never copy a figure from the invoice into the expected file.
- A failed check is a finding. Report it as it is; do not change the expected file to make it pass.
  Ask the user whether the price or the code is wrong.
- Keep the `--report` files (for example in `billing-checks/`) and list them in the summary.

## Plan

Show this plan, adjusted to the user's catalog, and wait for a yes. Each scenario uses its own test
customer, so the user's other test data is not touched.

1. **Webhook route.** Start the app, then run `tmb webhooks test --url …`. Fix the route until it
   passes. Then start `tmb listen` ("Webhooks from the engine"), so the scenarios' real events
   reach it.
2. **Start the clock** at now: `tmb clock start`. Create the scenarios after this, so they run on the
   simulated clock. The started clock **does not move** by itself: it stays at `simulated_now`
   until you advance it. Usage events, holds and the access check all read that one instant, so
   usage sent now shows as "this period" only after the clock moves past it. Advance by `1h` (or
   `--to` a later instant) before you check a balance or usage, and expect the earlier figures
   until then.
3. **First invoice.** `tmb trigger subscription --price <main plan's price id>`: a new test
   customer with test card `4242424242424242` subscribes, and the command prints the `sub_…`.
   Without `--price` it takes the first active recurring price that is not metered, so name the
   plan, and pick a price with no trial (trials are step 5). Money check: status `paid`, the plan's
   total. The trigger's customer has an email and no address. To check tax, create the customer
   by API with the buyer's address, add the card (`tmb.paymentMethods.create` with that number as
   `token`) and subscribe it.
4. **Renewal.** `tmb clock advance --by 1m` (or the plan's interval). Money check on the newest
   invoice. With usage, see "Usage and credits" below.
5. **Trial end**, if a plan has a trial: subscribe, advance past `trial_end`, check the first charge
   (or the cancellation, if the trial ends without a card).
6. **Failed payment:** card `4000000000009995` (insufficient funds, retried). While retries run the
   invoice is `payment_due` with `dunning_status: "in_progress"`. With no `dunning_config` the
   business retries 1, 3, 5 and 7 days after the invoice's due date; read
   `GET /v1/businesses/{biz}` to see the schedule. Advance in steps across it; when the retries run out the invoice is `not_paid`
   (`dunning_status: "exhausted"`) and the final action runs (default: cancel the subscription).
   Check that the app removes access when the subscription is cancelled or stays unpaid, as the
   user decided.
7. **Hard decline:** `4000000000000002`. On signup, the subscription must not become active and the
   app must not grant access. On a renewal, a hard decline skips the retries by default
   (`skip_retries_for_hard_failures`): the invoice goes straight to `not_paid`, `dunning_status:
   "exhausted"`, and the final action runs at once. Expect `not_paid`, not `payment_due`. On a
   plan change, the result depends on a business setting: see step 8.

   To make a customer's renewal fail, the failing card must be the only one collection can use. A
   new default card does not take the old one off: the old one becomes the `backup`, and collection
   falls back to it and the invoice is paid. Use a fresh test customer whose only card fails, or
   take the old card off with `POST …/customers/{cus}/payment_methods/{pm}/assign_role`
   `{ "role": "none" }`.
8. **Plan change**, if the app offers one: preview with `POST …/subscriptions/{sub}/estimate`, make
   the change, check the proration invoice against the preview and the user's rule. The preview's
   `lines` are the net effect: the credit for the old plan's unused time shows as a negative
   line, but the change books it as a **credit note** applied to the change invoice. Write the
   expected file from `invoice_total_minor` (the invoice's total, with only the new charges),
   `credit_note_total_minor` (the note) and `amount_due_minor` (what is charged), not from
   `lines`. Without `change_option`, the preview prices the timing the business rule gives: a
   downgrade applied at the end of the term previews the term end (no credit now).

   **Declined plan change.** Read `billing_rules_config.failed_change_charge` with
   `GET /v1/businesses/{biz}`, then make the change on a customer whose only card is
   `4000000000000002`. Expect, by value:
   - `apply_when_paid` (a new business's value): `402` `payment_failed` with `pending_change`.
     The subscription stays on the old plan, `GET …/subscriptions/{sub}` shows `pending_change`,
     and its invoice is `payment_due` with `dunning_status: "stopped"` (no retries). Add
     `4242424242424242`, make it the default, and send the same request again: it pays the
     **same** invoice (`pending_change.invoice`), the plan changes, and there is no second
     change invoice. Money check that invoice. `subscription_pending_change_created` and
     `subscription_pending_change_applied` are sent.
   - `revert`: `402` `payment_failed` with no `pending_change`. The plan stays as it was, and
     the change's invoice and credit notes are `voided`.
   - `start_dunning` (unset): `200`, and the change applies at once. The hard decline ends
     dunning at once: the invoice is `not_paid` (`dunning_status: "exhausted"`) and the final
     action runs (default: cancel the subscription).
   - `next_renewal`: `200`, and the change applies at once. The invoice's first retry waits
     until the term ends.
9. **Stop the clock:** `tmb clock stop` (keeps the scenario data for the user to look at).

**Usage and credits**, if the app meters usage or sells credits (usage skill). Run these on the
clock, before step 9, each with its own customer. The engine checks an event's `timestamp`
against the clock's `simulated_now`: more than 5 minutes after it is `timestamp_in_future`, more
than 35 days before it `timestamp_too_old`. An event with no `timestamp` takes `simulated_now`.
Read balances and usage only after `tmb clock advance --by 1h` (step 2).

- **Events bill.** Subscribe a customer to the plan with the meter's price and do the app's real
  actions. `tmb.usageEvents.list` with the meter shows each event `matched` (`unmatched`: the usage
  key is not on the customer); a repeat of a key answers `duplicate`. Advance across the renewal
  and money check the usage line on the renewal invoice.
- **Access check.** `GET /v1/businesses/{biz}/access?customer_key=<key>&meter=<meter>` with
  `estimate=<minor units>` (credit with a money value) or `estimate_units=<credits>` (a meter with
  a credit cost). With credit: `allowed: true`. Spend the credit, advance `1h`, check again:
  `allowed: false`, `code: "insufficient_credit"`, and the app refuses the action. For a money
  value, the check refuses only under a block policy, so `credit_config.blocking_enabled` must be
  `true`; with blocking off it answers `allowed: true` and the usage is billed. `on_exhausted`
  in the answer shows the policy and its `source`.
- **Refused at ingest** (a meter with a credit cost). With the balance spent, the next event
  answers `402` `insufficient_credit`: it is stored and not billed, and `credit_usage_refused` is
  sent. Check that the app treats the 402 as "not enough credit" and sends a new key after the
  customer buys credit (a replay of the key answers 402 again). Under `bill` with an overage price,
  or inside an overdraft limit, the event is accepted instead.
- **Free trial** (a meter with a credit cost, a plan with a trial). A trial gets no plan credits.
  With the default `credit_config.trial_usage: "refuse"`, an event the balance does not cover
  answers 402, and the access check shows `on_exhausted.source: "trial"`.
- **Automatic top-up**, if the app turns it on: the customer has card `4242424242424242` and a
  `PUT …/customers/{cus}/auto_topup` config (usage skill). Send events until the balance is at or
  below `threshold_units`, then advance `1h`: the clock runs the top-up. The pack's invoice is
  paid, `credit_auto_topup_succeeded` is sent, and the access check shows the pack's credits.

**Customer portal**, if the app links to it. A buyer cancel needs
`storefront_config.allow_cancel_subscription: true` (off by default; dashboard: **Settings →
Hosted pages**). The business PATCH replaces `storefront_config` whole: send the stored object
with the key changed. With a subscribed test customer on the clock:

1. `POST /v1/businesses/{biz}/customers/{cus}/portal_sessions` with `{}`, or
   `{ "action": "cancel_subscription", "object": "sub_…" }` to open the cancel dialog. Give the
   user the `url`: it works once, until `access_expires_at`.
2. The user cancels in the portal (the dialog can ask a reason and show offers first; **Cancel
   subscription** goes on). With `cancel_timing: "end_of_term"` (the default),
   `subscription_cancel_scheduled` is sent: the subscription is `non_renewing`,
   `cancel_at_period_end: true`, and `canceled_at` is the term end. The app must keep access.
3. Advance past the term end: `subscription_canceled` is sent, the subscription is `cancelled`,
   and the app must remove access. Under `cancel_timing: "immediately"` the portal cancel sends
   `subscription_canceled` at once.

With `storefront_config.allow_plan_changes: true`, test a plan change the same way: the app must
follow `subscription_changed` (applied now) or `subscription_change_scheduled` (at the term end).

**A one-time store** needs no clock. Run these instead of steps 2–9:

1. **Purchase paid.** Create a purchase checkout for one order and pay it by hand (below). Money
   check with `--session cosess_…`: status `paid`, the order's total with tax, and
   `metadata.order_id` matching the order. Then check the app marked that order paid.
2. **Tax by place of supply**, if the business has a tax region: one buyer inside the seller's
   state or country and one outside. Write each expected tax line in `taxes` first (for India,
   CGST + SGST inside the home state, IGST outside).
3. **Coupon**, if the app sells with codes: a percentage code, and a 100%-off code. The free order
   completes without a payment step, its invoice is `paid` with total 0, and the app fulfils it
   from the invoice status (the webhook may not come; see the integrate skill).
4. **Declined payment**: on the hosted checkout, select **Pay**, then **Decline** in the test
   dialog. No invoice is paid, the checkout stays open, and the order stays unpaid in the app. The
   buyer can select Pay again and Approve. On a subscription checkout whose card step shows a
   **Test card number** field, type `4000000000000002`: the payment is declined, no subscription
   is created, and the buyer can try again with `4242424242424242`. To prove the app's
   `payment_failed` handling, run `tmb trigger payment-failed --price <one-time price id>`: a
   **new** test customer whose only card is `4000000000000002` (a second card is a backup that
   pays) gets an invoice for that price, collected at once. The invoice stays unpaid and
   `payment_failed` is sent; the command exits 2 if the invoice was paid. By API: the same
   customer and card, then `POST /v1/businesses/{biz}/invoices` with `{ "customer": "cus_…",
   "lines": [{ "price": "<price id>" }], "collect": true }` (a line takes a `price`, or a
   `description` and `amount_minor`). A declined checkout raises no invoice, so it sends no
   `payment_failed`.

   A one-time invoice is not retried by default: a soft decline (`4000000000009995`) leaves it
   `not_paid` at once, with `dunning_status: null`. Retries run on invoices outside a subscription
   only when the business's `dunning_config.dun_one_time_invoices` is `true`
   (https://twominutebilling.com/help/developers/recipes/failed-payments.md); then advance the
   clock across the schedule as in step 6 above.

**3-D Secure** is tested by API: on the hosted page, the test gateway's 3-D Secure step sends the
buyer to an approval page that does not exist. Add `{ "token": "4000000000003155" }` to a fresh
customer and make it the default, then:

1. `POST …/customers/{cus}/subscriptions` with `on_session: true` → `402` `requires_action`
   with `payment_intent` and `next_action`. Without `on_session` the create is an off-session
   signup and the challenge is a refusal with no intent.
2. The buyer completes `next_action`. On the test gateway, stand in for the browser: send
   `client_result: { "nonce": "tmtest_ok" }` (`"tmtest_decline"` to refuse) in step 3.
3. Send the same create again with `on_session: true` and `payment_intent: "pi_…"` → `201`,
   `active`, first invoice `paid`.

More test cards — late failure `4000000000005126`, timeout
`4000000000000077`, settles only by webhook `4000000000000101`:
https://twominutebilling.com/help/developers/getting-started/test-and-live.md

## Webhooks from the engine

`tmb webhooks test` proves the handler on a sample event. To run it on the real events of the
scenarios, with no tunnel, run `tmb listen` while the app runs, in the background or in the user's
own terminal (it does not stop by itself). It has no script fallback:

```bash
tmb listen --forward http://localhost:<port>/<path> --env-file <env file>
```

It refuses a key that is not a test key, and posts each new event of the test business to the
loopback URL with the body and `Tmbilling-Signature` an endpoint gets, signed with
`TMBILLING_WEBHOOK_SECRET`. It prints one line for each event with the app's HTTP status: every
line must show a 2xx. The events that `tmb clock advance` causes are sent too. `--events a,b`
sends only those types. It sends every event the engine writes for the business, but the engine
writes `credit_usage_settled` only while an enabled webhook endpoint of the organization lists it
by name.

For a first real event without a scenario, run `tmb trigger purchase` (a one-time price:
`invoice_paid`, `payment_succeeded`) or `tmb trigger subscription` (`subscription_created`)
while `tmb listen` runs. The trigger's invoice belongs to no order in the app, so this proves
that real events reach the route, not the order flow.

`listen` sends each event once, and its sends are not in `/deliveries`. To prove the engine's own
delivery and retries, the engine must reach the app: a public URL (the user's tunnel, or a deployed
test environment), or the self-hosted engine on the same machine. Then list
`GET /v1/webhook_endpoints/{id}/deliveries` after the scenarios: every delivery must show a 2xx
`last_response_status`.

`POST /v1/webhook_endpoints/{id}/test` with `{ "type": "invoice_paid" }` (the type is required)
sends one sample event to the endpoint. A test send is **not** listed in
`/deliveries`, and its content is a sample marked `test: true`, so it proves the route answers, not
that real events reach it.

## Checkout by hand

Hosted checkout needs a person. Ask the user to open the app's subscribe or buy button in a
browser. In test mode, **Pay** opens the test gateway's dialog: **Approve** pays, **Decline**
refuses the payment. Where the card step shows a **Test card number** field, the typed card is
the card saved: `4242424242424242` pays, `4000000000000002` declines. On a plan-change checkout
under `apply_when_paid`, a decline leaves the plan as it was. A new checkout for the same change
then shows that the change waits for payment, its amount and the time it expires. Paying with
`4242424242424242` pays the same invoice and applies the change. Test 3-D Secure and a
decline at renewal by API, as above. Then check that the account shows
the plan, or the order shows paid, from the webhook or the invoice status, not because the return
page was reached.

## Start again

If the user wants the test business back to new, for example after a setup went wrong, offer a
reset. It deletes every customer, invoice and payment, the catalog, coupons, tax regions, webhook
endpoints and gateways of the test business. Then it copies every setting of the live business
onto it: name, address, tax registration number, coupon and billing rules. A setting made only on
the test business (for example the seller's address or tax number, `allow_customer_coupons`,
`zero_invoice_paid_event`) goes back to the live business's value, which can be empty. A running
clock stops. Run `tmb push --apply` (pricing skill; script fallback `catalog.mjs --apply`) again
after the reset: `billing.catalog.json` puts back the catalog, coupons, tax regions and settings
it lists. The business id, the keys and the audit log stay. It cannot be undone, so say what it
deletes and wait for the user's own yes. Then run:

```bash
tmb reset --confirm biz_… --env-file <env file>
```

`--confirm` takes the business id; without it `tmb` asks for the id in a terminal and stops when
there is none. It refuses a live business and a key that is not a test key. It calls the same
endpoint as this request, the fallback with no `tmb`:

```bash
curl -X POST "$TMBILLING_URL/v1/businesses/$TMBILLING_BUSINESS_ID/test_data/reset" \
  -H "Authorization: Bearer $TMBILLING_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```

To delete only the customers and keep the catalog, send `DELETE …/test_data` instead (`tmb`
has no command for it).

## Report

End with a table: scenario, invoice, expected total, actual total, result, report file. Name any
scenario you did not run and why. "Verified" means every row is MATCH.
