/**
 * verify:hosted-page-reports — the checkout and portal report pages' API.
 *
 * Seeds one business with checkout sessions stopped at each step (two paid for real over
 * HTTP, the rest placed by their timestamps), portal visits with their events, an email
 * link and the cancel flow; then reads GET /checkout_report and /portal_report and checks
 * every figure, the previous window, the filters, Reports equality and tenant isolation.
 */
import { and, asc, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import {
  checkoutSessions,
  emailMessages,
  events,
  invoices,
  payments,
  portalSessions,
  retentionEvents,
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

const org = await createOrganization({ name: "Hosted Reports Co" });
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
const A = await newBiz("Reports Biz");
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
const setRow = (orgPublic: string, set: Partial<typeof checkoutSessions.$inferInsert>) =>
  withTenant(orgId, (tx) =>
    tx.update(checkoutSessions).set(set).where(eq(checkoutSessions.publicId, orgPublic)),
  );
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

// ---------------------------------------------------------------- checkout seed
// Window: 1–10 Oct 2026 (UTC). Previous window: 21–30 Sep 2026.
const d1 = await paidCheckout(A.biz.publicId, A.price.publicId, "one@example.com");
const d2 = await paidCheckout(A.biz.publicId, A.price.publicId, "two@example.com");
const customerId = d1.r.resultingCustomerId!;
await setRow(d1.s.id, {
  createdAt: at("2026-10-02T09:59:00Z"),
  firstViewedAt: at("2026-10-02T10:00:00Z"),
  detailsSubmittedAt: at("2026-10-02T10:01:00Z"),
  paymentStartedAt: at("2026-10-02T10:02:00Z"),
  lastRemindedAt: at("2026-10-02T10:02:30Z"),
  reminderCount: 1,
  completedAt: at("2026-10-02T10:03:00Z"),
  lastUsedAt: at("2026-10-02T10:03:00Z"),
  paymentAttemptCount: 1,
  paymentFailureCount: 0,
});
await setRow(d2.s.id, {
  createdAt: at("2026-10-03T09:59:00Z"),
  firstViewedAt: at("2026-10-03T10:00:00Z"),
  detailsSubmittedAt: at("2026-10-03T10:02:00Z"),
  paymentStartedAt: at("2026-10-03T10:04:00Z"),
  completedAt: at("2026-10-03T10:06:00Z"),
  lastUsedAt: at("2026-10-03T10:06:00Z"),
  paymentAttemptCount: 1,
  paymentFailureCount: 0,
});

const placed = async (set: Partial<typeof checkoutSessions.$inferInsert>, biz = A) => {
  const s = await mint(biz.biz.publicId, biz.price.publicId);
  await setRow(s.id, { lastUsedAt: null, ...set });
  return s;
};
// Opened only; used a minute ago, so it is also "in checkout right now".
await placed({
  createdAt: at("2026-10-04T08:00:00Z"),
  firstViewedAt: at("2026-10-04T08:00:00Z"),
  lastUsedAt: new Date(Date.now() - 60_000),
});
// Details entered, left: abandoned.
await placed({
  createdAt: at("2026-10-05T08:00:00Z"),
  firstViewedAt: at("2026-10-05T08:00:00Z"),
  detailsSubmittedAt: at("2026-10-05T08:01:00Z"),
  resultingCustomerId: customerId,
  lastUsedAt: at("2026-10-05T08:02:00Z"),
});
// Payment started, two declines, left: abandoned.
await placed({
  createdAt: at("2026-10-06T08:00:00Z"),
  firstViewedAt: at("2026-10-06T08:00:00Z"),
  detailsSubmittedAt: at("2026-10-06T08:01:00Z"),
  paymentStartedAt: at("2026-10-06T08:02:00Z"),
  resultingCustomerId: customerId,
  paymentAttemptCount: 2,
  paymentFailureCount: 2,
  lastPaymentFailure: "Card declined",
  lastUsedAt: at("2026-10-06T08:03:00Z"),
});
// Completed with a coupon and no invoice (a free first period).
await placed({
  createdAt: at("2026-10-07T08:00:00Z"),
  firstViewedAt: at("2026-10-07T08:00:00Z"),
  detailsSubmittedAt: at("2026-10-07T08:01:00Z"),
  paymentStartedAt: at("2026-10-07T08:02:00Z"),
  completedAt: at("2026-10-07T08:03:00Z"),
  status: "completed",
  couponCodes: ["SAVE10"],
});
// Previous window: one opened, one completed.
await placed({ createdAt: at("2026-09-25T08:00:00Z"), firstViewedAt: at("2026-09-25T08:00:00Z") });
await placed({
  createdAt: at("2026-09-26T08:00:00Z"),
  firstViewedAt: at("2026-09-26T08:00:00Z"),
  completedAt: at("2026-09-26T08:05:00Z"),
  status: "completed",
});
// Outside both windows, and another business inside the window.
await placed({ createdAt: at("2026-10-15T08:00:00Z"), firstViewedAt: at("2026-10-15T08:00:00Z") });
await placed(
  {
    createdAt: at("2026-10-02T08:00:00Z"),
    firstViewedAt: at("2026-10-02T08:00:00Z"),
    completedAt: at("2026-10-02T08:05:00Z"),
    status: "completed",
  },
  B,
);

const get = async (bizPublicId: string, path: string, qs: string) => {
  const r = await app.inject({
    method: "GET",
    url: `/v1/businesses/${bizPublicId}/${path}?${qs}`,
    headers: { authorization: `Bearer ${org.secret}` },
  });
  return { status: r.statusCode, json: body(r) };
};

const c = await get(
  A.biz.publicId,
  "checkout_report",
  "start=2026-10-01&end=2026-10-10&compare=true",
);
ok("checkout_report answers 200", c.status === 200, c.json);
const ct = c.json.totals;
const revenue = Number(d1.inv.totalMinor) + Number(d2.inv.totalMinor);
console.log("  checkout totals:", JSON.stringify(ct));
ok("opened = 6 (window only, this business only)", ct.opened === 6, ct);
ok("completed = 3", ct.completed === 3, ct);
ok("conversion = 3 of 6 = 50%", ct.conversion_bps === 5000, ct);
ok("both paid invoices are the revenue", revenue > 0 && ct.revenue_minor === revenue, {
  revenue,
  ct,
});
ok("average order = revenue ÷ completed", ct.aov_minor === Math.round(revenue / 3), ct);
ok("abandoned = 2 (details entered, not paid, idle)", ct.abandoned === 2, ct);
ok(
  "recovered = 1, with its invoice's revenue",
  ct.recovered === 1 && ct.recovered_revenue_minor === Number(d1.inv.totalMinor),
  ct,
);
ok(
  "median time to complete = 3 min (180, 360, 180 s → 180)",
  ct.median_complete_seconds === 180,
  ct,
);
const steps = c.json.funnel.map((s: { sessions: number }) => s.sessions).join(",");
ok("funnel = 6, 5, 4, 3", steps === "6,5,4,3", c.json.funnel);
ok(
  "median from opened to details = 60 s",
  c.json.funnel[1].median_seconds_from_previous === 60,
  c.json.funnel,
);
ok(
  "previous window: 2 opened, 1 completed, 50%",
  c.json.previous?.opened === 2 &&
    c.json.previous?.completed === 1 &&
    c.json.previous?.conversion_bps === 5000,
  c.json.previous,
);
ok("10 days, one point per day", c.json.days.length === 10 && c.json.series.opened.length === 10);
ok("2 Oct holds one opened checkout", c.json.series.opened[1] === 1, c.json.series.opened);
ok(
  "series sum to the totals",
  c.json.series.opened.reduce((a: number, n: number) => a + n, 0) === 6 &&
    c.json.series.completed.reduce((a: number, n: number) => a + n, 0) === 3,
);
ok(
  "previous series has the previous completion",
  c.json.previous_series.completed.reduce((a: number, n: number) => a + n, 0) === 1,
);
const pm = c.json.payment_methods as Array<{
  method: string;
  gateway: string | null;
  paid: number;
  revenue_minor: number;
}>;
ok(
  "two paid by card on TM Test",
  pm.some(
    (m) =>
      m.method === "card" && m.gateway === "tmtest" && m.paid === 2 && m.revenue_minor === revenue,
  ),
  pm,
);
ok(
  "one completed with no payment",
  pm.some((m) => m.method === "none" && m.paid === 1),
  pm,
);
ok(
  "failures: 2 of 4 attempts, 1 checkout, reason kept",
  c.json.failures.failed_attempts === 2 &&
    c.json.failures.attempts === 4 &&
    c.json.failures.sessions_with_failure === 1 &&
    c.json.failures.reasons[0]?.reason === "Card declined",
  c.json.failures,
);
ok(
  "reminders: 1 reminded, 1 sent, recovered after the 1st",
  c.json.recovery.reminded === 1 &&
    c.json.recovery.reminders_sent === 1 &&
    c.json.recovery.by_reminder[0].recovered === 1,
  c.json.recovery,
);
ok(
  "coupon: 1 with (1 paid), 5 without (2 paid)",
  c.json.coupons.sessions_with_coupon === 1 &&
    c.json.coupons.completed_with_coupon === 1 &&
    c.json.coupons.sessions_without_coupon === 5 &&
    c.json.coupons.completed_without_coupon === 2 &&
    c.json.coupons.codes[0]?.code === "SAVE10",
  c.json.coupons,
);
ok(
  "billing country of paid checkouts",
  c.json.countries.some(
    (x: { country: string; completed: number }) => x.country === "US" && x.completed === 2,
  ),
  c.json.countries,
);
ok(
  "time bands hold every completion",
  c.json.time_to_complete.reduce((a: number, b: { completed: number }) => a + b.completed, 0) === 3,
);
ok("right now: one checkout in use", c.json.live.active_now === 1, c.json.live);
ok(
  "the link table holds API-made sessions",
  c.json.links[0]?.payment_link === null && c.json.links[0]?.opened === 6,
  c.json.links,
);

// Filters.
const byPlan = await get(
  A.biz.publicId,
  "checkout_report",
  `start=2026-10-01&end=2026-10-10&plan=${A.product.publicId}`,
);
ok("plan filter keeps every session of that plan", byPlan.json.totals?.opened === 6, byPlan.json);
const otherPlan = await get(
  A.biz.publicId,
  "checkout_report",
  "start=2026-10-01&end=2026-10-10&plan=no-such-plan",
);
ok("an unknown plan is refused", otherPlan.status === 400, otherPlan.json);
ok(
  "an unknown payment link is refused",
  (
    await get(
      A.biz.publicId,
      "checkout_report",
      "start=2026-10-01&end=2026-10-10&payment_link=plink_nope",
    )
  ).status === 400,
);
ok(
  "a window over 366 days is refused",
  (await get(A.biz.publicId, "checkout_report", "start=2024-01-01&end=2026-01-01")).status === 400,
);
ok(
  "an unknown parameter is refused",
  (await get(A.biz.publicId, "checkout_report", "start=2026-10-01&end=2026-10-10&nope=1"))
    .status === 400,
);
ok(
  "start and end are required",
  (await get(A.biz.publicId, "checkout_report", "start=2026-10-01")).status === 400,
);

// Tenant isolation.
const cb = await get(B.biz.publicId, "checkout_report", "start=2026-10-01&end=2026-10-10");
ok(
  "the other business sees only its own session",
  cb.json.totals?.opened === 1 &&
    cb.json.totals?.completed === 1 &&
    cb.json.totals?.revenue_minor === 0,
  cb.json.totals,
);

// The same figure as the Reports library, over the same 60 days.
const now = at("2026-10-10T12:00:00Z");
const wide = await get(A.biz.publicId, "checkout_report", "start=2026-08-12&end=2026-10-10");
const conv = await resolveReport(orgId, A.biz.id, "checkout_conversion", { range: "daily", now });
ok(
  "conversion equals the checkout_conversion report",
  wide.json.totals.conversion_bps === conv.headline,
  { page: wide.json.totals.conversion_bps, report: conv.headline },
);
const rem = await resolveReport(orgId, A.biz.id, "checkout_reminders", { range: "daily", now });
ok("recovered equals the checkout_reminders report", wide.json.totals.recovered === rem.headline, {
  page: wide.json.totals.recovered,
  report: rem.headline,
});
const remRev = await resolveReport(orgId, A.biz.id, "checkout_recovered_revenue", {
  range: "daily",
  now,
});
ok(
  "recovered revenue equals the checkout_recovered_revenue report",
  wide.json.totals.recovered_revenue_minor === remRev.headline,
  { page: wide.json.totals.recovered_revenue_minor, report: remRev.headline },
);

// ---------------------------------------------------------------- portal seed
async function visit(biz: typeof A, kind: "api" | "email", loginAt: string, customer = customerId) {
  const ref = await createPortalSession({
    organizationId: orgId,
    businessId: biz.biz.id,
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
const event = (biz: typeof A, actor: string, type: string, when: string, data: object) =>
  withTenant(orgId, (tx) =>
    tx.insert(events).values({
      organizationId: orgId,
      businessId: biz.biz.id,
      publicId: publicId("evt"),
      type,
      data,
      source: "api",
      actor,
      createdAt: at(when),
    }),
  );

const v1 = await visit(A, "email", "2026-10-02T12:00:00Z");
await withTenant(orgId, (tx) =>
  tx.insert(emailMessages).values({
    organizationId: orgId,
    businessId: A.biz.id,
    customerId,
    publicId: publicId("em"),
    type: "payment_failed",
    toAddress: "one@example.com",
    subject: "Payment failed",
    bodyHtml: "<p>Payment failed</p>",
    bodyText: "Payment failed",
    createdAt: v1.created,
  }),
);
await event(A, v1.id, "payment_succeeded", "2026-10-02T12:01:00Z", {
  payment: { id: d1.pay.publicId },
});
await event(A, v1.id, "invoice_paid", "2026-10-02T12:01:00Z", { invoice: { id: d1.inv.publicId } });
await event(A, v1.id, "payment_source_added", "2026-10-02T12:02:00Z", {
  payment_source: { id: "pm_XXXXXXXXXXXX01" },
});
await visit(A, "api", "2026-10-03T12:00:00Z");
const v3 = await visit(A, "api", "2026-10-05T12:00:00Z");
await event(A, v3.id, "payment_source_deleted", "2026-10-05T12:01:00Z", {
  payment_source: { id: "pm_XXXXXXXXXXXX02" },
  deletion_reason: { code: "card_replaced", text: null },
});
const pv = await visit(A, "api", "2026-09-25T12:00:00Z");
await event(A, pv.id, "payment_source_added", "2026-09-25T12:01:00Z", {
  payment_source: { id: "pm_XXXXXXXXXXXX03" },
});
// The other business: a visit with an action, inside the window.
const bCustomer = (await paidCheckout(B.biz.publicId, B.price.publicId, "other@example.com")).r
  .resultingCustomerId!;
const bv = await visit(B, "api", "2026-10-02T12:00:00Z", bCustomer);
await event(B, bv.id, "payment_source_added", "2026-10-02T12:01:00Z", {
  payment_source: { id: "pm_XXXXXXXXXXXX04" },
});
// The cancel flow: one save, one cancel after offers.
const retention = (kind: string, sub: string, when: string, extra: object = {}) =>
  withTenant(orgId, (tx) =>
    tx.insert(retentionEvents).values({
      organizationId: orgId,
      businessId: A.biz.id,
      customerId,
      subscriptionId: sub,
      kind,
      createdAt: at(when),
      ...extra,
    }),
  );
await retention("offer_accepted", d1.r.resultingSubscriptionId!, "2026-10-03T10:00:00Z", {
  offer: "pause",
  reasonCode: "too_expensive",
});
await retention("cancelled", d2.r.resultingSubscriptionId!, "2026-10-04T10:00:00Z", {
  offersShown: true,
  reasonCode: "too_expensive",
});

const p = await get(
  A.biz.publicId,
  "portal_report",
  "start=2026-10-01&end=2026-10-10&compare=true",
);
ok("portal_report answers 200", p.status === 200, p.json);
const pt = p.json.totals;
const paid = Number(d1.pay.amountMinor);
console.log("  portal totals:", JSON.stringify(pt));
ok("visits = 3, one customer", pt.visits === 3 && pt.customers === 1, pt);
ok(
  "visits with an action = 2 of 3",
  pt.visits_with_action === 2 && pt.action_rate_bps === 6667,
  pt,
);
ok(
  "paid in the portal = the payment, one invoice",
  pt.paid_minor === paid && pt.invoices_paid === 1,
  { paid, pt },
);
ok(
  "recovered from failed-payment emails = that payment",
  pt.recovered_from_failed_emails_minor === paid,
  pt,
);
ok("payment methods added = 1", pt.methods_added === 1, pt);
ok(
  "cancellations = 1, save rate = 1 of 2",
  pt.cancellations === 1 && pt.save_rate_bps === 5000,
  pt,
);
ok(
  "previous window: 1 visit, 1 method added",
  p.json.previous?.visits === 1 && p.json.previous?.methods_added === 1,
  p.json.previous,
);
const arr = Object.fromEntries(
  p.json.arrivals.map((a: { arrival: string; visits: number; paid_minor: number }) => [
    a.arrival,
    a,
  ]),
);
ok(
  "the email visit arrived from the payment-failed email",
  arr.payment_failed?.visits === 1 && arr.payment_failed?.paid_minor === paid,
  p.json.arrivals,
);
ok("two visits arrived from the API", arr.api?.visits === 2, p.json.arrivals);
ok(
  "funnel: 3 made, 3 opened, 2 acted",
  p.json.funnel.map((s: { sessions: number }) => s.sessions).join(",") === "3,3,2",
  p.json.funnel,
);
const acts = Object.fromEntries(
  p.json.actions.map((a: { action: string; count: number }) => [a.action, a.count]),
);
ok(
  "actions: paid 1, added 1, deleted 1",
  acts.paid_invoice === 1 && acts.added_method === 1 && acts.deleted_method === 1,
  acts,
);
ok(
  "delete reason kept",
  p.json.payment_methods.delete_reasons[0]?.reason === "card_replaced",
  p.json.payment_methods,
);
ok(
  "portal payments by method: card 1",
  p.json.payments.methods[0]?.method === "card" && p.json.payments.methods[0]?.paid === 1,
  p.json.payments,
);
ok(
  "retention: started 2, saw offer 2, took 1, saved 1",
  p.json.retention.started === 2 &&
    p.json.retention.saw_offer === 2 &&
    p.json.retention.accepted === 1 &&
    p.json.retention.saved === 1,
  p.json.retention,
);
ok(
  "the reason counts both",
  p.json.retention.reasons[0]?.reason === "too_expensive" &&
    p.json.retention.reasons[0]?.started === 2,
  p.json.retention.reasons,
);
ok(
  "recent visits newest first",
  p.json.recent.length === 3 && p.json.recent[0].at > p.json.recent[2].at,
  p.json.recent,
);
const arrived = await get(
  A.biz.publicId,
  "portal_report",
  "start=2026-10-01&end=2026-10-10&arrived_from=payment_failed",
);
ok(
  "arrived_from narrows to the email visit",
  arrived.json.totals?.visits === 1 && arrived.json.totals?.paid_minor === paid,
  arrived.json.totals,
);
const pb = await get(B.biz.publicId, "portal_report", "start=2026-10-01&end=2026-10-10");
ok(
  "the other business sees only its own visit",
  pb.json.totals?.visits === 1 &&
    pb.json.totals?.methods_added === 1 &&
    pb.json.totals?.paid_minor === 0,
  pb.json.totals,
);
const saves = await resolveReport(orgId, A.biz.id, "cancellation_saves", { range: "daily", now });
const pWide = await get(A.biz.publicId, "portal_report", "start=2026-08-12&end=2026-10-10");
ok(
  "save rate equals the cancellation_saves report",
  pWide.json.totals.save_rate_bps === saves.headline,
  { page: pWide.json.totals.save_rate_bps, report: saves.headline },
);

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);
