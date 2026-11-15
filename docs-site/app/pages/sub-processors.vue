<script setup lang="ts">
/**
 * Sub-processors: the companies that process customer data for Two Minute Billing Cloud. Every
 * row is checked against production configuration (2026-11-09): hosting, network, email, logs,
 * the assistant's model provider and the gateways that collect payment for our own plans.
 * Linked from /security, not from the menus. Update this page before a new one starts.
 */
import MkPageHero from "~/components/marketing/MkPageHero.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const UPDATED = "9 November 2026";

interface Processor {
  company: string;
  service?: string;
  purpose: string;
  data: string;
  location: string;
}

const processors: Processor[] = [
  {
    company: "Hetzner Online GmbH",
    purpose: "Servers and the database that hold your account",
    data: "All account and billing data: customers, subscriptions, invoices, payments and team members",
    location: "Germany",
  },
  {
    company: "Cloudflare, Inc.",
    purpose: "Network protection and delivery, file storage, and bot checks at sign-up and sign-in",
    data: "All traffic passes through it, encrypted in transit. It stores the brand images you upload and archived usage events, and sees browser signals for the bot check",
    location: "Global network",
  },
  {
    company: "Amazon Web Services, Inc.",
    service: "Amazon SES",
    purpose: "Sending the emails your customers and your team receive",
    data: "Recipient addresses and the email content: invoices, receipts, payment reminders and sign-in links",
    location: "United States",
  },
  {
    company: "Google LLC",
    service: "Google Cloud Logging",
    purpose: "Application logs, to find and correct errors",
    data: "Technical request details, record IDs and error messages",
    location: "Google Cloud",
  },
  {
    company: "OpenAI, L.L.C.",
    purpose: "Billy, the in-app assistant, and the meaning-based part of help search",
    data: "Questions asked to Billy and the records it reads to answer them, and help-search text, including searches from AI apps you connect. Sent with storage turned off. Not used when you add your own AI key",
    location: "United States",
  },
  {
    company: "Stripe, Inc.",
    purpose: "Collecting payment for your Two Minute Billing plan",
    data: "Billing contact and the payment details you give at checkout",
    location: "United States",
  },
  {
    company: "Razorpay Software Private Limited",
    purpose: "Collecting payment for your Two Minute Billing plan",
    data: "Billing contact and the payment details you give at checkout",
    location: "India",
  },
  {
    company: "PayPal, Inc.",
    purpose: "Collecting payment for your Two Minute Billing plan",
    data: "Billing contact and the payment details you give at checkout",
    location: "United States",
  },
];

const yours = [
  "Your payment gateways, which charge your customers.",
  "Integrations you connect, such as HubSpot.",
  "Your own email server, if you send through SMTP.",
  "Your own AI provider, when you add your own key for Billy.",
  "Google sign-in, when a team member chooses to sign in with Google.",
];

useMarketingSeo({
  title: "Sub-processors",
  crumb: "Sub-processors",
  description:
    "The companies that process your data to run Two Minute Billing Cloud: what each one receives and where. Hosting, network, email, logs, AI and payments.",
  og: {
    headline: "Sub-processors",
    title: "Two Minute Billing sub-processors",
    description:
      "Who processes your data to run Two Minute Billing Cloud, what each receives, and where.",
  },
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Trust"
      title="Sub-processors"
      description="The companies that process your data on our behalf to run Two Minute Billing Cloud, what each one receives, and where. Self-hosted installations use none of them unless you set them up."
      :primary="{ label: 'Billing security', to: '/security' }"
      :note="`Last updated ${UPDATED}`"
    />

    <UContainer class="py-14 lg:py-20">
      <h2 class="mk-h2 text-highlighted">Companies that process your data</h2>
      <div class="mk-surface mt-6 overflow-hidden">
        <div
          class="hidden gap-6 border-b border-default px-6 py-3 lg:grid lg:grid-cols-[14rem_1fr_1.3fr_9rem]"
          aria-hidden="true"
        >
          <span class="mk-label">Company</span>
          <span class="mk-label">What we use it for</span>
          <span class="mk-label">Data it receives</span>
          <span class="mk-label">Location</span>
        </div>
        <ul class="divide-y divide-default">
          <li
            v-for="p in processors"
            :key="p.company"
            class="grid gap-2 px-5 py-5 text-sm sm:px-6 lg:grid-cols-[14rem_1fr_1.3fr_9rem] lg:gap-6"
          >
            <div>
              <p class="font-semibold text-highlighted">{{ p.company }}</p>
              <p v-if="p.service" class="text-muted">{{ p.service }}</p>
            </div>
            <p class="text-toned">
              <span class="mk-label block lg:sr-only">What we use it for</span>{{ p.purpose }}
            </p>
            <p class="text-toned">
              <span class="mk-label block lg:sr-only">Data it receives</span>{{ p.data }}
            </p>
            <p class="text-toned">
              <span class="mk-label block lg:sr-only">Location</span>{{ p.location }}
            </p>
          </li>
        </ul>
      </div>

      <div class="mt-14 grid gap-12 lg:grid-cols-3">
        <section>
          <h2 class="mk-h3 text-highlighted">Services you choose and connect</h2>
          <p class="mt-3 text-muted">
            These process data because you connect them, under your own agreement with each
            provider. They are not our sub-processors.
          </p>
          <ul class="mt-3 list-disc space-y-1.5 pl-5 text-toned">
            <li v-for="y in yours" :key="y">{{ y }}</li>
          </ul>
        </section>
        <section>
          <h2 class="mk-h3 text-highlighted">On our website</h2>
          <p class="mt-3 text-muted">
            twominutebilling.com uses Google Analytics to count visits, only with your consent where
            the law requires it. It does not receive data from your account.
          </p>
        </section>
        <section>
          <h2 class="mk-h3 text-highlighted">Changes to this list</h2>
          <p class="mt-3 text-muted">
            We update this page before a new sub-processor starts processing your data. To get an
            email when it changes,
            <NuxtLink to="/contact" class="text-primary hover:underline">contact us</NuxtLink>.
          </p>
        </section>
      </div>
    </UContainer>
  </div>
</template>
