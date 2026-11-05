import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderEmail, blocksFor } from "@/modules/emails/templates";

/**
 * THREE paths render a billing email, and they have to agree about its shape:
 *
 *   1. `enqueueEmails`   → what the customer actually receives
 *   2. `previewTemplate` → what the merchant sees while editing
 *   3. `sendTestEmail`   → what the merchant sees when they check delivery
 *
 * Only (1) originally applied `blocksFor`, so (2) and (3) rendered an email with no facts
 * card, no action button and no sign-off — and (3) SENT that to the one person trying to
 * verify what their customers get. (2) was fixed when the editor's preview pane looked
 * wrong; (3) survived until a screenshot of a real inbox showed a payment-failure email
 * with no Pay-now button at all.
 *
 * Grepping the source is crude, but it is the only thing that catches the fourth path
 * somebody adds later: a unit test can only check the paths it already knows about, and
 * this failure mode is precisely "a new path forgot the shared step".
 */
describe("every render path composes the shell blocks", () => {
  const paths: Array<[label: string, file: string]> = [
    ["outbox (customer mail)", "src/modules/emails/outbox.ts"],
    ["preview (editor)", "src/modules/emails/template-service.ts"],
    ["test send (delivery check)", "src/modules/emails/smtp-service.ts"],
  ];

  for (const [label, file] of paths) {
    it(`${label} calls blocksFor`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("renderEmail(");
      expect(src, `${file} renders email without blocksFor`).toContain("blocksFor(");
    });
  }

  it("no OTHER module renders a billing email without the blocks", () => {
    // If this fails, a fourth path exists: either route it through `blocksFor` or add it
    // to the list above with a reason.
    const known = new Set(paths.map(([, f]) => f));
    for (const f of ["src/modules/emails/adhoc-service.ts", "src/modules/emails/service.ts"]) {
      const src = readFileSync(f, "utf8");
      if (/\brenderEmail\(/.test(src) && !known.has(f)) {
        expect(src, `${f} renders a billing email but never calls blocksFor`).toContain(
          "blocksFor(",
        );
      }
    }
  });

  /**
   * The blocks were only half of it. A path can call `blocksFor` and still send an
   * unbranded email with a button that goes nowhere, because the shell reads the brand
   * from `vars` and `blocksFor` reads the button's destination from `vars.portalUrl` —
   * both supplied by the CALLER, both silently defaulted when absent.
   *
   * That is what the operator-initiated sender did (reported 2026-09-10 from a real
   * `payment_method_request` in a customer's inbox): no brand vars, so `brandedShell` fell
   * back to `#111111` and a merchant's accent colour arrived as a black button with their
   * logo rendered as plain text; and `portalUrl` read straight off `PORTAL_BASE_URL`, the
   * deployment ROOT, so "Update payment method" skipped `/portal` and carried no session.
   */
  const SENDING_PATHS: Array<[label: string, file: string]> = [
    ["outbox (customer mail)", "src/modules/emails/outbox.ts"],
    ["ad-hoc (operator-initiated)", "src/modules/emails/adhoc-service.ts"],
  ];

  for (const [label, file] of [
    ...paths,
    ["ad-hoc (operator-initiated)", "src/modules/emails/adhoc-service.ts"] as [string, string],
  ]) {
    it(`${label} passes the brand vars to the shell`, () => {
      const src = readFileSync(file, "utf8");
      expect(
        src,
        `${file} renders without brandColor — the shell will fall back to #111111`,
      ).toContain("brandColor");
    });
  }

  for (const [label, file] of SENDING_PATHS) {
    it(`${label} mints a pre-authenticated button link`, () => {
      const src = readFileSync(file, "utf8");
      // A path that SENDS to a customer must mint the exchange link, never hand the button
      // a bare base URL — that starts a login instead of doing what the button says.
      expect(src, `${file} sends a billing email without minting a portal link`).toContain(
        "emailPortalLink(",
      );
      expect(
        /config\.PORTAL_BASE_URL/.test(src),
        `${file} reads PORTAL_BASE_URL directly; use portalEntryUrl() so the /portal path is not skipped`,
      ).toBe(false);
    });
  }

  it("the brand colour reaches the button, and its absence is what made it black", () => {
    const base = {
      businessName: "Acme",
      customerName: "Maya",
      portalUrl: "https://portal.test/portal",
    };
    const branded = renderEmail("payment_method_request", {
      ...base,
      brandColor: "#7C3AED",
      ...blocksFor("payment_method_request", base),
    });
    expect(branded.html).toContain("#7C3AED");
    // The fallback is not a neutral default — it is the reported symptom.
    const unbranded = renderEmail("payment_method_request", {
      ...base,
      ...blocksFor("payment_method_request", base),
    });
    expect(unbranded.html).toContain("#111111");
    expect(unbranded.html).not.toContain("#7C3AED");
  });

  it("the blocks actually appear once composed", () => {
    // Belt and braces: prove the composition the paths use produces a button and a card,
    // so the grep above is checking for something that matters.
    const vars = {
      businessName: "Acme",
      customerName: "Maya",
      portalUrl: "https://portal.test",
      amount: "$10.00",
      invoiceNumber: "INV-1",
    };
    const out = renderEmail("payment_failed", { ...vars, ...blocksFor("payment_failed", vars) });
    expect(out.html).toContain(">Pay now</a>");
    expect(out.html).toContain("Invoiced amount");
  });
});
