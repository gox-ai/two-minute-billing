<script setup lang="ts">
/**
 * A gateway's or integration's official logo, sized by `partnerLogoLayout` so every logo covers
 * the same `area` (px²). `ground="auto"` follows the site theme (`.dark` on <html>); pass
 * `light` or `dark` where the surface keeps one ground in both themes. Alt text is the company.
 *
 * In Markdown: `:partner-logo{name="stripe"}`.
 */
import {
  hasPartnerLogo,
  partnerLogoLayout,
  partnerLogoSameOnBothGrounds,
  type PartnerLogoKey,
} from "~/utils/partner-logos";

const props = withDefaults(
  defineProps<{
    name: PartnerLogoKey;
    area?: number;
    maxWidth?: number;
    ground?: "auto" | "light" | "dark";
    /** Above the fold: load at once. */
    eager?: boolean;
    /** Shown as text when the key has no logo file yet. */
    label?: string;
  }>(),
  { area: 1100, maxWidth: undefined, ground: "auto", eager: false, label: undefined },
);

const known = computed(() => hasPartnerLogo(props.name));

const grounds = computed(() => {
  if (!known.value) return [] as const;
  if (props.ground !== "auto") return [props.ground] as const;
  return partnerLogoSameOnBothGrounds(props.name)
    ? (["light"] as const)
    : (["light", "dark"] as const);
});
const layouts = computed(() =>
  grounds.value.map((g) => ({
    g,
    both: grounds.value.length === 1 && props.ground === "auto",
    ...partnerLogoLayout(props.name, g, props.area, props.maxWidth),
  })),
);
</script>

<template>
  <span class="pl-root">
    <span v-if="!known" class="pl-text">{{ label ?? name }}</span>
    <span
      v-for="l in layouts"
      :key="l.g"
      class="pl-box"
      :class="l.both ? '' : props.ground === 'auto' ? `pl-${l.g}` : ''"
      :style="
        l.plate
          ? {
              background: l.plate.color,
              padding: `${l.plate.padY}px ${l.plate.padX}px`,
              borderRadius: `${l.plate.radius}px`,
            }
          : undefined
      "
    >
      <img
        :src="l.src"
        :srcset="l.srcset"
        :alt="l.name"
        :width="l.width"
        :height="l.height"
        :style="{ width: `${l.width}px`, height: `${l.height}px`, margin: l.margin }"
        :loading="eager ? 'eager' : 'lazy'"
        decoding="async"
        class="pl-img"
      />
    </span>
  </span>
</template>

<style scoped>
.pl-root {
  display: inline-flex;
  flex: none;
  align-items: center;
  vertical-align: middle;
}
.pl-box {
  display: inline-flex;
  flex: none;
  align-items: center;
}
.pl-img {
  display: block;
  max-width: none;
}
.pl-text {
  font-weight: 600;
  font-size: 1.125rem;
}
</style>

<!-- Unscoped: the theme class sits on <html>, outside this component. -->
<style>
.dark .pl-light,
html:not(.dark) .pl-dark {
  display: none;
}
</style>
