---
title: Retries timed to when the payment is likely to go through
date: 2026-09-25
type: Feature
tags: Dunning, Payments
summary: With Smart decline handling, each retry can now be timed by why the payment failed, in your customer's morning.
---

**Turn on Adaptive retry timing** in Settings → Dunning, alongside Smart decline handling. Instead
of one schedule for every failure, each retry is timed by the reason the payment was declined:

- **A gateway or network hiccup is retried within hours**, then after a day and after three days.
- **Insufficient funds is retried on the next likely payday**: the 1st, the 15th or the last day
  of the month, up to four times.
- **A generic decline is retried a few days apart**, then the invoice is held and your customer is
  asked to update their card.

## Retries land in your customer's morning

- **At 10:00 where the card was issued**, or in your business's timezone when that isn't known.
- **Card networks are respected.** When a card network or gateway says how long to wait before
  trying again, the next attempt waits at least that long.
- **Your limits still apply.** No retry lands more than 30 days after the due date or past your
  dunning period, and mandate debits (UPI, e-NACH, card mandates) keep your retry schedule.

These timings follow common practice rather than a guarantee, so compare your collections
recovery rate before and after you turn it on. Adaptive retry timing is off until you do, and
your existing schedule is unchanged.

## Also in this release, for every business

- **A card the network says not to retry is never charged again** until it's replaced or
  updated, including when you collect by hand. Retrying those cards can bring network fees.
- **Each card stays under the card networks' attempt limits.** When a card has been declined
  many times recently, across all its invoices, the next retry waits instead.
