/**
 * verify:email-engagement — open and click tracking, through the real send path.
 *
 * Emails go out through `deliverPendingEmails` with a capturing mailer; the pixel and the
 * redirect are then requested over HTTP. Checks: the setting on and off, the HTML part only,
 * the machine split, the redirect target, tampered tokens, nothing personal stored, the
 * report figures, tenant isolation and the retention sweep.
 */
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { deliverPendingEmails } from "@/modules/emails/outbox";
import { signToken } from "@/modules/emails/tracking";
import { sweepEmailEngagement } from "@/modules/emails/engagement-retention";
import { businesses, emailEngagements, emailLinks, emailMessages, organizations } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const captured: OutboundEmail[] = [];
setMailer({
  kind: "smtp",
  target: null,
  async send(msg) {
    captured.push(msg);
    return { providerMessageId: `prov-${captured.length}`, status: "sent" };
  },
});

const app = await buildApp({ logger: false });
const HUMAN =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const SCANNER = "Mozilla/5.0 (compatible; Proofpoint URL Defense)";
const APPLE_IP = "17.58.0.1";
const TARGET = "https://shop.example.com/portal/s/ACCESSTOKEN0123456789abcdef?x=1&y=2";
const HTML = `<html><body><p>Hello</p><a class="btn" href="https://shop.example.com/portal/s/ACCESSTOKEN0123456789abcdef?x=1&amp;y=2" target="_blank">View invoice</a><a href="mailto:help@example.com">Write</a><a href="https://shop.example.com/unsubscribe?u=1">Unsubscribe</a></body></html>`;
const TEXT =
  "Hello\nView invoice: https://shop.example.com/portal/s/ACCESSTOKEN0123456789abcdef?x=1&y=2";

const mk = async (name: string, cfg: Record<string, unknown>) => {
  const org = await createOrganization({ name });
  const biz = await createBusiness({
    organizationId: org.organization.id,
    name: `${name} biz`,
    defaultCurrency: "USD",
    livemode: "live",
    timezone: "UTC",
  });
  await systemDb.update(businesses).set({ emailConfig: cfg }).where(eq(businesses.id, biz.id));
  return { org, orgId: org.organization.id, biz };
};
const A = await mk("Eng A", { enabled: true, trackEngagement: true });
const off = await (async () => {
  const biz = await createBusiness({
    organizationId: A.orgId,
    name: "Eng off",
    defaultCurrency: "USD",
    livemode: "live",
    timezone: "UTC",
  });
  await systemDb
    .update(businesses)
    .set({ emailConfig: { enabled: true } })
    .where(eq(businesses.id, biz.id));
  return biz;
})();
const X = await mk("Eng X", { enabled: true, trackEngagement: true });

async function queue(orgId: string, businessId: string, createdAt = new Date()) {
  const id = publicId("em");
  await systemDb.insert(emailMessages).values({
    publicId: id,
    organizationId: orgId,
    businessId,
    type: "invoice_issued",
    toAddress: "payer@example.com",
    subject: "Invoice",
    bodyHtml: HTML,
    bodyText: TEXT,
    status: "pending",
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    createdAt,
  });
  return id;
}
const rowOf = async (pid: string) =>
  (await systemDb.select().from(emailMessages).where(eq(emailMessages.publicId, pid)))[0]!;
const sentBack = (pid: string, ms: number) =>
  systemDb
    .update(emailMessages)
    .set({ sentAt: new Date(Date.now() - ms) })
    .where(eq(emailMessages.publicId, pid));

const eOn = [] as string[];
for (let i = 0; i < 5; i++) eOn.push(await queue(A.orgId, A.biz.id));
const eOff = await queue(A.orgId, off.id);
const eX = await queue(X.orgId, X.biz.id);
await deliverPendingEmails(new Date());
const sentOf = (pid: string) => captured.find((m) => m.idempotencyKey === pid)!;

