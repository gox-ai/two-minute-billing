<script setup lang="ts">
/**
 * Security. Only what the code enforces: no certifications, backups, residency, uptime or
 * hosting-encryption claims, and no legal links.
 */
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkPageFlow from "~/components/marketing/MkPageFlow.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const { signUp } = useAppLinks();

const roles = ["Owner", "Admin", "Manager", "Ops", "Developer"];

const access = [
  {
    icon: "i-lucide-users",
    title: "Five roles",
    body: "Give each person what their job needs. The same person can hold a different role in each organization.",
  },
  {
    icon: "i-lucide-fingerprint",
    title: "Passkeys",
    body: "Sign in with a passkey, with no email or password. A passkey counts as a second factor.",
  },
  {
    icon: "i-lucide-smartphone",
    title: "Two-factor sign-in",
    body: "An authenticator app or a passkey, with recovery codes for the day a phone is lost.",
  },
  {
    icon: "i-lucide-shield-alert",
    title: "Required for everyone",
    body: "Admins can require two-factor sign-in for the whole organization.",
  },
  {
    icon: "i-lucide-monitor-smartphone",
    title: "Sessions you can see",
    body: "List the browsers signed in to your account and sign out any of them. A password reset signs out all of them.",
  },
  {
    icon: "i-lucide-log-in",
    title: "Google sign-in",
    body: "Matched on the Google account itself, not on an email address someone could later take over.",
  },
];

const keys = [
  {
    icon: "i-lucide-eye",
    title: "Read-only API keys",
    body: "A key with read scope can see everything and change nothing. Give it to reporting jobs.",
  },
  {
    icon: "i-lucide-flask-conical",
    title: "Test, live or both",
    body: "A key is issued for one mode. A test key cannot reach live data, by id or by mistake.",
  },
  {
    icon: "i-lucide-hash",
    title: "Stored as hashes",
    body: "API keys and portal and checkout tokens are stored hashed. The plain value is shown once.",
  },
  {
    icon: "i-lucide-lock",
    title: "Gateway keys encrypted",
    body: "Your gateway credentials are encrypted at rest and never returned through the API.",
  },
];

const money = [
  {
    icon: "i-lucide-book-lock",
    title: "Append-only ledger",
    body: "Balances come from double-entry records. A correction is a new entry; nothing is edited or deleted.",
  },
  {
    icon: "i-lucide-file-lock",
    title: "Issued invoices are fixed",
    body: "Amounts on a posted invoice never change. A correction is a credit note with its own reason.",
  },
  {
    icon: "i-lucide-hourglass",
    title: "A timeout is not a decline",
    body: "When a gateway answer is lost, the payment stays pending until the gateway confirms what happened.",
  },
];

const audit = [
  {
    icon: "i-lucide-user-check",
    title: "The person or the key",
    body: "Dashboard changes name the signed-in person. API changes name the key that made them.",
  },
  {
    icon: "i-lucide-diff",
    title: "Before and after",
    body: "Each entry keeps the changed values, so you can see what a setting was before.",
  },
  {
    icon: "i-lucide-scroll-text",
    title: "Gateway logs too",
    body: "Every call to your gateway and its response, so a missed charge has an answer.",
  },
  {
    icon: "i-lucide-webhook",
    title: "Signed webhooks",
    body: "HMAC-SHA256 over the raw body. Rotate the signing secret at any time.",
  },
];

const apiKeys = [
  { name: "Reporting job", scope: "Read", mode: "Live" },
  { name: "Backend", scope: "Write", mode: "Live" },
  { name: "CI tests", scope: "Write", mode: "Test" },
];

const cards = [
  {
    icon: "i-lucide-monitor",
    title: "Typed in the browser",
    body: "The customer enters the card on a field your gateway hosts.",
  },
  {
    icon: "i-lucide-vault",
    title: "Stored by your gateway",
    body: "Your gateway keeps the card and returns a reference.",
  },
  {
    icon: "i-lucide-link",
    title: "We keep the reference",
    body: "With the last four digits and the expiry. Never the number.",
  },
  {
    icon: "i-lucide-credit-card",
    title: "Charged by reference",
    body: "Each renewal tells your gateway which saved card to charge.",
  },
];

const pci = [
  {
    icon: "i-lucide-database",
    title: "No card numbers stored",
    body: "Our database holds the gateway's reference, the last four digits and the expiry date.",
  },
  {
    icon: "i-lucide-shield-check",
    title: "3-D Secure on the page",
    body: "When the bank asks for authentication, the customer completes it on the checkout or portal page.",
  },
  {
    icon: "i-lucide-key-round",
    title: "Single-use portal links",
    body: "A portal link works once and expires an hour after it is made.",
  },
  {
    icon: "i-lucide-lock",
    title: "Gateway keys encrypted",
    body: "Your gateway credentials are encrypted at rest and never returned through the API.",
  },
];

