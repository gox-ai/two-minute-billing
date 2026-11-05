<script setup lang="ts">
/**
 * The homepage hero: three ways to bill, played in turn (AI pricing, a subscription, a one-time
 * order), with the money rail beside them: what the engine did, the charge in the merchant's own
 * gateway, the payout to their bank and our flat fee. AI pricing shows MuseLane AI's own app
 * (its warm orange, not our indigo) generating text and an image, with our usage widget in it;
 * the customer never sees the margin, only the engine card does.
 * The other two play in our checkout and portal screens. Every figure matches the real product.
 *
 * A pointer glides to the control behind each beat and clicks it: in MuseLane AI the prompt,
 * Generate (text), the Image tab and Generate (image); then Subscribe, Confirm change, the
 * quantity + and Pay. Beats with no control (credit draw-down, top-up,
 * renewal) play with the pointer still. It is hidden on phones, in the still and under reduced
 * motion.
 *
 * The story buttons and the pause button sit above the board, outside MkIll's role="img", so
 * they stay focusable. Hover on the board, or keyboard focus on a button, holds the loop;
 * reduced motion starts paused on the AI pricing still.
 *
 * MkIll scales the 1240x668 board to the slot and stacks it below 700px, where the screens
 * drop out and one line of what happened and the rail remain (all CSS, so the server-rendered
 * page is already right). The timeline runs in the browser only.
 */
import MkIll from "./MkIll.vue";
import PartnerLogo from "~/components/content/PartnerLogo.vue";

/** The AI pricing margin frame: the still for the server render and for reduced motion. */
const STILL = "story-3 stg-3 s-ai ai-4 ai-t pt";

/** One loop of the three stories, as [seconds from loop start, state classes]. The first frame
 * of each story keeps the last story's classes, so the outgoing screen holds while it fades.
 * Cursor: `cu` shows it, `c-*` is where it glides to, `cs` snaps it there (each story's first
 * frame, so a story jump never leaves it mid-glide), `cp` presses it and `ck` plays the ripple. */
const S1 = "story-1 ";
const S2 = "story-2 ";
const S3 = "story-3 ";
const FRAMES: [number, string | null][] = [
  [0.0, S3 + "stg-1 s-ai ai-0 cu cs c-ai0 by-q2 by-b by-d"],
  [0.3, S3 + "stg-1 s-ai ai-0 cu c-inp"],
  [0.9, S3 + "stg-1 s-ai ai-0 fo cu cp ck c-inp"],
  [1.1, S3 + "stg-1 s-ai ai-0 fo pt cu ck c-inp"],
  [1.8, S3 + "stg-1 s-ai ai-0 fo pt cu c-gen"],
  [2.4, S3 + "stg-1 s-ai ai-0 pt gp cu cp ck c-gen"],
  [2.6, S3 + "stg-2 s-ai ai-1 pt cu ck c-gen"],
  [3.1, S3 + "stg-2 s-ai ai-2 pt cu c-img"],
  [3.7, S3 + "stg-2 s-ai ai-2 pt ip cu cp ck c-img"],
  [3.9, S3 + "stg-2 s-ai ai-2 im pi cu ck c-img"],
  [4.6, S3 + "stg-2 s-ai ai-2 im pi cu c-gen"],
  [5.2, S3 + "stg-2 s-ai ai-2 im pi gp cu cp ck c-gen"],
  [5.4, S3 + "stg-2 s-ai ai-3 im pi cu ck c-gen"],
  [5.9, S3 + "stg-2 s-ai ai-4 im pi cu c-ai1"],
  [6.6, S3 + "stg-2 s-ai ai-4 ai-t im pi cu c-ai1"],
  [8.1, S3 + "stg-3 s-ai ai-4 ai-t im pi cu c-ai1"],
  [9.7, S1 + "stg-1 s-co cu cs c-co0 ai-4 ai-t im pi"],
  [10.0, S1 + "stg-1 s-co co-t cu c-co0"],
  [10.9, S1 + "stg-1 s-co co-t cu c-sub"],
  [11.5, S1 + "stg-1 s-co co-t co-pr cu cp ck c-sub"],
  [11.75, S1 + "stg-1 s-co co-t co-b cu ck c-sub"],
  [12.3, S1 + "stg-1 s-co co-t co-b co-d cu c-co1"],
  [13.8, S1 + "stg-3 s-pt co-t co-b co-d cu c-co1"],
  [14.2, S1 + "stg-3 s-pt pt-r co-t co-b co-d cu c-co1"],
  [15.5, S1 + "stg-4 s-ch pt-r ch-sc cu c-co1"],
  [16.0, S1 + "stg-4 s-ch pt-r ch-sc cu c-conf"],
  [16.7, S1 + "stg-4 s-ch pt-r ch-sc ch-pr cu cp ck c-conf"],
  [16.95, S1 + "stg-4 s-ch pt-r ch-sc ch-b cu ck c-conf"],
  [17.5, S1 + "stg-4 s-ch pt-r ch-sc ch-b ch-d cu c-ch1"],
  [19.0, S2 + "stg-1 s-by cu cs c-by0 ch-sc ch-b ch-d"],
  [19.3, S2 + "stg-1 s-by cu c-plus"],
  [19.9, S2 + "stg-1 s-by by-pp cu cp ck c-plus"],
  [20.1, S2 + "stg-1 s-by by-q2 cu ck c-plus"],
  [20.6, S2 + "stg-1 s-by by-q2 cu c-pay"],
  [21.2, S2 + "stg-2 s-by by-q2 by-pr cu cp ck c-pay"],
  [21.45, S2 + "stg-2 s-by by-q2 by-b cu ck c-pay"],
  [22.0, S2 + "stg-2 s-by by-q2 by-b by-d cu c-by1"],
  [23.7, null],
];

/** The story buttons, in play order. Steps are [label, stage number]. */
const STORIES = [
  {
    n: 3,
    label: "AI pricing",
    steps: [
      ["Price", 1],
      ["Credits", 2],
      ["Margin", 3],
    ],
    still: STILL,
  },
  {
    n: 1,
    label: "Subscription",
    steps: [
      ["Subscribe", 1],
      ["Renewal", 3],
      ["Upgrade", 4],
    ],
    still: "story-1 stg-3 s-pt pt-r co-t co-b co-d",
  },
  {
    n: 2,
    label: "One-time order",
    steps: [
      ["Order", 1],
      ["Pay", 2],
    ],
    still: "story-2 stg-2 s-by by-q2 by-b by-d",
  },
] as const;

const state = ref(STILL);
const cls = computed(() =>
  state.value
    .split(" ")
    .filter(Boolean)
    .map((t) => `hx-${t}`)
    .join(" "),
);
const cur = computed(() => Number(/story-(\d)/.exec(state.value)?.[1]));
const stg = computed(() => Number(/stg-(\d)/.exec(state.value)?.[1]));

/** Paused with the button (or by reduced motion). */
const paused = ref(false);
const root = ref<{ $el: HTMLElement } | null>(null);
let i = 0; // the frame to play from
let stale = true; // the screen shows a still, not FRAMES[i]
let timer: ReturnType<typeof setTimeout> | undefined;
let visible = false;
let hovered = false;
let focused = false;
let io: IntersectionObserver | undefined;

const running = () => visible && !paused.value && !hovered && !focused;

function show(k: number) {
  i = FRAMES[k]![1] === null ? 0 : k;
  state.value = FRAMES[i]![1]!;
  stale = false;
}

/** One timer at most: every change of course clears it first. */
function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (!running()) return;
  if (stale) show(i);
  timer = setTimeout(
    () => {
      timer = undefined;
      show(i + 1);
      schedule();
    },
    (FRAMES[i + 1]![0] - FRAMES[i]![0]) * 1000,
  );
}

/** Jump to a story's first frame; paused, show its still and play from its start later. */
function pick(n: number) {
  const k = FRAMES.findIndex((f) => f[1]?.startsWith(`story-${n} `));
  const s = STORIES.find((x) => x.n === n)!;
  if (running()) {
    show(k);
  } else {
    i = k;
    state.value = s.still;
    stale = true;
  }
  schedule();
}

function toggle() {
  paused.value = !paused.value;
  schedule();
}
function onHover(on: boolean) {
  hovered = on;
  schedule();
}
/** Hold for keyboard focus only: a mouse click on a story button must not freeze it. */
function onFocusIn(e: FocusEvent) {
  focused = (e.target as HTMLElement | null)?.matches?.(":focus-visible") ?? false;
  schedule();
}
function onFocusOut() {
  focused = false;
  schedule();
}

onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) paused.value = true;
  const el = root.value?.$el;
  if (!el || !window.IntersectionObserver) return;
  // Play only while the hero is on screen; resume where it paused.
  io = new IntersectionObserver(
    ([e]) => {
      visible = !!e?.isIntersecting;
      schedule();
    },
    { threshold: 0.15 },
  );
  io.observe(el);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  timer = undefined;
  io?.disconnect();
});

/** Our cheapest monthly price in the build's currency, from the catalogue. */
const { data: plans } = await useFetch("/api/plans", { key: "plans" });
const fee = computed(() => {
  const monthly = (plans.value?.plans ?? []).filter(
    (p) => p.interval === "month" && p.currency === plans.value?.preferred,
  );
  const low = monthly[0]; // the API sorts by amount
  if (!low) return undefined;
  return new Intl.NumberFormat(low.currency === "INR" ? "en-IN" : "en", {
    style: "currency",
    currency: low.currency,
    maximumFractionDigits: low.amountMinor % 100 === 0 ? 0 : 2,
  }).format(low.amountMinor / 100);
});
</script>

