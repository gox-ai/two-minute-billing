import { describe, expect, it } from "vitest";
import { TOOLS, withPayers, type ToolContext } from "@/modules/assistant-tools/catalog";
import { linkBareUrls, urlTitles } from "@/modules/assistant/figures";
import { resolveGuide, type MapScreen } from "@/modules/assistant/guide";
import { inPreviousOrder } from "@/modules/assistant/actions";
import { isDeveloperScreen } from "@/modules/assistant/run";
import type { RouteResult } from "@/modules/assistant-tools/route-call";

/** A ToolContext whose GETs answer from a table of path → body; records every call. */
function fakeCtx(routes: Record<string, unknown>, calls: string[] = []): ToolContext {
  return {
    business: { id: "biz_A1" } as ToolContext["business"],
    get: async (rel, query): Promise<RouteResult> => {
      calls.push(query ? `${rel}?${new URLSearchParams(query as Record<string, string>)}` : rel);
      return rel in routes
        ? { status: 200, body: routes[rel] }
        : { status: 403, body: { error: { message: "Your role cannot read this." } } };
    },
    post: async () => ({ status: 404, body: null }),
  };
}

describe("a list with its payers", () => {
  it("adds each customer's name and how they pay, one read per customer", async () => {
    const calls: string[] = [];
    const ctx = fakeCtx(
      {
        "customers/cus_1": { first_name: "Maren", last_name: "Holt", email: "maren@example.com" },
        "customers/cus_1/payment_methods": {
          data: [
            { role: "backup", type: "card", provider: "stripe", status: "valid" },
            { role: "primary", type: "paypal", provider: "paypal", status: "invalid" },
          ],
        },
        "customers/cus_2": { company: "Tidewater Labs", email: "ops@example.com" },
        "customers/cus_2/payment_methods": { data: [] },
      },
      calls,
    );
    const page = {
      object: "list",
      data: [
        { id: "sub_1", customer: "cus_1" },
        { id: "sub_2", customer: "cus_1" },
        { id: "sub_3", customer: "cus_2" },
      ],
    };
    const out = (await withPayers(ctx, page)) as { data: Array<Record<string, unknown>> };
    expect(out.data[0]!.payer).toEqual({
      name: "Maren Holt",
      company: null,
      email: "maren@example.com",
      pays_with: { type: "paypal", provider: "paypal", brand: null, status: "invalid" },
      payment_methods: 2,
    });
    expect(out.data[1]!.payer).toEqual(out.data[0]!.payer);
    expect((out.data[2]!.payer as Record<string, unknown>).pays_with).toBeNull();
    // Two customers: two reads each, not one per row.
    expect(calls.length).toBe(4);
  });

  it("says why a customer cannot be read, and leaves other shapes alone", async () => {
    const ctx = fakeCtx({});
    const out = (await withPayers(ctx, { data: [{ id: "inv_1", customer: "cus_9" }] })) as {
      data: Array<{ payer: { unavailable: string } }>;
    };
    expect(out.data[0]!.payer.unavailable).toContain("cannot read");
    expect(await withPayers(ctx, { object: "estimate" })).toEqual({ object: "estimate" });
  });

  it("list_subscriptions adds payers only when asked", async () => {
    const tool = TOOLS.find((t) => t.name === "list_subscriptions")!;
    const calls: string[] = [];
    const ctx = fakeCtx({ subscriptions: { data: [{ id: "sub_1", customer: "cus_1" }] } }, calls);
    await tool.run(ctx, {});
    expect(calls).toEqual(["subscriptions?limit=25"]);
    await tool.run(ctx, { with_payer: true });
    expect(calls.slice(1)).toContain("customers/cus_1/payment_methods");
  });
});

describe("the customer read", () => {
  it("includes the customer's open disputes", async () => {
    const calls: string[] = [];
    const tool = TOOLS.find((t) => t.name === "get_customer")!;
    const out = (await tool.run(
      fakeCtx({ "customers/cus_1": { id: "cus_1" }, disputes: { data: [{ id: "dsp_1" }] } }, calls),
      { customer: "cus_1" },
    )) as Record<string, unknown>;
    expect(calls).toContain("disputes?customer=cus_1&open=true&limit=10");
    expect(out.open_disputes).toEqual({ data: [{ id: "dsp_1" }] });
  });
});

