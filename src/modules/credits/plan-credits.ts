/**
 * Credits per cycle on a recurring price (design G3 §3.6, C3): a promotional allowance inside the
 * plan fee. Runs in the period invoice's transaction, after the period's usage is drawn:
 *   1. roll over the closing cycle grant (`carry`): floor(remaining × percent ÷ 100), capped,
 *      expiring `expire_after_cycles` periods later (null = never); a rolled grant never rolls;
 *   2. expire the rest, and every rolled grant of the item whose time is up;
 *   3. grant the new cycle (amount × item quantity), effective for the period.
 * `source_ref` = item + period start, unique: a re-run of the same period grants once.
 * Items on any other reset (G3b) are granted by the credit clock (`credit-clock.ts`) only.
 */
import { and, eq, inArray, like, lte, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { creditGrants, prices, subscriptionItems, type PriceGrantsCredit } from "@db/schema";
import { addInterval, type Interval } from "@/modules/subscriptions/interval";
import {
  bookGrantRemainder,
  creditUnitByKey,
  grantRemaining,
  insertCreditGrant,
  recordGrantMovement,
  unitRate,
} from "./service";
import { faceMinorFor } from "./units";
import { ensureCreditWindows, itemReset } from "./credit-clock";
import { stampNow } from "@/platform/clock";

type PerCycle = Extract<PriceGrantsCredit, { kind: "per_cycle" }>;

const cycleRef = (itemId: string, start: Date) => `${itemId}:cycle:${start.toISOString()}`;
const rolloverRef = (itemId: string, start: Date) => `${itemId}:rollover:${start.toISOString()}`;

export async function applyPlanCredits(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    subscription: { id: string; customerId: string; currency: string };
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<{ granted: number; rolled: number; expired: number }> {
  const items = await tx
    .select({
      itemId: subscriptionItems.id,
      quantity: subscriptionItems.quantity,
      gc: prices.grantsCredit,
      interval: prices.interval,
      intervalCount: prices.intervalCount,
    })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .where(eq(subscriptionItems.subscriptionId, input.subscription.id));
  const out = { granted: 0, rolled: 0, expired: 0 };
  for (const it of items) {
    if (it.gc?.kind !== "per_cycle" || itemReset(it.gc)) continue;
    const gc = it.gc as PerCycle;
    const ref = cycleRef(it.itemId, input.periodStart);
    const [done] = await tx
      .select({ id: creditGrants.id })
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.businessId, input.businessId),
          eq(creditGrants.source, "plan_cycle"),
          eq(creditGrants.sourceRef, ref),
        ),
      )
      .limit(1);
    if (done) continue; // this period already ran

    const unit = gc.unit ? await creditUnitByKey(tx, input.businessId, gc.unit) : null;
    const due = await tx
      .select()
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.subscriptionItemId, it.itemId),
          eq(creditGrants.source, "plan_cycle"),
          eq(creditGrants.status, "active"),
          lte(creditGrants.expiresAt, input.periodStart),
          // Reset-window grants expire through the expiry pass.
          sql`${creditGrants.sourceRef} not like '%:w:%'`,
          sql`${creditGrants.sourceRef} not like '%:wroll:%'`,
        ),
      )
      .for("update");
    // 1. Rollover: from the closing cycle grant only.
    const roll = gc.rollover;
    if (roll?.mode === "carry") {
      const closingCycles = due.filter(
        (g) =>
          g.sourceRef?.includes(":cycle:") &&
          !(g.metadata as { ended_by_change?: boolean } | null)?.ended_by_change,
      );
      for (const closing of closingCycles) {
        const left = (await grantRemaining(tx, [closing.id])).get(closing.id)!;
        let carry = (left.units * BigInt(roll.percent ?? 100)) / 100n;
        if (roll.cap != null && carry > BigInt(roll.cap)) carry = BigInt(roll.cap);
        if (carry <= 0n) continue;
        const face =
          carry === left.units
            ? left.face
            : (() => {
                const f = faceMinorFor(carry, unitRate(unit));
                return f > left.face ? left.face : f;
              })();
        if (face <= 0n) continue;
        const cycles = roll.expire_after_cycles === undefined ? 1 : roll.expire_after_cycles;
        const expiresAt =
          cycles == null
            ? null
            : cycles === 1
              ? input.periodEnd
              : addInterval(
                  input.periodEnd,
                  (it.interval ?? "month") as Interval,
                  (it.intervalCount ?? 1) * (cycles - 1),
                );
        await recordGrantMovement(tx, {
          grant: closing,
          kind: "rollover_out",
          units: -carry,
          faceMinor: -face,
        });
        await insertCreditGrant(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: input.subscription.customerId,
          currency: closing.currency,
          unit,
          amount: carry,
          faceMinor: face,
          category: "promotional",
          priority: closing.priority,
          effectiveAt: input.periodStart,
          expiresAt,
          applicability: closing.applicability,
          source: "plan_cycle",
          sourceRef: rolloverRef(it.itemId, input.periodStart),
          subscriptionItemId: it.itemId,
          onExhausted: closing.onExhausted,
          opening: { kind: "rollover_in", ledger: false },
        });
        out.rolled++;
      }
    }
    // 2. Expire what is left of the closing cycle and of rolled grants whose time is up.
    for (const g of due) {
      await bookGrantRemainder(tx, { grant: g, kind: "expire" });
      out.expired++;
    }
    // 3. The new cycle.
    const qty = BigInt(Math.max(1, it.quantity ?? 1));
    await insertCreditGrant(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.subscription.customerId,
      currency: unit?.currency ?? input.subscription.currency,
      unit,
      amount: BigInt(gc.amount) * qty,
      category: "promotional",
      priority: gc.priority ?? 50,
      effectiveAt: input.periodStart,
      expiresAt: input.periodEnd,
      applicability: gc.applicability ?? { kind: "metered" },
      source: "plan_cycle",
      sourceRef: ref,
      subscriptionItemId: it.itemId,
      onExhausted: gc.on_exhausted ?? null,
    });
    out.granted++;
  }
  return out;
}

/**
 * Cycle 1 for an active subscription whose first period is billable but raises no invoice now
 * (`invoice_immediately: false`). The invoice that later bills it is not the term's own invoice,
 * so without this the first period would get no credits. Same `source_ref`: no double grant.
 */
export async function grantCurrentCycle(input: {
  organizationId: string;
  businessId: string;
  subscription: {
    id: string;
    customerId: string;
    currency: string;
    status: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
  };
}): Promise<void> {
  const { subscription: sub } = input;
  if (sub.status !== "active" || !sub.currentPeriodStart || !sub.currentPeriodEnd) return;
  await withTenant(input.organizationId, async (tx) => {
    await applyPlanCredits(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      subscription: sub,
      periodStart: sub.currentPeriodStart!,
      periodEnd: sub.currentPeriodEnd!,
    });
    // Reset-window items start their clock now.
    await ensureCreditWindows(tx, {
      customerId: sub.customerId,
      now: stampNow(input.businessId),
    });
  });
}

/** Plan-cycle grants of a subscription's items (for tests and the dashboard). */
export async function planCycleGrants(tx: Tx, itemIds: string[]) {
  if (!itemIds.length) return [];
  return tx
    .select()
    .from(creditGrants)
    .where(
      and(
        inArray(creditGrants.subscriptionItemId, itemIds),
        eq(creditGrants.source, "plan_cycle"),
        like(creditGrants.sourceRef, "%:%"),
      ),
    );
}
