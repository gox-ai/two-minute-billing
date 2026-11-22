---
name: two-minute-billing-go-live
description: Take a Two Minute Billing integration live safely — pick the payment gateway for each currency and country (12 supported, including cards, UPI Autopay, eMandate, SEPA, ACH and Bacs), then run a read-only audit of the live business (gateway, currencies, catalog copied from test, live webhook endpoint, emails, tax, retries) with a key that cannot change anything. Also covers a self-hosted production install and rotating API keys and webhook secrets. Leaves every live change to the user. Use when the user asks to go live, launch billing, accept real payments, self-host in production, rotate a key or webhook secret, or why live payments do not work.
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

## Self-hosted: the production install

The local Docker install in the `two-minute-billing` skill is for development. Production is a
separate install on the user's own server, and the user runs it. Point them to the guide,
https://twominutebilling.com/help/developers/getting-started/self-host-docker.md, and check with
them that it covers:

- **Hosts and HTTPS.** Docker with Compose v2 and `openssl`. `./init-env.sh` without `--local`
  asks for two host names, the dashboard and the API. Both need DNS `A` or `AAAA` records, and
  ports 80 and 443 open; Caddy gets the certificates. `TMBILLING_URL` is then their API host.
- **The two settings files.** `.env` and `app.env` hold `API_KEY_SECRET` and
  `GATEWAY_CREDENTIALS_KEY`. Back them up with the database and never replace them: a new
  `API_KEY_SECRET` stops every API key, and without `GATEWAY_CREDENTIALS_KEY` the stored gateway
  credentials cannot be read. Remove `TMBILLING_INIT_ADMIN_PASSWORD` after the first start.
- **Backups.** `docker compose --profile backup run --rm backup` writes a dump to
  `deploy/docker/backups/`. Copy it off the server with the two files; rehearse a restore.
- **One worker.** The `worker` service is the billing clock: keep one. There is no alerting
  service; the guide lists the log events to alert on (`tick_clock_gap`, `worker_fatal_error`, …).
- **Email.** The SMTP settings in `app.env` send the instance's own mail (team invites, password
  resets); without them it goes to the API log. Customer emails need each business's own sending
  (step 4 below).
- **Upgrades.** Back up, set `TMBILLING_VERSION` in `.env`, then
  `docker compose pull && docker compose up -d`: `init` applies the migrations first. There is
  no downgrade; to go back, restore the backup and the previous version.

The live steps below then run in their own instance's dashboard. Gateways are connected per
business there; they need no setting in the files.

## 2. The user's live steps

Give the user this list. They do each step in the dashboard; you do none of them:

1. On Cloud, check the plan covers their monthly billing: https://twominutebilling.com/pricing
   (self-hosted has no plans and no limits: skip this)
2. Connect the live gateway account(s) to the **live** business.
3. Copy the test setup to live: dashboard → **Settings → Transfer & sample data → Check what
   changes**, review every value, then copy. A transfer copies the catalog (with meters, credit
   units and rate cards), coupons, tax rates and settings, the billing settings (due days, dunning,
   proration, cancel and pause defaults, checkout and portal fields), and on request the company
   profile and email sending. A live destination is merge-only: to change what already exists
   there, an owner or admin selects **Also update what is there**. Test customers, subscriptions,
   invoices and payments never move: real customers sign up in live, or are migrated.
4. Set what a transfer does not copy: logo and colours, timezone and contact details, invoice
   number prefixes (or set them in the transfer), the checkout return and cancel URLs, email
   templates and the subject prefix and footer, and every secret (the SMTP password, if they send
   through their own server). Then run **Check what changes** again: nothing should be left to copy.
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

## 5. Rotate a key or a webhook secret

The user rotates live secrets; you prepare the code and give them the steps.

- **API key.** Settings → Developer → API keys → **Rotate** creates a new key with the same name,
  mode and access, and shows it once. **The old key stops** sets the overlap: immediately, or
  after 1 hour, 24 hours or 7 days (API: `POST /v1/api_keys/{id}/rotate` with `overlap_seconds`,
  0 to 604800, default 86400). The user puts the new key in production's secrets and deploys
  before the old one stops. **Revoke** stops a key at once: use it for a leaked key.
- **Webhook signing secret.** `POST /v1/webhook_endpoints/{id}/rotate_secret` (Settings →
  Developer → Webhooks → **Rotate secret**) returns the new secret once. The old secret stops at
  once: every delivery after it is signed with the new one. So first change the route to accept
  either of two secrets, the new one first, then the old one
  (https://twominutebilling.com/help/developers/webhooks/signatures.md). Then the user rotates,
  adds the new secret to production's secrets and deploys; remove the old one after. A delivery
  refused before the deploy is retried (six attempts in a little under nine hours), and
  `POST /v1/webhook_endpoints/{id}/redeliver_failed` requeues the ones that failed.
