<script setup lang="ts">
/**
 * The homepage's product moment, in two beats that loop:
 *   1. A renewal in the seller's own state: GST invoice with CGST + SGST, charged on the
 *      customer's Razorpay e-mandate, events delivered to the merchant's endpoint.
 *   2. A renewal across states: IGST, the default card declines, the backup card pays.
 *
 * Every row is always in the DOM and only fades, so the card never changes height. The
 * server renders beat 1 finished, which is also the reduced-motion and no-JS frame.
 * Event names are the real webhook types.
 */
type Tone = "ok" | "bad" | "wait";
interface Row {
  at: number;
  label: string;
  amount?: string;
  muted?: boolean;
}
interface Pay {
  at: number;
  done: number;
  label: string;
  sub: string;
  result: "ok" | "bad" | "info";
  resultText: string;
}
interface Beat {
  number: string;
  billTo: string;
  billToState: string;
  supply: string;
  rows: Row[];
  totalAt: number;
  total: string;
  posted: number;
  paid: number;
  pay: Pay[];
  events: { at: number; type: string }[];
  length: number;
}

const BEATS: Beat[] = [
  {
    number: "INV-2026-0142",
    billTo: "Malnad Textiles Pvt Ltd",
    billToState: "Karnataka",
    supply: "Same state",
    rows: [
      { at: 500, label: "Growth plan · 1 – 30 Nov", amount: "₹2,999.00" },
      { at: 1100, label: "CGST 9%", amount: "₹269.91", muted: true },
      { at: 1300, label: "SGST 9%", amount: "₹269.91", muted: true },
    ],
    totalAt: 1800,
    total: "₹3,538.82",
    posted: 1800,
    paid: 3600,
    pay: [
      {
        at: 2500,
        done: 3500,
        label: "e-mandate ···· 6789",
        sub: "Razorpay",
        result: "ok",
        resultText: "Charged",
      },
      {
        at: 3900,
        done: 3900,
        label: "Money settles to your bank",
        sub: "On Razorpay's payout schedule",
        result: "info",
        resultText: "",
      },
    ],
    events: [
      { at: 500, type: "subscription_renewed" },
      { at: 1800, type: "invoice_generated" },
      { at: 3500, type: "payment_succeeded" },
      { at: 3700, type: "invoice_paid" },
    ],
    length: 7600,
  },
  {
    number: "INV-2026-0143",
    billTo: "Example Traders",
    billToState: "Maharashtra",
    supply: "Other state",
    rows: [
      { at: 500, label: "Scale plan · 1 – 30 Nov", amount: "₹9,999.00" },
      { at: 1100, label: "IGST 18%", amount: "₹1,799.82", muted: true },
      { at: 1300, label: "Place of supply: Maharashtra", muted: true },
    ],
    totalAt: 1800,
    total: "₹11,798.82",
    posted: 1800,
    paid: 4600,
    pay: [
      {
        at: 2500,
        done: 3300,
        label: "Card ···· 4242",
        sub: "Default card",
        result: "bad",
        resultText: "Declined",
      },
      {
        at: 3700,
        done: 4500,
        label: "Card ···· 5555",
        sub: "Backup card, same attempt",
        result: "ok",
        resultText: "Charged",
      },
    ],
    events: [
      { at: 500, type: "subscription_renewed" },
      { at: 1800, type: "invoice_generated" },
      { at: 4500, type: "payment_succeeded" },
      { at: 4700, type: "invoice_paid" },
    ],
    length: 8400,
  },
];

const FINISHED = 1e9;
const beat = ref(0);
const t = ref(FINISHED);
const fading = ref(false);
const running = ref(false);
const paused = ref(false);
const reduced = ref(true);

const b = computed(() => BEATS[beat.value]!);
const on = (at: number) => t.value >= at;
const status = computed(() =>
  on(b.value.paid) ? "Paid" : on(b.value.posted) ? "Posted" : "Draft",
);
const statusColor = computed(() =>
  status.value === "Paid"
    ? ("success" as const)
    : status.value === "Posted"
      ? ("info" as const)
      : ("neutral" as const),
);
function payTone(p: Pay): Tone {
  if (!on(p.done)) return "wait";
  return p.result === "bad" ? "bad" : "ok";
}

