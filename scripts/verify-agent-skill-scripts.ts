/**
 * The Agent Skills' scripts (the .mjs files under docs-site/skills), run for real against this engine
 * over HTTP, the way a coding agent runs them:
 *  - preflight: test key → 0; live write key → 3; live read key with --allow-live-read → 4; bad key → 2
 *  - clock: refuses a live key; start, advance a month, stop keeping data — with a TEST key
 *  - money-check: a real first invoice and a real renewal match; a wrong total exits 2
 *  - go-live-audit: snapshot with a test key; audit refuses a write key; a read key audits and
 *    reports the missing live gateway as a FAIL
 *  - webhook-check: passes a correct handler; fails one that skips the signature; loopback only
 *  - catalog: plan → apply → "Nothing to change"; a one-time charge round-trips; a changed kind
 *    or interval is a CONFLICT (exit 2); a changed amount is a planned edit; a live key is
 *    refused; a new business beside existing test businesses is flagged with their names; credit
 *    units come first; plan lines show the trial, credits and rate; a removed trial, a changed
 *    grant, changed rates and a unit name are edits that converge; a locked unit's decimals
 *    conflict
 *  - catalog, tax and settings: a GST region, coupons, a coupon set and business settings plan,
 *    apply and converge; edits plan as old → new (other credit_config keys kept); archived: true
 *    archives; a redeemed coupon's discount is a CONFLICT; an unknown setting is refused
 *  - register-webhook: writes the secret to the env file without printing it; refuses a second
 *    run, a git-tracked file and plain http
 *  - money-check --session: a completed one-time purchase matches, tax lines and metadata
 *    included; a differing or unlisted tax line or metadata value exits 2; an open session exits 1
 */
