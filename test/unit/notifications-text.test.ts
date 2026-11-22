import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS } from "@/modules/notifications/catalogue";
import {
  countText,
  renderItems,
  renderList,
  renderNotification,
  shortMoney,
  type Facts,
} from "@/modules/notifications/text";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-16T03:30:00Z");
const facts: Facts = {
  amountMinor: 499900,
  currency: "INR",
  customerName: "Meera Iyer",
  customerEmail: "meera@example.com",
  planName: "Studio Pro",
  billingCycle: "monthly",
  invoiceNumber: "2026-1184",
  reason: "Card declined",
  dueAt: "2026-11-19T18:29:00Z",
  nextRetryAt: "2026-11-18T04:00:00Z",
  gatewayName: "Stripe US",
  endpointUrl: "https://hooks.example.com/billing",
  failedCount: 3,
  outcome: "won",
  businessName: "Lumenfold Studio",
  businessPublicId: "biz_XXXXXXXXXXXX01",
  record: { type: "transaction", id: "txn_XXXXXXXXXXXX01" },
  url: "/businesses/biz_XXXXXXXXXXXX01/transactions/txn_XXXXXXXXXXXX01",
  occurredAt: "2026-11-16T03:06:00Z",
};
const opts = { timezone: TZ, now: NOW, baseUrl: "https://billing.example.com" };

