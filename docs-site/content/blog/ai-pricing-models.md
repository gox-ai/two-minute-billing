---
title: "AI pricing models: how to price an AI product"
seoTitle: "AI pricing models: how to price AI"
description: "AI pricing models compared: per seat, per token, credits and per outcome. Work out list-plus vs cost-plus markup, rate cards and mid-month price changes."
date: "2026-11-02"
category: Pricing and proration
type: Guide
draft: false
related:
  - monthly-recurring-revenue
cover:
  tone: neutral
  coverTitle: "AI pricing models"
  cardLabel: "Input · per 1M tokens"
  rows:
    - label: "Model list price"
      amount: "$3.00"
    - label: "Markup 20%"
      amount: "+$0.60"
  value: "$3.60"
  pill: "List-plus"
bridge:
  title: "How Two Minute Billing prices AI usage"
  body: "Two Minute Billing bills AI usage the way this post describes. You price each model and token type with a rate card, or bill from a dated model price list with a markup on the list price or on your own cost. Your cost is kept apart from the selling price, so you see margin by model and by customer, after discounts and credit notes, before tax. A customer can have their own markup or rates. When a model price changes mid-period, the invoice splits the line at the change, and each line names the price it came from. A large or strange change to the list is held for review before it reaches a bill. Two Minute Billing does not choose your price, forecast your model costs, or promise what a provider will charge."
  links:
    - label: "AI billing in Two Minute Billing"
      to: "/solutions/ai-billing"
    - label: "Bill AI tokens with the API"
      to: "/help/developers/recipes/bill-ai-tokens"
sources:
  - title: "Anthropic, Claude API pricing (model prices per million tokens)"
    url: "https://platform.claude.com/docs/en/about-claude/pricing"
    checked: "2026-11-02"
  - title: "Pydantic, genai-prices: prices for LLM inference APIs (MIT license)"
    url: "https://github.com/pydantic/genai-prices"
    checked: "2026-11-02"
---

::in-short
- Five AI pricing models are in common use: per seat, per token, prepaid credits, a seat with included usage, and per outcome. They differ in who carries the cost of each model call.
- Per-token pricing charges input, output and cached tokens at separate rates, quoted per million tokens.
- A 20% markup on the list price and a 20% markup on your own cost are different prices. On a $3.00 list price and a $2.00 cost, they are $3.60 and $2.40.
- When a model's price changes in the middle of a month, split the bill at the change. Usage that already happened keeps its old price.
::

## What are the AI pricing models?

An AI pricing model is the rule that turns product usage into a bill. Five are in common use: per seat, per token, prepaid credits, a seat with included usage, and per outcome. They differ mainly in one thing that classic software pricing never had to think about: who pays when a model request costs more than you expected.

| Pricing model | The customer pays for | Who carries the model cost |
|---|---|---|
| Per seat | Each user, each month | You. A heavy user pays the same seat price as a light one. |
| Per token ([usage-based](/solutions/usage)) | The tokens they use, per model | The customer. Their bill rises with their usage. |
| Prepaid credits | A balance, spent as they use the product | Shared. You set what a credit buys; they buy credits up front. |
| Seat with included usage | A seat price, plus a charge above an allowance | You up to the allowance, the customer above it. |
| Per outcome | A finished task, such as a resolved ticket | You. A hard task costs more to complete, at the same price. |

Many AI products use a mix: a plan that people recognize, plus a usage charge or credits for the part that costs you money each time. The sections below work through the per-token part, because every other model is built on knowing what a request costs.

## Why are AI products priced differently?

AI products are priced differently because every request has a cost of its own. The product sends tokens to a model, and the model provider charges you for each one. Classic software costs almost nothing extra when a customer uses it more.

