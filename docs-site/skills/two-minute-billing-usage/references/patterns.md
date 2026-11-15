# Usage and AI token code

Code for the two-minute-billing-usage skill. `tmb` and `BIZ` are the shared client and business id
from the integrate skill's `references/patterns.md` (server-side only).

## Usage

```ts
// once, in the catalog script
await tmb.meters.create(BIZ, {
  id: "api_calls", name: "API calls", event_name: "api_call", aggregation: "count",
});
await tmb.prices.create(BIZ, {
  product: "pro", id: "pro-api-calls-usd", name: "API calls", model: "usage",
  currency: "USD", interval: "month", meter: "api_calls", unit_amount_decimal: "0.1", // 0.1 cent each
});

// once per customer, when the account is created
await tmb.usageKeys.add(BIZ, customerId, account.id);

// on every billable action
await tmb.usageEvents.send(BIZ, {
  key: `call-${requestId}`,       // unique per event: a retry with the same key counts once
  customer: account.id,           // the usage key, or the cus_… id
  event_name: "api_call",
  properties: {},
});
```

- Batch with `tmb.usageEvents.sendBatch(BIZ, events)`: 1 to 500 events per request.
- Timestamps may be up to 35 days old. An event for an unknown key is kept as `unmatched` and
  billed once the key is added to a customer.
- Values are numbers with at most 12 decimal places; aggregations are `sum`, `count`, `min`,
  `max`, `avg`, `last`, `unique`, `weighted_sum`.
- Full recipe: https://twominutebilling.com/help/developers/recipes/meter-usage-events.md

## AI tokens

```ts
import { reportAiUsage } from "@two-minute-billing/sdk";

// once: a meter that sums tokens per model and token type
await tmb.meters.create(BIZ, {
  id: "ai_tokens", name: "AI tokens", event_name: "ai_tokens",
  aggregation: "sum", value_property: "tokens", group_by: ["model", "token_type"],
});

// after each model call
const response = await openai.chat.completions.create({ /* … */ });
await reportAiUsage(tmb, BIZ, response, { customer: account.id });
```

The helper reads the provider's usage block and sends one event per token type, keyed by the
response id, so a retried report counts once. Price the meter with a rate per model and token
type, or from the built-in model price list with a markup:
https://twominutebilling.com/help/developers/recipes/bill-ai-tokens.md
Prepaid credits and spend limits:
https://twominutebilling.com/help/developers/recipes/prepaid-ai-credits.md

