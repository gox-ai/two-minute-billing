/**
 * verify:email-report-page — the email report page's API (GET /email_report).
 *
 * Seeds one business with emails of several types and statuses (delivered, not sent to a
 * mail server, waiting, failed, bounced, complaint, skipped), a failed-payment sequence on two
 * paid invoices, and portal visits (one from an email link); then checks every figure, the
 * previous window, the filters, the portal report's figures and tenant isolation.
 */
import { and, asc, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import {
  checkoutSessions,
  emailMessages,
  events,
  invoices,
  payments,
  portalSessions,
} from "@db/schema";

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

const app = await buildApp({ logger: false });
await clearPublicRateLimits();

const org = await createOrganization({ name: "Email Report Co" });
const orgId = org.organization.id;
const newBiz = async (name: string) => {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
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
  return { biz, price, product };
};
const A = await newBiz("Email Biz");
const B = await newBiz("Other Biz");

const body = (r: { body: string }) => JSON.parse(r.body);
const mint = async (bizPublicId: string, priceId: string) => {
  const r = await app.inject({
    method: "POST",
    url: `/v1/businesses/${bizPublicId}/checkout_sessions`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
    payload: { price: priceId },
  });
  return body(r) as { token: string; id: string };
};
const call = (path: string, token: string, method: "GET" | "POST" = "GET", payload?: unknown) =>
  app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const address = {
  line1: "1 Report St",
  city: "San Francisco",
  state: "California",
  state_code: "CA",
  postal_code: "94105",
  country: "US",
  first_name: "Rep",
  last_name: "Ort",
};
const at = (iso: string) => new Date(iso);
const row = (id: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, id)),
  ).then((r) => r[0]!);

/** A real paid checkout, then moved to `viewed`. Returns its paid invoice and payment. */
async function paidCheckout(bizPublicId: string, priceId: string, email: string) {
  const s = await mint(bizPublicId, priceId);
  await call("/checkout/v1/session", s.token);
  await call("/checkout/v1/customer", s.token, "POST", { email, address });
  const done = await call("/checkout/v1/complete", s.token, "POST", { token: "tok_4242" });
  ok(`checkout ${email} completes`, done.statusCode === 201, done.body.slice(0, 200));
  const r = await row(s.id);
  const [inv] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, r.resultingSubscriptionId!))
      .orderBy(asc(invoices.createdAt))
      .limit(1),
  );
  const [pay] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, inv!.id), eq(payments.status, "succeeded"))),
  );
  return { s, r, inv: inv!, pay: pay! };
}

// ---------------------------------------------------------------- seed
// Window: 1-10 Oct 2026 (UTC). Previous window: 21-30 Sep 2026.
const d1 = await paidCheckout(A.biz.publicId, A.price.publicId, "one@example.com");
const d2 = await paidCheckout(A.biz.publicId, A.price.publicId, "two@example.com");
const c1 = d1.r.resultingCustomerId!;
const c2 = d2.r.resultingCustomerId!;
const setPaid = (invId: string, when: string) =>
  withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ paidAt: at(when) })
      .where(eq(invoices.id, invId)),
  );
await setPaid(d1.inv.id, "2026-10-02T12:01:00Z");
await setPaid(d2.inv.id, "2026-10-03T15:00:00Z");

type EmailSeed = Partial<typeof emailMessages.$inferInsert> & { type: string; createdAt: Date };
const mail = (biz: typeof A, customerId: string | null, e: EmailSeed) =>
  withTenant(orgId, (tx) =>
    tx
      .insert(emailMessages)
      .values({
        organizationId: orgId,
        businessId: biz.biz.id,
        customerId,
        publicId: publicId("em"),
        toAddress: "buyer@good.example",
        subject: e.type,
        bodyHtml: `<p>${e.type}</p>`,
        bodyText: e.type,
        status: "sent",
        transport: "smtp",
        ...e,
      })
      .returning({ publicId: emailMessages.publicId }),
  ).then((r) => r[0]!.publicId);

async function visit(kind: "api" | "email", loginAt: string, customer: string) {
  const ref = await createPortalSession({
    organizationId: orgId,
    businessId: A.biz.id,
    customerId: customer,
    kind,
  });
  const created = new Date(at(loginAt).getTime() - 60_000);
  await withTenant(orgId, (tx) =>
    tx
      .update(portalSessions)
      .set({
        createdAt: created,
        loginAt: at(loginAt),
        lastUsedAt: at(loginAt),
        status: "logged_in",
      })
      .where(eq(portalSessions.publicId, ref.publicId)),
  );
  return { id: ref.publicId, created };
}
const event = (actor: string, type: string, when: string, data: object) =>
  withTenant(orgId, (tx) =>
    tx.insert(events).values({
      organizationId: orgId,
      businessId: A.biz.id,
      publicId: publicId("evt"),
      type,
      data,
      source: "api",
      actor,
      createdAt: at(when),
    }),
  );

