<script setup lang="ts">
/** Solution: subscription billing for customers in the EU and UK: VAT by country, reverse charge, VIES. */
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

const vat = [
  {
    icon: "i-lucide-globe",
    title: "A tax region per country",
    body: "Add each country you sell to, with your VAT rates. The customer's country decides which rate applies.",
  },
  {
    icon: "i-lucide-tag",
    title: "Prices with or without VAT",
    body: "Quote €29.00 before VAT, or €29.00 with VAT inside it. The engine backs the tax out of an inclusive price.",
  },
  {
    icon: "i-lucide-circle-slash",
    title: "VAT exempt invoices",
    body: "Mark a customer exempt. Their invoices carry no tax, with the reason on record.",
  },
  {
    icon: "i-lucide-camera",
    title: "Rates kept on each invoice",
    body: "Rates and your registration are recorded at issue. A later rate change never re-taxes an old invoice.",
  },
];

const reverse = [
  {
    icon: "i-lucide-arrow-left-right",
    title: "Selected per customer",
    body: "Select the reverse-charge treatment on a business customer. Their invoices follow it from then on.",
  },
  {
    icon: "i-lucide-file-text",
    title: "0% VAT and the note",
    body: "The invoice carries 0% VAT and your reverse-charge note, so the buyer's finance team can book it.",
  },
  {
    icon: "i-lucide-lock",
    title: "The treatment stays on record",
    body: "The treatment is recorded on each invoice when it is issued, next to the rates.",
  },
];

const vies = [
  {
    icon: "i-lucide-badge-check",
    title: "Checked against VIES",
    body: "Each EU VAT number is checked against the official VIES register of the European Commission.",
  },
  {
    icon: "i-lucide-cloud-off",
    title: "VIES down? Billing goes on",
    body: 'An outage never blocks a new customer or an invoice. The result stays "undetermined".',
  },
  {
    icon: "i-lucide-user-check",
    title: "You decide the treatment",
    body: "A valid number does not change the invoice by itself. You select reverse charge on the customer.",
  },
];

const money = [
  {
    icon: "i-lucide-coins",
    title: "Multi-currency invoicing",
    body: "Price your plans in EUR, GBP and other currencies, and bill each customer in theirs.",
  },
  {
    icon: "i-lucide-chart-line",
    title: "Reports per currency",
    body: "MRR, churn and receivables per currency, never mixed.",
  },
  {
    icon: "i-lucide-landmark",
    title: "SEPA and Bacs Direct Debit",
    body: "SEPA Direct Debit through Stripe, Mollie or GoCardless. Bacs Direct Debit in the UK through GoCardless.",
  },
  {
    icon: "i-lucide-wallet",
    title: "Your account, a flat price",
    body: "Money settles in your own gateway account. You pay one flat monthly price, not a share of revenue.",
  },
];

const why = [
  {
    label: "The right rate for each country",
    body: "VAT on a sale to a consumer usually follows the customer's country. If you charge too little, you pay the difference.",
  },
  {
    label: "Invoices that business buyers accept",
    body: "A business buyer checks the invoice before it pays. A missing reverse-charge note means a dispute and a late payment.",
  },
  {
    label: "Records that match what you filed",
    body: "Each invoice keeps the rates and treatment it was issued with. A later rate change never rewrites it.",
  },
];

const steps = [
  {
    icon: "i-lucide-map",
    title: "Add your countries",
    body: "A tax region for each country you sell to, with your VAT rates. You do this once.",
  },
  {
    icon: "i-lucide-user",
    title: "Add the customer",
    body: "Their country, and their VAT number if they are a business. The number is checked against VIES.",
  },
  {
    icon: "i-lucide-list-checks",
    title: "Select the treatment",
    body: "Reverse charge or exempt where it applies. Otherwise the rate of the customer's country applies.",
  },
  {
    icon: "i-lucide-receipt",
    title: "The invoice goes out",
    body: "With the right VAT and note, and the rules recorded on it. Payment goes to your own gateway.",
  },
];

