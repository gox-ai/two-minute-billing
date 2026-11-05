---
title: Recipes
description: "Task-based walkthroughs for the billing API: trials, usage-based billing, usage events, AI tokens, prepaid credits, spend limits and automatic top-up, plan changes, coupons, one-time purchases, dunning, India GST and mandates."
seo:
  title: "Billing API recipes and walkthroughs"
navigation: false
---

Each recipe is one job, end to end: the calls in TypeScript and curl, the real response, what to
check, and the errors you are likely to meet. The runnable examples on these pages are
checked against the API by an automated test in our repository.

**Subscriptions**
- [Trials](/help/developers/recipes/trials) — free trials with and without a card, and what happens when one ends.
- [Usage-based billing](/help/developers/recipes/usage-based-billing) — meter consumption and bill it in arrears.
- [Meter usage events](/help/developers/recipes/meter-usage-events) — send events keyed by your own ids, count them with meters, bill a rate card.
- [Bill AI tokens](/help/developers/recipes/bill-ai-tokens) — a rate per model and token type, or the model price list with a markup on the list price or on your cost, and your margin.
- [Prepaid AI credits](/help/developers/recipes/prepaid-ai-credits) — credit units, credit packs and plan credits, an access check and holds before each call.
- [Spend limits and automatic top-up](/help/developers/recipes/spend-limits-and-auto-top-up) — spend limits per customer or user, alerts, credit runway, automatic top-up, early usage invoices and a usage widget.
- [Plan changes](/help/developers/recipes/plan-changes) — upgrades, downgrades and proration.
- [Coupons](/help/developers/recipes/coupons) — reusable coupons, code sets and one-off discounts.

**Payments**
- [One-time purchases](/help/developers/recipes/one-time-purchases) — sell once through checkout, payment links or your pricing page.
- [Checkout and portal](/help/developers/recipes/checkout-and-portal) — collect a card without your API key reaching a browser.
- [Failed payments](/help/developers/recipes/failed-payments) — retry schedules, dunning and what happens when retries run out.

**India**
- [India GST invoices](/help/developers/recipes/india-gst-invoices) — CGST, SGST and IGST by place of supply.
- [Recurring INR with mandates](/help/developers/recipes/india-mandates) — off-session renewals through Razorpay e-mandates.

**Moving in**
