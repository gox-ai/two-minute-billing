<script setup lang="ts">
/** Product: MRR and its movements, churn, cohorts, receivables, drill-through and the analytics API. */
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkPageBleed from "~/components/marketing/MkPageBleed.vue";
import MkPageFlow from "~/components/marketing/MkPageFlow.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageTrust from "~/components/marketing/MkPageTrust.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";
import MkRelated from "~/components/marketing/MkRelated.vue";
import MkShot from "~/components/marketing/MkShot.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const headline = [
  {
    icon: "i-lucide-trending-up",
    title: "MRR and ARR",
    body: "Committed recurring revenue, per currency. Usage and one-off charges stay out, so it stays a planning number.",
  },
  {
    icon: "i-lucide-users",
    title: "Subscribers",
    body: "Active, paying and in trial, with ARPU across active subscribers.",
  },
  {
    icon: "i-lucide-user-minus",
    title: "Churn",
    body: "Logo churn by count, and MRR lost to cancellation. A pause is reported apart from churn.",
  },
  {
    icon: "i-lucide-grid-3x3",
    title: "Cohorts",
    body: "Retention by the month customers joined, as a grid you can read across.",
  },
  {
    icon: "i-lucide-circle-dollar-sign",
    title: "Receivables",
    body: "What is owed, what is past due, and the cash you can expect.",
  },
  {
    icon: "i-lucide-message-square-x",
    title: "Cancellations",
    body: "MRR lost by month or week, why paying customers left, how long they stayed, and the largest losses.",
  },
];

const trace = [
  {
    icon: "i-lucide-mouse-pointer-click",
    title: "Drill through",
    body: "Figures on the metrics screens link to the subscriptions, invoices and payments behind them.",
  },
  {
    icon: "i-lucide-layout-dashboard",
    title: "Saved dashboards",
    body: "Build dashboards from the report catalog and keep them for your team.",
  },
  {
    icon: "i-lucide-braces",
    title: "Analytics API",
    body: "Ask for a measure over a window, cut by plan, country, currency or business.",
  },
  {
    icon: "i-lucide-download",
    title: "Export the rows",
    body: "Export the rows behind the revenue reports for your own spreadsheet or warehouse.",
  },
];

const many = [
  {
    icon: "i-lucide-building-2",
    title: "Every business side by side",
    body: "The organization view puts each business's MRR, customers and cash next to the others.",
  },
  {
    icon: "i-lucide-coins",
    title: "Per currency, never mixed",
    body: "Each currency is reported on its own. Set reporting exchange rates for one roll-up figure.",
  },
];

const why = [
  {
    label: "Five MRR movements",
    body: "New, expansion, reactivation, contraction and churn, so you see why MRR moved, not only that it did.",
  },
  {
    label: "From a figure to its rows",
    body: "When a number looks wrong, open the records behind it instead of rebuilding it in a spreadsheet.",
  },
  {
    label: "Currencies are never summed by accident",
    body: "Rupees and dollars are never summed by accident. A roll-up uses the exchange rates you set.",
  },
];

const steps = [
  {
    icon: "i-lucide-book-lock",
    title: "Money is recorded",
    body: "Each invoice, payment, refund and credit note goes on the ledger as it happens.",
  },
  {
    icon: "i-lucide-ruler",
    title: "Measures are defined once",
    body: "MRR, churn and the rest are calculated the same way on every screen and in the API.",
  },
  {
    icon: "i-lucide-chart-line",
    title: "Reports per currency",
    body: "Trends, movements, cohorts and receivables, per business and per currency.",
  },
  {
    icon: "i-lucide-mouse-pointer-click",
    title: "Open the rows",
    body: "Click a figure to read the records, or pull it through the API or an export.",
  },
];