describe("renderNotification", () => {
  it("payment failed reads as the design", () => {
    const r = renderNotification("payment_failed", facts, opts);
    expect(r.title).toBe("Payment failed: ₹4,999");
    expect(r.body).toBe("Meera Iyer · Studio Pro, monthly. Card declined. We try again on 18 Nov.");
    expect(r.push).toMatchObject({ title: r.title, body: r.body, url: facts.url });
    expect(r.email.subject).toBe(r.title);
    expect(r.email.html).toContain(
      "You get this email because &quot;Payment failed&quot; is set to Instant in your notifications.",
    );
    expect(r.email.html).toContain("https://billing.example.com/account/notifications");
    expect(r.email.text).toContain("View payment: https://billing.example.com/businesses/");
  });

  it("chat card: facts in two columns, no rows that repeat the header", () => {
    type Fact = { decoratedText: { topLabel: string; text: string } };
    type Col = { horizontalSizeStyle: string; widgets: Fact[] };
    const card = (f: Facts, hideNames = false) => {
      const c = renderNotification("payment_failed", f, { ...opts, hideNames }).chat.cardsV2[0] as {
        card: {
          header: { title: string; subtitle: string };
          sections: Array<{ widgets: unknown[] }>;
        };
      };
      const w = c.card.sections[0]!.widgets as Array<{
        columns?: { columnItems: Col[] };
        buttonList?: unknown;
      }>;
      const cols = w[0]!.columns!.columnItems;
      return {
        c,
        w,
        cols,
        labels: cols.map((col) => col.widgets.map((x) => x.decoratedText.topLabel)),
      };
    };
    const lean = {
      ...facts,
      nextRetryAt: undefined,
      dueAt: undefined,
      gatewayName: undefined,
      endpointUrl: undefined,
    };
    const { c, w, cols, labels } = card(lean);
    expect(c.card.header).toEqual({
      title: "Payment failed: ₹4,999",
      subtitle: "Lumenfold Studio · 08:36",
    });
    expect(cols).toHaveLength(2);
    expect(cols[0]!.horizontalSizeStyle).toBe("FILL_AVAILABLE_SPACE");
    expect(labels).toEqual([
      ["Customer", "Invoice"],
      ["Plan", "Reason"],
    ]);
    expect(w[1]!.buttonList).toBeDefined();
    expect(card(lean, true).labels.flat()).not.toContain("Customer");
    // Cents stay in the title, so no Amount row is needed.
    expect(card({ ...lean, amountMinor: 499950 }).c.card.header.title).toBe(
      "Payment failed: ₹4,999.50",
    );
  });

  it("dispute titles and evidence countdown", () => {
    const d = {
      ...facts,
      amountMinor: 1249900,
      customerName: "Tobias Lindqvist",
      reason: "Product not received",
      record: { type: "dispute", id: "dsp_XXXXXXXXXXXX01" },
    };
    expect(renderNotification("dispute_opened", d, opts).title).toBe("Dispute opened: ₹12,499");
    expect(renderNotification("dispute_opened", d, opts).body).toBe(
      "Tobias Lindqvist · Studio Pro, monthly. Reason: product not received. Evidence due 19 Nov.",
    );
    // The clock fires 72 hours ahead, inside the hour.
    const due = { ...opts, now: new Date("2026-11-16T19:00:00Z") };
    expect(renderNotification("dispute_evidence_due", d, due).title).toBe("Evidence due in 3 days");
    expect(
      renderNotification("dispute_evidence_due", d, {
        ...opts,
        now: new Date("2026-11-18T19:00:00Z"),
      }).title,
    ).toBe("Evidence due in 1 day");
    expect(renderNotification("dispute_evidence_due", d, due).body).toBe(
      "₹12,499 dispute from Tobias Lindqvist. Send evidence before 19 Nov.",
    );
    expect(renderNotification("dispute_closed", d, opts).title).toBe("Dispute won: ₹12,499");
  });

  it("names the business when the member has more than one", () => {
    const r = renderNotification("payment_failed", facts, { ...opts, showBusiness: true });
    expect(r.body.startsWith("Meera Iyer · Studio Pro, monthly · Lumenfold Studio.")).toBe(true);
  });

  it("a burst's bell row counts the first one", () => {
    const r = renderNotification("payment_failed", facts, {
      ...opts,
      grouped: {
        count: 12,
        totals: { INR: 5842000 },
        from: "2026-11-16T03:01:00Z",
        to: "2026-11-16T03:06:00Z",
      },
    });
    expect(r.title).toBe("12 payments failed");
    expect(r.body).toBe(
      "₹58,420 in total, from 08:31 to 08:36. The first was ₹4,999 from Meera Iyer.",
    );
    expect(r.url).toBe("/businesses/biz_XXXXXXXXXXXX01/transactions");
    expect(countText("dispute_opened", 1)).toBe("1 dispute opened");
    expect(countText("dispute_opened", 3)).toBe("3 disputes opened");
  });

  it("hides customer names and email addresses", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const r = renderNotification(kind, facts, { ...opts, hideNames: true });
      const all = [
        r.title,
        r.body,
        r.push.body,
        r.email.html,
        r.email.text,
        JSON.stringify(r.chat),
      ].join("\n");
      expect(all, kind).not.toContain("Meera");
      expect(all, kind).not.toContain("meera@example.com");
    }
    expect(
      renderNotification("spend_limit_reached", facts, { ...opts, hideNames: true }).body,
    ).toBe("A customer reached the ₹4,999 spending limit. Card declined.");
  });

  it("every kind has a title, a body and no raw dates or keys", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const r = renderNotification(kind, facts, opts);
      expect(r.title.length, kind).toBeGreaterThan(0);
      expect(r.title.length, kind).toBeLessThanOrEqual(40);
      expect(r.body, kind).toMatch(/\.$/);
      const text = [r.title, r.body, r.push.body, r.email.text].join("\n");
      expect(text, kind).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(text, kind).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(text, kind).not.toMatch(/undefined|null|NaN/);
      expect(r.chat.cardsV2).toHaveLength(1);
    }
  });

  it("titles carry the amount where the design shows one", () => {
    const t = (k: (typeof NOTIFICATION_KINDS)[number]) => renderNotification(k, facts, opts).title;
    expect(t("refund_failed")).toBe("Refund failed: ₹4,999");
    expect(t("retries_exhausted")).toBe("All payment retries failed: ₹4,999");
    expect(t("new_revenue")).toBe("New revenue: ₹4,999");
    expect(t("webhook_failing")).toBe("Webhook endpoint failing");
    expect(renderNotification("webhook_failing", facts, opts).body).toBe(
      "3 deliveries to hooks.example.com failed after all retries.",
    );
    expect(renderNotification("retries_exhausted", facts, opts).body).toBe(
      "Invoice 2026-1184 from Meera Iyer is now unpaid. We do not try again.",
    );
  });

  it("an outside address gets the destination footer and no settings link", () => {
    const r = renderNotification("payment_failed", facts, { ...opts, audience: "destination" });
    expect(r.email.html).not.toContain("/account/notifications");
    expect(r.email.text).toContain("added this address");
  });
});

const NAMES = [
  "Ravi Shah",
  "Lena Ortiz",
  "Kai Moreno",
  "Ines Duarte",
  "Omar Haddad",
  "Yuki Sato",
  "Nora Vik",
];
const overdue = (i: number): Facts => ({
  amountMinor: 10_000 * (i + 1),
  currency: "USD",
  customerName: NAMES[i]!,
  customerEmail: `buyer${i}@example.com`,
  invoiceNumber: `2026-12${i}`,
  dueAt: "2026-11-15T10:00:00Z",
  businessName: "Lumenfold Studio",
  businessPublicId: "biz_XXXXXXXXXXXX01",
  record: { type: "invoice", id: `inv_XXXXXXXXXXX0${i}` },
  url: `/businesses/biz_XXXXXXXXXXXX01/invoices/inv_XXXXXXXXXXX0${i}`,
});
const extras = (n: number) => Array.from({ length: n }, (_, i) => overdue(i));
const totalOf = (list: Facts[]) => ({ USD: list.reduce((s, f) => s + f.amountMinor!, 0) });
const allText = (r: ReturnType<typeof renderList>) =>
  [
    r.title,
    r.body,
    r.push.title,
    r.push.body,
    r.email.html,
    r.email.text,
    JSON.stringify(r.chat),
  ].join("\n");

