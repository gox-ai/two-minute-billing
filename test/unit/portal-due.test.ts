import { describe, expect, it } from "vitest";
import { summarizeDue, summarizeInFlight, type DueInvoice } from "../../dashboard/lib/portal-due";

const inv = (status: string, due: number): DueInvoice => ({
  status,
  currency: "USD",
  amount_due_minor: due,
  due_date: null,
});

describe("portal amount due", () => {
  it("does not count a pending (held) invoice as owed", () => {
    expect(summarizeDue([inv("pending", 1000)])).toEqual([]);
    expect(summarizeDue([inv("pending", 1000), inv("payment_due", 500)])).toEqual([
      { currency: "USD", minor: 500, count: 1, earliest: null, overdue: false },
    ]);
  });

  it("counts a scheduled debit as being collected, not owed", () => {
    const scheduled = {
      ...inv("payment_due", 700),
      collection_scheduled_at: "2026-11-20T10:00:00Z",
    };
    expect(summarizeDue([scheduled])).toEqual([]);
    expect(summarizeInFlight([scheduled])).toEqual([
      { currency: "USD", minor: 700, count: 1, earliest: null, overdue: false },
    ]);
  });
});
