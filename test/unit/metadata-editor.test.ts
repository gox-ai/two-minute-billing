import { describe, it, expect } from "vitest";
import {
  buildRuleTree,
  deleteAt,
  displayOf,
  draftRuleFrom,
  fieldKind,
  keySuggestions,
  metaText,
  otherKeys,
  parseField,
  pathOfError,
  ruleError,
  ruleSuggestions,
  setAt,
  uncoveredChildren,
  withOtherKeys,
  type EditorRule,
  type ObservedKey,
} from "../../dashboard/lib/metadata-editor";

const rule = (
  key: string,
  data_type: EditorRule["data_type"],
  extra: Partial<EditorRule> = {},
): EditorRule => ({
  key,
  data_type,
  enum_options: null,
  pattern: null,
  max_length: null,
  integer: false,
  min: null,
  max: null,
  item_type: null,
  item_enum_options: null,
  min_items: null,
  max_items: null,
  description: null,
  ...extra,
});

// The user's subscription shape.
const RULES: EditorRule[] = [
  rule("core_destination", "enum", { enum_options: ["gs", "gds"] }),
  rule("additional_destinations", "array", {
    item_type: "string",
    item_enum_options: ["gs", "gds"],
  }),
  rule("limit_overrides", "object"),
  ...["accounts", "schedules", "dataSources", "queries", "schedulesPerSheet", "usersCount"].map(
    (k) => rule(`limit_overrides.${k}`, "number", { integer: true, min: 0 }),
  ),
  rule("limit_overrides.scheduling", "array", {
    item_type: "string",
    item_enum_options: ["Hourly", "Daily", "Weekly", "Monthly"],
  }),
  rule("limit_overrides.dataSourceType", "string"),
];
const PAYLOAD = {
  core_destination: "gs",
  additional_destinations: ["gds"],
  limit_overrides: {
    accounts: 150,
    schedules: 500,
    dataSources: 40,
    queries: 2000,
    schedulesPerSheet: 10,
    usersCount: 15,
    scheduling: ["Hourly", "Daily"],
    dataSourceType: "All",
  },
};

describe("buildRuleTree", () => {
  it("nests dot paths under their parents", () => {
    const t = buildRuleTree(RULES);
    expect(t.map((n) => n.path)).toEqual([
      "additional_destinations",
      "core_destination",
      "limit_overrides",
    ]);
    const lo = t.find((n) => n.path === "limit_overrides")!;
    expect(lo.rule?.data_type).toBe("object");
    expect(lo.children).toHaveLength(8);
  });

  it("makes a plain group for an ancestor with no rule of its own", () => {
    const [b] = buildRuleTree([rule("billing.po", "string")]);
    expect(b!.path).toBe("billing");
    expect(b!.rule).toBeNull();
    expect(b!.children[0]!.label).toBe("po");
  });
});

describe("setAt / deleteAt", () => {
  it("sets nested values and keeps key order", () => {
    const m = setAt({ a: 1, b: { x: 1 }, c: 3 }, ["b", "y"], 2);
    expect(JSON.stringify(m)).toBe('{"a":1,"b":{"x":1,"y":2},"c":3}');
  });

  it("creates parents as needed", () => {
    expect(setAt(null, ["limit_overrides", "accounts"], 150)).toEqual({
      limit_overrides: { accounts: 150 },
    });
  });

  it("prunes a parent that the delete leaves empty", () => {
    expect(deleteAt({ a: 1, lo: { accounts: 1 } }, ["lo", "accounts"])).toEqual({ a: 1 });
    expect(deleteAt({ lo: { accounts: 1, queries: 2 } }, ["lo", "accounts"])).toEqual({
      lo: { queries: 2 },
    });
  });

  it("leaves the value alone when the path is absent", () => {
    const m = { a: 1 };
    expect(deleteAt(m, ["b", "c"])).toBe(m);
  });
});

