/**
 * What each line of an invoice can still be credited — the per-line cap a credit-note
 * item that names a line (`invoiceLineItemPublicId`) must stay under.
 *
 * Tax-inclusive, the basis the invoice ceiling (`total − Σ notes`) and the line rule in
 * `./note-tax.ts` use: a supply line is worth its amount less its discount, plus its tax
 * when that tax was ADDED (exclusive) rather than already inside the amount. A
 * `kind = 'tax'` line is worth its own amount. Each non-voided note's items against the
 * line come off.
 *
 * Exclusive tax is held twice — inside its supply line's value and on the tax line — so
 * the two caps are netted against one pool: a tax line can take only the exclusive tax
 * not yet reversed through supply lines, and tax credited on tax lines comes off each
 * exclusive supply line pro rata to its tax.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { appliedTaxes, creditNoteItems, creditNotes, invoiceLineItems, prices } from "@db/schema";
import { lineTaxShare } from "./note-tax";
import { packLineCredits, type PackLineCredit } from "@/modules/credits/service";

export interface LineValueInput {
  kind: string;
  amountMinor: bigint;
  discountMinor: bigint;
  /** Σ applied tax on the line. */
  taxMinor: bigint;
  /** The tax is inside `amountMinor` already. */
  taxInclusive: boolean;
}

/** A line's tax-inclusive value, never negative. */
export function lineCreditValue(l: LineValueInput): bigint {
  const v =
    l.kind === "tax"
      ? l.amountMinor
      : l.amountMinor - l.discountMinor + (l.taxInclusive ? 0n : l.taxMinor);
  return v > 0n ? v : 0n;
}

export interface LineCreditable {
  publicId: string;
  description: string;
  valueMinor: bigint;
  /** Σ items of non-voided notes against the line (plus `pending`). */
  creditedMinor: bigint;
  /** What is left, signed: negative when `pending` overshoots. */
  leftMinor: bigint;
  remainingMinor: bigint;
  /** A pack line: the credit grant it sold. Its cap is the unused cost share (G3 §3.8). */
  pack?: PackLineCredit;
}

const halfUpDiv = (n: bigint, d: bigint): bigint => (n + d / 2n) / d;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Per line of the invoice, keyed by line PUBLIC id. `onlyPublicIds` limits the result;
 * `pending` (amount per line public id) counts a note not yet written, so the caller can
 * see whether it fits. Run under `lockInvoiceCredit` when the result gates a write.
 */
