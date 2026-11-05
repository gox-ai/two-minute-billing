import { describe, it, expect } from "vitest";
import {
  checkMetadataWrite,
  checkValue,
  compilePattern,
  assertValidPath,
  assertValidOptions,
  assertValidBounds,
  assertNoConflict,
  resolvePath,
  MetadataRuleError,
  type RuleSpec,
} from "@/modules/metadata-rules/check";

const rule = (r: Partial<RuleSpec> & Pick<RuleSpec, "key" | "dataType">): RuleSpec => ({
  enumOptions: null,
  pattern: null,
  maxLength: null,
  ...r,
});

type Write = Parameters<typeof checkMetadataWrite>[0];
const write = (w: Partial<Write>): Write => ({
  validation: "on",
  rules: [],
  strict: false,
  next: {},
  existing: null,
  mode: "create",
  scope: "enforce",
  ...w,
});

const refusal = (w: Write): string | null => {
  try {
    checkMetadataWrite(w);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(MetadataRuleError);
    expect((e as MetadataRuleError).param).toBe("metadata");
    return (e as Error).message;
  }
};

describe("checkValue: each type, no coercion", () => {
  it.each([
    ["string", "abc", true],
    ["string", 12, false],
    ["number", 12.5, true],
    ["number", "12", false],
    ["number", Number.NaN, false],
    ["boolean", false, true],
    ["boolean", "true", false],
    ["email", "a@example.com", true],
    ["email", "not-an-email", false],
    ["date", "2026-10-08", true],
    ["date", "2026-10-08T09:30:00Z", true],
    ["date", "2026-02-30", false],
    ["date", "08/10/2026", false],
    ["object", { a: 1 }, true],
    ["object", [1], false],
    ["object", "x", false],
    ["array", [1, "a"], true],
    ["array", { 0: 1 }, false],
  ] as const)("%s accepts %j: %s", (dataType, value, ok) => {
    expect(checkValue(rule({ key: "k", dataType }), value) === null).toBe(ok);
  });

  it("enum must be one of its options", () => {
    const r = rule({ key: "tier", dataType: "enum", enumOptions: ["gold", "silver"] });
    expect(checkValue(r, "gold")).toBeNull();
    expect(checkValue(r, "bronze")).toBe('Metadata path "tier" must be one of: gold, silver.');
  });

  it("null passes the type check: every path is optional", () => {
    expect(checkValue(rule({ key: "k", dataType: "number" }), null)).toBeNull();
  });

  it("max_length and a full-value pattern apply to text types", () => {
    const r = rule({ key: "crm", dataType: "string", pattern: "A-\\d{4}", maxLength: 6 });
    expect(checkValue(r, "A-1024")).toBeNull();
    expect(checkValue(r, "xA-1024")).toMatch(/too long/);
    expect(
      checkValue(rule({ key: "crm", dataType: "string", pattern: "A-\\d{4}" }), "xA-1024"),
    ).toMatch(/does not match/);
  });
});

describe("compilePattern: refused at config time", () => {
  it("refuses a repeated group holding a repeat", () => {
    expect(() => compilePattern("(a+)+$")).toThrow(/repeated group/);
  });
  it("refuses an invalid regex", () => {
    expect(() => compilePattern("(abc")).toThrow(/not a valid regular expression/);
  });
  it("anchors the pattern to the whole value", () => {
    expect(compilePattern("\\d+").test("12a")).toBe(false);
    expect(compilePattern("\\d+").test("12")).toBe(true);
  });
});

describe("resolvePath", () => {
  it("finds a nested value, reports absence and a blocked intermediate", () => {
    expect(resolvePath({ a: { b: 1 } }, ["a", "b"])).toEqual({ state: "value", value: 1 });
    expect(resolvePath({ a: {} }, ["a", "b"])).toEqual({ state: "absent" });
    expect(resolvePath({}, ["a", "b"])).toEqual({ state: "absent" });
    expect(resolvePath({ a: null }, ["a", "b"])).toEqual({ state: "absent" });
    expect(resolvePath({ a: "x" }, ["a", "b"])).toMatchObject({ state: "blocked", at: "a" });
    expect(resolvePath({ a: [1] }, ["a", "b"])).toMatchObject({ state: "blocked", at: "a" });
  });
});

