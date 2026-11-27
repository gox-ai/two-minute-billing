/**
 * File imports (0550): upload → check → start → results → undo, through the HTTP routes.
 * The jobs are called directly; no worker is needed.
 *  a templates: CSV and JSON; every entity
 *  b upload maps common header names automatically; the check stores a summary
 *  c per-cell errors with the file's column name; the errors file; blockers stop a start
 *  d leaving out invalid rows leaves out the rows that need them
 *  e the run: records created with the file's ids, nothing charged, cards bound to the
 *    connected gateway, a warning for a gateway that is not connected
 *  f a second upload of the same rows is "existing"; nothing new is a blocker
 *  g a subscription can use a price that is in the business already (adopted, never undone)
 *  h renewal dates: past is an error; within 24 hours is a warning, or left out on request
 *  i a live business needs its name to start
 *  j undo: refused after an operator change; deletes only what the run created
 *  k one active run per business
 *  l permissions, tenancy, audit
 *  m a JSON file imports
 *  n test-business limits block the start
 *  o history: invoices, payments and a refund, a credit note, usage; open invoices are owed and
 *    not collected unless asked; undo reverses the opening ledger entries and deletes the rest
 *
 *   pnpm verify:bulk-import
 */
import { and, eq, inArray } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createBusiness } from "@/modules/tenancy/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { createMeter } from "@/modules/metering/meters";
import { signup, inviteUser, acceptInvite } from "@/modules/auth/service";
import { runCheckJob, runImportJob, runUndoJob } from "@/modules/bulk-import/runner";
import { buildApp } from "@/index";
import { setMailer } from "@/providers/mailer";
import { pinMfaMandateOff } from "./lib/mfa-policy";
import {
  auditLogs,
  authTokens,
  businesses,
  creditNotes,
  customers,
  ledgerEntries,
  refunds,
  transactions,
  usageRecords,
  gatewayAccounts,
  importRecords,
  importRuns,
  invoices,
  paymentMethods,
  payments,
  prices,
  subscriptions,
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
  checks.push([
    n,
    c,
    typeof detail === "string"
      ? detail
      : JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? String(v) : v)),
  ]);

// ── fixture ────────────────────────────────────────────────────────────────────
const PW = "Correct-Horse-Battery-9";
const uniq = randomBytes(4).toString("hex");
const em = (r: string) => `bulk-import-${r}-${uniq}@example.com`;
const owner = await signup({
  email: em("owner"),
  password: PW,
  organizationName: `Bulk Import ${uniq}`,
});
const orgId = owner.user.organizationId;
const live = await createBusiness({
  organizationId: orgId,
  name: "Lantern Labs",
  defaultCurrency: "USD",
  livemode: "live",
});
const [test] = await withTenant(orgId, (tx) =>
  tx.select().from(businesses).where(eq(businesses.liveBusinessId, live.id)),
);
if (!test) throw new Error("fixture: no test twin");
const T = { organizationId: orgId, businessId: test.id };

// A price made in the dashboard before any import.
const native = await createProduct({ ...T, name: "Legacy", id: "legacy", kind: "plan" });
await createPrice({
  ...T,
  productId: native.id,
  id: "legacy-usd-m",
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 2900,
  interval: "month",
});

const app = await buildApp({ logger: false });
type Auth = { cookie?: string; bearer?: string };
const authHeaders = (a: Auth) =>
  a.cookie ? { cookie: `tmb_session=${a.cookie}` } : { authorization: `Bearer ${a.bearer}` };
const OWNER: Auth = { cookie: owner.token };
const baseOf = (biz: string) => `/v1/businesses/${biz}/imports`;
const post = (biz: string, path: string, payload: object, auth: Auth = OWNER) =>
  app.inject({
    method: "POST",
    url: `${baseOf(biz)}${path}`,
    headers: { ...authHeaders(auth), "idempotency-key": randomBytes(8).toString("hex") },
    payload,
  });
const get = (biz: string, path: string, auth: Auth = OWNER) =>
  app.inject({ method: "GET", url: `${baseOf(biz)}${path}`, headers: authHeaders(auth) });

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const csv = (rows: string[][]) =>
  rows
    .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\n");

const upload = async (
  biz: string,
  files: Array<{ entity: string; filename?: string; content: string }>,
  extra: object = {},
) => {
  const res = await post(biz, "", {
    files: files.map((f) => ({ filename: `${f.entity}.csv`, ...f })),
    ...extra,
  });
  const body = res.json();
  if (res.statusCode === 201) await runCheckJob(body.id);
  return { res, id: body.id as string };
};
const view = async (biz: string, id: string) => (await get(biz, `/${id}`)).json();

