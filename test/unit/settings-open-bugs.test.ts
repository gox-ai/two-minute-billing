import { describe, expect, it } from "vitest";
import { creditNoteSettledBy } from "@/modules/credit-notes/serialize";
import { quotedInstant, QUOTE_TTL_MS } from "@/modules/subscriptions/price-quote";
import { withoutLegacyEmailKeys } from "@/modules/emails/config";
import { creditNoteChipStatus } from "../../dashboard/lib/credit-note-status";

describe("credit note settled_by", () => {
  const n = (status: string, allocatedMinor: bigint, refundedMinor: bigint) => ({
    status: status as "refunded",
    allocatedMinor,
    refundedMinor,
  });
  it("names what used up a refunded note", () => {
    expect(creditNoteSettledBy(n("refunded", 4000n, 0n))).toBe("allocation");
    expect(creditNoteSettledBy(n("refunded", 0n, 4000n))).toBe("refund");
    expect(creditNoteSettledBy(n("refunded", 1000n, 3000n))).toBe("mixed");
  });
  it("is null on every other status, and on an imported note settled with neither", () => {
    expect(creditNoteSettledBy(n("refund_due", 1000n, 0n))).toBeNull();
    expect(creditNoteSettledBy(n("refunded", 0n, 0n))).toBeNull();
  });
  it("the dashboard chip reads Applied to invoices only for an allocation-settled note", () => {
    expect(creditNoteChipStatus({ status: "refunded", settled_by: "allocation" })).toBe(
      "applied_to_invoices",
    );
    expect(creditNoteChipStatus({ status: "refunded", settled_by: "mixed" })).toBe("refunded");
    expect(creditNoteChipStatus({ status: "refund_due", settled_by: null })).toBe("refund_due");
  });
});

describe("quotedInstant", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  it("re-uses a recent instant", () => {
    const at = new Date(now.getTime() - 60_000).toISOString();
    expect(quotedInstant(at, now)?.toISOString()).toBe(at);
  });
  it("prices now when the instant is too old, in the future, or not a date", () => {
    expect(quotedInstant(new Date(now.getTime() - QUOTE_TTL_MS - 1).toISOString(), now)).toBe(
      undefined,
    );
    expect(quotedInstant(new Date(now.getTime() + 60_000).toISOString(), now)).toBe(undefined);
    expect(quotedInstant("nope", now)).toBe(undefined);
    expect(quotedInstant(undefined, now)).toBe(undefined);
  });
});

describe("retired email_config keys", () => {
  it("are dropped, everything else kept", () => {
    expect(
      withoutLegacyEmailKeys({ enabled: true, attachInvoicePdf: false, attachments: {} }),
    ).toEqual({ enabled: true, attachments: {} });
    expect(withoutLegacyEmailKeys(null)).toBeNull();
  });
});