describe("bare help URLs", () => {
  const results = [
    {
      results: [
        { title: "PayPal", url: "https://twominutebilling.com/help/guides/paypal#connect" },
      ],
    },
  ];
  it("become links titled by their page", () => {
    const titles = urlTitles(results);
    expect(
      linkBareUrls("See https://twominutebilling.com/help/guides/paypal#connect.", titles),
    ).toBe("See [PayPal](https://twominutebilling.com/help/guides/paypal#connect).");
  });
  it("leaves markdown links, autolinks and unknown pages as they are", () => {
    const titles = urlTitles(results);
    const md = "See [the guide](https://twominutebilling.com/help/guides/paypal).";
    expect(linkBareUrls(md, titles)).toBe(md);
    const auto = "See <https://twominutebilling.com/help/guides/paypal>.";
    expect(linkBareUrls(auto, titles)).toBe(auto);
    const other = "See https://twominutebilling.com/help/guides/stripe.";
    expect(linkBareUrls(other, titles)).toBe(other);
  });
});

describe("who a search is for", () => {
  it("a developer screen asks for developer pages; any other screen for guides", () => {
    expect(isDeveloperScreen("/developer")).toBe(true);
    expect(isDeveloperScreen("/developer/webhooks")).toBe(true);
    expect(isDeveloperScreen("/businesses/biz_A1/developer")).toBe(true);
    expect(isDeveloperScreen("/businesses/biz_A1/customers/cus_1")).toBe(false);
    expect(isDeveloperScreen("/developers-guide")).toBe(false);
    expect(isDeveloperScreen(undefined)).toBe(false);
  });
});

describe("Show me steps", () => {
  it("keep what the member does with each control", () => {
    const screens: MapScreen[] = [
      {
        route: "/businesses/{business}/catalog/coupons/new",
        scope: "biz",
        label: "New coupon",
        section: "Catalog",
        controls: ["Percentage", "Create coupon"],
      },
    ];
    const r = resolveGuide({
      businessId: "biz_A1",
      screens,
      id: "call_1",
      known: new Set(),
      input: {
        screen: "/businesses/{business}/catalog/coupons/new",
        steps: [
          { control: "Percentage", say: "Set Percentage to 20.", do: "enter" },
          { control: "Create coupon", say: "Select Create coupon.", do: "submit" },
        ],
      },
    });
    expect("guide" in r && r.guide.steps.map((s) => s.do)).toEqual(["enter", "submit"]);
  });
});

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe("payers read a few at a time", () => {
  it("never has more than 8 customers in flight", async () => {
    let open = 0;
    let peak = 0;
    const ctx: ToolContext = {
      business: { id: "biz_A1" } as ToolContext["business"],
      get: async (rel) => {
        open++;
        peak = Math.max(peak, open);
        await new Promise((r) => setTimeout(r, 2));
        open--;
        return rel.endsWith("payment_methods")
          ? { status: 200, body: { data: [] } }
          : { status: 200, body: { email: `${rel}@example.com` } };
      },
      post: async () => ({ status: 404, body: null }),
    };
    const data = Array.from({ length: 30 }, (_, i) => ({ id: `sub_${i}`, customer: `cus_${i}` }));
    const out = (await withPayers(ctx, { data })) as { data: Array<{ payer: unknown }> };
    expect(out.data.every((r) => !!r.payer)).toBe(true);
    // Two reads per customer, eight customers at a time.
    expect(peak).toBeLessThanOrEqual(16);
  });
});

describe("get_catalog", () => {
  it("returns lean products, prices and coupons", async () => {
    const out = (await tool("get_catalog").run(
      fakeCtx({
        products: {
          data: [{ id: "prod_1", name: "Pro", kind: "plan", active: true, metadata: {} }],
        },
        prices: {
          data: [
            {
              id: "price_1",
              product: "prod_1",
              name: "Pro monthly",
              type: "recurring",
              model: "per_unit",
              amount_minor: 2900,
              currency: "USD",
              interval: "month",
              interval_count: 1,
              active: true,
              tiers: null,
            },
          ],
        },
        coupons: {
          data: [{ id: "SAVE10", name: "Save 10", kind: "percentage", status: "active" }],
        },
      }),
      {},
    )) as Record<string, Array<Record<string, unknown>>>;
    expect(out.products).toEqual([{ id: "prod_1", name: "Pro", kind: "plan", status: "active" }]);
    expect(out.prices![0]).toMatchObject({ id: "price_1", amount_minor: 2900, interval: "month" });
    expect(out.prices![0]).not.toHaveProperty("tiers");
    expect(out.coupons![0]).toMatchObject({ id: "SAVE10", status: "active" });
  });

  it("says why the coupons are missing without coupons:view", async () => {
    const out = (await tool("get_catalog").run(
      fakeCtx({ products: { data: [] }, prices: { data: [] } }),
      {},
    )) as { coupons: { unavailable: string } };
    expect(out.coupons.unavailable).toContain("cannot read");
  });
});

