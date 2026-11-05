/**
 * verify:square — the Square adapter, offline. No network: API answers come from a stubbed
 * `fetch`, in the shapes the sandbox returned (measured 2026-10-25).
 *
 * Covers the webhook signature (URL + body), event mapping, decline mapping, the charge
 * initiator, idempotency after a lost answer, refunds, the `sdk` flows (card on file, pay-now
 * wallets, ACH), webhook provisioning, capabilities and the catalog.
 *
 *   pnpm verify:square
 */
import { closeDb } from "@/platform/db";
import {
  SQUARE_HOSTED_PREFIX,
  SQUARE_PAY_NOW_METHODS,
  SQUARE_VERSION,
  SQUARE_WEBHOOK_EVENTS,
  SquareProvider,
  chargeResultFromPayment,
  decodeSquareIntent,
  normalizeSquareNotification,
  signSquarePayload,
  squareCustomerDetails,
  squareIdempotencyKey,
  squareMethodUsed,
  squareHostedRef,
  squareHostedReference,
  squareReference,
  verifySquareSignature,
  type SquareNotification,
  type SquarePayment,
} from "@/providers/square";
import {
  DECLINE_SETS,
  declineHiddenFromPayer,
  normalizeSquareDecline,
} from "@/providers/decline-codes";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { GATEWAY_FACTORIES, GatewayResolveError } from "@/providers/gateways";
import { buildNotificationUrl } from "@/modules/gateway/webhook-endpoint";
import { ProviderIndeterminateError, ProviderRefusalError } from "@/providers/types";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push([name, cond, detail]);
const throws = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

// ── 1 · signature ──────────────────────────────────────────────────────────
// Square's own published vector (its SDK test suite): a real delivery, key and URL.
const VECTOR = {
  body: '{"merchant_id":"MLEFBHHSJGVHD","type":"webhooks.test_notification","event_id":"ac3ac95b-f97d-458c-a6e6-18981597e05f","created_at":"2022-07-13T20:30:59.037339943Z","data":{"type":"webhooks","id":"bc368e64-01aa-407e-b46e-3231809b1129"}}',
  header: "GF4YkrJgGBDZ9NIYbNXBnMzqb2HoL4RW/S6vkZ9/2N4=",
  key: "Ibxx_5AKakO-3qeNVR61Dw",
  url: "https://webhook.site/679a4f3a-dcfa-49ee-bac5-9d0edad886b9",
};
{
  ok(
    "signature: Square's published vector checks",
    verifySquareSignature(VECTOR.key, VECTOR.header, [VECTOR.url], VECTOR.body) === VECTOR.url,
  );
  ok(
    "signature: our signer reproduces Square's vector",
    signSquarePayload(VECTOR.key, VECTOR.url, VECTOR.body) === VECTOR.header,
  );
  ok(
    "signature: a tampered body is refused",
    (await throws(() =>
      verifySquareSignature(
        VECTOR.key,
        VECTOR.header,
        [VECTOR.url],
        VECTOR.body.replace("13T20", "13T21"),
      ),
    )) instanceof Error,
  );
  ok(
    "signature: the wrong key is refused",
    (await throws(() =>
      verifySquareSignature("MCmhFRxGX82xMwg5FsaoQA", VECTOR.header, [VECTOR.url], VECTOR.body),
    )) instanceof Error,
  );
  ok(
    "signature: the wrong URL is refused (the URL is signed)",
    (await throws(() =>
      verifySquareSignature(
        VECTOR.key,
        VECTOR.header,
        [VECTOR.url.replace("679a", "79a")],
        VECTOR.body,
      ),
    )) instanceof Error,
  );
  ok(
    "signature: a query string is part of the signed URL",
    (await throws(() =>
      verifySquareSignature(VECTOR.key, VECTOR.header, [`${VECTOR.url}?id=gwa_x`], VECTOR.body),
    )) instanceof Error,
  );
  ok(
    "signature: no header is refused",
    (await throws(() =>
      verifySquareSignature(VECTOR.key, undefined, [VECTOR.url], VECTOR.body),
    )) instanceof Error,
  );
  ok(
    "signature: no URL to check against is refused",
    (await throws(() =>
      verifySquareSignature(VECTOR.key, VECTOR.header, [], VECTOR.body),
    )) instanceof Error,
  );
  ok(
    "signature: the second candidate URL is tried",
    verifySquareSignature(
      VECTOR.key,
      VECTOR.header,
      ["https://other.example.com/x", VECTOR.url],
      VECTOR.body,
    ) === VECTOR.url,
  );
}

const KEY = "Sig_key_XXXXXXXXXXXX01";
const URL_ = "https://hooks.example.com/v1/gateway_webhooks/square?id=gwa_XXXXXXXXXXXX01";
const HOST = "https://square.invalid";
const adapter = (extra: Partial<ConstructorParameters<typeof SquareProvider>[0]> = {}) =>
  new SquareProvider({
    accessToken: "x",
    applicationId: "sandbox-sq0idb-XXXXXXXXXXXXXXXXXXXX01",
    locationId: "LXXXXXXXXXXX1",
    signatureKey: KEY,
    livemode: false,
    apiHost: HOST,
    ...extra,
  });

const REF = squareReference("pi_attempt_1");
const payment = (over: Partial<SquarePayment> = {}): SquarePayment => ({
  id: "PXXXXXXXXXXXXXXXXXXXXXXXXX01",
  status: "COMPLETED",
  source_type: "CARD",
  created_at: "2026-10-25T10:00:00.000Z",
  amount_money: { amount: 1234, currency: "USD" },
  total_money: { amount: 1234, currency: "USD" },
  reference_id: REF,
  customer_id: "CXXXXXXXXXXXXXXXXXXXXXXX01",
  version_token: "v1",
  card_details: {
    status: "CAPTURED",
    card: { card_brand: "VISA", last_4: "5858", exp_month: 10, exp_year: 2028 },
  },
  ...over,
});
const note = (type: string, object: Record<string, unknown>, id = "obj"): SquareNotification => ({
  merchant_id: "MXXXXXXXXXXX1",
  type,
  event_id: "00000000-0000-4000-8000-000000000001",
  created_at: "2026-10-25T10:00:01Z",
  data: { type: type.split(".")[0], id, object },
});

// ── 2 · normalizeWebhook end to end ────────────────────────────────────────
{
  const body = JSON.stringify(note("payment.updated", { payment: payment() }));
  const sig = { "x-square-hmacsha256-signature": signSquarePayload(KEY, URL_, body) };
  const evs = await adapter().normalizeWebhook({
    payload: body,
    headers: sig,
    notificationUrl: URL_,
  });
  ok("webhook: a signed delivery normalizes", evs[0]?.type === "charge.succeeded");
  ok(
    "webhook: the event id is Square's event_id, stable across retries",
    evs[0]?.providerEventId === "sq_00000000-0000-4000-8000-000000000001" &&
      adapter().webhookEventId({ payload: body, headers: {} }) === evs[0]?.providerEventId,
  );
  ok(
    "webhook: the URL can come from the account instead of the route",
    (await adapter({ notificationUrl: URL_ }).normalizeWebhook({ payload: body, headers: sig }))[0]
      ?.type === "charge.succeeded",
  );
  ok(
    "webhook: a delivery signed for another URL is refused",
    (await throws(() =>
      adapter().normalizeWebhook({ payload: body, headers: sig, notificationUrl: `${URL_}x` }),
    )) instanceof Error,
  );
  ok(
    "webhook: an account without a signature key refuses every delivery",
    (await throws(() =>
      adapter({ signatureKey: undefined }).normalizeWebhook({
        payload: body,
        headers: sig,
        notificationUrl: URL_,
      }),
    )) instanceof Error,
  );
}

