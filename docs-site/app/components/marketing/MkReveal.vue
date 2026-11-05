<script setup lang="ts">
/**
 * Plays its children's entrance once, when it scrolls into view. Children opt in with the
 * `mk-r` class and an `--i` index for the stagger. Server render, reduced motion and
 * anything already on screen at load stay static, so nothing flashes or shifts.
 */
const el = ref<HTMLElement>();
const state = ref<"idle" | "armed" | "go">("idle");
let io: IntersectionObserver | undefined;

onMounted(() => {
  const node = el.value;
  if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (node.getBoundingClientRect().top < window.innerHeight * 0.85) return;
  state.value = "armed";
  io = new IntersectionObserver(
    ([e]) => {
      if (!e?.isIntersecting) return;
      state.value = "go";
      io?.disconnect();
    },
    { threshold: 0.15 },
  );
  io.observe(node);
});
onBeforeUnmount(() => io?.disconnect());
</script>

<template>
  <div ref="el" :data-reveal="state">
    <slot />
  </div>
</template>
