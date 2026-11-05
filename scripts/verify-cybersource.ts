/**
 * verify:cybersource — the CyberSource adapter, offline. No network: API answers come from a
 * stubbed `fetch`, in the shapes the sandbox returned on 2026-10-25 where we measured them.
 *
 * Covers HTTP Signature building, the webhook signature, event mapping, the charge initiator
 * → stored-credential fields, eCheck SEC codes, decline mapping, idempotency through
 * Transaction Search, capabilities, the catalog and the `sdk` intent flow.
 *
 *   pnpm verify:cybersource
 */
import { createHash, createHmac } from "node:crypto";
import { closeDb } from "@/platform/db";
import {
  CYBERSOURCE_WEBHOOK_EVENTS,
  CybersourceProvider,
  chargeResultFromTransaction,
  cybersourceDeclineSignal,
  cybersourceEcheckProcessing,
  cybersourceEventId,
  cybersourceReference,
  cybersourceStoredCredential,
  decodeSyntheticIntent,
  describeCybersourceInstrument,
  normalizeCybersourceNotification,
  normalizeWebhookUrl,
  paymentInstrumentIdsOf,
  parseCybersourceSignatureHeader,
  readPaymentResponse,
  selectWebhookProducts,
  signCybersourceRequest,
  signCybersourceWebhook,
  transactionIdOf,
  verifyCybersourceSignature,
  type CsTransaction,
  type CybersourceNotification,
} from "@/providers/cybersource";
import {
  DECLINE_SETS,
  declineHiddenFromPayer,
  normalizeCybersourceDecline,
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

const ORG = "testorg_1234567890";
const KEY_ID = "00000000-0000-4000-8000-000000000001";
const SECRET = Buffer.alloc(32, 7).toString("base64");
const WH_KEY_ID = "00000000-0000-4000-8000-0000000000aa";
const WH_SECRET = `${WH_KEY_ID}:${Buffer.alloc(32, 9).toString("base64")}`;
const CID = "0000000000000000E063000000000C01";
const PI = "0000000000000000E063000000000A01";
const TX = "7900000000000000000001";

// ── 1 · HTTP Signature ─────────────────────────────────────────────────────
{
  const auth = { organizationId: ORG, keyId: KEY_ID, sharedSecret: SECRET };
  const date = "Sat, 25 Oct 2026 10:00:00 GMT";
  const body = '{"a":1}';
  const h = signCybersourceRequest(auth, {
    host: "apitest.cybersource.com",
    method: "POST",
    path: "/pts/v2/payments",
    body,
    date,
  });
  const digest = `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
  const want = createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(
      [
        "host: apitest.cybersource.com",
        `date: ${date}`,
        "request-target: post /pts/v2/payments",
        `digest: ${digest}`,
        `v-c-merchant-id: ${ORG}`,
      ].join("\n"),
    )
    .digest("base64");
  ok("http signature: digest is SHA-256=<base64 of the body>", h.digest === digest);
  ok("http signature: v-c-merchant-id is the organization id", h["v-c-merchant-id"] === ORG);
  ok(
    "http signature: POST signs host date request-target digest v-c-merchant-id",
    h.signature ===
      `keyid="${KEY_ID}", algorithm="HmacSHA256", headers="host date request-target digest v-c-merchant-id", signature="${want}"`,
  );
  const g = signCybersourceRequest(auth, {
    host: "apitest.cybersource.com",
    method: "GET",
    path: "/tss/v2/transactions/1",
    date,
  });
  ok(
    "http signature: GET has no digest and signs the four measured headers",
    !g.digest && g.signature!.includes('headers="host date request-target v-c-merchant-id"'),
  );
  ok(
    "http signature: request-target is lowercase method + path with query",
    signCybersourceRequest(auth, {
      host: "h",
      method: "GET",
      path: "/a?b=1",
      date,
    }).signature !== g.signature,
  );
}

// ── 2 · webhook signature ──────────────────────────────────────────────────
{
  const body = JSON.stringify({ eventType: "tms.networktoken.updated", payload: { a: 1 } });
  const t = "1617830804768";
  const header = signCybersourceWebhook(WH_SECRET, t, body);
  ok(
    "webhook signature: a valid signature passes",
    (await throws(() => verifyCybersourceSignature(WH_SECRET, header, body))) === null,
  );
  ok(
    "webhook signature: a Buffer body passes",
    (await throws(() => verifyCybersourceSignature(WH_SECRET, header, Buffer.from(body)))) === null,
  );
  const tampered = await throws(() =>
    verifyCybersourceSignature(WH_SECRET, header, body.replace('"a":1', '"a":2')),
  );
  ok("webhook signature: a tampered body is refused", tampered instanceof Error);
  const other = `${WH_KEY_ID}:${Buffer.alloc(32, 1).toString("base64")}`;
  ok(
    "webhook signature: the wrong key is refused",
    (await throws(() => verifyCybersourceSignature(other, header, body))) instanceof Error,
  );
  const rotated = `00000000-0000-4000-8000-0000000000bb:${Buffer.alloc(32, 9).toString("base64")}`;
  const e = await throws(() => verifyCybersourceSignature(rotated, header, body));
  ok(
    "webhook signature: a delivery signed with another key id says the key was replaced",
    e instanceof Error && /replaced/.test(e.message),
  );
  ok(
    "webhook signature: a changed timestamp is refused",
    (await throws(() =>
      verifyCybersourceSignature(WH_SECRET, header.replace(`t=${t}`, "t=1"), body),
    )) instanceof Error,
  );
  ok(
    "webhook signature: no header is refused",
    (await throws(() => verifyCybersourceSignature(WH_SECRET, undefined, body))) instanceof Error,
  );
  // The guide's example shape: it ends in a stray quote and semicolon.
  const p = parseCybersourceSignatureHeader(
    't=1617830804768;keyId=00000000-0000-4000-8000-0000000000cc;sig=XXXXXXXXXXXXXXXXX/XXXXXXXXXXXX+XXXXXXXXXXXX=";',
  );
  ok(
    "webhook signature: the guide's example header parses (base64 '=' kept)",
    p?.t === "1617830804768" &&
      p.keyId === "00000000-0000-4000-8000-0000000000cc" &&
      p.sig === "XXXXXXXXXXXXXXXXX/XXXXXXXXXXXX+XXXXXXXXXXXX=",
  );
  const bare = Buffer.alloc(32, 9).toString("base64");
  ok(
    "webhook signature: a secret without a key id still checks",
    (await throws(() => verifyCybersourceSignature(bare, header, body))) === null,
  );
}

// ── 3 · initiator → stored-credential fields ───────────────────────────────
{
  const mitRec = cybersourceStoredCredential({ by: "merchant", recurring: true }, "visa");
  ok(
    "initiator: merchant + recurring → recurring, type merchant, stored credential, no reason on Visa",
    mitRec.commerceIndicator === "recurring" &&
      mitRec.authorizationOptions.initiator.type === "merchant" &&
      mitRec.authorizationOptions.initiator.storedCredentialUsed === true &&
      !mitRec.authorizationOptions.initiator.merchantInitiatedTransaction,
  );
  ok(
    "initiator: merchant + recurring on Mastercard → reason 7",
    cybersourceStoredCredential({ by: "merchant", recurring: true }, "mastercard")
      .authorizationOptions.initiator.merchantInitiatedTransaction?.reason === "7",
  );
  const ucof = cybersourceStoredCredential({ by: "merchant", recurring: false }, "amex");
  ok(
    "initiator: merchant, not recurring → internet, reason 10 on Amex",
    ucof.commerceIndicator === "internet" &&
      ucof.authorizationOptions.initiator.merchantInitiatedTransaction?.reason === "10",
  );
  ok(
    "initiator: merchant, not recurring, Visa → no reason",
    !cybersourceStoredCredential({ by: "merchant", recurring: false }, "visa").authorizationOptions
      .initiator.merchantInitiatedTransaction,
  );
  const unknown = cybersourceStoredCredential(undefined, "discover");
  ok(
    "initiator: unknown → the unscheduled MIT default",
    unknown.authorizationOptions.initiator.type === "merchant" &&
      unknown.authorizationOptions.initiator.merchantInitiatedTransaction?.reason === "10",
  );
  const cit = cybersourceStoredCredential({ by: "customer", recurring: true }, "mastercard");
  ok(
    "initiator: customer → internet, type customer, stored credential",
    cit.commerceIndicator === "internet" &&
      cit.authorizationOptions.initiator.type === "customer" &&
      cit.authorizationOptions.initiator.storedCredentialUsed === true,
  );
  ok(
    "echeck: a recurring personal debit → WEB + recurring",
    JSON.stringify(cybersourceEcheckProcessing({ by: "merchant", recurring: true }, "checking")) ===
      JSON.stringify({ commerceIndicator: "recurring", bankTransferOptions: { secCode: "WEB" } }),
  );
  ok(
    "echeck: a one-off debit → WEB + internet",
    cybersourceEcheckProcessing(undefined, "savings").commerceIndicator === "internet" &&
      cybersourceEcheckProcessing(undefined, "savings").bankTransferOptions.secCode === "WEB",
  );
  ok(
    "echeck: a corporate checking account → CCD",
    cybersourceEcheckProcessing(undefined, "corporate checking").bankTransferOptions.secCode ===
      "CCD",
  );
}

// ── 4 · declines ───────────────────────────────────────────────────────────
{
  const n = (code: string, extra: Record<string, string> = {}) =>
    normalizeCybersourceDecline({ code, ...extra });
  ok(
    "decline: INSUFFICIENT_FUND → insufficient_funds",
    n("INSUFFICIENT_FUND").code === "insufficient_funds",
  );
  ok(
    "decline: EXPIRED_CARD → expired_card, not retriable",
    n("EXPIRED_CARD").code === "expired_card" && !n("EXPIRED_CARD").retriable,
  );
  ok(
    "decline: STOLEN_LOST_CARD → stolen_card, not retriable",
    n("STOLEN_LOST_CARD").code === "stolen_card" && !n("STOLEN_LOST_CARD").retriable,
  );
  ok("decline: CVN_NOT_MATCH → incorrect_cvc", n("CVN_NOT_MATCH").code === "incorrect_cvc");
  ok("decline: CONTACT_PROCESSOR → do_not_honor", n("CONTACT_PROCESSOR").code === "do_not_honor");
  ok(
    "decline: rFlag ESYSTEM (measured) → processing_error, retriable",
    n("ESYSTEM").code === "processing_error" && n("ESYSTEM").retriable,
  );
  ok("decline: rFlag DCARDREFUSED → card_declined", n("DCARDREFUSED").code === "card_declined");
  ok("decline: ACH R01 → insufficient_funds", n("R01").code === "insufficient_funds");
  ok(
    "decline: ACH R02 → bank_account_closed, not retriable",
    n("R02").code === "bank_account_closed" && !n("R02").retriable,
  );
  ok("decline: ACH R10 → debit_not_authorized", n("R10").code === "debit_not_authorized");
  const missing = n("MISSING_FIELD");
  ok(
    "decline: MISSING_FIELD is our side, hidden from the payer",
    missing.code === "gateway_request_rejected" &&
      !missing.retriable &&
      missing.ruleId === "cybersource.code.missing_field" &&
      declineHiddenFromPayer(missing.code),
  );
  const gone = n("PAYMENT_INSTRUMENT_NOT_FOUND");
  ok(
    "decline: a deleted instrument → payment_method_not_found, payer may read it",
    gone.code === "payment_method_not_found" && !gone.retriable && gone.exposedToPayer === true,
  );
  const jti = normalizeCybersourceDecline(
    cybersourceDeclineSignal({
      status: "INVALID_REQUEST",
      reason: "INVALID_DATA",
      details: [{ field: "tokenInformation.jti", reason: "INVALID_DATA" }],
    }),
  );
  ok(
    "decline: INVALID_DATA on tokenInformation.jti (measured) → enter the card again, retriable",
    jti.code === "processing_error" && jti.retriable && jti.exposedToPayer === true,
  );
  ok(
    "decline: a Mastercard advice code 24 asks for a 1 hour wait",
    normalizeCybersourceDecline({
      code: "PROCESSOR_DECLINED",
      cardBrand: "mastercard",
      recommendationCode: "24",
    }).retryAfterMs === 3_600_000,
  );
  ok(
    "decline: an unknown reason passes through, retriable",
    n("SOMETHING_NEW").code === "SOMETHING_NEW" && n("SOMETHING_NEW").retriable,
  );
  ok("decline: the set is registered", DECLINE_SETS.cybersource.rules.length > 0);
  const ids = DECLINE_SETS.cybersource.rules.map((r) => r.id);
  ok("decline: rule ids are unique", new Set(ids).size === ids.length);
}

// ── 5 · payment answers and Transaction Search records ────────────────────
{
  const ok201 = readPaymentResponse(201, { id: TX, status: "AUTHORIZED" }, "sale");
  ok(
    "payment: AUTHORIZED sale → succeeded",
    "result" in ok201 && ok201.result.status === "succeeded",
  );
  const ach = readPaymentResponse(201, { id: TX, status: "PENDING" }, "echeck");
  ok("payment: PENDING eCheck → pending", "result" in ach && ach.result.status === "pending");
  const review = readPaymentResponse(201, { id: TX, status: "AUTHORIZED_PENDING_REVIEW" }, "sale");
  ok(
    "payment: AUTHORIZED_PENDING_REVIEW → pending",
    "result" in review && review.result.status === "pending",
  );
  const declined = readPaymentResponse(
    201,
    {
      id: TX,
      status: "DECLINED",
      errorInformation: { reason: "INSUFFICIENT_FUND", message: "Decline - Insufficient funds" },
      processorInformation: { responseCode: "51" },
      paymentInformation: { card: { type: "001" } },
    },
    "sale",
  );
  ok(
    "payment: DECLINED → failed with the normalized reason",
    "result" in declined &&
      declined.result.status === "failed" &&
      declined.result.failure?.code === "insufficient_funds" &&
      declined.result.failure.providerCode === "INSUFFICIENT_FUND",
  );
  // Measured 2026-10-25: a repeated transactionId.
  const dup = readPaymentResponse(
    400,
    { id: TX, status: "INVALID_REQUEST", reason: "DUPLICATE_REQUEST" },
    "sale",
  );
  ok("payment: DUPLICATE_REQUEST (measured) → look the original up", "duplicate" in dup);
  // Measured 2026-10-25: an unconfigured processor.
  const se = readPaymentResponse(
    502,
    {
      id: TX,
      status: "SERVER_ERROR",
      reason: "SYSTEM_ERROR",
      message: "Error - General system failure.",
    },
    "sale",
  );
  ok(
    "payment: SERVER_ERROR (measured) → read the transaction back",
    "lookup" in se && se.lookup === TX,
  );
  const mf = readPaymentResponse(
    400,
    {
      id: TX,
      status: "INVALID_REQUEST",
      reason: "MISSING_FIELD",
      details: [{ field: "orderInformation.billTo.locality", reason: "MISSING_FIELD" }],
    },
    "sale",
  );
  ok(
    "payment: MISSING_FIELD (measured shape) → failed, our side",
    "result" in mf && mf.result.failure?.code === "gateway_request_rejected",
  );

  // The record of the measured SERVER_ERROR, as Transaction Search returned it.
  const esystem: CsTransaction = {
    id: TX,
    submitTimeUTC: "2026-10-24T19:04:15Z",
    clientReferenceInformation: { code: "TC50171_3" },
    applicationInformation: {
      reasonCode: 150,
      applications: [
        {
          name: "ics_auth",
          reasonCode: "150",
          rCode: "-1",
          rFlag: "ESYSTEM",
          rMessage:
            "The following property is either invalid or missing: usd_outlet_id, usd_terminal_id",
        },
        { name: "ics_decision" },
        { name: "ics_decision_early", reasonCode: "100", rCode: "1" },
      ],
    },
    orderInformation: { amountDetails: { totalAmount: "102.21", currency: "USD" } },
    paymentInformation: { card: { type: "001", suffix: "1111" } },
  };
  const r = chargeResultFromTransaction(esystem);
  ok(
    "tss: ics_auth rCode -1 ESYSTEM (measured) → failed processing_error",
    r.status === "failed" && r.failure?.code === "processing_error",
  );
  const sale: CsTransaction = {
    id: TX,
    applicationInformation: {
      applications: [
        { name: "ics_auth", rCode: "1", rFlag: "SOK" },
        { name: "ics_bill", rCode: "1", rFlag: "SOK" },
      ],
    },
  };
  ok("tss: auth + bill ok → succeeded", chargeResultFromTransaction(sale).status === "succeeded");
  ok(
    "tss: auth ok without a bill → pending for a sale, succeeded for an authorization",
    chargeResultFromTransaction({
      id: TX,
      applicationInformation: { applications: [{ name: "ics_auth", rCode: "1" }] },
    }).status === "pending" &&
      chargeResultFromTransaction(
        { id: TX, applicationInformation: { applications: [{ name: "ics_auth", rCode: "1" }] } },
        { authorization: true },
      ).status === "succeeded",
  );
  ok(
    "tss: a declined auth → failed with the rFlag",
    chargeResultFromTransaction({
      id: TX,
      applicationInformation: {
        applications: [{ name: "ics_auth", rCode: "0", rFlag: "DCARDEXPIRED" }],
      },
    }).failure?.code === "expired_card",
  );
  ok(
    "tss: an accepted eCheck debit stays pending",
    chargeResultFromTransaction({
      id: TX,
      applicationInformation: { applications: [{ name: "ics_ecp_debit", rCode: "1" }] },
    }).status === "pending",
  );
  // Measured 2026-10-25: eCheck on a processor without it.
  ok(
    "tss: an eCheck debit refused by the processor (measured) → failed",
    chargeResultFromTransaction({
      id: TX,
      applicationInformation: {
        applications: [
          {
            name: "ics_ecp_debit",
            rCode: "-1",
            rFlag: "ESYSTEM",
            rMessage:
              "The payment processor fdiglobal is not configured to process ECP transactions",
          },
        ],
      },
    }).status === "failed",
  );
}

// ── 6 · event mapping ──────────────────────────────────────────────────────
{
  const n = (eventType: string, payload: unknown): CybersourceNotification => ({
    eventType,
    webhookId: "wh1",
    productId: "x",
    organizationId: ORG,
    eventDate: "2026-10-25T10:00:00",
    transactionTraceId: "trace-1",
    retryNumber: 0,
    payload,
  });
  const ours: CsTransaction = {
    id: TX,
    clientReferenceInformation: { code: cybersourceReference("k1") },
    submitTimeUtc: "2026-10-25T09:59:00Z",
    applicationInformation: {
      applications: [
        { name: "ics_auth", rCode: "1" },
        { name: "ics_bill", rCode: "1" },
      ],
    },
  };
  // The guide's TMS example shape, with our instrument behind the link.
  const tmsPayload = {
    data: {
      _links: {
        paymentInstruments: [{ href: `/tms/v1/paymentinstruments/${PI}` }],
        instrumentIdentifiers: [{ href: "/tms/v1/instrumentidentifiers/7000000000000001111" }],
      },
      id: "7000000000000001111",
      type: "tokenizedCardEnrollments",
      version: "1.0",
    },
    organizationId: ORG,
  };
  ok(
    "events: payment instrument ids come from the TMS links",
    paymentInstrumentIdsOf(tmsPayload).join() === PI,
  );
  const upd = normalizeCybersourceNotification(
    n("tms.networktoken.updated", tmsPayload),
    "e1",
    {},
    {
      instruments: [
        {
          id: PI,
          card: { expirationMonth: "12", expirationYear: "2031", type: "001" },
          _embedded: { instrumentIdentifier: { card: { number: "411111XXXXXX1111" } } },
        },
      ],
    },
  );
  ok(
    "events: tms.networktoken.updated → payment_method.updated with the card read back",
    upd.length === 1 &&
      upd[0]!.type === "payment_method.updated" &&
      upd[0]!.providerPaymentMethodId === PI &&
      upd[0]!.card?.last4 === "1111" &&
      upd[0]!.card?.expYear === 2031 &&
      upd[0]!.card?.brand === "visa",
  );
  ok(
    "events: a token update with no instrument read → unknown",
    normalizeCybersourceNotification(n("tms.networktoken.updated", tmsPayload), "e1", {})[0]!
      .type === "unknown",
  );
  const txPayload = { data: { _links: { self: { href: `/pts/v2/payments/${TX}` } } } };
  ok("events: a transaction id comes from a payments href", transactionIdOf(txPayload) === TX);
  ok(
    "events: a transaction id comes from an id field",
    transactionIdOf({ caseInfo: { transactionId: TX } }) === TX,
  );
  const rev = normalizeCybersourceNotification(
    n("risk.profile.decision.review", txPayload),
    "e2",
    {},
    { tx: ours },
  );
  ok(
    "events: risk review → review.opened, ownership ours from our reference",
    rev[0]!.type === "review.opened" &&
      rev[0]!.ownership === "ours" &&
      rev[0]!.providerChargeId === TX,
  );
  const acc = normalizeCybersourceNotification(
    n("risk.casemanagement.decision.accept", txPayload),
    "e3",
    {},
    { tx: ours },
  );
  ok(
    "events: case accepted → review.closed + charge.succeeded from the record",
    acc.map((e) => e.type).join() === "review.closed,charge.succeeded",
  );
  const rej = normalizeCybersourceNotification(
    n("risk.casemanagement.decision.reject", txPayload),
    "e4",
    {},
    {},
  );
  ok(
    "events: case rejected, record unread → review.closed + charge.failed",
    rej.map((e) => e.type).join() === "review.closed,charge.failed",
  );
  const foreign = normalizeCybersourceNotification(
    n("risk.profile.decision.review", txPayload),
    "e5",
    {},
    {
      tx: { ...ours, clientReferenceInformation: { code: "SOMEONE-ELSE" } },
    },
  );
  ok("events: a record without our reference is foreign", foreign[0]!.ownership === "foreign");
  const ret = normalizeCybersourceNotification(
    n("payments.payments.failed", { ...txPayload, returnCode: "R02" }),
    "e6",
    {},
  );
  ok(
    "events: a returned eCheck debit → charge.failed with the NACHA code",
    ret[0]!.type === "charge.failed" &&
      ret[0]!.failureCode === "bank_account_closed" &&
      ret[0]!.failureRetriable === false,
  );
  ok(
    "events: an accepted eCheck debit → charge.pending",
    normalizeCybersourceNotification(n("payments.payments.accepted", txPayload), "e7", {})[0]!
      .type === "charge.pending",
  );
  ok(
    "events: a failed eCheck credit → refund.failed",
    normalizeCybersourceNotification(n("payments.credits.failed", txPayload), "e8", {})[0]!
      .providerRefundId === TX,
  );
  ok(
    "events: an unread event type → unknown",
    normalizeCybersourceNotification(n("invoicing.customer.invoice.paid", {}), "e9", {})[0]!
      .type === "unknown",
  );
  const a = cybersourceEventId(n("risk.profile.decision.review", txPayload));
  const retry = cybersourceEventId({
    ...n("risk.profile.decision.review", txPayload),
    transactionTraceId: "trace-2",
    retryNumber: 1,
  });
  const other = cybersourceEventId(
    n("risk.profile.decision.review", { data: { id: "7900000000000000000099" } }),
  );
  ok("events: a retry (new trace id) keeps the event id", a === retry && Boolean(a));
  ok("events: another payload gets another event id", a !== other);
  const products = selectWebhookProducts([
    {
      productId: "tokenManagement",
      eventTypes: [
        { eventName: "tms.networktoken.provisioned", payloadEncryption: false },
        { eventName: "tms.networktoken.updated", payloadEncryption: false },
      ],
    },
    {
      productId: "fraudManagementEssentials",
      eventTypes: [
        { eventName: "risk.profile.decision.review", payloadEncryption: false },
        { eventName: "risk.casemanagement.decision.accept", payloadEncryption: false },
      ],
    },
    {
      productId: "payments",
      eventTypes: [{ eventName: "payments.capture.status.accepted", payloadEncryption: true }],
    },
    {
      productId: "customerInvoicing",
      eventTypes: [{ eventName: "invoicing.customer.invoice.paid", payloadEncryption: false }],
    },
  ]);
  ok(
    "events: subscribe to what we read, enabled and unencrypted only (measured product list shape)",
    JSON.stringify(products) ===
      JSON.stringify([
        { productId: "tokenManagement", eventTypes: ["tms.networktoken.updated"] },
        {
          productId: "fraudManagementEssentials",
          eventTypes: ["risk.casemanagement.decision.accept", "risk.profile.decision.review"],
        },
      ]),
  );
  ok(
    "events: every event we subscribe to has a mapping",
    Object.values(CYBERSOURCE_WEBHOOK_EVENTS)
      .flat()
      .every(
        (e) =>
          normalizeCybersourceNotification(
            n(e, txPayload),
            "x",
            {},
            { tx: ours, instruments: [{ id: PI, card: { type: "001" } }] },
          )[0]!.type !== "unknown",
      ),
  );
  ok(
    "events: :443 is ignored when matching our URL (measured)",
    normalizeWebhookUrl("https://h.example.com:443/v1/gateway_webhooks/cybersource?id=gwa_1") ===
      "https://h.example.com/v1/gateway_webhooks/cybersource?id=gwa_1",
  );
}

// ── 7 · capabilities, catalog, factory ─────────────────────────────────────
{
  const def = GATEWAYS.cybersource;
  ok(
    "catalog: key and display name",
    def.key === "cybersource" && def.displayName === "CyberSource",
  );
  ok(
    "catalog: credential fields",
    def.credentialFields.map((f) => f.key).join() === "organization_id,key_id,shared_secret",
  );
  ok(
    "catalog: provider-minted webhook secret, query string kept",
    def.webhook.secret === "provider_minted" && !def.webhook.accountIdInPath,
  );
  ok(
    "catalog: eCheck settles by webhook",
    def.settlement.asyncMethods?.includes("us_bank_account") === true,
  );
  const creds = { organization_id: ORG, key_id: KEY_ID, shared_secret: SECRET };
  const a = GATEWAY_FACTORIES.cybersource.build(creds, { businessId: "biz_x", livemode: false });
  ok("factory: builds", a.key === "cybersource");
  ok(
    "factory: capabilities match the catalog",
    JSON.stringify(a.capabilities.methods) === JSON.stringify(def.advertisedMethods),
  );
  ok(
    "factory: refunds, partial refunds, intents, void",
    a.capabilities.refunds &&
      a.capabilities.partialRefunds &&
      a.capabilities.intents === true &&
      a.capabilities.intentVoid === true,
  );
  ok(
    "factory: a bad key id is refused",
    (await throws(() =>
      GATEWAY_FACTORIES.cybersource.build(
        { ...creds, key_id: "yourname" },
        { businessId: "b", livemode: false },
      ),
    )) instanceof GatewayResolveError,
  );
  ok(
    "factory: a bad shared secret is refused",
    (await throws(() =>
      GATEWAY_FACTORIES.cybersource.build(
        { ...creds, shared_secret: "abc" },
        { businessId: "b", livemode: false },
      ),
    )) instanceof GatewayResolveError,
  );
  ok(
    "factory: missing credentials are refused",
    (await throws(() =>
      GATEWAY_FACTORIES.cybersource.build({ key_id: KEY_ID }, { businessId: "b", livemode: false }),
    )) instanceof GatewayResolveError,
  );
  ok(
    "catalog: the notification URL keeps ?id=",
    /\/v1\/gateway_webhooks\/cybersource\?id=gwa_x$/.test(
      buildNotificationUrl({ gatewayKey: "cybersource", gatewayAccountPublicId: "gwa_x" }),
    ),
  );
  ok(
    "display: a bank instrument shows the last four digits",
    JSON.stringify(
      describeCybersourceInstrument({
        bankAccount: { type: "checking" },
        _embedded: { instrumentIdentifier: { bankAccount: { number: "XXXXXXXXXXXXX4567" } } },
      }),
    ) === JSON.stringify({ type: "us_bank_account", last4: "4567" }),
  );
}

// ── 8 · the adapter against a stubbed API ──────────────────────────────────
type Answer = (method: string, path: string, body: Record<string, unknown> | null) => unknown;
const realFetch = globalThis.fetch;
let answer: Answer = () => ({});
const sent: Array<{
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}> = [];
let failTransport: ((path: string) => boolean) | null = null;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = new URL(String(url));
  const path = u.pathname + u.search;
  const raw = String(init?.body ?? "");
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  const method = init?.method ?? "GET";
  sent.push({ method, path, body, headers: (init?.headers ?? {}) as Record<string, string> });
  if (failTransport?.(path)) throw new TypeError("fetch failed");
  const out = answer(method, path, body);
  const status = (out as { __status?: number } | null)?.__status ?? 200;
  const text = typeof out === "string" ? out : JSON.stringify(out);
  return new Response(status === 204 ? null : text, {
    status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

try {
  const adapter = new CybersourceProvider({
    organizationId: ORG,
    keyId: KEY_ID,
    sharedSecret: SECRET,
    livemode: false,
    webhookSecret: WH_SECRET,
    defaultOrigins: ["https://pay.example.com"],
    apiHost: "https://cybs.invalid",
    lookupDelaysMs: [0, 0],
  });
  const customer = { providerKey: "cybersource" as const, providerCustomerId: CID };
  const pm = {
    providerKey: "cybersource" as const,
    providerPaymentMethodId: PI,
    providerCustomerId: CID,
    display: { type: "card" as const, brand: "mastercard" },
  };
  const tssOf = (
    apps: Array<{ name: string; rCode: string; rFlag?: string }>,
    code?: string,
  ): CsTransaction => ({
    id: TX,
    clientReferenceInformation: { code: code ?? "x" },
    applicationInformation: { applications: apps },
    orderInformation: { amountDetails: { totalAmount: "12.34", currency: "USD" } },
  });

  // A renewal: MIT recurring on a stored instrument.
  answer = () => ({ __status: 201, id: TX, status: "AUTHORIZED" });
  sent.length = 0;
  const c1 = await adapter.charge({
    amountMinor: 1234n,
    currency: "usd",
    customer,
    paymentMethod: pm,
    idempotencyKey: "inv_1_attempt_1",
    initiator: { by: "merchant", recurring: true },
  });
  const b1 = sent[0]!.body as {
    processingInformation: Record<string, unknown>;
    paymentInformation: Record<string, Record<string, string>>;
    orderInformation: Record<string, Record<string, string>>;
    clientReferenceInformation: Record<string, string>;
  };
  ok("charge: AUTHORIZED → succeeded", c1.status === "succeeded" && c1.providerChargeId === TX);
  ok(
    "charge: POST /pts/v2/payments, signed",
    sent[0]!.path === "/pts/v2/payments" &&
      /keyid=/.test(sent[0]!.headers.signature ?? "") &&
      sent[0]!.headers["v-c-merchant-id"] === ORG,
  );
  ok(
    "charge: capture true, recurring MIT on Mastercard carries reason 7",
    b1.processingInformation.capture === true &&
      b1.processingInformation.commerceIndicator === "recurring" &&
      JSON.stringify(b1.processingInformation.authorizationOptions).includes('"reason":"7"'),
  );
  ok(
    "charge: the stored instrument and customer are sent",
    b1.paymentInformation.paymentInstrument!.id === PI &&
      b1.paymentInformation.customer!.id === CID,
  );
  ok(
    "charge: amount in major units from minor",
    b1.orderInformation.amountDetails!.totalAmount === "12.34" &&
      b1.orderInformation.amountDetails!.currency === "USD",
  );
  const ref = cybersourceReference("inv_1_attempt_1");
  ok(
    "charge: our reference is both code and transactionId (30 chars)",
    b1.clientReferenceInformation.code === ref &&
      b1.clientReferenceInformation.transactionId === ref &&
      ref.length === 30,
  );

  // A repeat: DUPLICATE_REQUEST → Transaction Search finds the original.
  answer = (method, path) => {
    if (path === "/pts/v2/payments")
      return {
        __status: 400,
        id: "7900000000000000000002",
        status: "INVALID_REQUEST",
        reason: "DUPLICATE_REQUEST",
      };
    if (path === "/tss/v2/searches")
      return {
        __status: 201,
        _embedded: {
          transactionSummaries: [
            {
              id: "7900000000000000000002",
              applicationInformation: {
                applications: [{ name: "ics_auth", rCode: "0", rFlag: "DDUPLICATE" }],
              },
            },
            {
              id: TX,
              applicationInformation: { applications: [{ name: "ics_auth", rCode: "1" }] },
            },
          ],
        },
      };
    if (path === `/tss/v2/transactions/${TX}`)
      return tssOf(
        [
          { name: "ics_auth", rCode: "1" },
          { name: "ics_bill", rCode: "1" },
        ],
        ref,
      );
    return { __status: 404 };
  };
  sent.length = 0;
  const c2 = await adapter.charge({
    amountMinor: 1234n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "inv_1_attempt_1",
  });
  ok(
    "idempotency: a duplicate is answered with the original's outcome, not the DDUPLICATE record (measured)",
    c2.status === "succeeded" && c2.providerChargeId === TX,
  );
  ok(
    "idempotency: the search is by our reference",
    JSON.stringify(sent.find((s) => s.path === "/tss/v2/searches")?.body).includes(
      `clientReferenceInformation.code:${ref}`,
    ),
  );

  // SERVER_ERROR (measured) → read back → ESYSTEM → failed.
  answer = (method, path) => {
    if (path === "/pts/v2/payments")
      return { __status: 502, id: TX, status: "SERVER_ERROR", reason: "SYSTEM_ERROR" };
    if (path === `/tss/v2/transactions/${TX}`)
      return tssOf([{ name: "ics_auth", rCode: "-1", rFlag: "ESYSTEM" }]);
    return { __status: 404 };
  };
  const c3 = await adapter.charge({
    amountMinor: 100n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "k3",
  });
  ok(
    "server error: the record shows ESYSTEM → failed processing_error",
    c3.status === "failed" && c3.failure?.code === "processing_error",
  );

  // SERVER_TIMEOUT and an unreadable record → unknown.
  answer = (method, path) =>
    path === "/pts/v2/payments"
      ? { __status: 502, id: TX, status: "SERVER_ERROR", reason: "SERVER_TIMEOUT" }
      : { __status: 404 };
  ok(
    "server timeout: no record → ProviderIndeterminateError",
    (await throws(() =>
      adapter.charge({
        amountMinor: 100n,
        currency: "USD",
        customer,
        paymentMethod: pm,
        idempotencyKey: "k4",
      }),
    )) instanceof ProviderIndeterminateError,
  );

  // Lost answer → found by reference.
  failTransport = (p) => p === "/pts/v2/payments";
  answer = (method, path) => {
    if (path === "/tss/v2/searches")
      return {
        __status: 201,
        _embedded: {
          transactionSummaries: [
            {
              id: TX,
              applicationInformation: {
                applications: [{ name: "ics_auth", rCode: "0", rFlag: "DCARDREFUSED" }],
              },
            },
          ],
        },
      };
    if (path === `/tss/v2/transactions/${TX}`)
      return tssOf([{ name: "ics_auth", rCode: "0", rFlag: "DCARDREFUSED" }]);
    return { __status: 404 };
  };
  const c5 = await adapter.charge({
    amountMinor: 100n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "k5",
  });
  ok(
    "lost answer: the record found by reference decides (declined)",
    c5.status === "failed" && c5.failure?.code === "card_declined",
  );
  answer = (method, path) =>
    path === "/tss/v2/searches"
      ? { __status: 201, _embedded: { transactionSummaries: [] } }
      : { __status: 404 };
  ok(
    "lost answer: nothing found → ProviderIndeterminateError",
    (await throws(() =>
      adapter.charge({
        amountMinor: 100n,
        currency: "USD",
        customer,
        paymentMethod: pm,
        idempotencyKey: "k6",
      }),
    )) instanceof ProviderIndeterminateError,
  );
  failTransport = null;

  // INVALID_DATA on a deleted instrument (measured: no detail) → payment_method_not_found.
  answer = (method, path) => {
    if (path === "/pts/v2/payments")
      return {
        __status: 400,
        id: TX,
        status: "INVALID_REQUEST",
        reason: "INVALID_DATA",
        message: "Declined - One or more fields in the request contains invalid data",
      };
    if (path.includes("/payment-instruments/"))
      return { __status: 410, errors: [{ type: "notAvailable", message: "Token not available" }] };
    return { __status: 404 };
  };
  const c7 = await adapter.charge({
    amountMinor: 100n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "k7",
  });
  ok(
    "charge: INVALID_DATA on a deleted instrument → payment_method_not_found",
    c7.status === "failed" &&
      c7.failure?.code === "payment_method_not_found" &&
      c7.failure.retriable === false,
  );

  // eCheck renewal on a stored bank instrument.
  answer = (method, path) => {
    if (path === "/pts/v2/payments") return { __status: 201, id: TX, status: "PENDING" };
    if (path.includes("/payment-instruments/"))
      return { id: PI, bankAccount: { type: "checking" } };
    return { __status: 404 };
  };
  sent.length = 0;
  const bankPm = { ...pm, display: { type: "us_bank_account" as const } };
  const c8 = await adapter.charge({
    amountMinor: 2000n,
    currency: "USD",
    customer,
    paymentMethod: bankPm,
    idempotencyKey: "k8",
    initiator: { by: "merchant", recurring: true },
  });
  const b8 = sent.find((s) => s.path === "/pts/v2/payments")!.body as {
    processingInformation: Record<string, unknown>;
    paymentInformation: Record<string, Record<string, string>>;
  };
  ok("echeck: a renewal debit returns pending", c8.status === "pending");
  ok(
    "echeck: WEB + recurring, paymentType check, no capture flag",
    JSON.stringify(b8.processingInformation) ===
      JSON.stringify({ commerceIndicator: "recurring", bankTransferOptions: { secCode: "WEB" } }) &&
      b8.paymentInformation.paymentType!.name === "check",
  );

  // Refund: card credit accepted → succeeded; eCheck credit → pending.
  answer = (method, path) => {
    if (path === `/tss/v2/transactions/${TX}`)
      return tssOf([
        { name: "ics_auth", rCode: "1" },
        { name: "ics_bill", rCode: "1" },
      ]);
    if (path === `/pts/v2/payments/${TX}/refunds`)
      return { __status: 201, id: "7900000000000000000009", status: "PENDING" };
    return { __status: 404 };
  };
  sent.length = 0;
  const rf = await adapter.refund({
    providerChargeId: TX,
    amountMinor: 500n,
    currency: "USD",
    idempotencyKey: "rf1",
  });
  ok(
    "refund: a card credit accepted → succeeded",
    rf.status === "succeeded" && rf.providerRefundId === "7900000000000000000009",
  );
  ok(
    "refund: partial amount sent",
    JSON.stringify(sent.at(-1)!.body).includes('"totalAmount":"5.00"'),
  );
  answer = (method, path) =>
    path === `/tss/v2/transactions/${TX}`
      ? tssOf([{ name: "ics_ecp_debit", rCode: "1" }])
      : { __status: 201, id: "7900000000000000000010", status: "PENDING" };
  const rf2 = await adapter.refund({ providerChargeId: TX, idempotencyKey: "rf2" });
  ok(
    "refund: an eCheck credit → pending, full amount by default",
    rf2.status === "pending" && JSON.stringify(sent.at(-1)!.body).includes('"totalAmount":"12.34"'),
  );
  answer = () => ({ __status: 404 });
  ok(
    "refund: an unknown payment is refused",
    (await throws(() => adapter.refund({ providerChargeId: TX, idempotencyKey: "rf3" }))) instanceof
      ProviderRefusalError,
  );

  // The sdk flow: a setup intent.
  const ctxJwt = `eyJraWQiOiJ6dSIsImFsZyI6IlJTMjU2In0.${Buffer.from(JSON.stringify({ ctx: [{ data: { clientLibrary: "https://testflex.cybersource.com/microform/bundle/v2.12.1/flex-microform.min.js", clientLibraryIntegrity: "sha256-x" } }] })).toString("base64url")}.sig`;
  answer = (method, path) => (path === "/microform/v2/sessions" ? ctxJwt : { __status: 404 });
  sent.length = 0;
  const setup = await adapter.createIntent({
    purpose: "setup",
    currency: "USD",
    customer,
    idempotencyKey: "si1",
    returnUrl: "https://shop.example.com/portal/x",
  });
  const sb = sent[0]!.body as { targetOrigins: string[]; allowedPaymentTypes: string[] };
  ok(
    "intent: a setup is a synthetic id with an sdk challenge",
    setup.status === "requires_action" &&
      decodeSyntheticIntent(setup.intentId)?.c === CID &&
      setup.authorization?.mode === "sdk",
  );
  ok(
    "intent: target origins = the return URL's origin + the configured ones",
    sb.targetOrigins.join() === "https://shop.example.com,https://pay.example.com",
  );
  ok("intent: a setup asks for cards only", sb.allowedPaymentTypes.join() === "CARD");
  ok(
    "intent: sdk params carry the client library from the capture context",
    setup.authorization?.sdk?.params.clientLibrary ===
      "https://testflex.cybersource.com/microform/bundle/v2.12.1/flex-microform.min.js",
  );
  const pay = await adapter.createIntent({
    purpose: "payment",
    amountMinor: 2500n,
    currency: "USD",
    customer,
    idempotencyKey: "pi1",
    returnUrl: "https://shop.example.com/pay",
  });
  ok(
    "intent: a USD payment also offers a bank account, flagged for NACHA authorization",
    (sent.at(-1)!.body as { allowedPaymentTypes: string[] }).allowedPaymentTypes.join() ===
      "CARD,CHECK" && pay.authorization?.sdk?.params.achAuthorizationRequired === true,
  );
  await adapter.createIntent({
    purpose: "payment",
    amountMinor: 2500n,
    currency: "EUR",
    customer,
    idempotencyKey: "pi2",
    returnUrl: "https://shop.example.com/pay",
  });
  ok(
    "intent: a non-USD payment offers cards only",
    (sent.at(-1)!.body as { allowedPaymentTypes: string[] }).allowedPaymentTypes.join() === "CARD",
  );

  const cardToken = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ content: { paymentInformation: { card: { number: { maskedValue: "XXXXXXXXXXXX1111" } } } } })).toString("base64url")}.sig`;
  const bankToken = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ content: { paymentInformation: { bank: { account: {} } } } })).toString("base64url")}.sig`;
  answer = (method, path) => {
    if (path === "/pts/v2/payments")
      return {
        __status: 201,
        id: TX,
        status: "AUTHORIZED",
        tokenInformation: {
          paymentInstrument: { id: PI },
          instrumentIdentifier: { id: "7000000000000001111" },
        },
      };
    if (path.includes("/payment-instruments/"))
      return {
        id: PI,
        card: { type: "001", expirationMonth: "12", expirationYear: "2031" },
        _embedded: { instrumentIdentifier: { card: { number: "411111XXXXXX1111" } } },
      };
    return { __status: 404 };
  };
  sent.length = 0;
  const sub = await adapter.submitClientResult({
    intentId: setup.intentId,
    purpose: "setup",
    idempotencyKey: "sc1",
    clientResult: {
      transientToken: cardToken,
      firstName: "Test",
      lastName: "Payer",
      address1: "1 Market St",
      locality: "San Francisco",
      administrativeArea: "ca",
      postalCode: "94105",
      country: "us",
      email: "payer@example.com",
    },
  });
  const zb = sent[0]!.body as {
    processingInformation: Record<string, unknown>;
    orderInformation: { amountDetails: Record<string, string>; billTo: Record<string, string> };
    tokenInformation: Record<string, string>;
    paymentInformation: Record<string, Record<string, string>>;
  };
  ok(
    "setup: a zero-amount authorization with TOKEN_CREATE under the customer",
    zb.orderInformation.amountDetails.totalAmount === "0.00" &&
      JSON.stringify(zb.processingInformation.actionList) === '["TOKEN_CREATE"]' &&
      zb.paymentInformation.customer!.id === CID &&
      zb.tokenInformation.transientTokenJwt === cardToken,
  );
  ok(
    "setup: a customer-initiated stored-credential start",
    JSON.stringify(zb.processingInformation.authorizationOptions) ===
      '{"initiator":{"type":"customer","credentialStoredOnFile":true}}',
  );
  ok(
    "setup: billing address sent, codes uppercased",
    zb.orderInformation.billTo.country === "US" &&
      zb.orderInformation.billTo.administrativeArea === "CA",
  );
  ok(
    "setup: authorized with the vaulted instrument as the intent",
    sub.status === "authorized" && sub.gatewayIntentId === `pi:${CID}:${PI}`,
  );
  const consumed = await adapter.consumeIntent({
    intentId: sub.gatewayIntentId!,
    purpose: "setup",
    idempotencyKey: "cs1",
  });
  ok(
    "setup: consuming returns the card",
    consumed.purpose === "setup" &&
      consumed.paymentMethod?.providerPaymentMethodId === PI &&
      consumed.paymentMethod.display.last4 === "1111" &&
      consumed.paymentMethod.display.brand === "visa",
  );
  ok(
    "setup: voiding a saved card holds nothing",
    JSON.stringify(
      await adapter.voidIntent({ intentId: sub.gatewayIntentId!, idempotencyKey: "v1" }),
    ) === JSON.stringify({ voided: true, held: false }),
  );
  const bankSetup = await adapter.submitClientResult({
    intentId: setup.intentId,
    purpose: "setup",
    idempotencyKey: "sc2",
    clientResult: { transientToken: bankToken },
  });
  ok(
    "setup: a bank account cannot be saved without a payment",
    bankSetup.status === "failed" && bankSetup.failure?.code === "payment_method_not_supported",
  );
  ok(
    "setup: a malformed token is refused",
    (
      await adapter.submitClientResult({
        intentId: setup.intentId,
        purpose: "setup",
        idempotencyKey: "sc3",
        clientResult: { transientToken: "nope" },
      })
    ).failure?.code === "invalid_client_result",
  );

  // Pay now by bank account: an eCheck debit stands in for the hold.
  answer = (method, path) => {
    if (path === "/pts/v2/payments") return { __status: 201, id: TX, status: "PENDING" };
    if (path === `/tss/v2/transactions/${TX}`)
      return tssOf([{ name: "ics_ecp_debit", rCode: "1" }]);
    if (path === `/pts/v2/payments/${TX}/voids`)
      return { __status: 201, id: "7900000000000000000011", status: "VOIDED" };
    return { __status: 404 };
  };
  sent.length = 0;
  const achPay = await adapter.submitClientResult({
    intentId: pay.intentId,
    purpose: "payment",
    idempotencyKey: "pc1",
    clientResult: { transientToken: bankToken, firstName: "A", lastName: "B" },
  });
  const ab = sent[0]!.body as {
    processingInformation: Record<string, unknown>;
    paymentInformation: Record<string, Record<string, string>>;
  };
  ok(
    "pay now (bank): WEB one-off debit with the token",
    achPay.status === "authorized" &&
      achPay.gatewayIntentId === `ach:${TX}` &&
      JSON.stringify(ab.processingInformation) ===
        JSON.stringify({
          commerceIndicator: "internet",
          bankTransferOptions: { secCode: "WEB" },
        }) &&
      ab.paymentInformation.paymentType!.name === "check",
  );
  const achCharge = await adapter.consumeIntent({
    intentId: `ach:${TX}`,
    purpose: "payment",
    idempotencyKey: "pc2",
  });
  ok(
    "pay now (bank): consuming reports the debit pending, paid by us_bank_account",
    achCharge.purpose === "payment" &&
      achCharge.charge.status === "pending" &&
      achCharge.charge.providerChargeId === TX &&
      achCharge.charge.methodUsed === "us_bank_account",
  );
  const achVoid = await adapter.voidIntent({ intentId: `ach:${TX}`, idempotencyKey: "pc3" });
  ok("pay now (bank): voiding voids the debit", achVoid.voided === true && achVoid.held === false);

  // Pay now by card: authorize, capture, reverse.
  answer = (method, path) => {
    if (path === "/pts/v2/payments") return { __status: 201, id: TX, status: "AUTHORIZED" };
    if (path === `/tss/v2/transactions/${TX}`) return tssOf([{ name: "ics_auth", rCode: "1" }]);
    if (path === `/pts/v2/payments/${TX}/captures`)
      return { __status: 201, id: "7900000000000000000012", status: "PENDING" };
    if (path === `/pts/v2/payments/${TX}/reversals`)
      return { __status: 201, id: "7900000000000000000013", status: "REVERSED" };
    return { __status: 404 };
  };
  sent.length = 0;
  const cardPay = await adapter.submitClientResult({
    intentId: pay.intentId,
    purpose: "payment",
    idempotencyKey: "pc4",
    clientResult: { transientToken: cardToken },
  });
  ok(
    "pay now (card): an authorization, not captured",
    cardPay.status === "authorized" &&
      cardPay.gatewayIntentId === TX &&
      (sent[0]!.body as { processingInformation: { capture: boolean } }).processingInformation
        .capture === false,
  );
  const cap = await adapter.consumeIntent({
    intentId: TX,
    purpose: "payment",
    idempotencyKey: "pc5",
    amountMinor: 2500n,
    currency: "USD",
  });
  ok(
    "pay now (card): capture → succeeded, paid by card",
    cap.purpose === "payment" &&
      cap.charge.status === "succeeded" &&
      cap.charge.methodUsed === "card" &&
      JSON.stringify(sent.at(-1)!.body).includes('"totalAmount":"25.00"'),
  );
  const rv = await adapter.voidIntent({ intentId: TX, idempotencyKey: "pc6" });
  ok(
    "pay now (card): void reverses the held amount read back",
    rv.voided === true &&
      rv.held === true &&
      JSON.stringify(sent.at(-1)!.body).includes('"totalAmount":"12.34"'),
  );

  // Delete: the default instrument moves to a sibling first (409 measured).
  let deleted = 0;
  answer = (method, path) => {
    if (method === "DELETE" && path === `/tms/v1/paymentinstruments/${PI}`)
      return deleted++ === 0
        ? {
            __status: 409,
            errors: [
              {
                type: "conflict",
                message:
                  "Action cannot be performed as the PaymentInstrument is the customers default",
              },
            ],
          }
        : { __status: 204 };
    if (method === "GET" && path === `/tms/v2/customers/${CID}/payment-instruments`)
      return {
        _embedded: {
          paymentInstruments: [
            { id: PI, default: true },
            { id: "0000000000000000E063000000000A02" },
          ],
        },
      };
    if (method === "PATCH" && path === `/tms/v2/customers/${CID}`) return { id: CID };
    return { __status: 404 };
  };
  sent.length = 0;
  await adapter.deletePaymentMethod({ customer, paymentMethod: pm });
  ok(
    "delete: a default instrument hands the default to a sibling, then deletes",
    sent.map((s) => `${s.method} ${s.path.split("/").slice(0, 4).join("/")}`).join() ===
      "DELETE /tms/v1/paymentinstruments,GET /tms/v2/customers,PATCH /tms/v2/customers,DELETE /tms/v1/paymentinstruments" &&
      JSON.stringify(sent[2]!.body) ===
        '{"defaultPaymentInstrument":{"id":"0000000000000000E063000000000A02"}}',
  );
  answer = () => ({ __status: 410 });
  ok(
    "delete: an instrument already gone is fine",
    (await throws(() => adapter.deletePaymentMethod({ customer, paymentMethod: pm }))) === null,
  );

  // Webhook provisioning.
  let subs: Array<{
    webhookId: string;
    webhookUrl: string;
    status: string;
    products?: Array<{ productId?: string; eventTypes?: string[] }>;
  }> = [];
  answer = (method, path, body) => {
    if (path.startsWith("/notification-subscriptions/v2/products/"))
      return [
        {
          productId: "tokenManagement",
          eventTypes: [{ eventName: "tms.networktoken.updated", payloadEncryption: false }],
        },
      ];
    if (path.startsWith("/notification-subscriptions/v2/webhooks?"))
      return subs.length ? subs : { __status: 404, errorCode: "Record Not Found" };
    if (path === "/notification-subscriptions/v2/webhooks" && method === "POST") {
      subs = [
        {
          webhookId: "wh-new",
          webhookUrl: String(body?.webhookUrl).replace("example.com/", "example.com:443/"),
          status: "PENDING_REVIEW",
          products: body?.products as Array<{ productId?: string; eventTypes?: string[] }>,
        },
      ];
      return { __status: 201, webhookId: "wh-new", status: "PENDING_REVIEW" };
    }
    if (path === "/kms/egress/v2/keys-sym")
      return {
        __status: 201,
        status: "SUCCESS",
        keyInformation: { keyId: "kid-1", key: Buffer.alloc(32, 3).toString("base64") },
      };
    if (path.startsWith("/notification-subscriptions/v2/webhooks/")) return { __status: 200 };
    return { __status: 404 };
  };
  sent.length = 0;
  const url = "https://hooks.example.com/v1/gateway_webhooks/cybersource?id=gwa_x";
  const p1 = await adapter.provisionWebhookEndpoint({ url });
  const create = sent.find((s) => s.path === "/notification-subscriptions/v2/webhooks")!.body as {
    securityPolicy: { securityType: string };
    products: unknown;
    webhookUrl: string;
    notificationScope: string;
  };
  ok(
    "provision: subscribes with securityType key (lowercase, measured)",
    create.securityPolicy.securityType === "key" &&
      create.notificationScope === "SELF" &&
      create.webhookUrl === url,
  );
  ok(
    "provision: only enabled events",
    JSON.stringify(create.products) ===
      '[{"productId":"tokenManagement","eventTypes":["tms.networktoken.updated"]}]',
  );
  ok(
    "provision: mints a key and stores keyId:key",
    p1.providerEndpointId === "wh-new" &&
      p1.webhookSecret === `kid-1:${Buffer.alloc(32, 3).toString("base64")}`,
  );
  ok(
    "provision: the key is minted after the subscription",
    sent.findIndex((s) => s.path === "/kms/egress/v2/keys-sym") >
      sent.findIndex((s) => s.path === "/notification-subscriptions/v2/webhooks"),
  );
  sent.length = 0;
  const p2 = await adapter.provisionWebhookEndpoint({ url });
  ok(
    "provision: the same URL (stored with :443) is reused, not created again, no PATCH when unchanged",
    p2.providerEndpointId === "wh-new" &&
      !sent.some(
        (s) => s.method === "POST" && s.path === "/notification-subscriptions/v2/webhooks",
      ) &&
      !sent.some((s) => s.method === "PATCH"),
  );
  answer = (method, path) =>
    path.startsWith("/notification-subscriptions/v2/products/")
      ? [
          {
            productId: "customerInvoicing",
            eventTypes: [
              { eventName: "invoicing.customer.invoice.paid", payloadEncryption: false },
            ],
          },
        ]
      : { __status: 404 };
  ok(
    "provision: an account with none of our events is refused with a reason",
    (
      (await throws(() => adapter.provisionWebhookEndpoint({ url }))) as Error | null
    )?.message.includes("none of the webhook events") === true,
  );

  // normalizeWebhook end to end.
  answer = (method, path) =>
    path === `/tss/v2/transactions/${TX}`
      ? {
          ...tssOf(
            [
              { name: "ics_auth", rCode: "1" },
              { name: "ics_bill", rCode: "1" },
            ],
            cybersourceReference("x"),
          ),
          submitTimeUTC: "2026-10-25T09:00:00Z",
        }
      : { __status: 404 };
  const body = JSON.stringify({
    eventType: "risk.casemanagement.decision.accept",
    webhookId: "wh-new",
    eventDate: "2026-10-25T10:00:00",
    transactionTraceId: "t1",
    payload: { data: { _links: { self: { href: `/pts/v2/payments/${TX}` } } } },
  });
  const evs = await adapter.normalizeWebhook({
    payload: body,
    headers: { "v-c-signature": signCybersourceWebhook(WH_SECRET, "1792900000000", body) },
  });
  ok(
    "webhook: verified, read back and mapped",
    evs.map((e) => e.type).join() === "review.closed,charge.succeeded" &&
      evs[1]!.ownership === "ours",
  );
  ok(
    "webhook: a forged delivery is refused",
    (await throws(() =>
      adapter.normalizeWebhook({
        payload: body,
        headers: {
          "v-c-signature": signCybersourceWebhook(
            `${WH_KEY_ID}:${Buffer.alloc(32, 1).toString("base64")}`,
            "1",
            body,
          ),
        },
      }),
    )) instanceof Error,
  );
  ok(
    "webhook: the event id is stable without a signature check",
    adapter.webhookEventId({ payload: body, headers: {} }).startsWith("cybs_"),
  );
} finally {
  globalThis.fetch = realFetch;
}

await closeDb().catch(() => undefined);
const failed = checks.filter(([, c]) => !c);
for (const [name, c, detail] of checks)
  console.log(`  ${c ? "✓" : "✗"} ${name}${!c && detail ? ` — ${detail}` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks`);
console.log(failed.length === 0 ? "✅ CYBERSOURCE: PASS" : "❌ CYBERSOURCE: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
