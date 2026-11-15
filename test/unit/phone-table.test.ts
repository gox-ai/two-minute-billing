import { describe, expect, it } from "vitest";
import { cellPlace, columnStarts, textOf } from "../../dashboard/lib/phone-table";
import { figureEm, figureTileMin } from "../../dashboard/lib/figure-fit";

const el = (children: unknown) => ({ type: "span", props: { children } });

describe("textOf", () => {
  it("joins strings and numbers through nested elements and skips booleans", () => {
    expect(textOf(["Amount (", el("INR"), ")"])).toBe("Amount (INR)");
    expect(textOf(el([el("Units"), false, null, 2]))).toBe("Units2");
    expect(textOf(undefined)).toBe("");
  });
});

describe("columnStarts", () => {
  it("advances by each cell's colSpan", () => {
    expect(columnStarts([undefined, undefined, undefined])).toEqual([0, 1, 2]);
    // A totals row: the label spans three columns, the amount sits in the fourth.
    expect(columnStarts([3, 1])).toEqual([0, 3]);
    expect(columnStarts([0, -1, 2.5, 1])).toEqual([0, 1, 2, 4]);
  });
});

describe("cellPlace", () => {
  const heads = [
    { label: "Item" },
    { label: "Units" },
    { label: "Amount", place: "aside" as const },
  ];
  it("leads with the first column and labels the rest", () => {
    expect(cellPlace(0, heads)).toBe("title");
    expect(cellPlace(1, heads)).toBe("detail");
    expect(cellPlace(5, heads)).toBe("detail");
  });
  it("follows the column head, and a cell's own place wins", () => {
    expect(cellPlace(2, heads)).toBe("aside");
    expect(cellPlace(2, heads, "hide")).toBe("hide");
    expect(cellPlace(0, [{ label: "", place: "detail" }])).toBe("detail");
    // A head that names the title moves it off the first column.
    expect(cellPlace(0, [{ label: "Date" }, { label: "Description", place: "title" }])).toBe(
      "detail",
    );
  });
});

describe("figureEm", () => {
  it("matches the measured width of a money figure", () => {
    // Measured in the browser: 6.055em.
    expect(figureEm("₹210,003.91")).toBeCloseTo(6.06, 1);
    expect(figureEm("7")).toBe(0.63);
  });
});

describe("figureTileMin", () => {
  it("sizes the tile for its widest figure", () => {
    expect(figureTileMin(["7", "₹1,178.82"])).toBe(
      `${Math.ceil((figureEm("₹1,178.82") * 1.625 + 2.25) * 100) / 100}rem`,
    );
  });
  it("gives up on anything that is not a plain string", () => {
    expect(figureTileMin([])).toBeUndefined();
    expect(figureTileMin(["7", undefined])).toBeUndefined();
  });
});
