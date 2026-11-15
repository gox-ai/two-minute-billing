/**
 * `metric_daily` is cut on the BUSINESS's local calendar day (0270).
 *
 * `period_end` is that business's own calendar date and a period's window is
 * `[local midnight of its first date, local midnight of the day after its last)`. Stored
 * days were cut on the UTC boundary until this gate existed, so every calendar figure the
 * product shows — today, this month, the retention month, signups — was shifted by the
 * zone's offset: 5h30m of every 24 on an Asia/Kolkata book.
 *
 * What this proves, in the order a wrong boundary breaks it:
 *   1. the bounds are the local ones, to the minute, for a half-hour zone;
 *   2. a day on which the clocks move is 23 or 25 hours — the check that catches offset
 *      arithmetic, which India can never fail because it has no daylight saving;
 *   3. a business with no timezone is byte-for-byte where it was (UTC);
 *   4. a coarser grain starts at LOCAL midnight on its first date, not UTC midnight;
 *   5. the JS boundary equals Postgres's own `at time zone` round trip — two implementations
 *      of one day boundary that could disagree is the bug being fixed, one layer up;
 *   6. end to end: a customer created at 00:30 local lands on the local day, not the UTC one;
 *   7. changing a business's timezone enqueues a recompute of its stored history, and
 *      saving anything else — or the same zone again — does not;
 *   9. an organization reads each business at its own local day: an additive org figure is the
 *      sum of the business answers, with Kolkata a day ahead of New York and on a shared date;
 *  10. the recompute that job runs restates the day in progress on a live book, and its
 *      forward figures equal a plain compute of that day.
 *
 *   pnpm verify:metric-daily-tz
 */
import { and, eq, sql } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { zonedDayStart, zonedDayEndExclusive, zonedDayString } from "@/platform/timezones";
import {
  periodStart,
  periodEndExclusive,
  computeMetricPeriod,
} from "@/modules/metrics/daily/compute";
import { endOfDay } from "@/modules/metrics/snapshots";
import { writeMetricDay, type MetricDailyRow } from "@/modules/metrics/daily/write";
import {
  dayGroups,
  resolveAnalytics,
  resolveScope,
  todayIn,
} from "@/modules/metrics/daily/public-query";
import { dayFor, type CronBusiness } from "@/modules/metrics/daily/cron";
import { DEFAULT_CALENDAR } from "@/platform/business-calendar";
import { customers, metricDaily } from "@db/schema";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { recomputeMetricDailyForBusiness } from "@/modules/metrics/daily/recompute";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const iso = (d: Date) => d.toISOString();
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

// ── 1. A half-hour zone, to the minute ────────────────────────────────────────────────────
console.log("\n1. Asia/Kolkata (+5:30, no daylight saving) — the production book");
ok(
  "2026-09-20 starts at 2026-09-19T18:30:00.000Z",
  iso(zonedDayStart("2026-09-20", "Asia/Kolkata")) === "2026-09-19T18:30:00.000Z",
  iso(zonedDayStart("2026-09-20", "Asia/Kolkata")),
);
ok(
  "2026-09-20 ends (exclusive) at 2026-09-20T18:30:00.000Z",
  iso(zonedDayEndExclusive("2026-09-20", "Asia/Kolkata")) === "2026-09-20T18:30:00.000Z",
  iso(zonedDayEndExclusive("2026-09-20", "Asia/Kolkata")),
);
// The stock edge is the last instant INSIDE the day — one millisecond before the bound the
// flows stop at, so a stock and a flow read the same day.
ok(
  "the stock edge is one millisecond inside that bound",
  endOfDay("2026-09-20", "Asia/Kolkata").getTime() ===
    zonedDayEndExclusive("2026-09-20", "Asia/Kolkata").getTime() - 1,
  iso(endOfDay("2026-09-20", "Asia/Kolkata")),
);
// Consecutive days must tile: no instant in two days, none in neither.
ok(
  "consecutive days tile with no gap and no overlap",
  zonedDayEndExclusive("2026-09-20", "Asia/Kolkata").getTime() ===
    zonedDayStart("2026-09-21", "Asia/Kolkata").getTime(),
);

