---
name: two-minute-billing-usage
description: Meter and bill usage with Two Minute Billing — usage events with retry-safe keys, meters and rate cards, AI token billing per model (rate card or the model price list plus a markup), prepaid credits (with a money value, or in the business's own unit with a credit cost per meter), an access check that stops usage when credit runs out, spend limits, alerts, automatic top-up and usage shown in the app. Use when an app charges per API call, GB, minute, seat-hour, outcome or AI token, or sells credits.
license: MIT
metadata:
  homepage: https://twominutebilling.com
  docs: https://twominutebilling.com/help/developers/recipes/meter-usage-events
---

# Usage, AI tokens and credits

The `two-minute-billing` skill's rules hold here: test key only, keys never in the chat, and
`preflight.mjs` before the first write. Code: `references/patterns.md`.

## 1. Write the event contract first

Before any code, agree with the user on one line per billable action and keep it in the repository
(for example `docs/billing-events.md`):

| Action in the app | `event_name` | value property | `key` (unique per action) | `customer` |
|---|---|---|---|---|
| An API request served | `api_call` | none (count) | `call-<request id>` | the account id (usage key) |
| A file stored | `storage_used` | `gb` | `upload-<upload id>` | the account id |

The `key` must come from the action itself (a request, job or upload id), never a random value
made at send time: a retry must send the **same** key, so it counts once. The `customer` is a usage
key — an id the app already has — added to the customer with `tmb.usageKeys.add`.

## 2. Meter and price it

- **Meter:** `event_name`, `aggregation` (`sum`, `count`, `min`, `max`, `avg`, `last`, `unique`,
  `weighted_sum`), `value_property`, optional `group_by` (up to 5) and `filters`. After its first
  counted event or first price, only its name can change: to count differently, add a new meter.
- **Price on the meter:** `model: "usage"` (or `tiered`, `volume`, `package`), `meter`,
  `unit_amount_decimal` in **minor units** with up to 12 decimals, `quantity_divisor` ("per 1,000"),
  and `rates` for a different rate per group value.
- Add both to the catalog file (`two-minute-billing-pricing`), not to app code.

## 3. Send events

- One event: `tmb.usageEvents.send`. Batches: `tmb.usageEvents.sendBatch`, 1–500 events a request.
  These routes take no `Idempotency-Key`; the event `key` deduplicates.
- Send from the place the action completes, after it succeeds. Queue and retry on failure with the
  same key; never drop an event silently.
- Timestamps: RFC 3339, up to 35 days old and 5 minutes ahead. Values: numbers with at most 12
  decimals; send decimals as strings to keep every digit.
- An event for an unknown key is kept as `unmatched` and billed once the key is added.
- A wrong event can be voided until its invoice is finalized; send the correction with a new key.
- A late event (after its period's invoice) bills on the next invoice, the whole period re-rated at
  its own price. After a cancellation it bills only when the business sets
  `billing_rules_config.late_usage_invoices.enabled` (one `late_usage` invoice a day at most).
- Events that come late every time: set `usage_close_delay_minutes` (0–43200, 30 days) on the
  business. The renewal and the new plan credits stay on time; the closed period's invoice stays
  `pending` until `usage_closes_at` (capped at half the billing period), then bills its usage and
  is charged. Webhooks: `subscription_renewed` + `invoice_pending_created` at the renewal;
  `invoice_generated`, `invoice_closed`, `usage_recorded` and payment events at the close.

## 4. AI tokens

One meter, `ai_tokens`, sums `tokens` grouped by `["model", "token_type"]`. After each model call:
`reportAiUsage(tmb, BIZ, response, { customer })` (exported by the SDK). It reads the provider's
usage block (no AI SDK dependency) and keys each event by the response id, so a retried report
counts once.

Price it one of two ways:

- **A rate card:** `rates` with one row per `{ model, token_type }`, in minor units per
  `quantity_divisor` tokens (for example per 1,000,000).
- **The model price list plus a markup:** `amount_source: "model_price_list"` with
  `markup_percent`. The engine keeps a dated copy of public model prices, so new models bill without
  a catalog change, and the dashboard shows the margin per model.

Recipe: https://twominutebilling.com/help/developers/recipes/bill-ai-tokens.md

### AI cost when the app charges per action or in credits

When the customer pays per action (1 credit per image, per report, per minute of audio), the
tokens are not what they buy, but you still want to know what each action cost you. An image can
need several provider calls: a text model that writes the prompt, an image model, a vision model
that checks the result. The model price list can price one image or audio call per `unit`
(`image`, `audio_second`), and a meter can read it with `price_list.unit` (recipe: bill-ai-tokens). An
action that is several provider calls still needs your own `cost` on the event. Send the cost
yourself:

- Bill the action on its own meter (sum of `credits`, or a count): with a price in money, or with
  a credit cost in a unit with no money value (§ 5, "Credits in the business's own unit").
- In the app, add up what the provider calls behind ONE action cost, and send the total as `cost`
  on that action's event: major units as a decimal string, with `currency` (default: the meter's
  `cost_currency`, else the price's currency). A line's cost is the sum of its events' `cost`;
  events without one are costed from your cost or the list price, if the model has one.

```ts
/** One image, one event. `callCostsMicroUsd`: each provider call behind it, in millionths of a dollar. */
export async function recordImage(
  biz: string,
  customer: string,
  imageId: string,
  callCostsMicroUsd: number[],
) {
  const micro = callCostsMicroUsd.reduce((sum, c) => sum + c, 0);
  await tmb.usageEvents.send(biz, {
    key: `image:${imageId}`,
    customer,
    event_name: "images",
    properties: { credits: 1 },
    cost: (micro / 1_000_000).toFixed(6),
    currency: "USD",
  });
}
```

- Optional: also report the token calls with `reportAiUsage` on an `ai_tokens` meter, to see
  usage per model. Do not price that meter, or the customer pays twice.
- Read the margin: `GET /v1/businesses/{biz}/reports/usage_margin?group_by=customer|model|meter`
  (dashboard: **Reports → Usage margin**). Revenue is the usage line after discounts and credit
  notes, before tax; margin is revenue minus cost.

Limits, say them to the user:

- The report reads usage lines of finalized invoices only. A meter with no price makes no line,
  so it shows no margin.
- For usage paid with credits that have a money value, the report's revenue is the line amount
  at the price's rate per unit, not what the customer paid for the credits (a pack sold at a
  discount, or a free grant, is not counted). Compare pack revenue by hand.
- A meter with a credit cost makes no usage line, so `scope=billed` (the default) does not show
  it. With `scope=all` its cost shows as cost only (written each night, up to yesterday), and by
  customer `total_revenue_minor` includes the pack sales. What the credits used earned is
  `revenue_minor` on each settlement: `GET /v1/businesses/{biz}/customers/{cus}/credit_usage`.
  The cost of every event that is not voided counts, a refused one too.

## 5. Credits and stopping usage

For prepaid or credit-based products:

- **Credit units and packs:** a credit unit, packs sold as one-time prices with `grants_credit`,
  and plan credits that renew. https://twominutebilling.com/help/developers/recipes/prepaid-ai-credits.md
- **Ask the user whether a credit has a money value** before you create the unit; it cannot
  change after the first grant. With a value (`minor_per_unit: "60"` = USD 0.60), a usage line is
  priced in money and paid in credits at this rate: give the meter's price the same
  `unit_amount_decimal`. When "1 image = 1 credit" and packs sell at different prices, the credit
  has no money value: `minor_per_unit: null`, see "Credits in the business's own unit" below.
- **`decimals`:** an action that costs 0.5 credit needs `decimals: 1`, and then every `amount` in
  that unit is in tenths (25 credits = `250`), `available_units` too.
- **Plan credits:** `kind: "per_cycle"` on a recurring price. `reset: { "every": "month" }` gives
  monthly credits on a yearly price; `first_window` (`full`, `prorated`, `next_full_window`) sets a
  calendar window that started before the subscription; `on_exhausted` (`block`, `bill`) is the
  plan's policy. A trial gets no plan credits: give a promotional grant by hand for trial credit.
- **Plan changes and credits:** `billing_rules_config.plan_credits` on the business sets
  `on_upgrade` (`full` default, `prorated`, `next_window`) and `on_downgrade` (`next_window`
  default, `full`, `prorated`), in `settings` of `billing.catalog.json` (pricing skill);
  `POST …/subscriptions/{sub}/change` takes `plan_credits` for one change. A downgrade at the end
  of the term grants the lower plan's full credits from the switch. An immediate downgrade under
  `prorated` ends the old plan's credits and grants the part of the lower plan's credits that
  matches the rest of the window.
- **Credits and unpaid invoices:** `plan_credits.grant_when` (`invoice_issued` default,
  `invoice_paid`) sets when a period's plan credits can be spent; under `invoice_paid` they are
  `pending` until the period's invoice is paid. `plan_credits.on_unpaid_cancel` (`keep`,
  `void_unused`) sets what a cancellation for non-payment does to the unused plan credits.
  `GET /v1/businesses/{biz}` shows the values in force. Ask the user which rules they want before
  go-live.
