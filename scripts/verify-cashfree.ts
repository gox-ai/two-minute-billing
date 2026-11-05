/**
 * Cashfree adapter, offline. No network: `fetch` is replaced by a recorder.
 *
 * Covers webhook signatures (tampered body, wrong key, stale and future timestamps),
 * event normalisation from fixtures shaped on Cashfree's documented payloads, decline
 * mapping, capability declarations, request shapes, and the id scheme that lets a
 * webhook rebuild the ids the API calls returned.
 *
 *   pnpm verify:cashfree
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { primeGeoReference } from "@/platform/geo";
import {
  CashfreeProvider,
  CASHFREE_CARD_UPI_MANDATE_MAX_MINOR,
  CASHFREE_LIVE_BASE,
  CASHFREE_SANDBOX_BASE,
  CASHFREE_WEBHOOK_MAX_AGE_MS,
  CASHFREE_WEBHOOK_VERSIONS,
  cashfreeIdempotencyUuid,
  cashfreeMandateStatus,
  cashfreePaymentId,
  cashfreeSubscriptionId,
  chargeScheduleDate,
  controlledSchedule,
  cashfreeMethodUsed,
  cashfreePhone,
  cashfreeForeignPhone,
  cashfreeIndianCardProblem,
  istDate,
  latestPayment,
  nextUpiDebitWindow,
  normalizeCashfreeEvent,
  normalizeCashfreeEvents,
  notDueWaitMs,
  parseCashfreeChargeRef,
  subChargeRef,
  subRefundRef,
  CASHFREE_MANDATE_CURRENCIES,
  CASHFREE_ORDER_CURRENCIES,
  CASHFREE_ORDER_EXPONENTS,
  cashfreeAmount,
  cashfreeInternationalPhone,
  cashfreeOrderPhone,
  cashfreeRemarks,
  parseCashfreeJson,
  cashfreeMinor,
  cashfreeOrderAmountProblem,
  orderChargeRef,
  orderRefundRef,
} from "@/providers/cashfree";
import { currencyExponent } from "@/platform/currency";
import { gatewayAllowsPurpose } from "@/providers/gateway-catalog";
import { effectiveMethodTypes } from "@/modules/gateway/service";
import { DECLINE_SETS, normalizeCashfreeDecline } from "@/providers/decline-codes";
import { GATEWAYS } from "@/providers/gateway-catalog";
import { gatewayNotifiesPayerOf, ProviderRefusalError } from "@/providers/types";
import { GATEWAY_FACTORIES } from "@/providers/gateways";
import {
  PRE_DEBIT_NOT_DUE_CODE,
  ProviderIndeterminateError,
  type NormalizeWebhookInput,
} from "@/providers/types";
import { flushGatewayRequestLogs } from "@/providers/http";
import { closeDb } from "@/platform/db";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push([name, cond, detail]);
const throwsSync = (fn: () => unknown, re?: RegExp) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re ? re.test(String((e as Error).message)) : true;
  }
};

const SECRET = "cf_secret_offline_x";
const NOW = Date.parse("2026-10-24T06:00:00Z"); // 11:30 IST
const cf = new CashfreeProvider({
  appId: "cf_app_x",
  secretKey: SECRET,
  livemode: false,
  apiBase: "https://cashfree.invalid/pg",
  now: () => NOW,
});

const sign = (
  body: string,
  ts = String(NOW),
  key = SECRET,
  version: string | null = "2025-01-01",
): NormalizeWebhookInput => ({
  payload: body,
  headers: {
    ...(version ? { "x-webhook-version": version } : {}),
    "x-webhook-timestamp": ts,
    "x-webhook-signature": createHmac("sha256", key)
      .update(ts + body)
      .digest("base64"),
  },
});

// ── fixtures (documented shapes, fake ids) ───────────────────────────────────
const SID = cashfreeSubscriptionId("fixture");
const PID = cashfreePaymentId(SID, "inv_fixture_attempt_1");
const subData = (status: string, extra: Record<string, unknown> = {}) => ({
  payment_id: PID,
  cf_payment_id: "49000001",
  subscription_id: SID,
  cf_subscription_id: "23000001",
  payment_type: "CHARGE",
  subscription_details: {
    subscription_id: SID,
    subscription_status: "ACTIVE",
    subscription_tags: {
      tmbilling_ref: "cus_XXXXXXXXXXXX01",
      tmbilling_customer: "cus_XXXXXXXXXXXX01",
    },
  },
  payment_amount: 399.0,
  payment_currency: "INR",
  failure_details: { failure_reason: null },
  payment_status: status,
  ...extra,
});
const ev = (type: string, data: unknown) =>
  JSON.stringify({ data, event_time: "2026-10-24T11:00:00+05:30", type });

async function main() {
  // ── A. signatures ──────────────────────────────────────────────────────────
  const body = ev("SUBSCRIPTION_PAYMENT_SUCCESS", subData("SUCCESS"));
  const good = await cf.normalizeWebhook(sign(body));
  ok("a signed webhook verifies", good.length === 1 && good[0]!.type === "charge.succeeded");
  const onVersion = (v: string | null) => cf.normalizeWebhook(sign(body, String(NOW), SECRET, v));
  const unread = [
    await onVersion(null),
    await onVersion("2099-01-01"),
    await onVersion("2022-09-01"),
  ];
  ok(
    "a delivery on no version or an undocumented one is recorded as an error, never parsed",
    unread.every(
      (r) =>
        r.length === 1 &&
        r[0]!.type === "unknown" &&
        /webhook version/.test(r[0]!.unresolved ?? ""),
    ),
  );
  // The dashboard's "Test" delivery: signed, no version header (measured 2026-10-27).
  const ping = ev("WEBHOOK", { test_object: { test_key: "test_value" } });
  const pinged = await cf.normalizeWebhook(sign(ping, String(NOW), SECRET, null));
  ok(
    "the dashboard test delivery is a signed no-op, not a version error",
    pinged.length === 1 && pinged[0]!.type === "unknown" && !pinged[0]!.unresolved,
  );
  let forgedPing = false;
  try {
    await cf.normalizeWebhook(sign(ping, String(NOW), "wrong_secret", null));
  } catch {
    forgedPing = true;
  }
  ok("a test delivery with a bad signature is still refused", forgedPing);
  const read = await Promise.all(CASHFREE_WEBHOOK_VERSIONS.map((v) => onVersion(v)));
  ok(
    "every documented version (2023-08-01, 2025-01-01, 2026-01-01) is read",
    read.every((r) => r[0]!.type === "charge.succeeded" && !r[0]!.unresolved),
  );
  const tampered = sign(body);
  tampered.payload = body.replace('"payment_amount":399', '"payment_amount":1');
  if (tampered.payload === body) throw new Error("the tamper fixture changed nothing");
  ok(
    "a tampered body is refused",
    throwsSync(() => cf.verifySignature(tampered), /signature/),
  );
  ok(
    "another key's signature is refused",
    throwsSync(() => cf.verifySignature(sign(body, String(NOW), "other")), /signature/),
  );
  ok(
    "a stale timestamp is refused, even with a valid signature",
    throwsSync(
      () => cf.verifySignature(sign(body, String(NOW - CASHFREE_WEBHOOK_MAX_AGE_MS - 1000))),
      /window/,
    ),
  );
  ok(
    "a timestamp just inside the window passes",
    !throwsSync(() =>
      cf.verifySignature(sign(body, String(NOW - CASHFREE_WEBHOOK_MAX_AGE_MS + 60_000))),
    ),
  );
  ok(
    "a future timestamp is refused",
    throwsSync(() => cf.verifySignature(sign(body, String(NOW + 3_600_000))), /window/),
  );
  // Measured on a live test delivery: version 2026-01-01 sends whole seconds.
  ok(
    "a timestamp in seconds passes",
    !throwsSync(() => cf.verifySignature(sign(body, String(Math.floor(NOW / 1000))))),
  );
  ok(
    "a stale timestamp in seconds is refused",
    throwsSync(
      () =>
        cf.verifySignature(
          sign(body, String(Math.floor((NOW - CASHFREE_WEBHOOK_MAX_AGE_MS) / 1000) - 60)),
        ),
      /window/,
    ),
  );
  // The endpoint's own Secret Key (measured: version 2025-01-01 endpoints show one).
  const withHook = new CashfreeProvider({
    appId: "cf_app_x",
    secretKey: SECRET,
    webhookSecret: "cf_hook_x",
    livemode: false,
    apiBase: "https://cashfree.invalid/pg",
    now: () => NOW,
  });
  ok(
    "a webhook signed with the endpoint's Secret Key passes",
    !throwsSync(() => withHook.verifySignature(sign(body, String(NOW), "cf_hook_x"))),
  );
  ok(
    "the API Secret Key still passes when an endpoint key is set",
    !throwsSync(() => withHook.verifySignature(sign(body))),
  );
  ok(
    "a third key is refused",
    throwsSync(() => withHook.verifySignature(sign(body, String(NOW), "other")), /signature/),
  );
  ok(
    "missing headers are refused",
    throwsSync(() => cf.verifySignature({ payload: body, headers: {} }), /missing/),
  );

  // ── B. normalisation ───────────────────────────────────────────────────────
  const n = (type: string, data: unknown) => normalizeCashfreeEvent(type, data as never);
  const success = n("SUBSCRIPTION_PAYMENT_SUCCESS", subData("SUCCESS"));
  ok(
    "subscription debit success → charge.succeeded on sub:<payment id>",
    success.type === "charge.succeeded" && success.providerChargeId === subChargeRef(PID),
  );
  ok(
    "a tagged subscription reads as ours",
    success.ownership === "ours" && success.ownershipRef === "cus_XXXXXXXXXXXX01",
  );
  ok(
    "capturedAmountMinor: a subscription debit carries payment_amount in paise",
    success.capturedAmountMinor === 39900n &&
      n("SUBSCRIPTION_PAYMENT_SUCCESS", subData("SUCCESS", { payment_amount: "1180.50" }))
        .capturedAmountMinor === 118050n,
  );
  ok(
    "capturedAmountMinor: unset when the debit names no amount, and on a failure",
    n("SUBSCRIPTION_PAYMENT_SUCCESS", subData("SUCCESS", { payment_amount: undefined }))
      .capturedAmountMinor === undefined &&
      n("SUBSCRIPTION_PAYMENT_FAILED", subData("FAILED")).capturedAmountMinor === undefined,
  );
  const failed = n(
    "SUBSCRIPTION_PAYMENT_FAILED",
    subData("FAILED", {
      failure_details: {
        failure_reason: "DEBIT FAILED | Insufficient Funds In Customer (Remitter) Account",
      },
    }),
  );
  ok(
    "subscription debit failure → charge.failed, insufficient_funds, retriable",
    failed.type === "charge.failed" &&
      failed.failureCode === "insufficient_funds" &&
      failed.failureRetriable === true,
  );
  const cancelled = n("SUBSCRIPTION_PAYMENT_CANCELLED", subData("CANCELLED"));
  ok("a cancelled debit is a failed charge", cancelled.type === "charge.failed");
  const authOk = n("SUBSCRIPTION_PAYMENT_SUCCESS", subData("SUCCESS", { payment_type: "AUTH" }));
  ok(
    "an AUTH success is the setup intent, not money",
    authOk.type === "intent.setup_succeeded" &&
      authOk.providerIntentId === SID &&
      !authOk.providerChargeId,
  );
  const authFail = n("SUBSCRIPTION_AUTH_STATUS", {
    ...subData("FAILED", { payment_type: "AUTH" }),
    subscription_details: { subscription_id: SID, subscription_status: "INITIALIZED" },
  });
  ok(
    "a failed mandate authorization → intent.setup_failed",
    authFail.type === "intent.setup_failed" && authFail.providerIntentId === SID,
  );
  const statusChanged = n("SUBSCRIPTION_STATUS_CHANGED", {
    subscription_details: {
      subscription_id: SID,
      subscription_status: "CUSTOMER_CANCELLED",
      subscription_expiry_time: "2055-08-07T10:30:46",
    },
    plan_details: { plan_type: "ON_DEMAND", plan_max_amount: 399.0, plan_currency: "INR" },
    authorization_details: {
      authorization_reference: "umn_XXXXXXXX01",
      authorization_status: "ACTIVE",
      payment_method: { upi: { channel: "link", upi_id: "payer@example" } },
      payment_group: "upi",
    },
  });
  ok(
    "a revoked mandate → mandate_updated, cancelled, ceiling 39900, rail upi",
    statusChanged.type === "payment_method.mandate_updated" &&
      statusChanged.providerPaymentMethodId === SID &&
      statusChanged.mandate?.status === "cancelled" &&
      statusChanged.mandate?.maxAmountMinor === 39_900n &&
      statusChanged.mandate?.rail === "upi" &&
      statusChanged.mandate?.expiresAt?.toISOString() === "2055-08-07T05:00:46.000Z",
  );
  const mapping: [string, string | undefined][] = [
    ["ACTIVE", "confirmed"],
    ["BANK_APPROVAL_PENDING", "initiated"],
    ["CUSTOMER_PAUSED", "paused"],
    ["ON_HOLD", "paused"],
    ["CARD_EXPIRED", "cancelled"],
    ["LINK_EXPIRED", "cancelled"],
    ["SOMETHING_NEW", undefined],
  ];
  ok(
    "subscription statuses map onto the mandate vocabulary",
    mapping.every(([a, b]) => cashfreeMandateStatus(a) === b),
  );

  for (const t of [
    "SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS",
    "SUBSCRIPTION_PAYMENT_CONTROLLED_NOTIFICATION_STATUS",
  ]) {
    const sent = n(t, {
      notification_id: `${PID}-n`,
      notification_status: "SUCCESS",
      payment_id: PID,
    });
    const refused = n(t, {
      notification_id: `${PID}-n`,
      notification_status: "FAILED",
      notification_failure_details: {
        failure_reason: "Unable to Notify the Customer",
        failure_error_code: "PDN_FAILED",
      },
    });
    ok(
      `${t} → pre_debit_notice.updated sent / failed`,
      sent.type === "pre_debit_notice.updated" &&
        sent.preDebitNotice?.status === "sent" &&
        sent.preDebitNotice.notificationRef === `${PID}-n` &&
        refused.preDebitNotice?.status === "failed" &&
        refused.preDebitNotice.failureCode === "PDN_FAILED",
    );
  }
  ok(
    "an in-flight notice status is not news",
    n("SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS", {
      notification_id: "x",
      notification_status: "INITIALIZED",
    }).type === "unknown",
  );
  const exec = n("SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS", {
    execution_id: `${PID}-x`,
    execution_status: "SUCCESS",
    payment_id: PID,
    subscription_id: SID,
  });
  ok(
    "a controlled execution names the same charge as the payment webhook",
    exec.type === "charge.succeeded" && exec.providerChargeId === success.providerChargeId,
  );
  ok(
    "capturedAmountMinor: a controlled execution carries payment_amount; unset when absent",
    exec.capturedAmountMinor === undefined &&
      n("SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS", {
        execution_status: "SUCCESS",
        payment_id: PID,
        payment_amount: 1,
      }).capturedAmountMinor === 100n,
  );
  const execFail = n("SUBSCRIPTION_PAYMENT_CONTROLLED_EXECUTION_STATUS", {
    execution_status: "FAILED",
    payment_id: PID,
    failure_details: {
      failure_reason: "MANDATE HAS BEEN REVOKED",
      failure_error_code: "",
      failure_sub_error_code: "",
    },
  });
  ok(
    "a failed execution on a revoked mandate → mandate_expired, not retriable",
    execFail.type === "charge.failed" &&
      execFail.failureCode === "mandate_expired" &&
      execFail.failureRetriable === false,
  );
  ok(
    "an execution still running → charge.pending",
    n("SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS", { execution_status: "PENDING", payment_id: PID })
      .type === "charge.pending",
  );

  const subRefund = n("SUBSCRIPTION_REFUND_STATUS", {
    payment_id: PID,
    refund_id: "tmr_000000000000000000000001",
    refund_amount: 100.5,
    refund_status: "SUCCESS",
  });
  const rid = subRefundRef(PID, "tmr_000000000000000000000001");
  ok(
    "a subscription refund rebuilds the ids and books its own amount in refunds[], no running total",
    subRefund.type === "charge.refunded" &&
      subRefund.providerChargeId === subChargeRef(PID) &&
      subRefund.providerRefundId === rid &&
      subRefund.amountRefundedMinor === undefined &&
      JSON.stringify(subRefund.refunds, (_k, v) => (typeof v === "bigint" ? String(v) : v)) ===
        JSON.stringify([{ providerRefundId: rid, amountMinor: "10050", status: "succeeded" }]),
  );
  const noAmount = n("SUBSCRIPTION_REFUND_STATUS", {
    payment_id: PID,
    refund_id: "tmr_000000000000000000000002",
    refund_status: "SUCCESS",
  });
  ok(
    "a SUCCESS refund event without an amount is an error, never a full refund",
    !!noAmount.unresolved && noAmount.refunds === undefined,
  );
  const v2023 = n("SUBSCRIPTION_PAYMENT_FAILED", {
    payment_id: PID,
    payment_amount: 399.0,
    failureDetails: { failureReason: "Insufficient balance" },
    payment_status: "FAILED",
  });
  ok(
    "2023-08-01 failure reason (`failureDetails.failureReason`) and the payment amount are read",
    v2023.failureCode === "insufficient_funds" &&
      v2023.amountMinor === 39_900n &&
      n("SUBSCRIPTION_PAYMENT_SUCCESS", subData("SUCCESS")).amountMinor === 39_900n,
    `${v2023.failureCode} ${v2023.failureMessage} ${v2023.amountMinor}`,
  );
  ok(
    "a cancelled refund → refund.failed",
    n("SUBSCRIPTION_REFUND_STATUS", { payment_id: PID, refund_id: "r", refund_status: "CANCELLED" })
      .type === "refund.failed",
  );

  const order = {
    order_id: "tmo_000000000000000000000001",
    order_amount: 1180.0,
    order_currency: "INR",
    order_tags: { tmbilling_ref: "pi_XXXXXXXXXXXX01" },
  };
  const pgOk = n("PAYMENT_SUCCESS_WEBHOOK", {
    order,
    payment: {
      cf_payment_id: "1453995084705707520",
      payment_status: "SUCCESS",
      payment_amount: 1180.0,
    },
  });
  ok(
    "PG payment success → intent.authorized (captured) on the order, so the engine books it through the intent",
    pgOk.type === "intent.authorized" &&
      pgOk.captureState === "succeeded" &&
      pgOk.providerChargeId === "ord:tmo_000000000000000000000001:1453995084705707520" &&
      pgOk.providerIntentId === order.order_id &&
      pgOk.ownership === "ours",
  );
  // Measured 2026-10-30: an Indian card on a 1 USD order pays 95.16 INR; the order stays 1 USD.
  const converted = n("PAYMENT_SUCCESS_WEBHOOK", {
    order: { ...order, order_amount: 1, order_currency: "USD" },
    payment: { cf_payment_id: "1", payment_amount: 95.16, payment_currency: "INR" },
  });
  const jpy = n("PAYMENT_SUCCESS_WEBHOOK", {
    order: { ...order, order_amount: 1000, order_currency: "JPY" },
    payment: { cf_payment_id: "2", payment_amount: 1000, payment_currency: "JPY" },
  });
  ok(
    "capturedAmountMinor comes from the order: 118000 INR, 100 USD (not 9516 INR), 1000 JPY",
    pgOk.capturedAmountMinor === 118000n &&
      converted.capturedAmountMinor === 100n &&
      jpy.capturedAmountMinor === 1000n &&
      n("PAYMENT_SUCCESS_WEBHOOK", {
        order: { order_id: order.order_id },
        payment: { cf_payment_id: "3", payment_amount: 25, payment_currency: "USD" },
      }).capturedAmountMinor === undefined,
    `${pgOk.capturedAmountMinor} ${converted.capturedAmountMinor} ${jpy.capturedAmountMinor}`,
  );
  // Webhooks send cf_payment_id as a JSON number above 2^53; a double changes its digits.
  const bigBody = `{"data":{"order":{"order_id":"tmo_000000000000000000000002","order_amount":1,"order_currency":"USD","order_tags":{"tmbilling_ref":"pi_XXXXXXXXXXXX02"}},"payment":{"cf_payment_id":1469749760381710336,"payment_status":"SUCCESS","payment_amount":95.16,"payment_currency":"INR","payment_group":"credit_card"}},"event_time":"2026-10-30T23:11:10+05:30","type":"PAYMENT_SUCCESS_WEBHOOK"}`;
  const [big] = await cf.normalizeWebhook(sign(bigBody));
  ok(
    "a cf_payment_id above 2^53 keeps every digit (1469749760381710336, not …300)",
    big?.providerChargeId === "ord:tmo_000000000000000000000002:1469749760381710336" &&
      big.capturedAmountMinor === 100n &&
      String(JSON.parse(bigBody).data.payment.cf_payment_id) !== "1469749760381710336",
    big?.providerChargeId,
  );
  ok(
    "parseCashfreeJson: big integers become strings, amounts and short numbers stay numbers",
    JSON.stringify(
      parseCashfreeJson(
        '{"cf_refund_id":12345678901234567890,"refund_amount":10.5,"n":42,"s":"x"}',
      ),
    ) === '{"cf_refund_id":"12345678901234567890","refund_amount":10.5,"n":42,"s":"x"}',
  );
  const pgFail = n("PAYMENT_FAILED_WEBHOOK", {
    order: { ...order, order_tags: { other: "x" } },
    payment: { cf_payment_id: "1504280029", payment_status: "FAILED" },
    error_details: {
      error_code: "GATEWAY_ERROR",
      error_description: "Insufficient balance in account",
      error_reason: "insufficient_funds",
    },
  });
  ok(
    "PG payment failure → charge.failed, classified, untagged order reads foreign",
    pgFail.type === "charge.failed" &&
      pgFail.failureCode === "insufficient_funds" &&
      pgFail.ownership === "foreign",
  );
  const pgRefund = n("REFUND_STATUS_WEBHOOK", {
    refund: {
      cf_refund_id: 11325632,
      cf_payment_id: 789727431,
      refund_id: "tmr_000000000000000000000002",
      order_id: order.order_id,
      refund_amount: 2.0,
      refund_status: "SUCCESS",
    },
  });
  ok(
    "PG refund success → charge.refunded on the order payment",
    pgRefund.type === "charge.refunded" &&
      pgRefund.providerRefundId === `ordrf:${order.order_id}:tmr_000000000000000000000002` &&
      pgRefund.providerChargeId === `ord:${order.order_id}:789727431`,
  );
  ok(
    "auto refund that did not succeed → unknown (nothing to book)",
    n("AUTO_REFUND_STATUS_WEBHOOK", {
      auto_refund: {
        cf_refund_id: 1,
        cf_payment_id: "2",
        order_id: order.order_id,
        refund_status: "PENDING",
      },
    }).type === "unknown",
  );
  ok(
    "a dropped checkout and unknown types are persisted as unknown",
    n("PAYMENT_USER_DROPPED_WEBHOOK", { order }).type === "unknown" &&
      n("SUBSCRIPTION_CARD_EXPIRY_REMINDER", {}).type === "unknown",
  );
  ok(
    "no tag bag at all reads unknown, never foreign",
    n("SUBSCRIPTION_PAYMENT_SUCCESS", { payment_id: PID, payment_type: "CHARGE" }).ownership ===
      "unknown",
  );

  // ── B2. conformance fixes ─────────────────────────────────────────────────
  // Disputes: Cashfree takes the money on opening and returns it on a win.
  const od = { order_id: "tmo_000000000000000000000003", cf_payment_id: 885473311 };
  const dispute = (
    type: string,
    status: string,
    dtype = status.replace(/_[A-Z]+(_[A-Z]+)?$/, ""),
  ) =>
    normalizeCashfreeEvents(type, {
      dispute: {
        dispute_id: "433475258",
        dispute_type: dtype,
        dispute_amount: 3,
        dispute_status: status,
        dispute_amount_currency: "INR",
        respond_by: "2026-10-30T23:59:59+05:30",
      },
      order_details: od,
    });
  const types = (evs: { type: string }[]) => evs.map((e) => e.type).join(",");
  ok(
    "dispute created (DISPUTE / CHARGEBACK) → created + funds_withdrawn",
    types(dispute("DISPUTE_CREATED", "DISPUTE_CREATED")) ===
      "dispute.created,dispute.funds_withdrawn" &&
      types(dispute("DISPUTE_CREATED", "CHARGEBACK_CREATED")) ===
        "dispute.created,dispute.funds_withdrawn",
  );
  ok(
    "a retrieval request moves no money → created only",
    types(dispute("DISPUTE_CREATED", "RETRIEVAL_CREATED")) === "dispute.created",
  );
  ok(
    "an open update keeps the funds withdrawn (idempotent in the engine)",
    types(dispute("DISPUTE_UPDATED", "CHARGEBACK_DOCS_RECEIVED", "CHARGEBACK")) ===
      "dispute.created,dispute.funds_withdrawn",
  );
  ok(
    "*_MERCHANT_WON → won (funds reinstated)",
    types(dispute("DISPUTE_CLOSED", "CHARGEBACK_MERCHANT_WON", "CHARGEBACK")) === "dispute.won",
  );
  ok(
    "*_MERCHANT_LOST / *_MERCHANT_ACCEPTED / closed INSUFFICIENT_EVIDENCE → lost",
    types(dispute("DISPUTE_CLOSED", "CHARGEBACK_MERCHANT_LOST", "CHARGEBACK")) === "dispute.lost" &&
      types(dispute("DISPUTE_UPDATED", "DISPUTE_MERCHANT_ACCEPTED", "DISPUTE")) ===
        "dispute.lost" &&
      types(dispute("DISPUTE_CLOSED", "DISPUTE_INSUFFICIENT_EVIDENCE", "DISPUTE")) ===
        "dispute.lost",
  );
  ok(
    "INSUFFICIENT_EVIDENCE while open asks for documents again: still open",
    types(dispute("DISPUTE_UPDATED", "CHARGEBACK_INSUFFICIENT_EVIDENCE", "CHARGEBACK")) ===
      "dispute.created,dispute.funds_withdrawn",
  );
  ok(
    "*_REVERSAL → won",
    types(dispute("DISPUTE_UPDATED", "CHARGEBACK_REVERSAL", "CHARGEBACK")) === "dispute.won",
  );
  const preArb = dispute("DISPUTE_UPDATED", "PRE_ARBITRATION_CREATED", "PRE_ARBITRATION");
  const first = dispute("DISPUTE_CREATED", "CHARGEBACK_CREATED");
  ok(
    "pre-arbitration after a win is its own case and withdraws again",
    types(preArb) === "dispute.created,dispute.funds_withdrawn" &&
      preArb[0]!.providerDisputeId === "433475258:pre_arbitration" &&
      first[0]!.providerDisputeId === "433475258" &&
      preArb[0]!.providerChargeId === `ord:${od.order_id}:${od.cf_payment_id}`,
  );
  ok(
    "an unknown closing status is neutral",
    types(dispute("DISPUTE_CLOSED", "SOMETHING_NEW", "DISPUTE")) === "dispute.closed",
  );
  ok(
    "dispute fields: amount in paise, due date, the documented quoted status cleaned",
    first[0]!.disputeAmountMinor === 300n &&
      first[0]!.evidenceDueBy?.toISOString() === "2026-10-30T18:29:59.000Z" &&
      dispute("DISPUTE_CREATED", '"DISPUTE_CREATED"', "DISPUTE")[0]!.disputeStatus ===
        "DISPUTE_CREATED",
  );

  // A refused eNACH mandate: the failed authorization is the only notice.
  const rejectedAuth = normalizeCashfreeEvents("SUBSCRIPTION_AUTH_STATUS", {
    ...subData("FAILED", { payment_type: "AUTH" }),
    subscription_details: { subscription_id: SID, subscription_status: "INITIALIZED" },
    authorization_details: { payment_group: "enach", authorization_status: "FAILED" },
  });
  const rejectedPay = normalizeCashfreeEvents(
    "SUBSCRIPTION_PAYMENT_FAILED",
    subData("FAILED", {
      payment_type: "AUTH",
      subscription_details: { subscription_id: SID, subscription_status: "INITIALIZED" },
    }),
  );
  ok(
    "failed authorization → setup_failed + mandate_updated rejected (AUTH status and AUTH payment)",
    types(rejectedAuth) === "intent.setup_failed,payment_method.mandate_updated" &&
      rejectedAuth[1]!.providerPaymentMethodId === SID &&
      rejectedAuth[1]!.mandate?.status === "rejected" &&
      rejectedAuth[1]!.mandate?.rail === "enach" &&
      types(rejectedPay) === "intent.setup_failed,payment_method.mandate_updated",
  );
  ok(
    "an authorization still pending is not a rejection",
    types(
      normalizeCashfreeEvents("SUBSCRIPTION_AUTH_STATUS", {
        ...subData("PENDING", { payment_type: "AUTH" }),
        subscription_details: { subscription_id: SID, subscription_status: "INITIALIZED" },
      }),
    ) === "intent.setup_failed",
  );

  // The 25 h lead counts from the delivery Cashfree reports.
  const delivered = n("SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS", {
    notification_id: `${PID}-n`,
    notification_status: "SUCCESS",
    notification_completed_time: "2026-10-24T06:00:00+05:30",
  });
  ok(
    "notice SUCCESS → executableAfter = completed + 25 h, outside NPCI peak hours",
    delivered.preDebitNotice?.executableAfter?.toISOString() ===
      new Date("2026-10-25T07:00:00+05:30").toISOString() &&
      n("SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS", {
        notification_id: `${PID}-n`,
        notification_status: "SUCCESS",
        notification_completed_time: "2026-10-24T10:30:00+05:30",
      }).preDebitNotice?.executableAfter?.toISOString() ===
        new Date("2026-10-25T13:00:00+05:30").toISOString(),
  );
  const noticeFail = n("SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS", {
    notification_id: `${PID}-n`,
    notification_status: "FAILED",
    notification_failure_details: {
      failure_reason: "Notification attempt failed",
      failure_error_code: "",
      failure_sub_error_code: "PDN_XYZ",
    },
  });
  ok(
    "a failed notice keeps Cashfree's sub-code when it sends no code",
    noticeFail.preDebitNotice?.failureCode === "PDN_XYZ" &&
      noticeFail.preDebitNotice.failureMessage === "Notification attempt failed",
    JSON.stringify(noticeFail.preDebitNotice),
  );

  ok(
    "refund REJECTED → refund.failed (subscription and PG webhooks)",
    n("SUBSCRIPTION_REFUND_STATUS", { payment_id: PID, refund_id: "r", refund_status: "REJECTED" })
      .type === "refund.failed" &&
      n("REFUND_STATUS_WEBHOOK", {
        refund: { refund_id: "r", order_id: "tmo_x", cf_payment_id: 1, refund_status: "REJECTED" },
      }).type === "refund.failed",
  );
  ok(
    "PG error_reason codes are classified (invalid_vpa, expired_card, bank_offline)",
    normalizeCashfreeDecline({ code: "invalid_vpa" }).code === "payment_method_not_found" &&
      normalizeCashfreeDecline({ code: "expired_card" }).code === "expired_card" &&
      normalizeCashfreeDecline({ code: "bank_offline" }).code === "processing_error" &&
      n("PAYMENT_FAILED_WEBHOOK", {
        order: { order_id: "tmo_x" },
        payment: { cf_payment_id: 1 },
        error_details: { error_code: "VALIDATION_FAILURE", error_reason: "invalid_vpa" },
      }).failureCode === "payment_method_not_found",
  );
  const now0 = new Date(NOW);
  ok(
    "timing refusals: 'No successful notification' waits 1 h; a blackout names its time",
    notDueWaitMs({ message: "No successful notification for payment_id" }, now0) === 3_600_000 &&
      notDueWaitMs(
        {
          code: "payment_execution_restriction_error",
          message:
            "Execution not allowed in blackout window. Retry after 2026-10-24T13:00:00+05:30",
        },
        now0,
      ) ===
        90 * 60_000 &&
      // Measured in the sandbox, 2026-10-26.
      notDueWaitMs(
        {
          code: "payment_execution_error",
          message: "Payment attempt date cannot be before the scheduled date 2026-10-25",
        },
        now0,
      ) ===
        Date.parse("2026-10-25T00:00:00+05:30") - NOW,
  );
  ok(
    "any other refusal is not a timing refusal",
    notDueWaitMs(
      {
        code: "payment_execution_restriction_error",
        message: "Max number of executions for a payment reached",
      },
      now0,
    ) === undefined && notDueWaitMs({ message: "subscription not active" }, now0) === undefined,
  );
  ok(
    "the latest order payment is picked by time, not by list position",
    latestPayment([
      { cf_payment_id: 3, payment_time: "2026-10-24T10:00:00+05:30" },
      { cf_payment_id: 1, payment_time: "2026-10-24T09:00:00+05:30" },
    ])?.cf_payment_id === 3 &&
      latestPayment([{ cf_payment_id: "9" }, { cf_payment_id: "10" }])?.cf_payment_id === "10",
  );
  ok(
    "phone: +91 / 0 prefixes dropped; anything but 10 digits is refused",
    cashfreePhone("+91 99000 00000") === "9900000000" &&
      cashfreePhone("09900000000") === "9900000000" &&
      cashfreePhone("99000") === undefined &&
      cashfreePhone("+1 415 555 0100 9") === undefined,
  );

  // event ids
  const withKey = (k: string) => ({
    ...sign(body),
    headers: { ...sign(body).headers, "x-idempotency-key": k },
  });
  ok("x-idempotency-key is the event id", cf.webhookEventId(withKey("A5Uk+key=")) === "A5Uk+key=");
  const other = ev(
    "SUBSCRIPTION_PAYMENT_SUCCESS",
    subData("SUCCESS", { payment_id: cashfreePaymentId(SID, "inv_fixture_attempt_2") }),
  );
  ok(
    "without the header: stable on replay, distinct for another payment in the same second",
    cf.webhookEventId(sign(body)) === cf.webhookEventId(sign(body)) &&
      cf.webhookEventId(sign(body)) !== cf.webhookEventId(sign(other)),
  );
  ok(
    "normalizeWebhook stamps webhookEventId",
    good[0]!.providerEventId === cf.webhookEventId(sign(body)),
  );

  // ── C. declines ────────────────────────────────────────────────────────────
  const d = (message: string) => normalizeCashfreeDecline({ message });
  const table: [string, string, boolean][] = [
    [
      "DEBIT HAS BEEN FAILED | INSUFFICIENT FUNDS IN CUSTOMER (REMITTER) ACCOUNT",
      "insufficient_funds",
      true,
    ],
    ["Balance Insufficient", "insufficient_funds", true],
    ["ACCOUNT CLOSED", "bank_account_closed", false],
    ["DEBIT HAS BEEN FAILED | ACCOUNT DOES NOT EXIST (REMITTER)", "bank_account_not_found", false],
    ["Invalid UMRN or Inactive Mandate", "mandate_expired", false],
    ["Mandate Cancelled", "mandate_expired", false],
    ["Amount Exceeds E-mandate Limit", "mandate_ceiling_exceeded", true],
    [
      "U30|DEBIT HAS BEEN FAILED|QK|MANDATE REQUEST LIMIT HAS BREACHED",
      "mandate_cycle_limit_exceeded",
      true,
    ],
    ["DEBIT HAS BEEN FAILED | SUSPECTED FRAUD", "fraudulent", false],
    ["U67|DEBIT TIMEOUT|UT|REMITTER/ISSUER UNAVAILABLE (TIMEOUT)", "processing_error", true],
    [
      "U29|ADDRESS RESOLUTION IS FAILED|ZH|INVALID VIRTUAL ADDRESS",
      "payment_method_not_found",
      false,
    ],
    ["DEBIT HAS BEEN FAILED | Unable to Notify the Customer", "processing_error", true],
    ["something new", "charge_failed", true],
  ];
  for (const [msg, code, retriable] of table) {
    const r = d(msg);
    ok(
      `decline "${msg.slice(0, 48)}" → ${code}`,
      r.code === code && r.retriable === retriable,
      `${r.code}/${r.retriable}`,
    );
  }
  const ours = normalizeCashfreeDecline({
    code: "request_failed",
    message: "bad URL",
    category: "invalid_request_error",
  });
  ok(
    "an API refusal is ours, parks, and never blames the instrument",
    ours.code === "gateway_request_rejected" &&
      ours.retriable === true &&
      ours.exposedToPayer === false,
  );
  ok("the decline set is registered", DECLINE_SETS.cashfree.rules.length > 0);

  // ── D. capabilities and catalog ────────────────────────────────────────────
  const cap = cf.capabilities;
  ok(
    "pay now: INR, USD, EUR, GBP, AED, JPY (KWD and BHD are refused by Cashfree)",
    cap.currencies.join() === "INR,USD,EUR,GBP,AED,JPY" &&
      !cap.currencies.includes("KWD") &&
      !cap.currencies.includes("BHD"),
    cap.currencies.join(),
  );
  ok(
    "Cashfree's decimals match our exponent table (JPY 0, others 2)",
    Object.entries(CASHFREE_ORDER_EXPONENTS).every(([c, e]) => currencyExponent(c) === e) &&
      CASHFREE_ORDER_EXPONENTS.JPY === 0,
  );
  const defC = GATEWAYS.cashfree;
  ok(
    "catalog: intentCurrencies pins the adapter (payment = capabilities, setup = mandates)",
    defC.intentCurrencies?.payment?.join() === CASHFREE_ORDER_CURRENCIES.join() &&
      defC.intentCurrencies?.setup?.join() === CASHFREE_MANDATE_CURRENCIES.join(),
  );
  const cfRow = { gatewayKey: "cashfree", methodTypes: null };
  ok(
    "routing: USD pay now and USD / EUR setup offer cards only; JPY setup nothing; INR setup keeps all rails",
    effectiveMethodTypes(cfRow, "USD", "payment", {}).join() === "card" &&
      effectiveMethodTypes(cfRow, "JPY", "payment", {}).join() === "card" &&
      effectiveMethodTypes(cfRow, "USD", "setup", {}).join() === "card" &&
      effectiveMethodTypes(cfRow, "EUR", "setup", {}).join() === "card" &&
      effectiveMethodTypes(cfRow, "JPY", "setup", {}).length === 0 &&
      effectiveMethodTypes(cfRow, "CAD", "payment", {}).length === 0 &&
      effectiveMethodTypes(cfRow, "INR", "setup", {}).join() === "card,upi,bank_transfer",
    [
      effectiveMethodTypes(cfRow, "USD", "payment", {}).join(),
      effectiveMethodTypes(cfRow, "USD", "setup", {}).join(),
      effectiveMethodTypes(cfRow, "INR", "setup", {}).join(),
    ].join(" | "),
  );
  ok(
    "router: Cashfree is a candidate for USD pay now and a USD mandate, never a GBP mandate",
    gatewayAllowsPurpose("cashfree", "payment", "USD") &&
      gatewayAllowsPurpose("cashfree", "setup", "USD") &&
      !gatewayAllowsPurpose("cashfree", "setup", "GBP") &&
      gatewayAllowsPurpose("cashfree", "setup", "INR") &&
      !gatewayAllowsPurpose("cashfree", "payment", "KWD"),
  );
  ok(
    "preDebitNotice: UPI, 25 h lead, 1 debit per notice, exact amount",
    cap.preDebitNotice?.methods.join() === "upi" &&
      cap.preDebitNotice.minLeadHours === 25 &&
      cap.preDebitNotice.maxDebitsPerNotice === 1 &&
      cap.preDebitNotice.exactAmount === true,
  );
  ok(
    "Cashfree notifies the payer for card and eNACH",
    cap.gatewayNotifiesPayer?.join() === "card,bank_transfer",
  );
  ok(
    "mandates, intents (both purposes), status probe, no void, POST return",
    cap.mandates === true &&
      cap.intents === true &&
      cap.intentPurposes?.length === 2 &&
      cap.intentStatus === true &&
      cap.intentVoid === false &&
      cap.buyerReturnByPost === true,
  );
  ok("no settlement report is declared", cap.settlementReport === undefined);
  const def = GATEWAYS.cashfree;
  ok(
    "catalog: the endpoint's Secret Key is pasted in, URL registered by hand",
    def.webhook.secret === "operator_pasted" &&
      def.webhook
        .instructions("https://x.example.com/wh", "secret_in")
        .some((l) => l.includes("https://x.example.com/wh")),
  );
  ok(
    "catalog: advertised methods equal the adapter's",
    JSON.stringify([...def.advertisedMethods]) === JSON.stringify(cap.methods),
  );
  ok(
    "catalog: no customer ids, phone required, async settlement",
    def.noCustomerIds === true &&
      def.recurringNeedsPhone === true &&
      def.settlement.alwaysAsync === true,
  );
  ok(
    "factory: missing credentials are refused",
    throwsSync(() => GATEWAY_FACTORIES.cashfree.build({}, { businessId: "b", livemode: false })),
  );

  // ── E. request shapes (recorded fetch) ─────────────────────────────────────
  type Call = { url: string; method: string; headers: Record<string, string>; body: any };
  const calls: Call[] = [];
  let reply: (c: Call) => {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  } = () => ({ status: 200, body: {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const c: Call = {
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = reply(c);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...r.headers },
    });
  }) as typeof fetch;
  try {
    const hostOf = (livemode: boolean) => {
      calls.length = 0;
      return new CashfreeProvider({ appId: "a", secretKey: "s", livemode })
        .healthCheck()
        .then(() => calls[0]!.url);
    };
    ok("sandbox host for a test account", (await hostOf(false)).startsWith(CASHFREE_SANDBOX_BASE));
    ok("live host for a live account", (await hostOf(true)).startsWith(CASHFREE_LIVE_BASE));

    calls.length = 0;
    reply = () => ({
      status: 200,
      body: { subscription_session_id: "subs_session_x", subscription_status: "INITIALIZED" },
    });
    const setup = await cf.initiateVaultSetup({
      customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
      contact: { email: "payer@example.com", phone: "+91 99000 00000" },
      returnUrl: "https://shop.example.com/return",
      cancelUrl: "https://shop.example.com/cancel",
      methodTypes: ["upi"],
      currency: "INR",
      maxAmountMinor: 1_234_567n,
      ownershipRef: "cus_XXXXXXXXXXXX01",
    });
    const sb = calls[0]!.body;
    ok(
      "vault setup: ON_DEMAND subscription, ceiling in rupees, UPI rail, ₹1 auth, tags",
      calls[0]!.url.endsWith("/subscriptions") &&
        sb.plan_details.plan_type === "ON_DEMAND" &&
        sb.plan_details.plan_max_amount === 12345.67 &&
        sb.authorization_details.payment_methods.join() === "upi" &&
        sb.authorization_details.authorization_amount === 1 &&
        sb.customer_details.customer_phone === "9900000000" &&
        sb.subscription_tags.tmbilling_customer === "cus_XXXXXXXXXXXX01" &&
        sb.subscription_id === setup.setupTokenId,
    );
    ok(
      "vault setup: headers carry the API version and a UUID idempotency key",
      calls[0]!.headers["x-api-version"] === "2026-01-01" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          calls[0]!.headers["x-idempotency-key"]!,
        ),
    );
    ok(
      "vault setup: mode sdk, subscription session, sandbox",
      setup.mode === "sdk" &&
        setup.sdk?.provider === "cashfree" &&
        setup.sdk.params.kind === "subscription" &&
        setup.sdk.params.sessionId === "subs_session_x" &&
        setup.sdk.params.environment === "sandbox",
    );
    // USD / EUR card mandates (sandbox 2026-11-01); UPI and eNACH stay INR.
    const intlSetup = async (
      currency: string,
      methodTypes?: string[],
      phone = "+1 415 555 0100",
    ) => {
      calls.length = 0;
      reply = () => ({ status: 200, body: { subscription_session_id: "s" } });
      try {
        await cf.initiateVaultSetup({
          customer: { providerKey: "cashfree", providerCustomerId: "c" },
          returnUrl: "r",
          cancelUrl: "c",
          currency,
          maxAmountMinor: 5_000_000n,
          ...(methodTypes ? { methodTypes } : {}),
          contact: { email: "a@example.com", phone, name: "Test Payer" },
        });
        return calls[0]?.body;
      } catch (e) {
        return e as Error;
      }
    };
    const usdMandate = await intlSetup("USD");
    const eurCard = await intlSetup("EUR", ["card"], "+91 99000 00000");
    const usdUpi = await intlSetup("USD", ["card", "upi"]);
    const jpyMandate = await intlSetup("JPY", ["card"]);
    const usdBadPhone = await intlSetup("USD", ["card"], "12345");
    ok(
      "USD / EUR mandate: card only, plan in its currency, no INR cap, + phone kept",
      !(usdMandate instanceof Error) &&
        usdMandate?.plan_details.plan_currency === "USD" &&
        usdMandate.plan_details.plan_max_amount === 50000 &&
        JSON.stringify(usdMandate.authorization_details.payment_methods) === '["card"]' &&
        usdMandate.customer_details.customer_phone === "+14155550100" &&
        usdMandate.subscription_tags.psp_note === "Payments up to USD 50,000.00" &&
        !(eurCard instanceof Error) &&
        eurCard?.plan_details.plan_currency === "EUR" &&
        eurCard.customer_details.customer_phone === "9900000000",
      JSON.stringify(usdMandate instanceof Error ? usdMandate.message : usdMandate),
    );
    ok(
      "a USD UPI mandate, a JPY mandate and a bad phone are refused before any call",
      usdUpi instanceof ProviderRefusalError &&
        /INR only\. For a mandate in USD, select card/.test(usdUpi.message) &&
        jpyMandate instanceof ProviderRefusalError &&
        /mandates in INR, USD, EUR/.test(jpyMandate.message) &&
        usdBadPhone instanceof ProviderRefusalError &&
        /country code/.test(usdBadPhone.message) &&
        calls.length === 0,
      `${(usdUpi as Error)?.message} | ${(jpyMandate as Error)?.message}`,
    );

    const pmUpi = {
      providerKey: "cashfree" as const,
      providerPaymentMethodId: SID,
      display: { type: "upi" as const },
    };
    calls.length = 0;
    reply = () => ({
      status: 200,
      body: { notification_status: "INITIALIZED", cf_notification_id: "3333" },
    });
    const notice = await cf.notifyUpcomingDebit({
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: pmUpi,
      amountMinor: 39_900n,
      currency: "INR",
      debitAt: new Date(NOW + 24 * 3_600_000 + 600_000),
      idempotencyKey: "pdn:pm_x:39900:INR:collect:1",
    });
    const nb = calls[0]!.body;
    ok(
      "notice: notify-mandate with our payment id, rupees and a schedule date",
      calls[0]!.url.endsWith("/subscriptions/pay/controlled/notify-mandate") &&
        nb.payment_amount === 399 &&
        nb.subscription_id === SID &&
        subscriptionOfPaymentOk(nb.payment_id) &&
        nb.notification_id === `${nb.payment_id}-n` &&
        /^\d{4}-\d{2}-\d{2}T00:00:00\+05:30$/.test(nb.payment_schedule_date),
    );
    ok(
      "notice: accepted = sent, executable after 25 h and outside NPCI peak hours",
      notice.status === "sent" &&
        notice.notificationRef === nb.notification_id &&
        notice.executableAfter!.getTime() >= NOW + 25 * 3_600_000 &&
        nextUpiDebitWindow(notice.executableAfter!).getTime() ===
          notice.executableAfter!.getTime() &&
        notice.expiresAt! > notice.executableAfter!,
    );

    calls.length = 0;
    reply = () => ({
      status: 200,
      body: { execution_status: "INITIALIZED", payment_status: "INITIALIZED" },
    });
    const exec1 = await cf.charge({
      amountMinor: 39_900n,
      currency: "INR",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: pmUpi,
      idempotencyKey: "inv_x_attempt_1",
      preDebitNotice: {
        notificationRef: notice.notificationRef,
        amountMinor: 39_900n,
        debitNumber: 1,
      },
    });
    ok(
      "UPI with a notice: execute-mandate, pending, same charge id the webhooks build",
      calls[0]!.url.endsWith("/execute-mandate") &&
        calls[0]!.body.payment_id === nb.payment_id &&
        exec1.status === "pending" &&
        exec1.providerChargeId === subChargeRef(nb.payment_id),
    );

    calls.length = 0;
    reply = () => ({ status: 200, body: { payment_status: "INITIALIZED", cf_payment_id: "1" } });
    const card = await cf.charge({
      amountMinor: 150_000n,
      currency: "INR",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: { ...pmUpi, display: { type: "card" } },
      idempotencyKey: "inv_y_attempt_1",
    });
    ok(
      "card: Raise-a-Charge CHARGE, scheduled T+1, pending with nobody to act",
      calls[0]!.url.endsWith("/subscriptions/pay") &&
        calls[0]!.body.payment_type === "CHARGE" &&
        calls[0]!.body.payment_amount === 1500 &&
        calls[0]!.body.payment_schedule_date.startsWith(chargeScheduleDate(new Date(NOW))) &&
        card.status === "pending" &&
        card.nextAction?.data.approvalRequired === false,
    );
    reply = () => ({
      status: 200,
      body: {
        payment_status: "SUCCESS",
        cf_payment_id: "2",
        authorization_details: { payment_method: { upi: { upi_id: "x@upi" } } },
      },
    });
    const upiPaid = await cf.charge({
      amountMinor: 150_000n,
      currency: "INR",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: { ...pmUpi, display: { type: "card" } },
      idempotencyKey: "inv_y_attempt_2",
    });
    ok(
      "methodUsed: the payment's mandate rail, not the saved type",
      upiPaid.status === "succeeded" && upiPaid.methodUsed === "upi",
      String(upiPaid.methodUsed),
    );
    ok(
      "methodUsed: PG order payment_group, unknown stays unknown",
      cashfreeMethodUsed("credit_card").methodUsed === "card" &&
        cashfreeMethodUsed("net_banking").methodUsed === "bank_transfer" &&
        cashfreeMethodUsed("enach").methodUsed === "bank_transfer" &&
        cashfreeMethodUsed("pay_later").methodUsed === undefined,
    );
    calls.length = 0;
    await cf.charge({
      amountMinor: 100n,
      currency: "INR",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: { ...pmUpi, display: { type: "bank_transfer" } },
      idempotencyKey: "k3",
    });
    ok("eNACH: no schedule date", calls[0]!.body.payment_schedule_date === undefined);

    reply = () => ({
      status: 400,
      body: {
        message: "subscription not active",
        code: "request_failed",
        type: "invalid_request_error",
      },
    });
    const rejected = await cf.charge({
      amountMinor: 100n,
      currency: "INR",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: pmUpi,
      idempotencyKey: "k4",
    });
    ok(
      "a 400 is booked as our refusal through the rules",
      rejected.status === "failed" &&
        rejected.failure?.code === "gateway_request_rejected" &&
        rejected.failure.retriable === true,
    );
    reply = () => ({ status: 502, body: { message: "bad gateway" } });
    let indeterminate = false;
    try {
      await cf.charge({
        amountMinor: 100n,
        currency: "INR",
        customer: { providerKey: "cashfree", providerCustomerId: "c" },
        paymentMethod: pmUpi,
        idempotencyKey: "k5",
      });
    } catch (e) {
      indeterminate = e instanceof ProviderIndeterminateError;
    }
    ok("a 5xx on a charge is indeterminate, never a failure", indeterminate);
    const usd = await cf.charge({
      amountMinor: 100n,
      currency: "USD",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: pmUpi,
      idempotencyKey: "k6",
    });
    const pmUsdCard = {
      providerKey: "cashfree" as const,
      providerPaymentMethodId: SID,
      display: { type: "card" as const },
      mandate: { currency: "USD" },
    };
    const onEur = await cf.charge({
      amountMinor: 100n,
      currency: "EUR",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: pmUsdCard,
      idempotencyKey: "k6b",
    });
    ok(
      "a USD debit on a UPI mandate, or EUR on a USD mandate, is refused locally",
      usd.status === "failed" &&
        usd.failure?.retriable === false &&
        onEur.status === "failed" &&
        /is in USD/.test(onEur.failure?.message ?? ""),
      `${usd.failure?.message} | ${onEur.failure?.message}`,
    );
    calls.length = 0;
    reply = () => ({ status: 200, body: { payment_status: "PENDING", cf_payment_id: "1" } });
    const usdCard = await cf.charge({
      amountMinor: 250n,
      currency: "USD",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: pmUsdCard,
      idempotencyKey: "k6c",
    });
    ok(
      "a USD debit on a USD card mandate is raised in dollars and pending",
      usdCard.status === "pending" &&
        calls[0]?.body.payment_amount === 2.5 &&
        calls[0]?.body.payment_type === "CHARGE",
      JSON.stringify(calls[0]?.body),
    );
    // Audit C1 (adapter end): a mandate with no currency on record is INR, never "any".
    calls.length = 0;
    const noCurrency = await cf.charge({
      amountMinor: 5000n,
      currency: "USD",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: {
        providerKey: "cashfree",
        providerPaymentMethodId: SID,
        display: { type: "card" },
      },
      idempotencyKey: "k6d",
    });
    // Audit L1: below 1 USD is refused locally (orders refuse it at Cashfree, measured).
    const tooSmall = await cf.charge({
      amountMinor: 50n,
      currency: "USD",
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: pmUsdCard,
      idempotencyKey: "k6e",
    });
    ok(
      "C1/L1: USD on a mandate with no currency on record (= INR), and 0.50 USD on a USD mandate, are refused before any call",
      noCurrency.status === "failed" &&
        /is in INR\. We cannot debit it in USD/.test(noCurrency.failure?.message ?? "") &&
        tooSmall.status === "failed" &&
        /at least 1 USD/.test(tooSmall.failure?.message ?? "") &&
        calls.length === 0,
      `${noCurrency.failure?.message} | ${tooSmall.failure?.message}`,
    );
    // Audit L3: Cashfree's own notice is confirmed for INR only, so USD/EUR card payers get ours.
    ok(
      "L3: Cashfree notifies an INR card or eNACH payer itself; a USD or EUR card payer gets our pre-debit email",
      gatewayNotifiesPayerOf(cf.capabilities, "card", "INR") &&
        gatewayNotifiesPayerOf(cf.capabilities, "bank_transfer", "INR") &&
        !gatewayNotifiesPayerOf(cf.capabilities, "card", "USD") &&
        !gatewayNotifiesPayerOf(cf.capabilities, "card", "EUR") &&
        !gatewayNotifiesPayerOf(cf.capabilities, "upi", "INR"),
    );
    // Audit L2: a number without + on a USD or EUR mandate is read in the customer's country.
    const geo = JSON.parse(readFileSync("db/seed-data/geo.json", "utf8"));
    primeGeoReference({
      countries: geo.countries,
      subdivisions: geo.subdivisions,
      aliases: geo.aliases ?? [],
    });
    const noCountry = await intlSetup("USD", ["card"], "4155550100");
    ok(
      "L2: a foreign mandate phone without + takes the customer's country, never India; no country = refused",
      cashfreeForeignPhone("4155550100", "US") === "+14155550100" &&
        cashfreeForeignPhone("14155550100", "US") === "+14155550100" &&
        cashfreeForeignPhone("030 1234567", "DE") === "+49301234567" &&
        cashfreeForeignPhone("+44 7700 900123", null) === "+447700900123" &&
        cashfreeForeignPhone("9900000000", "IN") === "9900000000" &&
        cashfreeForeignPhone("4155550100", null) === undefined &&
        cashfreeForeignPhone("12", "US") === undefined &&
        noCountry instanceof ProviderRefusalError &&
        /country code/.test(noCountry.message),
      `${cashfreeForeignPhone("030 1234567", "DE")} | ${(noCountry as Error)?.message}`,
    );
    // Audit M2: an India-issued card on a USD or EUR mandate is refused, and the mandate cancelled.
    const indianUsd = {
      subscription_id: SID,
      subscription_status: "ACTIVE",
      subscription_tags: { tmbilling_customer: "c" },
      plan_details: { plan_currency: "USD", plan_max_amount: 50 },
      authorization_details: {
        authorization_status: "ACTIVE",
        payment_method: {
          card: { card_country: "IN", card_network: "VISA", card_number: "XXXX1111" },
        },
      },
    };
    calls.length = 0;
    reply = (c) =>
      c.method === "GET" ? { status: 200, body: indianUsd } : { status: 200, body: {} };
    const m2consume = (await cf.consumeIntent({ purpose: "setup", intentId: SID } as never)) as {
      purpose: string;
      paymentMethod?: unknown;
      failure?: { message?: string };
    };
    const m2cancels = calls.filter((c) => c.method === "POST" && c.url.endsWith("/manage")).length;
    ok(
      "M2: an India-issued card on a USD mandate is refused at setup and the mandate is cancelled; INR or a foreign card is not",
      m2consume.purpose === "setup" &&
        !m2consume.paymentMethod &&
        /bank in India issued/.test(m2consume.failure?.message ?? "") &&
        m2cancels === 1 &&
        cashfreeIndianCardProblem({
          ...indianUsd,
          plan_details: { plan_currency: "INR" },
        } as never) === undefined &&
        cashfreeIndianCardProblem({
          ...indianUsd,
          authorization_details: { payment_method: { card: { card_country: "US" } } },
        } as never) === undefined,
      `${m2consume.failure?.message} | cancels ${m2cancels}`,
    );

    const debit = (key: string) =>
      cf
        .charge({
          amountMinor: 100n,
          currency: "INR",
          customer: { providerKey: "cashfree", providerCustomerId: "c" },
          paymentMethod: pmUpi,
          idempotencyKey: key,
        })
        .catch((e: Error) => e);
    const posts = () => calls.filter((c) => c.method === "POST");
    calls.length = 0;
    reply = (c) =>
      c.method === "GET"
        ? { status: 404, body: { message: "payment not found" } }
        : { status: 409, body: { code: "payment_already_exists", message: "already present" } };
    const conflict = await debit("k7");
    ok(
      "a 409 on a debit is retried with the same key, then read by our id, then indeterminate",
      conflict instanceof ProviderIndeterminateError &&
        posts().length === 3 &&
        new Set(posts().map((c) => c.headers["x-idempotency-key"])).size === 1 &&
        calls.at(-1)!.method === "GET",
      `${(conflict as Error).name} posts ${posts().length}`,
    );
    calls.length = 0;
    let limits = 0;
    reply = () =>
      limits++ < 1
        ? {
            status: 429,
            body: { type: "rate_limit_error", message: "Too many requests" },
            headers: { "x-ratelimit-retry": "1" },
          }
        : { status: 200, body: { payment_status: "PENDING" } };
    const t0 = Date.now();
    const limited = await debit("k8");
    ok(
      "a 429 waits x-ratelimit-retry, then the same key goes through",
      !(limited instanceof Error) &&
        limited.status === "pending" &&
        posts().length === 2 &&
        Date.now() - t0 >= 900,
    );
    calls.length = 0;
    reply = (c) => {
      if (c.method === "POST") throw new TypeError("fetch failed");
      return { status: 200, body: { payment_status: "PENDING" } };
    };
    const lostFound = await debit("k9");
    ok(
      "no answer on the debit: the payment our id names answers instead",
      !(lostFound instanceof Error) &&
        lostFound.status === "pending" &&
        lostFound.providerChargeId ===
          subChargeRef(cashfreePaymentId(pmUpi.providerPaymentMethodId, "k9")) &&
        posts().length === 3,
    );

    const located = cashfreePaymentId(SID, "k10");
    reply = (c) =>
      c.url.endsWith(`/payments/${located}`)
        ? { status: 200, body: { payment_id: located, payment_status: "SUCCESS" } }
        : { status: 404, body: { message: "payment not found" } };
    const found = await cf.locateCharge({
      idempotencyKey: "k10",
      paymentMethod: { providerPaymentMethodId: SID },
    });
    const none = await cf.locateCharge({
      idempotencyKey: "k11",
      paymentMethod: { providerPaymentMethodId: SID },
    });
    const noMandate = await cf.locateCharge({ idempotencyKey: "k10" }).catch((e: Error) => e);
    ok(
      "locateCharge reads the payment our id names: found, none (null), cannot ask (throws)",
      found?.status === "succeeded" &&
        found.providerChargeId === subChargeRef(located) &&
        none === null &&
        noMandate instanceof Error,
    );

    reply = () => ({ status: 404, body: {} });
    const delivery = (v: string | null, type: string) => ({
      headers: v ? { "x-webhook-version": v } : ({} as Record<string, string>),
      payload: { type },
    });
    const health = (recent: Parameters<typeof cf.healthCheck>[0]) => cf.healthCheck(recent);
    const right = await health({
      recentWebhooks: [
        delivery("2026-01-01", "SUBSCRIPTION_PAYMENT_SUCCESS"),
        delivery("2025-01-01", "REFUND_STATUS_WEBHOOK"),
      ],
    });
    const unknownV = await health({
      recentWebhooks: [delivery("2099-01-01", "SUBSCRIPTION_PAYMENT_SUCCESS")],
    });
    const wrongTab = await health({
      recentWebhooks: [delivery("2026-01-01", "PAYMENT_SUCCESS_WEBHOOK")],
    });
    const nothingYet = await health({ recentWebhooks: [] });
    const notRead = await cf.healthCheck();
    const row = (r: typeof right) => r.checks?.find((x) => x.key === "webhook_version");
    ok(
      "health check: the webhook version row warns on an unread or off-tab version",
      right.ok &&
        row(right)?.status === "ok" &&
        !unknownV.ok &&
        row(unknownV)?.status === "failed" &&
        /2099-01-01/.test(row(unknownV)!.message) &&
        (row(unknownV)!.steps ?? []).join(" ").includes("2025-01-01") &&
        (row(unknownV)!.steps ?? []).join(" ").includes("2026-01-01") &&
        !wrongTab.ok &&
        /Select version 2025-01-01/.test(row(wrongTab)!.message) &&
        row(nothingYet)?.status === "unchecked" &&
        nothingYet.ok &&
        notRead.checks === undefined,
      JSON.stringify([row(right), row(unknownV), row(wrongTab)]),
    );

    calls.length = 0;
    reply = (c) => ({
      status: 200,
      body:
        c.method === "GET"
          ? { payment_amount: 399.0, authorization_details: { payment_group: "upi" } }
          : { refund_status: "PENDING" },
    });
    const rf = await cf.refund({
      providerChargeId: subChargeRef(PID),
      idempotencyKey: "re_x",
      reason: "SUCCESS",
    });
    const rb = calls[1]!.body;
    ok(
      "refund: full amount read back, STANDARD on UPI, id the webhook rebuilds",
      rb.refund_amount === 399 &&
        rb.refund_speed === "STANDARD" &&
        rb.payment_id === PID &&
        rf.status === "pending" &&
        rf.providerRefundId === subRefundRef(PID, rb.refund_id),
    );

    // A USD card mandate payment refunds in USD; another currency, or under 1 USD, is refused locally.
    calls.length = 0;
    reply = (c) => ({
      status: 200,
      body:
        c.method === "GET"
          ? {
              payment_amount: 2,
              payment_currency: "USD",
              authorization_details: { payment_group: "card" },
            }
          : { refund_status: "PENDING" },
    });
    await cf.refund({
      providerChargeId: subChargeRef(PID),
      idempotencyKey: "re_usd",
      amountMinor: 100n,
      currency: "USD",
      reason: "Partial",
    });
    const subUsdRefund = calls.find((c) => c.method === "POST")?.body;
    calls.length = 0;
    const subUnderOne = await cf
      .refund({
        providerChargeId: subChargeRef(PID),
        idempotencyKey: "re_usd_small",
        amountMinor: 50n,
        currency: "USD",
      })
      .catch((e) => e);
    const underOnePosted = calls.some((c) => c.method === "POST");
    const subInrOnUsd = await cf
      .refund({
        providerChargeId: subChargeRef(PID),
        idempotencyKey: "re_usd_inr",
        amountMinor: 50n,
        currency: "INR",
      })
      .catch((e) => e);
    ok(
      "USD mandate refund: 1 USD sent; under 1 USD and an INR refund are refused before any POST",
      subUsdRefund?.refund_amount === 1 &&
        subUnderOne instanceof ProviderRefusalError &&
        /at least 1 USD/.test(subUnderOne.message) &&
        !underOnePosted &&
        subInrOnUsd instanceof ProviderRefusalError &&
        /is in USD/.test(subInrOnUsd.message),
      `${JSON.stringify(subUsdRefund)} | ${subUnderOne?.message} | posted ${underOnePosted} | ${subInrOnUsd?.message}`,
    );

    // Two partial refunds on one order payment (₹10 of ₹100, then ₹5); the second
    // webhook arrives alone. The engine reads `amountRefundedMinor` as the running total.
    const OID = "tmo_000000000000000000000009";
    const refundEvent = (rid: string, amount: number) =>
      sign(
        ev("REFUND_STATUS_WEBHOOK", {
          refund: {
            cf_payment_id: 7001,
            refund_id: rid,
            order_id: OID,
            refund_amount: amount,
            refund_currency: "INR",
            refund_status: "SUCCESS",
          },
        }),
      );
    const listed = [
      { refund_id: "tmr_a", cf_payment_id: 7001, refund_amount: 10.0, refund_status: "SUCCESS" },
      { refund_id: "tmr_b", cf_payment_id: 7001, refund_amount: 5.0, refund_status: "SUCCESS" },
      { refund_id: "tmr_c", cf_payment_id: 7001, refund_amount: 50.0, refund_status: "PENDING" },
      { refund_id: "tmr_d", cf_payment_id: 9999, refund_amount: 20.0, refund_status: "SUCCESS" },
    ];
    // The order is read first (its currency decides), then its refund list.
    const INR_ORDER = { order_amount: 100, order_currency: "INR" };
    const withOrder =
      (list: unknown, order: unknown = INR_ORDER) =>
      (c: Call) => ({ status: 200, body: c.url.endsWith("/refunds") ? list : order });
    calls.length = 0;
    reply = withOrder(listed);
    const second = (await cf.normalizeWebhook(refundEvent("tmr_b", 5.0)))[0]!;
    ok(
      "second partial refund: total = both SUCCESS refunds of that payment (₹15), read from the order's refund list",
      second.type === "charge.refunded" &&
        second.amountRefundedMinor === 1_500n &&
        calls.some((c) => c.url.endsWith(`/orders/${OID}/refunds`)),
      String(second.amountRefundedMinor),
    );
    reply = withOrder(listed.filter((x) => x.refund_id !== "tmr_b"));
    const lagging = (await cf.normalizeWebhook(refundEvent("tmr_b", 5.0)))[0]!;
    ok(
      "the list lags the webhook: the settled refund is still counted (₹15)",
      lagging.amountRefundedMinor === 1_500n,
      String(lagging.amountRefundedMinor),
    );
    reply = (c) =>
      c.url.endsWith("/refunds")
        ? { status: 500, body: { message: "down" } }
        : { status: 200, body: INR_ORDER };
    const down = (await cf.normalizeWebhook(refundEvent("tmr_b", 5.0)))[0]!;
    ok(
      "the list cannot be read: unresolved (redelivered), never ₹5 or a full refund posing as the total",
      down.type === "charge.refunded" &&
        down.amountRefundedMinor === undefined &&
        !!down.unresolved,
    );
    reply = () => {
      throw new Error("network down");
    };
    const offline = (await cf.normalizeWebhook(refundEvent("tmr_b", 5.0)))[0]!;
    ok(
      "no connection (order unreadable): unresolved, no total",
      offline.amountRefundedMinor === undefined && !!offline.unresolved,
    );
    reply = withOrder({ text: "not a list" }, { order_currency: "JPY", order_amount: 1000 });
    const jpyHalf = (
      await cf.normalizeWebhook(
        sign(
          ev("REFUND_STATUS_WEBHOOK", {
            refund: {
              cf_payment_id: 7001,
              refund_id: "tmr_j",
              order_id: OID,
              refund_amount: 10.5,
              refund_currency: "JPY",
              refund_status: "SUCCESS",
            },
          }),
        ),
      )
    )[0]!;
    reply = withOrder([], { order_currency: "USD", order_amount: 1 });
    const inrOnUsd = (
      await cf.normalizeWebhook(
        sign(
          ev("REFUND_STATUS_WEBHOOK", {
            refund: {
              cf_payment_id: 7001,
              refund_id: "tmr_i",
              order_id: OID,
              refund_amount: 47.58,
              refund_currency: "INR",
              refund_status: "SUCCESS",
            },
          }),
        ),
      )
    )[0]!;
    reply = withOrder(
      [
        {
          refund_id: "tmr_x",
          cf_payment_id: 7001,
          refund_amount: 47.58,
          refund_currency: "INR",
          refund_status: "SUCCESS",
        },
      ],
      { order_currency: "USD", order_amount: 1 },
    );
    const inrInList = (
      await cf.normalizeWebhook(
        sign(
          ev("REFUND_STATUS_WEBHOOK", {
            refund: {
              cf_payment_id: 7001,
              refund_id: "tmr_u",
              order_id: OID,
              refund_amount: 0.1,
              refund_currency: "USD",
              refund_status: "SUCCESS",
            },
          }),
        ),
      )
    )[0]!;
    ok(
      "unresolved, never a guessed total: 10.5 JPY, an INR refund on a USD order, an INR refund in the list",
      [jpyHalf, inrOnUsd, inrInList].every(
        (e) => !!e.unresolved && e.amountRefundedMinor === undefined,
      ),
      [jpyHalf, inrOnUsd, inrInList]
        .map((e) => e.unresolved ?? String(e.amountRefundedMinor))
        .join(" | "),
    );
    reply = withOrder([]);
    const first = (await cf.normalizeWebhook(refundEvent("tmr_a", 10.0)))[0]!;
    ok(
      "first refund, empty list so far: total = that refund (₹10)",
      first.amountRefundedMinor === 1_000n,
    );
    // A USD order: the event names no currency, so the order's is read; amounts are cents.
    calls.length = 0;
    reply = (c) => ({
      status: 200,
      body: c.url.endsWith("/refunds")
        ? [
            {
              refund_id: "tmr_u1",
              cf_payment_id: 7001,
              refund_amount: 0.5,
              refund_status: "SUCCESS",
            },
          ]
        : { order_amount: 1, order_currency: "USD" },
    });
    const usdRefund = (
      await cf.normalizeWebhook(
        sign(
          ev("REFUND_STATUS_WEBHOOK", {
            refund: {
              cf_payment_id: 7001,
              refund_id: "tmr_u2",
              order_id: OID,
              refund_amount: 0.25,
              refund_status: "SUCCESS",
            },
          }),
        ),
      )
    )[0]!;
    ok(
      "USD order refund without refund_currency: the order's currency is read, total 75 cents",
      usdRefund.amountRefundedMinor === 75n && calls.some((c) => c.url.endsWith(`/orders/${OID}`)),
      String(usdRefund.amountRefundedMinor),
    );

    // Auto refund (Cashfree's documented 2025-01-01 shape): no merchant refund_id.
    const autoEvent = () =>
      sign(
        ev("AUTO_REFUND_STATUS_WEBHOOK", {
          auto_refund: {
            event: "AUTO-REFUND",
            cf_refund_id: 1243460973,
            cf_payment_id: "7001",
            order_id: OID,
            refund_amount: 100,
            refund_currency: "INR",
            refund_type: "PAYMENT_AUTO_REFUND",
            refund_status: "SUCCESS",
            refund_reason: "Multiple payments were performed against same order.",
          },
        }),
      );
    reply = withOrder([]);
    const auto = (await cf.normalizeWebhook(autoEvent()))[0]!;
    ok(
      "auto refund → charge.refunded on that order payment, own refund id, total = its amount",
      auto.type === "charge.refunded" &&
        auto.providerChargeId === `ord:${OID}:7001` &&
        auto.providerRefundId === `ordrf:${OID}:auto-1243460973` &&
        auto.amountRefundedMinor === 10_000n,
      `${auto.providerRefundId} ${auto.amountRefundedMinor}`,
    );
    ok(
      "auto refund: the dedupe id names the Cashfree refund",
      auto.providerEventId.includes("auto-1243460973"),
      auto.providerEventId,
    );
    reply = withOrder([
      {
        cf_refund_id: 1243460973,
        cf_payment_id: 7001,
        refund_amount: 100,
        refund_status: "SUCCESS",
      },
    ]);
    const autoListed = (await cf.normalizeWebhook(autoEvent()))[0]!;
    ok(
      "auto refund already in the order's list: counted once (₹100)",
      autoListed.amountRefundedMinor === 10_000n,
      String(autoListed.amountRefundedMinor),
    );
    reply = (c) =>
      c.url.endsWith("/refunds")
        ? { status: 500, body: { message: "down" } }
        : { status: 200, body: INR_ORDER };
    const autoDown = (await cf.normalizeWebhook(autoEvent()))[0]!;
    reply = () => ({ status: 500, body: { message: "down" } });
    const autoNoOrder = (await cf.normalizeWebhook(autoEvent()))[0]!;
    ok(
      "auto refund, list unreadable: the whole payment it returned is the total; order unreadable: unresolved",
      autoDown.amountRefundedMinor === 10_000n && !!autoNoOrder.unresolved,
    );

    // Disputes are booked in the order's currency.
    const dz = (dispute: Record<string, unknown>, od: Record<string, unknown>) =>
      normalizeCashfreeEvents("DISPUTE_CREATED", {
        dispute: { dispute_id: 4001, dispute_status: "CHARGEBACK_CREATED", ...dispute },
        order_details: { order_id: "tmo_000000000000000000000079", cf_payment_id: 1, ...od },
      })[0]!;
    const converted = {
      order_amount: 1,
      order_currency: "USD",
      payment_amount: 95.16,
      payment_currency: "INR",
    };
    const dInr = dz({ dispute_amount: 95.16, dispute_amount_currency: "INR" }, converted);
    const dEur = dz({ dispute_amount: 1, dispute_amount_currency: "EUR" }, converted);
    const dBlank = dz(
      { dispute_amount: 1000, dispute_amount_currency: "" },
      { order_amount: 1000, order_currency: "JPY" },
    );
    const dNone = dz({ dispute_amount: 5 }, {});
    const dHalf = dz({ dispute_amount: 47.58, dispute_amount_currency: "INR" }, converted);
    ok(
      "dispute on a converted payment → order money (95.16 INR → 100 USD cents, 47.58 → 50); other currency, no currency → unresolved; blank → order's",
      dInr.disputeAmountMinor === 100n &&
        dInr.disputeCurrency === "USD" &&
        dHalf.disputeAmountMinor === 50n &&
        !!dEur.unresolved &&
        dEur.disputeAmountMinor === undefined &&
        dBlank.disputeAmountMinor === 1000n &&
        dBlank.disputeCurrency === "JPY" &&
        !!dNone.unresolved,
      JSON.stringify([dInr, dHalf, dEur.unresolved, dBlank, dNone.unresolved], (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      ),
    );

    // ── E2. conformance fixes, request shapes ─────────────────────────────────
    ok(
      "every call carries an x-request-id",
      calls.length > 0 &&
        calls.every((c) => /^[0-9a-f-]{36}$/.test(c.headers["x-request-id"] ?? "")),
    );

    // Mandate ceiling: card and UPI capped at ₹15,000 without AFA; eNACH keeps ₹1 crore.
    const ceilingFor = async (methodTypes: string[] | undefined, maxAmountMinor: bigint) => {
      calls.length = 0;
      reply = () => ({ status: 200, body: { subscription_session_id: "s" } });
      await cf.initiateVaultSetup({
        customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
        contact: { email: "payer@example.com", phone: "9900000000", name: "Al" },
        returnUrl: "r",
        cancelUrl: "c",
        currency: "INR",
        maxAmountMinor,
        ...(methodTypes ? { methodTypes } : {}),
      });
      return calls[0]!.body;
    };
    const upiBig = await ceilingFor(["upi"], 5_000_000n);
    const cardBig = await ceilingFor(["card"], 5_000_000n);
    const mixedBig = await ceilingFor(["card", "upi"], 5_000_000n);
    const enachBig = await ceilingFor(["bank_transfer"], 5_000_000n);
    const anyBig = await ceilingFor(undefined, 5_000_000n);
    ok(
      "ceiling: card / UPI capped at ₹15,000; eNACH and an open choice keep ₹50,000",
      CASHFREE_CARD_UPI_MANDATE_MAX_MINOR === 1_500_000n &&
        upiBig.plan_details.plan_max_amount === 15000 &&
        cardBig.plan_details.plan_max_amount === 15000 &&
        mixedBig.plan_details.plan_max_amount === 15000 &&
        enachBig.plan_details.plan_max_amount === 50000 &&
        anyBig.plan_details.plan_max_amount === 50000,
    );
    ok(
      "mandate: a 2-letter name is left out; psp_note names the ceiling, no internal id",
      upiBig.customer_details.customer_name === undefined &&
        upiBig.subscription_tags.psp_note === "Payments up to ₹15,000.00",
      upiBig.subscription_tags.psp_note,
    );
    let phoneRefusal = "";
    try {
      await cf.initiateVaultSetup({
        customer: { providerKey: "cashfree", providerCustomerId: "c" },
        contact: { email: "payer@example.com", phone: "12345" },
        returnUrl: "r",
        cancelUrl: "c",
        currency: "INR",
      });
    } catch (e) {
      phoneRefusal = (e as Error).message;
    }
    ok(
      "a phone that is not 10 digits is refused with a readable message, before any call",
      /10-digit mobile number/.test(phoneRefusal),
      phoneRefusal,
    );

    // The notice shows the invoice number, never our internal id.
    calls.length = 0;
    reply = () => ({ status: 200, body: { notification_status: "INITIALIZED" } });
    await cf.notifyUpcomingDebit({
      customer: { providerKey: "cashfree", providerCustomerId: "c" },
      paymentMethod: pmUpi,
      amountMinor: 39_900n,
      currency: "INR",
      debitAt: new Date(NOW + 26 * 3_600_000),
      idempotencyKey: "pdn:pm_x:39900:INR:collect:2",
      ownershipRef: "pdn_XXXXXXXXXXXX01",
      description: "Invoice INV-0001",
    });
    ok(
      "notice: payment_remarks = the invoice (spaces become hyphens), not the notice's internal id",
      calls[0]!.body.payment_remarks === "Invoice-INV-0001",
      calls[0]!.body.payment_remarks,
    );

    // Before the debit: read the notice and count 25 h from its delivery.
    const check = async (body: unknown, status = 200) => {
      calls.length = 0;
      reply = () => ({ status, body });
      return cf.checkPreDebitNotice({
        paymentMethod: pmUpi,
        notificationRef: `${PID}-n`,
        now: new Date(NOW),
      });
    };
    const fresh = await check({
      notification_status: "SUCCESS",
      notification_completed_time: "2026-10-24T06:00:00+05:30",
    });
    ok(
      "check: reads GET /subscriptions/payments/{pid}/controlled/notifications/{nid}",
      calls[0]!.method === "GET" &&
        calls[0]!.url.endsWith(`/subscriptions/payments/${PID}/controlled/notifications/${PID}-n`),
      calls[0]!.url,
    );
    ok(
      "check: delivered at 06:00 IST → sent, not before 07:00 IST the next day",
      fresh.status === "sent" &&
        fresh.executableAfter?.toISOString() ===
          new Date("2026-10-25T07:00:00+05:30").toISOString(),
    );
    const due = await check({
      notification_status: "SUCCESS",
      notification_completed_time: "2026-10-22T06:00:00+05:30",
    });
    ok(
      "check: a notice delivered long ago, now inside NPCI peak hours (11:30 IST) → wait for 13:00",
      due.status === "sent" &&
        due.executableAfter?.toISOString() === new Date("2026-10-24T13:00:00+05:30").toISOString(),
    );
    const inDelivery = await check({ notification_status: "INITIALIZED" });
    const failedCheck = await check({
      notification_status: "FAILED",
      notification_failure_details: {
        failure_reason: "Notification attempt failed",
        failure_sub_error_code: "E1",
      },
    });
    const missing = await check({ message: "not found" }, 404);
    ok(
      "check: in delivery → pending; FAILED → failed with the sub-code; unknown → failed",
      inDelivery.status === "pending" &&
        failedCheck.status === "failed" &&
        failedCheck.failureCode === "E1" &&
        missing.status === "failed",
      JSON.stringify(failedCheck),
    );

    // A timing refusal is not a decline: the engine keeps the notice.
    const exec = async (body: unknown) => {
      reply = () => ({ status: 400, body });
      return cf.charge({
        amountMinor: 39_900n,
        currency: "INR",
        customer: { providerKey: "cashfree", providerCustomerId: "c" },
        paymentMethod: pmUpi,
        idempotencyKey: "inv_z_attempt_1",
        preDebitNotice: { notificationRef: `${PID}-n`, amountMinor: 39_900n, debitNumber: 1 },
      });
    };
    const blackout = await exec({
      code: "payment_execution_restriction_error",
      type: "invalid_request_error",
      message: "Execution not allowed in blackout window. Retry after 2026-10-24T13:00:00+05:30",
    });
    const maxed = await exec({
      code: "payment_execution_restriction_error",
      type: "invalid_request_error",
      message: "Max number of executions for a payment reached",
    });
    ok(
      "execution refused as too early → pre_debit_not_due with the wait it names",
      blackout.status === "failed" &&
        blackout.failure?.code === PRE_DEBIT_NOT_DUE_CODE &&
        blackout.failure.retryAfterMs === 90 * 60_000 &&
        maxed.failure?.code === "gateway_request_rejected",
      `${blackout.failure?.code} ${blackout.failure?.retryAfterMs} ${maxed.failure?.code}`,
    );

    // eNACH refunds: the rail comes from the subscription, as a CHARGE payment has none.
    calls.length = 0;
    reply = (c) => ({
      status: 200,
      body: c.url.includes("/payments/")
        ? { payment_amount: 399.0, authorization_details: null }
        : c.method === "GET"
          ? { subscription_id: SID, authorization_details: { payment_group: "enach" } }
          : { refund_status: "PENDING" },
    });
    await cf.refund({
      providerChargeId: subChargeRef(PID),
      idempotencyKey: "re_enach",
      reason: "ok",
    });
    const enachRefund = calls.find((c) => c.method === "POST")!.body;
    ok(
      "eNACH refund: rail read from the subscription → INSTANT; a 2-letter reason → 'Refund'",
      enachRefund.refund_speed === "INSTANT" &&
        enachRefund.refund_note === "Refund" &&
        calls.some((c) => c.method === "GET" && c.url.endsWith(`/subscriptions/${SID}`)),
      JSON.stringify(enachRefund),
    );
    reply = () => ({ status: 200, body: { refund_status: "REJECTED" } });
    ok(
      "a REJECTED refund read back is failed",
      (await cf.fetchRefundStatus({ providerRefundId: subRefundRef(PID, "tmr_x") })).status ===
        "failed",
    );

    // Pay now: the order closes with our intent; short notes and names are left out.
    calls.length = 0;
    reply = () => ({ status: 200, body: { payment_session_id: "ps_x", order_status: "ACTIVE" } });
    const expires = new Date(NOW + 3_600_000);
    await cf.createIntent({
      purpose: "payment",
      amountMinor: 118_000n,
      currency: "INR",
      customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
      contact: { email: "payer@example.com", phone: "+91 99000 00000", name: "Al" },
      idempotencyKey: "pi_create_pi_x_a1",
      description: "x",
      expiresAt: expires,
    });
    const ob = calls[0]!.body;
    ok(
      "order: order_expiry_time = the intent's expiry; no order_note or name under 3 characters",
      ob.order_expiry_time === expires.toISOString() &&
        ob.order_note === undefined &&
        ob.customer_details.customer_name === undefined &&
        ob.customer_details.customer_phone === "9900000000" &&
        ob.order_amount === 1180 &&
        ob.order_currency === "INR",
      JSON.stringify(ob),
    );

    // ── E3. pay now in other currencies ──────────────────────────────────────
    const payNow = (currency: string, amountMinor: bigint, phone = "+1 415 555 0100") =>
      cf.createIntent({
        purpose: "payment",
        amountMinor,
        currency,
        customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
        contact: { email: "payer@example.com", phone, name: "Fernhill Payer" },
        idempotencyKey: `pi_fx_${currency}_${amountMinor}`,
      });
    calls.length = 0;
    await payNow("USD", 100n);
    await payNow("JPY", 1000n);
    await payNow("EUR", 1999n);
    const [usdO, jpyO, eurO] = calls.map((c) => c.body);
    ok(
      "pay now USD/JPY/EUR: order in that currency, its own decimals, international phone kept",
      usdO.order_amount === 1 &&
        usdO.order_currency === "USD" &&
        usdO.customer_details.customer_phone === "+14155550100" &&
        jpyO.order_amount === 1000 &&
        jpyO.order_currency === "JPY" &&
        eurO.order_amount === 19.99 &&
        eurO.order_currency === "EUR",
      JSON.stringify([usdO, jpyO, eurO]),
    );
    calls.length = 0;
    const fxRefused = await Promise.all([
      payNow("USD", 99n).catch((e) => e),
      payNow("KWD", 10_000n).catch((e) => e),
      payNow("CAD", 10_000n).catch((e) => e),
      payNow("USD", 100n, "4155").catch((e) => e),
    ]);
    ok(
      "refused before any call: under 1 USD, KWD, CAD, a bad phone",
      fxRefused.every((e) => e instanceof ProviderRefusalError) &&
        /at least 1 USD/.test(fxRefused[0].message) &&
        /KWD/.test(fxRefused[1].message) &&
        /country code/.test(fxRefused[3].message) &&
        calls.length === 0,
      fxRefused.map((e) => String(e?.message ?? e)).join(" | "),
    );

    // Indian card on a USD order: the payment is 95.16 INR, the order 1 USD. Book the order.
    const FX_OID = "tmo_000000000000000000000077";
    const fxOrder = { order_status: "PAID", order_amount: 1, order_currency: "USD" };
    const fxPay = {
      cf_payment_id: 5001,
      payment_status: "SUCCESS",
      payment_amount: 95.16,
      payment_currency: "INR",
      payment_group: "credit_card",
    };
    reply = (c) => ({
      status: 200,
      body: c.url.endsWith("/payments")
        ? [fxPay]
        : c.url.includes("/payments/")
          ? fxPay
          : c.url.endsWith("/refunds")
            ? []
            : fxOrder,
    });
    const consumed = await cf.consumeIntent({ purpose: "payment", intentId: FX_OID } as never);
    const fetched = await cf.fetchIntent({ intentId: FX_OID });
    const charge = consumed.purpose === "payment" ? consumed.charge : undefined;
    ok(
      "Indian card on a USD order: consumed, and the intent reads 100 USD from the order (not 9516 INR)",
      charge?.status === "succeeded" &&
        charge.providerChargeId === orderChargeRef(FX_OID, "5001") &&
        fetched.status === "consumed" &&
        fetched.amountMinor === 100n &&
        fetched.currency === "USD",
      JSON.stringify([
        charge?.status,
        fetched.status,
        String(fetched.amountMinor),
        fetched.currency,
      ]),
    );

    // Refunds are taken in the order's currency. Full refund = what is left of the order.
    const REF_OID = "tmo_000000000000000000000078";
    const refundReply =
      (order: Record<string, unknown>, listed: Record<string, unknown>[]) => (c: Call) => ({
        status: 200,
        body:
          c.method === "POST"
            ? { refund_status: "PENDING" }
            : c.url.endsWith("/refunds")
              ? listed
              : order,
      });
    calls.length = 0;
    reply = refundReply({ order_amount: 10, order_currency: "USD" }, [
      { refund_id: "a", cf_payment_id: 6001, refund_amount: 3, refund_status: "SUCCESS" },
      { refund_id: "b", cf_payment_id: 6001, refund_amount: 2, refund_status: "PENDING" },
      { refund_id: "c", cf_payment_id: 6001, refund_amount: 4, refund_status: "CANCELLED" },
      { refund_id: "d", cf_payment_id: 9999, refund_amount: 1, refund_status: "SUCCESS" },
    ]);
    const full = await cf.refund({
      providerChargeId: orderChargeRef(REF_OID, "6001"),
      currency: "USD",
      idempotencyKey: "re_fx_full",
    });
    const fullBody = calls.find((c) => c.method === "POST")?.body;
    ok(
      "full refund of a USD order: 10 − 3 − 2 (pending counts) = 5 USD; failed and other payments ignored",
      fullBody?.refund_amount === 5 &&
        full.providerRefundId === orderRefundRef(REF_OID, fullBody.refund_id),
      JSON.stringify(fullBody),
    );
    calls.length = 0;
    reply = refundReply({ order_amount: 1000, order_currency: "JPY" }, []);
    await cf.refund({
      providerChargeId: orderChargeRef(REF_OID, "6001"),
      amountMinor: 400n,
      currency: "JPY",
      idempotencyKey: "re_fx_jpy",
    });
    ok(
      "partial JPY refund: 400 minor → refund_amount 400 (no decimals)",
      calls.find((c) => c.method === "POST")?.body.refund_amount === 400,
    );
    calls.length = 0;
    reply = refundReply({ order_amount: 10, order_currency: "USD" }, [
      { refund_id: "a", cf_payment_id: 6001, refund_amount: 10, refund_status: "SUCCESS" },
    ]);
    const wrongCur = await cf
      .refund({
        providerChargeId: orderChargeRef(REF_OID, "6001"),
        amountMinor: 100n,
        currency: "INR",
        idempotencyKey: "re_fx_cur",
      })
      .catch((e) => e);
    const nothingLeft = await cf
      .refund({ providerChargeId: orderChargeRef(REF_OID, "6001"), idempotencyKey: "re_fx_none" })
      .catch((e) => e);
    ok(
      "refund refused locally: INR on a USD order; full refund with nothing left",
      wrongCur instanceof ProviderRefusalError &&
        /is in USD/.test(wrongCur.message) &&
        nothingLeft instanceof ProviderRefusalError &&
        !calls.some((c) => c.method === "POST"),
      `${wrongCur?.message} | ${nothingLeft?.message}`,
    );

    // ── E4. removing a mandate cancels the payments raised on it ──────────────
    {
      const MSID = "tms_00000000000000aa";
      const st: Record<string, string> = {
        [`${MSID}-000000000001`]: "INITIALIZED",
        [`${MSID}-000000000002`]: "SUCCESS",
        [`${MSID}-000000000003`]: "PENDING",
      };
      let subStatus = "ACTIVE";
      // The rail Cashfree reports on GET /subscriptions/{id}; undefined = none reported.
      let cfRail: string | undefined;
      const mandateReply =
        (opts: { stuck?: string; listDown?: boolean; subStuck?: boolean } = {}) =>
        (c: Call) => {
          const u = new URL(c.url).pathname.replace(/^\/pg/, "");
          if (u === `/subscriptions/${MSID}/payments`)
            return opts.listDown
              ? { status: 500, body: { message: "down" } }
              : {
                  status: 200,
                  body: Object.entries(st).map(([payment_id, payment_status]) => ({
                    payment_id,
                    payment_status,
                  })),
                };
          const m = /^\/subscriptions\/[^/]+\/payments\/([^/]+)(\/manage)?$/.exec(u);
          if (m) {
            if (m[2] && m[1] !== opts.stuck && st[m[1]!] !== "SUCCESS") st[m[1]!] = "CANCELLED";
            return { status: 200, body: { payment_id: m[1], payment_status: st[m[1]!] } };
          }
          if (u === `/subscriptions/${MSID}/manage`) {
            if (opts.subStuck) return { status: 400, body: { message: "Invalid action" } };
            subStatus = "CANCELLED";
            return { status: 200, body: { subscription_status: subStatus } };
          }
          return {
            status: 200,
            body: {
              subscription_id: MSID,
              subscription_status: subStatus,
              ...(cfRail ? { authorization_details: { payment_group: cfRail } } : {}),
            },
          };
        };
      // `type` = our stored display type; `rail` = the stored mandate rail (null: none stored).
      const del = (type: "card" | "upi" = "card", rail: string | null = type) =>
        cf
          .deletePaymentMethod({
            customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
            paymentMethod: {
              providerKey: "cashfree",
              providerPaymentMethodId: MSID,
              display: { type },
              ...(rail ? { mandate: { rail } } : {}),
            },
          })
          .then(
            () => null,
            (e: Error) => e,
          );
      calls.length = 0;
      reply = mandateReply();
      const ok1 = await del();
      const cancels = calls
        .filter((c) => c.method === "POST" && c.url.endsWith("/manage"))
        .map((c) => new URL(c.url).pathname.split("/").slice(-2, -1)[0]);
      ok(
        "mandate removal: each raised payment not yet run is cancelled, the paid one is left, then the subscription",
        ok1 === null &&
          st[`${MSID}-000000000001`] === "CANCELLED" &&
          st[`${MSID}-000000000003`] === "CANCELLED" &&
          st[`${MSID}-000000000002`] === "SUCCESS" &&
          !cancels.includes(`${MSID}-000000000002`) &&
          cancels.at(-1) === MSID,
        cancels.join(","),
      );
      const P1 = `${MSID}-000000000001`;
      const again = (status: string) => {
        st[P1] = status;
        subStatus = "ACTIVE";
      };
      again("PENDING");
      reply = mandateReply({ stuck: P1 });
      const stuck = await del("upi");
      again("PENDING");
      reply = mandateReply({ stuck: P1, subStuck: true });
      const stuckLive = await del();
      reply = mandateReply({ listDown: true });
      const blind = await del();
      ok(
        "mandate removal: a UPI payment Cashfree will not cancel, any payment on a mandate still live, or a payment list it will not show, is an error (recorded by the caller), never silent",
        stuck instanceof Error &&
          /000000000001 could not be cancelled/.test(stuck.message) &&
          stuckLive instanceof Error &&
          /subscription could not be cancelled/.test(stuckLive.message) &&
          blind instanceof Error &&
          /could not be read/.test(blind.message),
        `${stuck?.message} | ${stuckLive?.message} | ${blind?.message}`,
      );
      // Cashfree support 2026-11-02 and the subscription FAQ: on a cancelled mandate a card
      // PENDING is never debited, and an INITIALIZED payment fails at processing.
      again("PENDING");
      reply = mandateReply({ stuck: P1 });
      const cardPending = await del();
      again("INITIALIZED");
      reply = mandateReply({ stuck: P1 });
      const upiInitialized = await del("upi");
      ok(
        "mandate removal: a card PENDING or any INITIALIZED payment left on a CANCELLED mandate is not an error",
        cardPending === null && upiInitialized === null && subStatus === "CANCELLED",
        `${cardPending?.message} | ${upiInitialized?.message}`,
      );
      // Audit H1: only a KNOWN card rail lets a PENDING go unreported. Our display type is not
      // evidence (an unknown rail maps to card there, and a rail change does not update it).
      again("PENDING");
      reply = mandateReply({ stuck: P1 });
      const unknownRail = await del("card", null);
      again("PENDING");
      cfRail = "card";
      reply = mandateReply({ stuck: P1 });
      const cfSaysCard = await del("upi", null);
      again("PENDING");
      cfRail = "upi";
      reply = mandateReply({ stuck: P1 });
      const cfSaysUpi = await del("card", "card");
      cfRail = undefined;
      ok(
        "mandate removal (H1): a PENDING with no known rail, or on a rail Cashfree reports as UPI, is still reported; Cashfree's card rail wins over a stale stored type",
        unknownRail instanceof Error &&
          /could not be cancelled/.test(unknownRail.message) &&
          cfSaysCard === null &&
          cfSaysUpi instanceof Error,
        `${unknownRail?.message} | ${cfSaysCard?.message} | ${cfSaysUpi?.message}`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  // ── F. ids, amounts, time ──────────────────────────────────────────────────
  const parsed = parseCashfreeChargeRef(subChargeRef(PID));
  ok(
    "a charge id gives back its subscription",
    parsed?.kind === "sub" && parsed.subscriptionId === SID,
  );
  ok(
    "an order charge id round-trips",
    JSON.stringify(parseCashfreeChargeRef("ord:tmo_1:99")) ===
      JSON.stringify({ kind: "ord", orderId: "tmo_1", cfPaymentId: "99" }),
  );
  ok(
    "ids fit Cashfree's character set and length",
    /^[A-Za-z0-9_-]{1,40}$/.test(PID) && /^[A-Za-z0-9_-]{1,40}$/.test(`${PID}-n`),
  );
  ok(
    "same key, same UUID; other key, other UUID",
    cashfreeIdempotencyUuid("a") === cashfreeIdempotencyUuid("a") &&
      cashfreeIdempotencyUuid("a") !== cashfreeIdempotencyUuid("b"),
  );
  ok(
    "amounts are exact in each currency's decimals",
    cashfreeAmount(1015n, "INR") === 10.15 &&
      cashfreeAmount(1n, "USD") === 0.01 &&
      cashfreeAmount(1000n, "JPY") === 1000 &&
      cashfreeMinor(10.15, "INR") === 1015n &&
      cashfreeMinor("399.00", "INR") === 39_900n &&
      cashfreeMinor(95.16, "USD") === 9516n &&
      cashfreeMinor("1000", "JPY") === 1000n &&
      cashfreeMinor("1000.00", "JPY") === 1000n,
  );
  ok(
    "an amount with more decimals than its currency is unreadable, never rounded (10.5 JPY)",
    cashfreeMinor(10.5, "JPY") === undefined &&
      cashfreeMinor("1.005", "USD") === undefined &&
      cashfreeMinor(-1, "USD") === undefined &&
      cashfreeMinor(1, undefined) === undefined,
  );
  ok(
    "order amount: at least 1 whole unit, only currencies Cashfree takes",
    cashfreeOrderAmountProblem(100n, "USD") === undefined &&
      cashfreeOrderAmountProblem(1n, "JPY") === undefined &&
      /at least 1 USD/.test(cashfreeOrderAmountProblem(99n, "USD") ?? "") &&
      /at least 1 INR/.test(cashfreeOrderAmountProblem(50n, "INR") ?? "") &&
      /KWD/.test(cashfreeOrderAmountProblem(10_000n, "KWD") ?? "") &&
      /BHD/.test(cashfreeOrderAmountProblem(10_000n, "BHD") ?? ""),
  );
  ok(
    "order phone: a + number outside India keeps its code on any order; +91 → 10 digits",
    cashfreeOrderPhone("+65 9123 4567") === "+6591234567" &&
      cashfreeOrderPhone("+1 415 555 0100") === "+14155550100" &&
      cashfreeOrderPhone("+91 90000 00000") === "9000000000" &&
      cashfreeOrderPhone("9000000000") === "9000000000" &&
      cashfreeOrderPhone("4155") === undefined,
  );
  ok(
    "payment_remarks: only letters, digits, dot, hyphen, underscore (measured refusal otherwise)",
    cashfreeRemarks("New subscription · Subscription sub_X1 · Reports Pro · a@example.com") ===
      "New-subscription-Subscription-sub_X1-Reports-Pro-a-example.com" &&
      cashfreeRemarks(" · ") === undefined &&
      cashfreeRemarks(undefined) === undefined &&
      /^[A-Za-z0-9._-]{1,200}$/.test(cashfreeRemarks("x".repeat(300))!),
  );
  ok(
    "international phone: + and 8 to 15 digits",
    cashfreeInternationalPhone("+1 415 555 0100") === "+14155550100" &&
      cashfreeInternationalPhone("4155550100") === undefined &&
      cashfreeInternationalPhone("+12") === undefined,
  );
  ok(
    "UPI peak hours are skipped",
    nextUpiDebitWindow(new Date("2026-10-24T11:00:00+05:30")).toISOString() ===
      new Date("2026-10-24T13:00:00+05:30").toISOString() &&
      nextUpiDebitWindow(new Date("2026-10-24T18:00:00+05:30")).toISOString() ===
        new Date("2026-10-24T21:30:00+05:30").toISOString(),
  );
  const late = controlledSchedule(
    new Date("2026-10-24T23:30:00+05:30"),
    new Date("2026-10-25T23:40:00+05:30"),
    24,
  );
  ok(
    "a notice whose window is spent moves to the next day",
    late.date === "2026-10-26" &&
      late.executableAfter.toISOString() === new Date("2026-10-26T00:00:00+05:30").toISOString(),
  );
  ok(
    "Raise-a-Charge after 21:00 IST is T+2",
    chargeScheduleDate(new Date("2026-10-24T21:30:00+05:30")) === "2026-10-26" &&
      istDate(new Date("2026-10-24T20:00:00Z")) === "2026-10-25",
  );

  await flushGatewayRequestLogs();
  let failedCount = 0;
  for (const [label, pass, detail] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${!pass && detail ? `  (${detail})` : ""}`);
    if (!pass) failedCount++;
  }
  console.log(`\n${checks.length - failedCount}/${checks.length} passed`);
  console.log(failedCount ? "❌ CASHFREE: FAIL" : "✅ CASHFREE: PASS");
  await closeDb();
  process.exit(failedCount ? 1 : 0);
}

function subscriptionOfPaymentOk(paymentId: string): boolean {
  return (
    parseCashfreeChargeRef(subChargeRef(paymentId))?.kind === "sub" &&
    paymentId.startsWith(`${SID}-`)
  );
}

await main();
