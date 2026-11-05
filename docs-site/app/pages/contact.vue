<script setup lang="ts">
/** Contact: Enterprise, self-hosted support and anything else. Posts to /api/contact. */
import MkFaq from "~/components/marketing/MkFaq.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const route = useRoute();
const siteKey = useRuntimeConfig().public.turnstileSiteKey;
if (siteKey) {
  useHead({
    script: [
      { src: "https://challenges.cloudflare.com/turnstile/v0/api.js", async: true, defer: true },
    ],
  });
}

const freeBand = await useFreeBand("plans-visitor");

const topics = ["Cloud plans", "Enterprise", "Self-hosted support", "Something else"];
const state = reactive({
  name: "",
  email: "",
  company: "",
  topic: topics.includes(String(route.query.topic)) ? String(route.query.topic) : "Enterprise",
  message: "",
});
const status = ref<"idle" | "sending" | "sent">("idle");
const error = ref("");

async function submit(e: Event) {
  error.value = "";
  status.value = "sending";
  const token = new FormData(e.target as HTMLFormElement).get("cf-turnstile-response");
  try {
    await $fetch("/api/contact", {
      method: "POST",
      body: { ...state, turnstile_token: token ?? undefined },
      timeout: 30_000,
    });
    status.value = "sent";
    track("generate_lead", { form: "contact", topic: state.topic });
  } catch (err) {
    error.value =
      (err as { statusMessage?: string; data?: { statusMessage?: string } }).data?.statusMessage ??
      "We could not send your message. Try again.";
    status.value = "idle";
    // A Turnstile token works once: get a fresh one for the retry.
    (window as { turnstile?: { reset: () => void } }).turnstile?.reset();
  }
}

const reasons = [
  {
    icon: "i-lucide-building-2",
    title: "Enterprise volume",
    body: "Billing above the Scale plan, an agreement and invoicing terms.",
    to: "/pricing",
  },
  {
    icon: "i-lucide-server",
    title: "Self-hosted support",
    body: "Help with installation and upgrades of the open-source engine.",
    to: "/open-source",
  },
  {
    icon: "i-lucide-shield-check",
    title: "A security review",
    body: "The card flow, PCI DSS scope, roles and the audit log.",
    to: "/security",
  },
];

const faq = computed(() => [
  {
    label: "Can I try it before I talk to sales?",
    content: `Yes. Sign up with every feature. Free while you bill less than ${freeBand.value} a month. Then a flat monthly price.`,
  },
  {
    label: "What should I put in my message?",
    content: "How much you bill each month, in which currencies, and on which payment gateway.",
  },
  {
    label: "Do you support self-hosted installs?",
    content: "Yes. Select Self-hosted support in the form and tell us about your setup.",
  },
  {
    label: "Where do I report a security problem?",
    content: "Use this form and select Something else. Do not report it in a public issue.",
  },
]);

useMarketingSeo({
  title: "Contact sales and support",
  crumb: "Contact",
  description:
    "Talk to the Two Minute Billing team about Enterprise volume, an agreement, self-hosted support or a security review. A person on our team reads every message.",
  og: STATIC_OG["/contact"]!,
  faq: faq.value,
});
</script>

<template>
  <div>
    <section class="mk-hero border-b border-default">
      <UContainer class="py-12 lg:py-14">
        <p class="mk-kicker mb-4">Contact</p>
        <h1 class="max-w-2xl text-4xl font-semibold text-highlighted sm:text-5xl">
          Talk to the Two Minute Billing team
        </h1>
        <p class="mt-5 max-w-2xl text-lg text-muted">
          Talk to us about Enterprise volume, an agreement, support for a self-hosted install or a
          security review. A person on our team reads every message.
        </p>
      </UContainer>
    </section>

    <UContainer class="grid gap-12 py-10 lg:py-12 lg:grid-cols-[2fr_1fr]">
      <UCard v-if="status === 'sent'">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-check-circle" class="mt-0.5 size-5 text-success" />
          <div>
            <h2 class="font-medium text-highlighted">Message sent</h2>
            <p class="mt-1 text-sm text-muted">We reply to {{ state.email }}.</p>
          </div>
        </div>
      </UCard>

      <form v-else class="grid gap-5" @submit.prevent="submit">
        <div class="grid gap-5 sm:grid-cols-2">
          <UFormField label="Your name" required>
            <UInput
              v-model="state.name"
              autocomplete="name"
              maxlength="200"
              required
              class="w-full"
            />
          </UFormField>
          <UFormField label="Work email" required>
            <UInput
              v-model="state.email"
              type="email"
              autocomplete="email"
              maxlength="254"
              required
              class="w-full"
            />
          </UFormField>
          <UFormField label="Company">
            <UInput
              v-model="state.company"
              autocomplete="organization"
              maxlength="200"
              class="w-full"
            />
          </UFormField>
          <UFormField label="What is it about?" required>
            <USelect v-model="state.topic" :items="topics" class="w-full" />
          </UFormField>
        </div>
        <UFormField
          label="Message"
          required
          help="Tell us how much you bill each month and what you need."
        >
          <UTextarea v-model="state.message" :rows="6" maxlength="5000" required class="w-full" />
        </UFormField>
        <div v-if="siteKey" class="cf-turnstile" :data-sitekey="siteKey" />
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          icon="i-lucide-circle-alert"
        />
        <div>
          <UButton type="submit" size="lg" :loading="status === 'sending'">Send message</UButton>
        </div>
      </form>

      <aside class="space-y-6 text-sm">
        <div class="space-y-3">
          <NuxtLink v-for="r in reasons" :key="r.to" :to="r.to" class="mk-card flex-row! gap-3 p-4">
            <UIcon :name="r.icon" class="mt-0.5 size-5 shrink-0 text-(--mk-plain)" />
            <span>
              <span class="block font-semibold text-highlighted">{{ r.title }}</span>
              <span class="block text-muted">{{ r.body }}</span>
            </span>
          </NuxtLink>
        </div>
        <div>
          <h2 class="font-medium text-highlighted">Want to try it first?</h2>
          <p class="mt-1 text-muted">
            Every feature. Free while you bill less than {{ freeBand }} a month. Then a flat monthly
            price.
          </p>
          <UButton
            :to="useAppLinks().signUp"
            variant="link"
            class="px-0"
            trailing-icon="i-lucide-arrow-right"
          >
            Start for free
          </UButton>
        </div>
        <div>
          <h2 class="font-medium text-highlighted">Looking for answers?</h2>
          <p class="mt-1 text-muted">Guides for running billing, and the full API reference.</p>
          <UButton to="/help" variant="link" class="px-0" trailing-icon="i-lucide-arrow-right"
            >Read the docs</UButton
          >
        </div>
      </aside>
    </UContainer>

    <MkFaq :items="faq" title="Before you write" />
  </div>
</template>
