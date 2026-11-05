/**
 * Credit notes (E4 / CN-1..2, INV-4).
 *
 * Two kinds:
 *  - ADJUSTMENT — reduces an UNPAID invoice's balance; ledger dr credit_adjustments
 *    (or bad_debt for a write-off) / cr accounts_receivable. Self-allocates to that
 *    invoice; a fully-adjusting CN zeroes the invoice → `paid`.
 *  - REFUNDABLE — credits the customer's `refundable_credit_balance` (dr
 *    credit_adjustments / cr refundable_credit_balance). Its credit can be REFUNDED
 *    to the card (`refundCreditNote`) or ALLOCATED to invoices (auto, FIFO, as the
 *    bucket is drawn at generation).
 *
 * INVARIANT (enforced everywhere): total = allocated + refunded + available.
 *
 * CN-2 refund flow: refunding a payment on a CREDIT-CONSUMING invoice must not
 * silently burn the customer's credit. `refundInvoiceViaCreditNote` refunds the
 * CARD portion (gateway refund) and RESTORES the credit portion as a fresh
 * refundable CN (credit back to the bucket).
 */
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { withTenant, withTenantTx, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { currentChannel } from "@/platform/event-context";
import { postEntries } from "@/modules/ledger/service";
import { refundPayment, RefundError, refundGatewayAccount } from "@/modules/refunds/service";
import { recordTransaction, setTransactionStatus } from "@/modules/transactions/service";
import { emitEvent } from "@/modules/events/emit";
import { loadCustomerPublicId } from "@/modules/customers/serialize";
import { loadInvoicePublicId } from "@/modules/invoicing/serialize";
import { buildEventData } from "@/modules/events/registry";
import {
  PROMOTIONAL_CREDIT,
  EXCESS_PAYMENT,
  REFUNDABLE_CREDIT,
  lockCustomerBalances,
  bucketBalance,
  emitCustomerChanged,
} from "@/modules/customers/balances";
import { accountHolderName } from "@/modules/customers/names";
import { inheritedInvoiceRate } from "@/modules/invoicing/exchange-rate";
// The SQL mirror of `accountHolderName` — the `customer_name` filter has to match the
// name this list PRINTS, not the deprecated `customers.name` column.
import { accountHolderNameSql } from "@/modules/customers/name-sql";
import { scanBusinessFilter, stampNow, businessNow } from "@/platform/clock";
import {
  isOpenInvoiceStatus,
  dunningFieldsOnSettle,
  dunningFieldsOnCreditSettle,
} from "@/modules/invoicing/status";
import {
  creditNotes,
  creditNoteItems,
  creditNoteAllocations,
  creditNoteDiscounts,
  invoices,
  payments,
  refunds,
  ledgerEntries,
  businesses,
  transactions,
  customers,
  invoiceLineItems,
  subscriptions,
  appliedTaxes,
} from "@db/schema";
import { creditNoteTaxShare, type CreditedLineTax } from "./note-tax";
import { lineCreditableAmounts, packNetOf, type LineCreditable } from "./line-cap";
import { formatMoney } from "@/platform/currency";
import {
  resolveInvoiceCustomization,
  composeDocumentNumber,
} from "@/modules/invoicing/customization";
// `creditNoteAvailable`/`CreditNoteView` moved to `./serialize` (events/content.ts
// needs them and must never import this file — it imports `emitEvent`, closing
// the serialize → service → events/emit → events/content cycle). Re-exported
// here so existing importers of `credit-notes/service` are unaffected.
import { creditNoteAvailable, creditNoteSpendable, type CreditNoteView } from "./serialize";
import {
  clampLimit,
  documentNumberSortKey,
  filterConditions,
  keysetCondition,
  kindsFromSpecs,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedTotal,
} from "@/platform/list-query";
import { businessTimezone } from "@/platform/business-tz";
import { createLogger } from "@/platform/logger";

const log = createLogger("credit-notes");
export { creditNoteAvailable, creditNoteSpendable, type CreditNoteView };

type CreditNote = typeof creditNotes.$inferSelect;

/**
 * SET-3: assign the next human-readable CN number from the business's
 * credit_note_prefix + credit_note_next_number, formatted by the business's credit-note
 * numbering config (0239). Mirrors `nextInvoiceNumber` exactly, including WHY the config
 * read and the counter bump are separate statements — see that function's header.
 */
async function nextCreditNoteNumber(
  tx: Tx,
  businessId: string,
  at: Date = businessNow(businessId),
): Promise<string> {
  const [cfg] = await tx
    .select({ customization: businesses.invoiceCustomization, timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const numbering = resolveInvoiceCustomization({
    invoiceCustomization: cfg?.customization,
  }).creditNoteNumbering;

  const [b] = await tx
    .update(businesses)
    .set({
      creditNoteNextNumber: sql`${businesses.creditNoteNextNumber} + ${numbering.increment}`,
    })
    .where(eq(businesses.id, businessId))
    .returning({ prefix: businesses.creditNotePrefix, next: businesses.creditNoteNextNumber });
  return composeDocumentNumber({
    prefix: b!.prefix,
    counter: b!.next - BigInt(numbering.increment),
    numbering,
    at,
    timezone: cfg?.timezone ?? "UTC",
  });
}

export class CreditNoteError extends Error {
  /**
   * STRUCTURAL discriminator for the refusals that mean "the credit note you named does
   * not exist in this business" rather than "your request is wrong". Routes map
   * `'not_found'` to 404 and every other `CreditNoteError` to 400 — see
   * `credit-note-routes.ts`. Deliberately a field rather than a `No such …` message
   * prefix: `scripts/verify-bola.ts` pins the status of these routes, and a string match
   * would silently re-break the moment someone rephrased the message.
   *
   * Only the CREDIT-NOTE path-parameter lookups carry it. `No such invoice: …` stays a
   * 400 on purpose: the invoice arrives in the request BODY of `POST …/credit_notes`, so
   * it is a bad body field (what Stripe answers there too), not a missing addressed
   * resource.
   *
   * `undefined` (the default) = a genuine bad request. Keep it that way: widening this
   * to cover a validation refusal ("You can refund only a refundable credit note",
   * "Refund amount must be positive") would turn a 400 into a 404 and destroy the error
   * contract while leaving every gate green.
   */
  readonly code?: "not_found";
  constructor(message: string, code?: "not_found") {
    super(message);
    this.name = "CreditNoteError";
    this.code = code;
  }
}

export interface CreditNoteItemInput {
  description: string;
  amountMinor: number;
  /**
   * Public id (`il_…`) of the invoice line being credited. Optional, but when
   * supplied the credit-note item inherits that line's SERVICE PERIOD — which is
   * printed under each item, and the only way a prorated credit can say which period
   * it reversed.
   *
   * The link is `reference_line_item_id` on the credit-note line, and it is a LINE id —
   * `entity_type`/`entity_id` point at the price, not the line.
   */
  invoiceLineItemPublicId?: string | null;
  /**
   * The window this item CREDITS — not the window the source line billed.
   *
   * The two differ on every mid-term credit, and inheriting the source line's period
   * records the wrong one. Measured 2026-08-31: a plan change on day 6 of a 31-day term
   * (billed 31-Aug → 25-Sep) produces an adjustment note whose line carries
   * `date_from` = the CHANGE date and `date_to` = the term end — the 26 days handed
   * back, not the 31 days billed. Our own INR data (sub_XXXXXXXXXXXXXXXXXXXXXX01,
   * CN-1741) shows the failure both ways: items that resolved a source line stamped the
   * whole term, and items on the change path stamped nothing at all.
   *
   * Passed EXPLICITLY because only the caller knows it: the proration engine computes the
   * window when it cuts the amounts, and no amount of reading the invoice can recover it.
   * OMIT IT and the item falls back to the source line's period, which is the pre-2026-08-31
   * behaviour and still correct for a full-invoice credit (a manual waiver credits exactly
   * what was billed, and we keep the billed window).
   */
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

/**
 * `credit_note.discounts[].entity_type` (0186) — DB CHECK-constrained. Only the
 * first two are emitted by the engine: what a bucket-funded reversal handed back to
 * the promotional / excess buckets instead of making it cashable. The rest are
 * reserved for the importer, which must be able to record an imported coupon discount
 * rather than drop it off the document.
 */
export type CreditNoteDiscountType =
  | "promotional_credits"
  | "excess_payments"
  | "credit_grants"
  | "item_level_coupon"
  | "document_level_coupon"
  | "prorated_credits";

/**
 * One row of a credit note's `discounts[]`: what was taken OFF the gross reversal
 * (`credit_notes.subtotal_minor`) and where it went. Always POSITIVE, and purely
 * DOCUMENTARY — the money movement it describes is booked by whoever returned the
 * slice (`restoreBucketFundedSlices`), never here, or the bucket would be credited
 * twice.
 */
export interface CreditNoteDiscountInput {
  type: CreditNoteDiscountType;
  amountMinor: bigint;
  /** `discounts[].description`, e.g. "Promotional Credits Returned". */
  description?: string | null;
}

/**
 * Resolve `il_…` public ids to row ids + their service periods, for the credit
 * note items to copy. Scoped to the invoice being credited. A line that is not on
 * that invoice is refused: `assertLineCaps` cannot cap it, so it would credit up to
 * the whole invoice under another line's name. Internal callers build items from the
 * invoice's own lines.
 */
async function resolveCreditedLines(
  tx: Tx,
  invoiceId: string,
  items: readonly CreditNoteItemInput[],
): Promise<Map<string, { id: string; periodStart: Date | null; periodEnd: Date | null }>> {
  const wanted = items.map((i) => i.invoiceLineItemPublicId).filter((v): v is string => Boolean(v));
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({
      id: invoiceLineItems.id,
      publicId: invoiceLineItems.publicId,
      periodStart: invoiceLineItems.periodStart,
      periodEnd: invoiceLineItems.periodEnd,
    })
    .from(invoiceLineItems)
    .where(
      and(eq(invoiceLineItems.invoiceId, invoiceId), inArray(invoiceLineItems.publicId, wanted)),
    );
  // A line from another invoice would escape the per-line cap: refuse it.
  const found = new Set(rows.map((r) => r.publicId));
  const foreign = wanted.find((pid) => !found.has(pid));
  if (foreign)
    throw new CreditNoteError(
      `We could not create the credit note. The line ${foreign} is not on this invoice. ` +
        `Use a line of the invoice that the credit note credits.`,
    );
  return new Map(
    rows.map((r) => [r.publicId, { id: r.id, periodStart: r.periodStart, periodEnd: r.periodEnd }]),
  );
}

/**
 * Refuse an item that credits more of its line than the line has left — see
 * `./line-cap.ts`. Items for one line are summed. Call before the note's insert, under
 * `lockInvoiceCredit`, so two notes on one line cannot both pass.
 */
async function assertLineCaps(
  tx: Tx,
  inv: { id: string; businessId: string; priceType: string | null; currency: string },
  items: readonly CreditNoteItemInput[],
): Promise<Array<{ pack: NonNullable<LineCreditable["pack"]>; netMinor: bigint }>> {
  const asked = new Map<string, bigint>();
  for (const i of items)
    if (i.invoiceLineItemPublicId)
      asked.set(
        i.invoiceLineItemPublicId,
        (asked.get(i.invoiceLineItemPublicId) ?? 0n) + BigInt(i.amountMinor),
      );
  if (asked.size === 0) return [];
  // `asked` counts as credited, so a supply line and its tax line in ONE note are
  // netted against each other too.
  const caps = await lineCreditableAmounts(tx, inv, [...asked.keys()], asked);
  const packVoids: Array<{ pack: NonNullable<LineCreditable["pack"]>; netMinor: bigint }> = [];
  for (const [pid, amount] of asked) {
    const cap = caps.get(pid);
    // A line not on this invoice is refused by `resolveCreditedLines`.
    if (!cap || cap.leftMinor >= 0n) continue;
    const room = cap.leftMinor + amount > 0n ? cap.leftMinor + amount : 0n;
    throw new CreditNoteError(
      `We could not create the credit note. The credit on line "${cap.description}" (${pid}) is ` +
        `${formatMoney(amount, inv.currency)}, but only ${formatMoney(room, inv.currency)} ` +
        `of that line is still creditable. Enter ${formatMoney(room, inv.currency)} or less.`,
    );
  }
  for (const [pid, amount] of asked) {
    const cap = caps.get(pid);
    if (cap?.pack)
      packVoids.push({ pack: cap.pack, netMinor: packNetOf(amount, cap.valueMinor, cap.pack) });
  }
  return packVoids;
}

/** Void the units a note's pack-line items take back (G3 §3.8, Ex 5). After the note's insert. */
async function voidPackLines(
  tx: Tx,
  packVoids: Array<{ pack: NonNullable<LineCreditable["pack"]>; netMinor: bigint }>,
  creditNotePublicId: string,
): Promise<void> {
  if (packVoids.length === 0) return;
  const { voidPackUnitsForCreditNote } = await import("@/modules/credits/service");
  for (const v of packVoids)
    await voidPackUnitsForCreditNote(tx, {
      pack: v.pack,
      netMinor: v.netMinor,
      creditNotePublicId,
    });
}

/**
 * The `tax_payable` share of a note just inserted against `inv` — see `./note-tax.ts`
 * for the two rules. Both writers call this after inserting their `credit_notes` row.
 *
 * `taxAtInvoiceRate` forces the invoice rule for a caller whose line-linked items are
 * PRE-tax amounts with the tax on a separate amount-only item (`proration.ts`'s
 * `creditOneInvoice`). The line rule reads a linked amount as tax-inclusive.
 */
async function noteTaxShare(
  tx: Tx,
  args: {
    businessId: string;
    inv: {
      id: string;
      publicId: string;
      totalMinor: bigint;
      promotionalCreditsAppliedMinor: bigint | null;
      grantCreditsPreTaxMinor?: bigint | null;
    };
    noteId: string;
    totalMinor: bigint;
    items: readonly CreditNoteItemInput[];
    taxAtInvoiceRate?: boolean;
  },
): Promise<bigint> {
  const { businessId, inv } = args;
  // Booked tax off the invoice's own ledger: drift-proof for inclusive, additive and
  // discounted invoices alike.
  const bookedTax = (
    await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.businessId, businessId),
          eq(ledgerEntries.sourceType, "invoice"),
          eq(ledgerEntries.sourceId, inv.publicId),
          eq(ledgerEntries.account, "tax_payable"),
        ),
      )
  ).reduce((s, e) => s + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
  if (bookedTax <= 0n) return 0n;
  // Tax earlier notes reversed, net of their voids. Caps the sum of every note's share
  // at what the invoice booked.
  const notes = await tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, inv.id));
  const priorPids = notes.filter((n) => n.id !== args.noteId).map((n) => n.publicId);
  const reversedTax = priorPids.length
    ? (
        await tx
          .select()
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.businessId, businessId),
              eq(ledgerEntries.account, "tax_payable"),
              inArray(ledgerEntries.sourceType, ["credit_note", "credit_note_void"]),
              inArray(ledgerEntries.sourceId, priorPids),
            ),
          )
      ).reduce((s, e) => s + (e.direction === "debit" ? e.amountMinor : -e.amountMinor), 0n)
    : 0n;
  // The denominator is the TAXED gross: pre-tax promotional credit shrank the taxable
  // base, so that slice of the total never bore tax (D-cn-cap, 2026-08-24/25).
  // Pre-tax credit grants shrank it the same way (design G3 §3.4).
  const promo = (inv.promotionalCreditsAppliedMinor ?? 0n) + (inv.grantCreditsPreTaxMinor ?? 0n);
  const creditedAfter = notes
    .filter((n) => n.status !== "voided")
    .reduce((s, n) => s + n.totalMinor, 0n);
  return creditNoteTaxShare({
    totalMinor: args.totalMinor,
    bookedTaxMinor: bookedTax,
    remainingTaxMinor: bookedTax - reversedTax > 0n ? bookedTax - reversedTax : 0n,
    taxedGrossMinor: inv.totalMinor - promo > 0n ? inv.totalMinor - promo : 0n,
    creditedAfterMinor: creditedAfter,
    lines: args.taxAtInvoiceRate ? null : await creditedLineTaxes(tx, inv.id, args.items),
  });
}

/**
 * The line rule's inputs, or null when any item is amount-only or names a line that is
 * not on this invoice — such a note does not say which supply it reverses.
 */
async function creditedLineTaxes(
  tx: Tx,
  invoiceId: string,
  items: readonly CreditNoteItemInput[],
): Promise<CreditedLineTax[] | null> {
  if (items.length === 0 || items.some((i) => !i.invoiceLineItemPublicId)) return null;
  const amountByPid = new Map<string, bigint>();
  for (const i of items) {
    const pid = i.invoiceLineItemPublicId!;
    amountByPid.set(pid, (amountByPid.get(pid) ?? 0n) + BigInt(i.amountMinor));
  }
  const lines = await tx
    .select({
      id: invoiceLineItems.id,
      publicId: invoiceLineItems.publicId,
      kind: invoiceLineItems.kind,
      amountMinor: invoiceLineItems.amountMinor,
    })
    .from(invoiceLineItems)
    .where(
      and(
        eq(invoiceLineItems.invoiceId, invoiceId),
        inArray(invoiceLineItems.publicId, [...amountByPid.keys()]),
      ),
    );
  if (lines.length !== amountByPid.size) return null;
  const rows = await tx
    .select({
      lineId: appliedTaxes.invoiceLineItemId,
      rateBps: appliedTaxes.rateBps,
      amountMinor: appliedTaxes.amountMinor,
    })
    .from(appliedTaxes)
    .where(
      and(
        eq(appliedTaxes.invoiceId, invoiceId),
        inArray(
          appliedTaxes.invoiceLineItemId,
          lines.map((l) => l.id),
        ),
      ),
    );
  return lines.map((l) => {
    // Components that charged nothing (exempt, zero-rated, reverse charge) add no rate.
    const own = rows.filter((r) => r.lineId === l.id && r.amountMinor > 0n);
    const isTaxLine = l.kind === "tax";
    return {
      amountMinor: amountByPid.get(l.publicId)!,
      rateBps: own.reduce((s, r) => s + BigInt(r.rateBps), 0n),
      bookedTaxMinor: isTaxLine ? l.amountMinor : own.reduce((s, r) => s + r.amountMinor, 0n),
      isTaxLine,
    };
  });
}

/** Guard the money invariant total = allocated + refunded + available. */
function assertInvariant(
  cn: Pick<CreditNote, "totalMinor" | "allocatedMinor" | "refundedMinor">,
): void {
  const avail = creditNoteAvailable(cn);
  if (avail < 0n || cn.allocatedMinor < 0n || cn.refundedMinor < 0n)
    throw new CreditNoteError(
      `Credit-note invariant violated: total=${cn.totalMinor} allocated=${cn.allocatedMinor} refunded=${cn.refundedMinor}`,
    );
}

async function loadInvoice(tx: Tx, businessId: string, invoicePublicId: string) {
  const [inv] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
    .limit(1);
  return inv ?? null;
}

/**
 * P4: append one audit row inside the CALLER'S transaction — every credit-note op
 * is an operator money decision, and the Activity Log drills into exactly this
 * (actor · source · IP · field-by-field diff). In-tx like `invoice.void`, so a
 * rolled-back op leaves no audit row claiming it happened.
 *
 * `before`/`after` carry ONLY the changed fields. Actor, source and IP are NOT
 * passed: they ride the ambient EventContext (src/platform/event-context.ts), so a
 * new call site cannot forget them. The import is dynamic to match the other audit
 * call sites and keep this module's static graph free of the audit module.
 */
async function auditCn(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    action: string;
    resourceType: "credit_note" | "invoice";
    resourceId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const { writeAuditLog } = await import("@/modules/audit/service");
  await writeAuditLog(input, tx);
}

// ── CN-1: adjustment credit note (reduces an unpaid invoice) ──────────────────

