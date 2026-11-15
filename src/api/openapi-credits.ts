/**
 * OpenAPI for credits (design G3 § 7): credit units, credit grants, the credit transaction
 * list, credit holds and the access check. Spread into `openapi.ts`.
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
const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});
const unitParam = pathParam("unit", "The credit unit's id: the slug you chose.");
const grantParam = pathParam("grant", "The credit grant's id (cgr_…).");
const holdParam = pathParam("hold", "The credit hold's id (chd_…).");
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
) => ({ name, in: "query", required: false, schema, description });
const limit = (max: number, dflt: number) =>
  q("limit", `Page size, 1 to ${max}. Default ${dflt}.`, {
    type: "integer",
    minimum: 1,
    maximum: max,
  });
const after = q("starting_after", "The `next_cursor` of the previous page.");
const int = (description: string) => ({ type: "integer", description });
const str = (description: string) => ({ type: "string", description });
const nullable = (schema: Record<string, unknown>) => ({ ...schema, nullable: true });
const list = (item: string, description: string) => ({
  type: "object",
  description,
  properties: {
    object: { type: "string", enum: ["list"] },
    data: { type: "array", items: ref(item) },
    has_more: { type: "boolean" },
    next_cursor: nullable(str("Send as `starting_after` for the next page.")),
  },
  required: ["object", "data", "has_more", "next_cursor"],
});

const RATE =
  "Minor units of `currency` per 1 unit, as a decimal string with at most 12 decimal places. " +
  'For "1 credit = USD 0.01" send `"1"`.';
const INSTANT = "Unix seconds, or an ISO 8601 date-time with an offset.";
const CODES = [
  "ok",
  "insufficient_credit",
  "spend_limit_reached",
  "in_flight_limit",
  "no_subscription",
  "not_entitled",
];

export const CREDIT_PATHS = {
  "/v1/businesses/{biz}/credit_units": {
    get: {
      tags: ["Credits"],
      summary: "List credit units",
      parameters: [
        biz,
        limit(1000, 100),
        after,
        q("status", "Only units in this status.", { type: "string", enum: ["active", "archived"] }),
      ],
      responses: { "200": json("CreditUnitList", "The business's credit units.") },
    },
    post: {
      tags: ["Credits"],
      summary: "Create a credit unit",
      description:
        "Your own unit of credit. Send `minor_per_unit` to give the unit a money rate. Send " +
        "`minor_per_unit: null` for a unit with no rate: its credits are counted in units only, " +
        "and a grant in it has no money value. `minor_per_unit` is required: a request without " +
        "the field is refused with 400 (send a rate, or null for a unit with no money value). " +
        "The first grant in the unit fixes `currency`, `minor_per_unit` and " +
        "`decimals`. Needs `credits:manage`.",
      parameters: [biz],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("CreditUnitCreate") } },
      },
      responses: {
        "201": json("CreditUnit", "The credit unit."),
        "400": err("The body is not correct."),
        "409": err("A credit unit with this id already exists."),
      },
    },
  },
  "/v1/businesses/{biz}/credit_units/{unit}": {
    get: {
      tags: ["Credits"],
      summary: "Retrieve a credit unit",
      parameters: [biz, unitParam],
      responses: {
        "200": json("CreditUnit", "The credit unit."),
        "404": err("No such credit unit."),
      },
    },
    patch: {
      tags: ["Credits"],
      summary: "Update a credit unit",
      description:
        "After the first grant in the unit (`locked: true`), only `name` and `plural_name` can " +
        "change. A change to `currency`, `minor_per_unit` or `decimals` is refused with 409: create " +
        "a new unit instead.",
      parameters: [biz, unitParam],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("CreditUnitUpdate") } },
      },
      responses: {
        "200": json("CreditUnit", "The credit unit."),
        "404": err("No such credit unit."),
        "409": err("A credit grant uses this unit, so this field cannot change."),
      },
    },
  },
  "/v1/businesses/{biz}/credit_units/{unit}/archive": {
    post: {
      tags: ["Credits"],
      summary: "Archive a credit unit",
      description: "An archived unit takes no new grant. Grants that use it stay as they are.",
      parameters: [biz, unitParam],
      responses: {
        "200": json("CreditUnit", "The archived unit."),
        "404": err("No such credit unit."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_grants": {
    get: {
      tags: ["Credits"],
      summary: "List a customer's credit grants",
      parameters: [
        biz,
        cus,
        limit(1000, 50),
        after,
        q("status", "Only grants in this status.", {
          type: "string",
          enum: ["pending", "active", "expired", "voided"],
        }),
        q("category", "Only grants in this category.", {
          type: "string",
          enum: ["paid", "promotional"],
        }),
        q("currency", "Only grants in this currency (ISO 4217)."),
      ],
      responses: { "200": json("CreditGrantList", "The customer's credit grants, newest first.") },
    },
    post: {
      tags: ["Credits"],
      summary: "Give credit",
      description:
        "`category: promotional` (the default) books the credit at once. `category: paid` also " +
        "needs `invoices:manage`: it creates an invoice for `price_minor` (the net price, which is " +
        "the cost basis) taxed by `tax_treatment`, and a `pending` grant that becomes `active` when " +
        "the invoice is paid. With `mark_paid` the invoice is recorded as paid in the same request, " +
        "so the response shows `active`. Paid credit never exists without an invoice. Needs " +
        "`credits:manage`.",
      parameters: [biz, cus],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("CreditGrantCreate") } },
      },
      responses: {
        "201": json("CreditGrant", "The credit grant."),
        "400": err("The body is not correct, or a rule refuses the grant."),
        "403": err("A paid grant needs `invoices:manage` too."),
        "404": err("No such customer or credit unit."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_grants/{grant}": {
    get: {
      tags: ["Credits"],
      summary: "Retrieve a credit grant",
      parameters: [biz, cus, grantParam],
      responses: {
        "200": json("CreditGrant", "The credit grant."),
        "404": err("No such credit grant."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_grants/{grant}/void": {
    post: {
      tags: ["Credits"],
      summary: "Void a credit grant",
      description:
        "Books out what remains of a promotional grant. A paid grant leaves through a credit " +
        "note on its invoice, so the money side has a document. To void a paid grant with no " +
        "refund, send `without_refund: true` with a `reason`: the cost of the unused credit is " +
        "written off as breakage. Needs `credits:manage`.",
      parameters: [biz, cus, grantParam],
      responses: {
        "200": json("CreditGrant", "The voided grant."),
        "400": err("`without_refund` with no `reason`, or on a promotional grant."),
        "409": err("The grant is paid and `without_refund` is not set, or it is not active."),
        "404": err("No such credit grant."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_usage": {
    get: {
      tags: ["Credits"],
      summary: "List credit usage",
      description:
        "The settlements of usage paid in credits, newest first. Usage of a meter with a credit " +
        "cost takes its credits when each event arrives; a settlement then draws them from the " +
        "customer's credit grants, each hour and in the period invoice, and posts the cost of " +
        "paid credit as revenue. Needs `credits:view`.",
      parameters: [biz, cus, limit(1000, 50), after, q("meter", "Only settlements of this meter.")],
      responses: {
        "200": json("CreditUsageList", "The settlements."),
        "404": err("No such customer."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_transactions": {
    get: {
      tags: ["Credits"],
      summary: "List credit transactions",
      description: "Every movement of the customer's credit grants, newest first.",
      parameters: [
        biz,
        cus,
        limit(1000, 50),
        after,
        q("grant", "Only movements of this grant (cgr_…)."),
        q("kind", "Only movements of this kind.", {
          type: "string",
          enum: [
            "grant",
            "draw",
            "expire",
            "void",
            "restore",
            "rollover_in",
            "rollover_out",
            "activate",
          ],
        }),
        q("category", "Only movements of grants in this category.", {
          type: "string",
          enum: ["paid", "promotional"],
        }),
        q("unit", "Only movements in this credit unit. `money` = grants with no custom unit."),
        q("invoice", "Only movements on this invoice."),
        q("created[gte]", `Created at or after. ${INSTANT}`),
        q("created[lt]", `Created before. ${INSTANT}`),
      ],
      responses: { "200": json("CreditTransactionList", "The movements.") },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_holds": {
    post: {
      tags: ["Credits"],
      summary: "Hold credit",
      description:
        "Reserves an estimated amount before a call, so parallel calls cannot spend the same credit. " +
        "Refused with 402 and a `code`: `in_flight_limit` when open holds plus this amount would pass " +
        "the business's share of the balance (`credit_config.in_flight_share_bps`, default 50%; it " +
        "applies with no hold open too), `insufficient_credit` when the customer's policy blocks and the " +
        "amount is more than is available. A hold that is not captured or released expires after " +
        "`expires_in` seconds (default: the business's hold time, 60). " +
        "A meter that is paid in credits takes a hold in units: send `quantity` (the meter " +
        "quantity the work will use; the meter's credit cost for this customer converts it) or " +
        "`units` (credits), and no `amount_minor`. The units are reserved at once: no usage event " +
        "and no other hold can spend them. Such a hold is refused with `insufficient_credit` " +
        "when the balance does not cover it, also under the `bill` policy: a hold reserves " +
        "credits the customer has, never money overage or an overdraft. The customer needs no " +
        "subscription. " +
        "Needs `credit_holds:manage`.",
      parameters: [biz, cus],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("CreditHoldCreate") } },
      },
      responses: {
        "201": json("CreditHold", "The open hold."),
        "400": err("The body is not correct."),
        "402": err("Refused: `in_flight_limit` or `insufficient_credit`."),
        "404": err("No such customer or meter."),
      },
    },
  },
  "/v1/businesses/{biz}/credit_holds": {
    get: {
      tags: ["Credits"],
      summary: "List credit holds",
      parameters: [
        biz,
        q("customer", "Only this customer's holds (cus_…)."),
        q("status", "Only holds in this status.", {
          type: "string",
          enum: ["held", "captured", "released", "expired"],
        }),
        limit(100, 25),
        after,
      ],
      responses: { "200": json("CreditHoldList", "The holds, newest first.") },
    },
  },
  "/v1/businesses/{biz}/credit_holds/{hold}": {
    get: {
      tags: ["Credits"],
      summary: "Retrieve a credit hold",
      parameters: [biz, holdParam],
      responses: { "200": json("CreditHold", "The hold."), "404": err("No such credit hold.") },
    },
  },
  "/v1/businesses/{biz}/credit_holds/{hold}/capture": {
    post: {
      tags: ["Credits"],
      summary: "Capture a credit hold",
      description:
        "Records the real usage and closes the hold in one step: send the usage event itself " +
        "(`usage_event`, the body of `POST …/usage_events`) or the `key` of one already sent " +
        "(`usage_event_id`). The hold stops counting and the event starts counting together. Usage " +
        "above the hold is accepted; past the overdraft limit the hold is marked `overdraft` and the " +
        "rest bills on the next invoice. " +
        "A hold in units: its units go back to the balance and the event takes what it costs, in " +
        "one step. An event that costs less leaves the rest in the balance. An event that costs " +
        "more takes what the balance has; the rest is billed in money when the policy is `bill` " +
        "and the meter or the unit has a money price (`credits_uncovered`), else it takes the " +
        "balance below zero and the next grant pays it first; the hold is marked `overdraft`. With " +
        "`usage_event_id`, an event that was refused for credit while the hold was open is paid " +
        "now. A hold in money does not cover an event of a meter that is paid in credits: when " +
        "the balance is short the capture is refused with 402 `insufficient_credit` and the hold " +
        "stays open. " +
        "A hold in units can be used in steps: send `final: false` and the hold stays open with " +
        "the units that the event did not use (`remaining_units`). Each step has its own " +
        "`Idempotency-Key`. A step that leaves no units closes the hold. Release the hold to " +
        "give back the rest. " +
        "If a credit grant expires while the hold is open, the held units from that grant stay " +
        "reserved for the hold: a capture still uses them, and a release or the hold's expiry " +
        "lets them expire with the grant. Needs `credit_holds:manage`.",
      parameters: [biz, holdParam],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("CreditHoldCapture") } },
      },
      responses: {
        "200": json("CreditHold", "The captured hold."),
        "400": err("The body is not correct."),
        "402": err(
          "`insufficient_credit`: the event uses a meter that is paid in credits, and this hold does not cover it.",
        ),
        "404": err("No such credit hold."),
        "409": err("The hold is already captured, released or expired."),
        "422": err("The usage event was refused."),
      },
    },
  },
  "/v1/businesses/{biz}/credit_holds/{hold}/extend": {
    post: {
      tags: ["Credits"],
      summary: "Extend a credit hold",
      description:
        "Moves the expiry of a hold in units later, for work that runs in steps: the hold then " +
        "expires `expires_in` seconds from now. The new expiry must be later than the current " +
        "expiry. The held units do not change. A hold in money cannot be extended. " +
        "Needs `credit_holds:manage`.",
      parameters: [biz, holdParam],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("CreditHoldExtend") } },
      },
      responses: {
        "200": json("CreditHold", "The hold with its new expiry."),
        "400": err("The body is not correct, or the hold is in money."),
        "404": err("No such credit hold."),
        "409": err("The hold is already captured, released or expired."),
      },
    },
  },
  "/v1/businesses/{biz}/credit_holds/{hold}/release": {
    post: {
      tags: ["Credits"],
      summary: "Release a credit hold",
      description:
        "Frees the held amount at once. A hold in units gives back the units that it still " +
        "reserves. Units from a credit grant that expired while the hold was open expire with " +
        "that grant. " +
        "Needs `credit_holds:manage`.",
      parameters: [biz, holdParam],
      responses: {
        "200": json("CreditHold", "The released hold."),
        "404": err("No such credit hold."),
        "409": err("The hold is already captured, released or expired."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/access": {
    get: {
      tags: ["Credits"],
      summary: "Check access",
      description:
        "May this customer spend now? Always 200: read `allowed` and `code`. Checks, first failure " +
        "wins: `no_subscription` (no live subscription has a price on the meter, even with paid " +
        "credit), `not_entitled`, `spend_limit_reached`, `in_flight_limit` (only with `estimate` " +
        "under a block policy; checked before credit, so a small balance can answer it in place of " +
        "`insufficient_credit`), `insufficient_credit` (only when the customer's policy is to " +
        "block), then `ok`. " +
        "A meter that is paid in credits answers in units and needs no subscription: " +
        "`no_subscription` is not checked, `not_entitled` applies only when a subscription has a " +
        "feature for the meter, and `credits` gives the balance that a usage event can spend at " +
        "this instant, with the open holds taken off. Send `estimate_quantity` or " +
        "`estimate_units`. With no estimate, the check uses one event of a `count` meter, else " +
        "the smallest part of a credit. `insufficient_credit` answers as the event would be " +
        "answered: under `bill` with a money price (the meter's own usage price, else the unit's " +
        "overage price) the estimate is allowed, and inside the overdraft limit too. Under `bill` " +
        "with no money price it is refused as under `block`. A customer with no subscription is " +
        "always `block` (`on_exhausted.source` = `no_subscription`). " +
        "Writes nothing. Needs `credits:view`.",
      parameters: [
        biz,
        cus,
        q("meter", "The meter the call will use."),
        q("estimate", "The estimated cost in minor units.", { type: "integer", minimum: 0 }),
        q(
          "estimate_quantity",
          "A meter that is paid in credits: the meter quantity the call will use, as a decimal.",
        ),
        q(
          "estimate_units",
          "A meter that is paid in credits: the credits the call will use, as a decimal.",
        ),
        q("scope[<property>]", "A usage property value, for scoped spend limits. Up to 10."),
      ],
      responses: {
        "200": json("AccessCheck", "The answer."),
        "400": err("A parameter is not correct."),
        "404": err("No such customer or meter."),
      },
    },
  },
  "/v1/businesses/{biz}/access": {
    get: {
      tags: ["Credits"],
      summary: "Check access by usage key",
      description:
        "The access check for an app that knows the customer only by a usage key. Same answer as " +
        "`GET …/customers/{cus}/access`.",
      parameters: [
        biz,
        { ...q("customer_key", "A usage key of the customer."), required: true },
        q("meter", "The meter the call will use."),
        q("estimate", "The estimated cost in minor units.", { type: "integer", minimum: 0 }),
        q(
          "estimate_quantity",
          "A meter that is paid in credits: the meter quantity the call will use, as a decimal.",
        ),
        q(
          "estimate_units",
          "A meter that is paid in credits: the credits the call will use, as a decimal.",
        ),
        q("scope[<property>]", "A usage property value, for scoped spend limits. Up to 10."),
      ],
      responses: {
        "200": json("AccessCheck", "The answer."),
        "400": err("`customer_key` is missing, or a parameter is not correct."),
        "404": err("No customer has this usage key, or no such meter."),
      },
    },
  },
};

const applicability = {
  type: "object",
  description:
    'Which invoice lines the grant may pay: `{"kind":"metered"}` (every usage line, the default), ' +
    '`{"kind":"prices","prices":["…"]}`, or `{"kind":"meters","meters":["…"]}` (meter keys: the ' +
    "usage lines of every price that bills the meter when the grant draws). A `metered` grant " +
    "takes the business's `credit_config.credit_scope` when one is set.",
  properties: {
    kind: { type: "string", enum: ["metered", "prices", "meters"] },
    prices: { type: "array", items: { type: "string" } },
    meters: { type: "array", items: { type: "string" } },
  },
  required: ["kind"],
};
const policy = nullable({
  type: "string",
  enum: ["block", "bill"],
  description:
    "What happens when the credit is used up, for a business with blocking on. Null = not set here.",
});

export const CREDIT_SCHEMAS = {
  CreditUnit: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_unit"] },
      id: str("The slug id. Fixed after create."),
      name: str("Singular, for example `credit`."),
      plural_name: str("For example `credits`."),
      currency: str("ISO 4217."),
      minor_per_unit: nullable(str(`${RATE} Null = the unit has no rate.`)),
      rated: {
        type: "boolean",
        description:
          "True when the unit has a money rate. False: its credits are counted in units only.",
      },
      decimals: int("0 to 4. Grant amounts are whole numbers of 10^-decimals units."),
      locked: { type: "boolean", description: "True after the first grant in this unit." },
      locked_at: nullable({ type: "string", format: "date-time" }),
      status: { type: "string", enum: ["active", "archived"] },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      resource_version: int("Send as `expected_version` to refuse a stale update."),
    },
    required: [
      "object",
      "id",
      "name",
      "plural_name",
      "currency",
      "minor_per_unit",
      "rated",
      "decimals",
      "locked",
      "status",
    ],
  },
  CreditUnitList: list("CreditUnit", "A page of credit units."),
  CreditUnitCreate: {
    type: "object",
    properties: {
      id: str("A slug id. If you omit it, we make one from the name."),
      name: str("Singular."),
      plural_name: str("Plural. Default: `name` followed by `s`."),
      currency: str("ISO 4217."),
      minor_per_unit: nullable(
        str(`${RATE} Required: send a rate, or null for a unit with no money value.`),
      ),
      decimals: int("0 to 4. Default 0."),
    },
    required: ["name", "currency", "minor_per_unit"],
  },
  CreditUnitUpdate: {
    type: "object",
    properties: {
      name: str("Singular."),
      plural_name: str("Plural."),
      currency: str("ISO 4217. Refused once the unit is locked."),
      minor_per_unit: nullable(
        str(`${RATE} Null removes the rate. Refused once the unit is locked.`),
      ),
      decimals: int("0 to 4. Refused once the unit is locked."),
      expected_version: int("The `resource_version` you read."),
    },
  },
  CreditGrant: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_grant"] },
      id: str("cgr_…"),
      customer: str("cus_…"),
      currency: str("ISO 4217."),
      unit: nullable(str("The credit unit's id. Null = money.")),
      amount: int("Units at grant, in the unit's smallest step (money: minor units)."),
      amount_decimal: str("`amount` in whole units, as a decimal string."),
      face_minor: int("The money value at grant. Fixed for life. 0 for a unit with no rate."),
      cost_basis_minor: int("Paid: the net money received for it. Promotional: 0."),
      category: { type: "string", enum: ["paid", "promotional"] },
      priority: int("0 to 100. Lower draws first."),
      effective_at: { type: "string", format: "date-time" },
      expires_at: nullable({ type: "string", format: "date-time" }),
      applicability,
      source: {
        type: "string",
        enum: ["purchase", "plan_cycle", "manual", "restore", "auto_top_up"],
      },
      tax_treatment: nullable({ type: "string", enum: ["taxed_at_purchase", "taxed_at_use"] }),
      on_exhausted: policy,
      status: { type: "string", enum: ["pending", "active", "expired", "voided"] },
      invoice: nullable(str("The invoice that sold it (paid grants).")),
      restored_from: nullable(str("The expired grant this one restores.")),
      auto_top_up_run: nullable(str("atur_…: the automatic top-up run that sold it.")),
      remaining: {
        type: "object",
        description: "What is left: the sum of the grant's movements.",
        properties: {
          units: int("In the unit's smallest step."),
          units_decimal: str("In whole units."),
          face_minor: int("Money value left. 0 for a unit with no rate."),
          cost_minor: int("Cost basis left."),
        },
      },
      metadata: { type: "object", additionalProperties: true },
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      resource_version: { type: "integer" },
    },
    required: [
      "object",
      "id",
      "customer",
      "currency",
      "amount",
      "face_minor",
      "category",
      "status",
      "remaining",
    ],
  },
  CreditGrantList: list("CreditGrant", "A page of credit grants."),
  CreditGrantCreate: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["promotional", "paid"],
        description: "Default `promotional`.",
      },
      unit: nullable(str("A credit unit's id. Null or absent = money.")),
      currency: str("Money grants only. Default: the customer's currency."),
      amount: int("In the unit's smallest step (money: minor units)."),
      priority: int("0 to 100. Default 50."),
      effective_at: str(`Promotional only. Default now. ${INSTANT}`),
      expires_at: nullable(str(`Default: no expiry. ${INSTANT}`)),
      applicability: { ...applicability, description: "Default: every usage line (`metered`)." },
      on_exhausted: policy,
      metadata: { type: "object", additionalProperties: true },
      price_minor: int(
        "Paid only: the net price, without tax. It is the cost basis. For a unit with no rate, it is the only money the grant has.",
      ),
      tax_treatment: {
        type: "string",
        enum: ["taxed_at_purchase", "taxed_at_use"],
        description: "Paid only, required. `taxed_at_use` is for money credit only.",
      },
      mark_paid: {
        type: "object",
        description: "Paid only: record the invoice as paid now, so the credit is active at once.",
        properties: {
          method: str("cash | check | bank_transfer | other"),
          reference: str("Your reference for the payment."),
          paid_at: str(`Default now. ${INSTANT}`),
        },
        required: ["method"],
      },
    },
    required: ["amount"],
  },
  CreditTransaction: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_transaction"] },
      id: str("The movement's id."),
      kind: {
        type: "string",
        enum: [
          "grant",
          "draw",
          "expire",
          "void",
          "restore",
          "rollover_in",
          "rollover_out",
          "activate",
        ],
      },
      grant: str("cgr_…"),
      category: { type: "string", enum: ["paid", "promotional"] },
      currency: str("ISO 4217."),
      unit: nullable(str("The credit unit's id. Null = money.")),
      units: int("Signed, in the unit's smallest step."),
      units_decimal: str("Signed, in whole units."),
      face_minor: int("Signed money value."),
      cost_minor: int("Signed cost basis."),
      invoice: nullable(str("The invoice, for a draw or a restore.")),
      settlement: nullable(
        str("The credit usage settlement (cst_…), for a draw of usage paid in credits."),
      ),
      created_at: { type: "string", format: "date-time" },
    },
    required: ["object", "id", "kind", "grant", "currency", "units", "face_minor", "created_at"],
  },
  CreditTransactionList: list("CreditTransaction", "A page of credit movements."),
  CreditUsage: {
    type: "object",
    description: "One settlement of usage paid in credits: a customer, a meter and a window.",
    properties: {
      object: { type: "string", enum: ["credit_usage"] },
      id: str("cst_…"),
      customer: str("cus_…"),
      meter: str("The meter's id."),
      unit: str("The credit unit's id."),
      kind: {
        type: "string",
        enum: ["usage", "late"],
        description:
          "`usage`: events received in the window. `late`: late events that a credit grant paid in its grace window, after it ended.",
      },
      status: { type: "string", enum: ["settled"] },
      window_start: { type: "string", format: "date-time" },
      window_end: { type: "string", format: "date-time" },
      events: int("Usage events in the settlement."),
      quantity: str("The usage, in units of the meter."),
      credits_due: str("What the usage costs, in whole credits."),
      credits_drawn: str("What the settlement drew from the credit grants."),
      quantity_uncovered: str(
        "Usage that no credit paid. Only for events that a credit hold covers.",
      ),
      currency: str("ISO 4217."),
      revenue_minor: int("The cost of the paid credit drawn: the revenue the settlement posted."),
      created_at: { type: "string", format: "date-time" },
    },
    required: ["object", "id", "customer", "meter", "unit", "window_start", "window_end"],
  },
  CreditUsageList: list("CreditUsage", "A page of credit usage settlements."),
  CreditHold: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_hold"] },
      id: str("chd_…"),
      customer: str("cus_…"),
      currency: str("ISO 4217."),
      amount_minor: int("The amount held. 0 for a hold in units."),
      unit: nullable(str("The credit unit's id. Set for a hold in units.")),
      units: nullable(
        str("The credits held at the start, as a decimal. Null for a hold in money."),
      ),
      remaining_units: nullable(
        str("The credits that the hold still reserves. 0 when the hold is closed."),
      ),
      captured_units: nullable(
        str("The credits that the captured usage events took in total, as a decimal."),
      ),
      meter: nullable(str("The meter's id.")),
      scope: nullable({
        type: "object",
        additionalProperties: { type: "string" },
        description: "Usage property values, for scoped spend limits.",
      }),
      status: { type: "string", enum: ["held", "captured", "released", "expired"] },
      expires_at: { type: "string", format: "date-time" },
      captured_minor: nullable(int("The rated value of the captured usage event.")),
      overdraft: {
        type: "boolean",
        description:
          "The captured usage took the balance past the overdraft limit. For a hold in units: the event cost more credits than the balance had.",
      },
      metadata: nullable({ type: "object", additionalProperties: true }),
      created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
    },
    required: ["object", "id", "customer", "currency", "amount_minor", "status", "expires_at"],
  },
  CreditHoldList: list("CreditHold", "A page of credit holds."),
  CreditHoldCreate: {
    type: "object",
    properties: {
      amount_minor: int(
        "The estimated cost, more than 0. Not for a meter that is paid in credits.",
      ),
      quantity: str(
        "A meter that is paid in credits: the meter quantity the work will use, as a decimal. The meter's credit cost for this customer converts it to credits.",
      ),
      units: str(
        "A meter that is paid in credits: the credits to hold, as a decimal. Send `quantity` or `units`, not both.",
      ),
      currency: str("ISO 4217. Default: the customer's currency."),
      meter: str("The meter the call will use."),
      scope: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Up to 10 usage property values, stored for scoped spend limits.",
      },
      expires_in: int("Seconds, 1 to 86,400. Default: the business's hold time (60)."),
      metadata: { type: "object", additionalProperties: true },
    },
  },
  CreditHoldCapture: {
    type: "object",
    description: "Send one of the two.",
    properties: {
      usage_event: {
        type: "object",
        additionalProperties: true,
        description: "A usage event to record now.",
      },
      usage_event_id: str("The `key` of a usage event that you already sent."),
      final: {
        type: "boolean",
        description:
          "Default true: the capture closes the hold. False, for a hold in units: the hold stays open with the units that the event did not use.",
      },
    },
  },
  CreditHoldExtend: {
    type: "object",
    properties: {
      expires_in: int(
        "Seconds from now, 1 to 86,400. The new expiry must be later than the current expiry.",
      ),
    },
    required: ["expires_in"],
  },
  AccessCheck: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["access_check"] },
      allowed: { type: "boolean" },
      code: { type: "string", enum: CODES },
      message: str("A sentence for your logs."),
      customer: str("cus_…"),
      meter: nullable(str("The meter's id.")),
      currency: str("ISO 4217."),
      available_minor: int("Balance plus the overdraft limit. Can be negative."),
      available_units: {
        type: "array",
        items: {
          type: "object",
          properties: {
            unit: str("The credit unit's id."),
            units: int(
              "In the unit's smallest step. For a unit with no money rate: what a usage event can spend now. A credit grant counts only while its window contains this time, and usage that is not settled yet and open holds are taken off.",
            ),
            held_units: int(
              "Only for a unit with no money rate: reserved by open holds, in the unit's smallest step.",
            ),
            unsettled_units: int(
              "Only for a unit with no money rate: taken by usage events and not drawn from a credit grant yet.",
            ),
          },
        },
      },
      balance: {
        type: "object",
        properties: {
          grants_minor: int("Credit left on the customer's grants."),
          unbilled_usage_minor: int("Usage not yet invoiced that the grants will pay."),
          open_holds_minor: int("Open holds."),
          overdraft_limit_minor: int("How far below zero the balance can go before a block."),
        },
      },
      on_exhausted: {
        type: "object",
        properties: {
          policy: { type: "string", enum: ["block", "bill"] },
          source: {
            type: "string",
            enum: [
              "business_blocking_off",
              "customer_override",
              "grant",
              "plan_price",
              "business_default",
              "no_subscription",
              "trial",
            ],
          },
        },
      },
      usage_this_period: {
        type: "object",
        properties: { quantity: str("A decimal string.") },
      },
      cost_this_period_minor: int("Rated usage of the meter this period."),
      limits: {
        type: "array",
        items: ref("SpendLimitCheck"),
        description:
          "Spend limits checked. When the code is spend_limit_reached, only the tightest refusing limit.",
      },
      entitlement: nullable({
        type: "object",
        properties: {
          feature: str("The feature's id."),
          value: str("The limit."),
          used: str("Used in the allowance's window (its reset window, else this period)."),
          resets_at: nullable({
            type: "string",
            format: "date-time",
            description: "When the allowance resets. Null = never.",
          }),
        },
      }),
      renews_at: nullable({
        type: "string",
        format: "date-time",
        description: "When the customer's plan credits next renew. Null = no plan credits renew.",
      }),
      credits: nullable({
        type: "object",
        description:
          "Set for a meter that is paid in credits. Amounts are in the credit unit, as decimals.",
        properties: {
          unit: str("The credit unit's id."),
          credits_per_unit: str("What one unit of the meter costs this customer."),
          cost_source: { type: "string", enum: ["meter", "plan", "subscription"] },
          estimate: str("What the estimate costs."),
          available: str(
            "What a usage event can spend at this instant. The open holds are already taken off.",
          ),
          held: str("Reserved by open holds."),
          unsettled: str("Taken by usage events and not drawn from a credit grant yet."),
          remaining: str("`available` less the estimate, never below 0."),
        },
      }),
      as_of: { type: "string", format: "date-time" },
    },
    required: [
      "object",
      "allowed",
      "code",
      "customer",
      "currency",
      "available_minor",
      "balance",
      "on_exhausted",
    ],
  },
};

/** Invoice and estimate fields added by credit grants (0466). */
export const GRANT_CREDIT_FIELDS = {
  grant_credits_pre_tax_minor: {
    type: "integer",
    description:
      "Credit grants applied before tax (promotional, and paid credit taxed at purchase). Already off `total_minor`.",
  },
  grant_credits_post_tax_minor: {
    type: "integer",
    description:
      "Money credit grants taxed at use, applied after tax. Included in `credits_applied_minor`.",
  },
};

