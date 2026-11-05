import { eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { postEntries } from "@/modules/ledger/service";
import { isOpenInvoiceStatus } from "./status";
import { invoices, invoiceLineItems, invoiceLineDiscounts } from "@db/schema";

/**
 * ARCHIVAL invoice import (Option A). Writes the invoice + lines verbatim from
 * an external system's payload — unlike `createInvoiceFromLines`, it never runs
 * tax, collection, or (for settled history) the ledger: history is display/
 * reference data, money truth starts at cutover.
 *
 * The one exception: an OPEN imported invoice is real, collectible AR — it gets
 * an opening ledger entry (accounts_receivable ↔ opening_balance) so collection,
 * dunning and AR reports work from day one without fabricating historical
 * revenue in the new ledger.
 */
/**
 * The buyer, seller and terms a source invoice printed, in our columns' shape. `''` = the
 * source recorded none; `undefined` = the source did not say, so our column stays NULL.
 */
export interface IssueSnapshot {
  billingAddress?: Record<string, string | null>;
  customerTaxId?: string;
  sellerName?: string;
  sellerAddress?: Record<string, string | null>;
  sellerTaxId?: string;
  sellerTaxCountry?: string | null;
  priceType?: "exclusive" | "inclusive";
  netTermDays?: number | null;
  notes?: string;
  finalizedAt?: Date;
}

export async function importArchivalInvoice(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  subscriptionId?: string | null;
  number?: string | null;
  status: "paid" | "posted" | "payment_due" | "not_paid" | "voided";
  currency: string;
  subtotalMinor: number;
  totalMinor: number;
  /** Remaining collectible for open invoices (0 for settled). */
  amountDueMinor: number;
  /** Settled at the source by a write-off rather than by payment. */
  writtenOff?: boolean;
  /** What the source document froze at issue; absent fields leave our columns NULL. */
  issue?: IssueSnapshot;
  date: Date;
  dueDate?: Date | null;
  paidAt?: Date | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  lines: Array<{
    description: string;
    priceId?: string | null;
    quantity: number;
    unitAmountMinor: number;
    /** GROSS, before any discount. */
    amountMinor: number;
    /**
     * Discount attributed to this line, BOTH stages — the source's per-line discount.
     * Display/reconciliation only: it does not alter `subtotalMinor`, which the source
     * states directly (0169).
     */
    discountMinor?: number;
    /**
     * The per-stage split behind `discountMinor`, written to `invoice_line_discounts`.
     * `item_level` shares are already inside the source's `subtotalMinor`.
     */
    discounts?: Array<{
      scope: "item_level" | "document_level";
      amountMinor: number;
      couponSourceId?: string;
    }>;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    /** Omitted → recurring when priceId resolves, else one_time. */
    kind?: "recurring" | "proration" | "usage" | "one_time" | "discount" | "tax" | "rounding";
  }>;
  /**
   * Where the SOURCE's dunning ladder had already got to, for an invoice still open
   * at cutover. Omitted for settled history.
   *
   * `attempt_count` defaults to 0, so importing an open invoice without this restarts
   * our ladder from scratch: an invoice the source has already failed three times
   * would get a fresh four attempts and cancel roughly two weeks late. That is a
   * behavioural difference we manufactured, and in a parallel run it reads as an
   * engine bug.
   */
  dunning?: {
    attemptCount: number;
    nextAttemptAt?: Date | null;
    status?: string | null;
  };
  metadata: Record<string, unknown>;
  /**
   * The SOURCE document's own exchange rate (0228) and the base currency it was
   * measured against.
   *
   * Taken from the source or left null. Deliberately NOT resolved from the business's
   * CURRENT rates the way a freshly issued invoice is: this row is archival, so today's
   * rate is not the rate that applied when it was raised, and stamping one would
   * manufacture a fact about a historical document. Null reads as "not recorded", which
   * is exactly what happened.
   */
  exchangeRate?: string | number | null;
  exchangeRateBase?: string | null;
}): Promise<typeof invoices.$inferSelect> {
  const currency = input.currency.toUpperCase();
  // posted / payment_due / not_paid are finalized-but-owed → real, collectible AR.
  const collectible = isOpenInvoiceStatus(input.status);
  // Carried only for still-collectible invoices: a settled one has no ladder left to
  // resume, and stamping a position on it would be noise in the diff.
  const dunning = collectible ? input.dunning : undefined;

  /**
   * A `payment_due` invoice is one the source is still actively collecting, so it has to
   * land in a state one of our clock passes can actually SELECT. None of the three does,
   * for this shape:
   *
   *   runInvoiceDueTransitions  scans `status = 'posted'`                        (./due.ts)
   *   runDunningPass            scans `payment_due AND next_attempt_at NOT NULL` (../subscriptions/dunning.ts)
   *   sweepStrandedRetries      scans `... next_attempt_at IS NULL AND dunning_status = 'in_progress'`
   *
   * A source that leaves `next_retry_at` unset between ladder steps imports an
   * already-attempted invoice with a position (`attemptCount`) and no schedule — reachable
   * by no pass at all. It then sits owed forever: never charged, therefore no attempt and
   * no transaction, and nothing for a later `payment_succeeded` to settle. We would report
   * Payment Due on an invoice that had already been collected.
   *
   * The source's own schedule always wins; this only fills the hole when it gave none. The
   * due date (not `now`) is the default so a cutover reproduces the source's timing rather
   * than firing the whole imported book at whatever moment the import happened to run.
   *
   * A source status of `stopped` / `exhausted` / `succeeded` means the source's ladder is over
   * — paused by a human, spent, or recovered — and those legitimately carry no next retry.
   * Arming them would resume a ladder somebody deliberately ended, which is a worse failure
   * than the one this fixes: it charges a card nobody asked us to charge. Only an absent or
   * `in_progress` status leaves a hole worth filling.
   */
  const sourceLadderOver =
    dunning?.status === "stopped" ||
    dunning?.status === "exhausted" ||
    dunning?.status === "succeeded";

  const nextAttemptAt =
    dunning?.nextAttemptAt ??
    (input.status === "payment_due" && !sourceLadderOver ? (input.dueDate ?? input.date) : null);

  /**
   * Armed but statusless is the same trap one crash later: `sweepStrandedRetries` only
   * rescues a retry that died mid-claim when it reads `in_progress`, so leaving this null
   * on an armed invoice drops it back into the unreachable state at the first crash between
   * claim and outcome. Only defaulted where we did the arming — an invoice whose source
   * stated its own dunning status keeps it verbatim.
   */
  const dunningStatus =
    dunning?.status ?? (nextAttemptAt && input.status === "payment_due" ? "in_progress" : null);

  return withTenant(input.organizationId, async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customerId,
        subscriptionId: input.subscriptionId ?? null,
        publicId: publicId("inv"),
        number: input.number ?? null,
        // Stamped literally, not from `currentChannel()`: an import can be driven
        // from a script with no event context, and an archival row must never be
        // mistaken for something this system originated.
        channel: "import",
        status: input.status,
        currency,
        subtotalMinor: BigInt(input.subtotalMinor),
        totalMinor: BigInt(input.totalMinor),
        amountDueMinor: collectible ? BigInt(input.amountDueMinor) : null,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        dueDate: input.dueDate ?? null,
        paidAt: input.paidAt ?? null,
        writtenOff: input.writtenOff ?? false,
        billingAddress: input.issue?.billingAddress ?? null,
        customerTaxId: input.issue?.customerTaxId ?? null,
        sellerName: input.issue?.sellerName ?? null,
        sellerAddress: input.issue?.sellerAddress ?? null,
        sellerTaxId: input.issue?.sellerTaxId ?? null,
        sellerTaxCountry: input.issue?.sellerTaxCountry ?? null,
        priceType: input.issue?.priceType ?? null,
        netTermDays: input.issue?.netTermDays ?? null,
        notes: input.issue?.notes ?? null,
        finalizedAt: input.issue?.finalizedAt ?? null,
        attemptCount: dunning?.attemptCount ?? 0,
        nextAttemptAt: collectible ? nextAttemptAt : null,
        dunningStatus: collectible ? dunningStatus : null,
        imported: true,
        metadata: input.metadata,
        // Only when BOTH halves came from the source: a rate with no base to interpret
        // it is uninterpretable, and `invoices_exchange_rate_valid` refuses the pair.
        exchangeRate:
          input.exchangeRate != null && input.exchangeRateBase ? String(input.exchangeRate) : null,
        exchangeRateBase:
          input.exchangeRate != null && input.exchangeRateBase
            ? input.exchangeRateBase.toUpperCase()
            : null,
        // Keep the source's issue date so history sorts correctly.
        createdAt: input.date,
      })
      .returning();

    if (input.lines.length > 0) {
      const insertedLines = await tx
        .insert(invoiceLineItems)
        .values(
          input.lines.map((l) => ({
            organizationId: input.organizationId,
            businessId: input.businessId,
            invoiceId: inv!.id,
            publicId: publicId("il"),
            description: l.description,
            priceId: l.priceId ?? null,
            quantity: l.quantity,
            unitAmountMinor: BigInt(l.unitAmountMinor),
            amountMinor: BigInt(l.amountMinor),
            discountMinor: BigInt(Math.abs(l.discountMinor ?? 0)),
            kind: l.kind ?? (l.priceId ? "recurring" : "one_time"),
            periodStart: l.periodStart ?? null,
            periodEnd: l.periodEnd ?? null,
            // Same issue date as the document — a line must never look newer
            // than the invoice that carries it.
            createdAt: input.date,
          })),
        )
        .returning({ id: invoiceLineItems.id });
      // The per-(line, stage) attribution — imported rather than re-derived, so an
      // imported invoice's `subtotalMinor` is reproducible from its own rows exactly as a
      // natively-generated one is (0169). `applied_coupon_id` stays null: the source's
      // coupon id is not one of our applied-coupon rows, and inventing a link would be a
      // false FK. The scope and the amount are what the subtotal depends on.
      const shareValues = input.lines.flatMap((l, i) =>
        (l.discounts ?? [])
          .filter((d) => d.amountMinor > 0 && insertedLines[i] != null)
          .map((d) => ({
            organizationId: input.organizationId,
            businessId: input.businessId,
            invoiceId: inv!.id,
            invoiceLineItemId: insertedLines[i]!.id,
            appliedCouponId: null,
            label: d.couponSourceId ?? null,
            scope: d.scope,
            amountMinor: BigInt(d.amountMinor),
            createdAt: input.date,
          })),
      );
      if (shareValues.length > 0) await tx.insert(invoiceLineDiscounts).values(shareValues);
    }

    // Open imported invoices are live AR: post the opening entry (against the
    // opening_balance equity account, NOT revenue — historical revenue was
    // earned in the source system and must not distort post-cutover reports).
    if (collectible && input.amountDueMinor > 0) {
      await postEntries(
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: input.customerId,
          sourceType: "import",
          sourceId: inv!.publicId,
          lines: [
            {
              account: "accounts_receivable",
              direction: "debit",
              amountMinor: BigInt(input.amountDueMinor),
              currency,
              memo: "Opening AR (imported open invoice)",
            },
            {
              account: "opening_balance",
              direction: "credit",
              amountMinor: BigInt(input.amountDueMinor),
              currency,
              memo: "Opening AR (imported open invoice)",
            },
          ],
        },
        tx,
      );
    }
    return inv!;
  });
}

/** Is this invoice an imported archival row that must reject lifecycle ops? */
export async function isSettledArchivalInvoice(
  organizationId: string,
  invoiceId: string,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({ imported: invoices.imported, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    return !!row && row.imported && !isOpenInvoiceStatus(row.status);
  });
}