// --- Send path.
const m1 = sentOf(eOn[0]!);
ok(
  "tracked: the HTML part has the pixel",
  /<img src="[^"]*\/e\/o\/[A-Za-z0-9_-]{40}\.gif"/.test(m1.html ?? ""),
  m1.html,
);
ok(
  "tracked: the link goes through a redirect, other attributes kept",
  /<a class="btn" href="[^"]*\/e\/c\/[A-Za-z0-9_-]{40}" target="_blank">View invoice<\/a>/.test(
    m1.html ?? "",
  ),
  m1.html,
);
ok(
  "mailto and unsubscribe links are not rewritten",
  (m1.html ?? "").includes('href="mailto:help@example.com"') &&
    (m1.html ?? "").includes("https://shop.example.com/unsubscribe?u=1"),
);
ok("the text part is untouched", m1.text === TEXT, m1.text);
ok("the stored body is untouched", (await rowOf(eOn[0]!)).bodyHtml === HTML);
ok("a tracked send is marked", (await rowOf(eOn[0]!)).engagementTrackedAt !== null);
const mOff = sentOf(eOff);
ok("setting off: no pixel, no rewrite", mOff.html === HTML, mOff.html);
ok("setting off: the row is not marked", (await rowOf(eOff)).engagementTrackedAt === null);
const pixelPath = (pid: string) =>
  /\/e\/o\/([A-Za-z0-9_-]{40}\.gif)/.exec(sentOf(pid).html ?? "")![1]!;
const clickPath = (pid: string) => /\/e\/c\/([A-Za-z0-9_-]{40})"/.exec(sentOf(pid).html ?? "")![1]!;
const links = await systemDb.select().from(emailLinks).where(eq(emailLinks.businessId, A.biz.id));
ok(
  "the original URL is stored once per email, decoded",
  links.length === 5 && links.every((l) => l.url === TARGET),
  links[0],
);

const get = (url: string, ua = HUMAN, method: "GET" | "HEAD" = "GET", ip?: string) =>
  app.inject({ method, url, headers: { "user-agent": ua }, ...(ip ? { remoteAddress: ip } : {}) });
const events = async (pid: string) => {
  const r = await rowOf(pid);
  return systemDb.select().from(emailEngagements).where(eq(emailEngagements.emailMessageId, r.id));
};

// E1: two opens by a person, a proxy open, a click, a HEAD click, a scanner click.
const [e1, e2, e3, e4, e5] = eOn as [string, string, string, string, string];
for (const p of [e1, e2, e3, e4]) await sentBack(p, 60_000);
const o1 = await get(`/e/o/${pixelPath(e1)}`);
ok(
  "the pixel answers a GIF",
  o1.statusCode === 200 &&
    String(o1.headers["content-type"]).startsWith("image/gif") &&
    o1.rawPayload.subarray(0, 3).toString() === "GIF",
  o1.statusCode,
);
await get(`/e/o/${pixelPath(e1)}`);
await get(`/e/o/${pixelPath(e1)}`, HUMAN, "GET", APPLE_IP);
const c1 = await get(`/e/c/${clickPath(e1)}?to=https://evil.example.com`);
ok(
  "the redirect goes to the stored URL, not to a request value",
  c1.statusCode === 302 && c1.headers.location === TARGET,
  c1.headers.location,
);
await get(`/e/c/${clickPath(e1)}`, HUMAN, "HEAD");
await get(`/e/c/${clickPath(e1)}`, SCANNER);
const ev1 = await events(e1);
const n = (f: (x: (typeof ev1)[number]) => boolean) => ev1.filter(f).length;
ok(
  "two human opens, one machine open",
  n((x) => x.kind === "open" && !x.machine) === 2 && n((x) => x.kind === "open" && x.machine) === 1,
  ev1.map((x) => [x.kind, x.machine]),
);
ok(
  "one human click, two machine clicks (HEAD, scanner)",
  n((x) => x.kind === "click" && !x.machine) === 1 &&
    n((x) => x.kind === "click" && x.machine) === 2,
);
const first = await rowOf(e1);
ok("the first open and click are on the row once", !!first.firstOpenedAt && !!first.firstClickedAt);
const human = ev1.find((x) => x.kind === "click" && !x.machine)!;
ok(
  "a click keeps the host, the masked path and the label, never the query or the token",
  human.linkHost === "shop.example.com" &&
    human.linkPath === "/portal/s/:id" &&
    human.linkLabel === "View invoice" &&
    human.browser === "Safari" &&
    human.os === "iOS" &&
    human.deviceCategory === "mobile",
  human,
);
const t1 = first.firstOpenedAt;
await get(`/e/o/${pixelPath(e1)}`);
ok(
  "a later open does not move the first-open time",
  (await rowOf(e1)).firstOpenedAt?.getTime() === t1?.getTime(),
);

