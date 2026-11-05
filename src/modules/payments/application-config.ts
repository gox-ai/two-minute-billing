/**
 * Payment application (settings 2.51, 2.66, 2.69), stored in
 * `businesses.billing_rules_config.payment_application`:
 *
 *   { several_due_invoices?, invoice_order?, excess_payment? }
 *
 * Pure resolver: null, absent or an unknown value resolves to today's behaviour.
 *  - several_due_invoices: `separate` = one charge per invoice (today); `combined` = the clock
 *    charges a customer's due retries together (`dunning-combined.ts`); `customer_chooses` =
 *    one charge each, and the portal may pay all open invoices in one charge.
 *  - invoice_order: which open invoice a payment settles first. `oldest_first` (today),
 *    `newest_first`, or `customer_chooses` (oldest first, and the portal may select).
 *  - excess_payment: a gateway payment that settles for more than its invoice still owes.
 *    `credit` keeps the rest as customer credit (today); `refund` returns it;
 *    `customer_chooses` keeps it as credit and the portal may refund it.
 */
export const SEVERAL_DUE_INVOICES = ["separate", "combined", "customer_chooses"] as const;
export const INVOICE_ORDERS = ["oldest_first", "newest_first", "customer_chooses"] as const;
export const EXCESS_PAYMENT_ACTIONS = ["credit", "refund", "customer_chooses"] as const;

/**
 * An operator's offline payment above the amount due: `credit` (the default, whatever
 * `excess_payment` says, since that rule governs gateway payments) or `refund`, which records
 * the excess as returned to the payer outside any gateway.
 */
export const OFFLINE_EXCESS_CHOICES = ["credit", "refund"] as const;
export type OfflineExcessChoice = (typeof OFFLINE_EXCESS_CHOICES)[number];

export type SeveralDueInvoices = (typeof SEVERAL_DUE_INVOICES)[number];
export type InvoiceOrder = (typeof INVOICE_ORDERS)[number];
export type ExcessPaymentAction = (typeof EXCESS_PAYMENT_ACTIONS)[number];

export interface PaymentApplicationConfig {
  severalDueInvoices: SeveralDueInvoices;
  invoiceOrder: InvoiceOrder;
  excessPayment: ExcessPaymentAction;
}

export const DEFAULT_PAYMENT_APPLICATION: PaymentApplicationConfig = {
  severalDueInvoices: "separate",
  invoiceOrder: "oldest_first",
  excessPayment: "credit",
};

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

function obj(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** Takes the business row (camelCase `billingRulesConfig`). */
export function resolvePaymentApplication(
  biz: { billingRulesConfig?: unknown } | null | undefined,
): PaymentApplicationConfig {
  const pa = obj(obj(biz?.billingRulesConfig)?.payment_application);
  const d = DEFAULT_PAYMENT_APPLICATION;
  return {
    severalDueInvoices: pick(pa?.several_due_invoices, SEVERAL_DUE_INVOICES, d.severalDueInvoices),
    invoiceOrder: pick(pa?.invoice_order, INVOICE_ORDERS, d.invoiceOrder),
    excessPayment: pick(pa?.excess_payment, EXCESS_PAYMENT_ACTIONS, d.excessPayment),
  };
}

export function serializePaymentApplication(c: PaymentApplicationConfig) {
  return {
    several_due_invoices: c.severalDueInvoices,
    invoice_order: c.invoiceOrder,
    excess_payment: c.excessPayment,
  };
}

/** Newest first only when the business chose it; `customer_chooses` keeps the oldest-first default. */
export const settlesNewestFirst = (c: PaymentApplicationConfig) =>
  c.invoiceOrder === "newest_first";

/** Written for a business a person creates. Each equals today's behaviour (plan 2.51/2.66/2.69). */
export const NEW_BUSINESS_PAYMENT_APPLICATION = {
  several_due_invoices: "separate",
  invoice_order: "oldest_first",
  excess_payment: "credit",
} as const;

/** The resolved config of one business. */
export async function loadPaymentApplication(
  organizationId: string,
  businessId: string,
): Promise<PaymentApplicationConfig> {
  const { loadBillingRulesRow } = await import("@/modules/subscriptions/billing-rules-config");
  return resolvePaymentApplication(await loadBillingRulesRow(organizationId, businessId));
}

/**
 * Application order for open invoices: due date (else creation), then creation, then id —
 * ascending, or all three reversed for `newest_first`.
 */
export function compareForApplication(
  a: { dueDate: Date | null; createdAt: Date; id: string },
  b: { dueDate: Date | null; createdAt: Date; id: string },
  newestFirst = false,
): number {
  const ka = (a.dueDate ?? a.createdAt).getTime();
  const kb = (b.dueDate ?? b.createdAt).getTime();
  let c = 0;
  if (ka !== kb) c = ka - kb;
  else if (a.createdAt.getTime() !== b.createdAt.getTime())
    c = a.createdAt.getTime() - b.createdAt.getTime();
  else c = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return newestFirst ? -c : c;
}
