/**
 * verify:portal-access — storefront Phase 4a: sign-in by email code, link and session
 * lifetimes, and what the portal hides.
 *
 * Unset = today: no code sign-in (404), built-in lifetimes (1 h / 5 days / 72 h), every
 * subscription and invoice listed. The code is read back by brute-forcing its stored hash
 * (a million sha256s), so the engine needs no test hook and the log stays masked.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { WORKER_TASKS } from "@/platform/jobs";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createCustomer } from "@/modules/customers/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { emailPortalLink } from "@/modules/emails/portal-link";
import { upsertTemplate } from "@/modules/emails/template-service";
import {
  loginEmailHash,
  sendQueuedSignInCode,
  SIGN_IN_CODE_TASK,
  type SignInCodeJob,
} from "@/modules/customer-portal/login-code";
import { createInvoiceFromLines } from "@/modules/invoicing/service";
import { voidInvoice } from "@/modules/invoicing/ops";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { config } from "@/platform/config";
import {
  businesses,
  customers,
  emailMessages,
  portalLoginCodes,
  portalSessions,
  subscriptions,
} from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label);
  }
}

const app = await buildApp({ logger: false });
await clearPublicRateLimits();
const body = (r: { body: string }) => JSON.parse(r.body);
const post = (url: string, payload: object, token?: string) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "idempotency-key": crypto.randomUUID(),
    },
    payload,
  });

const org = await createOrganization({ name: "Portal Access Co" });
const orgId = org.organization.id;
const setConfig = (bizId: string, cfg: Record<string, unknown>) =>
  withTenant(orgId, (tx) =>
    tx.update(businesses).set({ storefrontConfig: cfg }).where(eq(businesses.id, bizId)),
  );

// ── Lifetimes (test business) ───────────────────────────────────────────────
const biz = await createBusiness({
  organizationId: orgId,
  name: "Access Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const cus = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "lt@example.com",
});
const sessionRow = (publicId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(portalSessions).where(eq(portalSessions.publicId, publicId)),
  ).then((r) => r[0]!);
const hoursFrom = (d: Date, from: number) => (d.getTime() - from) / 3_600_000;
const exchange = async (accessToken: string) =>
  body(
    await app.inject({
      method: "POST",
      url: "/portal/v1/session",
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  ) as { token: string; expires_at?: string };

let t0 = Date.now();
const api0 = await createPortalSession({
  organizationId: orgId,
  businessId: biz.id,
  customerId: cus.id,
});
ok("unset: an API link works 1 hour", Math.abs(hoursFrom(api0.accessExpiresAt, t0) - 1) < 0.01);
const email0 = await withTenant(orgId, (tx) =>
  emailPortalLink(tx, { organizationId: orgId, businessId: biz.id, customerId: cus.id }),
);
ok("unset: an email link works 5 days", !!email0);
t0 = Date.now();
await exchange(api0.accessToken);
ok(
  "unset: a session lasts 72 hours",
  Math.abs(hoursFrom((await sessionRow(api0.publicId)).expiresAt!, t0) - 72) < 0.01,
);

await setConfig(biz.id, {
  portal_link_hours: 2,
  portal_email_link_days: 7,
  portal_session_hours: 24,
});
t0 = Date.now();
const api1 = await createPortalSession({
  organizationId: orgId,
  businessId: biz.id,
  customerId: cus.id,
});
ok("set: an API link works 2 hours", Math.abs(hoursFrom(api1.accessExpiresAt, t0) - 2) < 0.01);
const emailTicket = await createPortalSession({
  organizationId: orgId,
  businessId: biz.id,
  customerId: cus.id,
  kind: "email",
});
ok(
  "set: an email link works 7 days",
  Math.abs(hoursFrom(emailTicket.accessExpiresAt, t0) - 168) < 0.01,
);
t0 = Date.now();
await exchange(api1.accessToken);
ok(
  "set: a session lasts 24 hours",
  Math.abs(hoursFrom((await sessionRow(api1.publicId)).expiresAt!, t0) - 24) < 0.01,
);
await setConfig(biz.id, { portal_link_hours: 99 });
const api2 = await createPortalSession({
  organizationId: orgId,
  businessId: biz.id,
  customerId: cus.id,
});
ok(
  "out of bounds (99 h) → the built-in 1 hour",
  Math.abs(hoursFrom(api2.accessExpiresAt, Date.now()) - 1) < 0.01,
);

// ── Hidden in the portal ────────────────────────────────────────────────────
await setConfig(biz.id, {});
const plan = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Team",
  kind: "plan",
});
const team = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 4900,
  interval: "month",
});
const mint = body(
  await post(
    `/v1/businesses/${biz.publicId}/checkout_sessions`,
    { price: team.publicId },
    org.secret,
  ),
) as { token: string };
await post(
  "/checkout/v1/customer",
  {
    email: "hide@example.com",
    address: {
      line1: "1 Market St",
      city: "San Francisco",
      state: "California",
      state_code: "CA",
      postal_code: "94105",
      country: "US",
      first_name: "Sam",
      last_name: "Rivera",
    },
  },
  mint.token,
);
const done = body(await post("/checkout/v1/complete", { token: "tok_4242" }, mint.token)) as {
  subscription_id: string;
  customer_id: string;
};
const [hc] = await withTenant(orgId, (tx) =>
  tx.select().from(customers).where(eq(customers.publicId, done.customer_id)),
);
const zero = await createInvoiceFromLines({
  organizationId: orgId,
  businessId: biz.id,
  customerId: hc!.id,
  currency: "USD",
  lines: [{ description: "Free month", amountMinor: 0n, kind: "one_time" }],
});
const toVoid = await createInvoiceFromLines({
  organizationId: orgId,
  businessId: biz.id,
  customerId: hc!.id,
  currency: "USD",
  lines: [{ description: "Setup", amountMinor: 1500n, kind: "one_time" }],
});
await voidInvoice(orgId, biz.id, toVoid.invoice.publicId);
await withTenant(orgId, (tx) =>
  tx
    .update(subscriptions)
    .set({ status: "cancelled" })
    .where(eq(subscriptions.publicId, done.subscription_id)),
);
const portalToken = async () => {
  const s = await createPortalSession({
    organizationId: orgId,
    businessId: biz.id,
    customerId: hc!.id,
  });
  return (await exchange(s.accessToken)).token;
};
const list = async (path: string) => {
  const tok = await portalToken();
  return body(
    await app.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${tok}` } }),
  ).data as Array<{ id: string }>;
};
const invIds = async () => (await list("/portal/v1/invoices")).map((i) => i.id);
const subIds = async () => (await list("/portal/v1/subscriptions")).map((s) => s.id);
ok("unset: the cancelled subscription is listed", (await subIds()).includes(done.subscription_id));
const before = await invIds();
ok(
  "unset: zero and voided invoices are listed",
  before.includes(zero.invoice.publicId) && before.includes(toVoid.invoice.publicId),
);
await setConfig(biz.id, {
  portal_hide_cancelled_subscriptions: true,
  portal_hide_zero_invoices: true,
  portal_hide_voided_invoices: true,
});
ok(
  "hide cancelled: the cancelled subscription is not listed",
  !(await subIds()).includes(done.subscription_id),
);
const after = await invIds();
ok("hide zero: the zero-total invoice is not listed", !after.includes(zero.invoice.publicId));
ok("hide voided: the voided invoice is not listed", !after.includes(toVoid.invoice.publicId));
ok("hide: the paid subscription invoice still shows", after.length === before.length - 2);

// ── Sign-in by email code (live business: the code email is not test-mode gated) ──
const live = await createBusiness({
  organizationId: orgId,
  name: "Access Live",
  defaultCurrency: "USD",
  livemode: "live",
  timezone: "UTC",
});
const a1 = await createCustomer({
  organizationId: orgId,
  businessId: live.id,
  email: "pat@example.com",
  firstName: "Pat",
});
const shared1 = await createCustomer({
  organizationId: orgId,
  businessId: live.id,
  email: "Shared@example.com",
  company: "North Co",
});
const shared2 = await createCustomer({
  organizationId: orgId,
  businessId: live.id,
  email: "shared@example.com",
  company: "South Co",
});
const archived = await createCustomer({
  organizationId: orgId,
  businessId: live.id,
  email: "gone@example.com",
});
await withTenant(orgId, (tx) =>
  tx.update(customers).set({ active: false }).where(eq(customers.id, archived.id)),
);

// A capturing mailer: what the code email carries, and WHEN it is sent.
const sentMail: OutboundEmail[] = [];
setMailer({
  kind: "console",
  target: null,
  async send(msg) {
    sentMail.push(msg);
    return { providerMessageId: "fake-1", status: "sent" };
  },
});
/** The queued send for one code row. */
const queuedJob = async (codeId: string) =>
  (
    (await systemDb.execute(sql`
      select j.payload::jsonb as payload
        from graphile_worker._private_jobs j
        join graphile_worker._private_tasks t on t.id = j.task_id
       where t.identifier = ${SIGN_IN_CODE_TASK} and j.key = ${`portal_sign_in_code:${codeId}`}`)) as unknown as Array<{
      payload: SignInCodeJob;
    }>
  )[0]?.payload;
