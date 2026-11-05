<script setup lang="ts">
/**
 * The product landing page. Its existence is load-bearing: Docus stops defining the `/` route
 * when `app/pages/index.vue` exists, so this file owns the root of the site.
 *
 * Every claim is something the product does today. No logos or customer numbers until a
 * customer agrees to be named; no vanity counts either. Gateways are named in one place only (the hub): the copy says
 * "your payment gateway", because the list will grow.
 */
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkHomeCta from "~/components/marketing/MkHomeCta.vue";
import MkHomeLifecycle from "~/components/marketing/MkHomeLifecycle.vue";
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import type { SchemaOffer } from "~/composables/useMarketingSeo";
import gatewayData from "../../data/gateways.json";

definePageMeta({ layout: "marketing", header: false, footer: false });

const { signUp } = useAppLinks();
const repo = useRepoUrl();
const modifiers = useShotModifiers();

/** The Free plan from the same catalogue read as /pricing, so the two pages never disagree. */
const { data: plans } = await useFetch("/api/plans", { key: "plans" });
const freePlans = computed(() => plans.value?.free ?? []);
const freeBand = await useFreeBand();
/** The Free plan in each catalogue currency. Paid prices are left to /pricing. */
const offers = computed<SchemaOffer[]>(() =>
  freePlans.value.length
    ? freePlans.value.map((p) => ({
        name: "Free plan",
        price: "0",
        priceCurrency: p.currency,
        description: p.description ?? "Every feature in live mode. No credit card required.",
      }))
    : [
        {
          name: "Free plan",
          price: "0",
          priceCurrency: plans.value?.preferred ?? "USD",
          description: "Every feature in live mode. No credit card required.",
        },
      ],
);

/** Our cheapest monthly price in the build's currency, from the catalogue. */
const fee = computed(() => {
  const monthly = (plans.value?.plans ?? []).filter(
    (p) => p.interval === "month" && p.currency === plans.value?.preferred,
  );
  const low = monthly[0]; // the API sorts by amount
  if (!low) return undefined;
  return new Intl.NumberFormat(low.currency === "INR" ? "en-IN" : "en", {
    style: "currency",
    currency: low.currency,
    maximumFractionDigits: low.amountMinor % 100 === 0 ? 0 : 2,
  }).format(low.amountMinor / 100);
});

/** Four facts a buyer can check, each a link. The gateway count comes from the gateway data. */
const facts = computed(() => [
  {
    title: `${gatewayData.gateways.length} payment gateways`,
    body: "Connect your own account. Your customers pay into it.",
    to: "/integrations",
  },
  {
    title: "Open source",
    body: "Under the AGPL-3.0. Read the code on GitHub.",
    to: repo,
    external: true,
  },
  {
    title: fee.value ? `From ${fee.value} a month` : "A flat monthly price",
    body: "A flat price, with 0% of your revenue.",
    to: "/pricing",
  },
  {
    title: "Free to start",
    body: `Free while you bill less than ${freeBand.value} a month. No credit card.`,
    to: signUp,
  },
]);

/** The developer band's spec list: what an integration can rely on. */
const devSpecs = [
  { k: "Gateways", v: "One API across 12 payment gateways" },
  { k: "Testing", v: "Test cards for each failure" },
  { k: "Events", v: "Webhooks for billing events" },
  { k: "Runs on", v: "Node.js and PostgreSQL" },
];

const benefits = [
  { title: "Paid straight to you", body: "The money goes into your own gateway account." },
  { title: "No share of your revenue", body: "A flat monthly price, however much you bill." },
  { title: "Open source", body: "Self-host it with all features, or let us run it." },
];

/** The AI billing band: what the margin story rests on. Each claim is on /solutions/ai-billing. */
const aiPoints = [
  {
    title: "Model prices that keep up",
    body: "A dated price list, updated two times a day. Your markup follows it.",
  },
  {
    title: "Credits checked before each call",
    body: "Prepaid credits collect the money first. 95% of checks answer in under 100 ms.",
  },
  {
    title: "Margin per customer",
    body: "Price, model cost and margin by customer, model and meter.",
  },
];

