<script setup lang="ts">
/** Asks before Google Analytics may set cookies. Shows only on builds with analytics on. */
const { open, init, choose } = useCookieConsent();
onMounted(init);
</script>

<template>
  <!-- To body: a sticky header with a backdrop filter would pin a fixed child to itself. -->
  <Teleport to="body">
    <div
      v-if="open"
      role="dialog"
      aria-label="Cookies"
      class="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-2xl flex-col gap-4 rounded-xl border border-default bg-default p-5 shadow-lg sm:flex-row sm:items-center"
    >
      <p class="flex-1 text-sm leading-relaxed text-toned">
        We use Google Analytics cookies to count visits and make this site better. These cookies
        stay off until you accept.
      </p>
      <div class="flex shrink-0 gap-2">
        <UButton color="neutral" variant="outline" @click="choose('denied')">Reject</UButton>
        <UButton @click="choose('granted')">Accept</UButton>
      </div>
    </div>
  </Teleport>
</template>
