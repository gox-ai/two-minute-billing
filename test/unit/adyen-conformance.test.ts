/**
 * Adyen adapter conformance: currency units, per-refund amounts, the dispute cycles and the
 * same-key replay. Shapes follow Adyen's documented notification items; ids are fakes.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  AdyenApiError,
  AdyenProvider,
  fromAdyenValue,
  normalizeAdyenItem,
  SECOND_CYCLE_SUFFIX,
  toAdyenValue,
  type AdyenNotificationItem,
} from "@/providers/adyen";
import {
  ProviderIndeterminateError,
  ProviderRefusalError,
  type ChargeInput,
} from "@/providers/types";

afterEach(() => vi.unstubAllGlobals());

const PAY = "PSPXXXXXXXXXXX01";
const MOD = "PSPXXXXXXXXXXX02";
const DSP = "PSPXXXXXXXXXXX03";

const item = (over: Partial<AdyenNotificationItem>): AdyenNotificationItem => ({
  merchantAccountCode: "ConformanceMerchantECOM",
  eventDate: "2026-10-27T10:00:00+01:00",
  success: "true",
  pspReference: MOD,
  originalReference: PAY,
  merchantReference: "tmc:inv_1",
  amount: { value: 1500, currency: "USD" },
  ...over,
});
const map = (over: Partial<AdyenNotificationItem>) => normalizeAdyenItem(item(over), "ev1");

describe("currency units", () => {
  it("converts where Adyen's decimals differ from ISO 4217, both ways", () => {
    expect(toAdyenValue(1_000_000n, "IDR")).toBe(10_000);
    expect(toAdyenValue(10_000n, "CVE")).toBe(100);
    expect(toAdyenValue(5000n, "CLP")).toBe(500_000);
    expect(toAdyenValue(5n, "isk")).toBe(500);
    expect(toAdyenValue(1999n, "USD")).toBe(1999);
    expect(fromAdyenValue(10_000, "IDR")).toBe(1_000_000n);
    expect(fromAdyenValue(500_000, "CLP")).toBe(5000n);
    expect(fromAdyenValue(1999, "USD")).toBe(1999n);
  });

  it("refuses an amount Adyen cannot express", () => {
    expect(() => toAdyenValue(150n, "IDR")).toThrow(ProviderRefusalError);
  });

  it("reads notification amounts in our minor units", () => {
    const [ev] = map({ eventCode: "REFUND", amount: { value: 2500, currency: "IDR" } });
    expect(ev?.refunds?.[0]?.amountMinor).toBe(250_000n);
  });
});

describe("refunds carry their own amount", () => {
  it("a dashboard REFUND is one record at its own amount, with no ownership tag", () => {
    const [ev] = map({ eventCode: "REFUND" });
    expect(ev?.type).toBe("charge.refunded");
    expect(ev?.amountRefundedMinor).toBeUndefined();
    expect(ev?.refunds).toEqual([
      { providerRefundId: MOD, amountMinor: 1500n, status: "succeeded" },
    ]);
  });

  it("our refund carries the tag from its reference", () => {
    const [ev] = map({ eventCode: "REFUND", merchantReference: "tmf:ref_7" });
    expect(ev?.refunds?.[0]?.ownershipRef).toBe("ref_7");
  });

  it("CANCEL_OR_REFUND that refunded is a record too", () => {
    const [ev] = map({
      eventCode: "CANCEL_OR_REFUND",
      additionalData: { "modification.action": "refund" },
    });
    expect(ev?.refunds?.[0]?.amountMinor).toBe(1500n);
  });

  it("a REFUND without an amount is never booked as a full refund", () => {
    const [ev] = map({ eventCode: "REFUND", amount: undefined });
    expect(ev?.type).toBe("unknown");
  });
});

describe("payments", () => {
  it("CAPTURE names the authorisation it captures", () => {
    const [ev] = map({ eventCode: "CAPTURE" });
    expect(ev?.providerIntentId).toBe(PAY);
  });

  it("EXPIRE voids the hold; SETTLED_REVERSED is a late reversal", () => {
    expect(map({ eventCode: "EXPIRE" })[0]?.type).toBe("intent.voided");
    const [rev] = map({ eventCode: "SETTLED_REVERSED" });
    expect(rev).toMatchObject({
      type: "charge.reversed",
      providerChargeId: PAY,
      lateReversal: true,
    });
  });
});

describe("disputes", () => {
  const dsp = (eventCode: string, disputeStatus: string) =>
    map({ eventCode, pspReference: DSP, additionalData: { disputeStatus } });

  it("events after CHARGEBACK_REVERSED are a second case on the same payment", () => {
    const second = dsp("SECOND_CHARGEBACK", "Lost");
    expect(second.map((e) => e.type)).toEqual(["dispute.funds_withdrawn", "dispute.lost"]);
    expect(second.every((e) => e.providerDisputeId === DSP + SECOND_CYCLE_SUFFIX)).toBe(true);
    expect(dsp("PREARBITRATION_WON", "Won")[0]?.providerDisputeId).toBe(DSP + SECOND_CYCLE_SUFFIX);
    expect(dsp("CHARGEBACK_REVERSED", "Pending")[0]?.providerDisputeId).toBe(DSP);
  });

  it("maps the closing codes", () => {
    expect(dsp("DISPUTE_DEFENSE_PERIOD_ENDED", "Accepted")[0]).toMatchObject({
      type: "dispute.lost",
      providerDisputeId: DSP,
    });
    expect(dsp("ISSUER_RESPONSE_TIMEFRAME_EXPIRED", "Won")[0]?.type).toBe("dispute.won");
    expect(dsp("SCHEME_ARBITRATION_WON", "Won")[0]?.type).toBe("dispute.won");
    expect(dsp("SCHEME_ARBITRATION_LOST", "Lost")[0]?.type).toBe("dispute.lost");
    expect(dsp("PREARBITRATION_ISSUER_WITHDRAWN", "Won")[0]?.type).toBe("dispute.won");
    expect(dsp("PREARBITRATION_ISSUER_WITHDRAWN", "Pending")[0]?.type).toBe("unknown");
  });
});

type Answer = { status: number; json?: unknown; headers?: Record<string, string> } | "network";

/** Answers `/payments` from `answers` in order; records each call's Idempotency-Key. */
function stubPayments(answers: Answer[]) {
  const keys: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    keys.push(init?.headers?.["Idempotency-Key"] ?? "");
    const a = answers[Math.min(keys.length - 1, answers.length - 1)]!;
    if (a === "network") throw new Error("socket hang up");
    return new Response(JSON.stringify(a.json ?? {}), {
      status: a.status,
      ...(a.headers ? { headers: a.headers } : {}),
    });
  });
  return keys;
}

