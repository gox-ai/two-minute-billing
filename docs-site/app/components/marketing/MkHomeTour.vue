<script setup lang="ts">
/**
 * The hero's product tour: four tabs over one frame. The active tab's bar fills over 8 s
 * (CSS) and its `animationend` moves the tour on, so reduced motion never advances it.
 * Selecting a tab stops the tour. The bar pauses while the tour is off screen.
 * A loop shows its still until the visitor presses play or selects its tab.
 */
interface Stop {
  label: string;
  caption: string;
  alt: string;
  /** A light/dark pair in public/product, without the suffix. */
  shot?: string;
  /** A loop in public/product/loops (light only). `shot` is its still until it plays. */
  loop?: string;
  stillAlt?: string;
}

const stops: Stop[] = [
  {
    label: "Create a subscription",
    caption: "Select a customer and a plan. The first invoice preview fills in.",
    alt: "A new subscription: the operator selects a customer and a plan, and the first invoice preview fills in",
    loop: "create-subscription",
    shot: "subscription-detail",
    stillAlt:
      "A subscription in the dashboard: its plan and add-on, MRR, the next billing date and the payment method",
  },
  {
    label: "Invoice and collect",
    caption: "We raise each invoice on schedule, with tax and discounts, as a branded PDF.",
    alt: "The invoice list, with the status, amount and due date of each invoice",
    shot: "invoices",
  },
  {
    label: "Recover failed payments",
    caption: "Retries run on your schedule. Emails let the customer pay in one click.",
    alt: "Payment retries, with the next attempt for each failed invoice",
    shot: "retries",
  },
  {
    label: "See your revenue",
    caption: "MRR, churn, cohorts and receivables, per currency.",
    alt: "The business home: MRR, revenue, active subscriptions and what needs attention today",
    shot: "business-home",
  },
];

const modifiers = useShotModifiers();
const active = ref(0);
const picked = ref(false);
const onScreen = ref(true);
const reduced = ref(false);
const root = ref<HTMLElement>();
const list = ref<HTMLElement>();
const buttons: HTMLButtonElement[] = [];
const video = ref<HTMLVideoElement>();
const playing = ref(false);
/** The loop is mounted only once the visitor asks for it. */
const started = ref(false);

function setVideo(el: unknown) {
  video.value = (el as HTMLVideoElement | null) ?? undefined;
}

function select(i: number, focus = false) {
  active.value = i;
  picked.value = true;
  if (stops[i]?.loop && !reduced.value) start();
  if (focus) buttons[i]?.focus();
}

function start() {
  picked.value = true;
  if (started.value) return syncVideo();
  started.value = true;
  nextTick(syncVideo);
}

function onKey(e: KeyboardEvent, i: number) {
  const n = stops.length;
  const next: Record<string, number> = {
    ArrowRight: (i + 1) % n,
    ArrowLeft: (i - 1 + n) % n,
    Home: 0,
    End: n - 1,
  };
  if (!(e.key in next)) return;
  e.preventDefault();
  select(next[e.key]!, true);
}

function advance() {
  if (!picked.value) active.value = (active.value + 1) % stops.length;
}

/** On a phone the tabs scroll sideways; keep the active one in view without moving the page. */
function reveal(i: number) {
  const box = list.value;
  const btn = buttons[i];
  if (!box || !btn || box.scrollWidth <= box.clientWidth) return;
  box.scrollTo({ left: btn.offsetLeft - 12, behavior: reduced.value ? "auto" : "smooth" });
}

function syncVideo() {
  const el = video.value;
  if (!el) return;
  const show = started.value && stops[active.value]?.loop && onScreen.value;
  if (show) el.play().catch(() => {});
  else el.pause();
}

function toggleVideo() {
  const el = video.value;
  if (!el) return;
  if (el.paused) el.play().catch(() => {});
  else el.pause();
}

watch(active, (i, prev) => {
  reveal(i);
  const el = video.value;
  if (el && stops[i]?.loop && i !== prev) el.currentTime = 0;
  syncVideo();
});

let io: IntersectionObserver | undefined;
onMounted(() => {
  reduced.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (root.value) {
    io = new IntersectionObserver(
      ([e]) => {
        onScreen.value = !!e?.isIntersecting;
        syncVideo();
      },
      { threshold: 0.2 },
    );
    io.observe(root.value);
  }
  syncVideo();
});
onBeforeUnmount(() => io?.disconnect());
</script>