// ── 3 · event mapping (payload shapes from Square's webhook test endpoint) ──
{
  const map = (n: SquareNotification) => normalizeSquareNotification(n, "e1", n);
  const one = (n: SquareNotification) => map(n)[0]!;
  ok(
    "event: payment COMPLETED → charge.succeeded",
    one(note("payment.updated", { payment: payment() })).type === "charge.succeeded",
  );
  ok(
    "event: payment.created COMPLETED → charge.succeeded",
    one(note("payment.created", { payment: payment() })).type === "charge.succeeded",
  );
  ok(
    "capturedAmountMinor: a COMPLETED payment carries total_money (amount plus tip)",
    one(note("payment.updated", { payment: payment() })).capturedAmountMinor === 1234n &&
      one(
        note("payment.updated", {
          payment: payment({ total_money: { amount: 1434, currency: "USD" } }),
        }),
      ).capturedAmountMinor === 1434n,
  );
  ok(
    "capturedAmountMinor: unset on an APPROVED hold",
    one(note("payment.created", { payment: payment({ status: "APPROVED" }) }))
      .capturedAmountMinor === undefined,
  );
  const auth = one(note("payment.created", { payment: payment({ status: "APPROVED" }) }));
  ok(
    "event: payment APPROVED → intent.authorized on the payment id",
    auth.type === "intent.authorized" && auth.providerIntentId === payment().id,
  );
  ok(
    "event: payment PENDING (ACH) → charge.pending",
    one(
      note("payment.updated", {
        payment: payment({ status: "PENDING", source_type: "BANK_ACCOUNT" }),
      }),
    ).type === "charge.pending",
  );
  ok(
    "event: payment CANCELED → intent.voided",
    one(note("payment.updated", { payment: payment({ status: "CANCELED" }) })).type ===
      "intent.voided",
  );
  const failed = one(
    note("payment.updated", {
      payment: payment({
        status: "FAILED",
        card_details: {
          status: "FAILED",
          card: { card_brand: "VISA" },
          errors: [
            {
              code: "CVV_FAILURE",
              category: "PAYMENT_METHOD_ERROR",
              detail: "Authorization error: 'CVV_FAILURE'",
            },
          ],
        },
      }),
    }),
  );
  ok(
    "event: payment FAILED → charge.failed with the normalized decline",
    failed.type === "charge.failed" &&
      failed.failureCode === "incorrect_cvc" &&
      failed.providerFailureCode === "CVV_FAILURE",
  );
  // Shape measured on a sandbox `bnon:bank-nonce-insufficient-funds` debit.
  const achFailed = one(
    note("payment.updated", {
      payment: payment({
        status: "FAILED",
        source_type: "BANK_ACCOUNT",
        bank_account_details: {
          transfer_type: "ACH",
          errors: [
            {
              code: "INSUFFICIENT_FUNDS",
              category: "PAYMENT_METHOD_ERROR",
              detail: "Banking error: 'INSUFFICIENT_FUNDS'",
            },
          ],
        },
      }),
    }),
  );
  ok(
    "event: ACH payment FAILED → charge.failed with the bank's reason",
    achFailed.type === "charge.failed" &&
      achFailed.failureCode === "insufficient_funds" &&
      achFailed.providerFailureCode === "INSUFFICIENT_FUNDS",
  );
  ok("event: our reference_id → ours", auth.ownership === "ours");
  const tagged = one(
    note("payment.updated", {
      payment: payment({ reference_id: squareReference("k1", "inv_XXXXXXXXXXXXXXXXXXXXXX01") }),
    }),
  );
  ok(
    "event: a reference carrying our ownership ref → ours, with that ref and the intent id",
    tagged.ownership === "ours" &&
      tagged.ownershipRef === "inv_XXXXXXXXXXXXXXXXXXXXXX01" &&
      tagged.providerIntentId === payment().id &&
      tagged.amountMinor === 1234n,
  );
  ok(
    "event: our reference at another location of the seller → foreign",
    normalizeSquareNotification(
      note("payment.updated", {
        payment: payment({ location_id: "LXXXXXXXXXXX2" }),
      }),
      "e1",
      null,
      { locationId: "LXXXXXXXXXXX1" },
    )[0]!.ownership === "foreign",
  );
  ok(
    "event: no reference_id → foreign",
    one(note("payment.updated", { payment: payment({ reference_id: undefined }) })).ownership ===
      "foreign",
  );
  ok(
    "event: providerObjectCreatedAt is the payment's created_at",
    auth.providerObjectCreatedAt?.toISOString() === "2026-10-25T10:00:00.000Z",
  );
  const refund = {
    id: "PXXXXXXXXXXXXXXXXXXXXXXXXX01_RXXXXXXXXXX01",
    payment_id: payment().id,
    amount_money: { amount: 234, currency: "USD" },
    created_at: "2026-10-25T10:00:00Z",
  };
  const rp = one(note("refund.created", { refund: { ...refund, status: "PENDING" } }));
  ok(
    "event: refund PENDING → refund.pending",
    rp.type === "refund.pending" && rp.providerRefundId === refund.id,
  );
  const rc = one(note("refund.updated", { refund: { ...refund, status: "COMPLETED" } }));
  ok(
    "event: refund COMPLETED → charge.refunded, one refund record at its own amount",
    rc.type === "charge.refunded" &&
      rc.providerChargeId === payment().id &&
      rc.amountRefundedMinor === undefined &&
      rc.refunds?.length === 1 &&
      rc.refunds[0]!.providerRefundId === refund.id &&
      rc.refunds[0]!.amountMinor === 234n &&
      rc.refunds[0]!.status === "succeeded",
  );
  ok(
    "event: refund REJECTED → refund.failed",
    one(note("refund.updated", { refund: { ...refund, status: "REJECTED" } })).type ===
      "refund.failed",
  );
  ok(
    "event: refund FAILED → refund.failed",
    one(note("refund.updated", { refund: { ...refund, status: "FAILED" } })).type ===
      "refund.failed",
  );
  const dispute = {
    id: "DXXXXXXXXXXXXXXXXX01",
    state: "EVIDENCE_REQUIRED",
    reason: "AMOUNT_DIFFERS",
    amount_money: { amount: 8801, currency: "USD" },
    due_at: "2026-11-04T00:00:00.000Z",
    disputed_payment: { payment_id: payment().id },
  };
  const dc = one(note("dispute.created", { dispute }));
  ok(
    "event: dispute.created → dispute.created with id, charge, amount, deadline",
    dc.type === "dispute.created" &&
      dc.providerDisputeId === dispute.id &&
      dc.providerChargeId === payment().id &&
      dc.disputeAmountMinor === 8801n &&
      dc.evidenceDueBy?.toISOString() === "2026-11-04T00:00:00.000Z" &&
      dc.disputeStatus === "EVIDENCE_REQUIRED",
  );
  const opened = map(note("dispute.created", { dispute }));
  ok(
    "event: an open chargeback also withdraws the funds (Square withholds them)",
    opened.map((e) => e.type).join() === "dispute.created,dispute.funds_withdrawn" &&
      opened[1]!.disputeAmountMinor === 8801n,
  );
  ok(
    "event: an inquiry moves no money",
    map(note("dispute.created", { dispute: { ...dispute, state: "INQUIRY_EVIDENCE_REQUIRED" } }))
      .map((e) => e.type)
      .join() === "dispute.created",
  );
  ok(
    "event: dispute WON → dispute.won",
    one(note("dispute.state.updated", { dispute: { ...dispute, state: "WON" } })).type ===
      "dispute.won",
  );
  ok(
    "event: dispute LOST → dispute.lost",
    one(note("dispute.state.updated", { dispute: { ...dispute, state: "LOST" } })).type ===
      "dispute.lost",
  );
  ok(
    "event: dispute ACCEPTED → dispute.lost",
    one(note("dispute.state.updated", { dispute: { ...dispute, state: "ACCEPTED" } })).type ===
      "dispute.lost",
  );
  ok(
    "event: dispute PROCESSING → dispute.created (upsert)",
    one(note("dispute.state.updated", { dispute: { ...dispute, state: "PROCESSING" } })).type ===
      "dispute.created",
  );
  const card = {
    id: "ccof:XXXXXXXXXXXXXXXX01",
    card_brand: "MASTERCARD",
    last_4: "9029",
    exp_month: 11,
    exp_year: 2030,
    enabled: true,
  };
  const cu = one(note("card.automatically_updated", { card }));
  ok(
    "event: card.automatically_updated → payment_method.updated with new card fields",
    cu.type === "payment_method.updated" &&
      cu.providerPaymentMethodId === card.id &&
      cu.card?.last4 === "9029" &&
      cu.card?.expYear === 2030 &&
      cu.card?.brand === "mastercard",
  );
  ok(
    "event: card.disabled → payment_method.detached",
    one(note("card.disabled", { card: { ...card, enabled: false } })).type ===
      "payment_method.detached",
  );
  ok(
    "event: card.forgotten → payment_method.detached",
    one(note("card.forgotten", { card: { id: card.id, enabled: false } })).type ===
      "payment_method.detached",
  );
  ok("event: anything else → unknown", one(note("customer.created", {})).type === "unknown");
  ok(
    "event: we register exactly the events we map",
    SQUARE_WEBHOOK_EVENTS.every(
      (t) => !t.startsWith("customer.") && !t.startsWith("subscription."),
    ),
  );
}

