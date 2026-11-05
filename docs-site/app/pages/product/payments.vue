<script setup lang="ts">
/** Product: bring-your-own gateway, routing, backup cards, reconciliation, refunds and disputes. */
import gatewayData from "../../../data/gateways.json";
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkGatewayTable from "~/components/marketing/MkGatewayTable.vue";
import MkPageBleed from "~/components/marketing/MkPageBleed.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageTrust from "~/components/marketing/MkPageTrust.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";
import MkRelated from "~/components/marketing/MkRelated.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const routes = [
  { currency: "INR", gateway: "Razorpay", methods: "Cards · UPI · Net banking · e-mandate" },
  { currency: "USD", gateway: "Stripe", methods: "Cards · Apple Pay · Google Pay" },
  { currency: "EUR", gateway: "Stripe", methods: "Cards · Apple Pay · Google Pay" },
  { currency: "USD", gateway: "PayPal", methods: "PayPal" },
];

const charge = [
  {
    icon: "i-lucide-layers",
    title: "Backup cards in the same attempt",
    body: "If the default card declines, the customer's backup cards are tried in turn, up to three cards in all.",
  },
  {
    icon: "i-lucide-shield-check",
    title: "Authentication on the page",
    body: "When the bank asks for 3-D Secure, the customer completes it on the checkout or portal page.",
  },
  {
    icon: "i-lucide-zap",
    title: "Charge when a card is added",
    body: "A customer who saves a working card pays what is owed at once, instead of at the next retry.",
  },
];

const records = [
  {
    icon: "i-lucide-clock-check",
    title: "Late settlements",
    body: "A payment the gateway confirms hours later is marked paid when the confirmation arrives.",
  },
  {
    icon: "i-lucide-undo-2",
    title: "Reversals",
    body: "A payment that reverses reopens its invoice and puts it back in the retry queue.",
  },
  {
    icon: "i-lucide-hand-coins",
    title: "Refunds",
    body: "Refund to the original payment method from a credit note, with the reason recorded.",
  },
  {
    icon: "i-lucide-gavel",
    title: "Disputes",
    body: "Each chargeback shows the payment, the amount, the bank's reason and its stage.",
  },
  {
    icon: "i-lucide-terminal",
    title: "Gateway logs",
    body: "Every call to your gateway and what came back, failures included.",
  },
  {
    icon: "i-lucide-flask-conical",
    title: "A test gateway",
    body: "Every test business has one, with cards that decline, time out or reverse on demand.",
  },
];

const why = [
  {
    figure: "0%",
    label: "Of your revenue to us",
    body: "Cloud plans are a flat monthly price. Your gateway charges its own fees, as it does today.",
  },
  {
    figure: "12",
    label: "Gateways to select from",
    body: "Several gateways side by side, each charging the currencies you route to it.",
  },
  {
    figure: "3 cards",
    label: "Tried in one attempt",
    body: "The default card, then up to two backup cards, before a failed charge has to wait for a retry.",
  },
];

const routing = [
  {
    icon: "i-lucide-route",
    title: "Routed by currency and method",
    body: "Each account lists the currencies and payment methods it handles. There is no silent fallback.",
  },
  {
    icon: "i-lucide-key-square",
    title: "Live keys for live businesses",
    body: "A test business takes test credentials and a live one live credentials. A mismatch is refused up front.",
  },
  {
    icon: "i-lucide-lock",
    title: "Keys kept encrypted",
    body: "Gateway credentials are encrypted at rest and never returned through the API.",
  },
  {
    icon: "i-lucide-credit-card",
    title: "Cards, wallets and mandates",
    body: "Saved cards, PayPal billing agreements, bank debit mandates, and e-mandates for recurring INR.",
  },
];

const log = [
  {
    icon: "i-lucide-clock-check",
    text: "Payment confirmed 3 hours later",
    result: "Invoice paid",
    tone: "ok",
  },
  {
    icon: "i-lucide-undo-2",
    text: "Payment reversed by the bank",
    result: "Invoice reopened",
    tone: "bad",
  },
  {
    icon: "i-lucide-hand-coins",
    text: "Refund from credit note CN-0042",
    result: "Refunded",
    tone: "ok",
  },
  {
    icon: "i-lucide-gavel",
    text: "Dispute opened · fraudulent",
    result: "Needs response",
    tone: "bad",
  },
];

const faq = [
  {
    label: "Do you hold my money?",
    content:
      "No. Payments go straight from your customer to your own gateway account and pay out to your bank on your gateway's schedule.",
  },
  {
    label: "Do you charge a fee per transaction?",
    content:
      "No. Cloud plans are a flat monthly price. Your gateway charges its own fees, as it does today.",
  },
  {
    label: "Can I use two payment gateways in the same business?",
    content:
      "Yes. Connect both, for example Stripe and Razorpay, and list the currencies and payment methods each one handles. Rupee charges go to Razorpay and the rest to Stripe, with no setting for the customer to select.",
  },
  {
    label: "What if a customer pays in a currency no gateway handles?",
    content:
      "The charge is refused at the point of attempt. It is never sent through whichever account happens to be set up, so you never find a surprise in a reconciliation weeks later.",
  },
  {
    label: "Where are my gateway keys kept?",
    content:
      "Encrypted at rest. The API accepts them but never returns them, and they are used only to charge, refund and save cards for you.",
  },
];

