<script setup lang="ts">
/** Product: hosted checkout, payment links, the public pricing page and the customer portal. */
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

const checkout = [
  {
    icon: "i-lucide-receipt-text",
    title: "What is due today",
    body: "The first invoice with tax and one-time items, or the trial, before the customer pays.",
  },
  {
    icon: "i-lucide-smartphone",
    title: "Ways to pay",
    body: "Apple Pay, Google Pay and Link through Stripe; UPI and net banking through Razorpay.",
  },
  {
    icon: "i-lucide-shield-check",
    title: "3-D Secure on the page",
    body: "When the bank asks for authentication, the customer completes it without leaving.",
  },
  {
    icon: "i-lucide-ticket-percent",
    title: "Coupon codes",
    body: "Let buyers enter a code at checkout, when you allow it.",
  },
];

const links = [
  {
    icon: "i-lucide-link",
    title: "Reusable payment links",
    body: "Share one link anywhere. Each visitor gets a checkout of their own, and opens and sales are counted.",
  },
  {
    icon: "i-lucide-layout-list",
    title: "A hosted pricing page",
    body: "Mark the payment links to show, and the page lists each with its buy button.",
  },
  {
    icon: "i-lucide-list-plus",
    title: "Quantities and optional items",
    body: "Let buyers select a quantity within limits you set, and add optional items.",
  },
  {
    icon: "i-lucide-bell",
    title: "Unfinished checkout emails",
    body: "Optional emails an hour after a buyer leaves, and again a day later, with a link back.",
  },
];

const portal = [
  {
    icon: "i-lucide-credit-card",
    title: "Cards and backups",
    body: "Add a card, and set the default and the backups.",
  },
  {
    icon: "i-lucide-file-down",
    title: "Invoices",
    body: "See and download every invoice, and pay what is owed.",
  },
  {
    icon: "i-lucide-id-card",
    title: "Billing details",
    body: "Edit the billing address and tax number, with the fields you allow.",
  },
  {
    icon: "i-lucide-ticket-percent",
    title: "Coupons",
    body: "Apply or remove a coupon on the subscription.",
  },
  {
    icon: "i-lucide-pause",
    title: "Pause, skip or cancel",
    body: "Pause, resume, skip a renewal, cancel or reactivate, each only when you allow it.",
  },
  {
    icon: "i-lucide-sliders-horizontal",
    title: "Your switches",
    body: "Turn each action on or off under Settings → Hosted pages.",
  },
];

const safe = [
  {
    icon: "i-lucide-key-round",
    title: "Single-use entry",
    body: "A portal link works once and expires an hour after it is made. Your API key never reaches the browser.",
  },
  {
    icon: "i-lucide-octagon-x",
    title: "Revoke at any time",
    body: "End a checkout or portal link, and the session it opened, with one action.",
  },
  {
    icon: "i-lucide-palette",
    title: "Your brand",
    body: "Logo, icon and brand color on checkout, the portal, invoices and email.",
  },
  {
    icon: "i-lucide-vault",
    title: "Cards go to your gateway",
    body: "Card details go from the browser to your gateway, never to our servers or yours.",
  },
];

const why = [
  {
    label: "Card numbers never reach your servers",
    body: "Card details go straight to your payment gateway, which keeps your scope at PCI DSS SAQ-A.",
  },
  {
    label: "Portal links work once",
    body: "Each link works once and then expires within an hour, so a forwarded email cannot open the account.",
  },
  {
    label: "Reminders for unfinished checkouts",
    body: "When you turn them on, an unfinished checkout gets a reminder after an hour and again a day later.",
  },
];

const steps = [
  {
    icon: "i-lucide-link",
    title: "Share a link",
    body: "A payment link, the pricing page, or a checkout session your app creates through the API.",
  },
  {
    icon: "i-lucide-shopping-cart",
    title: "The buyer pays",
    body: "On a hosted checkout with your brand, with tax shown before they pay.",
  },
  {
    icon: "i-lucide-repeat",
    title: "The subscription starts",
    body: "The invoice is paid, and your app hears about it by webhook.",
  },
  {
    icon: "i-lucide-user-cog",
    title: "The customer manages it",
    body: "Cards, invoices and changes in the portal, with no ticket to your team.",
  },
];

const faq = [
  {
    label: "Do card details touch my servers?",
    content:
      "No. Card details go from the customer's browser to your gateway. They never reach your servers or ours, which keeps you out of the compliance scope that storing card numbers brings.",
  },
  {
    label: "How does a customer get into the customer portal?",
    content:
      "You generate a link from the dashboard, or your app requests one through the API and redirects a signed-in user. There is no separate password for your customers to forget.",
  },
  {
    label: "Why is a portal link single use?",
    content:
      "So a forwarded or leaked link cannot be reused. It expires an hour after it is made, and you can revoke it sooner. Generate a fresh one whenever a customer asks.",
  },
  {
    label: "Can I publish a pricing page?",
    content:
      "Yes. Mark the payment links you want on it, and the hosted pricing page lists them, each with its buy button.",
  },
  {
    label: "Can customers cancel on their own?",
    content:
      "Only when you allow it. You also select whether their cancellation applies at once or at the end of the term.",
  },
];

