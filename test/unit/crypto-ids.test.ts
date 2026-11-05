import { describe, it, expect } from 'vitest'
import { signPayload } from '@/modules/webhooks/outbox'
import { generateApiKey, hashApiKey } from '@/platform/api-key'
import { publicId } from '@/platform/ids'

describe('signPayload (webhook HMAC)', () => {
  it('is deterministic for the same secret + body', () => {
    expect(signPayload('whsec_x', '{"a":1}')).toBe(signPayload('whsec_x', '{"a":1}'))
  })
  it('starts with sha256= and changes with body or secret', () => {
    const a = signPayload('whsec_x', '{"a":1}')
    expect(a.startsWith('sha256=')).toBe(true)
    expect(a).not.toBe(signPayload('whsec_x', '{"a":2}'))
    expect(a).not.toBe(signPayload('whsec_y', '{"a":1}'))
  })
})

describe('API keys', () => {
  it('mints sk_<mode>_ keys with a stored HMAC, raw shown once', () => {
    const k = generateApiKey('test')
    expect(k.raw.startsWith('sk_test_')).toBe(true)
    expect(k.prefix).toBe(k.raw.slice(0, 12))
    expect(k.hashed).toBe(hashApiKey(k.raw))
    expect(k.hashed).not.toContain(k.raw) // never stores the raw key
  })
  it('live mode prefix', () => {
    expect(generateApiKey('live').raw.startsWith('sk_live_')).toBe(true)
  })
  it('hashing is deterministic; distinct keys hash differently', () => {
    const a = generateApiKey('test')
    const b = generateApiKey('test')
    expect(a.raw).not.toBe(b.raw)
    expect(a.hashed).not.toBe(b.hashed)
    expect(hashApiKey(a.raw)).toBe(a.hashed)
  })
})

describe('publicId', () => {
  it('prefixes and is unique', () => {
    const id = publicId('cus')
    expect(id.startsWith('cus_')).toBe(true)
    const ids = new Set(Array.from({ length: 1000 }, () => publicId('sub')))
    expect(ids.size).toBe(1000) // no collisions in 1k
  })
})
