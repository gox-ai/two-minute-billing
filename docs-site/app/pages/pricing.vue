<script setup lang="ts">
/**
 * Pricing (F3). Plans and prices come from our own catalogue through `/api/plans`; the page
 * types none of them. The currency follows the visitor's location (India INR, EU EUR, else
 * USD) — the same rule billing applies — and is not a choice.
 *
 * Plans differ only by monthly billing volume, so each card leads with its limit, and a plan
 * finder sets the flat price against a share-of-revenue fee.
 */
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import type { SchemaOffer } from "~/composables/useMarketingSeo";

definePageMeta({ layout: "marketing", header: false, footer: false });

const { signUp } = useAppLinks();
// "plans-visitor", not "plans": see useFreeBand.
const { data } = await useFetch("/api/plans", { key: "plans-visitor" });

/** From the visitor's location, as billing decides it (India INR, the EU EUR, else USD). Not a choice. */
const currency = computed(() => data.value?.preferred ?? "USD");
const interval = ref<"month" | "year">("year");

/** A price for display, with no cents when the amount is whole ("$29", not "$29.00"). */
const fmt = (minor: number, cur = currency.value) =>
  new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en", {
    style: "currency",
    currency: cur,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);

/** The Free plan from the catalogue, in the visitor's currency. Display-only: never a checkout. */
const free = computed(() => (data.value?.free ?? []).find((p) => p.currency === currency.value));
const freeBand = await useFreeBand("plans-visitor");
/** Billy's included credits per plan, from the catalogue (1 credit ≈ 1 question). */
const assistantUse = await useAssistantUse("plans-visitor");
const billyLine = (credits: number | null | undefined) =>
  credits ? `Billy, with ${formatCredits(credits)} a month` : "Billy included";

type CatalogPlan = NonNullable<typeof data.value>["plans"][number];

/** Every paid plan at this interval, smallest first. */
const plans = computed(() =>
  (data.value?.plans ?? []).filter(
    (p) => p.amountMinor > 0 && p.currency === currency.value && p.interval === interval.value,
  ),
);
const monthlyOf = (p: { name: string; currency: string }) =>
  (data.value?.plans ?? []).find(
    (m) => m.name === p.name && m.currency === p.currency && m.interval === "month",
  );
const yearlyOf = (p: { name: string; currency: string }) =>
  (data.value?.plans ?? []).find(
    (m) => m.name === p.name && m.currency === p.currency && m.interval === "year",
  );
/** Yearly shown per month: the headline is what a month costs, rounded to a whole unit. */
const perMonthMinor = (p: { amountMinor: number }) => Math.round(p.amountMinor / 12 / 100) * 100;

/**
 * A paid plan's monthly billing limit, in minor units. The public pricing page carries it only
 * in the description the catalogue writes ("Bill up to $10,000 a month. Every feature.", see
 * backoffice account-billing setup). Null when it cannot be read: the plan finder hides.
 */
