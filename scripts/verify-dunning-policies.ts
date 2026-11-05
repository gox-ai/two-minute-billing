/**
 * Named dunning policies (0386): resolution order (excluded > customer policy > business),
 * the policy minimum in the scan filter, a mid-dunning switch, archive rules, the API and
 * tenant isolation.
 *
 *   pnpm verify:dunning-policies
 */
import { and, eq, sql } from "drizzle-orm";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { buildApp } from "@/index";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer, updateCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, dunningNotHeldSql } from "@/modules/invoicing/service";
import { retryDueInvoice, runDunningPass } from "@/modules/subscriptions/dunning";
import { getDunningJourney } from "@/modules/invoicing/dunning-journey";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { createDunningPolicy } from "@/modules/dunning-policies/service";
import { runWithClockScope } from "@/platform/clock";
import { businesses, dunningPolicies, events, invoices, payments, subscriptions } from "@db/schema";

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok, detail]);
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const SHORT = {
  retries: [{ after_days: 1 }],
  final_action: { invoice: "void", subscription: "retain" },
} as const;

async function setupBusiness(label: string, dunningConfig?: Record<string, unknown>) {
  const org = await createOrganization({ name: `Dunning policies ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  if (dunningConfig)
    await systemDb.update(businesses).set({ dunningConfig }).where(eq(businesses.id, biz.id));
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  return { org, orgId, biz, bizId: biz.id, price };
}

type Biz = Awaited<ReturnType<typeof setupBusiness>>;

/** A customer on a failing card with one billed, failed invoice. */
async function failingCustomer(
  b: Biz,
  email: string,
  opts: { policyId?: string; excluded?: boolean } = {},
) {
  const customer = await createCustomer({
    organizationId: b.orgId,
    businessId: b.bizId,
    email,
    dunningExcluded: opts.excluded,
    dunningPolicyId: opts.policyId ?? null,
  });
  const pm = await vaultPaymentMethod({
    organizationId: b.orgId,
    businessId: b.bizId,
    customer,
    token: "4000000000009995",
  });
  const sub = await createSubscription({
    organizationId: b.orgId,
    businessId: b.bizId,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: b.price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: b.orgId,
    businessId: b.bizId,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return { customer, sub: sub.subscription, invoiceId: invoice.id };
}

const getInv = (orgId: string, id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0]!,
  );
const getSub = (orgId: string, id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );
const payCount = (orgId: string, invoiceId: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select({ id: payments.id }).from(payments).where(eq(payments.invoiceId, invoiceId)))
        .length,
  );
const backdate = (id: string) =>
  systemDb
    .update(invoices)
    .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
    .where(eq(invoices.id, id));
const scopedPass = (bizId: string, now = new Date()) =>
  runWithClockScope({ onlyBusinessId: bizId, now }, () => runDunningPass(now));

// ── P1: resolution order ────────────────────────────────────────────────────────
{
  const b = await setupBusiness("Resolve", {
    retries: [{ after_days: 2 }, { after_days: 4 }],
    collect_on_payment_method_update: false,
    minimum_amounts: { USD: 100 },
  });
  const pol = await createDunningPolicy({
    organizationId: b.orgId,
    businessId: b.bizId,
    name: "Short",
    code: "short",
    config: SHORT,
  });
  const plain = await createCustomer({
    organizationId: b.orgId,
    businessId: b.bizId,
    email: "plain@example.com",
  });
  const onPol = await createCustomer({
    organizationId: b.orgId,
    businessId: b.bizId,
    email: "pol@example.com",
    dunningPolicyId: pol.id,
  });
  const [bizCfg, plainCfg, polCfg] = await withTenant(b.orgId, async (tx) => [
    await loadEffectiveDunningConfig(tx, { businessId: b.bizId }),
    await loadEffectiveDunningConfig(tx, { businessId: b.bizId, customerId: plain.id }),
    await loadEffectiveDunningConfig(tx, { businessId: b.bizId, customerId: onPol.id }),
  ]);
  check(
    "P1 no policy: the customer runs the business config",
    JSON.stringify(plainCfg) === JSON.stringify(bizCfg) && plainCfg.retryDays.join() === "2,4",
    `retries=${plainCfg.retryDays}`,
  );
  check(
    "P1 policy: its per-invoice keys replace the business's",
    polCfg.retryDays.join() === "1" &&
      polCfg.finalAction.invoice === "void" &&
      polCfg.finalAction.subscription === "retain" &&
      Object.keys(polCfg.minimumAmounts).length === 0,
    `retries=${polCfg.retryDays} final=${JSON.stringify(polCfg.finalAction)} min=${JSON.stringify(polCfg.minimumAmounts)}`,
  );
  check(
    "P1 policy: business-wide keys stay with the business",
    polCfg.collectOnPaymentMethodUpdate === false,
    `collect_on_pm_update=${polCfg.collectOnPaymentMethodUpdate}`,
  );
  const [stored] = await withTenant(b.orgId, (tx) =>
    tx.select().from(dunningPolicies).where(eq(dunningPolicies.id, pol.id)),
  );
  const cfg = stored?.config as Record<string, unknown>;
  check(
    "P1 stored config is the full per-invoice set",
    !!cfg &&
      [
        "enabled",
        "mode",
        "retries",
        "final_action",
        "dunning_period_days",
        "skip_retries_for_hard_failures",
        "park_hard_declines",
        "adaptive_timing",
        "minimum_amounts",
        "dun_offline_invoices",
        "dun_one_time_invoices",
        "dun_trial_and_future_subscriptions",
      ].every((k) => k in cfg) &&
      !("collect_on_payment_method_update" in cfg),
    JSON.stringify(cfg),
  );
}

// ── P2: exclusion beats a policy ────────────────────────────────────────────────
{
  const b = await setupBusiness("Excluded");
  const pol = await createDunningPolicy({
    organizationId: b.orgId,
    businessId: b.bizId,
    name: "Long",
    code: "long",
    config: { retries: [{ after_days: 1 }, { after_days: 2 }] },
  });
  const x = await failingCustomer(b, "x@example.com", { policyId: pol.id, excluded: true });
  const inv = await getInv(b.orgId, x.invoiceId);
  check(
    "P2 excluded with a policy: dunning does not start",
    inv.status === "not_paid" && inv.dunningStatus === null && inv.nextAttemptAt === null,
    `status=${inv.status} dunning=${inv.dunningStatus}`,
  );
}

// ── P3: the policy minimum at the first failure (collectInvoice) ───────────────
{
  const b = await setupBusiness("Minimum");
  const pol = await createDunningPolicy({
    organizationId: b.orgId,
    businessId: b.bizId,
    name: "Big only",
    code: "big-only",
    config: { minimum_amounts: { USD: 6000 } },
  });
  const held = await failingCustomer(b, "held@example.com", { policyId: pol.id });
  const free = await failingCustomer(b, "free@example.com");
  const h = await getInv(b.orgId, held.invoiceId);
  const f = await getInv(b.orgId, free.invoiceId);
  check(
    "P3 policy minimum above the amount: dunning does not start",
    h.status === "not_paid" && h.dunningStatus === null,
    `status=${h.status} dunning=${h.dunningStatus}`,
  );
  check(
    "P3 same business, no policy: dunning starts",
    f.status === "payment_due" && f.dunningStatus === "in_progress",
    `status=${f.status} dunning=${f.dunningStatus}`,
  );
}

// ── P4: the policy minimum in the scan filter and the pump ─────────────────────
{
  const b = await setupBusiness("ScanMinimum");
  const pol = await createDunningPolicy({
    organizationId: b.orgId,
    businessId: b.bizId,
    name: "Big only",
    code: "big-only",
    config: { minimum_amounts: { USD: 6000 } },
  });
  const c = await failingCustomer(b, "scan@example.com");
  await updateCustomer({
    organizationId: b.orgId,
    businessId: b.bizId,
    customerPublicId: c.customer.publicId,
    dunningPolicyId: pol.id,
  });
  await backdate(c.invoiceId);
  const notHeld = await withTenant(b.orgId, async (tx) => {
    const rows = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.id, c.invoiceId), dunningNotHeldSql()));
    return rows.length;
  });
  await scopedPass(b.bizId);
  const pump = await runWithClockScope({ onlyBusinessId: b.bizId, now: new Date() }, () =>
    retryDueInvoice(
      { id: c.invoiceId, organizationId: b.orgId, businessId: b.bizId, subscriptionId: c.sub.id },
      new Date(),
    ),
  );
  check(
    "P4 policy minimum: the scan filter holds the invoice",
    notHeld === 0,
    `matched=${notHeld}`,
  );
  check(
    "P4 policy minimum: the pass and the pump make no retry",
    (await payCount(b.orgId, c.invoiceId)) === 1 && pump === null,
    `payments=${await payCount(b.orgId, c.invoiceId)} pump=${pump}`,
  );
  const journey = await getDunningJourney({
    organizationId: b.orgId,
    business: { id: b.bizId },
    invoicePublicId: (await getInv(b.orgId, c.invoiceId)).publicId,
  });
  check(
    "P4 the journey reads the policy",
    journey?.projectionNote === "below_minimum",
    `note=${journey?.projectionNote}`,
  );
}

// ── P5: switching policy mid-dunning ────────────────────────────────────────────
{
  const b = await setupBusiness("Switch");
  const pol = await createDunningPolicy({
    organizationId: b.orgId,
    businessId: b.bizId,
    name: "Short",
    code: "short",
    config: SHORT,
  });
  const c = await failingCustomer(b, "switch@example.com");
  const before = await getInv(b.orgId, c.invoiceId);
  await updateCustomer({
    organizationId: b.orgId,
    businessId: b.bizId,
    customerPublicId: c.customer.publicId,
    dunningPolicyId: pol.id,
  });
  const kept = await getInv(b.orgId, c.invoiceId);
  check(
    "P5 switch: nothing is rewritten on assignment",
    kept.nextAttemptAt?.getTime() === before.nextAttemptAt?.getTime() &&
      kept.attemptCount === before.attemptCount,
    `next=${kept.nextAttemptAt?.toISOString()} attempts=${kept.attemptCount}`,
  );
  await backdate(c.invoiceId);
  await scopedPass(b.bizId);
  const inv = await getInv(b.orgId, c.invoiceId);
  const sub = await getSub(b.orgId, c.sub.id);
  check(
    "P5 switch: the shorter list exhausts at the next failure",
    inv.dunningStatus === "exhausted" && inv.attemptCount === 2,
    `status=${inv.status} dunning=${inv.dunningStatus} attempts=${inv.attemptCount}`,
  );
  check(
    "P5 switch: the final action is the new policy's (void + retain)",
    inv.status === "voided" && sub.status === "active",
    `invoice=${inv.status} sub=${sub.status}`,
  );
  // Control: same business, no policy → the 4-step default schedules another retry.
  const d = await failingCustomer(b, "control@example.com");
  await backdate(d.invoiceId);
  await scopedPass(b.bizId);
  const ctl = await getInv(b.orgId, d.invoiceId);
  check(
    "P5 control: without the policy the business schedule retries again",
    ctl.status === "payment_due" && ctl.dunningStatus === "in_progress" && ctl.attemptCount === 2,
    `status=${ctl.status} dunning=${ctl.dunningStatus} attempts=${ctl.attemptCount}`,
  );
}

// ── P6/P7/P8: API, archive, events, isolation ──────────────────────────────────
{
  const b = await setupBusiness("Api");
  const other = await setupBusiness("ApiOther");
  const app = await buildApp({ logger: false });
  let n = 0;
  const call = async (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
    who: Biz = b,
  ) => {
    const res = await app.inject({
      method,
      url: `/v1/businesses/${who.biz.publicId}${url}`,
      headers: {
        authorization: `Bearer ${who.org.secret}`,
        "idempotency-key": `dpol-${Date.now()}-${n++}`,
      },
      ...(payload ? { payload } : {}),
    });
    return { status: res.statusCode, body: JSON.parse(res.body || "null") };
  };
  const created = await call("POST", "/dunning_policies", {
    name: "Gentle",
    code: "gentle",
    config: {
      retries: [{ after_days: 3 }],
      final_action: { invoice: "not_paid", subscription: "retain" },
    },
  });
  const bizKey = await call("POST", "/dunning_policies", {
    name: "Bad",
    code: "bad",
    config: { collect_on_payment_method_update: false },
  });
  const dup = await call("POST", "/dunning_policies", {
    name: "Again",
    code: "gentle",
    config: {},
  });
  check(
    "P7 create: 201 with dpol_ id and the full config",
    created.status === 201 &&
      String(created.body?.id).startsWith("dpol_") &&
      created.body?.config?.retries?.[0]?.after_days === 3 &&
      created.body?.config?.enabled === true,
    `status=${created.status} body=${JSON.stringify(created.body)}`,
  );
  check(
    "P7 create: a business-wide key is refused",
    bizKey.status === 400,
    `status=${bizKey.status} ${bizKey.body?.error?.message ?? ""}`,
  );
  check("P7 create: a live code is unique", dup.status === 409, `status=${dup.status}`);
  const pid = created.body?.id as string;
  const cus = await call("POST", "/customers", { email: "api@example.com", dunning_policy: pid });
  const read = await call("GET", `/customers/${cus.body?.id}`);
  const list = await call("GET", "/customers?limit=10");
  check(
    "P7 customer create/read reports dunning_policy",
    cus.status === 201 &&
      cus.body?.dunning_policy === pid &&
      read.body?.dunning_policy === pid &&
      list.body?.data?.find((c: { id: string }) => c.id === cus.body?.id)?.dunning_policy === pid,
    `create=${cus.status}/${cus.body?.dunning_policy} read=${read.body?.dunning_policy}`,
  );
  const unknown = await call("PATCH", `/customers/${cus.body?.id}`, {
    dunning_policy: "dpol_nope",
  });
  check("P7 unknown policy is refused", unknown.status === 400, `status=${unknown.status}`);
  const got = await call("GET", `/dunning_policies/${pid}`);
  check(
    "P6 the policy counts its customers",
    got.body?.customer_count === 1,
    `count=${got.body?.customer_count}`,
  );
  const refused = await call("POST", `/dunning_policies/${pid}/archive`);
  check(
    "P6 archive refused while assigned (message names the count)",
    refused.status === 409 && /1 customer uses it/.test(refused.body?.error?.message ?? ""),
    `status=${refused.status} ${refused.body?.error?.message ?? ""}`,
  );
  await call("PATCH", `/customers/${cus.body?.id}`, { dunning_policy: null });
  const archived = await call("POST", `/dunning_policies/${pid}/archive`);
  const assignArchived = await call("PATCH", `/customers/${cus.body?.id}`, {
    dunning_policy: pid,
  });
  const reuse = await call("POST", "/dunning_policies", {
    name: "Gentle 2",
    code: "gentle",
    config: {},
  });
  check(
    "P6 archive succeeds once unassigned; archived cannot be assigned; code is free again",
    archived.status === 200 &&
      archived.body?.archived === true &&
      assignArchived.status === 400 &&
      reuse.status === 201,
    `archive=${archived.status} assign=${assignArchived.status} reuse=${reuse.status}`,
  );
  const patched = await call("PATCH", `/dunning_policies/${reuse.body?.id}`, {
    config: { retries: [{ after_days: 5 }] },
  });
  check(
    "P7 PATCH replaces the whole config",
    patched.status === 200 &&
      patched.body?.config?.retries?.length === 1 &&
      patched.body?.config?.retries?.[0]?.after_days === 5,
    `status=${patched.status} retries=${JSON.stringify(patched.body?.config?.retries)}`,
  );
  const evs = await withTenant(b.orgId, (tx) =>
    tx
      .select({ type: events.type })
      .from(events)
      .where(sql`${events.type} like 'dunning_policy_%'`),
  );
  const types = new Set(evs.map((e) => e.type));
  check(
    "P7 created/updated/archived events are emitted",
    types.has("dunning_policy_created") &&
      types.has("dunning_policy_updated") &&
      types.has("dunning_policy_archived"),
    [...types].join(","),
  );
  // P8 isolation: the other org cannot read or assign this business's policy.
  const cross = await call("GET", `/dunning_policies/${reuse.body?.id}`, undefined, other);
  const crossAssign = await call(
    "POST",
    "/customers",
    { email: "x@example.com", dunning_policy: reuse.body?.id },
    other,
  );
  const rlsCount = await withTenant(other.orgId, async (tx) =>
    Number(
      (
        (await tx.execute(
          sql`select count(*)::int as n from dunning_policies`,
        )) as unknown as Array<{
          n: number;
        }>
      )[0]?.n ?? -1,
    ),
  );
  check(
    "P8 cross-tenant: 404 on read, 400 on assign, RLS hides the rows",
    cross.status === 404 && crossAssign.status === 400 && rlsCount === 0,
    `read=${cross.status} assign=${crossAssign.status} rls=${rlsCount}`,
  );
  await app.close();
}

// ── P9: every dunning read goes through the customer-aware loader ──────────────
{
  const allowed = new Set([
    "src/modules/subscriptions/dunning-schedule.ts",
    "src/modules/dunning-policies/effective.ts",
  ]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !allowed.has(p)) {
        const text = readFileSync(p, "utf8");
        if (/resolveDunningConfig\(/.test(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")))
          offenders.push(p);
      }
    }
  };
  walk("src");
  check(
    "P9 no call site resolves the business config alone",
    offenders.length === 0,
    offenders.join(", ") || "none",
  );
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
console.log(failed ? "❌ DUNNING-POLICIES: FAIL" : "✅ DUNNING-POLICIES: PASS");
await closeDb();
process.exit(failed ? 1 : 0);
