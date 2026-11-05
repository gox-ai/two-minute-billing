/**
 * verify:checkout-consent — recurring-charge consent, terms and the marketing opt-in.
 *
 * Drives buyer sessions over HTTP: the page's consent block, refusals for a missing box,
 * the record on completion (exact text, time, IP, opt-in on the customer), and the
 * recommended checkout settings written only for businesses created from the dashboard.
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { initialStorefrontConfig } from "@/modules/checkout/storefront-config";
import { eventCount } from "@/platform/rate-limit";
import { businesses, checkoutSessions, customers, subscriptions } from "@db/schema";
import {
  completeCheckoutForSetupIntent,
  recordCheckoutSetupIntent,
  resolveCheckoutSession,
} from "@/modules/checkout/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { getCustomerById } from "@/modules/customers/service";

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

const org = await createOrganization({ name: "Consent Co" });
const orgId = org.organization.id;
const newBiz = async (name: string, storefrontConfig?: Record<string, unknown>) => {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  if (storefrontConfig)
    await withTenant(orgId, (tx) =>
      tx.update(businesses).set({ storefrontConfig }).where(eq(businesses.id, biz.id)),
    );
  await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Team" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 4900,
    interval: "month",
  });
  return { biz, price };
};

const body = (r: { body: string }) => JSON.parse(r.body);
const mint = async (bizPublicId: string, price: string) => {
  const r = await app.inject({
    method: "POST",
    url: `/v1/businesses/${bizPublicId}/checkout_sessions`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
    payload: { price },
  });
  return body(r) as { token: string; id: string };
};
const call = (path: string, token: string, method: "GET" | "POST" = "GET", payload?: unknown) =>
  app.inject({
    method,
    url: path,
    remoteAddress: "203.0.113.7",
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const address = {
  line1: "1 Market St",
  city: "San Francisco",
  state: "California",
  state_code: "CA",
  postal_code: "94105",
  country: "US",
  first_name: "Sam",
  last_name: "Rivera",
};
const sessionRow = (publicId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, publicId)),
  ).then((r) => r[0]!);

// ── A business that asks for all three ──────────────────────────────────────
const asks = await newBiz("Asks Biz", {
  recurring_consent: true,
  require_terms: true,
  terms_url: "https://fieldnote.example/terms",
  privacy_url: "https://fieldnote.example/privacy",
  marketing_consent: true,
});
const s1 = await mint(asks.biz.publicId, asks.price.publicId);
await call("/checkout/v1/customer", s1.token, "POST", { email: "consent@example.com", address });
const view = body(await call("/checkout/v1/session", s1.token));
const consent = view.consent as {
  recurring_text: string | null;
  terms_required: boolean;
  terms_url: string | null;
  marketing_offered: boolean;
};
console.log("  consent text:", consent?.recurring_text);
ok(
  "view: recurring text names the business, the amount and the period",
  !!consent?.recurring_text &&
    consent.recurring_text.includes("Asks Biz") &&
    consent.recurring_text.includes("$49.00") &&
    consent.recurring_text.includes("every month"),
);
ok(
  "view: terms required with the URL, marketing offered",
  consent.terms_required === true &&
    consent.terms_url === "https://fieldnote.example/terms" &&
    consent.marketing_offered === true,
);

const noBox = await call("/checkout/v1/complete", s1.token, "POST", { token: "tok_4242" });
ok(
  "complete without the recurring box → 400 with the box message",
  noBox.statusCode === 400 && body(noBox).error?.message?.includes("recurring charge"),
);
const noTerms = await call("/checkout/v1/complete", s1.token, "POST", {
  token: "tok_4242",
  consent: { recurring: true },
});
ok(
  "complete without the terms box → 400 with the terms message",
  noTerms.statusCode === 400 && body(noTerms).error?.message?.includes("accept the terms"),
);
const stale = await call("/checkout/v1/complete", s1.token, "POST", {
  token: "tok_4242",
  consent: {
    recurring: true,
    terms: true,
    recurring_text: "I agree that Asks Biz charges me $1.00 every month until I cancel.",
  },
});
ok(
  "a sentence that differs from the current one → 400 (the amount changed)",
  stale.statusCode === 400 && body(stale).error?.message?.includes("The amount changed"),
);
ok("a refused completion records no consent", (await sessionRow(s1.id)).consentedAt === null);

const done = await call("/checkout/v1/complete", s1.token, "POST", {
  token: "tok_4242",
  consent: {
    recurring: true,
    terms: true,
    marketing: true,
    recurring_text: consent.recurring_text ?? undefined,
  },
});
ok("complete with every box → 201", done.statusCode === 201);
const r1 = await sessionRow(s1.id);
ok("the exact text shown is recorded", r1.recurringConsentText === consent.recurring_text);
ok(
  "consent time, terms time and IP are recorded",
  r1.consentedAt instanceof Date && r1.termsAcceptedAt instanceof Date && !!r1.consentIp,
);
const [cus] = await withTenant(orgId, (tx) =>
  tx.select().from(customers).where(eq(customers.id, r1.resultingCustomerId!)),
);
ok(
  "the marketing opt-in is on the customer with its time",
  cus?.marketingOptIn === true && cus.marketingOptInAt instanceof Date,
);
const cusApi = body(
  await app.inject({
    method: "GET",
    url: `/v1/businesses/${asks.biz.publicId}/customers/${cus!.publicId}`,
    headers: { authorization: `Bearer ${org.secret}` },
  }),
);
ok("the customer API shows marketing_opt_in", cusApi.marketing_opt_in === true);

// ── A checkout the gateway webhook completes: consent comes from /setup ─────
const redirect = {
  return_url: "https://fieldnote.example/r",
  cancel_url: "https://fieldnote.example/c",
};
/** Mint, set the buyer, POST /setup with `consentBody`, then let the webhook path finish it. */
const webhookComplete = async (email: string, consentBody?: Record<string, unknown>) => {
  const s = await mint(asks.biz.publicId, asks.price.publicId);
  await call("/checkout/v1/customer", s.token, "POST", { email, address });
  const setup = await call("/checkout/v1/setup", s.token, "POST", {
    ...redirect,
    ...(consentBody ? { consent: consentBody } : {}),
  });
  const ctx = (await resolveCheckoutSession(s.token))!;
  const intent = `pi_consent_hook_${crypto.randomUUID()}`;
  await recordCheckoutSetupIntent(ctx, intent);
  const cus = (await getCustomerById(orgId, ctx.resultingCustomerId!))!;
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: asks.biz.id,
    customer: cus,
    token: "tok_4242",
  });
  const outcome = await completeCheckoutForSetupIntent({
    organizationId: orgId,
    businessId: asks.biz.id,
    intentPublicId: intent,
    paymentMethodId: pm.id,
  });
  const subs = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, cus.id)),
  );
  return { s, setup, outcome, subs, row: await sessionRow(s.id), customerId: cus.id };
};
const noConsent = await webhookComplete("hook-none@example.com");
ok(
  "webhook path, no consent sent with /setup → not completed, nothing created",
  noConsent.setup.statusCode === 201 &&
    noConsent.outcome === "failed" &&
    noConsent.subs.length === 0 &&
    noConsent.row.status === "open",
);
const half = await mint(asks.biz.publicId, asks.price.publicId);
await call("/checkout/v1/customer", half.token, "POST", {
  email: "hook-half@example.com",
  address,
});
const halfConsent = await call("/checkout/v1/setup", half.token, "POST", {
  ...redirect,
  consent: { recurring: true },
});
ok(
  "/setup with the terms box missing → 400 with the terms message",
  halfConsent.statusCode === 400 &&
    body(halfConsent).error?.message === "Select the box to accept the terms.",
);
const hookText = consent.recurring_text ?? undefined;
const staleHook = await webhookComplete("hook-stale@example.com", {
  recurring: true,
  terms: true,
  recurring_text: "I agree that Asks Biz charges me $1.00 every month until I cancel.",
});
ok(
  "/setup with a sentence that differs from the current one → 400, and the webhook refuses",
  staleHook.setup.statusCode === 400 &&
    staleHook.outcome === "failed" &&
    staleHook.subs.length === 0,
);
const agreed = await webhookComplete("hook-agreed@example.com", {
  recurring: true,
  terms: true,
  marketing: true,
  recurring_text: hookText,
});
ok(
  "webhook path with consent sent with /setup → completed",
  agreed.setup.statusCode === 201 && agreed.outcome === "completed" && agreed.subs.length === 1,
);
ok(
  "…and the consent is recorded as at /setup: text, time, terms, IP",
  agreed.row.recurringConsentText === consent.recurring_text &&
    agreed.row.consentedAt instanceof Date &&
    agreed.row.termsAcceptedAt instanceof Date &&
    agreed.row.consentIp === "203.0.113.7",
);
const [hookCus] = await withTenant(orgId, (tx) =>
  tx.select().from(customers).where(eq(customers.id, agreed.customerId)),
);
ok("…and the marketing opt-in is on the customer", hookCus?.marketingOptIn === true);

