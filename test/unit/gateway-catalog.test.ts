import { describe, it, expect } from "vitest";
import { GATEWAYS, GATEWAY_KEYS, REAL_GATEWAY_KEYS } from "@/providers/gateway-catalog";
import { GATEWAY_FACTORIES } from "@/providers/gateways";
import { listGatewayCatalog } from "@/modules/gateway/service";

/** Fields whose value has a shape the adapter checks at build time. */
const SHAPED: Record<string, string> = {
  merchant_accounts: "USD",
  secret_key: "sk_sbox_x",
  public_key: "pk_sbox_x",
  processing_channel_id: "pc_x",
  api_prefix: "abcd1234",
  default_country: "US",
  entity_id: "ent_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  signature_key: "ab".repeat(64),
  application_id: "sandbox-sq0idb-XXXXXXXXXXXXXXXXXXXX01",
  location_id: "LXXXXXXXXXXX1",
  // Mollie refuses a key whose test_/live_ prefix does not match the mode (test here).
  api_key: "test_shapedshapedshapedshapedshaped",
  payto_purpose_code: "retail",
  // CyberSource checks both shapes at build time.
  key_id: "00000000-0000-4000-8000-000000000001",
  shared_secret: Buffer.alloc(32, 7).toString("base64"),
};

/** Each gateway's own credential fields, filled with dummies. Nothing here talks to a gateway. */
const dummyCreds = (key: keyof typeof GATEWAYS) =>
  Object.fromEntries(
    GATEWAYS[key].credentialFields.map((f) => [f.key, SHAPED[f.key] ?? `${f.key}_x`]),
  );

describe("gateway catalogue", () => {
  it.each(GATEWAY_KEYS)("%s builds from the credentials its setup form asks for", (key) => {
    const adapter = GATEWAY_FACTORIES[key].build(dummyCreds(key), {
      businessId: "biz_x",
      livemode: false,
    });
    expect(adapter.key).toBe(key);
    // `advertisedMethods` answers "which rails?" without building an adapter; drift is a lie.
    expect([...GATEWAYS[key].advertisedMethods]).toEqual(adapter.capabilities.methods);
    // The dashboard shows the wallet-domain card from this flag.
    expect(GATEWAYS[key].walletDomains ?? false).toBe(
      typeof adapter.registerWalletDomain === "function",
    );
  });

  it.each(GATEWAY_KEYS)("%s offers no method it cannot be routed for", (key) => {
    const can = GATEWAYS[key].advertisedMethods;
    for (const m of GATEWAYS[key].methodOptions) expect(can).toContain(m.value);
  });

  it("only real gateways may be named for a vault or setup", () => {
    expect(REAL_GATEWAY_KEYS).not.toContain("tmtest");
    expect(REAL_GATEWAY_KEYS.length).toBe(
      GATEWAY_KEYS.filter((k) => !GATEWAYS[k].simulated).length,
    );
  });

  it("the API catalogue lists every gateway and no credential values", () => {
    const catalog = listGatewayCatalog();
    expect(catalog.map((g) => g.key)).toEqual(GATEWAY_KEYS);
    expect(JSON.stringify(catalog)).not.toMatch(/_x"/);
  });

  it("braintree merchant accounts are optional; every other field stays required", () => {
    const bt = listGatewayCatalog().find((g) => g.key === "braintree")!;
    expect(bt.credential_fields.filter((f) => f.optional).map((f) => f.key)).toEqual([
      "merchant_accounts",
    ]);
  });

  it("the catalogue says which gateways take the account id in the path", () => {
    const inPath = listGatewayCatalog()
      .filter((g) => g.webhook_account_id_in_path)
      .map((g) => g.key);
    expect(inPath).toEqual(["authorizenet", "payu"]);
  });
});