- **A pack-only buyer needs a subscription (units with a money value).** For a meter with a usage
  price, the access check answers `no_subscription` until a live subscription of the customer has
  a price on the meter, even with paid credit. Subscribe each customer to a plan with the meter's
  usage price (a USD 0 Free plan works), and sell packs on top. A unit with no money value needs
  none: a customer with no subscription and a paid pack is allowed, and the check blocks at 0
  (`on_exhausted.source: "no_subscription"`).
- **Blocking** is off until `credit_config.blocking_enabled` is true. Set it in `settings` of
  `billing.catalog.json` and run `tmb push --apply` (pricing skill; script fallback
  `catalog.mjs --apply`): the business PATCH replaces the whole `credit_config`, so it sends the
  stored object with the file's keys on top.
  `credit_config.in_flight_share_bps` (default 5000 = 50%) caps open holds plus the new amount at
  that part of the balance.
  `credit_config.in_flight_applies` sets when: `other_holds_open` applies the cap only while the
  customer has another hold open, so one action at a time can spend the whole balance; `always`
  (the value when the key is absent) applies it to every hold, so a 1-credit action can be
  refused as `in_flight_limit` at 1.5 credits. For an app that runs one action at a time, set
  `in_flight_applies: "other_holds_open"` in the file's `credit_config`.
  `in_flight_limit` is checked before `insufficient_credit`: treat both as "not enough credit" in
  the app.
