---
title: Delete a subscription
date: 2026-09-17
type: Feature
tags: Subscriptions, Dashboard
summary: Remove a subscription that should never have been there, and keep every invoice it raised.
---

A subscription created by mistake — a duplicate, a test, an import that went wrong — can now be
deleted. Open it and use **Delete subscription** in the actions rail, or call
`DELETE /v1/businesses/{business}/subscriptions/{subscription}`.

- **The billing stops and the books stay.** The subscription leaves your lists and its page, and
  nothing renews it again. Its invoices, payments and credit notes are kept exactly as they were and
  stay on the customer, so your revenue history reads the same after the delete as before it.
- **Anything still owed is still owed.** An unpaid invoice raised by a deleted subscription remains
  payable and keeps running through dunning — deleting the subscription does not write off the debt.
- **Deleting is not cancelling, and the dialog says so.** There is no final invoice, no credit for
  unused time and no cancellation on the record. If you want the term closed out properly, cancel
  the subscription instead; delete is for the one that should not exist at all.

Deleting is available to managers and owners, and every delete is recorded in the audit log with who
did it. Integrations can listen for the new `subscription_deleted` event.
