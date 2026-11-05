/**
 * The reporting calendar (0293): `week_start` and `fiscal_year_start_month`.
 *
 *   1. weeks: a Sunday opens a Sunday week and closes a Monday one;
 *   2. fiscal quarters and years (April start): period ends, labels, tiling;
 *   3. the engine's period builders agree with the helper (`coarsePeriodEnds`,
 *      `periodStartDate`, `buildPeriods`, `resolveWindow`), including windows that cross
 *      the calendar year;
 *   4. defaults: a new business is Sunday / January;
 *   5. the API: GET/PATCH validation, weekly buckets and fiscal labels read back;
 *   6. a PATCH that moves either setting enqueues a coarse recompute, which re-keys stored
 *      week/quarter/year rows.
 *
 * `PURE_ONLY=1` runs 1–3 alone; `BUSINESS_CALENDAR_MODULE` points them at another copy of
 * the helper, which is how the mutation run feeds it mutants.
 *
 *   pnpm verify:business-calendar
 */
import { and, eq, sql } from "drizzle-orm";
import type * as CalendarModule from "@/platform/business-calendar";
import { coarsePeriodEnds } from "@/modules/metrics/daily/cron";
import { periodStartDate } from "@/modules/metrics/daily/compute";
import { buildPeriods, resolveWindow } from "@/modules/metrics/daily/public-query";

const cal: typeof CalendarModule = await import(
  process.env.BUSINESS_CALENDAR_MODULE ?? "@/platform/business-calendar"
);
const { weekEnd, weekStartDate, fiscalQuarterEnd, fiscalYearEnd, periodEndOf, periodStartOf } = cal;

const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean, detail = "") =>
  checks.push([detail && !pass ? `${name} — ${detail}` : name, pass]);

const SUN = { weekStart: "sunday", fiscalYearStartMonth: 1 } as const;
const MON = { weekStart: "monday", fiscalYearStartMonth: 1 } as const;
const APR = { weekStart: "sunday", fiscalYearStartMonth: 4 } as const;

