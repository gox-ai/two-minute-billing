/**
 * Disputes a person records by hand, for gateways that send no dispute events
 * (`capabilities.disputeFeed: false`). The processor takes the money back and tells the
 * merchant directly; the operator enters what it said. The books are the gateway path's:
 * every posting goes through `applyDisputeTransition`.
 */
import { and, eq, ne } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { stampNow } from "@/platform/clock";
import { disputes, payments, refunds } from "@db/schema";
import {
  operatorRecordsDisputes,
  operatorRecordsDisputeOutcome,
  gatewayDefinition,
} from "@/providers/gateway-catalog";
import { writeAuditLog } from "@/modules/audit/service";
import {
  applyDisputeTransition,
  lockDispute,
  OPEN_DISPUTE_STATUSES,
  runChargebackPolicy,
  serializeDispute,
  type DisputeRow,
} from "./service";

/** Card-network reason categories. The value is stored in `disputes.reason`. */
export const DISPUTE_REASONS = [
  "fraudulent",
  "unrecognized",
  "duplicate",
  "subscription_canceled",
  "product_not_received",
  "product_unacceptable",
  "credit_not_processed",
  "general",
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export class DisputeError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "DisputeError";
  }
}

type PaymentRow = typeof payments.$inferSelect;

/** Captured, less refunds not failed, less disputes not won. Read under the payment lock. */
async function disputableMinor(tx: Tx, pay: PaymentRow): Promise<bigint> {
  const refunded = (
    await tx
      .select({ amount: refunds.amountMinor })
      .from(refunds)
      .where(and(eq(refunds.paymentId, pay.id), ne(refunds.status, "failed")))
  ).reduce((s, r) => s + r.amount, 0n);
  const disputed = (
    await tx
      .select({ amount: disputes.amountMinor })
      .from(disputes)
      .where(and(eq(disputes.paymentId, pay.id), ne(disputes.status, "won")))
  ).reduce((s, r) => s + r.amount, 0n);
  const left = pay.amountMinor - refunded - disputed;
  return left > 0n ? left : 0n;
}

async function hasGatewayDispute(tx: Tx, paymentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: disputes.id })
    .from(disputes)
    .where(and(eq(disputes.paymentId, paymentId), eq(disputes.source, "gateway")))
    .limit(1);
  return !!row;
}

export interface DisputeRecording {
  paymentPublicId: string;
  /** The most a new dispute may claim. */
  availableMinor: bigint;
}

/**
 * Whether a person may record a dispute on this payment, and for how much. Null when the
 * action is not offered: not a succeeded payment, a gateway that reports disputes itself,
 * or a gateway-reported dispute already on it.
 */
export async function disputeRecordingFor(
  organizationId: string,
  businessId: string,
  paymentId: string,
): Promise<DisputeRecording | null> {
  return withTenant(organizationId, async (tx) => {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.businessId, businessId), eq(payments.id, paymentId)))
      .limit(1);
    if (!pay || pay.status !== "succeeded" || !operatorRecordsDisputes(pay.providerKey))
      return null;
    if (await hasGatewayDispute(tx, pay.id)) return null;
    return { paymentPublicId: pay.publicId, availableMinor: await disputableMinor(tx, pay) };
  });
}

/**
 * Record a chargeback the processor reported: the case opens and the money leaves cash in
 * one step (`dispute.created` then `dispute.funds_withdrawn`), so the row lands
 * `under_review` with the funds held in `disputed_funds`.
 */
