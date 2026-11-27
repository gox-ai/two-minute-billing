import { describe, expect, it } from "vitest";
import { parseCsv } from "@/modules/bulk-import/csv-parse";
import { autoMap, missingRequired, templateCsv } from "@/modules/bulk-import/templates";
import { parseDate, parseMoney, parseRow } from "@/modules/bulk-import/parse";
import { analyze, type CheckContext, type RawRow, type RunFile } from "@/modules/bulk-import/check";

const NOW = new Date("2026-11-26T12:00:00Z");
const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  tz: "America/New_York",
  now: NOW,
  existing: {
    prices: new Map(),
    products: new Set(),
    coupons: new Set(),
    customers: new Map(),
    subscriptions: new Set(),
  },
  connectedGateways: new Set(["stripe"]),
  testUsage: null,
  ...over,
});

function files(spec: Record<string, string[][]>): { files: RunFile[]; rows: RawRow[] } {
  const out: RunFile[] = [];
  const rows: RawRow[] = [];
  for (const [entity, table] of Object.entries(spec)) {
    const [headers, ...data] = table as [string[], ...string[][]];
    out.push({
      entity: entity as RunFile["entity"],
      filename: `${entity}.csv`,
      headers,
      mapping: autoMap(entity as RunFile["entity"], headers),
      rows: data.length,
    });
    data.forEach((cells, i) =>
      rows.push({
        id: `${entity}-${i + 1}`,
        entity: entity as RunFile["entity"],
        rowNumber: i + 1,
        raw: Object.fromEntries(headers.map((h, j) => [h, cells[j] ?? ""])),
      }),
    );
  }
  return { files: out, rows };
}

describe("csv reader", () => {
  it("reads quotes, embedded line breaks, CRLF and a BOM", () => {
    const p = parseCsv('﻿id,name\r\n1,"Lee, ""Jo""\nline two"\r\n2,x\r\n');
    expect(p.headers).toEqual(["id", "name"]);
    expect(p.rows).toEqual([
      ["1", 'Lee, "Jo"\nline two'],
      ["2", "x"],
    ]);
  });
  it("detects a semicolon separator and pads short rows", () => {
    expect(parseCsv("a;b;c\n1;2\n").rows).toEqual([["1", "2", ""]]);
  });
  it("refuses an unclosed quote with its line", () => {
    expect(() => parseCsv('a\n"open\n')).toThrow(/line 2/);
  });
});

describe("column mapping", () => {
  it("maps prefixed, spaced and (UTC) headers; each field once", () => {
    expect(
      autoMap("subscriptions", [
        "subscriptions.id",
        "Customer ID",
        "Current Period End (UTC)",
        "id",
      ]),
    ).toEqual({
      "subscriptions.id": "subscription_id",
      "Customer ID": "customer_id",
      "Current Period End (UTC)": "current_term_end",
      id: null,
    });
  });
  it("lists required fields with no column", () => {
    expect(missingRequired("customers", { email: "email" })).toEqual(["customer_id"]);
  });
  it("templates start with the required id column", () => {
    expect(templateCsv("plans").startsWith('"price_id"')).toBe(true);
  });
});

describe("cell parsing", () => {
  it("amounts: thousands separators and symbols; no extra decimals; zero-decimal currencies", () => {
    expect(parseMoney("$1,234.50", "USD")).toBe(123450);
    expect(parseMoney("12.345", "USD")).toBeNull();
    expect(parseMoney("500", "JPY")).toBe(500);
    expect(parseMoney("5.5", "JPY")).toBeNull();
  });
  it("a date alone is midnight in the business's time zone; a naive date-time is UTC", () => {
    expect(parseDate("2026-12-15", "America/New_York")?.toISOString()).toBe(
      "2026-12-15T05:00:00.000Z",
    );
    expect(parseDate("2026-12-15 10:30:00", "America/New_York")?.toISOString()).toBe(
      "2026-12-15T10:30:00.000Z",
    );
    expect(parseDate("2026-02-30", null)).toBeNull();
  });
  it("a subscription amount uses its price's currency when the row has none", () => {
    const r = parseRow(
      "subscriptions",
      { sub: "s", cus: "c", price: "p", end: "2027-01-01", up: "9.99" },
      {
        sub: "subscription_id",
        cus: "customer_id",
        price: "price_id",
        end: "current_term_end",
        up: "unit_price",
      },
      null,
      "USD",
    );
    expect(r.errors).toEqual([]);
    expect(r.values.unit_price).toBe(999);
  });
  it("a saved card needs all three references", () => {
    const r = parseRow(
      "customers",
      { id: "c1", pm: "pm_X" },
      { id: "customer_id", pm: "gateway_payment_method_id" },
      null,
    );
    expect(r.errors.map((e) => e.field)).toEqual(["payment_gateway"]);
  });
});

