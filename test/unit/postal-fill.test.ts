import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { primeGeoReference } from "@/platform/geo";

vi.mock("@/platform/postal-lookup", () => ({
  lookupPostal: async (country: string, postal: string) => {
    if (country === "IN" && postal === "600001")
      return { stateCode: "TN", stateName: "Tamil Nadu", cities: ["Chennai"] };
    if (country === "IN" && postal === "600002")
      return { stateCode: "TN", stateName: "Tamil Nadu", cities: ["Alpha", "Beta"] };
    return null;
  },
}));

import { fillAddressFromPostal } from "@/modules/customers/postal-fill";

beforeAll(() => {
  primeGeoReference(
    JSON.parse(readFileSync(resolve(process.cwd(), "db/seed-data/geo.json"), "utf8")),
  );
});

describe("fillAddressFromPostal", () => {
  it("fills an empty city and state", async () => {
    expect(await fillAddressFromPostal({ postalCode: "600001", country: "IN" })).toMatchObject({
      city: "Chennai",
      stateCode: "TN",
      state: "Tamil Nadu",
    });
  });
  it("never overwrites a set value", async () => {
    const out = await fillAddressFromPostal({
      postalCode: "600001",
      country: "IN",
      city: "Elsewhere",
      stateCode: "KA",
    });
    expect(out).toMatchObject({ city: "Elsewhere", stateCode: "KA" });
  });
  it("leaves the city empty when several places match", async () => {
    const out = await fillAddressFromPostal<{
      postalCode?: string;
      country?: string;
      city?: string;
      stateCode?: string;
    }>({ postalCode: "600002", country: "IN" });
    expect(out?.city).toBeUndefined();
    expect(out?.stateCode).toBe("TN");
  });
  it("does nothing without a postal code, a country or a match", async () => {
    expect(await fillAddressFromPostal({ country: "IN" })).toEqual({ country: "IN" });
    expect(await fillAddressFromPostal({ postalCode: "1" })).toEqual({ postalCode: "1" });
    expect(await fillAddressFromPostal({ postalCode: "999999", country: "IN" })).toEqual({
      postalCode: "999999",
      country: "IN",
    });
    expect(await fillAddressFromPostal(null)).toBeNull();
  });
});
