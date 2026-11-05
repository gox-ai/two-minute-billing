import { createHash } from "node:crypto";
import type { NormalizeWebhookInput } from "./types";

/**
 * The id an inbound webhook delivery is deduped by: the first non-empty candidate (the
 * gateway's own event id, which it keeps across retries), else a hash of the exact body.
 *
 * Never derive it from the event's name and timestamp. Two different payments captured in
 * the same second share both, and the second one is then dropped as a "duplicate".
 */
export function webhookEventId(candidates: readonly unknown[], rawBody: string | Buffer): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
}

/** One header's value, case-insensitively; the first of a repeated header. */
export function headerValue(
  headers: NormalizeWebhookInput["headers"],
  name: string,
): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** The body's top-level `id`, or undefined when the body is not a JSON object. */
export function bodyId(rawBody: string | Buffer): unknown {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString());
    return parsed && typeof parsed === "object" ? (parsed as { id?: unknown }).id : undefined;
  } catch {
    return undefined;
  }
}