const solutions = [
  {
    title: "SaaS billing",
    body: "Seats, add-ons, monthly and yearly plans.",
    link: "SaaS billing software",
    to: "/solutions/saas",
  },
  {
    title: "Usage-based billing",
    body: "Meters and rate cards, billed with the plan fee.",
    link: "Metered billing",
    to: "/solutions/usage",
  },
  {
    title: "AI billing",
    body: "Model prices, prepaid credits and spend limits, with margin per customer.",
    link: "AI billing software",
    to: "/solutions/ai-billing",
  },
  {
    title: "Ecommerce and D2C",
    body: "One-time and repeat orders from one checkout, with skips and pauses.",
    link: "Billing for ecommerce",
    to: "/solutions/ecommerce",
  },
];

/** Each card opens on an illustration of one real moment of the feature. */
const product: {
  title: string;
  body: string;
  to: string;
  /** The illustration board (public/illustrations/) and what it shows. */
  art: string;
  alt: string;
  /** What the picture is about: running billing (cyan) or money won and growth (lime). */
  tone: "billing" | "growth";
}[] = [
  {
    title: "Subscription management",
    body: "Trials, upgrades, pauses and proration, calculated for you.",
    to: "/product/subscriptions",
    art: "IllCardSubscriptions",
    alt: "An upgrade from Growth to Enterprise, prorated: $60.00 due now.",
    tone: "billing",
  },
  {
    title: "Recurring invoicing",
    body: "Invoices go out on schedule, with tax and discounts, as a branded PDF.",
    to: "/product/invoicing",
    art: "IllCardInvoicing",
    alt: "A paid invoice for Pro Monthly: $49.00 plus $3.55 sales tax, $52.55 total, with its PDF.",
    tone: "billing",
  },
  {
    title: "Failed payment recovery",
    body: "Dunning with backup cards, retries on your schedule and one-click payment links.",
    to: "/product/recovery",
    art: "IllCardRecovery",
    alt: "A renewal retried twice and paid on the second retry: $129.00 recovered.",
    tone: "growth",
  },
  {
    title: "Tax on each invoice line",
    body: "VAT, GST, US sales tax by state and EU VAT reverse charge.",
    to: "/product/tax",
    art: "IllCardTax",
    alt: "One $90.00 plan taxed three ways: reverse charge in Germany, sales tax in California and VAT 20% in the United Kingdom.",
    tone: "billing",
  },
  {
    title: "Hosted checkout and portal",
    body: "Hosted checkout, buy links and a self-serve portal for your customers.",
    to: "/product/checkout-portal",
    art: "IllCardCheckout",
    alt: "A hosted checkout for Starter Monthly at €29.00 a month, €34.51 with tax, with a Subscribe button.",
    tone: "billing",
  },
  {
    title: "MRR and churn reporting",
    body: "MRR, churn, cohorts and receivables, in each currency.",
    to: "/product/reporting",
    art: "IllCardMrr",
    alt: "MRR of $38.32K, up 5.7% in 30 days, beside its trend chart.",
    tone: "growth",
  },
];

/** Each step opens on an illustration of that step in the dashboard. */
const how: { n: number; title: string; body: string; art: string; alt: string }[] = [
  {
    n: 1,
    title: "Connect",
    body: "Connect the gateway account you already have.",
    art: "IllHowConnect",
    alt: "A Stripe account connected with its secret key and shown as live.",
  },
  {
    n: 2,
    title: "Set up",
    body: "Add your plans, prices and tax.",
    art: "IllHowSetup",
    alt: "The Team plan priced at $99.00 and €89.00 a month, with US sales tax enabled.",
  },
  {
    n: 3,
    title: "Bill",
    body: "Invoices, charges and retries run on schedule.",
    art: "IllHowBill",
    alt: "Invoice INV-1078 paid at $106.18, and the next billing date, 21 Nov.",
  },
];

