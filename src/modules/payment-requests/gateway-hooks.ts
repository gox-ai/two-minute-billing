/**
 * Where a gateway event names only the CHARGE of a payment request, these spread it over the
 * request's child payments. Callers live outside the gateway-owned paths: the inbound
 * webhook handlers, the dispute correlator, the refund service and the settlement module.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { invoices, paymentRequests, payments, refunds, transactions } from "@db/schema";
import { postEntries } from "@/modules/ledger/service";
import {
  bucketBalance,
  EXCESS_PAYMENT,
  lockCustomerBalances,
} from "@/modules/customers/balances-read";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { chargeChildrenNewestFirst, spreadNewestFirst } from "./service";
import type { ProviderRefundRecord } from "@/providers/types";

const log = createLogger("payment-requests");

/** The request holding this gateway charge, across the delivering business when known. */
export async function requestByCharge(
  providerChargeId: string,
  businessId?: string | null,
): Promise<typeof paymentRequests.$inferSelect | null> {
  const rows = await systemDb
    .select()
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.providerChargeId, providerChargeId),
        ...(businessId ? [eq(paymentRequests.businessId, businessId)] : []),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    log.error(new Error("ambiguous payment request charge id — refusing to guess"), {
      event: "payment_request_charge_ambiguous",
      provider_charge_id: providerChargeId,
    });
    return null;
  }
  return rows[0] ?? null;
}

/** Refunds already claiming each child (anything not `failed`). */
async function claimedByChild(tx: Tx, childIds: string[]): Promise<Map<string, bigint>> {
  if (!childIds.length) return new Map();
  const rows = await tx
    .select({ paymentId: refunds.paymentId, n: sql<string>`sum(${refunds.amountMinor})` })
    .from(refunds)
    .where(and(inArray(refunds.paymentId, childIds), sql`${refunds.status} <> 'failed'`))
    .groupBy(refunds.paymentId);
  return new Map(rows.map((r) => [r.paymentId, BigInt(r.n ?? "0")]));
}

/**
 * An out-of-band refund on a request's charge (`charge.refunded` with no payment row for the
 * charge). Books the delta not yet recorded, spread over the children newest invoice first,
 * each capped at what is left on it. Returns null when the charge is not a request's.
 *
 * With `refunds` (one record per gateway refund) each refund is booked at its own amount,
 * once per refund id; a failed record reverses what that id booked. `amountRefundedMinor`
 * is then ignored.
 */
export async function applyRequestChargeRefund(input: {
  providerKey: string;
  providerChargeId: string;
  providerRefundId?: string | null;
  amountRefundedMinor?: bigint | null;
  refunds?: ProviderRefundRecord[];
  deliveredByBusinessId?: string | null;
}): Promise<"processed" | "ignored" | null> {
  const req = await requestByCharge(input.providerChargeId, input.deliveredByBusinessId);
  if (!req) return null;
  const toSettle: RefundRow[] = [];
  const toReverse: RefundRow[] = [];
  const booked = await withTenant(req.organizationId, async (tx) => {
    // Serializes concurrent refund deliveries: each reads what is claimed, then books the delta.
    await tx
      .select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(eq(paymentRequests.id, req.id))
      .for("update");
    const children = await chargeChildrenNewestFirst(tx, req.id);
    if (!children.length) return false;
    const ids = children.map((c) => c.id);
    const rowsFor = (providerRefundId: string) =>
      tx
        .select()
        .from(refunds)
        .where(
          and(
            inArray(refunds.paymentId, ids),
            eq(refunds.providerKey, input.providerKey),
            eq(refunds.providerRefundId, providerRefundId),
          ),
        );
    if (!input.refunds) {
      if (input.providerRefundId && (await rowsFor(input.providerRefundId)).length) return false;
      const recorded = [...(await claimedByChild(tx, ids)).values()].reduce((s, n) => s + n, 0n);
      const total = children.reduce((s, c) => s + c.amountMinor, 0n);
      const reported = input.amountRefundedMinor ?? total;
      return spreadRefund(
        tx,
        req,
        children,
        input,
        input.providerRefundId ?? null,
        reported - recorded,
      );
    }
    let any = false;
    for (const rec of input.refunds) {
      const seen = await rowsFor(rec.providerRefundId);
      if (seen.length) {
        if (rec.status === "failed") toReverse.push(...seen.filter((r) => r.status !== "failed"));
        else if (rec.status === "succeeded")
          toSettle.push(...seen.filter((r) => r.status === "pending"));
        continue;
      }
      // Ours books itself; out of band books only once it has landed.
      if (rec.ownershipRef || rec.status !== "succeeded") continue;
      if (await spreadRefund(tx, req, children, input, rec.providerRefundId, rec.amountMinor))
        any = true;
    }
    return any;
  });
  const { settleRefund, reverseRefund } = await import("@/modules/refunds/settlement");
  let changed = booked;
  for (const r of toSettle) if (await settleRefund(r)) changed = true;
  // The gateway reported these refunds failed.
  for (const r of toReverse)
    if (await reverseRefund(r, { failureCode: null, gatewayConfirmed: true })) changed = true;
  return changed ? "processed" : "ignored";
}

