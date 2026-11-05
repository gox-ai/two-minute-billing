/**
 * TOTP (RFC 6238) — the second factor's arithmetic, and nothing else (audit M3).
 *
 * ── WHY NOT A THIRD-PARTY PACKAGE ───────────────────────────────────────────────
 * TOTP is an HMAC, a truncation and a modulo. The published implementations are a few dozen
 * lines each, and adding one puts a supply-chain surface directly on the login path of a
 * billing system. This file imports nothing but `node:crypto`, is covered by `verify:auth`,
 * and is checked against RFC 6238's own published test vectors — a stronger guarantee than a
 * download count.
 *
 * ── SHA-1, DELIBERATELY ─────────────────────────────────────────────────────────
 * RFC 6238 permits SHA-256, and every authenticator app in practice implements SHA-1 only. A
 * "stronger" choice here produces codes that Google Authenticator and 1Password silently
 * reject, which is a support incident rather than a security gain. HMAC-SHA1's collision
 * weakness is irrelevant to a 6-digit code derived from a 30-second counter.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Seconds per code. 30 is what every authenticator app assumes. */
export const TOTP_PERIOD = 30;
/** Digits in a code. 6 is what every authenticator app assumes. */
export const TOTP_DIGITS = 6;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding — the encoding an otpauth URI expects. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226): HMAC-SHA1 over the counter, dynamically truncated to `digits`. */
function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  // Big-endian 64-bit, written as two 32-bit halves because a JS number cannot hold 64 bits
  // exactly. At 30-second steps the high half stays 0 until the year 10 000, but writing it
  // correctly costs one line and removes the question.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** The code for `at` (default now). */
export function totp(secretBase32: string, at: Date = new Date()): string {
  return hotp(base32Decode(secretBase32), Math.floor(at.getTime() / 1000 / TOTP_PERIOD));
}

/**
 * Verify a code, tolerating clock skew of `window` steps either side (default 1 = ±30s).
 *
 * Compared with `timingSafeEqual`: the codes are short and low-entropy, so a timing oracle
 * leaking a prefix meaningfully shrinks a 10^6 space. Callers MUST also rate-limit — six
 * digits fall to brute force in minutes otherwise, which is why `login()` counts a failed code
 * toward the same lockout a wrong password uses.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { at?: Date; window?: number } = {},
): boolean {
  return matchTotpStep(secretBase32, code, opts) !== null;
}

/**
 * The time step `code` is valid for, or null. Callers that accept a code for sign-in record
 * this step and refuse any step at or before it, so a code works once.
 */
export function matchTotpStep(
  secretBase32: string,
  code: string,
  opts: { at?: Date; window?: number } = {},
): number | null {
  const candidate = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(candidate)) return null;
  const at = opts.at ?? new Date();
  const window = opts.window ?? 1;
  const key = base32Decode(secretBase32);
  const step = Math.floor(at.getTime() / 1000 / TOTP_PERIOD);
  const given = Buffer.from(candidate);
  for (let drift = -window; drift <= window; drift++) {
    const expected = Buffer.from(hotp(key, step + drift));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return step + drift;
  }
  return null;
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * `issuer` appears twice — as a label prefix and as a parameter — because different apps read
 * different ones, and omitting either produces an entry labelled only with an email address,
 * which is unhelpful the moment someone has two accounts.
 */
export function otpauthUri(input: {
  secretBase32: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
