import { describe, expect, it, vi, afterEach } from "vitest";
import { publicId, uuidv7 } from "../../src/platform/ids";

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.useRealTimers());

describe("publicId", () => {
  it("keeps the 24-character shape the API documents", () => {
    expect(publicId("biz")).toMatch(/^biz_[A-Za-z0-9]{24}$/);
  });

  it("sorts by creation time, in byte order and in a case-insensitive locale", () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    for (const t of [1_700_000_000_000, 1_700_000_000_001, 1_800_000_000_000, 2_000_000_000_000]) {
      vi.setSystemTime(t);
      ids.push(publicId("inv"));
    }
    expect([...ids].sort()).toEqual(ids);
    expect([...ids].sort((a, b) => a.slice(0, 13).localeCompare(b.slice(0, 13), "en-US"))).toEqual(
      ids,
    );
  });
});

describe("uuidv7", () => {
  it("is RFC 9562 version 7 with the creation ms up front", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_792_600_000_000);
    const u = uuidv7();
    expect(u).toMatch(V7);
    expect(parseInt(u.replace(/-/g, "").slice(0, 12), 16)).toBe(1_792_600_000_000);
  });

  it("sorts by creation time as text", () => {
    vi.useFakeTimers();
    const ids = [1, 2, 1000, 5_000_000].map((d) => {
      vi.setSystemTime(1_792_600_000_000 + d);
      return uuidv7();
    });
    expect([...ids].sort()).toEqual(ids);
  });
});
