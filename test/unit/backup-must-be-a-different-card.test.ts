import { describe, expect, it } from "vitest";
import { usableBackup } from "@/modules/invoicing/collection";

/**
 * A BACKUP MUST BE A DIFFERENT CARD, NOT JUST A DIFFERENT ROW.
 *
 * `resolveChargeCandidates` returned `bk.id !== primary.id ? bk : null`, comparing row
 * ids. A backup carrying the SAME physical card as the primary passed as a genuine
 * fallback, so when the primary declined, collection "fell back" to the card the issuer
 * had just refused — false resilience, with the operator and the customer both seeing two
 * instruments where there was one.
 *
 * Measured on the live book 2026-09-12, the day `instrument_fingerprint` first existed to
 * see it with: one customer had the same card vaulted FOUR times, another twice.
 *
 * The DB-backed selection is exercised by the collection suites; this pins the DECISION,
 * which is the part that was wrong — and it imports the real `usableBackup` rather than a
 * copy of it, so the test cannot keep passing while the engine changes underneath it.
 */
/**
 * What `usableBackup` reads off a payment-method row. Annotated rather than inferred:
 * `instrumentFingerprint` is NULLABLE on the real row — only Stripe reports one — and a
 * fixture inferred as `string` pins `T` to the non-null shape, so the null cases below
 * stop compiling against the function they are here to pin.
 */
type Instrument = { id: string; instrumentFingerprint: string | null };

const P: Instrument = { id: "pm_primary", instrumentFingerprint: "FoQ4PLzrBK9mV9r0" };

describe("the backup fallback needs a different instrument", () => {
  it("refuses a backup that is the same card under another row", () => {
    // The measured shape: one card, two rows, one holding each role.
    expect(
      usableBackup(P, { id: "pm_other_row", instrumentFingerprint: P.instrumentFingerprint }),
    ).toBeNull();
  });

  it("keeps a backup that is genuinely another card", () => {
    const bk: Instrument = { id: "pm_backup", instrumentFingerprint: "KkCMWILNxTcnIiMm" };
    expect(usableBackup(P, bk)).toBe(bk);
  });

  it("NEVER drops a backup on an unknown fingerprint", () => {
    // Only Stripe reports one. RazorPay has no equivalent and PayPal's v3 schema has no
    // such field, so those rails keep the id-only check they always had. Dropping a real
    // backup on "cannot prove" would cost a collection to prevent a duplicate we never
    // established.
    const bk: Instrument = { id: "pm_backup", instrumentFingerprint: null };
    const unknownPrimary: Instrument = { id: "pm_primary", instrumentFingerprint: null };
    expect(usableBackup(P, bk)).toBe(bk);
    expect(usableBackup(unknownPrimary, bk)).toBe(bk);
  });

  it("still refuses the primary row itself", () => {
    expect(usableBackup(P, P)).toBeNull();
  });
});
