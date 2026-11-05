/**
 * A SETTLED invoice reports nothing outstanding — whatever the caller passes for `paidMinor`.
 *
 * Found by our user recording a buyer-portal journey on 2026-09-08. They paid two invoices
 * with a 3DS-authenticated India card; both settled correctly (`paid`/`success`, one
 * succeeded payment each, INV-7849 and INV-7850 on the real book) and both times the portal
 * told them "This payment did not settle the invoice — there is still an amount due."
 *
 * The mechanism was a nullish default doing the work of a conditional:
 *
 *     const paid = extra?.paidMinor ?? (inv.status === "paid" ? issueDue : 0n)
 *
 * `??` falls back only on null/undefined, so a caller handing in an explicit **0** — a
 * payments sum read a moment before the settlement committed — defeated the status fallback,
 * and the serializer returned `status: "paid"` beside a full `amount_due_minor`. Output that
 * contradicts itself, which the buyer then read as a failed payment.
 *
 * `amount_due_minor` on the WIRE is the live remaining balance; the stored column of the same
 * name is the issue-time collectible and is never decremented (see its comment in
 * db/schema/invoices.ts, which warns about exactly this misreading). These assertions pin the
 * reported figure, not the column.
 */
import { describe, it, expect } from "vitest";
import { serializeInvoice } from "@/modules/invoicing/serialize";

const BIZ = { publicId: "biz_x", name: "Acme", timezone: null } as never;

/** ₹1,109.20, the amount both journey invoices carried. */
const base = {
  publicId: "inv_x",
  number: "INV-7849",
  currency: "INR",
  subtotalMinor: 94000n,
  totalMinor: 110920n,
  amountDueMinor: 110920n,
  withholdingMinor: 0n,
  promotionalCreditsAppliedMinor: 0n,
  refundableCreditsAppliedMinor: 0n,
  excessPaymentsAppliedMinor: 0n,
  writtenOff: false,
} as never;

const due = (inv: unknown, paidMinor?: bigint) =>
  serializeInvoice({ ...(base as object), ...(inv as object) } as never, {
    biz: BIZ,
    ...(paidMinor === undefined ? {} : { paidMinor }),
  }).amount_due_minor;

describe("a settled invoice never reports an amount outstanding", () => {
  it("reports 0 when the real paid sum is supplied", () => {
    expect(due({ status: "paid" }, 110920n)).toBe(0);
  });

  it("reports 0 when paidMinor is omitted entirely", () => {
    expect(due({ status: "paid" })).toBe(0);
  });

  /** THE REGRESSION. This returned 110920 and is what the buyer was shown. */
  it("reports 0 even when handed a stale paidMinor of 0", () => {
    expect(due({ status: "paid" }, 0n)).toBe(0);
  });

  it("reports 0 for a written-off invoice handed a stale 0", () => {
    expect(due({ status: "payment_due", writtenOff: true }, 0n)).toBe(0);
  });

  it("reports 0 for a voided invoice handed a stale 0", () => {
    expect(due({ status: "voided" }, 0n)).toBe(0);
  });
});

describe("an OPEN invoice still reports what is genuinely left", () => {
  /**
   * The other direction, so the fix cannot be "always report 0". A part-paid open invoice
   * must still show its remainder, which is the case `paidMinor` exists to serve.
   */
  it("subtracts a partial payment", () => {
    expect(due({ status: "payment_due" }, 40920n)).toBe(70000);
  });

  it("reports the full amount when nothing has been paid", () => {
    expect(due({ status: "payment_due" }, 0n)).toBe(110920);
  });

  it("reports 0 once payments cover it, even before the status catches up", () => {
    expect(due({ status: "payment_due" }, 110920n)).toBe(0);
  });
});
