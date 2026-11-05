/**
 * verify:gateway-sdk-modes — the `sdk` and `form_post` buyer challenges, end to end on the
 * TM Test Gateway (`buyer_auth_mode` credential), plus `client_result` on the HTTP routes
 * and the operator-pasted webhook secret.
 *
 *   pnpm verify:gateway-sdk-modes
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { decryptCredentials } from "@/platform/secrets";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createInvoiceFromLines } from "@/modules/invoicing/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { listGatewayAccounts, updateGatewayAccount } from "@/modules/gateway/service";
import { listPaymentMethods, vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  applyClientResult,
  consumePaymentIntent,
  createPaymentIntent,
  getPaymentIntent,
  listAttemptsForIntent,
  retryPaymentIntent,
  serializePaymentIntent,
  PaymentIntentError,
} from "@/modules/payment-intents/service";
import {
  beginVaultSetup,
  completeVaultFromIntent,
  serializeVaultSetup,
  VaultSetupIntentError,
} from "@/api/vault-setup";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { TmtestProvider } from "@/providers/tmtest";
import { insertCharge } from "@/providers/tmtest/store";
import { AUTO_SUBMIT_SCRIPT_SHA256, formPostFields } from "@/providers/tmtest/form-post";
import type { BuyerAuthorization } from "@/providers/types";
import {
  businesses,
  gatewayAccounts,
  invoices,
  paymentMethods,
  payments,
  tmtestCharges,
} from "@db/schema";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

const checks: Array<[string, boolean, string?]> = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push([name, cond, detail]);

const app = await buildApp({ logger: false });
await clearPublicRateLimits();

const org = await createOrganization({ name: "Gateway SDK Modes Co" });
const orgId = org.organization.id;

/** A test business whose own TM Test account answers with `mode`. */
async function businessWithMode(name: string, mode: "sdk" | "form_post" | null) {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const [acct] = await listGatewayAccounts(orgId, biz.id);
  if (mode)
    await updateGatewayAccount({
      organizationId: orgId,
      businessId: biz.id,
      gwaPublicId: acct!.publicId,
      credentials: { buyer_auth_mode: mode },
    });
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `sdk-${randomUUID().slice(0, 8)}@example.com`,
  });
  return { biz, acct: acct!, cus };
}

const sdk = await businessWithMode("SDK Biz", "sdk");
const form = await businessWithMode("Form Post Biz", "form_post");
const plain = await businessWithMode("Plain Biz", null);

const mkInvoice = async (b: typeof sdk, amountMinor: bigint) =>
  (
    await createInvoiceFromLines({
      organizationId: orgId,
      businessId: b.biz.id,
      customerId: b.cus.id,
      currency: "USD",
      lines: [{ description: "SDK mode target", amountMinor }],
      collect: false,
    })
  ).invoice;
const invoiceStatus = async (id: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id)),
    )
  )[0]?.status;
/** A Pay-now style intent: the buyer picks the method in the challenge. */
const buyerIntent = (
  b: typeof sdk,
  inv: { publicId: string; amountDueMinor: bigint | null },
  extra: { returnUrl?: string; cancelUrl?: string } = {},
) =>
  createPaymentIntent({
    organizationId: orgId,
    businessId: b.biz.id,
    purpose: "payment",
    customerPublicId: b.cus.publicId,
    letBuyerChooseMethod: true,
    session: "on_session",
    gatewayAccountId: b.acct.publicId,
    amountMinor: Number(inv.amountDueMinor),
    currency: "USD",
    invoicePublicId: inv.publicId,
    ...extra,
  });
const catchErr = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
const clientResultRows = (intentAtGateway: string) =>
  systemDb
    .select()
    .from(tmtestCharges)
    .where(
      and(
        eq(tmtestCharges.parentChargeId, intentAtGateway),
        eq(tmtestCharges.kind, "client_result"),
      ),
    );