<template>
  <div class="hx-hero" :class="{ 'hx-held': paused }" @focusin="onFocusIn" @focusout="onFocusOut">
    <div class="hx-ctl">
      <div class="hx-tabs" role="group" aria-label="Ways to bill">
        <button
          v-for="s in STORIES"
          :key="s.n"
          type="button"
          class="hx-tab"
          :aria-pressed="cur === s.n"
          @click="pick(s.n)"
        >
          {{ s.label }}
        </button>
      </div>
      <i class="hx-vsep" aria-hidden="true"></i>
      <span class="hx-stages" aria-hidden="true"
        ><span v-for="s in STORIES" :key="s.n" class="hx-stg-grp" :class="{ 'hx-on': cur === s.n }"
          ><template v-for="(st, k) in s.steps" :key="st[0]"
            ><i v-if="k" class="hx-sep"></i
            ><span class="hx-sg" :class="{ 'hx-on': cur === s.n && stg === st[1] }">{{
              st[0]
            }}</span></template
          ></span
        ></span
      >
      <button
        type="button"
        class="hx-pp"
        :aria-label="paused ? 'Play animation' : 'Pause animation'"
        @click="toggle"
      >
        <svg v-if="paused" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5v14l11-7z"></path>
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5v14M16 5v14"></path>
        </svg>
      </button>
    </div>
    <MkIll
      ref="root"
      :w="1240"
      :h="668"
      stack
      class="hx-hc"
      :class="cls"
      label="Three ways to bill, in turn. AI pricing: in MuseLane AI's app, Jonah generates text at $3.00 per 1M tokens and an image at $0.06 each; each generation lowers his credit balance, and an automatic top-up adds $50.00. Two Minute Billing prices each call at the model's list price plus 20%, checks credit before each call, and records the model cost: a 40% margin. A subscription: the customer subscribes at checkout, the portal shows a renewal invoice paid, then an upgrade with a prorated charge. A one-time order: two mugs paid at checkout. Beside them, Two Minute Billing asks the merchant's own gateway (Stripe, Adyen or PayPal) to charge, the payment is paid out to their bank, and our fee stays a flat monthly price."
      @mouseenter="onHover(true)"
      @mouseleave="onHover(false)"
    >
      <div class="hx-scene">
        <div class="hx-abs hx-win">
          <div class="hx-scr hx-co">
            <div class="hx-page">
              <div class="hx-shead">
                <div class="hx-brand">
                  <span class="hx-bmark hx-kelp"
                    ><svg viewBox="0 0 24 24">
                      <path d="M4 15c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3"></path>
                      <path d="M4 9c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3"></path></svg
                  ></span>
                  <div>
                    <div class="hx-bname">Kelpwise</div>
                    <div class="hx-bsub">Subscribe to continue.</div>
                  </div>
                </div>
                <span class="hx-cancel">Cancel</span>
              </div>
              <ol class="hx-steps">
                <li class="hx-st">
                  <span class="hx-n"
                    ><i class="hx-chk"
                      ><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg></i></span
                  ><span class="hx-lb"><i class="hx-off-t">Your details</i></span>
                </li>
                <li class="hx-ln"></li>
                <li class="hx-st hx-a">
                  <span class="hx-n"
                    ><i class="hx-num">2</i
                    ><i class="hx-chk hx-x"
                      ><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg></i></span
                  ><span class="hx-lb"
                    ><i class="hx-on-t">Payment</i><i class="hx-off-t hx-x">Payment</i></span
                  >
                </li>
                <li class="hx-ln"></li>
                <li class="hx-st hx-b">
                  <span class="hx-n"><i class="hx-idle">3</i><i class="hx-fill hx-x">3</i></span
                  ><span class="hx-lb"
                    ><i class="hx-off-t">Confirmation</i
                    ><i class="hx-on-t hx-x">Confirmation</i></span
                  >
                </li>
              </ol>
              <div class="hx-panes">
                <div class="hx-left">
                  <div class="hx-form">
                    <div class="hx-sec">
                      <div class="hx-sh">Your details<span class="hx-lnk">Edit</span></div>
                      <div class="hx-sb hx-tight">
                        <div class="hx-strong">Ana Ruiz · Harbor Pine Studio</div>
                        <div class="hx-mut">ana.ruiz@example.com</div>
                        <div class="hx-mut">1610 Capitol Ave, Sacramento, 95814, US</div>
                      </div>
                    </div>
                    <div class="hx-sec">
                      <div class="hx-sh">Payment</div>
                      <div class="hx-sb">
                        <p class="hx-note">
                          Your card details go directly to Stripe. They never reach this page or our
                          servers.
                        </p>
                        <div class="hx-sf">
                          <div>
                            <label>Card number</label>
                            <div class="hx-in">
                              <span class="hx-ph hx-p-card">1234 1234 1234 1234</span
                              ><span class="hx-val"
                                ><b class="hx-g0">••••</b><b class="hx-g1"> ••••</b
                                ><b class="hx-g2"> ••••</b><b class="hx-g3"> 4242</b></span
                              ><b class="hx-visa">VISA</b><i class="hx-ring hx-r-card"></i>
                            </div>
                          </div>
                          <div class="hx-two">
                            <div>
                              <label>Expiration date</label>
                              <div class="hx-in">
                                <span class="hx-ph hx-p-exp">MM / YY</span
                                ><span class="hx-val"
                                  ><b class="hx-e1">12</b><b class="hx-e2"> / 28</b></span
                                ><i class="hx-ring hx-r-exp"></i>
                              </div>
                            </div>
                            <div>
                              <label>Security code</label>
                              <div class="hx-in">
                                <span class="hx-ph hx-p-cvc">CVC</span
                                ><span class="hx-val"><b class="hx-cv">•••</b></span
                                ><i class="hx-ring hx-r-cvc"></i>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div class="hx-commit">
                          <span class="hx-lnk hx-sm">Edit billing details</span
                          ><span class="hx-btn"
                            ><i class="hx-l0">Subscribe</i
                            ><i class="hx-l1 hx-x">Subscribing…</i></span
                          >
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="hx-notice hx-sec">
                    <div class="hx-nc">
                      <span class="hx-ic"
                        ><svg viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10"></circle>
                          <path d="m9 12 2 2 4-4"></path></svg
                      ></span>
                      <div class="hx-t">Everything is complete</div>
                      <div class="hx-b">
                        <p>Your subscription is now active. Thank you!</p>
                        <p class="hx-id">
                          Subscription <span class="hx-mono">sub_XXXXXXXXXXXX01</span>
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="hx-sec hx-rail">
                  <div class="hx-sh">Your plan</div>
                  <div class="hx-item">
                    <span class="hx-glyph"
                      ><svg viewBox="0 0 24 24">
                        <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"></path>
                        <path d="m3 8 9 5 9-5M12 13v8"></path></svg
                    ></span>
                    <div>
                      <div class="hx-nm">Team</div>
                      <div class="hx-kd">Plan · USD</div>
                    </div>
                    <span class="hx-am">USD 39.00 / month</span>
                  </div>
                  <div class="hx-due">
                    <div class="hx-row2">
                      <b class="hx-k2">Due today</b><b class="hx-big">$41.83</b>
                    </div>
                    <p class="hx-ft">Includes $2.83 tax, and any one-time items.</p>
                  </div>
                  <div class="hx-per">
                    <div class="hx-k">Each billing period</div>
                    <div class="hx-row2">
                      <b class="hx-tl">Total per period</b><b class="hx-big">$41.83</b>
                    </div>
                    <div class="hx-t"><b>includes California sales tax 7.25%</b><b>$2.83</b></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="hx-scr hx-pt">
            <div class="hx-page">
              <div class="hx-shead">
                <div class="hx-brand">
                  <span class="hx-bmark hx-kelp"
                    ><svg viewBox="0 0 24 24">
                      <path d="M4 15c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3"></path>
                      <path d="M4 9c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3"></path></svg
                  ></span>
                  <div>
                    <div class="hx-bname">Kelpwise</div>
                    <div class="hx-eyebrow">Billing portal</div>
                  </div>
                </div>
                <div class="hx-who">
                  <div class="hx-strong">Ana Ruiz</div>
                  <div class="hx-mut hx-xs">ana.ruiz@example.com</div>
                  <div class="hx-so">
                    <svg viewBox="0 0 24 24">
                      <path
                        d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
                      ></path></svg
                    >Sign out
                  </div>
                </div>
              </div>
              <div class="hx-ppanes">
                <div class="hx-pcol">
                  <div class="hx-sec">
                    <div class="hx-bal">
                      <span class="hx-okc"
                        ><svg viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10"></circle>
                          <path d="m9 12 2 2 4-4"></path></svg
                      ></span>
                      <div>
                        <div class="hx-bt">Everything is paid</div>
                        <p class="hx-bp">
                          <span class="hx-stack"
                            ><i class="hx-v-a"
                              >No balance due. Last payment $41.83 on 21-Oct-2026.</i
                            ><i class="hx-v-b hx-x"
                              >No balance due. Last payment $41.83 on 21-Nov-2026.</i
                            ></span
                          >
                        </p>
                      </div>
                    </div>
                    <div class="hx-meta">
                      <div>
                        <div class="hx-mk">Billed to</div>
                        <div class="hx-strong">Ana Ruiz</div>
                        <div class="hx-mut hx-xs">ana.ruiz@example.com</div>
                      </div>
                      <div>
                        <div class="hx-mk">Primary payment method</div>
                        <div class="hx-pm">
                          <span class="hx-visa hx-sm">VISA</span
                          ><span class="hx-strong">Visa •••• 4242</span
                          ><span class="hx-mut hx-xs">12/2028</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="hx-sec">
                    <div class="hx-sh hx-col">
                      Invoices<span class="hx-desc"
                        >Pay an open invoice or download a PDF for your records.</span
                      >
                    </div>
                    <div class="hx-ilist">
                      <div class="hx-irow hx-new">
                        <span class="hx-glyph"
                          ><svg viewBox="0 0 24 24">
                            <path
                              d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                            ></path>
                            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"></path></svg
                        ></span>
                        <div class="hx-grow">
                          <div class="hx-ttl">
                            KW-1187<span class="hx-badge"><i></i>Paid</span>
                          </div>
                          <div class="hx-kd">21-Nov-2026 · paid 21-Nov-2026</div>
                        </div>
                        <div class="hx-amt">$41.83</div>
                        <span class="hx-obtn"
                          ><svg viewBox="0 0 24 24">
                            <path d="M12 15V3"></path>
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <path d="m7 10 5 5 5-5"></path></svg
                          >PDF</span
                        >
                      </div>
                      <div class="hx-irow hx-old">
                        <span class="hx-glyph"
                          ><svg viewBox="0 0 24 24">
                            <path
                              d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                            ></path>
                            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"></path></svg
                        ></span>
                        <div class="hx-grow">
                          <div class="hx-ttl">
                            KW-1041<span class="hx-badge"><i></i>Paid</span>
                          </div>
                          <div class="hx-kd">21-Oct-2026 · paid 21-Oct-2026</div>
                        </div>
                        <div class="hx-amt">$41.83</div>
                        <span class="hx-obtn"
                          ><svg viewBox="0 0 24 24">
                            <path d="M12 15V3"></path>
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <path d="m7 10 5 5 5-5"></path></svg
                          >PDF</span
                        >
                      </div>
                    </div>
                  </div>
                </div>
                <div class="hx-pcol">
                  <div class="hx-pills">
                    <span class="hx-pill hx-on">Your plan</span
                    ><span class="hx-pill">Payment methods</span
                    ><span class="hx-pill">Billing details</span>
                  </div>
                  <div class="hx-sec">
                    <div class="hx-sh hx-col2">
                      <span class="hx-desc"
                        >Your subscription and the next payment that we collect.</span
                      ><span class="hx-badge"><i></i>Active</span>
                    </div>
                    <div class="hx-item">
                      <span class="hx-glyph"
                        ><svg viewBox="0 0 24 24">
                          <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"></path>
                          <path d="m3 8 9 5 9-5M12 13v8"></path></svg
                      ></span>
                      <div>
                        <div class="hx-nm">Team</div>
                        <div class="hx-kd">Plan</div>
                      </div>
                      <span class="hx-am hx-n">$39.00 / month</span>
                    </div>
                    <div class="hx-per hx-np">
                      <div class="hx-k">Next payment</div>
                      <div class="hx-row2">
                        <b class="hx-tl"
                          ><span class="hx-stack"
                            ><i class="hx-v-a">21-Nov-2026</i
                            ><i class="hx-v-b hx-x">21-Dec-2026</i></span
                          ></b
                        ><b class="hx-big">$41.83</b>
                      </div>
                      <div class="hx-t"><b>includes California sales tax 7.25%</b><b>$2.83</b></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="hx-scr hx-ai">
            <div class="hx-page">
              <div class="hx-shead">
                <div class="hx-brand">
                  <span class="hx-bmark hx-muse"
                    ><svg viewBox="0 0 24 24">
                      <path
                        d="M10 3.5l1.7 4.8 4.8 1.7-4.8 1.7L10 16.5l-1.7-4.8L3.5 10l4.8-1.7z"
                      ></path>
                      <circle cx="18" cy="18" r="2.2" fill="#c2410c"></circle></svg
                  ></span>
                  <div>
                    <div class="hx-bname">MuseLane AI</div>
                    <div class="hx-eyebrow">Your workspace</div>
                  </div>
                </div>
                <div class="hx-who">
                  <div class="hx-strong">Jonah Reyes</div>
                  <div class="hx-mut hx-xs">jonah@example.com</div>
                </div>
              </div>
              <div class="hx-apanes">
                <!-- MuseLane AI's own app, in its own warm style: compose, generate, its models
                     and prices, and its credit check. -->
                <div class="hx-sec hx-doc">
                  <div class="hx-sh">
                    <span class="hx-dtl">Spring newsletter</span
                    ><span class="hx-seg"
                      ><i class="hx-sgt">Text</i><i class="hx-sgi">Image</i></span
                    >
                  </div>
                  <div class="hx-cmp">
                    <div class="hx-inp">
                      <span class="hx-ph2">Describe what you want</span
                      ><span class="hx-ptt">Write an intro for our spring sale</span
                      ><span class="hx-pti">Cover image: a spring garden</span>
                    </div>
                    <span class="hx-gen"
                      ><svg viewBox="0 0 24 24">
                        <path
                          d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"
                        ></path></svg
                      >Generate</span
                    >
                  </div>
                  <div class="hx-out">
                    <div class="hx-otx">
                      <p class="hx-o1">Spring is here, and so is our biggest sale of the year.</p>
                      <p class="hx-o1">Every seed, pot and tool is 20% off until 30 April.</p>
                      <p class="hx-o2">Orders over $40 ship free.</p>
                      <p class="hx-o2">Happy planting!</p>
                    </div>
                    <div class="hx-oim">
                      <svg viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice">
                        <defs>
                          <linearGradient id="hx-sky" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0" style="stop-color: var(--im-sky1)"></stop>
                            <stop offset="1" style="stop-color: var(--im-sky2)"></stop>
                          </linearGradient>
                        </defs>
                        <rect width="400" height="150" fill="url(#hx-sky)"></rect>
                        <circle cx="318" cy="42" r="20" style="fill: var(--im-sun)"></circle>
                        <circle
                          cx="318"
                          cy="42"
                          r="30"
                          style="fill: var(--im-sun)"
                          opacity="0.3"
                        ></circle>
                        <path
                          d="M0 112 Q90 84 190 104 T400 96 V150 H0Z"
                          style="fill: var(--im-hill1)"
                        ></path>
                        <path
                          d="M0 128 Q120 108 240 124 T400 120 V150 H0Z"
                          style="fill: var(--im-hill2)"
                        ></path>
                        <g style="stroke: var(--im-stem)" stroke-width="2.5" stroke-linecap="round">
                          <path
                            d="M60 130 V104M110 134 V100M162 132 V108M232 136 V104M286 134 V110M344 136 V106"
                          ></path>
                        </g>
                        <g style="fill: var(--im-stem)">
                          <ellipse
                            cx="54"
                            cy="118"
                            rx="7"
                            ry="3.5"
                            transform="rotate(-30 54 118)"
                          ></ellipse>
                          <ellipse
                            cx="117"
                            cy="116"
                            rx="7"
                            ry="3.5"
                            transform="rotate(30 117 116)"
                          ></ellipse>
                          <ellipse
                            cx="226"
                            cy="120"
                            rx="7"
                            ry="3.5"
                            transform="rotate(-30 226 120)"
                          ></ellipse>
                          <ellipse
                            cx="350"
                            cy="120"
                            rx="7"
                            ry="3.5"
                            transform="rotate(30 350 120)"
                          ></ellipse>
                        </g>
                        <g>
                          <circle cx="60" cy="100" r="8" style="fill: var(--im-fl1)"></circle>
                          <circle cx="110" cy="96" r="9" style="fill: var(--im-fl2)"></circle>
                          <circle cx="162" cy="104" r="7" style="fill: var(--im-fl1)"></circle>
                          <circle cx="232" cy="100" r="9" style="fill: var(--im-fl1)"></circle>
                          <circle cx="286" cy="106" r="7" style="fill: var(--im-fl2)"></circle>
                          <circle cx="344" cy="102" r="8" style="fill: var(--im-fl2)"></circle>
                        </g>
                        <g style="fill: var(--im-dot)">
                          <circle cx="60" cy="100" r="3"></circle>
                          <circle cx="110" cy="96" r="3.2"></circle>
                          <circle cx="162" cy="104" r="2.6"></circle>
                          <circle cx="232" cy="100" r="3.2"></circle>
                          <circle cx="286" cy="106" r="2.6"></circle>
                          <circle cx="344" cy="102" r="3"></circle>
                        </g>
                      </svg>
                    </div>
                  </div>
                  <div class="hx-item hx-model">
                    <span class="hx-glyph"
                      ><svg viewBox="0 0 24 24">
                        <path
                          d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"
                        ></path></svg
                    ></span>
                    <div>
                      <div class="hx-nm">
                        <span class="hx-mv"
                          ><i class="hx-mt">small-v1</i><i class="hx-mi">image-v1</i></span
                        >
                      </div>
                      <div class="hx-kd">
                        <span class="hx-mv"
                          ><i class="hx-mt">Text model</i><i class="hx-mi">Image model</i></span
                        >
                      </div>
                    </div>
                    <span class="hx-am"
                      ><span class="hx-mv"
                        ><i class="hx-mt">$3.00 per 1M tokens</i
                        ><i class="hx-mi">$0.06 per image</i></span
                      ></span
                    >
                  </div>
                  <div class="hx-gate">
                    <span>Check before each call</span><span class="hx-badge"><i></i>Allowed</span>
                  </div>
                </div>
                <!-- Our usage widget, embedded: only the fields it renders. -->
                <div class="hx-sec hx-wdg">
                  <p class="hx-wt">Credit balance</p>
                  <div class="hx-wbig">
                    <span class="hx-av"
                      ><i class="hx-ab0">$42.00</i><i class="hx-ab1">$33.00</i
                      ><i class="hx-ab2">$24.00</i><i class="hx-ab3">$16.50</i
                      ><i class="hx-ab4">$9.00</i><i class="hx-ab5">$59.00</i></span
                    >
                  </div>
                  <div class="hx-wmut">Automatic top-up adds $50.00 when the balance is $10.00</div>
                  <div class="hx-wsec">
                    <p class="hx-wt">Usage this period</p>
                    <div class="hx-wrow">
                      <span class="hx-wlb">small-v1 tokens</span
                      ><span class="hx-av"
                        ><i class="hx-at0">$0.00</i><i class="hx-at1">$9.00</i
                        ><i class="hx-at2">$18.00</i></span
                      >
                    </div>
                    <div class="hx-wrow">
                      <span class="hx-wlb">image-v1 images</span
                      ><span class="hx-av"
                        ><i class="hx-ag0">$0.00</i><i class="hx-ag1">$7.50</i
                        ><i class="hx-ag2">$15.00</i></span
                      >
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="hx-scr hx-ch">
            <div class="hx-page hx-scroll">
              <div class="hx-shead">
                <div class="hx-brand">
                  <span class="hx-bmark hx-kelp"
                    ><svg viewBox="0 0 24 24">
                      <path d="M4 15c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3"></path>
                      <path d="M4 9c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3"></path></svg
                  ></span>
                  <div>
                    <div class="hx-bname">Kelpwise</div>
                    <div class="hx-bsub">Review and confirm your plan change.</div>
                  </div>
                </div>
                <span class="hx-cancel">Cancel</span>
              </div>
              <ol class="hx-steps">
                <li class="hx-st hx-a">
                  <span class="hx-n"
                    ><i class="hx-num">1</i
                    ><i class="hx-chk hx-x"
                      ><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg></i></span
                  ><span class="hx-lb"
                    ><i class="hx-on-t">Review</i><i class="hx-off-t hx-x">Review</i></span
                  >
                </li>
                <li class="hx-ln"></li>
                <li class="hx-st hx-b">
                  <span class="hx-n"><i class="hx-idle">2</i><i class="hx-fill hx-x">2</i></span
                  ><span class="hx-lb"
                    ><i class="hx-off-t">Confirmation</i
                    ><i class="hx-on-t hx-x">Confirmation</i></span
                  >
                </li>
              </ol>
              <div class="hx-panes">
                <div class="hx-left">
                  <div class="hx-form">
                    <div class="hx-sec">
                      <div class="hx-sh">Confirm</div>
                      <div class="hx-sb">
                        <p class="hx-body">
                          Your plan changes when you confirm. We charge
                          <b class="hx-strong">Visa •••• 4242</b>.
                        </p>
                        <div class="hx-commit hx-left">
                          <span class="hx-btn"
                            ><i class="hx-l0">Confirm change</i
                            ><i class="hx-l1 hx-x">Confirming…</i></span
                          >
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="hx-notice hx-sec">
                    <div class="hx-nc">
                      <span class="hx-ic"
                        ><svg viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10"></circle>
                          <path d="m9 12 2 2 4-4"></path></svg
                      ></span>
                      <div class="hx-t">Everything is complete</div>
                      <div class="hx-b">
                        <p>Your plan is changed. Thank you!</p>
                        <p class="hx-id">
                          Subscription <span class="hx-mono">sub_XXXXXXXXXXXX01</span>
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="hx-rails">
                  <div class="hx-sec hx-rail">
                    <div class="hx-sh">Your plan change</div>
                    <div class="hx-item hx-cur">
                      <span class="hx-glyph"
                        ><svg viewBox="0 0 24 24">
                          <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"></path>
                          <path d="m3 8 9 5 9-5M12 13v8"></path></svg
                      ></span>
                      <div>
                        <div class="hx-nm hx-s">Team</div>
                        <div class="hx-kd">Current plan</div>
                      </div>
                      <span class="hx-am hx-s">USD 39.00 / month</span>
                    </div>
                    <div class="hx-item">
                      <span class="hx-glyph"
                        ><svg viewBox="0 0 24 24">
                          <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"></path>
                          <path d="m3 8 9 5 9-5M12 13v8"></path></svg
                      ></span>
                      <div>
                        <div class="hx-nm">Business</div>
                        <div class="hx-kd">New plan · USD</div>
                      </div>
                      <span class="hx-am">USD 99.00 / month</span>
                    </div>
                    <div class="hx-per">
                      <div class="hx-k">From your next payment</div>
                      <div class="hx-row2">
                        <b class="hx-tl">Your plan costs</b><b class="hx-big">$106.18</b>
                      </div>
                      <div class="hx-t"><b>includes California sales tax 7.25%</b><b>$7.18</b></div>
                    </div>
                  </div>
                  <div class="hx-sec hx-rail">
                    <div class="hx-sh">Due today</div>
                    <div class="hx-pv">
                      <div class="hx-pl"><span>Unused time on Team ×1</span><b>−$26.00</b></div>
                      <div class="hx-pl">
                        <span>Remaining time on Business ×1</span><b>$66.00</b>
                      </div>
                      <div class="hx-pl hx-rule"><span>Subtotal</span><b>$40.00</b></div>
                      <div class="hx-pl"><span>California sales tax 7.25%</span><b>$2.90</b></div>
                    </div>
                    <div class="hx-pf"><span>Total due now</span><b>$42.90</b></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="hx-scr hx-by">
            <div class="hx-page">
              <div class="hx-shead">
                <div class="hx-brand">
                  <span class="hx-bmark hx-lark"
                    ><svg viewBox="0 0 24 24">
                      <path d="M5 9h12v5a6 6 0 0 1-12 0z"></path>
                      <path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"></path></svg
                  ></span>
                  <div>
                    <div class="hx-bname">Larkmoor Ceramics</div>
                    <div class="hx-bsub">Complete your purchase.</div>
                  </div>
                </div>
                <span class="hx-cancel">Cancel</span>
              </div>
              <ol class="hx-steps">
                <li class="hx-st">
                  <span class="hx-n"
                    ><i class="hx-chk"
                      ><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg></i></span
                  ><span class="hx-lb"><i class="hx-off-t">Your details</i></span>
                </li>
                <li class="hx-ln"></li>
                <li class="hx-st hx-a">
                  <span class="hx-n"
                    ><i class="hx-num">2</i
                    ><i class="hx-chk hx-x"
                      ><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"></path></svg></i></span
                  ><span class="hx-lb"
                    ><i class="hx-on-t">Payment</i><i class="hx-off-t hx-x">Payment</i></span
                  >
                </li>
                <li class="hx-ln"></li>
                <li class="hx-st hx-b">
                  <span class="hx-n"><i class="hx-idle">3</i><i class="hx-fill hx-x">3</i></span
                  ><span class="hx-lb"
                    ><i class="hx-off-t">Confirmation</i
                    ><i class="hx-on-t hx-x">Confirmation</i></span
                  >
                </li>
              </ol>
              <div class="hx-panes">
                <div class="hx-left">
                  <div class="hx-form">
                    <div class="hx-sec">
                      <div class="hx-sh">Your details<span class="hx-lnk">Edit</span></div>
                      <div class="hx-sb hx-tight">
                        <div class="hx-strong">Noah Bennett</div>
                        <div class="hx-mut">noah@example.com</div>
                        <div class="hx-mut">414 K St, Sacramento, 95814, US</div>
                        <div class="hx-mut">Ship to: 2730 Capitol Ave, Sacramento, 95816, US</div>
                      </div>
                    </div>
                    <div class="hx-sec">
                      <div class="hx-sh">Payment</div>
                      <div class="hx-sb">
                        <p class="hx-body hx-mut">
                          Select Pay to choose how you pay. Your payment provider opens over this
                          page.
                        </p>
                        <div class="hx-commit hx-end">
                          <span class="hx-btn"
                            ><i class="hx-q1">Pay $19.31</i><i class="hx-q2 hx-x">Pay $38.61</i
                            ><i class="hx-l1 hx-x">Paying…</i></span
                          >
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="hx-notice hx-sec">
                    <div class="hx-nc">
                      <span class="hx-ic"
                        ><svg viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10"></circle>
                          <path d="m9 12 2 2 4-4"></path></svg
                      ></span>
                      <div class="hx-t">Payment received</div>
                      <div class="hx-b">
                        <p>Thank you for your purchase. We will email your receipt.</p>
                        <p class="hx-id">Invoice <span class="hx-mono">LM-2207</span></p>
                        <p class="hx-cont">Continue</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="hx-sec hx-rail">
                  <div class="hx-sh">Your order</div>
                  <div class="hx-item">
                    <span class="hx-glyph"
                      ><svg viewBox="0 0 24 24">
                        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                        <path d="M3 6h18M16 10a4 4 0 0 1-8 0"></path></svg
                    ></span>
                    <div>
                      <div class="hx-nm">Speckled stoneware mug</div>
                      <div class="hx-kd">$18.00 · USD</div>
                    </div>
                    <span class="hx-stepper"
                      ><span class="hx-sbtn">−</span
                      ><span class="hx-qn hx-stack"
                        ><i class="hx-q1">1</i><i class="hx-q2 hx-x">2</i></span
                      ><span class="hx-sbtn hx-plus">+</span></span
                    >
                  </div>
                  <div class="hx-per">
                    <div class="hx-k">Due today</div>
                    <div class="hx-t hx-first">
                      <b>Subtotal</b
                      ><b class="hx-stack"
                        ><i class="hx-q1">$18.00</i><i class="hx-q2 hx-x">$36.00</i></b
                      >
                    </div>
                    <div class="hx-t">
                      <b>California sales tax 7.25%</b
                      ><b class="hx-stack"
                        ><i class="hx-q1">$1.31</i><i class="hx-q2 hx-x">$2.61</i></b
                      >
                    </div>
                    <div class="hx-row2 hx-tot">
                      <b class="hx-k2">Total</b
                      ><b class="hx-big hx-stack"
                        ><i class="hx-q1">$19.31</i><i class="hx-q2 hx-x">$38.61</i></b
                      >
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="hx-scr hx-p2">
            <div class="hx-page">
              <div class="hx-shead">
                <div class="hx-brand">
                  <span class="hx-bmark hx-lark"
                    ><svg viewBox="0 0 24 24">
                      <path d="M5 9h12v5a6 6 0 0 1-12 0z"></path>
                      <path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"></path></svg
                  ></span>
                  <div>
                    <div class="hx-bname">Larkmoor Ceramics</div>
                    <div class="hx-eyebrow">Billing portal</div>
                  </div>
                </div>
                <div class="hx-who">
                  <div class="hx-strong">Noah Bennett</div>
                  <div class="hx-mut hx-xs">noah@example.com</div>
                  <div class="hx-so">
                    <svg viewBox="0 0 24 24">
                      <path
                        d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
                      ></path></svg
                    >Sign out
                  </div>
                </div>
              </div>
              <div class="hx-ppanes">
                <div class="hx-pcol">
                  <div class="hx-sec">
                    <div class="hx-bal">
                      <span class="hx-okc"
                        ><svg viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10"></circle>
                          <path d="m9 12 2 2 4-4"></path></svg
                      ></span>
                      <div>
                        <div class="hx-bt">Everything is paid</div>
                        <p class="hx-bp">No balance due. Last payment $38.61 on 02-Nov-2026.</p>
                      </div>
                    </div>
                    <div class="hx-meta">
                      <div>
                        <div class="hx-mk">Billed to</div>
                        <div class="hx-strong">Noah Bennett</div>
                        <div class="hx-mut hx-xs">noah@example.com</div>
                      </div>
                    </div>
                  </div>
                  <div class="hx-sec">
                    <div class="hx-sh hx-col">
                      Invoices<span class="hx-desc"
                        >Pay an open invoice or download a PDF for your records.</span
                      >
                    </div>
                    <div class="hx-ilist hx-one">
                      <div class="hx-irow">
                        <span class="hx-glyph"
                          ><svg viewBox="0 0 24 24">
                            <path
                              d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                            ></path>
                            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"></path></svg
                        ></span>
                        <div class="hx-grow">
                          <div class="hx-ttl">
                            LM-2207<span class="hx-badge"><i></i>Paid</span>
                          </div>
                          <div class="hx-kd">02-Nov-2026 · paid 02-Nov-2026</div>
                        </div>
                        <div class="hx-amt">$38.61</div>
                        <span class="hx-obtn"
                          ><svg viewBox="0 0 24 24">
                            <path d="M12 15V3"></path>
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <path d="m7 10 5 5 5-5"></path></svg
                          >PDF</span
                        >
                      </div>
                    </div>
                  </div>
                  <div class="hx-sec">
                    <div class="hx-sh hx-col">
                      Purchases<span class="hx-desc"
                        >One-time products that you bought. Download a receipt for each.</span
                      >
                    </div>
                    <div class="hx-ilist hx-one">
                      <div class="hx-irow">
                        <span class="hx-glyph"
                          ><svg viewBox="0 0 24 24">
                            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                            <path d="M3 6h18M16 10a4 4 0 0 1-8 0"></path></svg
                        ></span>
                        <div class="hx-grow">
                          <div class="hx-ttl">Speckled stoneware mug × 2</div>
                          <div class="hx-kd">02-Nov-2026 · LM-2207</div>
                        </div>
                        <div class="hx-amt">$38.61</div>
                        <span class="hx-obtn"
                          ><svg viewBox="0 0 24 24">
                            <path d="M12 15V3"></path>
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <path d="m7 10 5 5 5-5"></path></svg
                          >Receipt</span
                        >
                      </div>
                    </div>
                  </div>
                </div>
                <div class="hx-pcol">
                  <div class="hx-pills">
                    <span class="hx-pill">Payment methods</span
                    ><span class="hx-pill hx-on">Billing details</span>
                  </div>
                  <div class="hx-sec">
                    <div class="hx-sh hx-col2">
                      <span class="hx-desc"
                        >The name and address that we print on your invoices. They also set the tax
                        on your invoices.</span
                      >
                    </div>
                    <div class="hx-bd">
                      <span class="hx-glyph"
                        ><svg viewBox="0 0 24 24">
                          <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path>
                          <circle cx="12" cy="10" r="3"></circle></svg
                      ></span>
                      <div class="hx-bdf">
                        <div>
                          <div class="hx-mk">Billed to</div>
                          <div class="hx-strong">Noah Bennett</div>
                        </div>
                        <div>
                          <div class="hx-mk">Billing address</div>
                          <div>414 K St<br />Sacramento, CA, 95814<br />United States</div>
                        </div>
                        <div>
                          <div class="hx-mk">Tax registration number</div>
                          <div class="hx-mut">Not set</div>
                        </div>
                      </div>
                      <span class="hx-obtn"
                        ><svg viewBox="0 0 24 24">
                          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg
                        >Edit</span
                      >
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="hx-abs hx-ptr">
          <i class="hx-rip"></i
          ><svg viewBox="0 0 16 21">
            <path d="M1.5 1.5v15.2l4.1-3.9 2.9 6.4 2.6-1.2-2.8-6.2h5.6z"></path>
          </svg>
        </div>
        <svg class="hx-abs hx-wires" viewBox="0 0 1240 668" aria-hidden="true">
          <path class="hx-sig" d="M900 94 L 932 94"></path>
          <path class="hx-sig" d="M1066 68 L 1066 84"></path>
          <path class="hx-cash" d="M1066 204 L 1066 234"></path>
        </svg>
        <div class="hx-abs hx-mrail">
          <div class="hx-rc hx-evt">
            <div class="hx-k">On the customer's screen</div>
            <div class="hx-evl">
              <i class="hx-v31">Jonah makes text and images in MuseLane AI.</i
              ><i class="hx-v32">Each text and image uses credit. Automatic top‑up adds $50.00.</i
              ><i class="hx-v33">Jonah's usage this period: $33.00, paid with credit.</i
              ><i class="hx-v11">Ana Ruiz subscribes to Team at checkout: $41.83 today.</i
              ><i class="hx-v13">Renewal on 21 Nov: invoice KW-1187 is paid, $41.83.</i
              ><i class="hx-v14">Ana upgrades to Business: $42.90 due now, prorated.</i
              ><i class="hx-v21">Noah orders 2 stoneware mugs: $38.61 with tax.</i
              ><i class="hx-v22">Payment received for invoice LM-2207.</i>
            </div>
          </div>
          <div class="hx-rc hx-eng">
            <div class="hx-hd2">
              <span class="hx-tile"
                ><svg viewBox="0 0 64 64" aria-hidden="true">
                  <path
                    d="M0 0H64V64L53.33 52.57L42.67 64L32 52.57L21.33 64L10.67 52.57L0 64Z"
                  ></path></svg></span
              >Two Minute Billing
            </div>
            <div class="hx-did">
              <i class="hx-ea">Raises the first invoice and asks your gateway to charge $41.83.</i>
              <i class="hx-eb">Sets the next payment: 21 Nov, $41.83.</i>
              <i class="hx-ec">Renews on 21 Nov and charges $41.83.</i>
              <i class="hx-ed">Prorates the upgrade and charges $42.90 now.</i>
              <i class="hx-ee">Adds California sales tax: $2.61 on $36.00.</i>
              <i class="hx-ef">Asks your gateway to charge $38.61.</i>
              <i class="hx-eh"
                >Prices each call at the model's list price plus 20%: $3.00 per 1M tokens, $0.06 per
                image.</i
              ><i class="hx-ei"
                >Checks credit before each call. Below $10.00, it buys $50.00 of credit.</i
              ><i class="hx-ej"
                >Records model cost on each call: $19.80 on Jonah's $33.00, a 40% margin.</i
              ><i class="hx-eg">Sends the receipt for invoice LM-2207.</i>
            </div>
          </div>
          <div class="hx-rc hx-gwc">
            <div class="hx-k">Your gateway account</div>
            <div class="hx-lg" style="margin-top: 6px">
              <i class="hx-k1"><PartnerLogo name="stripe" ground="auto" :area="900" /></i
              ><i class="hx-k3"><PartnerLogo name="adyen" ground="auto" :area="900" /></i
              ><i class="hx-k2"><PartnerLogo name="paypal" ground="auto" :area="900" /></i>
            </div>
            <div class="hx-row2">
              <span class="hx-sw hx-t"
                ><i class="hx-k0">Nothing yet</i><i class="hx-kh">Nothing yet</i
                ><i class="hx-ki">$50.00</i><i class="hx-ka">$41.83</i><i class="hx-kb">$41.83</i
                ><i class="hx-kc">$41.83</i><i class="hx-kd">$42.90</i
                ><i class="hx-ke">Nothing yet</i><i class="hx-kf">$38.61</i
                ><i class="hx-kg">$38.61</i></span
              >
              <span class="hx-sw"
                ><i class="hx-k0"><span class="hx-pillwait">Waiting</span></i
                ><i class="hx-kh"><span class="hx-pillwait">Waiting</span></i
                ><i class="hx-ki"><span class="hx-pillok">Succeeded</span></i
                ><i class="hx-ka"><span class="hx-pillok">Succeeded</span></i
                ><i class="hx-kb"><span class="hx-pillok">Succeeded</span></i
                ><i class="hx-kc"><span class="hx-pillok">Succeeded</span></i
                ><i class="hx-kd"><span class="hx-pillok">Succeeded</span></i
                ><i class="hx-ke"><span class="hx-pillwait">Waiting</span></i
                ><i class="hx-kf"><span class="hx-pillok">Completed</span></i
                ><i class="hx-kg"><span class="hx-pillok">Completed</span></i></span
              >
            </div>
          </div>
          <div class="hx-rc hx-bank">
            <div class="hx-t">Your bank</div>
            <div class="hx-amt">
              <i class="hx-k0"><span class="hx-money2">$0.00</span></i
              ><i class="hx-kh"><span class="hx-money2">$0.00</span></i
              ><i class="hx-ki"><span class="hx-money2">+$50.00</span></i
              ><i class="hx-ka"><span class="hx-money2">+$41.83</span></i
              ><i class="hx-kb"><span class="hx-money2">+$41.83</span></i
              ><i class="hx-kc"><span class="hx-money2">+$83.66</span></i
              ><i class="hx-kd"><span class="hx-money2">+$126.56</span></i
              ><i class="hx-ke"><span class="hx-money2">$0.00</span></i
              ><i class="hx-kf"><span class="hx-money2">+$38.61</span></i
              ><i class="hx-kg"><span class="hx-money2">+$38.61</span></i>
            </div>
            <div class="hx-k" style="margin-top: 6px">Paid out by your gateway</div>
          </div>
          <div class="hx-rc hx-fee">
            <div class="hx-k">Our fee</div>
            <div class="hx-v">
              {{ fee ? `From ${fee}` : "A flat price" }} <small>a month, flat</small>
            </div>
            <div class="hx-k" style="margin-top: 2px">0% of your revenue</div>
          </div>
          <div class="hx-safe2">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M20 13c0 5-3.5 7.5-7.66 8.950a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
              ></path>
              <path d="m9 12 2 2 4-4"></path></svg
            >We never hold your money
          </div>
        </div>
      </div>
    </MkIll>
  </div>
