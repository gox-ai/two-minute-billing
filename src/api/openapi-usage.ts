/**
 * OpenAPI for usage metering (design G1a § 5): meters, usage events, customer usage keys,
 * and the meter fields on prices, invoice lines and businesses. Spread into `openapi.ts`.
 */

const biz = {
  name: "biz",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The business's id (biz_…).",
};
const cus = {
  name: "cus",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The customer's id (cus_…).",
};
const meterParam = {
  name: "meter",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The meter's id: the slug you chose.",
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(name) } },
});
const err = (description: string) => json("Error", description);
const q = (
  name: string,
  description: string,
  schema: Record<string, unknown> = { type: "string" },
) => ({
  name,
  in: "query",
  required: false,
  schema,
  description,
});
const rateLimitHeaders = {
  "X-RateLimit-Limit": {
    description: "Usage requests allowed each second for your organization.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Remaining": {
    description: "Requests left in the current second.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Reset": {
    description: "When the window resets, in epoch seconds.",
    schema: { type: "integer" },
  },
};
const tooMany = {
  description:
    "Your organization sent more usage requests in one second than its limit. Send again after `Retry-After` seconds.",
  headers: {
    ...rateLimitHeaders,
    "Retry-After": { description: "Seconds to wait.", schema: { type: "integer" } },
  },
  content: { "application/json": { schema: ref("Error") } },
};

const DECIMAL =
  'A decimal string with at most 12 decimal places and no exponent, for example `"0.000125"`.';

/** Ingest routes take a per-event `key` instead of the `Idempotency-Key` header. */
export const USAGE_IDEMPOTENCY_EXEMPT = [
  "post /v1/businesses/{biz}/usage_events",
  "post /v1/businesses/{biz}/usage_events/batch",
];

export const USAGE_PATHS = {
  "/v1/businesses/{biz}/meters": {
    get: {
      tags: ["Usage"],
      summary: "List meters",
      parameters: [biz, q("include_archived", "Include archived meters.", { type: "boolean" })],
      responses: { "200": json("MeterList", "The business's meters.") },
    },
    post: {
      tags: ["Usage"],
      summary: "Create a meter",
      description:
        "A meter is a read-time view over usage events: it counts every retained event with its " +
        "`event_name` that passes its `filters`, including events received before the meter " +
        "existed. Several meters can read the same event name. Needs `meters:manage`.",
      parameters: [biz],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("MeterCreate") } },
      },
      responses: {
        "201": json("Meter", "The meter."),
        "400": err("The body is not correct."),
        "409": err("A meter with this key already exists."),
      },
    },
  },
  "/v1/businesses/{biz}/meters/{meter}": {
    get: {
      tags: ["Usage"],
      summary: "Retrieve a meter",
      parameters: [biz, meterParam],
      responses: { "200": json("Meter", "The meter."), "404": err("No such meter.") },
    },
    patch: {
      tags: ["Usage"],
      summary: "Update a meter",
      description:
        "After the first counted event or the first price on the meter, only `name` can change. " +
        "Any other field is refused with 409: create a new meter instead.",
      parameters: [biz, meterParam],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("MeterUpdate") } },
      },
      responses: {
        "200": json("Meter", "The meter."),
        "404": err("No such meter."),
        "409": err("The meter has usage, so this field cannot change."),
      },
    },
  },
  "/v1/businesses/{biz}/meters/{meter}/archive": {
    post: {
      tags: ["Usage"],
      summary: "Archive a meter",
      description:
        "Refused while an active price, or a price on a live subscription item, uses the meter. An archived meter " +
        "cannot be priced and still counts events for open periods.",
      parameters: [biz, meterParam],
      responses: {
        "200": json("Meter", "The archived meter."),
        "409": err("An active price or a live subscription bills this meter."),
      },
    },
  },
  "/v1/businesses/{biz}/usage_events": {
    get: {
      tags: ["Usage"],
      summary: "List usage events",
      description: "Cursor-paginated, newest first. Needs `usage_events:view`.",
      parameters: [
        biz,
        q("customer", "Events matched to this customer (cus_…)."),
        q("customer_key", "Events sent with this usage key."),
        q("meter", "Events that count toward this meter."),
        q("key", "The event with this key."),
        q("status", "matched, unmatched or voided.", {
          type: "string",
          enum: ["matched", "unmatched", "voided"],
        }),
        q("timestamp[gte]", "Event time on or after (unix seconds)."),
        q("timestamp[lt]", "Event time before (unix seconds)."),
        q("received[gte]", "Received on or after (unix seconds)."),
        q("received[lt]", "Received before (unix seconds)."),
        q("limit", "Page size.", { type: "integer", minimum: 1, maximum: 1000 }),
        q("starting_after", "The `next_cursor` of the previous page."),
      ],
      responses: { "200": json("UsageEventList", "A page of usage events.") },
    },
    post: {
      tags: ["Usage"],
      summary: "Send a usage event",
      description:
        "The event's `key` makes the call safe to retry: a repeat key returns the stored event " +
        "with status `duplicate` and changes nothing, even if its timestamp or values differ. " +
        "Keys are kept 35 days. The `Idempotency-Key` header is not used. The event is stored " +
        "before we answer. An event whose customer key matches no customer is kept as " +
        "unmatched and bills once you add the key to a customer. Needs `usage_events:manage`.\n\n" +
        "**A meter with a credit cost.** The event's credits are taken from the customer's balance " +
        "in the same transaction that stores the event. A credit grant pays only while its " +
        "window contains the time the event arrives: a grant that starts later does not pay, and " +
        "a grant that ended pays only a late event, as described below. When the customer does " +
        "not have sufficient credit, the policy decides. Under `bill` with a money price (the " +
        "meter's own usage price on the customer's subscription, else the credit unit's price " +
        "per credit) the event is accepted: credits pay what they can and the rest is billed on " +
        "the next invoice of the subscription (`credit.credits_uncovered`). Otherwise the " +
        "balance may go below zero down to the overdraft limit (default 0); the next grant or " +
        "top-up pays that part first. Past the limit the answer is 402 `insufficient_credit`: " +
        "the event is stored, it is not billed, and a `credit_usage_refused` event is written, " +
        "with the `policy` that applied. A repeat of its key answers 402 again. An event that arrives within the business's `late_event_grace_hours` (default " +
        "12) of its `timestamp` is paid first by a credit grant that was live at that timestamp, " +
        "even if the grant ended since; a later event is paid by the balance at arrival. Send " +
        "`backfill: true` to record usage and spend no credits.",
      parameters: [biz],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("UsageEventCreate") } },
      },
      responses: {
        "200": {
          ...json("UsageEventResult", "A duplicate: the stored event."),
          headers: rateLimitHeaders,
        },
        "201": {
          ...json("UsageEventResult", "The event was recorded."),
          headers: rateLimitHeaders,
        },
        "400": err("The body is not correct."),
        "402": err(
          "`insufficient_credit`: a meter with a credit cost, and the customer does not have sufficient credit. The event is stored and is not billed.",
        ),
        "422": err(
          "The event was refused: `timestamp_too_old`, `timestamp_in_future` or `invalid_value`.",
        ),
        "429": tooMany,
      },
    },
  },
  "/v1/businesses/{biz}/usage_events/batch": {
    post: {
      tags: ["Usage"],
      summary: "Send up to 500 usage events",
      description:
        "One result for each event, in order. A refused event does not stop the others. The " +
        "batch counts as one request against the rate limit. 400 only for a malformed body or " +
        "more than 500 events. An event refused with `insufficient_credit` (a meter with a " +
        "credit cost) is stored and is not billed.",
      parameters: [biz],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("UsageEventBatchCreate") } },
      },
      responses: {
        "200": {
          ...json("UsageEventBatchResult", "A result for each event."),
          headers: rateLimitHeaders,
        },
        "400": err("The body is not correct, or it has more than 500 events."),
        "429": tooMany,
      },
    },
  },
  "/v1/businesses/{biz}/usage_events/void": {
    post: {
      tags: ["Usage"],
      summary: "Void a usage event",
      description:
        "Allowed while no finalized invoice bills the event's period. The event stays on record " +
        "with `voided_at`; send a replacement with a new key. `timestamp` is required for an " +
        "event older than 35 days. Credits the event took go back to the customer's balance. " +
        "Credits a settlement already drew are given back by a correcting settlement: the grant " +
        "gets them back (a grant that ended since gives them as a new grant that expires in 12 " +
        "months) and the revenue they booked is reversed. Refused while an invoice bills the " +
        "event's usage beyond the credits: issue a credit note instead.",
      parameters: [biz],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("UsageEventVoid") } },
      },
      responses: {
        "200": json("UsageEventResult", "The voided event."),
        "404": err("No such event."),
        "409": err(
          "An invoice already bills its period or its usage beyond the credits (issue a credit note instead).",
        ),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/usage_keys": {
    get: {
      tags: ["Usage"],
      summary: "List a customer's usage keys",
      parameters: [biz, cus],
      responses: { "200": json("UsageKeyList", "The customer's usage keys.") },
    },
    post: {
      tags: ["Usage"],
      summary: "Add a usage key",
      description:
        "Events already sent with this key are matched to the customer and billed: in their own " +
        "period while it is open, else on the next invoice as usage from that period. A key " +
        "belongs to one customer. Needs `customers:manage`.",
      parameters: [biz, cus],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("UsageKeyWrite") } },
      },
      responses: {
        "201": json("UsageKey", "The usage key."),
        "409": err("Another customer has this key. Remove it there first."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/usage_keys/remove": {
    post: {
      tags: ["Usage"],
      summary: "Remove a usage key",
      description: "Events already matched stay with the customer.",
      parameters: [biz, cus],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("UsageKeyWrite") } },
      },
      responses: {
        "200": json("UsageKey", "The removed usage key."),
        "404": err("The customer has no such key."),
      },
    },
  },
  "/v1/businesses/{biz}/meters/{meter}/credit_cost": {
    get: {
      tags: ["Usage"],
      summary: "Retrieve a meter's credit cost",
      parameters: [biz, meterParam],
      responses: {
        "200": json("MeterCreditCost", "The credit cost."),
        "404": err("No such meter, or the meter has no credit cost."),
        "409": err("A price on a subscription bills the meter."),
      },
    },
    put: {
      tags: ["Usage"],
      summary: "Set a meter's credit cost",
      description:
        "States what one unit of the meter costs in credits of a credit unit that has no money " +
        "rate, for example `1` credit for an image and `0.5` for an edit. From then on each usage " +
        "event of the meter takes its credits from the customer's balance when it arrives. " +
        "`overrides` change the cost for a plan or for one subscription: a subscription's cost " +
        "applies first, then a plan's, then the meter's. The request replaces the whole cost: an " +
        "override that is not in `overrides` is removed. A usage price of the meter (a rate, " +
        "not event amounts) then bills only the usage that credits do not pay. Refused for a " +
        "credit unit that has a money rate, for a meter that a price on a subscription already " +
        "bills in money, and for a meter that does not count events or add a value. " +
        "Needs `meters:manage`.",
      parameters: [biz, meterParam],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("MeterCreditCostSet") } },
      },
      responses: {
        "200": json("MeterCreditCost", "The credit cost."),
        "400": err("The body is not correct, or the credit unit has a money rate."),
        "404": err("No such meter, credit unit, product or subscription."),
        "409": err(
          "A price on a subscription bills the meter in money, or the meter was paid in a different unit.",
        ),
      },
    },
    delete: {
      tags: ["Usage"],
      summary: "Remove a meter's credit cost",
      description:
        "Events received from then on spend no credits. Credits already taken stay taken. " +
        "Refused while a price on a subscription bills the meter. Needs `meters:manage`.",
      parameters: [biz, meterParam],
      responses: {
        "200": json("MeterCreditCostDeleted", "The credit cost was removed."),
        "404": err("No such meter, or the meter has no credit cost."),
      },
    },
  },
};

