<script setup lang="ts">
/**
 * Solution: billing for ecommerce and D2C stores that sell products once and on repeat, from one
 * catalog and one hosted checkout. Only what exists: one-time purchases (paid invoice, no
 * subscription, card saving never/always/ask), buy links with quantity limits and optional items,
 * a cart mixing one-time items with a subscription, checkout reminders, skip a renewal (12 ahead,
 * 48 h cut-off, portal limit per 12 months), pause, coupons, recovery, VAT, sales tax and GST by
 * region, credit notes, webhooks, and a shipping address at checkout with a per-customer address
 * book (one address per subscription, managed in the portal, kept on each invoice). No store
 * plugins, inventory, shipping rates, order management, tax from the shipping address (tax
 * follows the billing address) or "add to next order", so the page claims none of them.
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

const freeBand = await useFreeBand();

const why = [
  {
    label: "One catalog for both",
    body: "A product sells once, on a schedule, or both. One list of products and prices, not two systems.",
  },
  {
    label: "A skip keeps the customer",
    body: "A skipped order is not charged, and the subscription stays active. A cancellation ends every order after it.",
  },
  {
    label: "Your store stays in charge",
    body: "Stock, shipping and orders stay in your store. An event goes out for every billing change.",
  },
  {
    figure: "0%",
    label: "No share of your revenue",
    body: "Two Minute Billing takes 0% of your revenue. Payments settle in your own gateway account, and Cloud plans are a flat monthly price.",
  },
];

const once = [
  {
    icon: "i-lucide-link",
    title: "Buy links",
    body: "One link per product or bundle, with a quantity and optional extras. Each visitor gets their own checkout.",
  },
  {
    icon: "i-lucide-shopping-cart",
    title: "Once and on repeat, one cart",
    body: "A one-time item and a subscription in one checkout. It shows what is due today, with tax.",
  },
  {
    icon: "i-lucide-truck",
    title: "Ship-to address at checkout",
    body: "Ask for a shipping address, optional or required. Buyers ship to their billing address in one tick, or enter another.",
  },
  {
    icon: "i-lucide-mail",
    title: "Unfinished checkout emails",
    body: "When you turn them on: one email an hour after a buyer leaves, and one a day later.",
  },
];

const repeat = [
  {
    icon: "i-lucide-calendar-x",
    title: "Skip a delivery",
    body: "Skip one or more of the next 12 orders, within a yearly limit you set. Nothing is charged that cycle.",
  },
  {
    icon: "i-lucide-clock",
    title: "A cut-off you can plan by",
    body: "Skips close 48 hours before each order, so you know the size of each run.",
  },
  {
    icon: "i-lucide-pause",
    title: "Pause and resume",
    body: "Stop orders for a while and start again. Your team can set the resume date.",
  },
  {
    icon: "i-lucide-ticket-percent",
    title: "Subscribe-and-save coupons",
    body: "A percentage or fixed discount, for one order, some orders or every order.",
  },
];

const recover = [
  {
    icon: "i-lucide-layers",
    title: "Backup cards",
    body: "If the default card declines, the customer's other saved cards are tried.",
  },
  {
    icon: "i-lucide-clock",
    title: "Retries timed by the decline",
    body: "Smart mode retries a network error within hours and low funds near a likely payday.",
  },
  {
    icon: "i-lucide-calendar-clock",
    title: "Card-expiry emails",
    body: "Customers hear before a card that pays a live subscription expires.",
  },
  {
    icon: "i-lucide-mouse-pointer-click",
    title: "Pay in one click",
    body: "Each reminder has a link to pay. A new card pays what is owed at once.",
  },
];

const tax = [
  {
    icon: "i-lucide-globe",
    title: "VAT by country",
    body: "A tax region for each country you sell to, with your rates.",
  },
  {
    icon: "i-lucide-arrow-left-right",
    title: "EU business customers",
    body: "Reverse charge and your note, with the VAT number checked in VIES.",
  },
  {
    icon: "i-lucide-map",
    title: "US sales tax by state",
    body: "A rate per state. The customer's state decides which applies.",
  },
  {
    icon: "i-lucide-indian-rupee",
    title: "India: GST with HSN codes",
    body: "An HSN code on every line, and CGST and SGST or IGST by place of supply.",
  },
];

const steps = [
  {
    icon: "i-lucide-package",
    title: "Add your products",
    body: "A one-time price, a monthly price, or both, in each currency, with a tax code (HSN in India).",
  },
  {
    icon: "i-lucide-link",
    title: "Share a link or the checkout",
    body: "On a product page, in an email or in a post. The buyer pays on a hosted page.",
  },
  {
    icon: "i-lucide-repeat",
    title: "Orders bill themselves",
    body: "A one-time order is paid at checkout. A repeat order bills on its date.",
  },
  {
    icon: "i-lucide-truck",
    title: "Your store ships",
    body: "A webhook tells your store what to pack, hold or stop.",
  },
];

const related = [
  {
    to: "/product/checkout-portal",
    icon: "i-lucide-shopping-cart",
    label: "Hosted checkout and customer portal",
    description: "Buy links, a pricing page and a self-serve portal.",
  },
  {
    to: "/product/recovery",
    icon: "i-lucide-rotate-ccw",
    label: "Dunning and failed payment recovery",
    description: "Backup cards, smart retries and emails with a link to pay.",
  },
  {
    to: "/product/tax",
    icon: "i-lucide-landmark",
    label: "VAT, sales tax and GST on invoices",
    description: "Reverse charge, rates by country and state, and HSN codes.",
  },
  {
    to: "/help/developers/webhooks",
    icon: "i-lucide-webhook",
    label: "Webhooks",
    description: "An event for each billing change, so your store knows what to ship.",
  },
];

const faq = [
  {
    label: "Can a customer buy something once and subscribe in the same checkout?",
    content:
      "Yes. Put a one-time item and a subscription in one checkout. It shows what is due today, with tax. The one-time item is billed once, and only the subscription renews.",
  },
  {
    label: "Do you have a plugin for my store platform?",
    content:
      "No. Connect your store with the REST API and webhooks. Inventory, shipping and orders stay in your store.",
  },
  {
    label: "Can customers ship to a different address?",
    content:
      "Yes. The checkout can ask for a shipping address, optional or required. Each customer keeps an address book, each subscription can ship to its own address, and customers change it in the portal. Every invoice keeps the address it was issued with, and your store gets it through the API and webhooks. Tax follows the billing address.",
  },
  {
    label: "Which payment gateways can I use?",
    content: "Your own gateway account. Payments go to that account at its own rates.",
  },
  {
    label: "What is the difference between skipping and pausing?",
    content:
      "A skip passes over the orders you select, and the subscription stays active. A pause stops all orders until the subscription resumes.",
  },
  {
    label: "Do one-time orders count toward MRR?",
    content:
      "No. MRR counts committed repeat revenue only. One-time orders show in your invoices and revenue, not in MRR.",
  },
  {
    label: "Can I charge VAT, sales tax or GST on physical products?",
    content:
      "Yes. Add a tax region for each country you sell to, with your rates. EU business customers get reverse charge after a VAT number check. In India, add HSN codes and GST splits by place of supply. We do not file returns.",
  },
  {
    label: "Can I refund part of an order?",
    content:
      "Yes. Issue a credit note for the part to return and refund it to the original payment method, or keep it as credit for the next order.",
  },
];

useMarketingSeo({
  title: "Subscription billing for ecommerce",
  crumb: "Ecommerce",
  description:
    "Subscription billing for ecommerce: one-time and repeat orders from one catalog and checkout, with skip, pause and VAT, sales tax or GST on every invoice.",
  og: {
    headline: "Subscription billing for ecommerce",
    title: "Sell products once or on repeat, from one checkout",
    description: "One-time and repeat orders on your own gateway.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Subscription billing for ecommerce"
      title="Sell products once or on repeat, from one checkout"
      description="Two Minute Billing bills one-time and repeat orders from one catalog and one checkout, on your own payment gateway, at a flat monthly price with no share of your revenue. Your store keeps the stock and the shipping."
      :secondary="{ label: 'How one checkout works', to: '#checkout' }"
      :note="`Free while you bill less than ${freeBand} a month. No credit card required.`"
    >
      <MkIllustration
        name="IllEcomHero"
        :width="600"
        :height="460"
        alt="One checkout with daily vitamins every month at $32.00 and a shaker bottle once at $18.00: $50.00 due today. The bottle becomes a paid one-time order and the vitamins an active repeat order."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Subscription ecommerce billing with no share of your revenue"
      description="Subscription billing for ecommerce charges for physical products on a schedule, next to one-time orders. Two Minute Billing runs both from the same products, prices and checkout, and lets repeat customers skip or pause instead of cancelling."
      :items="why"
    />

    <MkPageZig
      id="checkout"
      kicker="One-time orders"
      title="Sell a product once, with a paid invoice"
      accent="once"
      description="A buy link or the hosted checkout takes a one-time order. The buyer pays, gets a paid invoice with tax, and no subscription starts."
      :points="once"
      :links="[
        { label: 'Hosted checkout', to: '/product/checkout-portal' },
        { label: 'One-time purchases guide', to: '/help/developers/recipes/one-time-purchases' },
      ]"
    >
      <MkIllustration
        name="IllEcomBuyLink"
        :width="600"
        :height="420"
        alt="A buy link for a shaker bottle: quantity 2 and an optional spare lid, $40.00 paid. The invoice is paid and no subscription starts."
      />
    </MkPageZig>

    <MkPageZig
      id="skip"
      flip
      kicker="Repeat orders"
      title="Skip a delivery, pause, and subscribe-and-save coupons on repeat orders"
      accent="Skip a delivery"
      description="In the customer portal, subscribers skip one or more of their next 12 orders, or pause, when you allow it. Nothing is charged for a skipped order."
      :points="repeat"
      :links="[
        {
          label: 'Skip a renewal guide',
          to: '/help/guides/customers-and-subscriptions#skip-a-renewal',
        },
        { label: 'Subscriptions', to: '/product/subscriptions' },
      ]"
    >
      <MkIllustration
        name="IllSkipHero"
        :width="600"
        :height="460"
        alt="Daily vitamins at $32.00 a month: January to March paid, April skipped in the customer portal at $0.00, and your store's webhook told to hold the April order."
      />
    </MkPageZig>

    <MkPageZig
      kicker="Failed card recovery"
      title="Keep repeat orders paid when a card fails"
      accent="card fails"
      description="When a card for a repeat order declines, Two Minute Billing tries the customer's other saved cards, retries on a schedule and emails a link to pay."
      :points="recover"
      :links="[{ label: 'Recovery', to: '/product/recovery' }]"
    >
      <MkIllustration
        name="IllCardRecovery"
        :width="600"
        :height="320"
        alt="A renewal retried twice and paid on the second retry: $129.00 recovered."
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Tax on physical goods"
      title="VAT, US sales tax and GST on one-time and repeat orders"
      accent="one-time and repeat orders"
      description="Two Minute Billing applies the same tax rules to one-time and repeat orders, from the rates you enter for each country or US state. We do not file returns."
      :points="tax"
      :links="[
        { label: 'Tax', to: '/product/tax' },
        { label: 'Billing in India', to: '/solutions/india' },
      ]"
    >
      <div class="grid gap-4">
        <MkIllustration
          name="IllPageVatTaxEcommerce"
          :width="600"
          :height="420"
          alt="A German seller's daily vitamins at €40.00: €47.60 with 19% VAT for a German consumer, €40.00 with reverse charge for a French business with a valid VAT number."
        />
        <div>
          <p class="mb-2 text-xs font-medium tracking-wide text-muted uppercase">India example</p>
          <MkIllustration
            name="IllPageGoodsTax"
            :width="600"
            :height="420"
            alt="An invoice for daily vitamins and a shaker bottle, each with its HSN code, with CGST and SGST: ₹2,360.00 total."
          />
        </div>
      </div>
    </MkPageZig>

    <section class="py-14 lg:py-20">
      <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl">
          <p class="mk-kicker mb-4 w-fit">Webhooks to your store</p>
          <h2 class="mk-h2 text-highlighted">Your store gets a webhook for each billing change</h2>
          <p class="mt-4 text-[1.0625rem] leading-relaxed text-muted">
            Two Minute Billing handles the billing only. Stock, shipping and orders stay in your
            store. A webhook goes out for every billing change, so fulfillment knows what to ship,
            where to ship it, what to hold or stop.
          </p>
        </div>
        <MkIllustration
          class="mx-auto mt-10 max-w-4xl"
          name="IllPageHubEcommerce"
          :phone="{ width: 390, height: 755 }"
          :width="800"
          :height="400"
          alt="Orders come in through the hosted checkout, the customer portal or your store's own API calls. The billing engine bills the order and sends your store a webhook: ship the order, hold the order, or ask for a new card."
        />
        <div class="mt-8 text-center">
          <UButton
            to="/help/developers/webhooks"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-arrow-up-right"
          >
            Webhooks
          </UButton>
        </div>
      </div>
    </section>

    <MkPageFlow
      kicker="How it works"
      title="From the first order to every order after it"
      :steps="steps"
    />

    <MkPageTrust />

    <MkFaq :items="faq" title="Ecommerce billing questions" />

    <MkRelated title="Read next" :links="related" />

    <MkCta
      title="Take your first order today"
      accent="today"
      :description="`Every feature from day one. Free while you bill less than ${freeBand} a month, then a flat monthly price. Or self-host the open-source edition.`"
      shot="/product/subscription-detail"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />
  </div>
</template>
