import { maskPans } from "@/platform/logger";

/**
 * Redaction for stored request-log bodies and query strings. Three layers; the third runs on
 * every string whatever its key:
 *  1. per route: a route that returns a one-time secret never has its response stored
 *     (`capture.ts`, `idempotentNoStore` or `requestLog: "no_response"`);
 *  2. key names (split into words);
 *  3. value shapes: our own credential prefixes, bearer tokens, JWTs, Luhn-valid card numbers.
 * Names, emails and addresses are kept (tenant data under RLS, erased with the customer).
 */

export const MASK = "****";

/** A key whose value is masked when ANY of its words is one of these. */
const SECRET_WORDS = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "credential",
  "signature",
  "authorization",
  "cookie",
  "cvv",
  "cvc",
  "pin",
  "otp",
  "iban",
  "ssn",
  "salt",
  "hmac",
]);

/** …or when two adjacent words are one of these pairs. */
const SECRET_PAIRS = new Set([
  "api key",
  "private key",
  "access key",
  "secret key",
  "signing key",
  "signature key",
  "transaction key",
  "hmac key",
  "merchant key",
  "client key",
  "card number",
  "account number",
  "routing number",
  "recovery code",
  "recovery codes",
]);

/** Everything under these keys is masked leaf by leaf: gateway credential sets carry
 *  vendor-specific secret names no word list can keep up with. */
const OPAQUE_KEYS = new Set(["credentials"]);

/** `secretAccessKey` → [secret, access, key]; `api-key` → [api, key]. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function isSecretKey(key: string): boolean {
  const words = keyWords(key);
  for (let i = 0; i < words.length; i++) {
    if (SECRET_WORDS.has(words[i]!)) return true;
    if (i > 0 && SECRET_PAIRS.has(`${words[i - 1]} ${words[i]}`)) return true;
  }
  return false;
}

// Our own credentials, by prefix. Stripe-style secret keys share the `sk_live_` shape.
const OWN_TOKEN_RE =
  /\b(sk_(?:test|live|all|sbox)_|whsec_|pstk_|psst_|cstk_|sess_|invt_|prst_|mfas_|mfac_)[A-Za-z0-9_-]{16,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;

/** Mask secret-shaped substrings, wherever they sit in the string. */
export function redactString(value: string): string {
  let out = value.replace(OWN_TOKEN_RE, (_m, prefix: string) => `${prefix}${MASK}`);
  out = out.replace(BEARER_RE, `Bearer ${MASK}`);
  out = out.replace(JWT_RE, MASK);
  return maskPans(out);
}

/** Every scalar leaf masked, structure kept. */
function maskAll(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskAll);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskAll(v);
    return out;
  }
  return value === null || typeof value === "boolean" ? value : MASK;
}

/**
 * Deep copy with secrets masked. A plain object under a secret key is recursed (its own keys
 * decide); an array or scalar under one is blanked, since an array element has no key to judge.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[omitted: too deep]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (OPAQUE_KEYS.has(k.toLowerCase())) out[k] = maskAll(v);
      else if (isSecretKey(k)) {
        const plain = v !== null && typeof v === "object" && !Array.isArray(v);
        // A boolean (`secret_configured`) says whether, never what.
        out[k] = plain
          ? redactValue(v, depth + 1)
          : v === null || typeof v === "boolean"
            ? v
            : MASK;
      } else out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** `a=1&token=x` → `a=1&token=****`. Keys judged like body keys, values by shape. */
export function redactQuery(query: string): string {
  if (!query) return query;
  const params = new URLSearchParams(query);
  const out: string[] = [];
  for (const [k, v] of params) {
    const bare = k.replace(/\[.*$/, "");
    const value = isSecretKey(bare) || OPAQUE_KEYS.has(bare.toLowerCase()) ? MASK : redactString(v);
    out.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
  }
  return out.join("&");
}

// ── Size caps, applied after redaction ──────────────────────────────────────

export const MAX_LEAF_CHARS = 2_048;
export const MAX_BODY_BYTES = 32 * 1024;
const PREVIEW_CHARS = 2_048;

function capLeaves(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > MAX_LEAF_CHARS ? `[omitted: ${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(capLeaves);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capLeaves(v);
    return out;
  }
  return value;
}

/** Long string leaves become a marker; a body still over 32 KB keeps a 2 KB preview. */
export function capBody(value: unknown): unknown {
  const capped = capLeaves(value);
  const text = JSON.stringify(capped);
  if (text === undefined) return null;
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_BODY_BYTES) return capped;
  return { _truncated: true, bytes, preview: text.slice(0, PREVIEW_CHARS) };
}

/** Redact then cap: what is stored. */
export function storedBody(value: unknown): unknown {
  if (value === undefined) return null;
  return capBody(redactValue(value));
}
