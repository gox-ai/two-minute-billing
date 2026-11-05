---
title: "What is dunning? How subscription businesses recover failed payments"
seoTitle: "What is dunning? Meaning and process"
description: "Dunning is how a business recovers a failed or overdue payment. Learn how subscription dunning works: retries, soft and hard declines, and emails."
date: "2026-11-02"
category: Failed payments
type: Explainer
draft: false
cover:
  tone: billing
  coverTitle: "What is dunning?"
  cardLabel: "Renewal invoice · Team plan"
  rows:
    - label: "Card declined · day 0"
      amount: "$49.00"
    - label: "New card charged · day 6"
      amount: "$49.00"
  value: "$49.00"
  pill: "Recovered"
bridge:
  title: "How Two Minute Billing handles dunning"
  body: "Select fixed retries, or smart mode, which reads each decline: temporary declines are retried, declines only the customer can fix wait for a new card, and declines that can never succeed stop at once. You set 1 to 8 retries, each counted from the last failure. Up to three saved cards are tried in one attempt, and a card the customer adds is charged at once. Automatic retries on a card pause after 10 declines in 24 hours or 15 in 30 days. The dunning emails carry a link to pay or change the card, and you edit their wording. When retries run out, you decide the invoice and the subscription separately. Two Minute Billing does not run a card updater service (your gateway does), send text messages, hand debts to a collections agency, or promise a recovery rate."
  links:
    - label: "Dunning and payment recovery"
      to: "/product/recovery"
    - label: "Recover failed payments"
      to: "/help/guides/recover-failed-payments"
    - label: "Failed payments with the API"
      to: "/help/developers/recipes/failed-payments"
sources:
  - title: "American Heritage Dictionary, dun"
    url: "https://ahdictionary.com/word/search.html?q=dun"
    checked: "2026-11-02"
  - title: "Visa Core Rules and Visa Product and Service Rules (October 24, 2026), sections 1.7.2.1, 7.3.6.3 (Table 7-2) and 8.6.1"
    url: "https://usa.visa.com/content/dam/VCOM/download/about-visa/visa-rules-public.pdf"
    checked: "2026-11-02"
  - title: "Visa Developer, Visa Account Updater FAQ"
    url: "https://developer.visa.com/capabilities/vau/vau-faq"
    checked: "2026-11-02"
  - title: "Mastercard Developers, decline details and merchant advice codes"
    url: "https://developer.mastercard.com/mastercard-send-funding/documentation/response-error-codes/decline-details/"
    checked: "2026-11-02"
  - title: "Mastercard Developers, Automatic Billing Updater"
    url: "https://developer.mastercard.com/automatic-billing-updater/documentation/support/"
    checked: "2026-11-02"
  - title: "Stripe documentation, decline codes"
    url: "https://docs.stripe.com/declines/codes"
    checked: "2026-11-02"
  - title: "Stripe documentation, card declines"
    url: "https://docs.stripe.com/declines/card"
    checked: "2026-11-02"
  - title: "Nacha, minor rules topics (reinitiation limited to two times)"
    url: "https://www.nacha.org/rules/minor-rules-topics-1"
    checked: "2026-11-02"
  - title: "Nacha, ACH network risk and enforcement topics (reinitiated entries)"
    url: "https://www.nacha.org/rules/ach-network-risk-and-enforcement-topics"
    checked: "2026-11-02"
---

Dunning is how a business recovers a payment that is overdue or has failed. For a subscription business, it means four things: retry the failed charge on a schedule, tell the customer, let them pay or change their card, and decide what happens if they never pay.

::in-short
- "To dun" means to press a debtor for payment. Dunning is the process that does it, by letter, email or automatic retry.
- For subscriptions billed to a card, dunning starts with a declined renewal charge, not with a late customer.
- Some declines can be retried. Others must never be retried: the card networks set the rules.
- When the retries run out, you decide two things separately: what happens to the invoice, and what happens to the subscription.
::

## What does dunning mean?

