/**
 * A measure answered for a customer segment (`segment=`), computed from the ledger at read time.
 *
 *   A. EVERYONE IS THE BOOK. A segment matching every customer reproduces the stored,
 *      unsegmented answer for every measure a segment accepts — the MRR stock, the flows and the
 *      head counts — period by period. This is the check that keeps the two paths honest.
 *   B. A SUBSET IS EXACT. A one-country segment answers the figures worked out by hand.
 *   C. REFUSED BY NAME. An unsupported measure, a split, an org-wide scope, an unknown segment
 *      and another organization's segment each fail with a sentence and `param: "segment"`.
 *   D. TILES AND THE API. A tile stores `segment_id` and is answered for it; a report tile and
 *      an unsupported measure refuse it; GET and the batch route carry it end to end.
 *
 *   pnpm verify:segment-analytics
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { createSegment } from "@/modules/segments/service";
import { bulkFillMetricDays } from "@/modules/metrics/daily/bulk-fill";
import { resolveAnalytics, resolveScope } from "@/modules/metrics/daily/public-query";
import { MeasureRefused } from "@/modules/metrics/daily/query";
import { SEGMENT_MEASURES } from "@/modules/metrics/daily/segment-series";
import { addTile, createDashboard, resolveDashboard } from "@/modules/metrics/dashboards/service";
import { customers, mrrMovements, subscriptions } from "@db/schema";

const checks: Array<[string, boolean, string?]> = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date("2026-07-15T12:00:00.000Z");

// ── The book: three customers, hand-written ledger ────────────────────────────────────────
const org = await createOrganization({ name: "Segment Analytics Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Segment Analytics Biz",
  defaultCurrency: "USD",
  timezone: "UTC",
  livemode: "test",
});
const plan = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});

async function account(
  name: string,
  country: string,
  s: { mrr: number; started: string; cancelled?: string },
) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `seg-an-${name}-${Date.now()}@example.test`,
  });
  await systemDb
    .update(customers)
    .set({ country, createdAt: day("2026-03-01") })
    .where(eq(customers.id, c.id));
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: day(s.started),
    startDate: day(s.started),
    items: [{ price, quantity: 1 }],
  });
  await systemDb
    .update(subscriptions)
    .set({
      status: s.cancelled ? "cancelled" : "active",
      mrr: BigInt(s.cancelled ? 0 : s.mrr),
      lastEarningMrr: BigInt(s.mrr),
      createdAt: day(s.started),
      startDate: day(s.started),
      startedAt: day(s.started),
      canceledAt: s.cancelled ? day(s.cancelled) : null,
      currentPeriodEnd: day("2028-01-01"),
    })
    .where(eq(subscriptions.id, subscription.id));
  return { cid: c.id, sid: subscription.id };
}
// A (India) earns throughout; B (US) churns in May; C (US) starts in May.
const a = await account("a", "IN", { mrr: 5000, started: "2026-04-05" });
const b = await account("b", "US", { mrr: 3000, started: "2026-04-08", cancelled: "2026-05-20" });
const c = await account("c", "US", { mrr: 2000, started: "2026-05-03" });

await systemDb.delete(mrrMovements).where(eq(mrrMovements.businessId, biz.id));
const row = (who: { cid: string; sid: string }, at: string, reason: string, delta: number) => ({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: who.sid,
  customerId: who.cid,
  reason,
  planProductId: plan.id,
  currency: "USD",
  previousMrrMinor: BigInt(delta < 0 ? -delta : 0),
  newMrrMinor: BigInt(delta > 0 ? delta : 0),
  deltaMinor: BigInt(delta),
  occurredAt: new Date(`${at}T09:00:00.000Z`),
});
await withTenant(orgId, (tx) =>
  tx
    .insert(mrrMovements)
    .values([
      row(a, "2026-04-05", "new", 5000),
      row(b, "2026-04-08", "new", 3000),
      row(b, "2026-05-20", "churn", -3000),
      row(c, "2026-05-03", "new", 2000),
    ]),
);

// The store, written by the real writer: every day, then the month rows the head counts need.
const days: string[] = [];
for (let d = day("2026-04-01"); d <= day("2026-06-30"); d = new Date(d.getTime() + 86_400_000)) {
  days.push(d.toISOString().slice(0, 10));
}
await bulkFillMetricDays({
  organizationId: orgId,
  businessId: biz.id,
  grain: "day",
  days,
  write: true,
  now: NOW,
  timezone: "UTC",
});
await bulkFillMetricDays({
  organizationId: orgId,
  businessId: biz.id,
  grain: "month",
  days: ["2026-04-30", "2026-05-31", "2026-06-30"],
  write: true,
  now: NOW,
  onlyNonAdditive: true,
  timezone: "UTC",
});

const everyone = await createSegment({
  organizationId: orgId,
  businessId: biz.id,
  name: "Everyone",
  filters: [{ field: "created_at", op: "before", value: "2100-01-01" }],
});
const us = await createSegment({
  organizationId: orgId,
  businessId: biz.id,
  name: "United States",
  filters: [{ field: "country", op: "is", value: "US" }],
});

const scope = await resolveScope(
  orgId,
  { id: biz.id, publicId: biz.publicId, name: biz.name, timezone: "UTC" },
  "all",
);
const win = { grain: "month", start: "2026-04-01", end: "2026-06-30", currency: "USD" };
const series = (r: { series: Array<{ t: string; value: number | null }> }) =>
  r.series.map((p) => `${p.t}=${p.value ?? 0}`).join(" ");

// ── A. Everyone is the book ───────────────────────────────────────────────────────────────
for (const measure of SEGMENT_MEASURES) {
  const stored = await resolveAnalytics(scope, { measure, ...win }, NOW).catch((e) => e as Error);
  if (stored instanceof Error) {
    // A flow this book never had (pause, expansion) is refused for the currency on both paths.
    const seg = await resolveAnalytics(
      scope,
      { measure, ...win, segment: everyone.publicId },
      NOW,
    ).catch((e) => e as Error);
    ok(`everyone: ${measure} — both paths refuse an empty currency alike`, seg instanceof Error);
    continue;
  }
  const seg = await resolveAnalytics(scope, { measure, ...win, segment: everyone.publicId }, NOW);
  ok(
    `everyone: ${measure} equals the stored answer`,
    series(seg) === series(stored),
    `stored ${series(stored)} · segment ${series(seg)}`,
  );
}

// ── B. A subset is exact ──────────────────────────────────────────────────────────────────
const usAnswer = async (measure: string) =>
  series(await resolveAnalytics(scope, { measure, ...win, segment: us.publicId }, NOW));
ok(
  "US: MRR is B then C",
  (await usAnswer("mrr")) === "2026-04-30=3000 2026-05-31=2000 2026-06-30=2000",
);
ok("US: new MRR", (await usAnswer("mrr_new")) === "2026-04-30=3000 2026-05-31=2000 2026-06-30=0");
ok(
  "US: churned MRR is B alone",
  (await usAnswer("mrr_churn")) === "2026-04-30=0 2026-05-31=3000 2026-06-30=0",
);
ok(
  "US: new customers",
  (await usAnswer("customers_new")) === "2026-04-30=1 2026-05-31=1 2026-06-30=0",
);
ok(
  "US: churned customers",
  (await usAnswer("customers_churned")) === "2026-04-30=0 2026-05-31=1 2026-06-30=0",
);
const tagged = await resolveAnalytics(scope, { measure: "mrr", ...win, segment: us.publicId }, NOW);
ok(
  "the answer names its segment and says membership is today's",
  tagged.segment?.id === us.publicId &&
    tagged.segment.membership === "current" &&
    tagged.segment.note.length > 0,
);

// ── C. Refused by name ────────────────────────────────────────────────────────────────────
const refusal = async (req: Parameters<typeof resolveAnalytics>[1], s = scope) => {
  try {
    await resolveAnalytics(s, req, NOW);
    return null;
  } catch (e) {
    return e instanceof MeasureRefused ? e : null;
  }
};
const unsupported = await refusal({ measure: "billing_gross", ...win, segment: us.publicId });
ok(
  "an unsupported measure is refused, naming what a segment answers",
  unsupported?.param === "segment" &&
    /cannot be answered for a segment/.test(unsupported.message) &&
    unsupported.options?.includes("mrr") === true,
);
const split = await refusal({ measure: "mrr", ...win, split: "plan", segment: us.publicId });
ok(
  "a split with a segment is refused",
  split?.param === "segment" && /cannot be split/.test(split.message),
);
// With one business an org-wide scope IS that business; the refusal is for a book of several.
await createBusiness({
  organizationId: orgId,
  name: "Second Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const orgScope = await resolveScope(orgId, null, "all");
const orgWide = await refusal({ measure: "mrr", ...win, segment: us.publicId }, orgScope);
ok(
  "an org-wide scope is refused — a segment belongs to one business",
  /belongs to one business/.test(orgWide?.message ?? ""),
);
const unknown = await refusal({ measure: "mrr", ...win, segment: "seg_doesnotexist" });
ok(
  "an unknown segment is refused",
  unknown?.param === "segment" && /no segment/.test(unknown.message),
);

const other = await createOrganization({ name: "Segment Analytics Other Org" });
const otherBiz = await createBusiness({
  organizationId: other.organization.id,
  name: "Elsewhere",
  defaultCurrency: "USD",
  livemode: "test",
});
const foreign = await createSegment({
  organizationId: other.organization.id,
  businessId: otherBiz.id,
  name: "Theirs",
  filters: [{ field: "country", op: "is", value: "US" }],
});
const crossed = await refusal({ measure: "mrr", ...win, segment: foreign.publicId });
ok("another organization's segment is refused, not answered", crossed?.param === "segment");

// ── D. Tiles and the API ──────────────────────────────────────────────────────────────────
const owner = "segment-analytics@example.test";
const board = await createDashboard({
  organizationId: orgId,
  businessId: biz.id,
  name: "Segments",
  owner,
});
const tile = await addTile(orgId, board.dashboard.publicId, owner, {
  reportKey: "mrr",
  segmentId: us.publicId,
});
ok("a measure tile stores segment_id", tile?.segmentId === us.publicId);
const tileRefusal = async (input: Parameters<typeof addTile>[3]) => {
  try {
    await addTile(orgId, board.dashboard.publicId, owner, input);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};
ok(
  "a report tile refuses a segment",
  /a segment applies to measures only/.test(
    await tileRefusal({ reportKey: "mrr_movement_summary", segmentId: us.publicId }),
  ),
);
ok(
  "an unsupported measure tile refuses a segment",
  /cannot be answered for a segment/.test(
    await tileRefusal({ reportKey: "billing_gross", segmentId: us.publicId }),
  ),
);
const resolved = await resolveDashboard(orgId, biz.id, board.dashboard.publicId, owner, {
  now: NOW,
});
const answered = resolved!.resolved.find((t) => t.id === tile!.publicId)!;
ok(
  "the tile is answered for its segment",
  answered.segment_id === us.publicId && answered.result?.segment?.id === us.publicId,
  answered.error ?? undefined,
);

// A segment that cannot resolve on its business is refused when the tile is SAVED — an unpinned
// `mrr` threshold (the High MRR starter) on a book billing in two currencies.
const mixed = await createBusiness({
  organizationId: orgId,
  name: "Two Currencies",
  defaultCurrency: "USD",
  livemode: "test",
});
for (const currency of ["USD", "EUR"] as const) {
  const p = await createProduct({
    organizationId: orgId,
    businessId: mixed.id,
    name: `Plan ${currency}`,
  });
  const pr = await createPrice({
    organizationId: orgId,
    businessId: mixed.id,
    productId: p.id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor: 1000,
    interval: "month",
  });
  const cu = await createCustomer({
    organizationId: orgId,
    businessId: mixed.id,
    email: `mixed-${currency}-${Date.now()}@example.test`,
    currency,
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: mixed.id,
    customerId: cu.id,
    now: day("2026-04-01"),
    startDate: day("2026-04-01"),
    items: [{ price: pr, quantity: 1 }],
  });
  await systemDb
    .update(subscriptions)
    .set({ status: "active", currency, mrr: 1000n })
    .where(eq(subscriptions.id, subscription.id));
}
const mixedBoard = await createDashboard({
  organizationId: orgId,
  businessId: mixed.id,
  name: "Mixed",
  owner,
});
ok(
  "saving a tile for a segment the business cannot resolve is refused, with the reason",
  /no usable exchange rate for EUR/.test(
    await (async () => {
      try {
        await addTile(orgId, mixedBoard.dashboard.publicId, owner, {
          reportKey: "mrr",
          segmentId: "seg_starter_high_mrr",
        });
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })(),
  ),
);
const orgBoard = await createDashboard({
  organizationId: orgId,
  businessId: null,
  name: "Org level",
  owner,
});
ok(
  "an org-level dashboard refuses a segment tile — a segment belongs to one business",
  /org-level/.test(
    await (async () => {
      try {
        await addTile(orgId, orgBoard.dashboard.publicId, owner, {
          reportKey: "mrr",
          segmentId: us.publicId,
        });
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })(),
  ),
);

const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${org.secret}` };
const get = await app.inject({
  method: "GET",
  url: `/v1/analytics?measure=mrr&grain=month&start=2026-04-01&end=2026-06-30&currency=USD&business=${biz.publicId}&livemode=test&segment=${us.publicId}`,
  headers: auth,
});
const g = JSON.parse(get.body);
ok(
  "GET carries segment= end to end",
  get.statusCode === 200 && g.segment?.id === us.publicId,
  get.body.slice(0, 200),
);
const batch = await app.inject({
  method: "POST",
  url: "/v1/analytics/query",
  headers: auth,
  payload: {
    business: biz.publicId,
    livemode: "test",
    grain: "month",
    start: "2026-04-01",
    end: "2026-06-30",
    currency: "USD",
    queries: [
      { key: "seg", measure: "mrr_churn", segment: us.publicId },
      { key: "bad", measure: "billing_gross", segment: us.publicId },
    ],
  },
});
const bt = JSON.parse(batch.body);
ok(
  "the batch carries segment per question, and refuses one alone",
  bt.data?.[0]?.segment?.id === us.publicId && bt.data?.[1]?.object === "analytics_error",
  batch.body.slice(0, 200),
);
const measures = JSON.parse(
  (await app.inject({ method: "GET", url: "/v1/analytics/measures", headers: auth })).body,
);
const flags = new Map<string, boolean>(
  measures.data.map((m: { id: string; segmentable: boolean }) => [m.id, m.segmentable]),
);
ok(
  "discovery publishes segmentable, matching what the engine accepts",
  [...flags].every(([id, s]) => s === SEGMENT_MEASURES.includes(id)) && flags.get("mrr") === true,
);
const listed = JSON.parse(
  (
    await app.inject({
      method: "GET",
      url: `/v1/businesses/${mixed.publicId}/customer_segments`,
      headers: auth,
    })
  ).body,
);
const high = listed.data?.find((x: { id: string }) => x.id === "seg_starter_high_mrr");
const active = listed.data?.find((x: { id: string }) => x.id === "seg_starter_active");
ok(
  "the segment list says which segments this business can answer, and why not",
  high?.answerable === false &&
    /no usable exchange rate for EUR/.test(high?.refusal ?? "") &&
    active?.answerable === true &&
    active?.refusal === null,
);
await app.close();

let failed = 0;
for (const [name, pass, detail] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${!pass && detail ? `\n      ${detail}` : ""}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
