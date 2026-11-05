import { describe, expect, it } from "vitest";
import {
  expandExponent,
  JsonNumber,
  parseJsonExact,
  propertiesJson,
} from "@/modules/metering/json-source";
import { pgTextArray, uuidFloor, uuidMs } from "@/modules/metering/usage-sql";

describe("usage JSON numbers from source text", () => {
  it("keeps every digit a float would round", () => {
    const v = parseJsonExact('{"t":1234567890.123456789012}') as { t: JsonNumber };
    expect(v.t).toBeInstanceOf(JsonNumber);
    expect(v.t.text).toBe("1234567890.123456789012");
    expect(JSON.stringify(v)).toBe('{"t":1234567890.123456789012}');
  });

  it("expands an exponent exactly", () => {
    expect(expandExponent("1e3")).toBe("1000");
    expect(expandExponent("1.5e-3")).toBe("0.0015");
    expect(expandExponent("-2E+2")).toBe("-200");
    expect(expandExponent("1.23e1")).toBe("12.3");
    expect(expandExponent("1E-13")).toBe("0.0000000000001");
    expect(expandExponent("12.50")).toBe("12.50");
  });

  it("writes properties back with numbers as received", () => {
    const p = parseJsonExact('{"a":0.10,"b":"x","c":true}') as Record<string, unknown>;
    expect(propertiesJson(p)).toBe('{"a":0.10,"b":"x","c":true}');
  });
});

describe("usage SQL helpers", () => {
  it("uuidFloor orders below every uuid_v7 of that millisecond", () => {
    const ms = 1_762_000_000_123;
    const floor = uuidFloor(ms);
    expect(uuidMs(floor)).toBe(ms);
    expect(floor < uuidFloor(ms + 1)).toBe(true);
  });

  it("pgTextArray quotes, escapes and keeps NULL", () => {
    expect(pgTextArray(['a"b', "c\\d", null, "e,f"])).toBe('{"a\\"b","c\\\\d",NULL,"e,f"}');
  });
});