/** The rest of the product, grouped: a checklist, not a grid of icon tiles. */
const builtIn = [
  {
    group: "Prices",
    items: [
      {
        title: "Prices in each currency",
        body: "One plan, a separate price for each currency.",
        to: "/product/subscriptions",
      },
      {
        title: "Usage-based billing",
        body: "Meters, rate cards and eight ways to count.",
        to: "/solutions/usage",
      },
      {
        title: "Prepaid credits",
        body: "Customers buy credit packs. Usage draws them down.",
        to: "/solutions/ai-billing",
      },
    ],
  },
  {
    group: "Subscriptions",
    items: [
      {
        title: "Trials and proration",
        body: "Free trials. A plan change charges only the difference.",
        to: "/product/subscriptions",
      },
      {
        title: "Pause and skip renewals",
        body: "Customers pause a subscription or skip one renewal.",
        to: "/solutions/ecommerce",
      },
    ],
  },
  {
    group: "Invoices and credit",
    items: [
      {
        title: "Coupons and credit",
        body: "Coupons and account credit, applied to the invoice.",
        to: "/product/invoicing",
      },
      {
        title: "Credit notes",
        body: "A correction is a credit note with its own reason.",
        to: "/product/invoicing",
      },
    ],
  },
  {
    group: "Access and CRM",
    items: [
      {
        title: "Entitlements",
        body: "Features and limits for each plan, which your app can check.",
        to: "/solutions/saas",
      },
      {
        title: "HubSpot sync",
        body: "Billing details on the HubSpot record, synced both ways.",
        to: "/integrations",
      },
    ],
  },
];

const faq = computed(() => [
  {
    label: "What is subscription billing software?",
    content:
      "Subscription billing software charges your customers on a schedule and keeps the records. It raises recurring invoices with tax, bills usage and AI tokens, retries failed payments (dunning) and gives customers a portal to manage their plan. Two Minute Billing does this through your own payment gateway account.",
  },
  {
    label: "Do I need my own payment gateway?",
    content:
      "Yes. Two Minute Billing connects to your own payment gateway account, and the money goes straight to it. We never hold your funds, and you keep your gateway pricing.",
  },
  {
    label: "Is there a free subscription billing plan?",
    content: `Yes. Two Minute Billing Cloud is free while you bill less than ${freeBand.value} a month. Then you pay a flat monthly price, never a share of your revenue. You do not need a credit card to start.`,
  },
  {
    label: "Is Two Minute Billing open source?",
    content:
      "Yes. The Two Minute Billing engine is open source under the AGPL-3.0. Self-host it on your own servers with all features, or let us run it on our Cloud.",
  },
  {
    label: "Do you store card numbers?",
    content:
      "No. Your payment gateway stores the cards. We keep only the reference that the gateway gives us, so Two Minute Billing stays in PCI DSS SAQ-A scope.",
  },
]);

useMarketingSeo({
  fullTitle: "Subscription billing software | Two Minute Billing",
  title: "Subscription billing software",
  description:
    "Subscription billing software on your own payment gateway: recurring invoices with tax, usage and AI billing, dunning and MRR reports. Free to start.",
  og: {
    headline: "Subscription billing software",
    title: "Subscription billing on your own payment gateway",
    description:
      "Recurring invoices with tax, payment recovery and MRR reports. Cloud or self-hosted.",
  },
  offers,
  faq: faq.value,
});
</script>

