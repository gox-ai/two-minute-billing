import { describe, expect, it } from "vitest";
// Relative, not `@/…`: these live in the dashboard app and the root `@/` alias points at src/.
import {
  buyerInvoiceState,
  cardExpired,
  failureVerb,
  methodProblem,
  normalizeMethodWords,
} from "../../dashboard/app/(storefront)/portal/(session)/portal-state";

const card = (exp_month: number, exp_year: number, status = "valid") => ({
  type: "card",
  status,
  exp_month,
  exp_year,
});

describe("cardExpired", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  it("is good through the last day of its printed month", () => {
    expect(cardExpired(card(11, 2026), "UTC", now)).toBe(false);
    expect(cardExpired(card(10, 2026), "UTC", now)).toBe(true);
    expect(cardExpired(card(12, 2025), "UTC", now)).toBe(true);
  });
  it("reads the month in the business time zone", () => {
    // 1 Dec 03:00 UTC is still 30 Nov in New York.
    const edge = new Date("2026-12-01T03:00:00Z");
    expect(cardExpired(card(11, 2026), "America/New_York", edge)).toBe(false);
    expect(cardExpired(card(11, 2026), "UTC", edge)).toBe(true);
  });
  it("claims nothing without a printed date", () => {
    expect(cardExpired({ type: "paypal", status: "valid", exp_month: null, exp_year: null })).toBe(
      false,
    );
  });
});

describe("methodProblem", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  it("names the engine's verdict first, then the printed date", () => {
    expect(methodProblem(card(12, 2031, "invalid"), "UTC", now)).toBe("invalid");
    expect(methodProblem(card(10, 2026, "valid"), "UTC", now)).toBe("expired");
    expect(methodProblem(card(12, 2031, "expired"), "UTC", now)).toBe("expired");
    expect(methodProblem(card(12, 2031, "pending_verification"), "UTC", now)).toBe("pending");
    expect(methodProblem(card(12, 2031, "expiring"), "UTC", now)).toBeNull();
    expect(methodProblem(card(12, 2031), "UTC", now)).toBeNull();
  });
});

describe("buyerInvoiceState", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const inv = (status: string, due: number, date: string | null, inFlight = false) => ({
    status,
    amount_due_minor: due,
    due_date: date,
    payment_in_flight: inFlight,
  });
  it("uses buyer words, never raw engine statuses", () => {
    expect(buyerInvoiceState(inv("paid", 0, null), now).label).toBe("Paid");
    expect(buyerInvoiceState(inv("posted", 100, "2026-12-01T00:00:00Z"), now).label).toBe("Due");
    expect(buyerInvoiceState(inv("payment_due", 100, "2026-11-11T00:00:00Z"), now).label).toBe(
      "Overdue",
    );
    expect(buyerInvoiceState(inv("payment_due", 100, null, true), now).label).toBe("Processing");
    expect(buyerInvoiceState(inv("voided", 0, null), now).label).toBe("Void");
  });
});

describe("failure wording", () => {
  it("says declined only when the code says the bank refused", () => {
    expect(failureVerb("card_declined")).toBe("was declined");
    expect(failureVerb("insufficient_funds")).toBe("was declined");
    expect(failureVerb("processing_error")).toBe("did not go through");
    expect(failureVerb(null)).toBe("did not go through");
  });
  it("puts frozen receipt words in the portal's card format", () => {
    expect(normalizeMethodWords("Visa ···4242")).toBe("Visa •••• 4242");
    expect(normalizeMethodWords("Cash")).toBe("Cash");
  });
});
