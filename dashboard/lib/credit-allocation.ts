/**
 * Spread ONE credit amount across an invoice's lines — the arithmetic behind the
 * invoice-level credit/refund dialogs.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * `POST /v1/businesses/:biz/credit_notes` takes `items[{ description, amount_minor }]`,
 * never a bare total. That is right for the API — a credit note is a document with
 * lines — but it forced the only credit-note UI we had to be the full line-by-line
 * takeover.
 *
 * So the invoice dialogs ask for a single amount and allocate it proportionally here
 * (a ₹49,026.64 credit on a ₹300,593.20 invoice lands as ₹14,871.46 / ₹17,661.72 /
 * ₹9,014.86 plus its share of IGST), leaving the takeover as the escape hatch for
 * line-level control.
 *
 * ── WHY THE TAX LINE IS JUST ANOTHER LINE ──────────────────────────────────────
 * Our invoices carry the tax as a real `kind: 'tax'` row in `invoice_line_items`
 * ("IGST (18.00%)"), and the takeover form already lists it as creditable. Allocating
 * proportionally across EVERY positive line therefore keeps the credit's tax share
 * correct by construction, and a full-amount credit reproduces each line exactly —
 * including the whole tax line. Special-casing tax here would mean re-deriving a rate
 * the invoice already states, which is the drift this codebase keeps closing.
 *
 * Largest-remainder, so the parts always sum to the requested total: rounding each
 * share half-up independently overshoots, and an over-allocated credit note trips the
 * refundable cap for a reason that has nothing to do with what the operator asked for.
 */
export interface CreditLine {
  description: string;
  amount_minor: number;
}

export function allocateAcrossLines(
  lines: ReadonlyArray<CreditLine>,
  totalMinor: number,
): CreditLine[] {
  // Non-positive lines are not creditable: a negative proration line is money we
  // already handed back, and a zero line has nothing to give.
  const positive = lines.filter((l) => l.amount_minor > 0);
  const base = positive.reduce((s, l) => s + l.amount_minor, 0);
  if (base <= 0 || totalMinor <= 0) return [];

  // At or above the invoice's own total there is nothing to apportion — credit each
  // line in full. Clamping rather than scaling up keeps us from inventing an amount
  // no line ever carried; the backend still has the final say on the cap.
  if (totalMinor >= base) {
    return positive.map((l) => ({ description: l.description, amount_minor: l.amount_minor }));
  }

  const exact = positive.map((l) => (l.amount_minor * totalMinor) / base);
  const parts = exact.map((v) => Math.floor(v));
  let short = totalMinor - parts.reduce((s, n) => s + n, 0);

  // Hand the remaining minor units to the largest fractional parts first; ties go to
  // the earlier line so the split is deterministic for a given invoice.
  const byRemainder = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < byRemainder.length && short > 0; k++) {
    parts[byRemainder[k].i] += 1;
    short -= 1;
  }

  return positive
    .map((l, i) => ({ description: l.description, amount_minor: parts[i] }))
    .filter((l) => l.amount_minor > 0); // the API requires every line positive
}

/**
 * What is still creditable against an invoice — the amount the dialogs pre-fill.
 *
 * The invoice total less the credit notes raised against THIS invoice (₹300,593.20 −
 * ₹251,566.56 = ₹49,026.64). Credit notes booked against other invoices in the same
 * billing cycle do not count, which is why the parameter is the invoice's own list.
 *
 * ⚠️ This is NOT the refundable-cash cap. That one is
 * `paid − gatewayRefunded − (refundableCNsTotal − refundableCNsPaidOut)` and lives in
 * `createRefundableCreditNoteForInvoice` (src/modules/credit-notes/service.ts), which
 * reads the payments and refunds tables. Re-deriving it here would be exactly the kind
 * of parallel calculation that previews one number and books another, so the refund
 * dialogs prefill the creditable remainder, say so, and let the engine's own message
 * through when it is lower.
 */
export function creditableRemainderMinor(
  invoiceTotalMinor: number,
  creditNotes: ReadonlyArray<{ total_minor: number; status: string }>,
): number {
  const issued = creditNotes
    .filter((cn) => cn.status !== "voided")
    .reduce((s, cn) => s + (cn.total_minor ?? 0), 0);
  return Math.max(0, invoiceTotalMinor - issued);
}

/**
 * What is still creditable on an invoice. Pre-tax credit grants are taken off `total_minor`,
 * but a credit note gives them back to the grants, so they count; their notes count by
 * their gross (`subtotal_minor`), because the grants' share is not in `total_minor`.
 */
export function invoiceCreditableMinor(
  inv: { total_minor: number; grant_credits_pre_tax_minor?: number | null },
  creditNotes: ReadonlyArray<{ total_minor: number; subtotal_minor?: number; status: string }>,
): number {
  const grants = inv.grant_credits_pre_tax_minor ?? 0;
  if (grants <= 0) return creditableRemainderMinor(inv.total_minor, creditNotes);
  return creditableRemainderMinor(
    inv.total_minor + grants,
    creditNotes.map((cn) => ({ ...cn, total_minor: cn.subtotal_minor ?? cn.total_minor })),
  );
}
