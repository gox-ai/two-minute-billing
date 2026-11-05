# Two Minute Billing

**Open-source subscription, usage-based and AI billing on your own payment gateway account (12
supported).** Plans, usage meters, AI model prices, prepaid credits, invoices, GST and VAT,
dunning, hosted checkout and MRR reports, with a flat price and no share of your revenue.
Self-host it for free, or let us run it on our Cloud.

[![Release](https://img.shields.io/github/v/tag/gox-ai/two-minute-billing?label=release&sort=semver)](https://github.com/gox-ai/two-minute-billing/tags)
[![npm](https://img.shields.io/npm/v/@two-minute-billing/sdk?label=npm%20sdk&logo=npm)](https://www.npmjs.com/package/@two-minute-billing/sdk)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![SDK: MIT](https://img.shields.io/badge/SDK-MIT-green.svg)](./sdk/LICENSE)
[![Docs](https://img.shields.io/badge/docs-twominutebilling.com-4E4EDA)](https://twominutebilling.com/help)
[![Self-host: Docker](https://img.shields.io/badge/self--host-Docker-2496ED?logo=docker&logoColor=white)](https://twominutebilling.com/help/developers/getting-started/self-host-docker)
[![GitHub stars](https://img.shields.io/github/stars/gox-ai/two-minute-billing?style=flat&logo=github&label=stars)](https://github.com/gox-ai/two-minute-billing)

[Website](https://twominutebilling.com) · [Documentation](https://twominutebilling.com/help) ·
[API reference](https://twominutebilling.com/help/developers/api-reference) ·
[TypeScript SDK on npm](https://www.npmjs.com/package/@two-minute-billing/sdk) ·
[Self-host](./SETUP.md) · [Compare](https://twominutebilling.com/compare)

## What is Two Minute Billing?

Two Minute Billing is an **open-source subscription billing platform** and **billing engine** for
SaaS, AI, usage-based and ecommerce businesses. You set up what you sell and how you charge for it;
it bills your customers on schedule, chases the payments that fail, and keeps the books straight.

- **Self-hosted recurring billing** under the AGPL-3.0, with every feature and no limits, or a
  hosted Cloud with the same engine.
- **SaaS billing**: plans, seats, add-ons, trials, upgrades and downgrades with proration.
- **Usage-based billing**: send usage events from your app; meters count them and rate cards
  price them, with tiers, minimum commitments and usage invoices in arrears.
- **AI billing**: bill each AI model and token type at its list price or your cost plus a markup,
  see your margin, and sell prepaid credits with spend limits and automatic top-up.
- **GST invoicing for India**: GST by place of supply, GSTIN and HSN or SAC codes, TDS on the
  invoice, and Razorpay mandates for recurring INR. VAT and US sales tax too.
- **Dunning and failed-payment recovery**: retries timed by the decline reason, a backup card,
  card-expiry emails and one-click payment links.
- **Self-service customer portal**, in your brand: customers change plan, seats and add-ons with
  the new price shown first, pause or skip a renewal, and sign in with a code sent by email.
- **Churn reduction**: before a customer cancels, offer a pause, a cheaper plan or a discount, and
  ask for the reason.
- **One-page hosted checkout**, with payment links, a pricing page, Apple Pay and Google Pay first,
  and the buyer's consent to recurring charges and your terms.
- **Billing rules per business**: proration, plan-change timing, dunning, payment application,
  small invoices, tax rounding and team alerts. A business that sets nothing keeps the defaults.
- **Revenue analytics**: MRR, ARR, churn, retention and cohorts, built in.

It is not a payment provider. Your payment gateway moves the money, through your own account
at your own rates. Two Minute Billing decides who owes what, when to charge them, and what
to do when a charge does not work.

## An alternative to

Each line says how we differ. The full side-by-side pages, with the source of every fact, are on
[twominutebilling.com/compare](https://twominutebilling.com/compare) (facts checked 22 October 2026).

| Product | How Two Minute Billing differs |
|---|---|
| [Chargebee](https://twominutebilling.com/compare/chargebee-alternative) | Both bill through your own gateway. Chargebee's Billing plans charge a percentage of monthly invoicing volume; ours are a flat monthly plan, or free when you self-host. |
| [Stripe Billing](https://twominutebilling.com/compare/stripe-billing-alternative) | Stripe Billing charges a percentage of billing volume. We bill through the same Stripe account, so your saved cards stay put, for a flat price, and add 10 more gateways, such as Adyen and Razorpay. |
| [Paddle](https://twominutebilling.com/compare/paddle-alternative) | Paddle is the merchant of record: it sells for you, files the tax and takes a percentage plus a fee per transaction. With us you are the seller on your own gateway, and you file the tax we work out. |
| [Recurly](https://twominutebilling.com/compare/recurly-alternative) | Recurly's plans charge a percentage of billing volume. We charge a flat monthly plan, and add India GST and Razorpay mandates. |
| [Chargify (Maxio)](https://twominutebilling.com/compare/chargify-alternative) | Chargify is now part of Maxio, sold through a demo. You can start with us for free today, or self-host. |
| [Zuora](https://twominutebilling.com/compare/zuora-alternative) | Zuora is priced by quote. Our prices are published, and you can start without a sales call. |
| [Lemon Squeezy](https://twominutebilling.com/compare/lemon-squeezy-alternative) | Lemon Squeezy, part of Stripe since 2024, is a merchant of record with a fee on each sale. With us you are the seller, on your own gateway, for a flat price. |

Product names are trademarks of their owners, named only to compare.

## Built-in subscription analytics

MRR and ARR per currency (with a converted total), MRR movements, customer and subscriber churn,
net and gross revenue retention (NRR, GRR), quick ratio, lifetime value (LTV), ARPU and revenue
per paying customer, trial conversion, and MRR and subscription retention cohorts, all built in,
so no separate Baremetrics / ChartMogul / ProfitWell subscription. Every report is built from the
append-only ledger, so each figure traces to the invoices and payments behind it.

## Usage-based and AI billing

Your app reports what each customer uses. Two Minute Billing prices it and puts it on the invoice.

- **Usage metering**: send usage events with a key your app already has, such as a workspace id.
  A meter counts them, and a rate card bills each model, region or plan tier at its own rate.
- **Usage-based pricing**: tiered, volume and package prices, a minimum commitment with a true-up,
  usage invoiced every month on an annual plan, and usage so far in the dashboard and the portal.
- **AI model price list**: a dated copy of public AI model prices, checked twice a day. Bill each
  model and token type at its list price or your cost plus a markup, and see your margin per model.
- **Prepaid credits**: your own credit unit, credit packs, plan credits that roll over, holds,
  an overdraft limit, and an access check your app calls to stop usage when credit runs out.
- **Spend controls**: spend limits, alerts before a limit, credit runway, automatic top-up,
  early usage invoices at a threshold, a rate-change preview and a usage widget for your app.

Guides: [usage and AI billing](https://twominutebilling.com/help/guides/usage-and-ai-billing) ·
[AI billing overview](https://twominutebilling.com/solutions/ai-billing).

## What it does

| | |
|---|---|
| **Catalogue** | Plans, add-ons and one-time charges in product groups. Flat, per-unit, tiered, volume, stairstep, package, percentage and metered pricing, in any currency and on any interval. Add-ons and charges can be attached to a plan, priced per plan, or required by it. |
| **Subscriptions** | Trials, upgrades and downgrades with proration worked out, pauses, skipped renewals, scheduled changes, fixed terms and reactivation. |
| **Invoices** | Raised on schedule with tax and discounts applied, emailed, and available as a PDF. Credit notes and refunds against them. |
| **Payments** | Cards, mandates and bank transfers collected through your own payment gateway, with a backup payment method and offline payments. |
| **Failed payments** | Dunning management on a schedule you set, adaptive retry timing, the action when retries run out, write-offs of small unpaid balances, and emails your customer can act on. |
| **Tax** | Per-line tax from where your customer is, including GST, VAT and US sales tax, inclusive or exclusive. |
| **Usage and AI billing** | Meters and rate cards for usage events, AI model prices with your markup and margin, prepaid credits, spend limits and automatic top-up. |
| **Coupons and credits** | Coupons with single-use code batches, promotional credits, and a credit balance that pays invoices first. |
| **Checkout and portal** | One-page or step-by-step hosted checkout, payment links and a self-service customer portal, in your brand. Customers change plan, seats and add-ons, pause, resume or cancel, and see retention offers first. |
| **Billing rules** | Each business sets its own: upgrade and downgrade proration and timing, the action at trial end, payment application, small-invoice handling, charge on the due date, tax per currency and tax rounding, and team alerts for overdue invoices and failed webhooks. |
| **Reporting** | The metrics above, plus receivables, cancellations and dashboards you build yourself. |
| **Time Travel** | Fast-forward a test business's clock to watch a year of renewals, dunning and webhooks in seconds. |
| **API and webhooks** | A documented REST API with idempotency keys on every write, signed outbound webhooks, and a typed TypeScript SDK ([`@two-minute-billing/sdk`](./sdk/README.md)). |

## Payment gateways

Twelve gateways, on your own accounts, routed by currency and payment method. Connect more than
one and each charge goes to the account that takes its currency and method.

| Gateway | Payment methods | Setup guide |
|---|---|---|
| Stripe | Cards, Direct Debit (ACH), Direct Debit (SEPA) | [Connect Stripe](https://twominutebilling.com/help/guides/connect-a-payment-gateway/stripe) |
| PayPal | PayPal wallet | [Connect PayPal](https://twominutebilling.com/help/guides/connect-a-payment-gateway/paypal) |
| Razorpay | Cards, UPI Autopay, Netbanking (eMandate) | [Connect Razorpay](https://twominutebilling.com/help/guides/connect-a-payment-gateway/razorpay) |
| Square | Cards | [Connect Square](https://twominutebilling.com/help/guides/connect-a-payment-gateway/square) |
| Braintree | Cards, PayPal, Venmo | [Connect Braintree](https://twominutebilling.com/help/guides/connect-a-payment-gateway/braintree) |
| Checkout.com | Cards | [Connect Checkout.com](https://twominutebilling.com/help/guides/connect-a-payment-gateway/checkoutcom) |
| Adyen | Cards | [Connect Adyen](https://twominutebilling.com/help/guides/connect-a-payment-gateway/adyen) |
| Mollie | Cards, Direct Debit (SEPA), PayPal | [Connect Mollie](https://twominutebilling.com/help/guides/connect-a-payment-gateway/mollie) |
| Authorize.net | Cards, eCheck (ACH) | [Connect Authorize.net](https://twominutebilling.com/help/guides/connect-a-payment-gateway/authorizenet) |
| GoCardless | Direct Debit: Bacs, SEPA, ACH, BECS (AU and NZ), PAD, Autogiro, Betalingsservice; PayTo | [Connect GoCardless](https://twominutebilling.com/help/guides/connect-a-payment-gateway/gocardless) |
| Cashfree | Cards, UPI Autopay, eNACH | [Connect Cashfree](https://twominutebilling.com/help/guides/connect-a-payment-gateway/cashfree) |
| PayU | Cards, UPI Autopay | [Connect PayU](https://twominutebilling.com/help/guides/connect-a-payment-gateway/payu) |

Coming next: CyberSource (cards), finishing its live checks. Every install also includes a test
gateway for test mode, with a test card for each outcome, and Time Travel runs a year of renewals
in seconds, so you can try your setup before you connect a real gateway.

Card details go straight to the gateway, so you stay in PCI DSS SAQ-A scope, and you are never
locked to one provider.

## Cloud or self-hosted

| | Self-hosted | Cloud |
|---|---|---|
| Features | Every feature, no limits | Every feature, the same engine |
| Price | Free (AGPL-3.0) | A free plan in test mode, then a flat monthly plan by billing volume. No percentage of revenue |
| Who runs it | You: your servers, database and network | We run hosting, upgrades and monitoring |
| Sign-up | By invitation to your organization | Public sign-up |

Pricing: [twominutebilling.com/pricing](https://twominutebilling.com/pricing).

## How it is built

- **The engine owns subscription state.** Payment providers only charge, refund and store cards,
  so you stay PCI SAQ-A and are never locked to one provider.
- **Money is a double-entry, append-only ledger** in integer minor units. Balances are derived,
  never edited.
- **Multi-tenant by design:** Organization → Business → Customer → Subscription, isolated with
  Postgres row-level security.
- **A durable billing clock** (a Postgres job queue), not in-memory timers, so a restart never
  loses a renewal.
- **Every write is idempotent,** including inbound provider webhooks; outbound webhooks use an
  outbox.

Stack: Node 24, TypeScript, Fastify, Zod, Postgres, Drizzle ORM, graphile-worker, and a Next.js
dashboard. Details and the reasoning behind each decision:
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Quick start

### With Docker

You need Docker with Compose v2. Nothing else runs on the host.

```bash
cd deploy/docker
./init-env.sh --local       # writes the settings; shows the first admin's password once
docker compose up -d        # Postgres, schema, API, worker, dashboard on http://localhost:4100
```

Without `--local` it asks for two host names and serves both over HTTPS. Automated installs,
upgrades and backups:
[twominutebilling.com/help/developers/getting-started/self-host-docker](https://twominutebilling.com/help/developers/getting-started/self-host-docker).

**Images.** Every release publishes two images, built by GitHub Actions from the release tag for
`linux/amd64` and `linux/arm64`, each with an SBOM and build provenance, and signed with
[cosign](https://github.com/sigstore/cosign):

| Image | What it runs |
|---|---|
| `ghcr.io/gox-ai/two-minute-billing-engine` | The API, the billing worker and the one-time `init` (schema, first admin) |
| `ghcr.io/gox-ai/two-minute-billing-dashboard` | The dashboard, hosted checkout and customer portal |

`init-env.sh` sets `TMBILLING_VERSION` to the release you checked out; to upgrade, change it and
run `docker compose pull && docker compose up -d`. To check that an image came from this
repository's release workflow:

```bash
cosign verify ghcr.io/gox-ai/two-minute-billing-engine:<version> \
  --certificate-identity-regexp '^https://github.com/gox-ai/two-minute-billing/\.github/workflows/images-publish\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### From source

You need Node 24 (via [fnm](https://github.com/Schniz/fnm)), [pnpm](https://pnpm.io) and Docker.

```bash
fnm use && pnpm install
cp .env.example .env        # local defaults work as they are
docker compose up -d        # local Postgres
pnpm setup:local            # schema → reference data → demo data; prints a login + API key
```

Then run the three processes:

```bash
pnpm dev                    # API on :4000  (curl localhost:4000/health)
pnpm worker                 # billing clock
pnpm dev:dashboard          # dashboard on :4100
```

This is the self-hosted edition (`TMBILLING_EDITION=self_hosted`, the default): every feature,
no plans, no limits, and no public sign-up — people join your organization by invitation.

The demo data is three businesses with over a year of billing history, produced by the real
engine, so every screen has something to show (`--small` for a quicker seed). The step-by-step
version, with the gotchas: [`SETUP.md`](./SETUP.md). The API quickstart, from a test key to a
paid subscription:
[twominutebilling.com/help/developers/getting-started/quickstart](https://twominutebilling.com/help/developers/getting-started/quickstart).

## Use the API

Install the typed TypeScript client,
[`@two-minute-billing/sdk`](https://www.npmjs.com/package/@two-minute-billing/sdk) on npm
([source](./sdk/README.md); MIT, no dependencies, Node 20+, Deno, Bun and the browser):

```bash
pnpm add @two-minute-billing/sdk
```

```ts
import { Tmbilling } from "@two-minute-billing/sdk";

const tmb = new Tmbilling({ apiKey: process.env.TMBILLING_API_KEY!, baseUrl: "http://localhost:4000" });
const biz = await tmb.businesses.create({ name: "Fernhill Analytics", default_currency: "USD" });
const customer = await tmb.customers.create(biz.id, { email: "maya@example.com" });
```

Every write sends an `Idempotency-Key`, so a retried request never charges twice, and every type
comes from the API's OpenAPI document. From any other language, generate a client from
`/openapi.json`. The guide:
[twominutebilling.com/help/developers/getting-started/sdks](https://twominutebilling.com/help/developers/getting-started/sdks).

## Repository

| Path | What |
|---|---|
| [`src/`](./src/README.md) | The billing engine: API, domain modules, provider adapters. Each module has its own README. |
| [`dashboard/`](./dashboard/README.md) | Next.js operator dashboard, hosted checkout and customer portal |
| `db/` | Drizzle schema, the one-file baseline schema (`baseline.sql`), migrations and row-level security policies |
| [`sdk/`](./sdk/README.md) | Typed TypeScript client generated from the OpenAPI spec, published as `@two-minute-billing/sdk` |
| `docs-site/` | Product and API documentation site |
| [`scripts/`](./scripts/README.md) | Setup, seed data and the end-to-end `verify:*` suites |
| `test/` | Unit tests for billing maths |

## Documentation

- **Using it:** the guides in [`docs-site/content`](./docs-site/content), from creating a business
  to going live, also at [twominutebilling.com/help](https://twominutebilling.com/help). Run them
  locally with `pnpm --filter tmbilling-docs dev` (http://localhost:4210).
- **Building on it:** the API reference in the same site, generated from the OpenAPI spec.
- **Changing it:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and
  [`docs/GUIDE.md`](./docs/GUIDE.md) (conventions and how a feature is added end to end).

## Contributing

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the
checks to run and the conventions the code depends on. Your first pull request asks you to sign
the [Contributor License Agreement](./CLA.md).

## Security

Please report vulnerabilities privately, as described in [`SECURITY.md`](./SECURITY.md), not in a
public issue.

## License

The engine, dashboard and docs site are licensed under the
[GNU Affero General Public License v3.0](./LICENSE) (`AGPL-3.0-only`). If you run a modified
version as a network service, you must offer its source to that service's users.

The API client in [`sdk/`](./sdk) (`@two-minute-billing/sdk`) is [MIT](./sdk/LICENSE), so it can be
embedded in any application.

**Third-party data.** AI model prices are synced from
[genai-prices](https://github.com/pydantic/genai-prices) (MIT, copyright Pydantic Services Inc.).
Each installation downloads the list into its own database. The test fixture in
`test/unit/fixtures/` keeps the original notice beside it.