<template>
  <div class="hp">
    <!-- 1. Hero: one action; the picture plays a subscription, usage and a one-time order -->
    <section class="mk-hero hp-hero">
      <UContainer class="flex flex-col items-center pt-16 text-center lg:pt-20">
        <h1 class="mk-h1 max-w-[54rem] text-highlighted">
          Subscription billing on your own payment gateway
        </h1>
        <p class="hp-lede mt-5 max-w-[42rem]">
          Bill subscriptions, usage, AI tokens and one-time orders through your own payment gateway
          account. You pay a flat monthly price, not a share of your revenue.
        </p>
        <UButton
          :to="signUp"
          size="xl"
          trailing-icon="i-lucide-arrow-up-right"
          class="hp-btn mt-8"
          :ui="{ trailingIcon: 'size-4.5' }"
        >
          Start for free
        </UButton>
        <p class="mt-3.5 text-sm text-muted">
          Free while you bill less than {{ freeBand }} a month. No credit card.
        </p>
        <div class="hp-ill-frame mt-14 w-full max-w-[68.75rem]">
          <MkHomeLifecycle />
        </div>
      </UContainer>
    </section>

    <!-- 2. Facts: four checkable facts, each a link -->
    <section aria-label="Facts">
      <UContainer class="pt-16 pb-20 lg:pb-24">
        <ul class="hp-facts">
          <li v-for="f in facts" :key="f.title" class="hp-fact">
            <ULink :to="f.to" :target="f.external ? '_blank' : undefined" class="hp-fact-title">
              {{ f.title }}<UIcon name="i-lucide-arrow-right" class="size-4 text-primary" />
            </ULink>
            <p class="hp-fact-body">{{ f.body }}</p>
          </li>
        </ul>
      </UContainer>
    </section>

    <!-- 3. Payments: statement left, gateway hub right, three benefits on a ruled line -->
    <section id="why" class="hp-band">
      <UContainer class="py-16 lg:py-24">
        <div class="flex flex-wrap items-center justify-between gap-12">
          <div class="flex min-w-0 flex-[1_1_25rem] flex-col items-start">
            <span class="mk-kicker mb-4">Payments</span>
            <h2 class="mk-h2 text-highlighted">
              Recurring payments through your own payment gateway.
              <span class="mk-tone">The money goes straight to your account.</span>
            </h2>
            <p class="hp-body mt-5 max-w-[30rem]">
              Connect the gateway accounts you already have. Two Minute Billing decides what to
              charge and when. Your gateway moves the money, and we never hold it.
            </p>
            <UButton
              to="/product/payments"
              size="xl"
              trailing-icon="i-lucide-arrow-up-right"
              class="hp-btn mt-8"
            >
              How payments work
            </UButton>
          </div>
          <div class="hp-ill-frame min-w-0 max-w-[37.5rem] flex-[1_1_32rem]">
            <MkIllustration
              name="IllHomeHub"
              :width="600"
              :height="420"
              alt="Your gateway accounts (Stripe, PayPal, Razorpay, Adyen) connect to the billing engine, which sends email and webhooks and runs the portal and checkout. A $59.00 payment succeeded."
            />
          </div>
        </div>
        <ul class="hp-ruled mt-16 grid gap-8 sm:grid-cols-3">
          <li v-for="b in benefits" :key="b.title" class="pt-6">
            <h3 class="text-lg font-medium text-highlighted">{{ b.title }}</h3>
            <p class="mt-1.5 text-base leading-relaxed text-muted">{{ b.body }}</p>
          </li>
        </ul>
      </UContainer>
    </section>

    <!-- 3b. AI billing: the picture left, the statement right, three points on a ruled line -->
    <section id="ai-billing">
      <UContainer class="py-16 lg:py-24">
        <div class="flex flex-wrap items-center justify-between gap-12">
          <div class="flex min-w-0 flex-[1_1_25rem] flex-col items-start">
            <span class="mk-kicker mb-4">AI billing</span>
            <h2 class="mk-h2 text-highlighted">
              AI billing that keeps your margin
              <span class="mk-tone">when model prices change.</span>
            </h2>
            <p class="hp-body mt-5 max-w-[30rem]">
              Price each model from its list price plus your markup. Sell prepaid credits, check
              them before each call, and see what each customer earns you after model cost.
            </p>
            <UButton
              to="/solutions/ai-billing"
              size="xl"
              trailing-icon="i-lucide-arrow-up-right"
              class="hp-btn mt-8"
            >
              How AI billing works
            </UButton>
          </div>
          <div class="hp-ill-frame min-w-0 max-w-[37.5rem] flex-[1_1_32rem] lg:order-first">
            <MkIllustration
              name="IllAiBillingHero"
              :width="600"
              :height="460"
              alt="A model's list price drops from $3.00 to $2.50 per 1M tokens on 15 November. Your price is the list price plus 20%, $3.00 per 1M. November usage margin for MuseLane AI: revenue $18,420, model cost $11,050, margin $7,370, 40%."
            />
          </div>
        </div>
        <ul class="hp-ruled mt-16 grid gap-8 sm:grid-cols-3">
          <li v-for="p in aiPoints" :key="p.title" class="pt-6">
            <h3 class="text-lg font-medium text-highlighted">{{ p.title }}</h3>
            <p class="mt-1.5 text-base leading-relaxed text-muted">{{ p.body }}</p>
          </li>
        </ul>
      </UContainer>
    </section>

    <!-- 4. Solutions: the heading in its column, four ruled link rows -->
    <section id="solutions">
      <UContainer class="hp-split py-16 lg:py-24">
        <h2 class="mk-h2 text-highlighted">
          Subscription billing for SaaS, usage-based, AI and ecommerce businesses.
          <span class="mk-tone">Select your model to see how it bills.</span>
        </h2>
        <ul class="hp-rows">
          <li v-for="s in solutions" :key="s.to">
            <NuxtLink :to="s.to" class="hp-row">
              <div class="min-w-0">
                <h3 class="mk-h3 text-highlighted">{{ s.title }}</h3>
                <p class="mt-1 text-[0.9375rem] leading-relaxed text-muted">{{ s.body }}</p>
              </div>
              <span class="hp-row-link">
                {{ s.link }}<UIcon name="i-lucide-arrow-right" class="size-4" />
              </span>
            </NuxtLink>
          </li>
        </ul>
      </UContainer>
    </section>

    <!-- 5. Product: six cards, the picture on top, one line under it -->
    <section id="product" class="hp-band">
      <UContainer class="py-16 lg:py-24">
        <h2 class="mk-h2 max-w-[44rem] text-highlighted">
          Subscription management software, from sign-up to paid invoice.
          <span class="mk-tone">Each step on one record.</span>
        </h2>
        <div class="hp-grid mt-12">
          <NuxtLink
            v-for="f in product"
            :key="f.title"
            :to="f.to"
            class="mk-card hp-card"
            :class="f.tone === 'growth' ? 'mk-growth' : 'mk-billing'"
          >
            <div class="hp-stage">
              <MkIllustration :name="f.art" :width="600" :height="320" :alt="f.alt" />
            </div>
            <div class="px-6 pt-5 pb-6">
              <h3 class="mk-h3 text-highlighted">{{ f.title }}</h3>
              <p class="mt-2 text-base leading-relaxed text-muted">{{ f.body }}</p>
            </div>
          </NuxtLink>
        </div>
      </UContainer>
    </section>

    <!-- 6. How it works: three unboxed steps on one ruled line -->
    <section id="how">
      <UContainer class="py-16 lg:py-24">
        <div class="flex flex-wrap items-end justify-between gap-6">
          <h2 class="mk-h2 max-w-[40rem] text-highlighted">
            Connect your own payment gateway, add your plans, then send the first invoice.
          </h2>
          <div class="flex flex-wrap items-center gap-6">
            <UButton :to="signUp" size="xl" trailing-icon="i-lucide-arrow-up-right" class="hp-btn">
              Start for free
            </UButton>
            <ULink
              to="/help/getting-started"
              class="inline-flex items-center gap-2 text-[0.9375rem] font-medium text-primary"
            >
              Read the getting-started guide<UIcon name="i-lucide-arrow-right" class="size-4" />
            </ULink>
          </div>
        </div>
        <ol class="hp-ruled hp-steps mt-12">
          <li v-for="h in how" :key="h.n" class="pt-6">
            <span class="text-sm text-muted">Step 0{{ h.n }}</span>
            <h3 class="mk-h3 mt-1 text-highlighted">{{ h.title }}</h3>
            <p class="mt-1.5 text-[0.9375rem] leading-relaxed text-muted">{{ h.body }}</p>
            <div class="hp-stage mt-5">
              <MkIllustration :name="h.art" :width="600" :height="320" :alt="h.alt" />
            </div>
          </li>
        </ol>
      </UContainer>
    </section>

    <!-- 7. Developers: the one dark band -->
    <section id="developers" class="hp-dev">
      <UContainer class="relative py-16 lg:py-24">
        <div class="hp-dev-top">
          <div class="min-w-0">
            <span class="mk-kicker hp-dev-label">Developers</span>
            <h2 class="mk-h2 mt-4 text-white">
              A subscription billing API for every action in the dashboard.
              <span class="text-[#93a4bd]">Build billing into your own product.</span>
            </h2>
            <p class="mt-4 text-[1.0625rem] leading-relaxed text-[#a7b4c9]">
              The engine is open source under the AGPL-3.0. Run it on your own servers, or use our
              Cloud.
            </p>
            <div class="mt-5 flex flex-wrap gap-x-6 gap-y-2">
              <ULink
                v-if="repo"
                :to="repo"
                target="_blank"
                class="inline-flex items-center gap-2 font-medium text-[#9393f3] hover:text-white"
              >
                <UIcon name="i-simple-icons-github" class="size-4" />View the source on GitHub
              </ULink>
              <ULink to="/integrations" class="font-medium text-[#9393f3] hover:text-white"
                >Billing integrations</ULink
              >
            </div>
          </div>
          <div class="min-w-0">
            <ul class="hp-specs">
              <li v-for="d in devSpecs" :key="d.k">
                <span class="mk-label hp-dev-label">{{ d.k }}</span
                ><span>{{ d.v }}</span>
              </li>
            </ul>
            <div class="mt-7 flex flex-wrap gap-3">
              <UButton
                to="/help/developers/getting-started/quickstart"
                size="xl"
                trailing-icon="i-lucide-arrow-up-right"
                class="h-12 px-5.5"
              >
                Quickstart
              </UButton>
              <UButton
                to="/help/developers/api-reference"
                size="xl"
                color="neutral"
                variant="ghost"
                class="mk-band-btn h-12 px-5.5"
              >
                API reference
              </UButton>
            </div>
          </div>
        </div>

        <div class="hp-composite mt-14">
          <div class="hp-composite-shot">
            <UColorModeImage
              light="/product/invoice-detail-light.webp"
              dark="/product/invoice-detail-dark.webp"
              alt="An invoice in the dashboard, with its lines, tax and payments"
              :width="1920"
              :height="1080"
              :modifiers="modifiers"
              loading="lazy"
              class="hp-composite-img"
            />
          </div>
          <div class="hp-json">
            <div class="hp-json-bar">
              <span class="mk-label hp-dev-label">API response</span>
            </div>
            <pre
              class="mk-code hp-json-code"
            ><span class="m">GET</span> /v1/businesses/$BIZ/invoices/inv_XXXXXXXXXXXX01

