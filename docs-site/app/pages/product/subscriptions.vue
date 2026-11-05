<script setup lang="ts">
/** Product: catalog, subscription lifecycle, discounts, credits and entitlements. */
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkLoop from "~/components/marketing/MkLoop.vue";
import MkPageBleed from "~/components/marketing/MkPageBleed.vue";
import MkPageFlow from "~/components/marketing/MkPageFlow.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageTrust from "~/components/marketing/MkPageTrust.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";
import MkRelated from "~/components/marketing/MkRelated.vue";
import MkShot from "~/components/marketing/MkShot.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const models = [
  { title: "Flat", body: "The same amount every period." },
  { title: "Per unit", body: "Amount times quantity, for seats and users." },
  { title: "Tiered", body: "Each tier's units at that tier's rate." },
  { title: "Volume", body: "The whole quantity at the rate of its tier." },
  { title: "Stairstep", body: "A flat amount per band, such as up to 50 users." },
  { title: "Package", body: "Blocks of units, such as 1,000 credits." },
  { title: "Usage", body: "What was consumed, billed after the period." },
  { title: "Percentage", body: "A share of a value you report." },
];

const lifecycle = [
  {
    icon: "i-lucide-hourglass",
    title: "Trials",
    body: "Nothing is charged until the trial ends. Then the subscription bills on its normal schedule.",
  },
  {
    icon: "i-lucide-arrow-up-down",
    title: "Upgrades and downgrades",
    body: "Unused time is credited and the new item is charged for the rest of the period. The renewal date stays put.",
  },
  {
    icon: "i-lucide-calendar-clock",
    title: "Scheduled changes",
    body: "Put a downgrade at the end of the term. It shows on the subscription until it happens, and you can withdraw it.",
  },
  {
    icon: "i-lucide-pause",
    title: "Pause and resume",
    body: "Resume inside the paid term and nothing new is charged. Resume after it and a new term starts that day.",
  },
  {
    icon: "i-lucide-circle-x",
    title: "Cancel and reactivate",
    body: "Cancel now or at the end of the term, with a reason. Reactivate later, or clear a cancellation you scheduled.",
  },
  {
    icon: "i-lucide-receipt",
    title: "One-off charges",
    body: "Add a setup fee or an extra and invoice it now, or add it to the next renewal.",
  },
];

const extras = [
  {
    icon: "i-lucide-ticket-percent",
    title: "Coupons",
    body: "Percentage or fixed, once, forever or for a number of periods. Several can stack on one subscription.",
  },
  {
    icon: "i-lucide-tickets",
    title: "Single-use codes",
    body: "Generate a set of codes for a campaign. Each code redeems once; voiding an invoice gives it back.",
  },
  {
    icon: "i-lucide-piggy-bank",
    title: "Account credit",
    body: "Money left over from a downgrade becomes credit and comes off the next invoice before the card is charged.",
  },
  {
    icon: "i-lucide-key-round",
    title: "Entitlements",
    body: "Grant features and limits per plan, override them for one subscription, and check them from your app.",
  },
];

const why = [
  {
    label: "Eight pricing models",
    body: "Flat, per unit, tiered, volume, stairstep, package, usage and percentage, on one catalog.",
  },
  {
    label: "One renewal date per subscription",
    body: "A plan, its add-ons and a metered line renew together, on one invoice.",
  },
  {
    label: "See every change before you confirm it",
    body: "Every upgrade, downgrade and mid-period change shows its proration and tax first.",
  },
];

const steps = [
  {
    icon: "i-lucide-hourglass",
    title: "Trial",
    body: "Nothing is charged until the trial ends. A reminder goes out before it does.",
  },
  {
    icon: "i-lucide-repeat",
    title: "Renew",
    body: "Each period, the invoice is raised and collected on the renewal date.",
  },
  {
    icon: "i-lucide-arrow-up-down",
    title: "Change",
    body: "Upgrade now with proration, or schedule a downgrade for the end of the term.",
  },
  {
    icon: "i-lucide-pause",
    title: "Pause or cancel",
    body: "Pause and resume later, or cancel now or at the term end, with a reason.",
  },
];

