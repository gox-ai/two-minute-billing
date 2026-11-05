<script setup lang="ts">
/**
 * A short FAQ block: the heading on the left, ruled questions on the right. Answers are plain
 * sentences; anything longer belongs in the docs. Closed answers stay in the HTML, so the page's
 * FAQ schema describes text that is on it.
 */
defineProps<{
  items: { label: string; content: string }[];
  title?: string;
}>();
</script>

<template>
  <section class="py-16 lg:py-24">
    <div
      class="mx-auto grid max-w-(--ui-container) gap-8 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16 lg:px-8"
    >
      <h2 class="mk-h2 text-highlighted">{{ title ?? "Frequently asked questions" }}</h2>
      <UAccordion
        :items="items"
        :unmount-on-hide="false"
        default-value="0"
        class="mk-faq w-full"
        :ui="{
          root: 'flex flex-col',
          trigger: 'min-h-14 py-4 text-base font-medium text-highlighted',
          body: 'pb-5 text-[0.9375rem] leading-relaxed text-muted',
        }"
      >
        <template #trailing="{ open }">
          <UIcon
            :name="open ? 'i-lucide-minus' : 'i-lucide-plus'"
            class="ms-auto size-5 shrink-0"
            :class="open ? 'text-highlighted' : 'text-muted'"
          />
        </template>
      </UAccordion>
    </div>
  </section>
</template>
