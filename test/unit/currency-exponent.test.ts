import { describe, it, expect } from "vitest";
// Relative, not `@/…`: the helper lives in the dashboard app (the only place that
// converts between what an operator types and what the API stores), and the root
// `@/` alias points at src/. It has no imports of its own, so this is safe.
import {
  currencyExponent,
  minorPerMajor,
  toMinor,
  toMajor,
  toMajorInput,
  majorStep,
} from "../../dashboard/lib/money";

/**
 * Every dashboard money field used to hardcode ÷100 / ×100. These tests pin the
 * exponent table, because a wrong exponent is a silent factor-of-100 error in a
 * real charge — typecheck cannot see it and no screen would look broken.
 */
describe("currencyExponent", () => {
  it("defaults to 2 for ordinary currencies", () => {
    for (const c of ["USD", "EUR", "INR", "GBP", "AUD", "SGD"]) {
      expect(currencyExponent(c)).toBe(2);
    }
  });

  it("is 0 for currencies with no minor unit", () => {
    for (const c of ["JPY", "KRW", "VND", "ISK", "CLP", "XOF", "XAF", "XPF", "VUV", "PYG"]) {
      expect(currencyExponent(c)).toBe(0);
    }
  });

  it("is 3 for the Gulf thousandths", () => {
    for (const c of ["KWD", "BHD", "OMR", "JOD", "TND", "LYD", "IQD"]) {
      expect(currencyExponent(c)).toBe(3);
    }
  });

  it("is 4 for four-place fund units", () => {
    expect(currencyExponent("CLF")).toBe(4);
    expect(currencyExponent("UYW")).toBe(4);
  });

  it("accepts lowercase and padded codes, and falls back to 2 on junk", () => {
    expect(currencyExponent("jpy")).toBe(0);
    expect(currencyExponent(" kwd ")).toBe(3);
    expect(currencyExponent("ZZZ")).toBe(2);
    expect(currencyExponent("")).toBe(2);
    expect(currencyExponent(null)).toBe(2);
    expect(currencyExponent(undefined)).toBe(2);
  });
});

describe("minorPerMajor", () => {
  it("is the power of ten the exponent implies", () => {
    expect(minorPerMajor("USD")).toBe(100);
    expect(minorPerMajor("JPY")).toBe(1);
    expect(minorPerMajor("KWD")).toBe(1000);
    expect(minorPerMajor("CLF")).toBe(10_000);
  });
});

describe("toMinor", () => {
  it("scales by the currency exponent, not a fixed 100", () => {
    expect(toMinor(5, "USD")).toBe(500);
    expect(toMinor(5.5, "USD")).toBe(550);
    expect(toMinor(1642, "INR")).toBe(164200);
    // The bug this whole helper exists for: ¥1000 is 1000 minor, not 100000.
    expect(toMinor(1000, "JPY")).toBe(1000);
    expect(toMinor(12.345, "KWD")).toBe(12345);
  });

  it("rounds rather than truncating, so float error cannot reach the API", () => {
    // 0.07 * 100 === 7.000000000000001 in IEEE-754.
    expect(toMinor(0.07, "USD")).toBe(7);
    expect(Number.isInteger(toMinor(0.07, "USD"))).toBe(true);
    // 1.005 * 100 === 100.49999999999999 — must not floor to 100.
    expect(toMinor(1.005, "USD")).toBe(100);
    expect(toMinor(8.29, "USD")).toBe(829);
    expect(toMinor(1.115, "USD")).toBe(112);
  });

  it("round-trips every ordinary amount", () => {
    for (const [major, currency] of [
      [0, "USD"],
      [0.01, "USD"],
      [49.99, "USD"],
      [1642, "INR"],
      [1000, "JPY"],
      [0.001, "KWD"],
    ] as const) {
      expect(toMajor(toMinor(major, currency), currency)).toBeCloseTo(major, 6);
    }
  });
});

