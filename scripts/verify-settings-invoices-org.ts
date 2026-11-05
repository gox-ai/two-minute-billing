/**
 * verify:settings-invoices-org — five settings and their defaults (= behaviour before them):
 *   A. exchange rate on documents (`invoice_customization.common.show_exchange_rate`)
 *   B. zero-value invoices (`email_config.attachments.invoice_issued.skipZeroSend`)
 *   C. card limit per currency (`businesses.card_payment_limits`)
 *   D. exclude a customer from reporting (`customers.exclude_from_reporting`)
 *   E. organization session policy (`organizations.session_*`, `mfa_required_roles`)
 *   H. a stored retired email key (`attachInvoicePdf`) does not block an email settings save
 */
import "@/modules/emails/outbox";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer, updateCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { collectInvoice, createInvoiceFromLines } from "@/modules/invoicing/service";
import {
  assembleInvoiceDocument,
  printedExchangeRate,
  printedRate,
} from "@/modules/invoicing/document";
import { renderInvoiceHtml } from "@/modules/invoicing/ops";
import {
  DEFAULT_CUSTOMIZATION,
  initialDocumentConfig,
  resolveInvoiceCustomization,
} from "@/modules/invoicing/customization";
import {
  CARD_LIMIT_CODE,
  CARD_LIMIT_MESSAGE,
  cardLimitFor,
  overCardLimit,
  resolveCardPaymentLimits,
} from "@/modules/invoicing/card-limit";
import { classifyDecline, PARK_EVEN_IN_FIXED_MODE } from "@/modules/subscriptions/decline-policy";
import { attachmentRule, resolveEmailConfig } from "@/modules/emails/config";
import { computeBusinessMetrics } from "@/modules/metrics/service";
import { computeBusinessAnalytics } from "@/modules/metrics/analytics";
import { signup, resolveSession, roleRequiresMfa } from "@/modules/auth/service";
import {
  effectiveAbsoluteTtlHours,
  effectiveIdleMinutes,
  rolesRequiringMfa,
  sessionPolicyError,
  SessionPolicyError,
  setOrganizationSessionPolicy,
} from "@/modules/auth/session-policy";
import { TwoFactorSetupRequiredError } from "@/modules/auth/org-two-factor";
import {
  customers,
  disputes,
  emailMessages,
  gatewayAccounts,
  payments,
  invoices,
  metricDaily,
  organizations,
  paymentMethods,
  sessions,
} from "@db/schema";
import { chargeBeforeSubscriptionInvoice } from "@/modules/invoicing/collection";
import { createPaymentIntent, PaymentIntentError } from "@/modules/payment-intents/service";
import {
  chargePaymentRequest,
  createPaymentRequest,
  PaymentRequestError,
} from "@/modules/payment-requests/service";
import { computeDisputeMeasures } from "@/modules/metrics/daily/dispute-measures";
import { computePaymentMethodMeasures } from "@/modules/metrics/daily/payment-method-measures";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { reportingSpanStart } from "@/modules/metrics/reportable";
import { restateMetricsFrom } from "@/modules/metrics/daily/recompute";
import { CheckoutError, purchaseIntentRefusal } from "@/modules/checkout/service";
import { bulkFillMetricDays } from "@/modules/metrics/daily/bulk-fill";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { businesses } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const rnd = () => Math.random().toString(36).slice(2, 10);

const org = await createOrganization({ name: "Settings P1D Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Settings P1D Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const bizPid = biz.publicId;
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: `p1d-${rnd()}@example.com`,
});

