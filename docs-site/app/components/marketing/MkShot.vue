<script setup lang="ts">
/**
 * A product screenshot or fragment in a soft-shadowed frame, light and dark.
 *
 * `src` is the path without the theme suffix: `/product/fragments/invoice-lines` serves
 * `…-light.webp` and `…-dark.webp`. `crop` ([x, y, w, h] in source pixels) shows one region
 * of a full capture, which is how app chrome stays out of marketing imagery.
 */
const props = withDefaults(
  defineProps<{
    src: string;
    alt: string;
    width?: number;
    height?: number;
    crop?: [number, number, number, number];
    caption?: string;
    eager?: boolean;
  }>(),
  { width: 1920, height: 1080 },
);

const modifiers = useShotModifiers();

const frame = computed(() => {
  const [, , w, h] = props.crop ?? [0, 0, props.width, props.height];
  return { aspectRatio: `${w} / ${h}` };
});
const img = computed(() => {
  if (!props.crop) return { width: "100%", height: "auto" };
  const [x, y, w, h] = props.crop;
  return {
    position: "absolute" as const,
    maxWidth: "none",
    width: `${(props.width / w) * 100}%`,
    left: `${(-x / w) * 100}%`,
    top: `${(-y / h) * 100}%`,
  };
});
</script>

<template>
  <figure class="min-w-0">
    <div class="mk-surface relative overflow-hidden" :style="frame">
      <UColorModeImage
        :light="`${src}-light.webp`"
        :dark="`${src}-dark.webp`"
        :alt="alt"
        :width="width"
        :height="height"
        :modifiers="modifiers"
        :loading="eager ? 'eager' : 'lazy'"
        :style="img"
      />
    </div>
    <figcaption v-if="caption" class="mt-3 text-center text-sm text-muted">
      {{ caption }}
    </figcaption>
  </figure>
</template>
