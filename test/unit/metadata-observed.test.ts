import { describe, it, expect } from "vitest";
import {
  shapeObserved,
  OBSERVED_LIMITS,
  type ObservedRow,
} from "@/modules/metadata-rules/observed-shape";

const path = (p: string, rows: number, distinct: number, type = "string"): ObservedRow[] => [
  { kind: "path", path: p, rows, distinct },
  { kind: "type", path: p, type, rows },
];
const val = (p: string, v: unknown, rows: number): ObservedRow => ({
  kind: "value",
  path: p,
  value: JSON.stringify(v),
  rows,
});

describe("shapeObserved", () => {
  it("returns values for a key with few short values, most used first", () => {
    const [k] = shapeObserved([
      ...path("core_destination", 10, 2),
      val("core_destination", "gs", 7),
      val("core_destination", "gds", 3),
    ]);
    expect(k).toMatchObject({
      path: "core_destination",
      rows: 10,
      type: "string",
      distinct_values: 2,
    });
    expect(k!.values).toEqual([
      { value: "gs", rows: 7 },
      { value: "gds", rows: 3 },
    ]);
  });

  it("returns no values for a high-cardinality key", () => {
    const [k] = shapeObserved([...path("source_id", 5000, 5000)]);
    expect(k!.values).toBeNull();
  });

  it("returns no values past the distinct cut-off, even when the query sent some", () => {
    const n = OBSERVED_LIMITS.maxDistinct + 1;
    const rows = [
      ...path("plan", n, n),
      ...Array.from({ length: n }, (_, i) => val("plan", `p${i}`, 1)),
    ];
    expect(shapeObserved(rows)[0]!.values).toBeNull();
  });

  it("returns no values when one value was long or not a scalar", () => {
    // 3 distinct values, but only 2 came back as short scalars.
    const [k] = shapeObserved([...path("note", 3, 3), val("note", "a", 1), val("note", "b", 1)]);
    expect(k!.values).toBeNull();
  });

  it("keeps nested paths and their types", () => {
    const [k] = shapeObserved([
      ...path("limit_overrides.accounts", 4, 2, "number"),
      val("limit_overrides.accounts", 150, 3),
      val("limit_overrides.accounts", 40, 1),
    ]);
    expect(k).toMatchObject({ path: "limit_overrides.accounts", type: "number" });
    expect(k!.values).toEqual([
      { value: 150, rows: 3 },
      { value: 40, rows: 1 },
    ]);
  });

  it("names the dominant type and ignores nulls", () => {
    const [k] = shapeObserved([
      { kind: "path", path: "flag", rows: 3, distinct: 1 },
      { kind: "type", path: "flag", type: "boolean", rows: 3 },
      { kind: "type", path: "flag", type: "null", rows: 9 },
    ]);
    expect(k).toMatchObject({ type: "boolean", rows: 3 });
  });

  it("drops a path that only ever holds null", () => {
    expect(
      shapeObserved([
        { kind: "path", path: "gone", rows: 0, distinct: 0 },
        { kind: "type", path: "gone", type: "null", rows: 4 },
      ]),
    ).toEqual([]);
  });

  it("returns array item values under the same cut-offs", () => {
    const [k] = shapeObserved([
      ...path("additional_destinations", 5, 2, "array"),
      { kind: "item_distinct", path: "additional_destinations", distinct: 2 },
      { kind: "item_value", path: "additional_destinations", value: '"gds"', rows: 4 },
      { kind: "item_value", path: "additional_destinations", value: '"gs"', rows: 2 },
    ]);
    expect(k!.item_values).toEqual([
      { value: "gds", rows: 4 },
      { value: "gs", rows: 2 },
    ]);
  });
});
