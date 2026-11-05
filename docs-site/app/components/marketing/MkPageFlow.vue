<script setup lang="ts">
/**
 * "How it works": numbered steps joined by a dashed track, in a row on wide screens and a
 * column on a phone.
 */
interface Step {
  title: string;
  body: string;
  icon?: string;
}

const props = defineProps<{
  kicker?: string;
  title: string;
  description?: string;
  steps: Step[];
  tint?: boolean;
}>();

const COLS: Record<number, string> = {
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
};
const cols = computed(() => COLS[props.steps.length] ?? "lg:grid-cols-4");
</script>

<template>
  <section class="py-16 lg:py-24" :class="{ 'mk-tint': tint }">
    <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
      <div class="max-w-3xl">
        <h2 class="mk-h2 text-highlighted">
          {{ title }}
        </h2>
        <p v-if="description" class="mt-4 text-[1.0625rem] leading-relaxed text-pretty text-muted">
          {{ description }}
        </p>
      </div>
      <ol class="fl-list relative mt-12 grid gap-6" :class="cols">
        <li v-for="(s, i) in steps" :key="s.title" class="fl-step relative min-w-0">
          <div class="flex items-center gap-3 lg:block">
            <span class="fl-num relative z-10 grid size-11 place-items-center rounded-full">
              <UIcon v-if="s.icon" :name="s.icon" class="size-5" />
              <span v-else class="text-sm font-semibold text-highlighted tabular-nums">{{
                i + 1
              }}</span>
            </span>
            <span class="text-xs font-medium text-muted lg:mt-4 lg:block">Step {{ i + 1 }}</span>
          </div>
          <h3 class="mt-3 font-medium text-highlighted">{{ s.title }}</h3>
          <p class="mt-1.5 text-sm leading-relaxed text-muted">{{ s.body }}</p>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
/* Steps are a process, not a category: neutral. */
.fl-num {
  color: var(--mk-plain);
  background: var(--mk-plain-soft);
  box-shadow: inset 0 0 0 1px var(--mk-plain-line);
}
/* The track: a dashed line behind the numbers, down the left on a phone, across on desktop. */
.fl-step::before {
  content: "";
  position: absolute;
  left: 21px;
  top: 44px;
  bottom: -24px;
  border-left: 2px dashed var(--mk-spoke);
}
.fl-step:last-child::before {
  display: none;
}
.fl-step {
  padding-left: 0;
}
@media (min-width: 1024px) {
  .fl-step::before {
    left: 44px;
    right: -24px;
    top: 21px;
    bottom: auto;
    border-left: 0;
    height: 2px;
    border: 0;
    background-image: linear-gradient(90deg, var(--mk-spoke) 50%, transparent 50%);
    background-size: 12px 2px;
  }
}
</style>
