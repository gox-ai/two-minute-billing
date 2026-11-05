<script setup lang="ts">
/**
 * The homepage's closing call to action: a light card, copy on the left, the subscription list
 * running off its right and bottom edges, from the edge of its sidebar. The screenshot is
 * aria-hidden decoration; its alt is for search.
 */
const { signUp } = useAppLinks();
const modifiers = useShotModifiers();
const freeBand = await useFreeBand();
</script>

<template>
  <section class="pb-18" data-cta-location="closing_cta">
    <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6">
      <div class="cta">
        <div class="cta-copy">
          <span class="mk-mark size-11!" aria-hidden="true" />
          <h2 class="mk-h2 cta-title">
            Send your first invoice today. <span class="mk-tone">Then bill on schedule.</span>
          </h2>
          <p class="cta-body">
            Free while you bill less than {{ freeBand }} a month. Then a flat monthly price. Or
            <ULink to="/open-source" class="font-medium text-primary hover:text-primary-700"
              >self-host the open-source billing engine</ULink
            >.
          </p>
          <div class="mt-8 flex flex-wrap items-center gap-6">
            <UButton
              :to="signUp"
              size="xl"
              leading-icon="i-lucide-arrow-up-right"
              class="h-13.5 px-6.5 text-[1.0625rem] font-medium"
            >
              Start for free
            </UButton>
            <ULink
              to="/pricing"
              class="inline-flex items-center gap-2.5 text-[1.0625rem] font-medium text-highlighted hover:text-primary"
            >
              <UIcon name="i-lucide-receipt" class="size-5" />
              See pricing
            </ULink>
          </div>
        </div>
        <div class="cta-shot" aria-hidden="true">
          <div class="cta-window">
            <UColorModeImage
              light="/product/subscriptions-light.webp"
              dark="/product/subscriptions-dark.webp"
              alt="The subscriptions list in the Two Minute Billing dashboard"
              :width="1920"
              :height="1080"
              :modifiers="modifiers"
              loading="lazy"
              class="cta-img"
            />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cta {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  overflow: hidden;
  border-radius: 0.75rem;
  border: 1px solid var(--mk-indigo-line);
  background: var(--mk-indigo-wash);
}
.cta-copy {
  position: relative;
  z-index: 1;
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  padding: 4.5rem 2.5rem 4.5rem 4rem;
}
.cta-title {
  margin-top: 1.75rem;
  color: var(--ui-text-highlighted);
}
.cta-body {
  margin-top: 1rem;
  max-width: 32.5rem;
  font-size: 1.0625rem;
  line-height: 1.6;
  color: var(--ui-text-toned);
}
.cta-shot {
  position: relative;
  min-width: 0;
  min-height: 26.25rem;
}
.cta-window {
  position: absolute;
  inset: 4rem 0 0 0.5rem;
  overflow: hidden;
  border-radius: 8px 0 0 0;
  border: 1px solid var(--ui-border);
  border-right: 0;
  border-bottom: 0;
  background: var(--mk-card);
}
/* Start at source x 262: past the dashboard's sidebar and its collapse toggle. */
.cta-window :deep(.cta-img) {
  position: absolute;
  top: 0;
  left: -8.36rem;
  width: 61.25rem;
  max-width: none;
}
@media (max-width: 900px) {
  .cta {
    grid-template-columns: 1fr;
  }
  .cta-copy {
    padding: 2.5rem 1.5rem 0.5rem;
  }
  .cta-shot {
    min-height: 20rem;
  }
  .cta-window {
    inset: 2.5rem 0 0 1.5rem;
  }
  .cta-window :deep(.cta-img) {
    left: -5.46rem;
    width: 40rem;
  }
}
</style>