export async function lineCreditableAmounts(
  tx: Tx,
  inv: { id: string; businessId: string; priceType: string | null },
  onlyPublicIds?: readonly string[],
  pending?: ReadonlyMap<string, bigint>,
): Promise<Map<string, LineCreditable>> {
  const lines = await tx
    .select({
      id: invoiceLineItems.id,
      publicId: invoiceLineItems.publicId,
      description: invoiceLineItems.description,
      kind: invoiceLineItems.kind,
      amountMinor: invoiceLineItems.amountMinor,
      discountMinor: invoiceLineItems.discountMinor,
      taxBehavior: prices.taxBehavior,
    })
    .from(invoiceLineItems)
    .leftJoin(prices, eq(prices.id, invoiceLineItems.priceId))
    .where(eq(invoiceLineItems.invoiceId, inv.id));
  if (lines.length === 0) return new Map();
  const taxRows = await tx
    .select({
      lineId: appliedTaxes.invoiceLineItemId,
      rateBps: appliedTaxes.rateBps,
      amountMinor: appliedTaxes.amountMinor,
    })
    .from(appliedTaxes)
    .where(eq(appliedTaxes.invoiceId, inv.id));
  const taxByLine = new Map<string, { tax: bigint; rate: bigint }>();
  for (const r of taxRows) {
    const t = taxByLine.get(r.lineId) ?? { tax: 0n, rate: 0n };
    t.tax += r.amountMinor;
    // Same rate rule as `creditedLineTaxes`: components that charged nothing add none.
    if (r.amountMinor > 0n) t.rate += BigInt(r.rateBps);
    taxByLine.set(r.lineId, t);
  }

  // Exclusive tax becomes `kind = 'tax'` lines; inclusive tax does not. When the
  // invoice is all one or the other the tax lines say which; only a mixed invoice
  // falls back to the price's own setting.
  const taxLinesMinor = lines
    .filter((l) => l.kind === "tax")
    .reduce((s, l) => s + l.amountMinor, 0n);
  const appliedMinor = lines
    .filter((l) => l.kind !== "tax")
    .reduce((s, l) => s + (taxByLine.get(l.id)?.tax ?? 0n), 0n);
  const inclusiveOf = (taxBehavior: string | null): boolean =>
    taxLinesMinor === 0n
      ? true
      : taxLinesMinor >= appliedMinor
        ? false
        : inv.priceType === "inclusive" || taxBehavior === "inclusive";

  const credited = await tx
    .select({ lineId: creditNoteItems.invoiceLineItemId, amountMinor: creditNoteItems.amountMinor })
    .from(creditNoteItems)
    .innerJoin(creditNotes, eq(creditNotes.id, creditNoteItems.creditNoteId))
    .where(
      and(
        inArray(
          creditNoteItems.invoiceLineItemId,
          lines.map((l) => l.id),
        ),
        ne(creditNotes.status, "voided"),
      ),
    );
  const creditedByLine = new Map<string, bigint>();
  for (const c of credited)
    if (c.lineId)
      creditedByLine.set(c.lineId, (creditedByLine.get(c.lineId) ?? 0n) + c.amountMinor);

  const rows = lines.map((l) => {
    const t = taxByLine.get(l.id) ?? { tax: 0n, rate: 0n };
    const isTax = l.kind === "tax";
    const exclusiveTax = !isTax && t.tax > 0n && !inclusiveOf(l.taxBehavior) ? t.tax : 0n;
    const creditedMinor = (creditedByLine.get(l.id) ?? 0n) + (pending?.get(l.publicId) ?? 0n);
    return {
      l,
      isTax,
      exclusiveTax,
      creditedMinor,
      valueMinor: lineCreditValue({
        kind: l.kind,
        amountMinor: l.amountMinor,
        discountMinor: l.discountMinor ?? 0n,
        taxMinor: t.tax,
        taxInclusive: exclusiveTax === 0n,
      }),
      // Tax this line's credits already reversed under the line rule.
      taxReversed:
        exclusiveTax > 0n
          ? lineTaxShare({
              amountMinor: creditedMinor,
              rateBps: t.rate,
              bookedTaxMinor: exclusiveTax,
              isTaxLine: false,
            })
          : 0n,
    };
  });
  const exclusivePool = rows.reduce((s, r) => s + r.exclusiveTax, 0n);
  const viaSupply = rows.reduce((s, r) => s + r.taxReversed, 0n);
  const viaTaxLines = rows.filter((r) => r.isTax).reduce((s, r) => s + r.creditedMinor, 0n);
  const poolLeft = taxLinesMinor - viaSupply - viaTaxLines;

  const wanted = onlyPublicIds ? new Set(onlyPublicIds) : null;
  const packs = await packLineCredits(tx, {
    businessId: inv.businessId,
    invoiceId: inv.id,
    lines: lines.filter((l) => l.kind !== "tax"),
  });
  return new Map(
    rows
      .filter((r) => !wanted || wanted.has(r.l.publicId))
      .map((r) => {
        const own = r.valueMinor - r.creditedMinor;
        let leftMinor = r.isTax
          ? min(own, poolLeft)
          : r.exclusiveTax > 0n && exclusivePool > 0n
            ? own - halfUpDiv(viaTaxLines * r.exclusiveTax, exclusivePool)
            : own;
        // A pack line credits at most its unused cost, with that share of its tax.
        const pack = packs.get(r.l.id);
        if (pack) {
          const basis = pack.grant.costBasisMinor;
          const packCap = basis > 0n ? halfUpDiv(r.valueMinor * pack.unusedCostMinor, basis) : 0n;
          leftMinor = min(leftMinor, packCap - (pending?.get(r.l.publicId) ?? 0n));
        }
        return [
          r.l.publicId,
          {
            publicId: r.l.publicId,
            description: r.l.description,
            valueMinor: r.valueMinor,
            creditedMinor: r.creditedMinor,
            leftMinor,
            remainingMinor: leftMinor > 0n ? leftMinor : 0n,
            ...(pack ? { pack } : {}),
          },
        ];
      }),
  );
}

/** The cost a credit of `amountMinor` (tax-inclusive) takes off a pack line worth `valueMinor`. */
export function packNetOf(amountMinor: bigint, valueMinor: bigint, pack: PackLineCredit): bigint {
  if (valueMinor <= 0n) return 0n;
  const net = halfUpDiv(amountMinor * pack.grant.costBasisMinor, valueMinor);
  return net < pack.unusedCostMinor ? net : pack.unusedCostMinor;
}
