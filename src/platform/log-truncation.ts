/**
 * Payload-size control for log entries, ported from tmr_data_service
 * (`src/configs/log-truncation.ts`) with two tmbilling-specific changes: BigInt is
 * serializable here (money is `bigint`), and the limits are expressed against
 * Google Cloud Logging's entry cap, which is the sink that actually rejects.
 *
 * Why any of this exists: Cloud Logging rejects a LogEntry over 256KB, and a
 * rejected entry is a log line you don't have when you need it most — the
 * oversized ones are almost always the failing provider response you were trying
 * to read. Truncating loudly (with `_wasTruncated` + the original size) always
 * beats dropping silently.
 */

/**
 * Circular-ref-safe JSON stringify. Replaces already-visited objects with
 * "[Circular]" instead of throwing, and renders `bigint` as `123n` (money in this
 * codebase is bigint minor units, and `JSON.stringify` throws on it outright).
 * Never throws — safe to call on anything a `catch` block hands us.
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(value, (_key, v) => {
        if (typeof v === 'bigint') return `${v}n`
        if (v && typeof v === 'object') {
          if (seen.has(v as object)) return '[Circular]'
          seen.add(v as object)
        }
        return v
      }) ?? String(value)
    )
  } catch {
    return '(unserializable)'
  }
}

/**
 * UTF-8 byte size, measured the way the sink counts it. Uses plain
 * `JSON.stringify` (which counts shared references independently, as GCP's
 * protobuf serializer does) and only falls back to `safeStringify` when the value
 * is circular or holds a bigint — `safeStringify` de-duplicates shared refs and
 * would under-measure.
 */
export function getSizeKB(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') / 1024
  } catch {
    return Buffer.byteLength(safeStringify(value), 'utf8') / 1024
  }
}

interface TruncateLimits {
  arrayLimit: number
  stringLimit: number
  depthLimit: number
  objectKeyLimit: number
}

const NORMAL_LIMITS: TruncateLimits = { arrayLimit: 5, stringLimit: 1000, depthLimit: 4, objectKeyLimit: 50 }
const AGGRESSIVE_LIMITS: TruncateLimits = { arrayLimit: 3, stringLimit: 500, depthLimit: 3, objectKeyLimit: 20 }

/**
 * Single-pass recursive truncation: the walk builds new objects/arrays as it
 * goes, so it is a selective clone and a truncation at once — no deep clone, and
 * no per-field `JSON.stringify` (decisions are structural: array length, string
 * length, depth, key count).
 */
function truncateRecursive(value: unknown, depth: number, limits: TruncateLimits): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return `${value}n`

  if (Array.isArray(value)) {
    if (value.length > limits.arrayLimit) {
      const kept: unknown[] = value.slice(0, limits.arrayLimit).map((el) => truncateRecursive(el, depth + 1, limits))
      kept.push({ _truncated: true, totalCount: value.length, hiddenCount: value.length - limits.arrayLimit })
      return kept
    }
    return value.map((el) => truncateRecursive(el, depth + 1, limits))
  }

  if (typeof value === 'string') {
    return value.length > limits.stringLimit
      ? `${value.slice(0, limits.stringLimit)} ...[truncated from ${value.length} chars]`
      : value
  }

  if (typeof value === 'object') {
    // Dates serialize to a short ISO string — walking their (empty) entries would
    // turn a legible timestamp into `{}`.
    if (value instanceof Date) return value.toISOString()
    const entries = Object.entries(value as Record<string, unknown>)
    if (depth >= limits.depthLimit) {
      return { _summary: true, keyCount: entries.length, keys: entries.slice(0, 20).map(([k]) => k) }
    }
    const result: Record<string, unknown> = {}
    const kept = entries.length > limits.objectKeyLimit ? entries.slice(0, limits.objectKeyLimit) : entries
    for (const [k, v] of kept) result[k] = truncateRecursive(v, depth + 1, limits)
    if (entries.length > limits.objectKeyLimit) {
      result._truncated = true
      result._totalKeyCount = entries.length
      result._hiddenKeyCount = entries.length - limits.objectKeyLimit
    }
    return result
  }

  return value
}

const SUMMARY_STRING_LIMIT = 200

function summarizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'string') {
    return value.length > SUMMARY_STRING_LIMIT
      ? `${value.slice(0, SUMMARY_STRING_LIMIT)} ...[truncated from ${value.length} chars]`
      : value
  }
  if (Array.isArray(value)) return { _type: 'array', _length: value.length }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return { _type: 'object', _keyCount: keys.length, _keys: keys.slice(0, 20) }
  }
  return value
}

/**
 * Safety net: keep the top-level scalars (message, service, traceId — the fields
 * that make the line findable at all) and collapse every nested value to a
 * one-line structural summary. Always produces something tiny.
 */
function forceTopLevelSummary(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return summarizeValue(payload)
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) result[k] = summarizeValue(v)
  return result
}

export interface TruncatedPayload extends Record<string, unknown> {
  _wasTruncated: true
  _truncationMode: 'normal' | 'aggressive' | 'structural-summary'
  _originalSizeKB: number
  _truncatedSizeKB: number
}

/**
 * Truncate a log payload with escalating strategies, stamping what it did:
 *
 *   pass 1 `normal`             arrays→5, strings→1000, depth→4, keys→50
 *   pass 2 `aggressive`         arrays→3, strings→500,  depth→3, keys→20
 *   pass 3 `structural-summary` top-level scalars kept, everything else summarized
 *
 * Returns the payload untouched when it is already under budget.
 *
 * @param knownSizeKB the caller's own measurement, to skip re-measuring.
 */
export function truncateLogPayload(
  payload: Record<string, unknown>,
  maxSizeKB = 155,
  knownSizeKB?: number,
): Record<string, unknown> {
  const originalSizeKB = knownSizeKB ?? getSizeKB(payload)
  if (originalSizeKB <= maxSizeKB) return payload

  let result = truncateRecursive(payload, 0, NORMAL_LIMITS) as Record<string, unknown>
  let truncatedSizeKB = getSizeKB(result)
  let truncationMode: TruncatedPayload['_truncationMode'] = 'normal'

  if (truncatedSizeKB > maxSizeKB) {
    result = truncateRecursive(result, 0, AGGRESSIVE_LIMITS) as Record<string, unknown>
    truncatedSizeKB = getSizeKB(result)
    truncationMode = 'aggressive'
  }

  if (truncatedSizeKB > maxSizeKB) {
    result = forceTopLevelSummary(result) as Record<string, unknown>
    truncatedSizeKB = getSizeKB(result)
    truncationMode = 'structural-summary'
  }

  result._wasTruncated = true
  result._truncationMode = truncationMode
  result._originalSizeKB = parseFloat(originalSizeKB.toFixed(2))
  result._truncatedSizeKB = parseFloat(truncatedSizeKB.toFixed(2))
  return result
}
