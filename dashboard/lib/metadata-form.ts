import { z } from "zod";

/** The API's `metadataField` bounds (src/api/limits.ts). */
const MAX_KEYS = 50;
const MAX_KEY_LENGTH = 64;
const MAX_SERIALIZED = 16_000;

export type MetadataCheck =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; error: string };

/**
 * A metadata textarea's text → the value to store; blank → null (clears it).
 * Mirrors every rule the API enforces, so a bad value is caught next to the field
 * instead of as a 400 after the round trip.
 */
export function checkMetadata(raw: string | null | undefined): MetadataCheck {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: 'Metadata must be a JSON object, for example {"tier":"gold"}.' };
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > MAX_KEYS) {
    return { ok: false, error: `Metadata is limited to ${MAX_KEYS} keys. It has ${keys.length}.` };
  }
  const long = keys.find((k) => k.length > MAX_KEY_LENGTH);
  if (long !== undefined) {
    return {
      ok: false,
      error: `Metadata keys are limited to ${MAX_KEY_LENGTH} characters ("${long.slice(0, 20)}…").`,
    };
  }
  if (JSON.stringify(obj).length > MAX_SERIALIZED) {
    return { ok: false, error: "Metadata is limited to 16KB." };
  }
  return { ok: true, value: obj };
}

/**
 * `checkMetadata` as a zod field, for actions that parse with a schema.
 * Checked in the browser too, but a posted string is not a trusted input.
 */
export const metadataFromForm = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    const r = checkMetadata(raw);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.error });
      return z.NEVER;
    }
    return r.value;
  });
