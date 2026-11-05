---
title: Payment methods show their own card marks
date: 2026-09-06
type: Improvement
tags: Payments, Dashboard
summary: Operator screens show the real network mark — the same one the payer sees in the portal.
---

A payer finds their card by its logo, not by re-reading four digits. Operator screens now do the
same: a Visa, a RuPay card, a UPI Autopay mandate and a bank debit are each recognisable at a
glance — which is exactly what you want on the screens where a failed payment gets triaged.

The mark comes from the same place the storefront uses, so the payer and the operator are always
looking at the same thing.

**Pay now works for cards vaulted on any gateway.** Routing follows the instrument that will actually
be charged, so a customer paying in INR with a card vaulted on Stripe pays without a detour.
