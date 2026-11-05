<script setup lang="ts">
/**
 * Tax by place of supply, as three slides: US sales tax (a `sales_tax` region with the rate the
 * business sets per state), EU VAT (the `reverse_charge` treatment vs the home rate) and India
 * GST (CGST + SGST inside the seller's state, IGST across states). Demo data, in HTML.
 *
 * The active tab's bar fills over 6 s (CSS) and its `animationend` moves on, so reduced motion
 * never advances. Hover, focus and off-screen pause the bar; a click stops it for good.
 */
import MkReveal from "./MkReveal.vue";

interface Buyer {
  where: string;
  rule: string;
  lines: { label: string; amount: string }[];
  total: string;
  note: string;
  /** Tax as a percentage of the price, for the bar. */
  share: number;
}
interface Slide {
  tab: string;
  seller: string;
  plan: string;
  price: string;
  who: string;
  buyers: Buyer[];
  footnote?: string;
  summary: string;
}

const slides: Slide[] = [
  {
    tab: "US sales tax",
    seller: "Seller · United States",
    plan: "Larkspur Inc. · Growth plan $1,000",
    price: "$1,000.00",
    who: "Customer in",
    buyers: [
      {
        where: "California",
        rule: "Your rate for this state",
        lines: [{ label: "Sales tax 7.25%", amount: "$72.50" }],
        total: "$1,072.50",
        note: "The invoice uses the rate that you set for California.",
        share: 7.25,
      },
      {
        where: "Oregon",
        rule: "Your rate for this state",
        lines: [{ label: "Sales tax 0%", amount: "$0.00" }],
        total: "$1,000.00",
        note: "You set 0% for Oregon, so the invoice adds no sales tax.",
        share: 0,
      },
    ],
    footnote: "You set the sales tax rate for each state.",
    summary:
      "A seller in the United States sells a $1,000 plan. The business sets the sales tax rate for each state. The customer in California pays the 7.25% rate that the business set, so the total is $1,072.50. The business set 0% for Oregon, so the customer in Oregon pays $1,000.",
  },
  {
    tab: "EU VAT",
    seller: "Seller · VAT DE123456789",
    plan: "Larkspur GmbH · Growth plan €1,000",
    price: "€1,000.00",
    who: "Business customer in",
    buyers: [
      {
        where: "France",
        rule: "Other EU country",
        lines: [{ label: "VAT 0% · Reverse charge", amount: "€0.00" }],
        total: "€1,000.00",
        note: "The invoice shows the customer's VAT number and your reverse-charge note.",
        share: 0,
      },
      {
        where: "Germany",
        rule: "Same country",
        lines: [{ label: "VAT 19%", amount: "€190.00" }],
        total: "€1,190.00",
        note: "The invoice shows your VAT number and the German rate.",
        share: 19,
      },
    ],
    summary:
      "A seller in Germany sells a €1,000 plan to two business customers. The customer in France gets 0% VAT and a reverse-charge note, so the total is €1,000. The customer in Germany pays 19% VAT, so the total is €1,190.",
  },
  {
    tab: "India GST",
    seller: "Seller in Karnataka · GSTIN 29ABCDE1234F1Z5",
    plan: "Larkspur Pvt Ltd · Growth plan ₹10,000",
    price: "₹10,000.00",
    who: "Customer in",
    buyers: [
      {
        where: "Karnataka",
        rule: "Same state",
        lines: [
          { label: "CGST 9%", amount: "₹900.00" },
          { label: "SGST 9%", amount: "₹900.00" },
        ],
        total: "₹11,800.00",
        note: "The supply is in your state, so the invoice shows CGST and SGST.",
        share: 18,
      },
      {
        where: "Maharashtra",
        rule: "Other state",
        lines: [{ label: "IGST 18%", amount: "₹1,800.00" }],
        total: "₹11,800.00",
        note: "The supply goes to another state, so the invoice shows IGST.",
        share: 18,
      },
    ],
    summary:
      "A seller in Karnataka sells a ₹10,000 plan. The customer in Karnataka pays CGST 9% and SGST 9%, ₹900 each. The customer in Maharashtra pays IGST 18%, ₹1,800. Both totals are ₹11,800.",
  },
];

const uid = useId();
const active = ref(0);
const picked = ref(false);
const onScreen = ref(true);
const root = ref<HTMLElement>();
const tabs: HTMLButtonElement[] = [];

function select(i: number, focus = false) {
  active.value = i;
  picked.value = true;
  if (focus) tabs[i]?.focus();
}

function onKey(e: KeyboardEvent, i: number) {
  const n = slides.length;
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
  if (!picked.value) active.value = (active.value + 1) % slides.length;
}

let io: IntersectionObserver | undefined;
onMounted(() => {
  if (!root.value) return;
  io = new IntersectionObserver(([e]) => (onScreen.value = !!e?.isIntersecting), {
    threshold: 0.3,
  });
  io.observe(root.value);
});
onBeforeUnmount(() => io?.disconnect());
</script>

