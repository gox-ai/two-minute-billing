/**
 * An endpoint's delivery log: cursor paging and filters on
 * `GET /v1/webhook_endpoints/:id/deliveries`.
 *
 *  - Pages cover every row once, newest first, with a tie on created_at.
 *  - status / event_type / event / created_at / attempts filters.
 *  - http_status grammar: exact, class, range, `timeout`, several OR-ed with `in`.
 *  - q finds a delivery by its id, its event id or the event's object id.
 *  - Malformed values 400; a garbled cursor degrades to the first page; another org 404s.
 *
 *   pnpm verify:webhook-delivery-log
 */
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { buildApp } from "@/index";
import { createOrganization } from "@/modules/tenancy/service";
import { createEndpoint } from "@/modules/webhooks/endpoints";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { webhookDeliveries } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Delivery Log Org" });
const orgId = org.organization.id;

// Events first, endpoint second: fan-out never targets the endpoint, so every
// delivery on it is one this suite wrote with known values.
const evs = await withTenant(orgId, async (tx) => {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const type = i % 2 === 0 ? "customer_created" : "invoice_paid";
    const key = type === "customer_created" ? "customer" : "invoice";
    const id = `${key === "customer" ? "cus" : "inv"}_dlog${String(i).padStart(4, "0")}`;
    out.push(
      await emitEvent(tx, {
        organizationId: orgId,
        type,
        data: buildEventData(type, { id }),
      }),
    );
  }
  return out;
});
const endpoint = (await createEndpoint({ organizationId: orgId, url: "http://127.0.0.1:9/hook" }))
  .endpoint;

// [status, attempts, last_response_status, minutes ago]. Rows 3 and 4 share a timestamp.
const shape: Array<[string, number, number | null, number]> = [
  ["delivered", 1, 200, 60], // 0
  ["failed", 6, 404, 50], // 1
  ["failed", 6, 500, 40], // 2
  ["pending", 2, null, 30], // 3  retrying after a timeout
  ["pending", 0, null, 30], // 4  not tried yet
  ["failed", 6, null, 20], // 5  refused connection
  ["pending", 1, 410, 10], // 6
];
const base = Date.now();
const far = new Date(base + 365 * 86400_000); // keep a live worker away from the pending rows
const deliveries = await systemDb
  .insert(webhookDeliveries)
  .values(
    shape.map(([status, attempts, code, ago], i) => ({
      organizationId: orgId,
      eventId: evs[i]!.id,
      endpointId: endpoint.id,
      status,
      attempts,
      lastResponseStatus: code,
      lastAttemptAt: attempts > 0 ? new Date(base - ago * 60_000) : null,
      nextAttemptAt: status === "pending" ? far : null,
      createdAt: new Date(base - ago * 60_000),
    })),
  )
  .returning();
const idOf = (i: number) => deliveries[i]!.id;

