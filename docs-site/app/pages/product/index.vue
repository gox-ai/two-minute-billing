<script setup lang="ts">
/** Product overview: the lifecycle in one page, linking to each product page from the site map. */
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import { toneClass } from "~/utils/tone";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkPageBleed from "~/components/marketing/MkPageBleed.vue";
import MkPageFlow from "~/components/marketing/MkPageFlow.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageTrust from "~/components/marketing/MkPageTrust.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const freeBand = await useFreeBand();

const renewal = [
  {
    icon: "i-lucide-file-text",
    title: "The invoice is raised",
    body: "Plan, add-ons, last period's usage, discounts, credits and tax, on one document.",
  },
  {
    icon: "i-lucide-credit-card",
    title: "Your gateway is charged",
    body: "The default card first. If it declines, the backup cards are tried in the same attempt.",
  },
  {
    icon: "i-lucide-rotate-ccw",
    title: "If it fails, recovery starts",
    body: "Retries timed by the reason the bank gave, and an email with a link to pay.",
  },
  {
    icon: "i-lucide-book-lock",
    title: "It goes on the record",
    body: "A ledger entry for the money, and a webhook to your own systems.",
  },
];

const solutions = [
  {
    to: "/solutions/india",
    icon: "i-lucide-indian-rupee",
    label: "India",
    description: "GST invoices by place of supply, TDS, and Razorpay mandates for recurring INR.",
  },
  {
    to: "/solutions/saas",
    icon: "i-lucide-building-2",
    label: "SaaS",
    description: "Plans, seats and add-ons, with entitlements your app can check.",
  },
  {
    to: "/solutions/usage",
    icon: "i-lucide-gauge",
    label: "Usage-based",
    description: "Meters and rate cards, billed with the plan fee.",
  },
  {
    to: "/solutions/ai-billing",
    icon: "i-lucide-sparkles",
    label: "AI billing",
    description: "Model prices, prepaid credits, spend limits and margin.",
  },
  {
    to: "/solutions/ecommerce",
    icon: "i-lucide-shopping-bag",
    label: "Ecommerce",
    description: "Recurring orders, with skips and pauses instead of cancellations.",
  },
  {
    to: "/solutions/developers",
    icon: "i-lucide-code",
    label: "Developers",
    description: "A documented REST API: every dashboard screen is also an endpoint.",
  },
];

const principles = [
  {
    icon: "i-lucide-wallet",
    title: "Your gateway, your money",
    body: "Payments land in your own gateway account. We never hold your funds.",
  },
  {
    icon: "i-lucide-mouse-pointer-click",
    title: "Every figure traces back",
    body: "Click a figure in a report to read the invoices, payments and credit notes behind it.",
  },
  {
    icon: "i-lucide-hourglass",
    title: "A timeout is not a decline",
    body: "When a gateway answer is lost, the payment stays pending until the gateway confirms what happened.",
  },
  {
    icon: "i-lucide-flask-conical",
    title: "Test mode in every business",
    body: "Test cards for every failure, and test businesses that email only your own team.",
  },
];

const businesses = [
  {
    icon: "i-lucide-building-2",
    title: "One business per brand",
    body: "Each business has its own catalog, currencies, tax setup and gateways.",
  },
  {
    icon: "i-lucide-layout-grid",
    title: "Side by side",
    body: "The organization view puts MRR, customers and cash for every business next to each other.",
  },
  {
    icon: "i-lucide-users",
    title: "One team",
    body: "One login per person, with a role in each organization.",
  },
  {
    icon: "i-lucide-scroll-text",
    title: "One audit log",
    body: "Who changed what, across the organization and in each business.",
  },
];

const why = [
  {
    label: "Seven parts, one record",
    body: "Subscriptions, invoices, payments, recovery, tax, checkout and reports share one set of customers and one ledger.",
  },
  {
    label: "No share of your revenue",
    body: `Free while you bill less than ${freeBand.value} a month. Then a flat monthly price, with no share of your revenue.`,
  },
  {
    label: "Nothing to reconcile between tools",
    body: "Nothing to sync between a billing tool, a tax tool and a reporting tool. It is one system.",
  },
];

const faq = [
  {
    label: "What is a subscription management platform?",
    content:
      "Software that runs recurring billing from end to end: the catalog, each customer's subscription, the invoices, the charges, the follow-up when a charge fails, and the reports. Two Minute Billing does all of it on your own payment gateway.",
  },
  {
    label: "Do I have to change my payment gateway?",
    content: "No. Connect the gateway account you have. Payments keep going to it, at your rates.",
  },
  {
    label: "Can I run several brands or companies?",
    content:
      "Yes. One organization holds many businesses, each with its own catalog, currencies, tax setup and gateways, and one view of them all.",
  },
  {
    label: "Is there a free plan?",
    content: `Yes. Every feature, in test mode and in live mode. Free while you bill less than ${freeBand.value} a month. Then a flat monthly price. No credit card required.`,
  },
];

