/**
 * OpenAPI for the price-change preview and the embeddable usage widget (design G5 § 3.8,
 * § 3.9). Spread into `openapi.ts`.
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
const biz = path("biz", "The business's id (biz_…).");
const DECIMAL =
  'A decimal string with at most 12 decimal places and no exponent, for example `"0.25"`.';

/** One tag for every usage-control route (limits, alerts, auto top-up, threshold invoicing, …). */
export const USAGE_CONTROLS_TAG = {
  name: "Usage controls",
  description:
    "Keep spend in check and bill usage early: spend limits that the access check enforces, " +
    "alerts with a state per threshold, credit runway, automatic top-up, invoices raised when " +
    "unbilled usage reaches an amount, a preview of a rate change on real usage, and an " +
    "embeddable usage widget for your own app.",
};

/** POST-shaped reads: they write nothing, so there is nothing to deduplicate. */
export const RATE_PREVIEW_IDEMPOTENCY_EXEMPT = [
  "post /v1/businesses/{biz}/prices/{price}/rate_change_preview",
];

const meterTier = {
  type: "object",
  required: ["up_to", "unit_amount_decimal"],
  properties: {
    up_to: {
      type: "string",
      nullable: true,
      description: `Inclusive upper bound in units. ${DECIMAL} Null on the last tier.`,
    },
    unit_amount_decimal: {
      type: "string",
      description: `Minor units per \`quantity_divisor\` units. ${DECIMAL}`,
    },
    flat_amount_minor: {
      type: "integer",
      description: "A flat amount for the tier, in minor units.",
    },
  },
};

export const USAGE_WIDGET_PATHS = {
  "/v1/businesses/{biz}/prices/{price}/rate_change_preview": {
    post: {
      tags: ["Usage controls"],
      summary: "Preview a rate change",
      description:
        "Re-rates each customer's last closed period of usage on this price under a draft rate " +
        "card, before you save it. The period is the window of the customer's last finalized " +
        "period invoice. `old_minor` rates that usage under the customer's current rate (the " +
        "invoiced amount when the rate did not change in that period); `new_minor` under the " +
        "draft. Fields you leave out keep their current values. Sorted by `diff_minor`, largest " +
        "increase first, in pages of up to 200; at most 5,000 customers per request " +
        "(`truncated` says when there are more). Writes nothing. Tax, discounts, credits and " +
        "minimums are not applied.",
      parameters: [biz, path("price", "The usage price (price_…).")],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("RateChangePreviewRequest") } },
      },
      responses: {
        "200": json("RateChangePreview", "The preview."),
        "400": err(
          "The price has no rate, or the draft is not a valid rate card. `param` names the field.",
        ),
        "404": err("No such price."),
      },
    },
  },
  "/v1/businesses/{biz}/customers/{cus}/usage_widget_tokens": {
    post: {
      tags: ["Usage controls"],
      summary: "Create a usage widget token",
      description:
        "Mints a read-only `uwt_…` bearer token for the embeddable usage widget, bound to this " +
        "customer and valid for 15 minutes. Call it from your backend, never from the browser, and " +
        "hand the token to the widget's `getToken`. The widget calls `getToken` again when the " +
        "token expires. The token reads `GET /widget/v1/usage` only; no write route accepts it. " +
        "The response is not stored for idempotent replay, because it carries the token.",
      parameters: [biz, path("cus", "The customer's id (cus_…).")],
      responses: {
        "201": json("UsageWidgetToken", "The token. It is shown once."),
        "404": err("No such customer."),
      },
    },
  },
  "/v1/businesses/{biz}/settings/usage_widget": {
    get: {
      tags: ["Usage controls"],
      summary: "Get the usage widget settings",
      description:
        "The origins that may call the widget, and the script URL and integrity hash for the snippet.",
      parameters: [biz],
      responses: { "200": json("UsageWidgetSettings", "The settings.") },
    },
    put: {
      tags: ["Usage controls"],
      summary: "Set the usage widget origins",
      description:
        "Replaces the list of origins (scheme, host and port, for example " +
        "`https://app.example.com`) allowed to call the widget from a browser. https only; plain http " +
        "is accepted only from a loopback origin, for local testing. A request from an origin that is not on the list gets no CORS grant, " +
        "so the browser does not show the data. At most 20.",
      parameters: [biz],
      requestBody: {
        required: true,
        content: { "application/json": { schema: ref("UsageWidgetSettingsUpdate") } },
      },
      responses: {
        "200": json("UsageWidgetSettings", "The saved settings."),
        "400": err("An origin is not valid. `param` names it."),
      },
    },
  },
};

