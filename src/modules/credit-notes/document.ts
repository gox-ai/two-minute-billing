import { and, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import {
  creditNotes,
  creditNoteItems,
  creditNoteDiscounts,
  customers,
  businesses,
  invoices,
  invoiceLineItems,
  appliedTaxes,
  taxRateComponents,
} from "@db/schema";
import { splitByWeight, taxComponentLabel } from "@/modules/tax/service";
// The bill-to identity rule and the address builders are IMPORTED, not re-implemented, for
// exactly the reason the shared `InvoiceDocument` shape is: this module used to keep its own
// near-identical copies, and they had already drifted — the credit-note snapshot builder
// silently dropped `line3`.
import {
  billToName,
  customerAddressLines,
  snapshotAddressLines,
  snapshotContactName,
  resolveDocumentIssuer,
  documentSeller,
  withFrozenSeller,
  printedExchangeRate,
  type InvoiceDocument,
} from "@/modules/invoicing/document";
import { customerTaxIdOf, fromFrozen } from "@/modules/invoicing/billing-snapshot";
import { resolveInvoiceCustomization, taxRegLabelFor } from "@/modules/invoicing/customization";

/**
 * Presentation model for a credit note.
 *
 * It reuses {@link InvoiceDocument} on purpose rather than defining a parallel
 * shape: a credit note prints the same artifact (seller block, bill-to, a line
 * table, a totals ladder, a status chip) and the renderers are shared. Two
 * near-identical shapes would let the PDF and HTML for credit notes drift away
 * from the invoice ones the first time either is restyled — which is exactly the
 * class of bug the dashboard totals block already had.
 *
 * Field mapping worth knowing:
 *  - `meta.status`    — credit-note vocabulary (`refund_due` / `refunded` /
 *                       `adjusted` / `voided`); `statusChip` in invoice-pdf.ts
 *                       understands both vocabularies.
 *  - `totals.amountPaidMinor`  — credit already consumed (allocated + refunded).
 *  - `totals.amountDueMinor`   — what remains AVAILABLE. The closing line is
 *                       relabelled "Amount Available" by the caller's labels,
 *                       because on a credit note the bottom line is what the
 *                       customer is still owed, not what they owe.
 *  - `subscription`, `payments` are empty: a credit note has no term and no
 *                       collection attempts.
 *  - `totals.subtotalMinor` — the note's recorded GROSS reversal, pre-tax
 *                       (`credit_notes.subtotal_minor`), NOT its cashable total.
 *  - `discountLines`  — the note's `credit_note_discounts` rows: the slices of that
 *                       gross handed back to a credit bucket instead of to the
 *                       customer. Positive magnitudes; the renderers negate them.
 *  - `taxLines`       — a DERIVED total (a credit note stores no tax column of its
 *                       own), split across the COMPONENT NAMES the credited invoice
 *                       booked — "IGST (18.00%)", not a flat "Tax". See
 *                       `creditNoteTaxTotal` and `splitCreditNoteTax`.
 */
export type CreditNoteDocument = InvoiceDocument;

/**
 * Printed label for a `credit_note_discounts` row that carries no description of its
 * own. Every writer today sets one ("Promotional Credits Returned" / "Excess Payments
 * Returned"), so this only catches an imported row whose source system said nothing —
 * and each label states the row's recorded TYPE rather than inventing an explanation.
 * The renderers' own fallback is a bare "Discount", which on a credit note would hide
 * the one fact the row exists to carry: which bucket the money went back to.
 */
const DISCOUNT_LABELS: Record<string, string> = {
  promotional_credits: "Promotional Credits Returned",
  excess_payments: "Excess Payments Returned",
  credit_grants: "Credit Grants Returned",
  prorated_credits: "Prorated Credits",
  item_level_coupon: "Discount",
  document_level_coupon: "Discount",
};

/**
 * The tax a credit note carries, DERIVED — a credit note stores no tax column, so
 * rearranging the totals identity is the only source of truth available:
 *
 *     total = sub_total − Σ discounts + tax
 *
 * Exact by construction: the writers size `subtotal_minor` net of the tax the note
 * carries precisely so it is (`creditOneInvoice`: `Σ cashable + bucketReturned −
 * taxOnNote`). A cancellation credit carries no tax line at all, so this comes out 0.
 *
 * A NULL `subtotal_minor` means "gross not recorded; it equals total_minor" — the
 * pre-0186 convention and the state of all 918 backfilled historical rows. There is no
 * ladder to rearrange on those, so the answer is 0 and no tax row prints.
 *
 * Exported so the REST read derives the number with the SAME code the PDF does, rather
 * than a second copy of the identity that can drift from it.
 */
export function creditNoteTaxTotal(
  note: { subtotalMinor: bigint | null; totalMinor: bigint },
  discounts: Array<{ amountMinor: bigint }>,
): bigint {
  if (note.subtotalMinor === null) return 0n;
  return note.totalMinor - note.subtotalMinor + discounts.reduce((s, d) => s + d.amountMinor, 0n);
}

/** One tax component the credited invoice booked, summed over its lines. */
export interface CreditedTaxComponent {
  name: string;
  rateBps: number;
  /** What the INVOICE booked for this component — the weight, never the printed figure. */
  amountMinor: bigint;
}

/**
 * The tax COMPONENTS the credited invoice booked, in the order that invoice prints them.
 *
 * A credit note stores no component names either, but it always references an invoice,
 * and that invoice's `applied_taxes` snapshotted the name and rate of every component it
 * charged (one row per component PER LINE). Grouping them back up is what lets the memo
 * say "IGST (18.00%)" instead of "Tax".
 *
 * ── WHY `applied_taxes` AND NOT THE INVOICE'S TAX LINE ITEMS ────────────────────────
 * The synthetic `kind: 'tax'` line items already carry the composed label, but they
 * exist for EXCLUSIVE tax only — inclusive tax sits inside the product lines and never
 * becomes a line of its own. `applied_taxes` records both, so an inclusive-priced
 * business gets named components too.
 *
 * ── SIGNED SUM, THEN DROP NON-POSITIVES ────────────────────────────────────────────
 * Rows are summed WITH their sign before the filter, because a proration invoice's
 * negative line carries negative tax (`allocateTaxAcrossSignedLines`): on INV-4 the
 * component's rows are +1,571.92 and −1,309.94 and the component's real weight is the
 * 261.98 they net to, not the 1,571.92 a positives-only sum would report. What the
 * filter then removes is a component that charged nothing — a zero-rated or exempt row,
 * which `computeInvoiceTax` writes with an amount of 0 purely to record the REASON.
 *
 * ── ORDER ──────────────────────────────────────────────────────────────────────────
 * `applied_taxes.created_at` is the transaction clock, so every row of an invoice shares
 * it to the microsecond and the ids are random — neither orders anything. The print
 * order is the resolver's own (`tax_rate_components.sort_order`, ties by name), so it is
 * read back through the snapshotted `tax_component_id` and applied here. That id is
 * `SET NULL` on component deletion, so a component archived since the invoice issued
 * sorts last by name — still deterministic, which is what matters when the same note is
 * rendered twice.
 */
async function creditedTaxComponents(tx: Tx, invoiceId: string): Promise<CreditedTaxComponent[]> {
  const rows = await tx
    .select({
      name: appliedTaxes.name,
      rateBps: appliedTaxes.rateBps,
      amountMinor: appliedTaxes.amountMinor,
      sortOrder: taxRateComponents.sortOrder,
    })
    .from(appliedTaxes)
    .leftJoin(taxRateComponents, eq(appliedTaxes.taxComponentId, taxRateComponents.id))
    .where(eq(appliedTaxes.invoiceId, invoiceId));
  const byComponent = new Map<string, CreditedTaxComponent & { sortOrder: number }>();
  for (const r of rows) {
    const key = `${r.name}|${r.rateBps}`;
    const acc = byComponent.get(key) ?? {
      name: r.name,
      rateBps: r.rateBps,
      amountMinor: 0n,
      sortOrder: r.sortOrder ?? Number.MAX_SAFE_INTEGER,
    };
    acc.amountMinor += r.amountMinor;
    byComponent.set(key, acc);
  }
  return [...byComponent.values()]
    .filter((c) => c.amountMinor > 0n)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ name, rateBps, amountMinor }) => ({ name, rateBps, amountMinor }));
}