const adyen = () =>
  new AdyenProvider({
    apiKey: "AQEconformance0000000000000000000000000001",
    clientKey: "test_CONFORMANCE00000000000000000000001",
    merchantAccount: "ConformanceMerchantECOM",
    livemode: false,
    checkoutUrl: "https://checkout.adyen.test/v71",
    sleep: async () => {},
  });
const chargeIn: ChargeInput = {
  amountMinor: 1500n,
  currency: "USD",
  idempotencyKey: "key_1",
  ownershipRef: "inv_1",
  customer: { providerKey: "adyen", providerCustomerId: "cus_1" },
  paymentMethod: {
    providerKey: "adyen",
    providerPaymentMethodId: "CONFXXXXXXXX01",
    providerCustomerId: "cus_1",
    display: { type: "card" },
  },
};
const err704 = (status: number) => ({
  status,
  json: { status, errorCode: "704", message: "Request already processed or in progress" },
});

describe("lost answers and 704", () => {
  it("a lost answer is replayed under the same key and answers the original", async () => {
    const keys = stubPayments([
      "network",
      { status: 200, json: { pspReference: PAY, resultCode: "Authorised" } },
    ]);
    const res = await adyen().charge(chargeIn);
    expect(res).toMatchObject({ status: "succeeded", providerChargeId: PAY });
    expect(keys).toEqual(["key_1", "key_1"]);
  });

  it("704 on 422 with transient-error is retried, then indeterminate", async () => {
    const keys = stubPayments([{ ...err704(422), headers: { "transient-error": "true" } }]);
    await expect(adyen().charge(chargeIn)).rejects.toBeInstanceOf(ProviderIndeterminateError);
    expect(keys).toEqual(["key_1", "key_1", "key_1"]);
  });

  it("704 on 409 is never a definite failure", async () => {
    stubPayments([err704(409)]);
    await expect(adyen().charge(chargeIn)).rejects.toBeInstanceOf(ProviderIndeterminateError);
  });

  it("704 without transient-error is indeterminate at once", async () => {
    const keys = stubPayments([err704(422)]);
    await expect(adyen().charge(chargeIn)).rejects.toBeInstanceOf(ProviderIndeterminateError);
    expect(keys).toHaveLength(1);
  });

  it("any other 422 is definite and not retried", async () => {
    const keys = stubPayments([
      {
        status: 422,
        json: { status: 422, errorCode: "137", message: "Field 'amount' is not valid" },
      },
    ]);
    await expect(adyen().charge(chargeIn)).rejects.toBeInstanceOf(AdyenApiError);
    expect(keys).toHaveLength(1);
  });
});