</template>

<style>
/* Theme tokens: light by default, the site's dark palette under .dark. */
.hx-hero {
  --hx-card: #ffffff;
  --hx-fg: #101828;
  --hx-muted: #64748b;
  --hx-plain: #475569;
  --hx-line: #e2e9f2;
  --hx-soft: #f6f8fa;
  --hx-ok: #067647;
  --hx-ok-bg: #e7f6ee;
  --hx-money: #3f6212;
  --hx-money-bg: #ecfccb;
  --hx-brand: #4e4eda;
  --hx-brand-soft: #f1f1fd;
  --hx-brand-line: rgb(78 78 218 / 0.28);
  --hx-ground: linear-gradient(135deg, #f4f4fe 0%, #f8f9fc 48%, #f1f9fb 100%);
}
.dark .hx-hero {
  --hx-card: #111a2b;
  --hx-fg: #e6edf7;
  --hx-muted: #93a4bd;
  --hx-plain: #aebbcc;
  --hx-line: #1e2836;
  --hx-soft: #0f1729;
  --hx-ok: #4ade80;
  --hx-ok-bg: rgb(74 222 128 / 0.12);
  --hx-money: #bef264;
  --hx-money-bg: rgb(190 242 100 / 0.12);
  --hx-brand: #9393f3;
  --hx-brand-soft: #181c38;
  --hx-brand-line: rgb(147 147 243 / 0.3);
  --hx-ground: linear-gradient(135deg, #10142a 0%, #0b1220 48%, #0b1a20 100%);
}
/* Unscoped: every class is hx- prefixed, and the state classes sit on MkIll's frame. The
   ground is on the wrapper, so the controls and the board share it. */
.hx-hero {
  position: relative;
  container: hxh / inline-size;
  background: var(--hx-ground);
  background-size: 220% 220%;
  background-position: 0% 0%;
  font-family: var(--font-sans);
  color: var(--hx-fg);
}
.hx-hc .hx-scene {
  position: absolute;
  inset: 0;
}

html,
body {
  margin: 0;
}
/* Hero option C: two lifecycles played in turn in one browser window. Every frame is a real
   screen: hosted checkout (create, change, purchase) and the customer portal. */
.hx-hc {
  position: relative;
  overflow: hidden;
  font-family: var(--font-sans);
  color: var(--hx-fg);
}
/* The board sits on the wrapper's ground: no frame or stage of its own. */
.hx-hero .hx-hc {
  border: 0;
  border-radius: 0;
  background: none;
}
.hx-hc,
.hx-hc * {
  box-sizing: border-box;
}
.hx-hc .hx-scene {
  font-size: 14px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
}
.hx-hc .hx-abs {
  position: absolute;
}
.hx-hc b {
  font-weight: inherit;
}
.hx-hc i {
  font-style: normal;
}
.hx-hc .hx-strong {
  font-weight: 500;
  color: var(--hx-fg);
}
.hx-hc .hx-mut {
  color: var(--hx-muted);
}
.hx-hc .hx-xs {
  font-size: 13px;
}
.hx-hc .hx-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.hx-hc .hx-stack {
  display: inline-grid;
}
.hx-hc .hx-stack > i {
  grid-area: 1 / 1;
  transition: opacity 0.35s ease;
}

/* the controls: story buttons, the step strip and pause, above the board and outside its
   role="img", so they stay focusable. The step groups share one grid cell: no layout shift. */
.hx-hero .hx-ctl {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 16px 0;
  font-size: 13px;
  line-height: 1.2;
  color: var(--hx-muted);
}
.hx-hero .hx-tabs {
  display: inline-flex;
  gap: 4px;
}
.hx-hero .hx-tab,
.hx-hero .hx-pp {
  appearance: none;
  margin: 0;
  font: inherit;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 99px;
  background: transparent;
  color: var(--hx-muted);
  transition:
    color 0.3s ease,
    background 0.3s ease,
    border-color 0.3s ease;
}
.hx-hero .hx-tab {
  padding: 5px 12px;
  font-weight: 500;
  white-space: nowrap;
}
.hx-hero .hx-tab:hover {
  color: var(--hx-fg);
}
.hx-hero .hx-tab[aria-pressed="true"] {
  color: var(--hx-brand);
  background: var(--hx-brand-soft);
  border-color: var(--hx-brand-line);
}
.hx-hero .hx-pp {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-left: 4px;
  border-color: var(--hx-line);
  background: var(--hx-card);
  color: var(--hx-plain);
}
.hx-hero .hx-pp:hover {
  color: var(--hx-fg);
}
.hx-hero .hx-pp svg {
  width: 13px;
  height: 13px;
  fill: currentColor;
  stroke: currentColor;
  stroke-width: 2.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hx-hero .hx-tab:focus-visible,
.hx-hero .hx-pp:focus-visible {
  outline: 2px solid var(--hx-brand);
  outline-offset: 2px;
}
.hx-hero .hx-ctl .hx-vsep {
  width: 1px;
  height: 18px;
  margin: 0 6px;
  background: var(--hx-line);
}
.hx-hero .hx-ctl .hx-stages {
  display: inline-grid;
}
.hx-hero .hx-ctl .hx-stg-grp {
  grid-area: 1 / 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.4s ease,
    visibility 0.4s;
}
.hx-hero .hx-ctl .hx-stg-grp.hx-on {
  opacity: 1;
  visibility: visible;
}
.hx-hero .hx-ctl .hx-sg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 99px;
  white-space: nowrap;
  transition:
    color 0.3s ease,
    background 0.3s ease;
}
.hx-hero .hx-ctl .hx-sg::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 99px;
  background: var(--hx-line);
  transition: background 0.3s ease;
}
.hx-hero .hx-ctl .hx-sg.hx-on {
  color: var(--hx-fg);
  font-weight: 500;
  background: rgb(78 78 218 / 0.08);
}
.hx-hero .hx-ctl .hx-sg.hx-on::before {
  background: var(--hx-brand);
}
.hx-hero .hx-ctl .hx-sep {
  width: 12px;
  height: 1px;
  background: var(--hx-line);
}

/* browser window: centred, neutral soft shadow */
.hx-hc .hx-win {
  left: 40px;
  top: 28px;
  width: 860px;
  height: 600px;
  border-radius: 12px;
  background: var(--hx-soft);
  border: 1px solid var(--hx-line);
  overflow: hidden;
  box-shadow:
    0 1px 2px rgb(15 23 42 / 0.05),
    0 12px 24px -12px rgb(15 23 42 / 0.14),
    0 32px 64px -32px rgb(15 23 42 / 0.22);
}
.hx-hc .hx-bar {
  display: none;
  position: relative;
  z-index: 2;
  height: 38px;
  display: grid;
  grid-template-columns: 80px 1fr 80px;
  align-items: center;
  padding: 0 14px;
  background: var(--hx-card);
  border-bottom: 1px solid var(--hx-line);
}
.hx-hc .hx-dots {
  display: flex;
  gap: 7px;
}
.hx-hc .hx-dots i {
  width: 11px;
  height: 11px;
  border-radius: 99px;
  background: var(--hx-line);
}
.hx-hc .hx-url {
  justify-self: center;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 14px;
  border-radius: 7px;
  background: var(--hx-soft);
  font-size: 13px;
  color: var(--hx-plain);
}
.hx-hc .hx-url svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hx-hc .hx-url .hx-stack {
  justify-items: center;
}
.hx-hc .hx-url .hx-stack > i {
  white-space: nowrap;
}
.hx-hc .hx-url .hx-host {
  font-weight: 500;
  color: var(--hx-fg);
}

/* screens: stacked in the window, one shown at a time */
.hx-hc .hx-scr {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  overflow: hidden;
  opacity: 0;
  z-index: 0;
  transform: translateY(8px);
  transition:
    opacity 0.25s ease,
    transform 0.25s ease;
  pointer-events: none;
  background: var(--hx-soft);
}
.hx-hc .hx-page {
  padding: 22px 28px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: transform 1.2s cubic-bezier(0.45, 0, 0.25, 1);
}

/* storefront header */
.hx-hc .hx-shead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.hx-hc .hx-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.hx-hc .hx-bmark {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: grid;
  place-items: center;
}
.hx-hc .hx-bmark.hx-kelp {
  background: #0f2e3a;
}
.hx-hc .hx-bmark.hx-kelp svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: #9be3d6;
  stroke-width: 2.4;
  stroke-linecap: round;
}
.hx-hc .hx-bmark.hx-lark {
  background: #f3e7dc;
}
.hx-hc .hx-bmark.hx-lark svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: #9a4a2b;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hx-hc .hx-bname {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.hx-hc .hx-bsub {
  font-size: 14px;
  color: var(--hx-muted);
}
.hx-hc .hx-eyebrow {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--hx-muted);
}
.hx-hc .hx-cancel {
  font-size: 14px;
  color: var(--hx-muted);
  transition: opacity 0.3s ease;
}
.hx-hc .hx-who {
  text-align: right;
  font-size: 14px;
  line-height: 1.35;
}
.hx-hc .hx-who .hx-so {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  font-size: 13px;
  color: var(--hx-muted);
}
.hx-hc .hx-who .hx-so svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* steps */
.hx-hc .hx-steps {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}
.hx-hc .hx-steps .hx-ln {
  width: 32px;
  height: 1px;
  background: var(--hx-line);
}
.hx-hc .hx-steps .hx-st {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hx-hc .hx-steps .hx-n {
  position: relative;
  width: 24px;
  height: 24px;
  flex: none;
}
.hx-hc .hx-steps .hx-n > i {
  position: absolute;
  inset: 0;
  border-radius: 99px;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 500;
  transition: opacity 0.4s ease;
}
.hx-hc .hx-steps .hx-n .hx-idle {
  background: var(--hx-soft);
  border: 1px solid var(--hx-line);
  color: var(--hx-muted);
}
.hx-hc .hx-steps .hx-n .hx-num,
.hx-hc .hx-steps .hx-n .hx-chk,
.hx-hc .hx-steps .hx-n .hx-fill {
  background: var(--hx-brand-soft);
  color: var(--hx-brand);
  box-shadow: inset 0 0 0 1px var(--hx-brand-line);
}
.hx-hc .hx-steps .hx-n svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hx-hc .hx-steps .hx-lb {
  display: inline-grid;
}
.hx-hc .hx-steps .hx-lb > i {
  grid-area: 1 / 1;
  white-space: nowrap;
  transition: opacity 0.4s ease;
}
.hx-hc .hx-steps .hx-off-t {
  color: var(--hx-muted);
}
.hx-hc .hx-steps .hx-on-t {
  color: var(--hx-fg);
  font-weight: 500;
}
.hx-hc .hx-x {
  opacity: 0;
}

/* checkout panes: the form, and the order rail (22rem) */
.hx-hc .hx-panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 352px;
  gap: 20px;
  align-items: start;
}
.hx-hc .hx-left {
  position: relative;
}
.hx-hc .hx-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: opacity 0.45s ease;
}
.hx-hc .hx-notice {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 0.6s ease 0.25s,
    transform 0.6s ease 0.25s;
}
.hx-hc .hx-rails {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.hx-hc .hx-sec {
  background: var(--hx-card);
  border: 1px solid var(--hx-line);
  border-radius: 14px;
  box-shadow: 0 1px 2px rgb(15 23 42 / 0.05);
  overflow: hidden;
}
.hx-hc .hx-sec .hx-sh {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 20px;
  border-bottom: 1px solid var(--hx-line);
  font-size: 14px;
  font-weight: 600;
}
.hx-hc .hx-sec .hx-sh.hx-col {
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}
.hx-hc .hx-sec .hx-sh .hx-desc {
  font-size: 13px;
  font-weight: 400;
  color: var(--hx-muted);
}
.hx-hc .hx-sec .hx-sh.hx-col2 {
  padding-top: 12px;
  padding-bottom: 12px;
}
.hx-hc .hx-sec .hx-sb {
  padding: 14px 20px;
}
.hx-hc .hx-sec .hx-sb.hx-tight {
  padding-top: 10px;
  padding-bottom: 10px;
  line-height: 1.4;
}
.hx-hc .hx-lnk {
  font-size: 14px;
  color: #4e4eda;
  font-weight: 400;
}
.hx-hc .hx-lnk.hx-sm {
  font-size: 13px;
}
.hx-hc .hx-body {
  margin: 0;
  font-size: 14px;
  color: var(--hx-muted);
}

/* the gateway's card form */
.hx-hc .hx-note {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--hx-muted);
}
.hx-hc .hx-sf {
  display: grid;
  gap: 8px;
}
.hx-hc .hx-sf .hx-two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.hx-hc .hx-sf label {
  display: block;
  margin-bottom: 4px;
  font-size: 14px;
  color: var(--hx-muted);
}
.hx-hc .hx-sf .hx-in {
  position: relative;
  display: flex;
  align-items: center;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--hx-line);
  border-radius: 6px;
  background: var(--hx-card);
  font-size: 15px;
  color: var(--hx-fg);
}
.hx-hc .hx-sf .hx-val {
  display: inline-flex;
  white-space: pre;
}
.hx-hc .hx-sf .hx-val b {
  opacity: 0;
}
.hx-hc .hx-sf .hx-ph {
  position: absolute;
  left: 12px;
  top: 50%;
  translate: 0 -50%;
  color: var(--hx-muted);
  white-space: pre;
}
.hx-hc .hx-sf .hx-ring {
  position: absolute;
  inset: -1px;
  border-radius: 6px;
  border: 1px solid #4e4eda;
  box-shadow: 0 0 0 2px rgb(78 78 218 / 0.2);
  pointer-events: none;
  opacity: 0;
}
.hx-hc .hx-sf .hx-r-card {
  opacity: 1;
}
.hx-hc .hx-visa {
  margin-left: auto;
  height: 18px;
  padding: 0 5px;
  border-radius: 3px;
  background: #1a1f71;
  font-size: 10px;
  font-weight: 800;
  font-style: italic;
  line-height: 18px;
  color: #fff;
}
.hx-hc .hx-sf .hx-visa {
  opacity: 0;
}
.hx-hc .hx-visa.hx-sm {
  margin: 0;
  flex: none;
}
.hx-hc .hx-commit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}
.hx-hc .hx-commit.hx-left,
.hx-hc .hx-commit.hx-end {
  justify-content: flex-end;
}
.hx-hc .hx-commit.hx-left {
  justify-content: flex-start;
}
.hx-hc .hx-btn {
  display: inline-grid;
  align-items: center;
  height: 38px;
  padding: 0 20px;
  border-radius: 8px;
  background: var(--hx-brand-soft);
  color: var(--hx-brand);
  font-size: 15px;
  font-weight: 500;
  box-shadow: inset 0 0 0 1px var(--hx-brand-line);
  transition:
    opacity 0.3s ease,
    transform 0.15s ease;
}
.hx-hc .hx-btn > i {
  grid-area: 1 / 1;
  text-align: center;
  white-space: nowrap;
  transition: opacity 0.2s ease;
}

