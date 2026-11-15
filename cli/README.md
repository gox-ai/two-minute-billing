# @two-minute-billing/cli

[![npm](https://img.shields.io/npm/v/@two-minute-billing/cli?logo=npm)](https://www.npmjs.com/package/@two-minute-billing/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`tmb`, the command line for [Two Minute Billing](https://github.com/gox-ai/two-minute-billing):
check your setup, push a catalog, move a test clock, forward events to your app and create test
payments. Node 20+, no dependencies.

## Install

Run it once without installing:

```sh
npx @two-minute-billing/cli doctor
```

Or add it to your project:

```sh
pnpm add -D @two-minute-billing/cli
pnpm exec tmb doctor
```

## Settings

`tmb` reads these from the environment. It also loads `./.env` when it exists, or the file you
give with `--env-file <path>`. A variable that is already set in the environment wins over the file.

| Variable | Value |
| --- | --- |
| `TMBILLING_URL` | The API host: `https://api.twominutebilling.com` on Cloud, your own API host when self-hosted |
| `TMBILLING_API_KEY` | A **test** key (`sk_test_…`) |
| `TMBILLING_BUSINESS_ID` | The test business (`biz_…`). Each command also takes `--business` |
| `TMBILLING_WEBHOOK_SECRET` | The signing secret your app checks. `tmb webhooks register` writes it. For `tmb listen` alone, any value that your app and `tmb` both read |

`tmb` never prints the key or the webhook secret.

## Commands

| Command | Example |
| --- | --- |
| `doctor`: which server, organization and key mode the key reaches | `tmb doctor` |
| `push`: plan the catalog, coupons, tax regions and settings in `billing.catalog.json`, then apply them | `tmb push billing.catalog.json --apply` |
| `clock`: move a test business's clock (start, advance, status, stop) | `tmb clock advance --by 1m` |
| `check`: compare a real invoice with the figures you expect | `tmb check --expected expected.json --subscription sub_XXXXXXXXXXXX01` |
| `webhooks test`: send signed test events to your local webhook route | `tmb webhooks test --url http://localhost:3000/webhooks/billing` |
| `webhooks register`: create an endpoint and write its secret to `.env` | `tmb webhooks register --url https://app.example.com/webhooks/billing` |
| `listen`: send the business's new events to a local URL, signed | `tmb listen --forward http://localhost:3000/webhooks/billing` |
| `trigger`: create test objects so that real events occur | `tmb trigger purchase` |
| `reset`: delete all the data of a test business | `tmb reset --confirm biz_XXXXXXXXXXXX01` |
| `init`: add the Agent Skills and the setting names to this project | `tmb init` |

Run `tmb <command> --help` for the options and exit codes of each command.

### listen

`tmb listen` gets the business's events every two seconds (`--interval`) and sends each new
one to `--forward`. The body and the `Tmbilling-Signature` and `Tmbilling-Event-Id` headers are
the same as a webhook endpoint gets, so your handler runs its real signature check. Select events
with `--events invoice_paid,payment_failed`. `--since 10m` also sends the events of the last ten
minutes. It sends to `localhost`, `127.0.0.1` or `[::1]` only, unless you add `--allow-remote`.

### trigger

| Scenario | What it does | Events |
| --- | --- | --- |
| `purchase` | A new test customer with the card 4242 4242 4242 4242 buys a one-time price | `invoice_paid`, `payment_succeeded` |
| `payment-failed` | The same with the card 4000 0000 0000 0002, which declines | `payment_failed` |
| `subscription` | A new test customer subscribes to a recurring price | `subscription_created` |

Without `--price`, `tmb` uses the first active price of the correct type and shows its id.

## Rules

- Every command that changes data refuses a key that is not a test key. The server says the
  key's mode (`GET /v1/me`). Only for an older server that does not say it, `tmb` reads the
  `sk_test_` prefix.
- `tmb reset` asks you to type the business id, or takes it with `--confirm`. With no terminal
  and no `--confirm`, it stops. It refuses a live business.
- `tmb init` changes only the example env file (`.env.example`). It never changes `.env`.

## Exit codes

`0` done · `1` bad input or a failed request · `2` a check failed, or the outcome is not the
expected one · `3` the key is not a test key. `tmb doctor` also uses `4` for a live read-only key
with `--allow-live-read`.

## License

MIT
