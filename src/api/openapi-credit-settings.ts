/**
 * OpenAPI for the credit settings of step 6 (overage price, overdraft limits, negative balance
 * at a plan reset, void reasons) and the credit reports of step 7. `withCreditSettingsDocs`
 * adds the paths and schemas, and the new fields to the credit unit, grant and runway docs.
 */
type Node = Record<string, unknown>;
type Spec = { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };

const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});
const biz = pathParam("biz", "The business's id (biz_…).");
const cus = pathParam("cus", "The customer's id (cus_…).");
const unitP = pathParam("unit", "The credit unit's id: the slug you chose.");
const grantP = pathParam("grant", "The credit grant's id (cgr_…).");
const productP = pathParam("product", "The plan's product id.");
const q = (name: string, description: string, schema: Node = { type: "string" }) => ({
  name,
  in: "query",
  required: false,
  schema,
  description,
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(name) } },
});
const err = (description: string) => json("Error", description);
const int = (description: string) => ({ type: "integer", description });
const str = (description: string) => ({ type: "string", description });
const nullable = (schema: Node) => ({ ...schema, nullable: true });
const limit = q("limit", "Page size, 1 to 1000.", { type: "integer" });
const after = q("starting_after", "The `next_cursor` of the previous page.");

const OVERAGE =
  "Money for one credit used past the balance, in minor units of the unit's `currency`, as a " +
  "decimal string with at most 12 decimal places. Only for a unit with no rate; null = none. " +
  "The gate bills it. A meter's own usage price wins over it.";
const OVERDRAFT =
  "How far below 0 the balance may go, in the unit's smallest step (as a grant's `amount`). " +
  "The unit's own limit; a plan and a customer can override it. Default 0. Only for a unit " +
  "with no rate. The gate enforces it.";
const RESET =
  "What a plan's credit reset does with a negative balance that no invoice billed: `carry` " +
  "(default; the new grant pays it first) or `forgive` (written off at the reset). Only for a " +
  "unit with no rate.";

const unitFields = {
  overage_minor_per_unit: nullable(str(OVERAGE)),
  overdraft_limit: int(OVERDRAFT),
  negative_balance_at_reset: { type: "string", enum: ["carry", "forgive"], description: RESET },
};

const VOID_REASONS = [
  "customer_request",
  "fraud",
  "goodwill_reversal",
  "billing_error",
  "migration",
  "other",
];

