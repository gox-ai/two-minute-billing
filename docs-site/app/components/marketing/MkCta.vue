<script setup lang="ts">
/**
 * The closing call to action: a dark card with a product screenshot running off its right
 * edge and foot, cropped to the page area (no sidebar). The sign-up is the default first door;
 * a page may replace it. `accent` names one word of the title to colour.
 */
import MkPageBleed from "./MkPageBleed.vue";

interface CtaLink {
  label: string;
  to: string;
  icon?: string;
}

const props = withDefaults(
  defineProps<{
    title: string;
    description: string;
    primary?: CtaLink;
    secondary?: CtaLink;
    accent?: string;
    /** Screenshot path without the `-light.webp` / `-dark.webp` suffix. */
    shot?: string;
  }>(),
  { shot: "/product/org-metrics" },
);

/** Alt text per capture. The shot is aria-hidden (the copy beside it says the same), so this is for search. */
const SHOT_ALT: Record<string, string> = {
  "org-metrics": "Organization metrics in the Two Minute Billing dashboard",
  gateways: "The payment gateways page in the Two Minute Billing dashboard",
  "hosted-pages": "Hosted page settings in the Two Minute Billing dashboard",
  "invoice-detail": "An invoice in the Two Minute Billing dashboard",
  invoices: "The invoices list in the Two Minute Billing dashboard",
  tax: "Tax settings in the Two Minute Billing dashboard",
  retries: "Payment retries in the Two Minute Billing dashboard",
  "subscription-detail": "A subscription in the Two Minute Billing dashboard",
  subscriptions: "The subscriptions list in the Two Minute Billing dashboard",
};
const shotAlt = computed(
  () =>
    SHOT_ALT[props.shot.split("/").pop() ?? ""] ?? "A screen in the Two Minute Billing dashboard",
);

const { signUp } = useAppLinks();
const first = computed(() => props.primary ?? { label: "Start for free", to: signUp });

const parts = computed(() => {
  const at = props.accent ? props.title.lastIndexOf(props.accent) : -1;
  if (at < 0) return { before: props.title, word: "", after: "" };
  return {
    before: props.title.slice(0, at),
    word: props.accent as string,
    after: props.title.slice(at + (props.accent as string).length),
  };
});
</script>

<template>
  <section class="py-12 lg:py-16" data-cta-location="closing_cta">
    <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6">
      <div class="mk-cta flex min-h-[23.75rem] flex-wrap items-stretch">
        <div
          class="relative z-10 flex min-w-0 flex-[1_1_460px] flex-col justify-center p-7 sm:p-10 lg:p-14"
        >
          <span class="mk-mark size-11!" aria-hidden="true" />
          <h2 class="mk-h2 mt-7 text-highlighted">
            {{ parts.before }}{{ parts.word }}{{ parts.after }}
          </h2>
          <p class="mt-4 max-w-[32.5rem] text-[1.0625rem] leading-relaxed text-toned">
            {{ description }}
          </p>
          <div class="mt-8 flex flex-wrap items-center gap-6">
            <UButton
              :to="first.to"
              size="xl"
              class="h-[3.375rem] px-6.5 text-[1.0625rem]"
              :leading-icon="first.icon ?? 'i-lucide-arrow-up-right'"
            >
              {{ first.label }}
            </UButton>
            <ULink
              v-if="secondary"
              :to="secondary.to"
              class="inline-flex items-center gap-2.5 text-[1.0625rem] font-medium text-highlighted hover:text-primary"
            >
              <UIcon v-if="secondary.icon" :name="secondary.icon" class="size-5" />
              {{ secondary.label }}
            </ULink>
          </div>
        </div>
        <div class="relative min-h-[16.25rem] min-w-0 flex-[1_1_420px]" aria-hidden="true">
          <div class="mk-cta-shot">
            <MkPageBleed :src="shot" :alt="shotAlt" :scale="1.25" />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* The closing call to action: a soft indigo band with an indigo hairline (marketing.css). */
.mk-cta {
  position: relative;
  overflow: hidden;
  border-radius: 0.75rem;
  border: 1px solid var(--mk-indigo-line);
  background: var(--mk-indigo-wash);
}
.mk-cta-shot {
  position: absolute;
  inset: 3rem 0 0 0;
}
.mk-cta-shot :deep(.pb-window) {
  box-shadow: -24px 24px 60px -30px rgb(16 24 40 / 0.22);
}
@media (max-width: 640px) {
  .mk-cta-shot {
    inset: 0 0 0 1.75rem;
  }
}
</style>
