import { describe, expect, it } from "vitest";
import {
  ON_FILE_CONSENT_TEXT_VERSION,
  OnFileConsentError,
  consentFromJson,
  onFileConsentEvidence,
  onFileConsentText,
} from "@/modules/payment-methods/on-file-consent";

const parties = {
  businessName: "Larkfield Studio",
  payerName: "Ana Ruiz",
  payerEmail: "ana@example.com",
};

describe("on-file consent", () => {
  it("says when the method is charged, for what amount, and how to stop it", () => {
    const t = onFileConsentText("Larkfield Studio");
    expect(t).toMatch(/future invoices/);
    expect(t).toMatch(/amount due on the invoice/);
    expect(t).toMatch(/delete it in your billing portal/);
  });
  it("stores the exact text of the version the buyer saw", () => {
    const at = new Date("2026-11-19T10:00:00Z");
    const e = onFileConsentEvidence(
      { textVersion: ON_FILE_CONSENT_TEXT_VERSION, ipAddress: "203.0.113.5", userAgent: "UA" },
      parties,
      at,
    );
    expect(e.text).toBe(onFileConsentText("Larkfield Studio"));
    expect(e.acceptedAt).toEqual(at);
    // Round-trips through the intent's JSON column.
    expect(consentFromJson(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });
  it("refuses a version we no longer show", () => {
    expect(() =>
      onFileConsentEvidence({ textVersion: "old", ipAddress: null, userAgent: null }, parties),
    ).toThrow(OnFileConsentError);
  });
  it("reads nothing from a malformed column", () => {
    expect(consentFromJson(null)).toBeNull();
    expect(consentFromJson({ text: 1 })).toBeNull();
  });
});
