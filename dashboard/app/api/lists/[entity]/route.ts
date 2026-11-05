import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  listCustomers,
  listSubscriptions,
  listInvoices,
  listCreditNotes,
  type ListFilterParam,
  type ListParams,
  type Subscription,
} from "@/lib/api";
import { listTransactions, listGatewayWebhooks, listGatewayRequests } from "@/lib/api/payments";
import { listEmails } from "@/lib/api/emails";
import { listAuditLogs, listBusinessAuditLogs } from "@/lib/api/audit";
import { listRetries } from "@/lib/api/retries";
import { listPaymentIntents } from "@/lib/api/payments";
import { listEventsForBusiness, listDeliveries } from "@/lib/api/developer";
import { listCouponRedemptions } from "@/lib/api/catalog-stats";
import { listRequestLogs } from "@/lib/api/request-logs";
import { listReceipts } from "@/lib/api/receipts";
import { listPaymentRequests } from "@/lib/api/payment-requests";
import { listModelPrices } from "@/lib/api/model-prices";
export const dynamic = "force-dynamic";

/**
 * Page fetcher for every list in `ListPage`'s server mode.
 *
 * The first page of each list is server-rendered by its page; search, sort,
 * segment, filter and scroll changes come through here, so the org API key never
 * reaches the browser. Query in: `biz`, `limit`, `starting_after`, `q`,
 * `sort` (`<field>` / `-<field>`), repeatable `filter=field:op:value`, plus any
 * scoping params the entity understands (`customer`, `invoice`).
 *
 * An entity may return extra per-page data its columns need — `customers` ships
 * `subs_by_customer` so the Subscription Info column costs one extra query per
 * page instead of reading every subscription in the business.
 */
interface Payload {
  data: unknown[];
  has_more: boolean;
  next_cursor: string | null;
  total: number | null;
  /** Optional per-page side data an entity's columns need. */
  [extra: string]: unknown;
}

const FETCHERS: Record<
  string,
  (biz: string, params: ListParams, scope: Record<string, string | undefined>) => Promise<Payload>
> = {
  customers: async (biz, params) => {
    const page = await listCustomers(biz, params);
    const ids = page.data.map((c) => c.id);
    const subsByCustomer: Record<string, Subscription[]> = {};
    if (ids.length > 0) {
      // This page's rows only; paged, because an export page of 200 customers can hold
      // more than 1,000 subscriptions.
      let after: string | null = null;
      do {
        const subs = await listSubscriptions(biz, ids, { limit: 1000, startingAfter: after });
        for (const s of subs.data) {
          if (!s.customer) continue;
          (subsByCustomer[s.customer] ??= []).push(s);
        }
        after = subs.has_more ? subs.next_cursor : null;
      } while (after);
    }
    return { ...page, subs_by_customer: subsByCustomer };
  },
  subscriptions: async (biz, params, scope) => ({
    ...(await listSubscriptions(biz, scope.customer, params)),
  }),
  invoices: async (biz, params, scope) => ({
    ...(await listInvoices(biz, scope.customer, {
      ...params,
      scope: { subscription: scope.subscription },
    })),
  }),
  credit_notes: async (biz, params, scope) => ({
    ...(await listCreditNotes(biz, scope.invoice, { ...params, customer: scope.customer })),
  }),
  // Only the params the transactions route accepts bare; a subscription scope arrives
  // as a `subscription:is:` filter row instead (a bare one is a 400).
  transactions: async (biz, params, scope) => ({
    ...(await listTransactions(biz, {
      ...params,
      scope: { customer: scope.customer, invoice: scope.invoice },
    })),
  }),
  emails: async (biz, params, scope) => ({
    ...(await listEmails(biz, { ...params, customer: scope.customer })),
  }),
  // `customer` is the whole footprint; `resource_id` one record (a subscription page).
  events: async (biz, params, scope) => ({
    ...(await listEventsForBusiness(biz, {
      ...params,
      customer: scope.customer,
      resource_id: scope.resource_id,
    })),
  }),
  // Scoped by `coupon` (its code); the engine pages by cursor only.
  coupon_redemptions: async (biz, params, scope) => {
    if (!scope.coupon) throw new Error("coupon is required");
    return { ...(await listCouponRedemptions(biz, scope.coupon, params)) };
  },
  // Bare scoping params only (`customer`, `invoice`, `payment`, `payment_request`); the
  // date/amount/currency rows go through as the generic filter grammar.
  receipts: async (biz, params, scope) => ({
    ...(await listReceipts(biz, {
      ...params,
      scope: {
        customer: scope.customer,
        invoice: scope.invoice,
        payment: scope.payment,
        payment_request: scope.payment_request,
      },
    })),
  }),
  // The engine takes `customer` and `status` (comma list) bare and no filter grammar, so a
  // status segment is translated here rather than forwarded as a filter row.
  payment_requests: async (biz, params, scope) => {
    const status = params.filters?.find((f) => f.field === "status" && f.op === "is")?.value;
    return {
      ...(await listPaymentRequests(biz, {
        limit: params.limit,
        startingAfter: params.startingAfter,
        scope: { customer: scope.customer, status },
      })),
    };
  },
  gateway_webhooks: async (biz, params) => ({ ...(await listGatewayWebhooks(biz, params)) }),
  gateway_requests: async (biz, params) => ({ ...(await listGatewayRequests(biz, params)) }),
  audit_logs: async (biz, params) => ({ ...(await listBusinessAuditLogs(biz, params)) }),
  /**
   * The engine's intents list takes exactly `status` and `purpose` (a closed
   * allow-list — any other param is a 400), so the segment/builder rows are
   * translated here rather than forwarded as the generic `<field>[<op>]` grammar.
   *
   * This used to read `scope.status`, which is not a key of `scope` and was
   * therefore always `undefined`: every status segment returned the FULL,
   * silently unfiltered list under a narrowed label. Reading them off
   * `params.filters` is what makes the segments real.
   */
  payment_intents: async (biz, params) => {
    const pick = (field: string) =>
      params.filters?.find((f) => f.field === field && f.op === "is")?.value;
    return {
      ...(await listPaymentIntents(biz, {
        limit: params.limit,
        startingAfter: params.startingAfter ?? undefined,
        status: pick("status"),
        purpose: pick("purpose"),
      })),
    };
  },
  /**
   * Cursor, sort (RETRY_SORTS) and the ONE narrowing the engine honours: `dunning_state`, which the
   * screen's segments carry and `/retries` resolves in SQL (RETRY_STATE).
   *
   * Translated here rather than passed through as a `filter` row: `/retries` has no
   * column map, so a filter naming a column would be accepted and ignored — the
   * "narrowed label over an unfiltered page" this file already warns about for
   * payment intents. An unknown value is dropped and the engine falls back to the
   * whole set, so a hand-typed one cannot produce a lying label either.
   */
  retries: async (biz, params) => {
    const state = params.filters?.find((f) => f.field === "dunning_state" && f.op === "is")?.value;
    return {
      ...(await listRetries(biz, {
        limit: params.limit,
        startingAfter: params.startingAfter ?? undefined,
        state: (["attention", "recovered", "given_up", "all"] as const).find((s) => s === state),
        sort: params.sort,
      })),
    };
  },
  // NO `disputes` entry, deliberately. The endpoint paginates as of 2026-09-09, but the
  // Disputes screen stays client-paged (the engine list accepts only `status`, so server mode
  // would kill its search box and every filter but one — see the note on its page). An entry
  // here with no consumer is dead code; add it the day that screen converts.
};

