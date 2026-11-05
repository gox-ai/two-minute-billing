/**
 * Phase C — Gateway rebuild verify suite (the marquee suite).
 *
 * Grows across C1..C10. Each section is guarded so partial progress still runs.
 *  - C1: credential crypto round-trip; gateway_accounts CRUD; credentials are
 *        write-only (never echoed); verify health-check; unsupported key → 400;
 *        tmtest-on-live blocked.
 *
 *   pnpm verify:gateway
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildApp } from "@/index";
import { newTraceId, withTraceContext } from "@/platform/trace";
import { closeDb, withTenant } from "@/platform/db";
import {
  createApiKey,
  createOrganization,
  createBusiness,
  updateBusiness,
} from "@/modules/tenancy/service";
import {
  encryptSecret,
  decryptSecret,
  encryptCredentials,
  decryptCredentials,
} from "@/platform/secrets";
import {
  createGatewayAccount,
  setDefaultGatewayAccount,
  getGatewayAccount,
  listGatewayAccounts,
  updateGatewayAccount,
  serializeGatewayAccount,
} from "@/modules/gateway/service";
import { selectGatewayAccount, GatewayRouterError } from "@/modules/gateway/router";
import {
  getWebhookEndpointInfo,
  provisionWebhookEndpoint,
  setWebhookSecretFallback,
  WEBHOOK_SECRET_FALLBACK,
  WEBHOOK_CHANGE_IN_PROGRESS,
} from "@/modules/gateway/webhook-endpoint";
import { ingestGatewayWebhook } from "@/modules/gateway/inbound";
import { config } from "@/platform/config";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { resolveAdapter } from "@/providers/registry";
import { startTimeTravel, stopTimeTravel, travelForward } from "@/modules/time-travel/service";
import { PayPalProvider } from "@/providers/paypal";
import { StripeProvider } from "@/providers/stripe";
import { RazorpayProvider } from "@/providers/razorpay";
import { GoCardlessProvider } from "@/providers/gocardless";
import { classifyToken } from "@/providers/tmtest/instruments";
import { advanceTmtest } from "@/providers/tmtest/webhooks";
import { systemDb } from "@/platform/db";
import {
  providerEvents,
  tmtestCharges,
  gatewayRequestLogs,
  events,
  paymentAttempts,
} from "@db/schema";
import { eq, and, asc } from "drizzle-orm";
import type {
  BuyerAuthorization,
  ChargeInput,
  CreateIntentInput,
  InitiateVaultSetupInput,
  IntentRef,
  RefundInput,
  PaymentProvider,
  ProviderCustomerRef,
  ProviderPaymentMethodRef,
} from "@/providers/types";
import { TmtestProvider } from "@/providers/tmtest";
import { ProviderIndeterminateError, ProviderRefusalError } from "@/providers/types";
import { createCustomer } from "@/modules/customers/service";
import {
  recordTransaction,
  reconcileTransaction,
  listTransactions,
  setTransactionStatus,
  getTransactionDetailed,
  serializeTransaction,
  TransactionError,
  type TransactionStatus,
} from "@/modules/transactions/service";
import { listEventsFiltered } from "@/modules/events/service";
import {
  vaultPaymentMethod,
  persistVaultedPaymentMethod,
  assignPaymentMethodRole,
  listPaymentMethods,
  assertVaultPreconditions,
} from "@/modules/payment-methods/service";
// #31 drives the LEGACY add-card path directly: `beginVaultSetup` prefers the
// setup-intent path and only falls back to this one, so going through the route would
// usually exercise `createIntent` again instead of `initiateVaultSetup`.
import { initiateVaultSetupForBusiness } from "@/modules/payment-methods/service";
import { topUpWallet } from "@/modules/wallet/service";
import { refundPayment, RefundError } from "@/modules/refunds/service";
import { paymentSourceSweep } from "@/modules/payment-methods/sweep";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  paymentMethods,
  paymentIntents,
  invoices,
  payments,
  transactions,
  gatewayAccounts,
  refunds,
  ledgerEntries,
  subscriptions,
  // #42 reads the idempotency record directly: whether a 502 leaves the caller's key
  // replayable is a property of the ROW, not of anything the response can show.
  idempotencyKeys,
  // C8-OFF flips a customer to auto-collect OFF directly: `auto_collection` is read only
  // at the reversal site, so the column IS the lever and going through the service would
  // add a collection side-effect the fixture does not want.
  customers,
  businesses,
} from "@db/schema";
import { createInvoiceFromLines, collectInvoice } from "@/modules/invoicing/service";
import { mandateMissingRefusal } from "@/modules/invoicing/collection";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { runDunningPass } from "@/modules/subscriptions/dunning";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { listGatewayWebhooks, listGatewayWebhooksPage } from "@/modules/gateway/inbound";
import { publicId } from "@/platform/ids";
import { beginVaultSetup, completeVaultFromIntent } from "@/api/vault-setup";
import {
  createPaymentIntent,
  reviveIntentForLateAuthorization,
  getPaymentIntent,
  authorizePaymentIntent,
  consumePaymentIntent,
  retryPaymentIntent,
  voidPaymentIntent,
  listAttemptsForIntent,
  serializePaymentAttempt,
  expirePaymentIntents,
  listPaymentIntentsPage,
  serializePaymentIntentRow,
  PaymentIntentError,
  PaymentIntentConflictError,
  PaymentIntentVoidUnsupportedError,
} from "@/modules/payment-intents/service";
// The rail-aware TTL table, so C7-TTL asserts the BEHAVIOUR at each rail's boundary
// instead of hard-coding hours that would then have to be retuned in two places.
import {
  ON_SESSION_TTL_MS,
  DEFAULT_RAIL_TTL_HOURS,
  railTtlHours,
  intentTtlMs,
} from "@/modules/payment-intents/ttl";

const checks: Array<[string, boolean, string?]> = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);

/** Debit-positive balance of a ledger account for a business+currency. */
async function ledgerBalance(
  orgId: string,
  businessId: string,
  account: string,
  currency = "USD",
): Promise<bigint> {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.businessId, businessId),
          eq(ledgerEntries.account, account),
          eq(ledgerEntries.currency, currency),
        ),
      ),
  );
  return rows.reduce((s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor), 0n);
}

// ── C1: credential crypto round-trip ─────────────────────────────────────────
{
  const secret = "sk_test_supersecret_value_12345";
  const enc = encryptSecret(secret);
  ok("crypto: envelope has v1: prefix", enc.startsWith("v1:"));
  ok("crypto: ciphertext differs from plaintext", !enc.includes(secret));
  ok("crypto: round-trip restores plaintext", decryptSecret(enc) === secret);
  ok(
    "crypto: two encryptions of same value differ (random IV)",
    encryptSecret(secret) !== encryptSecret(secret),
  );
  const creds = { secret_key: "sk_live_abc", webhook_secret: "whsec_xyz" };
  ok(
    "crypto: credentials JSON round-trip",
    JSON.stringify(decryptCredentials(encryptCredentials(creds))) === JSON.stringify(creds),
  );
  let tampered = false;
  try {
    const raw = enc.slice(3);
    const flipped = "v1:" + (raw[0] === "A" ? "B" : "A") + raw.slice(1);
    decryptSecret(flipped);
  } catch {
    tampered = true;
  }
  ok("crypto: tampered ciphertext rejected", tampered);
}

// ── C1: gateway_accounts CRUD over HTTP ───────────────────────────────────────
const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const org = await createOrganization({ name: "Gateway Co" });
const base = `http://127.0.0.1:${port}`;

const liveBiz = await createBusiness({
  organizationId: org.organization.id,
  name: "GW Live",
  defaultCurrency: "USD",
  livemode: "live",
});
const testBiz = await createBusiness({
  organizationId: org.organization.id,
  name: "GW Test",
  defaultCurrency: "USD",
  livemode: "test",
});

