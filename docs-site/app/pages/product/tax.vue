<script setup lang="ts">
/** Product: VAT by country with reverse charge, sales tax by state, GST by place of supply, withholding. */
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

const india = [
  {
    icon: "i-lucide-map-pin",
    title: "Place of supply",
    body: "CGST and SGST (or UTGST) inside a state, IGST across states, with cess where it applies.",
  },
  {
    icon: "i-lucide-id-card",
    title: "A GSTIN per state",
    body: "Record each state you are registered in. The right registration prints on each invoice.",
  },
  {
    icon: "i-lucide-barcode",
    title: "HSN and SAC codes",
    body: "On every line, with your GSTIN and your customer's.",
  },
  {
    icon: "i-lucide-plane",
    title: "SEZ and export",
    body: "Zero-rated with your note, or with IGST, per customer.",
  },
];

const global = [
  {
    icon: "i-lucide-globe",
    title: "VAT by country",
    body: "A tax region for each country you sell to, with your rates. The customer's country decides.",
  },
  {
    icon: "i-lucide-map",
    title: "Sales tax by state",
    body: "Set a rate per state, such as California. The customer's state decides which applies.",
  },
  {
    icon: "i-lucide-arrow-left-right",
    title: "VAT reverse charge",
    body: "For a business customer with a VAT number, the obligation moves to them and the invoice says so.",
  },
  {
    icon: "i-lucide-badge-check",
    title: "VAT numbers checked",
    body: "EU VAT numbers are checked against the official VIES register. A VIES outage never blocks an invoice.",
  },
  {
    icon: "i-lucide-circle-slash",
    title: "Exempt customers",
    body: "Mark a customer exempt and their invoices carry no tax, with the reason on record.",
  },
];

const rules = [
  {
    icon: "i-lucide-tag",
    title: "Inclusive or exclusive prices",
    body: "Quote 100 before tax, or 100 with tax inside it. The engine backs the tax out of an inclusive price.",
  },
  {
    icon: "i-lucide-shapes",
    title: "Taxable or not, per product",
    body: "Mark a product as not taxable, and its invoice lines carry no tax.",
  },
  {
    icon: "i-lucide-hand-coins",
    title: "Withholding, recorded",
    body: "When a customer withholds tax, such as TDS, the invoice shows the full amount and the withheld part.",
  },
  {
    icon: "i-lucide-camera",
    title: "A snapshot on each invoice",
    body: "Rates, registration and place of supply are recorded at issue. Later changes never re-tax an old document.",
  },
];

const why = [
  {
    label: "Lines always add up to the total",
    body: "Tax is allocated so the lines always add up to the invoice total, to the minor unit.",
  },
  {
    label: "Tax by component, on each line",
    body: "Each line carries each tax that applies to it, with its rate and the reason it applies.",
  },
  {
    label: "Rules recorded when the invoice is issued",
    body: "Rates, registration and place of supply are kept, so a later change never re-taxes an old invoice.",
  },
];

const steps = [
  {
    icon: "i-lucide-map",
    title: "Add your registrations",
    body: "Each country and state you are registered in, with its rates, once.",
  },
  {
    icon: "i-lucide-user",
    title: "Know the customer",
    body: "Their country, state and tax number decide the place of supply and the treatment.",
  },
  {
    icon: "i-lucide-calculator",
    title: "Tax every line",
    body: "Each taxable line gets the taxes of the customer's region, split by component.",
  },
  {
    icon: "i-lucide-lock",
    title: "Keep the record",
    body: "The invoice stores the rates and the reasons, as they were on the day of issue.",
  },
];

const faq = [
  {
    label: "Do you look up tax rates for me?",
    content:
      "No. You enter the rates for the places you are registered, once. The engine then decides, for every line of every invoice, which of them apply and why.",
  },
  {
    label: "Do the tax lines add up exactly?",
    content:
      "Yes. Tax is worked out per line and per component, and rounding is allocated so the lines always add up to the invoice total, to the minor unit.",
  },
  {
    label: "Can my prices include tax?",
    content:
      "Yes. Set a price as tax-inclusive, and the engine backs the tax out of it on each line. The customer pays the price you show.",
  },
  {
    label: "Do you file my returns?",
    content:
      "No. Two Minute Billing raises the invoices and keeps the records. Filing stays with you or your accountant.",
  },
];