const why = [
  {
    label: "Card numbers never reach our servers",
    body: "Card details go from the browser to your gateway, so card-data scope stays at PCI DSS SAQ-A.",
  },
  {
    label: "Five roles for your team",
    body: "Owner, Admin, Manager, Ops and Developer. Each person gets what their job needs.",
  },
  {
    label: "An append-only ledger",
    body: "Money is recorded in an append-only, double-entry ledger. A correction is a new entry.",
  },
];

const faq = [
  {
    label: "Do you store card numbers?",
    content:
      "No. Card details go from your customer's browser to your payment gateway, which stores them. We keep a reference to the saved card and its last four digits, never the number.",
  },
  {
    label: "Can my team's test work email a real customer?",
    content:
      "No. Test businesses send email only to members of your team, and test keys cannot reach live data.",
  },
  {
    label: "Can I see who changed a price or cancelled a subscription?",
    content:
      "Yes. The audit log records who made each change, from the dashboard or through the API, with the values before and after.",
  },
  {
    label: "Can I require two-factor sign-in for my team?",
    content:
      "Yes. Admins can require it for the whole organization. Each person uses an authenticator app or a passkey, with recovery codes.",
  },
  {
    label: "How do I report a vulnerability?",
    content: "Report it to us privately through the contact page, not in a public issue.",
  },
];

