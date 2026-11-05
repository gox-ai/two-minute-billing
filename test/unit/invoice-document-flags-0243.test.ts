/**
 * Migration 0243 — the two `invoice_customization` resolver flags, plus the pure
 * decision helpers each one drives.
 *
 *  - `invoice.show_zero_value_lines` — default TRUE (we print zero-value lines today).
 *  - `credit_note.service_period_basis` — default `invoice_line_dates`, chosen over
 *    `credit_note_date` on purpose: see customization.ts.
 */
import { describe, it, expect } from "vitest";
import { resolveInvoiceCustomization } from "@/modules/invoicing/customization";
import { shouldPrintChargeLine } from "@/modules/invoicing/document";
import { creditNoteLinePeriod } from "@/modules/credit-notes/document";

describe("resolveInvoiceCustomization — 0243 flags", () => {
  it("defaults show_zero_value_lines to true (current rendering, unchanged)", () => {
    const c = resolveInvoiceCustomization(null);
    expect(c.invoice.showZeroValueLines).toBe(true);
  });

  it("honours an explicit false", () => {
    const c = resolveInvoiceCustomization({
      invoiceCustomization: { invoice: { show_zero_value_lines: false } },
    });
    expect(c.invoice.showZeroValueLines).toBe(false);
  });

  it("a malformed value falls back to the default (true), not to false", () => {
    const c = resolveInvoiceCustomization({
      invoiceCustomization: { invoice: { show_zero_value_lines: "nope" } },
    });
    expect(c.invoice.showZeroValueLines).toBe(true);
  });

  it("defaults credit_note.service_period_basis to invoice_line_dates", () => {
    const c = resolveInvoiceCustomization(null);
    expect(c.creditNote.servicePeriodBasis).toBe("invoice_line_dates");
  });

  it("honours an explicit credit_note_date", () => {
    const c = resolveInvoiceCustomization({
      invoiceCustomization: { credit_note: { service_period_basis: "credit_note_date" } },
    });
    expect(c.creditNote.servicePeriodBasis).toBe("credit_note_date");
  });

  it("an unknown basis value falls back to the default, not to the other valid value", () => {
    const c = resolveInvoiceCustomization({
      invoiceCustomization: { credit_note: { service_period_basis: "sometime_else" } },
    });
    expect(c.creditNote.servicePeriodBasis).toBe("invoice_line_dates");
  });

  it("resolveInvoiceCustomization is otherwise unaffected by the two new keys", () => {
    // A malformed/absent value for either new key must not perturb sibling fields —
    // pinned because both were added to existing StoredCustomization sub-objects.
    const c = resolveInvoiceCustomization({
      invoiceCustomization: {
        invoice: { show_status: false },
        credit_note: { show_status: false },
      },
    });
    expect(c.invoice.showZeroValueLines).toBe(true);
    expect(c.creditNote.servicePeriodBasis).toBe("invoice_line_dates");
    expect(c.invoice.showStatus).toBe(false);
    expect(c.creditNote.showStatus).toBe(false);
  });
});

describe("shouldPrintChargeLine — invoice document zero-value suppression", () => {
  it("always prints when show_zero_value_lines is true", () => {
    expect(shouldPrintChargeLine(true, 0n)).toBe(true);
    expect(shouldPrintChargeLine(true, 500n)).toBe(true);
  });

  it("suppresses only a GROSS-zero line when the flag is false", () => {
    expect(shouldPrintChargeLine(false, 0n)).toBe(false);
    expect(shouldPrintChargeLine(false, 1n)).toBe(true);
    expect(shouldPrintChargeLine(false, 500n)).toBe(true);
  });

  it("a line fully discounted to zero NET is still gross-nonzero, so it still prints", () => {
    // shouldPrintChargeLine takes the GROSS amount (chargeLines[].amountMinor), never the
    // net-of-item-discount figure — a 100%-off line still explains what the discount
    // footer applied to. Simulated here: gross 1000, fully discounted, still prints.
    const grossAmountMinor = 1000n;
    expect(shouldPrintChargeLine(false, grossAmountMinor)).toBe(true);
  });
});

describe("creditNoteLinePeriod — credit note service-period basis", () => {
  const cnIssuedAt = new Date("2026-09-08T00:00:00Z");
  const invoiceLinePeriod = {
    start: new Date("2026-01-01T00:00:00Z"),
    end: new Date("2026-02-01T00:00:00Z"),
  };

  it("prints nothing when show_service_period is off, regardless of basis", () => {
    expect(
      creditNoteLinePeriod(false, "invoice_line_dates", cnIssuedAt, invoiceLinePeriod),
    ).toBeNull();
    expect(
      creditNoteLinePeriod(false, "credit_note_date", cnIssuedAt, invoiceLinePeriod),
    ).toBeNull();
  });

  it("invoice_line_dates (default) reports the credited line's own period", () => {
    expect(creditNoteLinePeriod(true, "invoice_line_dates", cnIssuedAt, invoiceLinePeriod)).toEqual(
      invoiceLinePeriod,
    );
  });

  it("invoice_line_dates prints nothing for an ad-hoc line with no period", () => {
    expect(creditNoteLinePeriod(true, "invoice_line_dates", cnIssuedAt, null)).toBeNull();
  });

  it("credit_note_date reports the note's own issue date as both start and end", () => {
    expect(creditNoteLinePeriod(true, "credit_note_date", cnIssuedAt, invoiceLinePeriod)).toEqual({
      start: cnIssuedAt,
      end: cnIssuedAt,
    });
  });

  it("credit_note_date is available even for an ad-hoc line with no invoice period", () => {
    expect(creditNoteLinePeriod(true, "credit_note_date", cnIssuedAt, null)).toEqual({
      start: cnIssuedAt,
      end: cnIssuedAt,
    });
  });
});
