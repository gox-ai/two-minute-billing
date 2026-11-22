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
  label: "Paid" | "Due" | "Overdue" | "Processing" | "Scheduled" | "Void" | "Draft" | "Closed";
  tone: "success" | "warning" | "error" | "neutral";
};

export function buyerInvoiceState(
  inv: {
    status: string;
    amount_due_minor: number;
    due_date: string | null;
    payment_in_flight?: boolean;
    collection_scheduled_at?: string | null;
  },
  now = Date.now(),
): BuyerInvoiceState {
  if (inv.status === "paid") return { label: "Paid", tone: "success" };
  if (inv.status === "voided") return { label: "Void", tone: "neutral" };
  if (inv.status === "pending") return { label: "Draft", tone: "neutral" };
  if (inv.amount_due_minor <= 0) return { label: "Paid", tone: "success" };
  if (inv.payment_in_flight) return { label: "Processing", tone: "neutral" };
  // The bank has the notice; the debit is taken without the buyer.
  if (inv.collection_scheduled_at) return { label: "Scheduled", tone: "neutral" };
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
  collection_scheduled_at?: string | null;
  over_card_limit?: boolean;
}): boolean {
  return (
    inv.amount_due_minor > 0 &&
    PAYABLE_STATUSES.has(inv.status) &&
    !inv.payment_in_flight &&
    !inv.collection_scheduled_at &&
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

/** An invoice line in the add-method result. */
export interface OutcomeInvoice {
  id: string;
  number: string | null;
  amountMinor: number;
  currency: string;
  /** Pay now can open for it (owed, open, nothing in flight, under the card limit). */
  payable: boolean;
}

/** What adding a payment method did to the buyer's open invoices. */
export interface AddMethodOutcome {
  paid: OutcomeInvoice[];
  /** Charged, and the bank has not confirmed it yet. */
  inProgress: OutcomeInvoice[];
  /** A pre-debit notice went to the bank; the debit follows in about a day. */
  scheduled: OutcomeInvoice[];
  /** Charged and refused: the reason is our payer sentence, when there is one. */
  notCollected: Array<OutcomeInvoice & { reason: string | null }>;
  /** Owed and not charged (collection is off, an offline invoice, or the charge errored). */
  stillDue: OutcomeInvoice[];
  /** The business does not charge open invoices when a method is added. */
  collectionOff: boolean;
}

/** The invoice fields the outcome reads; `PortalInvoice` satisfies it. */
export interface OutcomeInvoiceRow {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  amount_due_minor: number;
  payment_in_flight?: boolean;
  over_card_limit?: boolean;
  last_payment_error?: { message?: string | null } | null;
}

const BANK_MUST_CONFIRM =
  "Your bank must confirm this payment. Try again, and complete the check from your bank.";

/**
 * Sort the open invoices into what happened when a method was added. `collected` is the
 * engine's per-invoice result; `invoices` is the list read AFTER the charges, so a charge
 * that errored (and is missing from `collected`) still shows as due.
 */
export function addMethodOutcome(
  collected: ReadonlyArray<{
    invoice: string;
    status: string;
    amount_minor: number;
    currency: string;
  }>,
  invoices: readonly OutcomeInvoiceRow[],
  collectionOff = false,
): AddMethodOutcome {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const out: AddMethodOutcome = {
    paid: [],
    inProgress: [],
    scheduled: [],
    notCollected: [],
    stillDue: [],
    collectionOff,
  };
  const seen = new Set<string>();
  for (const c of collected) {
    seen.add(c.invoice);
    const row = byId.get(c.invoice);
    const base: OutcomeInvoice = {
      id: c.invoice,
      number: row?.number ?? null,
      amountMinor: c.amount_minor,
      currency: c.currency,
      payable: row ? payableNow(row) : false,
    };
    if (c.status === "succeeded" || c.status === "paid_with_credit") out.paid.push(base);
    else if (c.status === "pending") out.inProgress.push(base);
    else if (c.status === "scheduled") out.scheduled.push({ ...base, payable: false });
    else
      out.notCollected.push({
        ...base,
        // A refused charge leaves the invoice owed: say how much is owed now.
        amountMinor: row?.amount_due_minor ?? c.amount_minor,
        reason:
          row?.last_payment_error?.message ??
          (c.status === "requires_action" ? BANK_MUST_CONFIRM : null),
      });
  }
  for (const i of invoices) {
    if (seen.has(i.id) || !payableNow(i)) continue;
    out.stillDue.push({
      id: i.id,
      number: i.number,
      amountMinor: i.amount_due_minor,
      currency: i.currency,
      payable: true,
    });
  }
  return out;
}

/** Nothing was charged and nothing is owed: a plain confirmation is enough. */
export function outcomeIsEmpty(o: AddMethodOutcome): boolean {
  return (
    !o.paid.length &&
    !o.inProgress.length &&
    !o.scheduled.length &&
    !o.notCollected.length &&
    !o.stillDue.length
  );
}
