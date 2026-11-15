---
name: two-minute-billing-go-live
description: Take a Two Minute Billing integration live safely — pick the payment gateway for each currency and country (12 supported, including cards, UPI Autopay, eMandate, SEPA, ACH and Bacs), then run a read-only audit of the live business (gateway, currencies, catalog copied from test, live webhook endpoint, emails, tax, retries) with a key that cannot change anything. Leaves every live change to the user. Use when the user asks to go live, launch billing, accept real payments, or why live payments do not work.
license: MIT
metadata:
  homepage: https://twominutebilling.com
  docs: https://twominutebilling.com/help/developers/getting-started/test-and-live
---

# Go live

You do not make live changes. You advise, audit with a key that cannot write, and hand the user a
checklist. The `two-minute-billing` skill's rules still hold.

## 1. Pick the gateway

Read the live list instead of relying on memory: `GET $TMBILLING_URL/v1/gateways` (any key) returns
each gateway's `currencies`, `method_types` and whether it is `available`. Match it against where
the user's customers pay from:

| Customers mostly in | Recurring methods to look for | Gateways to compare |
|---|---|---|
| India, INR | UPI Autopay, eMandate (netbanking), cards | Razorpay, Cashfree, PayU |
| United States | cards, ACH Direct Debit | Stripe, Braintree, Authorize.net, Square, Adyen, Checkout.com |
| Euro area | cards, SEPA Direct Debit | Stripe, Mollie, GoCardless, Adyen |
| United Kingdom | cards, Bacs Direct Debit | GoCardless, Stripe, Checkout.com |
| Australia, New Zealand, Canada, Nordics | BECS, PAD, Autogiro, Betalingsservice, PayTo | GoCardless |
| Anywhere, wallet buyers | PayPal | PayPal, Braintree |

More than one can be connected: each charge goes to the account that takes its currency and method.
The user may already have a gateway account; keeping it keeps their fees and saved cards. Each
gateway's setup guide, with the permissions it needs:
https://twominutebilling.com/help/guides/connect-a-payment-gateway (add `/<gateway>.md`).

## 2. The user's live steps

Give the user this list. They do each step in the dashboard; you do none of them:

1. On Cloud, check the plan covers their monthly billing: https://twominutebilling.com/pricing
2. Connect the live gateway account(s) to the **live** business.
3. Copy the catalog to live: dashboard → **Settings → Transfer & Sample Data → Check changes**, then
   copy. (Or run the catalog script with a live key themselves.)
4. Set the brand (logo, colour, company details) so checkout, portal, emails and invoices show their
   company; set up email sending from their own domain.
5. Register the production webhook URL (https) for the live business; store its secret in
   production's secrets, never in the repository.
6. Create a `sk_live_…` key and set it, with the live business id, in production's secrets.
7. Create a **read-only** live key for the audit below, and add it to the local env file as
   `TMBILLING_LIVE_READ_KEY`.

## 3. Audit, read-only

```bash
node --env-file=<env file> <this skill>/scripts/go-live-audit.mjs snapshot   # test key: records the test catalog
node --env-file=<env file> <this skill>/scripts/go-live-audit.mjs audit      # read-only live key
```

`audit` refuses any key that is not live **and** read-only, so it cannot change live data. It checks:
the organization can write live, the live business, an active gateway, a gateway for every price
currency, every test product and price present in live, a live https webhook endpoint, email
delivery, tax profiles and retry policies. FAIL blocks launch; WARN needs the user's answer.

Report each FAIL with the step from the list above that fixes it. Run `audit` again after the user
fixes them. Done when there is no FAIL and the user has answered each WARN.

## 4. After launch

- Watch the first real renewals: dashboard → Invoices, and the webhook delivery log
  (`GET /v1/webhook_endpoints/{id}/deliveries`, read-only key).
- The read-only MCP server lets an assistant answer "why did this payment fail?" from live data
  without write access (see the `two-minute-billing` skill).
