/**
 * verify:adyen — the Adyen adapter, offline. No network: Checkout and Management answers come
 * from a stubbed `fetch`, in the shapes the test account returned (measured by
 * `verify:adyen-live`). Webhook signatures are checked against Adyen's published test vector.
 *
 * Covers per-item HMAC, multi-item deliveries, event mapping, the stored-credential flags,
 * decline mapping, capabilities, the catalog entry and the `sdk` session flow.
 *
 *   pnpm verify:adyen
 */
import { closeDb } from "@/platform/db";
import {
  ADYEN_REF,
  ADYEN_REPLAY_WINDOW_MS,
  AdyenApiError,
  AdyenProvider,
  adyenHmacPayload,
  adyenAllowedOriginsCheck,
  adyenItemEventId,
  adyenOwnership,
  adyenSepaChargeback,
  adyenSetupMethods,
  adyenStoredCredential,
  adyenTxVariant,
  chargeResultFromPayment,
  decodeStoredMethod,
  describeAdyenStoredMethod,
  encodeStoredMethod,
  normalizeAdyenItem,
  signAdyenItem,
  verifyAdyenItem,
  type AdyenNotificationItem,
} from "@/providers/adyen";
import {
  DECLINE_SETS,
  declineHiddenFromPayer,
  normalizeAdyenDecline,
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

// Adyen's published example (docs: verify HMAC signatures).
const DOC_KEY = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056";
const DOC_SIGNATURE = "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=";
const DOC_PAYLOAD =
  "7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true";
const OTHER_KEY = "00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF";

const signed = (item: AdyenNotificationItem, key = DOC_KEY): AdyenNotificationItem => ({
  ...item,
  additionalData: { ...item.additionalData, hmacSignature: signAdyenItem(key, item) },
});
const body = (...items: AdyenNotificationItem[]) =>
  JSON.stringify({
    live: "false",
    notificationItems: items.map((i) => ({ NotificationRequestItem: i })),
  });
const item = (over: Partial<AdyenNotificationItem>): AdyenNotificationItem => ({
  eventCode: "AUTHORISATION",
  success: "true",
  pspReference: "PSPXXXXXXXXXXX01",
  merchantAccountCode: "TestMerchantECOM",
  merchantReference: "tmc:pay_XXXXXXXXXXXX01",
  amount: { value: 1999, currency: "USD" },
  eventDate: "2026-10-24T10:00:00+02:00",
  additionalData: {},
  ...over,
});

const adyen = (over: Partial<ConstructorParameters<typeof AdyenProvider>[0]> = {}) =>
  new AdyenProvider({
    apiKey: "AQE_offline_key",
    clientKey: "test_OFFLINECLIENTKEY",
    merchantAccount: "TestMerchantECOM",
    livemode: false,
    hmacKey: DOC_KEY,
    ...over,
  });
const input = (payload: string) => ({ payload, headers: { "content-type": "application/json" } });
const types = (evs: NormalizedProviderEvent[]) => evs.map((e) => e.type).join(",");

// ── HMAC per item ───────────────────────────────────────────────────────────
{
  const doc: AdyenNotificationItem = {
    pspReference: "7914073381342284",
    merchantAccountCode: "TestMerchant",
    merchantReference: "TestPayment-1407325143704",
    amount: { value: 1130, currency: "EUR" },
    eventCode: "AUTHORISATION",
    success: "true",
  };
  ok("the signed string is Adyen's documented payload", adyenHmacPayload(doc) === DOC_PAYLOAD);
  ok(
    "the signature matches Adyen's published test vector (hex-decoded key)",
    signAdyenItem(DOC_KEY, doc) === DOC_SIGNATURE,
  );
  ok(
    "the lower-case key gives the same signature",
    signAdyenItem(DOC_KEY.toLowerCase(), doc) === DOC_SIGNATURE,
  );
  const good = { ...doc, additionalData: { hmacSignature: DOC_SIGNATURE } };
  ok("a valid item verifies", verifyAdyenItem(DOC_KEY, good));
  ok(
    "a tampered amount fails",
    !verifyAdyenItem(DOC_KEY, { ...good, amount: { value: 1131, currency: "EUR" } }),
  );
  ok("a tampered success flag fails", !verifyAdyenItem(DOC_KEY, { ...good, success: "false" }));
  ok("the wrong key fails", !verifyAdyenItem(OTHER_KEY, good));
  ok("an item with no signature fails", !verifyAdyenItem(DOC_KEY, doc));
  ok(
    "a key that is not hex is refused",
    (await throws(() => signAdyenItem("not-hex", doc))) != null,
  );

  const one = signed(item({}));
  const evs = await adyen().normalizeWebhook(input(body(one)));
  ok("normalizeWebhook accepts a signed delivery", evs.length === 1);
  const tampered = { ...one, amount: { value: 1, currency: "USD" } };
  ok(
    "normalizeWebhook rejects a tampered item",
    /HMAC/.test(String(await throws(() => adyen().normalizeWebhook(input(body(tampered)))))),
  );
  ok(
    "normalizeWebhook rejects the wrong key",
    (await throws(() => adyen({ hmacKey: OTHER_KEY }).normalizeWebhook(input(body(one))))) != null,
  );
  ok(
    "normalizeWebhook refuses every delivery without a configured key",
    /not configured/.test(
      String(await throws(() => adyen({ hmacKey: undefined }).normalizeWebhook(input(body(one))))),
    ),
  );
}

// ── Multi-item deliveries ───────────────────────────────────────────────────
{
  const a = signed(item({ pspReference: "PSPXXXXXXXXXXX11" }));
  const r = signed(
    item({
      eventCode: "REFUND",
      pspReference: "PSPXXXXXXXXXXR11",
      originalReference: "PSPXXXXXXXXXXX11",
      merchantReference: "tmf:re_XXXXXXXXXXXX01",
      amount: { value: 500, currency: "USD" },
    }),
  );
  const c = signed(
    item({
      eventCode: "CHARGEBACK",
      pspReference: "PSPXXXXXXXXXXD11",
      originalReference: "PSPXXXXXXXXXXX11",
      merchantReference: "tmc:pay_XXXXXXXXXXXX01",
      reason: "Fraud",
      additionalData: { chargebackReasonCode: "10.4", disputeStatus: "Undefended" },
    }),
  );
  const p = adyen();
  const evs = await p.normalizeWebhook(input(body(a, r, c)));
  ok(
    "a three-item delivery maps every item",
    types(evs) === "charge.succeeded,charge.refunded,dispute.created,dispute.funds_withdrawn",
    types(evs),
  );
  ok(
    "each event keeps its own item id",
    evs[0]!.providerEventId === "PSPXXXXXXXXXXX11:AUTHORISATION:true" &&
      evs[1]!.providerEventId === "PSPXXXXXXXXXXR11:REFUND:true" &&
      evs[3]!.providerEventId === "PSPXXXXXXXXXXD11:CHARGEBACK:true:funds_withdrawn",
    evs.map((e) => e.providerEventId).join(" "),
  );
  const batch = p.webhookEventId(input(body(a, r, c)));
  ok(
    "a batch id is order-independent and stable",
    batch.startsWith("adybatch:") && batch === p.webhookEventId(input(body(c, a, r))),
  );
  ok(
    "a single-item delivery is deduped by its item id",
    p.webhookEventId(input(body(a))) === adyenItemEventId(a),
  );
  ok(
    "a body that is not JSON falls back to a body hash",
    p.webhookEventId(input("[accepted]")).startsWith("sha256:"),
  );
  const bad = { ...r, success: "false" };
  ok(
    "one bad item rejects the whole delivery",
    (await throws(() => p.normalizeWebhook(input(body(a, bad, c))))) != null,
  );
}

// ── Event mapping ───────────────────────────────────────────────────────────
{
  const map = (over: Partial<AdyenNotificationItem>) => normalizeAdyenItem(item(over), "ev1");
  const ch = map({});
  ok(
    "AUTHORISATION success on a charge → charge.succeeded by pspReference, ours",
    ch[0]!.type === "charge.succeeded" &&
      ch[0]!.providerChargeId === "PSPXXXXXXXXXXX01" &&
      ch[0]!.ownership === "ours" &&
      ch[0]!.ownershipRef === "pay_XXXXXXXXXXXX01" &&
      ch[0]!.providerObjectCreatedAt instanceof Date,
  );
  const fail = map({
    success: "false",
    reason: "Not enough balance",
    paymentMethod: "mc",
    additionalData: { merchantAdviceCode: "24 : Retry after 1 hour" },
  });
  ok(
    "AUTHORISATION failure → charge.failed with the decline normalised from the reason text",
    fail[0]!.type === "charge.failed" &&
      fail[0]!.failureCode === "insufficient_funds" &&
      fail[0]!.providerFailureCode === "12" &&
      fail[0]!.failureRetriable === true,
    JSON.stringify(fail[0]),
  );
  const pi = map({ merchantReference: "tmp:pi_XXXXXXXXXXXX01" });
  ok(
    "AUTHORISATION on a payment intent → intent.authorized by pspReference",
    pi[0]!.type === "intent.authorized" && pi[0]!.providerIntentId === "PSPXXXXXXXXXXX01",
  );
  ok(
    "a refused payment intent → intent.failed",
    map({ merchantReference: "tmp:pi_X", success: "false", reason: "Refused" })[0]!.type ===
      "intent.failed",
  );
  const setup = map({
    merchantReference: "tms:pi_XXXXXXXXXXXX02",
    amount: { value: 0, currency: "USD" },
    additionalData: {
      "tokenization.storedPaymentMethodId": "TOKENXXXXXXXXX01",
      "tokenization.shopperReference": "cus_XXXXXXXXXXXX01",
    },
  });
  ok(
    "a zero-amount setup AUTHORISATION → intent.setup_succeeded keyed like the browser path",
    setup[0]!.type === "intent.setup_succeeded" &&
      setup[0]!.providerIntentId ===
        encodeStoredMethod("cus_XXXXXXXXXXXX01", "TOKENXXXXXXXXX01", "PSPXXXXXXXXXXX01"),
  );
  ok(
    "a setup AUTHORISATION without a token is persisted only",
    map({ merchantReference: "tms:pi_X" })[0]!.type === "unknown",
  );
  const cap = map({
    eventCode: "CAPTURE",
    pspReference: "CAPXXXXXXXXXXX01",
    originalReference: "PSPXXXXXXXXXXX01",
  });
  ok(
    "CAPTURE → charge.succeeded on the original payment",
    cap[0]!.type === "charge.succeeded" && cap[0]!.providerChargeId === "PSPXXXXXXXXXXX01",
  );
  ok(
    "capturedAmountMinor: a CAPTURE carries its amount",
    cap[0]!.capturedAmountMinor === 1999n &&
      map({
        eventCode: "CAPTURE",
        originalReference: "P",
        amount: { value: 500, currency: "USD" },
      })[0]!.capturedAmountMinor === 500n,
  );
  ok(
    "capturedAmountMinor: our charge's AUTHORISATION carries it (captured with the authorisation)",
    ch[0]!.capturedAmountMinor === 1999n,
  );
  ok(
    "capturedAmountMinor: unset on a foreign AUTHORISATION (its capture is unknown)",
    map({ merchantReference: "ORDER-1" })[0]!.type === "charge.succeeded" &&
      map({ merchantReference: "ORDER-1" })[0]!.capturedAmountMinor === undefined,
  );
  const cf = map({
    eventCode: "CAPTURE_FAILED",
    originalReference: "PSPXXXXXXXXXXX01",
    reason: "Capture failed",
  });
  ok(
    "CAPTURE_FAILED → charge.failed flagged as a reversal",
    cf[0]!.type === "charge.failed" &&
      cf[0]!.providerChargeId === "PSPXXXXXXXXXXX01" &&
      (cf[0]!.raw as { data?: { reversal?: boolean } }).data?.reversal === true,
  );
  ok(
    "CANCELLATION → intent.voided on the original payment",
    map({ eventCode: "CANCELLATION", originalReference: "PSPXXXXXXXXXXX01" })[0]!
      .providerIntentId === "PSPXXXXXXXXXXX01",
  );
  ok(
    "CANCEL_OR_REFUND (refund) → charge.refunded; (cancel) → intent.voided",
    map({
      eventCode: "CANCEL_OR_REFUND",
      originalReference: "P1",
      additionalData: { "modification.action": "refund" },
    })[0]!.type === "charge.refunded" &&
      map({
        eventCode: "CANCEL_OR_REFUND",
        originalReference: "P1",
        additionalData: { "modification.action": "cancel" },
      })[0]!.type === "intent.voided",
  );
  const rf = map({
    eventCode: "REFUND",
    pspReference: "RFXXXXXXXXXXXX01",
    originalReference: "PSPXXXXXXXXXXX01",
  });
  ok(
    "REFUND success → charge.refunded with both ids",
    rf[0]!.type === "charge.refunded" &&
      rf[0]!.providerRefundId === "RFXXXXXXXXXXXX01" &&
      rf[0]!.providerChargeId === "PSPXXXXXXXXXXX01",
  );
  ok(
    "REFUND failure, REFUND_FAILED and REFUNDED_REVERSED → refund.failed",
    ["REFUND", "REFUND_FAILED", "REFUNDED_REVERSED"].every(
      (code) =>
        map({
          eventCode: code,
          success: code === "REFUND" ? "false" : "true",
          pspReference: "RF1",
        })[0]!.type === "refund.failed",
    ),
  );
  const dispute = {
    pspReference: "DSXXXXXXXXXXXX01",
    originalReference: "PSPXXXXXXXXXXX01",
    amount: { value: 1999, currency: "USD" },
  };
  const noc = map({
    eventCode: "NOTIFICATION_OF_CHARGEBACK",
    ...dispute,
    additionalData: {
      chargebackReasonCode: "13.1",
      disputeStatus: "Undefended",
      defensePeriodEndsAt: "2026-11-10T00:00:00+01:00",
    },
  });
  ok(
    "NOTIFICATION_OF_CHARGEBACK → dispute.created only, with deadline and reason",
    types(noc) === "dispute.created" &&
      noc[0]!.providerDisputeId === "DSXXXXXXXXXXXX01" &&
      noc[0]!.providerChargeId === "PSPXXXXXXXXXXX01" &&
      noc[0]!.disputeReason === "13.1" &&
      noc[0]!.disputeAmountMinor === 1999n &&
      noc[0]!.evidenceDueBy instanceof Date,
  );
  ok(
    "CHARGEBACK → dispute.created + dispute.funds_withdrawn",
    types(
      map({ eventCode: "CHARGEBACK", ...dispute, additionalData: { disputeStatus: "Undefended" } }),
    ) === "dispute.created,dispute.funds_withdrawn",
  );
  ok(
    "an accepted CHARGEBACK is also dispute.lost",
    types(
      map({ eventCode: "CHARGEBACK", ...dispute, additionalData: { disputeStatus: "Accepted" } }),
    ) === "dispute.created,dispute.funds_withdrawn,dispute.lost",
  );
  ok(
    "CHARGEBACK_REVERSED → funds reinstated (+ won when Adyen says Won)",
    types(
      map({
        eventCode: "CHARGEBACK_REVERSED",
        ...dispute,
        additionalData: { disputeStatus: "Pending" },
      }),
    ) === "dispute.funds_reinstated" &&
      types(
        map({
          eventCode: "CHARGEBACK_REVERSED",
          ...dispute,
          additionalData: { disputeStatus: "Won" },
        }),
      ) === "dispute.funds_reinstated,dispute.won",
  );
  ok(
    "SECOND_CHARGEBACK → funds withdrawn again + dispute.lost, as a second case",
    types(map({ eventCode: "SECOND_CHARGEBACK", ...dispute })) ===
      "dispute.funds_withdrawn,dispute.lost" &&
      map({ eventCode: "SECOND_CHARGEBACK", ...dispute }).every(
        (e) => e.providerDisputeId === `${dispute.pspReference}:second`,
      ),
  );
  ok(
    "PREARBITRATION_WON / _LOST → dispute.won / dispute.lost",
    map({ eventCode: "PREARBITRATION_WON", ...dispute })[0]!.type === "dispute.won" &&
      map({ eventCode: "PREARBITRATION_LOST", ...dispute })[0]!.type === "dispute.lost",
  );
  ok(
    "RECURRING_CONTRACT and REPORT_AVAILABLE are persisted as unknown",
    map({ eventCode: "RECURRING_CONTRACT" })[0]!.type === "unknown" &&
      map({ eventCode: "REPORT_AVAILABLE", merchantReference: "" })[0]!.type === "unknown",
  );
  ok(
    "ownership: a prefixed reference is ours, another is foreign, none is unknown",
    adyenOwnership("tmc:pay_1").ownership === "ours" &&
      adyenOwnership("order-123").ownership === "foreign" &&
      adyenOwnership(undefined).ownership === "unknown" &&
      adyenOwnership("order-123", "pay_9").ownershipRef === "pay_9",
  );
  ok(
    "every reference prefix is distinct",
    new Set(Object.values(ADYEN_REF)).size === Object.values(ADYEN_REF).length,
  );

  // SEPA chargebacks: Adyen's documented example (risk-management/chargeback-guidelines/sepa-chargebacks).
  const sepaCb = (code: string | null, reason: string) => ({
    eventCode: "CHARGEBACK",
    pspReference: "PSPXXXXXXXXXXX20",
    originalReference: "PSPXXXXXXXXXXX01",
    paymentMethod: "sepadirectdebit",
    reason,
    amount: { value: 1000, currency: "EUR" },
    additionalData: {
      ...(code ? { chargebackReasonCode: code } : {}),
      chargebackSchemeCode: "sepadirectdebit",
      defendable: "false",
      disputeStatus: "Lost",
    },
  });
  const ret = map(sepaCb("AM04", "AM04:InsufficientFunds"));
  ok(
    "SEPA CHARGEBACK AM04 → a bank return: charge.failed as a late reversal, never a dispute",
    ret.length === 1 &&
      ret[0]!.type === "charge.failed" &&
      ret[0]!.lateReversal === true &&
      ret[0]!.providerChargeId === "PSPXXXXXXXXXXX01" &&
      ret[0]!.failureCode === "insufficient_funds" &&
      ret[0]!.providerFailureCode === "AM04",
    JSON.stringify(ret[0]),
  );
  const closed = map(sepaCb(null, "AC04:ClosedAccountNumber"));
  ok(
    "SEPA return read from the reason text when the code field is absent; closed account is terminal",
    closed[0]!.type === "charge.failed" &&
      closed[0]!.failureCode === "bank_account_closed" &&
      closed[0]!.failureRetriable === false,
    JSON.stringify(closed[0]),
  );
  const claim = map(sepaCb("MD06", "MD06:RefundRequestByEndCustomer"));
  ok(
    "SEPA MD06 (the payer's refund request) → dispute opened, withdrawn and lost at once",
    claim.map((e) => e.type).join() === "dispute.created,dispute.funds_withdrawn,dispute.lost" &&
      claim[0]!.providerChargeId === "PSPXXXXXXXXXXX01",
  );
  ok(
    "SEPA MD01 (no mandate) and an unknown code stay disputes, lost even without disputeStatus",
    map(sepaCb("MD01", "MD01:NoMandate")).at(-1)!.type === "dispute.lost" &&
      map({
        ...sepaCb("ZZ99", "ZZ99:New"),
        additionalData: { chargebackReasonCode: "ZZ99", chargebackSchemeCode: "sepadirectdebit" },
      }).at(-1)!.type === "dispute.lost",
  );
  ok(
    "SEPA classification: returns and claims, and nothing for a card chargeback",
    adyenSepaChargeback(item(sepaCb("SL01", "")))?.kind === "return" &&
      adyenSepaChargeback(item(sepaCb("MD06", "")))?.kind === "claim" &&
      adyenSepaChargeback(item({ eventCode: "CHARGEBACK", paymentMethod: "visa" })) === null,
  );
  ok(
    "SEPA returns caused by our creditor data are not the payer's account (gateway_request_rejected)",
    map(sepaCb("BE05", ""))[0]!.failureCode === "gateway_request_rejected",
  );
  const cxl = map({
    eventCode: "CANCEL_OR_REFUND",
    pspReference: "PSPXXXXXXXXXXX21",
    originalReference: "PSPXXXXXXXXXXX01",
    merchantReference: "tmf:re_XXXXXXXXXXXX01",
    amount: { value: 1000, currency: "EUR" },
    additionalData: { "modification.action": "cancel" },
  });
  ok(
    "CANCEL_OR_REFUND cancel answering OUR refund (tmf:) → charge.refunded, the debit never happened",
    cxl[0]!.type === "charge.refunded" &&
      cxl[0]!.refunds?.[0]?.amountMinor === 1000n &&
      cxl[0]!.refunds[0].ownershipRef === "re_XXXXXXXXXXXX01",
    JSON.stringify(cxl[0], (_k, v) => (typeof v === "bigint" ? String(v) : v)),
  );
  ok(
    "CANCEL_OR_REFUND cancel that answers no refund of ours is still a void",
    map({
      eventCode: "CANCEL_OR_REFUND",
      originalReference: "PSPXXXXXXXXXXX01",
      merchantReference: "tmv:pi_XXXXXXXXXXXX01",
      additionalData: { "modification.action": "cancel" },
    })[0]!.type === "intent.voided",
  );
  const setupItem = map({
    merchantReference: "tms:pi_XXXXXXXXXXXX01",
    pspReference: "PSPXXXXXXXXXXX22",
    paymentMethod: "sepadirectdebit",
    additionalData: {
      "tokenization.storedPaymentMethodId": "TOKENXXXXXXXXX03",
      "tokenization.shopperReference": "cus_XXXXXXXXXXXX01",
    },
  });
  ok(
    "AUTHORISATION of a setup → setup_succeeded with the same id the session result gives",
    setupItem[0]!.type === "intent.setup_succeeded" &&
      setupItem[0]!.providerIntentId ===
        encodeStoredMethod("cus_XXXXXXXXXXXX01", "TOKENXXXXXXXXX03", "PSPXXXXXXXXXXX22"),
  );
}

// ── Stored-credential flags (initiator) ─────────────────────────────────────
{
  const f = adyenStoredCredential;
  ok(
    "merchant + recurring → ContAuth / Subscription",
    f({ by: "merchant", recurring: true }).recurringProcessingModel === "Subscription" &&
      f({ by: "merchant", recurring: true }).shopperInteraction === "ContAuth",
  );
  ok(
    "merchant, not recurring → ContAuth / UnscheduledCardOnFile",
    f({ by: "merchant", recurring: false }).recurringProcessingModel === "UnscheduledCardOnFile",
  );
  ok(
    "no initiator → the unscheduled merchant-initiated default",
    f(undefined).recurringProcessingModel === "UnscheduledCardOnFile" &&
      f(undefined).shopperInteraction === "ContAuth",
  );
  ok(
    "customer present on a stored card stays ContAuth (Ecommerce needs a CVC we never hold)",
    f({ by: "customer", recurring: true }).shopperInteraction === "ContAuth" &&
      f({ by: "customer", recurring: true }).recurringProcessingModel === "Subscription" &&
      f({ by: "customer", recurring: false }).recurringProcessingModel === "UnscheduledCardOnFile",
  );
}

// ── Decline mapping ─────────────────────────────────────────────────────────
{
  const n = normalizeAdyenDecline;
  ok(
    "12 Not enough balance → insufficient_funds, retriable",
    n("12").code === "insufficient_funds" && n("12").retriable,
  );
  ok(
    "6 Expired Card → expired_card, not retriable",
    n("6").code === "expired_card" && !n("6").retriable,
  );
  ok(
    "5 Blocked Card → card_restricted, not retriable",
    n("5").code === "card_restricted" && !n("5").retriable,
  );
  ok("24 CVC Declined → incorrect_cvc", n("24").code === "incorrect_cvc");
  ok(
    "26 / 50 → revocation_of_authorization, not retriable",
    n("26").code === "revocation_of_authorization" && !n("50").retriable,
  );
  const blocked = n("46");
  ok(
    "46 (Adyen retry block) → network_do_not_retry, shown to the payer",
    blocked.code === "network_do_not_retry" &&
      !blocked.retriable &&
      blocked.exposedToPayer === true,
  );
  ok(
    "38 Authentication required → authentication_required",
    n("38").code === "authentication_required",
  );
  ok(
    "4 Acquirer Error → processing_error, retriable",
    n("4").code === "processing_error" && n("4").retriable,
  );
  ok(
    "api:803 (stored card gone) → payment_method_not_found, not retriable",
    n("api:803").code === "payment_method_not_found" && !n("api:803").retriable,
  );
  const cvc = n("api:14_029");
  ok(
    "api:14_029 (our request) → gateway_request_rejected, hidden from the payer",
    cvc.code === "gateway_request_rejected" &&
      cvc.exposedToPayer === false &&
      declineHiddenFromPayer(cvc.code),
  );
  ok("an unknown code passes through, retriable", n("99").code === "99" && n("99").retriable);
  ok(
    "a Mastercard advice code 24 sets a one-hour floor",
    n({ code: "2", cardBrand: "mastercard", recommendationCode: "24" }).retryAfterMs === 3_600_000,
  );
  ok(
    "the same advice code on Visa is ignored (Adyen's test account sends it on every card)",
    n({ code: "2", cardBrand: "visa", recommendationCode: "24" }).retryAfterMs === undefined,
  );
  ok(
    "the decline set is registered",
    DECLINE_SETS.adyen.rules.length > 0 && DECLINE_SETS.adyen.table["12"] === "insufficient_funds",
  );
  const refused = chargeResultFromPayment({
    pspReference: "PSPXXXXXXXXXXX02",
    resultCode: "Refused",
    refusalReason: "Blocked Card",
    refusalReasonCode: "5",
    paymentMethod: { brand: "visa", type: "scheme" },
  });
  ok(
    "a Refused payment → failed with the rule's code and Adyen's code kept",
    refused.status === "failed" &&
      refused.failure?.code === "card_restricted" &&
      refused.failure.providerCode === "5" &&
      refused.failure.ruleId === "adyen.code.blocked_card",
  );
  ok(
    "Authorised → succeeded; Received → pending; RedirectShopper → requires_action",
    chargeResultFromPayment({ pspReference: "P", resultCode: "Authorised" }).status ===
      "succeeded" &&
      chargeResultFromPayment({ pspReference: "P", resultCode: "Received" }).status === "pending" &&
      chargeResultFromPayment({
        pspReference: "P",
        resultCode: "RedirectShopper",
        action: { type: "redirect" },
      }).status === "requires_action",
  );
  ok(
    "methodUsed: absent when Adyen sends no paymentMethod; an unmapped type stays unknown",
    chargeResultFromPayment({ pspReference: "P", resultCode: "Authorised" }).methodUsed ===
      undefined &&
      chargeResultFromPayment({
        pspReference: "P",
        resultCode: "Authorised",
        paymentMethod: { type: "klarna" },
      }).methodUsed === undefined &&
      chargeResultFromPayment({
        pspReference: "P",
        resultCode: "Authorised",
        paymentMethod: { type: "sepadirectdebit" },
      }).methodUsed === "sepa_debit",
  );
}

// ── Capabilities and catalog ────────────────────────────────────────────────
{
  const p = adyen();
  const c = p.capabilities;
  ok(
    "capabilities: cards and SEPA Direct Debit, any currency, refunds, intents with void, no mandate ceilings",
    c.methods.join() === "card,sepa_debit" &&
      c.currencies.length === 0 &&
      c.refunds &&
      c.partialRefunds &&
      c.intents === true &&
      c.intentVoid === true &&
      c.mandates === false &&
      c.intentPurposes?.join() === "payment,setup",
  );
  ok(
    "no gateway pre-debit notice, no settlement report; Adyen does not notify SEPA payers (we do)",
    !c.preDebitNotice && !c.settlementReport && !c.gatewayNotifiesPayer,
  );
  ok(
    "no status polls: Checkout has no GET for a payment or a refund",
    !("fetchChargeStatus" in p) && !("fetchRefundStatus" in p) && !c.intentStatus,
  );
  ok(
    "lost answers: locateCharge is a same-key replay, inside the keys' 7-day minimum lifetime",
    typeof p.locateCharge === "function" &&
      c.locateByReplay?.keyValidMs === ADYEN_REPLAY_WINDOW_MS &&
      ADYEN_REPLAY_WINDOW_MS < 7 * 86_400_000,
  );
  const g = GATEWAYS.adyen;
  ok(
    "catalog: provider-minted webhook secret, customerless, cards and SEPA",
    g.webhook.secret === "provider_minted" &&
      g.noCustomerIds === true &&
      [...g.advertisedMethods].join() === c.methods.join() &&
      !g.settlement.alwaysAsync,
  );
  ok(
    "catalog: SEPA is EUR-bound, settles by webhook, and is offered with a hint",
    g.currencyBoundMethods?.sepa_debit === "EUR" &&
      g.settlement.asyncMethods?.join() === "sepa_debit" &&
      g.methodOptions.some((o) => o.value === "sepa_debit" && /EUR/.test(o.hint ?? "")),
  );
  ok(
    "catalog: the route answers Adyen [accepted] once a delivery is stored",
    g.webhook.processAfterAnswer?.body === "[accepted]",
  );
  ok(
    "catalog: the four credentials the setup form asks for",
    g.credentialFields.map((f) => f.key).join() ===
      "api_key,client_key,merchant_account,live_url_prefix",
  );
  ok(
    "catalog text says check, never verify",
    !/verif/i.test(
      JSON.stringify(g.credentialFields) +
        g.webhook.instructions("u", "self_provisioned").join() +
        g.webhook.fallbackInstructions.join(),
    ),
  );
  const build = (creds: Record<string, string>, livemode = false) =>
    GATEWAY_FACTORIES.adyen.build(creds, { businessId: "biz_x", livemode });
  const full = {
    api_key: "k",
    client_key: "test_c",
    merchant_account: "M",
    live_url_prefix: "test",
  };
  ok("the factory builds a test account", build(full).key === "adyen");
  ok(
    "the factory refuses missing credentials",
    (await throws(() => build({ api_key: "k" }))) instanceof GatewayResolveError,
  );
  ok(
    "a live account without its URL prefix is refused",
    (await throws(() => build({ ...full, client_key: "live_c" }, true))) instanceof
      GatewayResolveError,
  );
  ok(
    "a test client key on a live account is refused",
    (await throws(() => build({ ...full, live_url_prefix: "abc123-Acme" }, true))) instanceof
      GatewayResolveError,
  );
  ok(
    "a live account with prefix and live key builds",
    build({ ...full, client_key: "live_c", live_url_prefix: "abc123-Acme" }, true).key === "adyen",
  );
}

// ── Ids and display ─────────────────────────────────────────────────────────
{
  const id = encodeStoredMethod("cus_XXXXXXXXXXXX01", "TOKENXXXXXXXXX01");
  const d = decodeStoredMethod(id);
  ok(
    "a setup result round-trips",
    d?.shopperReference === "cus_XXXXXXXXXXXX01" && d.token === "TOKENXXXXXXXXX01",
  );
  ok("a bare token is not a setup result", decodeStoredMethod("TOKENXXXXXXXXX01") === null);
  const withPsp = decodeStoredMethod(
    encodeStoredMethod("cus_XXXXXXXXXXXX01", "TOKENXXXXXXXXX01", "PSPXXXXXXXXXXX09"),
  );
  ok(
    "a setup result carries its pspReference (the SEPA mandate id)",
    withPsp?.token === "TOKENXXXXXXXXX01" && withPsp.setupPsp === "PSPXXXXXXXXXXX09",
  );
  const sepaDisp = describeAdyenStoredMethod({
    id: "T",
    type: "sepadirectdebit",
    iban: "NL98ABNA0410108103",
    supportedRecurringProcessingModels: ["Subscription"],
  });
  ok(
    "display: a stored SEPA mandate is sepa_debit with the IBAN's last four",
    sepaDisp.type === "sepa_debit" &&
      sepaDisp.last4 === "8103" &&
      sepaDisp.supportsRecurring === true,
    JSON.stringify(sepaDisp),
  );
  ok(
    "tx variant: sepa_debit → sepadirectdebit, anything else → scheme",
    adyenTxVariant("sepa_debit") === "sepadirectdebit" &&
      adyenTxVariant("card") === "scheme" &&
      adyenTxVariant(undefined) === "scheme",
  );
  ok(
    "setup methods: cards by default; SEPA added only in EUR",
    adyenSetupMethods(undefined, "EUR").join() === "scheme" &&
      adyenSetupMethods(["card", "sepa_debit"], "eur").join() === "scheme,sepadirectdebit" &&
      adyenSetupMethods(["card", "sepa_debit"], "USD").join() === "scheme" &&
      adyenSetupMethods(["sepa_debit"], "EUR").join() === "sepadirectdebit",
  );
  ok(
    "setup methods: SEPA alone in another currency is refused with the reason",
    (await throws(() => adyenSetupMethods(["sepa_debit"], "USD"))) instanceof ProviderRefusalError,
  );
  const disp = describeAdyenStoredMethod({
    id: "T",
    brand: "mc",
    lastFour: "1111",
    expiryMonth: "03",
    expiryYear: "30",
    supportedRecurringProcessingModels: ["CardOnFile", "Subscription", "UnscheduledCardOnFile"],
  });
  ok(
    "display: brand mapped, two-digit year widened, recurring support read",
    disp.brand === "mastercard" &&
      disp.last4 === "1111" &&
      disp.expMonth === 3 &&
      disp.expYear === 2030 &&
      disp.supportsRecurring === true,
  );
}

// ── Stubbed API flows ───────────────────────────────────────────────────────
// A payment link's AUTHORISATION names the link: the intent we stored, re-pointed to the psp.
{
  const linkAuth = normalizeAdyenItem(
    item({
      merchantReference: "tmh:pi_XXXXXXXXXXXX09",
      paymentMethod: "visa_applepay",
      additionalData: {
        paymentLinkId: "PLXXXXXXXXXXXXXX01",
        "metadata.tmbilling_ref": "pi_XXXXXXXXXXXX09",
      },
    }),
    "evt",
  );
  const e = linkAuth[0]!;
  ok(
    "payment link: AUTHORISATION is intent.authorized on adypl_<link>, re-pointed to the psp",
    linkAuth.length === 1 &&
      e.type === "intent.authorized" &&
      e.providerIntentId === "adypl_PLXXXXXXXXXXXXXX01" &&
      e.providerChargeId === "PSPXXXXXXXXXXX01" &&
      e.gatewayIntentId === "PSPXXXXXXXXXXX01" &&
      e.ownership === "ours" &&
      e.ownershipRef === "pi_XXXXXXXXXXXX09",
    JSON.stringify(linkAuth),
  );
  const refused = normalizeAdyenItem(
    item({ success: "false", additionalData: { paymentLinkId: "PLXXXXXXXXXXXXXX01" } }),
    "evt",
  );
  ok(
    "payment link: a refused try closes nothing (the link stays open for another try)",
    refused.length === 1 && refused[0]!.type === "unknown",
  );
}

{
  interface Call {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }
  const calls: Call[] = [];
  let answer: (c: Call) => { status?: number; body?: unknown } | "network" = () => ({ body: {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? "GET",
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    calls.push(c);
    const a = answer(c);
    if (a === "network") throw new TypeError("fetch failed");
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status ?? 200,
    });
  }) as typeof fetch;
  const last = () => calls[calls.length - 1]!;
  const p = adyen();
  const customer = { providerKey: "adyen" as const, providerCustomerId: "cus_XXXXXXXXXXXX01" };
  const pm = {
    providerKey: "adyen" as const,
    providerPaymentMethodId: "TOKENXXXXXXXXX01",
    providerCustomerId: "cus_XXXXXXXXXXXX01",
    display: { type: "card" as const },
  };
  const chargeIn = {
    amountMinor: 1999n,
    currency: "usd",
    customer,
    paymentMethod: pm,
    idempotencyKey: "inv_XXXXXXXXXXXX01_attempt_1_pm_XXXXXXXXXXXX01_with_a_long_tail_past_64_chars",
    ownershipRef: "pay_XXXXXXXXXXXX01",
    initiator: { by: "merchant" as const, recurring: true },
  };

  try {
    answer = () => ({
      body: {
        pspReference: "PSPXXXXXXXXXXX03",
        resultCode: "Authorised",
        merchantReference: "tmc:pay_XXXXXXXXXXXX01",
        amount: { currency: "USD", value: 1999 },
        paymentMethod: { brand: "visa", type: "scheme" },
        additionalData: { "tokenization.storedPaymentMethodId": "TOKENXXXXXXXXX01" },
      },
    });
    const r = await p.charge(chargeIn);
    const c = last();
    ok(
      "charge: Authorised → succeeded by pspReference",
      r.status === "succeeded" && r.providerChargeId === "PSPXXXXXXXXXXX03",
    );
    ok("charge: methodUsed card from paymentMethod.type scheme", r.methodUsed === "card");
    ok(
      "charge: the request is a ContAuth subscription debit on the stored card",
      c.url.endsWith("/v71/payments") &&
        c.body.shopperInteraction === "ContAuth" &&
        c.body.recurringProcessingModel === "Subscription" &&
        (c.body.paymentMethod as { storedPaymentMethodId?: string }).storedPaymentMethodId ===
          "TOKENXXXXXXXXX01" &&
        c.body.shopperReference === "cus_XXXXXXXXXXXX01" &&
        c.body.captureDelayHours === 0,
      JSON.stringify(c.body),
    );
    const locateIn = {
      ownershipRef: chargeIn.ownershipRef,
      idempotencyKey: chargeIn.idempotencyKey,
      amountMinor: chargeIn.amountMinor,
      currency: chargeIn.currency,
      createdAfter: new Date(Date.now() - 20 * 60_000),
      paymentMethod: pm,
      replay: { initiator: chargeIn.initiator },
    };
    const found = await p.locateCharge(locateIn);
    ok(
      "locateCharge: replays the same body under the same key and reads the payment",
      found?.status === "succeeded" &&
        found.providerChargeId === "PSPXXXXXXXXXXX03" &&
        JSON.stringify(last().body) === JSON.stringify(c.body) &&
        last().headers["Idempotency-Key"] === c.headers["Idempotency-Key"],
      JSON.stringify(last().body),
    );
    const before = calls.length;
    const { replay: _none, ...noReplay } = locateIn;
    ok(
      "locateCharge: sends nothing unless the engine allows a replay",
      (await throws(() => p.locateCharge(noReplay))) instanceof Error && calls.length === before,
    );
    ok(
      "charge: amount in minor units, upper-case currency, prefixed reference, ownership metadata",
      JSON.stringify(c.body.amount) === '{"value":1999,"currency":"USD"}' &&
        c.body.reference === "tmc:pay_XXXXXXXXXXXX01" &&
        (c.body.metadata as Record<string, string>).tmbilling_ref === "pay_XXXXXXXXXXXX01",
    );
    const key = c.headers["Idempotency-Key"] ?? "";
    ok(
      "charge: Idempotency-Key is sent and fits Adyen's 64 characters",
      key.length > 0 && key.length <= 64,
      key,
    );
    ok("charge: the API key rides X-API-Key", c.headers["X-API-Key"] === "AQE_offline_key");

    answer = () => ({
      body: {
        pspReference: "PSPXXXXXXXXXXX04",
        resultCode: "Refused",
        refusalReason: "Not enough balance",
        refusalReasonCode: "12",
        additionalData: { merchantAdviceCode: "24 : Retry after 1 hour", paymentMethod: "mc" },
      },
    });
    const d = await p.charge(chargeIn);
    ok(
      "charge: Refused → failed, insufficient_funds, Mastercard wait applied",
      d.status === "failed" &&
        d.failure?.code === "insufficient_funds" &&
        d.failure.retryAfterMs === 3_600_000,
      JSON.stringify(d.failure),
    );

    answer = () => ({
      status: 422,
      body: {
        status: 422,
        errorCode: "803",
        message: "PaymentDetail not found",
        errorType: "validation",
      },
    });
    const gone = await p.charge(chargeIn);
    ok(
      "charge: a stored card Adyen no longer has → failed payment_method_not_found",
      gone.status === "failed" &&
        gone.failure?.code === "payment_method_not_found" &&
        gone.failure.retriable === false,
    );
    answer = () => ({
      status: 422,
      body: { status: 422, errorCode: "000", message: "Something new", errorType: "validation" },
    });
    ok(
      "charge: an unrecognised 422 throws",
      (await throws(() => p.charge(chargeIn))) instanceof AdyenApiError,
    );
    answer = () => ({ status: 500, body: { status: 500, message: "Internal error" } });
    ok(
      "charge: HTTP 500 is indeterminate",
      (await throws(() => p.charge(chargeIn))) instanceof ProviderIndeterminateError,
    );
    answer = () => "network";
    ok(
      "charge: a lost connection is indeterminate",
      (await throws(() => p.charge(chargeIn))) instanceof ProviderIndeterminateError,
    );
    answer = () => ({ status: 401, body: {} });
    const auth = await throws(() => p.charge(chargeIn));
    ok(
      "charge: a bad API key throws (not indeterminate)",
      auth instanceof Error && !(auth instanceof ProviderIndeterminateError),
    );
    answer = () => ({ body: { pspReference: "P", resultCode: "Authorised" } });
    await p.charge({ ...chargeIn, initiator: undefined });
    ok(
      "charge: no initiator → UnscheduledCardOnFile",
      last().body.recurringProcessingModel === "UnscheduledCardOnFile",
    );

    // setup session → browser → consume
    answer = () => ({
      status: 201,
      body: {
        id: "CSXXXXXXXXXXXXXXXXXX01",
        sessionData: "Ab02b4c0!opaque",
        expiresAt: "2026-10-24T19:00:00+02:00",
        mode: "embedded",
      },
    });
    const setup = await p.createIntent({
      purpose: "setup",
      currency: "inr",
      customer,
      idempotencyKey: "pi_setup_1",
      ownershipRef: "pi_XXXXXXXXXXXX02",
      returnUrl: "https://shop.example.com/return",
    });
    const sc = last();
    ok(
      "setup: a zero-amount session that stores the card for subscriptions",
      sc.url.endsWith("/v71/sessions") &&
        JSON.stringify(sc.body.amount) === '{"value":0,"currency":"INR"}' &&
        sc.body.storePaymentMethodMode === "enabled" &&
        sc.body.recurringProcessingModel === "Subscription" &&
        sc.body.shopperInteraction === "Ecommerce" &&
        sc.body.shopperReference === "cus_XXXXXXXXXXXX01" &&
        sc.body.reference === "tms:pi_XXXXXXXXXXXX02",
      JSON.stringify(sc.body),
    );
    ok(
      "setup: cards only (no Google Pay: we do not save a wallet for renewals)",
      JSON.stringify(sc.body.allowedPaymentMethods) === '["scheme"]',
      JSON.stringify(sc.body.allowedPaymentMethods),
    );
    const params = setup.authorization?.sdk?.params ?? {};
    ok(
      "setup: the buyer gets mode sdk with the client key, environment and session",
      setup.status === "requires_action" &&
        setup.authorization?.mode === "sdk" &&
        setup.authorization.sdk?.provider === "adyen" &&
        params.clientKey === "test_OFFLINECLIENTKEY" &&
        params.environment === "test" &&
        params.sessionId === "CSXXXXXXXXXXXXXXXXXX01" &&
        params.sessionData === "Ab02b4c0!opaque",
    );
    ok(
      "setup: the API key never reaches the browser",
      !JSON.stringify(setup).includes("AQE_offline_key"),
    );

    const submit = (clientResult: Record<string, string>) =>
      p.submitClientResult({
        intentId: setup.intentId,
        purpose: "setup",
        clientResult,
        idempotencyKey: "k",
      });
    const completed = {
      id: "CSXXXXXXXXXXXXXXXXXX01",
      status: "completed",
      reference: "tms:pi_XXXXXXXXXXXX02",
      payments: [
        {
          pspReference: "PSPXXXXXXXXXXX05",
          resultCode: "Authorised",
          amount: { currency: "INR", value: 0 },
        },
      ],
      additionalData: {
        "tokenization.storedPaymentMethodId": "TOKENXXXXXXXXX02",
        "tokenization.shopperReference": "cus_XXXXXXXXXXXX01",
      },
    };
    answer = () => ({ body: completed });
    const done = await submit({
      sessionId: "CSXXXXXXXXXXXXXXXXXX01",
      sessionResult: "Ab02b4c0!result",
    });
    ok(
      "submit: a completed session → authorized with the stored card as the gateway id",
      done.status === "authorized" &&
        done.gatewayIntentId ===
          encodeStoredMethod("cus_XXXXXXXXXXXX01", "TOKENXXXXXXXXX02", "PSPXXXXXXXXXXX05") &&
        last().url.includes("/sessions/CSXXXXXXXXXXXXXXXXXX01?sessionResult=Ab02b4c0!result"),
      last().url,
    );
    ok(
      "submit: a result for another session is refused without a call",
      (await submit({ sessionId: "CSOTHER", sessionResult: "x" })).failure?.code ===
        "invalid_client_result",
    );
    ok("submit: no sessionResult is refused", (await submit({})).status === "failed");
    answer = () => ({
      status: 422,
      body: { status: 422, errorCode: "14_0483", message: "Field 'sessionResult' is not valid." },
    });
    ok(
      "submit: a sessionResult Adyen rejects → invalid_client_result",
      (await submit({ sessionResult: "junk" })).failure?.code === "invalid_client_result",
    );
    answer = () => ({
      body: {
        ...completed,
        status: "refused",
        payments: [{ pspReference: "P6", resultCode: "Refused" }],
      },
    });
    ok("submit: refused → failed", (await submit({ sessionResult: "r" })).status === "failed");
    answer = () => ({ body: { ...completed, status: "paymentPending", payments: [] } });
    ok(
      "submit: paymentPending → still requires_action",
      (await submit({ sessionResult: "r" })).status === "requires_action",
    );
    answer = () => ({ body: { ...completed, additionalData: {} } });
    ok(
      "submit: completed with no token → not yet authorized",
      (await submit({ sessionResult: "r" })).status === "requires_action",
    );
    answer = () => ({
      body: {
        ...completed,
        status: "paymentPending",
        payments: [{ pspReference: "PSPXXXXXXXXXXX07", resultCode: "Received" }],
      },
    });
    const sepaSetup = await submit({ sessionResult: "r" });
    ok(
      "submit: a SEPA setup still Received but tokenised → authorized (the IBAN is stored)",
      sepaSetup.status === "authorized" &&
        decodeStoredMethod(sepaSetup.gatewayIntentId ?? "")?.setupPsp === "PSPXXXXXXXXXXX07",
      JSON.stringify(sepaSetup),
    );
    answer = () => ({
      body: {
        ...completed,
        status: "paymentPending",
        payments: [{ pspReference: "PSPXXXXXXXXXXX07", resultCode: "Received" }],
        additionalData: {},
      },
    });
    ok(
      "submit: a pending setup with no token yet → requires_action",
      (await submit({ sessionResult: "r" })).status === "requires_action",
    );

    answer = () => ({
      body: {
        merchantAccount: "TestMerchantECOM",
        shopperReference: "cus_XXXXXXXXXXXX01",
        storedPaymentMethods: [
          {
            id: "TOKENXXXXXXXXX02",
            brand: "mc",
            lastFour: "1111",
            expiryMonth: "03",
            expiryYear: "30",
            type: "scheme",
            supportedRecurringProcessingModels: ["Subscription"],
          },
        ],
      },
    });
    const consumed = await p.consumeIntent({
      intentId: done.gatewayIntentId!,
      idempotencyKey: "k",
      purpose: "setup",
    });
    ok(
      "consume setup: the stored card, bound to its shopper reference",
      consumed.purpose === "setup" &&
        consumed.paymentMethod?.providerPaymentMethodId === "TOKENXXXXXXXXX02" &&
        consumed.paymentMethod.providerCustomerId === "cus_XXXXXXXXXXXX01" &&
        consumed.paymentMethod.display.last4 === "1111" &&
        last().url.includes("shopperReference=cus_XXXXXXXXXXXX01"),
    );
    ok(
      "consume before the browser answered throws",
      (await throws(() =>
        p.consumeIntent({ intentId: setup.intentId, idempotencyKey: "k", purpose: "setup" }),
      )) != null,
    );
    const v = await p.vaultPaymentMethod({ customer, token: "TOKENXXXXXXXXX02" });
    ok(
      "vault: a bare token of this customer is read back",
      v.providerPaymentMethodId === "TOKENXXXXXXXXX02",
    );
    ok(
      "vault: an unknown token is refused",
      (await throws(() => p.vaultPaymentMethod({ customer, token: "NOPE" }))) instanceof
        ProviderRefusalError,
    );
    ok(
      "fetchVaultedPaymentMethod: unknown → null",
      (await p.fetchVaultedPaymentMethod({
        providerCustomerId: "cus_X",
        providerPaymentMethodId: "NOPE",
      })) === null,
    );
    ok(
      "voiding a setup holds nothing",
      JSON.stringify(
        await p.voidIntent({ intentId: done.gatewayIntentId!, idempotencyKey: "k" }),
      ) === '{"voided":true,"held":false}',
    );

    // payment session → browser → capture / cancel
    answer = () => ({ status: 201, body: { id: "CSXXXXXXXXXXXXXXXXXX03", sessionData: "s3" } });
    const pay = await p.createIntent({
      purpose: "payment",
      amountMinor: 2500n,
      currency: "USD",
      customer,
      idempotencyKey: "pi_pay_1",
      ownershipRef: "pi_XXXXXXXXXXXX03",
      returnUrl: "https://shop.example.com/return",
    });
    const pc = last();
    ok(
      "pay now: a manual-capture session, nothing stored",
      (pc.body.additionalData as Record<string, string>).manualCapture === "true" &&
        pc.body.storePaymentMethodMode === undefined &&
        pc.body.reference === "tmp:pi_XXXXXXXXXXXX03" &&
        pay.authorization?.sdk?.params.amount === "25.00",
    );
    ok(
      "pay now: the session offers cards and Google Pay",
      JSON.stringify(pc.body.allowedPaymentMethods) === '["scheme","googlepay"]',
      JSON.stringify(pc.body.allowedPaymentMethods),
    );
    answer = () => ({
      body: {
        id: "CSXXXXXXXXXXXXXXXXXX03",
        status: "completed",
        payments: [
          {
            pspReference: "PSPXXXXXXXXXXX07",
            resultCode: "Authorised",
            amount: { currency: "USD", value: 2500 },
            paymentMethod: { brand: "visa", type: "googlepay" },
          },
        ],
      },
    });
    const auth2 = await p.submitClientResult({
      intentId: pay.intentId,
      purpose: "payment",
      clientResult: { sessionResult: "r" },
      idempotencyKey: "k",
    });
    ok(
      "pay now: authorized by pspReference with the amount Adyen reports",
      auth2.status === "authorized" &&
        auth2.gatewayIntentId === "PSPXXXXXXXXXXX07" &&
        auth2.amountMinor === 2500n,
    );
    ok(
      "pay now: a Google Pay payment reports methodUsed google_pay from the session result",
      auth2.methodUsed === "google_pay",
      String(auth2.methodUsed),
    );

    // Apple Pay pay-now on a payment link (Adyen's page and certificate)
    answer = () => ({
      status: 201,
      body: {
        id: "PLXXXXXXXXXXXXXX01",
        url: "https://test.adyen.link/PLXXXXXXXXXXXXXX01",
        status: "active",
      },
    });
    const link = await p.createIntent({
      purpose: "payment",
      amountMinor: 2500n,
      currency: "USD",
      customer,
      idempotencyKey: "pi_create_pi_XXXXXXXXXXXX09_a1",
      ownershipRef: "pi_XXXXXXXXXXXX09",
      returnUrl: "https://shop.example.com/return",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      hostedWallet: "apple_pay",
    });
    const lc = last();
    ok(
      "apple pay: a one-time payment link restricted to applepay, held, tagged with our ref",
      lc.url.endsWith("/paymentLinks") &&
        JSON.stringify(lc.body.allowedPaymentMethods) === '["applepay"]' &&
        lc.body.reference === "tmh:pi_XXXXXXXXXXXX09" &&
        lc.body.manualCapture === true &&
        lc.body.reusable === false &&
        (lc.body.metadata as Record<string, string>).tmbilling_ref === "pi_XXXXXXXXXXXX09" &&
        JSON.stringify(lc.body.amount) === '{"value":2500,"currency":"USD"}' &&
        lc.body.expiresAt === "2030-01-01T00:00:00.000Z" &&
        !!lc.headers["Idempotency-Key"],
      JSON.stringify(lc.body),
    );
    ok(
      "apple pay: the buyer is redirected to the link; the intent is the link id",
      link.intentId === "adypl_PLXXXXXXXXXXXXXX01" &&
        link.authorization?.mode === "redirect" &&
        link.authorization.approvalUrl === "https://test.adyen.link/PLXXXXXXXXXXXXXX01",
    );
    answer = () => ({
      status: 422,
      body: { errorCode: "905_3", message: "Unsupported payment method" },
    });
    ok(
      "apple pay: a 422 on the link is a refusal that says what to enable",
      (await throws(() =>
        p.createIntent({
          purpose: "payment",
          amountMinor: 2500n,
          currency: "USD",
          customer,
          idempotencyKey: "pi_create_pi_XXXXXXXXXXXX10_a1",
          returnUrl: "https://shop.example.com/return",
          hostedWallet: "apple_pay",
        }),
      )) instanceof ProviderRefusalError,
    );
    ok(
      "apple pay: consuming the link before its webhook names the payment throws",
      (await throws(() =>
        p.consumeIntent({
          intentId: link.intentId,
          idempotencyKey: "k",
          purpose: "payment",
          amountMinor: 2500n,
          currency: "USD",
        }),
      )) instanceof Error,
    );
    const linkReads: string[] = [];
    answer = (c) => {
      linkReads.push(`${c.method} ${c.url.split("/").slice(-1)[0]}`);
      return {
        status: 200,
        body: { id: "PLXXXXXXXXXXXXXX01", status: c.method === "PATCH" ? "expired" : "active" },
      };
    };
    const expired = await p.voidIntent({ intentId: link.intentId, idempotencyKey: "k" });
    ok(
      "apple pay: voiding an unpaid link expires it; nothing was held",
      JSON.stringify(linkReads) === '["GET PLXXXXXXXXXXXXXX01","PATCH PLXXXXXXXXXXXXXX01"]' &&
        JSON.stringify(expired) === '{"voided":true,"held":false}',
      JSON.stringify([linkReads, expired]),
    );
    answer = () => ({ status: 200, body: { id: "PLXXXXXXXXXXXXXX01", status: "completed" } });
    const paidLink = await p.voidIntent({ intentId: link.intentId, idempotencyKey: "k" });
    ok(
      "apple pay: a paid link cannot say whether money is held (its webhook names the payment)",
      paidLink.voided && paidLink.held === undefined,
    );
    answer = () => ({
      status: 201,
      body: {
        paymentPspReference: "PSPXXXXXXXXXXX07",
        pspReference: "CAPXXXXXXXXXXX07",
        status: "received",
      },
    });
    const cap = await p.consumeIntent({
      intentId: "PSPXXXXXXXXXXX07",
      idempotencyKey: "pi_consume_1",
      purpose: "payment",
      amountMinor: 2500n,
      currency: "USD",
    });
    ok(
      "capture: posted to the payment's captures with the amount; booked on the payment's psp",
      last().url.endsWith("/payments/PSPXXXXXXXXXXX07/captures") &&
        JSON.stringify(last().body.amount) === '{"value":2500,"currency":"USD"}' &&
        !!last().headers["Idempotency-Key"] &&
        cap.purpose === "payment" &&
        cap.charge.status === "succeeded" &&
        cap.charge.providerChargeId === "PSPXXXXXXXXXXX07",
    );
    answer = () => ({
      status: 201,
      body: {
        paymentPspReference: "PSPXXXXXXXXXXX07",
        pspReference: "CNXXXXXXXXXXXX07",
        status: "received",
      },
    });
    const voided = await p.voidIntent({
      intentId: "PSPXXXXXXXXXXX07",
      idempotencyKey: "pi_void_1",
    });
    ok(
      "void: cancels the authorisation",
      voided.voided &&
        voided.providerTransactionId === "CNXXXXXXXXXXXX07" &&
        last().url.endsWith("/payments/PSPXXXXXXXXXXX07/cancels"),
    );
    ok(
      "void: an unused session says nothing about a hold",
      (await p.voidIntent({ intentId: pay.intentId, idempotencyKey: "k" })).held === undefined,
    );

    // stored-card intent
    answer = () => ({ body: { pspReference: "PSPXXXXXXXXXXX08", resultCode: "Authorised" } });
    const held = await p.createIntent({
      purpose: "payment",
      amountMinor: 900n,
      currency: "USD",
      customer,
      paymentMethod: pm,
      idempotencyKey: "pi_h",
    });
    ok(
      "a stored-card intent is authorised now with manual capture",
      held.status === "authorized" &&
        held.intentId === "PSPXXXXXXXXXXX08" &&
        (last().body.additionalData as Record<string, string>).manualCapture === "true" &&
        last().body.shopperInteraction === "ContAuth",
    );

    // refunds
    answer = () => ({
      status: 201,
      body: { pspReference: "RFXXXXXXXXXXXX09", status: "received" },
    });
    const part = await p.refund({
      providerChargeId: "PSPXXXXXXXXXXX03",
      amountMinor: 500n,
      currency: "USD",
      idempotencyKey: "re1",
      ownershipRef: "re_X",
    });
    ok(
      "partial refund: pending, by the refund's pspReference",
      part.status === "pending" &&
        part.providerRefundId === "RFXXXXXXXXXXXX09" &&
        last().url.endsWith("/payments/PSPXXXXXXXXXXX03/refunds") &&
        last().body.reference === "tmf:re_X",
    );
    await p.refund({ providerChargeId: "PSPXXXXXXXXXXX03", idempotencyKey: "re2" });
    ok(
      "full refund: a reversal, no amount",
      last().url.endsWith("/reversals") && last().body.amount === undefined,
    );
    ok(
      "partial refund without the currency throws",
      (await throws(() =>
        p.refund({ providerChargeId: "P", amountMinor: 1n, idempotencyKey: "x" }),
      )) != null,
    );
    answer = () => ({
      status: 422,
      body: {
        status: 422,
        errorCode: "167",
        message: "Original pspReference required for this operation",
      },
    });
    ok(
      "a refund Adyen refuses → ProviderRefusalError",
      (await throws(() =>
        p.refund({ providerChargeId: "P", amountMinor: 1n, currency: "USD", idempotencyKey: "x" }),
      )) instanceof ProviderRefusalError,
    );

    // SEPA Direct Debit on a stored mandate.
    const sepaPm = { ...pm, display: { type: "sepa_debit" as const } };
    answer = () => ({
      body: {
        pspReference: "PSPXXXXXXXXXXX30",
        resultCode: "Authorised",
        merchantReference: "tmc:pay_XXXXXXXXXXXX01",
        amount: { currency: "EUR", value: 1999 },
        paymentMethod: { type: "sepadirectdebit" },
      },
    });
    const sr = await p.charge({ ...chargeIn, currency: "eur", paymentMethod: sepaPm });
    const sb = last().body;
    ok(
      "charge (SEPA): type sepadirectdebit on the stored id, ContAuth + Subscription, EUR",
      sr.status === "succeeded" &&
        sr.methodUsed === "sepa_debit" &&
        (sb.paymentMethod as { type?: string }).type === "sepadirectdebit" &&
        sb.shopperInteraction === "ContAuth" &&
        sb.recurringProcessingModel === "Subscription" &&
        (sb.amount as { currency?: string }).currency === "EUR",
      JSON.stringify(sb),
    );
    answer = () => ({
      body: {
        pspReference: "PSPXXXXXXXXXXX31",
        resultCode: "Received",
        merchantReference: "tmc:x",
      },
    });
    ok(
      "charge (SEPA): Received → pending; the verdict comes by webhook",
      (await p.charge({ ...chargeIn, currency: "EUR", paymentMethod: sepaPm })).status ===
        "pending",
    );
    const callsBefore = calls.length;
    ok(
      "charge (SEPA) in USD is refused before any call",
      (await throws(() =>
        p.charge({ ...chargeIn, currency: "USD", paymentMethod: sepaPm }),
      )) instanceof ProviderRefusalError && calls.length === callsBefore,
    );
    answer = () => ({
      body: {
        pspReference: "PSPXXXXXXXXXXX32",
        resultCode: "Authorised",
        merchantReference: "tmc:pay_XXXXXXXXXXXX01",
        amount: { currency: "EUR", value: 1999 },
      },
    });
    await p.locateCharge!({
      ownershipRef: "pay_XXXXXXXXXXXX01",
      idempotencyKey: "k_sepa",
      amountMinor: 1999n,
      currency: "EUR",
      createdAfter: new Date(),
      paymentMethod: {
        providerPaymentMethodId: "TOKENXXXXXXXXX01",
        providerCustomerId: "cus_XXXXXXXXXXXX01",
        type: "sepa_debit",
      },
      replay: { initiator: { by: "merchant", recurring: true } },
    });
    ok(
      "locateCharge (SEPA): the replay rebuilds the body with type sepadirectdebit",
      (last().body.paymentMethod as { type?: string }).type === "sepadirectdebit",
    );
    answer = () => ({
      body: {
        merchantAccount: "TestMerchantECOM",
        shopperReference: "cus_XXXXXXXXXXXX01",
        storedPaymentMethods: [
          {
            id: "TOKENXXXXXXXXX09",
            type: "sepadirectdebit",
            iban: "NL98ABNA0410108103",
            ownerName: "Conformance Payer",
            supportedRecurringProcessingModels: ["Subscription", "UnscheduledCardOnFile"],
          },
        ],
      },
    });
    const sv = await p.vaultPaymentMethod({
      customer,
      token: encodeStoredMethod("cus_XXXXXXXXXXXX01", "TOKENXXXXXXXXX09", "PSPXXXXXXXXXXX33"),
    });
    ok(
      "vault (SEPA): a SEPA Core mandate in EUR, the setup pspReference as its reference",
      sv.display.type === "sepa_debit" &&
        sv.display.last4 === "8103" &&
        sv.mandate?.rail === "sepa_core" &&
        sv.mandate.currency === "EUR" &&
        sv.mandate.reference === "PSPXXXXXXXXXXX33",
      JSON.stringify(sv),
    );
    answer = () => ({ body: { id: "CSXXXXXXXXXXXXXXXXXX09", sessionData: "Ab02" } });
    await p.initiateVaultSetup({
      customer,
      returnUrl: "https://portal.example.com/r",
      cancelUrl: "https://portal.example.com/c",
      methodTypes: ["card", "sepa_debit"],
      currency: "EUR",
      ownershipRef: "pi_XXXXXXXXXXXX09",
    });
    ok(
      "setup session (EUR, card + SEPA): Drop-in offers scheme and sepadirectdebit",
      (last().body.allowedPaymentMethods as string[]).join() === "scheme,sepadirectdebit" &&
        last().body.storePaymentMethodMode === "enabled" &&
        last().body.recurringProcessingModel === "Subscription",
      JSON.stringify(last().body),
    );

    // webhook provisioning
    const seen: string[] = [];
    answer = (c) => {
      seen.push(`${c.method} ${c.url.replace(/^https:\/\/[^/]+/, "")}`);
      if (c.method === "GET") return { body: { data: [] } };
      if (c.url.endsWith("/generateHmac")) return { body: { hmacKey: OTHER_KEY } };
      return { body: { id: "WBHKXXXXXXXXXXXXXXXXXXXXXXXXXX01", type: "standard", active: true } };
    };
    const prov = await p.provisionWebhookEndpoint({
      url: "https://api.example.com/v1/gateway_webhooks/adyen?id=gwa_X",
    });
    ok(
      "provision: create a standard JSON webhook, then mint its HMAC key",
      prov.webhookSecret === OTHER_KEY &&
        prov.providerEndpointId === "WBHKXXXXXXXXXXXXXXXXXXXXXXXXXX01" &&
        seen.join(" | ") ===
          "GET /v3/merchants/TestMerchantECOM/webhooks?pageSize=100 | POST /v3/merchants/TestMerchantECOM/webhooks | POST /v3/merchants/TestMerchantECOM/webhooks/WBHKXXXXXXXXXXXXXXXXXXXXXXXXXX01/generateHmac",
      seen.join(" | "),
    );
    const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/webhooks"))!;
    ok(
      "provision: the webhook is JSON, active, and names chargeback reversals' payment",
      created.body.communicationFormat === "json" &&
        created.body.active === true &&
        JSON.stringify(created.body.additionalSettings).includes(
          "includeOriginalReferenceForChargebackReversed",
        ),
    );
    seen.length = 0;
    answer = (c) => {
      seen.push(c.method);
      if (c.method === "GET")
        return {
          body: {
            data: [
              {
                id: "WBHK_EXISTING",
                type: "standard",
                url: "https://api.example.com/x",
                active: true,
              },
            ],
          },
        };
      return { body: { hmacKey: DOC_KEY } };
    };
    const again = await p.provisionWebhookEndpoint({ url: "https://api.example.com/x" });
    ok(
      "provision: an existing webhook for the URL is reused (new HMAC key, no second webhook)",
      again.providerEndpointId === "WBHK_EXISTING" && seen.join() === "GET,POST",
    );
    answer = () => ({ status: 403, body: {} });
    ok(
      "provision: a credential without the webhook role gets a clear message",
      /Webhooks read and write/.test(
        String(await throws(() => p.provisionWebhookEndpoint({ url: "https://x" }))),
      ),
    );

    // delete
    answer = () => ({
      status: 422,
      body: { status: 422, errorCode: "803", message: "PaymentDetail not found" },
    });
    ok(
      "delete: a card already gone resolves",
      (await throws(() => p.deletePaymentMethod({ customer, paymentMethod: pm }))) === null,
    );
    answer = () => ({ status: 204 });
    await p.deletePaymentMethod({ customer, paymentMethod: pm });
    ok(
      "delete: scoped by merchant account and shopper reference",
      last().method === "DELETE" &&
        last().url.includes(
          "/storedPaymentMethods/TOKENXXXXXXXXX01?merchantAccount=TestMerchantECOM&shopperReference=cus_XXXXXXXXXXXX01",
        ),
    );
    // healthCheck: paymentMethods, then the credential's Allowed origins.
    let origins: { status?: number; body?: unknown } = {
      body: { data: [{ id: "S2-X", domain: "https://portal.example.com" }] },
    };
    const hcSeen: string[] = [];
    answer = (c) => {
      hcSeen.push(`${c.method} ${c.url.replace(/^https:\/\/[^/]+/, "")}`);
      if (c.url.endsWith("/me/allowedOrigins")) return origins;
      if (c.url.endsWith("/me")) return { body: { id: "CRED_X", username: "ws@Company.Example" } };
      return { body: { paymentMethods: [{ type: "scheme" }] } };
    };
    const STORE = { storefrontOrigins: ["https://portal.example.com"] };
    const hOk = await p.healthCheck(STORE);
    ok(
      "healthCheck: paymentMethods, then the credential's Allowed origins and name",
      hcSeen.join(" | ") === "POST /v71/paymentMethods | GET /v3/me/allowedOrigins | GET /v3/me",
      hcSeen.join(" | "),
    );
    ok(
      "healthCheck: the storefront origin is allowed → ok, check ok",
      hOk.ok === true &&
        hOk.checks?.[0]?.key === "allowed_origins" &&
        hOk.checks[0].status === "ok",
      JSON.stringify(hOk),
    );
    ok(
      "healthCheck: an origin matches case-insensitively and with a trailing slash",
      (await p.healthCheck({ storefrontOrigins: ["HTTPS://Portal.Example.com/portal/x"] }))
        .checks?.[0]?.status === "ok",
    );
    origins = { body: { data: [{ id: "S2-Y", domain: "https://other.example.com" }] } };
    const hMissing = await p.healthCheck(STORE);
    const steps = hMissing.checks?.[0]?.steps ?? [];
    ok(
      "healthCheck: a missing origin fails the account and is named",
      hMissing.ok === false &&
        hMissing.checks?.[0]?.status === "failed" &&
        hMissing.detail?.includes("https://portal.example.com") === true,
      JSON.stringify(hMissing),
    );
    ok(
      "healthCheck: the steps name the Customer Area, the credential and the origin to add",
      steps[0]?.includes("https://ca-test.adyen.com") === true &&
        steps[1]?.includes("ws@Company.Example") === true &&
        steps.some((s) => s.includes("Allowed origins, enter https://portal.example.com")),
      JSON.stringify(steps),
    );
    origins = { body: {} };
    ok(
      "healthCheck: an empty Allowed origins list (Adyen answers {}) names the origin",
      (await p.healthCheck(STORE)).checks?.[0]?.status === "failed",
    );
    ok(
      "healthCheck: a port is part of the origin",
      (
        await p.healthCheck({ storefrontOrigins: ["http://localhost:4100"] })
      ).checks?.[0]?.message.includes("http://localhost:4100") === true,
    );
    origins = { status: 403, body: {} };
    const hRole = await p.healthCheck(STORE);
    ok(
      "healthCheck: no permission to read Allowed origins → said plainly, the account stays ok",
      hRole.ok === true &&
        hRole.checks?.[0]?.status === "unchecked" &&
        /no Management API role/.test(hRole.checks[0].message),
      JSON.stringify(hRole),
    );
    origins = { status: 500, body: {} };
    const hDown = await p.healthCheck(STORE);
    ok(
      "healthCheck: an unanswered origins read → unchecked, the account stays ok",
      hDown.ok === true && hDown.checks?.[0]?.status === "unchecked",
    );
    origins = { body: { data: [] } };
    const hNoStore = await p.healthCheck({});
    ok(
      "healthCheck: no storefront address → unchecked, never a false failure",
      hNoStore.ok === true &&
        hNoStore.checks?.[0]?.status === "unchecked" &&
        /PORTAL_BASE_URL/.test(hNoStore.checks[0].message),
    );
    ok(
      "healthCheck: a live account points at the live Customer Area",
      adyenAllowedOriginsCheck({
        allowed: [],
        storefront: ["https://portal.example.com"],
        livemode: true,
      }).steps?.[0]?.includes("https://ca-live.adyen.com") === true,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

await closeDb().catch(() => undefined);
const failed = checks.filter(([, c]) => !c);
for (const [name, c, detail] of checks)
  console.log(`  ${c ? "✓" : "✗"} ${name}${!c && detail ? ` — ${detail}` : ""}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks`);
console.log(failed.length === 0 ? "✅ ADYEN: PASS" : "❌ ADYEN: FAIL");
process.exit(failed.length === 0 ? 0 : 1);