export const USAGE_WIDGET_SCHEMAS = {
  RateChangePreviewRequest: {
    type: "object",
    properties: {
      unit_amount_decimal: {
        type: "string",
        nullable: true,
        description: `Meter prices: the default rate, minor units per \`quantity_divisor\` units. ${DECIMAL}`,
      },
      quantity_divisor: {
        type: "string",
        description:
          "Meter prices: the number of units the rate is for, a whole number of 1 or more.",
      },
      tiers: {
        type: "array",
        description:
          "The tiers. Meter prices take `{up_to, unit_amount_decimal, flat_amount_minor}`; other " +
          "usage prices take `{upToMinor, unitAmountMinor, flatAmountMinor}`, as on the price.",
        items: { type: "object" },
      },
      rates: {
        type: "array",
        description: "Meter prices: the whole rate card. It replaces the current one.",
        items: {
          type: "object",
          required: ["match"],
          properties: {
            match: { type: "object", additionalProperties: { type: "string" } },
            unit_amount_decimal: { type: "string" },
            tiers: { type: "array", items: meterTier },
          },
        },
      },
      amount_minor: {
        type: "integer",
        description: "Usage prices not on a meter: the unit amount in minor units.",
      },
      limit: { type: "integer", description: "Page size, 1–200 (default 200)." },
      starting_after: {
        type: "string",
        description: "Cursor: the last row's `customer` from the previous page.",
      },
    },
  },
  RateChangePreview: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["rate_change_preview"] },
      price: { type: "string" },
      currency: { type: "string" },
      basis: { type: "string", enum: ["last_closed_period"] },
      totals: {
        type: "object",
        properties: {
          customers: { type: "integer" },
          old_minor: { type: "integer" },
          new_minor: { type: "integer" },
          diff_minor: { type: "integer" },
          diff_bps: { type: "integer", nullable: true },
        },
      },
      customers_without_usage: {
        type: "integer",
        description: "Customers on the price with no finalized period invoice yet.",
      },
      truncated: { type: "boolean", description: "More than 5,000 customers are on the price." },
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            customer: { type: "string" },
            customer_name: { type: "string", nullable: true },
            subscriptions: { type: "array", items: { type: "string" } },
            period_start: { type: "string", format: "date-time", nullable: true },
            period_end: { type: "string", format: "date-time", nullable: true },
            old_minor: { type: "integer" },
            new_minor: { type: "integer" },
            diff_minor: { type: "integer" },
            diff_bps: {
              type: "integer",
              nullable: true,
              description: "The change in basis points of `old_minor`; null when `old_minor` is 0.",
            },
          },
        },
      },
      has_more: { type: "boolean" },
      next_cursor: { type: "string", nullable: true },
    },
  },
  UsageWidgetToken: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["usage_widget_token"] },
      customer: { type: "string" },
      token: { type: "string", description: "`uwt_…`. Read-only, for this customer only." },
      expires_at: { type: "string", format: "date-time" },
    },
  },
  UsageWidgetSettings: {
    type: "object",
    properties: {
      object: { type: "string", enum: ["usage_widget_settings"] },
      origins: { type: "array", items: { type: "string" } },
      script_url: {
        type: "string",
        nullable: true,
        description:
          "Where the page loads `usage.js` from. Null when the API's public URL is not set.",
      },
      script_integrity: {
        type: "string",
        description: "The Subresource Integrity hash for the script tag's `integrity` attribute.",
      },
    },
  },
  UsageWidgetSettingsUpdate: {
    type: "object",
    required: ["origins"],
    properties: { origins: { type: "array", maxItems: 20, items: { type: "string" } } },
  },
};
