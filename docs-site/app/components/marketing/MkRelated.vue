<script setup lang="ts">
/** The rest of the product, read from the site map, so every product page links to the others. */
import { toneClass } from "~/utils/tone";

const props = defineProps<{ title?: string; links?: SiteLink[] }>();

const route = useRoute();
const items = computed(() => (props.links ?? PRODUCT).filter((l) => l.to !== route.path));
</script>

<template>
  <UPageSection :title="title ?? 'More of the product'" class="mk-tint border-t border-default">
    <UPageGrid>
      <UPageCard
        v-for="l in items"
        :key="l.to"
        :class="toneClass(l.to)"
        :to="l.to"
        :icon="l.icon"
        :title="l.label"
        :description="l.description"
        variant="outline"
        class="bg-default"
      />
    </UPageGrid>
  </UPageSection>
</template>
