/**
 * WHERE A CHANGE'S CREDIT WENT, in words — one definition for all three surfaces.
 *
 * The change dialog keeps its charges table PURE (charges only, `Total` = gross charges)
 * and states the credit in a separate prose section naming the amount, the type, the
 * period and the destination:
 *
 *     Credits
 *     An unpaid invoice #58 is present for the billing cycles (31-Aug-2025 00:00 -
 *     29-Sep-2025 23:59). Prorated Adjustment Credits (525,00 €) will be created for the
 *     unused period of 31-Aug-2025 00:00 - 29-Sep-2025 23:59 and will be adjusted against
 *     the due amount.
 *
 * So the invoice ladder subtracts only `credit_applied_to_this_invoice_minor` and the
 * GROSS note moves out of the ladder into these sentences. The buyer's checkout, the operator's rail and the confirm dialog all read
 * this function, because the previous arrangement — the same label computed three times — is
 * what let one screen say ₹44,368.00 where another said −₹752.00, and what let a third claim
 * ₹71,654.32 of credit applied where the routing applied ₹66,566.31.
 *
 * ── WHY A MODULE AND NOT A COMPONENT ─────────────────────────────────────────────────
 * The storefront tree and the dashboard tree format money differently and render different
 * primitives, so the shared part is the ARITHMETIC AND THE WORDING, not the markup. Each
 * caller passes its own formatters and renders the returned strings.
 *
 * ── ITERATE `credit_destinations`, NEVER RECONSTRUCT ─────────────────────────────────
 * The engine reports one typed entry per slice, and they sum to `credit_note_total_minor`
 * BY CONSTRUCTION (asserted per-fixture by `creditLegsAccountForTheNote`). So prose built by
 * iterating them cannot leave an unnamed remainder — which is the whole reason the scalars
 * were replaced. Never infer a slice's KIND from which scalar is non-zero either: one change
 * can raise both an adjustment and a refundable note, and that is exactly the shape an
 * inference mislabels.
 */

/** One typed slice of the credit note, as the engine reports it. */
export interface CreditDestinationEntry {
  kind: "adjustment" | "refundable" | "bucket_restore" | "stranded";
  destination: "open_invoice" | "this_invoice" | "balance" | "payment_method" | "buckets" | "none";
  amount_minor: number;
  /** The printed invoice number an `adjustment` cancelled, e.g. `INV-58`. */
  invoice?: string;
}

/** Everything the Credits section needs, in either casing the two trees use. */
export interface CreditNarrative {
  grossMinor: number;
  destinations: CreditDestinationEntry[];
  periodStart?: string;
  periodEnd?: string;
}

export function creditNarrativeFromPreview(p: {
  creditNoteTotalMinor?: number;
  creditDestinations?: CreditDestinationEntry[];
  creditedPeriodStart?: string;
  creditedPeriodEnd?: string;
}): CreditNarrative {
  return {
    grossMinor: p.creditNoteTotalMinor ?? 0,
    destinations: p.creditDestinations ?? [],
    periodStart: p.creditedPeriodStart,
    periodEnd: p.creditedPeriodEnd,
  };
}

/** Snake-case twin, for the operator surfaces reading the API shape directly. */
export function creditNarrativeFromEstimate(e: {
  credit_note_total_minor?: number;
  credit_destinations?: CreditDestinationEntry[];
  credited_period_start?: string;
  credited_period_end?: string;
}): CreditNarrative {
  return {
    grossMinor: e.credit_note_total_minor ?? 0,
    destinations: e.credit_destinations ?? [],
    periodStart: e.credited_period_start,
    periodEnd: e.credited_period_end,
  };
}

/**
 * What the reported destinations fail to account for.
 *
 * 0 in a healthy response — the engine asserts conservation on every fixture that issues a
 * note. Computed anyway because these sentences OPEN with the gross and then claim to place
 * all of it: a silent residue would make the section sum to less than its own first figure,
 * with nothing on screen revealing it.
 *
 * ⚠ NOT floored at 0. A negative residue means the destinations OVERSTATE the note, which is
 * the more dangerous direction and must not be hidden behind a `Math.max`.
 */
export function creditResidueMinor(n: CreditNarrative): number {
  return n.destinations.reduce((rest, d) => rest - d.amount_minor, n.grossMinor);
}

/** How a slice is DESCRIBED — the type named, and the type is not the destination. */
function kindWord(kind: CreditDestinationEntry["kind"]): string {
  switch (kind) {
    case "adjustment":
      return "adjustment credits";
    case "refundable":
      return "refundable credits";
    case "bucket_restore":
      return "credits";
    case "stranded":
      return "credits";
  }
}