describe("toMajor", () => {
  it("divides by the currency exponent", () => {
    expect(toMajor(4900, "USD")).toBe(49);
    expect(toMajor(1000, "JPY")).toBe(1000);
    expect(toMajor(12345, "KWD")).toBe(12.345);
  });
});

describe("toMajorInput", () => {
  it("pads to the currency exponent so a prefilled field reads naturally", () => {
    expect(toMajorInput(4900, "USD")).toBe("49.00");
    expect(toMajorInput(1000, "JPY")).toBe("1000");
    expect(toMajorInput(12345, "KWD")).toBe("12.345");
    expect(toMajorInput(0, "USD")).toBe("0.00");
  });

  it('is empty for a missing amount, never "0" — blank means "full remaining"', () => {
    expect(toMajorInput(null, "USD")).toBe("");
    expect(toMajorInput(undefined, "USD")).toBe("");
  });
});

describe("majorStep", () => {
  it("is one minor unit, so the field cannot accept finer than the currency", () => {
    expect(majorStep("USD")).toBe("0.01");
    expect(majorStep("JPY")).toBe("1");
    expect(majorStep("KWD")).toBe("0.001");
    expect(majorStep("CLF")).toBe("0.0001");
  });
});

/**
 * The two exponent tables must agree.
 *
 * There are two on purpose — `dashboard/lib/money.ts` cannot import from `src/`, and
 * `src/platform/currency.ts` must not import from the dashboard app. Duplication is
 * therefore unavoidable; silent DIVERGENCE is not, and it already happened: the server
 * table was missing ISK, UYI, IQD, LYD and the four-decimal codes entirely, so a
 * gateway payload for any of them was wrong by 100× or 10×. The hosted checkout was
 * separately hardcoding `/100`, which is what surfaced it.
 *
 * This compares them across every code either one knows about, so adding a code to one
 * table and forgetting the other fails here rather than in a charge.
 */
describe("the server and dashboard exponent tables agree", () => {
  it("assigns the same exponent to every code either table lists", async () => {
    const { currencyExponent: serverExponent } = await import("../../src/platform/currency");
    // Every code with a non-default exponent in either table, plus ordinary controls.
    const codes = [
      "BIF",
      "CLP",
      "DJF",
      "GNF",
      "ISK",
      "JPY",
      "KMF",
      "KRW",
      "MGA",
      "PYG",
      "RWF",
      "UGX",
      "UYI",
      "VND",
      "VUV",
      "XAF",
      "XOF",
      "XPF",
      "BHD",
      "IQD",
      "JOD",
      "KWD",
      "LYD",
      "OMR",
      "TND",
      "CLF",
      "UYW",
      "USD",
      "EUR",
      "INR",
      "GBP",
      "AUD",
      "SGD",
      "MRU",
    ];
    const divergent = codes
      .filter((c) => serverExponent(c) !== currencyExponent(c))
      .map((c) => `${c}: server=${serverExponent(c)} dashboard=${currencyExponent(c)}`);
    expect(divergent).toEqual([]);
  });

  it("gives MGA its ISO exponent on both sides", async () => {
    // Stored minor units follow ISO; a 0 here once rendered and charged MGA at 100x.
    const { currencyExponent: serverExponent } = await import("../../src/platform/currency");
    expect(serverExponent("MGA")).toBe(2);
    expect(currencyExponent("MGA")).toBe(2);
  });
});

/**
 * `formatMoney` renders the buyer-facing string on the hosted checkout.
 *
 * It exists because that page hardcoded `/100` with two forced decimals, so a ¥1000
 * plan advertised itself as "JPY 10.00" — a 100× misquote on the one screen where the
 * customer agrees to a price. Nothing caught it: the checkout suite only ever used
 * USD, where `/100` happens to be right. These cases are the non-2 exponents.
 */