// ── a: templates ───────────────────────────────────────────────────────────────
{
  const res = await get(test.publicId, "/templates/subscriptions");
  const text = res.body;
  ok(
    "a: subscriptions template is CSV with the required columns",
    res.statusCode === 200 && /^"subscription_id","customer_id","price_id"/.test(text),
    text.slice(0, 120),
  );
  const json = (await get(test.publicId, "/templates/customers?format=json")).json();
  ok(
    "a: JSON template lists fields with help",
    json.fields?.some(
      (f: { key: string; required: boolean }) => f.key === "customer_id" && f.required,
    ),
    json,
  );
  ok(
    "a: unknown template is 404",
    (await get(test.publicId, "/templates/refunds")).statusCode === 404,
  );
}

// ── b–e: a first import ────────────────────────────────────────────────────────
const plansCsv = csv([
  [
    "Plan ID",
    "Price ID",
    "Plan Name",
    "Pricing Model",
    "Price",
    "Currency",
    "Period Unit",
    "Trial Period Days",
    "Tiers",
  ],
  ["pro", "pro-usd-m", "Pro", "flat", "49.00", "USD", "month", "14", ""],
  ["pro", "pro-usd-y", "Pro", "flat", "490.00", "USD", "year", "", ""],
  ["team", "team-usd-m", "Team", "tiered", "", "USD", "month", "", "10:5.00|inf:4.00"],
  ["bad", "bad-usd-m", "Bad", "flat", "12.345", "USD", "month", "", ""],
]);
const customersCsv = csv([
  [
    "customers.id",
    "Email Address",
    "customers.first_name",
    "customers.last_name",
    "Country",
    "Gateway",
    "Gateway Customer ID",
    "Card ID",
    "Card Brand",
    "Last4",
  ],
  [
    "cust-a",
    "ana@example.com",
    "Ana",
    "Silva",
    "US",
    "tmtest",
    "tmcus_XXXXXXXX01",
    "tmpm_XXXXXXXX01",
    "visa",
    "4242",
  ],
  [
    "cust-b",
    "ben@example.com",
    "Ben",
    "Okafor",
    "GB",
    "stripe",
    "cus_XXXXXXXXXXXX02",
    "pm_XXXXXXXXXXXX02",
    "visa",
    "1111",
  ],
  ["cust-c", "not-an-email", "Cy", "Park", "US", "", "", "", "", ""],
  ["cust-d", "dee@example.com", "Dee", "", "US", "", "", "", "", ""],
]);
const subsCsv = csv([
  ["id", "Customer ID", "Plan", "Quantity", "Status", "Current Period End (UTC)", "Coupon"],
  ["sub-a", "cust-a", "pro-usd-m", "1", "active", day(10), ""],
  ["sub-b", "cust-b", "team-usd-m", "12", "active", day(20), ""],
  ["sub-c", "cust-c", "pro-usd-m", "1", "active", day(5), ""],
  ["sub-d", "cust-d", "legacy-usd-m", "1", "active", day(15), ""],
  ["sub-e", "cust-zzz", "pro-usd-m", "1", "active", day(15), ""],
  ["sub-f", "cust-d", "bad-usd-m", "1", "active", day(15), ""],
]);
const first = await upload(test.publicId, [
  { entity: "plans", content: plansCsv },
  { entity: "customers", content: customersCsv },
  { entity: "subscriptions", content: subsCsv },
]);
ok(
  "b: upload is 201 and queues the check",
  first.res.statusCode === 201 && first.res.json().status === "checking",
  first.res.body.slice(0, 300),
);
let run = await view(test.publicId, first.id);
const custMap = run.files?.find((f: { entity: string }) => f.entity === "customers")?.mapping ?? {};
ok(
  "b: prefixed and spaced headers map automatically",
  custMap["customers.id"] === "customer_id" &&
    custMap["Email Address"] === "email" &&
    custMap["customers.first_name"] === "first_name" &&
    custMap["Card ID"] === "gateway_payment_method_id",
  custMap,
);
const subMap =
  run.files?.find((f: { entity: string }) => f.entity === "subscriptions")?.mapping ?? {};
ok(
  "b: '(UTC)' columns and 'Plan' map",
  subMap["Current Period End (UTC)"] === "current_term_end" && subMap.Plan === "price_id",
  subMap,
);
ok(
  "b: the check ends 'checked' with a summary",
  run.status === "checked" && !!run.summary,
  run.status,
);

