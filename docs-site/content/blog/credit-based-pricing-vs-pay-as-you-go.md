---
title: "Credit-based pricing vs pay-as-you-go: how to choose"
seoTitle: "Credit-based pricing vs pay-as-you-go"
description: "Pay-as-you-go vs prepaid, worked through one customer's month: pack discounts, rollover, running out of credit, and how ASC 606 treats unused credit."
date: "2026-11-02"
category: Pricing and proration
type: Guide
draft: false
related:
  - ai-pricing-models
  - monthly-recurring-revenue
cover:
  tone: neutral
  coverTitle: "Pricing with credits"
  cardLabel: "Credit pack · 1,000 credits"
  rows:
    - label: "Face value"
      amount: "$10.00"
    - label: "Pack discount"
      amount: "−$1.00"
  value: "$9.00"
  pill: "Prepaid"
bridge:
  title: "How Two Minute Billing handles credits"
  body: "Two Minute Billing sells credit the way this post describes. You define your own credit unit, such as 1 credit = $0.01, and sell it in packs at a discount, include it in a plan with the rollover rule you choose, or give it as a promotion. Paid credit starts when its invoice is paid. Your app can check a customer's balance before each call. When credit runs out, you decide per customer: block, allow a small overdraft, or bill the rest on the next invoice. Two Minute Billing does not decide your tax treatment or produce revenue-recognition schedules."
  links:
    - label: "AI billing in Two Minute Billing"
      to: "/solutions/ai-billing"
    - label: "Prepaid AI credits with the API"
      to: "/help/developers/recipes/prepaid-ai-credits"
sources:
  - title: "FASB, Accounting Standards Update 2014-09, Revenue from Contracts with Customers (Topic 606), Section A, paragraphs 606-10-55-46 to 55-49 (customers' unexercised rights)"
    url: "https://storage.fasb.org/ASU%202014-09_Section%20A.pdf"
    checked: "2026-11-02"
---

::in-short
- With credit-based pricing, the customer pays first and spends a balance as they use your product. With pay-as-you-go, they use first and pay at the end of the period.
- Credits move cash to you sooner and cap what a customer can run up. Pay-as-you-go is simpler to explain and stops a customer mid-task only if you set a spending limit.
- A credit pack can sell credit below its face value. The difference is a discount, counted as the credit is used.
- Credit a customer has paid for is a liability in your books until it is used. Under ASC 606, the US revenue standard, credit that is never used ("breakage") becomes revenue as the rest is used, or when its use becomes remote.
::

## What is credit-based pricing?

Credit-based pricing, also called a credit pricing model, is a model where the customer gets a balance of credits up front and spends it as they use your product. A credit is a unit you define, for example 1 credit = $0.01. Each action costs a number of credits: a short AI reply might cost 5, a long report 400.

Customers get credit in three ways:

- **They buy a pack**, such as 1,000 credits, before they use it.
- **Their plan includes credit** each billing period, for example 5,000 credits a month.
- **You give it to them** as a promotion, such as a welcome bonus.

The balance goes down with each action. When it reaches zero, you decide what happens next: stop the action, allow a small overdraft, or bill the rest later.

## What is pay-as-you-go pricing?

Pay-as-you-go is a model where the customer uses your product first and pays at the end of the period for what they used. Usage is measured, priced at your rates and billed on the next invoice, which is [usage-based billing](/solutions/usage). For AI products, that is usually a [per-token rate card](/blog/ai-pricing-models): a price for each model and token type.

Nothing is paid in advance, and nothing runs out. The bill is known only when the period ends.

## Credit-based pricing vs pay-as-you-go: what is the difference?

The main difference is timing. With credit-based pricing the customer pays before using your product; with pay-as-you-go they pay after the period ends. In pay-as-you-go vs prepaid terms, that timing decides who carries the risk until the money arrives:

| | Credit-based pricing | Pay-as-you-go |
|---|---|---|
| When the customer pays | Before the usage | After the period ends |
| Who carries the risk of non-payment | Nobody, for usage the credit covers | You, until the invoice is paid |
| How predictable the bill is | The customer chooses what to spend | Known only at the end of the period |
| What a usage spike does | Uses up the balance sooner | Makes the next bill larger |
| What happens at zero | You choose: stop, overdraft or bill later | Nothing; usage keeps billing |
| Unused value | Credit left on the balance, which can expire | None |
| What the customer has to understand | What one credit buys | Your rates per unit |

## How does the same month look under each model?

A customer who uses $12.40 of your product in October pays $12.40 on November 1 under pay-as-you-go. On credits, the same customer pays $9.00 on October 1 for a 1,000-credit pack and runs out on October 24. One credit = $0.01 of usage, so $12.40 is 1,240 credits.

**With pay-as-you-go**, nothing is paid during October. On November 1 the customer receives an invoice for $12.40. You collect it when the card is charged, if the charge succeeds.

**With credits**, the customer buys a 1,000-credit pack for $9.00 on October 1, and you have the money that day. By October 24 they have used all 1,000 credits. The last 240 credits' worth of usage ($2.40) depends on your rule for an empty balance:

| Rule at zero | What happens to the last $2.40 | What the customer pays for October |
|---|---|---|
| Stop | The action is refused until they buy more credit | $9.00 |
| Bill later | The usage bills on the next invoice at $0.01 per credit | $9.00 + $2.40 = $11.40 |
| They buy a second pack | 240 credits come from the new pack; 760 are left for November | $18.00, with 760 credits left ($7.60 at face value, $6.84 at the price paid) |

The customer on credits paid $9.00 for $10.00 of usage, because the pack was sold at a discount. You traded $1.00 of price for cash on day one and for no risk of a failed charge on that $10.00.

