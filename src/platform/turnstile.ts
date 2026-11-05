/**
 * Cloudflare Turnstile verification (audit M3.2, standard §3.1 step 2 / §7.1).
 *
 * A bot challenge on the credential routes an automated caller actually targets. `signup` is
 * closed by default now (H2), so the remaining surface is `forgot_password` — which is
 * deliberately unauthenticated, deliberately answers identically whatever it is sent, and
 * therefore has nothing but a rate limit standing between it and a script mailing every
 * address someone owns.
 *
 * ── THREE STATES, AND THE MIDDLE ONE IS THE POINT ───────────────────────────────
 *   not configured  → SKIP. There is no secret to verify against, and refusing every caller
 *                     because an optional control is unconfigured would be an outage.
 *   configured, ok  → enforce the verdict.
 *   configured, but the verifier is UNREACHABLE → REFUSE.
 *
 * That last one is the opposite of the choice made for HIBP in `password-policy.ts`, and the
 * asymmetry is deliberate. A breach check failing open costs a slightly weaker password; a bot
 * challenge failing open hands an attacker the exact thing they wanted — an unchallenged
 * endpoint — and "make the verifier unreachable" is a cheaper attack than solving the
 * challenge. Fail-open here would be a control that switches itself off under pressure.
 */
import { config } from "./config";
import { createLogger } from "./logger";

const log = createLogger("turnstile");

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileOutcome = "skipped" | "passed" | "failed" | "unavailable";

export interface TurnstileOptions {
  /**
   * Override the network call. Exists so the branches are testable without reaching
   * Cloudflare — a suite that does is slow, flaky and fails offline, the same reasoning as
   * the injectable breach lookup in `password-policy.ts`.
   */
  verifier?: (token: string, ip: string | null) => Promise<boolean>;
  /** Force enablement on or off, ignoring config. For tests. */
  enabled?: boolean;
}

async function cloudflareVerify(token: string, ip: string | null): Promise<boolean> {
  const body = new URLSearchParams({ secret: config.TURNSTILE_SECRET_KEY ?? "", response: token });
  if (ip) body.set("remoteip", ip);
  const res = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`turnstile responded ${res.status}`);
  const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
  if (!json.success) {
    // The codes name WHY (expired token, duplicate submission, bad secret) and none of them
    // contain anything private, so they are worth having when a real user reports a loop.
    log.info("turnstile rejected a token", { codes: json["error-codes"] ?? [] });
  }
  return json.success === true;
}

/**
 * Verify a Turnstile token. Never throws — the caller gets an outcome to act on.
 *
 * `unavailable` is distinct from `failed` on purpose: one is "we could not ask", the other is
 * "the answer was no". They deserve different log lines even though both refuse.
 */
export async function verifyTurnstile(
  token: string | undefined | null,
  ip: string | null,
  opts: TurnstileOptions = {},
): Promise<TurnstileOutcome> {
  const enabled = opts.enabled ?? !!config.TURNSTILE_SECRET_KEY;
  if (!enabled) return "skipped";
  if (!token) return "failed";
  try {
    return (await (opts.verifier ?? cloudflareVerify)(token, ip)) ? "passed" : "failed";
  } catch (e) {
    log.error(e, { event: "turnstile_unavailable", detail: "refusing — see the header note" });
    return "unavailable";
  }
}

/** Whether an outcome should stop the request. `skipped` and `passed` proceed. */
export const turnstileRefuses = (o: TurnstileOutcome) => o === "failed" || o === "unavailable";
