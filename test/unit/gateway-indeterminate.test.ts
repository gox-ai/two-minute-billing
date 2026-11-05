/**
 * #42 — a gateway condition we cannot resolve gets an HTTP shape of its own.
 *
 * #32 made PayPal's `voidIntent` THROW when it cannot establish which authorization to
 * void. Nothing wrapped that throw, so a raw `Error` reached the route and fell through
 * to a 500 — the same failure `ProviderRefusalError` was created to end ("the one person
 * who can do nothing about it got the least useful message we produce"), reached from the
 * other direction.
 *
 * The pair under test here is the whole design, so both halves are asserted TOGETHER in
 * every case: a REFUSAL is a request a human must change (400), an INDETERMINATE result
 * is knowledge we do not have (502, `retriable: true`). A mutation that swaps the two
 * must be caught, which is why nothing below asserts one status without the other.
 */
import { describe, it, expect } from "vitest";
import type { FastifyReply } from "fastify";
import { ProviderIndeterminateError, ProviderRefusalError } from "@/providers/types";
import { badGateway, badRequest, conflict } from "@/api/helpers";

/** The two calls `badGateway` makes on a reply, captured. */
function fakeReply() {
  const seen: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      seen.status = status;
      return this;
    },
    send(body: unknown) {
      seen.body = body;
      return this;
    },
  };
  return { reply: reply as unknown as FastifyReply, seen };
}

const errorBody = (body: unknown) =>
  (body as { error: { type: string; message: string; retriable?: boolean } }).error;

describe("#42 · the two gateway error classes are mirrors, not synonyms", () => {
  it("an indeterminate result is its own class, distinguishable from a refusal", () => {
    const ind = new ProviderIndeterminateError("could not establish which authorization");
    const ref = new ProviderRefusalError("this account cannot take USD");
    expect(ind).toBeInstanceOf(Error);
    expect(ind.name).toBe("ProviderIndeterminateError");
    // ⚠️ MUTATION TARGET: make either class extend the other, or reuse one name for
    // both, and the routes below can no longer answer them differently — the whole
    // point of the split.
    expect(ind).not.toBeInstanceOf(ProviderRefusalError);
    expect(ref).not.toBeInstanceOf(ProviderIndeterminateError);
    expect(ref.name).toBe("ProviderRefusalError");
  });
});

describe("#42 · badGateway is the 502 half of the pair", () => {
  it("answers 502 with a gateway_error the caller is told to retry", () => {
    const { reply, seen } = fakeReply();
    badGateway(reply, "We could not confirm whether the hold was released");
    expect(seen.status).toBe(502);
    expect(errorBody(seen.body)).toEqual({
      type: "gateway_error",
      message: "We could not confirm whether the hold was released",
      retriable: true,
    });
  });

  it("…while a validation refusal stays a 400 invalid_request_error", () => {
    // The neighbour, asserted here so a mutation that renames either envelope type or
    // swaps the two status codes cannot pass by editing one of them consistently.
    const { reply, seen } = fakeReply();
    badRequest(reply, 'Use methodTypes: ["card"]');
    expect(seen.status).toBe(400);
    expect(errorBody(seen.body).type).toBe("invalid_request_error");
    expect(errorBody(seen.body)).not.toHaveProperty("retriable");
  });

  it("…and a conflict stays a 409 conflict_error", () => {
    const { reply, seen } = fakeReply();
    conflict(reply, "already in flight");
    expect(seen.status).toBe(409);
    expect(errorBody(seen.body).type).toBe("conflict_error");
  });
});
