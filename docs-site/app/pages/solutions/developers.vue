<script setup lang="ts">
/**
 * Solution: building billing into a product. Sells what an app gets (plan-driven feature access,
 * one integration for every gateway, usage, analytics), not table-stakes API practice.
 */
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkPageFlow from "~/components/marketing/MkPageFlow.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageTrust from "~/components/marketing/MkPageTrust.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";
import MkRelated from "~/components/marketing/MkRelated.vue";
import gatewayData from "../../../data/gateways.json";

definePageMeta({ layout: "marketing", header: false, footer: false });

const gateways = gatewayData.gateways.map((g) => g.name);
const gatewayCount = gateways.length;

const why = [
  {
    label: "Plan limits live in billing",
    body: "Change a plan's seats or quota in the dashboard. Your app reads the new limit at the next check. No release.",
  },
  {
    label: "One integration, any gateway",
    body: "Write the payment flow once. Each business selects its own gateway, and your code stays the same.",
  },
  {
    label: "Your numbers, in your tools",
    body: "MRR, churn and cohorts from the analytics API: the same figures the dashboard shows.",
  },
];

const access = [
  {
    icon: "i-lucide-toggle-right",
    title: "Switches, quotas and meters",
    body: "On or off, a number of seats, or a metered amount.",
  },
  {
    icon: "i-lucide-layers",
    title: "Granted by the plan",
    body: "An upgrade changes access the moment it applies.",
  },
  {
    icon: "i-lucide-user-cog",
    title: "Overrides per subscription",
    body: "Give one customer 15 seats without a new plan.",
  },
  {
    icon: "i-lucide-message-square-text",
    title: "An answer with a reason",
    body: "Within the limit, over it, or not on the plan.",
  },
];

const payments = [
  {
    icon: "i-lucide-settings-2",
    title: "The gateway is a setting",
    body: "Add a gateway account; your code does not change.",
  },
  {
    icon: "i-lucide-landmark",
    title: "Money settles with you",
    body: "Payments go to the business's own gateway account.",
  },
  {
    icon: "i-lucide-arrow-left-right",
    title: "Routed by currency",
    body: "Each charge goes to the account that takes its currency.",
  },
  {
    icon: "i-lucide-wallet",
    title: "Cards, wallets, bank debits",
    body: "Whatever each gateway offers, on the same API.",
  },
];

const usage = [
  {
    icon: "i-lucide-clock",
    title: "The timestamp decides the period",
    body: "A record sent late still bills in the right month.",
  },
  {
    icon: "i-lucide-sigma",
    title: "Sum, peak, unique or last",
    body: "Count API calls, peak seats or active users.",
  },
  {
    icon: "i-lucide-eraser",
    title: "Correct before it bills",
    body: "Delete a wrong record until an invoice carries it.",
  },
  {
    icon: "i-lucide-gauge",
    title: "Usage so far, on demand",
    body: "Show customers what they used this period.",
  },
];

const analytics = [
  {
    icon: "i-lucide-chart-line",
    title: "One endpoint, every measure",
    body: "MRR, ARR, churn, retention and receivables.",
  },
  {
    icon: "i-lucide-coins",
    title: "Per currency",
    body: "Dollars and euros are never added together.",
  },
  {
    icon: "i-lucide-split",
    title: "Cut by one dimension",
    body: "By plan, country, currency or business.",
  },
  {
    icon: "i-lucide-history",
    title: "Says how fresh it is",
    body: "Each answer carries when it was computed.",
  },
];

const steps = [
  {
    icon: "i-lucide-package",
    title: "Model plans and features",
    body: "In test mode, in the dashboard or by API.",
  },
  {
    icon: "i-lucide-plug",
    title: "Connect your app",
    body: "Check entitlements and send usage.",
  },
  {
    icon: "i-lucide-credit-card",
    title: "Add a gateway account",
    body: "The one the business already uses.",
  },
  {
    icon: "i-lucide-rocket",
    title: "Go live",
    body: "Copy your catalog to live, with a preview of each change.",
  },
];