/**
 * Serialize credit-note ISSUE against ONE invoice — the credit-note path's equivalent of
 * `lockCustomerBalances`, scoped to the invoice because that is what the caps are read
 * against.
 *
 * Both public issue functions were read-then-act with nothing serializing the read:
 *
 *   issueRefundableCreditNote     read `refundableCapacityForInvoice` → cap → INSERT
 *   issueAdjustmentCreditNote     read `amount_due` + paid ⇒ `owed`  → cap → INSERT
 *
 * Two transactions at READ COMMITTED cannot see each other's uncommitted `credit_notes`
 * row, so both read the full capacity and both pass. `credit_notes` has no unique index
 * that could catch it afterwards (only `public_id` and `(business_id, number)`, neither of
 * which constrains the total credited against an invoice), so there was no backstop of the
 * `payments_provider_charge_uq` kind either.
 *
 * Measured on `scripts/verify-concurrent-credit-note.ts` before this lock existed, five
 * concurrent full-amount notes against one 1500 invoice:
 *   - refundable: `refundable_credit_balance` reached 7500 on 1500 of collected cash —
 *     5x the money, and `refundCreditNote` (which IS correctly locked) would have paid it
 *     out. Locking the withdrawal while leaving the mint open protects nothing.
 *   - adjustment (`write_off`): `accounts_receivable` relieved 7500 and `bad_debt` claimed
 *     7500 against a 1500 debt. `invoices.amount_due` still read 0 — each writer computed
 *     the same `collectible − total` and the last one won — so the invoice row looked
 *     perfect while the ledger was out by 6000. Only the ledger could see it.
 *
 * Issued sequentially both caps already held (both suites assert that as a control), so
 * atomicity was the whole of the defect.
 *
 * ── LOCK ORDER ────────────────────────────────────────────────────────────────────
 * Always customer-then-invoice. `cancellation-credit.ts` and `proration.ts` take
 * `lockCustomerBalances` and then call these functions with their transaction, which then
 * takes this one; neither of these functions ever takes a customer lock, so the reverse
 * order does not exist anywhere and there is no cycle to deadlock on. Advisory locks are
 * re-entrant within a transaction, so a caller that already holds this one is unaffected.
 * Transaction-scoped: released at commit/rollback.
 *
 * ⚠ **That paragraph was FALSE of `proration.ts` for as long as it existed** (corrected
 * 2026-08-31). `cancellation-credit.ts` really does take `lockCustomerBalances` first —
 * `proration.ts` took NEITHER lock, and a repo-wide grep for `lockCustomerBalances` did not
 * mention it at all. So the change path ran the same read-then-act these locks exist to
 * serialise with nothing held, and the 2026-08-31 open-invoice fix widened that by routing
 * both of `creditOneInvoice`'s branches through `createRefundableCreditNote`, which is not
 * behind this lock. `creditOneInvoice` now takes both, in this order, at its top. The
 * paragraph above is a rule, not a description — check it against the code before relying
 * on it, which is the whole lesson here: a docblock asserting an invariant is not the
 * invariant.
 */
export async function lockInvoiceCredit(tx: Tx, invoicePublicId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${invoicePublicId}::text, 7403))`,
  );
}

export async function issueAdjustmentCreditNote(input: {
  organizationId: string;
  businessId: string;
  invoicePublicId: string;
  items: CreditNoteItemInput[];
  reasonCode?: string;
  reason?: string;
  /** Note to the customer (0309). */
  customerNotes?: string;
  /**
   * Join the caller's transaction instead of opening one, so the credit note
   * commits or rolls back WITH whatever the caller is writing. `changeSubscription`
   * needs this: it applies the item change and issues the downgrade credit in one
   * unit, or the customer is left downgraded with no credit (see proration.ts).
   * Omit it and behaviour is byte-identical to before.
   */
  tx?: Tx | null;
  /**
   * `sub_total` — the GROSS this note reverses, when that is MORE than the amount
   * it takes off the invoice (0186's shape, already carried by `createRefundableCreditNote`).
   *
   * An adjustment can only relieve what is still DUE, but a credit for supply the
   * customer's PRE-TAX promotional credit paid for reverses more than that: the balance
   * goes back to the promotional bucket instead of off the bill. The caller books that
   * movement (`restoreBucketFundedSlices`) and declares it here so the document still
   * satisfies `total = sub_total − discounts + tax`. See `proration.ts`'s
   * `creditOneInvoice` and `cancellation-credit.ts`.
   *
   * OMIT IT and the column stays NULL — "gross not recorded; it equals total_minor",
   * which is how every caller before 2026-08-25 behaves.
   */
  subtotalMinor?: bigint;
  /**
   * `credit_note.discounts[]` — the bucket-funded slices taken off that gross.
   * DOCUMENTARY ONLY: nothing here posts them; the caller already did. Zero and
   * negative rows are dropped rather than written.
   */
  discounts?: CreditNoteDiscountInput[];
  /**
   * Reverse tax at the invoice's average rate even though items name lines. For items
   * that are PRE-tax with the tax on a separate amount-only item — see `noteTaxShare`.
   */
  taxAtInvoiceRate?: boolean;
}): Promise<CreditNote> {
  const { organizationId, businessId } = input;
  if (input.items.length === 0) throw new CreditNoteError("A credit note needs at least one item");
  const total = input.items.reduce((s, i) => s + BigInt(i.amountMinor), 0n);
  if (total <= 0n) throw new CreditNoteError("Credit note total must be positive");
  const isWriteOff = input.reasonCode === "write_off";

  return withTenantTx(organizationId, input.tx, async (tx) => {
    // FIRST, before `loadInvoice`: the cap below is computed from `inv.amount_due_minor`,
    // so a load that happened before the lock was granted would leave the guard deciding
    // on a stale snapshot and the race would survive being serialized. Keyed on the
    // PUBLIC id precisely so it can be taken with nothing read yet. See `lockInvoiceCredit`.
    await lockInvoiceCredit(tx, input.invoicePublicId);
    const inv = await loadInvoice(tx, businessId, input.invoicePublicId);
    if (!inv) throw new CreditNoteError(`We could not find the invoice ${input.invoicePublicId}.`);
    if (!isOpenInvoiceStatus(inv.status))
      throw new CreditNoteError(
        `Adjustment credit notes apply only to unpaid invoices. This invoice is ${inv.status}.`,
      );
    // TWO FIGURES, and conflating them is how this bug worked in BOTH directions.
    //
    // `collectible` is the column's own contract: the issue-time amount net of CREDITS
    // only, never of cash. That is what the column must go on holding — `serializeInvoice`
    // and the PDF both subtract cash from it themselves, so writing a cash-net figure here
    // makes every consumer subtract the payment twice.
    //
    // `owed` is what the customer actually still owes. An adjustment note relieves a DEBT,
    // so the cap belongs on `owed`. Capping on the column let an adjustment exceed the debt
    // and book the customer's own cash as written off or adjusted away: a 5000 invoice with
    // 3000 collected accepted a 5000 write-off, so 3000 sitting in the bank became money
    // the books claim we never received. Value past `owed` is cash, and cash comes back as
    // a REFUNDABLE note — which is what every caller now splits out before calling here
    // (invoicing/ops.ts, proration.ts x2, cancellation-credit.ts).
    const collectible = inv.amountDueMinor ?? inv.totalMinor;
    const { invoiceOutstanding } = await import("@/modules/invoicing/service");
    const { paidMinor } = await invoiceOutstanding(tx, inv);
    const owed = collectible - paidMinor > 0n ? collectible - paidMinor : 0n;
    if (total > owed)
      throw new CreditNoteError(`Adjustment ${total} exceeds the invoice's ${owed} due`);
    // AND the schema's cumulative ceiling, as a BACKSTOP — inside the lock taken above,
    // so it is serialised with the INSERT below like the `owed` cap beside it.
    //
    // ⚠ NOT the paid-amount ceiling the REFUNDABLE writer now enforces. On a 7.00 invoice
    // with 3.50 collected, an ADJUSTMENT note for the whole 3.50 still OWED and then a
    // REFUNDABLE note for the 3.50 COLLECTED are both legal — cumulative 7.00, from two
    // notes bounded separately. The two kinds answer different questions: an adjustment
    // relieves the DEBT (that is `owed`, above), a refundable returns the CASH. Applying
    // the paid-amount cap here would refuse that shape.
    //
    // So why anything more than `owed`? Because `owed` bounds this note against the debt
    // as it stands, and the invariant `db/schema/credit-notes.ts` states is about the
    // CUMULATIVE total across both kinds. The two bounds are disjoint by construction —
    // adjustments can only exist while the invoice is open and only up to `owed`,
    // refundables only up to the cash — so their sum already cannot pass the invoice
    // total, and this line should never bind. It is here so the documented invariant is
    // ENFORCED rather than inferred from two other rules holding: that inference is
    // exactly what was true of the refundable writer, and it was wrong.
    const creditableRoom = await remainingCreditableAgainstInvoice(tx, inv);
    if (total > creditableRoom)
      throw new CreditNoteError(
        `Adjustment ${total} exceeds the ${creditableRoom} still creditable against this invoice` +
          `. The invoice total is ${inv.totalMinor}, and non-voided credit notes already credit part of it.`,
      );
    // Pre-tax items (`taxAtInvoiceRate`) are spread by the engine over the whole invoice,
    // not sized to one line, so only tax-inclusive items meet the per-line cap.
    const packVoids = input.taxAtInvoiceRate ? [] : await assertLineCaps(tx, inv, input.items);

    const [cn] = await tx
      .insert(creditNotes)
      .values({
        organizationId,
        businessId,
        customerId: inv.customerId,
        invoiceId: inv.id,
        publicId: publicId("cn"),
        number: await nextCreditNoteNumber(tx, businessId),
        creditMethod: "balance",
        kind: "adjustment",
        status: "adjusted",
        channel: currentChannel(),
        reasonCode: input.reasonCode ?? null,
        subtotalMinor: input.subtotalMinor ?? null,
        totalMinor: total,
        allocatedMinor: total,
        refundedMinor: 0n,
        currency: inv.currency,
        // FX snapshot (0228), inherited from the invoice — a reversal converts at the
        // rate of the document it reverses. The row is already in hand here.
        exchangeRate: inv.exchangeRate ?? null,
        exchangeRateBase: inv.exchangeRateBase ?? null,
        reason: input.reason ?? null,
        customerNotes: input.customerNotes ?? null,
      })
      .returning();
    const bucketDiscounts = (input.discounts ?? []).filter((d) => d.amountMinor > 0n);
    if (bucketDiscounts.length > 0) {
      await tx.insert(creditNoteDiscounts).values(
        bucketDiscounts.map((d) => ({
          organizationId,
          businessId,
          creditNoteId: cn!.id,
          type: d.type,
          amountMinor: d.amountMinor,
          description: d.description ?? null,
        })),
      );
    }
    await voidPackLines(tx, packVoids, cn!.publicId);
    const creditedLines = await resolveCreditedLines(tx, inv.id, input.items);
    await tx.insert(creditNoteItems).values(
      input.items.map((it) => {
        const src = it.invoiceLineItemPublicId
          ? creditedLines.get(it.invoiceLineItemPublicId)
          : undefined;
        return {
          organizationId,
          businessId,
          creditNoteId: cn!.id,
          publicId: publicId("cni"),
          description: it.description,
          amountMinor: BigInt(it.amountMinor),
          invoiceLineItemId: src?.id ?? null,
          // The CREDITED window wins over the billed one — see `CreditNoteItemInput.periodStart`.
          // `?? null` on each half independently: a caller that knows only the start is
          // giving us half a window, and half a window is not the source line's window.
          periodStart: it.periodStart ?? src?.periodStart ?? null,
          periodEnd: it.periodEnd ?? src?.periodEnd ?? null,
        };
      }),
    );
    // Ledger: a write-off books bad debt; a plain adjustment books credit_adjustments.
    // The tax inside the note reverses `tax_payable` — see `noteTaxShare`. An adjustment
    // reduces amount DUE and hands no promotional credit back, so every unit it credits
    // comes off the taxed slice. Integer math keeps the entry balanced.
    const taxShare = await noteTaxShare(tx, {
      businessId,
      inv,
      noteId: cn!.id,
      totalMinor: total,
      items: input.items,
      taxAtInvoiceRate: input.taxAtInvoiceRate,
    });
    const net = total - taxShare;
    const lines: Array<{
      account: string;
      direction: "debit" | "credit";
      amountMinor: bigint;
      currency: string;
    }> = [
      {
        account: "accounts_receivable",
        direction: "credit",
        amountMinor: total,
        currency: inv.currency,
      },
    ];
    if (net > 0n)
      lines.push({
        account: isWriteOff ? "bad_debt" : "credit_adjustments",
        direction: "debit",
        amountMinor: net,
        currency: inv.currency,
      });
    if (taxShare > 0n)
      lines.push({
        account: "tax_payable",
        direction: "debit",
        amountMinor: taxShare,
        currency: inv.currency,
      });
    await postEntries(
      {
        organizationId,
        businessId,
        customerId: inv.customerId,
        sourceType: "credit_note",
        sourceId: cn!.publicId,
        lines,
      },
      tx,
    );
    // A written-off invoice is never paid: a credit grant it sold must not activate (G3 §3.6).
    if (isWriteOff) {
      const { voidPendingGrantsForInvoice } = await import("@/modules/credits/service");
      await voidPendingGrantsForInvoice(tx, {
        organizationId,
        businessId,
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        reason: "write_off",
      });
    }
    await tx.insert(creditNoteAllocations).values({
      organizationId,
      businessId,
      creditNoteId: cn!.id,
      invoiceId: inv.id,
      amountMinor: total,
    });
    // Reduce the invoice's balance. `newDue` follows the column's OWN contract — the
    // collectible net of CREDITS only — so subtracting just this note is right here.
    const newDue = collectible - total;
    // But "is it settled" is a question about CASH, and this column has never had cash
    // taken off it. Asking `newDue <= 0` alone reads a part-paid invoice as still owing:
    // 5000 billed, 3000 collected, 2000 credited leaves newDue = 3000 against 3000 of
    // cash — nothing is owed, yet the invoice stayed `payment_due` and a write-off never
    // set `written_off`. Measured 2026-08-26, and it only surfaced once the callers
    // stopped over-crediting; while write-off credited the full 5000 this line was right
    // by accident. A fully UNPAID invoice has paidMinor = 0 and books exactly as before.
    //
    // `paidMinor` comes from the function that owns the cash rule rather than a second
    // payments scan of our own; the import is dynamic because invoicing/service imports
    // this module (`allocateRefundableDraw`), so a static edge would close a cycle.
    const zeroed = newDue - paidMinor <= 0n;
    await tx
      .update(invoices)
      .set({
        amountDueMinor: newDue,
        ...(zeroed
          ? {
              status: "paid" as const,
              paidAt: stampNow(),
              nextAttemptAt: null,
              writtenOff: isWriteOff || inv.writtenOff,
              // NOT `dunningFieldsOnSettle` — no cash arrived. The chase STOPPED, it did
              // not succeed; see `dunningFieldsOnCreditSettle` for the reasoning and
              // for the ten live invoices that claimed a recovery that never happened.
              ...dunningFieldsOnCreditSettle(inv),
            }
          : {}),
      })
      .where(eq(invoices.id, inv.id));

    /**
     * An invoice this credit note just zeroed is PAID, and must say so.
     *
     * `invoice_paid` is a deliberate tmbilling event — a settlement signal in its own
     * right, and by the decision of 2026-07-14 it "also fires for credit-covered
     * (amount-due-0) invoices". The sibling path implements that
     * (`invoicing/ops.ts::applyCreditsToInvoice`, with the same `paid_with_credit` flag);
     * THIS path never did, so an invoice zeroed by an adjustment note went `payment_due →
     * paid` emitting only `invoice_updated`. Measured on INV-6287, 2026-09-03: a subscriber
     * tracking settlement missed it, while 37,024 cash settlements in the same
     * organization had fired correctly.
     *
     * A WRITE-OFF is excluded on purpose. It also lands on `paid` and it is also
     * credit-covered, but it is bad debt written off rather than a debt settled — it emits
     * `invoice_written_off` just below, and telling a subscriber it was paid would be the
     * same class of lie the `dunningFieldsOnCreditSettle` note above exists to prevent.
     */
    if (zeroed && !isWriteOff) {
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "invoice_paid",
        data: buildEventData(
          "invoice_paid",
          {
            id: inv.publicId,
            amount_minor: Number(inv.totalMinor),
            currency: inv.currency,
          },
          null,
          { paid_with_credit: true },
        ),
      });
    }

    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "credit_note_created",
      data: {
        credit_note: cn!.publicId,
        invoice: inv.publicId,
        kind: "adjustment",
        reason_code: input.reasonCode ?? null,
        amount_minor: Number(total),
        currency: inv.currency,
      },
    });
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "credit_note_allocated",
      data: {
        credit_note: cn!.publicId,
        invoice: inv.publicId,
        amount_minor: Number(total),
        currency: inv.currency,
      },
    });
    // The invoice's amount due just went DOWN — an adjustment note is applied to it by
    // definition — so the invoice changed and must say so. Measured 2026-08-25: cancelling
    // a term billed across two unpaid invoices must emit `invoice_updated` for BOTH (total
    // 543508 and 1075924, amount_paid 0, status payment_due), and we emitted none. The
    // refundable path already does this
    // (`createRefundableCreditNote`); the adjustment path never did, which is the half that
    // fires on every cancellation of an unpaid term.
    await emitInvoiceUpdated(tx, { organizationId, businessId, invoicePublicId: inv.publicId });
    // Write-off emits invoice.written_off in the SAME tx as the state change
    // (outbox invariant — review fix; was a separate post-commit tx in ops.ts).
    if (isWriteOff && zeroed) {
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "invoice_written_off",
        data: buildEventData("invoice_written_off", {
          id: inv.publicId,
          status: "paid",
          amount_minor: Number(total),
          currency: inv.currency,
        }),
      });
    }
    // P4 — two distinct facts, so two rows: a credit note was issued, AND (for a
    // write-off) an invoice's debt was abandoned. The write-off row hangs off the
    // INVOICE so it appears in that invoice's Activity Log, which is where the
    // operator pressed the button; `writeOffInvoice` in invoicing/ops.ts routes
    // through here precisely so both land in this one transaction.
    await auditCn(tx, {
      organizationId,
      businessId,
      action: "credit_note.create",
      resourceType: "credit_note",
      resourceId: cn!.publicId,
      before: { status: null },
      after: {
        status: cn!.status,
        kind: "adjustment",
        total_minor: Number(total),
        currency: inv.currency,
        invoice: inv.publicId,
        reason_code: input.reasonCode ?? null,
      },
    });
    if (isWriteOff) {
      await auditCn(tx, {
        organizationId,
        businessId,
        action: "invoice.write_off",
        resourceType: "invoice",
        resourceId: inv.publicId,
        before: {
          status: inv.status,
          amount_due_minor: Number(collectible),
          written_off: inv.writtenOff,
        },
        after: {
          status: zeroed ? "paid" : inv.status,
          amount_due_minor: Number(newDue > 0n ? newDue : 0n),
          written_off: zeroed ? true : inv.writtenOff,
          credit_note: cn!.publicId,
        },
      });
    }
    return cn!;
  });
}

// ── CN-2: refundable credit note (credits the refundable bucket) ──────────────

/**
 * How much NEW refundable credit an invoice can still carry, and the cash it was paid.
 *
 *   available = paid − gatewayRefunded − (refundableCNsTotal − refundableCNsPaidOut)
 *
 * Money already committed to be returned is (a) gateway refunds already made against
 * this invoice's payments and (b) outstanding refundable-CN obligations not yet paid
 * out. A refundable CN's own payout shows up in BOTH the refunds rows and its
 * `paidOutMinor`, so each committed unit is subtracted exactly once (review fix: a
 * direct `refundPayment` followed by a refundable CN otherwise double-pays). Counting
 * ACTUAL payouts (`paid_out_minor`) rather than `refunded_minor` matters too — a
 * declined payout books refunded without a refunds row, and using refunded re-inflated
 * the cap (G review blocker: 14000 committed on 10000 collected, one decline away).
 *
 * EXPORTED because callers must be able to ASK before they commit. `issueRefundableCreditNote`
 * enforces it as a hard refusal, and a refusal mid-way through a subscription change rolls
 * the whole change back — so `proration.ts` allocates a term credit only across invoices
 * with capacity left, using this same function. One definition, or the allocator and the
 * guard disagree and the operator gets "Refundable credit N exceeds refundable paid
 * amount 0" on a change that had nothing wrong with it.
 */
