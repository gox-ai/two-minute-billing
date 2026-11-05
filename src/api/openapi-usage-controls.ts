/**
 * OpenAPI for usage controls (design G5 §5). Spread into `openapi.ts`. One section per
 * builder: spend limits, limit tiers, alerts and runway here first; automatic top-up and
 * usage invoice thresholds below them.
 */

const TAG = "Usage controls";
const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});
const biz = pathParam("biz", "The business's id (biz_…).");
const cus = pathParam("cus", "The customer's id (cus_…).");
const limitParam = pathParam("limit", "The spend limit's id (slim_…).");
const tierParam = pathParam("tier", "The limit tier's id (sltr_…).");
const alertParam = pathParam("alert", "The usage alert's id (ualt_…).");
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(name) } },
});
const err = (description: string) => json("Error", description);
const body = (name: string) => ({
  required: true,
  content: { "application/json": { schema: ref(name) } },
});
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
const int = (description: string) => ({ type: "integer", description });
const str = (description: string) => ({ type: "string", description });
const nullable = (schema: Record<string, unknown>) => ({ ...schema, nullable: true });
const simpleList = (item: string) => ({
  type: "object",
  properties: {
    object: { type: "string", enum: ["list"] },
    data: { type: "array", items: ref(item) },
  },
  required: ["object", "data"],
});
const deleted = (object: string) => ({
  type: "object",
  properties: {
    object: { type: "string", enum: [object] },
    id: str("The id."),
    deleted: { type: "boolean", enum: [true] },
  },
  required: ["object", "id", "deleted"],
});
const INTERVAL = {
  type: "string",
  enum: ["day", "week", "month", "period"],
  description:
    "day, week (ISO, from Monday) and month are calendar intervals in the business's time zone. " +
    "period is the term of the subscription that bills the usage.",
};
const RULE_422 = err("A rule refused the value. `param` names the field.");

// ── Spend limits, tiers, alerts, runway ─────────────────────────────────────────────

