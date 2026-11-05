<script lang="ts" setup>
/**
 * The social card for marketing pages (1200×600): the page's eyebrow, its promise and one
 * supporting line, on the brand ink and orange. Kept to plain boxes and text so the renderer stays fast.
 */
const { title, description, headline } = defineProps<{
  title?: string;
  description?: string;
  headline?: string;
}>();
</script>

<template>
  <div class="w-full h-full flex flex-col justify-between bg-[#0b1220] px-[80px] py-[64px]">
    <div
      class="absolute top-0 right-0 w-[640px] h-[640px] bg-[radial-gradient(circle_at_top_right,rgba(129,129,240,0.35)_0%,rgba(78,78,218,0.12)_45%,transparent_70%)]"
    />

    <div class="flex items-center">
      <div
        class="flex items-center justify-center w-[56px] h-[56px] rounded-[12px] bg-[#4e4eda] text-white text-[24px] font-bold"
      >
        tm
      </div>
      <div class="ml-4 text-white text-[28px] font-semibold">Two Minute Billing</div>
    </div>

    <div class="flex flex-col">
      <p
        v-if="headline"
        class="m-0 mb-5 uppercase text-[22px] font-bold tracking-[0.06em] text-[#a9a9f4]"
      >
        {{ headline }}
      </p>
      <h1
        v-if="title"
        class="m-0 mb-6 text-[60px] font-bold text-white leading-[1.08] max-w-[1000px]"
      >
        {{ title.slice(0, 70) }}
      </h1>
      <p v-if="description" class="m-0 text-[30px] text-[#cbd5e1] leading-[1.35] max-w-[960px]">
        {{ description.slice(0, 120) }}
      </p>
    </div>

    <div class="flex text-[22px] text-[#a9a9f4]">twominutebilling.com</div>
  </div>
</template>
