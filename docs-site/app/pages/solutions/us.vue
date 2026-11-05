<script setup lang="ts">
/** Solution: subscription billing for US SaaS: sales tax by state, exemptions, cards and ACH in USD. */
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

const states = [
  {
    icon: "i-lucide-map",
    title: "A rate per state",
    body: "Add each state where you collect, with the rate you set for it.",
  },
  {
    icon: "i-lucide-map-pin",
    title: "The customer's state decides",
    body: "Each invoice applies the rate you set for the customer's state.",
  },
  {
    icon: "i-lucide-badge-check",
    title: "State codes checked",
    body: "Each state code is checked against the list of US states, so a typo never becomes a rate.",
  },
  {
    icon: "i-lucide-shapes",
    title: "Taxable or not, per product",
    body: "Mark a product as not taxable, and its invoice lines carry no tax.",
  },
];

const exempt = [
  {
    icon: "i-lucide-circle-slash",
    title: "Exempt customers",
    body: "Mark a customer exempt, and their invoices carry no sales tax.",
  },
  {
    icon: "i-lucide-file-text",
    title: "The reason on record",
    body: "The exemption reason stays on the record, ready when anyone asks.",
  },
  {
    icon: "i-lucide-tag",
    title: "Tax-inclusive pricing",
    body: "Quote $49.00 before tax, or $49.00 with tax inside it. Tax is backed out of an inclusive price.",
  },
  {
    icon: "i-lucide-camera",
    title: "Rates kept on each invoice",
    body: "The rate and registration are recorded at issue. A later rate change never re-taxes an old invoice.",
  },
];

const payments = [
  {
    icon: "i-lucide-credit-card",
    title: "Cards in USD",
    body: "Each renewal charges the card on file, in dollars.",
  },
  {
    icon: "i-lucide-landmark",
    title: "ACH recurring payments",
    body: "Customers pay renewals straight from their bank account by ACH debit.",
  },
  {
    icon: "i-lucide-plug",
    title: "Gateways for bank debits",
    body: "ACH through Stripe, GoCardless or Authorize.net (eCheck). Venmo through Braintree.",
  },
  {
    icon: "i-lucide-wallet",
    title: "Your account, your money",
    body: "Payments settle in your own gateway account, not in ours.",
  },
];

const recovery = [
  {
    icon: "i-lucide-rotate-ccw",
    title: "Retries on your schedule",
    body: "A failed renewal is retried on the days you set.",
  },
  {
    icon: "i-lucide-credit-card",
    title: "Backup cards",
    body: "When the main card fails, a backup card on file can pay the invoice.",
  },
  {
    icon: "i-lucide-link",
    title: "One-click payment links",
    body: "The customer gets a link that pays the open invoice in one click.",
  },
  {
    icon: "i-lucide-chart-line",
    title: "MRR, churn and cohorts",
    body: "Reports read from the same invoices and payments, in USD.",
  },
];

const why = [
  {
    label: "The right rate on every renewal",
    body: "A renewal invoice with the wrong rate is money you owe or must refund. Each renewal uses the rate you set for the customer's state.",
  },
  {
    label: "Exempt customers never taxed",
    body: "An exempt customer who gets taxed disputes the invoice and pays late. Mark them exempt once, with the reason on record.",
  },
  {
    label: "A billing cost you know in advance",
    body: "A fee taken as a share of revenue grows with every sale. You pay a flat monthly price, not a share of your revenue.",
  },
];

const steps = [
  {
    icon: "i-lucide-map",
    title: "Add your state rates",
    body: "Each state where you collect, with the rate you set for it.",
  },
  {
    icon: "i-lucide-user",
    title: "The customer signs up",
    body: "On your hosted checkout, with a billing address in their state.",
  },
  {
    icon: "i-lucide-receipt",
    title: "The invoice is raised",
    body: "With the rate for their state, or no tax if they are exempt. The rate is kept on the invoice.",
  },
  {
    icon: "i-lucide-dollar-sign",
    title: "The renewal is charged",
    body: "By card or ACH on your own payment gateway. A failed payment goes to recovery.",
  },
];

const faq = [
  {
    label: "Do SaaS companies have to charge sales tax?",
    content:
      "It depends on the states your customers are in and your obligations there. Check with your tax adviser. Two Minute Billing then charges the rates you set for the states where you collect.",
  },
  {
    label: "Do you look up sales tax rates automatically?",
    content:
      "No. You set one rate per state. Two Minute Billing does not look up county, city or ZIP code rates, does not track nexus, and does not file or pay returns. For those, work with your tax adviser or a sales tax service.",
  },
  {
    label: "How do I bill a tax-exempt customer?",
    content:
      "Mark the customer exempt and record the reason. Their invoices carry no sales tax, and the reason stays on record.",
  },
  {
    label: "What happens to old invoices when I change a state rate?",
    content:
      "Nothing. Each invoice records its rate and registration when it is issued, so past invoices do not change. New invoices use the new rate.",
  },
  {
    label: "Can customers pay by ACH?",
    content:
      "Yes. Connect your own payment gateway with ACH bank debits in USD, and customers can pay renewals from their bank account. Cards work on the same subscription.",
  },
  {
    label: "Do you take a percentage of my revenue?",
    content:
      "No. You pay a flat monthly price, not a share of your revenue. The Free plan needs no credit card.",
  },
];