const bandOf = (p: { description: string | null }): number | null => {
  const m = p.description?.match(/up to\s+\D*?([\d,.\s]+)\s+a month/i);
  const n = m ? Number(m[1]!.replace(/[^\d]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n * 100 : null;
};

/* ---------- The running campaign (Black Friday first) ---------- */

/**
 * From the catalogue: its percent comes off a covered plan's first year. Only a first-year
 * offer changes the page; every figure is computed from the catalogue, never typed.
 */
const offer = computed(() => {
  const o = (data.value?.offers?.[0] as Offer | undefined) ?? null;
  return o && offerTerm(o) === "your first year" ? o : null;
});
const covered = (p: { interval: "month" | "year" }) =>
  !!offer.value && offerCovers(offer.value, p.interval);
/** What a covered plan costs for its first year (yearly) or first month (monthly). */
const firstYearMinor = (p: { amountMinor: number }) =>
  Math.round(p.amountMinor * (1 - (offer.value?.percentOff ?? 0) / 100));
/** The first-year price per month, rounded DOWN to a whole unit: ₹11,995 a year → ₹999. */
const firstYearPerMonthMinor = (p: { amountMinor: number; interval: "month" | "year" }) =>
  p.interval === "year" ? Math.floor(firstYearMinor(p) / 12 / 100) * 100 : firstYearMinor(p);

/** The yearly saving against paying monthly, as a whole percent (floored, never overstated). */
const yearlySaving = computed(() => {
  const pct = (data.value?.plans ?? [])
    .filter((p) => p.interval === "year" && p.amountMinor > 0 && p.currency === currency.value)
    .map((y) => {
      const m = monthlyOf(y);
      return m ? 1 - y.amountMinor / (m.amountMinor * 12) : 0;
    });
  return pct.length ? Math.floor(Math.min(...pct) * 100) : 0;
});
/** One number per offer: while a campaign covers yearly, the tag says what the cards say. */
/** The advertised saving: yearly discount and campaign together, from the catalogue. */
const headline = computed(() =>
  offer.value ? headlinePercent(offer.value, data.value?.plans ?? []) : 0,
);
const yearlyLabel = computed(() =>
  offer.value && offerCovers(offer.value, "year")
    ? `Save ${headline.value}%`
    : `Save ${yearlySaving.value}%`,
);

/**
 * One plan card's price: the per-month figure, the usual price struck beside it while a
 * campaign covers the plan, and one short billing line. The renewal price is the struck one.
 */
const card = (p: CatalogPlan) => {
  if (covered(p))
    return {
      price: fmt(firstYearPerMonthMinor(p), p.currency),
      // Struck: the monthly price, so the card shows the whole saving the headline claims.
      was: fmt(monthlyOf(p)?.amountMinor ?? p.amountMinor, p.currency),
      line:
        p.interval === "year"
          ? `Billed ${fmt(firstYearMinor(p), p.currency)} for your first year`
          : "For your first year",
    };
  if (p.interval === "year")
    return {
      price: fmt(perMonthMinor(p), p.currency),
      was: null,
      line: `Billed ${fmt(p.amountMinor, p.currency)} a year`,
    };
  return { price: fmt(p.amountMinor, p.currency), was: null, line: "Billed monthly" };
};

/** The plan finder's scale: a log scale from half the Free band to twice the Scale band. */
const scale = computed(() => {
  const fb = free.value?.bandMinor ?? null;
  const bands = plans.value.map(bandOf);
  if (fb == null || bands.length === 0 || bands.some((b) => b == null)) return null;
  const top = bands[bands.length - 1]!;
  return { lo: fb / 2, hi: top * 2, free: fb, bands: bands as number[] };
});

/* ---------- Plan finder ---------- */

/** The share-of-revenue rate we compare with: the low end of the published 0.65%–0.9%. */
const SHARE = 0.007;
const SHARE_PCT = "0.7%";
const SHARE_RANGE = "0.65% to 0.9%";
const slider = ref(560);
const sliderMinor = (x: number) => {
  const s = scale.value!;
  const v = s.lo * Math.pow(s.hi / s.lo, x / 1000);
  // Round to two significant figures so the readout looks like a real monthly figure.
  const step = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return Math.round(v / step) * step;
};
const finder = computed(() => {
  const s = scale.value;
  if (!s) return null;
  const volume = sliderMinor(slider.value);
  const monthlyPlans = (data.value?.plans ?? []).filter(
    (p) => p.amountMinor > 0 && p.currency === currency.value && p.interval === "month",
  );
  const monthly = monthlyPlans.find((p) => {
    const band = bandOf(p);
    return volume >= s.free && band != null && volume <= band;
  });
  // While a campaign covers yearly plans, the finder prices the first year of the yearly plan.
  const yearly = monthly && yearlyOf(monthly);
  const deal = !!yearly && covered(yearly);
  const pick =
    volume < s.free
      ? { name: "Free", minor: 0, usual: null, yearMinor: 0 }
      : monthly
        ? deal
          ? {
              name: monthly.name,
              minor: firstYearPerMonthMinor(yearly!),
              usual: monthly.amountMinor,
              yearMinor: firstYearMinor(yearly!),
            }
          : {
              name: monthly.name,
              minor: monthly.amountMinor,
              usual: null,
              yearMinor: monthly.amountMinor * 12,
            }
        : null;
  const share = Math.round(volume * SHARE);
  const top = Math.max(share, pick?.minor ?? 0, 1);
  return {
    volume: fmt(volume),
    pick,
    deal,
    share: fmt(share),
    usWidth: pick ? Math.max(pick.minor ? 1.5 : 0, (pick.minor / top) * 100) : 0,
    shareWidth: (share / top) * 100,
    kept: pick ? fmt(Math.max(0, share * 12 - pick.yearMinor)) : null,
  };
});
const ticks = computed(() => {
  const s = scale.value;
  if (!s) return [];
  const at = (v: number) => (Math.log(v / s.lo) / Math.log(s.hi / s.lo)) * 100;
  return [s.lo, s.bands[0]!, s.bands[1] ?? s.bands[0]!, s.hi].map((v) => ({
    left: at(v),
    label: fmt(v),
  }));
});

/* ---------- Every plan includes ---------- */

/** Grouped once; the tone says what a group is about (cyan = running billing, lime = money won). */
const groups = [
  {
    title: "Plans and pricing",
    icon: "i-lucide-layers",
    tone: "billing",
    items: [
      "Plans, add-ons, one-time products and coupons",
      "Eight pricing models, including tiered and metered usage",
      "Trials, proration and scheduled changes",
    ],
  },
  {
    title: "Invoices and tax",
    icon: "i-lucide-file-text",
    tone: "billing",
    items: [
      "Invoices and credit notes with branded PDFs",
      "GST by place of supply, VAT reverse charge, TDS",
    ],
  },
  {
    title: "Payments and checkout",
    icon: "i-lucide-credit-card",
    tone: "billing",
    items: [
      "All 12 gateways, several per business",
      "Hosted checkout, buy links and a pricing page",
      "A customer portal",
    ],
  },
  {
    title: "Payment recovery",
    icon: "i-lucide-rotate-ccw",
    tone: "growth",
    items: ["Smart retries", "A backup card", "Recovery emails"],
  },
  {
    title: "Reports",
    icon: "i-lucide-chart-column",
    tone: "growth",
    items: ["MRR, churn and cohorts", "An analytics API"],
  },
  {
    title: "Billy, the AI assistant",
    icon: "i-lucide-sparkles",
    tone: "plain",
    items: ["Included use every month", "Or your own AI key"],
  },
  {
    title: "For developers",
    icon: "i-lucide-code",
    tone: "plain",
    items: ["An API for every dashboard screen", "Test mode with a movable clock"],
  },
  {
    title: "Your team",
    icon: "i-lucide-shield-check",
    tone: "plain",
    items: ["Roles and an audit log", "Passkeys and two-factor sign-in"],
  },
] as const;

/* ---------- Cloud or self-hosted ---------- */

const ways = computed(() => {
  const launch = plans.value[0] ? monthlyOf(plans.value[0]) : undefined;
  return [
    {
      name: "Cloud",
      tag: launch
        ? `Free, then from ${fmt(launch.amountMinor, launch.currency)} a month`
        : "Free to start",
      line: "We host it, upgrade it and watch it for you.",
      rows: [
        ["Who runs it", "We do"],
        ["Limits", "Monthly billing volume, by plan"],
        ["Upgrades", "Applied for you"],
        ["Monitoring", "Ours, around the clock"],
        ["Billy", "Included use each month, or your own key"],
        ["Support", "Included"],
      ],
      cloud: true,
    },
    {
      name: "Self-hosted",
      tag: "Free · AGPL-3.0",
      line: "Open-source billing software on your own servers: the engine, dashboard and docs.",
      rows: [
        ["Who runs it", "You do, on your servers"],
        ["Limits", "None"],
        ["Upgrades", "You apply new releases"],
        ["Monitoring", "Yours to set up"],
        ["Billy", "Your own model key, or a local model"],
        ["Support", "Enterprise support on request"],
      ],
      cloud: false,
    },
  ];
});

/* ---------- FAQ ---------- */

const faq = computed(() => [
  {
    label: "What counts as billing volume?",
    content:
      "The payments you collect in live mode in a calendar month, less refunds, in your plan's currency. Test mode never counts.",
  },
  {
    label: "What happens if I bill more than my plan covers?",
    content:
      "Your billing carries on. We tell you on the Billing page and ask you to change to a larger plan. If you stay above the limit, we can make your dashboard read-only until you change plan. Your customers are still billed.",
  },
  {
    label: "Is the free plan really free?",
    content: `Yes. It is free while you bill less than ${freeBand.value} a month, in live mode, with every feature and no time limit. No credit card required. Then a flat monthly price.`,
  },
  {
    label: "Is Billy, the AI assistant, included in my plan?",
    content: `Yes. Each Cloud plan includes Billy credits every month${
      assistantUse.value.length ? `: ${listAssistantUse(assistantUse.value)}` : ""
    }. A credit is about one question; a long question that reads a lot of data can use more. Credits start again on the first day of each month. Add your own key from OpenAI, Anthropic or Google, and Billy use does not count against your plan.`,
  },
  {
    label: "What happens when the included use runs out?",
    content:
      "Settings → Billy shows how many of this month's credits you used. To use more, add your own AI key in Settings → Billy. Questions then go to your AI provider, on your account.",
  },
  {
    label: "Can I change plans?",
    content: "Yes, from Settings → Billing at any time, within the same currency.",
  },
  {
    label: "Which currency do I pay in?",
    content:
      "Organizations in India pay in INR, in the European Union in EUR, and everywhere else in USD. Prices are before tax.",
  },
  {
    label: "Do you take a percentage of my revenue, or a fee per transaction?",
    content: `No. You pay the plan price. Billing platforms that charge a share of revenue publish rates from ${SHARE_RANGE}. Your payment gateway charges its own fees as it does today.`,
  },
]);
/** The smallest covered yearly plan in the visitor's currency, as the worked example. */
const offerExample = computed(() => {
  const y = (data.value?.plans ?? []).find(
    (p) =>
      p.interval === "year" && p.amountMinor > 0 && p.currency === currency.value && covered(p),
  );
  const m = y && monthlyOf(y);
  return y && m
    ? { name: y.name, firstYear: fmt(firstYearMinor(y)), monthly: fmt(m.amountMinor * 12) }
    : null;
});

/**
 * The campaign's answer leads the FAQ while it runs (the first one is open), in the same one
 * number as the bar and the cards. It stays out of the FAQ schema.
 */
const faqShown = computed(() => {
  const o = offer.value;
  if (!o) return faq.value;
  const by = offerLastDay(o);
  const ex = offerExample.value;
  const content =
    offerCovers(o, "year") && ex
      ? `Select a yearly plan by ${by}. Your first year costs ${headline.value}% less than paying monthly: ${ex.name} is ${ex.firstYear} for the year instead of ${ex.monthly}. From the second year you pay the usual yearly price, still ${yearlySaving.value}% below monthly. Sign up for Free by ${by} and the offer waits for your first yearly plan.`
      : `Sign up by ${by} and you keep ${headline.value}% off ${offerTerm(o)} on ${offerPlans(o)}, whenever you upgrade. After that you pay the usual price.`;
  return [{ label: `How do I get ${headline.value}% off?`, content }, ...faq.value];
});

/**
 * Offers in the schema come from the same live catalogue read as the cards, in the visitor's
 * currency, at full price: a temporary campaign never enters the price data.
 */
const offers = computed<SchemaOffer[]>(() => [
  {
    name: "Free plan",
    price: "0",
    priceCurrency: currency.value,
    description: `Free while you bill less than ${freeBand.value} a month. Every feature.`,
  },
  ...(data.value?.plans ?? [])
    .filter((p) => p.amountMinor > 0 && p.currency === currency.value)
    .map((p) => ({
      name: `${p.name}, billed ${p.interval === "year" ? "yearly" : "monthly"}`,
      price: (p.amountMinor / 100).toFixed(2),
      priceCurrency: p.currency,
      billingDuration: p.interval === "year" ? ("P1Y" as const) : ("P1M" as const),
    })),
]);

useMarketingSeo({
  title: "Billing software pricing",
  crumb: "Pricing",
  description: `Flat monthly subscription billing plans with every feature and no share of your revenue. Free while you bill less than ${freeBand.value} a month. No credit card.`,
  og: STATIC_OG["/pricing"]!,
  faq: faq.value,
  offers,
});

const pickPlan = (plan: string, billing_period: string, cur?: string) =>
  track("select_plan", { plan, billing_period, currency: cur });
</script>

<template>
  <div class="pr">
    <section class="mk-hero pr-hero">
      <UContainer class="relative grid justify-items-center gap-4 pt-12 pb-6 text-center lg:pt-16">
        <h1 class="pr-h1 text-highlighted">
          A flat price for subscription billing. <em>Never a share</em> of your revenue.
        </h1>
        <p class="max-w-2xl text-lg text-muted">
          Every plan has every feature. Your plan only sets how much you bill each month, and the
          Free plan covers you while you bill less than {{ freeBand }} a month.
        </p>
        <ul class="pr-facts" aria-label="On every plan">
          <li><UIcon name="i-lucide-check" />Every feature on every plan</li>
          <li><UIcon name="i-lucide-check" />Your own payment gateway</li>
          <li><UIcon name="i-lucide-check" />No credit card to start</li>
        </ul>
        <!-- The header keeps its sign-up button in the menu on phones. -->
        <UButton :to="signUp" size="lg" class="min-h-11 sm:hidden">Start for free</UButton>
        <div class="pr-seg" role="group" aria-label="Billing period">
          <button type="button" :aria-pressed="interval === 'month'" @click="interval = 'month'">
            Monthly
          </button>
          <button type="button" :aria-pressed="interval === 'year'" @click="interval = 'year'">
            Yearly
            <span
              v-if="yearlySaving"
              class="pr-save"
              :class="{ 'pr-bf': offer && offerCovers(offer, 'year') }"
              >{{ yearlyLabel }}</span
            >
          </button>
        </div>
        <p
          v-if="offer && interval === 'month' && !offerCovers(offer, 'month')"
          class="text-sm text-muted"
        >
          {{ offer.name }} is on yearly plans: {{ headline }}% off your first year.
          <button type="button" class="font-semibold text-primary" @click="interval = 'year'">
            Show yearly prices
          </button>
        </p>
      </UContainer>
    </section>

    <section id="plans" class="scroll-mt-[calc(5rem+var(--mk-campaign-h))]">
      <UContainer class="pt-4 pb-10 lg:pb-12">
        <h2 class="sr-only">Plans</h2>
        <div class="pr-plans" data-cta-location="pricing_plan">
          <article class="pr-plan">
            <div class="pr-top"><h3>Free</h3></div>
            <div class="pr-band">
              <small>Free while you bill less than</small>
              <b>{{ freeBand }} a month</b>
            </div>
            <div class="pr-price">
              <div class="pr-amt">
                <b>{{ fmt(0) }}</b
                ><span>/month</span>
              </div>
              <span v-if="offer" class="pr-l1 pr-bfline">
                Sign up by {{ offerLastDay(offer, "short") }} to keep {{ headline }}% off
              </span>
              <span v-else class="pr-l1">No time limit</span>
            </div>
            <UButton
              :to="signUp"
              color="neutral"
              variant="outline"
              size="lg"
              block
              @click="pickPlan('Free', interval)"
            >
              Start for free
            </UButton>
            <ul class="pr-incl">
              <li><UIcon name="i-lucide-check" />Live mode and test mode</li>
              <li><UIcon name="i-lucide-check" />Every feature</li>
              <li><UIcon name="i-lucide-check" />{{ billyLine(free?.assistantCredits) }}</li>
            </ul>
          </article>

          <template v-if="data?.available">
            <article
              v-for="p in plans"
              :key="`${p.name}-${p.currency}-${p.interval}`"
              class="pr-plan"
              :class="{ 'pr-hl': p.name === 'Growth' }"
            >
              <div class="pr-top">
                <h3>{{ p.name }}</h3>
                <span v-if="covered(p)" class="pr-offer"> {{ headline }}% off first year </span>
              </div>
              <div class="pr-band">
                <small>Bill up to</small>
                <b v-if="bandOf(p)">{{ fmt(bandOf(p)!, p.currency) }} a month</b>
                <b v-else>{{ p.description }}</b>
              </div>
              <div class="pr-price">
                <div class="pr-amt">
                  <b>{{ card(p).price }}</b>
                  <s v-if="card(p).was" :aria-label="`Usually ${card(p).was}`">{{ card(p).was }}</s>
                  <span>/month</span>
                </div>
                <span class="pr-l1">{{ card(p).line }}</span>
              </div>
              <UButton
                :to="signUp"
                size="lg"
                block
                :color="p.name === 'Growth' ? 'primary' : 'neutral'"
                :variant="p.name === 'Growth' ? 'solid' : 'outline'"
                @click="pickPlan(p.name, p.interval, p.currency)"
              >
                Get started
              </UButton>
              <ul class="pr-incl">
                <li><UIcon name="i-lucide-check" />Every feature, live and test</li>
                <li><UIcon name="i-lucide-check" />Unlimited customers and team</li>
                <li>
                  <UIcon name="i-lucide-check" />{{
                    billyLine(p.assistantCredits ?? monthlyOf(p)?.assistantCredits)
                  }}
                </li>
              </ul>
            </article>
          </template>
          <div v-else class="pr-plan pr-fail">
            We could not load the plan prices. Reload the page to try again.
          </div>
        </div>

        <div class="pr-ent">
          <div>
            <b>Enterprise</b>
            <p>
              More than the Scale plan's billing volume, an agreement and invoicing terms, or help
              moving your billing to us.
            </p>
          </div>
          <UButton
            to="/contact?topic=Enterprise"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-arrow-right"
          >
            Contact us
          </UButton>
        </div>
        <p class="mt-4 text-center text-sm text-muted">
          Prices in {{ currency }}, before tax. Change your plan at any time in Settings → Billing.
          <ULink to="/product/ai-assistant" class="font-medium text-primary">Billy</ULink> is the AI
          assistant in your dashboard.
        </p>
      </UContainer>
    </section>

    <section v-if="finder" class="py-14 lg:py-20">
      <UContainer>
        <div class="pr-head">
          <p class="mk-kicker">Find your plan</p>
          <h2 class="mk-h2 text-highlighted">What you pay as you grow</h2>
          <p class="text-muted">
            Move the slider to your monthly billing. Your price stays flat inside a plan. A share of
            revenue grows with every sale.
          </p>
        </div>
        <div class="pr-calc">
          <div class="pr-calc-l">
            <label for="pr-volume" class="text-sm font-semibold text-highlighted">
              How much do you bill a month?
            </label>
            <output for="pr-volume" class="pr-vol">{{ finder.volume }}</output>
            <div>
              <input
                id="pr-volume"
                v-model.number="slider"
                class="pr-slider"
                type="range"
                min="0"
                max="1000"
                :aria-valuetext="`${finder.volume} a month`"
              />
              <div class="pr-ticks" aria-hidden="true">
                <span v-for="t in ticks" :key="t.label" :style="{ left: `${t.left}%` }">
                  {{ t.label }}
                </span>
              </div>
            </div>
            <p class="pr-pick">
              <template v-if="finder.pick">
                Your plan: <b>{{ finder.pick.name }}</b> ·
                {{ finder.pick.minor ? `${fmt(finder.pick.minor)} a month` : "free" }}
                <template v-if="finder.pick.usual">
                  <s class="pr-was">{{ fmt(finder.pick.usual) }}</s>
                  <span class="pr-offer">Save {{ headline }}%</span>
                </template>
              </template>
              <template v-else>Above Scale: <b>Enterprise</b> · a price agreed with you</template>
            </p>
          </div>
          <div class="pr-calc-r">
            <div class="pr-bar">
              <div>
                <span>Two Minute Billing</span
                ><b
                  ><s v-if="finder.pick?.usual" class="pr-was">{{ fmt(finder.pick.usual) }}</s>
                  {{
                    finder.pick
                      ? finder.pick.minor
                        ? `${fmt(finder.pick.minor)} a month`
                        : "Free"
                      : "Agreed with you"
                  }}</b
                >
              </div>
              <span class="pr-track"
                ><i class="pr-us" :style="{ width: `${finder.usWidth}%` }"
              /></span>
            </div>
            <div class="pr-bar">
              <div>
                <span>A {{ SHARE_PCT }} share of revenue</span><b>{{ finder.share }} a month</b>
              </div>
              <span class="pr-track"
                ><i class="pr-them" :style="{ width: `${finder.shareWidth}%` }"
              /></span>
            </div>
            <div class="pr-kept">
              <small>{{
                finder.deal ? "You keep in your first year" : "You keep, every year"
              }}</small>
              <b>{{ finder.kept ?? "Ask us for a quote" }}</b>
            </div>
            <p class="text-xs text-muted">
              <template v-if="finder.deal">
                {{ offer!.name }}: the first year of a yearly plan, {{ headline }}% below paying
                monthly.
              </template>
              <template v-else>Monthly cost at the plan's monthly price.</template> Billing
              platforms that charge a share of revenue publish rates from {{ SHARE_RANGE }}; we
              compare with {{ SHARE_PCT }}. Your payment gateway's own fees apply either way.
            </p>
          </div>
        </div>
      </UContainer>
    </section>

    <section class="mk-tint border-y border-default py-14 lg:py-20">
      <UContainer>
        <div class="pr-head">
          <p class="mk-kicker">Every plan includes</p>
          <h2 class="mk-h2 text-highlighted">No feature tiers</h2>
          <p class="text-muted">
            A plan sets how much you bill each month, and nothing else. The Free plan gets the same
            product as Scale.
            <ULink to="/product" class="font-medium text-primary">See how each feature works</ULink>
          </p>
        </div>
        <div class="pr-groups">
          <div v-for="g in groups" :key="g.title" class="pr-grp">
            <span class="pr-ico" :class="`pr-ico-${g.tone}`"><UIcon :name="g.icon" /></span>
            <h3>{{ g.title }}</h3>
            <ul>
              <li v-for="i in g.items" :key="i">{{ i }}</li>
            </ul>
          </div>
        </div>
      </UContainer>
    </section>

    <section class="py-14 lg:py-20">
      <UContainer>
        <div class="pr-head">
          <p class="mk-kicker">Cloud or self-hosted</p>
          <h2 class="mk-h2 text-highlighted">The same engine either way</h2>
          <p class="text-muted">The difference is who keeps it running.</p>
        </div>
        <div class="pr-ways">
          <div v-for="w in ways" :key="w.name" class="pr-way" :class="{ 'pr-way-cloud': w.cloud }">
            <div class="pr-way-top">
              <h3>{{ w.name }}</h3>
              <span class="text-sm font-medium text-primary">{{ w.tag }}</span>
            </div>
            <p class="text-sm text-muted">{{ w.line }}</p>
            <dl>
              <template v-for="[k, v] in w.rows" :key="k">
                <dt>{{ k }}</dt>
                <dd>{{ v }}</dd>
              </template>
            </dl>
            <div class="flex flex-wrap gap-2">
              <UButton v-if="w.cloud" :to="signUp" @click="pickPlan('Free', interval)">
                Start for free
              </UButton>
              <template v-else>
                <UButton to="/open-source" color="neutral" variant="outline">
                  About self-hosting
                </UButton>
                <UButton
                  to="/contact?topic=Self-hosted%20support"
                  color="neutral"
                  variant="outline"
                  trailing-icon="i-lucide-arrow-right"
                >
                  Enterprise support
                </UButton>
              </template>
            </div>
          </div>
        </div>
      </UContainer>
    </section>

    <MkFaq :items="faqShown" title="Pricing questions" />

    <MkCta
      title="Start billing on your own gateway"
      accent="your own gateway"
      :description="`Free while you bill less than ${freeBand} a month. No credit card. Then a flat monthly price, never a share of your revenue.`"
      :secondary="{ label: 'Contact us', to: '/contact' }"
      shot="/product/business-home"
      :zoom="1.6"
    />
  </div>
</template>

<style scoped>
.pr-hero::before {
  content: "";
  position: absolute;
  inset: -30% 15% auto;
  height: 420px;
  z-index: -1;
  background: radial-gradient(closest-side, var(--mk-accent-soft), transparent);
  pointer-events: none;
}
.pr-h1 {
  max-width: 22ch;
  font-size: 2.25rem;
  line-height: 1.06;
  font-weight: 600;
  letter-spacing: -0.03em;
  text-wrap: balance;
}
.pr-h1 em {
  font-style: normal;
  color: var(--ui-primary);
}
@media (min-width: 640px) {
  .pr-h1 {
    font-size: 3.25rem;
  }
}
.pr-facts {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem;
}
.pr-facts li {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--mk-card);
  font-size: 0.8125rem;
  font-weight: 500;
}
.pr-facts :deep(.iconify) {
  color: var(--ui-primary);
}

.pr-seg {
  display: inline-flex;
  gap: 2px;
  margin-top: 0.5rem;
  padding: 4px;
  border-radius: 11px;
  background: var(--mk-accent-soft);
}
.pr-seg button {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 2.5rem;
  padding: 0.4rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.pr-seg button[aria-pressed="true"] {
  background: var(--mk-card);
  color: var(--ui-text-highlighted);
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.08),
    0 0 0 1px var(--mk-accent-line);
}
.pr-seg button:focus-visible,
.pr-slider:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.pr-save {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mk-lime);
  color: var(--mk-lime-ink);
  font-size: 0.72rem;
  font-weight: 700;
}