// ── (a) sdk, approve ─────────────────────────────────────────────────────────
{
  const inv = await mkInvoice(sdk, 4200n);
  const { intent } = await buyerIntent(sdk, inv);
  const na = serializePaymentIntent(intent).next_action as BuyerAuthorization | null;
  ok(
    "a: next_action is mode sdk with the tmtest provider and the gateway intent in params (wire format)",
    na?.mode === "sdk" &&
      na.sdk?.provider === "tmtest" &&
      na.sdk.params.intent === intent.intentAtGateway,
    JSON.stringify(na),
  );
  const consumed = await consumePaymentIntent(orgId, sdk.biz.id, intent.publicId, inv.publicId, {
    clientResult: { nonce: "tmtest_ok" },
  });
  ok(
    "a: consume with client_result captures (applyClientResult → authorize → consume)",
    consumed?.intent.status === "consumed" && consumed.charge?.status === "succeeded",
    `${consumed?.intent.status}/${consumed?.charge?.status}`,
  );
  ok("a: the invoice is settled", (await invoiceStatus(inv.id)) === "paid");
  const [att] = await listAttemptsForIntent(orgId, sdk.biz.id, intent.publicId);
  ok(
    "a: the attempt carries the gateway's NEW id (the attempt-id rewrite), and consume used it",
    !!att?.idAtGateway?.startsWith("tmtx_") && att.idAtGateway !== intent.intentAtGateway,
    att?.idAtGateway ?? "(none)",
  );
  const replay = await new TmtestProvider(sdk.biz.id, {
    buyerAuthMode: "sdk",
  }).submitClientResult!({
    intentId: intent.intentAtGateway!,
    purpose: "payment",
    clientResult: { nonce: "tmtest_decline" },
    idempotencyKey: `pi_client_${intent.publicId}_a1`,
  });
  ok(
    "a: submitClientResult is idempotent on its key (a replay answers the first outcome)",
    replay.status === "authorized" && replay.gatewayIntentId === att?.idAtGateway,
    `${replay.status}/${replay.gatewayIntentId}`,
  );
}

// ── (b) sdk, decline → retry succeeds; invalid nonce ─────────────────────────
{
  const inv = await mkInvoice(sdk, 4300n);
  const { intent } = await buyerIntent(sdk, inv);
  const err = await catchErr(() =>
    consumePaymentIntent(orgId, sdk.biz.id, intent.publicId, inv.publicId, {
      clientResult: { nonce: "tmtest_decline" },
    }),
  );
  ok(
    "b: a declined client_result throws PaymentIntentError card_declined",
    err instanceof PaymentIntentError && err.code === "card_declined",
    String((err as Error)?.message),
  );
  const [a1] = await listAttemptsForIntent(orgId, sdk.biz.id, intent.publicId);
  ok(
    "b: the attempt is failed with the gateway's code",
    a1?.status === "failed" && a1.errorCode === "card_declined",
    `${a1?.status}/${a1?.errorCode}`,
  );
  const after = await getPaymentIntent(orgId, sdk.biz.id, intent.publicId);
  ok("b: the intent is not consumed and stays open", after?.status !== "consumed", after?.status);
  ok("b: the invoice is still unpaid", (await invoiceStatus(inv.id)) !== "paid");
  const retried = await retryPaymentIntent(orgId, sdk.biz.id, intent.publicId);
  ok(
    "b: a retry opens attempt 2 with a fresh sdk challenge",
    retried?.attempt.attemptNumber === 2 &&
      (retried.intent.nextAction as BuyerAuthorization | null)?.mode === "sdk",
  );
  const consumed = await consumePaymentIntent(orgId, sdk.biz.id, intent.publicId, inv.publicId, {
    clientResult: { nonce: "tmtest_ok" },
  });
  ok(
    "b: the retried attempt then succeeds and settles the invoice",
    consumed?.intent.status === "consumed" && (await invoiceStatus(inv.id)) === "paid",
  );

  const inv2 = await mkInvoice(sdk, 4310n);
  const { intent: i2 } = await buyerIntent(sdk, inv2);
  const bad = await catchErr(() =>
    consumePaymentIntent(orgId, sdk.biz.id, i2.publicId, inv2.publicId, {
      clientResult: { nonce: "not-a-nonce" },
    }),
  );
  ok(
    "b: an unknown nonce is refused as invalid_client_result",
    bad instanceof PaymentIntentError && bad.code === "invalid_client_result",
    String((bad as Error)?.message),
  );
}

