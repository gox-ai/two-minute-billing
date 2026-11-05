/**
 * Meters, the fold and the reader (design G1a §3.1, §3.5, §8 verify:meters):
 *   §1 CRUD over the API; an id is unique per business.
 *   §2 lock: after the first event, and after the first price, only `name` changes (409).
 *   §3 archive is refused while a live subscription's price, or any active price, bills from
 *      the meter.
 *   §4 raw and rolled reads agree for sum, count, min, max, avg, last and unique, across
 *      edges that cut buckets; filters and group_by fold correctly; one event feeds two meters.
 *   §5 the tail: events received after the fold are read raw on top of the rollups.
 *   §6 backfill: a meter created after its events counts them, raw first, then rolled.
 *   §7 splitAt and per-bucket reads add up; a window under 30 minutes reads raw.
 *   §8 a cutoff reads rollups at or below its generation plus the raw tail before it.
 *   §9 voiding a folded event rebuilds its bucket (max falls to the next value).
 *
 *   pnpm verify:meters
 */
import { sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { divHalfUp, formatFixed12, parseFixed12, FIXED12_SCALE } from "@/platform/fixed";
import { createApiKey, createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { addUsageKey, createMeter, type Meter } from "@/modules/metering/meters";
import { foldBusiness } from "@/modules/metering/fold";
import { ingestUsageEvents, voidUsageEvent } from "@/modules/metering/ingest";
import { readMeterUsage, takeUsageCutoff, type MeterUsage } from "@/modules/metering/read";
import { floor15 } from "@/modules/metering/usage-sql";

const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);
const uniq = Date.now().toString(36);

const org = await createOrganization({ name: `Meters ${uniq}` });
const orgId = org.organization.id;
await systemDb.execute(
  sql`update organizations set ingest_rate_limit_per_second = 100000 where id = ${orgId}`,
);
const app = await buildApp({ logger: false });
const { secret } = await createApiKey(orgId, "test");
const biz = await createBusiness({
  organizationId: orgId,
  name: `Meters Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const base = `/v1/businesses/${biz.publicId}`;
let n = 0;
const call = async (method: "GET" | "POST" | "PATCH", url: string, body?: unknown) => {
  const res = await app.inject({
    method,
    url: `${base}${url}`,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(method !== "GET" ? { "idempotency-key": `meters-${uniq}-${n++}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, json: res.json() as any };
};
const fold = () =>
  runWithClockScope({ onlyBusinessId: biz.id }, () => foldBusiness({ ...ctx, graceMs: 0 }));
const ingest = (events: unknown[]) => ingestUsageEvents({ ...ctx, events });
const iso = (ms: number) => new Date(ms).toISOString();

// ── §1 CRUD ───────────────────────────────────────────────────────────────────────────────
const created = await call("POST", "/meters", {
  id: "api-calls",
  name: "API calls",
  event_name: "api_call",
  aggregation: "count",
});
ok(
  "§1 create answers 201 with the id and locked=false",
  created.status === 201 && created.json.id === "api-calls" && created.json.locked === false,
  JSON.stringify(created.json),
);
const dupe = await call("POST", "/meters", {
  id: "api-calls",
  name: "x",
  event_name: "y",
  aggregation: "count",
});
ok("§1 the same id twice → 409", dupe.status === 409);
const badDef = await call("POST", "/meters", { name: "Bad", event_name: "y", aggregation: "sum" });
ok("§1 sum without value_property → 400", badDef.status === 400);
const fetched = await call("GET", "/meters/api-calls");
ok("§1 retrieve by id", fetched.status === 200 && fetched.json.event_name === "api_call");
const listed = await call("GET", "/meters");
ok(
  "§1 list carries locked",
  listed.status === 200 &&
    listed.json.data.some((m: any) => m.id === "api-calls" && m.locked === false),
);
const renamed = await call("PATCH", "/meters/api-calls", { name: "API requests" });
ok("§1 rename", renamed.status === 200 && renamed.json.name === "API requests");
const unusedChange = await call("PATCH", "/meters/api-calls", { event_name: "api_request" });
ok(
  "§1 an unused meter's definition can change",
  unusedChange.status === 200 && unusedChange.json.event_name === "api_request",
);

// ── §2 lock ───────────────────────────────────────────────────────────────────────────────
const customer = await createCustomer({ ...ctx, email: `meters-${uniq}@example.com` });
await addUsageKey({ ...ctx, customerId: customer.id, key: "ws" });
await ingest([{ key: "lock-1", customer: "ws", event_name: "api_request" }]);
const lockedAgg = await call("PATCH", "/meters/api-calls", {
  aggregation: "sum",
  value_property: "n",
});
ok(
  "§2 after the first event, PATCH aggregation → 409",
  lockedAgg.status === 409 &&
    /You cannot change aggregation on this meter/.test(lockedAgg.json?.error?.message ?? ""),
  JSON.stringify(lockedAgg.json),
);
const lockedName = await call("PATCH", "/meters/api-calls", { name: "Requests" });
ok("§2 …and name still changes", lockedName.status === 200 && lockedName.json.locked === true);

const product = await createProduct({ ...ctx, name: "Usage" });
const metered = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "usage",
  currency: "USD",
  amountMinor: 5,
  interval: "month",
  usageAggregation: "sum",
});
await call("POST", "/meters", {
  id: "priced",
  name: "Priced",
  event_name: "never_sent",
  aggregation: "sum",
  value_property: "n",
});
await withTenant(orgId, (tx) =>
  tx.execute(
    sql`update prices set meter_id = (select id from meters where business_id = ${biz.id} and key = 'priced') where id = ${metered.id}`,
  ),
);
const lockedByPrice = await call("PATCH", "/meters/priced", { value_property: "m" });
ok("§2 after the first price, PATCH → 409", lockedByPrice.status === 409);