const faq = [
  {
    label: "What counts as MRR?",
    content:
      "Committed recurring revenue: the plans and add-ons customers have agreed to pay each month, per currency. A yearly plan counts as one twelfth of its price each month.",
  },
  {
    label: "Why is usage not in MRR?",
    content:
      "MRR is what customers are committed to pay each month. Usage and one-off charges are real revenue, but counting them would make MRR move with consumption. Invoices and transactions show the total collected.",
  },
  {
    label: "How is churn measured?",
    content:
      "Logo churn counts the customers who left. MRR churn is the recurring revenue lost to cancellation. A paused subscription is reported apart from churn.",
  },
  {
    label: "How are several currencies shown?",
    content:
      "Per currency, never added together. For one roll-up figure, set reporting exchange rates. They change reports only, never what a customer is charged.",
  },
  {
    label: "Can I get the data out?",
    content:
      "Yes. Export the rows behind the revenue reports, or read any measure through the analytics API, with its unit, currency and window stated on every answer.",
  },
];

useMarketingSeo({
  title: "MRR, churn and SaaS metrics reporting",
  crumb: "Reporting",
  parents: [{ name: "Product", path: "/product" }],
  description:
    "Track MRR, ARR, churn, cohorts and receivables per currency and per business. Click any figure to see the invoices, payments and credit notes behind it.",
  og: {
    headline: "MRR and SaaS metrics",
    title: "MRR and churn your finance team can trace to the row",
    description: "MRR, churn, cohorts and receivables.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="MRR and SaaS metrics reporting"
      title="MRR and churn your finance team can trace to the row"
      description="Two Minute Billing reports MRR and its movements, ARR, churn, cohorts and receivables, per currency and per business. Click any figure to read the invoices, payments and credit notes behind it."
      :secondary="{ label: 'Read your numbers', to: '/help/guides/read-your-numbers' }"
    >
      <MkIllustration
        name="IllReportingHero"
        :width="600"
        :height="460"
        alt="November MRR of $50,520, up 4.8% from $48,200: new +$3,150, expansion +$1,240, reactivation +$310, contraction −$420 and churn −$1,960, with the new MRR opened to the subscriptions behind it."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Five MRR movements, figures you can open, and each currency kept apart"
      description="Board decks, budgets and pricing calls all start from MRR and churn. When the number and the invoices disagree, the meeting is about the number."
      :items="why"
    />

    <MkPageZig
      bleed
      kicker="SaaS metrics"
      title="SaaS metrics: MRR, ARR, churn, cohorts and receivables"
      accent="SaaS metrics"
      description="Defined once, calculated the same way on every screen and in the API."
      :points="headline"
      :links="[{ label: 'Read your numbers', to: '/help/guides/read-your-numbers' }]"
    >
      <MkPageBleed
        src="/product/business-home"
        alt="The business home screen: MRR, paying customers, churn, trial conversion and the MRR trend"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="MRR movements"
      title="MRR, and every movement behind it"
      accent="every movement"
      description="The trend for any window, split into new, expansion, reactivation, contraction and churn. Per business and per currency, never mixed."
      :points="many"
      :links="[
        { label: 'Expansion MRR from seats and add-ons', to: '/solutions/saas' },
        { label: 'Churn on repeat orders', to: '/solutions/ecommerce' },
      ]"
    >
      <MkShot
        src="/product/fragments/mrr-chart"
        alt="The MRR trend over 30 days, with the change against the previous period"
        :width="1560"
        :height="858"
      />
    </MkPageZig>

    <MkPageZig
      kicker="Traceable"
      title="From a figure to the records behind it"
      accent="records"
      description="When a number looks wrong, click it and read the invoices, payments and credit notes behind it."
      :points="trace"
      :links="[{ label: 'Analytics API', to: '/help/developers/concepts/analytics' }]"
    >
      <MkIllustration
        name="IllLedger"
        :width="600"
        :height="420"
        alt="The records behind a balance: two invoices, a payment and a ₹500.00 credit note leave ₹3,038.82 owed."
      />
    </MkPageZig>

    <MkPageFlow
      kicker="How it works"
      title="From a ledger record to a report in each currency"
      :steps="steps"
    />

    <MkPageTrust />

    <MkFaq :items="faq" title="MRR and churn reporting questions" />

    <MkRelated />

    <MkCta
      title="See your own numbers"
      accent="numbers"
      description="Sign up free, or talk to us about moving your history in so your reports start with your past, not from zero."
      :secondary="{ label: 'Talk to us', to: '/contact' }"
    />
  </div>
</template>
