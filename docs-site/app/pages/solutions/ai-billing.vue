<script setup lang="ts">
/**
 * Solution: billing for AI products — model prices with a markup on list or on cost, margin
 * after model cost, prepaid credits with a check before each call, spend controls and the
 * usage widget. The example business is MuseLane AI, an app that writes text and makes images.
 */
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

const why = [
  {
    label: "Price each model, and keep up",
    body: "Bill from the model's list price plus your markup. When a list price changes, the next call bills at the new price.",
  },
  {
    label: "Show margin after model cost",
    body: "See which customers cost more in model fees than they pay, before the month ends.",
  },
  {
    label: "Stop usage nobody will pay for",
    body: "Prepaid credits collect the money first. A check before each call stops usage that nobody will pay for.",
  },
];

const pricingPoints = [
  {
    icon: "i-lucide-list",
    title: "A dated model price list",
    body: "Updated two times a day. Large or odd changes wait for review.",
  },
  {
    icon: "i-lucide-percent",
    title: "Markup on list or on cost",
    body: "Record what you really pay a provider, and price as cost plus.",
  },
  {
    icon: "i-lucide-user-round",
    title: "A price for one customer",
    body: "A lower markup or fixed rates for a large account.",
  },
  {
    icon: "i-lucide-receipt-text",
    title: "Every line cites its price",
    body: "Each invoice line names the price row that billed it.",
  },
];

const marginPoints = [
  {
    icon: "i-lucide-coins",
    title: "Your real cost",
    body: "A negotiated rate, the cost on each event, or the list price.",
  },
  {
    icon: "i-lucide-chart-column",
    title: "Usage so far this period",
    body: "Each customer's usage by day, cost, margin and a projection.",
  },
  {
    icon: "i-lucide-bell",
    title: "A notice when a price moves",
    body: "You hear about each change and which subscriptions it affects.",
  },
  {
    icon: "i-lucide-scale",
    title: "Preview a rate change",
    body: "See what each customer's last period costs at the new rate.",
  },
];

const marginRows = [
  { name: "Kaveri Freight", pct: 48 },
  { name: "Corvid Analytics", pct: 37 },
  { name: "Saltmarsh Media", pct: 12 },
];

const creditPoints = [
  {
    icon: "i-lucide-badge-cent",
    title: "Your own credit unit",
    body: 'Show "1,000 credits" instead of a money amount.',
  },
  {
    icon: "i-lucide-repeat",
    title: "Plan credits that roll over",
    body: "Credits each period, with a rollover by percent, cap or number of periods.",
  },
  {
    icon: "i-lucide-hourglass",
    title: "Holds for calls in progress",
    body: "Calls that run at the same time cannot overspend the balance.",
  },
  {
    icon: "i-lucide-gift",
    title: "Free credit comes off before tax",
    body: "Promotional credit applies before tax is calculated.",
  },
];

const packs = [
  { label: "1,000 credits", price: "$10.00" },
  { label: "5,000 credits", price: "$45.00" },
];

const spendPoints = [
  {
    icon: "i-lucide-bell-ring",
    title: "Alerts before the limit",
    body: "On spend, usage, balance or days of credit left.",
  },
  {
    icon: "i-lucide-calendar-clock",
    title: "Credit runway",
    body: "Days of credit left at the last 7 days' rate.",
  },
  {
    icon: "i-lucide-refresh-cw",
    title: "Automatic top-up",
    body: "Buys credit at a balance or on a date. Credit arrives only after the payment succeeds.",
  },
  {
    icon: "i-lucide-file-clock",
    title: "Invoice large usage early",
    body: "Bill usage when it reaches an amount, not at month end.",
  },
];

const widgetBars = [40, 55, 35, 70, 60, 85, 75];

const steps = [
  {
    icon: "i-lucide-tags",
    title: "Price your models",
    body: "From the price list plus a markup, or your own rates.",
  },
  {
    icon: "i-lucide-shield-check",
    title: "Check before the call",
    body: "Your app asks if the customer has credit and room under the limit.",
  },
  {
    icon: "i-lucide-activity",
    title: "Report the response",
    body: "The SDK helper turns each model response into usage.",
  },
  {
    icon: "i-lucide-credit-card",
    title: "Credits pay, the rest bills",
    body: "Credits pay first. Usage they do not cover goes on the invoice, with tax.",
  },
];

