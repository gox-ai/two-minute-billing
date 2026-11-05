<script setup lang="ts">
/** Solution: subscription billing for businesses in India: GST, TDS, Razorpay and mandates. */
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

const gst = [
  {
    icon: "i-lucide-map-pin",
    title: "Place of supply",
    body: "CGST and SGST inside a state, IGST across states, worked out per line. Cess where it applies.",
  },
  {
    icon: "i-lucide-badge-check",
    title: "GSTIN on every invoice",
    body: "Yours for the right state, and your customer's, with HSN or SAC codes.",
  },
  {
    icon: "i-lucide-list-ordered",
    title: "One continuous series",
    body: "Invoice numbers run in one unbroken series per business.",
  },
  {
    icon: "i-lucide-plane",
    title: "SEZ and export",
    body: "Zero-rated with your note, or with IGST, set per customer.",
  },
];

const mandates = [
  {
    icon: "i-lucide-file-signature",
    title: "Approved once",
    body: "The customer approves a mandate on your Razorpay checkout, with a limit they agree to.",
  },
  {
    icon: "i-lucide-bell",
    title: "Pre-debit notice",
    body: "A notice email tells the customer the amount before each mandate charge.",
  },
  {
    icon: "i-lucide-repeat",
    title: "Charged each renewal",
    body: "The GST invoice is raised and the mandate is charged within the agreed limit.",
  },
  {
    icon: "i-lucide-rotate-ccw",
    title: "Recovery that knows mandates",
    body: "With smart decline handling, a cancelled mandate pauses the invoice and asks for a new one.",
  },
];

const more = [
  {
    icon: "i-lucide-hand-coins",
    title: "TDS, recorded",
    body: "The invoice shows the full amount and the withheld part, so receivables still match.",
  },
  {
    icon: "i-lucide-tag",
    title: "Prices with or without GST",
    body: "Exclusive for business buyers, inclusive for consumers. Inclusive tax is backed out of the price.",
  },
  {
    icon: "i-lucide-globe",
    title: "Sell abroad from the same business",
    body: "USD and EUR prices, collected through another gateway you connect, routed by currency.",
  },
  {
    icon: "i-lucide-chart-line",
    title: "Reports in rupees",
    body: "MRR, churn and receivables per currency, never mixed with dollars.",
  },
];

const why = [
  {
    label: "TDS withheld and still reconciled",
    body: "When a customer withholds tax, the invoice shows the full amount and the withheld part, so receivables still match.",
  },
  {
    label: "One invoice series with both GSTINs",
    body: "One continuous number series, with your GSTIN and your customer's on every invoice.",
  },
  {
    label: "GST splits worked out on each line",
    body: "CGST, SGST and IGST are worked out per line from the customer's state.",
  },
];

const steps = [
  {
    icon: "i-lucide-file-signature",
    title: "The customer signs up",
    body: "They pay on the hosted checkout and approve a Razorpay mandate.",
  },
  {
    icon: "i-lucide-bell",
    title: "A pre-debit notice goes out",
    body: "Before the renewal, with the amount to be charged.",
  },
  {
    icon: "i-lucide-receipt",
    title: "The GST invoice is raised",
    body: "With the right GSTIN, place of supply and HSN or SAC codes.",
  },
  {
    icon: "i-lucide-indian-rupee",
    title: "The mandate is charged",
    body: "Within the agreed limit. Money settles in your own Razorpay account.",
  },
];

const faq = [
  {
    label: "Is it GST compliant?",
    content:
      "Invoices carry your GSTIN and your customer's, tax by place of supply with CGST, SGST and IGST shown separately, HSN or SAC codes, and one continuous invoice series.",
  },
  {
    label: "Which payment methods can I use in India?",
    content:
      "Cards, UPI and net banking for payments, and mandates for recurring INR charges. You connect your own Razorpay account, so settlement goes straight to your bank.",
  },
  {
    label: "My customers deduct TDS. Will that break my receivables?",
    content:
      "No. Set the customer's withholding rate. The invoice shows the full amount and the withheld part, so the shortfall is explained instead of looking like an underpayment.",
  },
  {
    label: "Do you file my GST returns?",
    content:
      "No. Two Minute Billing raises the invoices and keeps the records. Filing stays with you or your accountant.",
  },
  {
    label: "Can I also sell outside India?",
    content:
      "Yes. Add USD or EUR prices, connect another gateway for those currencies, and the same business routes each charge to the right account.",
  },
];

const related = [
  ...PRODUCT.filter((p) =>
    ["/product/tax", "/product/payments", "/product/recovery"].includes(p.to),
  ),
  {
    to: "/solutions/ecommerce",
    icon: "i-lucide-shopping-bag",
    label: "Ecommerce subscriptions",
    description: "GST on physical goods by HSN code, skips and pauses.",
  },
  {
    to: "/help/developers/recipes/india-gst-invoices",
    icon: "i-lucide-book-open",
    label: "India GST invoices recipe",
    description: "Configure GST and raise an invoice, by API.",
  },
  {
    to: "/help/developers/recipes/india-mandates",
    icon: "i-lucide-book-open",
    label: "Recurring INR with mandates",
    description: "Set up e-mandates for renewals, by API.",
  },
];