const PATHS = {
  "/v1/businesses/{biz}/credit_units/{unit}/overdraft_limits": {
    get: {
      tags: ["Credits"],
      summary: "List overdraft limit overrides",
      description:
        "The plan and customer overrides of a unit's overdraft limit, oldest first. The unit's own " +
        "limit is `overdraft_limit` on the credit unit. Needs `credits:view`.",
      parameters: [
        biz,
        unitP,
        q("level", "Only plan or only customer overrides.", {
          type: "string",
          enum: ["plan", "customer"],
        }),
        limit,
        after,
      ],
      responses: {
        "200": json("CreditOverdraftLimitList", "The overrides."),
        "404": err("No such credit unit."),
      },
    },
  },
  "/v1/businesses/{biz}/credit_units/{unit}/overdraft_limits/plans/{product}": {
    put: {
      tags: ["Credits"],
      summary: "Set a plan's overdraft limit",
      description:
        "The limit for customers on this plan. A customer's own limit wins over it; it wins over " +
        "the unit's limit. With subscriptions to more than one plan that have a limit, the oldest " +
        "live subscription's plan wins. Needs `credits:manage`.",
      parameters: [biz, unitP, productP],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("CreditOverdraftLimitSet") } },
      },
      responses: {
        "200": json("CreditOverdraftLimit", "The plan's limit."),
        "400": err("The unit has a money rate, or the product is not a plan."),
        "404": err("No such credit unit or product."),
      },
    },
    delete: {
      tags: ["Credits"],
      summary: "Remove a plan's overdraft limit",
      description: "Customers on the plan then get the unit's limit. Needs `credits:manage`.",
      parameters: [biz, unitP, productP],
      responses: {
        "200": json("CreditOverdraftLimitDeleted", "Removed."),
        "404": err("No such credit unit or product."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_overdraft_limits": {
    get: {
      tags: ["Credits"],
      summary: "Get a customer's overdraft limits",
      description:
        "For each active unit with no rate: the limit that applies to the customer now and where " +
        "it comes from (customer, plan, unit, or the default 0). Needs `credits:view`.",
      parameters: [biz, cus],
      responses: {
        "200": json("CustomerCreditOverdraftLimitList", "One entry per unit."),
        "404": err("No such customer."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_overdraft_limits/{unit}": {
    put: {
      tags: ["Credits"],
      summary: "Set a customer's overdraft limit",
      description:
        "The customer's own limit wins over the plan's and the unit's. Needs `credits:manage`.",
      parameters: [biz, cus, unitP],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("CreditOverdraftLimitSet") } },
      },
      responses: {
        "200": json("CustomerCreditOverdraftLimit", "The limit that now applies."),
        "400": err("The unit has a money rate."),
        "404": err("No such customer or credit unit."),
      },
    },
    delete: {
      tags: ["Credits"],
      summary: "Remove a customer's overdraft limit",
      description: "The plan's or the unit's limit then applies. Needs `credits:manage`.",
      parameters: [biz, cus, unitP],
      responses: {
        "200": json("CustomerCreditOverdraftLimit", "The limit that now applies."),
        "404": err("No such customer or credit unit."),
      },
    },
  },
  "/v1/businesses/{biz}/reports/credit_deferred_revenue": {
    get: {
      tags: ["Credits"],
      summary: "Deferred credit revenue roll-forward",
      description:
        "Paid credit at its cost (what the buyer paid), per month in the business time zone, " +
        "currency and unit (`money` for credit in money): opening + sold − recognised − breakage " +
        "− refunds + other = closing, and a month's closing is the next month's opening. sold: " +
        "paid credit that became spendable. recognised: credit used, less draws given back. " +
        "breakage: credit that expired. refunds: credit voided by a credit note. other: rollovers " +
        "between grants. Every customer counts, so the closing balances of a currency add up to " +
        "`ledger_closing`. Credit invoiced and not yet paid is not included. Needs `credits:view`.",
      parameters: [
        biz,
        q("from", "First month, YYYY-MM. Default: 11 months before `to`."),
        q("to", "Last month, YYYY-MM. Default: this month. At most 36 months."),
        q("currency", "Only this currency."),
        q("unit", "Only this unit; `money` for credit in money."),
      ],
      responses: { "200": json("CreditDeferredRevenue", "The roll-forward.") },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/credit_grants/{grant}/activity": {
    get: {
      tags: ["Credits"],
      summary: "Get a credit grant's activity",
      description:
        "What happened to one grant: the totals (bought, used, revenue recognised, expired, " +
        "voided, left) and its movements, oldest first. A draw by usage paid in credits names " +
        "its settlement and meter; a draw on an invoice names the invoice. Needs `credits:view`.",
      parameters: [biz, cus, grantP, limit, after],
      responses: {
        "200": json("CreditGrantActivity", "The grant's activity."),
        "404": err("No such customer or credit grant."),
      },
    },
  },
  "/v1/businesses/{biz}/reports/credit_refused_demand": {
    get: {
      tags: ["Credits"],
      summary: "Refused credit usage",
      description:
        "Usage events refused because the customer did not have enough credit, per meter and " +
        "by `group_by` per day or customer: the events, their quantity in the meter's own unit, " +
        "and the credits they would have cost. Refused usage is never counted in a usage total, " +
        "an allowance or a settlement. Range at most 92 days. Needs `credits:view`.",
      parameters: [
        biz,
        { ...q("from", "Start, ISO 8601 with an offset."), required: true },
        { ...q("to", "End (exclusive), ISO 8601 with an offset."), required: true },
        q("group_by", "Default `meter`.", { type: "string", enum: ["meter", "day", "customer"] }),
        q("limit", "Rows, 1 to 1000. Default 500.", { type: "integer" }),
      ],
      responses: { "200": json("CreditRefusedDemand", "The refused usage.") },
    },
  },
};

const SCHEMAS = {
  CreditOverdraftLimitSet: {
    type: "object",
    properties: { overdraft_limit: int(OVERDRAFT) },
    required: ["overdraft_limit"],
  },
  CreditOverdraftLimit: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_overdraft_limit"] },
      unit: str("The credit unit."),
      level: { type: "string", enum: ["unit", "plan", "customer"] },
      product: nullable(str("The plan, for a plan override.")),
      product_name: nullable(str("The plan's name.")),
      customer: nullable(str("cus_…, for a customer override.")),
      customer_name: nullable(str("The customer's name.")),
      overdraft_limit: int("In the unit's smallest step."),
      overdraft_limit_decimal: str("In whole units, for example `2.5`."),
      updated_at: { type: "string", format: "date-time" },
    },
    required: ["object", "unit", "level", "overdraft_limit"],
  },
  CreditOverdraftLimitList: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: ref("CreditOverdraftLimit") },
      has_more: { type: "boolean" },
      next_cursor: nullable({ type: "string" }),
    },
    required: ["object", "data", "has_more", "next_cursor"],
  },
  CreditOverdraftLimitDeleted: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_overdraft_limit"] },
      unit: str("The credit unit."),
      level: { type: "string", enum: ["plan"] },
      product: str("The plan."),
      deleted: { type: "boolean" },
    },
    required: ["object", "unit", "deleted"],
  },
  CustomerCreditOverdraftLimit: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["customer_credit_overdraft_limit"] },
      unit: str("The credit unit."),
      unit_name: str("Plural name of the unit."),
      decimals: int("The unit's decimal places."),
      overdraft_limit: int("The limit that applies now, in the unit's smallest step."),
      overdraft_limit_decimal: str("The same, in whole units."),
      source: {
        type: "string",
        enum: ["customer", "plan", "unit", "default"],
        description: "Where the limit comes from. `default` = no limit is set: 0.",
      },
      customer_override: nullable(int("The customer's own limit; null = none.")),
    },
    required: ["object", "unit", "overdraft_limit", "source", "customer_override"],
  },
  CustomerCreditOverdraftLimitList: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      data: { type: "array", items: ref("CustomerCreditOverdraftLimit") },
    },
    required: ["object", "data"],
  },
  CreditVoidReason: {
    type: "object",
    properties: {
      reason: { type: "string", enum: VOID_REASONS },
      note: nullable(str("At most 500 characters.")),
      created_at: { type: "string", format: "date-time" },
    },
    required: ["reason", "note", "created_at"],
  },
  CreditGrantVoid: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        enum: VOID_REASONS,
        description: "Why you void the grant. Optional; the dashboard asks for one.",
      },
      note: str("At most 500 characters. Required with `other`; needs `reason`."),
      without_refund: {
        type: "boolean",
        description:
          "True voids a PAID grant with no credit note: the customer gets no money back, and the cost of the unused credit is written off as breakage. Needs `reason`. The audit log keeps the note, or the reason when there is no note. A promotional grant answers 400. You cannot undo this.",
      },
    },
  },
  CreditDeferredRevenue: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_deferred_revenue"] },
      time_zone: str("The business time zone the months are cut in."),
      from: str("YYYY-MM."),
      to: str("YYYY-MM."),
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            month: str("YYYY-MM."),
            currency: str("ISO 4217."),
            unit: str("The credit unit; `money` for credit in money."),
            opening_minor: int("Paid credit at cost at the start of the month."),
            sold_minor: int("Paid credit that became spendable."),
            recognised_minor: int("Credit used, less draws given back: moved to revenue."),
            breakage_minor: int("Credit that expired unused."),
            refunds_minor: int("Credit voided by a credit note."),
            other_minor: int("Rollovers between grants. Usually 0."),
            closing_minor: int("At the end of the month."),
            credited_minor: int(
              "What credit notes gave back on the packs this month, used credits included (a full refund). Not part of the balance above.",
            ),
          },
          required: [
            "month",
            "currency",
            "unit",
            "opening_minor",
            "sold_minor",
            "recognised_minor",
            "breakage_minor",
            "refunds_minor",
            "other_minor",
            "closing_minor",
          ],
        },
      },
      ledger_closing: {
        type: "array",
        description: "The `credit_grants_paid` ledger account at the end of `to`, per currency.",
        items: {
          type: "object",
          properties: { currency: str("ISO 4217."), credit_grants_paid_minor: int("Balance.") },
          required: ["currency", "credit_grants_paid_minor"],
        },
      },
    },
    required: ["object", "time_zone", "from", "to", "data", "ledger_closing"],
  },
  CreditGrantActivity: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_grant_activity"] },
      grant: str("cgr_…"),
      customer: str("cus_…"),
      unit: nullable(str("The credit unit; null for money.")),
      currency: str("ISO 4217."),
      category: { type: "string", enum: ["paid", "promotional"] },
      purchased_units: int("Units the grant gave, in the smallest step."),
      purchased_units_decimal: str("The same, in whole units."),
      status: str("The grant's status: pending, active, expired or voided."),
      cost_basis_minor: int("What the buyer paid. 0 for given credit."),
      used_units: int("Units used, less draws given back."),
      used_units_decimal: str("The same, in whole units."),
      revenue_recognised_minor: int("Revenue booked as the paid credit was used."),
      expired_units: int("Units that expired."),
      expired_units_decimal: str("The same, in whole units."),
      breakage_minor: int("Cost of the paid units that expired."),
      voided_units: int("Units voided."),
      voided_units_decimal: str("The same, in whole units."),
      refunded_minor: int("Cost of the paid units voided by a credit note."),
      credited_minor: int(
        "What credit notes gave back on the pack line that sold this grant. A full refund includes the used credits.",
      ),
      rolled_over_units: int("Net units moved in or out by a rollover."),
      remaining_units: int("Units left."),
      remaining_units_decimal: str("The same, in whole units."),
      remaining_cost_minor: int("Cost of the units left: deferred revenue."),
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: str("The movement id."),
            kind: {
              type: "string",
              enum: [
                "grant",
                "activate",
                "draw",
                "restore",
                "expire",
                "void",
                "rollover_in",
                "rollover_out",
              ],
            },
            created_at: { type: "string", format: "date-time" },
            units: int("Signed, in the smallest step."),
            units_decimal: str("Signed, in whole units."),
            cost_minor: int("Signed cost of these units."),
            invoice: nullable(str("in_… for an invoice draw, a purchase or a credit note void.")),
            invoice_number: nullable(str("That invoice's number, once it has one.")),
            settlement: nullable(str("cst_… for a draw by usage paid in credits.")),
            meter: nullable(str("The meter of that settlement.")),
            meter_name: nullable(str("That meter's name.")),
          },
          required: ["id", "kind", "created_at", "units", "cost_minor"],
        },
      },
      has_more: { type: "boolean" },
      next_cursor: nullable({ type: "string" }),
    },
    required: ["object", "grant", "data", "has_more", "next_cursor"],
  },
  CreditRefusedDemand: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["credit_refused_demand"] },
      group_by: { type: "string", enum: ["meter", "day", "customer"] },
      time_zone: str("The business time zone the days are cut in."),
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            day: str("YYYY-MM-DD, with `group_by=day`."),
            customer: str("cus_…, with `group_by=customer`."),
            customer_name: nullable(str("With `group_by=customer`.")),
            meter: str("The meter."),
            meter_name: str("The meter's name."),
            unit: str("The credit unit."),
            refused_events: int("Events refused."),
            customers: int("Customers refused."),
            refused_quantity: str("Quantity refused, in the meter's own unit (decimal string)."),
            refused_units: int("Credits it would have cost, in the smallest step."),
            refused_units_decimal: str("The same, in whole units."),
          },
          required: ["meter", "unit", "refused_events", "refused_quantity", "refused_units"],
        },
      },
      has_more: { type: "boolean" },
    },
    required: ["object", "group_by", "data", "has_more"],
  },
  CreditRunwayUnits: {
    type: "object",
    description: "Runway in units, for `unit` of a unit with no rate.",
    properties: {
      object: { type: "string", enum: ["credit_runway"] },
      customer: str("cus_…"),
      currency: str("The unit's currency."),
      unit: str("The credit unit."),
      estimate: { type: "boolean" },
      runway_days: nullable(int("Null with under 24 hours of usage or none.")),
      runs_out_at: nullable({ type: "string", format: "date-time" }),
      balance_units: int("What the gate offers now, in the smallest step."),
      balance_units_decimal: str("The same, in whole units."),
      burn_units_per_day: nullable(int("Units used in the last 7 days ÷ 7.")),
      burn_units_per_day_decimal: nullable(str("The same, in whole units.")),
      units_last_7_days: int("Units the gate took in the last 7 days."),
      units_last_7_days_decimal: str("The same, in whole units."),
      message: str("For example: Runs out in about 5 days."),
    },
    required: ["object", "customer", "unit", "runway_days", "balance_units"],
  },
};

