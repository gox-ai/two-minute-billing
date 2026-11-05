/**
 * Usage event ingest (design G1a §3.3, §3.10, §3.11, §8 verify:usage-events):
 *   §1 dedup: a replayed event and a retry with a new timestamp count once.
 *   §2 batch: 500 with 3 bad → 497 created + 3 per-event errors; 501 → 400.
 *   §3 timestamps: no offset or epoch → 400; −36 days / +6 min → per-event codes.
 *   §4 values: 13 dp (string and JSON number), "abc" and above 10^12 → invalid_value, nothing stored;
 *      a JSON number keeps every digit.
 *   §5 atomicity: a failure after the event insert leaves neither the dedup row nor the event.
 *   §6 matching: an unmatched event counts once its key is attached, behind and ahead of the
 *      watermark.
 *   §7 the unmatched notice fires once per business per hour.
 *   §8 void: counted no more; refused once an invoice bills the period.
 *   §9 rate limit: two keys of one org share one limit; a batch is one request; headers on
 *      2xx, Retry-After on 429; the per-key API counter is not used.
 *   §10 request log keeps no body on 2xx. §11 another org cannot list or void.
 *
 *   pnpm verify:usage-events
 */
import { sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createApiKey, createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { flushRequestLogs } from "@/modules/request-log/flush";
import { createMeter, addUsageKey } from "@/modules/metering/meters";
import { foldBusiness } from "@/modules/metering/fold";
import { readMeterUsage } from "@/modules/metering/read";
import { registerIngestHook } from "@/modules/metering/ingest";
import { runUnmatchedNotice } from "@/modules/metering/notice";
import { formatFixed12 } from "@/platform/fixed";

const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);
const uniq = Date.now().toString(36);

