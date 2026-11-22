/**
 * The read-only tool catalogue shared by the MCP server and (later) the in-app assistant.
 *
 * Every tool is a thin, described wrapper over existing /v1 routes. `perms` lists the keys
 * the tool's main route needs; it only decides whether the tool is LISTED for a credential.
 * The route itself still enforces its permission on every call.
 */
import { BROWSER_REPORTED } from "@/modules/payment-intents/browser-failure";
import { z } from "zod";
import type { PermissionKey } from "@/modules/auth/permissions";
import { routeErrorMessage, type QueryValue, type RouteResult } from "./route-call";
import {
  apiOperation,
  type Audience,
  findApiOperations,
  isDeveloperPage,
  searchDocs,
} from "@/modules/assistant-docs/search";
import { screenForPath } from "@/modules/assistant-docs/screens";
import { runBounded } from "@/platform/concurrency";
import { queryRecords, type Metric } from "./query";
import { formatMoney } from "@/platform/currency";
import { zonedDayString } from "@/platform/timezones";

export interface ToolBusiness {
  id: string;
  name: string;
  livemode: "test" | "live";
  currency: string;
  timezone: string | null;
}

export interface ToolContext {
  business: ToolBusiness;
  /** GET a path relative to the business, e.g. `invoices/inv_…`. */
  get(rel: string, query?: Record<string, QueryValue | undefined>): Promise<RouteResult>;
  /** POST to a read-scope route (an estimate) relative to the business. */
  post(rel: string, body: unknown): Promise<RouteResult>;
  /** The dashboard page the member is on (in-app assistant only; MCP has none). */
  page?: { path: string } | null;
  /**
   * In-app only: who the answer is for when a search does not say. "operator" keeps developer
   * pages and the API reference out. Unset (MCP): every page, no preference.
   */
  audience?: Audience;
  /** The organization (internal id), for the docs search's embedding usage record. */
  organizationId?: string;
}