const related = [
  {
    to: "/solutions/usage",
    icon: "i-lucide-gauge",
    label: "Usage-based billing",
    description: "Meters, rate cards and late usage.",
  },
  {
    to: "/help/guides/usage-and-ai-billing",
    icon: "i-lucide-book-open",
    label: "Usage and AI billing guide",
    description: "Model prices, credits and limits, in the dashboard.",
  },
  {
    to: "/help/developers/recipes/bill-ai-tokens",
    icon: "i-lucide-code",
    label: "Bill AI tokens",
    description: "The recipe, by API.",
  },
  {
    to: "/help/developers/recipes/prepaid-ai-credits",
    icon: "i-lucide-wallet",
    label: "Prepaid AI credits",
    description: "Packs, plan credits and holds.",
  },
];

const faq = [
  {
    label: "What is AI billing?",
    content:
      "AI billing is billing for products that call AI models. Each call has a cost that changes with the model and the number of tokens. So the bill prices usage per model, often sells prepaid credits and keeps spend inside limits. It is not AI that writes invoices for you.",
  },
  {
    label: "Can I charge the model's list price plus a markup?",
    content:
      "Yes. A price can bill each model at its list price plus a percent. If you pay a provider less than the list price, record your cost and price as cost plus instead. You can also set fixed rates for any model.",
  },
  {
    label: "What happens when a model's price changes?",
    content:
      "Usage already recorded keeps its price. Usage after the change bills at the new price, on a separate invoice line. You get an email and a notice that list each change.",
  },
  {
    label: "How do I stop a customer from spending too much?",
    content:
      "Set a hard spend limit. When the next call would go over it, the access check answers no, and your app stops the call. A soft limit only sends an alert.",
  },
  {
    label: "Is tax charged on credits?",
    content:
      "Promotional credit applies before tax is calculated. For paid credit packs you select when tax is charged: when the customer buys the pack, or when the credit is used.",
  },
  {
    label: "Which payment gateways does it work with?",
    content:
      "Your own. Each business connects its own gateway account, such as Stripe, PayPal or Razorpay, and customers pay through it. Credit packs, top-ups and invoices all collect there.",
  },
  {
    label: "Can I self-host it?",
    content:
      "Yes. The open-source edition has every feature, including the model price list. You can point it to your own copy of the list or turn the updates off.",
  },
];

