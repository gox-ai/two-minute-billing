import { describe, expect, it } from "vitest";
import {
  resultOf,
  retryable,
  summarize,
  wasQueued,
  type GraphItem,
  type ItemStatus,
} from "@/modules/transfer/graph";
import {
  filterCount,
  itemQueryKey,
  progressCounts,
  reloadLimit,
  resultCounts,
  statusCount,
  withoutPinned,
} from "../../dashboard/lib/transfer-items";

type Row = GraphItem & { status: ItemStatus; skipReason?: string | null };
const item = (key: string, over: Partial<Row> = {}): Row => ({
  pair: "main",
  section: "catalog",
  kind: "product",
  key,
  label: key,
  action: "create",
  excluded: false,
  dependsOn: [],
  messages: [],
  status: "pending",
  skipReason: null,
  ...over,
});

describe("transfer item result", () => {
  it("left out wins over blocked, blocked over the action", () => {
    expect(resultOf({ action: "blocked", excluded: true }, true)).toBe("left_out");
    expect(resultOf({ action: "create", excluded: false }, true)).toBe("blocked");
    expect(resultOf({ action: "skip", excluded: false }, false)).toBe("kept");
    expect(resultOf({ action: "delete", excluded: false }, false)).toBe("deleted");
  });

  it("an item skipped at apply as left out or unchanged was never queued", () => {
    expect(wasQueued({ status: "skipped", skipReason: "excluded" })).toBe(false);
    expect(wasQueued({ status: "skipped", skipReason: "unchanged" })).toBe(false);
    expect(wasQueued({ status: "skipped", skipReason: "dependency" })).toBe(true);
    expect(retryable({ status: "skipped", skipReason: "drift" })).toBe(true);
    expect(retryable({ status: "skipped", skipReason: "cancelled" })).toBe(false);
    expect(retryable({ status: "failed" })).toBe(true);
  });
});

describe("transfer run summary", () => {
  it("counts per section × result; a dependant of a blocked item is blocked too", () => {
    const s = summarize([
      item("tax_profile:GST", { section: "tax_rates", kind: "tax_profile", action: "blocked" }),
      item("product:a", { dependsOn: ["tax_profile:GST"] }),
      item("product:b", { action: "unchanged" }),
      item("product:c", { excluded: true }),
      item("coupon:X", { section: "coupons", kind: "coupon", action: "update" }),
      item("product:a", { pair: "twin" }),
    ]);
    expect(s.total).toBe(6);
    expect(s.results).toMatchObject({ new: 1, blocked: 2, unchanged: 1, left_out: 1, updated: 1 });
    expect(s.sections.map((x) => `${x.pair}:${x.section}`)).toEqual([
      "twin:catalog",
      "main:tax_rates",
      "main:catalog",
      "main:coupons",
    ]);
    expect(s.sections[2]!.results).toMatchObject({ blocked: 1, unchanged: 1, left_out: 1 });
    expect(s.blocked.map((b) => b.key)).toEqual(["main:tax_profile:GST", "main:product:a"]);
    expect(s.blocked[1]!.messages[0]!.message).toContain("tax_profile:GST");
  });

  it("progress counts queued items only, by status", () => {
    const s = summarize([
      item("product:a", { status: "done" }),
      item("product:b", { status: "failed" }),
      item("product:c", { status: "skipped", skipReason: "dependency" }),
      item("product:d", { status: "skipped", skipReason: "excluded", excluded: true }),
      item("product:e", { status: "skipped", skipReason: "unchanged", action: "unchanged" }),
    ]);
    expect(s.sections[0]!.progress).toEqual({
      total: 3,
      pending: 0,
      running: 0,
      done: 1,
      failed: 1,
      skipped: 1,
    });
    expect(s.retryable).toBe(2);
    expect(s.sections[0]!.applied).toEqual({ new: 1, updated: 0, deleted: 0 });
  });
});

describe("transfer item list helpers", () => {
  const zero = { new: 0, updated: 0, deleted: 0, unchanged: 0, kept: 0, blocked: 0, left_out: 0 };
  const progress = { total: 4, pending: 1, running: 1, done: 1, failed: 1, skipped: 0 };
  const summary = {
    total: 18,
    results: { ...zero, new: 5, unchanged: 10, blocked: 1, left_out: 2 },
    sections: [
      { pair: "twin", section: "coupons", results: { ...zero, new: 2 }, progress },
      { pair: "main", section: "coupons", results: { ...zero, new: 3, unchanged: 10 }, progress },
      {
        pair: "main",
        section: "catalog",
        results: { ...zero, blocked: 1, left_out: 2 },
        progress: { ...progress, total: 0, pending: 0, running: 0, done: 0, failed: 0 },
      },
    ],
    retryable: 1,
  };

  it("counts a section over both pairs; changes are new, updated and deleted only", () => {
    expect(resultCounts(summary, "coupons")).toMatchObject({ new: 5, unchanged: 10 });
    expect(resultCounts(summary, "all")).toBe(summary.results);
    expect(filterCount(summary.results, "changes")).toBe(5);
    expect(filterCount(summary.results, "all")).toBe(18);
    expect(filterCount(summary.results, "blocked")).toBe(1);
  });

  it("status counts sum the sections", () => {
    const p = progressCounts(summary);
    expect(p.total).toBe(8);
    expect(statusCount(p, "open")).toBe(4);
    expect(statusCount(p, "queued")).toBe(8);
  });

  it("a refresh reloads what is shown, within one engine page", () => {
    expect(reloadLimit(0)).toBe(100);
    expect(reloadLimit(100)).toBe(100);
    expect(reloadLimit(130)).toBe(200);
    expect(reloadLimit(4000)).toBe(500);
  });

  it("the query key ignores the page size; pinned items are not listed twice", () => {
    expect(itemQueryKey({ result: "blocked", limit: 500 })).toBe(
      itemQueryKey({ result: "blocked" }),
    );
    expect(itemQueryKey({ result: "changes" })).not.toBe(
      itemQueryKey({ result: "changes", q: "a" }),
    );
    expect(withoutPinned([{ key: "a" }, { key: "b" }], [{ key: "a" }])).toEqual([{ key: "b" }]);
  });
});
