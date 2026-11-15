/**
 * Async transfers (0517): a stored plan, an apply that queues the `transfer_run` job, and a
 * runner that applies item by item. The runner is called directly; no worker is needed.
 *  a plan is stored and reads back the same; a newer plan supersedes; HTTP shows items
 *  b a blocking item stops the apply; leaving it out lets it pass
 *  c a source change after the plan is drift (409)
 *  d a queued run completes; references point at destination rows
 *  e a killed runner resumes with no duplicate rows
 *  f retry runs only the failed items and the ones they held back
 *  g cancel a queued run and a running one
 *  h one active run per destination
 *  i prices with live subscriptions keep their billing fields
 *  j secrets are never copied
 *  k permissions: live updates need transfers:live_override
 *  l audit rows
 *  m the clock pass queues a stalled run again
 *  n Billy's get_transfer_status reads through its route
 *  o clear-first into a test destination
 *  p test twins: the test pair first; its failure leaves live untouched
 *  q a clear-first the destination's rows refuse is blocked at plan time
 *  r list filters; the numbering blocker names the business
 *  s a plan of 5,000 coupons stores, excludes, applies and reads back; counts without items,
 *    and the paged items list (filters, cursor, limit cap, tenancy)
 *
 *   pnpm verify:transfer-async
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createApiKey, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createProduct, createPrice, createProductGroup } from "@/modules/catalog/service";
import { createCoupon } from "@/modules/coupons/service";
import { createFlatTaxRate, createTaxProfile } from "@/modules/tax/service";
import { createMeter } from "@/modules/metering/meters";
import { createCreditUnit } from "@/modules/credits/service";
import { createCustomer } from "@/modules/customers/service";
import { saveSmtpSettings } from "@/modules/emails/smtp-service";
import { readSmtpPassword } from "@/modules/emails/smtp-config";
import { signup, inviteUser, acceptInvite } from "@/modules/auth/service";
import { TransferError } from "@/modules/transfer/plan";
import {
  TransferConflictError,
  TransferForbiddenError,
  reapStuckTransfers,
} from "@/modules/transfer/service";
import {
  applyTransferPlan,
  cancelTransferRun,
  createTransferPlan,
  getTransferRun,
  retryTransferRun,
  setItemExclusions,
  TransferDriftError,
  type PlanInput,
} from "@/modules/transfer/runs";
import { runTransferJob, requeueStalledRuns, SimulatedCrash } from "@/modules/transfer/runner";
import { writes } from "@/modules/transfer/graph";
import { TOOLS } from "@/modules/assistant-tools/catalog";
import { callRoute } from "@/modules/assistant-tools/route-call";
import { setMailer } from "@/providers/mailer";
import { buildApp } from "@/index";
import { pinMfaMandateOff } from "./lib/mfa-policy";
import {
  attachedItems,
  auditLogs,
  authTokens,
  businesses,
  couponItemConstraints,
  coupons,
  creditUnits,
  differentialPrices,
  meters,
  prices,
  productGroups,
  products,
  subscriptionItems,
  subscriptions,
  taxProfiles,
  transferConfigurations,
  transferItems,
} from "@db/schema";

pinMfaMandateOff();
const sent: Array<{ to: string; subject: string }> = [];
setMailer({
  kind: "smtp",
  target: null,
  async send(msg) {
    sent.push({ to: msg.to, subject: msg.subject });
    return { providerMessageId: `m-${sent.length}`, status: "sent" };
  },
});

const checks: Array<[string, boolean, string]> = [];
const ok = (n: string, c: boolean, detail: unknown = "") =>
  checks.push([n, c, typeof detail === "string" ? detail : JSON.stringify(detail)]);
const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

// ── fixture ────────────────────────────────────────────────────────────────────
const PW = "Correct-Horse-Battery-9";
const uniq = randomBytes(4).toString("hex");
const em = (r: string) => `transfer-async-${r}-${uniq}@example.com`;
const owner = await signup({
  email: em("owner"),
  password: PW,
  organizationName: `Transfer Async ${uniq}`,
});
const orgId = owner.user.organizationId;
const ids = (b: { id: string }) => ({ organizationId: orgId, businessId: b.id });

const live = await createBusiness({
  organizationId: orgId,
  name: "Studio",
  defaultCurrency: "USD",
  livemode: "live",
});
const [srcT] = await withTenant(orgId, (tx) =>
  tx.select().from(businesses).where(eq(businesses.liveBusinessId, live.id)),
);
if (!srcT) throw new Error("fixture: the live business has no test twin");
const S = ids(srcT);

// Catalog: groups, plans, an add-on, charges, prices in two currencies, a meter price, a credit pack.
await createProductGroup({ ...S, name: "Core plans", id: "core" });
await createProductGroup({ ...S, name: "Extras", id: "extras" });
const meter = await createMeter({
  ...S,
  key: "api-calls",
  definition: { name: "API calls", eventName: "api.call", aggregation: "count" },
});
await createCreditUnit({
  ...S,
  key: "token",
  unit: { name: "token", pluralName: "tokens", currency: "USD", minorPerUnitE12: 100_000_000_000n },
});
await createFlatTaxRate({ ...S, name: "VAT", country: "GB", rateBps: 2000 });
const reduced = await createTaxProfile({ ...S, name: "Reduced" });
const starter = await createProduct({
  ...S,
  name: "Starter",
  id: "starter",
  kind: "plan",
  productGroupPublicId: "core",
});
const growth = await createProduct({
  ...S,
  name: "Growth",
  id: "growth",
  kind: "plan",
  productGroupPublicId: "core",
});
const seats = await createProduct({
  ...S,
  name: "Seats",
  id: "seats",
  kind: "addon",
  productGroupPublicId: "extras",
});
const setup = await createProduct({
  ...S,
  name: "Setup",
  id: "setup",
  kind: "charge",
  productGroupPublicId: "extras",
});
const tokenPack = await createProduct({
  ...S,
  name: "Token pack",
  id: "token-pack",
  kind: "charge",
  productGroupPublicId: "extras",
});
await withTenant(orgId, (tx) =>
  tx.update(products).set({ taxProfileId: reduced.id }).where(eq(products.id, growth.id)),
);
const flat = (productId: string, id: string, currency: string, amountMinor: number) =>
  createPrice({
    ...S,
    productId,
    id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor,
    interval: "month",
  });
await flat(starter.id, "starter-usd-m", "USD", 1900);
await flat(starter.id, "starter-eur-m", "EUR", 1700);
await flat(growth.id, "growth-usd-m", "USD", 4900);
await flat(growth.id, "growth-eur-m", "EUR", 4500);
await flat(seats.id, "seats-usd-m", "USD", 500);
await createPrice({
  ...S,
  productId: growth.id,
  id: "api-usage",
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: meter.key,
  unitAmountDecimal: "0.5",
});
await createPrice({
  ...S,
  productId: setup.id,
  id: "setup-usd",
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 9900,
});
await createPrice({
  ...S,
  productId: tokenPack.id,
  id: "token-pack-usd",
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 800,
  grantsCredit: { kind: "pack", unit: "token", amount: 1000, tax_treatment: "taxed_at_purchase" },
});
await withTenant(orgId, (tx) =>
  tx.insert(attachedItems).values({
    ...S,
    itemProductId: seats.id,
    planProductId: growth.id,
    applicability: "recommended",
  }),
);
// Two differential prices that differ only by currency.
await withTenant(orgId, (tx) =>
  tx.insert(differentialPrices).values(
    (["USD", "EUR"] as const).map((currency) => ({
      ...S,
      addonProductId: seats.id,
      planProductId: growth.id,
      publicId: publicId("dprice"),
      currency,
      interval: "month",
      amountMinor: currency === "USD" ? 400n : 350n,
    })),
  ),
);
const coupon = await createCoupon({
  ...S,
  code: "WELCOME20",
  kind: "percentage",
  percentOffBps: 2000,
  durationType: "once",
});
await withTenant(orgId, async (tx) => {
  await tx.update(coupons).set({ timesRedeemed: 3 }).where(eq(coupons.id, coupon.id));
  await tx.insert(couponItemConstraints).values({
    ...S,
    couponId: coupon.id,
    itemKind: "plan",
    constraintType: "specific",
    productIds: ["growth"],
  });
});
await updateBusiness(orgId, srcT.publicId, { defaultDueDays: 14 });
const SECRET = "smtp-pass-31c8e2";
await saveSmtpSettings(orgId, srcT.id, {
  enabled: true,
  host: "smtp.src.example",
  port: 587,
  encryption: "starttls",
  username: "mailer",
  password: SECRET,
});
const srcEnc = (
  await withTenant(orgId, (tx) => tx.select().from(businesses).where(eq(businesses.id, srcT.id)))
)[0]!.smtpCredentialsEnc!;

// ── helpers ────────────────────────────────────────────────────────────────────
const ALL6 = [
  "catalog",
  "coupons",
  "tax_rates",
  "settings",
  "company_profile",
  "email_sending",
] as const;
const OWNER = new Set(["transfers:manage", "transfers:live_override"]);
const newTest = (name: string) =>
  createBusiness({ organizationId: orgId, name, defaultCurrency: "USD", livemode: "test" });
const plan = (dest: { id: string }, extra: Partial<PlanInput> = {}) =>
  createTransferPlan({
    organizationId: orgId,
    sourceBusinessId: srcT.id,
    destinationBusinessId: dest.id,
    sections: [...ALL6],
    ...extra,
  });
const apply = (runId: string, extra: { confirm?: string; perms?: Set<string> | null } = {}) =>
  applyTransferPlan({
    organizationId: orgId,
    runId,
    confirm: extra.confirm ?? null,
    operatorPermissions: extra.perms === undefined ? OWNER : extra.perms,
    operatorUserId: owner.user.userId,
  });
const flat2 = (b: { id: string }, productId: string) =>
  createPrice({
    ...ids(b),
    productId,
    id: "kept-usd-m",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
const view = async (id: string) => (await getTransferRun(orgId, id))!;
const itemMap = async (id: string) =>
  new Map((await view(id)).items.map((i) => [`${i.pair}:${i.key}`, i]));
const rowsIn = async <T>(table: unknown, bizId: string): Promise<T[]> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(table as any)
      .where(eq((table as any).businessId, bizId)),
  )) as T[];
const bizRow = async (id: string) =>
  (await withTenant(orgId, (tx) => tx.select().from(businesses).where(eq(businesses.id, id))))[0]!;
const jobCount = async (runId: string) =>
  (
    (await systemDb.execute(
      sql`select count(*)::int as n from graphile_worker._private_jobs where key = ${`transfer_run:${runId}`}`,
    )) as unknown as Array<{ n: number }>
  )[0]!.n;
const setRun = (id: string, set: Partial<typeof transferConfigurations.$inferInsert>) =>
  withTenant(orgId, (tx) =>
    tx.update(transferConfigurations).set(set).where(eq(transferConfigurations.id, id)),
  );
const audits = (runId: string) =>
  withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.resourceId, runId)));
/** Destination row counts equal the source's: nothing missing, nothing doubled. */
const sameCounts = async (destId: string) => {
  const out: Record<string, [number, number]> = {};
  for (const [name, t] of Object.entries({
    productGroups,
    products,
    prices,
    meters,
    creditUnits,
    coupons,
    couponItemConstraints,
    attachedItems,
    differentialPrices,
  }))
    out[name] = [(await rowsIn(t, srcT.id)).length, (await rowsIn(t, destId)).length];
  return out;
};
const countsMatch = (c: Record<string, [number, number]>) =>
  Object.values(c).every(([s, d]) => s === d);

