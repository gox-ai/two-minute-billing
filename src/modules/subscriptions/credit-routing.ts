/**
 * WHERE A TERM CREDIT ACTUALLY GOES — the arithmetic, with nothing else in it.
 *
 * Two decisions, both pure:
 *
 *   1. DISTRIBUTION — how one term credit is split across the several invoices that
 *      charged the credited prices (`distributeCreditAcrossInvoices`).
 *   2. ROUTING — for ONE invoice, how its share splits between relieving that invoice's
 *      debt, returning bucket-funded slices to their buckets, a cashable credit note, and
 *      a residual nothing can fund (`planOpenInvoiceCreditRouting`).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────
 * Both decisions used to live inside `proration.ts`, interleaved with the database reads
 * that feed them, which had two costs:
 *
 *   - `estimateChange` could not ask the questions. It re-derived the answers, and the
 *     re-derivation disagreed with the booking: the preview promised the WHOLE credit as
 *     balance credit where the apply spends it on the term's outstanding debt first
 *     (2026-08-31, checkout quoting "₹17,010.12 credited to your balance" on a change that
 *     delivers ₹0). Fixing that by modelling the split a second time only moves the
 *     disagreement — three definitions instead of two.
 *   - The arithmetic was not unit-testable. The bug that made this file necessary was
 *     `freedExcess` overshooting its own source (2400265 restored to the excess bucket
 *     against 2000000 ever drawn) — PURE arithmetic, which nonetheless took three attempts
 *     at a full database fixture to demonstrate because it could only be reached through
 *     `changeSubscription`. As plain numbers it is one assertion.
 *
 * So: plain bigints in, plain bigints out. NO imports — not the database, not the schema,
 * not a sibling module. Anything that needs a row read stays in the caller. That constraint
 * is the point of the file; keep it.
 *
 * `proration.ts` is the only writer of these outcomes and calls both functions;
 * `estimate.ts` calls them to predict what it will do. Neither may re-implement them.
 *
 * ── WHICH ROUTING FUNCTION: BRANCH ON INVOICE STATUS, ALWAYS ──────────────────────
 * There are two, mirroring `creditOneInvoice`'s own two branches, and they are NOT
 * interchangeable:
 *
 *     isOpenInvoiceStatus(inv.status)  →  planOpenInvoiceCreditRouting(...)
 *     otherwise (paid / part-paid)     →  routingFromFundingSplit(share, splitCreditByFunding(...))
 *
 * Passing a PAID invoice to the open function is wrong and quiet. Its promo leg is gated on
 * `outstandingMinor > 0` — correctly, because a freed promotional slice is only representable
 * ON an adjustment note and no note is written when there is nothing to adjust — so a paid
 * invoice (outstanding 0) returns `freedPromoMinor: 0` and reports that slice as
 * `strandedMinor` instead. Raised by the sibling session wiring `estimate.ts`, 2026-08-31.
 *
 * Worth being exact about the harm, because it is not the obvious one: the promo slice does
 * NOT leak into `cashableMinor`. `promoAppliedMinor` is deliberately absent from the cashable
 * cap (`refundableApplied + cashAvailable`), so on a mixed-funding shape — promo 1000000, cash
 * 2114324, credit 3114324 — this function returns `cashable 2114324 / stranded 1000000` where
 * the paid branch returns `cashable 2114324 / promotional 1000000`. `cashableMinor` agrees to
 * the unit; only the promo leg is mislabelled. So a consumer reading just `cashableMinor` is
 * unharmed, and one reporting "where did the credit go" is wrong. Promotional credit still
 * never becomes cashable, which is the invariant that actually matters.
 */

/** Minor units, always. Signed only where a residual can legitimately be zero. */
type Minor = bigint;

const ZERO: Minor = 0n;
const min = (a: Minor, b: Minor): Minor => (a < b ? a : b);
const floor0 = (a: Minor): Minor => (a > ZERO ? a : ZERO);