async function api(method: string, path: string, body?: unknown, key?: string) {
  // Only set Content-Type when there is a body — Fastify rejects an empty body
  // when content-type is application/json.
  const headers: Record<string, string> = { Authorization: `Bearer ${org.secret}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Defaulted rather than optional (audit L6): the engine refuses a mutating request with
  // no Idempotency-Key. An explicit `key` still wins — that is how the replay assertions
  // below reuse one deliberately.
  if (method !== "GET") headers["Idempotency-Key"] = key ?? crypto.randomUUID();
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as Record<string, unknown> };
}

// Create a gateway account (CRUD proof — uses tmtest since it needs no external
// credentials and its health probe is always deterministic/offline).
const created = await api(
  "POST",
  `/v1/businesses/${testBiz.publicId}/gateway_accounts`,
  { gateway_key: "tmtest", label: "Primary", credentials: {}, currencies: ["usd"] },
  "gwa-1",
);
ok("C1: create gateway account → 201", created.status === 201);
ok("C1: create returns gwa_ id", String(created.json.id).startsWith("gwa_"));
ok(
  "C1: create does NOT echo credentials",
  !("credentials" in created.json) && !("credentials_enc" in created.json),
);
ok(
  "C1: currencies normalized to upper-case",
  JSON.stringify(created.json.currencies) === JSON.stringify(["USD"]),
);
ok("C1: livemode derived from business", created.json.livemode === false);
const gwaId = created.json.id as string;

// Read paths never echo credentials.
const got = await api("GET", `/v1/businesses/${testBiz.publicId}/gateway_accounts/${gwaId}`);
ok("C1: get gateway account", got.status === 200 && got.json.id === gwaId);
ok(
  "C1: get does NOT echo credentials",
  !("credentials" in got.json) && !("credentials_enc" in got.json),
);
const listed = await api("GET", `/v1/businesses/${testBiz.publicId}/gateway_accounts`);
// testBiz auto-provisioned its own TM Test Gateway account (TL-5) on creation,
// so the list holds that one PLUS the one just created here.
ok(
  "C1: list returns the account",
  Array.isArray(listed.json.data) &&
    (listed.json.data as { id: string }[]).some((a) => a.id === gwaId),
);

// Update (re-encrypt credentials) bumps resource_version.
const updated = await api("PATCH", `/v1/businesses/${testBiz.publicId}/gateway_accounts/${gwaId}`, {
  label: "Renamed",
  credentials: {},
});
ok("C1: update label", updated.status === 200 && updated.json.label === "Renamed");
ok(
  "C1: update bumps resource_version",
  Number(updated.json.resource_version) > Number(created.json.resource_version),
);
ok("C1: update does NOT echo credentials", !("credentials" in updated.json));

// Verify health-check → ok (tmtest's probe is always healthy, no network call).
const verified = await api(
  "POST",
  `/v1/businesses/${testBiz.publicId}/gateway_accounts/${gwaId}/verify`,
);
ok("C1: verify health-check → ok", verified.status === 200 && verified.json.ok === true);

// Unsupported gateway key → 400.
const bad = await api(
  "POST",
  `/v1/businesses/${testBiz.publicId}/gateway_accounts`,
  { gateway_key: "no_such_gateway", label: "x", credentials: {} },
  "gwa-bad",
);
ok("C1: unsupported gateway_key → 400", bad.status === 400);

// tmtest on a LIVE business → 400 (TL-6 invariant).
const tmtestLive = await api(
  "POST",
  `/v1/businesses/${liveBiz.publicId}/gateway_accounts`,
  { gateway_key: "tmtest", label: "TM Test", credentials: {} },
  "gwa-tmlive",
);
ok("C1: tmtest on live business → 400", tmtestLive.status === 400);

// tmtest on a TEST business → allowed; livemode false.
const tmtestTest = await api(
  "POST",
  `/v1/businesses/${testBiz.publicId}/gateway_accounts`,
  { gateway_key: "tmtest", label: "TM Test", credentials: {} },
  "gwa-tmtest",
);
ok("C1: tmtest on test business → 201", tmtestTest.status === 201);
ok("C1: tmtest account livemode=false", tmtestTest.json.livemode === false);

// Delete.
const del = await api("DELETE", `/v1/businesses/${testBiz.publicId}/gateway_accounts/${gwaId}`);
ok("C1: delete → deleted", del.status === 200 && del.json.deleted === true);
const gone = await api("GET", `/v1/businesses/${testBiz.publicId}/gateway_accounts/${gwaId}`);
ok("C1: get after delete → 404", gone.status === 404);

// A delete that would strand records pointing at the account is refused, and deletes nothing.
{
  const orgId = org.organization.id;
  const inUse = await createGatewayAccount({
    organizationId: orgId,
    businessId: testBiz.id,
    gatewayKey: "tmtest",
    label: "In use",
    credentials: {},
  });
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: testBiz.id,
    email: `gwa-del-${randomUUID()}@gw.test`,
  });
  const pm = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(paymentMethods)
      .values({
        organizationId: orgId,
        businessId: testBiz.id,
        customerId: cus.id,
        publicId: publicId("pm"),
        providerKey: "tmtest",
        providerCustomerId: `tmcus_${cus.publicId}`,
        providerPaymentMethodId: `tmpm_${randomUUID()}`,
        type: "card",
        gatewayAccountId: inUse.id,
      })
      .returning();
    return row!;
  });
  const path = `/v1/businesses/${testBiz.publicId}/gateway_accounts/${inUse.publicId}`;
  const refused = await api("DELETE", path);
  const msg = String((refused.json.error as { message?: string } | undefined)?.message ?? "");
  ok(
    "C1: delete with a saved payment method → 409",
    refused.status === 409,
    String(refused.status),
  );
  ok(
    "C1: the 409 names the saved payment method and points to Disabled",
    msg.includes("1 saved payment method") && msg.includes("Disabled"),
    msg,
  );
  const still = await api("GET", path);
  ok("C1: refused delete keeps the account", still.status === 200);
  const pmLeft = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, pm.id)),
  );
  ok("C1: refused delete keeps the payment method", pmLeft.length === 1);

  // An unsettled transaction blocks too, once the method is gone.
  await withTenant(orgId, async (tx) => {
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, pm.id));
    await tx.insert(transactions).values({
      organizationId: orgId,
      businessId: testBiz.id,
      customerId: cus.id,
      publicId: publicId("txn"),
      type: "payment",
      status: "in_progress",
      amountMinor: 1000n,
      currency: "USD",
      gatewayAccountId: inUse.id,
      gatewayKey: "tmtest",
      occurredAt: new Date(),
    });
  });
  const pending = await api("DELETE", path);
  ok(
    "C1: delete with a transaction in progress → 409",
    pending.status === 409 &&
      String((pending.json.error as { message?: string })?.message).includes(
        "1 transaction without a final result",
      ),
    JSON.stringify(pending.json),
  );

  // Settled (and older than the refund window): nothing blocks any more.
  await withTenant(orgId, (tx) =>
    tx
      .update(transactions)
      .set({ status: "failed", occurredAt: new Date(Date.now() - 200 * 86_400_000) })
      .where(eq(transactions.gatewayAccountId, inUse.id)),
  );
  const freed = await api("DELETE", path);
  ok("C1: delete once nothing uses the account → deleted", freed.status === 200, freed.status + "");
}

// ── C2: router — currency split, ambiguity, default, no-gateway, override ──────
{
  const rBiz = await createBusiness({
    organizationId: org.organization.id,
    name: "Router Biz",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const orgId = org.organization.id;
  const usd = await createGatewayAccount({
    organizationId: orgId,
    businessId: rBiz.id,
    gatewayKey: "stripe",
    label: "USD acct",
    credentials: {},
    currencies: ["USD"],
  });
  const inr = await createGatewayAccount({
    organizationId: orgId,
    businessId: rBiz.id,
    gatewayKey: "stripe",
    label: "INR acct",
    credentials: {},
    currencies: ["INR"],
  });

  const pickUsd = await withTenant(orgId, (tx) =>
    selectGatewayAccount(tx, { businessId: rBiz.id, currency: "USD" }),
  );
  ok("C2: routes USD → USD account", pickUsd.id === usd.id);
  const pickInr = await withTenant(orgId, (tx) =>
    selectGatewayAccount(tx, { businessId: rBiz.id, currency: "INR" }),
  );
  ok("C2: routes INR → INR account", pickInr.id === inr.id);

  // No gateway for EUR → error (no silent fallback).
  let noGw = "";
  try {
    await withTenant(orgId, (tx) =>
      selectGatewayAccount(tx, { businessId: rBiz.id, currency: "EUR" }),
    );
  } catch (e) {
    if (e instanceof GatewayRouterError) noGw = e.code;
  }
  ok("C2: no gateway for currency → no_gateway_for_currency", noGw === "no_gateway_for_currency");

  /**
   * ── A token-bound charge is not a routing decision ──────────────────────────
   *
   * `currencies` picks WHICH account to route to. When the account is the one that
   * VAULTED the instrument, nothing else can charge that token — so refusing on the
   * currency list does not choose a better account, it guarantees no charge at all, on a
   * renewal, into dunning. This is what would have broken 32 migrated subscriptions:
   * cards vaulted on a Stripe account whose `currencies` omitted INR, after years of
   * being charged in INR.
   *
   * The refusal STAYS for a pinned account, because that pin arrives in a public request
   * body (`resolvePinnedAccount`) where validating it is a security control.
   */
  let pinRefused = "";
  try {
    await withTenant(orgId, (tx) =>
      selectGatewayAccount(tx, {
        businessId: rBiz.id,
        currency: "USD",
        override: inr.publicId,
      }),
    );
  } catch (e) {
    if (e instanceof GatewayRouterError) pinRefused = e.code;
  }
  ok(
    "C2+: a PINNED account outside its currencies is still refused",
    pinRefused === "no_gateway_for_currency",
  );

  let tokenBoundPick: string | null = null;
  let tokenBoundError = "";
  try {
    const picked = await withTenant(orgId, (tx) =>
      selectGatewayAccount(tx, {
        businessId: rBiz.id,
        currency: "USD",
        override: inr.publicId,
        tokenBound: true,
      }),
    );
    tokenBoundPick = picked.id;
  } catch (e) {
    tokenBoundError = (e as Error).message;
  }
  ok(
    "C2+: a TOKEN-BOUND account charges outside its currencies (the gateway decides)",
    tokenBoundPick === inr.id,
  );
  ok("C2+: …and does not raise", tokenBoundError === "");

  /**
   * ── A GATEWAY THAT REJECTS THE REQUEST IS STILL AN OUTCOME (caller-level #63) ──
   *
   * Adapters return genuine declines as DATA, so a THROW out of `createIntent` is the
   * request being rejected. Production 2026-09-06: Stripe refused a Collect now, the
   * adapter threw, and `createPaymentIntent` booked NOTHING — no intent, no attempt, no
   * transaction. The failure survived only in `gateway_request_logs`.
   *
   * Driven through the account credential `create_intent_fault`, not a magic amount: the
   * amount namespace is exhausted and a value chosen there hijacks every fixture ending in
   * the same two digits. `reject` throws before minting anything; `reject_stranding` below
   * refuses AFTER creating the object, which is Stripe's real shape for the missing
   * `mandate` and RazorPay's for an order it keeps.
   */
  {
    const rjOrg = await createOrganization({ name: "Reject Co" });
    const rjOrgId = rjOrg.organization.id;
    const rjBiz = await createBusiness({
      organizationId: rjOrgId,
      name: "Reject Biz",
      defaultCurrency: "INR",
      livemode: "test", // auto-provisions the TM Test Gateway account
    });
    const rjCus = await createCustomer({
      organizationId: rjOrgId,
      businessId: rjBiz.id,
      email: `reject-${randomUUID()}@gw.test`,
    });
    // The fault lives on THIS account's credentials, so nothing else in the suite is
    // affected — a magic amount would hijack every fixture ending in the same two digits
    // (measured: `4321` crashed this suite on the first attempt).
    const rjAcct = await createGatewayAccount({
      organizationId: rjOrgId,
      businessId: rjBiz.id,
      gatewayKey: "tmtest",
      label: "Rejecting gateway",
      credentials: { create_intent_fault: "reject" },
    });
    const rjPm = await vaultPaymentMethod({
      organizationId: rjOrgId,
      businessId: rjBiz.id,
      customer: rjCus,
      token: "tok_4242",
      gatewayAccountId: rjAcct.publicId,
    });

    let threw = "";
    try {
      await createPaymentIntent({
        organizationId: rjOrgId,
        businessId: rjBiz.id,
        purpose: "payment",
        paymentMethodPublicId: rjPm.publicId,
        amountMinor: 5_000,
        currency: "INR",
      });
    } catch (e) {
      threw = (e as Error).message;
    }
    // RETHROWN, never swallowed: the row is a record, not a verdict. An engine bug must
    // still reach the caller.
    ok("C63+: a rejected request still THROWS to the caller", threw !== "", threw.slice(0, 80));

    const booked = await withTenant(rjOrgId, (tx) =>
      tx.select().from(paymentIntents).where(eq(paymentIntents.businessId, rjBiz.id)),
    );
    ok("C63+: …and the intent is RECORDED, not lost", booked.length === 1);
    const attempts = booked[0]
      ? await withTenant(rjOrgId, (tx) =>
          tx
            .select()
            .from(paymentAttempts)
            .where(eq(paymentAttempts.paymentIntentId, booked[0]!.id)),
        )
      : [];
    ok(
      "C63+: …with a failed attempt behind it",
      attempts.length === 1 && attempts[0]!.status === "failed",
    );
    ok(
      "C63+: …classified as OUR fault, non-retriable",
      attempts[0]?.errorCode === "gateway_request_rejected",
      attempts[0]?.errorCode ?? "(none)",
    );

    /**
     * …AND IT REACHES THE ONE LIST ANYONE READS.
     *
     * An intent and an attempt are internal rows. The INVOICE lists transactions, the
     * customer's Transactions tab lists transactions, and the gateway's id lives on one —
     * so a refusal that books none leaves the operator who clicked Pay now looking at a
     * screen that appears untouched. That is how the 2026-09-06 mandate failure stayed
     * unnoticed until a money-safety alert called the leftover intent an orphan.
     */
    const rjTxns = await withTenant(rjOrgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.businessId, rjBiz.id)),
    );
    ok(
      "C63+: …and a TRANSACTION, which is what the invoice and the customer actually list",
      rjTxns.length === 1,
      `${rjTxns.length} rows`,
    );
    ok(
      "C63+: …booked as a failure, carrying the reason",
      rjTxns[0]?.status === "failed" && rjTxns[0]?.errorCode === "gateway_request_rejected",
      `${rjTxns[0]?.status}/${rjTxns[0]?.errorCode}`,
    );
    ok(
      "C63+: …joined to the intent and the attempt that produced it",
      rjTxns[0]?.paymentIntentId === booked[0]?.id &&
        rjTxns[0]?.paymentAttemptId === attempts[0]?.id,
    );

    /**
     * A GATEWAY THAT REFUSES BUT KEEPS THE OBJECT.
     *
     * Stripe's shape for the missing `mandate`, and RazorPay's for a stranded order: the
     * request failed, the object exists, and its id is the only handle on money armed at
     * the gateway. It has to survive onto BOTH the intent row and the transaction —
     * without it the object is reachable only through `orphaned_gateway_intents`, which is
     * an alert, not a record, and one that cannot tell a handled orphan from a new one.
     *
     * Its own business, so the single-transaction assertions above stay exact.
     */
    const stBiz = await createBusiness({
      organizationId: rjOrgId,
      name: "Stranding Biz",
      defaultCurrency: "INR",
      livemode: "test",
    });
    const stCus = await createCustomer({
      organizationId: rjOrgId,
      businessId: stBiz.id,
      email: `strand-${randomUUID()}@gw.test`,
    });
    const stAcct = await createGatewayAccount({
      organizationId: rjOrgId,
      businessId: stBiz.id,
      gatewayKey: "tmtest",
      label: "Stranding gateway",
      credentials: { create_intent_fault: "reject_stranding" },
    });
    const stPm = await vaultPaymentMethod({
      organizationId: rjOrgId,
      businessId: stBiz.id,
      customer: stCus,
      token: "tok_4242",
      gatewayAccountId: stAcct.publicId,
    });
    // Returned as data, not thrown — so this call SUCCEEDS and hands back a failed intent.
    const stranded = await createPaymentIntent({
      organizationId: rjOrgId,
      businessId: stBiz.id,
      purpose: "payment",
      paymentMethodPublicId: stPm.publicId,
      amountMinor: 5_000,
      currency: "INR",
    });
    const strandedId = stranded.intent.intentAtGateway;
    ok(
      "C63+: a refusal that STRANDED an object keeps its gateway id on the intent",
      !!strandedId,
      strandedId ?? "(none)",
    );
    const stTxns = await withTenant(rjOrgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.businessId, stBiz.id)),
    );
    ok(
      "C63+: …and the TRANSACTION holds that same id — the handle on the armed money",
      stTxns.length === 1 && !!strandedId && stTxns[0]?.idAtGateway === strandedId,
      `${stTxns.length} rows, id=${stTxns[0]?.idAtGateway ?? "(none)"}`,
    );

    // The RETRY is the create path's twin and had the identical gap — an attempt on
    // record, nothing on the invoice. Covered here rather than trusted: this is exactly
    // the shape of a fix landing on one path and not the other.
    await retryPaymentIntent(rjOrgId, stBiz.id, stranded.intent.publicId);
    const stAfterRetry = await withTenant(rjOrgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.businessId, stBiz.id)),
    );
    ok(
      "C63+: …and a RETRY that is refused books its own transaction, not silence",
      stAfterRetry.length === 2,
      `${stAfterRetry.length} rows`,
    );
    ok(
      "C63+: …carrying the id of the object THAT attempt stranded",
      stAfterRetry.every((t) => !!t.idAtGateway) &&
        new Set(stAfterRetry.map((t) => t.idAtGateway)).size === 2,
      stAfterRetry.map((t) => t.idAtGateway ?? "(none)").join(", "),
    );

    /**
     * …but an INDETERMINATE outcome must record NOTHING. A timeout means the gateway may
     * well have processed the request; booking a definite failure over an unknown state
     * is worse than booking none, and would also let dunning act on a fiction.
     */
    const indetAcct = await createGatewayAccount({
      organizationId: rjOrgId,
      businessId: rjBiz.id,
      gatewayKey: "tmtest",
      label: "Timing-out gateway",
      credentials: { create_intent_fault: "indeterminate" },
    });
    const indetPm = await vaultPaymentMethod({
      organizationId: rjOrgId,
      businessId: rjBiz.id,
      customer: rjCus,
      token: "tok_4242",
      gatewayAccountId: indetAcct.publicId,
    });
    let indeterminate = "";
    try {
      await createPaymentIntent({
        organizationId: rjOrgId,
        businessId: rjBiz.id,
        purpose: "payment",
        paymentMethodPublicId: indetPm.publicId,
        amountMinor: 5_000,
        currency: "INR",
      });
    } catch (e) {
      indeterminate = (e as Error).name;
    }
    ok(
      "C63+: an INDETERMINATE outcome still throws",
      indeterminate === "ProviderIndeterminateError",
      indeterminate,
    );
    const afterIndet = await withTenant(rjOrgId, (tx) =>
      tx.select().from(paymentIntents).where(eq(paymentIntents.businessId, rjBiz.id)),
    );
    ok(
      "C63+: …and books NOTHING — an unknown state is not a failure",
      afterIndet.length === booked.length,
      `${booked.length} → ${afterIndet.length}`,
    );

    /**
     * THE VAULT STEP, BEFORE `createIntent`. A setup intent creates the gateway customer
     * first; a gateway that refused our keys there answered 500 and booked nothing.
     * Driven through `ensure_customer_fault`, over HTTP so the status is what is checked.
     */
    const vfBiz = await createBusiness({
      organizationId: org.organization.id,
      name: "Vault Fault Biz",
      defaultCurrency: "INR",
      livemode: "test",
    });
    const vfCus = await createCustomer({
      organizationId: org.organization.id,
      businessId: vfBiz.id,
      email: `vault-fault-${randomUUID()}@gw.test`,
    });
    const vfIntents = () =>
      withTenant(org.organization.id, (tx) =>
        tx.select().from(paymentIntents).where(eq(paymentIntents.businessId, vfBiz.id)),
      );
    for (const fault of ["reject", "indeterminate"] as const) {
      const acct = await createGatewayAccount({
        organizationId: org.organization.id,
        businessId: vfBiz.id,
        gatewayKey: "tmtest",
        label: `Customer ${fault}`,
        credentials: { ensure_customer_fault: fault },
      });
      const before = (await vfIntents()).length;
      const res = await api("POST", `/v1/businesses/${vfBiz.publicId}/payment_intents`, {
        purpose: "setup",
        customer: vfCus.publicId,
        currency: "INR",
        gateway_account: acct.publicId,
      });
      const after = await vfIntents();
      if (fault === "reject") {
        ok("C63+: a vault-step refusal answers 400, not 500", res.status === 400, `${res.status}`);
        const row = after.length === before + 1 ? after[after.length - 1] : undefined;
        const attempts = row
          ? await withTenant(org.organization.id, (tx) =>
              tx.select().from(paymentAttempts).where(eq(paymentAttempts.paymentIntentId, row.id)),
            )
          : [];
        ok(
          "C63+: …and books the intent with a failed gateway_request_rejected attempt",
          attempts.length === 1 &&
            attempts[0]!.status === "failed" &&
            attempts[0]!.errorCode === "gateway_request_rejected",
          `${after.length - before} intents, ${attempts[0]?.status}/${attempts[0]?.errorCode}`,
        );
      } else {
        ok("C63+: a vault-step timeout answers 502", res.status === 502, `${res.status}`);
        ok("C63+: …and books NOTHING", after.length === before, `${before} → ${after.length}`);
      }
    }

    /** A public intent's currency is the business's default or on its currency list. */
    const curBiz = await createBusiness({
      organizationId: org.organization.id,
      name: "PI Currency Biz",
      defaultCurrency: "INR",
      livemode: "test",
    });
    const curCus = await createCustomer({
      organizationId: org.organization.id,
      businessId: curBiz.id,
      email: `pi-currency-${randomUUID()}@gw.test`,
    });
    const setupIn = (currency: string) =>
      api("POST", `/v1/businesses/${curBiz.publicId}/payment_intents`, {
        purpose: "setup",
        customer: curCus.publicId,
        currency,
      });
    const errMsg = (r: { json: Record<string, unknown> }) =>
      String((r.json.error as { message?: string } | undefined)?.message ?? "");
    const offList = await setupIn("USD");
    ok(
      "PI currency: a currency the business does not bill in answers 400",
      offList.status === 400 && /does not bill in USD/.test(errMsg(offList)),
      `${offList.status} ${errMsg(offList)}`,
    );
    const onDefault = await setupIn("INR");
    ok(
      "PI currency: the default currency is taken",
      onDefault.status === 201,
      `${onDefault.status} ${errMsg(onDefault)}`,
    );
    await updateBusiness(org.organization.id, curBiz.publicId, { currencies: ["USD"] });
    const onList = await setupIn("USD");
    ok(
      "PI currency: an enabled currency is taken",
      onList.status === 201,
      `${onList.status} ${errMsg(onList)}`,
    );
  }

  // Two USD-capable accounts → ambiguous without a default.
  const usd2 = await createGatewayAccount({
    organizationId: orgId,
    businessId: rBiz.id,
    gatewayKey: "stripe",
    label: "USD acct 2",
    credentials: {},
    currencies: ["USD"],
  });
  let amb = "";
  try {
    await withTenant(orgId, (tx) =>
      selectGatewayAccount(tx, { businessId: rBiz.id, currency: "USD" }),
    );
  } catch (e) {
    if (e instanceof GatewayRouterError) amb = e.code;
  }
  ok("C2: ambiguous match → ambiguous_gateway", amb === "ambiguous_gateway");

  // Setting a default resolves the ambiguity.
  await setDefaultGatewayAccount(orgId, rBiz.id, usd2.publicId);
  const picked = await withTenant(orgId, (tx) =>
    selectGatewayAccount(tx, { businessId: rBiz.id, currency: "USD" }),
  );
  ok("C2: default resolves ambiguity", picked.id === usd2.id);

  // Override forces a specific account.
  const overridden = await withTenant(orgId, (tx) =>
    selectGatewayAccount(tx, { businessId: rBiz.id, currency: "USD", override: usd.publicId }),
  );
  ok("C2: override forces the named account", overridden.id === usd.id);

  // Method-type filter: an account restricted to 'upi' won't serve a card charge.
  const upiOnly = await createGatewayAccount({
    organizationId: orgId,
    businessId: rBiz.id,
    gatewayKey: "stripe",
    label: "UPI only",
    credentials: {},
    currencies: ["SGD"],
    methodTypes: ["upi"],
  });
  let noMethod = "";
  try {
    await withTenant(orgId, (tx) =>
      selectGatewayAccount(tx, { businessId: rBiz.id, currency: "SGD", methodType: "card" }),
    );
  } catch (e) {
    if (e instanceof GatewayRouterError) noMethod = e.code;
  }
  ok("C2: method-type mismatch → no_gateway_for_currency", noMethod === "no_gateway_for_currency");
  const upiPick = await withTenant(orgId, (tx) =>
    selectGatewayAccount(tx, { businessId: rBiz.id, currency: "SGD", methodType: "upi" }),
  );
  ok("C2: method-type match routes correctly", upiPick.id === upiOnly.id);
}

// ── C2p: routing by purpose ──────────────────────────────────────────────────
// GoCardless only saves methods (`intentPurposes: ["setup"]`). Beside a gateway that takes
// payments, a pay-now must route past it — even when it is the business default.
{
  const orgId = org.organization.id;
  const pick = (businessId: string, purpose?: "payment" | "setup") =>
    withTenant(orgId, (tx) => selectGatewayAccount(tx, { businessId, currency: "USD", purpose }));
  const routerCode = async (businessId: string, purpose?: "payment" | "setup") => {
    try {
      await pick(businessId, purpose);
      return "";
    } catch (e) {
      return e instanceof GatewayRouterError ? `${e.code}: ${e.message}` : (e as Error).message;
    }
  };
  // A test business auto-provisions one tmtest account (no currency list, no default).
  const pBiz = await createBusiness({
    organizationId: orgId,
    name: "Purpose Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const tm = (await listGatewayAccounts(orgId, pBiz.id)).find((a) => a.gatewayKey === "tmtest")!;
  const gc = await createGatewayAccount({
    organizationId: orgId,
    businessId: pBiz.id,
    gatewayKey: "gocardless",
    label: "GC USD",
    credentials: {},
    currencies: ["USD"],
  });

  ok(
    "C2p: no default, no purpose → ambiguous_gateway (unchanged)",
    (await routerCode(pBiz.id)).startsWith("ambiguous_gateway"),
  );
  ok(
    "C2p: no default, pay-now → the one account that takes payments",
    (await pick(pBiz.id, "payment")).publicId === tm.publicId,
  );
  ok(
    "C2p: no default, setup → still ambiguous (both can save a method)",
    (await routerCode(pBiz.id, "setup")).startsWith("ambiguous_gateway"),
  );

  await setDefaultGatewayAccount(orgId, pBiz.id, gc.publicId);
  ok(
    "C2p: setup-only default, pay-now → routes past it",
    (await pick(pBiz.id, "payment")).publicId === tm.publicId,
  );
  ok(
    "C2p: setup-only default, setup → the default",
    (await pick(pBiz.id, "setup")).publicId === gc.publicId,
  );
  ok(
    "C2p: setup-only default, no purpose → the default (renewals unchanged)",
    (await pick(pBiz.id)).publicId === gc.publicId,
  );

  // End to end: a buyer-present pay-now used to land on GoCardless and fail the intent guard.
  const pCus = await createCustomer({
    organizationId: orgId,
    businessId: pBiz.id,
    email: "purpose@gw.test",
  });
  let payNowError = "";
  let payNowAccount: string | null = null;
  try {
    const { intent } = await createPaymentIntent({
      organizationId: orgId,
      businessId: pBiz.id,
      purpose: "payment",
      customerPublicId: pCus.publicId,
      letBuyerChooseMethod: true,
      amountMinor: 2_500,
      currency: "USD",
      returnUrl: "https://shop.example.com/return",
    });
    const tmRow = await getGatewayAccount(orgId, pBiz.id, tm.publicId);
    payNowAccount = intent.gatewayAccountId === tmRow?.id ? tm.publicId : intent.gatewayAccountId;
  } catch (e) {
    payNowError = (e as Error).message;
  }
  ok(
    "C2p: pay-now intent with a setup-only default routes to the paying gateway",
    payNowAccount === tm.publicId,
    payNowError || String(payNowAccount),
  );

  // Only a setup-only account left: pay-now names the purpose; setup still routes.
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: pBiz.id,
    gwaPublicId: tm.publicId,
    status: "disabled",
  });
  const onlyGc = await routerCode(pBiz.id, "payment");
  ok(
    "C2p: setup-only account alone, pay-now → no_gateway_for_currency naming the purpose",
    onlyGc.startsWith("no_gateway_for_currency") && onlyGc.includes("for a payment now"),
    onlyGc,
  );
  ok(
    "C2p: setup-only account alone, setup → routes",
    (await pick(pBiz.id, "setup")).publicId === gc.publicId,
  );
}

// ── WH: webhook-endpoint ownership ────────────────────────────────────────────
// tmbilling owns the webhook verification material — the operator is never asked
// for a signing secret. RazorPay (no provisioning API) gets a secret WE generate
// at creation; Stripe/PayPal endpoints are registered through the adapter.
{
  const orgId = org.organization.id;
  const wBiz = await createBusiness({
    organizationId: orgId,
    name: "Webhook Biz",
    defaultCurrency: "INR",
    livemode: "test",
  });

  // RazorPay: secret auto-generated at creation, no operator input.
  const rz = await createGatewayAccount({
    organizationId: orgId,
    businessId: wBiz.id,
    gatewayKey: "razorpay",
    label: "RZP",
    credentials: { key_id: "rzp_test_x", key_secret: "s" },
  });
  const rzRow = (await getGatewayAccount(orgId, wBiz.id, rz.publicId))!;
  const rzCreds = decryptCredentials(rzRow.credentialsEnc);
  ok(
    "WH: razorpay account auto-generates a webhook_secret (never asked for)",
    typeof rzCreds.webhook_secret === "string" && (rzCreds.webhook_secret as string).length >= 32,
  );
  ok(
    "WH: serializer reports webhook_secret_configured without echoing it",
    serializeGatewayAccount(rzRow).webhook_secret_configured === true &&
      !JSON.stringify(serializeGatewayAccount(rzRow)).includes(rzCreds.webhook_secret as string),
  );

  // A caller-supplied secret is respected (not clobbered by the generator).
  const rz2 = await createGatewayAccount({
    organizationId: orgId,
    businessId: wBiz.id,
    gatewayKey: "razorpay",
    label: "RZP2",
    credentials: { key_id: "rzp_test_y", key_secret: "s", webhook_secret: "operator-chosen" },
  });
  const rz2Creds = decryptCredentials(
    (await getGatewayAccount(orgId, wBiz.id, rz2.publicId))!.credentialsEnc,
  );
  ok(
    "WH: caller-supplied webhook_secret is preserved",
    rz2Creds.webhook_secret === "operator-chosen",
  );

  // Endpoint info: paste-required gateway hides the secret unless revealed.
  const infoHidden = await getWebhookEndpointInfo({
    organizationId: orgId,
    businessId: wBiz.id,
    gatewayAccountPublicId: rz.publicId,
  });
  ok(
    "WH: razorpay endpoint mode = paste_required + configured",
    infoHidden.mode === "paste_required" && infoHidden.configured === true,
  );
  ok("WH: secret withheld unless reveal=true", infoHidden.secret === null);
  const infoShown = await getWebhookEndpointInfo({
    organizationId: orgId,
    businessId: wBiz.id,
    gatewayAccountPublicId: rz.publicId,
    reveal: true,
  });
  ok("WH: reveal=true returns the secret", infoShown.secret === rzCreds.webhook_secret);

  // The secret forges inbound webhooks: a read key (gateways:view) must not reveal it.
  const readKey = await createApiKey(orgId, "test", "api", "read");
  const asReader = (q: string) =>
    fetch(
      `${base}/v1/businesses/${wBiz.publicId}/gateway_accounts/${rz.publicId}/webhook_endpoint${q}`,
      { headers: { Authorization: `Bearer ${readKey.secret}` } },
    ).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
  const readReveal = await asReader("?reveal=true");
  ok(
    "WH: read key + reveal=true → 403 gateways:manage, no secret",
    readReveal.status === 403 &&
      readReveal.json.error?.required === "gateways:manage" &&
      !JSON.stringify(readReveal.json).includes(rzCreds.webhook_secret as string),
  );
  const readPlain = await asReader("");
  ok(
    "WH: read key without reveal → 200, secret withheld",
    readPlain.status === 200 && readPlain.json.secret === null,
  );
  const writeReveal = await api(
    "GET",
    `/v1/businesses/${wBiz.publicId}/gateway_accounts/${rz.publicId}/webhook_endpoint?reveal=true`,
  );
  ok(
    "WH: write key + reveal=true still returns the secret",
    writeReveal.status === 200 && writeReveal.json.secret === rzCreds.webhook_secret,
  );

  // Notification URL carries the gateway account id so inbound events attribute
  // to this exact account.
  ok(
    "WH: notification URL carries ?id=<gwa>",
    infoHidden.notification_url.includes(`id=${rz.publicId}`),
  );

  // tmtest has no external endpoint.
  const tmAcct = await createGatewayAccount({
    organizationId: orgId,
    businessId: wBiz.id,
    gatewayKey: "tmtest",
    label: "TM",
    credentials: {},
  });
  const tmInfo = await getWebhookEndpointInfo({
    organizationId: orgId,
    businessId: wBiz.id,
    gatewayAccountPublicId: tmAcct.publicId,
  });
  ok("WH: tmtest endpoint mode = not_applicable", tmInfo.mode === "not_applicable");

  // Stripe is self-provisioning: nothing to paste, so no secret is ever surfaced.
  const stAcct = await createGatewayAccount({
    organizationId: orgId,
    businessId: wBiz.id,
    gatewayKey: "stripe",
    label: "ST",
    credentials: { secret_key: "sk_test_x" },
  });
  const stInfo = await getWebhookEndpointInfo({
    organizationId: orgId,
    businessId: wBiz.id,
    gatewayAccountPublicId: stAcct.publicId,
    reveal: true,
  });
  ok(
    "WH: stripe endpoint mode = self_provisioned, no secret surfaced",
    stInfo.mode === "self_provisioned" && stInfo.secret === null,
  );
  ok("WH: stripe endpoint not configured until provisioned", stInfo.configured === false);

  // RazorPay registration, against a stubbed API on a dedicated `api_base` (every other
  // fetch passes through). The stub keeps its endpoints, so a re-provision takes the PUT path.
  const stubBase = "https://rzp-stub.invalid/v1";
  type StubCall = { method: string; path: string; body: Record<string, unknown> };
  const stubCalls: StubCall[] = [];
  const stubHooks = new Map<string, string>();
  let stubRefuse = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(stubBase)) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const path = url.slice(stubBase.length);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    stubCalls.push({ method, path, body });
    if (method === "GET")
      return Response.json({ items: [...stubHooks].map(([u, id]) => ({ id, url: u })) });
    if (stubRefuse)
      return Response.json({ error: { description: "stubbed refusal" } }, { status: 400 });
    const id =
      stubHooks.get(String(body.url)) ?? `wh_stub${String(stubHooks.size).padStart(9, "0")}`;
    stubHooks.set(String(body.url), id);
    return Response.json({ id });
  }) as typeof fetch;
  const registrations = () => stubCalls.filter((c) => c.method !== "GET");
  const mutableConfig = config as { WEBHOOK_BASE_URL?: string };
  const savedBase = mutableConfig.WEBHOOK_BASE_URL;
  mutableConfig.WEBHOOK_BASE_URL = "https://hooks.example.com";
  const storedCreds = async (gwa: string) =>
    decryptCredentials((await getGatewayAccount(orgId, wBiz.id, gwa))!.credentialsEnc);

  // Between a pin migration's create and promote, re-registering would delete both
  // endpoints at the URL and strand webhook_secret_next.
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: wBiz.id,
    gwaPublicId: stAcct.publicId,
    credentials: { secret_key: "sk_test_x", webhook_secret_next: "whsec_next_x" },
  });
  let pinError = "";
  try {
    await provisionWebhookEndpoint({
      organizationId: orgId,
      businessId: wBiz.id,
      gatewayAccountPublicId: stAcct.publicId,
      force: true,
    });
  } catch (e) {
    pinError = e instanceof Error ? e.message : String(e);
  }
  ok(
    "WH: stripe re-provision is refused while webhook_secret_next is set",
    pinError === WEBHOOK_CHANGE_IN_PROGRESS &&
      (await storedCreds(stAcct.publicId)).webhook_secret_next === "whsec_next_x",
    pinError || "no error",
  );
  const stubCredentials = (keyId: string) => ({
    key_id: keyId,
    key_secret: "s",
    api_base: stubBase,
  });
  try {
    // The secret minted at creation makes the account `configured`, but nothing is
    // registered yet. A plain (non-force) provision must still register, with THAT secret.
    const rzReg = await createGatewayAccount({
      organizationId: orgId,
      businessId: wBiz.id,
      gatewayKey: "razorpay",
      label: "RZP-REG",
      credentials: stubCredentials("rzp_test_reg"),
    });
    const birthSecret = (await storedCreds(rzReg.publicId)).webhook_secret;

    stubRefuse = true;
    const refused = await provisionWebhookEndpoint({
      organizationId: orgId,
      businessId: wBiz.id,
      gatewayAccountPublicId: rzReg.publicId,
    });
    ok(
      "WH: razorpay non-force provision attempts registration",
      registrations().some((c) => c.method === "POST" && c.path === "/webhooks"),
      `stub calls: ${stubCalls.map((c) => `${c.method} ${c.path}`).join(", ") || "none"}`,
    );
    ok(
      "WH: razorpay refused registration → paste_required, secret kept",
      refused.mode === "paste_required" &&
        (await storedCreds(rzReg.publicId)).webhook_secret === birthSecret,
    );

    // The manual steps name exactly the events the automatic registration subscribes to.
    const subscribed = Object.keys(
      (registrations().find((c) => c.path === "/webhooks")?.body.events ?? {}) as object,
    );
    const steps = refused.instructions.join("\n");
    const fallback = GATEWAYS.razorpay.webhook.fallbackInstructions.join("\n");
    const missing = subscribed.filter((e) => !steps.includes(e) || !fallback.includes(e));
    ok(
      "WH: razorpay manual steps list every subscribed event",
      subscribed.length > 0 && missing.length === 0 && !/all events/i.test(steps + fallback),
      `subscribed ${subscribed.length}, missing: ${missing.join(", ") || "none"}`,
    );

    stubRefuse = false;
    stubCalls.length = 0;
    const registered = await provisionWebhookEndpoint({
      organizationId: orgId,
      businessId: wBiz.id,
      gatewayAccountPublicId: rzReg.publicId,
    });
    const post = registrations().find((c) => c.method === "POST" && c.path === "/webhooks");
    ok(
      "WH: razorpay non-force provision registers with the secret minted at creation",
      post?.body.secret === birthSecret &&
        post?.body.url === registered.notification_url &&
        (await storedCreds(rzReg.publicId)).webhook_secret === birthSecret,
    );
    ok(
      "WH: razorpay registered → self_provisioned, secret no longer surfaced",
      registered.mode === "self_provisioned" && registered.secret === null,
    );

    // Rotation: RazorPay must accept the new secret BEFORE we store it. A refused PUT
    // keeps the old secret (which RazorPay still holds) and answers an error.
    stubRefuse = true;
    stubCalls.length = 0;
    let rotateError = "";
    try {
      await provisionWebhookEndpoint({
        organizationId: orgId,
        businessId: wBiz.id,
        gatewayAccountPublicId: rzReg.publicId,
        force: true,
      });
    } catch (e) {
      rotateError = e instanceof Error ? e.message : String(e);
    }
    const afterRefusal = await storedCreds(rzReg.publicId);
    ok(
      "WH: razorpay refused rotation keeps the registered secret and endpoint",
      registrations().some((c) => c.method === "PUT") &&
        afterRefusal.webhook_secret === birthSecret &&
        typeof afterRefusal.webhook_endpoint_id === "string",
    );
    const sentSecret = registrations().find((c) => c.method === "PUT")?.body.secret;
    ok(
      "WH: razorpay unanswered rotation keeps the sent secret as an unconfirmed fallback",
      typeof sentSecret === "string" &&
        afterRefusal[WEBHOOK_SECRET_FALLBACK.secret] === sentSecret &&
        afterRefusal[WEBHOOK_SECRET_FALLBACK.kind] === "unconfirmed" &&
        Date.parse(String(afterRefusal[WEBHOOK_SECRET_FALLBACK.until])) > Date.now(),
    );
    ok(
      "WH: razorpay refused rotation answers a readable error",
      /^We could not rotate the webhook secret\./.test(rotateError),
      rotateError || "no error",
    );
    stubRefuse = false;
    stubCalls.length = 0;
    await provisionWebhookEndpoint({
      organizationId: orgId,
      businessId: wBiz.id,
      gatewayAccountPublicId: rzReg.publicId,
      force: true,
    });
    const put = registrations().find((c) => c.method === "PUT");
    const rotated = (await storedCreds(rzReg.publicId)).webhook_secret;
    ok(
      "WH: razorpay accepted rotation stores the secret RazorPay accepted",
      rotated !== birthSecret && put?.body.secret === rotated,
    );
    const afterRotation = await storedCreds(rzReg.publicId);
    ok(
      "WH: a rotation keeps the replaced secret as a 24h fallback",
      afterRotation[WEBHOOK_SECRET_FALLBACK.secret] === birthSecret &&
        afterRotation[WEBHOOK_SECRET_FALLBACK.kind] === "previous" &&
        Math.abs(
          Date.parse(String(afterRotation[WEBHOOK_SECRET_FALLBACK.until])) -
            (Date.now() + 24 * 3600_000),
        ) < 60_000,
    );

    // Inbound: the fallback verifies while its window is open; anything else is refused.
    const rzBody = JSON.stringify({ event: "tmbilling.probe", payload: {} });
    const deliver = (secret: string) =>
      ingestGatewayWebhook({
        gatewayKey: "razorpay",
        gatewayAccountPublicId: rzReg.publicId,
        rawBody: rzBody,
        headers: {
          "x-razorpay-signature": createHmac("sha256", secret).update(rzBody).digest("hex"),
          "x-razorpay-event-id": `evt_probe_${randomUUID()}`,
        },
      }).then(
        () => true,
        () => false,
      );
    ok("WH: inbound signed with the current secret verifies", await deliver(String(rotated)));
    ok(
      "WH: inbound signed with the replaced secret verifies in its window",
      await deliver(String(birthSecret)),
    );
    ok("WH: inbound signed with another secret is refused", !(await deliver("not-our-secret")));
    const writeCreds = async (c: Record<string, unknown>) => {
      const row = (await getGatewayAccount(orgId, wBiz.id, rzReg.publicId))!;
      await updateGatewayAccount({
        organizationId: orgId,
        businessId: wBiz.id,
        gwaPublicId: rzReg.publicId,
        credentials: c as Record<string, string>,
      });
      return row;
    };
    const expired = {
      ...afterRotation,
      [WEBHOOK_SECRET_FALLBACK.until]: new Date(Date.now() - 1000).toISOString(),
    };
    await writeCreds(expired);
    ok(
      "WH: inbound signed with the replaced secret is refused after its window",
      !(await deliver(String(birthSecret))),
    );
    // An unconfirmed secret that verifies a delivery becomes the primary.
    const unconfirmed = "unconfirmed-secret-probe";
    const withUnconfirmed = { ...(await storedCreds(rzReg.publicId)) };
    setWebhookSecretFallback(withUnconfirmed, unconfirmed, "unconfirmed");
    await writeCreds(withUnconfirmed);
    ok("WH: inbound signed with an unconfirmed secret verifies", await deliver(unconfirmed));
    const promoted = await storedCreds(rzReg.publicId);
    ok(
      "WH: the unconfirmed secret that verified a delivery is promoted; the old one is the fallback",
      promoted.webhook_secret === unconfirmed &&
        promoted[WEBHOOK_SECRET_FALLBACK.secret] === rotated &&
        promoted[WEBHOOK_SECRET_FALLBACK.kind] === "previous",
    );

    // Account create over HTTP registers straight away, best effort.
    const createRzp = (label: string) =>
      api("POST", `/v1/businesses/${wBiz.publicId}/gateway_accounts`, {
        gateway_key: "razorpay",
        label,
        credentials: stubCredentials(`rzp_test_${label}`),
      });
    const endpointOf = (gwa: string) =>
      getWebhookEndpointInfo({
        organizationId: orgId,
        businessId: wBiz.id,
        gatewayAccountPublicId: gwa,
      });
    stubCalls.length = 0;
    const onCreate = await createRzp("oncreate");
    ok(
      "WH: razorpay account create registers the endpoint",
      onCreate.status === 201 &&
        registrations().length > 0 &&
        (await endpointOf(String(onCreate.json.id))).mode === "self_provisioned",
      `status ${onCreate.status}, registrations ${registrations().length}`,
    );
    stubRefuse = true;
    const createRefused = await createRzp("refused");
    ok(
      "WH: a refused registration does not fail the create (paste_required)",
      createRefused.status === 201 &&
        (await endpointOf(String(createRefused.json.id))).mode === "paste_required",
    );
    stubRefuse = false;

    // Delete: only the registration with this account's URL is switched off (no DELETE).
    const otherUrl = "https://hooks.example.com/v1/gateway_webhooks/razorpay?id=gwa_OTHERSYSTEM01";
    stubHooks.set(otherUrl, "wh_stubother0001");
    const ownUrl = (await endpointOf(String(onCreate.json.id))).notification_url;
    stubCalls.length = 0;
    const del = await api(
      "DELETE",
      `/v1/businesses/${wBiz.publicId}/gateway_accounts/${String(onCreate.json.id)}`,
    );
    const offs = registrations().filter((c) => c.method === "PUT");
    const removal = del.json.webhook_removal as { status?: string; instructions?: string[] };
    ok(
      "WH: deleting a razorpay account switches off only its own registration",
      del.status === 200 &&
        offs.length === 1 &&
        offs[0]!.body.url === ownUrl &&
        offs[0]!.body.active === false &&
        !registrations().some((c) => c.method === "DELETE"),
      `status ${del.status}, ${JSON.stringify(offs.map((c) => [c.path, c.body.url]))}`,
    );
    ok(
      "WH: the delete answer says deactivated and names the manual step",
      removal?.status === "deactivated" &&
        (removal.instructions ?? []).some((t) => t.includes(ownUrl)),
      JSON.stringify(removal),
    );
    // A gateway that fails never blocks the delete.
    stubHooks.set(
      (await endpointOf(String(createRefused.json.id))).notification_url,
      "wh_stubrefused01",
    );
    stubRefuse = true;
    const delRefused = await api(
      "DELETE",
      `/v1/businesses/${wBiz.publicId}/gateway_accounts/${String(createRefused.json.id)}`,
    );
    stubRefuse = false;
    ok(
      "WH: a refused removal still deletes the account (status failed, manual steps)",
      delRefused.status === 200 &&
        (delRefused.json.webhook_removal as { status?: string })?.status === "failed" &&
        !(await getGatewayAccount(orgId, wBiz.id, String(createRefused.json.id))),
      JSON.stringify(delRefused.json),
    );

    stubCalls.length = 0;
    mutableConfig.WEBHOOK_BASE_URL = undefined;
    const createNoBase = await createRzp("nobase");
    ok(
      "WH: no WEBHOOK_BASE_URL → create makes no gateway call",
      createNoBase.status === 201 && stubCalls.length === 0,
    );
  } finally {
    globalThis.fetch = realFetch;
    mutableConfig.WEBHOOK_BASE_URL = savedBase;
  }
}

// ── WH-CRED: rotating an operator credential must not destroy the webhook secret ──
// The failure this pins is silent and expensive: `updateGatewayAccount` used to
// overwrite `credentials_enc` WHOLESALE, so an operator rotating a RazorPay
// `key_secret` — an ordinary operation — took the webhook secret with it. The adapter
// then builds with no `webhookSecret`, every inbound settlement webhook is rejected,
// and the account keeps registering mandates and collecting money nothing marks paid.
// Semantics pinned here: `credentials` REPLACES the operator's keys and PRESERVES the
// platform's webhook material, and an explicit `null` removes a key of either class —
// the channel that keeps "remove this key" expressible under a preserving merge (see
// `PLATFORM_OWNED_CREDENTIAL_KEYS` § "Chosen semantics").
{
  const orgId = org.organization.id;
  const cBiz = await createBusiness({
    organizationId: orgId,
    name: "Cred Rotation",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: cBiz.id,
    gatewayKey: "razorpay",
    label: "RZP rotate",
    credentials: { key_id: "rzp_test_a", key_secret: "original", api_base: "https://rzp.invalid" },
  });
  const before = decryptCredentials(
    (await getGatewayAccount(orgId, cBiz.id, acct.publicId))!.credentialsEnc,
  );
  const bornWith = String(before.webhook_secret ?? "");
  ok("WH-CRED: account is born holding a generated webhook_secret", bornWith.length >= 32);

  // The rotation itself: a new key_secret, no mention of webhook material.
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: cBiz.id,
    gwaPublicId: acct.publicId,
    credentials: { key_id: "rzp_test_a", key_secret: "rotated" },
  });
  const rotatedRow = (await getGatewayAccount(orgId, cBiz.id, acct.publicId))!;
  const after = decryptCredentials(rotatedRow.credentialsEnc);
  ok(
    "WH-CRED: rotating key_secret PRESERVES the webhook secret",
    after.webhook_secret === bornWith,
  );
  ok("WH-CRED: …and the rotated operator key is the new one", after.key_secret === "rotated");
  ok(
    "WH-CRED: …so the account is still settlement-reachable",
    serializeGatewayAccount(rotatedRow).webhook_secret_configured === true,
  );
  // Operator keys are REPLACED, not merged: `api_base` was omitted, so it is gone. This
  // is how a caller expresses "remove this key" — a blind whole-blob merge would have
  // left a stale credential behind instead.
  ok(
    "WH-CRED: an omitted OPERATOR key is removed (no stale credential survives)",
    !("api_base" in after),
  );
  // Still write-only.
  ok(
    "WH-CRED: the update path echoes no credential",
    !JSON.stringify(serializeGatewayAccount(rotatedRow)).includes(bornWith) &&
      !JSON.stringify(serializeGatewayAccount(rotatedRow)).includes("rotated"),
  );

  // Paired green case: an EXPLICIT webhook_secret still wins — preservation only fills
  // a key the caller did not name, so pasting a new one remains possible.
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: cBiz.id,
    gwaPublicId: acct.publicId,
    credentials: {
      key_id: "rzp_test_a",
      key_secret: "rotated",
      webhook_secret: "operator-chosen-2",
    },
  });
  const explicit = decryptCredentials(
    (await getGatewayAccount(orgId, cBiz.id, acct.publicId))!.credentialsEnc,
  );
  ok(
    "WH-CRED: an explicitly supplied webhook_secret still overwrites",
    explicit.webhook_secret === "operator-chosen-2",
  );

  // ── the REMOVAL channel ────────────────────────────────────────────────────
  // Preserving a platform key on silence makes "remove it" inexpressible unless
  // something else expresses it, and a merge with no removal channel is how a fixture
  // (or an operator) ends up unable to describe an account that genuinely lost its
  // endpoint. `null` is that channel: naming a key is authoritative, and naming it
  // `null` says it must not exist. It is DELETED, not stored as null, so every reader
  // downstream still sees a plain absent key.
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: cBiz.id,
    gwaPublicId: acct.publicId,
    credentials: { key_id: "rzp_test_a", key_secret: "rotated", webhook_secret: null },
  });
  const removedRow = (await getGatewayAccount(orgId, cBiz.id, acct.publicId))!;
  const removed = decryptCredentials(removedRow.credentialsEnc);
  ok(
    "WH-CRED: an explicit null REMOVES a platform key (not stored as null)",
    !("webhook_secret" in removed),
  );
  ok(
    "WH-CRED: …so the account reports itself unreachable for settlement",
    serializeGatewayAccount(removedRow).webhook_secret_configured === false,
  );
  ok("WH-CRED: …and the removal touched nothing else", removed.key_secret === "rotated");
  // Removal is not one-way: the same key can be pasted back.
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: cBiz.id,
    gwaPublicId: acct.publicId,
    credentials: { key_id: "rzp_test_a", key_secret: "rotated", webhook_secret: "pasted-back" },
  });
  ok(
    "WH-CRED: a removed platform key can be pasted back",
    decryptCredentials((await getGatewayAccount(orgId, cBiz.id, acct.publicId))!.credentialsEnc)
      .webhook_secret === "pasted-back",
  );

  // PayPal's endpoint id is platform-owned the same way — it is what PayPal's verify
  // API needs, and the operator never types it.
  const pp = await createGatewayAccount({
    organizationId: orgId,
    businessId: cBiz.id,
    gatewayKey: "paypal",
    label: "PP rotate",
    credentials: { client_id: "c", client_secret: "s", webhook_id: "WH-123" },
  });
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: cBiz.id,
    gwaPublicId: pp.publicId,
    credentials: { client_id: "c", client_secret: "rotated" },
  });
  const ppAfter = decryptCredentials(
    (await getGatewayAccount(orgId, cBiz.id, pp.publicId))!.credentialsEnc,
  );
  ok(
    "WH-CRED: paypal webhook_id survives a client_secret rotation",
    ppAfter.webhook_id === "WH-123",
  );
}

// ── WH-ASYNC: no mandate on a live account whose settlements can't reach us ───
// The check with real money behind it: on an async-settlement rail the inbound
// webhook is the ONLY thing that turns a `pending` debit into cash, so a LIVE
// account with no endpoint registers mandates, collects, and never marks an
// invoice paid. It is asserted through `assertVaultPreconditions` because that is
// the ONE list both add-card entry points now read — the intent path (which is what
// the portal and hosted checkout actually take) used to carry a hand-copied subset
// that left this check out, so it only ever ran on the path nobody takes.
{
  const orgId = org.organization.id;
  const aBiz = await createBusiness({
    organizationId: orgId,
    name: "Async WH Live",
    defaultCurrency: "INR",
    livemode: "live",
  });
  const aCus = await createCustomer({
    organizationId: orgId,
    businessId: aBiz.id,
    email: `async-wh-${randomUUID()}@gw.test`,
    phone: "9876543210",
  });
  const refusal = async (
    account: Awaited<ReturnType<typeof getGatewayAccount>>,
    methodTypes?: string[],
  ): Promise<string> => {
    try {
      await assertVaultPreconditions({
        account: account!,
        customer: aCus,
        ...(methodTypes ? { methodTypes } : {}),
      });
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  // RazorPay: async on EVERY rail. A new account is born holding a generated secret,
  // so it passes; the state under test is the one where that secret is GONE — the
  // account whose settlements can never reach us.
  //
  // The secret is removed with the `null` sentinel rather than by omitting it, because
  // omitting it no longer removes anything: platform-owned webhook material survives a
  // credential rotation on purpose (WH-CRED — a rotation that silently destroyed it was
  // the live path to collecting money nothing marks paid). `null` is the one channel
  // that still says "this key must not exist", so it is what a fixture reproducing a
  // lost endpoint has to use.
  const rzLive = await createGatewayAccount({
    organizationId: orgId,
    businessId: aBiz.id,
    gatewayKey: "razorpay",
    label: "RZP live",
    credentials: { key_id: "rzp_live_x", key_secret: "s" },
  });
  const rzFresh = await refusal(await getGatewayAccount(orgId, aBiz.id, rzLive.publicId), ["upi"]);
  ok(
    "WH-ASYNC: a live razorpay account WITH webhook material may register a mandate",
    rzFresh === "",
    // The refusal itself: a bare `false` here cannot tell "refused for the reason under
    // test" from "refused by something upstream", and those need opposite fixes.
    rzFresh || "(not refused)",
  );
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: aBiz.id,
    gwaPublicId: rzLive.publicId,
    credentials: { key_id: "rzp_live_x", key_secret: "rotated", webhook_secret: null },
  });
  const rzWiped = await refusal(await getGatewayAccount(orgId, aBiz.id, rzLive.publicId), ["upi"]);
  ok(
    "WH-ASYNC: a live razorpay account with no endpoint is refused BEFORE the buyer is sent to the gateway",
    /no webhook endpoint configured/.test(rzWiped),
    rzWiped || "(not refused)",
  );

  // …and through the ENTRY POINT the buyer surfaces actually use. The assertion above
  // proves the rule; this one proves `beginVaultSetup`'s INTENT path consults it —
  // that is the path the portal and hosted checkout take, and it is the one the check
  // was missing from.
  //
  // The message alone does not prove it: `beginVaultSetup` falls back to the legacy
  // call on any non-config error, and the legacy call raises the SAME message one step
  // later. What separates them is whether the gateway was touched at all. The refusal
  // is supposed to land BEFORE the buyer is sent anywhere, so the discriminator is an
  // empty `gateway_request_logs` for this account: skip the check on the intent path
  // and `createPaymentIntent` reaches RazorPay (ensure-customer, then the auth order)
  // before the legacy path can say no.
  let intentPath = "";
  try {
    await beginVaultSetup({
      organizationId: orgId,
      businessId: aBiz.id,
      customer: aCus,
      returnUrl: "https://example.invalid/r",
      cancelUrl: "https://example.invalid/c",
      gatewayAccountId: rzLive.publicId,
      methodTypes: ["upi"],
    });
  } catch (e) {
    intentPath = (e as Error).message;
  }
  const rzCalls = await systemDb
    .select()
    .from(gatewayRequestLogs)
    .where(
      eq(
        gatewayRequestLogs.gatewayAccountId,
        (await getGatewayAccount(orgId, aBiz.id, rzLive.publicId))!.id,
      ),
    );
  ok(
    "WH-ASYNC: beginVaultSetup (the path the portal and checkout take) enforces it too",
    /no webhook endpoint configured/.test(intentPath),
  );
  ok(
    "WH-ASYNC: …and refuses on the INTENT path, before a single gateway request",
    rzCalls.length === 0,
  );

  // Stripe: NOT async wholesale. Refusing a card add-card here would be a regression
  // for the common case, so the rule is method-aware — the bank-debit rails only.
  const stLive = await createGatewayAccount({
    organizationId: orgId,
    businessId: aBiz.id,
    gatewayKey: "stripe",
    label: "ST live",
    credentials: { secret_key: "sk_live_x" },
  });
  const stRow = await getGatewayAccount(orgId, aBiz.id, stLive.publicId);
  ok(
    "WH-ASYNC: a live stripe account with no endpoint may still add a CARD",
    (await refusal(stRow, ["card"])) === "",
  );
  ok(
    "WH-ASYNC: …but not a bank-debit rail, which settles by webhook like RazorPay",
    /no webhook endpoint configured/.test(await refusal(stRow, ["bank_transfer"])),
  );
  ok(
    "WH-ASYNC: …nor sepa_debit",
    /no webhook endpoint configured/.test(await refusal(stRow, ["sepa_debit"])),
  );

  // F-28: `method_types` is free-form jsonb, so nothing used to stop `upi` on Stripe —
  // a value Stripe's capabilities exclude and the router could never match.
  const upiOnStripe = await refusal(stRow, ["upi"]);
  ok(
    "WH-ASYNC: a method the adapter does not declare is refused with an actionable 400",
    /stripe supports/.test(upiOnStripe) && upiOnStripe.includes("upi"),
  );
  ok(
    "WH-ASYNC: a wallet is a card presentation, not an unsupported method",
    (await refusal(stRow, ["wallet"])) === "",
  );

  // ⚠️ LIVE MODE ONLY. Every verify suite and the whole local loop registers mandates
  // against a placeholder WEBHOOK_BASE_URL and settles by calling the inbound path
  // directly; enforcing this in test would break the suites that prove the rail works.
  const tBiz = await createBusiness({
    organizationId: orgId,
    name: "Async WH Test",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const tCus = await createCustomer({
    organizationId: orgId,
    businessId: tBiz.id,
    email: `async-wh-t-${randomUUID()}@gw.test`,
    phone: "9876543210",
  });
  const rzTest = await createGatewayAccount({
    organizationId: orgId,
    businessId: tBiz.id,
    gatewayKey: "razorpay",
    label: "RZP test",
    credentials: { key_id: "rzp_test_x", key_secret: "s" },
  });
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: tBiz.id,
    gwaPublicId: rzTest.publicId,
    credentials: { key_id: "rzp_test_x", key_secret: "rotated", webhook_secret: null },
  });
  let testExempt = "";
  try {
    await assertVaultPreconditions({
      account: (await getGatewayAccount(orgId, tBiz.id, rzTest.publicId))!,
      customer: tCus,
      methodTypes: ["upi"],
    });
  } catch (e) {
    testExempt = (e as Error).message;
  }
  ok(
    "WH-ASYNC: a TEST account with no endpoint is exempt (the suites depend on it)",
    testExempt === "",
  );

  // Leave the book clean: an endpoint-less LIVE async account is a standing
  // `async_gateway_has_webhook` violation, and this suite's leftovers are not one.
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: aBiz.id,
    gwaPublicId: rzLive.publicId,
    credentials: {
      key_id: "rzp_live_x",
      key_secret: "rotated",
      webhook_secret: "restored-for-teardown",
    },
  });
}

// A gateway that wants a person's name refuses the email fallback (Cashfree mandate
// setup: "customer_name : should be a person name", measured 2026-10-27).
{
  const orgId = org.organization.id;
  const nBiz = await createBusiness({
    organizationId: orgId,
    name: "Name Required",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const cf = await createGatewayAccount({
    organizationId: orgId,
    businessId: nBiz.id,
    gatewayKey: "cashfree",
    label: "cashfree",
    credentials: { app_id: "cf_app_x", secret_key: "cf_secret_x" },
  });
  const refusalFor = async (extra: Record<string, string>) => {
    const cus = await createCustomer({
      organizationId: orgId,
      businessId: nBiz.id,
      email: `name-${randomUUID()}@gw.test`,
      phone: "9876543210",
      ...extra,
    });
    try {
      await assertVaultPreconditions({ account: cf, customer: cus });
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const nameless = await refusalFor({});
  ok(
    "NAME: Cashfree recurring setup without a name is refused before the gateway call",
    /requires the customer's name/.test(nameless),
    nameless,
  );
  const named = await refusalFor({ firstName: "Asha", lastName: "Rao" });
  ok("NAME: …and passes once the customer has a name", !/customer's name/.test(named), named);
}

// ── C4: TM Test Gateway — instruments, charges, refunds, intents, async ───────
{
  const orgId = org.organization.id;
  const tmBiz = await createBusiness({
    organizationId: orgId,
    name: "TM Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: tmBiz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  const row = (await getGatewayAccount(orgId, tmBiz.id, acct.publicId))!;
  const tm = resolveAdapter(row);
  ok("C4: resolveAdapter builds a tmtest adapter", tm.key === "tmtest");
  ok(
    "C4: tmtest advertises verify + intents caps",
    tm.capabilities.verify === true && tm.capabilities.intents === true,
  );

  const cust: ProviderCustomerRef = await tm.ensureCustomer({ customerRef: "cus_tm" });
  let kn = 0;
  const key = () => `tmk-${kn++}`;
  const vaultAndCharge = async (token: string, amountMinor = 5000n) => {
    const pm = await tm.vaultPaymentMethod({ customer: cust, token });
    const res = await tm.charge({
      amountMinor,
      currency: "USD",
      customer: cust,
      paymentMethod: pm,
      idempotencyKey: key(),
    });
    return { pm, res };
  };

  // Classification (incl. the classic test-card aliases).
  ok("C4: 4242 → success", classifyToken("4242424242424242").behavior === "success");
  ok("C4: 4111 alias → success", classifyToken("4111111111111111").behavior === "success");
  ok(
    "C4: 4005…0004 alias → insufficient_funds",
    classifyToken("4005519200000004").behavior === "insufficient_funds",
  );
  ok(
    "C4: 4556…3886 alias → requires_action(3DS)",
    classifyToken("4556761029983886").behavior === "requires_action",
  );

  // Vault display + expiry status.
  const okPm = await tm.vaultPaymentMethod({
    customer: cust,
    token: "tok_tmtest_4242424242424242",
  });
  ok("C4: vault returns last4", okPm.display.last4 === "4242");
  const expiredPm = await tm.vaultPaymentMethod({
    customer: cust,
    token: "tok_tmtest_4242424242424242_expired",
  });
  const expiredVerify = await tm.verifyPaymentMethod!({ customer: cust, paymentMethod: expiredPm });
  ok(
    "C4: expired card verify → expired",
    expiredVerify.status === "expired" && expiredVerify.verified === false,
  );

  // Charge outcomes.
  const success = await vaultAndCharge("4242424242424242");
  ok(
    "C4: success card charges",
    success.res.status === "succeeded" && success.res.providerChargeId.startsWith("tmch_"),
  );

  const hard = await vaultAndCharge("4000000000000002");
  ok(
    "C4: hard decline → failed non-retriable",
    hard.res.status === "failed" &&
      hard.res.failure?.code === "card_declined" &&
      hard.res.failure?.retriable === false,
  );

  const insf = await vaultAndCharge("4000000000009995");
  ok(
    "C4: insufficient_funds → failed retriable",
    insf.res.status === "failed" &&
      insf.res.failure?.code === "insufficient_funds" &&
      insf.res.failure?.retriable === true,
  );

  const vof = await vaultAndCharge("4000000000000341");
  ok(
    "C4: vault-ok-charge-fails → vault ok, charge failed",
    vof.pm.providerPaymentMethodId.startsWith("tmpm_") && vof.res.status === "failed",
  );

  const tds = await vaultAndCharge("4000000000003155");
  ok(
    "C4: 3DS card → requires_action + nextAction",
    tds.res.status === "requires_action" && tds.res.nextAction?.type === "three_d_secure",
  );

  const na = await vaultAndCharge("4242424242424242", 5013n); // amount ends in 13
  ok(
    "C4: amount …13 → needs_attention outcome",
    na.res.status === "failed" &&
      (na.res.raw as { tmtest_outcome?: string })?.tmtest_outcome === "needs_attention",
  );
  // …and note what the line above actually proves: the amount OVERRODE a deliberately
  // vaulted SUCCESS instrument. Fine while the caller picks the amounts — every suite
  // here does — and wrong the moment they come from imported real data, where ~1 invoice
  // in 100 totals `…13`. The failure is `retriable: true`, so it does not merely misreport:
  // it arms a dunning ladder the source never started and can cancel the subscription.
  ok(
    "C4: …13 overrides the instrument (why magic_amounts must be switchable)",
    classifyToken("4242424242424242").behavior === "success" && na.res.status === "failed",
  );
  {
    // `magic_amounts: false` → the vaulted instrument is the ONLY thing that decides.
    const plainAcct = await createGatewayAccount({
      organizationId: orgId,
      businessId: tmBiz.id,
      gatewayKey: "tmtest",
      label: "TM Test (no magic amounts)",
      credentials: { magic_amounts: "false" },
    });
    const plain = resolveAdapter((await getGatewayAccount(orgId, tmBiz.id, plainAcct.publicId))!);
    const plainCust: ProviderCustomerRef = await plain.ensureCustomer({
      customerRef: "cus_tm_plain",
    });
    const chargeVia = async (token: string, amountMinor: bigint) => {
      const pm = await plain.vaultPaymentMethod({ customer: plainCust, token });
      return plain.charge({
        amountMinor,
        currency: "USD",
        customer: plainCust,
        paymentMethod: pm,
        idempotencyKey: key(),
      });
    };
    const okAt13 = await chargeVia("4242424242424242", 5013n);
    ok("C4: magic_amounts=false → success card at …13 SUCCEEDS", okAt13.status === "succeeded");
    // The instrument must still be obeyed — switching the amount rule off must not
    // switch every charge to success, or the shadow could never reproduce a decline.
    const failAt13 = await chargeVia("4000000000009995", 5013n);
    ok(
      "C4: magic_amounts=false → instrument still decides (…13 + insufficient_funds fails, retriable)",
      failAt13.status === "failed" &&
        failAt13.failure?.code === "insufficient_funds" &&
        failAt13.failure?.retriable === true,
    );
    const hardAt13 = await chargeVia("4000000000000002", 1013n);
    ok(
      "C4: magic_amounts=false → retriability preserved at …13 (hard decline stays non-retriable)",
      hardAt13.status === "failed" && hardAt13.failure?.retriable === false,
    );
    const refundAt13 = await plain.refund({
      providerChargeId: okAt13.providerChargeId,
      amountMinor: 113n,
      idempotencyKey: key(),
    });
    ok("C4: magic_amounts=false → refund at …13 succeeds", refundAt13.status === "succeeded");
    // And the default is untouched: the original account still applies the rule.
    ok("C4: magic amounts remain ON by default", na.res.status === "failed");
  }

  // Refunds.
  const refundOk = await tm.refund({
    providerChargeId: success.res.providerChargeId,
    idempotencyKey: key(),
  });
  ok(
    "C4: refund succeeds",
    refundOk.status === "succeeded" && refundOk.providerRefundId.startsWith("tmrf_"),
  );
  const refundFail = await tm.refund({
    providerChargeId: success.res.providerChargeId,
    amountMinor: 113n,
    idempotencyKey: key(),
  });
  ok("C4: refund amount …13 → failed", refundFail.status === "failed");

  // Intents (contract v2: `purpose` in, `BuyerAuthorization` out, declines RETURNED).
  const okVault = await tm.vaultPaymentMethod({ customer: cust, token: "4242424242424242" });
  const intent = await tm.createIntent!({
    purpose: "payment",
    amountMinor: 3000n,
    currency: "USD",
    customer: cust,
    paymentMethod: okVault,
    idempotencyKey: key(),
  });
  ok(
    "C4: createIntent authorized (non-3DS)",
    intent.status === "authorized" && intent.intentId.startsWith("tmpi_"),
  );
  const consumed = await tm.consumeIntent!({
    intentId: intent.intentId,
    idempotencyKey: key(),
    purpose: "payment",
  });
  ok(
    "C4: consumeIntent → succeeded",
    consumed.purpose === "payment" && consumed.charge.status === "succeeded",
  );
  const tdsVault = await tm.vaultPaymentMethod({ customer: cust, token: "4000000000003155" });
  const tdsIntent = await tm.createIntent!({
    purpose: "payment",
    amountMinor: 3000n,
    currency: "USD",
    customer: cust,
    paymentMethod: tdsVault,
    idempotencyKey: key(),
  });
  ok(
    "C4: createIntent 3DS → requires_action",
    tdsIntent.status === "requires_action" && !!tdsIntent.authorization,
  );
  // The challenge descriptor is the SHARED one (`BuyerAuthorization`), so one
  // client-side renderer serves vault setup and 3DS alike.
  ok(
    "C4: 3DS challenge is a redirect authorization",
    tdsIntent.authorization?.mode === "redirect" && !!tdsIntent.authorization.approvalUrl,
  );
  ok(
    "C4: tmtest advertises both intent purposes + a true void",
    JSON.stringify(tm.capabilities.intentPurposes) === JSON.stringify(["payment", "setup"]) &&
      tm.capabilities.intentVoid === true,
  );

  // ── setup-purpose intent at the ADAPTER: the product is an instrument ────────
  const setupRef = await tm.createIntent!({
    purpose: "setup",
    currency: "USD",
    customer: cust,
    idempotencyKey: key(),
  });
  ok(
    "C4: setup intent → tmseti_ + client_secret challenge",
    setupRef.status === "requires_action" &&
      setupRef.intentId.startsWith("tmseti_") &&
      setupRef.authorization?.mode === "client_secret" &&
      !!setupRef.authorization.clientSecret,
  );
  await TmtestProvider.resolveChallenge(setupRef.intentId, true, "4242424242424242");
  const setupTaken = await tm.consumeIntent!({
    intentId: setupRef.intentId,
    idempotencyKey: key(),
    purpose: "setup",
  });
  ok(
    "C4: consuming a setup intent yields an instrument, not a charge",
    setupTaken.purpose === "setup" &&
      setupTaken.paymentMethod?.providerPaymentMethodId.startsWith("tmpm_") === true &&
      setupTaken.paymentMethod?.display.last4 === "4242",
  );

  // ── the THIRD BuyerAuthorization mode: RazorPay-style embedded checkout ─────
  // `redirect` and `client_secret` were simulable; `checkout` was not, because its
  // descriptor is built from CREATE-time params (provider customer + rail) and
  // `createIntent` is idempotency-keyed — a replay must return the SAME descriptor.
  // `tmtest_charges.checkout_params` (0175) is where they now live.
  const checkoutKey = key();
  const checkoutRef = await tm.createIntent!({
    purpose: "setup",
    currency: "INR",
    customer: cust,
    methodTypes: ["upi"],
    idempotencyKey: checkoutKey,
  });
  ok(
    "C4: a checkout rail answers in checkout mode",
    checkoutRef.status === "requires_action" && checkoutRef.authorization?.mode === "checkout",
  );
  ok(
    "C4: the checkout descriptor carries the params the client SDK needs",
    checkoutRef.authorization?.checkout?.keyId?.startsWith("tmkey_") === true &&
      checkoutRef.authorization?.checkout?.orderId === checkoutRef.intentId &&
      checkoutRef.authorization?.checkout?.customerId === cust.providerCustomerId &&
      checkoutRef.authorization?.checkout?.recurring === true &&
      checkoutRef.authorization?.checkout?.method === "upi",
  );
  const checkoutReplay = await tm.createIntent!({
    purpose: "setup",
    currency: "INR",
    customer: cust,
    methodTypes: ["upi"],
    idempotencyKey: checkoutKey,
  });
  // Field-wise, not JSON.stringify: the descriptor round-trips through jsonb, which
  // does not preserve key order.
  const cbA = checkoutRef.authorization?.checkout;
  const cbB = checkoutReplay.authorization?.checkout;
  ok(
    "C4: a replayed create key returns the SAME checkout descriptor",
    checkoutReplay.intentId === checkoutRef.intentId &&
      checkoutReplay.authorization?.mode === "checkout" &&
      !!cbA &&
      !!cbB &&
      cbB.keyId === cbA.keyId &&
      cbB.orderId === cbA.orderId &&
      cbB.customerId === cbA.customerId &&
      cbB.recurring === cbA.recurring &&
      cbB.method === cbA.method,
  );
  const cardStillRedirects = await tm.createIntent!({
    purpose: "setup",
    currency: "USD",
    customer: cust,
    methodTypes: ["card"],
    idempotencyKey: key(),
  });
  ok(
    "C4: a card rail is unaffected (still client_secret)",
    cardStillRedirects.authorization?.mode === "client_secret",
  );

  // ── the retry card (4000000000002008): one intent, two consumes ──────────────
  // createIntent is UNAFFECTED — the failure belongs to the attempt, not to the
  // intent's birth — and the declined consume must LEAVE THE GATEWAY INTENT
  // AUTHORIZED, or the engine could never reach attempt_count = 2.
  const retryVault = await tm.vaultPaymentMethod({ customer: cust, token: "4000000000002008" });
  const retryIntent = await tm.createIntent!({
    purpose: "payment",
    amountMinor: 4400n,
    currency: "USD",
    customer: cust,
    paymentMethod: retryVault,
    idempotencyKey: key(),
  });
  ok(
    "C4: retry card leaves createIntent alone (born authorized)",
    retryIntent.status === "authorized" && !retryIntent.failure,
  );
  const retryKey1 = key();
  const retryFail = await tm.consumeIntent!({
    intentId: retryIntent.intentId,
    idempotencyKey: retryKey1,
    purpose: "payment",
  });
  ok(
    "C4: retry card first consume → retriable card_declined",
    retryFail.purpose === "payment" &&
      retryFail.charge.status === "failed" &&
      retryFail.charge.failure?.code === "card_declined" &&
      retryFail.charge.failure?.retriable === true,
  );
  const retryRow = (
    await systemDb
      .select()
      .from(tmtestCharges)
      .where(eq(tmtestCharges.chargeId, retryIntent.intentId))
      .limit(1)
  )[0];
  ok(
    "C4: a declined consume leaves the gateway intent authorized",
    retryRow?.status === "authorized",
  );
  const retryReplay = await tm.consumeIntent!({
    intentId: retryIntent.intentId,
    idempotencyKey: retryKey1,
    purpose: "payment",
  });
  ok(
    "C4: replaying the SAME consume key replays the failure",
    retryReplay.purpose === "payment" &&
      retryReplay.charge.status === "failed" &&
      (retryReplay.charge.raw as { tmtest_outcome?: string })?.tmtest_outcome ===
        "retry_pending_replay",
  );
  const retryWin = await tm.consumeIntent!({
    intentId: retryIntent.intentId,
    idempotencyKey: key(),
    purpose: "payment",
  });
  ok(
    "C4: a DIFFERENT consume key on the same intent captures",
    retryWin.purpose === "payment" && retryWin.charge.status === "succeeded",
  );

  // ── voidIntent + its two refusals ───────────────────────────────────────────
  const voidVault = await tm.vaultPaymentMethod({ customer: cust, token: "4242424242424242" });
  const toVoid = await tm.createIntent!({
    purpose: "payment",
    amountMinor: 1500n,
    currency: "USD",
    customer: cust,
    paymentMethod: voidVault,
    idempotencyKey: key(),
  });
  const voided = await tm.voidIntent!({ intentId: toVoid.intentId, idempotencyKey: key() });
  ok(
    "C4: voidIntent releases an authorized intent",
    voided.voided === true && voided.providerTransactionId?.startsWith("tmvd_") === true,
  );
  const voidedAgain = await tm.voidIntent!({ intentId: toVoid.intentId, idempotencyKey: key() });
  ok(
    "C4: voidIntent is idempotent (same void id)",
    voidedAgain.voided === true &&
      voidedAgain.providerTransactionId === voided.providerTransactionId,
  );
  const captureVoided = await tm.consumeIntent!({
    intentId: toVoid.intentId,
    idempotencyKey: key(),
    purpose: "payment",
  });
  ok(
    "C4: a voided intent can no longer be captured (intent_voided)",
    captureVoided.purpose === "payment" &&
      captureVoided.charge.status === "failed" &&
      captureVoided.charge.failure?.code === "intent_voided",
  );
  const capturedIntent = await tm.createIntent!({
    purpose: "payment",
    amountMinor: 1600n,
    currency: "USD",
    customer: cust,
    paymentMethod: voidVault,
    idempotencyKey: key(),
  });
  await tm.consumeIntent!({
    intentId: capturedIntent.intentId,
    idempotencyKey: key(),
    purpose: "payment",
  });
  const voidCaptured = await tm.voidIntent!({
    intentId: capturedIntent.intentId,
    idempotencyKey: key(),
  });
  ok("C4: a CAPTURED intent refuses to void (refund it instead)", voidCaptured.voided === false);

  // Signature verification on the inbound normalizer.
  let sigRejected = false;
  try {
    await tm.normalizeWebhook({
      payload: JSON.stringify({
        id: "tmev_x",
        type: "charge.succeeded",
        occurred_at: new Date().toISOString(),
        data: {},
      }),
      headers: { "x-tmtest-signature": "deadbeef" },
    });
  } catch {
    sigRejected = true;
  }
  ok("C4: bad webhook signature rejected", sigRejected);

  // Async: late_failure queues a reversal; advance delivers it through the pipeline.
  const beforeEvents = (
    await systemDb.select().from(providerEvents).where(eq(providerEvents.providerKey, "tmtest"))
  ).length;
  await vaultAndCharge("4000000000005126"); // succeeds now, reversal queued
  await vaultAndCharge("4000000000000077"); // pending, settlement queued
  const adv1 = await advanceTmtest(orgId, new Date());
  ok("C4: advance delivers 2 async webhooks", adv1.delivered === 2);
  const afterEvents = (
    await systemDb.select().from(providerEvents).where(eq(providerEvents.providerKey, "tmtest"))
  ).length;
  ok("C4: async webhooks recorded in provider_events", afterEvents === beforeEvents + 2);
  // Re-advance is a no-op (delivered rows aren't re-sent; dedup holds).
  const adv2 = await advanceTmtest(orgId, new Date());
  ok("C4: re-advance delivers nothing (dedup)", adv2.delivered === 0);
}

// ── C3: adapter contract v2 (superset; a non-tmtest adapter still conforms) ───
// Constructed directly (never invoked, never touches the network) purely to probe
// the adapter contract shape — capabilities/healthCheck are plain instance members.
{
  const generic = new PayPalProvider({
    clientId: "x",
    clientSecret: "x",
    apiBase: "https://api.example.invalid",
  });
  ok("C3: generic adapter exposes healthCheck probe", typeof generic.healthCheck === "function");
  ok(
    "C3: generic capabilities carry method families",
    // PayPal vaults wallets only (2026-10-25): `card` reached nothing.
    Array.isArray(generic.capabilities.methods) &&
      generic.capabilities.methods.includes("paypal") &&
      !generic.capabilities.methods.includes("card"),
  );
  // Intents are an OPTIONAL capability, and the flag must not lie in either direction:
  // the UI hides the control off `capabilities`, so an adapter advertising a method it
  // doesn't implement renders a button that throws. (PayPal gained real intents in the
  // contract-v2 rebuild, which is why this asserts the invariant rather than `false`.)
  ok(
    "C3: generic advertises intents iff it implements them",
    (generic.capabilities.intents === true) === (typeof generic.createIntent === "function"),
  );
  ok(
    "C3: generic advertises intentVoid iff it implements voidIntent",
    (generic.capabilities.intentVoid === true) === (typeof generic.voidIntent === "function"),
  );

  // ── F-40: `mandates` must agree with the implementation too ─────────────────
  // Same rule as `intentVoid` above, for the capability that decides how a NULL
  // `payment_methods.mandate_max_amount_minor` is READ: `true` means the gateway would
  // have told us, so a null ceiling is UNKNOWN and worth chasing; `false` means the
  // gateway has no per-debit ceiling on the flow we use, so a null is complete and
  // nothing will ever fill it. Both readings drive real behaviour (`mandateRefusal`
  // skips what it cannot compare, the portal explains what it cannot show), and neither
  // can tell a lying flag from an honest one.
  //
  // Unlike `intentVoid` there is no adapter METHOD to probe: a mandate is derived inside
  // the vault and webhook paths, and deriving a real one needs a live gateway. So the
  // evidence is the module — an adapter that claims a mandate model has to construct a
  // `ProviderMandate` somewhere (`describeStripeMandate`, `describeRazorpayMandate`), and
  // one that denies it never names the type at all. Flipping a flag without doing the
  // work, or doing the work without declaring it, breaks the iff.
  const capabilitiesOf: Record<string, { mandates?: boolean }> = {
    "stripe.ts": new StripeProvider("sk_test_x").capabilities,
    "razorpay.ts": new RazorpayProvider({
      keyId: "rzp_test_x",
      keySecret: "x",
      apiBase: "https://rzp.invalid",
    }).capabilities,
    "paypal.ts": generic.capabilities,
    // Reports mandate status and scheme, but Bacs/SEPA/ACH have no per-debit ceiling.
    "gocardless.ts": new GoCardlessProvider({ accessToken: "x", livemode: false }).capabilities,
  };
  for (const [file, caps] of Object.entries(capabilitiesOf)) {
    const src = readFileSync(new URL(`../src/providers/${file}`, import.meta.url), "utf8");
    const derives = src.includes("ProviderMandate");
    ok(
      `C3: ${file} advertises mandates iff it derives a ProviderMandate`,
      (caps.mandates === true) === derives,
    );
    // Absent means UNKNOWN by design, and shipping UNKNOWN on a LIVE adapter is the bug
    // the flag exists to prevent — an operator would be shown "we don't know" for a
    // gateway we do know about.
    ok(
      `C3: ${file} declares mandates explicitly (absent means UNKNOWN)`,
      typeof caps.mandates === "boolean",
    );
  }
}

// ── C5: transactions module — record, events, list filters, reconcile ─────────
{
  const orgId = org.organization.id;
  const txBiz = await createBusiness({
    organizationId: orgId,
    name: "Txn Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: txBiz.id,
    email: "txn@gw.test",
  });

  const paid = await recordTransaction({
    organizationId: orgId,
    businessId: txBiz.id,
    customerId: cus.id,
    type: "payment",
    status: "succeeded",
    amountMinor: 5000n,
    currency: "USD",
    gatewayKey: "tmtest",
    idAtGateway: "tmch_ok",
  });
  ok("C5: record transaction → txn_ id", paid.publicId.startsWith("txn_"));
  ok("C5: success transaction settled_at set", paid.settledAt !== null);

  const na = await recordTransaction({
    organizationId: orgId,
    businessId: txBiz.id,
    customerId: cus.id,
    type: "payment",
    status: "needs_attention",
    amountMinor: 4013n,
    currency: "USD",
    gatewayKey: "tmtest",
    idAtGateway: "tmch_na",
    errorCode: "gateway_error",
  });
  ok("C5: needs_attention transaction recorded", na.status === "needs_attention");

  const evTypes = (await listEventsFiltered(orgId, { limit: 100 })).data.map((e) => e.type);
  ok("C5: payment.initiated emitted", evTypes.includes("payment_initiated"));
  ok("C5: transaction.needs_attention emitted", evTypes.includes("transaction_needs_attention"));

  const all = await listTransactions(orgId, txBiz.id);
  ok("C5: list returns both transactions", all.length === 2);
  const filtered = await listTransactions(orgId, txBiz.id, { status: "needs_attention" });
  ok("C5: list filters by status", filtered.length === 1 && filtered[0]!.publicId === na.publicId);

  const reconciled = await reconcileTransaction({
    organizationId: orgId,
    txnPublicId: na.publicId,
    outcome: "succeeded",
  });
  ok(
    "C5: reconcile needs_attention → success",
    reconciled?.status === "succeeded" && reconciled?.settledAt !== null,
  );
  const evTypes2 = (await listEventsFiltered(orgId, { limit: 100 })).data.map((e) => e.type);
  ok("C5: transaction.reconciled emitted", evTypes2.includes("transaction_reconciled"));

  // A settled transaction cannot be reconciled again.
  let reReconcile = false;
  try {
    await reconcileTransaction({
      organizationId: orgId,
      txnPublicId: na.publicId,
      outcome: "failed",
    });
  } catch {
    reReconcile = true;
  }
  ok("C5: reconciling a settled transaction rejected", reReconcile);
}

// ── C6: payment-source lifecycle — roles, sweep, backup fallback ──────────────
{
  const orgId = org.organization.id;
  const psBiz = await createBusiness({
    organizationId: orgId,
    name: "PS Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: psBiz.id,
    email: "ps@gw.test",
  });

  // Roles: assign primary, then a second → primary demotes the first.
  const pm1 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: psBiz.id,
    customer: cus,
    token: "tok_4242",
  });
  const pm2 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: psBiz.id,
    customer: cus,
    token: "tok_4242_b",
  });
  await assignPaymentMethodRole(orgId, cus.id, pm1.publicId, "primary");
  await assignPaymentMethodRole(orgId, cus.id, pm2.publicId, "primary");
  const roles = await listPaymentMethods(orgId, cus.id);
  ok(
    "C6: assigning primary demotes the previous primary",
    roles.filter((p) => p.role === "primary").length === 1 &&
      roles.find((p) => p.id === pm2.id)?.role === "primary",
  );
  const roleEvents = (await listEventsFiltered(orgId, { limit: 100 })).data.filter(
    (e) => e.type === "payment_source_role_changed",
  );
  ok("C6: role change emits payment_source.role_changed", roleEvents.length >= 2);

  // Sweep: backdate expiries and run the pass.
  const nowY = new Date().getUTCFullYear();
  const nowM = new Date().getUTCMonth() + 1;
  const lastMonth = nowM === 1 ? { m: 12, y: nowY - 1 } : { m: nowM - 1, y: nowY };
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ expMonth: lastMonth.m, expYear: lastMonth.y })
      .where(eq(paymentMethods.id, pm1.id)),
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ expMonth: nowM, expYear: nowY })
      .where(eq(paymentMethods.id, pm2.id)),
  );
  const swept = await paymentSourceSweep(new Date());
  ok("C6: sweep flags 1 expired + 1 expiring", swept.expired === 1 && swept.expiring === 1);
  const afterSweep = await listPaymentMethods(orgId, cus.id);
  ok(
    "C6: expired card status=expired",
    afterSweep.find((p) => p.id === pm1.id)?.status === "expired",
  );
  ok(
    "C6: expiring card status=expiring",
    afterSweep.find((p) => p.id === pm2.id)?.status === "expiring",
  );
  const sweepEvents = (await listEventsFiltered(orgId, { limit: 100 })).data.map((e) => e.type);
  ok("C6: payment_source.expired emitted", sweepEvents.includes("payment_source_expired"));
  ok("C6: payment_source.expiring emitted", sweepEvents.includes("payment_source_expiring"));
  // Re-run is idempotent (no new transitions).
  const swept2 = await paymentSourceSweep(new Date());
  ok("C6: sweep is idempotent", swept2.expired === 0 && swept2.expiring === 0);

  // Backup fallback: primary HARD-declines → backup card is charged; primary → invalid.
  // A hard decline is signalled by a NON-retriable failure (tmtest 4000000000000002 =
  // hard_decline, retriable:false). A retriable decline (4000000000009995) goes to dunning, not backup.
  const cus2 = await createCustomer({
    organizationId: orgId,
    businessId: psBiz.id,
    email: "ps2@gw.test",
  });
  const badPrimary = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: psBiz.id,
    customer: cus2,
    token: "4000000000000002",
  }); // expired_card, non-retriable
  const goodBackup = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: psBiz.id,
    customer: cus2,
    token: "tok_4242",
  });
  await assignPaymentMethodRole(orgId, cus2.id, badPrimary.publicId, "primary");
  await assignPaymentMethodRole(orgId, cus2.id, goodBackup.publicId, "backup");
  const prod = await createProduct({
    organizationId: orgId,
    businessId: psBiz.id,
    name: "PS Plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: psBiz.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: psBiz.id,
    customerId: cus2.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: badPrimary.id,
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: psBiz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  ok("C6: backup card pays after primary hard-declines", invoice.status === "paid");
  const pms2 = await listPaymentMethods(orgId, cus2.id);
  ok(
    "C6: hard-declined primary marked invalid",
    pms2.find((p) => p.id === badPrimary.id)?.status === "invalid",
  );

  // A SOFT decline on the primary also reaches the backup, but leaves the primary valid.
  const billWith = async (email: string, primaryToken: string, backupToken: string) => {
    const c = await createCustomer({ organizationId: orgId, businessId: psBiz.id, email });
    const p1 = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: psBiz.id,
      customer: c,
      token: primaryToken,
    });
    const p2 = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: psBiz.id,
      customer: c,
      token: backupToken,
    });
    await assignPaymentMethodRole(orgId, c.id, p1.publicId, "primary");
    await assignPaymentMethodRole(orgId, c.id, p2.publicId, "backup");
    const s = await createSubscription({
      organizationId: orgId,
      businessId: psBiz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      defaultPaymentMethodId: p1.id,
    });
    const billed = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: psBiz.id,
      subscription: s.subscription,
      periodStart: s.subscription.currentPeriodStart!,
      periodEnd: s.subscription.currentPeriodEnd!,
    });
    const pms = await listPaymentMethods(orgId, c.id);
    return { ...billed, primaryStatus: pms.find((p) => p.id === p1.id)?.status };
  };

  const soft = await billWith("ps3@gw.test", "4000000000009995", "tok_4242");
  ok("C6: backup card pays after primary SOFT-declines", soft.invoice.status === "paid");
  ok("C6: soft-declined primary stays valid", soft.primaryStatus === "valid");

  // Primary soft, backup hard: dunning must follow the primary's retriable failure, not park.
  const mixed = await billWith("ps4@gw.test", "4000000000009995", "4000000000000002");
  ok(
    "C6: soft primary + hard backup leaves the invoice due",
    mixed.invoice.status === "payment_due",
  );
  ok(
    "C6: …and dunning is driven by the primary's soft decline",
    mixed.payment?.failureCode === "insufficient_funds",
  );
  // The history must read in charge order even though the primary's decline governs.
  const mixedRows = await withTenant(orgId, (tx) =>
    tx
      .select({ code: payments.failureCode, at: payments.createdAt })
      .from(payments)
      .where(eq(payments.invoiceId, mixed.invoice.id))
      .orderBy(asc(payments.createdAt)),
  );
  ok(
    "C6: …and the attempts are booked in the order the cards were charged",
    mixedRows.length === 2 && mixedRows[0]!.code === "insufficient_funds",
    `codes=${mixedRows.map((r) => r.code).join(",")}`,
  );
  ok("C6: …with a retry scheduled", mixed.invoice.nextAttemptAt != null);

  // Every non-primary card is a backup by default, and the run walks all of them.
  const cus5 = await createCustomer({
    organizationId: orgId,
    businessId: psBiz.id,
    email: "ps5@gw.test",
  });
  const cards = [];
  for (const token of ["4000000000009995", "4000000000000002", "tok_4242"])
    cards.push(
      await vaultPaymentMethod({
        organizationId: orgId,
        businessId: psBiz.id,
        customer: cus5,
        token,
      }),
    );
  const roles5 = await listPaymentMethods(orgId, cus5.id);
  const roleOf5 = (id: string) => roles5.find((p) => p.id === id)?.role;
  ok(
    "C6: first card is primary, every later card a backup",
    roleOf5(cards[0]!.id) === "primary" &&
      roleOf5(cards[1]!.id) === "backup" &&
      roleOf5(cards[2]!.id) === "backup",
  );
  const sub5 = await createSubscription({
    organizationId: orgId,
    businessId: psBiz.id,
    customerId: cus5.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: cards[0]!.id,
  });
  const billed5 = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: psBiz.id,
    subscription: sub5.subscription,
    periodStart: sub5.subscription.currentPeriodStart!,
    periodEnd: sub5.subscription.currentPeriodEnd!,
  });
  ok(
    "C6: with three cards, a soft-declined primary is paid by a backup",
    billed5.invoice.status === "paid",
  );

  // A removed backup is never charged.
  const cus7 = await createCustomer({
    organizationId: orgId,
    businessId: psBiz.id,
    email: "ps7@gw.test",
  });
  const p7 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: psBiz.id,
    customer: cus7,
    token: "4000000000009995",
  });
  const b7 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: psBiz.id,
    customer: cus7,
    token: "tok_4242",
  });
  await assignPaymentMethodRole(orgId, cus7.id, b7.publicId, "none");
  const sub7 = await createSubscription({
    organizationId: orgId,
    businessId: psBiz.id,
    customerId: cus7.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: p7.id,
  });
  const billed7 = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: psBiz.id,
    subscription: sub7.subscription,
    periodStart: sub7.subscription.currentPeriodStart!,
    periodEnd: sub7.subscription.currentPeriodEnd!,
  });
  ok("C6: a REMOVED backup is not charged", billed7.invoice.status === "payment_due");

  // The primary cannot be demoted — only replaced.
  let demoteRefused = false;
  try {
    await assignPaymentMethodRole(orgId, cus7.id, p7.publicId, "backup");
  } catch (e) {
    demoteRefused = (e as Error).name === "PrimaryDemotionError";
  }
  ok("C6: demoting the primary is refused", demoteRefused);

  // A card added after the primary was written off takes over — and the old one steps down.
  const cus8 = await createCustomer({
    organizationId: orgId,
    businessId: psBiz.id,
    email: "ps8@gw.test",
  });
  const dead8 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: psBiz.id,
    customer: cus8,
    token: "4000000000000002",
  });
  const sub8 = await createSubscription({
    organizationId: orgId,
    businessId: psBiz.id,
    customerId: cus8.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: psBiz.id,
    subscription: sub8.subscription,
    periodStart: sub8.subscription.currentPeriodStart!,
    periodEnd: sub8.subscription.currentPeriodEnd!,
  });
  const fresh8 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: psBiz.id,
    customer: cus8,
    token: "tok_4242",
  });
  const roles8 = await listPaymentMethods(orgId, cus8.id);
  ok(
    "C6: a card added after the primary went invalid is the ONLY primary",
    roles8.filter((p) => p.role === "primary").length === 1 &&
      roles8.find((p) => p.id === fresh8.id)?.role === "primary" &&
      roles8.find((p) => p.id === dead8.id)?.role === "backup" &&
      roles8.find((p) => p.id === dead8.id)?.status === "invalid",
  );
}

// ── C7: payment intents — 3DS challenge, authorize, consume, expiry ───────────
{
  const orgId = org.organization.id;
  const piBiz = await createBusiness({
    organizationId: orgId,
    name: "PI Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: piBiz.id,
    email: "pi@gw.test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: piBiz.id,
    gatewayKey: "tmtest",
    label: "TM",
    credentials: {},
  });
  const acctRow = (await getGatewayAccount(orgId, piBiz.id, acct.publicId))!;
  const tm = resolveAdapter(acctRow);

  // Vault a card through the tmtest gateway and persist a payment_methods row.
  const vaultPm = async (token: string) => {
    const ref = await tm.vaultPaymentMethod({
      customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cus.publicId}` },
      token,
    });
    return withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          organizationId: orgId,
          businessId: piBiz.id,
          customerId: cus.id,
          publicId: publicId("pm"),
          providerKey: "tmtest",
          providerCustomerId: `tmcus_${cus.publicId}`,
          providerPaymentMethodId: ref.providerPaymentMethodId,
          type: "card",
          last4: ref.display.last4,
          gatewayAccountId: acctRow.id,
        })
        .returning();
      return row!;
    });
  };

  // Intents consume INTO invoices (review fix: money must land in the engine).
  const mkInvoice = async (amountMinor: bigint) =>
    (
      await createInvoiceFromLines({
        organizationId: orgId,
        businessId: piBiz.id,
        customerId: cus.id,
        currency: "USD",
        lines: [{ description: "Intent target", amountMinor }],
        collect: false,
      })
    ).invoice;

  // 3DS card → intent needs a challenge.
  const tdsPm = await vaultPm("4000000000003155");
  const inv5000 = await mkInvoice(5000n);
  const created = await createPaymentIntent({
    organizationId: orgId,
    businessId: piBiz.id,
    paymentMethodPublicId: tdsPm.publicId,
    amountMinor: 5000,
    currency: "USD",
  });
  const intent = created.intent;
  ok(
    "C7: 3DS intent created in_progress with next_action",
    intent.status === "in_progress" &&
      intent.nextAction != null &&
      intent.publicId.startsWith("pi_"),
  );
  // Create now returns the intent AND its first attempt — the container/attempt split
  // the "Payment Attempts" column reads from.
  ok(
    "C7: create mints attempt #1",
    created.attempt.attemptNumber === 1 &&
      created.attempt.status === "requires_action" &&
      intent.attemptCount === 1,
  );

  // The LIST read (we had create/get-by-id only, which is why the dashboard could
  // only ever be a create-and-inspect form). Asserted here because this is the
  // one suite where intents actually exist — the seeded business's gateway
  // rejects them outright.
  {
    const page = await listPaymentIntentsPage(orgId, piBiz.id, { limit: 50 });
    const row = page.data.find((r) => r.intent.publicId === intent.publicId);
    ok("C7: intent appears in the list read", !!row);
    ok("C7: list total counts it", (page.total ?? 0) >= 1);
    // The joins are the reason this is a dedicated read rather than a bare select.
    ok("C7: list joins the customer", !!row?.customerPublicId);
    ok("C7: list joins the card", row?.cardLast4 === "3155");
    const ser = row ? serializePaymentIntentRow(row) : null;
    ok(
      "C7: list serializer exposes customer + card",
      ser?.customer === row?.customerPublicId && ser?.payment_method_last4 === "3155",
    );
    // `?status=` must narrow in SQL, not in the client.
    const narrowed = await listPaymentIntentsPage(orgId, piBiz.id, {
      status: "in_progress",
      limit: 50,
    });
    ok(
      "C7: list status filter narrows",
      narrowed.data.every((r) => r.intent.status === "in_progress") && narrowed.data.length > 0,
    );
    const none = await listPaymentIntentsPage(orgId, piBiz.id, { status: "consumed", limit: 50 });
    ok(
      "C7: list status filter excludes",
      !none.data.some((r) => r.intent.publicId === intent.publicId),
    );
  }

  // Consuming before authorization is rejected.
  let earlyConsume = false;
  try {
    await consumePaymentIntent(orgId, piBiz.id, intent.publicId, inv5000.publicId);
  } catch (e) {
    earlyConsume = e instanceof PaymentIntentError;
  }
  ok("C7: consume before authorize rejected", earlyConsume);

  const authorized = await authorizePaymentIntent(orgId, piBiz.id, intent.publicId);
  ok(
    "C7: authorize → authorized, next_action cleared",
    authorized?.status === "authorized" && authorized?.nextAction == null,
  );
  /**
   * `authorized_at` — the moment the gateway actually HELD the money.
   *
   * Measured 2026-08-31 (`scripts/probe-late-authorization.ts`): NOTHING wrote this column.
   * It was NULL platform-wide, including on an intent that provably held funds, which made
   * the `intent_hold_not_abandoned` invariant permanently green by construction — its
   * predicate requires `authorized_at IS NOT NULL`. Migration 0217 documents the contract
   * this now asserts.
   */
  ok(
    "C7: authorize stamps authorized_at",
    authorized?.authorizedAt != null &&
      Math.abs(authorized.authorizedAt.getTime() - Date.now()) < 5 * 60_000,
  );
  // `coalesce(authorized_at, now())`, so the FIRST hold wins: a redelivered
  // `intent.authorized` (gateways retry) re-runs the whole handler and must not move it.
  const reAuthorized = await authorizePaymentIntent(orgId, piBiz.id, intent.publicId);
  ok(
    "C7: a redelivered authorize does not move authorized_at",
    reAuthorized?.authorizedAt?.getTime() === authorized?.authorizedAt?.getTime(),
  );

  // Amount mismatch: this intent (5000) cannot consume into a 999 invoice.
  const invWrong = await mkInvoice(999n);
  let mismatch = false;
  try {
    await consumePaymentIntent(orgId, piBiz.id, intent.publicId, invWrong.publicId);
  } catch (e) {
    mismatch = e instanceof PaymentIntentError;
  }
  ok("C7: amount-mismatch consume rejected", mismatch);

  const cashBefore = await ledgerBalance(orgId, piBiz.id, "cash");
  const arBefore = await ledgerBalance(orgId, piBiz.id, "accounts_receivable");
  const consumed = await consumePaymentIntent(orgId, piBiz.id, intent.publicId, inv5000.publicId);
  ok(
    "C7: consume authorized intent → succeeded + consumed",
    consumed?.charge?.status === "succeeded" && consumed?.intent.status === "consumed",
  );
  ok("C7: consume closes the attempt as consumed", consumed?.attempt?.status === "consumed");
  const invAfter = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, inv5000.id)).limit(1),
    )
  )[0]!;
  ok("C7: consume settles the invoice → paid", invAfter.status === "paid");
  ok(
    "C7: consume books cash (+5000)",
    (await ledgerBalance(orgId, piBiz.id, "cash")) === cashBefore + 5000n,
  );
  ok(
    "C7: consume relieves AR (−5000)",
    (await ledgerBalance(orgId, piBiz.id, "accounts_receivable")) === arBefore - 5000n,
  );
  const payRows = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, inv5000.id)),
  );
  ok(
    "C7: consume creates a succeeded payment row",
    payRows.some((p) => p.status === "succeeded"),
  );
  const txRows = await listTransactions(orgId, piBiz.id, { invoiceId: inv5000.id });
  ok(
    "C7: consume records a success transaction",
    txRows.some((t) => t.status === "succeeded" && t.type === "payment"),
  );

  // Replay: a consumed intent cannot be consumed again (409-class rejection).
  let doubleConsume = false;
  try {
    await consumePaymentIntent(orgId, piBiz.id, intent.publicId, inv5000.publicId);
  } catch (e) {
    doubleConsume = e instanceof PaymentIntentError || e instanceof PaymentIntentConflictError;
  }
  ok("C7: double consume rejected", doubleConsume);

  const evTypes = (await listEventsFiltered(orgId, { limit: 100 })).data.map((e) => e.type);
  ok("C7: payment_intent.created emitted", evTypes.includes("payment_intent_created"));
  ok("C7: payment_intent.authorized emitted", evTypes.includes("payment_intent_authorized"));
  ok("C7: payment.succeeded emitted via intent", evTypes.includes("payment_succeeded"));

  // Non-3DS card → intent authorized immediately, consumable directly.
  const okPm = await vaultPm("4242424242424242");
  const inv2000 = await mkInvoice(2000n);
  const directIntent = (
    await createPaymentIntent({
      organizationId: orgId,
      businessId: piBiz.id,
      paymentMethodPublicId: okPm.publicId,
      amountMinor: 2000,
      currency: "USD",
    })
  ).intent;
  ok("C7: non-3DS intent authorized immediately", directIntent.status === "authorized");
  const directConsume = await consumePaymentIntent(
    orgId,
    piBiz.id,
    directIntent.publicId,
    inv2000.publicId,
  );
  ok("C7: non-3DS intent consumes directly", directConsume?.charge?.status === "succeeded");

  // Expiry sweep: an un-authorized 3DS intent past its TTL → expired.
  const stale = (
    await createPaymentIntent({
      organizationId: orgId,
      businessId: piBiz.id,
      paymentMethodPublicId: tdsPm.publicId,
      amountMinor: 999,
      currency: "USD",
    })
  ).intent;
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(paymentIntents.publicId, stale.publicId)),
  );
  const swept = await expirePaymentIntents(new Date());
  ok("C7: expiry sweep expires stale intents", swept.expired >= 1);
  const staleAfter = await getPaymentIntent(orgId, piBiz.id, stale.publicId);
  ok("C7: stale intent status=expired", staleAfter?.status === "expired");
  const evTypes2 = (await listEventsFiltered(orgId, { limit: 100 })).data.map((e) => e.type);
  ok("C7: payment_intent.expired emitted", evTypes2.includes("payment_intent_expired"));
  // An attempt left open under an EXPIRED intent would make it look retriable.
  const staleAttempts = await listAttemptsForIntent(orgId, piBiz.id, stale.publicId);
  ok(
    "C7: expiry closes the open attempt",
    staleAttempts.every((a) => a.status === "failed" && a.errorCode === "intent_expired"),
  );

  // ── C7-TTL: the deadline comes from the RAIL, not from a flat hour ───────────
  /**
   * `INTENT_TTL_MS` was one hour at both creation sites. Past that deadline the intent is
   * `expired`, which is TERMINAL to the inbound webhook path, so a bank approval arriving
   * at minute 61 is dropped — money held at the gateway with the invoice unpaid (INV-5510
   * carries two RazorPay orders, the second `authorized` with `pay_XXXXXXXXXXXX03` and no
   * engine rows), or a live mandate with no `payment_methods` row.
   *
   * Asserts the BOUNDARY BEHAVIOUR against the shared table rather than hard-coded hours,
   * so retuning a rail does not break the suite — `verify:stale-pending` case N is what
   * pins the numbers themselves (and pins them to the sweep's grace periods).
   */
  const ttlHours = (pi: { expiresAt: Date | null }) =>
    Math.round(((pi.expiresAt?.getTime() ?? 0) - Date.now()) / 3600_000);
  ok(
    "C7-TTL: an on-session card keeps its 1 hour",
    ttlHours(directIntent) === Math.round(ON_SESSION_TTL_MS / 3600_000),
  );
  // Same instrument type, mandate rail stamped the way a RazorPay e-mandate vault stamps
  // it (0179). An e-mandate debit can take up to 2 working days to authorize, so an hour
  // is not a deadline, it is a guarantee of losing the authorization.
  const mandatePm = await vaultPm("4242424242424242");
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateRail: "emandate" })
      .where(eq(paymentMethods.id, mandatePm.id)),
  );
  const mandateIntent = (
    await createPaymentIntent({
      organizationId: orgId,
      businessId: piBiz.id,
      paymentMethodPublicId: mandatePm.publicId,
      amountMinor: 1500,
      currency: "USD",
    })
  ).intent;
  ok(
    "C7-TTL: an e-mandate rail gets its rail's window, not an hour",
    ttlHours(mandateIntent) === railTtlHours("emandate"),
  );
  // A vault-setup intent is created BEFORE any payment method row exists, so there is no
  // rail to read — the case the hour hurt most (expire it and the mandate still goes live
  // at the gateway, attached to nothing). It takes the uncharacterised-rail default.
  const setupTtl = (
    await createPaymentIntent({
      organizationId: orgId,
      businessId: piBiz.id,
      purpose: "setup",
      customerPublicId: cus.publicId,
      currency: "USD",
      // Pinned, as checkout/portal pin it: by this point the business has more than one
      // USD-capable account and the router would (correctly) refuse to guess.
      gatewayAccountId: acct.publicId,
    })
  ).intent;
  ok(
    "C7-TTL: a setup intent with no instrument yet takes the default window",
    ttlHours(setupTtl) === DEFAULT_RAIL_TTL_HOURS,
  );

  // The portal's "Pay now": the buyer types a card into the gateway's own sheet and clears
  // 3DS inline, so the hour applies — and the rail cannot decide it, because this mode
  // passes no instrument and no `methodTypes`. That unknown rail is the trap: read after
  // the rail test the intent falls to the 72h default and sits on its invoice for days.
  const buyerSheet = (
    await createPaymentIntent({
      organizationId: orgId,
      businessId: piBiz.id,
      letBuyerChooseMethod: true,
      customerPublicId: cus.publicId,
      amountMinor: 2500,
      currency: "USD",
      // Pinned for the same reason the setup case above pins it.
      gatewayAccountId: acct.publicId,
    })
  ).intent;
  ok(
    "C7-TTL: a buyer-present gateway sheet keeps the hour, not the unknown-rail default",
    ttlHours(buyerSheet) === Math.round(ON_SESSION_TTL_MS / 3600_000),
  );
  /**
   * …and a RETRY of that intent keeps it too. The flag is not a column, so the retry path
   * infers it — a `payment` intent with no stored instrument can only have been minted
   * with it, because the create path refuses that combination otherwise. Without the
   * inference a retried Pay now falls back to the 72h unknown-rail default: the same fix
   * landing on one path and not its twin, which is how #63 came back a second time.
   *
   * Getting a retryable intent needs a FAILED attempt (`retryPaymentIntent` refuses an
   * authorized one), and tmtest authorizes inline — so the account is faulted for the
   * create and un-faulted for the retry.
   */
  const ttlFault = await createGatewayAccount({
    organizationId: orgId,
    businessId: piBiz.id,
    gatewayKey: "tmtest",
    label: "TTL retry fixture",
    credentials: { create_intent_fault: "reject" },
  });
  let faultedId = "";
  try {
    await createPaymentIntent({
      organizationId: orgId,
      businessId: piBiz.id,
      letBuyerChooseMethod: true,
      customerPublicId: cus.publicId,
      amountMinor: 2700,
      currency: "USD",
      gatewayAccountId: ttlFault.publicId,
    });
  } catch {
    const [booked] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.gatewayAccountId, ttlFault.id))
        .limit(1),
    );
    faultedId = booked?.publicId ?? "";
  }
  ok("C7-TTL: fixture — the faulted create booked a retryable intent", faultedId !== "");
  if (faultedId) {
    await updateGatewayAccount({
      organizationId: orgId,
      businessId: piBiz.id,
      gwaPublicId: ttlFault.publicId,
      credentials: {},
    });
    const retried = (await retryPaymentIntent(orgId, piBiz.id, faultedId))!.intent;
    ok(
      "C7-TTL: …and a RETRY of it does not fall back to the unknown-rail default",
      ttlHours(retried) === Math.round(ON_SESSION_TTL_MS / 3600_000),
      `${ttlHours(retried)}h`,
    );
  }
  // Same flag with an instrument ON FILE, and an asynchronous rail at that. The stored
  // method is withheld from the adapter here, so it must not reach the deadline either —
  // the buyer is paying with whatever they type, not with this mandate.
  const sheetOverMandate = (
    await createPaymentIntent({
      organizationId: orgId,
      businessId: piBiz.id,
      letBuyerChooseMethod: true,
      customerPublicId: cus.publicId,
      paymentMethodPublicId: mandatePm.publicId,
      amountMinor: 2600,
      currency: "USD",
    })
  ).intent;
  ok(
    "C7-TTL: the stored rail has no say once the buyer picks in the sheet",
    ttlHours(sheetOverMandate) === Math.round(ON_SESSION_TTL_MS / 3600_000),
  );
  // Ordering against the AFA rule, which needs INR above ₹15,000 — asserted on the pure
  // function because this business is USD. A MANDATE debit waits on the issuer's link
  // (96h, measured 2026-08-13); the same amount typed into the gateway's sheet does not.
  const afaDebit = {
    purpose: "payment" as const,
    rail: "card",
    methodType: "card",
    currency: "INR",
    amountMinor: 2_821_500n,
  };
  ok(
    "C7-TTL: an INR mandate debit above the AFA floor still takes the card window",
    intentTtlMs(afaDebit) === railTtlHours("card") * 3600_000,
  );
  ok(
    "C7-TTL: the same debit in the gateway's sheet takes the hour, not the AFA window",
    intentTtlMs({ ...afaDebit, letBuyerChooseMethod: true }) === ON_SESSION_TTL_MS,
  );

  // ── C7-REL: the expiry sweep releases a HOLD, and only a hold ────────────────
  /**
   * `releaseHoldBeforeExpiry` had no unattended coverage at all — only
   * `scripts/probe-late-authorization.ts` § D ever exercised it. Both directions are
   * asserted here because the fix (2026-09-01) narrows the trigger, and a narrowing is
   * exactly the kind of change that silently takes the good case with it.
   *
   * (a) A PAYMENT intent authorized past its deadline still releases: the buyer's money is
   *     really held and abandoning it is the bug 0217 fixed. This is the assertion that
   *     proves the non-setup path is untouched.
   * (b) A SETUP intent authorized past its deadline releases NOTHING. It is created with
   *     `amountMinor: 0n` on every adapter, so there is no hold; Stripe answers a cancel on
   *     a succeeded SetupIntent with `400 setup_intent_unexpected_state`, which is the same
   *     failing call `finishSetupConsume` was cleaned of in 041e35cb and which survived
   *     here. `not_held` and NOT `unsupported`: an `unsupported` verdict would raise the
   *     abandoned-funds WARN for funds that do not exist.
   *
   * Both are forced to `authorized` + a past deadline by direct UPDATE, the same lever the
   * expiry assertions above use — `finishSetupConsume`'s catch path is what writes
   * `authorized` on a real setup intent, and reproducing a failed vault persist here would
   * test the harness rather than the sweep.
   */
  const holdPm = await vaultPm("4242424242424242");
  const holdPi = (
    await createPaymentIntent({
      organizationId: orgId,
      businessId: piBiz.id,
      paymentMethodPublicId: holdPm.publicId,
      amountMinor: 4321,
      currency: "USD",
    })
  ).intent;
  const setupPi = (
    await createPaymentIntent({
      organizationId: orgId,
      businessId: piBiz.id,
      purpose: "setup",
      customerPublicId: cus.publicId,
      currency: "USD",
      gatewayAccountId: acct.publicId,
    })
  ).intent;
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ status: "authorized", expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(paymentIntents.publicId, holdPi.publicId)),
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ status: "authorized", expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(paymentIntents.publicId, setupPi.publicId)),
  );
  const reversalsBefore = (
    await listTransactions(orgId, piBiz.id, { type: "payment_reversal", limit: 200 })
  ).length;
  const relSweep = await expirePaymentIntents(new Date());
  // The sweep's counters are platform-wide, so they can only be asserted as lower bounds
  // without making the suite depend on what else is in the database. The load-bearing
  // assertions are the per-intent ones below, which are exact.
  ok("C7-REL: the sweep expired both intents", relSweep.expired >= 2);
  ok("C7-REL: the payment hold was released", relSweep.released >= 1);
  const reversalsAfter = await listTransactions(orgId, piBiz.id, {
    type: "payment_reversal",
    limit: 200,
  });
  ok(
    "C7-REL: the payment hold books ONE payment_reversal",
    reversalsAfter.length === reversalsBefore + 1,
  );
  ok(
    "C7-REL: and it belongs to the PAYMENT intent, not the setup",
    reversalsAfter.some((t) => t.paymentIntentId === holdPi.id) &&
      !reversalsAfter.some((t) => t.paymentIntentId === setupPi.id),
  );
  const relEvents = (await listEventsFiltered(orgId, { limit: 200 })).data.filter(
    (e) => e.type === "payment_intent_expired",
  );
  // `buildEventData` nests the resource under its own key and spreads `extra` beside it:
  // `{ payment_intent: { id, purpose }, hold_release }`.
  type ExpiredData = { payment_intent?: { id?: string }; hold_release?: string };
  const relOf = (publicIdOf: string) =>
    relEvents.find((e) => (e.data as ExpiredData | null)?.payment_intent?.id === publicIdOf)
      ?.data as ExpiredData | undefined;
  ok(
    "C7-REL: the payment intent reports hold_release=released",
    relOf(holdPi.publicId)?.hold_release === "released",
  );
  ok(
    "C7-REL: the setup intent reports hold_release=not_held (no cancel was attempted)",
    relOf(setupPi.publicId)?.hold_release === "not_held",
  );

  // ── C7-REVIVE: the bank authorized after we had already expired the intent ───
  /**
   * The other half of the late-authorization fix (the webhook path calls this). Measured
   * with `scripts/probe-late-authorization.ts` scenarios A and B: `applyIntentEvent` treats
   * `expired` as terminal and returns `ignored`, so the approval — and the money behind it
   * — is dropped in silence.
   */
  const lateAt = new Date();
  const revived = await reviveIntentForLateAuthorization(orgId, piBiz.id, stale.publicId, {
    occurredAt: lateAt,
  });
  ok(
    "C7-REVIVE: an expired intent is revived to authorized",
    revived?.status === "authorized" && (revived?.expiresAt?.getTime() ?? 0) > Date.now(),
  );
  // Stamped with the moment the GATEWAY authorized, not with now().
  ok(
    "C7-REVIVE: authorized_at records when the bank actually approved",
    revived?.authorizedAt != null &&
      Math.abs(revived.authorizedAt.getTime() - lateAt.getTime()) < 2000,
  );
  // The attempt the sweep failed with `intent_expired` must not stay failed under an
  // authorized intent: `retryPaymentIntent` reads that pairing as retriable and would mint
  // a pointless attempt N+1 against an authorization that already succeeded.
  const revivedAttempts = await listAttemptsForIntent(orgId, piBiz.id, stale.publicId);
  ok(
    "C7-REVIVE: the expiry-failed attempt is reopened, its error cleared",
    revivedAttempts.some((a) => a.status === "authorized" && a.errorCode == null),
  );
  // Redelivery: gateways retry, and two copies of one authorization must not both revive.
  ok(
    "C7-REVIVE: a redelivered late authorization revives nothing twice",
    (await reviveIntentForLateAuthorization(orgId, piBiz.id, stale.publicId, {
      occurredAt: lateAt,
    })) === null,
  );
  // A CONSUMED intent is genuinely finished — reviving it would re-open a captured charge.
  ok(
    "C7-REVIVE: a consumed intent is never revived",
    (await reviveIntentForLateAuthorization(orgId, piBiz.id, intent.publicId, {
      occurredAt: lateAt,
    })) === null,
  );
  // And the point of the whole thing: `consumePaymentIntent` no longer refuses it for
  // being expired. Any other refusal (an invoice whose outstanding drifted, a gateway that
  // will not capture an unauthenticated intent) is the caller's business, not this fix's.
  //
  // ⚠ Keyed on the error's CODE, not its message. It used to read
  // `reviveConsumeError !== "Intent expired"`, and #23 rewrote that message for the
  // payer who reads it — which would have left this assertion passing forever no matter
  // what the code did, because the new sentence is not the old string either way. A
  // negative assertion on prose is one copy edit away from becoming decoration.
  let reviveConsumeCode: string | null = null;
  try {
    await consumePaymentIntent(orgId, piBiz.id, stale.publicId, invWrong.publicId);
  } catch (e) {
    reviveConsumeCode =
      e instanceof PaymentIntentError ? (e.code ?? "(none)") : `(${(e as Error).name})`;
  }
  ok(
    "C7-REVIVE: consume no longer refuses the revived intent as expired",
    reviveConsumeCode !== "intent_expired",
    `code=${reviveConsumeCode}`,
  );
}