// ── 4 · declines ───────────────────────────────────────────────────────────
{
  const d = (code: string) => normalizeSquareDecline({ code });
  ok(
    "decline: GENERIC_DECLINE → card_declined, retriable",
    d("GENERIC_DECLINE").code === "card_declined" && d("GENERIC_DECLINE").retriable,
  );
  ok("decline: CVV_FAILURE → incorrect_cvc", d("CVV_FAILURE").code === "incorrect_cvc");
  ok(
    "decline: ADDRESS_VERIFICATION_FAILURE → card_declined",
    d("ADDRESS_VERIFICATION_FAILURE").code === "card_declined",
  );
  ok(
    "decline: INSUFFICIENT_FUNDS → insufficient_funds",
    d("INSUFFICIENT_FUNDS").code === "insufficient_funds",
  );
  ok(
    "decline: CARD_EXPIRED → expired_card, not retriable",
    d("CARD_EXPIRED").code === "expired_card" && !d("CARD_EXPIRED").retriable,
  );
  ok(
    "decline: CARD_DECLINED_VERIFICATION_REQUIRED → authentication_required",
    d("CARD_DECLINED_VERIFICATION_REQUIRED").code === "authentication_required",
  );
  const nf = d("NOT_FOUND");
  ok(
    "decline: NOT_FOUND (a disabled card) → payment_method_not_found, not retriable",
    nf.code === "payment_method_not_found" &&
      !nf.retriable &&
      nf.ruleId === "square.code.card_not_found",
  );
  const cur = d("CURRENCY_MISMATCH");
  ok(
    "decline: a currency refusal is ours, hidden from the payer",
    cur.code === "gateway_request_rejected" && declineHiddenFromPayer(cur.code),
  );
  ok(
    "decline: SOURCE_USED → enter the details again",
    d("SOURCE_USED").code === "processing_error" &&
      d("SOURCE_USED").retriable &&
      d("SOURCE_USED").exposedToPayer === true,
  );
  ok(
    "decline: every rule id is square.*",
    DECLINE_SETS.square.rules.every((r) => r.id.startsWith("square.code.")),
  );
  ok(
    "decline: rule ids are unique",
    new Set(DECLINE_SETS.square.rules.map((r) => r.id)).size === DECLINE_SETS.square.rules.length,
  );
}

