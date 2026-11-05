---
title: "Net revenue retention (NRR): formula, examples and NRR vs GRR"
seoTitle: "Net revenue retention (NRR) formula"
description: "Net revenue retention (NRR) shows how much recurring revenue your existing customers keep paying. Learn the formula, NRR vs GRR, and monthly vs annual NRR."
date: "2026-11-02"
category: Revenue metrics
type: Guide
draft: false
related:
  - monthly-recurring-revenue
  - what-is-dunning
cover:
  tone: growth
  coverTitle: "Net revenue retention"
  cardLabel: "October · starting customers"
  rows:
    - label: "Starting MRR"
      amount: "$10,000.00"
    - label: "Ending MRR"
      amount: "$10,100.00"
  value: "101%"
  pill: "NRR"
bridge:
  title: "How Two Minute Billing calculates NRR"
  body: "Two Minute Billing calculates gross revenue retention, net revenue retention and the quick ratio for the last complete month, from the same MRR history that gives you MRR. New business is left out of both retention rates. A pause counts as a loss and a resume as a return. Retention reports count only the subscriptions that were paying at the start of the month, show the month split by plan, and include cohort retention grids you can export. Two Minute Billing does not compare your NRR with other companies or forecast it."
  links:
    - label: "Reporting in Two Minute Billing"
      to: "/product/reporting"
    - label: "Subscriptions"
      to: "/product/subscriptions"
sources:
  - title: "US SEC, Release 33-10751, Commission Guidance on MD&A of Key Performance Indicators and Metrics (effective February 25, 2020)"
    url: "https://www.sec.gov/files/rules/interp/2020/33-10751.pdf"
    checked: "2026-11-02"
---

::in-short
- NRR = (starting MRR + expansion − contraction − churn) ÷ starting MRR, counting only the customers you had at the start of the period.
- GRR is the same without expansion, so it can never go above 100%. NRR can.
- 101% NRR means your existing customers pay you 1% more than at the start of the period, after every downgrade and cancellation.
- A year of 101% months does not mean 112.7% annual NRR. Annual NRR compares today's MRR from last year's customers with what they paid a year ago.
::

## What is net revenue retention (NRR)?

Net revenue retention (NRR), also called net dollar retention (NDR), is the percentage of recurring revenue you keep from the customers you already had, after upgrades, downgrades and cancellations. An NRR of 101% for October means the customers paying you on October 1 had 1% more MRR on October 31.

NRR deliberately leaves out new customers. Ask: if you stopped selling today, would the revenue you already have grow or shrink? It is built from [monthly recurring revenue (MRR)](/blog/monthly-recurring-revenue), so it follows the same rules for annual plans, discounts and usage that your MRR does.

## What is the NRR formula?

The net revenue retention formula divides what your starting customers pay at the end of a period by what they paid at the start:

**NRR = (starting MRR + expansion − contraction − churn) ÷ starting MRR**

- **Starting MRR:** the MRR of every customer paying at the start of the period.
- **Expansion:** MRR added by those customers through upgrades, extra seats or add-ons.
- **Contraction:** MRR lost by those customers through downgrades or fewer seats, while they stay.
- **Churn:** MRR lost when those customers cancel.

Every term is restricted to the starting customers. A customer who joins during the period adds new MRR, and new MRR is not in the formula. You can use ARR instead of MRR; the ratio is the same, because ARR is MRR × 12.

## How do you calculate net revenue retention? A worked example

To calculate NRR, add up what each customer paying on the first day of the period pays on the last day, then divide by what they paid on the first day. Leave out anyone who joined during the period.

Take five customers who pay $10,000 of MRR in total on October 1. During October:

| Customer | MRR on October 1 | What happened in October | MRR on October 31 |
|---|---|---|---|
| A | $4,000.00 | Upgraded to a larger plan | $4,600.00 |
| B | $2,500.00 | Added seats | $2,800.00 |
| C | $1,500.00 | Downgraded | $1,200.00 |
| D | $1,500.00 | No change | $1,500.00 |
| E | $500.00 | Cancelled | $0.00 |
| **Total** | **$10,000.00** | | **$10,100.00** |

That gives expansion of $900 (A and B), contraction of $300 (C) and churn of $500 (E):

- **NRR** = ($10,000 + $900 − $300 − $500) ÷ $10,000 = **101%**
- **GRR** = ($10,000 − $300 − $500) ÷ $10,000 = **92%**

Now add a sixth customer, F, who signs up on October 10 at $800 a month and upgrades to $1,000 on October 20. F is not in either rate. F was not a customer on October 1, so F's $1,000 is new MRR, including the $200 upgrade. Your total MRR on October 31 is $11,100, but NRR stays 101%.

Watch for this mistake in a home-made NRR: counting a new customer's first upgrade as expansion. It makes NRR look better every month you sign customers who upgrade quickly.

## What is the difference between NRR and GRR?

The difference is expansion: NRR counts upgrades from existing customers and gross revenue retention (GRR) does not, so GRR can never go above 100% while NRR can. GRR measures only what you lost from the starting customers:

**GRR = (starting MRR − contraction − churn) ÷ starting MRR**