const app = await buildApp({ logger: false });
const AUTH = { authorization: `Bearer ${org.secret}` };
const path = `/v1/webhook_endpoints/${endpoint.publicId}/deliveries`;
async function get(qs: string) {
  const res = await app.inject({
    method: "GET",
    url: `${path}${qs ? `?${qs}` : ""}`,
    headers: AUTH,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const ids = (b: { data?: Array<{ id: string }> }) => (b.data ?? []).map((d) => d.id);
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();
const rows = (...is: number[]) => is.map(idOf);

// ── Paging ──
const all = await get("");
ok(
  "no params: 200, every row, has_more false",
  all.status === 200 && all.body.data.length === 7 && all.body.has_more === false,
);
ok("no params: total 7", all.body.total === 7);
const order = ids(all.body);
ok(
  "newest first",
  order[0] === idOf(6) && order[1] === idOf(5) && order[order.length - 1] === idOf(0),
);
const seen: string[] = [];
let cursor: string | null = null;
let pages = 0;
do {
  const p = await get(`limit=3${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
  seen.push(...ids(p.body));
  cursor = p.body.has_more ? p.body.next_cursor : null;
  pages++;
} while (cursor && pages < 10);
ok("limit=3 pages 3 times", pages === 3);
ok("pages cover every row once, in order (tie included)", seen.join() === order.join());
const garbled = await get("limit=3&starting_after=k:not-a-uuid");
ok(
  "garbled cursor → first page",
  garbled.status === 200 && ids(garbled.body).join() === order.slice(0, 3).join(),
);
const page2 = await get(
  `limit=3&starting_after=${encodeURIComponent((await get("limit=3")).body.next_cursor)}`,
);
ok("total is first page only", page2.body.total === null);

// ── Column filters ──
ok("status[is]=failed", sameSet(ids((await get("status[is]=failed")).body), rows(1, 2, 5)));
ok(
  "status[in]=pending,delivered",
  sameSet(ids((await get("status[in]=pending,delivered")).body), rows(0, 3, 4, 6)),
);
ok(
  "event_type[is]=invoice_paid",
  sameSet(ids((await get("event_type[is]=invoice_paid")).body), rows(1, 3, 5)),
);
ok("event[is]=<evt id>", sameSet(ids((await get(`event[is]=${evs[2]!.publicId}`)).body), rows(2)));
ok("attempts[gte]=6", sameSet(ids((await get("attempts[gte]=6")).body), rows(1, 2, 5)));
const cut = Math.floor((base - 35 * 60_000) / 1000);
ok(
  "created_at[after]=<unix>",
  sameSet(ids((await get(`created_at[after]=${cut}`)).body), rows(3, 4, 5, 6)),
);
ok(
  "created_at[before]=<unix>",
  sameSet(ids((await get(`created_at[before]=${cut}`)).body), rows(0, 1, 2)),
);
const both = await get(`status[is]=failed&created_at[after]=${cut}`);
ok("filters AND together", sameSet(ids(both.body), rows(5)) && both.body.total === 1);

// ── HTTP status grammar ──
ok("http_status[is]=404", sameSet(ids((await get("http_status[is]=404")).body), rows(1)));
ok("http_status[is]=4xx", sameSet(ids((await get("http_status[is]=4xx")).body), rows(1, 6)));
ok("http_status[is]=5XX", sameSet(ids((await get("http_status[is]=5XX")).body), rows(2)));
ok(
  "http_status[is]=404-412 (inclusive range)",
  sameSet(ids((await get("http_status[is]=404-412")).body), rows(1, 6)),
);
ok(
  "http_status[is]=412-404 (bounds in any order)",
  sameSet(ids((await get("http_status[is]=412-404")).body), rows(1, 6)),
);
ok(
  "http_status[is]=timeout: tried, no response, not delivered",
  sameSet(ids((await get("http_status[is]=timeout")).body), rows(3, 5)),
);
ok(
  "http_status[in]=5xx,timeout (OR)",
  sameSet(ids((await get("http_status[in]=5xx,timeout")).body), rows(2, 3, 5)),
);
ok(
  'http_status[in]=["200","410"] (JSON array)',
  sameSet(
    ids((await get(`http_status[in]=${encodeURIComponent('["200","410"]')}`)).body),
    rows(0, 6),
  ),
);

// ── Search ──
ok("q=<delivery id>", sameSet(ids((await get(`q=${idOf(4)}`)).body), rows(4)));
ok("q=<event id>", sameSet(ids((await get(`q=${evs[5]!.publicId}`)).body), rows(5)));
ok("q=<object id>", sameSet(ids((await get("q=inv_dlog0003")).body), rows(3)));

// ── Refusals ──
for (const [qs, why] of [
  ["http_status[is]=abc", "not in the grammar"],
  ["http_status[is]=4xx,5xx", "is takes one value"],
  ["http_status[is]=600", "not an HTTP status"],
  ["http_status[gt]=400", "unsupported operator"],
  ["response[is]=404", "unknown field"],
  ["sort_by[desc]=status", "unsortable field"],
  ["created_at[on]=31/08/2026", "malformed date"],
] as const) {
  ok(`400: ${why}`, (await get(qs)).status === 400);
}

// ── Isolation ──
const other = await createOrganization({ name: "Other Org" });
const cross = await app.inject({
  method: "GET",
  url: path,
  headers: { authorization: `Bearer ${other.secret}` },
});
ok("another organization → 404", cross.statusCode === 404);

await app.close();
let failed = 0;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ WEBHOOK DELIVERY LOG: PASS (${checks.length} checks)`
    : `❌ WEBHOOK DELIVERY LOG: FAIL (${failed}/${checks.length})`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
