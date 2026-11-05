<script setup lang="ts">
/** Integrations: only connections that exist in the product today. */
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkPageFlow from "~/components/marketing/MkPageFlow.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageTrust from "~/components/marketing/MkPageTrust.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";
import PartnerLogo from "~/components/content/PartnerLogo.vue";
import type { PartnerLogoKey } from "~/utils/partner-logos";

definePageMeta({ layout: "marketing", header: false, footer: false });

/** Written by the webhook reference generator. */
const hooks = Object.values(
  import.meta.glob<{ event_count: number }>("../../data/webhooks.json", {
    eager: true,
    import: "default",
  }),
)[0];

/** Catalogue order. Each links to its setup guide. */
const gateways: PartnerLogoKey[] = [
  "stripe",
  "paypal",
  "razorpay",
  "square",
  "braintree",
  "checkoutcom",
  "adyen",
  "mollie",
  "authorizenet",
  "gocardless",
  "cashfree",
  "payu",
];

const directory: {
  group: string;
  items: {
    name: string;
    body: string;
    to: string;
    logo?: PartnerLogoKey;
    mark?: string;
    icon?: string;
  }[];
}[] = [
  {
    group: "CRM and growth",
    items: [
      {
        logo: "hubspot",
        name: "HubSpot",
        body: "Customers, subscriptions and prices to contacts, companies, deals and products, and edits come back.",
        to: "#hubspot",
      },
      {
        logo: "firstpromoter",
        name: "FirstPromoter",
        body: "Sales, refunds, sign-ups and cancellations sent to your affiliate program as they happen.",
        to: "#firstpromoter",
      },
    ],
  },
  {
    group: "Your own stack",
    items: [
      {
        mark: "{}",
        name: "REST API",
        body: "Every dashboard action, documented with a request and a response.",
        to: "/help/developers/api-reference",
      },
      {
        mark: "∑",
        name: "Analytics API",
        body: "MRR, churn and cohorts, pulled into your own BI tool.",
        to: "/help/developers/concepts/analytics",
      },
      {
        mark: "W",
        name: "Webhooks",
        body: "An event for each billing change, sent to your endpoints.",
        to: "/help/developers/webhooks",
      },
      {
        mark: "@",
        name: "Your mail server",
        body: "Billing email sent through your own SMTP, from your own domain.",
        to: "/help/guides/emails-and-branding",
      },
    ],
  },
];

const hubspot = [
  {
    icon: "i-lucide-contact",
    title: "Contacts and companies",
    body: "Matched on the rule you set, with your field mappings, custom fields included.",
  },
  {
    icon: "i-lucide-handshake",
    title: "Deals",
    body: "Subscriptions in the statuses you select become deals in your pipeline stages, with MRR or ARR as the amount.",
  },
  {
    icon: "i-lucide-package",
    title: "Products",
    body: "Flat and per-unit prices appear as HubSpot products.",
  },
  {
    icon: "i-lucide-arrow-left-right",
    title: "Edits come back",
    body: "Changes made in HubSpot flow back to linked records. Conflicts follow your rule, or wait for review.",
  },
  {
    icon: "i-lucide-panel-right",
    title: "A card on the record",
    body: "Billing details on the HubSpot record, and a Create subscription action when you allow it.",
  },
  {
    icon: "i-lucide-workflow",
    title: "Workflow actions",
    body: "Create or change a subscription from a HubSpot workflow.",
  },
];

const fp = [
  {
    icon: "i-lucide-user-plus",
    title: "Sign-ups",
    body: "A new customer reaches your affiliate program with its referral id.",
  },
  {
    icon: "i-lucide-badge-dollar-sign",
    title: "Sales",
    body: "Each paid invoice counts toward the affiliate's commission.",
  },
  {
    icon: "i-lucide-undo-2",
    title: "Refunds",
    body: "A refund reaches FirstPromoter too, so commission follows the money.",
  },
  {
    icon: "i-lucide-circle-x",
    title: "Cancellations",
    body: "A cancelled subscription is sent as it happens.",
  },
];

const hookPoints = [
  {
    icon: "i-lucide-filter",
    title: "Subscribe per endpoint",
    body: "Each endpoint gets only the event types it needs.",
  },
  {
    icon: "i-lucide-refresh-cw",
    title: "Nothing missed",
    body: "If your endpoint is down, the event is sent again later.",
  },
  {
    icon: "i-lucide-list-checks",
    title: "Every delivery on screen",
    body: "See the request and your endpoint's response, and resend any delivery.",
  },
];

const why = [
  {
    label: "12 payment gateways",
    body: "Stripe, PayPal, Razorpay, Square, Braintree, Checkout.com, Adyen, Mollie, Authorize.net, GoCardless, Cashfree and PayU, on your own accounts, in the same business.",
  },
  {
    label: "Two-way HubSpot sync",
    body: "Billing reaches your sales team, and their edits come back under your conflict rule.",
  },
  {
    label: "Webhooks for any other tool",
    body: "For any tool not listed here: subscribe an endpoint and call the API back.",
  },
];

