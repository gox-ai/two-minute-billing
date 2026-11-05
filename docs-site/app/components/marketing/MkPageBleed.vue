<script setup lang="ts">
/**
 * A window onto a screenshot that fills the box it is put in (`MkPageZig`'s bleed slot, the
 * closing call to action). The crop's top-left corner sits at the window's top-left; the rest
 * runs off the right edge and the foot, never the left or the top.
 *
 * The zoom is the largest of: `scale` (the window shows `crop width ÷ scale` source pixels
 * across, 1.6× closer on a phone), the zoom that fills the window's height, and the one that
 * fills its width, so the window never shows empty space. A full 1920×1080 capture defaults to the page area, without
 * the dashboard's sidebar (`dashboardCrop`). Coordinates are in 1920×1080 units; the files are
 * 2x, so the 2x candidate is real.
 */
const props = withDefaults(
  defineProps<{
    src: string;
    alt: string;
    width?: number;
    height?: number;
    /** [x, y, w, h] in source pixels. Only x, y and w set the window; the foot runs on. */
    crop?: ShotCrop;
    /** How far the crop overflows the window, 1.3 = 130% of its width. */
    scale?: number;
  }>(),
  { scale: 1.3, width: 1920, height: 1080 },
);

const modifiers = useShotModifiers();
/** A phone's window is a third as wide, so it shows less of the capture, larger. */
const PHONE_ZOOM = 1.6;

const img = computed(() => {
  const { width: W, height: H, scale } = props;
  const [x, y, w] =
    props.crop ?? (W === 1920 && H === 1080 ? dashboardCrop(props.src) : [0, 0, W, H]);
  const pct = (n: number) => `${+(n * 100).toFixed(3)}`;
  const byScale = W / (w / scale);
  const byWidth = W / (W - x);
  const byHeight = W / (H - y);
  return {
    "--pb-wide": `${pct(Math.max(byScale, byWidth))}cqw`,
    "--pb-phone": `${pct(Math.max(byScale * PHONE_ZOOM, byWidth))}cqw`,
    "--pb-tall": `${pct(byHeight)}cqh`,
    transform: `translate(-${pct(x / W)}%, -${pct(y / H)}%)`,
  };
});
</script>

<template>
  <div class="pb-window">
    <UColorModeImage
      :light="`${src}-light.webp`"
      :dark="`${src}-dark.webp`"
      :alt="alt"
      :width="width"
      :height="height"
      :modifiers="modifiers"
      loading="lazy"
      class="pb-img"
      :style="img"
    />
  </div>
</template>

<style scoped>
.pb-window {
  position: relative;
  height: 100%;
  overflow: hidden;
  container-type: size;
  border-radius: 0.5rem 0 0 0;
  background: var(--mk-card);
  box-shadow: var(--mk-shadow);
}
/* The frame: top and left only, the edges that stay in view. */
.pb-window::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  border: 1px solid var(--mk-ring);
  border-right: 0;
  border-bottom: 0;
  border-radius: inherit;
  pointer-events: none;
}
.pb-window :deep(.pb-img) {
  position: absolute;
  top: 0;
  left: 0;
  width: max(var(--pb-phone), var(--pb-tall));
  max-width: none;
  height: auto;
}
@media (min-width: 1024px) {
  .pb-window :deep(.pb-img) {
    width: max(var(--pb-wide), var(--pb-tall));
  }
}
</style>