/**
 * ── #28a · a disabled gateway account must not name itself to the buyer ──────────
 *
 * `assertIntentGatewayUsable` (payment-intents/service.ts) used to throw
 * `Gateway account ${publicId} is not active` straight into `PaymentIntentError.message`
 * — and the portal's collect route maps that message VERBATIM onto a buyer's screen
 * (`badRequest(reply, e.message)`). A buyer cannot activate a gateway account; the
 * sentence named what an OPERATOR must fix, on the one surface an operator never reads.
 *
 * The fix keeps `code: 'gateway_account_inactive'` (so nothing that asserts on the code
 * — like C7-REVIVE just above — breaks) and rewrites `message` to something true, buyer-
 * safe, and blame-free, while logging the real account id via `log.error` at the throw
 * site — the existing operator-log path, not a new ops surface.
 *
 * Captures real stdout during the call rather than asserting on behaviour we can't
 * observe any other way: this refusal never reaches a database row (it fires before the
 * atomic claim), so a structured log line is the ONLY place the account id survives.
 */
{
  const orgId = org.organization.id;
  const cfgBiz = await createBusiness({
    organizationId: orgId,
    name: "PI Gateway Config",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cfgAcct = (await listGatewayAccounts(orgId, cfgBiz.id)).find(
    (a) => a.gatewayKey === "tmtest",
  )!;
  const cfgCus = await createCustomer({
    organizationId: orgId,
    businessId: cfgBiz.id,
    email: "gw-config@gw.test",
  });
  const cfgCusRow = (
    await withTenant(orgId, (tx) =>
      tx.select().from(customers).where(eq(customers.publicId, cfgCus.publicId)).limit(1),
    )
  )[0]!;
  const cfgPm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: cfgBiz.id,
    customer: cfgCusRow,
    token: "tok_4242",
  });
  const cfgInv = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: cfgBiz.id,
    customerId: cfgCusRow.id,
    currency: "USD",
    lines: [{ description: "Gateway-config coverage", amountMinor: 400_00n }],
    collect: false,
  });
  const { intent: cfgIntent } = await createPaymentIntent({
    organizationId: orgId,
    businessId: cfgBiz.id,
    purpose: "payment",
    paymentMethodPublicId: cfgPm.publicId,
    customerPublicId: cfgCus.publicId,
    amountMinor: Number(cfgInv.invoice.amountDueMinor),
    currency: cfgInv.invoice.currency,
    invoicePublicId: cfgInv.invoice.publicId,
    session: "on_session",
  });
  ok(
    "#28a: fixture intent authorizes immediately (tmtest, no challenge)",
    cfgIntent.status === "authorized",
  );
  // Disable the account AFTER authorizing — exactly the shape that matters: the buyer
  // already has a live hold, and it is the CONSUME step (leg 2 / capture) that must now
  // refuse without naming the account.
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: cfgBiz.id,
    gwaPublicId: cfgAcct.publicId,
    status: "disabled",
  });
  let cfgCode: string | null = null;
  let cfgMessage: string | null = null;
  try {
    await consumePaymentIntent(orgId, cfgBiz.id, cfgIntent.publicId, cfgInv.invoice.publicId);
  } catch (e) {
    if (e instanceof PaymentIntentError) {
      cfgCode = e.code ?? "(none)";
      cfgMessage = e.message;
    } else {
      console.error(`  ↳ #28a unexpected throw: ${(e as Error).name}`);
    }
  }
  ok(
    "#28a: consume on a disabled gateway account still refuses with code=gateway_account_inactive",
    cfgCode === "gateway_account_inactive",
    `code=${cfgCode}`,
  );
  ok(
    "#28a: …but the BUYER-FACING message no longer names the gateway account",
    cfgMessage != null &&
      !cfgMessage.includes(cfgAcct.publicId) &&
      !cfgMessage.toLowerCase().includes("gateway account"),
    `message=${cfgMessage}`,
  );
  ok(
    "#28a: …and says something true instead of blaming the buyer",
    cfgMessage != null &&
      cfgMessage.includes("problem with the payment configuration") &&
      cfgMessage.includes("We did not charge you"),
    `message=${cfgMessage}`,
  );
  /**
   * The real account id is not simply dropped — it must still land somewhere an
   * operator reads. Pino's transport (pino-pretty, in a worker thread in this very
   * environment — see the colorized `[HH:MM:SS] WARN …` lines this suite already
   * prints) writes to the fd directly rather than through `process.stdout.write`, so a
   * runtime capture here would either miss it or fake a pass depending on transport
   * config — not something worth coupling a gate to. The static check below reads the
   * actual throw site instead: it fails if the log call is ever removed from
   * `assertIntentGatewayUsable`, which is the mutation that matters.
   */
  const gatewaySource = readFileSync(
    new URL("../src/modules/payment-intents/service.ts", import.meta.url),
    "utf8",
  );
  ok(
    "#28a: assertIntentGatewayUsable logs the real account id + code before throwing the safe message",
    /log\.error\(new Error\("gateway account is not active at consume"\), \{[\s\S]{0,200}reason: "gateway_account_inactive"[\s\S]{0,120}gatewayAccount: gw\.acc\.publicId/.test(
      gatewaySource,
    ),
  );
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: cfgBiz.id,
    gwaPublicId: cfgAcct.publicId,
    status: "active",
  });
}

