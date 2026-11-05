/**
 * A subscription's PO number reaching the invoices it raises (0243 gap), and the
 * business switch that decides whether it does (0246).
 *
 * `inheritedPoNumber` is the seam every invoice-raising path funnels through
 * (`commitSubscriptionPeriodInvoice`'s pending-draft insert, its fresh-invoice insert,
 * and `createInvoiceFromLines`'s insert) — see service.ts.
 *
 * The `enabled` argument has no default, deliberately: inheriting changes a PRINTED
 * document, so 0246 pinned every pre-existing business to `false` and made the column
 * default `true` for new ones. A defaulted parameter here would let a new call site
 * silently stamp a PO on a business that opted out, which is the whole thing the
 * migration exists to prevent — so these tests always state it.
 */
import { describe, it, expect } from "vitest";
import { inheritedPoNumber } from "@/modules/invoicing/service";

const ON = true;
const OFF = false;

describe("inheritedPoNumber — enabled", () => {
  it("inherits the subscription's PO onto the invoice", () => {
    expect(inheritedPoNumber({ poNumber: "PO-12345" }, ON)).toBe("PO-12345");
  });

  it("an invoice's own PO always wins over the subscription's", () => {
    expect(inheritedPoNumber({ poNumber: "PO-SUBSCRIPTION" }, ON, "PO-OVERRIDE")).toBe(
      "PO-OVERRIDE",
    );
    // Wins even when the subscription has none at all.
    expect(inheritedPoNumber({ poNumber: null }, ON, "PO-OVERRIDE")).toBe("PO-OVERRIDE");
  });

  it("a NULL subscription PO leaves the invoice NULL, never an empty string", () => {
    expect(inheritedPoNumber({ poNumber: null }, ON)).toBeNull();
    expect(inheritedPoNumber({ poNumber: null }, ON)).not.toBe("");
  });

  it("no subscription at all (a manual/ad-hoc customer invoice) resolves to NULL", () => {
    expect(inheritedPoNumber(null, ON)).toBeNull();
    expect(inheritedPoNumber(undefined, ON)).toBeNull();
  });

  it("an explicit but empty override is still an override — an operator clearing the PO wins", () => {
    expect(inheritedPoNumber({ poNumber: "PO-SUBSCRIPTION" }, ON, "")).toBe("");
  });
});

describe("inheritedPoNumber — disabled, which is what every EXISTING business gets", () => {
  it("does not inherit, so the invoice prints what it printed before 0246", () => {
    expect(inheritedPoNumber({ poNumber: "PO-12345" }, OFF)).toBeNull();
  });

  it("STILL honours an explicit override, because that is not inheritance", () => {
    // An operator who typed a PO onto this invoice, or a draft that already carried one,
    // must keep it whatever the business setting says — the switch governs inheriting
    // from the subscription, not whether an invoice may have a PO at all.
    expect(inheritedPoNumber({ poNumber: "PO-SUBSCRIPTION" }, OFF, "PO-OVERRIDE")).toBe(
      "PO-OVERRIDE",
    );
    expect(inheritedPoNumber(null, OFF, "PO-MANUAL")).toBe("PO-MANUAL");
    expect(inheritedPoNumber({ poNumber: "PO-SUBSCRIPTION" }, OFF, "")).toBe("");
  });

  it("resolves to NULL with no subscription and no override", () => {
    expect(inheritedPoNumber(null, OFF)).toBeNull();
    expect(inheritedPoNumber(undefined, OFF)).toBeNull();
  });
});
