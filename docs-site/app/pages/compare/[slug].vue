<script setup lang="ts">
/**
 * One "<product> alternative" page, from utils/compare.ts. Every claim about the other product
 * is sourced in docs/references/COMPARISON_SOURCES.md (the page shows no source links); this
 * template adds no claim of its own. Our paid prices come from the catalogue (/api/plans).
 */
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import type { SchemaOffer } from "~/composables/useMarketingSeo";

definePageMeta({ layout: "marketing", header: false, footer: false });

const route = useRoute();
const found = findComparison(String(route.params.slug));
if (!found) throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
const freeBand = await useFreeBand();
const c = fillFreeBand(found, freeBand.value);

const { signUp } = useAppLinks();
const { data: plans } = await useFetch("/api/plans", { key: "plans" });

const fmt = (minor: number, currency: string) =>
  new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);

/** The lowest paid monthly price in the visitor's currency, or nothing if the catalogue is down. */
const fromPrice = computed(() => {
  const cur = plans.value?.preferred ?? "USD";
  const monthly = (plans.value?.plans ?? []).filter(
    (p) => p.currency === cur && p.interval === "month" && p.amountMinor > 0,
  );
  const low = monthly.sort((a, b) => a.amountMinor - b.amountMinor)[0];
  return low ? fmt(low.amountMinor, low.currency) : undefined;
});

/** Our cost lines, with the lowest paid price after the flat-price line when the catalogue has one. */
const ourCosts = computed(() => {
  const lines = fillFreeBand(COMPARE_OUR_COSTS, freeBand.value);
  if (!fromPrice.value) return lines;
  return [
    ...lines.slice(0, 2),
    `Paid Cloud plans start at ${fromPrice.value} a month.`,
    ...lines.slice(2),
  ];
});

/** The same offers /pricing lists, so the SoftwareApplication node cannot drift. No ratings. */
const offers = computed<SchemaOffer[]>(() => {
  const cur = plans.value?.preferred ?? "USD";
  const free = (plans.value?.free ?? []).find((p) => p.currency === cur);
  return [
    {
      name: "Free plan",
      price: "0",
      priceCurrency: cur,
      description: free?.description ?? "Every feature in live mode. No credit card required.",
    },
    ...(plans.value?.plans ?? [])
      .filter((p) => p.amountMinor > 0 && p.currency === cur)
      .map((p) => ({
        name: `${p.name}, billed ${p.interval === "year" ? "yearly" : "monthly"}`,
        price: (p.amountMinor / 100).toFixed(2),
        priceCurrency: p.currency,
        billingDuration: p.interval === "year" ? ("P1Y" as const) : ("P1M" as const),
      })),
  ];
});

useMarketingSeo({
  title: c.title,
  crumb: c.eyebrow,
  parents: [{ name: "Compare", path: "/compare" }],
  description: c.description,
  og: c.og,
  faq: c.faq,
  offers,
});
</script>