describe("locateCharge: the same-key replay", () => {
  const locateIn = (
    over: Partial<Parameters<NonNullable<AdyenProvider["locateCharge"]>>[0]> = {},
  ) => ({
    ownershipRef: "inv_1",
    idempotencyKey: "key_1",
    amountMinor: 1500n,
    currency: "USD",
    createdAfter: new Date(Date.now() - 20 * 60_000),
    paymentMethod: { providerPaymentMethodId: "CONFXXXXXXXX01", providerCustomerId: "cus_1" },
    replay: { initiator: { by: "merchant" as const, recurring: true }, email: "payer@example.com" },
    ...over,
  });
  const bodies = () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          pspReference: PAY,
          resultCode: "Authorised",
          merchantReference: "tmc:inv_1",
          amount: { value: 1500, currency: "USD" },
        }),
        { status: 200 },
      );
    });
    return sent;
  };

  it("resends exactly what charge() sent, under the same key, and reads the payment", async () => {
    const sent = bodies();
    await adyen().charge({
      ...chargeIn,
      initiator: { by: "merchant", recurring: true },
      email: "payer@example.com",
    });
    const res = await adyen().locateCharge(locateIn());
    expect(res).toMatchObject({ status: "succeeded", providerChargeId: PAY });
    expect(sent[1]).toEqual(sent[0]);
  });

  it("creates nothing without `replay` or past the key's lifetime", async () => {
    const sent = bodies();
    await expect(adyen().locateCharge(locateIn({ replay: undefined }))).rejects.toThrow();
    await expect(
      adyen().locateCharge(locateIn({ createdAfter: new Date(Date.now() - 7 * 86_400_000) })),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("704, a 4xx and a lost answer throw; it never answers null", async () => {
    stubPayments([err704(422)]);
    await expect(adyen().locateCharge(locateIn())).rejects.toBeInstanceOf(
      ProviderIndeterminateError,
    );
    stubPayments([
      { status: 422, json: { status: 422, errorCode: "803", message: "PaymentDetail not found" } },
    ]);
    await expect(adyen().locateCharge(locateIn())).rejects.toBeInstanceOf(AdyenApiError);
    stubPayments(["network"]);
    await expect(adyen().locateCharge(locateIn())).rejects.toBeInstanceOf(
      ProviderIndeterminateError,
    );
  });

  it("an answer for another reference or amount is not adopted", async () => {
    stubPayments([
      {
        status: 200,
        json: { pspReference: PAY, resultCode: "Authorised", merchantReference: "tmc:inv_2" },
      },
    ]);
    await expect(adyen().locateCharge(locateIn())).rejects.toBeInstanceOf(
      ProviderIndeterminateError,
    );
    stubPayments([
      {
        status: 200,
        json: {
          pspReference: PAY,
          resultCode: "Authorised",
          amount: { value: 1, currency: "USD" },
        },
      },
    ]);
    await expect(adyen().locateCharge(locateIn())).rejects.toBeInstanceOf(
      ProviderIndeterminateError,
    );
  });

  it("a refused replay is a definite decline with its pspReference", async () => {
    stubPayments([
      {
        status: 200,
        json: { pspReference: PAY, resultCode: "Refused", refusalReason: "Not enough balance" },
      },
    ]);
    const res = await adyen().locateCharge(locateIn());
    expect(res).toMatchObject({ status: "failed", providerChargeId: PAY });
  });
});