describe("the validation switch", () => {
  const tier = rule({ key: "tier", dataType: "enum", enumOptions: ["gold"] });
  it("off: a write that breaks a rule passes, and strict is ignored", () => {
    expect(
      refusal(
        write({ validation: "off", rules: [tier], strict: true, next: { tier: "x", other: 1 } }),
      ),
    ).toBeNull();
  });
  it("on: the same write is refused", () => {
    expect(refusal(write({ rules: [tier], next: { tier: "x" } }))).toMatch(/must be one of/);
  });
});

describe("checkMetadataWrite: flat keys", () => {
  const tier = rule({ key: "tier", dataType: "enum", enumOptions: ["gold", "silver"] });
  const crm = rule({ key: "crm_id", dataType: "string", pattern: "A-\\d+" });

  it("judges every present path with a rule on create", () => {
    expect(refusal(write({ rules: [tier, crm], next: { tier: "bronze", crm_id: "A-1" } }))).toMatch(
      /tier/,
    );
  });

  it("every path is optional: absent or null passes with validation on and a rule present", () => {
    expect(refusal(write({ rules: [tier, crm], next: {} }))).toBeNull();
    expect(refusal(write({ rules: [tier, crm], next: null }))).toBeNull();
    expect(refusal(write({ rules: [crm], next: { crm_id: null } }))).toBeNull();
  });

  it("an update may remove or null a ruled value", () => {
    const existing = { crm_id: "A-1" };
    expect(refusal(write({ rules: [crm], mode: "update", existing, next: {} }))).toBeNull();
    expect(
      refusal(write({ rules: [crm], mode: "update", existing, next: { crm_id: null } })),
    ).toBeNull();
  });

  it("an unchanged non-conforming value passes on update; a changed one is judged", () => {
    const existing = { tier: "bronze", note: "x" };
    expect(
      refusal(
        write({ rules: [tier], mode: "update", existing, next: { tier: "bronze", note: "y" } }),
      ),
    ).toBeNull();
    expect(
      refusal(write({ rules: [tier], mode: "update", existing, next: { tier: "copper" } })),
    ).toMatch(/must be one of/);
  });

  it("supplied_only checks types but not strict", () => {
    const w = { rules: [tier, crm], strict: true, scope: "supplied_only" as const };
    expect(refusal(write({ ...w, next: { other: 1 } }))).toBeNull();
    expect(refusal(write({ ...w, next: { tier: "bronze" } }))).toMatch(/must be one of/);
  });

  it("off scope checks nothing", () => {
    expect(
      refusal(write({ rules: [tier, crm], strict: true, scope: "off", next: { tier: 1 } })),
    ).toBeNull();
  });
});

describe("checkMetadataWrite: nested paths", () => {
  const po = rule({ key: "billing.po", dataType: "string", pattern: "PO-\\d+" });
  const city = rule({ key: "billing.address.city", dataType: "string", maxLength: 10 });

  it("checks a value at a nested path", () => {
    expect(refusal(write({ rules: [po], next: { billing: { po: "PO-12" } } }))).toBeNull();
    expect(refusal(write({ rules: [po], next: { billing: { po: "12" } } }))).toMatch(
      /"billing.po" does not match/,
    );
  });

  it("a missing intermediate is absence, not a failure", () => {
    expect(refusal(write({ rules: [po], next: {} }))).toBeNull();
    expect(refusal(write({ rules: [po], next: { billing: {} } }))).toBeNull();
  });

  it("an intermediate that is not an object fails the rule on that path", () => {
    expect(refusal(write({ rules: [po], next: { billing: "none" } }))).toBe(
      'Metadata path "billing.po" cannot be checked: "billing" is string, not an object.',
    );
  });

  it("a rule three levels deep checks the value there, and passes when it is absent", () => {
    expect(
      refusal(
        write({ rules: [city], next: { billing: { address: { city: "Thiruvananthapuram" } } } }),
      ),
    ).toMatch(/"billing.address.city" is too long/);
    expect(refusal(write({ rules: [city], next: { billing: { address: {} } } }))).toBeNull();
    expect(
      refusal(write({ rules: [city], next: { billing: { address: { city: "Pune" } } } })),
    ).toBeNull();
  });

  it("an unchanged nested value is not judged on update", () => {
    const existing = { billing: { po: "bad" } };
    expect(
      refusal(
        write({ rules: [po], mode: "update", existing, next: { billing: { po: "bad" }, x: 1 } }),
      ),
    ).toBeNull();
  });

  it("object and array rules check the shape at a path", () => {
    const tags = rule({ key: "billing.tags", dataType: "array" });
    const extra = rule({ key: "extra", dataType: "object" });
    expect(refusal(write({ rules: [tags], next: { billing: { tags: "a" } } }))).toMatch(
      /must be an array/,
    );
    expect(refusal(write({ rules: [extra], next: { extra: [1] } }))).toMatch(/must be an object/);
    expect(
      refusal(write({ rules: [tags, extra], next: { billing: { tags: [] }, extra: {} } })),
    ).toBeNull();
  });
});

