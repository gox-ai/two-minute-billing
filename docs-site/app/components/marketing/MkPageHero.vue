<script setup lang="ts">
/**
 * The light hero every content page opens with. With a default slot it splits into copy and an
 * illustration; without one it centres the copy. The primary action is sign-up unless a page
 * names its own.
 */
interface HeroLink {
  label: string;
  to: string;
  icon?: string;
}

const props = defineProps<{
  eyebrow?: string;
  title: string;
  description: string;
  primary?: HeroLink;
  secondary?: HeroLink;
  note?: string;
}>();

const slots = useSlots();
const { signUp } = useAppLinks();
const primary = computed(() => props.primary ?? { label: "Start for free", to: signUp });
</script>

<template>
  <section class="mk-hero border-b border-muted">
    <UContainer
      class="grid items-center gap-10 py-14 lg:gap-14 lg:py-20"
      :class="slots.default ? 'lg:grid-cols-[1.05fr_1fr]' : ''"
    >
      <div :class="slots.default ? '' : 'mx-auto max-w-3xl text-center'">
        <p v-if="eyebrow" class="mk-kicker mb-5">{{ eyebrow }}</p>
        <h1 class="mk-h1 text-highlighted">
          {{ title }}
        </h1>
        <p
          class="mt-5 text-lg leading-relaxed text-pretty text-muted"
          :class="slots.default ? 'max-w-xl' : 'mx-auto max-w-2xl'"
        >
          {{ description }}
        </p>
        <div
          class="mt-8 flex flex-wrap items-center gap-3"
          :class="slots.default ? '' : 'justify-center'"
        >
          <UButton
            :to="primary.to"
            size="xl"
            :trailing-icon="primary.icon ?? 'i-lucide-arrow-up-right'"
          >
            {{ primary.label }}
          </UButton>
          <UButton
            v-if="secondary"
            :to="secondary.to"
            size="xl"
            color="neutral"
            variant="outline"
            :trailing-icon="secondary.icon"
          >
            {{ secondary.label }}
          </UButton>
        </div>
        <p v-if="note" class="mt-3 text-sm text-muted">{{ note }}</p>
      </div>
      <div v-if="slots.default" class="min-w-0">
        <slot />
      </div>
    </UContainer>
  </section>
</template>