/* the real confirmation: NoticeCard, tone success */
.hx-hc .hx-nc {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 56px 24px;
  text-align: center;
}
.hx-hc .hx-nc .hx-ic,
.hx-hc .hx-okc {
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 99px;
  display: grid;
  place-items: center;
  background: var(--hx-ok-bg);
  color: var(--hx-ok);
}
.hx-hc .hx-nc .hx-ic svg,
.hx-hc .hx-okc svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hx-hc .hx-nc .hx-t {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.hx-hc .hx-nc .hx-b {
  max-width: 384px;
  font-size: 14px;
  color: var(--hx-muted);
}
.hx-hc .hx-nc .hx-b p {
  margin: 0;
}
.hx-hc .hx-nc .hx-b .hx-id {
  margin-top: 8px;
  font-size: 13px;
}
.hx-hc .hx-nc .hx-b .hx-cont {
  margin-top: 12px;
  font-weight: 500;
  color: #4e4eda;
}

/* order rail rows */
.hx-hc .hx-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 20px;
}
.hx-hc .hx-item + .hx-item {
  border-top: 1px solid var(--hx-line);
}
.hx-hc .hx-item.hx-cur {
  color: var(--hx-muted);
}
.hx-hc .hx-s {
  text-decoration: line-through;
}
.hx-hc .hx-glyph {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 9px;
  background: var(--hx-soft);
  border: 1px solid var(--hx-line);
  display: grid;
  place-items: center;
  color: var(--hx-plain);
}
.hx-hc .hx-glyph svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hx-hc .hx-item .hx-nm {
  font-size: 14px;
  font-weight: 500;
}
.hx-hc .hx-item.hx-cur .hx-nm {
  font-weight: 400;
}
.hx-hc .hx-item .hx-kd,
.hx-hc .hx-irow .hx-kd {
  margin-top: 1px;
  font-size: 13px;
  color: var(--hx-muted);
}
.hx-hc .hx-irow .hx-kd {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hx-hc .hx-item .hx-am {
  margin-left: auto;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.hx-hc .hx-item .hx-am.hx-n {
  font-weight: 400;
}
.hx-hc .hx-due {
  padding: 14px 20px;
  border-top: 1px solid var(--hx-line);
}
.hx-hc .hx-row2 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.hx-hc .hx-k2 {
  font-size: 14px;
  font-weight: 500;
}
.hx-hc .hx-big {
  font-size: 19px;
  font-weight: 600;
}
.hx-hc .hx-due .hx-ft {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--hx-muted);
}
.hx-hc .hx-per {
  padding: 14px 20px 16px;
  border-top: 1px solid var(--hx-line);
  background: var(--hx-soft);
}
.hx-hc .hx-per .hx-k {
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--hx-muted);
}
.hx-hc .hx-per .hx-tl {
  font-size: 14px;
  color: var(--hx-muted);
}
.hx-hc .hx-per .hx-t {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 13px;
  color: var(--hx-muted);
}
.hx-hc .hx-per .hx-t.hx-first {
  margin-top: 0;
  font-size: 14px;
}
.hx-hc .hx-per .hx-t + .hx-t {
  font-size: 14px;
}
.hx-hc .hx-per .hx-tot {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--hx-line);
}
.hx-hc .hx-np {
  border-top: 1px solid var(--hx-line);
  background: var(--hx-card);
}
.hx-hc .hx-stepper {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.hx-hc .hx-sbtn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--hx-line);
  background: var(--hx-card);
  display: grid;
  place-items: center;
  font-size: 15px;
  color: var(--hx-fg);
}
.hx-hc .hx-qn {
  width: 32px;
  justify-items: center;
  font-size: 14px;
}
.hx-hc .hx-pv {
  padding: 12px 20px;
  display: grid;
  gap: 6px;
  font-size: 14px;
}
.hx-hc .hx-pl {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.hx-hc .hx-pl span {
  color: var(--hx-muted);
}
.hx-hc .hx-pl.hx-rule {
  padding-top: 6px;
  border-top: 1px solid var(--hx-line);
}
.hx-hc .hx-pf {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid var(--hx-line);
  background: var(--hx-soft);
  font-size: 14px;
  font-weight: 500;
}
.hx-hc .hx-pf b {
  font-size: 19px;
  font-weight: 600;
}

/* plan change: the rail is the longest column on any screen, so it runs tighter */
.hx-hc .hx-ch .hx-rails {
  gap: 12px;
}
.hx-hc .hx-ch .hx-item {
  padding-top: 9px;
  padding-bottom: 9px;
}
.hx-hc .hx-ch .hx-per {
  padding-top: 11px;
  padding-bottom: 12px;
}
.hx-hc .hx-ch .hx-sec .hx-sh {
  padding-top: 9px;
  padding-bottom: 9px;
}
.hx-hc .hx-ch .hx-pv {
  padding-top: 10px;
  padding-bottom: 10px;
  gap: 4px;
}
.hx-hc .hx-ch .hx-pf {
  padding-top: 9px;
  padding-bottom: 10px;
}

/* status chip (StatusBadge, green) */
.hx-hc .hx-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  border: 1px solid rgb(6 118 71 / 0.25);
  border-radius: 999px;
  padding: 1px 9px;
  background: var(--hx-ok-bg);
  color: var(--hx-ok);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}