describe("strict mode, level by level", () => {
  const po = rule({ key: "billing.po", dataType: "string" });
  const extra = rule({ key: "extra", dataType: "object" });
  const strict = (next: Record<string, unknown>, existing: Record<string, unknown> | null = null) =>
    refusal(
      write({
        rules: [po, extra],
        strict: true,
        next,
        existing,
        mode: existing ? "update" : "create",
      }),
    );

  it("top level: a key with no rule and no rule below it is refused", () => {
    expect(strict({ other: 1 })).toMatch(/"other" is not allowed/);
  });
  it("an ancestor of a rule path is covered", () => {
    expect(strict({ billing: { po: "x" } })).toBeNull();
  });
  it("a level that has child rules is checked: an uncovered child is refused", () => {
    expect(strict({ billing: { po: "x", note: "y" } })).toMatch(/"billing.note" is not allowed/);
  });
  it("inside an object rule with no child rules, keys are free-form", () => {
    expect(strict({ extra: { anything: { deep: [1] } } })).toBeNull();
  });
  it("an unchanged stored uncovered key passes; a new one is refused", () => {
    expect(strict({ legacy: 1, billing: { po: "x" } }, { legacy: 1 })).toBeNull();
    expect(strict({ legacy: 2 }, { legacy: 1 })).toMatch(/"legacy" is not allowed/);
  });
  it("with no rules at all, strict refuses every new key", () => {
    expect(refusal(write({ rules: [], strict: true, next: { a: 1 } }))).toMatch(/not allowed/);
  });
});

describe("rule config", () => {
  it("accepts a dot path up to 5 levels of safe segments", () => {
    expect(() => assertValidPath("crm_id")).not.toThrow();
    expect(() => assertValidPath("billing.address.city")).not.toThrow();
    expect(() => assertValidPath("a.b.c.d.e")).not.toThrow();
  });
  it("refuses depth, empty segments, long segments and unsafe characters", () => {
    expect(() => assertValidPath("a.b.c.d.e.f")).toThrow(/at most 5 levels/);
    expect(() => assertValidPath("a..b")).toThrow(/1 to 64/);
    expect(() => assertValidPath(".a")).toThrow(/1 to 64/);
    expect(() => assertValidPath("x".repeat(65))).toThrow(/1 to 64/);
    expect(() => assertValidPath("bad key")).toThrow(/letters, digits/);
    expect(() => assertValidPath("a[0]")).toThrow(/letters, digits/);
  });

  it("pattern and max_length apply only to text types; enum_options only to enum", () => {
    expect(() => assertValidOptions("number", { pattern: "\\d+" })).toThrow(/pattern applies/);
    expect(() => assertValidOptions("object", { maxLength: 3 })).toThrow(/max_length applies/);
    expect(() => assertValidOptions("string", { enumOptions: ["a"] })).toThrow(/enum_options/);
    expect(() => assertValidOptions("enum", { enumOptions: ["a", "a"] })).toThrow(/different/);
    expect(() =>
      assertValidOptions("enum", { enumOptions: ["a", "b"], maxLength: 5 }),
    ).not.toThrow();
  });
});

