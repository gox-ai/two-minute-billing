/**
 * The daily sweep: bell rows and built summaries live 90 days; queue rows that are done and
 * deliveries that settled live 30 days (their dedupe keys outlast every clock window). Closed
 * groups go after a day.
 */
import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { rowsOf } from "@/modules/metering/usage-sql";

const BATCH = 5000;

async function sweep(table: string, where: ReturnType<typeof sql>): Promise<number> {
  let total = 0;
  for (;;) {
    const r = rowsOf<{ n: number }>(
      await systemDb.execute(sql`
        with gone as (
          delete from ${sql.raw(table)} where id in (
            select id from ${sql.raw(table)} where ${where} limit ${BATCH})
          returning 1)
        select count(*)::int as n from gone`),
    );
    const n = r[0]?.n ?? 0;
    total += n;
    if (n < BATCH) return total;
  }
}

export async function sweepNotifications(now = new Date()) {
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  return {
    notifications: await sweep("notifications", sql`created_at < ${days(90)}::timestamptz`),
    digests: await sweep("notification_digests", sql`built_at < ${days(90)}::timestamptz`),
    queue: await sweep(
      "notification_queue",
      sql`status in ('done', 'failed') and created_at < ${days(30)}::timestamptz`,
    ),
    deliveries: await sweep(
      "notification_deliveries",
      sql`status in ('sent', 'skipped', 'failed') and created_at < ${days(30)}::timestamptz`,
    ),
    groups: await sweep("notification_groups", sql`closed_at < ${days(1)}::timestamptz`),
  };
}
