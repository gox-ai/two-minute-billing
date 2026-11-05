/**
 * Spend limits and limit tiers (design G5 §3.2–3.3, §8): per-property hard limits, holds in
 * scope, nesting at write, soft limits once per interval, tiers on settled payments only and
 * never demoted, buyer limits under the operator's, the access check blocking at a hard
 * limit and the on-arrival check (fast mark and fold backstop). Latency: `bench-usage-access.ts`.
 *
 *   pnpm verify:all:fresh -- --suite spend-limits
 */
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { publicId } from "@/platform/ids";
import { createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { addUsageKey } from "@/modules/metering/meters";
import { foldBusiness } from "@/modules/metering/fold";
import { ingestUsageEvents } from "@/modules/metering/ingest";
import { checkAccess } from "@/modules/credits/access";
import { createCreditHold } from "@/modules/credits/holds";
import { emitEvent } from "@/modules/events/emit";
import "@/modules/usage-controls/sink";
import {
  createSpendLimit,
  createTier,
  deleteSpendLimit,
  evaluateTiers,
  listSpendLimits,
  reachedTier,
  updateSpendLimit,
  UsageControlConflictError,
  UsageControlRuleError,
} from "@/modules/usage-controls/limits";
import { runUsageControlsCheck } from "@/modules/usage-controls/check";
import {
  businesses,
  emailMessages,
  events,
  meters,
  payments,
  refunds,
  usageControlDirty,
  usageRollupState,
  usageRollups,
} from "@db/schema";
import {
  checker,
  meterBusiness,
  newCustomer,
  sendEvent,
  setTerm,
  createTestMeter,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const { org, orgId, biz, ids, product } = await meterBusiness("Spend Limits Org");
const meter = await createTestMeter(ids);
await systemDb
  .update(meters)
  .set({ limitDimensions: ["user"] })
  .where(eq(meters.id, meter.id));
const H = 3_600_000;
const price = await createPrice({
  ...ids,
  productId: product.id,
  id: `sl-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: meter.key,
  unitAmountDecimal: "1",
});

async function subscribed(tag: string) {
  const c = await newCustomer(ids, tag);
  const sub = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, new Date(Date.now() - H), new Date(Date.now() + 20 * 24 * H));
  return c;
}
const record = (customerId: string, tokens: number, props: Record<string, string> = {}) =>
  sendEvent(ids, {
    customerId,
    eventName: meter.eventName,
    at: new Date(Date.now() - 5 * 60_000),
    properties: { tokens, ...props },
  });
const access = (
  customerId: string,
  extra: { estimate?: number; scope?: Record<string, string> } = {},
) =>
  checkAccess({
    ...ids,
    customerId,
    meterKey: meter.key,
    estimateMinor: extra.estimate != null ? BigInt(extra.estimate) : null,
    scope: extra.scope ?? null,
  });
const limit = (
  customerId: string,
  f: Partial<Parameters<typeof createSpendLimit>[0]["fields"]> & { amountMinor: bigint },
) =>
  createSpendLimit({
    ...ids,
    customerId,
    fields: {
      scope: "customer",
      interval: "day",
      currency: "USD",
      mode: "hard",
      setBy: "operator",
      ...f,
    },
  });
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e as Error;
  }
};
const scoped = <T>(fn: () => Promise<T>, now?: Date) =>
  runWithClockScope({ onlyBusinessId: biz.id, ...(now ? { now } : {}) }, fn);
const limitEvents = async (limitPublicId: string) =>
  (
    await systemDb
      .select({ id: events.id, data: events.data })
      .from(events)
      .where(
        and(
          eq(events.businessId, biz.id),
          eq(events.type, "spend_limit_reached"),
          sql`${events.data} -> 'spend_limit' ->> 'id' = ${limitPublicId}`,
        ),
      )
  ).length;

// ── 1. A per-user hard limit (each value of a property) ─────────────────────────
console.log("1. per-property hard limit");
const pu = await subscribed("per-user");
await limit(pu.id, { scope: "property", propertyKey: "user", amountMinor: 100n });
await record(pu.id, 150, { user: "alice" });
await record(pu.id, 50, { user: "bob" });
const a1 = await access(pu.id, { scope: { user: "alice" } });
check(
  "user alice (150 of 100 today) → spend_limit_reached, limits[0] names alice",
  a1.code === "spend_limit_reached" &&
    a1.limits.length === 1 &&
    a1.limits[0]?.property_value === "alice" &&
    a1.limits[0]?.spent_minor === 150,
  a1.limits,
);
const b1 = await access(pu.id, { scope: { user: "bob" }, estimate: 10 });
check(
  "user bob (50 + 10 of 100) → ok; the property filter keeps alice's usage out",
  b1.code === "ok" && b1.limits.some((l) => l.property_value === "bob" && l.spent_minor === 50),
  b1.limits,
);
const n1 = await access(pu.id);
check(
  "no user in the request → not refused, the limit is reported not_checked",
  n1.code === "ok" && n1.limits.some((l) => l.status === "not_checked"),
  n1.limits,
);
const prop422 = await refusal(
  limit(pu.id, { scope: "property", propertyKey: "team", amountMinor: 10n }),
);
check(
  "a property that is not a limit property of the meters → 422 on property_key",
  prop422 instanceof UsageControlRuleError && prop422.param === "property_key",
  prop422?.message,
);

// ── 2. Holds in scope, estimates, an expired hold ───────────────────────────────
console.log("2. holds");
const hc = await subscribed("holds");
await limit(hc.id, { amountMinor: 1000n });
await record(hc.id, 600);
await createCreditHold({ ...ids, customerId: hc.id, amountMinor: 300n, meterKey: meter.key });
check(
  "600 spent + 300 held + 50 estimate ≤ 1,000 → ok",
  (await access(hc.id, { estimate: 50 })).code === "ok",
);
const h2 = await access(hc.id, { estimate: 150 });
check(
  "600 spent + 300 held + 150 estimate > 1,000 → spend_limit_reached (holds count)",
  h2.code === "spend_limit_reached" && h2.limits[0]?.open_holds_minor === 300,
  h2.limits,
);
const later = await scoped(
  () => access(hc.id, { estimate: 150 }),
  new Date(Date.now() + 2 * 60_000),
);
check(
  "2 minutes later the 1-minute hold has expired and stops counting → ok",
  later.code === "ok",
  later.limits,
);

// ── 3. Nesting at write ─────────────────────────────────────────────────────────
console.log("3. nesting");
const nc = await subscribed("nest");
await limit(nc.id, { interval: "week", amountMinor: 500n });
const nest = await refusal(limit(nc.id, { interval: "day", amountMinor: 600n }));
check(
  "a daily limit above the weekly one → refused: “The daily limit cannot be more than the weekly limit.”",
  nest instanceof UsageControlRuleError &&
    nest.message === "The daily limit cannot be more than the weekly limit.",
  nest?.message,
);
const app = await buildApp({ logger: false });
const api = (method: "POST" | "GET" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(method === "GET" ? {} : { "idempotency-key": `sl-${Date.now()}-${Math.random()}` }),
    },
    ...(payload ? { payload: payload as object } : {}),
  });
const http422 = await api("POST", `/customers/${nc.publicId}/spend_limits`, {
  scope: "customer",
  interval: "month",
  amount_minor: 400,
  currency: "USD",
});
check(
  "API: a monthly limit below the weekly one → 422 naming amount_minor",
  http422.statusCode === 422 && JSON.parse(http422.body).error?.param === "amount_minor",
  http422.body,
);

// The meter API sets the limit properties (0475), even after the meter has usage.
const dimsOk = await api("PATCH", `/meters/${meter.key}`, { limit_dimensions: ["user", "region"] });
const dimsBad = await api("PATCH", `/meters/${meter.key}`, {
  limit_dimensions: ["a", "b", "c", "d"],
});
check(
  "API: PATCH a meter's limit_dimensions → 200 and returned; 4 properties → 400",
  dimsOk.statusCode === 200 &&
    JSON.stringify(JSON.parse(dimsOk.body).limit_dimensions) === '["user","region"]' &&
    dimsBad.statusCode === 400,
  [dimsOk.statusCode, dimsOk.body.slice(0, 200), dimsBad.statusCode],
);
await api("PATCH", `/meters/${meter.key}`, { limit_dimensions: ["user"] });

// ── 4. A soft limit emits once per interval ─────────────────────────────────────
console.log("4. soft limit");
const sc = await subscribed("soft");
const soft = await limit(sc.id, { mode: "soft", amountMinor: 100n });
await record(sc.id, 150);
await scoped(() => runUsageControlsCheck());
await record(sc.id, 10);
await withTenant(orgId, (tx) =>
  tx.execute(sql`insert into usage_control_dirty (customer_id, organization_id, business_id)
    values (${sc.id}, ${orgId}, ${biz.id}) on conflict do nothing`),
);
await scoped(() => runUsageControlsCheck());
check(
  "spend 150 then 160 against a soft 100/day → spend_limit_reached once",
  (await limitEvents(soft.publicId)) === 1,
);
check("a soft limit never refuses the access check", (await access(sc.id)).code === "ok");

// The spend_limit_reached email is opt-in: off until the business switches it on.
const mails = async (customerId: string) =>
  (
    await systemDb
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.customerId, customerId),
          eq(emailMessages.type, "spend_limit_reached"),
        ),
      )
  ).length;
const markDirtyNow = (customerId: string) =>
  withTenant(orgId, (tx) =>
    tx.execute(sql`insert into usage_control_dirty (customer_id, organization_id, business_id)
      values (${customerId}, ${orgId}, ${biz.id}) on conflict do nothing`),
  );
const setMail = (types: Record<string, boolean>) =>
  systemDb
    .update(businesses)
    .set({ emailConfig: { enabled: true, types } })
    .where(eq(businesses.id, biz.id));
await setMail({});
const mOff = await subscribed("mail-off");
const mOffLimit = await limit(mOff.id, { mode: "soft", amountMinor: 100n });
await record(mOff.id, 150);
await scoped(() => runUsageControlsCheck());
check(
  "email on, spend_limit_reached never switched on → the event fires, no email",
  (await limitEvents(mOffLimit.publicId)) === 1 && (await mails(mOff.id)) === 0,
);
await setMail({ spend_limit_reached: true });
const mOn = await subscribed("mail-on");
const mOnLimit = await limit(mOn.id, { mode: "soft", amountMinor: 100n });
await record(mOn.id, 150);
await scoped(() => runUsageControlsCheck());
await record(mOn.id, 10);
await markDirtyNow(mOn.id);
await scoped(() => runUsageControlsCheck());
check(
  "switched on → one email per limit crossing, nothing more on the next check",
  (await limitEvents(mOnLimit.publicId)) === 1 && (await mails(mOn.id)) === 1,
  { mails: await mails(mOn.id) },
);
await systemDb.update(businesses).set({ emailConfig: null }).where(eq(businesses.id, biz.id));

// ── 5. Tiers: settled payments only, never demoted ──────────────────────────────
console.log("5. tiers");
const tier = await createTier({
  ...ids,
  currency: "USD",
  levelMinor: 1000n,
  amounts: { day: 5000 },
});
const tc = await subscribed("tier");
await limit(tc.id, { amountMinor: 100n });
await record(tc.id, 150);
check(
  "before any payment: own limit 100/day refuses 150",
  (await access(tc.id)).code === "spend_limit_reached",
);
const payId = publicId("pay");
const [pay] = await systemDb
  .insert(payments)
  .values({
    ...ids,
    customerId: tc.id,
    publicId: payId,
    status: "pending",
    amountMinor: 1200n,
    currency: "USD",
    providerKey: "tmtest",
  })
  .returning();
await withTenant(orgId, (tx) => evaluateTiers(tx, { ...ids, customerId: tc.id, currency: "USD" }));
check(
  "a pending payment of 1,200 reaches no tier",
  (await withTenant(orgId, (tx) => reachedTier(tx, tc.id, "USD"))) === null,
);
await systemDb.update(payments).set({ status: "succeeded" }).where(eq(payments.id, pay!.id));
await withTenant(orgId, (tx) =>
  emitEvent(tx, {
    ...ids,
    type: "payment_succeeded",
    data: { payment: { id: payId } },
  }),
);
const reached = await withTenant(orgId, (tx) => reachedTier(tx, tc.id, "USD"));
const tierEv = await systemDb
  .select({ id: events.id })
  .from(events)
  .where(and(eq(events.businessId, biz.id), eq(events.type, "customer_limit_tier_reached")));
check(
  "the settled payment's event reaches the tier in its own transaction, with customer_limit_tier_reached",
  reached?.tier.publicId === tier.publicId && tierEv.length === 1,
  { reached: reached?.tier.publicId, events: tierEv.length },
);
check(
  "the tier raises the 100/day limit to 5,000: 150 is allowed",
  (await access(tc.id)).code === "ok",
);
await systemDb.insert(refunds).values({
  ...ids,
  paymentId: pay!.id,
  publicId: publicId("re"),
  status: "succeeded",
  amountMinor: 1200n,
  currency: "USD",
  providerKey: "tmtest",
});
await withTenant(orgId, (tx) => evaluateTiers(tx, { ...ids, customerId: tc.id, currency: "USD" }));
check(
  "a full refund (lifetime paid 0) does not demote: 150 still allowed",
  (await access(tc.id)).code === "ok",
);
// A chargeback reverses the payment itself.
await systemDb.update(payments).set({ status: "failed" }).where(eq(payments.id, pay!.id));
check(
  "a chargeback does not demote either",
  (await access(tc.id)).code === "ok" &&
    (await withTenant(orgId, (tx) => reachedTier(tx, tc.id, "USD")))?.tier.publicId ===
      tier.publicId,
);
const del = await refusal(
  withTenant(orgId, (tx) =>
    tx.execute(sql`delete from customer_limit_tier_reached where customer_id = ${tc.id}`),
  ),
);
check("a reached tier row cannot be deleted (append-only grants)", del !== null);

// ── 6. Buyer limits ─────────────────────────────────────────────────────────────
console.log("6. buyer limits");
const bc = await subscribed("buyer");
const op = await limit(bc.id, { amountMinor: 500n });
const over = await refusal(limit(bc.id, { setBy: "customer", amountMinor: 600n }));
check(
  "a buyer limit above the operator's → refused with the provider's limit",
  over instanceof UsageControlRuleError &&
    over.message ===
      "We could not save the limit. Your provider's limit is $5.00. Set a limit of $5.00 or less.",
  over?.message,
);
const mintPortal = async (cusPublicId: string) => {
  const mint = await api("POST", `/customers/${cusPublicId}/portal_sessions`);
  const res = await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${JSON.parse(mint.body).token}` },
  });
  return (JSON.parse(res.body) as { token: string }).token;
};
const ptok = await mintPortal(bc.publicId);
const portal = (method: "POST" | "GET" | "DELETE", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${ptok}`,
      ...(method === "GET" ? {} : { "idempotency-key": `pl-${Date.now()}-${Math.random()}` }),
    },
    ...(payload ? { payload: payload as object } : {}),
  });
const pOver = await portal("POST", "/portal/v1/spend_limits", {
  scope: "customer",
  interval: "day",
  amount_minor: 600,
  currency: "USD",
});
check("portal: a limit above the provider's → 422", pOver.statusCode === 422, pOver.body);
const pOk = await portal("POST", "/portal/v1/spend_limits", {
  scope: "customer",
  interval: "day",
  amount_minor: 50,
  currency: "USD",
});
check("portal: a lower limit (50) is saved", pOk.statusCode === 201, pOk.body);
await record(bc.id, 60);
const b6 = await access(bc.id);
check(
  "the tighter limit applies: 60 spent refused by the buyer's 50, not the operator's 500",
  b6.code === "spend_limit_reached" && b6.limits[0]?.set_by === "customer",
  b6.limits,
);
const pDelOp = await portal("DELETE", `/portal/v1/spend_limits/${op.publicId}`);
check(
  "portal: the buyer cannot delete the operator's limit (409)",
  pDelOp.statusCode === 409,
  pDelOp.body,
);
const svcDel = await refusal(
  deleteSpendLimit({ ...ids, customerId: bc.id, limit: op.publicId, asBuyer: true }),
);
check(
  "service: asBuyer delete of an operator row → conflict",
  svcDel instanceof UsageControlConflictError,
);
const pList = await portal("GET", "/portal/v1/spend_limits");
const listed = JSON.parse(pList.body).data as Array<{ id: string; editable: boolean }>;
check(
  "portal list: operator row read-only, buyer row editable",
  listed.find((l) => l.id === op.publicId)?.editable === false &&
    listed.find((l) => l.id === JSON.parse(pOk.body).id)?.editable === true,
  listed,
);
const pDelOwn = await portal("DELETE", `/portal/v1/spend_limits/${JSON.parse(pOk.body).id}`);
check("portal: the buyer deletes its own limit", pDelOwn.statusCode === 200, pDelOwn.body);

// The operator's list measures each limit: what was spent in its interval and whether it is reached.
const opList = JSON.parse((await api("GET", `/customers/${bc.publicId}/spend_limits`)).body)
  .data as Array<{ id: string; spent_minor: number | null; reached: boolean | null }>;
check(
  "operator list: the 500/day limit shows 60 spent, not reached",
  opList.find((l) => l.id === op.publicId)?.spent_minor === 60 &&
    opList.find((l) => l.id === op.publicId)?.reached === false,
  opList,
);

// A tier customer: the provider's limit is the effective one, the tier included.
const tierTok = await mintPortal(tc.publicId);
const asTier = (method: "POST" | "GET", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${tierTok}`,
      ...(method === "GET" ? {} : { "idempotency-key": `pt-${Date.now()}-${Math.random()}` }),
    },
    ...(payload ? { payload: payload as object } : {}),
  });
