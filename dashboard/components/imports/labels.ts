import type { ImportEntity, ImportStatus } from "@/lib/api/imports";

export const ENTITY_LABEL: Record<ImportEntity, string> = {
  plans: "Plans and prices",
  addons: "Add-ons",
  coupons: "Coupons",
  customers: "Customers",
  subscriptions: "Subscriptions",
  invoices: "Invoices",
  credit_notes: "Credit notes",
  payments: "Payments and refunds",
  usage: "Usage",
};

export const ENTITY_HELP: Record<ImportEntity, string> = {
  plans: "Plans and their flat, per-unit and tiered prices.",
  addons: "Add-ons and one-time charges.",
  coupons: "Coupons and their codes.",
  customers: "Contacts, addresses, tax IDs and saved card references.",
  subscriptions: "Items, coupons, trials and the current term. One row for each item.",
  invoices: "Paid, open and void invoices. One row for each line.",
  credit_notes: "Credit notes and the credit the customer can still use.",
  payments: "Payments and refunds, with the invoice they paid.",
  usage: "Usage of a usage price that is on a subscription.",
};

/** One record of each file, for counts: "2 plans". */
export const ENTITY_NOUN: Record<ImportEntity, [string, string]> = {
  plans: ["price", "prices"],
  addons: ["add-on price", "add-on prices"],
  coupons: ["coupon", "coupons"],
  customers: ["customer", "customers"],
  subscriptions: ["subscription row", "subscription rows"],
  invoices: ["invoice line", "invoice lines"],
  credit_notes: ["credit note", "credit notes"],
  payments: ["payment or refund", "payments and refunds"],
  usage: ["usage record", "usage records"],
};

/** The field each column can be imported as. */
export const FIELD_LABEL: Record<string, string> = {
  price_id: "Price ID",
  plan_id: "Plan ID",
  addon_id: "Add-on ID",
  name: "Name",
  description: "Description",
  amount: "Amount",
  currency: "Currency",
  interval: "Billing period",
  interval_count: "Billing period count",
  pricing_model: "Pricing model",
  tiers: "Tiers",
  trial_days: "Trial days",
  status: "Status",
  created_at: "Created",
  coupon_id: "Coupon code",
  discount_type: "Discount type",
  percent_off: "Percent off",
  amount_off: "Amount off",
  duration: "Duration",
  duration_periods: "Duration in periods",
  max_redemptions: "Maximum redemptions",
  redeem_by: "Redeem by",
  customer_id: "Customer ID",
  email: "Email",
  first_name: "First name",
  last_name: "Last name",
  company: "Company",
  phone: "Phone",
  auto_collection: "Auto collection",
  net_term_days: "Net term days",
  tax_id: "Tax ID",
  address_line1: "Address line 1",
  address_line2: "Address line 2",
  city: "City",
  state: "State",
  postal_code: "Postal code",
  country: "Country",
  payment_gateway: "Card: payment gateway",
  gateway_customer_id: "Card: gateway customer ID",
  gateway_payment_method_id: "Card: gateway payment method ID",
  card_brand: "Card: brand",
  card_last4: "Card: last 4 digits",
  card_exp_month: "Card: expiry month",
  card_exp_year: "Card: expiry year",
  subscription_id: "Subscription ID",
  quantity: "Quantity",
  unit_price: "Unit price",
  coupon_ids: "Coupon codes",
  current_term_start: "Current term start",
  current_term_end: "Current term end",
  trial_end: "Trial end",
  start_date: "Start date",
  cancelled_at: "Cancelled at",
  po_number: "PO number",
  invoice_id: "Invoice ID",
  number: "Invoice number",
  date: "Date",
  due_date: "Due date",
  paid_at: "Paid at",
  period_start: "Period start",
  period_end: "Period end",
  total: "Total",
  amount_due: "Amount due",
  tax: "Tax",
  discount: "Discount",
  line_description: "Line: description",
  line_amount: "Line: amount",
  line_quantity: "Line: quantity",
  line_price_id: "Line: price ID",
  credit_note_id: "Credit note ID",
  type: "Type",
  amount_allocated: "Amount allocated",
  amount_refunded: "Amount refunded",
  amount_available: "Amount available",
  reason: "Reason",
  voided_at: "Voided at",
  transaction_id: "Transaction ID",
  gateway_transaction_id: "Gateway transaction ID",
  refunded_transaction_id: "Refunded transaction ID",
  failure_reason: "Failure reason",
  usage_id: "Usage ID",
  timestamp: "Time",
};

export const fieldLabel = (key: string) =>
  FIELD_LABEL[key] ??
  key
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bid\b/gi, "ID");

/** What no file import carries, as the review lists it. */
export const NOT_IMPORTED_LABEL: Record<string, string> = {
  tax_rates: "Tax rates",
  gateway_credentials: "Payment gateway credentials",
  dunning_rules: "Dunning rules",
  invoice_numbering: "Invoice numbering",
  email_templates: "Email templates",
};

export const RUN_STATUS: Record<
  ImportStatus,
  { label: string; tone: "green" | "tan" | "red" | "gray" | "blue" }
> = {
  uploaded: { label: "Not checked", tone: "gray" },
  checking: { label: "Checking", tone: "blue" },
  checked: { label: "Not started", tone: "gray" },
  queued: { label: "Waiting", tone: "blue" },
  running: { label: "Importing", tone: "blue" },
  succeeded: { label: "Imported", tone: "green" },
  partially_failed: { label: "Partly imported", tone: "tan" },
  failed: { label: "Failed", tone: "red" },
  undoing: { label: "Undoing", tone: "blue" },
  undone: { label: "Undone", tone: "gray" },
  discarded: { label: "Discarded", tone: "gray" },
};

export const ACTIVE: ImportStatus[] = ["checking", "queued", "running", "undoing"];
export const FINISHED: ImportStatus[] = ["succeeded", "partially_failed", "failed"];

export const fmt = (n: number) => n.toLocaleString("en-US");
