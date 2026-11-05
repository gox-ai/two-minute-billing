<script lang="ts" setup>
/**
 * A blog post's social card (1200×630): the cover design (components/blog/BlogCover.vue) in
 * fixed pixels, light theme. Rows arrive as "label|amount" so every prop is a plain string.
 */
const props = defineProps<{
  category?: string;
  tone?: string;
  coverTitle?: string;
  cardLabel?: string;
  row1?: string;
  row2?: string;
  value?: string;
  pill?: string;
}>();

const GROUND: Record<string, string> = { billing: "#f2fbfc", growth: "#f5faea" };
const INK: Record<string, string> = { billing: "#06606d", growth: "#3f6212" };
const ground = GROUND[props.tone ?? ""] ?? "#f6f8fb";
const ink = INK[props.tone ?? ""] ?? "#344054";
const rows = [props.row1, props.row2]
  .filter((r): r is string => !!r)
  .map((r) => {
    const [label, amount] = r.split("|");
    return { label: label ?? "", amount: amount ?? "" };
  });
// 332px inside the card; a long value shrinks to fit (the renderer's face is wider than Inter).
const valueSize = `${Math.min(72, Math.floor(320 / ((props.value ?? "").length * 0.62 || 1)))}px`;
</script>

<template>
  <div class="w-full h-full flex relative text-[#101828]" :style="{ backgroundColor: ground }">
    <div class="absolute left-[80px] top-[88px] w-[540px] flex flex-col">
      <div class="text-[22px] font-semibold" :style="{ color: ink }">{{ category }}</div>
      <div class="mt-[22px] text-[60px] leading-[1.08] font-semibold tracking-[-0.03em]">
        {{ (coverTitle ?? "").slice(0, 70) }}
      </div>
    </div>

    <div
      class="absolute right-[90px] top-[120px] w-[400px] flex flex-col bg-white border border-[#e4e7ec] rounded-[22px] px-[34px] py-[32px]"
    >
      <div class="text-[18px] text-[#667085]">{{ cardLabel }}</div>
      <div
        v-for="(r, i) in rows"
        :key="i"
        class="flex justify-between text-[19px] text-[#475467]"
        :class="i === 0 ? 'mt-[22px]' : 'mt-[10px]'"
      >
        <span>{{ r.label }}</span>
        <span>{{ r.amount }}</span>
      </div>
      <div class="h-[1px] bg-[#eaecf0] my-[18px]" />
      <div class="font-semibold tracking-[-0.035em] leading-[1.1]" :style="{ fontSize: valueSize }">
        {{ value }}
      </div>
      <div class="flex mt-[14px]">
        <div
          class="flex items-center rounded-full bg-[#bef264] text-[#1a2e05] text-[17px] font-semibold px-[16px] py-[6px]"
        >
          {{ pill }}
        </div>
      </div>
    </div>

    <div class="absolute left-[80px] bottom-[72px] flex items-center">
      <div class="flex flex-col text-[18px] font-extrabold leading-none tracking-[-0.02em]">
        <span>TWO</span>
        <span class="flex">MINUTE<span class="ml-[6px] text-[#4e4eda]">BILLING</span></span>
      </div>
      <div class="w-[1px] h-[30px] bg-[#d0d5dd] mx-[14px]" />
      <div class="text-[18px] font-medium text-[#475467]">Blog</div>
    </div>
  </div>
</template>
