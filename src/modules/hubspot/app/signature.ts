import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** HubSpot rejects its own requests older than this; so do we. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/**
 * HubSpot signs the URI with these characters decoded (and no others), so the
 * URI we rebuild from the request must decode the same set before hashing.
 */
const DECODE: Record<string, string> = {
  "%3A": ":",
  "%2F": "/",
  "%3F": "?",
  "%40": "@",
  "%21": "!",
  "%24": "$",
  "%27": "'",
  "%28": "(",
  "%29": ")",
  "%2A": "*",
  "%2C": ",",
  "%3B": ";",
};

export function normalizeSignedUri(uri: string): string {
  return uri.replace(
    /%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi,
    (m) => DECODE[m.toUpperCase()] ?? m,
  );
}

export function signV3(input: {
  secret: string;
  method: string;
  uri: string;
  body: string;
  timestamp: string;
}): string {
  const base = `${input.method.toUpperCase()}${normalizeSignedUri(input.uri)}${input.body}${input.timestamp}`;
  return createHmac("sha256", input.secret).update(base, "utf8").digest("base64");
}

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

/**
 * `X-HubSpot-Signature-v3`: base64 HMAC-SHA256, keyed by the app's client secret, over
 * method + full URI + raw body + `X-HubSpot-Request-Timestamp`. `uris` lists every URI the
 * request may have been addressed to (public base vs. the host we saw behind a proxy).
 */
export function verifySignatureV3(input: {
  secret: string | undefined;
  method: string;
  uris: string[];
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  now?: number;
}): SignatureVerdict {
  if (!input.secret) return { ok: false, reason: "HubSpot is not configured on this deployment" };
  if (!input.signature || !input.timestamp)
    return { ok: false, reason: "Missing HubSpot signature" };
  const ts = Number(input.timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SIGNATURE_AGE_MS)
    return { ok: false, reason: "Stale HubSpot request timestamp" };
  const given = Buffer.from(input.signature, "utf8");
  for (const uri of new Set(input.uris)) {
    const expected = Buffer.from(
      signV3({
        secret: input.secret,
        method: input.method,
        uri,
        body: input.body,
        timestamp: input.timestamp,
      }),
      "utf8",
    );
    if (expected.length === given.length && timingSafeEqual(expected, given)) return { ok: true };
  }
  return { ok: false, reason: "Invalid HubSpot signature" };
}

/**
 * `X-HubSpot-Signature` v2: hex SHA-256 of client secret + method + URI + raw body. HubSpot
 * still signs workflow-action calls this way. No timestamp, so a replay verifies — callers
 * must be idempotent (workflow actions are, on `callbackId`).
 */
export function verifySignatureV2(input: {
  secret: string | undefined;
  method: string;
  uris: string[];
  body: string;
  signature: string | undefined;
}): SignatureVerdict {
  if (!input.secret) return { ok: false, reason: "HubSpot is not configured on this deployment" };
  if (!input.signature) return { ok: false, reason: "Missing HubSpot signature" };
  const given = Buffer.from(input.signature.toLowerCase(), "utf8");
  for (const uri of new Set(input.uris)) {
    const expected = Buffer.from(
      createHash("sha256")
        .update(`${input.secret}${input.method.toUpperCase()}${uri}${input.body}`, "utf8")
        .digest("hex"),
      "utf8",
    );
    if (expected.length === given.length && timingSafeEqual(expected, given)) return { ok: true };
  }
  return { ok: false, reason: "Invalid HubSpot signature" };
}

/** v3 whenever it is present; v2 only where the caller allows it (workflow actions). */
export function verifyHubSpotRequest(input: {
  secret: string | undefined;
  method: string;
  uris: string[];
  body: string;
  headers: Record<string, string | string[] | undefined>;
  allowV2: boolean;
  now?: number;
}): SignatureVerdict {
  const h = (k: string) => {
    const v = input.headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const v3 = h("x-hubspot-signature-v3");
  if (v3 || !input.allowV2)
    return verifySignatureV3({
      ...input,
      signature: v3,
      timestamp: h("x-hubspot-request-timestamp"),
    });
  if ((h("x-hubspot-signature-version") ?? "v2").toLowerCase() !== "v2")
    return { ok: false, reason: "Unsupported HubSpot signature version" };
  return verifySignatureV2({ ...input, signature: h("x-hubspot-signature") });
}