const faq = [
  {
    label: "Can I keep plan limits out of my code?",
    content:
      "Yes. Define features and grant them per plan. Your app asks the entitlement check, so a limit change needs no release.",
  },
  {
    label: "Do I have to use the dashboard?",
    content:
      "No. Every screen in the dashboard is also an endpoint, so anything you can do there, you can do by API.",
  },
  {
    label: "Which payment gateways can I use?",
    content: `${gatewayCount} gateways, each on the business's own account. The integrations page lists them with the methods each one takes.`,
  },
  {
    label: "Can I run it on my own servers?",
    content:
      "Yes. Two Minute Billing is open source, and the self-hosted edition has every billing feature.",
  },
  {
    label: "How do I test before real money moves?",
    content:
      "Each business has a test mode with test cards. Build and check everything there, then go live.",
  },
];

const docs = [
  {
    icon: "i-lucide-zap",
    label: "Quickstart",
    description: "From sign-up to a first subscription.",
    to: "/help/developers/getting-started/quickstart",
  },
  {
    icon: "i-lucide-braces",
    label: "API reference",
    description: "Every endpoint, with a request and a response.",
    to: "/help/developers/api-reference",
  },
  {
    icon: "i-lucide-shield-check",
    label: "Entitlements",
    description: "Features, plan grants and the check.",
    to: "/help/developers/api-reference/entitlements",
  },
];

