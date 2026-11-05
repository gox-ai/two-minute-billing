---
title: Direct debit and wallets on Stripe
date: 2026-09-05
type: Feature
tags: Payments
summary: Bank debit rails and wallet payments are reachable, with recovery paths of their own.
---

Stripe **direct debit** and **wallet** payments are now reachable from checkout and the portal, so
buyers who do not want to hand over a card have a route that works.

- **Direct-debit rails have their own failure and recovery handling**, because a bank debit fails
  differently from a card and deserves a different answer.
- **A paused mandate is re-asked.** When a mandate can no longer carry a charge, the payer is invited
  to re-authorise rather than the payment simply not happening.
- **A vaulted method's mandate can be recovered from the gateway**, so a method that arrived through
  a migration is as usable as one created here.
