<script setup lang="ts">
/**
 * The public changelog: the same notes customers read in the dashboard's What's New, generated
 * into `data/releases.json` by `scripts/gen-changelog.ts` before each build.
 */
import releases from "../../data/releases.json";

definePageMeta({ layout: "marketing", header: false, footer: false });

const TONE: Record<string, "success" | "info" | "warning" | "neutral"> = {
  Feature: "neutral",
  Improvement: "info",
  Fix: "success",
  Performance: "neutral",
  Security: "warning",
};

const fmt = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

useMarketingSeo({
  title: "Changelog: product updates",
  crumb: "Changelog",
  description:
    "Every Two Minute Billing release, newest first: new features, improvements, fixes and security updates to subscription billing, invoicing and payments.",
  og: {
    headline: "Changelog",
    title: "What shipped in Two Minute Billing",
    description: "New features, improvements and fixes, newest first.",
  },
});
</script>

<template>
  <div>
    <section class="mk-hero border-b border-default">
      <UContainer class="py-12 lg:py-14">
        <p class="mk-kicker mb-4">Changelog</p>
        <h1 class="text-4xl font-semibold text-highlighted sm:text-5xl">
          What is new in Two Minute Billing
        </h1>
        <p class="mt-5 max-w-2xl text-lg text-muted">
          What shipped, newest first. The same notes appear in the dashboard under What's new.
        </p>
      </UContainer>
    </section>

    <UContainer class="py-10 lg:py-12">
      <ol class="mx-auto max-w-3xl space-y-10">
        <li
          v-for="r in releases"
          :id="r.slug"
          :key="r.slug"
          class="grid gap-3 border-b border-default pb-12 last:border-0 md:grid-cols-[10rem_1fr] md:gap-8"
        >
          <div class="text-sm text-muted">
            <time :datetime="r.date">{{ fmt(r.date) }}</time>
          </div>
          <article>
            <div class="flex flex-wrap items-center gap-2">
              <UBadge
                :color="TONE[r.type] ?? 'neutral'"
                variant="subtle"
                :class="{ 'mk-badge-new': r.type === 'Feature' }"
                >{{ r.type }}</UBadge
              >
              <UBadge v-for="t in r.tags" :key="t" color="neutral" variant="outline">{{
                t
              }}</UBadge>
            </div>
            <h2 class="mt-3 text-xl font-medium text-highlighted">
              <a :href="`#${r.slug}`" class="hover:underline">{{ r.title }}</a>
            </h2>
            <!-- Notes are written with ## headings; they sit under the release's own h2. -->
            <MDC
              :value="r.body.replace(/^## /gm, '### ')"
              class="prose-sm mt-3 break-words text-toned [&_code]:break-all [&_li]:mt-1 [&_ul]:list-disc [&_ul]:pl-5 [&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-highlighted"
            />
          </article>
        </li>
      </ol>
    </UContainer>
  </div>
</template>
