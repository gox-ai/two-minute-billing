import { describe, it, expect } from 'vitest'
import { prorate, nonResetItemProration } from '@/modules/subscriptions/proration'

const start = new Date('2026-01-01T00:00:00Z')
const end = new Date('2026-02-01T00:00:00Z') // 31-day period

describe('prorate — fraction of period remaining', () => {
  it('full period remaining (now = start) → full amount', () => {
    expect(prorate(3100n, start, start, end)).toBe(3100n)
  })
  it('~half remaining → ~half (integer floor division)', () => {
    const mid = new Date('2026-01-16T12:00:00Z') // exact midpoint of 31 days
    const got = Number(prorate(3100n, mid, start, end))
    expect(Math.abs(got - 1550)).toBeLessThanOrEqual(2)
  })
  it('no time remaining (now = end) → 0', () => {
    expect(prorate(3100n, end, start, end)).toBe(0n)
  })
  it('now past end → 0', () => {
    expect(prorate(3100n, new Date('2026-03-01T00:00:00Z'), start, end)).toBe(0n)
  })
  it('degenerate period (end <= start) → 0', () => {
    expect(prorate(3100n, start, end, start)).toBe(0n)
  })
  it('one day remaining of 31 → ~1/31', () => {
    const dayBeforeEnd = new Date('2026-01-31T00:00:00Z')
    const got = Number(prorate(3100n, dayBeforeEnd, start, end))
    expect(got).toBe(100) // 3100 * (1 day / 31 days) = 100
  })

  it('quarter / three-quarter points', () => {
    const q1 = new Date('2026-01-08T18:00:00Z') // ~25% elapsed → ~75% remaining
    const q3 = new Date('2026-01-24T06:00:00Z') // ~75% elapsed → ~25% remaining
    expect(Math.abs(Number(prorate(4000n, q1, start, end)) - 3000)).toBeLessThanOrEqual(20)
    expect(Math.abs(Number(prorate(4000n, q3, start, end)) - 1000)).toBeLessThanOrEqual(20)
  })

  it('floors (never over-charges the prorated amount)', () => {
    // 1000 * (remaining just under half) must floor, not round up
    const justPastMid = new Date('2026-01-16T13:00:00Z')
    expect(Number(prorate(1000n, justPastMid, start, end))).toBeLessThanOrEqual(500)
  })

  it('large amounts do not overflow (bigint)', () => {
    const huge = 1_000_000_000_000n // $10,000,000,000.00
    expect(prorate(huge, start, start, end)).toBe(huge) // full period
    expect(prorate(huge, end, start, end)).toBe(0n)
  })

  it('1ms before end → tiny but non-negative', () => {
    const nearEnd = new Date(end.getTime() - 1)
    const got = prorate(3100n, nearEnd, start, end)
    expect(got >= 0n).toBe(true)
    expect(got < 3100n).toBe(true)
  })
})

/**
 * The NON-RESET branch of `changeSubscription` / `estimateChange`. Guards the
 * README invariant "a `one_time` item is charged once, prorated never, credited
 * never" on the fifth and last path that used to decide for itself (bug, 2026-08-04:
 * a change to a one-time item's own price/quantity was time-sliced on both sides).
 */
