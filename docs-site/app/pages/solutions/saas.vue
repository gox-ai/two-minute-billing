<script setup lang="ts">
/** Solution: B2B SaaS: plans, seats, add-ons, self-serve changes, entitlements, sales-led deals. */
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

const pricing = [
  {
    icon: "i-lucide-users",
    title: "Seats",
    body: "Per-unit prices for seats, or tiered and volume prices that get cheaper as a team grows.",
  },
  {
    icon: "i-lucide-puzzle",
    title: "Add-ons",
    body: "Extra seats, premium support or a module, on the same renewal date and the same invoice.",
  },
  {
    icon: "i-lucide-calendar-range",
    title: "Monthly and yearly",
    body: "Several prices on one product, in each currency you sell in.",
  },
  {
    icon: "i-lucide-gauge",
    title: "Usage on top",
    body: "A metered line next to the plan, billed in arrears.",
    to: "/solutions/usage",
  },
];

const selfServe = [
  {
    icon: "i-lucide-shopping-cart",
    title: "Hosted checkout",
    body: "Trial or paid sign-up on a page with your brand, showing exactly what is due today.",
  },
  {
    icon: "i-lucide-arrow-up-right",
    title: "Upgrade links",
    body: "Send a checkout link that changes an existing subscription, with the proration shown before they pay.",
  },
  {
    icon: "i-lucide-user-cog",
    title: "A customer portal",
    body: "Cards, invoices, billing details, and pausing or cancelling when you allow it.",
  },
];

const salesLed = [
  {
    icon: "i-lucide-file-clock",
    title: "Invoices with terms",
    body: "For accounts that pay by transfer: send the invoice with net terms and record the payment.",
  },
  {
    icon: "i-lucide-sliders-horizontal",
    title: "Negotiated exceptions",
    body: "Override one subscription's entitlements without inventing a new plan.",
  },
  {
    icon: "i-lucide-contact",
    title: "HubSpot, both ways",
    body: "Customers, subscriptions and prices flow to contacts, companies, deals and products.",
    to: "/integrations",
  },
];

const access = [
  {
    icon: "i-lucide-list-checks",
    title: "Define features once",
    body: "A switch such as SSO, or a limit such as seats, with a key your app reads.",
  },
  {
    icon: "i-lucide-package",
    title: "Grant them per plan",
    body: "Each product carries its features, so a new plan is a catalog change, not a deploy.",
  },
  {
    icon: "i-lucide-user-cog",
    title: "Override one subscription",
    body: "Give one customer more seats without inventing a new plan.",
  },
  {
    icon: "i-lucide-shield-question",
    title: "Check from your app",
    body: "Ask whether a subscription has a feature, and get a yes or no with the reason.",
  },
];

const matrix = [
  { key: "seats", starter: "5", growth: "25", scale: "100" },
  { key: "sso", starter: "—", growth: "On", scale: "On" },
  { key: "api_access", starter: "—", growth: "On", scale: "On" },
  { key: "audit_log", starter: "—", growth: "—", scale: "On" },
];

const why = [
  {
    label: "Eight pricing models",
    body: "Per seat, tiered, volume, usage and more, so the pricing page you want is the pricing page you ship.",
  },
  {
    label: "New plans without a deploy",
    body: "Your app checks feature keys, not plan ids. A new plan is a catalog change.",
  },
  {
    label: "Self-serve and sales-led in one place",
    body: "Self-serve card sign-ups and sales-led invoices with terms, in the same business.",
  },
];

const steps = [
  {
    icon: "i-lucide-hourglass",
    title: "Free trial",
    body: "The customer signs up on your hosted checkout. Nothing is charged until the trial ends.",
  },
  {
    icon: "i-lucide-badge-check",
    title: "First invoice",
    body: "The trial converts, the card is charged, and the features of the plan turn on.",
  },
  {
    icon: "i-lucide-users",
    title: "More seats",
    body: "The team grows. An upgrade link charges the prorated difference.",
  },
  {
    icon: "i-lucide-repeat",
    title: "Every renewal",
    body: "Plan, seats and add-ons renew on one date, on one invoice.",
  },
];

const faq = [
  {
    label: "Can I bill per seat?",
    content:
      "Yes. Use a per-unit price for a flat price per seat, or tiered and volume prices that get cheaper as a team grows. Change the quantity, and the difference is prorated.",
  },
  {
    label: "How do upgrades and downgrades work?",
    content:
      "Unused time is credited and the new plan is charged for the rest of the period. The renewal date stays put. Apply upgrades now and schedule downgrades for the end of the term.",
  },
  {
    label: "How does my app know what a customer paid for?",
    content:
      "Define features once, grant them on each plan, and ask the API whether a subscription has one. Gate on the feature key, not the plan id, so adding a plan is a catalog change instead of a deploy.",
  },
  {
    label: "Can a sales-led deal and a self-serve sign-up live in the same account?",
    content:
      "Yes. Both are ordinary subscriptions in the same business. One pays by card through checkout; the other gets invoices with terms.",
  },
];

const related = [
  ...PRODUCT.filter((p) =>
    ["/product/subscriptions", "/product/checkout-portal", "/product/reporting"].includes(p.to),
  ),
  {
    to: "/solutions/usage",
    icon: "i-lucide-gauge",
    label: "Usage-based billing",
    description: "Meter what customers use and bill it in arrears.",
  },
  {
    to: "/help/developers/recipes/trials",
    icon: "i-lucide-book-open",
    label: "Free trials recipe",
    description: "Trials with and without a card, by API.",
  },
  {
    to: "/help/developers/concepts/entitlements",
    icon: "i-lucide-key-round",
    label: "Entitlements",
    description: "Features, limits and the check your app makes.",
  },
];

