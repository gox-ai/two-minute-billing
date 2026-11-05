---
title: A transaction says where it came from
date: 2026-09-09
type: Improvement
tags: Payments, Ops
summary: Open a charge and you can see the authentication it came through and whatever the gateway has said about fraud.
---

A transaction now names the authorization behind it, and carries the gateway's own fraud verdict — both on the page you were already looking at.

- **Follow a charge back to its payment intent.** Where a customer authenticated — a checkout, a portal payment, an operator collecting an invoice — the transaction links straight to that intent and its attempts. You could always walk from the intent to the charge; now it goes both ways.
  Renewals show no link, and that is the honest answer: nobody is present to authenticate an automatic renewal, so no intent is ever created for one.
- **See a fraud warning where the money is.** If the card network flags a charge as probably fraudulent, or the gateway puts it under manual review, the transaction says so and when it was reported.
  It sits alongside the charge's own status rather than replacing it, so you can always still tell whether the money settled.

## Developers

`payment_intent` and `fraud_signal` are new on the transaction object. Both are nullable, `fraud_signal` is served on the single-transaction read, and both are in the OpenAPI spec and the generated SDK.