import { createServer, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { createApiKey, createOrganization } from "@/modules/tenancy/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import { businesses } from "@db/schema";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

const SKILLS = join(import.meta.dirname, "../docs-site/skills");
const PREFLIGHT = join(SKILLS, "two-minute-billing/scripts/preflight.mjs");
const CLOCK = join(SKILLS, "two-minute-billing-verify/scripts/clock.mjs");
const MONEY = join(SKILLS, "two-minute-billing-verify/scripts/money-check.mjs");
const HOOK = join(SKILLS, "two-minute-billing-verify/scripts/webhook-check.mjs");
const AUDIT = join(SKILLS, "two-minute-billing-go-live/scripts/go-live-audit.mjs");
const CATALOG = join(SKILLS, "two-minute-billing-pricing/scripts/catalog.mjs");
const REGISTER = join(SKILLS, "two-minute-billing-integrate/scripts/register-webhook.mjs");

const checks: Array<[string, boolean]> = [];
const tmp = mkdtempSync(join(tmpdir(), "skill-scripts-"));

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const URL_ = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const { organization } = await createOrganization({ name: "Skill Scripts Co" });
const { secret: testKey } = await createApiKey(organization.id, "test");
const { secret: liveKey } = await createApiKey(organization.id, "live");
const { secret: liveReadKey } = await createApiKey(organization.id, "live", "api", "read");

// Async on purpose: the server answers from this same process.
function run(script: string, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        env: { PATH: process.env.PATH ?? "", TMBILLING_URL: URL_, ...env },
        cwd: tmp,
        timeout: 5 * 60_000,
      },
      (err, stdout, stderr) =>
        resolve({ code: err ? Number(err.code ?? 1) : 0, out: stdout + stderr }),
    );
  });
}
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${testKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

// ——— preflight ——————————————————————————————————————————————————————————————
const pTest = await run(PREFLIGHT, ["--json"], { TMBILLING_API_KEY: testKey });
checks.push([
  "preflight: test key → exit 0, mode from the server",
  pTest.code === 0 && JSON.parse(pTest.out).mode_source === "server",
]);
checks.push(["preflight: never prints the key", !pTest.out.includes(testKey.slice(8))]);
checks.push([
  "preflight: live write key → exit 3",
  (await run(PREFLIGHT, [], { TMBILLING_API_KEY: liveKey })).code === 3,
]);
checks.push([
  "preflight: live read key with --allow-live-read → exit 4",
  (await run(PREFLIGHT, ["--allow-live-read"], { TMBILLING_API_KEY: liveReadKey })).code === 4,
]);
checks.push([
  "preflight: unknown key → exit 2",
  (await run(PREFLIGHT, [], { TMBILLING_API_KEY: "sk_test_nope" })).code === 2,
]);
checks.push([
  "preflight: no settings → exit 1",
  (await run(PREFLIGHT, [], { TMBILLING_URL: "" })).code === 1,
]);

// ——— a real test business, on the simulated clock ———————————————————————————
const biz = await api("POST", "/v1/businesses", {
  name: "Skill Scripts Test",
  default_currency: "USD",
});
const env = { TMBILLING_API_KEY: testKey, TMBILLING_BUSINESS_ID: biz.id };
checks.push([
  "clock: refuses a live key",
  (await run(CLOCK, ["status"], { ...env, TMBILLING_API_KEY: liveKey })).code === 3,
]);
const start = await run(CLOCK, ["start"], env);
checks.push([
  "clock: start with a test key",
  start.code === 0 && start.out.includes('"in_progress"'),
]);

await api("POST", `/v1/businesses/${biz.id}/products`, { id: "pro", name: "Pro" });
await api("POST", `/v1/businesses/${biz.id}/prices`, {
  id: "pro-monthly-usd",
  product: "pro",
  name: "Pro monthly",
  model: "flat",
  currency: "USD",
  amount_minor: 2900,
  interval: "month",
});
const cus = await api("POST", `/v1/businesses/${biz.id}/customers`, {
  email: "skill-check@example.com",
  currency: "USD",
});
await api("POST", `/v1/businesses/${biz.id}/customers/${cus.id}/payment_methods`, {
  token: "4242424242424242",
});
const sub = await api("POST", `/v1/businesses/${biz.id}/customers/${cus.id}/subscriptions`, {
  items: [{ price: "pro-monthly-usd", quantity: 1 }],
});

const expected = join(tmp, "expected.json");
writeFileSync(
  expected,
  JSON.stringify({
    currency: "USD",
    total_minor: 2900,
    status: "paid",
    lines: [{ price: "pro-monthly-usd", amount_minor: 2900 }],
  }),
);
const first = await run(
  MONEY,
  ["--expected", expected, "--subscription", sub.id, "--report", "first.json"],
  env,
);
checks.push([
  "money-check: the first invoice matches",
  first.code === 0 && first.out.includes("MATCH"),
]);
const wrong = join(tmp, "wrong.json");
writeFileSync(wrong, JSON.stringify({ currency: "USD", total_minor: 3000 }));
checks.push([
  "money-check: a wrong total → exit 2",
  (await run(MONEY, ["--expected", wrong, "--subscription", sub.id], env)).code === 2,
]);

const adv = await run(CLOCK, ["advance", "--by", "1m"], env);
checks.push(["clock: advance a month with a test key", adv.code === 0]);
const invs = await api("GET", `/v1/businesses/${biz.id}/invoices?subscription=${sub.id}`);
checks.push(["the advance raised the renewal invoice", invs.data.length === 2]);
const renewal = await run(MONEY, ["--expected", expected, "--subscription", sub.id], env);
checks.push(["money-check: the renewal matches", renewal.code === 0 && invs.data.length === 2]);

const stop = await run(CLOCK, ["stop"], env);
const kept = await api("GET", `/v1/businesses/${biz.id}/invoices?subscription=${sub.id}`);
checks.push(["clock: stop keeps the test data", stop.code === 0 && kept.data.length === 2]);

// ——— go-live audit —————————————————————————————————————————————————————————
const snap = await run(AUDIT, ["snapshot"], env);
checks.push(["go-live-audit: snapshot with a test key", snap.code === 0]);
checks.push([
  "go-live-audit: refuses a live key that can write",
  (await run(AUDIT, ["audit"], { TMBILLING_LIVE_READ_KEY: liveKey })).code === 3,
]);
const audit = await run(AUDIT, ["audit"], { TMBILLING_LIVE_READ_KEY: liveReadKey });
checks.push([
  "go-live-audit: a read key audits; no live gateway is a FAIL",
  audit.code === 2 &&
    /FAIL\s+payment gateway/.test(audit.out) &&
    /FAIL\s+catalog copied to live/.test(audit.out),
]);

// ——— webhook-check against a correct and a careless handler ——————————————————————
const SECRET = "whsec_skill_check";
const seen = new Set<string>();
function handler(checkSignature: boolean): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const want = Buffer.from("sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex"));
      const got = Buffer.from(String(req.headers["tmbilling-signature"] ?? ""));
      if (checkSignature && !(want.length === got.length && timingSafeEqual(want, got))) {
        res.writeHead(401).end();
        return;
      }
      seen.add(String(req.headers["tmbilling-event-id"]));
      res.writeHead(200).end();
    });
  });
}
const listen = (s: Server) =>
  new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const good = handler(true);
const careless = handler(false);
const goodPort = await listen(good);
const carelessPort = await listen(careless);
const hookEnv = { TMBILLING_WEBHOOK_SECRET: SECRET };
checks.push([
  "webhook-check: a correct handler passes",
  (await run(HOOK, ["--url", `http://127.0.0.1:${goodPort}/hooks`], hookEnv)).code === 0,
]);
const c = await run(HOOK, ["--url", `http://localhost:${carelessPort}/hooks`], hookEnv);
checks.push([
  "webhook-check: a handler that skips the signature fails",
  c.code === 2 && c.out.includes("does not check the signature"),
]);
checks.push([
  "webhook-check: a non-loopback URL is refused",
  (await run(HOOK, ["--url", "https://app.example.com/hooks"], hookEnv)).code === 1,
]);
good.close();
careless.close();

