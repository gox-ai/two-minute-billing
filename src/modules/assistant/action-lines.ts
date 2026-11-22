/**
 * What the member reads on a confirm card: each field of the stored request in the words and
 * formats of the dashboard screen that makes the same change. Display only: the request that
 * runs is never touched here.
 *
 * Labels and option labels are copied from the dashboard's own forms (`dashboard/components/**`,
 * `dashboard/lib/billing-rules.ts`, `credits.ts`, `usage-controls.ts`); keep them in step when a
 * form's wording changes. `plain: true` marks a field the dashboard has no control for.
 */
import type { RouteResult } from "@/modules/assistant-tools/route-call";

type Body = Record<string, unknown>;
type Get = (rel: string) => Promise<RouteResult>;

export interface Line {
  label: string;
  value: string;
  /** An update: the record's value now. Unset when the record does not show it. */
  before?: string;
  /** The body key this line shows, when the member may change it on the card. */
  key?: string;
  /** The control that changes it. Set together with `key`. */
  input?: LineInput;
}

export type LineInputKind =
  | "text"
  | "number"
  | "amount"
  | "date"
  | "datetime"
  | "select"
  | "boolean";

/** How the card edits one field. The engine converts what the member types back to the body's form. */
export interface LineInput {
  kind: LineInputKind;
  /** `select` (and the two sides of a `boolean`): each API value with its label. */
  options?: Array<{ value: string; label: string }>;
  /** `minor`: typed in major units, sent in minor units. `bps`: typed as a percent, sent in basis points. */
  unit?: "minor" | "bps";
  /** `amount`: the currency of the figure. */
  currency?: string;
  /**
   * The value as the member types it: a major-unit amount, a percent, `YYYY-MM-DD`, a local
   * `YYYY-MM-DDTHH:mm` in the business's zone, an option value, or a boolean.
   */
  value: string | boolean;
}

export interface LineContext {
  currency: string;
  /** The business's IANA zone: dates read as the dashboard shows them. */
  timezone?: string | null;
  /** `METHOD path` of the operation, for per-operation wording. */
  operation?: string;
  /** Record id → its name, from `lookupNames`. */
  names?: ReadonlyMap<string, string>;
  /** Credit unit id → how its amounts read. */
  units?: ReadonlyMap<string, { name: string; decimals: number }>;
}

const MAX_LINES = 30;

// ── general formatters ─────────────────────────────────────────────────────────

/** Initialisms that must not read as words ("PO number", not "Po number"). */
const ACRONYMS = new Set(["po", "id", "url", "vat", "gst", "mrr"]);
export const words = (k: string) =>
  k
    .replace(/_minor$/, "")
    .split("_")
    .map((w, i) =>
      ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w,
    )
    .join(" ");

