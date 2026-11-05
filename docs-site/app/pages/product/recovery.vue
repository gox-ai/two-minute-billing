<script setup lang="ts">
/** Product: failed-payment recovery: backup cards, smart decline handling, retries, outcomes. */
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkPageBleed from "~/components/marketing/MkPageBleed.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageTrust from "~/components/marketing/MkPageTrust.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";
import MkRelated from "~/components/marketing/MkRelated.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const before = [
  {
    icon: "i-lucide-layers",
    title: "Backup cards",
    body: "Every saved card that is not the default is a backup, unless you or the customer take it out of collection.",
  },
  {
    icon: "i-lucide-calendar-x",
    title: "Card-expiry emails",
    body: "Customers hear before a card lapses. Only cards that pay a live subscription get the email.",
  },
  {
    icon: "i-lucide-zap",
    title: "Charge when a card is added",
    body: "Saving a working card pays what is owed at once, not at the next retry.",
  },
];

const declines = [
  {
    label: "Temporary",
    example: "Insufficient funds, a network error",
    action: "Retried on the schedule",
  },
  {
    label: "Customer must act",
    example: "Expired card, cancelled mandate",
    action: "Invoice paused, customer reminded until they update",
  },
  { label: "Never retry", example: "Card reported lost or stolen", action: "Stopped at once" },
];

const timing = [
  { when: "Network problem", what: "Within hours" },
  { when: "Insufficient funds", what: "Next likely payday: the 1st, the 15th or month-end" },
  { when: "Generic decline", what: "A few days apart" },
];

const why = [
  {
    label: "Backup cards in the same attempt",
    body: "The default card, then up to two backup cards, before any retry has to wait.",
  },
  {
    label: "Retries land at 10:00 local time",
    body: "Adaptive timing aims each day-based retry at 10:00 where the card was issued.",
  },
  {
    label: "Pay from the email",
    body: "Each dunning email has a link to pay the invoice or change the card.",
  },
  {
    label: "A stolen card is never retried",
    body: "A decline that must never be retried, such as a card reported lost or stolen, stops at once.",
  },
];

const outcomes = [
  {
    icon: "i-lucide-file-text",
    title: "The invoice",
    body: "Leave it owed, void it, or write it off as bad debt with the reason kept.",
  },
  {
    icon: "i-lucide-repeat",
    title: "The subscription",
    body: "Cancel it, or keep it running while you sort it out with the customer.",
  },
  {
    icon: "i-lucide-calendar-days",
    title: "The schedule",
    body: "Set the retry days and the dunning period per business, under Settings → Dunning.",
  },
  {
    icon: "i-lucide-mail",
    title: "The emails",
    body: "Edit the wording of each reminder, and send it from your own domain.",
  },
];

const queue = [
  {
    icon: "i-lucide-refresh-cw",
    title: "Retry now",
    body: "When the customer says the card works again, without waiting for the schedule.",
  },
  {
    icon: "i-lucide-pause",
    title: "Pause",
    body: "While they sort it out with their bank. The invoice stays owed.",
  },
  { icon: "i-lucide-square", title: "Stop", body: "End the chase for this invoice." },
  {
    icon: "i-lucide-ban",
    title: "Write off",
    body: "Record it as bad debt when you have given up.",
  },
];

const faq = [
  {
    label: "What is dunning?",
    content:
      "Dunning is the process of collecting a payment that failed: retrying the charge, reminding the customer, and deciding what happens when the retries run out. Here it runs on its own, on the schedule you set.",
  },
  {
    label: "Does a failed payment cut off access?",
    content:
      "Only if you set it to. The invoice and the subscription are decided separately: you can write off the invoice and keep the customer, or keep chasing the invoice while access continues.",
  },
  {
    label: "Will payment retries annoy my customers' banks?",
    content:
      "Card-network retry rules are always followed. A card the network says not to retry is never charged again until it is replaced, and a card declined many times recently waits before its next attempt.",
  },
  {
    label: "Can I change the retry schedule?",
    content:
      "Yes. Set the retry days, the decline handling, the emails and the final outcome per business, under Settings → Dunning.",
  },
  {
    label: "How do I test failed payment recovery before going live?",
    content:
      "In a test business, subscribe a customer with the test card that declines for insufficient funds. The invoice goes into the retry queue, and you can read each email your customer would get.",
  },
];

