import { describe, it, expect } from "vitest";
import { collectionRank, isHardDecline, shouldTryBackup } from "@/modules/invoicing/collection";

/**
 * Whether a refusal moves on to the customer's BACKUP instrument: any decline does.
 * Only a hard decline also blames the primary (`invalid`); a soft one leaves it first
 * in line for the next retry.
 */
const failed = (retriable: boolean, code = "card_declined") => ({
  status: "failed",
  failure: { retriable, code },
});

describe("shouldTryBackup", () => {
  it("a NON-retriable refusal reaches the backup", () => {
    expect(shouldTryBackup(failed(false))).toBe(true);
  });

  it("a SOFT decline (insufficient funds) reaches the backup too", () => {
    expect(shouldTryBackup(failed(true, "insufficient_funds"))).toBe(true);
  });

  it("…without marking the primary invalid", () => {
    expect(isHardDecline(failed(true, "insufficient_funds"))).toBe(false);
  });

  it("a SUCCESS never reaches the backup", () => {
    expect(shouldTryBackup({ status: "succeeded" })).toBe(false);
  });

  it("a PENDING attempt never reaches the backup — money may still move", () => {
    expect(shouldTryBackup({ status: "pending" })).toBe(false);
  });

  it("an authentication challenge never reaches the backup", () => {
    expect(shouldTryBackup({ status: "requires_action" })).toBe(false);
  });

  it("NEVER falls through after the payer withdrew consent or the issuer flagged fraud", () => {
    for (const code of ["revocation_of_authorization", "debit_not_authorized", "fraudulent"])
      expect(shouldTryBackup(failed(false, code))).toBe(false);
  });

  it("a stolen or lost card still falls through — the card is dead, not the consent", () => {
    expect(shouldTryBackup(failed(false, "stolen_card"))).toBe(true);
    expect(shouldTryBackup(failed(false, "lost_card"))).toBe(true);
  });
});

describe("collectionRank — which decline governs dunning when several cards refused", () => {
  it("retry < park < terminate", () => {
    expect(collectionRank(failed(true, "insufficient_funds"))).toBe(0);
    expect(collectionRank(failed(false, "expired_card"))).toBe(1);
    expect(collectionRank(failed(false, "fraudulent"))).toBe(2);
  });

  it("a stolen card is held for a new one, so it ranks as a park", () => {
    expect(collectionRank(failed(false, "stolen_card"))).toBe(1);
  });

  it("an expired primary outranks a fraud-flagged backup, so the invoice parks rather than cancels", () => {
    expect(collectionRank(failed(false, "expired_card"))).toBeLessThan(
      collectionRank(failed(false, "fraudulent")),
    );
  });
});