useMarketingSeo({
  title: "VAT, sales tax and GST on invoices",
  crumb: "Tax",
  parents: [{ name: "Product", path: "/product" }],
  description:
    "Work out VAT with reverse charge, US sales tax by state and GST by place of supply on every subscription invoice line, from rules you set once per region.",
  og: {
    headline: "VAT, sales tax and GST",
    title: "VAT, sales tax and GST, worked out on every invoice line",
    description: "Place of supply, reverse charge and withholding.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="VAT, sales tax and GST"
      title="VAT, sales tax and GST, worked out on every invoice line"
      description="Two Minute Billing taxes each subscription invoice line by the customer's country: VAT with reverse charge for EU business customers, US sales tax by state, GST by place of supply, tax-inclusive prices and withholding. You set the rules once per country and state."
      :secondary="{ label: 'Set up tax', to: '/help/guides/set-up-tax' }"
    >
      <!-- The same €40 sale to a consumer at home and to an EU business abroad. -->
      <MkIllustration
        name="IllPageVatTax"
        :width="600"
        :height="460"
        alt="A German seller's €40.00 plan: €47.60 with 19% VAT for a German consumer, €40.00 with reverse charge for a French business with a valid VAT number."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Each tax on each line, with lines that add up to the invoice total"
      description="An invoice your customer cannot claim input credit on is an invoice they dispute. Tax that is right on every line keeps payments on time and your filings clean."
      :items="why"
    />

    <MkPageZig
      kicker="VAT and sales tax"
      title="VAT with reverse charge by country, and SaaS sales tax by US state"
      accent="by US state"
      description="Add each country and state you sell to. The customer's address and tax number decide the rest: local VAT at home, reverse charge for an EU business abroad, a state rate in the US."
      :points="global"
      :links="[
        { label: 'Set up tax', to: '/help/guides/set-up-tax' },
        { label: 'Billing in Europe', to: '/solutions/europe' },
        { label: 'Billing in the US', to: '/solutions/us' },
      ]"
    >
      <MkShot
        src="/product/fragments/invoice-lines"
        alt="An invoice for a US customer: a discount, then state sales tax on the discounted subtotal"
        :width="1556"
        :height="676"
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="India GST"
      title="India GST by place of supply, with HSN or SAC codes on each line"
      accent="place of supply"
      description="A sale inside your state and a sale across states carry different taxes, and the invoice shows each one separately, with HSN or SAC codes on every line."
      :points="india"
      :links="[
        { label: 'Billing in India', to: '/solutions/india' },
        { label: 'GST invoices recipe', to: '/help/developers/recipes/india-gst-invoices' },
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
      bleed
      kicker="Audit-ready"
      title="Tax-inclusive prices, and each invoice keeps its issue-date rates"
      accent="issue date"
      description="An invoice is defensible because it records the rules it was raised under."
      :points="rules"
      :links="[
        { label: 'Invoices keep their tax snapshot', to: '/product/invoicing' },
        { label: 'Tax on physical goods', to: '/solutions/ecommerce' },
      ]"
    >
      <MkPageBleed
        src="/product/tax"
        alt="The tax regions of a business, with the country, the rate and the registration of each"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageFlow kicker="How it works" title="How each invoice line is taxed" :steps="steps" />

    <MkPageTrust />

    <MkFaq :items="faq" title="VAT, sales tax and GST questions" />

    <MkRelated />

    <MkCta
      title="Set up tax in a test business"
      accent="tax"
      description="Add your registrations and rates, bill a test customer in another state, and read the invoice before any real customer does."
      shot="/product/invoice-detail"
      :secondary="{ label: 'Talk to us', to: '/contact' }"
    />
  </div>
</template>
