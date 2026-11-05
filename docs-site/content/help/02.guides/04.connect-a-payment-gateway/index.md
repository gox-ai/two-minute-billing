---
title: Connect a payment gateway
description: "Connect your own payment gateway account so Two Minute Billing can collect payments, and route each currency to the account that should handle it. Step-by-step guides for each gateway."
seo:
  title: "Connect your payment gateway"
  description: "Connect your own payment gateway account to Two Minute Billing, route each currency to the right account, and check the key permissions."
navigation:
  title: "Overview"
  icon: i-lucide-plug
---

Two Minute Billing collects through **your** payment accounts, at your rates, paying into your
bank. Until you connect one, it can raise invoices but cannot charge anything.

Open **Settings → Payment gateways**.

::screenshot
---
src: gateways
alt: "The Payment gateways settings screen, listing each gateway account connected to the business with its mode, currencies and status"
caption: "Each business connects its own gateway accounts. Test mode starts with the built-in test gateway."
---
::

## Connect an account

Add the account and paste in its credentials. Two Minute Billing stores them encrypted and uses
them only to charge, refund and save cards on your behalf.

Tell it which **currencies** and which **payment methods** that account handles.

::warning
**Test keys in test mode, live keys in live mode.** Connect your gateway's test (sandbox) keys to a test business and its live keys to a live
business. Test mode also has a built-in test gateway, so you can try everything before you
connect an account.
::

## Set up your gateway

Two Minute Billing connects to 12 payment gateways. Each guide shows where to find the keys in the
gateway, which **permissions** the keys need, how to connect them, and what to do about webhooks.
Select your gateway:

::gateway-cards
::

Coming soon: [CyberSource](/help/guides/connect-a-payment-gateway/cybersource). You cannot
connect it yet.

## Select a gateway

The payment methods and wallets below are the ones you can use today. For what each one asks of
your customers, see [Payment methods your customers can use](/help/guides/payment-methods).

<!-- generated:gateway-table -->
### Payment methods and wallets

| Gateway | Payment methods | Wallets on pay now |
| --- | --- | --- |
| [Stripe](/help/guides/connect-a-payment-gateway/stripe) | Cards, Direct Debit (ACH), Direct Debit (SEPA) | Apple Pay, Google Pay |
| [PayPal](/help/guides/connect-a-payment-gateway/paypal) | PayPal wallet | — |
| [Razorpay](/help/guides/connect-a-payment-gateway/razorpay) | Cards, UPI Autopay, Netbanking (eMandate) | — |
| [Square](/help/guides/connect-a-payment-gateway/square) | Cards, Afterpay (pay now), ACH (pay now) | Google Pay, Cash App Pay |
| [Braintree](/help/guides/connect-a-payment-gateway/braintree) | Cards, PayPal, Venmo | — |
| [Checkout.com](/help/guides/connect-a-payment-gateway/checkoutcom) | Cards | Google Pay |
| [Adyen](/help/guides/connect-a-payment-gateway/adyen) | Cards | Apple Pay, Google Pay |
| [Mollie](/help/guides/connect-a-payment-gateway/mollie) | Cards, Direct Debit (SEPA), PayPal, Other methods that you activate in Mollie (pay now) | Apple Pay, Google Pay |
| [Authorize.net](/help/guides/connect-a-payment-gateway/authorizenet) | Cards, eCheck (ACH) | — |
| [GoCardless](/help/guides/connect-a-payment-gateway/gocardless) | Direct Debit (Bacs), Direct Debit (SEPA), Direct Debit (ACH), Direct Debit (BECS), Direct Debit (BECS NZ), Pre-authorized debit (PAD), Direct Debit (Autogiro), Direct Debit (Betalingsservice), PayTo | — |
| [Cashfree](/help/guides/connect-a-payment-gateway/cashfree) | Cards, UPI Autopay, eNACH | — |
| [PayU](/help/guides/connect-a-payment-gateway/payu) | Cards, UPI Autopay | — |

### Regions and currencies