// ── Fields on existing objects (builder B: packs, plan credits, policy) ─────────────────

/** When plan credits or an allowance renew (G3b). */
export const RESET_SCHEMA = {
  type: "object",
  nullable: true,
  description:
    "When the credits or the allowance renew. `every`: hour (allowances only), day, week, month, " +
    "quarter, half_year, year, `term` (once each billing term, the default) or `never` (once, " +
    "kept until used). `count`: every N units (default 1; not with term or never). `anchor`: " +
    "`subscription` (windows start at the term start, the last one cut at the term end) or " +
    "`calendar` (on the hour, midnight, Monday, the 1st of the month, quarter, half year or year, " +
    "in the business time zone). A window may not be longer than the billing term.",
  properties: {
    every: {
      type: "string",
      enum: ["hour", "day", "week", "month", "quarter", "half_year", "year", "term", "never"],
    },
    count: { type: "integer", minimum: 1, maximum: 1000 },
    anchor: { type: "string", enum: ["subscription", "calendar"] },
  },
  required: ["every"],
};

/** An allowance's reset: a reset, or `{ same_as_credits: true }`. */
export const ALLOWANCE_RESET_SCHEMA = {
  nullable: true,
  // Every field of both branches, so the reference lists them; `oneOf` states the rule.
  properties: {
    ...RESET_SCHEMA.properties,
    same_as_credits: {
      type: "boolean",
      enum: [true],
      description: "Always true: renew with the plan credits. Send it alone.",
    },
  },
  oneOf: [
    { ...RESET_SCHEMA, nullable: false },
    {
      type: "object",
      description:
        "Renew with the plan credits. Each subscription follows the per-cycle credits of its own " +
        "price of the plan (an active price first). With no credits reset, the allowance renews " +
        "each billing term. A plan accepts the link only when its active prices grant credits " +
        "each period on one schedule; a price change that splits that schedule is refused.",
      properties: {
        same_as_credits: {
          type: "boolean",
          enum: [true],
          description: "Always true: renew with the plan credits.",
        },
      },
      required: ["same_as_credits"],
      additionalProperties: false,
    },
  ],
};