const props = (schemas: Record<string, unknown>, name: string): Node => {
  const s = schemas[name] as { properties?: Node } | undefined;
  if (!s?.properties) throw new Error(`openapi: schema ${name} has no properties`);
  return s.properties;
};

/** Adds the step 6/7 paths and schemas, and the new fields to the existing credit docs. */
export function withCreditSettingsDocs<T>(spec: T): T {
  const doc = spec as unknown as Spec;
  const schemas = doc.components.schemas;
  if (schemas.CreditOverdraftLimit) return spec;
  Object.assign(doc.paths, PATHS);
  Object.assign(schemas, SCHEMAS);
  Object.assign(props(schemas, "CreditUnit"), {
    ...unitFields,
    overdraft_limit_decimal: str("`overdraft_limit` in whole units."),
  });
  Object.assign(props(schemas, "CreditUnitCreate"), unitFields);
  Object.assign(props(schemas, "CreditUnitUpdate"), unitFields);
  Object.assign(props(schemas, "CreditGrant"), {
    void_reason: nullable({
      ...ref("CreditVoidReason"),
      description: "Why an operator voided the grant. Null when none was given.",
    }),
  });
  const voidPath = doc.paths["/v1/businesses/{biz}/customers/{cus}/credit_grants/{grant}/void"] as {
    post: Node;
  };
  voidPath.post.requestBody = {
    required: false,
    content: { "application/json": { schema: ref("CreditGrantVoid") } },
  };
  const runway = doc.paths["/v1/businesses/{biz}/customers/{cus}/credit_runway"] as
    | { get: { parameters: unknown[]; responses: Record<string, unknown>; description: string } }
    | undefined;
  if (runway) {
    runway.get.parameters.push(
      q(
        "unit",
        "A credit unit with no rate: the runway in its units, from the balance the gate offers and the units used in the last 7 days.",
      ),
    );
    runway.get.responses["200"] = {
      description: "The runway estimate, in money, or in units with `unit`.",
      content: {
        "application/json": { schema: { oneOf: [ref("CreditRunway"), ref("CreditRunwayUnits")] } },
      },
    };
  }
  return spec;
}