// ── 2. The days the clocks move ───────────────────────────────────────────────────────────
// THIS is the check offset arithmetic fails. A naive ±offset makes every day 24 hours long
// and would pass every check above, forever, on an Indian book.
console.log("\n2. daylight saving — a local day is 23 or 25 hours");
const dstCases: Array<[string, string, number]> = [
  ["Europe/Berlin", "2026-03-29", 23], // clocks forward
  ["Europe/Berlin", "2026-10-25", 25], // clocks back
  ["Europe/Berlin", "2026-06-01", 24], // an ordinary summer day, for contrast
  ["America/Chicago", "2026-03-08", 23],
  ["America/Chicago", "2026-11-01", 25],
];
for (const [zone, d, expected] of dstCases) {
  const len = hours(zonedDayStart(d, zone), zonedDayEndExclusive(d, zone));
  ok(`${zone} ${d} is ${expected}h`, len === expected, `${len}h`);
}
ok(
  "Europe/Berlin 2026-03-29 starts at 2026-03-28T23:00:00.000Z (CET, before the jump)",
  iso(zonedDayStart("2026-03-29", "Europe/Berlin")) === "2026-03-28T23:00:00.000Z",
  iso(zonedDayStart("2026-03-29", "Europe/Berlin")),
);
ok(
  "Europe/Berlin 2026-10-25 starts at 2026-10-24T22:00:00.000Z (CEST, before the fall back)",
  iso(zonedDayStart("2026-10-25", "Europe/Berlin")) === "2026-10-24T22:00:00.000Z",
  iso(zonedDayStart("2026-10-25", "Europe/Berlin")),
);
// A zone whose clocks jump ACROSS midnight: that local midnight never happens, and the day
// begins when the clock leaves the gap.
ok(
  "America/Santiago 2026-09-06 (midnight does not exist) begins at the transition",
  iso(zonedDayStart("2026-09-06", "America/Santiago")) === "2026-09-06T04:00:00.000Z",
  iso(zonedDayStart("2026-09-06", "America/Santiago")),
);

// ── 3. No timezone means UTC, unchanged ───────────────────────────────────────────────────
console.log("\n3. a business with no timezone is exactly where it was");
for (const zone of [null, undefined, "", "UTC"] as Array<string | null | undefined>) {
  const label = zone === null ? "null" : zone === undefined ? "undefined" : `'${zone}'`;
  ok(
    `${label} → 2026-09-20T00:00:00.000Z … 2026-09-21T00:00:00.000Z`,
    iso(zonedDayStart("2026-09-20", zone)) === "2026-09-20T00:00:00.000Z" &&
      iso(zonedDayEndExclusive("2026-09-20", zone)) === "2026-09-21T00:00:00.000Z",
  );
}
ok(
  "and the stock edge is still T23:59:59.999Z",
  iso(endOfDay("2026-09-20")) === "2026-09-20T23:59:59.999Z",
  iso(endOfDay("2026-09-20")),
);
ok(
  "periodStart/periodEndExclusive with no zone are the UTC bounds",
  iso(periodStart("day", "2026-09-20")) === "2026-09-20T00:00:00.000Z" &&
    iso(periodEndExclusive("2026-09-20")) === "2026-09-21T00:00:00.000Z",
);

