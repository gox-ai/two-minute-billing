import { describe, expect, it } from "vitest";
import {
  PAYMENT_METHOD_STATUSES,
  canChargeMethod,
  topupCanCharge,
} from "../../dashboard/lib/payment-method-status";
import {
  declinedPaymentLine,
  parseHoursText,
  resolveTopupRetry,
  retryConsequence,
  retryHoursIssue,
  retryScheduleLine,
  topupMaxTries,
  topupRetryBody,
  topupRetryDraft,
  topupTriesFor,
} from "../../dashboard/lib/topup-retry";

describe("a payment method that we can charge", () => {
  // The API says "valid", never "active": the page once filtered on "active" and found none.
  it("valid and expiring charge; the others do not", () => {
    const yes = PAYMENT_METHOD_STATUSES.filter((s) => canChargeMethod(s));
    expect(yes).toEqual(["valid", "expiring"]);
    expect(canChargeMethod("active")).toBe(false);
  });
  it("an older response with no status counts as valid", () => {
    expect(canChargeMethod(undefined)).toBe(true);
    expect(canChargeMethod(null)).toBe(true);
  });
  // The engine's rule for a top-up: only an invalid method does not count, and a run falls
  // through to a backup.
  it("a top-up with its own method needs that method; else any method", () => {
    const methods = [
      { id: "pm_a", status: "invalid" },
      { id: "pm_b", status: "expired" },
    ];
    expect(topupCanCharge(null, methods)).toBe(true);
    expect(topupCanCharge("pm_b", methods)).toBe(true);
    expect(topupCanCharge("pm_a", methods)).toBe(false);
    expect(topupCanCharge(null, [{ id: "pm_a", status: "invalid" }])).toBe(false);
    expect(topupCanCharge(null, [])).toBe(false);
  });
});

describe("the retry schedule of a declined automatic top-up", () => {
  const unset = resolveTopupRetry(null);

  it("unset: on, with the default schedule", () => {
    expect(unset).toEqual({
      auto_topup_retries: true,
      auto_topup_retry_hours: [4, 12],
      auto_topup_retry_hours_by_method: {},
    });
    expect(topupMaxTries(unset)).toBe(3);
    expect(retryScheduleLine([4, 12])).toBe("3 tries: at once, after 4 hours, then 12 hours later");
    expect(declinedPaymentLine(unset)).toBe("We try again, 3 tries in total");
  });
  it("off, or a stored empty list: one try", () => {
    const off = resolveTopupRetry({ auto_topup_retries: false });
    expect(topupTriesFor(off, "card")).toBe(1);
    expect(resolveTopupRetry({ auto_topup_retry_hours: [] }).auto_topup_retries).toBe(false);
    expect(retryConsequence(false, [4, 12])).toEqual([
      "We try one time. A declined payment disables the automatic top-up at once.",
    ]);
    expect(declinedPaymentLine(off)).toBe("We disable the automatic top-up");
  });
  it("a kind of method with its own list has its own number of tries", () => {
    const c = resolveTopupRetry({ auto_topup_retry_hours_by_method: { card: [1] } });
    expect(topupTriesFor(c, "card")).toBe(2);
    expect(topupTriesFor(c, "bank_debit")).toBe(3);
    expect(topupMaxTries(c)).toBeNull();
    expect(declinedPaymentLine(c)).toBe("We try again");
  });
  it("the consequence states the tries and the last one", () => {
    expect(retryConsequence(true, [4, 12])[0]).toBe(
      "We try 3 times: at once, after 4 hours, then 12 hours later.",
    );
    expect(retryConsequence(true, [4, 12])[1]).toBe("The last try is 16 hours after the first.");
    expect(retryConsequence(true, [1])[0]).toBe("We try 2 times: at once, then after 1 hour.");
  });
  it("limits: whole hours of 1 or more, 4 delays, 72 hours in total", () => {
    expect(retryHoursIssue([4, 12])).toBeNull();
    expect(retryHoursIssue([24, 24, 24])).toBeNull();
    expect(retryHoursIssue([0])).toMatch(/whole number of hours, 1 or more/);
    expect(retryHoursIssue([1.5])).toMatch(/whole number of hours/);
    expect(retryHoursIssue([1, 1, 1, 1, 1])).toMatch(/4 delays or fewer/);
    expect(retryHoursIssue([48, 25])).toMatch(/72 hours or less. They add up to 73 hours\./);
    expect(retryHoursIssue([0], "for cards")).toMatch(/each delay for cards/);
  });
  it("a typed list: numbers only", () => {
    expect(parseHoursText("4, 12")).toEqual([4, 12]);
    expect(parseHoursText(" ")).toEqual([]);
    expect(parseHoursText("4, x")[1]).toBeNaN();
  });
});

describe("what the retry form sends", () => {
  const saved = resolveTopupRetry(null);
  const draft = topupRetryDraft(saved);

  it("nothing changed: no key is sent, so unset stays unset", () => {
    expect(topupRetryBody(draft, saved)).toEqual({ ok: true, value: {} });
  });
  it("switched off: only the switch; the schedule is kept", () => {
    expect(topupRetryBody({ ...draft, enabled: false, hours: ["9"] }, saved)).toEqual({
      ok: true,
      value: { auto_topup_retries: false },
    });
  });
  it("a new schedule and a list for cards", () => {
    expect(topupRetryBody({ ...draft, hours: ["1", "1", "2"], card: "2, 6" }, saved)).toEqual({
      ok: true,
      value: {
        auto_topup_retry_hours: [1, 1, 2],
        auto_topup_retry_hours_by_method: { card: [2, 6] },
      },
    });
  });
  it("a bad row is marked; a fault of the whole list marks every row", () => {
    const row = topupRetryBody({ ...draft, hours: ["4", "x"] }, saved);
    expect(row.ok).toBe(false);
    if (!row.ok) {
      expect(Object.keys(row.errors).sort()).toEqual([
        "auto_topup_retry_hours",
        "auto_topup_retry_hours_1",
      ]);
    }
    const total = topupRetryBody({ ...draft, hours: ["48", "25"] }, saved);
    if (!total.ok) {
      expect(Object.keys(total.errors).sort()).toEqual([
        "auto_topup_retry_hours",
        "auto_topup_retry_hours_0",
        "auto_topup_retry_hours_1",
      ]);
    }
    expect(total.ok).toBe(false);
  });
  it("a bad list for one kind names that kind", () => {
    const r = topupRetryBody({ ...draft, bank_debit: "0" }, saved);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.auto_topup_retry_hours_bank_debit).toMatch(/for bank debits/);
  });
});
