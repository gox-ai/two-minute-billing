/**
 * verify:checkoutcom — the Checkout.com adapter, offline. No network: API answers come from a
 * stubbed `fetch`, in the shapes the sandbox returned (measured by `verify:checkoutcom-live`).
 *
 * Covers webhook signatures, event mapping, the stored-credential flags, decline mapping,
 * capabilities, the catalogue entry, base-URL and amount building, and the money calls.
 *
 *   pnpm verify:checkoutcom
 */
import { closeDb } from "@/platform/db";
import {
  CHECKOUTCOM_WEBHOOK_EVENTS,
  CHECKOUTCOM_HOSTED_PREFIX,
  CheckoutcomProvider,
  assertCheckoutcomKeyMode,
  checkoutcomHostedReference,
  chargeResultFromPayment,
  checkoutcomApiPrefix,
  checkoutcomBaseUrl,
  checkoutcomStoredCredential,
  decodeCheckoutcomIntent,
  encodeCheckoutcomIntent,
  fromCheckoutcomAmount,
  normalizeCheckoutcomEvent,
  signCheckoutcomPayload,
  toCheckoutcomAmount,
  verifyCheckoutcomSignature,
  type CkoPayment,
} from "@/providers/checkoutcom";
import {
  DECLINE_SETS,
  declineHiddenFromPayer,
  normalizeCheckoutcomDecline,
} from "@/providers/decline-codes";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { GATEWAY_FACTORIES, GatewayResolveError } from "@/providers/gateways";
import {
  ProviderIndeterminateError,
  ProviderRefusalError,
  type NormalizedProviderEvent,
} from "@/providers/types";

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

const KEY = "whkey_offline_test";
const OPTS = {
  secretKey: "sk_sbox_offline",
  publicKey: "pk_sbox_offline",
  processingChannelId: "pc_offline",
  apiPrefix: "abcd1234",
  defaultCountry: "US",
  entityId: "ent_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  livemode: false,
  webhookSecret: KEY,
};