export async function refundableCapacityForInvoice(
  tx: Tx,
  invoiceId: string,
): Promise<{ paidMinor: bigint; available: bigint; refundedMinor: bigint }> {
  const paidPays = await tx
    .select({ id: payments.id, amountMinor: payments.amountMinor })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, "succeeded")));
  const paidMinor = paidPays.reduce((s, p) => s + p.amountMinor, 0n);
  if (paidMinor <= 0n) return { paidMinor: 0n, available: 0n, refundedMinor: 0n };
  const payIds = paidPays.map((p) => p.id);
  const gatewayRefunded = payIds.length
    ? (
        await tx
          .select({ amountMinor: refunds.amountMinor })
          .from(refunds)
          // A pending refund is accepted money out (`refundPayment` booked it); a
          // credit-note payout counts it as paid out too, so it must count here once.
          .where(
            and(
              inArray(refunds.paymentId, payIds),
              // Not found and unresolved: the note counts it paid out, so it counts here too.
              or(
                inArray(refunds.status, ["pending", "succeeded"]),
                eq(refunds.notFoundState, "open"),
              ),
            ),
          )
      ).reduce((s, r) => s + r.amountMinor, 0n)
    : 0n;
  const prior = await tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoiceId));
  const refundableCns = prior.filter((c) => c.status !== "voided" && c.kind === "refundable");
  // A note's OUTSTANDING claim on this invoice's cash is what is left after BOTH
  // allocation and refund — `total − allocated − refunded`, the same figure
  // `creditNoteAvailable` reports. Credit ALLOCATED to another invoice has been spent as
  // credit and is no longer a claim on cash; counting the note's whole total (which this
  // did until 2026-08-25) declared the invoice fully claimed forever and made its cash
  // permanently unreachable.
  //
  // Concretely: the original invoice's note had been allocated onto the re-subscribe
  // invoice, so its cash read as spoken-for and the payout could not touch it — when
  // exactly that 2114024 was payable. Clamped per note so a fully-consumed one
  // contributes 0 rather than a negative that would inflate capacity.
  const refundableCNsOutstanding = refundableCns.reduce((s, c) => {
    // A declined refund reopened as credit (2.15) keeps its claim on this invoice's cash once
    // spent as credit elsewhere: only a payout (counted above as a gateway refund) releases it.
    if (c.reasonCode === "refund_declined" && c.refundId) {
      const left = c.totalMinor - c.refundedMinor;
      return s + (left > 0n ? left : 0n);
    }
    return s + creditNoteSpendable(c);
  }, 0n);
  // `refundedMinor` is CASH HANDED BACK THROUGH THE GATEWAY, exposed because a later
  // credit for the same term has to be scaled by it — a customer who was refunded part
  // of an invoice may not then be credited the whole of it. Reported here rather than
  // re-summed at the call site for the reason the note above gives about `paid`: this
  // function owns the rule, and the twin sums drifted apart last time.
  return {
    paidMinor,
    available: paidMinor - gatewayRefunded - refundableCNsOutstanding,
    refundedMinor: gatewayRefunded,
  };
}

/**
 * THE CEILING ON AN INVOICE'S CUMULATIVE CREDIT: its own total, less every non-voided
 * credit note already written against it. Never negative.
 *
 * `db/schema/credit-notes.ts` has always claimed this invariant — "Cumulative credit
 * notes can never exceed the invoice total (enforced in the service)" — and it was not
 * enforced anywhere a term credit was PLACED. Both allocators (`creditAcrossInvoices`,
 * and the preview's mirror of it in `estimate.ts`) built capacity as
 *
 *     due + creditableCapacityForInvoice + promo/excess/refundable applied
 *
 * where the last term — `recycled`, an invoice settled with the customer's OWN credit —
 * was added raw. `creditableCapacityForInvoice` correctly reports 0 for a fully credited
 * invoice, and `recycled` then overrode it, re-offering exactly the value a full-value
 * note had already reversed. Cash-funded invoices were safe only because their `recycled`
 * is 0, which is why the earlier fix on sub_QYsquS looked complete: same defect class,
 * second door.
 *
 * MEASURED read-only on the dev database 2026-09-01: 52 invoices carried non-voided notes
 * summing past their total, ₹1,23,250.81 in aggregate, earliest 2026-08-24. INV-5511
 * (total ₹66,219.24) carried ₹76,238.26, including "Unused time on BUSINESS plan" for the
 * window 08-31 → 09-29 issued TWICE, at ₹54,247.40 and then ₹10,361.30 again.
 *
 * ⚠ THIS IS A CLAMP, NOT A NEW CAPACITY MODEL. Callers keep their own capacity
 * arithmetic and take `min(theirs, this)`. On a FIRST credit no prior notes exist, so
 * this returns the invoice total and every existing shape — including the credit-funded
 * one `recycled` exists for — is byte-identical.
 *
 * ⚠ AND NOT A REASON TO WIDEN `creditableCapacityForInvoice`. Its rule is the credit
 * question and is correct; the defect was a term added BESIDE it, not the term itself.
 * Widening it re-breaks the cross-invoice payout — see the warnings on that function and in
 * `estimate.ts`.
 */
export async function remainingCreditableAgainstInvoice(
  tx: Tx,
  inv: { id: string; totalMinor: bigint },
): Promise<bigint> {
  const prior = await tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, inv.id));
  const creditedAway = prior
    .filter((c) => c.status !== "voided")
    .reduce((s, c) => s + c.totalMinor, 0n);
  const room = inv.totalMinor - creditedAway;
  return room > 0n ? room : 0n;
}

/**
 * How much of this invoice may still be CREDITED — a different question from
 * `refundableCapacityForInvoice`, which answers how much CASH a payout may draw.
 *
 * ── WHY TWO ───────────────────────────────────────────────────────────────────
 * The two differ on ALLOCATED credit, and the difference is not cosmetic:
 *
 *   payout asks   — is this money still a claim on cash?   allocated credit is NOT
 *   credit asks   — is this invoice's value already spent?  allocated credit IS
 *
 * `refundableCapacityForInvoice` subtracts only a note's OUTSTANDING claim
 * (`total − allocated − refunded`), deliberately: counting a note's whole total declared
 * an invoice fully claimed forever and made its cash permanently unreachable when that
 * amount was genuinely payable. That rule is right and is untouched here.
 *
 * But `creditAcrossInvoices` asks the SECOND question and was handed the first, so an
 * invoice whose entire value had already been credited still looked able to absorb
 * another credit. Measured 2026-08-28 on a real subscriber: removing an add-on produced
 * TWO notes of ₹2,717.54 — one correctly allocated to the live invoice, one against
 * INV-3288, which CN-564 had already credited in full. `refundableCapacityForInvoice`
 * reported INV-3288's full ₹57,012.88 as available, because CN-564's credit had been
 * ALLOCATED elsewhere and so contributed zero. The second note had no open claim to
 * offset, so it landed as `refund_due` — a cash liability instead of a reduction of the
 * live invoice. The buyer paid ₹12,811.26 where ₹10,093.72 was due and now holds a
 * refund nobody has actioned.
 *
 * So: subtract EVERY non-voided note's total, not just its outstanding claim.
 *
 * ⚠ NOT the writer's cap, and deliberately so — see
 * `refundableCreditCeilingForInvoice`. This one counts ADJUSTMENT notes into the same
 * sum, which is right for an ALLOCATOR deciding where to place a term credit (the
 * invoice's value really is spent) and is stricter than the rule the WRITER of a
 * refundable note obeys — see Q3 there.
 */
export async function creditableCapacityForInvoice(
  tx: Tx,
  invoiceId: string,
): Promise<{ paidMinor: bigint; available: bigint }> {
  const paidPays = await tx
    .select({ id: payments.id, amountMinor: payments.amountMinor })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, "succeeded")));
  const paidMinor = paidPays.reduce((s, p) => s + p.amountMinor, 0n);
  const payIds = paidPays.map((p) => p.id);
  const gatewayRefunded = payIds.length
    ? (
        await tx
          .select({ amountMinor: refunds.amountMinor })
          .from(refunds)
          .where(and(inArray(refunds.paymentId, payIds), eq(refunds.status, "succeeded")))
      ).reduce((s, r) => s + r.amountMinor, 0n)
    : 0n;
  // EVERY non-voided note, at its full total. A note whose credit was allocated to another
  // invoice has still consumed THIS invoice's value — that is precisely what the payout
  // question is right to ignore and the credit question must not.
  const prior = await tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoiceId));
  const creditedAway = prior
    .filter((c) => c.status !== "voided")
    .reduce((s, c) => s + c.totalMinor, 0n);
  const available = paidMinor - gatewayRefunded - creditedAway;
  return { paidMinor, available: available > 0n ? available : 0n };
}

/**
 * THE CEILING ON AN INVOICE'S CUMULATIVE REFUNDABLE CREDIT: the cash it
 * collected, less every non-voided REFUNDABLE note already written against it **at that
 * note's full total**. Never negative.
 *
 * This is the enforcement the schema's docblock has always claimed and nothing ever did.
 * `refundableCapacityForInvoice` was the writer's ONLY cap, and it answers a different
 * question — the PAYOUT question, "is this money still a claim on cash?" — so it
 * deliberately subtracts a note's OUTSTANDING claim (`total − allocated − refunded`)
 * rather than its total. That netting is correct there (the payout path depends on it) and is
 * catastrophic as a credit cap: once a note's credit has been ALLOCATED to a later
 * invoice its outstanding claim is 0, the source invoice reports its full cash as
 * available again, and a second full-value note is accepted.
 *
 * Measured on our engine (`scripts/probe-cn-writer-ceiling.ts`): INV-1 billed and paid
 * 10,000 in cash; CN-1 refundable for 10,000 (capacity correctly falls to 0 and a second
 * note attempted THERE is refused); CN-1 then allocated onto INV-2 by ordinary invoice
 * generation; capacity reads 10,000 again and CN-2 for another 10,000 is ACCEPTED. INV-1
 * ends carrying 20,000 of non-voided credit on a 10,000 invoice, and CN-2 sits
 * `refund_due` — 10,000 collected produced 10,000 of free supply plus 10,000 of open cash
 * liability. Reachable from `POST /v1/businesses/:biz/credit_notes` behind nothing but
 * `manager`.
 *
 * ── WHY PAID AND NOT TOTAL, AND WHY REFUNDABLE-ONLY ──────────────────────────────
 * Three rules, each one deliberate:
 *
 *   Q1  CUMULATIVE, NOT NETTED. A second full-value note is refused both before AND
 *       after CN-1's credit is allocated onto a later invoice: the creditable amount is
 *       already 0.00, and allocation does not re-open the ceiling. So the sum below is
 *       of note TOTALS, with no `− allocated − refunded` term.
 *
 *   Q2  THE BASIS IS THE PAID AMOUNT, NOT THE INVOICE TOTAL. On a 7.00 invoice with only
 *       3.50 collected, a refundable note for the 7.00 total is refused and one for
 *       exactly 3.50 accepted.
 *       ⚠ This is STRICTER than the invariant `db/schema/credit-notes.ts` documented
 *       ("cumulative credit notes can never exceed the invoice total"); on a
 *       partially-paid invoice this ceiling is tighter. That docblock has been corrected
 *       to say so, because a comment asserting a looser rule than the code enforces is
 *       the defect class this whole change closes.
 *
 *   Q3  ADJUSTMENT NOTES DO NOT CONSUME IT. On the same 7.00/3.50 invoice an ADJUSTMENT
 *       note for the whole 3.50 still owed and THEN a REFUNDABLE note for the
 *       3.50 collected are both legal — cumulative 7.00, exactly the invoice total, from
 *       two notes bounded separately. So the two kinds answer different questions and get
 *       different bounds: an adjustment relieves the DEBT (`issueAdjustmentCreditNote`
 *       caps at `owed`), a refundable returns the CASH.
 *       Hence `kind === "refundable"` in the filter below, and hence NOT
 *       `creditableCapacityForInvoice` — that function subtracts every non-voided note
 *       including adjustments, which would refuse the Q3 shape.
 *
 * ── WHAT THIS DOES NOT SUBTRACT, AND WHY ─────────────────────────────────────────
 * No `gatewayRefunded` term. Cash handed back through a credit note is already
 * represented by that note's total in the sum, so subtracting refunds as well would
 * double-count: paid 10,000, a 4,000 note, that note refunded to the card, would report
 * 2,000 of room where 6,000 is correct. A refund taken DIRECTLY against the payment
 * (`refundPayment`, no note) genuinely does reduce the recoverable cash, and
 * `refundableCapacityForInvoice` — which still applies, see below — subtracts exactly
 * that. Two caps, each subtracting the thing it owns, neither double-counting.
 *
 * ── `paidMinor` IS PASSED IN, NOT RE-DERIVED ─────────────────────────────────────
 * A second definition of "paid" is how this class of bug started, so this function does
 * not compute one. It takes the figure from `refundableCapacityForInvoice`, which owns the
 * cash rule (sum of SUCCEEDED payments on the invoice — cash only, like
 * `invoice.amount_paid`, which likewise excludes `credits_applied`: Q1's INV-B carried
 * `credits_applied` 7.00 with `amount_paid` 0.00). Both of this module's writers already
 * call that function, so the number is free and the two caps cannot disagree about what
 * was collected.
 *
 * ⚠ BOTH CAPS APPLY, WHICHEVER IS TIGHTER. This does not replace
 * `refundableCapacityForInvoice` and must not be folded into it — see the warnings on
 * that function and in `estimate.ts`. On that shape this one binds (0 against its
 * 10,000); on a direct gateway refund that one binds.
 */
export async function refundableCreditCeilingForInvoice(
  tx: Tx,
  invoiceId: string,
  paidMinor: bigint,
): Promise<{ issuedMinor: bigint; remaining: bigint }> {
  const prior = await tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoiceId));
  const issuedMinor = prior
    .filter((c) => c.status !== "voided" && c.kind === "refundable")
    .reduce((s, c) => s + c.totalMinor, 0n);
  const remaining = paidMinor - issuedMinor;
  return { issuedMinor, remaining: remaining > 0n ? remaining : 0n };
}

export async function issueRefundableCreditNote(input: {
  organizationId: string;
  businessId: string;
  invoicePublicId: string;
  items: CreditNoteItemInput[];
  reasonCode?: string;
  reason?: string;
  /** Note to the customer (0309). */
  customerNotes?: string;
  /** See `issueAdjustmentCreditNote.tx` — join the caller's transaction. */
  tx?: Tx | null;
}): Promise<CreditNote> {
  const { organizationId, businessId } = input;
  if (input.items.length === 0) throw new CreditNoteError("A credit note needs at least one item");
  const total = input.items.reduce((s, i) => s + BigInt(i.amountMinor), 0n);
  if (total <= 0n) throw new CreditNoteError("Credit note total must be positive");

  return withTenantTx(organizationId, input.tx, async (tx) => {
    // A grant-funded invoice gives grant draws back, which takes the customer lock. Lock
    // order is customer then invoice (see `lockInvoiceCredit`), so take it first. The
    // customer and the grant columns are fixed once the invoice is issued.
    const pre = await loadInvoice(tx, businessId, input.invoicePublicId);
    const grantApplied = pre
      ? (pre.grantCreditsPreTaxMinor ?? 0n) + (pre.grantCreditsPostTaxMinor ?? 0n)
      : 0n;
    if (pre && grantApplied > 0n) await lockCustomerBalances(tx, pre.customerId);
    // FIRST — see `lockInvoiceCredit`. Five concurrent full-amount notes minted 7500 of
    // cash-refundable credit on 1500 of collected cash without it.
    await lockInvoiceCredit(tx, input.invoicePublicId);
    const inv = await loadInvoice(tx, businessId, input.invoicePublicId);
    if (!inv) throw new CreditNoteError(`We could not find the invoice ${input.invoicePublicId}.`);
    // Eligible-status guard: a refundable credit note returns money that
    // was actually PAID, so it applies only to a paid / partially-paid invoice —
    // never a pending, voided, or never-paid one.
    if (inv.status === "voided" || inv.status === "pending")
      throw new CreditNoteError(
        `Refundable credit notes apply only to paid invoices. This invoice is ${inv.status}.`,
      );
    // Credit grants' share of this credit goes back to the grants, never to cash: the same
    // split the cancellation and change credits make (`splitCreditByFunding`), documented
    // as a `credit_grants` discount. Only the rest is cash, and only it meets the caps below.
    let grantShare = 0n;
    if (grantApplied > 0n && inv.totalMinor > 0n) {
      const { grantDrawnOutstanding } = await import("@/modules/credits/service");
      const outstanding = await grantDrawnOutstanding(tx, businessId, inv.id);
      const share = (total * grantApplied) / inv.totalMinor;
      grantShare = share < outstanding ? share : outstanding;
    }
    const cash = total - grantShare;
    // Cap at the amount ACTUALLY PAID in cash (sum of succeeded payments), not the
    // face total — you cannot refund money that was never collected (review fix).
    const { paidMinor, available } = await refundableCapacityForInvoice(tx, inv.id);
    if (cash > 0n && paidMinor <= 0n)
      throw new CreditNoteError(
        "Refundable credit notes require a paid invoice. This invoice has no succeeded payment to refund.",
      );
    if (cash > available)
      throw new CreditNoteError(
        `Refundable credit ${cash} exceeds refundable paid amount ${available}`,
      );
    // THE CUMULATIVE CEILING — the second cap, and the one the four readers in
    // `proration.ts` / `estimate.ts` were carrying alone. Inside the same
    // `lockInvoiceCredit` taken above, so the read is serialised with the INSERT below
    // rather than racing it; that is the whole reason it lives here and not at the call
    // sites, which now clamp as an optimisation instead of as the enforcement.
    //
    // Both caps apply and the tighter one wins. This one binds where the note's credit
    // has been allocated away (`available` re-inflates, `remaining` does not); the one
    // above binds where cash was refunded straight off the payment. See
    // `refundableCreditCeilingForInvoice` for the reasoning behind the paid-amount
    // basis and the refundable-only filter.
    const { issuedMinor, remaining } = await refundableCreditCeilingForInvoice(
      tx,
      inv.id,
      paidMinor,
    );
    if (cash > remaining)
      throw new CreditNoteError(
        `Refundable credit ${cash} exceeds the ${remaining} still creditable against this invoice` +
          `. The customer paid ${paidMinor}, and refundable credit notes already credit ${issuedMinor}.`,
      );

    if (grantShare === 0n) {
      const cn = await createRefundableCreditNote(tx, {
        organizationId,
        businessId,
        customerId: inv.customerId,
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        currency: inv.currency,
        items: input.items,
        reasonCode: input.reasonCode,
        reason: input.reason,
        ...(input.customerNotes ? { customerNotes: input.customerNotes } : {}),
      });
      return cn;
    }

    // The whole request meets the per-line caps; the cash items below are re-checked.
    if (input.items.some((i) => i.invoiceLineItemPublicId))
      await assertLineCaps(tx, inv, input.items);
    const { restoreGrantDraws } = await import("@/modules/credits/service");
    const returned = await restoreGrantDraws(tx, {
      organizationId,
      businessId,
      customerId: inv.customerId,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      faceMinor: grantShare,
      ledger: true,
      sourceType: "credit_note",
    });
    // The items become the cash lines: each keeps its line and its share of the cash.
    const cashTotal = total - returned;
    let given = 0n;
    const cashItems: CreditNoteItemInput[] = [];
    input.items.forEach((it, i) => {
      const last = i === input.items.length - 1;
      const amount = last ? cashTotal - given : (BigInt(it.amountMinor) * cashTotal) / total;
      given += amount;
      if (amount > 0n) cashItems.push({ ...it, amountMinor: Number(amount) });
    });
    return createRefundableCreditNote(tx, {
      organizationId,
      businessId,
      customerId: inv.customerId,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      currency: inv.currency,
      items: cashItems,
      // The note prints the lines as credited; the discount row takes the grants' part off.
      documentItems: input.items,
      subtotalMinor: total,
      discounts: [
        {
          type: "credit_grants",
          amountMinor: returned,
          description: "Credit Grants Returned",
        },
      ],
      reasonCode: input.reasonCode,
      reason: input.reason,
      ...(input.customerNotes ? { customerNotes: input.customerNotes } : {}),
    });
  });
}

/**
 * Shared insert for a refundable CN + its bucket credit (reused by CN-2 + E5 +
 * the cancellation-credit split). Tx-level and UNCAPPED — callers are responsible
 * for justifying the amount (the public issueRefundableCreditNote enforces the
 * paid-amount cap).
 */
/**
 * `invoice_updated` fires when an invoice gains a credit note or has credits
 * allocated to it. Emitted here from the credit-note primitives that
 * touch an invoice; enrichment (events/content.ts) attaches the customer/subscription.
 */
async function emitInvoiceUpdated(
  tx: Tx,
  args: { organizationId: string; businessId: string; invoicePublicId: string },
): Promise<void> {
  await emitEvent(tx, {
    organizationId: args.organizationId,
    businessId: args.businessId,
    type: "invoice_updated",
    data: buildEventData("invoice_updated", { id: args.invoicePublicId }),
  });
}

