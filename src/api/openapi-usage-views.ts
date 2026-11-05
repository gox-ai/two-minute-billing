/**
 * OpenAPI for the usage views of the model price list (design G1b § 5.1): a customer's own
 * selling price, usage by day, the usage margin report, and the cost fields on usage lines.
 * Spread into `openapi.ts`.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(name) } },
});
const err = (description: string) => json("Error", description);
const path = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});
const q = (
  name: string,
  description: string,
  schema: Record<string, unknown> = { type: "string" },
  required = false,
) => ({ name, in: "query", required, schema, description });
const biz = path("biz", "The business's id (biz_…).");
const DECIMAL = 'A decimal string with no exponent, for example `"20"`.';

const sellingRate = {
  type: "object",
  required: ["match"],
  properties: {
    match: {
      type: "object",
      additionalProperties: { type: "string" },
      example: { model: "large-v2", token_type: "input" },
      description:
        "Group values over some of the meter's `group_by`. The row naming the most values wins.",
    },
    unit_amount_decimal: {
      type: "string",
      nullable: true,
      description: `A fixed rate: minor units per the price's \`quantity_divisor\` units. ${DECIMAL}`,
    },
    markup_percent: {
      type: "string",
      nullable: true,
      description: "Or: percent over the price's markup base, at most 6 decimal places.",
    },
  },
};

const costBasis = {
  type: "string",
  enum: ["event", "price_list", "mixed", "partial", "none", "no_rate"],
  description:
    "`event`: the events' own cost. `price_list`: your cost, else the list, for events with no cost. `mixed`: both. `partial`: some quantity had no price. `none`: no cost at all. `no_rate`: an event cost in another currency had no exchange rate.",
};

/** Merged into the existing item path in `openapi.ts` (it also holds DELETE). */
export const SELLING_PRICE_PATCH = {
  patch: {
    tags: ["Subscriptions"],
    summary: "Set a customer's selling price on an item",
    description:
      "On an item whose price bills from the model price list only. Sets this customer's markup and per-model rows. They win over the price's rates and markup. A later change to the price does not move them. Send `null` to remove a field. Needs `subscriptions:manage`; the change is audited.",
    parameters: [
      biz,
      path("sub", "The subscription's id (sub_…)."),
      path("item", "The subscription item's id (si_…)."),
    ],
    requestBody: {
      required: true,
      content: { "application/json": { schema: ref("SellingPriceUpdate") } },
    },
    responses: {
      "200": json("SubscriptionItemSellingPrice", "The item and its selling price."),
      "400": err("The price is not on the model price list, or a row is not correct."),
      "404": err("No such subscription or item."),
    },
  },
};

export const USAGE_VIEW_PATHS = {
  "/v1/businesses/{biz}/customers/{cus}/usage": {
    get: {
      tags: ["Usage"],
      summary: "Usage by day for one customer",
      description:
        "Quantities per day, meter and group values, in the business's time zone. At most 92 days. `include=cost` adds the cost of each row and needs `usage_margin:view`.",
      parameters: [
        biz,
        path("cus", "The customer's id (cus_…)."),
        q("from", "Start, inclusive (RFC 3339).", { type: "string", format: "date-time" }, true),
        q("to", "End, exclusive (RFC 3339).", { type: "string", format: "date-time" }, true),
        q("meter", "One meter's id."),
        q("group_by", "Comma-separated group keys to keep. Default: every key of each meter."),
        q("interval", "Only `day`.", { type: "string", enum: ["day"] }),
        q("include", "`cost`: add cost per row.", { type: "string", enum: ["cost"] }),
        q("currency", "The currency of the cost. Default: the business's currency."),
      ],
      responses: {
        "200": json("UsageHistory", "Usage by day."),
        "400": err("The range is more than 92 days or not correct."),
        "403": err("`include=cost` without `usage_margin:view`."),
        "404": err("No such customer or meter."),
      },
    },
  },
  "/v1/businesses/{biz}/reports/usage_margin": {
    get: {
      tags: ["Analytics"],
      summary: "Usage margin",
      description:
        "Over meter usage lines of finalized invoices (not voided) dated in the range: revenue = line amount − its discount − its credit notes, before tax; margin = revenue − cost. A line with no full cost is counted in `lines_without_cost` and left out of revenue and cost. One row per group and currency; currencies are never added together. Needs `usage_margin:view`.",
      parameters: [
        biz,
        q("from", "Start, inclusive (RFC 3339).", { type: "string", format: "date-time" }, true),
        q(
          "to",
          "End, exclusive (RFC 3339). At most 366 days after `from`.",
          { type: "string", format: "date-time" },
          true,
        ),
        q("group_by", "Default `customer`.", {
          type: "string",
          enum: ["customer", "model", "meter"],
        }),
        q("currency", "One currency only."),
        q("customer", "One customer's id (cus_…)."),
      ],
      responses: {
        "200": json("UsageMargin", "The margin per group and the totals per currency."),
        "400": err("The range is not correct."),
        "404": err("No such customer."),
      },
    },
  },
};

