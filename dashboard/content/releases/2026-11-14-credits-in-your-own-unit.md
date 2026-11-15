---
title: Sell credits in your own unit
date: 2026-11-14
type: Feature
tags: Credits, Usage, Payments, Reports
summary: Sell credits that count actions, such as 1 image = 1 credit. Each usage event takes its credits when it arrives, and a declined payment always shows its reason.
---

You can now sell credits that have no money value, such as 1 image = 1 credit, with packs at
different prices. Each usage event takes its credits when it arrives, so a customer cannot spend
credit that they do not have.

## Credits in your own unit

- **A credit cost on each meter.** On the meter page, set what one event or one unit of usage
  costs in credits. A plan can have its own cost.
- **A check when each event arrives.** When a customer has no credit left, we refuse the event.
  Your app gets a 402 error and a webhook, and the refused event stays on the record.
- **Holds for AI calls.** Reserve credits before a call, then take what the call used. A job with
  several steps can take credits after each step and release the rest at the end.
- **Customers with packs only.** A customer with no subscription can buy packs and use them. The
  balance does not go below 0.
- **Automatic top-up.** When the balance falls to the level that you set, we buy a pack for the
  customer. If the card is declined, we try again on a schedule that you set, as for failed
  payments. You can let customers turn top-up on or off in the portal.
- **Revenue as credits are used.** Each hour, we take the used credits from the customer's
  grants and book the revenue at the price that the customer paid.
- **Refused usage is a cost, not usage.** A refused event does not count in usage totals. Its
  model cost still counts in your margin.

## Usage past the credit balance

- **Overage in money.** Set an overage price for each credit, or bill with the meter's own
  price. The meter's price comes first.
- **An overdraft limit.** Set how far below 0 the balance can go: for all customers, for a plan or
  for one customer. Credits that the customer buys pay an overdraft first. Usage that an
  invoice already billed is not taken again from new credit.
- **Plan renewal.** Select what happens to a negative balance that no invoice billed: carry it
  into the next period, or forgive it.
- **Overage for customers with packs only.** These customers get their own invoice for overage.
- **See overage before the invoice.** The subscription page, the portal and the upcoming
  invoice show usage past the credit balance and what the next invoice bills for it.
- **Free trials stay free.** During a free trial, usage stops when the credits run out. We do
  not bill overage, and automatic top-up waits for the trial to end.

## Reports and records

- **Deferred credit revenue by month.** For each unit: opening, sold, recognized, expired,
  refunded and closing. The closing balance agrees with your ledger.
- **Activity of each grant.** See what a grant gave, what used it and what is left.
- **Runway in units.** See how many days of credit a customer has left at their recent use.
- **Refused usage.** See the demand that you did not serve, by meter, by day or by customer.
- **A reason on each void.** When you void credit, select a reason and add a note. You can also
  void paid credit without a refund.
- **Full refund of a pack.** A credit note can refund the full price of a pack, used credits
  too. We first take the used credits from the customer's other credit in that unit.

## Payments and billing

- **Every declined payment shows its reason.** Checkout and the customer portal show the
  payment provider's reason and one next step, on every payment gateway.
- **No second payment by mistake.** When a payment provider does not answer, we check the
  payment with the provider and tell the buyer not to pay again. The subscription starts, and
  we confirm the payment later.
- **The correct email after a decline.** A declined charge sends the "payment failed" email,
  when that email is on, and not the overdue reminder.
- **Last error on payment intents.** The list shows the last error of each payment.
- **Late usage on held invoices.** You can hold an invoice that has usage lines so that late
  usage can arrive: up to 30 days, and at most half of the billing period.
- **Late usage after a cancellation.** If you turn it on, usage that arrives after a subscription
  ends goes on one more invoice. We send at most one each day, above a minimum amount.
- **More model prices.** The model price list now has prices for each image, each second of
  video or audio, and each character, with quality and resolution.
- **Billy starts closed.** A new tab opens without Billy. A reload keeps Billy where it was.