const root = ref<HTMLElement>();
let timer: ReturnType<typeof setInterval> | undefined;
let visible = false;
let observer: IntersectionObserver | undefined;
const TICK = 100;

function tick() {
  if (t.value >= b.value.length) {
    fading.value = true;
    setTimeout(() => {
      beat.value = (beat.value + 1) % BEATS.length;
      t.value = 0;
      fading.value = false;
    }, 350);
    stop();
    setTimeout(start, 400);
    return;
  }
  t.value += TICK;
}
function start() {
  if (timer || paused.value || !visible || reduced.value) return;
  running.value = true;
  timer = setInterval(tick, TICK);
}
function stop() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
function togglePause() {
  paused.value = !paused.value;
  if (paused.value) stop();
  else start();
}

onMounted(() => {
  reduced.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced.value || !root.value) return;
  // Hold the finished first frame a moment, then play the second beat and loop.
  t.value = BEATS[0]!.length - 2400;
  observer = new IntersectionObserver(([e]) => {
    visible = !!e?.isIntersecting;
    if (visible) start();
    else stop();
  });
  observer.observe(root.value);
  document.addEventListener("visibilitychange", onVisibility);
});
function onVisibility() {
  if (document.hidden) stop();
  else start();
}
onBeforeUnmount(() => {
  stop();
  observer?.disconnect();
  document.removeEventListener("visibilitychange", onVisibility);
});
</script>

<template>
  <div
    ref="root"
    class="relative mx-auto w-full max-w-[34rem] lg:pb-24"
    role="img"
    aria-label="A subscription renews. A GST invoice is raised, the customer's Razorpay e-mandate is charged, and invoice_paid is sent to your webhook endpoint. On the next renewal the default card declines and the backup card pays."
  >
    <!-- The invoice -->
    <div class="mk-surface relative p-5 sm:p-6" aria-hidden="true">
      <div class="hd-body" :class="{ 'is-fading': fading }" data-motion>
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-xs text-muted">
              <span class="hd-clock grid size-5 place-items-center rounded-full">
                <UIcon name="i-lucide-repeat" class="size-3" />
              </span>
              Renewal · 1 Nov, 00:00
            </div>
            <div class="mt-1.5 font-semibold text-highlighted">Tax invoice {{ b.number }}</div>
          </div>
          <UBadge :color="statusColor" variant="subtle" class="hd-status shrink-0 tabular-nums">{{
            status
          }}</UBadge>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div class="min-w-0">
            <div class="text-xs text-muted">From</div>
            <div class="truncate text-highlighted">Fernhill Analytics Pvt Ltd</div>
            <div class="text-xs text-muted">Karnataka</div>
          </div>
          <div class="min-w-0">
            <div class="text-xs text-muted">Bill to</div>
            <div class="truncate text-highlighted">{{ b.billTo }}</div>
            <div class="text-xs text-muted">
              {{ b.billToState }} ·
              <span class="font-medium text-primary">{{ b.supply }}</span>
            </div>
          </div>
        </div>

        <div class="mt-4 border-t border-default text-sm">
          <div
            v-for="(r, i) in b.rows"
            :key="i"
            class="hd-row flex items-center justify-between gap-3 border-b border-default py-2"
            :class="{ 'is-on': on(r.at) }"
          >
            <span class="truncate" :class="r.muted ? 'text-muted' : 'text-highlighted'">{{
              r.label
            }}</span>
            <span
              v-if="r.amount"
              class="tabular-nums"
              :class="r.muted ? 'text-muted' : 'text-highlighted'"
              >{{ r.amount }}</span
            >
          </div>
          <div
            class="hd-row flex items-center justify-between py-2 font-semibold text-highlighted"
            :class="{ 'is-on': on(b.totalAt) }"
          >
            <span>Total</span>
            <span class="tabular-nums">{{ b.total }}</span>
          </div>
        </div>

        <ul class="mt-2 space-y-2">
          <li
            v-for="(p, i) in b.pay"
            :key="i"
            class="hd-row hd-pay flex items-center gap-3 rounded-lg px-3 py-2"
            :class="[{ 'is-on': on(p.at) }, `tone-${p.result === 'info' ? 'info' : payTone(p)}`]"
          >
            <span class="hd-icon grid size-7 shrink-0 place-items-center rounded-md">
              <UIcon
                :name="
                  p.result === 'info'
                    ? 'i-lucide-landmark'
                    : payTone(p) === 'wait'
                      ? 'i-lucide-loader-circle'
                      : payTone(p) === 'bad'
                        ? 'i-lucide-x'
                        : 'i-lucide-check'
                "
                class="size-4"
                :class="{ 'animate-spin': p.result !== 'info' && payTone(p) === 'wait' }"
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-highlighted">{{ p.label }}</span>
              <span class="block truncate text-xs text-muted">{{ p.sub }}</span>
            </span>
            <span v-if="p.result !== 'info'" class="hd-result text-xs font-semibold">
              {{ payTone(p) === "wait" ? "Charging" : p.resultText }}
            </span>
          </li>
        </ul>
      </div>
    </div>

    <!-- What your endpoint receives -->
    <div
      class="hd-hook mt-3 rounded-xl p-4 text-xs sm:text-[0.8125rem] lg:absolute lg:-right-6 lg:bottom-0 lg:mt-0 lg:w-[19rem] xl:-right-10"
      aria-hidden="true"
    >
      <div class="flex items-center justify-between gap-2 font-mono">
        <span class="truncate"><span class="hd-verb">POST</span> /billing-events</span>
        <span class="hd-dim">your endpoint</span>
      </div>
      <ul class="hd-body mt-2.5 space-y-1.5 font-mono" :class="{ 'is-fading': fading }" data-motion>
        <li
          v-for="e in b.events"
          :key="e.type"
          class="hd-row flex items-center justify-between gap-2"
          :class="{ 'is-on': on(e.at) }"
        >
          <span class="truncate">{{ e.type }}</span>
          <span class="hd-ok shrink-0">200</span>
        </li>
      </ul>
    </div>

    <button
      v-if="!reduced"
      type="button"
      class="absolute -top-3 -right-1 grid size-7 place-items-center rounded-full border border-default bg-default text-muted shadow-sm hover:text-highlighted lg:right-5"
      :aria-label="paused ? 'Play the animation' : 'Pause the animation'"
      @click="togglePause"
    >
      <UIcon :name="paused ? 'i-lucide-play' : 'i-lucide-pause'" class="size-3.5" />
    </button>
  </div>
