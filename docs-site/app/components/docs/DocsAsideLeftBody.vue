<script setup lang="ts">
/** The sidebar shows only the active docs tab: guides, developer docs, or the API reference. */
import type { ContentNavigationItem } from "@nuxt/content";

const { sidebarNavigation } = useSubNavigation();
const route = useRoute();

const REF = "/help/developers/api-reference";
const DEV = "/help/developers";

const navigation = computed<ContentNavigationItem[]>(() => {
  // Docus hands us either the /help section's children or the whole tree with /help as its one
  // root; descend into /help so both shapes split the same way.
  const top = sidebarNavigation.value ?? [];
  const help = top.length === 1 && top[0]?.path === "/help" ? top[0] : undefined;
  const all = help?.children ?? top;
  const dev = all.find((n) => n.path === DEV);
  if (route.path.startsWith(REF)) {
    const ref = dev?.children?.find((n) => n.path === REF);
    return ref?.children ?? [];
  }
  if (route.path.startsWith(DEV)) return (dev?.children ?? []).filter((n) => n.path !== REF);
  return all.filter((n) => n.path !== DEV);
});
</script>

<template>
  <UContentNavigation :collapsible="false" highlight variant="link" :navigation="navigation" />
</template>
