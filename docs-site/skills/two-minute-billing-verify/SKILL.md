---
name: two-minute-billing-verify
description: Prove a Two Minute Billing integration works before go-live, on real test-mode invoices — check the app's webhook route rejects forged events (no tunnel needed), run subscriptions and one-time purchases with test cards that succeed, decline, need 3-D Secure or fail later, move the business clock forward by API to run renewals, trial ends and dunning, and compare each invoice with the expected figures field by field. Use after integrating, after a pricing change, or when asked whether billing is correct.
license: MIT
metadata:
  homepage: https://twominutebilling.com
  docs: https://twominutebilling.com/help/developers/getting-started/test-and-live
---

# Prove it works

A 2xx answer is not proof that the money is right. This skill checks real invoices on a real test
business, with scripts that fetch the evidence themselves. Every script runs with the project's
env file and refuses anything but a test key:

```bash
node --env-file=<env file> <this skill>/scripts/<script>.mjs …
```

| Script | Checks |
|---|---|
| `webhook-check.mjs --url http://localhost:<port>/<path>` | The app's route refuses a forged event (401), accepts a signed one (2xx) and accepts a repeat (2xx). Loopback only. |
| `clock.mjs start / advance --by 1m / status / stop` | Moves the test business's clock: renewals, trial ends, invoices, charges and retries due in between run now. `--by` takes `h` (hours), `d`, `w`, `m` (**months**, not minutes) and `y`; the smallest step is `1h`, and `--to <ISO time>` goes to an exact instant. `stop` keeps test data unless `--wipe`. |
| `money-check.mjs --expected e.json --subscription sub_…` (or `--invoice inv_…`, or `--session cosess_…` for a purchase) | Fetches the invoice and compares each expected field, the tax lines and the metadata; writes evidence with `--report`. |

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

1. **Webhook route.** Start the app, then run `webhook-check.mjs`. Fix the route until it passes.
2. **Start the clock** at now: `clock.mjs start`. Create the scenarios after this, so they run on the
   simulated clock. The started clock **does not move** by itself: it stays at `simulated_now`
   until you advance it. Usage events, holds and the access check all read that one instant, so
   usage sent now shows as "this period" only after the clock moves past it. Advance by `1h` (or
   `--to` a later instant) before you check a balance or usage, and expect the earlier figures
   until then.
3. **First invoice.** A customer with test card `4242424242424242` (`tmb.paymentMethods.create` with
   that number as `token`) subscribes to the main plan. Money check: status `paid`, the plan's total.
4. **Renewal.** `clock.mjs advance --by 1m` (or the plan's interval). Money check on the newest
   invoice. With usage: send events before advancing and expect them on the renewal.
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
9. **Stop the clock:** `clock.mjs stop` (keeps the scenario data for the user to look at).

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
   `payment_failed` handling by API:
   create a **new** test customer (one with no other card: a second card is a backup that pays),
   add the payment method `{ "token": "4000000000000002" }`, make it the
   default, raise an invoice with the price's amount as a line (`POST /v1/businesses/{biz}/invoices`
   takes `lines: [{ description, amount_minor, quantity }]`, not a price id) and collect it
   (`POST /v1/businesses/{biz}/invoices/{inv}/collect`). The invoice stays unpaid and
   `payment_failed` is sent. A declined checkout raises no invoice, so it sends no
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

`webhook-check.mjs` proves the handler. To prove delivery too, the engine must reach the app: a
public URL (the user's tunnel, or a deployed test environment), or the self-hosted engine on the same
machine. Then list `GET /v1/webhook_endpoints/{id}/deliveries` after the scenarios: every delivery
must show a 2xx `last_response_status`.

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
`zero_invoice_paid_event`) goes back to the live business's value, which can be empty. Run
`catalog.mjs --apply` (pricing skill) again after the reset: `billing.catalog.json` puts back the
catalog, coupons, tax regions and settings it lists. The business id and the keys stay. It cannot be undone, so say what it deletes and wait for the
user's own yes:

```bash
curl -X POST "$TMBILLING_URL/v1/businesses/$TMBILLING_BUSINESS_ID/test_data/reset" \
  -H "Authorization: Bearer $TMBILLING_API_KEY" -H "Idempotency-Key: $(uuidgen)"
```

To delete only the customers and keep the catalog, send `DELETE …/test_data` instead.

## Report

End with a table: scenario, invoice, expected total, actual total, result, report file. Name any
scenario you did not run and why. "Verified" means every row is MATCH.
