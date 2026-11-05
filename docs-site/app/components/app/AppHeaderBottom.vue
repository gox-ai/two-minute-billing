<script setup lang="ts">
/**
 * Docs tabs. Overrides Docus's, which builds tabs from top-level sections — and all our docs
 * sit under one section, /help. The left sidebar (DocsAsideLeftBody) follows the same split.
 */
const route = useRoute();
const cloud = useRuntimeConfig().public.edition === "cloud";
const p = computed(() => route.path);
const isRef = computed(() => p.value.startsWith("/help/developers/api-reference"));
const isDev = computed(() => !isRef.value && p.value.startsWith("/help/developers"));
const items = computed(() => [
  {
    label: "Guides",
    icon: "i-lucide-book-open",
    to: "/help/getting-started",
    active: !isDev.value && !isRef.value,
  },
  { label: "Developers", icon: "i-lucide-code", to: "/help/developers", active: isDev.value },
  {
    label: "API reference",
    icon: "i-lucide-braces",
    to: "/help/developers/api-reference",
    active: isRef.value,
  },
  // A marketing page: Cloud only.
  ...(cloud ? [{ label: "Changelog", icon: "i-lucide-sparkles", to: "/changelog" }] : []),
]);
</script>

<template>
  <USeparator class="hidden lg:flex" />
  <UContainer class="hidden items-center lg:flex">
    <UNavigationMenu :items="items" highlight variant="pill" class="-mx-2.5 -mb-px" />
  </UContainer>
</template>
