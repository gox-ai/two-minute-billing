import { isDeepStrictEqual } from "node:util";

/**
 * The part of `patch` that would actually change `current`.
 *
 * Update paths use it to tell a real edit from a re-save of the same values: an empty
 * result means no write, no audit row and no changed event. Comparison is deep and
 * ignores object key order, so a jsonb value read back from Postgres equals the same
 * object sent by a client.
 */
export function effectivePatch<T extends Record<string, unknown>>(
  patch: Partial<T>,
  current: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (!isDeepStrictEqual(patch[key] ?? null, current[key] ?? null)) out[key] = patch[key];
  }
  return out;
}