export async function createRefundableCreditNote(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    invoiceId: string;
    invoicePublicId: string;
    currency: string;
    items: CreditNoteItemInput[];
    reasonCode?: string;
    reason?: string;
    customerNotes?: string;
    /**
     * `sub_total` (0186): the GROSS reversal this note documents, before any slice
     * was routed back to a credit bucket. The note's own items are the CASHABLE lines, so
     * the relation the writer must satisfy is
     *
     *   total_minor = subtotal_minor − Σ discounts.amount_minor + Σ tax lines on the note
     *
     * OMIT IT and the column stays NULL, meaning "gross not recorded; it equals
     * total_minor" — the pre-0186 convention, and exactly how every caller that passes
     * neither this nor `discounts` behaves today.
     */
    subtotalMinor?: bigint;
    /**
     * `credit_note.discounts[]` — the bucket-funded slices taken off the gross.
     * DOCUMENTARY ONLY: the ledger movement that returned them is the caller's
     * (`restoreBucketFundedSlices`), and NOTHING here posts it a second time. Zero and
     * negative rows are dropped rather than written.
     */
    discounts?: CreditNoteDiscountInput[];
    /**
     * Reverse tax at the invoice's average rate even though items name lines. For items
     * that are PRE-tax with the tax on a separate amount-only item — see `noteTaxShare`.
     */
    taxAtInvoiceRate?: boolean;
    /**
     * The lines the note prints, when they differ from `items`. `items` stay the cashable
     * lines (total, tax, ledger, caps). A note that gives part of its credit back to credit
     * grants prints each credited line at its gross; the `credit_grants` discount takes the
     * returned part off, so Σ printed lines = subtotal + tax.
     */
    documentItems?: CreditNoteItemInput[];
  },
): Promise<CreditNote> {
  const total = input.items.reduce((s, i) => s + BigInt(i.amountMinor), 0n);
  const discounts = (input.discounts ?? []).filter((d) => d.amountMinor > 0n);
  // Per-line cap — see `assertLineCaps`. The lock is re-entrant, so a caller that
  // already holds it (`issueRefundableCreditNote`) is unaffected.
  let packVoids: Awaited<ReturnType<typeof assertLineCaps>> = [];
  if (!input.taxAtInvoiceRate && input.items.some((i) => i.invoiceLineItemPublicId)) {
    await lockInvoiceCredit(tx, input.invoicePublicId);
    const [inv] = await tx
      .select({
        id: invoices.id,
        businessId: invoices.businessId,
        priceType: invoices.priceType,
        currency: invoices.currency,
      })
      .from(invoices)
      .where(eq(invoices.id, input.invoiceId))
      .limit(1);
    if (inv) packVoids = await assertLineCaps(tx, inv, input.items);
  }
  // A ZERO-CASHABLE note is a real document (CN-188: gross 4189900, all of it
  // returned to promotional credit, total 0) and opens with nothing available, so it
  // is SETTLED at birth, not `refund_due`. Same rule the importer applies
  // (`amount_available > 0 ? refund_due : refunded`) and the same one
  // `allocateRefundableDraw` applies when allocation consumes a note entirely —
  // `refund_due` on a note with nothing to pay out would advertise a payout that can
  // never happen, to the dashboard and to any consumer filtering on it.
  const [cn] = await tx
    .insert(creditNotes)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customerId,
      invoiceId: input.invoiceId,
      publicId: publicId("cn"),
      number: await nextCreditNoteNumber(tx, input.businessId),
      creditMethod: "balance",
      kind: "refundable",
      status: total > 0n ? "refund_due" : "refunded",
      channel: currentChannel(),
      reasonCode: input.reasonCode ?? null,
      subtotalMinor: input.subtotalMinor ?? null,
      totalMinor: total,
      allocatedMinor: 0n,
      refundedMinor: 0n,
      currency: input.currency,
      // FX snapshot (0228), inherited from the credited invoice.
      ...(await inheritedInvoiceRate(tx, input.invoiceId)),
      reason: input.reason ?? null,
      customerNotes: input.customerNotes ?? null,
    })
    .returning();
  const printed = input.documentItems ?? input.items;
  const creditedLines = await resolveCreditedLines(tx, input.invoiceId, printed);
  // Guarded: a note whose whole gross went back to the buckets has NO cashable line,
  // and drizzle refuses an empty `values([])`.
  if (printed.length > 0) {
    await tx.insert(creditNoteItems).values(
      printed.map((it) => {
        const src = it.invoiceLineItemPublicId
          ? creditedLines.get(it.invoiceLineItemPublicId)
          : undefined;
        return {
          organizationId: input.organizationId,
          businessId: input.businessId,
          creditNoteId: cn!.id,
          publicId: publicId("cni"),
          description: it.description,
          amountMinor: BigInt(it.amountMinor),
          invoiceLineItemId: src?.id ?? null,
          // Same rule as the adjustment path: the credited window wins over the billed
          // one. A refundable note for a mid-term change reverses the same slice an
          // adjustment note would; only where the money lands differs.
          periodStart: it.periodStart ?? src?.periodStart ?? null,
          periodEnd: it.periodEnd ?? src?.periodEnd ?? null,
        };
      }),
    );
  }
  await voidPackLines(tx, packVoids, cn!.publicId);
  if (discounts.length > 0) {
    await tx.insert(creditNoteDiscounts).values(
      discounts.map((d) => ({
        organizationId: input.organizationId,
        businessId: input.businessId,
        creditNoteId: cn!.id,
        type: d.type,
        amountMinor: d.amountMinor,
        description: d.description ?? null,
      })),
    );
  }
  // NOTHING CASHABLE ⇒ NOTHING TO POST (0186 populate). A note whose entire gross went
  // back to the promotional / excess buckets moves no money of its own: the bucket
  // credit was already booked by `restoreBucketFundedSlices` before this call, and the
  // tax it reverses is nil because promotional credit is applied PRE-tax (a fully
  // promo-funded invoice has a zero taxable base). Booking anything here would either
  // credit REFUNDABLE_CREDIT with 0 — which `postEntries` rejects outright, every line
  // must be positive — or double-credit the bucket. `voidCreditNote` already tolerates a
  // note with no postings (`if (lines.length > 0)`), so the note stays voidable.
  //
  // `customer_updated` is skipped with it, deliberately: no balance of this customer
  // moved BECAUSE OF THIS NOTE, and the restore that did move one emits its own
  // `customer_credits_restored` + promotional-credit movement. `invoice_updated` still
  // fires — the invoice really did gain a credit note.
  if (total > 0n) {
    // TAX SPLIT: the tax inside a refunded total reverses `tax_payable`, or the business
    // keeps owing tax it handed back — see `noteTaxShare`. Untaxed invoices book no
    // `tax_payable`, so the whole total stays on credit_adjustments.
    const inv = await loadInvoice(tx, input.businessId, input.invoicePublicId);
    const taxShare = inv
      ? await noteTaxShare(tx, {
          businessId: input.businessId,
          inv,
          noteId: cn!.id,
          totalMinor: total,
          items: input.items,
          taxAtInvoiceRate: input.taxAtInvoiceRate,
        })
      : 0n;
    const net = total - taxShare;
    const lines: Array<{
      account: string;
      direction: "debit" | "credit";
      amountMinor: bigint;
      currency: string;
    }> = [
      {
        account: REFUNDABLE_CREDIT,
        direction: "credit",
        amountMinor: total,
        currency: input.currency,
      },
    ];
    if (net > 0n)
      lines.push({
        account: "credit_adjustments",
        direction: "debit",
        amountMinor: net,
        currency: input.currency,
      });
    if (taxShare > 0n)
      lines.push({
        account: "tax_payable",
        direction: "debit",
        amountMinor: taxShare,
        currency: input.currency,
      });
    await postEntries(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customerId,
        sourceType: "credit_note",
        sourceId: cn!.publicId,
        lines,
      },
      tx,
    );
  }
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "credit_note_created",
    data: {
      credit_note: cn!.publicId,
      invoice: input.invoicePublicId,
      kind: "refundable",
      reason_code: input.reasonCode ?? null,
      amount_minor: Number(total),
      currency: input.currency,
    },
  });
  // Refundable balance went up → customer_changed; the invoice gained a CN → invoice_updated.
  if (total > 0n)
    await emitCustomerChanged(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customerId,
    });
  await emitInvoiceUpdated(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    invoicePublicId: input.invoicePublicId,
  });
  // P4: audited here rather than in the public `issueRefundableCreditNote` so the
  // cancellation-credit split and E5 get a row too. Those run under the billing
  // clock, whose rows correctly show source=scheduled_job with a NULL IP — a
  // machine has no origin address, and inventing one would be the lie.
  await auditCn(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    action: "credit_note.create",
    resourceType: "credit_note",
    resourceId: cn!.publicId,
    before: { status: null },
    after: {
      status: cn!.status,
      kind: "refundable",
      total_minor: Number(total),
      currency: input.currency,
      invoice: input.invoicePublicId,
      reason_code: input.reasonCode ?? null,
    },
  });
  return cn!;
}

/**
 * Record a REFUNDED credit note documenting a gateway refund of an invoice-linked
 * payment (refunding a paid invoice's payment issues a `refunded`
 * credit note against the invoice — `credit_note_created`).
 *
 * DO-NOT-DOUBLE-BOOK: unlike `createRefundableCreditNote`, this books NO ledger
 * entries. The caller (`refundPayment`) already booked dr `refunds` / cr `cash`, so
 * the money has already left and the ledger is complete — re-booking here would
 * double-count the refund. The CN is a DOCUMENT of money returned, not a balance:
 * it opens fully refunded (total = refunded = paidOut = amount, allocated = 0,
 * available = 0, status `refunded`), so nothing is applicable to invoices and the
 * refundable bucket is untouched. Runs inside the caller's tx (same atomic flow as
 * the refund row). This is the INVERSE of `refundCreditNote` (a CN that pays out via
 * a refund); callers must NOT invoke it for a refund that is itself a CN payout
 * (`refundPayment` guards on contraAccount/creditNoteId) or the two would loop.
 */
export async function createRefundedCreditNote(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    invoiceId: string;
    invoicePublicId: string;
    currency: string;
    amountMinor: bigint;
    reasonCode?: string;
    reason?: string;
    /** The refund this note documents (0487). */
    refundId?: string;
  },
): Promise<CreditNote> {
  const total = input.amountMinor;
  const [cn] = await tx
    .insert(creditNotes)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customerId,
      invoiceId: input.invoiceId,
      publicId: publicId("cn"),
      number: await nextCreditNoteNumber(tx, input.businessId),
      refundId: input.refundId ?? null,
      creditMethod: "refund",
      kind: "refundable",
      status: "refunded",
      channel: currentChannel(),
      reasonCode: input.reasonCode ?? null,
      totalMinor: total,
      allocatedMinor: 0n,
      refundedMinor: total,
      paidOutMinor: total,
      currency: input.currency,
      // FX snapshot (0228), inherited from the credited invoice.
      ...(await inheritedInvoiceRate(tx, input.invoiceId)),
      reason: input.reason ?? null,
    })
    .returning();
  await tx.insert(creditNoteItems).values({
    organizationId: input.organizationId,
    businessId: input.businessId,
    creditNoteId: cn!.id,
    publicId: publicId("cni"),
    description: input.reason ?? `Refund of invoice ${input.invoicePublicId}`,
    amountMinor: total,
  });
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "credit_note_created",
    data: {
      credit_note: cn!.publicId,
      invoice: input.invoicePublicId,
      kind: "refundable",
      reason_code: input.reasonCode ?? null,
      amount_minor: Number(total),
      currency: input.currency,
    },
  });
  // The invoice gained a credit note → invoice_updated. No
  // customer_changed: no credit balance moved (the refund went to the card).
  await emitInvoiceUpdated(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    invoicePublicId: input.invoicePublicId,
  });
  // P4: the DOCUMENT of an operator's gateway refund (`refundPayment` books the
  // money and calls this in its tx). `credit_method: refund` is what tells the
  // reader this CN paid cash out rather than granting credit.
  await auditCn(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    action: "credit_note.create",
    resourceType: "credit_note",
    resourceId: cn!.publicId,
    before: { status: null },
    after: {
      status: cn!.status,
      kind: "refundable",
      credit_method: "refund",
      total_minor: Number(total),
      currency: input.currency,
      invoice: input.invoicePublicId,
      reason_code: input.reasonCode ?? null,
    },
  });
  return cn!;
}

/**
 * What one `refundCreditNote` call can pay back now: the note's spendable amount, capped by
 * the largest gateway payment that can fund it. 0 = nothing gateway-reversible (offline or
 * credit-settled money): the note stays as credit.
 */
export async function refundableNowMinor(
  organizationId: string,
  businessId: string,
  creditNotePublicId: string,
): Promise<bigint> {
  const cn = await withTenant(
    organizationId,
    async (tx) =>
      (
        await tx
          .select()
          .from(creditNotes)
          .where(
            and(
              eq(creditNotes.businessId, businessId),
              eq(creditNotes.publicId, creditNotePublicId),
            ),
          )
          .limit(1)
      )[0],
  );
  if (!cn || cn.kind !== "refundable" || cn.status === "voided") return 0n;
  const available = creditNoteSpendable(cn);
  if (available <= 0n || !cn.invoiceId) return 0n;
  const { pays } = await gatewayFundingLegs(organizationId, cn.invoiceId, { gatewayOnly: true });
  const largest = pays.reduce((max, p) => (p.remaining > max ? p.remaining : max), 0n);
  return largest < available ? largest : available;
}

/**
 * Refund (part of) a refundable credit note in two steps:
 *  1) draw the refundable bucket into a `refunds_payable` LIABILITY (dr
 *     refundable_credit_balance / cr refunds_payable) and mark the CN, in one
 *     customer-locked tx (concurrent refunds serialize on the lock);
 *  2) PAY THE CUSTOMER: execute a gateway refund against the CN's invoice funding
 *     payment(s), which clears refunds_payable → cash (dr refunds_payable / cr
 *     cash) via `refundPayment(contraAccount:'refunds_payable')`. Before this the
 *     payable was booked but never cleared — the customer never actually received
 *     money (review blocker). The payout runs OUTSIDE the tx (network) and is
 *     best-effort: a gateway failure leaves refunds_payable outstanding (a genuine
 *     unpaid obligation, retriable) rather than tearing the CN state.
 * Capped at the CN's `available`; when available hits 0 → `refunded`.
 */
/**
 * What `downgrade_credit: refund` could pay back through card or bank payments for a note on
 * `invoiceId`: the largest `legs` gateway funding legs (own invoice first, then capped
 * siblings), the same legs `refundCreditNote({ gatewayOnly })` spends. For previews.
 */
export async function gatewayRefundableTotalMinor(
  organizationId: string,
  invoiceId: string,
  legs = 10,
): Promise<bigint> {
  const { pays } = await gatewayFundingLegs(organizationId, invoiceId, { gatewayOnly: true });
  return [...pays]
    .map((p) => p.remaining)
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
    .slice(0, legs)
    .reduce((t, v) => t + v, 0n);
}

export async function refundCreditNote(input: {
  organizationId: string;
  businessId: string;
  creditNotePublicId: string;
  amountMinor?: number;
  reason?: string;
  /** Refund only through card or bank payments, never an offline one. */
  gatewayOnly?: boolean;
}): Promise<CreditNote> {
  const { organizationId, businessId } = input;

  // ── ONE PAYMENT PER REFUND ──────────────────────────────────────────────────
  // Refuse anything that would span more than one gateway operation, BEFORE the earmark,
  // and name the amount that WILL go through: a note with 21,490.31 available over two
  // payments is refused, 21,140.24 is named and cleared, and the remaining 350.07 clears
  // in its own call. Nothing is unreachable; it takes one call per payment.
  //
  // The point is atomicity: one request = one gateway refund = one id, one outcome, no
  // half-success. Fanning out inside one call is what produced `refunded=0 /
  // paidOut=2149031` here on 2026-08-25 — leg 1 paid, a reversal fired, leg 2 landed
  // after. Under this rule that state cannot arise at all.
  const preflight = await withTenant(organizationId, async (tx) => {
    const [cn] = await tx
      .select()
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.businessId, businessId),
          eq(creditNotes.publicId, input.creditNotePublicId),
        ),
      )
      .limit(1);
    return cn
      ? { invoiceId: cn.invoiceId, available: creditNoteSpendable(cn), currency: cn.currency }
      : null;
  });
  if (preflight) {
    const asked = input.amountMinor != null ? BigInt(input.amountMinor) : preflight.available;
    const { pays } = await gatewayFundingLegs(organizationId, preflight.invoiceId, {
      gatewayOnly: input.gatewayOnly,
    });
    const largestLeg = pays.reduce((max, p) => (p.remaining > max ? p.remaining : max), 0n);
    // Cap by the note's own available: naming more than the note is worth would be a lie.
    const payable = largestLeg < preflight.available ? largestLeg : preflight.available;
    if (asked > payable && payable > 0n) {
      throw new CreditNoteError(
        `You can refund only ${payable} now. Refund the remaining amount in a later refund operation.`,
      );
    }
  }

  const { updated, cn, requested } = await withTenant(organizationId, async (tx) => {
    const [stale] = await tx
      .select({ customerId: creditNotes.customerId })
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.businessId, businessId),
          eq(creditNotes.publicId, input.creditNotePublicId),
        ),
      )
      .limit(1);
    if (!stale)
      throw new CreditNoteError(
        `We could not find the credit note ${input.creditNotePublicId}.`,
        "not_found",
      );
    // Serialize ALL bucket/CN mutations for this customer, then re-read the CN so
    // every check below (available, invariant) sees post-lock state — a concurrent
    // refund/allocation otherwise races the snapshot and double-pays cash.
    await lockCustomerBalances(tx, stale.customerId);
    const [cn] = await tx
      .select()
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.businessId, businessId),
          eq(creditNotes.publicId, input.creditNotePublicId),
        ),
      )
      .limit(1);
    if (!cn)
      throw new CreditNoteError(
        `We could not find the credit note ${input.creditNotePublicId}.`,
        "not_found",
      );
    if (cn.kind !== "refundable")
      throw new CreditNoteError("You can refund only a refundable credit note");
    if (cn.status === "voided") throw new CreditNoteError("Credit note is voided");
    const available = creditNoteSpendable(cn);
    const requested = input.amountMinor != null ? BigInt(input.amountMinor) : available;
    if (requested <= 0n) throw new CreditNoteError("Refund amount must be positive");
    if (requested > available)
      throw new CreditNoteError(`Refund ${requested} exceeds available ${available}`);

    const bucket = await bucketBalance(tx, cn.customerId, REFUNDABLE_CREDIT, cn.currency);
    if (requested > bucket)
      throw new CreditNoteError(`Refundable balance ${bucket} is short of ${requested}`);
    await postEntries(
      {
        organizationId,
        businessId,
        customerId: cn.customerId,
        sourceType: "credit_note_refund",
        sourceId: cn.publicId,
        lines: [
          {
            account: REFUNDABLE_CREDIT,
            direction: "debit",
            amountMinor: requested,
            currency: cn.currency,
          },
          {
            account: "refunds_payable",
            direction: "credit",
            amountMinor: requested,
            currency: cn.currency,
          },
        ],
      },
      tx,
    );
    const refundedMinor = cn.refundedMinor + requested;
    const nowAvail = cn.totalMinor - cn.allocatedMinor - refundedMinor;
    assertInvariant({
      totalMinor: cn.totalMinor,
      allocatedMinor: cn.allocatedMinor,
      refundedMinor,
    });
    // Status stays `refund_due` until the payout ACTUALLY clears (G review
    // blocker: marking `refunded` before the gateway refund made a declined
    // payout look complete — the cap re-inflated and the payable was stranded
    // forever). `settleCnPayout` below flips to `refunded` on full payout.
    const [updated] = await tx
      .update(creditNotes)
      // TAKE THE LEASE in the SAME write as the earmark. From here until `settleCnPayout`
      // (or `reverseCnRefundEarmark`) this note reads `refunded_minor > paid_out_minor` —
      // indistinguishable, without this stamp, from a payout that got stranded by a crash.
      // `sweepOutstandingCnPayouts` retried exactly that gap on 2026-08-25 and sent Stripe a
      // second refund for a payout already in flight. The offline path below sets
      // `refundedMinor` and `paidOutMinor` together, so it never opens this window and takes
      // no lease.
      .set({ refundedMinor, status: "refund_due", payoutAttemptAt: new Date() })
      .where(eq(creditNotes.id, cn.id))
      .returning();
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "credit_note_refunded",
      data: {
        credit_note: cn.publicId,
        amount_minor: Number(requested),
        currency: cn.currency,
        available_minor: Number(nowAvail),
      },
    });
    // Both events belong here: the refundable bucket went DOWN — the ledger post above did it —
    // and the invoice this note sits on changed its credit position. `createRefundedCreditNote`
    // says "no customer_changed: no credit balance moved (the refund went to the card)",
    // which is true THERE (a direct card refund mints a note, it does not draw a bucket) and
    // was wrongly read as covering this path too. Drawing a refundable credit note down IS a
    // balance movement, whoever the cash ends up with.
    // `emitCustomerChanged` dedupes per request, so a multi-leg payout still reports one.
    await emitCustomerChanged(tx, { organizationId, businessId, customerId: cn.customerId });
    const [refundedInvoice] = await tx
      .select({ publicId: invoices.publicId })
      .from(invoices)
      .where(eq(invoices.id, cn.invoiceId))
      .limit(1);
    if (refundedInvoice) {
      await emitInvoiceUpdated(tx, {
        organizationId,
        businessId,
        invoicePublicId: refundedInvoice.publicId,
      });
    }
    // P4: audit the EARMARK (step 1) — this transaction is the operator's decision
    // to return money, and it is the only step that is atomic. The payout attempt
    // that follows is a gateway outcome, already on the CN's refund timeline and in
    // `transactions`; a declined payout is un-earmarked by
    // `reverseCnRefundEarmark`, whose compensating entry is the honest record. Note
    // `status` stays refund_due on purpose (see the comment above).
    await auditCn(tx, {
      organizationId,
      businessId,
      action: "credit_note.refund",
      resourceType: "credit_note",
      resourceId: cn.publicId,
      before: {
        refunded_minor: Number(cn.refundedMinor),
        available_minor: Number(available),
        status: cn.status,
      },
      after: {
        refunded_minor: Number(refundedMinor),
        available_minor: Number(nowAvail),
        status: updated!.status,
      },
    });
    return { updated: updated!, cn, requested };
  });

  // 2) Pay the customer: clear refunds_payable → cash via a gateway refund against
  //    the CN's invoice funding payment(s), oldest cap first.
  // 3) A payout leg the gateway REFUSED does not consume the credit note — the un-paid
  //    remainder is un-earmarked (compensating ledger entry) so `available` re-inflates
  //    and the operator can retry explicitly. Only amounts actually accepted by the
  //    gateway stay booked as refunded.
  const { paidOut, lastError, legsAttempted } = await payOutRefundsPayable({
    organizationId,
    businessId,
    invoiceId: cn.invoiceId,
    amountMinor: requested,
    currency: cn.currency,
    reason: input.reason,
    creditNoteId: cn.id,
    gatewayOnly: input.gatewayOnly,
  });
  // SETTLE BEFORE REVERSING. `reverseCnRefundEarmark` caps itself at
  // `refundedMinor − paidOutMinor` — "only the earmarked-but-unpaid slice". Reversing
  // first leaves `paidOutMinor` still at its pre-payout value, so that cap is the WHOLE
  // earmark and the reversal winds back money the gateway has already sent.
  //
  // Measured 2026-08-25, with the billing worker's `sweepOutstandingCnPayouts`
  // interleaving on the same note:
  //     08:08:56  credit_note_refunded          earmark 2149031
  //     08:08:58  refund success      35007     leg 1
  //     08:09:00  credit_note_refund_reversed   reversal — cap still computed against paidOut 0
  //     08:09:00  refund success    2114024     leg 2
  // Result: `refunded=0 / paidOut=2149031` — the note advertising 2,149,031 the customer
  // had already been paid. Cash in and cash out were equal throughout; the money was never
  // wrong, only the claim about it.
  //
  // Settling first makes the cap honest, and the same ordering makes a concurrent sweep
  // harmless rather than merely unlikely: whichever actor records its payout first, the
  // other's reversal can only touch what is genuinely still unpaid.
  let settled = await settleCnPayout(organizationId, businessId, cn.id, paidOut);
  if (paidOut < requested) {
    await reverseCnRefundEarmark({
      organizationId,
      businessId,
      cnId: cn.id,
      amountMinor: requested - paidOut,
      reason: lastError,
    });
    // Re-read: the reversal moved `refundedMinor` and the status underneath the row
    // `settleCnPayout` just returned.
    settled = await withTenant(organizationId, async (tx) => {
      const [fresh] = await tx.select().from(creditNotes).where(eq(creditNotes.id, cn.id)).limit(1);
      return fresh ?? settled;
    });
  }
  if (paidOut === 0n) {
    // Nothing cleared — the CN is back where it started; surface the reason to
    // the caller (400, not a silent "refund issued").
    //
    // `legsAttempted === 0` means no provider was ever called: the invoice has no
    // succeeded payment left to reverse, because it was settled by applied credit
    // or its payments are already fully refunded. This used to report the generic
    // "the gateway declined the payout", which is a lie with a cost — it sends the
    // operator to the RazorPay/Stripe dashboard hunting a decline that does not
    // exist. The dashboard now pre-empts this via `gateway_refundable_minor`, but
    // the API must be honest on its own for direct callers.
    throw new CreditNoteError(
      legsAttempted === 0
        ? "There is nothing to refund through a gateway. The invoice of this credit note has no payment left to reverse. Applied credit settled it, or its payments are already fully refunded. If you returned the money outside a gateway, use an offline refund."
        : `Refund failed: ${lastError ?? "the gateway declined the payout"}`,
    );
  }
  return settled;
}

