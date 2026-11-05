/**
 * verify:authorizenet — the Authorize.net adapter, offline. No network: API answers come from
 * a stubbed `fetch`, in the shapes the sandbox returned (BOM included), measured 2026-10-24.
 *
 * Covers the webhook signature, event mapping, the charge initiator → card-on-file flags,
 * decline mapping, BOM handling, idempotency without a header, refundability, capabilities,
 * the catalog and the `sdk` intent flow; eCheck setup, charge, refund and settlement poll; and
 * (needs the database) the payer's ACH authorization evidence: required, append-only, RLS.
 *
 *   pnpm verify:authorizenet
 */
import { createHmac } from "node:crypto";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { and, eq } from "drizzle-orm";
import { businesses, emailMessages, paymentMethodAuthorizations } from "@db/schema";
import "@/modules/emails/outbox";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import {
  AchAuthorizationRequiredError,
  persistVaultedPaymentMethod,
} from "@/modules/payment-methods/service";
import {
  ACH_AUTHORIZATION_TEXT_VERSION,
  AchAuthorizationError,
  achAuthorizationEvidence,
  achAuthorizationText,
} from "@/modules/payment-methods/ach-authorization";
import {
  AUTHORIZENET_VOIDED_CODE,
  AUTHORIZENET_WEBHOOK_EVENTS,
  AuthorizenetApiError,
  AuthorizenetProvider,
  authorizenetDeclineSignal,
  authorizenetDescription,
  authorizenetReference,
  authorizenetStoredCredential,
  chargeResultFromTransaction,
  decodeSyntheticIntent,
  normalizeAuthorizenetNotification,
  normalizeAuthorizenetSettlement,
  opaqueDataOf,
  parseAuthorizenetJson,
  readTransactionResponse,
  signAuthorizenetPayload,
  verifyAuthorizenetSignature,
  type AnetTransaction,
  type AuthorizenetNotification,
  unescapeAuthorizenetText,
} from "@/providers/authorizenet";
import {
  DECLINE_SETS,
  declineHiddenFromPayer,
  normalizeAuthorizenetDecline,
} from "@/providers/decline-codes";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { GATEWAY_FACTORIES, GatewayResolveError } from "@/providers/gateways";
import { buildNotificationUrl } from "@/modules/gateway/webhook-endpoint";
import {
  ProviderIndeterminateError,
  ProviderRefusalError,
  strandedObjectId,
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

const SIG_KEY = "0123456789ABCDEF".repeat(8);
const BOM = "﻿";
const OK = { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] };

// ── 1 · signature ──────────────────────────────────────────────────────────
{
  const body = JSON.stringify({
    notificationId: "n1",
    eventType: "net.authorize.payment.authcapture.created",
  });
  const upper = createHmac("sha512", Buffer.from(SIG_KEY, "utf8"))
    .update(body)
    .digest("hex")
    .toUpperCase();
  const passes = async (header: string | undefined, b: string | Buffer = body, key = SIG_KEY) =>
    (await throws(() => verifyAuthorizenetSignature(key, header, b))) === null;
  ok(
    "signature: sha512=UPPER hex with the key used as text passes",
    await passes(`sha512=${upper}`),
  );
  ok("signature: lowercase hex passes", await passes(`sha512=${upper.toLowerCase()}`));
  ok("signature: an uppercase SHA512= prefix passes", await passes(`SHA512=${upper}`));
  ok("signature: no prefix passes", await passes(upper));
  // The response hash's form (hex-decoded key) is not the webhook's (measured 2026-10-27).
  const hexSig = createHmac("sha512", Buffer.from(SIG_KEY, "hex")).update(body).digest("hex");
  ok("signature: the hex-decoded key is refused (one form)", !(await passes(`sha512=${hexSig}`)));
  ok(
    "signature: a key entered in lower case still verifies the upper-case key's signature",
    await passes(`sha512=${upper}`, body, SIG_KEY.toLowerCase()),
  );
  ok(
    "signature: signAuthorizenetPayload makes a header that passes",
    await passes(signAuthorizenetPayload(SIG_KEY, body)),
  );
  ok("signature: a tampered body is refused", !(await passes(`sha512=${upper}`, `${body} `)));
  ok(
    "signature: another key is refused",
    !(await passes(`sha512=${upper}`, body, "FEDCBA9876543210".repeat(8))),
  );
  ok(
    "signature: a non-hex key is refused",
    !(await passes(`sha512=${upper}`, body, "not-a-hex-key")),
  );
  ok("signature: a missing header is refused", !(await passes(undefined)));
  ok("signature: a short digest is refused", !(await passes("sha512=ABCD")));
  ok(
    "signature: a Buffer body is checked the same",
    await passes(`sha512=${upper}`, Buffer.from(body)),
  );
}

// ── 2 · BOM, references, nonces ────────────────────────────────────────────
{
  const j = parseAuthorizenetJson<{ messages: { resultCode: string } }>(
    `${BOM}{"messages":{"resultCode":"Ok"}}`,
  );
  ok("BOM: a body that starts with a BOM parses", j.messages.resultCode === "Ok");
  ok("BOM: a body without one parses too", parseAuthorizenetJson<{ a: number }>('{"a":1}').a === 1);
  const r = authorizenetReference("inv_X_attempt_1_pm_Y_with_a_long_key_beyond_twenty");
  ok("reference: 20 characters, tm + hex", /^tm[0-9a-f]{18}$/.test(r), r);
  ok(
    "reference: same key, same reference",
    r === authorizenetReference("inv_X_attempt_1_pm_Y_with_a_long_key_beyond_twenty"),
  );
  ok("reference: another key, another reference", r !== authorizenetReference("inv_X_attempt_2"));
  ok(
    "nonce: a bare value uses the Accept descriptor",
    opaqueDataOf("abc")?.dataDescriptor === "COMMON.ACCEPT.INAPP.PAYMENT",
  );
  ok(
    "nonce: JSON keeps its descriptor",
    opaqueDataOf('{"dataDescriptor":"D","dataValue":"v"}')?.dataDescriptor === "D",
  );
  ok(
    "nonce: empty is refused",
    opaqueDataOf("  ") === null && opaqueDataOf('{"dataValue":""}') === null,
  );
}

// ── 3 · initiator → card-on-file flags ─────────────────────────────────────
{
  const unknown = authorizenetStoredCredential(undefined);
  ok(
    "initiator: unknown → isSubsequentAuth, not recurring",
    unknown.processingOptions?.isSubsequentAuth === "true" && !unknown.recurringBilling,
  );
  const renew = authorizenetStoredCredential({ by: "merchant", recurring: true });
  ok(
    "initiator: merchant recurring → recurringBilling only",
    renew.recurringBilling && !renew.processingOptions,
  );
  const topup = authorizenetStoredCredential({ by: "merchant", recurring: false });
  ok(
    "initiator: merchant unscheduled → isSubsequentAuth",
    topup.processingOptions?.isSubsequentAuth === "true" && !topup.recurringBilling,
  );
  const signup = authorizenetStoredCredential({ by: "customer", recurring: true });
  ok(
    "initiator: customer recurring → isFirstRecurringPayment + recurringBilling",
    signup.processingOptions?.isFirstRecurringPayment === "true" && signup.recurringBilling,
  );
  const cit = authorizenetStoredCredential({ by: "customer", recurring: false });
  ok(
    "initiator: customer one-off → isStoredCredentials",
    cit.processingOptions?.isStoredCredentials === "true" && !cit.recurringBilling,
  );
  ok(
    "initiator: never sends subsequentAuthInformation",
    !JSON.stringify([unknown, renew, topup, signup, cit]).includes("subsequentAuthInformation"),
  );
}

// ── 4 · declines ───────────────────────────────────────────────────────────
{
  const n = (code: string) => normalizeAuthorizenetDecline({ code });
  ok("decline: 2 → card_declined, retriable", n("2").code === "card_declined" && n("2").retriable);
  ok("decline: 4 → pickup_card, not retriable", n("4").code === "pickup_card" && !n("4").retriable);
  ok(
    "decline: 8 → expired_card, not retriable",
    n("8").code === "expired_card" && !n("8").retriable,
  );
  ok("decline: 6 → incorrect_number", n("6").code === "incorrect_number");
  ok(
    "decline: 44/65 → incorrect_cvc",
    n("44").code === "incorrect_cvc" && n("65").code === "incorrect_cvc",
  );
  ok(
    "decline: 19 → processing_error, retriable",
    n("19").code === "processing_error" && n("19").retriable,
  );
  const gone = n("E00040");
  ok(
    "decline: E00040 → payment_method_not_found, rule, shown to the payer",
    gone.code === "payment_method_not_found" &&
      !gone.retriable &&
      gone.ruleId === "authorizenet.code.payment_profile_not_found" &&
      gone.exposedToPayer === true,
  );
  const cur = n("39");
  ok(
    "decline: 39 (currency) → gateway_request_rejected, hidden",
    cur.code === "gateway_request_rejected" && !cur.retriable && cur.exposedToPayer === false,
  );
  ok(
    "decline: 290 → gateway_request_rejected with the AVS remedy",
    n("290").code === "gateway_request_rejected" &&
      /Address Verification/.test(n("290").message ?? ""),
  );
  ok("decline: an unmapped code passes through", n("9999").code === "9999");
  ok("decline: no code → charge_failed", normalizeAuthorizenetDecline({}).code === "charge_failed");
  ok(
    "decline: registered in DECLINE_SETS",
    DECLINE_SETS.authorizenet.rules.length > 0 &&
      DECLINE_SETS.authorizenet.table["2"] === "card_declined",
  );
  ok(
    "decline: our-side rules are hidden from the payer",
    declineHiddenFromPayer("gateway_request_rejected"),
  );
  ok(
    "decline: every rule id is authorizenet.code.<slug>",
    DECLINE_SETS.authorizenet.rules.every((r) => /^authorizenet\.code\.[a-z0-9_]+$/.test(r.id)),
  );
}

