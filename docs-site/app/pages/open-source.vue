<script setup lang="ts">
/** Open source: the licence, self-hosting and what Cloud adds. */
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkPageFlow from "~/components/marketing/MkPageFlow.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageTrust from "~/components/marketing/MkPageTrust.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const freeBand = await useFreeBand();

const repo = useRepoUrl();
const { signUp } = useAppLinks();

const selfHost = [
  "Every feature, with no limits on customers or volume",
  "Your servers, your database, your network",
  "No fee to us",
  "You run upgrades, backups and monitoring",
];

const cloud = [
  "Every feature, the same engine",
  "We run the hosting, upgrades and monitoring",
  `Free while you bill less than ${freeBand.value} a month. Then a flat monthly price.`,
];

const reasons = [
  {
    icon: "i-lucide-scan-search",
    title: "Read the rules",
    body: "The code that decides what your customers are charged is code you can read and test.",
  },
  {
    icon: "i-lucide-door-open",
    title: "No lock-in",
    body: "Your billing does not depend on us. The code that runs it is yours to run.",
  },
  {
    icon: "i-lucide-server",
    title: "Your data stays put",
    body: "Self-hosted, your billing data never leaves your own infrastructure.",
  },
  {
    icon: "i-lucide-scale",
    title: "A clear licence",
    body: "AGPL-3.0 for the engine, the dashboard and the docs. MIT for the API client.",
  },
];

const why = [
  {
    label: "Free to self-host",
    body: "No licence fee, no share of revenue, no limit on customers, businesses or billing volume.",
  },
  {
    label: "Every feature, either way",
    body: "Cloud and self-hosted run the same engine. Only who keeps it running differs.",
  },
  {
    label: "Node.js and Postgres, nothing else",
    body: "Node.js and Postgres. The billing clock is a job queue inside Postgres, with no separate queue service.",
  },
];

const steps = [
  {
    icon: "i-simple-icons-github",
    title: "Get the code",
    body: "From the public repository, under the AGPL-3.0.",
  },
  {
    icon: "i-lucide-database",
    title: "Give it Postgres",
    body: "Run the engine on Node.js with your own Postgres database.",
  },
  {
    icon: "i-lucide-credit-card",
    title: "Connect your gateways",
    body: "Your own gateway accounts, the same 11 as on Cloud.",
  },
  {
    icon: "i-lucide-refresh-cw",
    title: "Keep it current",
    body: "You run upgrades, backups and monitoring, or ask us for support.",
  },
];

const faq = [
  {
    label: "Is Two Minute Billing open-source billing software?",
    content:
      "Yes. The billing engine, the dashboard and the docs are licensed under the AGPL-3.0, and the TypeScript API client under MIT.",
  },
  {
    label: "Where is the code?",
    content:
      "The public repository opens with the v0.1.0 release. Until then, the hosted Cloud runs the engine, and you can contact us about running it yourself.",
  },
  {
    label: "Is the self-hosted version limited?",
    content: "No. It has every feature, with no limits on customers, businesses or billing volume.",
  },
  {
    label: "What does the AGPL-3.0 ask of me?",
    content:
      "If you run a modified version as a network service, you must offer its source to that service's users. The API client is MIT licensed, so you can embed it in any application.",
  },
  {
    label: "What does it need to run?",
    content:
      "Node.js and Postgres. The billing clock is a job queue inside Postgres, so there is no separate queue service to run.",
  },
  {
    label: "Can I get help running it?",
    content: "Yes. Contact us about support for self-hosted installs.",
  },
];

