/**
 * The file formats a bulk import accepts: one CSV per entity. Each field has a key (the
 * template's column name), the header names it is also recognised by, and a parser kind.
 * Pure data, shared by the check, the template download and the column mapping.
 */
import { csvRow } from "@/platform/csv";
import { GATEWAY_KEYS } from "@/providers/gateway-catalog";

export const IMPORT_ENTITIES = [
  "plans",
  "addons",
  "coupons",
  "customers",
  "subscriptions",
  "invoices",
  "credit_notes",
  "payments",
  "usage",
] as const;
/** The files that carry history: settled and open documents, money moved, usage. */
export const HISTORY_ENTITIES = ["invoices", "credit_notes", "payments", "usage"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export type FieldKind =
  | "id"
  | "text"
  | "email"
  | "money"
  | "int"
  | "percent"
  | "enum"
  | "date"
  | "currency"
  | "country"
  | "tiers"
  | "list";

export interface FieldDef {
  key: string;
  kind: FieldKind;
  required?: boolean;
  /** Other header names this column is recognised by (any case, any punctuation). */
  aliases?: string[];
  /** enum: accepted value (normalized) → stored value. */
  values?: Record<string, string>;
  example: string;
  help: string;
}

const INTERVALS = {
  day: "day",
  daily: "day",
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
  year: "year",
  yearly: "year",
  annual: "year",
  annually: "year",
};
const STATUS_ACTIVE = { active: "active", archived: "archived", inactive: "archived" };

const priceFields = (kind: "plan" | "addon"): FieldDef[] => [
  {
    key: "price_id",
    kind: "id",
    required: true,
    aliases: ["item_price_id", "id", `${kind}_price_id`],
    example: kind === "plan" ? "pro-monthly-usd" : "extra-seat-monthly-usd",
    help: "The ID of the price. Subscriptions refer to this ID.",
  },
  {
    key: `${kind}_id`,
    kind: "id",
    aliases: ["item_id", "product_id"],
    example: kind === "plan" ? "pro" : "extra-seat",
    help: `The ID of the ${kind === "plan" ? "plan" : "add-on"}. Rows with the same ID are prices of one ${kind === "plan" ? "plan" : "add-on"}. If empty, the price ID is used.`,
  },
  {
    key: "name",
    kind: "text",
    required: true,
    aliases: [`${kind}_name`, "product_name", "item_name", "title"],
    example: kind === "plan" ? "Pro" : "Extra seat",
    help: "The name that customers see.",
  },
  {
    key: "pricing_model",
    kind: "enum",
    aliases: ["model", "price_model"],
    values: {
      flat: "flat",
      flat_fee: "flat",
      fixed: "flat",
      per_unit: "per_unit",
      unit: "per_unit",
      tiered: "tiered",
      volume: "volume",
      stairstep: "stairstep",
    },
    example: kind === "plan" ? "flat" : "per_unit",
    help: "flat, per_unit, tiered, volume or stairstep. Empty means flat.",
  },
  {
    key: "amount",
    kind: "money",
    aliases: ["price", "unit_amount", "unit_price"],
    example: kind === "plan" ? "49.00" : "10.00",
    help: "The price in the currency's main unit, for example 49.00. Not used for tiered, volume and stairstep prices.",
  },
  {
    key: "currency",
    kind: "currency",
    required: true,
    aliases: ["currency_code"],
    example: "USD",
    help: "Three-letter currency code.",
  },
  {
    key: "interval",
    kind: "enum",
    required: kind === "plan",
    aliases: [
      "period_unit",
      "billing_period_unit",
      "billing_interval",
      "recurring_interval",
      "frequency",
    ],
    values: INTERVALS,
    example: "month",
    help:
      kind === "plan"
        ? "day, week, month or year."
        : "day, week, month or year. Empty means a one-time charge.",
  },
  {
    key: "interval_count",
    kind: "int",
    aliases: ["period", "billing_period", "recurring_interval_count"],
    example: "1",
    help: "Bill every this many intervals. Empty means 1.",
  },
  {
    key: "tiers",
    kind: "tiers",
    example: "",
    help: "For tiered, volume and stairstep prices: up_to:amount pairs, separated by |. Example: 10:5.00|50:4.00|inf:3.00",
  },
  ...(kind === "plan"
    ? [
        {
          key: "trial_days",
          kind: "int" as const,
          aliases: ["trial_period_days", "trial_period"],
          example: "14",
          help: "Days of free trial for new subscriptions. Empty means no trial.",
        },
      ]
    : []),
  { key: "description", kind: "text", example: "", help: "A description for your team." },
  {
    key: "status",
    kind: "enum",
    values: STATUS_ACTIVE,
    example: "active",
    help: "active or archived. Empty means active.",
  },
  {
    key: "created_at",
    kind: "date",
    aliases: ["created", "created_date"],
    example: "2025-01-15",
    help: "When the price was made. Empty means now.",
  },
];

export const ENTITY_FIELDS: Record<ImportEntity, FieldDef[]> = {
  plans: priceFields("plan"),
  addons: priceFields("addon"),
  coupons: [
    {
      key: "coupon_id",
      kind: "id",
      required: true,
      aliases: ["id", "code", "coupon_code"],
      example: "SAVE20",
      help: "The coupon code. Customers type this code, and subscriptions refer to it.",
    },
    {
      key: "name",
      kind: "text",
      aliases: ["coupon_name"],
      example: "20% off",
      help: "The name your team sees.",
    },
    {
      key: "discount_type",
      kind: "enum",
      required: true,
      aliases: ["type", "discount"],
      values: {
        percentage: "percentage",
        percent: "percentage",
        fixed_amount: "fixed_amount",
        fixed: "fixed_amount",
        amount: "fixed_amount",
        flat: "fixed_amount",
      },
      example: "percentage",
      help: "percentage or fixed_amount.",
    },
    {
      key: "percent_off",
      kind: "percent",
      aliases: ["discount_percentage", "percentage"],
      example: "20",
      help: "For a percentage coupon: the percent, for example 20 or 12.5.",
    },
    {
      key: "amount_off",
      kind: "money",
      aliases: ["discount_amount"],
      example: "",
      help: "For a fixed_amount coupon: the amount in the currency's main unit.",
    },
    {
      key: "currency",
      kind: "currency",
      aliases: ["currency_code"],
      example: "",
      help: "For a fixed_amount coupon: the three-letter currency code.",
    },
    {
      key: "duration",
      kind: "enum",
      aliases: ["duration_type"],
      values: {
        once: "once",
        one_time: "once",
        forever: "forever",
        repeating: "repeating",
        limited_period: "repeating",
      },
      example: "repeating",
      help: "once, forever or repeating. Empty means once.",
    },
    {
      key: "duration_periods",
      kind: "int",
      aliases: ["duration_in_months", "period"],
      example: "3",
      help: "For a repeating coupon: how many billing periods it applies.",
    },
    {
      key: "max_redemptions",
      kind: "int",
      example: "",
      help: "How many times the coupon can be used in total. Empty means no limit.",
    },
    {
      key: "redeem_by",
      kind: "date",
      aliases: ["valid_till", "expires_at"],
      example: "",
      help: "The last date the coupon can be used. Empty means no end.",
    },
    {
      key: "status",
      kind: "enum",
      values: STATUS_ACTIVE,
      example: "active",
      help: "active or archived. Empty means active.",
    },
    {
      key: "created_at",
      kind: "date",
      aliases: ["created"],
      example: "",
      help: "When the coupon was made. Empty means now.",
    },
  ],
  customers: [
    {
      key: "customer_id",
      kind: "id",
      required: true,
      aliases: ["id", "cust_id"],
      example: "cust-0001",
      help: "The customer's ID in your current system. It becomes the customer's ID here.",
    },
    {
      key: "email",
      kind: "email",
      aliases: ["email_address"],
      example: "jordan@example.com",
      help: "The billing email.",
    },
    { key: "first_name", kind: "text", example: "Jordan", help: "" },
    { key: "last_name", kind: "text", example: "Lee", help: "" },
    {
      key: "name",
      kind: "text",
      aliases: ["full_name", "customer_name"],
      example: "",
      help: "Full name, if you have no first and last name columns.",
    },
    {
      key: "company",
      kind: "text",
      aliases: ["company_name", "organization", "business_name"],
      example: "",
      help: "",
    },
    { key: "phone", kind: "text", aliases: ["phone_number"], example: "", help: "" },
    {
      key: "address_line1",
      kind: "text",
      aliases: ["billing_address_line1", "address_line_1", "address", "line1", "address1"],
      example: "500 Market St",
      help: "",
    },
    {
      key: "address_line2",
      kind: "text",
      aliases: ["billing_address_line2", "address_line_2", "line2", "address2"],
      example: "",
      help: "",
    },
    {
      key: "city",
      kind: "text",
      aliases: ["billing_address_city", "address_city"],
      example: "Austin",
      help: "",
    },
    {
      key: "state",
      kind: "text",
      aliases: ["billing_address_state", "address_state", "state_code", "province", "region"],
      example: "TX",
      help: "",
    },
    {
      key: "postal_code",
      kind: "text",
      aliases: ["billing_address_zip", "zip", "zip_code", "postcode", "address_postal_code"],
      example: "78701",
      help: "",
    },
    {
      key: "country",
      kind: "country",
      aliases: ["billing_address_country", "address_country", "country_code"],
      example: "US",
      help: "Two-letter country code.",
    },
    {
      key: "tax_id",
      kind: "text",
      aliases: ["vat_number", "gstin", "tax_number", "tax_id_value"],
      example: "",
      help: "The customer's tax registration number.",
    },
    {
      key: "auto_collection",
      kind: "enum",
      values: { on: "on", true: "on", yes: "on", off: "off", false: "off", no: "off" },
      example: "on",
      help: "on: charge the saved card at renewal. off: send an invoice. Empty means on.",
    },
    {
      key: "net_term_days",
      kind: "int",
      aliases: ["net_terms", "payment_terms_days"],
      example: "",
      help: "Days to pay an invoice when auto collection is off.",
    },
    {
      key: "payment_gateway",
      kind: "enum",
      aliases: ["gateway", "card_gateway", "payment_provider"],
      values: Object.fromEntries(GATEWAY_KEYS.map((k) => [k, k])),
      example: "stripe",
      help: "The gateway that stores the customer's card.",
    },
    {
      key: "gateway_customer_id",
      kind: "text",
      aliases: ["provider_customer_id", "stripe_customer_id"],
      example: "cus_XXXXXXXXXXXX01",
      help: "The customer's ID at the gateway.",
    },
    {
      key: "gateway_payment_method_id",
      kind: "text",
      aliases: [
        "payment_method_id",
        "card_id",
        "gateway_card_id",
        "default_payment_method",
        "default_source",
        "token",
      ],
      example: "pm_XXXXXXXXXXXX01",
      help: "The ID of the saved card at the gateway. Never a card number.",
    },
    { key: "card_brand", kind: "text", aliases: ["brand", "card_type"], example: "visa", help: "" },
    {
      key: "card_last4",
      kind: "text",
      aliases: ["last4", "card_last_4", "masked_number"],
      example: "4242",
      help: "",
    },
    {
      key: "card_exp_month",
      kind: "int",
      aliases: ["exp_month", "expiry_month"],
      example: "12",
      help: "",
    },
    {
      key: "card_exp_year",
      kind: "int",
      aliases: ["exp_year", "expiry_year"],
      example: "2028",
      help: "",
    },
    {
      key: "created_at",
      kind: "date",
      aliases: ["created", "created_date"],
      example: "2025-01-15",
      help: "When the customer signed up. Empty means now.",
    },
  ],
  subscriptions: [
    {
      key: "subscription_id",
      kind: "id",
      required: true,
      aliases: ["id", "sub_id"],
      example: "sub-0001",
      help: "The subscription's ID. Use one row for each item: rows with the same ID are one subscription.",
    },
    {
      key: "customer_id",
      kind: "id",
      required: true,
      aliases: ["customer", "cust_id"],
      example: "cust-0001",
      help: "The customer's ID, from your customers file or from customers that are here already.",
    },
    {
      key: "price_id",
      kind: "id",
      required: true,
      aliases: ["item_price_id", "plan_id", "plan", "price", "plan_price_id"],
      example: "pro-monthly-usd",
      help: "The price's ID, from your plans or add-ons file or from prices that are here already.",
    },
    {
      key: "quantity",
      kind: "int",
      aliases: ["qty", "plan_quantity", "item_quantity"],
      example: "1",
      help: "Empty means 1.",
    },
    {
      key: "unit_price",
      kind: "money",
      aliases: ["price_override", "unit_amount", "plan_unit_price"],
      example: "",
      help: "A negotiated price for this item. Empty means the price's amount.",
    },
    {
      key: "status",
      kind: "enum",
      aliases: ["subscription_status", "state"],
      values: {
        active: "active",
        trialing: "trialing",
        in_trial: "trialing",
        trial: "trialing",
        future: "future",
        paused: "paused",
        canceled: "canceled",
        cancelled: "canceled",
        non_renewing: "non_renewing",
      },
      example: "active",
      help: "active, trialing, future, paused, non_renewing or cancelled. Empty means active.",
    },
    {
      key: "currency",
      kind: "currency",
      aliases: ["currency_code"],
      example: "USD",
      help: "Empty means the price's currency.",
    },
    {
      key: "current_term_start",
      kind: "date",
      aliases: ["current_period_start", "current_term_start_date", "period_start"],
      example: "2026-11-15",
      help: "When the period the customer has paid for started.",
    },
    {
      key: "current_term_end",
      kind: "date",
      required: true,
      aliases: [
        "current_period_end",
        "current_term_end_date",
        "next_billing_at",
        "next_billing_date",
        "renews_at",
        "period_end",
      ],
      example: "2026-12-15",
      help: "When the period the customer has paid for ends. The first renewal here is on this date.",
    },
    {
      key: "trial_end",
      kind: "date",
      aliases: ["trial_end_date", "trial_ends_at"],
      example: "",
      help: "For a trialing subscription: when the trial ends.",
    },
    {
      key: "start_date",
      kind: "date",
      aliases: ["starts_at"],
      example: "",
      help: "For a future subscription: when it starts.",
    },
    {
      key: "cancelled_at",
      kind: "date",
      aliases: ["canceled_at", "cancelled_date", "ended_at"],
      example: "",
      help: "For a cancelled subscription: when it ended.",
    },
    {
      key: "coupon_ids",
      kind: "list",
      aliases: ["coupons", "coupon", "coupon_id", "coupon_code"],
      example: "",
      help: "Coupon codes on the subscription, separated by |.",
    },
    {
      key: "auto_collection",
      kind: "enum",
      values: { on: "on", true: "on", yes: "on", off: "off", false: "off", no: "off" },
      example: "",
      help: "on or off. Empty means the customer's setting.",
    },
    { key: "po_number", kind: "text", aliases: ["purchase_order"], example: "", help: "" },
    {
      key: "created_at",
      kind: "date",
      aliases: ["created", "started_at", "start"],
      example: "2025-01-15",
      help: "When the subscription started. Empty means now.",
    },
  ],
  invoices: [
    {
      key: "invoice_id",
      kind: "id",
      required: true,
      aliases: ["id", "inv_id"],
      example: "inv-0001",
      help: "The invoice's ID in your current system. Use one row for each line: rows with the same ID are one invoice.",
    },
    {
      key: "customer_id",
      kind: "id",
      required: true,
      aliases: ["customer", "cust_id"],
      example: "cust-0001",
      help: "The customer's ID, from your customers file or from customers that are here already.",
    },
    {
      key: "subscription_id",
      kind: "id",
      aliases: ["subscription", "sub_id"],
      example: "sub-0001",
      help: "The subscription the invoice bills, if any.",
    },
    {
      key: "number",
      kind: "text",
      aliases: ["invoice_number", "document_number"],
      example: "INV-1001",
      help: "The number printed on the invoice. Empty means the invoice ID.",
    },
    {
      key: "status",
      kind: "enum",
      required: true,
      aliases: ["invoice_status", "state"],
      values: {
        paid: "paid",
        open: "payment_due",
        due: "payment_due",
        payment_due: "payment_due",
        unpaid: "payment_due",
        not_paid: "payment_due",
        posted: "payment_due",
        void: "voided",
        voided: "voided",
      },
      example: "paid",
      help: "paid, open (still owed) or void.",
    },
    {
      key: "currency",
      kind: "currency",
      required: true,
      aliases: ["currency_code"],
      example: "USD",
      help: "",
    },
    {
      key: "date",
      kind: "date",
      required: true,
      aliases: ["invoice_date", "issued_at", "created_at", "created"],
      example: "2026-10-15",
      help: "The date of the invoice.",
    },
    { key: "due_date", kind: "date", aliases: ["due_at", "due"], example: "2026-10-15", help: "" },
    {
      key: "paid_at",
      kind: "date",
      aliases: ["paid_on", "paid_date"],
      example: "2026-10-15",
      help: "For a paid invoice: when it was paid.",
    },
    {
      key: "period_start",
      kind: "date",
      aliases: ["service_period_start"],
      example: "2026-10-15",
      help: "",
    },
    {
      key: "period_end",
      kind: "date",
      aliases: ["service_period_end"],
      example: "2026-11-15",
      help: "",
    },
    {
      key: "total",
      kind: "money",
      required: true,
      aliases: ["amount", "invoice_total", "total_amount"],
      example: "49.00",
      help: "The invoice total: the lines, less the discount, plus the tax.",
    },
    {
      key: "amount_due",
      kind: "money",
      aliases: ["balance", "amount_remaining", "balance_due"],
      example: "",
      help: "What is still owed. Empty means the total for an open invoice and 0 for the others.",
    },
    {
      key: "tax",
      kind: "money",
      aliases: ["tax_amount", "total_tax"],
      example: "",
      help: "The tax on the invoice. Put it on the first row of the invoice.",
    },
    {
      key: "discount",
      kind: "money",
      aliases: ["discount_amount", "total_discount"],
      example: "",
      help: "A discount on the whole invoice. Put it on the first row of the invoice.",
    },
    {
      key: "line_description",
      kind: "text",
      required: true,
      aliases: ["description", "item_description", "line_item"],
      example: "Pro, monthly",
      help: "What the line bills.",
    },
    {
      key: "line_amount",
      kind: "money",
      required: true,
      aliases: ["line_total", "item_amount"],
      example: "49.00",
      help: "The amount of the line, before discounts.",
    },
    {
      key: "line_quantity",
      kind: "int",
      aliases: ["quantity", "qty"],
      example: "1",
      help: "Empty means 1.",
    },
    {
      key: "line_price_id",
      kind: "id",
      aliases: ["price_id", "item_price_id"],
      example: "pro-monthly-usd",
      help: "The price the line bills, if any.",
    },
  ],
  credit_notes: [
    {
      key: "credit_note_id",
      kind: "id",
      required: true,
      aliases: ["id", "cn_id", "credit_note"],
      example: "cn-0001",
      help: "The credit note's ID in your current system.",
    },
    {
      key: "invoice_id",
      kind: "id",
      required: true,
      aliases: ["invoice", "reference_invoice_id"],
      example: "inv-0001",
      help: "The invoice it credits, from your invoices file or from an earlier import.",
    },
    {
      key: "customer_id",
      kind: "id",
      aliases: ["customer", "cust_id"],
      example: "cust-0001",
      help: "Empty means the customer of the invoice.",
    },
    {
      key: "type",
      kind: "enum",
      aliases: ["credit_note_type"],
      values: { refundable: "refundable", adjustment: "adjustment" },
      example: "refundable",
      help: "refundable (the customer can use or get back the credit) or adjustment. Empty means refundable.",
    },
    {
      key: "currency",
      kind: "currency",
      required: true,
      aliases: ["currency_code"],
      example: "USD",
      help: "",
    },
    {
      key: "date",
      kind: "date",
      required: true,
      aliases: ["created_at", "issued_at", "credit_note_date"],
      example: "2026-10-20",
      help: "",
    },
    {
      key: "total",
      kind: "money",
      required: true,
      aliases: ["amount", "total_amount"],
      example: "10.00",
      help: "",
    },
    {
      key: "amount_allocated",
      kind: "money",
      aliases: ["allocated", "amount_applied"],
      example: "",
      help: "The part applied to the invoice.",
    },
    {
      key: "amount_refunded",
      kind: "money",
      aliases: ["refunded"],
      example: "",
      help: "The part paid back to the customer.",
    },
    {
      key: "amount_available",
      kind: "money",
      aliases: ["available", "remaining", "balance"],
      example: "10.00",
      help: "The part the customer can still use. It becomes credit on the customer.",
    },
    { key: "reason", kind: "text", aliases: ["reason_code", "description"], example: "", help: "" },
    {
      key: "voided_at",
      kind: "date",
      aliases: ["void_date"],
      example: "",
      help: "For a voided credit note: when it was voided.",
    },
  ],
  payments: [
    {
      key: "transaction_id",
      kind: "id",
      required: true,
      aliases: ["id", "payment_id", "txn_id"],
      example: "pay-0001",
      help: "The payment's or refund's ID in your current system.",
    },
    {
      key: "type",
      kind: "enum",
      aliases: ["transaction_type"],
      values: { payment: "payment", charge: "payment", refund: "refund" },
      example: "payment",
      help: "payment or refund. Empty means payment.",
    },
    {
      key: "customer_id",
      kind: "id",
      required: true,
      aliases: ["customer", "cust_id"],
      example: "cust-0001",
      help: "",
    },
    {
      key: "invoice_id",
      kind: "id",
      aliases: ["invoice"],
      example: "inv-0001",
      help: "The invoice the payment paid, from your invoices file or from an earlier import.",
    },
    {
      key: "amount",
      kind: "money",
      required: true,
      aliases: ["amount_paid", "total"],
      example: "49.00",
      help: "",
    },
    {
      key: "currency",
      kind: "currency",
      required: true,
      aliases: ["currency_code"],
      example: "USD",
      help: "",
    },
    {
      key: "date",
      kind: "date",
      required: true,
      aliases: ["paid_at", "created_at", "created"],
      example: "2026-10-15",
      help: "",
    },
    {
      key: "status",
      kind: "enum",
      aliases: ["transaction_status", "state"],
      values: {
        succeeded: "succeeded",
        success: "succeeded",
        paid: "succeeded",
        failed: "failed",
        declined: "failed",
      },
      example: "succeeded",
      help: "succeeded or failed. Empty means succeeded.",
    },
    {
      key: "payment_gateway",
      kind: "enum",
      aliases: ["gateway", "payment_provider"],
      values: Object.fromEntries(GATEWAY_KEYS.map((k) => [k, k])),
      example: "stripe",
      help: "The gateway that took the payment. Empty for an offline payment.",
    },
    {
      key: "gateway_transaction_id",
      kind: "text",
      aliases: ["provider_transaction_id", "charge_id", "id_at_gateway"],
      example: "",
      help: "The payment's ID at the gateway. With the gateway, refunds of it work here.",
    },
    {
      key: "refunded_transaction_id",
      kind: "id",
      aliases: ["refunded_payment_id", "original_transaction_id"],
      example: "",
      help: "For a refund: the payment it gives back, from this file.",
    },
    {
      key: "failure_reason",
      kind: "text",
      aliases: ["error", "error_message", "decline_reason"],
      example: "",
      help: "",
    },
  ],
  usage: [
    {
      key: "usage_id",
      kind: "id",
      required: true,
      aliases: ["id", "usage_record_id", "event_id"],
      example: "use-0001",
      help: "The usage record's ID in your current system.",
    },
    {
      key: "subscription_id",
      kind: "id",
      required: true,
      aliases: ["subscription", "sub_id"],
      example: "sub-0001",
      help: "From your subscriptions file or from subscriptions that are here already.",
    },
    {
      key: "price_id",
      kind: "id",
      required: true,
      aliases: ["item_price_id", "metered_price_id"],
      example: "api-calls-usd",
      help: "A usage price that is here already and is on the subscription.",
    },
    {
      key: "quantity",
      kind: "int",
      required: true,
      aliases: ["qty", "units"],
      example: "120",
      help: "",
    },
    {
      key: "timestamp",
      kind: "date",
      required: true,
      aliases: ["recorded_at", "date", "usage_date", "occurred_at"],
      example: "2026-11-20T10:00:00Z",
      help: "When the usage happened.",
    },
  ],
};

/** Lower case, punctuation and spaces to `_`, no `_` at the ends; a trailing `_utc` dropped. */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_utc$/, "");
}

