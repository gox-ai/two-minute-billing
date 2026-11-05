import { describe, it, expect } from "vitest";
import {
  collectionDecision,
  collectionRulesActive,
  mergeInvoiceRulesConfig,
  resolveInvoiceRulesConfig,
} from "../../src/modules/invoicing/invoice-rules-config";

const defaults = resolveInvoiceRulesConfig(null);

describe("resolveInvoiceRulesConfig", () => {
  it("resolves an unset business to today's behaviour", () => {
    expect(defaults).toEqual({
      smallInvoiceAction: "charge",
      smallInvoiceThresholds: {},
      chargeTiming: "at_creation",
    });
    expect(collectionRulesActive(defaults, "USD")).toBe(false);
  });

  it("drops unknown values", () => {
    const c = resolveInvoiceRulesConfig({
      invoiceRulesConfig: { small_invoice_action: "roll", charge_timing: "x" },
    });
    expect(c.smallInvoiceAction).toBe("charge");
    expect(c.chargeTiming).toBe("at_creation");
  });
});

describe("collectionDecision", () => {
  const now = new Date("2027-01-01T00:00:00Z");
  const later = new Date("2027-01-16T00:00:00Z");

  it("waits for a future due date only with on_due_date", () => {
    const inv = { status: "posted", amountDueMinor: 1000n, currency: "USD", dueDate: later };
    expect(collectionDecision(defaults, inv, now)).toBe("charge");
    const onDue = { ...defaults, chargeTiming: "on_due_date" as const };
    expect(collectionDecision(onDue, inv, now)).toBe("wait_for_due_date");
    expect(collectionDecision(onDue, { ...inv, dueDate: now }, now)).toBe("charge");
  });

  it("writes off only an amount due below the currency's limit", () => {
    const cfg = {
      ...defaults,
      smallInvoiceAction: "write_off" as const,
      smallInvoiceThresholds: { USD: 100 },
    };
    const inv = { status: "payment_due", currency: "USD", dueDate: now };
    expect(collectionDecision(cfg, { ...inv, amountDueMinor: 50n }, now)).toBe("write_off");
    expect(collectionDecision(cfg, { ...inv, amountDueMinor: 100n }, now)).toBe("charge");
    expect(collectionDecision(cfg, { ...inv, amountDueMinor: 50n, currency: "EUR" }, now)).toBe(
      "charge",
    );
    expect(collectionDecision(cfg, { ...inv, status: "paid", amountDueMinor: 0n }, now)).toBe(
      "charge",
    );
  });
});

describe("mergeInvoiceRulesConfig", () => {
  it("replaces a threshold map and upper-cases its codes", () => {
    expect(
      mergeInvoiceRulesConfig(
        { charge_timing: "on_due_date", small_invoice_thresholds: { USD: 1 } },
        { small_invoice_thresholds: { eur: 5 } },
      ),
    ).toEqual({ charge_timing: "on_due_date", small_invoice_thresholds: { EUR: 5 } });
  });
});