const related = [
  ...PRODUCT.filter((p) =>
    ["/product/tax", "/product/recovery", "/product/payments"].includes(p.to),
  ),
  {
    to: "/solutions/europe",
    icon: "i-lucide-euro",
    label: "EU VAT for SaaS",
    description: "VAT by country, with reverse charge for EU businesses.",
  },
  {
    to: "/help/guides/set-up-tax",
    icon: "i-lucide-book-open",
    label: "Set up tax",
    description: "Add your states and rates, prices and exemptions.",
  },
];

useMarketingSeo({
  title: "SaaS sales tax billing in the US",
  crumb: "United States",
  description:
    "Charge US customers sales tax at the rate you set for each state, keep exempt customers on record, and collect USD by card or ACH. Flat monthly price.",
  og: {
    headline: "SaaS sales tax for the US",
    title: "Subscription billing for US SaaS, with sales tax by state",
    description: "Sales tax by state, exemptions and ACH.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="SaaS sales tax billing for the US"
      title="Subscription billing for US SaaS, with sales tax by state"
      description="Two Minute Billing charges SaaS sales tax at the rate you set for each state. The customer's state decides which rate applies. Exempt customers keep their reason on record, and USD renewals are collected by card or ACH through your own payment gateway."
      :secondary="{ label: 'Set up tax', to: '/help/guides/set-up-tax' }"
    >
      <MkIllustration
        name="IllUsHero"
        :width="600"
        :height="460"
        alt="An Austin company sets sales tax by state; a customer in Pennsylvania pays $49.00 for the Team plan plus $2.94 sales tax at 6%, $51.94 paid."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Sales tax on SaaS subscriptions depends on the customer's state"
      description="States do not treat SaaS the same way, and rates change. Your billing has to apply the rate you set on every renewal, not only at sign-up, and leave past invoices as they were."
      :items="why"
    />

    <MkPageZig
      kicker="State rates"
      title="Sales tax by state, at the rates you set"
      accent="rates you set"
      description="Enter a rate for each state where you collect. The customer's state selects the rate on every invoice, at sign-up and on each renewal."
      :points="states"
      :links="[
        { label: 'How tax works', to: '/product/tax' },
        { label: 'Set up tax', to: '/help/guides/set-up-tax' },
      ]"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="us-rates">
        <span id="us-rates" class="sr-only"
          >The sales tax rates Mesquite Labs Inc. set for each state: Pennsylvania 6%, Washington
          6.5%, and Texas, its home state, 6.25%. The customer's state decides which applies.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center justify-between border-b border-default px-5 py-3.5">
            <div>
              <div class="text-xs text-muted">Tax region · United States</div>
              <div class="text-sm font-semibold text-highlighted">Sales tax by state</div>
            </div>
            <UBadge color="success" variant="subtle">Active</UBadge>
          </div>
          <table class="w-full text-sm">
            <tbody class="divide-y divide-default">
              <tr>
                <td class="px-5 py-2.5 text-highlighted">Pennsylvania · PA</td>
                <td class="px-5 py-2.5 text-right tabular-nums">6.00%</td>
              </tr>
              <tr>
                <td class="px-5 py-2.5 text-highlighted">Washington · WA</td>
                <td class="px-5 py-2.5 text-right tabular-nums">6.50%</td>
              </tr>
              <tr>
                <td class="px-5 py-2.5 text-highlighted">
                  Texas · TX <span class="text-xs text-muted">· home state</span>
                </td>
                <td class="px-5 py-2.5 text-right tabular-nums">6.25%</td>
              </tr>
            </tbody>
          </table>
          <div class="flex items-center gap-2 border-t border-default px-5 py-3 text-xs text-muted">
            <UIcon name="i-lucide-map-pin" class="size-4 shrink-0 text-(--mk-plain)" />
            Rates you set. The customer's state decides which applies.
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Exemptions"
      title="Exempt customers, with the reason on record"
      accent="reason on record"
      description="When a customer such as a school district is exempt, its invoices show no sales tax. Mark it exempt once, and every renewal follows."
      :points="exempt"
      :links="[{ label: 'Invoices keep their tax snapshot', to: '/product/invoicing' }]"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="us-ex">
        <span id="us-ex" class="sr-only"
          >An invoice to Cedar Valley School District, an exempt customer: Team plan 49 dollars,
          sales tax 0 dollars, total 49 dollars. The reason on record is Exemption on file.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center justify-between gap-3 border-b border-default px-5 py-3.5">
            <div class="min-w-0">
              <div class="text-xs text-muted">Bill to</div>
              <div class="text-sm font-semibold text-highlighted">Cedar Valley School District</div>
            </div>
            <UBadge color="neutral" variant="subtle" class="shrink-0">Tax exempt</UBadge>
          </div>
          <table class="w-full text-sm">
            <tbody class="divide-y divide-default">
              <tr>
                <td class="px-5 py-2.5 text-highlighted">Team plan · monthly</td>
                <td class="px-5 py-2.5 text-right tabular-nums">$49.00</td>
              </tr>
              <tr>
                <td class="px-5 py-2.5 text-muted">Sales tax · exempt</td>
                <td class="px-5 py-2.5 text-right tabular-nums">$0.00</td>
              </tr>
              <tr class="font-semibold text-highlighted">
                <td class="px-5 py-2.5">Total</td>
                <td class="px-5 py-2.5 text-right tabular-nums">$49.00</td>
              </tr>
            </tbody>
          </table>
          <div class="flex items-center gap-2 border-t border-default px-5 py-3 text-xs text-muted">
            <UIcon name="i-lucide-file-check" class="size-4 shrink-0 text-(--mk-plain)" />
            Reason: Exemption on file
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      kicker="Payments"
      title="USD by card and ACH, through your own payment gateway"
      accent="ACH"
      description="Collect ACH recurring payments and cards on a gateway account you own. Money settles with you, never with us."
      :points="payments"
      :links="[{ label: 'Card and ACH payments', to: '/product/payments' }]"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="us-ach">
        <span id="us-ach" class="sr-only"
          >A renewal paid by ACH bank debit from a checking account ending 6021: 51 dollars 94, for
          the Team plan with Pennsylvania sales tax. Status paid.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center justify-between border-b border-default px-5 py-3.5">
            <div>
              <div class="text-xs text-muted">Payment method · ACH bank debit</div>
              <div class="text-sm font-semibold text-highlighted">ACH · Checking ···· 6021</div>
            </div>
            <UBadge color="success" variant="subtle">Paid</UBadge>
          </div>
          <dl class="grid grid-cols-2 gap-3 p-5 text-sm">
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">Invoice</dt>
              <dd class="font-medium tabular-nums text-highlighted">INV-2026-0418</dd>
            </div>
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">Amount</dt>
              <dd class="font-medium tabular-nums text-highlighted">$51.94</dd>
            </div>
          </dl>
          <div class="flex items-center gap-2 border-t border-default px-5 py-3 text-xs text-muted">
            <UIcon name="i-lucide-wallet" class="size-4 shrink-0 text-(--mk-plain)" />
            Settled in your own gateway account
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Recovery and reports"
      title="Failed renewals recovered, with MRR you can trust"
      accent="recovered"
      description="Dunning wins back failed payments. A hosted checkout and buy links sign customers up, and a self-serve portal serves them after. All for a flat monthly price."
      :points="recovery"
      :links="[
        { label: 'How recovery works', to: '/product/recovery' },
        { label: 'Checkout and portal', to: '/product/checkout-portal' },
        { label: 'Reporting', to: '/product/reporting' },
        { label: 'Flat monthly pricing', to: '/pricing' },
      ]"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="us-rec">
        <span id="us-rec" class="sr-only"
          >A renewal for a customer in Washington: 52 dollars 19 with 6.5% sales tax. The card was
          declined, then the backup card paid it on the retry. Status recovered.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center justify-between border-b border-default px-5 py-3.5">
            <div>
              <div class="text-xs text-muted">Renewal · Washington · WA 6.5%</div>
              <div class="text-sm font-semibold tabular-nums text-highlighted">$52.19</div>
            </div>
            <UBadge color="success" variant="subtle">Recovered</UBadge>
          </div>
          <ul class="divide-y divide-default text-sm">
            <li class="flex items-center justify-between px-5 py-2.5">
              <span class="text-muted">Card ···· 3318 declined</span>
              <span class="text-xs text-muted">Nov 1</span>
            </li>
            <li class="flex items-center justify-between px-5 py-2.5">
              <span class="text-highlighted">Backup card ···· 1881 paid</span>
              <span class="text-xs text-muted">Nov 4</span>
            </li>
          </ul>
        </div>
      </div>
    </MkPageZig>

    <MkPageFlow kicker="How it works" title="From state rates to every renewal" :steps="steps" />

    <MkPageTrust />

    <MkFaq :items="faq" title="SaaS sales tax questions" />

    <MkRelated title="Read next" :links="related" />

    <MkCta
      title="Raise a sales tax invoice in test mode"
      accent="sales tax invoice"
      description="Add your state rates, bill a test customer in another state, and read the invoice before any real customer does."
      shot="/product/tax"
      :secondary="{ label: 'Talk to us', to: '/contact' }"
    />
  </div>
</template>