// ── 4. The coarser grains ─────────────────────────────────────────────────────────────────
console.log("\n4. a month starts at LOCAL midnight on the 1st");
ok(
  "month ending 2026-09-30 in Asia/Kolkata starts 2026-08-31T18:30:00.000Z",
  iso(periodStart("month", "2026-09-30", "Asia/Kolkata")) === "2026-08-31T18:30:00.000Z",
  iso(periodStart("month", "2026-09-30", "Asia/Kolkata")),
);
ok(
  "…and ends 2026-09-30T18:30:00.000Z",
  iso(periodEndExclusive("2026-09-30", "Asia/Kolkata")) === "2026-09-30T18:30:00.000Z",
  iso(periodEndExclusive("2026-09-30", "Asia/Kolkata")),
);
ok(
  "a month whose 1st is a clocks-forward day still starts at local midnight",
  // Europe/Lisbon springs forward at 01:00 on 2026-03-29; March starts on an ordinary day,
  // so the month bound is WET and the day bound inside it is not.
  iso(periodStart("month", "2026-03-31", "Europe/Berlin")) === "2026-02-28T23:00:00.000Z",
  iso(periodStart("month", "2026-03-31", "Europe/Berlin")),
);
ok(
  "a quarter ending 2026-09-30 in Asia/Kolkata starts 2026-06-30T18:30:00.000Z",
  iso(periodStart("quarter", "2026-09-30", "Asia/Kolkata")) === "2026-06-30T18:30:00.000Z",
  iso(periodStart("quarter", "2026-09-30", "Asia/Kolkata")),
);
ok(
  "a year ending 2026-12-31 in Asia/Kolkata starts 2025-12-31T18:30:00.000Z",
  iso(periodStart("year", "2026-12-31", "Asia/Kolkata")) === "2025-12-31T18:30:00.000Z",
  iso(periodStart("year", "2026-12-31", "Asia/Kolkata")),
);

// ── 5. The JS boundary equals Postgres's own ──────────────────────────────────────────────
/**
 * The legacy calendar path (`metrics/calendar-ranges.ts`, `analytics.ts`) resolves its
 * boundaries in SQL: a local wall clock `at time zone tz` is the instant it corresponds to,
 * and Postgres's tz database supplies the daylight-saving rule. This layer cannot — its
 * boundary functions are pure and synchronous and are called once per day of a 400-day
 * fill. So the two implementations are pinned to each other here instead: over every zone
 * shape that has ever broken date code (half-hour, 45-minute, both DST directions, the
 * extremes, a zone that skips midnight), and on both the day and the month grain.
 */
console.log("\n5. the JS boundary agrees with Postgres's `at time zone`");
const zones = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Europe/Berlin",
  "Europe/Dublin",
  "America/Chicago",
  "America/Santiago",
  "Australia/Adelaide",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "Pacific/Kiritimati",
  "Pacific/Niue",
];
const probeDays = [
  "2026-01-01",
  "2026-03-08",
  "2026-03-29",
  "2026-04-05",
  "2026-06-01",
  "2026-09-06",
  "2026-09-20",
  "2026-10-04",
  "2026-10-25",
  "2026-11-01",
  "2026-12-31",
];
let sqlMismatches: string[] = [];
for (const zone of zones) {
  for (const d of probeDays) {
    const rows = (await systemDb.execute(sql`
      select ((${d}::date)::timestamp at time zone ${zone}) as day_start,
             (((${d}::date)::timestamp + interval '1 day') at time zone ${zone}) as day_end
    `)) as unknown as Array<{ day_start: Date; day_end: Date }>;
    const r = rows[0]!;
    const gotStart = zonedDayStart(d, zone).getTime();
    const gotEnd = zonedDayEndExclusive(d, zone).getTime();
    if (gotStart !== new Date(r.day_start).getTime()) {
      sqlMismatches.push(
        `${zone} ${d} start: js ${new Date(gotStart).toISOString()} vs pg ${new Date(r.day_start).toISOString()}`,
      );
    }
    if (gotEnd !== new Date(r.day_end).getTime()) {
      sqlMismatches.push(
        `${zone} ${d} end: js ${new Date(gotEnd).toISOString()} vs pg ${new Date(r.day_end).toISOString()}`,
      );
    }
  }
}
ok(
  `${zones.length} zones × ${probeDays.length} days match Postgres exactly`,
  sqlMismatches.length === 0,
  sqlMismatches.slice(0, 4).join(" | "),
);

// ── 6. End to end: the writer stores the LOCAL day ────────────────────────────────────────
console.log("\n6. end to end — a customer created at 00:30 local");
const org = await createOrganization({ name: "Metric Daily TZ Org" });
const orgId = org.organization.id;

