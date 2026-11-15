import { describe, expect, it } from "vitest";
import { meterDefinitionIssue, normalizePriceListMap } from "@/modules/metering/meters";
import { listKeyOf } from "@/modules/metering/price-list-rating";

const def = (priceList: Record<string, string>, groupBy = ["model", "quality"]) =>
  meterDefinitionIssue({
    name: "m",
    eventName: "e",
    aggregation: "sum",
    valueProperty: "n",
    groupBy,
    priceList,
  } as Parameters<typeof meterDefinitionIssue>[0]);

describe("meter price_list: unit and tier", () => {
  it("checks the unit, the tier values and that each _key is grouped", () => {
    expect(def({ token_type: "output", unit: "image", quality_key: "quality" })).toBeNull();
    expect(def({ token_type: "output", unit: "furlong" })).toMatch(/unit in price_list/);
    expect(def({ token_type: "output", quality: "hd", quality_key: "quality" })).toMatch(
      /Set quality or quality_key/,
    );
    expect(def({ token_type: "output", quality: "h d!" })).toMatch(/quality in price_list/);
    expect(def({ token_type: "output", resolution: "" })).toMatch(/resolution in price_list/);
    expect(def({ token_type: "output", resolution_key: "size" })).toBe(
      "We could not save the meter. price_list reads size, so add size to group_by.",
    );
  });

  it("a fixed tier is trimmed and lower-cased before the check; keys and the rest stay", () => {
    const m = { token_type: "output", unit: "image", quality: " HD ", resolution: "1024X1024" };
    expect(normalizePriceListMap(m)).toEqual({ ...m, quality: "hd", resolution: "1024x1024" });
    expect(def(normalizePriceListMap(m))).toBeNull();
    // A property name keeps its case: it is matched against group_by as written.
    const keyed = { token_type: "output", quality_key: "Quality" };
    expect(normalizePriceListMap(keyed)).toBe(keyed);
    expect(normalizePriceListMap(null)).toBeNull();
    // Only spaces is no tier value: the check still refuses it.
    expect(def(normalizePriceListMap({ token_type: "output", quality: "  " }))).toMatch(
      /quality in price_list/,
    );
  });

  it("a map with no unit or tier gives the key it gave before; one with them carries them", () => {
    const group = { model: "img", quality: " HD " };
    expect(listKeyOf({ priceList: { token_type: "output" } }, group, "USD")).toEqual({
      provider: null,
      model: "img",
      tokenType: "output",
      currency: "USD",
    });
    expect(
      listKeyOf(
        { priceList: { token_type: "output", unit: "image", quality_key: "quality" } },
        group,
        "USD",
      ),
    ).toEqual({
      provider: null,
      model: "img",
      tokenType: "output",
      currency: "USD",
      unit: "image",
      quality: "hd",
      resolution: "",
    });
  });
});