useMarketingSeo({
  title: "Hosted checkout and customer portal",
  crumb: "Checkout and portal",
  parents: [{ name: "Product", path: "/product" }],
  description:
    "Give buyers a branded hosted checkout, payment links and a pricing page, and customers a self-serve billing portal. Cards go straight to your gateway.",
  og: {
    headline: "Checkout and portal",
    title: "A hosted checkout and a self-serve billing portal",
    description: "Card details go straight to your gateway.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Hosted checkout and customer portal"
      title="A hosted checkout and a self-serve billing portal, with your brand"
      description="Two Minute Billing gives you a hosted checkout, payment links, a public pricing page and a self-serve customer portal, each with your logo and colors. Card details go straight to your payment gateway, and routine billing changes never reach your inbox."
      :secondary="{
        label: 'Hosted checkout and portal guide',
        to: '/help/guides/hosted-checkout-and-portal',
      }"
    >
      <MkIllustration
        name="IllCheckoutHero"
        :width="600"
        :height="460"
        alt="A customer portal in Fernhill Analytics' brand: the Growth plan, active at $99.00 a month with Pause and Cancel, a default and a backup card, and the November and October invoices, both paid."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Safe self-serve: cards go to your gateway, links work once"
      description="A customer who updates a card at midnight pays at midnight. A customer who has to email you waits for business hours, and some never write."
      :items="why"
    />

    <MkPageZig
      kicker="Hosted checkout"
      title="A hosted payment page that shows what is due today, with tax"
      accent="hosted payment page"
      description="The buyer selects a plan, enters their details and pays on a page with your logo and colors. What they see due is what they are charged."
      :points="checkout"
      :links="[
        { label: 'Checkout and portal recipe', to: '/help/developers/recipes/checkout-and-portal' },
        { label: 'Free trials and upgrades for SaaS', to: '/solutions/saas' },
      ]"
    >
      <MkShot
        src="/product/fragments/hosted-checkout"
        alt="Hosted checkout: the buyer's details, the steps to pay, and the plan they are buying with the tax for each billing period"
        :width="2272"
        :height="912"
        :crop="[1482, 212, 790, 700]"
      />
    </MkPageZig>

    <MkPageZig
      flip
      bleed
      kicker="Customer portal"
      title="A customer portal for cards, invoices, billing details and plan changes"
      accent="customer portal"
      description="Each switch you turn on under Settings → Hosted pages is a support request your team stops receiving. Whether customers may cancel on their own is your call."
      :points="portal"
      :links="[{ label: 'One-time and repeat orders for stores', to: '/solutions/ecommerce' }]"
    >
      <MkPageBleed
        src="/product/fragments/customer-portal"
        alt="The customer portal: nothing owed, the saved card, past invoices to download, and the plan with its next payment"
        :width="2400"
        :height="1140"
        :scale="1.55"
      />
    </MkPageZig>

    <MkPageZig
      bleed
      kicker="Payment links"
      title="Reusable payment links and a hosted pricing page"
      accent="payment links"
      description="Sell a plan or a one-time product from one link, or publish a pricing page that lists the links you mark."
      :points="links"
      :links="[
        { label: 'Payment links recipe', to: '/help/developers/recipes/one-time-purchases' },
      ]"
    >
      <MkPageBleed
        src="/product/hosted-pages"
        alt="Hosted pages settings: coupon codes, invoice and payment method permissions, and the cancel, pause and skip switches for the portal"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Safe by design"
      title="Portal links work once, expire after an hour and can be revoked"
      accent="work once"
      description="The pages that take a card are the ones that most need to be tight."
      :points="safe"
      :links="[{ label: 'Security', to: '/security' }]"
    >
      <div class="mk-surface p-5" role="img" aria-labelledby="cp-link">
        <span id="cp-link" class="sr-only"
          >A portal link for one customer: single use, expires in 60 minutes, and can be
          revoked.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center justify-between gap-3">
            <div class="text-sm font-semibold text-highlighted">Portal link</div>
            <UBadge color="success" variant="subtle">Unused</UBadge>
          </div>
          <div class="mt-3 truncate rounded-lg bg-elevated px-3 py-2 font-mono text-xs text-toned">
            billing.example.com/portal/session/••••••••••••
          </div>
          <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div class="rounded-lg border border-default px-3 py-2">
              <dt class="text-xs text-muted">Uses left</dt>
              <dd class="font-medium text-highlighted">1</dd>
            </div>
            <div class="rounded-lg border border-default px-3 py-2">
              <dt class="text-xs text-muted">Expires in</dt>
              <dd class="font-medium text-highlighted tabular-nums">60 min</dd>
            </div>
          </dl>
          <div class="mt-4 flex justify-end">
            <span
              class="rounded-lg border border-default px-3 py-1.5 text-xs font-medium text-highlighted"
              >Revoke</span
            >
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageFlow
      kicker="How it works"
      title="From a payment link to a subscription the customer manages"
      :steps="steps"
    />

    <MkPageTrust />

    <MkFaq :items="faq" title="Checkout and portal questions" />

    <MkRelated />

    <MkCta
      title="Open your own checkout in test mode"
      accent="checkout"
      description="Sign up free, create a payment link and buy your own plan with a test card."
      shot="/product/hosted-pages"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />
  </div>
</template>
