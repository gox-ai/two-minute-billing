---
title: A self-service portal, a one-page checkout and billing rules you set
date: 2026-11-03
type: Feature
tags: Portal, Checkout, Subscriptions, Dunning, Invoicing, Tax, Payments, Security
summary: Customers change their plan, seats and add-ons in the portal with the exact price first. Checkout fits on one page. Each business sets its own billing rules.
---

Your customers can do more for themselves, and each business decides how billing behaves. Every
new setting is off until you turn it on, so your billing does not change until you choose. Three
security changes apply to every business. They are listed at the end.

## Customer portal

- **Plan, seat and add-on changes.** Customers see the exact price before they confirm, and they
  pay that price. You set the plans they can move to, the seat limits and which add-ons they
  can change. Turn it on in **Settings → Hosted pages**.
- **Pause, resume and skip.** Customers can pause and resume a subscription, skip a renewal, and
  undo a cancellation that is scheduled.
- **Offers before a cancel.** Before a customer cancels, offer a pause, a cheaper plan, a coupon
  or a talk with your team. Ask for a reason. A report shows the cancellations that you saved.
- **Sign in with a code.** Customers can sign in with a 6-digit code that we send by email. You
  set how long a portal link and a portal session stay valid.
- **Buttons that go to the task.** The buttons in your emails open the task directly: pay this
  invoice, change the payment method, change the plan or cancel.
- **A cleaner list.** You can hide cancelled subscriptions, and invoices that are zero or void.

## Checkout

- **One page.** Show the details and the payment on one page, with Apple Pay and Google Pay at
  the top when the device supports them.
- **Consent on record.** Ask the buyer to agree to the recurring charge, your terms and your
  privacy policy. You can also offer a marketing opt-in.
- **A bot check.** After a number of failed payments from one IP address, checkout asks the buyer
  to show that they are a person.
- **Conversion reports.** See where buyers leave checkout and why their payments fail.

## Billing rules for each business

- **Plan changes.** Set the proration for upgrades and downgrades. Set when a change applies: now,
  at the end of the term, or as the customer selects. You can stop changes while invoices are
  unpaid.
- **Trials and cancellations.** Set what happens when a trial ends, which cancel reasons are
  required, and how a refund for a downgrade is paid.
- **Dunning.** Select what happens when retries end: cancel at the end of the term, pause, or stop
  collection. Change the retry timing, and set retry schedules for each payment method and plan.
- **Payments and credits.** Combine due invoices into one charge, pay the newest or the oldest
  invoice first, and refund an overpayment automatically.
- **Invoices.** Write off small invoices below an amount you set, charge on the due date, and send
  invoices and receipts to CC and BCC addresses for each customer.
- **Tax.** Set tax as inclusive or exclusive for each currency and each customer. Add a seller tax
  ID for each country, and round tax on each line.
- **Reminders and documents.** Set how many days before a payment is due the reminder goes. Show
  the exchange rate on documents, and add a PO number field to checkout.
- **Team alerts.** Get an email for overdue invoices, for failed webhooks and as a daily summary.
  An address outside your team gets alerts only after it confirms them.

## Security changes for every business

- **One coupon code at checkout.** A buyer can enter one coupon code. To allow up to 10, change
  it in **Settings → Hosted pages**.
- **A smaller Developer role.** The Developer role cannot collect payments or cancel, pause,
  resume or change a subscription. Give these tasks to the Ops role or to a custom role.
- **Limits on free credit.** Set the most free credit a person can give in each currency, and get
  an alert above an amount you set.
