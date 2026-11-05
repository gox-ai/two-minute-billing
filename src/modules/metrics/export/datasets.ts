import { reportableCustomer } from "../reportable";
import { and, asc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { csvRow } from "@/platform/csv";
import { withTenant } from "@/platform/db";
import { businesses, invoices, mrrMovements, transactions } from "@db/schema";
import { ANALYTICS_RANGES, buildBuckets, type AnalyticsRange } from "../analytics";

/**
 * The rows BEHIND a report figure.
 *
 * A report answers "what is recurring revenue this quarter". The next question a finance
 * team asks is "which movements make that up", and until now the only way to ask it was the
 * list API with hand-built filters — which does not know what window the report used, so the
 * two disagree on exactly the edges nobody checks.
 *
 * So every dataset here declares the report it reconciles with, and takes its window from
 * `buildBuckets` — the same function the report layer builds its buckets from. Not a similar
 * window: the same one, or the export would explain a figure it does not equal.
 */
export class RawExportError extends Error {}

export type RawDatasetKey = "mrr_movements" | "invoices" | "payments" | "refunds";

export interface RawDatasetDef {
  key: RawDatasetKey;
  name: string;
  description: string;
  /** The report key whose headline Σ `reporting_amount_minor` equals over the same window. */
  reconciles_with: string;
  /** The row's own money column, in its own currency. */
  amount_column: string;
  columns: string[];
}

export const RAW_DATASETS: RawDatasetDef[] = [
  {
    key: "mrr_movements",
    name: "MRR movements",
    description:
      "Every change to recurring revenue in the window, with the reason, the subscription and the plan it happened on.",
    reconciles_with: "net_mrr_growth",
    amount_column: "delta_minor",
    columns: [
      "id",
      "occurred_at",
      "reason",
      "subscription_id",
      "customer_id",
      "plan_product_id",
      "previous_plan_product_id",
      "currency",
      "previous_mrr_minor",
      "new_mrr_minor",
      "delta_minor",
      "reporting_currency",
      "reporting_rate",
      "reporting_amount_minor",
    ],
  },
  {
    key: "invoices",
    name: "Invoices",
    description: "Every invoice billed in the window, at the document total.",
    reconciles_with: "total_billing",
    amount_column: "total_minor",
    columns: [
      "id",
      "number",
      "created_at",
      "status",
      "customer_id",
      "subscription_id",
      "due_date",
      "paid_at",
      "currency",
      "amount_due_minor",
      "total_minor",
      "reporting_currency",
      "reporting_rate",
      "reporting_amount_minor",
    ],
  },
  {
    key: "payments",
    name: "Payments",
    description: "Every successful payment the gateway moved in the window.",
    reconciles_with: "total_payments",
    amount_column: "amount_minor",
    columns: [
      "id",
      "occurred_at",
      "status",
      "customer_id",
      "invoice_id",
      "gateway_key",
      "id_at_gateway",
      "currency",
      "amount_minor",
      "reporting_currency",
      "reporting_rate",
      "reporting_amount_minor",
    ],
  },
  {
    key: "refunds",
    name: "Refunds",
    description: "Every successful refund the gateway moved in the window.",
    reconciles_with: "total_refunds",
    amount_column: "amount_minor",
    columns: [
      "id",
      "occurred_at",
      "status",
      "customer_id",
      "invoice_id",
      "gateway_key",
      "id_at_gateway",
      "currency",
      "amount_minor",
      "reporting_currency",
      "reporting_rate",
      "reporting_amount_minor",
    ],
  },
];

const BY_KEY = new Map(RAW_DATASETS.map((d) => [d.key, d]));
export const isRawDataset = (k: string): k is RawDatasetKey => BY_KEY.has(k as RawDatasetKey);

/** Invoice statuses that mean the document was BILLED — the same set `total_billing` sums. */
const BILLED_STATUSES = ["posted", "payment_due", "not_paid", "paid"];

/** One page is bounded so neither the query nor the response can grow with the book. */
export const MAX_PAGE = 1000;
const DEFAULT_PAGE = 500;

export type RawCell = string | number | null;

export interface RawExportOptions {
  range?: string;
  currency?: string;
  limit?: number;
  startingAfter?: string;
  now?: Date;
}

export interface RawExportPage {
  dataset: RawDatasetDef;
  columns: string[];
  rows: RawCell[][];
  hasMore: boolean;
  nextCursor: string | null;
  windowStart: Date;
  windowEnd: Date;
  reportingCurrency: string;
  /** False when the caller scoped to one currency, so nothing was converted at all. */
  converted: boolean;
  /** Per currency, in that currency. Never added up — paise are not cents. */
  totalsByCurrency: { currency: string; amount_minor: number; rows: number }[];
}

/**
 * Keyset cursor: the sort instant and the row id it stopped on.
 *
 * The instant travels as Postgres' OWN text, not as a JS `Date`. Postgres keeps microseconds
 * and a `Date` keeps milliseconds, so a cursor round-tripped through one truncates — and
 * `> truncated` then re-reads every row inside that millisecond. On the real book that
 * duplicated invoices across a page boundary and the export exceeded the report it was
 * supposed to equal.
 */
const encodeCursor = (at: string, id: string) =>
  Buffer.from(`${at}|${id}`, "utf8").toString("base64url");

function decodeCursor(raw: string): { at: string; id: string } {
  const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  // Postgres' own rendering — `2026-09-18 08:05:20.123456+00` — which `Date` will not parse
  // and must not be asked to: the point of carrying the text is that nothing truncates it.
  if (!at || !id || !/^\d{4}-\d{2}-\d{2} [\d:.]+[+-]\d{2}(:\d{2})?$/.test(at)) {
    throw new RawExportError("starting_after is not a cursor");
  }
  return { at, id };
}

/**
 * The currency context, resolved exactly as the report layer resolves it: a business default
 * to report in, the stored rates to convert with, and a row that no rate reaches is EXCLUDED
 * rather than converted at 1. Excluding it is what keeps the export equal to the figure —
 * the report drops that row too.
 */
async function currencyContext(organizationId: string, businessId: string, requested?: string) {
  const [biz] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        defaultCurrency: businesses.defaultCurrency,
        exchangeRates: businesses.exchangeRates,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  const rates = (biz?.exchangeRates as Record<string, number> | null) ?? {};
  const scoped = (requested ?? "ALL").toUpperCase() === "ALL" ? null : requested!.toUpperCase();
  const reporting = scoped ?? (biz?.defaultCurrency ?? "USD").toUpperCase();

  /** Units of the row's currency per one unit of the reporting currency; null = 1:1. */
  const rateFor = (ccy: string): number | null =>
    ccy.toUpperCase() === reporting ? null : (rates[ccy.toUpperCase()] ?? null);

  const convert = (minor: number, ccy: string): number | null => {
    const c = ccy.toUpperCase();
    if (scoped) return c === scoped ? minor : null;
    if (c === reporting) return minor;
    const rate = rates[c];
    return rate != null && rate > 0 ? Math.round(minor / rate) : null;
  };

  // Pushed into SQL rather than filtered afterwards, so a page is a page: the representable
  // set is exactly the currencies `convert` would answer for.
  const representable = scoped
    ? [scoped]
    : [
        reporting,
        ...Object.keys(rates)
          .filter((c) => (rates[c] ?? 0) > 0)
          .map((c) => c.toUpperCase()),
      ];

  return { reporting, scoped, convert, rateFor, representable: [...new Set(representable)] };
}

type Ctx = Awaited<ReturnType<typeof currencyContext>>;

/** The window, taken the way a report takes it — never re-derived from the range name. */
export function exportWindow(range: string | undefined, now: Date) {
  if (range != null && range !== "" && !ANALYTICS_RANGES.includes(range as AnalyticsRange)) {
    throw new RawExportError(`range must be one of: ${ANALYTICS_RANGES.join(", ")}`);
  }
  const buckets = buildBuckets((range || "12m") as AnalyticsRange, now, "back");
  return { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };
}

/**
 * Keyset, not OFFSET: the sort instant plus the row id, so a page is a range scan on an
 * index the table already carries and the cost of page 600 is the cost of page 1.
 */
const after = (
  sortCol: SQL | typeof invoices.createdAt,
  idCol: typeof invoices.id,
  c: { at: string; id: string },
) =>
  or(
    // Bound as an explicit timestamptz: a raw fragment does not carry the column's own
    // mapper, so the value reaches Postgres as an untyped string.
    sql`${sortCol} > ${c.at}::timestamptz`,
    and(sql`${sortCol} = ${c.at}::timestamptz`, sql`${idCol} > ${c.id}::uuid`),
  )!;

export async function readRawPage(
  organizationId: string,
  businessId: string,
  datasetKey: RawDatasetKey,
  opts: RawExportOptions & { skipTotals?: boolean } = {},
): Promise<RawExportPage> {
  const def = BY_KEY.get(datasetKey)!;
  const now = opts.now ?? new Date();
  const w = exportWindow(opts.range, now);
  const ctx = await currencyContext(organizationId, businessId, opts.currency);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);
  const cursor = opts.startingAfter ? decodeCursor(opts.startingAfter) : null;

  const { rows, hasMore, nextCursor } = await fetchRows(
    organizationId,
    businessId,
    def,
    ctx,
    w,
    limit,
    cursor,
  );
  // The stream asks per page and only needs the totals once, so it opts out.
  const totals = opts.skipTotals
    ? []
    : await totalsByCurrency(organizationId, businessId, def, ctx, w);

  return {
    dataset: def,
    columns: def.columns,
    rows,
    hasMore,
    nextCursor,
    windowStart: w.start,
    windowEnd: w.end,
    reportingCurrency: ctx.reporting,
    converted: ctx.scoped == null,
    totalsByCurrency: totals,
  };
}

