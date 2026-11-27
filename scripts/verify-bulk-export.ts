/**
 * Bulk exports (0552): preview → start → files → download → delete / expire, through the HTTP
 * routes. The job is called directly; no worker is needed.
 *  a the round trip: business A is filled by a file import; its export, imported into a new
 *    business B, checks clean and adds the same records; B's export has the same import
 *    columns as A's
 *  b preview: rows per file, related rows, a sample in the file's columns
 *  c filters: status and dates choose rows; related records come with them, or not
 *  d the zip: a README and one CSV per record type; one CSV on its own
 *  e one export at a time per business; usage needs a start date
 *  f the email to the member who started it; webhooks event; audit (start, run, download)
 *  g delete and expiry remove the files and keep the run; a download then says why not
 *  h permissions and tenancy
 *  i imports: the end-of-import email links to the import page; an undo sends an email
 *
 *   pnpm verify:bulk-export
 */
import { and, eq, inArray } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createBusiness } from "@/modules/tenancy/service";
import { signup, inviteUser, acceptInvite } from "@/modules/auth/service";
import { runCheckJob, runImportJob, runUndoJob } from "@/modules/bulk-import/runner";
import { runExportJob, expireExports } from "@/modules/bulk-export/runner";
import { parseCsv } from "@/modules/bulk-import/csv-parse";
import { ENTITY_FIELDS } from "@/modules/bulk-import/templates";
import { buildApp } from "@/index";
import { setMailer } from "@/providers/mailer";
import { pinMfaMandateOff } from "./lib/mfa-policy";
import { auditLogs, authTokens, businesses, events, exportParts, exportRuns } from "@db/schema";

