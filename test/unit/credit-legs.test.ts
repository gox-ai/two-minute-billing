import { describe, it, expect } from "vitest";
import {
  creditLegSentences,
  creditResidueMinor,
  type CreditDestinationEntry,
} from "../../dashboard/lib/credit-legs";

/**
 * THE CREDITS PROSE — the sentences all three change surfaces render.
 *
 * The change dialog keeps its charges table pure and explains the credit note in a separate
 * `Credits` section (amount, type, period, destination). `creditLegSentences` is the
 * one place that wording lives, so the buyer's checkout, the operator's rail and the confirm
 * dialog cannot drift into three explanations of one split.
 *
 * These are PURE-FUNCTION tests on purpose. The bug this whole change exists to fix was a
 * screen deriving "what this invoice absorbed" locally — `gross − openInvoices` in two places,
 * `min(gross, invoiceTotal)` in a third — each right on the one shape it was debugged against
 * and wrong elsewhere. That class of defect is arithmetic, not layout, so it is cheapest to
 * pin here and hopeless to pin in a browser.
 *
 * The three destination shapes below are the ones `verify:estimates` actually emits (the
 * open-debt, downgrade and promo-funded fixtures), so a change to the engine's vocabulary
 * breaks this file rather than silently changing what a buyer reads.
 */