.pr-plans {
  display: grid;
  gap: 0.875rem;
}
@media (min-width: 768px) {
  .pr-plans {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 1280px) {
  .pr-plans {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.pr-plan {
  display: grid;
  grid-template-rows: auto auto auto auto 1fr;
  align-content: start;
  gap: 0.875rem;
  min-width: 0;
  padding: 1.375rem 1.25rem 1.25rem;
  border: 1px solid var(--ui-border);
  border-radius: 16px;
  background: var(--mk-card);
}
.pr-hl {
  border-color: var(--ui-primary);
  box-shadow:
    0 0 0 1px var(--ui-primary),
    0 18px 40px -26px var(--ui-primary);
}
.pr-fail {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 0.875rem;
  color: var(--ui-text-muted);
}
@media (min-width: 1280px) {
  .pr-fail {
    grid-column: span 3;
  }
}
.pr-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 1.625rem;
}
.pr-top h3 {
  font-size: 1.1875rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ui-text-highlighted);
}
/* Black Friday is black: the offer pill and the yearly tag, with the offer in lime. */
.pr-offer,
.pr-save.pr-bf {
  background: var(--mk-campaign);
  color: var(--mk-lime);
  box-shadow: inset 0 0 0 1px var(--mk-campaign-edge);
}
.pr-offer {
  white-space: nowrap;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
}
.pr-band {
  display: grid;
  gap: 0.4rem;
}
.pr-band small {
  font-size: 0.75rem;
  color: var(--ui-text-muted);
}
.pr-band b {
  font-size: 0.9375rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-highlighted);
}
.pr-price {
  display: grid;
  align-content: start;
  gap: 0.2rem;
  min-height: 4rem;
  padding-top: 0.875rem;
  border-top: 1px dashed var(--ui-border);
}
.pr-amt {
  display: flex;
  align-items: baseline;
  gap: 0.3rem;
  font-variant-numeric: tabular-nums;
}
.pr-amt b {
  font-size: 2.5rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.035em;
  color: var(--ui-text-highlighted);
}
.pr-amt span,
.pr-l1 {
  font-size: 0.8125rem;
  color: var(--ui-text-muted);
}
.pr-amt s {
  font-size: 1.05rem;
  font-weight: 500;
  color: var(--ui-text-dimmed);
}
.pr-l1 {
  font-variant-numeric: tabular-nums;
}
.pr-bfline {
  font-weight: 600;
  color: var(--mk-lime-text);
}
.pr-incl {
  display: grid;
  align-content: start;
  gap: 0.5rem;
  font-size: 0.84rem;
  color: var(--ui-text-toned);
}
.pr-incl li,
.pr-grp li {
  display: flex;
  gap: 0.5rem;
}
.pr-incl :deep(.iconify) {
  flex-shrink: 0;
  margin-top: 0.15rem;
  color: var(--ui-primary);
}
.pr-ent {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 0.875rem;
  padding: 1.125rem 1.25rem;
  border: 1px solid var(--ui-border);
  border-radius: 16px;
  background: var(--mk-tint);
}
.pr-ent b {
  color: var(--ui-text-highlighted);
}
.pr-ent p {
  max-width: 70ch;
  font-size: 0.875rem;
  color: var(--ui-text-muted);
}