// The failed-payment sequence: invoice 1 gets two, paid after the second; invoice 2 gets one.
await mail(A, c1, {
  type: "payment_failed",
  invoiceId: d1.inv.id,
  createdAt: at("2026-10-01T09:00:00Z"),
});
const v1 = await visit("email", "2026-10-02T12:00:00Z", c1);
const e1 = await mail(A, c1, {
  type: "payment_failed",
  invoiceId: d1.inv.id,
  createdAt: v1.created,
});
await event(v1.id, "payment_succeeded", "2026-10-02T12:01:00Z", {
  payment: { id: d1.pay.publicId },
});
await event(v1.id, "invoice_paid", "2026-10-02T12:01:00Z", { invoice: { id: d1.inv.publicId } });
await mail(A, c2, {
  type: "payment_failed",
  invoiceId: d2.inv.id,
  createdAt: at("2026-10-03T09:00:00Z"),
});
await visit("api", "2026-10-03T12:00:00Z", c1);
// The rest of the window.
await mail(A, c1, { type: "invoice_issued", createdAt: at("2026-10-04T08:00:00Z") });
await mail(A, c1, {
  type: "invoice_issued",
  toAddress: "gone@bad.example",
  status: "bounced",
  transport: "ses",
  bounceType: "permanent",
  lastError: "550 5.1.1 gone@bad.example unknown",
  createdAt: at("2026-10-04T09:00:00Z"),
});
await mail(A, c1, {
  type: "payment_receipt",
  status: "bounced",
  bounceType: "complaint",
  createdAt: at("2026-10-05T08:00:00Z"),
});
await mail(A, c1, {
  type: "payment_receipt",
  status: "failed",
  lastError: "connect ETIMEDOUT",
  createdAt: at("2026-10-06T08:00:00Z"),
});
await mail(A, c1, {
  type: "invoice_issued",
  status: "skipped",
  lastError: "Address is suppressed after an earlier bounce or complaint.",
  createdAt: at("2026-10-07T08:00:00Z"),
});
await mail(A, c1, {
  type: "payment_receipt",
  transport: "console",
  createdAt: at("2026-10-07T09:00:00Z"),
});
const last = await mail(A, c2, {
  type: "invoice_issued",
  status: "pending",
  transport: null,
  createdAt: at("2026-10-08T08:00:00Z"),
});
// Previous window, outside both windows, and the other business.
await mail(A, c1, { type: "invoice_issued", createdAt: at("2026-09-25T08:00:00Z") });
await mail(A, c1, {
  type: "payment_receipt",
  status: "bounced",
  bounceType: "permanent",
  createdAt: at("2026-09-26T08:00:00Z"),
});
await visit("email", "2026-09-25T12:00:00Z", c1);
await mail(A, c1, { type: "invoice_issued", createdAt: at("2026-10-15T08:00:00Z") });
const bCustomer = (await paidCheckout(B.biz.publicId, B.price.publicId, "other@example.com")).r
  .resultingCustomerId!;
await mail(B, bCustomer, { type: "invoice_issued", createdAt: at("2026-10-02T08:00:00Z") });

const get = async (bizPublicId: string, path: string, qs: string) => {
  const r = await app.inject({
    method: "GET",
    url: `/v1/businesses/${bizPublicId}/${path}?${qs}`,
    headers: { authorization: `Bearer ${org.secret}` },
  });
  return { status: r.statusCode, json: body(r) };
};
const W = "start=2026-10-01&end=2026-10-10";