/** Minor units → a stable string, so assertions read like the rendered line. */
const inr = (m: number) => `₹${(m / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
const when = (iso: string) => iso.slice(0, 10);

describe("creditLegSentences", () => {
  it("says nothing when the change issues no credit note", () => {
    expect(creditLegSentences({ grossMinor: 0, destinations: [] }, inr)).toEqual([]);
  });

  it("opens with the gross and the credited period — the ladder no longer shows either", () => {
    const out = creditLegSentences(
      {
        grossMinor: 8866444,
        destinations: [
          {
            kind: "adjustment",
            destination: "open_invoice",
            amount_minor: 2209813,
            invoice: "INV-58",
          },
          { kind: "refundable", destination: "this_invoice", amount_minor: 6656631 },
        ],
        periodStart: "2026-08-31T00:00:00.000Z",
        periodEnd: "2026-09-30T00:00:00.000Z",
      },
      inr,
      { fmtWhen: when },
    );
    // The face value of the note appears exactly once, in the opening sentence.
    expect(out[0]).toBe(
      "₹88,664.44 in credits will be created for the unused period 2026-08-31 – 2026-09-30.",
    );
    expect(out).toHaveLength(3);
  });

  it("names the invoice an adjustment cleared", () => {
    const out = creditLegSentences(
      {
        grossMinor: 3294324,
        destinations: [
          {
            kind: "adjustment",
            destination: "open_invoice",
            amount_minor: 3294324,
            invoice: "INV-58",
          },
        ],
      },
      inr,
    );
    expect(out[1]).toContain("INV-58");
    expect(out[1]).toContain("adjustment credits");
    // The buyer is told their DEBT went, not that they were refunded.
    expect(out[1]).toContain("clearing what you owed on it");
    expect(out[1]).not.toContain("refundable");
  });

  it("renders the operator wording for the same split", () => {
    const out = creditLegSentences(
      {
        grossMinor: 3294324,
        destinations: [
          {
            kind: "adjustment",
            destination: "open_invoice",
            amount_minor: 3294324,
            invoice: "INV-58",
          },
        ],
      },
      inr,
      { audience: "operator" },
    );
    expect(out[1]).toContain("This clears the debt. It is not a refund");
  });

  it("renders the MIXED shape as two sentences from one note (the downgrade fixture)", () => {
    // One note, two destinations: what the new invoice absorbed, and the overflow to balance.
    // This is the shape every local derivation got wrong — `gross − openInvoices` reports the
    // whole 5324160 as applied here when only 5235424 was.
    const destinations: CreditDestinationEntry[] = [
      { kind: "refundable", destination: "this_invoice", amount_minor: 5235424 },
      { kind: "refundable", destination: "balance", amount_minor: 88736 },
    ];
    const out = creditLegSentences({ grossMinor: 5324160, destinations }, inr);
    expect(out).toHaveLength(3);
    expect(out[1]).toBe(
      "₹52,354.24 of prorated refundable credits is applied to the invoice above.",
    );
    expect(out[2]).toBe(
      "₹887.36 of prorated refundable credits is added to your balance and spent at your next renewal.",
    );
    // No residue sentence: the destinations account for the note exactly.
    expect(out.some((s) => s.includes("unaccounted"))).toBe(false);
  });

  it("keeps a bucket restore OUT of the balance sentence (the promo-funded fixture)", () => {
    const out = creditLegSentences(
      {
        grossMinor: 1000000,
        destinations: [{ kind: "bucket_restore", destination: "buckets", amount_minor: 1000000 }],
      },
      inr,
    );
    // Promotional credit never becomes spendable balance — the rule credit-routing.ts exists
    // to hold. Saying "added to your balance" here would be a misstatement, not a paraphrase.
    expect(out[1]).toContain("returns to the promotional and excess credit");
    expect(out[1]).not.toContain("balance");
  });

  it("orders destinations so the non-spendable slice is read first", () => {
    const out = creditLegSentences(
      {
        grossMinor: 600,
        destinations: [
          { kind: "refundable", destination: "balance", amount_minor: 100 },
          { kind: "refundable", destination: "this_invoice", amount_minor: 200 },
          { kind: "adjustment", destination: "open_invoice", amount_minor: 300, invoice: "INV-9" },
        ],
      },
      inr,
    );
    expect(out[1]).toContain("INV-9");
    expect(out[2]).toContain("invoice above");
    expect(out[3]).toContain("balance");
  });

  it("drops the period clause rather than printing a raw ISO instant", () => {
    // `fmtWhen` is how each surface pins its own locale + business timezone. Without it the
    // sentence must not leak `2026-08-31T00:00:00.000Z` onto a buyer's screen.
    const out = creditLegSentences(
      {
        grossMinor: 1000,
        destinations: [{ kind: "refundable", destination: "this_invoice", amount_minor: 1000 }],
        periodStart: "2026-08-31T00:00:00.000Z",
        periodEnd: "2026-09-30T00:00:00.000Z",
      },
      inr,
    );
    expect(out[0]).toBe("₹10.00 in credits will be created for the unused period.");
    expect(out[0]).not.toContain("T00:00");
  });

  it("STATES a residue instead of hiding it — a note whose slices do not sum", () => {
    // Not reachable through a healthy engine response (conservation is asserted per-fixture),
    // and rendered anyway: a section that opens with a gross figure and quietly places less
    // than all of it is the exact failure this reshape was meant to end.
    const out = creditLegSentences(
      {
        grossMinor: 1000,
        destinations: [{ kind: "refundable", destination: "this_invoice", amount_minor: 600 }],
      },
      inr,
    );
    expect(out[out.length - 1]).toContain("₹4.00");
    expect(out[out.length - 1]).toContain("unaccounted for");
  });

  it("calls an OVERSTATED note double-counted, never floors it away", () => {
    const n = {
      grossMinor: 1000,
      destinations: [
        { kind: "refundable" as const, destination: "this_invoice" as const, amount_minor: 1500 },
      ],
    };
    expect(creditResidueMinor(n)).toBe(-500);
    expect(creditLegSentences(n, inr).at(-1)).toContain("double-counted");
  });

  it("skips zero-amount destinations without dropping the sentence count elsewhere", () => {
    const out = creditLegSentences(
      {
        grossMinor: 1000,
        destinations: [
          { kind: "refundable", destination: "this_invoice", amount_minor: 1000 },
          { kind: "stranded", destination: "none", amount_minor: 0 },
        ],
      },
      inr,
    );
    expect(out).toHaveLength(2);
    expect(out.some((s) => s.includes("could not be"))).toBe(false);
  });

  it("names a stranded slice (UNTESTED IN THE ENGINE — no fixture produces one)", () => {
    // ⚠ The engine cannot currently produce this shape, so conservation is measured on four of
    // the five kinds and this branch carries less assurance than its neighbours (recorded as an
    // open gap in docs/PROGRESS.md). Pinned here so the wording is at least deliberate: credit
    // nobody could fund must be named, because dropping it makes the section stop adding up.
    const out = creditLegSentences(
      {
        grossMinor: 1000,
        destinations: [{ kind: "stranded", destination: "none", amount_minor: 1000 }],
      },
      inr,
    );
    expect(out[1]).toBe("₹10.00 could not be applied to anything on your account.");
    expect(out.some((s) => s.includes("unaccounted"))).toBe(false);
  });
});
