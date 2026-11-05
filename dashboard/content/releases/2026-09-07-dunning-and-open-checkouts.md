---
title: Two dunning settings, and open checkouts on the invoice
date: 2026-09-07
type: Feature
tags: Dunning, Invoicing
summary: Retry behaviour and end-of-dunning behaviour are set separately, and an invoice shows the checkout waiting at the gateway.
---

**Dunning is two settings now.** What happens while an invoice is being retried and what happens
when retries run out are separate choices, so you can keep collecting without committing to what
happens at the end — and change one without disturbing the other.

**An invoice shows the checkout that is open at the gateway.** When a payer has a hosted checkout
session waiting, the invoice says so, so you can tell "nobody has tried" apart from "somebody is
part-way through". A payment intent that is no longer wanted can be voided from the same place.

**The dunning card names the final attempt.** Before it happens, the screen tells you what the last
attempt will do, so the end of a dunning cycle holds no surprises.