export async function recordOperatorDispute(input: {
  organizationId: string;
  businessId: string;
  paymentPublicId: string;
  amountMinor: bigint;
  reason: DisputeReason;
  processorReference?: string | null;
  /** When the processor opened the case. Default now. */
  openedAt?: Date;
}): Promise<DisputeRow> {
  const out = await withTenant(input.organizationId, async (tx) => {
    // Serializes with refunds and other records on this payment, which read the same caps.
    const [pay] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.businessId, input.businessId),
          eq(payments.publicId, input.paymentPublicId),
        ),
      )
      .limit(1)
      .for("update");
    if (!pay) throw new DisputeError("not_found", `No such payment: ${input.paymentPublicId}`);
    if (pay.status !== "succeeded")
      throw new DisputeError("invalid", "You can record a dispute only on a succeeded payment.");
    if (!operatorRecordsDisputes(pay.providerKey)) {
      const name = gatewayDefinition(pay.providerKey)?.displayName ?? pay.providerKey;
      throw new DisputeError(
        "invalid",
        `${name} sends its disputes to us, and we record them from its events. You cannot record a dispute on this payment by hand.`,
      );
    }
    if (await hasGatewayDispute(tx, pay.id))
      throw new DisputeError(
        "conflict",
        "The gateway already reported a dispute on this payment. Record the outcome at the gateway.",
      );
    if (input.amountMinor <= 0n)
      throw new DisputeError("invalid", "The dispute amount must be more than zero.");
    const available = await disputableMinor(tx, pay);
    if (input.amountMinor > available)
      throw new DisputeError(
        "invalid",
        `The dispute amount ${input.amountMinor} is more than the ${available} that this payment can still lose. That is the captured amount less refunds and other disputes.`,
      );
    const now = stampNow();
    const openedAt = input.openedAt ?? now;
    if (openedAt.getTime() > now.getTime() + 5 * 60_000)
      throw new DisputeError("invalid", "The dispute date cannot be in the future.");
    if (openedAt.getTime() < pay.createdAt.getTime() - 24 * 3600_000)
      throw new DisputeError("invalid", "The dispute date cannot be before the payment date.");

    const pid = publicId("dsp");
    await lockDispute(tx, input.organizationId, pid);
    const [row] = await tx
      .insert(disputes)
      .values({
        publicId: pid,
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: pay.customerId,
        paymentId: pay.id,
        invoiceId: pay.invoiceId ?? null,
        providerKey: pay.providerKey,
        // The gateway never named this case; our own id keeps the per-org key unique.
        providerDisputeId: pid,
        providerChargeId: pay.providerChargeId ?? null,
        status: "needs_response",
        reason: input.reason,
        amountMinor: input.amountMinor,
        currency: pay.currency,
        openedAt,
        source: "operator",
        processorReference: input.processorReference?.trim() || null,
      })
      .returning();
    const dispute = row!;
    const scope = {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: pay.customerId,
    };
    const phase = await applyDisputeTransition(tx, dispute, "dispute.created", scope, true);
    await applyDisputeTransition(tx, dispute, "dispute.funds_withdrawn", scope, false);
    const [after] = await tx.select().from(disputes).where(eq(disputes.id, dispute.id)).limit(1);
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "dispute.record",
        resourceType: "dispute",
        resourceId: pid,
        beforeFull: null,
        afterFull: serializeDispute(after!),
      },
      tx,
    );
    return { row: after!, phase };
  });
  if (out.phase) {
    await runChargebackPolicy({
      organizationId: input.organizationId,
      businessId: input.businessId,
      publicId: out.row.publicId,
      customerId: out.row.customerId,
      invoiceId: out.row.invoiceId,
      currency: out.row.currency,
      amountMinor: out.row.amountMinor,
      phase: out.phase,
    });
  }
  return out.row;
}

/**
 * The processor's decision on a hand-recorded dispute. `won` reinstates the funds
 * (`dispute.funds_reinstated`, then `dispute.won`); `lost` realizes the loss
 * (`dispute.lost`). A gateway dispute takes its outcome from the gateway, unless the gateway
 * never sends one (`operatorRecordsDisputeOutcome`).
 */
export async function recordDisputeOutcome(input: {
  organizationId: string;
  businessId: string;
  disputePublicId: string;
  outcome: "won" | "lost";
}): Promise<DisputeRow> {
  const out = await withTenant(input.organizationId, async (tx) => {
    const find = () =>
      tx
        .select()
        .from(disputes)
        .where(
          and(
            eq(disputes.organizationId, input.organizationId),
            eq(disputes.businessId, input.businessId),
            eq(disputes.publicId, input.disputePublicId),
          ),
        )
        .limit(1);
    const [found] = await find();
    if (!found) throw new DisputeError("not_found", `No such dispute: ${input.disputePublicId}`);
    await lockDispute(tx, input.organizationId, found.providerDisputeId);
    // Read again under the lock: a second outcome waits here and then sees the first.
    const [dispute] = await find();
    // A gateway that never sends a final state leaves its disputes open: a person closes them.
    if (dispute!.source !== "operator" && !operatorRecordsDisputeOutcome(dispute!.providerKey))
      throw new DisputeError(
        "invalid",
        "The gateway reports the outcome of this dispute. You cannot set it by hand.",
      );
    if (!(OPEN_DISPUTE_STATUSES as readonly string[]).includes(dispute!.status))
      throw new DisputeError(
        "conflict",
        `This dispute is already ${dispute!.status.replace(/_/g, " ")}. You cannot change its outcome.`,
      );
    const before = { status: dispute!.status, funds_withdrawn: dispute!.fundsWithdrawn === "true" };
    const scope = {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: dispute!.customerId,
    };
    let phase: "initiated" | "lost" | null = null;
    if (input.outcome === "won") {
      await applyDisputeTransition(tx, dispute!, "dispute.funds_reinstated", scope, false);
      await applyDisputeTransition(tx, dispute!, "dispute.won", scope, false);
    } else {
      phase = await applyDisputeTransition(tx, dispute!, "dispute.lost", scope, false);
    }
    const [after] = await tx.select().from(disputes).where(eq(disputes.id, dispute!.id)).limit(1);
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: input.outcome === "won" ? "dispute.mark_won" : "dispute.mark_lost",
        resourceType: "dispute",
        resourceId: dispute!.publicId,
        before,
        after: { status: after!.status, funds_withdrawn: after!.fundsWithdrawn === "true" },
      },
      tx,
    );
    return { row: after!, phase };
  });
  if (out.phase) {
    await runChargebackPolicy({
      organizationId: input.organizationId,
      businessId: input.businessId,
      publicId: out.row.publicId,
      customerId: out.row.customerId,
      invoiceId: out.row.invoiceId,
      currency: out.row.currency,
      amountMinor: out.row.amountMinor,
      phase: out.phase,
    });
  }
  return out.row;
}
