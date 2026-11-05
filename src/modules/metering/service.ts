import { stampNow } from "@/platform/clock";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { businessTimezone } from "@/platform/business-tz";
import {
  clampLimit,
  countExpr,
  filterConditions,
  keysetCondition,
  kindsFromSpecs,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import {
  invoiceLineItems,
  invoices,
  prices,
  subscriptionItems,
  subscriptions,
  usageRecords,
} from "@db/schema";
import { createLogger } from "@/platform/logger";
import type { PriceSnapshot, UsageAggregation } from "@/modules/catalog/pricing";
import { usageWindowStart } from "@/modules/subscriptions/usage-window";
import { windowAggregate } from "./measure";

const log = createLogger("metering");

export type { UsageAggregation };

/** A usage event the item's price cannot take (a negative quantity, a remove). */
export class UsageRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageRuleError";
  }
}

/**
 * The rules an event must meet for its item's price. A negative quantity is a delta on a
 * recurring sum or a weighted_sum. `remove` takes a `unique_key` off a unique metric.
 */
export function usageEventIssue(
  snap: Pick<PriceSnapshot, "usageAggregation" | "usageRecurring"> | null,
  e: { quantity: number; operation: "add" | "remove"; uniqueKey?: string },
): string | null {
  const agg = snap?.usageAggregation ?? "sum";
  if (e.operation === "remove") {
    if (agg !== "unique")
      return "We could not record the usage. Only a price with the unique aggregation takes a remove operation. Send operation add.";
    if (!e.uniqueKey)
      return "We could not record the usage. A remove operation needs a unique_key. Send the key to remove.";
  }
  if (e.quantity < 0 && !(agg === "weighted_sum" || (agg === "sum" && snap?.usageRecurring)))
    return "We could not record the usage. A negative quantity is allowed only for a recurring sum or a weighted_sum price. Send a quantity of 0 or more.";
  return null;
}

/** A usage key reused with different values. Never answered with the old record. */
export class UsageIdempotencyConflictError extends Error {
  constructor(idempotencyKey: string, usagePublicId: string) {
    super(
      `We could not record the usage. The idempotency key ${idempotencyKey} is already used by usage record ${usagePublicId} with different values. Use a new idempotency key for a new usage event, or send the same values to repeat the request.`,
    );
    this.name = "UsageIdempotencyConflictError";
  }
}

/** A usage timestamp that no future invoice will bill. */
export class UsageOutsideWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageOutsideWindowError";
  }
}

/** How far ahead of "now" a usage timestamp may be (clock skew between caller and us). */
export const USAGE_FUTURE_TOLERANCE_MS = 5 * 60_000;

/** The refusal for a timestamp outside `[windowStart, now + 5 min]`, or null when it is inside. */
function windowRefusal(
  ts: Date,
  w: { start: Date; subscriptionStart: Date },
  now: Date,
): string | null {
  const latest = new Date(now.getTime() + USAGE_FUTURE_TOLERANCE_MS);
  let reason: string;
  if (ts.getTime() > latest.getTime())
    reason = `The timestamp ${ts.toISOString()} is more than 5 minutes in the future.`;
  else if (ts.getTime() < w.subscriptionStart.getTime())
    reason = `The timestamp ${ts.toISOString()} is before the subscription starts.`;
  else if (ts.getTime() < w.start.getTime())
    reason = `The timestamp ${ts.toISOString()} is in a period that is already invoiced.`;
  else return null;
  const accepted =
    w.start.getTime() <= latest.getTime()
      ? `This subscription item accepts usage from ${w.start.toISOString()} to ${latest.toISOString()}. Send a timestamp in this window.`
      : `This subscription item accepts usage from ${w.start.toISOString()}. Send the usage at or after that time.`;
  return `We could not record the usage. ${reason} ${accepted}`;
}

/**
 * Record a metered usage event for a subscription item.
 *
 * With an `idempotencyKey`, a repeat with the same values returns the existing record and a
 * repeat with different values throws `UsageIdempotencyConflictError`. An omitted timestamp
 * matches any stored one: the first request was stamped "now".
 *
 * `checkWindow` (the API) refuses a timestamp no future invoice bills — see
 * `usageWindowStart` — or one more than 5 minutes ahead of the business clock.
 */
