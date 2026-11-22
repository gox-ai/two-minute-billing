import { describe, expect, it } from "vitest";
import {
  checkFigures,
  recordPaths,
  recordRoutes,
  unprefixedRecordLinks,
} from "@/modules/assistant/figures";

const tool = {
  result: {
    id: "inv_XXXXXXXXXXXX01",
    total_minor: 12900,
    rate: 0.2,
    note: "Paid 3 of 4 on 2026-11-09",
  },
};

describe("checkFigures", () => {
  it("accepts a minor amount shown as major, a fraction as a percent, and numbers in strings", () => {
    const c = checkFigures("Invoice inv_XXXXXXXXXXXX01 is $129.00, tax 20%, 4 attempts.", [tool]);
    expect(c.unverified).toEqual([]);
    expect(c.links).toEqual(["inv_XXXXXXXXXXXX01"]);
  });

  it("flags a figure that no tool returned", () => {
    expect(checkFigures("MRR is $123,456.78.", [tool]).unverified).toEqual(["123,456.78"]);
  });

  it("ignores dates, times, years and small counts", () => {
    const c = checkFigures("On 2026-11-09 at 10:30, in 2026, 3 retries ran.", [tool]);
    expect(c.checked).toBe(0);
  });

  it("does not link an id that no tool returned", () => {
    expect(checkFigures("See inv_madeupmadeup1.", [tool]).unknown_ids).toEqual([
      "inv_madeupmadeup1",
    ]);
  });

  it("flags a docs link that no tool returned, ignoring the fragment", () => {
    const docs = {
      results: [
        { url: "https://twominutebilling.com/help/guides/recover-failed-payments#smart-retries" },
      ],
    };
    const c = checkFigures(
      "See [retries](https://twominutebilling.com/help/guides/recover-failed-payments) and [this](https://twominutebilling.com/help/guides#setting-up).",
      [docs],
    );
    expect(c.unverified_links).toEqual(["https://twominutebilling.com/help/guides#setting-up"]);
  });

  it("accepts a dashboard path a tool returned and flags a made-up one", () => {
    const screens = { screens: [{ path: "/developer" }] };
    const c = checkFigures("Open [API keys](/developer), not [this](/settings/nowhere).", [
      screens,
    ]);
    expect(c.unverified_links).toEqual(["/settings/nowhere"]);
  });

  it("accepts a decrease written without its sign, in either currency style", () => {
    // explain_mrr_change returns decreases as negative minor amounts.
    const bridge = {
      opening_mrr_minor: 4533393,
      closing_mrr_minor: 4324240,
      change_minor: -209153,
      reasons: [
        { reason: "churn", mrr_delta_minor: -391382 },
        { reason: "contraction", mrr_delta_minor: -31864 },
        { reason: "expansion", mrr_delta_minor: 3510 },
      ],
    };
    const c = checkFigures(
      "MRR fell by $2,091.53. Churn reduced it by $3,913.82; contraction −$318.64; expansion +$35.10.",
      [bridge],
    );
    expect(c.unverified).toEqual([]);
  });

  it("still flags a figure that is in no tool result, signed or not", () => {
    const c = checkFigures("Churn was $1,234.56.", [{ mrr_delta_minor: -391382 }]);
    expect(c.unverified).toEqual(["1,234.56"]);
  });

  it("reads a figure as written: Indian groups, scale words and rounding", () => {
    const ev = [{ closing_mrr_minor: 4790847, total_minor: 12345600, rate: -0.0418 }];
    const ok = "MRR is $47,908, or $47.9k; down 4.2%. Invoice: ₹1,23,456.00, about ₹1.23 lakh.";
    expect(checkFigures(ok, ev).unverified).toEqual([]);
    const wrong = "MRR is $47,910, or $48.2k; down 4.3%. Invoice: ₹1,23,457.00, about ₹1.5 lakh.";
    expect(checkFigures(wrong, ev).unverified).toEqual([
      "47,910",
      "48.2k",
      "4.3%",
      "1,23,457.00",
      "1.5 lakh",
    ]);
  });

  it("accepts the number of records a list returned", () => {
    const list = { data: Array.from({ length: 42 }, () => ({ total_minor: 1000 })) };
    expect(checkFigures("You have 42 unpaid invoices.", [list]).unverified).toEqual([]);
    expect(checkFigures("You have 45 unpaid invoices.", [list]).unverified).toEqual(["45"]);
  });
});

describe("links for an imported id with no prefix", () => {
  const results = [
    {
      customer: { object: "customer", id: "Qx7LmN2pRt4VwY9Za", first_name: "Ilse" },
      recent_invoices: {
        data: [{ object: "invoice", id: "Wm4Ra9Tc2Lx8", customer: "Qx7LmN2pRt4VwY9Za" }],
      },
    },
  ];
  it("routes a record by the object it came in", () => {
    const routes = recordRoutes(results);
    expect(routes.get("Qx7LmN2pRt4VwY9Za")).toBe("customers");
    expect(routes.get("Wm4Ra9Tc2Lx8")).toBe("invoices");
    expect(recordPaths("biz_1", ["Qx7LmN2pRt4VwY9Za", "inv_9", "zz"], routes)).toEqual([
      "/businesses/biz_1/customers/Qx7LmN2pRt4VwY9Za",
      "/businesses/biz_1/invoices/inv_9",
    ]);
  });
  it("lets the answer link the imported record's page", () => {
    const routes = recordRoutes(results);
    const answer =
      "See [the customer](/businesses/biz_1/customers/Qx7LmN2pRt4VwY9Za) and Wm4Ra9Tc2Lx8.";
    const evidence = [...results, { links: recordPaths("biz_1", routes.keys(), routes) }];
    expect(checkFigures(answer, evidence).unverified_links).toEqual([]);
    expect(unprefixedRecordLinks(answer, routes)).toEqual({
      Qx7LmN2pRt4VwY9Za: "customers",
      Wm4Ra9Tc2Lx8: "invoices",
    });
  });
  it("names no link for an id inside a longer word", () => {
    expect(
      unprefixedRecordLinks("ref xWm4Ra9Tc2Lx8y", new Map([["Wm4Ra9Tc2Lx8", "invoices"]])),
    ).toEqual({});
  });
});
