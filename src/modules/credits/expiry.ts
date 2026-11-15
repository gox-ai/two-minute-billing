/**
 * The `expire_credit_grants` pass (design G3 §3.8): a grant past its expiry is booked out only
 * when no invoice can still draw it, i.e. every metered item of the customer bills usage from
 * on or after the expiry (`usageWindowStart`). Term plan grants expire in the renewal instead;
 * reset-window plan grants (G3b) expire here.
 */
import { and, eq, inArray, isNotNull, like, lte, ne, or, sql } from "drizzle-orm";
import { scanBusinessFilter } from "@/platform/clock";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import { createLogger } from "@/platform/logger";
import { creditGrants, prices, subscriptionItems, subscriptions } from "@db/schema";
import { isMeteredPrice, snapshotPrice, type PriceSnapshot } from "@/modules/catalog/pricing";
import { usageWindowStart } from "@/modules/subscriptions/usage-window";
import { ensureCreditWindows } from "./credit-clock";
import { bookGrantRemainder, type CreditGrant } from "./service";

const log = createLogger("credits.expiry");

/**
 * Close one grant past its expiry: the one close for this pass and for the gate at ingest
 * (`bringUnitBalanceToNow`). In a unit that pays usage, what is left moves to the grant's
 * grace row; otherwise it is booked out. Caller holds `lockCustomerBalances`.
 */
export async function closeExpiredGrant(tx: Tx, g: CreditGrant, now: Date): Promise<void> {
  // A window grant in a unit with no rate waits for no invoice: roll it over first.
  if (!g.unitRated && g.source === "plan_cycle")
    await ensureCreditWindows(tx, { customerId: g.customerId, now });
  await bookGrantRemainder(tx, { grant: g, kind: "expire" });
}

export async function runExpireCreditGrants(
  now: Date,
): Promise<{ expired: number; waiting: number }> {
  const scope = scanBusinessFilter(creditGrants.businessId);
  // systemDb: the pass finds due grants across organizations; each is booked under withTenant.
  const due = await systemDb
    .select({
      organization_id: creditGrants.organizationId,
      id: creditGrants.id,
      customerId: creditGrants.customerId,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.status, "active"),
        isNotNull(creditGrants.expiresAt),
        lte(creditGrants.expiresAt, now),
        // Term plan grants expire in the renewal; reset-window ones here.
        or(
          ne(creditGrants.source, "plan_cycle"),
          like(creditGrants.sourceRef, "%:w:%"),
          like(creditGrants.sourceRef, "%:wroll:%"),
        ),
        // A grant that waits in its grace window is closed by `settle_credit_usage` (0526).
        sql`not exists (select 1 from credit_grant_grace gg
          where gg.grant_id = ${creditGrants.id} and gg.locked_at is null)`,
        scope,
      ),
    )
    .orderBy(creditGrants.expiresAt)
    .limit(500);
  let expired = 0;
  let waiting = 0;
  for (const r of due) {
    try {
      const done = await withTenant(r.organization_id, async (tx) => {
        // The customer lock before the grant row, as every credit path takes them.
        await lockCustomerBalances(tx, r.customerId);
        const [g] = await tx
          .select()
          .from(creditGrants)
          .where(and(eq(creditGrants.id, r.id), eq(creditGrants.status, "active")))
          .for("update")
          .limit(1);
        if (!g || !g.expiresAt) return false;
        // An open usage window that starts before the expiry may still draw the grant.
        const items = await tx
          .select({ item: subscriptionItems, price: prices })
          .from(subscriptionItems)
          .innerJoin(subscriptions, eq(subscriptions.id, subscriptionItems.subscriptionId))
          .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
          .where(
            and(
              eq(subscriptions.customerId, g.customerId),
              eq(subscriptions.currency, g.currency),
              inArray(subscriptions.status, ["active", "in_trial", "paused"]),
            ),
          );
        // No invoice draws a unit with no rate: nothing to wait for.
        for (const { item, price } of g.unitRated ? items : []) {
          const snap = (item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(price);
          if (!isMeteredPrice(snap) && !snap.meter) continue;
          const w = await usageWindowStart(tx, item.id);
          if (w && w.start.getTime() < g.expiresAt.getTime()) return false;
        }
        await closeExpiredGrant(tx, g, now);
        const [after] = await tx
          .select({ status: creditGrants.status })
          .from(creditGrants)
          .where(eq(creditGrants.id, g.id));
        return after?.status === "expired";
      });
      if (done) expired++;
      else waiting++;
    } catch (e) {
      log.error(e, { event: "credit_grant_expire_failed", grantId: r.id });
    }
  }
  return { expired, waiting };
}
