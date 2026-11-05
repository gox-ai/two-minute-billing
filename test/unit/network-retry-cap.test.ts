import { describe, it, expect } from 'vitest'
import { planFailureRearm, capRetryDaysForRail, networkRetryCap, NETWORK_RETRY_CAP } from '@/modules/subscriptions/dunning-schedule'
import { NETWORK_RETRY_CAP as DASHBOARD_CAP } from '../../dashboard/lib/dunning-caps'

const base = {
  dunningStatus: null, currentNextAttemptAt: null, autoCollectOn: true,
  retriable: true, now: new Date('2026-01-10T00:00:00Z'),
  dueDate: new Date('2026-01-01T00:00:00Z'),
  retryDays: [1, 2, 3, 4, 5, 6, 7, 8],
}

describe('NPCI presentation cap', () => {
  it('caps UPI and e-NACH at three retries, leaves others alone', () => {
    // The two rails DIFFER, and the internal reference doc that claimed "3 on both"
    // was wrong about NACH — verified 2026-08-18. UPI: 1 execution + 3 retries (NPCI,
    // Aug 2025, enforced by rejection). NACH: 1 presentation + 2 re-presentations
    // (NPCI/NACH/OC No.010/2023-24, enforced by a return-rate penalty).
    expect(networkRetryCap('upi')).toBe(3)
    expect(networkRetryCap('emandate')).toBe(2)
    expect(networkRetryCap('nach')).toBe(2)
    expect(networkRetryCap('card')).toBeNull()
    expect(networkRetryCap(null)).toBeNull()
    expect(capRetryDaysForRail([1,2,3,4,5,6,7,8], 'upi')).toEqual([1,2,3])
    expect(capRetryDaysForRail([1,2,3,4,5,6,7,8], 'emandate')).toEqual([1,2])
    expect(capRetryDaysForRail([1,2,3,4,5,6,7,8], 'card')).toEqual([1,2,3,4,5,6,7,8])
    expect(capRetryDaysForRail([1,2], 'upi')).toEqual([1,2])
  })

  it('a UPI mandate exhausts after the third retry even with eight configured', () => {
    // attempt 4 = the 4th retry slot → past the cap → nothing left to schedule.
    const atCap = planFailureRearm({ ...base, newAttemptCount: 3, mandateRail: 'upi' })
    const past = planFailureRearm({ ...base, newAttemptCount: 4, mandateRail: 'upi' })
    expect(atCap.action).toBe('retry')
    expect(past.action).toBe('exhausted')
  })

  it('an e-NACH mandate exhausts one retry EARLIER than UPI', () => {
    expect(planFailureRearm({ ...base, newAttemptCount: 2, mandateRail: 'emandate' }).action).toBe('retry')
    expect(planFailureRearm({ ...base, newAttemptCount: 3, mandateRail: 'emandate' }).action).toBe('exhausted')
    // …and the same attempt is still live on UPI, which is the whole point of per-rail.
    expect(planFailureRearm({ ...base, newAttemptCount: 3, mandateRail: 'upi' }).action).toBe('retry')
  })

  it('a CARD mandate keeps every configured retry', () => {
    const past = planFailureRearm({ ...base, newAttemptCount: 4, mandateRail: 'card' })
    expect(past.action).toBe('retry')
  })

  it('no rail = uncapped, i.e. unchanged behaviour', () => {
    expect(planFailureRearm({ ...base, newAttemptCount: 4 }).action).toBe('retry')
  })

  it('the dashboard mirrors the engine cap', () => {
    // The dashboard cannot import engine modules, so its copy is maintained by hand.
    // A settings screen quoting a cap the engine does not enforce is worse than one
    // that says nothing, so the two are pinned together here.
    expect(DASHBOARD_CAP).toEqual(NETWORK_RETRY_CAP)
  })
})
