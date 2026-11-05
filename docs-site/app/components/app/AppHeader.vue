<script setup lang="ts">
/**
 * Docus's header, with one change: the tab bar (AppHeaderBottom) shows on every docs page.
 * Docus shows it only in its "sub-navigation" mode, which builds tabs from top-level sections
 * — and all our docs sit under one section, /help, so that mode never gave us tabs.
 */
const route = useRoute();
const appConfig = useAppConfig();
const { forced: forcedColorMode } = useDocusColorMode();
const { isEnabled: isAssistantEnabled } = useAssistant();
const { isEnabled, locales } = useDocusI18n();

const isDocs = computed(() => route.path === "/help" || route.path.startsWith("/help/"));

const links = computed(() =>
  appConfig.github && appConfig.github.url
    ? [
        {
          icon: "i-simple-icons-github",
          to: appConfig.github.url,
          target: "_blank",
          "aria-label": "GitHub",
        },
      ]
    : [],
);
</script>

<template>
  <UHeader :ui="{ center: 'flex-1' }" :class="{ 'flex flex-col': isDocs }">
    <AppHeaderCenter />

    <template #left>
      <AppHeaderLeft />
    </template>

    <template #right>
      <AppHeaderCTA />

      <template v-if="isAssistantEnabled">
        <AssistantChat />
      </template>

      <template v-if="isEnabled && locales.length > 1">
        <ClientOnly>
          <LanguageSelect />
          <template #fallback>
            <div class="h-8 w-8 animate-pulse rounded-md bg-neutral-200 dark:bg-neutral-800" />
          </template>
        </ClientOnly>
        <USeparator orientation="vertical" class="h-8" />
      </template>

      <UContentSearchButton class="lg:hidden" />

      <ClientOnly v-if="!forcedColorMode">
        <UColorModeButton />
        <template #fallback>
          <div class="h-8 w-8 animate-pulse rounded-md bg-neutral-200 dark:bg-neutral-800" />
        </template>
      </ClientOnly>

      <template v-if="links?.length">
        <UButton
          v-for="(link, index) of links"
          :key="index"
          v-bind="{ color: 'neutral', variant: 'ghost', ...link }"
        />
      </template>
    </template>

    <template #toggle="{ open, toggle }">
      <IconMenuToggle :open="open" class="lg:hidden" @click="toggle" />
    </template>

    <template #body>
      <AppHeaderBody />
    </template>

    <template v-if="isDocs" #bottom>
      <AppHeaderBottom />
    </template>
    <!-- Docs pages have no layout of ours; CookieBar teleports to body. -->
    <CookieBar />
  </UHeader>
</template>