- **Ask before the expensive action:** `GET /v1/businesses/{biz}/access?customer_key=<key>&meter=<meter>&estimate=<units>`
  → `{ allowed, code, message, available_units, … }`. Refuse the action when `allowed` is false.
  If the check cannot be reached, decide with the user whether to fail open or closed, and write
  that in the code.
- **Spend limits, alerts, automatic top-up:** per customer, managed by API or in the dashboard.
  https://twominutebilling.com/help/developers/recipes/spend-limits-and-auto-top-up.md

### Credits in the business's own unit

For an app where an action costs credits ("1 image = 1 credit, an edit = 0.5") and a credit has no
fixed price. Recipe: https://twominutebilling.com/help/developers/recipes/credits-in-your-own-unit.md

- **The unit:** `POST /v1/businesses/{biz}/credit_units` with `minor_per_unit: null`. The field is
  required: omitting it is a 400. `decimals: 1` allows half a credit; every `amount` in the unit
  is then in tenths. Put the unit (`"minor_per_unit": null`) and each meter's `credit_cost` in
  `billing.catalog.json` (pricing skill); the API is the alternative. Dashboard: **Settings → Credit units**, **Money
  value: No money value**.
- **Grants:** packs (`grants_credit.kind: "pack"`), plan credits (`"per_cycle"`) and grants by
  hand, as for any unit. A grant has `face_minor: 0`; its money is its `cost_basis_minor`
  ("15 credits, bought for USD 9.00" = `amount: 150`, `cost_basis_minor: 900`). Paid credit is
  revenue when it is used, at that cost: USD 0.60 a credit here. What is left at expiry is
  breakage. Plan credits and promotional grants book nothing. `taxed_at_use` is refused.
- **Meter credit cost:** `PUT /v1/businesses/{biz}/meters/{meter}/credit_cost` with `{ unit,
  credits_per_unit, overrides? }`; an override names a plan (`product`) or a `subscription`. The
  subscription's cost wins, then the plan's, then the meter's. The PUT replaces every override.
  Only a `count` meter or a `sum` that is not recurring. A meter that a usage price bills on a
  live subscription refuses a credit cost (409); a price with a rate can be added to a meter with
  a credit cost, and then bills only the usage that credits do not pay. An event costs quantity × `credits_per_unit`, rounded half up to the
  unit's step.
