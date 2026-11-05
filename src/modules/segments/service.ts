import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { customerSegments, customers, subscriptions } from "@db/schema";
import { isOrder } from "@/modules/metrics/daily/order-predicate";
import type { CustomerSegmentFilter } from "@db/schema";
import { filterValueError } from "@/platform/list-query";
import { createLogger } from "@/platform/logger";
import {
  CUSTOMER_FILTER_OPS,
  CUSTOMER_FILTER_KINDS,
  customerCustomFieldFilterSet,
  customerPopulationSql,
  listCustomersPage,
  mrrFilterBook,
  mrrFilterRefusal,
} from "@/modules/customers/service";
import { filterDefinitions } from "@/modules/custom-fields/service";
import { apiStatusSql } from "@/modules/subscriptions/status-sql";
import { refusalFor } from "./attributes";
import { STARTER_BY_PUBLIC_ID, STARTER_SEGMENTS, starterPublicId } from "./starters";

const log = createLogger("segments");

/**
 * Customer segments — a saved, named POPULATION, and the thing "compare segments"
 * charts a metric across.
 *
 * ⚠️ VOCABULARY. A **view** is a saved filter over a list (`list_views`); an
 * **attribute** is a stored dimension of a report (`metrics/reports`); a **segment** is
 * this. The three words are kept apart on purpose — `db/schema/segments.ts` says why.
 * Nothing in this module calls a segment a view, and nothing in the metrics module
 * calls an attribute a segment.
 *
 * Not evented and not ledgered, for the same reason `list_views` is not: a segment is
 * how someone looks at the book, never a change to it.
 */
export class SegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentError";
  }
}

/** A name already taken on this business — a 409, not a 400. */
export class SegmentNameTakenError extends SegmentError {
  constructor(name: string) {
    super(`This business already has a segment called '${name}'`);
    this.name = "SegmentNameTakenError";
  }
}

/**
 * The predicate asks for something the stored data cannot express.
 *
 * Its own class because the message is the product: it names the attribute and says
 * WHY, so the answer is a next step. The alternative — answering it slowly by
 * reconstructing the book per segment on every read — is what § 4c refused, and it is
 * slowest on exactly the book big enough to need segmenting.
 */
export class SegmentRefusedError extends SegmentError {
  constructor(message: string) {
    super(message);
    this.name = "SegmentRefusedError";
  }
}

export type CustomerSegmentRow = typeof customerSegments.$inferSelect;

export const MAX_FILTERS_PER_SEGMENT = 25;
const MAX_NAME_LENGTH = 60;