// ── base URL and credentials ─────────────────────────────────────────────────
{
  ok(
    "sandbox base URL is built from the prefix",
    checkoutcomBaseUrl("abcd1234", false) === "https://abcd1234.api.sandbox.checkout.com",
  );
  ok(
    "live base URL is built from the prefix",
    checkoutcomBaseUrl("abcd1234", true) === "https://abcd1234.api.checkout.com",
  );
  ok(
    "a pasted base URL yields its prefix",
    checkoutcomApiPrefix("https://ABCD1234.api.sandbox.checkout.com/") === "abcd1234",
  );
  ok("a bare prefix is kept", checkoutcomApiPrefix(" abcd1234 ") === "abcd1234");
  ok("a malformed prefix is refused", (await throws(() => checkoutcomApiPrefix("abc"))) != null);
  ok(
    "the generic host is refused as a prefix",
    (await throws(() => checkoutcomApiPrefix("https://api.sandbox.checkout.com"))) != null,
  );
  ok(
    "sandbox keys on a test business pass",
    (await throws(() => assertCheckoutcomKeyMode("sk_sbox_a", "pk_sbox_a", false))) == null,
  );
  ok(
    "sandbox keys on a live business are refused",
    (await throws(() => assertCheckoutcomKeyMode("sk_sbox_a", "pk_sbox_a", true))) != null,
  );
  ok(
    "live keys on a test business are refused",
    (await throws(() => assertCheckoutcomKeyMode("sk_a", "pk_a", false))) != null,
  );
  ok(
    "a sandbox public key with a live secret key is refused",
    (await throws(() => assertCheckoutcomKeyMode("sk_a", "pk_sbox_a", true))) != null,
  );
  ok(
    "a key without the sk_ prefix is refused",
    (await throws(() => assertCheckoutcomKeyMode("abc", "pk_sbox_a", false))) != null,
  );
  const creds = {
    secret_key: "sk_sbox_x",
    public_key: "pk_sbox_x",
    processing_channel_id: "pc_x",
    api_prefix: "abcd1234",
    default_country: "us",
    entity_id: "ent_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const built = GATEWAY_FACTORIES.checkoutcom.build(creds, { businessId: "b", livemode: false });
  ok("the factory builds from the setup form's fields", built.key === "checkoutcom");
  const liveErr = await throws(() =>
    GATEWAY_FACTORIES.checkoutcom.build(creds, { businessId: "b", livemode: true }),
  );
  ok(
    "the factory refuses sandbox keys for a live business, clearly",
    liveErr instanceof GatewayResolveError && /sandbox keys/.test(liveErr.message),
  );
  const missing = await throws(() =>
    GATEWAY_FACTORIES.checkoutcom.build(
      { ...creds, processing_channel_id: undefined },
      { businessId: "b", livemode: false },
    ),
  );
  ok(
    "the factory names a missing credential",
    missing instanceof GatewayResolveError && /processing_channel_id/.test(missing.message),
  );
  const badCountry = await throws(() =>
    GATEWAY_FACTORIES.checkoutcom.build(
      { ...creds, default_country: "USA" },
      { businessId: "b", livemode: false },
    ),
  );
  ok("a three-letter default country is refused", badCountry instanceof GatewayResolveError);
}

// ── amounts ──────────────────────────────────────────────────────────────────
{
  ok("USD minor units pass unchanged", toCheckoutcomAmount(1234n, "USD") === 1234);
  ok("JPY is the full amount", toCheckoutcomAmount(500n, "JPY") === 500);
  ok("KWD keeps three decimals", toCheckoutcomAmount(1500n, "KWD") === 1500);
  ok("CLP gains two decimals (0 for us, 2 there)", toCheckoutcomAmount(1500n, "CLP") === 150000);
  ok("CLP comes back to our units", fromCheckoutcomAmount(150000, "CLP") === 1500n);
  ok("EUR comes back unchanged", fromCheckoutcomAmount(1999, "EUR") === 1999n);
  ok(
    "a four-decimal amount that does not fit two is refused",
    (await throws(() => toCheckoutcomAmount(12345n, "CLF"))) instanceof ProviderRefusalError,
  );
  ok(
    "a three-decimal amount must end in 0",
    (await throws(() => toCheckoutcomAmount(1505n, "KWD"))) instanceof ProviderRefusalError,
  );
  ok("nine digits pass", toCheckoutcomAmount(999_999_999n, "USD") === 999_999_999);
  ok(
    "ten digits are refused",
    (await throws(() => toCheckoutcomAmount(1_000_000_000n, "USD"))) instanceof
      ProviderRefusalError,
  );
}

// ── stored-credential flags ──────────────────────────────────────────────────
{
  const sc = checkoutcomStoredCredential;
  const eq = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
  ok(
    "no initiator → merchant-initiated Unscheduled",
    eq(sc(undefined), { payment_type: "Unscheduled", merchant_initiated: true }),
  );
  ok(
    "renewal (merchant, recurring) → MIT Recurring",
    eq(sc({ by: "merchant", recurring: true }), {
      payment_type: "Recurring",
      merchant_initiated: true,
    }),
  );
  ok(
    "top-up (merchant, not recurring) → MIT Unscheduled",
    eq(sc({ by: "merchant", recurring: false }), {
      payment_type: "Unscheduled",
      merchant_initiated: true,
    }),
  );
  ok(
    "signup charge (customer, recurring) → CIT Recurring",
    eq(sc({ by: "customer", recurring: true }), {
      payment_type: "Recurring",
      merchant_initiated: false,
    }),
  );
  ok(
    "one-off (customer, not recurring) → CIT Regular",
    eq(sc({ by: "customer", recurring: false }), {
      payment_type: "Regular",
      merchant_initiated: false,
    }),
  );
}

// ── decline mapping ──────────────────────────────────────────────────────────
{
  const n = normalizeCheckoutcomDecline;
  ok(
    "20051 → insufficient_funds, retriable",
    n("20051").code === "insufficient_funds" && n("20051").retriable,
  );
  ok("20005 → do_not_honor", n("20005").code === "do_not_honor");
  ok("20054 → expired_card, terminal", n("20054").code === "expired_card" && !n("20054").retriable);
  ok("30043 → stolen_card, terminal", n("30043").code === "stolen_card" && !n("30043").retriable);
  ok("30041 → lost_card", n("30041").code === "lost_card");
  ok(
    "200R1 → revocation, terminal, by a rule",
    n("200R1").code === "revocation_of_authorization" &&
      !n("200R1").retriable &&
      n("200R1").ruleId === "checkoutcom.code.revocation_one",
  );
  ok("20154 → authentication_required", n("20154").code === "authentication_required");
  ok("43102 (risk) → card_declined", n("43102").code === "card_declined");
  const gone = n("source_id_unknown");
  ok(
    "source_id_unknown (deleted card) → payment_method_not_found, terminal",
    gone.code === "payment_method_not_found" && !gone.retriable,
  );
  const ours = n("20157");
  ok(
    "a merchant-setup refusal is ours and hidden from the payer",
    ours.code === "gateway_request_rejected" &&
      ours.exposedToPayer === false &&
      declineHiddenFromPayer("gateway_request_rejected"),
  );
  const visaHard = n({ code: "20005", networkMessage: "04", cardBrand: "visa" });
  ok(
    "a Visa never-resubmit network code stops retries",
    visaHard.code === "network_do_not_retry" && !visaHard.retriable,
  );
  const macWait = n({ code: "20051", recommendationCode: "24", cardBrand: "mastercard" });
  ok("a Mastercard advice code sets a wait", macWait.retryAfterMs === 3_600_000);
  ok("an unknown code passes through, retriable", n("29999").retriable === true);
  ok("the decline set is registered", DECLINE_SETS.checkoutcom?.rules.length > 0);
  const ids = DECLINE_SETS.checkoutcom.rules.map((r) => r.id);
  ok("rule ids are unique", new Set(ids).size === ids.length);
}

// ── payment results ──────────────────────────────────────────────────────────
{
  const pay = (p: Partial<CkoPayment>): CkoPayment => ({
    id: "pay_xxxxxxxxxxxxxxxxxxxxxxxx01",
    ...p,
  });
  ok(
    "201 Authorized → succeeded",
    chargeResultFromPayment(pay({ status: "Authorized", approved: true })).status === "succeeded",
  );
  ok(
    "Captured → succeeded",
    chargeResultFromPayment(pay({ status: "Captured", approved: true })).status === "succeeded",
  );
  const declined = chargeResultFromPayment(
    pay({
      status: "Declined",
      approved: false,
      response_code: "20051",
      response_summary: "Insufficient Funds",
    }),
  );
  ok(
    "Declined → failed with the normalised code and the raw code",
    declined.status === "failed" &&
      declined.failure?.code === "insufficient_funds" &&
      declined.failure.providerCode === "20051",
  );
  const threeDs = chargeResultFromPayment(
    pay({
      status: "Pending",
      _links: { redirect: { href: "https://authentication-devices.sandbox.checkout.com/x" } },
    }),
  );
  ok(
    "202 Pending with a redirect → requires_action with the URL",
    threeDs.status === "requires_action" &&
      threeDs.nextAction?.type === "redirect_to_url" &&
      threeDs.nextAction.data.approvalRequired === true,
  );
  ok(
    "Pending without a redirect → pending",
    chargeResultFromPayment(pay({ status: "Pending" })).status === "pending",
  );
  ok(
    "Retry Scheduled → pending, never succeeded",
    chargeResultFromPayment(pay({ status: "Retry Scheduled" })).status === "pending",
  );
  ok(
    "Voided → failed",
    chargeResultFromPayment(pay({ status: "Voided", approved: true })).status === "failed",
  );
  const used = (type?: string, card_wallet_type?: string) =>
    chargeResultFromPayment(
      pay({ status: "Captured", approved: true, source: { type, card_wallet_type } }),
    ).methodUsed;
  ok(
    "methodUsed: source.type card → card, ach → us_bank_account, unknown → none",
    used("card") === "card" && used("ach") === "us_bank_account" && used("klarna") === undefined,
    `${used("card")} ${used("ach")} ${used("klarna")}`,
  );
  ok(
    "methodUsed: a card source with card_wallet_type googlepay → google_pay, applepay → apple_pay",
    used("card", "googlepay") === "google_pay" && used("card", "applepay") === "apple_pay",
    `${used("card", "googlepay")} ${used("card", "applepay")}`,
  );
}

// ── signatures ───────────────────────────────────────────────────────────────
{
  const body = JSON.stringify({ id: "evt_1", type: "payment_captured", data: { id: "pay_1" } });
  const sig = signCheckoutcomPayload(KEY, body);
  ok(
    "a valid signature passes",
    (await throws(() => verifyCheckoutcomSignature(KEY, sig, body))) == null,
  );
  ok(
    "an upper-case hex signature passes",
    (await throws(() => verifyCheckoutcomSignature(KEY, sig.toUpperCase(), body))) == null,
  );
  ok(
    "a tampered body is refused",
    (await throws(() => verifyCheckoutcomSignature(KEY, sig, body.replace("pay_1", "pay_2")))) !=
      null,
  );
  ok(
    "the wrong key is refused",
    (await throws(() => verifyCheckoutcomSignature("other", sig, body))) != null,
  );
  ok(
    "a missing header is refused",
    (await throws(() => verifyCheckoutcomSignature(KEY, undefined, body))) != null,
  );
  const cko = new CheckoutcomProvider(OPTS);
  const evs = await cko.normalizeWebhook({ payload: body, headers: { "Cko-Signature": sig } });
  ok("normalizeWebhook reads the header case-insensitively", evs[0]?.type === "charge.succeeded");
  ok("the event id is the evt_ id", evs[0]?.providerEventId === "evt_1");
  const noSecret = new CheckoutcomProvider({ ...OPTS, webhookSecret: undefined });
  ok(
    "an account without a webhook secret refuses deliveries",
    (await throws(() =>
      noSecret.normalizeWebhook({ payload: body, headers: { "cko-signature": sig } }),
    )) != null,
  );
  ok(
    "a Buffer body is signed byte for byte",
    (await throws(() => verifyCheckoutcomSignature(KEY, sig, Buffer.from(body)))) == null,
  );
}

// ── event mapping ────────────────────────────────────────────────────────────
{
  const map = (type: string, data: Record<string, unknown> = {}): NormalizedProviderEvent[] =>
    normalizeCheckoutcomEvent(
      { id: "evt_x", type, created_on: "2026-10-24T10:00:00Z", data },
      "evt_x",
      null,
    );
  const ours = { tmbilling_ref: "pay_X", tmbilling_kind: "charge" };
  const cap = map("payment_captured", {
    id: "pay_1",
    amount: 1000,
    currency: "USD",
    metadata: ours,
  })[0]!;
  ok(
    "payment_captured → charge.succeeded, ours",
    cap.type === "charge.succeeded" &&
      cap.providerChargeId === "pay_1" &&
      cap.ownership === "ours" &&
      cap.ownershipRef === "pay_X",
  );
  ok(
    "payment_approved on a charge → charge.succeeded",
    map("payment_approved", { id: "pay_1", metadata: ours })[0]?.type === "charge.succeeded",
  );
  ok("capturedAmountMinor: payment_captured carries its amount", cap.capturedAmountMinor === 1000n);
  ok(
    "capturedAmountMinor: unset on payment_approved (an authorization, not yet captured)",
    map("payment_approved", { id: "pay_1", amount: 1000, currency: "USD", metadata: ours })[0]
      ?.capturedAmountMinor === undefined,
  );
  const hold = map("payment_approved", {
    id: "pay_2",
    metadata: { tmbilling_ref: "pi_X", tmbilling_kind: "intent" },
  })[0]!;
  ok(
    "payment_approved on a hold → intent.authorized, never cash",
    hold.type === "intent.authorized" && hold.providerIntentId === "pay_2",
  );
  ok(
    "payment_approved with no kind → charge.pending (persist only)",
    map("payment_approved", { id: "pay_3" })[0]?.type === "charge.pending",
  );
  const dec = map("payment_declined", {
    id: "pay_4",
    response_code: "20051",
    response_summary: "Insufficient Funds",
    metadata: ours,
  })[0]!;
  ok(
    "payment_declined → charge.failed with the normalised decline",
    dec.type === "charge.failed" &&
      dec.failureCode === "insufficient_funds" &&
      dec.providerFailureCode === "20051" &&
      dec.failureRetriable === true,
  );
  ok(
    "payment_declined on a hold → unknown (refused in the call)",
    map("payment_declined", { id: "pay_5", metadata: { tmbilling_kind: "intent" } })[0]?.type ===
      "unknown",
  );
  ok(
    "payment_declined on a card check → unknown",
    map("payment_declined", { id: "pay_5", metadata: { tmbilling_kind: "setup" } })[0]?.type ===
      "unknown",
  );
  const capDec = map("payment_capture_declined", { id: "pay_6", response_code: "20006" })[0]!;
  ok(
    "payment_capture_declined → charge.failed that reverses a payment booked paid",
    capDec.type === "charge.failed" &&
      capDec.failureCode === "gateway_request_rejected" &&
      capDec.lateReversal === true,
  );
  const ref = map("payment_refunded", {
    id: "pay_7",
    action_id: "act_1",
    amount: 234,
    currency: "USD",
    balances: { total_refunded: 1234 },
    metadata: ours,
  })[0]!;
  ok(
    "payment_refunded → charge.refunded with the running total",
    ref.type === "charge.refunded" &&
      ref.providerRefundId === "act_1" &&
      ref.amountRefundedMinor === 1234n,
  );
  const refDec = map("payment_refund_declined", {
    id: "pay_7",
    action_id: "act_2",
    response_code: "50003",
  })[0]!;
  ok(
    "payment_refund_declined → refund.failed on the refund action",
    refDec.type === "refund.failed" &&
      refDec.providerRefundId === "act_2" &&
      refDec.providerFailureCode === "50003",
  );
  ok(
    "payment_refund_pending → refund.pending",
    map("payment_refund_pending", { id: "pay_7", action_id: "act_3" })[0]?.type ===
      "refund.pending",
  );
  ok(
    "payment_pending → charge.pending",
    map("payment_pending", { id: "pay_8" })[0]?.type === "charge.pending",
  );
  ok(
    "payment_voided on a hold → intent.voided",
    map("payment_voided", { id: "pay_9", metadata: { tmbilling_kind: "intent" } })[0]?.type ===
      "intent.voided",
  );
  const voidedCharge = map("payment_voided", {
    id: "pay_9",
    metadata: { tmbilling_ref: "inv_X", tmbilling_kind: "charge" },
  })[0]!;
  ok(
    "payment_voided on a charge → charge.failed that reverses it",
    voidedCharge.type === "charge.failed" && voidedCharge.lateReversal === true,
  );
  ok(
    "payment_returned → charge.reversed",
    map("payment_returned", { id: "pay_10" })[0]?.type === "charge.reversed",
  );
  const disp = map("dispute_received", {
    id: "dsp_1",
    payment_id: "pay_11",
    amount: 8150,
    currency: "GBP",
    category: "fraudulent",
    evidence_required_by: "2026-11-10T00:00:00Z",
  });
  ok(
    "dispute_received → dispute.created + funds_withdrawn",
    disp.length === 2 &&
      disp[0]!.type === "dispute.created" &&
      disp[1]!.type === "dispute.funds_withdrawn" &&
      disp[0]!.providerChargeId === "pay_11" &&
      disp[0]!.disputeAmountMinor === 8150n &&
      disp[0]!.evidenceDueBy instanceof Date,
  );
  ok("dispute_won → dispute.won", map("dispute_won", { id: "dsp_1" })[0]?.type === "dispute.won");
  ok(
    "dispute_lost → dispute.lost",
    map("dispute_lost", { id: "dsp_1" })[0]?.type === "dispute.lost",
  );
  ok(
    "dispute_accepted / expired → dispute.lost",
    map("dispute_accepted")[0]?.type === "dispute.lost" &&
      map("dispute_expired")[0]?.type === "dispute.lost",
  );
  ok(
    "dispute_canceled credits back (dispute.won); dispute_resolved → dispute.closed",
    map("dispute_canceled")[0]?.type === "dispute.won" &&
      map("dispute_resolved")[0]?.type === "dispute.closed",
  );
  const upd = map("card_updated", {
    reason_type: "card_updated",
    replacement_card: { scheme: "visa", last4: "3456", expiry_month: 12, expiry_year: 2030 },
    sources: [{ id: "src_a" }, { id: "src_b" }],
  });
  ok(
    "card_updated → payment_method.updated per stored card",
    upd.length === 2 &&
      upd.every((e) => e.type === "payment_method.updated") &&
      upd[1]!.providerPaymentMethodId === "src_b" &&
      upd[0]!.card?.last4 === "3456",
  );
  ok(
    "card_updated for a closed card → unknown",
    map("card_updated", { reason_type: "card_closed", sources: [{ id: "src_a" }] })[0]?.type ===
      "unknown",
  );
  ok(
    "a foreign payment (metadata without our ref) is foreign",
    map("payment_captured", { id: "pay_12", metadata: { other: "x" } })[0]?.ownership === "foreign",
  );
  ok("an unmapped type is unknown", map("payment_paid")[0]?.type === "unknown");
  const sources = Object.keys(CHECKOUTCOM_WEBHOOK_EVENTS);
  ok(
    "the workflow subscribes to gateway, dispute and account-updater events",
    ["gateway", "dispute", "vault_rtau"].every((s) => sources.includes(s)),
  );
}

// ── capabilities and catalogue ───────────────────────────────────────────────
{
  const cko = new CheckoutcomProvider(OPTS);
  const c = cko.capabilities;
  ok("cards only", JSON.stringify(c.methods) === '["card"]');
  ok("refunds and partial refunds", c.refunds && c.partialRefunds);
  ok("intents for payment and setup", c.intents === true && c.intentPurposes?.length === 2);
  ok("an authorization can be voided", c.intentVoid === true);
  ok("no mandate ceiling on a stored card", c.mandates === false);
  ok("no per-debit mandate reference required", !c.perDebitMandateReference);
  const def = GATEWAYS.checkoutcom;
  ok("display name", def.displayName === "Checkout.com");
  ok(
    "credential fields",
    JSON.stringify(def.credentialFields.map((f) => f.key)) ===
      '["secret_key","public_key","processing_channel_id","api_prefix","default_country","entity_id"]',
  );
  ok("we own the webhook key", def.webhook.secret === "provider_minted");
  ok("advertised methods match the adapter", JSON.stringify(def.advertisedMethods) === '["card"]');
  ok("card settles in the call", !def.settlement.alwaysAsync);
  const text = [
    ...def.credentialFields.flatMap((f) => [f.label, f.hint ?? ""]),
    ...def.webhook.instructions("https://x", "self_provisioned"),
    ...def.webhook.fallbackInstructions,
  ].join(" ");
  ok("setup copy says check, never verify", !/\bverif/i.test(text));
}

// ── synthetic intents ────────────────────────────────────────────────────────
{
  const id = encodeCheckoutcomIntent({
    p: "payment",
    c: "cus_1",
    s: "ps_1",
    cur: "USD",
    a: "1500",
    r: "pi_X",
  });
  const back = decodeCheckoutcomIntent(id);
  ok("a challenge id round-trips", back?.s === "ps_1" && back.a === "1500" && back.c === "cus_1");
  ok("a payment id is not a challenge", decodeCheckoutcomIntent("pay_1") === null);
  ok("a garbled challenge id is rejected", decodeCheckoutcomIntent("ckoi_!!!") === null);
}

// ── money calls against a stubbed API ────────────────────────────────────────
{
  const realFetch = globalThis.fetch;
  const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] =
    [];
  let answer: (url: string, method: string) => { status: number; body?: unknown } = () => ({
    status: 200,
    body: {},
  });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url: String(url),
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const a = answer(String(url), method);
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  const last = () => calls[calls.length - 1]!;
  try {
    const cko = new CheckoutcomProvider(OPTS);
    const base = {
      amountMinor: 2000n,
      currency: "usd",
      customer: { providerKey: "checkoutcom" as const, providerCustomerId: "cus_1" },
      paymentMethod: {
        providerKey: "checkoutcom" as const,
        providerPaymentMethodId: "src_1",
        display: { type: "card" as const },
      },
      idempotencyKey: "pay_attempt_1",
      ownershipRef: "pay_X",
    };
    answer = () => ({
      status: 201,
      body: { id: "pay_ok", status: "Authorized", approved: true, response_code: "10000" },
    });
    const res = await cko.charge({
      ...base,
      mandateReference: "pay_cit",
      initiator: { by: "merchant", recurring: true },
    });
    const b = last().body as Record<string, unknown>;
    ok(
      "charge succeeds on 201 Authorized",
      res.status === "succeeded" && res.providerChargeId === "pay_ok",
    );
    ok(
      "charge goes to the prefixed host",
      last().url === "https://abcd1234.api.sandbox.checkout.com/payments",
    );
    ok(
      "charge sends Bearer and Cko-Idempotency-Key",
      last().headers.Authorization === "Bearer sk_sbox_offline" &&
        last().headers["Cko-Idempotency-Key"] === "pay_attempt_1",
    );
    ok(
      "a renewal is an MIT Recurring quoting the initial payment",
      b.payment_type === "Recurring" &&
        b.merchant_initiated === true &&
        b.previous_payment_id === "pay_cit" &&
        b.processing_channel_id === "pc_offline",
    );
    ok(
      "charge tags ownership and kind",
      (b.metadata as Record<string, string>).tmbilling_ref === "pay_X" &&
        (b.metadata as Record<string, string>).tmbilling_kind === "charge",
    );
    ok("currency is upper-cased, amount in minor units", b.currency === "USD" && b.amount === 2000);

    await cko.charge({
      ...base,
      initiator: { by: "customer", recurring: true },
      mandateReference: "pay_cit",
    });
    const cit = last().body as Record<string, unknown>;
    ok(
      "a customer-present charge sends no previous_payment_id",
      cit.merchant_initiated === false && cit.previous_payment_id === undefined,
    );

    answer = () => ({
      status: 201,
      body: {
        id: "pay_dec",
        status: "Declined",
        approved: false,
        response_code: "20051",
        response_summary: "Insufficient Funds",
        processing: { partner_response_code: "51", scheme: "VISA" },
      },
    });
    const dec = await cko.charge(base);
    ok(
      "a declined charge is data, not a throw",
      dec.status === "failed" &&
        dec.failure?.code === "insufficient_funds" &&
        dec.providerChargeId === "pay_dec",
    );

    answer = () => ({
      status: 422,
      body: { error_type: "processing_error", error_codes: ["source_id_unknown"] },
    });
    const gone = await cko.charge(base);
    ok(
      "a deleted card is a terminal failure",
      gone.status === "failed" &&
        gone.failure?.code === "payment_method_not_found" &&
        !gone.failure.retriable,
    );

    answer = () => ({
      status: 422,
      body: { error_type: "request_invalid", error_codes: ["amount_invalid"] },
    });
    ok(
      "an unrecognised 422 throws (our bug)",
      (await throws(() => cko.charge(base))) instanceof Error,
    );

    const sent = calls.length;
    const tooBig = await cko.charge({ ...base, amountMinor: 1_000_000_000n });
    ok(
      "an amount Checkout.com documents as invalid is a definite refusal, never sent",
      tooBig.status === "failed" &&
        tooBig.failure?.code === "gateway_request_rejected" &&
        tooBig.failure.retriable === false &&
        calls.length === sent,
    );

    let n = 0;
    answer = () =>
      ++n === 1
        ? { status: 502 }
        : { status: 201, body: { id: "pay_replayed", status: "Authorized", approved: true } };
    const before = calls.length;
    const replayed = await cko.charge(base);
    ok(
      "a 5xx is sent again under the same key and takes the replayed answer",
      replayed.status === "succeeded" &&
        replayed.providerChargeId === "pay_replayed" &&
        calls.length - before === 2 &&
        calls.at(-1)!.headers["Cko-Idempotency-Key"] ===
          calls.at(-2)!.headers["Cko-Idempotency-Key"],
    );

    answer = () => ({ status: 409 });
    ok(
      "a concurrent duplicate (409) is indeterminate",
      (await throws(() => cko.charge(base))) instanceof ProviderIndeterminateError,
    );
    answer = () => ({ status: 503 });
    ok(
      "a 5xx is indeterminate",
      (await throws(() => cko.charge(base))) instanceof ProviderIndeterminateError,
    );
    answer = () => ({ status: 401 });
    const auth = await throws(() => cko.charge(base));
    ok(
      "a 401 names the key and prefix, and is not indeterminate",
      auth instanceof Error &&
        !(auth instanceof ProviderIndeterminateError) &&
        /API prefix/.test(auth.message),
    );

    answer = () => ({ status: 202, body: { action_id: "act_r1", reference: "re_X" } });
    const rf = await cko.refund({
      providerChargeId: "pay_ok",
      amountMinor: 500n,
      currency: "USD",
      idempotencyKey: "re_1",
      ownershipRef: "re_X",
    });
    ok(
      "a refund is accepted pending with the action id",
      rf.status === "pending" &&
        rf.providerRefundId === "act_r1" &&
        (last().body as { amount?: number }).amount === 500,
    );
    answer = () => ({ status: 422, body: { error_codes: ["refund_amount_exceeds_balance"] } });
    ok(
      "a refused refund is a refusal",
      (await throws(() =>
        cko.refund({ providerChargeId: "pay_ok", idempotencyKey: "re_2" }),
      )) instanceof ProviderRefusalError,
    );
    answer = () => ({ status: 403, body: {} });
    ok(
      "a refund answered 403 (Refund not allowed) is a refusal, not a key error",
      (await throws(() =>
        cko.refund({ providerChargeId: "pay_ok", idempotencyKey: "re_3" }),
      )) instanceof ProviderRefusalError,
    );
    answer = () => ({ status: 200, body: {} });
    ok(
      "a refund answered 200 (already refunded) is a refusal",
      (await throws(() =>
        cko.refund({ providerChargeId: "pay_ok", idempotencyKey: "re_4" }),
      )) instanceof ProviderRefusalError,
    );

    // A lost answer, found by reference and then by the key in the metadata.
    const ours = (key: string) => ({
      id: `pay_${key}`,
      status: "Authorized",
      approved: true,
      metadata: { tmbilling_ref: "pay_X", tmbilling_kind: "charge", tmbilling_key: key },
    });
    answer = (url) =>
      url.includes("/payments?reference=")
        ? {
            status: 200,
            body: { total_count: 2, data: [ours("other_try"), ours("pay_attempt_1")] },
          }
        : { status: 500 };
    const found = await cko.locateCharge({
      ownershipRef: "pay_X",
      idempotencyKey: "pay_attempt_1",
    });
    ok(
      "locateCharge picks the attempt by its key, not another attempt on the same reference",
      found?.status === "succeeded" &&
        found.providerChargeId === "pay_pay_attempt_1" &&
        last().url.includes("reference=pay_X"),
    );
    answer = () => ({ status: 404 });
    ok(
      "locateCharge: no payment with the reference is a definite null",
      (await cko.locateCharge({ ownershipRef: "pay_X", idempotencyKey: "pay_attempt_9" })) === null,
    );

    // setup intent: a payment session, then the browser's payment id
    answer = (url) =>
      url.includes("/customers/")
        ? { status: 200, body: { id: "cus_1", metadata: { billing_country: "GB" } } }
        : {
            status: 201,
            body: {
              id: "ps_1",
              payment_session_token: "t",
              payment_session_secret: "pss_1",
              _links: {},
            },
          };
    const intent = await cko.createIntent({
      purpose: "setup",
      currency: "EUR",
      customer: base.customer,
      idempotencyKey: "pi_1",
      ownershipRef: "pi_X",
      returnUrl: "https://shop.example.com/ok",
      cancelUrl: "https://shop.example.com/no",
    });
    const sess = last().body as Record<string, unknown>;
    ok(
      "a setup is a 0-amount Recurring card-only session with a 3DS mandate challenge",
      JSON.stringify(sess.enabled_payment_methods) === '["card"]' &&
        sess.amount === 0 &&
        sess.payment_type === "Recurring" &&
        (sess["3ds"] as { challenge_indicator?: string }).challenge_indicator ===
          "challenge_requested_mandate",
    );
    ok(
      "the billing country comes from the customer",
      (sess.billing as { address: { country: string } }).address.country === "GB",
    );
    ok(
      "the buyer gets the session, the public key and the environment",
      intent.status === "requires_action" &&
        intent.authorization?.mode === "sdk" &&
        intent.authorization.sdk?.params.publicKey === "pk_sbox_offline" &&
        intent.authorization.sdk.params.environment === "sandbox" &&
        (intent.authorization.sdk.params.paymentSession as { id: string }).id === "ps_1",
    );
    const verified = {
      id: "pay_cit",
      status: "Card Verified",
      approved: true,
      amount: 0,
      currency: "EUR",
      customer: { id: "cus_1" },
      metadata: { cko_payment_session_id: "ps_1" },
      source: {
        id: "src_new",
        scheme: "Visa",
        last4: "4242",
        expiry_month: 12,
        expiry_year: 2030,
        issuer_country: "GB",
        card_type: "CREDIT",
      },
    };
    answer = () => ({ status: 200, body: verified });
    const sub = await cko.submitClientResult({
      intentId: intent.intentId,
      purpose: "setup",
      clientResult: { payment_id: "pay_cit" },
      idempotencyKey: "k",
    });
    ok(
      "a verified card on this session authorizes the setup",
      sub.status === "authorized" && sub.gatewayIntentId === "pay_cit",
    );
    answer = () => ({
      status: 200,
      body: { ...verified, metadata: { cko_payment_session_id: "ps_other" } },
    });
    const other = await cko.submitClientResult({
      intentId: intent.intentId,
      purpose: "setup",
      clientResult: { payment_id: "pay_cit" },
      idempotencyKey: "k",
    });
    ok(
      "a payment from another session is refused",
      other.status === "failed" && other.failure?.code === "invalid_client_result",
    );
    answer = () => ({ status: 200, body: { ...verified, customer: { id: "cus_2" } } });
    const stranger = await cko.submitClientResult({
      intentId: intent.intentId,
      purpose: "setup",
      clientResult: { payment_id: "pay_cit" },
      idempotencyKey: "k",
    });
    ok("a payment for another customer is refused", stranger.status === "failed");
    answer = () => ({ status: 200, body: verified });
    const consumed = await cko.consumeIntent({
      intentId: "pay_cit",
      purpose: "setup",
      idempotencyKey: "k",
    });
    ok(
      "consuming the setup returns the stored card with the initial payment as reference",
      consumed.purpose === "setup" &&
        consumed.paymentMethod?.providerPaymentMethodId === "src_new" &&
        consumed.paymentMethod.mandate?.reference === "pay_cit" &&
        consumed.paymentMethod.mandate.rail === undefined &&
        consumed.paymentMethod.display.brand === "visa",
    );

    // a payment session, then capture and void
    answer = (url) =>
      url.includes("/customers/")
        ? { status: 200, body: { id: "cus_1", metadata: {} } }
        : { status: 201, body: { id: "ps_2", _links: {} } };
    const payIntent = await cko.createIntent({
      purpose: "payment",
      amountMinor: 1500n,
      currency: "USD",
      customer: base.customer,
      idempotencyKey: "pi_2",
      ownershipRef: "pi_Y",
      returnUrl: "https://shop.example.com/ok",
    });
    const ps = last().body as Record<string, unknown>;
    ok(
      "a payment session holds the money (capture false) for the business's country",
      ps.capture === false &&
        JSON.stringify(ps.enabled_payment_methods) === '["card","googlepay"]' &&
        ps.amount === 1500 &&
        (ps.billing as { address: { country: string } }).address.country === "US",
    );
    answer = () => ({
      status: 200,
      body: {
        id: "pay_h",
        status: "Authorized",
        approved: true,
        amount: 1499,
        currency: "USD",
        metadata: { cko_payment_session_id: "ps_2" },
      },
    });
    const short = await cko.submitClientResult({
      intentId: payIntent.intentId,
      purpose: "payment",
      clientResult: { payment_id: "pay_h" },
      idempotencyKey: "k",
    });
    ok("a payment for a different amount is refused", short.status === "failed");
    answer = () => ({
      status: 200,
      body: {
        id: "pay_h",
        status: "Authorized",
        approved: true,
        amount: 1500,
        currency: "USD",
        metadata: { cko_payment_session_id: "ps_2" },
        source: { type: "card", scheme: "Visa", last4: "1111", card_wallet_type: "googlepay" },
      },
    });
    const good = await cko.submitClientResult({
      intentId: payIntent.intentId,
      purpose: "payment",
      clientResult: { payment_id: "pay_h" },
      idempotencyKey: "k",
    });
    ok(
      "the matching hold authorizes the payment",
      good.status === "authorized" &&
        good.providerChargeId === "pay_h" &&
        good.amountMinor === 1500n,
    );
    ok(
      "a Google Pay hold reports methodUsed google_pay to the engine",
      good.methodUsed === "google_pay",
      String(good.methodUsed),
    );

    // Apple Pay pay-now on the Hosted Payments Page
    answer = (url) =>
      url.includes("/customers/")
        ? { status: 200, body: { id: "cus_1", metadata: {} } }
        : {
            status: 201,
            body: {
              id: "hpp_XXXXXXXXXX01",
              _links: {
                redirect: { href: "https://pay.sandbox.checkout.com/page/hpp_XXXXXXXXXX01" },
              },
            },
          };
    const hosted = await cko.createIntent({
      purpose: "payment",
      amountMinor: 1500n,
      currency: "USD",
      customer: base.customer,
      idempotencyKey: "pi_3",
      ownershipRef: "pi_XXXXXXXXXXXXXXXXXXXXXXXX",
      returnUrl: "https://shop.example.com/ok",
      cancelUrl: "https://shop.example.com/cancel",
      hostedWallet: "apple_pay",
    });
    const hp = last();
    const hb = hp.body as Record<string, unknown>;
    const ref = checkoutcomHostedReference("pi_XXXXXXXXXXXXXXXXXXXXXXXX");
    ok(
      "apple pay: a held Hosted Payments Page restricted to applepay, with our reference",
      hp.url.endsWith("/hosted-payments") &&
        JSON.stringify(hb.allow_payment_methods) === '["applepay"]' &&
        hb.capture === false &&
        hb.reference === ref &&
        ref.length <= 30 &&
        hb.success_url === "https://shop.example.com/ok" &&
        hb.cancel_url === "https://shop.example.com/cancel" &&
        (hb.metadata as Record<string, string>).tmbilling_ref === "pi_XXXXXXXXXXXXXXXXXXXXXXXX",
      JSON.stringify(hb),
    );
    ok(
      "apple pay: the buyer is redirected; the intent is the page's reference",
      hosted.intentId === CHECKOUTCOM_HOSTED_PREFIX + ref &&
        hosted.authorization?.mode === "redirect" &&
        hosted.authorization.approvalUrl ===
          "https://pay.sandbox.checkout.com/page/hpp_XXXXXXXXXX01",
    );
    const applePaid = {
      id: "pay_ap",
      status: "Authorized",
      approved: true,
      amount: 1500,
      currency: "USD",
      reference: ref,
      source: { type: "card", scheme: "Visa", last4: "1111", card_wallet_type: "applepay" },
    };
    answer = () => ({ status: 200, body: { ...applePaid, reference: "th-someone-else" } });
    const foreign = await cko.submitClientResult({
      intentId: hosted.intentId,
      purpose: "payment",
      clientResult: { "cko-payment-id": "pay_ap" },
      idempotencyKey: "k",
    });
    ok(
      "apple pay: a returned payment with another reference is refused",
      foreign.status === "failed",
    );
    answer = () => ({ status: 200, body: applePaid });
    const back = await cko.submitClientResult({
      intentId: hosted.intentId,
      purpose: "payment",
      clientResult: { "cko-payment-id": "pay_ap" },
      idempotencyKey: "k",
    });
    ok(
      "apple pay: the return's cko-payment-id re-points the intent to the held payment",
      back.status === "authorized" &&
        back.gatewayIntentId === "pay_ap" &&
        back.amountMinor === 1500n &&
        back.methodUsed === "apple_pay",
      `${back.status} ${back.gatewayIntentId} ${back.amountMinor} ${back.methodUsed}`,
    );
    answer = () => ({ status: 404, body: {} });
    ok(
      "apple pay: voiding a page nobody paid holds nothing",
      JSON.stringify(await cko.voidIntent({ intentId: hosted.intentId, idempotencyKey: "k" })) ===
        '{"voided":true,"held":false}',
    );
    const approved = normalizeCheckoutcomEvent(
      {
        id: "evt_ap",
        type: "payment_approved",
        created_on: "2026-10-28T10:00:00Z",
        data: {
          ...applePaid,
          metadata: { tmbilling_ref: "pi_XXXXXXXXXXXXXXXXXXXXXXXX", tmbilling_kind: "intent" },
        },
      },
      "evt_ap",
      null,
    );
    ok(
      "apple pay: payment_approved with a th- reference authorizes the page's intent",
      approved.length === 1 &&
        approved[0]!.type === "intent.authorized" &&
        approved[0]!.providerIntentId === hosted.intentId &&
        approved[0]!.gatewayIntentId === "pay_ap" &&
        approved[0]!.ownershipRef === "pi_XXXXXXXXXXXXXXXXXXXXXXXX",
      approved.map((e) => `${e.type} ${e.providerIntentId}`).join(", "),
    );
    answer = () => ({ status: 202, body: { action_id: "act_c" } });
    const cap = await cko.consumeIntent({
      intentId: "pay_h",
      purpose: "payment",
      idempotencyKey: "k",
      amountMinor: 1500n,
      currency: "USD",
    });
    ok(
      "capture accepted → succeeded",
      cap.purpose === "payment" &&
        cap.charge.status === "succeeded" &&
        last().url.endsWith("/payments/pay_h/captures"),
    );
    answer = (_u, m) =>
      m === "GET"
        ? { status: 200, body: { id: "pay_h", status: "Authorized" } }
        : { status: 202, body: { action_id: "act_v" } };
    const v = await cko.voidIntent({ intentId: "pay_h", idempotencyKey: "k" });
    ok(
      "voiding a hold reports the hold",
      v.voided && v.held === true && v.providerTransactionId === "act_v",
    );
    const vs = await cko.voidIntent({ intentId: payIntent.intentId, idempotencyKey: "k" });
    ok("voiding an unanswered challenge holds nothing", vs.voided && vs.held === false);

    // workflows
    const seen: string[] = [];
    answer = (url, method) => {
      seen.push(`${method} ${url.replace("https://abcd1234.api.sandbox.checkout.com", "")}`);
      if (method === "GET" && url.endsWith("/workflows"))
        return {
          status: 200,
          body: {
            data: [
              { id: "wf_old", name: "tmbilling webhooks gwa_1" },
              { id: "wf_foreign", name: "theirs" },
            ],
          },
        };
      if (method === "GET")
        return {
          status: 200,
          body: {
            actions: [{ url: "https://api.example.com/v1/gateway_webhooks/checkoutcom?id=gwa_1" }],
          },
        };
      if (method === "DELETE") return { status: 204 };
      return { status: 201, body: { id: "wf_new" } };
    };
    const prov = await cko.provisionWebhookEndpoint({
      url: "https://api.example.com/v1/gateway_webhooks/checkoutcom?id=gwa_1",
      secret: "our_key",
    });
    const wfBody = last().body as {
      name: string;
      conditions: Array<{ type: string; processing_channels?: string[]; entities?: string[] }>;
      actions: Array<{ signature: { key: string; method: string } }>;
    };
    ok(
      "provisioning returns the key we set and the workflow id",
      prov.webhookSecret === "our_key" && prov.providerEndpointId === "wf_new",
    );
    ok(
      "the workflow signs with our key, HMAC-SHA256",
      wfBody.actions[0]!.signature.key === "our_key" &&
        wfBody.actions[0]!.signature.method === "HMACSHA256",
    );
    ok(
      "the workflow is scoped to the processing channel",
      wfBody.conditions.some(
        (c) => c.type === "processing_channel" && c.processing_channels?.[0] === "pc_offline",
      ),
    );
    ok(
      "the workflow names the account's entity (the API refuses a workflow without one)",
      wfBody.conditions.some(
        (c) => c.type === "entity" && c.entities?.[0] === "ent_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    );
    ok(
      "a malformed entity_id is refused at build",
      (() => {
        try {
          new CheckoutcomProvider({ ...OPTS, entityId: "ent_x" });
          return false;
        } catch {
          return true;
        }
      })(),
    );
    ok(
      "re-provisioning replaces our old workflow for this URL and leaves others alone",
      seen.includes("DELETE /workflows/wf_old") && !seen.some((s) => s.includes("wf_foreign")),
    );
    answer = (_u, method) =>
      method === "GET"
        ? { status: 200, body: { data: [] } }
        : { status: 201, body: { id: "wf_2" } };
    const minted = await cko.provisionWebhookEndpoint({
      url: "https://api.example.com/x?id=gwa_2",
    });
    ok(
      "without a given secret the adapter mints a strong key",
      (minted.webhookSecret ?? "").length >= 40,
    );

    // customers
    answer = (url, method) =>
      method === "POST"
        ? { status: 422, body: { error_codes: ["customer_email_already_exists"] } }
        : { status: 200, body: { id: "cus_existing" } };
    const cus = await cko.ensureCustomer({ customerRef: "cus_X", email: "payer@example.com" });
    ok(
      "an existing email reuses that customer",
      cus.providerCustomerId === "cus_existing" &&
        last().url.endsWith("/customers/payer%40example.com"),
    );
    ok(
      "a customer without email is refused before any call",
      (await throws(() => cko.ensureCustomer({ customerRef: "cus_X" }))) instanceof
        ProviderRefusalError,
    );

    // health
    answer = () => ({ status: 404 });
    ok("health: a 404 reference search means the key works", (await cko.healthCheck()).ok);
  } finally {
    globalThis.fetch = realFetch;
  }
}

await closeDb().catch(() => undefined);
const failed = checks.filter(([, c]) => !c);
for (const [name, c, detail] of checks)
  console.log(`  ${c ? "✓" : "✗"} ${name}${!c && detail ? ` — ${detail}` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks`);
console.log(failed.length === 0 ? "✅ CHECKOUTCOM: PASS" : "❌ CHECKOUTCOM: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