const LIMIT_PATHS = {
  "/v1/businesses/{biz}/customers/{cus}/spend_limits": {
    get: {
      tags: [TAG],
      summary: "List a customer's spend limits",
      description: "Active limits, set by you or by the customer in the portal.",
      parameters: [biz, cus],
      responses: {
        "200": json("SpendLimitList", "The customer's spend limits."),
        "404": err("No such customer."),
      },
    },
    post: {
      tags: [TAG],
      summary: "Create a spend limit",
      description:
        "A limit on rated usage (before tax and credits) per interval, for the customer, one " +
        "subscription or each value of a usage property. A `hard` limit makes the access check " +
        "answer `spend_limit_reached`; a `soft` limit only sends `spend_limit_reached` once per " +
        "interval. For one subject and mode, day ≤ week ≤ month, and month ≤ period when the " +
        "term is a month or longer. Usage is never refused at ingest. Needs `usage_controls:manage`.",
      parameters: [biz, cus],
      requestBody: body("SpendLimitCreate"),
      responses: {
        "201": json("SpendLimit", "The spend limit."),
        "400": err("The body is not correct."),
        "404": err("No such customer or subscription."),
        "409": err("A limit for this subject, interval and mode already exists."),
        "422": RULE_422,
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/spend_limits/{limit}": {
    get: {
      tags: [TAG],
      summary: "Retrieve a spend limit",
      parameters: [biz, cus, limitParam],
      responses: {
        "200": json("SpendLimit", "The spend limit."),
        "404": err("No such spend limit."),
      },
    },
    patch: {
      tags: [TAG],
      summary: "Update a spend limit",
      description: "Change the amount or the meters. The nesting rule applies.",
      parameters: [biz, cus, limitParam],
      requestBody: body("SpendLimitUpdate"),
      responses: {
        "200": json("SpendLimit", "The spend limit."),
        "404": err("No such spend limit."),
        "422": RULE_422,
      },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a spend limit",
      parameters: [biz, cus, limitParam],
      responses: {
        "200": json("SpendLimitDeleted", "The limit no longer applies."),
        "404": err("No such spend limit."),
      },
    },
  },
  "/v1/businesses/{biz}/spend_limit_tiers": {
    get: {
      tags: [TAG],
      summary: "List limit tiers",
      parameters: [
        biz,
        q("include_archived", "true to include archived tiers.", { type: "boolean" }),
      ],
      responses: { "200": json("SpendLimitTierList", "The business's limit tiers.") },
    },
    post: {
      tags: [TAG],
      summary: "Create a limit tier",
      description:
        "When a customer's lifetime paid amount (succeeded payments less succeeded refunds) in " +
        "`currency` reaches `level_minor`, its customer limits per interval rise to `amounts`. " +
        "A customer never drops to a lower tier after a refund or a chargeback. Up to 10 per currency.",
      parameters: [biz],
      requestBody: body("SpendLimitTierCreate"),
      responses: {
        "201": json("SpendLimitTier", "The limit tier."),
        "409": err("A tier with this level already exists."),
        "422": RULE_422,
      },
    },
  },
  "/v1/businesses/{biz}/spend_limit_tiers/{tier}": {
    get: {
      tags: [TAG],
      summary: "Retrieve a limit tier",
      parameters: [biz, tierParam],
      responses: {
        "200": json("SpendLimitTier", "The limit tier."),
        "404": err("No such limit tier."),
      },
    },
    patch: {
      tags: [TAG],
      summary: "Update a limit tier",
      description: "Change the amounts. The level cannot change.",
      parameters: [biz, tierParam],
      requestBody: body("SpendLimitTierUpdate"),
      responses: {
        "200": json("SpendLimitTier", "The limit tier."),
        "404": err("No such limit tier."),
        "409": err("The tier is archived."),
        "422": RULE_422,
      },
    },
    delete: {
      tags: [TAG],
      summary: "Archive a limit tier",
      description: "An archived tier stops applying. Customers that reached it keep the record.",
      parameters: [biz, tierParam],
      responses: {
        "200": json("SpendLimitTier", "The archived tier."),
        "404": err("No such limit tier."),
      },
    },
  },
  "/v1/businesses/{biz}/usage_alerts": {
    get: {
      tags: [TAG],
      summary: "List usage alerts",
      parameters: [
        biz,
        q("customer", "Only this customer's alerts (cus_…)."),
        q("product", "Only plan alerts on this product."),
      ],
      responses: { "200": json("UsageAlertList", "Active usage alerts.") },
    },
    post: {
      tags: [TAG],
      summary: "Create a usage alert",
      description:
        "An alert on usage, spend, credit balance or credit runway, for one `customer` or for " +
        "every subscription to a `product` (including later ones). Each threshold triggers once " +
        "per period and resolves when the value moves back or the period ends. A customer alert " +
        "of the same kind and meter wins over a plan alert. Alerts never block or charge.",
      parameters: [biz],
      requestBody: body("UsageAlertCreate"),
      responses: {
        "201": json("UsageAlert", "The usage alert."),
        "400": err("The body is not correct."),
        "404": err("No such customer or product."),
        "422": RULE_422,
      },
    },
  },
  "/v1/businesses/{biz}/usage_alerts/{alert}": {
    get: {
      tags: [TAG],
      summary: "Retrieve a usage alert",
      description: "A customer alert includes `states` (see the states endpoint).",
      parameters: [biz, alertParam],
      responses: {
        "200": json("UsageAlert", "The usage alert."),
        "404": err("No such usage alert."),
      },
    },
    patch: {
      tags: [TAG],
      summary: "Update a usage alert",
      parameters: [biz, alertParam],
      requestBody: body("UsageAlertUpdate"),
      responses: {
        "200": json("UsageAlert", "The usage alert."),
        "404": err("No such usage alert."),
        "422": RULE_422,
      },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a usage alert",
      parameters: [biz, alertParam],
      responses: {
        "200": json("UsageAlertDeleted", "The alert is off."),
        "404": err("No such usage alert."),
        "409": err("The alert is already deleted."),
      },
    },
  },
  "/v1/businesses/{biz}/usage_alerts/{alert}/states": {
    get: {
      tags: [TAG],
      summary: "Get the state of each threshold",
      description:
        "For the current period: each threshold is `armed`, `triggered` or `resolved`, with " +
        "the times and the last value. You can rebuild your view from this read alone, without " +
        "replaying webhooks. A plan alert needs `customer` and answers per subscription.",
      parameters: [
        biz,
        alertParam,
        q("customer", "The customer (cus_…). Needed for a plan alert."),
      ],
      responses: {
        "200": json("UsageAlertStateList", "Threshold states."),
        "400": err("A plan alert needs customer."),
        "404": err("No such usage alert or customer."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_runway": {
    get: {
      tags: [TAG],
      summary: "Estimate the credit runway",
      description:
        "Days until the credit balance runs out at the last 7 days' rate of spend: " +
        "floor(balance ÷ (spend in the last 7 days ÷ 7)). Counts what an active automatic top-up " +
        "can still add this month. `runway_days` is null with under 24 hours of usage or no " +
        "spend. An estimate.",
      parameters: [biz, cus, q("currency", "The balance currency. Default: the customer's.")],
      responses: {
        "200": json("CreditRunway", "The runway estimate."),
        "404": err("No such customer."),
      },
    },
  },
};

const threshold = {
  type: "object",
  properties: {
    value: { type: "number", description: "The threshold. A whole number except for units." },
    unit: {
      type: "string",
      enum: ["minor", "units", "percent", "days"],
      description:
        "minor (money, spend and balance), units (meter units or credit units), percent (of the " +
        "spend limit, the meter feature's limit, or the credit granted), days (runway).",
    },
  },
  required: ["value", "unit"],
};

const LIMIT_SCHEMAS = {
  SpendLimit: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["spend_limit"] },
      id: str("slim_…"),
      customer: str("cus_…"),
      scope: { type: "string", enum: ["customer", "subscription", "property"] },
      subscription: nullable(str("sub_…, for subscription scope.")),
      property_key: nullable(str("The usage property, for property scope.")),
      property_value: nullable(
        str(
          "The property value. Null: each value gets the amount; a row with a value overrides it.",
        ),
      ),
      meters: nullable({
        type: "array",
        items: { type: "string" },
        description: "Meter keys. Null: all meters.",
      }),
      interval: INTERVAL,
      amount_minor: int("The limit, in minor units of `currency`."),
      currency: str("ISO 4217."),
      mode: { type: "string", enum: ["hard", "soft"] },
      set_by: { type: "string", enum: ["operator", "customer"] },
      active: { type: "boolean" },
      effective_amount_minor: int(
        "The amount that applies. A customer-scope hard limit you set is raised by a reached " +
          "limit tier, unless you changed the limit after the tier was reached. Else amount_minor.",
      ),
      spent_minor: nullable(
        int(
          "Spend in the current interval. Null for a property limit with no property_value: each value has its own spend.",
        ),
      ),
      reached: nullable({
        type: "boolean",
        description: "spent_minor is at or above effective_amount_minor.",
      }),
      resets_at: nullable(str("ISO 8601. When the current interval ends.")),
      editable: {
        type: "boolean",
        description: "Portal only: the buyer set it, so the buyer can change it.",
      },
      created_at: str("ISO 8601."),
      updated_at: str("ISO 8601."),
    },
    required: ["object", "id", "scope", "interval", "amount_minor", "currency", "mode", "set_by"],
  },
  SpendLimitCreate: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["customer", "subscription", "property"] },
      subscription: str("sub_…, for subscription scope."),
      property_key: str("For property scope: a limit property of the covered meters."),
      property_value: nullable(str("Null or absent: each value of the property gets the amount.")),
      meters: nullable({
        type: "array",
        items: { type: "string" },
        description: "Meter keys. Null: all.",
      }),
      interval: INTERVAL,
      amount_minor: int("The limit in minor units."),
      currency: str("ISO 4217."),
      mode: { type: "string", enum: ["hard", "soft"], description: "Default hard." },
    },
    required: ["scope", "interval", "amount_minor", "currency"],
  },
  SpendLimitUpdate: {
    type: "object",
    properties: {
      amount_minor: int("The new limit."),
      meters: nullable({ type: "array", items: { type: "string" } }),
    },
  },
  SpendLimitList: simpleList("SpendLimit"),
  SpendLimitDeleted: deleted("spend_limit"),
  SpendLimitCheck: {
    type: "object",
    description:
      "A limit the access check measured. When the check refuses, `limits` holds only the " +
      "tightest refusing limit.",
    properties: {
      id: str("slim_… for a limit, sltr_… for a reached tier."),
      limit: str("Same as id."),
      scope: { type: "string", enum: ["customer", "subscription", "property"] },
      property_key: nullable(str("The property.")),
      property_value: nullable(str("The value measured.")),
      interval: INTERVAL,
      mode: { type: "string", enum: ["hard", "soft"] },
      set_by: { type: "string", enum: ["operator", "customer"] },
      source: { type: "string", enum: ["limit", "tier"] },
      amount_minor: int("The limit."),
      limit_minor: int("Same as amount_minor."),
      spent_minor: int("Spend in the interval so far."),
      open_holds_minor: int("Open credit holds in the limit's scope."),
      resets_at: nullable(str("When the interval resets.")),
      reached: { type: "boolean" },
      status: {
        type: "string",
        enum: ["ok", "reached", "not_checked"],
        description: "not_checked: a property limit whose property the request did not send.",
      },
    },
  },
  SpendLimitTier: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["spend_limit_tier"] },
      id: str("sltr_…"),
      currency: str("ISO 4217."),
      level_minor: int("Lifetime paid at which the tier is reached."),
      amounts: ref("SpendLimitTierAmounts"),
      active: { type: "boolean" },
      created_at: str("ISO 8601."),
    },
    required: ["object", "id", "currency", "level_minor", "amounts"],
  },
  SpendLimitTierAmounts: {
    type: "object",
    description: "Customer limit per interval, minor units. day ≤ week ≤ month ≤ period.",
    properties: {
      day: int("Daily."),
      week: int("Weekly."),
      month: int("Monthly."),
      period: int("Per billing period."),
    },
  },
  SpendLimitTierCreate: {
    type: "object",
    properties: {
      currency: str("ISO 4217."),
      level_minor: int("Lifetime paid that reaches the tier."),
      amounts: ref("SpendLimitTierAmounts"),
    },
    required: ["currency", "level_minor", "amounts"],
  },
  SpendLimitTierUpdate: {
    type: "object",
    properties: { amounts: ref("SpendLimitTierAmounts") },
    required: ["amounts"],
  },
  SpendLimitTierList: simpleList("SpendLimitTier"),
  UsageAlertThreshold: threshold,
  UsageAlert: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["usage_alert"] },
      id: str("ualt_…"),
      kind: {
        type: "string",
        enum: ["usage_quantity", "spend", "credit_balance", "credit_runway"],
      },
      scope: { type: "string", enum: ["customer", "plan"] },
      customer: nullable(str("cus_…, for customer scope.")),
      product: nullable(str("The product, for plan scope.")),
      meter: nullable(str("Meter key: usage (required) and spend (optional).")),
      interval: nullable(INTERVAL),
      currency: nullable(str("ISO 4217. All kinds but usage.")),
      unit: nullable(str("Credit unit key, for balance and runway. Null: money.")),
      thresholds: { type: "array", items: ref("UsageAlertThreshold") },
      email: { type: "boolean", description: "Email the customer when a threshold triggers." },
      active: { type: "boolean" },
      created_at: str("ISO 8601."),
      states: {
        type: "array",
        items: ref("UsageAlertSubjectStates"),
        description: "Customer alerts only.",
      },
    },
    required: ["object", "id", "kind", "scope", "thresholds"],
  },
  UsageAlertCreate: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["usage_quantity", "spend", "credit_balance", "credit_runway"],
      },
      customer: str("One customer (cus_…). Send this or product."),
      product: str("Every subscription to this product. Send this or customer."),
      meter: str("Meter key."),
      interval: INTERVAL,
      currency: str("ISO 4217."),
      unit: str("Credit unit key."),
      thresholds: { type: "array", items: ref("UsageAlertThreshold"), minItems: 1, maxItems: 10 },
      email: { type: "boolean" },
    },
    required: ["kind", "thresholds"],
  },
  UsageAlertUpdate: {
    type: "object",
    properties: {
      thresholds: { type: "array", items: ref("UsageAlertThreshold"), minItems: 1, maxItems: 10 },
      email: { type: "boolean" },
    },
  },
  UsageAlertList: simpleList("UsageAlert"),
  UsageAlertDeleted: deleted("usage_alert"),
  UsageAlertThresholdState: {
    type: "object",
    properties: {
      value: { type: "number" },
      unit: { type: "string", enum: ["minor", "units", "percent", "days"] },
      state: { type: "string", enum: ["armed", "triggered", "resolved"] },
      last_value: nullable({
        description: "The last value measured (number, or decimal string for quantities).",
      }),
      triggered_at: nullable(str("ISO 8601.")),
      resolved_at: nullable(str("ISO 8601.")),
      resolve_reason: nullable({ type: "string", enum: ["recovered", "period_ended"] }),
      period_key: nullable(str("The period start.")),
      resets_at: nullable(str("The period end.")),
    },
    required: ["value", "unit", "state"],
  },
  UsageAlertSubjectStates: {
    type: "object",
    properties: {
      subject: { type: "string", enum: ["customer", "subscription"] },
      subscription: nullable(str("sub_…, for a plan alert.")),
      period_key: nullable(str("The period start.")),
      resets_at: nullable(str("The period end.")),
      thresholds: { type: "array", items: ref("UsageAlertThresholdState") },
    },
    required: ["subject", "thresholds"],
  },
  UsageAlertStateList: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      alert: str("ualt_…"),
      data: { type: "array", items: ref("UsageAlertSubjectStates") },
    },
    required: ["object", "data"],
  },
  CreditRunway: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_runway"] },
      customer: str("cus_…"),
      currency: str("ISO 4217."),
      estimate: { type: "boolean", enum: [true] },
      runway_days: nullable(int("Whole days. Null: not enough usage to estimate.")),
      runs_out_at: nullable(str("ISO 8601.")),
      balance_minor: int("Live credit balance."),
      burn_minor_per_day: nullable(int("Spend in the last 7 days ÷ 7.")),
      spend_last_7_days_minor: int("Rated usage in the last 7 days."),
      auto_topup_minor: int("What an active automatic top-up can still add this month."),
      message: str("The estimate in words."),
    },
    required: ["object", "customer", "currency", "runway_days"],
  },
};

