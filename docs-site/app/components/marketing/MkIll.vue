<script setup lang="ts">
/**
 * The frame for a live illustration (`ill.css`). A board is drawn at a fixed native size
 * (`w` × `h`) and scaled down to the slot's width, never up. With `stack`, a slot narrower than
 * 700 px renders the board's own stacked layout at full size instead, because scaling alone
 * leaves phone text a few pixels tall. The board styles that layout inside
 * `@container ill (max-width: 699.98px)`.
 *
 * Both the scale and the stacked layout are CSS, so the server-rendered page is already right:
 * a script that measured the slot after hydration moved everything below the homepage hero on
 * phones (CLS 0.2) and visibly shrank the desktop hero about two seconds after first paint.
 */
defineOptions({ inheritAttrs: false });
const props = defineProps<{ w: number; h: number; stack?: boolean; label?: string }>();

const vars = computed(() => ({
  "--ill-ar": `${props.w} / ${props.h}`,
  "--ill-w": `${props.w}px`,
  "--ill-h": `${props.h}px`,
}));
</script>

<template>
  <div class="ill-cq" :class="{ 'ill-cq-stack': stack }">
    <div
      v-bind="$attrs"
      class="ill"
      :style="vars"
      :role="label ? 'img' : undefined"
      :aria-label="label"
    >
      <div class="scene ill-fit" :aria-hidden="label ? 'true' : undefined">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ill-cq {
  container: ill / inline-size;
}
/* The frame is a container too, so 100cqw below is its width inside the border. */
.ill {
  aspect-ratio: var(--ill-ar);
  container-type: inline-size;
}
/* The scale is the frame's width over the board's, never above 1: tan(atan2(a, b)) divides one
   length by another and gives a plain number. */
.ill > .ill-fit {
  position: absolute;
  left: 50%;
  top: 50%;
  width: var(--ill-w);
  height: var(--ill-h);
  transform: translate(-50%, -50%) scale(min(1, tan(atan2(100cqw, var(--ill-w)))));
  transform-origin: 50% 50%;
}
@container ill (max-width: 699.98px) {
  .ill-cq-stack > .ill {
    aspect-ratio: auto;
  }
  .ill-cq-stack > .ill > .ill-fit {
    position: relative;
    left: auto;
    top: auto;
    width: 100%;
    height: auto;
    transform: none;
  }
}
</style>