// ── C7-TT: a time-travelled business pays through the test gateway ─────────────
// The intent's deadline is counted on the business clock, the one consume checks.
{
  const orgId = org.organization.id;
  const ttBiz = await createBusiness({
    organizationId: orgId,
    name: "PI Time Travel Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const ttCus = await createCustomer({
    organizationId: orgId,
    businessId: ttBiz.id,
    email: "pi-tt@gw.test",
  });
  const ttAcct = await createGatewayAccount({
    organizationId: orgId,
    businessId: ttBiz.id,
    gatewayKey: "tmtest",
    label: "TM",
    credentials: {},
  });
  const ttRow = (await getGatewayAccount(orgId, ttBiz.id, ttAcct.publicId))!;
  const ref = await resolveAdapter(ttRow).vaultPaymentMethod({
    customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${ttCus.publicId}` },
    token: "4242424242424242",
  });
  const [ttPm] = await withTenant(orgId, (tx) =>
    tx
      .insert(paymentMethods)
      .values({
        organizationId: orgId,
        businessId: ttBiz.id,
        customerId: ttCus.id,
        publicId: publicId("pm"),
        providerKey: "tmtest",
        providerCustomerId: `tmcus_${ttCus.publicId}`,
        providerPaymentMethodId: ref.providerPaymentMethodId,
        type: "card",
        last4: ref.display.last4,
        gatewayAccountId: ttRow.id,
      })
      .returning(),
  );
  const ttInv = (
    await createInvoiceFromLines({
      organizationId: orgId,
      businessId: ttBiz.id,
      customerId: ttCus.id,
      currency: "USD",
      lines: [{ description: "Time travel target", amountMinor: 2500n }],
      collect: false,
    })
  ).invoice;
  // Ten days ahead of the real clock: an intent counted from the real clock is past due.
  await startTimeTravel({ orgId, bizId: ttBiz.id, genesisTime: new Date() });
  await travelForward({
    orgId,
    bizId: ttBiz.id,
    toTime: new Date(Date.now() + 10 * 86_400_000),
  });
  const ttCreated = await createPaymentIntent({
    organizationId: orgId,
    businessId: ttBiz.id,
    paymentMethodPublicId: ttPm!.publicId,
    amountMinor: 2500,
    currency: "USD",
  });
  if (ttCreated.intent.status !== "authorized")
    await authorizePaymentIntent(orgId, ttBiz.id, ttCreated.intent.publicId);
  const ttPaid = await consumePaymentIntent(
    orgId,
    ttBiz.id,
    ttCreated.intent.publicId,
    ttInv.publicId,
  ).catch((e: Error) => e);
  ok(
    "C7-TT: a payment in a time-travelled business succeeds (the intent is not expired at birth)",
    !(ttPaid instanceof Error) && ttPaid?.charge?.status === "succeeded",
    ttPaid instanceof Error
      ? ttPaid.message
      : `${ttCreated.intent.status} → ${ttPaid?.charge?.status}`,
  );
  await stopTimeTravel({ orgId, bizId: ttBiz.id, wipe: false });
}

// ── C7+: intents rebuilt — purposes, attempts, void, declines, traces, hooks ──
// The engine half of the rebuild. C4 proves the ADAPTER contract; this proves what
// the engine PERSISTS: a setup intent that vaults instead of charging, an attempt
// timeline that survives a retry, a void that is a release (never a refund), a
// decline that lands as data, the trace that is the only link to the request logs,
// and the inbound callbacks that make a buyer authorization real.
{
  const orgId = org.organization.id;
  // A fresh TEST business auto-provisions exactly ONE tmtest account (TL-5), so
  // `selectGatewayAccount` is unambiguous for the setup intents below — which have
  // no payment method to route from.
  const biz = await createBusiness({
    organizationId: orgId,
    name: "PI Rebuild",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acctLite = (await listGatewayAccounts(orgId, biz.id)).find(
    (a) => a.gatewayKey === "tmtest",
  )!;
  const acctRow = (await getGatewayAccount(orgId, biz.id, acctLite.publicId))!;
  const tm = resolveAdapter(acctRow);
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "rebuild@gw.test",
  });

  const vaultPm = async (token: string) => {
    const ref = await tm.vaultPaymentMethod({
      customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cus.publicId}` },
      token,
    });
    return withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: cus.id,
          publicId: publicId("pm"),
          providerKey: "tmtest",
          providerCustomerId: `tmcus_${cus.publicId}`,
          providerPaymentMethodId: ref.providerPaymentMethodId,
          type: "card",
          last4: ref.display.last4,
          gatewayAccountId: acctRow.id,
        })
        .returning();
      return row!;
    });
  };
  const mkInvoice = async (amountMinor: bigint) =>
    (
      await createInvoiceFromLines({
        organizationId: orgId,
        businessId: biz.id,
        customerId: cus.id,
        currency: "USD",
        lines: [{ description: "Intent target", amountMinor }],
        collect: false,
      })
    ).invoice;
  const invoiceRow = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, id)).limit(1),
      )
    )[0]!;
  /** Events of one type naming this intent (the org-wide feed is far too noisy by now). */
  const eventsNaming = async (type: string, needle: string) => {
    const rows = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(events)
        .where(and(eq(events.businessId, biz.id), eq(events.type, type))),
    );
    return rows.filter((r) => JSON.stringify(r.data).includes(needle));
  };
  /**
   * `gateway_request_logs` is written fire-and-forget (providers/http.ts never
   * blocks a gateway call on its own audit row), so poll rather than race it.
   */
  const logsForTrace = async (traceId: string, want = 1) => {
    let rows = await systemDb
      .select()
      .from(gatewayRequestLogs)
      .where(eq(gatewayRequestLogs.traceId, traceId));
    for (let i = 0; i < 40 && rows.length < want; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await systemDb
        .select()
        .from(gatewayRequestLogs)
        .where(eq(gatewayRequestLogs.traceId, traceId));
    }
    return rows;
  };
  /** An attempt's (or a collection's) calls: its span, which can cross requests. */
  const logsForSpan = async (spanId: string, want = 1) => {
    let rows: (typeof gatewayRequestLogs.$inferSelect)[] = [];
    for (let i = 0; i < 40 && rows.length < want; i++) {
      if (i) await new Promise((r) => setTimeout(r, 50));
      rows = await systemDb
        .select()
        .from(gatewayRequestLogs)
        .where(eq(gatewayRequestLogs.spanId, spanId));
    }
    return rows;
  };

  // ── (1) setup purpose: zero amount, no instrument, a CUSTOMER ───────────────
  // Most real intents are $0.00 Stripe SetupIntents. The product is a
  // vaulted card, so the proof is a payment_methods row appearing and NO money moving.
  const cashBefore = await ledgerBalance(orgId, biz.id, "cash");
  const arBefore = await ledgerBalance(orgId, biz.id, "accounts_receivable");
  const setupCus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "setup@gw.test",
  });
  const setup = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    purpose: "setup",
    customerPublicId: setupCus.publicId,
    currency: "USD",
  });
  ok(
    "C7+: setup intent created with no amount and no instrument",
    setup.intent.purpose === "setup" &&
      setup.intent.amountMinor === 0n &&
      setup.intent.paymentMethodId === null,
  );
  ok(
    "C7+: setup intent born in_progress with a client_secret challenge",
    setup.intent.status === "in_progress" &&
      (setup.intent.nextAction as BuyerAuthorization | null)?.mode === "client_secret",
  );
  ok(
    "C7+: setup intent mints attempt #1",
    setup.attempt.attemptNumber === 1 && setup.intent.attemptCount === 1,
  );
  const setupAuthorized = await authorizePaymentIntent(orgId, biz.id, setup.intent.publicId);
  ok("C7+: setup challenge completes → authorized", setupAuthorized?.status === "authorized");
  // No invoice argument: a setup intent is consumed INTO an instrument, not into money.
  // Guarded: a throw here must be REPORTED as a failing check, not abort the suite —
  // everything after it (attempts, void, traces, callbacks) is independent.
  let setupConsumed: Awaited<ReturnType<typeof consumePaymentIntent>> = null;
  let setupThrew: string | null = null;
  try {
    setupConsumed = await consumePaymentIntent(orgId, biz.id, setup.intent.publicId);
  } catch (e) {
    setupThrew = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`  ↳ setup consume threw: ${setupThrew}`);
  }
  ok("C7+: setup consume completes without throwing", setupThrew === null);
  ok(
    "C7+: consuming a setup intent vaults an instrument",
    setupConsumed?.paymentMethod != null && setupConsumed?.intent.status === "consumed",
  );
  const vaulted = await listPaymentMethods(orgId, setupCus.id);
  ok(
    "C7+: the instrument is a REAL payment_methods row",
    vaulted.length === 1 &&
      vaulted[0]!.id === setupConsumed?.paymentMethod?.id &&
      vaulted[0]!.last4 === "4242",
  );
  ok(
    "C7+: setup consume closes the attempt as consumed + links the instrument",
    setupConsumed?.attempt?.status === "consumed" &&
      setupConsumed?.attempt?.paymentMethodId === vaulted[0]!.id,
  );
  ok(
    "C7+: setup consume moves NO money (cash + AR unchanged)",
    (await ledgerBalance(orgId, biz.id, "cash")) === cashBefore &&
      (await ledgerBalance(orgId, biz.id, "accounts_receivable")) === arBefore,
  );
  const setupPayments = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.customerId, setupCus.id)),
  );
  ok("C7+: setup consume writes no payments row", setupPayments.length === 0);

  /**
   * ── (1a) #28b — MEASURED, not assumed: does the SETUP consume go stale like #23's
   * payment path did? ────────────────────────────────────────────────────────────
   *
   * #23 fixed `consumePaymentIntent` refusing a `payment` intent as "not authorized"
   * when the buyer's own leg-2 request beats the webhook back — our row still says
   * `in_progress`, the gateway already holds the money. `confirmAuthorizationWithGateway`
   * is scoped to `purpose: 'payment'` (its own docblock says so), so the SETUP branch of
   * `consumePaymentIntent` has NO poll: on a still-`in_progress` intent it goes straight
   * to `{ outcome: 'not_authorized' }` and throws. The filing (#28) asked whether
   * `completeVaultFromIntent` (vault-setup.ts) — the function a buyer's add-card
   * completion actually calls — inherits that gap. It does not, and the test below is
   * what settles it rather than assumes it:
   *
   * `completeVaultFromIntent` never lets `consumePaymentIntent` see a stale row in the
   * first place. Read its own lines: `if (intent.status === "in_progress" ||
   * intent.status === "requires_action") { await authorizePaymentIntent(...) }` runs
   * BEFORE the consume call — it self-authorizes on the BUYER'S OWN COMPLETION REQUEST
   * (safe, per its docblock, because the consume that follows still asks the GATEWAY to
   * resolve the order; a client that lied gets `failSetupConsume`, not a vaulted card).
   * So by the time `consumePaymentIntent` runs, the row already says `authorized` and the
   * purpose='setup' branch of `confirmAuthorizationWithGateway` is never reached at all —
   * not because it would answer correctly, but because nothing here asks it the
   * question. Any further race (the webhook claims it first, or authorizes it out from
   * under this call) is absorbed by the `refusal` catch + the up-to-2s
   * `rowTheIntentNames()` wait loop a few lines below, which is a DIFFERENT, older
   * mechanism than #23's gateway poll and was not touched by it.
   *
   * This fixture reproduces #23's exact shape for setup: create the intent and call
   * `completeVaultFromIntent` as the buyer's OWN first touch — no prior
   * `authorizePaymentIntent`, no webhook, nothing else has looked at this row. If the
   * self-authorize line above were ever removed, this would fail exactly the way #23's
   * pre-fix payment path failed (see the mutation note in PROGRESS/the report for this
   * defect) — proving the assertion watches the real mechanism, not a coincidence.
   */
  {
    const staleCus = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "setup-stale@gw.test",
    });
    const [staleCusRow] = await withTenant(orgId, (tx) =>
      tx.select().from(customers).where(eq(customers.publicId, staleCus.publicId)).limit(1),
    );
    const staleSetup = await createPaymentIntent({
      organizationId: orgId,
      businessId: biz.id,
      purpose: "setup",
      customerPublicId: staleCus.publicId,
      currency: "USD",
    });
    ok(
      "#28b: fixture setup intent born in_progress — nothing has authorized it yet",
      staleSetup.intent.status === "in_progress",
    );
    let staleVaulted: Awaited<ReturnType<typeof completeVaultFromIntent>> | null = null;
    let staleThrew: string | null = null;
    try {
      // No `authorizePaymentIntent` call here on purpose — the buyer's completion
      // request is the FIRST thing to touch this intent, exactly #23's race shape.
      staleVaulted = await completeVaultFromIntent({
        organizationId: orgId,
        businessId: biz.id,
        customerId: staleCusRow!.id,
        paymentIntentPublicId: staleSetup.intent.publicId,
      });
    } catch (e) {
      staleThrew = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(`  ↳ #28b stale setup consume threw: ${staleThrew}`);
    }
    ok(
      "#28b: completeVaultFromIntent vaults the card from a still-in_progress intent " +
        "— no false 'not authorized' refusal",
      staleThrew === null && staleVaulted?.id != null,
    );
    const staleFresh = await getPaymentIntent(orgId, biz.id, staleSetup.intent.publicId);
    ok(
      "#28b: the intent itself reaches consumed, not stuck refusing",
      staleFresh?.status === "consumed",
    );
  }

  /**
   * ── #36 · A SETUP REFUSAL MUST NOT PROMISE AN INVOICE ────────────────────────
   *
   * The block above proves the BUYER's path never reaches the setup branch of the
   * refusal, because `completeVaultFromIntent` self-authorizes first. The OPERATOR
   * route (`POST /v1/businesses/:biz/payment_intents/:pi/consume`) calls
   * `consumePaymentIntent` directly with no such wrapper, so it does reach it — and
   * `confirmAuthorizationWithGateway` is hardcoded to `not_authorized` for
   * `purpose: 'setup'`, so the refusal fires without the gateway ever being asked.
   *
   * The message it fired was written for a PAYMENT: "...it will be applied to this
   * invoice on its own once it arrives." A setup intent HAS no invoice — the product is
   * a vaulted instrument — so it told someone saving a card to wait for a document that
   * will never exist. Same class as #28: not a leak of internal detail, but a sentence
   * that is false for the case it is shown in.
   *
   * Asserted on the WORDS rather than the code, deliberately: the code
   * (`intent_not_authorized`) was already right and is unchanged, so a code assertion
   * would have passed throughout and proved nothing.
   */
  {
    const copyCus = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "setup-copy@gw.test",
    });
    const copySetup = await createPaymentIntent({
      organizationId: orgId,
      businessId: biz.id,
      purpose: "setup",
      customerPublicId: copyCus.publicId,
      currency: "USD",
    });
    let copyMsg = "";
    let copyCode: string | null = null;
    try {
      // The operator route's shape: straight into the engine, no self-authorize.
      await consumePaymentIntent(orgId, biz.id, copySetup.intent.publicId);
    } catch (e) {
      copyMsg = e instanceof Error ? e.message : String(e);
      copyCode = (e as { code?: string })?.code ?? null;
    }
    ok(
      "#36: consuming a stale SETUP intent still refuses, with the unchanged code",
      copyCode === "intent_not_authorized",
      `code=${copyCode} msg=${copyMsg}`,
    );
    ok(
      "#36: ...and the refusal does NOT promise an invoice that cannot exist",
      copyMsg.length > 0 && !/invoice/i.test(copyMsg),
      copyMsg,
    );
    ok(
      "#36: ...and it names what the person was actually doing — saving a payment method",
      /payment method|card|saved/i.test(copyMsg),
      copyMsg,
    );
  }

  // ── (1b) the SAME instrument, vaulted twice → ONE row (0183) ────────────────
  // Two paths vault one instrument BY DESIGN: the buyer's browser completing the
  // add-card, and `harvestSetupIntent` doing it from the gateway's webhook for the
  // buyer who approved and never came back. Both used to write — measured 2026-08-21,
  // RazorPay UPI mandate `token_XXXXXXXXXXXX02` became two `payment_methods` rows 15s
  // apart and the portal listed one mandate as two payment methods.
  //
  // Exercised through the single WRITER rather than through one gateway's flow,
  // because that is what makes the guarantee provider-agnostic: Stripe, RazorPay,
  // PayPal and tmtest all end here.
  const firstRow = vaulted[0]!;
  const again = await persistVaultedPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: setupCus,
    vaulted: {
      providerKey: firstRow.providerKey as ProviderPaymentMethodRef["providerKey"],
      providerPaymentMethodId: firstRow.providerPaymentMethodId,
      providerCustomerId: firstRow.providerCustomerId,
      display: { type: "card", ...(firstRow.brand ? { brand: firstRow.brand } : {}) },
      // Whoever arrives second is the one that knows the mandate confirmed — the
      // instrument is the same, the KNOWLEDGE of it is fresher.
      mandate: { maxAmountMinor: 500_000n, currency: "USD", rail: "card", status: "confirmed" },
    },
    gatewayAccountId: firstRow.gatewayAccountId,
  });
  const afterSecond = await listPaymentMethods(orgId, setupCus.id);
  ok(
    "0183: vaulting the same provider instrument twice does not add a second row",
    afterSecond.length === 1 && again.id === firstRow.id,
  );
  ok(
    "0183: the second arrival refreshes the mandate it knows about",
    again.mandateStatus === "confirmed" &&
      again.mandateRail === "card" &&
      again.mandateMaxAmountMinor === 500_000n,
  );
  ok(
    "0183: the refresh does not blank display fields the new ref said nothing about",
    again.last4 === firstRow.last4 && again.type === firstRow.type,
  );
  // The read above is not the only guard, because two concurrent vaults can both miss
  // it. `payment_methods_provider_pm_uq` is what makes the loser of that race fail
  // instead of writing a second row.
  const { id: _dupeId, publicId: _dupePid, createdAt: _dupeAt, ...dupeClone } = firstRow;
  let rawDupe = "accepted";
  try {
    await withTenant(orgId, (tx) =>
      tx.insert(paymentMethods).values({ ...dupeClone, publicId: publicId("pm") }),
    );
  } catch {
    rawDupe = "rejected";
  }
  ok(
    "0183: the database itself refuses a second row for the same provider instrument",
    rawDupe === "rejected",
  );

  // The third challenge mode end-to-end: the engine persists whatever descriptor the
  // gateway hands back, so a checkout-rail intent previews the REAL embedded checkout
  // instead of a card challenge the buyer would never see.
  const upiCus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "upi@gw.test",
  });
  const upiSetup = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    purpose: "setup",
    customerPublicId: upiCus.publicId,
    currency: "USD",
    methodTypes: ["upi"],
  });
  const upiAuth = upiSetup.intent.nextAction as BuyerAuthorization | null;
  ok(
    "C7+: a checkout-rail setup intent stores a checkout descriptor",
    upiAuth?.mode === "checkout" &&
      upiAuth.checkout?.orderId === upiSetup.intent.intentAtGateway &&
      upiAuth.checkout?.recurring === true &&
      upiAuth.checkout?.method === "upi",
  );

  // ── F-42/F-43: a mandate CONFIRMING is a payment method becoming usable ─────
  //
  // The add-card routes collect a customer's open invoices against a freshly usable
  // instrument (Billing LogIQ, ON by default). On the netbanking rails the instrument
  // is NOT usable when it is added — an e-mandate is `initiated` until the bank
  // confirms at T+1 — so that collection runs against something that cannot be
  // charged, and F-11's pre-flight now refuses the debit outright and defers 12 hours.
  // The confirmation webhook is the moment the instrument becomes chargeable, and
  // until F-42 it was wired to nothing: the buyer waited for the next backoff tick.
  //
  // Exercised through `handleProviderEvent`, not through `applyMandateUpdate`, so the
  // provider-event dedup and the outcome recording are part of what is proven.
  {
    const mandCus = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "mandate-confirm@gw.test",
    });
    /** A vaulted instrument on a netbanking rail whose bank has not confirmed yet. */
    const mkMandatePm = async (token: string, mandateStatus: string) => {
      const ref = await tm.vaultPaymentMethod({
        customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${mandCus.publicId}` },
        token,
      });
      return withTenant(orgId, async (tx) => {
        const [row] = await tx
          .insert(paymentMethods)
          .values({
            organizationId: orgId,
            businessId: biz.id,
            customerId: mandCus.id,
            publicId: publicId("pm"),
            providerKey: "tmtest",
            providerCustomerId: `tmcus_${mandCus.publicId}`,
            providerPaymentMethodId: ref.providerPaymentMethodId,
            type: "bank_transfer",
            mandateRail: "emandate",
            mandateStatus,
            gatewayAccountId: acctRow.id,
          })
          .returning();
        return row!;
      });
    };
    const mandInvoice = async (amountMinor: bigint) =>
      (
        await createInvoiceFromLines({
          organizationId: orgId,
          businessId: biz.id,
          customerId: mandCus.id,
          currency: "USD",
          lines: [{ description: "Awaiting the bank", amountMinor }],
          collect: false,
        })
      ).invoice;
    const mandateEvent = (pmId: string, status: string) =>
      handleProviderEvent("tmtest", {
        providerEventId: `evt_mandate_${randomUUID()}`,
        type: "payment_method.mandate_updated",
        providerPaymentMethodId: pmId,
        mandate: { status, rail: "emandate" },
        occurredAt: new Date(),
        raw: {},
      });

    const emPm = await mkMandatePm("4242424242424242", "initiated");
    const waiting = await mandInvoice(7700n);
    ok(
      "F-42: an invoice due against an unconfirmed mandate starts unpaid",
      (await invoiceRow(waiting.id)).status === "payment_due",
    );

    const confirmOutcome = await mandateEvent(emPm.providerPaymentMethodId, "confirmed");
    ok("F-42: the confirmation webhook is processed", confirmOutcome === "processed");
    ok(
      "F-42: the confirmation collects the invoice that was waiting on the bank",
      (await invoiceRow(waiting.id)).status === "paid",
    );

    // ── the REDELIVERY, which must not collect again ──────────────────────────
    // A DIFFERENT provider event id, so the dedup at the top of `handleProviderEvent`
    // lets it through — which is the point: dedup keys on the event, and two events
    // can both assert `confirmed`. Only the state transition stops this one.
    const second = await mandInvoice(3300n);
    const redelivered = await mandateEvent(emPm.providerPaymentMethodId, "confirmed");
    ok("F-42: a re-asserted confirmation is still processed", redelivered === "processed");
    ok(
      "F-42: re-asserting `confirmed` does NOT re-collect (no transition into live)",
      (await invoiceRow(second.id)).status === "payment_due",
    );

    // ── a resume that lands on `initiated` restores the row but collects nothing ──
    // The un-pause branch revalidates the instrument, and it is right to: the pause was
    // the only thing that invalidated it. But `initiated` is not chargeable, so
    // collecting here would trip F-11's pending pre-flight and spend a deferral for
    // nothing.
    const pausedPm = await mkMandatePm("4242424242424242", "paused");
    await withTenant(orgId, (tx) =>
      tx
        .update(paymentMethods)
        .set({ status: "invalid" })
        .where(eq(paymentMethods.id, pausedPm.id)),
    );
    const pausedInv = await mandInvoice(2200n);
    await mandateEvent(pausedPm.providerPaymentMethodId, "initiated");
    const resumedRow = async (id: string) =>
      (
        await withTenant(orgId, (tx) =>
          tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)).limit(1),
        )
      )[0]!;
    ok(
      "F-42: a resume onto `initiated` still un-invalidates the instrument",
      (await resumedRow(pausedPm.id)).status === "valid",
    );
    ok(
      "F-42: …but collects nothing — an unconfirmed mandate is not chargeable",
      (await invoiceRow(pausedInv.id)).status === "payment_due",
    );

    // ── and a resume onto a LIVE status DOES collect ──────────────────────────
    // The same situation as an add-card: an instrument that became collectable again.
    await mandateEvent(pausedPm.providerPaymentMethodId, "confirmed");
    ok(
      "F-42: a resume onto `confirmed` collects, exactly like an add-card",
      (await invoiceRow(pausedInv.id)).status === "paid",
    );

    // ── a confirmation on an instrument we already wrote off collects nothing ──
    // `applyMandateUpdate` deliberately does not revalidate on a confirmation: a mandate
    // coming alive says nothing about whether the card behind it expired or was refused.
    // Collecting anyway would debit an instrument the card updater or a hard decline had
    // already taken out of service.
    const deadCardPm = await mkMandatePm("4242424242424242", "initiated");
    await withTenant(orgId, (tx) =>
      tx
        .update(paymentMethods)
        .set({ status: "invalid" })
        .where(eq(paymentMethods.id, deadCardPm.id)),
    );
    const deadCardInv = await mandInvoice(4400n);
    await mandateEvent(deadCardPm.providerPaymentMethodId, "confirmed");
    ok(
      "F-42: a confirmation on an INVALID instrument collects nothing",
      (await invoiceRow(deadCardInv.id)).status === "payment_due",
    );
    ok(
      "F-42: …and the confirmation does not silently revalidate it either",
      (await resumedRow(deadCardPm.id)).status === "invalid",
    );

    // ── F-43: a SPENT single-use mandate is never debited ─────────────────────
    // `spent` belonged to none of the status sets, so nothing refused it and collection
    // kept charging an authorization that had already been used — while the buyer portal
    // told the payer it was finished.
    const spentPm = await mkMandatePm("4242424242424242", "spent");
    const spentInv = await mandInvoice(1187n); // a distinctive amount: the assertion below scans tmtest charges
    const spentPay = await collectInvoice({
      organizationId: orgId,
      businessId: biz.id,
      invoice: await invoiceRow(spentInv.id),
      paymentMethodOverrideId: spentPm.publicId,
    });
    ok(
      "F-43: a spent single-use mandate is refused before the gateway sees it",
      spentPay.status === "failed" && spentPay.failureCode === "mandate_spent",
    );
    ok(
      "F-43: the refusal does not brand the instrument invalid — nothing was declined",
      (await resumedRow(spentPm.id)).status === "valid",
    );
    ok(
      "F-43: no tmtest charge was made for the spent mandate",
      (
        await systemDb.select().from(tmtestCharges).where(eq(tmtestCharges.businessId, biz.id))
      ).every((c) => c.amountMinor !== 1187n),
    );

    // ── collect_open_invoices is kept on the method and read when the mandate confirms ──
    // Vaulted through the single writer with the add-card route's argument, then confirmed
    // by a real webhook. A fresh customer per case: collection takes every open invoice.
    {
      const [bizCfg] = await withTenant(orgId, (tx) =>
        tx
          .select({ cfg: businesses.dunningConfig })
          .from(businesses)
          .where(eq(businesses.id, biz.id)),
      );
      const setCollectRule = (on: boolean) =>
        withTenant(orgId, (tx) =>
          tx
            .update(businesses)
            .set({
              dunningConfig: {
                ...((bizCfg?.cfg as object | null) ?? {}),
                collect_on_payment_method_update: on,
              },
            })
            .where(eq(businesses.id, biz.id)),
        );
      /** A pending e-mandate added with `collect`, an open invoice, then the bank confirms. */
      const confirmAfterAdd = async (label: string, collect: boolean | undefined) => {
        const cus = await createCustomer({
          organizationId: orgId,
          businessId: biz.id,
          email: `oca-${label}-${randomUUID()}@gw.test`,
        });
        const ref = await tm.vaultPaymentMethod({
          customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cus.publicId}` },
          token: "4242424242424242",
        });
        const pm = await persistVaultedPaymentMethod({
          organizationId: orgId,
          businessId: biz.id,
          customer: cus,
          vaulted: {
            ...ref,
            display: { ...ref.display, type: "bank_transfer" },
            mandate: { status: "initiated", rail: "emandate" },
          },
          gatewayAccountId: acctRow.id,
          providerCustomerId: `tmcus_${cus.publicId}`,
          collectOpenInvoices: collect,
        });
        const inv = (
          await createInvoiceFromLines({
            organizationId: orgId,
            businessId: biz.id,
            customerId: cus.id,
            currency: "USD",
            lines: [{ description: "Awaiting the bank", amountMinor: 5100n }],
            collect: false,
          })
        ).invoice;
        const outcome = await mandateEvent(pm.providerPaymentMethodId, "confirmed");
        const [after] = await withTenant(orgId, (tx) =>
          tx
            .select({ c: paymentMethods.collectOpenInvoices })
            .from(paymentMethods)
            .where(eq(paymentMethods.id, pm.id)),
        );
        return {
          stored: pm.collectOpenInvoices,
          afterConfirm: after?.c ?? null,
          outcome,
          status: (await invoiceRow(inv.id)).status,
        };
      };

      await setCollectRule(true);
      const keepOpen = await confirmAfterAdd("off", false);
      ok(
        `OCA: the method stores collect_open_invoices=false (${keepOpen.stored})`,
        keepOpen.stored === false,
      );
      ok(
        `OCA: rule ON + false — the confirmation leaves the invoice open (${keepOpen.status})`,
        keepOpen.outcome === "processed" && keepOpen.status === "payment_due",
      );
      ok(
        `OCA: the choice is cleared after the first confirmation (${keepOpen.afterConfirm})`,
        keepOpen.afterConfirm === null,
      );
      const ruleOnOmitted = await confirmAfterAdd("on-omitted", undefined);
      ok(
        `OCA: rule ON + omitted — stored null, the confirmation collects (${ruleOnOmitted.status})`,
        ruleOnOmitted.stored === null && ruleOnOmitted.status === "paid",
      );

      await setCollectRule(false);
      const collectNow = await confirmAfterAdd("on", true);
      ok(
        `OCA: rule OFF + true — the confirmation collects (${collectNow.status})`,
        collectNow.stored === true && collectNow.status === "paid",
      );
      const ruleOffOmitted = await confirmAfterAdd("off-omitted", undefined);
      ok(
        `OCA: rule OFF + omitted — the confirmation leaves it open (${ruleOffOmitted.status})`,
        ruleOffOmitted.stored === null && ruleOffOmitted.status === "payment_due",
      );

      await withTenant(orgId, (tx) =>
        tx
          .update(businesses)
          .set({ dunningConfig: bizCfg?.cfg ?? null })
          .where(eq(businesses.id, biz.id)),
      );
    }

    /**
     * ── #104: the gateway row says WHICH FLOW took the money ─────────────────────
     *
     * Three flows charge a gateway and read identically in its dashboard: the clock
     * renewing, an operator pressing Collect now, and the payer pressing Pay now. When a
     * payment needs explaining that is the first question, and the answer lived only in our
     * own `payment_attempts` — which the support person looking at Stripe does not have.
     *
     * Worse on the INTENT path, which sent no description at all: it fell through to the
     * adapter's placeholder, literally "Card authorization" (measured on the live account
     * 2026-09-07).
     *
     * Asserted from what the ENGINE SENT, read back out of tmtest's synthetic request log —
     * the real adapters put the description on the gateway's own object, where nothing here
     * could see it.
     */
    {
      const descCus = await createCustomer({
        organizationId: orgId,
        businessId: biz.id,
        email: `desc-${randomUUID()}@gw.test`,
      });
      const descInv = (
        await createInvoiceFromLines({
          organizationId: orgId,
          businessId: biz.id,
          customerId: descCus.id,
          currency: "USD",
          lines: [{ description: "Widgets", amountMinor: 4200n }],
          collect: false,
        })
      ).invoice;
      const portalIntent = await createPaymentIntent({
        organizationId: orgId,
        businessId: biz.id,
        purpose: "payment",
        customerPublicId: descCus.publicId,
        invoicePublicId: descInv.publicId,
        amountMinor: 4200,
        currency: "USD",
        letBuyerChooseMethod: true,
        flow: "portal_payment",
      });
      const sent = await systemDb
        .select({ body: gatewayRequestLogs.responseBody })
        .from(gatewayRequestLogs)
        .where(
          and(
            eq(gatewayRequestLogs.businessId, biz.id),
            eq(gatewayRequestLogs.operation, "create_intent"),
          ),
        );
      const described = sent
        .map((r) => r.body as { intentId?: string; description?: string | null } | null)
        .find((b) => b?.intentId === portalIntent.intent.intentAtGateway);
      const desc = described?.description ?? "";
      ok(
        "#104: the intent path sends a description at all — it never used to",
        desc !== "" && desc !== null,
        desc || "(none — fell back to the adapter placeholder)",
      );
      ok(
        "#104: …naming the FLOW first, so two rows for one customer are told apart",
        desc.startsWith("Portal payment · "),
        desc,
      );
      ok(
        "#104: …then the invoice NUMBER, which is what a payer quotes back",
        desc.includes(`· Invoice ${descInv.number ?? descInv.publicId} ·`),
        desc,
      );
      ok("#104: …and the customer's email", desc.endsWith(descCus.email!), desc);
      // NOT "PayNow": `paynow` is a Stripe payment METHOD (Singapore's instant-transfer
      // scheme), so that word against a card debit would name a rail nobody used, in a
      // dashboard that also lists real PayNow payments.
      ok("#104: …and never the word PayNow", !/paynow/i.test(desc), desc);

      /**
       * ── The invoice page's own filter ────────────────────────────────────────
       *
       * An OPEN intent writes no transaction and no payments row, so the invoice's money
       * list could not see one and an operator had no way to know a checkout was already
       * open at the gateway for it. `pendingPaymentsForInvoices`' docblock names this
       * page as one of the two that "still need an intent-aware branch"; this is the
       * read-only half of that, and the filter it reads through.
       */
      const forThisInvoice = await listPaymentIntentsPage(orgId, biz.id, {
        invoicePublicId: descInv.publicId,
        limit: 50,
      });
      ok(
        "#104: the intents list can be filtered to ONE invoice",
        forThisInvoice.data.some((r) => r.intent.publicId === portalIntent.intent.publicId),
        `${forThisInvoice.data.length} rows`,
      );
      ok(
        "#104: …and returns nothing belonging to another invoice",
        forThisInvoice.data.every((r) => r.intent.invoiceId === descInv.id),
      );
      /**
       * An unknown id must return an EMPTY page, not every intent on the business.
       * Dropping an unrecognised filter is how a list ends up answering a question nobody
       * asked — and on this page it would render another invoice's open checkout as
       * belonging to the one being read.
       */
      const bogus = await listPaymentIntentsPage(orgId, biz.id, {
        invoicePublicId: "inv_does_not_exist",
        limit: 50,
      });
      ok(
        "#104: …while an unknown invoice id returns EMPTY, never everything",
        bogus.data.length === 0,
        `${bogus.data.length} rows`,
      );
    }

    /**
     * ── #104b: SAVING A CARD is described too ────────────────────────────────────
     *
     * A vault object is not money, which is why it went without a description — but it is
     * the row a support person opens when a renewal later fails on "the card they saved",
     * and Stripe showed a SetupIntent with NOTHING against it. RazorPay was the only
     * adapter sending anything and only its own generic default ("Authorize recurring
     * payments"), which names neither the customer nor the terms.
     *
     * No FLOW label here on purpose: "Renewal" and "Portal payment" are both false about
     * an object that moves no money. What it carries instead is who is authorising and,
     * when a ceiling is being registered, what that ceiling is — and on RazorPay's
     * e-mandate this text reaches the buyer's own bank page.
     */
    {
      const setupCus = await createCustomer({
        organizationId: orgId,
        businessId: biz.id,
        email: `setupdesc-${randomUUID()}@gw.test`,
      });
      const setupIntent = await createPaymentIntent({
        organizationId: orgId,
        businessId: biz.id,
        purpose: "setup",
        customerPublicId: setupCus.publicId,
        currency: "INR",
        maxAmountMinor: 1_500_000,
      });
      const logs = await systemDb
        .select({ body: gatewayRequestLogs.responseBody })
        .from(gatewayRequestLogs)
        .where(
          and(
            eq(gatewayRequestLogs.businessId, biz.id),
            eq(gatewayRequestLogs.operation, "create_setup_intent"),
          ),
        );
      const body = logs
        .map((r) => r.body as { intentId?: string; description?: string | null } | null)
        .find((b) => b?.intentId === setupIntent.intent.intentAtGateway);
      const sd = body?.description ?? "";
      ok(
        "#104b: a SETUP intent sends a description — Stripe showed none at all",
        sd !== "",
        sd || "(none)",
      );
      ok(
        "#104b: …naming the authorization, not a charge flow that would be a lie",
        sd.startsWith("Payment method setup · "),
        sd,
      );
      ok(
        "#104b: …carrying the CEILING being registered, which is the term agreed",
        /up to .*15,000\.00 per charge/.test(sd),
        sd,
      );
      ok("#104b: …and the customer who is authorizing", sd.endsWith(setupCus.email!), sd);
    }

    /**
     * ── #103: the gateway's answer is LEARNED, then enforced before the gateway ──
     *
     * The hole the other four refusals left. Each reads a mandate FACT and bows out when
     * its field is absent, so an instrument missing the mandate entirely satisfied all
     * four and every renewal went to Stripe — which refused it AFTER creating the
     * PaymentIntent, leaving the orphan `orphaned_gateway_intents` reported twice on
     * 2026-09-06/07.
     *
     * The loop, in order: attempt 1 REACHES the gateway and is refused, the refusal is
     * written onto the instrument, attempt 2 is refused here and never leaves. That order
     * is the design — two earlier cuts inferred the state from our own data instead (the
     * pm row, then the currency) and both were wrong, because all 13 migrated rows are
     * bare and indistinguishable from a plain card-on-file.
     *
     * Its own account: tmtest reads no reference and cannot reach this refusal by default,
     * and `charge_fault` makes it answer the way Stripe does. Both credentials matter —
     * RazorPay debits with the recurring token alone, so refusing it would invent a
     * failure the rail does not have.
     */
    const strictAcct = await createGatewayAccount({
      organizationId: orgId,
      businessId: biz.id,
      gatewayKey: "tmtest",
      label: "Reads the mandate reference",
      credentials: { per_debit_mandate_reference: "true", charge_fault: "mandate_missing" },
    });
    const barePm = await mkMandatePm("4242424242424242", "confirmed");
    await withTenant(orgId, (tx) =>
      tx
        .update(paymentMethods)
        // As bare as the migrated rows: nothing about a mandate, on an account that needs
        // one. Indistinguishable from a plain card-on-file, which is exactly why the
        // gateway and not our own columns has to be the source.
        .set({
          mandateReference: null,
          mandateRail: null,
          mandateStatus: null,
          mandateMaxAmountMinor: null,
          gatewayAccountId: strictAcct.id,
        })
        .where(eq(paymentMethods.id, barePm.id)),
    );

    const firstInv = await mandInvoice(1188n);
    const firstPay = await collectInvoice({
      organizationId: orgId,
      businessId: biz.id,
      invoice: await invoiceRow(firstInv.id),
      paymentMethodOverrideId: barePm.publicId,
    });
    ok(
      "#103: attempt 1 reaches the gateway and comes back `mandate_missing`",
      firstPay.status === "failed" && firstPay.failureCode === "mandate_missing",
      `${firstPay.status}/${firstPay.failureCode}`,
    );
    ok(
      "#103: …and the answer is REMEMBERED on the instrument",
      (await resumedRow(barePm.id)).mandateStatus === "missing",
      String((await resumedRow(barePm.id)).mandateStatus),
    );
    ok(
      "#103: …without branding it invalid — nothing was declined, it is un-authorised",
      (await resumedRow(barePm.id)).status === "valid",
    );

    const secondInv = await mandInvoice(1189n); // distinctive: the no-charge scan reads it
    const secondPay = await collectInvoice({
      organizationId: orgId,
      businessId: biz.id,
      invoice: await invoiceRow(secondInv.id),
      paymentMethodOverrideId: barePm.publicId,
    });
    ok(
      "#103: attempt 2 is refused BEFORE the gateway, on what attempt 1 learned",
      secondPay.status === "failed" && secondPay.failureCode === "mandate_missing",
      `${secondPay.status}/${secondPay.failureCode}`,
    );
    ok(
      "#103: …so no gateway charge was attempted for it, and nothing can strand",
      (
        await systemDb.select().from(tmtestCharges).where(eq(tmtestCharges.businessId, biz.id))
      ).every((c) => c.amountMinor !== 1189n),
    );
    ok(
      "#103: …and re-authorising clears it without anyone resetting the status",
      mandateMissingRefusal(
        { ...(await resumedRow(barePm.id)), mandateReference: "mandate_reauthorised" },
        { mandates: true, perDebitMandateReference: true },
      ) === null,
    );
  }

  // ── (2) multi-attempt: one intent, two attempts, attempt #1 preserved ───────
  const retryPm = await vaultPm("4000000000002008"); // retry card
  const retryInv = await mkInvoice(4400n);
  const retryPi = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    paymentMethodPublicId: retryPm.publicId,
    amountMinor: 4400,
    currency: "USD",
    invoicePublicId: retryInv.publicId,
  });
  ok(
    "C7+: retry-card intent is born authorized with a live attempt #1",
    retryPi.intent.status === "authorized" &&
      retryPi.attempt.status === "authorized" &&
      retryPi.intent.attemptCount === 1,
  );
  // Retrying a LIVE attempt would double-authorize the buyer.
  let liveRetry = "";
  try {
    await retryPaymentIntent(orgId, biz.id, retryPi.intent.publicId);
  } catch (e) {
    liveRetry = e instanceof PaymentIntentError ? "rejected" : "wrong-error";
  }
  ok("C7+: retry rejected while the latest attempt is not failed", liveRetry === "rejected");

  const firstConsume = await consumePaymentIntent(
    orgId,
    biz.id,
    retryPi.intent.publicId,
    retryInv.publicId,
  );
  ok(
    "C7+: a declined capture is DATA (retriable card_declined)",
    firstConsume?.charge?.status === "failed" &&
      firstConsume?.charge?.failure?.code === "card_declined" &&
      firstConsume?.charge?.failure?.retriable === true,
  );
  ok(
    "C7+: a declined capture releases the intent back to authorized",
    firstConsume?.intent.status === "authorized",
  );
  ok(
    "C7+: a declined capture fails attempt #1 with the normalized code",
    firstConsume?.attempt?.status === "failed" &&
      firstConsume?.attempt?.errorCode === "card_declined",
  );
  ok(
    "C7+: a declined capture does not settle the invoice",
    (await invoiceRow(retryInv.id)).status !== "paid",
  );
  ok(
    "C7+: a declined capture records a failure transaction",
    (await listTransactions(orgId, biz.id, { invoiceId: retryInv.id })).some(
      (t) => t.status === "failed" && t.errorCode === "card_declined",
    ),
  );

  const secondAttempt = await retryPaymentIntent(orgId, biz.id, retryPi.intent.publicId);
  ok(
    "C7+: retry mints attempt #2 → attempt_count = 2",
    secondAttempt?.attempt.attemptNumber === 2 && secondAttempt?.intent.attemptCount === 2,
  );
  const retryAttempts = await listAttemptsForIntent(orgId, biz.id, retryPi.intent.publicId);
  ok(
    "C7+: both attempts live on the timeline, oldest first",
    retryAttempts.length === 2 &&
      retryAttempts[0]!.attemptNumber === 1 &&
      retryAttempts[1]!.attemptNumber === 2,
  );
  ok(
    "C7+: attempt #1 is STILL failed (a retry never mutates the try before it)",
    retryAttempts[0]!.status === "failed" &&
      retryAttempts[0]!.errorCode === "card_declined" &&
      retryAttempts[0]!.publicId === firstConsume?.attempt?.publicId,
  );
  ok(
    "C7+: attempt #2 opens its own gateway intent",
    !!retryAttempts[1]!.idAtGateway &&
      retryAttempts[1]!.idAtGateway !== retryAttempts[0]!.idAtGateway,
  );
  ok(
    "C7+: the intent now points at attempt #2s gateway intent",
    secondAttempt?.intent.intentAtGateway === retryAttempts[1]!.idAtGateway,
  );
  const serialized = serializePaymentAttempt(retryAttempts[0]!);
  ok(
    "C7+: attempt serializer exposes attempt_number, error_code and trace_id",
    serialized.attempt_number === 1 &&
      serialized.error_code === "card_declined" &&
      !!serialized.trace_id,
  );

  // ── (3) void: a release, never a refund ────────────────────────────────────
  const voidPm = await vaultPm("4242424242424242");
  const voidInv = await mkInvoice(1500n);
  const voidPi = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    paymentMethodPublicId: voidPm.publicId,
    amountMinor: 1500,
    currency: "USD",
  });
  const voidCashBefore = await ledgerBalance(orgId, biz.id, "cash");
  const voidRes = await voidPaymentIntent(orgId, biz.id, voidPi.intent.publicId);
  ok(
    "C7+: void sets voided_at + status=voided",
    voidRes?.intent.status === "voided" && voidRes?.intent.voidedAt != null,
  );
  ok("C7+: void closes the attempt as voided", voidRes?.attempt?.status === "voided");
  ok("C7+: void moves no money", (await ledgerBalance(orgId, biz.id, "cash")) === voidCashBefore);
  ok(
    "C7+: void records a payment_reversal transaction",
    (await listTransactions(orgId, biz.id, { type: "payment_reversal" })).some(
      (t) => t.status === "succeeded",
    ),
  );
  ok(
    "C7+: payment_intent.voided emitted",
    (await eventsNaming("payment_intent_voided", voidPi.intent.publicId)).length === 1,
  );
  let consumeVoided = false;
  try {
    await consumePaymentIntent(orgId, biz.id, voidPi.intent.publicId, voidInv.publicId);
  } catch (e) {
    consumeVoided = e instanceof PaymentIntentError;
  }
  ok("C7+: a voided intent cannot be consumed", consumeVoided);
  let doubleVoid = false;
  try {
    await voidPaymentIntent(orgId, biz.id, voidPi.intent.publicId);
  } catch (e) {
    doubleVoid = e instanceof PaymentIntentError;
  }
  ok("C7+: voiding twice rejected", doubleVoid);
  // A consumed intent has nothing left to release.
  const donePm = await vaultPm("4242424242424242");
  const doneInv = await mkInvoice(1200n);
  const donePi = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    paymentMethodPublicId: donePm.publicId,
    amountMinor: 1200,
    currency: "USD",
  });
  const doneConsume = await consumePaymentIntent(
    orgId,
    biz.id,
    donePi.intent.publicId,
    doneInv.publicId,
  );
  ok(
    "C7+: a payment intent consumes into its invoice",
    doneConsume?.intent.status === "consumed" && (await invoiceRow(doneInv.id)).status === "paid",
  );
  let voidConsumed = false;
  try {
    await voidPaymentIntent(orgId, biz.id, donePi.intent.publicId);
  } catch (e) {
    voidConsumed = e instanceof PaymentIntentError;
  }
  ok("C7+: a consumed intent cannot be voided", voidConsumed);

  // A gateway with NO void must fail BY NAME — substituting a refund would post real
  // money movement for a payment that never settled. RazorPay reports intentVoid:false
  // and deliberately does not implement voidIntent; INR-only so it cannot also steal
  // the USD routing above.
  const rzAcct = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "razorpay",
    label: "RZP (no void)",
    credentials: { key_id: "rzp_test_x", key_secret: "s" },
    currencies: ["INR"],
  });
  const rzRow = (await getGatewayAccount(orgId, biz.id, rzAcct.publicId))!;
  const noVoidPi = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    paymentMethodPublicId: voidPm.publicId,
    amountMinor: 1700,
    currency: "USD",
  });
  // Re-point the intent at the void-less gateway; the refusal must happen before any
  // network call, purely off `capabilities.intentVoid`.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ gatewayAccountId: rzRow.id })
      .where(eq(paymentIntents.id, noVoidPi.intent.id)),
  );
  let unsupported = "";
  try {
    await voidPaymentIntent(orgId, biz.id, noVoidPi.intent.publicId);
  } catch (e) {
    unsupported = e instanceof PaymentIntentVoidUnsupportedError ? "named" : "wrong-error";
  }
  ok(
    "C7+: a gateway without void raises PaymentIntentVoidUnsupportedError (no refund fallback)",
    unsupported === "named",
  );
  const noVoidAfter = await getPaymentIntent(orgId, biz.id, noVoidPi.intent.publicId);
  ok(
    "C7+: the un-voidable intent is left untouched",
    noVoidAfter?.status === "authorized" && noVoidAfter?.voidedAt === null,
  );

  // ── (4) a RETURNED decline is persisted, not swallowed ─────────────────────
  // Adapters return declines instead of throwing (IntentRef.failure). This path
  // regressed once: the decline was persisted as a live `inited` attempt, which reads
  // as retriable forever while `retryPaymentIntent` refuses it. tmtest has no
  // create-time decline card, so the refusal is injected at the adapter boundary.
  const declinePm = await vaultPm("4242424242424242");
  const originalCreateIntent = TmtestProvider.prototype.createIntent;
  TmtestProvider.prototype.createIntent = async function (
    this: TmtestProvider,
    input: CreateIntentInput,
  ): Promise<IntentRef> {
    const ref = await originalCreateIntent.call(this, input);
    return {
      ...ref,
      status: "inited",
      failure: { code: "insufficient_funds", message: "Declined by issuer", retriable: true },
    };
  };
  let declined: Awaited<ReturnType<typeof createPaymentIntent>>;
  try {
    declined = await createPaymentIntent({
      organizationId: orgId,
      businessId: biz.id,
      paymentMethodPublicId: declinePm.publicId,
      amountMinor: 2500,
      currency: "USD",
    });
  } finally {
    TmtestProvider.prototype.createIntent = originalCreateIntent;
  }
  ok(
    "C7+: a returned decline persists the attempt as FAILED with the normalized code",
    declined.attempt.status === "failed" &&
      declined.attempt.errorCode === "insufficient_funds" &&
      declined.attempt.errorText === "Declined by issuer",
  );
  ok(
    "C7+: a returned decline leaves the INTENT open (inited), so it stays retriable",
    declined.intent.status === "inited",
  );
  ok("C7+: a returned decline still counts as attempt #1", declined.intent.attemptCount === 1);
  ok(
    "C7+: payment_intent.failed emitted for a create-time decline",
    (await eventsNaming("payment_intent_failed", declined.intent.publicId)).length === 1,
  );
  const declineRetry = await retryPaymentIntent(orgId, biz.id, declined.intent.publicId);
  ok(
    "C7+: the open-but-failed pairing is what makes a decline retriable",
    declineRetry?.attempt.attemptNumber === 2 && declineRetry?.attempt.status === "authorized",
  );

  // ── (5) trace correlation — the ONLY link to the request logs ──────────────
  // `payment_attempts.trace_id` ↔ `gateway_request_logs.trace_id`. That table is
  // platform-global with no RLS, so there is deliberately no FK: lose the trace id and
  // the dashboard's "View Request/Response Logs" has nothing to open.
  const tracedAttempts = await withTenant(orgId, (tx) =>
    tx.select().from(paymentAttempts).where(eq(paymentAttempts.businessId, biz.id)),
  );
  ok(
    "C7+: every attempt carries a trace id and a span id",
    tracedAttempts.length > 0 && tracedAttempts.every((a) => !!a.traceId && !!a.spanId),
  );
  ok(
    "C7+: each attempt gets its OWN span (a retry is a distinct unit)",
    new Set(retryAttempts.map((a) => a.spanId)).size === retryAttempts.length,
  );
  const attempt1Logs = await logsForSpan(retryAttempts[0]!.spanId!, 1);
  ok(
    "C7+: the attempts gateway calls land in gateway_request_logs under its span",
    attempt1Logs.length >= 1 &&
      attempt1Logs.every((l) => l.gatewayKey === "tmtest" && l.businessId === biz.id),
  );
  ok(
    "C7+: the create call is filed under the attempt that made it",
    attempt1Logs.some((l) => l.operation === "create_intent"),
  );
  // Two DIFFERENT gateway calls, one attempt, made in separate executions: the create and
  // the void that released it share the attempt's span — that is what makes the dashboard's
  // "View Request/Response Logs" show an attempt's whole conversation.
  const voidLogs = await logsForSpan(voidRes?.attempt?.spanId ?? "", 2);
  ok(
    "C7+: every call of one attempt shares its span (create + void)",
    voidLogs.some((l) => l.operation === "create_intent") &&
      voidLogs.some((l) => l.operation === "void_intent"),
  );
  const attempt2Logs = await logsForSpan(retryAttempts[1]!.spanId!, 1);
  ok(
    "C7+: attempt #2s calls are filed under attempt #2s span, not #1s",
    attempt2Logs.length >= 1 && !attempt2Logs.some((l) => attempt1Logs.some((p) => p.id === l.id)),
  );

  // ── (5a) an attempt keeps its caller's trace ───────────────────────────────
  // An attempt is a unit inside the request or job that made it, not an execution of
  // its own: the API request log's link to its gateway calls depends on this.
  {
    const apiTrace = newTraceId("api");
    const callerPm = await vaultPm("4242424242424242");
    const callerInv = await mkInvoice(4600n);
    const callerPi = await withTraceContext({ traceId: apiTrace }, () =>
      createPaymentIntent({
        organizationId: orgId,
        businessId: biz.id,
        paymentMethodPublicId: callerPm.publicId,
        amountMinor: 4600,
        currency: "USD",
        invoicePublicId: callerInv.publicId,
      }),
    );
    const callerAttempt = callerPi.attempt;
    ok(
      "span: an attempt made in a request carries the request's trace",
      callerAttempt?.traceId === apiTrace && !!callerAttempt.spanId,
      `${callerAttempt?.traceId}/${callerAttempt?.spanId}`,
    );
    const callerLogs = await logsForTrace(apiTrace, 1);
    ok(
      "span: …and its gateway calls are found from the request's trace",
      callerLogs.length >= 1 && callerLogs.every((l) => l.spanId === callerAttempt?.spanId),
    );
  }

  // ── (5b) one clock-tick trace, many collections: a span each ────────────────
  // A tick charges every due invoice under one `job-` trace. Each collection gets its own
  // span, so a transaction's "View request/response logs" shows its own calls only.
  {
    const spanPm = await vaultPm("4242424242424242");
    const spanInvs = [await mkInvoice(4510n), await mkInvoice(4520n)];
    const tickTrace = newTraceId("job");
    const spanPays = await withTraceContext({ traceId: tickTrace }, async () => {
      const out = [];
      for (const inv of spanInvs)
        out.push(
          await collectInvoice({
            organizationId: orgId,
            businessId: biz.id,
            invoice: await invoiceRow(inv.id),
            paymentMethodOverrideId: spanPm.publicId,
          }),
        );
      return out;
    });
    const spanTxns = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.traceId, tickTrace), eq(transactions.type, "payment"))),
    );
    const spans = spanTxns.map((t) => t.spanId);
    ok(
      "span: two collections in one trace get two different spans",
      spanTxns.length === 2 && spans.every(Boolean) && new Set(spans).size === 2,
      JSON.stringify(spans),
    );
    const tickLogs = await logsForTrace(tickTrace, 2);
    ok(
      "span: every gateway call of the tick carries one of those spans",
      tickLogs.length >= 2 && tickLogs.every((l) => spans.includes(l.spanId)),
      JSON.stringify(tickLogs.map((l) => [l.operation, l.spanId])),
    );
    ok(
      "span: each span names only its own charge",
      spans.every((sp) => {
        const own = tickLogs.filter((l) => l.spanId === sp);
        return own.length >= 1 && own.length < tickLogs.length;
      }),
    );

    // A payout sweep refunds many credit notes under one tick trace: a span per refund.
    const sweepTrace = newTraceId("job");
    await withTraceContext({ traceId: sweepTrace }, async () => {
      for (const p of spanPays)
        await refundPayment({
          organizationId: orgId,
          businessId: biz.id,
          paymentPublicId: p.publicId,
        });
    });
    const refundTxns = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.traceId, sweepTrace), eq(transactions.type, "refund"))),
    );
    const refundSpans = refundTxns.map((t) => t.spanId);
    const refundLogs = await logsForTrace(sweepTrace, 2);
    ok(
      "span: two refunds in one trace get two spans, each carrying its own gateway call",
      refundTxns.length === 2 &&
        new Set(refundSpans).size === 2 &&
        refundSpans.every((sp) => !!sp && refundLogs.some((l) => l.spanId === sp)),
      JSON.stringify({ refundSpans, logs: refundLogs.map((l) => [l.operation, l.spanId]) }),
    );
  }

  // ── (6) webhook-driven authorization ───────────────────────────────────────
  const hookPm = await vaultPm("4000000000003155"); // 3DS → the buyer must act
  const hookPi = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    paymentMethodPublicId: hookPm.publicId,
    amountMinor: 3300,
    currency: "USD",
  });
  ok(
    "C7+: 3DS intent waits on the buyer",
    hookPi.intent.status === "in_progress" && hookPi.attempt.status === "requires_action",
  );
  const rid = randomUUID().slice(0, 8);
  const hookOutcome = await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_intauth_${rid}`,
      type: "intent.authorized",
      providerIntentId: hookPi.intent.intentAtGateway!,
      occurredAt: new Date(),
      raw: { data: {} },
    },
    { businessId: biz.id },
  );
  ok(
    "C7+: intent.authorized correlated by providerIntentId → processed",
    hookOutcome === "processed",
  );
  const hookAfter = await getPaymentIntent(orgId, biz.id, hookPi.intent.publicId);
  const hookAttempts = await listAttemptsForIntent(orgId, biz.id, hookPi.intent.publicId);
  ok(
    "C7+: the callback drove the CURRENT attempt to authorized",
    hookAfter?.status === "authorized" &&
      hookAfter?.nextAction === null &&
      hookAttempts[0]!.status === "authorized",
  );

  // An intent id we don't know is a NO-OP: answering non-2xx would put the gateway
  // into an endless redelivery loop.
  const unknownOutcome = await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_intunk_${rid}`,
      type: "intent.authorized",
      providerIntentId: `tmpi_${rid}_not_ours`,
      occurredAt: new Date(),
      raw: { data: {} },
    },
    { businessId: biz.id },
  );
  ok("C7+: an unknown gateway intent id is ignored, never thrown", unknownOutcome === "ignored");

  // Stale news from attempt N-1 must not touch attempt N.
  const staleGatewayId = retryAttempts[0]!.idAtGateway!;
  const staleOutcome = await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_intstale_${rid}`,
      type: "intent.authorized",
      providerIntentId: staleGatewayId,
      occurredAt: new Date(),
      raw: { data: {} },
    },
    { businessId: biz.id },
  );
  const afterStale = await listAttemptsForIntent(orgId, biz.id, retryPi.intent.publicId);
  ok("C7+: a callback carrying a superseded gateway id is ignored", staleOutcome === "ignored");
  ok(
    "C7+: the stale callback left attempt #1 failed and attempt #2 untouched",
    afterStale[0]!.status === "failed" &&
      afterStale[1]!.status === retryAttempts[1]!.status &&
      afterStale[1]!.resourceVersion === retryAttempts[1]!.resourceVersion,
  );

  // A setup refusal confirmed in the buyer's browser: the reason arrives only on the
  // webhook, and it is what the attempt must keep.
  const refusedSetup = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    purpose: "setup",
    customerPublicId: setupCus.publicId,
    currency: "USD",
    gatewayAccountId: acctLite.publicId,
  });
  const refusedOutcome = await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_setupfail_${rid}`,
      type: "intent.setup_failed",
      providerIntentId: refusedSetup.intent.intentAtGateway!,
      failureCode: "incorrect_cvc",
      providerFailureCode: "invalid_cvc",
      failureMessage: "Your card's security code is invalid.",
      occurredAt: new Date(),
      raw: { data: {} },
    },
    { businessId: biz.id },
  );
  const [refusedAttempt] = await listAttemptsForIntent(orgId, biz.id, refusedSetup.intent.publicId);
  ok(
    `C7+: a setup refusal keeps the gateway's reason on the attempt [${refusedAttempt?.errorCode}]`,
    refusedOutcome === "processed" &&
      refusedAttempt?.status === "failed" &&
      refusedAttempt?.errorCode === "incorrect_cvc" &&
      refusedAttempt?.errorText === "Your card's security code is invalid.",
  );
  // …and the attempt can find that webhook: the list filters on the gateway intent id.
  const byIntent = await listGatewayWebhooksPage(orgId, biz.id, {
    filters: [{ field: "intent", op: "is", value: refusedSetup.intent.intentAtGateway! }],
  });
  ok(
    `C7+: the webhooks list filters to one gateway intent [${byIntent.data.map((w) => w.type)}]`,
    byIntent.data.length === 1 && byIntent.data[0]!.type === "intent.setup_failed",
  );
  const bareSetup = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    purpose: "setup",
    customerPublicId: setupCus.publicId,
    currency: "USD",
    gatewayAccountId: acctLite.publicId,
  });
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_setupbare_${rid}`,
      type: "intent.setup_failed",
      providerIntentId: bareSetup.intent.intentAtGateway!,
      occurredAt: new Date(),
      raw: { data: {} },
    },
    { businessId: biz.id },
  );
  const [bareAttempt] = await listAttemptsForIntent(orgId, biz.id, bareSetup.intent.publicId);
  ok(
    "C7+: a setup refusal with no reason still reads setup_failed",
    bareAttempt?.status === "failed" && bareAttempt?.errorCode === "setup_failed",
  );
}

// ── C8: inbound reconciliation + gateway-webhook log ──────────────────────────
{
  const orgId = org.organization.id;
  // provider_events is platform-global and NOT truncated between standalone runs,
  // so event ids + gateway charge ids must be unique per run.
  const rid = randomUUID().slice(0, 8);
  const inBiz = await createBusiness({
    organizationId: orgId,
    name: "Inbound Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: inBiz.id,
    email: "in@gw.test",
  });
  const prod = await createProduct({
    organizationId: orgId,
    businessId: inBiz.id,
    name: "In Plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: inBiz.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 6000,
    interval: "month",
  });

  // (a) charge.succeeded settlement of a timeout: an OPEN invoice + in_progress txn.
  const openCus = cus;
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: inBiz.id,
    customerId: openCus.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const billed = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: inBiz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  ok("C8: no-card invoice is payment_due (dunning)", billed.invoice.status === "payment_due");
  const timeoutTxn = await recordTransaction({
    organizationId: orgId,
    businessId: inBiz.id,
    customerId: openCus.id,
    type: "payment",
    status: "in_progress",
    amountMinor: 6000n,
    currency: "USD",
    gatewayKey: "tmtest",
    idAtGateway: `tmch_timeout_${rid}`,
    invoiceId: billed.invoice.id,
  });
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_ok_${rid}`,
      type: "charge.succeeded",
      providerChargeId: `tmch_timeout_${rid}`,
      occurredAt: new Date(),
      raw: { data: {} },
    },
    { businessId: inBiz.id, payload: { id: `tmev_ok_${rid}` } },
  );
  const settledInv = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, billed.invoice.id)).limit(1),
  );
  const settledTxn = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.id, timeoutTxn.id)).limit(1),
  );
  ok("C8: charge.succeeded settles the invoice → paid", settledInv[0]!.status === "paid");
  ok(
    "C8: charge.succeeded settles the transaction → succeeded",
    settledTxn[0]!.status === "succeeded",
  );

  // (b) late_failure reversal: a PAID invoice + successful payment reversed.
  const cus2 = await createCustomer({
    organizationId: orgId,
    businessId: inBiz.id,
    email: "in2@gw.test",
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: inBiz.id,
    customer: cus2,
    token: "tok_4242",
  });
  const sub2 = await createSubscription({
    organizationId: orgId,
    businessId: inBiz.id,
    customerId: cus2.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const paid = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: inBiz.id,
    subscription: sub2.subscription,
    periodStart: sub2.subscription.currentPeriodStart!,
    periodEnd: sub2.subscription.currentPeriodEnd!,
  });
  ok("C8: card invoice paid", paid.invoice.status === "paid");
  const payRow = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, paid.invoice.id)).limit(1),
    )
  )[0]!;
  const succTxn = await recordTransaction({
    organizationId: orgId,
    businessId: inBiz.id,
    customerId: cus2.id,
    type: "payment",
    status: "succeeded",
    amountMinor: 6000n,
    currency: "USD",
    gatewayKey: "tmtest",
    idAtGateway: `tmch_rev_${rid}`,
    invoiceId: paid.invoice.id,
    paymentId: payRow.id,
  });
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_rev_${rid}`,
      type: "charge.failed",
      providerChargeId: `tmch_rev_${rid}`,
      occurredAt: new Date(),
      raw: { data: { reversal: true } },
    },
    { businessId: inBiz.id, payload: { id: `tmev_rev_${rid}` } },
  );
  const reopened = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, paid.invoice.id)).limit(1),
    )
  )[0]!;
  const lateTxn = (
    await withTenant(orgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.id, succTxn.id)).limit(1),
    )
  )[0]!;
  ok(
    "C8: reversal reopens the invoice → payment_due",
    reopened.status === "payment_due" && reopened.nextAttemptAt !== null,
  );
  ok("C8: reversal → transaction late_failed", lateTxn.status === "late_failed");
  const evTypes = (await listEventsFiltered(orgId, { limit: 100 })).data.map((e) => e.type);
  ok("C8: transaction.late_failure emitted", evTypes.includes("transaction_late_failure"));
  ok("C8: invoice.payment_due emitted on reopen", evTypes.includes("invoice_payment_due"));

  // ── C8-OFF: the same reversal, on an OFFLINE (auto-collect-off) invoice ──────
  /**
   * `reconcileChargeFailed` is the third writer that calls `planFailureRearm`, and it was
   * the last one still missing the `send_invoice` action. It fell through to the `stopped`
   * else and wrote `not_paid` + `dunning_status: stopped` + `next_attempt_at: null` +
   * `attempt_count + 1` — four divergences from one unhandled case.
   *
   * An unpaid `auto_collection: off` invoice must read `payment_due` +
   * `dunning_status: in_progress` + `next_retry_at = due date + the first retry interval`
   * + no attempts — already honoured by `due.ts` and `invoicing/service.ts`. `not_paid`
   * is the collection-FAILED status and a send-invoice bill has failed no collection.
   *
   * The customer is flipped to `auto_collection: off` AFTER the invoice was paid, because
   * that is the only place the flag is read on this path (`isAutoCollectOn` at reversal
   * time) and it keeps the fixture to one lever. Behaviourally it is the reported shape:
   * an offline invoice settled by a manual collection, then reversed.
   */
  const offCus = await createCustomer({
    organizationId: orgId,
    businessId: inBiz.id,
    email: "in3@gw.test",
  });
  const offPm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: inBiz.id,
    customer: offCus,
    token: "tok_4242",
  });
  const offSub = await createSubscription({
    organizationId: orgId,
    businessId: inBiz.id,
    customerId: offCus.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: offPm.id,
  });
  const offPaid = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: inBiz.id,
    subscription: offSub.subscription,
    periodStart: offSub.subscription.currentPeriodStart!,
    periodEnd: offSub.subscription.currentPeriodEnd!,
  });
  ok(
    "C8-OFF: the offline fixture's invoice is paid to start with",
    offPaid.invoice.status === "paid",
  );
  const offAttemptsBefore = offPaid.invoice.attemptCount;
  await withTenant(orgId, (tx) =>
    tx.update(customers).set({ autoCollection: "off" }).where(eq(customers.id, offCus.id)),
  );
  const offPayRow = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, offPaid.invoice.id)).limit(1),
    )
  )[0]!;
  const offTxn = await recordTransaction({
    organizationId: orgId,
    businessId: inBiz.id,
    customerId: offCus.id,
    type: "payment",
    status: "succeeded",
    amountMinor: 6000n,
    currency: "USD",
    gatewayKey: "tmtest",
    idAtGateway: `tmch_revoff_${rid}`,
    invoiceId: offPaid.invoice.id,
    paymentId: offPayRow.id,
  });
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_revoff_${rid}`,
      type: "charge.failed",
      providerChargeId: `tmch_revoff_${rid}`,
      occurredAt: new Date(),
      raw: { data: { reversal: true } },
    },
    { businessId: inBiz.id, payload: { id: `tmev_revoff_${rid}` } },
  );
  const offReopened = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, offPaid.invoice.id)).limit(1),
    )
  )[0]!;
  ok(
    "C8-OFF: an offline invoice reopens to payment_due, NOT not_paid",
    offReopened.status === "payment_due",
  );
  ok(
    "C8-OFF: dunning_status is in_progress, NOT stopped (nobody halted anything)",
    offReopened.dunningStatus === "in_progress",
  );
  ok(
    "C8-OFF: the offline REMINDER schedule is re-armed, not destroyed",
    offReopened.nextAttemptAt !== null &&
      offReopened.nextAttemptAt.getTime() > offPaid.invoice.dueDate!.getTime(),
  );
  ok(
    "C8-OFF: attempt_count does not move (no attempts)",
    offReopened.attemptCount === offAttemptsBefore,
  );
  ok("C8-OFF: paid_at is cleared — the money really went back", offReopened.paidAt === null);
  ok(
    "C8-OFF: the transaction is a late_failed like any other reversal",
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(transactions).where(eq(transactions.id, offTxn.id)).limit(1),
      )
    )[0]!.status === "late_failed",
  );
  // The event must describe the transition the row actually took: an offline reopen is
  // `payment_due`, so announcing `invoice_not_paid` would be a lie downstream acts on
  // (it is what carries the customer's overdue mail).
  const offEvents = (await listEventsFiltered(orgId, { limit: 200 })).data.filter(
    (e) =>
      (e.data as { invoice?: { id?: string } } | null)?.invoice?.id === offPaid.invoice.publicId,
  );
  ok(
    "C8-OFF: invoice.payment_due announced on the reopen",
    offEvents.some((e) => e.type === "invoice_payment_due"),
  );
  ok(
    "C8-OFF: invoice.not_paid NOT announced",
    !offEvents.some((e) => e.type === "invoice_not_paid"),
  );

  // (c) dedup: replaying the same provider_event_id to the same business is a no-op.
  const dup = await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_rev_${rid}`,
      type: "charge.failed",
      providerChargeId: `tmch_rev_${rid}`,
      occurredAt: new Date(),
      raw: { data: { reversal: true } },
    },
    { businessId: inBiz.id },
  );
  ok("C8: replayed webhook is a duplicate", dup === "duplicate");

  // (d) inbound log/inspector: rows recorded with outcome + payload.
  const log = await listGatewayWebhooks(orgId, inBiz.id);
  ok("C8: gateway_webhooks log has entries", log.length >= 2);
  ok(
    "C8: log records outcome=processed",
    log.some((r) => r.outcome === "processed"),
  );
  ok(
    "C8: log records payload",
    log.some((r) => r.payload != null),
  );
}

// ── C9: test/live enforcement (TL-5 auto-provision, TL-6 livemode) ────────────
{
  const orgId = org.organization.id;
  // TL-5: a new TEST business auto-provisions an enabled TM Test Gateway.
  const autoTest = await createBusiness({
    organizationId: orgId,
    name: "Auto Test",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const autoAccts = await listGatewayAccounts(orgId, autoTest.id);
  ok(
    "C9: test business auto-provisions a tmtest gateway",
    autoAccts.some((a) => a.gatewayKey === "tmtest" && a.status === "active"),
  );
  ok(
    "C9: auto-provisioned tmtest account livemode=false",
    autoAccts.find((a) => a.gatewayKey === "tmtest")?.livemode === false,
  );

  // A LIVE business does NOT auto-provision tmtest.
  const autoLive = await createBusiness({
    organizationId: orgId,
    name: "Auto Live",
    defaultCurrency: "USD",
    livemode: "live",
  });
  const liveAccts = await listGatewayAccounts(orgId, autoLive.id);
  ok("C9: live business has no tmtest account", !liveAccts.some((a) => a.gatewayKey === "tmtest"));

  // TL-6: livemode of a manually-created account matches its business.
  const liveStripe = await createGatewayAccount({
    organizationId: orgId,
    businessId: autoLive.id,
    gatewayKey: "stripe",
    label: "Stripe",
    credentials: { secret_key: "sk" },
  });
  ok("C9: live business gateway account livemode=true", liveStripe.livemode === true);
  const testStripe = await createGatewayAccount({
    organizationId: orgId,
    businessId: autoTest.id,
    gatewayKey: "stripe",
    label: "Stripe Test",
    credentials: { secret_key: "sk_test" },
  });
  ok("C9: test business gateway account livemode=false", testStripe.livemode === false);

  // TL-6: tmtest cannot be configured on a live business.
  let blocked = false;
  try {
    await createGatewayAccount({
      organizationId: orgId,
      businessId: autoLive.id,
      gatewayKey: "tmtest",
      label: "x",
      credentials: {},
    });
  } catch {
    blocked = true;
  }
  ok("C9: tmtest blocked on live business", blocked);
}

// ── C10: business runs entirely on tmtest — every failure mode in the txn log ─
{
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Live-on-TM",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const tmAcct = (await listGatewayAccounts(orgId, biz.id)).find((a) => a.gatewayKey === "tmtest")!;
  ok("C10: business auto-runs on tmtest", !!tmAcct);

  const prod = await createProduct({ organizationId: orgId, businessId: biz.id, name: "TM Plan" });
  const mkPrice = (amt: number) =>
    createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: prod.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: amt,
      interval: "month",
    });

  const scenario = async (label: string, token: string, amount: number) => {
    const cus = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `${label}@tm.test`,
    });
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer: cus,
      token,
      gatewayAccountId: tmAcct.publicId,
    });
    const price = await mkPrice(amount);
    const sub = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: cus.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      defaultPaymentMethodId: pm.id,
    });
    const { invoice } = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: sub.subscription,
      periodStart: sub.subscription.currentPeriodStart!,
      periodEnd: sub.subscription.currentPeriodEnd!,
    });
    const txns = await listTransactions(orgId, biz.id, { customerId: cus.id });
    return { cus, invoice, txns, pm };
  };

  // (a) success
  const succ = await scenario("succ", "4242424242424242", 5000);
  ok(
    "C10: success → invoice paid + transaction success",
    succ.invoice.status === "paid" &&
      succ.txns.some((t) => t.status === "succeeded" && t.gatewayKey === "tmtest"),
  );

  // (b) insufficient_funds → dunning (open) + failure txn
  const insf = await scenario("insf", "4000000000009995", 5000);
  ok(
    "C10: insufficient_funds → invoice payment_due + failure txn",
    insf.invoice.status === "payment_due" &&
      insf.txns.some((t) => t.status === "failed" && t.errorCode === "insufficient_funds"),
  );

  // (c) timeout → pending/timeout txn; advance settles it
  const to = await scenario("timeout", "4000000000000077", 5000);
  // Split so a failure says WHICH half broke. The invoice is `payment_due`, not
  // `posted`: an unpaid invoice with no due date is due on issue (see
  // invoicing/status.ts) — same expectation as the insufficient_funds case above.
  ok(
    "C10: timeout → transaction parked as timeout",
    to.txns.some((t) => t.status === "timeout"),
  );
  ok("C10: timeout → invoice left payment_due", to.invoice.status === "payment_due");
  await advanceTmtest(orgId, new Date());
  const toInv = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, to.invoice.id)).limit(1),
    )
  )[0]!;
  const toTxns = await listTransactions(orgId, biz.id, { customerId: to.cus.id });
  ok(
    "C10: timeout settled by async webhook → paid + success",
    toInv.status === "paid" && toTxns.some((t) => t.status === "succeeded"),
  );

  // (d) needs_attention (amount …13)
  const na = await scenario("na", "4242424242424242", 5013);
  ok(
    "C10: needs_attention → transaction needs_attention",
    na.txns.some((t) => t.status === "needs_attention"),
  );

  // (e) late_failure → paid then reversed
  const lf = await scenario("late", "4000000000005126", 5000);
  ok(
    "C10: late_failure charge → invoice paid initially",
    lf.invoice.status === "paid" && lf.txns.some((t) => t.status === "succeeded"),
  );
  await advanceTmtest(orgId, new Date());
  const lfInv = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, lf.invoice.id)).limit(1),
    )
  )[0]!;
  const lfTxns = await listTransactions(orgId, biz.id, { customerId: lf.cus.id });
  ok(
    "C10: late_failure reversal → txn late_failed + invoice reopened",
    lfInv.status === "payment_due" && lfTxns.some((t) => t.status === "late_failed"),
  );

  // Refund path through tmtest (success + …13 failure).
  const refPm = succ.pm;
  void refPm;
  const payRow = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, succ.invoice.id)).limit(1),
    )
  )[0]!;
  const { refundPayment } = await import("@/modules/refunds/service");
  const refund = await refundPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: payRow.publicId,
    amountMinor: 2000,
  });
  ok(
    "C10: tmtest refund succeeds + refund txn",
    refund.status === "succeeded" &&
      (await listTransactions(orgId, biz.id, { type: "refund" })).some(
        (t) => t.status === "succeeded",
      ),
  );
}

// ── Review fixes (2026-07-03): pending-attempt money-consistency + idempotency ─
{
  const orgId = org.organization.id;
  const rBiz = await createBusiness({
    organizationId: orgId,
    name: "Reconcile Money Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: rBiz.id,
    gatewayKey: "tmtest",
    label: "TM-R",
    credentials: {},
  });
  const acctRow = (await getGatewayAccount(orgId, rBiz.id, acct.publicId))!;
  const tm = resolveAdapter(acctRow);
  const prod = await createProduct({ organizationId: orgId, businessId: rBiz.id, name: "R Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: rBiz.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 6000,
    interval: "month",
  });

  const vaultPm = async (cusId: string, token: string) => {
    const ref = await tm.vaultPaymentMethod({
      customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cusId}` },
      token,
    });
    return withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          organizationId: orgId,
          businessId: rBiz.id,
          customerId: cusId,
          publicId: publicId("pm"),
          providerKey: "tmtest",
          providerCustomerId: `tmcus_${cusId}`,
          providerPaymentMethodId: ref.providerPaymentMethodId,
          type: "card",
          last4: ref.display.last4,
          gatewayAccountId: acctRow.id,
        })
        .returning();
      return row!;
    });
  };
  const billTimeout = async (email: string) => {
    const cus = await createCustomer({ organizationId: orgId, businessId: rBiz.id, email });
    const pm = await vaultPm(cus.id, "4000000000000077"); // timeout card → pending outcome
    const sub = await createSubscription({
      organizationId: orgId,
      businessId: rBiz.id,
      customerId: cus.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      defaultPaymentMethodId: pm.id,
    });
    const billed = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: rBiz.id,
      subscription: sub.subscription,
      periodStart: sub.subscription.currentPeriodStart!,
      periodEnd: sub.subscription.currentPeriodEnd!,
    });
    const inv = (
      await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, billed.invoice.id)).limit(1),
      )
    )[0]!;
    return { cus, pm, inv };
  };

  // (1) timeout → parked: attempt slot consumed, nextAttemptAt cleared, no re-collect.
  const t1 = await billTimeout("r1@gw.test");
  const p1 = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, t1.inv.id)),
  );
  ok("park: timeout books ONE pending payment", p1.length === 1 && p1[0]!.status === "pending");
  ok(
    "park: attemptCount bumped + nextAttemptAt cleared",
    t1.inv.attemptCount === 1 && t1.inv.nextAttemptAt === null,
  );
  await runDunningPass(new Date());
  const p1b = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, t1.inv.id)),
  );
  ok("park: dunning pass does NOT re-collect a pending attempt", p1b.length === 1);
  const again = await collectInvoice({
    organizationId: orgId,
    businessId: rBiz.id,
    invoice: t1.inv,
  });
  ok("guard: collectInvoice returns the in-flight payment (no new charge)", again.id === p1[0]!.id);

  // (2) reconcile(succeeded) books the money.
  const txn1 = (
    await listTransactions(orgId, rBiz.id, { status: "timeout", invoiceId: t1.inv.id })
  )[0]!;
  const cashBefore = await ledgerBalance(orgId, rBiz.id, "cash");
  const arBefore = await ledgerBalance(orgId, rBiz.id, "accounts_receivable");
  await reconcileTransaction({
    organizationId: orgId,
    txnPublicId: txn1.publicId,
    outcome: "succeeded",
  });
  ok(
    "reconcile(succeeded) books cash (+6000)",
    (await ledgerBalance(orgId, rBiz.id, "cash")) === cashBefore + 6000n,
  );
  ok(
    "reconcile(succeeded) relieves AR (−6000)",
    (await ledgerBalance(orgId, rBiz.id, "accounts_receivable")) === arBefore - 6000n,
  );
  const inv1After = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, t1.inv.id)).limit(1),
    )
  )[0]!;
  const pay1After = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, t1.inv.id)).limit(1),
    )
  )[0]!;
  ok(
    "reconcile(succeeded) → invoice paid + payment succeeded",
    inv1After.status === "paid" && pay1After.status === "succeeded",
  );

  // (3) reconcile(failed) re-enters dunning; no money moves.
  const t2 = await billTimeout("r2@gw.test");
  const txn2 = (
    await listTransactions(orgId, rBiz.id, { status: "timeout", invoiceId: t2.inv.id })
  )[0]!;
  const cashBefore2 = await ledgerBalance(orgId, rBiz.id, "cash");
  await reconcileTransaction({
    organizationId: orgId,
    txnPublicId: txn2.publicId,
    outcome: "failed",
  });
  const inv2After = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, t2.inv.id)).limit(1),
    )
  )[0]!;
  const pay2After = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, t2.inv.id)).limit(1),
    )
  )[0]!;
  ok(
    "reconcile(failed) → payment failed, invoice payment_due with retry scheduled",
    pay2After.status === "failed" &&
      inv2After.status === "payment_due" &&
      inv2After.nextAttemptAt !== null,
  );
  ok(
    "reconcile(failed) moves no money",
    (await ledgerBalance(orgId, rBiz.id, "cash")) === cashBefore2,
  );

  // (4) tmtest honors idempotency keys: a replayed charge returns the SAME charge.
  const cus3 = await createCustomer({
    organizationId: orgId,
    businessId: rBiz.id,
    email: "r3@gw.test",
  });
  const pm3 = await vaultPm(cus3.id, "4242424242424242");
  const chargeInput = {
    amountMinor: 1000n,
    currency: "USD",
    customer: { providerKey: "tmtest" as const, providerCustomerId: `tmcus_${cus3.id}` },
    paymentMethod: {
      providerKey: "tmtest" as const,
      providerPaymentMethodId: pm3.providerPaymentMethodId,
      display: { type: "card" as const },
    },
    idempotencyKey: `idem_replay_${Date.now()}`,
  };
  const r1 = await tm.charge(chargeInput);
  const r2 = await tm.charge(chargeInput);
  ok(
    "tmtest: replayed idempotency key returns the same charge",
    r1.providerChargeId === r2.providerChargeId && r2.status === "succeeded",
  );

  // (5) disabled vaulting account is not charged (S6).
  const cus4 = await createCustomer({
    organizationId: orgId,
    businessId: rBiz.id,
    email: "r4@gw.test",
  });
  const pm4 = await vaultPm(cus4.id, "4242424242424242");
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: rBiz.id,
    gwaPublicId: acct.publicId,
    status: "disabled",
  });
  const sub4 = await createSubscription({
    organizationId: orgId,
    businessId: rBiz.id,
    customerId: cus4.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm4.id,
  });
  const billed4 = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: rBiz.id,
    subscription: sub4.subscription,
    periodStart: sub4.subscription.currentPeriodStart!,
    periodEnd: sub4.subscription.currentPeriodEnd!,
  });
  const pay4 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, billed4.invoice.id)).limit(1),
    )
  )[0]!;
  ok(
    "S6: disabled gateway account is NOT charged (retriable failure)",
    pay4.status === "failed" &&
      pay4.failureCode === "gateway_account_unavailable" &&
      billed4.invoice.status !== "paid",
  );
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: rBiz.id,
    gwaPublicId: acct.publicId,
    status: "active",
  });
}