// ── Automatic top-up and usage invoice thresholds ─────────────────────────────────────

const productParam = pathParam("product", "The plan's product id (the slug you chose).");
const currencyParam = pathParam("currency", "The ISO currency code of the amount.");
const subParam = pathParam("sub", "The subscription's id (sub_…).");
const whichQuery = [
  q("currency", "The config's currency. Default: the customer's."),
  q("unit", "The credit unit's id. Omit for money credit."),
];

const TOPUP_PATHS = {
  "/v1/businesses/{biz}/customers/{cus}/auto_topup": {
    get: {
      tags: [TAG],
      summary: "Retrieve a customer's automatic top-up",
      parameters: [biz, cus, ...whichQuery],
      responses: {
        "200": json("AutoTopup", "The automatic top-up."),
        "404": err("No such customer, or no automatic top-up."),
      },
    },
    put: {
      tags: [TAG],
      summary: "Set a customer's automatic top-up",
      description:
        "Buys credit when the live balance is at or below `threshold_minor`, or on a schedule. " +
        "`fixed` buys `amount_minor` (a multiple of it, so the balance lands above the " +
        "threshold); `target` buys up to `target_minor`. Each run stays inside the business's " +
        "top-up limits, the monthly cap and `max_runs_per_day`; on an INR card or UPI mandate a " +
        "run is at most ₹15,000. Credit is granted only when the purchase invoice is paid. A " +
        "decline voids the invoice and turns automatic top-up off. On a payment method that " +
        "needs an advance notice, a threshold below the notice lead's usage at the current rate " +
        "is refused. Needs `usage_controls:manage`.",
      parameters: [biz, cus],
      requestBody: body("AutoTopupInput"),
      responses: {
        "200": json("AutoTopup", "The automatic top-up."),
        "400": err("The body is not correct, or a rule refused it."),
        "404": err("No such customer, credit unit or payment method."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/auto_topup/enable": {
    post: {
      tags: [TAG],
      summary: "Turn on a customer's automatic top-up",
      description: "Needs a payment method that we can charge. Clears `disabled_reason`.",
      parameters: [biz, cus, ...whichQuery],
      responses: {
        "200": json("AutoTopup", "The automatic top-up."),
        "400": err("The customer has no payment method that we can charge."),
        "404": err("No such customer, or no automatic top-up."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/auto_topup/disable": {
    post: {
      tags: [TAG],
      summary: "Turn off a customer's automatic top-up",
      description: "A run not yet charged is cancelled and its invoice voided.",
      parameters: [biz, cus, ...whichQuery],
      responses: {
        "200": json("AutoTopup", "The automatic top-up."),
        "404": err("No such customer, or no automatic top-up."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/auto_topup/runs": {
    get: {
      tags: [TAG],
      summary: "List a customer's automatic top-up runs",
      parameters: [
        biz,
        cus,
        q("limit", "Page size, 1 to 100. Default 25.", {
          type: "integer",
          minimum: 1,
          maximum: 100,
        }),
        q("starting_after", "The `next_cursor` of the previous page."),
      ],
      responses: {
        "200": json("AutoTopupRunList", "Newest first."),
        "404": err("No such customer."),
      },
    },
  },
  "/v1/businesses/{biz}/usage_invoice_thresholds": {
    get: {
      tags: [TAG],
      summary: "List usage invoice thresholds",
      parameters: [
        biz,
        q("product", "Only this plan's thresholds."),
        q("subscription", "Only this subscription's override."),
      ],
      responses: {
        "200": json("UsageInvoiceThresholdList", "The thresholds."),
        "404": err("No such product or subscription."),
      },
    },
  },
  "/v1/businesses/{biz}/products/{product}/usage_invoice_thresholds/{currency}": {
    put: {
      tags: [TAG],
      summary: "Set a plan's usage invoice threshold",
      description:
        "Invoice usage each time unbilled usage reaches `amount_minor`. The interim invoice " +
        "bills the usage to date less what earlier interim invoices billed; coupons and the " +
        "minimum apply on the period's final invoice only. Needs `usage_controls:manage`.",
      parameters: [biz, productParam, currencyParam],
      requestBody: body("UsageInvoiceThresholdPlanInput"),
      responses: {
        "200": json("UsageInvoiceThreshold", "The threshold."),
        "400": err("The body is not correct."),
        "404": err("No such product."),
      },
    },
    delete: {
      tags: [TAG],
      summary: "Remove a plan's usage invoice threshold",
      parameters: [biz, productParam, currencyParam],
      responses: {
        "200": json("UsageInvoiceThresholdDeleted", "Removed."),
        "404": err("No threshold for this plan and currency."),
      },
    },
  },
  "/v1/businesses/{biz}/subscriptions/{sub}/usage_invoice_threshold": {
    put: {
      tags: [TAG],
      summary: "Set a subscription's usage invoice threshold",
      description:
        "Wins over the plan's amount. `amount_minor: null` turns threshold invoicing off for " +
        "this subscription. Needs `usage_controls:manage`.",
      parameters: [biz, subParam],
      requestBody: body("UsageInvoiceThresholdSubscriptionInput"),
      responses: {
        "200": json("UsageInvoiceThreshold", "The threshold."),
        "400": err("The body is not correct."),
        "404": err("No such subscription."),
      },
    },
    delete: {
      tags: [TAG],
      summary: "Remove a subscription's override",
      description: "The plan's amount applies again.",
      parameters: [biz, subParam],
      responses: {
        "200": json("UsageInvoiceThresholdDeleted", "Removed."),
        "404": err("This subscription has no override."),
      },
    },
  },
};

const grantSettings = {
  type: "object",
  description: "The credit each run buys.",
  properties: {
    tax_treatment: { type: "string", enum: ["taxed_at_purchase", "taxed_at_use"] },
    priority: int("Lower draws first. 0 to 100."),
    expires_after_months: nullable(int("The credit expires this many months after payment.")),
    applicability: {
      type: "object",
      description: "`{kind: metered}` or `{kind: prices, prices}`.",
    },
  },
  required: ["tax_treatment"],
};
const schedule = nullable({
  type: "object",
  description:
    "`{every: week, weekday: 1–7}` (ISO, 1 = Monday) or `{every: month, day: 1–31}`. A day " +
    "past the month's end runs on its last day.",
});

const TOPUP_SCHEMAS = {
  AutoTopupInput: {
    type: "object",
    properties: {
      currency: str("ISO currency. Default: the credit unit's, else the customer's."),
      unit: nullable(str("The credit unit's id. Null or absent = money credit.")),
      trigger: { type: "string", enum: ["threshold", "schedule"] },
      threshold_minor: nullable(int("Buy when the live balance is at or below this.")),
      schedule,
      method: { type: "string", enum: ["fixed", "target"] },
      amount_minor: nullable(int("`fixed`: the amount to buy.")),
      target_minor: nullable(int("`target`: buy up to this balance.")),
      monthly_cap_minor: int("Most that runs can buy per calendar month."),
      max_runs_per_day: int("1 to 10. Default 3."),
      payment_method: nullable(str("The `pm_…` to charge. Null = the customer's charge order.")),
      grant: grantSettings,
    },
    required: ["trigger", "method", "monthly_cap_minor", "grant"],
  },
  AutoTopup: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["auto_topup"] },
      id: str("atu_…"),
      customer: str("cus_…"),
      currency: str("ISO currency."),
      unit: nullable(str("The credit unit's id.")),
      trigger: { type: "string", enum: ["threshold", "schedule"] },
      threshold_minor: nullable(int("The threshold.")),
      schedule,
      method: { type: "string", enum: ["fixed", "target"] },
      amount_minor: nullable(int("The fixed amount.")),
      target_minor: nullable(int("The target balance.")),
      monthly_cap_minor: int("The monthly cap."),
      max_runs_per_day: int("Runs per day."),
      payment_method: nullable(str("pm_…")),
      grant: grantSettings,
      status: { type: "string", enum: ["active", "disabled"] },
      disabled_reason: nullable(str("payment_declined, operator or customer.")),
      disabled_at: nullable(str("ISO 8601.")),
      threshold_low_at: nullable(str("Last `credit_auto_topup_threshold_low`, ISO 8601.")),
      lead_time: {
        type: "object",
        description:
          "The notice lead rule on the payment method a run charges first (read and save). " +
          "`required_threshold_minor` = `lead_hours` of usage at the current rate.",
        properties: {
          lead_hours: int("Worst case from notice to charge. 0 = no notice."),
          burn_minor_per_day: nullable(int("Spend per day over the last 7 days.")),
          required_threshold_minor: nullable(int("The lowest threshold the rule allows.")),
          warning: nullable(str("Set when there is not enough usage to check the rule.")),
        },
      },
      created_at: str("ISO 8601."),
      updated_at: str("ISO 8601."),
      resource_version: int("Version."),
    },
    required: ["object", "id", "customer", "currency", "trigger", "method", "status"],
  },
  AutoTopupRun: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["auto_topup_run"] },
      id: str("atur_…"),
      auto_topup: str("atu_…"),
      trigger: { type: "string", enum: ["threshold", "schedule"] },
      trigger_key: nullable(str("A schedule slot, `sch:<YYYY-MM-DD>`.")),
      amount_minor: int("The credit bought (before tax)."),
      currency: str("ISO currency."),
      status: {
        type: "string",
        enum: ["created", "notice_sent", "charging", "pending", "succeeded", "failed", "cancelled"],
      },
      invoice: nullable(str("The purchase invoice, inv_…")),
      payment: nullable(str("pay_…")),
      charge_after: nullable(str("Planned charge time, ISO 8601.")),
      decline_code: nullable(str("Why the charge failed.")),
      failure_message: nullable(str("The gateway's message.")),
      created_at: str("ISO 8601."),
      updated_at: str("ISO 8601."),
    },
    required: ["object", "id", "amount_minor", "currency", "status"],
  },
  AutoTopupRunList: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: ref("AutoTopupRun") },
      has_more: { type: "boolean" },
      next_cursor: nullable(str("Send as `starting_after` for the next page.")),
    },
    required: ["object", "data", "has_more", "next_cursor"],
  },
  UsageInvoiceThresholdPlanInput: {
    type: "object",
    properties: { amount_minor: int("Invoice usage each time unbilled usage reaches this.") },
    required: ["amount_minor"],
  },
  UsageInvoiceThresholdSubscriptionInput: {
    type: "object",
    properties: {
      amount_minor: nullable(int("This subscription's amount. Null turns it off.")),
    },
    required: ["amount_minor"],
  },
  UsageInvoiceThreshold: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["usage_invoice_threshold"] },
      scope: { type: "string", enum: ["plan", "subscription"] },
      product: nullable(str("The plan's product id.")),
      subscription: nullable(str("sub_…")),
      currency: str("ISO currency."),
      amount_minor: nullable(int("The amount. Null = off for this subscription.")),
      active: { type: "boolean" },
      created_at: str("ISO 8601."),
      updated_at: str("ISO 8601."),
    },
    required: ["object", "scope", "currency", "active"],
  },
  UsageInvoiceThresholdList: simpleList("UsageInvoiceThreshold"),
  UsageInvoiceThresholdDeleted: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["usage_invoice_threshold"] },
      deleted: { type: "boolean", enum: [true] },
    },
    required: ["object", "deleted"],
  },
};

export const USAGE_CONTROL_PATHS = {
  ...LIMIT_PATHS,
  ...TOPUP_PATHS,
};

export const USAGE_CONTROL_SCHEMAS = {
  ...LIMIT_SCHEMAS,
  ...TOPUP_SCHEMAS,
};
