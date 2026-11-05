import { createHash } from "node:crypto";

/**
 * A gateway-legal reference derived from one of our keys, for gateways that cap length or
 * alphabet (PayU txnid ≤25, Authorize.net refId ≤20, PhonePe ≤63 `[A-Za-z0-9_-]`, Adyen
 * UPI references alphanumeric only).
 *
 * Deterministic, so a retry under the same idempotency key sends the same reference and
 * the gateway's own uniqueness check dedupes it. A key that already fits is kept as is,
 * so the reference stays readable in the gateway's dashboard. One-way: store the mapping
 * on the attempt if it must be read back.
 */
export function shortReference(
  key: string,
  opts: { maxLength: number; alphanumericOnly?: boolean; prefix?: string },
): string {
  const prefix = opts.prefix ?? "";
  const legal = opts.alphanumericOnly ? /^[A-Za-z0-9]+$/ : /^[A-Za-z0-9_-]+$/;
  const whole = `${prefix}${key}`;
  if (whole.length <= opts.maxLength && legal.test(whole)) return whole;
  const room = opts.maxLength - prefix.length;
  if (room < 12) throw new Error(`shortReference: ${opts.maxLength} leaves no room after prefix`);
  // Base-36 SHA-256: alphanumeric, ~5.2 bits per char, so 12+ chars is ≥62 bits.
  const digest = BigInt(`0x${createHash("sha256").update(key).digest("hex")}`).toString(36);
  return `${prefix}${digest.slice(0, room)}`;
}