/**
 * Un-earmark a booked-but-not-paid-out refund amount: compensating ledger entry
 * (refunds_payable → refundable credit; the ledger is append-only) + wind
 * `refundedMinor` back so the amount is available again. Never drops
 * `refundedMinor` below what was actually paid out.
 */
async function reverseCnRefundEarmark(input: {
  organizationId: string;
  businessId: string;
  cnId: string;
  amountMinor: bigint;
  reason?: string | null;
}): Promise<void> {
  if (input.amountMinor <= 0n) return;
  await withTenant(input.organizationId, (tx) => reverseCnRefundEarmarkTx(tx, input));
}

async function reverseCnRefundEarmarkTx(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    cnId: string;
    amountMinor: bigint;
    reason?: string | null;
  },
): Promise<void> {
  const { organizationId, businessId } = input;
  if (input.amountMinor <= 0n) return;
  {
    const [stale] = await tx
      .select({ customerId: creditNotes.customerId })
      .from(creditNotes)
      .where(eq(creditNotes.id, input.cnId))
      .limit(1);
    if (!stale) return;
    await lockCustomerBalances(tx, stale.customerId);
    const [cn] = await tx.select().from(creditNotes).where(eq(creditNotes.id, input.cnId)).limit(1);
    if (!cn) return;
    // Cap: only the earmarked-but-unpaid slice can be reversed.
    const reversible = cn.refundedMinor - cn.paidOutMinor;
    const amount = input.amountMinor < reversible ? input.amountMinor : reversible;
    if (amount <= 0n) return;
    await postEntries(
      {
        organizationId,
        businessId,
        customerId: cn.customerId,
        sourceType: "credit_note_refund_reversal",
        sourceId: cn.publicId,
        lines: [
          {
            account: "refunds_payable",
            direction: "debit",
            amountMinor: amount,
            currency: cn.currency,
          },
          {
            account: REFUNDABLE_CREDIT,
            direction: "credit",
            amountMinor: amount,
            currency: cn.currency,
          },
        ],
      },
      tx,
    );
    const refundedMinor = cn.refundedMinor - amount;
    assertInvariant({
      totalMinor: cn.totalMinor,
      allocatedMinor: cn.allocatedMinor,
      refundedMinor,
    });
    await tx
      .update(creditNotes)
      // Lease released alongside the reversal: the earmark this was holding is gone, so there
      // is nothing in flight to protect.
      .set({
        refundedMinor,
        status: cn.status === "voided" ? "voided" : "refund_due",
        payoutAttemptAt: null,
      })
      .where(eq(creditNotes.id, cn.id));
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "credit_note_refund_reversed",
      data: {
        credit_note: cn.publicId,
        amount_minor: Number(amount),
        currency: cn.currency,
        reason: input.reason ?? null,
      },
    });
  }
}

/**
 * Settle ONE payout refund the gateway could not find (`refunds.not_found_state`):
 *   `mark_paid`       open → paid: the refund and its transaction become `succeeded` and the
 *                     cash leaving is booked (a person, or the gateway's late success);
 *   `credit_operator` open → credited: a person returns it to the note as credit;
 *   `credit_gateway`  open → gateway_failed: the gateway confirmed it failed; same credit;
 *   `late_paid`       credited → credited_then_paid: a person returned it as credit and the
 *                     gateway then paid it: the customer has it twice (`payout_duplicated_minor`);
 *                     gateway_failed → gateway_failed_then_paid: the failure and the success
 *                     arrived out of order (`payout_out_of_order_minor`). The cash out is booked
 *                     either way; the credit is never taken back silently;
 *   `bounced`         *_then_paid → back: the payout came back after all (a bank debit's
 *                     funds returned): the cash posting is reversed and the flag lowered.
 * Claims the refund's state first, so each happens once; under the customer-balance lock.
 */
type UnconfirmedResolution =
  | "mark_paid"
  | "credit_operator"
  | "credit_gateway"
  | "late_paid"
  | "bounced";

export async function resolveUnconfirmedRefundTx(
  tx: Tx,
  refundId: string,
  resolution: UnconfirmedResolution,
): Promise<boolean> {
  const [txn] = await tx
    .select({ id: transactions.id, creditNoteId: transactions.creditNoteId })
    .from(transactions)
    .where(eq(transactions.refundId, refundId))
    .limit(1);
  if (!txn?.creditNoteId) return false;
  const [note] = await tx
    .select()
    .from(creditNotes)
    .where(eq(creditNotes.id, txn.creditNoteId))
    .limit(1);
  if (!note) return false;
  await lockCustomerBalances(tx, note.customerId);
  const [current] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
  if (!current) return false;
  const from = current.notFoundState;
  const NEXT: Record<UnconfirmedResolution, Record<string, string>> = {
    mark_paid: { open: "paid" },
    credit_operator: { open: "credited" },
    credit_gateway: { open: "gateway_failed" },
    late_paid: { credited: "credited_then_paid", gateway_failed: "gateway_failed_then_paid" },
    bounced: { credited_then_paid: "credited", gateway_failed_then_paid: "gateway_failed" },
  };
  const to = from ? NEXT[resolution][from] : undefined;
  if (!from || !to) return false;
  const status =
    resolution === "mark_paid" || resolution === "late_paid"
      ? "succeeded"
      : resolution === "bounced"
        ? "failed"
        : current.status;
  const [ref] = await tx
    .update(refunds)
    .set({ notFoundState: to, status })
    .where(and(eq(refunds.id, refundId), eq(refunds.notFoundState, from)))
    .returning();
  if (!ref) return false;
  const amount = ref.amountMinor;
  const cash = (out: boolean) =>
    postEntries(
      {
        organizationId: note.organizationId,
        businessId: note.businessId,
        customerId: note.customerId,
        sourceType: out ? "credit_note_payout_confirmed" : "credit_note_payout_returned",
        sourceId: ref.publicId,
        lines: [
          {
            account: out ? "refunds_payable" : "cash",
            direction: "debit",
            amountMinor: amount,
            currency: ref.currency,
          },
          {
            account: out ? "cash" : "refunds_payable",
            direction: "credit",
            amountMinor: amount,
            currency: ref.currency,
          },
        ],
      },
      tx,
    );
  const [cn] = await tx.select().from(creditNotes).where(eq(creditNotes.id, note.id)).limit(1);

  if (resolution === "late_paid" || resolution === "bounced") {
    const twice = from === "credited" || from === "credited_then_paid";
    const delta = resolution === "late_paid" ? amount : -amount;
    await setTransactionStatus(
      tx,
      note.organizationId,
      txn.id,
      resolution === "late_paid" ? "succeeded" : "failed",
      resolution === "late_paid" ? { settledAt: new Date() } : { errorCode: "refund_failed" },
    );
    await cash(resolution === "late_paid");
    const floor = (v: bigint) => (v > 0n ? v : 0n);
    await tx
      .update(creditNotes)
      .set(
        twice
          ? { payoutDuplicatedMinor: floor(cn!.payoutDuplicatedMinor + delta) }
          : { payoutOutOfOrderMinor: floor(cn!.payoutOutOfOrderMinor + delta) },
      )
      .where(eq(creditNotes.id, note.id));
    if (resolution === "late_paid")
      log.error(
        twice
          ? "a refund returned as credit was later paid out — the customer has it twice"
          : "a refund the gateway reported failed was later reported paid — out-of-order answers",
        {
          event: twice ? "cn_payout_duplicated" : "cn_payout_out_of_order",
          creditNote: note.publicId,
          refund: ref.publicId,
          amountMinor: String(amount),
        },
      );
    return true;
  }

  if (resolution === "mark_paid") {
    await setTransactionStatus(tx, note.organizationId, txn.id, "succeeded", {
      settledAt: new Date(),
    });
    await cash(true);
  }
  const left = cn!.payoutUnconfirmedMinor - amount;
  await tx
    .update(creditNotes)
    .set({ payoutUnconfirmedMinor: left > 0n ? left : 0n })
    .where(eq(creditNotes.id, note.id));
  if (resolution === "credit_operator" || resolution === "credit_gateway")
    await releaseFailedCnPayoutTx(tx, {
      organizationId: note.organizationId,
      businessId: note.businessId,
      cnId: note.id,
      amountMinor: amount,
      reason: "refund_not_confirmed_returned_as_credit",
    });
  return true;
}

/**
 * A late gateway answer for a refund that may be flagged not found. Decided UNDER the
 * customer-balance lock on the refund's state as it is now, so a person's resolution or the
 * stale sweep racing the answer cannot make it pick the wrong branch:
 *   success: open → paid · credited / gateway_failed → paid after credit (flagged) · else nothing
 *   failure: open → credit · *_then_paid → bounced back · paid → `proceed` (normal reversal)
 *            · credited / gateway_failed → nothing
 * `proceed` = not flagged (or paid, on a failure): the caller takes its normal path.
 */
export async function answerUnconfirmedRefundTx(
  tx: Tx,
  refundId: string,
  answer: "success" | "failure",
): Promise<"done" | "noop" | "proceed"> {
  const [link] = await tx
    .select({ customerId: creditNotes.customerId })
    .from(transactions)
    .innerJoin(creditNotes, eq(creditNotes.id, transactions.creditNoteId))
    .where(eq(transactions.refundId, refundId))
    .limit(1);
  if (!link) return "proceed";
  await lockCustomerBalances(tx, link.customerId);
  const [ref] = await tx
    .select({ state: refunds.notFoundState })
    .from(refunds)
    .where(eq(refunds.id, refundId))
    .limit(1);
  const state = ref?.state ?? null;
  if (state == null) return "proceed";
  const run = async (r: UnconfirmedResolution) =>
    (await resolveUnconfirmedRefundTx(tx, refundId, r)) ? ("done" as const) : ("noop" as const);
  if (answer === "success") {
    if (state === "open") return run("mark_paid");
    if (state === "credited" || state === "gateway_failed") return run("late_paid");
    return "noop";
  }
  if (state === "open") return run("credit_gateway");
  if (state === "credited_then_paid" || state === "gateway_failed_then_paid") return run("bounced");
  return state === "paid" ? "proceed" : "noop";
}

/** An operator's answer for every unconfirmed payout refund of a note. Once per refund. */
export async function resolveUnconfirmedCnPayout(input: {
  organizationId: string;
  businessId: string;
  creditNotePublicId: string;
  resolution: "return_as_credit" | "mark_paid";
}): Promise<CreditNote> {
  const { organizationId, businessId } = input;
  return withTenant(organizationId, async (tx) => {
    const find = async () =>
      (
        await tx
          .select()
          .from(creditNotes)
          .where(
            and(
              eq(creditNotes.businessId, businessId),
              eq(creditNotes.publicId, input.creditNotePublicId),
            ),
          )
          .limit(1)
      )[0];
    const cn = await find();
    if (!cn)
      throw new CreditNoteError(
        `We could not find the credit note ${input.creditNotePublicId}.`,
        "not_found",
      );
    const open = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .innerJoin(transactions, eq(transactions.refundId, refunds.id))
      .where(and(eq(transactions.creditNoteId, cn.id), eq(refunds.notFoundState, "open")));
    let done = 0;
    for (const r of open)
      if (
        await resolveUnconfirmedRefundTx(
          tx,
          r.id,
          input.resolution === "mark_paid" ? "mark_paid" : "credit_operator",
        )
      )
        done++;
    if (done)
      await auditCn(tx, {
        organizationId,
        businessId,
        action: "credit_note.resolve_payout",
        resourceType: "credit_note",
        resourceId: cn.publicId,
        before: { payout_unconfirmed_minor: Number(cn.payoutUnconfirmedMinor) },
        after: { resolution: input.resolution, refunds: done },
      });
    return (await find())!;
  });
}

/**
 * A credit-note payout refund that the gateway accepted and then FAILED: that amount was
 * counted as paid out, so take it off `paid_out_minor` and give it back to the note as
 * credit. Only this refund's amount; called once, from `reverseRefund`'s claimed update.
 */
export async function releaseFailedCnPayoutTx(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    cnId: string;
    amountMinor: bigint;
    reason?: string | null;
  },
): Promise<void> {
  const [cn] = await tx.select().from(creditNotes).where(eq(creditNotes.id, input.cnId)).limit(1);
  if (!cn) return;
  await lockCustomerBalances(tx, cn.customerId);
  const back = input.amountMinor < cn.paidOutMinor ? input.amountMinor : cn.paidOutMinor;
  if (back <= 0n) return;
  await tx
    .update(creditNotes)
    .set({ paidOutMinor: cn.paidOutMinor - back })
    .where(eq(creditNotes.id, cn.id));
  await reverseCnRefundEarmarkTx(tx, { ...input, amountMinor: back });
}

/**
 * Single-CN detail with the "Refunds and Allocations" timeline: FIFO invoice
 * allocations (with invoice public ids) + every refund transaction stamped with
 * this CN's id (gateway payouts via payOutRefundsPayable and offline refunds).
 */
export async function getCreditNoteDetail(
  organizationId: string,
  businessId: string,
  cnPublicId: string,
) {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      // Customer joined in: the credit-note screen leads with the customer, and the
      // index carries a "Customer Info" column; we showed only the invoice, so there
      // was no way to get from a credit note to the payer.
      .select({
        cn: creditNotes,
        invPid: invoices.publicId,
        invNumber: invoices.number,
        subId: invoices.subscriptionId,
        cusPid: customers.publicId,
        // Same name chain as the list — the detail header and the row that led to
        // it must not disagree about who this credit belongs to.
        cusFirstName: customers.firstName,
        cusLastName: customers.lastName,
        cusCompany: customers.company,
        cusEmail: customers.email,
      })
      .from(creditNotes)
      .innerJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
      .leftJoin(customers, eq(creditNotes.customerId, customers.id))
      .where(and(eq(creditNotes.businessId, businessId), eq(creditNotes.publicId, cnPublicId)))
      .limit(1);
    if (!row) return null;
    const items = await tx
      .select()
      .from(creditNoteItems)
      .where(eq(creditNoteItems.creditNoteId, row.cn.id));
    const allocations = await tx
      .select({ alloc: creditNoteAllocations, invPid: invoices.publicId })
      .from(creditNoteAllocations)
      .innerJoin(invoices, eq(creditNoteAllocations.invoiceId, invoices.id))
      .where(eq(creditNoteAllocations.creditNoteId, row.cn.id))
      .orderBy(asc(creditNoteAllocations.createdAt));
    const refundTxns = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.creditNoteId, row.cn.id), eq(transactions.type, "refund")))
      .orderBy(asc(transactions.occurredAt));
    // `credit_note.discounts[]` (0186): which slices of `subtotal_minor` went back
    // to a credit bucket instead of to the customer. Detail-only — one extra table read
    // per note, which the list must not pay 25 times over; the list carries
    // `subtotal_minor` alone, the same split the invoice read uses for its `discounts`.
    const discounts = await tx
      .select()
      .from(creditNoteDiscounts)
      .where(eq(creditNoteDiscounts.creditNoteId, row.cn.id))
      .orderBy(asc(creditNoteDiscounts.createdAt));
    // Whether a GATEWAY refund of this note is even possible, computed with the
    // same scan the payout itself walks (`gatewayRefundableForInvoice`) so the
    // control the dashboard offers and the payout that follows cannot disagree.
    const gatewayRefundable = await gatewayRefundableForInvoice(tx, row.cn.invoiceId);
    return {
      view: {
        note: row.cn,
        invoicePublicId: row.invPid,
        invoiceNumber: row.invNumber,
        items,
        customerPublicId: row.cusPid ?? null,
        customerName: accountHolderName({
          firstName: row.cusFirstName,
          lastName: row.cusLastName,
          company: row.cusCompany,
          email: row.cusEmail,
        }),
        customerEmail: row.cusEmail ?? null,
      } satisfies CreditNoteView,
      allocations,
      refundTxns,
      discounts,
      gatewayRefundableMinor: gatewayRefundable.totalMinor,
    };
  });
}

export const OFFLINE_REFUND_METHODS = ["cash", "check", "bank_transfer", "other"] as const;
export type OfflineRefundMethod = (typeof OFFLINE_REFUND_METHODS)[number];

/**
 * Record an OFFLINE refund of a refundable credit note — money returned to the
 * customer outside any gateway (cash / check / bank transfer). Same guards as
 * `refundCreditNote`, but the payout is already settled by definition, so one atomic
 * booking does both steps:
 * dr refundable_credit_balance / cr cash (no refunds_payable stop-over — there
 * is no pending obligation), refunded and paid_out advance together, and a
 * success `refund` transaction (gateway_key `offline_<method>`, reference in
 * id_at_gateway, linked via credit_note_id) records it for the CN timeline.
 */
