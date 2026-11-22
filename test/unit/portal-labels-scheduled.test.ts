import { describe, expect, it } from "vitest";
import { payuBrand } from "@/providers/payu";
// Relative, not `@/…`: these live in the dashboard app and the root `@/` alias points at src/.
import { instrumentLabel } from "../../dashboard/lib/instrument-label";
import { mandateRailLabel, mandateRevokeWhere } from "../../dashboard/lib/mandate-rail";
import {
  buyerInvoiceState,
  payableNow,
} from "../../dashboard/app/(storefront)/portal/(session)/portal-state";

describe("PayU card brands", () => {
  it("maps PayU card_type codes to the brand names other adapters store", () => {
    expect(payuBrand("MAST")).toBe("mastercard");
    expect(payuBrand("DINR")).toBe("diners");
    expect(payuBrand("VISA")).toBe("visa");
    expect(payuBrand("RUPAY")).toBe("rupay");
  });
  it("names a brand already stored as a PayU code", () => {
    expect(instrumentLabel({ type: "card", brand: "mast", last4: "2346" })).toBe(
      "Mastercard •••• 2346",
    );
    expect(instrumentLabel({ type: "card", brand: "Visa", last4: "1111" })).toBe("Visa •••• 1111");
  });
});

describe("mandate rail words", () => {
  it("never shows the raw rail code", () => {
    expect(mandateRailLabel("directdebit")).toBe("SEPA Direct Debit");
    expect(mandateRailLabel("bacs")).toBe("Bacs Direct Debit");
    expect(mandateRailLabel("something_new")).toBe("Direct Debit");
  });
  it("sends only UPI payers to a UPI app", () => {
    expect(mandateRevokeWhere("upi")).toBe("in your UPI app");
    expect(mandateRevokeWhere("directdebit")).toBe("with your bank");
    expect(mandateRevokeWhere("bacs")).not.toMatch(/UPI/);
  });
});

describe("scheduled collection", () => {
  const inv = {
    status: "payment_due",
    amount_due_minor: 199900,
    due_date: "2026-01-01T00:00:00Z",
    collection_scheduled_at: "2026-11-20T10:00:00Z",
  };
  it("shows Scheduled, not Overdue, and offers no Pay", () => {
    expect(buyerInvoiceState(inv).label).toBe("Scheduled");
    expect(payableNow(inv)).toBe(false);
    expect(payableNow({ ...inv, collection_scheduled_at: null })).toBe(true);
  });
});
