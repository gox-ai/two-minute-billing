import { and, desc, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { formatMoney } from "@/platform/currency";
import {
  businesses,
  customers,
  hubspotLinks,
  invoices,
  prices,
  products,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import { OPEN_INVOICE_STATUSES } from "@/modules/invoicing/status";
import { paidTotals } from "@/modules/invoicing/service";
import { nextBillingBoundary } from "@/modules/subscriptions/service";
import type { Connection } from "../client";
import { parseSettings } from "../settings";

const MAX_CUSTOMERS = 10;
const RECENT_INVOICES = 5;
const PLAN_OPTIONS = 200;

export type RemoteType = "contact" | "company" | "deal";

/** Local ids behind a HubSpot record: its customers, and for a deal the one subscription. */
export async function linkedRecord(conn: Connection, remoteType: RemoteType, remoteId: string) {
  return withTenant(conn.organizationId, async (tx) => {
    if (remoteType === "deal") {
      const [link] = await tx
        .select({ localId: hubspotLinks.localId })
        .from(hubspotLinks)
        .where(
          and(
            eq(hubspotLinks.connectionId, conn.id),
            eq(hubspotLinks.localType, "subscription"),
            eq(hubspotLinks.remoteType, "deal"),
            eq(hubspotLinks.remoteId, remoteId),
          ),
        )
        .limit(1);
      if (!link) return { customerIds: [] as string[], subscriptionId: null as string | null };
      const [sub] = await tx
        .select({ id: subscriptions.id, customerId: subscriptions.customerId })
        .from(subscriptions)
        .where(
          and(eq(subscriptions.id, link.localId), eq(subscriptions.businessId, conn.businessId)),
        )
        .limit(1);
      return sub
        ? { customerIds: [sub.customerId], subscriptionId: sub.id as string | null }
        : { customerIds: [] as string[], subscriptionId: null as string | null };
    }
    const rows = await tx
      .select({ localId: hubspotLinks.localId })
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.localType, "customer"),
          eq(hubspotLinks.remoteType, remoteType),
          eq(hubspotLinks.remoteId, remoteId),
        ),
      )
      .limit(MAX_CUSTOMERS);
    return { customerIds: rows.map((r) => r.localId), subscriptionId: null as string | null };
  });
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const money = (minor: bigint | number | null | undefined, currency: string) => ({
  minor: Number(minor ?? 0),
  currency,
  display: formatMoney(minor ?? 0, currency),
});