/**
 * Name the derived tax total after the components the credited invoice booked, splitting
 * it between them in the PROPORTION that invoice booked them.
 *
 * A note usually credits only part of its invoice, so the component amounts cannot be
 * copied across — they have to be re-cut to the note's own total. The cut uses
 * `splitByWeight`, the SAME largest-remainder helper `computeInvoiceTax` uses to divide
 * an inclusive pool between components, so the parts sum EXACTLY to the derived total
 * and the printed ladder still adds up. Introducing a second rounding convention here is
 * how a memo ends up a paisa short of its own Total.
 *
 * FALLBACK — a flat "Tax", exactly what this file printed before — when
 * `creditedTaxComponents` comes back EMPTY. That is the detection: no `applied_taxes`
 * rows on the credited invoice at all (a row issued before per-line tax was recorded, or
 * an untaxed business), or none of them charged anything. The tax is real either way —
 * the identity says so — so the row must still print; it just cannot be named.
 *
 * A NEGATIVE total also falls back: it is not a tax that was split between components,
 * and `splitByWeight` returns zeros for a non-positive total, which would silently drop
 * money off the ladder. It prints as one honest, unnamed row instead.
 */
export function splitCreditNoteTax(
  taxTotalMinor: bigint,
  components: CreditedTaxComponent[],
): Array<{ label: string; amountMinor: bigint }> {
  if (taxTotalMinor === 0n) return [];
  if (taxTotalMinor < 0n || components.length === 0)
    return [{ label: "Tax", amountMinor: taxTotalMinor }];
  const parts = splitByWeight(
    taxTotalMinor,
    components.map((c) => c.amountMinor),
  );
  // Dropping the zero parts keeps the sum (they contribute nothing) and keeps a
  // component the note credited none of off the memo.
  return components
    .map((c, i) => ({ label: taxComponentLabel(c.name, c.rateBps), amountMinor: parts[i] ?? 0n }))
    .filter((l) => l.amountMinor !== 0n);
}