// ── 5 · transaction responses (measured shapes) ────────────────────────────
const approved = {
  transactionResponse: {
    responseCode: "1",
    authCode: "A1",
    transId: "120000000001",
    accountNumber: "XXXX1111",
    accountType: "Visa",
    messages: [{ code: "1", description: "This transaction has been approved." }],
    networkTransId: "N1",
  },
  refId: "tm0",
  messages: OK,
};
{
  const a = readTransactionResponse(approved);
  ok(
    "response: 1 on a card → succeeded with transId",
    "result" in a &&
      a.result.status === "succeeded" &&
      a.result.providerChargeId === "120000000001",
  );
  const e = readTransactionResponse({
    ...approved,
    transactionResponse: { ...approved.transactionResponse, accountType: "eCheck" },
  });
  ok("response: 1 on an eCheck → pending", "result" in e && e.result.status === "pending");
  ok(
    "response: methodUsed card for a card brand, us_bank_account for an eCheck",
    "result" in a &&
      a.result.methodUsed === "card" &&
      "result" in e &&
      e.result.methodUsed === "us_bank_account",
  );
  ok(
    "read-back: methodUsed from the payment block",
    chargeResultFromTransaction({
      transId: "120000000003",
      transactionStatus: "settledSuccessfully",
      payment: { bankAccount: { accountNumber: "XXXX6789" } },
    } as Parameters<typeof chargeResultFromTransaction>[0]).methodUsed === "us_bank_account",
  );
  const held = readTransactionResponse({
    ...approved,
    transactionResponse: { ...approved.transactionResponse, responseCode: "4" },
  });
  ok("response: 4 (fraud hold) → pending", "result" in held && held.result.status === "pending");
  const declined = readTransactionResponse({
    transactionResponse: {
      responseCode: "2",
      transId: "120000000002",
      accountType: "MasterCard",
      errors: [{ errorCode: "2", errorText: "This transaction has been declined." }],
    },
    messages: OK,
  });
  ok(
    "response: 2 → failed card_declined with providerCode",
    "result" in declined &&
      declined.result.status === "failed" &&
      declined.result.failure?.code === "card_declined" &&
      declined.result.failure.providerCode === "2",
  );
  const dup = readTransactionResponse({
    transactionResponse: {
      responseCode: "3",
      transId: "120000000001",
      errors: [{ errorCode: "11", errorText: "A duplicate transaction has been submitted." }],
    },
    messages: { resultCode: "Error", message: [{ code: "E00027" }] },
  });
  ok(
    "response: 3/11 names the original transaction",
    "duplicateOf" in dup && dup.duplicateOf === "120000000001",
  );
  const cur = readTransactionResponse({
    transactionResponse: {
      responseCode: "3",
      transId: "0",
      errors: [{ errorCode: "39", errorText: "The supplied currency code is either invalid…" }],
    },
    messages: { resultCode: "Error" },
  });
  ok(
    "response: 3/39 → failed gateway_request_rejected, no id",
    "result" in cur &&
      cur.result.failure?.code === "gateway_request_rejected" &&
      cur.result.providerChargeId === "",
  );
  const noTx = readTransactionResponse({
    transactionResponse: {},
    messages: {
      resultCode: "Error",
      message: [
        { code: "E00040", text: "Customer Profile ID or Customer Payment Profile ID not found." },
      ],
    },
  });
  ok(
    "response: no transaction → an API error to classify",
    "apiError" in noTx && noTx.apiError.code === "E00040",
  );

  const tx = (status: string, extra: Partial<AnetTransaction> = {}): AnetTransaction => ({
    transId: "t1",
    transactionStatus: status,
    responseCode: 1,
    responseReasonCode: 1,
    ...extra,
  });
  ok(
    "details: capturedPendingSettlement (card) → succeeded",
    chargeResultFromTransaction(
      tx("capturedPendingSettlement", { payment: { creditCard: { cardNumber: "XXXX1111" } } }),
    ).status === "succeeded",
  );
  ok(
    "details: capturedPendingSettlement (bank) → pending",
    chargeResultFromTransaction(
      tx("capturedPendingSettlement", { payment: { bankAccount: { accountNumber: "XXXX7891" } } }),
    ).status === "pending",
  );
  ok(
    "details: settledSuccessfully (bank) → succeeded",
    chargeResultFromTransaction(tx("settledSuccessfully", { payment: { bankAccount: {} } }))
      .status === "succeeded",
  );
  const d = chargeResultFromTransaction(
    tx("declined", {
      responseCode: 2,
      responseReasonCode: 2,
      responseReasonDescription: "Card declined by issuer",
    }),
  );
  ok(
    "details: declined → failed card_declined",
    d.status === "failed" && d.failure?.code === "card_declined",
  );
  const voided = chargeResultFromTransaction(
    tx("voided", { payment: { bankAccount: { accountNumber: "XXXX7891" } } }),
  );
  ok(
    "details: voided → failed debit_cancelled, not retriable (it read as a retriable approval)",
    voided.status === "failed" &&
      voided.failure?.code === AUTHORIZENET_VOIDED_CODE &&
      voided.failure.retriable === false,
    JSON.stringify(voided.failure),
  );
  ok(
    "text: HTML entities in gateway text are decoded",
    unescapeAuthorizenetText("The ABA code and&#47;or account &amp; &#x2F;x &lt;y&gt;") ===
      "The ABA code and/or account & /x <y>" &&
      new AuthorizenetApiError("op", "E1", "and&#47;or").text === "and/or" &&
      authorizenetDeclineSignal({ text: "and&#47;or" }).message === "and/or",
  );
  ok(
    "details: FDSPendingReview → pending",
    chargeResultFromTransaction(tx("FDSPendingReview")).status === "pending",
  );
  ok(
    "details: authorizedPendingCapture → pending on a charge, succeeded on an authorization",
    chargeResultFromTransaction(tx("authorizedPendingCapture")).status === "pending" &&
      chargeResultFromTransaction(tx("authorizedPendingCapture"), { authorization: true })
        .status === "succeeded",
  );
}

// ── 5b · unknown outcomes, couldNotVoid, the ownership tag ─────────────────
{
  const err = (code: string, transId = "0") => ({
    transactionResponse: {
      responseCode: "3",
      transId,
      errors: [{ errorCode: code, errorText: "x" }],
    },
    messages: { resultCode: "Error", message: [{ code: "E00027", text: "x" }] },
  });
  for (const code of ["19", "20", "120", "121", "122"]) {
    const out = readTransactionResponse(err(code, "120000000009"));
    ok(
      `responses: reason ${code} is an unknown outcome, not a decline`,
      "outcomeUnknown" in out && out.outcomeUnknown.transId === "120000000009",
    );
  }
  ok("responses: reason 2 stays a decline", "result" in readTransactionResponse(err("2")));
  const t = (transactionStatus: string): AnetTransaction => ({
    transId: "t1",
    transactionStatus,
    payment: { creditCard: { cardNumber: "XXXX1111" } },
  });
  ok(
    "details: couldNotVoid → succeeded (the void failed, the money is still captured)",
    chargeResultFromTransaction(t("couldNotVoid")).status === "succeeded",
  );
  const long = "d".repeat(400);
  const d = authorizenetDescription(long, "inv_0123456789abcdefghijklmn")!;
  ok(
    "tag: the ref ends the description and the whole stays within 255",
    d.length <= 255 && d.endsWith(" [ref:inv_0123456789abcdefghijklmn]"),
    String(d.length),
  );
  ok("tag: no ref, the description alone", authorizenetDescription("Plan", undefined) === "Plan");
  ok(
    "tag: no description, the tag alone",
    authorizenetDescription(undefined, "rf_1") === "[ref:rf_1]",
  );
  ok(
    "tag: a ref with other characters is not stamped",
    authorizenetDescription("Plan", "a b]") === "Plan",
  );
}

