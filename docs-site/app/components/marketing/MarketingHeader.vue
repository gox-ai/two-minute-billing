<script setup lang="ts">
/**
 * The marketing pages' header. Not Docus's `AppHeader`: docs search, docs navigation and
 * section tabs belong under /help. Sticky. Product, Solutions and Developers open as menus
 * (MkMenuPanel) and dim the page behind them; below 860px everything moves into the
 * slideover behind the menu button.
 */
import type { NavigationMenuItem } from "@nuxt/ui";
import MkLogo from "~/components/marketing/MkLogo.vue";
import MkMenuPanel from "~/components/marketing/MkMenuPanel.vue";

const { signIn, signUp } = useAppLinks();
const repo = useRepoUrl();
const menus = headerMenus(repo);
const LINKS = [
  { label: "Pricing", to: "/pricing" },
  { label: "Docs", to: "/help" },
  { label: "Blog", to: "/blog" },
];

const items = computed<NavigationMenuItem[]>(() => [
  ...menus.map((m) => ({ label: m.label, value: m.value, slot: "menu" as const })),
  ...LINKS,
]);
const menuOf = (value: unknown) => menus.find((m) => m.value === value)!;

// The open desktop menu ("" when none). Navigation closes it; so does a link to this page.
const open = ref("");
const route = useRoute();
watch(
  () => route.fullPath,
  () => (open.value = ""),
);

const sheet = menus.map((m) => ({ label: m.label, value: m.value, menu: m }));

/**
 * The menu button shows below 860px, not Nuxt UI's 1024px (`lg`), and is a 44px touch target
 * there; the icon keeps its size.
 */
const ui = {
  // 64px on phones, 80px from 860px up, as on the other Two Minute sites.
  root: "[--ui-header-height:4rem] min-[860px]:[--ui-header-height:5rem] bg-default/85 backdrop-blur-md border-b border-muted shadow-[0_1px_12px_-6px_rgb(16_24_40/0.12)]",
  center: "min-[860px]:flex flex-1 justify-start min-[860px]:ml-6",
  toggle: "min-[860px]:hidden size-11 justify-center",
  content: "min-[860px]:hidden mk-sheet",
  overlay: "min-[860px]:hidden",
  body: "px-5 pt-1 pb-6",
  left: "flex-none",
  right: "flex-none",
};

// The panel hangs from the header (the root is `static`), centred on the page.
const navUi = {
  root: "static",
  linkTrailingIcon: "size-4",
  viewportWrapper: "pointer-events-none pt-2.25 px-4",
  viewport:
    "pointer-events-auto w-(--reka-navigation-menu-viewport-width) rounded-2xl ring-0 bg-transparent",
  content: "w-max max-h-[calc(100dvh-6rem)]",
};

const sheetUi = {
  item: "border-b border-default last:border-b",
  trigger:
    "min-h-13 py-0 text-[17px] font-medium text-highlighted data-[state=open]:text-(--mk-accent) rounded-none",
  trailingIcon: "size-[18px]",
  body: "pb-3 text-base",
};
</script>

