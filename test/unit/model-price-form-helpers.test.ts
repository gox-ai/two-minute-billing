import { describe, expect, it } from "vitest";
import { normalizeTier, TIER_RE } from "@/modules/model-prices/units";
import {
  PRICE_UNITS,
  TIER_MESSAGE,
  costRowActions,
  COST_DIVISORS_BY_UNIT,
  costTierFields,
  defaultCostDivisor,
  feedTimes,
  formatListPrice,
  isMediaUnit,
  listPriceParts,
  normalizeTier as normalizeTierForm,
  perUnitLabel,
  priceListFieldErrors,
  priceUnitLabel,
  shortVersion,
  showsResolution,
  takesResolution,
  unlistedCostFilters,
  unlistedCostKey,
} from "../../dashboard/lib/model-prices";
import { perUnitText } from "@/modules/model-prices/units";

describe("tier normalisation", () => {
  it("trims and lower-cases, in the engine and in the form alike", () => {
    for (const f of [normalizeTier, normalizeTierForm]) {
      expect(f(" HD ")).toBe("hd");
      expect(f("1024X1024")).toBe("1024x1024");
      expect(f(null)).toBe("");
      expect(f(undefined)).toBe("");
    }
  });

  it("a normalised tier passes the pattern; a bad character still fails", () => {
    expect(TIER_RE.test(normalizeTier("1024X1024"))).toBe(true);
    expect(TIER_RE.test(normalizeTier("HD!"))).toBe(false);
    // The multiplication sign is not an "x".
    expect(TIER_RE.test(normalizeTier("1024×1024"))).toBe(false);
  });
});

describe("price units in the dashboard", () => {
  it("labels each unit; no unit is tokens", () => {
    expect(PRICE_UNITS.map((u) => priceUnitLabel(u.value))).toEqual([
      "Tokens",
      "Requests",
      "Images",
      "Audio",
      "Video",
      "Characters",
      "Pages",
      "Pixels",
    ]);
    expect(priceUnitLabel(null)).toBe("Tokens");
    expect(priceUnitLabel("light_year")).toBe("Light year");
  });

  it("offers Resolution for images, video and pixels only", () => {
    expect(PRICE_UNITS.filter((u) => takesResolution(u.value)).map((u) => u.value)).toEqual([
      "image",
      "video_second",
      "pixel",
    ]);
    // Quality stays for every media unit.
    expect(PRICE_UNITS.filter((u) => isMediaUnit(u.value)).map((u) => u.value)).toEqual([
      "image",
      "audio_second",
      "video_second",
      "character",
      "page",
      "pixel",
    ]);
  });

  it("still shows a stored resolution on a unit that takes none", () => {
    expect(showsResolution("audio_second", false)).toBe(false);
    expect(showsResolution("audio_second", true)).toBe(true);
    expect(showsResolution("image", false)).toBe(true);
    expect(showsResolution("token", true)).toBe(false);
  });
});

describe("cost row actions", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const at = (h: number) => new Date(now + h * 3_600_000).toISOString();

  it("deletes before the start, ends after it, and does nothing once ended", () => {
    expect(costRowActions({ effective_from: at(1), effective_to: null }, now)).toEqual({
      canDelete: true,
      canEnd: false,
    });
    expect(costRowActions({ effective_from: at(-1), effective_to: null }, now)).toEqual({
      canDelete: false,
      canEnd: true,
    });
    expect(costRowActions({ effective_from: at(-2), effective_to: at(3) }, now)).toEqual({
      canDelete: false,
      canEnd: true,
    });
    expect(costRowActions({ effective_from: at(-2), effective_to: at(-1) }, now)).toEqual({
      canDelete: false,
      canEnd: false,
    });
  });
});

describe("cost row actions: a cost ended a moment ago", () => {
  it("is ended for a time read after the end, not for one read before it", () => {
    const opened = Date.parse("2026-11-13T12:00:00Z");
    const c = { effective_from: "2026-11-01T00:00:00Z", effective_to: "2026-11-13T12:00:05Z" };
    expect(costRowActions(c, opened).canEnd).toBe(true);
    expect(costRowActions(c, opened + 6_000).canEnd).toBe(false);
  });
});

describe("per-unit words", () => {
  it("uses the singular for one unit, as the engine does", () => {
    for (const [unit, divisor] of [
      ["image", "1"],
      ["audio_second", "1"],
      ["video_second", "1"],
      ["audio_second", "3600"],
      ["video_second", "60"],
      ["character", "1000000"],
      ["request", "1000"],
      ["pixel", "1000000000"],
    ] as const)
      expect(perUnitLabel(unit, divisor)).toBe(perUnitText(unit, divisor));
    expect(perUnitLabel("image", "1")).toBe("per image");
    expect(perUnitLabel("audio_second", 1)).toBe("per second of audio");
  });
});

describe("list price parts", () => {
  it("splits the amount from its per text, and joins to the one-line price", () => {
    const p = listPriceParts("75", "USD", "1", "video_second");
    expect(p?.per).toBe("per second of video");
    expect(`${p?.amount} ${p?.per}`).toBe(formatListPrice("75", "USD", "1", "video_second"));
    // No unit is a rate-card rate.
    expect(listPriceParts("300", "USD", "1000000")?.per).toBe("per 1M");
  });

  it("has no parts without a rate; the one-line price is a dash", () => {
    expect(listPriceParts(null, "USD", "1", "image")).toBeNull();
    expect(listPriceParts("", "USD", "1", "image")).toBeNull();
    expect(formatListPrice(null, "USD", "1", "image")).toBe("—");
  });
});

describe("source version", () => {
  it("drops the weak marker and the quotes, and keeps 8 characters", () => {
    expect(shortVersion('W/"0123456789abcdef"')).toBe("01234567");
    expect(shortVersion('"m1"')).toBe("m1");
  });
});