// HTTP
const app = await buildApp({ logger: false });
const sessionAs = async (role: "admin" | "manager" | "ops"): Promise<string> => {
  const invited = await inviteUser({ organizationId: orgId, email: em(role), role });
  const tok = `invt_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: invited.userId,
    tokenHash: createHash("sha256").update(tok).digest("hex"),
    purpose: "invite",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await acceptInvite(tok, PW)).token;
};
type Auth = { cookie?: string; bearer?: string };
const authHeaders = (a: Auth) =>
  a.cookie ? { cookie: `tmb_session=${a.cookie}` } : { authorization: `Bearer ${a.bearer}` };
const base = `/v1/businesses/${srcT.publicId}/transfer_configurations`;
const post = (path: string, auth: Auth, payload: object) =>
  app.inject({
    method: "POST",
    url: `${base}${path}`,
    headers: { ...authHeaders(auth), "idempotency-key": randomBytes(8).toString("hex") },
    payload,
  });
const get = (path: string, auth: Auth) =>
  app.inject({ method: "GET", url: `${base}${path}`, headers: authHeaders(auth) });
const OWNER_C = { cookie: owner.token };
const KEY = { bearer: owner.dashboardKeySecret };

// ── a: a stored plan reads back the same; a newer plan supersedes ───────────────
{
  const dA = await newTest("Copy A");
  const id1 = await plan(dA);
  const v1 = await view(id1);
  const v2 = await view(id1);
  const shape = (v: typeof v1) =>
    v.items.map((i) => [i.pair, i.key, i.action, i.fingerprint, i.seq]);
  ok(
    "a: the plan is stored with its items",
    v1.run.status === "planned" && v1.items.length > 10,
    v1.items.length,
  );
  ok(
    "a: two reads give the same items, actions and fingerprints",
    JSON.stringify(shape(v1)) === JSON.stringify(shape(v2)),
  );
  const kinds = new Set(v1.items.map((i) => i.kind));
  ok(
    "a: every kind is planned",
    [
      "meter",
      "credit_unit",
      "tax_profile",
      "product_group",
      "product",
      "price",
      "attached_item",
      "differential_price",
      "coupon",
      "coupon_constraint",
      "field",
    ].every((k) => kinds.has(k)),
    [...kinds],
  );
  const id2 = await plan(dA);
  ok(
    "a: a second plan for the pair supersedes the first",
    (await view(id1)).run.status === "superseded" && (await view(id2)).run.status === "planned",
  );
  ok(
    "a: a superseded plan cannot be applied",
    (await err(apply(id1))) instanceof TransferConflictError,
  );
  const res = await get(`/${id2}`, OWNER_C);
  const body = res.json();
  ok(
    "a: HTTP GET returns the run with its items",
    res.statusCode === 200 &&
      body.run_kind === "async" &&
      body.status === "planned" &&
      body.items?.length === v1.items.length,
    { status: res.statusCode, items: body.items?.length },
  );
  ok(
    "a: each item carries its key, action and status",
    body.items?.every(
      (i: { key: string; action: string; status: string }) =>
        /^main:/.test(i.key) && i.action && i.status === "pending",
    ),
  );
}

// ── b: a blocking item stops the apply ─────────────────────────────────────────
{
  const dB = await newTest("Copy B");
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ currencies: ["USD"] })
      .where(eq(businesses.id, dB.id)),
  );
  const id = await plan(dB);
  const m = await itemMap(id);
  const eur = m.get("main:price:starter-eur-m")!;
  ok(
    "b: a price in a currency the destination does not bill in is blocked",
    eur.action === "blocked" && JSON.stringify(eur.messages).includes("does not bill in EUR"),
    eur.messages,
  );
  ok(
    "b: the run's validation lists the errors",
    ((await view(id)).run.validation as { errors: unknown[] }).errors.length >= 2,
  );
  ok("b: the apply is refused", (await err(apply(id))) instanceof TransferError);
  ok(
    "b: a refused apply queues nothing",
    (await view(id)).run.status === "planned" && (await jobCount(id)) === 0,
  );

  await setItemExclusions(orgId, id, { exclude: ["main:product:starter"] });
  const v = await view(id);
  const usd = v.effective.get("main:price:starter-usd-m")!;
  ok(
    "b: leaving out a product the destination lacks blocks its prices",
    usd.blocked && JSON.stringify(usd.messages).includes("left out"),
    usd.messages,
  );
  const lean = (await get(`/${id}?items=none`, OWNER_C)).json();
  const blockedPage = (await get(`/${id}/items?result=blocked&limit=500`, OWNER_C)).json();
  const newPage = (await get(`/${id}/items?result=new&limit=500`, OWNER_C)).json();
  const pinnedKeys = (lean.summary.blocked as Array<{ key: string }>).map((b) => b.key).sort();
  const listed = (blockedPage.data as Array<{ key: string; blocked: boolean }>).map((i) => i.key);
  ok(
    "b: a dependency block is listed under result=blocked and in the summary, not under new",
    listed.includes("main:price:starter-usd-m") &&
      JSON.stringify([...listed].sort()) === JSON.stringify(pinnedKeys) &&
      lean.summary.results.blocked === listed.length &&
      !(newPage.data as Array<{ key: string }>).some((i) => i.key === "main:price:starter-usd-m"),
    { listed, pinnedKeys },
  );
  await setItemExclusions(orgId, id, {
    include: ["main:product:starter"],
    exclude: ["main:price:starter-eur-m", "main:price:growth-eur-m"],
  });
  ok(
    "b: with the blocked items left out there are no errors",
    ((await view(id)).run.validation as { errors: unknown[] }).errors.length === 0,
  );
  ok(
    "b: an unknown item key is refused",
    (await err(setItemExclusions(orgId, id, { exclude: ["main:price:nope"] }))) instanceof
      TransferError,
  );
  const applied = await err(apply(id));
  ok(
    "b: the apply passes",
    applied === null && (await view(id)).run.status === "queued",
    String(applied),
  );
  ok(
    "b: changing a queued plan is refused",
    (await err(setItemExclusions(orgId, id, { include: ["main:price:growth-eur-m"] }))) instanceof
      TransferConflictError,
  );
  await runTransferJob(id);
  const after = await itemMap(id);
  ok(
    "b: the left-out items are skipped, not copied",
    after.get("main:price:starter-eur-m")?.skipReason === "excluded" &&
      !(await rowsIn<{ publicId: string }>(prices, dB.id)).some(
        (p) => p.publicId === "starter-eur-m",
      ),
  );
}

// ── c: drift between plan and apply ────────────────────────────────────────────
{
  const dC = await newTest("Copy C");
  const id = await plan(dC);
  const bump = (amount: bigint) =>
    withTenant(orgId, (tx) =>
      tx
        .update(prices)
        .set({ amountMinor: amount })
        .where(and(eq(prices.businessId, srcT.id), eq(prices.publicId, "starter-usd-m"))),
    );
  await bump(2100n);
  const e = await err(apply(id));
  ok(
    "c: a source change after the plan refuses the apply (drift)",
    e instanceof TransferDriftError && /changed after the check/.test((e as Error).message),
    String(e),
  );
  ok("c: the drifted plan is not queued", (await view(id)).run.status === "planned");
  const created = await post("/plans", OWNER_C, {
    destination_business: dC.publicId,
    sections: ["catalog", "tax_rates"],
  });
  const hid = created.json().id;
  ok(
    "c: HTTP plan answers 201",
    created.statusCode === 201 && typeof hid === "string",
    created.statusCode,
  );
  await bump(1900n);
  const res = await post(`/${hid}/apply`, OWNER_C, {});
  ok("c: HTTP apply after a change answers 409", res.statusCode === 409, {
    status: res.statusCode,
    body: res.json(),
  });
  ok(
    "c: the 409 carries the code transfer_drift and the drift text",
    res.json().error?.code === "transfer_drift" &&
      /^The set-up changed after the check/.test(res.json().error?.message ?? ""),
    res.json(),
  );
}

// ── d + j: an async run completes; secrets stay behind ─────────────────────────
const dD = await newTest("Copy D");
{
  const id = await plan(dD);
  const planned = await view(id);
  const smtpItem = planned.items.find((i) => i.key === "email_sending.smtp_config");
  ok(
    "j: the plan warns that the SMTP password is not copied",
    !!smtpItem &&
      JSON.stringify(smtpItem.messages).includes("Secrets are not copied") &&
      ((planned.run.validation as { warnings: unknown[] }).warnings.length ?? 0) > 0,
    smtpItem?.messages,
  );
  await apply(id);
  const q = await view(id);
  ok("d: apply queues the run", q.run.status === "queued" && !!q.run.queuedAt);
  ok("d: a graphile job keyed transfer_run:<id> exists", (await jobCount(id)) === 1);
  const toWrite = q.items.filter((i) =>
    writes({ action: i.action as never, excluded: i.excluded }),
  ).length;
  const r = await runTransferJob(id);
  const done = await view(id);
  const c = done.run.counts as { done: number; failed: number; total: number };
  ok("d: the run succeeds", r === "succeeded" && done.run.status === "succeeded", {
    r,
    error: done.run.error,
  });
  ok("d: the counts match the items", c.done === toWrite && c.failed === 0 && c.total === toWrite, {
    c,
    toWrite,
  });
  ok("d: a finished run is not leased again", (await runTransferJob(id)) === "busy_or_done");
  const mails = sent.filter((m) => m.subject === "The copy to Copy D is complete");
  ok(
    "d: the member who applied gets one email",
    mails.length === 1 && mails[0]!.to === em("owner"),
    sent,
  );
  const counts = await sameCounts(dD.id);
  ok("d: the destination has every catalog row", countsMatch(counts), counts);

  const [dm] = await rowsIn<{ id: string; key: string }>(meters, dD.id);
  const dPrices = await rowsIn<{
    publicId: string;
    meterId: string | null;
    productId: string;
    grantsCredit: unknown;
  }>(prices, dD.id);
  const dProducts = await rowsIn<{
    id: string;
    publicId: string;
    taxProfileId: string | null;
    productGroupId: string | null;
  }>(products, dD.id);
  const pid = (p: string) => dProducts.find((x) => x.publicId === p)?.id;
  const usage = dPrices.find((p) => p.publicId === "api-usage");
  ok(
    "d: the meter price uses the destination meter",
    !!dm && usage?.meterId === dm.id && usage.meterId !== meter.id,
  );
  ok(
    "d: prices point at destination products",
    dPrices.every((p) => dProducts.some((x) => x.id === p.productId)),
  );
  const dProfiles = await rowsIn<{ id: string; name: string }>(taxProfiles, dD.id);
  const dReduced = dProfiles.find((p) => p.name === "Reduced");
  const dGrowth = dProducts.find((p) => p.publicId === "growth");
  ok(
    "d: the product's tax profile is the destination's",
    !!dReduced && dGrowth?.taxProfileId === dReduced.id && dReduced.id !== reduced.id,
  );
  const dGroups = await rowsIn<{ id: string; publicId: string }>(productGroups, dD.id);
  ok(
    "d: products sit in destination groups",
    dGrowth?.productGroupId === dGroups.find((g) => g.publicId === "core")?.id,
  );
  const [att] = await rowsIn<{ itemProductId: string; planProductId: string }>(
    attachedItems,
    dD.id,
  );
  ok(
    "d: the attached item links destination products",
    att?.itemProductId === pid("seats") && att?.planProductId === pid("growth"),
  );
  const dd = await rowsIn<{
    currency: string;
    addonProductId: string;
    planProductId: string;
    amountMinor: bigint;
  }>(differentialPrices, dD.id);
  ok(
    "d: both differential prices are copied, one per currency",
    dd
      .map((x) => `${x.currency}:${x.amountMinor}`)
      .sort()
      .join() === "EUR:350,USD:400" &&
      dd.every((x) => x.addonProductId === pid("seats") && x.planProductId === pid("growth")),
    dd.map((x) => `${x.currency}:${x.amountMinor}`),
  );
  const [dc] = await rowsIn<{ id: string; timesRedeemed: number }>(coupons, dD.id);
  const [dcon] = await rowsIn<{ couponId: string }>(couponItemConstraints, dD.id);
  ok("d: the coupon starts with no redemptions", dc?.timesRedeemed === 0);
  ok("d: the coupon rule points at the destination coupon", dcon?.couponId === dc?.id);
  ok(
    "d: the credit pack keeps its unit, which the destination has",
    (dPrices.find((p) => p.publicId === "token-pack-usd")?.grantsCredit as { unit?: string })
      ?.unit === "token" &&
      (await rowsIn<{ key: string }>(creditUnits, dD.id)).some((u) => u.key === "token"),
  );
  ok("d: settings are copied", (await bizRow(dD.id)).defaultDueDays === 14);

  const D = await bizRow(dD.id);
  ok("j: the test destination has no SMTP password", D.smtpCredentialsEnc === null);
  ok(
    "j: the SMTP server is copied switched off",
    (D.smtpConfig as { host?: string; enabled?: boolean } | null)?.host === "smtp.src.example" &&
      (D.smtpConfig as { enabled?: boolean }).enabled === false,
    D.smtpConfig,
  );
  const stored = JSON.stringify(done.items);
  ok(
    "j: no item carries the secret or its envelope",
    !stored.includes(SECRET) && !stored.includes(srcEnc),
  );
  const httpJson = (await get(`/${id}`, OWNER_C)).body;
  ok(
    "j: the HTTP payload carries no secret or envelope",
    !httpJson.includes(SECRET) && !httpJson.includes(srcEnc),
  );

  const again = await plan(dD);
  const left = (await view(again)).items.filter((i) =>
    writes({ action: i.action as never, excluded: i.excluded }),
  );
  ok(
    "d: a new plan after the run has nothing to write",
    left.length === 0,
    left.map((i) => `${i.key}:${i.action}:${JSON.stringify(i.diff)}`),
  );
  await cancelTransferRun(orgId, again);

  // l: apply + finish audit rows
  const a = await audits(id);
  ok(
    "l: apply writes transfer.apply",
    a.some((x) => x.action === "transfer.apply"),
  );
  ok(
    "l: the finish writes transfer.run",
    a.some((x) => x.action === "transfer.run"),
  );
}

// ── e: a killed runner resumes ─────────────────────────────────────────────────
{
  const dE = await newTest("Copy E");
  const id = await plan(dE);
  await apply(id);
  const crash = await err(
    runTransferJob(id, {
      afterWrite: (i) => {
        if (i === 4) throw new SimulatedCrash("killed");
      },
    }),
  );
  const mid = await view(id);
  const running = mid.items.filter((i) => i.status === "running");
  ok("e: the crash stops the runner", crash instanceof SimulatedCrash);
  ok(
    "e: the run stays running with 4 items done and 1 running",
    mid.run.status === "running" &&
      mid.items.filter((i) => i.status === "done").length === 4 &&
      running.length === 1,
    { status: mid.run.status, running: running.length },
  );
  ok("e: a fresh lease keeps a second runner out", (await runTransferJob(id)) === "busy_or_done");
  await setRun(id, { heartbeatAt: new Date(Date.now() - 120_000) });
  const r = await runTransferJob(id);
  const end = await view(id);
  ok("e: the next runner finishes the run", r === "succeeded" && end.run.status === "succeeded", {
    r,
    error: end.run.error,
  });
  const counts = await sameCounts(dE.id);
  ok("e: no destination row is doubled or missing", countsMatch(counts), counts);
  const queuedItems = end.items.filter((i) =>
    writes({ action: i.action as never, excluded: i.excluded }),
  );
  ok(
    "e: every item is done",
    queuedItems.every((i) => i.status === "done"),
  );
  ok(
    "e: only the crashed item ran twice",
    queuedItems
      .filter((i) => i.attempts === 2)
      .map((i) => i.id)
      .join() === running.map((i) => i.id).join() &&
      queuedItems.filter((i) => i.attempts === 1).length === queuedItems.length - 1,
  );
  ok("e: the lease was taken twice", end.run.leaseCount === 2, end.run.leaseCount);
}

// ── f: retry runs only what failed ─────────────────────────────────────────────
{
  const dF = await newTest("Copy F");
  const g = await createProductGroup({ ...ids(dF), name: "Extras", id: "extras" });
  const id = await plan(dF);
  const gItem = (await itemMap(id)).get("main:product_group:extras")!;
  if (writes({ action: gItem.action as never, excluded: false }))
    await setItemExclusions(orgId, id, { exclude: ["main:product_group:extras"] });
  await apply(id);
  // The destination loses the group after the apply: the products in it cannot be created.
  await withTenant(orgId, (tx) => tx.delete(productGroups).where(eq(productGroups.id, g.id)));
  await runTransferJob(id);
  const first = await itemMap(id);
  const st = (k: string) => first.get(`main:${k}`);
  ok(
    "f: the run is partially failed",
    (await view(id)).run.status === "partially_failed",
    (await view(id)).run.status,
  );
  ok(
    "f: the run error counts the failed items",
    (await view(id)).run.error === "3 items failed.",
    (await view(id)).run.error,
  );
  ok(
    "f: the products in the missing group fail",
    ["seats", "setup", "token-pack"].every((p) => st(`product:${p}`)?.status === "failed") &&
      /product group extras/.test(st("product:seats")?.error ?? ""),
    st("product:seats")?.error,
  );
  ok(
    "f: their prices and the attached item are skipped for the dependency",
    ["price:seats-usd-m", "price:setup-usd", "price:token-pack-usd", "attached:seats@growth"].every(
      (k) => st(k)?.status === "skipped" && st(k)?.skipReason === "dependency",
    ),
  );
  ok(
    "f: the rest is done",
    st("product:growth")?.status === "done" && st("coupon:WELCOME20")?.status === "done",
  );
  await createProductGroup({ ...ids(dF), name: "Extras", id: "extras" });
  const before = new Map([...first].map(([k, v]) => [k, v.attempts]));
  await retryTransferRun({ organizationId: orgId, runId: id, operatorPermissions: OWNER });
  ok(
    "f: retry queues the run again",
    (await view(id)).run.status === "queued" && (await jobCount(id)) === 1,
  );
  const r = await runTransferJob(id);
  const second = await itemMap(id);
  ok("f: the retry succeeds", r === "succeeded", { r, error: (await view(id)).run.error });
  const doneBefore = [...first].filter(([, v]) => v.status === "done").map(([k]) => k);
  ok(
    "f: items done before did not run again",
    doneBefore.every((k) => second.get(k)!.attempts === before.get(k)),
  );
  ok(
    "f: failed items ran again and held-back items ran once",
    second.get("main:product:seats")?.attempts === 2 &&
      second.get("main:price:seats-usd-m")?.attempts === 1 &&
      [...second.values()].every((i) => i.status !== "failed" && i.skipReason !== "dependency"),
  );
  const counts = await sameCounts(dF.id);
  ok("f: the destination is complete with no duplicates", countsMatch(counts), counts);
  ok(
    "l: retry writes transfer.retry",
    (await audits(id)).some((x) => x.action === "transfer.retry"),
  );
  ok(
    "f: a succeeded run cannot be retried",
    (await err(
      retryTransferRun({ organizationId: orgId, runId: id, operatorPermissions: OWNER }),
    )) instanceof TransferConflictError,
  );
}

// ── g: cancel ──────────────────────────────────────────────────────────────────
{
  const dG = await newTest("Copy G");
  const id = await plan(dG);
  await apply(id);
  await cancelTransferRun(orgId, id);
  const v = await view(id);
  ok(
    "g: a queued run is cancelled at once",
    v.run.status === "cancelled" && v.items.every((i) => i.status === "skipped"),
  );
  ok(
    "g: the runner does nothing for a cancelled run",
    (await runTransferJob(id)) === "busy_or_done" && (await rowsIn(products, dG.id)).length === 0,
  );
  ok(
    "l: cancel writes transfer.cancel",
    (await audits(id)).some((x) => x.action === "transfer.cancel"),
  );
  ok(
    "g: an ended run cannot be cancelled",
    (await err(cancelTransferRun(orgId, id))) instanceof TransferConflictError,
  );

  const id2 = await plan(dG);
  await apply(id2);
  const r = await runTransferJob(id2, {
    afterWrite: async (i) => {
      if (i === 2) await cancelTransferRun(orgId, id2);
    },
  });
  const v2 = await view(id2);
  const c = v2.run.counts as { done: number; skipped: number };
  ok(
    "g: a running run stops after the current item",
    r === "cancelled" && v2.run.status === "cancelled" && c.done === 3,
    { r, c },
  );
  ok(
    "g: the items not reached are skipped as cancelled",
    v2.items.filter((i) => i.skipReason === "cancelled").length > 0 &&
      !v2.items.some((i) => i.status === "pending" || i.status === "running"),
  );
}

// ── h: one active run per destination ──────────────────────────────────────────
{
  const dH = await newTest("Copy H");
  const id1 = await plan(dH, { sections: ["catalog", "tax_rates"] });
  await apply(id1);
  const res = await post("/plans", OWNER_C, {
    destination_business: dH.publicId,
    sections: ["settings"],
  });
  const res2 = await post(`/${res.json().id}/apply`, OWNER_C, {});
  ok("h: over HTTP a second apply answers 409", res2.statusCode === 409, res2.statusCode);
  const id2 = await plan(dH, { sections: ["coupons"] });
  ok(
    "h: a second apply into a busy destination is refused",
    (await err(apply(id2))) instanceof TransferConflictError,
  );
  ok(
    "h: the database allows one active async run per destination",
    (await err(setRun(id2, { status: "queued" }))) !== null,
  );
  await cancelTransferRun(orgId, id1);
  ok("h: after the first run ends the second applies", (await err(apply(id2))) === null);
  await runTransferJob(id2);
}

// ── i + k: a live destination ──────────────────────────────────────────────────
{
  const manager = await sessionAs("manager");
  const admin = await sessionAs("admin");
  const body = {
    destination_business: live.publicId,
    sections: ["catalog", "coupons", "tax_rates", "settings"],
  };
  const mgr = await post("/plans", { cookie: manager }, body);
  ok(
    "k: a role without transfers:manage cannot plan (403)",
    mgr.statusCode === 403,
    mgr.statusCode,
  );

  // Add-only into live: a key may apply it.
  const p0 = await post("/plans", KEY, body);
  const p0Id = p0.json().id as string;
  ok(
    "k: a key plans into live (201)",
    p0.statusCode === 201 && p0.json().live_override_needed === false,
    p0.statusCode,
  );
  const gw = (
    p0.json().items as Array<{ key: string; messages: Array<{ message: string }> }>
  ).filter((i) => i.messages.some((m) => m.message.startsWith("No connected payment gateway")));
  const gwText = gw.map(
    (i) => i.messages.find((m) => m.message.startsWith("No connected"))!.message,
  );
  ok(
    "i: the gateway warning shows once per currency",
    gw.length === 2 &&
      gwText.some((t) => t.includes("USD")) &&
      gwText.some((t) => t.includes("EUR")),
    gw.map((i) => i.key),
  );
  const a0 = await post(`/${p0Id}/apply`, KEY, {});
  ok(
    "k: a key applies an add-only plan into live (202)",
    a0.statusCode === 202 && a0.json().status === "queued",
    { s: a0.statusCode, b: a0.json() },
  );
  ok("k: the add-only live run succeeds", (await runTransferJob(p0Id)) === "succeeded");
  ok(
    "l: an add-only live run audits as transfer.run",
    (await audits(p0Id)).some((x) => x.action === "transfer.run"),
  );

  // A live subscription on starter-usd-m.
  const livePrices = await rowsIn<{
    id: string;
    publicId: string;
    amountMinor: bigint;
    name: string | null;
  }>(prices, live.id);
  const lp = livePrices.find((p) => p.publicId === "starter-usd-m")!;
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: live.id,
    email: em("buyer"),
  });
  await withTenant(orgId, async (tx) => {
    const [sub] = await tx
      .insert(subscriptions)
      .values({
        ...ids(live),
        customerId: cust.id,
        publicId: publicId("sub"),
        status: "active",
        currency: "USD",
      })
      .returning();
    await tx
      .insert(subscriptionItems)
      .values({ ...ids(live), subscriptionId: sub!.id, publicId: publicId("si"), priceId: lp.id });
  });
  const srcPrice = (set: Partial<typeof prices.$inferInsert>) =>
    withTenant(orgId, (tx) =>
      tx
        .update(prices)
        .set(set)
        .where(and(eq(prices.businessId, srcT.id), eq(prices.publicId, "starter-usd-m"))),
    );
  const upd = { sections: ["catalog" as const], conflictPolicy: { catalog: "update" as const } };
  const livePlan = (extra: Partial<PlanInput>) =>
    createTransferPlan({
      organizationId: orgId,
      sourceBusinessId: srcT.id,
      destinationBusinessId: live.id,
      ...extra,
    });

  await srcPrice({ amountMinor: 2500n });
  const bill = await livePlan(upd);
  const bi = (await itemMap(bill)).get("main:price:starter-usd-m")!;
  ok(
    "i: an amount change on a price live subscriptions use is blocked",
    bi.action === "blocked" && JSON.stringify(bi.messages).includes("live subscription"),
    { action: bi.action, messages: bi.messages },
  );
  ok(
    "i: the apply is refused",
    (await err(apply(bill, { confirm: "Studio" }))) instanceof TransferError,
  );

  await srcPrice({ amountMinor: 1900n, name: "Starter monthly" });
  const nameOnly = await livePlan(upd);
  const ni = (await itemMap(nameOnly)).get("main:price:starter-usd-m")!;
  ok(
    "i: a name-only change is allowed",
    ni.action === "update" && !(ni.messages as unknown[]).length,
    { action: ni.action, diff: ni.diff },
  );
  const nv = await view(nameOnly);
  ok("k: the plan needs the live override", nv.liveOverrideNeeded === true);
  const byKey = await post(`/${nameOnly}/apply`, KEY, { confirm: "Studio" });
  ok("k: a key cannot apply an update into live (403)", byKey.statusCode === 403, byKey.statusCode);
  ok(
    "k: a member without transfers:live_override is refused",
    (await err(
      apply(nameOnly, { confirm: "Studio", perms: new Set(["transfers:manage"]) }),
    )) instanceof TransferForbiddenError,
  );
  const wrong = await post(`/${nameOnly}/apply`, { cookie: admin }, { confirm: "studio" });
  ok("k: a wrong confirmation answers 400", wrong.statusCode === 400, wrong.statusCode);
  const good = await post(`/${nameOnly}/apply`, { cookie: admin }, { confirm: "Studio" });
  ok("k: an admin applies it with the exact name (202)", good.statusCode === 202, {
    s: good.statusCode,
    b: good.json(),
  });
  ok("i: the run succeeds", (await runTransferJob(nameOnly)) === "succeeded");
  const after = (
    await rowsIn<{ publicId: string; amountMinor: bigint; name: string | null }>(prices, live.id)
  ).find((p) => p.publicId === "starter-usd-m")!;
  ok(
    "i: the live price took the name and kept its amount",
    after.name === "Starter monthly" && after.amountMinor === 1900n,
    { name: after.name, amount: String(after.amountMinor) },
  );
  ok(
    "l: a live update audits as transfer.live_override",
    (await audits(nameOnly)).some((x) => x.action === "transfer.live_override"),
  );

  // j on live: the copy is refused until the destination has its own password.
  const mail = {
    sections: ["email_sending" as const],
    conflictPolicy: { email_sending: "update" as const },
  };
  const m1 = await livePlan(mail);
  const smtp1 = (await itemMap(m1)).get("main:email_sending.smtp_config");
  ok(
    "j: a live destination with no SMTP password blocks the copy",
    smtp1?.action === "blocked" &&
      JSON.stringify(smtp1.messages).includes("Secrets are not copied"),
    smtp1?.messages,
  );
  const refused = await err(apply(m1, { confirm: "Studio" }));
  ok(
    "j: the live apply is refused with the credential message",
    refused instanceof TransferError && /SMTP password/.test((refused as Error).message),
    String(refused),
  );
  const LIVE_SECRET = "live-own-pass-5d1";
  await saveSmtpSettings(orgId, live.id, {
    enabled: true,
    host: "smtp.live.example",
    port: 587,
    encryption: "starttls",
    username: "live",
    password: LIVE_SECRET,
  });
  const liveEnc = (await bizRow(live.id)).smtpCredentialsEnc;

  // A retry of live updates needs the destination's name too.
  await srcPrice({ name: "Starter per month" });
  const rp = await livePlan(upd);
  await apply(rp, { confirm: "Studio" });
  await runTransferJob(rp, {
    afterWrite: (_i, item) => {
      if (item.key === "price:starter-usd-m") throw new Error("price write refused");
    },
  });
  ok(
    "k: fixture: the live update failed",
    (await view(rp)).run.status === "failed",
    (await view(rp)).run.status,
  );
  const noName = await err(
    retryTransferRun({ organizationId: orgId, runId: rp, operatorPermissions: OWNER }),
  );
  ok(
    "k: a retry of live updates without the name is refused",
    noName instanceof TransferError && /confirmation/.test((noName as Error).message),
    String(noName),
  );
  await retryTransferRun({
    organizationId: orgId,
    runId: rp,
    confirm: "Studio",
    operatorPermissions: OWNER,
  });
  ok("k: with the name the retry runs", (await runTransferJob(rp)) === "succeeded");
  const m2 = await livePlan(mail);
  ok(
    "j: with its own password the live copy is not blocked",
    (await view(m2)).items.every((i) => i.action !== "blocked"),
  );
  await apply(m2, { confirm: "Studio" });
  const rm = await runTransferJob(m2);
  const L = await bizRow(live.id);
  ok(
    "j: the live destination keeps its own password",
    rm === "succeeded" &&
      L.smtpCredentialsEnc === liveEnc &&
      readSmtpPassword(L.smtpCredentialsEnc) === LIVE_SECRET,
  );
  ok(
    "j: the SMTP server settings are copied",
    (L.smtpConfig as { host?: string }).host === "smtp.src.example",
  );
  const auditJson = JSON.stringify(await audits(m2));
  ok(
    "j: the audit rows carry no secret or envelope",
    !auditJson.includes(SECRET) && !auditJson.includes(srcEnc) && !auditJson.includes(liveEnc!),
  );
}

// ── m: the clock pass ──────────────────────────────────────────────────────────
{
  const dM = await newTest("Copy M");
  const id = await plan(dM, { sections: ["coupons"] });
  await apply(id);
  await systemDb.execute(
    sql`delete from graphile_worker._private_jobs where key = ${`transfer_run:${id}`}`,
  );
  ok("m: fixture: the job is gone", (await jobCount(id)) === 0);
  ok(
    "m: a fresh queued run is not queued again",
    (await requeueStalledRuns(new Date())) === 0 && (await jobCount(id)) === 0,
  );
  await setRun(id, { queuedAt: new Date(Date.now() - 5 * 60_000) });
  const n = await requeueStalledRuns(new Date());
  ok("m: a stalled run is queued again", n >= 1 && (await jobCount(id)) === 1, n);
  const reap = await reapStuckTransfers(new Date());
  ok(
    "m: reapStuckTransfers returns reaped and requeued",
    typeof reap.reaped === "number" && reap.requeued >= 1,
    reap,
  );
  ok("m: the job stays single", (await jobCount(id)) === 1);
  ok("m: the requeued run completes", (await runTransferJob(id)) === "succeeded");
}

// ── n: Billy reads the status through its route ────────────────────────────────
{
  const dN = await newTest("Copy N");
  const open = await plan(dN, { sections: ["coupons"] });
  const tool = TOOLS.find((t) => t.name === "get_transfer_status");
  ok("n: the tool is in the catalogue", !!tool);
  if (tool) {
    const ctx = {
      business: {
        id: srcT.publicId,
        name: srcT.name,
        livemode: "test" as const,
        currency: "USD",
        timezone: null,
      },
      get: (rel: string, query?: Record<string, string | number | boolean | undefined>) =>
        callRoute(
          app,
          { cookie: `tmb_session=${owner.token}`, "user-agent": "verify-transfer-async" },
          {
            method: "GET",
            path: `/v1/businesses/${srcT.publicId}/${rel}`,
            query,
          },
        ),
      post: async () => ({ status: 405, body: null }),
    };
    const out = (await tool.run(ctx, {})) as {
      open: { data: Array<{ id: string }> };
      past: { data: Array<{ id: string; status: string }> };
    };
    ok("n: it shows the open plan", out.open.data[0]?.id === open, out.open);
    ok(
      "n: past copies are runs, not plans",
      out.past.data.length > 0 &&
        out.past.data.every((r) => r.status !== "planned" && r.status !== "superseded"),
    );
  }
}

// ── o: clear-first into a test destination ─────────────────────────────────────
{
  const dO = await newTest("Copy O");
  await createProduct({ ...ids(dO), name: "Old", id: "old-only", kind: "plan" });
  await createProductGroup({ ...ids(dO), name: "Core plans", id: "core" });
  const id = await plan(dO, {
    sections: ["catalog", "coupons", "tax_rates"],
    wipeDestination: true,
  });
  const v = await view(id);
  ok(
    "o: the plan clears first",
    v.run.wipeDestination && v.items[0]?.kind === "clear",
    v.items[0]?.key,
  );
  await apply(id);
  const r = await runTransferJob(id);
  const left = await rowsIn<{ publicId: string }>(products, dO.id);
  ok(
    "o: the clear-first run deletes and copies",
    r === "succeeded" &&
      !left.some((p) => p.publicId === "old-only") &&
      left.some((p) => p.publicId === "growth"),
    { r, error: (await view(id)).run.error },
  );
  // A clear-first keeps the destination's "default" group by design.
  const { productGroups: _g, ...counts } = await sameCounts(dO.id);
  const groups = (await rowsIn<{ publicId: string }>(productGroups, dO.id))
    .map((g) => g.publicId)
    .sort();
  ok(
    "o: the destination matches the source",
    countsMatch(counts) && groups.join() === "core,default,extras",
    { counts, groups },
  );
}

// ── p: test twins: the test pair goes first; its failure leaves live untouched ──
{
  const liveA = await createBusiness({
    organizationId: orgId,
    name: "Twin A",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const liveB = await createBusiness({
    organizationId: orgId,
    name: "Twin B",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const twinOf = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(businesses).where(eq(businesses.liveBusinessId, id)),
      )
    )[0]!;
  const tA = await twinOf(liveA.id);
  const tB = await twinOf(liveB.id);
  await createCoupon({
    ...ids(liveA),
    code: "LIVEONLY",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "once",
  });
  await createCoupon({
    ...ids(tA),
    code: "TESTONLY",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "once",
  });
  const id = await createTransferPlan({
    organizationId: orgId,
    sourceBusinessId: liveA.id,
    destinationBusinessId: liveB.id,
    sections: ["coupons"],
    includeTestTwins: true,
  });
  const v = await view(id);
  ok(
    "p: one plan covers both pairs, test first",
    v.items[0]?.pair === "twin" && v.items.some((i) => i.pair === "main") && !v.liveOverrideNeeded,
    v.items.map((i) => `${i.pair}:${i.key}`),
  );
  await apply(id);
  await runTransferJob(id, {
    afterWrite: (_i, item) => {
      if (item.pair === "twin") throw new Error("twin write refused");
    },
  });
  const f = await view(id);
  const main = f.items.find((i) => i.pair === "main")!;
  ok(
    "p: a failed twin item fails the run",
    f.run.status === "failed" && f.run.error === "1 item failed.",
    f.run.error,
  );
  const tItem = f.items.find((i) => i.pair === "twin")!;
  ok(
    "p: an unexpected error shows a neutral message, not its detail",
    tItem.error === "We could not copy this item. Try it again." &&
      !JSON.stringify(f).includes("twin write refused"),
    tItem.error,
  );
  ok(
    "p: the live pair is skipped and untouched",
    main.skipReason === "dependency" && (await rowsIn(coupons, liveB.id)).length === 0,
  );
  await retryTransferRun({ organizationId: orgId, runId: id, operatorPermissions: OWNER });
  ok("p: the retry succeeds", (await runTransferJob(id)) === "succeeded");
  const codes = async (b: string) =>
    (await rowsIn<{ code: string }>(coupons, b)).map((c) => c.code).join();
  ok(
    "p: each pair reads its own source",
    (await codes(tB.id)) === "TESTONLY" && (await codes(liveB.id)) === "LIVEONLY",
  );
}

// ── q: clear-first into a destination whose rows are in use ────────────────────
{
  const dQ = await newTest("Copy Q");
  const prod = await createProduct({ ...ids(dQ), name: "Kept", id: "kept", kind: "plan" });
  const price = await flat2(dQ, prod.id);
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: dQ.id,
    email: em("q-buyer"),
  });
  await withTenant(orgId, async (tx) => {
    const [sub] = await tx
      .insert(subscriptions)
      .values({
        ...ids(dQ),
        customerId: cust.id,
        publicId: publicId("sub"),
        status: "active",
        currency: "USD",
      })
      .returning();
    await tx
      .insert(subscriptionItems)
      .values({ ...ids(dQ), subscriptionId: sub!.id, publicId: publicId("si"), priceId: price.id });
  });
  const id = await plan(dQ, {
    sections: ["catalog", "coupons", "tax_rates"],
    wipeDestination: true,
  });
  const m = await itemMap(id);
  const clear = m.get("main:clear:catalog")!;
  ok(
    "q: a clear the destination's rows refuse is blocked at plan time",
    clear.action === "blocked" && JSON.stringify(clear.messages).includes("We cannot delete them"),
    { action: clear.action, messages: clear.messages },
  );
  ok("q: the other clears are not blocked", m.get("main:clear:coupons")?.action === "delete");
  ok(
    "q: every item of a cleared section waits for its clear",
    [...m.values()]
      .filter((i) => i.kind !== "clear")
      .every((i) => (i.dependsOn as string[]).includes(`clear:${i.section}`)),
  );
  const e = await err(apply(id));
  ok(
    "q: the apply is refused with the clear message",
    e instanceof TransferError && /We cannot delete them/.test((e as Error).message),
    String(e),
  );
  ok(
    "q: the probe deleted nothing",
    (await rowsIn(products, dQ.id)).length === 1 && (await rowsIn(prices, dQ.id)).length === 1,
  );
}

// ── r: the list filters and the numbering blocker ──────────────────────────────
{
  const out = await get(
    "?status=planned,queued,running,succeeded&run_kind=async&direction=outgoing&limit=100",
    OWNER_C,
  );
  const rows = out.json().data as Array<{ run_kind: string; source_business: string }>;
  ok(
    "r: run_kind=async&direction=outgoing lists only async runs from the business",
    out.statusCode === 200 &&
      rows.length > 0 &&
      rows.every((r) => r.run_kind === "async" && r.source_business === srcT.publicId),
    { s: out.statusCode, n: rows.length },
  );
  const inc = await app.inject({
    method: "GET",
    url: `/v1/businesses/${live.publicId}/transfer_configurations?direction=incoming&limit=100`,
    headers: authHeaders(OWNER_C),
  });
  const incRows = inc.json().data as Array<{ destination_business: string }>;
  ok(
    "r: direction=incoming lists runs into the business",
    incRows.length > 0 && incRows.every((r) => r.destination_business === live.publicId),
  );
  const outLive = await app.inject({
    method: "GET",
    url: `/v1/businesses/${live.publicId}/transfer_configurations?direction=outgoing&limit=100`,
    headers: authHeaders(OWNER_C),
  });
  ok(
    "r: direction=outgoing leaves them out",
    outLive.json().data.length === 0,
    outLive.json().data.length,
  );

  const dR = await newTest("Copy R");
  const prefix = "STU";
  await withTenant(orgId, (tx) =>
    tx.update(businesses).set({ invoicePrefix: prefix }).where(eq(businesses.id, srcT.id)),
  );
  const id = await plan(dR, { sections: ["settings"], numbering: { invoicePrefix: prefix } });
  const n = (await view(id)).items.find((i) => i.key === "numbering.invoice_prefix");
  ok(
    "r: the numbering blocker names the other business by its name",
    ((n?.messages as Array<{ message: string }> | undefined) ?? []).some(
      (m) =>
        m.message.includes(`by the business "${srcT.name}"`) && !m.message.includes(srcT.publicId),
    ),
    n?.messages,
  );
}

// ── paged items: GET …/:job?items=none and GET …/:job/items ─────────────────────
type WireItem = { key: string; label: string; action: string; section: string };
const getJson = async (url: string, auth: Auth = OWNER_C) => {
  const r = await app.inject({ method: "GET", url, headers: authHeaders(auth) });
  return { code: r.statusCode, body: r.json() };
};
/** Every page of a filtered list, following `next_cursor`. */
async function allItems(bizPid: string, runId: string, qs: string): Promise<WireItem[]> {
  const out: WireItem[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < 200; pages++) {
    const r = await getJson(
      `/v1/businesses/${bizPid}/transfer_configurations/${runId}/items?${qs}${after ? `&starting_after=${after}` : ""}`,
    );
    if (r.code !== 200) throw new Error(`items ${qs}: ${r.code} ${JSON.stringify(r.body)}`);
    out.push(...(r.body.data as WireItem[]));
    after = r.body.has_more ? r.body.next_cursor : null;
    if (!after) break;
  }
  return out;
}

async function pagedItemChecks(
  src: { publicId: string },
  runId: string,
  total: number,
  unchanged: number,
) {
  const runUrl = `/v1/businesses/${src.publicId}/transfer_configurations/${runId}`;
  const lean = await getJson(`${runUrl}?items=none`);
  const sum = lean.body.summary;
  ok(
    "s: items=none returns the run without items",
    lean.code === 200 && !("items" in lean.body),
    lean.code,
  );
  ok(
    "s: items=none counts every result",
    sum?.total === total &&
      sum.results.new === total - unchanged &&
      sum.results.unchanged === unchanged &&
      sum.results.blocked === 0 &&
      sum.results.left_out === 0 &&
      Array.isArray(sum.blocked) &&
      sum.blocked.length === 0,
    sum?.results,
  );
  const coupon = (sum?.sections ?? []).find((x: { section: string }) => x.section === "coupons");
  ok(
    "s: items=none counts per section",
    sum?.sections.length === 1 &&
      coupon?.pair === "main" &&
      coupon.results.new === total - unchanged &&
      coupon.results.unchanged === unchanged,
    sum?.sections,
  );
  const full = await getJson(runUrl);
  ok(
    "s: the default run view still carries every item",
    full.code === 200 && full.body.items?.length === total,
    full.body.items?.length,
  );

  // What the dashboard's server page hands the client: before, the run with every item;
  // now, the counts and the first page of changes.
  const firstChanges = await getJson(`${runUrl}/items?result=changes`);
  const before = JSON.stringify(full.body).length;
  const after = JSON.stringify({ run: lean.body, list: firstChanges.body }).length;
  console.log(`  · s: first-load props ${before} → ${after} bytes`);
  ok("s: the page's first load stays under 300 KB", after < 300_000, { before, after });

  const all = await allItems(src.publicId, runId, "limit=500");
  const stored = await withTenant(orgId, (tx) =>
    tx
      .select({ pair: transferItems.pair, key: transferItems.key })
      .from(transferItems)
      .where(eq(transferItems.transferId, runId))
      .orderBy(transferItems.seq),
  );
  const keys = all.map((i) => i.key);
  ok(
    "s: starting_after pages through every item once, in plan order",
    all.length === total &&
      new Set(keys).size === total &&
      keys.every((k, n) => k === `${stored[n]!.pair}:${stored[n]!.key}`),
    { got: all.length, unique: new Set(keys).size },
  );
  const first = await getJson(`${runUrl}/items`);
  ok(
    "s: the default page is 100 items with a cursor",
    first.code === 200 &&
      first.body.object === "list" &&
      first.body.data.length === 100 &&
      first.body.has_more === true &&
      typeof first.body.next_cursor === "string",
    { code: first.code, n: first.body.data?.length },
  );
  const sameShape = JSON.stringify(Object.keys(first.body.data[0] ?? {}).sort());
  ok(
    "s: a listed item has the run view's shape",
    sameShape === JSON.stringify(Object.keys(full.body.items?.[0] ?? {}).sort()) &&
      JSON.stringify(first.body.data[0]) === JSON.stringify(full.body.items?.[0]),
    sameShape,
  );
  const changes = await allItems(src.publicId, runId, "result=changes&limit=500");
  ok(
    "s: result=changes lists only the items that write (new, updated, deleted)",
    changes.length === total - unchanged &&
      changes.every((i) => ["create", "update", "delete"].includes(i.action)),
    changes.length,
  );
  const same = await allItems(src.publicId, runId, "result=unchanged&limit=500");
  ok(
    "s: result=unchanged lists only them",
    same.length === unchanged && same.every((i) => i.action === "unchanged"),
    same.length,
  );
  const hit = await allItems(src.publicId, runId, "q=bulk49&limit=500");
  const want = all.filter((i) => i.label.toLowerCase().includes("bulk49")).length;
  ok(
    "s: q matches the label in any case",
    want === 111 && hit.length === want && hit.every((i) => /bulk49/i.test(i.label)),
    { want, got: hit.length },
  );
  const pct = await allItems(src.publicId, runId, `q=${encodeURIComponent("%")}`);
  ok("s: q matches % literally", pct.length === 0, pct.length);
  const both = await allItems(src.publicId, runId, "q=BULK49&result=unchanged");
  ok("s: filters combine", both.length === 100, both.length);
  const inCoupons = await allItems(src.publicId, runId, "section=coupons&limit=500");
  const inCatalog = await allItems(src.publicId, runId, "section=catalog");
  ok("s: section filters", inCoupons.length === total && inCatalog.length === 0, {
    coupons: inCoupons.length,
    catalog: inCatalog.length,
  });
  const capped = await getJson(`${runUrl}/items?limit=501`);
  const badCursor = await getJson(`${runUrl}/items?starting_after=abc`);
  const badResult = await getJson(`${runUrl}/items?result=maybe`);
  ok(
    "s: limit above 500, a bad cursor and an unknown result are refused",
    capped.code === 400 && badCursor.code === 400 && badResult.code === 400,
    [capped.code, badCursor.code, badResult.code],
  );
  const testKey = (await createApiKey(orgId, "test")).secret;
  const restricted = await getJson(`${runUrl}/items`, { bearer: testKey });
  ok("s: a single-mode key cannot list items", restricted.code === 403, restricted.code);
  const other = await signup({
    email: em("other-org"),
    password: PW,
    organizationName: `Transfer Other ${uniq}`,
  });
  const otherBiz = await createBusiness({
    organizationId: other.user.organizationId,
    name: "Elsewhere",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const foreign = { cookie: other.token };
  const theirs = await getJson(
    `/v1/businesses/${otherBiz.publicId}/transfer_configurations/${runId}/items`,
    foreign,
  );
  const theirView = await getJson(
    `/v1/businesses/${otherBiz.publicId}/transfer_configurations/${runId}?items=none`,
    foreign,
  );
  const viaOurs = await getJson(`${runUrl}/items`, foreign);
  ok(
    "s: another organization's run is 404",
    theirs.code === 404 && theirView.code === 404 && viaOurs.code === 404,
    [theirs.code, theirView.code, viaOurs.code],
  );
}

// ── s: a plan with thousands of coupons ────────────────────────────────────────
// 5,000 items × 16 columns is past the 65,535-parameter cap of one statement.
{
  const N = 5000;
  const bigSrc = await newTest("Many coupons");
  const bigDest = await newTest("Many coupons copy");
  await withTenant(orgId, async (tx) => {
    for (let at = 0; at < N; at += 1000)
      await tx.insert(coupons).values(
        Array.from({ length: Math.min(1000, N - at) }, (_, k) => ({
          ...ids(bigSrc),
          code: `BULK${at + k}`,
          kind: "percentage",
          percentOffBps: 1000,
        })),
      );
  });
  // The last 100 already exist in the destination, the same: the plan shows them unchanged.
  const PRESET = 100;
  await withTenant(orgId, (tx) =>
    tx.insert(coupons).values(
      Array.from({ length: PRESET }, (_, k) => ({
        ...ids(bigDest),
        code: `BULK${N - PRESET + k}`,
        kind: "percentage",
        percentOffBps: 1000,
      })),
    ),
  );
  const runErr = await err(
    createTransferPlan({
      organizationId: orgId,
      sourceBusinessId: bigSrc.id,
      destinationBusinessId: bigDest.id,
      sections: ["coupons"],
    }),
  );
  ok("s: a plan of 5,000 coupons is stored", runErr === null, String(runErr));
  const [run] = await withTenant(orgId, (tx) =>
    tx
      .select({ id: transferConfigurations.id })
      .from(transferConfigurations)
      .where(
        and(
          eq(transferConfigurations.sourceBusinessId, bigSrc.id),
          eq(transferConfigurations.status, "planned"),
        ),
      ),
  );
  if (run) {
    const v = await view(run.id);
    ok("s: every coupon is an item", v.items.length === N, v.items.length);
    await pagedItemChecks(bigSrc, run.id, N, PRESET);
    // Keep 10: exclude and apply each update 4,990 rows by id; the runner copies only 10.
    const KEEP = 10;
    const leaveOut = Array.from({ length: N - KEEP }, (_, k) => `main:coupon:BULK${k + KEEP}`);
    await setItemExclusions(orgId, run.id, { exclude: leaveOut });
    const excluded = (await view(run.id)).items.filter((i) => i.excluded).length;
    ok("s: 4,990 items of 5,000 are left out", excluded === N - KEEP, excluded);
    const writes = await allItems(bigSrc.publicId, run.id, "result=changes&limit=500");
    ok(
      "s: result=changes leaves out the left-out items",
      writes.length === KEEP && writes.every((i) => i.action === "create"),
      writes.length,
    );
    await apply(run.id);
    const skipped = (await view(run.id)).items.filter((i) => i.status === "skipped").length;
    ok("s: apply skips every left-out item", skipped === N - KEEP, skipped);
    const outcome = await runTransferJob(run.id);
    const after = await withTenant(orgId, (tx) =>
      tx.select({ code: coupons.code }).from(coupons).where(eq(coupons.businessId, bigDest.id)),
    );
    const codes = after
      .map((c) => c.code)
      .filter((c) => Number(c.slice(4)) < N - PRESET)
      .sort();
    const want = Array.from({ length: KEEP }, (_, k) => `BULK${k}`).sort();
    ok("s: the run copies only the kept coupons", JSON.stringify(codes) === JSON.stringify(want), {
      outcome,
      codes,
    });
    const http = await app.inject({
      method: "GET",
      url: `/v1/businesses/${bigSrc.publicId}/transfer_configurations/${run.id}`,
      headers: authHeaders(OWNER_C),
    });
    ok("s: the run reads back over HTTP", http.statusCode === 200, http.statusCode);
    const done = await getJson(
      `/v1/businesses/${bigSrc.publicId}/transfer_configurations/${run.id}?items=none`,
    );
    const section = (
      done.body.summary.sections as Array<{
        progress: { total: number; done: number };
        applied: { new: number; updated: number; deleted: number };
      }>
    )[0];
    const progress = section?.progress;
    ok(
      "s: the summary counts what the copy wrote, by result",
      section?.applied.new === KEEP &&
        section.applied.updated === 0 &&
        section.applied.deleted === 0,
      section?.applied,
    );
    ok(
      "s: after the run, the summary counts the 10 queued items, all copied",
      progress?.total === KEEP &&
        progress.done === KEEP &&
        done.body.summary.results.left_out === N - KEEP,
      done.body.summary,
    );
    const queued = await allItems(bigSrc.publicId, run.id, "status=queued&limit=500");
    const failed = await allItems(bigSrc.publicId, run.id, "status=failed");
    ok(
      "s: status=queued lists only the queued items; status=failed none",
      queued.length === KEEP && failed.length === 0,
      { queued: queued.length, failed: failed.length },
    );
  }
}

// ── no item of any run in this organization carries an envelope ────────────────
{
  const all = JSON.stringify(
    await withTenant(orgId, (tx) =>
      tx
        .select({
          diff: transferItems.diff,
          messages: transferItems.messages,
          replaced: transferItems.replaced,
        })
        .from(transferItems)
        .where(inArray(transferItems.organizationId, [orgId])),
    ),
  );
  ok(
    "j: no stored item carries the source secret or envelope",
    !all.includes(SECRET) && !all.includes(srcEnc),
  );
}

await app.close();
let failed = 0;
for (const [label, passed, detail] of checks) {
  console.log(
    `${passed ? "  ✓" : "  ✗ FAIL"} ${label}${passed || !detail ? "" : `  — ${detail.slice(0, 600)}`}`,
  );
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? "✅ TRANSFER-ASYNC: PASS" : `❌ TRANSFER-ASYNC: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
