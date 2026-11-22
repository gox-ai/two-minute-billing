/**
 * verify:buyer-client-errors — the payment errors a buyer's browser reports.
 *
 * Posts reports through the real checkout and portal routes and reads the rows back: the
 * scope comes from the session, `leak` is computed (the 2026-11-17 gateway sentence is a
 * leak, our replacement is not, a field error is not), a repeat inside a few seconds is one
 * row, a bad body is refused, other credentials are refused, the per-session rate limit
 * holds, and the sweep keeps 30 days. A gateway refusal reported for the session's own open
 * intent is booked on its attempt (Last error, the attempt's Error, a browser row in the
 * gateway request log); another customer's intent, a field error, another gateway and a
 * reason already named are not.
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createCustomer } from "@/modules/customers/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import {
  BUYER_CLIENT_ERROR_RETENTION_MS,
  sweepBuyerClientErrors,
} from "@/modules/ops/buyer-client-errors";
import { BUYER_CLIENT_ERROR_RATE_PER_SESSION } from "@/api/buyer-client-error-routes";
import { buyerClientErrors, gatewayRequestLogs, paymentAttempts, paymentIntents } from "@db/schema";
import { BROWSER_REPORTED } from "@/modules/payment-intents/browser-failure";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

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

const org = await createOrganization({ name: "Client Errors Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Client Errors Biz",
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

const body = (r: { body: string }) => (r.body ? JSON.parse(r.body) : {});
const mint = async () => {
  const r = await app.inject({
    method: "POST",
    url: `/v1/businesses/${biz.publicId}/checkout_sessions`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
    payload: { price: price.publicId },
  });
  return body(r) as { token: string; id: string };
};
const report = (surface: "checkout" | "portal", token: string, payload: unknown) =>
  app.inject({
    method: "POST",
    url: `/${surface}/v1/client_errors`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as object,
  });
const rowsOf = (session: string) =>
  systemDb.select().from(buyerClientErrors).where(eq(buyerClientErrors.sessionPublicId, session));

const STRIPE_3DS =
  "We could not confirm your payment. We are unable to authenticate your payment method. Please choose a different payment method and try again.";
const OURS =
  "We could not confirm your payment. Your bank must confirm this payment. Try again, and complete the check from your bank.";

// ── Checkout ─────────────────────────────────────────────────────────────────
const link = await mint();
const leaked = await report("checkout", link.token, {
  text: STRIPE_3DS,
  step: "payment_form",
  page: "/checkout",
  gateway: "stripe",
  type: "invalid_request_error",
  code: "payment_intent_authentication_failure",
  gateway_message: "We are unable to authenticate your payment method.",
});
ok("checkout: a report answers 204", leaked.statusCode === 204);
let rows = await rowsOf(link.id);
const leakRow = rows.find((r) => r.text === STRIPE_3DS);
ok(
  "checkout: the row carries the session's tenant, surface and the gateway signal",
  leakRow?.organizationId === orgId &&
    leakRow.businessId === biz.id &&
    leakRow.surface === "checkout" &&
    leakRow.gateway === "stripe" &&
    leakRow.gatewayCode === "payment_intent_authentication_failure" &&
    leakRow.step === "payment_form",
);
ok("checkout: the gateway's own sentence is a leak", leakRow?.leak === true);

await report("checkout", link.token, { text: OURS, gateway: "stripe" });
await report("checkout", link.token, {
  text: "We could not save your payment method. Your card number is incomplete.",
  gateway: "stripe",
  type: "validation_error",
  field_error: true,
});
rows = await rowsOf(link.id);
ok("checkout: our replacement is not a leak", rows.find((r) => r.text === OURS)?.leak === false);
ok(
  "checkout: a field error is kept as one and is not a leak",
  rows.some((r) => r.fieldError && r.leak === false),
);

const again = await report("checkout", link.token, { text: STRIPE_3DS, gateway: "stripe" });
rows = await rowsOf(link.id);
ok(
  "checkout: the same text again inside a few seconds is one row",
  again.statusCode === 204 && rows.filter((r) => r.text === STRIPE_3DS).length === 1,
);

const bad = await report("checkout", link.token, { text: "" });
ok("checkout: an empty text is refused (400)", bad.statusCode === 400);
const extra = await report("checkout", link.token, { text: "x".repeat(1001) });
ok("checkout: a text past 1000 characters is refused (400)", extra.statusCode === 400);
ok(
  "checkout: the organization key is refused (401)",
  (await report("checkout", org.secret, { text: OURS })).statusCode === 401,
);
ok(
  "checkout: no token is refused (401)",
  (
    await app.inject({
      method: "POST",
      url: "/checkout/v1/client_errors",
      payload: { text: OURS },
    })
  ).statusCode === 401,
);

// ── Portal ───────────────────────────────────────────────────────────────────
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "client-errors@example.com",
});
const portal = await createPortalSession({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
});
const exchanged = await app.inject({
  method: "POST",
  url: "/portal/v1/session",
  headers: { authorization: `Bearer ${portal.accessToken}` },
});
const psst = String(body(exchanged).token ?? "");
ok("portal: the link exchanges for a session", psst.startsWith("psst_"));
const portalReport = await report("portal", psst, {
  text: "An unexpected error occurred.",
  step: "pay_invoice",
  gateway: "razorpay",
  decline_code: "BAD_REQUEST_ERROR",
});
ok("portal: a report answers 204", portalReport.statusCode === 204);
const portalRows = await rowsOf(portal.publicId);
ok(
  "portal: the row carries the customer, surface and leak",
  portalRows.length === 1 &&
    portalRows[0]!.surface === "portal" &&
    portalRows[0]!.customerId === customer.id &&
    portalRows[0]!.declineCode === "BAD_REQUEST_ERROR" &&
    portalRows[0]!.leak === true,
);
ok(
  "portal: a checkout token is refused (401)",
  (await report("portal", link.token, { text: OURS })).statusCode === 401,
);

// ── Booking a browser refusal on the session's own open intent ────────────────
const exchange = async (customerId: string) => {
  const link = await createPortalSession({ organizationId: orgId, businessId: biz.id, customerId });
  const r = await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${link.accessToken}` },
  });
  return String(body(r).token ?? "");
};
const setup = await app.inject({
  method: "POST",
  url: "/portal/v1/payment_methods/setup",
  headers: { authorization: `Bearer ${psst}`, "idempotency-key": crypto.randomUUID() },
  payload: {
    return_url: "https://portal.test/portal?setup=return",
    cancel_url: "https://portal.test/portal?setup=cancel",
  },
});
const pi = String(body(setup).payment_intent ?? "");
ok(`book: the portal setup opens an intent (${setup.statusCode})`, pi.startsWith("pi_"));
const [intentRow] = await systemDb
  .select()
  .from(paymentIntents)
  .where(eq(paymentIntents.publicId, pi));
const attemptOf = async () =>
  (
    await systemDb
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentIntentId, intentRow!.id))
  )[0]!;
const browserRows = () =>
  systemDb
    .select()
    .from(gatewayRequestLogs)
    .where(
      and(
        eq(gatewayRequestLogs.businessId, biz.id),
        eq(gatewayRequestLogs.source, "customer_browser"),
      ),
    );
const refusal = {
  gateway: "tmtest",
  type: "card_error",
  code: "card_declined",
  gateway_message: "The card was refused by the test gateway.",
  payment_intent: pi,
};

const other = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "client-errors-other@example.com",
});
const otherSession = await exchange(other.id);
await report("portal", otherSession, {
  ...refusal,
  text: "We could not save your payment method.",
});
await report("portal", psst, {
  ...refusal,
  text: "We could not save your payment method. Their field text.",
  field_error: true,
});
await report("portal", psst, { ...refusal, gateway: "stripe", text: "We could not save it. A." });
let attempt = await attemptOf();
ok(
  "book: another customer's session, a field error and another gateway book nothing",
  attempt.errorCode === null && (await browserRows()).length === 0,
);

await report("portal", psst, { ...refusal, text: "We could not save your payment method. B." });
attempt = await attemptOf();
const [intentAfter] = await systemDb
  .select()
  .from(paymentIntents)
  .where(eq(paymentIntents.id, intentRow!.id));
ok(
  `book: the attempt carries the code and the gateway's words, marked as the browser's (${attempt.errorCode}: ${attempt.errorText})`,
  attempt.errorCode === "setup_failed" &&
    attempt.errorText === `${refusal.gateway_message} ${BROWSER_REPORTED}` &&
    ["inited", "requires_action"].includes(attempt.status) &&
    intentAfter!.status === intentRow!.status,
);
const listed = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz.publicId}/payment_intents`,
  headers: { authorization: `Bearer ${org.secret}` },
});
const row = (body(listed).data as Array<{ id: string; last_error: unknown }>).find(
  (r) => r.id === pi,
);
ok(
  "book: the payment intents list shows it as Last error",
  JSON.stringify(row?.last_error) ===
    JSON.stringify({ code: "setup_failed", message: attempt.errorText }),
);
const logged = await browserRows();
ok(
  "book: one browser row in the gateway request log, under the attempt's span, no HTTP status",
  logged.length === 1 &&
    attempt.spanId != null &&
    logged[0]!.spanId === attempt.spanId &&
    logged[0]!.status === null &&
    logged[0]!.method === "BROWSER" &&
    logged[0]!.operation === "confirm (browser)" &&
    (logged[0]!.responseBody as { code?: string }).code === "card_declined",
);

// A reason our server or a webhook wrote is never replaced.
await systemDb
  .update(paymentAttempts)
  .set({ errorCode: "card_declined", errorText: "Your card was declined." })
  .where(eq(paymentAttempts.id, attempt.id));
await report("portal", psst, { ...refusal, text: "We could not save your payment method. C." });
attempt = await attemptOf();
ok(
  "book: a named reason already on the attempt stays",
  attempt.errorCode === "card_declined" && (await browserRows()).length === 1,
);

// ── Rate limit ───────────────────────────────────────────────────────────────
const loud = await mint();
const codes: number[] = [];
for (let i = 0; i <= BUYER_CLIENT_ERROR_RATE_PER_SESSION; i++)
  codes.push(
    (await report("checkout", loud.token, { text: `We could not take your payment ${i}.` }))
      .statusCode,
  );
ok(
  `rate limit: ${BUYER_CLIENT_ERROR_RATE_PER_SESSION} reports a minute, then 429`,
  codes.slice(0, -1).every((c) => c === 204) && codes.at(-1) === 429,
);

// ── Sweep ────────────────────────────────────────────────────────────────────
const now = new Date();
const [old] = await systemDb
  .insert(buyerClientErrors)
  .values({
    surface: "checkout",
    sessionPublicId: link.id,
    organizationId: orgId,
    businessId: biz.id,
    text: "Old text.",
    leak: true,
    createdAt: new Date(now.getTime() - BUYER_CLIENT_ERROR_RETENTION_MS - 60_000),
  })
  .returning({ id: buyerClientErrors.id });
const swept = await sweepBuyerClientErrors(now);
const left = await systemDb
  .select({ id: buyerClientErrors.id })
  .from(buyerClientErrors)
  .where(and(eq(buyerClientErrors.sessionPublicId, link.id)));
ok(
  "sweep: a row past 30 days is deleted, fresh rows stay",
  swept.deleted >= 1 && !left.some((r) => r.id === old!.id) && left.length >= 3,
);

console.log(
  `\n${fail === 0 ? "✅" : "❌"} verify:buyer-client-errors: ${pass} passed, ${fail} failed`,
);
await app.close();
await closeDb();
process.exit(fail === 0 ? 0 : 1);