const iso = (d: Date | null) => (d == null ? null : d.toISOString());

/** The conversion columns every dataset carries: native, currency, rate, converted. */
function converted(ctx: Ctx, amountMinor: bigint | number | null, currency: string): RawCell[] {
  const native = Number(amountMinor ?? 0);
  const rate = ctx.rateFor(currency);
  return [ctx.reporting, rate, ctx.convert(native, currency)];
}

async function fetchRows(
  organizationId: string,
  businessId: string,
  def: RawDatasetDef,
  ctx: Ctx,
  w: { start: Date; end: Date },
  limit: number,
  cursor: { at: string; id: string } | null,
): Promise<{ rows: RawCell[][]; hasMore: boolean; nextCursor: string | null }> {
  // One row more than asked for: the extra is not returned, it only answers `has_more`.
  const take = limit + 1;
  let out: { id: string; at: string; cells: RawCell[] }[] = [];

  if (def.key === "mrr_movements") {
    const where = and(
      and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
      gte(mrrMovements.occurredAt, w.start),
      lt(mrrMovements.occurredAt, w.end),
      inArray(sql`upper(${mrrMovements.currency})`, ctx.representable),
      cursor
        ? after(mrrMovements.occurredAt as never, mrrMovements.id as never, cursor)
        : undefined,
    )!;
    const rows = await withTenant(organizationId, (tx) =>
      tx
        .select({
          id: mrrMovements.id,
          occurredAt: mrrMovements.occurredAt,
          sortText: sql<string>`${mrrMovements.occurredAt}::text`,
          reason: mrrMovements.reason,
          subscriptionId: mrrMovements.subscriptionId,
          customerId: mrrMovements.customerId,
          planProductId: mrrMovements.planProductId,
          previousPlanProductId: mrrMovements.previousPlanProductId,
          currency: mrrMovements.currency,
          previousMrrMinor: mrrMovements.previousMrrMinor,
          newMrrMinor: mrrMovements.newMrrMinor,
          deltaMinor: mrrMovements.deltaMinor,
        })
        .from(mrrMovements)
        .where(where)
        .orderBy(asc(mrrMovements.occurredAt), asc(mrrMovements.id))
        .limit(take),
    );
    out = rows.map((r) => ({
      id: r.id,
      at: r.sortText,
      cells: [
        r.id,
        iso(r.occurredAt),
        r.reason,
        r.subscriptionId,
        r.customerId,
        r.planProductId,
        r.previousPlanProductId,
        r.currency,
        Number(r.previousMrrMinor),
        Number(r.newMrrMinor),
        Number(r.deltaMinor),
        ...converted(ctx, r.deltaMinor, r.currency),
      ],
    }));
  } else if (def.key === "invoices") {
    const where = and(
      and(eq(invoices.businessId, businessId), reportableCustomer(invoices.customerId)),
      inArray(invoices.status, BILLED_STATUSES),
      gte(invoices.createdAt, w.start),
      lt(invoices.createdAt, w.end),
      inArray(sql`upper(${invoices.currency})`, ctx.representable),
      cursor ? after(invoices.createdAt as never, invoices.id, cursor) : undefined,
    )!;
    const rows = await withTenant(organizationId, (tx) =>
      tx
        .select({
          id: invoices.id,
          sortText: sql<string>`${invoices.createdAt}::text`,
          publicId: invoices.publicId,
          number: invoices.number,
          createdAt: invoices.createdAt,
          status: invoices.status,
          customerId: invoices.customerId,
          subscriptionId: invoices.subscriptionId,
          dueDate: invoices.dueDate,
          paidAt: invoices.paidAt,
          currency: invoices.currency,
          amountDueMinor: invoices.amountDueMinor,
          totalMinor: invoices.totalMinor,
        })
        .from(invoices)
        .where(where)
        .orderBy(asc(invoices.createdAt), asc(invoices.id))
        .limit(take),
    );
    out = rows.map((r) => ({
      id: r.id,
      at: r.sortText,
      cells: [
        r.publicId,
        r.number,
        iso(r.createdAt),
        r.status,
        r.customerId,
        r.subscriptionId,
        iso(r.dueDate),
        iso(r.paidAt),
        r.currency,
        r.amountDueMinor == null ? null : Number(r.amountDueMinor),
        Number(r.totalMinor),
        ...converted(ctx, r.totalMinor, r.currency),
      ],
    }));
  } else {
    const type = def.key === "refunds" ? "refund" : "payment";
    const where = and(
      and(eq(transactions.businessId, businessId), reportableCustomer(transactions.customerId)),
      eq(transactions.type, type),
      eq(transactions.status, "succeeded"),
      gte(transactions.occurredAt, w.start),
      lt(transactions.occurredAt, w.end),
      inArray(sql`upper(${transactions.currency})`, ctx.representable),
      cursor
        ? after(transactions.occurredAt as never, transactions.id as never, cursor)
        : undefined,
    )!;
    const rows = await withTenant(organizationId, (tx) =>
      tx
        .select({
          id: transactions.id,
          sortText: sql<string>`${transactions.occurredAt}::text`,
          publicId: transactions.publicId,
          occurredAt: transactions.occurredAt,
          status: transactions.status,
          customerId: transactions.customerId,
          invoiceId: transactions.invoiceId,
          gatewayKey: transactions.gatewayKey,
          idAtGateway: transactions.idAtGateway,
          currency: transactions.currency,
          amountMinor: transactions.amountMinor,
        })
        .from(transactions)
        .where(where)
        .orderBy(asc(transactions.occurredAt), asc(transactions.id))
        .limit(take),
    );
    out = rows.map((r) => ({
      id: r.id,
      at: r.sortText,
      cells: [
        r.publicId,
        iso(r.occurredAt),
        r.status,
        r.customerId,
        r.invoiceId,
        r.gatewayKey,
        r.idAtGateway,
        r.currency,
        Number(r.amountMinor),
        ...converted(ctx, r.amountMinor, r.currency),
      ],
    }));
  }

  const hasMore = out.length > limit;
  const page = hasMore ? out.slice(0, limit) : out;
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => r.cells),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.at, last.id) : null,
  };
}