describe("analyze", () => {
  const base = {
    plans: [
      ["price_id", "name", "amount", "currency", "interval"],
      ["pro-m", "Pro", "50.00", "USD", "month"],
      ["pro-y", "Pro", "600.00", "USD", "year"],
    ],
    customers: [
      [
        "customer_id",
        "email",
        "payment_gateway",
        "gateway_customer_id",
        "gateway_payment_method_id",
      ],
      ["c1", "a@example.com", "stripe", "cus_X1", "pm_X1"],
      ["c2", "b@example.com", "razorpay", "cust_X2", "token_X2"],
      ["c3", "c@example.com", "", "", ""],
    ],
    subscriptions: [
      ["subscription_id", "customer_id", "price_id", "quantity", "current_term_end"],
      ["s1", "c1", "pro-m", "2", "2026-12-20"],
      ["s2", "c2", "pro-y", "1", "2027-03-01"],
      ["s3", "c3", "pro-m", "1", "2026-12-01"],
    ],
  };

  it("summarises MRR, card coverage and renewals", () => {
    const { files: f, rows } = files(base);
    const { summary } = analyze(f, rows, {}, ctx());
    expect(summary.ready).toBe(true);
    expect(summary.subscriptions.new).toBe(3);
    // flat ignores quantity: 50 + 600/12 + 50 = 150.00
    expect(summary.mrr).toEqual([{ currency: "USD", amount_minor: 15000 }]);
    expect(summary.payment).toMatchObject({
      with_card_connected: 1,
      with_card_not_connected: 1,
      without_card: 1,
      gateways_not_connected: ["razorpay"],
    });
    expect(summary.warnings.map((w) => w.code).sort()).toEqual([
      "gateway_not_connected",
      "no_card",
    ]);
  });

  it("a bad customer leaves out its subscription, and blocks unless invalid rows are skipped", () => {
    const spec = structuredClone(base);
    spec.customers[1]![1] = "not-an-email";
    const { files: f, rows } = files(spec);
    const blocked = analyze(f, rows, {}, ctx());
    expect(blocked.summary.blockers.map((b) => b.code)).toEqual(["invalid_rows"]);
    expect(blocked.rows.find((r) => r.id === "subscriptions-1")?.state).toBe("excluded");
    const skipped = analyze(f, rows, { skip_invalid_rows: true }, ctx());
    expect(skipped.summary.ready).toBe(true);
    expect(skipped.summary.subscriptions.new).toBe(2);
  });

  it("rows of one subscription must agree; a past renewal is an error", () => {
    const spec = structuredClone(base);
    spec.subscriptions.push(["s1", "c2", "pro-y", "1", "2026-12-20"]);
    spec.subscriptions[3]![4] = "2026-11-01";
    const { files: f, rows } = files(spec);
    const out = analyze(f, rows, {}, ctx());
    const bad = out.rows.find((r) => r.id === "subscriptions-4")!;
    expect(bad.errors.map((e) => e.field)).toContain("customer_id");
    expect(out.rows.find((r) => r.id === "subscriptions-3")?.errors[0]?.message).toMatch(
      /in the past/,
    );
  });

  it("ids in the business already are 'existing'; references to them resolve", () => {
    const { files: f, rows } = files({ subscriptions: base.subscriptions.slice(0, 2) });
    const out = analyze(
      f,
      rows,
      {},
      ctx({
        existing: {
          prices: new Map([
            [
              "pro-m",
              {
                currency: "USD",
                model: "flat",
                amountMinor: 5000,
                interval: "month",
                intervalCount: 1,
                kind: "plan",
              },
            ],
          ]),
          products: new Set(),
          coupons: new Set(),
          customers: new Map([["c1", true]]),
          subscriptions: new Set(),
        },
      }),
    );
    expect(out.summary.ready).toBe(true);
    expect(out.summary.payment.with_card_connected).toBe(1);
  });

  it("test-business limits block before the run", () => {
    const { files: f, rows } = files(base);
    const out = analyze(
      f,
      rows,
      {},
      ctx({
        testUsage: {
          customers: { used: 999, limit: 1000 },
          subscriptions: { used: 0, limit: 1000 },
        },
      }),
    );
    expect(out.summary.blockers.map((b) => b.code)).toEqual(["test_limit_customers"]);
  });
});

