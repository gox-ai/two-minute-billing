<script setup lang="ts">
/** A post's category as a chip, in the category's meaning colour. */
const props = defineProps<{ category: string }>();
const tone = computed(() => blogToneClass(blogCategory(props.category)?.tone));
</script>

<template>
  <span class="mk-chip" :class="tone">{{ category }}</span>
</template>
