# @two-minute-billing/sdk

[![npm](https://img.shields.io/npm/v/@two-minute-billing/sdk?logo=npm)](https://www.npmjs.com/package/@two-minute-billing/sdk)
[![Types](https://img.shields.io/npm/types/@two-minute-billing/sdk)](https://www.npmjs.com/package/@two-minute-billing/sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-twominutebilling.com-4E4EDA)](https://twominutebilling.com/help/developers/getting-started/sdks)

Typed, dependency-free TypeScript client for the [Two Minute Billing](https://github.com/gox-ai/two-minute-billing) API.

- Every request and response type is generated from the API's OpenAPI document.
- Every write carries an `Idempotency-Key`, so a retried request never charges twice.
- Uses the platform `fetch`: Node 20+, Deno, Bun and the browser. No dependencies.

## Install

```sh
pnpm add @two-minute-billing/sdk
```

## Use

```ts
import { Tmbilling, TmbillingError } from "@two-minute-billing/sdk";

const tmb = new Tmbilling({
  apiKey: process.env.TMBILLING_API_KEY!,
  baseUrl: process.env.TMBILLING_URL, // your API host; default http://localhost:4000
});

const biz = await tmb.businesses.create({ name: "Fernhill Analytics", default_currency: "USD" });
const customer = await tmb.customers.create(biz.id, { email: "maya@example.com", currency: "USD" });

try {
  await tmb.invoices.collect(biz.id, "inv_XXXXXXXXXXXX01");
} catch (e) {
  if (e instanceof TmbillingError) console.error(e.status, e.type, e.message);
}
```

A write takes `{ idempotencyKey }` in its options to replay one specific request.

### Bill AI usage

`reportAiUsage()` reads the token counts from an AI model response and sends them as usage
events:

```ts
import { reportAiUsage } from "@two-minute-billing/sdk";
```

## Reference

- API reference and guides: the `/help` pages of your deployment's docs site.
- `@two-minute-billing/sdk/openapi.json` is the OpenAPI document this client is built from;
  generate a client in another language from it.

## Versions

The package version is the Two Minute Billing release it was built from. Use the version that
matches your API.

## License

MIT