// ── A business that asks for nothing ────────────────────────────────────────
const plain = await newBiz("Plain Biz");
const s2 = await mint(plain.biz.publicId, plain.price.publicId);
await call("/checkout/v1/customer", s2.token, "POST", { email: "plain@example.com", address });
const plainView = body(await call("/checkout/v1/session", s2.token));
ok(
  "no settings → no recurring text, no terms, no opt-in",
  plainView.consent?.recurring_text === null &&
    plainView.consent?.terms_required === false &&
    plainView.consent?.marketing_offered === false,
);
const plainDone = await call("/checkout/v1/complete", s2.token, "POST", { token: "tok_4242" });
ok("no settings → completes without any box", plainDone.statusCode === 201);
const r2 = await sessionRow(s2.id);
ok("no settings → nothing recorded", r2.consentedAt === null && r2.recurringConsentText === null);

// ── Terms without a URL ask for nothing ─────────────────────────────────────
const noUrl = await newBiz("No URL Biz", { require_terms: true });
const s3 = await mint(noUrl.biz.publicId, noUrl.price.publicId);
await call("/checkout/v1/customer", s3.token, "POST", { email: "nourl@example.com", address });
ok(
  "require_terms without terms_url → terms not required",
  body(await call("/checkout/v1/session", s3.token)).consent?.terms_required === false,
);

