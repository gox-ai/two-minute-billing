import { describe, expect, it } from "vitest";
// Relative, not `@/…`: these live in the dashboard app and the root `@/` alias points at src/.
import { currencyForCountry } from "../../dashboard/lib/country-currency";
import { signupGatewayKey, signupGatewayName } from "../../dashboard/lib/signup-gateway";

describe("create-business currency preset", () => {
  it.each([
    ["IN", "INR"],
    ["us", "USD"],
    ["DE", "EUR"],
    ["BG", "EUR"],
    ["GB", "GBP"],
    ["EC", "USD"],
  ])("%s presets %s", (country, currency) => {
    expect(currencyForCountry(country)).toBe(currency);
  });

  it.each([null, undefined, "", "ZZ"])("falls back to USD for %p", (country) => {
    expect(currencyForCountry(country)).toBe("USD");
  });

  it("every preset is a currency the picker offers", () => {
    const offered = new Set(Intl.supportedValuesOf("currency"));
    const codes =
      "AD AE AF AG AL AM AO AR AT AU AZ BA BD BE BG BR BY CA CH CL CN CO CZ DE DK EG ES FI FR GB GH HK HU ID IE IL IN IQ IR IT JP KE KR KW KZ LK MA MX MY NG NL NO NZ PE PH PK PL PT QA RO RS RU SA SE SG TH TR TW UA US VN ZA".split(
        " ",
      );
    for (const c of codes) expect(offered.has(currencyForCountry(c)), c).toBe(true);
  });
});

describe("sign-up gateway", () => {
  it("names the gateways a sign-up can pick", () => {
    expect(signupGatewayName("razorpay")).toBe("Razorpay");
    expect(signupGatewayKey("stripe")).toBe("stripe");
  });

  it.each(["other", "none", null, "constructor"])("names nothing for %p", (answer) => {
    expect(signupGatewayName(answer)).toBeNull();
    expect(signupGatewayKey(answer)).toBeNull();
  });
});
