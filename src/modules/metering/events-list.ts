import { and, eq, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { customers, meters } from "@db/schema";
import { parseJsonExact, propertyText } from "./json-source";
import { serializeUsageEvent, storedEventColumns, type StoredEventRow } from "./ingest";
import { DECIMAL_TEXT_RE, countsTowardMeter, iso, rowsOf, uuidFloor } from "./usage-sql";
import { toMeterShape, type Meter } from "./meters";

export interface UsageEventFilters {
  customer?: string;
  customerKey?: string;
  meter?: string;
  key?: string;
  status?: "matched" | "unmatched" | "voided";
  timestampGte?: Date;
  timestampLt?: Date;
  receivedGte?: Date;
  receivedLt?: Date;
}

const decimalRe = new RegExp(DECIMAL_TEXT_RE);

/** The meters an event counts toward (the same rule as the SQL in usage-sql.ts). */
export function metersCounting(
  ev: { event_name: string; properties: Record<string, unknown> },
  list: Meter[],
): string[] {
  return list
    .filter((m) => {
      if (m.eventName !== ev.event_name) return false;
      for (const [p, values] of Object.entries(m.filters ?? {})) {
        const t = propertyText(ev.properties[p]);
        if (t === null || !values.some((v) => String(v) === t)) return false;
      }
      if (m.aggregation === "unique")
        return propertyText(ev.properties[m.uniqueProperty ?? ""]) !== null;
      if (m.aggregation === "count") return true;
      const v = propertyText(ev.properties[m.valueProperty ?? ""]);
      return v !== null && decimalRe.test(v);
    })
    .map((m) => m.key);
}

const encodeCursor = (id: string) => Buffer.from(id, "utf8").toString("base64url");
const decodeCursor = (c: string) => {
  const id = Buffer.from(c, "base64url").toString("utf8");
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
};

/** One page of a business's usage events, newest received first. `total` on the first page. */
export async function listUsageEvents(input: {
  organizationId: string;
  businessId: string;
  filters: UsageEventFilters;
  limit: number;
  startingAfter?: string;
}) {
  return withTenant(input.organizationId, async (tx) => {
    const f = input.filters;
    const all = await tx.select().from(meters).where(eq(meters.businessId, input.businessId));
    const where: SQL[] = [sql`e.business_id = ${input.businessId}`];
    if (f.customer) {
      const [c] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.businessId, input.businessId), eq(customers.publicId, f.customer)))
        .limit(1);
      if (!c) return { data: [], hasMore: false, nextCursor: null, total: 0 };
      where.push(sql`e.customer_id = ${c.id}`);
    }
    if (f.meter) {
      const m = all.find((x) => x.key === f.meter);
      if (!m) return { data: [], hasMore: false, nextCursor: null, total: 0 };
      where.push(countsTowardMeter("e", toMeterShape(m)));
    }
    if (f.customerKey) where.push(sql`e.customer_key = ${f.customerKey}`);
    if (f.key) where.push(sql`e.key = ${f.key}`);
    if (f.status === "voided") where.push(sql`e.voided_at is not null`);
    if (f.status === "matched") where.push(sql`e.voided_at is null and e.customer_id is not null`);
    if (f.status === "unmatched") where.push(sql`e.voided_at is null and e.customer_id is null`);
    if (f.timestampGte) where.push(sql`e."timestamp" >= ${iso(f.timestampGte)}::timestamptz`);
    if (f.timestampLt) where.push(sql`e."timestamp" < ${iso(f.timestampLt)}::timestamptz`);
    if (f.receivedGte) where.push(sql`e.id >= ${uuidFloor(f.receivedGte.getTime())}::uuid`);
    if (f.receivedLt) where.push(sql`e.id < ${uuidFloor(f.receivedLt.getTime())}::uuid`);
    const base = sql.join(where, sql` and `);
    const after = input.startingAfter ? decodeCursor(input.startingAfter) : null;
    const rows = rowsOf<StoredEventRow>(
      await tx.execute(sql`
        select ${storedEventColumns} from usage_events e
        left join customers c on c.id = e.customer_id
        where ${base} ${after ? sql`and e.id < ${after}::uuid` : sql``}
        order by e.id desc limit ${input.limit + 1}`),
    );
    let total: number | null = null;
    if (!input.startingAfter) {
      const [t] = rowsOf<{ n: number }>(
        await tx.execute(sql`select count(*)::int as n from usage_events e where ${base}`),
      );
      total = t?.n ?? 0;
    }
    const page = rows.slice(0, input.limit);
    const names = new Set(all.map((m) => m.eventName));
    const data = page.map((r) => {
      const counted = metersCounting(
        {
          event_name: r.event_name,
          properties: parseJsonExact(r.properties_text) as Record<string, unknown>,
        },
        all,
      );
      return serializeUsageEvent(r, {
        meters: counted,
        flags: names.has(r.event_name) ? [] : ["no_meter"],
      });
    });
    const hasMore = rows.length > input.limit;
    return {
      data,
      hasMore,
      nextCursor: hasMore ? encodeCursor(page.at(-1)!.id) : null,
      total,
    };
  });
}