useMarketingSeo({
  title: "Dunning and failed payment recovery",
  crumb: "Recovery",
  parents: [{ name: "Product", path: "/product" }],
  description:
    "Dunning software that recovers failed subscription payments with backup cards, smart retries by decline reason, card-expiry emails and one-click pay links.",
  og: {
    headline: "Dunning and recovery",
    title: "Dunning that wins back failed subscription payments",
    description: "Backup cards, smart retries and dunning emails.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Dunning and failed payment recovery"
      title="Dunning that wins back failed subscription payments"
      description="Dunning collects a subscription payment that failed. When a renewal fails, Two Minute Billing tries the backup cards, retries only the declines worth retrying, and emails the customer a one-click payment link. Involuntary churn stops costing you subscribers."
      :secondary="{
        label: 'Recover failed payments guide',
        to: '/help/guides/recover-failed-payments',
      }"
    >
      <MkIllustration
        name="IllRecoveryHero"
        :width="600"
        :height="460"
        alt="After a failed renewal charge and a failed backup card, Corvid Analytics gets a payment link by email, pays, and the $249.00 invoice is recovered."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Recover failed payments with backup cards, retries and a pay link"
      description="A customer whose card fails did not decide to leave. Each recovered invoice keeps that subscriber and every renewal after it."
      :items="why"
    />

    <MkPageZig
      kicker="Prevention"
      title="Prevent failed payments with backup cards and card-expiry emails"
      accent="failed payments"
      description="A retry is the second-best outcome. These keep the first charge from failing at all."
      :points="before"
      :links="[
        { label: 'Payments', to: '/product/payments' },
        { label: 'Card updates in the customer portal', to: '/product/checkout-portal' },
      ]"
      bleed
    >
      <MkPageBleed
        src="/product/fragments/customer-portal"
        alt="The customer portal: the primary payment method, the next payment, and the invoices to pay or download"
        :width="2400"
        :height="1140"
        :scale="1.5"
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Smart retries"
      title="Smart decline handling, by the reason the bank gave"
      accent="reason"
      description="Not every decline deserves a retry. Smart mode reads why the payment was declined and acts on it. Adaptive timing is optional, and off until you turn it on."
      :links="[
        { label: 'Recover failed payments guide', to: '/help/guides/recover-failed-payments' },
      ]"
    >
      <div class="mk-surface overflow-hidden">
        <div class="border-b border-default px-5 py-3.5 text-sm font-semibold text-highlighted">
          Decline handling
        </div>
        <ul class="divide-y divide-default">
          <li v-for="d in declines" :key="d.label" class="px-5 py-3.5">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <span class="text-sm font-medium text-highlighted">{{ d.label }}</span>
              <span class="text-xs text-muted">{{ d.example }}</span>
            </div>
            <p class="mt-1 flex gap-2 text-sm text-toned">
              <UIcon
                name="i-lucide-corner-down-right"
                class="mt-0.5 size-4 shrink-0 text-(--mk-plain)"
              />
              {{ d.action }}
            </p>
          </li>
        </ul>
        <div class="border-t border-default bg-elevated/60 px-5 py-4">
          <div class="text-xs font-medium text-muted">Adaptive retry timing</div>
          <dl class="mt-2 grid gap-2 sm:grid-cols-3">
            <div v-for="t in timing" :key="t.when" class="rounded-lg bg-default px-3 py-2">
              <dt class="text-xs text-muted">{{ t.when }}</dt>
              <dd class="text-sm font-medium text-highlighted">{{ t.what }}</dd>
            </div>
          </dl>
        </div>
      </div>
    </MkPageZig>

    <section class="py-14 lg:py-20">
      <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl">
          <p class="mk-kicker mb-4 w-fit">How it works</p>
          <h2 class="mk-h2 text-highlighted">
            One failed renewal on the default payment retry schedule
          </h2>
          <p class="mt-4 text-[1.0625rem] leading-relaxed text-muted">
            On a default schedule. Every day, email and final outcome is yours to change.
          </p>
        </div>
        <div class="mt-10">
          <MkIllustration
            name="IllRecoveryTimeline"
            :phone="{ width: 390, height: 535 }"
            :width="1040"
            :height="420"
            alt="A retry schedule from the due date to day 7. The payment is recovered on day 3: $79.00 paid."
          />
        </div>
      </div>
    </section>

    <MkPageZig
      bleed
      kicker="The retry queue"
      title="Retry, pause, stop or write off each invoice in the retry queue"
      accent="retry queue"
      description="Retries lists every invoice being chased, with the attempts, the decline reason and the card. The count next to it is your backlog."
      :points="queue"
      :links="[{ label: 'Failed cards on repeat orders', to: '/solutions/ecommerce' }]"
    >
      <MkPageBleed
        src="/product/fragments/retries"
        alt="The Retries list: each unpaid invoice with its amount, attempts, whether the failure is soft or hard, the decline reason and the card"
        :width="3386"
        :height="1242"
        :crop="[0, 0, 2300, 1242]"
        :scale="1.35"
      />
    </MkPageZig>

    <MkPageZig
      flip
      bleed
      kicker="Your rules"
      title="Set the retry schedule, the emails and what happens when dunning ends"
      accent="dunning ends"
      description="When the retries run out, the invoice and the subscription each get the outcome you set."
      :points="outcomes"
      :links="[{ label: 'Emails and branding', to: '/help/guides/emails-and-branding' }]"
    >
      <MkPageBleed
        src="/product/dunning-settings"
        alt="Dunning settings: smart or fixed decline handling, the retry schedule and the final outcome for the invoice and the subscription"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageTrust />

    <MkFaq :items="faq" title="Dunning and payment recovery questions" />

    <MkRelated />

    <MkCta
      title="Recover your first failed payment"
      accent="failed payment"
      description="Sign up free, subscribe a test customer with a declining test card, and see the retry scheduled and the email your customer gets."
      shot="/product/retries"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />
  </div>
</template>