useMarketingSeo({
  title: "Multi-gateway recurring payments",
  crumb: "Payments",
  parents: [{ name: "Product", path: "/product" }],
  description:
    "Collect recurring payments through your own payment gateway accounts, routed by currency, with backup cards, records that match and no share of revenue.",
  og: {
    headline: "Multi-gateway payments",
    title: "Recurring payments through the gateways you already own",
    description: "Your own gateway accounts, routed by currency.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Multi-gateway recurring payments"
      title="Recurring payments through the gateway accounts you already own"
      description="Two Minute Billing charges subscriptions through your own payment gateway accounts, several of them in one business. Money goes straight to your account at your rates, with no share of your revenue to us. We decide when to charge, which card to use, and what to do when a charge fails."
      :secondary="{ label: 'Connect a gateway', to: '/help/guides/connect-a-payment-gateway' }"
    >
      <MkIllustration
        name="IllPaymentsHero"
        :width="600"
        :height="460"
        alt="A $249.00 renewal charge succeeds and lands in the business's own gateway account; Fernhill Analytics routes INR to Razorpay, USD and EUR to Stripe, and USD to PayPal."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Keep your gateway rates and your payouts"
      description="Billing that takes a percentage grows its fee every time you grow. Here the money moves between your customer, your gateway and your bank, and nowhere else."
      :items="why"
    />

    <MkPageZig
      kicker="Bring your own gateway"
      title="Recurring payments go straight to your own payment gateway account"
      accent="your own payment gateway account"
      description="You keep your gateway pricing, your payouts and your relationship with the card networks. We send the instructions; the money never passes through us."
      :links="[{ label: 'Integrations', to: '/integrations' }]"
    >
      <MkIllustration
        name="IllMoneyFlow"
        :width="600"
        :height="420"
        alt="Two Minute Billing sends one API call to your gateway (Stripe, PayPal, Razorpay or 8 more). A $79.00 card payment goes from your customer through your gateway to your bank. Two Minute Billing never holds the money."
      />
    </MkPageZig>

    <section class="py-10 lg:py-14" aria-labelledby="pay-gateways">
      <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl">
          <p class="mk-kicker mb-4 w-fit">Supported gateways</p>
          <h2 id="pay-gateways" class="mk-h2 text-highlighted">
            {{ gatewayData.gateways.length }} payment gateways, on your own accounts
          </h2>
          <p class="mt-4 text-[1.0625rem] leading-relaxed text-pretty text-muted">
            The payment methods each gateway gives your customers, and the wallets they can use to
            pay an invoice now.
          </p>
        </div>
        <div class="mt-10">
          <MkGatewayTable />
        </div>
      </div>
    </section>

    <MkPageZig
      flip
      bleed
      kicker="Payment routing"
      title="Route each payment to a gateway account by currency and payment method"
      accent="currency and payment method"
      description="Run Razorpay for rupees and Stripe for everything else. The account is selected from the currency and the payment method, so customers never need to know."
      :points="routing"
      :links="[
        { label: 'Connect a gateway', to: '/help/guides/connect-a-payment-gateway' },
        { label: 'E-mandates for recurring INR', to: '/solutions/india' },
      ]"
    >
      <MkPageBleed
        src="/product/gateways"
        alt="The payment gateways list: each connected account with its mode, its currencies and its status"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageZig
      kicker="Fewer failed charges"
      title="Fewer recurring payments fail in the first place"
      accent="fail"
      description="The cheapest failed payment is the one that never happens."
      :points="charge"
      :links="[{ label: 'Recovery', to: '/product/recovery' }]"
      bleed
    >
      <MkPageBleed
        src="/product/invoice-detail"
        alt="An invoice in the dashboard, with its lines, tax, totals, addresses and the payments made against it"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Reconciliation"
      title="Refunds, disputes and reversals, recorded from your gateway"
      accent="recorded"
      description="Gateways confirm and reverse payments after the fact. Two Minute Billing listens, so you do not reconcile by hand."
      :points="records"
      :links="[
        { label: 'Handle disputes', to: '/help/guides/handle-disputes' },
        { label: 'Refunds and credit notes', to: '/product/invoicing' },
      ]"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="pay-log">
        <span id="pay-log" class="sr-only"
          >Gateway events kept in step: a payment confirmed hours later marks the invoice paid, a
          reversal reopens it, a refund from a credit note is recorded, and a dispute waits for a
          response.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center justify-between border-b border-default px-5 py-3.5">
            <span class="text-sm font-semibold text-highlighted">From your gateway</span>
            <span class="text-xs text-muted">Kept in step</span>
          </div>
          <ul class="divide-y divide-default">
            <li v-for="l in log" :key="l.text" class="flex items-center gap-3 px-5 py-3">
              <UIcon :name="l.icon" class="size-4 shrink-0 text-primary" />
              <span class="min-w-0 flex-1 truncate text-sm text-highlighted">{{ l.text }}</span>
              <UBadge :color="l.tone === 'ok' ? 'success' : 'warning'" variant="subtle">{{
                l.result
              }}</UBadge>
            </li>
          </ul>
        </div>
      </div>
    </MkPageZig>

    <MkPageTrust />

    <MkFaq :items="faq" title="Recurring payments questions" />

    <MkRelated />

    <MkCta
      title="Connect a gateway in test mode"
      accent="gateway"
      description="Sign up free, collect an invoice with a test card, and read the exact call to the gateway in Logs."
      shot="/product/gateways"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />
  </div>
</template>