const ZERO_DECIMAL = ["JPY", "KRW", "VND", "CLP", "ISK"];
export function money(minor: number, currency: string): string {
  const digits = ZERO_DECIMAL.includes(currency.toUpperCase()) ? 0 : 2;
  const v = minor / 10 ** digits;
  try {
    return v.toLocaleString("en-US", { style: "currency", currency: currency.toUpperCase() });
  } catch {
    return `${v.toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `21-Aug-2026` in the business's zone, the dashboard's date format, with ` 14:30` when the
 * time is not midnight. Takes unix seconds, milliseconds or ISO; null when `v` is no date.
 */
export function dateText(v: unknown, tz?: string | null): string | null {
  let d: Date | null = null;
  if (typeof v === "number" || (typeof v === "string" && /^\d{9,13}$/.test(v))) {
    const n = Number(v);
    if (n < 1e8) return null;
    d = new Date(n < 1e11 ? n * 1000 : n);
  } else if (typeof v === "string") {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (day) return `${day[3]}-${MONTHS[Number(day[2]) - 1]}-${day[1]}`;
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) d = new Date(v);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).formatToParts(d!);
  let parts;
  try {
    parts = fmt(tz || "UTC");
  } catch {
    parts = fmt("UTC");
  }
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  const date = `${p.day}-${MONTHS[Number(p.month) - 1]}-${p.year}`;
  return p.hour === "00" && p.minute === "00" ? date : `${date} ${p.hour}:${p.minute}`;
}

/** Keys that hold an instant. `billing_date` is a day of the month and has its own entry. */
const DATE_KEY =
  /(^|_)(at|date|until|end|from|by|timestamp|start)$|^(trial_end|term_ends_at|billing_anchor)$/;

const percentFromBps = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isObj = (v: unknown): v is Body => !!v && typeof v === "object" && !Array.isArray(v);

const nameOf = (id: unknown, c: LineContext) =>
  typeof id === "string" ? (c.names?.get(id) ?? id) : String(id ?? "—");

const ADDRESS_PARTS = [
  "line1",
  "line2",
  "line3",
  "city",
  "state",
  "state_code",
  "postal_code",
  "country",
];
/** An address as one line, the way the dashboard lists one. */
function addressText(a: Body): string {
  const who = [str(a.first_name), str(a.last_name)].filter(Boolean).join(" ");
  const state = str(a.state) ?? str(a.state_code);
  return (
    [
      who,
      str(a.company),
      str(a.email),
      str(a.phone),
      str(a.line1),
      str(a.line2),
      str(a.line3),
      str(a.city),
      state,
      str(a.postal_code),
      str(a.country),
    ]
      .filter(Boolean)
      .join(", ") || "—"
  );
}

/** Free key-value data (metadata, custom fields, a rate's match) as `key: value, …`. */
function kvText(o: Body, c: LineContext): string {
  // Values someone typed stay as typed; dates, money and ids still read cleanly.
  const parts = Object.entries(o).map(
    ([k, v]) =>
      `${k}: ${typeof v === "string" && !c.names?.has(v) && !DATE_KEY.test(k) ? v : plainValue(k, v, c)}`,
  );
  return parts.length ? parts.join(", ") : "—";
}

/** A value with no field entry: dates, money, ids and enums still read cleanly. */
function plainValue(key: string, v: unknown, c: LineContext): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number" && key.endsWith("_minor")) return money(v, c.currency);
  if (typeof v === "number" && key.endsWith("_bps")) return percentFromBps(v);
  if (DATE_KEY.test(key)) {
    const d = dateText(v, c.timezone);
    if (d) return d;
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" && c.names?.has(v)) return c.names.get(v)!;
  // An API value such as "end_of_term" reads as words; ids and free text stay as sent.
  if (typeof v === "string" && /^[a-z]+(_[a-z]+)*$/.test(v))
    return v.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());
  if (typeof v === "string" || typeof v === "number") return String(v).slice(0, 200);
  if (Array.isArray(v))
    return v.length
      ? v.some(isObj)
        ? v.map((x) => (isObj(x) ? kvText(x, c) : plainValue(key, x, c))).join("; ")
        : v.map((x) => plainValue(key, x, c)).join(", ")
      : "None";
  if (isObj(v)) return kvText(v, c);
  return String(v);
}

// ── field wording ──────────────────────────────────────────────────────────────

interface FieldText {
  label: string;
  /** Option labels for an enum, or for a switch under "true" / "false". */
  options?: Record<string, string>;
  /** What null means for this field. */
  none?: string;
  /** The whole value; lines for a value that reads as several rows. */
  format?: (v: unknown, c: LineContext, body: Body) => string | Line[] | null;
  /** No dashboard control: a plain label. */
  plain?: true;
  /** Internal to the request (a price lock, a token): never on the card. */
  hidden?: true;
}

const listText = (v: unknown) =>
  Array.isArray(v) ? (v.length ? v.map(String).join(", ") : "None") : null;

const onOff = (on: string, off: string) => ({ true: on, false: off });

// Option sets shared by several fields, from the dashboard's forms.
const OFFLINE_METHOD = {
  cash: "Cash",
  check: "Check",
  cheque: "Check",
  bank_transfer: "Bank transfer",
  other: "Other",
};
const CHANGE_INVOICING = onOff("Invoice immediately", "Add to unbilled charges");
const DISCOUNT_DURATION = { one_time: "Next invoice only", forever: "Forever (until removed)" };
const FAILED_CHANGE = {
  start_dunning: "Start dunning",
  next_renewal: "Retry at the next renewal",
  revert: "Undo the change",
  apply_when_paid: "Apply when paid",
};
const POLICY = { block: "Block usage", bill: "Bill usage" };
const TAX_TREATMENT = { taxed_at_purchase: "Taxed at purchase", taxed_at_use: "Taxed at use" };
const INTERVAL = {
  day: "Day",
  week: "Week (Monday to Sunday)",
  month: "Calendar month",
  period: "Billing period",
};
const CANCEL_WHEN = {
  immediately: "Cancel immediately",
  end_of_term: "Cancel at end of current term",
  specific_date: "Cancel on a specific date",
  end_of_billing_term: "Cancel at end of subscription billing term",
};
const CANCEL_REASONS: Record<string, string> = {
  pricing_high: "Pricing was high",
  pausing_will_return: "Pausing, will come back",
  complicated_to_use: "Complicated to use",
  product_has_issues: "Product has issues",
  product_unsatisfactory: "Product was unsatisfactory",
  trying_out: "Was just trying out",
  other: "Other",
};
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * A per-subscription credit cap is "Follow the business setting" (null), "Never auto-apply
 * here" (0) or a limit, never "0.00".
 */
const creditCap = (v: unknown, c: LineContext) =>
  v === null || v === undefined
    ? "Follow the business setting"
    : v === 0
      ? "Never auto-apply here"
      : typeof v === "number"
        ? `Auto-apply up to ${money(v, c.currency)} per invoice`
        : String(v);

const PERIOD_ONE: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};
/** A coupon's billing periods as a scope: ", yearly only", ", monthly or every 3 months only". */
function periodsOnly(v: unknown): string {
  if (!Array.isArray(v) || !v.length) return "";
  const each = v.filter(isObj).map((p) => {
    const n = num(p.interval_count) ?? 1;
    const unit = String(p.interval ?? "");
    return n === 1 ? (PERIOD_ONE[unit] ?? unit) : `every ${n} ${unit}s`;
  });
  return each.length ? `, ${each.join(" or ")} only` : "";
}

/** A manual discount: "10% off, next invoice only". */
function discountText(v: unknown, c: LineContext): string | null {
  if (!isObj(v)) return null;
  const value = num(v.value);
  const off =
    value === null
      ? "—"
      : v.type === "amount"
        ? `${money(value, c.currency)} off`
        : `${value}% off`;
  const duration = DISCOUNT_DURATION[String(v.duration) as keyof typeof DISCOUNT_DURATION] ?? null;
  return [off, duration?.toLowerCase(), str(v.note)].filter(Boolean).join(", ");
}

/** A price with its quantity: "Pro Monthly × 2 at ₹500.00 each (optional, quantity 1 to 5)". */
function priceQty(e: Body, c: LineContext): string {
  const qty = num(e.quantity) ?? 1;
  const unit = num(e.unit_price_minor);
  const extra = [
    e.optional === true ? "optional" : null,
    num(e.min_quantity) !== null || num(e.max_quantity) !== null
      ? `quantity ${e.min_quantity ?? 1} to ${e.max_quantity ?? "any"}`
      : null,
    num(e.free_quantity) ? `${e.free_quantity} free` : null,
    num(e.billing_cycles) ? `for ${e.billing_cycles} billing cycles` : null,
  ].filter(Boolean);
  return `${nameOf(e.price, c)} × ${qty}${unit !== null ? ` at ${money(unit, c.currency)} each` : ""}${
    extra.length ? ` (${extra.join(", ")})` : ""
  }`;
}

/** One row per element of an array of objects. */
const rows =
  (label: string, each: (e: Body, c: LineContext) => string) =>
  (v: unknown, c: LineContext): Line[] | null =>
    Array.isArray(v)
      ? v.length
        ? v.map((e) => ({ label, value: isObj(e) ? each(e, c) : nameOf(e, c) }))
        : [{ label, value: "None" }]
      : null;

/** A list of record ids, by name. */
const namesList = (v: unknown, c: LineContext) =>
  Array.isArray(v) ? (v.length ? v.map((id) => nameOf(id, c)).join(", ") : "None") : null;

const itemChange = (e: Body, c: LineContext) => {
  const to = e.price ? ` → ${nameOf(e.price, c)}` : "";
  const qty = num(e.quantity) !== null ? ` × ${e.quantity}` : "";
  const unit = num(e.unit_price_minor);
  return `${nameOf(e.item, c)}${to}${qty}${unit !== null ? ` at ${money(unit, c.currency)} each` : ""}`;
};

const ITEMS = rows("Item", priceQty);
const CHANGE_FIELDS: Record<string, FieldText> = {
  changes: { label: "Change item", format: rows("Change item", itemChange) },
  adds: { label: "Add item", format: rows("Add item", priceQty) },
  removes: { label: "Remove item", format: rows("Remove item", (e, c) => nameOf(e.item, c)) },
};

/** Wording for each request field, by key. Nested fields use `parent.child`. */
const FIELDS: Record<string, FieldText> = {
  // people and contact
  email: { label: "Email" },
  first_name: { label: "First name" },
  last_name: { label: "Last name" },
  name: { label: "Name" },
  company: { label: "Company" },
  phone: { label: "Phone" },
  label: { label: "Label" },
  to: { label: "To" },
  note: { label: "Note" },
  comment: { label: "Comment" },
  reason: { label: "Reason" },
  description: { label: "Description" },
  reference: { label: "Reference number" },
  currency: { label: "Currency" },
  metadata: { label: "Metadata", format: (v, c) => (isObj(v) ? kvText(v, c) : null) },
  custom_fields: { label: "Custom fields", format: (v, c) => (isObj(v) ? kvText(v, c) : null) },
  address: { label: "Billing address", format: (v) => (isObj(v) ? addressText(v) : null) },
  billing_address: { label: "Billing address", format: (v) => (isObj(v) ? addressText(v) : null) },
  shipping_address: {
    label: "Shipping address",
    format: (v) => (isObj(v) ? addressText(v) : null),
  },
  line1: { label: "Address line 1" },
  line2: { label: "Address line 2" },
  line3: { label: "Address line 3" },
  city: { label: "City" },
  state: { label: "State" },
  state_code: { label: "State code", plain: true },
  postal_code: { label: "Zip / postal code" },
  country: { label: "Country" },

  // customers
  tax_exempt: { label: "Tax", options: onOff("Tax exempt", "Not tax exempt") },
  email_notifications: { label: "Email notifications", options: onOff("On", "Off") },
  dunning_excluded: {
    label: "Dunning",
    options: onOff("Exclude from dunning", "Include in dunning"),
  },
  exclude_from_reporting: {
    label: "Reports",
    options: onOff("Exclude from reports", "Include in reports"),
  },
  billing_cc_emails: { label: "CC on invoices and receipts", format: (v) => listText(v) },
  billing_bcc_emails: { label: "BCC on invoices and receipts", format: (v) => listText(v) },
  tax_behavior: {
    label: "Price type",
    options: {
      inclusive: "Tax inclusive for all prices",
      exclusive: "Tax exclusive for all prices",
    },
    none: "Use the price type of each price",
  },
  dunning_policy: { label: "Dunning policy", none: "Business settings" },
  new_method_gateway_account: {
    label: "Gateway for new payment methods",
    none: "Same as business setting",
  },
  vat_number: { label: "VAT / GST number" },
  withholding_rate_bps: { label: "Withholding / TDS rate" },
  active: { label: "Status", options: onOff("Active", "Archived"), plain: true },
  credit_settings: { label: "Credit settings", none: "Business settings" },
  "credit_settings.on_exhausted": {
    label: "When credit is used up",
    options: POLICY,
    none: "No override",
  },
  "credit_settings.override_expires_at": { label: "Override ends on" },
  "credit_settings.overdraft_limit_minor": {
    label: "Overdraft limit",
    plain: true,
    format: (v) =>
      isObj(v)
        ? Object.entries(v)
            .map(([cur, m]) => (typeof m === "number" ? money(m, cur) : `${cur}: —`))
            .join(", ") || "None"
        : null,
  },

  // contacts
  enabled: { label: "Status", options: onOff("Enabled", "Disabled"), plain: true },
  send_account_email: {
    label: "Account emails",
    options: onOff("Send to this contact", "Do not send"),
    plain: true,
  },
  send_billing_email: {
    label: "Billing emails",
    options: onOff("Send to this contact", "Do not send"),
    plain: true,
  },
  is_default: {
    label: "Default",
    options: onOff("Make this the default shipping address", "Not the default"),
  },

  // comments
  resource_type: {
    label: "Record type",
    options: {
      invoice: "Invoice",
      credit_note: "Credit note",
      customer: "Customer",
      subscription: "Subscription",
      product: "Product",
      price: "Price",
      coupon: "Coupon",
      coupon_set: "Coupon set",
      product_group: "Product group",
    },
  },
  resource_id: { label: "Record" },
  body: { label: "Comment" },

  // payment links and portal links
  items: { label: "Item", format: ITEMS },
  show_on_pricing_page: {
    label: "Pricing page",
    options: onOff("Show on your pricing page", "Do not show on your pricing page"),
  },
  redirect_url: { label: "Page after payment", plain: true },
  cancel_url: { label: "Page after cancel", plain: true },
  return_url: { label: "Page after payment", plain: true },
  link_kind: { label: "Link opens for", options: { api: "1 hour", email: "5 days" }, plain: true },
  forward_url: {
    label: "Opens on",
    plain: true,
    options: {
      "/portal": "Portal home",
      "/portal?tab=invoices": "Invoices",
      "/portal?tab=plan": "Plan",
      "/portal?tab=methods": "Payment methods",
      "/portal?tab=details": "Account details",
    },
  },
  object: { label: "Record", plain: true },

  // emails and payment requests
  type: {
    label: "Email",
    options: {
      invoice_sent: "Invoice",
      payment_request: "Payment request",
      payment_method_request: "Payment method request",
      credit_note_sent: "Credit note",
      subscription_restart: "Restart link",
    },
  },
  customer: { label: "Customer" },
  invoice: { label: "Invoice" },
  credit_note: { label: "Credit note" },
  subscription: { label: "Subscription" },
  restart_price: {
    label: "Price of the new term",
    options: { current: "Current price of the plan", keep: "Price the subscription had" },
  },
  invoices: { label: "Invoices", format: namesList },
  invoice_ids: { label: "Invoices", format: namesList },
  mode: { label: "Collect by", options: { charge: "Charge now", link: "Send a payment link" } },
  payment_method: { label: "Payment method" },
  payment_method_id: { label: "Payment method" },

  // invoices
  po_number: { label: "PO number" },
  expected_payment_date: { label: "Expected payment date" },
  until: { label: "Pause retries until" },
  net_days: { label: "Net days" },
  lines: {
    label: "Line item",
    format: rows("Line item", (e, c) => {
      const qty = num(e.quantity) ?? 1;
      const amount = num(e.amount_minor);
      const each = amount === null ? "—" : money(amount, c.currency);
      return `${str(e.description) ?? "—"}${qty === 1 ? `: ${each}` : ` × ${qty} at ${each} each`}`;
    }),
  },
  collect: { label: "Collection", options: onOff("Collect now", "Do not collect now") },
  apply_tax: { label: "Tax", options: onOff("Apply tax", "Do not apply tax") },

  // subscriptions
  auto_collection: {
    label: "Auto-collection",
    options: { on: "On: charge the card automatically", off: "Off: send the invoice" },
  },
  shipping_address_id: { label: "Ship to", none: "The customer's default shipping address" },
  invoice_notes: { label: "Invoice notes" },
  net_term_days: { label: "Net term days" },
  remaining_billing_cycles: {
    label: "Renewals remaining after the current term",
    none: "Renews forever",
  },
  billing_cycles: { label: "Renewals remaining after the current term", none: "Renews forever" },
  renewal_at: { label: "Renewal" },
  id: { label: "ID" },
  trial_days: {
    label: "Trial days",
    format: (v) => (v === 0 ? "No trial" : null),
  },
  trial_end: { label: "Trial end" },
  start_date: { label: "Start date" },
  billing_anchor: { label: "First term ends on", plain: true },
  coupon_ids: { label: "Coupons", format: namesList },
  coupon_code: { label: "Coupon code" },
  code: { label: "Coupon code" },
  discount: { label: "Manual discount", format: discountText },
  manual_discount: { label: "Manual discount", format: discountText },
  invoice_immediately: { label: "Invoicing", options: CHANGE_INVOICING },
  create_pending_invoices: {
    label: "Renewal invoicing",
    options: onOff("Keep a pending invoice", "Post an invoice on each renewal"),
  },
  bill_usage_monthly: {
    label: "Usage",
    options: onOff("Bill usage every month", "Do not bill usage every month"),
  },
  commitment_amount_minor: {
    label: "Minimum commitment per billing period",
    none: "No minimum commitment",
  },
  payment_intent: { label: "Payment intent", plain: true },
  client_result: {
    label: "Authentication result",
    plain: true,
    format: (v, c) => (isObj(v) ? kvText(v, c) : null),
  },
  on_session: {
    label: "Payment session",
    options: onOff("The customer is present", "The customer is not present"),
    plain: true,
  },
  ...CHANGE_FIELDS,
  remove_discount: {
    label: "Discount",
    options: onOff("Remove the discount", "Keep the discount"),
  },
  at: { label: "Apply at" },
  reset_term: {
    label: "Billing term",
    options: onOff("Start a new term today", "Keep the current term"),
  },
  prorate: {
    label: "Proration",
    options: onOff("Apply prorated credits and charges", "Do not prorate"),
  },
  timing: {
    label: "Apply the changes",
    options: { now: "Immediately", end_of_term: "On next renewal" },
  },
  on_charge_failure: { label: "If the payment fails", options: FAILED_CHANGE },
  coupons: {
    label: "Coupons on the new plan",
    options: {
      keep: "Keep the coupons",
      drop: "Remove the coupons",
      keep_if_valid: "Keep only coupons that apply to the new plan",
    },
  },
  downgrade_credit: {
    label: "Credit from this change",
    options: { credit_balance: "Keep as account credit", refund: "Refund to the payment method" },
  },
  net_credit_documents: {
    label: "Documents for the credit",
    options: {
      credit_note_and_invoice: "Credit note and invoice",
      one_credit_note: "One credit note",
    },
  },
  plan_credits: {
    label: "Plan credits",
    options: {
      full: "At once, in full",
      prorated: "At once, prorated",
      next_window: "From the next window",
    },
  },
  allowances: {
    label: "Usage allowances",
    options: {
      new_window: "Start a new window",
      keep_used: "Keep the used count",
      prorated: "Prorate the rest of the allowance",
    },
  },
  priced_at: { label: "Prices as of", plain: true },
  // The preview's price lock: it keeps the confirmed price equal to the preview's.
  quote: { label: "Quote", hidden: true },
  price: { label: "Item" },
  quantity: { label: "Quantity" },
  unit_price_minor: { label: "Unit price" },
  cancel_option: { label: "Cancellation", options: CANCEL_WHEN },
  at_period_end: {
    label: "Cancellation",
    options: onOff(CANCEL_WHEN.end_of_term, CANCEL_WHEN.immediately),
  },
  include_cancellation_day_in_billing: {
    label: "Cancellation day",
    options: onOff("Bill the cancellation day", "Credit the cancellation day"),
    plain: true,
  },
  cancel_at: { label: "Cancellation date" },
  credit_option_for_current_term_charges: {
    label: "Unused period",
    options: {
      none: "Do not issue credits",
      prorate: "Issue prorated credits",
      full: "Issue full credits",
    },
  },
  unbilled_charges_option: {
    label: "Unbilled charges",
    options: { invoice: "Invoice them now", delete: "Delete them" },
    none: "Leave them pending",
  },
  account_receivables_handling: {
    label: "Open invoices",
    options: {
      no_action: "Leave them as is",
      schedule_payment_collection: "Collect them now",
      void: "Void them",
      write_off: "Write them off",
    },
  },
  refundable_credits_handling: {
    label: "Refundable credits",
    options: { no_action: "Keep credits", schedule_refund: "Initiate refund" },
  },
  cancel_reason_code: { label: "Cancellation reason", options: CANCEL_REASONS },
  cancel_reason: { label: "Cancellation note", plain: true },
  final_period: {
    label: "Last term",
    options: {
      full_period: "Bill the full term",
      prorated: "Bill until the cancellation date",
      nothing: "Bill nothing",
    },
  },
  "plan_credits.on_cancel_at_period_end": {
    label: "Plan credits until the end",
    options: {
      grant_started_window: "Grant until the end",
      stop_at_request: "Stop granting at the cancel request",
    },
  },
  "plan_credits.on_pause": {
    label: "Plan credits while paused",
    options: {
      skip: "Skip windows while paused",
      keep_granting: "Keep granting",
      shift: "Move the windows by the paused time",
    },
  },
  pause_option: {
    label: "Pause",
    options: {
      immediately: "Immediately",
      end_of_term: "At the end of the current term",
      specific_date: "On a specific date",
      billing_cycles: "For a number of billing cycles (auto-resume)",
    },
  },
  pause_date: { label: "Pause on" },
  skip_billing_cycles: { label: "Skip billing cycles" },
  unbilled_charges_handling: {
    label: "Unbilled charges",
    options: {
      no_action: "Leave them as unbilled charges",
      invoice: "Invoice them now",
      delete: "Delete them",
    },
  },
  dunning_handling: {
    label: "Dunning (payment retries)",
    options: { continue: "Continue retries while paused", stop: "Stop retries" },
  },
  resume_date: { label: "Resume on" },
  charges_handling: {
    label: "New term's charge",
    options: {
      invoice_immediately: "Invoice immediately",
      add_to_unbilled_charges: "Add to unbilled charges",
    },
  },
  unpaid_invoices_handling: {
    label: "Unpaid invoices",
    options: { no_action: "No action", schedule_payment_collection: "Attempt collection" },
  },
  resume_option: {
    label: "Resume",
    options: { immediately: "Immediately", specific_date: "On a specific date" },
    plain: true,
  },
  term: {
    label: "Term",
    options: { continue: "Continue the current term", new: "Start a new term today" },
  },
  reactivate_from: { label: "Reactivate from", plain: true },
  payment_initiator: {
    label: "Payment started by",
    options: { customer: "The customer", merchant: "The business" },
    plain: true,
  },
  effective_at: { label: "Takes effect on" },
  immediately: {
    label: "End the trial",
    options: onOff("End trial immediately", "On the new trial end date"),
  },
  term_ends_at: { label: "Term ends at" },
  billing_date: { label: "Day of month", none: "Business default" },
  billing_date_mode: {
    label: "Mode",
    options: { using_defaults: "Using defaults", manually_set: "Manually set" },
  },
  amount_minor: { label: "Amount" },
  invoice_now: { label: "Invoicing", options: CHANGE_INVOICING },

  // credits
  category: { label: "Type of credit", options: { promotional: "Promotional", paid: "Paid" } },
  unit: { label: "Unit", none: "Money" },
  amount: { label: "Amount" },
  priority: { label: "Priority" },
  expires_at: { label: "Expires on", none: "Never" },
  applicability: {
    label: "Applies to",
    plain: true,
    format: (v, c) => {
      if (!isObj(v)) return null;
      if (v.kind === "prices") return `Selected prices: ${namesList(v.prices ?? [], c)}`;
      if (v.kind === "meters") return `Selected meters: ${namesList(v.meters ?? [], c)}`;
      if (v.kind === "metered") return "All metered usage";
      return kvText(v, c);
    },
  },
  on_exhausted: {
    label: "When this credit is used up",
    options: POLICY,
    none: "Not set on this credit",
  },
  price_minor: { label: "Price, before tax" },
  tax_treatment: { label: "Tax", options: TAX_TREATMENT },
  mark_paid: { label: "Mark the invoice as paid" },
  "mark_paid.method": { label: "Payment method" },
  "mark_paid.reference": { label: "Reference" },
  "mark_paid.paid_at": { label: "Paid on" },

  // usage
  item: { label: "Item" },
  unique_key: { label: "Unique key", plain: true },
  operation: { label: "Operation", options: { add: "Add", remove: "Remove" }, plain: true },
  timestamp: { label: "Usage time", plain: true },
  idempotency_key: { label: "Duplicate check key", plain: true },
  markup_percent: {
    label: "Markup",
    format: (v) => (typeof v === "string" || typeof v === "number" ? `${v}%` : null),
  },
  rates: {
    label: "Rate",
    format: rows("Rate", (e, c) => {
      const match = isObj(e.match) ? kvText(e.match, c) : "All";
      const price =
        e.unit_amount_decimal != null
          ? `Fixed rate ${e.unit_amount_decimal}`
          : e.markup_percent != null
            ? `Markup ${e.markup_percent}%`
            : "—";
      return `${match}: ${price}`;
    }),
  },

  // usage controls
  scope: {
    label: "Limit",
    options: {
      customer: "All usage of this customer",
      subscription: "One subscription",
      property: "Each value of a property",
    },
  },
  property_key: { label: "Property" },
  property_value: { label: "Value" },
  meters: { label: "Meters", format: namesList, plain: true },
  interval: { label: "Interval", options: INTERVAL },
  trigger: {
    label: "When",
    options: { threshold: "When the balance falls to an amount", schedule: "On a schedule" },
  },
  threshold_minor: { label: "Balance" },
  threshold_units: { label: "Balance in credits" },
  pack_price: { label: "Credit pack" },
  pack_quantity: { label: "Packs for each top-up" },
  target_units: { label: "Balance in credits after the top-up" },
  purchase_limits: { label: "Purchase limits" },
  "purchase_limits.hour": { label: "Limit for the last hour" },
  "hour.count": { label: "Purchases in the last hour" },
  "hour.amount_minor": { label: "Amount in the last hour" },
  "purchase_limits.day": { label: "Limit for this day" },
  "day.count": { label: "Purchases in this day" },
  "day.amount_minor": { label: "Amount in this day" },
  "purchase_limits.week": { label: "Limit for the last 7 days" },
  "week.count": { label: "Purchases in the last 7 days" },
  "week.amount_minor": { label: "Amount in the last 7 days" },
  "purchase_limits.month": { label: "Limit for this month" },
  "month.count": { label: "Purchases in this month" },
  "month.amount_minor": { label: "Amount in this month" },
  schedule: {
    label: "Repeat",
    format: (v) => {
      if (!isObj(v)) return null;
      if (v.every === "week")
        return `Every week on ${WEEKDAYS[(num(v.weekday) ?? 1) - 1] ?? v.weekday}`;
      if (v.every === "month") return `Every month on day ${v.day ?? "—"}`;
      return null;
    },
  },
  method: {
    label: "How much",
    options: { fixed: "Add a fixed amount", target: "Fill up to a balance" },
  },
  target_minor: { label: "Balance after the top-up" },
  monthly_cap_minor: { label: "Monthly limit" },
  max_runs_per_day: { label: "Top-ups per day" },
  grant: { label: "Credit" },
  "grant.tax_treatment": { label: "Tax on the credit", options: TAX_TREATMENT },
  "grant.priority": { label: "Priority" },
  "grant.expires_after_months": { label: "Credit expires after (months)" },

  // coupons
  kind: { label: "Discount", options: { percentage: "Percentage", fixed_amount: "Fixed amount" } },
  percent_off_bps: { label: "Percentage" },
  amount_off_minor: { label: "Amount" },
  duration_type: {
    label: "Duration",
    options: { once: "Once", forever: "Forever", repeating: "Repeating" },
  },
  duration_in_periods: { label: "Billing periods" },
  max_redemptions: { label: "Maximum redemptions" },
  max_redemptions_per_customer: { label: "Redemptions per customer" },
  per_customer_limit_by: {
    label: "Count redemptions per customer by",
    options: { customer: "Customer", email: "Email" },
  },
  redeem_by: { label: "Valid till" },
  valid_from: { label: "Valid from" },
  invoice_name: { label: "Invoice name" },
  apply_on: {
    label: "Apply on",
    options: { invoice_amount: "Invoice amount", each_specified_item: "Each specified item" },
  },
  item_constraints: {
    label: "Applies to",
    format: (v, c) =>
      Array.isArray(v)
        ? v.filter(isObj).map((e) => {
            const kind =
              { plan: "Plans", addon: "Addons", charge: "Charges" }[String(e.item_kind)] ?? "Items";
            const ids = [
              ...((e.product_ids as unknown[]) ?? []),
              ...((e.price_ids as unknown[]) ?? []),
            ];
            const scope =
              e.constraint_type === "specific"
                ? namesList(ids, c)
                : e.constraint_type === "all"
                  ? "all"
                  : "none";
            return {
              label: "Applies to",
              value: `${kind}: ${scope}${periodsOnly(e.billing_periods)}`,
            };
          })
        : null,
  },

  // money
  on_decline: {
    label: "If the gateway declines the refund",
    options: {
      block: "Keep the money with the business",
      issue_credit: "Give the customer credit",
    },
  },
  confirm_repeat: {
    label: "Repeat refund",
    options: onOff("Send it again (Refund again)", "Stop if it repeats a recent refund"),
  },
  reason_code: { label: "Reason" },
  customer_notes: { label: "Customer notes", plain: true },
  invoice_allocations: {
    label: "Invoice",
    format: rows("Invoice", (e, c) => {
      const amount = num(e.allocation_amount);
      return `${nameOf(e.invoice_id, c)}: ${amount === null ? "the full amount due" : `up to ${money(amount, c.currency)}`}`;
    }),
  },
  refundable_minor: { label: "Refundable credit" },
  excess_minor: { label: "Excess payments" },
  credit_notes: {
    label: "Credit notes",
    format: (v, c) =>
      Array.isArray(v) ? v.map((e) => nameOf(isObj(e) ? e.id : e, c)).join(", ") || "None" : null,
  },
  date: { label: "Payment date" },
  shortfall: {
    label: "Remaining amount",
    options: {
      write_off: "Write off the remaining amount",
      leave_due: "Keep the remaining amount due",
    },
  },
  excess: {
    label: "Amount more than due",
    options: {
      credit: "Keep it as credit for the customer",
      refund: "Record that you returned it",
    },
  },
  void_reason_code: { label: "Reason" },
  action: {
    label: "Action",
    options: { add: "Add credits", deduct: "Deduct credits", set: "Set balance to" },
  },
  credit_type: {
    label: "Credit type",
    options: {
      general: "General",
      referral_rewards: "Referral rewards",
      loyalty_credits: "Loyalty credits",
    },
    plain: true,
  },
  max_excess_payment_usage_minor: { label: "Excess payments", format: creditCap },
  max_refundable_credits_usage_minor: { label: "Refundable credit", format: creditCap },
};

const SHIPPING = {
  label: { label: "Label" },
  is_default: FIELDS.is_default!,
};

/** Where one field means something else in one operation. */
const OP_FIELDS: Record<string, Record<string, FieldText>> = {
  "POST customers": { id: { label: "Customer ID" }, currency: { label: "Preferred currency" } },
  "PATCH customers/{cus}": { currency: { label: "Preferred currency" } },
  "POST customers/{cus}/shipping_addresses": SHIPPING,
  "PATCH customers/{cus}/shipping_addresses/{addr}": SHIPPING,
  "POST payment_links": { name: { label: "Name" } },
  "POST customers/{cus}/portal_sessions": {
    redirect_url: { label: "Page after sign-out", plain: true },
    action: {
      label: "Task",
      plain: true,
      options: {
        pay_invoice: "Pay an invoice",
        update_card: "Update the payment method",
        change_plan: "Change the plan",
        cancel_subscription: "Cancel the subscription",
      },
    },
  },
  "POST customers/{cus}/payment_requests": { email: { label: "Send to" } },
  "POST payment_requests/{preq}/send": { to: { label: "Send to" } },
  "POST customers/{cus}/subscriptions": {
    id: { label: "Subscription ID" },
    trial_end: { label: "Trial ends on", plain: true },
    discount: { label: "Manual discount", format: discountText },
    invoice_immediately: {
      label: "First invoice",
      options: onOff("Immediately", "Later: add the charges to unbilled charges"),
    },
    on_charge_failure: {
      label: "If the payment fails",
      options: {
        refuse: "Do not create the subscription",
        dun: "Create it, and dunning collects the invoice",
      },
    },
  },
  "POST subscriptions/{sub}/skip_renewal": {
    renewal_at: { label: "Renewal to skip", plain: true },
  },
  "POST subscriptions/{sub}/unskip_renewal": { renewal_at: { label: "Undo skip" } },
  "POST subscriptions/{sub}/manual_discount": {
    type: {
      label: "Discount type",
      options: { percent: "Percent off", amount: "Fixed amount off" },
    },
    value: {
      label: "Discount",
      format: (v, c, b) =>
        typeof v !== "number" ? null : b.type === "amount" ? money(v, c.currency) : `${v}%`,
    },
    duration: { label: "Duration", options: DISCOUNT_DURATION },
    note: { label: "Note" },
  },
  "POST subscriptions/{sub}/resume": {
    resume_date: { label: "Resume on", plain: true },
  },
  "POST subscriptions/{sub}/reactivate": {
    items: { label: "Item", format: ITEMS },
    billing_cycles: {
      label: "Billing cycles",
      format: (v) => (typeof v === "number" ? `Limited to ${v}` : null),
      none: "Forever",
    },
    trial_end: { label: "Trial end at" },
    charges_handling: {
      label: "Invoice timing",
      options: {
        invoice_immediately: "Immediately",
        add_to_unbilled_charges: "Add to unbilled charges",
      },
    },
    on_charge_failure: {
      label: "If the payment fails",
      options: { refuse: "Do not reactivate", dun: "Reactivate, and dunning collects the invoice" },
    },
  },
  "POST subscriptions/{sub}/schedule": {
    type: {
      label: "Change",
      plain: true,
      options: { cancel: "Cancel", pause: "Pause", resume: "Resume", change: "Change the items" },
    },
  },
  "POST subscriptions/{sub}/edit_trial_end": { trial_end: { label: "New trial end date" } },
  "POST subscriptions/{sub}/change_term_end": {
    prorate: {
      label: "Proration",
      options: onOff("Prorate the difference", "Do not prorate the difference"),
    },
    invoice_immediately: {
      label: "Invoicing",
      options: onOff("Invoice the proration immediately", "Do not invoice the proration now"),
    },
  },
  "POST customers/{cus}/credit_grants": { effective_at: { label: "Starts on", plain: true } },
  "POST customers/{cus}/spend_limits": {
    subscription: { label: "Subscription" },
    mode: {
      label: "At the limit",
      options: { hard: "Stop new requests", soft: "Send a notification only" },
    },
  },
  "PUT customers/{cus}/auto_topup": {
    unit: { label: "Unit", none: "Money" },
    amount_minor: { label: "Amount" },
  },
  "POST coupons": { code: { label: "ID" } },
  "POST payments/{pay}/refund": { reason: { label: "Reason" } },
  "POST credit_notes": {
    kind: {
      label: "This credit note should",
      options: { adjustment: "Adjust the amount due", refundable: "Provide refundable credits" },
    },
    reason: { label: "Note" },
    pack_refund: {
      label: "Credit pack line",
      options: { unused: "Credit the unused credits only", full: "Refund used credits too" },
    },
    items: {
      label: "Line item",
      format: rows("Line item", (e, c) => {
        const amount = num(e.amount_minor);
        const from = dateText(e.period_start, c.timezone);
        const until = dateText(e.period_end, c.timezone);
        return `${str(e.description) ?? nameOf(e.invoice_line_item, c)}: ${
          amount === null ? "—" : money(amount, c.currency)
        }${from && until ? ` (${from} to ${until})` : ""}`;
      }),
    },
  },
  "POST customers/{cus}/credit_grants/{grant}/void": {
    without_refund: {
      label: "Void without a refund",
      options: onOff("The customer gets no money back", "Refund through a credit note"),
    },
    reason: {
      label: "Reason",
      options: {
        customer_request: "Customer request",
        goodwill_reversal: "Goodwill credit taken back",
        billing_error: "Billing error",
        fraud: "Fraud",
        migration: "Migration",
        other: "Other",
      },
    },
  },
  "POST invoices": { customer: { label: "Customer" } },
  "POST invoices/{inv}/pay": {
    method: { label: "Payment method", options: OFFLINE_METHOD },
    comment: { label: "Note" },
  },
  "POST credit_notes/{cn}/record_refund": {
    method: { label: "Refund method", options: OFFLINE_METHOD },
    date: { label: "Refund date" },
    reason: { label: "Comment" },
  },
  "POST payment_requests/{preq}/record_payment": {
    method: { label: "Method", options: OFFLINE_METHOD },
    reference: { label: "Reference" },
  },
  "POST customers/{cus}/record_excess_payment": {
    method: { label: "Method", options: OFFLINE_METHOD },
  },
  "POST customers/{cus}/wallet/topup": {
    type: {
      label: "Type",
      plain: true,
      options: { paid: "Paid: charge the customer's card", granted: "Granted: free credit" },
    },
  },
};

/** The wording for a field: the operation's own, else the shared one. */
function fieldText(op: string | undefined, key: string): FieldText | undefined {
  return (op ? OP_FIELDS[op]?.[key] : undefined) ?? FIELDS[key];
}

/** A field's wording, for the coverage test: its label, options and formatter. */
export function fieldWording(
  operation: string,
  key: string,
): { label: string; options?: Record<string, string>; formatted: boolean } | undefined {
  const f = fieldText(operation, key);
  return f && { label: f.label, options: f.options, formatted: !!f.format };
}

/** Fields shown with a plain label because the dashboard has no control for them. */
export function plainFields(): string[] {
  const out = Object.entries(FIELDS)
    .filter(([, f]) => f.plain)
    .map(([k]) => k);
  for (const [op, fields] of Object.entries(OP_FIELDS))
    for (const [k, f] of Object.entries(fields)) if (f.plain) out.push(`${op} → ${k}`);
  return out;
}

/** Ids that name a credit amount in a unit, not money. */
function creditAmount(v: unknown, c: LineContext, body: Body): string | null {
  if (typeof v !== "number") return null;
  const unit = str(body.unit);
  const u = unit ? c.units?.get(unit) : undefined;
  if (!unit) return money(v, c.currency);
  if (!u) return String(v);
  return `${Number((v / 10 ** u.decimals).toFixed(u.decimals))} ${u.name}`;
}

/** The lines for one field: one, or several for a list or a group of settings. */
function fieldLines(
  op: string | undefined,
  key: string,
  v: unknown,
  c: LineContext,
  body: Body,
  path = key,
): Line[] {
  const f = fieldText(op, path) ?? (path !== key ? fieldText(op, key) : undefined);
  const label = f?.label ?? words(key);
  if (f?.format) {
    const out = f.format(v, c, body);
    if (Array.isArray(out)) return out;
    if (out !== null) return [{ label, value: out }];
  }
  if (v === null || v === undefined) return [{ label, value: f?.none ?? "—" }];
  if (f?.options) {
    const o = f.options[String(v)];
    if (o) return [{ label, value: o }];
  }
  if (key === "amount" && op === "POST customers/{cus}/credit_grants") {
    const a = creditAmount(v, c, body);
    if (a) return [{ label, value: a }];
  }
  if (key === "unit" && typeof v === "string")
    return [{ label, value: c.units?.get(v)?.name ?? v }];
  if (key === "billing_date" && typeof v === "number") return [{ label, value: String(v) }];
  // A group of settings: one line per setting, never JSON.
  if (isObj(v) && !/metadata|custom_fields|match/.test(key)) {
    const out = Object.entries(v).flatMap(([k, x]) => fieldLines(op, k, x, c, v, `${path}.${k}`));
    return out.length ? out : [{ label, value: "None" }];
  }
  return [{ label, value: plainValue(key, v, c) }];
}

// ── editing on the card ────────────────────────────────────────────────────────

/** Fields the card never offers to change: tokens, and the record a comment is on. */
const NOT_EDITABLE = new Set([
  "payment_intent",
  "idempotency_key",
  "unique_key",
  "object",
  "priced_at",
  "resource_type",
  "resource_id",
  "quote",
]);

const minorDigits = (currency: string) => (ZERO_DECIMAL.includes(currency.toUpperCase()) ? 0 : 2);

function zoneOf(tz?: string | null): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC" });
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}

/** The wall-clock time of `ms` in `tz`, read as if it were UTC. */
function wallClock(ms: number, tz: string): number {
  const p: Record<string, string> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: tz,
  }).formatToParts(new Date(ms)))
    p[type] = value;
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
}

/** An instant as a `datetime-local` value in the business's zone. */
export function localInputValue(ms: number, tz?: string | null): string {
  return new Date(wallClock(ms, zoneOf(tz))).toISOString().slice(0, 16);
}

/** A `datetime-local` value in the business's zone as an instant (ms); null when it is no time. */
export function fromLocalInput(local: string, tz?: string | null): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  if (Number.isNaN(guess)) return null;
  const zone = zoneOf(tz);
  let t = guess - (wallClock(guess, zone) - guess);
  // Once more, for a time near a daylight-saving change.
  t = guess - (wallClock(t, zone) - t);
  return t;
}

function instantMs(v: unknown): number | null {
  if (typeof v === "number") return v >= 1e8 ? (v < 1e11 ? v * 1000 : v) : null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Option labels as a list, one per label (`cheque` and `check` both read "Check"). */
function optionList(options: Record<string, string>, current: string) {
  const seen = new Map<string, string>();
  for (const [value, label] of Object.entries(options))
    if (!seen.has(label) || value === current) seen.set(label, value);
  return [...seen].map(([label, value]) => ({ value, label }));
}

/**
 * The control for a top-level scalar field, or null when the card must not offer one: record
 * ids, nested values, lists, hidden and internal fields.
 */
export function editInput(
  op: string | undefined,
  key: string,
  v: unknown,
  c: LineContext,
  body: Body,
): LineInput | null {
  if (NOT_EDITABLE.has(key) || key in ID_KEYS) return null;
  const f = fieldText(op, key);
  if (f?.hidden) return null;
  if (typeof v === "boolean") {
    const o = f?.options;
    return {
      kind: "boolean",
      value: v,
      ...(o?.true && o.false
        ? {
            options: [
              { value: "true", label: o.true },
              { value: "false", label: o.false },
            ],
          }
        : {}),
    };
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    if (DATE_KEY.test(key) && v >= 1e8)
      return { kind: "datetime", value: localInputValue(instantMs(v)!, c.timezone) };
    if (key.endsWith("_bps")) return { kind: "number", unit: "bps", value: String(v / 100) };
    const money =
      key.endsWith("_minor") ||
      (key === "amount" && op === "POST customers/{cus}/credit_grants" && !str(body.unit)) ||
      (key === "value" &&
        op === "POST subscriptions/{sub}/manual_discount" &&
        body.type === "amount");
    if (money) {
      const digits = minorDigits(c.currency);
      return {
        kind: "amount",
        unit: "minor",
        currency: c.currency,
        value: (v / 10 ** digits).toFixed(digits),
      };
    }
    // An amount in a credit unit reads in that unit's decimals: not offered.
    if (key === "amount" && str(body.unit)) return null;
    return { kind: "number", value: String(v) };
  }
  if (typeof v === "string") {
    if (c.names?.has(v)) return null;
    if (f?.options?.[v]) return { kind: "select", value: v, options: optionList(f.options, v) };
    if (DATE_KEY.test(key)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { kind: "date", value: v };
      const ms = instantMs(v);
      if (ms !== null) return { kind: "datetime", value: localInputValue(ms, c.timezone) };
    }
    return { kind: "text", value: v };
  }
  return null;
}

/**
 * What the member typed, in the body's own form: minor units, basis points, the instant in the
 * shape the body had. `error` says what to enter instead.
 */
export function coerceEdit(
  input: LineInput,
  raw: unknown,
  original: unknown,
  tz?: string | null,
): { value: unknown } | { error: string } {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : null;
  switch (input.kind) {
    case "text":
      if (raw === null || text === "") return { value: null };
      return text === null ? { error: "Enter text" } : { value: text };
    case "number":
    case "amount": {
      const n = text === null || text === "" ? NaN : Number(text);
      if (!Number.isFinite(n)) return { error: "Enter a number" };
      if (input.unit === "bps") return { value: Math.round(n * 100) };
      if (input.unit === "minor")
        return { value: Math.round(n * 10 ** minorDigits(input.currency ?? "USD")) };
      return { value: n };
    }
    case "date": {
      const d = text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN;
      return Number.isNaN(d) ? { error: "Enter a date" } : { value: text };
    }
    case "datetime": {
      const ms = !text
        ? null
        : /[zZ]|[+-]\d{2}:?\d{2}$/.test(text)
          ? instantMs(text)
          : fromLocalInput(text, tz);
      if (ms === null) return { error: "Enter a date and time" };
      if (typeof original === "number")
        return { value: original < 1e11 ? Math.floor(ms / 1000) : ms };
      return { value: new Date(ms).toISOString().replace(".000Z", "Z") };
    }
    case "select":
      return text !== null && input.options?.some((o) => o.value === text)
        ? { value: text }
        : { error: "Select one of the options" };
    case "boolean":
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true" || raw === "false") return { value: raw === "true" };
      return { error: "Select on or off" };
  }
}

/** What a record id param is, for its line's label. */
export const RECORD_NOUN: Record<string, string> = {
  cus: "Customer",
  sub: "Subscription",
  inv: "Invoice",
  cn: "Credit note",
  preq: "Payment request",
  pay: "Payment",
  email: "Email",
  sch: "Scheduled change",
  item: "Item",
  con: "Contact",
  addr: "Shipping address",
  charge: "Pending charge",
  usage: "Usage record",
  limit: "Spend limit",
  grant: "Credit grant",
};

const SHIPPING_OPS = new Set([
  "POST customers/{cus}/shipping_addresses",
  "PATCH customers/{cus}/shipping_addresses/{addr}",
]);

/** Fields one line stands for: the address parts of a shipping address, a comment's record. */
function regroup(op: string | undefined, body: Body, c: LineContext): Array<[string, unknown]> {
  const entries = Object.entries(body);
  if (op && SHIPPING_OPS.has(op) && entries.some(([k]) => ADDRESS_PARTS.includes(k))) {
    const parts = Object.fromEntries(entries.filter(([k]) => ADDRESS_PARTS.includes(k)));
    const rest = entries.filter(([k]) => !ADDRESS_PARTS.includes(k));
    return [...rest, ["__address", addressText(parts)]];
  }
  if (op === "POST comments" && typeof body.resource_id === "string") {
    const noun = FIELDS.resource_type!.options![String(body.resource_type)] ?? "Record";
    return [
      ["__record", [noun, nameOf(body.resource_id, c)]],
      ...entries.filter(([k]) => k !== "resource_type" && k !== "resource_id"),
    ];
  }
  return entries;
}

/** Operations where the currency is a setting of its own, not the unit of an amount. */
const CURRENCY_SETTING = new Set(["POST customers", "PATCH customers/{cus}"]);

/** True when an amount in the body already says the currency. */
const hasMoney = (v: unknown): boolean =>
  isObj(v)
    ? Object.entries(v).some(([k, x]) => /_minor$/.test(k) || k === "amount" || hasMoney(x))
    : Array.isArray(v)
      ? v.some(hasMoney)
      : false;

/** The request as the member will read it: the records it touches, then each field sent. */
export function requestLines(
  params: Record<string, string>,
  body: Body,
  ctx: string | LineContext,
): Line[] {
  const c0: LineContext = typeof ctx === "string" ? { currency: ctx } : ctx;
  const c: LineContext = { ...c0, currency: str(body.currency) ?? c0.currency };
  const op = c.operation;
  const lines: Line[] = [];
  for (const [k, v] of Object.entries(params))
    lines.push({ label: RECORD_NOUN[k] ?? words(k), value: c.names?.get(v) ?? v });
  const showCurrency = !hasMoney(body) || (op ? CURRENCY_SETTING.has(op) : false);
  for (const [k, v] of regroup(op, body, c)) {
    if (k === "currency" && !showCurrency) continue;
    if (fieldText(op, k)?.hidden) continue;
    if (k === "__address") lines.push({ label: "Address", value: String(v) });
    else if (k === "__record") {
      const [label, value] = v as [string, string];
      lines.push({ label, value });
    } else {
      const out = fieldLines(op, k, v, c, body);
      // One line for one scalar field: the member may change it on the card.
      const input = out.length === 1 ? editInput(op, k, v, c, body) : null;
      if (input) out[0] = { ...out[0]!, key: k, input };
      lines.push(...out);
    }
  }
  if (lines.length <= MAX_LINES) return lines;
  return [
    ...lines.slice(0, MAX_LINES - 1),
    { label: "More fields", value: String(lines.length - MAX_LINES + 1) },
  ];
}

/**
 * An update as before → after rows: the records it touches, then one row per field that
 * changes. A row whose two values read the same is dropped.
 */
export function changeLines(
  params: Record<string, string>,
  changed: Body,
  before: Body,
  ctx: LineContext,
): Line[] {
  const after = requestLines(params, changed, ctx);
  const was = requestLines({}, before, ctx);
  const records = Object.keys(params).length;
  const seen = new Map<string, number>();
  const out: Line[] = after.slice(0, records);
  for (const l of after.slice(records)) {
    const n = seen.get(l.label) ?? 0;
    seen.set(l.label, n + 1);
    const b = was.filter((w) => w.label === l.label)[n];
    if (b && b.value === l.value) continue;
    out.push(b ? { ...l, before: b.value } : l);
  }
  return out;
}

// ── previews ───────────────────────────────────────────────────────────────────

/** Engine preview figures, as the dashboard's summaries name them. */
const PREVIEW_LABEL: Record<string, string> = {
  subtotal_minor: "Subtotal",
  discount_minor: "Discounts",
  promotional_discount_minor: "Promotional credits",
  tax_minor: "Tax",
  total_minor: "Total",
  invoice_subtotal_minor: "Invoice subtotal",
  invoice_total_minor: "Invoice total",
  credit_note_total_minor: "Credit for unused time",
  credits_applied_minor: "Credits",
  promotional_credits_applied_minor: "Promotional credits applied",
  refundable_credits_applied_minor: "Refundable credits applied",
  excess_payments_applied_minor: "Excess payments applied",
  grant_credits_pre_tax_minor: "Credit grants before tax",
  grant_credits_post_tax_minor: "Credit grants after tax",
  refunded_to_payment_method_minor: "Refunded to the payment method",
  refundable_credit_added_minor: "Credited to the account",
  credit_applied_to_open_invoices_minor: "Credit applied to open invoices",
  credit_applied_to_this_invoice_minor: "Credit applied",
  credit_returned_to_buckets_minor: "Credit returned to the balance",
  credit_returned_to_grants_minor: "Credit returned to credit grants",
  withholding_minor: "Withholding",
  amount_due_minor: "Amount due",
  outstanding_minor: "Outstanding",
  ceiling_minor: "Mandate limit",
  reauthorized_ceiling_minor: "New mandate limit",
};
const PREVIEW_GROUP: Record<string, string> = {
  next_renewal: "Next renewal",
  in_term_reactivation: "Open invoice",
  invoice: "Invoice",
  mandate_shortfall: "Mandate",
};
/** Engine checks, not figures for the member. */
const PREVIEW_SKIP = new Set(["credit_stranded_minor", "credit_routing_over_claimed_minor"]);

/** The cancel preview's rows, split as the cancel dialog splits them. */
function cancelPreview(e: Body, currency: string): Line[] {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const out: Line[] = [];
  if (n(e.net_collect_minor) > 0)
    out.push({
      label: "Collected from the customer",
      value: money(n(e.net_collect_minor), currency),
    });
  if (n(e.net_refund_minor) > 0)
    out.push({ label: "Refunded to the customer", value: money(n(e.net_refund_minor), currency) });
  const credit = n(e.net_credit_minor);
  if (credit > 0) {
    const cc = isObj(e.cancellation_credit) ? e.cancellation_credit : {};
    const rc = isObj(e.refundable_credits) ? e.refundable_credits : {};
    const refunded = n(rc.includes_cancellation_credit_minor);
    const restored = Math.max(
      0,
      n(cc.refundable_credit_note_minor) +
        n(cc.promotional_restore_minor) +
        n(cc.excess_restore_minor) -
        refunded,
    );
    const relieved = cc.delivery === "adjustment" ? n(cc.adjustment_minor) : 0;
    if (restored + relieved + refunded === credit) {
      if (restored > 0)
        out.push({ label: "Credited to the account", value: money(restored, currency) });
      if (relieved > 0) out.push({ label: "No longer owed", value: money(relieved, currency) });
    } else out.push({ label: "Credited to the account", value: money(credit, currency) });
  }
  return out;
}

/** Money figures from an engine preview: the non-zero amounts, named as the dashboard names them. */
export function previewLines(preview: unknown, ctx: string | LineContext): Line[] {
  const currency = typeof ctx === "string" ? ctx : ctx.currency;
  if (!isObj(preview)) return [];
  const cur = str(preview.currency) ?? currency;
  if (preview.object === "cancel_estimate") return cancelPreview(preview, cur);
  if (Array.isArray(preview.invoice_estimates)) {
    const invoices = preview.invoice_estimates.filter(isObj);
    return invoices
      .flatMap((inv, i) =>
        ["subtotal_minor", "tax_minor", "credits_applied_minor", "total_minor", "amount_due_minor"]
          .filter((k) => typeof inv[k] === "number" && inv[k] !== 0)
          .map((k) => ({
            label: `${invoices.length > 1 ? `Invoice ${i + 1} · ` : ""}${PREVIEW_LABEL[k]}`,
            value: money(inv[k] as number, str(inv.currency) ?? cur),
          })),
      )
      .slice(0, 10);
  }
  const out: Line[] = [];
  const walk = (o: Body, prefix: string, depth: number, c: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (out.length >= 10) return;
      if (typeof v === "number" && k.endsWith("_minor") && v !== 0 && !PREVIEW_SKIP.has(k))
        out.push({ label: `${prefix}${PREVIEW_LABEL[k] ?? words(k)}`, value: money(v, c) });
      else if (isObj(v) && depth < 2)
        walk(v, `${prefix}${PREVIEW_GROUP[k] ?? words(k)} · `, depth + 1, str(v.currency) ?? c);
    }
  };
  walk(preview, "", 0, cur);
  return out;
}

// ── names ──────────────────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9_-]{1,100}$/;
type Kind =
  | "customer"
  | "invoice"
  | "credit_note"
  | "price"
  | "coupon"
  | "product"
  | "meter"
  | "credit_unit"
  | "payment_method"
  | "dunning_policy"
  | "item"
  | "contact"
  | "address";

/** Body keys whose value is a record id with a name, by key. */
const ID_KEYS: Record<string, Kind> = {
  customer: "customer",
  invoice: "invoice",
  invoices: "invoice",
  invoice_ids: "invoice",
  invoice_id: "invoice",
  credit_note: "credit_note",
  credit_notes: "credit_note",
  price: "price",
  prices: "price",
  price_ids: "price",
  coupon_ids: "coupon",
  product_ids: "product",
  meters: "meter",
  unit: "credit_unit",
  payment_method: "payment_method",
  payment_method_id: "payment_method",
  item: "item",
  removes: "item",
  shipping_address_id: "address",
  dunning_policy: "dunning_policy",
};
const PARAM_KINDS: Record<string, Kind> = {
  cus: "customer",
  inv: "invoice",
  cn: "credit_note",
  item: "item",
  con: "contact",
  addr: "address",
};
const RESOURCE_KINDS: Record<string, Kind> = {
  customer: "customer",
  invoice: "invoice",
  credit_note: "credit_note",
  price: "price",
  coupon: "coupon",
  product: "product",
};

/** Every named record id the request mentions. */
export function namedRefs(params: Record<string, string>, body: Body): Array<[Kind, string]> {
  const out: Array<[Kind, string]> = [];
  const add = (kind: Kind | undefined, v: unknown) => {
    if (kind && typeof v === "string" && ID.test(v)) out.push([kind, v]);
  };
  for (const [k, v] of Object.entries(params)) add(PARAM_KINDS[k], v);
  const walk = (o: unknown, key: string, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(o)) for (const x of o) walk(x, key, depth + 1);
    else if (isObj(o)) for (const [k, v] of Object.entries(o)) walk(v, k, depth + 1);
    else add(ID_KEYS[key], o);
  };
  walk(body, "", 0);
  // credit_notes: [{ id }] on apply credits.
  if (Array.isArray(body.credit_notes))
    for (const e of body.credit_notes) if (isObj(e)) add("credit_note", e.id);
  if (typeof body.resource_type === "string")
    add(RESOURCE_KINDS[body.resource_type], body.resource_id);
  if (typeof body.object === "string")
    add(body.action === "pay_invoice" ? "invoice" : undefined, body.object);
  return out;
}

const ok = (r: RouteResult | null) =>
  r && r.status >= 200 && r.status < 300 && isObj(r.body) ? (r.body as Body) : null;
const listOf = (b: Body | null): Body[] =>
  Array.isArray(b?.data) ? (b!.data as unknown[]).filter(isObj) : [];

/** A GET that runs each path once per proposal. */
export function cachedGet(get: Get): Get {
  const seen = new Map<string, Promise<RouteResult>>();
  return (rel) => {
    if (!seen.has(rel)) seen.set(rel, get(rel));
    return seen.get(rel)!;
  };
}

/**
 * The names behind the ids a request mentions, through the same read routes the dashboard uses.
 * A lookup that fails leaves the id as it is.
 */
export async function lookupNames(
  params: Record<string, string>,
  body: Body,
  get: Get,
): Promise<{ names: Map<string, string>; units: Map<string, { name: string; decimals: number }> }> {
  const names = new Map<string, string>();
  const units = new Map<string, { name: string; decimals: number }>();
  const refs = namedRefs(params, body).slice(0, 40);
  if (!refs.length) return { names, units };
  const read = (rel: string) =>
    get(rel)
      .then(ok)
      .catch(() => null);
  const e = encodeURIComponent;

  // The customer, for its payment methods, contacts and addresses; the subscription, for its items.
  const sub = params.sub ?? str(body.subscription);
  const subBody =
    sub && refs.some(([k]) => k === "item") ? await read(`subscriptions/${e(sub)}`) : null;
  let customer = params.cus ?? str(body.customer);
  if (!customer && refs.some(([k]) => k === "payment_method" || k === "address")) {
    for (const [p, path] of [
      ["sub", "subscriptions"],
      ["inv", "invoices"],
      ["preq", "payment_requests"],
    ] as const) {
      const id = params[p];
      const b = id ? await read(`${path}/${e(id)}`) : null;
      customer = str(b?.customer);
      if (customer) break;
    }
  }
  if (subBody && Array.isArray(subBody.items))
    for (const it of subBody.items.filter(isObj))
      if (typeof it.id === "string" && str(it.product_name))
        names.set(it.id, String(it.product_name));

  const one = async (kind: Kind, id: string): Promise<string | null> => {
    switch (kind) {
      case "customer": {
        const b = await read(`customers/${e(id)}`);
        return str(b?.name) ?? str(b?.company) ?? str(b?.email);
      }
      case "invoice":
        return str((await read(`invoices/${e(id)}`))?.number);
      case "credit_note":
        return str((await read(`credit_notes/${e(id)}`))?.number);
      case "price":
        return str((await read(`prices/${e(id)}`))?.name);
      case "coupon": {
        const b = await read(`coupons/${e(id)}`);
        return str(b?.name) ?? str(b?.code);
      }
      case "product":
        return str((await read(`products/${e(id)}`))?.name);
      case "meter":
        return str((await read(`meters/${e(id)}`))?.name);
      case "dunning_policy":
        return str((await read(`dunning_policies/${e(id)}`))?.name);
      case "credit_unit": {
        const b = await read(`credit_units/${e(id)}`);
        const name = str(b?.plural_name) ?? str(b?.name);
        if (name) units.set(id, { name, decimals: num(b?.decimals) ?? 0 });
        return name;
      }
      case "payment_method": {
        if (!customer) return null;
        const b = await read(`customers/${e(customer)}/payment_methods/${e(id)}`);
        if (!b) return null;
        const brand = str(b.brand);
        const head = brand
          ? brand.charAt(0).toUpperCase() + brand.slice(1)
          : (str(b.type) ?? "Card");
        return `${head}${b.last4 ? ` ending ${b.last4}` : ""}`;
      }
      case "contact": {
        if (!customer) return null;
        const c = listOf(await read(`customers/${e(customer)}/contacts`)).find((x) => x.id === id);
        return c
          ? [str(c.first_name), str(c.last_name)].filter(Boolean).join(" ") ||
              str(c.email) ||
              str(c.label)
          : null;
      }
      case "address": {
        if (!customer) return null;
        const a = listOf(await read(`customers/${e(customer)}/shipping_addresses`)).find(
          (x) => x.id === id,
        );
        return a ? (str(a.label) ?? addressText(a)) : null;
      }
      case "item":
        return names.get(id) ?? null;
    }
  };
  await Promise.all(
    [...new Map(refs.map(([k, id]) => [`${k}:${id}`, [k, id] as const])).values()].map(
      async ([kind, id]) => {
        const name = await one(kind, id).catch(() => null);
        if (name) names.set(id, name);
      },
    ),
  );
  return { names, units };
}