// ── A. Exchange rate on documents ─────────────────────────────────────────────
{
  ok(
    "A1 default customization does not show the rate",
    !DEFAULT_CUSTOMIZATION.common.showExchangeRate,
  );
  ok(
    "A2 an untouched business resolves Off",
    !resolveInvoiceCustomization(biz).common.showExchangeRate,
  );
  ok(
    "A3 a business a person creates starts On",
    JSON.stringify(initialDocumentConfig({ hasOperator: true })) ===
      JSON.stringify({ common: { show_exchange_rate: true } }),
  );
  ok("A4 a key-created business keeps the default", initialDocumentConfig({}) === undefined);
  ok("A5 a fresh business row stores no customization", biz.invoiceCustomization == null);
  const on = resolveInvoiceCustomization({
    invoiceCustomization: { common: { show_exchange_rate: true } },
  });
  ok(
    "A6 printed rate drops numeric padding and rounds to 4 places",
    printedExchangeRate(on, {
      currency: "INR",
      exchangeRate: "94.9537410000",
      exchangeRateBase: "USD",
    })?.rate === "94.9537",
  );
  ok(
    "A7 no row in the default currency",
    printedExchangeRate(on, { currency: "USD", exchangeRate: "1", exchangeRateBase: "USD" }) ===
      null,
  );
  ok(
    "A8 no row without a recorded rate",
    printedExchangeRate(on, { currency: "INR", exchangeRate: null, exchangeRateBase: null }) ===
      null,
  );

  await updateBusiness(orgId, bizPid, { exchangeRates: { INR: 94.95 } });
  const { invoice } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    currency: "INR",
    lines: [{ description: "FX line", amountMinor: 50000n }],
  });
  const off = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
  ok("A9 Off: the document has no exchange-rate row", off?.meta.exchangeRate === null);
  await updateBusiness(orgId, bizPid, {
    invoiceCustomization: { common: { show_exchange_rate: true } },
  });
  const doc = await assembleInvoiceDocument(orgId, biz.id, invoice.publicId);
  const fx = doc?.meta.exchangeRate;
  ok(
    "A10 On: the stamped rate prints (1 USD = 94.95 INR)",
    fx?.base === "USD" && fx.currency === "INR" && fx.rate === "94.95",
  );
  const html = await renderInvoiceHtml(orgId, biz.id, invoice.publicId);
  ok("A11 the HTML view shows the row", !!html?.includes("1 USD = 94.95 INR"));
  const { invoice: usdInv } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    currency: "USD",
    lines: [{ description: "home currency", amountMinor: 1000n }],
  });
  const usdDoc = await assembleInvoiceDocument(orgId, biz.id, usdInv.publicId);
  ok("A12 On: a default-currency invoice still shows no row", usdDoc?.meta.exchangeRate === null);
  ok(
    "A13 a printed rate is cut to 4 places, half up, zeros trimmed",
    printedRate("94.9450549451") === "94.9451" &&
      printedRate("94.9500000000") === "94.95" &&
      printedRate("1.99995") === "2" &&
      printedRate("83") === "83",
  );
  ok(
    "A15 a rate below 1 keeps 4 significant digits (0.000039, VND to USD)",
    printedRate("0.0000393012") === "0.0000393" && printedRate("0.000039") === "0.000039",
  );
  await updateBusiness(orgId, bizPid, { exchangeRates: { INR: 94.9450549451 } });
  const { invoice: longRate } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    currency: "INR",
    lines: [{ description: "long rate", amountMinor: 50000n }],
  });
  const longHtml = await renderInvoiceHtml(orgId, biz.id, longRate.publicId);
  const [stamped] = await withTenant(orgId, (tx) =>
    tx.select({ rate: invoices.exchangeRate }).from(invoices).where(eq(invoices.id, longRate.id)),
  );
  ok(
    "A14 the document prints 94.9451; the stored rate keeps every digit",
    !!longHtml?.includes("1 USD = 94.9451 INR") && stamped?.rate === "94.9450549451",
  );
  await updateBusiness(orgId, bizPid, { invoiceCustomization: null });
}

// ── B. Zero-value invoices ────────────────────────────────────────────────────
{
  ok(
    "B1 default: the invoice email is sent for a zero total",
    attachmentRule(resolveEmailConfig({ emailConfig: null }), "invoice_issued")?.skipZeroSend ===
      false,
  );
  await updateBusiness(orgId, bizPid, { emailConfig: { enabled: true } });
  const zero = async () =>
    (
      await createInvoiceFromLines({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        currency: "USD",
        lines: [{ description: "free", amountMinor: 0n }],
      })
    ).invoice;
  const mails = (invoiceId: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(
          and(eq(emailMessages.invoiceId, invoiceId), eq(emailMessages.type, "invoice_issued")),
        ),
    );
  const sent = await zero();
  ok("B2 a zero-total invoice is finalized as paid", sent.status === "paid");
  ok("B3 Finalize and send (today): one invoice email", (await mails(sent.id)).length === 1);
  await updateBusiness(orgId, bizPid, {
    emailConfig: {
      enabled: true,
      attachments: { invoice_issued: { pdf: true, skipZeroPdf: false, skipZeroSend: true } },
    },
  });
  const quiet = await zero();
  ok("B4 Finalize, do not send: still finalized as paid", quiet.status === "paid");
  ok("B5 Finalize, do not send: no invoice email", (await mails(quiet.id)).length === 0);
  await updateBusiness(orgId, bizPid, { emailConfig: null });
}