/** A failure the model can act on. Worded for the reader: what failed, why, what next. */
export class ToolError extends Error {
  /** The route's HTTP status when a call was refused; unset for a bad argument. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ToolDef {
  name: string;
  /** Offered to the in-app assistant only, never over MCP (its results must not be shown as-is). */
  assistantOnly?: boolean;
  title: string;
  description: string;
  perms: PermissionKey[];
  input: z.ZodRawShape;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

// ── shared inputs ──────────────────────────────────────────────────────────────

/** Ids are opaque: an imported record keeps its source id, which may have no `cus_`-style prefix. */
const id = (what: string) =>
  z
    .string()
    .min(1)
    .max(100)
    .describe(
      `The ${what} id, exactly as a tool or the member's page gave it. An imported record's id may have no prefix: never add or change one.`,
    );

const listInput = {
  filters: z
    .record(z.string().max(80), z.union([z.string().max(500), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Filters as "field[op]": value. Ops: is, is_not, in, not_in, contains, starts_with, gt, gte, lt, lte, before, after, on, between, is_present. ' +
        'Use a comma list for in. Dates are YYYY-MM-DD in the business timezone. Example: {"status[in]": "payment_due,not_paid", "created_at[after]": "2026-10-01"}. ' +
        "An unknown field or op is refused with the list of valid ones.",
    ),
  sort: z
    .string()
    .max(60)
    .optional()
    .describe(
      'A field to sort by, newest first unless prefixed "asc:", e.g. "created_at" or "asc:due_date".',
    ),
  limit: z.number().int().min(1).max(100).optional().describe("Rows per page. Default 25."),
  starting_after: z
    .string()
    .max(500)
    .optional()
    .describe("The next_cursor of the previous page, to read the next page."),
};

function listQuery(args: Record<string, unknown>): Record<string, QueryValue | undefined> {
  const q: Record<string, QueryValue | undefined> = { limit: (args.limit as number) ?? 25 };
  if (args.starting_after) q.starting_after = args.starting_after as string;
  if (typeof args.sort === "string") {
    const asc = args.sort.startsWith("asc:");
    q[`sort_by[${asc ? "asc" : "desc"}]`] = asc ? args.sort.slice(4) : args.sort;
  }
  for (const [k, v] of Object.entries((args.filters as Record<string, QueryValue>) ?? {})) q[k] = v;
  return q;
}

/** The body of a successful call, or a ToolError carrying the route's own message. */
function must(r: RouteResult, what: string): unknown {
  if (r.status >= 200 && r.status < 300) return r.body;
  const reason = routeErrorMessage(r) ?? `The API answered ${r.status}.`;
  // A missing id is most often a changed one: say so, rather than invite a search for another.
  const hint =
    r.status === 404
      ? " Use the id exactly as it was given, with no prefix added or changed. Do not read a different record in its place."
      : "";
  throw new ToolError(`We could not read ${what}. ${reason}${hint}`, r.status);
}

/** A secondary part of an overview: its body, or why it is missing. Never fails the tool. */
function part(r: RouteResult): unknown {
  if (r.status >= 200 && r.status < 300) return r.body;
  return { unavailable: routeErrorMessage(r) ?? `The API answered ${r.status}.` };
}

const seg = (v: unknown) => encodeURIComponent(String(v));

/** Who a docs search is for (search_docs, research). */
export const audienceInput = z
  .enum(["operator", "developer"])
  .optional()
  .describe(
    "Who the answer is for. operator (default in the app): guides only. developer: the API reference and developer pages too — use it when the member asks about the API, code, webhooks or an integration.",
  );

/** Asks a list tool to add each row's payer (`withPayers`). */
const payerInput = {
  with_payer: z
    .boolean()
    .optional()
    .describe(
      "Add each row's customer: name, email, and how they pay (the primary payment method's type, provider and status). Use it when the answer depends on who pays or how.",
    ),
};

type Row = Record<string, unknown>;
const PAYERS_MAX = 100;
/** Customers read at a time: a page of 100 rows must not open 200 route calls at once. */
const PAYERS_POOL = 8;

const ok = (r: RouteResult) => r.status >= 200 && r.status < 300;
const why = (r: RouteResult) => routeErrorMessage(r) ?? `The API answered ${r.status}.`;

/** A customer row's public id, whether the row holds it bare or as an object. */
const customerOf = (r: Row): string | null =>
  typeof r.customer === "string"
    ? r.customer
    : typeof (r.customer as Row | null)?.id === "string"
      ? ((r.customer as Row).id as string)
      : null;

/** One customer's name, email and how they pay. */
async function readPayer(ctx: ToolContext, id: string): Promise<Row> {
  const [c, pms] = await Promise.all([
    ctx.get(`customers/${seg(id)}`),
    ctx.get(`customers/${seg(id)}/payment_methods`),
  ]);
  if (!ok(c)) return { unavailable: why(c) };
  const cus = c.body as Row;
  const list = (ok(pms) ? (pms.body as { data?: Row[] }).data : null) ?? null;
  const primary = list?.find((m) => m.role === "primary") ?? null;
  const name = [cus.first_name, cus.last_name].filter(Boolean).join(" ") || null;
  return {
    name,
    company: cus.company ?? null,
    email: cus.email ?? null,
    pays_with: primary
      ? {
          type: primary.type,
          provider: primary.provider,
          brand: primary.brand ?? null,
          status: primary.status,
        }
      : list
        ? null
        : { unavailable: "The payment methods could not be read." },
    payment_methods: list?.length ?? null,
  };
}

/**
 * Each row's customer and how they pay, read once per customer on the page, PAYERS_POOL at a
 * time: one tool call instead of a read per row. A customer that cannot be read gets
 * `unavailable`.
 */
export async function withPayers(ctx: ToolContext, page: unknown): Promise<unknown> {
  const p = page as { data?: Row[] };
  if (!Array.isArray(p?.data)) return page;
  const ids = [...new Set(p.data.map(customerOf).filter((x): x is string => !!x))].slice(
    0,
    PAYERS_MAX,
  );
  const payers = new Map<string, Row>();
  const { settled } = await runBounded(ids, PAYERS_POOL, (id) => readPayer(ctx, id));
  for (const s of settled)
    payers.set(s.item, s.ok ? s.value : { unavailable: "The customer could not be read." });
  return {
    ...p,
    data: p.data.map((r) => {
      const id = customerOf(r);
      return id && payers.has(id) ? { ...r, payer: payers.get(id) } : r;
    }),
  };
}

/** Customers joined in one query at most: past it, rows carry `payer: {unavailable}`. */
const JOIN_MAX = 500;

/** Payers for many rows (a query over every page), read once per customer, PAYERS_POOL at a time. */
export async function joinPayers(ctx: ToolContext, rows: Row[]): Promise<Row[]> {
  const ids = [...new Set(rows.map(customerOf).filter((x): x is string => !!x))];
  const read = ids.slice(0, JOIN_MAX);
  const payers = new Map<string, Row>();
  const { settled } = await runBounded(read, PAYERS_POOL, (id) => readPayer(ctx, id));
  for (const s of settled)
    payers.set(s.item, s.ok ? s.value : { unavailable: "The customer could not be read." });
  const over = { unavailable: `Not read: more than ${JOIN_MAX} customers in this query.` };
  return rows.map((r) => {
    const id = customerOf(r);
    return id ? { ...r, payer: payers.get(id) ?? over } : r;
  });
}

// ── business days ─────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayInput = (what: string) =>
  z.string().regex(DAY).optional().describe(`${what}, YYYY-MM-DD in the business timezone.`);

/** Today in the business timezone. */
const today = (ctx: ToolContext) => zonedDayString(new Date(), ctx.business.timezone);

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Sum `amount_minor` per currency: `[{currency, count, amount_minor}]`, largest first. */
function totalsByCurrency<T extends Row>(
  rows: T[],
  amount: (r: T) => number | null,
  extra?: (acc: Row, r: T) => void,
): Row[] {
  const by = new Map<string, Row>();
  for (const r of rows) {
    const cur = typeof r.currency === "string" ? r.currency : "unknown";
    const acc = by.get(cur) ?? { currency: cur, count: 0, amount_minor: 0 };
    acc.count = (acc.count as number) + 1;
    acc.amount_minor = (acc.amount_minor as number) + (amount(r) ?? 0);
    extra?.(acc, r);
    by.set(cur, acc);
  }
  return [...by.values()].sort((x, y) => (y.amount_minor as number) - (x.amount_minor as number));
}

// ── payments ───────────────────────────────────────────────────────────────────

/** An attempt, lean: what was tried, with what, and the gateway's answer. */
const leanAttempt = (a: Row): Row => ({
  attempt_number: a.attempt_number ?? null,
  status: a.status ?? null,
  error_code: a.error_code ?? null,
  error_text: a.error_text ?? null,
  payment_method_type: a.payment_method_type ?? null,
  payment_method_brand: a.payment_method_brand ?? null,
  payment_method_last4: a.payment_method_last4 ?? null,
  created_at: a.created_at ?? null,
});

/** A payment intent row, lean: its state and why its newest attempt failed. */
const leanIntent = (r: Row): Row => ({
  id: r.id ?? null,
  customer: r.customer ?? null,
  status: r.status ?? null,
  purpose: r.purpose ?? null,
  amount_minor: r.amount_minor ?? null,
  currency: r.currency ?? null,
  attempt_count: r.attempt_count ?? null,
  last_attempt_status: r.last_attempt_status ?? null,
  last_error: r.last_error ?? null,
  gateway_key: r.gateway_key ?? null,
  created_at: r.created_at ?? null,
  expires_at: r.expires_at ?? null,
});

/** A list body with each row made lean; any other body (an `unavailable` part) as it is. */
/**
 * An excess payment, named for a reader: `held_minor` reads as "still held" and is not (it is
 * what the payment put on the balance), so the model gets `received_minor` and
 * `still_held_minor` instead.
 */
const leanExcessPayment = (r: Row): Row => ({
  payment: r.payment ?? null,
  invoice: r.invoice ?? null,
  currency: r.currency ?? null,
  received_minor: r.held_minor ?? null,
  still_held_minor: r.remaining_minor ?? null,
  refundable_minor: r.refundable_minor ?? null,
  gateway: r.gateway ?? null,
  created_at: r.created_at ?? null,
});

/**
 * The customer's balance in each bucket, named for a reader. The API lists every currency the
 * customer holds or held credit in, zeros included, so a used-up balance reads as 0.
 */
function creditBalances(customer: unknown): Row[] {
  const rows = (customer as { balances?: Row[] } | null)?.balances ?? [];
  return rows
    .filter((b) => typeof b.currency_code === "string")
    .map((b) => ({
      currency: b.currency_code,
      promotional_credits_minor: b.promotional_credits ?? 0,
      refundable_credits_minor: b.refundable_credits ?? 0,
      excess_payments_minor: b.excess_payments ?? 0,
    }));
}

const leanRows = (body: unknown, lean: (r: Row) => Row): unknown => {
  const b = body as { data?: unknown; has_more?: unknown } | null;
  if (!b || !Array.isArray(b.data)) return body;
  return { data: (b.data as Row[]).map(lean), has_more: b.has_more === true };
};

/** A gateway call, without headers and bodies: the model reads one in full with read_api. */
const leanGatewayCall = (r: Row): Row => ({
  id: r.id ?? null,
  operation: r.operation ?? null,
  method: r.method ?? null,
  status: r.status ?? null,
  error: r.error ?? null,
  source: r.source ?? null,
  duration_ms: r.duration_ms ?? null,
  created_at: r.created_at ?? null,
});

const leanWebhook = (r: Row): Row => ({
  id: r.id ?? null,
  type: r.type ?? null,
  outcome: r.outcome ?? null,
  error: r.error ?? null,
  response_status: r.response_status ?? null,
  transaction: r.transaction ?? null,
  received_at: r.received_at ?? null,
});

/** The gateway-request filter for one attempt's calls: its span, else its trace. */
export function attemptCallsQuery(a: Row): Record<string, QueryValue> | null {
  if (typeof a.span_id === "string" && a.span_id) return { "span_id[is]": a.span_id };
  if (typeof a.trace_id === "string" && a.trace_id) return { "trace_id[is]": a.trace_id };
  return null;
}

/** Newest attempts whose gateway calls an intent read includes. */
const INTENT_CALLS_ATTEMPTS = 5;
/** Gateway calls per attempt, and webhooks per intent. */
const INTENT_CALLS_MAX = 10;
const INTENT_WEBHOOKS_MAX = 20;

/** Rows in the collections queue. */
const COLLECTIONS_MAX = 50;
/** Entries in a timeline. */
const TIMELINE_MAX = 40;

/** The record kinds a timeline can start from, and the event resource type of each. */
const RECORD_KINDS: Record<string, string> = {
  cus_: "customer",
  sub_: "subscription",
  inv_: "invoice",
  pi_: "payment_intent",
  txn_: "transaction",
};
const TIMELINE_KINDS = [
  "customer",
  "subscription",
  "invoice",
  "payment_intent",
  "transaction",
] as const;

// ── read_api guard ─────────────────────────────────────────────────────────────

const READ_API_PATH = /^[a-z_]+(\/[A-Za-z0-9_\-.:]+)*$/;
/**
 * Reads kept out of a model's context: documents (pdf/html), bulk exports, and settings
 * that describe how we reach other systems. A key can still read them over the plain API.
 */
const READ_API_DENY = [
  /\/(pdf|html)$/,
  /^raw_export(\/|$)/,
  /^emails\/(smtp|ses)$/,
  /^gateway_accounts\/[^/]+\/webhook_endpoint$/,
  /^integrations(\/|$)/,
];

// ── the catalogue ──────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  {
    name: "get_business",
    title: "Business settings",
    description:
      "Read the business this connection is pinned to: name, currency, timezone, test or live mode, and its billing settings.",
    perms: ["settings:view"],
    input: {},
    run: async (ctx) => must(await ctx.get(""), "the business"),
  },
  {
    name: "get_catalog",
    title: "Product catalog",
    description:
      'The whole active catalog in one call: products (plans, add-ons, charges), their prices (amount, currency, interval) and the coupons. Use it for "what plans do we have", for prices and add-ons, and before creating a coupon or a subscription, which need price ids. ' +
      "Rows are short: read_api products/<id> or prices/<id> for one record in full.",
    perms: ["catalog:view"],
    input: {},
    run: async (ctx) => {
      const [products, prices, coupons] = await Promise.all([
        ctx.get("products"),
        ctx.get("prices"),
        ctx.get("coupons"),
      ]);
      const rows = (body: unknown) => ((body as { data?: Row[] } | null)?.data ?? []) as Row[];
      return {
        products: rows(must(products, "the products")).map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          status: p.active === false ? "archived" : "active",
        })),
        prices: rows(must(prices, "the prices")).map((p) => ({
          id: p.id,
          name: p.name,
          product: p.product,
          type: p.type,
          model: p.model,
          amount_minor: p.amount_minor,
          currency: p.currency,
          interval: p.interval,
          interval_count: p.interval_count,
          status: p.active === false ? "archived" : "active",
        })),
        // Needs coupons:view; without it the part says why.
        coupons: ok(coupons)
          ? rows(coupons.body).map((c) => ({
              id: c.id,
              name: c.name,
              kind: c.kind,
              percent_off_bps: c.percent_off_bps,
              amount_off_minor: c.amount_off_minor,
              currency: c.currency,
              duration_type: c.duration_type,
              status: c.status,
            }))
          : { unavailable: why(coupons) },
      };
    },
  },
  {
    name: "get_transfer_status",
    title: "Set-up copy status",
    description:
      "Read the copies of this business's set-up to another business (for example from test mode to live): the open plan or the copy that is running, then the latest past copies, " +
      "each with its status, item counts, who started it, and its errors. Read only: a copy is started only by a person on the Transfer screen.",
    perms: ["transfers:view"],
    input: {},
    run: async (ctx) => {
      const open = must(
        await ctx.get("transfer_configurations", {
          status: "planned,queued,running",
          run_kind: "async",
          direction: "outgoing",
          limit: 1,
        }),
        "the open copy",
      );
      const past = must(await ctx.get("transfer_configurations", { limit: 5 }), "the past copies");
      return { open, past };
    },
  },
  {
    name: "search_customers",
    title: "Search customers",
    description:
      "Find customers by name, email, company or id (query), or by filters such as mrr, has_unpaid_invoices, cannot_be_charged, payment_method_expiring, subscription_status, country. " +
      "Returns a page of customers with ids for the other tools. Not for a customer whose id you have (the member's page, a mention, an earlier read): read that one with get_customer.",
    perms: ["customers:view"],
    input: {
      query: z.string().max(200).optional().describe("Free text: name, email, company or id."),
      ...listInput,
    },
    run: async (ctx, a) => {
      const query = typeof a.query === "string" ? a.query.trim() : "";
      const first = must(
        await ctx.get("customers", { ...listQuery(a), q: query || undefined }),
        "customers",
      ) as {
        data?: Array<Record<string, unknown>>;
      };
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      if ((first.data?.length ?? 0) > 0 || words.length < 2) return first;
      // Search matches one column at a time, so "Maren Holt" finds nobody. Search by the
      // longest word, then keep the customers whose name, email or company holds every word.
      const longest = [...words].sort((x, y) => y.length - x.length)[0]!;
      const wide = must(
        await ctx.get("customers", { ...listQuery(a), q: longest, limit: 100 }),
        "customers",
      ) as {
        data?: Array<Record<string, unknown>>;
      };
      const hay = (c: Record<string, unknown>) =>
        ["first_name", "last_name", "name", "email", "company"]
          .map((k) => String(c[k] ?? ""))
          .join(" ")
          .toLowerCase();
      return {
        ...wide,
        data: (wide.data ?? []).filter((c) => words.every((w) => hay(c).includes(w))),
        has_more: false,
      };
    },
  },
  {
    name: "get_customer",
    title: "Customer overview",
    description:
      "Everything about one customer in one call: the customer record (with its credit balances by type), their subscriptions, their 10 most recent invoices (each with the credit applied to it by type), their payment methods, their open disputes, their excess payments (what each put on the balance and what is still held), and their 10 most recent payment intents (status, and the last error when the newest attempt failed). " +
      "For one payment intent in full, use get_payment_attempts.",
    perms: ["customers:view"],
    input: { customer: id("customer (cus_…)") },
    run: async (ctx, a) => {
      const c = seg(a.customer);
      const [customer, subscriptions, invoices, paymentMethods, disputes, intents, excess] =
        await Promise.all([
          ctx.get(`customers/${c}`),
          ctx.get("subscriptions", { "customer[is]": String(a.customer), limit: 25 }),
          ctx.get("invoices", { "customer[is]": String(a.customer), limit: 10 }),
          ctx.get(`customers/${c}/payment_methods`),
          ctx.get("disputes", { customer: String(a.customer), open: "true", limit: 10 }),
          ctx.get("payment_intents", { customer: String(a.customer), limit: 10 }),
          ctx.get(`customers/${c}/excess_payments`, { include_used: "true" }),
        ]);
      return {
        customer: must(customer, `the customer ${String(a.customer)}`),
        subscriptions: part(subscriptions),
        recent_invoices: part(invoices),
        payment_methods: part(paymentMethods),
        // Needs payments:view; without it the part says why.
        open_disputes: part(disputes),
        // Open intents write no transaction, so a buyer stuck on a payment page shows only here.
        recent_payment_intents: leanRows(part(intents), leanIntent),
        // Needs credits:view; a used-up overpayment stays here with nothing still held.
        excess_payments: leanRows(part(excess), leanExcessPayment),
        credit_balances: creditBalances(part(customer)),
      };
    },
  },
  {
    name: "list_subscriptions",
    title: "List subscriptions",
    description:
      "List subscriptions with filters such as status (future, in_trial, active, paused, cancelled), customer, mrr, next_billing_at, cancel_scheduled_at, coupon, billing_period_unit. " +
      "with_payer adds each row's customer and how they pay.",
    perms: ["subscriptions:view"],
    input: { ...listInput, ...payerInput },
    run: async (ctx, a) => {
      const page = must(await ctx.get("subscriptions", listQuery(a)), "subscriptions");
      // The customer reads run as the caller: without customers:view each payer says why.
      return a.with_payer ? withPayers(ctx, page) : page;
    },
  },
  {
    name: "get_upcoming_charges",
    title: "Upcoming charges",
    description:
      'Who will be charged in a window of days and how much: active, in-trial and future subscriptions whose next billing date is between from and to (default: the next 30 days), soonest first, each with its payer and how they pay, plus totals per currency with the count and amount per payment type. Use it for "who renews this week", "how much will we collect this month" and "which upcoming charges go through PayPal" (payment_type keeps only those rows, so none are cut). ' +
      "Amounts are an estimate: the recurring amount before tax, usage, discounts and credits. For one subscription's exact next invoice, use get_subscription. If has_more is true, the list and the totals cover only the rows shown: use a smaller window.",
    perms: ["subscriptions:view"],
    input: {
      from: dayInput("First day. Default: today"),
      to: dayInput("Last day. Default: 30 days after from"),
      payment_type: z
        .string()
        .max(40)
        .optional()
        .describe(
          'Only subscriptions whose payer pays this way: a method type such as "paypal", "card", "upi", "sepa_debit", or "none" for customers with no payment method.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Most subscriptions to read. Default 100."),
    },
    run: async (ctx, a) => {
      const from = (a.from as string | undefined) ?? today(ctx);
      const to = (a.to as string | undefined) ?? addDays(from, 30);
      if (to < from)
        throw new ToolError("We could not read the upcoming charges. to must be on or after from.");
      const page = must(
        await ctx.get("subscriptions", {
          "status[in]": "active,in_trial,future",
          "next_billing_at[between]": `${from},${to}`,
          "sort_by[asc]": "next_billing_at",
          limit: (a.limit as number | undefined) ?? 100,
        }),
        "the upcoming charges",
      ) as { data?: Row[]; has_more?: boolean };
      const withPay = (await withPayers(ctx, {
        data: (page.data ?? []).map((s) => ({
          id: s.id,
          status: s.status,
          customer: s.customer,
          customer_name: s.customer_name ?? null,
          customer_email: s.customer_email ?? null,
          next_billing_at: s.next_billing_at,
          recurring_amount_minor: s.recurring_amount_minor ?? null,
          currency: s.currency,
          items: Array.isArray(s.items)
            ? (s.items as Row[]).map((i) => ({
                price: i.price,
                quantity: i.quantity,
                product_name: i.product_name ?? null,
              }))
            : [],
        })),
      })) as { data: Row[] };
      const payType = (r: Row) => {
        const payer = r.payer as Row | undefined;
        const pays = payer?.pays_with as Row | null | undefined;
        if (!payer || payer.unavailable || (pays && pays.unavailable)) return "unknown";
        return typeof pays?.type === "string" ? pays.type : "none";
      };
      const wanted =
        typeof a.payment_type === "string" ? a.payment_type.trim().toLowerCase() : null;
      const rows = wanted ? withPay.data.filter((r) => payType(r) === wanted) : withPay.data;
      return {
        from,
        to,
        estimate: true,
        ...(wanted ? { payment_type: wanted, read: withPay.data.length } : {}),
        data: rows,
        has_more: page.has_more === true,
        totals: totalsByCurrency(
          rows,
          (r) => (typeof r.recurring_amount_minor === "number" ? r.recurring_amount_minor : null),
          (acc, r) => {
            // Per payment type: how many, and how much (the same estimate as amount_minor).
            const by = (acc.by_payment_type ??= {}) as Record<string, Row>;
            const t = payType(r);
            const cell = (by[t] ??= { count: 0, amount_minor: 0 });
            cell.count = (cell.count as number) + 1;
            cell.amount_minor =
              (cell.amount_minor as number) +
              (typeof r.recurring_amount_minor === "number" ? r.recurring_amount_minor : 0);
          },
        ),
      };
    },
  },
  {
    name: "get_subscription",
    title: "Subscription overview",
    description:
      "One subscription with its items, its scheduled changes, and the engine's estimate of its next renewal invoice.",
    perms: ["subscriptions:view"],
    input: { subscription: id("subscription (sub_…)") },
    run: async (ctx, a) => {
      const s = seg(a.subscription);
      const [subscription, scheduled, renewal] = await Promise.all([
        ctx.get(`subscriptions/${s}`),
        ctx.get(`subscriptions/${s}/scheduled_changes`),
        ctx.get(`subscriptions/${s}/renewal_estimate`),
      ]);
      return {
        subscription: must(subscription, `the subscription ${String(a.subscription)}`),
        scheduled_changes: part(scheduled),
        renewal_estimate: part(renewal),
      };
    },
  },
  {
    name: "list_invoices",
    title: "List invoices",
    description:
      "List invoices with filters such as status (pending, posted, payment_due, not_paid, paid, voided), dunning_status, customer, subscription, amount_due_minor, due_date, paid_at, created_at. " +
      "with_payer adds each row's customer and how they pay.",
    perms: ["invoices:view"],
    input: { ...listInput, ...payerInput },
    run: async (ctx, a) => {
      const page = must(await ctx.get("invoices", listQuery(a)), "invoices");
      // The customer reads run as the caller: without customers:view each payer says why.
      return a.with_payer ? withPayers(ctx, page) : page;
    },
  },
  {
    name: "get_collections_queue",
    title: "Collections queue",
    description:
      'The unpaid invoices dunning will retry soon: status payment_due or not_paid with the next retry within days (default 7), soonest retry first, plus the total due per currency. Use it for "what will be retried this week" and "how much is overdue and being collected". ' +
      "total_due counts every invoice read (up to 100); has_more means there are more than the rows shown. " +
      "Invoices with no retry planned are not in it: use list_invoices for every unpaid invoice, and explain_payment for why one failed.",
    perms: ["invoices:view"],
    input: {
      days: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("Retries planned up to this many days from today. Default 7."),
    },
    run: async (ctx, a) => {
      const until = addDays(today(ctx), (a.days as number | undefined) ?? 7);
      const page = must(
        await ctx.get("invoices", {
          "status[in]": "payment_due,not_paid",
          "next_attempt_at[on_or_before]": until,
          // The list cannot sort by next_attempt_at: read a full page, sort it here.
          "sort_by[asc]": "due_date",
          limit: 100,
        }),
        "the collections queue",
      ) as { data?: Row[]; has_more?: boolean };
      const at = (r: Row) => (typeof r.next_attempt_at === "string" ? r.next_attempt_at : "");
      const rows = (page.data ?? [])
        .map((i) => ({
          id: i.id,
          number: i.number ?? null,
          customer: i.customer ?? null,
          customer_name: i.customer_name ?? null,
          amount_due_minor: i.amount_due_minor,
          currency: i.currency,
          due_date: i.due_date ?? null,
          dunning_status: i.dunning_status ?? null,
          attempt_count: i.attempt_count ?? 0,
          next_attempt_at: i.next_attempt_at ?? null,
        }))
        .sort((x, y) => at(x).localeCompare(at(y)));
      return {
        until,
        data: rows.slice(0, COLLECTIONS_MAX),
        has_more: page.has_more === true || rows.length > COLLECTIONS_MAX,
        total_due: totalsByCurrency(rows, (r) =>
          typeof r.amount_due_minor === "number" ? r.amount_due_minor : null,
        ),
      };
    },
  },
  {
    name: "get_invoice",
    title: "Invoice detail",
    description:
      "One invoice with its lines, taxes, discounts, credits and payments, plus its dunning journey (each reminder and retry, past and planned). For why it is what it is, use explain_invoice.",
    perms: ["invoices:view"],
    input: { invoice: id("invoice (inv_…)") },
    run: async (ctx, a) => {
      const i = seg(a.invoice);
      const [invoice, dunning] = await Promise.all([
        ctx.get(`invoices/${i}`),
        ctx.get(`invoices/${i}/dunning_journey`),
      ]);
      return {
        invoice: must(invoice, `the invoice ${String(a.invoice)}`),
        dunning_journey: part(dunning),
      };
    },
  },
  {
    name: "list_payments",
    title: "List payments and refunds",
    description:
      "List money movements (transactions): payments, refunds and authorizations, with filters such as type, status, customer, gateway, amount_minor, created_at.",
    perms: ["payments:view"],
    input: listInput,
    run: async (ctx, a) => must(await ctx.get("transactions", listQuery(a)), "payments"),
  },
  {
    name: "get_payment_attempts",
    title: "Payment intent and attempts",
    description:
      "One payment intent (pi_…) in full: the intent (payment_intent), every attempt oldest first (data) with the gateway's answer, error code and text, and timing, " +
      "the gateway calls of the newest attempts (gateway_calls on each attempt), and the webhooks the gateway sent about the intent (webhooks). " +
      "reported_by_browser marks a refusal the gateway showed only on the payment page, never to our server. Use it to explain why a payment failed.",
    perms: ["payments:view"],
    input: { payment_intent: id("payment intent (pi_…)") },
    run: async (ctx, a) => {
      const pi = String(a.payment_intent);
      const intent = must(
        await ctx.get(`payment_intents/${seg(pi)}`),
        `the payment intent ${pi}`,
      ) as Row;
      const attempts = Array.isArray(intent.attempts) ? (intent.attempts as Row[]) : [];
      const traced = attempts.slice(-INTENT_CALLS_ATTEMPTS);
      // Gateway logs need gateways:view; without it each part says why.
      const [calls, webhooks] = await Promise.all([
        Promise.all(
          traced.map((at) => {
            const q = attemptCallsQuery(at);
            return q ? ctx.get("gateway_requests", { ...q, limit: INTENT_CALLS_MAX }) : null;
          }),
        ),
        ctx.get("gateway_webhooks", { "payment_intent[is]": pi, limit: INTENT_WEBHOOKS_MAX }),
      ]);
      const callsOf = new Map(traced.map((at, i) => [at, calls[i]]));
      return {
        object: "list",
        payment_intent: leanIntent(intent),
        data: attempts.map((at) => {
          const r = callsOf.get(at);
          return {
            id: at.id ?? null,
            ...leanAttempt(at),
            id_at_gateway: at.id_at_gateway ?? null,
            reported_by_browser:
              typeof at.error_text === "string" && at.error_text.endsWith(BROWSER_REPORTED),
            gateway_calls: !callsOf.has(at)
              ? { unavailable: "Not read: an older attempt." }
              : r
                ? leanRows(part(r), leanGatewayCall)
                : { unavailable: "This attempt made no traced gateway call." },
          };
        }),
        webhooks: leanRows(part(webhooks), leanWebhook),
      };
    },
  },
  {
    name: "get_metrics",
    title: "Revenue metrics",
    description:
      "MRR, ARR, active and trialing counts per currency now, and the home analytics series (MRR movement, revenue, churn) for a range. " +
      "Figures come from the metric store; quote them, do not recompute them.",
    perms: ["reports:view"],
    input: {
      range: z.enum(["daily", "3m", "6m", "12m"]).optional().describe("Series range. Default 12m."),
      currency: z.string().length(3).optional().describe("ISO currency, e.g. USD."),
    },
    run: async (ctx, a) => {
      const [now, series] = await Promise.all([
        ctx.get("metrics"),
        ctx.get("analytics", {
          range: (a.range as string) ?? "12m",
          currency: a.currency as string | undefined,
        }),
      ]);
      return { current: must(now, "the metrics"), series: part(series) };
    },
  },
  {
    name: "preview_subscription_change",
    title: "Preview a subscription change",
    description:
      "Ask the engine what a change would cost, without making it: proration, the immediate invoice and the next renewal. " +
      'change is the body of the estimate endpoint, e.g. {"changes": [{"item": "si_…", "price": "<new price id>", "quantity": 2}]}, {"adds": [{"price": "<price id>", "quantity": 1}]}, {"removes": ["si_…"]}, optional "at" (ISO time) and "reset_term". ' +
      "Nothing is changed.",
    perms: ["subscriptions:estimate"],
    input: {
      subscription: id("subscription (sub_…)"),
      change: z.record(z.string(), z.unknown()).describe("The estimate body."),
    },
    run: async (ctx, a) =>
      must(
        await ctx.post(`subscriptions/${seg(a.subscription)}/estimate`, a.change),
        "an estimate for that change",
      ),
  },
  {
    name: "preview_cancellation",
    title: "Preview a cancellation",
    description:
      "Ask the engine what cancelling a subscription would do to money, without cancelling: credits, refunds and final charges. " +
      'options is the body of the cancel estimate endpoint, e.g. {"cancel_option": "end_of_term"} or {"cancel_option": "immediately", "credit_option_for_current_term_charges": "prorate"}. Nothing is changed.',
    perms: ["subscriptions:estimate"],
    input: {
      subscription: id("subscription (sub_…)"),
      options: z.record(z.string(), z.unknown()).optional().describe("The cancel estimate body."),
    },
    run: async (ctx, a) =>
      must(
        await ctx.post(`subscriptions/${seg(a.subscription)}/cancel_estimate`, a.options ?? {}),
        "a cancellation estimate",
      ),
  },
  {
    name: "explain_invoice",
    title: "Explain an invoice",
    description:
      "Why an invoice is what it is, from the engine's stored lines: the totals ladder and whether it adds up, the facts behind each line (recurring, proration, usage, discounts, tax or why untaxed), and what changed from the same subscription's previous invoice. " +
      'Use it for "why was this customer charged X" and "why is this invoice higher than last month".',
    perms: ["invoices:view"],
    input: { invoice: id("invoice (inv_…)") },
    run: async (ctx, a) =>
      must(
        await ctx.get(`invoices/${seg(a.invoice)}/explanation`),
        `an explanation of ${String(a.invoice)}`,
      ),
  },
  {
    name: "explain_payment",
    title: "Explain a payment problem",
    description:
      "Why an invoice is unpaid or a payment failed: the invoice's collection state, every attempt with its decline code and message, what dunning will do next and when, and the customer's payment methods (expired or missing cards show here). " +
      "Give invoice (inv_…), or payment: a payment intent (pi_…) or a transaction (txn_…). For a payment the result adds payment and attempts, and the invoice it was for when there is one.",
    perms: ["invoices:view"],
    input: {
      invoice: id("invoice (inv_…)").optional(),
      payment: z
        .string()
        .regex(/^(pi|txn)_[A-Za-z0-9_-]+$/)
        .max(100)
        .optional()
        .describe("A payment intent (pi_…) or transaction (txn_…) id."),
    },
    run: async (ctx, a) => {
      if (!a.invoice && !a.payment)
        throw new ToolError(
          "We could not explain a payment. Give invoice (inv_…), or payment (pi_… or txn_…).",
        );
      let invoiceId = typeof a.invoice === "string" ? a.invoice : null;
      let payment: Row | null = null;
      let attempts: Row[] | { unavailable: string } | null = null;
      let customer: string | null = null;
      if (typeof a.payment === "string") {
        const ref = a.payment;
        let intentId: string | null = ref.startsWith("pi_") ? ref : null;
        let txn: Row | null = null;
        if (ref.startsWith("txn_")) {
          txn = must(await ctx.get(`transactions/${seg(ref)}`), `the payment ${ref}`) as Row;
          intentId = typeof txn.payment_intent === "string" ? txn.payment_intent : null;
        }
        const pi = intentId ? await ctx.get(`payment_intents/${seg(intentId)}`) : null;
        // Asked for by id: a missing intent is the answer, not a part.
        const intent = pi && ok(pi) ? (pi.body as Row) : null;
        if (!txn && !intent) must(pi!, `the payment ${ref}`);
        if (intent) {
          attempts = Array.isArray(intent.attempts)
            ? (intent.attempts as Row[]).map(leanAttempt)
            : null;
          if (!attempts) {
            const r = await ctx.get(`payment_intents/${seg(intentId!)}/attempts`);
            attempts = ok(r)
              ? (((r.body as { data?: Row[] }).data ?? []) as Row[]).map(leanAttempt)
              : { unavailable: why(r) };
          }
        } else if (pi) {
          attempts = { unavailable: why(pi) };
        }
        // An intent names no invoice; its transaction does.
        if (!txn && intent) {
          const t = await ctx.get("transactions", { "payment_intent[is]": intentId!, limit: 1 });
          txn = ok(t) ? (((t.body as { data?: Row[] }).data ?? [])[0] ?? null) : null;
        }
        const src = txn ?? intent!;
        payment = {
          id: ref,
          kind: ref.startsWith("txn_") ? "transaction" : "payment_intent",
          type: txn?.type ?? null,
          status: (ref.startsWith("txn_") ? txn?.status : intent?.status) ?? null,
          last_attempt_status: intent?.last_attempt_status ?? null,
          attempt_count: intent?.attempt_count ?? null,
          amount_minor: src.amount_minor ?? intent?.amount_minor ?? null,
          currency: src.currency ?? intent?.currency ?? null,
          gateway: txn?.gateway_key ?? intent?.gateway_key ?? null,
          error_code: txn?.error_code ?? null,
          error_text: txn?.error_text ?? null,
          payment_intent: intentId,
          invoice: txn?.invoice ?? null,
          customer: src.customer ?? intent?.customer ?? null,
          customer_name: src.customer_name ?? intent?.customer_name ?? null,
          created_at: src.created_at ?? null,
        };
        invoiceId ??= typeof payment.invoice === "string" ? payment.invoice : null;
        customer = typeof payment.customer === "string" ? payment.customer : null;
      }

      let invoice: Row | null = null;
      let hasJourney = false;
      if (invoiceId) {
        const r = await ctx.get(`invoices/${seg(invoiceId)}`);
        // An invoice the member named must exist; one found through a payment is a part.
        const body = a.invoice || ok(r) ? (must(r, `the invoice ${invoiceId}`) as Row) : null;
        if (body) {
          invoice = {
            id: invoiceId,
            status: body.status,
            currency: body.currency,
            amount_due_minor: body.amount_due_minor,
            due_date: body.due_date ?? null,
            dunning_status: body.dunning_status ?? null,
            attempt_count: body.attempt_count ?? 0,
            next_attempt_at: body.next_attempt_at ?? null,
            payment_in_flight: body.payment_in_flight ?? false,
            customer: body.customer ?? null,
          };
          customer = (body.customer as string | null) ?? customer;
          hasJourney = true;
        } else {
          invoice = { id: invoiceId, unavailable: why(r) };
        }
      }
      const [journey, methods] = await Promise.all([
        hasJourney ? ctx.get(`invoices/${seg(invoiceId!)}/dunning_journey`) : null,
        customer ? ctx.get(`customers/${seg(customer)}/payment_methods`) : null,
      ]);
      return {
        invoice,
        dunning_journey: journey ? part(journey) : null,
        payment_methods: methods ? part(methods) : null,
        ...(payment ? { payment, attempts } : {}),
      };
    },
  },
  {
    name: "explain_mrr_change",
    title: "Explain an MRR change",
    description:
      "How MRR moved over a range of days: opening MRR, the change split by reason (new, expansion, reactivation, resume, contraction, pause, churn) with the largest movements and their customers, and closing MRR. " +
      'Opening + changes = closing by construction. Use it for "why did MRR drop" or "who churned last month".',
    perms: ["reports:view"],
    input: {
      start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("First day, YYYY-MM-DD. Default: 29 days before end."),
      end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Last day, YYYY-MM-DD. Default: today."),
      currency: z
        .string()
        .length(3)
        .optional()
        .describe("ISO currency. Default: the business currency."),
      top: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Largest movements per reason. Default 5."),
    },
    run: async (ctx, a) =>
      must(
        await ctx.get("mrr_bridge", {
          start: a.start as string | undefined,
          end: a.end as string | undefined,
          currency: a.currency as string | undefined,
          top: a.top as number | undefined,
        }),
        "the MRR bridge",
      ),
  },
  {
    name: "explain_balance",
    title: "Explain a customer's balances",
    description:
      "Where a customer's credit comes from and goes: promotional credits, excess payments (each overpayment with what it put on the balance and what is still held after invoices used it, also when all of it is used), credit grants with their movements, and their wallet.",
    perms: ["customers:view"],
    input: { customer: id("customer (cus_…)") },
    run: async (ctx, a) => {
      const c = seg(a.customer);
      const [promo, excess, grants, movements, wallet] = await Promise.all([
        ctx.get(`customers/${c}/promotional_credits`),
        ctx.get(`customers/${c}/excess_payments`, { include_used: "true" }),
        ctx.get(`customers/${c}/credit_grants`),
        ctx.get(`customers/${c}/credit_transactions`),
        ctx.get(`customers/${c}/wallet`),
      ]);
      if (promo.status === 404) must(promo, `the customer ${String(a.customer)}`);
      return {
        promotional_credits: part(promo),
        excess_payments: leanRows(part(excess), leanExcessPayment),
        credit_grants: part(grants),
        credit_movements: part(movements),
        wallet: part(wallet),
      };
    },
  },
  {
    name: "get_timeline",
    title: "Record timeline",
    description:
      'What happened to one record, newest first: its events, and for a customer also the emails sent to them and their payments; for an invoice also its payments. Give a customer (cus_…), subscription (sub_…), invoice (inv_…), payment intent (pi_…) or transaction (txn_…) id, and its kind. Use it for "what happened to this customer" and "when was this invoice sent and paid". ' +
      `At most ${TIMELINE_MAX} entries. A part the member cannot read is left out and named in notes.`,
    perms: ["events:view"],
    input: {
      record: id("customer, subscription, invoice, payment intent or transaction"),
      kind: z
        .enum(TIMELINE_KINDS)
        .optional()
        .describe("What the record is. Needed when its id has no prefix (an imported record)."),
    },
    run: async (ctx, a) => {
      const record = String(a.record);
      const prefix = Object.keys(RECORD_KINDS).find((p) => record.startsWith(p));
      const kind = (a.kind as string | undefined) ?? (prefix ? RECORD_KINDS[prefix] : undefined);
      if (!kind)
        throw new ToolError(
          "We could not read the timeline. Give the record's kind: customer, subscription, invoice, payment_intent or transaction.",
        );
      const limit = TIMELINE_MAX;
      const isCustomer = kind === "customer";
      const [events, emails, payments] = await Promise.all([
        ctx.get(
          "events",
          isCustomer
            ? { customer: record, limit }
            : { resource_type: kind, resource_id: record, limit },
        ),
        isCustomer ? ctx.get("emails", { customer: record, limit }) : null,
        isCustomer || kind === "invoice"
          ? ctx.get("transactions", { [isCustomer ? "customer" : "invoice"]: record, limit })
          : null,
      ]);
      const notes: string[] = [];
      const read = (r: RouteResult | null, what: string): Row[] => {
        if (!r) return [];
        const body = part(r) as { data?: Row[]; unavailable?: string };
        if (body?.unavailable) notes.push(`We could not read the ${what}. ${body.unavailable}`);
        return body?.data ?? [];
      };
      const money = (r: Row) =>
        typeof r.amount_minor === "number" && typeof r.currency === "string"
          ? formatMoney(r.amount_minor, r.currency)
          : null;
      const join = (...xs: unknown[]) =>
        xs.filter((x) => typeof x === "string" && x).join(" · ") || null;
      const entries: Row[] = [
        ...read(events, "events").map((e) => {
          const res = e.resource as { type?: string; id?: string } | null;
          const data = (e.data as Row | null)?.[res?.type ?? ""] as Row | undefined;
          return {
            at: e.occurred_at ?? null,
            kind: "event",
            type: e.type ?? null,
            summary: join(res ? `${res.type} ${res.id}` : null, data ? money(data) : null),
            id: e.id ?? null,
            status: null,
          };
        }),
        ...read(emails, "emails").map((m) => ({
          at: m.created_at ?? null,
          kind: "email",
          type: m.type ?? null,
          summary: join(m.subject, m.to ? `to ${String(m.to)}` : null),
          id: m.id ?? null,
          status: m.status ?? null,
        })),
        ...read(payments, "payments").map((t) => ({
          at: t.occurred_at ?? t.created_at ?? null,
          kind: "payment",
          type: t.type ?? null,
          summary: join(
            money(t),
            t.invoice,
            t.method_type ?? (t.instrument as Row | null)?.type,
            t.error_text,
          ),
          id: t.id ?? null,
          status: t.status ?? null,
        })),
      ];
      const time = (r: Row) => (typeof r.at === "string" ? Date.parse(r.at) || 0 : 0);
      entries.sort((x, y) => time(y) - time(x));
      return {
        record,
        record_type: kind,
        entries: entries.slice(0, TIMELINE_MAX),
        ...(notes.length ? { notes } : {}),
      };
    },
  },
  {
    name: "search_docs",
    title: "Search the help",
    description:
      'Search the product help, the API reference and the engine notes. Use it for how-to questions ("how do I pause dunning", "what is a credit note") and to find the page to cite. ' +
      "Write the query in the product's own terms (dunning, credit note, proration, mandate, entitlement, meter…) as well as the user's words; if the results do not answer, search again with other words. " +
      "Returns the best section of each matching page with its URL. Cite the URL in your answer.",
    perms: [],
    input: {
      query: z.string().min(2).max(300).describe("The question or keywords."),
      source: z
        .enum(["help", "api", "engine", "all"])
        .optional()
        .describe(
          "help (default with api), api (the API reference), engine (rules of the billing engine), or all.",
        ),
      limit: z.number().int().min(1).max(10).optional().describe("Pages to return. Default 5."),
      audience: audienceInput,
    },
    run: async (ctx, a) => {
      const source = (a.source as string | undefined) ?? "default";
      const limit = (a.limit as number) ?? 5;
      // An operator needs the screen and the guide, not the API: developer pages show only
      // for a developer. The search says who it is for; else the turn's default.
      const audience = (a.audience as Audience | undefined) ?? ctx.audience;
      const guidesOnly = audience === "operator";
      const wanted: Array<"help" | "api" | "engine"> =
        source === "all"
          ? ["help", "api", "engine"]
          : source === "default"
            ? ["help", "api"]
            : [source as "help" | "api" | "engine"];
      const sources = guidesOnly ? wanted.filter((s) => s !== "api") : wanted;
      const found = sources.length
        ? await searchDocs(String(a.query), {
            sources,
            limit: guidesOnly ? 10 : limit,
            organizationId: ctx.organizationId,
            audience,
          })
        : [];
      const hits = guidesOnly ? found.filter((h) => !isDeveloperPage(h)).slice(0, limit) : found;
      if (guidesOnly && !hits.length)
        return {
          results: [],
          note: "No guide covers this. This search was for an operator, so do not cite developer pages or the API reference: answer with the screen (find_screen, show_in_app) and how the product works (search_source). If the member is asking about the API, code, webhooks or an integration, search again with audience developer.",
        };
      return {
        results: hits.map((h, i) => ({
          title: h.heading ? `${h.title} › ${h.heading}` : h.title,
          url: h.url,
          source: h.source,
          // The whole section for the best three, so a how-to answer has every step.
          ...(i < 3 ? { text: h.body } : { excerpt: h.excerpt }),
        })),
        ...(hits.length ? {} : { note: "Nothing matched. Try other words, or source all." }),
      };
    },
  },
  {
    name: "get_api_reference",
    title: "API reference",
    description:
      "The exact definition of one API operation (parameters, request body, responses, permission), from the OpenAPI document. " +
      "Give method and path, e.g. GET /v1/businesses/{biz}/invoices. Without a path, query finds operations by words in their path or summary.",
    perms: [],
    input: {
      method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).optional(),
      path: z
        .string()
        .max(300)
        .optional()
        .describe("The operation path, e.g. /v1/businesses/{biz}/subscriptions/{sub}/cancel."),
      query: z
        .string()
        .max(200)
        .optional()
        .describe('Words to find operations, e.g. "cancel subscription".'),
    },
    run: async (_ctx, a) => {
      if (a.method && a.path) {
        const op = apiOperation(String(a.method), String(a.path));
        if (!op) {
          throw new ToolError(
            `We could not find ${String(a.method)} ${String(a.path)}. Use query to find the operation first.`,
          );
        }
        return op;
      }
      if (!a.query) throw new ToolError("We could not search. Give method and path, or query.");
      return { operations: findApiOperations(String(a.query)) };
    },
  },
  {
    name: "find_screen",
    title: "Find a dashboard screen",
    description:
      "Where something is in the dashboard: the screen's name, its menu location, a link to it for this business, the card on the screen, and the buttons, fields and settings in it, with their exact labels. " +
      'Use it to write "where do I click" guides. The screen the member is on is always included, marked on_this_page, with its best-matching card; prefer it when its controls do what they asked. Some controls show only for some roles or record states.',
    perms: [],
    input: {
      query: z
        .string()
        .min(2)
        .max(200)
        .describe(
          'What the member wants to do or find, e.g. "create an API key" or "dunning retry schedule".',
        ),
    },
    run: async (ctx, a) => {
      const query = String(a.query);
      const hits = await searchDocs(query, {
        sources: ["ui"],
        limit: 5,
        organizationId: ctx.organizationId,
      });
      // The screen the member is on, when it has what they asked for: the narrowest place.
      const here = ctx.page ? screenForPath(ctx.page.path) : null;
      const onPage = here
        ? (
            await searchDocs(query, {
              sources: ["ui"],
              limit: 1,
              paths: [here.route],
              organizationId: ctx.organizationId,
            })
          )[0]
        : undefined;
      // Added, not forced first: the model weighs it against the best matches.
      const ordered = onPage ? [...hits.filter((h) => h.path !== onPage.path), onPage] : hits;
      return {
        screens: ordered.map((h) => {
          const controls = /On this screen: (.*)$/m.exec(h.body)?.[1] ?? "";
          const cards = /^Cards: (.*)$/m.exec(h.body)?.[1] ?? "";
          const isHere = h === onPage;
          // On the member's page, link the page itself (its record ids filled in).
          const path = isHere
            ? ctx.page!.path
            : (h.url ?? "").replace("{business}", ctx.business.id);
          const ready = !/\{[^}]+\}/.test(path);
          return {
            screen: h.title,
            ...(isHere ? { on_this_page: true } : {}),
            path,
            // Copy as is. A path with {placeholders} needs a record id, so it has no link.
            ...(ready ? { link: `[${h.heading ?? h.title}](${path})` } : { link: null }),
            // The card on the screen these controls sit in, as its title reads.
            cards: cards.split(" · ").filter(Boolean),
            controls: controls.split(" · ").filter(Boolean),
          };
        }),
      };
    },
  },
  {
    name: "search_source",
    title: "Check how the product works",
    assistantOnly: true,
    description:
      "Search the product's own source code (engine and dashboard), the complete record of what it does: which setting decides something, what happens in an edge case, which screen and control change it. Use it whenever the help does not answer, and before saying something is not possible. " +
      "It is a reference for you only. Never show code, file names, or function or variable names in your answer: describe the behaviour in plain words.",
    perms: [],
    input: {
      query: z
        .string()
        .min(2)
        .max(200)
        .describe(
          'Plain words or identifiers, e.g. "proration credit on downgrade" or "retry schedule hard decline".',
        ),
    },
    run: async (ctx, a) => {
      const hits = await searchDocs(String(a.query), {
        sources: ["code"],
        limit: 5,
        organizationId: ctx.organizationId,
      });
      return {
        reference_only: true,
        sections: hits.map((h) => ({ file: h.path, symbol: h.heading, code: h.body })),
      };
    },
  },
  {
    name: "read_api",
    title: "Read any business resource",
    description:
      "GET any read endpoint of this business that the other tools do not cover, by its path after /v1/businesses/{business}/. " +
      "Examples: credit_notes, credit_notes/cn_…, coupons, prices, products, payment_intents/pi_…, customers/cus_…/promotional_credits, disputes, retries, events, emails, reports. " +
      "Documents (pdf, html), bulk exports and connection settings are not available here.",
    perms: [],
    input: {
      path: z.string().min(1).max(300).describe("e.g. credit_notes or customers/cus_…/wallet"),
      query: z
        .record(z.string().max(80), z.union([z.string().max(500), z.number(), z.boolean()]))
        .optional()
        .describe("Query parameters, e.g. limit, starting_after, filters as field[op]."),
    },
    run: async (ctx, a) => {
      const path = String(a.path).replace(/^\/+|\/+$/g, "");
      if (!READ_API_PATH.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
        throw new ToolError(
          "We could not read that path. Give a path after /v1/businesses/{business}/, such as credit_notes or customers/cus_123/wallet.",
        );
      }
      if (READ_API_DENY.some((re) => re.test(path))) {
        throw new ToolError(
          "We could not read that path. Documents, bulk exports and connection settings are not available to AI assistants. Use the dashboard or the API.",
        );
      }
      return must(await ctx.get(path, a.query as Record<string, QueryValue> | undefined), path);
    },
  },
  {
    name: "query_records",
    title: "Count, sum and group records",
    description:
      'Count, sum, average, min, max or group ANY list of this business, over every matching row, not only a page: "how much will PayPal customers pay next month", "how many trials end this week by plan", "unpaid total by country", "which plan churned most". ' +
      "resource is a list path after /v1/businesses/{business}/ (subscriptions, invoices, transactions, customers, credit_notes, payment_requests, payment_intents, disputes, retries, events, emails, usage_events, unbilled_charges, coupons, prices, products, customers/cus_…/credit_grants, …). " +
      "filters are the list's own \"field[op]\" filters (they run in the database: use them first); with_payer joins each row's customer and how they pay; where filters the rows read, on any field including payer.pays_with.type; group_by and metrics say what to count. " +
      "Money fields end in _minor. The answer holds the figures and a few sample rows; complete: false means the row or time budget cut the read. Use this instead of listing rows and adding them up yourself.",
    perms: [],
    input: {
      resource: z
        .string()
        .min(1)
        .max(200)
        .describe("The list path, e.g. subscriptions or invoices."),
      filters: listInput.filters,
      with_payer: z
        .boolean()
        .optional()
        .describe("Join each row's customer (name, email) and how they pay, as payer."),
      where: z
        .record(z.string().max(80), z.unknown())
        .optional()
        .describe(
          'Keep rows where each dot path matches: a value (strings compare without case), a list (one of), or {in, not_in, gt, gte, lt, lte, contains, is_present}. Example: {"payer.pays_with.type": "paypal", "amount_due_minor": {"gt": 0}}.',
        ),
      group_by: z
        .array(z.string().max(80))
        .max(3)
        .optional()
        .describe('Dot paths to group by, e.g. ["currency", "payer.pays_with.type"].'),
      metrics: z
        .array(
          z.object({
            op: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]),
            field: z.string().max(80).optional().describe("The dot path; not needed for count."),
          }),
        )
        .max(5)
        .optional()
        .describe(
          'Default: count. Example: [{"op": "sum", "field": "recurring_amount_minor"}, {"op": "count_distinct", "field": "customer"}].',
        ),
      sample: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Sample rows to return. Default 3."),
      max_rows: z
        .number()
        .int()
        .min(100)
        .max(5000)
        .optional()
        .describe("Most rows to read. Default 2000."),
    },
    run: async (ctx, a) => {
      const path = String(a.resource).replace(/^\/+|\/+$/g, "");
      if (!READ_API_PATH.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
        throw new ToolError(
          "We could not query that path. Give a list path after /v1/businesses/{business}/, such as subscriptions or customers/cus_123/credit_grants.",
        );
      }
      if (READ_API_DENY.some((re) => re.test(path))) {
        throw new ToolError(
          "We could not query that path. Documents, bulk exports and connection settings are not available to AI assistants.",
        );
      }
      return queryRecords(
        ctx,
        {
          resource: path,
          filters: a.filters as Record<string, QueryValue> | undefined,
          where: a.where as Record<string, unknown> | undefined,
          group_by: a.group_by as string[] | undefined,
          metrics: a.metrics as Metric[] | undefined,
          sample: a.sample as number | undefined,
          max_rows: a.max_rows as number | undefined,
        },
        a.with_payer ? (rows) => joinPayers(ctx, rows) : undefined,
      );
    },
  },
];