// ── §3 archive ────────────────────────────────────────────────────────────────────────────
await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
await withTenant(orgId, (tx) =>
  tx.execute(sql`update prices set meter_id = null where id = ${metered.id}`),
);
await createSubscription({
  ...ctx,
  customerId: customer.id,
  now: new Date(),
  items: [{ price: metered, quantity: 1 }],
});
await withTenant(orgId, (tx) =>
  tx.execute(
    sql`update prices set meter_id = (select id from meters where business_id = ${biz.id} and key = 'priced') where id = ${metered.id}`,
  ),
);
const archiveLive = await call("POST", "/meters/priced/archive");
ok(
  "§3 archive is refused while a live subscription bills from it",
  archiveLive.status === 409,
  JSON.stringify(archiveLive.json),
);
const archiveFree = await call("POST", "/meters/api-calls/archive");
ok(
  "§3 an unpriced meter archives",
  archiveFree.status === 200 && archiveFree.json.status === "archived",
);

// A price with no subscription still bills from the meter: archive is refused until the
// price is archived.
await call("POST", "/meters", {
  id: "price-only",
  name: "Price only",
  event_name: "never_sent_2",
  aggregation: "count",
});
const priceOnly = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: "price-only",
  unitAmountDecimal: "1",
});
const archivePriced = await call("POST", "/meters/price-only/archive");
ok(
  "§3 archive is refused while an active price bills from it, and the message names the price",
  archivePriced.status === 409 &&
    (archivePriced.json?.error?.message ?? "").includes(priceOnly.publicId),
  JSON.stringify(archivePriced.json),
);
await withTenant(orgId, (tx) =>
  tx.execute(sql`update prices set active = false where id = ${priceOnly.id}`),
);
const archiveAfter = await call("POST", "/meters/price-only/archive");
ok(
  "§3 …and archives once that price is archived",
  archiveAfter.status === 200 && archiveAfter.json.status === "archived",
  JSON.stringify(archiveAfter.json),
);

// ── §4 raw = rolled for every aggregation ─────────────────────────────────────────────────
const mk = (key: string, d: Record<string, unknown>) =>
  createMeter({
    ...ctx,
    key,
    definition: { name: key, eventName: "calls", groupBy: ["model"], ...d } as never,
  });
