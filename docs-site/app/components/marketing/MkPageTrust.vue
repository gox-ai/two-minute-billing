<script setup lang="ts">
/**
 * The trust strip every content page closes with: the three guarantees finance asks about
 * first, in one ruled row (a strip, not a third card grid). Each is enforced in the engine;
 * /security has the detail.
 */
withDefaults(
  defineProps<{
    title?: string;
    description?: string;
  }>(),
  {
    title: "Money you can trace, cards you never hold",
    description:
      "The same three rules apply to every invoice, refund and credit note, whatever you sell.",
  },
);

const items = [
  {
    icon: "i-lucide-book-lock",
    title: "An append-only ledger",
    body: "Balances come from double-entry records. A correction is a new entry, so every figure traces back to the rows behind it.",
  },
  {
    icon: "i-lucide-shield-check",
    title: "PCI DSS SAQ-A scope",
    body: "Card numbers go from the browser straight to your payment gateway. They never reach our servers or yours.",
  },
  {
    icon: "i-lucide-scroll-text",
    title: "An audit log",
    body: "Who changed what, from the dashboard or the API, with the values before and after.",
  },
];
</script>

<template>
  <section class="mk-tint py-12 lg:py-14">
    <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <h2 class="mk-h3 text-highlighted">{{ title }}</h2>
        <ULink
          to="/security"
          class="inline-flex items-center gap-1.5 text-[0.9375rem] font-medium text-primary"
        >
          How we keep billing safe<UIcon name="i-lucide-arrow-right" class="size-4" />
        </ULink>
      </div>
      <ul class="mk-plain mt-6 grid gap-6 border-t border-default pt-6 md:grid-cols-3">
        <li v-for="i in items" :key="i.title" class="flex gap-3">
          <UIcon :name="i.icon" class="mk-ico mt-0.5 size-5 shrink-0" />
          <div class="min-w-0">
            <h3 class="font-medium text-highlighted">{{ i.title }}</h3>
            <p class="mt-1 text-sm leading-relaxed text-muted">{{ i.body }}</p>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>
