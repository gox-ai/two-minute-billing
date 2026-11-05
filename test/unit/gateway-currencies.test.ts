import { describe, expect, it } from "vitest";
import {
  GATEWAYS,
  REAL_GATEWAY_KEYS,
  gatewayAllowsPurpose,
  gatewaySupportsCurrency,
} from "@/providers/gateway-catalog";
import { gatewayOffered } from "@/providers/conformance";
import { METHOD_CURRENCY } from "@/providers/method-types";
import { CASHFREE_ORDER_CURRENCIES } from "@/providers/cashfree";
import { handlesCurrency } from "@/modules/gateway/router";
import { assertInternationalCurrencies, internationalCurrencies } from "@/modules/gateway/service";

/**
 * ISO 4217 codes in circulation on 2026-10-31, less fund and metal codes. Withdrawn codes
 * (HRK, LTL, SLL, STD, ZMK, ZWD, ZWL, ANG, BGN, VEF, CUC, MRO) and XDR are not here.
 */
const ISO_4217_CURRENT = new Set(
  `AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD
   CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS
   GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW
   KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR
   MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR
   SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX
   USD UYU UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG`.split(/\s+/),
);
/** Sanctioned markets: never offered. */
const SANCTIONED = ["CUP", "IRR", "KPW", "SYP"];

const listed = REAL_GATEWAY_KEYS.filter((k) => GATEWAYS[k].currencies);

describe("gateway currency lists", () => {
  it("every offered gateway has a list", () => {
    for (const k of REAL_GATEWAY_KEYS)
      if (gatewayOffered(k)) expect(GATEWAYS[k].currencies, k).toBeTruthy();
  });

  it.each(listed)("%s: current ISO codes only, sorted, no duplicates", (k) => {
    const list = GATEWAYS[k].currencies!;
    for (const c of list) expect(ISO_4217_CURRENT.has(c), `${k} ${c}`).toBe(true);
    for (const c of SANCTIONED) expect(list).not.toContain(c);
    expect([...list]).toEqual([...new Set(list)].sort());
  });

  // MGA is ISO two-decimal on both sides; Stripe's adapter converts it to whole units.
  it.each(["stripe", "razorpay", "checkoutcom"] as const)("%s: takes MGA", (k) =>
    expect(GATEWAYS[k].currencies).toContain("MGA"),
  );

  it("PayU takes INR only", () => expect(GATEWAYS.payu.currencies).toEqual(["INR"]));

  it("Cashfree takes the six proven order currencies", () => {
    expect([...GATEWAYS.cashfree.currencies!].sort()).toEqual(
      [...CASHFREE_ORDER_CURRENCIES].sort(),
    );
    expect([...GATEWAYS.cashfree.currencies!].sort()).toEqual(
      ["AED", "EUR", "GBP", "INR", "JPY", "USD"].sort(),
    );
  });

  it.each(listed)("%s: intent and method currencies are on the list", (k) => {
    const def = GATEWAYS[k];
    const list = def.currencies!;
    for (const codes of Object.values(def.intentCurrencies ?? {}))
      for (const c of codes) expect(list, `${k} intent ${c}`).toContain(c);
    for (const c of Object.values(def.currencyBoundMethods ?? {}))
      expect(list, `${k} bound ${c}`).toContain(c);
    for (const m of def.advertisedMethods) {
      const c = METHOD_CURRENCY[m];
      if (c) expect(list, `${k} ${m} ${c}`).toContain(c);
    }
  });

  it("an unknown key or a gateway without a list takes any currency", () => {
    expect(gatewaySupportsCurrency("offline", "XYZ")).toBe(true);
    expect(gatewaySupportsCurrency("tmtest", "KWD")).toBe(true);
    expect(gatewaySupportsCurrency("payu", "usd")).toBe(false);
    expect(gatewaySupportsCurrency("payu", "inr")).toBe(true);
  });

  it("intent purposes are unchanged inside the list", () => {
    expect(gatewayAllowsPurpose("cashfree", "payment", "USD")).toBe(true);
    expect(gatewayAllowsPurpose("cashfree", "setup", "USD")).toBe(true);
    expect(gatewayAllowsPurpose("cashfree", "setup", "JPY")).toBe(false);
  });
});

describe("handlesCurrency", () => {
  const acc = (gatewayKey: string, currencies: string[] | null) =>
    ({ gatewayKey, currencies }) as Parameters<typeof handlesCurrency>[0];

  it("an account with no list routes only what its gateway takes", () => {
    expect(handlesCurrency(acc("payu", null), "INR")).toBe(true);
    expect(handlesCurrency(acc("payu", null), "USD")).toBe(false);
    expect(handlesCurrency(acc("stripe", null), "kwd")).toBe(false);
    expect(handlesCurrency(acc("tmtest", null), "KWD")).toBe(true);
  });

  it("an explicit list is honoured as written", () => {
    expect(handlesCurrency(acc("payu", ["USD"]), "USD")).toBe(true);
    expect(handlesCurrency(acc("stripe", ["USD"]), "EUR")).toBe(false);
  });
});

describe("international payments switch", () => {
  it("names the currencies that need it, and only on a switch gateway", () => {
    expect(internationalCurrencies("cashfree", ["inr", "USD", "usd"])).toEqual(["USD"]);
    expect(internationalCurrencies("razorpay", ["INR"])).toEqual([]);
    expect(internationalCurrencies("stripe", ["USD"])).toEqual([]);
  });
  it("an import that lists them is saved with the switch on, which the edit check accepts", () => {
    // The migration sets the switch from `internationalCurrencies`; off, the next edit refuses.
    expect(() => assertInternationalCurrencies("cashfree", false, ["INR", "USD"])).toThrow();
    expect(() => assertInternationalCurrencies("cashfree", true, ["INR", "USD"])).not.toThrow();
  });
});
