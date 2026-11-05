/**
 * Signing for TM Test Gateway async webhooks (C4). The gateway signs each
 * outbound payload; our inbound route (C8) verifies it — exercising the real
 * signature-verification path a live gateway would. Both sides derive the same
 * HMAC key from config so no secret needs provisioning for the in-process gateway.
 *
 * Signatures are computed over a CANONICAL serialization (recursively
 * key-sorted JSON) so they survive a round-trip through the `jsonb` payload
 * column (which does not preserve key order/whitespace).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '@/platform/config'

function key(): string {
  return `tmtest:${config.GATEWAY_CREDENTIALS_KEY ?? config.API_KEY_SECRET}`
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/** Sign a payload object → hex HMAC over its canonical form. */
export function signTmtest(payloadObj: unknown): string {
  return createHmac('sha256', key()).update(canonicalJson(payloadObj), 'utf8').digest('hex')
}

/** Verify a payload object against a signature. */
export function verifyTmtest(payloadObj: unknown, signature: string): boolean {
  const expected = signTmtest(payloadObj)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}
