import { describe, expect, it } from "vitest";
import { rollParts, rollWords, ROLL_SPREAD_MS } from "../../dashboard/lib/rolling-number";

const digits = (v: string, prev: string | null = null) =>
  rollParts(v, prev).flatMap((p) => (p.kind === "digit" ? [[p.from, p.to]] : []));

describe("rollParts", () => {
  it("splits a money figure into digits and still text", () => {
    expect(rollParts("$1,284.50").map((p) => (p.kind === "digit" ? p.to : p.text))).toEqual([
      "$",
      1,
      ",",
      2,
      8,
      4,
      ".",
      5,
      0,
    ]);
  });

  it("keeps a non-ASCII currency sign and a unit as text", () => {
    const parts = rollParts("₹12,499");
    expect(parts[0]).toEqual({ kind: "text", text: "₹" });
    expect(rollParts("13 days").map((p) => p.kind)).toEqual(["digit", "digit", "space", "text"]);
    expect(rollParts("4.4%").at(-1)).toEqual({ kind: "text", text: "%" });
  });

  it("starts every digit at 0 on mount", () => {
    expect(digits("907")).toEqual([
      [0, 9],
      [0, 0],
      [0, 7],
    ]);
  });

  it("starts from the previous value, aligned from the right", () => {
    expect(digits("$1,234", "$987")).toEqual([
      [0, 1],
      [9, 2],
      [8, 3],
      [7, 4],
    ]);
    expect(digits("12", "4,560")).toEqual([
      [6, 1],
      [0, 2],
    ]);
  });

  it("spreads the start over at most the spread, leftmost first", () => {
    const delays = rollParts("1,234,567").flatMap((p) => (p.kind === "digit" ? [p.delayMs] : []));
    expect(delays[0]).toBe(0);
    expect(delays.at(-1)).toBe(ROLL_SPREAD_MS);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
    expect(rollParts("7")[0]).toMatchObject({ delayMs: 0 });
  });

  it("returns only text for a figure with no digits", () => {
    expect(rollParts("—")).toEqual([{ kind: "text", text: "—" }]);
  });
});

describe("rollWords", () => {
  it("breaks only at whitespace", () => {
    const words = rollWords(rollParts("13 days ago"));
    expect(
      words.map((w) => w.map((p) => (p.kind === "digit" ? String(p.to) : p.text)).join("")),
    ).toEqual(["13", " ", "days", " ", "ago"]);
  });
});