// ─────────────────────────────────────────────────────────────────────────────────
// 1 · DISTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────────

export interface CreditDistributionPart {
  /** Stable key — the invoice id. Only used to label the result. */
  id: string;
  /**
   * This invoice's weight in the pro-rata split: the credited base it carries. The
   * caller owns what "base" means (it is the invoice's share of the credited lines);
   * this function only needs the weights to be comparable to each other.
   */
  baseMinor: Minor;
  /**
   * The most this invoice can absorb — `due + refundable headroom + recycled credit`.
   * RECYCLED COUNTS: an invoice settled from the customer's own promotional, excess or
   * refundable balance can absorb a credit with zero cash behind it, because the routing
   * below returns those slices to their buckets instead of refusing (2026-08-31).
   *
   * A part whose capacity is <= 0 is dropped: nothing is behind it, so there is nothing
   * to credit. That is the same filter the caller's capacity map applied by only setting
   * entries it found room for.
   */
  capacityMinor: Minor;
}

export interface CreditDistribution {
  /** Fundable parts only, in input order. A part may still receive 0. */
  shares: Array<{ id: string; shareMinor: Minor }>;
  /**
   * Credit no invoice could absorb, after re-placement. DROPPED, not refused — it is
   * credit the customer has ALREADY received, and refusing would block a change over
   * money that has been handed back. This is the FIRST of the two stranding sites; the
   * routing below has its own.
   */
  unplacedMinor: Minor;
}

/**
 * Place `totalMinor` across `parts`, NEWEST INVOICE FIRST — fill the most recent supply to
 * what it can give back, then spill onto older ones, until the credit is placed.
 *
 * ── WHY NEWEST-FIRST AND NOT PRO-RATA (changed 2026-09-02) ──────────────────────
 * This was a proportional split: each invoice weighted by the base it carried, largest-
 * remainder for the rounding, then clamped to capacity with the overflow re-placed. Same
 * total, same per-invoice attribution, a different distribution. Fill-and-spill is the rule
 * instead:
 *
 *   add-on ×1 → ×4 → ×2   removed 1880.00, newest invoice holds 2820.00
 *                          → ONE note, qty 2, entirely on the NEWEST invoice
 *   add-on ×4 → ×5 → ×1   removed 3760.00, newest invoice holds only 940.00
 *                          → TWO notes — 940.00 qty 1 newest, 2820.00 qty 3 older
 *
 * The second shape is what establishes the rule — in the first, "newest first" and "the
 * newest invoice only" are indistinguishable.
 *
 * The pro-rata version was not wrong about money — the total and the per-invoice
 * attribution were identical — but it credited FRACTIONS OF A UNIT instead of whole
 * ones: a 2-of-4 cut took half a unit's value from the invoice that billed one and one and
 * a half from the invoice that billed three. Greedy removes those artefacts as a side
 * effect rather than by rounding them away.
 *
 * ── THE ORDERING CONTRACT, WHICH IS OLDER THAN THIS FUNCTION ────────────────────
 * `parts` MUST arrive oldest → newest. That is not new and not only for this: today
 * `proration.ts` takes `live[live.length - 1]` as "the newest live invoice" for the
 * non-whole-term clamp, so the last element is ALREADY load-bearing. It was undocumented
 * and rested on one `.sort()` that nothing enforced — a refactor replacing that sort with
 * a plain select would have broken the clamp silently, before any of this. Both callers
 * now order in the QUERY (`orderBy(asc(invoices.createdAt))`), so the guarantee comes from
 * where the rows come from rather than from a line an edit can drop while still compiling.
 *
 * ⚠ Until 2026-09-02 the PREVIEW did not order at all — `estimate.ts` selected and filtered
 * with no sort, taking Postgres row order. That was harmless only because a proportional
 * split is order-INDEPENDENT (the index broke a largest-remainder tie and nothing else).
 * This function is order-dependent, so preview and booking would have allocated differently
 * whenever the rows came back differently — intermittently, on money. Fixed in the same
 * commit; do not make this order-dependent again without checking both callers.
 *
 * Each part contributes at most its `capacityMinor`, and `baseMinor` decides only WHETHER it
 * participates, never how much it takes.
 *
 * ⚠ THE FIRST CUT OF THIS BOUNDED EACH TAKE BY `min(baseMinor, capacityMinor)`, reasoning that
 * an invoice cannot give back more of the credited item than it billed. That contradicts this
 * field's contract — `baseMinor` is a WEIGHT, "comparable to each other" and not necessarily an
 * absolute — and the unit tests say so plainly by passing `baseMinor: 1n` beside
 * `capacityMinor: 100000n`. In production it would have been worse than wrong-in-theory: the
 * credit being placed is GROSS while the bases are PRE-TAX, so bounding by base would have
 * stranded the tax on every distribution that spanned more than one invoice. Caught by four
 * unit tests before it left the tree.
 *
 * A part with `baseMinor <= 0` carries none of the credited supply and takes nothing — the
 * pro-rata version expressed the same rule as a zero total weight placing nothing at all, and
 * `a zero credit or no parts places nothing` pins it.
 */
