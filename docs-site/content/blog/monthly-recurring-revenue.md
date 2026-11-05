---
title: "Monthly recurring revenue (MRR): what it is and how to calculate it"
seoTitle: "Monthly recurring revenue (MRR) formula"
description: "Monthly recurring revenue (MRR) is what customers have committed to pay each month. Learn the formula, what to leave out, and how to handle annual plans."
date: "2026-11-02"
category: Revenue metrics
type: Guide
draft: false
related:
  - what-is-dunning
cover:
  tone: growth
  coverTitle: "Monthly recurring revenue"
  cardLabel: "October · all plans"
  rows:
    - label: "Starting MRR"
      amount: "$10,000.00"
    - label: "Net new MRR"
      amount: "+$849.00"
  value: "$10,849.00"
  pill: "MRR"
bridge:
  title: "How Two Minute Billing calculates MRR"
  body: "Two Minute Billing applies the rules in this post. It converts every billing period to a month, leaves out usage, one-time charges, tax, trials and paused subscriptions, and counts a discount only when it lasts more than one bill. Every change is filed by its reason, such as new, expansion, contraction, churn, reactivation or pause, so each month's starting MRR plus its changes equals its ending MRR. You also see committed MRR, a daily MRR history, MRR in each currency, and a converted total when exchange rates cover every currency. ARR is MRR × 12. Two Minute Billing does not forecast MRR, compare you with other companies, or produce revenue-recognition schedules. Each invoice line carries its service period for your accountant."
  links:
    - label: "Reporting in Two Minute Billing"
      to: "/product/reporting"
    - label: "Subscriptions"
      to: "/product/subscriptions"
sources:
  - title: "US SEC, Release 33-10751, Commission Guidance on MD&A of Key Performance Indicators and Metrics (effective February 25, 2020)"
    url: "https://www.sec.gov/files/rules/interp/2020/33-10751.pdf"
    checked: "2026-11-02"
  - title: "US SEC, Corporation Finance staff interpretations, Non-GAAP Financial Measures (Question 100.04)"
    url: "https://www.sec.gov/rules-regulations/staff-guidance/corporation-finance-interpretations/non-gaap-financial-measures"
    checked: "2026-11-02"
  - title: "FASB, Accounting Standards Update 2014-09, Revenue from Contracts with Customers (Topic 606), Section A"
    url: "https://storage.fasb.org/ASU%202014-09_Section%20A.pdf"
    checked: "2026-11-02"
  - title: "IFRS Foundation, IFRS 15 Revenue from Contracts with Customers"
    url: "https://www.ifrs.org/issued-standards/list-of-standards/ifrs-15-revenue-from-contracts-with-customers/"
    checked: "2026-11-02"
  - title: "American Heritage Dictionary, recur"
    url: "https://ahdictionary.com/word/search.html?q=recur"
    checked: "2026-11-02"
---

Monthly recurring revenue (MRR) is the amount your customers have committed to pay you every month for their subscriptions. To calculate it, convert each active subscription's recurring price to a monthly figure and add them up. Usage charges, one-time fees, tax, trials and paused subscriptions stay out.

::in-short
- MRR = the sum of every active subscription's recurring price, converted to one month.
- An annual plan counts at one twelfth of its price. A $490 yearly plan is $40.83 of MRR.
- MRR is a business metric, not revenue in your accounts. Cash, MRR and revenue can all differ in the same month.
- Committed MRR (CMRR) also counts what is already agreed: a booked cancellation leaves it at once, and a signed future contract joins it at once.
::

## What is monthly recurring revenue (MRR)?

MRR stands for monthly recurring revenue. It measures the predictable income a subscription business can expect each month: the sum of every active subscription's recurring price, converted to a monthly amount. "Recurring" means it happens again and again: the [American Heritage Dictionary](https://ahdictionary.com/word/search.html?q=recur) defines "recur" as "to happen or occur again or repeatedly". A customer on a $49 monthly plan adds $49 to MRR every month until the plan changes or ends.