// ——— catalog as code, with a one-time charge ————————————————————————————————————
const catalogName = `Skill Catalog ${crypto.randomUUID().slice(0, 8)}`;
const catalog = {
  business: { name: catalogName, default_currency: "USD" },
  products: [
    { id: "pro", name: "Pro", kind: "plan" },
    { id: "credit-pack", name: "Credit pack", kind: "charge" },
  ],
  prices: [
    {
      id: "pro-monthly-usd",
      product: "pro",
      name: "Pro monthly",
      type: "recurring",
      model: "flat",
      currency: "USD",
      amount_minor: 2900,
      interval: "month",
      tax_behavior: "exclusive",
    },
    {
      id: "credit-pack-usd",
      product: "credit-pack",
      name: "Credit pack",
      type: "one_time",
      model: "flat",
      currency: "USD",
      amount_minor: 2500,
      tax_behavior: "exclusive",
    },
  ],
  features: [{ key: "projects", name: "Projects", type: "quota" }],
  entitlements: [{ product: "pro", feature: "projects", value: "10" }],
};
const catalogFile = join(tmp, "billing.catalog.json");
writeFileSync(catalogFile, JSON.stringify(catalog));
const keyEnv = { TMBILLING_API_KEY: testKey };
checks.push([
  "catalog: refuses a live key",
  (await run(CATALOG, [catalogFile], { TMBILLING_API_KEY: liveKey })).code === 3,
]);
const plan = await run(CATALOG, [catalogFile], keyEnv);
checks.push([
  "catalog: plan lists the creates, changes nothing",
  plan.code === 0 &&
    plan.out.includes(`+ business "${catalogName}"`) &&
    plan.out.includes("+ product credit-pack (charge)") &&
    plan.out.includes("+ price credit-pack-usd (flat, one_time, USD, 2500, tax exclusive)") &&
    plan.out.includes("+ pro grants projects = 10") &&
    plan.out.includes("Plan only") &&
    !(await api("GET", "/v1/businesses")).data.some((b: any) => b.name === catalogName),
]);
checks.push([
  "catalog: a new business beside existing ones is flagged with their names",
  /! NEW BUSINESS: .*CREATES one/.test(plan.out) &&
    plan.out.includes('"Skill Scripts Test"') &&
    JSON.parse((await run(CATALOG, [catalogFile, "--json"], keyEnv)).out).new_business === true,
]);
const applied = await run(CATALOG, [catalogFile, "--apply"], keyEnv);
const cbiz = (await api("GET", "/v1/businesses")).data.find((b: any) => b.name === catalogName);
checks.push([
  "catalog: --apply creates the business and everything under it",
  applied.code === 0 && !!cbiz && applied.out.includes("done + price credit-pack-usd"),
]);
const again = await run(CATALOG, [catalogFile, "--json"], keyEnv);
checks.push([
  "catalog: an existing business by its exact name is no new business",
  JSON.parse(again.out).new_business === false && !again.out.includes("NEW BUSINESS"),
]);
checks.push([
  'catalog: a second run → "Nothing to change", exit 0',
  again.code === 0 &&
    JSON.parse(again.out).result === "nothing to change" &&
    (await run(CATALOG, [catalogFile], keyEnv)).out.includes("Nothing to change."),
]);
const packProduct = cbiz ? await api("GET", `/v1/businesses/${cbiz.id}/products/credit-pack`) : {};
const packPrice = cbiz ? await api("GET", `/v1/businesses/${cbiz.id}/prices/credit-pack-usd`) : {};
checks.push([
  "catalog: the one-time charge round-trips (kind, type, tax_behavior)",
  packProduct.kind === "charge" &&
    packPrice.type === "one_time" &&
    packPrice.tax_behavior === "exclusive" &&
    packPrice.amount_minor === 2500,
]);
const changed = structuredClone(catalog);
changed.prices[0]!.amount_minor = 3900;
changed.products[1]!.kind = "addon";
const changedFile = join(tmp, "changed.catalog.json");
writeFileSync(changedFile, JSON.stringify(changed));
const conflict = await run(CATALOG, [changedFile, "--apply"], keyEnv);
const proPrice = cbiz ? await api("GET", `/v1/businesses/${cbiz.id}/prices/pro-monthly-usd`) : {};
checks.push([
  "catalog: a changed kind is a CONFLICT, exit 2, nothing applied (the amount edit waits too)",
  conflict.code === 2 &&
    conflict.out.includes("~ price pro-monthly-usd: amount_minor 2900 → 3900") &&
    conflict.out.includes("! CONFLICT product credit-pack: kind") &&
    proPrice.amount_minor === 2900,
]);
const moved = structuredClone(catalog);
moved.prices[0]!.interval = "year";
writeFileSync(changedFile, JSON.stringify(moved));
const fixedField = await run(CATALOG, [changedFile], keyEnv);
checks.push([
  "catalog: a price field the API cannot change (interval) is a CONFLICT, exit 2",
  fixedField.code === 2 &&
    fixedField.out.includes(
      '! CONFLICT price pro-monthly-usd: interval is "month", file says "year"',
    ),
]);

