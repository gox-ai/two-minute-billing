/**
 * The model price list: sync, your cost and price-change notices (design G1b T1–T3, T5 cost
 * half, T6–T9). The feed is the trimmed fixture, served by a local HTTP server; nothing here
 * calls the network.
 *  - T1 the fetch goes through the egress guard: a private source is refused with no request,
 *    and a 302 is not followed;
 *  - T2 0.29 USD per 1M is stored as 29.000000000000 cents; 13 places in cents round half-up
 *    once and mark the row; a 6 MB body is refused;
 *  - T3 the same feed twice writes no row; a 304 moves only `checked_at`;
 *  - T6 HTTP 500 writes nothing, keeps `last_success_at`, and the old prices still resolve;
 *  - T9 cost rows are invisible to another organization; an overlap is 409; a started row
 *    cannot be deleted; a past start is 400;
 *  - T5 (cost) a list change leaves your cost row as it was, and cost resolves from it;
 *  - T8 one `model_prices_changed` per business that used the model, none for one that did
 *    not; one email per organization's price managers; a retry sends nothing twice;
 *  - T7 a ×100 batch is held, writes nothing, and a release applies it once, from the release
 *    instant; a held batch the source corrects never applies, and one the source keeps for
 *    `SETTLE_MS` applies on its own (a changed ETag with the same suspect prices keeps the clock);
 *  - T10 media prices: a feed that gains audio, character and page prices (one model with
 *    `input` in tokens and in audio seconds) applies them with no hold and no notice; the 0524
 *    backfill makes a `_kcount` row a request and a unit-less lookup still resolves it; your
 *    cost takes a unit and a quality, and `price_kind` is `token_type` under its new name;
 *  - T11 the second (media) source, served beside the first: one merged run adds its image,
 *    video and audio prices with no hold and no notice, keeps the first feed's names and token
 *    lookups, and resolves an image tier through the tier order; one source failing leaves its
 *    keys alone while the other applies; a body over 12 MB is refused; a key the sources price
 *    more than 25 % apart is held with both prices and released; a batch held before the
 *    second source still releases; `MODEL_PRICES_SYNC=off` reads neither.
 *  Every run before T11 reads the first feed alone (`mediaUrl: null`): the behaviour with the
 *  second source off.
 *
 *   pnpm verify:model-prices
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { runWithClockScope } from "@/platform/clock";
import { formatFixed12 } from "@/platform/fixed";
import { publicId } from "@/platform/ids";
import { PRIVATE_TARGET_MESSAGE } from "@/platform/egress";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { createApiKey, createBusiness } from "@/modules/tenancy/service";
import { createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { foldBusiness } from "@/modules/metering/fold";
import { majorTextToMinorFixed12 } from "@/modules/model-prices/decimal";
import {
  MEDIA_SOURCE,
  MODEL_PRICES_SOURCE,
  NoHeldBatchError,
  readModelPriceSource,
  releaseHeldModelPrices,
  runModelPriceSync,
  SETTLE_MS,
  SETTLED_BY,
} from "@/modules/model-prices/sync";
import {
  formatListPrice,
  recordModelPriceChanges,
  runModelPriceNotices,
} from "@/modules/model-prices/notices";
import { resolveListPrice, resolveModelCost } from "@/modules/model-prices/resolve";
import { memberships, users } from "@db/schema";
import {
  checker,
  createTestMeter,
  meterBusiness,
  newCustomer,
  sendEvent,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const rows = <T>(r: unknown) => r as T[];
const HOUR = 3_600_000;

// The list is platform-global: start from an empty one so counts are this suite's own.
await systemDb.execute(sql`truncate model_prices, model_price_models`);
await systemDb.execute(
  sql`delete from reference_data_sources where source in (${MODEL_PRICES_SOURCE}, ${MEDIA_SOURCE})`,
);

// ── The local source ─────────────────────────────────────────────────────────────────────────
const FIXTURE = readFileSync(
  new URL("../test/unit/fixtures/model-prices-feed.json", import.meta.url),
  "utf8",
).trimEnd();
/** The fixture plus extra providers (raw JSON text, numbers as written). */
const feedWith = (...extra: string[]) =>
  extra.length ? `${FIXTURE.slice(0, -1)},${extra.join(",")}]` : FIXTURE;
