<script setup lang="ts">
// ::in-short — the summary box near the top of a blog post: a short list of the answers.
</script>

<template>
  <aside class="mk-in-short" aria-label="In short">
    <p class="mk-in-short-title">In short</p>
    <slot />
  </aside>
</template>

<style scoped>
.mk-in-short {
  margin-block: 1.75rem;
  padding: 1.25rem 1.5rem;
  border-radius: 0.75rem;
  background: var(--mk-tint);
  border: 1px solid var(--ui-border);
  font-size: 0.9375rem;
  line-height: 1.7;
}
.mk-in-short-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.mk-in-short :deep(ul) {
  margin: 0.625rem 0 0;
}
.mk-in-short :deep(li) {
  margin-block: 0.25rem;
}
</style>