- **The gate at ingest:** each event takes its credits in the transaction that stores it; parallel
  events never take the balance past its overdraft floor (0 unless an overdraft limit is set on
  the unit, a plan or the customer). Not enough credit → **402 `insufficient_credit`** (in a
  batch: that event's `error.code`). The event is stored as refused (`event.credit[].status:
  "refused"`), never billed, and `credit_usage_refused` is sent with the `policy`. Under `bill`,
  an overage price (the rate price of the meter on a live subscription of the customer, or the
  unit's `overage_minor_per_unit`; the meter's comes first) accepts the event and the next period invoice bills the missing credits in
  money; with no overage price `bill` refuses as `block` does. During a free trial (policy source
  `trial`) the default `credit_config.trial_usage: "refuse"` refuses it: no overage, no overdraft
  (`overdraft_only` allows the overdraft limit; `as_paid` applies the paid rules). A refused
  event counts in cost reports, not in usage totals. A replay of
  the key answers 402 again, so send a new key after the customer buys credit. An event that
  captures a credit hold is never refused; the rest is in `credits_uncovered`. A grant pays only
  while its life contains the moment the event arrives.
- **Automatic top-up:** `PUT /v1/businesses/{biz}/customers/{cus}/auto_topup` with `unit`,
  `trigger: "threshold"`, `threshold_units` (credits, decimal), `pack_price` (the pack's price id),
  `method: "fixed"`, `pack_quantity` and the required `monthly_cap_minor`. GET, enable and disable
  take `?unit=<unit>`; without it they answer 404 for a unit top-up. A soft decline is retried
  every `credit_config.auto_topup_retry_hours`; after the last try the top-up is disabled with
  `disabled_reason: "retries_exhausted"`.
- **One customer's policy:** `PATCH /v1/businesses/{biz}/customers/{cus}` with
  `credit_settings: { on_exhausted: "bill" | "block", override_expires_at?, overdraft_limit_minor?: { USD: 500 } }`
  (replaced whole). A customer's overdraft for one unit:
  `PUT …/customers/{cus}/credit_overdraft_limits/{unit}` with `{ "overdraft_limit": <smallest steps> }`.
- **Late events:** an event that arrives within `credit_config.late_event_grace_hours` (default
  12, 0 = off) of its `timestamp` is paid first by the grant live at that timestamp; any other by
  the balance at arrival. Older than 35 days: 422 `timestamp_too_old`. `backfill: true` records
  the usage and spends nothing (`tmb.usageEvents.send` takes `backfill: true`).
- **Settlement:** each hour (events received before the top of the hour) and in the period
  invoice. It draws the credits from the grants and books the revenue. Read it with
  `GET …/customers/{cus}/credit_usage`; `credit_usage_settled` goes only to an endpoint that lists
  it by name. A usage event can be voided until it is settled (then 409).
- **Local webhooks:** `tmb listen --forward http://localhost:<port>/<path>` (verify skill) sends
  `credit_usage_refused` and the top-up events to the app with no tunnel. It sends
  `credit_usage_settled` only while an enabled webhook endpoint of the organization lists that
  type: without one, the engine does not write the event.
- **The invoice:** the period invoice states "Illustrations: 120. Paid with 120 credits." under
  "Usage paid with credits", with no amount and no tax.
- **Free credit limit:** `credit_config.unit_grant_limits.<unit>` (`max_units`,
  `alert_above_units`, in the unit's smallest step) caps a promotional grant by hand. The business
  PATCH replaces `credit_config` whole, but keeps `unit_grant_limits` and
  `late_event_grace_hours` when they are left out. Dashboard: **Settings → Credits**.

```ts
import { TmbillingError } from "@two-minute-billing/sdk";

// once, in a setup script
await api("POST", `/v1/businesses/${BIZ}/credit_units`, {
  id: "credit", name: "credit", plural_name: "credits", currency: "USD",
  minor_per_unit: null, // no money value; required
  decimals: 1,          // half a credit is possible: 15 credits = amount 150
});
await api("PUT", `/v1/businesses/${BIZ}/meters/illustrations/credit_cost`, {
  unit: "credit", credits_per_unit: "1",
});
await api("PUT", `/v1/businesses/${BIZ}/meters/edits/credit_cost`, {
  unit: "credit", credits_per_unit: "0.5",
});

/** On each action. False: the customer's credits did not pay for it. */
export async function chargeEdit(workspaceId: string, editId: string): Promise<boolean> {
  try {
    await tmb.usageEvents.send(BIZ, { key: `edit-${editId}`, customer: workspaceId, event_name: "edit" });
    return true;
  } catch (e) {
    if (e instanceof TmbillingError && e.status === 402) return false; // insufficient_credit
    throw e; // queue it and retry with the same key
  }
}
```

## 6. Show usage in the app

`GET /v1/businesses/{biz}/subscriptions/{sub}/current_usage` returns the usage so far in
the current window. The engine also has a usage widget the app can embed with a short-lived token
(`POST …/customers/{cus}/usage_widget_tokens`).

## Done when

Events sent from the app arrive with status `matched` (`tmb.usageEvents.list` with the meter), a
repeat of a key comes back `duplicate`, and the verify skill's money check passes on an invoice
that bills them.
