/**
 * HOW A CHARGE LINE IS RE-WORDED ON THE CREDIT NOTE THAT REVERSES IT.
 *
 * A term-reset credit note is spelled out from the source invoice's OWN line descriptions
 * (`issueCurrentTermCredit` → `creditAcrossInvoices`), so `creditedDescription` has to cope
 * with every phrasing a charge line can carry. There are two, and only one was handled:
 *
 *   "Remaining time on BUSINESS plan ×1"   ← ours (non-reset proration pair)     — handled
 *   "BUSINESS plan - Prorated Charges"     ← imported, preserved verbatim        — was NOT
 *
 * The unhandled one shipped: CN-1324 (measured 2026-08-30) carried three lines reading
 * "Unused time on BUSINESS plan - Prorated Charges" — a credit for the unused portion of
 * some *charges*. Both affixes are now stripped.
 *
 * Pinned as a UNIT test on purpose. Proration-line WORDING is not compared end to end, so
 * a wording regression passes the integration suites in silence — the same blind spot that
 * let the forced-reset charge label drift.
 */
import { describe, it, expect } from "vitest";
import { creditedDescription } from "../../src/modules/subscriptions/proration";

describe("creditedDescription", () => {
  it("re-points our own prefix form instead of stacking on it", () => {
    // The bug that was already fixed once: blind prefixing gave
    // "Unused time on Remaining time on BUSINESS plan ×1".
    expect(creditedDescription("Remaining time on BUSINESS plan ×1")).toBe(
      "Unused time on BUSINESS plan ×1",
    );
  });

  it("strips a trailing '- Prorated Charges' — the case that shipped on CN-1324", () => {
    expect(creditedDescription("BUSINESS plan - Prorated Charges")).toBe(
      "Unused time on BUSINESS plan",
    );
    expect(creditedDescription("Looker Studio Destination - Prorated Charges")).toBe(
      "Unused time on Looker Studio Destination",
    );
    expect(creditedDescription("Additional Connections - Prorated Charges")).toBe(
      "Unused time on Additional Connections",
    );
  });

  it("leaves a plain line alone apart from the prefix", () => {
    // A full-term charge line: no affix to strip. This is also what a post-2026-08-30
    // forced-reset charge looks like, now that the reset label is unconditional.
    expect(creditedDescription("PRO plan")).toBe("Unused time on PRO plan");
  });

  it("strips both affixes independently rather than either/or", () => {
    // Nothing emits this today; the point is that a line which ever did would not keep
    // one of the two.
    expect(creditedDescription("Remaining time on PRO plan - Prorated Charges")).toBe(
      "Unused time on PRO plan",
    );
  });

  it("only strips the affixes at their own ends", () => {
    // "Prorated Charges" mid-string, and a plan whose NAME contains the prefix words, must
    // both survive — the anchors are what make this safe to run over arbitrary line text.
    expect(creditedDescription("Prorated Charges Explainer Addon")).toBe(
      "Unused time on Prorated Charges Explainer Addon",
    );
    expect(creditedDescription("Remaining time on plan - Prorated Charges Bundle")).toBe(
      "Unused time on plan - Prorated Charges Bundle",
    );
  });

  it("never returns a bare prefix for an empty description", () => {
    expect(creditedDescription("")).toBe("Unused time on ");
  });
});
