<script setup lang="ts">
/**
 * Pricing (F3). Plans and prices come from our own catalogue through `/api/plans`; the page
 * types none of them. The currency follows the visitor's location (India INR, EU EUR, else
 * USD) — the same rule billing applies — and is not a choice.
 */
import MkFaq from "~/components/marketing/MkFaq.vue";
import type { SchemaOffer } from "~/composables/useMarketingSeo";

definePageMeta({ layout: "marketing", header: false, footer: false });

const { signUp } = useAppLinks();
// "plans-visitor", not "plans": see useFreeBand.
const { data } = await useFetch("/api/plans", { key: "plans-visitor" });

/** From the visitor's location, as billing decides it (India INR, the EU EUR, else USD). Not a choice. */
const currency = computed(() => data.value?.preferred ?? "USD");
const interval = ref<"month" | "year">("year");
const deploy = ref<"cloud" | "self">("cloud");

/** A price for display, with no cents when the amount is whole ("$29", not "$29.00"). */
const fmt = (minor: number, currency: string) =>
  new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);

/** The Free plan from the catalogue, in the visitor's currency. Display-only: never a checkout. */
const free = computed(() => (data.value?.free ?? []).find((p) => p.currency === currency.value));
const freeBand = await useFreeBand("plans-visitor");

/** Cloud and self-hosted, side by side. Only what holds today on both sides. */
const compare = computed(() => [
  { row: "Who runs it", cloud: "We do", self: "You do, on your servers" },
  { row: "Features", cloud: "Every feature", self: "Every feature" },
  { row: "Limits", cloud: "Monthly billing volume, by plan", self: "None" },
  { row: "Upgrades", cloud: "Applied for you", self: "You apply new releases" },
  { row: "Monitoring and alerts", cloud: "Ours, around the clock", self: "Yours to set up" },
  {
    row: "Your payment gateway",
    cloud: "All 12 gateways",
    self: "All 12 gateways",
  },
  {
    row: "Price",
    cloud: `Free while you bill less than ${freeBand.value} a month. Then a flat monthly price.`,
    self: "Free (AGPL-3.0)",
  },
  { row: "Support", cloud: "Included", self: "Enterprise support on request" },
]);

/** The paid plans: Free is its own card, on both tabs. */
const plans = computed(() =>
  (data.value?.plans ?? []).filter(
    (p) => p.amountMinor > 0 && p.currency === currency.value && p.interval === interval.value,
  ),
);

/** The same plan's monthly price, struck through beside the yearly per-month price. */
const monthlyOf = (p: { name: string; currency: string }) =>
  (data.value?.plans ?? []).find(
    (m) => m.name === p.name && m.currency === p.currency && m.interval === "month",
  );

/** Yearly shown per month: the headline is what a month costs, rounded to a whole unit. */
const perMonthMinor = (p: { amountMinor: number }) => Math.round(p.amountMinor / 12 / 100) * 100;

const includes = [
  "Plans, add-ons, one-time products and coupons",
  "Eight pricing models, including tiered and metered usage",
  "Trials, proration and scheduled changes",
  "Invoices and credit notes with branded PDFs",
  "GST by place of supply, VAT reverse charge, TDS",
  "All 12 gateways, several per business",
  "Smart retries, a backup card and recovery emails",
  "Hosted checkout, buy links, pricing page and customer portal",
  "MRR, churn, cohorts and an analytics API",
  "A REST API for every dashboard screen, and webhooks",
  "Test mode with a movable clock in every business",
  "Roles, passkeys, two-factor and an audit log",
];

const faq = computed(() => [
  {
    label: "What counts as billing volume?",
    content:
      "The payments you collect in live mode in a calendar month, less refunds, in your plan's currency. Test mode never counts.",
  },
  {
    label: "What happens if I bill more than my plan covers?",
    content:
      "Your billing carries on. We tell you on the Billing page and ask you to change to a larger plan. If you stay above the limit, we can make your dashboard read-only until you change plan. Your customers are still billed.",
  },
  {
    label: "Is the free plan really free?",
    content: `Yes. It is free while you bill less than ${freeBand.value} a month, in live mode, with every feature and no time limit. No credit card required. Then a flat monthly price.`,
  },
  {
    label: "Can I change plans?",
    content: "Yes, from Settings → Billing at any time, within the same currency.",
  },
  {
    label: "Which currency do I pay in?",
    content:
      "Organizations in India pay in INR, in the European Union in EUR, and everywhere else in USD. Prices are before tax.",
  },
  {
    label: "Do you take a percentage of my revenue, or a fee per transaction?",
    content:
      "No. You pay the plan price. Your payment gateway charges its own fees as it does today.",
  },
]);

