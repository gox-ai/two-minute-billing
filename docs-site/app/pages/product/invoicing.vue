<script setup lang="ts">
/** Product: invoices, statuses, credit notes, offline payment and the document itself. */
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

const statuses = [
  {
    label: "Pending",
    color: "neutral" as const,
    body: "Open and still collecting usage and charges.",
  },
  { label: "Posted", color: "info" as const, body: "Finalized. Lines, tax and total are fixed." },
  {
    label: "Payment due",
    color: "warning" as const,
    body: "Owed: past its due date, or collection failed.",
  },
  { label: "Not paid", color: "error" as const, body: "Retries ran out without a payment." },
  { label: "Paid", color: "success" as const, body: "Settled." },
  { label: "Voided", color: "neutral" as const, body: "Cancelled, with its accounting reversed." },
];

const corrections = [
  {
    icon: "i-lucide-file-minus",
    title: "Adjustment credit note",
    body: "The invoice is unpaid and the customer should owe less. It reduces what is owed.",
  },
  {
    icon: "i-lucide-file-check",
    title: "Refundable credit note",
    body: "The invoice was paid and you owe money back. It becomes credit, which you can refund to the card.",
  },
  {
    icon: "i-lucide-file-x",
    title: "Void",
    body: "For an invoice that should never have existed. The accounting reverses and a used coupon is returned.",
  },
  {
    icon: "i-lucide-ban",
    title: "Write off",
    body: "You have given up on an unpaid invoice. It is recorded as bad debt, with the reason kept.",
  },
];

const collect = [
  {
    icon: "i-lucide-credit-card",
    title: "Charged automatically",
    body: "The saved card or mandate is charged when the invoice posts, through your own gateway.",
  },
  {
    icon: "i-lucide-send",
    title: "Sent with payment terms",
    body: "For customers who pay by transfer, send the invoice with net terms instead of charging a card.",
  },
  {
    icon: "i-lucide-landmark",
    title: "Paid outside the system",
    body: "Record a bank transfer or a cheque. The invoice is marked paid without touching a card.",
  },
  {
    icon: "i-lucide-piggy-bank",
    title: "Credit applied first",
    body: "Promotional credit, refundable credit and earlier overpayments come off before anything is charged.",
  },
];

const doc = [
  {
    icon: "i-lucide-palette",
    title: "Your brand on every PDF",
    body: "Your logo, icon and brand color on every invoice PDF.",
  },
  {
    icon: "i-lucide-list-ordered",
    title: "One number series",
    body: "One continuous invoice number series per business.",
  },
  {
    icon: "i-lucide-camera",
    title: "A snapshot at issue",
    body: "The address, tax and rates as they were on the day of issue.",
  },
  {
    icon: "i-lucide-users",
    title: "Copies to billing contacts",
    body: "The customer's other billing contacts get the invoice too, with the PDF attached when you select it.",
  },
];

const why = [
  {
    label: "One continuous number series",
    body: "Invoices are numbered in one continuous series, so an auditor reads them in order.",
  },
  {
    label: "One status that everyone reads the same",
    body: "Your team, your customer and your webhooks see the same state of each invoice.",
  },
  {
    label: "An issued amount never changes",
    body: "A correction is a credit note with its own reason. The original stays as it was sent.",
  },
];

const steps = [
  {
    icon: "i-lucide-calendar",
    title: "The renewal date arrives",
    body: "The invoice is raised with the plan, add-ons, last period's usage, discounts and credit.",
  },
  {
    icon: "i-lucide-receipt",
    title: "Tax is worked out",
    body: "Per line and per component, then the lines, tax and total are fixed.",
  },
  {
    icon: "i-lucide-credit-card",
    title: "It is collected",
    body: "The saved card or mandate is charged, or the invoice is sent with payment terms.",
  },
  {
    icon: "i-lucide-file-minus",
    title: "Corrections follow",
    body: "A credit note reduces or refunds it, with its own number and reason.",
  },
];

const faq = [
  {
    label: "Can I edit an invoice after it is issued?",
    content:
      "Not its amounts. A correction is a credit note, a second document with its own reason, so you and your customer can both see what happened. The PO number, expected payment date, notes and shown address stay editable.",
  },
  {
    label: "Can usage and the subscription fee be on one invoice?",
    content:
      "Yes. Usage collects on the open invoice through the period and bills in arrears, next to the fee for the coming period.",
  },
  {
    label: "Can my customers pay by bank transfer?",
    content:
      "Yes. Send the invoice with net terms and record the payment when it arrives. Recovery emails remind the customer while it is due.",
  },
  {
    label: "Can I put a PO number on an invoice?",
    content:
      "Yes. Add it on the invoice or the subscription, or ask buyers for one at checkout. It prints on the PDF.",
  },
  {
    label: "What is the difference between a credit note and a refund?",
    content:
      "A credit note is the document that reduces or reverses what an invoice charged. A refund is money sent back to the card. A refundable credit note becomes credit first, and you refund from it.",
  },
];

