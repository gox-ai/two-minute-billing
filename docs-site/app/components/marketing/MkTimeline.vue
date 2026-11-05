<script setup lang="ts">
/** Numbered steps in a row on wide screens, stacked on a phone. */
const props = defineProps<{
  steps: { when: string; what: string; detail?: string }[];
}>();

// Literal class strings, so Tailwind sees every one of them.
const COLS: Record<number, string> = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-2 lg:grid-cols-4",
  5: "md:grid-cols-3 lg:grid-cols-5",
};
const cols = computed(() => COLS[props.steps.length] ?? "md:grid-cols-3");
</script>

<template>
  <ol class="grid gap-4" :class="cols">
    <li
      v-for="s in steps"
      :key="s.when"
      class="rounded-[14px] border border-default bg-default p-5"
    >
      <div class="text-xs font-medium tracking-wide text-primary uppercase">{{ s.when }}</div>
      <p class="mt-2 text-sm font-medium text-highlighted">{{ s.what }}</p>
      <p v-if="s.detail" class="mt-2 text-sm text-muted">{{ s.detail }}</p>
    </li>
  </ol>
</template>
