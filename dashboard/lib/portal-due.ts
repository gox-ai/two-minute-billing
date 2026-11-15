// What the portal header says the buyer owes. Pure, so the rule is unit-tested.

/** The fields of a portal invoice (`PortalInvoice`) that decide what is owed. */
export interface DueInvoice {
  status: string;
  currency: string;
  amount_due_minor: number;
  due_date: string | null;
  payment_in_flight?: boolean;
}

/** One outstanding balance per currency — a business may bill the same buyer in more than one. */
export interface DueTotal {
  currency: string;
  minor: number;
  count: number;
  /** Earliest due date across the open invoices in this currency. */
  earliest: string | null;
  overdue: boolean;
}

/**
 * What is still owed. An invoice whose payment is already in progress is left out: that money
 * is being collected, so it is neither "due" nor a reason to save a payment method.
 */
export function summarizeDue(invoices: DueInvoice[]): DueTotal[] {
  return summarize(invoices.filter((i) => !i.payment_in_flight));
}

/** The invoices whose payment the bank or provider is still confirming. */
export function summarizeInFlight(invoices: DueInvoice[]): DueTotal[] {
  return summarize(invoices.filter((i) => i.payment_in_flight));
}

function summarize(invoices: DueInvoice[]): DueTotal[] {
  const now = Date.now();
  const byCurrency = new Map<string, DueTotal>();
  for (const inv of invoices) {
    // A pending invoice is still open for lines (a held renewal waits for late usage): not owed yet.
    if (inv.amount_due_minor <= 0 || inv.status === "pending") continue;
    const t = byCurrency.get(inv.currency) ?? {
      currency: inv.currency,
      minor: 0,
      count: 0,
      earliest: null,
      overdue: false,
    };
    t.minor += inv.amount_due_minor;
    t.count += 1;
    if (inv.due_date && (t.earliest === null || inv.due_date < t.earliest))
      t.earliest = inv.due_date;
    if (inv.due_date && Date.parse(inv.due_date) < now) t.overdue = true;
    byCurrency.set(inv.currency, t);
  }
  return [...byCurrency.values()].sort((a, b) => b.minor - a.minor);
}