// ── Warm-up (2026-07-03): retriable→dunning→RECOVERY e2e + refund-failure ──────
{
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Recovery Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const tmAcct = (await listGatewayAccounts(orgId, biz.id)).find((a) => a.gatewayKey === "tmtest")!;
  const prod = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Rec Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 7000,
    interval: "month",
  });

  // (1) retriable decline → dunning → recovery on the scheduled retry.
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "recover@tm.test",
  });
  const badPm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cus,
    token: "4000000000009995",
    gatewayAccountId: tmAcct.publicId,
  }); // insufficient_funds
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: cus.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: badPm.id,
  });
  const billed = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  const invAfterFail = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, billed.invoice.id)).limit(1),
    )
  )[0]!;
  ok(
    "warmup: retriable decline → invoice payment_due + retry scheduled",
    invAfterFail.status === "payment_due" && invAfterFail.nextAttemptAt !== null,
  );

  // Customer fixes their card; point the subscription at the good instrument.
  const goodPm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cus,
    token: "4242424242424242",
    gatewayAccountId: tmAcct.publicId,
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ defaultPaymentMethodId: goodPm.id })
      .where(eq(subscriptions.id, sub.subscription.id)),
  );
  // Dunning pass at the scheduled retry time → re-collects on the good card.
  const cashBefore = await ledgerBalance(orgId, biz.id, "cash");
  await runDunningPass(new Date(invAfterFail.nextAttemptAt!.getTime() + 60_000));
  const invRecovered = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, billed.invoice.id)).limit(1),
    )
  )[0]!;
  ok("warmup: dunning recovery → invoice paid", invRecovered.status === "paid");
  ok(
    "warmup: recovery books cash (+7000)",
    (await ledgerBalance(orgId, biz.id, "cash")) === cashBefore + 7000n,
  );

  // (2) refund FAILURE through the engine refundPayment (refund amount ending …13).
  const succCus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "refundfail@tm.test",
  });
  const succPm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: succCus,
    token: "4242424242424242",
    gatewayAccountId: tmAcct.publicId,
  });
  const priceR = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 6000,
    interval: "month",
  });
  const subR = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: succCus.id,
    now: new Date(),
    items: [{ price: priceR, quantity: 1 }],
    defaultPaymentMethodId: succPm.id,
  });
  const billedR = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: subR.subscription,
    periodStart: subR.subscription.currentPeriodStart!,
    periodEnd: subR.subscription.currentPeriodEnd!,
  });
  const payR = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(payments)
        .where(and(eq(payments.invoiceId, billedR.invoice.id), eq(payments.status, "succeeded")))
        .limit(1),
    )
  )[0]!;
  const { refundPayment, RefundError } = await import("@/modules/refunds/service");
  let refundThrew = false;
  try {
    await refundPayment({
      organizationId: orgId,
      businessId: biz.id,
      paymentPublicId: payR.publicId,
      amountMinor: 5013,
    }); // …13 → tmtest refund failure
  } catch (e) {
    refundThrew = e instanceof RefundError;
  }
  const refundFailTxn = (await listTransactions(orgId, biz.id, { type: "refund" })).some(
    (t) => t.status === "failed" && t.errorCode === "refund_failed",
  );
  ok(
    "warmup: …13 refund fails via engine refundPayment (+ failure txn)",
    refundThrew && refundFailTxn,
  );
}