describe("get_upcoming_charges", () => {
  const subs = {
    data: [
      {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        next_billing_at: "2026-11-14T00:00:00Z",
        recurring_amount_minor: 2900,
        currency: "USD",
        items: [{ price: "price_1", quantity: 1, product_name: "Pro", product_kind: "plan" }],
      },
      {
        id: "sub_2",
        customer: "cus_2",
        status: "in_trial",
        next_billing_at: "2026-11-20T00:00:00Z",
        recurring_amount_minor: 1000,
        currency: "USD",
        items: [],
      },
      {
        id: "sub_3",
        customer: "cus_3",
        status: "active",
        next_billing_at: "2026-11-21T00:00:00Z",
        recurring_amount_minor: 99900,
        currency: "INR",
        items: [],
      },
    ],
    has_more: false,
  };

  it("reads the window, adds payers and totals per currency and payment type", async () => {
    const calls: string[] = [];
    const out = (await tool("get_upcoming_charges").run(
      fakeCtx(
        {
          subscriptions: subs,
          "customers/cus_1": { email: "a@example.com" },
          "customers/cus_1/payment_methods": {
            data: [{ role: "primary", type: "card", provider: "stripe", status: "valid" }],
          },
          "customers/cus_2": { email: "b@example.com" },
          "customers/cus_2/payment_methods": { data: [] },
        },
        calls,
      ),
      { from: "2026-11-12", to: "2026-11-30" },
    )) as Record<string, unknown>;
    const q = new URLSearchParams(calls[0]!.split("?")[1]);
    expect(q.get("status[in]")).toBe("active,in_trial,future");
    expect(q.get("next_billing_at[between]")).toBe("2026-11-12,2026-11-30");
    expect(q.get("sort_by[asc]")).toBe("next_billing_at");
    expect(q.get("limit")).toBe("100");
    expect(out.estimate).toBe(true);
    expect((out.data as unknown[]).length).toBe(3);
    expect(out.totals).toEqual([
      {
        currency: "INR",
        count: 1,
        amount_minor: 99900,
        by_payment_type: { unknown: { count: 1, amount_minor: 99900 } },
      },
      {
        currency: "USD",
        count: 2,
        amount_minor: 3900,
        by_payment_type: {
          card: { count: 1, amount_minor: 2900 },
          none: { count: 1, amount_minor: 1000 },
        },
      },
    ]);
  });

  it("payment_type keeps only the rows that pay that way, and totals them", async () => {
    const out = (await tool("get_upcoming_charges").run(
      fakeCtx({
        subscriptions: subs,
        "customers/cus_1": { email: "a@example.com" },
        "customers/cus_1/payment_methods": {
          data: [{ role: "primary", type: "paypal", provider: "paypal", status: "valid" }],
        },
        "customers/cus_2": { email: "b@example.com" },
        "customers/cus_2/payment_methods": {
          data: [{ role: "primary", type: "card", provider: "stripe", status: "valid" }],
        },
      }),
      { from: "2026-11-12", to: "2026-11-30", payment_type: "PayPal" },
    )) as Record<string, unknown>;
    expect(out.payment_type).toBe("paypal");
    expect(out.read).toBe(3);
    expect((out.data as Array<{ id: string }>).map((r) => r.id)).toEqual(["sub_1"]);
    expect(out.totals).toEqual([
      {
        currency: "USD",
        count: 1,
        amount_minor: 2900,
        by_payment_type: { paypal: { count: 1, amount_minor: 2900 } },
      },
    ]);
  });

  it("defaults to the next 30 days in the business timezone", async () => {
    const calls: string[] = [];
    await tool("get_upcoming_charges").run(fakeCtx({ subscriptions: { data: [] } }, calls), {});
    const from = ymd(new Date());
    const to = ymd(
      new Date(Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8) + 30)),
    );
    expect(new URLSearchParams(calls[0]!.split("?")[1]).get("next_billing_at[between]")).toBe(
      `${from},${to}`,
    );
  });

  it("fails without subscriptions:view", async () => {
    await expect(tool("get_upcoming_charges").run(fakeCtx({}), {})).rejects.toThrow(
      /We could not read the upcoming charges/,
    );
  });
});

