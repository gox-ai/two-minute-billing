/**
 * Pure buyer-facing rules for the portal: what state a saved method is in, what word an
 * invoice gets, how a failed charge is named. No React and no `@/` imports, so the unit
 * tests import this file directly.
 */

/** The fields these rules read; `PortalPaymentMethod` satisfies it. */
export interface MethodLike {
  type: string;
  status: string | null;
  exp_month: number | null;
  exp_year: number | null;
}

/** Year and month (1–12) of `now` in the business time zone. */
function yearMonthIn(tz: string | null | undefined, now: Date): { y: number; m: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "numeric",
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
    }).formatToParts(now);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month") };
}

/**
 * A card is good through the last day of its printed month. Computed here, in the
 * business time zone, because nothing sweeps an expired card to `invalid`.
 */
export function cardExpired(pm: MethodLike, tz?: string | null, now = new Date()): boolean {
  if (!pm.exp_month || !pm.exp_year) return false;
  const { y, m } = yearMonthIn(tz, now);
  return pm.exp_year < y || (pm.exp_year === y && pm.exp_month < m);
}

/** Why a saved method cannot be charged now; null when it can. */
export type MethodProblem = "invalid" | "expired" | "pending";

/**
 * Status values (engine): valid | expiring | expired | invalid | pending_verification.
 * `expired` also follows the printed date, because nothing sweeps a card to `expired`.
 */
export function methodProblem(
  pm: MethodLike,
  tz?: string | null,
  now = new Date(),
): MethodProblem | null {
  if (pm.status === "invalid") return "invalid";
  if (pm.status === "expired" || cardExpired(pm, tz, now)) return "expired";
  if (pm.status === "pending_verification") return "pending";
  return null;
}

/** The chip for a method problem. */
export const METHOD_PROBLEM_LABEL: Record<MethodProblem, string> = {
  invalid: "Cannot be charged",
  expired: "Expired",
  pending: "Not verified",
};

/** The chip a buyer reads on an invoice row, and its tone. */
export type BuyerInvoiceState = {
  label: "Paid" | "Due" | "Overdue" | "Processing" | "Void" | "Draft" | "Closed";
  tone: "success" | "warning" | "error" | "neutral";
};

export function buyerInvoiceState(
  inv: {
    status: string;
    amount_due_minor: number;
    due_date: string | null;
    payment_in_flight?: boolean;
  },
  now = Date.now(),
): BuyerInvoiceState {
  if (inv.status === "paid") return { label: "Paid", tone: "success" };
  if (inv.status === "voided") return { label: "Void", tone: "neutral" };
  if (inv.status === "pending") return { label: "Draft", tone: "neutral" };
  if (inv.amount_due_minor <= 0) return { label: "Paid", tone: "success" };
  if (inv.payment_in_flight) return { label: "Processing", tone: "neutral" };
  if (inv.status === "posted" || inv.status === "payment_due" || inv.status === "not_paid") {
    const overdue = inv.due_date != null && Date.parse(inv.due_date) < now;
    return overdue ? { label: "Overdue", tone: "error" } : { label: "Due", tone: "warning" };
  }
  return { label: "Closed", tone: "neutral" };
}

/**
 * Mirrors `OPEN_INVOICE_STATUSES` in src/modules/invoicing/status.ts: the statuses where the
 * engine takes money. "Pay now" on any other status is refused when pressed.
 */
export const PAYABLE_STATUSES: ReadonlySet<string> = new Set(["posted", "payment_due", "not_paid"]);

/** Pay now can open for it: owed, open, no payment moving, under the card limit. */
export function payableNow(inv: {
  status: string;
  amount_due_minor: number;
  payment_in_flight?: boolean;
  over_card_limit?: boolean;
}): boolean {
  return (
    inv.amount_due_minor > 0 &&
    PAYABLE_STATUSES.has(inv.status) &&
    !inv.payment_in_flight &&
    !inv.over_card_limit
  );
}

/** A gateway code that means the issuer refused the charge. */
const DECLINE = /declin|insufficient|expired|lost|stolen|honou?r|fraud|restricted|blocked/i;

/** "was declined" when the code says the bank refused; otherwise a plain "did not go through". */
export function failureVerb(code: string | null | undefined): string {
  return code && DECLINE.test(code) ? "was declined" : "did not go through";
}

/**
 * Receipts freeze their method words at payment time ("Visa ···4242"). Show them in the
 * portal's one card format, "Visa •••• 4242".
 */
export function normalizeMethodWords(words: string): string {
  return words.replace(/\s*(?:···|\.\.\.|…)\s*(\d{2,4})\b/g, " •••• $1");
}
