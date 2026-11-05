/**
 * The conformance suite's verdict and the availability hook, without a database. What
 * regresses without it: a known gap that now passes stays listed (and keeps the gateway
 * off sale), an unknown failure is swallowed, or a new catalog gateway ships with no
 * fixtures and no stated reason.
 */
import { describe, it, expect } from "vitest";
import { GATEWAY_KEYS } from "@/providers/gateway-catalog";
import {
  conformanceExclusions,
  conformanceGaps,
  knownGapsByGateway,
} from "@/providers/conformance";
import {
  compareWithKnownGaps,
  coverageProblems,
  type MeasuredRow,
} from "../../scripts/conformance/verdict";

const row = (gateway: string, id: string, outcome: MeasuredRow["outcome"]): MeasuredRow => ({
  gateway,
  id,
  outcome,
});
const gap = { reason: "r", planRef: "3f x" };

describe("compareWithKnownGaps", () => {
  it("passes when the failing rows equal the known gaps", () => {
    const v = compareWithKnownGaps(
      [row("sq", "S3.a", "fail"), row("sq", "S2.b", "pass")],
      { sq: { "S3.a": gap } },
      ["sq"],
    );
    expect(v.unexpected).toEqual([]);
    expect(v.stale).toEqual([]);
    expect(v.known.map((r) => r.id)).toEqual(["S3.a"]);
  });

  it("reports a failure that is not a known gap", () => {
    const v = compareWithKnownGaps([row("sq", "S8.c", "fail")], { sq: {} }, ["sq"]);
    expect(v.unexpected.map((r) => r.id)).toEqual(["S8.c"]);
  });

  it("reports a known gap that passes, is n/a, or no longer exists", () => {
    const v = compareWithKnownGaps(
      [row("sq", "S3.a", "pass"), row("sq", "S10", "na")],
      { sq: { "S3.a": gap, S10: gap, "S7.gone": gap } },
      ["sq"],
    );
    expect(v.stale).toEqual([
      { gateway: "sq", row: "S3.a", now: "pass" },
      { gateway: "sq", row: "S10", now: "na" },
      { gateway: "sq", row: "S7.gone", now: "absent" },
    ]);
  });

  it("judges only the gateways that ran", () => {
    const v = compareWithKnownGaps([], { other: { "S1.x": gap } }, ["sq"]);
    expect(v.stale).toEqual([]);
  });
});

describe("coverageProblems", () => {
  const ex = { tm: { kind: "test-gateway" as const, reason: "test" } };
  it("accepts fixtures or a stated exclusion for every catalog gateway", () => {
    expect(
      coverageProblems({ catalog: ["a", "tm"], fixtures: ["a"], gapKeys: ["a"], exclusions: ex }),
    ).toEqual([]);
  });
  it("refuses a gateway with neither", () => {
    expect(
      coverageProblems({ catalog: ["a", "b"], fixtures: ["a"], gapKeys: ["a"], exclusions: {} }),
    ).toEqual(["b: no conformance fixture module and no stated reason in exclusions.json"]);
  });
  it("refuses an exclusion without a reason, beside fixtures, or outside the catalog", () => {
    const p = coverageProblems({
      catalog: ["a", "b"],
      fixtures: ["a"],
      gapKeys: ["a"],
      exclusions: {
        a: { kind: "pending", reason: "x" },
        b: { kind: "pending", reason: " " },
        z: { kind: "pending", reason: "x" },
      },
    });
    expect(p).toHaveLength(3);
  });
  it("needs a known-gaps entry for every fixture module, and none without one", () => {
    expect(
      coverageProblems({ catalog: ["a"], fixtures: ["a"], gapKeys: ["b"], exclusions: {} }),
    ).toHaveLength(2);
  });
});

describe("conformanceGaps", () => {
  const gaps = { sq: { "S8.b": gap, "S3.a": gap }, st: {} };
  const excluded = {
    tm: { kind: "test-gateway" as const, reason: "test" },
    pp: {
      kind: "pending" as const,
      reason: "Fixture module not written yet.",
      planRef: "3e rollout",
    },
  };
  it("lists a fixture module's open rows, sorted", () => {
    expect(conformanceGaps("sq", gaps, excluded).map((g) => g.row)).toEqual(["S3.a", "S8.b"]);
  });
  it("is empty for a gateway whose rows all pass, and for the test gateway", () => {
    expect(conformanceGaps("st", gaps, excluded)).toEqual([]);
    expect(conformanceGaps("tm", gaps, excluded)).toEqual([]);
  });
  it("is one `fixtures` gap for a gateway without fixtures", () => {
    expect(conformanceGaps("pp", gaps, excluded)).toEqual([
      { row: "fixtures", reason: "Fixture module not written yet.", planRef: "3e rollout" },
    ]);
    expect(conformanceGaps("unknown", gaps, excluded)[0]?.row).toBe("fixtures");
  });
});

describe("the checked-in files", () => {
  const gaps = knownGapsByGateway();
  const excluded = conformanceExclusions();
  it("cover every catalog gateway exactly once", () => {
    for (const key of GATEWAY_KEYS)
      expect([key in gaps, key in excluded].filter(Boolean)).toHaveLength(1);
  });
  it("name rows by scenario and carry a reason and a plan item", () => {
    for (const rows of Object.values(gaps))
      for (const [id, g] of Object.entries(rows)) {
        expect(id).toMatch(/^S\d{1,2}(\.|$)/);
        expect(g.reason.trim()).not.toBe("");
        expect(g.planRef).toMatch(/^3f /);
      }
  });
});
