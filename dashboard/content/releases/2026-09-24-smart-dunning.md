---
title: Dunning that reads why a payment failed
date: 2026-09-24
type: Feature
tags: Dunning, Payments, Emails
summary: Smart decline handling retries what can succeed, pauses what needs the customer, and keeps them informed until it is fixed.
---

**Choose how failed payments are handled.** Settings → Dunning has a new **Decline handling**
option. _Fixed_ follows your retry schedule for every failure. _Smart_ reads the reason the
payment was declined and acts on it:

- **Temporary problems are retried**, such as insufficient funds or a bank that is briefly
  unavailable, on your schedule.
- **Problems only the customer can fix pause the invoice** instead of retrying a card that cannot
  succeed, such as an expired card or a cancelled mandate. Your customer is asked to update their
  payment method, and the invoice can be charged the moment they do.
- **Declines that must not be retried stop straight away**, such as a card reported lost or
  stolen.

## Customers hear from you while an invoice is paused

- **Reminders through the whole window.** A paused invoice gets a series of reminders spaced by
  your own retry schedule, each with an **Update payment method** button, so a new card settles
  this invoice and the next renewal too.
- **One last attempt before the deadline.** When the window closes, the invoice is charged once
  more before your final action runs.
- **Failure emails say when you will try again.** The payment failed email now shows the date of
  the next attempt.

## Also in this release

- **A customer with no payment method on file is given time to add one** instead of reaching
  your final action within days.
- **A problem with your own gateway account never cancels a customer.** Those invoices are paused
  rather than run to your final action, so you can fix the connection and collect.
- **Collections recovery rate** is a new measure you can add to any dashboard: of the invoices
  dunning finished with, the share it recovered. It counts from today.