// ——— catalog: credit units, credits, trials and rates ————————————————————————————
const creditName = `Skill Credits ${crypto.randomUUID().slice(0, 8)}`;
const credits = {
  business: { name: creditName, default_currency: "USD" },
  credit_units: [
    { id: "credit", name: "credit", currency: "USD", minor_per_unit: "60", decimals: 1 },
  ],
  meters: [
    {
      id: "images",
      name: "Images",
      event_name: "images",
      aggregation: "sum",
      value_property: "credits",
      group_by: ["model"],
    },
  ],
  products: [
    { id: "pro", name: "Pro", kind: "plan" },
    { id: "usage", name: "Usage", kind: "addon" },
  ],
  prices: [
    {
      id: "pro-monthly",
      product: "pro",
      type: "recurring",
      model: "flat",
      currency: "USD",
      amount_minor: 9900,
      interval: "month",
      trial_period: 14,
      trial_period_unit: "day",
      grants_credit: {
        kind: "per_cycle",
        unit: "credit",
        amount: 250,
        reset: { every: "month" },
        on_exhausted: "block",
        applicability: { kind: "meters", meters: ["images"] },
      },
    } as Record<string, unknown>,
    {
      id: "images-monthly",
      product: "usage",
      type: "recurring",
      model: "usage",
      currency: "USD",
      interval: "month",
      meter: "images",
      unit_amount_decimal: "60",
      rates: [{ match: { model: "fast" }, unit_amount_decimal: "30" }],
    } as Record<string, unknown>,
  ],
};
const creditsFile = join(tmp, "credits.catalog.json");
writeFileSync(creditsFile, JSON.stringify(credits));
const cPlan = await run(CATALOG, [creditsFile], keyEnv);
const unitAt = cPlan.out.indexOf("+ credit unit credit (USD, 60 minor per unit, 1 decimals)");
checks.push([
  "catalog: a credit unit in the file is planned before the meters and prices",
  cPlan.code === 0 && unitAt >= 0 && unitAt < cPlan.out.indexOf("+ price pro-monthly"),
]);
checks.push([
  "catalog: the plan line shows the trial, the credits (amount, unit, kind, reset) and the rate",
  cPlan.out.includes(
    "+ price pro-monthly (flat, recurring, USD, 9900, per 1 month, trial 14 day, credits 25 credit (amount 250) per_cycle, reset every month, on exhausted block)",
  ) && cPlan.out.includes("meter images, rate 60, 1 rate card row(s)"),
]);
const cApplied = await run(CATALOG, [creditsFile, "--apply"], keyEnv);
const cAgain = await run(CATALOG, [creditsFile, "--json"], keyEnv);
checks.push([
  "catalog: credits catalog applies, then a second run changes nothing",
  cApplied.code === 0 && cAgain.code === 0 && JSON.parse(cAgain.out).result === "nothing to change",
]);
const creditBiz = (await api("GET", "/v1/businesses")).data.find((b: any) => b.name === creditName);
const CREDIT_BIZ = `/v1/businesses/${creditBiz?.id}`;
const edited = structuredClone(credits);
delete edited.prices[0]!.trial_period;
delete edited.prices[0]!.trial_period_unit;
(edited.prices[0]!.grants_credit as Record<string, unknown>).amount = 500;
edited.prices[1]!.rates = [{ match: { model: "fast" }, unit_amount_decimal: "25" }];
edited.credit_units[0]!.name = "image credit";
writeFileSync(creditsFile, JSON.stringify(edited));
const ePlan = await run(CATALOG, [creditsFile], keyEnv);
checks.push([
  "catalog: a removed trial, a changed grant, changed rates and a unit name are changes, not 'nothing to change'",
  ePlan.code === 0 &&
    ePlan.out.includes("~ price pro-monthly: grants_credit: credits 25 credit (amount 250)") &&
    ePlan.out.includes("→ credits 50 credit (amount 500)") &&
    ePlan.out.includes("trial_period 14 → null") &&
    ePlan.out.includes("~ price images-monthly: rates") &&
    ePlan.out.includes('~ credit unit credit: name "credit" → "image credit"'),
]);
const eApplied = await run(CATALOG, [creditsFile, "--apply"], keyEnv);
const proAfter = creditBiz ? await api("GET", `${CREDIT_BIZ}/prices/pro-monthly`) : {};
const eAgain = await run(CATALOG, [creditsFile, "--json"], keyEnv);
checks.push([
  "catalog: --apply edits the price (no trial, 500 credits), and the next run changes nothing",
  eApplied.code === 0 &&
    !proAfter.trial_period &&
    proAfter.grants_credit?.amount === 500 &&
    JSON.parse(eAgain.out).result === "nothing to change",
]);
// A grant locks the unit's money value and decimals.
const holder = creditBiz
  ? await api("POST", `${CREDIT_BIZ}/customers`, { email: "unit-lock@example.com" })
  : { id: "" };
if (creditBiz)
  await api("POST", `${CREDIT_BIZ}/customers/${holder.id}/credit_grants`, {
    unit: "credit",
    amount: 10,
    category: "promotional",
  });
const relocked = structuredClone(edited);
relocked.credit_units[0]!.decimals = 2;
writeFileSync(creditsFile, JSON.stringify(relocked));
const locked = await run(CATALOG, [creditsFile], keyEnv);
checks.push([
  "catalog: changed decimals on a unit a grant uses is a CONFLICT, exit 2",
  locked.code === 2 &&
    locked.out.includes(
      "! CONFLICT credit unit credit: decimals is 1, file says 2 (a grant uses the unit)",
    ),
]);