describe("form state ↔ metadata", () => {
  it("round-trips the user's payload through every control", () => {
    let m: Record<string, unknown> = {};
    for (const node of buildRuleTree(RULES).flatMap(function walk(n): ReturnType<
      typeof buildRuleTree
    > {
      return n.children.length ? n.children.flatMap(walk) : [n];
    })) {
      const r = node.rule!;
      const kind = fieldKind(r);
      const stored = node.segs.reduce<unknown>(
        (v, s) => (v as Record<string, unknown>)?.[s],
        PAYLOAD,
      );
      const d = displayOf(r, kind, stored !== undefined, stored);
      expect(d.readOnly).toBe(false);
      const p = parseField(r, kind, d.raw);
      expect("error" in p).toBe(false);
      if ("value" in p) m = setAt(m, node.segs, p.value);
    }
    expect(m).toEqual(PAYLOAD);
  });

  it("treats an empty control as absent", () => {
    const r = rule("n", "number");
    expect(parseField(r, "number", "")).toEqual({ absent: true });
    expect(parseField(r, "chips", [])).toEqual({ absent: true });
  });

  it("coerces list items to the item type and names a bad item", () => {
    const r = rule("ids", "array", { item_type: "number" });
    expect(parseField(r, "list", ["1", " 2 "])).toEqual({ absent: false, value: [1, 2] });
    expect(parseField(r, "list", ["1", "x"])).toEqual({ error: "Item 2 must be a number." });
  });

  it("shows a stored value that does not fit the control as read-only", () => {
    const r = rule("core_destination", "enum", { enum_options: ["gs", "gds"] });
    expect(displayOf(r, "select", true, "legacy").readOnly).toBe(true);
    expect(displayOf(r, "select", true, 7).readOnly).toBe(true);
  });

  it("checks values with the API's own checker", () => {
    const accounts = RULES.find((r) => r.key === "limit_overrides.accounts")!;
    expect(ruleError(accounts, -5)).toMatch(/whole number of 0 or more/);
    expect(ruleError(accounts, 1.5)).toMatch(/whole number/);
    expect(ruleError(accounts, 150)).toBeNull();
    const sched = RULES.find((r) => r.key === "limit_overrides.scheduling")!;
    expect(ruleError(sched, ["Hourly", "Yearly"])).toMatch(/\[1\]/);
  });

  it("finds the path in a server refusal", () => {
    expect(pathOfError('Metadata path "limit_overrides.accounts" must be a whole number.')).toBe(
      "limit_overrides.accounts",
    );
    expect(pathOfError("Something else")).toBeNull();
  });

  it("posts the old textarea's format, and nothing for an empty value", () => {
    expect(metaText({})).toBe("");
    expect(metaText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("keys without a rule", () => {
  const stored = {
    source: "x",
    core_destination: "gs",
    limit_overrides: { accounts: 1, legacy: true },
  };

  it("splits out the top-level keys no rule covers", () => {
    expect(otherKeys(stored, RULES)).toEqual({ source: "x" });
  });

  it("keeps covered keys and their order when the other keys change", () => {
    const m = withOtherKeys(stored, RULES, { source: "y", crm: "c" });
    expect(Object.keys(m)).toEqual(["source", "core_destination", "limit_overrides", "crm"]);
    expect(m.source).toBe("y");
  });

  it("drops an other key the operator removed, and nothing else", () => {
    expect(withOtherKeys(stored, RULES, {})).toEqual({
      core_destination: "gs",
      limit_overrides: { accounts: 1, legacy: true },
    });
  });

  it("names the stored keys inside a group that no rule covers", () => {
    const lo = buildRuleTree(RULES).find((n) => n.path === "limit_overrides")!;
    expect(uncoveredChildren(stored, RULES, lo)).toEqual(["legacy"]);
  });
});

describe("suggestions", () => {
  const observed: ObservedKey[] = [
    {
      path: "source",
      rows: 9,
      type: "string",
      distinct_values: 1,
      values: [{ value: "import", rows: 9 }],
      item_values: null,
    },
    {
      path: "core_destination",
      rows: 5,
      type: "string",
      distinct_values: 2,
      values: null,
      item_values: null,
    },
    {
      path: "appSumoPlan",
      rows: 4,
      type: "string",
      distinct_values: 3,
      values: [
        { value: "gox_tier1", rows: 2 },
        { value: "", rows: 2 },
      ],
      item_values: null,
    },
    {
      path: "limit_overrides.extra",
      rows: 1,
      type: "number",
      distinct_values: 1,
      values: null,
      item_values: null,
    },
    {
      path: "tags",
      rows: 3,
      type: "array",
      distinct_values: 2,
      values: null,
      item_values: [
        { value: "a", rows: 3 },
        { value: "b", rows: 1 },
      ],
    },
  ];

  it("suggests top-level keys with no rule that are not already in use", () => {
    expect(keySuggestions(observed, RULES, ["appSumoPlan"]).map((o) => o.path)).toEqual([
      "source",
      "tags",
    ]);
  });

  it("suggests rules for unruled paths, nested ones included", () => {
    expect(ruleSuggestions(observed, RULES).map((o) => o.path)).toEqual([
      "source",
      "appSumoPlan",
      "limit_overrides.extra",
      "tags",
    ]);
  });

  it("drafts an enum for few string values, and plain text when one is empty", () => {
    expect(draftRuleFrom(observed[0]!)).toMatchObject({
      data_type: "enum",
      enum_options: ["import"],
    });
    expect(draftRuleFrom(observed[2]!)).toMatchObject({ data_type: "string", enum_options: null });
  });

  it("drafts an array with string item options", () => {
    expect(draftRuleFrom(observed[4]!)).toMatchObject({
      data_type: "array",
      item_type: "string",
      item_enum_options: ["a", "b"],
    });
  });
});
