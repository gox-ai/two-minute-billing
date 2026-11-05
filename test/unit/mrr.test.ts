import { describe, it, expect } from 'vitest'
import { monthlyRecurringMinor, annualFromMonthly } from '@/modules/metrics/mrr'
import type { prices } from '@db/schema'

type Price = typeof prices.$inferSelect
function p(o: Partial<Price>): Price {
  return {
    type: 'recurring', model: 'flat', amountMinor: null, interval: 'month',
    intervalCount: 1, tiers: null, ...o,
  } as unknown as Price
}

describe('monthlyRecurringMinor — interval normalization', () => {
  it('monthly flat = itself', () => {
    expect(monthlyRecurringMinor(p({ model: 'flat', amountMinor: 5000n, interval: 'month' }), 1)).toBe(5000n)
  })
  it('annual → /12 (rounded)', () => {
    // $100/yr = 10000 → 833 (833.33 rounded)
    expect(monthlyRecurringMinor(p({ model: 'flat', amountMinor: 10000n, interval: 'year' }), 1)).toBe(833n)
  })
  it('quarterly (every 3 months) → /3', () => {
    expect(monthlyRecurringMinor(p({ model: 'flat', amountMinor: 3000n, interval: 'month', intervalCount: 3 }), 1)).toBe(1000n)
  })
  it('weekly → ×52/12', () => {
    // $10/wk = 1000 → 1000*52/12 = 4333.3 → 4333
    expect(monthlyRecurringMinor(p({ model: 'flat', amountMinor: 1000n, interval: 'week' }), 1)).toBe(4333n)
  })
  it('daily → ×365/12', () => {
    // $1/day = 100 → 100*365/12 = 3041.6 → 3042
    expect(monthlyRecurringMinor(p({ model: 'flat', amountMinor: 100n, interval: 'day' }), 1)).toBe(3042n)
  })
})

describe('monthlyRecurringMinor — models', () => {
  it('per_unit scales with quantity', () => {
    expect(monthlyRecurringMinor(p({ model: 'per_unit', amountMinor: 1000n, interval: 'month' }), 5)).toBe(5000n)
  })
  it('per_unit annual per seat', () => {
    // $120/yr/seat × 3 seats = 36000/yr → 3000/mo
    expect(monthlyRecurringMinor(p({ model: 'per_unit', amountMinor: 12000n, interval: 'year' }), 3)).toBe(3000n)
  })
  it('tiered uses graduated math then normalizes', () => {
    const price = p({ model: 'tiered', amountMinor: null, interval: 'month',
      tiers: [{ upToMinor: 10, unitAmountMinor: 1000, flatAmountMinor: 0 }, { upToMinor: null, unitAmountMinor: 500, flatAmountMinor: 0 }] })
    // qty 15 → 10*1000 + 5*500 = 12500/mo
    expect(monthlyRecurringMinor(price, 15)).toBe(12500n)
  })
})

describe('monthlyRecurringMinor — exclusions', () => {
  it('one_time → 0 (not recurring)', () => {
    expect(monthlyRecurringMinor(p({ type: 'one_time', model: 'flat', amountMinor: 9900n, interval: null }), 1)).toBe(0n)
  })
  it('usage → 0 (variable, not committed MRR)', () => {
    expect(monthlyRecurringMinor(p({ model: 'usage', amountMinor: 5n, interval: 'month' }), 1000)).toBe(0n)
  })
  it('zero amount → 0', () => {
    expect(monthlyRecurringMinor(p({ model: 'flat', amountMinor: 0n }), 1)).toBe(0n)
  })
})

describe('annualFromMonthly', () => {
  it('ARR = MRR × 12', () => expect(annualFromMonthly(5000n)).toBe(60000n))
})