// A unit with no money rate, and a meter's credit cost in it.
const own = structuredClone(edited) as any;
own.credit_units.push({ id: "token", name: "token", currency: "USD", minor_per_unit: null });
own.meters.push({
  id: "renders",
  name: "Renders",
  event_name: "renders",
  aggregation: "count",
  credit_cost: {
    unit: "token",
    credits_per_unit: "2.50",
    overrides: [{ product: "pro", credits_per_unit: 2 }],
  },
});
writeFileSync(creditsFile, JSON.stringify(own));
const oPlan = await run(CATALOG, [creditsFile], keyEnv);
checks.push([
  "catalog: a unit with minor_per_unit null and a meter credit cost are planned",
  oPlan.code === 0 &&
    oPlan.out.includes("+ credit unit token (USD, no money rate, 0 decimals)") &&
    oPlan.out.includes("+ meter renders: credit cost 2.5 token per unit, 1 override(s)"),
]);
const oApplied = await run(CATALOG, [creditsFile, "--apply"], keyEnv);
const tokenUnit = creditBiz
  ? (await api("GET", `${CREDIT_BIZ}/credit_units`)).data.find((u: any) => u.id === "token")
  : null;
const rendersCost = creditBiz ? await api("GET", `${CREDIT_BIZ}/meters/renders/credit_cost`) : {};
const oAgain = await run(CATALOG, [creditsFile, "--json"], keyEnv);
checks.push([
  'catalog: --apply stores null (not "null") and the credit cost; the next run changes nothing',
  oApplied.code === 0 &&
    tokenUnit?.minor_per_unit === null &&
    rendersCost.unit === "token" &&
    Number(rendersCost.credits_per_unit) === 2.5 &&
    rendersCost.overrides?.[0]?.product === "pro" &&
    JSON.parse(oAgain.out).result === "nothing to change",
]);
delete own.meters[1].credit_cost;
writeFileSync(creditsFile, JSON.stringify(own));
const rPlan = await run(CATALOG, [creditsFile], keyEnv);
await run(CATALOG, [creditsFile, "--apply"], keyEnv);
const rendersAfter = creditBiz ? await api("GET", `${CREDIT_BIZ}/meters/renders`) : {};
checks.push([
  "catalog: a credit cost left out of the file is planned for removal, and --apply removes it",
  rPlan.out.includes("~ meter renders: remove credit cost (2.5 token per unit)") &&
    rendersAfter.credit_cost === null,
]);

// A unit's overage price, overdraft limit and reset rule are editable and compared.
const pol = structuredClone(own) as any;
pol.meters[1].credit_cost = { unit: "token", credits_per_unit: 1 };
Object.assign(pol.credit_units[1], {
  overage_minor_per_unit: "0.5",
  overdraft_limit: 20,
  negative_balance_at_reset: "forgive",
});
writeFileSync(creditsFile, JSON.stringify(pol));
const polPlan = await run(CATALOG, [creditsFile], keyEnv);
checks.push([
  "catalog: overage_minor_per_unit, overdraft_limit and negative_balance_at_reset on a unit are planned",
  !polPlan.out.includes("Nothing to change") &&
    polPlan.out.includes('~ credit unit token: overage_minor_per_unit null → "0.5"') &&
    polPlan.out.includes("overdraft_limit 0 → 20") &&
    polPlan.out.includes('negative_balance_at_reset "carry" → "forgive"'),
]);
await run(CATALOG, [creditsFile, "--apply"], keyEnv);
const polUnit = creditBiz
  ? (await api("GET", `${CREDIT_BIZ}/credit_units`)).data.find((u: any) => u.id === "token")
  : null;
const polAgain = await run(CATALOG, [creditsFile, "--json"], keyEnv);
checks.push([
  "catalog: the three unit fields apply, and the next run changes nothing",
  Number(polUnit?.overage_minor_per_unit) === 0.5 &&
    polUnit?.overdraft_limit === 20 &&
    polUnit?.negative_balance_at_reset === "forgive" &&
    JSON.parse(polAgain.out).result === "nothing to change",
]);