type RefundRow = typeof refunds.$inferSelect;
type ChargeChild = Awaited<ReturnType<typeof chargeChildrenNewestFirst>>[number];

/** Book `amount` (capped at what the children still hold) as out-of-band refunds. */
async function spreadRefund(
  tx: Tx,
  req: typeof paymentRequests.$inferSelect,
  children: ChargeChild[],
  input: { providerKey: string },
  providerRefundId: string | null,
  amount: bigint,
): Promise<boolean> {
  const claimed = await claimedByChild(
    tx,
    children.map((c) => c.id),
  );
  const left = children.reduce((s, c) => s + c.amountMinor - (claimed.get(c.id) ?? 0n), 0n);
  const delta = amount < left ? amount : left;
  if (delta <= 0n) return false;
  const parts = spreadNewestFirst(
    children,
    delta,
    (c) => c.amountMinor - (claimed.get(c.id) ?? 0n),
  );
  for (const p of parts) {
    const [refund] = await tx
      .insert(refunds)
      .values({
        organizationId: req.organizationId,
        businessId: req.businessId,
        paymentId: p.child.id,
        publicId: publicId("re"),
        status: "succeeded",
        amountMinor: p.amountMinor,
        currency: p.child.currency,
        reason: "out_of_band",
        providerKey: input.providerKey,
        providerRefundId,
      })
      .returning();
    await postEntries(
      {
        organizationId: req.organizationId,
        businessId: req.businessId,
        customerId: p.child.customerId,
        sourceType: "refund",
        sourceId: refund!.publicId,
        lines: [
          {
            account: "refunds",
            direction: "debit",
            amountMinor: p.amountMinor,
            currency: p.child.currency,
          },
          {
            account: "cash",
            direction: "credit",
            amountMinor: p.amountMinor,
            currency: p.child.currency,
          },
        ],
      },
      tx,
    );
  }
  log.info("gateway refund on a payment request charge spread over its children", {
    event: "payment_request_refund_spread",
    request: req.publicId,
    parts: parts.length,
    amountMinor: String(delta),
  });
  return true;
}

/**
 * The child a dispute on a request's charge is attributed to: the newest invoice the
 * disputed amount reaches. The dispute ledger posts the dispute amount itself.
 */
export async function requestDisputeTarget(
  txn: { organizationId: string; paymentRequestId: string | null },
  amountMinor: bigint,
): Promise<{ paymentId: string; invoiceId: string | null } | null> {
  if (!txn.paymentRequestId) return null;
  return withTenant(txn.organizationId, async (tx) => {
    const children = await chargeChildrenNewestFirst(tx, txn.paymentRequestId!);
    const parts = spreadNewestFirst(
      children,
      amountMinor > 0n ? amountMinor : 1n,
      (c) => c.amountMinor,
    );
    const first = parts[0]?.child ?? children[0];
    if (!first) return null;
    if (parts.length > 1)
      log.warn("a dispute on a payment request charge spans several invoices", {
        event: "payment_request_dispute_spread",
        payments: parts.map((p) => p.child.publicId),
      });
    return { paymentId: first.id, invoiceId: first.invoiceId };
  });
}

/**
 * The gateway reversed a request's settled charge (late failure): every succeeded invoice
 * child is reversed (what it still holds goes back to AR) and its invoice reopens for
 * collection; a child with no invoice gives back the credit it still holds. The request
 * reopens. `statedMinor` is the amount the gateway says it took, when it says.
 */