// ── C. Card limit per currency ────────────────────────────────────────────────
{
  ok("C1 no column = no limit", cardLimitFor({ cardPaymentLimits: null }, "USD") === null);
  ok(
    "C2 malformed entries are dropped",
    Object.keys(
      resolveCardPaymentLimits({ cardPaymentLimits: { USD: -1, eur: 500, X: 1 } }),
    ).join() === "EUR",
  );
  ok(
    "C3 equal to the limit is allowed",
    !overCardLimit({ cardPaymentLimits: { USD: 1000 } }, "USD", 1000n),
  );
  ok(
    "C4 above the limit is refused",
    overCardLimit({ cardPaymentLimits: { USD: 1000 } }, "usd", 1001n),
  );
  ok(
    "C5 another currency has no limit",
    !overCardLimit({ cardPaymentLimits: { USD: 1000 } }, "EUR", 10n ** 9n),
  );
  ok("C6 the refusal parks dunning", classifyDecline(CARD_LIMIT_CODE) === "park");
  ok("C7 …in fixed mode too", PARK_EVEN_IN_FIXED_MODE.has(CARD_LIMIT_CODE));

  const payer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `p1d-card-${rnd()}@example.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: payer,
    token: "tok_4242",
  });
  const open = async (amountMinor: bigint) =>
    (
      await createInvoiceFromLines({
        organizationId: orgId,
        businessId: biz.id,
        customerId: payer.id,
        currency: "USD",
        lines: [{ description: "card limit", amountMinor }],
      })
    ).invoice;
  const reread = (id: string) =>
    withTenant(orgId, (tx) => tx.select().from(invoices).where(eq(invoices.id, id)).limit(1)).then(
      (r) => r[0]!,
    );

  const offInv = await open(150000n);
  const offPay = await collectInvoice({
    organizationId: orgId,
    businessId: biz.id,
    invoice: offInv,
  });
  ok("C8 Off (today): a large invoice is charged to the card", offPay.status === "succeeded");

  await updateBusiness(orgId, bizPid, { cardPaymentLimits: { USD: 100000 } });
  const big = await open(150000n);
  const refused = await collectInvoice({ organizationId: orgId, businessId: biz.id, invoice: big });
  ok("C9 above the limit: no card charge, the attempt is booked", refused.status === "failed");
  ok("C10 …with code card_limit_exceeded", refused.failureCode === CARD_LIMIT_CODE);
  ok("C11 …and no gateway was asked", refused.providerKey === "none");
  const after = await reread(big.id);
  // A one-time invoice is not dunned by default: it stays owed with no automatic retry.
  ok(
    "C12 the invoice stays owed, with no automatic retry",
    after.status === "not_paid" && after.nextAttemptAt === null && after.paidAt === null,
  );
  await updateBusiness(orgId, bizPid, {
    dunningConfig: { enabled: true, dun_one_time_invoices: true },
  });
  const dunned = await open(150000n);
  await collectInvoice({ organizationId: orgId, businessId: biz.id, invoice: dunned });
  const retried = await reread(dunned.id);
  ok(
    "C13 where dunning applies, it follows the schedule like any refused attempt",
    retried.status === "payment_due" && retried.dunningStatus === "in_progress",
  );
  await updateBusiness(orgId, bizPid, {
    dunningConfig: { enabled: true, dun_one_time_invoices: true, park_hard_declines: true },
  });
  const parkedInv = await open(150000n);
  await collectInvoice({ organizationId: orgId, businessId: biz.id, invoice: parkedInv });
  const parked = await reread(parkedInv.id);
  ok(
    "C13b with parking on, it parks: open, no automatic retry",
    parked.status === "payment_due" &&
      parked.dunningStatus === "parked" &&
      parked.nextAttemptAt === null,
  );
  await updateBusiness(orgId, bizPid, { dunningConfig: null });

  const small = await open(90000n);
  const paid = await collectInvoice({ organizationId: orgId, businessId: biz.id, invoice: small });
  ok("C14 under the limit: the card is charged", paid.status === "succeeded");
  await updateBusiness(orgId, bizPid, { cardPaymentLimits: null });
}

// ── D. Exclude a customer from reporting ──────────────────────────────────────
{
  const rbiz = await createBusiness({
    organizationId: orgId,
    name: "Reporting Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const product = await createProduct({ organizationId: orgId, businessId: rbiz.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: rbiz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const subscribe = async () => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: rbiz.id,
      email: `p1d-rep-${rnd()}@example.com`,
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: rbiz.id,
      customer: c,
      token: "tok_4242",
    });
    await createSubscription({
      organizationId: orgId,
      businessId: rbiz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    });
    return c;
  };
  const kept = await subscribe();
  const internal = await subscribe();
  ok("D1 a new customer is reported (default off)", internal.excludeFromReporting === false);

  const usdMrr = (m: Awaited<ReturnType<typeof computeBusinessMetrics>>) =>
    m.currencies.find((c) => c.currency === "USD")?.mrr_minor ?? 0;
  const before = await computeBusinessMetrics(orgId, rbiz.id, new Date());
  ok("D2 both customers count before", before.subscribers.active === 2 && usdMrr(before) === 10000);

  await updateCustomer({
    organizationId: orgId,
    businessId: rbiz.id,
    customerPublicId: internal.publicId,
    excludeFromReporting: true,
  });
  const during = await computeBusinessMetrics(orgId, rbiz.id, new Date());
  ok("D3 excluded: metrics count one subscription", during.subscribers.active === 1);
  ok("D4 excluded: MRR is the other customer's only", usdMrr(during) === 5000);
  const home = await computeBusinessAnalytics(orgId, rbiz.id, { currency: "USD" });
  ok("D5 excluded: Business Home MRR leaves it out", home.kpis.mrr.value === 5000);
  ok(
    "D6 excluded: Business Home active count leaves it out",
    home.kpis.active_subscriptions.value === 1,
  );

  await updateCustomer({
    organizationId: orgId,
    businessId: rbiz.id,
    customerPublicId: internal.publicId,
    excludeFromReporting: false,
  });
  const restored = await computeBusinessMetrics(orgId, rbiz.id, new Date());
  ok(
    "D7 cleared: the customer is counted again",
    restored.subscribers.active === 2 && usdMrr(restored) === 10000,
  );
  ok("D8 the kept customer was never touched", kept.excludeFromReporting === false);
}

// ── E. Organization session policy ────────────────────────────────────────────
{
  ok(
    "E1 unset idle = the installation value",
    effectiveIdleMinutes(null) === config.SESSION_IDLE_MINUTES,
  );
  ok(
    "E2 unset lifetime = the installation value",
    effectiveAbsoluteTtlHours({ sessionAbsoluteTtlHours: null }) ===
      config.SESSION_ABSOLUTE_TTL_HOURS,
  );
  ok(
    "E3 a shorter idle wins",
    effectiveIdleMinutes({ sessionIdleMinutes: 5 }) === Math.min(5, config.SESSION_IDLE_MINUTES),
  );
  ok(
    "E4 a longer idle cannot loosen it",
    effectiveIdleMinutes({ sessionIdleMinutes: config.SESSION_IDLE_MINUTES + 100 }) ===
      config.SESSION_IDLE_MINUTES,
  );
  ok(
    "E5 unset roles = the installation roles",
    rolesRequiringMfa(null).join() === config.MFA_REQUIRED_ROLES.join(),
  );
  ok("E6 org roles are added", rolesRequiringMfa({ mfaRequiredRoles: ["ops"] }).includes("ops"));
  ok("E7 roleRequiresMfa reads the org", roleRequiresMfa("ops", { mfaRequiredRoles: ["ops"] }));
  ok(
    "E8 a looser idle is refused",
    sessionPolicyError({
      sessionIdleMinutes: config.SESSION_IDLE_MINUTES + 1,
      sessionAbsoluteTtlHours: null,
      mfaRequiredRoles: null,
    }) !== null,
  );
  ok(
    "E9 an unknown role is refused",
    sessionPolicyError({
      sessionIdleMinutes: null,
      sessionAbsoluteTtlHours: null,
      mfaRequiredRoles: ["root"],
    }) !== null,
  );

  const s = await signup({
    email: `p1d-auth-${rnd()}@example.com`,
    password: `Pw-${rnd()}-${rnd()}-Zq9!`,
    organizationName: "Session Org",
  });
  const sOrg = s.user.organizationId;
  const tokenHash = createHash("sha256").update(s.token).digest("hex");
  ok("E10 a session resolves with no org policy", (await resolveSession(s.token)) !== null);

  let refused = false;
  try {
    await setOrganizationSessionPolicy({
      organizationId: sOrg,
      actorUserId: s.user.userId,
      actorRole: "owner",
      policy: {
        sessionIdleMinutes: config.SESSION_IDLE_MINUTES + 1,
        sessionAbsoluteTtlHours: null,
        mfaRequiredRoles: null,
      },
    });
  } catch (e) {
    refused = e instanceof SessionPolicyError;
  }
  ok("E11 the API refuses a looser idle timeout", refused);
  let locked = false;
  try {
    await setOrganizationSessionPolicy({
      organizationId: sOrg,
      actorUserId: s.user.userId,
      actorRole: "owner",
      policy: {
        sessionIdleMinutes: null,
        sessionAbsoluteTtlHours: null,
        mfaRequiredRoles: ["owner"],
      },
    });
  } catch (e) {
    locked = e instanceof TwoFactorSetupRequiredError;
  }
  ok("E12 an owner without 2FA cannot require it for owners", locked);

  const idle = Math.min(5, config.SESSION_IDLE_MINUTES);
  const saved = await setOrganizationSessionPolicy({
    organizationId: sOrg,
    actorUserId: s.user.userId,
    actorRole: "owner",
    policy: { sessionIdleMinutes: idle, sessionAbsoluteTtlHours: 1, mfaRequiredRoles: ["ops"] },
  });
  ok("E13 a stricter policy saves", saved.changed);
  ok(
    "E14 the session still resolves, now on the shorter window",
    (await resolveSession(s.token)) !== null,
  );
  const [row] = await systemDb
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  ok(
    "E15 the idle deadline was pulled in to the org window",
    !!row && row.expiresAt.getTime() <= Date.now() + idle * 60_000 + 1000,
  );
  await systemDb
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - 2 * 3600_000) })
    .where(eq(sessions.tokenHash, tokenHash));
  ok(
    "E16 past the org's 1-hour lifetime the session ends",
    (await resolveSession(s.token)) === null,
  );
  const [o] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, sOrg))
    .limit(1);
  ok("E17 stored roles", (o?.mfaRequiredRoles ?? []).join() === "ops");

  // A session idle longer than a window the org shortened later must end, not be refreshed.
  const t = await signup({
    email: `p1d-idle-${rnd()}@example.com`,
    password: `Pw-${rnd()}-${rnd()}-Zq9!`,
    organizationName: "Idle Org",
  });
  const env = config.SESSION_IDLE_MINUTES;
  const orgIdle = 5;
  const idleFor = Math.min(env - 1, 20);
  await setOrganizationSessionPolicy({
    organizationId: t.user.organizationId,
    actorUserId: t.user.userId,
    actorRole: "owner",
    policy: { sessionIdleMinutes: orgIdle, sessionAbsoluteTtlHours: null, mfaRequiredRoles: null },
  });
  const tHash = createHash("sha256").update(t.token).digest("hex");
  const stampedAt = (idleMin: number, lastActive: boolean) =>
    systemDb
      .update(sessions)
      .set({
        // Stamped with the installation window when the member was last active.
        expiresAt: new Date(Date.now() + (env - idleMin) * 60_000),
        lastActiveAt: lastActive ? new Date(Date.now() - idleMin * 60_000) : null,
      })
      .where(eq(sessions.tokenHash, tHash));
  await stampedAt(2, true);
  ok(
    "E18 active 2 minutes ago: still inside a 5-minute org window",
    (await resolveSession(t.token)) !== null,
  );
  await stampedAt(idleFor, true);
  ok(
    `E19 idle ${idleFor} minutes under a ${orgIdle}-minute org window: rejected, not refreshed`,
    env > orgIdle + 1 ? (await resolveSession(t.token)) === null : true,
  );
  const u = await signup({
    email: `p1d-idle2-${rnd()}@example.com`,
    password: `Pw-${rnd()}-${rnd()}-Zq9!`,
    organizationName: "Idle Org 2",
  });
  await setOrganizationSessionPolicy({
    organizationId: u.user.organizationId,
    actorUserId: u.user.userId,
    actorRole: "owner",
    policy: { sessionIdleMinutes: orgIdle, sessionAbsoluteTtlHours: null, mfaRequiredRoles: null },
  });
  await systemDb
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() + (env - idleFor) * 60_000), lastActiveAt: null })
    .where(eq(sessions.tokenHash, createHash("sha256").update(u.token).digest("hex")));
  ok(
    "E20 a row from before 0482 (no last use) is measured from the installation window",
    env > orgIdle + 1 ? (await resolveSession(u.token)) === null : true,
  );
}

// ── F. Review fixes: every card charge path, request totals, all metric sources ──
{
  const fbiz = await createBusiness({
    organizationId: orgId,
    name: "Review Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await updateBusiness(orgId, fbiz.publicId, { cardPaymentLimits: { USD: 100000 } });
  const payer = await createCustomer({
    organizationId: orgId,
    businessId: fbiz.id,
    email: `p1d-rev-${rnd()}@example.com`,
  });
  const card = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: fbiz.id,
    customer: payer,
    token: "tok_4242",
  });

  // A1: the charge taken before a subscription's invoice exists (API, checkout, reactivation).
  const product = await createProduct({ organizationId: orgId, businessId: fbiz.id, name: "Big" });
  const small = await createPrice({
    organizationId: orgId,
    businessId: fbiz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: fbiz.id,
    customerId: payer.id,
    now: new Date(),
    items: [{ price: small, quantity: 1 }],
  });
  const pre = await chargeBeforeSubscriptionInvoice({
    organizationId: orgId,
    businessId: fbiz.id,
    customerId: payer.id,
    subscription,
    amountMinor: 150000n,
    currency: "USD",
  });
  ok(
    "F1 a first charge above the limit is refused, the card is not charged",
    pre.kind === "declined" && pre.failureCode === CARD_LIMIT_CODE,
  );
  // A1: on-session intents (portal, checkout purchase, operator intents) above the limit.
  let intentRefused = false;
  try {
    await createPaymentIntent({
      organizationId: orgId,
      businessId: fbiz.id,
      purpose: "payment",
      customerPublicId: payer.publicId,
      letBuyerChooseMethod: true,
      amountMinor: 150000,
      currency: "USD",
      session: "on_session",
    });
  } catch (e) {
    intentRefused = e instanceof PaymentIntentError && e.code === CARD_LIMIT_CODE;
  }
  ok("F2 an on-session card payment above the limit is refused before the gateway", intentRefused);
  let savedCardRefused = false;
  try {
    await createPaymentIntent({
      organizationId: orgId,
      businessId: fbiz.id,
      purpose: "payment",
      paymentMethodPublicId: card.publicId,
      amountMinor: 150000,
      currency: "USD",
      session: "on_session",
    });
  } catch (e) {
    savedCardRefused = e instanceof PaymentIntentError && e.code === CARD_LIMIT_CODE;
  }
  ok("F3 …with a saved card named too", savedCardRefused);

  // A2: one request charge of 3 × 40,000 is 120,000 in ONE card transaction.
  const owed = [] as string[];
  for (let i = 0; i < 3; i++)
    owed.push(
      (
        await createInvoiceFromLines({
          organizationId: orgId,
          businessId: fbiz.id,
          customerId: payer.id,
          currency: "USD",
          lines: [{ description: `part ${i}`, amountMinor: 40000n }],
        })
      ).invoice.publicId,
    );
  const link = await createPaymentRequest({
    organizationId: orgId,
    businessId: fbiz.id,
    customerPublicId: payer.publicId,
    invoicePublicIds: owed,
    mode: "link",
  });
  let requestRefused = false;
  try {
    await chargePaymentRequest({
      organizationId: orgId,
      businessId: fbiz.id,
      paymentRequestPublicId: link.request.publicId,
      paymentMethodPublicId: card.publicId,
      initiator: "merchant",
    });
  } catch (e) {
    requestRefused = e instanceof PaymentRequestError;
  }
  const charged = await withTenant(orgId, (tx) =>
    tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.businessId, fbiz.id), eq(invoices.status, "paid"))),
  );
  ok(
    "F4 a request whose total is above the limit takes no card charge",
    requestRefused && charged.length === 0,
  );

  // B1: disputes and saved-card expiry leave an excluded customer out.
  const at = new Date();
  await withTenant(orgId, (tx) =>
    tx.insert(disputes).values({
      publicId: `dsp_p1d${rnd()}`,
      organizationId: orgId,
      businessId: fbiz.id,
      customerId: payer.id,
      providerKey: "tmtest",
      providerDisputeId: `dp_${rnd()}`,
      amountMinor: 1000n,
      currency: "USD",
    }),
  );
  await withTenant(orgId, (tx) =>
    tx.update(paymentMethods).set({ status: "expired" }).where(eq(paymentMethods.id, card.id)),
  );
  const window = {
    from: new Date(at.getTime() - 86_400_000),
    toExclusive: new Date(at.getTime() + 86_400_000),
    now: at,
  };
  const measure = async () => {
    const d = await withTenant(orgId, (tx) =>
      computeDisputeMeasures({ tx, businessId: fbiz.id, ...window }),
    );
    const c = await withTenant(orgId, (tx) =>
      computePaymentMethodMeasures({ tx, businessId: fbiz.id, ...window }),
    );
    const report = await resolveReport(orgId, fbiz.id, "total_cards_expired", { now: at });
    return {
      opened: d.find((r) => r.measure === "disputes_opened" && r.dim === "")?.value ?? 0n,
      expired: c.find((r) => r.measure === "cards_expired")?.value ?? 0n,
      report: report.headline,
    };
  };
  const seen = await measure();
  ok("F5 counted while reported", seen.opened === 1n && seen.expired === 1n && seen.report === 1);
  await withTenant(orgId, (tx) =>
    tx.update(customers).set({ excludeFromReporting: true }).where(eq(customers.id, payer.id)),
  );
  const hidden = await measure();
  ok("F6 excluded: no dispute counted", hidden.opened === 0n);
  ok(
    "F7 excluded: no expired card counted (daily measure and report)",
    hidden.expired === 0n && hidden.report === 0,
  );

  // B2: the restatement rewrites in place from the customer's first day; older stored
  // periods are never deleted, so no grain reads empty while it runs.
  await withTenant(orgId, (tx) =>
    tx.insert(metricDaily).values([
      {
        organizationId: orgId,
        businessId: fbiz.id,
        grain: "day",
        periodEnd: "2020-01-15",
        measure: "mrr",
        currency: "USD",
        value: 7n,
      },
      {
        organizationId: orgId,
        businessId: fbiz.id,
        grain: "month",
        periodEnd: "2020-01-31",
        measure: "mrr",
        currency: "USD",
        value: 7n,
      },
    ]),
  );
  const since = await reportingSpanStart(orgId, fbiz.id, payer.id);
  const today = new Date().toISOString().slice(0, 10);
  ok(
    "F8 the restatement starts at the customer's first day, not the book's",
    since != null && since > "2020-01-31" && since <= today,
  );
  const restated = await restateMetricsFrom(fbiz.id, since!);
  const old = await withTenant(orgId, (tx) =>
    tx
      .select({ grain: metricDaily.grain })
      .from(metricDaily)
      .where(and(eq(metricDaily.businessId, fbiz.id), eq(metricDaily.periodEnd, "2020-01-31"))),
  );
  ok("F9 a stored month outside the span survives the restatement", old.length === 1);
  ok("F10 only the customer's span is recomputed", restated.days > 0 && restated.days <= 3);
}

// ── G. Re-review fixes ─────────────────────────────────────────────────────────
{
  const today = new Date().toISOString().slice(0, 10);
  const gbiz = await createBusiness({
    organizationId: orgId,
    name: "Re-review Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const [plain] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.businessId, gbiz.id));
  const setPm = (id: string, set: Partial<typeof paymentMethods.$inferInsert>) =>
    withTenant(orgId, (tx) => tx.update(paymentMethods).set(set).where(eq(paymentMethods.id, id)));
  const payerWith = async (cardToken: string) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: gbiz.id,
      email: `p1d-g-${rnd()}@example.com`,
    });
    const cardPm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: gbiz.id,
      customer: c,
      token: cardToken,
      gatewayAccountId: plain!.publicId,
    });
    await setPm(cardPm.id, { role: "primary" });
    return { c, cardPm };
  };
  const owe = async (customerId: string, amountMinor: bigint) =>
    (
      await createInvoiceFromLines({
        organizationId: orgId,
        businessId: gbiz.id,
        customerId,
        currency: "USD",
        lines: [{ description: "owed", amountMinor }],
      })
    ).invoice;

  // N2: a pre-debit-notice rail is never debited from a request, whatever went before it.
  const notice = await createGatewayAccount({
    organizationId: orgId,
    businessId: gbiz.id,
    gatewayKey: "tmtest",
    label: "Notice rail",
    credentials: { pre_debit_lead_hours: "24" },
  });
  const addNoticeBackup = async (c: Awaited<ReturnType<typeof createCustomer>>) => {
    const upi = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: gbiz.id,
      customer: c,
      token: "tok_4242",
      gatewayAccountId: plain!.publicId,
    });
    await setPm(upi.id, {
      type: "upi",
      mandateRail: "upi",
      mandateReference: "UMN-TEST-0001",
      mandateStatus: "confirmed",
      gatewayAccountId: notice.id,
      role: "backup",
    });
    return upi;
  };
  const upiAttempts = (pmId: string) =>
    withTenant(orgId, (tx) =>
      tx.select({ id: payments.id }).from(payments).where(eq(payments.paymentMethodId, pmId)),
    ).then((r) => r.length);
  const requestFor = async (customerPublicId: string, ids: string[]) =>
    (
      await createPaymentRequest({
        organizationId: orgId,
        businessId: gbiz.id,
        customerPublicId,
        invoicePublicIds: ids,
        mode: "link",
      })
    ).request.publicId;
  const charge = async (req: string) => {
    try {
      await chargePaymentRequest({
        organizationId: orgId,
        businessId: gbiz.id,
        paymentRequestPublicId: req,
        initiator: "merchant",
      });
      return "charged";
    } catch (e) {
      return e instanceof PaymentRequestError ? "refused" : "threw";
    }
  };

  await updateBusiness(orgId, gbiz.publicId, { cardPaymentLimits: { USD: 100000 } });
  const a = await payerWith("tok_4242");
  const aUpi = await addNoticeBackup(a.c);
  const aReq = await requestFor(a.c.publicId, [(await owe(a.c.id, 150000n)).publicId]);
  ok(
    "G1 above the card limit, the request does not fall through to a notice-rail backup",
    (await charge(aReq)) === "refused" && (await upiAttempts(aUpi.id)) === 0,
  );
  await updateBusiness(orgId, gbiz.publicId, { cardPaymentLimits: null });
  const b = await payerWith("tok_4000000000009995");
  const bUpi = await addNoticeBackup(b.c);
  const bReq = await requestFor(b.c.publicId, [(await owe(b.c.id, 5000n)).publicId]);
  ok(
    "G2 a declined card does not fall through to a notice-rail backup either",
    (await charge(bReq)) === "refused" && (await upiAttempts(bUpi.id)) === 0,
  );

  // N3: a group the restatement empties is removed, not left stale.
  const cbiz = await createBusiness({
    organizationId: orgId,
    name: "Cash Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const only = await createCustomer({
    organizationId: orgId,
    businessId: cbiz.id,
    email: `p1d-cash-${rnd()}@example.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: cbiz.id,
    customer: only,
    token: "tok_4242",
  });
  const paidInv = (
    await createInvoiceFromLines({
      organizationId: orgId,
      businessId: cbiz.id,
      customerId: only.id,
      currency: "USD",
      lines: [{ description: "cash", amountMinor: 5000n }],
    })
  ).invoice;
  await collectInvoice({ organizationId: orgId, businessId: cbiz.id, invoice: paidInv });
  await bulkFillMetricDays({
    organizationId: orgId,
    businessId: cbiz.id,
    grain: "day",
    days: [today],
    write: true,
  });
  const cashRows = () =>
    withTenant(orgId, (tx) =>
      tx
        .select({ value: metricDaily.value })
        .from(metricDaily)
        .where(
          and(
            eq(metricDaily.businessId, cbiz.id),
            eq(metricDaily.measure, "cash_collected"),
            eq(metricDaily.currency, "USD"),
          ),
        ),
    );
  ok(
    "G3 the payment is stored as USD cash collected",
    (await cashRows()).some((r) => r.value === 5000n),
  );
  await withTenant(orgId, (tx) =>
    tx.update(customers).set({ excludeFromReporting: true }).where(eq(customers.id, only.id)),
  );
  await restateMetricsFrom(cbiz.id, today);
  ok(
    "G4 its only payer excluded: no USD cash collected rows remain",
    (await cashRows()).length === 0,
  );

  // N1: the hosted one-time purchase above the limit answers the buyer, not a 500.
  const { buildApp } = await import("@/index");
  const { clearPublicRateLimits } = await import("./lib/rate-limit-reset");
  const app = await buildApp({ logger: false });
  await clearPublicRateLimits();
  // Its own business: one gateway, so routing is not the refusal under test.
  const hbiz = await createBusiness({
    organizationId: orgId,
    name: "Hosted Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await updateBusiness(orgId, hbiz.publicId, { cardPaymentLimits: { USD: 100000 } });
  const pack = await createProduct({
    organizationId: orgId,
    businessId: hbiz.id,
    name: "Large pack",
    kind: "charge",
  });
  const packPrice = await createPrice({
    organizationId: orgId,
    businessId: hbiz.id,
    productId: pack.id,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 150000,
  });
  const minted = await app.inject({
    method: "POST",
    url: `/v1/businesses/${hbiz.publicId}/checkout_sessions`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": crypto.randomUUID() },
    payload: { price: packPrice.publicId, mode: "purchase" },
  });
  const token = (JSON.parse(minted.body) as { token: string }).token;
  const hosted = (path: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() },
      payload: payload as object,
    });
  await hosted("/checkout/v1/customer", {
    email: `p1d-buyer-${rnd()}@example.com`,
    address: {
      line1: "1 Market St",
      city: "San Francisco",
      state: "California",
      state_code: "CA",
      postal_code: "94105",
      country: "US",
      first_name: "Bu",
      last_name: "Yer",
    },
  });
  const done = await hosted("/checkout/v1/complete", {});
  const msg = (JSON.parse(done.body) as { error?: { message?: string } }).error?.message ?? "";
  ok(
    "G5 a hosted purchase above the card limit answers 400 with the card-limit message",
    minted.statusCode === 201 && done.statusCode === 400 && msg === CARD_LIMIT_MESSAGE,
  );
  await app.close();
  ok(
    "G6 a configuration fault on the purchase path is not turned into a buyer 400",
    purchaseIntentRefusal(new PaymentIntentError("Gateway X does not support intents")) === null &&
      purchaseIntentRefusal(new PaymentIntentError(CARD_LIMIT_MESSAGE, CARD_LIMIT_CODE)) instanceof
        CheckoutError,
  );
}