// c: errors
{
  const rows = (await get(test.publicId, `/${first.id}/rows?state=invalid`)).json().data as Array<{
    entity: string;
    source_id: string;
    errors: Array<{ column: string; message: string }>;
  }>;
  const by = (id: string) => rows.find((r) => r.source_id === id);
  ok(
    "c: too many decimals is a cell error on the Price column",
    by("bad-usd-m")?.errors.some((e) => e.column === "Price") === true,
    by("bad-usd-m"),
  );
  ok(
    "c: a bad email is a cell error",
    by("cust-c")?.errors.some((e) => e.column === "Email Address") === true,
    by("cust-c"),
  );
  ok(
    "c: an unknown customer is an error on the subscription",
    by("sub-e")?.errors.some((e) => /no customer/i.test(e.message)) === true,
    by("sub-e"),
  );
  ok(
    "c: invalid_rows blocks the start",
    run.summary.blockers.some((b: { code: string }) => b.code === "invalid_rows") &&
      run.summary.ready === false,
    run.summary.blockers,
  );
  const start = await post(test.publicId, `/${first.id}/start`, {});
  ok(
    "c: start with blockers is 409 with reasons",
    start.statusCode === 409 && start.json().error.reasons?.length > 0,
    start.body.slice(0, 300),
  );
  const file = await get(test.publicId, `/${first.id}/files/customers`);
  ok(
    "c: the errors file adds import_errors with the message",
    file.statusCode === 200 &&
      file.body.split("\r\n")[0]!.endsWith('"import_errors"') &&
      /Enter a valid email address/.test(file.body),
    file.body.slice(0, 400),
  );
}

// d: leave out invalid rows
{
  const res = await post(test.publicId, `/${first.id}/check`, {
    options: { skip_invalid_rows: true },
  });
  ok("d: re-check is 202", res.statusCode === 202, res.body.slice(0, 200));
  await runCheckJob(first.id);
  run = await view(test.publicId, first.id);
  const excluded = (await get(test.publicId, `/${first.id}/rows?state=excluded`)).json()
    .data as Array<{ source_id: string }>;
  ok(
    "d: rows that need an invalid row are left out",
    excluded.some((r) => r.source_id === "sub-c") && excluded.some((r) => r.source_id === "sub-f"),
    excluded,
  );
  ok("d: now ready", run.summary.ready === true, run.summary.blockers);
  ok(
    "d: the payment check names the gateway that is not connected",
    run.summary.payment.gateways_not_connected.includes("stripe") &&
      run.summary.warnings.some((w: { code: string }) => w.code === "gateway_not_connected"),
    run.summary.payment,
  );
  const usd = run.summary.mrr.find((m: { currency: string }) => m.currency === "USD")?.amount_minor;
  // a: 4900; b: tiered 10×500 + 2×400 = 5800; d: 2900.
  ok("d: MRR counts flat, tiered and existing prices", usd === 4900 + 5800 + 2900, run.summary.mrr);
}