const aggregation = {
  type: "string",
  enum: ["sum", "count", "min", "max", "avg", "last", "unique", "weighted_sum"],
  description:
    "How events combine in a period. `avg` = total of the values ÷ number of events. `unique` " +
    "counts distinct values of `unique_property`. `weighted_sum` bills a level × the time it held.",
};
const meterFields = {
  name: { type: "string", maxLength: 200, example: "AI tokens" },
  event_name: { type: "string", example: "ai_tokens", description: "The event name it reads." },
  aggregation,
  value_property: {
    type: "string",
    nullable: true,
    example: "tokens",
    description: "The property holding the number. Required except for `count`.",
  },
  unique_property: {
    type: "string",
    nullable: true,
    description: "`unique` only: the property whose distinct values are counted.",
  },
  recurring: {
    type: "boolean",
    description: "sum, last, max and unique only: the level carries into the next period.",
  },
  time_unit: {
    type: "string",
    enum: ["hour", "day"],
    nullable: true,
    description: "`weighted_sum` only.",
  },
  filters: {
    type: "object",
    additionalProperties: {
      type: "array",
      items: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
    },
    example: { region: ["eu", "us"] },
    description: "An event counts only when every listed property has one of its values.",
  },
  group_by: {
    type: "array",
    maxItems: 5,
    items: { type: "string" },
    example: ["model", "token_type"],
    description: "Up to 5 property names, in order. A price can set a rate for each combination.",
  },
  limit_dimensions: {
    type: "array",
    maxItems: 3,
    items: { type: "string" },
    example: ["user"],
    description:
      "Up to 3 event properties a spend limit can name (`property_key`), so each value of the property has its own limit. Can change after the meter has usage.",
  },
  price_list: {
    type: "object",
    nullable: true,
    properties: {
      provider: { type: "string", description: "The list provider for every event." },
      provider_key: { type: "string", description: "Or: the group key that names the provider." },
      model_key: {
        type: "string",
        description: "The group key that names the model. Default `model`.",
      },
      token_type: {
        type: "string",
        description: "The token type for every event, such as `input`.",
      },
      token_type_key: {
        type: "string",
        description: "Or: the group key that names the token type.",
      },
      unit: {
        type: "string",
        enum: [
          "token",
          "request",
          "image",
          "video_second",
          "audio_second",
          "character",
          "page",
          "pixel",
        ],
        description:
          "The list unit an event quantity counts, such as `audio_second` or `image`. Not set: `token`, else `request`.",
      },
      quality: {
        type: "string",
        description:
          "The price tier for every event, such as `hd`. Stored trimmed and in lower case.",
      },
      quality_key: {
        type: "string",
        description: "Or: the group key that names the quality.",
      },
      resolution: {
        type: "string",
        description:
          "The resolution tier for every event, such as `1024x1024`. Stored trimmed and in lower case.",
      },
      resolution_key: {
        type: "string",
        description: "Or: the group key that names the resolution.",
      },
    },
    example: { provider: "openai", token_type_key: "token_type" },
    description:
      "Maps each combination to a model price list key, for `model_price_list` prices and line cost. Each key it reads must be in `group_by`. With a quality or resolution, the price is the row with both tiers, else the same quality only, else the same resolution only, else the row with no tier. Can change after the meter has usage.",
  },
  cost_currency: {
    type: "string",
    nullable: true,
    minLength: 3,
    maxLength: 3,
    description:
      "The currency of event `cost` for events that name none. Null = the price's currency.",
  },
};