describe("rule conflicts", () => {
  it("refuses the same path twice, even against an archived rule", () => {
    expect(() =>
      assertNoConflict({ key: "a.b", dataType: "string" }, [
        { key: "a.b", dataType: "number", archived: true },
      ]),
    ).toThrow(/already exists/);
  });
  it("refuses a child under a non-object parent rule", () => {
    expect(() =>
      assertNoConflict({ key: "billing.po", dataType: "string" }, [
        { key: "billing", dataType: "string" },
      ]),
    ).toThrow(/Only an object rule can have rules below it/);
  });
  it("refuses a non-object rule at a path that has child rules", () => {
    expect(() =>
      assertNoConflict({ key: "billing", dataType: "array" }, [
        { key: "billing.po", dataType: "string" },
      ]),
    ).toThrow(/must be object/);
  });
  it("allows an object parent with children, and ignores archived rules for type conflicts", () => {
    expect(() =>
      assertNoConflict({ key: "billing", dataType: "object" }, [
        { key: "billing.po", dataType: "string" },
      ]),
    ).not.toThrow();
    expect(() =>
      assertNoConflict({ key: "billing.po", dataType: "string" }, [
        { key: "billing", dataType: "string", archived: true },
      ]),
    ).not.toThrow();
  });
});

describe("number bounds (0333)", () => {
  const limit = rule({
    key: "limit_overrides.accounts",
    dataType: "number",
    integerOnly: true,
    minValue: 0,
  });
  it("accepts whole numbers at and above the inclusive minimum", () => {
    expect(checkValue(limit, 0)).toBeNull();
    expect(checkValue(limit, 150)).toBeNull();
  });
  it("refuses a negative and a fraction, naming the path and the bound", () => {
    expect(checkValue(limit, -5)).toBe(
      'Metadata path "limit_overrides.accounts" must be a whole number of 0 or more.',
    );
    expect(checkValue(limit, 1.5)).toMatch(/must be a whole number of 0 or more/);
  });
  it("treats min and max as inclusive", () => {
    const r = rule({ key: "n", dataType: "number", minValue: 1, maxValue: 10 });
    expect(checkValue(r, 1)).toBeNull();
    expect(checkValue(r, 10)).toBeNull();
    expect(checkValue(r, 0.5)).toBe('Metadata path "n" must be a number from 1 to 10.');
    expect(checkValue(r, 10.01)).toMatch(/from 1 to 10/);
  });
  it("names an upper bound alone", () => {
    expect(checkValue(rule({ key: "n", dataType: "number", maxValue: 3 }), 4)).toBe(
      'Metadata path "n" must be a number of 3 or less.',
    );
  });
  it("leaves a number rule without bounds as before", () => {
    expect(checkValue(rule({ key: "n", dataType: "number" }), -1.25)).toBeNull();
  });
});

describe("array items (0333)", () => {
  const scheduling = rule({
    key: "limit_overrides.scheduling",
    dataType: "array",
    itemType: "string",
    itemEnumOptions: ["Hourly", "Daily", "Weekly", "Monthly"],
  });
  it("accepts allowed items and an empty array", () => {
    expect(checkValue(scheduling, ["Hourly", "Daily"])).toBeNull();
    expect(checkValue(scheduling, [])).toBeNull();
  });
  it("refuses an item outside the options, naming its index", () => {
    expect(checkValue(scheduling, ["Hourly", "Yearly"])).toBe(
      'Metadata path "limit_overrides.scheduling"[1] must be one of: Hourly, Daily, Weekly, Monthly.',
    );
  });
  it("refuses an item of the wrong type", () => {
    const nums = rule({ key: "a", dataType: "array", itemType: "number" });
    expect(checkValue(nums, [1, "2"])).toBe('Metadata path "a"[1] must be a number, not string.');
    expect(checkValue(rule({ key: "a", dataType: "array", itemType: "boolean" }), [null])).toMatch(
      /\[0\] must be true or false, not null/,
    );
  });
  it("enforces the item count", () => {
    const r = rule({ key: "a", dataType: "array", minItems: 1, maxItems: 2 });
    expect(checkValue(r, [])).toBe('Metadata path "a" must have 1 or more items.');
    expect(checkValue(r, [1, 2, 3])).toBe('Metadata path "a" must have 2 or fewer items.');
  });
  it("leaves an array rule without item options as before", () => {
    expect(checkValue(rule({ key: "a", dataType: "array" }), [1, "x", null])).toBeNull();
  });
});