const dropJob = (codeId: string) =>
  systemDb.execute(
    sql`delete from graphile_worker._private_jobs where key = ${`portal_sign_in_code:${codeId}`}`,
  );

const request = (email: string) =>
  post("/portal/v1/login/request", { business: live.publicId, email });
const verify = (email: string, code: string, customer?: string) =>
  post("/portal/v1/login/verify", {
    business: live.publicId,
    email,
    code,
    ...(customer ? { customer } : {}),
  });
const codeRows = (email: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select()
      .from(portalLoginCodes)
      .where(
        and(
          eq(portalLoginCodes.businessId, live.id),
          eq(portalLoginCodes.emailHash, loginEmailHash(email)),
        ),
      ),
  );
/** The live code for an email, found from its hash. */
const codeFor = async (email: string) => {
  const row = (await codeRows(email)).filter((r) => !r.usedAt).at(-1);
  if (!row) return null;
  for (let i = 0; i < 1_000_000; i++) {
    const c = String(i).padStart(6, "0");
    if (createHash("sha256").update(`${row.id}:${c}`).digest("hex") === row.codeHash) return c;
  }
  return null;
};

const notice0 = body(
  await app.inject({ method: "GET", url: `/portal/v1/link_notice/${live.publicId}` }),
);
ok("unset: link_notice says email_code false", notice0.email_code === false);
ok("unset: requesting a code → 404", (await request("pat@example.com")).statusCode === 404);

