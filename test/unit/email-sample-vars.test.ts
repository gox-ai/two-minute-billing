import { describe, expect, it } from "vitest";
import { TEMPLATE_VARS, sampleVarsFor } from "@/modules/emails/templates";

describe("sampleVarsFor", () => {
  it("offers paymentMethodType to the overdue and failed-payment emails", () => {
    for (const t of ["invoice_overdue", "payment_failed"] as const)
      expect(
        TEMPLATE_VARS[t].some((v) => v.key === "paymentMethodType"),
        t,
      ).toBe(true);
  });

  it("leaves out a variable another type receives, so a preview blanks it like a send", () => {
    const v = sampleVarsFor("invoice_issued") as Record<string, unknown>;
    expect(v.paymentMethodType).toBeUndefined();
    expect(v.cardLast4).toBeUndefined();
    expect(v.invoiceNumber).toBeDefined();
  });

  it("keeps every variable the type does receive", () => {
    const v = sampleVarsFor("invoice_overdue") as Record<string, unknown>;
    for (const { key } of TEMPLATE_VARS.invoice_overdue)
      if (key !== "businessName") expect(v[key], key).toBeDefined();
  });
});