const eventProps = {
  key: {
    type: "string",
    minLength: 1,
    maxLength: 255,
    example: "resp_XXXXXXXXXXXX01:input",
    description: "Your idempotency key for this event, unique per business.",
  },
  customer: {
    type: "string",
    example: "workspace-4821",
    description: "A usage key of the customer, or the customer id (cus_…).",
  },
  event_name: { type: "string", example: "ai_tokens" },
  timestamp: {
    type: "string",
    format: "date-time",
    description:
      "RFC 3339 with `Z` or an offset. From 35 days in the past to 5 minutes in the future. Default: now.",
  },
  properties: {
    type: "object",
    maxProperties: 50,
    additionalProperties: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
    example: { model: "large-v2", token_type: "input", tokens: 1200 },
    description:
      "Flat, up to 50 keys and 8 KB. A meter's value property must be a number from -10^12 to 10^12 with at most 12 decimal places; a number is read from its exact text.",
  },
  amount: { type: "string", description: `Major units, from -10^12 to 10^12. ${DECIMAL}` },
  cost: { type: "string", description: `Your cost, major units, from -10^12 to 10^12. ${DECIMAL}` },
  currency: {
    type: "string",
    minLength: 3,
    maxLength: 3,
    description: "Default: the price's currency.",
  },
};

