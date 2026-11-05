<script setup lang="ts">
/**
 * One API endpoint, two panes: `::api-operation{method path}` with `#docs`,
 * `#request` and `#response` slots (written by scripts/gen-api-reference.ts).
 *
 * Prose and parameter tables sit left; the curl request and the JSON responses sit
 * in a right pane that stays in view while the reader scrolls the fields. Code
 * blocks are ordinary MDC fences, so highlighting, copy buttons and status tabs
 * (`code-group`) come from the prose components and follow the colour mode.
 *
 * The switch is a CONTAINER query, not a viewport one: the column this renders in
 * changes width with the sidebar, so only its own width says whether two panes fit.
 */
defineProps<{ method: string; path: string }>();
</script>

<template>
  <div class="tm-op">
    <div class="tm-op-grid">
      <div class="tm-op-docs">
        <Endpoint :method="method" :path="path" />
        <slot name="docs" />
      </div>
      <aside class="tm-op-examples" aria-label="Example request and response">
        <div class="tm-op-sticky">
          <p class="tm-op-label">Request</p>
          <slot name="request" />
          <template v-if="$slots.response">
            <p class="tm-op-label">Response</p>
            <slot name="response" />
          </template>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.tm-op {
  container-type: inline-size;
}
.tm-op-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1.5rem;
}
.tm-op-docs,
.tm-op-examples {
  min-width: 0;
}
.tm-op-label {
  margin: 1rem 0 0.4rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ui-text-muted);
}
.tm-op-sticky > .tm-op-label:first-child {
  margin-top: 0;
}
/* Long JSON scrolls inside its block, never the page. */
.tm-op-examples :deep(pre) {
  max-height: 32rem;
  overflow: auto;
}
.tm-op-examples :deep(div:has(> pre)),
.tm-op-examples :deep([role="tablist"]) + * {
  margin-top: 0;
}

@container (min-width: 760px) {
  .tm-op-grid {
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
    gap: 2rem;
  }
  .tm-op-sticky {
    position: sticky;
    top: calc(var(--ui-header-height, 4rem) + 1.25rem);
    max-height: calc(100vh - var(--ui-header-height, 4rem) - 2.5rem);
    overflow-y: auto;
    padding-bottom: 1rem;
  }
}
</style>

<style>
/*
 * An endpoint page has no table of contents (its headings live in a slot), so the
 * page's empty right rail is handed to the two panes. Scoped to the inner UPage —
 * the one with a right rail and no left — that holds an operation.
 */
@media (min-width: 1024px) {
  [data-slot="root"]:has(> [data-slot="right"]):not(:has(> [data-slot="left"])):has(.tm-op)
    > [data-slot="center"] {
    grid-column: span 10 / span 10;
  }
  [data-slot="root"]:has(> [data-slot="right"]):not(:has(> [data-slot="left"])):has(.tm-op)
    > [data-slot="right"] {
    display: none;
  }
}
</style>