describe("explain_payment", () => {
  const invoice = {
    id: "inv_1",
    status: "payment_due",
    currency: "USD",
    amount_due_minor: 2900,
    customer: "cus_1",
    attempt_count: 2,
  };

  it("needs an invoice or a payment", async () => {
    await expect(tool("explain_payment").run(fakeCtx({}), {})).rejects.toThrow(
      /Give invoice .* or payment/,
    );
  });

  it("keeps today's keys for an invoice", async () => {
    const out = (await tool("explain_payment").run(
      fakeCtx({ "invoices/inv_1": invoice, "invoices/inv_1/dunning_journey": { steps: [] } }),
      { invoice: "inv_1" },
    )) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["dunning_journey", "invoice", "payment_methods"]);
    expect((out.payment_methods as { unavailable: string }).unavailable).toContain("cannot read");
  });

  it("follows a transaction to its intent and invoice", async () => {
    const out = (await tool("explain_payment").run(
      fakeCtx({
        "transactions/txn_1": {
          id: "txn_1",
          type: "payment",
          status: "failure",
          amount_minor: 2900,
          currency: "USD",
          invoice: "inv_1",
          customer: "cus_1",
          payment_intent: "pi_1",
          error_text: "Card declined",
        },
        "payment_intents/pi_1": {
          id: "pi_1",
          status: "requires_payment_method",
          attempt_count: 1,
          attempts: [
            { attempt_number: 1, status: "failed", error_code: "card_declined", span_id: "x" },
          ],
        },
        "invoices/inv_1": invoice,
        "invoices/inv_1/dunning_journey": { steps: [] },
        "customers/cus_1/payment_methods": { data: [] },
      }),
      { payment: "txn_1" },
    )) as Record<string, Record<string, unknown> & unknown[]>;
    expect(out.invoice!.id).toBe("inv_1");
    expect(out.payment).toMatchObject({
      id: "txn_1",
      kind: "transaction",
      payment_intent: "pi_1",
      error_text: "Card declined",
    });
    expect(out.attempts![0]).toMatchObject({ attempt_number: 1, error_code: "card_declined" });
    expect(out.attempts![0]).not.toHaveProperty("span_id");
    expect(out.payment_methods).toEqual({ data: [] });
  });

  it("answers an intent with no invoice with the intent, attempts and payment methods", async () => {
    const out = (await tool("explain_payment").run(
      fakeCtx({
        "payment_intents/pi_2": {
          id: "pi_2",
          status: "requires_payment_method",
          customer: "cus_1",
          amount_minor: 500,
          currency: "USD",
          attempts: [],
        },
        transactions: { data: [] },
        "customers/cus_1/payment_methods": { data: [] },
      }),
      { payment: "pi_2" },
    )) as Record<string, unknown>;
    expect(out.invoice).toBeNull();
    expect(out.dunning_journey).toBeNull();
    expect(out.payment).toMatchObject({
      kind: "payment_intent",
      customer: "cus_1",
      amount_minor: 500,
    });
    expect(out.attempts).toEqual([]);
    expect(out.payment_methods).toEqual({ data: [] });
  });

  it("an unknown intent is an error", async () => {
    await expect(tool("explain_payment").run(fakeCtx({}), { payment: "pi_x" })).rejects.toThrow(
      /We could not read the payment pi_x/,
    );
  });
});