describe("analyze: history", () => {
  const customers = [
    ["customer_id", "email"],
    ["c1", "a@example.com"],
  ];
  const invoices = [
    [
      "invoice_id",
      "customer_id",
      "status",
      "currency",
      "date",
      "total",
      "tax",
      "line_description",
      "line_amount",
    ],
    ["i1", "c1", "paid", "USD", "2026-10-01", "55.00", "5.00", "Pro", "30.00"],
    ["i1", "c1", "paid", "USD", "2026-10-01", "55.00", "", "Seats", "20.00"],
    ["i2", "c1", "open", "USD", "2026-11-01", "50.00", "", "Pro", "50.00"],
  ];

  it("an invoice's lines, discount and tax make its total; open invoices open receivables", () => {
    const { files: f, rows } = files({ customers, invoices });
    const out = analyze(f, rows, {}, ctx({ invoiceNextNumber: 1 }));
    expect(out.summary.blockers).toEqual([]);
    expect(out.summary.history).toMatchObject({
      invoices: 2,
      open_invoices: 1,
      receivables: [{ currency: "USD", amount_minor: 5000 }],
      next_invoice_number: 3,
    });
    expect(out.summary.warnings.map((w) => w.code).sort()).toEqual([
      "invoice_numbering",
      "open_invoices_not_collected",
    ]);
    const on = analyze(f, rows, { collect_open_invoices: true }, ctx());
    expect(on.summary.warnings.map((w) => w.code)).toContain("open_invoices_collected");
  });

  it("a total that does not add up blocks the whole invoice", () => {
    const spec = structuredClone({ customers, invoices });
    spec.invoices[1]![5] = "60.00";
    spec.invoices[2]![5] = "60.00";
    const { files: f, rows } = files(spec);
    const out = analyze(f, rows, {}, ctx());
    expect(out.rows.find((r) => r.id === "invoices-1")?.errors[0]?.message).toMatch(/make 55\.00/);
    expect(out.rows.find((r) => r.id === "invoices-2")?.state).toBe("excluded");
  });

  it("payments and credit notes need their invoice; a refund needs its payment in the file", () => {
    const { files: f, rows } = files({
      customers,
      invoices,
      payments: [
        [
          "transaction_id",
          "type",
          "customer_id",
          "invoice_id",
          "amount",
          "currency",
          "date",
          "refunded_transaction_id",
        ],
        ["p1", "payment", "c1", "i1", "55.00", "USD", "2026-10-02", ""],
        ["p2", "payment", "c1", "nope", "5.00", "USD", "2026-10-02", ""],
        ["r1", "refund", "c1", "", "5.00", "USD", "2026-10-03", "p9"],
      ],
      credit_notes: [
        ["credit_note_id", "invoice_id", "currency", "date", "total", "amount_available"],
        ["cn1", "i1", "USD", "2026-10-05", "10.00", "10.00"],
      ],
    });
    const out = analyze(f, rows, { skip_invalid_rows: true }, ctx());
    const state = (id: string) => out.rows.find((r) => r.id === id)?.state;
    expect(state("payments-1")).toBe("new");
    expect(state("payments-2")).toBe("invalid");
    expect(state("payments-3")).toBe("invalid");
    expect(out.summary.history?.credit).toEqual([{ currency: "USD", amount_minor: 1000 }]);
  });

  it("usage needs a usage price that is on the subscription", () => {
    const { files: f, rows } = files({
      usage: [
        ["usage_id", "subscription_id", "price_id", "quantity", "timestamp"],
        ["u1", "s1", "api", "10", "2026-11-20T10:00:00Z"],
        ["u2", "s1", "pro-m", "10", "2026-11-20T10:00:00Z"],
      ],
    });
    const usagePrice = {
      currency: "USD",
      model: "usage",
      amountMinor: null as number | null,
      interval: "month",
      intervalCount: 1,
      kind: "plan" as const,
    };
    const out = analyze(
      f,
      rows,
      {},
      ctx({
        existing: {
          prices: new Map([
            ["api", usagePrice],
            ["pro-m", { ...usagePrice, model: "flat", amountMinor: 5000 }],
          ]),
          products: new Set(),
          coupons: new Set(),
          customers: new Map(),
          subscriptions: new Set(["s1"]),
          subscriptionPrices: new Map([["s1", new Set(["api"])]]),
        },
      }),
    );
    expect(out.rows.find((r) => r.id === "usage-1")?.state).toBe("new");
    expect(out.rows.find((r) => r.id === "usage-2")?.errors[0]?.message).toMatch(/usage price/);
  });
});
