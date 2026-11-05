import { describe, it, expect } from "vitest";
import { updateBusinessBody } from "@/api/routes";
import { resolveEmailConfig, attachmentRule, MAX_FOOTER_NOTE_CHARS } from "@/modules/emails/config";
import { openapiDocument } from "@/api/openapi";

/**
 * Zod strips unknown keys, so an `email_config` field the ENGINE reads but the write
 * schema omits is discarded silently — the PATCH succeeds, the settings screen keeps
 * showing what the merchant typed, and the value never existed.
 *
 * `footerNote` shipped exactly that way: added to `EmailConfig`, to `resolveEmailConfig`,
 * to the shell that renders it and to the settings form that posts it — but not to the
 * zod object three lines below a comment warning about this precise trap. The dashboard
 * control was dead and nothing failed.
 *
 * These tests are keyed off `resolveEmailConfig`'s own output rather than a hand-listed
 * set of names, so a field added later is covered the day it is added.
 */
describe("email_config write path accepts everything the engine reads", () => {
  // The resolver returns every key with its default, so this IS the runtime contract.
  const engineKeys = Object.keys(resolveEmailConfig(null)).sort();

  it("the resolver exposes the keys we expect to police", () => {
    // A guard on the guard: if the resolver ever stopped returning a full object, the two
    // tests below would pass vacuously.
    expect(engineKeys).toContain("footerNote");
    expect(engineKeys.length).toBeGreaterThanOrEqual(9);
  });

  it("emailConfigWriteSchemaIsComplete — zod keeps every engine field", () => {
    // One value per key, shaped to pass each field's own validation.
    const sample: Record<string, unknown> = {
      enabled: true,
      fromName: "Acme",
      fromAddress: "billing@acme.test",
      replyTo: "support@acme.test",
      cc: ["cc@acme.test"],
      bcc: ["bcc@acme.test"],
      subjectPrefix: "[Acme]",
      footerNote: "PS: thanks for being a customer.",
      // `pdf: false` deliberately: absent means attached, so a sample of `true` would survive
      // a schema that dropped it while the merchant's OFF was being discarded.
      attachments: { invoice_issued: { pdf: false, skipZeroPdf: false, skipZeroSend: true } },
      types: { invoice_issued: false },
      attachReceiptPdf: true,
      linkTarget: "merchant_url",
      merchantUrl: "https://billing.example.com/account",
    };
    // Every engine key must be represented above, or this test cannot police it.
    expect(Object.keys(sample).sort()).toEqual(engineKeys);

    const parsed = updateBusinessBody.parse({ email_config: sample });
    const kept = Object.keys(parsed.email_config as object).sort();
    const stripped = engineKeys.filter((k) => !kept.includes(k));
    expect(stripped, `silently stripped on write: ${stripped.join(", ")}`).toEqual([]);
  });

  it("the OpenAPI email_config schema documents every engine field", () => {
    // The spec is a hand-maintained literal with no imports, so it drifts the same way —
    // and an undocumented field is one an API consumer cannot discover.
    // Walked with `any` on purpose: the spec is a deeply nested literal, and typing the
    // path precisely here buys nothing a failed assertion would not already tell us.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const doc = openapiDocument as any;
    const props =
      doc.paths?.["/v1/businesses/{biz}"]?.patch?.requestBody?.content?.["application/json"]?.schema
        ?.properties?.email_config?.properties;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(props, "email_config properties not found in the spec").toBeTruthy();
    const documented = Object.keys(props as Record<string, unknown>);
    const missing = engineKeys.filter((k) => !documented.includes(k));
    expect(missing, `undocumented in OpenAPI: ${missing.join(", ")}`).toEqual([]);
  });

  it("an over-long footerNote is refused at the API, not truncated later", () => {
    // resolveEmailConfig truncates on READ; the write layer should say so instead of
    // accepting 5,000 characters and quietly keeping the cap.
    const r = updateBusinessBody.safeParse({
      email_config: { enabled: true, footerNote: "x".repeat(MAX_FOOTER_NOTE_CHARS + 1) },
    });
    expect(r.success).toBe(false);
  });

  it("the business footer may only use variables every email has", () => {
    const ok = updateBusinessBody.safeParse({
      email_config: { enabled: true, footerNote: "Thanks,\nThe {{businessName}} team" },
    });
    expect(ok.success).toBe(true);
    const bad = updateBusinessBody.safeParse({
      email_config: { enabled: true, footerNote: "Your invoice {{invoiceNumber}}" },
    });
    expect(bad.success).toBe(false);
  });
});

describe("per-email attachment rules", () => {
  it("an absent type attaches the PDF and skips nothing", () => {
    expect(attachmentRule(resolveEmailConfig({ emailConfig: {} }), "invoice_issued")).toEqual({
      pdf: true,
      skipZeroPdf: false,
      skipZeroSend: false,
    });
  });

  it("a type about no document has no rule", () => {
    expect(attachmentRule(resolveEmailConfig(null), "trial_started")).toBeNull();
  });

  it("zero-value rules survive only where a zero-value invoice can occur", () => {
    const cfg = resolveEmailConfig({
      emailConfig: {
        attachments: {
          invoice_issued: { pdf: true, skipZeroPdf: true, skipZeroSend: true },
          invoice_sent: { pdf: true, skipZeroPdf: true, skipZeroSend: true },
          payment_receipt: { pdf: false, skipZeroPdf: true, skipZeroSend: true },
          trial_started: { pdf: false },
        },
      },
    });
    expect(cfg.attachments.invoice_issued).toEqual({
      pdf: true,
      skipZeroPdf: true,
      skipZeroSend: true,
    });
    // An operator's "Send invoice" is never silently not sent.
    expect(cfg.attachments.invoice_sent).toEqual({
      pdf: true,
      skipZeroPdf: true,
      skipZeroSend: false,
    });
    expect(cfg.attachments.payment_receipt).toEqual({
      pdf: false,
      skipZeroPdf: false,
      skipZeroSend: false,
    });
    expect(cfg.attachments.trial_started).toBeUndefined();
  });

  it("the old business-wide flag is no longer read", () => {
    const cfg = resolveEmailConfig({ emailConfig: { attachDocumentPdf: false } });
    expect(attachmentRule(cfg, "invoice_issued")?.pdf).toBe(true);
  });
});

describe("business footer line breaks", () => {
  it("is read back as plain lines, whatever the browser posted", () => {
    const cfg = resolveEmailConfig({
      emailConfig: { footerNote: "Thanks, \r\n{{businessName}} team \r\n" },
    });
    expect(cfg.footerNote).toBe("Thanks,\n{{businessName}} team");
  });
});