/** Every price in the text, × 100 (digits moved, as the sync reads them). */
const times100 = (text: string) =>
  text.replace(
    /("[a-z0-9_]+_(?:mtok|kcount)"|"base"|"price"): (\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g,
    (_m, k: string, v: string) => `${k}: ${formatFixed12(majorTextToMinorFixed12(v).value)}`,
  );
const T2_PROVIDER =
  '{"id":"t2","name":"T2","models":[{"id":"t2-model","prices":{"input_mtok":0.29,"output_mtok":0.000000000000125}}]}';

const src = {
  mode: "ok" as "ok" | "500" | "302" | "big",
  body: feedWith(T2_PROVIDER),
  etag: null as string | null,
  hits: 0,
  redirectHits: 0,
  lastIfNoneMatch: null as string | null,
};
/** The second (media) source, served at /media.json. */
const med = {
  mode: "ok" as "ok" | "500" | "big",
  body: "{}",
  etag: null as string | null,
  hits: 0,
};
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/media.json") {
    med.hits++;
    if (med.mode === "500") {
      res.statusCode = 500;
      res.end("down");
      return;
    }
    if (med.mode === "big") {
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      for (let i = 0; i < 13; i++) res.write(chunk);
      res.end("{}");
      return;
    }
    if (med.etag && req.headers["if-none-match"] === med.etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    if (med.etag) res.setHeader("etag", med.etag);
    res.end(med.body);
    return;
  }
  if (req.url === "/moved") {
    src.redirectHits++;
    res.end(src.body);
    return;
  }
  src.hits++;
  src.lastIfNoneMatch = (req.headers["if-none-match"] as string | undefined) ?? null;
  if (src.mode === "500") {
    res.statusCode = 500;
    res.end("down");
    return;
  }
  if (src.mode === "302") {
    res.statusCode = 302;
    res.setHeader("location", "/moved");
    res.end();
    return;
  }
  if (src.mode === "big") {
    // No content-length: the cap must hold on the stream itself.
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < 6; i++) res.write(chunk);
    res.end("[]");
    return;
  }
  if (src.etag && src.lastIfNoneMatch === src.etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  if (src.etag) res.setHeader("etag", src.etag);
  res.end(src.body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${(server.address() as AddressInfo).port}/data_slim.json`;
const MEDIA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/media.json`;
const sync = (now = new Date()) => runModelPriceSync({ url: URL_, now, mediaUrl: null });
const syncBoth = (now: Date) => runModelPriceSync({ url: URL_, now, mediaUrl: MEDIA_URL });

const countRows = async () =>
  rows<{ n: number }>(await systemDb.execute(sql`select count(*)::int as n from model_prices`))[0]!
    .n;
const sourceRow = async () =>
  rows<Record<string, unknown>>(
    await systemDb.execute(sql`select upstream_version, checked_at::text, check_error,
      last_success_at::text, held_batch from reference_data_sources where source = ${MODEL_PRICES_SOURCE}`),
  )[0] ?? null;
const guard = config as { WEBHOOK_ALLOW_PRIVATE_TARGETS: boolean };

// ── T1 SSRF ──────────────────────────────────────────────────────────────────────────────────
console.log("T1 the fetch goes through the egress guard");
{
  guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = false;
  const r = await sync();
  guard.WEBHOOK_ALLOW_PRIVATE_TARGETS = true;
  const s = await sourceRow();
  check("a private source is refused before any request", r.status === "failed" && src.hits === 0, {
    r,
    hits: src.hits,
  });
  check("…the refusal is stored as check_error", s?.check_error === PRIVATE_TARGET_MESSAGE, s);
  check("…and no price row is written", (await countRows()) === 0);

  src.mode = "302";
  const moved = await sync();
  check(
    "a 302 is a failure and is not followed",
    moved.status === "failed" &&
      moved.error === "The source answered HTTP 302" &&
      src.redirectHits === 0,
    { moved, redirectHits: src.redirectHits },
  );
  check("…and writes no row", (await countRows()) === 0);
}

// ── T2 decimals, first fill, size cap ────────────────────────────────────────────────────────
console.log("T2 decimals and the size cap");
src.mode = "ok";
const first = await sync();
{
  check(
    "the first run applies the whole list",
    first.status === "applied" && first.rows > 0,
    first,
  );
  const t2 = rows<{ token_type: string; v: string; rounded: boolean; f: string }>(
    await systemDb.execute(sql`select token_type, unit_amount_decimal::text as v, rounded,
      effective_from::text as f from model_prices where provider = 't2' order by token_type`),
  );
  const input = t2.find((r) => r.token_type === "input");
  const output = t2.find((r) => r.token_type === "output");
  check(
    "0.29 USD per 1M is stored as 29.000000000000 cents",
    input?.v === "29.000000000000" && !input.rounded,
    input,
  );
  check(
    "13 places in cents round half-up once and the row says so",
    output?.v === "0.000000000013" && output.rounded === true,
    output,
  );
  check("a new key's first price applies from -infinity", input?.f === "-infinity", input);
  const opus = rows<{ f: string; sd: string | null }>(
    await systemDb.execute(sql`select effective_from::text as f, source_effective_from::text as sd
      from model_prices where provider = 'anthropic' and model = 'claude-opus-4-6'
        and token_type = 'input' order by effective_from`),
  );
  check(
    "a new key keeps every dated entry with its own date",
    opus.length === 2 && opus[0]!.f === "-infinity" && opus[1]!.sd === "2026-03-13",
    opus,
  );
  const alias = await withTenant((await meterBusiness("Model Prices Alias")).orgId, (tx) =>
    resolveListPrice(
      tx,
      { model: "claude-opus-4", tokenType: "input", currency: "USD" },
      new Date(),
    ),
  );
  check(
    "an exact alias resolves to its model",
    alias.kind === "list" &&
      alias.model === "claude-opus-4-0" &&
      alias.unitAmount === 1500n * 10n ** 12n,
    alias,
  );

  const before = await countRows();
  const s0 = await sourceRow();
  src.mode = "big";
  const big = await sync();
  const s1 = await sourceRow();
  check("a 6 MB body is refused", big.status === "failed" && /5 MB/.test(big.error), big);
  check(
    "…writes no row and keeps the last success",
    (await countRows()) === before && s1?.last_success_at === s0?.last_success_at,
  );
  src.mode = "ok";
}

// ── T3 idempotent ────────────────────────────────────────────────────────────────────────────
console.log("T3 idempotent");
{
  const before = await countRows();
  const again = await sync();
  check(
    "the same feed again (no ETag) writes no row",
    again.status === "applied" && again.rows === 0 && (await countRows()) === before,
    again,
  );
  src.etag = '"v1"';
  const tagged = await sync();
  check(
    "a run with an ETag stores it",
    tagged.status === "applied" && (await sourceRow())?.upstream_version === '"v1"',
  );
  const s0 = await sourceRow();
  await new Promise((r) => setTimeout(r, 5));
  const nm = await sync();
  const s1 = await sourceRow();
  check(
    "the next run sends If-None-Match and a 304 changes nothing",
    nm.status === "not_modified" &&
      src.lastIfNoneMatch === '"v1"' &&
      (await countRows()) === before,
    { nm, inm: src.lastIfNoneMatch },
  );
  check(
    "…only checked_at moves",
    s1?.checked_at !== s0?.checked_at &&
      s1?.last_success_at === s0?.last_success_at &&
      s1?.upstream_version === s0?.upstream_version &&
      s1?.check_error === s0?.check_error,
    { s0, s1 },
  );
}

// ── T6 failure ───────────────────────────────────────────────────────────────────────────────
console.log("T6 a failed run");
{
  const before = await countRows();
  const s0 = await sourceRow();
  src.mode = "500";
  const r = await sync();
  const s1 = await sourceRow();
  check(
    "HTTP 500 is a failed run",
    r.status === "failed" && s1?.check_error === "The source answered HTTP 500",
    r,
  );
  check("…writes no row", (await countRows()) === before);
  check(
    "…keeps last_success_at and the ETag",
    s1?.last_success_at === s0?.last_success_at && s1?.upstream_version === s0?.upstream_version,
    { s0, s1 },
  );
  const state = await readModelPriceSource();
  check(
    "…and the source state reports the error",
    state.checkError === "The source answered HTTP 500",
  );
  src.mode = "ok";
}

// ── Fixtures for T9, T5 and T8 ───────────────────────────────────────────────────────────────
const A = await meterBusiness("Model Prices Org A");
const B = await meterBusiness("Model Prices Org B");
const keyA = (await createApiKey(A.orgId, "test")).secret;
const keyB = (await createApiKey(B.orgId, "test")).secret;
const app = await buildApp({ logger: false });
let n = 0;
async function call(
  secret: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(method !== "GET" ? { "idempotency-key": `mp-${Date.now()}-${n++}` } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, json: res.json() as any };
}

// ── T9 your cost: RLS, overlap, delete, past ─────────────────────────────────────────────────
console.log("T9 your cost");
const COSTS = "/v1/organization/model_cost_overrides";
const outputCost = await call(keyA, "POST", COSTS, {
  provider: "openai",
  model: "gpt-4o",
  token_type: "output",
  currency: "USD",
  unit_amount_decimal: "800",
  quantity_divisor: "1000000",
  note: "Negotiated rate",
});
{
  check(
    "a cost row is created (201)",
    outputCost.status === 201 && outputCost.json.id?.startsWith("mco_"),
    outputCost,
  );
  const overlap = await call(keyA, "POST", COSTS, {
    model: "gpt-4o",
    provider: "openai",
    token_type: "output",
    currency: "USD",
    unit_amount_decimal: "700",
    quantity_divisor: 1000000,
    effective_from: new Date(Date.now() + 24 * HOUR).toISOString(),
  });
  check("an overlapping cost for the same key is 409", overlap.status === 409, overlap);
  const past = await call(keyA, "POST", COSTS, {
    model: "gpt-4o",
    token_type: "cache_read",
    currency: "USD",
    unit_amount_decimal: "50",
    quantity_divisor: "1000000",
    effective_from: new Date(Date.now() - 24 * HOUR).toISOString(),
  });
  check("a start in the past is 400", past.status === 400, past);

  const id = outputCost.json.id as string;
  const fromB = await call(keyB, "GET", `${COSTS}/${id}`);
  const listB = await call(keyB, "GET", COSTS);
  check(
    "org B cannot read org A's cost row",
    fromB.status === 404 && listB.json.data?.length === 0,
    {
      fromB,
      listB,
    },
  );
  const rls = await withTenant(B.orgId, async (tx) =>
    rows<{ n: number }>(
      await tx.execute(
        sql`select count(*)::int as n from model_cost_overrides where public_id = ${id}`,
      ),
    ),
  );
  check("…not even with a direct query under its own tenant (RLS)", rls[0]!.n === 0);

  const del = await call(keyA, "DELETE", `${COSTS}/${id}`);
  check("a started cost cannot be deleted (409)", del.status === 409, del);
  const future = await call(keyA, "POST", COSTS, {
    model: "in-house-model",
    token_type: "input",
    currency: "INR",
    unit_amount_decimal: "12.5",
    quantity_divisor: "1000",
    effective_from: new Date(Date.now() + 48 * HOUR).toISOString(),
  });
  const delFuture = await call(keyA, "DELETE", `${COSTS}/${future.json.id}`);
  check(
    "a cost that has not started can be deleted, and may name a model the list does not have",
    future.status === 201 && delFuture.status === 200 && delFuture.json.deleted === true,
    { future, delFuture },
  );
  const web = await call(keyA, "POST", COSTS, {
    provider: "openai",
    model: "gpt-4o",
    token_type: "web_searches",
    currency: "USD",
    unit_amount_decimal: "900",
    quantity_divisor: "1000",
  });
  const ended = await call(keyA, "POST", `${COSTS}/${web.json.id}/end`, {});
  const endedAgain = await call(keyA, "POST", `${COSTS}/${web.json.id}/end`, {});
  check(
    "End sets effective_to to now; a second End is 409",
    ended.status === 200 && ended.json.effective_to !== null && endedAgain.status === 409,
    { ended, endedAgain },
  );
  const audit = rows<{ action: string }>(
    await systemDb.execute(sql`select action from audit_logs where organization_id = ${A.orgId}
      and resource_type = 'model_cost_override' order by created_at`),
  ).map((r) => r.action);
  check(
    "each change writes an audit row",
    ["model_cost_override.create", "model_cost_override.delete", "model_cost_override.end"].every(
      (a) => audit.includes(a),
    ),
    audit,
  );
  const list = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices?provider=openai&model=gpt-4o",
  );
  const outRow = list.json.data?.find((r: any) => r.token_type === "output");
  check(
    "the price list shows your cost beside the list price",
    list.status === 200 && outRow?.unit_amount_decimal === "1000" && outRow?.cost?.id === id,
    outRow,
  );
  const history = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices/history?model=gpt-4o&provider=openai",
  );
  check(
    "history lists dated rows and your cost rows",
    history.status === 200 && history.json.prices.length > 0 && history.json.costs.length >= 2,
    history.json,
  );
  const source = await call(keyA, "GET", "/v1/organization/model_prices/source");
  check(
    "source reports the licence, last success and no held batch",
    source.status === 200 &&
      /MIT/.test(source.json.licence) &&
      source.json.held === false &&
      source.json.last_success_at !== null,
    source.json,
  );
}