const steps = [
  {
    icon: "i-lucide-credit-card",
    title: "Connect a gateway",
    body: "Add your gateway account, and list the currencies each one handles.",
  },
  {
    icon: "i-lucide-contact",
    title: "Connect your CRM",
    body: "Link a HubSpot portal to a business, and map the fields.",
  },
  {
    icon: "i-lucide-webhook",
    title: "Add your endpoints",
    body: "Subscribe each one to the events it needs.",
  },
  {
    icon: "i-lucide-shield",
    title: "Billing stays first",
    body: "Sync runs on its own queue. An outage elsewhere never rolls back a charge.",
  },
];

const faq = [
  {
    label: "Which payment gateways do you integrate with?",
    content:
      "Twelve payment gateways. Connect your own accounts, and route each currency and payment method to the right one. Payments go straight to you.",
  },
  {
    label: "Is HubSpot or Two Minute Billing the source of truth?",
    content:
      "Two Minute Billing owns every billing record. HubSpot gets a copy it can act on, and edits made there come back under the conflict rule you set.",
  },
  {
    label: "Does a HubSpot outage stop billing?",
    content:
      "No. Sync runs on its own queue, apart from the billing clock. A failed push is retried later and never rolls back a charge or an invoice.",
  },
  {
    label: "My tool is not listed. Can I still connect it?",
    content:
      "Yes. Subscribe a webhook endpoint to the events you need and call the API back. Tell us what you use, too. It shapes what we build next.",
  },
];

