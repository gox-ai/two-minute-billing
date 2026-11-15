import { describe, expect, it } from "vitest";
import { TOOLS, type ToolContext } from "@/modules/assistant-tools/catalog";
import {
  aggregate,
  getPath,
  matchesWhere,
  queryRecords,
} from "@/modules/assistant-tools/query";
import type { RouteResult } from "@/modules/assistant-tools/route-call";

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

/** A list that pages: `routes[rel]` is every row; each call returns the next 100 or `limit`. */
function pagedCtx(
  lists: Record<string, Record<string, unknown>[]>,
  others: Record<string, unknown> = {},
  calls: string[] = [],
): ToolContext {
  return {
    business: { id: "biz_A1", timezone: "UTC" } as ToolContext["business"],
    get: async (rel, query): Promise<RouteResult> => {
      calls.push(query ? `${rel}?${new URLSearchParams(query as Record<string, string>)}` : rel);
      if (rel in lists) {
        const all = lists[rel]!;
        const limit = Number(query?.limit ?? 100);
        const from = query?.starting_after ? Number(String(query.starting_after).slice(1)) : 0;
        const data = all.slice(from, from + limit);
        const end = from + data.length;
        return {
          status: 200,
          body: { object: "list", data, has_more: end < all.length, next_cursor: `c${end}` },
        };
      }
      if (rel in others) return { status: 200, body: others[rel] };
      return { status: 403, body: { error: { message: "Your role cannot read this." } } };
    },
    post: async () => ({ status: 404, body: null }),
  };
}

describe("getPath and matchesWhere", () => {
  const row = { amount_due_minor: 970, payer: { pays_with: { type: "PayPal" } }, items: [{ q: 2 }] };
  it("reads dot paths through objects and arrays", () => {
    expect(getPath(row, "payer.pays_with.type")).toBe("PayPal");
    expect(getPath(row, "items.0.q")).toBe(2);
    expect(getPath(row, "payer.missing.x")).toBeUndefined();
  });
  it("compares without case, with lists and with operators", () => {
    expect(matchesWhere(row, { "payer.pays_with.type": "paypal" })).toBe(true);
    expect(matchesWhere(row, { "payer.pays_with.type": ["card", "upi"] })).toBe(false);
    expect(matchesWhere(row, { amount_due_minor: { gt: 0, lte: 970 } })).toBe(true);
    expect(matchesWhere(row, { amount_due_minor: { gt: 970 } })).toBe(false);
    expect(matchesWhere(row, { "payer.email": { is_present: false } })).toBe(true);
    expect(matchesWhere(row, { "payer.pays_with.type": { contains: "pay" } })).toBe(true);
    expect(matchesWhere(row, undefined)).toBe(true);
  });
});

describe("aggregate", () => {
  const rows = [
    { currency: "USD", recurring_amount_minor: 1500, customer: "c1", payer: { pays_with: { type: "card" } } },
    { currency: "USD", recurring_amount_minor: 9700, customer: "c2", payer: { pays_with: { type: "paypal" } } },
    { currency: "USD", recurring_amount_minor: 7300, customer: "c2", payer: { pays_with: { type: "paypal" } } },
    { currency: "INR", recurring_amount_minor: 99900, customer: "c3", payer: { pays_with: null } },
  ];
  it("counts by default and sums, averages, counts distinct per group, largest sum first", () => {
    const a = aggregate(rows, {
      group_by: ["currency", "payer.pays_with.type"],
      metrics: [
        { op: "sum", field: "recurring_amount_minor" },
        { op: "count_distinct", field: "customer" },
        { op: "avg", field: "recurring_amount_minor" },
      ],
    });
    expect(a.totals).toEqual({
      count: 4,
      sum_recurring_amount_minor: 118400,
      count_distinct_customer: 3,
      avg_recurring_amount_minor: 29600,
    });
    expect(a.groups.map((g) => [g.key, g.count, g.sum_recurring_amount_minor])).toEqual([
      [{ currency: "INR", "payer.pays_with.type": null }, 1, 99900],
      [{ currency: "USD", "payer.pays_with.type": "paypal" }, 2, 17000],
      [{ currency: "USD", "payer.pays_with.type": "card" }, 1, 1500],
    ]);
    expect(aggregate(rows, {}).totals).toEqual({ count: 4 });
    expect(aggregate([], { metrics: [{ op: "min", field: "x" }] }).totals).toEqual({ count: 0, min_x: null });
  });
});

describe("queryRecords", () => {
  const subs = Array.from({ length: 250 }, (_, i) => ({
    id: `sub_${i}`,
    customer: `cus_${i % 5}`,
    currency: "USD",
    recurring_amount_minor: 100 * (i + 1),
  }));
  it("reads every page, joins payers once per customer, filters, groups and samples", async () => {
    const calls: string[] = [];
    const others: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      others[`customers/cus_${i}`] = { email: `c${i}@example.com` };
      others[`customers/cus_${i}/payment_methods`] = {
        data: [{ role: "primary", type: i % 2 ? "paypal" : "card", provider: "x", status: "valid" }],
      };
    }
    const out = (await tool("query_records").run(pagedCtx({ subscriptions: subs }, others, calls), {
      resource: "subscriptions",
      filters: { "status[in]": "active" },
      with_payer: true,
      where: { "payer.pays_with.type": "paypal" },
      group_by: ["payer.pays_with.type"],
      metrics: [{ op: "sum", field: "recurring_amount_minor" }],
      sample: 2,
    })) as Record<string, unknown>;
    expect(out.rows_read).toBe(250);
    expect(out.pages).toBe(3);
    expect(out.complete).toBe(true);
    expect(out.rows_matched).toBe(100);
    expect((out.sample as unknown[]).length).toBe(2);
    expect(out.totals).toEqual({ count: 100, sum_recurring_amount_minor: 1255000 });
    // The list filter reached the route; each customer was read once, not once per row.
    expect(calls[0]).toContain("status%5Bin%5D=active");
    expect(calls.filter((c) => c === "customers/cus_1").length).toBe(1);
  });

  it("stops at max_rows and says the figures are partial", async () => {
    const out = (await queryRecords(pagedCtx({ subscriptions: subs }), {
      resource: "subscriptions",
      max_rows: 150,
    })) as Record<string, unknown>;
    expect(out.rows_read).toBe(150);
    expect(out.complete).toBe(false);
    expect(String(out.note)).toContain("150 rows");
  });

  it("refuses a path that is not a list, a denied path and a read the role cannot make", async () => {
    const ctx = pagedCtx({}, { "customers/cus_1": { id: "cus_1" } });
    await expect(queryRecords(ctx, { resource: "customers/cus_1" })).rejects.toThrow(/not a list/);
    await expect(tool("query_records").run(ctx, { resource: "raw_export" })).rejects.toThrow(/not available/);
    await expect(queryRecords(ctx, { resource: "invoices" })).rejects.toThrow(/cannot read/);
  });
});
