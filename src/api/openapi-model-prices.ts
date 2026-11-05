/**
 * OpenAPI for the AI model price list and "your cost" (design G1b § 5.1). Spread into
 * `openapi.ts`.
 */

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
  required = false,
) => ({ name, in: "query", required, schema, description });
const idParam = (description: string) => ({
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});

const DECIMAL =
  'A decimal string with at most 12 decimal places and no exponent, for example `"0.25"`.';
const UNIT_AMOUNT = `Minor units (cents for USD) per \`quantity_divisor\` units. ${DECIMAL}`;

export const MODEL_PRICE_TAG = {
  name: "Model prices",
  description:
    "A dated price list for AI models (model × token type), refreshed every hour from the " +
    "public genai-prices list (MIT license) into a table we keep. Prices are USD. Each row " +
    "has two dates: `source_effective_from`, the source's own date, and `effective_from`, the " +
    "instant we apply it from. A change never reprices usage recorded before it. Every usage " +
    "line that bills from the list cites the row it used (`mpr_…`), and you can get that row " +
    "here.\n\n**Your cost** is the price your organization pays its model provider. It feeds " +
    "cost and margin, and is the markup base when a price asks for it. The sync never changes it.",
};

export const MODEL_PRICE_PATHS = {
  "/v1/organization/model_prices": {
    get: {
      tags: ["Model prices"],
      summary: "List model prices",
      description:
        "The list price per model and token type at `as_of` (default now), with your cost in " +
        "effect at the same instant.",
      parameters: [
        q("provider", "Only this provider, for example `openai`."),
        q("model", "Only this model id."),
        q("token_type", "Only this token type, for example `input`."),
        q("q", "Text in the model or provider id."),
        q("has_cost", "Only rows with your cost.", { type: "boolean" }),
        q("used", "Only models your meters saw in the last 35 days.", { type: "boolean" }),
        q(
          "business",
          "Only models this business (biz_…) used in the last 35 days. Implies `used`.",
        ),
        q("as_of", "Prices at this instant.", { type: "string", format: "date-time" }),
        q("limit", "Page size, 1–500 (default 100).", { type: "integer" }),
        q("starting_after", "Cursor: the last row's `id` from the previous page."),
      ],
      responses: {
        "200": json("ModelPriceList", "One page of list prices."),
        "400": err("A parameter is not correct."),
      },
    },
  },
  "/v1/organization/model_prices/history": {
    get: {
      tags: ["Model prices"],
      summary: "Price history of a model",
      description:
        "Every dated list row of a model, both dates on each, and your cost rows for it.",
      parameters: [
        q("model", "The model id.", { type: "string" }, true),
        q("provider", "Only this provider."),
        q("token_type", "Only this token type."),
      ],
      responses: {
        "200": json("ModelPriceHistory", "The model's price history."),
        "400": err("A parameter is not correct."),
      },
    },
  },
  "/v1/organization/model_prices/source": {
    get: {
      tags: ["Model prices"],
      summary: "Price list source",
      description:
        "Where the list comes from, its license, and how fresh it is. When `held` is true, a " +
        "sync changed prices sharply and waits until the source keeps them for 6 hours; bills " +
        "use the last prices until then.",
      responses: { "200": json("ModelPriceSource", "The source state.") },
    },
  },
  "/v1/organization/model_prices/drift": {
    get: {
      tags: ["Model prices"],
      summary: "List drift",
      description:
        "For each model, what your calls that reported their cost really cost, against the list " +
        "price of the same tokens, over the last 7 days. USD events only. Models with no " +
        "reported cost are not listed.",
      parameters: [q("business", "Only this business's usage (biz_…).")],
      responses: { "200": json("ModelPriceDriftList", "The drift per model.") },
    },
  },
  "/v1/organization/model_prices/{id}": {
    get: {
      tags: ["Model prices"],
      summary: "Retrieve a model price",
      description: "One dated list row: the id a usage line cites in `rating.segments[]`.",
      parameters: [idParam("The row's id (mpr_…).")],
      responses: {
        "200": json("ModelPrice", "The list row."),
        "404": err("No such model price."),
      },
    },
  },
  "/v1/organization/model_cost_overrides": {
    get: {
      tags: ["Model prices"],
      summary: "List your costs",
      parameters: [
        q("model", "Only this model."),
        q("provider", "Only this provider."),
        q("token_type", "Only this token type."),
        q("limit", "Page size, 1–500 (default 100).", { type: "integer" }),
        q("starting_after", "Cursor: the last row's `id` from the previous page."),
      ],
      responses: { "200": json("ModelCostOverrideList", "Your cost rows, newest first.") },
    },
    post: {
      tags: ["Model prices"],
      summary: "Set your cost",
      description:
        "Record the price you pay for a model and token type. It starts now or later and never " +
        "reaches back over usage that is already costed. To change a cost, end the current row " +
        "and add a new one. The model can be one the list does not have. Needs `model_prices:manage`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("ModelCostOverrideCreate") } },
      },
      responses: {
        "201": json("ModelCostOverride", "The cost row."),
        "400": err("The body is not correct, or `effective_from` is in the past."),
        "409": err("Another cost for this key is in effect in that period."),
      },
    },
  },
  "/v1/organization/model_cost_overrides/{id}": {
    get: {
      tags: ["Model prices"],
      summary: "Retrieve your cost",
      parameters: [idParam("The cost's id (mco_…).")],
      responses: {
        "200": json("ModelCostOverride", "The cost row."),
        "404": err("No such cost."),
      },
    },
    delete: {
      tags: ["Model prices"],
      summary: "Delete your cost",
      description:
        "Only a cost that has not started. A started cost can be on an invoice: end it instead.",
      parameters: [idParam("The cost's id (mco_…).")],
      responses: {
        "200": json("ModelCostOverride", "The deleted row, with `deleted: true`."),
        "404": err("No such cost."),
        "409": err("The cost has started."),
      },
    },
  },
  "/v1/organization/model_cost_overrides/{id}/end": {
    post: {
      tags: ["Model prices"],
      summary: "End your cost",
      description: "Set `effective_to` to now (default) or a later instant.",
      parameters: [idParam("The cost's id (mco_…).")],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                effective_to: {
                  type: "string",
                  format: "date-time",
                  description: "Now or later. Default now.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": json("ModelCostOverride", "The ended row."),
        "400": err("`effective_to` is in the past or before the start."),
        "404": err("No such cost."),
        "409": err("The cost has already ended, or the new end overlaps another cost."),
      },
    },
  },
};

