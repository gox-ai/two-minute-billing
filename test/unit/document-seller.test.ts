/** The shared seller block: invoices and credit notes name the same issuer. */
import { describe, it, expect } from "vitest";
import { resolveInvoiceCustomization } from "@/modules/invoicing/customization";
import { documentSeller } from "@/modules/invoicing/document";

const custom = resolveInvoiceCustomization(null);
const biz = {
  name: "Shop One",
  address: { line1: "1 Shop St", city: "Pune", country: "IN" },
  taxRegistrationNumber: "27BIZ",
  supportEmail: "help@shop.example",
  website: null,
  logoUrl: "https://shop.example/logo.png",
  iconUrl: null,
  timezone: "Asia/Kolkata",
} as unknown as Parameters<typeof documentSeller>[0];

describe("documentSeller", () => {
  it("prints the business when no issuer resolved", () => {
    const s = documentSeller(biz, "biz_1", null, custom);
    expect(s.name).toBe("Shop One");
    expect(s.taxRegId).toBe("27BIZ");
    expect(s.addressLines).toContain("1 Shop St");
  });

  it("prints the entity's legal name, address and tax id, keeping the business's brand", () => {
    const s = documentSeller(
      biz,
      "biz_1",
      {
        name: "Acct",
        legalName: "Entity Pvt Ltd",
        address: { line1: "9 Entity Rd", country: "US" },
        taxRegistrationNumber: "ENT1",
      },
      custom,
    );
    expect(s.name).toBe("Entity Pvt Ltd");
    expect(s.taxRegId).toBe("ENT1");
    expect(s.addressLines).toContain("9 Entity Rd");
    expect(s.addressLines).not.toContain("1 Shop St");
    expect(s.supportEmail).toBe("help@shop.example");
    expect(s.logoUrl).toBe("https://shop.example/logo.png");
    expect(s.timezone).toBe("Asia/Kolkata");
  });

  it("falls back to the account name when the entity has no legal name", () => {
    const s = documentSeller(
      biz,
      "biz_1",
      { name: "Acct", legalName: null, address: null, taxRegistrationNumber: "ENT1" },
      custom,
    );
    expect(s.name).toBe("Acct");
  });
});