await get(`/e/o/${pixelPath(e2)}`, HUMAN, "GET", APPLE_IP);
const r2 = await rowOf(e2);
ok(
  "E2: a proxy open alone sets no first-open time",
  r2.firstOpenedAt === null && (await events(e2)).length === 1,
);
await get(`/e/c/${clickPath(e4)}`);
ok("E4: a person's click is recorded", (await rowOf(e4)).firstClickedAt !== null);
const c5 = await get(`/e/c/${clickPath(e5)}`);
ok(
  "E5: a click within seconds of the send is machine, and still redirects",
  c5.statusCode === 302 && (await events(e5))[0]?.machine === true,
);

// --- Bad tokens.
const tk = pixelPath(e1);
const bad = (tk[0] === "A" ? "B" : "A") + tk.slice(1);
ok("a tampered pixel token is 404", (await get(`/e/o/${bad}`)).statusCode === 404);
const ct = clickPath(e1);
ok(
  "a tampered click token is 404",
  (await get(`/e/c/${(ct[0] === "A" ? "B" : "A") + ct.slice(1)}`)).statusCode === 404,
);
ok(
  "a pixel token does not open a click",
  (await get(`/e/c/${tk.slice(0, 40)}`)).statusCode === 404,
);
const rE1 = await rowOf(e1);
ok(
  "a signed token for a link we do not hold is 404",
  (await get(`/e/c/${signToken("c", rE1.id, 99)}`)).statusCode === 404,
);
ok(
  "junk is 404",
  (await get(`/e/c/abc`)).statusCode === 404 && (await get(`/e/o/abc.gif`)).statusCode === 404,
);

// --- Off business and later switch-off.
const rOff = await rowOf(eOff);
await get(`/e/o/${signToken("o", rOff.id)}.gif`);
ok("setting off: a pixel request records nothing", (await events(eOff)).length === 0);
const before = (await events(e1)).length;
await systemDb
  .update(businesses)
  .set({ emailConfig: { enabled: true } })
  .where(eq(businesses.id, A.biz.id));
const lateClick = await get(`/e/c/${clickPath(e1)}`);
await get(`/e/o/${pixelPath(e1)}`);
ok(
  "switched off later: the link still works, nothing is recorded",
  lateClick.statusCode === 302 && (await events(e1)).length === before,
);
await systemDb
  .update(businesses)
  .set({ emailConfig: { enabled: true, trackEngagement: true } })
  .where(eq(businesses.id, A.biz.id));

// --- Nothing personal stored.
const cols = (await systemDb.execute(
  sql`select column_name from information_schema.columns where table_name in ('email_engagements','email_links')`,
)) as unknown as Array<{ column_name: string }>;
ok(
  "no column for an IP, a user agent or an address",
  !cols.some((c) => /(^|_)ip($|_)|user_agent|address|email$|query/.test(c.column_name)),
  cols.map((c) => c.column_name),
);
const dump = JSON.stringify(
  await systemDb.select().from(emailEngagements).where(eq(emailEngagements.businessId, A.biz.id)),
);
ok(
  "no IP, user agent, address, query string or token in any engagement row",
  !dump.includes(APPLE_IP) &&
    !/Mozilla|Proofpoint/.test(dump) &&
    !dump.includes("payer@example.com") &&
    !dump.includes("x=1") &&
    !dump.includes("ACCESSTOKEN"),
  dump.slice(0, 300),
);

