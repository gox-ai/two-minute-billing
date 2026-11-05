<script setup lang="ts">
/**
 * The comparison hub: one row per product with the key difference, and a compact matrix.
 * Every cell about another product comes from utils/compare.ts, where each is sourced.
 */
import MkCta from "~/components/marketing/MkCta.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const freeBand = await useFreeBand();
const comparisons = COMPARISONS.map((c) => fillFreeBand(c, freeBand.value));

useMarketingSeo({
  title: "Compare subscription billing software",
  crumb: "Compare",
  description:
    "Compare Two Minute Billing with seven subscription billing platforms: price, fees on revenue, the seller, gateways and self-hosting, from public pages.",
  og: {
    headline: "Compare",
    title: "Compare subscription billing software",
    description: "Price, fees, seller, gateways and self-hosting.",
  },
});

// The comparison pages as an ItemList, next to the page graph.
const base = String(useSiteConfig().url ?? "").replace(/\/+$/, "");
useHead({
  script: [
    {
      key: "compare-itemlist",
      type: "application/ld+json",
      innerHTML: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Subscription billing platforms compared with Two Minute Billing",
        numberOfItems: COMPARISONS.length,
        itemListElement: COMPARISONS.map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: `${c.name} alternative`,
          url: `${base}/compare/${c.slug}`,
        })),
      }),
    },
  ],
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Compare"
      title="Compare subscription billing software"
      description="Two Minute Billing next to seven billing platforms. The biggest differences are how each one is priced, who is the seller, and whether you can run it yourself. Each page also says when the other product is the better fit."
      :secondary="{ label: 'See pricing', to: '/pricing' }"
      :note="`We make Two Minute Billing. Last updated ${COMPARE_UPDATED_LABEL}.`"
    />

    <section class="py-16 lg:py-24">
      <UContainer>
        <div class="max-w-3xl">
          <h2 class="mk-h2 text-highlighted">The key difference, product by product</h2>
          <p class="mt-4 text-[1.0625rem] leading-relaxed text-pretty text-muted">
            Select a product to see the full comparison: price, hidden costs, features, and when it
            is the better fit.
          </p>
        </div>
        <ul class="mt-10 divide-y divide-default rounded-lg border border-default">
          <li v-for="c in comparisons" :key="c.slug">
            <NuxtLink
              :to="`/compare/${c.slug}`"
              class="group grid gap-2 px-5 py-5 hover:bg-elevated/50 sm:grid-cols-[14rem_1fr_auto] sm:items-center sm:gap-6 sm:px-6"
            >
              <span class="font-medium text-highlighted">{{ c.name }}</span>
              <span class="text-sm leading-relaxed text-muted">{{ c.difference }}</span>
              <span class="inline-flex items-center gap-1 text-sm font-medium text-primary">
                Compare
                <UIcon
                  name="i-lucide-arrow-right"
                  class="size-4 transition-transform group-hover:translate-x-0.5"
                />
              </span>
            </NuxtLink>
          </li>
        </ul>
      </UContainer>
    </section>

    <section class="mk-tint py-16 lg:py-24">
      <UContainer>
        <div class="max-w-3xl">
          <h2 class="mk-h2 text-highlighted">The eight at a glance</h2>
          <p class="mt-4 text-[1.0625rem] leading-relaxed text-pretty text-muted">
            From each product's public pricing pages and docs, as of {{ COMPARE_CHECKED_LABEL }}.
          </p>
        </div>
        <div class="mt-10 overflow-x-auto rounded-lg border border-default bg-default">
          <table class="w-full min-w-[52rem] text-left text-sm">
            <caption class="sr-only">
              Subscription billing platforms compared on price, fees on revenue, seller, gateways
              and self-hosting, as of
              {{
                COMPARE_CHECKED_LABEL
              }}
            </caption>
            <thead>
              <tr class="border-b border-default text-highlighted">
                <th scope="col" class="px-5 py-4 font-semibold">Product</th>
                <th scope="col" class="px-5 py-4 font-semibold">Price</th>
                <th scope="col" class="px-5 py-4 font-semibold">Fee on your revenue</th>
                <th scope="col" class="px-5 py-4 font-semibold">Seller</th>
                <th scope="col" class="px-5 py-4 font-semibold">Gateways</th>
                <th scope="col" class="px-5 py-4 font-semibold">Self-host</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr class="align-top">
                <th scope="row" class="px-5 py-3.5 font-medium text-highlighted">
                  <ULink
                    to="/pricing"
                    raw
                    class="inline-flex items-center gap-2 underline-offset-4 hover:text-primary hover:underline"
                  >
                    <span class="mk-mark size-4!" aria-hidden="true" />
                    Two Minute Billing
                  </ULink>
                </th>
                <td class="px-5 py-3.5 text-toned">
                  Free plan under {{ freeBand }} a month, then a flat monthly price
                </td>
                <td class="px-5 py-3.5 text-toned">0%</td>
                <td class="px-5 py-3.5 text-toned">You</td>
                <td class="px-5 py-3.5 text-toned">11, on your own accounts</td>
                <td class="px-5 py-3.5 text-toned">Yes, free (AGPL-3.0)</td>
              </tr>
              <tr v-for="c in comparisons" :key="c.slug" class="align-top">
                <th scope="row" class="px-5 py-3.5 font-medium text-highlighted">
                  <ULink
                    :to="`/compare/${c.slug}`"
                    raw
                    class="underline-offset-4 hover:text-primary hover:underline"
                  >
                    {{ c.name }}
                  </ULink>
                </th>
                <td class="px-5 py-3.5 text-toned">{{ c.hub.price }}</td>
                <td class="px-5 py-3.5 text-toned">{{ c.hub.fee }}</td>
                <td class="px-5 py-3.5 text-toned">{{ c.hub.seller }}</td>
                <td class="px-5 py-3.5 text-toned">{{ c.hub.gateways }}</td>
                <td class="px-5 py-3.5 text-toned">Not listed</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="mt-4 text-xs text-muted">
          "Not listed": the product's public pages we checked list no self-hosted or open-source
          edition. Gateway counts are as each product states them, or as its docs list them.
        </p>
      </UContainer>
    </section>

    <section class="py-12 lg:py-16">
      <UContainer>
        <div class="max-w-3xl space-y-2 text-xs leading-relaxed text-muted">
          <p>
            Last updated {{ COMPARE_UPDATED_LABEL }}. Facts checked on {{ COMPARE_CHECKED_LABEL }}.
          </p>
          <p>How we compare: {{ COMPARE_METHOD }}</p>
          <p>
            We make Two Minute Billing, so we are not neutral. Product names on these pages are
            trademarks of their owners and are named only to compare. Something changed?
            <ULink to="/contact" class="text-primary underline">Tell us</ULink>.
          </p>
        </div>
      </UContainer>
    </section>

    <MkCta
      title="Try it in test mode"
      accent="test mode"
      :description="`Sign up free, connect a test gateway and bill a test customer. Free while you bill less than ${freeBand} a month. Or self-host the open-source engine.`"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />
  </div>
</template>