// ——— catalog: tax regions, coupons, coupon sets and business settings ———————————————
const shopName = `Skill Settings ${crypto.randomUUID().slice(0, 8)}`;
const GSTIN = "29AAAAA0000A1Z5";
const shop = {
  business: { name: shopName, default_currency: "INR" },
  products: [{ id: "report", name: "Report", kind: "charge" }],
  prices: [
    {
      id: "report-inr",
      product: "report",
      type: "one_time",
      model: "flat",
      currency: "INR",
      amount_minor: 9900,
      tax_behavior: "exclusive",
    },
  ],
  tax_regions: [
    {
      country: "IN",
      regime: "gst",
      home_state_code: "KA",
      registration_number: GSTIN,
      components: [
        { name: "CGST", rate_bps: 900, applies_to: "intra" },
        { name: "SGST", rate_bps: 900, applies_to: "intra" },
        { name: "IGST", rate_bps: 1800, applies_to: "inter" },
      ],
    } as Record<string, unknown>,
  ],
  coupons: [
    {
      code: "FREE100",
      name: "Launch",
      kind: "percentage",
      percent_off_bps: 10000,
      duration_type: "once",
      max_redemptions: 100,
      // Read back from the LIST route; a field missing there never reports "Nothing to change".
      max_redemptions_per_customer: 1,
      per_customer_limit_by: "email",
    },
    { code: "SAVE10", kind: "percentage", percent_off_bps: 1000, duration_type: "forever" },
  ] as Array<Record<string, unknown>>,
  coupon_sets: [{ id: "launch-codes", coupon: "FREE100", name: "Launch codes", count: 5 }] as Array<
    Record<string, unknown>
  >,
  settings: {
    allow_customer_coupons: true,
    tax_registration_number: GSTIN,
    address: {
      line1: "1 Market Road",
      city: "Bengaluru",
      state_code: "KA",
      postal_code: "560001",
      country: "IN",
    },
    billing_rules_config: {
      zero_invoice_paid_event: "one_off",
      plan_credits: { on_upgrade: "prorated" },
    } as Record<string, unknown>,
    credit_config: { blocking_enabled: true } as Record<string, unknown>,
  },
};
const shopFile = join(tmp, "shop.catalog.json");
const writeShop = (c: unknown) => writeFileSync(shopFile, JSON.stringify(c));
writeShop(shop);
const sPlan = await run(CATALOG, [shopFile], keyEnv);
checks.push([
  "catalog: the plan shows the tax region with its components, the coupons, the set and the settings",
  sPlan.code === 0 &&
    sPlan.out.includes(
      `+ tax region IN (gst, exclusive, home state KA, registration ${GSTIN}): CGST 9% intra, SGST 9% intra, IGST 18% inter`,
    ) &&
    sPlan.out.includes(
      "+ coupon FREE100 (100% off, once, max 100 redemptions, max 1 per customer)",
    ) &&
    sPlan.out.includes("+ coupon SAVE10 (10% off, forever)") &&
    sPlan.out.includes("+ coupon set launch-codes (5 codes for coupon FREE100)") &&
    sPlan.out.includes("~ setting allow_customer_coupons true") &&
    sPlan.out.includes('~ setting billing_rules_config.plan_credits.on_upgrade "prorated"'),
]);
const sApplied = await run(CATALOG, [shopFile, "--apply"], keyEnv);
const shopBiz = (await api("GET", "/v1/businesses")).data.find((b: any) => b.name === shopName);
const SHOP = `/v1/businesses/${shopBiz?.id}`;
const shopRow = shopBiz ? await api("GET", SHOP) : {};
const region = shopBiz ? (await api("GET", `${SHOP}/tax_regions`)).data[0] : {};
const free = shopBiz ? await api("GET", `${SHOP}/coupons/FREE100`) : {};
checks.push([
  "catalog: --apply creates the tax region, the coupons and the set, and sets the settings",
  sApplied.code === 0 &&
    region?.regime === "gst" &&
    region?.home_state_code === "KA" &&
    region?.components?.length === 3 &&
    free.percent_off_bps === 10000 &&
    shopRow.allow_customer_coupons === true &&
    shopRow.tax_registration_number === GSTIN &&
    shopRow.address?.city === "Bengaluru" &&
    shopRow.billing_rules_config?.zero_invoice_paid_event === "one_off" &&
    shopRow.billing_rules_config?.plan_credits?.on_upgrade === "prorated" &&
    shopRow.credit_config?.blocking_enabled === true,
]);
const sAgain = await run(CATALOG, [shopFile, "--json"], keyEnv);
checks.push([
  'catalog: a second run over tax, coupons and settings → "Nothing to change"',
  sAgain.code === 0 && JSON.parse(sAgain.out).result === "nothing to change",
]);
const shopEdit = structuredClone(shop);
Object.assign(shopEdit.coupons[0]!, { name: "Launch week", max_redemptions: 200 });
shopEdit.tax_regions[0]!.components = [
  { name: "CGST", rate_bps: 600, applies_to: "intra" },
  { name: "SGST", rate_bps: 600, applies_to: "intra" },
  { name: "IGST", rate_bps: 1200, applies_to: "inter" },
];
shopEdit.coupon_sets[0]!.count = 8;
shopEdit.settings.billing_rules_config.mid_term_coupons = "unbilled_and_edits";
shopEdit.settings.credit_config.in_flight_share_bps = 10000;
(shopEdit.settings as Record<string, unknown>).dunning_config = { dun_one_time_invoices: true };
writeShop(shopEdit);
const sEdit = await run(CATALOG, [shopFile], keyEnv);
checks.push([
  "catalog: changed coupon caps, tax rates, set size and settings plan as old → new",
  sEdit.code === 0 &&
    sEdit.out.includes(
      '~ coupon FREE100: name "Launch" → "Launch week"; max_redemptions 100 → 200',
    ) &&
    sEdit.out.includes(
      "~ tax region IN: components CGST 9% intra, SGST 9% intra, IGST 18% inter → CGST 6% intra, SGST 6% intra, IGST 12% inter",
    ) &&
    sEdit.out.includes("~ coupon set launch-codes: count 5 → 8 (3 new codes)") &&
    /~ setting billing_rules_config\.mid_term_coupons "\w+" → "unbilled_and_edits"/.test(
      sEdit.out,
    ) &&
    sEdit.out.includes("~ setting credit_config.in_flight_share_bps null → 10000") &&
    /~ setting dunning_config\.dun_one_time_invoices \S+ → true/.test(sEdit.out),
]);
const sEditApplied = await run(CATALOG, [shopFile, "--apply"], keyEnv);
const shopRow2 = shopBiz ? await api("GET", SHOP) : {};
const set2 = shopBiz ? await api("GET", `${SHOP}/coupon_sets/launch-codes`) : {};
const sEditAgain = await run(CATALOG, [shopFile, "--json"], keyEnv);
checks.push([
  "catalog: --apply makes the edits, keeps the other credit_config keys, and the next run changes nothing",
  sEditApplied.code === 0 &&
    set2.total_count === 8 &&
    shopRow2.billing_rules_config?.mid_term_coupons === "unbilled_and_edits" &&
    shopRow2.billing_rules_config?.zero_invoice_paid_event === "one_off" &&
    shopRow2.credit_config?.in_flight_share_bps === 10000 &&
    shopRow2.credit_config?.blocking_enabled === true &&
    shopRow2.dunning_config?.dun_one_time_invoices === true &&
    JSON.parse(sEditAgain.out).result === "nothing to change",
]);
const shopArchive = structuredClone(shopEdit);
shopArchive.coupons[0]!.archived = true;
shopArchive.tax_regions[0]!.archived = true;
shopArchive.coupon_sets[0]!.archived = true;
writeShop(shopArchive);
const sArchive = await run(CATALOG, [shopFile, "--apply"], keyEnv);
const freeAfter = shopBiz ? await api("GET", `${SHOP}/coupons/FREE100`) : {};
const regionAfter = shopBiz ? (await api("GET", `${SHOP}/tax_regions`)).data[0] : {};
const setAfter = shopBiz ? await api("GET", `${SHOP}/coupon_sets/launch-codes`) : {};
const sArchiveAgain = await run(CATALOG, [shopFile, "--json"], keyEnv);
checks.push([
  "catalog: archived: true archives the coupon, the tax region and the set; nothing is deleted",
  sArchive.code === 0 &&
    sArchive.out.includes("~ coupon FREE100: archive") &&
    sArchive.out.includes("~ tax region IN: archive") &&
    sArchive.out.includes("~ coupon set launch-codes: archive") &&
    freeAfter.status === "archived" &&
    regionAfter?.enabled === false &&
    !!setAfter.archived_at &&
    JSON.parse(sArchiveAgain.out).result === "nothing to change",
]);
// A redemption freezes the discount.
if (shopBiz) {
  const redeemer = await api("POST", `${SHOP}/customers`, { email: "coupon-lock@example.com" });
  await api("POST", `${SHOP}/customers/${redeemer.id}/discounts`, { coupon: "SAVE10" });
}
const reprice = structuredClone(shopArchive);
reprice.coupons[1]!.percent_off_bps = 2000;
writeShop(reprice);
const sConflict = await run(CATALOG, [shopFile, "--apply"], keyEnv);
const save10 = shopBiz ? await api("GET", `${SHOP}/coupons/SAVE10`) : {};
checks.push([
  "catalog: a new discount on a redeemed coupon is a CONFLICT, exit 2, nothing applied",
  sConflict.code === 2 &&
    sConflict.out.includes(
      "! CONFLICT coupon SAVE10: percent_off_bps is 1000, file says 2000 (redeemed 1 time(s)",
    ) &&
    save10.percent_off_bps === 1000,
]);
writeShop({ ...shop, settings: { not_a_setting: true } });
const badSetting = await run(CATALOG, [shopFile], keyEnv);
checks.push([
  "catalog: a settings key the script does not manage → exit 1, names the keys it does",
  badSetting.code === 1 && badSetting.out.includes("settings.not_a_setting is not a setting"),
]);