// ── H. A stored retired email key ───────────────────────────────────────────────
// The dashboard sends back the email_config it read, so a stored `attachInvoicePdf` made
// every save (Zero-value invoices, the Emails card) fail as an unknown parameter.
{
  const { buildApp } = await import("@/index");
  const app = await buildApp({ logger: false });
  const api = (method: "GET" | "PATCH", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${org.secret}`,
        ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  const legacy = await createBusiness({
    organizationId: orgId,
    name: "Legacy Email Key",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const url = `/v1/businesses/${legacy.publicId}`;
  const zeroRule = { pdf: false, skipZeroPdf: false, skipZeroSend: true };
  const stored = {
    enabled: true,
    attachInvoicePdf: false,
    attachments: { invoice_issued: zeroRule },
  };
  await systemDb
    .update(businesses)
    .set({ emailConfig: stored })
    .where(eq(businesses.id, legacy.id));
  const read = (await api("GET", url)).json() as { email_config: Record<string, unknown> };
  ok("H1 the API does not return the retired key", !("attachInvoicePdf" in read.email_config));
  // Zero-value invoices: the attachments rule, merged over what was read.
  const zeroSave = await api("PATCH", url, {
    email_config: {
      ...read.email_config,
      attachments: { invoice_issued: { ...zeroRule, skipZeroSend: false } },
    },
  });
  ok("H2 the Zero-value invoices save succeeds", zeroSave.statusCode === 200);
  // The Emails card, sent by a client that still spreads the raw stored object.
  const cardSave = await api("PATCH", url, {
    email_config: {
      ...stored,
      attachments: { invoice_issued: zeroRule },
      types: { invoice_issued: true },
    },
  });
  const [after] = await systemDb
    .select({ emailConfig: businesses.emailConfig })
    .from(businesses)
    .where(eq(businesses.id, legacy.id));
  const cfg = after!.emailConfig as Record<string, unknown>;
  ok(
    "H3 the Emails card save succeeds with the retired key in the body, and does not store it",
    cardSave.statusCode === 200 && !("attachInvoicePdf" in cfg),
  );
  const rule = attachmentRule(resolveEmailConfig({ emailConfig: cfg }), "invoice_issued");
  ok(
    "H4 the attach setting is preserved",
    rule?.pdf === false && rule.skipZeroPdf === false && rule.skipZeroSend === true,
  );
  // 0492 removes the key from stored rows and keeps `attachments`; a second run is a no-op.
  await systemDb
    .update(businesses)
    .set({ emailConfig: stored })
    .where(eq(businesses.id, legacy.id));
  const migration = readFileSync("db/migrations/0492_email_config_legacy_keys.sql", "utf8");
  await systemDb.execute(sql.raw(migration));
  await systemDb.execute(sql.raw(migration));
  const [migrated] = await systemDb
    .select({ emailConfig: businesses.emailConfig })
    .from(businesses)
    .where(eq(businesses.id, legacy.id));
  ok(
    "H5 0492 removes the retired key, keeps the rest, and is safe to run twice",
    JSON.stringify(migrated!.emailConfig) ===
      JSON.stringify({ enabled: true, attachments: { invoice_issued: zeroRule } }),
  );
  await app.close();
}

let failed = 0;
for (const [name, pass] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? "✓" : "✗"} ${name}`);
}
console.log(
  `\n${failed === 0 ? "✅" : "❌"} SETTINGS INVOICES/ORG: ${failed === 0 ? "PASS" : "FAIL"} (${checks.length - failed}/${checks.length})`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
