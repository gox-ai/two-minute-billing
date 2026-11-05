---
title: India auto-debits ask only when the bank asks
date: 2026-09-10
type: Fix
tags: Payments, India, Subscriptions
summary: A recurring payment that is only waiting on its pre-debit notification now reads as in progress, not as something your customer has to approve.
---

An India e-mandate payment now says exactly what it is waiting for.

Under RBI rules every e-mandate debit pauses briefly while the pre-debit notification goes
out to the cardholder. Most of those debits need nothing from anyone — the notification is
served, the charge presents itself, and the money arrives. Some genuinely do need the
cardholder to authenticate. Your customers now only hear from us about the second kind.

- **The portal asks for approval only when approval is actually required.**
  A payment waiting on nothing but its notification window shows as in progress, so nobody
  is prompted to act on a charge that will complete on its own.
- **Payment records name the kind of wait.**
  Whether an attempt is waiting on the bank's notification or on the cardholder is taken
  from what the gateway states, not inferred from the amount — so the Retries and payment
  screens agree with the gateway.
- **Every amount is treated the same way.**
  An auto-debit is not assumed to be unattended just because it is small, and not assumed
  to need authentication just because it is large.
- **A charge above the approved limit can now be authorised in one step.**
  When a renewal exceeds the per-charge limit on an Indian card mandate, the bank offers the
  cardholder a link to approve that single payment. They now get it, instead of being asked
  to set up their auto-debit again from scratch.
- **When a bank asks us to wait, we wait.**
  A decline that comes back with "try again in 24 hours" no longer spends a retry the same
  night on an attempt the network has already said it will refuse.
