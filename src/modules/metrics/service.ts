import { reportableCustomer } from "./reportable";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import { annualFromMonthly, loadActiveDiscounts, reportingMrrBySubscription } from "./mrr";
import { subscriptions, subscriptionItems, prices, businesses, mrrMovements } from "@db/schema";
import { createLogger } from "@/platform/logger";

const log = createLogger("metrics");

export interface CurrencyMetrics {
  currency: string;
  mrr_minor: number;
  arr_minor: number;
  active: number;
  trialing: number;
  arpu_minor: number; // MRR / active (committed revenue per paying account)
}

/** Roll-up converted to the business default currency via manual FX rates. */
export interface ConvertedMetrics {
  currency: string;
  mrr_minor: number;
  arr_minor: number;
  /** Currencies with activity but no configured rate — excluded from the total. */
  missing_rates: string[];
}

export interface BusinessMetrics {
  as_of: string;
  currencies: CurrencyMetrics[];
  converted: ConvertedMetrics | null;
  subscribers: {
    future: number;
    active: number;
    in_trial: number;
    paused: number;
    cancelled: number;
  };
  movement_30d: {
    new_subscriptions: number;
    canceled_subscriptions: number;
    new_mrr_minor: Record<string, number>;
    churned_mrr_minor: Record<string, number>;
    logo_churn_rate_bps: number; // canceled / (active + canceled) over the window
  };
}

const LIVE = ["active", "in_trial"] as const;

/**
 * Compute SaaS metrics for a business from current subscription state:
 * MRR/ARR/ARPU per currency, subscriber counts by status, and 30-day movement
 * (new vs churned subscriptions + their MRR, logo churn rate).
 *
 * MRR sums each live subscription's items normalized to monthly (excludes usage +
 * one-time). Grouped by currency — never sums across currencies.
 */
