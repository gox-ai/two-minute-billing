import { asc, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { customers, invoiceLineItems, subscriptionItems, prices, products } from "@db/schema";

/**
 * What a person sees beside the money in the gateway's own dashboard.
 *
 * Stripe shows `description` on the payment row, the receipt and the dispute record, and it
 * is often the only field a support or finance person has to work from — the gateway knows
 * nothing of our ids. Ours said `Invoice inv_XXXXXXXXXXXXXXXXXXXXXX01`, which identifies the
 * row to us and to nobody else: not who paid, not what for.
 *
 * Format: `<invoice number> · <plan> · <email>`, e.g.
 *   `INV-100042 · Google Sheets (LITE plan) · customer@example.com`
 *
 * The human invoice NUMBER, not the public id: the number is what appears on the PDF the
 * customer received and what they quote back, so it is the field that joins a Stripe row to a
 * conversation.
 *
 * Best-effort by construction. Every lookup is optional and any failure degrades to a shorter
 * description — a charge must never fail because its label could not be built, and a partial
 * label still beats the id alone.
 */
const MAX = 320; // well inside Stripe's 1000, and short enough to read in a table row

/**
 * WHICH FLOW TOOK THE MONEY — the one thing the gateway row could never tell you.
 *
 * Three flows reach a gateway with a charge and they read identically in Stripe's list:
 * the billing clock renewing a subscription, an operator pressing Collect now, and the
 * payer pressing Pay now in the portal. When a payment needs explaining, "who started
 * this" is usually the first question, and until now the answer lived only in our own
 * `payment_attempts` — which the support person looking at Stripe does not have open.
 *
 * ⚠️ THESE LABELS ARE SEMI-CUSTOMER-FACING. Stripe puts `description` on the payment row,
 * the RECEIPT and the dispute record, so they are written to be read by a payer as well as
 * by us — which rules out our own internal names.
 *
 * `PayNow` is deliberately NOT used: **`paynow` is a Stripe payment method** (Singapore's
 * instant-transfer scheme), so a row reading "PayNow" against an INR card debit would name
 * a rail that was not used, in a dashboard that also lists real PayNow payments. "Portal
 * payment" says the same thing without the collision, and it is precisely accurate — the
 * flow exists only on the customer portal.
 *
 * `Manual collection` rather than "Collect now" for the same reason (the button's name
 * means nothing to a payer) and one more: this product already has "record an OFFLINE
 * payment", and "Manual payment" would read as that.
 */
export type ChargeFlow =
  | "renewal"
  | "manual_collection"
  | "portal_payment"
  | "new_subscription"
  | "reactivation"
  | "one_time_purchase";

const FLOW_LABEL: Record<ChargeFlow, string> = {
  renewal: "Renewal",
  manual_collection: "Manual collection",
  portal_payment: "Portal payment",
  new_subscription: "New subscription",
  reactivation: "Reactivation",
  one_time_purchase: "One-time purchase",
};

/** The label, or nothing when the caller genuinely does not know which flow it is in. */
export function chargeFlowLabel(flow: ChargeFlow | undefined): string | null {
  return flow ? FLOW_LABEL[flow] : null;
}

function join(parts: Array<string | null | undefined>): string {
  const out = parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(" · ");
  return out.length > MAX ? `${out.slice(0, MAX - 1)}…` : out;
}

async function emailOf(organizationId: string, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  try {
    const [c] = await withTenant(organizationId, (tx) =>
      tx
        .select({ email: customers.email })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1),
    );
    return c?.email ?? null;
  } catch {
    return null;
  }
}

/** The invoice's first non-tax, non-discount line — in practice the plan the buyer is paying for. */
async function planFromInvoice(organizationId: string, invoiceId: string): Promise<string | null> {
  try {
    const rows = await withTenant(organizationId, (tx) =>
      tx
        .select({ description: invoiceLineItems.description, kind: invoiceLineItems.kind })
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId))
        .orderBy(asc(invoiceLineItems.createdAt))
        .limit(8),
    );
    return rows.find((r) => r.kind !== "tax" && r.kind !== "discount")?.description ?? null;
  } catch {
    return null;
  }
}

