/**
 * The ledger side of a late reversal: the gateway took back a charge we booked as settled.
 *
 * It takes back only what the payments still hold: paid, less refunds not failed, less cash
 * their disputes already took. So the cash for that money never goes below zero. Dispute money
 * moves to AR instead of leaving cash a second time. A gateway-stated amount is used when the
 * event carries one, capped at what remains.
 */
import { and, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { postEntries } from "@/modules/ledger/service";
import { refunds } from "@db/schema";

const log = createLogger("late-reversal");

export interface ReversedPayment {
  id: string;
  publicId: string;
  organizationId: string;
  businessId: string;
  customerId: string | null;
  amountMinor: bigint;
  currency: string;
}

/** Refunds not failed, per payment. */
export async function refundedByPayment(tx: Tx, ids: string[]): Promise<Map<string, bigint>> {
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ paymentId: refunds.paymentId, n: sql<string>`sum(${refunds.amountMinor})` })
    .from(refunds)
    .where(and(inArray(refunds.paymentId, ids), ne(refunds.status, "failed")))
    .groupBy(refunds.paymentId);
  return new Map(rows.map((r) => [r.paymentId, BigInt(r.n ?? "0")]));
}

/**
 * Post the reversal of `pays` (one payment, or a request's invoice children newest first).
 * The caller holds the payments' row locks and flips their status. `disputedPaymentIds` are the
 * payments whose disputes share this money (defaults to `pays`). Returns the cash taken.
 */
export async function postLateReversal(
  tx: Tx,
  input: {
    pays: ReversedPayment[];
    sourceIdFor: (p: ReversedPayment) => string;
    statedMinor?: bigint | null;
    disputedPaymentIds?: string[];
  },
): Promise<bigint> {
  const { pays } = input;
  if (!pays.length) return 0n;
  const refunded = await refundedByPayment(
    tx,
    pays.map((p) => p.id),
  );
  const left = new Map<string, bigint>();
  for (const p of pays) {
    const n = p.amountMinor - (refunded.get(p.id) ?? 0n);
    left.set(p.id, n > 0n ? n : 0n);
  }
  const totalLeft = [...left.values()].reduce((s, n) => s + n, 0n);

  const first = pays[0]!;
  const { absorbDisputesIntoReversal } = await import("@/modules/disputes/service");
  const absorbed = await absorbDisputesIntoReversal(
    tx,
    first,
    input.disputedPaymentIds ?? pays.map((p) => p.id),
    totalLeft,
  );

  let cash = totalLeft - absorbed;
  const stated = input.statedMinor;
  if (stated != null && stated >= 0n && stated < cash) cash = stated;
  if (stated != null && stated > totalLeft - absorbed)
    log.warn("a gateway stated a reversal larger than the payment still holds — capped", {
      event: "late_reversal_capped",
      payment: first.publicId,
      stated_minor: String(stated),
      capped_minor: String(cash),
    });

  // Dispute money comes off the newest first, then the cash leg fills what is left.
  let toSkip = absorbed;
  let toTake = cash;
  for (const p of pays) {
    let room = left.get(p.id)!;
    const skip = toSkip < room ? toSkip : room;
    toSkip -= skip;
    room -= skip;
    const take = toTake < room ? toTake : room;
    toTake -= take;
    if (take <= 0n) continue;
    await postEntries(
      {
        organizationId: p.organizationId,
        businessId: p.businessId,
        ...(p.customerId ? { customerId: p.customerId } : {}),
        sourceType: "payment_reversal",
        sourceId: input.sourceIdFor(p),
        lines: [
          {
            account: "accounts_receivable",
            direction: "debit",
            amountMinor: take,
            currency: p.currency,
          },
          { account: "cash", direction: "credit", amountMinor: take, currency: p.currency },
        ],
      },
      tx,
    );
  }
  return cash;
}
