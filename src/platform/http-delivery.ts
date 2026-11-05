import { describeEgressError, EgressRefusedError, guardedFetch } from "./egress";

/**
 * The HTTP half of an outbox delivery, shared by the webhook outbox and the integrations
 * outbox: retry ladder, one bounded POST, and the clipping rules for what an operator sees.
 * Each outbox owns its table, its claim and how it settles a row; nothing here touches a row.
 */

// The published webhook reference states both numbers; it reads them from here.
export const MAX_DELIVERY_ATTEMPTS = 6;
/** Backoff (seconds) before each retry of a failed delivery. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];

/** How much of a body a transcript carries back to the operator screen. Truncation is marked. */
const MAX_TRANSCRIPT_BYTES = 16_384;

export function clip(s: string): string {
  if (s.length <= MAX_TRANSCRIPT_BYTES) return s;
  return `${s.slice(0, MAX_TRANSCRIPT_BYTES)}\n\n… truncated at ${MAX_TRANSCRIPT_BYTES} characters`;
}

/** How much of a refusal `last_error` keeps — enough for a partner's error message. */
const MAX_ERROR_CHARS = 1_000;

/** First `MAX_ERROR_CHARS` of a body, read from the stream and cancelled: a 40MB page costs KBs. */
async function readErrorHead(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < MAX_ERROR_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/** What `last_error` stores: trimmed, clipped, and null when there is nothing to say. */
export function errorText(s: string | null): string | null {
  const t = s?.trim();
  if (!t) return null;
  return t.length > MAX_ERROR_CHARS ? `${t.slice(0, MAX_ERROR_CHARS)}…` : t;
}

/** Scheme + host + port — the circuit-breaker key. Null for a URL that will not parse. */
export function requestOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Seconds to wait after the `attempts`-th failed attempt. */
export function backoffSeconds(attempts: number): number {
  return BACKOFF_SECONDS[attempts - 1] ?? 21600;
}

/**
 * What one attempt sent and got back. Never persisted: only a synchronous Resend shows it.
 * Headers are already masked by whoever built the request.
 */
export interface DeliveryTranscript {
  request: { method: "POST"; url: string; headers: Record<string, string>; body: string };
  /** Null when the request never got an HTTP response — see `error`. */
  response: { status: number; headers: Record<string, string>; body: string } | null;
  /** Why there was no response (DNS, refused, reset, timeout). Null when one arrived. */
  error: string | null;
  latencyMs: number;
  /** `skipped`: the event carried nothing to send, so no request was made. */
  outcome: "delivered" | "failed" | "retrying" | "not_attempted" | "skipped";
  /** The attempt count AFTER this attempt. */
  attempts: number;
}

export interface PostResult {
  /** 0 when the fetch threw (DNS, refused, reset, timeout) — the breaker's transport-fault signal. */
  status: number;
  headers: Record<string, string> | null;
  /** The whole (clipped) body when `capture`, else the head of a non-2xx body, else "". */
  body: string;
  /** A fixed sentence we may store and show: the network failure, or a redirect we refused. */
  error: string | null;
  /** The target is private or reserved: no request was made, and every retry is refused too. */
  refused: boolean;
  /** The raw network error, for the log only (it may carry an address or an OS message). */
  cause: { message?: string; code?: string } | null;
  latencyMs: number;
}

/**
 * One POST through `guardedFetch` (private-target guard, no redirects followed). `capture` reads the whole body for a live
 * transcript; the clock never does, so a huge error page costs it a few KB, not the page.
 */
export async function postOnce(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  capture: boolean;
}): Promise<PostResult> {
  const startedAt = Date.now();
  let status = 0;
  let headers: Record<string, string> | null = null;
  let body = "";
  let error: string | null = null;
  let refused = false;
  let cause: PostResult["cause"] = null;
  try {
    const res = await guardedFetch(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      // Floored at 1s: a deadline already passed would abort instantly and burn an attempt.
      signal: AbortSignal.timeout(Math.max(1_000, input.timeoutMs)),
    });
    status = res.status;
    headers = Object.fromEntries(res.headers);
    if (res.status >= 300 && res.status < 400) {
      error = `The endpoint answered ${res.status} (a redirect). We do not follow redirects. Set the endpoint URL to the final address`;
    }
    try {
      if (input.capture) body = clip(await res.text());
      else if (res.status < 200 || res.status >= 300) body = await readErrorHead(res);
      // Unread, the body would hold the socket open.
      else await res.body?.cancel().catch(() => {});
    } catch {
      // The status already says the host answered; an unreadable body must not undo that.
      body = "";
    }
  } catch (e) {
    status = 0; // network error / timeout / refused target
    refused = e instanceof EgressRefusedError;
    // A fixed sentence, not the raw error: an address, port or OS message is for the log only.
    error = describeEgressError(e);
    cause = { message: (e as Error)?.message, code: (e as { code?: string })?.code };
  }
  return { status, headers, body, error, refused, cause, latencyMs: Date.now() - startedAt };
}
