import { fixed12FromNumeric, formatFixed12 } from "@/platform/fixed";
import { eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  invoices,
  invoiceLineItems,
  invoiceLineDiscounts,
  customers,
  subscriptions,
  prices,
  businesses,
} from "@db/schema";
import { inclusiveBoundary, type BillingMode } from "@/modules/subscriptions/billing-mode";
import { accountHolderName } from "@/modules/customers/names";
import { customerBillingAddress } from "./billing-snapshot";
import type { InvoiceRelations } from "./relations";
import { publicMetadata } from "@/platform/public-metadata";

type CustomerRow = typeof customers.$inferSelect;

/** Just enough of the business row to decide the boundary convention. */
/** A stored numeric(38,12) as canonical text, or the integer field on an older row. */
function decimalText(stored: string | null | undefined, integer: number | bigint): string {
  return stored != null ? formatFixed12(fixed12FromNumeric(stored)) : String(integer);
}

export type PeriodConvention = Pick<
  typeof businesses.$inferSelect,
  "anchorGranularity" | "timezone"
>;

/**
 * A billing period ends on the same boundary the subscription's term does, so it is
 * reported the same way: INCLUSIVELY on day-anchored businesses (…T23:59:59 local),
 * exclusively in storage. Without this an invoice covering 26-Jul→25-Aug reported
 * `period_end: 26-Aug T00:00` and the invoice list rendered "26 Aug" — a day the period
 * does not bill for — while the subscription's own `current_period_end` said the 25th.
 * Two answers for one boundary in the same payload family.
 *
 * `biz` is optional only because a handful of writes serialize an invoice they just
 * created without a business row to hand; omitting it reports the raw exclusive instant,
 * which is the pre-existing behaviour, never a wrong-but-plausible converted one.
 */
export function inclusivePeriodEnd(
  end: Date | null,
  biz: PeriodConvention | null | undefined,
): Date | null {
  if (!biz) return end;
  const mode: BillingMode = {
    anchor: biz.anchorGranularity === "day" ? "day" : "instant",
    proration: "exact", // unused — only the anchor decides a boundary
    timezone: biz.timezone ?? "UTC",
  };
  return inclusiveBoundary(end, mode);
}

/**
 * A line's rating as a reader sees it: without your cost unless `showCost`. Each price-list
 * segment drops the cost row it cites and, on a cost markup base, the base rate.
 */
/** `cumulative_minor` / `billed_before_minor` of an interim or final usage line. */
function usageToDate(rating: unknown) {
  const r = rating as { cumulative_minor?: number; billed_before_minor?: number } | null;
  return {
    cumulative_minor: typeof r?.cumulative_minor === "number" ? r.cumulative_minor : null,
    billed_before_minor: typeof r?.billed_before_minor === "number" ? r.billed_before_minor : null,
  };
}

export function publicRating(rating: unknown, showCost: boolean): unknown {
  if (rating == null) return null;
  const r = rating as { segments?: Array<Record<string, unknown>> };
  if (showCost || !Array.isArray(r.segments)) return rating;
  return {
    ...r,
    segments: r.segments.map(({ model_cost_override_id: _c, ...seg }) =>
      seg.markup_base === "cost" ? { ...seg, base_unit_amount_decimal: null } : seg,
    ),
  };
}

