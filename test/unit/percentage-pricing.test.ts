import { describe, it, expect } from 'vitest'
import { computeLineAmount } from '@/modules/catalog/pricing'
import type { prices } from '@db/schema'

type Price = typeof prices.$inferSelect
function pct(o: { percentageBps: number; freeUnits?: number }): Price {
  return {
    model: 'percentage', amountMinor: null, tiers: null, packageSize: null,
    percentageBps: o.percentageBps, freeUnits: o.freeUnits ?? 0,
  } as unknown as Price
}

describe('percentage model — basic rates', () => {
  // 2.5% (250 bps) of a $100.00 (10000 minor) base = $2.50 (250 minor).
  it('250 bps of 10000 → 250', () => {
    expect(computeLineAmount(pct({ percentageBps: 250 }), 10000)).toBe(250n)
  })
  // 100% (10000 bps) is identity.
  it('10000 bps of 4242 → 4242', () => {
    expect(computeLineAmount(pct({ percentageBps: 10000 }), 4242)).toBe(4242n)
  })
  // 2.9% of 1000 = 29.
  it('290 bps of 1000 → 29', () => {
    expect(computeLineAmount(pct({ percentageBps: 290 }), 1000)).toBe(29n)
  })
})

describe('percentage model — rounding (half-up)', () => {
  // 1% of 1234 = 12.34 → rounds to 12.
  it('100 bps of 1234 → 12 (rounds down)', () => {
    expect(computeLineAmount(pct({ percentageBps: 100 }), 1234)).toBe(12n)
  })
  // 1% of 1250 = 12.5 → rounds half-up to 13.
  it('100 bps of 1250 → 13 (half rounds up)', () => {
    expect(computeLineAmount(pct({ percentageBps: 100 }), 1250)).toBe(13n)
  })
  // 1% of 1249 = 12.49 → 12.
  it('100 bps of 1249 → 12', () => {
    expect(computeLineAmount(pct({ percentageBps: 100 }), 1249)).toBe(12n)
  })
})

describe('percentage model — free base value', () => {
  const p = pct({ percentageBps: 1000, freeUnits: 1000 }) // 10%, first $10 of base free
  it('base within free allotment → 0', () => expect(computeLineAmount(p, 1000)).toBe(0n))
  it('base below free → 0', () => expect(computeLineAmount(p, 500)).toBe(0n))
  it('10% of (3000 − 1000) → 200', () => expect(computeLineAmount(p, 3000)).toBe(200n))
})

describe('percentage model — degenerate', () => {
  it('zero base → 0', () => expect(computeLineAmount(pct({ percentageBps: 250 }), 0)).toBe(0n))
  it('no rate → 0', () => {
    expect(computeLineAmount({ model: 'percentage', percentageBps: null, freeUnits: 0, amountMinor: null, tiers: null } as unknown as Price, 10000)).toBe(0n)
  })
})
