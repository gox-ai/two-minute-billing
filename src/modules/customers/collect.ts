/**
 * Ad-hoc collect_payment (CUST-3 / plan §D3).
 *
 * `POST /v1/customers/:cus/collect_payment` — settle a customer's open invoices in the
 * business's application order (oldest due first unless set to newest first), applying their post-tax credit buckets (refundable then
 * excess) BEFORE charging the remainder to a card. Promotional credit is NOT
 * applied here — it is pre-tax and only consumed at invoice generation.
 *
 * `amount_minor` caps the total settled (credits + charge) and is money, so it
 * REQUIRES a `currency` scope: the budget only draws against invoices of that
 * currency (a $100 budget must not be spent down by a €90 invoice — review
 * finding 2026-07-04). Without `amount_minor` every open invoice is eligible
 * regardless of currency (no budget). `invoice_ids` limits the target set;
 * `payment_method_id` charges a specific instrument.
 *
 * If a card charge fails mid-run, we STOP charging cards for the rest of this
 * call (the same failing instrument would otherwise burn one dunning attempt per
 * open invoice); already-applied credits stand and remaining invoices can still
 * take credit.
 */
import { activatePaidCreditGrants } from "@/modules/credits/packs";
import { stampNow } from "@/platform/clock";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { loadPaymentApplication, settlesNewestFirst } from "@/modules/payments/application-config";
import { withTenant } from "@/platform/db";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  collectInvoice,
  CollectionInFlightError,
  invoiceOutstanding,
  postCreditApplications,
} from "@/modules/invoicing/service";
import { OPEN_INVOICE_STATUSES, dunningFieldsOnCreditSettle } from "@/modules/invoicing/status";
import { bucketBalancesForCurrency, lockCustomerBalances } from "@/modules/customers/balances";
import { loadCreditApplicationLimits } from "@/modules/customers/credits-flexibility";
import { getCustomerByPublicId } from "@/modules/customers/service";
import { isCustomerPaymentMethod } from "@/modules/invoicing/collection";
import { invoices, payments, subscriptions } from "@db/schema";

type Invoice = typeof invoices.$inferSelect;

const min = (a: bigint, b: bigint) => (a < b ? a : b);
/** A bucket balance narrowed by its Credits Flexibility ceiling; `null` = unlimited. */
const capped = (balance: bigint, limit: bigint | null) =>
  limit === null ? balance : min(balance, limit);
/**
 * What is left of a PER-INVOICE ceiling after what this invoice already drew from that
 * bucket. `null` (unlimited) stays unlimited; a spent-out ceiling floors at 0 rather than
 * going negative, which `capped` would read as "apply a negative amount".
 */
const headroom = (limit: bigint | null, alreadyApplied: bigint | null): bigint | null => {
  if (limit === null) return null;
  const left = limit - (alreadyApplied ?? 0n);
  return left > 0n ? left : 0n;
};

export class CollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectError";
  }
}

export interface CollectPaymentResult {
  customer: string;
  applied: { refundable: number; excess: number };
  charged: number;
  invoices: Array<{ id: string; status: string; amount_due_minor: number }>;
}

