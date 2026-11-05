/**
 * An open intent whose newest attempt was refused must not badge as `in_progress`.
 *
 * Production, 2026-09-18: a setup intent read "In Progress" above its own red
 * "Attempt 1 · Failed · The gateway refused the authorization". `payment_intents` has
 * no `failed` status by design — the refusal lives on the attempt so `retryPaymentIntent`
 * can mint attempt N+1 — so the page has to derive what it shows.
 */
import { describe, it, expect } from "vitest";
import { ATTEMPT_FAILED, displayIntentStatus } from "../../dashboard/lib/payment-intent-status";

const attempt = (attempt_number: number, status: string) => ({ attempt_number, status });

describe("displayIntentStatus", () => {
  it("shows the refusal over an intent left in_progress", () => {
    expect(displayIntentStatus({ status: "in_progress" }, [attempt(1, "failed")])).toBe(
      ATTEMPT_FAILED,
    );
  });

  it("covers the other two states a retry is legal from", () => {
    // `inited` is where a declined authorization is recorded; `authorized` is where a
    // refused VAULT is rewound to (`failSetupConsume`). Both stay open and both used to
    // render as healthy — `authorized` in green.
    for (const status of ["inited", "authorized"] as const)
      expect(displayIntentStatus({ status }, [attempt(1, "failed")])).toBe(ATTEMPT_FAILED);
  });

  it("reads the NEWEST attempt, not the last in the array", () => {
    // Oldest-first is a serializer detail; the engine acts on the highest attempt_number.
    expect(
      displayIntentStatus({ status: "in_progress" }, [
        attempt(2, "failed"),
        attempt(1, "consumed"),
      ]),
    ).toBe(ATTEMPT_FAILED);
    expect(
      displayIntentStatus({ status: "authorized" }, [
        attempt(2, "authorized"),
        attempt(1, "failed"),
      ]),
    ).toBe("authorized");
  });

  it("leaves a terminal intent alone — the failure there is history", () => {
    for (const status of ["consumed", "expired", "voided"] as const)
      expect(displayIntentStatus({ status }, [attempt(1, "failed")])).toBe(status);
    expect(
      displayIntentStatus({ status: "in_progress", voided_at: "2026-09-18T00:00:00Z" }, [
        attempt(1, "failed"),
      ]),
    ).toBe("in_progress");
  });

  it("reads the cached last_attempt_status when the caller has no attempts (a LIST row)", () => {
    // The list cannot load attempts — `payment_intents.last_attempt_status` (0265) is the
    // same fact, denormalised, and both call sites must reach the same verdict or the list
    // and the detail page disagree about one row.
    expect(displayIntentStatus({ status: "in_progress", last_attempt_status: "failed" })).toBe(
      ATTEMPT_FAILED,
    );
    expect(
      displayIntentStatus({ status: "in_progress", last_attempt_status: "requires_action" }),
    ).toBe("in_progress");
    expect(displayIntentStatus({ status: "consumed", last_attempt_status: "failed" })).toBe(
      "consumed",
    );
    // No attempt yet is null on the column, and is not a refusal.
    expect(displayIntentStatus({ status: "inited", last_attempt_status: null })).toBe("inited");
  });

  it("prefers the attempts it was given over the cache", () => {
    // Only reachable if the two ever disagree, which `intent_last_attempt_status_drift`
    // exists to catch — the attempts are the source of truth, so they win.
    expect(
      displayIntentStatus({ status: "in_progress", last_attempt_status: "requires_action" }, [
        attempt(1, "failed"),
      ]),
    ).toBe(ATTEMPT_FAILED);
  });

  it("passes the stored status through when nothing diverges", () => {
    expect(displayIntentStatus({ status: "in_progress" }, [])).toBe("in_progress");
    expect(displayIntentStatus({ status: "in_progress" }, [attempt(1, "requires_action")])).toBe(
      "in_progress",
    );
  });
});