// ── #42: a gateway condition we cannot RESOLVE answers 502, not 500 ──────────
// #32 made an adapter THROW when it cannot establish which authorization to void.
// Nothing wrapped that throw, so the operator's Void action answered "Internal server
// error" — a fault of ours, on a condition where nobody did anything wrong and the
// right move is to try again. Three things are proved here, over HTTP, on the real
// routes:
//   (a) the status and envelope (502 `gateway_error`, `retriable: true`), and that a
//       ProviderRefusalError on the SAME route still answers 400 — the mirror must not
//       collapse into one code,
//   (b) the intent is left OPEN, so the operator still has a way to finish the release,
//   (c) the Idempotency-Key survives REPLAYABLE: a 502 recorded as a completed request
//       would make the caller's retry replay a failure that never resolved, and the
//       operation could then never be completed under that key.
{
  const orgId = org.organization.id;
  const biz42 = await createBusiness({
    organizationId: orgId,
    name: "PI Indeterminate",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acct42Lite = (await listGatewayAccounts(orgId, biz42.id)).find(
    (a) => a.gatewayKey === "tmtest",
  )!;
  const acct42 = (await getGatewayAccount(orgId, biz42.id, acct42Lite.publicId))!;
  const tm42 = resolveAdapter(acct42);
  const cus42 = await createCustomer({
    organizationId: orgId,
    businessId: biz42.id,
    email: "indeterminate@gw.test",
  });
  const pm42 = await (async () => {
    const ref = await tm42.vaultPaymentMethod({
      customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cus42.publicId}` },
      token: "4000000000003155",
    });
    return withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          organizationId: orgId,
          businessId: biz42.id,
          customerId: cus42.id,
          publicId: publicId("pm"),
          providerKey: "tmtest",
          providerCustomerId: `tmcus_${cus42.publicId}`,
          providerPaymentMethodId: ref.providerPaymentMethodId,
          type: "card",
          last4: ref.display.last4,
          gatewayAccountId: acct42.id,
        })
        .returning();
      return row!;
    });
  })();
  /** An intent the gateway is holding — the only state the Void action applies to. */
  const authorizedIntent = async () => {
    const c = await createPaymentIntent({
      organizationId: orgId,
      businessId: biz42.id,
      paymentMethodPublicId: pm42.publicId,
      amountMinor: 4200,
      currency: "USD",
    });
    await authorizePaymentIntent(orgId, biz42.id, c.intent.publicId);
    return c.intent;
  };
  const errOf = (json: Record<string, unknown>) =>
    (json.error ?? {}) as { type?: string; message?: string; retriable?: boolean };
  const keyRows = async (key: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.organizationId, orgId), eq(idempotencyKeys.key, key))),
    );

  // The adapter is driven through its PROTOTYPE rather than a hand-written double, so
  // the request travels the real route, the real service and the real resolveAdapter
  // cache — only the one gateway call is replaced.
  const realVoid = TmtestProvider.prototype.voidIntent;
  const realCreate = TmtestProvider.prototype.createIntent;
  const INDETERMINATE =
    "tmtest void aborted: the authorization for this intent could not be resolved — " +
    "no void request was sent, and whether a hold is in place is unknown";

  // ── (1) the operator's Void action ─────────────────────────────────────────
  const pi42 = await authorizedIntent();
  TmtestProvider.prototype.voidIntent = async () => {
    throw new ProviderIndeterminateError(INDETERMINATE);
  };
  const voidKey = `pi42-void-${randomUUID()}`;
  const voided42 = await api(
    "POST",
    `/v1/businesses/${biz42.publicId}/payment_intents/${pi42.publicId}/void`,
    {},
    voidKey,
  );
  ok("#42: an unresolvable void answers 502, not 500", voided42.status === 502);
  ok(
    "#42: …with a gateway_error the caller is explicitly told to retry",
    errOf(voided42.json).type === "gateway_error" && errOf(voided42.json).retriable === true,
  );
  ok(
    "#42: …carrying the adapter's own sentence, which claims nothing about the money",
    String(errOf(voided42.json).message).includes("could not be resolved") &&
      !/hold (?:was|is) (?:not )?released/i.test(String(errOf(voided42.json).message)),
  );
  const stillOpen = await getPaymentIntent(orgId, biz42.id, pi42.publicId);
  ok(
    "#42: the intent is left OPEN, so the release can still be finished",
    stillOpen?.status === "authorized" && stillOpen?.voidedAt == null,
  );
  ok(
    "#42: a 502 leaves the Idempotency-Key REPLAYABLE (no terminal record)",
    (await keyRows(voidKey)).length === 0,
  );
  // …and replayable means it really re-executes, not that it replays the failure.
  TmtestProvider.prototype.voidIntent = realVoid;
  const retried42 = await api(
    "POST",
    `/v1/businesses/${biz42.publicId}/payment_intents/${pi42.publicId}/void`,
    {},
    voidKey,
  );
  ok(
    "#42: the SAME key retried after the 502 executes for real → 200 voided",
    retried42.status === 200 && retried42.json.status === "voided",
  );

  // ── (2) the mirror, on a route that already mapped ProviderRefusalError ────
  const createIntentOverHttp = () =>
    api("POST", `/v1/businesses/${biz42.publicId}/payment_intents`, {
      purpose: "payment",
      payment_method: pm42.publicId,
      amount_minor: 4200,
      currency: "USD",
    });
  TmtestProvider.prototype.createIntent = async () => {
    throw new ProviderRefusalError("tmtest will not take this combination — change the request");
  };
  const refused42 = await createIntentOverHttp();
  ok(
    "#42: a provider REFUSAL on the create route still answers 400",
    refused42.status === 400 && errOf(refused42.json).type === "invalid_request_error",
  );
  TmtestProvider.prototype.createIntent = async () => {
    throw new ProviderIndeterminateError(INDETERMINATE);
  };
  const indet42 = await createIntentOverHttp();
  ok(
    "#42: an INDETERMINATE result on the SAME route answers 502",
    indet42.status === 502 && errOf(indet42.json).type === "gateway_error",
  );

  // ── (3) the retry route maps it too (it mints attempt N+1 at the gateway) ──
  // Retry needs a FAILED attempt to retry, so the fixture is the suite's retry card:
  // born authorized, declined on consume, which leaves attempt #1 `failed` and the
  // intent back to `authorized`.
  TmtestProvider.prototype.createIntent = realCreate;
  const retryPm42 = await (async () => {
    const ref = await tm42.vaultPaymentMethod({
      customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cus42.publicId}` },
      token: "4000000000002008",
    });
    return withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          organizationId: orgId,
          businessId: biz42.id,
          customerId: cus42.id,
          publicId: publicId("pm"),
          providerKey: "tmtest",
          providerCustomerId: `tmcus_${cus42.publicId}`,
          providerPaymentMethodId: ref.providerPaymentMethodId,
          type: "card",
          last4: ref.display.last4,
          gatewayAccountId: acct42.id,
        })
        .returning();
      return row!;
    });
  })();
  const retryInv42 = (
    await createInvoiceFromLines({
      organizationId: orgId,
      businessId: biz42.id,
      customerId: cus42.id,
      currency: "USD",
      lines: [{ description: "Indeterminate retry target", amountMinor: 4400n }],
      collect: false,
    })
  ).invoice;
  const retryTarget = (
    await createPaymentIntent({
      organizationId: orgId,
      businessId: biz42.id,
      paymentMethodPublicId: retryPm42.publicId,
      amountMinor: 4400,
      currency: "USD",
      invoicePublicId: retryInv42.publicId,
    })
  ).intent;
  const declined42 = await consumePaymentIntent(
    orgId,
    biz42.id,
    retryTarget.publicId,
    retryInv42.publicId,
  );
  ok(
    "#42: (fixture) the retry target has a FAILED attempt to retry",
    declined42?.attempt?.status === "failed",
  );
  TmtestProvider.prototype.createIntent = async () => {
    throw new ProviderIndeterminateError(INDETERMINATE);
  };
  const retryKey = `pi42-retry-${randomUUID()}`;
  const retryRoute = await api(
    "POST",
    `/v1/businesses/${biz42.publicId}/payment_intents/${retryTarget.publicId}/retry`,
    {},
    retryKey,
  );
  ok(
    "#42: the retry route answers 502 rather than 500",
    retryRoute.status === 502 && errOf(retryRoute.json).type === "gateway_error",
  );

  /**
   * ⚠ MEASURED, and it is the OPPOSITE of the void route — deliberately, and worth
   * knowing before anyone relies on "a 502 is always replayable".
   *
   * `idempotencyOnSend` decides from the ROW's status, never from the status code: a
   * non-2xx that wrote nothing durable frees the key (the void case above), and one that
   * DID write goes terminal `failed` and is never re-executed. `retryPaymentIntent`
   * records the failed attempt N+1 before rethrowing — on purpose, so the timeline does
   * not lose a real gateway interaction — so this request HAS side effects and its key is
   * spent. The caller's retry replays the stored 502 even once the gateway is healthy;
   * only a NEW key gets through.
   *
   * That is the machinery working as designed rather than a defect of #42's, and it is
   * asserted here so that if anyone changes either half the consequence is visible.
   */
  const retryKeyRow = (await keyRows(retryKey))[0];
  ok(
    "#42: (measured) a 502 AFTER a durable write is terminal, not replayable",
    retryKeyRow?.status === "failed" && retryKeyRow?.responseStatus === 502,
  );
  TmtestProvider.prototype.createIntent = realCreate;
  const retryReplay = await api(
    "POST",
    `/v1/businesses/${biz42.publicId}/payment_intents/${retryTarget.publicId}/retry`,
    {},
    retryKey,
  );
  ok(
    "#42: (measured) …the same key replays the stored 502 though the gateway is healthy",
    retryReplay.status === 502,
  );
  const retryFreshKey = await api(
    "POST",
    `/v1/businesses/${biz42.publicId}/payment_intents/${retryTarget.publicId}/retry`,
    {},
  );
  ok(
    "#42: (measured) …while a NEW key gets through, so the operation is not stranded",
    retryFreshKey.status === 200 || retryFreshKey.status === 201,
  );
}