/**
 * Offers in the schema come from the same live catalogue read as the cards, in the visitor's
 * currency. If the catalogue cannot be read, only the free plan is listed, with no band.
 */
const offers = computed<SchemaOffer[]>(() => [
  {
    name: "Free plan",
    price: "0",
    priceCurrency: currency.value,
    description: free.value?.description ?? "Every feature in live mode. No credit card required.",
  },
  ...(data.value?.plans ?? [])
    .filter((p) => p.amountMinor > 0 && p.currency === currency.value)
    .map((p) => ({
      name: `${p.name}, billed ${p.interval === "year" ? "yearly" : "monthly"}`,
      price: (p.amountMinor / 100).toFixed(2),
      priceCurrency: p.currency,
      billingDuration: p.interval === "year" ? ("P1Y" as const) : ("P1M" as const),
    })),
]);

useMarketingSeo({
  title: "Billing software pricing",
  crumb: "Pricing",
  description: `Flat monthly subscription billing plans with every feature and no share of your revenue. Free while you bill less than ${freeBand.value} a month. No credit card.`,
  og: STATIC_OG["/pricing"]!,
  faq: faq.value,
  offers,
});
</script>

<template>
  <div>
    <section class="mk-hero border-b border-default">
      <UContainer class="pt-12 pb-10 text-center lg:pt-16 lg:pb-12">
        <p class="mk-kicker mb-4">Pricing</p>
        <h1
          class="mx-auto max-w-3xl text-4xl leading-[1.08] font-semibold text-balance text-highlighted sm:text-5xl"
        >
          A flat price for subscription billing. No share of your revenue.
        </h1>
        <p class="mx-auto mt-5 max-w-2xl text-lg text-muted">
          Every plan has every feature. Plans differ only in how much you bill each month, and the
          Free plan covers you while you bill less than {{ freeBand }} a month.
        </p>
        <!-- The header keeps its sign-up button in the menu on phones. -->
        <UButton :to="signUp" size="lg" class="mt-6 min-h-11 sm:hidden">Start for free</UButton>
        <div class="mt-8 flex justify-center">
          <UTabs
            v-model="deploy"
            :items="[
              { label: 'Cloud', value: 'cloud', icon: 'i-lucide-cloud' },
              { label: 'Self-hosted', value: 'self', icon: 'i-lucide-server' },
            ]"
            :content="false"
            :ui="{ trigger: 'max-sm:min-h-11' }"
            class="w-auto"
          />
        </div>
        <div
          v-if="deploy === 'cloud'"
          class="mt-4 flex flex-wrap items-center justify-center gap-3"
        >
          <UTabs
            v-model="interval"
            :items="[
              { label: 'Monthly', value: 'month' },
              { label: 'Yearly · 20% off', value: 'year' },
            ]"
            :content="false"
            size="sm"
            :ui="{ trigger: 'max-sm:min-h-11' }"
            class="w-auto"
          />
        </div>
      </UContainer>
    </section>

    <UContainer v-if="deploy === 'self'" class="py-10 lg:py-12">
      <div class="mx-auto grid max-w-4xl gap-4 md:grid-cols-2">
        <UPricingPlan
          title="Self-hosted"
          description="The open-source engine, dashboard and docs on your own servers."
          price="Free"
          billing-cycle="AGPL-3.0"
          :features="[
            'Every feature',
            'No plan limits',
            'Your servers, your database, your data',
            'Releases you apply when it suits you',
          ]"
          :button="{ label: 'About self-hosting', to: '/open-source' }"
          highlight
        />
        <UPricingPlan
          title="Enterprise support"
          description="For a self-hosted install that needs a team behind it."
          price="Custom"
          :features="[
            'Help with installation and upgrades',
            'An agreement and support terms',
            'Help moving your billing',
          ]"
          :button="{
            label: 'Contact us',
            to: '/contact?topic=Self-hosted%20support',
            color: 'neutral',
            variant: 'outline',
          }"
        />
      </div>
    </UContainer>

    <UContainer v-else class="py-10 lg:py-12">
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4" data-cta-location="pricing_plan">
        <UPricingPlan
          title="Free"
          :description="`Free while you bill less than ${freeBand} a month. Every feature.`"
          price="Free"
          terms="No time limit. Free for startups."
          :features="[
            'Live mode with every feature',
            'Test mode with every feature',
            'No credit card required',
          ]"
          :button="{
            label: 'Start for free',
            to: signUp,
            color: 'neutral',
            variant: 'outline',
            onClick: () => track('select_plan', { plan: 'Free', billing_period: interval }),
          }"
        />
        <template v-if="data?.available">
          <UPricingPlan
            v-for="p in plans"
            :key="`${p.name}-${p.currency}-${p.interval}`"
            :title="p.name"
            :description="p.description ?? undefined"
            :price="
              p.interval === 'year' && monthlyOf(p)
                ? fmt(monthlyOf(p)!.amountMinor, p.currency)
                : fmt(p.amountMinor, p.currency)
            "
            :discount="p.interval === 'year' ? fmt(perMonthMinor(p), p.currency) : undefined"
            billing-cycle="/month"
            :terms="
              p.interval === 'year'
                ? `Billed yearly at ${fmt(p.amountMinor, p.currency)}`
                : undefined
            "
            :highlight="p.name === 'Growth'"
            :features="[
              'Live mode, every feature',
              'All gateways and currencies',
              'Unlimited customers and team members',
            ]"
            :button="{
              label: 'Get started',
              to: signUp,
              onClick: () =>
                track('select_plan', {
                  plan: p.name,
                  billing_period: p.interval,
                  currency: p.currency,
                }),
            }"
          />
        </template>
        <div
          v-else
          class="flex items-center justify-center rounded-[14px] border border-default p-6 text-center text-sm text-muted md:col-span-1 xl:col-span-3"
        >
          We could not load the plan prices. Reload the page to try again.
        </div>
      </div>
      <div
        class="mt-4 flex flex-col items-start justify-between gap-4 rounded-[14px] border border-default p-6 md:flex-row md:items-center"
      >
        <div>
          <div class="font-semibold text-highlighted">Enterprise</div>
          <p class="mt-1 text-sm text-muted">
            Billing volume above the Scale plan, an agreement and invoicing terms, or help moving
            your billing.
          </p>
        </div>
        <UButton
          to="/contact?topic=Enterprise"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
        >
          Contact us
        </UButton>
      </div>
      <p class="mt-4 text-center text-sm text-muted">
        Prices in {{ currency }}, before tax. Change your plan at any time in Settings → Billing.
      </p>
    </UContainer>

    <section class="mk-tint border-y border-default">
      <UContainer class="grid gap-10 py-10 lg:py-12 lg:grid-cols-[1fr_2fr]">
        <div>
          <h2 class="text-2xl font-medium text-highlighted">Every plan includes</h2>
          <p class="mt-3 text-muted">
            There are no feature tiers. A plan sets how much you bill each month, and nothing else.
          </p>
          <ULink to="/product" class="mt-3 inline-block text-sm font-medium text-primary">
            See how each feature works
          </ULink>
        </div>
        <ul class="grid gap-3 sm:grid-cols-2">
          <li v-for="f in includes" :key="f" class="flex gap-2 text-sm text-toned">
            <UIcon name="i-lucide-check" class="mt-0.5 size-4 shrink-0 text-(--mk-plain)" />
            {{ f }}
          </li>
        </ul>
      </UContainer>
    </section>

    <UPageSection
      title="Cloud or self-hosted"
      description="The same engine either way. The difference is who keeps it running."
    >
      <div class="overflow-x-auto rounded-[14px] border border-default">
        <table class="w-full text-sm">
          <thead class="bg-elevated text-left">
            <tr>
              <th class="px-4 py-3 font-medium text-muted"></th>
              <th class="px-4 py-3 font-semibold text-highlighted">Cloud</th>
              <th class="px-4 py-3 font-semibold text-highlighted">Self-hosted</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="r in compare" :key="r.row">
              <td class="px-4 py-3 font-medium text-highlighted">{{ r.row }}</td>
              <td class="px-4 py-3 text-toned">{{ r.cloud }}</td>
              <td class="px-4 py-3 text-toned">{{ r.self }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UPageSection>

    <MkFaq :items="faq" title="Pricing questions" />
  </div>
</template>