export async function reverseRequestCharge(
  tx: Tx,
  txn: typeof transactions.$inferSelect,
  occurredAt: Date,
  statedMinor: bigint | null = null,
  /** The reversal's normalised decline and verdict, as the direct reversal path gets them. */
  decline: { declineCode?: string; retriable?: boolean } = {},
): Promise<void> {
  if (!txn.paymentRequestId) return;
  const children = await chargeChildrenNewestFirst(tx, txn.paymentRequestId);
  // Same lock order as disputes on this money (payment id ascending).
  if (children.length)
    await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        inArray(
          payments.id,
          children.map((c) => c.id),
        ),
      )
      .orderBy(asc(payments.id))
      .for("update");
  const { postLateReversal } = await import("@/modules/payments/late-reversal");
  await postLateReversal(tx, {
    pays: children.filter((c) => c.invoiceId),
    sourceIdFor: (p) => p.publicId,
    statedMinor,
    disputedPaymentIds: children.map((c) => c.id),
  });
  for (const pay of children) {
    await tx
      .update(payments)
      .set({
        status: "failed",
        failureCode: "late_failure",
        reversalCode: decline.declineCode ?? null,
      })
      .where(eq(payments.id, pay.id));
    if (!pay.invoiceId) {
      await reverseDetachedChild(tx, txn, pay);
      continue;
    }
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, pay.invoiceId)).limit(1);
    if (!inv || inv.status !== "paid") continue;
    // The same re-arm as a direct reversal: a terminate-class or revoked-mandate decline
    // is not re-presented the next day.
    const { rearmReversedInvoice } = await import("@/modules/webhooks/inbound");
    const { inv: upd, set } = await rearmReversedInvoice(tx, {
      organizationId: txn.organizationId,
      businessId: txn.businessId,
      invoice: inv,
      paymentMethodId: pay.paymentMethodId ?? txn.paymentMethodId,
      occurredAt,
      declineCode: decline.declineCode,
      retriable: decline.retriable ?? true,
      paymentId: pay.id,
    });
    // Still paid (other money, or voided meanwhile): no dunning, and the line stays closed.
    if (!upd) continue;
    const reopened = set.status === "payment_due";
    await emitEvent(tx, {
      organizationId: txn.organizationId,
      businessId: txn.businessId,
      type: reopened ? "invoice_payment_due" : "invoice_not_paid",
      data: reopened
        ? buildEventData(
            "invoice_payment_due",
            { id: upd.publicId, next_attempt_at: set.nextAttemptAt ?? null },
            null,
            { reopened: "late_failure" },
          )
        : buildEventData("invoice_not_paid", { id: upd.publicId }, null, {
            reopened: "late_failure",
          }),
    });
    // Back into the request, unless another open request took the invoice meanwhile.
    await tx.execute(sql`
      update payment_request_invoices set state = 'open'
      where request_id = ${txn.paymentRequestId} and invoice_id = ${inv.id}
        and not exists (select 1 from payment_request_invoices o
                        where o.invoice_id = ${inv.id} and o.state = 'open')`);
  }
  const [req] = await tx
    .update(paymentRequests)
    .set({
      status: "open",
      paidAt: null,
      lastPaymentError: {
        code: "late_failure",
        message: "The payment was reversed after it settled.",
      },
    })
    .where(eq(paymentRequests.id, txn.paymentRequestId))
    .returning();
  if (req)
    await emitEvent(tx, {
      organizationId: req.organizationId,
      businessId: req.businessId,
      type: "payment_request_payment_failed",
      data: buildEventData("payment_request_payment_failed", {
        id: req.publicId,
        status: req.status,
        code: "late_failure",
      }),
    });
}

/**
 * A child with no invoice (overshoot, or a late capture's excess) booked cash against the
 * customer's excess credit, never AR. Its refunds already returned their part, so only what
 * it still holds leaves: excess → cash. Credit the customer already spent is owed again (AR,
 * with no invoice to reopen) and is logged for an operator.
 */
async function reverseDetachedChild(
  tx: Tx,
  txn: typeof transactions.$inferSelect,
  pay: typeof payments.$inferSelect,
): Promise<void> {
  const { excessHeldByPayment, EXCESS_REVERSAL_SOURCE } = await import("@/modules/refunds/excess");
  await lockCustomerBalances(tx, pay.customerId);
  const held = await excessHeldByPayment(tx, pay.publicId);
  if (held === 0n) return;
  const bucket = await bucketBalance(tx, pay.customerId, EXCESS_PAYMENT, pay.currency);
  const fromCredit = held < bucket ? held : bucket;
  const owed = held - fromCredit;
  const line = (account: string, amountMinor: bigint) => ({
    account,
    direction: "debit" as const,
    amountMinor,
    currency: pay.currency,
  });
  await postEntries(
    {
      organizationId: txn.organizationId,
      businessId: txn.businessId,
      customerId: pay.customerId,
      sourceType: EXCESS_REVERSAL_SOURCE,
      sourceId: pay.publicId,
      lines: [
        ...(fromCredit > 0n ? [line(EXCESS_PAYMENT, fromCredit)] : []),
        ...(owed > 0n ? [line("accounts_receivable", owed)] : []),
        { account: "cash", direction: "credit", amountMinor: held, currency: pay.currency },
      ],
    },
    tx,
  );
  if (owed > 0n)
    log.error(new Error("a reversed payment request charge took back credit already spent"), {
      event: "payment_request_reversal_credit_spent",
      payment: pay.publicId,
      owedMinor: String(owed),
      currency: pay.currency,
    });
}

/** The gateway charge and account to refund a child payment through: its request's. */
export async function requestChargeForChild(
  tx: Tx,
  pay: { paymentRequestId: string | null },
): Promise<{
  providerChargeId: string;
  providerKey: string | null;
  gatewayAccountId: string | null;
} | null> {
  if (!pay.paymentRequestId) return null;
  const [req] = await tx
    .select({
      providerChargeId: paymentRequests.providerChargeId,
      providerKey: paymentRequests.providerKey,
      gatewayAccountId: paymentRequests.gatewayAccountId,
    })
    .from(paymentRequests)
    .where(eq(paymentRequests.id, pay.paymentRequestId))
    .limit(1);
  if (!req?.providerChargeId) return null;
  return {
    providerChargeId: req.providerChargeId,
    providerKey: req.providerKey,
    gatewayAccountId: req.gatewayAccountId,
  };
}