const meters: Record<string, Meter> = {
  sum: await mk("m-sum", { aggregation: "sum", valueProperty: "v" }),
  count: await mk("m-count", { aggregation: "count" }),
  min: await mk("m-min", { aggregation: "min", valueProperty: "v" }),
  max: await mk("m-max", { aggregation: "max", valueProperty: "v" }),
  avg: await mk("m-avg", { aggregation: "avg", valueProperty: "v" }),
  last: await mk("m-last", { aggregation: "last", valueProperty: "v" }),
  unique: await mk("m-unique", { aggregation: "unique", uniqueProperty: "user" }),
  eu: await mk("m-eu", {
    aggregation: "sum",
    valueProperty: "v",
    filters: { region: ["eu"] },
    groupBy: ["model", "token_type"],
  }),
};

const B = floor15(Date.now() - 2 * 86_400_000);
interface Ev {
  key: string;
  at: number;
  v: string;
  model: string;
  region: string;
  user: string;
  tt: string;
}
const evs: Ev[] = [];
for (let i = 0; i < 48; i++) {
  evs.push({
    key: `c-${i}`,
    at: B + i * 3 * 60_000 + (i % 5) * 1_000,
    v: `${(i * 37) % 11}.${String((i * 7919) % 1000).padStart(3, "0")}`,
    model: i % 3 === 0 ? "a" : "b",
    region: i % 2 === 0 ? "eu" : "us",
    user: `u${i % 5}`,
    tt: i % 4 === 0 ? "input" : "output",
  });
}
const toWire = (e: Ev) => ({
  key: e.key,
  customer: "ws",
  event_name: "calls",
  timestamp: iso(e.at),
  properties: { v: e.v, model: e.model, region: e.region, user: e.user, token_type: e.tt },
});
const r1 = await ingest(evs.map(toWire));
ok(
  "§4 48 events stored",
  r1.every((r) => r.status === "created"),
  JSON.stringify(r1.find((r) => r.status !== "created")),
);

// Edges cut buckets: 00:07:30 into the first quarter hour, to 02:04 into a later one.
const W = {
  start: new Date(B + 7 * 60_000 + 30_000),
  end: new Date(B + 2 * 3_600_000 + 4 * 60_000),
};
const inW = (e: Ev) => e.at >= W.start.getTime() && e.at < W.end.getTime();
function expected(agg: string, list: Ev[]): Record<string, string> {
  const out: Record<string, string> = {};
  const groups = new Map<string, Ev[]>();
  for (const e of list) groups.set(e.model, [...(groups.get(e.model) ?? []), e]);
  for (const [g, es] of groups) {
    const vals = es.map((e) => parseFixed12(e.v));
    const sum = vals.reduce((a, b) => a + b, 0n);
    const last = [...es].sort((a, b) => a.at - b.at).at(-1)!;
    const v =
      agg === "sum"
        ? sum
        : agg === "count"
          ? BigInt(es.length) * FIXED12_SCALE
          : agg === "min"
            ? vals.reduce((a, b) => (b < a ? b : a))
            : agg === "max"
              ? vals.reduce((a, b) => (b > a ? b : a))
              : agg === "avg"
                ? divHalfUp(sum, BigInt(es.length))
                : agg === "last"
                  ? parseFixed12(last.v)
                  : BigInt(new Set(es.map((e) => e.user)).size) * FIXED12_SCALE;
    out[g] = formatFixed12(v);
  }
  return Object.fromEntries(Object.entries(out).sort());
}
const flat = (u: MeterUsage) =>
  Object.fromEntries(
    u.segments
      .flatMap((s) => s.rows)
      .map((r) => [r.groupValues.join("|"), formatFixed12(r.quantity)] as [string, string])
      .sort(),
  );
const read = (m: Meter, extra: Partial<Parameters<typeof readMeterUsage>[1]> = {}) =>
  withTenant(orgId, (tx) =>
    readMeterUsage(tx, { customerId: customer.id, meterId: m.id, window: W, ...extra }),
  );