export async function collectPayment(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  amountMinor?: number;
  currency?: string;
  invoiceIds?: string[];
  paymentMethodId?: string;
  /**
   * Explicit per-invoice amounts, settled in the order given. Each is a ceiling for that
   * invoice (credit + charge) and must not exceed what it owes; an omitted amount means
   * its whole remainder. Exclusive with `invoiceIds`. The card leg still settles an
   * invoice in full or not at all, so an allocation below the remainder left after
   * credit applies credit only.
   */
  invoiceAllocations?: Array<{ invoiceId: string; amountMinor?: number }>;
}): Promise<CollectPaymentResult | null> {
  const cust = await getCustomerByPublicId(
    input.organizationId,
    input.businessId,
    input.customerPublicId,
  );
  if (!cust) return null;

  // A money budget is currency-scoped: only invoices of that currency count
  // against it. Enforced at the route too, but guard here for direct callers.
  if (input.amountMinor != null && !input.currency)
    throw new CollectError("currency is required when amount_minor is set");
  const currency = input.currency?.toUpperCase();
  if (
    input.paymentMethodId &&
    !(await isCustomerPaymentMethod(input.organizationId, cust.id, input.paymentMethodId))
  )
    throw new CollectError(
      `We could not find the payment method ${input.paymentMethodId} for this customer.`,
    );

  const allocations = input.invoiceAllocations;
  if (allocations && input.invoiceIds?.length)
    throw new CollectError("Pass invoice_ids or invoice_allocations, not both");

  // Per-invoice ceilings, validated up front against what each invoice owes now.
  const allocationCap = new Map<string, bigint | null>();
  let allocated: Awaited<ReturnType<typeof loadAllocatedInvoices>> | null = null;
  if (allocations) {
    allocated = await loadAllocatedInvoices(input.organizationId, cust.id, allocations);
    const currencies = new Set(allocated.map((a) => a.invoice.currency));
    if (currencies.size > 1)
      throw new CollectError("invoice_allocations must all be invoices of one currency");
    if (currency && !currencies.has(currency))
      throw new CollectError(`invoice_allocations are not in ${currency}`);
    let sum = 0n;
    for (const a of allocated) {
      if (a.amount !== null && a.amount > a.due)
        throw new CollectError(
          `allocation_amount ${a.amount} exceeds the ${a.due} ${a.invoice.currency} due on ${a.invoice.publicId}`,
        );
      allocationCap.set(a.invoice.id, a.amount);
      sum += a.amount ?? a.due;
    }
    if (input.amountMinor != null && sum > BigInt(input.amountMinor))
      throw new CollectError(
        `The invoice_allocations total ${sum} is more than amount_minor ${input.amountMinor}`,
      );
  }

  // Open invoices in the business's application order (2.66): oldest due first unless it
  // chose newest first. Optionally filtered to the requested currency (always, when a
  // budget scopes to one currency).
  const newestFirst = settlesNewestFirst(
    await loadPaymentApplication(input.organizationId, input.businessId),
  );
  const open = allocated
    ? allocated.map((a) => a.invoice)
    : await withTenant(input.organizationId, async (tx) => {
        const conds = [
          eq(invoices.customerId, cust.id),
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
        ];
        if (currency) conds.push(eq(invoices.currency, currency));
        if (input.invoiceIds?.length) conds.push(inArray(invoices.publicId, input.invoiceIds));
        return tx
          .select()
          .from(invoices)
          .where(and(...conds))
          .orderBy(
            ...(newestFirst
              ? [
                  desc(sql`coalesce(${invoices.dueDate}, ${invoices.createdAt})`),
                  desc(invoices.createdAt),
                  desc(invoices.id),
                ]
              : [
                  asc(sql`coalesce(${invoices.dueDate}, ${invoices.createdAt})`),
                  asc(invoices.createdAt),
                ]),
          );
      });

  let budget: bigint | null = input.amountMinor != null ? BigInt(input.amountMinor) : null;
  let refundableTotal = 0n;
  let excessTotal = 0n;
  let chargedTotal = 0n;
  let cardFailed = false;
  const touched: Array<{ id: string; status: string; amount_due_minor: number }> = [];

  for (const inv of open) {
    if (budget !== null && budget <= 0n) break;

    const alloc = allocationCap.get(inv.id);
    const drawn = await applyCreditOnFile({
      organizationId: input.organizationId,
      businessId: input.businessId,
      invoice: inv,
      capMinor: budget !== null && alloc != null ? min(budget, alloc) : (budget ?? alloc ?? null),
    });
    // Already settled by a concurrent run (or gone) — nothing left to do for it here.
    if (!drawn) continue;
    const { refApply, exApply } = drawn;
    let due = drawn.due;

    const creditApplied = refApply + exApply;
    // What this invoice's allocation still allows for the card leg.
    const allocLeft = allocationCap.get(inv.id);
    const allocRemaining = allocLeft != null ? allocLeft - creditApplied : null;
    if (creditApplied > 0n) {
      refundableTotal += refApply;
      excessTotal += exApply;
      due -= creditApplied;
      if (budget !== null) budget -= creditApplied;
    }

    // Charge the remainder to a card — only when we can settle the invoice in full
    // within the budget (no partial card charges), and only while cards still work
    // (a prior failure this run stops further attempts to avoid burning dunning
    // attempts on every open invoice).
    if (
      due > 0n &&
      !cardFailed &&
      (budget === null || budget >= due) &&
      (allocRemaining === null || allocRemaining >= due)
    ) {
      const fresh = (
        await withTenant(input.organizationId, (tx) =>
          tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1),
        )
      )[0]!;
      // The invoice's subscription, so its own default card wins over the customer's
      // primary — the order collection resolves everywhere else.
      const sub = fresh.subscriptionId
        ? (
            await withTenant(input.organizationId, (tx) =>
              tx
                .select()
                .from(subscriptions)
                .where(eq(subscriptions.id, fresh.subscriptionId!))
                .limit(1),
            )
          )[0]
        : undefined;
      let pay: Awaited<ReturnType<typeof collectInvoice>> | null = null;
      try {
        pay = await collectInvoice({
          organizationId: input.organizationId,
          businessId: input.businessId,
          invoice: fresh,
          subscription: sub,
          paymentMethodOverrideId: input.paymentMethodId,
          // A person asked for this charge, so it must not spend one of the invoice's
          // scheduled retries — same as the invoice page's "Collect now".
          manualAttempt: true,
        });
      } catch (e) {
        // A collection is already in flight for this invoice (the clock, or an operator's
        // "collect now"). Skip it and stop charging further invoices this run — the same
        // conservative stance as a card failure, since we cannot know yet whether the
        // in-flight attempt will consume the customer's budget.
        if (!(e instanceof CollectionInFlightError)) throw e;
        cardFailed = true;
      }
      if (pay?.status === "succeeded") {
        chargedTotal += due;
        if (budget !== null) budget -= due;
      } else if (pay) {
        cardFailed = true;
      }
    }

    const { final, remaining } = await withTenant(input.organizationId, async (tx) => {
      const row = (await tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1))[0]!;
      return { final: row, remaining: (await invoiceOutstanding(tx, row)).remainingMinor };
    });
    // Report what the caller would see on the invoice — remaining, not the stored
    // issue-time collectible (they just paid some of it).
    touched.push({ id: final.publicId, status: final.status, amount_due_minor: Number(remaining) });
  }

  return {
    customer: cust.publicId,
    applied: { refundable: Number(refundableTotal), excess: Number(excessTotal) },
    charged: Number(chargedTotal),
    invoices: touched,
  };
}

