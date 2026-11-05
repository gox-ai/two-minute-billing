/**
 * Several due invoices, one charge (setting 2.51, `payment_application.several_due_invoices =
 * combined`). When the clock retries an invoice, the same customer's other retries that are
 * due now are charged with it, through a `dunning`-origin payment request: one gateway
 * charge, one child payment per invoice. A decline fails each child as that invoice's own
 * attempt (`settleRequestFailed` → `settlePaymentFailed`), so every invoice keeps its own
 * schedule, caps and final action.
 *
 * Combined only when every instrument in the charge order is a card with no mandate and no
 * pre-debit notice, and the total stays inside the card limit. Mandate rails cap each debit
 * and count presentations per invoice, and a notice names one amount, so those customers
 * keep one charge each. Anything that refuses before a charge falls back to one charge each.
 */
import { and, eq, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import {
  CollectionInFlightError,
  autoCollectionOnSql,
  dunningHoldFor,
  dunningNotHeldSql,
  invoiceOutstanding,
} from "@/modules/invoicing/service";
import { chargeOrder, resolveChargeCandidates, type Pm } from "@/modules/invoicing/collection";
import { presentationBlock } from "@/modules/invoicing/representment";
import { isCardInstrument, overCardLimit } from "@/modules/invoicing/card-limit";
import { loadPaymentApplication } from "@/modules/payments/application-config";
import { businesses, customers, invoices, paymentRequestInvoices, subscriptions } from "@db/schema";

const log = createLogger("dunning-combined");

type Invoice = typeof invoices.$inferSelect;
type Sub = typeof subscriptions.$inferSelect;

/** At most this many invoices in one combined charge (the request limit is 50). */
const MAX_GROUP = 20;

export type CombinedOutcome = "recovered" | "still_failing" | "canceled";

/**
 * Try the combined charge for `primary`, already claimed by `retryInvoice` (its
 * `next_attempt_at` is null) with credit on file applied. Null = not combined: the caller
 * charges the primary alone, as today.
 */
export async function tryCombinedRetry(input: {
  organizationId: string;
  businessId: string;
  primary: Invoice;
  subscription: Sub | null;
  now: Date;
}): Promise<CombinedOutcome | null> {
  const { organizationId, businessId, primary, now } = input;
  const cfg = await loadPaymentApplication(organizationId, businessId);
  if (cfg.severalDueInvoices !== "combined") return null;

  const order = await combinableOrder(
    organizationId,
    businessId,
    primary.currency,
    chargeOrder(
      await resolveChargeCandidates({
        organizationId,
        customerId: primary.customerId,
        subscription: input.subscription,
        currency: primary.currency,
      }),
    ),
    now,
  );
  if (!order) return null;

  const siblings = await dueSiblings(organizationId, primary, now);
  if (siblings.length === 0) return null;

  // Each sibling must resolve to the same first instrument (its subscription may name another).
  const group: Array<{ inv: Invoice; sub: Sub | null; nextAttemptAt: Date }> = [];
  for (const s of siblings) {
    const own = chargeOrder(
      await resolveChargeCandidates({
        organizationId,
        customerId: s.inv.customerId,
        subscription: s.sub,
        currency: s.inv.currency,
      }),
    );
    if (own[0]?.id === order[0]!.id) group.push(s);
  }
  if (group.length === 0) return null;

  const total = await withTenant(organizationId, async (tx) => {
    let sum = 0n;
    for (const inv of [primary, ...group.map((g) => g.inv)])
      sum += (await invoiceOutstanding(tx, inv)).remainingMinor;
    const [biz] = await tx
      .select({ cardPaymentLimits: businesses.cardPaymentLimits })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return { sum, overLimit: overCardLimit(biz, primary.currency, sum) };
  });
  // Above the card limit a combined charge has no card left; one charge each still may.
  if (total.overLimit) return null;

  // Claim each sibling's retry as `retryInvoice` claims the primary's.
  const claimed = await withTenant(organizationId, async (tx) => {
    const out: typeof group = [];
    for (const g of group) {
      const [row] = await tx
        .update(invoices)
        .set({ nextAttemptAt: null })
        .where(
          and(
            eq(invoices.id, g.inv.id),
            eq(invoices.status, "payment_due"),
            isNotNull(invoices.nextAttemptAt),
            lte(invoices.nextAttemptAt, now),
          ),
        )
        .returning({ id: invoices.id });
      if (row) out.push(g);
    }
    return out;
  });
  if (claimed.length === 0) return null;
  const restore = () => restoreRetries(organizationId, claimed);

  const pr = await import("@/modules/payment-requests/service");
  let requestId: string;
  try {
    const view = await pr.createPaymentRequest({
      organizationId,
      businessId,
      customerPublicId: await customerPublicId(organizationId, primary.customerId),
      invoicePublicIds: [primary.publicId, ...claimed.map((g) => g.inv.publicId)],
      mode: "charge",
      origin: "dunning",
      createdBy: "billing_clock",
    });
    requestId = view.request.publicId;
  } catch (e) {
    await restore();
    if (e instanceof pr.PaymentRequestError) {
      log.info("combined retry not created; charging one each", {
        event: "dunning_combined_refused",
        invoice: primary.publicId,
        reason: e.message,
      });
      return null;
    }
    throw e;
  }

  try {
    await pr.chargePaymentRequest({
      organizationId,
      businessId,
      paymentRequestPublicId: requestId,
      initiator: "merchant",
      candidates: order,
    });
  } catch (e) {
    if (!(e instanceof pr.PaymentRequestError) && !(e instanceof CollectionInFlightError)) throw e;
    const view = await pr.getPaymentRequest(organizationId, businessId, requestId);
    if (view && view.request.attemptCount === 0) {
      // Refused before any charge: close the request and charge one each.
      if (view.request.status === "open")
        await pr.cancelPaymentRequest({
          organizationId,
          businessId,
          paymentRequestPublicId: requestId,
          reason: "combined_charge_refused",
        });
      await restore();
      return null;
    }
    // A decline: each invoice was re-armed by its own failure.
  }

  log.info("combined dunning retry charged", {
    event: "dunning_combined_charge",
    request: requestId,
    invoices: 1 + claimed.length,
    amountMinor: total.sum.toString(),
  });
  return finishGroup(organizationId, businessId, [
    { inv: primary, sub: input.subscription },
    ...claimed,
  ]);
}

/**
 * The charge order when it can be combined: every instrument a plain card with no mandate on a
 * gateway that needs no notice. A backup at its attempt cap is left out, as a single retry
 * leaves it out; a capped first card means no combined charge (the single retry defers it).
 */
async function combinableOrder(
  organizationId: string,
  businessId: string,
  currency: string,
  order: Pm[],
  now: Date,
): Promise<Pm[] | null> {
  if (order.length === 0) return null;
  const { isNoticeRail } = await import("@/modules/payment-requests/service");
  const out: Pm[] = [];
  for (const [i, pm] of order.entries()) {
    if (!isCardInstrument(pm) || pm.mandateRail) return null;
    if (await isNoticeRail(organizationId, businessId, currency, pm)) return null;
    if (await presentationBlock({ organizationId, pm, now, applyCaps: true })) {
      if (i === 0) return null;
      continue;
    }
    out.push(pm);
  }
  return out;
}

/** The customer's other retries due now that the dunning pass itself would retry. */
async function dueSiblings(
  organizationId: string,
  primary: Invoice,
  now: Date,
): Promise<Array<{ inv: Invoice; sub: Sub | null; nextAttemptAt: Date }>> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ inv: invoices, sub: subscriptions })
      .from(invoices)
      // The joins exist for `autoCollectionOnSql`, as in `runDunningPass`.
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .leftJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId))
      .where(
        and(
          eq(invoices.businessId, primary.businessId),
          eq(invoices.customerId, primary.customerId),
          eq(invoices.currency, primary.currency),
          ne(invoices.id, primary.id),
          eq(invoices.status, "payment_due"),
          isNotNull(invoices.nextAttemptAt),
          lte(invoices.nextAttemptAt, now),
          autoCollectionOnSql(),
          dunningNotHeldSql(),
          sql`not exists (select 1 from ${paymentRequestInvoices} pri
                where pri.invoice_id = ${invoices.id} and pri.state = 'open')`,
        ),
      )
      .orderBy(invoices.createdAt)
      .limit(MAX_GROUP - 1);
    const cfg = await loadEffectiveDunningConfig(tx, {
      businessId: primary.businessId,
      customerId: primary.customerId,
    });
    const out: Array<{ inv: Invoice; sub: Sub | null; nextAttemptAt: Date }> = [];
    for (const r of rows) {
      // The two skips `retryDueInvoice` makes before it claims.
      if (!r.inv.subscriptionId && (!cfg.enabled || !cfg.dunOneTimeInvoices)) continue;
      if (r.inv.subscriptionId && !r.sub) continue;
      if ((await dunningHoldFor(tx, r.inv, cfg)) !== null) continue;
      out.push({ inv: r.inv, sub: r.sub, nextAttemptAt: r.inv.nextAttemptAt! });
    }
    return out;
  });
}