const org = await createOrganization({ name: `Usage Events ${uniq}` });
const orgId = org.organization.id;
// A high limit, so only §9 meets the limiter.
await systemDb.execute(
  sql`update organizations set ingest_rate_limit_per_second = 100000 where id = ${orgId}`,
);
const app = await buildApp({ logger: false });
const keyA = (await createApiKey(orgId, "test")).secret;
const keyB = (await createApiKey(orgId, "test")).secret;
const biz = await createBusiness({
  organizationId: orgId,
  name: `Usage Events Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const base = `/v1/businesses/${biz.publicId}`;

const send = async (url: string, body: unknown, opts: { key?: string; raw?: boolean } = {}) => {
  const res = await app.inject({
    method: "POST",
    url: `${base}${url}`,
    headers: { authorization: `Bearer ${opts.key ?? keyA}`, "content-type": "application/json" },
    payload: opts.raw ? (body as string) : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* empty */
  }
  return { status: res.statusCode, json, headers: res.headers, raw: res.body };
};
const get = async (url: string, key = keyA) => {
  const res = await app.inject({
    method: "GET",
    url: `${base}${url}`,
    headers: { authorization: `Bearer ${key}` },
  });
  return { status: res.statusCode, json: res.json() as any };
};
const fold = () =>
  runWithClockScope({ onlyBusinessId: biz.id }, () => foldBusiness({ ...ctx, graceMs: 0 }));
const stored = async (key: string) => {
  const rows = (await systemDb.execute(sql`
    select key, "timestamp", properties ->> 'tokens' as tokens, properties::text as props
    from usage_events where business_id = ${biz.id} and key = ${key}`)) as unknown as Array<{
    key: string;
    timestamp: Date;
    tokens: string | null;
    props: string;
  }>;
  return rows;
};
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

const customer = await createCustomer({ ...ctx, email: `usage-${uniq}@example.com` });
await addUsageKey({ ...ctx, customerId: customer.id, key: "ws-1" });
const meter = await createMeter({
  ...ctx,
  key: "tokens",
  definition: {
    name: "Tokens",
    eventName: "ai_tokens",
    aggregation: "sum",
    valueProperty: "tokens",
  },
});

// ── §1 dedup ──────────────────────────────────────────────────────────────────────────────
const t0 = iso(now - 3_600_000);
const first = await send("/usage_events", {
  key: "e-1",
  customer: "ws-1",
  event_name: "ai_tokens",
  timestamp: t0,
  properties: { tokens: 10 },
});
ok(
  "§1 a new event answers 201 created",
  first.status === 201 && first.json?.status === "created",
  JSON.stringify(first.json),
);
ok("§1 the answer names the customer", first.json?.event?.customer === customer.publicId);
const replay = await send("/usage_events", {
  key: "e-1",
  customer: "ws-1",
  event_name: "ai_tokens",
  timestamp: t0,
  properties: { tokens: 10 },
});
ok(
  "§1 a replay answers 200 duplicate",
  replay.status === 200 && replay.json?.status === "duplicate",
);
const retry = await send("/usage_events", {
  key: "e-1",
  customer: "ws-1",
  event_name: "ai_tokens",
  timestamp: iso(now - 1_800_000),
  properties: { tokens: 99 },
});
const e1 = await stored("e-1");
ok(
  "§1 a retry with a new timestamp and value counts once (dedup has no timestamp)",
  retry.json?.status === "duplicate" && e1.length === 1 && e1[0]!.tokens === "10",
  `${retry.json?.status} rows=${e1.length}`,
);
ok("§1 the duplicate answer is the stored event", retry.json?.event?.timestamp === t0);
const unmatched = await send("/usage_events", {
  key: "e-unmatched",
  customer: "nobody-yet",
  event_name: "ai_tokens",
  timestamp: t0,
  properties: { tokens: 5 },
});
ok(
  "§1 an unknown customer key is stored unmatched (customer null)",
  unmatched.status === 201 &&
    unmatched.json?.event?.customer === null &&
    unmatched.json?.event?.status === "unmatched",
);

// ── §2 batch ──────────────────────────────────────────────────────────────────────────────
const batch = Array.from({ length: 500 }, (_, i) => ({
  key: `b-${i}`,
  customer: "ws-1",
  event_name: "ai_tokens",
  timestamp: iso(now - 600_000 - i * 1000),
  properties: { tokens: 1 },
}));
batch[7] = { ...batch[7]!, timestamp: "2026-01-01 10:00:00" };
batch[100] = { ...batch[100]!, properties: { tokens: "abc" as unknown as number } };
batch[499] = { ...batch[499]!, timestamp: iso(now - 40 * 86_400_000) };
const counterSum = async () =>
  Number(
    (
      (await systemDb.execute(
        sql`select coalesce(sum(count), 0)::int as n from ingest_rate_counters where organization_id = ${orgId}`,
      )) as unknown as Array<{ n: number }>
    )[0]!.n,
  );
const beforeBatch = await counterSum();
const b1 = await send("/usage_events/batch", { events: batch });
const afterBatch = await counterSum();
ok(
  "§2 a batch of 500 with 3 bad: 497 created, 3 errors",
  b1.json?.created === 497 && b1.json?.errors === 3,
  JSON.stringify({ c: b1.json?.created, e: b1.json?.errors }),
);
ok(
  "§2 the errors are per event, with their index and code",
  b1.json?.results?.[7]?.error?.code === "invalid_request" &&
    b1.json?.results?.[100]?.error?.code === "invalid_value" &&
    b1.json?.results?.[499]?.error?.code === "timestamp_too_old",
);
ok(
  "§9 a batch of 500 counts as one request",
  afterBatch - beforeBatch === 1,
  `${beforeBatch}→${afterBatch}`,
);
const b2 = await send("/usage_events/batch", { events: batch });
ok(
  "§2 a replayed batch counts once (497 duplicates)",
  b2.json?.created === 0 && b2.json?.duplicates === 497,
);
const b501 = await send("/usage_events/batch", { events: [...batch, batch[0]] });
ok("§2 501 events → 400", b501.status === 400);
const bad = await send("/usage_events/batch", { events: "nope" });
ok("§2 a malformed envelope → 400", bad.status === 400);

// ── §3 timestamps ─────────────────────────────────────────────────────────────────────────
const ev = (key: string, extra: Record<string, unknown>) => ({
  key,
  customer: "ws-1",
  event_name: "ai_tokens",
  properties: { tokens: 1 },
  ...extra,
});
const noOffset = await send("/usage_events", ev("t-1", { timestamp: "2026-10-31T10:00:00" }));
ok("§3 RFC 3339 without an offset → 400", noOffset.status === 400);
const epoch = await send("/usage_events", ev("t-2", { timestamp: Math.floor(now / 1000) }));
ok("§3 an epoch number → 400", epoch.status === 400);
const old = await send("/usage_events", ev("t-3", { timestamp: iso(now - 36 * 86_400_000) }));
ok(
  "§3 −36 days → timestamp_too_old",
  old.status === 422 && old.json?.error?.code === "timestamp_too_old",
);
const future = await send("/usage_events", ev("t-4", { timestamp: iso(now + 6 * 60_000) }));
ok(
  "§3 +6 minutes → timestamp_in_future",
  future.status === 422 && future.json?.error?.code === "timestamp_in_future",
);
ok(
  "§3 nothing outside the window is stored",
  (await stored("t-3")).length + (await stored("t-4")).length === 0,
);

// ── §4 values ─────────────────────────────────────────────────────────────────────────────
const s13 = await send("/usage_events", ev("v-1", { properties: { tokens: "0.1234567890123" } }));
ok(
  "§4 13 dp as a string → invalid_value",
  s13.json?.error?.code === "invalid_value",
  JSON.stringify(s13.json),
);
const n13 = await send(
  "/usage_events",
  `{"key":"v-2","customer":"ws-1","event_name":"ai_tokens","properties":{"tokens":0.1234567890123}}`,
  { raw: true },
);
ok(
  "§4 13 dp as a JSON number → invalid_value (read from source text)",
  n13.json?.error?.code === "invalid_value",
  JSON.stringify(n13.json),
);
const abc = await send("/usage_events", ev("v-3", { properties: { tokens: "abc" } }));
ok('§4 "abc" → invalid_value', abc.json?.error?.code === "invalid_value");
ok(
  "§4 nothing refused was stored (never truncated)",
  (await stored("v-1")).length + (await stored("v-2")).length + (await stored("v-3")).length === 0,
);
const exact = await send(
  "/usage_events",
  `{"key":"v-4","customer":"ws-1","event_name":"ai_tokens","properties":{"tokens":1234567890.123456789012}}`,
  { raw: true },
);
const v4 = await stored("v-4");
ok(
  "§4 a JSON number keeps every digit (stored and echoed)",
  exact.status === 201 &&
    v4[0]?.tokens === "1234567890.123456789012" &&
    exact.raw.includes("1234567890.123456789012"),
  `${exact.status} ${v4[0]?.tokens}`,
);
const exp = await send(
  "/usage_events",
  `{"key":"v-5","customer":"ws-1","event_name":"ai_tokens","properties":{"tokens":1.5e-3}}`,
  { raw: true },
);
ok(
  "§4 an exponent is expanded exactly",
  exp.status === 201 && (await stored("v-5"))[0]?.tokens === "0.0015",
);
const neg = await send("/usage_events", ev("v-6", { properties: { tokens: -1 } }));
ok(
  "§4 a negative value on a non-recurring sum → invalid_value",
  neg.json?.error?.code === "invalid_value",
);

const huge = await send(
  "/usage_events",
  ev("v-7", { properties: { tokens: "1000000000000.000000000001" } }),
);
ok(
  "§4 a value above 10^12 → invalid_value, nothing stored",
  huge.json?.error?.code === "invalid_value" && (await stored("v-7")).length === 0,
  JSON.stringify(huge.json),
);
const hugeAmount = await send("/usage_events", ev("v-8", { amount: "1000000000001" }));
ok(
  "§4 an amount above 10^12 → invalid_value",
  hugeAmount.json?.error?.code === "invalid_value",
  JSON.stringify(hugeAmount.json),
);
const atCap = await send("/usage_events", ev("v-9", { properties: { tokens: "1000000000000" } }));
ok("§4 exactly 10^12 is taken", atCap.status === 201, JSON.stringify(atCap.json));

// ── §5 atomicity ──────────────────────────────────────────────────────────────────────────
let failNext = false;
registerIngestHook(async () => {
  if (failNext) {
    failNext = false;
    throw new Error("simulated crash after the event insert");
  }
});
failNext = true;
const crashed = await app.inject({
  method: "POST",
  url: `${base}/usage_events`,
  headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
  payload: JSON.stringify(ev("crash-1", {})),
});
const dedupLeft = (await systemDb.execute(
  sql`select count(*)::int as n from usage_event_dedup where business_id = ${biz.id} and key = 'crash-1'`,
)) as unknown as Array<{ n: number }>;
ok(
  "§5 a failure after the insert leaves neither the dedup row nor the event",
  crashed.statusCode >= 500 && dedupLeft[0]!.n === 0 && (await stored("crash-1")).length === 0,
);
const again = await send("/usage_events", ev("crash-1", {}));
ok("§5 the same key then records normally", again.status === 201);

// ── §6 matching ───────────────────────────────────────────────────────────────────────────
const late = await createCustomer({ ...ctx, email: `late-${uniq}@example.com` });
const lateTs = now - 7_200_000;
await send(
  "/usage_events",
  ev("m-behind", { customer: "late-key", timestamp: iso(lateTs), properties: { tokens: 7 } }),
);
await fold(); // folds past it: it stays unmatched behind the watermark
await addUsageKey({ ...ctx, customerId: late.id, key: "late-key" });
await send(
  "/usage_events",
  ev("m-ahead", {
    customer: "late-key",
    timestamp: iso(lateTs + 60_000),
    properties: { tokens: 3 },
  }),
);
// m-ahead was sent after the key existed, so it matched at ingest.
const window = { start: new Date(lateTs - 3_600_000), end: new Date(now) };
const read = async (customerId: string) =>
  withTenant(orgId, (tx) => readMeterUsage(tx, { customerId, meterId: meter.id, window }));
const beforeMatch = await read(late.id);
const sumOf = (u: Awaited<ReturnType<typeof read>>) =>
  formatFixed12(u.segments.flatMap((s) => s.rows).reduce((a, r) => a + r.quantity, 0n));
ok(
  "§6 before the fold matches it, the unmatched event does not count",
  sumOf(beforeMatch) === "3",
  sumOf(beforeMatch),
);
await fold();
const afterMatch = await read(late.id);
ok(
  "§6 after the key is attached and the fold runs, both count (behind the watermark too)",
  sumOf(afterMatch) === "10",
  sumOf(afterMatch),
);
const matchedRow = (await systemDb.execute(
  sql`select matched_at from usage_events where business_id = ${biz.id} and key = 'm-behind'`,
)) as unknown as Array<{ matched_at: Date | null }>;
ok("§6 a late match is stamped matched_at", matchedRow[0]?.matched_at != null);

// ── §7 unmatched notice ───────────────────────────────────────────────────────────────────
await send("/usage_events", ev("u-1", { customer: "ghost-1" }));
await send("/usage_events", ev("u-2", { customer: "ghost-2" }));
const nextHour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000 + 60_000);
await runWithClockScope({ onlyBusinessId: biz.id }, () => runUnmatchedNotice(nextHour));
await runWithClockScope({ onlyBusinessId: biz.id }, () => runUnmatchedNotice(nextHour));
const notices = (await systemDb.execute(
  sql`select data from events where business_id = ${biz.id} and type = 'usage_event_unmatched'`,
)) as unknown as Array<{ data: any }>;
ok(
  "§7 usage_event_unmatched fires once for the hour, naming the keys",
  notices.length === 1 &&
    notices[0]!.data.usage_event.customer_keys.includes("ghost-1") &&
    notices[0]!.data.usage_event.count >= 2,
  JSON.stringify(notices.map((n) => n.data)),
);

// ── §8 void ───────────────────────────────────────────────────────────────────────────────
await fold();
const voidIdem = (k: string) => ({ "idempotency-key": `void-${uniq}-${k}` });
const voidCall = async (body: unknown, key = keyA) => {
  const res = await app.inject({
    method: "POST",
    url: `${base}/usage_events/void`,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...voidIdem(JSON.stringify(body) + key),
    },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, json: res.json() as any };
};
const v1 = await voidCall({ key: "m-ahead", reason: "test" });
ok(
  "§8 void answers the event as voided",
  v1.status === 200 && v1.json?.event?.status === "voided",
  JSON.stringify(v1.json),
);
const afterVoid = await read(late.id);
ok("§8 a voided (folded) event no longer counts", sumOf(afterVoid) === "7", sumOf(afterVoid));
await withTenant(orgId, (tx) =>
  tx.execute(sql`insert into customer_meter_billing (customer_id, meter_id, organization_id, business_id, usage_through)
    values (${late.id}, ${meter.id}, ${orgId}, ${biz.id}, ${iso(now)}::timestamptz)`),
);
const v2 = await voidCall({ key: "m-behind" });
ok(
  "§8 void is refused once an invoice bills the period (409)",
  v2.status === 409,
  JSON.stringify(v2.json),
);

// ── §9 rate limit ─────────────────────────────────────────────────────────────────────────
const ok2xx = await send("/usage_events", ev("r-0", {}));
ok(
  "§9 a 2xx carries X-RateLimit-Limit/Remaining/Reset",
  ok2xx.status === 201 &&
    ok2xx.headers["x-ratelimit-limit"] === "100000" &&
    ok2xx.headers["x-ratelimit-remaining"] != null &&
    ok2xx.headers["x-ratelimit-reset"] != null,
);
const perKey = async () =>
  Number(
    (
      (await systemDb.execute(
        sql`select coalesce(sum(c.count),0)::int as n from rate_limit_counters c join api_keys k on k.id = c.api_key_id where k.organization_id = ${orgId}`,
      )) as unknown as Array<{ n: number }>
    )[0]!.n,
  );
const pk0 = await perKey();
await send("/usage_events", ev("r-1", {}));
await send("/usage_events/batch", { events: [ev("r-2", {})] });
const pk1 = await perKey();
await get("/usage_events?limit=1");
const pk2 = await perKey();
ok(
  "§9 ingest does not use the per-key API counter (a read does)",
  pk1 === pk0 && pk2 === pk0 + 1,
  `${pk0} ${pk1} ${pk2}`,
);
await systemDb.execute(
  sql`update organizations set ingest_rate_limit_per_second = 3 where id = ${orgId}`,
);
// Start at the top of a fresh second, so earlier requests are in another window.
await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 5));
const burst = [];
for (const [i, k] of [keyA, keyB, keyA, keyB].entries())
  burst.push(await send("/usage_events", ev(`r-burst-${i}`, {}), { key: k }));
const statuses = burst.map((b) => b.status);
ok(
  "§9 two keys of one org share one limit (4th request in the second → 429)",
  statuses.slice(0, 3).every((s) => s === 201) && statuses[3] === 429,
  `${statuses.join(",")} ${JSON.stringify(burst[0]!.headers["x-ratelimit-limit"])} ${JSON.stringify(burst[0]!.json)}`,
);
ok(
  "§9 a 429 carries Retry-After and the message",
  burst[3]!.headers["retry-after"] != null &&
    /usage requests in one second/.test(burst[3]!.json?.error?.message ?? ""),
);
await systemDb.execute(
  sql`update organizations set ingest_rate_limit_per_second = 100000 where id = ${orgId}`,
);

// ── §10 request log ───────────────────────────────────────────────────────────────────────
await flushRequestLogs();
const logs = (await systemDb.execute(sql`
  select status, coalesce(request_body ? '_omitted', true) as no_req,
    coalesce(response_body ? '_omitted', true) as no_res
  from api_request_logs where organization_id = ${orgId} and route = '/v1/businesses/:biz/usage_events'`)) as unknown as Array<{
  status: number;
  no_req: boolean;
  no_res: boolean;
}>;
const ok2 = logs.filter((l) => l.status < 400);
const err4 = logs.filter((l) => l.status >= 400);
ok(
  "§10 request-log rows carry no body on 2xx, and keep it on errors",
  ok2.length > 0 && ok2.every((l) => l.no_req && l.no_res) && err4.some((l) => !l.no_req),
  JSON.stringify(logs),
);

// ── §11 RLS ───────────────────────────────────────────────────────────────────────────────
const other = await createOrganization({ name: `Usage Other ${uniq}` });
const otherKey = (await createApiKey(other.organization.id, "test")).secret;
const otherList = await get("/usage_events", otherKey);
ok("§11 another org cannot list the business's events", otherList.status === 404);
const otherVoid = await voidCall({ key: "e-1" }, otherKey);
ok("§11 another org cannot void them", otherVoid.status === 404);
const leaked = await withTenant(other.organization.id, (tx) =>
  tx.execute(sql`select count(*)::int as n from usage_events where business_id = ${biz.id}`),
);
ok(
  "§11 RLS hides the events from another org",
  (leaked as unknown as Array<{ n: number }>)[0]!.n === 0,
);

// The list API: filters, flags and total.
const list = await get("/usage_events?status=unmatched&limit=2");
ok(
  "list: status filter, cursor paging and a first-page total",
  list.status === 200 &&
    list.json.data.every((e: any) => e.status === "unmatched") &&
    list.json.total >= 2 &&
    list.json.has_more === true,
  JSON.stringify({ s: list.status, t: list.json.total }),
);
const page2 = await get(
  `/usage_events?status=unmatched&limit=2&starting_after=${list.json.next_cursor}`,
);
ok(
  "list: the next page has no repeat and no total",
  page2.status === 200 &&
    page2.json.total === undefined &&
    !page2.json.data.some((e: any) => list.json.data.some((d: any) => d.key === e.key)),
);
const byMeter = await get(`/usage_events?meter=tokens&key=e-1`);
ok("list: rows name the meters they count toward", byMeter.json.data[0]?.meters?.[0] === "tokens");
const noMeter = await send("/usage_events", ev("nm-1", { event_name: "other_event" }));
const nm = await get("/usage_events?key=nm-1");
ok(
  "list: an event name with no meter is accepted and flagged no_meter",
  noMeter.status === 201 && nm.json.data[0]?.flags?.includes("no_meter"),
);

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? "✅" : "❌"} ${name}${pass || !detail ? "" : ` — ${detail}`}`);
}
console.log(
  failed === 0
    ? `\n✅ USAGE EVENTS: PASS (${checks.length})`
    : `\n❌ USAGE EVENTS: FAIL (${failed}/${checks.length})`,
);
await app.close();
await closeDb();
process.exit(failed === 0 ? 0 : 1);
