import { describe, it, expect } from "vitest";
import { classifyGatewayHttp, parseRetryAfter } from "@/providers/gateway-http-class";

const now = new Date("2026-10-26T12:00:00Z");

describe("classifyGatewayHttp", () => {
  it("reads a 2xx as an answer", () => {
    expect(classifyGatewayHttp({ status: 200 })).toEqual({ kind: "answer" });
    expect(classifyGatewayHttp({ status: 201 })).toEqual({ kind: "answer" });
  });

  it.each([
    [408, "timeout"],
    [409, "conflict"],
    [500, "server"],
    [502, "server"],
    [503, "server"],
    [504, "server"],
  ] as const)("%i: retry with the same key, then indeterminate", (status, reason) => {
    expect(classifyGatewayHttp({ status })).toEqual({
      kind: "retry_same_key",
      reason,
      retryAfterMs: null,
      whenExhausted: "indeterminate",
    });
  });

  it("a network error (or no status) is indeterminate, never definite", () => {
    for (const c of [
      { networkError: true },
      { status: null },
      {},
      { status: 200, networkError: true },
    ])
      expect(classifyGatewayHttp(c)).toMatchObject({
        kind: "retry_same_key",
        reason: "network",
        whenExhausted: "indeterminate",
      });
  });

  it("429 backs off by Retry-After and stays indeterminate by default", () => {
    expect(classifyGatewayHttp({ status: 429, retryAfter: "7", now })).toEqual({
      kind: "retry_same_key",
      reason: "rate_limited",
      retryAfterMs: 7000,
      whenExhausted: "indeterminate",
    });
  });

  it("429 is definite once exhausted only when the gateway documents it created nothing", () => {
    expect(classifyGatewayHttp({ status: 429, rateLimitCreatesNothing: true })).toMatchObject({
      kind: "retry_same_key",
      whenExhausted: "definite",
    });
  });

  it("a 503 with Retry-After carries the wait too", () => {
    expect(classifyGatewayHttp({ status: 503, retryAfter: 2, now })).toMatchObject({
      reason: "server",
      retryAfterMs: 2000,
    });
  });

  it.each([400, 401, 402, 403, 404, 410, 422])("%i is definite: nothing was created", (status) => {
    expect(classifyGatewayHttp({ status })).toEqual({ kind: "definite" });
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter(1.5, now)).toBe(1500);
  });
  it("reads an HTTP date relative to now", () => {
    expect(parseRetryAfter("Mon, 26 Oct 2026 12:00:05 GMT", now)).toBe(5000);
  });
  it("never goes negative", () => {
    expect(parseRetryAfter("-3", now)).toBe(0);
    expect(parseRetryAfter("Mon, 26 Oct 2026 11:00:00 GMT", now)).toBe(0);
  });
  it("is null when absent or unreadable", () => {
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});