const faq = [
  {
    label: "Do I have to charge VAT to customers in the EU and UK?",
    content:
      "It depends on your registrations and on the customer. Your accountant tells you the rules. Two Minute Billing applies the rates and the treatment you set on every invoice.",
  },
  {
    label: "Do you look up VAT rates for me?",
    content:
      "No. You enter the rate for each country once. The customer's country then decides which rate applies on each invoice.",
  },
  {
    label: "How does reverse charge VAT work on an invoice?",
    content:
      'Select the reverse-charge treatment on a business customer. Their invoices carry 0% VAT and a note such as "Reverse charge: the customer accounts for the VAT."',
  },
  {
    label: "How do you check an EU VAT number?",
    content:
      'Each EU VAT number is checked against the official VIES register. If VIES is down, the customer and the invoice are still created, and the result stays "undetermined".',
  },
  {
    label: "Can customers in Europe pay by SEPA Direct Debit?",
    content:
      "Yes. Connect your own payment gateway that supports SEPA Direct Debit, or Bacs Direct Debit in the UK. Renewals are collected from the customer's bank account, and the money settles in your gateway account.",
  },
  {
    label: "Do you file my VAT returns?",
    content:
      "No. Two Minute Billing raises the invoices and keeps the records. Filing stays with you or your accountant.",
  },
];

const related = [
  ...PRODUCT.filter((p) =>
    ["/product/tax", "/product/payments", "/product/invoicing"].includes(p.to),
  ),
  {
    to: "/solutions/us",
    icon: "i-lucide-landmark",
    label: "Sales tax for US SaaS",
    description: "Sales tax at the rate you set per state, in USD.",
  },
  {
    to: "/help/guides/set-up-tax",
    icon: "i-lucide-book-open",
    label: "Set up tax",
    description: "Add your tax regions and rates, step by step.",
  },
  {
    to: "/help/guides/vat-for-saas-in-europe",
    icon: "i-lucide-book-open",
    label: "EU VAT for SaaS",
    description: "Which rate applies, reverse charge, VIES, OSS and VAT invoices.",
  },
];