/** What the record card renders. Unlinked records get `linked: false` and nothing else to show. */
export async function cardData(conn: Connection, remoteType: RemoteType, remoteId: string) {
  const settings = parseSettings(conn.settings);
  const { customerIds, subscriptionId } = await linkedRecord(conn, remoteType, remoteId);

  return withTenant(conn.organizationId, async (tx) => {
    const [biz] = await tx
      .select({
        publicId: businesses.publicId,
        name: businesses.name,
        currency: businesses.defaultCurrency,
      })
      .from(businesses)
      .where(eq(businesses.id, conn.businessId))
      .limit(1);
    const dash = config.DASHBOARD_BASE_URL?.replace(/\/+$/, "") ?? null;
    const link = (path: string) =>
      dash && biz ? `${dash}/businesses/${biz.publicId}${path}` : null;

    const plans = settings.deals.manualCreate
      ? await tx
          .select({
            id: prices.publicId,
            name: prices.name,
            product: products.name,
            currency: prices.currency,
            amountMinor: prices.amountMinor,
            model: prices.model,
            interval: prices.interval,
            intervalCount: prices.intervalCount,
          })
          .from(prices)
          .innerJoin(products, eq(products.id, prices.productId))
          .where(
            and(
              eq(prices.businessId, conn.businessId),
              eq(prices.type, "recurring"),
              eq(prices.active, true),
              eq(products.kind, "plan"),
            ),
          )
          .orderBy(products.name, prices.name)
          .limit(PLAN_OPTIONS)
      : [];

    const base = {
      object: "hubspot_card",
      business: biz ? { id: biz.publicId, name: biz.name } : null,
      record: { type: remoteType, id: remoteId },
      manual_create: settings.deals.manualCreate,
      // A deal already carrying a subscription is edited, not subscribed again.
      can_create: settings.deals.manualCreate && !(remoteType === "deal" && subscriptionId),
      plans: plans.map((p) => ({
        id: p.id,
        label: `${p.product}${p.name && p.name !== p.product ? ` — ${p.name}` : ""}`,
        currency: p.currency,
        amount: p.amountMinor != null ? money(p.amountMinor, p.currency) : null,
        interval: p.interval,
        interval_count: p.intervalCount,
        per_unit: p.model !== "flat",
      })),
    };
    if (customerIds.length === 0) return { ...base, linked: false as const, customers: [] };

    const custRows = await tx
      .select()
      .from(customers)
      .where(and(inArray(customers.id, customerIds), eq(customers.businessId, conn.businessId)));
    const subRows = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, conn.businessId),
          subscriptionId
            ? eq(subscriptions.id, subscriptionId)
            : inArray(subscriptions.customerId, customerIds),
        ),
      )
      .orderBy(desc(subscriptions.createdAt))
      .limit(50);
    const itemRows = subRows.length
      ? await tx
          .select({
            subscriptionId: subscriptionItems.subscriptionId,
            quantity: subscriptionItems.quantity,
            priceType: prices.type,
            priceName: prices.name,
            product: products.name,
            kind: products.kind,
          })
          .from(subscriptionItems)
          .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
          .innerJoin(products, eq(products.id, prices.productId))
          .where(
            and(
              eq(subscriptionItems.businessId, conn.businessId),
              inArray(
                subscriptionItems.subscriptionId,
                subRows.map((s) => s.id),
              ),
            ),
          )
      : [];
    const invoiceRows = await tx
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.businessId, conn.businessId), inArray(invoices.customerId, customerIds)),
      )
      .orderBy(desc(invoices.createdAt))
      .limit(200);
    const open = new Set<string>(OPEN_INVOICE_STATUSES);
    // The stored due is net of credits only; cash payments come off here.
    const paid = await paidTotals(
      tx,
      invoiceRows.filter((i) => open.has(i.status)).map((i) => i.id),
    );

    const out = custRows.map((c) => {
      const mine = invoiceRows.filter((i) => i.customerId === c.id);
      const dues = new Map<string, bigint>();
      for (const i of mine) {
        if (!open.has(i.status)) continue;
        const left = (i.amountDueMinor ?? i.totalMinor) - (paid.get(i.id) ?? 0n);
        if (left > 0n) dues.set(i.currency, (dues.get(i.currency) ?? 0n) + left);
      }
      const subs = subRows
        .filter((s) => s.customerId === c.id)
        .map((s) => {
          const items = itemRows.filter((i) => i.subscriptionId === s.id);
          const plan =
            items.find((i) => i.kind === "plan") ??
            items.find((i) => i.priceType === "recurring") ??
            items[0];
          return {
            id: s.publicId,
            status: s.status,
            plan: plan ? plan.product : null,
            plan_price: plan?.priceName ?? null,
            quantity: plan?.quantity ?? null,
            mrr: money(s.mrr ?? 0n, s.currency),
            next_billing_at: ["cancelled", "paused"].includes(s.status)
              ? null
              : iso(nextBillingBoundary(s)),
            url: link(`/subscriptions/${s.publicId}`),
          };
        });
      const name =
        [c.firstName, c.lastName].filter(Boolean).join(" ") || c.company || c.email || c.publicId;
      return {
        id: c.publicId,
        name,
        email: c.email,
        company: c.company,
        url: link(`/customers/${c.publicId}`),
        dues: [...dues].map(([cur, minor]) => money(minor, cur)),
        subscriptions: subs,
        invoices: mine.slice(0, RECENT_INVOICES).map((i) => ({
          id: i.publicId,
          number: i.number,
          status: i.status,
          total: money(i.totalMinor, i.currency),
          amount_due: money(i.amountDueMinor ?? 0n, i.currency),
          date: iso(i.createdAt),
          due_date: iso(i.dueDate),
          url: link(`/invoices/${i.publicId}`),
        })),
      };
    });
    return { ...base, linked: true as const, customers: out };
  });
}