MRR is a business metric, not an accounting figure. The revenue standards, [ASC 606](https://storage.fasb.org/ASU%202014-09_Section%20A.pdf) in the US and [IFRS 15](https://www.ifrs.org/issued-standards/list-of-standards/ifrs-15-revenue-from-contracts-with-customers/) elsewhere, do not use the term. So no rulebook tells you what goes in, and each company defines MRR for itself. This post uses the rules below, with the reason for each.

## What is the MRR formula?

The MRR formula is the sum of each active subscription's recurring price, converted to a month:

**MRR = Σ (recurring price × billing periods per year ÷ 12)**

- A monthly plan: price × 12 ÷ 12, so the price itself.
- An annual plan: price × 1 ÷ 12.
- A quarterly plan: price × 4 ÷ 12.
- A weekly plan: price × 52 ÷ 12.

For example, a $49 monthly plan plus a $490 annual plan is $49.00 + $40.83 = $89.83 of MRR.

You will also see **MRR = customers × average revenue per customer**. That gives the same answer only when you already know the average, and the average comes from MRR. Use it to explain MRR, not to calculate it.

## What counts as MRR, and what does not?

MRR counts what a customer has agreed to pay again and again, at the price they actually pay. Everything else stays out.

| Item | In MRR? | Why |
|---|---|---|
| Monthly plan and recurring add-ons | Yes, at the price on the subscription | Agreed and repeated |
| Annual or quarterly plan | Yes, converted to a month | Agreed and repeated; only the billing period differs |
| A discount that lasts more than one bill | Yes, it lowers MRR | The customer pays the lower price again and again |
| A discount for one bill only | No, MRR stays at full price | It does not repeat |
| Usage or metered charges | No | The amount changes each month and is not agreed in advance. Track it as usage revenue |
| One-time fees (setup, onboarding) | No | They do not repeat |
| Sales tax and VAT | No | You collect it for a government |
| Subscriptions in a free trial | No, until the trial converts | Nothing is agreed yet |
| Paused subscriptions | No, until they resume | Nothing is billed while paused |
| Refunds and credit notes | No change to MRR | They correct a past invoice, not the recurring price |

## How do you calculate MRR? A worked example

To calculate MRR, convert each active subscription's recurring price to a month, apply any discount that repeats, and leave out trials, pauses, usage, one-time fees and tax. For the seven subscriptions below, all in US dollars, MRR is $467.03:

| Subscription | Billing | MRR |
|---|---|---|
| Team plan | $49 per month | $49.00 |
| Team plan | $490 per year | $40.83 |
| Pro plan, 20% off with no end date | $99 per month | $79.20 |
| Pro plan, 50% off the first bill only | $99 per month | $99.00 |
| Team plan in a 14-day trial | $49 per month after the trial | $0.00 |
| Pro plan, paused | $99 per month | $0.00 |
| Growth plan, plus a $500 setup fee and $230 of usage last month | $199 per month | $199.00 |
| **Total** | | **$467.03** |

- The annual plan is $490 ÷ 12 = $40.833, which rounds to $40.83.
- The permanent discount repeats, so it counts: $99 × 0.8 = $79.20.
- The first-bill discount does not repeat, so MRR stays at $99.00.
- The setup fee and the usage stay out. So does any sales tax on these invoices.

ARR for these subscriptions is $467.03 × 12 = $5,604.36. Rounding to the cent leaves the annual plan's share at $489.96 a year, 4 cents under its $490 price.

## What are the types of MRR?

MRR changes for six reasons, and each one has a name:

- **New MRR**: a new customer's first subscription.
- **Expansion MRR**: an existing customer pays more, for example a higher plan or more seats.
- **Contraction MRR**: an existing customer pays less, for example a lower plan or fewer seats.
- **Churned MRR**: a subscription ends.
- **Reactivation MRR**: a customer who had left comes back.
- **Paused and resumed MRR**: a subscription stops billing for a time, then starts again. Count it apart from churn and reactivation.

Together they explain every change between two months. If the numbers do not add up, a change was missed or counted twice. This October has no pauses:

| October | Amount |
|---|---|
| Starting MRR | $10,000.00 |
| + New | $1,200.00 |
| + Expansion | $400.00 |
| + Reactivation | $99.00 |
| − Contraction | $250.00 |
| − Churn | $600.00 |
| **Ending MRR** | **$10,849.00** |

Net new MRR is the ending figure minus the starting one: $849.00.

**A prorated charge is not expansion MRR.** A customer moves from a $49 plan to a $99 plan halfway through a 30-day month. They pay a one-time prorated charge of $25.00 for the rest of the month ($50 × 15 ÷ 30). Expansion MRR is $50.00, the change in the monthly price. The $25.00 is a one-time charge and stays out of MRR.

**A pause is not churn.** A paused subscription leaves MRR while paused, but the customer has not left. Count it apart from churn, so a pause does not make churn look worse than it is.

## What is committed MRR (CMRR)?

Committed MRR (CMRR) is your current MRR adjusted for changes customers have already agreed to: minus subscriptions booked to cancel, plus contracts signed to start later. MRR tells you what customers pay today. CMRR tells you what they have agreed to pay, so a booked loss shows up before it happens.

Two kinds of agreed changes make the two numbers differ:

- **A booked cancellation.** A customer on a $300 plan tells you they will cancel at the end of their term. Their $300 stays in MRR until the term ends. It leaves CMRR the day the cancellation is booked.
- **A signed future start.** A new customer signs a $500 contract that starts next month. It is not in MRR until it starts. It joins CMRR the day it is signed.

| Item | MRR today | CMRR today |
|---|---|---|
| Current subscriptions | $10,000.00 | $10,000.00 |
| Booked cancellation at term end | No change yet | −$300.00 |
| Contract signed to start next month | Not yet | +$500.00 |
| **Total** | **$10,000.00** | **$10,200.00** |

Looking ahead, CMRR also drops a subscription with a fixed number of billing cycles after its last cycle, even though no one cancelled it.

Watch the gap between the two. CMRR shows you a loss the day the customer tells you about it, often weeks before it reaches MRR. That is the time to talk to the customer.

## Is MRR the same as ARR?

No. ARR (annual recurring revenue) is MRR × 12: the same recurring income, stated per year. A business with $10,849 of MRR has $130,188 of ARR.

Use MRR to follow month-to-month changes, and ARR when most of your contracts are annual or when you talk about the size of the business. Do not call total contract value ARR: a multi-year contract, or a first-year price with a one-time discount, overstates it. Calculate MRR first, then multiply.

## Is MRR the same as revenue?

No. MRR is a metric. Revenue is what your accounts recognize under ASC 606 or IFRS 15. Cash is what reached your bank. One annual plan shows the difference:

| $1,200 annual plan, paid on January 1 | January | February to December, each month |
|---|---|---|
| Cash received | $1,200 | $0 |
| MRR | $100 | $100 |
| Revenue recognized | $100 | $100 |

Under ASC 606, revenue is recognized "when (or as)" you deliver what the customer paid for, and a service is "typically" delivered over time ([FASB, ASU 2014-09](https://storage.fasb.org/ASU%202014-09_Section%20A.pdf)). For a year of software, that means across the year. Until then, the paid but undelivered part is a "contract liability": your obligation to deliver a service the customer has already paid for.

So a big January of annual renewals is a big January of cash, not of revenue or MRR. The SEC's staff say it can be misleading to present revenue that is recognized over time "as though revenue was earned when customers were billed" ([SEC non-GAAP interpretations, Question 100.04](https://www.sec.gov/rules-regulations/staff-guidance/corporation-finance-interpretations/non-gaap-financial-measures)). Keep the three numbers apart, and ask your accountant how the rules apply to your contracts.

## How do you report MRR consistently?

Write your definition down, apply it the same way every month, and say so when you change it. Because no standard defines MRR, two companies can report the same business with different MRR. Investors and your own team need to know which rules you used.

The SEC asks the same of public companies that report a business metric. Its 2020 guidance ([Release 33-10751](https://www.sec.gov/files/rules/interp/2020/33-10751.pdf)) expects "a clear definition of the metric and how it is calculated", the reasons it is useful, and how management uses it. When the calculation changes, the company should consider disclosing the difference, the reason and the effect, and recasting earlier periods. A private company has no such duty, but the same habit stops arguments about the number.

A written MRR definition answers these questions:

- Which prices count, and which are usage or one-time?
- How are annual and other billing periods converted?
- Which discounts lower MRR?
- When do trials, pauses and cancellations enter or leave?
- Which exchange rate converts other currencies, and from which date?

## Does a failed payment reduce MRR?

Not at once. A subscription whose renewal charge failed is still active while you try to collect, so it stays in MRR. It leaves MRR as churn if the subscription ends because the customer never paid. Our post on [dunning](/blog/what-is-dunning) explains that process.

## How do you calculate MRR in more than one currency?

Never add euros to dollars. Report MRR in each currency, and if you want one total, convert at a stated exchange rate on a stated date. Otherwise a change in the exchange rate looks like a change in your business.