</template>

<style scoped>
.hd-body {
  transition: opacity 0.3s ease;
}
.hd-body.is-fading {
  opacity: 0;
}
.hd-row {
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity 0.45s ease,
    transform 0.45s ease,
    background-color 0.4s ease;
}
.hd-row.is-on {
  opacity: 1;
  transform: none;
}
.hd-clock {
  background: var(--mk-accent-soft);
  color: var(--mk-accent);
}
.hd-pay {
  background: var(--ui-bg-muted);
}
.hd-icon {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-muted);
  transition:
    background-color 0.3s ease,
    color 0.3s ease;
}
.tone-ok .hd-icon {
  background: color-mix(in oklab, var(--mk-ok) 14%, transparent);
  color: var(--mk-ok);
}
.tone-ok .hd-result {
  color: var(--mk-ok);
}
.tone-bad .hd-icon {
  background: color-mix(in oklab, var(--mk-bad) 14%, transparent);
  color: var(--mk-bad);
}
.tone-bad .hd-result {
  color: var(--mk-bad);
}
.tone-wait .hd-result {
  color: var(--ui-text-muted);
}
.tone-info .hd-icon {
  background: color-mix(in oklab, var(--ui-primary) 12%, transparent);
  color: var(--ui-primary);
}
.hd-hook {
  background: #0d1526;
  color: #d7e2f3;
  box-shadow:
    0 0 0 1px rgb(255 255 255 / 0.06),
    0 20px 40px -16px rgb(2 6 23 / 0.55);
}
:global(.dark) .hd-hook {
  background: #050a14;
  box-shadow:
    0 0 0 1px rgb(255 255 255 / 0.1),
    0 20px 40px -16px rgb(0 0 0 / 0.7);
}
.hd-verb {
  color: #ffb27a;
}
.hd-dim {
  color: #6f819c;
}
.hd-ok {
  color: #86efac;
}
@media (prefers-reduced-motion: reduce) {
  .hd-row,
  .hd-body,
  .hd-icon {
    transition: none;
  }
}
</style>
