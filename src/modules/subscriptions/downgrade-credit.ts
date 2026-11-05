/**
 * Money from a downgrade (`billing_rules_config.downgrade_credit`).
 *
 * A change that gives credit raises a refundable credit note, which stays as account
 * credit. `refund` pays back what the gateway can reverse, one funding payment per
 * `refundCreditNote` call (the operator's refund path): the cash goes back to the payments
 * that funded the customer's invoices, so bank-debit money returns to the bank debit.
 * What no gateway payment backs (offline or credit-settled money) stays as credit, with
 * nothing earmarked. A payment whose refund does not settle at once ends the run: the rest
 * stays as credit rather than being counted against cash still in flight.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businesses, creditNotes, payments, refunds } from "@db/schema";
import { createLogger } from "@/platform/logger";
import { resolveLifecycleConfig, type DowngradeCredit } from "./lifecycle-config";

const log = createLogger("subscriptions.downgrade-credit");

/** At most this many funding payments per note in one change. */
export const MAX_LEGS = 10;

export interface CreditRefundOutcome {
  creditNote: string;
  /** Paid back to the customer's payments. */
  refundedMinor: number;
  /** Left on the account as credit. */
  keptMinor: number;
  /** Why some or all of it stayed as credit. */
  reason?: string;
}

/** Where a change's credit goes: the rule, or the customer's choice under `customer_chooses`. */
export function creditHandlingFor(
  rule: DowngradeCredit,
  choice?: "credit_balance" | "refund",
): "credit_balance" | "refund" {
  if (rule === "customer_chooses") return choice ?? "credit_balance";
  return rule;
}

/** Succeeded refunds on the customer's payments, the ground truth for "it settled". */
async function settledRefunds(organizationId: string, customerId: string): Promise<bigint> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({ amountMinor: refunds.amountMinor })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(and(eq(payments.customerId, customerId), eq(refunds.status, "succeeded"))),
  );
  return rows.reduce((s, r) => s + r.amountMinor, 0n);
}

/** Null when the credit stays as balance (nothing attempted). */
export async function refundChangeCredit(input: {
  organizationId: string;
  businessId: string;
  creditNotes: Array<{ publicId: string }>;
  choice?: "credit_balance" | "refund";
  /** The operator's choice for this call; wins over the business rule. */
  override?: "credit_balance" | "refund";
}): Promise<CreditRefundOutcome[] | null> {
  const { organizationId, businessId } = input;
  if (input.override === "credit_balance") return null;
  const notes = await withTenant(organizationId, async (tx) => {
    if (!input.override) {
      const [biz] = await tx
        .select({ billingRulesConfig: businesses.billingRulesConfig })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      const rule = resolveLifecycleConfig(biz).downgradeCredit;
      if (creditHandlingFor(rule, input.choice) !== "refund") return null;
    }
    return tx
      .select()
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.businessId, businessId),
          inArray(
            creditNotes.publicId,
            input.creditNotes.map((n) => n.publicId),
          ),
        ),
      );
  });
  if (!notes) return null;
  const { creditNoteSpendable, refundCreditNote, refundableNowMinor } =
    await import("@/modules/credit-notes/service");
  const out: CreditRefundOutcome[] = [];
  for (const cn of notes) {
    // Re-read: the change may already have spent part of the note on its own invoice.
    const start = creditNoteSpendable(cn);
    if (cn.kind !== "refundable" || cn.status === "voided" || start <= 0n) continue;
    let refunded = 0n;
    let reason: string | undefined;
    for (let leg = 0; leg < MAX_LEGS; leg++) {
      const amount = await refundableNowMinor(organizationId, businessId, cn.publicId);
      if (amount <= 0n) {
        reason =
          refunded === 0n
            ? "No card or bank payment can take this refund."
            : "No other card or bank payment can take the rest.";
        break;
      }
      const before = await settledRefunds(organizationId, cn.customerId);
      try {
        await refundCreditNote({
          organizationId,
          businessId,
          creditNotePublicId: cn.publicId,
          amountMinor: Number(amount),
          reason: "Credit from a plan change, refunded by the business rule",
          gatewayOnly: true,
        });
      } catch (e) {
        reason = (e as Error)?.message ?? String(e);
        log.warn("plan-change credit not refunded — kept as account credit", {
          event: "downgrade_credit_refund_failed",
          creditNote: cn.publicId,
          businessId,
          error: reason,
        });
        break;
      }
      refunded += amount;
      if ((await settledRefunds(organizationId, cn.customerId)) - before !== amount) {
        // Accepted but not settled: counted as refunded (it fails back to credit on its own).
        reason = "A refund is still in progress. The rest stays as credit.";
        break;
      }
    }
    if (!reason && refunded < start)
      reason = `We refunded through ${MAX_LEGS} payments. The rest stays as credit.`;
    out.push({
      creditNote: cn.publicId,
      refundedMinor: Number(refunded),
      keptMinor: Number(start - refunded),
      ...(reason && refunded < start ? { reason } : {}),
    });
  }
  return out;
}