// ── (c) setup intent through completeVaultFromIntent ─────────────────────────
{
  const begin = () =>
    beginVaultSetup({
      organizationId: orgId,
      businessId: sdk.biz.id,
      customer: sdk.cus,
      returnUrl: "https://shop.example.com/cards/done",
      cancelUrl: "https://shop.example.com/cards/cancel",
      methodTypes: ["card"],
    });
  const outcome = await begin();
  const view = serializeVaultSetup(outcome) as Record<string, unknown>;
  ok(
    "c: vault_setup answers mode sdk with `sdk` and the setup intent (wire format)",
    view.mode === "sdk" &&
      (view.sdk as { provider?: string })?.provider === "tmtest" &&
      typeof view.payment_intent === "string" &&
      (view.next_action as { mode?: string })?.mode === "sdk",
    JSON.stringify(view),
  );
  const before = (await listPaymentMethods(orgId, sdk.cus.id)).length;
  const pm = await completeVaultFromIntent({
    organizationId: orgId,
    businessId: sdk.biz.id,
    customerId: sdk.cus.id,
    paymentIntentPublicId: outcome.intent!.publicId,
    clientResult: { nonce: "tmtest_ok" },
  });
  ok(
    "c: an approved setup saves the payment method",
    !!pm?.providerPaymentMethodId.startsWith("tmpm_") &&
      (await listPaymentMethods(orgId, sdk.cus.id)).length === before + 1,
  );
  const declined = await begin();
  const err = await catchErr(() =>
    completeVaultFromIntent({
      organizationId: orgId,
      businessId: sdk.biz.id,
      customerId: sdk.cus.id,
      paymentIntentPublicId: declined.intent!.publicId,
      clientResult: { nonce: "tmtest_decline" },
    }),
  );
  ok(
    "c: a declined setup throws VaultSetupIntentError 400 card_declined (no self-authorize)",
    err instanceof VaultSetupIntentError && err.status === 400 && err.detail === "card_declined",
    String((err as Error)?.message),
  );
  ok(
    "c: …and saves no payment method",
    (await listPaymentMethods(orgId, sdk.cus.id)).length === before + 1,
  );
}

// ── (d) client_result on a gateway with no submitClientResult ────────────────
{
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: plain.biz.id,
    customer: plain.cus,
    token: "tok_4000000000003155",
    gatewayAccountId: plain.acct.publicId,
  });
  const inv = await mkInvoice(plain, 4400n);
  const { intent } = await createPaymentIntent({
    organizationId: orgId,
    businessId: plain.biz.id,
    purpose: "payment",
    paymentMethodPublicId: pm.publicId,
    gatewayAccountId: plain.acct.publicId,
    amountMinor: Number(inv.amountDueMinor),
    currency: "USD",
    session: "on_session",
  });
  ok(
    "d: the default tmtest account is unchanged (redirect challenge)",
    (intent.nextAction as BuyerAuthorization | null)?.mode === "redirect",
  );
  const err = await catchErr(() =>
    consumePaymentIntent(orgId, plain.biz.id, intent.publicId, inv.publicId, {
      clientResult: { nonce: "tmtest_ok" },
    }),
  );
  ok(
    "d: client_result is refused with client_result_unsupported",
    err instanceof PaymentIntentError && err.code === "client_result_unsupported",
    String((err as Error)?.message),
  );
  const [att] = await listAttemptsForIntent(orgId, plain.biz.id, intent.publicId);
  ok(
    "d: nothing changed on the attempt",
    att?.status === "requires_action" && att.idAtGateway === intent.intentAtGateway,
  );
}

