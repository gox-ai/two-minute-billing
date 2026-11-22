import { describe, expect, it } from "vitest";
import { changeSummary, fieldLabel } from "../../dashboard/components/audit/labels";

const KOLKATA = "Asia/Kolkata";

describe("changeSummary", () => {
  it("renders a renewal's term dates in the business timezone", () => {
    // 18:30Z is the next day in Kolkata.
    const s = changeSummary(
      // jsonb order: end before start.
      {
        updated_at: "2026-11-13T18:30:00.000Z",
        resource_version: 4,
        current_period_end: "2026-11-13T18:30:00.000Z",
        current_period_start: "2026-10-13T18:30:00.000Z",
      },
      {
        updated_at: "2026-11-13T18:30:05.000Z",
        resource_version: 5,
        current_period_end: "2026-12-13T18:30:00.000Z",
        current_period_start: "2026-11-13T18:30:00.000Z",
      },
      KOLKATA,
    );
    expect(s).toEqual({
      lines: [
        { field: "Current term start", from: "14 Oct 2026", to: "14 Nov 2026" },
        { field: "Current term end", from: "14 Nov 2026", to: "14 Dec 2026" },
      ],
      more: 0,
    });
  });

  it("adds the time when both dates fall on the same day", () => {
    const s = changeSummary(
      { trial_end: "2026-11-14T04:00:00.000Z" },
      { trial_end: "2026-11-14T10:00:00.000Z" },
      "UTC",
    );
    expect(s.lines).toEqual([
      { field: "Trial end", from: "14 Nov 2026, 04:00", to: "14 Nov 2026, 10:00" },
    ]);
  });

  it("reads a status as words", () => {
    const s = changeSummary({ status: "payment_due" }, { status: "paid" }, null);
    expect(s.lines).toEqual([{ field: "Status", from: "payment due", to: "paid" }]);
  });

  it("keeps an id as it is", () => {
    const s = changeSummary({ price_id: "price_monthly_a" }, { price_id: "price_yearly_a" }, null);
    expect(s.lines[0]).toEqual({
      field: "Price ID",
      from: "price_monthly_a",
      to: "price_yearly_a",
    });
  });

  it("reads a boolean as on or off", () => {
    const s = changeSummary({ auto_collection: true }, { auto_collection: false }, null);
    expect(s.lines).toEqual([{ field: "Auto collection", from: "on", to: "off" }]);
  });

  it("formats money when its side carries the currency", () => {
    const s = changeSummary(
      { amount_due_minor: "4900", currency: "USD" },
      { amount_due_minor: "9900", currency: "EUR" },
      null,
    );
    expect(s.lines[0]).toEqual({ field: "Amount due", from: "$49.00", to: "€99.00" });
  });

  it("leaves money without a currency out, but counts it", () => {
    const s = changeSummary(
      { amountDueMinor: 4900, status: "draft" },
      { amountDueMinor: 9900, status: "posted" },
      null,
    );
    expect(s.lines).toEqual([{ field: "Status", from: "draft", to: "posted" }]);
    expect(s.more).toBe(1);
    expect(JSON.stringify(s)).not.toContain("4900");
  });

  it("treats MRR as money", () => {
    const bare = changeSummary({ mrr: "21100" }, { mrr: "22300" }, null);
    expect(bare).toEqual({ lines: [], more: 1 });
    const priced = changeSummary(
      { mrr: "21100", currency: "INR" },
      { mrr: "22300", currency: "INR" },
      null,
    );
    expect(priced.lines).toEqual([{ field: "MRR", from: "₹211.00", to: "₹223.00" }]);
  });

  it("names a structure without its contents", () => {
    const s = changeSummary(
      { items: [{ quantity: 1 }], billing_address: null },
      { items: [{ quantity: 2 }], billing_address: { city: "Pune" } },
      null,
    );
    expect(s.lines).toEqual([
      { field: "Items", changed: true },
      { field: "Billing address", changed: true },
    ]);
  });

  it("shows nothing for a creation", () => {
    expect(changeSummary({}, { status: "active" }, null)).toEqual({ lines: [], more: 0 });
    expect(changeSummary(null, { status: "active" }, null)).toEqual({ lines: [], more: 0 });
  });

  it("never shows or counts version and updated-at fields", () => {
    const s = changeSummary(
      { resource_version: 3, updated_at: "2026-11-01T00:00:00Z", po_number: "PO-1" },
      { resource_version: 4, updated_at: "2026-11-02T00:00:00Z", po_number: "PO-2" },
      null,
    );
    expect(s).toEqual({ lines: [{ field: "PO number", from: "PO-1", to: "PO-2" }], more: 0 });
  });

  it("caps the lines at two and counts the rest", () => {
    const s = changeSummary(
      { items: [], auto_collection: true, status: "active", po_number: null },
      { items: [{ quantity: 1 }], auto_collection: false, status: "paused", po_number: "PO-9" },
      null,
    );
    expect(s.lines).toHaveLength(2);
    expect(s.more).toBe(2);
  });

  it("marks a set value with no `from` and a cleared one with no `to`", () => {
    const set = changeSummary({ po_number: null }, { po_number: "PO-9" }, null);
    expect(set.lines).toEqual([{ field: "PO number", to: "PO-9" }]);
    const cleared = changeSummary({ po_number: "PO-9" }, { po_number: "" }, null);
    expect(cleared.lines).toEqual([{ field: "PO number", from: "PO-9" }]);
  });
});

describe("fieldLabel", () => {
  it("names the current period as the term", () => {
    expect(fieldLabel("current_period_end")).toBe("Current term end");
    expect(fieldLabel("currentPeriodStart")).toBe("Current term start");
  });
});