/**
 * The window total per currency, in that currency. There is deliberately no total across
 * them: adding paise to cents produces a number that is true of nothing.
 */
async function totalsByCurrency(
  organizationId: string,
  businessId: string,
  def: RawDatasetDef,
  ctx: Ctx,
  w: { start: Date; end: Date },
): Promise<{ currency: string; amount_minor: number; rows: number }[]> {
  const read = async <T extends { currency: string; amount: unknown; n: unknown }>(
    q: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T[]>,
  ) => {
    const rows = await withTenant(organizationId, q);
    return rows
      .map((r) => ({
        currency: r.currency.toUpperCase(),
        amount_minor: Number(r.amount ?? 0),
        rows: Number(r.n ?? 0),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  };

  if (def.key === "mrr_movements") {
    return read((tx) =>
      tx
        .select({
          currency: mrrMovements.currency,
          amount: sql<string>`coalesce(sum(${mrrMovements.deltaMinor}), 0)`,
          n: sql<string>`count(*)`,
        })
        .from(mrrMovements)
        .where(
          and(
            and(
              eq(mrrMovements.businessId, businessId),
              reportableCustomer(mrrMovements.customerId),
            ),
            gte(mrrMovements.occurredAt, w.start),
            lt(mrrMovements.occurredAt, w.end),
            inArray(sql`upper(${mrrMovements.currency})`, ctx.representable),
          ),
        )
        .groupBy(mrrMovements.currency),
    );
  }
  if (def.key === "invoices") {
    return read((tx) =>
      tx
        .select({
          currency: invoices.currency,
          amount: sql<string>`coalesce(sum(${invoices.totalMinor}), 0)`,
          n: sql<string>`count(*)`,
        })
        .from(invoices)
        .where(
          and(
            and(eq(invoices.businessId, businessId), reportableCustomer(invoices.customerId)),
            inArray(invoices.status, BILLED_STATUSES),
            gte(invoices.createdAt, w.start),
            lt(invoices.createdAt, w.end),
            inArray(sql`upper(${invoices.currency})`, ctx.representable),
          ),
        )
        .groupBy(invoices.currency),
    );
  }
  const type = def.key === "refunds" ? "refund" : "payment";
  return read((tx) =>
    tx
      .select({
        currency: transactions.currency,
        amount: sql<string>`coalesce(sum(${transactions.amountMinor}), 0)`,
        n: sql<string>`count(*)`,
      })
      .from(transactions)
      .where(
        and(
          and(eq(transactions.businessId, businessId), reportableCustomer(transactions.customerId)),
          eq(transactions.type, type),
          eq(transactions.status, "succeeded"),
          gte(transactions.occurredAt, w.start),
          lt(transactions.occurredAt, w.end),
          inArray(sql`upper(${transactions.currency})`, ctx.representable),
        ),
      )
      .groupBy(transactions.currency),
  );
}

/**
 * The CSV, a page at a time.
 *
 * A generator rather than a string: the real book carries thousands of payments on ONE
 * business, and an export that concatenates them all holds the whole answer in memory before
 * it sends a byte. Here at most one page exists at a time, whatever the tenant's size.
 *
 * The header is emitted even when the window is empty — a file with a header and no rows
 * says "nothing happened", where an empty file says "the export broke".
 */
export async function* streamRawCsv(
  organizationId: string,
  businessId: string,
  datasetKey: RawDatasetKey,
  opts: RawExportOptions = {},
): AsyncGenerator<string> {
  const def = BY_KEY.get(datasetKey)!;
  yield `${csvRow(def.columns)}\n`;
  let cursor = opts.startingAfter;
  // The window is resolved once, so every page is cut on the same instants even if the
  // clock crosses a bucket boundary mid-export.
  const now = opts.now ?? new Date();
  for (;;) {
    const page = await readRawPage(organizationId, businessId, datasetKey, {
      ...opts,
      now,
      limit: MAX_PAGE,
      startingAfter: cursor,
      skipTotals: true,
    });
    if (page.rows.length > 0) yield `${page.rows.map(csvRow).join("\n")}\n`;
    if (!page.hasMore || !page.nextCursor) return;
    cursor = page.nextCursor;
  }
}