useMarketingSeo({
  title: "EU VAT for SaaS subscription billing",
  crumb: "Europe",
  description:
    "Bill EU and UK customers with the right VAT on every invoice: your rate per country, reverse charge for businesses, live VIES checks. Bill in EUR or GBP.",
  og: {
    headline: "EU VAT for SaaS",
    title: "Bill customers in Europe with the right VAT on every invoice",
    description: "VAT by country, reverse charge and VIES checks.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="EU VAT for SaaS"
      title="Bill customers in Europe with the right VAT on every invoice"
      description="Set your VAT rate for each country once. Every invoice then carries the VAT of the customer's country, the reverse-charge note for business buyers and an EU VAT number checked against VIES. Bill in EUR and GBP on your own payment gateway."
      :secondary="{ label: 'Set up tax', to: '/help/guides/set-up-tax' }"
    >
      <MkIllustration
        name="IllEuropeHero"
        :width="600"
        :height="460"
        alt="A Berlin company bills a private customer in Lyon €29.00 plus €5.80 French VAT at 20%, €34.80 paid, while a Dutch business buyer pays €29.00 under reverse charge with its VAT number valid."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Right VAT for each customer keeps invoices paid and records clean"
      description="In the EU, VAT on a SaaS sale to a consumer usually follows the customer's country. A sale to a VAT-registered business usually moves to reverse charge, and the invoice must say so. The UK has its own VAT rules. Two Minute Billing applies the rules you set, and your accountant still files your returns."
      :items="why"
    />

    <MkPageZig
      kicker="VAT invoicing"
      title="VAT invoicing by the customer's country, at the rates you set"
      accent="customer's country"
      description="You enter each rate once. On every invoice, the customer's country decides which one applies."
      :points="vat"
      :links="[
        { label: 'How tax works', to: '/product/tax' },
        { label: 'EU VAT for SaaS guide', to: '/help/guides/vat-for-saas-in-europe' },
      ]"
    >
      <MkIllustration
        name="IllPageVatTax"
        :width="600"
        :height="460"
        alt="A seller in Germany with a €40.00 monthly Pro plan: €47.60 with 19% VAT for a consumer in Germany, and €40.00 with reverse charge for a business in France whose VAT number is valid."
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Reverse charge"
      title="Reverse charge VAT for business customers, with the note on the invoice"
      accent="the note"
      description="A business buyer in another EU country accounts for the VAT itself. You select the treatment, and the invoice says so."
      :points="reverse"
      :links="[{ label: 'Invoices and credit notes', to: '/product/invoicing' }]"
    >
      <div class="mk-surface p-6" role="img" aria-labelledby="eu-rc">
        <span id="eu-rc" class="sr-only"
          >An invoice from Lindenhof Analytics GmbH to Kanaal Studio B.V. in the Netherlands for the
          Growth plan at 29 euros a month. VAT is 0 euros under reverse charge, the total is 29
          euros, and the invoice carries the note: Reverse charge: the customer accounts for the
          VAT.</span
        >
        <div aria-hidden="true">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-xs text-muted">Invoice · Kanaal Studio B.V.</div>
              <div class="font-semibold text-highlighted">INV-2026-0419</div>
            </div>
            <UBadge color="info" variant="subtle">Reverse charge</UBadge>
          </div>
          <table class="mt-5 w-full text-sm">
            <tbody class="divide-y divide-default">
              <tr>
                <td class="py-2 text-highlighted">Growth plan · monthly</td>
                <td class="py-2 text-right tabular-nums">€29.00</td>
              </tr>
              <tr>
                <td class="py-2 text-muted">VAT · 0%</td>
                <td class="py-2 text-right tabular-nums">€0.00</td>
              </tr>
              <tr class="font-semibold text-highlighted">
                <td class="py-2">Total</td>
                <td class="py-2 text-right tabular-nums">€29.00</td>
              </tr>
            </tbody>
          </table>
          <div class="mt-4 rounded-lg bg-elevated px-3 py-2 text-xs text-muted">
            Reverse charge: the customer accounts for the VAT.
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      kicker="VIES VAT check"
      title="EU VAT numbers checked against VIES, without blocking your invoices"
      accent="VIES"
      description="Each EU VAT number is checked live against the official register. If VIES is down, you still bill."
      :points="vies"
      :links="[{ label: 'How tax works', to: '/product/tax' }]"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="eu-vies">
        <span id="eu-vies" class="sr-only"
          >The VAT number of Kanaal Studio B.V., NL859302741B01, is valid. It was checked against
          VIES.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center justify-between border-b border-default px-5 py-3.5">
            <div>
              <div class="text-xs text-muted">VAT number · Kanaal Studio B.V.</div>
              <div class="text-sm font-semibold break-all text-highlighted tabular-nums">
                NL859302741B01
              </div>
            </div>
            <UBadge color="success" variant="subtle">Valid</UBadge>
          </div>
          <div class="flex items-center gap-2 px-5 py-3 text-xs text-muted">
            <UIcon name="i-lucide-badge-check" class="size-4 shrink-0 text-(--mk-plain)" />
            Checked against VIES
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Euros and pounds"
      title="Euros, pounds and SEPA Direct Debit, on your own payment gateway"
      accent="SEPA Direct Debit"
      description="Collect from bank accounts across Europe. Hosted checkout, a self-service portal and failed-payment recovery come with it."
      :points="money"
      :links="[
        { label: 'Payments', to: '/product/payments' },
        { label: 'Failed-payment recovery', to: '/product/recovery' },
        { label: 'Checkout and portal', to: '/product/checkout-portal' },
        { label: 'Pricing', to: '/pricing' },
      ]"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="eu-mrr">
        <span id="eu-mrr" class="sr-only"
          >Monthly recurring revenue shown per currency: 18,420 euros and 6,150 pounds, each on its
          own row.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center justify-between border-b border-default px-5 py-3.5">
            <div class="text-sm font-semibold text-highlighted">MRR by currency</div>
            <UBadge color="neutral" variant="subtle">Never mixed</UBadge>
          </div>
          <dl class="grid grid-cols-2 gap-3 p-5 text-sm">
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">EUR</dt>
              <dd class="font-medium tabular-nums text-highlighted">€18,420.00</dd>
            </div>
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">GBP</dt>
              <dd class="font-medium tabular-nums text-highlighted">£6,150.00</dd>
            </div>
          </dl>
        </div>
      </div>
    </MkPageZig>

    <MkPageFlow
      kicker="How it works"
      title="From a new country to a correct invoice"
      :steps="steps"
    />

    <MkPageTrust />

    <MkFaq :items="faq" title="EU and UK VAT questions" />

    <MkRelated title="Read next" :links="related" />

    <MkCta
      title="Send an EU VAT invoice in test mode"
      accent="EU VAT invoice"
      description="Add a country and its rate, bill a test business customer on reverse charge, and read the invoice before any real customer does."
      shot="/product/tax"
      :secondary="{ label: 'Talk to us', to: '/contact' }"
    />
  </div>
</template>