const tierRows = JSON.parse((await asTier("GET", "/portal/v1/spend_limits")).body).data as Array<{
  set_by: string;
  interval: string;
  effective_amount_minor: number;
}>;
check(
  "portal (tier customer): the provider's 100/day limit shows 5,000, the tier's amount",
  tierRows.some(
    (l) => l.set_by === "operator" && l.interval === "day" && l.effective_amount_minor === 5000,
  ),
  tierRows,
);
const tOver = await asTier("POST", "/portal/v1/spend_limits", {
  scope: "customer",
  interval: "day",
  amount_minor: 6000,
  currency: "USD",
});
check(
  "portal (tier customer): 6,000 is above the effective 5,000 → 422",
  tOver.statusCode === 422 && JSON.parse(tOver.body).error?.message?.includes("$50.00"),
  tOver.body,
);
const [tcOwn] = await listSpendLimits(orgId, biz.id, tc.id, { setBy: "operator" });
await updateSpendLimit({ ...ids, customerId: tc.id, limit: tcOwn!.publicId, amountMinor: 300n });
const tLow = await asTier("POST", "/portal/v1/spend_limits", {
  scope: "customer",
  interval: "day",
  amount_minor: 400,
  currency: "USD",
});
const lowRows = JSON.parse((await asTier("GET", "/portal/v1/spend_limits")).body).data as Array<{
  set_by: string;
  effective_amount_minor: number;
}>;
check(
  "portal (tier customer): the operator lowered its limit after the tier, so 300 applies; 400 → 422",
  tLow.statusCode === 422 &&
    lowRows.some((l) => l.set_by === "operator" && l.effective_amount_minor === 300),
  { status: tLow.statusCode, lowRows },
);

