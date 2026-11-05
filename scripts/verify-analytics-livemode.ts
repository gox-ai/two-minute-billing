/**
 * The analytics API's test/live partition.
 *
 * A business is wholly live or wholly test, so the caller's key mode has to decide WHICH
 * BUSINESSES an answer covers — otherwise the organization-wide headline counts sandbox
 * figures the business roster beside it deliberately hides, and two numbers on one screen
 * describe two different populations.
 *
 * The seed gives the live and the test business DIFFERENT figures in the SAME currency, so
 * every assertion below is a money difference rather than a row count: a filter that silently
 * did nothing would still return the right number of rows.
 *
 *   pnpm verify:analytics-livemode
 */
import { buildApp } from "@/index";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { todayIn } from "@/modules/metrics/daily/public-query";
import { metricDaily } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean) => checks.push([name, pass]);

const TZ = "Asia/Kolkata";
const DAYS = 7;
/** Minor units, one currency — so the two populations differ by a number, not a row count. */
const LIVE_MRR = 400_000;
const TEST_MRR = 25_000;

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00.000Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

// ── seed ──────────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Analytics Livemode Org" });
const orgId = org.organization.id;

const liveBiz = await createBusiness({
  organizationId: orgId,
  name: "Livemode Live Biz",
  defaultCurrency: "INR",
  livemode: "live",
  timezone: TZ,
});
const testBiz = await createBusiness({
  organizationId: orgId,
  name: "Livemode Test Biz",
  defaultCurrency: "INR",
  livemode: "test",
  timezone: TZ,
});

const liveKey = (await createApiKey(orgId, "live")).secret;
const testKey = (await createApiKey(orgId, "test")).secret;
const allKey = org.secret; // the organization's own key is minted 'all'

const today = todayIn(TZ);
const firstDay = addDays(today, -(DAYS - 1));
const computedAt = new Date();

const rows: Array<typeof metricDaily.$inferInsert> = [];
for (let i = 0; i < DAYS; i++) {
  const base = {
    organizationId: orgId,
    grain: "day",
    periodEnd: addDays(firstDay, i),
    computedAt,
    measure: "mrr",
    dim: "",
    dimValue: "",
    currency: "INR",
  };
  rows.push({ ...base, businessId: liveBiz.id, value: BigInt(LIVE_MRR) });
  rows.push({ ...base, businessId: testBiz.id, value: BigInt(TEST_MRR) });
}
await withTenant(orgId, (tx) => tx.insert(metricDaily).values(rows));

// ── drive the real server, in process ─────────────────────────────────────────────────────
const app = await buildApp({ logger: false });
const get = (url: string, key: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });
const j = (r: { body: string }) => JSON.parse(r.body);

const win = `start=${firstDay}&end=${today}`;
const orgWide = (key: string) => get(`/v1/analytics?measure=mrr&grain=day&${win}`, key);

// ── 1 · the organization-wide headline is partitioned ─────────────────────────────────────
const live = await orgWide(liveKey);
ok("a live key's org-wide answer is 200", live.statusCode === 200);
ok(
  `a live key's org-wide MRR is the live business alone (${LIVE_MRR})`,
  j(live).total === LIVE_MRR,
);

const test = await orgWide(testKey);
ok(
  `a test key's org-wide MRR is the test business alone (${TEST_MRR})`,
  j(test).total === TEST_MRR,
);

const all = await orgWide(allKey);
ok(
  `an 'all' key still sees both (${LIVE_MRR + TEST_MRR})`,
  all.statusCode === 200 && j(all).total === LIVE_MRR + TEST_MRR,
);

// A split names the businesses, so the filter is visible and not merely arithmetic.
const split = await get(`/v1/analytics?measure=mrr&grain=day&${win}&split=business`, liveKey);
const keys = (j(split).split?.series ?? []).map((r: { key: string }) => r.key);
ok(
  "a live key's split=business lists the live business and no other",
  keys.length === 1 && keys[0] === liveBiz.publicId,
);

const splitAll = await get(`/v1/analytics?measure=mrr&grain=day&${win}&split=business`, allKey);
const allKeys = (j(splitAll).split?.series ?? []).map((r: { key: string }) => r.key).sort();
ok(
  "an 'all' key's split=business lists both",
  allKeys.length === 2 && allKeys.includes(liveBiz.publicId) && allKeys.includes(testBiz.publicId),
);

// ── 2 · a business outside the partition cannot be named ──────────────────────────────────
const crossMode = await get(
  `/v1/analytics?measure=mrr&grain=day&${win}&business=${testBiz.publicId}`,
  liveKey,
);
ok(
  "a live key naming a test business is refused, in the same words as one that does not exist",
  crossMode.statusCode === 422 &&
    j(crossMode).error.message === `No such business: ${testBiz.publicId}`,
);

const ownMode = await get(
  `/v1/analytics?measure=mrr&grain=day&${win}&business=${liveBiz.publicId}`,
  liveKey,
);
ok(
  "…while its own business still answers, unchanged",
  ownMode.statusCode === 200 && j(ownMode).total === LIVE_MRR,
);

const allNamesTest = await get(
  `/v1/analytics?measure=mrr&grain=day&${win}&business=${testBiz.publicId}`,
  allKey,
);
ok(
  "an 'all' key may still name the test business",
  allNamesTest.statusCode === 200 && j(allNamesTest).total === TEST_MRR,
);

// ── 3 · an 'all' credential can ask for one partition ─────────────────────────────────────
const allLive = await get(`/v1/analytics?measure=mrr&grain=day&${win}&livemode=live`, allKey);
ok(
  "an 'all' key asking for live gets the live business alone",
  allLive.statusCode === 200 && j(allLive).total === LIVE_MRR,
);
const allTest = await get(`/v1/analytics?measure=mrr&grain=day&${win}&livemode=test`, allKey);
ok(
  "…and asking for test gets the test business alone",
  allTest.statusCode === 200 && j(allTest).total === TEST_MRR,
);
const liveAsksTest = await get(`/v1/analytics?measure=mrr&grain=day&${win}&livemode=test`, liveKey);
ok(
  "a live key asking for test figures is refused, not quietly narrowed",
  liveAsksTest.statusCode === 422 &&
    /A live key cannot ask for test figures\./.test(j(liveAsksTest).error.message),
);

// ── 4 · the batch endpoint resolves scope the same way ────────────────────────────────────
const batch = await app.inject({
  method: "POST",
  url: "/v1/analytics/query",
  headers: { authorization: `Bearer ${liveKey}` },
  payload: {
    start: firstDay,
    end: today,
    grain: "day",
    queries: [
      { key: "orgwide", measure: "mrr" },
      { key: "crossmode", measure: "mrr", business: testBiz.publicId },
    ],
  },
});
const b = j(batch);
ok("the batch endpoint partitions its org-wide slot too", b.data[0].total === LIVE_MRR);
ok(
  "…and refuses the cross-mode slot alone",
  b.data[1].status === 422 && b.data[1].error.message === `No such business: ${testBiz.publicId}`,
);

// ── verdict ───────────────────────────────────────────────────────────────────────────────
await app.close();

const failed = checks.filter(([, pass]) => !pass);
for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
console.log("");
console.log(
  failed.length === 0
    ? `✅ ANALYTICS-LIVEMODE: PASS (${checks.length}/${checks.length})`
    : `❌ ANALYTICS-LIVEMODE: FAIL (${failed.length} of ${checks.length})`,
);
await closeDb();
process.exit(failed.length === 0 ? 0 : 1);