describe('nonResetItemProration — one-time items are charged once, prorated never, credited never', () => {
  const mid = new Date('2026-01-16T12:00:00Z') // exact midpoint of the 31-day period
  const base = { billingCycles: null as number | null, cyclesBilled: 0, now: mid, periodStart: start, periodEnd: end }

  it('RECURRING → RECURRING is untouched: both sides time-sliced', () => {
    const got = nonResetItemProration({
      ...base,
      oldSnapshotType: 'recurring',
      newSnapshotType: 'recurring',
      oldFullMinor: 3100n,
      newFullMinor: 6200n,
    })
    expect(got.creditMinor).toBe(prorate(3100n, mid, start, end))
    expect(got.chargeMinor).toBe(prorate(6200n, mid, start, end))
    expect(got.chargeIsOneTime).toBe(false)
  })

  it('ONE-TIME, cycle unspent → FULL fee, no credit (pre-fix it was half of each)', () => {
    const got = nonResetItemProration({
      ...base,
      oldSnapshotType: 'one_time',
      newSnapshotType: 'one_time',
      oldFullMinor: 5000n,
      newFullMinor: 5000n,
    })
    expect(got.chargeMinor).toBe(5000n) // pre-fix: prorate(5000) === 2500
    expect(got.creditMinor).toBe(0n) // pre-fix: prorate(5000) === 2500
    expect(got.chargeIsOneTime).toBe(true) // → plain label, kind one_time, markItemsBilled
  })

  it('ONE-TIME whose single cycle is SPENT → nothing charged, nothing credited', () => {
    const got = nonResetItemProration({
      ...base,
      cyclesBilled: 1, // implicit one_time cap of 1 (itemCycleCap) is exhausted
      oldSnapshotType: 'one_time',
      newSnapshotType: 'one_time',
      oldFullMinor: 3000n,
      newFullMinor: 9000n,
    })
    expect(got.chargeMinor).toBe(0n)
    expect(got.creditMinor).toBe(0n)
    expect(got.chargeIsOneTime).toBe(false)
  })

  it('an EXPLICIT billing_cycles cap beats the implicit one_time cap of 1', () => {
    const unspent = nonResetItemProration({
      ...base, billingCycles: 2, cyclesBilled: 1,
      oldSnapshotType: 'one_time', newSnapshotType: 'one_time', oldFullMinor: 3000n, newFullMinor: 3000n,
    })
    expect(unspent.chargeMinor).toBe(3000n)
    const spent = nonResetItemProration({
      ...base, billingCycles: 2, cyclesBilled: 2,
      oldSnapshotType: 'one_time', newSnapshotType: 'one_time', oldFullMinor: 3000n, newFullMinor: 3000n,
    })
    expect(spent.chargeMinor).toBe(0n)
  })

  it('an already-PAID one-time fee is still credited nothing (unconditional on cycles_billed)', () => {
    const got = nonResetItemProration({
      ...base, cyclesBilled: 1,
      oldSnapshotType: 'one_time', newSnapshotType: 'recurring', oldFullMinor: 3000n, newFullMinor: 12000n,
    })
    expect(got.creditMinor).toBe(0n)
    expect(got.chargeMinor).toBe(prorate(12000n, mid, start, end)) // the new RECURRING side still prorates
    expect(got.chargeIsOneTime).toBe(false)
  })

  it('a RECURRING item swapped onto a one_time price is decided by the POST-change type', () => {
    // Mirrors the term-reset charge loop verbatim: the item has billed a cycle, so the
    // implicit one-cycle cap of its new one_time type is already exhausted.
    const billed = nonResetItemProration({
      ...base, cyclesBilled: 1,
      oldSnapshotType: 'recurring', newSnapshotType: 'one_time', oldFullMinor: 12000n, newFullMinor: 5000n,
    })
    expect(billed.chargeMinor).toBe(0n)
    expect(billed.creditMinor).toBe(prorate(12000n, mid, start, end)) // the old RECURRING side is still credited
    // Never billed → the fee is genuinely still owed, in full.
    const fresh = nonResetItemProration({
      ...base,
      oldSnapshotType: 'recurring', newSnapshotType: 'one_time', oldFullMinor: 12000n, newFullMinor: 5000n,
    })
    expect(fresh.chargeMinor).toBe(5000n)
    expect(fresh.chargeIsOneTime).toBe(true)
  })

  it('a one-time fee is full even with no time left in the term (a recurring one would be 0)', () => {
    const args = { ...base, now: end, oldFullMinor: 5000n, newFullMinor: 5000n }
    expect(nonResetItemProration({ ...args, oldSnapshotType: 'recurring', newSnapshotType: 'recurring' }).chargeMinor).toBe(0n)
    expect(nonResetItemProration({ ...args, oldSnapshotType: 'one_time', newSnapshotType: 'one_time' }).chargeMinor).toBe(5000n)
  })

  it('returns integer minor units only — never a float', () => {
    const got = nonResetItemProration({
      ...base, oldSnapshotType: 'recurring', newSnapshotType: 'recurring', oldFullMinor: 999n, newFullMinor: 1001n,
    })
    expect(typeof got.creditMinor).toBe('bigint')
    expect(typeof got.chargeMinor).toBe('bigint')
  })
})