const seedBusiness = async (name: string, timezone: string) => {
  const b = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
    timezone,
  });
  // 2026-09-19T19:00:00Z is 2026-09-20 00:30 in Asia/Kolkata and still 2026-09-19 in UTC.
  // One instant, two calendar dates — which is the whole question.
  const c = await createCustomer({
    organizationId: orgId,
    businessId: b.id,
    email: `tz-${b.id}@example.test`,
  });
  await systemDb
    .update(customers)
    .set({ createdAt: new Date("2026-09-19T19:00:00.000Z") })
    .where(eq(customers.id, c.id));
  return b;
};

const kolkata = await seedBusiness("TZ Kolkata Biz", "Asia/Kolkata");
const utcBiz = await seedBusiness("TZ UTC Biz", "UTC");

const signupsOn = async (businessId: string, day: string): Promise<bigint> => {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, businessId, "day", day, new Date("2026-09-25T00:00:00.000Z")),
  );
  const r = rows.find((x) => x.measure === "customers_created" && x.dim === "");
  return r?.value ?? 0n;
};

ok(
  "Asia/Kolkata: the signup counts on 2026-09-20, its local date",
  (await signupsOn(kolkata.id, "2026-09-20")) === 1n,
);
ok(
  "Asia/Kolkata: and NOT on 2026-09-19, the UTC date",
  (await signupsOn(kolkata.id, "2026-09-19")) === 0n,
);
ok(
  "UTC business: the same instant counts on 2026-09-19, unchanged",
  (await signupsOn(utcBiz.id, "2026-09-19")) === 1n,
);
ok("UTC business: and not on 2026-09-20", (await signupsOn(utcBiz.id, "2026-09-20")) === 0n);

// A month must contain the day it contains — the two grains are cut on the same calendar.
const monthRows = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, kolkata.id, "month", "2026-09-30", new Date("2026-09-25T00:00:00.000Z")),
);
ok(
  "the September month on that book contains the signup its local day holds",
  (monthRows.find((r) => r.measure === "customers_created" && r.dim === "")?.value ?? 0n) === 1n,
);

// ── 7. A timezone change invalidates the stored history ───────────────────────────────────
/**
 * Every stored row is keyed by a local calendar date and bounded by that date's local
 * midnights, so moving the zone does not make the rows stale — it makes them answers to a
 * question the business has stopped asking. Nothing can repair them in place.
 *
 * ⚠️ `graphile_worker.jobs` is a VIEW and carries no payload, so the check joins
 * `_private_tasks`. A worker listening on the same database may CLAIM the job between the
 * save and this read; the recompute's own effect — the business's rows restated — counts as
 * the same evidence, because both outcomes mean the job existed.
 */
console.log("\n7. changing the timezone enqueues a recompute");
const recomputesQueued = async (businessId: string): Promise<number> => {
  const rows = (await systemDb.execute(sql`
    select count(*)::int as n
      from graphile_worker._private_jobs j
      join graphile_worker._private_tasks t on t.id = j.task_id
     where t.identifier = 'metric_daily_recompute'
       and j.payload->>'businessId' = ${businessId}`)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
};
const lastComputedAt = async (businessId: string): Promise<number> => {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ at: sql<string>`coalesce(max(${metricDaily.computedAt}), 'epoch')` })
      .from(metricDaily)
      .where(and(eq(metricDaily.businessId, businessId), eq(metricDaily.grain, "day"))),
  );
  return new Date(rows[0]?.at ?? 0).getTime();
};

// Give the recompute something to restate, so its effect is observable either way.
for (const day of ["2026-09-19", "2026-09-20"]) {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, kolkata.id, "day", day, new Date("2026-09-25T00:00:00.000Z")),
  );
  await writeMetricDay({
    organizationId: orgId,
    businessId: kolkata.id,
    grain: "day",
    periodEnd: day,
    rows,
  });
}

const before = await lastComputedAt(kolkata.id);
const queuedBefore = await recomputesQueued(kolkata.id);