/** The subscription's first item, for the charge that happens BEFORE any invoice exists. */
async function planFromSubscription(
  organizationId: string,
  subscriptionId: string,
): Promise<string | null> {
  try {
    const [row] = await withTenant(organizationId, (tx) =>
      tx
        .select({ product: products.name, price: prices.publicId })
        .from(subscriptionItems)
        .leftJoin(prices, eq(prices.id, subscriptionItems.priceId))
        .leftJoin(products, eq(products.id, prices.productId))
        .where(eq(subscriptionItems.subscriptionId, subscriptionId))
        .orderBy(asc(subscriptionItems.createdAt))
        .limit(1),
    );
    return row?.product ?? row?.price ?? null;
  } catch {
    return null;
  }
}

/**
 * Label for a SETUP — saving a card, registering a mandate. Not a charge.
 *
 * Deliberately carries no {@link ChargeFlow}: "Renewal" or "Portal payment" would both be
 * false about an object that moves no money, and a wrong word on a mandate authorisation
 * the buyer is being asked to approve is worse than a missing one. What it does carry is
 * the two things the gateway row cannot say for itself — WHO is authorising, and, when a
 * ceiling is being registered, the term that ceiling is. On RazorPay's e-mandate this text
 * reaches the buyer's own bank page, which is the strongest reason for it to read as a
 * plain sentence about their authorisation rather than as our internal vocabulary.
 */
/**
 * Money, for a label. Local rather than `document.ts`'s `formatMoney`: this file's only
 * dependencies are drizzle and the schema, and it is imported by the payment-intents and
 * payment-methods modules — pulling the invoice RENDERER in to format one number would
 * hand those two a dependency on the PDF stack for a string.
 */
function money(minor: bigint, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(Number(minor) / 100);
  } catch {
    // An unknown code must not stop a charge — say the number and the code plainly.
    return `${(Number(minor) / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export async function setupChargeDescription(input: {
  organizationId: string;
  customerId: string | null;
  maxAmountMinor?: bigint | null;
  currency?: string | null;
}): Promise<string> {
  const email = await emailOf(input.organizationId, input.customerId);
  const ceiling =
    input.maxAmountMinor != null && input.maxAmountMinor > 0n && input.currency
      ? `up to ${money(input.maxAmountMinor, input.currency)} per charge`
      : null;
  return join(["Payment method setup", ceiling, email]);
}

/** Label for a charge that settles an invoice. */
export async function invoiceChargeDescription(input: {
  organizationId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  invoicePublicId: string;
  customerId: string | null;
  flow?: ChargeFlow;
}): Promise<string> {
  const [plan, email] = await Promise.all([
    planFromInvoice(input.organizationId, input.invoiceId),
    emailOf(input.organizationId, input.customerId),
  ]);
  // The public id is the fallback, never an addition: it is meaningless outside our database,
  // and a number the customer can quote is the whole point of preferring it.
  //
  // The FLOW leads, because it is the field that differs between two rows for the same
  // customer and it is short enough not to push the invoice number out of a truncated
  // column. The number stays second, still the first thing a support conversation quotes.
  return join([
    chargeFlowLabel(input.flow),
    `Invoice ${input.invoiceNumber ?? input.invoicePublicId}`,
    plan,
    email,
  ]);
}

/**
 * Label for the first charge of a subscription, taken before its invoice is committed —
 * see `chargeBeforeSubscriptionInvoice`. There is no invoice number to name yet, so the
 * subscription is what identifies the row.
 */
export async function subscriptionChargeDescription(input: {
  organizationId: string;
  subscriptionId: string;
  subscriptionPublicId: string;
  customerId: string | null;
  flow?: ChargeFlow;
}): Promise<string> {
  const [plan, email] = await Promise.all([
    planFromSubscription(input.organizationId, input.subscriptionId),
    emailOf(input.organizationId, input.customerId),
  ]);
  return join([
    chargeFlowLabel(input.flow),
    `Subscription ${input.subscriptionPublicId}`,
    plan,
    email,
  ]);
}
