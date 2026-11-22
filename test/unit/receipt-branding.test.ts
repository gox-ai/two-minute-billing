import { describe, expect, it } from "vitest";
import { businessSnapshot, type Receipt, type ReceiptSnapshot } from "@/modules/receipts/service";
import { drawReceiptPdf, receiptBranding } from "@/modules/receipts/pdf";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Biz = Parameters<typeof businessSnapshot>[0] & object;
const current = {
  logoUrl: "https://cdn.example.com/now-logo.png",
  iconUrl: "https://cdn.example.com/now-icon.png",
  supportEmail: "help@example.com",
  website: "https://example.com",
  invoiceCustomization: { signature: { caption: "Authorised signatory", position: "bottom_left" } },
};

const oldSnapshotBusiness: ReceiptSnapshot["business"] = {
  name: "Lakeshore Tiles",
  address: null,
  tax_registration_number: null,
  email: null,
  timezone: "UTC",
};

describe("receipt snapshot carries the brand marks", () => {
  it("freezes logo and icon URLs at creation", () => {
    const snap = businessSnapshot({
      name: "Lakeshore Tiles",
      logoUrl: "https://cdn.example.com/a.png",
      iconUrl: null,
      timezone: "UTC",
    } as Biz);
    expect(snap).toMatchObject({ logo_url: "https://cdn.example.com/a.png", icon_url: null });
    expect("icon_url" in snap).toBe(true);
  });
});

describe("receiptBranding", () => {
  it("prints the frozen marks, not today's, when the snapshot has them", () => {
    const b = receiptBranding(
      { ...oldSnapshotBusiness, logo_url: "https://cdn.example.com/then.png", icon_url: null },
      current,
    );
    expect(b.logoUrl).toBe("https://cdn.example.com/then.png");
    expect(b.iconUrl).toBeNull();
  });

  it("a frozen null stays null: no logo at creation is not today's logo", () => {
    const b = receiptBranding({ ...oldSnapshotBusiness, logo_url: null, icon_url: null }, current);
    expect(b.logoUrl).toBeNull();
    expect(b.iconUrl).toBeNull();
  });

  it("an old snapshot without the fields falls back to the current logo and icon", () => {
    const b = receiptBranding(oldSnapshotBusiness, current);
    expect(b.logoUrl).toBe(current.logoUrl);
    expect(b.iconUrl).toBe(current.iconUrl);
  });

  it("signature and contact come from the business, as on the invoice", () => {
    const b = receiptBranding(oldSnapshotBusiness, current);
    expect(b.signature).toEqual({
      imageUrl: null,
      caption: "Authorised signatory",
      position: "bottom_left",
    });
    expect(b.contact).toBe("help@example.com   ·   https://example.com");
  });

  it("no customization and no contact draw no band", () => {
    const b = receiptBranding(oldSnapshotBusiness, null);
    expect(b).toEqual({ logoUrl: null, iconUrl: null, signature: null, contact: "" });
  });
});

describe("drawReceiptPdf", () => {
  const receipt = (business: ReceiptSnapshot["business"]) =>
    ({
      number: "RCPT-1",
      amountMinor: 5000n,
      currency: "USD",
      paidAt: new Date("2026-11-18T00:00:00Z"),
      snapshot: {
        business,
        payer: { id: "cus_1", name: "Ada Payer", email: null, address: null, tax_id: null },
        method: "Cash",
        payments: [],
        payment_request: null,
        allocations: [{ invoice: null, invoice_number: null, amount_minor: 5000 }],
      } satisfies ReceiptSnapshot,
    }) as unknown as Receipt;
  const images = (pdf: Buffer) => pdf.toString("latin1").split("/Subtype /Image").length - 1;

  it("an old snapshot draws the business's current logo", async () => {
    const r = receipt(oldSnapshotBusiness);
    const branded = await drawReceiptPdf(
      r,
      receiptBranding(oldSnapshotBusiness, { ...current, logoUrl: PNG, iconUrl: null }),
    );
    const bare = await drawReceiptPdf(r, receiptBranding(oldSnapshotBusiness, null));
    expect(images(branded)).toBeGreaterThan(0);
    expect(images(bare)).toBe(0);
  });
});
