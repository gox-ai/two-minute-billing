import { describe, expect, it } from "vitest";
import { combinesAcrossBusinesses, measureById } from "@/modules/metrics/daily/measures";

const m = (id: string) => {
  const def = measureById(id);
  if (!def) throw new Error(`no measure ${id}`);
  return def;
};

describe("combinesAcrossBusinesses", () => {
  it("lets a cohort ratio stored as two halves cross businesses by day and month", () => {
    for (const id of ["gross_revenue_retention", "net_revenue_retention", "customer_churn_rate"]) {
      expect(combinesAcrossBusinesses(m(id), "month")).toBe(true);
      expect(combinesAcrossBusinesses(m(id), "day")).toBe(true);
    }
  });

  it("refuses week, quarter and year, where business calendars can disagree", () => {
    for (const grain of ["week", "quarter", "year"] as const) {
      expect(combinesAcrossBusinesses(m("gross_revenue_retention"), grain)).toBe(false);
    }
  });

  it("refuses a bare distinct count, which has no denominator to weight it", () => {
    expect(combinesAcrossBusinesses(m("customers_new"), "month")).toBe(false);
    expect(combinesAcrossBusinesses(m("customers_churned"), "month")).toBe(false);
  });
});