// ── (e) an already-authorized intent → past_challenge, no gateway call ───────
{
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: sdk.biz.id,
    customer: sdk.cus,
    token: "tok_4242",
    gatewayAccountId: sdk.acct.publicId,
  });
  const inv = await mkInvoice(sdk, 4500n);
  const { intent } = await createPaymentIntent({
    organizationId: orgId,
    businessId: sdk.biz.id,
    purpose: "payment",
    paymentMethodPublicId: pm.publicId,
    gatewayAccountId: sdk.acct.publicId,
    amountMinor: Number(inv.amountDueMinor),
    currency: "USD",
  });
  ok("e: a vaulted success card authorizes without a challenge", intent.status === "authorized");
  const applied = await applyClientResult(orgId, sdk.biz.id, intent.publicId, {
    nonce: "tmtest_decline",
  });
  ok("e: applyClientResult answers past_challenge", applied?.outcome === "past_challenge");
  ok(
    "e: …without calling the gateway",
    (await clientResultRows(intent.intentAtGateway!)).length === 0,
  );
  const consumed = await consumePaymentIntent(orgId, sdk.biz.id, intent.publicId, inv.publicId, {
    clientResult: { nonce: "tmtest_decline" },
  });
  ok("e: and the consume still settles", consumed?.intent.status === "consumed");
}