const e = await get(A.biz.publicId, "email_report", `${W}&compare=true`);
ok("email_report answers 200", e.status === 200, e.json);
const t = e.json.totals;
const paid = Number(d1.pay.amountMinor);
console.log("  email totals:", JSON.stringify(t));
ok("queued = 10 (window only, this business only)", t.queued === 10, t);
ok(
  "delivered 4, not sent 1, waiting 1",
  t.delivered === 4 && t.not_sent === 1 && t.pending === 1,
  t,
);
ok(
  "failed 1, bounced 1 (complaint apart), complaints 1, skipped 1",
  t.failed === 1 && t.bounced === 1 && t.complained === 1 && t.skipped === 1,
  t,
);
ok(
  "the statuses add up to the queued count",
  ["delivered", "not_sent", "pending", "failed", "bounced", "complained", "skipped"].reduce(
    (n, k) => n + t[k],
    0,
  ) === t.queued,
  t,
);
ok(
  "rates divide by what reached an outcome (7)",
  t.attempted === 7 &&
    t.delivered_bps === 5714 &&
    t.bounce_bps === 1429 &&
    t.complaint_bps === 1429,
  t,
);
ok("portal visits from email links = 1", t.link_visits === 1, t);
ok(
  "recovered = the payment made from the failed-payment email",
  t.recovered_minor === paid && paid > 0,
  { paid, t },
);
ok(
  "previous window: 2 queued, 50% delivered, 50% bounced",
  e.json.previous?.queued === 2 &&
    e.json.previous?.delivered_bps === 5000 &&
    e.json.previous?.bounce_bps === 5000,
  e.json.previous,
);
ok(
  "previous window: 1 visit from an email link",
  e.json.previous?.link_visits === 1,
  e.json.previous,
);
ok("10 days, one point per day", e.json.days.length === 10 && e.json.series.queued.length === 10);
ok(
  "series sum to the totals",
  e.json.series.queued.reduce((a: number, n: number) => a + n, 0) === 10 &&
    e.json.series.delivered.reduce((a: number, n: number) => a + n, 0) === 4,
);
ok(
  "problems = failed + bounced + complaints per day",
  e.json.series.problems.reduce((a: number, n: number) => a + n, 0) === 3,
  e.json.series.problems,
);
ok(
  "previous series holds the previous queue",
  e.json.previous_series.queued.reduce((a: number, n: number) => a + n, 0) === 2,
);
ok(
  "funnel = queued 10, delivered 4, link opened 1, paid 2",
  e.json.funnel.map((s: { sessions: number }) => s.sessions).join(",") === "10,4,1,2",
  e.json.funnel,
);
const bt = Object.fromEntries(e.json.by_type.map((r: { type: string }) => [r.type, r]));
ok(
  "payment_failed: 3 queued, 3 delivered, 1 portal visit, 2 invoices paid",
  bt.payment_failed?.queued === 3 &&
    bt.payment_failed?.delivered === 3 &&
    bt.payment_failed?.link_visits === 1 &&
    bt.payment_failed?.paid_after === 2,
  bt.payment_failed,
);
ok(
  "invoice_issued: 4 queued, 1 bounced, 1 skipped, 1 waiting",
  bt.invoice_issued?.queued === 4 &&
    bt.invoice_issued?.bounced === 1 &&
    bt.invoice_issued?.skipped === 1 &&
    bt.invoice_issued?.pending === 1,
  bt.invoice_issued,
);
ok(
  "payment_receipt: complaint, failure and not-sent counted apart",
  bt.payment_receipt?.complained === 1 &&
    bt.payment_receipt?.failed === 1 &&
    bt.payment_receipt?.not_sent === 1 &&
    bt.payment_receipt?.bounced === 0,
  bt.payment_receipt,
);
const tr = Object.fromEntries(
  e.json.by_transport.map((r: { transport: string }) => [r.transport, r]),
);
ok(
  "by transport: smtp, ses, console, unknown",
  tr.smtp?.delivered === 4 &&
    tr.ses?.bounced === 1 &&
    tr.console?.not_sent === 1 &&
    tr.unknown?.pending === 1,
  e.json.by_transport,
);
const dom = Object.fromEntries(e.json.by_domain.map((r: { domain: string }) => [r.domain, r]));
ok(
  "domains only, no address",
  e.json.by_domain.every((r: { domain: string }) => !r.domain.includes("@")) &&
    dom["bad.example"]?.bounced === 1 &&
    dom["bad.example"]?.bounce_bps === 10000,
  e.json.by_domain,
);
const rs = e.json.reasons as Array<{ outcome: string; reason: string | null; count: number }>;
ok(
  "reasons keep the response and drop the address",
  rs.some((r) => r.outcome === "bounced" && r.reason === "550 5.1.1 <address> unknown") &&
    rs.some((r) => r.outcome === "failed" && r.reason === "connect ETIMEDOUT") &&
    !JSON.stringify(rs).includes("@"),
  rs,
);
ok(
  "a complaint with no response has no reason",
  rs.some((r) => r.outcome === "complained" && r.reason === null),
  rs,
);
ok(
  "skipped by reason as stored",
  e.json.skipped_reasons[0]?.reason ===
    "Address is suppressed after an earlier bounce or complaint." &&
    e.json.skipped_reasons[0]?.count === 1,
  e.json.skipped_reasons,
);
const ds = e.json.dunning.steps;
ok(
  "failed-payment sequence: 1st sent 2 recovered 1, 2nd sent 1 recovered 1",
  ds[0].sent === 2 &&
    ds[0].recovered === 1 &&
    ds[1].sent === 1 &&
    ds[1].recovered === 1 &&
    ds[2].sent === 0,
  ds,
);
ok(
  "recent emails newest first, with the waiting one on top",
  e.json.recent.length === 10 &&
    e.json.recent[0].email === last &&
    e.json.recent[0].status === "pending",
  e.json.recent.map((r: { email: string; at: string }) => r.at),
);
const rec = e.json.recent.find((r: { email: string }) => r.email === e1);
ok(
  "the email with the opened link and the paid invoice says so",
  rec?.portal_opened === true && rec?.paid_after === true && rec?.customer_name != null,
  rec,
);
ok(
  "recent honours its limit",
  (await get(A.biz.publicId, "email_report", `${W}&recent=3`)).json.recent.length === 3,
);