pinMfaMandateOff();
const sent: Array<{ to: string; subject: string; text: string }> = [];
setMailer({
  kind: "smtp",
  target: null,
  async send(msg) {
    sent.push({ to: msg.to, subject: msg.subject, text: msg.text ?? "" });
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
const em = (r: string) => `bulk-export-${r}-${uniq}@example.com`;
const owner = await signup({
  email: em("owner"),
  password: PW,
  organizationName: `Bulk Export ${uniq}`,
});
const orgId = owner.user.organizationId;
const twin = async (name: string) => {
  const live = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "live",
  });
  const [t] = await withTenant(orgId, (tx) =>
    tx.select().from(businesses).where(eq(businesses.liveBusinessId, live.id)),
  );
  if (!t) throw new Error("fixture: no test twin");
  return t;
};
const A = await twin("Harbor Kite");
const B = await twin("Harbor Kite Copy");

const app = await buildApp({ logger: false });
type Auth = { cookie?: string; bearer?: string };
const authHeaders = (a: Auth) =>
  a.cookie ? { cookie: `tmb_session=${a.cookie}` } : { authorization: `Bearer ${a.bearer}` };
const OWNER: Auth = { cookie: owner.token };
const req = (method: "GET" | "POST", url: string, payload?: object, auth: Auth = OWNER) =>
  app.inject({
    method,
    url,
    headers: {
      ...authHeaders(auth),
      ...(method === "POST" ? { "idempotency-key": randomBytes(8).toString("hex") } : {}),
    },
    ...(payload ? { payload } : {}),
  });
const imp = (biz: string) => `/v1/businesses/${biz}/imports`;
const exp = (biz: string) => `/v1/businesses/${biz}/exports`;

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const csv = (rows: string[][]) =>
  rows
    .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\n");

async function importFiles(biz: string, files: Array<{ entity: string; content: string }>) {
  const res = await req("POST", imp(biz), {
    files: files.map((f) => ({ filename: `${f.entity}.csv`, ...f })),
  });
  const id = res.json().id as string;
  if (res.statusCode !== 201) return { id, view: res.json(), res };
  await runCheckJob(id);
  const view = (await req("GET", `${imp(biz)}/${id}`)).json();
  return { id, view, res };
}
async function startImport(biz: string, id: string | undefined) {
  if (!id) return { status: "not_uploaded" };
  await req("POST", `${imp(biz)}/${id}/start`, {});
  await runImportJob(id);
  return (await req("GET", `${imp(biz)}/${id}`)).json();
}

/** Every file of a zip, by name. */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  const n = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < n; i++) {
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    out.set(name, inflateRawSync(buf.subarray(lh, lh + csize)).toString("utf8"));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

async function exportAll(biz: string, body: object) {
  const res = await req("POST", exp(biz), body);
  if (res.statusCode !== 202) return { res, run: res.json(), files: new Map<string, string>() };
  const id = res.json().id as string;
  await runExportJob(id);
  const run = (await req("GET", `${exp(biz)}/${id}`)).json();
  const zip = await req("GET", `${exp(biz)}/${id}/file`);
  return { res, run, zip, files: zip.statusCode === 200 ? unzip(zip.rawPayload) : new Map() };
}

// ── a: the round trip ──────────────────────────────────────────────────────────
const source = [
  {
    entity: "plans",
    content: csv([
      [
        "plan_id",
        "price_id",
        "name",
        "pricing_model",
        "amount",
        "currency",
        "interval",
        "trial_days",
        "tiers",
      ],
      ["pro", "pro-usd-m", "Pro", "flat", "49.00", "USD", "month", "14", ""],
      ["pro", "pro-usd-y", "Pro", "flat", "490.00", "USD", "year", "", ""],
      ["team", "team-usd-m", "Team", "tiered", "", "USD", "month", "", "10:5.00|inf:4.00"],
    ]),
  },
  {
    entity: "addons",
    content: csv([
      ["addon_id", "price_id", "name", "pricing_model", "amount", "currency", "interval"],
      ["seats", "seats-usd-m", "Extra seats", "per_unit", "10.00", "USD", "month"],
      ["setup", "setup-usd", "Set-up", "flat", "99.00", "USD", ""],
    ]),
  },
  {
    entity: "coupons",
    content: csv([
      [
        "coupon_id",
        "name",
        "discount_type",
        "percent_off",
        "amount_off",
        "currency",
        "duration",
        "duration_periods",
      ],
      ["SAVE15", "Save 15", "percentage", "15", "", "", "repeating", "3"],
      ["TENOFF", "Ten off", "fixed_amount", "", "10.00", "USD", "once", ""],
    ]),
  },
  {
    entity: "customers",
    content: csv([
      [
        "customer_id",
        "email",
        "first_name",
        "last_name",
        "company",
        "phone",
        "country",
        "payment_gateway",
        "gateway_customer_id",
        "gateway_payment_method_id",
        "card_brand",
        "card_last4",
      ],
      [
        "c1",
        em("c1"),
        "Ana",
        "Silva",
        "=Sum Co",
        "+14155550100",
        "US",
        "tmtest",
        "tmcus_XXXXXXXX01",
        "tmpm_XXXXXXXX01",
        "visa",
        "4242",
      ],
      ["c2", em("c2"), "Ben", "Okafor", "", "", "GB", "", "", "", "", ""],
      ["c3", em("c3"), "Cy", "Park", "", "", "US", "", "", "", "", ""],
    ]),
  },
  {
    entity: "subscriptions",
    content: csv([
      [
        "subscription_id",
        "customer_id",
        "price_id",
        "quantity",
        "status",
        "current_term_end",
        "trial_end",
        "coupon_ids",
      ],
      ["s1", "c1", "pro-usd-m", "1", "active", day(10), "", "SAVE15"],
      ["s1", "c1", "seats-usd-m", "3", "active", day(10), "", "SAVE15"],
      ["s2", "c2", "team-usd-m", "12", "trialing", day(5), day(5), ""],
      ["s3", "c3", "pro-usd-y", "1", "non_renewing", day(40), "", ""],
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
        "discount",
        "line_description",
        "line_amount",
        "line_price_id",
      ],
      [
        "i1",
        "c1",
        "s1",
        "HK-1",
        "paid",
        "USD",
        day(-30),
        "",
        day(-29),
        "73.90",
        "",
        "4.90",
        "5.00",
        "Pro",
        "49.00",
        "pro-usd-m",
      ],
      [
        "i1",
        "c1",
        "s1",
        "HK-1",
        "paid",
        "USD",
        day(-30),
        "",
        day(-29),
        "73.90",
        "",
        "",
        "",
        "Seats",
        "25.00",
        "",
      ],
      [
        "i2",
        "c1",
        "s1",
        "HK-2",
        "open",
        "USD",
        day(-3),
        day(4),
        "",
        "49.00",
        "49.00",
        "",
        "",
        "Pro",
        "49.00",
        "pro-usd-m",
      ],
      [
        "i3",
        "c2",
        "",
        "HK-3",
        "void",
        "USD",
        day(-60),
        "",
        "",
        "99.00",
        "",
        "",
        "",
        "Set-up",
        "99.00",
        "setup-usd",
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
      ["p1", "payment", "c1", "i1", "73.90", "USD", day(-29), ""],
      ["r1", "refund", "c1", "", "5.00", "USD", day(-20), "p1"],
    ]),
  },
  {
    entity: "credit_notes",
    content: csv([
      ["credit_note_id", "invoice_id", "type", "currency", "date", "total", "amount_available"],
      ["cn1", "i1", "refundable", "USD", day(-15), "10.00", "10.00"],
    ]),
  },
];
const ALL = [
  "plans",
  "addons",
  "coupons",
  "customers",
  "subscriptions",
  "invoices",
  "credit_notes",
  "payments",
];

let exportA: Awaited<ReturnType<typeof exportAll>>;
{
  const a = await importFiles(A.publicId, source);
  const bad = (await req("GET", `${imp(A.publicId)}/${a.id}/rows?state=invalid`)).json();
  ok("a: the fixture imports into A", a.view.summary?.ready === true, bad.data ?? a.view);
  const done = await startImport(A.publicId, a.id);
  ok("a: A has the records", done.status === "succeeded", done.result ?? done.error);

  exportA = await exportAll(A.publicId, { entities: ALL });
  ok("a: the export starts (202)", exportA.res.statusCode === 202, exportA.res.body);
  ok("a: the export succeeds", exportA.run.status === "succeeded", exportA.run);
  ok(
    "a: one file per record type, and a README",
    ALL.every((e) => exportA.files.has(`${e}.csv`)) && exportA.files.has("README.txt"),
    [...exportA.files.keys()],
  );
  const customersCsv = parseCsv(exportA.files.get("customers.csv") ?? "");
  const head = ENTITY_FIELDS.customers.map((f) => f.key);
  ok(
    "a: each file starts with the import's columns, in order",
    head.every((h, i) => customersCsv.headers[i] === h),
    customersCsv.headers,
  );
  ok("a: A's skipped list is empty", (exportA.run.skipped ?? []).length === 0, exportA.run.skipped);

  const b = await importFiles(
    B.publicId,
    ALL.map((e) => ({ entity: e, content: exportA.files.get(`${e}.csv`)! })),
  );
  ok(
    "a: the export imports into B with nothing blocked",
    b.view.summary?.ready === true && b.view.summary?.blockers?.length === 0,
    b.view.summary?.blockers ?? b.view,
  );
  const invalid = Object.entries(b.view.summary?.entities ?? {}).filter(
    ([, c]) => (c as { invalid: number }).invalid > 0,
  );
  ok("a: no row of the export is invalid", invalid.length === 0, invalid);
  const doneB = await startImport(B.publicId, b.id);
  ok("a: B has the records", doneB.status === "succeeded", doneB.result ?? doneB.error);
  ok(
    "a: A and B have the same MRR",
    JSON.stringify(a.view.summary?.mrr) === JSON.stringify(b.view.summary?.mrr),
    { a: a.view.summary?.mrr, b: b.view.summary?.mrr },
  );

  const exportB = await exportAll(B.publicId, { entities: ALL });
  for (const e of ALL) {
    // History records get new ids when imported (customers, subscriptions and prices keep
    // theirs), so ids of invoices, credit notes and payments are not compared.
    const NEW_IDS = new Set([
      "invoice_id",
      "credit_note_id",
      "transaction_id",
      "refunded_transaction_id",
    ]);
    const keys = ENTITY_FIELDS[e as keyof typeof ENTITY_FIELDS]
      .map((f) => f.key)
      .filter((k) => !NEW_IDS.has(k));
    const pick = (text: string) => {
      const p = parseCsv(text);
      return p.rows.map((r) => keys.map((k) => r[p.headers.indexOf(k)] ?? "").join("|")).sort();
    };
    const ra = pick(exportA.files.get(`${e}.csv`) ?? "");
    const rb = pick(exportB.files.get(`${e}.csv`) ?? "");
    const diff = ra.filter((x, i) => x !== rb[i]);
    ok(
      `a: ${e}: B's export has the same import columns as A's`,
      ra.length > 0 && ra.length === rb.length && diff.length === 0,
      { a: diff.slice(0, 2), b: rb.filter((x, i) => x !== ra[i]).slice(0, 2) },
    );
  }
  const phone = parseCsv(exportA.files.get("customers.csv") ?? "");
  const c1 = phone.rows.find((r) => r[0] === "c1");
  ok(
    "a: text that starts with + or = is kept safe in the file and imported as it was",
    c1?.[phone.headers.indexOf("phone")] === "'+14155550100" &&
      c1?.[phone.headers.indexOf("company")] === "'=Sum Co",
    c1,
  );
}

// ── b: preview ─────────────────────────────────────────────────────────────────
{
  const res = await req("POST", `${exp(A.publicId)}/preview`, {
    entities: ["invoices"],
    filters: { invoices: { status: ["paid"] } },
  });
  const p = res.json();
  const file = (e: string) => p.files?.find((f: { entity: string }) => f.entity === e);
  ok("b: preview answers 200", res.statusCode === 200, res.body);
  ok(
    "b: the chosen invoices are counted",
    file("invoices")?.chosen === 1 && file("invoices")?.rows === 1,
    file("invoices"),
  );
  ok(
    "b: related records come with them (its customer, subscription and prices)",
    file("customers")?.rows === 1 && file("subscriptions")?.rows === 1 && file("plans")?.rows >= 1,
    p.files?.map((f: { entity: string; rows: number }) => `${f.entity}:${f.rows}`),
  );
  ok(
    "b: the sample has the file's columns and rows",
    file("invoices")?.sample?.length === 2 &&
      file("invoices")?.columns?.[0] === "invoice_id" &&
      file("invoices")?.sample?.[0]?.[3] === "HK-1" &&
      file("invoices")?.sample?.[0]?.[13] === "4.90",
    file("invoices"),
  );
  const none = (
    await req("POST", `${exp(A.publicId)}/preview`, {
      entities: ["invoices"],
      filters: { invoices: { status: ["paid"] } },
      include_related: false,
    })
  ).json();
  ok("b: without related records, only the chosen file", none.files?.length === 1, none.files);
}

// ── c: filters ─────────────────────────────────────────────────────────────────
{
  const r = await exportAll(A.publicId, {
    entities: ["subscriptions"],
    filters: { subscriptions: { status: ["trialing"] } },
    include_related: false,
  });
  const subs = parseCsv(r.files.get("subscriptions.csv") ?? "");
  ok(
    "c: a status filter keeps only those subscriptions",
    subs.rows.length === 1 && subs.rows[0]![0] === "s2" && !r.files.has("customers.csv"),
    { rows: subs.rows, files: [...r.files.keys()] },
  );
  const dated = (
    await req("POST", `${exp(A.publicId)}/preview`, {
      entities: ["invoices"],
      filters: { invoices: { from: day(-10) } },
      include_related: false,
    })
  ).json();
  ok("c: a date range keeps only invoices in it", dated.files?.[0]?.rows === 1, dated.files);
  const bad = await req("POST", `${exp(A.publicId)}/preview`, {
    entities: ["invoices"],
    filters: { invoices: { from: day(1), to: day(-1) } },
  });
  ok("c: a start after the end is a 400 with the reason", bad.statusCode === 400, bad.body);
}

// ── d: one file ────────────────────────────────────────────────────────────────
{
  const id = exportA!.run.id as string;
  const one = await req("GET", `${exp(A.publicId)}/${id}/files/customers`);
  ok(
    "d: one CSV downloads on its own, the same as in the zip",
    one.statusCode === 200 && one.body === exportA!.files.get("customers.csv"),
    one.statusCode,
  );
  ok(
    "d: the README says what the zip holds",
    /customers\.csv: 3 rows/.test(exportA!.files.get("README.txt") ?? ""),
    exportA!.files.get("README.txt"),
  );
}

// ── e: one at a time; usage needs a start date ──────────────────────────────────
{
  const first = await req("POST", exp(A.publicId), { entities: ["customers"] });
  const second = await req("POST", exp(A.publicId), { entities: ["customers"] });
  ok("e: a second export while one is queued is a 409", second.statusCode === 409, second.body);
  await runExportJob(first.json().id);
  const usage = await req("POST", exp(A.publicId), { entities: ["usage"] });
  ok("e: usage without a start date is a 400", usage.statusCode === 400, usage.body);
}

// ── f: email, event, audit ─────────────────────────────────────────────────────
{
  const id = exportA!.run.id as string;
  const mail = sent.find(
    (m) => m.to === em("owner") && /export of Harbor Kite is ready/.test(m.subject),
  );
  ok(
    "f: the member who started it gets an email with a link to the page",
    !!mail && mail.text.includes(`/businesses/${A.publicId}/imports?tab=export&export=${id}`),
    sent.map((m) => m.subject),
  );
  const ev = await withTenant(orgId, (tx) =>
    tx.select({ type: events.type }).from(events).where(eq(events.businessId, A.id)),
  );
  ok(
    "f: an export_completed event is emitted",
    ev.some((e) => e.type === "export_completed"),
    ev.map((e) => e.type),
  );
  const audit = await withTenant(orgId, (tx) =>
    tx
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, id), eq(auditLogs.resourceType, "export"))),
  );
  const actions = audit.map((a) => a.action);
  ok(
    "f: audit has the start, the run and each download",
    ["export.start", "export.run", "export.download"].every((a) => actions.includes(a)),
    actions,
  );
}

