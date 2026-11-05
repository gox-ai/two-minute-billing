import { describe, it, expect } from "vitest";
import {
  GATEWAYS,
  GATEWAY_KEYS,
  gatewayAllowsPurpose,
  mandateCurrencyIsAuthoritative,
  operatorRecordsDisputes,
} from "@/providers/gateway-catalog";
import { allowsIntentPurpose } from "@/providers/types";
import { GATEWAY_FACTORIES } from "@/providers/gateways";

/**
 * `GatewayDefinition.disputeFeed` duplicates each adapter's `capabilities.disputeFeed`, so the
 * payment page can decide "may a person record a dispute here?" without decrypting credentials.
 * A drift either hides the action where a chargeback cannot reach us, or offers it where the
 * gateway will also report the dispute and book it twice.
 */
const DUMMY: Record<string, string> = {
  secret_key: "sk_test_x",
  publishable_key: "pk_test_x",
  webhook_secret: "whsec_x",
  key_id: "rzp_test_x",
  key_secret: "secret_x",
  client_id: "id_x",
  client_secret: "secret_x",
  access_token: "sandbox_x",
  merchant_id: "merchant_x",
  public_key: "pk_test_x",
  private_key: "private_x",
  app_id: "app_x",
  api_key: "test_x",
  client_key: "test_x",
  merchant_account: "merchant_x",
  hmac_key: "00",
  processing_channel_id: "pc_x",
  entity_id: "ent_" + "a".repeat(26),
  api_login_id: "login_x",
  transaction_key: "key_x",
  signature_key: "0".repeat(128),
  api_prefix: "abcd1234",
  default_country: "US",
  application_id: "sandbox-sq0idb-x",
  location_id: "LOCATION01",
  profile_id: "pfl_x",
  merchant_key: "key_x",
  merchant_salt: "salt_x",
  organization_id: "org_x",
  shared_secret: Buffer.alloc(32, 7).toString("base64"),
};

/** Gateways that check a credential's shape at build time. */
const shaped = (key: string): Record<string, string> =>
  key === "checkoutcom"
    ? { ...DUMMY, secret_key: "sk_sbox_x", public_key: "pk_sbox_x" }
    : key === "cybersource"
      ? { ...DUMMY, key_id: "00000000-0000-4000-8000-000000000001" }
      : DUMMY;

describe("disputeFeed: the catalogue matches every adapter", () => {
  for (const key of GATEWAY_KEYS) {
    it(key, () => {
      const adapter = GATEWAY_FACTORIES[key].build(shaped(key), {
        businessId: "00000000-0000-0000-0000-000000000000",
        livemode: false,
      });
      expect(adapter.capabilities.disputeFeed !== false).toBe(GATEWAYS[key].disputeFeed !== false);
    });
  }
});

/** `GatewayDefinition.intentPurposes` drives routing; a drift sends a payment to a setup-only gateway. */
describe("intentPurposes: the catalogue matches every adapter", () => {
  for (const key of GATEWAY_KEYS) {
    it(key, () => {
      const adapter = GATEWAY_FACTORIES[key].build(shaped(key), {
        businessId: "00000000-0000-0000-0000-000000000000",
        livemode: false,
      });
      for (const p of ["payment", "setup"] as const)
        expect(gatewayAllowsPurpose(key, p)).toBe(
          allowsIntentPurpose(adapter.capabilities.intentPurposes, p),
        );
    });
  }
});

/** The checkout clamps and filters on the catalogue copy; a drift offers a rail the gateway caps lower. */
describe("mandateCeilingCapMinor: the catalogue matches every adapter", () => {
  for (const key of GATEWAY_KEYS) {
    it(key, () => {
      const adapter = GATEWAY_FACTORIES[key].build(shaped(key), {
        businessId: "00000000-0000-0000-0000-000000000000",
        livemode: false,
      });
      const fromAdapter = Object.fromEntries(
        Object.entries(adapter.capabilities.mandateCeilingCapMinor ?? {}).map(([m, v]) => [
          m,
          Number(v),
        ]),
      );
      expect(fromAdapter).toEqual({ ...(GATEWAYS[key].mandateCeilingCapMinor ?? {}) });
    });
  }
});

/** Candidate selection reads the catalogue copy; a drift refuses or skips a method the gateway would debit. */
describe("mandateCurrencyAuthoritative: the catalogue matches every adapter", () => {
  for (const key of GATEWAY_KEYS) {
    it(key, () => {
      const adapter = GATEWAY_FACTORIES[key].build(shaped(key), {
        businessId: "00000000-0000-0000-0000-000000000000",
        livemode: false,
      });
      expect([...(adapter.capabilities.mandateCurrencyAuthoritative ?? [])].sort()).toEqual(
        [...(GATEWAYS[key].mandateCurrencyAuthoritative ?? [])].sort(),
      );
    });
  }
  it("RazorPay cards are not held to their stored currency; UPI and Cashfree cards are", () => {
    expect(mandateCurrencyIsAuthoritative("razorpay", "card")).toBe(false);
    expect(mandateCurrencyIsAuthoritative("razorpay", "upi")).toBe(true);
    expect(mandateCurrencyIsAuthoritative("cashfree", "card")).toBe(true);
    expect(mandateCurrencyIsAuthoritative("stripe", "card")).toBe(false);
  });
});

/** An adapter with a fixed list must charge every currency the catalogue offers for it. */
describe("currencies: the catalogue fits every adapter's own list", () => {
  for (const key of GATEWAY_KEYS) {
    it(key, () => {
      const adapter = GATEWAY_FACTORIES[key].build(shaped(key), {
        businessId: "00000000-0000-0000-0000-000000000000",
        livemode: false,
      });
      // Braintree's list is the merchant accounts in the credentials, not a fixed one.
      const own = key === "braintree" ? [] : adapter.capabilities.currencies;
      if (own.length === 0) return;
      for (const c of GATEWAYS[key].currencies ?? []) expect(own, `${key} ${c}`).toContain(c);
    });
  }
});

describe("operatorRecordsDisputes", () => {
  it("allows a gateway with no dispute feed", () => {
    expect(operatorRecordsDisputes("authorizenet")).toBe(true);
    expect(operatorRecordsDisputes("tmtest")).toBe(true);
  });
  it("refuses a gateway that reports disputes, and an unknown key", () => {
    expect(operatorRecordsDisputes("stripe")).toBe(false);
    expect(operatorRecordsDisputes("offline")).toBe(false);
    expect(operatorRecordsDisputes(null)).toBe(false);
  });
});