await app.close();

// ── ATTEMPTED-AMOUNT: a refused charge records what was ASKED FOR, not the total ──
/**
 * `recordFailedPayment` stored `invoice.totalMinor` until 2026-09-03, so every refused
 * attempt on an invoice whose OUTSTANDING was smaller than its total booked a number
 * nobody ever asked a gateway for. Measured on two real rows: ₹41,816.84 recorded where
 * ₹31,057.60 was owed, ₹10,041.95 where ₹2,070.50 was owed — the overstatement equal to
 * the credit applied each time. 3,025 rows database-wide disagreed with the `transactions`
 * row written for the SAME attempt, which always carried `due`.
 *
 * It reaches the payer: this function emits `payment_failed` with the row's amount,
 * `emailTypeForEvent` maps every one of those to the customer's mail unconditionally, and
 * the template prints it.
 *
 * The fixture reduces the outstanding with PARTIAL CASH rather than a credit note, which
 * is the more general statement of the bug — `invoiceOutstanding` subtracts cash and
 * credit alike, so anything that lowers the balance was overstated, not just credit. The
 * refusal is the no-saved-card path: synchronous, no gateway involved, and it shares the
 * same `due` as every other refusal in `collectClaimedInvoice`.
 */
{
  const cardless = await createCustomer({
    organizationId: org.organization.id,
    businessId: testBiz.id,
    email: `attempted-amount-${randomUUID()}@gw.test`,
  });
  const raised = (
    await createInvoiceFromLines({
      organizationId: org.organization.id,
      businessId: testBiz.id,
      customerId: cardless.id,
      currency: "USD",
      lines: [{ description: "Attempted amount", amountMinor: 10_000n }],
      collect: false,
    })
  ).invoice;
  // Part-paid in cash: total 100.00, outstanding 60.00.
  await recordOfflinePayment({
    organizationId: org.organization.id,
    businessId: testBiz.id,
    invoicePublicId: raised.publicId,
    amountMinor: 4_000,
    method: "cash",
  });
  const refused = await collectInvoice({
    organizationId: org.organization.id,
    businessId: testBiz.id,
    invoice: raised,
  });
  ok(
    "ATTEMPTED-AMOUNT: a refused charge books the OUTSTANDING, not the invoice total",
    refused.amountMinor === 6_000n,
    `booked ${refused.amountMinor} (total 10000, outstanding 6000)`,
  );
  /**
   * And no gateway money-log row is invented for it. This refusal never reached a provider
   * — there was no instrument to reach one with — so `transactions`, which is the record of
   * what the RAILS did, must stay empty for it. Written after the first draft asserted the
   * opposite (that the two rows agree) and went red for this reason rather than the one
   * under test: on the paths that DO reach a gateway the two amounts now agree because both
   * read `due`, and the database-wide version of that check belongs in `verify:invariants`,
   * not here.
   */
  const [txnForPay] = await withTenant(org.organization.id, (tx) =>
    tx.select().from(transactions).where(eq(transactions.paymentId, refused.id)).limit(1),
  );
  ok(
    "ATTEMPTED-AMOUNT: …and no gateway transaction is invented for a charge never sent",
    txnForPay === undefined,
    txnForPay ? `found ${txnForPay.publicId}` : "none",
  );
}

// ── FINALISED-AT: a terminal transaction records WHEN it finished ─────────────
/**
 * The detail page renders its terminal timeline entry as `Settled` for a success and
 * `Finalised` for anything else — and the second was UNREACHABLE. It keyed off
 * `settled_at`, which means cash moved: measured 2026-09-03, 0 of 6,428 `failure` rows
 * carried one, nor did any of the 217 `late_failure` or 7 `voided` rows. So 6,659 finished
 * transactions showed a timeline that stops at "Created" and read as still in flight.
 *
 * `finalised_at` (migration 0230) answers the question `settled_at` cannot. The two
 * RECONCILABLE statuses are excluded on purpose: a human is still expected to resolve them,
 * so the row is not finished and must not claim to be.
 */
{
  const finCus = await createCustomer({
    organizationId: org.organization.id,
    businessId: testBiz.id,
    email: `finalised-${randomUUID()}@gw.test`,
  });
  /**
   * Recorded ALREADY terminal, never transitioned — the shape a synchronous refusal takes.
   * The first cut of `finalised_at` set it only in `setTransactionStatus`, so every
   * pre-flight refusal (`mandate_ceiling_exceeded`, `no_payment_method`) kept a null and
   * the timeline entry stayed unreachable for the commonest decline of all. Missed because
   * the assertions below all transition; caught by driving a real refusal through the
   * dashboard. This is the one that would have caught it.
   */
  const mkBornTerminal = async (status: TransactionStatus) => {
    const t = await recordTransaction({
      organizationId: org.organization.id,
      businessId: testBiz.id,
      customerId: finCus.id,
      type: "payment",
      status,
      amountMinor: 1_000n,
      currency: "USD",
      idAtGateway: `born_${randomUUID().slice(0, 8)}`,
    });
    const [row] = await withTenant(org.organization.id, (tx) =>
      tx.select().from(transactions).where(eq(transactions.id, t.id)).limit(1),
    );
    return row!;
  };

  const mkTxn = async (status: TransactionStatus) => {
    const t = await recordTransaction({
      organizationId: org.organization.id,
      businessId: testBiz.id,
      customerId: finCus.id,
      type: "payment",
      status: "in_progress",
      amountMinor: 1_000n,
      currency: "USD",
      idAtGateway: `fin_${randomUUID().slice(0, 8)}`,
    });
    await withTenant(org.organization.id, (tx) =>
      setTransactionStatus(tx, org.organization.id, t.id, status),
    );
    const [row] = await withTenant(org.organization.id, (tx) =>
      tx.select().from(transactions).where(eq(transactions.id, t.id)).limit(1),
    );
    return row!;
  };

  for (const status of ["failed", "voided", "late_failed"] as const) {
    const born = await mkBornTerminal(status);
    ok(
      `FINALISED-AT: a ${status} transaction recorded ALREADY terminal records it too`,
      born.finalisedAt !== null,
      `finalised_at=${born.finalisedAt ?? "null"}`,
    );
    const row = await mkTxn(status);
    ok(
      `FINALISED-AT: a ${status} transaction records when it finished`,
      row.finalisedAt !== null,
      `finalised_at=${row.finalisedAt ?? "null"} settled_at=${row.settledAt ?? "null"}`,
    );
  }
  // …and the money column is untouched by any of it: `settled_at` still means cash moved.
  const failed = await mkTxn("failed");
  ok(
    "FINALISED-AT: …without pretending a failure settled money",
    failed.settledAt === null,
    String(failed.settledAt),
  );
  // The two the operator can still act on are NOT finished.
  for (const status of ["needs_attention", "timeout"] as const) {
    const row = await mkTxn(status);
    ok(
      `FINALISED-AT: a ${status} transaction is NOT marked finished`,
      row.finalisedAt === null,
      `finalised_at=${row.finalisedAt ?? "null"}`,
    );
  }
}

// ── #17: a late `intent.authorized` for money that has ALREADY come back ──────
/**
 * Measured 2026-09-03 on INV-7824 (docs/PROGRESS.md #17). RazorPay delivered one
 * payment's webhooks out of order — their own event ids carry their creation time and
 * prove it: `payment.authorized_1788436855` (the EARLIEST) arrived 21 minutes after
 * `payment.captured_1788437757` and `refund.processed_1788437764`. So the FIRST thing
 * that happened reached us LAST, six minutes after we had captured AND refunded that
 * charge ourselves (`rfnd_TXYouJ9STeNwgr`).
 *
 * Three things then went wrong, and this section holds one assertion for each:
 *  (A) the staleness guard read only the INTENT's own status, so the late event
 *      authorized an intent whose money was already back and raised a
 *      `needs_attention` claiming "the gateway holds 2218400 INR" — it holds nothing;
 *  (B) that false alarm renders the operator Reconcile panel with `succeeded`
 *      PRE-SELECTED, and confirming it books phantom cash plus a customer credit
 *      (`cash` debit / `excess_payment_balance` credit) through an append-only ledger;
 *  (C) the row carried no `id_at_gateway`, so a human could not link it to the refund
 *      row sitting six minutes above it in the same list.
 *
 * The true case is asserted alongside each: money REALLY held must still raise the row,
 * and a charge with no refund against it must still be confirmable.
 */
{
  const orgId = org.organization.id;
  const rid = randomUUID().slice(0, 8);
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Late Auth 17",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acctLite = (await listGatewayAccounts(orgId, biz.id)).find(
    (a) => a.gatewayKey === "tmtest",
  )!;
  const acctRow = (await getGatewayAccount(orgId, biz.id, acctLite.publicId))!;
  const tm = resolveAdapter(acctRow);
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `late17_${rid}@gw.test`,
  });
  // 3DS: the intent stays `in_progress`/`requires_action`, which is the shape the defect
  // needs — the buyer's browser never posted the second leg, so nothing local tied the
  // intent to the payment it produced.
  const pm3ds = await (async () => {
    const ref = await tm.vaultPaymentMethod({
      customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cus.publicId}` },
      token: "4000000000003155",
    });
    return withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: cus.id,
          publicId: publicId("pm"),
          providerKey: "tmtest",
          providerCustomerId: `tmcus_${cus.publicId}`,
          providerPaymentMethodId: ref.providerPaymentMethodId,
          type: "card",
          last4: ref.display.last4,
          gatewayAccountId: acctRow.id,
        })
        .returning();
      return row!;
    });
  })();

  const mkInvoice = async (amountMinor: bigint) =>
    (
      await createInvoiceFromLines({
        organizationId: orgId,
        businessId: biz.id,
        customerId: cus.id,
        currency: "USD",
        lines: [{ description: "Late-auth target", amountMinor }],
        collect: false,
      })
    ).invoice;
  /**
   * An intent against an invoice that is then settled by OTHER money — the real shape:
   * INV-7824 was `paid` with `amount_due_minor = 0` while an intent for 2218400 was
   * still open against it, so `invoiceOutstanding` reads 0 and the authorization is
   * unappliable. The intent is created BEFORE the invoice closes, because that is the
   * order it happened in (and because a paid invoice refuses a new intent).
   */
  const openIntentOnSettledInvoice = async (amountMinor: bigint) => {
    const inv = await mkInvoice(amountMinor);
    const pi = await createPaymentIntent({
      organizationId: orgId,
      businessId: biz.id,
      paymentMethodPublicId: pm3ds.publicId,
      amountMinor: Number(amountMinor),
      currency: "USD",
      invoicePublicId: inv.publicId,
    });
    await recordOfflinePayment({
      organizationId: orgId,
      businessId: biz.id,
      invoicePublicId: inv.publicId,
      method: "wire",
    });
    return { inv, pi };
  };
  /**
   * The capture-and-refund that happened out of band, written directly because that is
   * exactly what the engine has to read: a succeeded `payments` row carrying the
   * gateway's charge id and a succeeded `refunds` row against it. Going through the
   * refund SERVICE would need a live gateway charge to refund and would post its own
   * ledger entries, which the (B) assertions measure.
   */
  const returnedCharge = async (chargeId: string, amountMinor: bigint) =>
    withTenant(orgId, async (tx) => {
      const [pay] = await tx
        .insert(payments)
        .values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: cus.id,
          // NULL, like the real row: refunding detached it from the invoice
          // (`markUnapplied`), which is why the refund transaction renders Invoice "—".
          invoiceId: null,
          publicId: publicId("pay"),
          status: "succeeded",
          amountMinor,
          currency: "USD",
          providerKey: "tmtest",
          providerChargeId: chargeId,
        })
        .returning();
      await tx.insert(refunds).values({
        organizationId: orgId,
        businessId: biz.id,
        paymentId: pay!.id,
        publicId: publicId("re"),
        status: "succeeded",
        amountMinor,
        currency: "USD",
        providerKey: "tmtest",
        providerRefundId: `tmrf_${chargeId}`,
      });
      return pay!;
    });
  const intentRow = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(paymentIntents).where(eq(paymentIntents.id, id)).limit(1),
      )
    )[0]!;
  const unappliableFor = async (invoiceId: string) =>
    (await listTransactions(orgId, biz.id, { invoiceId })).filter(
      (t) => t.type === "authorization" && t.errorCode === "authorization_unappliable",
    );
  /**
   * THE GATEWAY CANNOT RELEASE THIS HOLD — the state RazorPay is permanently in.
   *
   * `capabilities.intentVoid: false` there: an authorized RazorPay payment is either
   * captured or left to lapse, and ours had already been captured AND refunded. tmtest
   * can void, so without this the suite would prove nothing — it would release the hold
   * and never reach the `needs_attention` branch the defect lives on. Removing the
   * gateway's own intent row is the only lever that expresses "there is no releasable
   * hold behind this order": `voidIntentCharge` answers `not_found`, `voidIntent` returns
   * `voided: false`, and `voidPaymentIntent` fails by name exactly as it does on RazorPay.
   *
   * ⚠ It must be removed, not flipped to `succeeded`: `authorizePaymentIntent` calls
   * `TmtestProvider.resolveChallenge(id, true)` on its way through, which sets any intent
   * row it FINDS back to `authorized` — measured here, it silently undid the flip and the
   * void then succeeded (a green that meant nothing).
   */
  const noReleasableHold = async (intentAtGateway: string) => {
    const gone = await systemDb
      .delete(tmtestCharges)
      .where(eq(tmtestCharges.chargeId, intentAtGateway))
      .returning();
    ok(
      "#17-FIXTURE: the gateway has no releasable hold behind the order",
      gone.length === 1,
      `gw=${intentAtGateway} removed=${gone.length}`,
    );
  };

  // ── (A) the late delivery must not treat a returned charge as a live hold ────
  const a = await openIntentOnSettledInvoice(2_218_400n);
  const chargeA = `tmch_returned_${rid}`;
  await returnedCharge(chargeA, 2_218_400n);
  await noReleasableHold(a.pi.intent.intentAtGateway!);
  const outcomeA = await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_late17_a_${rid}`,
      type: "intent.authorized",
      providerIntentId: a.pi.intent.intentAtGateway!,
      // RazorPay's `payment.authorized` names the PAYMENT as well as the order —
      // measured on the real event: `providerChargeId: pay_XXXXXXXXXXXX05`. That id is
      // the only identifier every side of this carries, and the whole fix hangs on it.
      providerChargeId: chargeA,
      occurredAt: new Date(),
      raw: { data: {} },
    },
    { businessId: biz.id },
  );
  const afterA = await intentRow(a.pi.intent.id);
  ok(
    "#17-A: a late authorization for an already-refunded charge is not an error (no redelivery loop)",
    outcomeA !== "error",
    `outcome=${outcomeA}`,
  );
  ok(
    "#17-A: …and does NOT leave the intent authorized (releaseHoldBeforeExpiry would chase a refunded hold)",
    afterA.status !== "authorized",
    `status=${afterA.status}`,
  );
  ok(
    "#17-A: …and raises NO needs_attention authorization for money that is already back",
    (await unappliableFor(a.inv.id)).length === 0,
    `rows=${(await unappliableFor(a.inv.id)).map((t) => `${t.publicId}:${t.errorText}`).join(" | ")}`,
  );

  // ── (C) money REALLY held still raises the row — and now names the charge ────
  /**
   * The gateway auto-captured and cannot void (RazorPay's `intentVoid: false`), so the
   * void tmtest would otherwise perform fails and the only correct action left is to
   * make the money impossible to miss. Flipping the tmtest charge to `succeeded` is how
   * `voidIntentCharge` reports `captured` — the same refusal, reached honestly.
   */
  const c = await openIntentOnSettledInvoice(4_321n);
  const chargeC = `tmch_held_${rid}`;
  await noReleasableHold(c.pi.intent.intentAtGateway!);
  const outcomeC = await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_late17_c_${rid}`,
      type: "intent.authorized",
      providerIntentId: c.pi.intent.intentAtGateway!,
      providerChargeId: chargeC, // no payment, no refund: this money is genuinely out there
      occurredAt: new Date(),
      raw: { data: {} },
    },
    { businessId: biz.id },
  );
  const heldRows = await unappliableFor(c.inv.id);
  ok(
    "#17-C: a genuine late authorization with money really held STILL raises needs_attention",
    outcomeC === "processed" && heldRows.length === 1 && heldRows[0]!.status === "needs_attention",
    `outcome=${outcomeC} rows=${heldRows.length}`,
  );
  ok(
    "#17-C: …and the row names the gateway charge it is written about (it rendered Gateway '—')",
    heldRows[0]?.idAtGateway === chargeC,
    `id_at_gateway=${heldRows[0]?.idAtGateway ?? "null"}`,
  );
  ok(
    "#17-C: …and its sentence still claims a HOLD, because there is one",
    (heldRows[0]?.errorText ?? "").includes("holds"),
    heldRows[0]?.errorText ?? "no row",
  );

  // ── (B) the brake: `succeeded` is REFUSED where the money has come back ──────
  const mkNeedsAttention = async (fields: {
    idAtGateway?: string | null;
    invoiceId?: string | null;
    amountMinor: bigint;
  }) => {
    const t = await recordTransaction({
      organizationId: orgId,
      businessId: biz.id,
      customerId: cus.id,
      type: "authorization",
      status: "needs_attention",
      amountMinor: fields.amountMinor,
      currency: "USD",
      idAtGateway: fields.idAtGateway ?? null,
      invoiceId: fields.invoiceId ?? null,
      errorCode: "authorization_unappliable",
      errorText: "fixture",
      retriable: false,
    });
    return t;
  };
  const refuses = async (txnPublicId: string) => {
    try {
      await reconcileTransaction({ organizationId: orgId, txnPublicId, outcome: "succeeded" });
      return null;
    } catch (e) {
      return e instanceof TransactionError ? (e as Error).message : `WRONG ERROR: ${String(e)}`;
    }
  };
  const txnRow = async (publicIdValue: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(transactions).where(eq(transactions.publicId, publicIdValue)).limit(1),
      )
    )[0]!;

  // (B1) the post-fix shape: the row carries the charge id.
  const chargeB = `tmch_returned_b_${rid}`;
  await returnedCharge(chargeB, 9_900n);
  const bRow = await mkNeedsAttention({ idAtGateway: chargeB, amountMinor: 9_900n });
  const cashBefore = await ledgerBalance(orgId, biz.id, "cash");
  const excessBefore = await ledgerBalance(orgId, biz.id, "excess_payment_balance");
  const refusalB = await refuses(bRow.publicId);
  ok(
    "#17-B1: confirming `succeeded` on a row whose charge has a settled refund is REFUSED",
    refusalB != null && !refusalB.startsWith("WRONG ERROR"),
    refusalB ?? "the verdict was ACCEPTED — it would have booked phantom cash",
  );
  ok(
    "#17-B1: …and the refusal names the refund the operator can check at the gateway",
    (refusalB ?? "").includes(`tmrf_${chargeB}`),
    refusalB ?? "accepted",
  );
  ok(
    "#17-B1: …and posts NO ledger entries (the actual harm: append-only phantom cash + credit)",
    (await ledgerBalance(orgId, biz.id, "cash")) === cashBefore &&
      (await ledgerBalance(orgId, biz.id, "excess_payment_balance")) === excessBefore,
    `cash ${cashBefore}→${await ledgerBalance(orgId, biz.id, "cash")} excess ${excessBefore}→${await ledgerBalance(orgId, biz.id, "excess_payment_balance")}`,
  );
  ok(
    "#17-B1: …and leaves the row reconcilable rather than half-settled",
    (await txnRow(bRow.publicId)).status === "needs_attention",
    (await txnRow(bRow.publicId)).status,
  );

  /**
   * (B2) THE EXISTING ROW's shape. `txn_XXXXXXXXXXXXXXXXXXXXXX02` was minted before the
   * fix above: `id_at_gateway`, `payment_intent_id` and `payment_id` are all NULL and the
   * only link it carries is the invoice. Measured on that row 2026-09-03. So the guard
   * needs a path that does not depend on the row naming its charge: the intent for that
   * invoice names the gateway ORDER, and the callbacks we already persisted name the
   * order and the charge together (`provider_events.normalized`).
   */
  const d = await openIntentOnSettledInvoice(7_777n);
  const chargeD = `tmch_returned_d_${rid}`;
  await returnedCharge(chargeD, 7_777n);
  await systemDb.insert(providerEvents).values({
    providerKey: "tmtest",
    providerEventId: `tmev_late17_d_capture_${rid}`,
    type: "charge.succeeded",
    businessId: biz.id,
    outcome: "processed",
    // The row RazorPay's `payment.captured` left behind: ONE delivery naming both the
    // order and the payment (measured: order_XXXXXXXXXXXX04 + pay_XXXXXXXXXXXX05).
    normalized: {
      type: "charge.succeeded",
      providerIntentId: d.pi.intent.intentAtGateway,
      providerChargeId: chargeD,
    },
  });
  const legacyRow = await mkNeedsAttention({
    idAtGateway: null,
    invoiceId: d.inv.id,
    amountMinor: 7_777n,
  });
  const cashBeforeD = await ledgerBalance(orgId, biz.id, "cash");
  const refusalD = await refuses(legacyRow.publicId);
  ok(
    "#17-B2: the EXISTING row's shape (no id_at_gateway, invoice only) is refused too",
    refusalD != null && !refusalD.startsWith("WRONG ERROR"),
    refusalD ?? "the verdict was ACCEPTED — txn_gCE7Yk… is still confirmable",
  );
  ok(
    "#17-B2: …with no ledger movement",
    (await ledgerBalance(orgId, biz.id, "cash")) === cashBeforeD,
    `cash ${cashBeforeD}→${await ledgerBalance(orgId, biz.id, "cash")}`,
  );

  // (B3) …and the guard is not a blanket block: an unreturned charge still settles.
  const cleanRow = await mkNeedsAttention({
    idAtGateway: `tmch_clean_${rid}`,
    amountMinor: 1_500n,
  });
  let cleanAccepted = false;
  try {
    await reconcileTransaction({
      organizationId: orgId,
      txnPublicId: cleanRow.publicId,
      outcome: "succeeded",
    });
    cleanAccepted = true;
  } catch (e) {
    cleanAccepted = false;
    ok("#17-B3: (unexpected refusal detail)", false, String(e));
  }
  ok(
    "#17-B3: a needs_attention row with NO refund against its charge is still confirmable",
    cleanAccepted && (await txnRow(cleanRow.publicId)).status === "succeeded",
  );
  /**
   * (B4) …and the honest verdict on a refunded row — `failed` — is still available: the
   * guard blocks ONE verdict, not the form.
   *
   * On the legacy-shaped row deliberately. `failed` on a row that DOES name its charge
   * cannot work at all: `settleTransactionOutcome` mints a fresh payment carrying
   * `id_at_gateway` as its `provider_charge_id`, and `payments_provider_charge_uq`
   * (one gateway charge books at most one payment) rejects the insert with a 500 —
   * measured here 2026-09-03 while writing this gate. That is a separate defect from
   * #17 and is reported, not fixed, by this section.
   */
  let failAccepted = false;
  try {
    await reconcileTransaction({
      organizationId: orgId,
      txnPublicId: legacyRow.publicId,
      outcome: "failed",
    });
    failAccepted = (await txnRow(legacyRow.publicId)).status === "failed";
  } catch (e) {
    failAccepted = false;
    ok("#17-B4: (refusal detail)", false, String(e));
  }
  ok(
    "#17-B4: `failed` is still accepted on a refunded row (the guard blocks one verdict, not the form)",
    failAccepted,
    (await txnRow(legacyRow.publicId)).status,
  );

  // ── (4) the panel needs the fact, not a guess ────────────────────────────────
  const detailed = await getTransactionDetailed(orgId, biz.id, bRow.publicId);
  const serializedB = detailed ? serializeTransaction(detailed.txn, detailed) : null;
  ok(
    "#17-D: the transaction read exposes the settled refund the panel must show instead of 'unknown'",
    (serializedB as { settled_refund?: { provider_refund_id?: string | null } } | null)
      ?.settled_refund?.provider_refund_id === `tmrf_${chargeB}`,
    JSON.stringify((serializedB as { settled_refund?: unknown } | null)?.settled_refund ?? null),
  );
  const cleanDetailed = await getTransactionDetailed(orgId, biz.id, cleanRow.publicId);
  ok(
    "#17-D: …and stays null where nothing came back, so the panel keeps its ordinary form",
    (cleanDetailed ? serializeTransaction(cleanDetailed.txn, cleanDetailed) : null) != null &&
      (cleanDetailed
        ? (serializeTransaction(cleanDetailed.txn, cleanDetailed) as {
            settled_refund?: unknown;
          })
        : {}
      ).settled_refund == null,
  );
}

// ── #15: a hold the GATEWAY calls authorized while OUR row still says in_progress ──
/**
 * Measured 2026-09-03 on INV-7824 (docs/PROGRESS.md #15). RazorPay authorized
 * ₹22,184.00 and delivered `payment.authorized` 21 minutes late. For those minutes our
 * `payment_intents` row read `in_progress`, the invoice read unpaid, the buyer was
 * blocked from paying with their own money held — and every fallback missed it:
 *
 *  - `releaseHoldBeforeExpiry` opened with `if (pi.status !== 'authorized') return
 *    not_held`, trusting the one field a late callback leaves stale. At expiry it made
 *    NO gateway call and concluded nothing was held.
 *  - there was no `fetchIntent` on the adapter interface at all — `createIntent`,
 *    `consumeIntent` and `voidIntent` could tell a gateway things, and nothing could ASK.
 *  - the `unapplied_gateway_money` alert reported `held_authorizations: 0`, because it
 *    counts `transactions`, and a late callback produces none. Invisible by construction.
 *
 * So this section asserts the three halves of the fix, each with its own negative:
 *  (A) a gateway-authorized hold is released even though our row says `in_progress`;
 *  (B) a gateway that says otherwise is NOT released, and a `setup` intent is never
 *      polled or released at all (its India e-mandate registration debit is a ₹1–5
 *      charge that is routinely refunded — measured, `pay_XXXXXXXXXXXX06`: amount 100,
 *      fee 3 — and must never pollute a money alert);
 *  (C) an aged `in_progress` intent joins the alert's population, a fresh one does not,
 *      and neither does one that never reached a gateway (7 such seed rows exist here —
 *      counting them read PAGE permanently, the same trap the 197 excess payments set).
 */
{
  const orgId = org.organization.id;
  const rid = randomUUID().slice(0, 8);
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Late Auth 15",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acctLite = (await listGatewayAccounts(orgId, biz.id)).find(
    (a) => a.gatewayKey === "tmtest",
  )!;
  const acctRow = (await getGatewayAccount(orgId, biz.id, acctLite.publicId))!;
  const tm = resolveAdapter(acctRow);
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `late15_${rid}@gw.test`,
  });
  // 3DS card: the intent stays `in_progress`, which is the shape the defect needs — the
  // buyer's browser never posted the second leg, so nothing local knows the gateway
  // went on to authorize it.
  const pm = await (async () => {
    const ref = await tm.vaultPaymentMethod({
      customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cus.publicId}` },
      token: "4000000000003155",
    });
    return withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: cus.id,
          publicId: publicId("pm"),
          providerKey: "tmtest",
          providerCustomerId: `tmcus_${cus.publicId}`,
          providerPaymentMethodId: ref.providerPaymentMethodId,
          type: "card",
          last4: ref.display.last4,
          gatewayAccountId: acctRow.id,
        })
        .returning();
      return row!;
    });
  })();

  const gatewayRow = async (chargeId: string) =>
    (
      await systemDb
        .select()
        .from(tmtestCharges)
        .where(eq(tmtestCharges.chargeId, chargeId))
        .limit(1)
    )[0];
  /** Force the gateway's own row to a status, WITHOUT touching our intent row. */
  const gatewaySays = async (chargeId: string, status: string) => {
    await systemDb
      .update(tmtestCharges)
      .set({ status })
      .where(eq(tmtestCharges.chargeId, chargeId));
  };
  /** Make our row due for the expiry sweep, leaving its status alone. */
  const dueNow = async (id: string) =>
    withTenant(orgId, (tx) =>
      tx
        .update(paymentIntents)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(paymentIntents.id, id)),
    );
  const paymentIntentOnInvoice = async (amountMinor: bigint) => {
    const inv = (
      await createInvoiceFromLines({
        organizationId: orgId,
        businessId: biz.id,
        customerId: cus.id,
        currency: "USD",
        lines: [{ description: "Late-auth-15 target", amountMinor }],
        collect: false,
      })
    ).invoice;
    const pi = await createPaymentIntent({
      organizationId: orgId,
      businessId: biz.id,
      paymentMethodPublicId: pm.publicId,
      amountMinor: Number(amountMinor),
      currency: "USD",
      invoicePublicId: inv.publicId,
    });
    return { inv, pi };
  };

  // ── (A) the gateway is holding funds our record has not caught up with ───────
  const a = await paymentIntentOnInvoice(2_218_400n);
  const gwA = a.pi.intent.intentAtGateway!;
  ok(
    "#15-FIXTURE: our row says in_progress (a late callback never moved it)",
    a.pi.intent.status === "in_progress",
    `status=${a.pi.intent.status}`,
  );
  // The gateway went on to authorize. Written directly rather than through
  // `resolveChallenge`, which would also drive OUR row — and the divergence between the
  // two records IS the defect. (`resolveChallenge(id, true)` re-authorizes any row it
  // finds, which is how a fixture gets silently undone — A1 hit exactly that on #17.)
  await gatewaySays(gwA, "authorized");
  await dueNow(a.pi.intent.id);
  await expirePaymentIntents(new Date());
  const gwAfterA = await gatewayRow(gwA);
  ok(
    "#15-A: a hold the GATEWAY calls authorized is RELEASED even though our row said in_progress",
    gwAfterA?.status === "voided",
    `gateway row=${gwAfterA?.status} (unreleased means releaseHoldBeforeExpiry trusted our status)`,
  );
  const reversalsFor = async (piId: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.paymentIntentId, piId), eq(transactions.type, "payment_reversal")),
        ),
    );
  const reversalsA = await reversalsFor(a.pi.intent.id);
  ok(
    "#15-A: …and the release is recorded as a payment_reversal, like every other release",
    reversalsA.length === 1,
    `reversals=${reversalsA.length}`,
  );

  // ── (B) a gateway that does NOT report a hold must not be second-guessed ─────
  const b = await paymentIntentOnInvoice(1_000_00n);
  const gwB = b.pi.intent.intentAtGateway!;
  await gatewaySays(gwB, "requires_action");
  await dueNow(b.pi.intent.id);
  await expirePaymentIntents(new Date());
  const gwAfterB = await gatewayRow(gwB);
  ok(
    "#15-B: an intent the gateway does NOT call authorized is left alone (no release, no claim)",
    gwAfterB?.status === "requires_action" && (await reversalsFor(b.pi.intent.id)).length === 0,
    `gateway row=${gwAfterB?.status}`,
  );

  // A SETUP intent is never polled and never released — rule 1 of
  // `releaseHoldBeforeExpiry`, and the reason it has to come FIRST now: a setup intent
  // holds no money (created with `amountMinor: 0n` on every adapter), and its
  // registration debit on the India e-mandate rails is a ₹1–5 charge that is routinely
  // refunded while the mandate goes live. Releasing that, or counting it as stranded
  // money, would be a false alarm about someone else's rupee.
  const setup15 = await createPaymentIntent({
    organizationId: orgId,
    businessId: biz.id,
    purpose: "setup",
    customerPublicId: cus.publicId,
    currency: "USD",
  });
  const gwS = setup15.intent.intentAtGateway!;
  await gatewaySays(gwS, "authorized");
  await dueNow(setup15.intent.id);
  await expirePaymentIntents(new Date());
  ok(
    "#15-B: a SETUP intent the gateway calls authorized is NOT released (it holds no money)",
    (await gatewayRow(gwS))?.status === "authorized",
    `gateway row=${(await gatewayRow(gwS))?.status}`,
  );

  // ── (B2) the adapter contract: only the two gateways that need it may answer ──
  ok(
    "#15-B: tmtest advertises intentStatus iff it implements fetchIntent",
    (tm.capabilities.intentStatus === true) === (typeof tm.fetchIntent === "function"),
  );
  {
    const rzp = new RazorpayProvider({
      keyId: "rzp_test_x",
      keySecret: "x",
      apiBase: "https://rzp.invalid",
    });
    ok(
      "#15-B: razorpay advertises intentStatus iff it implements fetchIntent",
      (rzp.capabilities.intentStatus === true) === (typeof rzp.fetchIntent === "function"),
    );
    // A gateway id shape RazorPay's order endpoint cannot answer for must come back
    // `unknown` — never a verdict, and never a network call. The netbanking e-mandate
    // auth link stores an `inv_…` (see `createEmandateAuthLink`).
    ok(
      "#15-B: razorpay answers `unknown` for an id it cannot query, without calling out",
      (await rzp.fetchIntent!({ intentId: "inv_XXXXXXXXXXXX01" })).status === "unknown",
    );
    // Flag and probe come together: Stripe has both since 2026-10-25 (a pay-now bank debit
    // sends no authorization webhook), PayPal neither — see `capabilities.intentStatus`.
    // Probed THROUGH the interface, not the concrete class: `fetchIntent` is optional on
    // `PaymentProvider`. The point of the assertion is the CONTRACT.
    const stripe: PaymentProvider = new StripeProvider("sk_test_x");
    const paypal: PaymentProvider = new PayPalProvider({
      clientId: "x",
      clientSecret: "x",
      apiBase: "https://api.example.invalid",
    });
    ok(
      "#15-B: stripe declares the probe with the flag; paypal implements neither",
      typeof stripe.fetchIntent === "function" &&
        stripe.capabilities.intentStatus === true &&
        paypal.fetchIntent === undefined &&
        paypal.capabilities.intentStatus === undefined,
    );
  }

  // ── (D) #18: the gateway fee, surfaced through the adapter ───────────────────
  /**
   * RazorPay hands us the fee on the capture webhook we ALREADY persist, and nothing
   * read it: no fee column, no fee field on any adapter, no fee account in the ledger.
   * The payload below is the real one from `pay_XXXXXXXXXXXX05` (INV-7824), trimmed to
   * the fields the adapter reads — `fee: 43192`, `tax: 6588` (₹431.92, of which ₹65.88
   * GST). That round trip cost ₹431.92 that the books show as zero, twice over.
   */
  {
    const secret = `whsec_15_${rid}`;
    const rzp = new RazorpayProvider({
      keyId: "rzp_test_x",
      keySecret: "x",
      apiBase: "https://rzp.invalid",
      webhookSecret: secret,
    });
    const body = JSON.stringify({
      id: `evt_fee_${rid}`,
      event: "payment.captured",
      created_at: 1788437757,
      payload: {
        payment: {
          entity: {
            id: "pay_XXXXXXXXXXXX05",
            order_id: "order_XXXXXXXXXXXX04",
            amount: 2218400,
            currency: "INR",
            status: "captured",
            captured: true,
            fee: 43192,
            tax: 6588,
          },
        },
      },
    });
    const events15 = await rzp.normalizeWebhook({
      payload: body,
      headers: {
        "x-razorpay-signature": createHmac("sha256", secret).update(body).digest("hex"),
      },
    });
    const captured = events15[0]!;
    ok(
      "#18: the capture's gateway FEE reaches the engine through the normalized event",
      captured.feeMinor === 43_192n && captured.feeTaxMinor === 6_588n,
      `feeMinor=${captured.feeMinor} feeTaxMinor=${captured.feeTaxMinor}`,
    );
    ok(
      "#18: …and it is a per-CHARGE fee, never confused with a payout's netted fees",
      captured.settlementFeesMinor === undefined && captured.type === "charge.succeeded",
    );
  }
}