// ——— register-webhook ———————————————————————————————————————————————————————————
const appEnv = join(tmp, "app.env");
writeFileSync(appEnv, "OTHER=1");
const regArgs = [
  "--url",
  "https://hooks.example.com/billing",
  "--business",
  cbiz?.id ?? "",
  "--events",
  "invoice_paid,payment_failed",
  "--env-file-out",
  appEnv,
];
checks.push([
  "register-webhook: refuses a live key",
  (await run(REGISTER, regArgs, { TMBILLING_API_KEY: liveKey })).code === 3,
]);
checks.push([
  "register-webhook: refuses plain http to a public host",
  (await run(REGISTER, ["--url", "http://hooks.example.com/x", ...regArgs.slice(2)], keyEnv))
    .code === 1,
]);
const reg = await run(REGISTER, regArgs, keyEnv);
const written = readFileSync(appEnv, "utf8");
const secret = /^TMBILLING_WEBHOOK_SECRET=(.+)$/m.exec(written)?.[1] ?? "";
const regId = /^endpoint\s+(\S+)/m.exec(reg.out)?.[1];
checks.push([
  "register-webhook: creates the endpoint and appends the secret to the env file",
  reg.code === 0 &&
    !!regId &&
    secret.length > 8 &&
    written.startsWith("OTHER=1\nTMBILLING_WEBHOOK_SECRET=") &&
    reg.out.includes("invoice_paid, payment_failed"),
]);
checks.push(["register-webhook: never prints the secret", !!secret && !reg.out.includes(secret)]);
checks.push([
  "register-webhook: a second run is refused (exit 2), the file is unchanged",
  (await run(REGISTER, regArgs, keyEnv)).code === 2 && readFileSync(appEnv, "utf8") === written,
]);
const repo = join(tmp, "repo");
mkdirSync(repo);
writeFileSync(join(repo, ".env"), "OTHER=1\n");
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["add", ".env"], { cwd: repo });
const trackedRun = await run(REGISTER, [...regArgs.slice(0, -1), join(repo, ".env")], keyEnv);
checks.push([
  "register-webhook: a git-tracked env file is refused (exit 2)",
  trackedRun.code === 2 && trackedRun.out.includes("tracked by git"),
]);
if (regId) await api("DELETE", `/v1/webhook_endpoints/${regId}`);