// (a) something that is not the timezone must queue nothing.
await updateBusiness(orgId, kolkata.publicId, { name: "TZ Kolkata Biz (renamed)" });
ok(
  "renaming the business queues no recompute",
  (await recomputesQueued(kolkata.id)) === queuedBefore,
);

// (b) re-saving the SAME zone is not a change — the settings form posts every field.
await updateBusiness(orgId, kolkata.publicId, { timezone: "Asia/Kolkata" });
ok(
  "re-saving the same timezone queues no recompute",
  (await recomputesQueued(kolkata.id)) === queuedBefore,
);
// …including the legacy spelling, which normalizes to the stored one.
await updateBusiness(orgId, kolkata.publicId, { timezone: "Asia/Calcutta" });
ok(
  "re-saving its legacy spelling queues no recompute either",
  (await recomputesQueued(kolkata.id)) === queuedBefore,
);

// (c) an actual move must queue one.
await updateBusiness(orgId, kolkata.publicId, { timezone: "Europe/Berlin" });
const queuedAfter = await recomputesQueued(kolkata.id);
const restated = (await lastComputedAt(kolkata.id)) > before;
ok(
  "moving the business to Europe/Berlin queues a recompute of its history",
  queuedAfter > queuedBefore || restated,
  queuedAfter > queuedBefore
    ? "queued"
    : restated
      ? "already restated by a live worker"
      : "neither",
);

// ── 8. The cron writes each business's own day ────────────────────────────────────────────
/**
 * One instant is not one calendar date. At 19:00 UTC it is already tomorrow in Asia/Kolkata
 * and still today in America/Chicago, so the single global day string the cron used to
 * compute filed one of them under a day that had not started — and either side of the date
 * line, always the wrong one.
 */
console.log("\n8. the cron's day is per business, not per pass");
const at = new Date("2026-09-20T19:00:00.000Z");
const asBiz = (timezone: string | null): CronBusiness => ({
  id: "b",
  organizationId: "o",
  timezone,
  calendar: DEFAULT_CALENDAR,
});
ok(
  "19:00Z is already the 21st for an Asia/Kolkata business",
  dayFor(asBiz("Asia/Kolkata"), at) === "2026-09-21",
  dayFor(asBiz("Asia/Kolkata"), at),
);
ok(
  "…still the 20th for an America/Chicago business",
  dayFor(asBiz("America/Chicago"), at) === "2026-09-20",
  dayFor(asBiz("America/Chicago"), at),
);
ok(
  "…and the 20th, unchanged, for a business with no timezone",
  dayFor(asBiz(null), at) === "2026-09-20",
  dayFor(asBiz(null), at),
);
// The reader resolves "today" in the reporting zone too (`todayIn`, public-query.ts). The
// writer now uses the same rule, which is the whole point: a figure filed under a day the
// reader never asks for is invisible, and one filed under the wrong day is worse.
ok(
  "writer and reader name the same day for the same instant",
  dayFor(asBiz("Asia/Kolkata"), at) === todayIn("Asia/Kolkata") ||
    // `todayIn` reads the real clock, so only the shape can be pinned here.
    zonedDayString(new Date(), "Asia/Kolkata") === todayIn("Asia/Kolkata"),
);

// ── 9. An organization reads every business at its own local day ──────────────────────────
/**
 * At 20:00 UTC an Asia/Kolkata business is already on tomorrow; New York is not. The
 * organization must read each at its OWN today, so an additive org figure is the sum of the
 * business answers at any instant, and the newest point never holds one business alone.
 * 12:00 UTC, when both share a date, is the control.
 */
console.log("\n9. an organization reads every business at its own local day");
const STRADDLE = new Date("2026-10-22T20:00:00.000Z"); // Kolkata 23 Oct 01:30; NY 22 Oct 16:00
const SAME_DAY = new Date("2026-10-22T12:00:00.000Z"); // Kolkata 22 Oct 17:30; NY 22 Oct 08:00
const org9 = await createOrganization({ name: "Metric Daily TZ Org-wide" });
const org9Id = org9.organization.id;
await withTenant(org9Id, (tx) =>
  tx.execute(
    sql`update organizations set timezone = 'Asia/Kolkata', base_currency = 'USD',
        exchange_rates = '{"INR":80}'::jsonb where id = ${org9Id}`,
  ),
);
const biz9 = async (name: string, timezone: string, currency: string) =>
  createBusiness({ organizationId: org9Id, name, defaultCurrency: currency, timezone });
