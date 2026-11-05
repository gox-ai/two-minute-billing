import { describe, it, expect } from 'vitest'
import { parseInvalidEventNames } from '@/providers/razorpay'

/**
 * RazorPay rejects an ENTIRE webhook registration if any single event name is not valid on the
 * account. The caller treats that as "auto-provisioning failed" and falls back to a manual
 * paste, so one unrecognised name silently stops every webhook arriving. The provisioning path
 * now drops the rejected names and retries — which makes this parser load-bearing in both
 * directions: too greedy and a REAL error gets quietly retried into a half-registration; too
 * narrow and the endpoint still degrades to manual.
 */
describe('parseInvalidEventNames', () => {
  it('pulls the names out of RazorPay’s measured error text', () => {
    expect(parseInvalidEventNames('Invalid event name/names: token.resumed, token.updated'))
      .toEqual(['token.resumed', 'token.updated'])
  })

  it('handles a single name and a trailing full stop', () => {
    expect(parseInvalidEventNames('Invalid event name: payment.downtime.started.'))
      .toEqual(['payment.downtime.started'])
  })

  it('is case-insensitive about the phrasing', () => {
    expect(parseInvalidEventNames('invalid event names: refund.speed_changed'))
      .toEqual(['refund.speed_changed'])
  })

  // The important half: anything that is NOT this error must fall through to a real failure
  // rather than being retried with a shorter list.
  it.each([
    ['', undefined],
    ['no match', 'The api key provided is invalid'],
    ['auth', 'Authentication failed'],
    ['url', 'Invalid url'],
    ['rate limit', 'Too many requests'],
  ])('returns nothing for an unrelated error (%s)', (_label, text) => {
    expect(parseInvalidEventNames(text as string | undefined)).toEqual([])
  })

  it('ignores fragments that are not event names', () => {
    expect(parseInvalidEventNames('Invalid event name/names: not an event, token.paused'))
      .toEqual(['token.paused'])
  })
})