.pr-head {
  display: grid;
  gap: 0.5rem;
  max-width: 60ch;
  margin-bottom: 1.75rem;
}

.pr-calc {
  display: grid;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 18px;
  background: var(--mk-card);
}
@media (min-width: 768px) {
  .pr-calc {
    grid-template-columns: 1fr 1fr;
  }
}
.pr-calc-l,
.pr-calc-r {
  display: grid;
  align-content: start;
  gap: 1.1rem;
  padding: 1.5rem;
}
@media (min-width: 768px) {
  .pr-calc-l,
  .pr-calc-r {
    padding: 1.75rem;
  }
  .pr-calc-l {
    border-right: 1px solid var(--ui-border);
  }
}
.pr-calc-r {
  background: var(--mk-tint);
}
.pr-vol {
  font-size: 2.4rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-highlighted);
}
.pr-slider {
  width: 100%;
  height: 1.5rem;
  accent-color: var(--ui-primary);
  cursor: pointer;
}
.pr-ticks {
  position: relative;
  height: 1.1rem;
  font-size: 0.75rem;
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
}
.pr-ticks span {
  position: absolute;
  top: 0;
  white-space: nowrap;
  transform: translateX(-50%);
}
.pr-ticks span:first-child {
  transform: none;
}
.pr-ticks span:last-child {
  transform: translateX(-100%);
}
/* On a phone the third label would run into the last one. */
@media (max-width: 639px) {
  .pr-ticks span:nth-child(3) {
    display: none;
  }
}
.pr-pick {
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--mk-accent-line);
  border-radius: 12px;
  background: var(--mk-accent-soft);
  font-size: 0.875rem;
}
.pr-was {
  margin-inline: 0.15rem 0.35rem;
  font-weight: 400;
  color: var(--ui-text-dimmed);
}
.pr-pick .pr-offer {
  margin-left: 0.25rem;
}
.pr-pick b {
  color: var(--ui-primary);
}
.pr-bar {
  display: grid;
  gap: 0.4rem;
}
.pr-bar > div {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.84rem;
}
.pr-bar b {
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-highlighted);
}
.pr-track {
  display: block;
  height: 14px;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--mk-card);
}
.pr-track i {
  display: block;
  height: 100%;
  border-radius: 5px;
  transition: width 0.2s ease;
}
.pr-us {
  background: var(--ui-primary);
}
.pr-them {
  background: var(--mk-plain);
}
.pr-kept {
  display: grid;
  gap: 0.1rem;
  padding: 1rem;
  border-radius: 12px;
  background: var(--mk-lime-soft);
}
.pr-kept small {
  font-size: 0.8125rem;
  color: var(--ui-text-muted);
}
.pr-kept b {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--mk-lime-text);
}