await setConfig(live.id, { portal_email_code: true });
const notice1 = body(
  await app.inject({ method: "GET", url: `/portal/v1/link_notice/${live.publicId}` }),
);
ok("on: link_notice says email_code true", notice1.email_code === true);
const unknown = await request("nobody@example.com");
ok(
  "unknown email → 200 sent, and no code is made",
  unknown.statusCode === 200 &&
    body(unknown).sent === true &&
    (await codeRows("nobody@example.com")).length === 0,
);
const known = await request("pat@example.com");
ok("known email → the same 200 sent", known.statusCode === 200 && body(known).sent === true);
const rows = await codeRows("pat@example.com");
ok(
  "one code row, hashed (no plain code stored)",
  rows.length === 1 && rows[0]!.codeHash.length === 64,
);
const code = await codeFor("pat@example.com");
ok("the code is 6 digits", !!code && /^\d{6}$/.test(code));
ok("the request itself sends no email: it is queued", sentMail.length === 0);
ok("the worker runs the send task", WORKER_TASKS.includes(SIGN_IN_CODE_TASK));
const job = await queuedJob(rows[0]!.id);
ok(
  "one send job is queued for the code, the code encrypted in it",
  !!job && job.to === "pat@example.com" && !job.code.includes(code!) && job.code.startsWith("v1:"),
);
ok("the job sends the code", (await sendQueuedSignInCode(job!)) === "sent");
ok(
  "the code email goes to the customer only: no cc, no bcc",
  sentMail.length === 1 &&
    sentMail[0]!.to === "pat@example.com" &&
    (sentMail[0]!.cc ?? []).length === 0 &&
    Array.isArray(sentMail[0]!.bcc) &&
    sentMail[0]!.bcc!.length === 0 &&
    sentMail[0]!.text.includes(code!),
);
await dropJob(rows[0]!.id);
const [mail] = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(emailMessages)
    .where(
      and(eq(emailMessages.businessId, live.id), eq(emailMessages.type, "portal_sign_in_code")),
    ),
);
ok(
  "the logged email is masked: it never holds the code",
  !!mail &&
    !mail.bodyText!.includes(code!) &&
    !mail.bodyHtml!.includes(code!) &&
    mail.bodyText!.includes("••••••"),
);
ok(
  "archived customer → no code is made",
  (await request("gone@example.com")).statusCode === 200 &&
    (await codeRows("gone@example.com")).length === 0,
);

const wrong = code === "000000" ? "000001" : "000000";
ok("wrong code → 400", (await verify("pat@example.com", wrong)).statusCode === 400);
const good = await verify("pat@example.com", code!);
const goodBody = body(good);
ok(
  "right code → a session token",
  good.statusCode === 200 && goodBody.object === "portal_login" && !!goodBody.token,
);
const me = await app.inject({
  method: "GET",
  url: "/portal/v1/me",
  headers: { authorization: `Bearer ${goodBody.token}` },
});
ok(
  "the session opens the portal for that customer",
  me.statusCode === 200 && me.body.includes(a1.publicId),
);
ok("the code works one time", (await verify("pat@example.com", code!)).statusCode === 400);