/**
 * The credit note's printed tax rows, for a caller that has the note's numbers but no
 * transaction — the REST read. Same two functions the PDF uses, in the same order, so
 * the API, the dashboard page and the printed memo cannot name the tax differently.
 */
export async function creditNoteTaxLines(
  orgId: string,
  invoiceId: string,
  taxTotalMinor: bigint,
): Promise<Array<{ label: string; amountMinor: bigint }>> {
  if (taxTotalMinor <= 0n) return splitCreditNoteTax(taxTotalMinor, []);
  return withTenant(orgId, async (tx) =>
    splitCreditNoteTax(taxTotalMinor, await creditedTaxComponents(tx, invoiceId)),
  );
}

/**
 * A credit note line's printed service period, per `credit_note.service_period_basis`.
 *
 * `showServicePeriod` alone decides WHETHER a period prints; `basis` decides WHAT it says —
 * independent gates, see both fields' docblocks in `../invoicing/customization.ts`.
 *   · `invoice_line_dates` (default) — the credited invoice line's own period. Null when
 *     that line has none (an ad-hoc credit), exactly as before this setting existed.
 *   · `credit_note_date` — the note's own issue date, always available.
 */
export function creditNoteLinePeriod(
  showServicePeriod: boolean,
  basis: "invoice_line_dates" | "credit_note_date",
  creditNoteIssuedAt: Date,
  invoiceLinePeriod: { start: Date; end: Date } | null,
): { start: Date; end: Date } | null {
  if (!showServicePeriod) return null;
  if (basis === "credit_note_date") return { start: creditNoteIssuedAt, end: creditNoteIssuedAt };
  return invoiceLinePeriod;
}

