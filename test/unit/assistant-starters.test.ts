import { describe, expect, it } from "vitest";
import { STARTERS, startersFor } from "../../dashboard/lib/assistant";
import {
  groupKeyText,
  metricLabel,
  openDisputesText,
  paymentSplitText,
  paysWithText,
  priceText,
  timelineText,
} from "../../dashboard/components/assistant/tool-data-helpers";

describe("startersFor", () => {
  it("tunes the invoice list to its state", () => {
    expect(startersFor("invoice", "unpaid")[0]).toBe("Why is this invoice unpaid?");
    expect(startersFor("invoice", "in_dunning")[1]).toBe("What will dunning do next?");
    expect(startersFor("invoice", "paid")[1]).toBe("Was any of it refunded?");
  });
  it("puts the failed payment first for a customer with unpaid invoices", () => {
    expect(startersFor("customer", "unpaid")[0]).toBe("Why did their last payment fail?");
  });
  it("tunes a cancelled subscription", () => {
    expect(startersFor("subscription", "cancelled")[0]).toBe("Why did this subscription end?");
  });
  it("falls back to the default lists", () => {
    expect(startersFor("invoice")).toEqual(STARTERS.invoice);
    expect(startersFor("subscription", "active")).toEqual(STARTERS.subscription);
    expect(startersFor("nope")).toEqual(STARTERS.default);
  });
});

describe("card text helpers", () => {
  it("writes the payment method", () => {
    expect(paysWithText({ type: "card", status: "valid" })).toBe("Pays with card");
    expect(paysWithText({ type: "card", status: "expired" })).toBe("Pays with card (invalid)");
    expect(paysWithText(null)).toBeNull();
  });
  it("writes timeline rows", () => {
    expect(timelineText({ summary: " Invoice sent " })).toBe("Invoice sent");
    expect(timelineText({ type: "invoice.paid" })).toBe("Invoice paid");
    expect(timelineText({})).toBe("Event");
  });
  it("writes the dispute, split and price lines", () => {
    expect(openDisputesText(1)).toBe("1 open dispute");
    expect(openDisputesText(2)).toBe("2 open disputes");
    expect(paymentSplitText({ card: 12, paypal: 3, none: 0 })).toBe("Card 12 · PayPal 3");
    expect(
      paymentSplitText(
        { card: { count: 1, amount_minor: 1500 }, paypal: { count: 2, amount_minor: 17000 } },
        (m) => `$${(m / 100).toFixed(2)}`,
      ),
    ).toBe("Card 1 $15.00 · PayPal 2 $170.00");
    expect(priceText("Pro", "$10.00", "month")).toBe("Pro · $10.00 / month");
    expect(priceText("Setup", "$5.00", null)).toBe("Setup · $5.00");
    expect(metricLabel("sum_recurring_amount_minor")).toBe("Recurring amount (sum)");
    expect(metricLabel("count_distinct_customer")).toBe("Customer (distinct)");
    expect(metricLabel("count")).toBe("Count");
    expect(groupKeyText({ currency: "USD", "payer.pays_with.type": null })).toBe("USD · —");
  });
});
