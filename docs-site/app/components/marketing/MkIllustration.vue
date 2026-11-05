<script setup lang="ts">
/**
 * An illustration exported from design/illustrations: a still WebP, and a video laid over
 * it once it plays. The still is the real image (alt text, the LCP candidate, what reduced motion
 * and blocked autoplay show); the video is decoration and loads only while the board is on
 * screen, for the theme and width actually shown. Light and dark pairs share one size, so the
 * theme swap never moves the layout. A wide board can carry a stacked `phone` cut, served below
 * 640 px at its own size.
 */
const props = defineProps<{
  /** The board's file name, e.g. "IllMoneyFlow". */
  name: string;
  /** The 1× CSS size; the files are 2×. */
  width: number;
  height: number;
  alt: string;
  /** Above the fold: load the still at once instead of when scrolled near. */
  eager?: boolean;
  /** The 1× size of a `Name.phone.*` cut, when the board has one. */
  phone?: { width: number; height: number };
}>();

const PHONE = "(max-width: 639px)";

const themes = [
  { key: "light", suffix: "" },
  { key: "dark", suffix: ".dark" },
] as const;
/** File name → content hash, from nuxt.config.ts. A changed file gets a new URL. */
declare const __ILL_VERSIONS__: Record<string, string>;
const file = (suffix: string, ext: "webp" | "mp4", phone = false) => {
  const name = `${props.name}${phone ? ".phone" : ""}${suffix}.${ext}`;
  const v = __ILL_VERSIONS__[name];
  return `/illustrations/${name}${v ? `?v=${v}` : ""}`;
};

const root = ref<HTMLElement>();
let stop = () => {};

onMounted(() => {
  const el = root.value;
  if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const phoneQuery = matchMedia(PHONE);
  let near = false;

  // Play the one video that is near the viewport and in the layer on display; pause the rest.
  // A video gets its source only when it first plays, so a hidden theme never downloads one.
  const sync = () => {
    for (const layer of el.querySelectorAll<HTMLElement>(".mk-illustration-layer")) {
      const video = layer.querySelector("video")!;
      const shown = near && getComputedStyle(layer).display !== "none";
      if (!shown) {
        video.pause();
        continue;
      }
      const src = file(layer.dataset.suffix!, "mp4", !!props.phone && phoneQuery.matches);
      if (video.getAttribute("src") !== src) {
        video.classList.remove("is-playing");
        video.src = src;
      }
      // Autoplay can be refused (iOS Low Power Mode): the still simply stays.
      // Each video plays once; after it ends the still (the finished picture) stays.
      if (!video.ended) video.play().catch(() => {});
    }
  };

  const io = new IntersectionObserver(
    ([entry]) => {
      near = entry!.isIntersecting;
      sync();
    },
    { rootMargin: "200px" },
  );
  io.observe(el);
  // The site toggles `.dark` on <html>; re-pick the layer when it does.
  const mo = new MutationObserver(sync);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  phoneQuery.addEventListener("change", sync);
  stop = () => {
    io.disconnect();
    mo.disconnect();
    phoneQuery.removeEventListener("change", sync);
  };
});
onBeforeUnmount(() => stop());

// Show the video only once frames are coming, so the still never blinks out.
const onPlaying = (e: Event) => (e.target as HTMLVideoElement).classList.add("is-playing");
const onEnded = (e: Event) => (e.target as HTMLVideoElement).classList.remove("is-playing");
</script>

<template>
  <span ref="root" class="mk-illustration">
    <span
      v-for="t in themes"
      :key="t.key"
      :class="`mk-illustration-layer mk-illustration-${t.key}`"
      :data-suffix="t.suffix"
    >
      <picture>
        <source
          v-if="phone"
          :srcset="file(t.suffix, 'webp', true)"
          :media="PHONE"
          :width="phone.width"
          :height="phone.height"
        />
        <img
          :src="file(t.suffix, 'webp')"
          :width="width"
          :height="height"
          :alt="alt"
          :loading="eager && t.key === 'light' ? 'eager' : 'lazy'"
          :fetchpriority="eager && t.key === 'light' ? 'high' : undefined"
          decoding="async"
        />
      </picture>
      <video
        muted
        playsinline
        preload="none"
        aria-hidden="true"
        @playing="onPlaying"
        @ended="onEnded"
      />
    </span>
  </span>
</template>

<style>
/* Unscoped: the theme swap keys off `.dark` on <html>, outside this component. */
/* The board's own ground ends in a rounded edge; a slot that frames it (the homepage panels)
   turns this off. */
.mk-illustration {
  display: block;
  overflow: hidden;
  border-radius: 0.75rem;
}
.mk-illustration-layer {
  position: relative;
  display: block;
}
.mk-illustration img {
  display: block;
  width: 100%;
  height: auto;
}
/* The video sits exactly over the still (same cut, same aspect) and fades in once playing. */
.mk-illustration video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
}
.mk-illustration video.is-playing {
  opacity: 1;
}
.mk-illustration-dark,
.dark .mk-illustration-light {
  display: none;
}
.dark .mk-illustration-dark {
  display: block;
}
</style>
