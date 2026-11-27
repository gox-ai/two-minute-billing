import type { ExportStatus } from "@/lib/api/exports";
import type { ImportEntity } from "@/lib/import-entities";

/** What one record of each file is, for counts: "1,204 customers". */
export const RECORD_NOUN: Record<ImportEntity, [string, string]> = {
  plans: ["plan price", "plan prices"],
  addons: ["add-on price", "add-on prices"],
  coupons: ["coupon", "coupons"],
  customers: ["customer", "customers"],
  subscriptions: ["subscription", "subscriptions"],
  invoices: ["invoice", "invoices"],
  credit_notes: ["credit note", "credit notes"],
  payments: ["payment or refund", "payments and refunds"],
  usage: ["usage record", "usage records"],
};

export const records = (e: ImportEntity, n: number) =>
  `${n.toLocaleString("en-US")} ${RECORD_NOUN[e][n === 1 ? 0 : 1]}`;

/** What each file holds, under its name. */
export const EXPORT_HELP: Record<ImportEntity, string> = {
  plans: "Plans and their prices. One row for each price.",
  addons: "Add-ons and one-time charges. One row for each price.",
  coupons: "Coupons and their codes.",
  customers: "Contacts, addresses, tax IDs and saved card references. Never card numbers.",
  subscriptions: "Items, coupons, trials and the current term. One row for each item.",
  invoices: "Paid, open and void invoices. One row for each line, with the tax and discount.",
  credit_notes: "Credit notes and the credit the customer can still use.",
  payments: "Payments and refunds, with the invoice they paid.",
  usage: "Usage records of each subscription.",
};

/** The columns after the import's: the file has them, and the import does not read them. */
export const EXTRA_COLUMN_HELP: Record<string, string> = {
  product_name: "The name of the plan or add-on the price belongs to.",
  updated_at: "When the record last changed.",
  times_redeemed: "How many times the coupon was used.",
  currency: "The customer's currency.",
  mrr: "The monthly recurring revenue of the subscription, after its discounts.",
  next_billing_at: "When the subscription renews next.",
  amount_paid: "How much of the invoice is paid.",
  paid_status: "The invoice's status in this business.",
  number: "The credit note's number.",
  status: "The credit note's status in this business.",
  subscription_id: "The subscription the payment was for.",
};

export const EXPORT_STATUS: Record<
  ExportStatus,
  { label: string; tone: "green" | "tan" | "red" | "gray" | "blue" }
> = {
  queued: { label: "Waiting", tone: "blue" },
  running: { label: "Exporting", tone: "blue" },
  succeeded: { label: "Ready", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  expired: { label: "Files deleted", tone: "gray" },
  deleted: { label: "Files deleted", tone: "gray" },
};

export const SUBSCRIPTION_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "trialing", label: "In trial" },
  { value: "future", label: "Future" },
  { value: "paused", label: "Paused" },
  { value: "non_renewing", label: "Non-renewing" },
  { value: "cancelled", label: "Cancelled" },
];
export const INVOICE_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "paid", label: "Paid" },
  { value: "open", label: "Open" },
  { value: "void", label: "Void" },
];
export const PAYMENT_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];

export type RangePreset =
  | "any"
  | "last_30_days"
  | "last_90_days"
  | "last_12_months"
  | "this_year"
  | "last_year"
  | "between";

export const RANGE_OPTIONS: Array<{ value: RangePreset; label: string }> = [
  { value: "any", label: "Any time" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "last_12_months", label: "Last 12 months" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
  { value: "between", label: "Between dates" },
];

export const sizeText = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024)).toLocaleString("en-US")} KB`
    : `${(n / 1048576).toFixed(1)} MB`;