export function distributeCreditAcrossInvoices(input: {
  totalMinor: Minor;
  parts: readonly CreditDistributionPart[];
}): CreditDistribution {
  const total = input.totalMinor;
  if (total <= ZERO || input.parts.length === 0) return { shares: [], unplacedMinor: ZERO };

  const fundable = input.parts.filter((p) => p.capacityMinor > ZERO);
  if (fundable.length === 0) return { shares: [], unplacedMinor: total };

  // Only invoices that carry some of the credited supply take any of it.
  const participating = fundable.filter((p) => p.baseMinor > ZERO);
  if (participating.length === 0) return { shares: [], unplacedMinor: total };

  const taken = new Map<string, Minor>();
  let remaining = total;
  // Reverse: `parts` arrive oldest → newest, so the last is the most recent supply.
  for (let k = participating.length - 1; k >= 0 && remaining > ZERO; k--) {
    const p = participating[k]!;
    const take = min(p.capacityMinor, remaining);
    taken.set(p.id, take);
    remaining -= take;
  }

  // Every fundable part is still reported, at zero where nothing reached it — the same shape
  // the pro-rata version returned, so no caller has to learn a new one.
  return {
    shares: fundable.map((p) => ({ id: p.id, shareMinor: taken.get(p.id) ?? ZERO })),
    unplacedMinor: floor0(remaining),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────
// 2 · PER-INVOICE ROUTING
// ─────────────────────────────────────────────────────────────────────────────────

export interface InvoiceCreditRouting {
  /** Reduces this invoice's outstanding debt. An ADJUSTMENT credit note. */
  adjustmentMinor: Minor;
  /** Returned to the promotional bucket. Never cashable — that is the whole rule. */
  freedPromoMinor: Minor;
  /** Returned to the excess-payments bucket. Not cashable either. */
  freedExcessMinor: Minor;
  /** Returned to the credit grants the invoice drew (G3). Never cashable. */
  freedGrantsMinor?: Minor;
  /**
   * A REFUNDABLE credit note: recycled refundable credit plus real cash. The ONLY leg
   * that is "refundable credit added" — a preview that reports the whole credit, or even
   * the whole overflow, over-states this on any bucket-funded invoice.
   */
  cashableMinor: Minor;
  /**
   * Credit nothing on this invoice can fund. Credited to NOBODY, deliberately — the same
   * residual the paid branch leaves on a TDS-withheld term. It is money this invoice never
   * received, so handing it over would be inventing it.
   */
  strandedMinor: Minor;
}

/**
 * Route one OPEN (payment-due / not-paid) invoice's share of a term credit.
 *
 * The rule: an open invoice's credit is an ADJUSTMENT that reduces what is owed. Past the
 * debt it is not an adjustment any more, so a partially-paid invoice takes BOTH notes — a
 * refundable credit note for the overflow past the debt, plus an adjustment note for the
 * amount still unpaid.
 *
 * The overflow past the debt is funded by whatever settled the invoice, and each source
 * gets its own money back:
 *
 *   promotional  →  the promotional bucket, at its own non-pro-rata rate (see below)
 *   excess       →  the excess-payments bucket
 *   refundable   \
 *   cash          }  ONE cashable refundable note
 *
 * ── THE PROMO SLICE IS NOT PRO-RATA, AND THAT IS ON PURPOSE ──────────────────────
 * Promotional credit is applied PRE-tax, so it funds supply the customer KEEPS while the
 * credit fits inside the taxed base. Past the base there is no retained supply left for it
 * to fund and the units being credited are the ones the promo paid for, so the answer is
 * to give that credit back. The amount is exactly the overflow past the taxed base,
 * `discountedTotal − taxedBase` — not a share of anything.
 *
 * ── THE OVERFLOW IS CAPPED BEFORE IT IS SPLIT, NOT EACH LEG AFTER ────────────────
 * The first version of this split divided by `excessApplied + refundableApplied +
 * cashAvailable` and clamped only the cashable leg, assuming `overflow <= funded` always
 * holds. It does not, and the excess leg then exceeded what the invoice ever drew — money
 * posted to a LEDGER bucket that nobody paid in. Measured: 2400265 restored against an
 * `excessApplied` of 2000000. The identity it leaned on is real but INCIDENTAL — with no
 * prior notes and no refunds, `due = taxedGross − E − R − C` makes the overflow collapse
 * to exactly `E + R + C`, promo regime included — and it is tight, with zero headroom,
 * stated nowhere the split can see. So cap first, split the capped figure, and both legs
 * are inside their own source by construction.
 */
export function planOpenInvoiceCreditRouting(input: {
  /** The note's gross for this invoice, tax reversal line included. */
  creditMinor: Minor;
  /** What this invoice still owes — `invoiceOutstanding().remainingMinor`, NOT the column. */
  outstandingMinor: Minor;
  /** The pre-tax gross credit (the supply lines, after any coupon/refund rescale). */
  discountedTotalMinor: Minor;
  /** `netBase − promotionalCreditsApplied` — the slice of this invoice that bore tax. */
  taxedBaseMinor: Minor;
  promoAppliedMinor: Minor;
  excessAppliedMinor: Minor;
  refundableAppliedMinor: Minor;
  /** `refundableCapacityForInvoice().available` — cash still retained, not cash ever paid. */
  cashAvailableMinor: Minor;
}): InvoiceCreditRouting {
  const credit = input.creditMinor;
  const nil: InvoiceCreditRouting = {
    adjustmentMinor: ZERO,
    freedPromoMinor: ZERO,
    freedExcessMinor: ZERO,
    cashableMinor: ZERO,
    strandedMinor: ZERO,
  };
  if (credit <= ZERO) return nil;

  const outstanding = floor0(input.outstandingMinor);
  // Fits inside the debt → one adjustment note and nothing else happens.
  if (credit <= outstanding) return { ...nil, adjustmentMinor: credit };

  const excess = credit - outstanding;
  const overBase = input.discountedTotalMinor - floor0(input.taxedBaseMinor);
  // `outstanding > 0` because the freed slice is only representable ON a note, and no note
  // is written when there is nothing to adjust.
  //
  // ── AND CLAMPED TO THE OVERFLOW ITSELF ───────────────────────────────────────────
  // `min(…, excess)` is a NO-OP on every shape a real invoice can present, and it is here
  // anyway. Substituting the invoice identity shows why it cannot bind: with
  // `taxedBase = netBase − promo`, `taxedGross = taxedBase + bookedTax` and
  // `due = taxedGross − E − R − C`, the overflow past the debt reduces to
  //
  //     excess = overBase + (E + R + C)
  //
  // so `overBase <= excess` for as long as E, R and C are non-negative — which they are.
  // But that is an INCIDENTAL identity holding upstream of a function that cannot see it,
  // and this file exists because the last time this split leaned on exactly such an
  // identity it over-restored a ledger bucket by 400265. A grid over inconsistent inputs
  // reaches `freedPromo > excess`, and without the clamp the function then reports more
  // placed than it was given. Conservation is asserted unconditionally in
  // `test/unit/credit-routing.test.ts`; this is what makes it true.
  const freedPromo =
    outstanding > ZERO && input.promoAppliedMinor > ZERO && overBase > ZERO
      ? min(min(overBase, input.promoAppliedMinor), excess)
      : ZERO;

  const overflowRest = floor0(excess - freedPromo);
  const cashableCap = input.refundableAppliedMinor + input.cashAvailableMinor;
  const fundedRest = input.excessAppliedMinor + cashableCap;
  const attributable = min(overflowRest, fundedRest);
  const freedExcess =
    input.excessAppliedMinor > ZERO && fundedRest > ZERO
      ? (attributable * input.excessAppliedMinor) / fundedRest
      : ZERO;

  return {
    adjustmentMinor: outstanding,
    freedPromoMinor: freedPromo,
    freedExcessMinor: freedExcess,
    cashableMinor: attributable - freedExcess,
    strandedMinor: overflowRest - attributable,
  };
}

/**
 * Map the PAID branch's funding split into the same shape, so a caller asking "where does
 * this credit go" gets one answer type for either invoice status.
 *
 * Takes the split as plain numbers rather than importing `splitCreditByFunding`
 * (`cancellation-credit.ts`) — that function is already pure and already the single
 * definition of the paid-branch split; re-implementing it here would be the third
 * definition this file exists to prevent. A paid invoice has no debt to relieve, so
 * `adjustmentMinor` is always zero.
 */
export function routingFromFundingSplit(
  creditMinor: Minor,
  split: { promotional: Minor; excess: Minor; refundable: Minor; grants?: Minor },
): InvoiceCreditRouting {
  // The credit-grant slice goes back to the grants: placed, never stranded.
  const placed = split.promotional + split.excess + split.refundable + (split.grants ?? ZERO);
  return {
    adjustmentMinor: ZERO,
    freedPromoMinor: split.promotional,
    freedExcessMinor: split.excess,
    ...(split.grants ? { freedGrantsMinor: split.grants } : {}),
    cashableMinor: split.refundable,
    strandedMinor: floor0(creditMinor - placed),
  };
}

/** Sum routings across a term's invoices — what a preview quotes. */
export function totalRouting(parts: readonly InvoiceCreditRouting[]): InvoiceCreditRouting {
  return parts.reduce<InvoiceCreditRouting>(
    (acc, r) => ({
      adjustmentMinor: acc.adjustmentMinor + r.adjustmentMinor,
      freedPromoMinor: acc.freedPromoMinor + r.freedPromoMinor,
      freedExcessMinor: acc.freedExcessMinor + r.freedExcessMinor,
      // Present only when a grant slice exists, so a grant-free total keeps its shape.
      ...(acc.freedGrantsMinor || r.freedGrantsMinor
        ? { freedGrantsMinor: (acc.freedGrantsMinor ?? ZERO) + (r.freedGrantsMinor ?? ZERO) }
        : {}),
      cashableMinor: acc.cashableMinor + r.cashableMinor,
      strandedMinor: acc.strandedMinor + r.strandedMinor,
    }),
    {
      adjustmentMinor: ZERO,
      freedPromoMinor: ZERO,
      freedExcessMinor: ZERO,
      cashableMinor: ZERO,
      strandedMinor: ZERO,
    },
  );
}
