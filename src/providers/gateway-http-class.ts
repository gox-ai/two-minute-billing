/**
 * How an adapter reads a gateway's HTTP answer on a call that can create money (a charge, a
 * capture, a refund). One rule for every adapter:
 *  - 2xx (any status below 400): an answer — read the body.
 *  - 408, 409, 5xx and network errors: the request may have been processed. Retry with the
 *    SAME idempotency key; when the retries run out, throw `ProviderIndeterminateError`.
 *  - 429: back off for `Retry-After` and retry with the same key. When the retries run out it
 *    stays indeterminate, unless the gateway documents that a 429 created nothing
 *    (`rateLimitCreatesNothing`) — then it is a definite, retriable failure.
 *  - any other 4xx: definite — the gateway created nothing. On a refund, throw
 *    `ProviderRefusalError` so the engine releases the reservation.
 */
export type GatewayHttpClass =
  | { kind: "answer" }
  | {
      kind: "retry_same_key";
      reason: "network" | "timeout" | "conflict" | "server" | "rate_limited";
      /** The wait the gateway asked for, when it sent `Retry-After`. */
      retryAfterMs: number | null;
      /** What the call is once retries are exhausted. */
      whenExhausted: "indeterminate" | "definite";
    }
  | { kind: "definite" };

export function classifyGatewayHttp(input: {
  /** The HTTP status; absent when no response arrived. */
  status?: number | null;
  /** The `Retry-After` header: seconds, or an HTTP date. */
  retryAfter?: string | number | null;
  /** The request failed before a response (timeout, reset, DNS). */
  networkError?: boolean;
  /** The gateway documents that a 429 created nothing. Default false. */
  rateLimitCreatesNothing?: boolean;
  now?: Date;
}): GatewayHttpClass {
  const retryAfterMs = parseRetryAfter(input.retryAfter, input.now ?? new Date());
  const retry = (reason: Extract<GatewayHttpClass, { kind: "retry_same_key" }>["reason"]) => ({
    kind: "retry_same_key" as const,
    reason,
    retryAfterMs,
    whenExhausted: "indeterminate" as const,
  });
  const status = input.status;
  if (input.networkError || status == null || !Number.isFinite(status)) return retry("network");
  if (status < 400) return { kind: "answer" };
  if (status === 408) return retry("timeout");
  if (status === 409) return retry("conflict");
  if (status === 429)
    return {
      ...retry("rate_limited"),
      whenExhausted: input.rateLimitCreatesNothing ? "definite" : "indeterminate",
    };
  if (status >= 500) return retry("server");
  return { kind: "definite" };
}

/** `Retry-After` in milliseconds (never negative), or null when absent or unreadable. */
export function parseRetryAfter(
  value: string | number | null | undefined,
  now: Date = new Date(),
): number | null {
  if (value == null || value === "") return null;
  const seconds = typeof value === "number" ? value : Number(String(value).trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(String(value));
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}