// ── 5 · initiator, method used, capabilities, catalog ──────────────────────
{
  ok(
    "initiator: absent → merchant-initiated",
    squareCustomerDetails(undefined).customer_initiated === false,
  );
  ok(
    "initiator: merchant renewal → customer_initiated false",
    squareCustomerDetails({ by: "merchant", recurring: true }).customer_initiated === false,
  );
  ok(
    "initiator: buyer present → customer_initiated true",
    squareCustomerDetails({ by: "customer", recurring: false }).customer_initiated === true,
  );
  ok(
    "initiator: never seller_keyed_in",
    squareCustomerDetails({ by: "customer", recurring: true }).seller_keyed_in === false,
  );
  ok(
    "method used: Cash App Pay",
    squareMethodUsed({ id: "x", source_type: "WALLET", wallet_details: { brand: "CASH_APP" } }) ===
      "cash_app_pay",
  );
  ok(
    "method used: Afterpay",
    squareMethodUsed({ id: "x", source_type: "BUY_NOW_PAY_LATER" }) === "afterpay",
  );
  ok(
    "method used: us_bank_account",
    squareMethodUsed({ id: "x", source_type: "BANK_ACCOUNT" }) === "us_bank_account",
  );
  ok(
    "method used: a card with a wallet claim keeps the claim",
    squareMethodUsed({ id: "x", source_type: "CARD" }, "google_pay") === "google_pay",
  );
  ok(
    "method used: a non-card source ignores a card claim",
    squareMethodUsed({ id: "x", source_type: "BANK_ACCOUNT" }, "apple_pay") === "us_bank_account",
  );

  const caps = adapter().capabilities;
  ok("capabilities: cards only for routing and renewals", caps.methods.join() === "card");
  ok(
    "capabilities: refunds, partial refunds, intents, void",
    caps.refunds && caps.partialRefunds && caps.intents === true && caps.intentVoid === true,
  );
  ok(
    "capabilities: no mandate model",
    caps.mandates === false && caps.perDebitMandateReference === false,
  );
  ok("capabilities: setup and payment intents", caps.intentPurposes?.join() === "payment,setup");

  const def = GATEWAYS.square;
  ok("catalog: key and name", def.key === "square" && def.displayName === "Square");
  ok(
    "catalog: the operator enters token, application id and location",
    def.credentialFields.map((f) => f.key).join() === "access_token,application_id,location_id",
  );
  ok("catalog: the gateway mints the webhook key", def.webhook.secret === "provider_minted");
  ok(
    "catalog: the account id rides the query string (accepted, measured)",
    !def.webhook.accountIdInPath,
  );
  ok(
    "catalog: the notification URL carries ?id=",
    buildNotificationUrl({ gatewayKey: "square", gatewayAccountPublicId: "gwa_x" }).endsWith(
      "/v1/gateway_webhooks/square?id=gwa_x",
    ),
  );
  ok(
    "catalog: advertised methods equal the adapter's",
    def.advertisedMethods.join() === caps.methods.join(),
  );
  const build = (creds: Record<string, string>, livemode = false) =>
    throws(() => GATEWAY_FACTORIES.square.build(creds, { businessId: "b", livemode }));
  const good = {
    access_token: "x",
    application_id: "sandbox-sq0idb-XXXXXXXXXXXX01",
    location_id: "LXXXXXXXXXXX1",
  };
  ok("factory: good sandbox credentials build", (await build(good)) === null);
  ok(
    "factory: a sandbox Application ID on a live business is refused",
    (await build(good, true)) instanceof GatewayResolveError,
  );
  ok(
    "factory: a live Application ID on a test business is refused",
    (await build({ ...good, application_id: "sq0idp-XXXXXXXXXXXX01" })) instanceof
      GatewayResolveError,
  );
  ok(
    "factory: a malformed Application ID is refused",
    (await build({ ...good, application_id: "app_x" })) instanceof GatewayResolveError,
  );
  ok(
    "factory: a malformed location is refused",
    (await build({ ...good, location_id: "loc id" })) instanceof GatewayResolveError,
  );
  ok(
    "factory: a missing token is refused",
    (await build({ ...good, access_token: "" })) instanceof GatewayResolveError,
  );
  ok(
    "keys: idempotency keys fit Square's 45 characters",
    squareIdempotencyKey("pay", "x".repeat(200)).length <= 45,
  );
  ok(
    "keys: reference_id is 40 characters and stable",
    REF.length === 40 && squareReference("pi_attempt_1") === REF,
  );
  const tag = squareReference("pi_attempt_1", "inv_XXXXXXXXXXXXXXXXXXXXXX01");
  ok(
    "keys: a reference carries the ownership ref, fits 40, and differs per key",
    tag.length === 40 &&
      tag.startsWith("tm-inv_XXXXXXXXXXXXXXXXXXXXXX01-") &&
      tag !== squareReference("pi_attempt_2", "inv_XXXXXXXXXXXXXXXXXXXXXX01"),
  );
  ok(
    "keys: an ownership ref too long to fit falls back to the plain reference",
    squareReference("pi_attempt_1", "x".repeat(40)) === REF,
  );
}

// ── 6 · the adapter against a stubbed Square ───────────────────────────────
type Answer = { status?: number; body?: unknown; network?: boolean };
const realFetch = globalThis.fetch;
let calls: Array<{
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> = [];
let answer: (
  method: string,
  path: string,
  body: Record<string, unknown>,
  n: number,
) => Answer = () => ({ body: {} });
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = new URL(String(url));
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({
    method,
    path: u.pathname + u.search,
    body,
    headers: (init?.headers ?? {}) as Record<string, string>,
  });
  const a = answer(method, u.pathname, body, calls.length);
  if (a.network) throw new TypeError("fetch failed");
  return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
}) as typeof fetch;
const reset = (fn: typeof answer) => {
  calls = [];
  answer = fn;
};

