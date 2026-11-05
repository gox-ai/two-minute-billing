---
title: Pay another way, without the risk of paying twice
date: 2026-09-12
type: Improvement
tags: Payments, India, Portal
summary: The portal offers a second way to pay only where the first attempt can actually be stopped, and payment records now say what the gateway said.
---

A customer waiting on a bank approval can pay another way — where we can safely stop the
first attempt.

- **"Pay now" appears only when the first attempt can be cancelled.**
  Some banks can authorise a payment retroactively, for up to three days, with nothing for
  the cardholder to decline. Where that is possible, we no longer offer a second route that
  could take the money twice; the invoice waits instead.
- **The confirmation says what will happen.**
  Before anything is released, your customer is told plainly that we will cancel the bank's
  request, and to decline it if it still reaches them.
- **Payment records carry the gateway's own answer.**
  Whether a payment is waiting on the cardholder is taken from what the gateway states, and
  a later statement replaces an earlier one — so a record never keeps saying "no approval
  needed" after the gateway has asked for approval.
- **A quiet payment is no longer read as a stalled one.**
  Time alone never decides that a customer has been asked to authenticate.
- **Approval is asked for on Indian cards, where the rule applies.**
  The RBI mandate rules follow the card's issuing country, not the currency, so a foreign
  card paying in rupees is treated as what it is.

## Payment methods know more about themselves

- **Every saved method records its issuing country, funding type, bank and capabilities.**
  Cards, netbanking, UPI, wallets and direct debits all carry the same facts, so routing and
  retries can use them. Card numbers are never stored.
- **Re-adding a card updates the one you already have.**
  Saving the same card again keeps the existing method and its history instead of leaving a
  duplicate behind.
- **A backup payment method has to be a different card.**
  If your backup turns out to be the same card as the primary, it is no longer used as a
  fallback — retrying the same card against the same decline never helped anyone.
