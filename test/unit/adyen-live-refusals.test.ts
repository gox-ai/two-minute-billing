/**
 * Adyen live-payment refusals: a buyer-present refusal reaches the open attempt with its real
 * reason, a dead stored token is a failed charge (not a throw), and SEPA ED05 is a retriable
 * technical failure. Shapes follow Adyen's documented notifications; ids are fakes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdyenProvider, normalizeAdyenItem, type AdyenNotificationItem } from "@/providers/adyen";
import { normalizeAdyenDecline, payerDeclineMessage } from "@/providers/decline-codes";
import type { ChargeInput } from "@/providers/types";

afterEach(() => vi.unstubAllGlobals());

const PSP = "PSPXXXXXXXXXXX01";
const item = (over: Partial<AdyenNotificationItem>): AdyenNotificationItem => ({
  eventCode: "AUTHORISATION",
  success: "false",
  pspReference: PSP,
  merchantAccountCode: "LiveRefusalsECOM",
  merchantReference: "tmp:pi_XXXXXXXXXXXX01",
  amount: { value: 1500, currency: "EUR" },
  eventDate: "2026-11-17T10:00:00+01:00",
  additionalData: {},
  ...over,
});
const map = (over: Partial<AdyenNotificationItem>) => normalizeAdyenItem(item(over), "ev1")[0]!;

function stubFetch(status: number, json: unknown) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(json), { status }));
}
const adyen = () =>
  new AdyenProvider({
    apiKey: "AQErefusals00000000000000000000000000001",
    clientKey: "test_REFUSALS000000000000000000000000001",
    merchantAccount: "LiveRefusalsECOM",
    livemode: false,
    checkoutUrl: "https://checkout.adyen.test/v71",
    sleep: async () => {},
  });
const chargeIn: ChargeInput = {
  amountMinor: 1500n,
  currency: "EUR",
  idempotencyKey: "key_1",
  ownershipRef: "inv_1",
  customer: { providerKey: "adyen", providerCustomerId: "cus_1" },
  paymentMethod: {
    providerKey: "adyen",
    providerPaymentMethodId: "TOKENXXXXXXXXX01",
    providerCustomerId: "cus_1",
    display: { type: "card" },
  },
};

describe("a buyer-present refusal reaches the open attempt", () => {
  it("a Drop-in session refusal is matched on the stored session id and keeps its reason", () => {
    const ev = map({
      reason: "Not enough balance",
      additionalData: { checkoutSessionId: "CSXXXXXXXXXXXX01", refusalReasonRaw: "51 : NSF" },
    });
    expect(ev).toMatchObject({
      type: "charge.failed",
      providerIntentId: "adyses_CSXXXXXXXXXXXX01",
      providerChargeId: PSP,
      ownership: "ours",
      ownershipRef: "pi_XXXXXXXXXXXX01",
      failureCode: "insufficient_funds",
      providerFailureCode: "12",
    });
    expect(ev.failureMessage).toContain("51 : NSF");
    expect(ev.lateReversal).toBeUndefined();
  });

  it("without a session id it still names our reference", () => {
    const ev = map({
      merchantReference: "tms:pi_XXXXXXXXXXXX02",
      reason: "Expired Card",
    });
    expect(ev).toMatchObject({
      type: "charge.failed",
      ownershipRef: "pi_XXXXXXXXXXXX02",
      failureCode: "expired_card",
    });
    expect(ev.providerIntentId).toBeUndefined();
  });

  it("a stored-card hold refusal (no session) still fails the intent by its pspReference", () => {
    const ev = map({ reason: "Refused" });
    expect(ev).toMatchObject({ type: "intent.failed", providerIntentId: PSP });
  });

  it("a payment-link refusal records on adypl_<link> and closes nothing", () => {
    const ev = map({
      merchantReference: "tmh:pi_XXXXXXXXXXXX03",
      reason: "CVC Declined",
      additionalData: { paymentLinkId: "PLXXXXXXXXXXXXXX01" },
    });
    expect(ev).toMatchObject({
      type: "charge.failed",
      providerIntentId: "adypl_PLXXXXXXXXXXXXXX01",
      providerChargeId: PSP,
      failureCode: "incorrect_cvc",
    });
  });

  it("a renewal refusal keeps the raw acquirer text out of the payer's message", () => {
    const ev = map({
      merchantReference: "tmc:pay_XXXXXXXXXXXX01",
      reason: "Refused",
      additionalData: { refusalReasonRaw: "05 : Do not honor" },
    });
    expect(ev.type).toBe("charge.failed");
    expect(ev.failureMessage).toBe("Refused");
  });

  it("a cancelled session result is payment_abandoned, not a decline", async () => {
    stubFetch(200, { id: "CSXXXXXXXXXXXX04", status: "canceled", payments: [] });
    const res = await adyen().submitClientResult({
      intentId: "adyses_CSXXXXXXXXXXXX04",
      purpose: "payment",
      clientResult: { sessionResult: "RESULTXXXX01" },
      idempotencyKey: "k",
    });
    expect(res).toMatchObject({ status: "failed", failure: { code: "payment_abandoned" } });
  });
});

describe("a dead stored token is a failed charge, not a throw", () => {
  it.each([
    ["800", "payment_method_not_found"],
    ["802", "payment_method_not_found"],
    ["803_3", "payment_method_not_found"],
    ["805", "payment_method_not_found"],
    ["26_006", "payment_method_not_found"],
    ["26_002", "card_restricted"],
  ])("errorCode %s → %s, not retriable", async (errorCode, code) => {
    stubFetch(422, { status: 422, errorCode, message: "Refused", errorType: "validation" });
    const res = await adyen().charge(chargeIn);
    expect(res.status).toBe("failed");
    expect(res.failure).toMatchObject({ code, retriable: false, providerCode: `api:${errorCode}` });
    expect(res.failure?.ruleId).toMatch(/^adyen\.code\./);
  });
});

describe("SEPA ED05", () => {
  it("is a retriable processing error, never insufficient funds", () => {
    const f = normalizeAdyenDecline({ code: "sepa:ED05" });
    expect(f).toMatchObject({ code: "processing_error", retriable: true });
    expect(f.ruleId).toBe("adyen.code.sepa_settlement_failed");
  });

  it("the payer reads a generic sentence, not the bank code", () => {
    const [ev] = normalizeAdyenItem(
      item({
        eventCode: "CHARGEBACK",
        success: "true",
        paymentMethod: "sepadirectdebit",
        originalReference: PSP,
        pspReference: "PSPXXXXXXXXXXX02",
        merchantReference: "tmc:pay_XXXXXXXXXXXX01",
        reason: "ED05:SettlementFailed",
        additionalData: { chargebackReasonCode: "ED05" },
      }),
      "ev2",
    );
    expect(ev).toMatchObject({ type: "charge.failed", failureCode: "processing_error" });
    const text = payerDeclineMessage(
      { code: ev!.failureCode, message: ev!.failureMessage },
      "fallback",
    );
    expect(text).not.toMatch(/ED05|funds/i);
  });
});