useMarketingSeo({
  title: "AI billing software for tokens and credits",
  crumb: "AI billing",
  description:
    "Bill AI usage by model and token, at list price plus markup or cost plus. Prepaid credits, spend limits and a margin report. Open source, free to start.",
  og: {
    headline: "AI billing",
    title: "AI billing for tokens and credits, at a margin you can see",
    description: "Model prices, prepaid credits, spend limits and margin after model cost.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="AI billing software"
      title="AI billing for tokens and credits, at a margin you can see"
      description="AI billing charges customers for the model calls your product makes. Two Minute Billing is billing software with an open-source edition. It prices each model and token type, sells prepaid credits, checks the balance before each call, and shows your margin per customer after model costs. It collects through your own payment gateway."
      :secondary="{
        label: 'Bill AI tokens recipe',
        to: '/help/developers/recipes/bill-ai-tokens',
      }"
    >
      <MkIllustration
        name="IllAiBillingHero"
        :width="600"
        :height="460"
        alt="A model's list price drops from $3.00 to $2.50 per 1M tokens on 15 November. Your price is the list price plus 20%, $3.00 per 1M. November usage margin for MuseLane AI: revenue $18,420, model cost $11,050, margin $7,370, 40%."
        eager
      />
    </MkPageHero>

    <MkPageWhy kicker="Why it matters" title="What AI billing software must do" :items="why" />

    <MkPageZig
      kicker="Model pricing"
      title="A price for each model and token type"
      accent="and token type"
      description="Quote rates the way model providers do, such as $3.00 per 1M input tokens. Set them by hand, or bill from a model price list that we keep current for you."
      :points="pricingPoints"
      :links="[
        { label: 'Bill AI tokens', to: '/help/developers/recipes/bill-ai-tokens' },
        {
          label: 'Model price list guide',
          to: '/help/guides/usage-and-ai-billing/model-price-list',
        },
      ]"
    >
      <figure class="mk-surface overflow-hidden" role="img" aria-labelledby="ai-split">
        <figcaption id="ai-split" class="sr-only">
          An invoice for MuseLane AI with two lines for one model: input tokens before and after a
          list price change on 15 November, each at the list price plus 20 percent. 1,234,567 tokens
          at $3.60 per 1M is $4.44, and 456,789 tokens at $3.00 per 1M is $1.37.
        </figcaption>
        <div aria-hidden="true">
          <div class="flex items-center justify-between border-b border-default px-5 py-3.5">
            <div>
              <div class="text-xs text-muted">Invoice · November</div>
              <div class="text-sm font-semibold text-highlighted">AI usage</div>
            </div>
            <UBadge color="neutral" variant="subtle">List price + 20%</UBadge>
          </div>
          <ul class="divide-y divide-default text-sm">
            <li class="flex items-start justify-between gap-3 px-5 py-3">
              <span>
                <span class="block text-highlighted">small-v1 · input, to 15 Nov</span>
                <span class="text-xs text-muted">1,234,567 tokens · $3.60 per 1M</span>
              </span>
              <span class="tabular-nums">$4.44</span>
            </li>
            <li class="flex items-start justify-between gap-3 px-5 py-3">
              <span>
                <span class="block text-highlighted">small-v1 · input, from 15 Nov</span>
                <span class="text-xs text-muted">456,789 tokens · $3.00 per 1M</span>
              </span>
              <span class="tabular-nums">$1.37</span>
            </li>
          </ul>
          <div
            class="flex justify-between border-t border-default bg-elevated/60 px-5 py-3 text-sm text-highlighted"
          >
            <span>Price source</span>
            <span class="font-semibold">Model price list · 15 Nov</span>
          </div>
        </div>
      </figure>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Cost and margin"
      title="Margin by customer, model and meter"
      accent="model and meter"
      description="AI usage margin is revenue after discounts and credit notes, minus the model cost of the same usage. Example: $18,420 revenue minus $11,050 model cost is $7,370, a 40% margin."
      :points="marginPoints"
    >
      <figure class="mk-surface p-5" role="img" aria-labelledby="ai-margin">
        <figcaption id="ai-margin" class="sr-only">
          Usage margin by customer for November: Kaveri Freight 48 percent, Corvid Analytics 37
          percent, Saltmarsh Media 12 percent.
        </figcaption>
        <div aria-hidden="true">
          <div class="text-xs text-muted">Usage margin · November · by customer</div>
          <ul class="mt-4 space-y-4 text-sm">
            <li v-for="r in marginRows" :key="r.name">
              <div class="flex justify-between">
                <span class="text-highlighted">{{ r.name }}</span>
                <span class="font-semibold tabular-nums">{{ r.pct }}%</span>
              </div>
              <div class="mt-1.5 h-1.5 rounded-full bg-elevated">
                <div class="h-full rounded-full bg-(--mk-cyan)" :style="{ width: `${r.pct}%` }" />
              </div>
            </li>
          </ul>
          <div
            class="mt-5 flex justify-between rounded-lg border border-default bg-elevated/60 px-3.5 py-2.5 text-xs"
          >
            <span class="text-muted">Group by</span>
            <span class="font-semibold text-highlighted">Customer · Model · Meter</span>
          </div>
        </div>
      </figure>
    </MkPageZig>

    <MkPageZig
      kicker="Prepaid credits"
      title="Sell prepaid AI credits, then check them before each call"
      accent="then check them before each call"
      description="Prepaid AI credits are units a customer buys before using your AI features. Each model call spends credits. Customers buy packs in the portal or get credits with their plan. Your app checks the balance before each call: 95% of checks answer in under 100 ms."
      :points="creditPoints"
      :links="[
        { label: 'Prepaid AI credits', to: '/help/developers/recipes/prepaid-ai-credits' },
        { label: 'Prepaid credits guide', to: '/help/guides/usage-and-ai-billing/prepaid-credits' },
      ]"
    >
      <figure class="mk-surface p-5" role="img" aria-labelledby="ai-packs">
        <figcaption id="ai-packs" class="sr-only">
          The customer portal's Buy credits list: 1,000 credits for $10.00 and 5,000 credits for
          $45.00. Below, the balance: 1,240 credits, of which 40 are held for a call in progress.
        </figcaption>
        <div aria-hidden="true">
          <div class="text-sm font-semibold text-highlighted">Buy credits</div>
          <ul class="mt-3 space-y-2.5 text-sm">
            <li
              v-for="p in packs"
              :key="p.label"
              class="flex items-center justify-between rounded-lg border border-default px-3.5 py-2.5"
            >
              <span class="text-highlighted">{{ p.label }}</span>
              <span class="flex items-center gap-3">
                <span class="font-semibold tabular-nums">{{ p.price }}</span>
                <UButton size="xs" tabindex="-1">Buy</UButton>
              </span>
            </li>
          </ul>
          <div class="mt-4 space-y-1.5 border-t border-default pt-4 text-sm">
            <div class="flex justify-between">
              <span class="text-muted">Balance</span>
              <span class="font-semibold tabular-nums">1,240 credits</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted">Held for a call in progress</span>
              <span class="font-semibold tabular-nums">40 credits</span>
            </div>
          </div>
        </div>
      </figure>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Spend controls"
      title="Stop usage at a limit, yours or your customer's"
      accent="yours or your customer's"
      description="Set spend limits per customer, per subscription or per user. Your customers can set a lower limit of their own in the portal. The lower limit applies."
      :points="spendPoints"
      :links="[
        {
          label: 'Spend limits and top-up',
          to: '/help/developers/recipes/spend-limits-and-auto-top-up',
        },
      ]"
    >
      <figure class="mk-surface p-5" role="img" aria-labelledby="ai-spend">
        <figcaption id="ai-spend" class="sr-only">
          Spend this month: $412 of a $450 limit. Your limit is $500; the customer set their own
          limit of $450, so the lower one applies. An alert was sent at 80 percent. Automatic top-up
          adds 5,000 credits when the balance falls below 500.
        </figcaption>
        <div aria-hidden="true">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs text-muted">Spend this month</div>
              <div class="text-2xl font-semibold text-highlighted tabular-nums">
                $412 <span class="text-sm font-normal text-muted">of $450</span>
              </div>
            </div>
            <UBadge color="neutral" variant="subtle">Alert sent at 80%</UBadge>
          </div>
          <div class="mt-3 h-2 rounded-full bg-elevated">
            <div class="h-full w-[92%] rounded-full bg-(--mk-cyan)" />
          </div>
          <ul class="mt-4 divide-y divide-default border-t border-default text-sm">
            <li class="flex justify-between py-2.5">
              <span>Your limit</span><span class="font-semibold tabular-nums">$500</span>
            </li>
            <li class="flex justify-between py-2.5">
              <span>Customer's own limit</span>
              <span class="font-semibold tabular-nums">$450 · applies</span>
            </li>
            <li class="flex justify-between py-2.5">
              <span>Automatic top-up</span>
              <span class="font-semibold">+5,000 credits below 500</span>
            </li>
          </ul>
        </div>
      </figure>
    </MkPageZig>

    <MkPageZig
      kicker="Usage your customers can see"
      title="Show usage inside your own app"
      accent="inside your own app"
      description="Add the usage widget to your settings page. It shows the balance, days left, usage this period, the estimated bill and the limits, in your colors and font. The customer portal shows the same."
      :links="[{ label: 'Customer portal', to: '/product/checkout-portal' }]"
    >
      <figure class="mk-surface p-5" role="img" aria-labelledby="ai-widget">
        <figcaption id="ai-widget" class="sr-only">
          The usage widget on an app's settings page: 1,240 credits, about 9 days left, estimated
          bill $38.20 this month.
        </figcaption>
        <div aria-hidden="true">
          <div class="text-xs text-muted">MuseLane AI · Settings · Usage</div>
          <div class="mt-3 grid grid-cols-3 gap-2.5 text-xs">
            <div class="rounded-lg border border-default p-3">
              <div class="text-muted">Balance</div>
              <div class="mt-1 text-base font-semibold text-highlighted">1,240</div>
            </div>
            <div class="rounded-lg border border-default p-3">
              <div class="text-muted">Days left</div>
              <div class="mt-1 text-base font-semibold text-highlighted">About 9</div>
            </div>
            <div class="rounded-lg border border-default p-3">
              <div class="text-muted">Estimated bill</div>
              <div class="mt-1 text-base font-semibold text-highlighted">$38.20</div>
            </div>
          </div>
          <div class="mt-4 flex h-16 items-end gap-1.5">
            <div
              v-for="(h, i) in widgetBars"
              :key="i"
              class="flex-1 rounded"
              :class="i >= 5 ? 'bg-(--mk-cyan)' : 'bg-(--mk-cyan-soft)'"
              :style="{ height: `${h}%` }"
            />
          </div>
        </div>
      </figure>
    </MkPageZig>

    <MkPageFlow
      kicker="How it works"
      title="From a model call to a paid invoice"
      description="To bill for AI tokens, set a price per 1M tokens for each model and token type, such as the list price plus 20%. Check the customer's credit before each call, and report the tokens from each response. Credits pay first. The rest goes on the invoice, with tax."
      :steps="steps"
    />

    <MkPageTrust />

    <MkFaq :items="faq" title="AI billing questions" />

    <MkRelated title="Read next" :links="related" />

    <MkCta
      title="Bill your first model call in test mode"
      accent="in test mode"
      description="Price a model, sell a credit pack and check a balance before you go live."
      shot="/product/subscriptions"
      :secondary="{ label: 'Developers', to: '/solutions/developers' }"
    />
  </div>
</template>