<template>
  <UHeader
    to="/"
    mode="slideover"
    title="Two Minute Billing"
    :menu="{
      title: 'Menu',
      description: 'Product, solutions, developer docs, pricing and the blog',
    }"
    :ui="ui"
  >
    <template #title>
      <MkLogo class="h-9 min-[860px]:h-11" />
    </template>

    <UNavigationMenu v-model="open" :items="items" variant="link" class="mk-nav" :ui="navUi">
      <template #menu-content="{ item }">
        <MkMenuPanel :menu="menuOf(item.value)" @close="open = ''" />
      </template>
    </UNavigationMenu>

    <template #right>
      <UButton
        v-if="repo"
        :to="repo"
        target="_blank"
        icon="i-simple-icons-github"
        color="neutral"
        variant="ghost"
        aria-label="GitHub"
        class="hidden xl:inline-flex"
      />
      <UColorModeButton class="hidden xl:inline-flex" />
      <UButton
        :to="signIn"
        color="neutral"
        variant="soft"
        size="lg"
        class="hidden whitespace-nowrap min-[860px]:inline-flex"
      >
        Sign in
      </UButton>
      <UButton
        :to="signUp"
        size="lg"
        trailing-icon="i-lucide-arrow-up-right"
        class="hidden whitespace-nowrap min-[860px]:inline-flex"
        :ui="{ trailingIcon: 'max-lg:hidden' }"
      >
        Start for free
      </UButton>
    </template>

    <!-- Phones: one section open at a time; each side panel becomes one plain link. -->
    <template #body>
      <UAccordion :items="sheet" :ui="sheetUi">
        <template #body="{ item }">
          <template
            v-for="g in [
              ...item.menu.columns.flat(),
              ...(item.menu.phone ? [item.menu.phone] : []),
            ]"
            :key="g.label"
          >
            <p class="mk-label mt-3.5 mb-0.5">{{ g.label }}</p>
            <NuxtLink
              v-for="l in g.items"
              :key="l.to"
              :to="l.to"
              :target="l.external ? '_blank' : undefined"
              class="mk-sheet-it"
            >
              <span class="flex items-center gap-1 font-medium text-highlighted">
                {{ l.label }}
                <template v-if="l.external">
                  <UIcon name="i-lucide-arrow-up-right" class="size-3.5 text-muted" />
                  <span class="sr-only">(opens in a new tab)</span>
                </template>
              </span>
              <span class="block text-sm text-muted">{{ l.blurb }}</span>
            </NuxtLink>
          </template>
          <NuxtLink
            v-if="item.menu.footer"
            :to="item.menu.footer.to"
            class="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-(--mk-accent)"
          >
            {{ item.menu.footer.label }}<UIcon name="i-lucide-arrow-right" class="size-4" />
          </NuxtLink>
        </template>
      </UAccordion>
      <NuxtLink v-for="l in LINKS" :key="l.to" :to="l.to" class="mk-sheet-sec">
        {{ l.label }}
      </NuxtLink>
      <!-- The slideover is phone and tablet only: 44px touch targets. -->
      <div class="mt-6 flex flex-col gap-2">
        <UButton :to="signUp" block size="lg" class="min-h-12">Start for free</UButton>
        <UButton :to="signIn" color="neutral" variant="outline" block size="lg" class="min-h-12">
          Sign in
        </UButton>
      </div>
      <div class="mt-5 flex items-center justify-between text-sm text-muted">
        <span>Theme</span>
        <UColorModeButton class="mk-sheet-x" />
      </div>
    </template>
  </UHeader>

  <!-- The page behind an open desktop menu: dimmed and softly blurred. -->
  <div class="mk-menu-dim" :class="{ on: open }" aria-hidden="true" />
</template>

<!-- Unscoped: the menu renders inside UHeader, which does not carry this scope id. -->
<style>
/* Top-level menu items: dark and semibold, so the bar reads at a glance. */
.mk-nav [data-slot="link"] {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.mk-nav [data-slot="link"]:hover,
.mk-nav [data-slot="link"][data-state="open"] {
  color: var(--ui-primary);
}

/* Between 860px and 1024px the full menu has to fit beside both buttons. */
@media (min-width: 860px) and (max-width: 1023.98px) {
  .mk-nav [data-slot="link"] {
    padding-inline: 0.25rem;
  }
}

/* The open menu's panel (MkMenuPanel). Neutral greys; indigo is for links only. */
.mk-nav {
  --mm-card: #ffffff;
  --mm-aside: #f6f7f9;
  --mm-tile: #f2f4f7;
  --mm-line: #e4e7ec;
  --mm-line2: #eef0f3;
  --mm-shadow: 0 2px 6px rgb(16 24 40 / 0.06), 0 28px 56px -18px rgb(16 24 40 / 0.32);
}
.dark .mk-nav {
  --mm-card: #111a2b;
  --mm-aside: #0d1525;
  --mm-tile: #1b2539;
  --mm-line: rgb(255 255 255 / 0.1);
  --mm-line2: rgb(255 255 255 / 0.07);
  --mm-shadow: 0 1px 0 rgb(255 255 255 / 0.04) inset, 0 28px 56px -18px rgb(0 0 0 / 0.8);
}
.mk-nav [data-slot="viewport"] {
  box-shadow: var(--mm-shadow);
}

.mk-menu-dim {
  position: fixed;
  inset: 5rem 0 0;
  z-index: 40;
  background: rgb(16 24 40 / 0.32);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 0.15s ease,
    visibility 0.15s;
}
.dark .mk-menu-dim {
  background: rgb(2 6 14 / 0.58);
}
.mk-menu-dim.on {
  opacity: 1;
  visibility: visible;
}
@media (max-width: 859.98px) {
  .mk-menu-dim {
    display: none;
  }
}

/* The phone slideover. */
.mk-sheet-it {
  display: block;
  padding: 9px 0;
}
.mk-sheet-it:hover > span:first-child {
  color: var(--mk-accent);
}
.mk-sheet-sec {
  display: flex;
  align-items: center;
  min-height: 52px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 17px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.mk-sheet-sec:hover {
  color: var(--mk-accent);
}
.mk-sheet [data-slot="toggle"],
.mk-sheet-x {
  width: 2.75rem;
  height: 2.75rem;
  justify-content: center;
  box-shadow: inset 0 0 0 1px var(--ui-border);
}
</style>