{
  <span class="k">"object"</span>: <span class="s">"invoice"</span>,
  <span class="k">"number"</span>: <span class="s">"INV-1084"</span>,
  <span class="k">"status"</span>: <span class="s">"paid"</span>,
  <span class="k">"currency"</span>: <span class="s">"USD"</span>,
  <span class="k">"total_minor"</span>: 8473,
  <span class="k">"amount_due_minor"</span>: 0,
  …
}</pre>
          </div>
        </div>
      </UContainer>
    </section>

    <!-- 8. Also built in: a grouped capability list -->
    <section id="features">
      <UContainer class="py-16 lg:py-24">
        <div class="flex flex-wrap items-end justify-between gap-6">
          <h2 class="mk-h2 max-w-[40rem] text-highlighted">
            Multi-currency prices, trials, credit notes and CRM sync.
            <span class="mk-tone">In every plan.</span>
          </h2>
          <UButton
            to="/product"
            color="neutral"
            variant="outline"
            size="lg"
            trailing-icon="i-lucide-arrow-up-right"
            class="bg-default"
          >
            Explore all features
          </UButton>
        </div>
        <div class="hp-groups mt-12">
          <div v-for="g in builtIn" :key="g.group" class="hp-ruled pt-6">
            <h3 class="text-[0.9375rem] font-medium text-highlighted">{{ g.group }}</h3>
            <ul class="mt-4 flex flex-col gap-4">
              <li v-for="b in g.items" :key="b.title" class="flex gap-2.5">
                <UIcon name="i-lucide-check" class="mk-ico mk-billing mt-1 size-4 shrink-0" />
                <NuxtLink :to="b.to" class="min-w-0">
                  <span class="block font-medium text-highlighted hover:text-primary">{{
                    b.title
                  }}</span>
                  <span class="mt-0.5 block text-[0.9375rem] leading-relaxed text-muted">{{
                    b.body
                  }}</span>
                </NuxtLink>
              </li>
            </ul>
          </div>
        </div>
      </UContainer>
    </section>

    <!-- 9. FAQ: the heading in its column, ruled questions -->
    <div id="faq" class="hp-band">
      <MkFaq :items="faq" title="Questions about subscription billing" />
    </div>

    <!-- 10. Call to action -->
    <MkHomeCta />
  </div>
