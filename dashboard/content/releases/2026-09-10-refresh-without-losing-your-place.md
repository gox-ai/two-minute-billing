---
title: Refresh a screen without losing your place
date: 2026-09-10
type: Improvement
tags: Dashboard, Invoicing, Payments, Subscriptions
summary: Every list and the invoice, subscription, transaction and customer screens now reload the numbers on demand — keeping your filters, your sort and your scroll exactly as they were.
---

Billing moves while you are looking at it: the clock issues invoices, gateways answer
minutes later, and payers act in their own portal. Every screen that shows that kind of
state now has a Refresh control that fetches the current answer on the spot.

- **Your view survives a refresh.** Refresh re-runs the search, filters, segment and sort
  you already have applied, so a narrowed list comes back narrowed. It reloads the rows
  and nothing else — the page does not reload and you do not return to the top.
- **On a list, one control covers everything you monitor.** Invoices, Transactions,
  Subscriptions, Customers, Credit notes, Payment intents, Events, Retries, Emails,
  Gateway requests, Gateway webhooks, the Audit log and Ops due-work all carry it.
- **On a record, only what moves gets fetched.** Open an invoice and Refresh brings its
  status, amount due, payments, credits and retry schedule up to date; the line items,
  addresses and tax stay put. Subscriptions refresh their status, term and next billing;
  transactions their settlement and refunds; customers their balance, credits and payment
  methods.
- **On a transaction, Refresh and Sync are different questions.** Refresh shows what we
  already know. Sync goes and asks the gateway. Both are available and neither pretends to
  be the other.
- **The business dashboard says when it last synced, and lets you do something about it.**
  The freshness of the figures is now next to the control that updates them.