// ── g: delete and expiry ───────────────────────────────────────────────────────
{
  const id = exportA!.run.id as string;
  const del = await req("POST", `${exp(A.publicId)}/${id}/delete`, {});
  ok("g: delete answers with the run, status deleted", del.json().status === "deleted", del.body);
  const parts = await withTenant(orgId, (tx) =>
    tx.select({ id: exportParts.id }).from(exportParts).where(eq(exportParts.runId, id)),
  );
  ok("g: its files are gone", parts.length === 0, parts.length);
  const dl = await req("GET", `${exp(A.publicId)}/${id}/file`);
  ok(
    "g: a download then is a 409 that says why",
    dl.statusCode === 409 && /deleted/.test(dl.body),
    dl.body,
  );

  const r = await exportAll(A.publicId, { entities: ["coupons"] });
  await withTenant(orgId, (tx) =>
    tx
      .update(exportRuns)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(exportRuns.id, r.run.id)),
  );
  await expireExports(new Date());
  const after = (await req("GET", `${exp(A.publicId)}/${r.run.id}`)).json();
  const left = await systemDb
    .select({ id: exportParts.id })
    .from(exportParts)
    .where(eq(exportParts.runId, r.run.id));
  ok(
    "g: an expired export keeps its run and loses its files",
    after.status === "expired" && left.length === 0,
    after,
  );
}