// Five wrong tries end a code, even if the right one follows.
await request("pat@example.com");
const code2 = await codeFor("pat@example.com");
const bad2 = code2 === "111111" ? "222222" : "111111";
for (let i = 0; i < 5; i++) await verify("pat@example.com", bad2);
ok(
  "after 5 wrong tries the right code is refused",
  (await verify("pat@example.com", code2!)).statusCode === 400,
);
await request("pat@example.com");
const code3 = await codeFor("pat@example.com");
ok(
  "a new request gives a working code",
  (await verify("pat@example.com", code3!)).statusCode === 200,
);

// Parallel wrong guesses cannot share one count: the 5-try limit holds.
await createCustomer({ organizationId: orgId, businessId: live.id, email: "race@example.com" });
await request("race@example.com");
const raceCode = await codeFor("race@example.com");
const raceBad = raceCode === "333333" ? "444444" : "333333";
await Promise.all(Array.from({ length: 8 }, () => verify("race@example.com", raceBad)));
const [raceRow] = (await codeRows("race@example.com")).filter((r) => !r.usedAt);
ok("parallel wrong tries stop at 5", raceRow?.attempts === 5);
ok(
  "after parallel wrong tries the right code is refused",
  (await verify("race@example.com", raceCode!)).statusCode === 400,
);

// One email, two accounts.
await request("shared@example.com");
const sc = await codeFor("shared@example.com");
const choice = body(await verify("SHARED@example.com", sc!));
ok(
  "one email on two accounts → the list to select from",
  choice.object === "portal_login_choice" && choice.customers.length === 2,
);
const picked = body(await verify("shared@example.com", sc!, shared2.publicId));
const meShared = await app.inject({
  method: "GET",
  url: "/portal/v1/me",
  headers: { authorization: `Bearer ${picked.token}` },
});
ok(
  "selecting an account opens that account",
  meShared.statusCode === 200 &&
    meShared.body.includes(shared2.publicId) &&
    !meShared.body.includes(shared1.publicId),
);

// The sign-in template must keep {{code}}.
let refused = "";
try {
  await upsertTemplate(orgId, live.id, "portal_sign_in_code", {
    subject: "Sign in",
    heading: "Sign in",
    body: "Hello",
  } as never);
} catch (e) {
  refused = (e as Error).message;
}
ok("a sign-in template without {{code}} is refused", refused.includes("{{code}}"));

// At most 5 codes an hour to one address.
const statuses: number[] = [];
for (let i = 0; i < 6; i++) statuses.push((await request("flood@example.com")).statusCode);
ok(
  "6th request for one address within an hour → 429",
  statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429,
);

// Requests without a bot-check token do not use up the address's hourly quota.
await clearPublicRateLimits();
await createCustomer({ organizationId: orgId, businessId: live.id, email: "victim@example.com" });
const tcfg = config as unknown as Record<string, string | undefined>;
const savedTurnstile = tcfg.TURNSTILE_SECRET_KEY;
tcfg.TURNSTILE_SECRET_KEY = "verify-portal-access";
const tokenless: number[] = [];
for (let i = 0; i < 6; i++) tokenless.push((await request("victim@example.com")).statusCode);
tcfg.TURNSTILE_SECRET_KEY = savedTurnstile;
ok(
  "bot check on: requests without a token → 400",
  tokenless.every((x) => x === 400),
);
ok(
  "after them the customer can still get a code",
  (await request("victim@example.com")).statusCode === 200 &&
    (await codeRows("victim@example.com")).length === 1,
);

// ── Phase 4b: single-action links, the peek, the back link ─────────────────
await setConfig(biz.id, {});
const mintFor = (customer: string, payload: object) =>
  post(`/v1/businesses/${biz.publicId}/customers/${customer}/portal_sessions`, payload, org.secret);
