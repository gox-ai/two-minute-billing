import { describe, it, expect } from 'vitest'
import { addInterval } from '@/modules/subscriptions/service'

const d = (iso: string) => new Date(iso)

describe('addInterval', () => {
  it('day / week', () => {
    expect(addInterval(d('2026-01-15T00:00:00Z'), 'day', 5).toISOString()).toBe('2026-01-20T00:00:00.000Z')
    expect(addInterval(d('2026-01-15T00:00:00Z'), 'week', 2).toISOString()).toBe('2026-01-29T00:00:00.000Z')
  })
  it('month / year (ordinary)', () => {
    expect(addInterval(d('2026-01-15T00:00:00Z'), 'month', 1).toISOString()).toBe('2026-02-15T00:00:00.000Z')
    expect(addInterval(d('2026-01-15T00:00:00Z'), 'year', 1).toISOString()).toBe('2027-01-15T00:00:00.000Z')
  })
  it('month rolls over the year boundary', () => {
    expect(addInterval(d('2026-12-10T00:00:00Z'), 'month', 1).toISOString()).toBe('2027-01-10T00:00:00.000Z')
  })
  it('intervalCount > 1', () => {
    expect(addInterval(d('2026-01-01T00:00:00Z'), 'month', 3).toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })
  it('preserves time-of-day', () => {
    expect(addInterval(d('2026-01-15T09:30:00Z'), 'month', 1).toISOString()).toBe('2026-02-15T09:30:00.000Z')
  })
  it('clamps month-end: Jan 31 + 1 month = Feb 28 (no rollover into March)', () => {
    // Clamp landed in the Phase E review pass (65f1e97); this documents it.
    expect(addInterval(d('2026-01-31T00:00:00Z'), 'month', 1).toISOString()).toBe('2026-02-28T00:00:00.000Z')
  })
})
