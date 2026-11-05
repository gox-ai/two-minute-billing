/**
 * The availability flag, without a database. Fakes go in through the parameters; the checked-in
 * files are only read. What regresses without it: a gateway with open gaps can be connected, a
 * method not proven live reaches buyers, or a typo in `live-proof-pending.json` hides nothing.
 */
import { describe, it, expect } from "vitest";
import { GATEWAYS, isGatewayKey, withholdableMethods } from "@/providers/gateway-catalog";
import {
  GATEWAY_NOT_AVAILABLE_REASON,
  METHOD_NOT_AVAILABLE_REASON,
  conformanceExclusions,
  gatewayOffered,
  knownGapsByGateway,
  liveProofPending,
  methodOffered,
  type PendingMethods,
} from "@/providers/conformance";
import {
  assertGatewayOffered,
  effectiveMethodTypes,
  GatewayError,
  hostedApplePayOffered,
  listGatewayCatalog,
} from "@/modules/gateway/service";
import { pendingMethodProblems } from "../../scripts/conformance/verdict";

const gap = { reason: "r", planRef: "3f x" };
// The real gaps, plus one open row on Adyen.
const adyenGap = { gaps: { ...knownGapsByGateway(), adyen: { "S7.lost": gap } } };
const sepaPending: PendingMethods = { adyen: { sepa_debit: { reason: "r", planRef: "4 x" } } };
const applePending: PendingMethods = { square: { apple_pay: { reason: "r", planRef: "4 x" } } };
const withholdable = (gw: string) => (isGatewayKey(gw) ? withholdableMethods(gw) : null);

describe("gateway level", () => {
  it("a gateway with a gap, or a pending exclusion, is not offered", () => {
    expect(gatewayOffered("adyen", adyenGap)).toBe(false);
    expect(
      gatewayOffered("adyen", {
        gaps: { stripe: {} },
        exclusions: { adyen: { kind: "pending", reason: "No fixtures yet.", planRef: "3e" } },
      }),
    ).toBe(false);
    expect(gatewayOffered("stripe", adyenGap)).toBe(true);
  });

  it("a gateway whose every method waits on its live proof is not offered", () => {
    const all: PendingMethods = {
      mollie: Object.fromEntries(
        GATEWAYS.mollie.advertisedMethods.map((m) => [m, { reason: "r", planRef: "4 x" }]),
      ),
    };
    expect(gatewayOffered("mollie", { pending: all })).toBe(false);
    expect(gatewayOffered("mollie", { pending: {} })).toBe(true);
  });

  it("the test gateway keeps its treatment: offered, with no fixtures", () => {
    expect(gatewayOffered("tmtest")).toBe(true);
  });

  it("refuses a new account, in STE", () => {
    expect(() => assertGatewayOffered("adyen", adyenGap)).toThrow(GatewayError);
    expect(() => assertGatewayOffered("adyen", adyenGap)).toThrow(
      "We could not connect Adyen. It is not available yet.",
    );
    expect(() => assertGatewayOffered("adyen", { gaps: { adyen: {} } })).not.toThrow();
  });

  it("the catalogue keeps the gateway, marked not available", () => {
    const cat = listGatewayCatalog(adyenGap);
    const adyen = cat.find((g) => g.key === "adyen")!;
    expect(adyen.available).toBe(false);
    expect(adyen.unavailable_reason).toBe(GATEWAY_NOT_AVAILABLE_REASON);
    const stripe = cat.find((g) => g.key === "stripe")!;
    expect(stripe.available).toBe(true);
    expect(stripe.unavailable_reason).toBeNull();
  });

  it("today every catalog gateway is offered, except a pending exclusion or no proven method", () => {
    const live = liveProofPending();
    const pending = new Set([
      ...Object.entries(conformanceExclusions())
        .filter(([, e]) => e.kind === "pending")
        .map(([k]) => k),
      ...Object.values(GATEWAYS)
        .filter((g) => g.advertisedMethods.every((m) => live[g.key]?.[m]))
        .map((g) => g.key),
    ]);
    for (const g of listGatewayCatalog())
      expect([g.key, g.available]).toEqual([g.key, !pending.has(g.key)]);
  });

  it("PayU offers cards and UPI Autopay; net banking waits on its live proof", () => {
    expect(gatewayOffered("payu")).toBe(true);
    expect(methodOffered("payu", "card")).toBe(true);
    expect(methodOffered("payu", "upi")).toBe(true);
    expect(methodOffered("payu", "bank_transfer")).toBe(false);
  });

  it("CyberSource is coming soon: listed, and a new account is refused", () => {
    for (const key of ["cybersource"]) {
      expect(gatewayOffered(key)).toBe(false);
      expect(listGatewayCatalog().find((g) => g.key === key)?.available).toBe(false);
      expect(() => assertGatewayOffered(key)).toThrow(GatewayError);
    }
  });
});