// ── 6 · event mapping ──────────────────────────────────────────────────────
{
  const n = (
    eventType: string,
    payload: AuthorizenetNotification["payload"] = {
      id: "t9",
      entityName: "transaction",
      responseCode: 1,
    },
  ): AuthorizenetNotification => ({
    notificationId: "11111111-2222-4333-8444-555555555555",
    eventType: `net.authorize.${eventType}`,
    eventDate: "2026-10-24T16:49:44.0080095Z",
    webhookId: "w1",
    payload,
  });
  const card = (extra: Partial<AnetTransaction> = {}): AnetTransaction => ({
    transId: "t9",
    submitTimeUTC: "2026-10-24T16:49:44.363Z",
    transactionType: "authCaptureTransaction",
    transactionStatus: "capturedPendingSettlement",
    responseCode: 1,
    responseReasonCode: 1,
    authAmount: 12.34,
    settleAmount: 12.34,
    order: { invoiceNumber: authorizenetReference("k") },
    payment: { creditCard: { cardNumber: "XXXX1111", cardType: "Visa" } },
    ...extra,
  });
  const map = (
    ev: AuthorizenetNotification,
    tx: AnetTransaction | null,
    profile?: Parameters<typeof normalizeAuthorizenetNotification>[4],
  ) => normalizeAuthorizenetNotification(ev, "anet_x", ev, tx, profile);

  let out = map(n("payment.authcapture.created"), card());
  ok(
    "event: authcapture (card, captured) → charge.succeeded, ours",
    out[0]?.type === "charge.succeeded" &&
      out[0].providerChargeId === "t9" &&
      out[0].ownership === "ours",
  );
  ok(
    "event: occurredAt from eventDate, created from submitTimeUTC",
    out[0]?.occurredAt.toISOString().startsWith("2026-10-24T16:49:44") === true &&
      out[0]?.providerObjectCreatedAt?.toISOString() === "2026-10-24T16:49:44.363Z",
  );
  out = map(
    n("payment.authcapture.created", { id: "t9", responseCode: 2 }),
    card({
      transactionStatus: "declined",
      responseCode: 2,
      responseReasonCode: 2,
      responseReasonDescription: "Declined",
    }),
  );
  ok(
    "event: authcapture declined → charge.failed with the normalized code",
    out[0]?.type === "charge.failed" &&
      out[0].failureCode === "card_declined" &&
      out[0].providerFailureCode === "2" &&
      out[0].failureRetriable === true,
  );
  out = map(
    n("payment.authcapture.created"),
    card({ payment: { bankAccount: { accountNumber: "XXXX7891", echeckType: "WEB" } } }),
  );
  ok("event: authcapture on an eCheck → charge.pending", out[0]?.type === "charge.pending");
  out = map(n("payment.authcapture.created"), card({ order: { invoiceNumber: "INV-1001" } }));
  ok("event: a transaction without our reference is foreign", out[0]?.ownership === "foreign");
  out = map(n("payment.authcapture.created"), null);
  ok(
    "event: unread transaction → payload responseCode, ownership unknown",
    out[0]?.type === "charge.succeeded" && out[0].ownership === "unknown",
  );
  out = map(
    n("payment.authorization.created"),
    card({ transactionType: "authOnlyTransaction", transactionStatus: "authorizedPendingCapture" }),
  );
  ok(
    "event: authorization → intent.authorized",
    out[0]?.type === "intent.authorized" && out[0].providerIntentId === "t9",
  );
  out = map(n("payment.authorization.created", { id: "t9", responseCode: 2 }), null);
  ok("event: declined authorization → intent.failed", out[0]?.type === "intent.failed");
  out = map(
    n("payment.priorAuthCapture.created"),
    card({ transactionType: "priorAuthCaptureTransaction" }),
  );
  ok(
    "event: priorAuthCapture → charge.succeeded on the same id",
    out[0]?.type === "charge.succeeded" && out[0].providerChargeId === "t9",
  );
  out = map(
    n("payment.priorAuthCapture.created"),
    card({ transactionType: "priorAuthCaptureTransaction", authAmount: 20, settleAmount: 12.34 }),
  );
  ok(
    "capturedAmountMinor: a capture of less than the hold reports what it took (settleAmount)",
    out[0]?.capturedAmountMinor === 1234n,
  );
  out = map(n("payment.authcapture.created"), card());
  ok(
    "capturedAmountMinor: authcapture carries the read amount",
    out[0]?.capturedAmountMinor === 1234n,
  );
  out = map(n("payment.authcapture.created", { id: "t9", responseCode: 1, authAmount: 7.5 }), null);
  ok(
    "capturedAmountMinor: unread authcapture falls back to the payload's authAmount",
    out[0]?.type === "charge.succeeded" && out[0].capturedAmountMinor === 750n,
  );
  out = map(
    n("payment.priorAuthCapture.created", { id: "t9", responseCode: 1, authAmount: 7.5 }),
    null,
  );
  ok(
    "capturedAmountMinor: unset on an unread prior-auth capture (it may take less than authAmount)",
    out[0]?.type === "charge.succeeded" && out[0].capturedAmountMinor === undefined,
  );
  out = map(
    n("payment.refund.created", { id: "r1", responseCode: 1, authAmount: 5 }),
    card({
      transId: "r1",
      refTransId: "t9",
      transactionType: "refundTransaction",
      transactionStatus: "refundPendingSettlement",
      settleAmount: 5,
    }),
  );
  ok(
    "event: refund → charge.refunded against the original, one record at its own amount",
    out[0]?.type === "charge.refunded" &&
      out[0].providerChargeId === "t9" &&
      out[0].amountRefundedMinor === undefined &&
      out[0].refunds?.length === 1 &&
      out[0].refunds[0]!.providerRefundId === "r1" &&
      out[0].refunds[0]!.amountMinor === 500n &&
      out[0].refunds[0]!.status === "succeeded" &&
      out[0].refunds[0]!.ownershipRef === undefined,
  );
  out = map(
    n("payment.refund.created", { id: "r2", responseCode: 1 }),
    card({
      transId: "r2",
      refTransId: "t9",
      transactionType: "refundTransaction",
      transactionStatus: "refundPendingSettlement",
      settleAmount: 3,
      order: { invoiceNumber: authorizenetReference("rf"), description: "[ref:rf_0001]" },
    }),
  );
  ok(
    "event: our refund's record carries the ref read back off it",
    out[0]?.refunds?.[0]?.ownershipRef === "rf_0001" && out[0].refunds[0].amountMinor === 300n,
  );
  out = map(
    n("payment.void.created"),
    card({
      transactionStatus: "voided",
      order: { invoiceNumber: authorizenetReference("k"), description: "[ref:inv_0001]" },
    }),
  );
  ok(
    "event: void of a capture → one full record on the charge id, without the charge's tag",
    out.length === 1 &&
      out[0]?.type === "charge.refunded" &&
      out[0].providerRefundId === "t9" &&
      out[0].refunds?.[0]?.amountMinor === 1234n &&
      out[0].refunds[0].ownershipRef === undefined,
  );
  out = map(
    n("payment.void.created"),
    card({ transactionType: "authOnlyTransaction", transactionStatus: "voided" }),
  );
  ok(
    "event: void of an authorization → intent.voided, and charge.refunded for a captured one",
    out.map((e) => e.type).join() === "intent.voided,charge.refunded" &&
      out[0]?.providerIntentId === "t9" &&
      out[1]?.refunds?.[0]?.amountMinor === 1234n,
  );
  out = map(
    n("payment.void.created"),
    card({
      transactionStatus: "voided",
      payment: { bankAccount: { accountNumber: "XXXX7891", accountType: "checking" } },
    }),
  );
  ok(
    "event: void of a pending eCheck → charge.failed debit_cancelled, no refund record",
    out.length === 1 &&
      out[0]?.type === "charge.failed" &&
      out[0].providerChargeId === "t9" &&
      out[0].failureCode === AUTHORIZENET_VOIDED_CODE &&
      out[0].failureRetriable === false &&
      out[0].refunds === undefined,
    JSON.stringify(out.map((e) => [e.type, e.failureCode])),
  );
  out = map(
    n("payment.void.created"),
    card({ transactionType: "refundTransaction", transactionStatus: "voided" }),
  );
  ok(
    "event: void of a refund → refund.failed",
    out[0]?.type === "refund.failed" && out[0].providerRefundId === "t9",
  );
  out = map(
    n("payment.fraud.held", { id: "t9", responseCode: 4 }),
    card({ transactionStatus: "FDSPendingReview" }),
  );
  ok("event: fraud.held → review.opened", out.length === 1 && out[0]?.type === "review.opened");
  out = map(n("payment.fraud.approved"), card());
  ok(
    "event: fraud.approved → review.closed + charge.succeeded",
    out.map((e) => e.type).join() === "review.closed,charge.succeeded" &&
      out[1]?.capturedAmountMinor === 1234n,
  );
  out = map(
    n("payment.fraud.approved"),
    card({ transactionStatus: "declined", responseCode: 2, responseReasonCode: 2 }),
  );
  ok(
    "event: fraud.approved on a charge the issuer then declined → charge.failed",
    out.map((e) => e.type).join() === "review.closed,charge.failed",
  );
  out = map(n("payment.fraud.approved"), card({ transactionStatus: "FDSPendingReview" }));
  ok(
    "event: fraud.approved while the read still shows the hold → charge.pending",
    out.map((e) => e.type).join() === "review.closed,charge.pending",
  );
  out = map(n("payment.fraud.approved"), null);
  ok(
    "event: fraud.approved with no read → review.closed only",
    out.map((e) => e.type).join() === "review.closed",
  );
  out = map(
    n("payment.fraud.approved"),
    card({ transactionType: "authOnlyTransaction", transactionStatus: "declined" }),
  );
  ok(
    "event: fraud.approved on an authorization then declined → intent.failed",
    out.map((e) => e.type).join() === "review.closed,intent.failed",
  );
  out = map(n("payment.authcapture.created"), card({ transactionStatus: "settlementError" }));
  ok(
    "event: a settlementError read → charge.failed with lateReversal",
    out[0]?.type === "charge.failed" && out[0].lateReversal === true,
  );
  out = map(n("payment.authcapture.created"), card({ transactionStatus: "declined" }));
  ok("event: an ordinary decline is not a late reversal", out[0]?.lateReversal === undefined);
  out = map(
    n("payment.authcapture.created"),
    card({
      order: { invoiceNumber: authorizenetReference("k"), description: "Plan [ref:inv_0001]" },
    }),
  );
  ok("event: our ref is read back off the description", out[0]?.ownershipRef === "inv_0001");
  out = map(
    n("payment.authcapture.created"),
    card({ order: { invoiceNumber: "INV-1001", description: "Plan [ref:inv_0001]" } }),
  );
  ok(
    "event: a tag on a transaction without our reference is not read",
    out[0]?.ownership === "foreign" && out[0].ownershipRef === undefined,
  );
  out = map(
    n("payment.fraud.approved"),
    card({ transactionType: "authOnlyTransaction", transactionStatus: "authorizedPendingCapture" }),
  );
  ok(
    "event: fraud.approved on an authorization → intent.authorized",
    out.map((e) => e.type).join() === "review.closed,intent.authorized",
  );
  out = map(
    n("payment.fraud.declined", { id: "t9", responseCode: 2 }),
    card({
      transactionStatus: "declined",
      responseCode: 2,
      responseReasonCode: 254,
      responseReasonDescription: "Declined after manual review",
    }),
  );
  ok(
    "event: fraud.declined → review.closed + charge.failed",
    out.map((e) => e.type).join() === "review.closed,charge.failed" &&
      out[1]?.failureCode === "card_declined",
  );
  out = map(
    n("customer.paymentProfile.deleted", {
      id: "pp1",
      entityName: "customerPaymentProfile",
      customerProfileId: 7,
    }),
    null,
  );
  ok(
    "event: paymentProfile.deleted → payment_method.detached",
    out[0]?.type === "payment_method.detached" && out[0].providerPaymentMethodId === "pp1",
  );
  out = map(n("customer.paymentProfile.updated", { id: "pp1", customerProfileId: 7 }), null, {
    payment: {
      creditCard: { cardNumber: "XXXX4242", expirationDate: "2031-04", cardType: "Visa" },
    },
  });
  ok(
    "event: paymentProfile.updated → payment_method.updated with card fields",
    out[0]?.type === "payment_method.updated" &&
      out[0].card?.last4 === "4242" &&
      out[0].card.expYear === 2031 &&
      out[0].card.expMonth === 4 &&
      out[0].card.brand === "visa",
  );
  out = map(n("customer.created", { id: "c1", entityName: "customerProfile" }), null);
  ok("event: customer.created → unknown", out[0]?.type === "unknown");
  out = map(n("customer.subscription.created", { id: "s1", entityName: "subscription" }), null);
  ok("event: ARB subscription events → unknown", out[0]?.type === "unknown");
  ok(
    "event: we register only payment and payment-profile events",
    AUTHORIZENET_WEBHOOK_EVENTS.every((e) =>
      /^net\.authorize\.(payment\.|customer\.paymentProfile\.)/.test(e),
    ),
  );
}

// ── 7 · capabilities, catalog, factory ─────────────────────────────────────
{
  const creds = { api_login_id: "login", transaction_key: "key", signature_key: SIG_KEY };
  const a = GATEWAY_FACTORIES.authorizenet.build(creds, { businessId: "biz_x", livemode: false });
  const c = a.capabilities;
  ok("capabilities: cards and eCheck", c.methods.join() === "card,us_bank_account");
  ok(
    "capabilities: refunds, partial refunds, intents (both), void",
    c.refunds &&
      c.partialRefunds &&
      c.intents === true &&
      c.intentPurposes?.join() === "payment,setup" &&
      c.intentVoid === true,
  );
  ok(
    "capabilities: no mandate model",
    c.mandates === false && c.perDebitMandateReference === false,
  );
  ok(
    "capabilities: a settlement report every 6 h over at most 48 h, and a poll to read it",
    c.settlementReport?.intervalMinutes === 360 &&
      c.settlementReport.maxWindowHours === 48 &&
      typeof a.pollSettlements === "function",
  );
  const def = GATEWAYS.authorizenet;
  ok("catalog: display name Authorize.net", def.displayName === "Authorize.net");
  ok(
    "catalog: advertised methods = capabilities",
    [...def.advertisedMethods].join() === c.methods.join(),
  );
  ok(
    "catalog: eCheck is saved then charged, and the authorization is ours to take",
    def.setupOnlyMethods?.join() === "us_bank_account" &&
      def.achAuthorization === "ours" &&
      def.methodOptions.some((m) => m.value === "us_bank_account") &&
      def.settlement.lateCaptureAfterFailure === true,
  );
  ok(
    "catalog: three credentials",
    def.credentialFields.map((f) => f.key).join() === "api_login_id,transaction_key,signature_key",
  );
  ok(
    "catalog: webhooks signed by a credential, account id in the path",
    def.webhook.secret === "credential" && def.webhook.accountIdInPath === true,
  );
  ok(
    "catalog: no competitor and no 'verify' in operator copy",
    !/verify/i.test(
      JSON.stringify([
        def.webhook.instructions("u", "url_only"),
        def.webhook.instructions("u", "self_provisioned"),
        def.webhook.fallbackInstructions,
        def.credentialFields,
      ]),
    ),
  );
  ok(
    "factory: a signature key that is not 128 hex characters is refused",
    (await throws(() =>
      GATEWAY_FACTORIES.authorizenet.build(
        { ...creds, signature_key: "short" },
        { businessId: "b", livemode: false },
      ),
    )) instanceof GatewayResolveError,
  );
  ok(
    "factory: a missing credential is refused",
    (await throws(() =>
      GATEWAY_FACTORIES.authorizenet.build(
        { api_login_id: "x" },
        { businessId: "b", livemode: false },
      ),
    )) instanceof GatewayResolveError,
  );
  const url = buildNotificationUrl({
    gatewayKey: "authorizenet",
    gatewayAccountPublicId: "gwa_XXXXXXXXXXXX01",
  });
  ok(
    "notification URL: account id in the path, no query string",
    url.endsWith("/v1/gateway_webhooks/authorizenet/gwa_XXXXXXXXXXXX01") && !url.includes("?"),
    url,
  );
  const other = buildNotificationUrl({
    gatewayKey: "braintree",
    gatewayAccountPublicId: "gwa_XXXXXXXXXXXX01",
  });
  ok(
    "notification URL: other gateways keep ?id=",
    other.includes("/v1/gateway_webhooks/braintree?id=gwa_XXXXXXXXXXXX01"),
  );
}

// ── 8 · the adapter against a stubbed API ──────────────────────────────────
type Answer = (root: string, body: Record<string, unknown>, url: string, method: string) => unknown;
const realFetch = globalThis.fetch;
let answer: Answer = () => ({ messages: OK });
const sent: Array<{
  root: string;
  body: Record<string, unknown>;
  url: string;
  method: string;
  raw: string;
  auth?: string;
}> = [];
let failTransport: ((root: string) => boolean) | null = null;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const raw = String(init?.body ?? "");
  const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : {};
  const root = Object.keys(parsed)[0] ?? "";
  const method = init?.method ?? "GET";
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
  sent.push({
    root,
    body: parsed[root] ?? {},
    url: String(url),
    method,
    raw,
    ...(auth ? { auth } : {}),
  });
  if (failTransport?.(root)) throw new TypeError("fetch failed");
  let out: unknown;
  try {
    out = answer(root, parsed[root] ?? {}, String(url), method);
  } catch (e) {
    // Stubs written for one money call: the pre-send reference lookup finds nothing.
    if (
      root !== "getTransactionListForCustomerRequest" &&
      root !== "getUnsettledTransactionListRequest"
    )
      throw e;
    out = { transactions: [], messages: OK };
  }
  const status = (out as { __status?: number })?.__status ?? 200;
  return new Response(BOM + JSON.stringify(out), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}) as typeof fetch;