<template>
  <div>
    <MkPageHero
      :eyebrow="c.eyebrow"
      :title="c.h1"
      :description="c.intro"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
      :note="`We make Two Minute Billing. Last updated ${COMPARE_UPDATED_LABEL}.`"
    >
      <div class="rounded-lg border border-default bg-default p-6">
        <p class="mk-label">At a glance</p>
        <table class="mt-4 w-full text-sm">
          <thead>
            <tr class="text-xs text-muted">
              <th class="pb-2 text-left font-normal"><span class="sr-only">Topic</span></th>
              <th class="pb-2 pr-3 text-left font-semibold text-highlighted">Two Minute Billing</th>
              <th class="pb-2 text-left font-normal">{{ c.name }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="g in c.glance" :key="g.label" class="align-top">
              <th scope="row" class="py-2.5 pr-3 text-left font-normal text-muted">
                {{ g.label }}
              </th>
              <td class="py-2.5 pr-3 font-medium text-highlighted">{{ g.us }}</td>
              <td class="py-2.5 text-toned">{{ g.them }}</td>
            </tr>
          </tbody>
        </table>
        <p class="mt-4 text-xs text-muted">
          {{ c.name }} facts from its public pages, as of {{ COMPARE_CHECKED_LABEL }}.
        </p>
      </div>
    </MkPageHero>

    <!-- Feature and pricing matrix: a real table so extractors keep it; it stacks below sm. -->
    <section class="py-16 lg:py-24">
      <UContainer>
        <div class="max-w-3xl">
          <h2 class="mk-h2 text-highlighted">Two Minute Billing vs {{ c.name }}</h2>
          <p class="mt-4 text-[1.0625rem] leading-relaxed text-pretty text-muted">
            Price, fees and features, side by side. {{ c.name }} facts come from its own pricing
            pages and docs, as of {{ COMPARE_CHECKED_LABEL }}.
          </p>
        </div>
        <table class="mt-10 block w-full overflow-hidden rounded-lg border border-default">
          <caption class="sr-only">
            Two Minute Billing compared with
            {{
              c.name
            }}, as of
            {{
              COMPARE_CHECKED_LABEL
            }}
          </caption>
          <thead class="hidden sm:block">
            <tr
              class="border-b border-default px-6 py-4 text-sm font-semibold text-highlighted sm:grid sm:grid-cols-[12rem_1fr_1fr] sm:gap-6"
            >
              <th scope="col" class="text-left font-semibold">
                <span class="sr-only">Topic</span>
              </th>
              <th scope="col" class="flex items-center gap-2 text-left font-semibold">
                <span class="mk-mark size-5!" aria-hidden="true" />
                Two Minute Billing
              </th>
              <th scope="col" class="text-left font-semibold">{{ c.name }}</th>
            </tr>
          </thead>
          <tbody class="block">
            <tr
              v-for="r in c.rows"
              :key="r.label"
              class="grid gap-2 border-b border-default px-5 py-4 last:border-b-0 sm:grid-cols-[12rem_1fr_1fr] sm:gap-6 sm:px-6"
            >
              <th scope="row" class="text-left text-sm font-semibold text-highlighted">
                <ULink
                  v-if="COMPARE_ROW_LINKS[r.label]"
                  :to="COMPARE_ROW_LINKS[r.label]"
                  raw
                  class="underline-offset-4 hover:text-primary hover:underline"
                >
                  {{ r.label }}
                </ULink>
                <template v-else>{{ r.label }}</template>
              </th>
              <td class="text-sm leading-relaxed text-toned">
                <span class="mb-0.5 block text-xs font-medium text-muted sm:hidden">
                  Two Minute Billing
                </span>
                {{ r.us }}
              </td>
              <td class="text-sm leading-relaxed text-muted">
                <span class="mb-0.5 block text-xs font-medium text-dimmed sm:hidden">
                  {{ c.name }}
                </span>
                {{ r.them }}
              </td>
            </tr>
          </tbody>
        </table>
        <div class="mt-8 flex flex-wrap gap-3">
          <UButton :to="signUp" size="xl" trailing-icon="i-lucide-arrow-up-right">
            Start for free
          </UButton>
          <UButton to="/pricing" size="xl" color="neutral" variant="outline">See pricing</UButton>
        </div>
      </UContainer>
    </section>

    <!-- Pricing, with the costs that are easy to miss. -->
    <section class="mk-tint py-16 lg:py-24">
      <UContainer>
        <div class="max-w-3xl">
          <h2 class="mk-h2 text-highlighted">What each one costs</h2>
          <p class="mt-4 text-[1.0625rem] leading-relaxed text-pretty text-muted">
            Every fee we could find on each product's public pages, including fees on revenue, fees
            per transaction and minimums.
          </p>
        </div>
        <div class="mt-10 grid gap-4 lg:grid-cols-2">
          <div class="rounded-lg border border-default bg-default p-6 sm:p-8">
            <h3 class="mk-h3 text-highlighted">Two Minute Billing</h3>
            <ul class="mt-5 space-y-3">
              <li v-for="item in ourCosts" :key="item" class="flex gap-2 text-sm text-toned">
                <UIcon name="i-lucide-check" class="mt-0.5 size-4 shrink-0 text-success" />
                {{ item }}
              </li>
            </ul>
            <ULink
              to="/pricing"
              class="mt-6 inline-block text-sm font-medium text-primary underline"
            >
              See the plans in your currency
            </ULink>
          </div>
          <div class="rounded-lg border border-default bg-default p-6 sm:p-8">
            <h3 class="mk-h3 text-highlighted">{{ c.name }}</h3>
            <ul class="mt-5 space-y-3">
              <li v-for="item in c.costs" :key="item.text" class="flex gap-2 text-sm text-toned">
                <UIcon name="i-lucide-receipt" class="mt-0.5 size-4 shrink-0 text-dimmed" />
                <span>
                  {{ item.text }}
                </span>
              </li>
            </ul>
            <p class="mt-6 text-xs text-muted">
              From {{ c.name }}'s public pages, as of {{ COMPARE_CHECKED_LABEL }}.
            </p>
          </div>
        </div>
      </UContainer>
    </section>

    <!-- Fit: when we suit you, and when the other product is the better fit. -->
    <section class="py-16 lg:py-24">
      <UContainer class="grid gap-12 lg:grid-cols-2">
        <div>
          <h2 class="mk-h2 text-highlighted">When Two Minute Billing fits</h2>
          <ul class="mt-6 space-y-3">
            <li v-for="s in c.fit.us" :key="s" class="flex gap-2 text-toned">
              <UIcon name="i-lucide-check" class="mt-1 size-4 shrink-0 text-success" />
              {{ s }}
            </li>
          </ul>
        </div>
        <div>
          <h2 class="mk-h2 text-highlighted">When {{ c.name }} is the better fit</h2>
          <ul class="mt-6 space-y-3">
            <li v-for="s in c.fit.them" :key="s" class="flex gap-2 text-toned">
              <UIcon name="i-lucide-arrow-right" class="mt-1 size-4 shrink-0 text-(--mk-plain)" />
              {{ s }}
            </li>
          </ul>
        </div>
      </UContainer>
    </section>

    <section class="border-t border-default py-16 lg:py-24">
      <UContainer class="grid gap-12 lg:grid-cols-2">
        <div>
          <h2 class="mk-h2 text-highlighted">What to plan for</h2>
          <p class="mt-4 text-muted">Our limits against {{ c.name }}, said up front.</p>
          <ul class="mt-6 space-y-3">
            <li v-for="m in c.cons" :key="m" class="flex gap-2 text-toned">
              <UIcon name="i-lucide-minus" class="mt-1 size-4 shrink-0 text-dimmed" />
              {{ m }}
            </li>
          </ul>
        </div>
        <div>
          <h2 class="mk-h2 text-highlighted">Moving from {{ c.name }}</h2>
          <p class="mt-4 leading-relaxed text-toned">{{ c.moving }}</p>
          <ULink to="/contact" class="mt-5 inline-block text-sm font-medium text-primary underline">
            Talk to our team
          </ULink>
        </div>
      </UContainer>
    </section>

    <MkFaq :items="c.faq" />

    <MkCta
      title="Try it in test mode"
      accent="test mode"
      :description="`${c.verdict} Sign up free, connect a test gateway and bill a test customer.`"
      :primary="{ label: 'Start for free', to: signUp }"
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />

    <!-- Related comparisons, the date, the method and who wrote this. -->
    <section class="border-t border-default py-12 lg:py-16">
      <UContainer>
        <h2 class="mk-h3 text-highlighted">All comparisons</h2>
        <nav aria-label="All comparisons" class="mt-6">
          <ul class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <li>
              <ULink
                to="/compare"
                class="text-toned underline-offset-4 hover:text-primary hover:underline"
              >
                Compare all billing software
              </ULink>
            </li>
            <li v-for="l in COMPARE" :key="l.to">
              <span
                v-if="l.to === route.path"
                class="font-medium text-highlighted"
                aria-current="page"
              >
                {{ l.label }}
              </span>
              <ULink
                v-else
                :to="l.to"
                class="text-toned underline-offset-4 hover:text-primary hover:underline"
              >
                {{ l.label }}
              </ULink>
            </li>
          </ul>
        </nav>
        <div class="mt-10 max-w-3xl space-y-2 text-xs leading-relaxed text-muted">
          <p>
            Last updated {{ COMPARE_UPDATED_LABEL }}. {{ c.name }} facts checked on
            {{ COMPARE_CHECKED_LABEL }}.
          </p>
          <p>How we compare: {{ COMPARE_METHOD }}</p>
          <p>
            We make Two Minute Billing, so we are not neutral. {{ c.trademark }} Something changed?
            <ULink to="/contact" class="text-primary underline">Tell us</ULink>.
          </p>
        </div>
      </UContainer>
    </section>
  </div>
</template>
