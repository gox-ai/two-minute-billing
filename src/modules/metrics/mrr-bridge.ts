/**
 * The MRR bridge for a window: opening MRR, the change split by reason, closing MRR, and the
 * largest movements behind each reason.
 *
 * Built on the movements ledger's own identity (Σ delta over a window = the change in MRR
 * across it), so opening is Σ delta before the window and closing is opening + Σ delta in it.
 * Movements are netted on `NETTED_KEYS` first, so a restated move counts once.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { customers, mrrMovements, products, subscriptions } from "@db/schema";
import { accountHolderName } from "@/modules/customers/names";
import {
  NETS_TO_SOMETHING,
  NETTED_KEYS,
  carried,
  nettedDelta,
  type MrrMovementReason,
} from "./mrr-movements";

export const BRIDGE_REASONS: readonly MrrMovementReason[] = [
  "new",
  "expansion",
  "reactivation",
  "resume",
  "contraction",
  "pause",
  "churn",
];

export interface MrrBridgeInput {
  from: Date;
  /** Exclusive. */
  to: Date;
  currency: string;
  /** Largest movements listed per reason. */
  top: number;
}

type Move = {
  subscriptionId: string;
  occurredAt: Date;
  reason: string;
  delta: bigint;
  customerId: string | null;
  previous: string;
  next: string;
  plan: string | null;
  previousPlan: string | null;
};

export async function mrrBridge(organizationId: string, businessId: string, input: MrrBridgeInput) {
  return withTenant(organizationId, async (tx) => {
    const scope = and(
      eq(mrrMovements.businessId, businessId),
      eq(mrrMovements.currency, input.currency),
    );
    const [opening] = await tx
      .select({ v: sql<string>`coalesce(sum(${mrrMovements.deltaMinor}), 0)` })
      .from(mrrMovements)
      .where(and(scope, lt(mrrMovements.occurredAt, input.from)));

    const moves: Move[] = await tx
      .select({
        subscriptionId: mrrMovements.subscriptionId,
        occurredAt: mrrMovements.occurredAt,
        reason: mrrMovements.reason,
        delta: nettedDelta(),
        customerId: carried<string | null>(mrrMovements.customerId),
        previous: carried<string>(mrrMovements.previousMrrMinor),
        next: carried<string>(mrrMovements.newMrrMinor),
        plan: carried<string | null>(mrrMovements.planProductId),
        previousPlan: carried<string | null>(mrrMovements.previousPlanProductId),
      })
      .from(mrrMovements)
      .where(
        and(scope, gte(mrrMovements.occurredAt, input.from), lt(mrrMovements.occurredAt, input.to)),
      )
      .groupBy(...NETTED_KEYS)
      .having(NETS_TO_SOMETHING);

    const byReason = new Map<string, Move[]>();
    for (const m of moves) byReason.set(m.reason, [...(byReason.get(m.reason) ?? []), m]);

    const shown = [...byReason.values()].flatMap((ms) =>
      [...ms].sort((a, b) => absCmp(b.delta, a.delta)).slice(0, input.top),
    );
    const subIds = [...new Set(shown.map((m) => m.subscriptionId))];
    const cusIds = [...new Set(shown.map((m) => m.customerId).filter((x): x is string => !!x))];
    const prodIds = [
      ...new Set(shown.flatMap((m) => [m.plan, m.previousPlan]).filter((x): x is string => !!x)),
    ];
    const [subRows, cusRows, prodRows] = await Promise.all([
      subIds.length
        ? tx
            .select({ id: subscriptions.id, publicId: subscriptions.publicId })
            .from(subscriptions)
            .where(inArray(subscriptions.id, subIds))
        : [],
      cusIds.length ? tx.select().from(customers).where(inArray(customers.id, cusIds)) : [],
      prodIds.length
        ? tx
            .select({ id: products.id, publicId: products.publicId, name: products.name })
            .from(products)
            .where(inArray(products.id, prodIds))
        : [],
    ]);
    const sub = new Map(subRows.map((r) => [r.id, r.publicId]));
    const cus = new Map(cusRows.map((r) => [r.id, r]));
    const prod = new Map(prodRows.map((r) => [r.id, r]));
    const plan = (id: string | null) =>
      id && prod.get(id) ? { id: prod.get(id)!.publicId, name: prod.get(id)!.name } : null;

    const openingMinor = BigInt(opening?.v ?? "0");
    let changeMinor = 0n;
    const reasons = BRIDGE_REASONS.map((reason) => {
      const ms = byReason.get(reason) ?? [];
      const total = ms.reduce((s, m) => s + m.delta, 0n);
      changeMinor += total;
      return {
        reason,
        mrr_delta_minor: Number(total),
        movements: ms.length,
        largest: [...ms]
          .sort((a, b) => absCmp(b.delta, a.delta))
          .slice(0, input.top)
          .map((m) => {
            const c = m.customerId ? cus.get(m.customerId) : undefined;
            return {
              subscription: sub.get(m.subscriptionId) ?? null,
              customer: c?.publicId ?? null,
              customer_name: c ? accountHolderName(c) : null,
              plan: plan(m.plan),
              previous_plan: m.previousPlan !== m.plan ? plan(m.previousPlan) : null,
              previous_mrr_minor: Number(m.previous),
              new_mrr_minor: Number(m.next),
              mrr_delta_minor: Number(m.delta),
              occurred_at: m.occurredAt,
            };
          }),
      };
    });
    // A reason outside the list would break the identity silently; surface it instead.
    const other = moves.filter((m) => !BRIDGE_REASONS.includes(m.reason as MrrMovementReason));
    const otherMinor = other.reduce((s, m) => s + m.delta, 0n);
    return {
      object: "mrr_bridge",
      currency: input.currency,
      from: input.from,
      to: input.to,
      opening_mrr_minor: Number(openingMinor),
      change_minor: Number(changeMinor + otherMinor),
      closing_mrr_minor: Number(openingMinor + changeMinor + otherMinor),
      reasons,
      ...(other.length ? { unclassified_minor: Number(otherMinor) } : {}),
    };
  });
}

function absCmp(a: bigint, b: bigint): number {
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  return x === y ? 0 : x > y ? 1 : -1;
}