| Gateway | Regions | Currencies |
| --- | --- | --- |
| [Stripe](/help/guides/connect-a-payment-gateway/stripe) | Where Stripe serves your business. ACH in the US, SEPA in the EU | [132 currencies](/help/guides/connect-a-payment-gateway/stripe#currencies). Direct Debit (ACH): USD. Direct Debit (SEPA): EUR |
| [PayPal](/help/guides/connect-a-payment-gateway/paypal) | Where PayPal serves your business | [25 currencies](/help/guides/connect-a-payment-gateway/paypal#currencies) |
| [Razorpay](/help/guides/connect-a-payment-gateway/razorpay) | India | [124 currencies](/help/guides/connect-a-payment-gateway/razorpay#currencies) |
| [Square](/help/guides/connect-a-payment-gateway/square) | The country of each Square location | [AUD, CAD, EUR, GBP, JPY, USD](/help/guides/connect-a-payment-gateway/square#currencies) |
| [Braintree](/help/guides/connect-a-payment-gateway/braintree) | Where Braintree serves your business. Venmo in the US | [126 currencies](/help/guides/connect-a-payment-gateway/braintree#currencies). Venmo: USD |
| [Checkout.com](/help/guides/connect-a-payment-gateway/checkoutcom) | Where Checkout.com serves your business | [141 currencies](/help/guides/connect-a-payment-gateway/checkoutcom#currencies) |
| [Adyen](/help/guides/connect-a-payment-gateway/adyen) | Where Adyen serves your business | [135 currencies](/help/guides/connect-a-payment-gateway/adyen#currencies) |
| [Mollie](/help/guides/connect-a-payment-gateway/mollie) | Where Mollie serves your business | [27 currencies](/help/guides/connect-a-payment-gateway/mollie#currencies). Direct Debit (SEPA): EUR |
| [Authorize.net](/help/guides/connect-a-payment-gateway/authorizenet) | Where Authorize.net serves your business. eCheck for US bank accounts | [AUD, CAD, EUR, GBP, NZD, USD](/help/guides/connect-a-payment-gateway/authorizenet#currencies). eCheck (ACH): USD |
| [GoCardless](/help/guides/connect-a-payment-gateway/gocardless) | UK, euro area, US, Australia, New Zealand, Canada, Sweden and Denmark | [GBP, EUR, USD, AUD, NZD, CAD, SEK, DKK](/help/guides/connect-a-payment-gateway/gocardless#currencies) |
| [Cashfree](/help/guides/connect-a-payment-gateway/cashfree) | India | [AED, EUR, GBP, INR, JPY, USD](/help/guides/connect-a-payment-gateway/cashfree#currencies). Saved payment methods: INR, USD, EUR. UPI Autopay: INR. eNACH: INR |
| [PayU](/help/guides/connect-a-payment-gateway/payu) | India | [INR](/help/guides/connect-a-payment-gateway/payu#currencies) |
<!-- /generated:gateway-table -->

::warning
**Check the permissions before you go live.** Connecting checks only that the gateway accepts the
key. A key without a permission it needs still connects, and fails later: on a refund, a saved
card or the webhook. Read the **Permissions** section of your gateway's guide.
::

## Use more than one

You can connect several accounts to one business. Two Minute Billing selects which to use from the
currency, the payment method and what the customer does: pay now, or save a payment method.

That is how you run one gateway for rupee payments and another for everything else — without
your customers or your catalog knowing anything about it.

<!-- generated:setup-only -->
**Pay now uses an account that can take a payment now.** An account on [GoCardless](/help/guides/connect-a-payment-gateway/gocardless) only saves payment methods (it sets up a mandate), so Two Minute Billing does not use it when a customer pays an invoice now.
<!-- /generated:setup-only -->

**Renewals stay on the account that saved the payment method.** Only that account can charge it,
so a renewal never moves to another account. If you disable that account, its renewals fail until
you enable it again or the customer saves a new payment method.

**When more than one account matches,** Two Minute Billing uses the business's default gateway
account. If no matching account is the default, the payment is refused with a message to set a
default.

::note
**An unmapped currency is refused, not guessed.** If you sell in a currency no connected account handles, the charge is refused at the point of
attempt. It is never quietly routed through an account that happens to be configured — you would
only discover that weeks later in a reconciliation.
::

## Check it works

Create a customer in test mode, save a payment method with the test details in your gateway's
guide (under **Test it**), and collect an invoice. **Logs** shows the actual call to the provider and what came back.

## When a payment provider tells you something later

Providers sometimes confirm or reverse a payment hours after the fact. Two Minute Billing listens
for those and keeps your records straight: a payment that settles late is marked paid, and one
that reverses reopens the invoice so it goes back into your retry queue.

You do not have to reconcile that by hand.

If Two Minute Billing cannot process a message from your gateway, it tries again on its own for
about four days, also after the gateway stops sending it. If the last try fails, **Gateway
Webhooks** shows the message with the reason, and you can select **Replay** to try again.

## Related

- [Multi-gateway recurring payments](/product/payments)
- [Payments and gateways in the API](/help/developers/concepts/payments)
- [Recurring INR with Razorpay mandates](/help/developers/recipes/india-mandates)