const adapter = new AuthorizenetProvider({
  apiLoginId: "login",
  transactionKey: "key",
  signatureKey: SIG_KEY,
  livemode: false,
  apiHost: "https://anet.invalid",
});
const customer = { providerKey: "authorizenet" as const, providerCustomerId: "900000001" };
const pm = {
  providerKey: "authorizenet" as const,
  providerPaymentMethodId: "900000002",
  providerCustomerId: "900000001",
  display: { type: "card" as const },
};
const details = (t: Partial<AnetTransaction>) => ({
  transaction: {
    transId: "120000000001",
    transactionType: "authCaptureTransaction",
    transactionStatus: "capturedPendingSettlement",
    responseCode: 1,
    responseReasonCode: 1,
    authAmount: 12.34,
    settleAmount: 12.34,
    payment: { creditCard: { cardNumber: "XXXX1111", expirationDate: "XXXX", cardType: "Visa" } },
    profile: { customerProfileId: "900000001" },
    ...t,
  },
  messages: OK,
});

try {
  // charge: body shape
  answer = () => approved;
  sent.length = 0;
  const res = await adapter.charge({
    amountMinor: 1234n,
    currency: "usd",
    customer,
    paymentMethod: pm,
    idempotencyKey: "inv_1_attempt_1",
    initiator: { by: "merchant", recurring: true },
    description: "Invoice INV-1",
  });
  const req = sent.find((s) => s.root === "createTransactionRequest")!;
  const tr = req.body.transactionRequest as Record<string, unknown>;
  ok(
    "charge: approved card → succeeded",
    res.status === "succeeded" && res.providerChargeId === "120000000001",
  );
  ok(
    "charge: posts createTransactionRequest to the sandbox path",
    req.root === "createTransactionRequest" &&
      req.url === "https://anet.invalid/xml/v1/request.api",
  );
  ok(
    "charge: merchantAuthentication comes first",
    Object.keys(req.body)[0] === "merchantAuthentication",
  );
  ok(
    "charge: elements in XSD order",
    Object.keys(tr).join() ===
      "transactionType,amount,currencyCode,profile,order,transactionSettings",
    Object.keys(tr).join(),
  );
  ok(
    "charge: amount as a decimal string, currency upper-case",
    tr.amount === "12.34" && tr.currencyCode === "USD",
  );
  const ref = authorizenetReference("inv_1_attempt_1");
  ok(
    "charge: refId = invoiceNumber = our reference",
    req.body.refId === ref && (tr.order as { invoiceNumber: string }).invoiceNumber === ref,
  );
  const settings = (
    tr.transactionSettings as { setting: Array<{ settingName: string; settingValue: string }> }
  ).setting;
  ok(
    "charge: duplicateWindow 28800 and recurringBilling",
    settings.some((s) => s.settingName === "duplicateWindow" && s.settingValue === "28800") &&
      settings.some((s) => s.settingName === "recurringBilling" && s.settingValue === "true"),
  );
  ok(
    "charge: profile ids from the payment method",
    JSON.stringify(tr.profile) ===
      JSON.stringify({
        customerProfileId: "900000001",
        paymentProfile: { paymentProfileId: "900000002" },
      }),
  );
  sent.length = 0;
  await adapter.charge({
    amountMinor: 100n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "k2",
  });
  const tr2 = sent.find((s) => s.root === "createTransactionRequest")!.body
    .transactionRequest as Record<string, unknown>;
  ok(
    "charge: no initiator → processingOptions.isSubsequentAuth, last element",
    JSON.stringify(tr2.processingOptions) === '{"isSubsequentAuth":"true"}' &&
      Object.keys(tr2).at(-1) === "processingOptions",
  );

  // duplicate → read the original back
  answer = (root) =>
    root === "createTransactionRequest"
      ? {
          transactionResponse: {
            responseCode: "3",
            transId: "120000000001",
            errors: [{ errorCode: "11", errorText: "A duplicate transaction has been submitted." }],
          },
          messages: { resultCode: "Error", message: [{ code: "E00027" }] },
        }
      : details({});
  const dup = await adapter.charge({
    amountMinor: 1234n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "inv_1_attempt_1",
  });
  ok(
    "idempotency: a retry inside the window returns the ORIGINAL outcome",
    dup.status === "succeeded" && dup.providerChargeId === "120000000001",
  );

  // a key re-sent after the duplicate window: found before anything is sent
  const hit = {
    transactions: [
      { transId: "120000000009", invoiceNumber: "tm000000000000000000" },
      { transId: "120000000001", invoiceNumber: ref },
    ],
    messages: OK,
  };
  answer = (root) =>
    root === "getUnsettledTransactionListRequest"
      ? hit
      : root === "getTransactionListForCustomerRequest"
        ? { transactions: [], messages: OK }
        : root === "createTransactionRequest"
          ? approved
          : details({});
  sent.length = 0;
  const late = await adapter.charge({
    amountMinor: 1234n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "inv_1_attempt_1",
  });
  ok(
    "idempotency: a re-send after the window returns the earlier charge and sends nothing",
    late.status === "succeeded" &&
      late.providerChargeId === "120000000001" &&
      sent[0]?.root === "getUnsettledTransactionListRequest" &&
      !sent.some((s) => s.root === "createTransactionRequest"),
    sent.map((s) => s.root).join(),
  );
  // settled since: found on the customer's settled list instead
  answer = (root) =>
    root === "getUnsettledTransactionListRequest"
      ? { transactions: [], messages: OK }
      : root === "getTransactionListForCustomerRequest"
        ? hit
        : root === "createTransactionRequest"
          ? approved
          : details({});
  sent.length = 0;
  const settledLate = await adapter.charge({
    amountMinor: 1234n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "inv_1_attempt_1",
  });
  ok(
    "idempotency: a re-send after settlement is found on the settled list and sends nothing",
    settledLate.providerChargeId === "120000000001" &&
      !sent.some((s) => s.root === "createTransactionRequest"),
    sent.map((s) => s.root).join(),
  );
  // the lookup refused (Transaction Details API off): the charge goes on under the window
  answer = (root) =>
    root === "getUnsettledTransactionListRequest" || root === "getTransactionListForCustomerRequest"
      ? {
          messages: {
            resultCode: "Error",
            message: [{ code: "E00011", text: "Access denied." }],
          },
        }
      : approved;
  sent.length = 0;
  const lookupRefused = await adapter.charge({
    amountMinor: 1234n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "k-refused-lookup",
  });
  ok(
    "idempotency: a refused lookup still sends the charge (duplicate window applies)",
    lookupRefused.status === "succeeded" && sent.some((s) => s.root === "createTransactionRequest"),
  );
  // the lookup unanswered: nothing is sent, and the error is not indeterminate
  failTransport = (root) => root === "getUnsettledTransactionListRequest";
  sent.length = 0;
  const unread = await throws(() =>
    adapter.charge({
      amountMinor: 1234n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "k-unread-lookup",
    }),
  );
  ok(
    "idempotency: an unanswered lookup sends nothing and throws a plain error",
    unread instanceof Error &&
      !(unread instanceof ProviderIndeterminateError) &&
      /did not send it/.test(unread.message) &&
      !sent.some((s) => s.root === "createTransactionRequest"),
  );

  // lost answer → look up by reference (the pre-send lookup found nothing)
  failTransport = (root) => root === "createTransactionRequest";
  let lookups = 0;
  answer = (root) =>
    root === "getUnsettledTransactionListRequest"
      ? lookups++ === 0
        ? { transactions: [], messages: OK }
        : hit
      : root === "getTransactionListForCustomerRequest"
        ? { transactions: [], messages: OK }
        : details({});
  const found = await adapter.charge({
    amountMinor: 1234n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "inv_1_attempt_1",
  });
  ok(
    "idempotency: a lost answer is found by invoice number",
    found.status === "succeeded" && found.providerChargeId === "120000000001",
  );
  answer = (root) =>
    root === "getUnsettledTransactionListRequest" || root === "getTransactionListForCustomerRequest"
      ? { transactions: [], messages: OK }
      : details({});
  const lost = await throws(() =>
    adapter.charge({
      amountMinor: 1234n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "inv_1_attempt_1",
    }),
  );
  ok(
    "idempotency: nothing found → ProviderIndeterminateError",
    lost instanceof ProviderIndeterminateError,
  );
  failTransport = null;
  answer = () => ({ __status: 503 });
  ok(
    "transport: HTTP 503 → ProviderIndeterminateError",
    (await throws(() => adapter.fetchChargeStatus({ providerChargeId: "1" }))) instanceof
      ProviderIndeterminateError,
  );

  answer = () => ({
    transactionResponse: { SupplementalDataQualificationIndicator: 0 },
    messages: {
      resultCode: "Error",
      message: [
        { code: "E00040", text: "Customer Profile ID or Customer Payment Profile ID not found." },
      ],
    },
  });
  const gone = await adapter.charge({
    amountMinor: 100n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "k3",
  });
  ok(
    "charge: a deleted payment profile → failed payment_method_not_found",
    gone.status === "failed" &&
      gone.failure?.code === "payment_method_not_found" &&
      !gone.failure.retriable,
  );
  answer = () => ({
    messages: {
      resultCode: "Error",
      message: [
        {
          code: "E00007",
          text: "User authentication failed due to invalid authentication values.",
        },
      ],
    },
  });
  ok(
    "charge: bad API keys throw",
    (await throws(() =>
      adapter.charge({
        amountMinor: 100n,
        currency: "USD",
        customer,
        paymentMethod: pm,
        idempotencyKey: "k4",
      }),
    )) instanceof Error,
  );

  // refunds
  answer = (root, body) => {
    if (root === "getTransactionDetailsRequest") return details({});
    if (root === "getTransactionListForCustomerRequest") return { transactions: [], messages: OK };
    const t = (body.transactionRequest as { transactionType: string }).transactionType;
    return t === "voidTransaction"
      ? {
          transactionResponse: {
            responseCode: "1",
            transId: "120000000001",
            messages: [{ code: "1" }],
          },
          messages: OK,
        }
      : approved;
  };
  sent.length = 0;
  const full = await adapter.refund({
    providerChargeId: "120000000001",
    idempotencyKey: "re1",
    currency: "USD",
  });
  ok(
    "refund: unsettled, full → a void, refund id = charge id",
    full.status === "succeeded" &&
      full.providerRefundId === "120000000001" &&
      sent.some((s) => JSON.stringify(s.body).includes("voidTransaction")),
  );
  ok(
    "refund: unsettled, partial → refused with the remedy",
    (await throws(() =>
      adapter.refund({
        providerChargeId: "120000000001",
        amountMinor: 500n,
        currency: "USD",
        idempotencyKey: "re2",
      }),
    )) instanceof ProviderRefusalError,
  );
  answer = (root, body) =>
    root === "getTransactionDetailsRequest"
      ? details({ transactionStatus: "settledSuccessfully" })
      : (body.transactionRequest as { transactionType: string }).transactionType ===
          "refundTransaction"
        ? {
            transactionResponse: {
              responseCode: "1",
              transId: "120000000077",
              messages: [{ code: "1" }],
            },
            messages: OK,
          }
        : approved;
  sent.length = 0;
  const part = await adapter.refund({
    providerChargeId: "120000000001",
    amountMinor: 500n,
    currency: "USD",
    idempotencyKey: "re3",
  });
  const rtr = sent.find((s) => s.root === "createTransactionRequest")!.body
    .transactionRequest as Record<string, unknown>;
  ok(
    "refund: settled card, partial → refundTransaction",
    part.status === "succeeded" && part.providerRefundId === "120000000077",
  );
  ok(
    "refund: last four digits and XXXX, in XSD order",
    JSON.stringify(rtr.payment) ===
      '{"creditCard":{"cardNumber":"1111","expirationDate":"XXXX"}}' &&
      Object.keys(rtr).join() ===
        "transactionType,amount,payment,refTransId,order,transactionSettings",
    Object.keys(rtr).join(),
  );
  ok("refund: amount 5.00", rtr.amount === "5.00");
  const bankTx = (accountType: string, submitTimeUTC = new Date().toISOString()) =>
    details({
      transactionStatus: "settledSuccessfully",
      submitTimeUTC,
      payment: {
        bankAccount: {
          accountType,
          routingNumber: "XXXX0028",
          accountNumber: "XXXX7891",
          nameOnAccount: "Conformance Payer",
          echeckType: "WEB",
        },
      },
    });
  const echeckRefund = (accountType: string) => (root: string) =>
    root === "getTransactionDetailsRequest"
      ? bankTx(accountType)
      : root === "createTransactionRequest"
        ? {
            transactionResponse: {
              responseCode: "1",
              transId: "120000000078",
              accountType: "eCheck",
              messages: [{ code: "1" }],
            },
            messages: OK,
          }
        : { transactions: [], messages: OK };
  answer = echeckRefund("checking");
  sent.length = 0;
  const bankRefund = await adapter.refund({
    providerChargeId: "120000000001",
    amountMinor: 500n,
    currency: "USD",
    idempotencyKey: "re4",
  });
  const brt = sent.find((x) => x.root === "createTransactionRequest")!.body
    .transactionRequest as Record<string, unknown>;
  ok(
    "refund: a settled eCheck is refunded as PPD to the masked account (WEB has no refunds)",
    bankRefund.status === "pending" &&
      bankRefund.providerRefundId === "120000000078" &&
      JSON.stringify(brt.payment) ===
        '{"bankAccount":{"accountType":"checking","routingNumber":"XXXX0028","accountNumber":"XXXX7891","nameOnAccount":"Conformance Payer","echeckType":"PPD"}}' &&
      brt.refTransId === "120000000001",
    JSON.stringify(brt.payment),
  );
  answer = echeckRefund("businessChecking");
  sent.length = 0;
  await adapter.refund({ providerChargeId: "120000000001", idempotencyKey: "re4b" });
  const ccd = sent.find((x) => x.root === "createTransactionRequest")!.body.transactionRequest as {
    payment: { bankAccount: { echeckType: string } };
  };
  ok(
    "refund: a business checking account is refunded as CCD",
    ccd.payment.bankAccount.echeckType === "CCD",
  );
  answer = () => bankTx("checking", new Date(Date.now() - 181 * 86_400_000).toISOString());
  ok(
    "refund: an eCheck settled more than 180 days ago is refused with the remedy",
    /180 days/.test(
      String(
        (
          (await throws(() =>
            adapter.refund({ providerChargeId: "120000000001", idempotencyKey: "re4c" }),
          )) as Error
        ).message,
      ),
    ),
  );
  answer = () => details({ transactionStatus: "declined" });
  ok(
    "refund: a declined payment has nothing to refund",
    (await throws(() =>
      adapter.refund({ providerChargeId: "120000000001", idempotencyKey: "re5" }),
    )) instanceof ProviderRefusalError,
  );
  answer = () =>
    details({
      transId: "120000000077",
      transactionType: "refundTransaction",
      transactionStatus: "refundPendingSettlement",
    });
  ok(
    "refund status: refundPendingSettlement (card) → succeeded",
    (await adapter.fetchRefundStatus({ providerRefundId: "120000000077" })).status === "succeeded",
  );
  answer = () => details({ transactionStatus: "voided" });
  ok(
    "refund status: a voided charge (void-as-refund) → succeeded",
    (await adapter.fetchRefundStatus({ providerRefundId: "120000000001" })).status === "succeeded",
  );

  // cancelPendingCharge: an eCheck is voided before its batch settles.
  ok("cancel pending: the adapter declares it", adapter.capabilities.pendingDebitCancel === true);
  const pendingCheck = {
    transactionStatus: "capturedPendingSettlement",
    payment: { bankAccount: { accountNumber: "XXXX7891", accountType: "checking" } },
  };
  answer = (root) =>
    root === "getTransactionDetailsRequest"
      ? details(pendingCheck)
      : {
          transactionResponse: { responseCode: "1", transId: "120000000001" },
          messages: OK,
        };
  sent.length = 0;
  const cancelled = await adapter.cancelPendingCharge({
    providerChargeId: "120000000001",
    idempotencyKey: "cancel-debit-pay_1",
  });
  const voidReq = sent.find((x) => x.root === "createTransactionRequest")?.body
    .transactionRequest as Record<string, unknown> | undefined;
  ok(
    "cancel pending: an unsettled eCheck is voided → cancelled",
    cancelled.status === "cancelled" &&
      voidReq?.transactionType === "voidTransaction" &&
      voidReq.refTransId === "120000000001",
    JSON.stringify(voidReq),
  );
  answer = () => details({ ...pendingCheck, transactionStatus: "voided" });
  sent.length = 0;
  const again = await adapter.cancelPendingCharge({
    providerChargeId: "120000000001",
    idempotencyKey: "cancel-debit-pay_1",
  });
  ok(
    "cancel pending: a voided debit answers cancelled again, with no second void",
    again.status === "cancelled" && !sent.some((x) => x.root === "createTransactionRequest"),
  );
  answer = () => details({ ...pendingCheck, transactionStatus: "settledSuccessfully" });
  sent.length = 0;
  const settled = await adapter.cancelPendingCharge({
    providerChargeId: "120000000001",
    idempotencyKey: "cancel-debit-pay_1",
  });
  ok(
    "cancel pending: a settled eCheck is final (succeeded), not voided",
    settled.status === "already_final" &&
      settled.charge?.status === "succeeded" &&
      !sent.some((x) => x.root === "createTransactionRequest"),
  );
  answer = () => details({ transactionStatus: "voided" });
  const fetched = await adapter.fetchChargeStatus({ providerChargeId: "120000000001" });
  ok(
    "charge status: a voided transaction → failed debit_cancelled, not retriable",
    fetched.status === "failed" &&
      fetched.failure?.code === AUTHORIZENET_VOIDED_CODE &&
      fetched.failure.retriable === false,
  );

  // customers
  answer = () => ({
    customerPaymentProfileIdList: [],
    messages: {
      resultCode: "Error",
      message: [{ code: "E00039", text: "A duplicate record with ID 900000001 already exists." }],
    },
  });
  const cu = await adapter.ensureCustomer({
    customerRef: "cus_XXXXXXXXXXXXXXXXXXXXXXXX01",
    email: "a@example.com",
    name: "Ada",
  });
  ok(
    "customer: a duplicate returns the existing profile id",
    cu.providerCustomerId === "900000001",
  );
  ok(
    "customer: merchantCustomerId fits 20 characters",
    String((sent.at(-1)!.body.profile as { merchantCustomerId: string }).merchantCustomerId)
      .length <= 20,
  );

  // sdk intents
  answer = (root) => {
    if (root === "getMerchantDetailsRequest")
      return { publicClientKey: "PCK_offline", currencies: ["USD"], messages: OK };
    if (root === "createCustomerPaymentProfileRequest")
      return {
        customerProfileId: "900000001",
        customerPaymentProfileId: "900000003",
        validationDirectResponse:
          "1,1,1,(TESTMODE) This transaction has been approved.,000000,P,0,none,x,1.00,CC,auth_only",
        messages: OK,
      };
    if (root === "getCustomerPaymentProfileRequest")
      return {
        paymentProfile: {
          customerProfileId: "900000001",
          customerPaymentProfileId: "900000003",
          payment: {
            creditCard: { cardNumber: "XXXX1111", expirationDate: "2035-12", cardType: "Visa" },
          },
        },
        messages: OK,
      };
    return { messages: OK };
  };
  const intent = await adapter.createIntent({
    purpose: "setup",
    currency: "USD",
    customer,
    idempotencyKey: "pi_1",
    ownershipRef: "pi_X",
  });
  const params = intent.authorization?.sdk?.params ?? {};
  ok(
    "intent: setup → requires_action, sdk mode",
    intent.status === "requires_action" &&
      intent.authorization?.mode === "sdk" &&
      intent.authorization.sdk?.provider === "authorizenet",
  );
  ok(
    "intent: sdk params carry login id, public client key, sandbox",
    params.apiLoginId === "login" &&
      params.clientKey === "PCK_offline" &&
      params.environment === "sandbox",
  );
  ok(
    "intent: no secret in the sdk params",
    !JSON.stringify(params).includes('key"') && !JSON.stringify(params).includes(SIG_KEY),
  );
  ok(
    "intent: the id is a decodable synthetic",
    decodeSyntheticIntent(intent.intentId)?.c === "900000001",
  );
  sent.length = 0;
  const sub = await adapter.submitClientResult({
    intentId: intent.intentId,
    purpose: "setup",
    clientResult: {
      dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT",
      dataValue: "nonce",
      firstName: "Ada",
      lastName: "Lovelace",
    },
    idempotencyKey: "pi_client_1",
  });
  const create = sent.find((s) => s.root === "createCustomerPaymentProfileRequest")!;
  ok(
    "submit: setup saves the nonce, testMode on the sandbox",
    sub.status === "authorized" &&
      sub.gatewayIntentId === "900000001:900000003" &&
      create.body.validationMode === "testMode",
  );
  ok(
    "submit: names go on billTo",
    JSON.stringify((create.body.paymentProfile as { billTo: unknown }).billTo) ===
      '{"firstName":"Ada","lastName":"Lovelace"}',
  );
  const consumed = await adapter.consumeIntent({
    intentId: "900000001:900000003",
    purpose: "setup",
    idempotencyKey: "c1",
  });
  ok(
    "consume: setup returns the saved card",
    consumed.purpose === "setup" &&
      consumed.paymentMethod?.providerPaymentMethodId === "900000003" &&
      consumed.paymentMethod.providerCustomerId === "900000001" &&
      consumed.paymentMethod.display.last4 === "1111" &&
      consumed.paymentMethod.display.expYear === 2035,
  );
  const v = await adapter.voidIntent({ intentId: "900000001:900000003", idempotencyKey: "v1" });
  ok("void: a saved card holds no money", v.voided && v.held === false);
  const bad = await adapter.submitClientResult({
    intentId: intent.intentId,
    purpose: "setup",
    clientResult: {},
    idempotencyKey: "pi_client_2",
  });
  ok(
    "submit: no nonce → failed invalid_client_result",
    bad.status === "failed" && bad.failure?.code === "invalid_client_result",
  );
  answer = (root) =>
    root === "createCustomerPaymentProfileRequest"
      ? {
          validationDirectResponse: "2,1,2,This transaction has been declined.,000000,N,0",
          messages: {
            resultCode: "Error",
            message: [{ code: "E00027", text: "This transaction has been declined." }],
          },
        }
      : { messages: OK };
  const declined = await adapter.submitClientResult({
    intentId: intent.intentId,
    purpose: "setup",
    clientResult: { dataValue: "nonce" },
    idempotencyKey: "pi_client_3",
  });
  ok(
    "submit: a declined check → failed card_declined",
    declined.status === "failed" && declined.failure?.code === "card_declined",
  );

  // eCheck: the buyer chose a bank account, so the form shows bank fields only
  const bankProfile = {
    customerProfileId: "900000001",
    customerPaymentProfileId: "900000004",
    payment: {
      bankAccount: { accountNumber: "XXXX7891", accountType: "checking", echeckType: "WEB" },
    },
  };
  answer = (root) => {
    if (root === "getMerchantDetailsRequest")
      return { publicClientKey: "PCK_offline", messages: OK };
    if (root === "createCustomerPaymentProfileRequest")
      return {
        customerProfileId: "900000001",
        customerPaymentProfileId: "900000004",
        messages: OK,
      };
    if (root === "getCustomerPaymentProfileRequest")
      return { paymentProfile: bankProfile, messages: OK };
    return { messages: OK };
  };
  const bankIntent = await adapter.createIntent({
    purpose: "setup",
    currency: "USD",
    customer,
    idempotencyKey: "pi_bank",
    methodTypes: ["us_bank_account"],
  });
  ok(
    "eCheck: a bank setup asks the hosted form for the bank fields only",
    bankIntent.authorization?.sdk?.params.method === "us_bank_account" &&
      decodeSyntheticIntent(bankIntent.intentId)?.m === "b",
  );
  const cardIntent = await adapter.createIntent({
    purpose: "setup",
    currency: "USD",
    customer,
    idempotencyKey: "pi_card",
  });
  ok(
    "eCheck: a card setup asks for card fields",
    cardIntent.authorization?.sdk?.params.method === "card",
  );
  const savedBank = await adapter.submitClientResult({
    intentId: bankIntent.intentId,
    purpose: "setup",
    clientResult: { dataValue: "bank-nonce" },
    idempotencyKey: "pi_bank_1",
  });
  const bankConsumed = await adapter.consumeIntent({
    intentId: savedBank.gatewayIntentId!,
    purpose: "setup",
    idempotencyKey: "c_bank",
  });
  ok(
    "eCheck: a bank nonce on a bank setup is saved as us_bank_account",
    savedBank.status === "authorized" &&
      bankConsumed.purpose === "setup" &&
      bankConsumed.paymentMethod?.display.type === "us_bank_account" &&
      bankConsumed.paymentMethod.display.last4 === "7891",
  );
  sent.length = 0;
  const bankOnCard = await adapter.submitClientResult({
    intentId: cardIntent.intentId,
    purpose: "setup",
    clientResult: { dataValue: "bank-nonce" },
    idempotencyKey: "pi_card_1",
  });
  ok(
    "eCheck: a bank nonce on a card setup is deleted again and refused (no authorization)",
    bankOnCard.status === "failed" &&
      sent.some((x) => x.root === "deleteCustomerPaymentProfileRequest"),
  );
  ok(
    "eCheck: a bank token through the token path is refused",
    (await throws(() => adapter.vaultPaymentMethod({ customer, token: "bank-nonce" }))) instanceof
      ProviderRefusalError,
  );
  // An eCheck charge carries no card-on-file flags; the profile holds its SEC code.
  answer = (root) =>
    root === "createTransactionRequest"
      ? {
          transactionResponse: {
            responseCode: "1",
            transId: "120000000090",
            accountType: "eCheck",
            messages: [{ code: "1" }],
          },
          messages: OK,
        }
      : { transactions: [], messages: OK };
  sent.length = 0;
  const bankCharge = await adapter.charge({
    amountMinor: 4200n,
    currency: "USD",
    customer,
    paymentMethod: { ...pm, display: { type: "us_bank_account" } },
    idempotencyKey: "inv_bank_1",
    initiator: { by: "merchant", recurring: true },
  });
  const bct = sent.find((x) => x.root === "createTransactionRequest")!.body
    .transactionRequest as Record<string, unknown>;
  ok(
    "eCheck: a charge is pending (collected days later) and paid with us_bank_account",
    bankCharge.status === "pending" && bankCharge.methodUsed === "us_bank_account",
  );
  ok(
    "eCheck: no card-on-file flags on a bank charge",
    !("processingOptions" in bct) &&
      !JSON.stringify(bct.transactionSettings).includes("recurringBilling"),
    JSON.stringify(bct),
  );
  // ── 3f: lost void answers, couldNotVoid, unknown outcomes, paging, locateCharge, health ──
  {
    const empty = { transactions: [], messages: OK };
    const voidOk = {
      transactionResponse: {
        responseCode: "1",
        transId: "120000000001",
        messages: [{ code: "1" }],
      },
      messages: OK,
    };
    const refusedTx = (code: string, text: string) => ({
      transactionResponse: {
        responseCode: "3",
        transId: "0",
        errors: [{ errorCode: code, errorText: text }],
      },
      messages: {
        resultCode: "Error",
        message: [{ code: "E00027", text: "The transaction was unsuccessful." }],
      },
    });

    let reads = 0;
    failTransport = (root) => root === "createTransactionRequest";
    answer = (root) =>
      root === "getTransactionDetailsRequest"
        ? details({ transactionStatus: reads++ === 0 ? "capturedPendingSettlement" : "voided" })
        : voidOk;
    const lostVoid = await adapter.refund({
      providerChargeId: "120000000001",
      idempotencyKey: "re_lost_1",
      currency: "USD",
    });
    ok(
      "refund: a void whose answer is lost, and the charge reads voided → succeeded",
      lostVoid.status === "succeeded" && lostVoid.providerRefundId === "120000000001",
    );
    answer = (root) =>
      root === "getTransactionDetailsRequest"
        ? details({ transactionStatus: "capturedPendingSettlement" })
        : voidOk;
    const notYet = await throws(() =>
      adapter.refund({
        providerChargeId: "120000000001",
        idempotencyKey: "re_lost_2",
        currency: "USD",
      }),
    );
    ok(
      "refund: a lost void the charge does not show yet → indeterminate, charge id stamped",
      notYet instanceof ProviderIndeterminateError && strandedObjectId(notYet) === "120000000001",
    );
    failTransport = null;

    sent.length = 0;
    answer = (root) =>
      root === "getTransactionDetailsRequest"
        ? details({ transactionStatus: "couldNotVoid" })
        : voidOk;
    const again = await adapter.refund({
      providerChargeId: "120000000001",
      idempotencyKey: "re_cnv_1",
      currency: "USD",
    });
    ok(
      "refund: couldNotVoid → the void is sent again",
      again.status === "succeeded" &&
        sent.some((x) => JSON.stringify(x.body).includes("voidTransaction")),
    );
    answer = (root) =>
      root === "getTransactionDetailsRequest"
        ? details({ transactionStatus: "couldNotVoid" })
        : refusedTx("16", "The transaction cannot be found.");
    const cnv = await throws(() =>
      adapter.refund({
        providerChargeId: "120000000001",
        idempotencyKey: "re_cnv_2",
        currency: "USD",
      }),
    );
    ok(
      "refund: couldNotVoid and the void refused → refused: the money is still captured",
      cnv instanceof ProviderRefusalError &&
        /still captured/.test(cnv.message) &&
        !/no money/i.test(cnv.message),
      cnv instanceof Error ? cnv.message : String(cnv),
    );

    const r19 = refusedTx("19", "An error occurred during processing.  Please try again.");
    answer = (root) =>
      root === "createTransactionRequest"
        ? r19
        : root.startsWith("get") && root.includes("List")
          ? empty
          : details({});
    const unknown = await throws(() =>
      adapter.charge({
        amountMinor: 1234n,
        currency: "USD",
        customer,
        paymentMethod: pm,
        idempotencyKey: "inv_19a",
      }),
    );
    ok(
      "charge: reason 19, nothing found → indeterminate, not a decline",
      unknown instanceof ProviderIndeterminateError,
    );
    let listed = 0;
    answer = (root) =>
      root === "createTransactionRequest"
        ? r19
        : root === "getUnsettledTransactionListRequest"
          ? listed++ === 0
            ? empty
            : {
                transactions: [
                  { transId: "120000000001", invoiceNumber: authorizenetReference("inv_19b") },
                ],
                messages: OK,
              }
          : root === "getTransactionListForCustomerRequest"
            ? empty
            : details({});
    const found19 = await adapter.charge({
      amountMinor: 1234n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "inv_19b",
    });
    ok(
      "charge: reason 19, and the lookup finds the charge → its real outcome",
      found19.status === "succeeded" && found19.providerChargeId === "120000000001",
    );

    const ref = authorizenetReference("inv_page");
    const rows = (n: number, from: number, mineAt = -1, at = "2026-10-27T10:00:00Z") =>
      Array.from({ length: n }, (_, i) => ({
        transId: String(130000000000 + from + i),
        invoiceNumber: from + i === mineAt ? ref : "INV-OTHER",
        submitTimeUTC: at,
      }));
    const offsets: string[] = [];
    answer = (root, body) => {
      if (root !== "getUnsettledTransactionListRequest")
        return details({ transId: "130000001000" });
      const off = String((body.paging as { offset: string }).offset);
      offsets.push(off);
      return { transactions: off === "1" ? rows(1000, 0) : rows(1, 1000, 1000), messages: OK };
    };
    const paged = await adapter.findByReference("900000001", ref);
    ok(
      "lookup: the unsettled list is read past its first 1000 rows",
      paged?.transId === "130000001000" && offsets.join() === "1,2",
      offsets.join(),
    );
    answer = (root) =>
      root === "getUnsettledTransactionListRequest"
        ? { transactions: rows(1000, 0), messages: OK }
        : empty;
    const capped = await throws(() => adapter.findByReference("900000001", ref));
    ok(
      "lookup: past the page cap it throws, never a short 'not found'",
      capped instanceof Error && /more than/.test(capped.message),
    );

    const lref = authorizenetReference("inv_loc");
    sent.length = 0;
    answer = (root, body) => {
      if (root === "getUnsettledTransactionListRequest") return empty;
      if (root === "getSettledBatchListRequest")
        return {
          batchList: [{ batchId: "5001", settlementTimeUTC: "2026-10-27T10:00:00Z" }],
          messages: OK,
        };
      if (root === "getTransactionListRequest")
        return {
          transactions:
            body.batchId === "5001" ? [{ transId: "120000000001", invoiceNumber: lref }] : [],
          messages: OK,
        };
      return details({ transactionStatus: "settledSuccessfully" });
    };
    const since = new Date(Date.now() - 3_600_000);
    const loc = await adapter.locateCharge({
      ownershipRef: "inv_x",
      idempotencyKey: "inv_loc",
      createdAfter: since,
    });
    const batchReq = sent.find((x) => x.root === "getSettledBatchListRequest")?.body ?? {};
    ok(
      "locateCharge: found in a batch settled since the attempt → its outcome",
      loc?.status === "succeeded" && loc.providerChargeId === "120000000001",
    );
    ok(
      "locateCharge: batch dates in XSD order, no milliseconds",
      Object.keys(batchReq).join() ===
        "merchantAuthentication,firstSettlementDate,lastSettlementDate" &&
        /:\d\dZ$/.test(String(batchReq.firstSettlementDate)),
      JSON.stringify(batchReq),
    );
    const pages: string[] = [];
    answer = (root, body) => {
      if (root === "getUnsettledTransactionListRequest") {
        pages.push(String((body.paging as { offset: string }).offset));
        return { transactions: rows(1000, 0, -1, "2020-01-01T00:00:00Z"), messages: OK };
      }
      if (root === "getSettledBatchListRequest") return { batchList: [], messages: OK };
      return empty;
    };
    const none = await adapter.locateCharge({
      ownershipRef: "inv_x",
      idempotencyKey: "inv_loc2",
      createdAfter: since,
    });
    ok(
      "locateCharge: nothing since the attempt → null, and older rows end the read",
      none === null && pages.join() === "1",
      pages.join(),
    );

    answer = () => approved;
    sent.length = 0;
    await adapter.charge({
      amountMinor: 1234n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "inv_tag",
      ownershipRef: "inv_0001",
      description: "Invoice INV-1",
    });
    const order = (
      sent.find((x) => x.root === "createTransactionRequest")!.body.transactionRequest as {
        order: Record<string, string>;
      }
    ).order;
    ok(
      "charge: our ref rides at the end of order.description",
      order.description === "Invoice INV-1 [ref:inv_0001]" &&
        Object.keys(order).join() === "invoiceNumber,description",
      JSON.stringify(order),
    );

    const hook = (
      status: string,
      name = "tmbilling",
      url = "https://example.com/v1/gateway_webhooks/authorizenet/gwa_XXXXXXXXXXXX01",
    ) => ({
      webhookId: "w1",
      name,
      url,
      status,
      eventTypes: [],
    });
    let listedHooks: unknown = [hook("inactive")];
    answer = (_r, _b, url) => (url.includes("/rest/v1/webhooks") ? listedHooks : { messages: OK });
    let h = await adapter.healthCheck();
    ok(
      "health: an endpoint set inactive fails the check, with steps",
      !h.ok &&
        /inactive/.test(h.detail ?? "") &&
        h.checks?.[0]?.status === "failed" &&
        (h.checks[0].steps?.length ?? 0) > 0,
    );
    listedHooks = [hook("active")];
    h = await adapter.healthCheck();
    ok("health: an active endpoint passes", h.ok && h.checks?.[0]?.status === "ok");
    listedHooks = [hook("inactive", "other system", "https://other.example.com/hooks")];
    h = await adapter.healthCheck();
    ok("health: another system's inactive webhook is not ours", h.ok);
    listedHooks = { __status: 500 };
    h = await adapter.healthCheck();
    ok(
      "health: unreadable webhooks → unchecked, not a failure",
      h.ok && h.checks?.[0]?.status === "unchecked",
    );
  }
  const noKey = new AuthorizenetProvider({
    apiLoginId: "l",
    transactionKey: "k",
    signatureKey: SIG_KEY,
    livemode: true,
    apiHost: "https://anet.invalid",
  });
  answer = () => ({ messages: OK });
  ok(
    "intent: no Public Client Key → refused with the remedy",
    (await throws(() =>
      noKey.createIntent({ purpose: "setup", currency: "USD", customer, idempotencyKey: "x" }),
    )) instanceof ProviderRefusalError,
  );

  // payment intent with a saved card, capture, void
  answer = (_root, body) => {
    const t = (body.transactionRequest as { transactionType?: string } | undefined)
      ?.transactionType;
    if (t === "authOnlyTransaction")
      return {
        transactionResponse: {
          responseCode: "1",
          transId: "120000000050",
          accountType: "Visa",
          messages: [{ code: "1" }],
        },
        messages: OK,
      };
    if (t === "priorAuthCaptureTransaction")
      return {
        transactionResponse: {
          responseCode: "1",
          transId: "0",
          refTransID: "120000000050",
          messages: [{ code: "311", description: "This transaction has already been captured." }],
        },
        messages: OK,
      };
    if (t === "voidTransaction")
      return {
        transactionResponse: {
          responseCode: "1",
          transId: "120000000050",
          messages: [{ code: "1" }],
        },
        messages: OK,
      };
    return details({
      transId: "120000000050",
      transactionType: "authOnlyTransaction",
      transactionStatus: "authorizedPendingCapture",
    });
  };
  const auth = await adapter.createIntent({
    purpose: "payment",
    amountMinor: 700n,
    currency: "USD",
    customer,
    paymentMethod: pm,
    idempotencyKey: "pi_2",
    session: "on_session",
  });
  ok(
    "intent: payment with a saved card → authorized",
    auth.status === "authorized" && auth.intentId === "120000000050",
  );
  const cap = await adapter.consumeIntent({
    intentId: "120000000050",
    purpose: "payment",
    idempotencyKey: "cap1",
  });
  ok(
    "consume: a repeated capture (311) keeps the original as captured",
    cap.purpose === "payment" &&
      cap.charge.status === "succeeded" &&
      cap.charge.providerChargeId === "120000000050",
  );
  const vo = await adapter.voidIntent({ intentId: "120000000050", idempotencyKey: "v2" });
  ok("void: an authorization → voided, held true", vo.voided && vo.held === true);

  // webhooks through the adapter
  const body = JSON.stringify({
    notificationId: "11111111-2222-4333-8444-555555555555",
    eventType: "net.authorize.payment.authcapture.created",
    eventDate: "2026-10-24T16:49:44.0080095Z",
    webhookId: "w",
    payload: {
      responseCode: 1,
      merchantReferenceId: ref,
      authAmount: 12.34,
      entityName: "transaction",
      id: "120000000001",
    },
  });
  answer = () => details({ order: { invoiceNumber: ref } });
  const evs = await adapter.normalizeWebhook({
    payload: body,
    headers: { "X-ANET-Signature": signAuthorizenetPayload(SIG_KEY, body) },
  });
  ok(
    "webhook: signed delivery → charge.succeeded, ours, with the event id",
    evs[0]?.type === "charge.succeeded" &&
      evs[0].ownership === "ours" &&
      evs[0].providerEventId === "anet_11111111-2222-4333-8444-555555555555",
  );
  ok(
    "webhook: forged delivery refused",
    (await throws(() =>
      adapter.normalizeWebhook({
        payload: body,
        headers: { "x-anet-signature": `sha512=${"A".repeat(128)}` },
      }),
    )) instanceof Error,
  );
  ok(
    "webhook: event id is stable across a redelivery",
    adapter.webhookEventId({ payload: body, headers: {} }) ===
      adapter.webhookEventId({ payload: Buffer.from(body), headers: {} }),
  );

  // provisioning
  const calls: string[] = [];
  let hooks: Array<{ webhookId: string; url: string; status: string; eventTypes: string[] }> = [];
  answer = (_r, b, url, method) => {
    calls.push(`${method} ${url.replace("https://anet.invalid", "")}`);
    if (method === "GET") return hooks;
    if (method === "POST") return { webhookId: "wh-new", ...(b as object) };
    return { webhookId: "wh-old" };
  };
  const p1 = await adapter.provisionWebhookEndpoint({
    url: "https://example.com/v1/gateway_webhooks/authorizenet/gwa_XXXXXXXXXXXX01",
  });
  ok(
    "provision: creates the endpoint when none exists",
    p1.providerEndpointId === "wh-new" &&
      calls.join() === "GET /rest/v1/webhooks,POST /rest/v1/webhooks",
    calls.join(),
  );
  ok(
    "provision: Basic auth (login:key) on the REST API",
    sent.at(-1)?.auth === `Basic ${Buffer.from("login:key").toString("base64")}`,
  );
  hooks = [
    {
      webhookId: "wh-old",
      url: "https://example.com/v1/gateway_webhooks/authorizenet/gwa_XXXXXXXXXXXX01",
      status: "active",
      eventTypes: [...AUTHORIZENET_WEBHOOK_EVENTS],
    },
  ];
  calls.length = 0;
  const p2 = await adapter.provisionWebhookEndpoint({ url: hooks[0]!.url });
  ok(
    "provision: an up-to-date endpoint is reused, no write",
    p2.providerEndpointId === "wh-old" && calls.join() === "GET /rest/v1/webhooks",
  );
  hooks[0]!.status = "inactive";
  calls.length = 0;
  await adapter.provisionWebhookEndpoint({ url: hooks[0]!.url });
  ok(
    "provision: an inactive endpoint is re-enabled",
    calls.join() === "GET /rest/v1/webhooks,PUT /rest/v1/webhooks/wh-old",
  );
  answer = (_r, _b, _u, method) =>
    method === "GET"
      ? []
      : {
          __status: 400,
          details: [{ message: "Invalid Url entered. Only valid HTTP(s) Urls are supported." }],
        };
  const refused = await throws(() =>
    adapter.provisionWebhookEndpoint({ url: "https://example.com/x?id=1" }),
  );
  ok(
    "provision: a refusal throws with Authorize.net's reason",
    refused instanceof Error && /Invalid Url/.test(refused.message),
  );

  // settlement poll: batches → transactions (paged) → details only for our late failures
  {
    const ours = authorizenetReference("inv_settle_1");
    const refundRef = authorizenetReference("re_settle_1");
    const filler = Array.from({ length: 1000 }, (_, i) => ({
      transId: String(130000000000 + i),
      transactionStatus: "settledSuccessfully",
      invoiceNumber: `INV-OTHER-${i}`,
    }));
    const page2 = [
      { transId: "120000000101", transactionStatus: "settlementError", invoiceNumber: ours },
      { transId: "120000000102", transactionStatus: "settlementError", invoiceNumber: "INV-9" },
      { transId: "120000000103", transactionStatus: "settlementError", invoiceNumber: refundRef },
      { transId: "120000000104", transactionStatus: "settledSuccessfully", invoiceNumber: ours },
    ];
    answer = (root, body) => {
      if (root === "getSettledBatchListRequest")
        return {
          batchList: [{ batchId: "9001", settlementTimeUTC: "2026-10-26T04:12:00Z" }],
          messages: OK,
        };
      if (root === "getTransactionListRequest") {
        const page = Number((body.paging as { offset: string }).offset);
        return { transactions: page === 1 ? filler : page2, messages: OK };
      }
      if (root === "getTransactionDetailsRequest") {
        const id = String(body.transId);
        return details({
          transId: id,
          transactionStatus: "settlementError",
          order: { invoiceNumber: id === "120000000103" ? refundRef : ours },
          ...(id === "120000000103"
            ? { transactionType: "refundTransaction", refTransId: "120000000099" }
            : {}),
        });
      }
      throw new Error(`unexpected ${root}`);
    };
    sent.length = 0;
    const since = new Date("2026-10-26T00:00:00Z");
    const until = new Date("2026-10-26T06:00:00Z");
    const evs = await adapter.pollSettlements({ since, until });
    const lists = sent.filter((x) => x.root === "getSettledBatchListRequest");
    const pages = sent.filter((x) => x.root === "getTransactionListRequest");
    const reads = sent.filter((x) => x.root === "getTransactionDetailsRequest");
    ok(
      "settlement poll: batch lists cover the 70-day eCheck return window in 30-day pieces, UTC",
      lists.length === 3 &&
        lists[0]!.body.firstSettlementDate === "2026-08-17T06:00:00Z" &&
        lists[2]!.body.lastSettlementDate === "2026-10-26T06:00:00Z",
      JSON.stringify(lists.map((x) => x.body)),
    );
    ok(
      "settlement poll: the batch is read page by page (1000 a page) until a short page",
      pages.length === 2 &&
        pages.every((x) => x.body.batchId === "9001") &&
        (pages[0]!.body.paging as { limit: string }).limit === "1000" &&
        (pages[1]!.body.paging as { offset: string }).offset === "2",
    );
    ok(
      "settlement poll: details are read only for our late failures",
      reads.map((x) => x.body.transId).join() === "120000000101,120000000103",
      reads.map((x) => x.body.transId).join(),
    );
    const failed = evs.find((e) => e.type === "charge.failed");
    const refundFailed = evs.find((e) => e.type === "refund.failed");
    ok(
      "settlement poll: our settlementError charge is a late reversal",
      evs.length === 2 &&
        failed?.providerChargeId === "120000000101" &&
        failed.lateReversal === true &&
        failed.ownership === "ours" &&
        failed.providerEventId === "anet_settle_120000000101_settlementError" &&
        failed.occurredAt.toISOString() === "2026-10-26T04:12:00.000Z",
      JSON.stringify(evs.map((e) => [e.type, e.providerEventId])),
    );
    ok(
      "settlement poll: our refund in settlementError is refund.failed by its own id",
      refundFailed?.providerRefundId === "120000000103" &&
        refundFailed.providerEventId === "anet_settle_120000000103_settlementError",
    );
    const again = await adapter.pollSettlements({ since, until });
    ok(
      "settlement poll: a re-read gives the same event ids (dedupe holds)",
      again.map((e) => e.providerEventId).join() === evs.map((e) => e.providerEventId).join(),
    );
    ok(
      "settlement poll: a settled card transaction maps to nothing",
      normalizeAuthorizenetSettlement(
        details({ transactionStatus: "settledSuccessfully", order: { invoiceNumber: ours } })
          .transaction as AnetTransaction,
        {},
      ).length === 0,
    );
    // eCheck: success, returns and refunds arrive only in the batch report.
    const bank = { bankAccount: { accountNumber: "XXXX7891", echeckType: "WEB" } };
    const echeck = (t: Partial<AnetTransaction>) =>
      normalizeAuthorizenetSettlement(
        details({ order: { invoiceNumber: ours }, payment: bank, ...t })
          .transaction as AnetTransaction,
        { settlementTimeUTC: "2026-10-26T04:12:00Z" },
      );
    const sale = echeck({ transactionStatus: "settledSuccessfully" });
    ok(
      "eCheck poll: a settled sale → charge.succeeded with its amount",
      sale.length === 1 &&
        sale[0]!.type === "charge.succeeded" &&
        sale[0]!.capturedAmountMinor === 1234n &&
        sale[0]!.providerEventId === "anet_settle_120000000001_settledSuccessfully",
    );
    const ret = echeck({
      transactionStatus: "returnedItem",
      returnedItems: {
        returnedItem: [
          {
            id: "1",
            dateUTC: "2026-10-29T10:00:00Z",
            code: "R01",
            description: "Insufficient Funds",
          },
        ],
      },
    });
    ok(
      "eCheck poll: an ACH return → late reversal with the R-code, dated at the return",
      ret[0]?.type === "charge.failed" &&
        ret[0].lateReversal === true &&
        ret[0].providerFailureCode === "R01" &&
        ret[0].failureCode === "insufficient_funds" &&
        ret[0].occurredAt.toISOString() === "2026-10-29T10:00:00.000Z",
      JSON.stringify(ret[0]),
    );
    const unauthorized = echeck({
      transactionStatus: "chargeback",
      returnedItems: [{ code: "R10", description: "Customer Advises Not Authorized" }],
    });
    ok(
      "eCheck poll: a chargeback (R10) → late reversal, debit_not_authorized",
      unauthorized[0]?.type === "charge.failed" &&
        unauthorized[0].lateReversal === true &&
        unauthorized[0].failureCode === "debit_not_authorized",
    );
    const back = echeck({ transactionStatus: "chargebackReversal" });
    ok(
      "eCheck poll: a reversed chargeback → charge.succeeded with amountMinor (late capture)",
      back[0]?.type === "charge.succeeded" && back[0].amountMinor === 1234n,
    );
    const refunded = echeck({
      transId: "120000000079",
      transactionType: "refundTransaction",
      transactionStatus: "refundSettledSuccessfully",
      refTransId: "120000000001",
    });
    ok(
      "eCheck poll: a settled refund → charge.refunded, its own id, succeeded",
      refunded[0]?.type === "charge.refunded" &&
        refunded[0].providerRefundId === "120000000079" &&
        refunded[0].refunds?.[0]?.status === "succeeded",
    );
    // Old eCheck batches are read for returns; old card batches are not.
    answer = (root, body) => {
      if (root === "getSettledBatchListRequest")
        return String(body.firstSettlementDate).startsWith("2026-08")
          ? {
              batchList: [
                {
                  batchId: "7001",
                  settlementTimeUTC: "2026-08-20T04:00:00Z",
                  paymentMethod: "eCheck",
                },
                {
                  batchId: "7002",
                  settlementTimeUTC: "2026-08-20T04:00:00Z",
                  paymentMethod: "creditCard",
                },
              ],
              messages: OK,
            }
          : { batchList: [], messages: OK };
      if (root === "getTransactionListRequest")
        return {
          transactions: [
            { transId: "120000000201", transactionStatus: "returnedItem", invoiceNumber: ours },
            {
              transId: "120000000202",
              transactionStatus: "settledSuccessfully",
              invoiceNumber: ours,
            },
          ],
          messages: OK,
        };
      if (root === "getTransactionDetailsRequest")
        return details({
          transId: String(body.transId),
          transactionStatus: "returnedItem",
          order: { invoiceNumber: ours },
          payment: bank,
          returnedItems: [{ code: "R02", description: "Account Closed" }],
        });
      throw new Error(`unexpected ${root}`);
    };
    sent.length = 0;
    const old = await adapter.pollSettlements({ since, until });
    ok(
      "eCheck poll: a return in a 60-day-old eCheck batch is found; an old card batch is skipped",
      old.length === 1 &&
        old[0]!.type === "charge.failed" &&
        old[0]!.providerFailureCode === "R02" &&
        sent
          .filter((x) => x.root === "getTransactionListRequest")
          .every((x) => x.body.batchId === "7001"),
      JSON.stringify(old.map((e) => [e.type, e.providerEventId])),
    );
    answer = (root) =>
      root === "getSettledBatchListRequest"
        ? {
            batchList: Array.from({ length: 151 }, (_, i) => ({ batchId: String(9100 + i) })),
            messages: OK,
          }
        : { transactions: [], messages: OK };
    const tooMany = await throws(() => adapter.pollSettlements({ since, until }));
    ok(
      "settlement poll: more batches than the cap throws (the window is read again)",
      tooMany instanceof Error && /more than 150/.test(tooMany.message),
    );
    answer = (root) =>
      root === "getSettledBatchListRequest"
        ? { batchList: [{ batchId: "9002" }], messages: OK }
        : {
            transactions: Array.from({ length: 1000 }, (_, i) => ({ transId: String(i) })),
            messages: OK,
          };
    sent.length = 0;
    const endless = await throws(() => adapter.pollSettlements({ since, until }));
    ok(
      "settlement poll: a batch past the page cap throws after 25 pages",
      endless instanceof Error &&
        sent.filter((x) => x.root === "getTransactionListRequest").length === 25,
    );
  }
} finally {
  globalThis.fetch = realFetch;
}