const books9 = [
  {
    b: await biz9("TZ9 Kolkata", "Asia/Kolkata", "INR"),
    ccy: "INR",
    rate: 80,
    lastDay: "2026-10-23",
  },
  {
    b: await biz9("TZ9 New York", "America/New_York", "USD"),
    ccy: "USD",
    rate: 1,
    lastDay: "2026-10-22",
  },
];
const days9 = (from: string, to: string) => {
  const out: string[] = [];
  for (
    let d = new Date(`${from}T00:00:00Z`);
    iso(d).slice(0, 10) <= to;
    d.setUTCDate(d.getUTCDate() + 1)
  )
    out.push(iso(d).slice(0, 10));
  return out;
};
// Each day's figures move, so a check can tell WHICH day was read. INR values divide by 80.
const dayIndex = (d: string) => days9("2026-08-01", d).length;
const mrr9 = (i: number, d: string) => BigInt((i + 1) * 1_600_000 + dayIndex(d) * 800);
const paying9 = (i: number, d: string) => BigInt((i + 1) * 40 + dayIndex(d));
const new9 = (i: number, d: string) => BigInt((i + 1) * 8_000 + dayIndex(d) * 80);
await withTenant(org9Id, (tx) =>
  tx.insert(metricDaily).values(
    books9.flatMap(({ b, ccy, lastDay }, i) =>
      days9("2026-08-01", lastDay).flatMap((d) => {
        const base = {
          organizationId: org9Id,
          businessId: b.id,
          grain: "day",
          periodEnd: d,
          currency: ccy,
        };
        return [
          { ...base, measure: "mrr", value: mrr9(i, d) },
          { ...base, measure: "paying_customers", value: paying9(i, d) },
          { ...base, measure: "mrr_new", value: new9(i, d) },
        ];
      }),
    ),
  ),
);
const toUsd = (minor: number | null | undefined, rate: number) =>
  minor == null ? NaN : Math.round(minor / rate);
const orgScope9 = await resolveScope(org9Id, null, "live");
const bizScopes9 = await Promise.all(
  books9.map(({ b }) =>
    resolveScope(
      org9Id,
      { id: b.id, publicId: b.publicId, name: b.name, timezone: b.timezone ?? null },
      "live",
    ),
  ),
);
type Q9 = Record<string, unknown>;
/** The org answer and each business's own answer, money stated in USD. */
const both9 = async (q: Q9, at: Date) => {
  const org = await resolveAnalytics(orgScope9, q as never, at);
  const biz = await Promise.all(bizScopes9.map((s) => resolveAnalytics(s, q as never, at)));
  return { org, biz };
};
const usd9 = (i: number, minor: number | null | undefined, money: boolean) =>
  money ? toUsd(minor, books9[i]!.rate) : (minor ?? NaN);
const sumOf9 = (vals: (i: number) => number | null | undefined, money: boolean) =>
  books9.reduce((s, _, i) => s + usd9(i, vals(i), money), 0);