// ── h: permissions and tenancy ─────────────────────────────────────────────────
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
  const denied = await req("POST", exp(A.publicId), { entities: ["customers"] }, mgr);
  ok("h: a manager cannot export (403)", denied.statusCode === 403, denied.statusCode);
  const deniedRead = await req("GET", exp(A.publicId), undefined, mgr);
  ok("h: nor list exports (403)", deniedRead.statusCode === 403, deniedRead.statusCode);

  const other = await signup({
    email: em("other"),
    password: PW,
    organizationName: `Other ${uniq}`,
  });
  const theirs = await req("GET", `${exp(A.publicId)}/${exportA!.run.id}`, undefined, {
    cookie: other.token,
  });
  ok(
    "h: another organization cannot read it",
    theirs.statusCode === 404 || theirs.statusCode === 403,
    theirs.statusCode,
  );
}

// ── i: import emails ───────────────────────────────────────────────────────────
{
  const mail = sent.find((m) => /The import into Harbor Kite /.test(m.subject));
  ok(
    "i: the end-of-import email links to the import page",
    !!mail && new RegExp(`/businesses/${A.publicId}/imports\\?run=`).test(mail.text),
    mail?.text,
  );
  const c = await importFiles(A.publicId, [
    {
      entity: "customers",
      content: csv([
        ["customer_id", "email"],
        ["u1", em("u1")],
      ]),
    },
  ]);
  await startImport(A.publicId, c.id);
  const u = await req("POST", `${imp(A.publicId)}/${c.id}/undo`, {});
  ok("i: the undo is queued", u.statusCode === 202, u.body);
  await runUndoJob(c.id);
  const undoMail = sent.find((m) => /The import into Harbor Kite is undone/.test(m.subject));
  ok(
    "i: the member who asked for the undo gets an email",
    !!undoMail && undoMail.to === em("owner") && undoMail.text.includes(`imports?run=${c.id}`),
    sent.map((m) => m.subject),
  );
}

void inArray;
await app.close();
let failed = 0;
for (const [label, passed, detail] of checks) {
  console.log(
    `${passed ? "  ✓" : "  ✗ FAIL"} ${label}${passed || !detail ? "" : `  — ${detail.slice(0, 900)}`}`,
  );
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? "✅ BULK-EXPORT: PASS" : `❌ BULK-EXPORT: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