.hx-hc .hx-badge i {
  width: 6px;
  height: 6px;
  border-radius: 99px;
  background: currentColor;
}

/* portal: money column and account column */
.hx-hc .hx-ppanes {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.hx-hc .hx-pcol {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hx-hc .hx-bal {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 20px;
}
.hx-hc .hx-bal .hx-okc {
  width: 36px;
  height: 36px;
}
.hx-hc .hx-bt {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.hx-hc .hx-bp {
  margin: 2px 0 0;
  font-size: 14px;
  color: var(--hx-muted);
}
.hx-hc .hx-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 12px 20px 14px;
  border-top: 1px solid var(--hx-line);
  background: var(--hx-soft);
  font-size: 14px;
}
.hx-hc .hx-mk {
  margin-bottom: 2px;
  font-size: 13px;
  color: var(--hx-muted);
}
.hx-hc .hx-pm {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.hx-hc .hx-ilist {
  position: relative;
  height: 128px;
}
.hx-hc .hx-ilist.hx-one {
  height: auto;
}
.hx-hc .hx-irow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  height: 64px;
  background: var(--hx-card);
}
.hx-hc .hx-ilist:not(.hx-one) .hx-irow {
  position: absolute;
  left: 0;
  right: 0;
  transition:
    transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.5s ease;
}
.hx-hc .hx-irow.hx-new {
  top: 0;
  opacity: 0;
  transform: translateY(-10px);
}
.hx-hc .hx-irow.hx-old {
  top: 0;
}
.hx-hc .hx-irow .hx-grow {
  flex: 1;
  min-width: 0;
}
.hx-hc .hx-irow .hx-ttl {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
}
.hx-hc .hx-irow .hx-amt {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
}
.hx-hc .hx-obtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--hx-line);
  background: var(--hx-card);
  font-size: 13px;
  font-weight: 500;
  color: var(--hx-fg);
  white-space: nowrap;
}
.hx-hc .hx-obtn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hx-hc .hx-pills {
  display: flex;
  gap: 6px;
}
.hx-hc .hx-pill {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--hx-line);
  background: var(--hx-card);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.hx-hc .hx-pill.hx-on {
  background: var(--hx-fg);
  border-color: var(--hx-fg);
  color: var(--hx-card);
}
.hx-hc .hx-bd {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 20px;
  font-size: 14px;
}
.hx-hc .hx-bdf {
  flex: 1;
  display: grid;
  gap: 10px;
  line-height: 1.45;
}