const faq = [
  {
    label: "How does proration work on an upgrade?",
    content:
      "Unused time on the old item is credited, and the new item is charged for the rest of the period. The renewal date stays put. You see the amounts, with tax, before you confirm.",
  },
  {
    label: "Can one subscription hold several items?",
    content: "Yes. A plan, two add-ons and a metered line share one renewal date and one invoice.",
  },
  {
    label: "What happens to existing customers when I change a price?",
    content:
      "Nothing. Editing a price affects new subscriptions only. To move existing customers, create the new price and change their subscriptions onto it, with the notice you owe them.",
  },
  {
    label: "Does a downgrade refund the card?",
    content:
      "No. The difference becomes credit on the customer's account and comes off their next invoice. To put money back on the card, issue a refund from a credit note.",
  },
  {
    label: "Can I sell the same plan in several currencies?",
    content:
      "Yes. Add a price per currency to the same product. Each customer is billed in their own currency, so a subscription never mixes two.",
  },
];

useMarketingSeo({
  title: "Subscription management and proration",
  crumb: "Subscriptions",
  parents: [{ name: "Product", path: "/product" }],
  description:
    "Subscription management for plans, add-ons, trials, upgrades and pauses in every currency, with proration worked out and shown before you confirm.",
  og: {
    headline: "Subscription management",
    title: "Subscription management, every change priced first",
    description: "Trials, proration, pauses and scheduled changes.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Subscription management software"
      title="Subscription management that prices every change before you confirm"
      description="Two Minute Billing manages plans, add-ons, free trials, upgrades, downgrades, pauses and scheduled changes, in every currency you sell in. Proration is worked out and shown with tax before anything is charged."
      :secondary="{ label: 'Build your catalog', to: '/help/getting-started/build-your-catalogue' }"
    >
      <MkIllustration
        name="IllSubscriptionsHero"
        :width="600"
        :height="460"
        alt="A change from Growth to Scale is priced before you confirm: unused time on Growth −$49.50 and remaining time on Scale $124.50, so $75.00 is due today, and the next renewal stays on 1 Dec."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Change plans and subscriptions in the dashboard, price shown first"
      description="Every new plan, discount or mid-month upgrade is revenue. When the billing system cannot price it, the deal waits or the invoice goes out wrong."
      :items="why"
    />

    <MkPageZig
      kicker="Pricing models"
      title="Eight pricing models, one catalog"
      accent="one catalog"
      description="One product can carry many prices: Pro monthly and yearly, in USD and EUR, is one product with four. Archive what you stop selling; old invoices still point at it."
      :points="models"
      :links="[
        { label: 'Build your catalog', to: '/help/getting-started/build-your-catalogue' },
        { label: 'Seats and add-ons for SaaS', to: '/solutions/saas' },
        { label: 'Metered usage pricing', to: '/solutions/usage' },
      ]"
    >
      <MkLoop
        name="create-subscription"
        label="Creating a subscription: select a customer and a plan, and the first invoice preview fills in"
        :width="1280"
        :height="720"
      />
    </MkPageZig>

    <MkPageZig
      flip
      bleed
      kicker="Lifecycle"
      title="Upgrades, downgrades and pauses, with proration calculated"
      accent="proration"
      description="Each action asks what should happen to outstanding invoices, unbilled charges and credit, and records a reason your churn reports can use."
      :points="lifecycle"
      :links="[
        {
          label: 'Customers and subscriptions guide',
          to: '/help/guides/customers-and-subscriptions',
        },
        { label: 'Plan changes recipe', to: '/help/developers/recipes/plan-changes' },
      ]"
    >
      <MkPageBleed
        src="/product/subscription-detail"
        alt="A subscription in the dashboard: its plan and add-on, MRR, the next billing date and the payment method"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageZig
      kicker="Discounts and access"
      title="Coupons, credit and entitlements on the subscription"
      accent="entitlements"
      description="The commercial details that usually live in a spreadsheet live on the subscription instead."
      :points="extras"
      :links="[
        { label: 'Coupons recipe', to: '/help/developers/recipes/coupons' },
        { label: 'Prepaid AI credits', to: '/solutions/ai-billing' },
      ]"
    >
      <MkShot
        src="/product/fragments/subscription-items"
        alt="A subscription with a Growth plan and an Extra Seats add-on, and the tax on the next renewal"
        :width="1556"
        :height="1156"
      />
    </MkPageZig>

    <MkPageFlow
      kicker="How it works"
      title="The subscription lifecycle, end to end"
      :steps="steps"
    />

    <MkPageTrust />

    <MkFaq :items="faq" title="Subscription management questions" />

    <MkRelated />

    <MkCta
      title="Model your pricing in test mode"
      accent="pricing"
      description="Create your plans, put a test customer on one, then change it mid-period and read the estimate before you confirm."
      shot="/product/subscription-detail"
      :secondary="{ label: 'Talk to us', to: '/contact' }"
    />
  </div>
</template>
