/**
 * verify:checkout-funnel — the checkout funnel report and the step it needed.
 *
 * Drives buyer sessions over HTTP to each step (the payment stamp lives in the routes),
 * then reads the `checkout_funnel` report. Also holds: the stamp is set once, a step
 * counts sessions that went further, plan-change links and other businesses stay out.
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { checkoutSessions } from "@db/schema";

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

const org = await createOrganization({ name: "Funnel Co" });
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
  return { biz, price };
};
const { biz, price } = await newBiz("Funnel Biz");
const other = await newBiz("Other Biz");

const body = (r: { body: string }) => JSON.parse(r.body);
const mint = async (bizPublicId: string, payload: object) => {
  const r = await app.inject({
    method: "POST",
    url: `/v1/businesses/${bizPublicId}/checkout_sessions`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
    payload,
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
  line1: "1 Funnel St",
  city: "San Francisco",
  state: "California",
  state_code: "CA",
  postal_code: "94105",
  country: "US",
  first_name: "Fun",
  last_name: "Nel",
};
const setupPayload = {
  return_url: "https://portal.test/done",
  cancel_url: "https://portal.test/back",
};
const row = (publicId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, publicId)),
  ).then((r) => r[0]!);
const createLink = () => mint(biz.publicId, { price: price.publicId });

// One session stopped at each step.
const sCreated = await createLink();
const sOpened = await createLink();
await call("/checkout/v1/session", sOpened.token);
const sDetails = await createLink();
await call("/checkout/v1/session", sDetails.token);
await call("/checkout/v1/customer", sDetails.token, "POST", {
  email: "details@example.com",
  address,
});
ok("details step leaves payment unstamped", (await row(sDetails.id)).paymentStartedAt === null);

const sPayment = await createLink();
await call("/checkout/v1/session", sPayment.token);
await call("/checkout/v1/customer", sPayment.token, "POST", {
  email: "payment@example.com",
  address,
});
const setup = await call("/checkout/v1/setup", sPayment.token, "POST", setupPayload);
ok("setup answers 201", setup.statusCode === 201);
const stamped = (await row(sPayment.id)).paymentStartedAt;
ok("setup stamps payment_started_at", stamped instanceof Date);
await call("/checkout/v1/setup", sPayment.token, "POST", setupPayload);
ok(
  "a second setup keeps the first stamp",
  (await row(sPayment.id)).paymentStartedAt?.getTime() === stamped?.getTime(),
);

const sDone = await createLink();
await call("/checkout/v1/session", sDone.token);
await call("/checkout/v1/customer", sDone.token, "POST", { email: "done@example.com", address });
const done = await call("/checkout/v1/complete", sDone.token, "POST", { token: "tok_4242" });
ok("complete answers 201", done.statusCode === 201);
const doneRow = await row(sDone.id);
ok(
  "complete with no setup stamps payment_started_at",
  doneRow.paymentStartedAt instanceof Date && doneRow.completedAt instanceof Date,
);

// Left out: a plan-change link, another business's link, a link older than the window.
const change = await mint(biz.publicId, {
  mode: "change",
  subscription: String(body(done).subscription_id),
});
await call("/checkout/v1/session", change.token);
const otherLink = await mint(other.biz.publicId, { price: other.price.publicId });
await call("/checkout/v1/session", otherLink.token);
const old = await createLink();
await withTenant(orgId, (tx) =>
  tx
    .update(checkoutSessions)
    .set({ createdAt: new Date(Date.now() - 2 * 365 * 86_400_000) })
    .where(eq(checkoutSessions.publicId, old.id)),
);

const funnel = () => resolveReport(orgId, biz.id, "checkout_funnel", { range: "12m" });
const counts = (r: Awaited<ReturnType<typeof funnel>>) =>
  Object.fromEntries((r.rows ?? []).map((x) => [x.group, x.value]));
const r1 = await funnel();
const c1 = counts(r1);
console.log("  funnel:", JSON.stringify(c1));
ok("report is a funnel of buckets", r1.shape === "buckets" && r1.funnel === true);
ok(
  "rows are the five steps, in order",
  (r1.rows ?? []).map((x) => x.group).join("|") ===
    "Links created|Opened|Details entered|Payment started|Completed",
);
ok("links created = 5 (change, other business and old link left out)", c1["Links created"] === 5);
ok("opened = 4", c1.Opened === 4);
ok("details entered = 3", c1["Details entered"] === 3);
ok("payment started = 2", c1["Payment started"] === 2);
ok("completed = 1, and it is the headline", c1.Completed === 1 && r1.headline === 1);
ok("unused link exists but counts only as created", (await row(sCreated.id)).lastUsedAt === null);

// A session completed before 0343 has no stamp; it still counts as having paid.
await withTenant(orgId, (tx) =>
  tx
    .update(checkoutSessions)
    .set({ paymentStartedAt: null })
    .where(eq(checkoutSessions.publicId, sDone.id)),
);
ok(
  "an unstamped completed session still counts as payment started",
  counts(await funnel())["Payment started"] === 2,
);

const otherFunnel = counts(
  await resolveReport(orgId, other.biz.id, "checkout_funnel", { range: "12m" }),
);
ok("the other business sees only its own link", otherFunnel["Links created"] === 1);

// 0478: view, details, attempts and failures, and the conversion and failure reports.
const sTrack = await createLink();
const viewed = await call("/checkout/v1/viewed", sTrack.token, "POST", {
  layout: "one_page",
  device_class: "mobile",
});
ok("viewed answers 200", viewed.statusCode === 200);
const firstView = (await row(sTrack.id)).firstViewedAt;
await call("/checkout/v1/viewed", sTrack.token, "POST", {
  layout: "steps",
  device_class: "desktop",
});
const tracked = await row(sTrack.id);
ok(
  "a second view keeps the first view's time, layout and device",
  tracked.firstViewedAt?.getTime() === firstView?.getTime() &&
    tracked.layout === "one_page" &&
    tracked.deviceClass === "mobile",
);
ok(
  "viewed refuses an unknown layout",
  (await call("/checkout/v1/viewed", sTrack.token, "POST", { layout: "x", device_class: "mobile" }))
    .statusCode === 400,
);
await call("/checkout/v1/customer", sTrack.token, "POST", { email: "track@example.com", address });
ok("details stamp details_submitted_at", (await row(sTrack.id)).detailsSubmittedAt instanceof Date);
const declined = await call("/checkout/v1/complete", sTrack.token, "POST", {
  token: "tok_4000000000000341",
});
ok("a declined first charge answers 400", declined.statusCode === 400);
const afterDecline = await row(sTrack.id);
ok(
  "a decline counts one attempt and one failure, with its reason",
  afterDecline.paymentAttemptCount === 1 &&
    afterDecline.paymentFailureCount === 1 &&
    (afterDecline.lastPaymentFailure ?? "").length > 0,
);
const paid = await call("/checkout/v1/complete", sTrack.token, "POST", { token: "tok_4242" });
ok("the retry with a good card completes", paid.statusCode === 201);
const afterPaid = await row(sTrack.id);
ok(
  "the successful retry counts an attempt and no failure",
  afterPaid.paymentAttemptCount === 2 && afterPaid.paymentFailureCount === 1,
);
await call("/checkout/v1/complete", sTrack.token, "POST", { token: "tok_4242" });
ok(
  "a replayed completion is not another attempt",
  (await row(sTrack.id)).paymentAttemptCount === 2,
);

const sSteps = await createLink();
await call("/checkout/v1/viewed", sSteps.token, "POST", {
  layout: "steps",
  device_class: "desktop",
});

const conversion = await resolveReport(orgId, biz.id, "checkout_conversion", { range: "12m" });
const byGroup = Object.fromEntries((conversion.rows ?? []).map((x) => [x.group, x.value]));
console.log("  conversion:", JSON.stringify(byGroup), "headline", conversion.headline);
ok("one page on a phone converted 100%", byGroup["One page · Phone"] === 10000);
ok("steps on desktop converted 0%", byGroup["Steps · Desktop"] === 0);
ok("the headline is 1 of 2 viewed = 50%", conversion.headline === 5000);
ok(
  "sessions with no view stamp are left out",
  Object.keys(byGroup).every((g) => !g.startsWith("Unknown")),
);
const failures = await resolveReport(orgId, biz.id, "checkout_payment_failures", { range: "12m" });
const failGroups = Object.fromEntries((failures.rows ?? []).map((x) => [x.group, x.value]));
ok("one page on a phone: 1 of 2 attempts failed = 50%", failGroups["One page · Phone"] === 5000);
ok("a segment with no attempts is left out", !("Steps · Desktop" in failGroups));

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);