Take one model as an example. On November 2, 2026, [Anthropic's price list](https://platform.claude.com/docs/en/about-claude/pricing) charged these amounts for Claude Sonnet 4.6 (newer models on the same page have their own prices):

| Token type | Price per 1M tokens |
|---|---|
| Input | $3.00 |
| Output | $15.00 |
| Cache writes (kept 5 minutes) | $3.75 |
| Cache hits (input read from cache) | $0.30 |

Output costs five times as much as input. Writing to the cache costs more than fresh input, and reading from it costs a tenth. So the same number of tokens can cost very different amounts, depending on what a customer does.

A flat seat price can lose money on heavy users. On a $20 per user per month plan, a user who sends 2 million input tokens and gets 1 million output tokens back costs you $6.00 + $15.00 = $21.00 in model fees alone. That user loses you money before you pay for anything else. A flat price works only if you know your heaviest users stay well under it, or if you cap what a seat includes.

## How does per-token pricing work?

Per-token pricing, also called token-based LLM pricing, bills each customer for the tokens (the units of text a model reads and writes) that their requests used, at a rate for each model and token type. Rates are quoted per million tokens, the same way model providers quote them.

A worked example. A customer's requests used 1,234,567 input tokens and 456,789 output tokens this month. You charge $3.00 per 1M input tokens and $15.00 per 1M output tokens:

| Line | Tokens | Rate | Exact amount | Billed |
|---|---|---|---|---|
| Input | 1,234,567 | $3.00 per 1M | $3.703701 | $3.70 |
| Output | 456,789 | $15.00 per 1M | $6.851835 | $6.85 |
| **Total** | | | | **$10.55** |

Two details matter here:

- **Round once, on the invoice line.** A single request often costs a fraction of a cent. Round each request to the cent and the errors add up over thousands of requests. Add the exact amounts for the period, then round the line. The lines here add to $10.55, not the $10.56 that the exact total of $10.555536 would round to, because the invoice total is the sum of its rounded lines.
- **Rate each cache type on its own row.** Cache reads cost a tenth of input, but cache writes cost more than input. Providers also differ on whether their input count already includes cached tokens. Check how yours reports them before you subtract, or you bill the same tokens twice.

This example charges exactly what the provider charges, so it makes no money. The next question is how much to add.

## Cost-plus or list-plus: which markup should you use?

Use list-plus to keep the discount you negotiate with a model provider. Use cost-plus to pass that discount on to your customers. The two ways to add a markup are:

- **List-plus:** a percentage on the provider's public list price.
- **Cost-plus:** a percentage on what the model actually costs you.

They are the same when you pay the list price. They differ when you pay less, for example under a volume contract with the provider. Say the list price for input is $3.00 per 1M tokens, your contract gives you $2.00, and your markup is 20%:

| Markup on | Customer pays per 1M | Your cost per 1M | Margin per 1M | Margin as % of price |
|---|---|---|---|---|
| List price | $3.60 | $2.00 | $1.60 | 44.4% |
| Your cost | $2.40 | $2.00 | $0.40 | 16.7% |

**List-plus keeps your discount.** The customer pays the public price plus your markup, and whatever you negotiated below list is yours. Use it when customers compare you with the provider's public prices, or when your discount is what funds the rest of your product.

**Cost-plus passes your discount on.** The customer pays your real cost plus a fixed share. Use it when you sell on being cheap, or when a large customer asks to see what the model costs you.

Note that markup and margin are different numbers. A 20% markup on cost is a 16.7% margin on the price, because the margin is divided by the selling price, not the cost. Decide on the margin you need, then work back: markup = margin ÷ (1 − margin). A 30% margin needs a markup of about 42.9%.

## What is a rate card for AI usage?

A rate card for AI usage is a table of selling prices for each model and token type, plus a default rate for anything not listed. This card prices Sonnet 4.6 and Opus 4.6 at Anthropic's list price plus 20%:

| Row | Rate per 1M tokens |
|---|---|
| Sonnet 4.6, input | $3.60 |
| Sonnet 4.6, output | $18.00 |
| Sonnet 4.6, cache writes | $4.50 |
| Sonnet 4.6, cache hits | $0.36 |
| Opus 4.6, input | $6.00 |
| Opus 4.6, output | $30.00 |
| Opus 4.6, cache hits | $0.60 |
| Default (any other model or token type) | $6.00 |

Opus 4.6 is listed at $5 input, $0.50 cache hits and $25 output per 1M tokens, so its rows are those prices plus 20%.

The default row is the one people forget. Your engineers will try a new model before anyone updates the price list. Without a default, that usage bills at zero or fails to bill at all. With one, it bills at a rate you chose. Choose it with care: a default that is too low loses money on exactly the usage nobody planned for, and one that is too high overcharges. Treat it as a safety net, and add a proper row as soon as a new model appears.

Because the most specific row wins, you can price broadly and make exceptions. One row can price all output tokens, and a second row can price output on one expensive model differently.

## What happens when a model price changes mid-month?

When a model price changes mid-month, split the invoice line at the moment of the change. Usage before the change bills at the old rate, and usage after it bills at the new one. If you bill from the list price, a provider's price change reaches your customers' rates too.

A worked example. Input on a model is $3.00 per 1M tokens until the 15th at 10:00 UTC, then $2.50. You bill list price plus 20%, so your rate moves from $3.60 to $3.00. The customer used 1,234,567 input tokens before the change and 456,789 after it:

| Line | Tokens | Rate | Exact amount | Billed |
|---|---|---|---|---|
| Input, to the 15th 10:00 UTC | 1,234,567 | $3.60 per 1M | $4.4444412 | $4.44 |
| Input, from the 15th 10:00 UTC | 456,789 | $3.00 per 1M | $1.370367 | $1.37 |

Each line says which price it used, so the customer can check the bill against the provider's public prices.

Who carries a price change depends on how you price:

| How you price | A provider price cut | A provider price rise |
|---|---|---|
| List-plus | The customer's rate falls. Your margin per token falls with it. If the list price falls below your contract cost, you sell at a loss until your contract changes. | The customer's rate rises. Your margin per token rises. |
| Cost-plus | The customer's rate and your margin stay the same, unless your contract price changes. | Same as a cut: no change unless your contract price changes. |
| Fixed rate card | The customer's rate stays. Your margin grows. | The customer's rate stays. Your margin shrinks. |

One more risk: a price list is data, and data can be wrong. If you take model prices from a shared list such as [genai-prices](https://github.com/pydantic/genai-prices), whose own README warns that its prices "will not be 100% accurate", treat each update as input to check, not as truth. A row that drops to zero, or moves by ten times overnight, is more likely an error than a real price. Hold changes like that for a person to check before they reach a customer's bill.

## How do you measure margin on AI usage?

Margin on usage is what the customer paid for it minus what it cost you. Two rules keep the figure honest:

- **Revenue after discounts and credit notes, before tax.** A coupon or a refund reduces what you earned. Tax is collected for the government, so it is not revenue.
- **The best cost you have.** Use the exact cost of each request when you record it. When you don't have that, use your contract price, and when you don't have that, use the list price.

Measure margin by model and by customer, not only in total. A total margin of 40% can hide one customer who uses your most expensive model at a loss. With margin by customer you can see that before the renewal, and offer that customer a different plan or their own rates.

If a usage line has no cost at all, for example a model you host yourself and never priced, leave it out of the margin and count it separately. If you count it as zero cost, your margin looks better than it is.

## Can you combine a plan with usage or credits?

Yes. Three combinations are common:

1. **A seat price plus usage.** Each user pays a monthly fee, and tokens are billed on top at your rate card. The fee covers your fixed costs and the usage covers the model.
2. **A plan with included usage.** The plan includes a set number of tokens or requests each month, and usage above that is billed per token. Customers get a predictable bill until they go past the allowance.
3. **A plan with credits.** Each renewal adds credits to the customer's balance, and credits can roll over to the next period up to a limit. Customers can also buy credit packs when they run low.

Credits suit products where one action can use very different numbers of tokens, such as generating a short reply or a long report. The customer sees a simple balance, and you set what each credit costs in tokens. Credits also move money to you before the usage happens, which a per-token bill at the end of the month does not.

## Which AI pricing model should you choose?

Choose by three questions, in this order:

1. **How much does the cost of one request vary?** If one customer's request can cost a hundred times another's, a flat seat price puts that risk on you. Charge per token, or sell credits.
2. **Do your customers need a predictable bill?** Buyers with a fixed budget prefer a plan with included usage, or credits they buy up front, to a bill that is only known at month end.
3. **Can you measure the outcome without dispute?** Per-outcome pricing works when you and the customer agree on what counts, such as a ticket marked resolved. If they can argue about it, price the work, not the result.

Whichever model you pick, write the rule down and apply it to every customer: what is included, what is billed, at what rate, and what happens when a model's price changes. A customer who can check each line against the rule is less likely to dispute the bill.
