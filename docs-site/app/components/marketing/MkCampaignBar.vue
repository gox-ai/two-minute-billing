<script setup lang="ts">
/**
 * The campaign bar above the header on every marketing page (Black Friday first). Everything
 * it says comes from the catalogue; it renders nothing when no campaign runs. The whole bar is
 * the link to the plans. It stays pinned above the header (marketing.css).
 */
const offer = useCampaignOffer();
const route = useRoute();
const to = computed(() => (route.path === "/pricing" ? "#plans" : "/pricing#plans"));
</script>

<template>
  <NuxtLink
    v-if="offer"
    :to="to"
    :aria-label="`${offer.name}: ${offer.headline}% off ${offerTerm(offer)} on ${offerPlans(offer)}. See plans.`"
    class="mk-campaign-bar flex items-center justify-center gap-2.5 overflow-hidden whitespace-nowrap px-4 text-center text-sm"
  >
    <span class="mk-campaign-tag">{{ offer.name }}</span>
    <span class="hidden min-[860px]:inline">
      {{ offer.headline }}% off {{ offerTerm(offer) }} on {{ offerPlans(offer) }}. Sign up by
      {{ offerLastDay(offer) }} and keep the offer.
    </span>
    <span class="min-[860px]:hidden">{{ offer.headline }}% off {{ offerPlans(offer) }}</span>
    <span class="mk-campaign-go whitespace-nowrap font-semibold">
      <span class="hidden min-[860px]:inline">See plans</span> →
    </span>
  </NuxtLink>
</template>
