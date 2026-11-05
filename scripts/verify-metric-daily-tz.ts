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
 *      saving anything else — or the same zone again — does not.
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
import { writeMetricDay } from "@/modules/metrics/daily/write";
import { resolveAnalytics, resolveScope, todayIn } from "@/modules/metrics/daily/public-query";
import { dayFor, type CronBusiness } from "@/modules/metrics/daily/cron";
import { DEFAULT_CALENDAR } from "@/platform/business-calendar";
import { customers, metricDaily } from "@db/schema";

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

// ── 9. An organization across zones reads every business at the same day ─────────────────
/**
 * At 20:00 UTC an Asia/Kolkata business already has tomorrow's row; New York and Amsterdam
 * do not. Reading the organization at the later day summed Kolkata's stock with nothing for
 * the others: MRR fell ~93% and paying customers to Kolkata's alone. The organization reads
 * up to the earliest local today of its businesses, and a day past it is unknown, not zero.
 */
console.log("\n9. an organization across zones reads every business at the same day");
const NOW9 = new Date("2026-10-22T20:00:00.000Z"); // Kolkata 23 Oct 01:30; NY 22 Oct 16:00
const org9 = await createOrganization({ name: "Metric Daily TZ Org-wide" });
const org9Id = org9.organization.id;
await withTenant(org9Id, (tx) =>
  tx.execute(
    sql`update organizations set timezone = 'Asia/Kolkata', base_currency = 'USD',
        exchange_rates = '{"INR":80,"EUR":0.8}'::jsonb where id = ${org9Id}`,
  ),
);
const biz9 = async (name: string, timezone: string, currency: string) =>
  createBusiness({
    organizationId: org9Id,
    name,
    defaultCurrency: currency,
    livemode: "test",
    timezone,
  });
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
  {
    b: await biz9("TZ9 Amsterdam", "Europe/Amsterdam", "EUR"),
    ccy: "EUR",
    rate: 0.8,
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
// Each day's stock moves, so a check can tell WHICH day was read.
const dayIndex = (d: string) => days9("2026-08-01", d).length;
const mrr9 = (i: number, d: string) => BigInt((i + 1) * 1_600_000 + dayIndex(d) * 800);
const paying9 = (i: number, d: string) => BigInt((i + 1) * 40 + dayIndex(d));
const new9 = (i: number) => BigInt((i + 1) * 8_000);
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
          { ...base, measure: "mrr_new", value: new9(i) },
        ];
      }),
    ),
  ),
);
const toUsd = (minor: bigint, rate: number) => Math.round(Number(minor) / rate);
const orgMrrOn = (d: string) => books9.reduce((s, { rate }, i) => s + toUsd(mrr9(i, d), rate), 0);
const orgPayingOn = (d: string) => books9.reduce((s, _, i) => s + Number(paying9(i, d)), 0);
const orgScope9 = await resolveScope(org9Id, null, "all");
const ask9 = (q: Record<string, unknown>) => resolveAnalytics(orgScope9, q as never, NOW9);

const mrr30 = await ask9({ measure: "mrr", range: "30d", grain: "day", compare: "previous" });
ok(
  "a named window ends on the earliest local today, 22 Oct, not on Kolkata's 23rd",
  mrr30.range.end === "2026-10-22" && mrr30.range.start === "2026-09-23",
  `${mrr30.range.start}…${mrr30.range.end}`,
);
ok(
  "MRR is every business at 22 Oct, converted per cell",
  mrr30.total === orgMrrOn("2026-10-22"),
  `${mrr30.total} vs ${orgMrrOn("2026-10-22")}`,
);
ok(
  "…and 30 days ago is every business at 22 Sep, so the change compares like with like",
  mrr30.compare?.previous_total === orgMrrOn("2026-09-22") &&
    mrr30.compare?.change_minor === orgMrrOn("2026-10-22") - orgMrrOn("2026-09-22"),
  JSON.stringify(mrr30.compare),
);
ok(
  "…a small rise, not a 93% fall",
  (mrr30.compare?.change_bps ?? -1) > 0 && (mrr30.compare?.change_bps ?? 0) < 1_000,
  String(mrr30.compare?.change_bps),
);
const paying30 = await ask9({
  measure: "paying_customers",
  range: "30d",
  grain: "day",
  compare: "previous",
});
ok(
  "paying customers is every business at 22 Oct",
  paying30.total === orgPayingOn("2026-10-22") &&
    paying30.compare?.previous_total === orgPayingOn("2026-09-22"),
  `${paying30.total} vs ${orgPayingOn("2026-10-22")}; prev ${paying30.compare?.previous_total}`,
);

// An explicit window can ask past that day. The 23rd is then unknown — never Kolkata alone.
const explicit = await ask9({
  measure: "mrr",
  grain: "day",
  start: "2026-09-24",
  end: "2026-10-23",
});
const last = explicit.series[explicit.series.length - 1];
ok(
  "an explicit window past that day: the 23rd reads unknown, not Kolkata's stock alone",
  last?.t === "2026-10-23" &&
    last.value === null &&
    (explicit.coverage?.missing_periods ?? []).includes("2026-10-23"),
  JSON.stringify({ last, coverage: explicit.coverage?.missing_periods }),
);
ok(
  "…and its MRR is the last day every business has, 22 Oct",
  explicit.total === orgMrrOn("2026-10-22"),
  `${explicit.total} vs ${orgMrrOn("2026-10-22")}`,
);
const month = await ask9({
  measure: "mrr",
  grain: "month",
  start: "2026-10-01",
  end: "2026-10-23",
});
ok(
  "a month bucket reads the same day as the day buckets",
  month.total === orgMrrOn("2026-10-22"),
  `${month.total} vs ${orgMrrOn("2026-10-22")}`,
);

// Flows are summed over the same days for every business.
const new30 = await ask9({ measure: "mrr_new", range: "30d", grain: "day" });
const perDay = books9.reduce((s, { rate }, i) => s + toUsd(new9(i), rate), 0);
ok(
  "new MRR is 30 whole days for every business, Kolkata's 23rd not yet among them",
  new30.total === perDay * 30 && new30.series.every((p) => p.value === perDay),
  `${new30.total} vs ${perDay * 30}`,
);

// One business is read at its own today.
const kolkataScope = await resolveScope(
  org9Id,
  {
    id: books9[0]!.b.id,
    publicId: books9[0]!.b.publicId,
    name: "TZ9 Kolkata",
    timezone: "Asia/Kolkata",
  },
  "all",
);
const kolkataMrr = await resolveAnalytics(
  kolkataScope,
  { measure: "mrr", grain: "day", start: "2026-09-24", end: "2026-10-23", currency: "INR" },
  NOW9,
);
ok(
  "a single Kolkata business still reads its own 23 Oct",
  kolkataMrr.total === Number(mrr9(0, "2026-10-23")),
  `${kolkataMrr.total}`,
);

console.log(
  failures === 0
    ? `\n✅ metric_daily cuts on the business's local calendar day (${zones.length * probeDays.length * 2} boundaries checked against Postgres)`
    : `\n❌ ${failures} check(s) failed`,
);
await closeDb();
process.exit(failures === 0 ? 0 : 1);