</template>

<style scoped>
.hp-lede {
  font-size: 1.1875rem;
  line-height: 1.6;
  color: var(--ui-text-muted);
  text-wrap: balance;
}
.hp-body {
  font-size: 1.0625rem;
  line-height: 1.65;
  color: var(--ui-text-muted);
}
.hp-btn {
  height: 3rem;
  padding-inline: 1.375rem;
  font-size: 1rem;
  font-weight: 500;
  gap: 0.625rem;
}

/* Sections alternate full-bleed bands (white, then the pale tint) split by hairlines. */
.hp-band {
  background: var(--mk-wash);
  border-block: 1px solid var(--ui-border-muted);
}
/* A ruled group: a hairline on top, never a box. */
.hp-ruled > li,
.hp-ruled {
  border-top: 1px solid var(--ui-border);
}
.hp-ruled:is(ul, ol) {
  border-top: 0;
}

/* Heading in its own column, the content beside it. */
.hp-split {
  display: grid;
  gap: 2.5rem;
}
@media (min-width: 1024px) {
  .hp-split {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
    gap: 4rem;
  }
}
.hp-rows > li {
  border-top: 1px solid var(--ui-border);
}
.hp-rows > li:last-child {
  border-bottom: 1px solid var(--ui-border);
}
.hp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding-block: 1.25rem;
  color: inherit;
}
.hp-row-link {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--ui-primary);
}
@media (max-width: 640px) {
  .hp-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
}