/**
 * Apply the customer's credit on file (refundable, then excess) to one open invoice,
 * under the business's Credits Flexibility ceilings. Every path that is about to charge
 * an open invoice calls this first, so credit is spent before a card everywhere.
 * Returns what was applied and the outstanding balance BEFORE it, or null when the
 * invoice is gone, already settled, or has a debit in flight.
 */
export async function applyCreditOnFile(input: {
  organizationId: string;
  businessId: string;
  invoice: Pick<Invoice, "id" | "customerId" | "subscriptionId">;
  /** Apply at most this much (a caller's budget or allocation); null = up to the balance due. */
  capMinor?: bigint | null;
}): Promise<{ refApply: bigint; exApply: bigint; due: bigint } | null> {
  /**
   * Credits Flexibility (0219) — the SAME ceilings the invoicing path applies.
   *
   * ⚠️ A judgement call, and the reasoning matters. The setting governs auto-application
   * "on invoices generated", which reads as invoice generation only, and `collect_payment`
   * is an operator-initiated call. We gate it anyway, for two reasons. First, from the customer's side this IS auto-application:
   * the caller says "settle these invoices", never "spend this much refundable credit",
   * so the engine is still the one deciding to draw a bucket — and the dashboard's
   * Collect payment button and the hosted portal both reach it. A merchant who set "do
   * not auto-apply" and then watched a button draw ₹69,521.79 of refundable credit
   * would be right to call that a bug. Second, one resolution rule for the whole engine
   * is worth a lot here: the alternative is two answers to "may this bucket be drawn",
   * which is the shape of every drift this module's comments record.
   *
   * The cost was that a merchant with auto-apply OFF had no deliberate way left to apply
   * credit, because we had no explicit apply-credits endpoint. That follow-up
   * landed the same week: `POST /v1/businesses/:biz/invoices/:inv/apply_credits`
   * (`applyCreditsToInvoice` in `modules/invoicing/ops.ts`), which names the invoice, may
   * name the exact amount per bucket, and deliberately does NOT consult the ceilings — the
   * line between the two routes is who chose the money. Read its docblock before changing
   * the gating here; the two decisions only make sense as a pair.
   *
   * Resolved PER INVOICE — the class depends on the invoice: one raised for a
   * subscription reads the `recurring` slots and that subscription's own maxima, one
   * without reads `one_time`. And resolved OUTSIDE the locked transaction below,
   * because it is settings, not balance: nesting a `withTenant` inside the advisory
   * lock would open a second connection while holding it.
   */
  const limits = await loadCreditApplicationLimits({
    organizationId: input.organizationId,
    businessId: input.businessId,
    subscriptionId: input.invoice.subscriptionId,
  });

  // Draw post-tax credit buckets (refundable then excess), inside one locked
  // transaction so a concurrent drawer can't over-spend the same balance.
  //
  // ── THE INVOICE IS RE-READ INSIDE THE LOCK, AND THAT IS THE POINT (2026-08-28) ──
  // `inv` comes from the open-invoice scan at the top of this function, taken before
  // any lock. Every write below is computed by ADDING TO or SUBTRACTING FROM that
  // snapshot — `stored`, `refundable_credits_applied_minor`,
  // `excess_payments_applied_minor` — and the "is it settled" test used a `due` read in
  // a separate, unlocked transaction. `lockCustomerBalances` correctly stopped the
  // BUCKET being over-drawn, but it never protected the INVOICE row, so two concurrent
  // runs each derived their update from the same stale base and the later commit
  // silently discarded the earlier one. A classic lost update, and it loses the
  // customer's money in the worst possible direction: the ledger records the credit as
  // SPENT while the invoice still shows a balance due.
  //
  // Measured on `scripts/verify-concurrent-credit-apply.ts`: five concurrent
  // `collectPayment` calls against 1000 of excess credit and five 400 invoices consumed
  // the whole 1000 from `excess_payment_balance` but recorded only 200 applied across
  // the invoices and left ZERO of them paid — so the customer's credit was gone and
  // every invoice was still due, ready to be dunned and charged again. Run once, the
  // same fixture applies 1000 and settles two invoices (the suite's 2S control).
  //
  // Re-reading inside the lock makes the whole read-modify-write atomic per customer,
  // which is what the lock was always meant to buy.
  return withTenant(input.organizationId, async (tx) => {
    await lockCustomerBalances(tx, input.invoice.customerId);
    const row = (
      await tx.select().from(invoices).where(eq(invoices.id, input.invoice.id)).limit(1)
    )[0];
    if (!row) return null;
    // Net of cash already collected — an invoice part-paid offline must only be
    // settled for its REMAINDER, never its stored issue-time collectible.
    const due = (await invoiceOutstanding(tx, row)).remainingMinor;
    if (due <= 0n) return null;
    // A debit in flight already covers the balance: credit on top would collect twice.
    // Credit is drawn next time, if the debit fails. Payment-request children are excluded,
    // as in `payments/pending-debit.ts`: an overshoot there settles as credit.
    const [inFlight] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.invoiceId, row.id),
          eq(payments.status, "pending"),
          isNull(payments.paymentRequestId),
        ),
      )
      .limit(1);
    if (inFlight) return null;
    const bals = await bucketBalancesForCurrency(
      input.organizationId,
      input.invoice.customerId,
      row.currency,
      tx,
    );
    const cap = input.capMinor != null && input.capMinor < due ? input.capMinor : due;
    /**
     * The ceilings are PER INVOICE, so what this invoice ALREADY drew counts against
     * them. Measured, not assumed: `verify:credits-flexibility` § 4G bills a renewal
     * under an "apply up to 2000 of excess" setting, which correctly applies 2000 at
     * generation — and then `collect_payment` applied a second 2000 to the same
     * invoice, because a fresh ceiling was handed to every application in turn. The
     * merchant asked for at most 2000 of excess on that bill and got 4000.
     *
     * Only this path needs the subtraction: the invoicing path resolves the money for
     * an invoice it is creating, where nothing has been applied yet.
     */
    const refApply = min(
      capped(bals.refundable, headroom(limits.refundable, row.refundableCreditsAppliedMinor)),
      cap,
    );
    const exApply = min(
      capped(bals.excess, headroom(limits.excess, row.excessPaymentsAppliedMinor)),
      cap - refApply,
    );
    const creditApplied = refApply + exApply;
    if (creditApplied > 0n) {
      await postCreditApplications(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.invoice.customerId,
        invoicePublicId: row.publicId,
        currency: row.currency,
        promotional: 0n,
        refundable: refApply,
        excess: exApply,
      });
      // The refundable draw is spent from specific credit notes; record which, as every
      // other draw site does, or a note stays "refund due" for money already spent here.
      if (refApply > 0n) {
        const { allocateRefundableDraw } = await import("@/modules/credit-notes/service");
        await allocateRefundableDraw(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: input.invoice.customerId,
          invoiceId: row.id,
          invoicePublicId: row.publicId,
          currency: row.currency,
          drawMinor: refApply,
        });
      }
      // The stored column tracks the collectible net of CREDITS only (cash is
      // subtracted at serialization), so it moves by the credit applied — while
      // "is it settled now" is judged against `due`, which is net of cash too.
      const stored = (row.amountDueMinor ?? row.totalMinor) - creditApplied;
      const paid = due - creditApplied <= 0n;
      await tx
        .update(invoices)
        .set({
          amountDueMinor: stored,
          refundableCreditsAppliedMinor: (row.refundableCreditsAppliedMinor ?? 0n) + refApply,
          excessPaymentsAppliedMinor: (row.excessPaymentsAppliedMinor ?? 0n) + exApply,
          ...(paid
            ? {
                status: "paid" as const,
                paidAt: stampNow(),
                nextAttemptAt: null,
                /**
                 * `dunningFieldsOnCreditSettle`, NOT `dunningFieldsOnSettle` (corrected
                 * 2026-09-01). This branch settles the invoice with CREDIT ALONE — the
                 * card charge below has not run and, when credit covers the balance,
                 * never will. `success` therefore reported a recovered collection that
                 * never happened, which is precisely the defect `status.ts` documents
                 * against ten live invoices whose only payment attempt FAILED.
                 *
                 * The card leg is unaffected: when a charge does settle the invoice it
                 * is `collectInvoice` that marks it paid, and that path still uses the
                 * cash rule. Found while building `applyCreditsToInvoice`, which settles
                 * by credit and must not answer this question differently.
                 */
                ...dunningFieldsOnCreditSettle(row),
              }
            : {}),
        })
        .where(eq(invoices.id, row.id));
      if (paid) {
        await emitEvent(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          type: "invoice_paid",
          data: buildEventData(
            "invoice_paid",
            { id: row.publicId, amount_minor: Number(row.totalMinor), currency: row.currency },
            null,
            { paid_with_credit: true },
          ),
        });
        await activatePaidCreditGrants(tx, {
          organizationId: input.organizationId,
          invoiceId: row.id,
        });
      }
    }
    return { refApply, exApply, due };
  });
}

