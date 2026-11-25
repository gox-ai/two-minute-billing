---
title: "Lemon Squeezy is shutting down: what to do before March 31, 2027"
seoTitle: "Lemon Squeezy shutting down: what to do"
description: "Lemon Squeezy stops processing payments on March 31, 2027. The key dates, what moves to Stripe Managed Payments, who cannot use it, and your three options."
date: "2026-11-24"
category: Switching platforms
type: Guide
draft: false
notTaxAdvice: true
cover:
  tone: billing
  coverTitle: "Lemon Squeezy is closing"
  cardLabel: "Key dates"
  rows:
    - label: "Sign-ups closed"
      amount: "Nov 16, 2026"
    - label: "Payments stop"
      amount: "Mar 31, 2027"
  value: "Dec 2, 2026"
  pill: "Move tooling opens"
related:
  - what-is-dunning
  - saas-sales-tax-by-state
bridge:
  title: "How Two Minute Billing handles a move from Lemon Squeezy"
  body: "Two Minute Billing is the own-gateway path. You stay the seller, and payments go to your own gateway account. Twelve gateways are supported, PayPal, Razorpay, Cashfree and PayU among them. You pay a flat monthly price and we take 0% of revenue; a Free plan covers billing below a monthly limit. We work out US sales tax, VAT and GST on every invoice; you register and file. We have no self-serve import from Lemon Squeezy, no license keys, no file delivery and no affiliate program. Talk to us before you plan the move, so we can check your setup with you."
  links:
    - label: "Lemon Squeezy alternative: the comparison"
      to: "/compare/lemon-squeezy-alternative"
    - label: "Pricing"
      to: "/pricing"
    - label: "Connect a payment gateway"
      to: "/help/guides/connect-a-payment-gateway"
sources:
  - title: "Lemon Squeezy blog, 2026 Update: Lemon Squeezy + Stripe Managed Payments (January 28, 2026)"
    url: "https://www.lemonsqueezy.com/blog/2026-update"
    checked: "2026-10-29"
  - title: "Lemon Squeezy blog, Saying goodbye to Lemon Squeezy (November 16, 2026)"
    url: "https://www.lemonsqueezy.com/blog/saying-goodbye-to-lemon-squeezy"
    checked: "2026-11-24"
  - title: "Lemon Squeezy docs, Migration: Lemon Squeezy is winding down"
    url: "https://docs.lemonsqueezy.com/migration"
    checked: "2026-11-24"
  - title: "Lemon Squeezy docs, Migration: wind-down FAQs"
    url: "https://docs.lemonsqueezy.com/migration/faq"
    checked: "2026-11-24"
  - title: "Lemon Squeezy docs, Comparing Lemon Squeezy and Stripe Managed Payments"
    url: "https://docs.lemonsqueezy.com/migration/comparison"
    checked: "2026-11-24"
  - title: "Lemon Squeezy docs, Exporting orders"
    url: "https://docs.lemonsqueezy.com/help/orders/exporting-orders"
    checked: "2026-11-24"
  - title: "Stripe documentation, Managed Payments eligibility"
    url: "https://docs.stripe.com/payments/managed-payments/eligibility"
    checked: "2026-11-24"
---

