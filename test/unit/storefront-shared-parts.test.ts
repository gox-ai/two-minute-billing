import { describe, expect, it } from "vitest";
import geo from "../../db/seed-data/geo.json";
// Relative, not `@/…`: these live in the dashboard app and the root `@/` alias points at src/.
import {
  cardNetworksHint,
  countryOptions,
  privacyText,
  railsForCurrency,
  sdkAmountLabel,
  supportEmail,
  websiteLink,
} from "../../dashboard/app/(storefront)/storefront-text";
import { postalExample, postalNoun } from "../../dashboard/components/customers/postal-example";
import {
  groupPricing,
  offerSentence,
  optionFor,
  yearlySaving,
  type PricedLink,
} from "../../dashboard/app/(storefront)/pricing/[biz]/plans";

const link = (
  id: string,
  product: string,
  interval: string | null,
  amountMinor: number | null,
  extra: Partial<PricedLink["price"]> = {},
): PricedLink => ({
  id,
  name: product,
  mode: interval ? "create" : "purchase",
  product: { id: `prod_${product}`, name: product },
  description: null,
  price: {
    amount: `$${(amountMinor ?? 0) / 100}`,
    currency: "USD",
    amount_minor: amountMinor,
    interval,
    interval_count: 1,
    model: "flat",
    ...extra,
  },
});

describe("method chooser by currency", () => {
  it("offers UPI only to a buyer paying in rupees", () => {
    expect(railsForCurrency(["card", "upi"], "USD")).toEqual(["card"]);
    expect(railsForCurrency(["card", "upi"], "inr")).toEqual(["card", "upi"]);
    expect(railsForCurrency(["card", "upi"], null)).toEqual(["card", "upi"]);
  });
  it("names RuPay for rupees only", () => {
    expect(cardNetworksHint("INR")).toContain("RuPay");
    expect(cardNetworksHint("USD")).not.toContain("RuPay");
  });
});

describe("hosted page text", () => {
  it("states who never sees the card without a possessive", () => {
    expect(privacyText("Halyard Analytics")).toBe(
      "Your card details go directly to the payment provider. Halyard Analytics never sees them.",
    );
    expect(privacyText("Halyard Analytics", "bank")).toMatch(/^Your bank account details/);
  });
  it("shows a gateway amount in the page's money format", () => {
    expect(sdkAmountLabel("29.00", "USD")).toBe("$29.00");
    expect(sdkAmountLabel("1990.5", "usd")).toBe("$1,990.50");
    expect(sdkAmountLabel(undefined, "USD")).toBeNull();
    expect(sdkAmountLabel("abc", "USD")).toBeNull();
  });
  it("links only an http(s) website", () => {
    expect(websiteLink("halyard.example.com")).toEqual({
      href: "https://halyard.example.com/",
      label: "halyard.example.com",
    });
    expect(websiteLink("https://www.example.com/help/")?.label).toBe("example.com/help");
    expect(websiteLink("javascript:alert(1)")).toBeNull();
    expect(websiteLink("")).toBeNull();
    expect(supportEmail("help@example.com")).toBe("help@example.com");
    expect(supportEmail("not an email")).toBeNull();
  });
  it("lists countries by name and leaves out regions that are not countries", () => {
    const list = countryOptions();
    expect(list.find((c) => c.value === "US")?.label).toBe("United States");
    expect(list.some((c) => ["EU", "UN", "ZZ"].includes(c.value))).toBe(false);
  });
});

describe("postal code example", () => {
  const countries = (geo as unknown as { countries: unknown[] }).countries;
  it("shows a real example for the US instead of the N mask", () => {
    expect(postalExample("US", "NNNNN-NNNN")).toBe("95814");
    expect(postalExample("XX", "LNL NLN")).toBe("A1B 2C3");
    expect(postalExample("XX", null)).toBeNull();
  });
  it("gives every country an example its own pattern accepts", () => {
    const bad: string[] = [];
    for (const raw of countries as Array<Record<string, unknown>>) {
      const mask = (raw.postalHint ?? raw.postal_hint) as string | null;
      const re = (raw.postalRegex ?? raw.postal_regex) as string | null;
      if (!mask || !re) continue;
      const ex = postalExample(raw.code as string, mask)!;
      const body = re.replace(/^\^/, "").replace(/\$$/, "");
      let canonical = ex.toUpperCase();
      for (const ch of ((raw.postalRedundant ?? raw.postal_redundant) as string | null) ?? "")
        canonical = canonical.split(ch).join("");
      if (!new RegExp(`^(?:${body})$`).test(canonical)) bad.push(`${raw.code}:${ex}`);
    }
    expect(bad).toEqual([]);
  });
  it("keeps the capitals of ZIP and PIN inside a sentence", () => {
    expect(postalNoun("ZIP code")).toBe("ZIP code");
    expect(postalNoun("Postal code")).toBe("postal code");
    expect(postalNoun("Eircode")).toBe("Eircode");
  });
});

describe("pricing page grouping", () => {
  const links = [
    link("m1", "Starter", "month", 2900),
    link("y1", "Starter", "year", 29000),
    link("m2", "Pro", "month", 19900),
    link("y2", "Pro", "year", 238800),
    link("o1", "Onboarding", null, 49900),
  ];
  it("puts a product's cadences on one card and one-time products apart", () => {
    const g = groupPricing(links);
    expect(g.plans.map((p) => p.name)).toEqual(["Starter", "Pro"]);
    expect(g.plans[0]!.options.map((o) => o.cadence)).toEqual(["month:1", "year:1"]);
    expect(g.oneTime.map((p) => p.name)).toEqual(["Onboarding"]);
    expect(g.cadences).toEqual(["month:1", "year:1"]);
    expect(optionFor(g.plans[0]!, "year:1").link.id).toBe("y1");
  });
  it("states a yearly saving only when the yearly price is lower", () => {
    const g = groupPricing(links);
    expect(yearlySaving(g.plans[0]!)).toEqual({ amountMinor: 5800, currency: "USD", percent: 16 });
    // 12 × 199.00 = 2388.00: no saving, so none is claimed.
    expect(yearlySaving(g.plans[1]!)).toBeNull();
  });
  it("claims no saving for a metered price", () => {
    const g = groupPricing([
      link("m", "Usage", "month", 100, { model: "usage" }),
      link("y", "Usage", "year", 100, { model: "usage" }),
    ]);
    expect(yearlySaving(g.plans[0]!)).toBeNull();
  });
  it("keeps two links of one product and cadence as two cards", () => {
    const g = groupPricing([
      link("a", "Starter", "month", 2900),
      link("b", "Starter", "month", 3900),
    ]);
    expect(g.plans).toHaveLength(2);
  });
  it("says what an offer takes off and for how long", () => {
    expect(offerSentence(10, 1, [])).toBe("10% off any plan for the first billing period.");
    expect(offerSentence(20, null, ["year"])).toBe(
      "20% off yearly plans for every billing period.",
    );
    expect(offerSentence(15, 3, ["month", "year"])).toBe(
      "15% off monthly and yearly plans for the first 3 billing periods.",
    );
  });
});