/* the money rail: what the engine did, where the money went, what we charge */
.hx-hc .hx-mrail {
  left: 932px;
  top: 28px;
  width: 268px;
  height: 600px;
}
.hx-hc .hx-rc {
  position: absolute;
  left: 0;
  right: 0;
  background: var(--hx-card);
  border: 1px solid var(--hx-line);
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow:
    0 1px 2px rgb(15 23 42 / 0.05),
    0 10px 22px -14px rgb(15 23 42 / 0.2);
}
.hx-hc .hx-rc .hx-k {
  font-size: 12px;
  color: var(--hx-muted);
}
.hx-hc .hx-rc .hx-t {
  font-size: 14px;
  font-weight: 600;
  color: var(--hx-fg);
}
.hx-hc .hx-sw {
  display: inline-grid;
}
.hx-hc .hx-sw > i {
  grid-area: 1 / 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.hx-hc .hx-rc .hx-big {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-top: 4px;
}
/* A soft tint, not solid indigo: inside the hero, solid indigo competed with the page's own
   Start for free button. */
.hx-hc .hx-eng {
  top: 0;
  background: var(--hx-brand-soft);
  border-color: var(--hx-brand-line);
  color: var(--hx-fg);
  box-shadow: 0 10px 22px -14px rgb(15 23 42 / 0.2);
}
.hx-hc .hx-eng .hx-hd2 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 600;
}
.hx-hc .hx-eng .hx-tile {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--hx-card);
  border: 1px solid var(--hx-brand-line);
  display: grid;
  place-items: center;
  flex: none;
}
.hx-hc .hx-eng .hx-tile svg {
  width: 15px;
  height: 15px;
  fill: var(--hx-brand);
}
.hx-hc .hx-eng .hx-did {
  display: grid;
  margin-top: 10px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--hx-plain);
  min-height: 38px;
}
.hx-hc .hx-eng .hx-did > i {
  grid-area: 1 / 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.hx-hc .hx-gwc {
  top: 140px;
}
.hx-hc .hx-gwc .hx-lg {
  display: grid;
  height: 22px;
  align-items: center;
}
.hx-hc .hx-gwc .hx-lg > i {
  grid-area: 1 / 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.hx-hc .hx-gwc .hx-lg img {
  display: block;
  height: 20px;
  width: auto;
}
.hx-hc .hx-gwc .hx-row2 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
}
.hx-hc .hx-pillok {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 99px;
  font-size: 12px;
  font-weight: 500;
  background: var(--hx-ok-bg);
  color: var(--hx-ok);
  border: 1px solid rgb(6 118 71 / 0.2);
}
.hx-hc .hx-pillok::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 99px;
  background: currentColor;
}
.hx-hc .hx-pillwait {
  display: inline-flex;
  padding: 2px 9px;
  border-radius: 99px;
  font-size: 12px;
  font-weight: 500;
  background: var(--hx-soft);
  color: var(--hx-muted);
  border: 1px solid var(--hx-line);
}
.hx-hc .hx-bank {
  top: 290px;
}
.hx-hc .hx-bank .hx-amt {
  display: inline-grid;
  margin-top: 8px;
}
.hx-hc .hx-bank .hx-amt > i {
  grid-area: 1 / 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.hx-hc .hx-money2 {
  display: inline-flex;
  padding: 3px 10px;
  border-radius: 99px;
  background: var(--hx-money-bg);
  color: var(--hx-money);
  border: 1px solid rgb(77 124 15 / 0.3);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.hx-hc .hx-fee {
  top: 420px;
}
.hx-hc .hx-fee .hx-v {
  font-size: 18px;
  font-weight: 600;
  margin-top: 2px;
  white-space: nowrap;
}
.hx-hc .hx-fee .hx-v small {
  font-size: 13px;
  font-weight: 400;
  color: var(--hx-muted);
}
.hx-hc .hx-safe2 {
  position: absolute;
  left: 0;
  top: 548px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 99px;
  background: var(--hx-card);
  border: 1px solid var(--hx-line);
  font-size: 13px;
  font-weight: 500;
  color: var(--hx-plain);
}
.hx-hc .hx-safe2 svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: #4d7c0f;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hx-hc .hx-wires {
  left: 0;
  top: 0;
  width: 1240px;
  height: 668px;
  pointer-events: none;
}
.hx-hc .hx-wires .hx-sig {
  fill: none;
  stroke: #4e4eda;
  stroke-width: 1.5;
  opacity: 0.5;
  stroke-dasharray: 3 4;
}
.hx-hc .hx-wires .hx-cash {
  fill: none;
  stroke: #84cc16;
  stroke-width: 3;
  stroke-linecap: round;
  opacity: 0.55;
}
.hx-hc.hx-story-1.hx-stg-1 .hx-did .hx-ea,
.hx-hc.hx-story-1.hx-stg-2 .hx-did .hx-eb,
.hx-hc.hx-story-1.hx-stg-3 .hx-did .hx-ec,
.hx-hc.hx-story-1.hx-stg-4 .hx-did .hx-ed,
.hx-hc.hx-story-3.hx-stg-1 .hx-did .hx-eh,
.hx-hc.hx-story-3.hx-stg-2 .hx-did .hx-ei,
.hx-hc.hx-story-3.hx-stg-3 .hx-did .hx-ej,
.hx-hc.hx-story-2.hx-stg-1 .hx-did .hx-ee,
.hx-hc.hx-story-2.hx-stg-2 .hx-did .hx-ef,
.hx-hc.hx-story-2.hx-stg-3 .hx-did .hx-eg {
  opacity: 1;
  transition: opacity 0.35s ease 0.18s;
}
/* which rail value shows: a-d story 1 stages 1-4, e-g story 2 stages 1-3, h-i story 3 before
   and after the top-up */
.hx-hc.hx-story-1.hx-stg-1.hx-co-d .hx-ka,
.hx-hc.hx-story-1.hx-stg-1:not(.hx-co-d) .hx-k0,
.hx-hc.hx-story-1.hx-stg-2 .hx-kb,
.hx-hc.hx-story-1.hx-stg-3.hx-pt-r .hx-kc,
.hx-hc.hx-story-1.hx-stg-3:not(.hx-pt-r) .hx-kb,
.hx-hc.hx-story-1.hx-stg-4.hx-ch-d .hx-kd,
.hx-hc.hx-story-1.hx-stg-4:not(.hx-ch-d) .hx-kc,
.hx-hc.hx-story-2.hx-stg-1 .hx-ke,
.hx-hc.hx-story-2.hx-stg-2.hx-by-d .hx-kf,
.hx-hc.hx-story-2.hx-stg-2:not(.hx-by-d) .hx-ke,
.hx-hc.hx-story-2.hx-stg-3 .hx-kg,
.hx-hc.hx-story-3:not(.hx-ai-t) .hx-kh,
.hx-hc.hx-story-3.hx-ai-t .hx-ki,
.hx-hc.hx-story-1 .hx-gwc .hx-lg .hx-k1,
.hx-hc.hx-story-2 .hx-gwc .hx-lg .hx-k2,
.hx-hc.hx-story-3 .hx-gwc .hx-lg .hx-k3 {
  opacity: 1;
  transition: opacity 0.35s ease 0.18s;
}

/* AI pricing: MuseLane AI's own app in its own warm orange (never our indigo), and our usage
   widget embedded beside it in ours. Swaps fade out fast and fade in after, never overlapping. */
.hx-hc {
  --hx-muse: #c2410c;
  --hx-muse-soft: #fff4eb;
  --hx-muse-line: rgb(234 88 12 / 0.32);
  --hx-muse-bg: #fffaf5;
}
.dark .hx-hc {
  --hx-muse: #fdba74;
  --hx-muse-soft: rgb(251 146 60 / 0.12);
  --hx-muse-line: rgb(251 146 60 / 0.4);
  --hx-muse-bg: rgb(251 146 60 / 0.05);
}
/* the generated picture: quiet warm neutrals, so it never pulls the eye from the page */
.hx-hc .hx-oim {
  --im-sky1: #f3eee8;
  --im-sky2: #fbf8f4;
  --im-sun: #ead9c4;
  --im-hill1: #e6dfd5;
  --im-hill2: #dbd2c5;
  --im-stem: #c7bba9;
  --im-fl1: #e3cfbb;
  --im-fl2: #d9cbbb;
  --im-dot: #f7f1ea;
}
.dark .hx-hc .hx-oim {
  --im-sky1: #24211e;
  --im-sky2: #1d1b19;
  --im-sun: #4a3f34;
  --im-hill1: #2f2b27;
  --im-hill2: #37322c;
  --im-stem: #4e463d;
  --im-fl1: #5b4c3e;
  --im-fl2: #4f463c;
  --im-dot: #2b2723;
}
.hx-hc .hx-bmark.hx-muse {
  background: #fdebdd;
}
.hx-hc .hx-bmark.hx-muse svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: #c2410c;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.hx-hc .hx-apanes {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.hx-hc .hx-doc .hx-dtl {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 16px;
  font-weight: 600;
}
.hx-hc .hx-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--hx-line);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
}
.hx-hc .hx-seg > i {
  padding: 3px 10px;
  border-radius: 6px;
  color: var(--hx-muted);
  transition:
    color 0.2s ease,
    background 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.15s ease;
}
.hx-hc:not(.hx-im) .hx-seg .hx-sgt,
.hx-hc.hx-im .hx-seg .hx-sgi {
  color: var(--hx-muse);
  background: var(--hx-muse-soft);
  box-shadow: inset 0 0 0 1px var(--hx-muse-line);
}
.hx-hc .hx-cmp {
  display: flex;
  gap: 8px;
  padding: 14px 20px 12px;
}
.hx-hc .hx-inp {
  flex: 1;
  display: grid;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--hx-line);
  border-radius: 8px;
  background: var(--hx-card);
  font-size: 13px;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}
