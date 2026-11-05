<script setup lang="ts">
/**
 * Every gateway we connect to: its official logo (linking to its setup guide), the payment
 * methods it gives customers and the wallets on pay now. Rows come from `data/gateways.json`,
 * which `pnpm gen:gateway-guides` writes from the gateway catalogue: a method that is not
 * proven live is never listed. A row per gateway on a wide screen; stacked on a phone.
 */
import data from "../../../data/gateways.json";
import PartnerLogo from "~/components/content/PartnerLogo.vue";
import type { PartnerLogoKey } from "~/utils/partner-logos";

interface Gateway {
  key: PartnerLogoKey;
  name: string;
  guide: string;
  methods: string[];
  payNowWallets: string[];
}
const gateways = data.gateways as Gateway[];
</script>

<template>
  <div class="mk-surface overflow-hidden">
    <div
      class="hidden gap-6 border-b border-default px-6 py-3 lg:grid lg:grid-cols-[13rem_1fr_15rem]"
      aria-hidden="true"
    >
      <span class="mk-label">Gateway</span>
      <span class="mk-label">Payment methods</span>
      <span class="mk-label">Wallets on pay now</span>
    </div>
    <ul class="divide-y divide-default">
      <li
        v-for="g in gateways"
        :key="g.key"
        class="grid gap-3 px-5 py-5 sm:px-6 lg:grid-cols-[13rem_1fr_15rem] lg:items-center lg:gap-6"
      >
        <NuxtLink
          :to="g.guide"
          class="flex w-fit items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          :aria-label="`${g.name} setup guide`"
        >
          <PartnerLogo :name="g.key" :label="g.name" :area="1000" :max-width="150" />
        </NuxtLink>
        <div class="min-w-0">
          <span class="mk-label mb-1.5 block lg:sr-only">Payment methods</span>
          <ul class="flex flex-wrap gap-1.5">
            <li
              v-for="m in g.methods"
              :key="m"
              class="rounded-md bg-elevated px-2 py-0.5 text-xs leading-5 text-toned"
            >
              {{ m }}
            </li>
          </ul>
        </div>
        <div class="min-w-0">
          <span class="mk-label mb-1.5 block lg:sr-only">Wallets on pay now</span>
          <ul v-if="g.payNowWallets.length" class="flex flex-wrap gap-1.5">
            <li
              v-for="w in g.payNowWallets"
              :key="w"
              class="rounded-md bg-elevated px-2 py-0.5 text-xs leading-5 text-toned"
            >
              {{ w }}
            </li>
          </ul>
          <span v-else class="text-sm text-dimmed">None</span>
        </div>
      </li>
    </ul>
  </div>
</template>
