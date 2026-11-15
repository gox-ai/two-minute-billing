import { describe, expect, it } from "vitest";
import { StreamGuard } from "@/modules/assistant/leaks";
import { lean, shapeForModel } from "@/modules/assistant-tools/shape";
import { nearPaths, normalizeReadArgs } from "@/modules/assistant/read-api";
import { memberSteps } from "@/modules/assistant/visibility";
import { FollowUpFilter, withoutFollowUps } from "@/modules/assistant/follow-ups";
import { bodyError, compactSchema, withSchema } from "@/modules/assistant/action-rules";
import { dropUnverifiedLinks, recordPaths } from "@/modules/assistant/figures";

const SOURCE = `export function computeProrationCredit(item: Item, at: Date) {
  const unused = item.periodEnd.getTime() - at.getTime();
  return Math.round((item.amountMinor * unused) / item.periodLength);
}`;

/** Stream `text` in small pieces through a guard, as the model's deltas arrive. */
function streamed(text: string, sources: string[]) {
  const g = new StreamGuard(sources);
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 7) parts.push(g.push(text.slice(i, i + 7)));
  parts.push(g.flush());
  return { text: parts.join(""), firstAt: parts.findIndex(Boolean) };
}

describe("StreamGuard", () => {
  it("lets plain words through before the line ends", () => {
    const r = streamed("The credit is the unused part of the period, rounded to the cent.", [
      SOURCE,
    ]);
    expect(r.text).toBe("The credit is the unused part of the period, rounded to the cent.");
    expect(r.firstAt).toBeLessThan(5);
  });

  it("never shows a copied line, a copied block, a path or a source name", () => {
    const answer =
      "It is prorated.\nreturn Math.round((item.amountMinor * unused) / item.periodLength);\n```ts\nconst unused = item.periodEnd.getTime() - at.getTime();\n```\nSee src/modules/subscriptions/proration.ts and `computeProrationCredit`.\n";
    const r = streamed(answer, [SOURCE]);
    expect(r.text).not.toMatch(/Math\.round|periodEnd|src\/modules|computeProrationCredit/);
    expect(r.text).toContain("It is prorated.");
  });

  it("checks against source read after it was made", () => {
    const sources: string[] = [];
    const g = new StreamGuard(sources);
    sources.push(SOURCE);
    const out = g.push("  return Math.round((item.amountMinor * unused) / item.periodLength);\n");
    expect(out).toBe("");
  });
});

