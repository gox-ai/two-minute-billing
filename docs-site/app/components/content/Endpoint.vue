<script setup lang="ts">
/**
 * An endpoint signature: `::endpoint{method="POST" path="/v1/…"}`.
 *
 * Replaces the plain ```text fence the generator used to emit. A method is the
 * first thing a reader looks for on an API page, and a fenced code block gives it
 * no more weight than a curl example — so the verb gets a colour and the path gets
 * room to break on a phone without a horizontal scrollbar.
 */
const props = defineProps<{ method: string; path: string }>();

const VERB_COLOR: Record<string, string> = {
  GET: "var(--verb-get)",
  POST: "var(--verb-post)",
  PUT: "var(--verb-put)",
  PATCH: "var(--verb-patch)",
  DELETE: "var(--verb-delete)",
};

const verb = computed(() => props.method.toUpperCase());
const color = computed(() => VERB_COLOR[verb.value] ?? "var(--ui-text-muted)");
</script>

<template>
  <div class="tm-endpoint">
    <span class="tm-verb" :style="{ color }">{{ verb }}</span>
    <code class="tm-path">{{ path }}</code>
  </div>
</template>

<style scoped>
.tm-endpoint {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin: 1.25rem 0;
  padding: 0.65rem 0.9rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  background: var(--ui-bg-muted);
}
.tm-verb {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}
.tm-path {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.85rem;
  color: var(--ui-text);
  background: transparent;
  padding: 0;
  /* A long path must wrap rather than scroll the page sideways on a phone. */
  overflow-wrap: anywhere;
}
</style>