useMarketingSeo({
  title: "Billing security and PCI SAQ-A scope",
  crumb: "Security",
  description:
    "Card numbers never reach our servers, money lives in an append-only ledger, and an audit log names who changed what. Roles, passkeys and two-factor.",
  og: {
    headline: "Billing security",
    title: "Billing security: PCI DSS SAQ-A scope, a ledger and an audit log",
    description: "PCI DSS SAQ-A scope. Append-only ledger. Audit log.",
  },
  faq,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Billing security"
      title="Billing security: PCI DSS SAQ-A scope, a ledger and an audit log"
      description="Card numbers never reach our servers, so your PCI DSS scope stays at SAQ-A. Money is recorded in an append-only ledger, every change has a name next to it in the audit log, and test data can never touch live."
      :secondary="{ label: 'Your team and the audit log', to: '/help/guides/your-team' }"
    >
      <MkIllustration
        name="IllSecurityHero"
        :width="600"
        :height="460"
        alt="An audit log entry records a subscription cancelled from the dashboard by a named team member; card numbers never reach our servers, which keeps PCI DSS scope at SAQ-A; test and live are kept apart."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="No card numbers on our servers, and money in an append-only ledger"
      description="Finance, auditors and your security review ask the same three questions: where are the cards, can the numbers change, and who did what. Here are the answers."
      :items="why"
    />

    <MkPageZig
      kicker="PCI DSS SAQ-A"
      title="Card data stays with your gateway, so your PCI scope stays at SAQ-A"
      accent="SAQ-A"
      description="Card numbers go from your customer's browser straight to your payment gateway. They never reach our servers or yours, so card-data scope stays at PCI DSS SAQ-A."
      :points="pci"
    >
      <div class="mk-surface p-5" role="img" aria-labelledby="sec-flow">
        <span id="sec-flow" class="sr-only"
          >The card goes from the customer's browser to your gateway, which stores it. Two Minute
          Billing keeps only a reference.</span
        >
        <ol class="grid gap-3" aria-hidden="true">
          <li class="flex items-center gap-3 rounded-[14px] border border-default p-4">
            <UIcon name="i-lucide-monitor" class="size-6 text-(--mk-plain)" />
            <span
              ><span class="block font-medium text-highlighted">Customer's browser</span
              ><span class="text-xs text-muted">Types the card</span></span
            >
          </li>
          <li
            class="mk-billing flex items-center gap-3 rounded-[14px] border border-(--mk-mark-line) bg-(--mk-mark-soft) p-4"
          >
            <UIcon name="i-lucide-vault" class="mk-ico size-6" />
            <span
              ><span class="block font-medium text-highlighted">Your gateway</span
              ><span class="text-xs text-muted">Stores the card</span></span
            >
          </li>
          <li class="flex items-center gap-3 rounded-[14px] border border-default p-4">
            <span class="mk-mark" />
            <span
              ><span class="block font-medium text-highlighted">Two Minute Billing</span
              ><span class="text-xs text-muted">Keeps a reference</span></span
            >
          </li>
        </ol>
      </div>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Append-only ledger"
      title="An append-only ledger and invoices that stay fixed"
      accent="append-only ledger"
      description="Finance can trust a number when nothing behind it can be edited after the fact."
      :points="money"
    >
      <MkIllustration
        name="IllLedger"
        :width="600"
        :height="420"
        alt="An append-only ledger: two invoices, a payment and a ₹500.00 credit note leave ₹3,038.82 owed."
      />
    </MkPageZig>

    <MkPageZig
      kicker="Access control"
      title="Five roles, passkeys and two-factor sign-in for your team"
      accent="two-factor sign-in"
      description="Each person gets their own login, with a role and a second factor."
      :points="access"
      :links="[{ label: 'Your team and the audit log', to: '/help/guides/your-team' }]"
    >
      <div class="mk-surface p-5" role="img" aria-labelledby="sec-roles">
        <span id="sec-roles" class="sr-only"
          >Five roles: Owner, Admin, Manager, Ops and Developer. Two-factor sign-in is required for
          the organization.</span
        >
        <div aria-hidden="true">
          <div class="text-sm font-semibold text-highlighted">Roles</div>
          <div class="mt-3 flex flex-wrap gap-2">
            <UBadge v-for="r in roles" :key="r" color="neutral" variant="outline" size="lg">{{
              r
            }}</UBadge>
          </div>
          <div
            class="mt-5 flex items-center justify-between gap-3 rounded-lg bg-elevated px-3 py-2.5 text-sm"
          >
            <span class="flex items-center gap-2 text-highlighted">
              <UIcon name="i-lucide-shield-alert" class="size-4 text-(--mk-plain)" />
              Require two-factor sign-in
            </span>
            <span class="sec-on rounded-full px-2 py-0.5 text-xs font-semibold">On</span>
          </div>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Audit log"
      title="An audit log of who changed what, with the values before and after"
      accent="audit log"
      description="The audit log is append-only. It covers changes made in the dashboard and through the API, across the organization and in each business."
      :points="audit"
    >
      <div class="mk-surface overflow-hidden" role="img" aria-labelledby="sec-keys">
        <span id="sec-keys" class="sr-only"
          >Three API keys: a read-only live key for a reporting job, a live write key for the
          backend, and a test key for CI.</span
        >
        <div aria-hidden="true">
          <div class="border-b border-default px-5 py-3.5 text-sm font-semibold text-highlighted">
            API keys
          </div>
          <ul class="divide-y divide-default">
            <li
              v-for="k in apiKeys"
              :key="k.name"
              class="flex items-center gap-3 px-5 py-3 text-sm"
            >
              <UIcon name="i-lucide-key-round" class="size-4 shrink-0 text-muted" />
              <span class="min-w-0 flex-1 truncate text-highlighted">{{ k.name }}</span>
              <UBadge color="neutral" variant="outline">{{ k.scope }}</UBadge>
              <UBadge :color="k.mode === 'Test' ? 'warning' : 'success'" variant="subtle">{{
                k.mode
              }}</UBadge>
            </li>
          </ul>
        </div>
      </div>
    </MkPageZig>

    <MkPageZig
      kicker="Keys and tokens"
      title="Read-only API keys, keys for each mode, and tokens stored as hashes"
      accent="API keys"
      description="Each key works in one mode, with one scope, and can be withdrawn. Test businesses email only your own team, so a rehearsal never reaches a real customer."
      :points="keys"
      :links="[{ label: 'Self-hosted', to: '/open-source' }]"
    >
      <div class="mk-surface p-6">
        <span class="mk-tile size-11!" aria-hidden="true"
          ><UIcon name="i-lucide-server" class="size-5"
        /></span>
        <h3 class="mt-4 text-lg font-medium text-highlighted">
          Or keep it all on your own servers
        </h3>
        <p class="mt-2 text-sm leading-relaxed text-muted">
          The engine is open source. Run it in your own infrastructure with every feature, and your
          billing data never leaves it.
        </p>
      </div>
    </MkPageZig>

    <MkPageFlow kicker="How it works" title="What happens to a card, step by step" :steps="cards" />

    <MkFaq :items="faq" title="Billing security questions" />

    <MkCta
      title="Have a security review to run?"
      accent="security review"
      description="Tell us what your team needs to see, and we will walk them through how it works."
      :primary="{ label: 'Talk to us', to: '/contact' }"
      :secondary="{ label: 'Start for free', to: signUp }"
    />
  </div>
</template>

<style scoped>
.sec-on {
  background: color-mix(in oklab, var(--mk-ok) 14%, transparent);
  color: var(--mk-ok);
}
</style>
