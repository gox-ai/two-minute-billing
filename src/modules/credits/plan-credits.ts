/**
 * Credits per cycle on a recurring price (design G3 §3.6, C3): a promotional allowance inside the
 * plan fee. Runs in the period invoice's transaction, after the period's usage is drawn:
 *   1. roll over the closing cycle grant (`carry`): floor(remaining × percent ÷ 100), capped,
 *      expiring `expire_after_cycles` periods later (null = never); a rolled grant never rolls;
 *   2. expire the rest, and every rolled grant of the item whose time is up;
 *   3. grant the new cycle (amount × item quantity), effective for the period.
 * `source_ref` = item + period start, unique: a re-run of the same period grants once.
 * Steps 1–2 are `settlePlanCycles`, step 3 is `grantPlanCycle`; a held renewal invoice
 * (`invoices.hold_until`) grants at the renewal and settles at its close.
 * Items on any other reset (G3b) are granted by the credit clock (`credit-clock.ts`) only.
 *
 * `plan_credits.grant_when: invoice_paid`: with `invoiceId`, the new cycle (and the term's
 * reset windows) is `pending` against that invoice until it is paid (`activatePaidCreditGrants`),
 * and voided with it (`voidPendingGrantsForInvoice`, `voidUnpaidPlanCredits`).
 */
import { and, eq, inArray, like, lte, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import {
  CREDIT_LEDGER_ACCOUNTS,
  creditGrants,
  prices,
  subscriptionItems,
  type PriceGrantsCredit,
} from "@db/schema";
import { addInterval, type Interval } from "@/modules/subscriptions/interval";
import {
  bookGrantRemainder,
  creditUnitByKey,
  grantRemaining,
  insertCreditGrant,
  recordGrantMovement,
  unitRate,
  settleOwnUnitFirst,
} from "./service";
import { faceMinorFor, isUnrated } from "./units";
import { parseMoneyPerCreditE12, planGrantCostMinor } from "./credit-cost";
import { currencyExponent } from "@/platform/currency";
import { postEntries } from "@/modules/ledger/service";
import { ensureCreditWindows, itemReset } from "./credit-clock";
import { activatePaidCreditGrants } from "./packs";
import { readResetSettings } from "./reset-settings";
import { loadBillingRulesRow } from "@/modules/subscriptions/billing-rules-config";
import { stampNow } from "@/platform/clock";

type PerCycle = Extract<PriceGrantsCredit, { kind: "per_cycle" }>;

const cycleRef = (itemId: string, start: Date) => `${itemId}:cycle:${start.toISOString()}`;
const rolloverRef = (itemId: string, start: Date) => `${itemId}:rollover:${start.toISOString()}`;

interface PlanCycleInput {
  organizationId: string;
  businessId: string;
  subscription: { id: string; customerId: string; currency: string };
  periodStart: Date;
  periodEnd: Date;
  /** The period's own invoice, written earlier in this transaction. */
  invoiceId?: string;
}

async function perCycleItems(tx: Tx, subscriptionId: string) {
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
    .where(eq(subscriptionItems.subscriptionId, subscriptionId));
  return items.flatMap((it) =>
    it.gc?.kind === "per_cycle" && !itemReset(it.gc) ? [{ ...it, gc: it.gc as PerCycle }] : [],
  );
}

/** Steps 1–3 for one period: settle the closing cycle, then grant the new one. */
export async function applyPlanCredits(
  tx: Tx,
  input: PlanCycleInput,
): Promise<{ granted: number; rolled: number; expired: number }> {
  const settled = await settlePlanCycles(tx, input);
  const { granted } = await grantPlanCycle(tx, input);
  return { granted, ...settled };
}

/**
 * Steps 1–2: roll over and expire every term cycle grant that ended by `periodStart` (the
 * closed period's end). `periodEnd` is the new period's end, for the rolled grant's expiry.
 * Locks the grants it books; a second run finds none active and does nothing.
 */
export async function settlePlanCycles(
  tx: Tx,
  input: Omit<PlanCycleInput, "invoiceId">,
): Promise<{ rolled: number; expired: number }> {
  const out = { rolled: 0, expired: 0 };
  // The customer lock before the grant rows (the one lock order of the credit paths).
  await lockCustomerBalances(tx, input.subscription.customerId);
  for (const it of await perCycleItems(tx, input.subscription.id)) {
    const gc = it.gc;
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
    if (!due.length) continue;
    const unit = gc.unit ? await creditUnitByKey(tx, input.businessId, gc.unit) : null;
    // 1. Rollover: from the closing cycle grant only.
    const roll = gc.rollover;
    if (roll?.mode === "carry") {
      const closingCycles = due.filter(
        (g) =>
          g.sourceRef?.includes(":cycle:") &&
          !(g.metadata as { ended_by_change?: boolean } | null)?.ended_by_change,
      );
      for (const closing of closingCycles) {
        if (await settleOwnUnitFirst(tx, closing, "rollover")) continue;
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
        // A unit with no rate rolls in units only.
        if (face <= 0n && closing.unitRated) continue;
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
  }
  return out;
}

/**
 * Step 3: grant the new cycle (amount × item quantity), effective for the period. With
 * `grant_when: invoice_paid` and `invoiceId`, it waits for that invoice to be paid.
 */
export async function grantPlanCycle(tx: Tx, input: PlanCycleInput): Promise<{ granted: number }> {
  const held =
    !!input.invoiceId &&
    readResetSettings(await loadBillingRulesRow(input.organizationId, input.businessId, tx))
      .planCredits.grantWhen === "invoice_paid";
  let granted = 0;
  for (const it of await perCycleItems(tx, input.subscription.id)) {
    const gc = it.gc;
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
    const qty = BigInt(Math.max(1, it.quantity ?? 1));
    // A per-unit cost basis (0530): paid credit against the term invoice; that share of the
    // plan fee is deferred (Dr revenue / Cr credit_grants_paid) and recognised on use.
    const basisE12 =
      gc.unit_cost_basis && unit && isUnrated(unit) && input.invoiceId && !held
        ? parseMoneyPerCreditE12(gc.unit_cost_basis, currencyExponent(unit.currency))
        : null;
    const basisCost = basisE12
      ? planGrantCostMinor(BigInt(gc.amount) * qty, basisE12, unit!.decimals)
      : 0n;
    const grant = await insertCreditGrant(tx, {
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
      ...(held ? { status: "pending" as const, invoiceId: input.invoiceId } : {}),
      ...(basisCost > 0n
        ? {
            category: "paid" as const,
            costBasisMinor: basisCost,
            taxTreatment: "taxed_at_purchase" as const,
            invoiceId: input.invoiceId,
          }
        : {}),
    });
    if (basisCost > 0n)
      await postEntries(
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: input.subscription.customerId,
          sourceType: "credit_grant",
          sourceId: grant.publicId,
          lines: [
            {
              account: "revenue",
              direction: "debit",
              amountMinor: basisCost,
              currency: grant.currency,
            },
            {
              account: CREDIT_LEDGER_ACCOUNTS.paid,
              direction: "credit",
              amountMinor: basisCost,
              currency: grant.currency,
            },
          ],
        },
        tx,
      );
    granted++;
  }
  if (held) {
    // Windows that waited for this invoice are granted against it; a paid invoice opens all.
    await ensureCreditWindows(tx, {
      customerId: input.subscription.customerId,
      now: stampNow(input.businessId),
    });
    await activatePaidCreditGrants(tx, {
      organizationId: input.organizationId,
      invoiceId: input.invoiceId!,
    });
  }
  return { granted };
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