export function serializeInvoice(
  inv: typeof invoices.$inferSelect,
  extra?: {
    customer?: string | null;
    subscription?: string | null;
    lines?: Array<{ line: typeof invoiceLineItems.$inferSelect; price: string | null }>;
    /**
     * Per-(line, coupon, stage) discount attribution, from `invoice_line_discounts`.
     * Supplied by the detail read; omitted on list reads, where `discounts` and the two
     * stage totals are therefore absent rather than reported as zero — a zero would be a
     * claim that nothing was discounted (0169).
     */
    discountShares?: Array<typeof invoiceLineDiscounts.$inferSelect>;
    /**
     * What each `appliedCouponId` in `discountShares` actually IS — the
     * `discounts[].entity_type` split of coupon vs manual, which nothing else on the
     * invoice can answer. `invoice_line_discounts.label` cannot: a MANUAL discount is
     * labelled "Discount" only because that is `peekDiscounts`' default `invoiceName`,
     * and a coupon is free to carry the same string.
     *
     * `code` is the coupon's own code, kept apart from `label` — `label` is
     * `invoice_name ?? code`, so a coupon with an invoice name hides the code the
     * operator actually applied, which is the thing they search for.
     */
    discountSources?: Array<{ appliedCouponId: string; source: string; code: string | null }>;
    /** Sum of succeeded payments (from the payments table). When omitted, derived from status. */
    paidMinor?: bigint;
    /** The caller holds `usage_margin:view`: usage lines show their cost and cost rows. */
    showCost?: boolean;
    /** Joined on the detail read — supplies the display name and the address fallback. */
    customerRow?: CustomerRow | null;
    /**
     * Name/email alone, from the list read (which does not select the whole row).
     * The list has already resolved the name through `accountHolderName` — pass a
     * resolved value, never a bare `customers.name`.
     */
    customerName?: string | null;
    customerEmail?: string | null;
    /** Decides the period-end convention — see `inclusivePeriodEnd`. Omit only where no business row is at hand. */
    biz?: PeriodConvention | null;
    /**
     * End of this invoice's dunning period (`dunningPeriodEndsAt`), or null when the business
     * sets none. Supplied by the DETAIL read, which has the business to resolve the config
     * from; `biz` above is a narrow period-convention shape and cannot carry it.
     *
     * Serialized because the dashboard needs it to say whether an armed retry is the LAST one,
     * and that answer is `scheduleTail`'s: once the offsets are spent, a period still in the
     * future buys one more attempt at the deadline. Computing it in the UI instead would be a
     * second copy of an engine rule, which is exactly how the banner came to disagree with the
     * engine in the first place.
     */
    dunningPeriodEndsAt?: Date | null;
    /** The detail read's related records; absent on list reads (see `relations.ts`). */
    relations?: InvoiceRelations;
  },
) {
  const rel = extra?.relations;
  // ── PROMOTIONAL CREDIT IS A PRE-TAX DISCOUNT ON THE DOCUMENT (2026-08-25) ───────
  //
  // The engine applies promotional credit BEFORE tax — it shrinks the taxable base
  // (`resolvePeriodInvoiceMoney`, and the same in `createInvoiceFromLines`) — but the
  // column `invoices.total_minor` is the GROSS taxed claim, i.e. what accounts_receivable
  // is debited at issue. On a promo invoice that made the DOCUMENT unreadable: subtotal
  // 27,918.00 with "IGST 18%  3,225.24" against it, when 18% of 27,918.00 is 5,025.24.
  // The taxable value the tax was actually charged on (17,918.00) appeared nowhere, which
  // an India GST tax invoice is required to state (CGST Rules r.46(m)–(n)).
  //
  // The document models the same money as a typed pre-tax DISCOUNT (`entity_type:
  // "promotional_credits"`) and reserves `credits_applied` for the POST-tax buckets only.
  // We used to report the promo slice in `credits_applied_minor` instead, so `total_minor`
  // overstated the claim by exactly the promo and the tax line could not be derived from
  // the document.
  //
  // The DOCUMENT now states it correctly. The COLUMN is untouched: `total_minor`
  // stays the gross taxed claim because `proration.ts`, `cancellation-credit.ts` and
  // `credit-notes/service.ts` all reverse against it (`taxedGross = total − promo`), the
  // ledger debits AR with it, and `ops/invariants.ts` reconciles it against the line
  // items. Presentation is derived here — exactly the split `amount_due_minor` already
  // uses (stored = issue-time collectible, reported = remaining balance).
  const promotionalDiscount = inv.promotionalCreditsAppliedMinor ?? 0n;
  // Credit grants (design G3 §3.4): pre-tax draws are a document discount like promo;
  // post-tax draws are a credit applied like the buckets.
  const grantPreTax = inv.grantCreditsPreTaxMinor ?? 0n;
  const grantPostTax = inv.grantCreditsPostTaxMinor ?? 0n;
  /** `invoice.total`: sub_total − discounts (promo and pre-tax grants included) + tax. */
  const netTotal = inv.totalMinor - promotionalDiscount - grantPreTax;
  // The money fields: credits_applied = balance
  // credit consumed at generation POST-tax (refundable + excess; the promotional
  // bucket is the discount above, never counted twice); amount_paid = cash collected;
  // amount_due = what REMAINS collectible (decrements to 0 as payments land — the
  // stored amountDueMinor column is the issue-time collectible, net of credits).
  const creditsApplied =
    (inv.refundableCreditsAppliedMinor ?? 0n) +
    (inv.excessPaymentsAppliedMinor ?? 0n) +
    grantPostTax;
  // Fallback for rows with no stored collectible (imported archival AR): the NET total,
  // so `amount_due = total − withholding − credits − paid` holds on those rows too.
  const issueDue = inv.amountDueMinor ?? netTotal;
  const paid = extra?.paidMinor ?? (inv.status === "paid" && !inv.writtenOff ? issueDue : 0n);
  /**
   * A SETTLED invoice reports 0 outstanding whatever `paidMinor` says.
   *
   * ⚠️ `extra?.paidMinor ?? …` above only falls back on null/undefined, so a caller passing
   * an explicit **0** defeated the status fallback and this returned `status: "paid"` beside
   * a full `amount_due_minor` — output contradicting itself. The buyer portal then read that
   * balance and told a customer "This payment did not settle the invoice" for a payment that
   * had settled it: reproduced twice on the real book (INV-7849, INV-7850, both
   * `paid`/`success` with one succeeded payment each) while our user was recording a journey.
   *
   * `paid` and `written_off` and `voided` all mean nothing is collectible, so the STATUS
   * decides here and the arithmetic only applies to invoices still open. A caller cannot
   * make a settled invoice look owed by handing us a stale sum.
   */
  const settled = inv.status === "paid" || inv.writtenOff || inv.status === "voided";
  const remainingDue = settled ? 0n : issueDue - paid;
  return {
    object: "invoice",
    id: inv.publicId,
    number: inv.number,
    status: inv.status,
    currency: inv.currency,
    subtotal_minor: Number(inv.subtotalMinor),
    total_minor: Number(netTotal),
    /**
     * The promotional-credit slice, as a pre-tax discount (`discounts[].entity_type =
     * "promotional_credits"`). Always present (it is one
     * column), unlike the coupon breakdown which the list read omits, so a list row
     * can still explain why its total is below its subtotal.
     */
    promotional_discount_minor: Number(promotionalDiscount),
    credits_applied_minor: Number(creditsApplied),
    grant_credits_pre_tax_minor: Number(grantPreTax),
    grant_credits_post_tax_minor: Number(grantPostTax),
    amount_paid_minor: Number(paid),
    amount_due_minor: Number(remainingDue < 0n ? 0n : remainingDue),
    withholding_minor: Number(inv.withholdingMinor ?? 0n),
    // Tax determination SNAPSHOT (frozen at issue). `seller_state_code` is what decided
    // CGST+SGST vs IGST, so it is reported rather than re-derived — the region's current
    // home state may since have changed. Null on invoices raised before place-of-supply
    // tax existed; the UI must render that as "—", never as a claim.
    seller_state_code: inv.sellerStateCode ?? null,
    place_of_supply_code: inv.placeOfSupplyCode ?? null,
    tax_treatment: inv.taxTreatment ?? null,
    /** Reverse-charge / SEZ / export note to print. Null = nothing to print. */
    tax_note: inv.taxNote ?? null,
    /**
     * FX SNAPSHOT (0228) — units of THIS invoice's currency per 1 unit of
     * `exchange_rate_base`, as it stood when the invoice was finalized. The reason a
     * converted book can be reproduced later instead of drifting with whatever rate the
     * reader happens to hold.
     *
     * A STRING, deliberately: `numeric` is exact and JSON numbers are not, so reporting
     * it as a number would hand every consumer 94.95374099999999. Null = no rate was
     * recorded (raised before 0228, or the business had no rate for the currency) — and
     * a consumer must NOT read that as 1, which would assert parity with the base.
     */
    exchange_rate: inv.exchangeRate ?? null,
    exchange_rate_base: inv.exchangeRateBase ?? null,
    period_start: inv.periodStart,
    period_end: inclusivePeriodEnd(inv.periodEnd, extra?.biz),
    // A monthly usage invoice inside the term: its sub-period. Null on every other invoice.
    sub_period:
      (inv.metadata as { sub_period?: { start: string; end: string } } | null)?.sub_period ?? null,
    due_date: inv.dueDate,
    attempt_count: inv.attemptCount,
    next_attempt_at: inv.nextAttemptAt,
    paid_at: inv.paidAt,
    voided_at: inv.voidedAt,
    void_reason_code: inv.voidReasonCode ?? null,
    written_off: inv.writtenOff,
    dunning_status: inv.dunningStatus,
    // 0474: usage_interim (a threshold invoice) | credit_purchase (automatic top-up); null otherwise.
    purpose: inv.purpose ?? null,
    // Null both when no period is configured and when the detail read did not supply one, so
    // a consumer must not read "absent" as "the schedule alone decides" — see the extra above.
    dunning_period_ends_at: extra?.dunningPeriodEndsAt ?? null,
    po_number: inv.poNumber,
    // Collections forecast — NOT a payment term. See the column comment: nothing
    // in the engine reads it, so it can never move a dunning date.
    expected_payment_date: inv.expectedPaymentDate,
    channel: inv.channel,
    // Address SNAPSHOT if one was taken on this invoice, else the customer's
    // current address. Resolved here rather than in the UI so every consumer
    // (dashboard, PDF, portal) shows the same address for the same invoice.
    // `billing_address_is_snapshot` tells the edit screen whether it is about to
    // create the first snapshot or amend an existing one.
    billing_address:
      inv.billingAddress ?? (extra?.customerRow ? customerBillingAddress(extra.customerRow) : null),
    billing_address_is_snapshot: inv.billingAddress != null,
    // Frozen at issue; '' (none on file then) and NULL (before 0335) both read null.
    customer_tax_id: inv.customerTaxId || null,
    // The seller registration the document printed, frozen at issue (0336). Null before.
    tax_origin:
      inv.sellerTaxId == null
        ? null
        : { country: inv.sellerTaxCountry ?? null, registration_number: inv.sellerTaxId || null },
    price_type: inv.priceType ? `tax_${inv.priceType}` : null,
    notes: inv.notes || null,
    net_term_days: inv.netTermDays ?? null,
    finalized_at: inv.finalizedAt ?? null,
    updated_at: inv.updatedAt,
    resource_version: inv.resourceVersion,
    recurring: inv.subscriptionId != null,
    ...(rel
      ? {
          tax_minor: Number(rel.taxes.reduce((s, t) => s + t.amountMinor, 0n)),
          taxes: rel.taxes.map((t) => ({
            name: t.name,
            rate_bps: t.rateBps,
            amount_minor: Number(t.amountMinor),
          })),
          first_invoice: rel.firstInvoice,
          // Adjustment notes reduce what is owed; a write-off is the adjustment that gives up on it.
          amount_adjusted_minor: Number(
            rel.creditNotes
              .filter((c) => c.kind === "adjustment" && c.status !== "voided")
              .reduce((s, c) => s + c.totalMinor, 0n),
          ),
          write_off_amount_minor: Number(
            rel.creditNotes
              .filter(
                (c) =>
                  c.kind === "adjustment" && c.status !== "voided" && c.reasonCode === "write_off",
              )
              .reduce((s, c) => s + c.totalMinor, 0n),
          ),
          adjustment_credit_notes: rel.creditNotes
            .filter((c) => c.kind === "adjustment")
            .map(creditNoteRef),
          issued_credit_notes: rel.creditNotes
            .filter((c) => c.kind !== "adjustment")
            .map(creditNoteRef),
          applied_credits: rel.appliedCredits.map((a) => ({
            ...creditNoteRef(a.creditNote),
            applied_amount_minor: Number(a.amountMinor),
            applied_at: a.appliedAt,
          })),
          linked_payments: rel.transactions.map((t) => ({
            id: t.publicId,
            type: t.type,
            status: t.status,
            amount_minor: Number(t.amountMinor),
            currency: t.currency,
            gateway: t.gatewayKey ?? null,
            id_at_gateway: t.idAtGateway ?? null,
            error_code: t.errorCode ?? null,
            occurred_at: t.occurredAt ?? t.createdAt,
          })),
        }
      : {}),
    shipping_address: inv.shippingAddress ?? extra?.customerRow?.shippingAddress ?? null,
    shipping_address_is_snapshot: inv.shippingAddress != null,
    imported: inv.imported,
    metadata: publicMetadata(inv.metadata),
    created_at: inv.createdAt,
    ...(extra?.customer != null ? { customer: extra.customer } : {}),
    // `accountHolderName`, not the raw `name` column: this is the operator-facing
    // identity (who the invoice is FOR), which is not necessarily the contact printed
    // on the document — see `customers/names.ts`, and `document.ts` for the other one.
    ...(extra?.customerRow
      ? {
          customer_name: accountHolderName(extra.customerRow),
          customer_email: extra.customerRow.email ?? null,
        }
      : extra?.customerName !== undefined || extra?.customerEmail !== undefined
        ? { customer_name: extra.customerName ?? null, customer_email: extra.customerEmail ?? null }
        : {}),
    ...(extra?.subscription != null ? { subscription: extra.subscription } : {}),
    // `discounts[]` + the two stage totals, so a reader can reproduce the
    // subtotal instead of trusting it:
    //   subtotal_minor = Σ line amount_minor − item_level_discount_minor
    //   total_minor    = subtotal_minor − document_level_discount_minor + tax
    // Only present when the shares were loaded (the detail read) — see `discountShares`.
    ...(extra?.discountShares
      ? (() => {
          // uuid → public id, so a discount can name the LINES it hit ("applied on line
          // item(s) #1"). Positional ordinals are the reader's job:
          // this emits stable ids and lets the renderer count.
          const linePublicId = new Map(
            (extra?.lines ?? []).map(({ line }) => [line.id, line.publicId]),
          );
          const sourceOf = new Map(
            (extra?.discountSources ?? []).map((d) => [d.appliedCouponId, d]),
          );
          const byKey = new Map<
            string,
            {
              label: string | null;
              scope: string;
              applied_coupon: string | null;
              amount_minor: bigint;
              line_item_ids: string[];
            }
          >();
          let itemLevel = 0n;
          // The promotional slice is a document-level discount that has no coupon and
          // therefore no `invoice_line_discounts` row — it is seeded here so
          // `total_minor = subtotal_minor − document_level_discount_minor + tax` holds.
          let documentLevel = promotionalDiscount + grantPreTax;
          for (const s of extra.discountShares) {
            if (s.scope === "item_level") itemLevel += s.amountMinor;
            else documentLevel += s.amountMinor;
            // Aggregated per (coupon, stage): one coupon can straddle both stages, and
            // collapsing them would lose which part is inside the subtotal.
            const key = `${s.appliedCouponId ?? s.label ?? ""}|${s.scope}`;
            const acc = byKey.get(key) ?? {
              label: s.label,
              scope: s.scope,
              applied_coupon: s.appliedCouponId,
              amount_minor: 0n,
              line_item_ids: [] as string[],
            };
            acc.amount_minor += s.amountMinor;
            const pid = s.invoiceLineItemId ? linePublicId.get(s.invoiceLineItemId) : undefined;
            // Deduped: one coupon can produce several shares against the same line.
            if (pid && !acc.line_item_ids.includes(pid)) acc.line_item_ids.push(pid);
            byKey.set(key, acc);
          }
          return {
            item_level_discount_minor: Number(itemLevel),
            document_level_discount_minor: Number(documentLevel),
            discounts: [
              // The promotional slice is listed FIRST and typed, so an importer or
              // consumer can tell it from a coupon (`applied_coupon` is null for both an
              // ad-hoc document discount and this).
              ...(promotionalDiscount > 0n
                ? [
                    {
                      label: "Promotional Credits",
                      scope: "document_level",
                      entity_type: "promotional_credits",
                      // Not a coupon and not a manual discount — it is the customer's own
                      // promotional-credit balance being spent, so it names its own source
                      // rather than borrowing one of the other two.
                      source: "promotional_credits",
                      coupon_code: null,
                      applied_coupon: null,
                      line_item_ids: [],
                      amount_minor: Number(promotionalDiscount),
                    },
                  ]
                : []),
              ...(grantPreTax > 0n
                ? [
                    {
                      label: "Credit grants",
                      scope: "document_level",
                      entity_type: "credit_grants",
                      source: "credit_grants",
                      coupon_code: null,
                      applied_coupon: null,
                      line_item_ids: [],
                      amount_minor: Number(grantPreTax),
                    },
                  ]
                : []),
              ...[...byKey.values()].map((d) => ({
                label: d.label,
                /** item_level is INSIDE subtotal_minor; document_level is applied TO it. */
                scope: d.scope,
                entity_type:
                  d.scope === "item_level" ? "item_level_discount" : "document_level_discount",
                /** coupon | manual — see `discountSources`. Null when not loaded. */
                source: d.applied_coupon ? (sourceOf.get(d.applied_coupon)?.source ?? null) : null,
                coupon_code: d.applied_coupon
                  ? (sourceOf.get(d.applied_coupon)?.code ?? null)
                  : null,
                applied_coupon: d.applied_coupon,
                /** The lines this discount reduced, as line public ids. */
                line_item_ids: d.line_item_ids,
                amount_minor: Number(d.amount_minor),
              })),
            ],
          };
        })()
      : {}),
    ...(extra?.lines
      ? {
          lines: extra.lines.map(({ line: l, price }) => ({
            id: l.publicId,
            description: l.description,
            kind: l.kind,
            quantity: l.quantity,
            unit_amount_minor: Number(l.unitAmountMinor),
            // 0454: read these. Rows from before 0454 hold nulls: fall back to the integers.
            quantity_decimal: decimalText(l.quantityDecimal, l.quantity),
            unit_amount_decimal: decimalText(l.unitAmountDecimal, l.unitAmountMinor),
            // GROSS, before any discount.
            amount_minor: Number(l.amountMinor),
            // Discount attributed to this line across BOTH waterfall stages.
            discount_minor: Number(l.discountMinor ?? 0n),
            // SNAPSHOT of the HSN/SAC that classified this line at issue (India GST).
            // Null outside that regime, on pre-existing lines, and on lines that classify
            // no supply (discount / tax / rounding).
            tax_code: l.taxCode ?? null,
            // How a usage line was rated (0380); null on every other line.
            rating: publicRating(l.rating, extra.showCost === true),
            // Threshold invoicing: usage to date and what interim invoices billed before;
            // `amount_minor` is this invoice's part. Null on every other line.
            ...usageToDate(l.rating),
            // 0458: a usage line's cost, for callers who may see it.
            ...(extra.showCost
              ? {
                  cost_minor: l.costMinor != null ? Number(l.costMinor) : null,
                  cost_basis: l.costBasis ?? null,
                }
              : {}),
            // A true-up line: minimum_spend | commitment; null on every other line.
            adjustment: l.adjustment ?? null,
            // Tax charged on THIS line and, when none, why (detail read only).
            ...(rel && l.kind !== "tax" && l.kind !== "discount" && l.kind !== "rounding"
              ? (() => {
                  const t = rel.lineTaxes.get(l.id);
                  const amount = t?.amountMinor ?? 0n;
                  return {
                    tax_amount_minor: Number(amount),
                    is_taxed: amount > 0n,
                    tax_exempt_reason:
                      amount > 0n ? null : (t?.reasons.find((r) => r !== "standard_rated") ?? null),
                  };
                })()
              : {}),
            // What a credit note may still credit on this line, tax-inclusive (detail read only).
            ...(rel ? { creditable_minor: Number(rel.lineCreditable.get(l.publicId) ?? 0n) } : {}),
            // …and the part of it that is INSIDE `subtotal_minor`. Split out because the
            // two need opposite treatment when displayed: the item-level part explains why
            // the subtotal is less than the lines and belongs beside them, while the
            // document-level part already has its own row in the totals ladder — showing
            // that one per line too would render the same money twice on one document.
            // Only present when the shares were loaded (the detail read).
            ...(extra.discountShares
              ? {
                  item_level_discount_minor: Number(
                    extra.discountShares
                      .filter((s) => s.invoiceLineItemId === l.id && s.scope === "item_level")
                      .reduce((sum, s) => sum + s.amountMinor, 0n),
                  ),
                }
              : {}),
            price,
            period_start: l.periodStart,
            period_end: inclusivePeriodEnd(l.periodEnd, extra?.biz),
          })),
        }
      : {}),
  };
}