// Members: a price manager and an ops member in org A; org B has no member.
async function member(orgId: string, role: string) {
  const [u] = await systemDb
    .insert(users)
    .values({ publicId: publicId("usr"), email: `${role}-${Date.now()}-${n++}@example.com` })
    .returning();
  await systemDb.insert(memberships).values({ organizationId: orgId, userId: u!.id, role });
  return u!.email;
}
const managerEmail = await member(A.orgId, "manager");
const opsEmail = await member(A.orgId, "ops");

/** A meter mapped to the list, with usage folded for each model in `models`. */
async function usingBusiness(
  ids: { organizationId: string; businessId: string },
  models: string[],
) {
  const meter = await createTestMeter(ids, { groupBy: ["model", "token_type"] });
  const since = new Date(Date.now() - 24 * HOUR).toISOString();
  await systemDb.execute(
    sql`update meters set price_list = ${JSON.stringify({
      provider: "openai",
      token_type_key: "token_type",
    })}::jsonb, folded_from = ${since}::timestamptz, backfilled_at = now() where id = ${meter.id}`,
  );
  // The fold state createMeter would set; this meter is inserted directly.
  await systemDb.execute(sql`insert into usage_rollup_state (business_id, organization_id, watermark)
    values (${ids.businessId}, ${ids.organizationId}, ${since}::timestamptz)
    on conflict (business_id) do nothing`);
  const customer = await newCustomer(ids, "mp");
  for (const model of models)
    for (const tokenType of ["input", "output"])
      await sendEvent(ids, {
        customerId: customer.id,
        eventName: meter.eventName,
        at: new Date(Date.now() - 2 * HOUR),
        properties: { model, token_type: tokenType, tokens: 1000 },
      });
  await runWithClockScope({ onlyBusinessId: ids.businessId }, () =>
    foldBusiness({ ...ids, graceMs: 0 }),
  );
  return { meter, customer };
}
const A1 = await usingBusiness(A.ids, ["gpt-4o"]);
// A1 bills gpt-4o from the list (markup on the list price): its bills move.
const listPrice = await createPrice({
  ...A.ids,
  productId: A.product.id,
  id: `mp-list-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: A1.meter.key,
  amountSource: "model_price_list",
  unitAmountDecimal: "100",
  quantityDivisor: "1000000",
  markupPercent: "20",
} as Parameters<typeof createPrice>[0]);
await createSubscription({
  ...A.ids,
  customerId: A1.customer.id,
  now: new Date(),
  items: [{ price: listPrice, quantity: 1 }],
});
const a2Biz = await createBusiness({
  organizationId: A.orgId,
  name: "Biz 2",
  defaultCurrency: "USD",
  livemode: "test",
});
await usingBusiness({ organizationId: A.orgId, businessId: a2Biz.id }, ["gpt-4o-mini"]);
const B1 = await usingBusiness(B.ids, ["gpt-4o"]);
void B1;

// ── T8 + T5 (cost) a list change ─────────────────────────────────────────────────────────────
console.log("T8 price-change notices, T5 your cost stays");
const costBefore = rows<{ v: string; rv: number; u: string }>(
  await systemDb.execute(sql`select unit_amount_decimal::text as v, resource_version as rv,
    updated_at::text as u from model_cost_overrides where public_id = ${outputCost.json.id}`),
)[0]!;
const changeAt = new Date();
src.etag = '"v2"';
// gpt-4o: input $2.50 → $2.00, output $10 → $9 per 1M.
src.body = feedWith(T2_PROVIDER)
  .replace(/("id": "gpt-4o",[\s\S]*?"input_mtok": )2\.5\b/, (_m, p: string) => `${p}2`)
  .replace(/("id": "gpt-4o",[\s\S]*?"output_mtok": )10\b/, (_m, p: string) => `${p}9`);
if (src.body === feedWith(T2_PROVIDER)) throw new Error("fixture edit did not apply");
const changed = await sync(changeAt);
{
  check(
    "a small change applies (2 keys of many)",
    changed.status === "applied" && changed.changes === 2,
    changed,
  );
  const evs = rows<{ business_id: string; data: any }>(
    await systemDb.execute(sql`select business_id, data from events
      where type = 'model_prices_changed' and business_id in (${A.biz.id}, ${a2Biz.id}, ${B.biz.id})`),
  );
  const forBiz = (id: string) => evs.filter((e) => e.business_id === id);
  check(
    "one model_prices_changed per business that used the model",
    forBiz(A.biz.id).length === 1 && forBiz(B.biz.id).length === 1,
    evs.map((e) => e.business_id),
  );
  check("none for a business that did not use it", forBiz(a2Biz.id).length === 0);
  const changes = (forBiz(A.biz.id)[0]?.data?.model_prices?.changes ?? []) as any[];
  const input = changes.find((c) => c.token_type === "input");
  const output = changes.find((c) => c.token_type === "output");
  check(
    "the change names old and new price, divisor and both dates",
    input?.old_unit_amount_decimal === "250" &&
      input?.new_unit_amount_decimal === "200" &&
      input?.quantity_divisor === "1000000" &&
      input?.model_price_id?.startsWith("mpr_") &&
      input?.effective_from === changeAt.toISOString(),
    input,
  );
  check(
    "a list-priced item's bill moves; a key with your cost does not move cost",
    input?.bill_moves === true && input?.cost_moves === true && output?.cost_moves === false,
    { input, output },
  );
  const costAfter = rows<{ v: string; rv: number; u: string }>(
    await systemDb.execute(sql`select unit_amount_decimal::text as v, resource_version as rv,
      updated_at::text as u from model_cost_overrides where public_id = ${outputCost.json.id}`),
  )[0]!;
  check(
    "the sync leaves your cost row untouched",
    JSON.stringify(costAfter) === JSON.stringify(costBefore),
    {
      costBefore,
      costAfter,
    },
  );
  const key = { provider: "openai", model: "gpt-4o", tokenType: "output", currency: "USD" };
  const [cost, list] = await withTenant(A.orgId, async (tx) => [
    await resolveModelCost(tx, A.orgId, key, new Date()),
    await resolveListPrice(tx, key, new Date()),
  ]);
  check(
    "cost resolves from your cost while it is live, not from the new list",
    cost.kind === "cost" &&
      cost.unitAmount === 800n * 10n ** 12n &&
      list.kind === "list" &&
      list.unitAmount === 900n * 10n ** 12n,
    { cost, list },
  );
  const old = await withTenant(A.orgId, (tx) =>
    resolveListPrice(tx, { ...key, tokenType: "input" }, new Date(changeAt.getTime() - 1)),
  );
  check(
    "usage before the change keeps the old list price",
    old.kind === "list" && old.unitAmount === 250n * 10n ** 12n,
    old,
  );

  const notices = rows<{ organization_id: string; status: string }>(
    await systemDb.execute(sql`select organization_id, status from model_price_notices
      where organization_id in (${A.orgId}, ${B.orgId})`),
  );
  check("one notice row per organization", notices.length === 2, notices);

  const captured: OutboundEmail[] = [];
  setMailer({
    kind: "console" as const,
    target: null,
    async send(m: OutboundEmail) {
      captured.push(m);
      return { providerMessageId: `fake_${captured.length}`, status: "sent" as const };
    },
  });
  const sentA = await runModelPriceNotices(new Date());
  const mine = captured.filter((m) => m.to === managerEmail || m.to === opsEmail);
  check(
    "one email, to the member who manages prices only",
    mine.length === 1 && mine[0]!.to === managerEmail && sentA.sent >= 1,
    mine.map((m) => m.to),
  );
  check(
    "…subject and body name the change",
    mine[0]?.subject === "Prices changed for 1 AI model" &&
      /\$2\.50 per 1M tokens/.test(mine[0]!.text ?? "") &&
      /\$2\.00 per 1M tokens/.test(mine[0]!.text ?? "") &&
      /Your cost stays in effect/.test(mine[0]!.text ?? ""),
    mine[0],
  );
  const statusB = rows<{ status: string }>(
    await systemDb.execute(
      sql`select status from model_price_notices where organization_id = ${B.orgId}`,
    ),
  )[0]?.status;
  check("an organization with no price manager is skipped", statusB === "skipped", statusB);

  // A retry: the same run recorded again, the cron run again.
  const runId = rows<{ id: string }>(
    await systemDb.execute(sql`select sync_run_id::text as id from model_price_notices
      where organization_id = ${A.orgId}`),
  )[0]!.id;
  await systemDb.transaction((tx) =>
    recordModelPriceChanges(tx, {
      syncRunId: runId,
      now: new Date(),
      changes: [
        {
          provider: "openai",
          model: "gpt-4o",
          tokenType: "input",
          unit: "token",
          quality: "",
          resolution: "",
          currency: "USD",
          modelPriceId: input?.model_price_id,
          oldUnitAmountDecimal: "250",
          newUnitAmountDecimal: "200",
          quantityDivisor: "1000000",
          effectiveFrom: changeAt.toISOString(),
          sourceEffectiveFrom: null,
          source: "genai-prices",
          sourceVersion: '"v2"',
        },
      ],
    }),
  );
  const before = captured.length;
  await runModelPriceNotices(new Date());
  await runModelPriceNotices(new Date(Date.now() + 20 * 60_000));
  const rowsA = rows<{ n: number }>(
    await systemDb.execute(sql`select count(*)::int as n from model_price_notices
      where organization_id = ${A.orgId}`),
  )[0]!.n;
  check(
    "a retry writes no second notice and sends no second email",
    rowsA === 1 && captured.length === before,
    {
      rowsA,
      sent: captured.length - before,
    },
  );
  setMailer(null);
}

// ── T7 held batch ────────────────────────────────────────────────────────────────────────────
console.log("T7 a suspicious batch is held");
{
  const before = await countRows();
  src.etag = '"v3"';
  src.body = times100(src.body);
  const heldAt = new Date();
  const held = await sync(heldAt);
  const state = await readModelPriceSource();
  check(
    "every price × 100 is held, with its reasons",
    held.status === "held" &&
      held.reasons.includes("price_moved_tenfold") &&
      held.reasons.includes("many_keys_changed") &&
      state.held !== null,
    held,
  );
  check("…and nothing is written", (await countRows()) === before);
  const key = { provider: "openai", model: "gpt-4o", tokenType: "input", currency: "USD" };
  const waiting = new Date(heldAt.getTime() + 1000);
  const releaseAt = new Date(heldAt.getTime() + 2000);
  const r = await releaseHeldModelPrices({ by: "staff@example.com", now: releaseAt });
  const [during, afterRelease] = await withTenant(A.orgId, async (tx) => [
    await resolveListPrice(tx, key, waiting),
    await resolveListPrice(tx, key, releaseAt),
  ]);
  check(
    "a release applies the batch from the release instant",
    r.rows > 0 &&
      afterRelease.kind === "list" &&
      afterRelease.unitAmount === 20_000n * 10n ** 12n &&
      afterRelease.effectiveFrom?.getTime() === releaseAt.getTime(),
    { r, afterRelease },
  );
  check(
    "usage recorded while it waited keeps the old price",
    during.kind === "list" && during.unitAmount === 200n * 10n ** 12n,
    during,
  );
  const by = rows<{ b: string | null }>(
    await systemDb.execute(sql`select distinct released_by as b from model_prices
      where effective_from = ${releaseAt.toISOString()}::timestamptz`),
  );
  check("…records who released it", by.length === 1 && by[0]!.b === "staff@example.com", by);
  let again: unknown = null;
  try {
    await releaseHeldModelPrices({
      by: "staff@example.com",
      now: new Date(releaseAt.getTime() + 1000),
    });
  } catch (e) {
    again = e;
  }
  check("…once: a second release finds nothing held", again instanceof NoHeldBatchError);
  check("the held batch is cleared", (await readModelPriceSource()).held === null);
}

console.log("T7 a held batch settles on its own");
{
  const H = 3_600_000;
  const before = await countRows();
  const good = src.body;
  const t0 = new Date(Date.now() + 60_000);
  src.etag = '"v4"';
  src.body = times100(good);
  const held = await sync(t0);
  const unchanged = await sync(new Date(t0.getTime() + H));
  src.etag = '"v5"';
  src.body = good;
  const corrected = await sync(new Date(t0.getTime() + 2 * H));
  check(
    "a slip the source corrects before it settles never applies",
    held.status === "held" &&
      held.settlesAt === new Date(t0.getTime() + SETTLE_MS).toISOString() &&
      unchanged.status === "not_modified" &&
      corrected.status === "applied" &&
      corrected.rows === 0 &&
      (await countRows()) === before &&
      (await readModelPriceSource()).held === null,
    { held, unchanged, corrected },
  );

  const t1 = new Date(t0.getTime() + 3 * H);
  src.etag = '"v6"';
  src.body = times100(good);
  await sync(t1);
  src.etag = '"v7"';
  const again = await sync(new Date(t1.getTime() + 3 * H));
  const settleAt = new Date(t1.getTime() + SETTLE_MS + 1000);
  const settled = await sync(settleAt);
  const by = rows<{ b: string | null; n: number }>(
    await systemDb.execute(sql`select released_by as b, count(*)::int as n from model_prices
      where effective_from = ${settleAt.toISOString()}::timestamptz group by 1`),
  );
  check(
    "a new ETag with the same suspect prices keeps the settle clock",
    again.status === "held" && again.settlesAt === new Date(t1.getTime() + SETTLE_MS).toISOString(),
    again,
  );
  check(
    "…and once settled the batch applies on its own, from that instant",
    settled.status === "settled" &&
      settled.rows > 0 &&
      by.length === 1 &&
      by[0]!.b === SETTLED_BY &&
      (await readModelPriceSource()).held === null,
    { settled, by },
  );
}

// ── T10 media prices ─────────────────────────────────────────────────────────────────────────
console.log("T10 media prices");
{
  const MEDIA = readFileSync(
    new URL("../test/unit/fixtures/model-prices-media-feed.json", import.meta.url),
    "utf8",
  ).trim();
  // After the rows T7 applied, so every known key is unchanged at this instant.
  const [last] = rows<{ ms: string }>(
    await systemDb.execute(sql`select (extract(epoch from max(effective_from)) * 1000)::bigint::text
      as ms from model_prices where effective_from <> 'infinity'`),
  );
  const at = new Date(Number(last!.ms) + HOUR);
  const count = async (q: string) => rows<{ n: number }>(await systemDb.execute(sql.raw(q)))[0]!.n;
  const eventsBefore = await count(
    "select count(*)::int as n from events where type = 'model_prices_changed'",
  );
  const noticesBefore = await count("select count(*)::int as n from model_price_notices");
  const before = await countRows();
  src.etag = '"v8"';
  src.body = `${src.body.trimEnd().slice(0, -1)},${MEDIA.slice(1, -1)}]`;
  const r = await sync(at);
  check(
    "a feed that only gains media prices applies them: no hold, no change",
    r.status === "applied" &&
      r.changes === 0 &&
      r.rows > 0 &&
      (await countRows()) === before + r.rows,
    r,
  );
  check(
    "…and sends no model_prices_changed event and no notice",
    (await count("select count(*)::int as n from events where type = 'model_prices_changed'")) ===
      eventsBefore &&
      (await count("select count(*)::int as n from model_price_notices")) === noticesBefore,
  );
  const media = rows<{ m: string; t: string; u: string; v: string; d: string }>(
    await systemDb.execute(sql`select model as m, token_type as t, unit as u,
      unit_amount_decimal::text as v, quantity_divisor::text as d from model_prices
      where model in ('whisper-1', 'tts-1', 'mistral-ocr-2512', 'voxtral-small-24b-2507')
        and effective_from = '-infinity'
      order by model, token_type, unit`),
  );
  const has = (m: string, t: string, u: string, v: string, d: string) =>
    media.some((x) => x.m === m && x.t === t && x.u === u && x.v === v && x.d === d);
  check(
    "a media-only model is on the list: $0.36 per audio hour = 36 ¢ per 3,600 seconds",
    has("whisper-1", "input", "audio_second", "36.000000000000", "3600") &&
      has("whisper-1", "audio", "audio_second", "36.000000000000", "3600") &&
      has("tts-1", "input", "character", "1500.000000000000", "1000000") &&
      has("mistral-ocr-2512", "input_document", "page", "200.000000000000", "1000"),
    media,
  );
  check(
    "a model with input in two units keeps both rows",
    has("voxtral-small-24b-2507", "input", "token", "10.000000000000", "1000000") &&
      has("voxtral-small-24b-2507", "input", "audio_second", "24.000000000000", "3600"),
    media.filter((x) => x.m === "voxtral-small-24b-2507"),
  );
  const [tokenHit, audioHit] = await withTenant(A.orgId, async (tx) => [
    await resolveListPrice(
      tx,
      { model: "voxtral-small-latest", tokenType: "input", currency: "USD" },
      at,
    ),
    await resolveListPrice(
      tx,
      { model: "voxtral-small-latest", tokenType: "input", currency: "USD", unit: "audio_second" },
      at,
    ),
  ]);
  check(
    "a unit-less lookup keeps the token price; a lookup that names audio_second gets the audio price",
    tokenHit.kind === "list" &&
      tokenHit.unit === "token" &&
      audioHit.kind === "list" &&
      audioHit.unit === "audio_second" &&
      audioHit.quantityDivisor === 3600n,
    { tokenHit, audioHit },
  );
  check(
    "the notice wording names the unit",
    formatListPrice("36.000000000000", "3600", "audio_second") === "$0.36 per hour of audio" &&
      formatListPrice("250.000000000000", "1000000") === "$2.50 per 1M tokens",
  );

  // The 0524 backfill, run again on rows written the way the sync wrote them before it.
  await systemDb.execute(sql`insert into model_price_models (provider, model)
    values ('legacy', 'legacy-search') on conflict do nothing`);
  for (const [t, v, d] of [
    ["web_searches", "1000", "1000"],
    ["input", "300", "1000000"],
  ])
    await systemDb.execute(sql`insert into model_prices (public_id, provider, model, token_type,
      currency, unit_amount_decimal, quantity_divisor, effective_from, source, sync_run_id)
      values (${publicId("mpr")}, 'legacy', 'legacy-search', ${t}, 'USD', ${v}::numeric,
        ${d}::bigint, '-infinity', 'genai-prices', '00000000-0000-7000-8000-000000000009'::uuid)`);
  const legacyCost = await call(keyA, "POST", COSTS, {
    model: "legacy-search",
    token_type: "web_searches",
    currency: "USD",
    unit_amount_decimal: "800",
    quantity_divisor: "1000",
  });
  const migration = readFileSync(
    new URL("../db/migrations/0524_model_price_units.sql", import.meta.url),
    "utf8",
  );
  const backfill = migration
    .split("--> statement-breakpoint")
    .find((st) => /UPDATE model_prices SET unit = 'request'/.test(st));
  if (!backfill) throw new Error("0524 has no backfill statement");
  await systemDb.execute(sql.raw(backfill));
  const legacy = rows<{ t: string; u: string }>(
    await systemDb.execute(sql`select token_type as t, unit as u from model_prices
      where provider = 'legacy' order by token_type`),
  );
  const legacyCostUnit = rows<{ u: string }>(
    await systemDb.execute(sql`select unit as u from model_cost_overrides
      where public_id = ${legacyCost.json.id}`),
  )[0]?.u;
  check(
    "the backfill makes a per-1,000 row a request; a per-1M row and every cost row stay token",
    JSON.stringify(legacy) === '[{"t":"input","u":"token"},{"t":"web_searches","u":"request"}]' &&
      legacyCostUnit === "token",
    { legacy, legacyCostUnit },
  );
  const [legacyList, legacyToken, legacyCostHit] = await withTenant(A.orgId, async (tx) => [
    await resolveListPrice(
      tx,
      { model: "legacy-search", tokenType: "web_searches", currency: "USD" },
      at,
    ),
    await resolveListPrice(
      tx,
      { model: "legacy-search", tokenType: "web_searches", currency: "USD", unit: "token" },
      at,
    ),
    await resolveModelCost(
      tx,
      A.orgId,
      { model: "legacy-search", tokenType: "web_searches", currency: "USD" },
      new Date(),
    ),
  ]);
  check(
    "a unit-less lookup still resolves the request row; your token cost row still prices it",
    legacyList.kind === "list" &&
      legacyList.unit === "request" &&
      legacyToken.kind === null &&
      legacyCostHit.kind === "cost" &&
      legacyCostHit.unitAmount === 800n * 10n ** 12n,
    { legacyList, legacyToken, legacyCostHit },
  );
  const listed = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices?model=legacy-search&token_type=web_searches",
  );
  check(
    "the list shows that token cost row beside the request row, as before",
    listed.json.data?.length === 1 &&
      listed.json.data[0].unit === "request" &&
      listed.json.data[0].cost?.id === legacyCost.json.id,
    listed.json,
  );

  // The API: unit filter, price_kind alias, cost rows with a unit and a quality.
  const audioList = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices?model=whisper-1&unit=audio_second&price_kind=input",
  );
  check(
    "?unit= and ?price_kind= filter the list; each row returns unit and price_kind",
    audioList.status === 200 &&
      audioList.json.data?.length === 1 &&
      audioList.json.data[0].unit === "audio_second" &&
      audioList.json.data[0].price_kind === "input" &&
      audioList.json.data[0].token_type === "input" &&
      audioList.json.data[0].quality === null,
    audioList.json,
  );
  const clash = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices?token_type=input&price_kind=output",
  );
  check("token_type and price_kind that differ → 400", clash.status === 400, clash.json);
  const imgCost = (o: Record<string, unknown>) =>
    call(keyA, "POST", COSTS, {
      model: "image-model",
      currency: "USD",
      unit_amount_decimal: "3",
      quantity_divisor: 1,
      ...o,
    });
  const hd = await imgCost({ price_kind: "output", unit: "image", quality: "hd" });
  const tok = await imgCost({ token_type: "output", quantity_divisor: "1000000" });
  const std = await imgCost({ token_type: "output", unit: "image", quality: "standard" });
  const hdAgain = await imgCost({ token_type: "output", unit: "image", quality: "hd" });
  const badUnit = await imgCost({ token_type: "output", unit: "furlong" });
  const badTier = await imgCost({ token_type: "output", unit: "image", quality: "HD!" });
  const noKind = await imgCost({ unit: "image" });
  check(
    "a cost row takes a unit and a quality, and returns them with price_kind",
    hd.status === 201 &&
      hd.json.unit === "image" &&
      hd.json.quality === "hd" &&
      hd.json.resolution === null &&
      hd.json.token_type === "output" &&
      hd.json.price_kind === "output",
    hd.json,
  );
  check(
    "the overlap rule is per unit and tier: token and standard sit beside hd; a second hd → 409",
    tok.status === 201 && tok.json.unit === "token" && std.status === 201 && hdAgain.status === 409,
    { tok: tok.status, std: std.status, hdAgain: hdAgain.json },
  );
  check(
    "an unknown unit, a bad tier and no kind → 400",
    badUnit.status === 400 && badTier.status === 400 && noKind.status === 400,
    { badUnit: badUnit.json, badTier: badTier.json, noKind: noKind.json },
  );
  const imgRows = await call(keyA, "GET", `${COSTS}?model=image-model&unit=image`);
  check(
    "?unit= filters your cost rows",
    imgRows.json.data?.length === 2 &&
      imgRows.json.data.every((x: { unit: string }) => x.unit === "image"),
    imgRows.json,
  );

  // Costs the list cannot show: a tier the list does not price, a model it does not have.
  const mixed = await imgCost({
    token_type: "output",
    unit: "image",
    quality: " Ultra ",
    resolution: "1024X1024",
  });
  check(
    "a tier is trimmed and lower-cased before the pattern check",
    mixed.status === 201 && mixed.json.quality === "ultra" && mixed.json.resolution === "1024x1024",
    mixed.json,
  );
  const tiered = await call(keyA, "POST", COSTS, {
    model: "whisper-1",
    token_type: "input",
    unit: "audio_second",
    quality: "hd",
    currency: "USD",
    unit_amount_decimal: "30",
    quantity_divisor: 3600,
  });
  const later = await imgCost({
    model: "model-not-on-the-list",
    token_type: "input",
    effective_from: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const ids = async (qs: string) =>
    ((await call(keyA, "GET", `${COSTS}?limit=500${qs}`)).json.data ?? []).map(
      (x: { id: string }) => x.id,
    ) as string[];
  const [all, unlisted, onList] = [
    await ids(""),
    await ids("&listed=false"),
    await ids("&listed=true"),
  ];
  check(
    "?listed=false returns the tiered cost row and the rows of a model missing from the list",
    tiered.status === 201 &&
      later.status === 201 &&
      [tiered, later, hd, std, tok, mixed].every((c) => unlisted.includes(c.json.id)),
    { unlisted },
  );
  check(
    "…and not a cost the list shows; ?listed=true returns the others; together they are every row",
    !unlisted.includes(legacyCost.json.id) &&
      onList.includes(legacyCost.json.id) &&
      onList.every((id) => !unlisted.includes(id)) &&
      unlisted.length + onList.length === all.length,
    { all: all.length, unlisted: unlisted.length, onList: onList.length },
  );
  const viaList = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices?model=whisper-1&has_cost=true",
  );
  check(
    "the list read does not show the tiered row: its key has no list row",
    viaList.status === 200 && viaList.json.data?.length === 0,
    viaList.json,
  );
  const history = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices/history?model=whisper-1&token_type=input&unit=audio_second",
  );
  check(
    "the history of the untiered key returns the tiered cost row",
    history.json.costs?.some((c: { id: string; quality: string }) => c.id === tiered.json.id),
    history.json.costs,
  );

  // The cost list: text search, filters and the cursor, so a card can page it honestly.
  const bySearch = await ids("&listed=false&q=NOT-ON-THE");
  check(
    "?q= on your costs matches text in the model, in any case",
    bySearch.length === 1 && bySearch[0] === later.json.id,
    { bySearch },
  );
  const byBoth = await ids("&listed=false&q=whisper&unit=audio_second");
  check(
    "?q= with ?unit= narrows together; a unit with no such cost returns nothing",
    byBoth.length === 1 &&
      byBoth[0] === tiered.json.id &&
      (await ids("&listed=false&q=whisper&unit=image")).length === 0,
    { byBoth },
  );
  check(
    "?q= treats % and _ as text",
    (await ids("&q=%25")).length === 0 && (await ids("&q=_")).length === 0,
  );
  const walked: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: {
      json: { data: { id: string }[]; has_more: boolean; next_cursor: string | null };
    } = await call(
      keyA,
      "GET",
      `${COSTS}?listed=false&limit=2${cursor ? `&starting_after=${cursor}` : ""}`,
    );
    walked.push(...page.json.data.map((x) => x.id));
    cursor = page.json.has_more ? page.json.next_cursor : null;
    pages++;
  } while (cursor && pages < 50);
  check(
    "the cursor walks ?listed=false to the end: every row once",
    pages > 1 &&
      walked.length === unlisted.length &&
      new Set(walked).size === walked.length &&
      unlisted.every((id) => walked.includes(id)),
    { pages, walked: walked.length, unlisted: unlisted.length },
  );

  // The history lists what the list row shows: a cost under an alias, a token cost on a request row.
  const aliasCost = await call(keyA, "POST", COSTS, {
    provider: "openai",
    model: "gpt-4o-2024-08-06",
    token_type: "cache_read",
    currency: "USD",
    unit_amount_decimal: "90",
    quantity_divisor: "1000000",
  });
  const aliasRow = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices?model=gpt-4o&provider=openai&token_type=cache_read",
  );
  const aliasHistory = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices/history?model=gpt-4o&provider=openai&token_type=cache_read&unit=token",
  );
  check(
    "a cost stored under an alias shows on the model's list row and in that row's history",
    aliasCost.status === 201 &&
      aliasRow.json.data?.length === 1 &&
      aliasRow.json.data[0].cost?.id === aliasCost.json.id &&
      aliasHistory.json.costs?.some((c: { id: string }) => c.id === aliasCost.json.id),
    { aliasCost: aliasCost.json, aliasRow: aliasRow.json, costs: aliasHistory.json.costs },
  );
  const otherProvider = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices/history?model=gpt-4o&provider=not-a-provider&token_type=cache_read",
  );
  check(
    "…and not in the history of the same model name under another provider",
    otherProvider.status === 200 &&
      !otherProvider.json.costs.some((c: { id: string }) => c.id === aliasCost.json.id),
    otherProvider.json.costs,
  );
  const requestHistory = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices/history?model=legacy-search&token_type=web_searches&unit=request",
  );
  const tokenHistory = await call(
    keyA,
    "GET",
    "/v1/organization/model_prices/history?model=image-model&token_type=output&unit=image",
  );
  check(
    "a request row's history lists the token cost its list row shows; another unit's does not",
    requestHistory.json.costs?.some((c: { id: string }) => c.id === legacyCost.json.id) &&
      tokenHistory.json.costs?.length > 0 &&
      tokenHistory.json.costs.every((c: { unit: string }) => c.unit === "image"),
    { request: requestHistory.json.costs, image: tokenHistory.json.costs },
  );

  const ended = await call(keyA, "POST", `${COSTS}/${tiered.json.id}/end`, {});
  const deleted = await call(keyA, "DELETE", `${COSTS}/${later.json.id}`);
  const startedDelete = await call(keyA, "DELETE", `${COSTS}/${hd.json.id}`);
  check(
    "a tiered row ends; an unlisted row that has not started is deleted; a started one is not",
    ended.status === 200 &&
      ended.json.effective_to !== null &&
      deleted.status === 200 &&
      deleted.json.deleted === true &&
      startedDelete.status === 409 &&
      !(await ids("&listed=false")).includes(later.json.id),
    { ended: ended.json, deleted: deleted.json, startedDelete: startedDelete.json },
  );
}

// ── T11 the second (media) source ────────────────────────────────────────────────────────────
console.log("T11 the second (media) source");
{
  const LITELLM = readFileSync(
    new URL("../test/unit/fixtures/model-prices-litellm.json", import.meta.url),
    "utf8",
  ).trim();
  /** The fixture plus test entries (raw JSON members). */
  const mediaWith = (...extra: string[]) =>
    extra.length ? `${LITELLM.slice(0, -1).trimEnd()},${extra.join(",")}}` : LITELLM;
  // The same model as the first feed's gpt-4o, and one of its aliases, under other providers
  // with image prices only; and one image price on the first feed's own model.
  const SHADOWS = [
    '"gpt-4o": {"litellm_provider": "openai", "mode": "image_generation", "output_cost_per_image": 0.04}',
    '"azure/gpt-4o": {"litellm_provider": "azure", "mode": "image_generation", "output_cost_per_image": 0.04}',
    '"bedrock/gpt-4o": {"litellm_provider": "bedrock", "mode": "image_generation", "output_cost_per_image": 0.05}',
    '"azure/gpt-4o-2024-08-06": {"litellm_provider": "azure", "mode": "image_generation", "output_cost_per_image": 0.04}',
  ];
  const [last] = rows<{ ms: string }>(
    await systemDb.execute(sql`select (extract(epoch from max(effective_from)) * 1000)::bigint::text
      as ms from model_prices where effective_from <> 'infinity'`),
  );
  let t = Number(last!.ms) + HOUR;
  const next = () => new Date((t += HOUR));
  const count = async (q: string) => rows<{ n: number }>(await systemDb.execute(sql.raw(q)))[0]!.n;
  const events = () =>
    count("select count(*)::int as n from events where type = 'model_prices_changed'");
  const notices = () => count("select count(*)::int as n from model_price_notices");
  const mediaRow = async () =>
    rows<Record<string, unknown>>(
      await systemDb.execute(sql`select upstream_version, checked_at::text, check_error,
        last_success_at::text from reference_data_sources where source = ${MEDIA_SOURCE}`),
    )[0] ?? null;
  const tokenKey = { model: "gpt-4o", tokenType: "input", currency: "USD" };
  const aliasKey = { ...tokenKey, model: "gpt-4o-2024-08-06" };
  const lookups = (at: Date) =>
    withTenant(A.orgId, async (tx) => [
      await resolveListPrice(tx, tokenKey, at),
      await resolveListPrice(tx, aliasKey, at),
      await resolveListPrice(
        tx,
        { model: "claude-opus-4", tokenType: "input", currency: "USD" },
        at,
      ),
    ]);

  // A first-feed model of our own, so a change to a key that feed owns is easy to see.
  src.etag = '"v8b"';
  src.body = `${src.body.trimEnd().slice(0, -1)},{"id":"t11","models":[{"id":"t11-model","prices":{"input_mtok":1}}]}]`;
  await sync(next());

  // One merged run: the first feed answers 304 and is read again in full.
  const t0 = next();
  const before = await lookups(t0);
  const eventsBefore = await events();
  const noticesBefore = await notices();
  const rowsBefore = await countRows();
  med.etag = '"m1"';
  med.body = mediaWith(...SHADOWS);
  const hitsA = src.hits;
  const first = await syncBoth(t0);
  check(
    "a first two-source run adds the media prices: no hold, no change, no notice",
    first.status === "applied" &&
      first.changes === 0 &&
      first.rows > 20 &&
      first.heldRows === undefined &&
      first.mediaModels! > 10 &&
      (await countRows()) === rowsBefore + first.rows &&
      (await events()) === eventsBefore &&
      (await notices()) === noticesBefore &&
      (await readModelPriceSource()).held === null,
    first,
  );
  check(
    "…the first feed answered 304, then was read in full for the merge",
    src.hits - hitsA === 2,
    { hits: src.hits - hitsA },
  );
  const m1 = await mediaRow();
  check(
    "…the media source keeps its own ETag and success",
    m1?.upstream_version === '"m1"' && m1.check_error === null && m1.last_success_at != null,
    m1,
  );
  const tagged = rows<{ s: string; v: string | null; n: number }>(
    await systemDb.execute(sql`select source as s, source_version as v, count(*)::int as n
      from model_prices where sync_run_id = (select sync_run_id from model_prices
        where source = 'litellm' limit 1) group by 1, 2`),
  );
  check(
    "…every row it wrote names its source and version",
    tagged.length === 1 && tagged[0]!.s === "litellm" && tagged[0]!.v === '"m1"',
    tagged,
  );
  const names = rows<{ aliases: string[] }>(
    await systemDb.execute(sql`select aliases from model_price_models
      where provider = 'openai' and model = 'gpt-4o'`),
  )[0];
  const after = await lookups(t0);
  check(
    "the first feed's names survive: gpt-4o keeps its aliases",
    JSON.stringify(names?.aliases) === '["gpt-4o-2024-08-06","gpt-4o-2024-11-20"]',
    names,
  );
  check(
    "token and alias lookups with no provider resolve the same rows as before",
    JSON.stringify(after, (_k, v) => (typeof v === "bigint" ? String(v) : v)) ===
      JSON.stringify(before, (_k, v) => (typeof v === "bigint" ? String(v) : v)) &&
      after.every((h) => h.kind === "list"),
    { before, after },
  );
  const at0 = new Date(t0.getTime() + 1);
  const [imgAmbiguous, imgOpenai, tiered, fallback, untiered] = await withTenant(
    A.orgId,
    async (tx) => [
      await resolveListPrice(
        tx,
        { model: "gpt-4o", tokenType: "output", currency: "USD", unit: "image" },
        at0,
      ),
      await resolveListPrice(
        tx,
        {
          provider: "openai",
          model: "gpt-4o",
          tokenType: "output",
          currency: "USD",
          unit: "image",
        },
        at0,
      ),
      await resolveListPrice(
        tx,
        {
          provider: "aws",
          model: "amazon.nova-canvas-v1:0",
          tokenType: "output",
          currency: "USD",
          unit: "image",
          quality: "50-steps",
          resolution: "1024x1024",
        },
        at0,
      ),
      await resolveListPrice(
        tx,
        {
          provider: "fal_ai",
          model: "fal-ai/nano-banana-2",
          tokenType: "output",
          currency: "USD",
          unit: "image",
          quality: "high",
          resolution: "8k",
        },
        at0,
      ),
      await resolveListPrice(
        tx,
        {
          provider: "fal_ai",
          model: "fal-ai/nano-banana-2",
          tokenType: "output",
          currency: "USD",
          unit: "image",
          resolution: "4k",
        },
        at0,
      ),
    ],
  );
  check(
    "an image price under several providers needs the provider named",
    imgAmbiguous.kind === null &&
      imgAmbiguous.reason === "ambiguous_provider" &&
      imgOpenai.kind === "list" &&
      imgOpenai.unitAmount === 4n * 10n ** 12n &&
      imgOpenai.source === "litellm",
    { imgAmbiguous, imgOpenai },
  );
  check(
    "an image model resolves through the tier order: exact, then no tier",
    tiered.kind === "list" &&
      tiered.quality === "50-steps" &&
      tiered.resolution === "1024x1024" &&
      tiered.unitAmount === 6n * 10n ** 12n &&
      fallback.kind === "list" &&
      fallback.quality === "" &&
      fallback.resolution === "" &&
      fallback.unitAmount === 8n * 10n ** 12n &&
      untiered.kind === "list" &&
      untiered.resolution === "4k" &&
      untiered.unitAmount === 16n * 10n ** 12n,
    { tiered, fallback, untiered },
  );

  // Both unchanged: nothing to do.
  const quiet = await syncBoth(next());
  check("both sources unchanged: not modified", quiet.status === "not_modified", quiet);

  // The media source fails; the first feed changes a key it owns and one the media feed owns.
  med.mode = "500";
  const m0 = await mediaRow();
  src.etag = '"v9"';
  const good = src.body;
  src.body = good
    .replace('{"input_mtok":1}', '{"input_mtok":1.1}')
    .replace('"audio_hours": 0.36,', '"audio_hours": 0.36, "output_audio_hours": 0.72,');
  const t1 = next();
  const mediaDown = await syncBoth(t1);
  const whisperOut = rows<{ s: string; v: string }>(
    await systemDb.execute(sql`select source as s, unit_amount_decimal::text as v from model_prices
      where provider = 'openai' and model = 'whisper-1' and token_type = 'output'
      order by effective_from desc limit 1`),
  )[0];
  const m2 = await mediaRow();
  const own = await withTenant(A.orgId, (tx) =>
    resolveListPrice(
      tx,
      { model: "t11-model", tokenType: "input", currency: "USD" },
      new Date(t1.getTime() + 1),
    ),
  );
  check(
    "the media source down: the first feed's own change still applies",
    mediaDown.status === "applied" &&
      mediaDown.failures?.length === 1 &&
      mediaDown.failures[0]!.source === "litellm" &&
      own.kind === "list" &&
      own.unitAmount === 110n * 10n ** 12n,
    { mediaDown, own },
  );
  check(
    "…a key the media source owns is left alone, not taken over",
    whisperOut?.s === "litellm" && whisperOut.v === "0.010000000000",
    whisperOut,
  );
  check(
    "…and the media source keeps its last success, with the error",
    m2?.check_error === "The source answered HTTP 500" &&
      m2.last_success_at === m0?.last_success_at &&
      m2.upstream_version === '"m1"',
    m2,
  );

  // The first feed fails; the media source changes one of its own prices.
  med.mode = "ok";
  src.mode = "500";
  med.etag = '"m2"';
  med.body = mediaWith(...SHADOWS.map((x) => x.replace("0.05}", "0.055}")));
  const firstDown = await syncBoth(next());
  const aws = rows<{ v: string }>(
    await systemDb.execute(sql`select unit_amount_decimal::text as v from model_prices
      where provider = 'aws' and model = 'gpt-4o' order by effective_from desc limit 1`),
  )[0];
  check(
    "the first feed down: the media source's own change applies, and the failure is stored",
    firstDown.status === "applied" &&
      firstDown.summary === null &&
      firstDown.failures?.[0]?.source === "genai-prices" &&
      aws?.v === "5.500000000000" &&
      (await sourceRow())?.check_error === "The source answered HTTP 500",
    { firstDown, aws },
  );
  src.mode = "ok";

  // A body over the media cap is refused.
  med.mode = "big";
  med.etag = '"m3"';
  const big = await syncBoth(next());
  check(
    "a media body over 12 MB is refused and stored as its error",
    big.failures?.some((f) => f.source === "litellm" && /12 MB/.test(f.error)) === true &&
      (await mediaRow())?.check_error === "The source sent more than 12 MB",
    big,
  );
  med.mode = "ok";

  // The two sources disagree by more than 25 % on tts-1 characters ($15 vs $20 per 1M).
  med.etag = '"m4"';
  // Whitespace-tolerant: a formatter may reflow the fixture.
  const TTS1 = /("tts-1":\s*\{\s*"input_cost_per_character":\s*)1\.5e-0?5/;
  if (!TTS1.test(LITELLM)) throw new Error("fixture: tts-1 character price not found");
  med.body = mediaWith(...SHADOWS).replace(TTS1, (_m, p: string) => `${p}2e-05`);
  const t2 = next();
  const disagree = await syncBoth(t2);
  const heldNow = (await readModelPriceSource()).held;
  check(
    "a key the sources price > 25 % apart is held with both prices; the rest applies",
    disagree.status === "applied" &&
      disagree.heldRows === 1 &&
      heldNow?.reasons.join() === "sources_disagree" &&
      heldNow.rows.length === 1 &&
      heldNow.rows[0]!.model === "tts-1" &&
      heldNow.rows[0]!.source === "litellm" &&
      heldNow.rows[0]!.unitAmount === "0.002000000000" &&
      heldNow.rows[0]!.crossCheck?.source === "genai-prices" &&
      heldNow.rows[0]!.crossCheck.unitAmount === "1500.000000000000",
    { disagree, heldNow },
  );
  const mHeld = await mediaRow();
  const releasedAt = new Date(t2.getTime() + 1000);
  const released = await releaseHeldModelPrices({ by: "staff@example.com", now: releasedAt });
  const mReleased = await mediaRow();
  check(
    "…a release of media rows moves the media source's last success to the release",
    mHeld?.last_success_at != null &&
      mReleased?.last_success_at !== mHeld.last_success_at &&
      mReleased?.last_success_at === (await sourceRow())?.last_success_at,
    { mHeld, mReleased },
  );
  const tts = rows<{ s: string; v: string; b: string | null }>(
    await systemDb.execute(sql`select source as s, unit_amount_decimal::text as v, released_by as b
      from model_prices where provider = 'openai' and model = 'tts-1' and unit = 'character'
      order by effective_from desc limit 1`),
  )[0];
  check(
    "…a release applies the media price, citing its source",
    released.rows === 1 &&
      tts?.s === "litellm" &&
      tts.v === "0.002000000000" &&
      tts.b === "staff@example.com",
    { released, tts },
  );
  med.etag = '"m5"';
  const settledDown = await syncBoth(next());
  check(
    "…and the next run writes nothing and holds nothing: no flapping",
    settledDown.status === "applied" &&
      settledDown.rows === 0 &&
      (await readModelPriceSource()).held === null,
    settledDown,
  );

  // A batch held before the second source (no source, no cross-check) still releases.
  await systemDb.execute(
    sql`update reference_data_sources set held_batch = ${JSON.stringify({
      syncRunId: "00000000-0000-7000-8000-00000000000b",
      heldAt: new Date(t).toISOString(),
      sourceVersion: '"old"',
      reasons: ["price_moved_tenfold"],
      knownKeys: 1,
      changedKeys: 1,
      rows: [
        {
          provider: "legacy",
          model: "legacy-held",
          tokenType: "input",
          unitAmount: "100.000000000000",
          divisor: "1000000",
          rounded: false,
          from: "now",
          sourceEffectiveFrom: null,
          oldUnitAmount: null,
        },
      ],
      models: [{ provider: "legacy", model: "legacy-held", aliases: [], contextTiers: null }],
    })}::jsonb where source = ${MODEL_PRICES_SOURCE}`,
  );
  const mOld = await mediaRow();
  const old = await releaseHeldModelPrices({ by: "staff@example.com", now: next() });
  check(
    "…and a release with no media row leaves the media source's last success alone",
    mOld?.last_success_at != null && (await mediaRow())?.last_success_at === mOld.last_success_at,
    mOld,
  );
  const oldRow = rows<{ s: string; v: string | null; u: string }>(
    await systemDb.execute(sql`select source as s, source_version as v, unit as u from model_prices
      where model = 'legacy-held'`),
  );
  check(
    "a batch held before the second source reads and releases as the first feed's",
    old.rows === 1 &&
      oldRow.length === 1 &&
      oldRow[0]!.s === "genai-prices" &&
      oldRow[0]!.v === '"old"' &&
      oldRow[0]!.u === "token",
    oldRow,
  );

  // The source endpoint names both.
  const info = await call(keyA, "GET", "/v1/organization/model_prices/source");
  check(
    "GET …/model_prices/source names both sources with their own state",
    info.status === 200 &&
      info.json.source === "genai-prices" &&
      info.json.sources?.length === 2 &&
      info.json.sources[1].source === "litellm" &&
      info.json.sources[1].upstream_version === '"m5"' &&
      /Berri AI/.test(info.json.sources[1].licence) &&
      info.json.sources[0].upstream_version === info.json.upstream_version,
    info.json,
  );

  // MODEL_PRICES_SYNC=off reads neither source.
  const cfg = config as { MODEL_PRICES_SYNC: "on" | "off" };
  cfg.MODEL_PRICES_SYNC = "off";
  const h0 = src.hits + med.hits;
  const off = await syncBoth(next());
  cfg.MODEL_PRICES_SYNC = "on";
  check(
    "MODEL_PRICES_SYNC=off reads neither source",
    off.status === "disabled" && src.hits + med.hits === h0,
    off,
  );
  src.body = good;
}

await app.close();
server.close();
await closeDb();
console.log(
  fails.length
    ? `\n✗ ${fails.length} failed: ${fails.join("; ")}`
    : "\n✓ verify:model-prices passed",
);
process.exit(fails.length ? 1 : 0);