/** Give back the retry instants this run claimed but did not charge. */
async function restoreRetries(
  organizationId: string,
  claimed: Array<{ inv: Invoice; nextAttemptAt: Date }>,
): Promise<void> {
  await withTenant(organizationId, async (tx) => {
    for (const g of claimed)
      await tx
        .update(invoices)
        .set({ nextAttemptAt: g.nextAttemptAt })
        .where(
          and(
            eq(invoices.id, g.inv.id),
            eq(invoices.status, "payment_due"),
            isNull(invoices.nextAttemptAt),
          ),
        );
  });
}

async function customerPublicId(organizationId: string, customerId: string): Promise<string> {
  const [c] = await withTenant(organizationId, (tx) =>
    tx
      .select({ publicId: customers.publicId })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1),
  );
  return c!.publicId;
}

/**
 * After the charge: an exhausted invoice gets the business's final action, as
 * `retryInvoice` gives a single one. The primary's state is the caller's outcome.
 */
async function finishGroup(
  organizationId: string,
  businessId: string,
  group: Array<{ inv: Invoice; sub: Sub | null }>,
): Promise<CombinedOutcome> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(
        inArray(
          invoices.id,
          group.map((g) => g.inv.id),
        ),
      ),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { applyDunningFinalAction } = await import("./dunning");
  let outcome: CombinedOutcome = "still_failing";
  for (const [i, g] of group.entries()) {
    const now = byId.get(g.inv.id);
    if (!now) continue;
    if (i === 0 && now.status === "paid") outcome = "recovered";
    if (now.status !== "not_paid" || now.dunningStatus !== "exhausted") continue;
    const config = await withTenant(organizationId, (tx) =>
      loadEffectiveDunningConfig(tx, { businessId, customerId: now.customerId }),
    );
    await applyDunningFinalAction({
      organizationId,
      businessId,
      invoicePublicId: now.publicId,
      subscriptionId: g.inv.subscriptionId,
      subscriptionPublicId: g.sub?.publicId ?? null,
      config,
    });
    if (i === 0 && g.inv.subscriptionId && config.finalAction.subscription === "cancel")
      outcome = "canceled";
  }
  return outcome;
}
