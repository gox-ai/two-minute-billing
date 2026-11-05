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
 *    `SETTLE_MS` applies on its own (a changed ETag with the same suspect prices keeps the clock).
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
  MODEL_PRICES_SOURCE,
  NoHeldBatchError,
  readModelPriceSource,
  releaseHeldModelPrices,
  runModelPriceSync,
  SETTLE_MS,
  SETTLED_BY,
} from "@/modules/model-prices/sync";
import { recordModelPriceChanges, runModelPriceNotices } from "@/modules/model-prices/notices";
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
  sql`delete from reference_data_sources where source = ${MODEL_PRICES_SOURCE}`,
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
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
const sync = (now = new Date()) => runModelPriceSync({ url: URL_, now });

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

await app.close();
server.close();
await closeDb();
console.log(
  fails.length
    ? `\n✗ ${fails.length} failed: ${fails.join("; ")}`
    : "\n✓ verify:model-prices passed",
);
process.exit(fails.length ? 1 : 0);