// --- Report.
const tokenA = A.org.secret;
const d = new Date();
const day = (o: number) => new Date(d.getTime() + o * 86_400_000).toISOString().slice(0, 10);
const report = async (biz: string, start: string, end: string, token = tokenA) => {
  const r = await app.inject({
    method: "GET",
    url: `/v1/businesses/${biz}/email_report?start=${start}&end=${end}&recent=20`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
// E3 was tracked ten days ago, so a window from 3 days back is fully covered.
await systemDb
  .update(emailMessages)
  .set({ engagementTrackedAt: new Date(d.getTime() - 10 * 86_400_000) })
  .where(eq(emailMessages.publicId, e3));
const full = await report(A.biz.publicId, day(-3), day(1));
const t = full.body.totals;
ok(
  "report: 5 tracked, 2 opened by people, 2 clicked, 2 machine opens",
  t?.tracked === 5 && t.opened === 2 && t.clicked === 2 && t.machine_opened === 2,
  t,
);
ok(
  "report: open and click rate are over tracked emails",
  t?.open_bps === 4000 && t.click_bps === 4000,
  t,
);
ok(
  "report: tracking covers the period when it began before it",
  full.body.tracking?.enabled === true && full.body.tracking.covers_period === true,
  full.body.tracking,
);
const steps = (full.body.funnel as Array<{ step: string; sessions: number }>).map((s) => s.step);
ok(
  "report: funnel queued, delivered, opened, clicked, portal link opened, paid",
  steps.join() === "queued,delivered,email_opened,email_clicked,opened,paid",
  steps,
);
const bt = (full.body.by_type as Array<Record<string, number | string>>).find(
  (x) => x.type === "invoice_issued",
);
ok(
  "report: by type has opened and clicked",
  bt?.opened === 2 && bt.clicked === 2 && bt.open_bps === 4000,
  bt,
);
const top = full.body.top_links?.[0];
ok(
  "report: most-clicked link counts people only",
  top?.label === "View invoice" &&
    top.clicks === 2 &&
    top.emails === 2 &&
    top.path === "/portal/s/:id",
  full.body.top_links,
);
const rec = (
  full.body.recent as Array<{ email: string; opened: boolean | null; clicked: boolean | null }>
).find((x) => x.email === e1);
ok(
  "report: recent emails show opened and clicked",
  rec?.opened === true && rec.clicked === true,
  rec,
);
const e3rec = (full.body.recent as Array<{ email: string; opened: boolean | null }>).find(
  (x) => x.email === e3,
);
ok("report: an email nobody opened is No, not a dash", e3rec?.opened === false, e3rec);
const part = await report(A.biz.publicId, day(-20), day(1));
ok(
  "report: a window that starts before tracking began says so",
  part.body.tracking?.covers_period === false && !!part.body.tracking.since,
  part.body.tracking,
);
const offR = await report(off.publicId, day(-3), day(1));
ok(
  "report: a business with tracking off has no rate",
  offR.body.totals?.tracked === 0 &&
    offR.body.totals.open_bps === null &&
    offR.body.tracking.enabled === false &&
    offR.body.tracking.since === null,
  offR.body.totals,
);
ok(
  "report: no opened or clicked funnel step with tracking off",
  !(offR.body.funnel as Array<{ step: string }>).some((s) => s.step === "email_opened"),
);
const xr = await report(X.biz.publicId, day(-3), day(1), X.org.secret);
ok(
  "report: another business's figures do not mix in",
  xr.body.totals?.tracked === 1 && xr.body.totals.opened === 0,
  xr.body.totals,
);
const cross = await report(A.biz.publicId, day(-3), day(1), X.org.secret);
ok(
  "tenant isolation: another organization cannot read the report",
  cross.status !== 200,
  cross.status,
);
void eX;

// --- Retention: a platform organization's rows survive.
const P = await mk("Eng Platform", { enabled: true, trackEngagement: true });
await systemDb.update(organizations).set({ isPlatform: true }).where(eq(organizations.id, P.orgId));
const old = new Date(Date.now() - 400 * 86_400_000);
async function oldRows(m: Awaited<ReturnType<typeof mk>>) {
  const pid = await queue(m.orgId, m.biz.id, old);
  const row = await rowOf(pid);
  await systemDb
    .insert(emailEngagements)
    .values({
      organizationId: m.orgId,
      businessId: m.biz.id,
      emailMessageId: row.id,
      kind: "open",
      createdAt: old,
    });
  await systemDb
    .insert(emailLinks)
    .values({
      emailMessageId: row.id,
      position: 1,
      organizationId: m.orgId,
      businessId: m.biz.id,
      url: TARGET,
      createdAt: old,
    });
  return row.id;
}
const pOld = await oldRows(P);
const nOld = await oldRows(X);
await sweepEmailEngagement(new Date());
const left = async (id: string) => ({
  e: (await systemDb.select().from(emailEngagements).where(eq(emailEngagements.emailMessageId, id)))
    .length,
  l: (
    await systemDb
      .select()
      .from(emailLinks)
      .where(and(eq(emailLinks.emailMessageId, id)))
  ).length,
});
const lp = await left(pOld);
const ln = await left(nOld);
ok("retention: another organization's old rows are deleted", ln.e === 0 && ln.l === 0, ln);
ok("retention: a platform organization's old rows survive", lp.e === 1 && lp.l === 1, lp);
const recent = await left(rE1.id);
ok("retention: recent rows stay", recent.e > 0 && recent.l > 0, recent);

setMailer(null);
await app.close();
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