// ── 9 · the payer's ACH authorization (engine + database) ──────────────────
{
  const org = await createOrganization({ name: "ACH authorization" });
  const other = await createOrganization({ name: "ACH other org" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Fernhill Analytics",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // Mail on, so the payer's copy of the authorization is queued.
  await systemDb
    .update(businesses)
    .set({ emailConfig: { enabled: true } })
    .where(eq(businesses.id, biz.id));
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "payer@example.com",
    firstName: "Conformance",
    lastName: "Payer",
  });
  const parties = {
    businessName: "Fernhill Analytics",
    businessEmail: "billing@example.com",
    payerName: "Conformance Payer",
    payerEmail: "payer@example.com",
  };
  const text = achAuthorizationText(parties);
  ok(
    "ACH text: names the business, the varying amount, the 10-day notice, how to cancel, the payer",
    text.version === ACH_AUTHORIZATION_TEXT_VERSION &&
      text.paragraphs.join(" ").includes("Fernhill Analytics") &&
      /can change from one invoice to the next/.test(text.paragraphs.join(" ")) &&
      /at least 10 days before/.test(text.paragraphs.join(" ")) &&
      /To cancel it/.test(text.paragraphs.join(" ")) &&
      text.agreement.includes("Conformance Payer"),
  );
  // With no business email, "I tell <business>" named no way to do it.
  const noEmail = achAuthorizationText({ ...parties, businessEmail: null }).paragraphs.join(" ");
  ok(
    "ACH text: with no business email, cancelling names the billing portal only",
    noEmail.includes("To cancel it, I remove this bank account in my billing portal.") &&
      !noEmail.includes("I tell") &&
      text.paragraphs.join(" ").includes("I tell Fernhill Analytics at billing@example.com"),
    noEmail,
  );
  ok(
    "ACH text: a stale version is refused",
    (await throws(() =>
      achAuthorizationEvidence({ textVersion: "old", ipAddress: null, userAgent: null }, parties),
    )) instanceof AchAuthorizationError,
  );
  const bankRef = (id: string) => ({
    providerKey: "authorizenet" as const,
    providerPaymentMethodId: id,
    providerCustomerId: "900000001",
    display: { type: "us_bank_account" as const, last4: "7891" },
  });
  ok(
    "ACH evidence: a bank account with no authorization is not saved",
    (await throws(() =>
      persistVaultedPaymentMethod({
        organizationId: orgId,
        businessId: biz.id,
        customer: cust,
        vaulted: bankRef("900000101"),
        gatewayAccountId: null,
      }),
    )) instanceof AchAuthorizationRequiredError,
  );
  const evidence = achAuthorizationEvidence(
    { textVersion: ACH_AUTHORIZATION_TEXT_VERSION, ipAddress: "203.0.113.7", userAgent: "UA/1" },
    parties,
  );
  const pmRow = await persistVaultedPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    vaulted: bankRef("900000102"),
    gatewayAccountId: null,
    achAuthorization: evidence,
  });
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(paymentMethodAuthorizations)
      .where(eq(paymentMethodAuthorizations.paymentMethodId, pmRow.id)),
  );
  ok(
    "ACH evidence: written with the method — version, full text, time, IP, agent, payer",
    rows.length === 1 &&
      rows[0]!.textVersion === ACH_AUTHORIZATION_TEXT_VERSION &&
      rows[0]!.text.includes("Fernhill Analytics") &&
      rows[0]!.ipAddress === "203.0.113.7" &&
      rows[0]!.userAgent === "UA/1" &&
      rows[0]!.payerEmail === "payer@example.com" &&
      rows[0]!.paymentMethodPublicId === pmRow.publicId,
  );
  const copies = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(emailMessages)
      .where(
        and(eq(emailMessages.businessId, biz.id), eq(emailMessages.type, "ach_authorization_copy")),
      ),
  );
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  ok(
    "ACH copy: one email queued with the acceptance, to the payer on the row",
    copies.length === 1 && copies[0]!.toAddress === "payer@example.com",
    `${copies.length}`,
  );
  ok(
    "ACH copy: it carries the stored text word for word, the version and the accepted time",
    copies.length === 1 &&
      flat(copies[0]!.bodyText).includes(flat(rows[0]!.text)) &&
      copies[0]!.bodyText.includes(ACH_AUTHORIZATION_TEXT_VERSION) &&
      /UTC/.test(copies[0]!.bodyText) &&
      /To cancel this authorization/.test(copies[0]!.bodyText),
  );
  ok(
    "ACH copy: the paragraphs of the text stay separate lines",
    copies.length === 1 && copies[0]!.bodyHtml.includes("Bank account debit authorization<br>"),
  );
  // A second acceptance on the same account (the gateway returned the same profile).
  await persistVaultedPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    vaulted: bankRef("900000102"),
    gatewayAccountId: null,
    achAuthorization: { ...evidence, acceptedAt: new Date() },
  });
  const afterSecond = await withTenant(orgId, (tx) =>
    tx
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(
        and(eq(emailMessages.businessId, biz.id), eq(emailMessages.type, "ach_authorization_copy")),
      ),
  );
  ok("ACH copy: one email for each acceptance", afterSecond.length === 2);
  // A gateway that shows its own ACH text (Stripe) gets no copy from us.
  await persistVaultedPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    vaulted: { ...bankRef("ba_XXXXXXXXXXXX01"), providerKey: "stripe" as const },
    gatewayAccountId: null,
  });
  const afterGateway = await withTenant(orgId, (tx) =>
    tx
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(
        and(eq(emailMessages.businessId, biz.id), eq(emailMessages.type, "ach_authorization_copy")),
      ),
  );
  ok('ACH copy: none for a "gateway" ACH method', afterGateway.length === 2);
  ok(
    "ACH evidence: append-only — the app role cannot UPDATE it",
    (await throws(() =>
      withTenant(orgId, (tx) =>
        tx
          .update(paymentMethodAuthorizations)
          .set({ text: "changed" })
          .where(eq(paymentMethodAuthorizations.paymentMethodId, pmRow.id)),
      ),
    )) instanceof Error,
  );
  ok(
    "ACH evidence: append-only — the app role cannot DELETE it",
    (await throws(() =>
      withTenant(orgId, (tx) =>
        tx
          .delete(paymentMethodAuthorizations)
          .where(eq(paymentMethodAuthorizations.paymentMethodId, pmRow.id)),
      ),
    )) instanceof Error,
  );
  const seenByOther = await withTenant(other.organization.id, (tx) =>
    tx.select().from(paymentMethodAuthorizations),
  );
  ok(
    "ACH evidence: another organization sees none of it (RLS)",
    !seenByOther.some((r) => r.paymentMethodId === pmRow.id),
  );
  const card = await persistVaultedPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: cust,
    vaulted: { ...bankRef("900000103"), display: { type: "card" as const, last4: "1111" } },
    gatewayAccountId: null,
  });
  ok("ACH evidence: a card needs none", card.type === "card");
}

await closeDb().catch(() => undefined);
const failed = checks.filter(([, c]) => !c);
for (const [name, c, detail] of checks)
  console.log(`  ${c ? "✓" : "✗"} ${name}${!c && detail ? ` — ${detail}` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks`);
console.log(failed.length === 0 ? "✅ AUTHORIZENET: PASS" : "❌ AUTHORIZENET: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