// The same figures as the portal report.
const pr = await get(A.biz.publicId, "portal_report", W);
ok(
  "recovered equals the portal report's figure",
  pr.json.totals.recovered_from_failed_emails_minor === t.recovered_minor,
  { portal: pr.json.totals.recovered_from_failed_emails_minor, email: t.recovered_minor },
);
const pArr = Object.fromEntries(
  pr.json.arrivals.map((a: { arrival: string; visits: number }) => [a.arrival, a.visits]),
);
ok(
  "portal visits from payment_failed equal the portal report's arrival",
  pArr.payment_failed === bt.payment_failed?.link_visits,
  { pArr, bt: bt.payment_failed?.link_visits },
);

// Filters.
const byType = await get(A.biz.publicId, "email_report", `${W}&type=payment_failed`);
ok(
  "type filter narrows every figure",
  byType.json.totals?.queued === 3 &&
    byType.json.totals?.delivered === 3 &&
    byType.json.totals?.link_visits === 1 &&
    byType.json.totals?.recovered_minor === paid,
  byType.json.totals,
);
const noPortal = await get(A.biz.publicId, "email_report", `${W}&type=invoice_issued`);
ok(
  "a type that no failed-payment email carries recovers nothing",
  noPortal.json.totals?.queued === 4 &&
    noPortal.json.totals?.recovered_minor === 0 &&
    noPortal.json.totals?.link_visits === 0,
  noPortal.json.totals,
);
const byTransport = await get(A.biz.publicId, "email_report", `${W}&transport=ses`);
ok(
  "transport filter narrows the counts and hides the portal figures",
  byTransport.json.totals?.queued === 1 &&
    byTransport.json.totals?.bounced === 1 &&
    byTransport.json.totals?.link_visits === null &&
    byTransport.json.totals?.recovered_minor === null,
  byTransport.json.totals,
);
const unk = await get(A.biz.publicId, "email_report", `${W}&transport=unknown`);
ok(
  "transport=unknown keeps emails with no recorded transport",
  unk.json.totals?.queued === 1 && unk.json.totals?.pending === 1,
  unk.json.totals,
);
ok(
  "filter options list what was seen",
  e.json.options.types.includes("payment_failed") && e.json.options.transports.includes("ses"),
  e.json.options,
);
ok(
  "a window over 366 days is refused",
  (await get(A.biz.publicId, "email_report", "start=2024-01-01&end=2026-01-01")).status === 400,
);
ok(
  "an unknown parameter is refused",
  (await get(A.biz.publicId, "email_report", `${W}&nope=1`)).status === 400,
);
ok(
  "a bad type is refused",
  (await get(A.biz.publicId, "email_report", `${W}&type=Bad-Type`)).status === 400,
);
ok(
  "start and end are required",
  (await get(A.biz.publicId, "email_report", "start=2026-10-01")).status === 400,
);
const noKey = await app.inject({
  method: "GET",
  url: `/v1/businesses/${A.biz.publicId}/email_report?${W}`,
});
ok("no key, no report", noKey.statusCode === 401);

// Tenant isolation.
const eb = await get(B.biz.publicId, "email_report", W);
ok(
  "the other business sees only its own email",
  eb.json.totals?.queued === 1 &&
    eb.json.totals?.delivered === 1 &&
    eb.json.totals?.link_visits === 0 &&
    eb.json.by_domain.length === 1,
  eb.json.totals,
);
const cross = await get(B.biz.publicId, "email_report", `${W}&type=payment_failed`);
ok(
  "the other business has no failed-payment email",
  cross.json.totals?.queued === 0 && cross.json.recent.length === 0,
  cross.json.totals,
);

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);