/**
 * `applyCreditOnFile`, then the invoice as the card leg must see it. `settled` means
 * credit covered the balance and there is nothing left to charge.
 */
export async function applyCreditBeforeCharge<T extends Invoice>(input: {
  organizationId: string;
  businessId: string;
  invoice: T;
}): Promise<{ settled: boolean; creditApplied: bigint; invoice: T }> {
  const drawn = await applyCreditOnFile(input);
  const creditApplied = drawn ? drawn.refApply + drawn.exApply : 0n;
  if (creditApplied === 0n) return { settled: false, creditApplied, invoice: input.invoice };
  const [fresh] = await withTenant(input.organizationId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, input.invoice.id)).limit(1),
  );
  return {
    settled: creditApplied >= drawn!.due,
    creditApplied,
    invoice: { ...input.invoice, ...fresh },
  };
}

/** The allocated invoices in the caller's order, each open, this customer's, with what it owes. */
async function loadAllocatedInvoices(
  organizationId: string,
  customerId: string,
  allocations: Array<{ invoiceId: string; amountMinor?: number }>,
) {
  const ids = allocations.map((a) => a.invoiceId);
  if (new Set(ids).size !== ids.length)
    throw new CollectError("invoice_allocations lists the same invoice twice");
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.customerId, customerId), inArray(invoices.publicId, ids)));
    const byId = new Map(rows.map((r) => [r.publicId, r]));
    const out: Array<{ invoice: (typeof rows)[number]; amount: bigint | null; due: bigint }> = [];
    for (const a of allocations) {
      const inv = byId.get(a.invoiceId);
      if (!inv)
        throw new CollectError(`We could not find the invoice ${a.invoiceId} for this customer.`);
      if (!(OPEN_INVOICE_STATUSES as readonly string[]).includes(inv.status))
        throw new CollectError(`Invoice ${a.invoiceId} is ${inv.status}, not open for payment`);
      const due = (await invoiceOutstanding(tx, inv)).remainingMinor;
      out.push({ invoice: inv, amount: a.amountMinor != null ? BigInt(a.amountMinor) : null, due });
    }
    return out;
  });
}
