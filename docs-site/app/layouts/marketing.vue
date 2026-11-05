<script setup lang="ts">
import { toneClass } from "~/utils/tone";

const route = useRoute();
</script>

<template>
  <div class="mk min-h-screen bg-default">
    <MarketingHeader />
    <!-- A product page's own colour (cyan or lime) for its accents; neutral elsewhere. -->
    <main :class="toneClass(route.path)">
      <slot />
    </main>
    <MarketingFooter />
    <CookieBar />
  </div>
</template>