const rawReads: Record<string, MeterUsage> = {};
for (const [agg, m] of Object.entries(meters)) if (agg !== "eu") rawReads[agg] = await read(m);
await fold();
for (const [agg, m] of Object.entries(meters)) {
  if (agg === "eu") continue;
  const rolled = await read(m);
  const want = expected(agg, evs.filter(inW));
  ok(
    `§4 ${agg}: raw and rolled reads agree and are exact at both edges`,
    JSON.stringify(flat(rawReads[agg]!)) === JSON.stringify(want) &&
      JSON.stringify(flat(rolled)) === JSON.stringify(want) &&
      rolled.usedRollups === (agg !== "unique") &&
      rawReads[agg]!.usedRollups === false,
    `want ${JSON.stringify(want)} raw ${JSON.stringify(flat(rawReads[agg]!))} rolled ${JSON.stringify(flat(rolled))} used=${rolled.usedRollups}`,
  );
}
const euRead = await read(meters.eu!);
const euWant: Record<string, bigint> = {};
for (const e of evs.filter(inW).filter((e) => e.region === "eu"))
  euWant[`${e.model}|${e.tt}`] = (euWant[`${e.model}|${e.tt}`] ?? 0n) + parseFixed12(e.v);
const euGot = flat(euRead);
ok(
  "§4 filters and a two-property group_by fold correctly; the event also fed m-sum",
  euRead.usedRollups &&
    Object.keys(euWant).length === Object.keys(euGot).length &&
    Object.entries(euWant).every(([k, v]) => euGot[k] === formatFixed12(v)),
  `${JSON.stringify(euGot)}`,
);

// ── §5 tail ───────────────────────────────────────────────────────────────────────────────
const tailEv: Ev = {
  key: "c-tail",
  at: B + 60 * 60_000 + 1_000,
  v: "100.5",
  model: "a",
  region: "eu",
  user: "u9",
  tt: "input",
};
await ingest([toWire(tailEv)]);
evs.push(tailEv);
const withTail = await read(meters.sum!);
ok(
  "§5 an event received after the fold is read from the tail, once",
  JSON.stringify(flat(withTail)) === JSON.stringify(expected("sum", evs.filter(inW))),
  JSON.stringify(flat(withTail)),
);
await fold();
const afterTailFold = await read(meters.sum!);
ok(
  "§5 …and once more after it is folded (no double count)",
  JSON.stringify(flat(afterTailFold)) === JSON.stringify(flat(withTail)),
);

// ── §6 backfill ───────────────────────────────────────────────────────────────────────────
await ingest(
  evs.slice(0, 20).map((e) => ({ ...toWire(e), key: `late-${e.key}`, event_name: "later" })),
);
await fold();
const later = await createMeter({
  ...ctx,
  key: "m-later",
  definition: {
    name: "Later",
    eventName: "later",
    aggregation: "sum",
    valueProperty: "v",
    groupBy: ["model"],
  },
});
const laterWant = expected("sum", evs.slice(0, 20).filter(inW));
const beforeBackfill = await read(later);
ok(
  "§6 a meter created after its events counts them at once (raw)",
  !beforeBackfill.usedRollups && JSON.stringify(flat(beforeBackfill)) === JSON.stringify(laterWant),
  JSON.stringify(flat(beforeBackfill)),
);
await fold();
const [lm] = (await systemDb.execute(
  sql`select backfilled_at from meters where id = ${later.id}`,
)) as unknown as Array<{ backfilled_at: Date | null }>;
const afterBackfill = await read(later);
ok(
  "§6 the backfill folds them; reads switch to rollups and agree",
  lm?.backfilled_at != null &&
    afterBackfill.usedRollups &&
    JSON.stringify(flat(afterBackfill)) === JSON.stringify(laterWant),
  JSON.stringify(flat(afterBackfill)),
);

