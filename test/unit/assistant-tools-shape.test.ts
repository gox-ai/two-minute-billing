import { describe, expect, it } from "vitest";
import { capResult, stripInvisible } from "@/modules/assistant-tools/shape";

describe("stripInvisible", () => {
  it("removes zero-width, bidi and tag characters at any depth", () => {
    const dirty = {
      name: "Lark​field‮",
      meta: { note: "pay\u{E0041}\u{E0042}now", list: ["a﻿b"] },
    };
    expect(stripInvisible(dirty)).toEqual({
      name: "Larkfield",
      meta: { note: "paynow", list: ["ab"] },
    });
  });

  it("keeps real text, numbers and nulls", () => {
    const v = { name: "Zoë Ångström 東京", amount_minor: 1299, gone: null, ok: true };
    expect(stripInvisible(v)).toEqual(v);
  });
});

describe("capResult", () => {
  it("returns small results unchanged", () => {
    expect(capResult({ a: 1 })).toBe('{"a":1}');
  });

  it("halves data arrays and says so when a page is too large", () => {
    const page = {
      object: "list",
      data: Array.from({ length: 400 }, (_, i) => ({ i, pad: "x".repeat(200) })),
    };
    const out = JSON.parse(capResult(page, 20_000));
    expect(out.data.length).toBeLessThan(400);
    expect(out.data[0].i).toBe(0);
    expect(out.truncated).toMatch(/starting_after/);
  });

  it("never returns more than the cap", () => {
    const blob = { text: "y".repeat(100_000) };
    expect(capResult(blob, 5_000).length).toBeLessThanOrEqual(5_000);
  });
});