// ── #20: a `failed` verdict on a charge that is ALREADY booked ────────────────
/**
 * Found by agent A1 on 2026-09-03 while writing #17's gate (docs/PROGRESS.md #20), and
 * recorded there in a comment rather than fixed: `reconcileTransaction(outcome: 'failed')`
 * on a `needs_attention` row that DOES carry `id_at_gateway` for a charge a payment
 * already books raised a **500**, not a refusal — `settleTransactionOutcome` began with
 * `if (!paymentId) { insert into payments … providerChargeId: input.txn.idAtGateway }`
 * and `payments_provider_charge_uq` (business + charge, "one gateway charge books at most
 * one payment") rejected the insert. So "mark this failed" was unavailable on exactly the
 * rows most likely to need it, and it failed as a server error nobody can act on.
 *
 * That shape is not exotic: post-#17 the late-authorization path stamps `id_at_gateway`
 * on the `authorization_unappliable` row it raises (`webhooks/inbound.ts`), and the
 * capture that produced the charge has usually already booked its own payment — through
 * `settleUnmatchedGatewayCapture` or through the collect path's `bookPending`. The row
 * naming the charge and the payment holding it are two records of ONE charge, which is
 * the whole reason the unique index exists.
 *
 * ── THE TWO SHAPES, AND WHY BOTH ARE HERE ──────────────────────────────────────
 * Resolving the existing payment and settling THAT row is right while it is still
 * `pending` (B) — the same "look it up, do not insert" that `settleUnmatchedGatewayCapture`
 * in the same file has always done, and the failure is then booked once against the money
 * it belongs to. It is WRONG once that row reads `succeeded` (A): `settlePaymentFailed`
 * claims `pending` only, so reuse would post nothing, no-op silently, and still leave
 * `reconcileTransaction`'s own `status = 'failed'` standing — a transaction reading
 * failure over money that demonstrably moved, and terminal, so nobody can reconcile it
 * back. So (A) is REFUSED, in #17's shape and before the write transaction opens, and
 * (A4) is the assertion that tells the two shapes apart.
 *
 * (D) proves the collision was never specific to the `failed` verdict — the insert sits
 * ABOVE the outcome branch, so a `succeeded` verdict on an already-booked charge that
 * #17's brake cannot see (nothing refunded) 500s identically. That is why the fix is in
 * `settleTransactionOutcome` and not in a verdict branch.
 */
{
  const orgId = org.organization.id;
  const rid = randomUUID().slice(0, 8);
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Booked Charge 20",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acctLite20 = (await listGatewayAccounts(orgId, biz.id)).find(
    (a) => a.gatewayKey === "tmtest",
  )!;
  const acctRow20 = (await getGatewayAccount(orgId, biz.id, acctLite20.publicId))!;
  const tm20 = resolveAdapter(acctRow20);
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `booked20_${rid}@gw.test`,
  });
  const vaultPm20 = async (token: string) => {
    const ref = await tm20.vaultPaymentMethod({
      customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cus.publicId}` },
      token,
    });
    return withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: cus.id,
          publicId: publicId("pm"),
          providerKey: "tmtest",
          providerCustomerId: `tmcus_${cus.publicId}`,
          providerPaymentMethodId: ref.providerPaymentMethodId,
          type: "card",
          last4: ref.display.last4,
          gatewayAccountId: acctRow20.id,
        })
        .returning();
      return row!;
    });
  };
  const mkInvoice20 = async (amountMinor: bigint) =>
    (
      await createInvoiceFromLines({
        organizationId: orgId,
        businessId: biz.id,
        customerId: cus.id,
        currency: "USD",
        lines: [{ description: "Booked-charge target", amountMinor }],
        collect: false,
      })
    ).invoice;
  const invoiceRow20 = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, id)).limit(1),
      )
    )[0]!;
  /**
   * The row the late-authorization path raises: an authorization nothing local can apply,
   * naming its gateway charge (#17's fix) and carrying NO `payment_id` — which is what
   * sends `settleTransactionOutcome` down the insert branch this section is about.
   */
  const mkNeedsAttention20 = async (fields: {
    amountMinor: bigint;
    idAtGateway: string | null;
    invoiceId?: string | null;
  }) =>
    recordTransaction({
      organizationId: orgId,
      businessId: biz.id,
      customerId: cus.id,
      type: "authorization",
      status: "needs_attention",
      amountMinor: fields.amountMinor,
      currency: "USD",
      idAtGateway: fields.idAtGateway,
      invoiceId: fields.invoiceId ?? null,
      errorCode: "authorization_unappliable",
      errorText: "fixture",
      retriable: false,
    });
  /**
   * A verdict's outcome as an operator experiences it: `null` = accepted, a string =
   * refused with words they can act on, and `NOT A TransactionError` = the 500. That
   * distinction IS the defect — asserting only "it did not throw" would pass just as
   * happily on a suite that booked the contradiction.
   */
  const verdict20 = async (txnPublicId: string, outcome: "succeeded" | "failed") => {
    try {
      await reconcileTransaction({ organizationId: orgId, txnPublicId, outcome });
      return null;
    } catch (e) {
      return e instanceof TransactionError
        ? (e as Error).message
        : `NOT A TransactionError: ${String(e)}`;
    }
  };
  const txnRow20 = async (publicIdValue: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(transactions).where(eq(transactions.publicId, publicIdValue)).limit(1),
      )
    )[0]!;
  const paymentsForCharge20 = async (chargeId: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(payments)
        .where(and(eq(payments.businessId, biz.id), eq(payments.providerChargeId, chargeId))),
    );
  const ledger20 = async () => ({
    cash: await ledgerBalance(orgId, biz.id, "cash"),
    ar: await ledgerBalance(orgId, biz.id, "accounts_receivable"),
    excess: await ledgerBalance(orgId, biz.id, "excess_payment_balance"),
  });

  // ── (A) the charge is booked and its payment SUCCEEDED: the verdict is refused ──
  /**
   * The booked payment is produced BY the code under test — a `succeeded` verdict on a
   * first row naming the charge — rather than written here. #25's lesson: a fixture that
   * constructs the row it reads cannot discover the shape production actually stores, and
   * the shape that collides is precisely the one this insert writes.
   */
  const chargeA20 = `tmch_booked_a_${rid}`;
  const invA20 = await mkInvoice20(9_900n);
  const firstA20 = await mkNeedsAttention20({
    amountMinor: 9_900n,
    idAtGateway: chargeA20,
    invoiceId: invA20.id,
  });
  const acceptedFirstA20 = await verdict20(firstA20.publicId, "succeeded");
  const bookedA20 = (await paymentsForCharge20(chargeA20))[0];
  ok(
    "#20-FIXTURE: a `succeeded` verdict books ONE payment carrying the gateway charge id",
    acceptedFirstA20 == null &&
      (await paymentsForCharge20(chargeA20)).length === 1 &&
      bookedA20?.status === "succeeded",
    `verdict=${acceptedFirstA20 ?? "accepted"} rows=${(await paymentsForCharge20(chargeA20)).length} status=${bookedA20?.status}`,
  );
  // The second record of the same charge: the late-authorization row.
  const secondA20 = await mkNeedsAttention20({
    amountMinor: 9_900n,
    idAtGateway: chargeA20,
    invoiceId: invA20.id,
  });
  const beforeA20 = await ledger20();
  const refusalA20 = await verdict20(secondA20.publicId, "failed");
  ok(
    "#20-A1: a `failed` verdict on an already-booked charge is REFUSED, not a 500",
    refusalA20 != null && !refusalA20.startsWith("NOT A TransactionError"),
    refusalA20 ?? "the verdict was ACCEPTED",
  );
  ok(
    "#20-A2: …and the refusal names the payment that already holds the charge",
    (refusalA20 ?? "").includes(bookedA20?.publicId ?? " ") &&
      (refusalA20 ?? "").includes(chargeA20),
    refusalA20 ?? "accepted",
  );
  const afterA20 = await ledger20();
  ok(
    "#20-A3: …and posts NO ledger entries (nothing may contradict a settled payment)",
    afterA20.cash === beforeA20.cash &&
      afterA20.ar === beforeA20.ar &&
      afterA20.excess === beforeA20.excess,
    `cash ${beforeA20.cash}->${afterA20.cash} ar ${beforeA20.ar}->${afterA20.ar} excess ${beforeA20.excess}->${afterA20.excess}`,
  );
  /**
   * THE ASSERTION THAT TELLS THE TWO SHAPES APART. Resolve-and-reuse would land here
   * silently: `settlePaymentFailed` claims `pending` only, so it posts nothing and
   * returns false, while `reconcileTransaction` has already written `status = 'failed'`
   * — a transaction reading failure over a succeeded payment, terminal, and therefore
   * un-reconcilable by anyone afterwards.
   */
  ok(
    "#20-A4: …and does NOT flip the row to `failed` behind a payment that reads succeeded",
    (await txnRow20(secondA20.publicId)).status === "needs_attention" &&
      (await paymentsForCharge20(chargeA20))[0]!.status === "succeeded",
    `txn=${(await txnRow20(secondA20.publicId)).status} payment=${(await paymentsForCharge20(chargeA20))[0]!.status}`,
  );
  ok(
    "#20-A5: …and mints no SECOND payment against the same gateway charge",
    (await paymentsForCharge20(chargeA20)).length === 1,
    `rows=${(await paymentsForCharge20(chargeA20)).length}`,
  );

  // ── (B) the charge is booked and its payment is PENDING: settle THAT row ─────
  /**
   * The pending payment comes from the real collect path: tmtest's `…077` card responds
   * too slowly, `collectInvoice` parks the invoice and `bookPending` writes a `pending`
   * payment carrying the gateway charge id. The second record of that charge is the
   * late-authorization row again — #26's live shape, one status earlier.
   */
  const pmTimeout20 = await vaultPm20("4000000000000077");
  const invB20 = await mkInvoice20(4_400n);
  await collectInvoice({
    organizationId: orgId,
    businessId: biz.id,
    invoice: await invoiceRow20(invB20.id),
    paymentMethodOverrideId: pmTimeout20.publicId,
  });
  const pendingB20 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, invB20.id)),
    )
  )[0];
  const chargeB20 = pendingB20?.providerChargeId ?? "";
  ok(
    "#20-FIXTURE: the parked attempt booked ONE pending payment naming its gateway charge",
    pendingB20?.status === "pending" && chargeB20 !== "",
    `status=${pendingB20?.status} charge=${chargeB20 || "(none)"}`,
  );
  const lateB20 = await mkNeedsAttention20({
    amountMinor: 4_400n,
    idAtGateway: chargeB20,
    invoiceId: invB20.id,
  });
  const beforeB20 = await ledger20();
  const refusalB20 = await verdict20(lateB20.publicId, "failed");
  ok(
    "#20-B1: a `failed` verdict is ACCEPTED where the charge's payment is still pending",
    refusalB20 == null,
    refusalB20 ?? "accepted",
  );
  ok(
    "#20-B2: …and settles the EXISTING pending payment rather than minting a second one",
    (await paymentsForCharge20(chargeB20)).length === 1 &&
      (await paymentsForCharge20(chargeB20))[0]!.status === "failed",
    `rows=${(await paymentsForCharge20(chargeB20)).length} status=${(await paymentsForCharge20(chargeB20))[0]?.status}`,
  );
  ok(
    "#20-B3: …and the transaction reads failure",
    (await txnRow20(lateB20.publicId)).status === "failed",
    (await txnRow20(lateB20.publicId)).status,
  );
  const afterB20 = await ledger20();
  ok(
    "#20-B4: …and books no cash for a failure, and leaves the invoice unpaid",
    afterB20.cash === beforeB20.cash &&
      afterB20.excess === beforeB20.excess &&
      (await invoiceRow20(invB20.id)).status !== "paid",
    `cash ${beforeB20.cash}->${afterB20.cash} invoice=${(await invoiceRow20(invB20.id)).status}`,
  );

  // ── (C) the ordinary verdict on a genuinely unbooked charge is untouched ─────
  const chargeC20 = `tmch_unbooked_c_${rid}`;
  const invC20 = await mkInvoice20(2_500n);
  const cleanC20 = await mkNeedsAttention20({
    amountMinor: 2_500n,
    idAtGateway: chargeC20,
    invoiceId: invC20.id,
  });
  const beforeC20 = await ledger20();
  const refusalC20 = await verdict20(cleanC20.publicId, "failed");
  ok(
    "#20-C: the ordinary `failed` verdict on an UNBOOKED charge still books its payment and fails it",
    refusalC20 == null &&
      (await txnRow20(cleanC20.publicId)).status === "failed" &&
      (await paymentsForCharge20(chargeC20)).length === 1 &&
      (await paymentsForCharge20(chargeC20))[0]!.status === "failed",
    `verdict=${refusalC20 ?? "accepted"} txn=${(await txnRow20(cleanC20.publicId)).status} rows=${(await paymentsForCharge20(chargeC20)).length}`,
  );
  const afterC20 = await ledger20();
  ok(
    "#20-C: …and posts no cash for it",
    afterC20.cash === beforeC20.cash && afterC20.excess === beforeC20.excess,
    `cash ${beforeC20.cash}->${afterC20.cash}`,
  );

  // ── (D) the `succeeded` verdict collided the SAME way ────────────────────────
  /**
   * Same already-booked charge as (A), and #17's brake cannot see it: nothing was
   * refunded, so `settledReturnForTransaction` returns null and the verdict reaches
   * `settleTransactionOutcome`'s insert. Accepting it books nothing new — this charge's
   * money is already on the ledger once and the claim inside `settlePaymentSucceeded`
   * declines a second posting — so `succeeded` is the truthful status for a second record
   * of a charge that really did capture.
   */
  const thirdA20 = await mkNeedsAttention20({
    amountMinor: 9_900n,
    idAtGateway: chargeA20,
    invoiceId: invA20.id,
  });
  const beforeD20 = await ledger20();
  const refusalD20 = await verdict20(thirdA20.publicId, "succeeded");
  ok(
    "#20-D1: a `succeeded` verdict on an already-booked charge is not a 500 either",
    refusalD20 == null || !refusalD20.startsWith("NOT A TransactionError"),
    refusalD20 ?? "accepted",
  );
  const afterD20 = await ledger20();
  ok(
    "#20-D2: …and the charge's money stays booked exactly ONCE",
    afterD20.cash === beforeD20.cash &&
      afterD20.excess === beforeD20.excess &&
      (await paymentsForCharge20(chargeA20)).length === 1,
    `cash ${beforeD20.cash}->${afterD20.cash} excess ${beforeD20.excess}->${afterD20.excess} rows=${(await paymentsForCharge20(chargeA20)).length}`,
  );
}

// ── #31: every gateway object we create carries a REAL id of ours ────────────
/**
 * `ownershipRef` reached the CONTRACT (`providers/types.ts`) and all three real adapters
 * on 2026-09-04 — Stripe `metadata.tmbilling_ref`, RazorPay `notes.tmbilling_ref`, PayPal
 * `custom_id` — and a live PayPal sandbox capture came back carrying it. What it did NOT
 * reach was a single engine CALL SITE: measured 2026-09-04,
 * `grep -rn ownershipRef src --include=*.ts` found it only in `providers/`. So every
 * gateway object fell through to each adapter's documented bridge, the IDEMPOTENCY KEY.
 *
 * Why that bridge is not good enough, and why these assertions are about RESOLUTION:
 *  · an idempotency key is not a public id, so a human reconciling in the gateway console
 *    has nothing to paste into our search — the key resolves to NO row of ours;
 *  · the invoice-collection key is `inv_${invoice.publicId}_attempt_N_${pm.publicId}` and
 *    `invoice.publicId` already begins `inv_`, so the live PayPal evidence read
 *    `custom_id: "tmbilling_ref:inv_inv_EMZpKKXAK0fsEQ9vTkmt4zL9_attempt_1_pm_GnAxcDk…"`
 *    — a doubled prefix, i.e. not even a well-formed id of ours;
 *  · `charge()` is the path every off-session RENEWAL takes, so this is the busiest money
 *    path in the system.
 *
 * ── WHERE THESE ASSERTIONS OBSERVE, AND WHY NOT THE REQUEST LOG ────────────────
 * The brief for this section proposed reading `gateway_request_logs` the way #20 reads
 * DB state. Measured instead (2026-09-04):
 * `grep -nE "providers/http|gatewayRequestLogs|logGatewayRequest" src/providers/tmtest/index.ts`
 * returns NOTHING — tmtest never makes an HTTP call, and `gateway_request_logs` is written
 * only by `providers/http.ts`. A request-log assertion against the one adapter that runs
 * offline would therefore be vacuous: it would pass on zero rows. So these observe the
 * ENGINE→ADAPTER boundary, which is also the defect's exact location (the contract field
 * existed; nobody filled it). Prototype patching is the technique C7+ already uses above.
 *
 * The convention asserted here: **the bare public id of the tmbilling row the gateway
 * object exists to settle** — no wrapping, no composition, no decoration. Public ids are
 * self-describing by prefix, so any of `pi_ inv_ pay_ re_ cus_` pasted into our own search
 * lands on exactly one row, which is what `resolve31` below actually checks.
 */
{
  const orgId = org.organization.id;
  const rid = randomUUID().slice(0, 8);
  const biz31 = await createBusiness({
    organizationId: orgId,
    name: "Ownership Ref 31",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acctLite31 = (await listGatewayAccounts(orgId, biz31.id)).find(
    (a) => a.gatewayKey === "tmtest",
  )!;
  const acctRow31 = (await getGatewayAccount(orgId, biz31.id, acctLite31.publicId))!;
  const tm31 = resolveAdapter(acctRow31);
  const cus31 = await createCustomer({
    organizationId: orgId,
    businessId: biz31.id,
    email: `own31_${rid}@gw.test`,
  });
  const cusRow31 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(customers).where(eq(customers.id, cus31.id)).limit(1),
    )
  )[0]!;
  const vaultPm31 = async (token: string) => {
    const ref = await tm31.vaultPaymentMethod({
      customer: { providerKey: "tmtest", providerCustomerId: `tmcus_${cus31.publicId}` },
      token,
    });
    return withTenant(orgId, async (tx) => {
      const [row] = await tx
        .insert(paymentMethods)
        .values({
          organizationId: orgId,
          businessId: biz31.id,
          customerId: cus31.id,
          publicId: publicId("pm"),
          providerKey: "tmtest",
          providerCustomerId: `tmcus_${cus31.publicId}`,
          providerPaymentMethodId: ref.providerPaymentMethodId,
          type: "card",
          last4: ref.display.last4,
          gatewayAccountId: acctRow31.id,
        })
        .returning();
      return row!;
    });
  };
  const invoiceRow31 = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, id)).limit(1),
      )
    )[0]!;

  /**
   * Paste-it-into-our-search, as a query. A tag a human cannot resolve to one row IS the
   * thing being fixed, so "the ref is a public id" is asserted by LOOKING THE ROW UP
   * rather than by matching a prefix — a well-shaped string that names nothing would
   * satisfy a regex and still leave the reconciler stuck.
   */
  const resolve31 = async (ref: string | undefined): Promise<string | null> => {
    if (!ref) return null;
    return withTenant(orgId, async (tx) => {
      const one = async (rows: Array<unknown>, label: string) => (rows.length === 1 ? label : null);
      if (ref.startsWith("pi_"))
        return one(
          await tx
            .select({ id: paymentIntents.id })
            .from(paymentIntents)
            .where(eq(paymentIntents.publicId, ref)),
          "payment_intent",
        );
      if (ref.startsWith("inv_"))
        return one(
          await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.publicId, ref)),
          "invoice",
        );
      if (ref.startsWith("pay_"))
        return one(
          await tx.select({ id: payments.id }).from(payments).where(eq(payments.publicId, ref)),
          "payment",
        );
      if (ref.startsWith("re_"))
        return one(
          await tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.publicId, ref)),
          "refund",
        );
      if (ref.startsWith("sub_"))
        return one(
          await tx
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(eq(subscriptions.publicId, ref)),
          "subscription",
        );
      if (ref.startsWith("cus_"))
        return one(
          await tx.select({ id: customers.id }).from(customers).where(eq(customers.publicId, ref)),
          "customer",
        );
      if (ref.startsWith("pm_"))
        return one(
          await tx
            .select({ id: paymentMethods.id })
            .from(paymentMethods)
            .where(eq(paymentMethods.publicId, ref)),
          "payment_method",
        );
      return null;
    });
  };

  /**
   * The captures. `key` rides alongside `ref` on every one because the assertion that
   * matters is comparative: the tag must be the public id AND must not be the key the
   * adapters fall back to. Recording only the ref would let a call site that passed the
   * key explicitly pass this gate.
   */
  type Cap31 = { ref?: string; key?: string };
  const cap31: { intent: Cap31[]; charge: Cap31[]; refund: Cap31[]; vault: Cap31[] } = {
    intent: [],
    charge: [],
    refund: [],
    vault: [],
  };
  /**
   * tmtest's `initiateVaultSetup()` is declared with NO parameter (it ignores its input),
   * so the class's own prototype type is `() => Promise<VaultSetupRef>` and a spy that
   * reads the input is not assignable to it. The cast is that fact, not laziness — what
   * is under test is what the ENGINE passed, never what the stub did with it.
   */
  const proto31 = TmtestProvider.prototype as unknown as {
    createIntent: (i: CreateIntentInput) => Promise<unknown>;
    charge: (i: ChargeInput) => Promise<unknown>;
    refund: (i: RefundInput) => Promise<unknown>;
    initiateVaultSetup: (i: InitiateVaultSetupInput) => Promise<unknown>;
  };
  const orig31 = {
    createIntent: proto31.createIntent,
    charge: proto31.charge,
    refund: proto31.refund,
    initiateVaultSetup: proto31.initiateVaultSetup,
  };
  proto31.createIntent = async function (this: unknown, i: CreateIntentInput) {
    cap31.intent.push({ ref: i.ownershipRef, key: i.idempotencyKey });
    return orig31.createIntent.call(this, i);
  };
  proto31.charge = async function (this: unknown, i: ChargeInput) {
    cap31.charge.push({ ref: i.ownershipRef, key: i.idempotencyKey });
    return orig31.charge.call(this, i);
  };
  proto31.refund = async function (this: unknown, i: RefundInput) {
    cap31.refund.push({ ref: i.ownershipRef, key: i.idempotencyKey });
    return orig31.refund.call(this, i);
  };
  proto31.initiateVaultSetup = async function (this: unknown, i: InitiateVaultSetupInput) {
    cap31.vault.push({ ref: i?.ownershipRef });
    return orig31.initiateVaultSetup.call(this, i);
  };

  let drive31: string | null = null;
  let created31: Awaited<ReturnType<typeof createPaymentIntent>> | null = null;
  let invB31: { id: string; publicId: string } | null = null;
  let payB31: typeof payments.$inferSelect | null = null;
  let ref31: Awaited<ReturnType<typeof refundPayment>> | null = null;
  let topupPay31: typeof payments.$inferSelect | null = null;
  try {
    // (A) createIntent — the intent's own public id.
    const pmA31 = await vaultPm31("4242424242424242");
    created31 = await createPaymentIntent({
      organizationId: orgId,
      businessId: biz31.id,
      paymentMethodPublicId: pmA31.publicId,
      amountMinor: 4200,
      currency: "USD",
    });

    // (B) charge — invoice collection, the renewal path. Amount avoids the tmtest
    // needs-attention magic (`…13`).
    const madeB31 = await createInvoiceFromLines({
      organizationId: orgId,
      businessId: biz31.id,
      customerId: cus31.id,
      currency: "USD",
      lines: [{ description: "Ownership-ref target", amountMinor: 4_400n }],
      collect: false,
    });
    invB31 = madeB31.invoice;
    await collectInvoice({
      organizationId: orgId,
      businessId: biz31.id,
      invoice: await invoiceRow31(madeB31.invoice.id),
    });
    payB31 =
      (
        await withTenant(orgId, (tx) =>
          tx.select().from(payments).where(eq(payments.invoiceId, madeB31.invoice.id)),
        )
      )[0] ?? null;

    // (C) refund — its own gateway object, which does NOT inherit the charge's metadata.
    if (payB31) {
      ref31 = await refundPayment({
        organizationId: orgId,
        businessId: biz31.id,
        paymentPublicId: payB31.publicId,
      });
    }

    // (D) charge — wallet top-up, the second `charge()` call site.
    const topup31 = await topUpWallet({
      organizationId: orgId,
      businessId: biz31.id,
      customer: cusRow31,
      amountMinor: 4500,
      currency: "USD",
      type: "paid",
    });
    topupPay31 = topup31.paymentId
      ? ((
          await withTenant(orgId, (tx) =>
            tx.select().from(payments).where(eq(payments.id, topup31.paymentId!)).limit(1),
          )
        )[0] ?? null)
      : null;

    // (E) initiateVaultSetup — the legacy add-card path. Driven at
    // `initiateVaultSetupForBusiness` rather than through `beginVaultSetup`, because
    // `beginVaultSetup` prefers the setup-INTENT path and only falls back here, so the
    // route would usually exercise (A) again instead of this call.
    await initiateVaultSetupForBusiness({
      organizationId: orgId,
      businessId: biz31.id,
      customer: cusRow31,
      returnUrl: "https://own31.test/return",
      cancelUrl: "https://own31.test/cancel",
    });
  } catch (e) {
    drive31 = e instanceof Error ? e.message : String(e);
  } finally {
    proto31.createIntent = orig31.createIntent;
    proto31.charge = orig31.charge;
    proto31.refund = orig31.refund;
    proto31.initiateVaultSetup = orig31.initiateVaultSetup;
  }

  ok(
    "#31-FIXTURE: all five gateway calls were made (no drive error)",
    drive31 == null &&
      cap31.intent.length >= 1 &&
      cap31.charge.length >= 2 &&
      cap31.refund.length >= 1 &&
      cap31.vault.length >= 1,
    `error=${drive31 ?? "none"} intent=${cap31.intent.length} charge=${cap31.charge.length} refund=${cap31.refund.length} vault=${cap31.vault.length}`,
  );

  // ── (A) createIntent ────────────────────────────────────────────────────────
  const capA31 = cap31.intent[0];
  ok(
    "#31-A1: createIntent is tagged with the payment intent's OWN public id",
    capA31?.ref != null && capA31.ref === created31?.intent.publicId,
    `ref=${capA31?.ref ?? "MISSING"} intent=${created31?.intent.publicId ?? "?"}`,
  );
  ok(
    "#31-A2: …and that tag is not the idempotency key the adapters fall back to",
    capA31?.ref != null && capA31.ref !== capA31.key,
    `ref=${capA31?.ref ?? "MISSING"} key=${capA31?.key ?? "?"}`,
  );
  ok(
    "#31-A3: …and it RESOLVES: pasted into our search it lands on the intent",
    (await resolve31(capA31?.ref)) === "payment_intent",
    `ref=${capA31?.ref ?? "MISSING"} resolved=${(await resolve31(capA31?.ref)) ?? "NOTHING"}`,
  );

  // ── (B) charge, invoice collection ──────────────────────────────────────────
  const capB31 = cap31.charge[0];
  ok(
    "#31-B1: an invoice charge is tagged with the INVOICE's public id",
    capB31?.ref != null && capB31.ref === invB31?.publicId,
    `ref=${capB31?.ref ?? "MISSING"} invoice=${invB31?.publicId ?? "?"}`,
  );
  ok(
    "#31-B2: …not the idempotency key, whose `inv_inv_` doubling the live PayPal capture showed",
    capB31?.ref != null && capB31.ref !== capB31.key && !/^inv_inv_/.test(capB31.ref),
    `ref=${capB31?.ref ?? "MISSING"} key=${capB31?.key ?? "?"}`,
  );
  ok(
    "#31-B3: …and it RESOLVES to the invoice",
    (await resolve31(capB31?.ref)) === "invoice",
    `ref=${capB31?.ref ?? "MISSING"} resolved=${(await resolve31(capB31?.ref)) ?? "NOTHING"}`,
  );
  /**
   * The fallback's actual cost, measured rather than argued: the key names no row of
   * ours, so the reconciler holding it in the gateway console has nowhere to go. This
   * line is what makes "pass the real id" a fix and not a preference.
   */
  ok(
    "#31-B4: …and the idempotency key it replaced resolves to NOTHING (the defect, measured)",
    (await resolve31(capB31?.key)) === null,
    `key=${capB31?.key ?? "?"} resolved=${(await resolve31(capB31?.key)) ?? "nothing"}`,
  );

  // ── (C) refund ──────────────────────────────────────────────────────────────
  const capC31 = cap31.refund[0];
  ok(
    "#31-C1: a refund is tagged with the REFUND's own public id",
    capC31?.ref != null && capC31.ref === ref31?.publicId,
    `ref=${capC31?.ref ?? "MISSING"} refund=${ref31?.publicId ?? "?"}`,
  );
  ok(
    "#31-C2: …and it RESOLVES to the refund",
    (await resolve31(capC31?.ref)) === "refund",
    `ref=${capC31?.ref ?? "MISSING"} resolved=${(await resolve31(capC31?.ref)) ?? "NOTHING"}`,
  );

  // ── (D) charge, wallet top-up ───────────────────────────────────────────────
  /**
   * The wallet's idempotency key ALREADY is the payment's public id (`pubPay`), minted
   * before the charge and written onto the row after it — so here `ref === key` and no
   * "not the key" assertion is possible. That coincidence is exactly why the fallback
   * looked harmless: the key format is a call site's private choice, not part of the
   * contract, and the invoice path shows what happens when it differs. So this asserts
   * the ref IS the payment id and resolves, which is the contract either way.
   */
  const capD31 = cap31.charge[1];
  ok(
    "#31-D1: a wallet top-up charge is tagged with the PAYMENT's public id",
    capD31?.ref != null && capD31.ref === topupPay31?.publicId,
    `ref=${capD31?.ref ?? "MISSING"} payment=${topupPay31?.publicId ?? "?"}`,
  );
  ok(
    "#31-D2: …and it RESOLVES to the payment",
    (await resolve31(capD31?.ref)) === "payment",
    `ref=${capD31?.ref ?? "MISSING"} resolved=${(await resolve31(capD31?.ref)) ?? "NOTHING"}`,
  );

  // ── (E) initiateVaultSetup ──────────────────────────────────────────────────
  /**
   * A vault setup has no row of ours to name — no payment, no intent, no invoice; the
   * only durable id in hand when the SetupIntent is created is the CUSTOMER whose
   * instrument is being vaulted, and that is also the row a reconciler wants (whose
   * card is this?). `InitiateVaultSetupInput`'s own contract note says the input
   * "carries no identifier of ours at all", which is the same observation.
   */
  const capE31 = cap31.vault[0];
  ok(
    "#31-E1: a vault setup is tagged with the CUSTOMER's public id",
    capE31?.ref != null && capE31.ref === cusRow31.publicId,
    `ref=${capE31?.ref ?? "MISSING"} customer=${cusRow31.publicId}`,
  );
  ok(
    "#31-E2: …and it RESOLVES to the customer",
    (await resolve31(capE31?.ref)) === "customer",
    `ref=${capE31?.ref ?? "MISSING"} resolved=${(await resolve31(capE31?.ref)) ?? "NOTHING"}`,
  );
}

// ── A gateway refusing a refund: a failed refund and a 400, not a stranded reservation ──
// Measured live (GoCardless "refunds not enabled", Braintree "not settled yet"): the throw
// escaped refundPayment, left a `pending` refund claiming the payment, and answered 500.
{
  const orgId = org.organization.id;
  const bizR = await createBusiness({
    organizationId: orgId,
    name: "Refund Refusal",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cusR = await createCustomer({
    organizationId: orgId,
    businessId: bizR.id,
    email: `refusal_${randomUUID().slice(0, 8)}@gw.test`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizR.id,
    customer: cusR,
    token: "tok_4242",
  });
  const { payment: payR } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: bizR.id,
    customerId: cusR.id,
    currency: "USD",
    lines: [{ description: "Refusal probe", amountMinor: 2_400n }],
    collect: true,
  });
  // The refund dialogs' balance notice resolves the account the refund will use, also for an
  // imported payment whose charge transaction carries no account.
  {
    const { invoiceRefundGatewayAccount } = await import("@/modules/credit-notes/service");
    const chargeOf = and(eq(transactions.paymentId, payR!.id), eq(transactions.type, "payment"));
    const [row] = await withTenant(orgId, (tx) =>
      tx
        .select({
          inv: invoices.publicId,
          gwaId: gatewayAccounts.id,
          gwa: gatewayAccounts.publicId,
        })
        .from(transactions)
        .innerJoin(invoices, eq(invoices.id, transactions.invoiceId))
        .innerJoin(gatewayAccounts, eq(gatewayAccounts.id, transactions.gatewayAccountId))
        .where(chargeOf)
        .limit(1),
    );
    const direct = await invoiceRefundGatewayAccount(orgId, bizR.id, row!.inv);
    await withTenant(orgId, (tx) =>
      tx.update(transactions).set({ gatewayAccountId: null }).where(chargeOf),
    );
    const imported = await invoiceRefundGatewayAccount(orgId, bizR.id, row!.inv);
    await withTenant(orgId, (tx) =>
      tx.update(transactions).set({ gatewayAccountId: row!.gwaId }).where(chargeOf),
    );
    const missing = await invoiceRefundGatewayAccount(orgId, bizR.id, "inv_does_not_exist");
    ok(
      "REFUND-ACCOUNT-1: the refund gateway account is the account that took the charge",
      direct?.id === row!.gwa,
      `${direct?.id} vs ${row!.gwa}`,
    );
    ok(
      "REFUND-ACCOUNT-2: …and is still found when the charge transaction has no account (imported)",
      imported?.id === row!.gwa,
      `${imported?.id} vs ${row!.gwa}`,
    );
    ok("REFUND-ACCOUNT-3: an unknown invoice is undefined (404), not null", missing === undefined);
  }
  const protoR = TmtestProvider.prototype as unknown as {
    refund: (i: RefundInput) => Promise<unknown>;
  };
  const origRefund = protoR.refund;
  protoR.refund = async () => {
    throw new ProviderRefusalError("Refunds are not enabled on this test account.");
  };
  let msgR = "";
  try {
    await refundPayment({
      organizationId: orgId,
      businessId: bizR.id,
      paymentPublicId: payR!.publicId,
    });
  } catch (e) {
    msgR = e instanceof RefundError ? e.message : `not a RefundError: ${(e as Error).message}`;
  } finally {
    protoR.refund = origRefund;
  }
  ok(
    "REFUSAL-1: a gateway refusal is a RefundError naming the gateway's reason",
    msgR.includes("Refunds are not enabled on this test account."),
    msgR,
  );
  const rowsR = await withTenant(orgId, (tx) =>
    tx.select().from(refunds).where(eq(refunds.paymentId, payR!.id)),
  );
  ok(
    "REFUSAL-2: …its refund is failed, not left pending",
    rowsR.length === 1 && rowsR[0]!.status === "failed",
    rowsR.map((r) => r.status).join(","),
  );
  const txR = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.paymentId, payR!.id)),
  );
  ok(
    "REFUSAL-3: …the refused attempt is on the record",
    txR.some(
      (t) => t.type === "refund" && t.status === "failed" && t.errorCode === "refund_refused",
    ),
  );
  const again = await refundPayment({
    organizationId: orgId,
    businessId: bizR.id,
    paymentPublicId: payR!.publicId,
  }).catch((e) => e as Error);
  ok(
    "REFUSAL-4: …and the whole amount can still be refunded afterwards",
    !(again instanceof Error) && again.amountMinor === 2_400n,
    again instanceof Error ? again.message : String(again.amountMinor),
  );
}

// ── report ───────────────────────────────────────────────────────────────────
let pass = true;
for (const [n, c, detail] of checks) {
  // The detail rides on FAILURES only: on a passing line it is noise, and on a failing
  // one it is usually the entire finding.
  console.log(`  ${c ? "✓" : "✗"} ${n}${!c && detail ? ` — ${detail}` : ""}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ GATEWAY: PASS" : "❌ GATEWAY: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
