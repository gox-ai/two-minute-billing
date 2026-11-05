import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { pgTextArray, rowsOf } from "./usage-sql";

const log = createLogger("metering.partitions");

export type PartitionedTable = "usage_events" | "usage_rollups";

/** First day of the UTC month holding `d`. */
export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** `usage_events_y2026m11`: the name `usage_create_partition` gives a month. */
export function partitionName(table: PartitionedTable, month: Date): string {
  const m = monthStart(month);
  return `${table}_y${m.getUTCFullYear()}m${String(m.getUTCMonth() + 1).padStart(2, "0")}`;
}

const isoDate = (d: Date) => monthStart(d).toISOString().slice(0, 10);

/** Partitions this process knows exist. A dropped partition is removed from it. */
const known = new Set<string>();

/**
 * Make sure the month's partition exists. Event timestamps follow the business clock (time
 * travel), so ingest cannot rely on the daily cron alone. Cached per process; the create is
 * idempotent, so two processes racing is harmless. Runs outside any tenant transaction:
 * adding a partition locks the parent, and that lock must not be held for a request.
 */
export async function ensurePartition(table: PartitionedTable, month: Date): Promise<void> {
  const name = partitionName(table, month);
  if (known.has(name)) return;
  const [found] = rowsOf<{ r: string | null }>(
    await systemDb.execute(sql`select to_regclass(${`public.${name}`})::text as r`),
  );
  if (!found?.r) {
    await systemDb.execute(
      sql`select public.usage_create_partition(${table}, ${isoDate(month)}::date)`,
    );
    log.info("usage partition created", { event: "usage_partition_created", partition: name });
  }
  known.add(name);
}

/** Both tables for one month: the fold writes rollups for every month that has events. */
export async function ensureUsageMonth(month: Date): Promise<void> {
  await ensurePartition("usage_events", month);
  await ensurePartition("usage_rollups", month);
}

/** Every existing monthly partition of a table, oldest first. */
export async function listPartitions(
  table: PartitionedTable,
): Promise<Array<{ name: string; month: Date }>> {
  const rows = rowsOf<{ name: string }>(
    await systemDb.execute(sql`
      select c.relname as name from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
      where p.relname = ${table} and p.relnamespace = 'public'::regnamespace
      order by c.relname`),
  );
  const re = new RegExp(`^${table}_y(\\d{4})m(\\d{2})$`);
  return rows.flatMap((r) => {
    const m = re.exec(r.name);
    return m ? [{ name: r.name, month: new Date(Date.UTC(+m[1]!, +m[2]! - 1, 1)) }] : [];
  });
}

/** Detach and drop one month. Callers archive event partitions first. */
export async function dropPartition(table: PartitionedTable, month: Date): Promise<string | null> {
  const [row] = rowsOf<{ dropped: string | null }>(
    await systemDb.execute(
      sql`select public.usage_drop_partition(${table}, ${isoDate(month)}::date) as dropped`,
    ),
  );
  known.delete(partitionName(table, month));
  return row?.dropped ?? null;
}

/** How many months ahead the daily cron keeps. */
export const MONTHS_AHEAD = 2;

/** The daily cron's create step: this month and the next two, for both tables. */
export async function createUpcomingPartitions(now: Date = new Date()): Promise<void> {
  for (let i = 0; i <= MONTHS_AHEAD; i++) await ensureUsageMonth(addMonths(now, i));
}

export class MissingUsagePartitionError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Usage partitions are missing: ${missing.join(", ")}. Run the database migrations, or ` +
        `run the usage_partitions job, before starting this process.`,
    );
    this.name = "MissingUsagePartitionError";
  }
}

/** Boot check: the current and the next month must exist for both tables. Fails loud. */
export async function requireUsagePartitions(now: Date = new Date()): Promise<void> {
  const want = [0, 1].flatMap((i) =>
    (["usage_events", "usage_rollups"] as const).map((t) => partitionName(t, addMonths(now, i))),
  );
  const rows = rowsOf<{ name: string }>(
    await systemDb.execute(sql`
      select relname as name from pg_class
      where relnamespace = 'public'::regnamespace and relname = any(${pgTextArray(want)}::text[])`),
  );
  const have = new Set(rows.map((r) => r.name));
  const missing = want.filter((n) => !have.has(n));
  if (missing.length) throw new MissingUsagePartitionError(missing);
}