describe("lists", () => {
  it("one later event reads as a normal notification", () => {
    const one = extras(1);
    const r = renderItems("invoice_overdue", one, opts, {
      count: 1,
      totals: totalOf(one),
      more: true,
    });
    expect(r).toEqual(renderNotification("invoice_overdue", one[0]!, opts));
    expect(r.title).toBe("Invoice overdue: $100");
    expect(r.email.text).toContain("Customer: Ravi Shah");
  });

  it("three later events: a list with their own total and no summary rows", () => {
    const three = extras(3);
    const r = renderList("invoice_overdue", three, opts, {
      count: 3,
      totals: totalOf(three),
      more: true,
    });
    expect(r.title).toBe("3 more invoices overdue · $600");
    expect(r.email.subject).toBe(r.title);
    expect(r.push.body).toBe(
      "Invoice 2026-120 · $100 · Ravi Shah\nInvoice 2026-121 · $200 · Lena Ortiz\nand 1 more",
    );
    expect(r.email.text).toContain(
      "- Invoice 2026-120 · $100 · Ravi Shah\n- Invoice 2026-121 · $200 · Lena Ortiz\n- Invoice 2026-122 · $300 · Kai Moreno",
    );
    expect(r.url).toBe("/businesses/biz_XXXXXXXXXXXX01/invoices");
    const text = allText(r);
    for (const label of ["Count", "Total", "First"])
      expect(text).not.toMatch(new RegExp(`\\b${label}\\b`));
    expect(JSON.stringify(r.chat)).toContain("View invoices");
    expect(JSON.stringify(r.chat)).toContain("/invoices/inv_XXXXXXXXXXX02");
  });

  it("seven later events: five rows, then the rest as a count", () => {
    const seven = extras(7);
    const r = renderList("invoice_overdue", seven, opts, {
      count: 7,
      totals: totalOf(seven),
      more: true,
    });
    expect(r.title).toBe("7 more invoices overdue · $2,800");
    expect(r.email.text).toContain("- Invoice 2026-124 · $500 · Omar Haddad\nand 2 more");
    expect(r.email.text).not.toContain("Yuki Sato");
    expect(r.push.body.split("\n")).toEqual([
      "Invoice 2026-120 · $100 · Ravi Shah",
      "Invoice 2026-121 · $200 · Lena Ortiz",
      "and 5 more",
    ]);
    const chat = JSON.stringify(r.chat);
    expect(chat).toContain("and 2 more");
    expect(chat).not.toContain("Yuki Sato");
    // A group keeps 20 items; the count stays exact beyond that.
    const many = renderList("invoice_overdue", seven, opts, {
      count: 40,
      totals: { USD: 1 },
      more: true,
    });
    expect(many.email.text).toContain("and 35 more");
  });

  it("hides customer names and email addresses in list rows", () => {
    const r = renderList(
      "invoice_overdue",
      extras(3),
      { ...opts, hideNames: true },
      {
        count: 3,
        totals: totalOf(extras(3)),
      },
    );
    const text = allText(r);
    for (const name of NAMES.slice(0, 3)) expect(text).not.toContain(name);
    expect(text).not.toContain("@example.com");
    expect(r.push.body.split("\n")[0]).toBe("Invoice 2026-120 · $100");
  });

  it("a clock run: one item is a full card, three are one list with the total of all", () => {
    const one = renderItems("invoice_overdue", extras(1), opts, {
      count: 1,
      totals: totalOf(extras(1)),
    });
    expect(one.title).toBe("Invoice overdue: $100");
    const three = renderItems("invoice_overdue", extras(3), opts, {
      count: 3,
      totals: totalOf(extras(3)),
    });
    expect(three.title).toBe("3 invoices overdue · $600");
    expect(three.body).toBe(
      "$600 in total. Invoice 2026-120 · $100 · Ravi Shah. Invoice 2026-121 · $200 · Lena Ortiz. Invoice 2026-122 · $300 · Kai Moreno.",
    );
    const hooks = renderList(
      "webhook_failing",
      [
        { endpointUrl: "https://hooks.example.com/a", failedCount: 3 },
        { endpointUrl: "https://ops.example.com/b", failedCount: 1 },
      ],
      opts,
      { count: 2, totals: {} },
    );
    expect(hooks.title).toBe("2 webhook endpoints failing");
    expect(hooks.push.body).toBe(
      "hooks.example.com: 3 deliveries failed\nops.example.com: 1 delivery failed",
    );
  });
});

describe("shortMoney", () => {
  it("drops .00 on whole amounts only, with the currency's own exponent", () => {
    expect(shortMoney(499900, "INR")).toBe("₹4,999");
    expect(shortMoney(24950, "USD")).toBe("$249.50");
    expect(shortMoney(1000, "JPY")).toBe("¥1,000");
    expect(shortMoney(1500, "KWD")).toBe("KWD\u00A01.500");
  });
});
