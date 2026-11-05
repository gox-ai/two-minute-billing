---
title: Retries and Disputes sit with your work, not your logs
date: 2026-09-09
type: Improvement
tags: Dashboard, Dunning, Payments
summary: Money at risk is on the sidebar with a live count, Billing LogIQ is now Billing rules, and a payment intent links to the transactions it produced.
---

The two screens that track money you can still lose now sit in the sidebar alongside
Customers and Subscriptions.

- **Retries carries a live count.** The number of invoices the billing clock is still
  working on shows on the sidebar from every page, so revenue in dunning is something you
  see rather than something you go looking for.
- **Disputes has its own place.** A chargeback runs against an evidence deadline, so it is
  no longer filed with webhook payloads.
- **Every dispute is reachable.** The disputes API now reports how many there are and pages
  through all of them, and the screen says so plainly when it is showing only the most
  recent ones.
- **"Billing LogIQ" is now "Billing rules."** The same nine settings — billing mode,
  payment terms, proration, round-off and the subscription-change rules — under a name that
  says what they do. Existing links and bookmarks redirect on their own.
- **A payment intent links to the money it moved.** Open an intent and jump straight to its
  transactions, so an authentication step and the charge that followed read as one story.
