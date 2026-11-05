import type { Term } from "@/components/analytics/card-info";

/**
 * What each home figure means, behind its (i). One entry per figure, shared by every card that
 * shows it. One short sentence, plus a formula only where there is arithmetic. Paraphrases the
 * engine's measure descriptions (`src/modules/metrics/daily/measures.ts`) — keep them in step.
 */
const t = (label: string, text: string, formula?: string | string[]): Term => ({
  label,
  text,
  formula,
});

export const G = {
  mrr: t(
    "MRR",
    "What live subscriptions bill per month, after recurring discounts. Excludes tax, one-offs, usage and trials.",
    "Σ (period price − recurring discounts) × periods per year ÷ 12",
  ),
  consolidatedMrr: t(
    "Consolidated MRR",
    "Every business's MRR, converted to the reporting currency.",
    "Σ each business's MRR × its exchange rate",
  ),
  arr: t("ARR", "Today's MRR over a year. This is a run rate, not a forecast.", "MRR × 12"),
  cmrr: t(
    "Committed",
    "MRR under contract. It excludes booked cancellations and includes signed future starts.",
    "MRR − booked cancellations + future starts",
  ),
  cancelling: t("Cancelling", "MRR booked to cancel, on any date. It stays in MRR until it stops."),
  businesses: t(
    "Businesses",
    "Businesses in the total. The total excludes a business that has no exchange rate.",
  ),
  mrrTrend: t("MRR trend", "MRR each day, compared with the period before."),
  payingCustomers: t(
    "Paying customers",
    "Accounts with recurring revenue now. Each account counts once, however many subscriptions it has.",
  ),
  arpa: t("ARPC", "Average revenue per paying customer.", "MRR ÷ paying customers"),
  payingSubs: t("Paying subs", "Live subscriptions with MRR above zero, cancelling ones included."),
  renewing: t("Renewing", "Paying subs that will renew.", "Paying subs − cancelling"),
  newAccounts: t(
    "New accounts",
    "Customers created in the period, paying or not. Dots mark new paying customers.",
  ),
  newPaying: t("New paying", "Accounts that started paying for the first time."),
  netPaying: t(
    "Paying customers, net",
    "Change in paying customers over the period.",
    "New paying − churned customers",
  ),
  churnedCustomers: t("Left", "Paying accounts that dropped to zero MRR and stayed there."),
  customerChurn: t(
    "Customer churn",
    "Share of paying customers at the start who stopped paying.",
    "Customers lost ÷ paying customers at the start",
  ),
  churned: t("Churned", "Paying customers at the start who stopped paying."),
  mrrChurnRate: t(
    "MRR churn",
    "MRR lost to cancellations and downgrades, as a share of starting MRR.",
    "(Churn + Contraction) ÷ Starting MRR",
  ),
  mrrLost: t("MRR lost", "MRR of subscriptions cancelled in the period."),
  churnCard: t("Churn", "MRR lost to cancellations, per day."),
  churnKind: t(
    "Voluntary · involuntary",
    "Involuntary: cancelled for a failed payment, missing payment method or chargeback.",
  ),
  netNewMrr: t(
    "Net new MRR",
    "MRR gained minus MRR lost.",
    "New + Expansion + Reactivation − Contraction − Churn",
  ),
  newMrr: t("New", "MRR from subscriptions that started."),
  expansionReactivation: t(
    "Expansion + reactivation",
    "Upgrades on live subscriptions, plus subscriptions that returned.",
  ),
  churnContraction: t(
    "Churn + contraction",
    "Cancellations, plus downgrades on live subscriptions.",
  ),
  quickRatio: t(
    "Quick ratio",
    "MRR gained for every 1 lost. Below 1 the business is shrinking.",
    "(New + Expansion + Reactivation) ÷ (Contraction + Churn + Paused)",
  ),
  grr: t(
    "Gross revenue retention",
    "Share of starting MRR still there at the end, ignoring upgrades. Max 100%.",
    "(Start − Contraction − Churn − Paused) ÷ Start",
  ),
  nrr: t(
    "Net revenue retention",
    "Starting MRR's worth at the end, upgrades included. Above 100% means existing customers grew.",
    "(Start + Expansion + Reactivation − Contraction − Churn) ÷ Start",
  ),
  netMrrGrowth: t(
    "Net MRR growth",
    "Net new MRR as a share of starting MRR.",
    "Net new MRR ÷ MRR at the start",
  ),
  mrrMovement: t(
    "MRR movement",
    "How MRR got from the start of the period to the end.",
    "Start + New + Expansion + Reactivation − Contraction − Churn − Paused = End",
  ),
  movementByGrain: t(
    "Movement over time",
    "MRR gained and lost per bucket. The line shows net new MRR.",
  ),
  movementByPlan: t(
    "Movement by plan",
    "The period's MRR movement per plan, largest net change first.",
  ),
  mrrByPlan: t("MRR by plan", "Today's MRR split by plan."),
  mrrByInterval: t(
    "MRR by billing interval",
    "Today's MRR split by billing frequency, each at its monthly share.",
  ),
  mrrByCountry: t("MRR by country", "Today's MRR split by the customer's billing country."),
  concentration: t(
    "Revenue concentration",
    "Share of MRR from your 10 largest customers.",
    "MRR of the top 10 customers ÷ total MRR",
  ),
  bookedChanges: t(
    "Booked changes",
    "Scheduled plan changes and cancellations not yet in effect, priced when booked.",
  ),
  revenuePerNewSub: t(
    "Revenue per new subscription",
    "Average MRR each new subscription brought.",
    "New MRR ÷ new subscriptions",
  ),
  revenueLostPerChurnedSub: t(
    "Revenue lost per churned subscription",
    "Average MRR each departing subscription took.",
    "(Churned MRR + Paused MRR) ÷ subscriptions that left",
  ),
  clv: t(
    "Customer lifetime value",
    "What a customer is worth over their life. It shows only after a customer has fully left.",
    "ARPC × average customer lifetime",
  ),
  customerLifetime: t(
    "Average customer lifetime",
    "How long departed customers stayed, first subscription to last.",
  ),
  subsPerCustomer: t("Subscriptions per customer", "Average live subscriptions per customer."),
  trials: t(
    "Trials",
    "Trials started in the period and how many converted to paid.",
    "Conversion = converted ÷ trials ended",
  ),
  disputesNeedResponse: t(
    "Disputes",
    "Chargebacks waiting for your evidence. Missing the deadline loses the payment.",
  ),
  unpaidAfterRetries: t(
    "Unpaid after retries",
    "Invoices still owed after every retry failed, in the last 30 days. No more retries occur. Collect the payment, contact the customer or write off the invoice.",
  ),
  emailsNotDelivered: t(
    "Emails not delivered",
    "Billing emails that failed or bounced in the last 7 days, so the customer never saw them.",
  ),
  pendingInvoices: t("Pending invoices", "Invoices waiting for approval before they are posted."),
  mrrAtRisk: t("MRR at risk", "MRR on subscriptions that have an unpaid invoice under retry."),
  cantBeCharged: t(
    "Cannot be charged",
    "Auto-collected renewing customers (MRR above 0, not cancelling) with an expired, invalid or missing payment method.",
  ),
  cardsExpiring: t("Cards expiring", "Renewing customers whose card expires within 90 days."),
  trialsConverted: t("Converted", "Trials that converted to paid in the period."),
  trialsEnded: t(
    "Ended",
    "Trials that ended in the period by conversion, cancellation or expiry. The conversion rate is converted ÷ ended.",
  ),
  trialConversion: t(
    "Trial conversion",
    "Trials that converted to paid, over trials that ended, in the last 30 days.",
    "Converted ÷ trials ended",
  ),
  newMrr30: t("New MRR", "MRR from subscriptions that started in the last 30 days."),
  cashCard: t("Cash", "Money received against invoices in the period."),
  creditBalance: t(
    "Credit balance",
    "The face value of the credit that customers hold now, paid and promotional.",
  ),
  creditLiability: t(
    "Credit liability",
    "The price customers paid for credit that they did not use yet. You owe them this value until they use it or it expires.",
  ),
  prepaidBalance: t(
    "Prepaid account balance",
    "Money that customers hold on their account: top-ups, promotional credit and excess payments. It pays any invoice, so it is not part of the credit balance.",
  ),
  creditsExpiring: t(
    "When credit expires",
    "The credit that customers hold now, by how soon it expires. Credit with no expiry date is shown as having no date.",
  ),
  creditRunway: t(
    "Running low",
    "Customers whose credit runs out within 7 days if they continue to use it at the rate of the last 7 days.",
    "Credit balance ÷ (credit used in the last 7 days ÷ 7)",
  ),
  creditFlow: t(
    "Credit flow",
    "Credit granted, used and expired in the period, at face value. Credit given back on a refund is taken off what was used.",
  ),
  creditRevenue: t(
    "Revenue from credit",
    "Credit packs sold, and the revenue that paid credit becomes: when customers use it, and when it expires unused (breakage).",
  ),
  usageRevenue: t(
    "Usage revenue",
    "What you invoiced for metered usage, before tax and after discounts. Usage is invoiced after it happens, so recent usage shows when its invoice is raised.",
  ),
  usageStopped: t(
    "Usage stopped",
    "Customers who sent usage before but sent none in the last 30 days. For a usage business, this is often the first sign that a customer is leaving.",
  ),
  usageRetention: t(
    "Usage revenue retention",
    "Usage revenue in the period from customers who had usage revenue in the period before, as a share of what they had then. Above 100% means that existing customers use more.",
    "Usage revenue now ÷ their usage revenue in the period before",
  ),
  orders: t(
    "Orders",
    "One-time orders: invoices with no subscription and at least one one-time line that is not a credit pack. Order revenue is before tax and after discounts.",
  ),
  returningBuyers: t(
    "Buyers",
    "Customers who placed an order in the period. A returning buyer placed an order before the period too.",
    "Returning buyer rate = returning buyers ÷ buyers",
  ),
  revenueMix: t(
    "Revenue mix",
    "What you invoiced in the period, by type: subscriptions, usage, one-time sales and credit packs. The amounts are before tax and after discounts. Collected is the money you received for each type.",
  ),
  recoveredByDunning: t("Recovered by dunning", "Invoices paid after they entered dunning."),
  refunds: t("Refunds", "Money returned to customers in the period."),
  collected: t("Collected", "Money received against invoices in the period."),
  collectionRate: t(
    "Collection rate",
    "Cash as a share of what was invoiced. It can go above 100% when customers pay old invoices.",
    "Cash ÷ Invoiced",
  ),
  dso: t(
    "Days sales outstanding",
    "Days of billing that stay unpaid. Lower is better.",
    "Unpaid ÷ average daily billing",
  ),
  failedPayments: t(
    "Failed payments",
    "Payment attempts that failed, with the top reasons. Each retry is a new attempt.",
    "Failed ÷ All attempts",
  ),
  whyFailed: t("Why payments failed", "Failed payment attempts grouped by the gateway's reason."),
  paymentSuccess: t(
    "Payment success",
    "Payment attempts and failures over time. The line shows the success rate.",
    "1 − Failed ÷ Attempts",
  ),
  successByGateway: t(
    "Success by gateway",
    "Share of payment attempts that succeeded, per gateway.",
  ),
  todaySoFar: t(
    "Today so far",
    "Today so far, compared with yesterday, in the business's time zone.",
  ),
  receivables: t("Receivables", "Amount owed on unpaid invoices now, by how overdue they are."),
  dunning: t(
    "Dunning",
    "Invoices in dunning, by state. The rate is the share of finished invoices that were paid.",
    "Recovered ÷ (Recovered + Exhausted + Stopped)",
  ),
  toBeBilled: t(
    "To be billed",
    "Renewals due in the next 30 days, plus overdue renewals not yet billed. Excludes tax and usage.",
  ),
  disputesOpen: t("Disputes", "Open chargebacks and the soonest evidence deadline."),
  cashSources: t(
    "Where the cash came from",
    "Cash split by subscriptions, one-off charges and usage.",
  ),
  creditNotes: t("Credit notes raised", "Credit notes issued in the period."),
  netRecurringCash: t("Net recurring cash", "Recurring cash less recurring refunds."),
  dunningOutcome: t(
    "Dunning outcome",
    "Money dunning recovered, compared with money it stopped trying to collect.",
  ),
  daysToPay: t("Days to pay", "Invoices paid in the period, by how late they were."),
  disputesPeriod: t("Disputes", "Chargebacks opened, won and lost in the period."),
  discounts: t(
    "Discounts",
    "What discounts and coupons took off invoices.",
    "Share = discount ÷ (invoiced + discount)",
  ),
  tax: t(
    "Tax charged",
    "Tax on invoices raised. You collect it for the tax authority, so it is not revenue.",
  ),
  voidedWrittenOff: t(
    "Voided · written off",
    "Voided invoices, and invoices written off as uncollectable.",
  ),
  orgSubscriptions: t(
    "Subscriptions",
    "Subscriptions that started billing, against those cancelled.",
  ),
  // Reports: cancellations
  cancelMrrLost: t(
    "MRR lost",
    "MRR of paying subscriptions cancelled in the period, at the rate each was paying.",
  ),
  payingCancellations: t(
    "Paying cancellations",
    "Paying subscriptions cancelled in the period. This counts subscriptions, not customers.",
  ),
  involuntaryShare: t(
    "Involuntary share",
    "Share of MRR lost to a failed payment, missing payment method or chargeback rather than a choice.",
    "Involuntary MRR lost ÷ MRR lost",
  ),
  trialsNotConverted: t(
    "Trials not converted",
    "Trials that ended without a payment. This is not churn, because no MRR was lost.",
  ),
  // Reports: recovery
  recoveryRate: t(
    "Recovery rate",
    "Share of invoices that entered collections and were then paid. Invoices still under retry count as not recovered yet, so the rate can only rise.",
    "Recovered ÷ invoices taken in",
  ),
  failedCharges: t(
    "Failed charges",
    "Payment attempts the gateway refused. Each retry is a new attempt, so one invoice can fail several times.",
  ),
  amountRecovered: t(
    "Amount recovered",
    "Money from invoices paid after they entered collections. Each amount is dated by the day it arrived.",
  ),
} as const;