describe("get_timeline", () => {
  it("merges a customer's events, emails and payments newest first", async () => {
    const calls: string[] = [];
    const out = (await tool("get_timeline").run(
      fakeCtx(
        {
          events: {
            data: [
              {
                id: "ev_1",
                type: "invoice_generated",
                occurred_at: "2026-11-01T10:00:00Z",
                resource: { type: "invoice", id: "inv_1" },
                data: { invoice: { amount_minor: 2900, currency: "USD" } },
              },
            ],
          },
          emails: {
            data: [
              {
                id: "em_1",
                type: "invoice",
                status: "sent",
                to: "a@example.com",
                subject: "Your invoice",
                created_at: "2026-11-01T10:05:00Z",
              },
            ],
          },
          transactions: {
            data: [
              {
                id: "txn_1",
                type: "payment",
                status: "success",
                amount_minor: 2900,
                currency: "USD",
                invoice: "inv_1",
                occurred_at: "2026-11-02T09:00:00Z",
              },
            ],
          },
        },
        calls,
      ),
      { record: "cus_1" },
    )) as { entries: Array<Record<string, unknown>>; notes?: string[] };
    expect(calls).toContain("events?customer=cus_1&limit=40");
    expect(calls).toContain("emails?customer=cus_1&limit=40");
    expect(calls).toContain("transactions?customer=cus_1&limit=40");
    expect(out.entries.map((e) => e.kind)).toEqual(["payment", "email", "event"]);
    expect(out.entries[0]).toMatchObject({
      id: "txn_1",
      status: "success",
      summary: "$29.00 · inv_1",
    });
    expect(out.entries[2]!.summary).toBe("invoice inv_1 · $29.00");
    expect(out.notes).toBeUndefined();
  });

  it("names what it could not read instead of failing", async () => {
    const out = (await tool("get_timeline").run(
      fakeCtx({ events: { data: [] }, transactions: { data: [] } }),
      { record: "inv_1" },
    )) as { entries: unknown[]; notes?: string[] };
    expect(out.entries).toEqual([]);
    expect(out.notes).toBeUndefined();
    const cus = (await tool("get_timeline").run(fakeCtx({ events: { data: [] } }), {
      record: "cus_1",
    })) as { notes: string[] };
    expect(cus.notes).toEqual([
      "We could not read the emails. Your role cannot read this.",
      "We could not read the payments. Your role cannot read this.",
    ]);
  });

  it("reads events by resource for a subscription, and refuses an unknown id", async () => {
    const calls: string[] = [];
    await tool("get_timeline").run(fakeCtx({ events: { data: [] } }, calls), { record: "sub_9" });
    expect(calls).toEqual(["events?resource_type=subscription&resource_id=sub_9&limit=40"]);
    await expect(tool("get_timeline").run(fakeCtx({}), { record: "zz_1" })).rejects.toThrow(
      /cus_, sub_, inv_, pi_ or txn_/,
    );
  });
});

describe("get_collections_queue", () => {
  it("lists invoices by next retry with the total due per currency", async () => {
    const calls: string[] = [];
    const out = (await tool("get_collections_queue").run(
      fakeCtx(
        {
          invoices: {
            data: [
              {
                id: "inv_1",
                number: "1",
                customer: "cus_1",
                customer_name: "A",
                amount_due_minor: 500,
                currency: "USD",
                next_attempt_at: "2026-11-15T00:00:00Z",
                lines: [],
              },
              {
                id: "inv_2",
                number: "2",
                customer: "cus_2",
                customer_name: "B",
                amount_due_minor: 700,
                currency: "USD",
                next_attempt_at: "2026-11-13T00:00:00Z",
              },
            ],
          },
        },
        calls,
      ),
      { days: 3 },
    )) as { data: Array<Record<string, unknown>>; total_due: unknown; until: string };
    const q = new URLSearchParams(calls[0]!.split("?")[1]);
    expect(q.get("status[in]")).toBe("payment_due,not_paid");
    expect(q.get("next_attempt_at[on_or_before]")).toBe(out.until);
    expect(out.data.map((r) => r.id)).toEqual(["inv_2", "inv_1"]);
    expect(out.data[0]).not.toHaveProperty("lines");
    expect(out.total_due).toEqual([{ currency: "USD", count: 2, amount_minor: 1200 }]);
  });

  it("fails without invoices:view", async () => {
    await expect(tool("get_collections_queue").run(fakeCtx({}), {})).rejects.toThrow(
      /We could not read the collections queue/,
    );
  });
});

describe("an edited card keeps its line order", () => {
  it("follows the previous card by key, then label; new lines last", () => {
    const prev = [
      { label: "ID", value: "SPRING25", key: "code" },
      { label: "Name", value: "Spring", key: "name" },
      { label: "Percentage", value: "25%", key: "percent_off_bps" },
      { label: "Duration", value: "Forever" },
    ];
    const next = [
      { label: "Duration", value: "Forever" },
      { label: "Percentage", value: "40%", key: "percent_off_bps" },
      { label: "Applies to", value: "All" },
      { label: "ID", value: "SPRING25", key: "code" },
      { label: "Name", value: "Spring", key: "name" },
    ];
    expect(inPreviousOrder(prev, next).map((l) => l.label)).toEqual([
      "ID",
      "Name",
      "Percentage",
      "Duration",
      "Applies to",
    ]);
  });
});

describe("the member's own figures", () => {
  it("count as evidence when the question is cited", async () => {
    const { checkFigures } = await import("@/modules/assistant/figures");
    const answer = "You asked for $170; the two PayPal renewals come to $146.00.";
    const tools = [{ totals: [{ amount_minor: 14600 }] }];
    expect(checkFigures(answer, tools).unverified).toEqual(["170"]);
    expect(
      checkFigures(answer, [...tools, { member_question: "I need $170 from PayPal customers" }])
        .unverified,
    ).toEqual([]);
  });
});