const SINGULAR: Record<ImportEntity, string> = {
  plans: "plan",
  addons: "addon",
  coupons: "coupon",
  customers: "customer",
  subscriptions: "subscription",
  invoices: "invoice",
  credit_notes: "credit_note",
  payments: "payment",
  usage: "usage",
};

export type ColumnMapping = Record<string, string | null>;

/**
 * Header → field key, for every header. A header matches a field's key or one of its
 * aliases; an entity prefix (`customers.email`, `subscription_status`) is tried both kept
 * and dropped. Each field takes the first header that matches it; the rest map to null.
 */
export function autoMap(entity: ImportEntity, headers: string[]): ColumnMapping {
  const byName = new Map<string, string>();
  for (const f of ENTITY_FIELDS[entity]) {
    byName.set(normalizeHeader(f.key), f.key);
    for (const a of f.aliases ?? []) {
      const n = normalizeHeader(a);
      if (!byName.has(n)) byName.set(n, f.key);
    }
  }
  const prefixes = [`${entity}_`, `${SINGULAR[entity]}_`];
  const taken = new Set<string>();
  const out: ColumnMapping = {};
  for (const h of headers) {
    const n = normalizeHeader(h);
    let key = byName.get(n);
    if (!key)
      for (const p of prefixes)
        if (n.startsWith(p) && byName.has(n.slice(p.length))) {
          key = byName.get(n.slice(p.length));
          break;
        }
    if (key && !taken.has(key)) {
      taken.add(key);
      out[h] = key;
    } else out[h] = null;
  }
  return out;
}

/** Required fields with no column mapped to them. */
export function missingRequired(entity: ImportEntity, mapping: ColumnMapping): string[] {
  const mapped = new Set(Object.values(mapping).filter(Boolean));
  return ENTITY_FIELDS[entity].filter((f) => f.required && !mapped.has(f.key)).map((f) => f.key);
}

/** A template file: the header line and one example row. */
export function templateCsv(entity: ImportEntity): string {
  const fields = ENTITY_FIELDS[entity];
  return `${csvRow(fields.map((f) => f.key))}\r\n${csvRow(fields.map((f) => f.example))}\r\n`;
}