<template>
  <MkReveal>
    <div ref="root" class="tx" :class="{ 'tx-paused': !onScreen }">
      <div role="tablist" aria-label="Tax examples" class="tx-tabs">
        <button
          v-for="(s, i) in slides"
          :id="`${uid}-tab-${i}`"
          :key="s.tab"
          :ref="(el) => (tabs[i] = el as HTMLButtonElement)"
          type="button"
          role="tab"
          class="tx-tab"
          :aria-selected="i === active"
          :aria-controls="`${uid}-panel-${i}`"
          :tabindex="i === active ? 0 : -1"
          @click="select(i)"
          @keydown="onKey($event, i)"
        >
          {{ s.tab }}
        </button>
      </div>

      <div class="mk-surface tx-card mt-3">
        <span class="tx-track" aria-hidden="true">
          <span
            :key="`${active}-${picked}`"
            class="tx-bar"
            :class="{ 'tx-run': !picked }"
            data-motion
            @animationend="advance"
          />
        </span>
        <div class="tx-stack p-4 sm:p-6">
          <div
            v-for="(s, i) in slides"
            :id="`${uid}-panel-${i}`"
            :key="s.tab"
            role="tabpanel"
            :aria-labelledby="`${uid}-tab-${i}`"
            :tabindex="i === active ? 0 : -1"
            class="tx-slide"
            :class="{ 'tx-on': i === active }"
          >
            <p class="sr-only">{{ s.summary }}</p>
            <div aria-hidden="true">
              <div class="mx-auto w-fit rounded-xl bg-elevated px-4 py-2.5 text-center">
                <div class="text-xs text-muted">{{ s.seller }}</div>
                <div class="text-sm font-semibold text-highlighted">{{ s.plan }}</div>
              </div>
              <div class="tx-branch mx-auto" />
              <div class="grid gap-4 sm:grid-cols-2">
                <div
                  v-for="b in s.buyers"
                  :key="b.where"
                  class="flex flex-col rounded-xl border border-default bg-elevated/40 p-4"
                >
                  <div class="text-xs text-muted">{{ s.who }}</div>
                  <div class="font-semibold text-highlighted">{{ b.where }}</div>
                  <span
                    class="mt-1 inline-block w-fit rounded-full border border-default px-2 py-0.5 text-xs text-primary"
                    >{{ b.rule }}</span
                  >
                  <div class="tx-meter mt-4">
                    <span class="tx-fill" :style="{ width: `${(100 * 100) / (100 + b.share)}%` }" />
                    <span
                      v-if="b.share"
                      class="tx-tax"
                      :style="{ width: `${(100 * b.share) / (100 + b.share)}%` }"
                    />
                  </div>
                  <div class="mt-3 flex justify-between text-sm tabular-nums">
                    <span class="text-toned">Growth plan</span
                    ><span class="text-toned">{{ s.price }}</span>
                  </div>
                  <div
                    v-for="l in b.lines"
                    :key="l.label"
                    class="mt-1 flex justify-between gap-3 text-sm tabular-nums"
                  >
                    <span class="text-toned">{{ l.label }}</span
                    ><span class="text-toned">{{ l.amount }}</span>
                  </div>
                  <div
                    class="mt-2 flex justify-between border-t border-default pt-2 text-sm font-semibold text-highlighted tabular-nums"
                  >
                    <span>Total</span><span>{{ b.total }}</span>
                  </div>
                  <p class="mt-2.5 text-xs leading-normal text-muted">{{ b.note }}</p>
                </div>
              </div>
              <p v-if="s.footnote" class="mt-4 text-center text-xs text-muted">
                {{ s.footnote }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div class="tx-dots mt-3" aria-hidden="true">
        <span v-for="(s, i) in slides" :key="s.tab" :class="{ 'tx-dot-on': i === active }" />
      </div>
    </div>
  </MkReveal>
</template>

<style scoped>
.tx-tabs {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.375rem;
}
.tx-tab {
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--mk-card);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ui-text-muted);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}
.tx-tab:hover {
  color: var(--ui-text-highlighted);
}
.tx-tab:focus-visible,
.tx-slide:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.tx-tab[aria-selected="true"] {
  border-color: var(--mk-accent-line);
  background: var(--mk-accent-soft);
  font-weight: 600;
  color: var(--ui-primary);
}
.tx-card {
  position: relative;
  overflow: hidden;
}
.tx-track {
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: var(--mk-accent-soft);
}
.tx-bar {
  display: block;
  height: 3px;
  background: var(--mk-accent);
  transform-origin: left center;
}
.tx-run {
  animation: mk-fill 6s linear both;
}
/* Hold the bar while the reader looks at the card or is off screen. */
.tx:hover .tx-run,
.tx:focus-within .tx-run,
.tx-paused .tx-run {
  animation-play-state: paused;
}
/* All slides share one cell, so the card keeps the height of the tallest. */
.tx-stack {
  display: grid;
}
.tx-slide {
  grid-area: 1 / 1;
  visibility: hidden;
  opacity: 0;
  transition:
    opacity 0.3s ease,
    visibility 0s linear 0.3s;
}
.tx-on {
  visibility: visible;
  opacity: 1;
  transition: opacity 0.3s ease;
}
.tx-branch {
  width: 50%;
  height: 1.5rem;
  margin-bottom: 0.25rem;
  border: 1px solid var(--ui-border-accented);
  border-bottom: 0;
  border-radius: 10px 10px 0 0;
  margin-top: 0.75rem;
}
.tx-meter {
  display: flex;
  gap: 2px;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
}
.tx-fill {
  background: var(--mk-accent);
}
.tx-tax {
  background: color-mix(in oklab, var(--mk-accent) 45%, transparent);
}
.tx-dots {
  display: flex;
  justify-content: center;
  gap: 0.375rem;
}
.tx-dots span {
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 999px;
  background: var(--ui-border-accented);
  transition:
    width 0.2s ease,
    background-color 0.2s ease;
}
.tx-dots .tx-dot-on {
  width: 1.25rem;
  background: var(--mk-accent);
}
@media (max-width: 640px) {
  .tx-branch {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .tx-run {
    animation: none;
  }
  .tx-slide,
  .tx-on {
    transition: none;
  }
}
</style>