export const USAGE_SCHEMAS = {
  MeterCreate: {
    type: "object",
    required: ["name", "event_name", "aggregation"],
    properties: {
      id: {
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$",
        example: "ai_tokens",
        description: "The meter's id. Omit and we make one from the name. Fixed after create.",
      },
      ...meterFields,
    },
  },
  MeterUpdate: {
    type: "object",
    properties: {
      ...meterFields,
      expected_version: { type: "integer", description: "Refuse the write if the meter changed." },
    },
  },
  Meter: {
    type: "object",
    required: ["object", "id", "name", "event_name", "aggregation", "status"],
    properties: {
      object: { type: "string", enum: ["meter"] },
      id: { type: "string", example: "ai_tokens" },
      ...meterFields,
      status: { type: "string", enum: ["active", "archived"] },
      locked: {
        type: "boolean",
        description: "True once the meter has a counted event or a price: only `name` can change.",
      },
      credit_cost: {
        allOf: [ref("MeterCreditCost")],
        nullable: true,
        description:
          "What one unit of the meter costs in credits. Null = the meter has no credit cost. Set it with `PUT …/meters/{meter}/credit_cost`.",
      },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      resource_version: { type: "integer" },
    },
  },
  MeterList: {
    type: "object",
    required: ["object", "data"],
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: ref("Meter") },
      has_more: { type: "boolean" },
      next_cursor: { type: "string", nullable: true },
    },
  },
  UsageEventCreate: {
    type: "object",
    required: ["key", "customer", "event_name"],
    properties: {
      ...eventProps,
      backfill: {
        type: "boolean",
        default: false,
        description:
          "For a meter with a credit cost: record the usage and spend no credits. No effect on any other meter.",
      },
    },
  },
  MeterCreditCostSet: {
    type: "object",
    required: ["unit", "credits_per_unit"],
    properties: {
      unit: {
        type: "string",
        example: "credit",
        description: "The id of a credit unit that has no money rate. A meter keeps its unit.",
      },
      credits_per_unit: {
        type: "string",
        example: "0.5",
        description:
          "Credits for one unit of the meter: more than 0, at most 6 decimal places. A number is accepted too.",
      },
      overrides: {
        type: "array",
        maxItems: 500,
        items: ref("MeterCreditCostOverride"),
        description: "The cost for a plan or for one subscription. Omit for none.",
      },
    },
  },
  MeterCreditCostOverride: {
    type: "object",
    required: ["credits_per_unit"],
    description: "Send `product` (a plan) or `subscription`, not both.",
    properties: {
      product: { type: "string", example: "pro-plan", description: "A plan's product id." },
      subscription: { type: "string", example: "sub_XXXXXXXXXXXX01" },
      credits_per_unit: { type: "string", example: "0.4" },
    },
  },
  MeterCreditCost: {
    type: "object",
    required: ["unit", "credits_per_unit", "overrides"],
    properties: {
      object: { type: "string", enum: ["meter_credit_cost"] },
      meter: { type: "string", example: "illustrations" },
      unit: { type: "string", example: "credit" },
      credits_per_unit: { type: "string", example: "1" },
      overrides: { type: "array", items: ref("MeterCreditCostOverride") },
    },
  },
  MeterCreditCostDeleted: {
    type: "object",
    required: ["object", "meter", "deleted"],
    properties: {
      object: { type: "string", enum: ["meter_credit_cost"] },
      meter: { type: "string" },
      deleted: { type: "boolean", enum: [true] },
    },
  },
  UsageEventCredit: {
    type: "object",
    description: "What a meter with a credit cost did with the event.",
    properties: {
      meter: { type: "string" },
      unit: { type: "string" },
      status: {
        type: "string",
        enum: ["taken", "pending", "settled", "refused", "skipped"],
        description:
          "`taken`: the credits left the balance and wait for settlement. `pending`: a credit grant that ended pays, and its grace window is open. `settled`: drawn from the grants. `refused` and `skipped`: no credits were spent, and the event is never billed.",
      },
      reason: {
        type: "string",
        nullable: true,
        enum: ["insufficient_credit", "backfill", "unmatched_customer", "voided", null],
        description: "Why no credits were spent. Null for a billed event.",
      },
      quantity: { type: "string", description: "The event's quantity on the meter." },
      credits_per_unit: { type: "string" },
      cost_source: { type: "string", enum: ["meter", "plan", "subscription"] },
      credits_due: { type: "string", description: "What the event costs." },
      credits_taken: { type: "string" },
      credits_from_closed_grant: {
        type: "string",
        description: "The part a credit grant that ended paid, in its grace window.",
      },
      credits_uncovered: {
        type: "string",
        description:
          "The part that credits did not pay and that is billed in money (see `overage_basis`). Under `bill`, when the meter or the credit unit has a money price, the event is accepted and this part goes on the next invoice of the customer's subscription as a usage line.",
      },
      overage_basis: {
        type: "string",
        nullable: true,
        enum: ["meter", "unit", null],
        description:
          "What bills `credits_uncovered`: `meter`, the meter's own usage price on the customer's subscription (it wins); `unit`, the credit unit's price per credit. Null when nothing bills it.",
      },
      credits_overdrawn: {
        type: "string",
        description:
          "The part taken below zero, inside the overdraft limit, that no grant has paid back and no invoice bills yet. The next grant or top-up pays it first.",
      },
      covered_by_hold: { type: "boolean" },
      credits_past_hold: {
        type: "string",
        description:
          "The part past the hold that the capture did not charge, when `credit_config.capture_over_hold` is `cap_at_hold`. It is recorded and never billed. `credits_taken` does not include it.",
      },
    },
  },
  UsageEventBatchCreate: {
    type: "object",
    required: ["events"],
    properties: {
      events: { type: "array", minItems: 1, maxItems: 500, items: ref("UsageEventCreate") },
    },
  },
  UsageEvent: {
    type: "object",
    required: ["object", "id", "key", "customer_key", "event_name", "timestamp", "status"],
    properties: {
      object: { type: "string", enum: ["usage_event"] },
      id: { type: "string" },
      ...eventProps,
      customer: {
        type: "string",
        nullable: true,
        example: "cus_XXXXXXXXXXXX01",
        description: "The matched customer, or null while no usage key matches.",
      },
      customer_key: { type: "string", description: "The customer value the event was sent with." },
      amount: { type: "string", nullable: true },
      cost: { type: "string", nullable: true },
      currency: { type: "string", nullable: true },
      status: { type: "string", enum: ["matched", "unmatched", "voided"] },
      meters: {
        type: "array",
        items: { type: "string" },
        description: "Keys of the meters the event counts toward.",
      },
      flags: {
        type: "array",
        items: { type: "string" },
        description: "`no_meter`: no active meter reads its name. `currency_mismatch`: not billed.",
      },
      created_at: { type: "string", format: "date-time", description: "When we received it." },
      voided_at: { type: "string", format: "date-time", nullable: true },
      void_reason: { type: "string", nullable: true },
      refused_at: {
        type: "string",
        format: "date-time",
        nullable: true,
        description:
          "Set when a meter that is paid in credits refused the event because the customer did not have sufficient credit. The event is stored and listed. It does not count in usage totals. Its cost still counts in cost and margin reports.",
      },
      credit: {
        type: "array",
        items: ref("UsageEventCredit"),
        description:
          "Present only when a meter with a credit cost counted the event: one entry for each such meter.",
      },
    },
  },
  UsageEventResult: {
    type: "object",
    required: ["event", "status"],
    properties: {
      event: ref("UsageEvent"),
      status: { type: "string", enum: ["created", "duplicate", "voided"] },
    },
  },
  UsageEventBatchResult: {
    type: "object",
    required: ["results", "created", "duplicates", "errors"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "key", "status"],
          properties: {
            index: { type: "integer" },
            key: { type: "string" },
            status: { type: "string", enum: ["created", "duplicate", "error"] },
            error: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  example: "timestamp_too_old",
                  description:
                    "timestamp_too_old, timestamp_in_future, invalid_value, insufficient_credit (stored, not billed), …",
                },
                message: { type: "string" },
              },
            },
          },
        },
      },
      created: { type: "integer" },
      duplicates: { type: "integer" },
      errors: { type: "integer" },
    },
  },
  UsageEventList: {
    type: "object",
    required: ["object", "data", "has_more"],
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: ref("UsageEvent") },
      has_more: { type: "boolean" },
      next_cursor: { type: "string", nullable: true },
      total: { type: "integer", nullable: true, description: "First page only." },
    },
  },
  UsageEventVoid: {
    type: "object",
    required: ["key"],
    properties: {
      key: { type: "string" },
      timestamp: {
        type: "string",
        format: "date-time",
        description: "The event's timestamp. Required past 35 days.",
      },
      reason: { type: "string", maxLength: 500, description: "Why the event is voided." },
    },
  },
  UsageKeyWrite: {
    type: "object",
    required: ["key"],
    properties: {
      key: { type: "string", minLength: 1, maxLength: 255, example: "workspace-4821" },
    },
  },
  UsageKey: {
    type: "object",
    required: ["object", "key"],
    properties: {
      object: { type: "string", enum: ["usage_key"] },
      key: { type: "string" },
      customer: { type: "string", example: "cus_XXXXXXXXXXXX01" },
      created_at: { type: "string", format: "date-time" },
    },
  },
  UsageKeyList: {
    type: "object",
    required: ["object", "data"],
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: ref("UsageKey") },
    },
  },
  PriceRate: {
    type: "object",
    required: ["match"],
    properties: {
      match: {
        type: "object",
        additionalProperties: { type: "string" },
        example: { model: "large-v2", token_type: "output" },
        description:
          "Group values over some of the meter's `group_by`. The row naming the most values wins, then the oldest.",
      },
      unit_amount_decimal: {
        type: "string",
        description: `Minor units per \`quantity_divisor\` units. ${DECIMAL}`,
      },
      markup_percent: {
        type: "string",
        nullable: true,
        description:
          "`model_price_list` and `event_cost_or_list` only: percent over the price's markup base (and, for `event_cost_or_list`, over the events' own cost), in place of a fixed rate.",
      },
      tiers: {
        type: "array",
        nullable: true,
        items: { type: "object" },
        description:
          "Tiers in the price's model: `up_to`, `unit_amount_decimal`, `flat_amount_minor`.",
      },
    },
  },
};