useMarketingSeo({
  title: "Subscription management platform",
  crumb: "Product",
  description:
    "One subscription billing engine for plans, invoices, payments, dunning, tax, checkout and MRR reports, on your own payment gateway account.",
  og: {
    headline: "Subscription management platform",
    title: "One billing engine, from first trial to paid invoice",
    description: "Subscriptions. Invoices. Payments. Recovery. Tax. Reports.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Subscription management platform"
      title="One subscription billing engine, from first trial to paid invoice"
      description="Two Minute Billing is a subscription management platform. It decides what each customer owes, collects it through your own payment gateway, chases what fails, and keeps a record you can trace. Plans, invoices, payments, dunning, tax, checkout and MRR reports in one platform."
      :secondary="{ label: 'What it does', to: '/help/getting-started/what-it-does' }"
      :note="`Free while you bill less than ${freeBand} a month. Then a flat monthly price.`"
    >
      <MkIllustration
        name="IllProductHero"
        :width="600"
        :height="460"
        alt="A renewed Growth plan invoice for Kaveri Freight, $99.00 plus 8.25% sales tax for $107.17 paid, collected in your own gateway, and MRR of $50,520, up 4.8%."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Subscriptions, invoices, payments, tax and reports in one billing platform"
      description="Billing in one tool, tax in a spreadsheet and MRR in another tool means three versions of the truth. One record means one."
      :items="why"
    />

    <section class="py-6 lg:py-10">
      <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl">
          <p class="mk-kicker mb-4 w-fit">The product</p>
          <h2 class="mk-h2 text-highlighted">
            What the subscription management platform does, from sign-up to paid invoice
          </h2>
        </div>
        <div class="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NuxtLink
            v-for="p in PRODUCT"
            :key="p.to"
            :to="p.to"
            class="mk-card p-6"
            :class="toneClass(p.to)"
          >
            <span class="mk-tile size-10!" aria-hidden="true">
              <UIcon :name="p.icon ?? 'i-lucide-box'" class="size-5" />
            </span>
            <span class="mt-4 flex items-center gap-1.5 font-semibold text-highlighted">
              {{ p.label }}
              <UIcon name="i-lucide-arrow-up-right" class="size-4 text-muted" />
            </span>
            <span class="mt-1.5 text-sm leading-relaxed text-muted">{{ p.description }}</span>
          </NuxtLink>
        </div>
      </div>
    </section>

    <MkPageFlow
      kicker="How it works"
      title="What happens on a renewal"
      description="Nobody on your team presses a button. The billing clock runs every renewal, retry and email on time."
      :steps="renewal"
    />

    <MkPageZig
      bleed
      kicker="Many businesses"
      title="One dashboard for every business you run"
      accent="every business"
      description="Each business keeps its own catalog, currencies, tax setup and gateways. The organization view puts them side by side."
      :points="businesses"
      :links="[{ label: 'Reporting', to: '/product/reporting' }]"
    >
      <MkPageBleed
        src="/product/org-home"
        alt="The organization home: MRR, customers and cash for each business, side by side"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Principles"
      title="Payments go to your own gateway, and every figure traces back"
      accent="every figure traces back"
      description="The parts of billing that must never be wrong are built so they cannot be."
      :points="principles"
      :links="[{ label: 'Security', to: '/security' }]"
    >
      <MkIllustration
        name="IllMoneyFlow"
        :width="600"
        :height="420"
        alt="Two Minute Billing sends one API call to your gateway (Stripe, PayPal, Razorpay or 8 more). A $79.00 card payment goes from your customer through your gateway to your bank. Two Minute Billing never holds the money."
      />
    </MkPageZig>

    <section class="py-14 lg:py-20">
      <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl">
          <p class="mk-kicker mb-4 w-fit">Solutions</p>
          <h2 class="mk-h2 text-highlighted">
            Billing for SaaS, usage-based pricing, ecommerce, India and developers
          </h2>
        </div>
        <div class="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <NuxtLink v-for="s in solutions" :key="s.to" :to="s.to" class="mk-card p-5">
            <UIcon :name="s.icon" class="size-6 text-(--mk-plain)" />
            <span class="mt-3 font-semibold text-highlighted">{{ s.label }}</span>
            <span class="mt-1 text-sm leading-relaxed text-muted">{{ s.description }}</span>
          </NuxtLink>
        </div>
      </div>
    </section>

    <MkPageTrust />

    <MkFaq :items="faq" title="Subscription management questions" />

    <MkCta
      title="Send your first invoice today"
      accent="today"
      :description="`Every feature from day one. Free while you bill less than ${freeBand} a month. Then a flat monthly price.`"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />
  </div>
</template>
