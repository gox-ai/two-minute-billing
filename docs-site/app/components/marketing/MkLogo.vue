<script setup lang="ts">
/**
 * The horizontal logo: TWO and the receipt mark over MINUTE BILLING. Two files, one per theme;
 * `.mk-logo-*` in assets/css/marketing.css shows the one that matches (the other is display:none,
 * so a screen reader reads one alt). Size it with a height class.
 */
</script>

<template>
  <span class="mk-logo">
    <img
      src="/brand/logo-horizontal-on-light.svg"
      alt="Two Minute Billing"
      class="mk-logo-light h-full w-auto"
      width="300"
      height="100"
    />
    <img
      src="/brand/logo-horizontal-on-dark.svg"
      alt="Two Minute Billing"
      class="mk-logo-dark h-full w-auto"
      width="300"
      height="100"
    />
  </span>
</template>