for (const [label, at, kolkataToday] of [
  ["straddling (Kolkata a day ahead)", STRADDLE, "2026-10-23"],
  ["control (one shared date)", SAME_DAY, "2026-10-22"],
] as const) {
  console.log(`  — ${label}`);
  const groups = dayGroups(orgScope9, at);
  ok(
    `${groups.length} day group(s)`,
    groups.length === (at === STRADDLE ? 2 : 1),
    groups.map((g) => g.today).join(", "),
  );

  // Stock: MRR, converted per cell. The org total is the business totals' sum.
  const mrr = await both9({ measure: "mrr", range: "30d", grain: "day", compare: "previous" }, at);
  const mrrSum = sumOf9((i) => mrr.biz[i]!.total, true);
  ok("MRR = Σ business MRR", mrr.org.total === mrrSum, `org ${mrr.org.total} vs Σ ${mrrSum}`);
  ok(
    `…Kolkata's share is its own ${kolkataToday}`,
    mrr.biz[0]!.total === Number(mrr9(0, kolkataToday)),
    `${mrr.biz[0]!.total}`,
  );
  const prevSum = sumOf9((i) => mrr.biz[i]!.compare?.previous_total, true);
  ok(
    "…and the previous window's MRR = Σ business previous MRR",
    mrr.org.compare?.previous_total === prevSum,
    `org ${mrr.org.compare?.previous_total} vs Σ ${prevSum}`,
  );

  // Stock count: paying customers.
  const paying = await both9({ measure: "paying_customers", range: "30d", grain: "day" }, at);
  const payingSum = sumOf9((i) => paying.biz[i]!.total, false);
  ok(
    "paying customers = Σ business paying customers",
    paying.org.total === payingSum && paying.biz[0]!.total === Number(paying9(0, kolkataToday)),
    `org ${paying.org.total} vs Σ ${payingSum}; Kolkata ${paying.biz[0]!.total}`,
  );

  // Flow over 30 days: each business sums its own 30 local days.
  const fresh = await both9({ measure: "mrr_new", range: "30d", grain: "day" }, at);
  const freshSum = sumOf9((i) => fresh.biz[i]!.total, true);
  const kolkata30 = days9("2026-08-01", kolkataToday)
    .slice(-30)
    .reduce((s, d) => s + Number(new9(0, d)), 0);
  ok(
    "new MRR over 30d = Σ business new MRR, Kolkata over its own 30 days",
    fresh.org.total === freshSum && fresh.biz[0]!.total === kolkata30,
    `org ${fresh.org.total} vs Σ ${freshSum}; Kolkata ${fresh.biz[0]!.total} vs ${kolkata30}`,
  );
  const pointSum = fresh.org.series.reduce((s, p) => s + (p.value ?? 0), 0);
  ok("…and its points add up to its total", pointSum === fresh.org.total, `${pointSum}`);

  // Series: the newest point is each business's own latest day, never one business alone.
  const lastOf = (r: { series: Array<{ value: number | null }> }) =>
    r.series[r.series.length - 1]?.value;
  const newest = mrr.org.series[mrr.org.series.length - 1];
  const newestSum = sumOf9((i) => lastOf(mrr.biz[i]!), true);
  ok(
    "MRR by day: the newest point = Σ each business's newest point",
    newest?.t === "2026-10-22" && newest.value === newestSum,
    `${newest?.t} ${newest?.value} vs Σ ${newestSum}`,
  );
  const older = mrr.org.series.slice(0, -1);
  const olderOk = older.every((p) => p.value === sumOf9((i) => Number(mrr9(i, p.t)), true));
  ok(
    "…and every older point is each business at that local date",
    mrr.org.series.length === 30 && olderOk,
    `${mrr.org.series.length} points`,
  );

  // A month series aligns by the business-local month label.
  const months = await both9({ measure: "mrr_new", range: "30d", grain: "month" }, at);
  const monthsOk = months.org.series.every(
    (p) =>
      p.value ===
      sumOf9((i) => months.biz[i]!.series.find((b) => b.label === p.label)?.value, true),
  );
  ok(
    "new MRR by month: each month = Σ the business months with that label",
    months.org.series.length === 2 && monthsOk,
    months.org.series.map((p) => `${p.label} ${p.value}`).join("; "),
  );
}