// e: the run
{
  const res = await post(test.publicId, `/${first.id}/start`, {});
  ok(
    "e: start on a test business needs no name: 202",
    res.statusCode === 202 && res.json().status === "queued",
    res.body.slice(0, 200),
  );
  const out = await runImportJob(first.id);
  run = await view(test.publicId, first.id);
  ok("e: the run succeeds", out === "succeeded" && run.status === "succeeded", {
    out,
    status: run.status,
    error: run.error,
    result: run.result,
  });
  const subs = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.businessId, test.id)),
  );
  const subA = subs.find((s) => s.publicId === "sub-a");
  ok(
    "e: subscriptions keep the file's ids",
    ["sub-a", "sub-b", "sub-d"].every((id) => subs.some((s) => s.publicId === id)) &&
      !subs.some((s) => s.publicId === "sub-c"),
    subs.map((s) => s.publicId),
  );
  ok(
    "e: the first renewal is the term end",
    subA?.currentPeriodEnd?.toISOString().slice(0, 10) === day(10),
    subA?.currentPeriodEnd,
  );
  const custIds = (
    await withTenant(orgId, (tx) =>
      tx.select({ id: customers.id }).from(customers).where(eq(customers.businessId, test.id)),
    )
  ).map((c) => c.id);
  const inv = await withTenant(orgId, (tx) =>
    tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.businessId, test.id)),
  );
  const pay = custIds.length
    ? await withTenant(orgId, (tx) =>
        tx.select({ id: payments.id }).from(payments).where(inArray(payments.customerId, custIds)),
      )
    : [];
  ok(
    "e: nothing is charged: no invoice, no payment",
    inv.length === 0 && pay.length === 0 && run.result?.charges === 0,
    { inv: inv.length, pay: pay.length },
  );
  const pms = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.businessId, test.id)),
  );
  const [tmAcct] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(gatewayAccounts)
      .where(
        and(eq(gatewayAccounts.businessId, test.id), eq(gatewayAccounts.gatewayKey, "tmtest")),
      ),
  );
  ok(
    "e: the tmtest card is bound to the connected account",
    pms.find((p) => p.providerPaymentMethodId === "tmpm_XXXXXXXX01")?.gatewayAccountId ===
      tmAcct?.id,
    pms.map((p) => [p.providerKey, p.gatewayAccountId]),
  );
  ok(
    "e: the stripe card is kept, unbound",
    pms.some((p) => p.providerKey === "stripe" && p.gatewayAccountId == null),
  );
  const results = (
    await get(test.publicId, `/${first.id}/rows?outcome=created&entity=subscriptions`)
  ).json().data;
  ok(
    "e: rows carry their outcome",
    results.length === 3,
    results.map((r: { source_id: string }) => r.source_id),
  );
  // File order, also across pages: ids are uuid v7 and random within one insert.
  const all = (await get(test.publicId, `/${first.id}/rows`)).json().data as Array<{
    id: string;
    entity: string;
    row_number: number;
  }>;
  const key = (r: { entity: string; row_number: number }) =>
    `${r.entity}:${String(r.row_number).padStart(6, "0")}`;
  const sorted = [...all].sort((a, b) => key(a).localeCompare(key(b)));
  const paged: typeof all = [];
  for (let after: string | undefined; ;) {
    const page = (
      await get(
        test.publicId,
        `/${first.id}/rows?limit=2${after ? `&starting_after=${after}` : ""}`,
      )
    ).json();
    paged.push(...page.data);
    if (!page.has_more) break;
    after = page.data[page.data.length - 1].id;
  }
  ok(
    "e: rows come in file order, and paging keeps it",
    all.length > 2 &&
      all.map(key).join() === sorted.map(key).join() &&
      paged.map(key).join() === sorted.map(key).join(),
    all.map(key),
  );
  const file = await get(test.publicId, `/${first.id}/files/subscriptions`);
  ok(
    "e: the results file adds import_result",
    /"import_result"/.test(file.body.split("\r\n")[0]!) && /excluded/.test(file.body),
    file.body.slice(0, 300),
  );
  ok(
    "e: the member who started it gets one email",
    sent.filter((m) => m.to === em("owner") && /import into/.test(m.subject)).length === 1,
    sent,
  );
}

// f: same rows again
{
  const again = await upload(test.publicId, [
    { entity: "customers", content: customersCsv.split("\n").slice(0, 2).join("\n") },
  ]);
  const v = await view(test.publicId, again.id);
  ok(
    "f: an imported row is 'existing'",
    v.summary.entities.customers.existing === 1,
    v.summary.entities,
  );
  ok(
    "f: nothing new is a blocker",
    v.summary.blockers.some((b: { code: string }) => b.code === "nothing_new"),
    v.summary.blockers,
  );
  const d = await post(test.publicId, `/${again.id}/discard`, {});
  ok(
    "f: discard an unstarted import",
    d.statusCode === 200 && d.json().status === "discarded",
    d.body.slice(0, 200),
  );
}

// g: the native price is adopted, never owned by the run
{
  const rec = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(importRecords)
      .where(
        and(eq(importRecords.businessId, test.id), eq(importRecords.sourceId, "legacy-usd-m")),
      ),
  );
  ok(
    "g: an existing price gets an import record without a run",
    rec.length === 1 && rec[0]!.runId === null,
    rec,
  );
}

