<script setup lang="ts">
/**
 * "Why it matters", in money terms. A card leads with a figure only when a buyer would weigh
 * it (a price share, a gateway count, an endpoint count): a product fact or plain arithmetic,
 * never a market statistic. Otherwise it leads with its title, and no figure is made up.
 */
interface Item {
  figure?: string;
  label: string;
  body: string;
}

defineProps<{
  kicker?: string;
  title: string;
  description?: string;
  items: Item[];
}>();
</script>

<template>
  <section class="py-16 lg:py-24">
    <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl">
        <h2 class="mk-h2 text-highlighted">
          {{ title }}
        </h2>
        <p v-if="description" class="mt-4 text-[1.0625rem] leading-relaxed text-pretty text-muted">
          {{ description }}
        </p>
      </div>
      <div
        class="mt-10 grid gap-4"
        :class="items.length === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'md:grid-cols-3'"
      >
        <div v-for="i in items" :key="i.label" class="wy-card mk-surface p-6">
          <template v-if="i.figure">
            <div
              class="text-[2.5rem] leading-none font-light tracking-[-0.045em] text-highlighted tabular-nums"
            >
              {{ i.figure }}
            </div>
            <div class="mt-3 font-medium text-highlighted">{{ i.label }}</div>
          </template>
          <h3 v-else class="text-lg leading-snug font-medium text-highlighted">
            {{ i.label }}
          </h3>
          <p class="mt-1.5 text-sm leading-relaxed text-muted">{{ i.body }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wy-card {
  border-top: 1px solid var(--ui-border);
}
</style>