// ── (f) form_post ────────────────────────────────────────────────────────────
{
  ok(
    "f: a form_post account declares buyerReturnByPost; the default one does not",
    new TmtestProvider(form.biz.id, { buyerAuthMode: "form_post" }).capabilities
      .buyerReturnByPost === true &&
      !new TmtestProvider(form.biz.id).capabilities.buyerReturnByPost,
  );
  const returnUrl = "https://shop.example.com/pay/done?inv=1#top";
  const bounce = `https://shop.example.com/gateway-return?next=${encodeURIComponent("/pay/done?inv=1#top")}`;
  const post = (fields: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/v1/tmtest/form_post",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(fields).toString(),
    });

  const inv = await mkInvoice(form, 4600n);
  const { intent } = await buyerIntent(form, inv, {
    returnUrl,
    cancelUrl: "https://shop.example.com/pay/cancel",
  });
  const na = serializePaymentIntent(intent).next_action as BuyerAuthorization | null;
  ok(
    "f: next_action is mode form_post with action + signed fields (wire format)",
    na?.mode === "form_post" &&
      !!na.formPost?.action.endsWith("/v1/tmtest/form_post") &&
      na.formPost.fields.intent === intent.intentAtGateway &&
      !!na.formPost.fields.signature,
    JSON.stringify(na),
  );
  ok(
    "f: the return URL handed to the adapter is the /gateway-return bounce with the right next",
    na?.formPost?.fields.return_url === bounce,
    na?.formPost?.fields.return_url,
  );
  const tampered = await post({ ...na!.formPost!.fields, return_url: "https://evil.example.com/" });
  ok("f: a tampered field is refused (400)", tampered.statusCode === 400);
  const res = await post(na!.formPost!.fields);
  ok(
    "f: the route answers an auto-submit form to the bounce URL",
    res.statusCode === 200 &&
      String(res.headers["content-type"]).startsWith("text/html") &&
      res.body.includes(`action="${bounce}"`) &&
      res.body.includes("document.forms[0].submit()"),
    `${res.statusCode} ${res.body.slice(0, 160)}`,
  );
  ok(
    "f: its CSP admits that one script by hash and lets the form post out",
    String(res.headers["content-security-policy"]).includes(AUTO_SUBMIT_SCRIPT_SHA256) &&
      String(res.headers["content-security-policy"]).includes("form-action http: https:"),
  );
  const consumed = await consumePaymentIntent(orgId, form.biz.id, intent.publicId, inv.publicId);
  ok(
    "f: completion asks the gateway (no posted fields) and settles the invoice",
    consumed?.intent.status === "consumed" && (await invoiceStatus(inv.id)) === "paid",
  );

  const inv2 = await mkInvoice(form, 4700n);
  const { intent: i2 } = await buyerIntent(form, inv2, { returnUrl });
  const f2 = (i2.nextAction as BuyerAuthorization).formPost!.fields;
  const declined = await post({ ...f2, decision: "decline" });
  ok(
    "f: decision=decline posts back with status declined",
    declined.statusCode === 200 && declined.body.includes('value="declined"'),
  );
  const err = await catchErr(() =>
    consumePaymentIntent(orgId, form.biz.id, i2.publicId, inv2.publicId),
  );
  ok(
    "f: a declined form_post does not settle (intent_not_authorized)",
    err instanceof PaymentIntentError && err.code === "intent_not_authorized",
    String((err as Error)?.message),
  );

  const liveBiz = await createBusiness({
    organizationId: orgId,
    name: "Live Biz",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const liveId = `tmpi_live${randomUUID().replace(/-/g, "")}`;
  await insertCharge({
    chargeId: liveId,
    businessId: liveBiz.id,
    kind: "intent",
    amountMinor: 100n,
    currency: "USD",
    status: "requires_action",
  });
  const live = await post(formPostFields(liveId, returnUrl));
  ok("f: the route refuses a live business (404)", live.statusCode === 404);
}

// ── (g) HTTP: client_result through real routes ──────────────────────────────
const api = (method: "GET" | "POST", url: string, token: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
    },
    ...(payload ? { payload } : {}),
  });
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>;
{
  const link = await createPortalSession({
    organizationId: orgId,
    businessId: sdk.biz.id,
    customerId: sdk.cus.id,
  });
  const ex = await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${link.accessToken}` },
  });
  const ptoken = json(ex).token as string;
  ok("g: portal session exchanged", ex.statusCode === 201 && !!ptoken);

  const inv = await mkInvoice(sdk, 4800n);
  const leg1 = await api("POST", `/portal/v1/invoices/${inv.publicId}/collect`, ptoken, {});
  const leg1Body = json(leg1);
  ok(
    "g: portal Pay now answers action_required with next_action mode sdk",
    leg1.statusCode === 200 &&
      leg1Body.status === "action_required" &&
      leg1Body.next_action?.mode === "sdk",
    leg1.body.slice(0, 200),
  );
  const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
  const big = await api("POST", `/portal/v1/invoices/${inv.publicId}/collect`, ptoken, {
    payment_intent: leg1Body.payment_intent?.id,
    client_result: tooMany,
  });
  ok("g: client_result over 20 keys is refused (400)", big.statusCode === 400);
  const leg2 = await api("POST", `/portal/v1/invoices/${inv.publicId}/collect`, ptoken, {
    payment_intent: leg1Body.payment_intent?.id,
    client_result: { nonce: "tmtest_ok" },
  });
  ok(
    "g: portal Pay now leg 2 with client_result settles the invoice",
    leg2.statusCode === 200 && (await invoiceStatus(inv.id)) === "paid",
    leg2.body.slice(0, 200),
  );

  const inv2 = await mkInvoice(sdk, 4900n);
  const d1 = json(await api("POST", `/portal/v1/invoices/${inv2.publicId}/collect`, ptoken, {}));
  const d2 = await api("POST", `/portal/v1/invoices/${inv2.publicId}/collect`, ptoken, {
    payment_intent: d1.payment_intent?.id,
    client_result: { nonce: "tmtest_decline" },
  });
  ok(
    "g: a declined client_result answers 400 with the gateway's reason",
    d2.statusCode === 400 && d2.body.includes("The card was declined"),
    d2.body.slice(0, 200),
  );

  // Operator consume route.
  const inv3 = await mkInvoice(sdk, 5100n);
  const { intent: i3 } = await buyerIntent(sdk, inv3);
  const c3 = await api(
    "POST",
    `/v1/businesses/${sdk.biz.publicId}/payment_intents/${i3.publicId}/consume`,
    org.secret,
    { invoice: inv3.publicId, client_result: { nonce: "tmtest_ok" } },
  );
  ok(
    "g: POST …/payment_intents/:pi/consume passes client_result through",
    c3.statusCode === 200 && json(c3).status === "consumed",
    c3.body.slice(0, 200),
  );
}

// ── (h) checkout complete: client_result goes to payment_intent, else setup_intent ──
{
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ storefrontConfig: { one_time_save_payment_method: "ask" } })
      .where(eq(businesses.id, sdk.biz.id)),
  );
  const product = await createProduct({
    organizationId: orgId,
    businessId: sdk.biz.id,
    name: "Credit pack",
    kind: "charge",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: sdk.biz.id,
    productId: product.id,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 2500,
  });
  const address = {
    line1: "1 Market St",
    city: "San Francisco",
    state: "California",
    state_code: "CA",
    postal_code: "94105",
    country: "US",
    first_name: "Bu",
    last_name: "Yer",
  };
  const openLink = async (email: string) => {
    const r = await api(
      "POST",
      `/v1/businesses/${sdk.biz.publicId}/checkout_sessions`,
      org.secret,
      {
        price: price.publicId,
        mode: "purchase",
      },
    );
    const token = json(r).token as string;
    await api("POST", "/checkout/v1/customer", token, { email, address });
    return token;
  };
  const invoiceById = async (publicId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.publicId, publicId)).limit(1),
      )
    )[0];

  // Charge leg: a 3DS card answers 402 with an sdk challenge; client_result completes it.
  const t1 = await openLink(`h1-${randomUUID().slice(0, 6)}@example.com`);
  const CHALLENGE = "tok_4000000000003155";
  const l1 = await api("POST", "/checkout/v1/complete", t1, { token: CHALLENGE });
  const l1b = json(l1);
  ok(
    "h: checkout leg 1 answers 402 with next_action mode sdk",
    l1.statusCode === 402 && l1b.next_action?.mode === "sdk",
    l1.body.slice(0, 200),
  );
  const l2 = await api("POST", "/checkout/v1/complete", t1, {
    token: CHALLENGE,
    payment_intent: l1b.payment_intent?.id,
    client_result: { nonce: "tmtest_ok" },
  });
  const paidInv = l2.statusCode === 201 ? await invoiceById(json(l2).invoice_id) : undefined;
  ok(
    "h: checkout complete applies client_result to payment_intent and pays",
    paidInv?.status === "paid",
    l2.body.slice(0, 200),
  );

  // Setup leg: client_result completes the add-card when there is no payment_intent.
  const t2 = await openLink(`h2-${randomUUID().slice(0, 6)}@example.com`);
  const setup = json(
    await api("POST", "/checkout/v1/setup", t2, {
      return_url: "https://shop.example.com/done",
      cancel_url: "https://shop.example.com/cancel",
    }),
  );
  ok("h: checkout setup answers mode sdk", setup.mode === "sdk" && !!setup.payment_intent);
  const sDecl = await api("POST", "/checkout/v1/complete", t2, {
    setup_intent: setup.payment_intent,
    client_result: { nonce: "tmtest_decline" },
  });
  ok(
    "h: a declined setup client_result is refused (400) — it reached the setup, not a charge",
    sDecl.statusCode === 400,
    sDecl.body.slice(0, 200),
  );
  const setup2 = json(
    await api("POST", "/checkout/v1/setup", t2, {
      return_url: "https://shop.example.com/done",
      cancel_url: "https://shop.example.com/cancel",
    }),
  );
  const sOk = await api("POST", "/checkout/v1/complete", t2, {
    setup_intent: setup2.payment_intent,
    client_result: { nonce: "tmtest_ok" },
  });
  const sInv = sOk.statusCode === 201 ? await invoiceById(json(sOk).invoice_id) : undefined;
  const saved = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.businessId, sdk.biz.id)),
  );
  ok(
    "h: an approved setup client_result saves the card and the purchase is paid with it",
    sInv?.status === "paid" && saved.some((p) => p.providerPaymentMethodId.startsWith("tmpm_")),
    sOk.body.slice(0, 200),
  );
}

// ── (i) operator-pasted webhook secret (`secret_in`) ─────────────────────────
{
  const url = `/v1/businesses/${plain.biz.publicId}/gateway_accounts/${plain.acct.publicId}/webhook_endpoint`;
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: plain.biz.id,
    gwaPublicId: plain.acct.publicId,
    credentials: { api_key: "key_test_fixture" },
  });
  const refused = await api("POST", url, org.secret, { webhook_secret: "whsec_fixture" });
  ok("i: a webhook_secret is refused outside secret_in mode (400)", refused.statusCode === 400);
  // tmtest stands in for an `operator_pasted` gateway for this block only.
  const def = GATEWAYS.tmtest.webhook;
  const was = def.secret;
  def.secret = "operator_pasted";
  try {
    const info = json(await api("GET", url, org.secret));
    ok(
      "i: the account reads mode secret_in, not configured",
      info.mode === "secret_in" && !info.configured,
    );
    const saved = await api("POST", url, org.secret, { webhook_secret: "whsec_fixture" });
    const sb = json(saved);
    ok(
      "i: saving answers configured: true and never echoes the secret",
      saved.statusCode === 200 &&
        sb.configured === true &&
        sb.mode === "secret_in" &&
        !saved.body.includes("whsec_fixture"),
      saved.body.slice(0, 200),
    );
    const [row] = await withTenant(orgId, (tx) =>
      tx.select().from(gatewayAccounts).where(eq(gatewayAccounts.publicId, plain.acct.publicId)),
    );
    const creds = decryptCredentials(row!.credentialsEnc);
    ok(
      "i: the secret is merged in and the API keys are still present",
      creds.webhook_secret === "whsec_fixture" && creds.api_key === "key_test_fixture",
    );
  } finally {
    def.secret = was;
  }
}

// ── (j) the browser's result names the method; the capture does not ─────────
// Adyen and Checkout.com report Google Pay only when the browser's result is read.
{
  // `submitClientResult` is an instance field bound to `acceptClientResult` in sdk mode.
  const proto = TmtestProvider.prototype as unknown as {
    acceptClientResult: NonNullable<TmtestProvider["submitClientResult"]>;
  };
  const orig = proto.acceptClientResult;
  proto.acceptClientResult = async function (this: TmtestProvider, input) {
    const r = await orig.call(this, input);
    return r.status === "authorized" ? { ...r, methodUsed: "google_pay" } : r;
  };
  try {
    const inv = await mkInvoice(sdk, 4700n);
    const { intent } = await buyerIntent(sdk, inv);
    const consumed = await consumePaymentIntent(orgId, sdk.biz.id, intent.publicId, inv.publicId, {
      clientResult: { nonce: "tmtest_ok" },
    });
    const [att] = await listAttemptsForIntent(orgId, sdk.biz.id, intent.publicId);
    const [pay] = await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, inv.id)),
    );
    ok(
      "j: the attempt keeps the method the browser's result named",
      att?.methodUsed === "google_pay",
      String(att?.methodUsed),
    );
    ok(
      "j: the payment books it: method_type card, metadata.payment_method_used google_pay",
      consumed?.charge?.status === "succeeded" &&
        pay?.methodType === "card" &&
        (pay.metadata as Record<string, unknown> | null)?.payment_method_used === "google_pay",
      `${pay?.methodType} ${JSON.stringify(pay?.metadata)}`,
    );
  } finally {
    proto.acceptClientResult = orig;
  }
}

await app.close();
const failed = checks.filter(([, c]) => !c);
for (const [name, c, detail] of checks)
  console.log(`${c ? "✓" : "✗"} ${name}${!c && detail ? ` — ${detail}` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
console.log(failed.length ? "❌ GATEWAY-SDK-MODES: FAIL" : "✅ GATEWAY-SDK-MODES: PASS");
await closeDb();
process.exit(failed.length ? 1 : 0);