export async function recordUsage(input: {
  organizationId: string;
  businessId: string;
  subscriptionItemId: string;
  quantity: number;
  uniqueKey?: string;
  /** add (default) | remove — see `usageEventIssue`. */
  operation?: "add" | "remove";
  timestamp?: Date;
  idempotencyKey?: string;
  note?: string;
  checkWindow?: boolean;
}): Promise<typeof usageRecords.$inferSelect> {
  const operation = input.operation ?? "add";
  return withTenant(input.organizationId, async (tx) => {
    const findExisting = async () => {
      const [existing] = await tx
        .select()
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.subscriptionItemId, input.subscriptionItemId),
            eq(usageRecords.idempotencyKey, input.idempotencyKey!),
          ),
        )
        .limit(1);
      return existing;
    };
    const replay = (existing: typeof usageRecords.$inferSelect) => {
      const same =
        existing.quantity === BigInt(input.quantity) &&
        existing.uniqueKey === (input.uniqueKey ?? null) &&
        existing.operation === operation &&
        existing.note === (input.note ?? null) &&
        (input.timestamp === undefined ||
          existing.timestamp.getTime() === input.timestamp.getTime());
      if (!same) throw new UsageIdempotencyConflictError(input.idempotencyKey!, existing.publicId);
      // Debug rather than warn: a retried usage POST is the system working as designed.
      log.debug("usage record deduplicated by idempotency key", {
        subscriptionItem: input.subscriptionItemId,
        idempotencyKey: input.idempotencyKey,
        quantity: input.quantity,
      });
      return existing;
    };

    // A repeat is answered before the window check: its window can have closed since.
    if (input.idempotencyKey) {
      const existing = await findExisting();
      if (existing) return replay(existing);
    }
    const [item] = await tx
      .select({ snapshot: subscriptionItems.priceSnapshot })
      .from(subscriptionItems)
      .where(eq(subscriptionItems.id, input.subscriptionItemId))
      .limit(1);
    const issue = usageEventIssue((item?.snapshot as PriceSnapshot | null) ?? null, {
      quantity: input.quantity,
      operation,
      uniqueKey: input.uniqueKey,
    });
    if (issue) throw new UsageRuleError(issue);
    const now = stampNow(input.businessId);
    const timestamp = input.timestamp ?? now;
    if (input.checkWindow) {
      const w = await usageWindowStart(tx, input.subscriptionItemId);
      const refusal = w && windowRefusal(timestamp, w, now);
      if (refusal) throw new UsageOutsideWindowError(refusal);
    }

    const inserted = await tx
      .insert(usageRecords)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        subscriptionItemId: input.subscriptionItemId,
        publicId: publicId("ur"),
        quantity: BigInt(input.quantity),
        uniqueKey: input.uniqueKey ?? null,
        operation,
        timestamp,
        idempotencyKey: input.idempotencyKey ?? null,
        note: input.note ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) return inserted[0]!;
    // Lost a race with a concurrent insert of the same key.
    return replay((await findExisting())!);
  });
}

/**
 * Aggregate usage for one subscription item over [start, end) per the aggregation mode,
 * with no carried level. Billing measures through `aggregateMeteredQuantity` (measure.ts).
 */
export async function aggregateUsage(
  organizationId: string,
  subscriptionItemId: string,
  start: Date,
  end: Date,
  mode: UsageAggregation,
): Promise<bigint> {
  return withTenant(organizationId, (tx) =>
    windowAggregate(tx, subscriptionItemId, { start, end }, mode),
  );
}

// ── Read + correct usage records ──────────────────────────────────────────────

/** A recurring record before the open window: later billed levels were measured from it. */
export class UsageLevelLockedError extends Error {
  constructor(usagePublicId: string, windowStart: Date) {
    super(
      `We could not delete usage ${usagePublicId}. Its price carries the level to later periods, and the record is before ${windowStart.toISOString()}, in a period that is already billed. Record a correcting event instead.`,
    );
    this.name = "UsageLevelLockedError";
  }
}