<template>
  <div ref="root" class="tour w-full">
    <div
      ref="list"
      role="tablist"
      aria-label="Product tour"
      class="tour-tabs"
      :class="{ 'tour-paused': !onScreen }"
    >
      <button
        v-for="(s, i) in stops"
        :id="`tour-tab-${i}`"
        :key="s.label"
        :ref="(el) => (buttons[i] = el as HTMLButtonElement)"
        type="button"
        role="tab"
        class="tour-tab"
        :aria-selected="i === active"
        aria-controls="tour-panel"
        :tabindex="i === active ? 0 : -1"
        @click="select(i)"
        @keydown="onKey($event, i)"
      >
        <span class="tour-label">
          <span class="tour-num">{{ i + 1 }}</span>
          <span>{{ s.label }}</span>
        </span>
        <span class="tour-track" aria-hidden="true">
          <span
            v-if="i === active"
            :key="`${active}-${picked}`"
            class="tour-bar"
            :class="{ 'tour-run': !picked }"
            data-motion
            @animationend="advance"
          />
        </span>
      </button>
    </div>

    <p class="tour-caption" :aria-live="picked ? 'polite' : 'off'">
      {{ stops[active]!.caption }}
    </p>

    <div
      id="tour-panel"
      role="tabpanel"
      :aria-labelledby="`tour-tab-${active}`"
      tabindex="0"
      class="mk-frame tour-frame"
    >
      <div
        v-for="(s, i) in stops"
        v-show="i === active"
        :key="s.label"
        class="tour-shot"
        :class="{ 'tour-in': picked || i !== 0 }"
        data-motion
      >
        <template v-if="s.loop && started">
          <video
            :ref="setVideo"
            class="tour-media"
            :poster="`/product/loops/${s.loop}-poster.webp`"
            :aria-label="s.alt"
            preload="auto"
            muted
            loop
            playsinline
            width="1280"
            height="720"
            @play="playing = true"
            @pause="playing = false"
          >
            <source :src="`/product/loops/${s.loop}.mp4`" type="video/mp4" />
          </video>
          <button
            type="button"
            class="tour-play"
            :aria-label="playing ? 'Pause video' : 'Play video'"
            @click="toggleVideo"
          >
            <UIcon :name="playing ? 'i-lucide-pause' : 'i-lucide-play'" class="size-4" />
          </button>
        </template>
        <template v-else>
          <UColorModeImage
            :light="`/product/${s.shot}-light.webp`"
            :dark="`/product/${s.shot}-dark.webp`"
            :alt="s.stillAlt ?? s.alt"
            :width="1920"
            :height="1080"
            :modifiers="modifiers"
            sizes="sm:100vw lg:980px"
            :loading="i === 0 ? 'eager' : 'lazy'"
            class="tour-media tour-crop"
          />
          <button
            v-if="s.loop"
            type="button"
            class="tour-play"
            aria-label="Play video"
            @click="start"
          >
            <UIcon name="i-lucide-play" class="size-4" />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tour-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--mk-accent-line);
  border-radius: 14px;
  background: var(--mk-card);
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.04);
}
.tour-tab {
  display: block;
  min-width: 0;
  padding: 0;
  border: 0;
  border-right: 1px solid var(--ui-border-muted);
  background: var(--mk-card);
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--ui-text-muted);
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s ease;
}
.tour-tab:last-child {
  border-right: 0;
}
.tour-tab:hover {
  color: var(--ui-text-highlighted);
}
.tour-tab:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}
.tour-tab[aria-selected="true"] {
  background: var(--mk-accent-soft);
  font-weight: 600;
  color: var(--ui-primary);
}
.tour-label {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  height: 3.5rem;
  padding: 0 1.125rem;
}
.tour-num {
  display: inline-flex;
  flex: none;
  width: 1.5rem;
  height: 1.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--mk-accent-soft);
  font-size: 0.75rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ui-primary);
}
.tour-tab[aria-selected="true"] .tour-num {
  background: var(--mk-accent);
  color: var(--mk-canvas);
}
.tour-track {
  display: block;
  height: 3px;
  overflow: hidden;
  background: var(--mk-accent-soft);
}
.tour-bar {
  display: block;
  height: 3px;
  background: var(--mk-accent);
  transform-origin: left center;
}
.tour-run {
  animation: mk-fill 8s linear both;
}
.tour-paused .tour-run {
  animation-play-state: paused;
}
.tour-caption {
  margin-top: 0.875rem;
  min-height: 1.5rem;
  font-size: 0.9375rem;
  color: var(--ui-text-toned);
  text-align: center;
}
.tour-frame {
  margin-top: 0.75rem;
}
.tour-frame:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.tour-shot {
  position: relative;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  border-radius: 14px;
  border: 1px solid var(--ui-border-muted);
}
.tour-in {
  animation: mk-panel 0.6s ease-out both;
}
.tour-media {
  vertical-align: top;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top left;
}
/* Screenshots show source x 262–1900: past the sidebar and its collapse toggle, short of the
   scrollbar. 1920 / 1638 wide, moved 262 / 1638 left. */
.tour-shot :deep(.tour-crop) {
  vertical-align: top;
  width: 117.216%;
  max-width: none;
  height: auto;
  margin-left: -15.995%;
}
.tour-play {
  position: absolute;
  right: 0.75rem;
  bottom: 0.75rem;
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border-radius: 999px;
  background: rgb(0 0 0 / 0.55);
  color: #fff;
  backdrop-filter: blur(4px);
}
.tour-play:hover {
  background: rgb(0 0 0 / 0.7);
}
.tour-play:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
@media (max-width: 760px) {
  .tour-tabs {
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .tour-tab {
    flex: 0 0 auto;
    min-width: 13.125rem;
    scroll-snap-align: start;
  }
}
@media (prefers-reduced-motion: reduce) {
  .tour-run,
  .tour-in {
    animation: none;
  }
  .tour-bar {
    transform: none;
  }
}
</style>