useMarketingSeo({
  title: "Recurring invoicing and credit notes",
  crumb: "Invoicing",
  parents: [{ name: "Product", path: "/product" }],
  description:
    "Raise recurring invoices on schedule with tax, discounts and credit applied, in one number series, as a branded PDF. Corrections are credit notes.",
  og: {
    headline: "Recurring invoicing",
    title: "Recurring invoices raised on each renewal date, with tax and credit applied",
    description: "Tax, discounts and credit applied. Branded PDFs.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Recurring invoicing"
      title="Recurring invoices raised on each renewal date, with tax and credit applied"
      description="Two Minute Billing raises each subscription's invoice on its renewal date, with tax, discounts and credit applied. Invoices share one continuous number series per business and go out as your branded PDF. A correction is a credit note, never an edit."
      :secondary="{
        label: 'Invoices and credit notes guide',
        to: '/help/guides/invoices-and-credit-notes',
      }"
    >
      <MkIllustration
        name="IllInvoicingHero"
        :width="600"
        :height="460"
        alt="Saltmarsh Media's Scale plan renews on 1 Dec and an invoice is raised: Scale plan $249.00, three extra seats $45.00, a 10% coupon −$29.40 and account credit −$20.00, so $244.60 is due, and the PDF goes to 2 billing contacts."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Invoices in one number series, with amounts that do not change after issue"
      description="An invoice that changes after it is sent breaks your revenue figures and your customer's books at once. These rules keep both in step."
      :items="why"
    />

    <MkPageZig
      bleed
      kicker="Invoice status"
      title="Every invoice has one clear status"
      accent="one clear status"
      description="Six states, read the same way by your team, your customer and your webhooks."
      :links="[{ label: 'Usage on the same invoice', to: '/solutions/usage' }]"
    >
      <template #default>
        <MkPageBleed
          src="/product/invoices"
          alt="The invoice list, with the status, amount, due date and customer of each invoice"
          :scale="1.45"
        />
      </template>
    </MkPageZig>

    <section class="-mt-2 pb-6">
      <div
        class="mx-auto grid max-w-(--ui-container) gap-3 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-3 lg:px-8"
      >
        <div v-for="st in statuses" :key="st.label" class="mk-surface flex items-start gap-3 p-4">
          <UBadge :color="st.color" variant="subtle" class="shrink-0">{{ st.label }}</UBadge>
          <p class="text-sm text-muted">{{ st.body }}</p>
        </div>
      </div>
    </section>

    <MkPageZig
      flip
      bleed
      kicker="Credit notes"
      title="Correct an issued invoice with a credit note, a void or a write-off"
      accent="credit note"
      description="Issued amounts never change. Each correction is its own document with its own reason, so the record still explains itself a year later."
      :points="corrections"
      :links="[
        { label: 'Invoices and credit notes guide', to: '/help/guides/invoices-and-credit-notes' },
      ]"
    >
      <MkPageBleed
        src="/product/credit-notes"
        alt="The credit note list: each note with its invoice, type, reason, status, amount and customer"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageZig
      kicker="Collection"
      title="Collect by saved card, by invoice with net terms, or by bank transfer"
      accent="net terms"
      description="Card on file for self-serve customers. An invoice with net terms for the ones whose accounts team pays by bank transfer."
      :points="collect"
      :links="[
        { label: 'Payments', to: '/product/payments' },
        { label: 'Recover unpaid invoices', to: '/product/recovery' },
      ]"
    >
      <MkShot
        src="/product/fragments/invoice-lines"
        alt="Invoice line items with a discount, sales tax, the total and the amount paid"
        :width="1556"
        :height="676"
      />
    </MkPageZig>

    <MkPageZig
      flip
      bleed
      kicker="The document"
      title="A branded invoice PDF, fixed as of its issue date"
      accent="invoice PDF"
      description="Each invoice records its tax, rates and addresses as they were that day. Changing a customer's address later does not rewrite a document they already have."
      :points="doc"
      :links="[
        { label: 'Tax on invoices', to: '/product/tax' },
        { label: 'GST invoices for India', to: '/solutions/india' },
      ]"
    >
      <MkPageBleed
        src="/product/invoice-detail"
        alt="An invoice in the dashboard, with its lines, tax, totals, billing and shipping addresses, and payments"
        :scale="1.45"
      />
    </MkPageZig>

    <MkPageFlow kicker="How it works" title="From renewal date to paid invoice" :steps="steps" />

    <MkPageTrust />

    <MkFaq :items="faq" title="Recurring invoicing questions" />

    <MkRelated />

    <MkCta
      title="Raise your first invoice today"
      accent="today"
      description="Sign up free, subscribe a test customer and open the PDF with your own logo on it."
      shot="/product/invoices"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />
  </div>
</template>
