<script setup lang="ts">
/**
 * A short, silent product loop: `/product/loops/<name>.mp4` with `<name>-poster.webp`.
 * Plays only while on screen. Under reduced motion it is the poster, with a play button.
 */
const props = defineProps<{
  name: string;
  label: string;
  width?: number;
  height?: number;
  caption?: string;
}>();

const video = ref<HTMLVideoElement>();
const reduced = ref(false);
const playing = ref(false);
const poster = computed(() => `/product/loops/${props.name}-poster.webp`);
const ratio = computed(() => `${props.width ?? 1600} / ${props.height ?? 1000}`);

let observer: IntersectionObserver | undefined;

onMounted(() => {
  const el = video.value;
  if (!el) return;
  reduced.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced.value) return;
  observer = new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting) el.play().catch(() => {});
      else el.pause();
    },
    { threshold: 0.25 },
  );
  observer.observe(el);
});
onBeforeUnmount(() => observer?.disconnect());

function toggle() {
  const el = video.value;
  if (!el) return;
  if (el.paused) el.play().catch(() => {});
  else el.pause();
}
</script>

<template>
  <figure class="min-w-0">
    <div class="mk-surface relative overflow-hidden" :style="{ aspectRatio: ratio }">
      <video
        ref="video"
        class="absolute inset-0 size-full object-cover"
        :poster="poster"
        :aria-label="label"
        muted
        loop
        playsinline
        preload="metadata"
        @play="playing = true"
        @pause="playing = false"
      >
        <source :src="`/product/loops/${name}.mp4`" type="video/mp4" />
      </video>
      <button
        type="button"
        class="absolute right-3 bottom-3 grid size-8 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70"
        :aria-label="playing ? 'Pause video' : 'Play video'"
        @click="toggle"
      >
        <UIcon :name="playing ? 'i-lucide-pause' : 'i-lucide-play'" class="size-4" />
      </button>
    </div>
    <figcaption v-if="caption" class="mt-3 text-center text-sm text-muted">
      {{ caption }}
    </figcaption>
  </figure>
</template>