const at = (d: string) => new Date(`${d}T00:00:00.000Z`);
const addDays = (d: string, n: number) => {
  const x = at(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const dow = (d: string) => at(d).getUTCDay();
const everyDay = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

// ── 1 · weeks ─────────────────────────────────────────────────────────────────────────────
// 2026-09-20 is a Sunday.
ok("fixture: 2026-09-20 is a Sunday", dow("2026-09-20") === 0);
ok(
  "sunday: a Sunday OPENS its week (Sun 20 – Sat 26)",
  weekStartDate("2026-09-20", "sunday") === "2026-09-20" &&
    weekEnd("2026-09-20", "sunday") === "2026-09-26",
  `${weekStartDate("2026-09-20", "sunday")}..${weekEnd("2026-09-20", "sunday")}`,
);
ok(
  "sunday: the Saturday before closes the previous week",
  weekEnd("2026-09-19", "sunday") === "2026-09-19" &&
    weekStartDate("2026-09-19", "sunday") === "2026-09-13",
);
ok(
  "monday: a Sunday CLOSES its week (Mon 14 – Sun 20)",
  weekStartDate("2026-09-20", "monday") === "2026-09-14" &&
    weekEnd("2026-09-20", "monday") === "2026-09-20",
  `${weekStartDate("2026-09-20", "monday")}..${weekEnd("2026-09-20", "monday")}`,
);
ok(
  "monday: the Monday after opens the next week",
  weekStartDate("2026-09-21", "monday") === "2026-09-21" &&
    weekEnd("2026-09-21", "monday") === "2026-09-27",
);
{
  const bad: string[] = [];
  for (const d of everyDay("2025-12-01", "2027-02-28")) {
    for (const ws of ["sunday", "monday"] as const) {
      const end = weekEnd(d, ws);
      const start = weekStartDate(d, ws);
      const lastDow = ws === "sunday" ? 6 : 0;
      if (dow(end) !== lastDow || start > d || end < d || addDays(start, 6) !== end) {
        bad.push(`${ws} ${d}`);
      }
      // Weeks tile: the day after the end opens the next week.
      if (weekStartDate(addDays(end, 1), ws) !== addDays(end, 1)) bad.push(`${ws} tile ${d}`);
    }
  }
  ok(
    "weeks: every day of 15 months sits in one 7-day week ending on the right weekday",
    bad.length === 0,
    bad.slice(0, 3).join(", "),
  );
}

// ── 2 · fiscal quarters and years (April start) ───────────────────────────────────────────
ok(
  "fy=4: Q1 is April–June",
  fiscalQuarterEnd("2026-04-01", 4) === "2026-06-30" &&
    periodStartOf("quarter", "2026-05-15", APR) === "2026-04-01",
);
ok(
  "fy=4: January sits in Q4, which ends 31 March",
  fiscalQuarterEnd("2027-01-10", 4) === "2027-03-31" &&
    periodStartOf("quarter", "2027-01-10", APR) === "2027-01-01",
);
ok(
  "fy=4: the fiscal year crosses the calendar year (Apr 2026 – Mar 2027)",
  fiscalYearEnd("2026-04-01", 4) === "2027-03-31" &&
    fiscalYearEnd("2026-12-31", 4) === "2027-03-31" &&
    fiscalYearEnd("2026-03-31", 4) === "2026-03-31" &&
    periodStartOf("year", "2027-02-10", APR) === "2026-04-01",
);
ok(
  "fy=4: labels name the year a fiscal year ENDS in",
  cal.quarterLabel("2026-04-01", 4) === "Q1 FY2027" &&
    cal.quarterLabel("2027-01-10", 4) === "Q4 FY2027" &&
    cal.quarterLabel("2026-03-31", 4) === "Q4 FY2026" &&
    cal.yearLabel("2026-05-01", 4) === "FY2027",
  `${cal.quarterLabel("2026-04-01", 4)} / ${cal.yearLabel("2026-05-01", 4)}`,
);
ok(
  "fy=1: calendar labels are unchanged",
  cal.quarterLabel("2026-05-20", 1) === "Q2 2026" && cal.yearLabel("2026-05-20", 1) === "2026",
);
ok(
  "fy=2: a quarter can straddle New Year (Nov–Jan)",
  fiscalQuarterEnd("2026-11-15", 2) === "2027-01-31" &&
    fiscalQuarterEnd("2027-01-31", 2) === "2027-01-31" &&
    periodStartOf("quarter", "2027-01-15", { weekStart: "sunday", fiscalYearStartMonth: 2 }) ===
      "2026-11-01",
);
{
  const bad: string[] = [];
  for (let fy = 1; fy <= 12; fy++) {
    const c = { weekStart: "sunday", fiscalYearStartMonth: fy } as const;
    for (const d of everyDay("2025-11-01", "2027-03-31")) {
      for (const g of ["month", "quarter", "year"] as const) {
        const end = periodEndOf(g, d, c);
        const start = periodStartOf(g, d, c);
        if (start > d || end < d) bad.push(`${fy} ${g} ${d} outside`);
        if (!addDays(end, 1).endsWith("-01")) bad.push(`${fy} ${g} ${d} end not month end`);
        // Tiling: the next period opens the day after this one ends.
        if (periodStartOf(g, addDays(end, 1), c) !== addDays(end, 1)) bad.push(`${fy} ${g} tile`);
        // The stored-row window: compute.ts derives the start from the end alone.
        if (periodStartDate(g, end) !== start) bad.push(`${fy} ${g} ${d} periodStartDate`);
      }
      const yEnd = periodEndOf("year", d, c);
      if (Number(yEnd.slice(5, 7)) !== ((fy + 10) % 12) + 1)
        bad.push(`${fy} year ends wrong month`);
    }
  }
  ok(
    "fiscal: all 12 start months — every period contains its day, ends on a month end, tiles, and matches periodStartDate",
    bad.length === 0,
    bad.slice(0, 3).join(", "),
  );
}
{
  const bad: string[] = [];
  for (const d of everyDay("2026-01-01", "2026-12-31")) {
    for (const c of [SUN, MON, APR]) {
      if (periodStartDate("week", periodEndOf("week", d, c)) !== periodStartOf("week", d, c))
        bad.push(d);
    }
  }
  ok("weeks: periodStartDate(week end) is the week's first day, either start", bad.length === 0);
}

// ── 3 · the engine's builders ─────────────────────────────────────────────────────────────
{
  const sun = new Map(coarsePeriodEnds("2026-09-20", SUN));
  const mon = new Map(coarsePeriodEnds("2026-09-20", MON));
  const apr = new Map(coarsePeriodEnds("2027-02-10", APR));
  ok(
    "coarsePeriodEnds: Sunday 20 Sep keys its week at Sat 26 (sunday) / Sun 20 (monday)",
    sun.get("week") === "2026-09-26" && mon.get("week") === "2026-09-20",
  );
  ok(
    "coarsePeriodEnds: fy=4 keys Feb 2027 at quarter 2027-03-31 and year 2027-03-31; month unchanged",
    apr.get("quarter") === "2027-03-31" &&
      apr.get("year") === "2027-03-31" &&
      apr.get("month") === "2027-02-28",
  );
  const fy4Dec = new Map(coarsePeriodEnds("2026-12-15", APR));
  ok(
    "coarsePeriodEnds: fy=4 keys Dec 2026's YEAR at 2027-03-31, not 2026-12-31",
    fy4Dec.get("year") === "2027-03-31",
  );
}
{
  const s = buildPeriods("week", "2026-09-01", "2026-09-30", SUN);
  const m = buildPeriods("week", "2026-09-01", "2026-09-30", MON);
  ok(
    "buildPeriods sunday: first bucket 1–5 Sep, labelled by its full week Aug 30 – Sep 5",
    s[0]?.start === "2026-09-01" && s[0]?.end === "2026-09-05" && s[0]?.label === "Aug 30 – Sep 5",
    JSON.stringify(s[0]),
  );
  ok(
    "buildPeriods sunday: Sunday 20 Sep opens the bucket Sep 20 – Sep 26",
    s.some(
      (p) => p.start === "2026-09-20" && p.end === "2026-09-26" && p.label === "Sep 20 – Sep 26",
    ),
  );
  ok(
    "buildPeriods monday: first bucket 1–6 Sep (Aug 31 – Sep 6); Sunday 20 Sep closes Sep 14 – Sep 20",
    m[0]?.end === "2026-09-06" &&
      m[0]?.label === "Aug 31 – Sep 6" &&
      m.some((p) => p.start === "2026-09-14" && p.end === "2026-09-20"),
    JSON.stringify(m[0]),
  );
  const q = buildPeriods("quarter", "2026-01-01", "2026-12-31", APR);
  ok(
    "buildPeriods fy=4 quarters over 2026: Q4 FY2026, Q1–Q3 FY2027, ending Mar/Jun/Sep/Dec",
    q.map((p) => `${p.end} ${p.label}`).join("|") ===
      "2026-03-31 Q4 FY2026|2026-06-30 Q1 FY2027|2026-09-30 Q2 FY2027|2026-12-31 Q3 FY2027",
    q.map((p) => `${p.end} ${p.label}`).join("|"),
  );
  const y = buildPeriods("year", "2026-01-01", "2026-12-31", APR);
  ok(
    "buildPeriods fy=4 years over 2026: FY2026 (clipped to Mar 31) then FY2027 (clipped to Dec 31)",
    y.map((p) => `${p.start}..${p.end} ${p.label}`).join("|") ===
      "2026-01-01..2026-03-31 FY2026|2026-04-01..2026-12-31 FY2027",
    y.map((p) => `${p.start}..${p.end} ${p.label}`).join("|"),
  );
  const cy = buildPeriods("quarter", "2026-01-01", "2026-06-30", SUN);
  ok(
    "buildPeriods fy=1: quarter labels stay Q1 2026 / Q2 2026",
    cy.map((p) => p.label).join(",") === "Q1 2026,Q2 2026",
  );
}
{
  const w = (range: string, today: string, c: CalendarModule.BusinessCalendar) =>
    resolveWindow({ range, timezone: "UTC", timezoneSource: "default", calendar: c, today });
  const ytd = w("this_year", "2027-02-10", APR);
  const qtd = w("this_quarter", "2027-02-10", APR);
  ok(
    "resolveWindow fy=4: 'year to date' on 10 Feb 2027 runs from 1 Apr 2026 (crosses the calendar year)",
    ytd.start === "2026-04-01" && ytd.end === "2027-02-10",
    `${ytd.start}..${ytd.end}`,
  );
  ok(
    "resolveWindow fy=4: 'this quarter' on 10 Feb 2027 runs from 1 Jan 2027",
    qtd.start === "2027-01-01",
  );
  const fy2q = w("this_quarter", "2027-01-15", { weekStart: "sunday", fiscalYearStartMonth: 2 });
  ok(
    "resolveWindow fy=2: 'this quarter' on 15 Jan 2027 runs from 1 Nov 2026",
    fy2q.start === "2026-11-01",
  );
  ok(
    "resolveWindow fy=1: this_year / this_quarter are calendar",
    w("this_year", "2027-02-10", SUN).start === "2027-01-01" &&
      w("this_quarter", "2027-02-10", SUN).start === "2027-01-01",
  );
  const lm = w("last_month", "2027-02-10", APR);
  ok(
    "resolveWindow: last_month is a calendar month whatever the fiscal year",
    lm.start === "2027-01-01" && lm.end === "2027-01-31",
  );
}
ok(
  "defaults: DEFAULT_CALENDAR is sunday / 1, and calendarOf falls back to it",
  cal.DEFAULT_CALENDAR.weekStart === "sunday" &&
    cal.DEFAULT_CALENDAR.fiscalYearStartMonth === 1 &&
    cal.calendarOf(null).weekStart === "sunday" &&
    cal.calendarOf({ weekStart: "monday", fiscalYearStartMonth: 13 }).fiscalYearStartMonth === 1,
);

// ── 4–6 · the database, the API and the recompute ─────────────────────────────────────────
if (process.env.PURE_ONLY !== "1") {
  const { buildApp } = await import("@/index");
  const { systemDb: db, closeDb, withTenant } = await import("@/platform/db");
  const { createOrganization, createBusiness, updateBusiness } =
    await import("@/modules/tenancy/service");
  const { createCustomer } = await import("@/modules/customers/service");
  const { createProduct, createPrice } = await import("@/modules/catalog/service");
  const { createSubscription } = await import("@/modules/subscriptions/service");
  const { bulkFillMetricDays, bulkFillCoarseGrains } =
    await import("@/modules/metrics/daily/bulk-fill");
  const { recomputeCoarseGrainsForBusiness } = await import("@/modules/metrics/daily/recompute");
  const { zonedDayString } = await import("@/platform/timezones");
  const { businesses, metricDaily, subscriptions } = await import("@db/schema");

  const org = await createOrganization({ name: "Business Calendar Org" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Business Calendar Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });

  // 4 · defaults
  const [row] = await db
    .select({ ws: businesses.weekStart, fy: businesses.fiscalYearStartMonth })
    .from(businesses)
    .where(eq(businesses.id, biz.id));
  ok(
    "defaults: a new business is week_start 'sunday', fiscal_year_start_month 1",
    row?.ws === "sunday" && row?.fy === 1,
  );

  // 5 · the API
  const app = await buildApp({ logger: false });
  const auth = { authorization: `Bearer ${org.secret}` };
  let keyN = 0;
  const patch = (payload: object) =>
    app.inject({
      method: "PATCH",
      url: `/v1/businesses/${biz.publicId}`,
      headers: { ...auth, "idempotency-key": `bizcal-${Date.now()}-${++keyN}` },
      payload,
    });
  const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
  const j = (r: { body: string }) => JSON.parse(r.body);

  const got = j(await get(`/v1/businesses/${biz.publicId}`));
  ok(
    "GET business exposes week_start and fiscal_year_start_month",
    got.week_start === "sunday" && got.fiscal_year_start_month === 1,
  );
  const badWs = await patch({ week_start: "tuesday" });
  const badFy = await patch({ fiscal_year_start_month: 13 });
  const badFy0 = await patch({ fiscal_year_start_month: 0 });
  ok(
    "PATCH refuses week_start 'tuesday' and fiscal months 0 / 13",
    badWs.statusCode === 400 && badFy.statusCode === 400 && badFy0.statusCode === 400,
    `${badWs.statusCode}/${badFy.statusCode}/${badFy0.statusCode}`,
  );

  // Weekly buckets over the API: one flow on Sunday 2026-09-20.
  await withTenant(orgId, (tx) =>
    tx.insert(metricDaily).values({
      organizationId: orgId,
      businessId: biz.id,
      grain: "day",
      periodEnd: "2026-09-20",
      measure: "mrr_new",
      dim: "",
      dimValue: "",
      currency: "USD",
      value: 700n,
    }),
  );
  const weekly = async () =>
    j(
      await get(
        `/v1/analytics?measure=mrr_new&grain=week&start=2026-09-06&end=2026-10-03&business=${biz.publicId}`,
      ),
    ) as { series: Array<{ t: string; label: string; value: number | null }> };
  const sunSeries = (await weekly()).series;
  ok(
    "API sunday: weekly buckets end on Saturdays and Sunday 20 Sep's flow lands in Sep 20 – Sep 26",
    sunSeries.map((p) => p.t).join(",") === "2026-09-12,2026-09-19,2026-09-26,2026-10-03" &&
      sunSeries.find((p) => p.t === "2026-09-26")?.value === 700 &&
      sunSeries.find((p) => p.t === "2026-09-26")?.label === "Sep 20 – Sep 26",
    JSON.stringify(sunSeries),
  );

  // 6 · stored coarse rows, then a PATCH that moves the calendar.
  const today = zonedDayString(new Date(), null);
  // A fixed window that ends before the §5 query window (Sep 6 – Oct 3): the day fill
  // rewrites every day it covers, so a clock-relative one overwrote the 20 Sep flow.
  const fillEnd = "2026-08-31";
  const start = addDays(fillEnd, -45);
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10_000,
    interval: "month",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `bizcal-${Date.now()}@example.test`,
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: at(start),
    startDate: at(start),
    items: [{ price, quantity: 1 }],
  });
  // Parked far ahead so a live worker renews nothing mid-run.
  const parked = at(addDays(today, 400));
  await db
    .update(subscriptions)
    .set({ currentPeriodEnd: parked, trialEnd: parked })
    .where(eq(subscriptions.id, subscription.id));

  const days = everyDay(start, fillEnd);
  await bulkFillMetricDays({
    organizationId: orgId,
    businessId: biz.id,
    grain: "day",
    days,
    write: true,
    timezone: null,
  });
  await bulkFillCoarseGrains({
    organizationId: orgId,
    businessId: biz.id,
    days,
    write: true,
    timezone: null,
  });
  const keys = async (grain: string) =>
    [
      ...new Set(
        (
          await withTenant(orgId, (tx) =>
            tx
              .select({ k: metricDaily.periodEnd })
              .from(metricDaily)
              .where(and(eq(metricDaily.businessId, biz.id), eq(metricDaily.grain, grain))),
          )
        ).map((r) => r.k),
      ),
    ].sort();
  const weeksSun = await keys("week");
  const monthsBefore = await keys("month");
  ok(
    "stored (sunday): every week row is keyed on a Saturday",
    weeksSun.length >= 6 && weeksSun.every((k) => dow(k) === 6),
    weeksSun.join(","),
  );

  const recomputesQueued = async (): Promise<Array<{ grains: string[] | null }>> =>
    (await db.execute(sql`
      select j.payload->'grains' as grains
        from graphile_worker._private_jobs j
        join graphile_worker._private_tasks t on t.id = j.task_id
       where t.identifier = 'metric_daily_recompute'
         and j.payload->>'businessId' = ${biz.id}`)) as unknown as Array<{
      grains: string[] | null;
    }>;

  const q0 = (await recomputesQueued()).length;
  await updateBusiness(orgId, biz.publicId, { weekStart: "sunday", fiscalYearStartMonth: 1 });
  ok("re-saving the same calendar queues nothing", (await recomputesQueued()).length === q0);

  const moved = await patch({ week_start: "monday" });
  ok(
    "PATCH week_start=monday answers 200 with the new value",
    moved.statusCode === 200 && j(moved).week_start === "monday",
  );
  const afterWs = await recomputesQueued();
  const weekJob =
    afterWs.length > q0 && afterWs.some((r) => JSON.stringify(r.grains) === '["week"]');
  const weeksNow = await keys("week");
  ok(
    "PATCH week_start enqueues a recompute of the WEEK grain only",
    weekJob || weeksNow.every((k) => dow(k) === 0),
    weekJob ? "queued" : "consumed by a live worker",
  );

  // The API reads the new calendar at once, before the recompute runs.
  const monSeries = (await weekly()).series;
  ok(
    "API monday: weekly buckets end on Sundays and Sunday 20 Sep's flow lands in Sep 14 – Sep 20",
    monSeries.find((p) => p.t === "2026-09-20")?.value === 700 &&
      monSeries.find((p) => p.t === "2026-09-20")?.label === "Sep 14 – Sep 20",
    JSON.stringify(monSeries),
  );

  await recomputeCoarseGrainsForBusiness(biz.id, ["week"]);
  const weeksMon = await keys("week");
  ok(
    "recompute: week rows re-keyed onto Sundays, none left on a Saturday",
    weeksMon.length >= 6 && weeksMon.every((k) => dow(k) === 0),
    weeksMon.join(","),
  );
  ok(
    "recompute: the week-only pass left month rows alone",
    JSON.stringify(await keys("month")) === JSON.stringify(monthsBefore),
  );

  const fyMove = await patch({ fiscal_year_start_month: 4 });
  const afterFy = await recomputesQueued();
  ok(
    "PATCH fiscal_year_start_month enqueues a recompute of quarter + year",
    fyMove.statusCode === 200 &&
      j(fyMove).fiscal_year_start_month === 4 &&
      (afterFy.some((r) => JSON.stringify(r.grains) === '["quarter","year"]') ||
        (await keys("year")).every((k) => k.endsWith("-03-31"))),
  );
  await recomputeCoarseGrainsForBusiness(biz.id, ["quarter", "year"]);
  const years = await keys("year");
  const quarters = await keys("quarter");
  ok(
    "recompute fy=4: year rows keyed on 31 March, quarters on fiscal quarter ends",
    years.length > 0 &&
      years.every((k) => k.endsWith("-03-31")) &&
      quarters.every((k) => ["03-31", "06-30", "09-30", "12-31"].includes(k.slice(5))),
    `${years.join(",")} / ${quarters.join(",")}`,
  );

  const fyQ = j(
    await get(
      `/v1/analytics?measure=mrr_new&grain=quarter&start=2026-01-01&end=2026-12-31&business=${biz.publicId}`,
    ),
  ) as { series: Array<{ t: string; label: string }> };
  ok(
    "API fy=4: quarter buckets are labelled Q4 FY2026 … Q3 FY2027",
    fyQ.series.map((p) => p.label).join(",") === "Q4 FY2026,Q1 FY2027,Q2 FY2027,Q3 FY2027",
    fyQ.series.map((p) => p.label).join(","),
  );
  const ytd = j(
    await get(`/v1/analytics?measure=mrr_new&grain=month&range=this_year&business=${biz.publicId}`),
  );
  const m = Number(today.slice(5, 7));
  const expectYtd = `${Number(today.slice(0, 4)) - (m < 4 ? 1 : 0)}-04-01`;
  ok(
    "API fy=4: range=this_year starts at the fiscal year's 1 April",
    ytd.range?.start === expectYtd,
    ytd.range?.start,
  );

  // Leave nothing queued against the test business.
  await db.execute(sql`
    delete from graphile_worker._private_jobs j
     using graphile_worker._private_tasks t
     where t.id = j.task_id and t.identifier = 'metric_daily_recompute'
       and j.payload->>'businessId' = ${biz.id} and j.locked_at is null`);
  await app.close();
  await closeDb();
}

const failed = checks.filter(([, pass]) => !pass);
for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
console.log("");
console.log(
  failed.length === 0
    ? `✅ BUSINESS-CALENDAR: PASS (${checks.length}/${checks.length})`
    : `❌ BUSINESS-CALENDAR: FAIL (${failed.length} of ${checks.length})`,
);
process.exit(failed.length === 0 ? 0 : 1);