describe("formatMoney", () => {
  it("uses the currency exponent, not a hardcoded /100", async () => {
    const { formatMoney } = await import("../../src/platform/currency");
    expect(formatMoney(1000, "JPY")).toBe("¥1,000"); // exp 0 — was "JPY 10.00"
    // \u00A0, not a plain space: Intl separates a currency CODE from the amount with a
    // NON-BREAKING space, so the pair never wraps across a line. Asserted explicitly
    // because the two are indistinguishable on screen and a plain space here would
    // fail with a diff that reads "expected 'KWD 1.000' to be 'KWD 1.000'".
    expect(formatMoney(1000, "KWD")).toBe("KWD\u00A01.000"); // exp 3 — was "KWD 10.00"
    expect(formatMoney(249900, "INR")).toBe("₹2,499.00"); // exp 2 — value unchanged
    expect(formatMoney(4900, "USD")).toBe("$49.00");
  });

  it("renders the same shape the dashboard does, so checkout and portal agree", async () => {
    const { formatMoney } = await import("../../src/platform/currency");
    const { money } = await import("../../dashboard/lib/format");
    for (const [minor, code] of [
      [249900, "INR"],
      [4900, "USD"],
      [1000, "JPY"],
    ] as const) {
      expect(formatMoney(minor, code)).toBe(money(minor, code));
    }
  });

  it("falls back to the exponent, not 2, for a code Intl rejects", async () => {
    const { formatMoney } = await import("../../src/platform/currency");
    // Intl only throws on a MALFORMED code — it happily formats any well-formed
    // three-letter one it does not know ('ZZZ' → "ZZZ 10.00"). So the fallback is
    // reached by a wrong-length code, not an unknown currency.
    expect(formatMoney(1000, "XX")).toBe("10.00 XX");
    expect(formatMoney(1000, "")).toBe("10.00 ");
    // Unknown-but-well-formed still goes through Intl, which is fine: our table and
    // CLDR both default such a code to two decimals.
    expect(formatMoney(1000, "ZZZ")).toBe("ZZZ\u00A010.00");
  });
});

/**
 * Every money string a CUSTOMER sees must be the same string.
 *
 * There are three formatters, each with a reason to exist: `platform/currency.formatMoney`
 * (the general one), `invoicing/document.formatMoney` (bigint, because an invoice is a tax
 * document and `Number` loses precision on large amounts), and `emails/templates.formatMoney`
 * (a thin re-export, kept so template code reads naturally).
 *
 * All three used to differ. The email said `1,485.62 INR`, the invoice said `₹1,485.62`,
 * and the checkout said `INR 1485.62` — three renderings of one amount, to one customer,
 * across three surfaces. Two of them also hardcoded `/100`, so a ¥1000 charge announced
 * itself as ten yen.
 *
 * This compares them on the same inputs so a future edit to one has to be made to all.
 */
describe("all customer-facing money formatters agree", () => {
  it("renders identically across the invoice, the email and the platform", async () => {
    const { formatMoney: plat } = await import("../../src/platform/currency");
    const { formatMoney: doc } = await import("../../src/modules/invoicing/document");
    const { formatMoney: mail } = await import("../../src/modules/emails/templates");
    const cases: Array<[bigint, string]> = [
      [148562n, "INR"], // ordinary two-decimal
      [129900n, "USD"],
      [1000n, "JPY"], // zero-decimal — the 100× case
      [1000n, "KWD"], // three-decimal — the 10× case
      [-4900n, "USD"], // negative, e.g. a credit note line
      [0n, "INR"],
    ];
    for (const [minor, code] of cases) {
      const p = plat(minor, code);
      expect({ code, doc: doc(minor, code) }).toEqual({ code, doc: p });
      expect({ code, mail: mail(minor, code) }).toEqual({ code, mail: p });
    }
  }, 30_000); // cold dynamic imports of three formatter modules; 5s is not enough under a parallel run

  it("the invoice formatter keeps bigint precision the others would lose", async () => {
    // Number.MAX_SAFE_INTEGER is ~9.007e15 minor units. An invoice is a tax document, so
    // its formatter takes bigint all the way rather than round-tripping through Number.
    const { formatMoney: doc } = await import("../../src/modules/invoicing/document");
    expect(doc(9007199254740993n, "INR")).toBe("₹90,071,992,547,409.93");
  });
});