// ── §7 splitAt, buckets, short windows ────────────────────────────────────────────────────
const split = new Date(B + 47 * 60_000 + 13_000);
const segs = await read(meters.sum!, { splitAt: [split] });
const sortKeys = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort());
const segWant = [
  sortKeys(
    expected(
      "sum",
      evs.filter((e) => inW(e) && e.at < split.getTime()),
    ),
  ),
  sortKeys(
    expected(
      "sum",
      evs.filter((e) => inW(e) && e.at >= split.getTime()),
    ),
  ),
];
const segGot = segs.segments.map((s) =>
  sortKeys(
    Object.fromEntries(s.rows.map((r) => [r.groupValues.join("|"), formatFixed12(r.quantity)])),
  ),
);
ok(
  "§7 splitAt reads a mid-bucket instant as an edge; each segment is exact",
  JSON.stringify(segGot) === JSON.stringify(segWant),
  `${JSON.stringify(segGot)} want ${JSON.stringify(segWant)}`,
);
const buckets = await read(meters.sum!, { granularity: "bucket" });
const bucketTotal = buckets.segments[0]!.rows.filter((r) => r.groupValues[0] === "a").reduce(
  (a, r) => a + r.quantity,
  0n,
);
ok(
  "§7 per-bucket rows add up to the total",
  formatFixed12(bucketTotal) === expected("sum", evs.filter(inW)).a &&
    buckets.segments[0]!.rows.every((r) => r.bucketStart),
);
const short = await read(meters.sum!, {
  window: { start: new Date(B + 15 * 60_000), end: new Date(B + 44 * 60_000) },
});
ok("§7 a window under 30 minutes reads wholly raw", short.usedRollups === false);

// ── §8 cutoff ─────────────────────────────────────────────────────────────────────────────
await withTenant(orgId, (tx) =>
  tx.execute(
    sql`insert into customer_meter_billing (customer_id, meter_id, organization_id, business_id) values (${customer.id}, ${meters.sum!.id}, ${orgId}, ${biz.id})`,
  ),
);
const cutoff = await withTenant(orgId, (tx) =>
  takeUsageCutoff(tx, { ...ctx, customerId: customer.id, meterId: meters.sum!.id }),
);
// A bucket-aligned window: no raw edges, so the cutoff's grace on raw reads plays no part.
const aligned = { start: new Date(B), end: new Date(B + 2 * 3_600_000) };
const atCutoff = flat(await read(meters.sum!, { window: aligned }));
const afterEv: Ev = {
  key: "c-after",
  at: B + 90 * 60_000,
  v: "1000",
  model: "a",
  region: "us",
  user: "u1",
  tt: "input",
};
await ingest([toWire(afterEv)]);
await fold();
const readCut = flat(await read(meters.sum!, { window: aligned, cutoff }));
const [genRow] = (await systemDb.execute(
  sql`select generation::text as g from customer_meter_billing where customer_id = ${customer.id} and meter_id = ${meters.sum!.id}`,
)) as unknown as Array<{ g: string }>;
ok(
  "§8 a cutoff moves the generation and excludes rollups folded after it",
  cutoff.generation === 0n &&
    genRow?.g === "1" &&
    JSON.stringify(readCut) === JSON.stringify(atCutoff),
  `gen=${cutoff.generation}/${genRow?.g} cut=${JSON.stringify(readCut)} at=${JSON.stringify(atCutoff)}`,
);
evs.push(afterEv);
ok(
  "§8 without a cutoff the new event counts",
  JSON.stringify(flat(await read(meters.sum!))) ===
    JSON.stringify(expected("sum", evs.filter(inW))),
);

// ── §9 void rebuilds a bucket ─────────────────────────────────────────────────────────────
const inWa = evs.filter((e) => inW(e) && e.model === "a");
const top = inWa.reduce((a, b) => (parseFixed12(b.v) > parseFixed12(a.v) ? b : a));
await voidUsageEvent({ ...ctx, key: top.key });
const remaining = evs.filter((e) => e.key !== top.key);
const maxAfter = flat(await read(meters.max!));
ok(
  "§9 voiding the max event of a folded bucket: max falls to the next value",
  maxAfter.a === expected("max", remaining.filter(inW)).a,
  `${maxAfter.a} vs ${expected("max", remaining.filter(inW)).a}`,
);
ok(
  "§9 …and the sum drops by its value",
  flat(await read(meters.sum!)).a === expected("sum", remaining.filter(inW)).a,
);

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? "✅" : "❌"} ${name}${pass || !detail ? "" : ` — ${detail}`}`);
}
console.log(
  failed === 0
    ? `\n✅ METERS: PASS (${checks.length})`
    : `\n❌ METERS: FAIL (${failed}/${checks.length})`,
);
await app.close();
await closeDb();
process.exit(failed === 0 ? 0 : 1);