describe("method level", () => {
  const adyen = { gatewayKey: "adyen", methodTypes: null };

  it("a pending method leaves the buyer list; the gateway's other methods stay", () => {
    expect(effectiveMethodTypes(adyen, "EUR", "setup", {})).toEqual(["card", "sepa_debit"]);
    expect(effectiveMethodTypes(adyen, "EUR", "setup", sepaPending)).toEqual(["card"]);
    expect(effectiveMethodTypes(adyen, "EUR", "payment", sepaPending)).toEqual(["card"]);
    // An operator who enabled it does not bring it back.
    const pinned = { gatewayKey: "adyen", methodTypes: ["card", "sepa_debit"] };
    expect(effectiveMethodTypes(pinned, "EUR", "setup", sepaPending)).toEqual(["card"]);
    // Other gateways with the same method are untouched.
    const mollie = { gatewayKey: "mollie", methodTypes: null };
    expect(effectiveMethodTypes(mollie, "EUR", "setup", sepaPending)).toContain("sepa_debit");
  });

  it("hosted Apple Pay is not offered while pending", () => {
    expect(hostedApplePayOffered("square", {})).toBe(true);
    expect(hostedApplePayOffered("square", applePending)).toBe(false);
    expect(hostedApplePayOffered("adyen", applePending)).toBe(true);
    expect(hostedApplePayOffered("stripe", {})).toBe(false);
  });

  it("the catalogue keeps the method option, marked not available", () => {
    const sepa = listGatewayCatalog({ pending: sepaPending })
      .find((g) => g.key === "adyen")!
      .method_types.find((m) => m.value === "sepa_debit")!;
    expect(sepa.available).toBe(false);
    expect(sepa.unavailable_reason).toBe(METHOD_NOT_AVAILABLE_REASON);
  });

  it("the checked-in list withholds what the plan names", () => {
    expect(methodOffered("adyen", "sepa_debit")).toBe(false);
    expect(methodOffered("checkoutcom", "apple_pay")).toBe(false);
    expect(methodOffered("square", "apple_pay")).toBe(false);
    expect(methodOffered("adyen", "card")).toBe(true);
  });
});

describe("live-proof-pending.json guard", () => {
  it("finds a gateway or method the catalog does not have", () => {
    const typo: PendingMethods = {
      adyn: { sepa_debit: { reason: "r", planRef: "4 x" } },
      adyen: { sepa: { reason: "r", planRef: "4 x" } },
      square: { apple_pay: { reason: "", planRef: "4 x" } },
      stripe: { apple_pay: { reason: "r", planRef: "4 x" } },
    };
    const problems = pendingMethodProblems(typo, withholdable);
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/"adyn" is not a gateway/);
    expect(problems.join("\n")).toMatch(/adyen has no method "sepa"/);
    expect(problems.join("\n")).toMatch(/square\.apple_pay needs a reason/);
    // Stripe's wallet buttons are not a hosted page: the flag cannot withhold them.
    expect(problems.join("\n")).toMatch(/stripe has no method "apple_pay"/);
  });

  it("the checked-in file passes", () => {
    expect(pendingMethodProblems(liveProofPending(), withholdable)).toEqual([]);
  });

  it("the setup copy says 'coming soon' exactly where Apple Pay is pending", () => {
    const pending = liveProofPending();
    for (const g of Object.values(GATEWAYS)) {
      const copy = [g.note ?? "", ...g.methodOptions.map((m) => m.hint ?? "")].join(" ");
      const says = /Apple Pay is coming soon/.test(copy);
      expect([g.key, says]).toEqual([g.key, Boolean(pending[g.key]?.apple_pay)]);
    }
  });
});
