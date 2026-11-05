---
title: Every payment attempt is on the record
date: 2026-09-07
type: Fix
tags: Payments, Reliability
summary: Whatever the gateway answers, the attempt and its reason land in tmbilling where you can see them.
---

Every charge now leaves a trail you can read, whichever way it was started — the billing clock
renewing, an operator pressing **Collect now**, or the payer pressing **Pay now** in the portal.

- A charge the gateway turns down writes a **payment attempt** carrying the gateway's own wording,
  so the reason an invoice is still unpaid is on the screen next to it.
- Attempts appear in the customer's **Transactions** and on the invoice itself.
- Charges the gateway accepts but that never complete are picked up by the sweep, across every
  gateway you have connected.
- An instrument that is not authorised for the amount is caught before the charge goes out, so the
  payer gets a clear answer instead of a gateway error.

## Your gateway statement says which flow charged

A renewal, an operator collecting early, and a payer paying themselves all reach the gateway the
same way. Every charge tmbilling sends now carries a description naming the flow it came from, so a
line in your Stripe or RazorPay dashboard can be explained without opening tmbilling beside it.
