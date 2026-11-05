<script setup lang="ts">
// ::screenshot{src="dashboard-home" alt="..."} → /product/dashboard-home-{light,dark}.webp
// `single`: one image for both themes (a third-party screen with no dark mode) → /product/<src>.webp
// `width`/`height`: a cropped capture's own pixel size (the default is a full 1920x1080 screen).
const props = defineProps<{
  src: string;
  alt: string;
  caption?: string;
  single?: boolean;
  width?: number;
  height?: number;
}>();
const file = (theme: "light" | "dark") =>
  props.single ? `/product/${props.src}.webp` : `/product/${props.src}-${theme}.webp`;
const modifiers = useShotModifiers();
</script>

<template>
  <figure class="my-6">
    <div class="overflow-hidden rounded-lg ring-1 ring-default shadow-sm">
      <!-- Explicit dimensions, or the image optimizer serves a 960px copy into a
           wider box and the dashboard text turns to mush. Captures are 2x of a 1920x1080 screen. -->
      <UColorModeImage
        :light="file('light')"
        :dark="file('dark')"
        :alt="alt"
        :width="width ?? 1920"
        :height="height ?? 1080"
        :modifiers="modifiers"
        class="block w-full"
        loading="lazy"
      />
    </div>
    <figcaption v-if="caption" class="mt-2 text-sm text-muted">
      {{ caption }}
    </figcaption>
  </figure>
</template>