/* Product cards: three across on desktop; the boards are drawn to be read at about 0.6 scale. */
.hp-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.25rem;
}
@media (max-width: 1024px) {
  .hp-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .hp-grid {
    grid-template-columns: 1fr;
  }
}
.hp-card {
  color: inherit;
}
/* The picture sits in an inset panel on a flat tint that says what it shows (cyan = billing,
   lime = money won, neutral = a process), so its white cards never read as the card's text. */
.hp-stage {
  margin: 0.5rem 0.5rem 0;
  overflow: hidden;
  border-radius: 0.375rem;
  border: 1px solid var(--ui-border-muted);
}
.hp-steps .hp-stage {
  margin: 0;
}
.hp-stage :deep(.ill) {
  --d-bg: var(--mk-mark-soft);
  --d-stage-top: var(--mk-mark-soft);
}
.dark .hp-stage :deep(.ill) {
  --d-bg: color-mix(in oklab, var(--mk-mark-soft) 35%, #070b12);
  --d-stage-top: color-mix(in oklab, var(--mk-mark-soft) 35%, #070b12);
}
.hp-stage :deep(.ill),
.hp-ill-frame :deep(.ill),
.hp-stage :deep(.mk-illustration),
.hp-ill-frame :deep(.mk-illustration) {
  border: 0;
  border-radius: 0;
}
/* A product illustration on the page: a hairline frame, no shadow. */
.hp-ill-frame {
  overflow: hidden;
  border-radius: 0.625rem;
  border: 1px solid var(--ui-border);
  text-align: left;
}

/* How it works: three steps side by side. */
.hp-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: 2rem;
}

/* Also built in: four groups of two. */
.hp-groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
  gap: 2rem;
}

