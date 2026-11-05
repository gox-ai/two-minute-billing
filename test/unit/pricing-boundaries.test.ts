import { describe, it, expect } from 'vitest'
import { computeLineAmount } from '@/modules/catalog/pricing'
import type { prices } from '@db/schema'

type Price = typeof prices.$inferSelect
const tieredP = (tiers: unknown[]) => ({ model: 'tiered', amountMinor: null, tiers } as unknown as Price)
const volumeP = (tiers: unknown[]) => ({ model: 'volume', amountMinor: null, tiers } as unknown as Price)
const perUnitP = (a: number) => ({ model: 'per_unit', amountMinor: BigInt(a), tiers: null } as unknown as Price)

// 0–10 @10/flat2 · 11–20 @5/flat3 · 21+ @5/flat3  (minor units ×100)
const GRAD = [
  { upToMinor: 10, unitAmountMinor: 1000, flatAmountMinor: 200 },
  { upToMinor: 20, unitAmountMinor: 500, flatAmountMinor: 300 },
  { upToMinor: null, unitAmountMinor: 500, flatAmountMinor: 300 },
]
// 0–100 @2/flat10 · 101–200 @1/flat0 · 201+ @0.5/flat50
const VOL = [
  { upToMinor: 100, unitAmountMinor: 200, flatAmountMinor: 1000 },
  { upToMinor: 200, unitAmountMinor: 100, flatAmountMinor: 0 },
  { upToMinor: null, unitAmountMinor: 50, flatAmountMinor: 5000 },
]

describe('tiered (graduated) — every tier boundary', () => {
  const cases: Array<[number, bigint]> = [
    [0, 0n],
    [1, 1200n],
    [9, 9200n], // 9*1000+200
    [10, 10200n], // exact tier1 cap
    [11, 11000n], // first unit of tier2: +1*500+300
    [19, 15000n], // tier1 10200 + 9*500+300=4800
    [20, 15500n], // exact tier2 cap: tier1 10200 + 10*500+300=5300
    [21, 16300n], // + tier3 1*500+300=800
    [100, 55800n], // 10200 + 5300 + 80*500+300=40300
  ]
  for (const [q, want] of cases) {
    it(`qty ${q} → ${want}`, () => expect(computeLineAmount(tieredP(GRAD), q)).toBe(want))
  }
})

describe('volume — every tier boundary (all units at the landed tier)', () => {
  const cases: Array<[number, bigint]> = [
    [0, 0n],
    [1, 1200n],
    [99, 20800n], // 99*200+1000
    [100, 21000n], // exact tier1 cap
    [101, 10100n], // jumps to tier2 rate for ALL units
    [200, 20000n], // exact tier2 cap
    [201, 15050n], // tier3: 201*50+5000
    [1000, 55000n], // 1000*50+5000
  ]
  for (const [q, want] of cases) {
    it(`qty ${q} → ${want}`, () => expect(computeLineAmount(volumeP(VOL), q)).toBe(want))
  }
})

describe('single-tier and flat-only tiers', () => {
  it('one unbounded tier behaves like per_unit + flat', () => {
    const p = tieredP([{ upToMinor: null, unitAmountMinor: 100, flatAmountMinor: 500 }])
    expect(computeLineAmount(p, 5)).toBe(1000n) // 5*100 + 500
  })
  it('volume single unbounded tier', () => {
    const p = volumeP([{ upToMinor: null, unitAmountMinor: 100, flatAmountMinor: 500 }])
    expect(computeLineAmount(p, 5)).toBe(1000n)
  })
})

describe('per_unit — scale + large quantities (no overflow with bigint)', () => {
  it('1e9 units', () => expect(computeLineAmount(perUnitP(7), 1_000_000_000)).toBe(7_000_000_000n))
})
