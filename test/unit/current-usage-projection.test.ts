import { describe, it, expect } from "vitest";
import { projectQuantity, projectionSpan } from "@/modules/subscriptions/usage-projection";

const DAY = 86_400_000;
const start = new Date("2027-01-01T00:00:00Z");
const end = new Date("2027-02-01T00:00:00Z"); // 31 days
const at = (days: number) => new Date(start.getTime() + days * DAY);

describe("projectionSpan", () => {
  it("is null before 10% of the window", () => {
    expect(projectionSpan({ start, end }, at(3))).toBeNull(); // 9.7 %
    expect(projectionSpan({ start, end }, at(3.1))).not.toBeNull(); // exactly 10 %
  });
  it("caps elapsed at the window length", () => {
    const s = projectionSpan({ start, end }, at(40))!;
    expect(s.elapsedMs).toBe(s.lengthMs);
  });
});

describe("projectQuantity", () => {
  const span = projectionSpan({ start, end }, at(10))!;
  it("extends a running total linearly, rounded up", () => {
    expect(projectQuantity({ growth: "additive", quantity: 4000n, span })).toEqual({
      quantity: 12400n,
      method: "linear",
    });
    expect(projectQuantity({ growth: "additive", quantity: 1n, span }).quantity).toBe(4n); // 3.1 → 4
  });
  it("stays exact past the safe-integer range", () => {
    const q = 9_007_199_254_740_993n;
    expect(projectQuantity({ growth: "additive", quantity: q, span }).quantity).toBe(
      (q * 31n + 9n) / 10n,
    );
  });
  it("holds a level", () => {
    expect(projectQuantity({ growth: "level", quantity: 42n, span })).toEqual({
      quantity: 42n,
      method: "held_level",
    });
  });
  it("takes the full-window measurement for time-weighted usage", () => {
    expect(
      projectQuantity({ growth: "time_weighted", quantity: 240n, span, fullWindowQuantity: 744n }),
    ).toEqual({ quantity: 744n, method: "held_level" });
  });
  it("projects zero usage as zero, and the whole window as itself", () => {
    expect(projectQuantity({ growth: "additive", quantity: 0n, span }).quantity).toBe(0n);
    const full = projectionSpan({ start, end }, end)!;
    expect(projectQuantity({ growth: "additive", quantity: 4000n, span: full }).quantity).toBe(
      4000n,
    );
  });
});