export async function computeBusinessMetrics(
  organizationId: string,
  businessId: string,
  now: Date,
): Promise<BusinessMetrics> {
  const windowStart = new Date(now.getTime() - 30 * 24 * 3600_000);

  return withTenant(organizationId, async (tx) => {
    /**
     * Aggregated in SQL, never materialized.
     *
     * This used to `SELECT *` the whole book, join EVERY subscription item to its full
     * price row (`price_snapshot` JSON and all), load every active discount, and assemble
     * the answer in JavaScript — on the page an operator lands on first, with no cache in
     * front of it. At 100k subscriptions that is the request, not a part of it.
     *
     * It is safe to aggregate because of what `reportingMrrBySubscription` actually does:
     * for every status except `cancelled` it returns the cached `subscriptions.mrr`
     * verbatim. The only rows it recomputes from items are cancelled ones — and cancelled
     * is not in `LIVE`, so the stock half never once read a recomputed value. The items
     * and discounts were fetched for the whole business to serve the churn window alone.
     *
     * A deleted subscription is not revenue: it bills nothing from the moment it is
     * stamped, so counting its MRR would report money no invoice will ever ask for.
     */
    const byStatus = await tx
      .select({
        status: subscriptions.status,
        currency: subscriptions.currency,
        // Three things this line has to get right, each caught by `verify:metrics`:
        // a cast cannot follow FILTER directly, so the aggregate is parenthesised; without
        // aliases two of these come back named `coalesce` and the driver maps one over the
        // other; and a raw `sql` fragment cannot bind a Date — postgres.js refuses it
        // ("must be of type string … Received an instance of Date"), hence the ISO cast.
        n: sql<number>`(count(*))::int`.as("n"),
        mrr: sql<string>`coalesce(sum(${subscriptions.mrr}), 0)`.as("mrr"),
        newN: sql<number>`(count(*) filter (where ${subscriptions.createdAt} >= ${windowStart.toISOString()}::timestamptz))::int`.as(
          "new_n",
        ),
        newMrr:
          sql<string>`coalesce(sum(${subscriptions.mrr}) filter (where ${subscriptions.createdAt} >= ${windowStart.toISOString()}::timestamptz), 0)`.as(
            "new_mrr",
          ),
      })
      .from(subscriptions)
      .where(
        and(
          and(
            eq(subscriptions.businessId, businessId),
            reportableCustomer(subscriptions.customerId),
          ),
          notDeleted(),
        ),
      )
      .groupBy(subscriptions.status, subscriptions.currency);

    // Per-currency MRR + active/trialing counts.
    const ccy = new Map<string, { mrr: bigint; active: number; trialing: number }>();
    const counts = { future: 0, active: 0, in_trial: 0, paused: 0, cancelled: 0 };
    const newMrr: Record<string, number> = {};
    let newSubscriptions = 0;

    for (const r of byStatus) {
      counts[r.status as keyof typeof counts] =
        (counts[r.status as keyof typeof counts] ?? 0) + r.n;
      // `new_subscriptions` counts arrivals in the window whatever became of them, which
      // is what it counted before; `new_mrr` counts only the ones still live.
      newSubscriptions += r.newN;
      if ((LIVE as readonly string[]).includes(r.status)) {
        const c = ccy.get(r.currency) ?? { mrr: 0n, active: 0, trialing: 0 };
        c.mrr += BigInt(r.mrr);
        if (r.status === "active") c.active += r.n;
        else c.trialing += r.n;
        ccy.set(r.currency, c);
        if (r.newN > 0) {
          newMrr[r.currency] = (newMrr[r.currency] ?? 0) + Number(r.newMrr);
        }
      }
    }

    const currencies: CurrencyMetrics[] = [...ccy.entries()]
      .map(([currency, c]) => {
        const payers = c.active; // ARPU over active (paying) accounts
        return {
          currency,
          mrr_minor: Number(c.mrr),
          arr_minor: Number(annualFromMonthly(c.mrr)),
          active: c.active,
          trialing: c.trialing,
          arpu_minor: payers > 0 ? Math.round(Number(c.mrr) / payers) : 0,
        };
      })
      .sort((a, b) => b.mrr_minor - a.mrr_minor);

    /**
     * Churn over the window, from the movement ledger — the same rows every churn report
     * reads, so Home and Reports cannot disagree about what was lost.
     *
     * Two ids, not rows: who churned in the window is a cheap indexed read, and it is all
     * the fallback below needs.
     */
    const canceledIds = await tx
      .select({ id: subscriptions.id, currency: subscriptions.currency })
      .from(subscriptions)
      .where(
        and(
          and(
            eq(subscriptions.businessId, businessId),
            reportableCustomer(subscriptions.customerId),
          ),
          notDeleted(),
          eq(subscriptions.status, "cancelled"),
          gte(subscriptions.canceledAt, windowStart),
        ),
      );

    const churnedMrr: Record<string, number> = {};
    const ledger = await tx
      .select({
        currency: mrrMovements.currency,
        lost: sql<string>`coalesce(sum(-${mrrMovements.deltaMinor}), 0)`,
      })
      .from(mrrMovements)
      .where(
        and(
          and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
          eq(mrrMovements.reason, "churn"),
          gte(mrrMovements.occurredAt, windowStart),
        ),
      )
      .groupBy(mrrMovements.currency);

    /**
     * ⚠️ The ledger is only the answer where it HAS the answer.
     *
     * `mrr_movements` is written going forward and seeded by a backfill. A business that
     * has churn in the window but no churn rows carries an unseeded ledger, and reading it
     * would report zero churn — a silent wrong number, which is worse than a slow one. The
     * rule this codebase already follows for snapshots applies here too: a cache that is
     * not yet complete must not change the answer.
     *
     * So the test is coverage, not preference. When it fails we recompute from items —
     * scoped to the cancelled-in-window ids, never the whole book, because a cancelled
     * row's stored `mrr` is 0 and would flatten churn if summed directly.
     */
    if (ledger.length > 0 || canceledIds.length === 0) {
      for (const r of ledger) churnedMrr[r.currency] = Number(r.lost);
    } else {
      const ids = canceledIds.map((s) => s.id);
      const subs = await tx
        .select({
          id: subscriptions.id,
          status: subscriptions.status,
          mrr: subscriptions.mrr,
          // 0271: the churned rate, as stored while it was still knowable.
          lastEarningMrr: subscriptions.lastEarningMrr,
          currency: subscriptions.currency,
          billingPeriod: subscriptions.billingPeriod,
          billingPeriodUnit: subscriptions.billingPeriodUnit,
        })
        .from(subscriptions)
        .where(inArray(subscriptions.id, ids));
      const items = await tx
        .select({ item: subscriptionItems, price: prices })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .where(inArray(subscriptionItems.subscriptionId, ids));
      const mrrById = reportingMrrBySubscription({
        subs,
        items: items.map((r) => ({
          subscriptionId: r.item.subscriptionId,
          price: r.price,
          quantity: r.item.quantity,
          snapshot: r.item.priceSnapshot,
        })),
        discounts: await loadActiveDiscounts(tx, businessId),
        cadence: new Map(
          subs.map((s) => [
            s.id,
            { interval: s.billingPeriodUnit ?? "month", intervalCount: s.billingPeriod ?? 1 },
          ]),
        ),
      });
      for (const s of subs) {
        churnedMrr[s.currency] = (churnedMrr[s.currency] ?? 0) + Number(mrrById.get(s.id) ?? 0n);
      }
      log.debug("churn recomputed from items — ledger has no rows for this window", {
        businessId,
        cancelled: canceledIds.length,
      });
    }

    const activeNow = counts.active + counts.in_trial;
    const denom = activeNow + canceledIds.length;
    const logoChurnBps = denom > 0 ? Math.round((canceledIds.length / denom) * 10000) : 0;

    // Convert per-currency MRR to the default currency using the business's
    // manual reporting rates (1 default = rate × other). Null when there is no
    // default currency; buckets without a rate are excluded and reported.
    const [bizRow] = await tx
      .select({
        defaultCurrency: businesses.defaultCurrency,
        exchangeRates: businesses.exchangeRates,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    let converted: ConvertedMetrics | null = null;
    const base = bizRow?.defaultCurrency?.toUpperCase() ?? null;
    if (base) {
      const rates = (bizRow?.exchangeRates as Record<string, number> | null) ?? {};
      let mrrBase = 0;
      const missing: string[] = [];
      for (const c of currencies) {
        const rate = rates[c.currency];
        if (c.currency === base) mrrBase += c.mrr_minor;
        else if (rate != null && rate > 0) mrrBase += Math.round(c.mrr_minor / rate);
        else if (c.mrr_minor > 0) missing.push(c.currency);
      }
      converted = {
        currency: base,
        mrr_minor: mrrBase,
        arr_minor: mrrBase * 12,
        missing_rates: missing,
      };
    }

    log.debug("business metrics computed", {
      businessId: businessId,
      currencies: currencies.length,
      subscribers: counts,
      missingRates: converted?.missing_rates ?? [],
    });
    return {
      as_of: now.toISOString(),
      currencies,
      converted,
      subscribers: counts,
      movement_30d: {
        new_subscriptions: newSubscriptions,
        canceled_subscriptions: canceledIds.length,
        new_mrr_minor: newMrr,
        churned_mrr_minor: churnedMrr,
        logo_churn_rate_bps: logoChurnBps,
      },
    };
  });
}