| | Net revenue retention (NRR) | Gross revenue retention (GRR) |
|---|---|---|
| Counts expansion | Yes | No |
| Counts contraction and churn | Yes | Yes |
| Highest possible value | No limit | 100% |
| In the example above | 101% | 92% |
| Answers | Does the revenue you already have grow? | How much of it do you keep without selling more? |
| Can hide | Heavy churn, covered by a few large upgrades | Strong growth inside the customers you keep |

Read them together. In the example, NRR of 101% looks steady, but GRR of 92% says 8% of the starting revenue was lost in one month. Upgrades from two customers covered it this time. If those upgrades stop, the same losses give NRR of 92%.

## Can NRR be above 100%, and what do 95% and 120% mean?

Yes. NRR is above 100% whenever expansion from your starting customers is larger than what they took away through downgrades and cancellations. GRR can never go above 100%, because it leaves expansion out.

120% NRR means your starting customers now pay 20% more than at the start, after every downgrade and cancellation. 95% means they pay 5% less. For $10,000 of starting MRR:

| NRR | What the starting customers pay at the end | What it means |
|---|---|---|
| 95% | $9,500 | You lose $500 of MRR from existing customers. You need $500 of new MRR just to stay level. |
| 100% | $10,000 | Losses and expansion cancel out. All growth must come from new customers. |
| 120% | $12,000 | Existing customers add $2,000. You grow even with no new sales. |

### Is 95% NRR good?

Whether 95% NRR is good depends on the period it covers, because the same figure means very different losses monthly and annually. As a monthly figure it means losing a twentieth of your existing revenue every month. As an annual figure it means losing a twentieth over the whole year. Always say which period an NRR covers.

## Is monthly NRR the same as annual NRR?

No. Annual NRR is not twelve monthly figures compounded, because each month starts with a different group of customers. Annual NRR follows one group: the customers paying 12 months ago.

**Annual NRR** looks at the customers you had 12 months ago:

**Annual NRR = MRR today from the customers paying 12 months ago ÷ their MRR 12 months ago**

Say your customers on January 1 paid $10,000 of MRR. On December 31, those same customers pay $10,800, after every upgrade, downgrade and cancellation during the year. Annual NRR is 108%.

Compounding a year of 101% months gives 1.01¹² ≈ 112.7%, a different number. The reason: February's starting customers include those who joined in January, March's include those who joined in February, and so on. Their upgrades, downgrades and cancellations move the monthly figures, but they were never in January's group, so they are not in the annual figure. The reverse also happens: a January customer who cancels in March and returns in June is new business in June's monthly figure, but counts again in annual NRR.

Use monthly NRR to see a change quickly. Use annual NRR when you compare years or report to investors, and never present a compounded monthly figure as annual NRR.

## How do pauses, returns and plan changes affect NRR?

NRR moves only when MRR moves, so each case follows from your MRR rules:

- **Pauses.** A paused subscription contributes no MRR, so a pause lowers both NRR and GRR, and a resume raises them again. Count both, or a pause that never resumes never shows up as a loss.
- **A customer who leaves and returns in the same period.** If they return at the same price, churn and reactivation cancel out and NRR does not move. At a different price, only the net change counts, as expansion or contraction.
- **A former customer who returns.** If they left before the period started, they are not in the starting MRR. Their return is new business for this period, not retention.
- **Upgrades in the middle of a period.** Count the change in MRR, not the prorated charge on the invoice. A $50-a-month upgrade with 15 days left bills about $25 this month, but adds $50 of expansion.
- **Annual plans.** They count in MRR at one twelfth of their price, so an annual renewal at a higher price adds expansion of the monthly difference.
- **Failed payments.** A subscription in dunning is still a customer and still in MRR. It becomes churn only if it is cancelled. See [what dunning is](/blog/what-is-dunning).
- **More than one currency.** Don't add euros to dollars. Calculate NRR for each currency, or convert every amount at one stated rate.

## How does NRR relate to churn rate and the quick ratio?

NRR is one of several numbers built from the same MRR changes:

- **Gross revenue churn** = (contraction + churn) ÷ starting MRR = 1 − GRR. In the example, 8%.
- **Customer churn rate** = customers lost ÷ customers at the start. In the example, 1 of 5, or 20%. It counts customers, not dollars, so a small customer and a large one weigh the same.
- **Quick ratio** = (new + expansion + reactivation) ÷ (contraction + churn). It includes new business, unlike NRR. In the example: ($1,000 new from F + $900 expansion) ÷ ($300 + $500) = $1,900 ÷ $800 ≈ 2.4. You added $2.40 of MRR for every $1 you lost.

## How do you report NRR consistently?

Write your definition down and keep it. No accounting standard defines NRR, so two companies can report the same business with different NRR.

The SEC's 2020 guidance on business metrics ([Release 33-10751](https://www.sec.gov/files/rules/interp/2020/33-10751.pdf)) expects public companies to give "a clear definition of the metric and how it is calculated", the reasons it is useful, and how management uses it. When the calculation changes, the company should consider disclosing the difference, the reason and the effect. A private company has no such duty, but the same habit helps any board or buyer trust the number. Your NRR definition should answer:

- Which period does it cover: a month or 12 months?
- Is it based on MRR or ARR, and with which MRR rules?
- Is a customer who joins during the period excluded, including their first upgrade?
- How are pauses, reactivations and failed payments treated?
- Which exchange rate converts other currencies?
- Why does the number matter, and how do you use it?