useMarketingSeo({
  title: "Open-source, self-hosted billing",
  crumb: "Self-hosted",
  description:
    "Open-source subscription billing under the AGPL-3.0. Self-host the engine, dashboard and docs with every feature and no limits, or use our Cloud.",
  og: {
    headline: "Open-source billing",
    title: "Open-source subscription billing on your own servers",
    description: "AGPL-3.0. Every feature. No limits.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Open-source billing software · AGPL-3.0"
      title="Open-source subscription billing, on your own servers"
      description="Self-hosted subscription billing with every feature and no limits. The billing engine, the dashboard and the docs are licensed under the AGPL-3.0. Run it yourself, or let us run it for you on Cloud."
      :primary="
        repo
          ? { label: 'View on GitHub', to: repo, icon: 'i-simple-icons-github' }
          : { label: 'Start for free', to: signUp }
      "
      :secondary="{ label: 'Self-hosted support', to: '/contact?topic=Self-hosted%20support' }"
    >
      <MkIllustration
        name="IllPageHubOpenSource"
        :width="600"
        :height="460"
        alt="The open-source billing engine runs on Node.js with Postgres, which also holds its job queue. It serves the dashboard, the hosted checkout and portal, and the documentation under the AGPL-3.0, and the TypeScript API client under MIT."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Free to self-host, with every feature, on Node.js and Postgres"
      description="Your billing system decides what every customer pays. Open source means you can read that decision, run it yourself, and never be stuck."
      :items="why"
    />

    <section class="py-6 lg:py-10">
      <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
        <div class="max-w-3xl">
          <p class="mk-kicker mb-4 w-fit">Cloud or self-hosted</p>
          <h2 class="mk-h2 text-highlighted">
            Self-hosted billing software, or the same engine on our Cloud
          </h2>
          <p class="mt-4 text-[1.0625rem] leading-relaxed text-muted">
            The features are the same either way. The difference is who keeps it running.
          </p>
        </div>
        <div class="mt-10 grid max-w-4xl gap-4 md:grid-cols-2">
          <div class="mk-surface p-6">
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-medium text-highlighted">Self-hosted</h3>
              <span class="mk-tile mk-tile-ink size-10!" aria-hidden="true"
                ><UIcon name="i-lucide-server" class="size-5"
              /></span>
            </div>
            <p class="mt-1 text-sm text-muted">Free under the AGPL-3.0.</p>
            <ul class="mt-5 space-y-3">
              <li v-for="x in selfHost" :key="x" class="flex gap-2 text-sm text-toned">
                <UIcon name="i-lucide-check" class="mt-0.5 size-4 shrink-0 text-(--mk-plain)" />
                {{ x }}
              </li>
            </ul>
            <UButton
              to="/contact?topic=Self-hosted%20support"
              class="mt-6"
              color="neutral"
              variant="outline"
              trailing-icon="i-lucide-arrow-right"
              >Self-hosted support</UButton
            >
          </div>
          <div class="os-cloud mk-surface p-6">
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-medium text-highlighted">Cloud</h3>
              <span class="mk-tile size-10!" aria-hidden="true"
                ><UIcon name="i-lucide-cloud" class="size-5"
              /></span>
            </div>
            <p class="mt-1 text-sm text-muted">We run it for you.</p>
            <ul class="mt-5 space-y-3">
              <li v-for="x in cloud" :key="x" class="flex gap-2 text-sm text-toned">
                <UIcon name="i-lucide-check" class="mt-0.5 size-4 shrink-0 text-(--mk-plain)" />
                {{ x }}
              </li>
            </ul>
            <UButton to="/pricing" class="mt-6" trailing-icon="i-lucide-arrow-right"
              >See pricing</UButton
            >
          </div>
        </div>
      </div>
    </section>

    <MkPageZig
      kicker="Why open source"
      title="Open-source billing software you can read and run yourself"
      accent="Open-source billing software"
      description="A billing system holds your customers, your prices and your revenue history. You should be able to read it and keep it."
      :points="reasons"
      :links="[
        { label: 'Self-hosted quickstart', to: '/help/developers/getting-started/quickstart' },
      ]"
    >
      <div class="mk-surface overflow-hidden">
        <div class="border-b border-default px-5 py-3.5 text-sm font-semibold text-highlighted">
          Licences
        </div>
        <ul class="divide-y divide-default text-sm">
          <li
            v-for="l in [
              ['Billing engine', 'AGPL-3.0'],
              ['Dashboard, checkout and portal', 'AGPL-3.0'],
              ['Documentation', 'AGPL-3.0'],
              ['TypeScript API client', 'MIT'],
            ]"
            :key="l[0]"
            class="flex items-center justify-between gap-3 px-5 py-3"
          >
            <span class="text-highlighted">{{ l[0] }}</span>
            <UBadge color="neutral" variant="outline">{{ l[1] }}</UBadge>
          </li>
        </ul>
      </div>
    </MkPageZig>

    <MkPageFlow kicker="How it works" title="How self-hosting works" :steps="steps" />

    <MkPageTrust />

    <MkFaq :items="faq" title="Open-source billing questions" />

    <MkCta
      title="Start free on Cloud, and self-host when you want to"
      accent="self-host"
      description="Try every feature free today. Self-host whenever it suits you."
      :secondary="{ label: 'See pricing', to: '/pricing' }"
    />
  </div>
</template>

<style scoped>
.os-cloud {
  box-shadow:
    0 0 0 1px var(--mk-accent-line),
    0 24px 60px -36px rgb(16 24 40 / 0.22);
}
</style>
