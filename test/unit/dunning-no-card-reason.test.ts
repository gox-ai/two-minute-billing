import { describe, it, expect } from "vitest";
import { hasCardOnFileForReason } from "@/modules/subscriptions/dunning";

/**
 * `no_card` — the "Cancelled – No Card" reason — must mean what a merchant can verify:
 * no card on file. It used to be derived from `payment_methods.status !== "expired"`, which
 * was correct until that column gained a second meaning — the C6 sweep writes `expired` for a
 * lapsed MANDATE as well as a lapsed card (`decidePaymentSourceExpiry` returns
 * `reason: "card" | "mandate"` for exactly that reason). A Visa valid to 2099 whose mandate
 * ended therefore read as "no card".
 *
 * ⚠️ ASSERTED HERE AND NOT IN A FIXTURE, on purpose. The branch is not reachable end-to-end
 * today: a mandate-expired instrument makes dunning exhaust and PARK, so no cancellation
 * reason is derived at all (measured 2026-09-02 — `verify:dunning` § I pins that park). A gate
 * that cannot go red is decoration, so the decision is asserted where it can be.
 */
const past = new Date("2026-08-02T00:00:00.000Z");
const NOW = new Date("2026-09-02T00:00:00.000Z");

describe("hasCardOnFileForReason", () => {
  it("a valid card whose MANDATE lapsed is still a card on file", () => {
    expect(
      hasCardOnFileForReason([{ expMonth: 1, expYear: 2099, mandateExpiresAt: past }], NOW),
    ).toBe(true);
  });

  it("a card whose PRINTED expiry has passed is not", () => {
    expect(
      hasCardOnFileForReason([{ expMonth: 1, expYear: 2020, mandateExpiresAt: null }], NOW),
    ).toBe(false);
  });

  it("no instruments at all is not — this is the real `no_card`", () => {
    expect(hasCardOnFileForReason([], NOW)).toBe(false);
  });

  it("a card expiring THIS month still counts — `expiring` is not `expired`", () => {
    expect(
      hasCardOnFileForReason([{ expMonth: 9, expYear: 2026, mandateExpiresAt: null }], NOW),
    ).toBe(true);
  });

  it("one good card rescues a customer who also holds an expired one", () => {
    expect(
      hasCardOnFileForReason(
        [
          { expMonth: 1, expYear: 2020, mandateExpiresAt: null },
          { expMonth: 1, expYear: 2099, mandateExpiresAt: null },
        ],
        NOW,
      ),
    ).toBe(true);
  });

  it("a row with no printed expiry counts — absent is not expired", () => {
    expect(
      hasCardOnFileForReason([{ expMonth: null, expYear: null, mandateExpiresAt: null }], NOW),
    ).toBe(true);
  });
});