const grantsCreditSchema = {
  type: "object",
  nullable: true,
  description:
    'Credit this price grants. `{"kind":"pack", …}` on a one-time price: each paid invoice line ' +
    "grants `amount` × quantity (paid credit, active once the invoice is paid). " +
    '`{"kind":"per_cycle", …}` on a recurring price: `amount` × item quantity of promotional credit ' +
    "each period, with optional rollover. Null grants nothing.",
  properties: {
    kind: { type: "string", enum: ["pack", "per_cycle"] },
    unit: { type: "string", nullable: true, description: "A credit unit id. Null = money." },
    amount: { type: "integer", description: "In the unit's smallest step (money: minor units)." },
    priority: { type: "integer", minimum: 0, maximum: 100 },
    expires_after: {
      type: "object",
      nullable: true,
      properties: { days: { type: "integer", minimum: 1 } },
      description: "Packs: the credit expires this many days after the invoice is paid.",
    },
    applicability,
    tax_treatment: {
      type: "string",
      nullable: true,
      enum: ["taxed_at_purchase", "taxed_at_use"],
      description: "Packs: required, or the business default. `taxed_at_use` is money only.",
    },
    on_exhausted: policy,
    rollover: {
      type: "object",
      description:
        "Per cycle: `none`, or `carry` floor(remaining × percent ÷ 100) units (optionally capped) " +
        "into a grant that expires `expire_after_cycles` periods later (null = never).",
      properties: {
        mode: { type: "string", enum: ["none", "carry"] },
        percent: { type: "integer", minimum: 1, maximum: 100 },
        cap: { type: "integer", nullable: true },
        expire_after_cycles: {
          type: "integer",
          nullable: true,
          minimum: 1,
          description: "Counted in reset windows when `reset` is set.",
        },
      },
    },
    reset: {
      ...RESET_SCHEMA,
      description:
        "Per cycle: when the credits renew (absent = each term). Each window gets its own grant, " +
        "which pays only the usage inside that window. Credits do not renew by the hour.",
    },
    unit_cost_basis: {
      type: "string",
      pattern: "^\\d{1,12}(\\.\\d{1,12})?$",
      description:
        "Per cycle, for a credit unit with no money rate: money per whole credit (a decimal in " +
        "major units), a share of the plan fee. The credit of each term is then paid credit: " +
        "units × this amount is deferred from the term invoice's revenue and recognised as the " +
        "credits are used; what is left at expiry is breakage. Absent: the credit has no money " +
        "value. Applies to a term grant written with its invoice; a grant that waits for its " +
        "invoice to be paid, a reset window and carried credit have no cost basis.",
    },
    first_window: {
      type: "string",
      nullable: true,
      enum: ["full", "prorated", "next_full_window"],
      description:
        "Per cycle, a calendar window that starts before the subscription: grant it in full, " +
        "prorated, or wait for the first full window. Null = the business setting.",
    },
  },
  required: ["kind", "unit", "amount"],
};

/** Price create, update and object. */
export const PRICE_GRANTS_CREDIT_FIELD = { grants_credit: grantsCreditSchema };

/** Customer create, update and object (0464). */
export const CUSTOMER_CREDIT_SETTINGS_FIELD = {
  credit_settings: {
    type: "object",
    nullable: true,
    description:
      "Credit policy for this customer: an override of what happens when credit is used up " +
      "(ignored after `override_expires_at`), and an overdraft limit per currency. Replaced whole; " +
      "null = the business's settings.",
    properties: {
      on_exhausted: policy,
      override_expires_at: { type: "string", format: "date-time", nullable: true },
      overdraft_limit_minor: {
        type: "object",
        additionalProperties: { type: "integer", minimum: 0 },
        description: 'Per currency (`{"USD": 500}`).',
      },
    },
  },
};

/** Feature create, update and object (0467). */
export const FEATURE_METER_FIELD = {
  meter: {
    type: "string",
    nullable: true,
    description:
      "Meter features only: the meter whose usage this period counts against the limit. Null = the " +
      "check compares `required` with the limit only.",
  },
};
