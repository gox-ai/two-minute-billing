---
title: Open a charge in your gateway, from the transaction
date: 2026-09-14
type: Improvement
tags: Payments, Dashboard
summary: The gateway transaction id on a transaction is now a link straight to that charge on Stripe, Razorpay or PayPal, in the right mode.
---

Reconciling a payment no longer means copying an id into your gateway's search box.

- **The gateway transaction id links to the charge.**
  On a transaction, the id the provider gave the charge opens that charge on the provider's own
  dashboard in a new tab — Stripe, Razorpay and PayPal.
- **The transactions list carries it too.**
  A new **Gateway Charge Id** column sits beside Gateway, linked the same way, so you can jump to
  the provider without opening each transaction first. Hide it from the column chooser if you would
  rather not see it.
- **It opens in the right mode.**
  A test charge opens the provider's test dashboard or sandbox and a live one opens live, so the
  link never lands on an account where the charge does not exist.
- **Ids with nowhere to go stay plain text.**
  Simulated and offline payments have no gateway page, and a refund is reached through the payment
  it reverses — those ids are shown as before rather than as links that would go nowhere.