/**
 * Full-snapshot loader for event content (BLUEPRINT §11 Part B). Loads an
 * invoice by public id + its customer/subscription public ids + line items,
 * returning the serialized object, or null if not found. `tx` must be the
 * caller's RLS-scoped transaction.
 *
 * Deliberately a self-contained query (mirrors `getInvoiceWithLines` in
 * `./service`) rather than importing that function — `service.ts` imports
 * `emitEvent`, which would close the serialize → service → events/emit →
 * events/content → serialize cycle.
 */
/**
 * An invoice's PUBLIC id from its internal one. Same reason as `loadCustomerPublicId`:
 * an event payload naming the uuid enriches nothing, and nothing says so.
 */
export async function loadInvoicePublicId(tx: Tx, invoiceId: string): Promise<string | null> {
  const [row] = await tx
    .select({ publicId: invoices.publicId })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  return row?.publicId ?? null;
}

export async function loadInvoiceSnapshot(
  tx: Tx,
  invPublicId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ inv: invoices, cusPid: customers.publicId, subPid: subscriptions.publicId })
    .from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .leftJoin(subscriptions, eq(invoices.subscriptionId, subscriptions.id))
    .where(eq(invoices.publicId, invPublicId))
    .limit(1);
  if (!row) return null;
  const lineRows = await tx
    .select({ line: invoiceLineItems, pricePid: prices.publicId })
    .from(invoiceLineItems)
    .leftJoin(prices, eq(invoiceLineItems.priceId, prices.id))
    .where(eq(invoiceLineItems.invoiceId, row.inv.id))
    // Insertion order. Without it Postgres returns an invoice's lines in ANY order, and did:
    // the same invoice served [plan, addon] on one read and [addon, plan] on the next.
    .orderBy(invoiceLineItems.seq);
  // The webhook payload must carry the SAME period_end the REST read does — a consumer
  // reconciling an `invoice.generated` event against `GET /v1/invoices/:id` would
  // otherwise see the boundary move by a second.
  const [biz] = await tx
    .select({ anchorGranularity: businesses.anchorGranularity, timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, row.inv.businessId))
    .limit(1);
  // Same reason as `biz` above: the webhook payload must carry the same discount
  // attribution the REST read does, or a consumer reconciling `invoice.generated`
  // against `GET /v1/invoices/:id` sees a subtotal it cannot reproduce in one and can
  // in the other.
  const shareRows = await tx
    .select()
    .from(invoiceLineDiscounts)
    .where(eq(invoiceLineDiscounts.invoiceId, row.inv.id));
  return serializeInvoice(row.inv, {
    customer: row.cusPid ?? null,
    subscription: row.subPid ?? null,
    lines: lineRows.map((l) => ({ line: l.line, price: l.pricePid ?? null })),
    discountShares: shareRows,
    biz: biz ?? null,
  });
}

/** A credit note as an invoice refers to it. */
function creditNoteRef(c: InvoiceRelations["creditNotes"][number]) {
  return {
    id: c.publicId,
    number: c.number ?? null,
    kind: c.kind,
    reason_code: c.reasonCode ?? null,
    status: c.status,
    total_minor: Number(c.totalMinor),
    created_at: c.createdAt,
  };
}