useMarketingSeo({
  title: "GST billing software for SaaS in India",
  crumb: "India",
  description:
    "GST billing software for subscriptions in India: invoices by place of supply with GSTIN, HSN and SAC, TDS on the invoice, and e-mandates for recurring INR.",
  og: {
    headline: "GST billing for India",
    title: "Subscription billing in India, built for GST",
    description: "GST invoices, TDS and e-mandates.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="GST billing software for India"
      title="Subscription billing in India, built for GST and recurring rupees"
      description="Two Minute Billing raises GST invoices for subscriptions by place of supply, with GSTIN, HSN or SAC codes and TDS recorded on the invoice. Renewals are charged on e-mandates. Sell abroad in USD and EUR from the same business."
      :secondary="{ label: 'Set up tax', to: '/help/guides/set-up-tax' }"
    >
      <MkIllustration
        name="IllIndiaHero"
        :width="600"
        :height="460"
        alt="A paid GST invoice: Scale plan ₹50,000.00 with CGST and SGST at 9% each, ₹59,000.00 total; the customer withheld 2% TDS of ₹1,000.00 and paid ₹58,000.00, with the TDS recorded."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="GST splits on each line, both GSTINs on each invoice, and TDS recorded"
      description="A B2B buyer claims input tax credit from your invoice. A wrong GSTIN, a wrong split or a gap in the series turns into a dispute and a late payment."
      :items="why"
    />

    <MkPageZig
      kicker="GST invoices"
      title="GST invoices by place of supply, with GSTIN and HSN or SAC codes"
      accent="place of supply"
      description="Built into the engine. Each invoice records the rates, your registration and the place of supply as they were that day."
      :points="gst"
      :links="[
        { label: 'How tax works', to: '/product/tax' },
        { label: 'GST invoices recipe', to: '/help/developers/recipes/india-gst-invoices' },
        { label: 'Invoice series and credit notes', to: '/product/invoicing' },
      ]"
    >
      <MkIllustration
        name="IllGstSupply"
        :width="600"
        :height="420"
        alt="GST on a ₹10,000.00 plan sold from Karnataka: CGST and SGST in the same state, IGST to Maharashtra, ₹11,800.00 total either way."
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Recurring INR"
      title="Recurring INR on a Razorpay e-mandate, with a pre-debit notice"
      accent="Razorpay e-mandate"
      description="Connect your own Razorpay account. Customers approve a mandate once; each renewal is charged within the limit they agreed."
      :points="mandates"
      :links="[
        { label: 'Mandates recipe', to: '/help/developers/recipes/india-mandates' },
        { label: 'When a mandate payment fails', to: '/product/recovery' },
      ]"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="in-md">
        <span id="in-md" class="sr-only"
          >A Razorpay mandate for a customer: active, with a limit of 10,000 rupees. The next charge
          of 3,538 rupees 82 is on 1 December, and the pre-debit notice was sent.</span
        >
        <div aria-hidden="true">
          <div class="flex items-center justify-between border-b border-default px-5 py-3.5">
            <div>
              <div class="text-xs text-muted">Payment method · Razorpay</div>
              <div class="text-sm font-semibold text-highlighted">e-mandate · HDFC ···· 0042</div>
            </div>
            <UBadge color="success" variant="subtle">Active</UBadge>
          </div>
          <dl class="grid grid-cols-2 gap-3 p-5 text-sm">
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">Limit per charge</dt>
              <dd class="font-medium tabular-nums text-highlighted">₹10,000.00</dd>
            </div>
            <div class="rounded-lg bg-elevated px-3 py-2">
              <dt class="text-xs text-muted">Next charge · 1 Dec</dt>
              <dd class="font-medium tabular-nums text-highlighted">₹3,538.82</dd>
            </div>
          </dl>
          <div class="flex items-center gap-2 border-t border-default px-5 py-3 text-xs text-muted">
            <UIcon name="i-lucide-bell" class="size-4 shrink-0 text-(--mk-plain)" />
            Pre-debit notice sent to the customer
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      kicker="HSN on goods"
      title="GST invoices for physical goods, too"
      accent="physical goods"
      description="Selling boxes or refills? Give each price its HSN code, and every invoice line prints it."
      :points="more"
      :links="[{ label: 'Ecommerce', to: '/solutions/ecommerce' }]"
    >
      <MkIllustration
        name="IllPageGoodsTax"
        :width="600"
        :height="420"
        alt="An invoice for daily vitamins and a shaker bottle, each with its HSN code, with CGST and SGST: ₹2,360.00 total."
      />
    </MkPageZig>

    <MkPageFlow kicker="How it works" title="A renewal on an e-mandate" :steps="steps" />

    <MkPageTrust />

    <MkFaq :items="faq" title="GST billing questions" />

    <MkRelated title="Read next" :links="related" />

    <MkCta
      title="Raise a GST invoice in test mode"
      accent="GST invoice"
      description="Add your GSTIN and rates, bill a test customer in another state, and read the invoice before any real customer does."
      shot="/product/tax"
      :secondary="{ label: 'Talk to us', to: '/contact' }"
    />
  </div>
</template>
