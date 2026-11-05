/**
 * The `expire_credit_grants` pass (design G3 §3.8): a grant past its expiry is booked out only
 * when no invoice can still draw it, i.e. every metered item of the customer bills usage from
 * on or after the expiry (`usageWindowStart`). Term plan grants expire in the renewal instead;
 * reset-window plan grants (G3b) expire here.
 */
import { and, eq, inArray, isNotNull, like, lte, ne, or } from "drizzle-orm";
import { scanBusinessFilter } from "@/platform/clock";
import { systemDb, withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { creditGrants, prices, subscriptionItems, subscriptions } from "@db/schema";
import { isMeteredPrice, snapshotPrice, type PriceSnapshot } from "@/modules/catalog/pricing";
import { usageWindowStart } from "@/modules/subscriptions/usage-window";
import { bookGrantRemainder } from "./service";

const log = createLogger("credits.expiry");

export async function runExpireCreditGrants(
  now: Date,
): Promise<{ expired: number; waiting: number }> {
  const scope = scanBusinessFilter(creditGrants.businessId);
  // systemDb: the pass finds due grants across organizations; each is booked under withTenant.
  const due = await systemDb
    .select({ organization_id: creditGrants.organizationId, id: creditGrants.id })
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
        for (const { item, price } of items) {
          const snap = (item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(price);
          if (!isMeteredPrice(snap) && !snap.meter) continue;
          const w = await usageWindowStart(tx, item.id);
          if (w && w.start.getTime() < g.expiresAt.getTime()) return false;
        }
        await bookGrantRemainder(tx, { grant: g, kind: "expire" });
        return true;
      });
      if (done) expired++;
      else waiting++;
    } catch (e) {
      log.error(e, { event: "credit_grant_expire_failed", grantId: r.id });
    }
  }
  return { expired, waiting };
}
