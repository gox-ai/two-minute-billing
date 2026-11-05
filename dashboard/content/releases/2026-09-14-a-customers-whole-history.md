---
title: A customer's whole history, on the customer
date: 2026-09-14
type: Improvement
tags: Customers, Dashboard
summary: The customer page now shows everything that happened to that customer — renewals, invoices, payments, credit notes — as well as the raw event stream.
---

Open a customer and you can see their whole life with you, not just the edits made to their
record.

- **The Activity log covers everything the customer owns.**
  Renewals, invoices raised and paid, payments and refunds, credit notes and payment-method
  changes all appear alongside the changes made to the customer itself — each row naming the
  record it is about, who did it, and where from.
- **The Events tab is back, scoped the same way.**
  The developer's view of the same history: event id, type, the record it names, its source and
  when it happened — the list you reach for when you are matching a webhook to what the engine
  actually did.
- **Both read the whole footprint.**
  Subscriptions, invoices, credit notes, transactions, payments, refunds and saved payment
  methods — one customer, one history.

## For API users

`GET /v1/businesses/:business/events` and `GET /v1/businesses/:business/audit_logs` take a
`customer=<id>` parameter that scopes either stream to everything that customer owns, so you no
longer have to fan out over their records and merge the results yourself.