Lemon Squeezy, the merchant-of-record payments platform that Stripe acquired in 2024, is shutting down. It announced the shutdown on November 16, 2026 in its post ["Saying goodbye to Lemon Squeezy"](https://www.lemonsqueezy.com/blog/saying-goodbye-to-lemon-squeezy), closed new store sign-ups that day, and stops processing payments, subscription renewals included, on March 31, 2027. Lemon Squeezy says it [cannot extend that date](https://docs.lemonsqueezy.com/migration/faq). Every store needs a new way to take payments before then.

::in-short
- Payments and subscription renewals stop on March 31, 2027. Lemon Squeezy suggests you start moving by mid-January 2027.
- Lemon Squeezy recommends Stripe Managed Payments, another merchant of record. Its move tooling opens on December 2, 2026.
- Card subscriptions can move; PayPal subscriptions cannot, so those customers subscribe again.
- Stripe Managed Payments is not open to businesses in India, and it does not support PayPal, license keys, file delivery or affiliates. If it does not fit you, the alternatives are another merchant of record or your own payment gateway with billing software.
::

## When does Lemon Squeezy shut down?

Lemon Squeezy stops processing payments, including subscription renewals, on **March 31, 2027**, and it closed new store sign-ups on November 16, 2026. It says it cannot extend the March 31 date ([wind-down FAQ](https://docs.lemonsqueezy.com/migration/faq)). The dates below come from its [shutdown post](https://www.lemonsqueezy.com/blog/saying-goodbye-to-lemon-squeezy) and its [migration guide](https://docs.lemonsqueezy.com/migration).

| Date | What happens |
|---|---|
| November 16, 2026 | Lemon Squeezy stops accepting new users and new store sign-ups. Existing stores keep working. |
| December 2, 2026 | The move tooling for Stripe Managed Payments opens in the Lemon Squeezy dashboard. |
| Mid-January 2027 | The latest date Lemon Squeezy recommends to start your move. |
| March 31, 2027 | Lemon Squeezy stops processing transactions, including subscription renewals. |
| December 1, 2027 | The promotional Managed Payments price for merchants who moved from Lemon Squeezy ends. |

Revenue from completed transactions is still paid out, and Lemon Squeezy says it pays out remaining earnings even below its usual $50 minimum, as long as your account is in good standing ([FAQ](https://docs.lemonsqueezy.com/migration/faq)).

## What happens to my subscriptions and my customers' saved cards?

Card subscriptions can move to Stripe Managed Payments or to another provider; PayPal subscriptions cannot move, so those customers subscribe again, according to Lemon Squeezy's [wind-down FAQ](https://docs.lemonsqueezy.com/migration/faq) and [migration guide](https://docs.lemonsqueezy.com/migration).

- **To Stripe Managed Payments:** card subscriptions move without customers entering their card details again. Lemon Squeezy tells customers at least 14 days before their subscription moves.
- **Cards issued in India:** customers with these cards must authorize the payment again, even if your business is in a supported country. This rule is about the card, not about where your business is based.
- **To any other provider:** only subscriptions paid by card can move. You request the transfer through the migration form in your Lemon Squeezy dashboard (account settings, then migration). Lemon Squeezy does not publish which providers can receive the cards, so ask your new provider what it needs before you start.
- **PayPal subscriptions** cannot move to Managed Payments, because Managed Payments does not support PayPal, and only card subscriptions can go to another provider.

## What does not move to Stripe Managed Payments?

Stripe Managed Payments does not support PayPal, license keys, file and link delivery, or affiliate programs, according to Lemon Squeezy's [comparison page](https://docs.lemonsqueezy.com/migration/comparison) and [FAQ](https://docs.lemonsqueezy.com/migration/faq).

| On Lemon Squeezy today | On Stripe Managed Payments |
|---|---|
| PayPal | Not supported |
| License keys | Not offered |
| File and link delivery | Not offered |
| Affiliate program | Not offered: use a separate affiliate tool |
| Storefront | Not included: connect a storefront tool |
| Email marketing | Not included: connect your marketing tool to Stripe events |
| Checkout overlays and custom checkouts | Must be rebuilt |
| Old API calls, webhooks and checkout links | No automatic redirects: replace them |

Product data also changes shape on the way: each variant becomes its own product, descriptions over 500 characters are shortened, and only the first eight images move ([FAQ](https://docs.lemonsqueezy.com/migration/faq)).

## Is Stripe Managed Payments available in India?

No. Stripe Managed Payments is not available to businesses based in India: Stripe's [eligibility page](https://docs.stripe.com/payments/managed-payments/eligibility) does not list India among its supported business locations (checked November 24, 2026). The supported locations are:

- **North America:** the United States and Canada.
- **Europe:** every EU country, plus the United Kingdom, Norway, Switzerland and Liechtenstein.
- **Asia Pacific:** Australia, Hong Kong, Japan and Singapore.

Countries such as Brazil, Mexico, the United Arab Emirates and South Africa are not on the list either. If Managed Payments is not available where your business is, Lemon Squeezy says it [cannot move your account](https://docs.lemonsqueezy.com/migration/faq): you export your data and move to another provider yourself.

Two more limits from Stripe's eligibility page: Managed Payments does not support Stripe Connect platforms or accounts that a platform controls, and it covers eligible digital products such as SaaS, software, e-books, downloads and self-paced courses.

## What are the alternatives to Lemon Squeezy?

Lemon Squeezy merchants have three alternatives: move to Stripe Managed Payments (the option Lemon Squeezy recommends), switch to another merchant of record, or bill through your own payment gateway with billing software such as Two Minute Billing, which we make.

| Factor | Stripe Managed Payments | Another merchant of record | Your own gateway + Two Minute Billing |
|---|---|---|---|
| Who is the seller | Stripe | That provider | You |
| Who registers for and files sales tax and VAT | Stripe | That provider | You. Two Minute Billing works out US sales tax, VAT and GST on each invoice |
| Fees | 3.5% per sale plus Stripe processing fees (1.5% instead of 3.5% for moved merchants until December 1, 2027) | A percentage per sale, set by the provider | Your gateway's processing fees plus a flat monthly price, with 0% of revenue to us. Free while you bill below a monthly limit |
| PayPal | No | Ask the provider | Yes, on your own PayPal account |
| Business in India | No | Ask the provider | Yes, with Razorpay, Cashfree or PayU, and GST invoices |
| Card subscriptions move without re-entry | Yes, with Lemon Squeezy's tooling | Possible for card subscriptions; Lemon Squeezy does not publish which providers can receive them. Ask first. | Possible for card subscriptions; Lemon Squeezy does not publish which providers can receive them. We have no self-serve import from Lemon Squeezy, so talk to us first |
| License keys and file delivery | No | Ask the provider | No: connect your own tool |
| Effort | Lowest | Medium | Highest: a gateway account, tax registrations and chargebacks. The hosted checkout and customer portal come with Two Minute Billing |

Stripe Managed Payments pricing: 3.5% per transaction plus Stripe processing fees, or a promotional 1.5% instead of the 3.5% for merchants who move from Lemon Squeezy, until December 1, 2027. Lemon Squeezy's pages do not say whether Stripe's processing fees apply on top of the 1.5%; confirm before you decide. Source: Lemon Squeezy [migration guide](https://docs.lemonsqueezy.com/migration) and [FAQ](https://docs.lemonsqueezy.com/migration/faq), checked November 24, 2026.

If you look at another merchant of record, ask it five questions before you move: which countries it accepts sellers from, whether it takes PayPal, its fee per sale, whether it can receive card subscriptions from Lemon Squeezy, and how it pays out to your country.

### Which option fits you?

We make Two Minute Billing, the third option, so weigh our view accordingly.

- **Pick Stripe Managed Payments** if your business is in a supported country, you sell eligible digital products, you take cards rather than PayPal, and you want someone else to handle sales tax and VAT. It is the shortest move.
- **Pick another merchant of record** if you still want a merchant of record but Managed Payments does not support your country, PayPal or your product type.
- **Pick your own gateway with Two Minute Billing** if you want to stop paying a percentage of each sale, your subscribers pay with PayPal, or your business is in a country the merchants of record do not serve, India included. You pay a flat monthly price, bill through any of 12 gateways on your own accounts, and can self-host the open-source engine. The trade-off is real: you become the seller, so you register for sales tax or VAT where you must, file the returns and handle chargebacks, which a merchant of record does for you. See the [side-by-side comparison](/compare/lemon-squeezy-alternative).

## A checklist with dates

1. **Now:** list what you use on Lemon Squeezy: payment methods (card, PayPal), license keys, file delivery, affiliates, discounts, checkout overlays, webhooks and API calls.
2. **Now:** check where your business is based against the Managed Payments country list.
3. **By mid-December 2026:** pick your destination and open its account. Leave time for the account to be approved.
4. **December 2026:** if you use Managed Payments, install the move tooling from your Lemon Squeezy dashboard. If you go elsewhere, send the migration form for your card subscriptions and ask your new provider what it needs.
5. **By mid-January 2027:** start the move, as Lemon Squeezy recommends. Rebuild checkout links, webhooks and anything that pointed at Lemon Squeezy: there are no automatic redirects.
6. **By mid-February 2027:** email your PayPal subscribers to subscribe again on the new system, because their payments stop on March 31.
7. **By mid-March 2027:** export your orders and download your tax documents and payout statements.

## What to export before March 31, 2027

Before March 31, 2027, export your orders as a CSV from the Orders page in Lemon Squeezy, and download your tax documents and financial records. Lemon Squeezy emails the order export to the store owner ([Exporting orders](https://docs.lemonsqueezy.com/help/orders/exporting-orders)).

Keep a copy of everything you will need after the move: orders, your customer list, subscriptions with their status and renewal dates, discount codes, the license keys you issued, your product files, and your tax documents and payout statements. The order export is the only export Lemon Squeezy documents in its help pages, so ask its support how to get the rest. Lemon Squeezy issues tax documents through the payout account you used, and says it will share more about access to them after the move ([migration guide](https://docs.lemonsqueezy.com/migration)).