// ── Bot check: failed payments are counted per IP ───────────────────────────
const guarded = await newBiz("Guarded Biz", { bot_check_after_failures: 1 });
const s4 = await mint(guarded.biz.publicId, guarded.price.publicId);
await call("/checkout/v1/customer", s4.token, "POST", { email: "guard@example.com", address });
const failuresFor203 = () =>
  eventCount({
    scope: "checkout_payment_failure",
    kind: "ip",
    value: "203.0.113.7",
    windowMs: 86_400_000,
  });
const before = await failuresFor203();
const declined = await call("/checkout/v1/complete", s4.token, "POST", {
  token: "tok_4000000000000341",
});
ok("a declined payment answers 400", declined.statusCode === 400);
ok("the decline adds one failure for the IP", (await failuresFor203()) === before + 1);
const retried = await call("/checkout/v1/complete", s4.token, "POST", { token: "tok_4242" });
ok(
  "over the threshold with no Turnstile secret configured, the check is skipped",
  retried.statusCode === 201,
);

// ── Recommended settings only for businesses a person creates ───────────────
ok(
  "a signed-in person gets the recommended checkout settings",
  (() => {
    const c = initialStorefrontConfig({ hasOperator: true });
    return c?.checkout_layout === "one_page" && c?.recurring_consent === true;
  })(),
);
ok("a key gets no initial settings", initialStorefrontConfig({ hasOperator: false }) === undefined);
const dashKey = await createApiKey(orgId, "test", "dashboard");
for (const [label, secret] of [
  ["the organization's first key", org.secret],
  ["a dashboard-kind key", dashKey.secret],
] as const) {
  const created = body(
    await app.inject({
      method: "POST",
      url: "/v1/businesses",
      headers: { authorization: `Bearer ${secret}`, "idempotency-key": crypto.randomUUID() },
      payload: { name: `Via ${label}`, default_currency: "USD", livemode: "test" },
    }),
  );
  ok(
    `a business created with ${label} keeps the engine defaults`,
    created.storefront_config?.checkout_layout === undefined &&
      created.storefront_config?.recurring_consent === undefined,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);