/** A starter or a stored segment, in the one shape the API and the screen speak. */
export interface Segment {
  publicId: string;
  name: string;
  description: string | null;
  filters: CustomerSegmentFilter[];
  /** Starters are read-only: no rename, no edit, no delete. Duplicate one instead. */
  isStarter: boolean;
  starterKey: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export function serializeSegment(s: Segment) {
  return {
    object: "customer_segment",
    id: s.publicId,
    name: s.name,
    description: s.description,
    filters: s.filters,
    is_starter: s.isStarter,
    starter_key: s.starterKey,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

const fromRow = (r: CustomerSegmentRow): Segment => ({
  publicId: r.publicId,
  name: r.name,
  description: r.description,
  filters: r.filters,
  isStarter: false,
  starterKey: r.starterKey,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const STARTER_SEGMENT_LIST: Segment[] = STARTER_SEGMENTS.map((s) => ({
  publicId: starterPublicId(s.key),
  name: s.name,
  description: s.description,
  filters: s.filters,
  isStarter: true,
  starterKey: s.key,
  createdAt: null,
  updatedAt: null,
}));

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Check a filter set against the CUSTOMER LIST's own allow-list, field by field and
 * value by value.
 *
 * The maps are `CUSTOMER_FILTER_OPS` / `CUSTOMER_FILTER_KINDS` — the same ones the
 * list route validates a request against and `list-views/entities.ts` validates a
 * saved view against. Reusing them is what makes a stored segment unable to hold a
 * predicate the list would later refuse; a hand-kept second copy would drift, and the
 * drift would surface as a segment that 400s months after it was saved.
 *
 * The business's `cf_*` custom fields are merged over them, exactly as the route does,
 * so a segment over a merchant-defined field is as first-class as one over `country`.
 */
export async function validateSegmentFilters(
  organizationId: string,
  businessId: string,
  filters: CustomerSegmentFilter[],
): Promise<void> {
  if (filters.length === 0) {
    throw new SegmentError(
      "A segment needs at least one filter. An empty segment is the same as 'all customers', " +
        "and the list already has an entry for that.",
    );
  }
  if (filters.length > MAX_FILTERS_PER_SEGMENT) {
    throw new SegmentError(`A segment may hold at most ${MAX_FILTERS_PER_SEGMENT} filters.`);
  }

  const defs = await filterDefinitions(organizationId, businessId, "customer");
  const cf = customerCustomFieldFilterSet(defs);
  const ops = { ...CUSTOMER_FILTER_OPS, ...cf.ops };
  const kinds = { ...CUSTOMER_FILTER_KINDS, ...cf.kinds };

  for (const f of filters) {
    const allowed = Object.hasOwn(ops, f.field) ? ops[f.field] : undefined;
    if (!allowed) throw new SegmentRefusedError(refusalFor(f.field, Object.keys(ops)));
    if (!allowed.includes(f.op)) {
      throw new SegmentError(
        `Operator '${f.op}' is not supported on '${f.field}'. Supported: ${allowed.join(", ")}.`,
      );
    }
    const kind = kinds[f.field];
    const problem = kind ? filterValueError(kind, f.op, f.value) : null;
    if (problem) throw new SegmentError(`Invalid value for '${f.field}[${f.op}]': ${problem}`);
  }

  await assertMrrAnswerable(organizationId, businessId, filters);
}

/**
 * A segment filtering on MRR must resolve to ONE currency.
 *
 * `subscriptions.mrr` is minor units of each subscription's own currency, so a
 * threshold over a mixed book compares 250 USD against 250 INR and calls the answer a
 * population. The rule is OURS and it is stated rather than worked around: pin a
 * currency, or the segment is refused by name.
 *
 * A single-currency book needs no `currency` filter — there is nothing to disambiguate
 * — which is what keeps "High MRR" usable out of the box on the common case. The check
 * reads the currencies the LIVE subscriptions actually carry, not the ones the catalog
 * could price in: a business configured for three and selling in one is single-currency
 * for this purpose.
 */
/**
 * An `mrr` threshold is answerable when every currency the book holds converts into its default
 * one — the same rule the customer list applies (`mrrFilterRefusal`), so a segment the list
 * could not show is never saved or charted.
 */
async function assertMrrAnswerable(
  organizationId: string,
  businessId: string,
  filters: CustomerSegmentFilter[],
): Promise<void> {
  if (!filters.some((f) => f.field === "mrr")) return;
  const book = await withTenant(organizationId, (tx) => mrrFilterBook(tx, businessId));
  const refusal = mrrFilterRefusal(filters, book);
  if (refusal) throw new SegmentRefusedError(refusal);
}

/**
 * Why each segment cannot be resolved on this business, or null when it can — so a picker can
 * disable a dead end with its reason. One read of the book for the whole list.
 */
export async function segmentRefusals(
  organizationId: string,
  businessId: string,
  segments: Segment[],
): Promise<Map<string, string | null>> {
  const book = segments.some((s) => s.filters.some((f) => f.field === "mrr"))
    ? await withTenant(organizationId, (tx) => mrrFilterBook(tx, businessId))
    : null;
  return new Map(
    segments.map((s) => [s.publicId, book ? mrrFilterRefusal(s.filters, book) : null]),
  );
}

/** The currencies this business's live subscriptions actually carry. */
export async function liveCurrencies(
  organizationId: string,
  businessId: string,
): Promise<string[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .selectDistinct({ currency: subscriptions.currency })
      .from(subscriptions)
      .innerJoin(customers, eq(customers.id, subscriptions.customerId))
      .where(
        and(
          eq(customers.businessId, businessId),
          sql`${subscriptions.status} IN ('active', 'in_trial')`,
        ),
      ),
  );
  return rows.map((r) => r.currency).filter((c): c is string => !!c);
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new SegmentError("A segment needs a name.");
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new SegmentError(`A segment name may be at most ${MAX_NAME_LENGTH} characters.`);
  }
  // A starter's name is taken: two entries reading "Active customers" in one rail, with
  // different definitions, is the exact confusion segments exist to remove.
  if (STARTER_SEGMENTS.some((s) => s.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new SegmentNameTakenError(trimmed);
  }
  return trimmed;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Every segment on one business: the starter library first, then what was saved.
 *
 * Not paginated. A business accumulates a handful of segments, and the rail renders
 * all of them; if that stops being true this moves to the shared cursor helper.
 */
export async function listSegments(organizationId: string, businessId: string): Promise<Segment[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(customerSegments)
      .where(
        and(
          eq(customerSegments.organizationId, organizationId),
          eq(customerSegments.businessId, businessId),
        ),
      )
      .orderBy(asc(sql`lower(${customerSegments.name})`)),
  );
  return [...STARTER_SEGMENT_LIST, ...rows.map(fromRow)];
}

/** One segment by public id — a starter, or a stored row. `null` if neither. */
export async function getSegment(
  organizationId: string,
  businessId: string,
  id: string,
): Promise<Segment | null> {
  const starter = STARTER_BY_PUBLIC_ID.get(id);
  if (starter) return STARTER_SEGMENT_LIST.find((s) => s.starterKey === starter.key) ?? null;
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(customerSegments)
      .where(
        and(
          eq(customerSegments.organizationId, organizationId),
          eq(customerSegments.businessId, businessId),
          eq(customerSegments.publicId, id),
        ),
      )
      .limit(1),
  );
  return row ? fromRow(row) : null;
}

/**
 * The population a filter set names: one page of it, its exact size, and what it earns.
 *
 * Both figures come from the SAME conditions (`customerSegmentTotals` and
 * `listCustomersPage` share `customerFilterConditions`), so the summary can never
 * disagree with the rows beneath it — a screen that sums the page it happened to load
 * and calls it the book is quietly wrong on any business with a fifty-first customer.
 *
 * MRR comes back BY CURRENCY, always. The caller prints one figure only when there is
 * one currency to print.
 */
export async function resolveSegment(
  organizationId: string,
  businessId: string,
  filters: CustomerSegmentFilter[],
  page: { limit?: number; startingAfter?: string; sortField?: string; sortDesc?: boolean } = {},
) {
  // Re-checked on every read, not only on save. A book that was single-currency when
  // the segment was written can stop being one, and the honest answer then is the
  // refusal rather than a threshold silently comparing amounts that are not
  // comparable. Costs one distinct-currency query, and only when `mrr` is in play.
  await assertMrrAnswerable(organizationId, businessId, filters);
  const defs = await filterDefinitions(organizationId, businessId, "customer");
  const listArgs = { filters, customFieldDefs: defs };
  // `o:0` is the list's own offset-0 cursor: the same first page, minus the list's
  // count — `segmentTotals` already counts the population, and counting it twice was
  // a second full pass over the book.
  const [rows, totals] = await Promise.all([
    listCustomersPage(organizationId, businessId, {
      ...listArgs,
      ...page,
      startingAfter: page.startingAfter ?? "o:0",
    }),
    segmentTotals(organizationId, businessId, listArgs),
  ]);
  if (!page.startingAfter) rows.total = totals.customers;
  return { rows, totals };
}

/**
 * The population's size and its MRR by currency, off ONE evaluation of its filters.
 *
 * The population is materialized once and both figures read it; correlated per-customer
 * counts make each evaluation a pass over every customer. `jit = off` because at book
 * scale compiling the plan costs as much as running it.
 */
async function segmentTotals(
  organizationId: string,
  businessId: string,
  args: {
    filters: CustomerSegmentFilter[];
    customFieldDefs: Awaited<ReturnType<typeof filterDefinitions>>;
  },
): Promise<{ customers: number; mrrByCurrency: Record<string, number> }> {
  return withTenant(organizationId, async (tx) => {
    await tx.execute(sql`set local jit = off`);
    const pop = await customerPopulationSql(tx, businessId, args);
    const rows = (await tx.execute(sql`
      with pop as materialized (${pop})
      select 'n' as kind, null::text as currency, count(*)::text as v from pop
      union all
      select 'm', ${subscriptions.currency}, coalesce(sum(${subscriptions.mrr}), 0)::text
      from ${subscriptions}
      where ${subscriptions.customerId} in (select id from pop)
        and ${subscriptions.status} in ('active', 'in_trial')
      group by ${subscriptions.currency}`)) as unknown as Array<{
      kind: "n" | "m";
      currency: string | null;
      v: string;
    }>;
    let customers = 0;
    const mrrByCurrency: Record<string, number> = {};
    for (const r of rows) {
      if (r.kind === "n") customers = Number(r.v);
      // Integer minor units: `sum()` over bigint arrives as text, never a float.
      else if (r.currency) mrrByCurrency[r.currency] = Number(r.v);
    }
    return { customers, mrrByCurrency };
  });
}

/**
 * What a saved segment means as a population: its filters, ready for
 * `customerPopulationSql`. The same checks `resolveSegment` makes, so a segment that cannot be
 * listed cannot be charted either.
 */
export async function segmentPopulation(
  organizationId: string,
  businessId: string,
  id: string,
): Promise<{
  segment: Segment;
  filters: CustomerSegmentFilter[];
  customFieldDefs: Awaited<ReturnType<typeof filterDefinitions>>;
}> {
  const segment = await getSegment(organizationId, businessId, id);
  if (!segment) throw new SegmentError(`There is no segment ${id} on this business.`);
  await assertMrrAnswerable(organizationId, businessId, segment.filters);
  const customFieldDefs = await filterDefinitions(organizationId, businessId, "customer");
  return { segment, filters: segment.filters, customFieldDefs };
}

/**
 * Per-customer facts the segment table renders: how many subscriptions in each API
 * status, and what they earn.
 *
 * ONE grouped query for the whole page, zipped on by the route — the same shape
 * `getCurrencyWeightsForCustomers` uses on the customers list, and for the same
 * reason: resolving this per row would be an N+1 that grows with the page size.
 *
 * Statuses are grouped by `apiStatusSql`, not by the stored column, so the chip on a
 * row says what the subscriptions list says. `non_renewing` is derived at the API
 * boundary and the stored column never holds it.
 *
 * ⚠️ MRR is a map, for the same reason the segment summary is: a customer holding a
 * USD and an INR subscription has two figures, not one.
 */
export interface SegmentCustomerFacts {
  statuses: Record<string, number>;
  mrr: Record<string, number>;
  /** The customer's last one-time order (ISO), or null. */
  last_order_at: string | null;
}

export async function loadSegmentCustomerFacts(
  organizationId: string,
  customerIds: string[],
): Promise<Record<string, SegmentCustomerFacts>> {
  if (customerIds.length === 0) return {};
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        customerId: subscriptions.customerId,
        status: sql<string>`${apiStatusSql}`,
        currency: subscriptions.currency,
        n: sql<number>`count(*)::int`,
        mrr: sql<string>`coalesce(sum(${subscriptions.mrr}), 0)::text`,
      })
      .from(subscriptions)
      .where(inArray(subscriptions.customerId, customerIds))
      .groupBy(subscriptions.customerId, sql`${apiStatusSql}`, subscriptions.currency),
  );
  // The last one-time order, for a buyer the subscription columns say nothing about.
  const orders = (await withTenant(organizationId, (tx) =>
    tx.execute(sql`select i.customer_id::text as customer, max(i.created_at) as at
      from invoices i
      where i.customer_id = any(${`{${customerIds.join(",")}}`}::uuid[]) and ${isOrder()}
      group by 1`),
  )) as unknown as Array<{ customer: string; at: string | Date }>;
  const out: Record<string, SegmentCustomerFacts> = {};
  const facts = (id: string) => (out[id] ??= { statuses: {}, mrr: {}, last_order_at: null });
  for (const o of orders) facts(o.customer).last_order_at = new Date(o.at).toISOString();
  for (const r of rows) {
    const f = facts(r.customerId);
    f.statuses[r.status] = (f.statuses[r.status] ?? 0) + r.n;
    // Only an EARNING status carries revenue; every other one holds 0 by design, and
    // adding those zeros under a currency key would invent a currency for a customer
    // whose only subscription is long cancelled.
    if ((r.status === "active" || r.status === "in_trial") && r.currency) {
      const v = Number(r.mrr);
      if (v !== 0) f.mrr[r.currency] = (f.mrr[r.currency] ?? 0) + v;
    }
  }
  return out;
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function createSegment(input: {
  organizationId: string;
  businessId: string;
  name: string;
  description?: string | null;
  filters: CustomerSegmentFilter[];
  starterKey?: string | null;
}): Promise<CustomerSegmentRow> {
  const name = checkName(input.name);
  await validateSegmentFilters(input.organizationId, input.businessId, input.filters);
  return withTenant(input.organizationId, async (tx) => {
    const existing = await tx
      .select({ id: customerSegments.id })
      .from(customerSegments)
      .where(
        and(
          eq(customerSegments.organizationId, input.organizationId),
          eq(customerSegments.businessId, input.businessId),
          sql`lower(${customerSegments.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    if (existing.length) throw new SegmentNameTakenError(name);
    const [row] = await tx
      .insert(customerSegments)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("seg"),
        name,
        description: input.description ?? null,
        filters: input.filters,
        starterKey: input.starterKey ?? null,
      })
      .returning();
    log.info("segment created", { segment: row!.publicId, filters: input.filters.length });
    return row!;
  });
}

export async function updateSegment(
  organizationId: string,
  businessId: string,
  id: string,
  patch: { name?: string; description?: string | null; filters?: CustomerSegmentFilter[] },
): Promise<CustomerSegmentRow | null> {
  if (STARTER_BY_PUBLIC_ID.has(id)) {
    throw new SegmentError(
      "A starter segment is read-only. Duplicate it to get a copy you can edit.",
    );
  }
  const name = patch.name != null ? checkName(patch.name) : undefined;
  if (patch.filters) await validateSegmentFilters(organizationId, businessId, patch.filters);
  return withTenant(organizationId, async (tx) => {
    const set: Partial<typeof customerSegments.$inferInsert> = { updatedAt: new Date() };
    if (name !== undefined) set.name = name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.filters !== undefined) set.filters = patch.filters;
    const [row] = await tx
      .update(customerSegments)
      .set(set)
      .where(
        and(
          eq(customerSegments.organizationId, organizationId),
          eq(customerSegments.businessId, businessId),
          eq(customerSegments.publicId, id),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function deleteSegment(
  organizationId: string,
  businessId: string,
  id: string,
): Promise<boolean> {
  if (STARTER_BY_PUBLIC_ID.has(id)) {
    throw new SegmentError("A starter segment cannot be deleted.");
  }
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .delete(customerSegments)
      .where(
        and(
          eq(customerSegments.organizationId, organizationId),
          eq(customerSegments.businessId, businessId),
          eq(customerSegments.publicId, id),
        ),
      )
      .returning({ id: customerSegments.id }),
  );
  return rows.length > 0;
}
