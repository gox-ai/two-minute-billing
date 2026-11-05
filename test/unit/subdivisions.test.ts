import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import {
  TAX_COUNTRIES,
  isTaxCountry,
  isStrictSubdivisionCountry,
  isValidStateCode,
  normalizeStateCode,
  primeGeoReference,
  requireStateCode,
  subdivisionName,
  subdivisionsFor,
  SubdivisionError,
} from "@/platform/geo";

// The reference set now lives in the database, but the validators are pure given
// the data — so prime them from the same committed dataset the seed loads and keep
// this a unit test with no connection.
beforeAll(() => {
  primeGeoReference(
    JSON.parse(readFileSync(resolve(process.cwd(), "db/seed-data/geo.json"), "utf8")),
  );
});

describe("subdivision lists", () => {
  it("India has all 36 subdivisions (28 states + 8 union territories)", () => {
    expect(subdivisionsFor("IN")).toHaveLength(36);
  });
  it("US has 60 — 50 states, DC, 5 territories, 3 military postal regions, UM", () => {
    // Straight from the source, unfiltered. The military regions (AA/AE/AP) are real
    // billing destinations even though they are not tax jurisdictions.
    expect(subdivisionsFor("US")).toHaveLength(60);
  });
  it("now ships a list for every country that has one", () => {
    // GB used to return null. It now resolves to its 4 top-level divisions (England,
    // Scotland, Wales, Northern Ireland) — but UK addresses conventionally carry a
    // COUNTY, which is none of those, so the set stays OPEN and free text still passes.
    expect(subdivisionsFor("GB")).not.toBeNull();
    expect(isStrictSubdivisionCountry("GB")).toBe(false);
    expect(isStrictSubdivisionCountry("IN")).toBe(true);
    expect(isStrictSubdivisionCountry("US")).toBe(true);
  });
  it("is null for a country with no subdivisions at all", () => {
    // 21 of them — Antarctica, Vatican City, Gibraltar, Macau. They get a free-text
    // region field. (Bermuda used to be in this list only because the old ISO
    // package lacked its parishes; the current source has all nine.)
    expect(subdivisionsFor("VA")).toBeNull();
    expect(subdivisionsFor("GI")).toBeNull();
    expect(subdivisionsFor(null)).toBeNull();
  });
  it("codes are unique within a country", () => {
    for (const cc of ["IN", "US"]) {
      const codes = subdivisionsFor(cc)!.map((s) => s.value);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });
  it("only India and the US are configurable for tax today", () => {
    expect([...TAX_COUNTRIES]).toEqual(["IN", "US"]);
    expect(isTaxCountry("in")).toBe(true);
    expect(isTaxCountry("US")).toBe(true);
    expect(isTaxCountry("GB")).toBe(false);
    expect(isTaxCountry(null)).toBe(false);
  });
});

describe("Indian state codes fold onto the canonical set", () => {
  /**
   * Two schemes are in use for Indian states and our canonical set is a MIXTURE of them,
   * so the folds are not all in the same direction: ISO for Chhattisgarh / Odisha /
   * Telangana (CT / OR / TG) against the everyday CG / OD / TS — but the everyday `UK`
   * for Uttarakhand, where ISO says `UT`. Three fold everyday→canonical, one the reverse.
   */
  const ALIASED: Array<[string, string, string]> = [
    ["CG", "CT", "Chhattisgarh"],
    ["OD", "OR", "Odisha"],
    ["TS", "TG", "Telangana"],
    ["UT", "UK", "Uttarakhand"],
  ];

  it.each(ALIASED)("'%s' folds to canonical '%s' (%s)", (alias, iso) => {
    expect(normalizeStateCode("IN", alias)).toBe(iso);
    expect(isValidStateCode("IN", alias)).toBe(true);
  });

  it("the fold is what stops an imported customer being taxed at zero", () => {
    // A rate component configured through our picker stores the ISO code; an imported
    // customer can arrive with the everyday one. They must resolve to one value.
    const configured = requireStateCode("IN", "OR"); // our picker
    const imported = requireStateCode("IN", "OD"); // an import
    expect(imported).toBe(configured);
  });

  it("codes the two schemes agree on are untouched", () => {
    for (const c of ["KA", "TN", "MH", "DL", "GJ"]) expect(normalizeStateCode("IN", c)).toBe(c);
  });

  it("no alias silently renames a state that already exists", () => {
    // An alias must never also be a canonical code, or the fold would shadow a real
    // subdivision. Guard against a future careless alias.
    const iso = new Set(subdivisionsFor("IN")!.map((s) => s.value));
    for (const [alias] of ALIASED) expect(iso.has(alias)).toBe(false);
  });
});

describe("normalizeStateCode", () => {
  it("upper-cases and trims", () => {
    expect(normalizeStateCode("IN", " ka ")).toBe("KA");
    expect(normalizeStateCode("US", "ca")).toBe("CA");
  });
  it('empty means "not stated", not an error', () => {
    expect(normalizeStateCode("IN", "")).toBeNull();
    expect(normalizeStateCode("IN", null)).toBeNull();
    expect(normalizeStateCode("IN", "   ")).toBeNull();
  });
  it("passes through unknown countries rather than mangling them", () => {
    expect(normalizeStateCode("GB", "gtr-london")).toBe("GTR-LONDON");
  });
  it("an alias is scoped to its country — US CG is not Chhattisgarh", () => {
    expect(normalizeStateCode("US", "CG")).toBe("CG");
  });
});

describe("validation", () => {
  it("accepts real codes, rejects invented ones", () => {
    expect(isValidStateCode("IN", "KA")).toBe(true);
    expect(isValidStateCode("IN", "ZZ")).toBe(false);
    expect(isValidStateCode("US", "CA")).toBe(true);
    expect(isValidStateCode("US", "XX")).toBe(false);
  });
  it("does not reject codes for countries we ship no list for", () => {
    expect(isValidStateCode("GB", "anything")).toBe(true);
  });
  it("a US state name is not a US state code", () => {
    // The exact bug this closes: free text let 'California' through, which matches
    // no component and silently taxes nothing.
    expect(isValidStateCode("US", "California")).toBe(false);
    expect(isValidStateCode("IN", "Karnataka")).toBe(false);
  });
  it("requireStateCode throws with the expected set named", () => {
    expect(() => requireStateCode("US", "California")).toThrow(SubdivisionError);
    try {
      requireStateCode("IN", "ZZ");
    } catch (e) {
      expect((e as Error).message).toContain("IN");
      expect((e as Error).message).toContain("KA");
    }
  });
  it("requireStateCode returns the canonical form on success", () => {
    expect(requireStateCode("IN", "od")).toBe("OR");
    expect(requireStateCode("US", "ny")).toBe("NY");
    expect(requireStateCode("IN", null)).toBeNull();
  });
});

describe("subdivisionName", () => {
  it("names a canonical code", () => {
    expect(subdivisionName("IN", "TN")).toBe("Tamil Nadu");
    expect(subdivisionName("US", "CA")).toBe("California");
  });
  it("names an aliased code too", () => {
    expect(subdivisionName("IN", "OD")).toBe("Odisha");
  });
  it("is null for anything unknown", () => {
    expect(subdivisionName("IN", "ZZ")).toBeNull();
    expect(subdivisionName("GB", "XYZ")).toBeNull();
  });
});