try {
  const sq = adapter();
  const customer = {
    providerKey: "square" as const,
    providerCustomerId: "CXXXXXXXXXXXXXXXXXXXXXXX01",
  };
  const pm = {
    providerKey: "square" as const,
    providerPaymentMethodId: "ccof:XXXXXXXXXXXXXXXX01",
    display: { type: "card" as const },
  };
  const chargeInput = {
    amountMinor: 1234n,
    currency: "usd",
    customer,
    paymentMethod: pm,
    idempotencyKey: "pi_attempt_1",
    initiator: { by: "merchant" as const, recurring: true },
  };

  // charge
  reset(() => ({ body: { payment: payment() } }));
  const c = await sq.charge(chargeInput);
  const sent = calls[0]!;
  ok(
    "charge: one POST /v2/payments",
    calls.length === 1 && sent.method === "POST" && sent.path === "/v2/payments",
  );
  ok("charge: Square-Version header", sent.headers["Square-Version"] === SQUARE_VERSION);
  ok(
    "charge: card on file + customer + location + amount in minor units",
    sent.body.source_id === pm.providerPaymentMethodId &&
      sent.body.customer_id === customer.providerCustomerId &&
      sent.body.location_id === "LXXXXXXXXXXX1" &&
      JSON.stringify(sent.body.amount_money) === '{"amount":1234,"currency":"USD"}',
  );
  ok(
    "charge: autocomplete, our reference, merchant-initiated",
    sent.body.autocomplete === true &&
      sent.body.reference_id === REF &&
      (sent.body.customer_details as { customer_initiated: boolean }).customer_initiated === false,
  );
  ok(
    "charge: idempotency key derived from ours, ≤45",
    sent.body.idempotency_key === squareIdempotencyKey("pay", "pi_attempt_1") &&
      String(sent.body.idempotency_key).length <= 45,
  );
  ok(
    "charge: COMPLETED → succeeded, method card",
    c.status === "succeeded" && c.providerChargeId === payment().id && c.methodUsed === "card",
  );

  // a decline answers 400 with the FAILED payment
  reset(() => ({
    status: 400,
    body: {
      errors: [
        {
          code: "GENERIC_DECLINE",
          category: "PAYMENT_METHOD_ERROR",
          detail: "Authorization error: 'GENERIC_DECLINE'",
        },
      ],
      payment: payment({
        status: "FAILED",
        card_details: {
          status: "FAILED",
          errors: [{ code: "GENERIC_DECLINE", category: "PAYMENT_METHOD_ERROR" }],
        },
      }),
    },
  }));
  const declined = await sq.charge(chargeInput);
  ok(
    "charge: a decline is a failed result with the payment id",
    declined.status === "failed" &&
      declined.providerChargeId === payment().id &&
      declined.failure?.code === "card_declined",
  );

  reset(() => ({
    status: 404,
    body: {
      errors: [
        {
          code: "NOT_FOUND",
          category: "INVALID_REQUEST_ERROR",
          field: "source_id",
          detail: "Did not find matching card",
        },
      ],
    },
  }));
  const gone = await sq.charge(chargeInput);
  ok(
    "charge: a disabled card fails as payment_method_not_found",
    gone.status === "failed" &&
      gone.failure?.code === "payment_method_not_found" &&
      !gone.failure.retriable,
  );

  reset(() => ({
    status: 400,
    body: {
      errors: [
        {
          code: "INVALID_VALUE",
          category: "INVALID_REQUEST_ERROR",
          field: "amount_money.currency",
          detail: "This merchant can only process payments in USD, but amount was provided in EUR.",
        },
      ],
    },
  }));
  const wrongCur = await sq.charge({ ...chargeInput, currency: "eur" });
  ok(
    "charge: another currency fails as our setup problem",
    wrongCur.status === "failed" && wrongCur.failure?.code === "gateway_request_rejected",
  );

  const reused = {
    errors: [{ code: "IDEMPOTENCY_KEY_REUSED", category: "INVALID_REQUEST_ERROR" }],
  };
  reset((m) =>
    m === "POST" ? { status: 400, body: reused } : { body: { payments: [payment()] } },
  );
  const reusedFound = await sq.charge(chargeInput);
  ok(
    "charge: IDEMPOTENCY_KEY_REUSED answers with the payment the key made",
    reusedFound.status === "succeeded" && reusedFound.providerChargeId === payment().id,
  );
  reset((m) => (m === "POST" ? { status: 400, body: reused } : { body: { payments: [] } }));
  ok(
    "charge: IDEMPOTENCY_KEY_REUSED with nothing found is indeterminate, never a failure",
    (await throws(() => sq.charge(chargeInput))) instanceof ProviderIndeterminateError,
  );
  reset((m) =>
    m === "POST"
      ? { status: 409, body: { errors: [{ code: "CONFLICT", category: "INVALID_REQUEST_ERROR" }] } }
      : { body: { payments: [] } },
  );
  ok(
    "charge: a 409 is replayed with the same key, then indeterminate",
    (await throws(() => sq.charge(chargeInput))) instanceof ProviderIndeterminateError &&
      calls.filter((x) => x.method === "POST").length === 2,
  );

  reset(() => ({
    status: 401,
    body: { errors: [{ code: "UNAUTHORIZED", category: "AUTHENTICATION_ERROR" }] },
  }));
  ok(
    "charge: a refused token throws",
    (await throws(() => sq.charge(chargeInput))) instanceof Error,
  );

  // lost answers
  reset((_m, _p, _b, n) => (n === 1 ? { status: 503 } : { body: { payment: payment() } }));
  const replayed = await sq.charge(chargeInput);
  ok(
    "idempotency: a lost answer is replayed with the same key",
    replayed.status === "succeeded" &&
      calls.length === 2 &&
      calls[1]!.body.idempotency_key === calls[0]!.body.idempotency_key,
  );
  reset((m, p) =>
    m === "POST" && p === "/v2/payments"
      ? { network: true }
      : { body: { payments: [payment({ reference_id: "tmother" }), payment()] } },
  );
  const found = await sq.charge(chargeInput);
  ok(
    "idempotency: after two lost answers the payment is found by reference",
    found.status === "succeeded" &&
      calls.at(-1)!.method === "GET" &&
      calls.at(-1)!.path.startsWith("/v2/payments?location_id=LXXXXXXXXXXX1"),
  );
  reset((m) => (m === "POST" ? { network: true } : { body: { payments: [] } }));
  ok(
    "idempotency: nothing found → ProviderIndeterminateError",
    (await throws(() => sq.charge(chargeInput))) instanceof ProviderIndeterminateError,
  );
  const since = new Date("2026-10-25T09:50:00.000Z");
  reset(() => ({ body: { payments: [payment()] } }));
  const located = await sq.locateCharge({
    ownershipRef: "x".repeat(40),
    idempotencyKey: "pi_attempt_1",
    amountMinor: 1234n,
    currency: "USD",
    createdAfter: since,
  });
  const q = new URL(`https://x${calls[0]!.path}`).searchParams;
  ok(
    "locate: finds the lost charge by its reference, in a window from the attempt",
    located?.status === "succeeded" &&
      located.providerChargeId === payment().id &&
      q.get("begin_time") === since.toISOString() &&
      q.get("end_time") === "2026-10-25T11:50:00.000Z" &&
      q.get("total") === "1234",
  );
  reset(() => ({ body: { payments: [payment({ reference_id: "tmother" })] } }));
  ok(
    "locate: no payment with our reference → null",
    (await sq.locateCharge({
      ownershipRef: "x".repeat(40),
      idempotencyKey: "pi_attempt_1",
      amountMinor: 1234n,
      currency: "USD",
      createdAfter: since,
    })) === null,
  );
  reset(() => ({ body: { payments: [], cursor: "more" } }));
  ok(
    "locate: a window too large to read in full throws, never null",
    (await throws(() =>
      sq.locateCharge({
        ownershipRef: "x".repeat(40),
        idempotencyKey: "pi_attempt_1",
        amountMinor: 1234n,
        currency: "USD",
        createdAfter: since,
      }),
    )) instanceof Error,
  );
  reset(() => ({ body: { payment: payment() } }));
  const blank = await sq.fetchChargeStatus({ providerChargeId: "" });
  ok(
    "status: an empty charge id is pending and calls nothing",
    blank.status === "pending" && calls.length === 0,
  );

  // refunds
  reset((m) =>
    m === "GET"
      ? { body: { payment: payment({ refunded_money: { amount: 200, currency: "USD" } }) } }
      : {
          body: {
            refund: { id: `${payment().id}_R1`, status: "PENDING", payment_id: payment().id },
          },
        },
  );
  const partial = await sq.refund({
    providerChargeId: payment().id,
    amountMinor: 100n,
    idempotencyKey: "rf_1",
  });
  ok(
    "refund: partial sends that amount in the payment's currency",
    partial.status === "pending" &&
      JSON.stringify(calls[1]!.body.amount_money) === '{"amount":100,"currency":"USD"}' &&
      calls[1]!.path === "/v2/refunds",
  );
  calls = [];
  await sq.refund({ providerChargeId: payment().id, idempotencyKey: "rf_2" });
  ok(
    "refund: full refunds what is left (total − refunded)",
    (calls[1]!.body.amount_money as { amount: number }).amount === 1034,
  );
  reset((m) =>
    m === "GET"
      ? { body: { payment: payment({ status: "APPROVED" }) } }
      : { body: { payment: payment({ status: "CANCELED" }) } },
  );
  const cancel = await sq.refund({ providerChargeId: payment().id, idempotencyKey: "rf_3" });
  ok(
    "refund: a full refund of an uncaptured payment cancels it",
    cancel.status === "succeeded" &&
      calls[1]!.path.endsWith("/cancel") &&
      cancel.providerRefundId === payment().id,
  );
  ok(
    "refund: a partial refund of an uncaptured payment is refused",
    (await throws(() =>
      sq.refund({ providerChargeId: payment().id, amountMinor: 1n, idempotencyKey: "rf_4" }),
    )) instanceof ProviderRefusalError,
  );
  reset((m) =>
    m === "GET"
      ? { body: { payment: payment() } }
      : {
          status: 400,
          body: {
            errors: [
              {
                code: "REFUND_AMOUNT_INVALID",
                category: "REFUND_ERROR",
                detail: "The requested refund amount exceeds the amount available to refund.",
              },
            ],
          },
        },
  );
  ok(
    "refund: Square's refund refusal reaches the operator",
    (await throws(() =>
      sq.refund({ providerChargeId: payment().id, amountMinor: 999999n, idempotencyKey: "rf_5" }),
    )) instanceof ProviderRefusalError,
  );
  reset((m) =>
    m === "GET"
      ? { body: { payment: payment() } }
      : {
          status: 400,
          body: {
            errors: [{ code: "PAYMENT_NOT_REFUNDABLE", category: "INVALID_REQUEST_ERROR" }],
          },
        },
  );
  ok(
    "refund: any other 4xx is a refusal too, so the reservation is released",
    (await throws(() =>
      sq.refund({ providerChargeId: payment().id, amountMinor: 100n, idempotencyKey: "rf_6" }),
    )) instanceof ProviderRefusalError,
  );
  reset((m) => (m === "GET" ? { body: { payment: payment() } } : { status: 503 }));
  const refund5xx = await throws(() =>
    sq.refund({ providerChargeId: payment().id, amountMinor: 100n, idempotencyKey: "rf_7" }),
  );
  ok(
    "refund: a 5xx is indeterminate, not a refusal",
    refund5xx instanceof ProviderIndeterminateError,
  );
  reset(() => ({ body: { refund: { id: `${payment().id}_R1`, status: "COMPLETED" } } }));
  ok(
    "refund status: COMPLETED → succeeded",
    (await sq.fetchRefundStatus({ providerRefundId: `${payment().id}_R1` })).status === "succeeded",
  );

  // sdk: save a card
  reset(() => ({
    body: { location: { id: "LXXXXXXXXXXX1", country: "US", currency: "USD", status: "ACTIVE" } },
  }));
  const setup = await sq.createIntent({
    purpose: "setup",
    currency: "usd",
    customer,
    idempotencyKey: "pi_setup_1",
    ownershipRef: "pi_XXXX01",
  });
  const sp = setup.authorization?.sdk?.params ?? {};
  ok(
    "sdk: setup is an sdk challenge offering cards only",
    setup.status === "requires_action" &&
      setup.authorization?.mode === "sdk" &&
      JSON.stringify(sp.methods) === '["card"]' &&
      sp.applicationId === "sandbox-sq0idb-XXXXXXXXXXXXXXXXXXXX01" &&
      sp.locationId === "LXXXXXXXXXXX1" &&
      sp.environment === "sandbox",
  );
  ok(
    "sdk: the setup id carries the customer",
    decodeSquareIntent(setup.intentId)?.c === customer.providerCustomerId,
  );
  reset(() => ({
    body: {
      card: {
        id: "ccof:XXXXXXXXXXXXXXXX02",
        card_brand: "VISA",
        last_4: "5858",
        customer_id: customer.providerCustomerId,
        enabled: true,
      },
    },
  }));
  const saved = await sq.submitClientResult({
    intentId: setup.intentId,
    purpose: "setup",
    clientResult: { token: "cnon:card-nonce-ok", method: "card" },
    idempotencyKey: "k1",
  });
  ok(
    "sdk: a card token is saved with POST /v2/cards on the customer",
    saved.status === "authorized" &&
      saved.gatewayIntentId === "ccof:XXXXXXXXXXXXXXXX02" &&
      calls[0]!.path === "/v2/cards" &&
      (calls[0]!.body.card as { customer_id: string }).customer_id === customer.providerCustomerId,
  );
  calls = [];
  const wallet = await sq.submitClientResult({
    intentId: setup.intentId,
    purpose: "setup",
    clientResult: { token: "wnon:cash-app-ok" },
    idempotencyKey: "k2",
  });
  ok("sdk: a non-card token is never saved", wallet.status === "failed" && calls.length === 0);
  reset(() => ({
    status: 400,
    body: {
      errors: [
        { code: "INVALID_CARD_DATA", category: "INVALID_REQUEST_ERROR", field: "source_id" },
      ],
    },
  }));
  const bad = await sq.submitClientResult({
    intentId: setup.intentId,
    purpose: "setup",
    clientResult: { token: "cnon:card-nonce-declined" },
    idempotencyKey: "k3",
  });
  ok(
    "sdk: a refused card (measured INVALID_CARD_DATA) fails the setup",
    bad.status === "failed" && bad.failure?.code === "incorrect_number",
  );
  const junk = await sq.submitClientResult({
    intentId: setup.intentId,
    purpose: "setup",
    clientResult: { token: "<script>" },
    idempotencyKey: "k4",
  });
  ok(
    "sdk: a malformed browser token is refused before any call",
    junk.status === "failed" && junk.failure?.code === "invalid_client_result",
  );
  reset(() => ({
    body: {
      card: {
        id: "ccof:XXXXXXXXXXXXXXXX02",
        card_brand: "VISA",
        last_4: "5858",
        exp_month: 10,
        exp_year: 2028,
        customer_id: customer.providerCustomerId,
        enabled: true,
      },
    },
  }));
  const consumedSetup = await sq.consumeIntent({
    intentId: "ccof:XXXXXXXXXXXXXXXX02",
    purpose: "setup",
    idempotencyKey: "c1",
  });
  ok(
    "sdk: consuming the setup returns the card",
    consumedSetup.purpose === "setup" && consumedSetup.paymentMethod?.display.last4 === "5858",
  );

  // sdk: pay now
  ok(
    "sdk: pay-now does not offer Apple Pay in the SDK (it needs Square's domain file)",
    !(SQUARE_PAY_NOW_METHODS as readonly string[]).includes("apple_pay"),
  );

  // Apple Pay pay-now on a Square payment link
  reset(() => ({
    body: {
      payment_link: {
        id: "LXXXXXXXXXXXXXX01",
        order_id: "OXXXXXXXXXXXXXXXXXXXXXXX01",
        url: "https://square.link/u/XXXXXX01",
      },
    },
  }));
  const linkIntent = await adapter().createIntent({
    purpose: "payment",
    amountMinor: 5000n,
    currency: "usd",
    customer,
    idempotencyKey: "pi_create_pi_XXXXXXXXXXXXXXXXXXXXXXXX_a1",
    ownershipRef: "pi_XXXXXXXXXXXXXXXXXXXXXXXX",
    returnUrl: "https://shop.example.com/portal?pay=return",
    description: "Invoice INV-1",
    hostedWallet: "apple_pay",
  });
  const lb = calls[0]?.body as Record<string, Record<string, unknown>>;
  const orderRef = String(lb?.order?.reference_id);
  ok(
    "apple pay: a payment link with Apple Pay on, our reference on its order, the amount once",
    calls[0]?.path === "/v2/online-checkout/payment-links" &&
      (lb.checkout_options!.accepted_payment_methods as Record<string, boolean>).apple_pay ===
        true &&
      lb.checkout_options!.redirect_url === "https://shop.example.com/portal?pay=return" &&
      lb.checkout_options!.allow_tipping === false &&
      orderRef.length <= 40 &&
      squareHostedRef(orderRef) === "pi_XXXXXXXXXXXXXXXXXXXXXXXX" &&
      orderRef ===
        squareHostedReference(
          "pi_create_pi_XXXXXXXXXXXXXXXXXXXXXXXX_a1",
          "pi_XXXXXXXXXXXXXXXXXXXXXXXX",
        ) &&
      JSON.stringify(
        (lb.order!.line_items as Array<Record<string, unknown>>)[0]!.base_price_money,
      ) === '{"amount":5000,"currency":"USD"}' &&
      typeof lb.idempotency_key === "string",
    JSON.stringify(lb),
  );
  ok(
    "apple pay: the buyer is redirected; the intent is the link's order",
    linkIntent.intentId === `${SQUARE_HOSTED_PREFIX}OXXXXXXXXXXXXXXXXXXXXXXX01` &&
      linkIntent.authorization?.mode === "redirect" &&
      linkIntent.authorization.approvalUrl === "https://square.link/u/XXXXXX01",
  );
  ok(
    "apple pay: a link holds nothing, so a void releases nothing",
    JSON.stringify(
      await adapter().voidIntent({ intentId: linkIntent.intentId, idempotencyKey: "k" }),
    ) === '{"voided":true,"held":false}',
  );
  const linkPayment: SquarePayment = {
    id: "PXXXXXXXXXXXXXXXXXXXXXXX09",
    status: "COMPLETED",
    source_type: "CARD",
    location_id: "LXXXXXXXXXXX1",
    order_id: "OXXXXXXXXXXXXXXXXXXXXXXX01",
    amount_money: { amount: 5000, currency: "USD" },
    total_money: { amount: 5000, currency: "USD" },
  };
  const linkNote = {
    type: "payment.updated",
    created_at: "2026-10-28T10:00:00Z",
    data: { type: "payment", id: linkPayment.id, object: { payment: linkPayment } },
  } as SquareNotification;
  const linkBody = JSON.stringify(linkNote);
  reset((m, path) =>
    path === "/v2/orders/OXXXXXXXXXXXXXXXXXXXXXXX01"
      ? { body: { order: { id: "OXXXXXXXXXXXXXXXXXXXXXXX01", reference_id: orderRef } } }
      : { status: 404, body: {} },
  );
  const linkEvents = await adapter({ notificationUrl: URL_ }).normalizeWebhook({
    payload: linkBody,
    headers: { "x-square-hmacsha256-signature": signSquarePayload(KEY, URL_, linkBody) },
    notificationUrl: URL_,
  });
  ok(
    "apple pay: a completed payment on the link's order books its intent, then the charge",
    calls.length === 1 &&
      linkEvents.length === 2 &&
      linkEvents[0]!.type === "intent.authorized" &&
      linkEvents[0]!.providerIntentId === linkIntent.intentId &&
      linkEvents[0]!.gatewayIntentId === linkPayment.id &&
      linkEvents[0]!.captureState === "succeeded" &&
      linkEvents[0]!.ownershipRef === "pi_XXXXXXXXXXXXXXXXXXXXXXXX" &&
      linkEvents[1]!.type === "charge.succeeded" &&
      linkEvents[1]!.providerChargeId === linkPayment.id &&
      linkEvents[1]!.capturedAmountMinor === 5000n,
    JSON.stringify(linkEvents, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
  );
  reset(() => ({
    body: { order: { id: "OXXXXXXXXXXXXXXXXXXXXXXX01", reference_id: "someone-else" } },
  }));
  const foreignEvents = await adapter({ notificationUrl: URL_ }).normalizeWebhook({
    payload: linkBody,
    headers: { "x-square-hmacsha256-signature": signSquarePayload(KEY, URL_, linkBody) },
    notificationUrl: URL_,
  });
  ok(
    "apple pay: a completed payment on an order that is not ours stays a foreign charge",
    foreignEvents.length === 1 &&
      foreignEvents[0]!.type === "charge.succeeded" &&
      foreignEvents[0]!.ownership === "foreign",
    JSON.stringify(foreignEvents, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
  );
  reset(() => ({ body: {} }));
  normalizeSquareNotification(
    {
      type: "payment.updated",
      data: { object: { payment: { ...linkPayment, reference_id: squareReference("k", "pi_A") } } },
    } as SquareNotification,
    "e",
    null,
  );
  ok("apple pay: a payment with our own reference needs no order read", calls.length === 0);

  reset(() => ({
    body: { location: { id: "LXXXXXXXXXXX1", country: "US", currency: "USD", status: "ACTIVE" } },
  }));
  const payNow = await adapter().createIntent({
    purpose: "payment",
    amountMinor: 5000n,
    currency: "usd",
    customer,
    idempotencyKey: "pi_pay_1",
  });
  const pp = payNow.authorization?.sdk?.params ?? {};
  ok(
    "sdk: pay-now offers every Square method, with the amount and country",
    JSON.stringify(pp.methods) === JSON.stringify(SQUARE_PAY_NOW_METHODS) &&
      pp.amount === "50.00" &&
      pp.countryCode === "US" &&
      pp.currency === "USD",
  );
  reset(() => ({
    body: {
      payment: payment({
        status: "APPROVED",
        source_type: "WALLET",
        wallet_details: { brand: "CASH_APP", status: "AUTHORIZED" },
      }),
    },
  }));
  const cash = await sq.submitClientResult({
    intentId: payNow.intentId,
    purpose: "payment",
    clientResult: { token: "wnon:cash-app-ok", method: "cash_app_pay" },
    idempotencyKey: "k5",
  });
  ok(
    "sdk: a Cash App Pay token is authorized (autocomplete false), not captured",
    cash.status === "authorized" &&
      cash.gatewayIntentId === payment().id &&
      calls[0]!.body.autocomplete === false &&
      calls[0]!.body.source_id === "wnon:cash-app-ok",
  );
  reset((m, p) =>
    m === "GET"
      ? {
          body: {
            payment: payment({
              status: "APPROVED",
              amount_money: { amount: 5000, currency: "USD" },
            }),
          },
        }
      : p.endsWith("/complete")
        ? {
            body: {
              payment: payment({
                status: "COMPLETED",
                amount_money: { amount: 4000, currency: "USD" },
                source_type: "WALLET",
                wallet_details: { brand: "CASH_APP" },
              }),
            },
          }
        : { body: { payment: payment({ status: "APPROVED", version_token: "v2" }) } },
  );
  const captured = await sq.consumeIntent({
    intentId: payment().id,
    purpose: "payment",
    amountMinor: 4000n,
    currency: "USD",
    idempotencyKey: "c2",
  });
  ok(
    "sdk: a lower capture lowers the amount, then completes with the new version",
    calls.map((x) => x.method).join() === "GET,PUT,POST" &&
      calls[2]!.path.endsWith("/complete") &&
      calls[2]!.body.version_token === "v2",
  );
  ok(
    "sdk: the capture records the method the payer used",
    captured.purpose === "payment" &&
      captured.charge.status === "succeeded" &&
      captured.charge.methodUsed === "cash_app_pay",
  );

  calls = [];
  const ach = await sq.submitClientResult({
    intentId: payNow.intentId,
    purpose: "payment",
    clientResult: { token: "bauth:XXXXXXXXXXXX01", method: "ach" },
    idempotencyKey: "k6",
  });
  ok(
    "sdk: an ACH token holds nothing and calls nothing until consume",
    ach.status === "authorized" &&
      calls.length === 0 &&
      ach.gatewayIntentId?.startsWith("sqb_") === true,
  );
  reset(() => ({ body: { payment: payment({ status: "PENDING", source_type: "BANK_ACCOUNT" }) } }));
  const achCharge = await sq.consumeIntent({
    intentId: ach.gatewayIntentId!,
    purpose: "payment",
    amountMinor: 5000n,
    currency: "USD",
    idempotencyKey: "c3",
  });
  ok(
    "sdk: consuming ACH creates the debit with autocomplete true → pending, method ach",
    calls[0]!.body.autocomplete === true &&
      calls[0]!.body.source_id === "bauth:XXXXXXXXXXXX01" &&
      achCharge.purpose === "payment" &&
      achCharge.charge.status === "pending" &&
      achCharge.charge.methodUsed === "us_bank_account",
  );
  calls = [];
  ok(
    "void: an ACH token held nothing",
    (await sq.voidIntent({ intentId: ach.gatewayIntentId!, idempotencyKey: "v1" })).held ===
      false && calls.length === 0,
  );
  ok(
    "void: an unused challenge held nothing",
    (await sq.voidIntent({ intentId: payNow.intentId, idempotencyKey: "v2" })).held === false,
  );
  reset((m) =>
    m === "GET"
      ? { body: { payment: payment({ status: "APPROVED" }) } }
      : { body: { payment: payment({ status: "CANCELED" }) } },
  );
  const voided = await sq.voidIntent({ intentId: payment().id, idempotencyKey: "v3" });
  ok(
    "void: an authorization is canceled and was held",
    voided.voided && voided.held === true && calls[1]!.path.endsWith("/cancel"),
  );

  // stored card authorization (on-session) → customer_initiated
  reset(() => ({ body: { payment: payment({ status: "APPROVED" }) } }));
  const held = await sq.createIntent({
    purpose: "payment",
    amountMinor: 700n,
    currency: "usd",
    customer,
    paymentMethod: pm,
    session: "on_session",
    idempotencyKey: "pi_pay_2",
  });
  ok(
    "intent: a saved-card authorization is authorized, buyer-initiated",
    held.status === "authorized" &&
      (calls[0]!.body.customer_details as { customer_initiated: boolean }).customer_initiated ===
        true,
  );

  // card on file
  reset((m) =>
    m === "POST"
      ? { body: { card: { id: pm.providerPaymentMethodId, enabled: false } } }
      : {
          body: {
            card: {
              id: pm.providerPaymentMethodId,
              enabled: false,
              customer_id: customer.providerCustomerId,
            },
          },
        },
  );
  await sq.deletePaymentMethod({ customer, paymentMethod: pm });
  ok(
    "delete: a card is disabled (Square cannot delete one)",
    calls[0]!.path === `/v2/cards/${encodeURIComponent(pm.providerPaymentMethodId)}/disable`,
  );
  ok(
    "display: a disabled card has no display",
    (await sq.fetchPaymentMethodDisplay({
      providerPaymentMethodId: pm.providerPaymentMethodId,
    })) === null,
  );
  reset(() => ({ status: 404, body: { errors: [{ code: "NOT_FOUND" }] } }));
  ok(
    "delete: an unknown card is already gone",
    (await throws(() => sq.deletePaymentMethod({ customer, paymentMethod: pm }))) === null,
  );

  // customers
  reset((_m, p) =>
    p === "/v2/customers/search"
      ? { body: { customers: [{ id: "CXXXXXXXXXXXXXXXXXXXXXXX09" }] } }
      : { body: {} },
  );
  const existing = await sq.ensureCustomer({
    customerRef: "cus_XXXX01",
    name: "Ada Lovelace",
    email: "ada@example.com",
  });
  ok(
    "customer: an existing one is found by reference_id, nothing created",
    existing.providerCustomerId === "CXXXXXXXXXXXXXXXXXXXXXXX09" && calls.length === 1,
  );
  reset((_m, p) =>
    p === "/v2/customers/search"
      ? { body: {} }
      : { body: { customer: { id: "CXXXXXXXXXXXXXXXXXXXXXXX10" } } },
  );
  await sq.ensureCustomer({
    customerRef: "cus_XXXX01",
    name: "Ada Lovelace",
    email: "ada@example.com",
  });
  ok(
    "customer: a new one carries our reference and the split name",
    calls[1]!.body.reference_id === "cus_XXXX01" &&
      calls[1]!.body.given_name === "Ada" &&
      calls[1]!.body.family_name === "Lovelace",
  );

  // webhook provisioning
  reset((m, p) =>
    m === "GET" && p === "/v2/webhooks/subscriptions"
      ? { body: {} }
      : { body: { subscription: { id: "wbhk_XXXX01", signature_key: KEY } } },
  );
  const made = await sq.provisionWebhookEndpoint({ url: URL_ });
  ok(
    "provision: a new subscription is created for our events at our API version",
    made.webhookSecret === KEY &&
      made.providerEndpointId === "wbhk_XXXX01" &&
      JSON.stringify((calls[1]!.body.subscription as { event_types: string[] }).event_types) ===
        JSON.stringify(SQUARE_WEBHOOK_EVENTS) &&
      (calls[1]!.body.subscription as { api_version: string }).api_version === SQUARE_VERSION,
  );
  reset((m, p) =>
    m === "GET" && p === "/v2/webhooks/subscriptions"
      ? {
          body: {
            subscriptions: [
              {
                id: "wbhk_XXXX02",
                notification_url: URL_,
                enabled: true,
                event_types: [...SQUARE_WEBHOOK_EVENTS],
                api_version: SQUARE_VERSION,
              },
            ],
          },
        }
      : { body: { subscription: { id: "wbhk_XXXX02", signature_key: KEY } } },
  );
  const again = await sq.provisionWebhookEndpoint({ url: URL_ });
  ok(
    "provision: the same URL reuses its subscription and reads the key back",
    again.providerEndpointId === "wbhk_XXXX02" &&
      again.webhookSecret === KEY &&
      calls.map((x) => x.method).join() === "GET,GET",
  );
  reset((m, p) =>
    m === "GET" && p === "/v2/webhooks/subscriptions"
      ? {
          body: {
            subscriptions: [
              {
                id: "wbhk_XXXX03",
                notification_url: URL_,
                enabled: true,
                event_types: [...SQUARE_WEBHOOK_EVENTS],
                api_version: "2021-01-21",
              },
            ],
          },
        }
      : { body: { subscription: { id: "wbhk_XXXX03", signature_key: KEY } } },
  );
  await sq.provisionWebhookEndpoint({ url: URL_ });
  ok(
    "provision: a reused subscription at another API version is moved to ours",
    calls[1]?.method === "PUT" &&
      (calls[1]!.body.subscription as { api_version?: string }).api_version === SQUARE_VERSION,
  );
  ok(
    "provision: an HTTP URL is refused before any call (measured HTTPS_ONLY)",
    (await throws(() => sq.provisionWebhookEndpoint({ url: "http://x.example.com/h" }))) instanceof
      Error,
  );

  // a read-back outcome
  ok(
    "readback: APPROVED is pending for a charge",
    chargeResultFromPayment(payment({ status: "APPROVED" })).status === "pending",
  );
  ok(
    "readback: CANCELED is a failure",
    chargeResultFromPayment(payment({ status: "CANCELED" })).status === "failed",
  );
  reset(() => ({ body: { payment: payment({ status: "CANCELED" }) } }));
  const consumed = await sq
    .consumeIntent({
      intentId: payment().id,
      idempotencyKey: "pi_consume_1",
      purpose: "payment",
      amountMinor: 1234n,
      currency: "USD",
    })
    .catch((e: Error) => e);
  ok(
    "consume: an authorization Square already cancelled answers failed, with no capture call",
    !(consumed instanceof Error) &&
      consumed.purpose === "payment" &&
      consumed.charge.status === "failed" &&
      calls.length === 1,
  );
} finally {
  globalThis.fetch = realFetch;
}

await closeDb().catch(() => undefined);
const failed = checks.filter(([, c]) => !c);
for (const [name, c, detail] of checks)
  console.log(`  ${c ? "✓" : "✗"} ${name}${!c && detail ? ` — ${detail}` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks`);
console.log(failed.length === 0 ? "✅ SQUARE: PASS" : "❌ SQUARE: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