.pr-groups {
  display: grid;
  gap: 0.875rem;
}
@media (min-width: 640px) {
  .pr-groups {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 1024px) {
  .pr-groups {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
.pr-grp {
  display: grid;
  align-content: start;
  gap: 0.6rem;
  min-width: 0;
  padding: 1.125rem;
  border: 1px solid var(--ui-border);
  border-radius: 14px;
  background: var(--mk-card);
}
.pr-grp h3 {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.pr-grp ul {
  display: grid;
  gap: 0.3rem;
  font-size: 0.84rem;
  color: var(--ui-text-muted);
}
.pr-ico {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 10px;
  font-size: 1.15rem;
}
.pr-ico-billing {
  background: var(--mk-cyan-soft);
  color: var(--mk-cyan);
}
.pr-ico-growth {
  background: var(--mk-lime-soft);
  color: var(--mk-lime-deep);
}
.pr-ico-plain {
  border: 1px solid var(--mk-plain-line);
  background: var(--mk-plain-soft);
  color: var(--mk-plain);
}

.pr-ways {
  display: grid;
  gap: 0.875rem;
}
@media (min-width: 768px) {
  .pr-ways {
    grid-template-columns: 1fr 1fr;
  }
}
.pr-way {
  display: grid;
  align-content: start;
  gap: 0.875rem;
  padding: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 16px;
  background: var(--mk-card);
}
.pr-way-cloud {
  border-color: var(--mk-accent-line);
  background: linear-gradient(180deg, var(--mk-accent-soft), var(--mk-card) 8rem);
}
.pr-way-top {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}
.pr-way h3 {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.pr-way dl {
  display: grid;
  grid-template-columns: 8.5rem 1fr;
  font-size: 0.875rem;
}
.pr-way dt,
.pr-way dd {
  padding: 0.55rem 0;
  border-top: 1px solid var(--ui-border);
}
.pr-way dt {
  color: var(--ui-text-muted);
}
.pr-way dd {
  color: var(--ui-text-toned);
}
@media (prefers-reduced-motion: reduce) {
  .pr-track i {
    transition: none;
  }
}
</style>