// A customer with usage to limit and no limit yet may add one; one without usage may not.
const listAs = async (cusPublicId: string) => {
  const tok = await mintPortal(cusPublicId);
  const res = await app.inject({
    method: "GET",
    url: "/portal/v1/spend_limits",
    headers: { authorization: `Bearer ${tok}` },
  });
  return JSON.parse(res.body) as { data: unknown[]; can_add?: boolean };
};
const fresh = await listAs((await subscribed("fresh")).publicId);
const bare = await listAs((await newCustomer(ids, "bare")).publicId);
check(
  "portal list: can_add for a usage customer with no limit; not for one with no usage",
  fresh.data.length === 0 && fresh.can_add === true && bare.can_add === false,
  { fresh, bare },
);

// ── 7. On arrival: the fast mark and the fold backstop ──────────────────────────
console.log("7. on arrival");
const oa = await subscribed("arrive");
await addUsageKey({ ...ids, customerId: oa.id, key: `acct-${oa.id}` });
const oaLimit = await limit(oa.id, { mode: "soft", amountMinor: 50n });
await scoped(() => runUsageControlsCheck());
const sent = await ingestUsageEvents({
  ...ids,
  events: [
    {
      key: `arr-${Date.now()}`,
      customer: `acct-${oa.id}`,
      event_name: meter.eventName,
      properties: { tokens: "60" },
    },
  ],
});
const [mark] = await systemDb
  .select()
  .from(usageControlDirty)
  .where(eq(usageControlDirty.customerId, oa.id));
