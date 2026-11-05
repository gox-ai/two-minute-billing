---
title: Eleven payment gateways, roles, usage billing and more
date: 2026-10-28
type: Feature
tags: Payments, Gateways, Developers, Accounts, Usage, Dunning, Integrations
summary: Connect eight more payment gateways, give your team custom roles, bill usage with more pricing models, and get more control over collections.
---

You can now collect through 11 payment gateways. This release also adds custom roles, a request
log, more ways to price usage and more control over collections.

- **Eight more payment gateways.** Square, Braintree, Checkout.com, Adyen, Mollie, Authorize.net,
  GoCardless and Cashfree, together with Stripe, PayPal and Razorpay. Each has a setup guide in
  [Connect a payment gateway](https://twominutebilling.com/help/guides/connect-a-payment-gateway).
- **More ways to pay.** Apple Pay, Google Pay, Venmo, Cash App Pay and PayPal through Braintree,
  plus direct debits such as Bacs, SEPA, ACH, BECS, PAD, Autogiro, Betalingsservice, PayTo, eNACH
  and UPI Autopay. Each payment shows the payment method that paid it.
- **The correct account for each payment.** With more than one gateway account, pay now and
  save a payment method each use an account that can do that action.
- **Gateway messages are not lost.** If we cannot process a message from your gateway, we try
  again for about four days. On **Gateway Webhooks**, select **Replay** to try again yourself.
- **Record a dispute.** If your gateway cannot report a chargeback, select **Record dispute** on
  the payment. Refunds that you make in your gateway now show in Two Minute Billing too.
- **Custom roles.** On **Team → Roles**, make a role with only the permissions that it needs.
  You can also limit an API key to the resources that it needs.
- **Safer API keys.** Each key shows when it was last used. Set an expiry date, or select
  **Rotate key** to replace a key with an overlap of up to 7 days.
- **Request logs.** **Developers → Request logs** shows each API request, with secrets removed.
  The webhook delivery log now has filters and paging.
- **Usage-based pricing.** Price usage as tiered, volume, stairstep, package or percentage, and
  set a minimum spend. Customers see their usage so far in the customer portal.
- **Usage on yearly plans.** Bill a yearly plan's usage each month, and set a minimum commitment
  for each term.
- **More control over collections.** Select **Exclude from dunning** for a customer, set a
  minimum amount for dunning in each currency, and give a customer their own dunning policy.
  Set how many days before a trial end, a renewal or a scheduled cancellation the reminder goes.
- **Receipts and payment requests.** Each payment gets a numbered receipt with a PDF, also in
  the customer portal. A payment request collects up to 50 open invoices in one charge.
- **HubSpot invoices.** Send your invoices to a custom object in HubSpot Enterprise.
- **More accurate bills.** Each billing period gets one invoice, credit notes reverse the
  correct tax, and a cancel at the end of a term bills the usage and charges of that term.