Dunning means pressing a customer to pay money they owe. It comes from the verb "to dun", which the [American Heritage Dictionary](https://ahdictionary.com/word/search.html?q=dun) defines as to "importune (a debtor) for payment", with the example "a dunning letter". In business, dunning is the planned sequence of reminders, retries and final steps a company uses to collect an overdue or failed payment.

The word has two meanings in business today:

- **In accounts receivable**, dunning is chasing invoices that customers have not paid by the due date.
- **In subscription billing**, dunning is recovering a charge that failed. The customer did not refuse to pay. Their card declined on the renewal date, and the business has to get the payment through before the customer is lost.

The rest of this post is about the subscription meaning, because that is where most of the work is now automatic.

### What does dunning mean in accounts receivable (AR)?

In accounts receivable (AR), dunning is chasing invoices that customers have not paid by the due date. The business sends dunning letters or notices, each one firmer than the last, and may at the end pass the debt to a collections agency.

### Why is it called dunning?

It is called dunning because "to dun" means to press a debtor for payment. Nobody knows where the word comes from: the American Heritage Dictionary gives its origin as unknown, so treat any story about its source as folklore.

## How does the dunning process work for subscriptions?

Subscription dunning starts when a renewal charge fails and ends with a payment or a final decision. The invoice stays open, the customer gets an email with a link to pay or change the card, the charge is retried if the decline code permits, and a new card is charged at once. The steps:

1. **The renewal charge fails.** The gateway returns a decline code that says why.
2. **The invoice stays open.** It is not cancelled. It moves to a "payment due" state and enters the retry schedule.
3. **The customer is told.** An email says the payment failed and gives a link to pay or change the card.
4. **The charge is retried** on a schedule, if the decline type permits a retry.
5. **A new card is charged at once.** If the customer adds a working card, the open invoice is paid then, not at the next retry.
6. **The final step applies** if no retry works before the schedule ends.

Here is one example with stated inputs. A customer is on a $49.00 monthly Team plan. The renewal charge on day 0 is declined with "insufficient funds". The schedule retries 1, 3 and 7 days after each failure.

| Day | What happens | Invoice | Subscription |
|---|---|---|---|
| 0 | Renewal charge of $49.00 is declined: insufficient funds | Payment due | Active |
| 0 | Email: "Your payment failed", with a link to pay or change the card | Payment due | Active |
| 1 | Retry 1 is declined again | Payment due | Active |
| 4 | Retry 2 is declined again (3 days after retry 1) | Payment due | Active |
| 6 | The customer adds a new card. It is charged $49.00 at once | Paid | Active |
| 11 | Retry 3 would have run here (7 days after retry 2). It is not needed | — | — |

Two details matter in this table. First, the subscription stays active while the invoice is chased. Whether the customer keeps access during dunning is your decision, not the gateway's. Second, the customer fixed the problem on day 6, before the last retry. A good dunning process makes that easy, because a customer who acts is faster than any schedule.

## What is automated dunning?

Automated dunning, also called auto dunning or dunning automation, is dunning that your billing system runs without manual work. When a renewal charge fails, it retries the charge on a schedule the decline code permits, emails the customer a link to pay or change the card, charges a new card at once, and applies your final step when the retries run out.

Your team still has work to do, but less of it. It sets the schedule and the email wording once, and then handles only the exceptions: a customer who asks for more time, or a large account where someone should call before the plan ends.

## Why do subscription payments fail?

A subscription payment fails because the card issuer declines it, and the decline code says whether a retry can work. Codes fall into two groups:

- **Soft declines** are temporary. The card is good, but the issuer cannot approve the charge now. Insufficient funds is one example. A retry a few days later can succeed.
- **Hard declines** are permanent. The card is lost, stolen or closed, or the cardholder told the bank to stop the payment. No retry can succeed, and the card networks forbid retrying.

Visa writes this into its rules. The [Visa Core Rules](https://usa.visa.com/content/dam/VCOM/download/about-visa/visa-rules-public.pdf) (edition of October 24, 2026, Table 7-2) put every decline code in one of four categories:

| Visa category | Example codes | What you may do |
|---|---|---|
| 1. Issuer will never approve | 04 and 07 pick up card, 14 invalid account number, 41 lost card, 43 stolen card, 46 closed account, R0/R1/R3 stop payment | Never resubmit for the same card |
| 2. Issuer cannot approve at this time | 51 not sufficient funds | Up to 20 attempts in 30 days |
| 3. Data quality: revalidate payment information | 54 expired card, N7 CVV2 failure | Up to 20 attempts in 30 days |
| 4. Generic response codes | All other decline codes | Up to 20 attempts in 30 days |

The same rules (section 1.7.2.1) say a merchant that retries must not intentionally change data in the original request, such as the merchant category code or the e-commerce indicator, to get past a decline. Correcting the card details after a category 3 decline is different: that is what the category asks for.

Mastercard sends its advice with the decline as a merchant advice code. Code 03 means "Do not try again" and code 21 means "Payment cancellation" ([Mastercard Developers](https://developer.mastercard.com/mastercard-send-funding/documentation/response-error-codes/decline-details/)). Other codes tell you to wait a stated time before you retry.

### What does "do not honor" mean?

Code 05, "do not honor", is the issuer declining without a reason. It is not in Visa's categories 1 to 3, so it falls in category 4, the generic codes, and a retry is permitted. Gateway documentation describes the matching code as "declined for an unknown reason". In practice, retry it a few times on your schedule, then ask the customer for another card.

Gateways pass this advice on. One gateway's [card declines documentation](https://docs.stripe.com/declines/card) says networks limit how many times a single charge can be retried and recommends at most eight retries for charges that permit them. Its [decline codes list](https://docs.stripe.com/declines/codes) also says not to tell the customer that a card was reported lost or stolen: show a generic decline instead.

## What is involuntary churn?

Involuntary churn is a customer you lose because a payment failed, not because they decided to leave. The customer still wants the product. Their card expired, ran short on the renewal date, or was replaced after a fraud alert, and nobody got a working card on file in time.

Dunning exists to stop involuntary churn. That is why it counts as a revenue process, not only a collections process. Each customer recovered can keep paying for every month after the failed one.

## What is a dunning letter?

A dunning letter or email is a message that tells a customer a payment is overdue or failed, and asks them to pay. In accounts receivable it is often a printed letter or a PDF. In subscription billing it is almost always an email.

A useful dunning email says five things:

- **The amount and what it is for**, for example "$49.00 for your Team plan".
- **A plain reason**, such as "your card was declined". Do not repeat a decline reason the customer should not see, such as a lost-card report.
- **One link** to pay the invoice or change the card. The customer should not have to sign in first.
- **The next attempt date**, so the customer knows when the charge will run again.
- **What happens at the end**, said calmly: for example, "If we cannot collect by May 20, your plan will end."

No rule sets the number of stages in a dunning sequence. One way to group them is four stages, each firmer than the last: a first notice, a reminder, a final notice and, in accounts receivable only, handover to a collections agency. For a subscription, the final notice is the last message:

| Message | When | Tone |
|---|---|---|
| Payment failed | At the first decline | Friendly. Probably a card problem, easy to correct |
| Reminder | At a later retry | Direct. The amount, the link, the next attempt date |
| Final notice | Before the final step | Clear. What ends, and when |
| Collections handover | Accounts receivable only, after the final notice | Formal. The debt goes to an agency |

## What is pre-dunning?

Pre-dunning is the work you do before a charge fails, so that it does not fail. The two main tools are card-expiry emails to customers whose saved card will soon expire, and card updater services, which send new card numbers and expiry dates to the merchant through its gateway.

**Card-expiry notices.** Your billing system knows the expiry date of each saved card. An email before the card expires, sent only to customers whose card pays a live subscription, removes the cause of many declines.

**Card updater services.** Visa and Mastercard both run a service that sends new card details to merchants that bill cards on file:

- [Visa Account Updater](https://developer.visa.com/capabilities/vau/vau-faq) shares updated card numbers, expiry dates, closed accounts and cardholder advices. In the US, Visa issuers must enroll all their BINs (the first digits of their card numbers) in it, except commercial, prepaid and a few other card types ([Visa Core Rules](https://usa.visa.com/content/dam/VCOM/download/about-visa/visa-rules-public.pdf), section 8.6.1).
- [Mastercard Automatic Billing Updater](https://developer.mastercard.com/automatic-billing-updater/documentation/support/) lets issuers send account number and expiry date changes, to reduce avoidable declines for card-on-file and recurring merchants.

You do not connect to these services directly. Your gateway or acquirer does, and the updated card arrives through the gateway. Ask your gateway whether it is on for your account.

## How is dunning different for ACH bank debits?

ACH debits from US bank accounts follow Nacha's rules, not the card networks' rules, and they allow fewer retries. When a debit is returned:

- It may be reinitiated only in the limited cases the rules permit, and **at most two times** ([Nacha](https://www.nacha.org/rules/minor-rules-topics-1)).
- A reinitiated debit must keep the same company name, company ID and amount, and carry the description "RETRY PYMT" ([Nacha](https://www.nacha.org/rules/ach-network-risk-and-enforcement-topics)).
- A debit returned as unauthorized must never be reinitiated. Nacha calls that an improper reinitiation.

Two things do not count as a reinitiation, according to the same Nacha page. The next debit in a series of recurring debits is not one, as long as it does not depend on whether the earlier debit was returned. A debit made under a new authorization, obtained after the return, is not one either.

ACH returns also take days to arrive, not seconds. Plan fewer attempts than for cards, with more time between them.

## What happens when dunning fails?

When the last retry fails, or the dunning period ends, you make two independent decisions: what happens to the invoice, and what happens to the subscription.

**The invoice.** You can leave it owed, so the customer still owes the amount and can pay it later. You can void it, if it should never have been due. Or you can write it off as bad debt, so your books show it as revenue you will not collect.

**The subscription.** You can cancel it, which is the usual choice for consumer plans. Or you can keep it running, which can be the right choice for a business customer with a long history and an invoice their finance team is still processing.

Keep the two decisions apart. "Write off this month and keep the customer" is a valid result. So is "cancel the plan, and keep the invoice owed".

## Who does the dunning: your gateway or your billing system?

The gateway charges the card, returns the decline code and runs card updater services. The billing system does the rest: the retry schedule, the invoice status, the dunning emails and pay link, and the final step.

| Job | Gateway | Billing system |
|---|---|---|
| Charge the card and return the decline code | Yes | — |
| Card updater services | Yes | — |
| Retry schedule and the decline rules it follows | — | Yes |
| Invoice status during dunning | — | Yes |
| Dunning emails and the pay link | — | Yes |
| Final step for the invoice and the subscription | — | Yes |

A gateway charges a card when it is asked to. It does not know that the charge is month 14 of a subscription, that the customer has a second card on file, or that you want to keep business customers active through a failed payment. That knowledge lives in the billing system. So, if you already have a gateway, dunning is the billing system's job.