export async function recordOfflineCnRefund(input: {
  organizationId: string;
  businessId: string;
  creditNotePublicId: string;
  amountMinor?: number;
  method: OfflineRefundMethod;
  reference?: string;
  occurredAt?: Date;
  reason?: string;
}): Promise<CreditNote> {
  const { organizationId, businessId } = input;
  return withTenant(organizationId, async (tx) => {
    const [stale] = await tx
      .select({ customerId: creditNotes.customerId })
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.businessId, businessId),
          eq(creditNotes.publicId, input.creditNotePublicId),
        ),
      )
      .limit(1);
    if (!stale)
      throw new CreditNoteError(
        `We could not find the credit note ${input.creditNotePublicId}.`,
        "not_found",
      );
    await lockCustomerBalances(tx, stale.customerId);
    const [cn] = await tx
      .select()
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.businessId, businessId),
          eq(creditNotes.publicId, input.creditNotePublicId),
        ),
      )
      .limit(1);
    if (!cn)
      throw new CreditNoteError(
        `We could not find the credit note ${input.creditNotePublicId}.`,
        "not_found",
      );
    if (cn.kind !== "refundable")
      throw new CreditNoteError("You can refund only a refundable credit note");
    if (cn.status === "voided") throw new CreditNoteError("Credit note is voided");
    const available = creditNoteSpendable(cn);
    const requested = input.amountMinor != null ? BigInt(input.amountMinor) : available;
    if (requested <= 0n) throw new CreditNoteError("Refund amount must be positive");
    if (requested > available)
      throw new CreditNoteError(`Refund ${requested} exceeds available ${available}`);
    const bucket = await bucketBalance(tx, cn.customerId, REFUNDABLE_CREDIT, cn.currency);
    if (requested > bucket)
      throw new CreditNoteError(`Refundable balance ${bucket} is short of ${requested}`);

    await postEntries(
      {
        organizationId,
        businessId,
        customerId: cn.customerId,
        sourceType: "credit_note_refund",
        sourceId: cn.publicId,
        lines: [
          {
            account: REFUNDABLE_CREDIT,
            direction: "debit",
            amountMinor: requested,
            currency: cn.currency,
            memo: `offline refund (${input.method})${input.reference ? ` ref ${input.reference}` : ""}`,
          },
          { account: "cash", direction: "credit", amountMinor: requested, currency: cn.currency },
        ],
      },
      tx,
    );
    const refundedMinor = cn.refundedMinor + requested;
    const paidOutMinor = cn.paidOutMinor + requested;
    assertInvariant({
      totalMinor: cn.totalMinor,
      allocatedMinor: cn.allocatedMinor,
      refundedMinor,
    });
    const nowAvail = cn.totalMinor - cn.allocatedMinor - refundedMinor;
    const fullySettled = nowAvail === 0n && paidOutMinor >= refundedMinor;
    const [updated] = await tx
      .update(creditNotes)
      .set({
        refundedMinor,
        paidOutMinor,
        status: fullySettled ? "refunded" : cn.status === "refund_due" ? "refund_due" : cn.status,
      })
      .where(eq(creditNotes.id, cn.id))
      .returning();
    await recordTransaction(
      {
        organizationId,
        businessId,
        customerId: cn.customerId,
        type: "refund",
        status: "succeeded",
        amountMinor: requested,
        currency: cn.currency,
        gatewayKey: `offline_${input.method}`,
        idAtGateway: input.reference ?? null,
        invoiceId: cn.invoiceId,
        creditNoteId: cn.id,
        occurredAt: input.occurredAt,
      },
      tx,
    );
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "credit_note_refunded",
      data: {
        credit_note: cn.publicId,
        amount_minor: Number(requested),
        currency: cn.currency,
        available_minor: Number(nowAvail),
        offline: true,
        method: input.method,
        ...(input.reference ? { reference: input.reference } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    // P4: an offline refund is a human ASSERTION that cash left the building — no
    // gateway corroborates it — so the actor, the origin IP, the reference and the
    // reason they typed are the whole audit value. Same tx as the ledger + transaction rows.
    await auditCn(tx, {
      organizationId,
      businessId,
      action: "credit_note.record_refund",
      resourceType: "credit_note",
      resourceId: cn.publicId,
      before: {
        refunded_minor: Number(cn.refundedMinor),
        paid_out_minor: Number(cn.paidOutMinor),
        available_minor: Number(available),
        status: cn.status,
      },
      after: {
        refunded_minor: Number(refundedMinor),
        paid_out_minor: Number(paidOutMinor),
        available_minor: Number(nowAvail),
        status: updated!.status,
        method: input.method,
        reference: input.reference ?? null,
        reason: input.reason ?? null,
      },
    });
    return updated!;
  });
}

/**
 * Record the amount a payout actually cleared and settle the CN's status:
 * `refunded` only when everything drawn has BOTH left the bucket and been paid
 * to the customer; otherwise it stays `refund_due` (sweep retries the gap).
 */
async function settleCnPayout(
  organizationId: string,
  businessId: string,
  cnId: string,
  paidOut: bigint,
): Promise<CreditNote> {
  return withTenant(organizationId, async (tx) => {
    const [cn] = await tx.select().from(creditNotes).where(eq(creditNotes.id, cnId)).limit(1);
    if (!cn) throw new CreditNoteError("Credit note vanished during payout");
    const paidOutMinor = cn.paidOutMinor + (paidOut > 0n ? paidOut : 0n);
    const fullyDrawn = creditNoteAvailable(cn) === 0n;
    const fullyPaid = paidOutMinor >= cn.refundedMinor;
    if (!fullyPaid) {
      log.error(
        "REFUNDS PAYABLE OUTSTANDING: a credit note is booked but not paid out — the payout sweep will retry",
        {
          event: "cn_refund_payable_outstanding",
          creditNote: cn.publicId,
          outstandingMinor: cn.refundedMinor - paidOutMinor,
          bookedMinor: cn.refundedMinor,
          paidOutMinor,
          currency: cn.currency,
        },
      );
    }
    const [updated] = await tx
      .update(creditNotes)
      .set({
        paidOutMinor,
        status:
          cn.status === "voided" ? "voided" : fullyDrawn && fullyPaid ? "refunded" : "refund_due",
        // Release the lease. Cleared even when the payout only PARTLY settled: what is left is
        // genuinely outstanding, and the sweep must be free to pick it up on its next pass —
        // holding the lease there would strand exactly the money the sweep exists to chase.
        payoutAttemptAt: null,
      })
      .where(eq(creditNotes.id, cnId))
      .returning();
    return updated!;
  });
}

/**
 * Clock pass: retry outstanding CN payouts (refunded_minor > paid_out_minor) —
 * a gateway decline must leave a RETRIABLE obligation, not a stranded liability.
 */
/**
 * How long ONE gateway payout may legitimately be in flight before the sweep assumes the
 * process attempting it has died and reclaims the payable.
 *
 * Deliberately generous. Too short and the sweep reintroduces the duplicate-refund race it
 * exists to stop; too long and a genuinely stranded payable — money owed to a customer —
 * waits that much longer for its retry. A gateway refund call is seconds, so five minutes is
 * two orders of magnitude of headroom on the fast path while still bounding the slow one.
 */
export const CN_PAYOUT_LEASE_MS = 5 * 60_000;

export async function sweepOutstandingCnPayouts(): Promise<{ retried: number; cleared: number }> {
  const { systemDb: db } = await import("@/platform/db");
  // SKIP WHAT IS ALREADY IN FLIGHT. `refunded_minor > paid_out_minor` is true both for a
  // stranded payable AND for one mid-gateway-call, and the sweep could not tell them apart:
  // on 2026-08-25 it re-sent a refund 1.4 seconds after that refund had already succeeded
  // (Stripe: "charge has already been refunded" — it was a FULL refund, so there was nothing
  // left to send; a partial one would have gone out twice).
  //
  // The lease EXPIRES rather than blocking, because a process that dies between the earmark
  // and the settle must not strand the payable forever — reclaiming exactly that is what this
  // sweep is for. `CN_PAYOUT_LEASE` is the how-long-can-one-payout-legitimately-take bound.
  const leaseCutoff = new Date(Date.now() - CN_PAYOUT_LEASE_MS);
  const rows = await db
    .select()
    .from(creditNotes)
    .where(
      and(
        eq(creditNotes.kind, "refundable"),
        sql`${creditNotes.refundedMinor} > ${creditNotes.paidOutMinor}`,
        ne(creditNotes.status, "voided"),
        or(isNull(creditNotes.payoutAttemptAt), lt(creditNotes.payoutAttemptAt, leaseCutoff)),
        scanBusinessFilter(creditNotes.businessId),
      ),
    );
  let retried = 0;
  let cleared = 0;
  for (const cn of rows) {
    try {
      // CLAIM IT before calling a gateway, so two ticks (or a tick and a manual retry) cannot
      // both attempt the same payable — the very race this sweep just caused against the live
      // path. Conditional on the lease still being what we read, so exactly one claimant wins.
      const claimed = await withTenant(cn.organizationId, (tx) =>
        tx
          .update(creditNotes)
          .set({ payoutAttemptAt: new Date() })
          .where(
            and(
              eq(creditNotes.id, cn.id),
              cn.payoutAttemptAt == null
                ? isNull(creditNotes.payoutAttemptAt)
                : eq(creditNotes.payoutAttemptAt, cn.payoutAttemptAt),
            ),
          )
          .returning({ id: creditNotes.id }),
      );
      if (claimed.length === 0) continue;
      retried++;
      const gap = cn.refundedMinor - cn.paidOutMinor;
      const { paidOut, lastError } = await payOutRefundsPayable({
        organizationId: cn.organizationId,
        businessId: cn.businessId,
        invoiceId: cn.invoiceId,
        amountMinor: gap,
        currency: cn.currency,
        reason: `refundable credit note payout retry (${cn.publicId})`,
        creditNoteId: cn.id,
      });
      if (paidOut > 0n) {
        await settleCnPayout(cn.organizationId, cn.businessId, cn.id, paidOut);
        if (paidOut >= gap) cleared++;
      }
      // Whatever the gateway refused again goes back to `available` instead of staying
      // stranded as an earmark forever — this also heals gaps booked before reversal
      // semantics existed.
      if (paidOut < gap) {
        await reverseCnRefundEarmark({
          organizationId: cn.organizationId,
          businessId: cn.businessId,
          cnId: cn.id,
          amountMinor: gap - paidOut,
          reason: lastError,
        });
        cleared++;
      }
    } catch (e) {
      // Isolate — retried next tick. Logged because an outstanding payout that
      // fails EVERY tick is money owed to a customer that nothing else reports.
      log.error(e, {
        event: "cn_payout_retry_failed",
        creditNote: cn.publicId,
        businessId: cn.businessId,
      });
    }
  }
  return { retried, cleared };
}

/**
 * Execute the actual gateway payout that clears a booked `refunds_payable` for
 * `amountMinor` against a source invoice's succeeded payments (dr refunds_payable
 * / cr cash on settle). Splits across payments by their remaining-refundable cap.
 * Best-effort: a gateway decline / a shortfall of refundable payments leaves the
 * remainder as an outstanding payable (retriable). Returns the amount paid out.
 */
/**
 * The cash on ONE INVOICE that a gateway can still reverse: every succeeded
 * payment against it, less refunds the gateway has already accepted, oldest
 * first. `totalMinor === 0n` means a gateway refund of that invoice is
 * impossible — there is no charge to send back.
 *
 * Exported and shared on purpose. `payOutRefundsPayable` SPENDS this list and
 * `getCreditNoteDetail` REPORTS it so the dashboard can decide whether to offer
 * the gateway-refund control at all. Those two must never disagree, or the UI
 * offers a button whose payout then finds nothing — which is the shape of the
 * bug this whole helper came out of. Do not inline a second copy of this scan.
 *
 * NOT to be confused with the refundable-credit CAPS, which differ deliberately:
 * `issueRefundableCreditNote` caps at cash received (it mints NEW cashable
 * credit), while `subscriptions/cancellation-credit.ts` caps at
 * `cashPaid + refundableApplied` (it RETURNS credit the customer already held —
 * a refundable CN is how refundable balance comes back, see the REFUNDABLE_CREDIT
 * credit in `createRefundableCreditNote`). Both caps can hit the same dead end ("No
 * refundable payments present"); see D-cn-cap in docs/PROGRESS.md.
 */
export async function gatewayRefundableForInvoice(
  tx: Tx,
  invoiceId: string,
  /** Leave out offline payments: only money a card or bank gateway can reverse. */
  opts: { gatewayOnly?: boolean } = {},
): Promise<{ totalMinor: bigint; pays: Array<{ publicId: string; remaining: bigint }> }> {
  const pays = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.invoiceId, invoiceId),
        eq(payments.status, "succeeded"),
        opts.gatewayOnly ? ne(payments.providerKey, "offline") : undefined,
      ),
    )
    .orderBy(asc(payments.createdAt));
  const out: Array<{ publicId: string; remaining: bigint }> = [];
  for (const p of pays) {
    const prior = await tx.select().from(refunds).where(eq(refunds.paymentId, p.id));
    // A pending refund is money already promised back: it is not refundable again.
    const refunded = prior
      .filter(
        (r) => r.status === "succeeded" || r.status === "pending" || r.notFoundState === "open",
      )
      .reduce((s, r) => s + r.amountMinor, 0n);
    const remaining = p.amountMinor - refunded;
    if (remaining > 0n) out.push({ publicId: p.publicId, remaining });
  }
  return { totalMinor: out.reduce((s, p) => s + p.remaining, 0n), pays: out };
}

/**
 * The one gateway account a refund of this invoice goes through, for the balance shown
 * beside a refund. Scans the payments the payout scans, and resolves each with
 * `refundGatewayAccount`, as the refund does. Null when none resolves, or when several
 * accounts took the payments: the payout then picks the payment, so no single balance applies.
 */
export async function invoiceRefundGatewayAccount(
  organizationId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<{ id: string; label: string; gatewayKey: string } | null | undefined> {
  return withTenant(organizationId, async (tx) => {
    const [inv] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    if (!inv) return undefined;
    const { pays } = await gatewayRefundableForInvoice(tx, inv.id, { gatewayOnly: true });
    const found = new Map<string, { id: string; label: string; gatewayKey: string }>();
    for (const leg of pays) {
      const [p] = await tx
        .select()
        .from(payments)
        .where(eq(payments.publicId, leg.publicId))
        .limit(1);
      if (!p) continue;
      const acc = await refundGatewayAccount(tx, {
        businessId,
        paymentId: p.id,
        paymentMethodId: p.paymentMethodId,
        providerKey: p.providerKey,
      });
      if (!acc) return null;
      found.set(acc.id, { id: acc.publicId, label: acc.label, gatewayKey: acc.gatewayKey });
    }
    return found.size === 1 ? [...found.values()][0]! : null;
  });
}

/**
 * Cash actually reversed against these payments, straight from the `refunds` table.
 *
 * The payout loop's `paidOut += amt` counter is NOT ground truth: a leg can succeed AT THE
 * GATEWAY and then throw during bookkeeping, in which case the money is gone and the
 * counter never learns. The caller then reverses an earmark for cash that has left, and
 * the credit note ends up advertising a balance the customer has already been paid —
 * measured 2026-08-25 as `refunded=0 / paidOut=2149031` (5efeec0, reverted).
 * A multi-leg payout multiplies the chances of hitting exactly that.
 */
async function succeededRefundTotal(
  organizationId: string,
  paymentPublicIds: string[],
): Promise<bigint> {
  if (!paymentPublicIds.length) return 0n;
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ amountMinor: refunds.amountMinor })
      .from(refunds)
      .innerJoin(payments, eq(refunds.paymentId, payments.id))
      // PENDING COUNTS: the gateway accepted it and `refundPayment` already booked the cash
      // out. Counting only `succeeded` reversed the earmark of a refund still settling, so a
      // pending refund that later landed paid the customer twice (cash and credit). A refund
      // that fails releases its own amount (`releaseFailedCnPayoutTx`).
      .where(
        and(
          inArray(payments.publicId, paymentPublicIds),
          inArray(refunds.status, ["pending", "succeeded"]),
        ),
      );
    return rows.reduce((sum, r) => sum + r.amountMinor, 0n);
  });
}

/**
 * The gateway-reversible payments that can fund a payout for a note on `invoiceId`,
 * ordered: the note's OWN invoice first, then the rest of the customer's invoices in the
 * same currency (capped per sibling by `refundableCapacityForInvoice` so a payout can
 * never spend cash another live note is a claim on).
 *
 * Shared on purpose. `refundCreditNote` VALIDATES against this list and
 * `payOutRefundsPayable` SPENDS from it; if they ever disagreed we would accept a refund
 * we cannot execute.
 */
async function gatewayFundingLegs(
  organizationId: string,
  invoiceId: string,
  opts: { gatewayOnly?: boolean } = {},
): Promise<{
  invoicePublicId: string | null;
  pays: Array<{ publicId: string; remaining: bigint }>;
}> {
  return withTenant(organizationId, async (tx) => {
    const [inv] = await tx
      .select({
        publicId: invoices.publicId,
        customerId: invoices.customerId,
        currency: invoices.currency,
      })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    // The note's OWN invoice first. Its cash is what this note is a claim on, so it is
    // spent before anything else — which keeps the ordinary case byte-identical to the
    // pre-2026-08-25 behaviour.
    const own = await gatewayRefundableForInvoice(tx, invoiceId, opts);
    const pays = [...own.pays];
    // Then the REST of the customer's invoices, in the same currency. Gateway-reversible
    // cash pools across a customer's invoices; we scoped it to one, so a note attached to
    // a credit-funded invoice could not reach the cash the customer had actually paid —
    // INR 21,140.24 payable against a note whose own invoice had collected only INR
    // 350.07, on a customer holding 21,493.31 across invoices. That is the shape that left
    // 2114024 of refundable credit real on our books and unreachable by card.
    if (inv?.customerId) {
      const siblings = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.customerId, inv.customerId), eq(invoices.currency, inv.currency)))
        .orderBy(asc(invoices.createdAt));
      for (const sib of siblings) {
        if (sib.id === invoiceId) continue;
        // Only cash that invoice's OWN live credit notes have not already claimed.
        // `refundableCapacityForInvoice` is exactly that figure
        // (paid − gatewayRefunded − (liveRefundableCNs − paidOut)). Without this cap a
        // payout here could spend cash another note is a claim on, and the customer would
        // end up owed more than the business ever collected — the same over-exposure
        // `4ca4147` closed on the direct-refund path, arrived at from the other side.
        const { available } = await refundableCapacityForInvoice(tx, sib.id);
        if (available <= 0n) continue;
        let room = available;
        const sibPays = await gatewayRefundableForInvoice(tx, sib.id, opts);
        for (const p of sibPays.pays) {
          if (room <= 0n) break;
          const take = p.remaining < room ? p.remaining : room;
          pays.push({ publicId: p.publicId, remaining: take });
          room -= take;
        }
      }
    }
    return { invoicePublicId: inv?.publicId ?? null, pays };
  });
}

