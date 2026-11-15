import { describe, expect, it } from "vitest";
import {
  blockingErrors,
  checkExclusionKeys,
  countStatuses,
  defaultPolicy,
  dependencyBlocker,
  effectiveState,
  finalStatus,
  needsLiveOverride,
  pairKey,
  sortItems,
  warnings,
  type GraphItem,
  type ItemStatus,
} from "@/modules/transfer/graph";

const item = (key: string, over: Partial<GraphItem> = {}): GraphItem => ({
  pair: "main",
  section: "catalog",
  kind: (key.split(":")[0] as GraphItem["kind"]) ?? "product",
  key,
  label: key,
  action: "create",
  excluded: false,
  dependsOn: [],
  messages: [],
  ...over,
});

describe("transfer plan order", () => {
  it("puts referenced rows before the rows that reference them, twin pair first", () => {
    const sorted = sortItems([
      item("price:p1", { kind: "price" }),
      item("settings.default_due_days", { kind: "field", section: "settings" }),
      item("product:a", { kind: "product" }),
      item("email_sending.email_config", { kind: "field", section: "email_sending" }),
      item("meter:calls", { kind: "meter" }),
      item("tax_profile:GST", { kind: "tax_profile", section: "tax_rates" }),
      item("coupon:SAVE", { kind: "coupon", section: "coupons" }),
      item("product:a", { kind: "product", pair: "twin" }),
      item("clear:catalog", { kind: "clear" }),
    ]);
    expect(sorted.map((i) => `${i.pair}:${i.key}`)).toEqual([
      "twin:product:a",
      "main:clear:catalog",
      "main:meter:calls",
      "main:tax_profile:GST",
      "main:product:a",
      "main:price:p1",
      "main:coupon:SAVE",
      "main:settings.default_due_days",
      "main:email_sending.email_config",
    ]);
  });
});

describe("transfer validation", () => {
  it("blocks the dependants of a blocked item", () => {
    const items = [
      item("product:a", {
        kind: "product",
        action: "blocked",
        messages: [{ level: "error", message: "bad" }],
      }),
      item("price:p", { kind: "price", dependsOn: ["product:a"] }),
    ];
    const eff = effectiveState(items);
    expect(eff.get("main:price:p")!.blocked).toBe(true);
    expect(blockingErrors(items)).toHaveLength(2);
  });

  it("blocks a child of a left-out parent only when the destination lacks the parent", () => {
    const missing = [
      item("product:a", { kind: "product", action: "create", excluded: true }),
      item("price:p", { kind: "price", dependsOn: ["product:a"] }),
    ];
    expect(effectiveState(missing).get("main:price:p")!.blocked).toBe(true);
    const present = [
      item("product:a", { kind: "product", action: "skip", excluded: true }),
      item("price:p", { kind: "price", dependsOn: ["product:a"] }),
    ];
    expect(effectiveState(present).get("main:price:p")!.blocked).toBe(false);
  });

  it("ignores a blocked item that is left out", () => {
    const items = [
      item("product:a", {
        action: "blocked",
        excluded: true,
        messages: [{ level: "error", message: "x" }],
      }),
    ];
    expect(blockingErrors(items)).toEqual([]);
  });

  it("reports warnings without blocking", () => {
    const items = [item("price:p", { messages: [{ level: "warning", message: "no gateway" }] })];
    expect(blockingErrors(items)).toEqual([]);
    expect(warnings(items)).toEqual([{ key: "main:price:p", message: "price:p: no gateway" }]);
  });

  it("refuses unknown exclusion keys", () => {
    expect(checkExclusionKeys([item("product:a")], ["main:product:a", "main:nope"])).toEqual([
      "main:nope",
    ]);
  });
});

describe("conflict policy", () => {
  it("defaults to update for a test destination and skip for a live one", () => {
    expect(defaultPolicy(false, ["catalog"])).toEqual({ catalog: "update" });
    expect(defaultPolicy(true, ["catalog", "settings"])).toEqual({
      catalog: "skip",
      settings: "skip",
    });
  });

  it("needs the live override only to change or delete live records", () => {
    expect(needsLiveOverride([item("product:a", { action: "create" })], true)).toBe(false);
    expect(needsLiveOverride([item("product:a", { action: "update" })], true)).toBe(true);
    expect(needsLiveOverride([item("product:a", { action: "update", excluded: true })], true)).toBe(
      false,
    );
    expect(needsLiveOverride([item("product:a", { action: "update" })], false)).toBe(false);
  });
});

describe("item keys", () => {
  it("are deterministic per pair and natural key", () => {
    expect(pairKey({ pair: "main", key: "price:pro-usd" })).toBe("main:price:pro-usd");
    expect(pairKey({ pair: "twin", key: "price:pro-usd" })).not.toBe(
      pairKey({ pair: "main", key: "price:pro-usd" }),
    );
  });
});

describe("run state", () => {
  const s = (status: ItemStatus, queued = true) => ({ status, queued });

  it("counts only queued items", () => {
    expect(countStatuses([s("done"), s("failed"), s("skipped", false)])).toEqual({
      total: 2,
      pending: 0,
      running: 0,
      done: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it("ends succeeded, partially failed, failed or cancelled", () => {
    const c = (done: number, failed: number) => ({
      total: done + failed,
      pending: 0,
      running: 0,
      done,
      failed,
      skipped: 0,
    });
    expect(finalStatus(c(3, 0), false)).toBe("succeeded");
    expect(finalStatus(c(2, 1), false)).toBe("partially_failed");
    expect(finalStatus(c(0, 2), false)).toBe("failed");
    expect(finalStatus(c(2, 1), true)).toBe("cancelled");
  });

  it("skips an item whose dependency failed, and the main pair when the twin failed", () => {
    const byKey = new Map([
      [
        "main:product:a",
        {
          pair: "main" as const,
          key: "product:a",
          label: "Plan A",
          status: "failed" as ItemStatus,
        },
      ],
    ]);
    expect(dependencyBlocker({ pair: "main", dependsOn: ["product:a"] }, byKey, false)).toMatch(
      /Plan A/,
    );
    expect(dependencyBlocker({ pair: "main", dependsOn: [] }, byKey, true)).toMatch(
      /test business/,
    );
    expect(dependencyBlocker({ pair: "twin", dependsOn: [] }, byKey, true)).toBeNull();
  });
});