useMarketingSeo({
  title: "Billing integrations: gateways and CRM",
  crumb: "Integrations",
  description:
    "Connect 12 payment gateways on your own accounts, sync HubSpot both ways, send affiliate events to FirstPromoter, and send webhooks to your own code.",
  og: {
    headline: "Billing integrations",
    title: "Billing integrations for the tools you already run",
    description: "12 payment gateways, HubSpot, FirstPromoter and webhooks.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Billing integrations"
      title="Billing integrations for the tools you already run"
      description="Your payment gateways, your CRM, your affiliate program and your own code, through native integrations with 12 payment gateways, HubSpot and FirstPromoter, webhooks and a documented API."
      :secondary="{ label: 'Set up a gateway', to: '/help/guides/connect-a-payment-gateway' }"
    >
      <MkIllustration
        name="IllPageHubIntegrations"
        :width="600"
        :height="460"
        alt="Payments come in through your gateway accounts: Stripe, PayPal, Adyen, Square, Authorize.net, Razorpay and five more. The billing engine syncs HubSpot both ways, sends affiliate events to FirstPromoter, sends webhooks to your endpoints, and sends email through your own mail server."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Payment gateway integration, HubSpot sync and webhooks"
      description="Sales sees MRR on the deal, partners see commission on the sale, and your app sees every change. Nobody copies numbers between tools."
      :items="why"
    />

    <section class="py-6 lg:py-10">
      <div class="mx-auto max-w-(--ui-container) space-y-10 px-4 sm:px-6 lg:px-8">
        <section aria-labelledby="int-gw">
          <h2 id="int-gw" class="text-sm font-medium tracking-wide text-muted uppercase">
            Payment gateways
          </h2>
          <div class="mk-card mt-4 p-5 sm:p-6">
            <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p class="font-semibold text-highlighted">On your own accounts</p>
              <NuxtLink
                to="/product/payments"
                class="flex items-center gap-1 text-sm font-medium text-primary"
              >
                Payments and routing
                <UIcon name="i-lucide-arrow-up-right" class="size-4" />
              </NuxtLink>
            </div>
            <p class="mt-1 text-sm text-muted">
              Connect several in one business, each for the currencies and payment methods you
              select. Select a gateway to read its setup guide.
            </p>
            <ul class="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <li v-for="g in gateways" :key="g">
                <NuxtLink
                  :to="`/help/guides/connect-a-payment-gateway/${g}`"
                  class="ig-tile grid h-16 place-items-center rounded-[14px] px-3"
                >
                  <PartnerLogo :name="g" :area="900" :max-width="112" />
                </NuxtLink>
              </li>
              <li
                class="ig-soon grid h-16 place-items-center rounded-[14px] px-3 text-center text-xs text-muted"
              >
                Coming soon: CyberSource
              </li>
            </ul>
          </div>
        </section>
        <section v-for="g in directory" :key="g.group">
          <h2 class="text-sm font-medium tracking-wide text-muted uppercase">{{ g.group }}</h2>
          <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <NuxtLink
              v-for="i in g.items"
              :key="i.name"
              :to="i.to"
              class="mk-card flex-row! gap-4 p-5"
            >
              <span
                v-if="!i.logo"
                class="grid size-11 shrink-0 place-items-center rounded-[14px] bg-elevated text-sm font-bold text-highlighted"
              >
                <UIcon v-if="i.icon" :name="i.icon" class="size-5" />
                <template v-else>{{ i.mark }}</template>
              </span>
              <span class="min-w-0">
                <span class="flex min-h-6 items-center gap-1.5 font-semibold text-highlighted">
                  <PartnerLogo v-if="i.logo" :name="i.logo" :area="900" :max-width="140" />
                  <template v-else>{{ i.name }}</template>
                  <UIcon name="i-lucide-arrow-up-right" class="size-4 text-muted" />
                </span>
                <span class="mt-1 block text-sm text-muted">{{ i.body }}</span>
              </span>
            </NuxtLink>
          </div>
        </section>
      </div>
    </section>

    <MkPageZig
      id="hubspot"
      kicker="HubSpot billing integration"
      title="Two-way HubSpot sync for contacts, companies, deals and products"
      accent="Two-way HubSpot sync"
      description="Connect a HubSpot portal to a business, and your sales team sees billing where they work. With autosync on, changes reach HubSpot within minutes."
      :points="hubspot"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="int-hs">
        <span id="int-hs" class="sr-only"
          >The billing card on a HubSpot company record: an active Growth subscription, its MRR, the
          next renewal and the amount owed, with a Create subscription action.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center gap-2 border-b border-default px-5 py-3.5">
            <PartnerLogo name="hubspot" :area="500" />
            <span class="text-sm font-semibold text-highlighted">Billing · Larkspur Software</span>
          </div>
          <dl class="grid grid-cols-2 gap-3 p-5 text-sm">
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">Subscription</dt>
              <dd class="font-medium text-highlighted">Growth · Active</dd>
            </div>
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">MRR</dt>
              <dd class="font-medium tabular-nums text-highlighted">$298.00</dd>
            </div>
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">Next renewal</dt>
              <dd class="font-medium text-highlighted">1 Dec</dd>
            </div>
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">Owed</dt>
              <dd class="font-medium tabular-nums text-highlighted">$0.00</dd>
            </div>
          </dl>
          <div class="flex justify-end border-t border-default px-5 py-3">
            <span
              class="rounded-lg border border-default px-3 py-1.5 text-xs font-medium text-highlighted"
              >Create subscription</span
            >
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      id="firstpromoter"
      flip
      kicker="Affiliates"
      title="FirstPromoter for affiliate programs"
      accent="affiliate programs"
      description="Paste your FirstPromoter API key and account id. Events reach your affiliate program as they happen, matched by the referral id you store on the customer."
      :points="fp"
    >
      <ul class="mk-surface divide-y divide-default overflow-hidden">
        <li
          v-for="e in ['New customer', 'Invoice paid', 'Refund', 'Cancellation']"
          :key="e"
          class="flex items-center justify-between gap-3 px-5 py-3"
        >
          <span class="text-sm font-medium text-highlighted">{{ e }}</span>
          <span class="flex items-center gap-1.5 text-xs text-muted">
            <UIcon name="i-lucide-arrow-right" class="size-3.5" />
            <PartnerLogo name="firstpromoter" :area="500" />
          </span>
        </li>
      </ul>
    </MkPageZig>

    <MkPageZig
      kicker="Webhooks"
      title="Webhooks for any other tool"
      accent="any other tool"
      :description="`${hooks ? hooks.event_count + ' event types. ' : ''}Subscribe each endpoint to the ones it needs, and call the API back for anything you want to read.`"
      :points="hookPoints"
      :links="[
        { label: 'Event types', to: '/help/developers/webhooks/events' },
        { label: 'For developers', to: '/solutions/developers' },
      ]"
    >
      <pre class="mk-code p-5"><span class="k">POST</span> /billing-events
<span class="k">Tmbilling-Event-Id</span>: <span class="s">evt_XXXXXXXXXXXX01</span>

{
  <span class="k">"object"</span>: <span class="s">"event"</span>,
  <span class="k">"id"</span>: <span class="s">"evt_XXXXXXXXXXXX01"</span>,
  <span class="k">"event_type"</span>: <span class="s">"invoice_paid"</span>,
  <span class="k">"occurred_at"</span>: <span class="s">"2026-11-01T00:04:12.381Z"</span>,
  <span class="k">"source"</span>: <span class="s">"billing_clock"</span>,
  <span class="k">"content"</span>: { … }
}</pre>
    </MkPageZig>

    <MkPageFlow
      kicker="How it works"
      title="Connect a gateway, a CRM and your own endpoints"
      :steps="steps"
    />

    <MkPageTrust />

    <MkFaq :items="faq" title="Billing integration questions" />

    <MkCta
      title="Connect your stack in test mode"
      accent="test mode"
      description="Sign up free, connect a test gateway and a webhook endpoint, and watch the events arrive."
      shot="/product/gateways"
      :secondary="{ label: 'Talk to us', to: '/contact' }"
    />
  </div>
</template>

<style scoped>
.ig-tile {
  border: 1px solid var(--ui-border);
  background: var(--mk-card);
  transition: border-color 0.15s ease;
}
.ig-tile:hover {
  border-color: var(--mk-spoke);
}
.ig-soon {
  border: 1px dashed var(--ui-border);
}
</style>