async function payOutRefundsPayable(input: {
  organizationId: string;
  businessId: string;
  invoiceId: string;
  amountMinor: bigint;
  currency: string;
  reason?: string;
  /** Internal id of the CN being paid out — stamps refund transactions for the CN timeline. */
  creditNoteId?: string;
  gatewayOnly?: boolean;
}): Promise<{ paidOut: bigint; lastError: string | null; legsAttempted: number }> {
  const { organizationId, businessId } = input;
  if (input.amountMinor <= 0n) return { paidOut: 0n, lastError: null, legsAttempted: 0 };
  const funding = await gatewayFundingLegs(organizationId, input.invoiceId, {
    gatewayOnly: input.gatewayOnly,
  });
  let remaining = input.amountMinor;
  // Kept only to decide how much to ATTEMPT per leg; the figure returned to the caller is
  // re-derived from `refunds` below, because this counter cannot see a gateway success
  // whose bookkeeping threw.
  let attributed = 0n;
  let lastError: string | null = null;
  const legPublicIds = funding.pays.map((p) => p.publicId);
  const refundedBefore = await succeededRefundTotal(organizationId, legPublicIds);
  // How many payout legs we actually handed to a provider. ZERO is a completely
  // different failure from "every leg declined" — see the throw in
  // `refundCreditNote`, which used to report both as a gateway decline.
  let legsAttempted = 0;
  // ONE PAYMENT PER CALL — adopted deliberately (2026-08-25). A note with 21,490.31
  // available over two payments (350.07 and 21,143.24) is REFUSED in full and names
  // 21,140.24; that amount clears, then the remaining 350.07 clears in its own call.
  // The unit is the PAYMENT, and the full amount is reachable in N calls.
  //
  // It is a design, not a limit: one request maps 1:1 onto ONE gateway operation, so it
  // has one id, one status, one outcome, and cannot half-succeed. Fanning out inside a
  // single call is exactly how tmbilling produced `refunded=0 / paidOut=2149031` — leg 1
  // paid, a reversal fired, leg 2 landed after (`eafcc03`). Under this rule that state is
  // unreachable, so this replaces the ordering fix's *mitigation* with prevention.
  //
  // `refundCreditNote` has already refused anything that does not fit one payment, so the
  // first leg with room covers the whole request; own invoice is preferred by ordering.
  const leg = funding.pays.find((p) => p.remaining >= remaining) ?? funding.pays[0];
  for (const p of leg ? [leg] : []) {
    if (remaining <= 0n) break;
    const amt = p.remaining < remaining ? p.remaining : remaining;
    legsAttempted += 1;
    try {
      await refundPayment({
        organizationId,
        businessId,
        paymentPublicId: p.publicId,
        amountMinor: Number(amt),
        reason:
          input.reason ??
          `refundable credit note payout${funding.invoicePublicId ? ` (invoice ${funding.invoicePublicId})` : ""}`,
        contraAccount: "refunds_payable",
        creditNoteId: input.creditNoteId,
      });
      attributed += amt;
      remaining -= amt;
    } catch (e) {
      // Gateway declined / unavailable — leave the payable outstanding (retriable
      // by sweepOutstandingCnPayouts). Loud: a silent catch made stranded payables
      // operationally invisible (G review). refundPayment() already records a
      // failed `refund` transaction + `refund_failed` event for provider-side
      // declines and unresolved-provider errors — this ALSO emits a CN-scoped
      // event so a payout leg failure is durable/visible from the credit note's
      // own timeline (the dashboard surfaces refund_due CNs from here), not just
      // console-only.
      const message = e instanceof Error ? e.message : "CN payout leg failed";
      log.error(e, { stage: "cn_payout_leg", payment: p.publicId });
      lastError = message;
      // RefundError legs were already recorded by refundPayment (failed refund
      // transaction stamped with the CN). Raw provider throws (e.g. Stripe SDK
      // exceptions like insufficient balance) were NOT — record them here so the
      // decline + its reason show up on the CN's own timeline.
      if (!(e instanceof RefundError)) {
        try {
          const [pay] = await withTenant(organizationId, (tx) =>
            tx.select().from(payments).where(eq(payments.publicId, p.publicId)).limit(1),
          );
          await recordTransaction({
            organizationId,
            businessId,
            customerId: pay?.customerId ?? null,
            type: "refund",
            status: "failed",
            amountMinor: amt,
            currency: input.currency,
            gatewayAccountId: null,
            gatewayKey: pay?.providerKey ?? null,
            idAtGateway: null,
            paymentId: pay?.id ?? null,
            invoiceId: input.invoiceId,
            creditNoteId: input.creditNoteId ?? null,
            errorCode: "refund_failed",
            errorText: message,
          });
        } catch (recordErr) {
          log.error(recordErr, { event: "cn_payout_transaction_not_recorded" });
        }
      }
      /**
       * The `refund` key is what makes this enrichable. `resourceTypeOf("refund_failed")`
       * is `refund` and `deriveResourceId` reads `data.refund`; with the id sitting at the
       * TOP level instead, `buildEventContent` returned before its switch and the event
       * shipped with no invoice, no customer and no subscription — a refund failure a
       * consumer could not attribute to anyone.
       *
       * It carries `invoice` rather than relying on its own id: the minted `re_…` names a
       * refund that does not exist (the refund FAILED), so no loader can resolve it, while
       * the invoice ref enriches invoice → customer → subscription in one hop.
       *
       * The flat keys stay exactly as they were. Consumers read `data.id` / `data.payment`
       * today, and this event is live — the key is added, nothing is moved.
       */
      const failedRefundId = publicId("re");
      const refundInvoice = await withTenant(organizationId, (tx) =>
        loadInvoicePublicId(tx, input.invoiceId),
      );
      await withTenant(organizationId, (tx) =>
        emitEvent(tx, {
          organizationId,
          businessId,
          type: "refund_failed",
          data: {
            id: failedRefundId,
            payment: p.publicId,
            credit_note: input.creditNoteId ?? null,
            amount_minor: Number(amt),
            currency: input.currency,
            reason: message,
            refund: {
              id: failedRefundId,
              payment: p.publicId,
              invoice: refundInvoice,
            },
          },
        }),
      );
    }
  }
  // What the gateway ACTUALLY reversed during this call. `attributed` is reported only
  // when they disagree, which is the signal that a leg paid out and failed to record.
  const refundedAfter = await succeededRefundTotal(organizationId, legPublicIds);
  const paidOut = refundedAfter - refundedBefore;
  if (paidOut !== attributed) {
    log.error(
      "CN PAYOUT ACCOUNTING MISMATCH: attribution disagrees with the refunds table — trusting the refunds " +
        "table, so the earmark is reversed against cash that actually left, not against the counter",
      {
        event: "cn_payout_accounting_mismatch",
        creditNote: input.creditNoteId ?? null,
        attributedMinor: Number(attributed),
        actualMinor: Number(paidOut),
        currency: input.currency,
      },
    );
  }
  return { paidOut: paidOut > 0n ? paidOut : 0n, lastError, legsAttempted };
}

/**
 * FIFO-allocate a refundable-bucket DRAW (made at invoice generation) across the
 * customer's open refundable CNs — provenance tracking so `allocated` reflects
 * credit spent on invoices. Runs INSIDE the invoice transaction (bucket ledger was
 * already posted by the balance split). Returns the amount actually attributed to
 * CNs (≤ draw; the rest was non-CN refundable credit).
 */
export async function allocateRefundableDraw(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    invoiceId: string;
    invoicePublicId: string;
    currency: string;
    drawMinor: bigint;
    /** True when the draw is part of CREATING the target invoice: its invoice_generated
     *  already reflects the applied credits, and a same-request credit-note create+consume
     *  nets the balance out — so suppress the derived customer_changed + invoice_updated
     *  here. Neither belongs on the new invoice — `invoice_generated` plus a single
     *  `customer_changed` already covers it, and firing them was over-emission. Allocation
     *  to an EXISTING invoice (default) still emits both. */
    suppressBalanceInvoiceEvents?: boolean;
    /** Draw from these notes only (internal ids), in this order. Omit → oldest first. */
    creditNoteIds?: string[];
  },
): Promise<bigint> {
  if (input.drawMinor <= 0n) return 0n;
  const all = await tx
    .select()
    .from(creditNotes)
    .where(
      and(
        eq(creditNotes.customerId, input.customerId),
        eq(creditNotes.kind, "refundable"),
        eq(creditNotes.currency, input.currency),
      ),
    )
    .orderBy(asc(creditNotes.createdAt));
  const chosen = input.creditNoteIds;
  const open = chosen ? chosen.flatMap((id) => all.filter((cn) => cn.id === id)) : all;
  let remaining = input.drawMinor;
  for (const cn of open) {
    if (remaining <= 0n) break;
    if (cn.status === "voided") continue;
    const avail = creditNoteSpendable(cn);
    if (avail <= 0n) continue;
    const alloc = avail < remaining ? avail : remaining;
    await tx.insert(creditNoteAllocations).values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      creditNoteId: cn.id,
      invoiceId: input.invoiceId,
      amountMinor: alloc,
    });
    const allocatedMinor = cn.allocatedMinor + alloc;
    assertInvariant({ totalMinor: cn.totalMinor, allocatedMinor, refundedMinor: cn.refundedMinor });
    // A refundable CN fully consumed by allocation is 'refunded' (settled). A
    // partially-allocated CN stays 'refund_due' (cash refund still open).
    const fullyConsumed = cn.totalMinor - allocatedMinor - cn.refundedMinor <= 0n;
    const statusPatch =
      fullyConsumed && cn.status === "refund_due" ? { status: "refunded" as const } : {};
    await tx
      .update(creditNotes)
      .set({ allocatedMinor, ...statusPatch })
      .where(eq(creditNotes.id, cn.id));
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_note_allocated",
      data: {
        credit_note: cn.publicId,
        invoice: input.invoicePublicId,
        amount_minor: Number(alloc),
        currency: input.currency,
      },
    });
    remaining -= alloc;
  }
  const drawn = input.drawMinor - remaining;
  if (drawn > 0n && !input.suppressBalanceInvoiceEvents) {
    // Available refundable balance went down → customer_changed; the target invoice
    // gained applied credits → invoice_updated. Suppressed when the draw
    // is part of the target invoice's own creation (see suppressBalanceInvoiceEvents).
    await emitCustomerChanged(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customerId,
    });
    await emitInvoiceUpdated(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      invoicePublicId: input.invoicePublicId,
    });
  }
  return drawn;
}

/**
 * The EXACT INVERSE of `allocateRefundableDraw`, for an invoice that has just been
 * VOIDED (#57). Runs inside `voidInvoice`'s transaction, alongside the compensating
 * ledger entry that gives the bucket its money back.
 *
 * ── Why this has to exist ─────────────────────────────────────────────────────
 * The void path posted a flawless compensating entry — `invoice_void` mirroring
 * `credit_applied`, append-only, so the LEDGER released the credit correctly — and left
 * every denormalised satellite behind. Measured 2026-09-04 on a live INR reactivation
 * that failed at the gateway: the allocation row still pointed at the voided invoice,
 * `allocated_minor` still read the whole ₹9,661.13 draw, and the status had been flipped
 * `refund_due` → `refunded` with `refunded_minor` and `paid_out_minor` both 0 — a status
 * that was simply false, nothing had been refunded.
 *
 * That BLOCKED the customer's own money, in both write paths: `creditNoteAvailable`
 * (`total − allocated − refunded`) read 0, so `refundCreditNote` and
 * `recordOfflineCnRefund` refused a full refund with "Refund amount must be positive" and
 * an explicit one with "exceeds available 0" — while the line immediately after the guard
 * in each reads the LEDGER, which would have said the money was there. And the next
 * invoice diverged rather than merely reporting stale: the loop above skips a note whose
 * `avail <= 0`, so credit APPLICATION (ledger-driven) applied ₹9,661.13 that ALLOCATION
 * (note-driven) recorded nowhere. The funding record, not a counter, went wrong.
 *
 * Note that `total = allocated + refunded + available` HELD throughout that
 * (966113 = 966113 + 0 + 0), which is why no guard caught it: the invariant is arithmetic
 * and the defect was substantive. The evidence that this is fixed has to compare the note
 * against the LEDGER, and `verify:apply-credits` §9G does exactly that.
 *
 * ── DELETE, not a negative reversal row ───────────────────────────────────────
 * The compensating-entry style is the house rule for the LEDGER, which is append-only by
 * locked decision and guarded by a hook. `credit_note_allocations` is a denormalised
 * satellite with no such contract, and the house style for those is to rewrite them and
 * let the ledger carry the immutable history — `invoicing/service.ts` deletes
 * `applied_taxes` + `invoice_line_items` when it re-derives an invoice, and
 * `reverseCnRefundEarmark` right below DECREMENTS `refunded_minor` rather than booking a
 * negative counter.
 *
 * A negative row was the alternative and was rejected on evidence: the table has no
 * `kind`/`reverses` column, so every reader treats `amount_minor` as a positive
 * allocation. It would serialise out of `GET /credit_notes/:id` as
 * `{"object":"credit_note_allocation","amount_minor":-966113}` and render on the CN
 * timeline as "Allocated −₹9,661.13 was allocated to invoice inv_…" — a control that
 * lies. Making it honest needs an API-contract change, an openapi change and a dashboard
 * change, which is a much larger surface than the defect. Deleting keeps the surface
 * truthful: the release is recorded in the LEDGER (`credit_applied` + `invoice_void`, both
 * carrying the invoice's public id), in `invoice_voided`, and in the `invoice.void` audit
 * row, whose `after` now carries `credit_released_minor` so the amount is on the audited
 * path rather than only derivable.
 *
 * ── Only REFUNDABLE notes ─────────────────────────────────────────────────────
 * An adjustment note self-allocates to the invoice it reduces and books
 * `credit_adjustments`/`bad_debt` → AR, a posting `voidInvoice` does NOT mirror (it
 * reverses `invoice`, `import` and `credit_applied` only). Its credit therefore was NOT
 * given back, and releasing its allocation would invent availability on a note whose
 * credit lives in no bucket at all — the same false claim of spendable money, pointing
 * the other way. Same principle as the fix itself: the satellite moves only where the
 * ledger moved.
 *
 * Returns the total released (0 when the invoice consumed no credit-note credit).
 */
export async function releaseAllocationsForVoidedInvoice(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    invoiceId: string;
    invoicePublicId: string;
  },
): Promise<bigint> {
  // The same advisory lock every other writer of these counters takes, so a concurrent
  // refund or allocation cannot read `allocated_minor` across this release.
  await lockCustomerBalances(tx, input.customerId);
  const rows = await tx
    .select({ alloc: creditNoteAllocations, cn: creditNotes })
    .from(creditNoteAllocations)
    .innerJoin(creditNotes, eq(creditNoteAllocations.creditNoteId, creditNotes.id))
    .where(
      and(
        eq(creditNoteAllocations.businessId, input.businessId),
        eq(creditNoteAllocations.invoiceId, input.invoiceId),
        eq(creditNotes.kind, "refundable"),
      ),
    );
  if (rows.length === 0) return 0n;
  const byNote = new Map<string, { cn: CreditNote; released: bigint; allocIds: string[] }>();
  for (const r of rows) {
    const e = byNote.get(r.cn.id) ?? { cn: r.cn, released: 0n, allocIds: [] };
    e.released += r.alloc.amountMinor;
    e.allocIds.push(r.alloc.id);
    byNote.set(r.cn.id, e);
  }
  let releasedTotal = 0n;
  for (const { cn, released, allocIds } of byNote.values()) {
    await tx.delete(creditNoteAllocations).where(inArray(creditNoteAllocations.id, allocIds));
    // `released` is summed from the rows themselves, so it can only exceed the column if
    // the column was ALREADY behind its rows — which the `credit_note_allocations_reconcile`
    // ops check reports as critical. Refuse to write a negative counter (and say so) rather
    // than either throwing, which would block an operator's void on pre-existing bad data,
    // or silently carrying the corruption forward.
    let allocatedMinor = cn.allocatedMinor - released;
    if (allocatedMinor < 0n) {
      log.error("credit note allocated_minor was behind its allocation rows", {
        event: "cn_allocation_release_underflow",
        creditNote: cn.publicId,
        invoice: input.invoicePublicId,
        allocatedMinor: String(cn.allocatedMinor),
        releasedMinor: String(released),
      });
      allocatedMinor = 0n;
    }
    assertInvariant({
      totalMinor: cn.totalMinor,
      allocatedMinor,
      refundedMinor: cn.refundedMinor,
    });
    // The inverse of the allocation loop's status rule, and only that: allocation flips a
    // FULLY consumed `refund_due` note to `refunded` (settled), so releasing
    // credit that makes it no longer fully consumed flips it back — the cash refund is open
    // again for the freed slice. A note whose `refunded` came from a payout that actually
    // CLEARED keeps it (it stays fully consumed by `refunded_minor`), and a `voided` note
    // stays voided.
    const stillConsumed = cn.totalMinor - allocatedMinor - cn.refundedMinor <= 0n;
    const statusPatch =
      cn.status === "refunded" && !stillConsumed ? { status: "refund_due" as const } : {};
    await tx
      .update(creditNotes)
      .set({ allocatedMinor, ...statusPatch })
      .where(eq(creditNotes.id, cn.id));
    releasedTotal += released;
    log.info("credit note allocation released by an invoice void", {
      event: "cn_allocation_released",
      creditNote: cn.publicId,
      invoice: input.invoicePublicId,
      releasedMinor: String(released),
      allocatedMinor: String(allocatedMinor),
      status: statusPatch.status ?? cn.status,
      currency: cn.currency,
    });
  }
  return releasedTotal;
}

/**
 * Void a credit note (CN-3) by mirroring its ledger entries (the voidInvoice
 * pattern — never re-derive amounts). Forbidden once any of it has been refunded
 * to cash, or (refundable) allocated to invoices — that credit is already spent.
 * Voiding an adjustment CN reopens the invoice it reduced.
 */
export async function voidCreditNote(input: {
  organizationId: string;
  businessId: string;
  creditNotePublicId: string;
}): Promise<CreditNote> {
  const { organizationId, businessId } = input;
  return withTenant(organizationId, async (tx) => {
    const [stale] = await tx
      .select({ customerId: creditNotes.customerId })
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.businessId, businessId),
          eq(creditNotes.publicId, input.creditNotePublicId),
        ),
      )
      .limit(1);
    if (!stale)
      throw new CreditNoteError(
        `We could not find the credit note ${input.creditNotePublicId}.`,
        "not_found",
      );
    // Lock BEFORE reading the row we validate against — a concurrent refund/
    // allocation must not slip between the refunded/allocated guards and the void.
    await lockCustomerBalances(tx, stale.customerId);
    const [cn] = await tx
      .select()
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.businessId, businessId),
          eq(creditNotes.publicId, input.creditNotePublicId),
        ),
      )
      .limit(1);
    if (!cn)
      throw new CreditNoteError(
        `We could not find the credit note ${input.creditNotePublicId}.`,
        "not_found",
      );
    if (cn.status === "voided") throw new CreditNoteError("The credit note is already voided");
    if (cn.refundedMinor > 0n)
      throw new CreditNoteError("You cannot void a credit note that is refunded to cash");
    if (cn.kind === "refundable" && cn.allocatedMinor > 0n)
      throw new CreditNoteError(
        "You cannot void a refundable credit note when its credit is already applied to invoices",
      );

    // Mirror the exact issue postings → a balanced compensating entry. An imported note
    // posted its opening credit under `import`, and only for what was still available.
    const originals = await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.businessId, businessId),
          inArray(ledgerEntries.sourceType, ["credit_note", "import"]),
          eq(ledgerEntries.sourceId, cn.publicId),
        ),
      );
    if (cn.kind === "refundable") {
      // What THIS note put in the bucket — its total when issued here, less (or nothing)
      // when imported. Checking the total refused every imported note that opened no credit.
      const contributed = originals
        .filter((e) => e.account === REFUNDABLE_CREDIT && e.currency === cn.currency)
        .reduce((s, e) => s + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
      const bucket = await bucketBalance(tx, cn.customerId, REFUNDABLE_CREDIT, cn.currency);
      if (contributed > bucket)
        throw new CreditNoteError(
          "The refundable balance is too low. The credit is already used elsewhere.",
        );
    }
    const lines = originals.map((e) => ({
      account: e.account,
      direction: (e.direction === "debit" ? "credit" : "debit") as "debit" | "credit",
      amountMinor: e.amountMinor,
      currency: e.currency,
    }));
    if (lines.length > 0)
      await postEntries(
        {
          organizationId,
          businessId,
          customerId: cn.customerId,
          sourceType: "credit_note_void",
          sourceId: cn.publicId,
          lines,
        },
        tx,
      );

    // An adjustment CN reopens the invoice it reduced — but drift-proof (review fix):
    //  - never resurrect a VOIDED invoice (guard on status),
    //  - reopen only the GENUINELY OUTSTANDING portion, computed from the invoice
    //    total net of cash actually paid and any OTHER still-valid adjustment CNs
    //    (the old code blindly added cn.total to amount_due, resurrecting cash that
    //    was already collected).
    if (cn.kind === "adjustment") {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, cn.invoiceId)).limit(1);
      if (inv && inv.status !== "voided") {
        const cashPaid = (
          await tx
            .select({ amountMinor: payments.amountMinor })
            .from(payments)
            .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "succeeded")))
        ).reduce((s, p) => s + p.amountMinor, 0n);
        const otherAdjustments = (
          await tx
            .select()
            .from(creditNotes)
            .where(and(eq(creditNotes.invoiceId, inv.id), eq(creditNotes.kind, "adjustment")))
        )
          .filter((o) => o.id !== cn.id && o.status !== "voided")
          .reduce((s, o) => s + o.totalMinor, 0n);
        // Credit-bucket draws applied at generation reduced the due with no
        // payments row — they are settled value too (F review blocker: a
        // promo-covered slice was re-billed on void).
        const bucketApplied =
          (inv.promotionalCreditsAppliedMinor ?? 0n) +
          (inv.refundableCreditsAppliedMinor ?? 0n) +
          (inv.excessPaymentsAppliedMinor ?? 0n) +
          (inv.grantCreditsPreTaxMinor ?? 0n) +
          (inv.grantCreditsPostTaxMinor ?? 0n);
        // TWO FIGURES, because `amount_due_minor` and "is it settled" are not the same question.
        //
        // The stored column tracks the collectible NET OF CREDITS ONLY — cash is subtracted at
        // serialization (see `customers/collect.ts`, which states the same rule where it writes
        // the column). Writing a cash-net figure into it subtracts the cash TWICE: once here and
        // again when the invoice is served, so a part-paid invoice under-reports what it is owed
        // by exactly the amount already collected. Measured 2026-08-26: a 5000 invoice with 3000
        // of cash read `amount_due_minor = 2000` after a void, and `invoice_not_overpaid` then
        // called 3000 of cash against a "2000" invoice an over-collection — 60 invoices' worth of
        // a critical alarm, all traced back to this one subtraction.
        //
        // Cash still decides the STATUS: an invoice already covered by cash must not be dragged
        // back to payment_due just because a credit note was voided.
        const collectible = inv.totalMinor - bucketApplied - otherAdjustments;
        const outstanding = collectible - cashPaid;
        await tx
          .update(invoices)
          .set({
            amountDueMinor: collectible,
            ...(outstanding > 0n
              ? {
                  status: inv.attemptCount > 0 ? ("payment_due" as const) : ("posted" as const),
                  paidAt: null,
                  writtenOff: false,
                }
              : {}),
          })
          .where(eq(invoices.id, inv.id));
      }
    }
    const [updated] = await tx
      .update(creditNotes)
      .set({ status: "voided", voidedAt: stampNow() })
      .where(eq(creditNotes.id, cn.id))
      .returning();
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "credit_note_voided",
      data: {
        credit_note: cn.publicId,
        amount_minor: Number(cn.totalMinor),
        currency: cn.currency,
      },
    });
    // P4: mirrors `invoice.void`'s audit row — the append-only ledger means a void
    // is the closest thing to a deletion this system has, so it is the row an
    // auditor looks for first.
    await auditCn(tx, {
      organizationId,
      businessId,
      action: "credit_note.void",
      resourceType: "credit_note",
      resourceId: cn.publicId,
      before: { status: cn.status, voided_at: null },
      after: { status: "voided", voided_at: updated!.voidedAt?.toISOString() ?? null },
    });
    return updated!;
  });
}

