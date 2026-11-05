---
title: Usage and AI billing
description: "Bill what your customers use: price usage with tiers and commitments, count usage events with meters, bill AI models from a price list, and sell prepaid credit."
seo:
  title: "Usage-based and AI billing guides"
navigation:
  title: "Overview"
  icon: i-lucide-activity
---

Usage billing charges for what a customer did in a period: API calls, gigabytes stored, AI tokens.
Your app reports the usage, and Two Minute Billing prices it and puts it on the invoice. These
guides cover the jobs you do in the dashboard. For the API calls behind them, see the
[developer recipes](/help/developers/recipes).

## Two ways to report usage

- **Usage records** go to one subscription item. They suit a few simple counters, such as seats
  or a monthly quantity.
- **Usage events** name the customer by a key your app already has, such as a workspace id. A
  **meter** counts them, and one price can bill each model, region or plan tier at its own rate.
  Use events for AI usage and for anything with many values.

Both bill in arrears: the usage of a period goes on an invoice after the period ends. To take
payment first, sell prepaid credit.

## The guides

- [Price usage and commitments](/help/guides/usage-and-ai-billing/usage-pricing): tiered, volume
  and package pricing, monthly usage invoices on an annual plan, a minimum commitment with a
  true-up, and usage so far in the dashboard and the portal.
- [Meters and rate cards](/help/guides/usage-and-ai-billing/meters-and-rate-cards): create a
  meter, send a test event, add usage keys, and bill a rate for each model and token type.
- [Bill from the AI model price list](/help/guides/usage-and-ai-billing/model-price-list): bill each
  AI model at its list price or your cost plus a markup, and see your margin.
- [Prepaid credits](/help/guides/usage-and-ai-billing/prepaid-credits): credit units, credit
  packs, plan credits with rollover, and blocking usage when credit runs out.
- [Spend limits, alerts and automatic top-up](/help/guides/usage-and-ai-billing/spend-limits-and-auto-top-up):
  cap spend, warn before a limit, top up credit automatically, invoice usage early, preview a rate
  change and show usage in your app.
