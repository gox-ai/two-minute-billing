import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MERCHANT_SIDE_PARK,
  PARK,
  PARK_EVEN_IN_FIXED_MODE,
  TERMINATE,
  classifyDecline,
} from "@/modules/subscriptions/decline-policy";
import { declineHiddenFromPayer, isTerminalDeclineCode } from "@/providers/decline-codes";

/**
 * A GATEWAY THROW MUST LEAVE A ROW.
 *
 * INV-100004 (2026-09-10): Stripe answered the renewal's PaymentIntent with HTTP 400,
 * the adapter threw, `collectClaimedInvoice`'s catch re-threw, and nothing was booked —
 * no transaction, no payment, `attempt_count` 0, `next_attempt_at` NULL. Neither
 * `runDunningPass` (`next_attempt_at IS NOT NULL`) nor `sweepExpiredParkedDunning`
 * (`dunning_status = 'parked'`) can see such an invoice, so it is stranded for ever
 * while the subscription keeps serving.
 *
 * What regresses if these break: a re-added `throw e` fall-through silently strands
 * invoices again, and an indeterminate throw booked as a failure sends dunning back to
 * a gateway that may already have taken the money.
 */
const SERVICE = readFileSync(resolve(__dirname, "../../src/modules/invoicing/service.ts"), "utf8");

/** The catch that wraps the collection attempt loop, source text only. */
const attemptCatch = (() => {
  const start = SERVICE.indexOf("a = await attempt(pm);");
  expect(start).toBeGreaterThan(-1);
  const end = SERVICE.indexOf("const outcome = tmtestOutcome(a.result);", start);
  expect(end).toBeGreaterThan(start);
  return SERVICE.slice(start, end);
})();

describe("a throw from the gateway books an attempt instead of vanishing", () => {
  it("has no bare re-throw left in the attempt catch", () => {
    expect(attemptCatch).toMatch(/catch \(e\)/);
    expect(attemptCatch).not.toMatch(/^\s*throw e;\s*$/m);
  });

  it("books a RETRIABLE attempt for an unrecognised gateway error", () => {
    // Retriable is the load-bearing half. A catch-all cannot tell a malformed request from
    // a timeout or an outage, and parking an outage stops collection on money the next
    // tick would have taken. This branch booked the parking `gateway_request_rejected`
    // until 2026-09-10 — a token that asserts the request was ours to fix, which a
    // catch-all is in no position to claim.
    expect(attemptCatch).toMatch(/recordFailedPayment\(/);
    expect(attemptCatch).toMatch(/failureCode: "gateway_error"/);
    expect(attemptCatch).toMatch(/retriable: true/);
    expect(attemptCatch).not.toMatch(/failureCode: "gateway_request_rejected"/);
  });

  it("still logs the original error, so the stack reaches the error feed", () => {
    expect(attemptCatch).toMatch(/log\.error\(/);
  });

  it("keeps the pre-existing gateway_account_unavailable branch", () => {
    expect(attemptCatch).toMatch(/GatewayRouterError/);
    expect(attemptCatch).toMatch(/failureCode: "gateway_account_unavailable"/);
  });
});

describe("an indeterminate outcome is never booked as a failure", () => {
  /** Where the indeterminate guard opens, and where the catch-all books a failure. */
  const guardAt = attemptCatch.indexOf("if (e instanceof ProviderIndeterminateError)");
  const bookFailureAt = attemptCatch.indexOf("recordFailedPayment(", guardAt);

  it("is handled before the catch-all", () => {
    expect(guardAt).toBeGreaterThan(-1);
    expect(bookFailureAt).toBeGreaterThan(guardAt);
  });

  it("books pending/timeout — money may have moved, so dunning must not retry", () => {
    const branch = attemptCatch.slice(guardAt, bookFailureAt);
    expect(branch).toMatch(/bookPending\(/);
    expect(branch).toMatch(/"timeout"/);
    expect(branch).not.toMatch(/recordFailedPayment/);
    // The stranded id is the only handle on an object the gateway kept.
    expect(branch).toMatch(/strandedObjectId\(e\)/);
  });
});

describe("an unknown gateway fault retries — it is not a hard failure", () => {
  it("follows the dunning config instead of parking", () => {
    // It could be an outage. `gateway_error` is in neither PARK nor TERMINATE, so the
    // invoice keeps its schedule and a fault that clears is collected on the next tick.
    expect(classifyDecline("gateway_error")).toBe("retry");
    expect(PARK.has("gateway_error")).toBe(false);
    expect(TERMINATE.has("gateway_error")).toBe(false);
  });

  it("is not terminal to the provider layer either", () => {
    // The two must agree, or dunning and the payer-facing copy tell different stories
    // about the same failure.
    expect(isTerminalDeclineCode("gateway_error")).toBe(false);
  });
});

describe("gateway_request_rejected still parks — it means we sent a bad request", () => {
  it("classifies as park", () => {
    expect(classifyDecline("gateway_request_rejected")).toBe("park");
  });

  it("is merchant-side, so no payer action can clear it", () => {
    expect(MERCHANT_SIDE_PARK.has("gateway_request_rejected")).toBe(true);
  });

  it("parks even in fixed mode — a fixed-schedule business must not cancel over our fault", () => {
    expect(PARK_EVEN_IN_FIXED_MODE.has("gateway_request_rejected")).toBe(true);
  });

  it("is hidden from the payer, so our own gateway complaint never reaches their inbox", () => {
    expect(declineHiddenFromPayer("gateway_request_rejected")).toBe(true);
  });
});