.hx-hc.hx-fo .hx-inp,
.hx-hc.hx-pt .hx-inp,
.hx-hc.hx-pi .hx-inp {
  border-color: var(--hx-muse-line);
  box-shadow: 0 0 0 3px var(--hx-muse-soft);
}
.hx-hc .hx-inp > span {
  grid-area: 1 / 1;
  white-space: nowrap;
  overflow: hidden;
}
.hx-hc .hx-ph2 {
  color: var(--hx-muted);
  transition: opacity 0.15s ease;
}
.hx-hc.hx-pt .hx-ph2,
.hx-hc.hx-pi .hx-ph2 {
  opacity: 0;
}
/* typing: a stepped reveal while the class is on, closed at once when it goes */
.hx-hc .hx-ptt,
.hx-hc .hx-pti {
  clip-path: inset(0 100% 0 0);
}
.hx-hc.hx-pt:not(.hx-im) .hx-ptt,
.hx-hc.hx-pi .hx-pti {
  clip-path: inset(0 0 0 0);
  transition: clip-path 0.7s steps(22, end) 0.1s;
}
.hx-hc .hx-gen {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--hx-muse-line);
  background: var(--hx-muse-soft);
  color: var(--hx-muse);
  font-size: 13px;
  font-weight: 600;
  transition: transform 0.15s ease;
}
.hx-hc .hx-gen svg {
  width: 13px;
  height: 13px;
  fill: currentColor;
}
.hx-hc.hx-gp .hx-gen,
.hx-hc.hx-ip .hx-seg .hx-sgi {
  transform: scale(0.94);
}
.hx-hc .hx-out {
  display: grid;
  height: 150px;
  margin: 0 20px 16px;
  border-radius: 10px;
  background: var(--hx-muse-bg);
  overflow: hidden;
}
.hx-hc .hx-out > div {
  grid-area: 1 / 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.hx-hc:not(.hx-im) .hx-otx,
.hx-hc.hx-im .hx-oim {
  opacity: 1;
  transition: opacity 0.35s ease 0.18s;
}
.hx-hc .hx-otx {
  display: grid;
  align-content: start;
  gap: 6px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--hx-fg);
}
.hx-hc .hx-otx > p {
  margin: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.hx-hc.hx-ai-1 .hx-otx > .hx-o1,
.hx-hc.hx-ai-2 .hx-otx > p,
.hx-hc.hx-ai-3 .hx-otx > p,
.hx-hc.hx-ai-4 .hx-otx > p {
  opacity: 1;
  transition: opacity 0.35s ease 0.18s;
}
.hx-hc .hx-oim svg {
  display: block;
  width: 100%;
  height: 150px;
  clip-path: inset(0 0 100% 0);
}
.hx-hc.hx-ai-3 .hx-oim svg {
  clip-path: inset(0 0 48% 0);
  transition: clip-path 0.5s ease;
}
.hx-hc.hx-ai-4 .hx-oim svg {
  clip-path: inset(0 0 0 0);
  transition: clip-path 0.5s ease;
}
.hx-hc .hx-model {
  border-top: 1px solid var(--hx-line);
}
.hx-hc .hx-mv {
  display: inline-grid;
}
.hx-hc .hx-mv > i {
  grid-area: 1 / 1;
  opacity: 0;
  white-space: nowrap;
  transition: opacity 0.15s ease;
}
.hx-hc .hx-am .hx-mv > i {
  text-align: right;
}
.hx-hc:not(.hx-im) .hx-mv > .hx-mt,
.hx-hc.hx-im .hx-mv > .hx-mi {
  opacity: 1;
  transition: opacity 0.35s ease 0.18s;
}
.hx-hc .hx-gate {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--hx-line);
  font-size: 13px;
  color: var(--hx-muted);
}
.hx-hc .hx-gate .hx-badge {
  opacity: 0;
  transition: opacity 0.4s ease;
}
.hx-hc.hx-story-3:not(.hx-stg-1) .hx-gate .hx-badge {
  opacity: 1;
}
.hx-hc .hx-wdg {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 20px 20px;
}
.hx-hc .hx-wt {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.hx-hc .hx-wbig {
  font-size: 30px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.01em;
}
.hx-hc .hx-wmut {
  font-size: 13px;
  color: var(--hx-muted);
}
.hx-hc .hx-wsec {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--hx-line);
}
.hx-hc .hx-wrow {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.hx-hc .hx-wlb {
  color: var(--hx-muted);
}
.hx-hc .hx-av {
  display: inline-grid;
}
.hx-hc .hx-av > i {
  grid-area: 1 / 1;
  opacity: 0;
  transition: opacity 0.15s ease;
  white-space: nowrap;
}
.hx-hc .hx-wrow .hx-av > i {
  text-align: right;
}
.hx-hc.hx-ai-0 .hx-ab0,
.hx-hc.hx-ai-1 .hx-ab1,
.hx-hc.hx-ai-2 .hx-ab2,
.hx-hc.hx-ai-3 .hx-ab3,
.hx-hc.hx-ai-4:not(.hx-ai-t) .hx-ab4,
.hx-hc.hx-ai-t .hx-ab5,
.hx-hc.hx-ai-0 .hx-at0,
.hx-hc.hx-ai-1 .hx-at1,
.hx-hc.hx-ai-2 .hx-at2,
.hx-hc.hx-ai-3 .hx-at2,
.hx-hc.hx-ai-4 .hx-at2,
.hx-hc.hx-ai-0 .hx-ag0,
.hx-hc.hx-ai-1 .hx-ag0,
.hx-hc.hx-ai-2 .hx-ag0,
.hx-hc.hx-ai-3 .hx-ag1,
.hx-hc.hx-ai-4 .hx-ag2 {
  opacity: 1;
  transition: opacity 0.35s ease 0.18s;
}
.hx-hc .hx-plus {
  transition: transform 0.15s ease;
}
.hx-hc.hx-by-pp .hx-plus {
  transform: scale(0.94);
}

/* the pointer: glides between targets in board units, presses, and leaves a soft ripple */
.hx-hc {
  --hx-cur-fill: #101828;
  --hx-cur-edge: #ffffff;
}
.dark .hx-hc {
  --hx-cur-fill: #f1f5f9;
  --hx-cur-edge: #0b1220;
}
.hx-hc .hx-ptr {
  left: 0;
  top: 0;
  z-index: 5;
  width: 18px;
  height: 23px;
  opacity: 0;
  pointer-events: none;
  transform: translate(var(--cx, 470px), var(--cy, 520px));
  transition:
    transform 0.6s cubic-bezier(0.45, 0, 0.25, 1),
    opacity 0.3s ease;
}
.hx-hc.hx-cu .hx-ptr {
  opacity: 1;
}
.hx-hc.hx-cs .hx-ptr {
  transition: opacity 0.3s ease;
}
.hx-hc .hx-ptr svg {
  position: relative;
  display: block;
  width: 18px;
  height: 23px;
  fill: var(--hx-cur-fill);
  stroke: var(--hx-cur-edge);
  stroke-width: 1.4;
  stroke-linejoin: round;
  filter: drop-shadow(0 1px 2px rgb(15 23 42 / 0.25));
  transform-origin: 2px 2px;
  transition: transform 0.12s ease;
}
.hx-hc.hx-cp .hx-ptr svg {
  transform: scale(0.86);
}
.hx-hc .hx-ptr .hx-rip {
  position: absolute;
  left: -14px;
  top: -14px;
  width: 32px;
  height: 32px;
  border-radius: 99px;
  background: rgb(78 78 218 / 0.14);
  border: 1.5px solid rgb(78 78 218 / 0.38);
  opacity: 0;
}
.dark .hx-hc .hx-ptr .hx-rip {
  background: rgb(147 147 243 / 0.18);
  border-color: rgb(147 147 243 / 0.45);
}
.hx-hc.hx-ck .hx-ptr .hx-rip {
  animation: hc-rip 0.6s ease-out both;
}
@keyframes hc-rip {
  from {
    opacity: 0.95;
    transform: scale(0.3);
  }
  to {
    opacity: 0;
    transform: scale(1.5);
  }
}
.hx-hc.hx-c-ai0 {
  --cx: 300px;
  --cy: 545px;
}
.hx-hc.hx-c-inp {
  --cx: 200px;
  --cy: 193px;
}
.hx-hc.hx-c-gen {
  --cx: 438px;
  --cy: 193px;
}
.hx-hc.hx-c-img {
  --cx: 462px;
  --cy: 134px;
}
.hx-hc.hx-c-ai1 {
  --cx: 470px;
  --cy: 520px;
}
.hx-hc.hx-c-co0 {
  --cx: 640px;
  --cy: 470px;
}
.hx-hc.hx-c-sub {
  --cx: 420px;
  --cy: 556px;
}
.hx-hc.hx-c-co1 {
  --cx: 560px;
  --cy: 575px;
}
.hx-hc.hx-c-conf {
  --cx: 176px;
  --cy: 212px;
}
.hx-hc.hx-c-ch1 {
  --cx: 330px;
  --cy: 470px;
}
.hx-hc.hx-c-by0 {
  --cx: 700px;
  --cy: 380px;
}
.hx-hc.hx-c-plus {
  --cx: 838px;
  --cy: 236px;
}
.hx-hc.hx-c-pay {
  --cx: 424px;
  --cy: 434px;
}
.hx-hc.hx-c-by1 {
  --cx: 520px;
  --cy: 520px;
}

/* phone: the screens are desktop-sized, so the board stacks what reads at this width: one line of what the customer just did, and the money rail. Same timeline. */
.hx-hc .hx-evt {
  display: none;
}
.hx-hc .hx-evl {
  display: grid;
  margin-top: 6px;
  font-size: 15px;
  line-height: 1.45;
  color: var(--hx-fg);
  min-height: 44px;
}
.hx-hc .hx-evl > i {
  grid-area: 1 / 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.hx-hc.hx-story-1.hx-stg-1 .hx-evl .hx-v11,
.hx-hc.hx-story-1.hx-stg-3 .hx-evl .hx-v13,
.hx-hc.hx-story-1.hx-stg-4 .hx-evl .hx-v14,
.hx-hc.hx-story-3.hx-stg-1 .hx-evl .hx-v31,
.hx-hc.hx-story-3.hx-stg-2 .hx-evl .hx-v32,
.hx-hc.hx-story-3.hx-stg-3 .hx-evl .hx-v33,
.hx-hc.hx-story-2.hx-stg-1 .hx-evl .hx-v21,
.hx-hc.hx-story-2.hx-stg-2 .hx-evl .hx-v22 {
  opacity: 1;
  transition: opacity 0.35s ease 0.18s;
}

/* ===== state: which screen, which story, which stage ===== */
/* the incoming screen fades in on top; the outgoing one leaves only once it is covered */
.hx-hc.hx-s-ai .hx-scr.hx-ai,
.hx-hc.hx-s-co .hx-scr.hx-co,
.hx-hc.hx-s-pt .hx-scr.hx-pt,
.hx-hc.hx-s-ch .hx-scr.hx-ch,
.hx-hc.hx-s-by .hx-scr.hx-by,
.hx-hc.hx-s-p2 .hx-scr.hx-p2 {
  opacity: 1;
  transform: none;
  z-index: 1;
  transition:
    opacity 0.45s ease 0.25s,
    transform 0.45s ease 0.25s;
}
.hx-hc .hx-url .hx-u {
  opacity: 0;
  transition: opacity 0.4s ease;
}
.hx-hc.hx-s-co .hx-u-co,
.hx-hc.hx-s-ch .hx-u-co,
.hx-hc.hx-s-pt .hx-u-pt,
.hx-hc.hx-s-by .hx-u-by,
.hx-hc.hx-s-p2 .hx-u-p2 {
  opacity: 1;
}
/* done: steps advance, the form gives way to the confirmation, Cancel goes */
.hx-hc.hx-co-d .hx-co .hx-st.hx-a .hx-num,
.hx-hc.hx-ch-d .hx-ch .hx-st.hx-a .hx-num,
.hx-hc.hx-by-d .hx-by .hx-st.hx-a .hx-num {
  opacity: 0;
}
.hx-hc.hx-co-d .hx-co .hx-st.hx-a .hx-chk,
.hx-hc.hx-ch-d .hx-ch .hx-st.hx-a .hx-chk,
.hx-hc.hx-by-d .hx-by .hx-st.hx-a .hx-chk {
  opacity: 1;
}
.hx-hc.hx-co-d .hx-co .hx-st.hx-a .hx-on-t,
.hx-hc.hx-ch-d .hx-ch .hx-st.hx-a .hx-on-t,
.hx-hc.hx-by-d .hx-by .hx-st.hx-a .hx-on-t {
  opacity: 0;
}
.hx-hc.hx-co-d .hx-co .hx-st.hx-a .hx-off-t.hx-x,
.hx-hc.hx-ch-d .hx-ch .hx-st.hx-a .hx-off-t.hx-x,
.hx-hc.hx-by-d .hx-by .hx-st.hx-a .hx-off-t.hx-x {
  opacity: 1;
}
.hx-hc.hx-co-d .hx-co .hx-st.hx-b .hx-fill,
.hx-hc.hx-ch-d .hx-ch .hx-st.hx-b .hx-fill,
.hx-hc.hx-by-d .hx-by .hx-st.hx-b .hx-fill {
  opacity: 1;
}
.hx-hc.hx-co-d .hx-co .hx-st.hx-b .hx-off-t,
.hx-hc.hx-ch-d .hx-ch .hx-st.hx-b .hx-off-t,
.hx-hc.hx-by-d .hx-by .hx-st.hx-b .hx-off-t {
  opacity: 0;
}
.hx-hc.hx-co-d .hx-co .hx-st.hx-b .hx-on-t.hx-x,
.hx-hc.hx-ch-d .hx-ch .hx-st.hx-b .hx-on-t.hx-x,
.hx-hc.hx-by-d .hx-by .hx-st.hx-b .hx-on-t.hx-x {
  opacity: 1;
}
.hx-hc.hx-co-d .hx-co .hx-cancel,
.hx-hc.hx-ch-d .hx-ch .hx-cancel,
.hx-hc.hx-by-d .hx-by .hx-cancel {
  opacity: 0;
}
.hx-hc.hx-co-d .hx-co .hx-form,
.hx-hc.hx-ch-d .hx-ch .hx-form,
.hx-hc.hx-by-d .hx-by .hx-form {
  opacity: 0;
}
.hx-hc.hx-co-d .hx-co .hx-notice,
.hx-hc.hx-ch-d .hx-ch .hx-notice,
.hx-hc.hx-by-d .hx-by .hx-notice {
  opacity: 1;
  transform: none;
}
/* busy: pressed, then the real busy label, disabled (opacity .5) */
.hx-hc.hx-co-pr .hx-co .hx-btn,
.hx-hc.hx-ch-pr .hx-ch .hx-btn,
.hx-hc.hx-by-pr .hx-by .hx-btn {
  transform: scale(0.96);
}
.hx-hc.hx-co-b .hx-co .hx-btn,
.hx-hc.hx-ch-b .hx-ch .hx-btn,
.hx-hc.hx-by-b .hx-by .hx-btn {
  opacity: 0.5;
}
.hx-hc.hx-co-b .hx-co .hx-btn .hx-l0,
.hx-hc.hx-ch-b .hx-ch .hx-btn .hx-l0,
.hx-hc.hx-by-b .hx-by .hx-btn .hx-q1,
.hx-hc.hx-by-b .hx-by .hx-btn .hx-q2 {
  opacity: 0 !important;
}
.hx-hc.hx-co-b .hx-co .hx-btn .hx-l1,
.hx-hc.hx-ch-b .hx-ch .hx-btn .hx-l1,
.hx-hc.hx-by-b .hx-by .hx-btn .hx-l1 {
  opacity: 1;
}
/* portal renewal: the new paid invoice arrives on top */
.hx-hc.hx-pt-r .hx-pt .hx-irow.hx-new {
  opacity: 1;
  transform: none;
}
.hx-hc.hx-pt-r .hx-pt .hx-irow.hx-old {
  transform: translateY(64px);
  border-top: 1px solid var(--hx-line);
}
.hx-hc.hx-pt-r .hx-pt .hx-v-a {
  opacity: 0;
}
.hx-hc.hx-pt-r .hx-pt .hx-v-b {
  opacity: 1;
}
/* plan change: the page scrolls to the proration preview */
.hx-hc.hx-ch-sc .hx-ch .hx-page {
  transform: translateY(-64px);
}
/* buy link: quantity 1 -> 2 */
.hx-hc.hx-by-q2 .hx-by .hx-q1 {
  opacity: 0;
}
.hx-hc.hx-by-q2 .hx-by .hx-q2 {
  opacity: 1;
}

/* typing: one run when the class arrives, ending filled */
.hx-hc.hx-co-t .hx-co .hx-p-card {
  animation: hc-out 0.075s ease 0.125s both;
}
.hx-hc.hx-co-t .hx-co .hx-g0 {
  animation: hc-in 0.09s ease 0.15s both;
}
.hx-hc.hx-co-t .hx-co .hx-g1 {
  animation: hc-in 0.09s ease 0.3s both;
}
.hx-hc.hx-co-t .hx-co .hx-g2 {
  animation: hc-in 0.09s ease 0.45s both;
}
.hx-hc.hx-co-t .hx-co .hx-g3 {
  animation: hc-in 0.09s ease 0.6s both;
}
.hx-hc.hx-co-t .hx-co .hx-sf .hx-visa {
  animation: hc-pop 0.15s ease 0.725s both;
}
.hx-hc.hx-co-t .hx-co .hx-r-card {
  animation: hc-out 0.1s ease 0.85s both;
}
.hx-hc.hx-co-t .hx-co .hx-r-exp {
  animation: hc-blink 0.6s ease 0.85s both;
}
.hx-hc.hx-co-t .hx-co .hx-p-exp {
  animation: hc-out 0.075s ease 0.925s both;
}
.hx-hc.hx-co-t .hx-co .hx-e1 {
  animation: hc-in 0.09s ease 0.95s both;
}
.hx-hc.hx-co-t .hx-co .hx-e2 {
  animation: hc-in 0.09s ease 1.1s both;
}
.hx-hc.hx-co-t .hx-co .hx-r-cvc {
  animation: hc-blink 0.45s ease 1.3s both;
}
.hx-hc.hx-co-t .hx-co .hx-p-cvc {
  animation: hc-out 0.075s ease 1.35s both;
}
.hx-hc.hx-co-t .hx-co .hx-cv {
  animation: hc-in 0.09s ease 1.375s both;
}
@keyframes hc-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes hc-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@keyframes hc-pop {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes hc-blink {
  0% {
    opacity: 0;
  }
  15%,
  80% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .hx-hero {
    animation: hcbg-drift 20s ease-in-out infinite alternate;
  }
  .hx-hero.hx-held {
    animation-play-state: paused;
  }
  @keyframes hcbg-drift {
    from {
      background-position: 0% 0%;
    }
    to {
      background-position: 100% 100%;
    }
  }
}
@media (prefers-reduced-motion: reduce) {
  .hx-hc .hx-ptr {
    display: none;
  }
  .hx-hero *,
  .hx-hero *::before {
    transition: none !important;
    animation: none !important;
  }
}

/* phone: the story buttons take the first line, the steps and pause the second */
@container hxh (max-width: 699.98px) {
  .hx-hero .hx-ctl .hx-vsep,
  .hx-hero .hx-ctl .hx-sep {
    display: none;
  }
  .hx-hero .hx-ctl .hx-stg-grp {
    gap: 2px;
  }
  .hx-hero .hx-ctl {
    padding: 14px 8px 0;
  }
  .hx-hero .hx-tabs {
    flex-basis: 100%;
    justify-content: center;
  }
  .hx-hero .hx-ctl .hx-stages {
    justify-items: center;
  }
}

/* phone: MkIll stacks below 700px; the board shows one line and the money rail */
@container ill (max-width: 699.98px) {
  .hx-hc {
    overflow: visible;
  }
  .hx-hc .hx-win,
  .hx-hc .hx-wires,
  .hx-hc .hx-ptr {
    display: none;
  }
  .hx-hc .hx-abs {
    position: static;
  }
  .hx-hc .hx-mrail {
    width: auto;
    height: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hx-hc .hx-rc {
    position: relative;
    top: auto;
  }
  .hx-hc .hx-evt {
    display: block;
  }
  .hx-hc .hx-safe2 {
    position: relative;
    top: auto;
    align-self: flex-start;
  }
  .hx-hc .hx-scene {
    position: relative;
    padding: 14px 16px 24px;
  }
}
</style>
