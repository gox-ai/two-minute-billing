<script setup lang="ts">
/**
 * One card per gateway: its official logo, linking to its setup guide. Rows come from
 * `data/gateways.json` (`pnpm gen:gateway-guides`), so the cards follow the guides.
 *
 * In Markdown: `::gateway-cards\n::`.
 */
import data from "../../../data/gateways.json";
import PartnerLogo from "./PartnerLogo.vue";
import type { PartnerLogoKey } from "~/utils/partner-logos";

const gateways = data.gateways as { key: PartnerLogoKey; name: string; guide: string }[];
</script>

<template>
  <UPageGrid class="not-prose my-6 grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
    <UPageCard
      v-for="g in gateways"
      :key="g.key"
      :to="g.guide"
      :aria-label="`${g.name} setup guide`"
      variant="outline"
      spotlight
      :ui="{ container: 'flex min-h-20 items-center justify-center p-4 sm:p-5 lg:flex' }"
    >
      <PartnerLogo :name="g.key" :label="g.name" :area="900" :max-width="120" />
    </UPageCard>
  </UPageGrid>
</template>