describe("assertValidBounds (0333)", () => {
  it("refuses min greater than max", () => {
    expect(() => assertValidBounds("number", { minValue: 5, maxValue: 1 })).toThrow(
      /min must be less than or equal to max/,
    );
  });
  it("refuses non-finite bounds", () => {
    expect(() => assertValidBounds("number", { minValue: Number.NaN })).toThrow(/finite/);
    expect(() => assertValidBounds("number", { maxValue: Infinity })).toThrow(/finite/);
  });
  it("refuses number options on another type, and array options on another type", () => {
    expect(() => assertValidBounds("string", { integerOnly: true })).toThrow(/number type/);
    expect(() => assertValidBounds("array", { minValue: 0 })).toThrow(/number type/);
    expect(() => assertValidBounds("number", { itemType: "string" })).toThrow(/array type/);
    expect(() => assertValidBounds("object", { minItems: 1 })).toThrow(/array type/);
  });
  it("needs string items for item_enum_options", () => {
    expect(() =>
      assertValidBounds("array", { itemType: "number", itemEnumOptions: ["a"] }),
    ).toThrow(/item_type string/);
    expect(() =>
      assertValidBounds("array", { itemType: "string", itemEnumOptions: ["a", "a"] }),
    ).toThrow(/different values/);
  });
  it("refuses min_items greater than max_items", () => {
    expect(() => assertValidBounds("array", { minItems: 3, maxItems: 1 })).toThrow(/min_items/);
  });
  it("accepts integer false and empty options on any type", () => {
    expect(() =>
      assertValidBounds("string", { integerOnly: false, minValue: null, itemType: null }),
    ).not.toThrow();
  });
});

describe("the limit_overrides shape (0333)", () => {
  const rules: RuleSpec[] = [
    rule({ key: "core_destination", dataType: "enum", enumOptions: ["gs", "gds"] }),
    rule({
      key: "additional_destinations",
      dataType: "array",
      itemType: "string",
      itemEnumOptions: ["gs", "gds"],
    }),
    rule({ key: "limit_overrides", dataType: "object" }),
    ...["accounts", "schedules", "dataSources", "queries", "schedulesPerSheet", "usersCount"].map(
      (k) =>
        rule({ key: `limit_overrides.${k}`, dataType: "number", integerOnly: true, minValue: 0 }),
    ),
    rule({
      key: "limit_overrides.scheduling",
      dataType: "array",
      itemType: "string",
      itemEnumOptions: ["Hourly", "Daily", "Weekly", "Monthly"],
    }),
    rule({ key: "limit_overrides.dataSourceType", dataType: "string" }),
  ];
  const payload = {
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
  const with_ = (lo: Record<string, unknown>) => ({
    ...payload,
    limit_overrides: { ...payload.limit_overrides, ...lo },
  });
  it("accepts the full payload under strict mode", () => {
    expect(refusal(write({ rules, strict: true, next: payload }))).toBeNull();
  });
  it("refuses a typo in a limit name under strict mode", () => {
    expect(refusal(write({ rules, strict: true, next: with_({ schedule: 500 }) }))).toMatch(
      /"limit_overrides.schedule" is not allowed/,
    );
  });
  it("refuses a negative and a fractional limit", () => {
    expect(refusal(write({ rules, next: with_({ accounts: -5 }) }))).toMatch(/0 or more/);
    expect(refusal(write({ rules, next: with_({ accounts: 1.5 }) }))).toMatch(/whole number/);
  });
});