describe("shapeForModel", () => {
  it("drops empty fields, type tags and large metadata; says a shared value once", () => {
    const page = {
      object: "list",
      data: [1, 2, 3].map((i) => ({
        id: `inv_${i}`,
        object: "invoice",
        currency: "USD",
        voided_at: null,
        notes: "",
        lines: [],
        metadata: { blob: "x".repeat(500) },
        total_minor: i * 100,
      })),
    };
    const out = lean(page) as { data: Array<Record<string, unknown>>; same_in_every_row: object };
    expect(out.same_in_every_row).toEqual({
      currency: "USD",
      metadata: "(left out: large; read the record alone to see it)",
    });
    expect(out.data[0]).toEqual({ id: "inv_1", total_minor: 100 });
  });

  it("shows 10 rows of a list unless asked, and never invites paging past them", () => {
    const page = {
      data: Array.from({ length: 25 }, (_, i) => ({ id: `cus_${i}`, n: i })),
      has_more: true,
      next_cursor: "abc",
    };
    const out = JSON.parse(shapeForModel(page, { rows: 10 }));
    expect(out.data).toHaveLength(10);
    expect(out.next_cursor).toBeUndefined();
    expect(out.more_rows).toMatch(/10 of the 25 rows read \(more exist\).*limit/);
  });

  it("keeps a large result whole JSON under the cap, cutting long text first", () => {
    const big = { sections: Array.from({ length: 30 }, () => ({ text: "y".repeat(5_000) })) };
    const text = shapeForModel(big, { max: 20_000 });
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("read_api arguments", () => {
  it("mends a full path, a query string and nested filters", () => {
    expect(
      normalizeReadArgs({
        path: "/v1/businesses/biz_123/credit_notes?status[is]=issued&limit=5",
        query: { filters: { "customer[is]": "cus_1" } },
      }),
    ).toEqual({
      path: "credit_notes",
      query: { "status[is]": "issued", limit: "5", "customer[is]": "cus_1" },
    });
    expect(normalizeReadArgs({ path: "customers/cus_1/wallet/" })).toEqual({
      path: "customers/cus_1/wallet",
      query: undefined,
    });
  });

  it("names the readable paths near one that is not", () => {
    expect(nearPaths("subscriptions/sub_1/invoices")).toContain("subscriptions/{sub}");
    expect(nearPaths("plans")).toContain("products");
  });
});

describe("prefetched steps", () => {
  it("are stored but never shown to the member", () => {
    const steps = [
      { name: "get_invoice", label: "Read invoice inv_1", ok: true, prefetched: true },
      { name: "get_invoice", label: "Read invoice inv_1", ok: true },
      { name: "research", label: "Researched: x", ok: true },
    ];
    expect(memberSteps(steps)).toEqual([steps[1]]);
  });
});

describe("follow-ups line", () => {
  const run = (text: string, size = 5) => {
    const f = new FollowUpFilter();
    let out = "";
    for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
    out += f.flush();
    return { out, questions: f.questions };
  };

  it("never reaches the member's screen and becomes the chips", () => {
    const r = run(
      "First line.\nFollow the steps below.\n\nFollow-ups: When is the next retry? | Show unpaid invoices",
    );
    expect(r.out).toBe("First line.\nFollow the steps below.\n\n");
    expect(r.questions).toEqual(["When is the next retry?", "Show unpaid invoices"]);
  });

  it("reads a bold marker and drops it from the stored answer", () => {
    const text = "Done.\n**Follow-ups:** What is MRR? | Who churned?";
    expect(run(text, 3).questions).toEqual(["What is MRR?", "Who churned?"]);
    expect(withoutFollowUps(text)).toBe("Done.");
  });

  it("keeps an answer without one unchanged", () => {
    expect(run("Fine.\n- Follow these steps\nok").out).toBe("Fine.\n- Follow these steps\nok");
  });
});

describe("a refused proposal teaches the body", () => {
  it("lists the operation's fields with their allowed values", () => {
    const s = compactSchema("POST coupons")!;
    expect(s).toMatch(/^POST coupons body: \{code: string/);
    expect(s).toContain('kind: "percentage"|"fixed_amount"');
    expect(withSchema("Missing code.", "POST coupons")).toMatch(
      /^Missing code\. POST coupons body:/,
    );
  });

  it("refuses a per-item coupon that names no item", () => {
    const body = {
      code: "A",
      kind: "percentage",
      percent_off_bps: 5000,
      apply_on: "each_specified_item",
    };
    expect(
      bodyError("POST coupons", { ...body, item_constraints: [{ item_kind: "plan" }] }),
    ).toMatch(/needs item_constraints/);
    expect(
      bodyError("POST coupons", {
        ...body,
        item_constraints: [
          { item_kind: "plan", constraint_type: "specific", price_ids: ["price_1"] },
        ],
      }),
    ).toBeNull();
  });
});

describe("links no tool returned", () => {
  it("are taken out, their words kept; given links stay", () => {
    const answer =
      "Open [API keys](/developer), not [this](/settings/nowhere). See https://twominutebilling.com/help/made-up.";
    expect(
      dropUnverifiedLinks(answer, [
        "/settings/nowhere",
        "https://twominutebilling.com/help/made-up",
      ]),
    ).toBe("Open [API keys](/developer), not this. See");
  });

  it("a record the turn read may be linked", () => {
    expect(recordPaths("biz_1", ["inv_1", "cus_2", "evt_3"])).toEqual([
      "/businesses/biz_1/invoices/inv_1",
      "/businesses/biz_1/customers/cus_2",
    ]);
  });
});