const marginFields = {
  currency: { type: "string" },
  revenue_minor: { type: "integer", description: "After discounts and credit notes, before tax." },
  cost_minor: { type: "integer" },
  margin_minor: { type: "integer" },
  margin_percent: { type: "string", nullable: true, example: "35.96" },
  lines: { type: "integer" },
  lines_without_cost: { type: "integer" },
};

export const USAGE_VIEW_SCHEMAS = {
  SellingPrice: {
    type: "object",
    properties: {
      markup_percent: {
        type: "string",
        nullable: true,
        description: "Percent over the price's markup base for every combination no row matches.",
      },
      rates: { type: "array", maxItems: 500, items: sellingRate },
    },
  },
  SellingPriceUpdate: {
    type: "object",
    properties: {
      markup_percent: { type: "string", nullable: true },
      rates: { type: "array", nullable: true, maxItems: 500, items: sellingRate },
    },
  },
  SubscriptionItemSellingPrice: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["subscription_item"] },
      id: { type: "string" },
      subscription: { type: "string" },
      selling_price: { ...ref("SellingPrice"), nullable: true },
    },
  },
  UsageHistory: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["usage_history"] },
      customer: { type: "string" },
      time_zone: { type: "string", example: "Asia/Kolkata" },
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" },
      interval: { type: "string", enum: ["day"] },
      currency: { type: "string", nullable: true, description: "With `include=cost` only." },
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string", format: "date", description: "In the business's time zone." },
            meter: { type: "string" },
            group: { type: "object", additionalProperties: { type: "string" } },
            quantity: { type: "string", example: "1234567" },
            cost_minor: {
              type: "integer",
              nullable: true,
              description: "With `include=cost` only.",
            },
            cost_basis: { ...costBasis, description: "With `include=cost` only." },
          },
        },
      },
    },
  },
  UsageMargin: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["usage_margin"] },
      group_by: { type: "string", enum: ["customer", "model", "meter"] },
      from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" },
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            customer: { type: "string" },
            customer_name: {
              type: "string",
              nullable: true,
              description: "With `group_by=customer`: the customer's name, else its email.",
            },
            model: { type: "string" },
            meter: { type: "string" },
            ...marginFields,
          },
        },
      },
      totals: { type: "array", items: { type: "object", properties: marginFields } },
    },
  },
};

/** Fields added to every invoice line: shown only to callers with `usage_margin:view`. */
export const LINE_COST_FIELDS = {
  cost_minor: {
    type: "integer",
    nullable: true,
    description:
      "A usage line's cost in its currency, fixed when it was rated. Only for callers with `usage_margin:view`; the customer never sees it.",
  },
  cost_basis: { ...costBasis, nullable: true },
};

/** Fields added to a usage line's `rating`. */
export const RATING_SEGMENT_FIELDS = {
  price_source: {
    type: "string",
    enum: ["model_price_list", "your_cost", "fixed_rate", "default_rate", "reported_cost"],
    description:
      "Where a line's rate came from. `reported_cost`: an `event_cost_or_list` line of the events' own cost.",
  },
  part: {
    type: "string",
    enum: ["reported_cost", "list"],
    description:
      "`event_cost_or_list` lines only: the events' own cost, or the events without one, billed from the list. Absent on a late line, which holds both.",
  },
  segments: {
    type: "array",
    description:
      "A `model_price_list` line: the rate and the rows it priced from. A price change splits a period into lines, one per segment.",
    items: {
      type: "object",
      properties: {
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        unit_amount_decimal: {
          type: "string",
          description: "The selling rate per `quantity_divisor` units.",
        },
        quantity_divisor: { type: "string" },
        markup_percent: { type: "string", nullable: true },
        markup_base: { type: "string", nullable: true, enum: ["list", "cost", null] },
        base_unit_amount_decimal: {
          type: "string",
          nullable: true,
          description: "The markup base's rate. Null on a `cost` base without `usage_margin:view`.",
        },
        rate_from: { type: "string", enum: ["subscription_override", "price_rate", "price"] },
        price_source: {
          type: "string",
          enum: ["model_price_list", "your_cost", "fixed_rate", "default_rate", "reported_cost"],
        },
        model_price_id: { type: "string", nullable: true, description: "The list row (mpr_…)." },
        model_cost_override_id: {
          type: "string",
          nullable: true,
          description: "Your cost row (mco_…). Only for callers with `usage_margin:view`.",
        },
        source: { type: "string", nullable: true },
        source_version: { type: "string", nullable: true },
        source_effective_from: { type: "string", format: "date", nullable: true },
      },
    },
  },
};