const costFields = {
  provider: {
    type: "string",
    nullable: true,
    description: "Null = this model under any provider.",
  },
  model: { type: "string", description: "The model id or name, as your events send it." },
  token_type: { type: "string", example: "input" },
  currency: { type: "string", example: "USD" },
  unit_amount_decimal: { type: "string", example: "200", description: UNIT_AMOUNT },
  quantity_divisor: { type: "integer", example: 1000000 },
};

const modelPrice = {
  type: "object",
  properties: {
    object: { type: "string", enum: ["model_price"] },
    id: { type: "string", example: "mpr_…" },
    provider: { type: "string", example: "openai" },
    model: { type: "string", example: "gpt-4o" },
    token_type: {
      type: "string",
      example: "input",
      description: "`input`, `output`, `cache_read`, `cache_write`, … as the source names them.",
    },
    currency: { type: "string", example: "USD" },
    unit_amount_decimal: { type: "string", example: "250", description: UNIT_AMOUNT },
    quantity_divisor: {
      type: "integer",
      example: 1000000,
      description: "1,000,000 for tokens; 1,000 for counted items such as web searches.",
    },
    effective_from: {
      type: "string",
      format: "date-time",
      nullable: true,
      description: "The instant we apply this price from. Null = the model's first price.",
    },
    source_effective_from: {
      type: "string",
      format: "date",
      nullable: true,
      description: "The source's own date for this price.",
    },
    source: { type: "string", example: "genai-prices" },
    source_version: { type: "string", nullable: true },
    rounded: {
      type: "boolean",
      description:
        "The source value had more than 12 decimal places in cents: rounded half-up once.",
    },
    last_seen_at: {
      type: "string",
      format: "date-time",
      nullable: true,
      description: "When the source last listed this model.",
    },
  },
};