/** A usage record can no longer be deleted: an issued invoice rated its window. */
export class UsageInvoicedError extends Error {
  constructor(
    public readonly usagePublicId: string,
    public readonly invoicePublicId: string,
  ) {
    super(
      `Usage ${usagePublicId} was billed on invoice ${invoicePublicId} and cannot be deleted — issue a credit note to correct the charge`,
    );
    this.name = "UsageInvoicedError";
  }
}

/**
 * The invoice that rated this record, if any: a finalized (non-`pending`) invoice of the
 * record's subscription carrying a `usage` line whose window holds the record's timestamp.
 * A usage line carries the window it aggregated. A `pending` invoice re-aggregates at close,
 * so it does not count.
 */
const ratedOnInvoice = sql<string | null>`(
  select ${invoices.publicId} from ${invoices}
  join ${invoiceLineItems} on ${invoiceLineItems.invoiceId} = ${invoices.id}
  where ${invoices.subscriptionId} = ${subscriptions.id}
    and ${invoices.status} <> 'pending'
    and ${invoiceLineItems.kind} = 'usage'
    and ${invoiceLineItems.periodStart} <= ${usageRecords.timestamp}
    and ${usageRecords.timestamp} < ${invoiceLineItems.periodEnd}
  order by ${invoices.createdAt}
  limit 1
)`;

const usageSelection = {
  usage: usageRecords,
  itemPublicId: subscriptionItems.publicId,
  subscriptionPublicId: subscriptions.publicId,
  pricePublicId: prices.publicId,
  invoicePublicId: ratedOnInvoice,
  recurring: sql<boolean>`coalesce((${subscriptionItems.priceSnapshot} ->> 'usageRecurring')::boolean, false)`,
};

export type UsageRow = {
  usage: typeof usageRecords.$inferSelect;
  /** Null once the item was removed (the record is detached, 0371). */
  itemPublicId: string | null;
  subscriptionPublicId: string;
  pricePublicId: string | null;
  invoicePublicId: string | null;
  /** The item's price carries its level (`usage_recurring`). */
  recurring: boolean;
};

export function serializeUsage(r: UsageRow) {
  return {
    object: "usage_record" as const,
    id: r.usage.publicId,
    subscription: r.subscriptionPublicId,
    item: r.itemPublicId,
    price: r.pricePublicId,
    quantity: Number(r.usage.quantity),
    unique_key: r.usage.uniqueKey,
    operation: r.usage.operation,
    timestamp: r.usage.timestamp,
    note: r.usage.note,
    invoice: r.invoicePublicId,
    created_at: r.usage.createdAt,
  };
}

const USAGE_LIST_FILTERS: Record<string, FilterSpec> = {
  usage_date: { column: usageRecords.timestamp, kind: "date" },
  created_at: { column: usageRecords.createdAt, kind: "date" },
  invoiced: { column: sql`(${ratedOnInvoice} is not null)`, kind: "bool" },
  invoice: { column: ratedOnInvoice, kind: "text" },
};
export const USAGE_FILTER_OPS = opsFromSpecs(USAGE_LIST_FILTERS);
export const USAGE_FILTER_KINDS = kindsFromSpecs(USAGE_LIST_FILTERS);
export const USAGE_SORT_FIELDS = ["created_at", "usage_date"] as const;

// One join shape for the page, the count and the single read. A detached record (its item
// removed, 0371) carries its own subscription and price; a live one reads them from the item.
const usageSubscriptionId = sql`coalesce(${usageRecords.subscriptionId}, ${subscriptionItems.subscriptionId})`;
const usagePriceId = sql`coalesce(${usageRecords.priceId}, ${subscriptionItems.priceId})`;
const usageRows = (tx: Tx) =>
  tx
    .select(usageSelection)
    .from(usageRecords)
    .leftJoin(subscriptionItems, eq(usageRecords.subscriptionItemId, subscriptionItems.id))
    .innerJoin(subscriptions, eq(subscriptions.id, usageSubscriptionId))
    .leftJoin(prices, eq(prices.id, usagePriceId));