// h: renewal dates
{
  const soon = new Date(Date.now() + 6 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const past = day(-2);
  const subs = csv([
    ["subscription_id", "customer_id", "price_id", "current_term_end"],
    ["sub-soon", "cust-a", "pro-usd-y", soon],
    ["sub-past", "cust-a", "pro-usd-y", past],
  ]);
  const r = await upload(test.publicId, [{ entity: "subscriptions", content: subs }]);
  let v = await view(test.publicId, r.id);
  const rows = (await get(test.publicId, `/${r.id}/rows`)).json().data as Array<{
    source_id: string;
    state: string;
    errors: unknown[];
  }>;
  ok(
    "h: a past renewal date is an error",
    rows.find((x) => x.source_id === "sub-past")?.state === "invalid",
    rows,
  );
  ok(
    "h: a renewal within 24 hours is a warning",
    v.summary.renewals.within_24h === 1 &&
      v.summary.warnings.some((w: { code: string }) => w.code === "renews_within_24h"),
    v.summary.renewals,
  );
  await post(test.publicId, `/${r.id}/check`, {
    options: { skip_invalid_rows: true, exclude_renewing_within_24h: true },
  });
  await runCheckJob(r.id);
  v = await view(test.publicId, r.id);
  ok(
    "h: left out on request; then nothing new",
    (await get(test.publicId, `/${r.id}/rows?state=excluded`)).json().data.length === 1 &&
      v.summary.blockers.some((b: { code: string }) => b.code === "nothing_new"),
    v.summary,
  );
  await post(test.publicId, `/${r.id}/discard`, {});
}

// i: live needs the name; k: one active run
{
  const r = await upload(live.publicId, [
    {
      entity: "plans",
      content: csv([
        ["price_id", "name", "amount", "currency", "interval"],
        ["live-usd-m", "Live", "10.00", "USD", "month"],
      ]),
    },
  ]);
  const v = await view(live.publicId, r.id);
  ok("i: a live check is ready", v.summary?.ready === true, v.summary);
  const wrong = await post(live.publicId, `/${r.id}/start`, { confirm: "Lantern" });
  ok("i: a wrong name is 400", wrong.statusCode === 400, wrong.body.slice(0, 200));
  const right = await post(live.publicId, `/${r.id}/start`, { confirm: "Lantern Labs" });
  ok("i: the name starts it", right.statusCode === 202, right.body.slice(0, 200));
  const r2 = await upload(live.publicId, [
    {
      entity: "plans",
      content: csv([
        ["price_id", "name", "amount", "currency", "interval"],
        ["live2-usd-m", "Live 2", "10.00", "USD", "month"],
      ]),
    },
  ]);
  const busy = await post(live.publicId, `/${r2.id}/start`, { confirm: "Lantern Labs" });
  ok(
    "k: a second start while one is queued is 409",
    busy.statusCode === 409,
    busy.body.slice(0, 200),
  );
  await runImportJob(r.id);
  ok("i: the live run succeeds", (await view(live.publicId, r.id)).status === "succeeded");
}

// j: undo
{
  // An operator change blocks the undo.
  await withTenant(orgId, (tx) =>
    tx
      .update(customers)
      .set({ updatedAt: new Date(Date.now() + 3600_000) })
      .where(and(eq(customers.businessId, test.id), eq(customers.publicId, "cust-a"))),
  );
  let v = await view(test.publicId, first.id);
  ok(
    "j: the run shows what blocks an undo",
    v.undo_blockers?.some((b: { code: string }) => b.code === "changed_customers"),
    v.undo_blockers,
  );
  const refused = await post(test.publicId, `/${first.id}/undo`, {});
  ok(
    "j: undo is refused with reasons",
    refused.statusCode === 409 && refused.json().error.reasons?.length > 0,
    refused.body.slice(0, 300),
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(customers)
      .set({ updatedAt: new Date(Date.now() - 3600_000) })
      .where(and(eq(customers.businessId, test.id), eq(customers.publicId, "cust-a"))),
  );
  await withTenant(orgId, (tx) =>
    tx.update(importRuns).set({ finishedAt: new Date() }).where(eq(importRuns.id, first.id)),
  );
  const res = await post(test.publicId, `/${first.id}/undo`, {});
  ok(
    "j: undo is 202",
    res.statusCode === 202 && res.json().status === "undoing",
    res.body.slice(0, 300),
  );
  const out = await runUndoJob(first.id);
  v = await view(test.publicId, first.id);
  ok("j: the run is undone", out === "undone" && v.status === "undone", {
    out,
    v: v.status,
    error: v.error,
  });
  const leftSubs = await withTenant(orgId, (tx) =>
    tx
      .select({ id: subscriptions.publicId })
      .from(subscriptions)
      .where(eq(subscriptions.businessId, test.id)),
  );
  const leftCust = await withTenant(orgId, (tx) =>
    tx.select({ id: customers.publicId }).from(customers).where(eq(customers.businessId, test.id)),
  );
  const leftPrices = await withTenant(orgId, (tx) =>
    tx.select({ id: prices.publicId }).from(prices).where(eq(prices.businessId, test.id)),
  );
  ok(
    "j: what the run created is gone",
    leftSubs.length === 0 &&
      leftCust.length === 0 &&
      !leftPrices.some((p) => p.id.startsWith("pro-")),
    { leftSubs, leftCust, leftPrices },
  );
  ok(
    "j: the price that was there before stays",
    leftPrices.some((p) => p.id === "legacy-usd-m"),
    leftPrices,
  );
  const recs = await withTenant(orgId, (tx) =>
    tx.select().from(importRecords).where(eq(importRecords.runId, first.id)),
  );
  ok("j: the run's import records are gone", recs.length === 0, recs.length);
}

// l: permissions, tenancy, audit
{
  const invited = await inviteUser({ organizationId: orgId, email: em("mgr"), role: "manager" });
  const tok = `invt_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: invited.userId,
    tokenHash: createHash("sha256").update(tok).digest("hex"),
    purpose: "invite",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const mgr: Auth = { cookie: (await acceptInvite(tok, PW)).token };
  const denied = await post(
    test.publicId,
    "",
    { files: [{ entity: "plans", filename: "p.csv", content: "price_id\nx" }] },
    mgr,
  );
  ok("l: a manager cannot upload (403)", denied.statusCode === 403, denied.statusCode);
  const deniedRead = await get(test.publicId, "", mgr);
  ok(
    "l: a manager cannot list imports (403)",
    deniedRead.statusCode === 403,
    deniedRead.statusCode,
  );
  const other = await signup({
    email: em("other"),
    password: PW,
    organizationName: `Other ${uniq}`,
  });
  const otherBiz = await createBusiness({
    organizationId: other.user.organizationId,
    name: "Elsewhere",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const cross = await get(otherBiz.publicId, `/${first.id}`, { cookie: other.token });
  ok(
    "l: another organization cannot read the import (404)",
    cross.statusCode === 404,
    cross.statusCode,
  );
  const audit = await withTenant(orgId, (tx) =>
    tx
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, first.id)),
  );
  const actions = new Set(audit.map((a) => a.action));
  ok(
    "l: upload, start, run and undo are audited",
    ["import.upload", "import.start", "import.run", "import.undo"].every((a) => actions.has(a)),
    [...actions],
  );
}

// m: a JSON file
{
  const json = JSON.stringify({
    plans: [
      { id: "json-basic", name: "Basic", amountMinor: 900, currency: "USD", interval: "month" },
    ],
    customers: [{ id: "json-cust", email: "jo@example.com", name: "Jo Rivera" }],
    subscriptions: [
      {
        id: "json-sub",
        customerId: "json-cust",
        planId: "json-basic",
        currentTermEnd: `${day(9)}T00:00:00Z`,
      },
    ],
  });
  const r = await upload(test.publicId, [
    { entity: "json", filename: "export.json", content: json },
  ]);
  const v = await view(test.publicId, r.id);
  ok(
    "m: a JSON file becomes three checked files",
    v.files.length === 3 && v.summary?.ready === true,
    { files: v.files?.map((f: { entity: string }) => f.entity), s: v.summary?.blockers },
  );
  await post(test.publicId, `/${r.id}/start`, {});
  ok("m: and imports", (await runImportJob(r.id)) === "succeeded");
  const [c] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(customers)
      .where(and(eq(customers.businessId, test.id), eq(customers.publicId, "json-cust"))),
  );
  ok(
    "m: a full name splits into first and last",
    c?.firstName === "Jo" && c?.lastName === "Rivera",
    c,
  );
}

// n: test-business limits
{
  await systemDb.update(businesses).set({ testCustomerLimit: 1 }).where(eq(businesses.id, test.id));
  const r = await upload(test.publicId, [
    {
      entity: "customers",
      content: csv([
        ["customer_id", "email"],
        ["lim-1", "l1@example.com"],
        ["lim-2", "l2@example.com"],
      ]),
    },
  ]);
  const v = await view(test.publicId, r.id);
  ok(
    "n: the limit is a blocker before the run",
    v.summary.blockers.some((b: { code: string }) => b.code === "test_limit_customers"),
    v.summary.blockers,
  );
  await systemDb
    .update(businesses)
    .set({ testCustomerLimit: null })
    .where(eq(businesses.id, test.id));
}

// o: history
{
  const B = test.publicId;
  await createMeter({
    ...T,
    key: `h-calls-${uniq}`,
    definition: { name: `h-calls-${uniq}`, eventName: "calls", aggregation: "count" } as never,
  });
  const api = await createProduct({ ...T, name: "API calls", id: `h-api-${uniq}`, kind: "plan" });
  await createPrice({
    ...T,
    productId: api.id,
    id: "h-api-usd",
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    meter: `h-calls-${uniq}`,
    unitAmountDecimal: "1",
  });
  const historyFiles = [
    {
      entity: "customers",
      content: csv([
        ["customer_id", "email"],
        ["h-c1", em("h1")],
      ]),
    },
    {
      entity: "subscriptions",
      content: csv([
        ["subscription_id", "customer_id", "price_id", "current_term_end"],
        ["h-s1", "h-c1", "legacy-usd-m", day(20)],
        ["h-s1", "h-c1", "h-api-usd", day(20)],
      ]),
    },
    {
      entity: "invoices",
      content: csv([
        [
          "invoice_id",
          "customer_id",
          "subscription_id",
          "number",
          "status",
          "currency",
          "date",
          "due_date",
          "paid_at",
          "total",
          "amount_due",
          "tax",
          "line_description",
          "line_amount",
          "line_price_id",
        ],
        [
          "h-i1",
          "h-c1",
          "h-s1",
          "H-1",
          "paid",
          "USD",
          day(-30),
          "",
          day(-29),
          "53.90",
          "",
          "4.90",
          "Legacy",
          "29.00",
          "legacy-usd-m",
        ],
        [
          "h-i1",
          "h-c1",
          "h-s1",
          "H-1",
          "paid",
          "USD",
          day(-30),
          "",
          day(-29),
          "53.90",
          "",
          "",
          "Seats",
          "20.00",
          "",
        ],
        [
          "h-i2",
          "h-c1",
          "h-s1",
          "H-2",
          "open",
          "USD",
          day(-5),
          day(-1),
          "",
          "29.00",
          "29.00",
          "",
          "Legacy",
          "29.00",
          "legacy-usd-m",
        ],
      ]),
    },
    {
      entity: "payments",
      content: csv([
        [
          "transaction_id",
          "type",
          "customer_id",
          "invoice_id",
          "amount",
          "currency",
          "date",
          "refunded_transaction_id",
        ],
        ["h-p1", "payment", "h-c1", "h-i1", "53.90", "USD", day(-29), ""],
        ["h-r1", "refund", "h-c1", "", "5.00", "USD", day(-25), "h-p1"],
      ]),
    },
    {
      entity: "credit_notes",
      content: csv([
        ["credit_note_id", "invoice_id", "type", "currency", "date", "total", "amount_available"],
        ["h-cn1", "h-i1", "refundable", "USD", day(-20), "10.00", "10.00"],
      ]),
    },
    {
      entity: "usage",
      content: csv([
        ["usage_id", "subscription_id", "price_id", "quantity", "timestamp"],
        ["h-u1", "h-s1", "h-api-usd", "120", `${day(-1)}T10:00:00Z`],
      ]),
    },
  ];
  const r = await upload(B, historyFiles);
  const v = await view(B, r.id);
  ok("o: history files check clean", v.summary?.ready === true, v.summary?.blockers ?? r.res.body);
  ok(
    "o: the review shows the opening receivables and credit",
    JSON.stringify(v.summary?.history?.receivables) ===
      JSON.stringify([{ currency: "USD", amount_minor: 2900 }]) &&
      JSON.stringify(v.summary?.history?.credit) ===
        JSON.stringify([{ currency: "USD", amount_minor: 1000 }]),
    v.summary?.history,
  );
  ok(
    "o: it says the open invoice is not collected",
    v.summary?.warnings?.some((w: { code: string }) => w.code === "open_invoices_not_collected"),
    v.summary?.warnings,
  );
  await post(B, `/${r.id}/start`, {});
  await runImportJob(r.id);
  const done = await view(B, r.id);
  ok("o: the history import succeeds", done.status === "succeeded", {
    status: done.status,
    error: done.error,
    result: done.result,
  });

  const [cust] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(customers)
      .where(and(eq(customers.businessId, test.id), eq(customers.publicId, "h-c1"))),
  );
  const invs = cust
    ? await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.customerId, cust.id)),
      )
    : [];
  const open = invs.find((i) => i.number === "H-2");
  ok(
    "o: two invoices; the open one is owed and not collected",
    invs.length === 2 &&
      open?.status === "payment_due" &&
      Number(open.amountDueMinor) === 2900 &&
      open.dunningStatus === "stopped" &&
      open.nextAttemptAt == null,
    invs.map((i) => ({
      n: i.number,
      s: i.status,
      due: String(i.amountDueMinor),
      d: i.dunningStatus,
      next: i.nextAttemptAt,
    })),
  );
  const pays = cust
    ? await withTenant(orgId, (tx) =>
        tx.select().from(payments).where(eq(payments.customerId, cust.id)),
      )
    : [];
  const refs = pays.length
    ? await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(refunds)
          .where(
            inArray(
              refunds.paymentId,
              pays.map((x) => x.id),
            ),
          ),
      )
    : [];
  const cns = cust
    ? await withTenant(orgId, (tx) =>
        tx.select().from(creditNotes).where(eq(creditNotes.customerId, cust.id)),
      )
    : [];
  const use = await withTenant(orgId, (tx) =>
    tx.select().from(usageRecords).where(eq(usageRecords.businessId, test.id)),
  );
  ok(
    "o: a payment, its refund, a credit note and the usage are imported",
    pays.length === 1 &&
      refs.length === 1 &&
      cns.length === 1 &&
      use.some((u) => Number(u.quantity) === 120),
    {
      pays: pays.length,
      refs: refs.length,
      cns: cns.length,
      use: use.map((u) => String(u.quantity)),
    },
  );
  const docIds = [...invs.map((i) => i.publicId), ...cns.map((c) => c.publicId)];
  const opening = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.businessId, test.id), inArray(ledgerEntries.sourceId, docIds))),
  );
  ok(
    "o: opening entries for the open invoice and the refundable credit only",
    opening.filter((e) => e.sourceType === "import").length === 4 &&
      new Set(opening.map((e) => e.sourceId)).size === 2,
    opening.map((e) => `${e.sourceType} ${e.account} ${e.direction} ${e.amountMinor}`),
  );

  // A change to an imported invoice after the import blocks the undo: the run ended an hour
  // ago, the invoice changed now (updated_at follows the change).
  await withTenant(orgId, (tx) =>
    tx
      .update(importRuns)
      .set({ finishedAt: new Date(Date.now() - 3600_000) })
      .where(eq(importRuns.id, r.id)),
  );
  await withTenant(orgId, (tx) =>
    tx.update(invoices).set({ updatedAt: new Date() }).where(eq(invoices.id, open!.id)),
  );
  const blocked = await view(B, r.id);
  ok(
    "o: an invoice changed after the import blocks the undo",
    blocked.undo_blockers?.some((b: { code: string }) => b.code === "changed_invoices"),
    blocked.undo_blockers,
  );
  await withTenant(orgId, (tx) =>
    tx.update(importRuns).set({ finishedAt: new Date() }).where(eq(importRuns.id, r.id)),
  );
  const clear = await view(B, r.id);
  ok(
    "o: its own history does not block the undo",
    clear.undo_blockers?.length === 0,
    clear.undo_blockers,
  );

  const u = await post(B, `/${r.id}/undo`, {});
  await runUndoJob(r.id);
  const undone = await view(B, r.id);
  const after = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.businessId, test.id), inArray(ledgerEntries.sourceId, docIds))),
  );
  const net = new Map<string, bigint>();
  for (const e of after) {
    const k = `${e.sourceId}:${e.account}`;
    net.set(k, (net.get(k) ?? 0n) + (e.direction === "debit" ? 1n : -1n) * BigInt(e.amountMinor));
  }
  ok(
    "o: undo reverses the opening entries (nothing deleted from the ledger)",
    u.statusCode === 202 &&
      undone.status === "undone" &&
      after.length === 8 &&
      [...net.values()].every((n) => n === 0n),
    { status: undone.status, error: undone.error, entries: after.length },
  );
  const left = await withTenant(orgId, async (tx) => ({
    inv: (await tx.select().from(invoices).where(inArray(invoices.publicId, docIds))).length,
    cn: (await tx.select().from(creditNotes).where(inArray(creditNotes.publicId, docIds))).length,
    pay: pays.length
      ? (
          await tx
            .select()
            .from(payments)
            .where(
              inArray(
                payments.id,
                pays.map((x) => x.id),
              ),
            )
        ).length
      : 0,
    txn: cust
      ? (await tx.select().from(transactions).where(eq(transactions.customerId, cust.id))).length
      : 0,
    use: (
      await tx
        .select()
        .from(usageRecords)
        .where(
          inArray(
            usageRecords.id,
            use.map((x) => x.id),
          ),
        )
    ).length,
  }));
  ok(
    "o: undo deletes the invoices, payments, credit note and usage",
    Object.values(left).every((n) => n === 0),
    left,
  );

  // With collection on, an open invoice enters the retry schedule.
  const c = await upload(
    B,
    [
      {
        entity: "customers",
        content: csv([
          ["customer_id", "email"],
          ["h-c2", em("h2")],
        ]),
      },
      {
        entity: "invoices",
        content: csv([
          [
            "invoice_id",
            "customer_id",
            "status",
            "currency",
            "date",
            "due_date",
            "total",
            "line_description",
            "line_amount",
          ],
          ["h-i3", "h-c2", "open", "USD", day(-3), day(2), "15.00", "Setup", "15.00"],
        ]),
      },
    ],
    { options: { collect_open_invoices: true } },
  );
  await post(B, `/${c.id}/start`, {});
  await runImportJob(c.id);
  const [armed] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(eq(customers.businessId, test.id), eq(customers.publicId, "h-c2"))),
  );
  ok(
    "o: with collection on, the open invoice is scheduled from its due date",
    armed?.invoices.dunningStatus === "in_progress" && armed.invoices.nextAttemptAt != null,
    armed?.invoices,
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
  `\n${failed === 0 ? "✅ BULK-IMPORT: PASS" : `❌ BULK-IMPORT: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