/**
 * The Credits section, as sentences: what was created and over what window, then one
 * sentence per slice saying where it went and what it is called.
 *
 * `fmt` renders one minor-unit amount in the caller's currency; `fmtWhen` renders an ISO
 * instant in the business timezone. The storefront and the dashboard do both differently and
 * neither belongs in here. `fmtWhen` omitted ⇒ the period clause is dropped rather than
 * rendered raw.
 *
 * `audience` shifts person, not substance: the buyer reads "your unpaid invoice", the
 * operator "the customer's". Both state the same arithmetic, so the surfaces stay diffable.
 *
 * Returns [] when there is no note, so a caller can gate the section on `.length`.
 */
export function creditLegSentences(
  n: CreditNarrative,
  fmt: (minor: number) => string,
  opts: { audience?: "buyer" | "operator"; fmtWhen?: (iso: string) => string } = {},
): string[] {
  if (n.grossMinor <= 0) return [];
  const buyer = (opts.audience ?? "buyer") === "buyer";
  const when = opts.fmtWhen;
  const out: string[] = [];

  // OPENS WITH THE GROSS AND THE WINDOW. The ladder above deliberately no longer
  // shows the note's face value, so this sentence is the only place it appears — dropping it
  // when a single slice takes the whole note would make a fully-credited change look as if it
  // credited only the part that happened to fit.
  const period =
    when && n.periodStart && n.periodEnd
      ? ` for the unused period ${when(n.periodStart)} – ${when(n.periodEnd)}`
      : " for the unused period";
  out.push(`${fmt(n.grossMinor)} in credits will be created${period}.`);

  // OPEN-INVOICE SLICES FIRST. They never become spendable, so a reader who stops after one
  // sentence should meet the constraint rather than the good news.
  const order: Record<CreditDestinationEntry["destination"], number> = {
    open_invoice: 0,
    this_invoice: 1,
    balance: 2,
    payment_method: 3,
    buckets: 4,
    none: 5,
  };
  for (const d of [...n.destinations].sort((a, b) => order[a.destination] - order[b.destination])) {
    if (d.amount_minor <= 0) continue;
    const amt = fmt(d.amount_minor);
    const word = kindWord(d.kind);
    switch (d.destination) {
      case "open_invoice":
        // Name the invoice. `d.invoice` is the PRINTED number; without it the sentence
        // still has to say the debt was cleared, so the clause is conditional, not the row.
        out.push(
          buyer
            ? `${amt} of prorated ${word} is adjusted against your unpaid invoice${d.invoice ? ` ${d.invoice}` : ""}, clearing what you owed on it.`
            : `${amt} of prorated ${word} is adjusted against the term's unpaid invoice${d.invoice ? ` ${d.invoice}` : ""}. This clears the debt. It is not a refund.`,
        );
        break;
      case "this_invoice":
        out.push(`${amt} of prorated ${word} is applied to the invoice above.`);
        break;
      case "balance":
        out.push(
          buyer
            ? `${amt} of prorated ${word} is added to your balance and spent at your next renewal.`
            : `${amt} of prorated ${word} lands on the customer's balance and is spent at the next renewal.`,
        );
        break;
      case "payment_method":
        out.push(
          buyer
            ? `${amt} is refunded to your payment method.`
            : `${amt} is refunded to the card or bank account that paid. It does not stay as credit.`,
        );
        break;
      case "buckets":
        // Real value, but it cannot offset this invoice — so never folded into the balance
        // sentence. A buyer told "added to your balance" who then finds it spendable only as
        // promotional credit has been misinformed.
        out.push(
          buyer
            ? `${amt} returns to the promotional and excess credit it was originally paid from.`
            : `${amt} returns to the promotional/excess buckets that funded it.`,
        );
        break;
      case "none":
        // ⚠ UNTESTED BRANCH. No fixture produces a stranded slice, so conservation is measured
        // on four of the five kinds (recorded as an open gap in docs/PROGRESS.md). Kept because
        // omitting it is strictly worse — a section that opens with a gross figure and silently
        // drops a slice stops adding up — but it carries less assurance than its neighbours.
        out.push(
          buyer
            ? `${amt} could not be applied to anything on your account.`
            : `${amt} could not be placed on any invoice or bucket.`,
        );
        break;
    }
  }

  // A residue is an ENGINE disagreement, not a rendering choice, and it is stated on screen
  // rather than swallowed. The alternative is a section whose sentences sum to less than the
  // figure they opened with and no way for a reader to tell.
  const residue = creditResidueMinor(n);
  if (residue !== 0) {
    out.push(
      `${fmt(Math.abs(residue))} of this credit is ${residue > 0 ? "unaccounted for" : "double-counted"}. Check this change before you use the figures above.`,
    );
  }

  return out;
}