/** Assemble the presentation model for one credit note. Null when not found. */
export async function assembleCreditNoteDocument(
  orgId: string,
  businessId: string,
  creditNotePublicId: string,
): Promise<CreditNoteDocument | null> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({
        cn: creditNotes,
        invPid: invoices.publicId,
        invBillingAddress: invoices.billingAddress,
        invCustomerTaxId: invoices.customerTaxId,
        invSellerName: invoices.sellerName,
        invSellerAddress: invoices.sellerAddress,
        invSellerTaxId: invoices.sellerTaxId,
        invSellerTaxCountry: invoices.sellerTaxCountry,
        invIssuedAt: invoices.createdAt,
      })
      .from(creditNotes)
      .innerJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
      .where(
        and(eq(creditNotes.businessId, businessId), eq(creditNotes.publicId, creditNotePublicId)),
      )
      .limit(1);
    if (!row) return null;
    const cn = row.cn;

    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    const [cus] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.businessId, businessId), eq(customers.id, cn.customerId)))
      .limit(1);
    // LEFT JOIN, not inner: `invoiceLineItemId` is nullable (an ad-hoc credit line
    // reverses no specific invoice line), and an inner join would silently drop those
    // rows from the printed memo — money missing from a legal document.
    const items = await tx
      .select({ it: creditNoteItems, taxCode: invoiceLineItems.taxCode })
      .from(creditNoteItems)
      .leftJoin(invoiceLineItems, eq(creditNoteItems.invoiceLineItemId, invoiceLineItems.id))
      .where(eq(creditNoteItems.creditNoteId, cn.id))
      .orderBy(creditNoteItems.createdAt);

    // ── THE TOTALS LADDER (0186 phase 4a) ───────────────────────────────────────
    // The identity:
    //
    //     total = sub_total − Σ discounts + tax
    //
    // `credit_notes.subtotal_minor` is the GROSS reversal, pre-tax; the discount rows
    // are the slices of it routed back to a credit bucket rather than to the customer.
    // This file used to print `subtotalMinor: cn.totalMinor` and read neither, so a note
    // that reversed ₹27,918.00 and returned ₹10,000.00 to promotional credit printed as a
    // document of ₹21,143.24 with no trace of where the rest went.
    const discountRows = await tx
      .select()
      .from(creditNoteDiscounts)
      .where(eq(creditNoteDiscounts.creditNoteId, cn.id))
      .orderBy(creditNoteDiscounts.createdAt);
    // NULL `subtotal_minor` means "gross not recorded; it equals total_minor" — the
    // pre-0186 convention, and the state of all 918 backfilled historical rows. Those
    // print EXACTLY as they did before: subtotal = total, no discount rows, no tax row.
    // The whole ladder is gated on the column, not on the discount rows, because a
    // discount printed without the gross it came off would not add up — the ladder is
    // only ever built from a note that recorded all of its own terms.
    const grossRecorded = cn.subtotalMinor !== null;
    const discountLines = grossRecorded
      ? discountRows.map((d) => ({
          description: d.description ?? DISCOUNT_LABELS[d.type] ?? "Discount",
          amountMinor: d.amountMinor,
        }))
      : [];
    // Always positive in the table (the writer drops zero/negative rows); the renderers
    // negate for display, exactly as they do for the invoice's contra discount lines.
    const discountTotalMinor = discountLines.reduce((s, d) => s + d.amountMinor, 0n);
    const subtotalMinor = cn.subtotalMinor ?? cn.totalMinor;
    // DERIVED, not stored: a credit note has no tax column, and neither does it store the
    // NAMES of the components that tax was charged under. Both come back the same way —
    // the amount by rearranging the identity, the names from the invoice this note
    // references, which snapshotted them onto `applied_taxes`. See `creditNoteTaxTotal`
    // and `splitCreditNoteTax`; the fallback when the invoice has none is a flat 'Tax',
    // which is what this document printed for every note before 2026-08-25.
    const taxTotalMinor = creditNoteTaxTotal(cn, discountLines);
    const taxLines = splitCreditNoteTax(
      taxTotalMinor,
      taxTotalMinor > 0n ? await creditedTaxComponents(tx, cn.invoiceId) : [],
    );

    const consumed = cn.allocatedMinor + cn.refundedMinor;
    const available = cn.totalMinor - consumed;

    // Same identity rule as the invoice: the BILLING ADDRESS CONTACT, not the account
    // holder. A credit note reverses a specific invoice, so it must be addressed to
    // whoever that invoice was addressed to, or the two documents cannot be reconciled —
    // which is also why the SOURCE INVOICE's snapshot outranks the customer's current row
    // here, name included. See `billToName`.
    const printedName = billToName(row.invBillingAddress, cus ?? null, cn.customerId);

    const custom = resolveInvoiceCustomization(biz);

    return {
      // The alternative wording is "REFUND", for a note that returns cash rather than
      // crediting an account.
      title: custom.creditNote.title === "refund" ? "REFUND" : "CREDIT NOTE",
      // The SAME seller the credited invoice prints: the identity it froze at issue, so the
      // two documents name one seller and can be reconciled against one GSTIN.
      seller: withFrozenSeller(
        documentSeller(biz, businessId, await resolveDocumentIssuer(tx, orgId, biz), custom),
        {
          sellerName: row.invSellerName,
          sellerAddress: row.invSellerAddress,
          sellerTaxId: row.invSellerTaxId,
          sellerTaxCountry: row.invSellerTaxCountry,
        },
        custom,
      ),
      billTo: {
        id: custom.common.showCustomerId ? (cus?.publicId ?? cn.customerId) : null,
        name: printedName,
        email: cus?.email ?? null,
        // Same precedence as the invoice: the source invoice's address SNAPSHOT
        // wins, so a credit note prints the address the invoice was issued to.
        addressLines: !custom.common.showCustomerInfo
          ? []
          : row.invBillingAddress
            ? snapshotAddressLines(row.invBillingAddress, printedName)
            : cus
              ? customerAddressLines(cus, printedName)
              : [],
        // Same precedence as the invoice (GSTIN before EU VAT id) — a GST credit note
        // must carry the same buyer registration as the invoice it reverses.
        taxRegId: custom.common.showCustomerInfo
          ? fromFrozen(row.invCustomerTaxId, () => customerTaxIdOf(cus))
          : null,
        taxRegLabel: taxRegLabelFor(cus?.country),
      },
      shipTo: custom.common.showShippingInfo
        ? (() => {
            // A credit note has no shipping snapshot of its own, so this is the
            // customer's current address — stated rather than silently equated with the
            // invoice's snapshot, which is a different fact.
            const addr = cus?.shippingAddress ?? null;
            const name = snapshotContactName(addr);
            return { name, addressLines: addr ? snapshotAddressLines(addr, name) : [] };
          })()
        : { name: null, addressLines: [] },
      subscription: null,
      payments: [],
      meta: {
        number: cn.number ?? cn.publicId,
        id: cn.publicId,
        status: custom.creditNote.showStatus ? cn.status : null,
        issuedDate: cn.createdAt,
        dueDate: null,
        periodStart: null,
        periodEnd: null,
        // Reuses the invoice meta slot to print WHICH invoice was credited —
        // the single most important cross-reference on a credit note.
        poNumber: row.invPid,
        /**
         * `cn.reason` is why THIS note exists; the business note is standing text that
         * applies to every one ("Credits are non-refundable"). They answer different
         * questions, so a business setting one does not lose the other — both print,
         * reason first, separated by a blank line.
         */
        notes:
          [cn.reason, custom.creditNote.notes]
            .filter((n): n is string => !!n?.trim())
            .join("\n\n") || null,
        // "Invoice date": the date of the invoice being credited, not this note's
        // own date.
        relatedInvoiceDate: custom.creditNote.showInvoiceDate ? row.invIssuedAt : null,
        // A credit note does not list credit notes.
        creditNoteNumbers: [],
        // The rate it inherited from the invoice it credits (0228).
        exchangeRate: printedExchangeRate(custom, cn),
      },
      /**
       * The custom-fields switch lives on the INVOICES tab only, with no counterpart on
       * the Credit Notes tab — so a credit note prints none rather than borrowing the
       * invoice's setting, which would be a control the merchant never saw.
       */
      customFields: [],
      /**
       * Payment instructions print on INVOICES only: a credit note is money going the
       * other way, so telling the customer where to send a payment would be wrong on
       * the document.
       */
      paymentInstructions: [],
      // The signature is explicitly shared: it prints on invoices and credit notes
      // alike.
      signature:
        custom.signature.imageUrl || custom.signature.caption
          ? {
              imageUrl: custom.signature.imageUrl,
              caption: custom.signature.caption,
              position: custom.signature.position,
            }
          : null,
      chargeLines: items.map(({ it, taxCode }) => ({
        description: it.description,
        /**
         * The "Service period" setting on the Credit Notes tab. A credit note has no
         * subscription band, so the period it shows is the one on each credited line —
         * which is why this flag gates the LINE period here and the invoice's
         * `show_billing_period` gates the subscription band instead. See
         * `creditNoteLinePeriod` for the WHETHER/WHAT split.
         */
        period: creditNoteLinePeriod(
          custom.creditNote.showServicePeriod,
          custom.creditNote.servicePeriodBasis,
          cn.createdAt,
          it.periodStart && it.periodEnd ? { start: it.periodStart, end: it.periodEnd } : null,
        ),
        quantity: 1,
        unitAmountMinor: it.amountMinor,
        quantityDecimal: null,
        unitAmountDecimal: null,
        amountMinor: it.amountMinor,
        // Nothing to net out of the Amount column for the same reason `discountMinor` is
        // 0 below: this document has no per-line attribution to net.
        itemLevelDiscountMinor: 0n,
        // A credit note has no PER-LINE coupon attribution — it credits amounts that were
        // already discounted on the invoice it reverses, and the bucket-funded slices it
        // hands back are DOCUMENT-level (`discountLines` above). 0 keeps the per-line
        // Discount column off the printed memo.
        //
        // ⚠ The note's items are its CASHABLE lines, so they sum to `totals.totalMinor`,
        // NOT to `totals.subtotalMinor` — the gap is precisely the discount rows, which is
        // why printing them is what makes the document add up. On the change path the tax
        // the ladder states is also one of these items ("Tax reversal on credited time"):
        // `credit_note_items` records no line kind and that item carries no
        // `invoice_line_item_id`, so there is no way to tell a tax item from a supply item
        // without guessing at its amount or its wording, and a guess that misfires
        // mislabels a supply line on a legal document. Both blocks tie to the same bottom
        // line either way.
        discountMinor: 0n,
        // INHERITED from the invoice line this credits, never re-resolved from the
        // product. A GST credit note must carry the HSN/SAC of the supply it reverses,
        // and that supply was classified when the invoice issued — re-deriving it here
        // would let a later recatalogue print a credit note that disagrees with the
        // invoice it references.
        taxCode,
      })),
      discountLines,
      /**
       * EMPTY, deliberately, and not because credit notes have no discounts.
       *
       * The invoice footer names its discounts from `invoice_line_discounts`, which
       * carries the (line, coupon, stage) attribution. A note's equivalent is
       * `credit_note_discounts`, and it records the BUCKET a slice was returned to, not a
       * coupon — so there is no code to print and no line to point at. Printing a
       * "DISCOUNT" block here would have to invent both. The document-level slices it does
       * know about are already stated as `discountLines` rows in the ladder.
       */
      discountDetails: [],
      taxLines,
      roundingMinor: 0n,
      totals: {
        subtotalMinor,
        discountTotalMinor,
        taxTotalMinor,
        roundingMinor: 0n,
        withholdingMinor: 0n,
        totalMinor: cn.totalMinor,
        creditsApplied: { promotional: 0n, refundable: 0n, excess: 0n },
        // "Payments" on a credit note = credit already consumed (allocated to
        // invoices or refunded to the customer).
        amountPaidMinor: consumed,
        amountDueMinor: available,
        currency: cn.currency,
      },
    };
  });
}
