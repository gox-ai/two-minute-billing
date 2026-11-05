<script setup lang="ts">
/**
 * A post's cover, 1200×630 in proportion: the category, a big title and one invoice-like card
 * with an oversized key value. Every size is in container units, so the cover scales with its
 * width (the featured card, the post header). The social card is the same design
 * (OgImage/BlogCover.takumi.vue).
 */
import MkLogo from "~/components/marketing/MkLogo.vue";

export interface BlogCoverData {
  tone: string;
  coverTitle: string;
  cardLabel: string;
  rows: { label: string; amount: string }[];
  value: string;
  pill: string;
}

const props = defineProps<{ cover: BlogCoverData; category: string }>();

const label = computed(() => {
  const c = props.cover;
  const rows = c.rows.map((r) => `${r.label} ${r.amount}`).join(", ");
  return `Cover: ${c.coverTitle}. ${c.cardLabel}: ${rows}. ${c.value}, ${c.pill}.`;
});

// The card is ~27cqw wide inside; a long value ("$10,849.00") shrinks to fit, short ones stay 6cqw.
const valueSize = computed(
  () => `${Math.min(6, 26 / (props.cover.value.length * 0.58)).toFixed(2)}cqw`,
);
</script>

<template>
  <div role="img" :aria-label="label" class="bc" :class="blogToneClass(cover.tone)">
    <div class="bc-copy">
      <div class="bc-kicker">{{ category }}</div>
      <div class="bc-title">{{ cover.coverTitle }}</div>
    </div>
    <div class="bc-card">
      <div class="bc-card-label">{{ cover.cardLabel }}</div>
      <div v-for="(r, i) in cover.rows" :key="i" class="bc-row">
        <span>{{ r.label }}</span
        ><span>{{ r.amount }}</span>
      </div>
      <div class="bc-rule" />
      <div class="bc-value" :style="{ fontSize: valueSize }">{{ cover.value }}</div>
      <div class="bc-pill">
        <UIcon name="i-lucide-check" class="bc-pill-icon" />
        {{ cover.pill }}
      </div>
    </div>
    <div class="bc-brand">
      <MkLogo class="bc-logo" />
      <span class="bc-sep" />
      <span>Blog</span>
    </div>
  </div>
</template>

<style scoped>
.bc {
  position: relative;
  overflow: hidden;
  container-type: inline-size;
  aspect-ratio: 1200 / 630;
  width: 100%;
  border-radius: 0.75rem;
  border: 1px solid var(--mk-mark-line);
  background: color-mix(in oklab, var(--mk-mark-soft) 55%, var(--mk-canvas));
  color: var(--ui-text-highlighted);
  font-variant-numeric: tabular-nums;
}
/* The faint dot grid of the site's illustrations. */
.bc::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: radial-gradient(
    color-mix(in oklab, var(--ui-text-highlighted) 8%, transparent) 1px,
    transparent 1px
  );
  background-size: 1.85cqw 1.85cqw;
}
.bc-copy {
  position: absolute;
  left: 6.7%;
  top: 14%;
  width: 43%;
}
.bc-kicker {
  font-size: 1.85cqw;
  font-weight: 600;
  color: var(--mk-mark-text);
}
.bc-title {
  margin-top: 1.8cqw;
  font-size: 5cqw;
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -0.03em;
  text-wrap: balance;
}
.bc-card {
  position: absolute;
  right: 7.5%;
  top: 19%;
  width: 33.3%;
  padding: 2.7cqw 2.8cqw;
  border-radius: 1.8cqw;
  background: var(--mk-card);
  border: 1px solid var(--ui-border);
  box-shadow: 0 1.5cqw 4cqw rgb(16 24 40 / 0.1);
}
.bc-card-label {
  font-size: 1.5cqw;
  color: var(--ui-text-dimmed);
}
.bc-row {
  display: flex;
  justify-content: space-between;
  gap: 1cqw;
  margin-top: 0.9cqw;
  font-size: 1.6cqw;
  color: var(--ui-text-muted);
}
.bc-card-label + .bc-row {
  margin-top: 1.8cqw;
}
.bc-rule {
  height: 1px;
  margin-block: 1.5cqw 1cqw;
  background: var(--ui-border);
}
.bc-value {
  font-size: 6cqw;
  line-height: 1.1;
  white-space: nowrap;
  font-weight: 600;
  letter-spacing: -0.035em;
}
.bc-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.6cqw;
  margin-top: 1.2cqw;
  padding: 0.5cqw 1.3cqw;
  border-radius: 999px;
  font-size: 1.4cqw;
  font-weight: 600;
  color: var(--mk-lime-ink);
  background: var(--mk-lime);
}
.bc-pill-icon {
  width: 1.3cqw;
  height: 1.3cqw;
}
.bc-brand {
  position: absolute;
  left: 6.7%;
  bottom: 10%;
  display: flex;
  align-items: center;
  gap: 1.2cqw;
  font-size: 1.5cqw;
  font-weight: 500;
  color: var(--ui-text-muted);
}
.bc-logo {
  height: 3.6cqw;
}
.bc-sep {
  width: 1px;
  height: 2.5cqw;
  background: var(--ui-border-accented, var(--ui-border));
}
</style>