## How do you price a credit pack?

A credit pack has a face value and a price. The face value is what the credits would cost at your normal rate. The price is what the customer pays. A pack of 1,000 credits at $0.01 each has a face value of $10.00. Sell it for $9.00, and the customer gets a 10% discount for paying first.

Two rules keep the numbers honest:

- **Count the discount when the credit is used, not when the pack is sold.** When $10.00 of usage is paid by a $9.00 pack, you earned $9.00 for it, not $10.00. Show the usage at full price and the $1.00 difference as a discount, so your revenue matches what the customer paid.
- **Give bigger packs a bigger discount only if you can afford it at your worst margin.** The discount comes out of your margin on every credit in the pack, including credits spent on your most expensive model.

A pack can expire, for example 12 months after purchase. Say so at the point of sale, and show the expiry date next to the balance.

## How do plan credits and rollover work?

Credit rollover is a rule that moves unused plan credits into the next billing period instead of letting them expire. Plan credits are the credits a subscription includes each period. A plan at $49 a month might include 5,000 credits, granted again at each renewal. The question is what happens to credits the customer did not use.

There are three common answers:

1. **They expire.** The simplest rule: each period starts fresh.
2. **They all carry over.** The customer never loses anything, but the balance can grow without limit.
3. **Part of them carry over, with a cap and an expiry.** A middle path.

Here is the third rule as a worked example: 50% of unused plan credit carries over, at most 2,000 credits, and carried credit lasts one more month.

| Plan credit left at the end of the month | Carries to next month | Expires |
|---|---|---|
| 0 | 0 | 0 |
| 2,000 | 1,000 | 1,000 |
| 4,500 | 2,000 (the cap; 50% would be 2,250) | 2,500 |

Carried credit never carries a second time. Whatever is left of it at the end of the next month expires. Without that rule, a customer who rarely uses the product would pile up credit for years.

## What happens when credit runs out?

When the balance reaches zero, you have three choices. Pick one as the default and change it for single customers when you need to:

- **Stop the action.** The customer can't run more usage until they buy credit. This fits self-serve customers who chose credits to cap their spending.
- **Allow a small overdraft.** The balance can go a fixed amount below zero, such as 200 credits ($2.00), before the action stops. This fits trusted customers, so one long task doesn't fail halfway.
- **Bill the rest later.** Usage continues, and what the credit didn't cover goes on the next invoice. This fits larger customers on contracts, who would rather pay a bill than see an error.

Whichever you choose, tell the customer before the balance runs out, not after. A low-balance email when 20% of the last pack or plan credit is left gives them time to buy more.

## How do you stop two requests spending the same credit?

Reserve the credit before the request starts. An AI product often runs many requests for one customer at the same time. If each request only checks the balance, two requests that each need 40 credits can both see the last 50 and both go ahead, and the customer ends up below zero.

A reservation takes the estimated cost off the available balance while the request runs:

1. Before the call, reserve the estimate, for example 40 credits. A second call that also needs 40 now sees only 10 available.
2. If the balance can't cover it, refuse the call before it costs you anything.
3. After the call, charge the actual usage and close the reservation. If the call fails, release it.

No two calls can spend the same credit, even with hundreds running at once. If a call costs more than its estimate, the balance can still dip by the difference, so estimate high. A reservation that is never closed should expire on its own after a short time, so a crashed request doesn't lock up credit.

## How do you account for unused credit?

Credit is not revenue when you sell it. Under the US revenue standard, ASC 606, a prepayment creates a contract liability: you owe the customer the service. Paragraph 606-10-55-46 says you remove that liability and recognize revenue "when it transfers those goods or services". For credits, that is when the customer spends them.

Breakage is credit that a customer pays for and never uses. For a nonrefundable prepayment, ASC 606 calls it the customer's "unexercised rights" (606-10-55-47), and how you recognize it depends on what you expect:

- **If you expect to be entitled to unused credit**, and can estimate it without risking a large reversal later (606-10-32-11 to 32-13), you recognize that expected amount as revenue "in proportion to the pattern of rights exercised by the customer" (606-10-55-48). In other words, a little at a time, as the rest of the credit is used.
- **If you don't expect any to go unused**, you recognize the unused credit only when "the likelihood of the customer exercising its remaining rights becomes remote" (606-10-55-48), for example when it expires.
- **If a law requires you to hand unused amounts to another party**, such as a government under unclaimed property laws, that amount stays a liability and is never your revenue (606-10-55-49).

This is the reason to record every credit movement: each grant, use, expiry and rollover. Your accountant needs that history to estimate breakage. Check your treatment with them, and decide too whether tax is charged when credit is bought or when it is used, which depends on where you sell.

## Which should you choose?

Choose credits when you need cash before usage and your customers want a spending cap. Choose pay-as-you-go when your customers expect an invoice and must never be stopped mid-task. In more detail, choose credit-based pricing when:

- your cost per action varies a lot, and you want cash before you pay the model provider;
- your customers want to cap what they spend, or can't be billed after the fact;
- you sell self-serve to many small customers, where chasing failed charges costs more than it brings in.

Choose pay-as-you-go when:

- your customers are larger businesses that expect an invoice, not a balance to top up;
- stopping a customer mid-task would hurt more than the risk of an unpaid bill;
- you want the simplest possible price page: one rate per unit.

Many products use both. A plan includes credit each month, and usage beyond it bills at the end of the month at a rate card. For example, the $49 plan above includes 5,000 credits. A customer who uses 6,200 credits in a month pays $49 plus 1,200 × $0.01 = $12.00 on the next invoice, $61.00 in all. The customer gets a predictable base, and you never have to refuse work.