/* Developers: a full-width dark band, the same in both themes. */
.hp-dev {
  position: relative;
  overflow: hidden;
  background: #0b1220;
  color: #e6edf7;
}
:global(.dark) .hp-dev {
  background: #070c17;
  border-block: 1px solid rgb(255 255 255 / 0.06);
}
.hp-dev .hp-dev-label {
  color: #8f9bb3;
}
/* The developer band's spec list: label left, value right, ruled. */
.hp-specs {
  border-top: 1px solid rgb(255 255 255 / 0.1);
  font-size: 0.9375rem;
  color: #e6edf7;
}
.hp-specs li {
  display: grid;
  grid-template-columns: 7.5rem minmax(0, 1fr);
  gap: 1rem;
  align-items: center;
  min-height: 3rem;
  border-bottom: 1px solid rgb(255 255 255 / 0.1);
}
.hp-dev-top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 3rem;
  align-items: end;
}
.hp-composite {
  position: relative;
  padding-bottom: 4rem;
}
.hp-composite-shot {
  width: 82%;
  height: 32.5rem;
  overflow: hidden;
  border-radius: 0.625rem;
  border: 1px solid rgb(255 255 255 / 0.12);
  background: var(--mk-card);
}
/* Source x 262–1500: the invoice itself at about 0.8 scale, so its text stays readable. */
.hp-composite-shot :deep(.hp-composite-img) {
  vertical-align: top;
  width: 155.089%;
  max-width: none;
  height: auto;
  margin-left: -21.163%;
}
.hp-json {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 28.75rem;
  max-width: 100%;
  overflow: hidden;
  border-radius: 0.625rem;
  border: 1px solid rgb(255 255 255 / 0.14);
  background: #0d1526;
}
.hp-json-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2.625rem;
  padding: 0 1rem;
  border-bottom: 1px solid rgb(255 255 255 / 0.08);
  background: rgb(255 255 255 / 0.03);
}
.hp-json-code {
  margin: 0;
  padding: 1rem 1.125rem 1.25rem;
  border-radius: 0;
  background: transparent;
}
.hp-json-code .m {
  color: #eaf0f8;
  font-weight: 600;
}
@media (max-width: 980px) {
  .hp-dev-top {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 760px) {
  .hp-composite {
    padding-bottom: 0;
  }
  /* The whole capture height, so no empty band shows under a short image. */
  .hp-composite-shot {
    width: 100%;
    height: auto;
  }
  .hp-json {
    position: relative;
    right: auto;
    bottom: auto;
    width: auto;
    margin: -3rem 0.75rem 0;
  }
}

/* Facts: four columns under one rule, split by hairlines; each title is a link. */
.hp-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  padding-top: 2rem;
  border-top: 1px solid var(--ui-border);
}
.hp-fact {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
  padding-inline: 1.5rem;
  border-left: 1px solid var(--ui-border);
}
.hp-fact:first-child {
  padding-left: 0;
  border-left: 0;
}
.hp-fact-title {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.375rem;
  letter-spacing: -0.01em;
  color: var(--ui-text-highlighted);
}
.hp-fact-title:hover {
  color: var(--ui-primary);
}
.hp-fact-body {
  font-size: 0.9375rem;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
@media (max-width: 900px) {
  .hp-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: 1.75rem;
  }
  .hp-fact:nth-child(3) {
    padding-left: 0;
    border-left: 0;
  }
}
@media (max-width: 520px) {
  .hp-facts {
    grid-template-columns: 1fr;
    row-gap: 1.25rem;
  }
  .hp-fact {
    padding: 0;
    border-left: 0;
  }
}
</style>
