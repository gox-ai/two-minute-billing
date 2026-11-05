<script setup lang="ts">
/** Footer for the marketing pages, from the same site map as the header, plus the comparisons. */
import MkLogo from "~/components/marketing/MkLogo.vue";

interface FooterLink {
  label: string;
  to: string;
  target?: string;
  /** Not a page: the router must not take it (the RSS feed). */
  external?: boolean;
}

const repo = useRepoUrl();
const cookies = useCookieConsent();
const columns: { label: string; children: FooterLink[] }[] = [
  {
    label: "Product",
    children: [
      { label: "Overview", to: "/product" },
      ...PRODUCT.map(({ label, to }) => ({ label, to })),
    ],
  },
  { label: "Solutions", children: SOLUTIONS.map(({ label, to }) => ({ label, to })) },
  {
    label: "Developers",
    children: [
      ...DEVELOPERS.map(({ label, to }) => ({ label, to })),
      ...(repo ? [{ label: "GitHub", to: repo, target: "_blank" }] : []),
    ],
  },
  {
    label: "Company",
    children: [
      ...COMPANY.map(({ label, to }) => ({ label, to })),
      { label: "RSS feed", to: "/blog/rss.xml", external: true },
    ],
  },
];
</script>

<template>
  <footer class="relative overflow-hidden border-t border-muted bg-default">
    <UContainer class="flex flex-wrap justify-between gap-12 pt-16 pb-10">
      <div class="min-w-0 flex-[1_1_300px]">
        <NuxtLink to="/" class="inline-flex">
          <MkLogo class="h-14" />
        </NuxtLink>
        <p class="mt-4 max-w-sm text-lg leading-normal text-muted">
          Subscription billing on the gateway you already use. Run it on our Cloud, or self-host it.
        </p>
        <UButton
          v-if="repo"
          :to="repo"
          target="_blank"
          icon="i-simple-icons-github"
          color="neutral"
          variant="outline"
          size="lg"
          aria-label="Two Minute Billing on GitHub"
          class="mt-5 max-sm:size-11 max-sm:justify-center"
        />
      </div>
      <nav
        aria-label="Footer"
        class="grid flex-[2_1_560px] grid-cols-2 gap-8 text-[0.9375rem] sm:grid-cols-4"
      >
        <div v-for="col in columns" :key="col.label">
          <div class="text-sm font-medium text-highlighted">{{ col.label }}</div>
          <ul class="mt-3.5 flex flex-col gap-0.5">
            <li v-for="l in col.children" :key="l.label">
              <ULink :to="l.to" :target="l.target" :external="l.external" class="mk-foot-link">{{
                l.label
              }}</ULink>
            </li>
          </ul>
        </div>
      </nav>
    </UContainer>
    <UContainer class="pb-10">
      <nav aria-label="Comparisons" class="border-t border-muted pt-6 text-[0.9375rem]">
        <ULink to="/compare" class="text-sm font-medium text-highlighted"> Compare </ULink>
        <ul class="mt-3.5 flex flex-wrap gap-x-6 gap-y-0.5">
          <li v-for="l in COMPARE" :key="l.to">
            <ULink :to="l.to" class="mk-foot-link">{{ l.label }}</ULink>
          </li>
        </ul>
      </nav>
    </UContainer>
    <UContainer class="flex items-center justify-between gap-4 pb-6 text-sm text-muted">
      <p>© {{ new Date().getFullYear() }} Two Minute Billing</p>
      <div class="flex items-center gap-4">
        <button v-if="cookies.enabled" type="button" class="mk-foot-link" @click="cookies.show()">
          Cookie settings
        </button>
        <UColorModeButton class="max-sm:size-11 max-sm:justify-center" />
      </div>
    </UContainer>
  </footer>
</template>

<style scoped>
/* 4px above and below make each link a 27px target; the list gap shrank by the same 8px. */
.mk-foot-link {
  display: inline-block;
  padding-block: 0.25rem;
  color: var(--ui-text-toned);
  transition: color 0.15s ease;
}
.mk-foot-link:hover {
  color: var(--ui-primary);
}
</style>