/**
 * CN-2 refund flow: refund a paid invoice CORRECTLY — restore each CREDIT portion
 * to the bucket it came from, then return the CARD portion via the gateway.
 *
 * Ordering + idempotency (money-safety):
 *  - Restore FIRST, in one customer-locked transaction, guarded so a re-run
 *    (crash between restore and gateway refunds) never restores twice.
 *  - Promotional credit goes back to the PROMOTIONAL bucket (a fresh grant) —
 *    it is marketing liability and must never become cashable; excess goes back
 *    to the EXCESS bucket; only the refundable portion becomes a refundable CN.
 *  - Gateway refunds then run per payment against its REMAINING refundable
 *    amount, so a retry resumes where it stopped instead of throwing.
 */
export async function refundInvoiceViaCreditNote(input: {
  organizationId: string;
  businessId: string;
  invoicePublicId: string;
  reason?: string;
}): Promise<{
  cardRefundedMinor: number;
  creditRestoredMinor: number;
  creditNote: CreditNote | null;
}> {
  const { organizationId, businessId } = input;

  // 1) Restore the consumed credit, per bucket, atomically + idempotently.
  const restored = await withTenant(organizationId, async (tx) => {
    const inv = await loadInvoice(tx, businessId, input.invoicePublicId);
    if (!inv) throw new CreditNoteError(`We could not find the invoice ${input.invoicePublicId}.`);
    if (inv.status !== "paid")
      throw new CreditNoteError(
        `You can refund only a paid invoice. This invoice is ${inv.status}.`,
      );
    await lockCustomerBalances(tx, inv.customerId);

    const promoConsumed = inv.promotionalCreditsAppliedMinor ?? 0n;
    const refundableConsumed = inv.refundableCreditsAppliedMinor ?? 0n;
    const excessConsumed = inv.excessPaymentsAppliedMinor ?? 0n;

    // Idempotency guards: bucket restores are keyed on the invoice via a
    // dedicated sourceType; the refundable restore on a reason-coded CN.
    const [priorRestore] = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.businessId, businessId),
          eq(ledgerEntries.sourceType, "invoice_refund_restore"),
          eq(ledgerEntries.sourceId, inv.publicId),
        ),
      )
      .limit(1);
    const priorCns = await tx
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.invoiceId, inv.id), eq(creditNotes.kind, "refundable")));
    const priorRestoreCn =
      priorCns.find((c) => c.reasonCode === "refund_restore" && c.status !== "voided") ?? null;

    const bucketLines: Array<{
      account: string;
      direction: "debit" | "credit";
      amountMinor: bigint;
      currency: string;
    }> = [];
    if (!priorRestore && promoConsumed > 0n) {
      // Same shape as a promotional grant: dr promo expense / cr promo bucket.
      bucketLines.push(
        {
          account: "promotional_credit",
          direction: "debit",
          amountMinor: promoConsumed,
          currency: inv.currency,
        },
        {
          account: PROMOTIONAL_CREDIT,
          direction: "credit",
          amountMinor: promoConsumed,
          currency: inv.currency,
        },
      );
    }
    if (!priorRestore && excessConsumed > 0n) {
      bucketLines.push(
        {
          account: "credit_adjustments",
          direction: "debit",
          amountMinor: excessConsumed,
          currency: inv.currency,
        },
        {
          account: EXCESS_PAYMENT,
          direction: "credit",
          amountMinor: excessConsumed,
          currency: inv.currency,
        },
      );
    }
    if (bucketLines.length > 0) {
      await postEntries(
        {
          organizationId,
          businessId,
          customerId: inv.customerId,
          sourceType: "invoice_refund_restore",
          sourceId: inv.publicId,
          lines: bucketLines,
        },
        tx,
      );
      // `customer:` (PUBLIC id) or this enriches nothing — see the note on the twin
      // emit in `subscriptions/cancellation-credit.ts`. Added alongside `invoice`.
      const restoredFor = await loadCustomerPublicId(tx, inv.customerId);
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "customer_credits_restored",
        data: {
          customer: restoredFor,
          invoice: inv.publicId,
          promotional_minor: Number(promoConsumed),
          excess_minor: Number(excessConsumed),
          currency: inv.currency,
        },
      });
    }

    let creditNote: CreditNote | null = priorRestoreCn;
    if (!priorRestoreCn && refundableConsumed > 0n) {
      creditNote = await createRefundableCreditNote(tx, {
        organizationId,
        businessId,
        customerId: inv.customerId,
        invoiceId: inv.id,
        invoicePublicId: inv.publicId,
        currency: inv.currency,
        items: [
          {
            description: `Restored credit — refund of invoice ${inv.publicId}`,
            amountMinor: Number(refundableConsumed),
          },
        ],
        reasonCode: "refund_restore",
        reason: input.reason,
      });
    }
    // Credit grants the invoice drew go back to their grants (G3), never out as cash. Capped
    // at what is still drawn, so a repeat run or an earlier partial restore adds nothing.
    const { restoreGrantDraws } = await import("@/modules/credits/service");
    const grantsRestored = await restoreGrantDraws(tx, {
      organizationId,
      businessId,
      customerId: inv.customerId,
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      faceMinor: "all",
      ledger: true,
      sourceType: "invoice_refund_restore",
    });
    return {
      inv,
      creditNote,
      creditRestored: promoConsumed + refundableConsumed + excessConsumed + grantsRestored,
    };
  });
  const { inv, creditNote, creditRestored } = restored;

  // 2) Refund the card portion through the gateway — per payment, only what is
  //    still refundable, so a partially-completed earlier run resumes cleanly.
  const succeeded = await withTenant(organizationId, async (tx) => {
    const pays = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "succeeded")))
      .orderBy(desc(payments.createdAt));
    const out: Array<{ publicId: string; remaining: bigint }> = [];
    for (const p of pays) {
      const prior = await tx.select().from(refunds).where(eq(refunds.paymentId, p.id));
      const refunded = prior
        .filter((r) => r.status === "succeeded")
        .reduce((s, r) => s + r.amountMinor, 0n);
      out.push({ publicId: p.publicId, remaining: p.amountMinor - refunded });
    }
    return out;
  });
  let cardRefunded = 0n;
  for (const p of succeeded) {
    if (p.remaining <= 0n) continue;
    // `bucketsRestoredByCaller`: this function restores the promotional slice itself
    // (see `creditRestoredMinor` in its return) — without the flag `refundPayment`
    // would return a proportional slice on top and double-count it.
    await refundPayment({
      organizationId,
      businessId,
      paymentPublicId: p.publicId,
      amountMinor: Number(p.remaining),
      reason: input.reason ?? `refund invoice ${inv.publicId}`,
      bucketsRestoredByCaller: true,
    });
    cardRefunded += p.remaining;
  }

  return {
    cardRefundedMinor: Number(cardRefunded),
    creditRestoredMinor: Number(creditRestored),
    creditNote,
  };
}

// ── Compatibility shim + listing ──────────────────────────────────────────────

/**
 * Legacy entry point (pre-E4): `balance` → refundable CN; `refund` → refundable CN
 * that is immediately paid back to the card. New code should call the kind-specific
 * functions directly.
 */
export async function issueCreditNote(input: {
  organizationId: string;
  businessId: string;
  invoicePublicId: string;
  creditMethod: "refund" | "balance";
  items: CreditNoteItemInput[];
  reason?: string;
}): Promise<CreditNote> {
  if (input.creditMethod === "refund") {
    // Refund method: the invoice must have a succeeded payment to refund.
    const cn = await issueRefundableCreditNote({
      organizationId: input.organizationId,
      businessId: input.businessId,
      invoicePublicId: input.invoicePublicId,
      items: input.items,
      reason: input.reason,
    });
    const paid = await withTenant(input.organizationId, async (tx) => {
      const [inv] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.businessId, input.businessId),
            eq(invoices.publicId, input.invoicePublicId),
          ),
        )
        .limit(1);
      if (!inv) return false;
      const [p] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "succeeded")))
        .limit(1);
      return !!p;
    });
    if (!paid)
      throw new CreditNoteError(
        "You cannot refund the credit note. The invoice has no succeeded payment.",
      );
    // Refund the CN's credit back to the card (draws the bucket → cash out).
    return refundCreditNote({
      organizationId: input.organizationId,
      businessId: input.businessId,
      creditNotePublicId: cn.publicId,
    });
  }
  return issueRefundableCreditNote(input);
}

export async function listCreditNotes(
  organizationId: string,
  invoiceId: string,
): Promise<CreditNote[]> {
  return withTenant(organizationId, async (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoiceId)),
  );
}

// ── Paginated list (see docs/GUIDE.md §3.4 for the shared contract) ────────────

/**
 * The REPORTED `subtotal_minor`. A NULL column means "gross not recorded; it equals
 * total_minor" (the pre-0186 convention and every backfilled historical row), and the
 * serializer resolves it that way — so the filter has to coalesce too, or
 * `?subtotal_minor[gt]=0` drops every historical note while the list itself prints a
 * positive gross for each of them.
 */
const reportedSubtotalMinor: SQL = sql`coalesce(${creditNotes.subtotalMinor}, ${creditNotes.totalMinor})`;

/**
 * The REPORTED `available_minor` — `creditNoteAvailable` in SQL. Not a stored column:
 * available is derived from the invariant `total = allocated + refunded + available`,
 * so a filter on it must recompute the same subtraction the response prints.
 */
const availableMinor: SQL = sql`(case when ${creditNotes.status} = 'refunded' then 0 else greatest(${creditNotes.totalMinor} - ${creditNotes.allocatedMinor} - ${creditNotes.refundedMinor}, 0) end)`;

const LIST_FILTERS: Record<string, FilterSpec> = {
  id: { column: creditNotes.publicId, kind: "text" },
  number: { column: creditNotes.number, kind: "text" },
  kind: { column: creditNotes.kind, kind: "enum" },
  status: { column: creditNotes.status, kind: "enum" },
  reason_code: { column: creditNotes.reasonCode, kind: "enum" },
  // The free-text note an operator typed at issue time, next to the coded reason.
  reason: { column: creditNotes.reason, kind: "text" },
  currency: { column: creditNotes.currency, kind: "enum" },
  // Provenance: api | dashboard | system | import. Null on rows predating the column,
  // which `is_present` is the way to ask about.
  channel: { column: creditNotes.channel, kind: "enum" },
  // Archival rows carry no ledger postings, so "did we book this" is a real question
  // an operator reconciling the ledger against the credit-note list has to be able to ask.
  imported: { column: creditNotes.imported, kind: "bool" },
  // The four money figures the list prints, all four filterable — "notes with credit
  // still available" and "notes fully refunded" were both unaskable without them.
  subtotal_minor: { column: reportedSubtotalMinor, kind: "number" },
  total_minor: { column: creditNotes.totalMinor, kind: "number" },
  allocated_minor: { column: creditNotes.allocatedMinor, kind: "number" },
  refunded_minor: { column: creditNotes.refundedMinor, kind: "number" },
  available_minor: { column: availableMinor, kind: "number" },
  created_at: { column: creditNotes.createdAt, kind: "date" },
  // `status` records THAT a note was voided; this records when — the "Voided On"
  // column, and the only way to bound a void to a period.
  voided_at: { column: creditNotes.voidedAt, kind: "date" },
  invoice: { column: invoices.publicId, kind: "text" },
  // The subscription of the credited invoice (`sub_…`). A scalar subquery, not a join,
  // so the count and page queries keep their join set; null on a one-off invoice.
  subscription: {
    column: sql`(SELECT ${subscriptions.publicId} FROM ${subscriptions} WHERE ${subscriptions.id} = ${invoices.subscriptionId})`,
    kind: "text",
  },
  // The payer. Already joined for the list's Customer column and serialized as
  // `customer` / `customer_name` / `customer_email`; the three fields were printable
  // but not filterable, so "every credit note for this customer" needed the separate
  // `?customer=` scope and could not be combined into a saved view with anything else.
  customer: { column: customers.publicId, kind: "text" },
  customer_name: { column: accountHolderNameSql, kind: "text" },
  customer_email: { column: customers.email, kind: "text" },
};

export const CREDIT_NOTE_FILTER_OPS = opsFromSpecs(LIST_FILTERS);
export const CREDIT_NOTE_FILTER_KINDS = kindsFromSpecs(LIST_FILTERS);

const LIST_SORTS = {
  created_at: creditNotes.createdAt,
  total_minor: creditNotes.totalMinor,
  status: creditNotes.status,
  // Single-column sorts over the business's own notes — the same cost class as
  // `status` above. `number` sorts by its numeric suffix, so CN-10 follows CN-9.
  number: documentNumberSortKey(creditNotes.number),
  kind: creditNotes.kind,
  voided_at: creditNotes.voidedAt,
  refunded_minor: creditNotes.refundedMinor,
  // Arithmetic on three columns the row already carries; no extra read.
  available_minor: availableMinor,
} as const;

export type CreditNoteSortField = keyof typeof LIST_SORTS;
export const CREDIT_NOTE_SORT_FIELDS = Object.keys(LIST_SORTS) as CreditNoteSortField[];

export interface CreditNoteListFilters {
  /** Scope to one invoice (public id). */
  invoicePublicId?: string;
  /** Scope to one customer (internal id) — the customer-detail history tab. */
  customerId?: string;
  search?: string;
  filters?: ListFilter[];
  sortField?: string;
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
}

/**
 * One page of a business's credit notes, newest-first.
 *
 * Keyset on `(created_at DESC, public_id DESC)` via
 * `credit_notes_business_created_idx`. Items are loaded in **one** query for the
 * whole page — the unpaginated version issued a query per note (N+1) across every
 * credit note in the business.
 */
export async function listCreditNotesPage(
  organizationId: string,
  businessId: string,
  f: CreditNoteListFilters = {},
): Promise<ListPage<CreditNoteView>> {
  const limit = clampLimit(f.limit);
  const sortField = (f.sortField ?? "created_at") as CreditNoteSortField;
  const descending = f.sortDesc ?? true;
  const keyset = sortField === "created_at";

  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(creditNotes.businessId, businessId)];
    if (f.invoicePublicId) {
      const [inv] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, f.invoicePublicId)))
        .limit(1);
      if (!inv) return { data: [], hasMore: false, nextCursor: null, total: 0 };
      conds.push(eq(creditNotes.invoiceId, inv.id));
    }
    if (f.customerId) conds.push(eq(creditNotes.customerId, f.customerId));
    const search = searchCondition(
      [
        creditNotes.publicId,
        creditNotes.number,
        creditNotes.status,
        creditNotes.reasonCode,
        invoices.publicId,
      ],
      f.search,
    );
    if (search) conds.push(search);
    // Date filters bucket by the BUSINESS day, not the UTC day (business-tz.ts).
    conds.push(
      ...filterConditions(LIST_FILTERS, f.filters, await businessTimezone(tx, businessId)),
    );

    let total: number | null = null;
    if (!f.startingAfter) {
      total = await cappedTotal(
        tx,
        tx
          .select({ one: sql`1` })
          .from(creditNotes)
          .innerJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
          // Same join set as the page read below, because `LIST_FILTERS` now reaches
          // `customers` — a filter field the count query cannot see is not a wrong
          // total, it is a 500 ("missing FROM-clause entry for table customers").
          // Free when unused: it is a LEFT JOIN on a unique PK, which Postgres drops
          // from a COUNT that references no column of it.
          .leftJoin(customers, eq(creditNotes.customerId, customers.id))
          .where(and(...conds)),
      );
    }

    const { keysetId, offset } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    if (keyset && keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${creditNotes.createdAt}::text`,
          publicId: creditNotes.publicId,
        })
        .from(creditNotes)
        .where(and(eq(creditNotes.businessId, businessId), eq(creditNotes.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        creditNotes.createdAt,
        creditNotes.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const noteRows = await tx
      // Customer joined for the index's "Customer" column — the credit-note list
      // leads with the payer.
      .select({
        cn: creditNotes,
        invPid: invoices.publicId,
        invNumber: invoices.number,
        cusPid: customers.publicId,
        // The full name chain — `accountHolderName` picks below. The legacy `name`
        // alone is null for any customer created with first/last, which left this
        // column empty on exactly the notes an operator is chasing.
        cusFirstName: customers.firstName,
        cusLastName: customers.lastName,
        cusCompany: customers.company,
        cusEmail: customers.email,
      })
      .from(creditNotes)
      .innerJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
      .leftJoin(customers, eq(creditNotes.customerId, customers.id))
      .where(and(...pageConds))
      .orderBy(...pageOrder(LIST_SORTS[sortField], creditNotes.publicId, descending, keyset))
      .limit(limit + 1)
      .offset(keyset ? 0 : offset);

    const page = toPage(noteRows, limit, { keyset, offset, keyOf: (r) => r.cn.publicId, total });
    const ids = page.data.map((r) => r.cn.id);
    const itemsByNote = new Map<string, Array<typeof creditNoteItems.$inferSelect>>();
    if (ids.length > 0) {
      const itemRows = await tx
        .select()
        .from(creditNoteItems)
        .where(inArray(creditNoteItems.creditNoteId, ids));
      for (const it of itemRows) {
        itemsByNote.set(it.creditNoteId, [...(itemsByNote.get(it.creditNoteId) ?? []), it]);
      }
    }
    return {
      ...page,
      data: page.data.map((r) => ({
        note: r.cn,
        invoicePublicId: r.invPid,
        invoiceNumber: r.invNumber,
        items: itemsByNote.get(r.cn.id) ?? [],
        customerPublicId: r.cusPid ?? null,
        customerName: accountHolderName({
          firstName: r.cusFirstName,
          lastName: r.cusLastName,
          company: r.cusCompany,
          email: r.cusEmail,
        }),
        customerEmail: r.cusEmail ?? null,
      })),
    };
  });
}

/**
 * Every credit note of a business, unpaginated (one query per note).
 * **Internal use only** — API routes use `listCreditNotesPage`.
 */
export async function listCreditNotesByBusiness(
  organizationId: string,
  businessId: string,
  opts?: { invoicePublicId?: string },
): Promise<CreditNoteView[]> {
  return withTenant(organizationId, async (tx) => {
    let invoiceId: string | undefined;
    if (opts?.invoicePublicId) {
      const [inv] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(eq(invoices.businessId, businessId), eq(invoices.publicId, opts.invoicePublicId)),
        )
        .limit(1);
      if (!inv) return [];
      invoiceId = inv.id;
    }
    const where = invoiceId
      ? and(eq(creditNotes.businessId, businessId), eq(creditNotes.invoiceId, invoiceId))
      : eq(creditNotes.businessId, businessId);
    const noteRows = await tx
      .select({ cn: creditNotes, invPid: invoices.publicId, invNumber: invoices.number })
      .from(creditNotes)
      .innerJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
      .where(where)
      .orderBy(desc(creditNotes.createdAt));
    const out: CreditNoteView[] = [];
    for (const r of noteRows) {
      const items = await tx
        .select()
        .from(creditNoteItems)
        .where(eq(creditNoteItems.creditNoteId, r.cn.id));
      out.push({ note: r.cn, invoicePublicId: r.invPid, invoiceNumber: r.invNumber, items });
    }
    return out;
  });
}