describe("meter price list mapping: field messages", () => {
  const base = { model_key: "model", token_type: "output" };

  it("is empty for a complete mapping", () => {
    expect(
      priceListFieldErrors({ ...base, quality_key: "quality", resolution: "1024x1024" }, [
        "model",
        "quality",
      ]),
    ).toEqual({});
  });

  it("names the empty property or value under its own field", () => {
    expect(
      priceListFieldErrors({ ...base, quality_key: "", resolution_key: "", provider_key: "" }, [
        "model",
      ]),
    ).toEqual({
      provider_key: "Enter the property that holds the provider.",
      quality_key: "Enter the property that holds the quality.",
      resolution_key: "Enter the property that holds the resolution.",
    });
    expect(priceListFieldErrors({ ...base, quality: "" }, ["model"])).toEqual({
      quality: "Enter the quality.",
    });
  });

  it("puts a tier the list cannot hold under the tier field", () => {
    expect(priceListFieldErrors({ ...base, resolution: "1024×1024" }, ["model"])).toEqual({
      resolution: TIER_MESSAGE,
    });
  });

  it("asks for each property that Group by does not have", () => {
    expect(
      priceListFieldErrors({ token_type_key: "token_type", quality_key: "quality" }, ["model"]),
    ).toEqual({
      token_type_key: "Add token_type to Group by.",
      quality_key: "Add quality to Group by.",
    });
    expect(priceListFieldErrors(base, [])).toEqual({ model_key: "Add model to Group by." });
  });

  it("skips the Group by check when the form did not post it", () => {
    expect(priceListFieldErrors({ ...base, quality_key: "quality" }, null)).toEqual({});
  });
});

describe("Set your cost: tier fields", () => {
  it("a media unit offers its tiers; tokens and requests offer none in free entry", () => {
    expect(costTierFields("image")).toEqual({ quality: true, resolution: true });
    expect(costTierFields("audio_second")).toEqual({ quality: true, resolution: false });
    expect(costTierFields("token", null)).toEqual({ quality: false, resolution: false });
    expect(costTierFields("request", { quality: null, resolution: null })).toEqual({
      quality: false,
      resolution: false,
    });
  });

  it("a row opened with a tier keeps that tier's field, whatever the unit", () => {
    expect(costTierFields("token", { quality: "priority" })).toEqual({
      quality: true,
      resolution: false,
    });
    expect(costTierFields("request", { resolution: "1024x1024" })).toEqual({
      quality: false,
      resolution: true,
    });
    expect(costTierFields("audio_second", { quality: "hd", resolution: "16k" })).toEqual({
      quality: true,
      resolution: true,
    });
  });
});

describe("the cost card follows the list's search and filters", () => {
  it("reads q and the provider and unit filters; drops what the cost list cannot apply", () => {
    expect(unlistedCostFilters(" gpt ", ["provider:is:openai", "unit:is:image"])).toEqual({
      q: "gpt",
      provider: "openai",
      unit: "image",
    });
    expect(unlistedCostFilters(null, [])).toEqual({});
    expect(unlistedCostFilters("  ", ["unit:is:furlong", "provider:in:a,b"])).toEqual({});
    // A value keeps its own colons.
    expect(unlistedCostFilters("", ["provider:is:a:b"])).toEqual({ provider: "a:b" });
  });

  it("the key changes only when a filter does", () => {
    const a = unlistedCostKey(unlistedCostFilters("x", ["unit:is:image"]));
    expect(unlistedCostKey({ unit: "image", q: "x" })).toBe(a);
    expect(unlistedCostKey({ q: "x" })).not.toBe(a);
    expect(unlistedCostKey({})).toBe(unlistedCostKey(unlistedCostFilters(null, [])));
  });
});

describe("source line: checked and updated", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 10, 13, h)).toISOString();
  it("shows the last update when it is not the check", () => {
    expect(feedTimes({ checked_at: t(9), last_success_at: t(3) })).toEqual({
      checked: t(9),
      updated: t(3),
    });
  });

  it("one time when both are the same instant, in any spelling", () => {
    expect(feedTimes({ checked_at: t(9), last_success_at: t(9) }).updated).toBeNull();
    expect(
      feedTimes({ checked_at: "2026-11-13T09:00:00Z", last_success_at: "2026-11-13T09:00:00.000Z" })
        .updated,
    ).toBeNull();
  });

  it("a staff release after the last check shows as the update", () => {
    expect(feedTimes({ checked_at: t(9), last_success_at: t(10) }).updated).toBe(t(10));
  });

  it("no check yet: the last success stands in, once; nothing at all is nothing", () => {
    expect(feedTimes({ checked_at: null, last_success_at: t(3) })).toEqual({
      checked: t(3),
      updated: null,
    });
    expect(feedTimes({})).toEqual({ checked: null, updated: null });
  });
});

describe("Set your cost: the default Per", () => {
  it("each unit starts on its first amount, never on an empty one", () => {
    for (const u of PRICE_UNITS) {
      const d = defaultCostDivisor(u.value);
      expect(d).toBe(COST_DIVISORS_BY_UNIT[u.value]![0]);
      expect(d).toMatch(/^[1-9][0-9]*$/);
    }
    expect(defaultCostDivisor("audio_second")).toBe("3600");
    expect(defaultCostDivisor("request")).toBe("1000");
    expect(defaultCostDivisor("character")).toBe("1000000");
  });

  it("no unit or an unknown unit uses the token amounts", () => {
    expect(defaultCostDivisor(null)).toBe("1000000");
    expect(defaultCostDivisor("furlong")).toBe("1000000");
  });
});
