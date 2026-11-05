import { describe, it, expect } from "vitest";
import { publicMetadata } from "@/platform/public-metadata";

describe("publicMetadata", () => {
  it("drops the stored import record and keeps the rest", () => {
    const stored = { source: "x", source_id: "1", source_payload: { tax_id: "T" }, note: "n" };
    expect(publicMetadata(stored)).toEqual({ source: "x", source_id: "1", note: "n" });
    expect(stored.source_payload).toEqual({ tax_id: "T" });
  });
  it("passes null and plain bags through", () => {
    expect(publicMetadata(null)).toBeNull();
    expect(publicMetadata(undefined)).toBeNull();
    const md = { a: 1 };
    expect(publicMetadata(md)).toBe(md);
  });
});