const payLink = await mintFor(done.customer_id, {
  action: "pay_invoice",
  object: zero.invoice.publicId,
});
const payBody = body(payLink);
ok(
  "4b: a pay_invoice link opens on that invoice",
  payLink.statusCode === 201 &&
    payBody.forward_url === `/portal?tab=invoices&pay_invoice=${zero.invoice.publicId}`,
);
ok(
  "4b: an invoice of another customer → 400",
  (await mintFor(cus.publicId, { action: "pay_invoice", object: zero.invoice.publicId }))
    .statusCode === 400,
);
ok(
  "4b: action and forward_url together → 400",
  (await mintFor(done.customer_id, { action: "update_card", forward_url: "/portal" }))
    .statusCode === 400,
);
const peek = (token: string) =>
  app.inject({
    method: "GET",
    url: "/portal/v1/session/peek",
    headers: { authorization: `Bearer ${token}` },
  });
const p1 = await peek(payBody.token);
const p1Body = body(p1);
ok(
  "4b: peek says what the link opens, and nothing sensitive",
  p1.statusCode === 200 &&
    p1Body.task === "pay_invoice" &&
    p1Body.link_kind === "api" &&
    !p1.body.includes(zero.invoice.publicId) &&
    !p1.body.includes("hide@example.com") &&
    !("amount_due_minor" in p1Body),
);
ok(
  "4b: peek is never cached and sends no referrer",
  String(p1.headers["cache-control"]).includes("no-store") &&
    p1.headers["referrer-policy"] === "no-referrer",
);
await peek(payBody.token);
const ex1 = await app.inject({
  method: "POST",
  url: "/portal/v1/session",
  headers: { authorization: `Bearer ${payBody.token}` },
});
ok("4b: two peeks, then the button's exchange still opens the portal", ex1.statusCode === 201);
ok("4b: the exchange carries the task", body(ex1).forward_url === payBody.forward_url);
const ex2 = await app.inject({
  method: "POST",
  url: "/portal/v1/session",
  headers: { authorization: `Bearer ${payBody.token}` },
});
ok(
  "4b: a second exchange after the link is spent → 401 (the expired card)",
  ex2.statusCode === 401,
);
ok("4b: a peek of a spent link → 401", (await peek(payBody.token)).statusCode === 401);

await setConfig(biz.id, { portal_actions: { pay_invoice: false } });
const offLink = body(
  await mintFor(done.customer_id, { action: "pay_invoice", object: zero.invoice.publicId }),
);
ok(
  "4b: pay_invoice turned off → the link opens the portal home, no error",
  !!offLink.token && !offLink.forward_url,
);
const emailOff = await withTenant(orgId, (tx) =>
  emailPortalLink(
    tx,
    { organizationId: orgId, businessId: biz.id, customerId: hc!.id },
    { kind: "pay_invoice", invoiceId: zero.invoice.id },
  ),
);
const offRow = (
  await withTenant(orgId, (tx) =>
    tx.select().from(portalSessions).where(eq(portalSessions.customerId, hc!.id)),
  )
).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
ok(
  "4b: an email Pay now link with the task off opens the portal home",
  !!emailOff && offRow.forwardUrl === null,
);
await setConfig(biz.id, {});
await withTenant(orgId, (tx) =>
  emailPortalLink(
    tx,
    { organizationId: orgId, businessId: biz.id, customerId: hc!.id },
    { kind: "pay_invoice", invoiceId: zero.invoice.id },
  ),
);
const emailRow = (
  await withTenant(orgId, (tx) =>
    tx.select().from(portalSessions).where(eq(portalSessions.customerId, hc!.id)),
  )
).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
ok(
  "4b: an email Pay now link is an email-kind link that opens the invoice",
  emailRow.accessKind === "email" &&
    emailRow.forwardUrl === `/portal?tab=invoices&pay_invoice=${zero.invoice.publicId}`,
);

// The back link: the business's https URL, unless the link has its own redirect_url.
const meOf = async (payload: object = {}) => {
  const t = body(await mintFor(done.customer_id, payload)).token;
  const s2 = (await exchange(t)).token;
  return body(
    await app.inject({
      method: "GET",
      url: "/portal/v1/me",
      headers: { authorization: `Bearer ${s2}` },
    }),
  );
};
ok("4b: unset → no back link", (await meOf()).return_url === null);
const patch = (cfg: object) =>
  app.inject({
    method: "PATCH",
    url: `/v1/businesses/${biz.publicId}`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
    payload: { storefront_config: cfg },
  });
ok(
  "4b: an http back link is refused",
  (await patch({ portal_return_url: "http://example.com/account" })).statusCode === 400,
);
await setConfig(biz.id, { portal_return_url: "https://example.com/account" });
ok("4b: set → the back link", (await meOf()).return_url === "https://example.com/account");
ok(
  "4b: a link's own redirect_url wins",
  (await meOf({ redirect_url: "https://example.com/app" })).return_url ===
    "https://example.com/app",
);

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);