const usageCount = (tx: Tx) =>
  tx
    .select({ n: countExpr })
    .from(usageRecords)
    .leftJoin(subscriptionItems, eq(usageRecords.subscriptionItemId, subscriptionItems.id))
    .innerJoin(subscriptions, eq(subscriptions.id, usageSubscriptionId))
    .leftJoin(prices, eq(prices.id, usagePriceId));

/** A page of a business's usage records. Keyset on `(created_at | timestamp, public_id)`. */
export async function listUsagePage(
  organizationId: string,
  businessId: string,
  f: {
    subscriptionPublicId?: string;
    itemPublicId?: string;
    pricePublicId?: string;
    filters?: ListFilter[];
    sortField?: string;
    sortDesc?: boolean;
    startingAfter?: string;
    limit?: number;
  } = {},
): Promise<ListPage<UsageRow>> {
  const limit = clampLimit(f.limit);
  const descending = f.sortDesc ?? false;
  const sortCol = f.sortField === "usage_date" ? usageRecords.timestamp : usageRecords.createdAt;
  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(usageRecords.businessId, businessId)];
    if (f.subscriptionPublicId) conds.push(eq(subscriptions.publicId, f.subscriptionPublicId));
    if (f.itemPublicId) conds.push(eq(subscriptionItems.publicId, f.itemPublicId));
    if (f.pricePublicId) conds.push(eq(prices.publicId, f.pricePublicId));
    conds.push(
      ...filterConditions(USAGE_LIST_FILTERS, f.filters, await businessTimezone(tx, businessId)),
    );

    let total: number | null = null;
    if (!f.startingAfter) {
      const [row] = await usageCount(tx).where(and(...conds));
      total = row?.n ?? 0;
    }

    const { keysetId } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    if (keysetId) {
      const [cursor] = await tx
        .select({ sortValue: sql<string>`${sortCol}::text`, publicId: usageRecords.publicId })
        .from(usageRecords)
        .where(and(eq(usageRecords.businessId, businessId), eq(usageRecords.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        sortCol,
        usageRecords.publicId,
        cursor ? { sortValue: cursor.sortValue, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = (await usageRows(tx)
      .where(and(...pageConds))
      .orderBy(...pageOrder(sortCol, usageRecords.publicId, descending, true))
      .limit(limit + 1)) as UsageRow[];
    return toPage(rows, limit, { keyset: true, offset: 0, keyOf: (r) => r.usage.publicId, total });
  });
}

async function selectUsage(tx: Tx, businessId: string, usagePublicId: string) {
  const [row] = await usageRows(tx)
    .where(and(eq(usageRecords.businessId, businessId), eq(usageRecords.publicId, usagePublicId)))
    .limit(1);
  return (row as UsageRow | undefined) ?? null;
}

export async function getUsage(
  organizationId: string,
  businessId: string,
  usagePublicId: string,
): Promise<UsageRow | null> {
  return withTenant(organizationId, (tx) => selectUsage(tx, businessId, usagePublicId));
}

/**
 * Delete a usage record no issued invoice has rated. Nothing to recompute: usage is
 * aggregated from the rows at billing time (a `pending` invoice re-aggregates at close).
 * Once an invoice has billed the window, the correction is a credit note instead.
 */
export async function deleteUsage(
  organizationId: string,
  businessId: string,
  usagePublicId: string,
): Promise<UsageRow | null> {
  return withTenant(organizationId, async (tx) => {
    const row = await selectUsage(tx, businessId, usagePublicId);
    if (!row) return null;
    if (row.invoicePublicId) throw new UsageInvoicedError(usagePublicId, row.invoicePublicId);
    // A recurring record moves every later level, and a zero-level period has no line to
    // lock it, so anything before the open window is locked.
    if (row.usage.subscriptionItemId && row.recurring) {
      const w = await usageWindowStart(tx, row.usage.subscriptionItemId);
      if (w && row.usage.timestamp.getTime() < w.start.getTime())
        throw new UsageLevelLockedError(usagePublicId, w.start);
    }
    await tx.delete(usageRecords).where(eq(usageRecords.id, row.usage.id));
    return row;
  });
}
