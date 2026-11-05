import { describe, it, expect } from "vitest";
import { GATEWAY_KEYS, gatewayCancelsPendingDebits } from "@/providers/gateway-catalog";
import { GATEWAY_FACTORIES } from "@/providers/gateways";

// A drift hides "Cancel pending debit" where it works, or offers it where it cannot.
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

describe("pendingDebitCancel: the catalogue matches every adapter", () => {
  for (const key of GATEWAY_KEYS) {
    it(key, () => {
      const creds =
        key === "checkoutcom"
          ? { ...DUMMY, secret_key: "sk_sbox_x", public_key: "pk_sbox_x" }
          : key === "cybersource"
            ? { ...DUMMY, key_id: "00000000-0000-4000-8000-000000000001" }
            : DUMMY;
      const adapter = GATEWAY_FACTORIES[key].build(creds, {
        businessId: "00000000-0000-0000-0000-000000000000",
        livemode: false,
      });
      const declared =
        adapter.capabilities.pendingDebitCancel === true &&
        typeof adapter.cancelPendingCharge === "function";
      expect(declared).toBe(gatewayCancelsPendingDebits(key));
    });
  }

  it("an unknown key cannot cancel", () => {
    expect(gatewayCancelsPendingDebits("offline")).toBe(false);
    expect(gatewayCancelsPendingDebits(null)).toBe(false);
  });
});