check(
  "ingest writes the dirty mark in its own transaction",
  sent[0]?.status === "created" && !!mark,
  sent,
);
const t0 = Date.now();
const run = await scoped(() => runUsageControlsCheck());
const rolled = await systemDb
  .select({ n: sql<number>`count(*)::int` })
  .from(usageRollups)
  .where(eq(usageRollups.customerId, oa.id));
check(
  "the next check run sees the crossing before any fold (no rollups for the customer)",
  (await limitEvents(oaLimit.publicId)) === 1 && rolled[0]?.n === 0 && run.claimed >= 1,
  { run, rolled },
);
check("…in well under a minute", Date.now() - t0 < 60_000, Date.now() - t0);

const bk = await subscribed("backstop");
const bkLimit = await limit(bk.id, { mode: "soft", amountMinor: 50n });
await scoped(() => runUsageControlsCheck());
const hourAgo = new Date(Date.now() - H);
await systemDb
  .insert(usageRollupState)
  .values({ ...ids, watermark: hourAgo })
  .onConflictDoUpdate({ target: usageRollupState.businessId, set: { watermark: hourAgo } });
await systemDb.update(meters).set({ foldedFrom: hourAgo }).where(eq(meters.id, meter.id));
await record(bk.id, 60); // written straight to the table: no fast mark
const [noMark] = await systemDb
  .select()
  .from(usageControlDirty)
  .where(eq(usageControlDirty.customerId, bk.id));
await foldBusiness({ organizationId: orgId, businessId: biz.id, graceMs: 0 });
const [foldMark] = await systemDb
  .select()
  .from(usageControlDirty)
  .where(eq(usageControlDirty.customerId, bk.id));
await scoped(() => runUsageControlsCheck());
check(
  "with no fast mark, the fold backstop marks the customer and the check fires",
  !noMark && !!foldMark && (await limitEvents(bkLimit.publicId)) === 1,
  { noMark: !!noMark, foldMark: !!foldMark },
);

await app.close();
await closeDb();
if (fails.length) {
  console.log(`\n❌ SPEND-LIMITS: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("\n✅ SPEND-LIMITS: PASS");
process.exit(0);