const costOverride = {
  type: "object",
  properties: {
    object: { type: "string", enum: ["model_cost_override"] },
    id: { type: "string", example: "mco_…" },
    ...costFields,
    effective_from: { type: "string", format: "date-time" },
    effective_to: { type: "string", format: "date-time", nullable: true },
    note: { type: "string", nullable: true },
    created_at: { type: "string", format: "date-time" },
    deleted: { type: "boolean", description: "Present and true on a delete response." },
  },
};

const page = (item: string) => ({
  type: "object",
  properties: {
    object: { type: "string", enum: ["list"] },
    data: { type: "array", items: ref(item) },
    has_more: { type: "boolean" },
    next_cursor: { type: "string", nullable: true },
  },
});

export const MODEL_PRICE_SCHEMAS = {
  ModelPrice: modelPrice,
  ModelPriceListRow: {
    allOf: [
      ref("ModelPrice"),
      {
        type: "object",
        properties: {
          cost: { ...ref("ModelCostOverride"), nullable: true },
          used: { type: "boolean" },
        },
      },
    ],
  },
  ModelPriceList: page("ModelPriceListRow"),
  ModelPriceHistory: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["model_price_history"] },
      provider: { type: "string", nullable: true },
      model: { type: "string" },
      prices: { type: "array", items: ref("ModelPrice") },
      costs: { type: "array", items: ref("ModelCostOverride") },
    },
  },
  ModelPriceSource: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["model_price_source"] },
      source: { type: "string", example: "genai-prices" },
      url: { type: "string" },
      licence: { type: "string" },
      checked_at: { type: "string", format: "date-time", nullable: true },
      last_success_at: { type: "string", format: "date-time", nullable: true },
      check_error: { type: "string", nullable: true },
      upstream_version: { type: "string", nullable: true },
      held: { type: "boolean" },
      next_check_at: { type: "string", format: "date-time" },
      providers: { type: "array", items: { type: "string" } },
    },
  },
  ModelPriceDriftList: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["list"] },
      window: {
        type: "object",
        properties: {
          start: { type: "string", format: "date-time" },
          end: { type: "string", format: "date-time" },
        },
      },
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            object: { type: "string", enum: ["model_price_drift"] },
            provider: { type: "string" },
            model: { type: "string" },
            reported_cost_minor: { type: "integer", description: "USD cents the calls reported." },
            list_cost_minor: {
              type: "integer",
              description: "USD cents the list gives for the same tokens.",
            },
            difference_percent: {
              type: "number",
              example: 14.2,
              description: "(reported ÷ list − 1) × 100. Positive: your calls cost more.",
            },
          },
        },
      },
    },
  },
  ModelCostOverride: costOverride,
  ModelCostOverrideList: page("ModelCostOverride"),
  ModelCostOverrideCreate: {
    type: "object",
    additionalProperties: false,
    required: ["model", "token_type", "currency", "unit_amount_decimal", "quantity_divisor"],
    properties: {
      ...costFields,
      quantity_divisor: {
        oneOf: [{ type: "integer", minimum: 1 }, { type: "string" }],
        description: "Units the amount is for: 1000000 (per 1M), 1000 (per 1K) or 1.",
      },
      effective_from: {
        type: "string",
        format: "date-time",
        description: "Now or later. Default now.",
      },
      effective_to: { type: "string", format: "date-time", nullable: true },
      note: { type: "string", maxLength: 500, nullable: true },
    },
  },
};
