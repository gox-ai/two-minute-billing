<script setup lang="ts">
/**
 * Solution: usage-based billing on events — meters, rate cards per combination, eight
 * aggregations, billing by timestamp with late usage at its own period's price, and the usage
 * customers see before the bill. Credits and AI pricing live on /solutions/ai-billing.
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

definePageMeta({ layout: "marketing", header: false, footer: false });

const aggregations = [
  { label: "Sum", use: "API calls, messages, GB transferred" },
  { label: "Count", use: "Discrete actions" },
  { label: "Max", use: "Peak seats, peak storage" },
  { label: "Min", use: "Committed floors" },
  { label: "Average", use: "Average concurrent usage" },
  { label: "Last", use: "A gauge you report now and then" },
  { label: "Unique", use: "Monthly active users" },
  { label: "Time-weighted", use: "GB-hours, instance-days" },
];

const meterPoints = [
  {
    icon: "i-lucide-table-2",
    title: "A rate per combination",
    body: "Group by up to 5 properties. A default rate bills anything new.",
  },
  {
    icon: "i-lucide-sigma",
    title: "Sub-cent rates",
    body: "Rates to 12 decimal places, rounded once on each invoice line.",
  },
  {
    icon: "i-lucide-layers",
    title: "Tiers and volume",
    body: "The rate can fall as the quantity grows. Free units come off first.",
  },
  {
    icon: "i-lucide-key-round",
    title: "Your own customer ids",
    body: "Name the customer by a workspace or account id your app already has.",
  },
];

const periodPoints = [
  {
    icon: "i-lucide-clock",
    title: "Late events still bill",
    body: "On the next invoice, as their own line, at their own period's price.",
  },
  {
    icon: "i-lucide-pencil",
    title: "Correct before invoicing",
    body: "Void an event until its invoice is finalized. After that, a credit note.",
  },
  {
    icon: "i-lucide-timer",
    title: "Billed minutes after the period",
    body: "Usage closes about 6 minutes after the period ends, then the renewal invoice bills it.",
  },
  {
    icon: "i-lucide-inbox",
    title: "Nothing dropped",
    body: "An event for a customer or meter you add later is kept and billed then.",
  },
];

const visibilityPoints = [
  {
    icon: "i-lucide-bell",
    title: "Alerts and spend limits",
    body: "Warn at a threshold, or stop usage at a limit.",
  },
  {
    icon: "i-lucide-file-clock",
    title: "Invoice large usage early",
    body: "Bill when unbilled usage reaches an amount, not at month end.",
  },
];

const portalBars = [30, 42, 38, 55, 60, 66, 72, 80, 86];

const steps = [
  {
    icon: "i-lucide-activity",
    title: "You send events",
    body: "As they happen, up to 500 in one request.",
  },
  {
    icon: "i-lucide-gauge",
    title: "Meters count them",
    body: "Per customer and per combination, all period.",
  },
  {
    icon: "i-lucide-file-text",
    title: "The period closes",
    body: "Usage for the period that ended, next to the fee for the one starting.",
  },
  {
    icon: "i-lucide-credit-card",
    title: "It is collected",
    body: "Through your gateway, with discounts, tax and credit applied.",
  },
];

const why = [
  {
    label: "Ways to count usage",
    figure: "8",
    body: "Sum, count, min, max, average, last, unique and time-weighted, so the quantity matches how you price.",
  },
  {
    label: "Late usage is not lost",
    body: "An event that arrives after its period closed bills on the next invoice, dated to its own period, at that period's price.",
  },
  {
    label: "One invoice for fee and usage",
    body: "Next month's plan fee and last month's usage on one document, not a subscription invoice and a usage invoice.",
  },
];

const related = [
  {
    to: "/solutions/ai-billing",
    icon: "i-lucide-sparkles",
    label: "AI billing",
    description: "Model prices, credits and spend limits.",
  },
  {
    to: "/solutions/saas",
    icon: "i-lucide-building-2",
    label: "SaaS billing",
    description: "Seats, plans and add-ons, with entitlements.",
  },
  {
    to: "/help/guides/usage-and-ai-billing",
    icon: "i-lucide-book-open",
    label: "Usage and AI billing guide",
    description: "Meters, rate cards and credits, in the dashboard.",
  },
  {
    to: "/help/developers/recipes/meter-usage-events",
    icon: "i-lucide-code",
    label: "Meter usage events",
    description: "Send events and price a meter, by API.",
  },
];

const faq = [
  {
    label: "What is usage-based billing?",
    content:
      "A pricing model that charges for what a customer used in the period, such as API calls, gigabytes or tokens, often next to a fixed plan fee. It is also called metered billing.",
  },
  {
    label: "Can the same invoice carry a subscription fee and usage?",
    content:
      "Yes. The renewal invoice has the fee for the period that starts and the usage for the period that ended.",
  },
  {
    label: "What if usage arrives late?",
    content:
      "It still bills. It goes on the next invoice as its own line, dated to its own period and at that period's price. Events can be up to 35 days old.",
  },
  {
    label: "Can I correct usage after I send it?",
    content:
      "Yes, until the invoice for its period is finalized: void the event and send a new one. After that, issue a credit note.",
  },
  {
    label: "Does usage count toward MRR?",
    content:
      "No. MRR is committed recurring revenue. Including usage would make MRR move with consumption. Invoices and transactions show the total.",
  },
  {
    label: "How long do you keep usage events?",
    content:
      "25 months online. After that they move to an archive, and the billed totals stay on the invoices.",
  },
];

useMarketingSeo({
  title: "Usage-based billing software",
  crumb: "Usage-based billing",
  description:
    "Usage-based billing on events: meters, a rate card per combination and eight ways to count. Late usage bills at its own period's price, with the fee.",
  og: {
    headline: "Usage-based billing",
    title: "Usage-based billing for what customers use",
    description: "Meters, rate cards and late usage, on one invoice with the plan fee.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Usage-based billing software"
      title="Usage-based billing for what customers use"
      description="Usage-based billing charges for what a customer used in the period, such as API calls, storage, messages or AI tokens. Your app sends usage events. Meters count them, a rate card prices them, and the usage goes on the same invoice as the subscription fee."
      :secondary="{
        label: 'Meter usage events recipe',
        to: '/help/developers/recipes/meter-usage-events',
      }"
    >
      <MkIllustration
        name="IllUsageHero"
        :width="600"
        :height="460"
        alt="12,843 API calls in November at $0.01 each, billed as $128.43 in arrears next to the $99.00 plan: $227.43 total."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Bill every unit, in the right period, at the right price"
      :items="why"
    />

    <MkPageZig
      kicker="Meters and rate cards"
      title="Count usage the way you price it"
      accent="the way you price it"
      description="A meter says which events to count and how. A rate card sets a price for each combination, such as each region or each model."
      :points="meterPoints"
      :links="[
        {
          label: 'Meters and rate cards guide',
          to: '/help/guides/usage-and-ai-billing/meters-and-rate-cards',
        },
      ]"
    >
      <figure class="mk-surface overflow-hidden" role="img" aria-labelledby="us-agg">
        <figcaption id="us-agg" class="sr-only">
          The eight aggregations and what each one bills: sum, count, max, min, average, last,
          unique and time-weighted.
        </figcaption>
        <ul aria-hidden="true" class="divide-y divide-default px-5 text-sm">
          <li v-for="a in aggregations" :key="a.label" class="flex justify-between gap-4 py-2.5">
            <span class="font-semibold text-highlighted">{{ a.label }}</span>
            <span class="text-right text-muted">{{ a.use }}</span>
          </li>
        </ul>
      </figure>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Periods and late data"
      title="The timestamp decides the period"
      accent="decides the period"
      description="Each event bills in the period of its own timestamp, to the exact end of the period. Upload yesterday's batch at midnight, and it bills against yesterday."
      :points="periodPoints"
      :links="[
        { label: 'Usage pricing guide', to: '/help/guides/usage-and-ai-billing/usage-pricing' },
      ]"
    >
      <figure class="mk-surface overflow-hidden" role="img" aria-labelledby="us-late">
        <figcaption id="us-late" class="sr-only">
          An invoice raised on 1 December: the Team plan for December, $49.00, storage for 1 to 30
          November, $101.20, and a separate line for usage from October that arrived late, $3.45,
          billed at October's price.
        </figcaption>
        <div aria-hidden="true">
          <div class="border-b border-default px-5 py-3.5 text-xs text-muted">Invoice · 1 Dec</div>
          <ul class="divide-y divide-default text-sm">
            <li class="flex justify-between gap-3 px-5 py-3">
              <span class="text-highlighted">Team plan · December</span>
              <span class="tabular-nums">$49.00</span>
            </li>
            <li class="flex justify-between gap-3 px-5 py-3">
              <span class="text-highlighted">Storage · 1 – 30 Nov</span>
              <span class="tabular-nums">$101.20</span>
            </li>
            <li class="flex items-start justify-between gap-3 px-5 py-3">
              <span>
                <span class="block text-highlighted">Usage from 1 – 31 Oct</span>
                <span class="text-xs text-muted"
                  >Arrived after October closed · October's price</span
                >
              </span>
              <span class="tabular-nums">$3.45</span>
            </li>
          </ul>
        </div>
      </figure>
    </MkPageZig>

    <MkPageZig
      kicker="No surprises"
      title="Usage your customers see before the bill"
      accent="see before the bill"
      description="The customer portal shows usage so far, by day, and the projected total for the period. You see the same on each customer, with cost and margin."
      :points="visibilityPoints"
      :links="[{ label: 'Prepaid credits and AI billing', to: '/solutions/ai-billing' }]"
    >
      <figure class="mk-surface p-5" role="img" aria-labelledby="us-portal">
        <figcaption id="us-portal" class="sr-only">
          The customer portal's usage page: storage used so far this month, 2,870 GB, by day, with a
          projected 4,450 GB at the end of the period.
        </figcaption>
        <div aria-hidden="true">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs text-muted">Customer portal · Usage</div>
              <div class="text-sm font-semibold text-highlighted">Storage this month</div>
            </div>
            <UBadge color="neutral" variant="subtle">Projected 4,450 GB</UBadge>
          </div>
          <div class="mt-2 text-3xl font-semibold text-highlighted tabular-nums">2,870 GB</div>
          <div class="mt-4 flex h-20 items-end gap-1.5">
            <div
              v-for="(h, i) in portalBars"
              :key="i"
              class="flex-1 rounded"
              :class="i < 6 ? 'bg-(--mk-cyan)' : 'bg-(--mk-cyan-soft)'"
              :style="{ height: `${h}%` }"
            />
          </div>
        </div>
      </figure>
    </MkPageZig>

    <MkPageFlow kicker="How it works" title="From an event to a paid invoice" :steps="steps" />

    <MkPageTrust />

    <MkFaq :items="faq" title="Usage-based billing questions" />

    <MkRelated title="Read next" :links="related" />

    <MkCta
      title="Send your first usage event in test mode"
      accent="in test mode"
      description="Create a meter, price it, and see it on an invoice before you go live."
      shot="/product/subscriptions"
      :secondary="{ label: 'Developers', to: '/solutions/developers' }"
    />
  </div>
</template>