// ——— money-check --session on a one-time purchase ——————————————————————————————————
await clearPublicRateLimits();
// A 10% sales tax, so the tax lines have something to compare.
const [cbizRow] = await systemDb
  .select({ id: businesses.id })
  .from(businesses)
  .where(eq(businesses.publicId, cbiz.id));
await createFlatTaxRate({
  organizationId: organization.id,
  businessId: cbizRow!.id,
  name: "Sales tax",
  country: "US",
  rateBps: 1000,
});
const mintPurchase = () =>
  api("POST", `/v1/businesses/${cbiz.id}/checkout_sessions`, {
    price: "credit-pack-usd",
    mode: "purchase",
    metadata: { order_id: "1042" },
  });
const buyer = async (token: string, path: string, body: unknown) => {
  const res = await fetch(`${URL_}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const purchase = await mintPurchase();
await buyer(purchase.token, "/checkout/v1/customer", {
  email: "skill-buyer@example.com",
  address: {
    line1: "1 Market St",
    city: "San Francisco",
    state: "California",
    state_code: "CA",
    postal_code: "94105",
    country: "US",
    first_name: "Ria",
    last_name: "Buyer",
  },
});
// The test gateway answers Pay with its Approve/Decline dialog; approve, as the page does.
const leg1 = await buyer(purchase.token, "/checkout/v1/complete", {});
const paid =
  leg1.status === 402
    ? await buyer(purchase.token, "/checkout/v1/complete", {
        payment_intent: leg1.body.payment_intent?.id,
        client_result: { nonce: "tmtest_ok" },
      })
    : leg1;
const packExpected = join(tmp, "pack.json");
writeFileSync(
  packExpected,
  JSON.stringify({
    currency: "USD",
    total_minor: 2750,
    status: "paid",
    lines: [{ price: "credit-pack-usd", amount_minor: 2500 }],
    taxes: [{ name: "Sales tax", rate_bps: 1000, amount_minor: 250 }],
    metadata: { order_id: "1042" },
  }),
);
const sessionEnv = { TMBILLING_API_KEY: testKey, TMBILLING_BUSINESS_ID: cbiz.id };
const bySession = await run(
  MONEY,
  ["--expected", packExpected, "--session", purchase.id],
  sessionEnv,
);
checks.push([
  "money-check --session: a completed purchase matches its invoice",
  paid.status === 201 &&
    bySession.code === 0 &&
    bySession.out.includes(`MATCH: invoice ${paid.body.invoice_id}`),
]);
const writeExpected = (name: string, patch: object) => {
  const file = join(tmp, name);
  writeFileSync(
    file,
    JSON.stringify({ ...JSON.parse(readFileSync(packExpected, "utf8")), ...patch }),
  );
  return file;
};
const wrongTax = await run(
  MONEY,
  [
    "--expected",
    writeExpected("tax.json", { taxes: [{ name: "Sales tax", amount_minor: 200 }] }),
    "--session",
    purchase.id,
  ],
  sessionEnv,
);
checks.push([
  "money-check: a tax line that differs → exit 2, names the line",
  wrongTax.code === 2 && /DIFF\s+taxes\[0\] Sales tax amount_minor/.test(wrongTax.out),
]);
const missingTax = await run(
  MONEY,
  ["--expected", writeExpected("notax.json", { taxes: [] }), "--session", purchase.id],
  sessionEnv,
);
checks.push([
  "money-check: a tax line the file does not list → exit 2",
  missingTax.code === 2 && /DIFF\s+taxes count/.test(missingTax.out),
]);
const wrongMeta = await run(
  MONEY,
  [
    "--expected",
    writeExpected("meta.json", { metadata: { order_id: "999" } }),
    "--session",
    purchase.id,
  ],
  sessionEnv,
);
checks.push([
  "money-check: metadata that differs → exit 2",
  wrongMeta.code === 2 && /DIFF\s+metadata\.order_id/.test(wrongMeta.out),
]);
const open = await mintPurchase();
const openRun = await run(MONEY, ["--expected", packExpected, "--session", open.id], sessionEnv);
checks.push([
  "money-check --session: a session not yet completed → exit 1, says so",
  openRun.code === 1 && openRun.out.includes("has no invoice yet"),
]);

await app.close();
await closeDb();
let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
if (!pass)
  for (const [n, r] of Object.entries({
    first,
    adv,
    renewal,
    audit,
    plan,
    applied,
    again,
    conflict,
    sPlan,
    sApplied,
    sEdit,
    sEditApplied,
    sArchive,
    sConflict,
    reg,
    trackedRun,
    bySession,
    wrongTax,
    missingTax,
    wrongMeta,
    openRun,
  }))
    console.log(`--- ${n}\n${r.out}`);
console.log(pass ? "✅ AGENT SKILL SCRIPTS: PASS" : "❌ AGENT SKILL SCRIPTS: FAIL");
process.exit(pass ? 0 : 1);