useMarketingSeo({
  title: "SaaS billing for seats and add-ons",
  crumb: "SaaS",
  description:
    "SaaS billing software for plans, seats and add-ons, with free trials, proration, self-serve upgrades, entitlements and invoices with payment terms.",
  og: {
    headline: "SaaS billing",
    title: "SaaS billing for seats, add-ons, free trials and invoices with terms",
    description: "Plans, seats, add-ons and entitlements.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="SaaS billing software"
      title="SaaS billing for seats, add-ons, free trials and invoices with terms"
      description="Two Minute Billing is SaaS billing software for per-seat plans and add-ons, with free trials, proration and self-serve upgrades. Entitlements your app can check keep the plan matrix in one place, and sales-led deals get invoices with terms."
      :secondary="{
        label: 'Customers and subscriptions guide',
        to: '/help/guides/customers-and-subscriptions',
      }"
    >
      <MkIllustration
        name="IllSaasHero"
        :width="600"
        :height="460"
        alt="A Growth plan with 25 seats. Your app asks whether the customer can have 20 seats, and the entitlement check answers allowed."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Eight pricing models, and new plans without a deploy"
      description="Every pricing test, new tier or enterprise exception is revenue. If billing cannot express it, the change waits for engineering or the invoice goes out wrong."
      :items="why"
    />

    <MkPageZig
      kicker="Seat-based billing"
      title="Seat-based pricing with add-ons, yearly plans and usage on top"
      accent="Seat-based pricing"
      description="Eight pricing models, any interval, every currency. Editing a price never reprices the customers already on it."
      :points="pricing"
      :links="[{ label: 'Subscription management and proration', to: '/product/subscriptions' }]"
    >
      <MkShot
        src="/product/fragments/subscription-items"
        alt="A subscription with a Growth plan and two extra seats as an add-on, and the tax on the next renewal"
        :width="1556"
        :height="1156"
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Self-serve"
      title="Self-serve from free trial to upgrade"
      accent="upgrade"
      description="Customers buy, upgrade and update their card without writing to your support team."
      :points="selfServe"
      :links="[{ label: 'Checkout and portal', to: '/product/checkout-portal' }]"
    >
      <MkShot
        src="/product/fragments/hosted-checkout"
        alt="Hosted checkout for a trial: the buyer's details, the plan, nothing due today and the price each period"
        :width="2272"
        :height="912"
        :crop="[1482, 212, 790, 700]"
      />
    </MkPageZig>

    <MkPageZig
      kicker="Entitlements"
      title="Entitlements: one plan matrix, read by your app"
      accent="your app"
      description="Feature access lives next to the price, so sales, billing and the product agree on what each customer has."
      :points="access"
      :links="[{ label: 'Entitlements', to: '/help/developers/concepts/entitlements' }]"
    >
      <figure class="mk-surface overflow-hidden" role="img" aria-labelledby="sa-mx">
        <figcaption id="sa-mx" class="sr-only">
          A plan matrix: Starter has 5 seats, Growth has 25 seats with SSO and API access, and Scale
          has 100 seats with SSO, API access and the audit log.
        </figcaption>
        <table class="w-full text-sm" aria-hidden="true">
          <thead class="bg-elevated/60 text-xs text-muted">
            <tr>
              <th class="px-4 py-2.5 text-left font-medium">Feature</th>
              <th class="px-3 py-2.5 text-right font-medium">Starter</th>
              <th class="bg-(--mk-lime-soft) px-3 py-2.5 text-right font-medium">Growth</th>
              <th class="px-4 py-2.5 text-right font-medium">Scale</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="m in matrix" :key="m.key">
              <td class="px-4 py-2.5">
                <code class="text-xs text-highlighted">{{ m.key }}</code>
              </td>
              <td class="px-3 py-2.5 text-right tabular-nums text-muted">{{ m.starter }}</td>
              <td
                class="bg-(--mk-lime-soft) px-3 py-2.5 text-right font-medium tabular-nums text-highlighted"
              >
                {{ m.growth }}
              </td>
              <td class="px-4 py-2.5 text-right tabular-nums text-highlighted">{{ m.scale }}</td>
            </tr>
          </tbody>
        </table>
      </figure>
    </MkPageZig>

    <MkPageZig
      flip
      bleed
      kicker="Sales-led"
      title="Invoices with net terms and per-customer exceptions for sales-led deals"
      accent="sales-led deals"
      description="Larger accounts want invoices, terms and exceptions. They get them without a second billing system."
      :points="salesLed"
      :links="[
        { label: 'Invoices with payment terms', to: '/product/invoicing' },
        { label: 'Integrations', to: '/integrations' },
      ]"
    >
      <MkPageBleed
        src="/product/invoices"
        alt="The invoice list, with the status, amount, due date and customer of each invoice"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageZig
      kicker="SaaS metrics"
      title="New, expansion, contraction and churn MRR, with cohorts by sign-up month"
      accent="cohorts"
      description="New, expansion, contraction and churn MRR every month, cohorts by sign-up month, and cancellation reasons your team records."
      :links="[{ label: 'Reporting', to: '/product/reporting' }]"
    >
      <MkShot
        src="/product/fragments/mrr-chart"
        alt="The MRR trend over 30 days, with the change against the previous period"
        :width="1560"
        :height="858"
      />
    </MkPageZig>

    <MkPageFlow kicker="How it works" title="From free trial to every renewal" :steps="steps" />

    <MkPageTrust />

    <MkFaq :items="faq" title="SaaS billing questions" />

    <MkRelated title="Read next" :links="related" />

    <MkCta
      title="Set up your plans and add-ons in test mode"
      accent="test mode"
      description="Create your plans and add-ons, subscribe a test customer, and upgrade them mid-period to see the proration."
      shot="/product/subscription-detail"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />
  </div>
</template>