useMarketingSeo({
  title: "Subscription billing API for developers",
  crumb: "Developers",
  description:
    "Build billing into your product: check plan limits from your app, record usage, read MRR by API, and charge through 12 payment gateways with one integration.",
  og: {
    headline: "Billing API",
    title: "Build billing into your product, not around it",
    description: "Plan limits, usage, analytics and 12 gateways behind one API.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Subscription billing API"
      title="Build billing into your product, not around it"
      description="Every screen in the dashboard is also an API endpoint. Check plan limits from your app, record usage as it happens, and charge through the payment gateway each business already uses."
      :secondary="{ label: 'API reference', to: '/help/developers/api-reference' }"
    >
      <MkIllustration
        name="IllDevelopersHero"
        :width="600"
        :height="460"
        alt="Your app asks whether a customer can add 3 seats, and the answer is allowed, with 10 seats on the plan."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Pricing changes without a deploy, and one integration for every gateway"
      :items="why"
    />

    <MkPageZig
      kicker="Feature access"
      title="Gate features and quotas from the plan"
      accent="from the plan"
      description="Define features once and grant them per plan. Your app asks one question: can this subscription use it, and how much?"
      :points="access"
      :links="[
        { label: 'Entitlements', to: '/help/developers/api-reference/entitlements' },
        { label: 'Plans and pricing', to: '/product/subscriptions' },
      ]"
    >
      <div
        class="mk-surface p-6"
        role="img"
        aria-label="The Growth plan grants SSO, 10 seats and 100,000 API calls a month. One subscription has an override of 15 seats."
      >
        <div aria-hidden="true">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-xs text-muted">Plan</div>
              <div class="text-lg font-semibold text-highlighted">Growth</div>
            </div>
            <UBadge color="neutral" variant="subtle">3 features</UBadge>
          </div>
          <dl class="mt-4 divide-y divide-default border-t border-default text-sm">
            <div class="flex justify-between py-3">
              <dt>SSO</dt>
              <dd class="font-semibold text-highlighted">On</dd>
            </div>
            <div class="flex justify-between py-3">
              <dt>Seats</dt>
              <dd class="font-semibold text-highlighted tabular-nums">10</dd>
            </div>
            <div class="flex justify-between py-3">
              <dt>API calls a month</dt>
              <dd class="font-semibold text-highlighted tabular-nums">100,000</dd>
            </div>
          </dl>
          <div
            class="mt-3 flex items-center justify-between rounded-lg bg-elevated px-3 py-2.5 text-sm"
          >
            <span>One subscription · Seats</span>
            <span class="font-semibold text-highlighted">15 · override</span>
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Payments"
      :title="`One integration for ${gatewayCount} payment gateways`"
      :accent="`${gatewayCount} payment gateways`"
      description="Build checkout, renewals and refunds once. Which gateway charges the card is a setting on the business, not code in your app."
      :points="payments"
      :links="[
        { label: 'Integrations', to: '/integrations' },
        { label: 'Payments', to: '/product/payments' },
      ]"
    >
      <div
        class="mk-surface p-6"
        role="img"
        :aria-label="`${gatewayCount} payment gateways behind one billing API: ${gateways.join(', ')}.`"
      >
        <div aria-hidden="true">
          <div class="flex justify-center">
            <span class="rounded-xl bg-(--ui-primary) px-4 py-2.5 text-sm font-semibold text-white">
              Your app · one billing API
            </span>
          </div>
          <div class="mx-auto h-6 w-px bg-(--ui-border-accented)" />
          <ul class="grid grid-cols-2 gap-2.5 text-center text-sm font-semibold sm:grid-cols-3">
            <li
              v-for="g in gateways"
              :key="g"
              class="rounded-lg border border-default px-2 py-2.5 text-highlighted"
            >
              {{ g }}
            </li>
          </ul>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      kicker="Usage"
      title="Send usage as it happens. It bills at the period end"
      accent="at the period end"
      description="Record API calls, messages or storage from your app. The renewal invoice prices them with the plan fee."
      :points="usage"
      :links="[
        { label: 'Usage-based billing', to: '/solutions/usage' },
        { label: 'Usage recipe', to: '/help/developers/recipes/usage-based-billing' },
      ]"
    >
      <div
        class="mk-surface p-6"
        role="img"
        aria-label="Usage this period for one subscription: 128,400 API calls. One record was sent the next day and still bills in this period."
      >
        <div aria-hidden="true">
          <div class="text-xs text-muted">API calls · 1 – 30 Nov</div>
          <div class="mt-1 text-4xl font-semibold tracking-tight text-highlighted tabular-nums">
            128,400
          </div>
          <dl class="mt-4 divide-y divide-default border-t border-default text-sm tabular-nums">
            <div class="flex justify-between py-2.5">
              <dt class="text-muted">16 Nov, 10:00</dt>
              <dd>1,420</dd>
            </div>
            <div class="flex justify-between py-2.5">
              <dt class="text-muted">16 Nov, 11:00 · sent 17 Nov</dt>
              <dd>1,385</dd>
            </div>
            <div class="flex justify-between py-2.5">
              <dt class="text-muted">16 Nov, 12:00</dt>
              <dd>1,502</dd>
            </div>
          </dl>
          <UBadge class="mt-3" color="success" variant="subtle">Bills on the 1 Dec invoice</UBadge>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Analytics"
      title="The dashboard's numbers, in your own tools"
      accent="in your own tools"
      description="One endpoint answers every figure on the dashboard. Pull MRR, churn and cohorts into your warehouse or BI tool."
      :points="analytics"
      :links="[
        { label: 'Analytics API', to: '/help/developers/concepts/analytics' },
        { label: 'Reporting', to: '/product/reporting' },
      ]"
    >
      <div
        class="grid grid-cols-2 gap-3"
        role="img"
        aria-label="MRR of $284,750 in US dollars, up 5.1% in 30 days, and net revenue retention of 104% over the last 12 months, read from the analytics API."
      >
        <div class="mk-surface p-5" aria-hidden="true">
          <div class="text-xs text-muted">MRR · USD</div>
          <div class="mt-1 text-3xl font-semibold tracking-tight text-highlighted tabular-nums">
            $284,750
          </div>
          <UBadge class="mt-2" color="success" variant="subtle">+5.1% in 30 days</UBadge>
        </div>
        <div class="mk-surface p-5" aria-hidden="true">
          <div class="text-xs text-muted">Net revenue retention</div>
          <div class="mt-1 text-3xl font-semibold tracking-tight text-highlighted tabular-nums">
            104%
          </div>
          <div class="mt-2 text-xs text-muted">Last 12 months</div>
        </div>
        <div
          class="mk-surface col-span-2 flex flex-wrap justify-between gap-2 px-5 py-3.5 text-sm text-muted"
          aria-hidden="true"
        >
          <span>Read by your BI tool, nightly</span>
          <span class="font-semibold text-highlighted">Computed 02:00 UTC</span>
        </div>
      </div>
    </MkPageZig>

    <MkPageFlow kicker="How it works" title="From a test business to live billing" :steps="steps" />

    <MkPageTrust />

    <MkFaq :items="faq" title="Developer questions" />

    <MkRelated title="Start in the docs" :links="docs" />

    <MkCta
      title="Check your first entitlement in test mode"
      accent="first entitlement"
      description="Create a plan with a feature, subscribe a test customer, and ask the API. No credit card required."
      :secondary="{ label: 'API reference', to: '/help/developers/api-reference' }"
    />
  </div>
</template>
