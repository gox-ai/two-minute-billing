<script setup lang="ts">
/**
 * The page header's links, plus the gateway's official logo on a gateway setup guide. The
 * guide is found by its path in `data/gateways.json`, which `pnpm gen:gateway-guides` writes
 * from each guide's `gateway:` frontmatter, so no guide needs its own logo markup.
 */
import DocusHeaderLinks from "docus/app/components/docs/DocsPageHeaderLinks.vue";
import data from "../../../data/gateways.json";
import PartnerLogo from "../content/PartnerLogo.vue";
import { hasPartnerLogo, type PartnerLogoKey } from "~/utils/partner-logos";

const route = useRoute();
const gateway = computed(
  () =>
    (data.gateways as { key: PartnerLogoKey; guide: string }[]).find(
      (g) => g.guide === route.path.replace(/\/$/, ""),
    )?.key,
);
</script>

<template>
  <div class="flex flex-wrap items-center gap-4">
    <!-- The page title already names a gateway that has no logo file yet. -->
    <PartnerLogo
      v-if="gateway && hasPartnerLogo(gateway)"
      :name="gateway"
      :area="1400"
      :max-width="180"
      eager
    />
    <DocusHeaderLinks />
  </div>
</template>
