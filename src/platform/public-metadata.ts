/**
 * Metadata keys the engine writes for its own use and never returns from the API.
 * `source_payload` is the raw record an import read; it stays stored for import audits.
 */
const INTERNAL_METADATA_KEYS = ["source_payload"] as const;

/** The caller-visible copy of a metadata bag: internal keys removed, null kept null. */
export function publicMetadata(md: unknown): Record<string, unknown> | null {
  if (md == null) return null;
  if (typeof md !== "object" || Array.isArray(md)) return md as Record<string, unknown>;
  const src = md as Record<string, unknown>;
  if (!INTERNAL_METADATA_KEYS.some((k) => k in src)) return src;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!(INTERNAL_METADATA_KEYS as readonly string[]).includes(k)) out[k] = v;
  }
  return out;
}