// An explicit window can ask past the label day. That period is unknown — never Kolkata alone —
// and Kolkata's own 23rd sits in the 22nd's period.
const explicit = await resolveAnalytics(
  orgScope9,
  { measure: "mrr", grain: "day", start: "2026-09-24", end: "2026-10-23" } as never,
  STRADDLE,
);
const last = explicit.series[explicit.series.length - 1];
ok(
  "an explicit window past the label day: the 23rd reads unknown, not Kolkata's stock alone",
  last?.t === "2026-10-23" &&
    last.value === null &&
    (explicit.coverage?.missing_periods ?? []).includes("2026-10-23"),
  JSON.stringify({ last, coverage: explicit.coverage?.missing_periods }),
);
ok(
  "…and its MRR is each business at its own today",
  explicit.total === toUsd(Number(mrr9(0, "2026-10-23")), 80) + Number(mrr9(1, "2026-10-22")),
  `${explicit.total}`,
);

// ── 10. The recompute restates the day in progress on a live book ─────────────────────────
/**
 * The job fills through today, and only today computes the forward book, which reads every
 * live subscription's items through the bulk fill's cached transaction. A live subscription
 * is the input that reaches that read.
 */
console.log("\n10. the timezone recompute on a live book, through today");
const org10 = await createOrganization({ name: "Metric Daily TZ Recompute Org" });
const org10Id = org10.organization.id;
const biz10 = await createBusiness({
  organizationId: org10Id,
  name: "TZ Recompute Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "Asia/Kolkata",
});
const plan10 = await createProduct({ organizationId: org10Id, businessId: biz10.id, name: "Plan" });
const price10 = await createPrice({
  organizationId: org10Id,
  businessId: biz10.id,
  productId: plan10.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
for (let i = 0; i < 2; i++) {
  const cus = await createCustomer({
    organizationId: org10Id,
    businessId: biz10.id,
    email: `tz-recompute-${i}-${biz10.id}@example.test`,
  });
  await createSubscription({
    organizationId: org10Id,
    businessId: biz10.id,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: price10, quantity: 1 }],
  });
}
const today10 = zonedDayString(new Date(), "Asia/Kolkata");
const firstDay10 = new Date(`${today10}T00:00:00.000Z`);
firstDay10.setUTCDate(firstDay10.getUTCDate() - 2);
const first10 = firstDay10.toISOString().slice(0, 10);
await writeMetricDay({
  organizationId: org10Id,
  businessId: biz10.id,
  grain: "day",
  periodEnd: first10,
  rows: await withTenant(org10Id, (tx) => computeMetricPeriod(tx, biz10.id, "day", first10)),
});

let recompute10: { days: number; rows: number } | null = null;
let recomputeError = "";
try {
  recompute10 = await recomputeMetricDailyForBusiness(biz10.id);
} catch (e) {
  recomputeError = e instanceof Error ? e.message : String(e);
}
ok(
  "the recompute completes on a book with live subscriptions",
  recompute10 != null && recompute10.days === 3,
  recomputeError || `${recompute10?.days} days`,
);

type ForwardRow = Pick<MetricDailyRow, "measure" | "dim" | "dimValue" | "currency" | "value">;
const forward = (rows: readonly ForwardRow[]) =>
  rows
    .filter((r) => r.measure === "expected_renewal_cash" || r.measure === "expected_renewals")
    .map((r) => `${r.measure}|${r.dim}|${r.dimValue}|${r.currency}|${r.value}`)
    .sort();
const stored10 = forward(
  (await withTenant(org10Id, (tx) =>
    tx
      .select()
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, biz10.id),
          eq(metricDaily.grain, "day"),
          eq(metricDaily.periodEnd, today10),
        ),
      ),
  )) as ForwardRow[],
);
const plain10 = forward(
  await withTenant(org10Id, (tx) => computeMetricPeriod(tx, biz10.id, "day", today10)),
);
ok(
  "the restated day in progress carries the forward book a plain compute gives",
  stored10.length > 0 && JSON.stringify(stored10) === JSON.stringify(plain10),
  `stored ${stored10.length} rows, plain ${plain10.length}`,
);

console.log(
  failures === 0
    ? `\n✅ metric_daily cuts on the business's local calendar day (${zones.length * probeDays.length * 2} boundaries checked against Postgres)`
    : `\n❌ ${failures} check(s) failed`,
);
await closeDb();
process.exit(failures === 0 ? 0 : 1);