/** Fields added to PriceCreate, PriceUpdate and Price. */
export const METER_PRICE_FIELDS = {
  meter: {
    type: "string",
    nullable: true,
    example: "ai_tokens",
    description:
      "Bill from this meter's events. Models usage, tiered, volume or package. The usage aggregation is copied from the meter. Fixed after create.",
  },
  unit_amount_decimal: {
    type: "string",
    nullable: true,
    example: "300",
    description: `The default rate: minor units per \`quantity_divisor\` units. ${DECIMAL} "$3 per 1M tokens" is \`"300"\` with divisor 1000000.`,
  },
  quantity_divisor: {
    type: "integer",
    minimum: 1,
    example: 1000000,
    description: "The rate is per this many units. Default 1.",
  },
  amount_source: {
    type: "string",
    enum: ["rate", "event_amount", "event_cost", "model_price_list", "event_cost_or_list"],
    description:
      "`rate` (default): quantity × rate. `event_amount`: the sum of the events' `amount`. `event_cost`: the sum of `cost` × (1 + `markup_percent` ÷ 100). `model_price_list`: each combination at the selling rate: a fixed rate in `rates`, else its markup base × (1 + markup ÷ 100); a combination with no base bills `unit_amount_decimal`. `event_cost_or_list`: the events that carry a `cost` bill that cost × (1 + markup ÷ 100), on their own line; the events without one (or with a cost in another currency) bill as `model_price_list`; a fixed rate for a combination wins over both. The last two: the usage model only, on a sum or count meter with a `price_list` mapping.",
  },
  markup_percent: {
    type: "string",
    nullable: true,
    example: "20",
    description:
      "`event_cost`, `model_price_list` and `event_cost_or_list` only: a decimal percent, 0 or more, up to 6 decimal places.",
  },
  markup_base: {
    type: "string",
    nullable: true,
    enum: ["list", "cost", null],
    description:
      "`model_price_list` and `event_cost_or_list` only. `list` (default): the model price list, else your cost. `cost`: your cost, else the list.",
  },
  rates: {
    type: "array",
    maxItems: 500,
    items: { $ref: "#/components/schemas/PriceRate" },
    description: "The rate card. A combination that no row names bills at the price's own rate.",
  },
};

/** Fields added to every invoice line. */
export const LINE_DECIMAL_FIELDS = {
  quantity_decimal: {
    type: "string",
    example: "1234567",
    description:
      "The line's quantity, up to 12 decimal places. Read this, not `quantity`: a meter line carries its quantity here only.",
  },
  unit_amount_decimal: {
    type: "string",
    example: "0.0003",
    description:
      "The rate per unit in minor units, up to 12 decimal places. Read this, not `unit_amount_minor`.",
  },
};

export const USAGE_CLOSE_DELAY_FIELD = {
  usage_close_delay_minutes: {
    type: "integer",
    minimum: 0,
    maximum: 43200,
    description:
      "The usage grace window in minutes, 0 to 43200 (30 days), for apps that send events late. A metered subscription renews on time and its new period's plan credits start on time; only the invoice of the period that closed waits, for this long after the period ends plus about 6 minutes, so usage that arrives in the grace bills on it. The wait is never more than half the plan's billing interval or half the new period. Usage that arrives after the invoice finalizes bills on the next invoice. Only an invoice with metered usage waits. 0 = the invoice finalizes about 6 minutes after the period ends.",
  },
};
