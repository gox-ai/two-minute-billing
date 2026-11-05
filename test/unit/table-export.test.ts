import { describe, expect, it } from "vitest";
import {
  buildCsv,
  fetchAllPages,
  moneyCell,
  type ExportCell,
} from "../../dashboard/lib/table-export";

type Row = { id: string; mrr: number | null; currency: string };

describe("list export", () => {
  it("writes money in major units with the currency's own decimals", () => {
    const cells: ExportCell<Row>[] = [
      { header: "ID", value: (r) => r.id },
      moneyCell<Row>(
        "MRR",
        (r) => r.mrr,
        (r) => r.currency,
      ),
      { header: "Currency", value: (r) => r.currency },
    ];
    const csv = buildCsv(cells, [
      { id: "sub_1", mrr: 8083, currency: "USD" },
      { id: "sub_2", mrr: 1642, currency: "JPY" },
      { id: "sub_3", mrr: null, currency: "USD" },
    ]);
    expect(csv.split("\n")).toEqual([
      "ID,MRR,Currency",
      "sub_1,80.83,USD",
      "sub_2,1642,JPY",
      "sub_3,,USD",
    ]);
  });

  it("pages until the list ends", async () => {
    const pages = [
      { rows: [1, 2], hasMore: true, nextCursor: "a" },
      { rows: [3], hasMore: false, nextCursor: null },
    ];
    const seen: (string | null)[] = [];
    const out = await fetchAllPages(async (c) => {
      seen.push(c);
      return pages[seen.length - 1]!;
    }, 10);
    expect(out).toEqual({ rows: [1, 2, 3], capped: false });
    expect(seen).toEqual([null, "a"]);
  });

  it("stops at the cap and says the file is incomplete", async () => {
    const out = await fetchAllPages(
      async () => ({ rows: [1, 2, 3], hasMore: true, nextCursor: "next" }),
      5,
    );
    expect(out).toEqual({ rows: [1, 2, 3, 1, 2], capped: true });
  });
});