/**
 * Every entity above is scoped to one business. These are not:
 *   - `org_audit_logs` — the org-wide Audit Log page (`/audit`) spans every business.
 *   - `webhook_deliveries` — one endpoint's delivery log, scoped by `endpoint`.
 *   - `request_logs` — the org's API request log (`/developer/logs`).
 *   - `model_prices` — the organization's AI model price list (Settings → Model prices).
 */
const ORG_FETCHERS: Record<
  string,
  (params: ListParams, scope: Record<string, string | undefined>) => Promise<Payload>
> = {
  org_audit_logs: async (params) => ({ ...(await listAuditLogs(params)) }),
  webhook_deliveries: async (params, scope) => {
    if (!scope.endpoint) throw new Error("endpoint is required");
    return { ...(await listDeliveries(scope.endpoint, params)) };
  },
  request_logs: async (params) => ({ ...(await listRequestLogs(params)) }),
  // The engine takes bare params and no filter grammar, so the builder's provider row is
  // translated here. `business`, `has_cost` and `used` are the page's own URL scope.
  model_prices: async (params, scope) => {
    const provider = params.filters?.find((f) => f.field === "provider" && f.op === "is")?.value;
    const page = await listModelPrices({
      q: params.q,
      provider,
      business: scope.business,
      has_cost: scope.has_cost === "on",
      used: scope.used === "on",
      limit: params.limit,
      starting_after: params.startingAfter ?? undefined,
    });
    return { ...page, total: page.total ?? null };
  },
};

function buildParams(sp: URLSearchParams): ListParams {
  const filters: ListFilterParam[] = [];
  for (const raw of sp.getAll("filter")) {
    // field:op:value — the value may itself contain ':'
    const [field, op, ...rest] = raw.split(":");
    if (field && op) filters.push({ field, op, value: rest.join(":") });
  }
  const sortRaw = sp.get("sort");
  const limit = Number(sp.get("limit") ?? 50);

  return {
    limit: Number.isFinite(limit) ? limit : 50,
    startingAfter: sp.get("starting_after"),
    q: sp.get("q") ?? undefined,
    sort: sortRaw ? { field: sortRaw.replace(/^-/, ""), desc: sortRaw.startsWith("-") } : undefined,
    filters,
    includeArchived: sp.get("include_archived") === "true",
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ entity: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { entity } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const scope = {
    customer: sp.get("customer") ?? undefined,
    invoice: sp.get("invoice") ?? undefined,
    subscription: sp.get("subscription") ?? undefined,
    resource_id: sp.get("resource_id") ?? undefined,
    coupon: sp.get("coupon") ?? undefined,
    endpoint: sp.get("endpoint") ?? undefined,
    payment: sp.get("payment") ?? undefined,
    payment_request: sp.get("payment_request") ?? undefined,
    business: sp.get("business") ?? undefined,
    has_cost: sp.get("has_cost") ?? undefined,
    used: sp.get("used") ?? undefined,
  };

  const orgFetcher = ORG_FETCHERS[entity];
  if (orgFetcher) {
    try {
      return NextResponse.json(await orgFetcher(buildParams(sp), scope));
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
  }

  const fetcher = FETCHERS[entity];
  if (!fetcher) return NextResponse.json({ error: `Unknown list: ${entity}` }, { status: 404 });

  const biz = sp.get("biz");
  if (!biz) return NextResponse.json({ error: "biz is required" }, { status: 400 });

  const params = buildParams(sp);

  try {
    return NextResponse.json(await fetcher(biz, params, scope));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
