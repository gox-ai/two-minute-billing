<script setup lang="ts">
/**
 * One zig-zag feature row: copy on one side, a product visual on the other, inside a tinted
 * rounded panel. `flip` puts the visual on the left. With `bleed`, the slot is a box from an
 * inset top-left corner to the panel's foot, for `MkPageBleed`: in a normal row it runs off the
 * panel's right edge, in a flipped row it ends beside the copy. Never off the left or the top.
 */
import PartnerLogo from "~/components/content/PartnerLogo.vue";
import type { PartnerLogoKey } from "~/utils/partner-logos";

interface Point {
  title: string;
  body: string;
  icon?: string;
  /** A gateway's official logo, in place of the icon and the title (its alt text). */
  gateway?: PartnerLogoKey;
}
interface Link {
  label: string;
  to: string;
}

const props = withDefaults(
  defineProps<{
    kicker?: string;
    title: string;
    /** One word of the title to colour. */
    accent?: string;
    description?: string;
    points?: Point[];
    links?: Link[];
    flip?: boolean;
    bleed?: boolean;
    /** `tint` is the lavender panel, `plain` a white card on a tinted page section. */
    tone?: "tint" | "plain";
    id?: string;
  }>(),
  { tone: "tint" },
);

/** The label names the topic; one the heading already says is dropped. */
const label = computed(() =>
  props.kicker && !props.title.toLowerCase().includes(props.kicker.toLowerCase())
    ? props.kicker
    : "",
);

const parts = computed(() => {
  const at = props.accent ? props.title.lastIndexOf(props.accent) : -1;
  if (at < 0) return { before: props.title, word: "", after: "" };
  return {
    before: props.title.slice(0, at),
    word: props.accent as string,
    after: props.title.slice(at + (props.accent as string).length),
  };
});
</script>

<template>
  <section :id="id" class="zg-sec py-5 lg:py-6">
    <div class="mx-auto max-w-(--ui-container) px-4 sm:px-6 lg:px-8">
      <div
        class="zg-panel grid overflow-hidden lg:grid-cols-2"
        :class="[tone === 'tint' ? 'zg-tint' : 'zg-plain', { 'zg-flip': flip }]"
      >
        <div class="zg-copy flex min-w-0 flex-col justify-center p-6 sm:p-10 lg:p-14">
          <p v-if="label" class="mk-kicker mb-4 w-fit">{{ label }}</p>
          <h2 class="mk-h2 text-highlighted">
            {{ parts.before }}{{ parts.word }}{{ parts.after }}
          </h2>
          <p
            v-if="description"
            class="mt-4 text-[1.0625rem] leading-relaxed text-pretty text-muted"
          >
            {{ description }}
          </p>
          <ul v-if="points?.length" class="mt-7 grid gap-x-6 gap-y-5 sm:grid-cols-2">
            <li v-for="p in points" :key="p.title" class="min-w-0">
              <span class="flex items-center gap-2 font-medium text-highlighted">
                <PartnerLogo v-if="p.gateway" :name="p.gateway" :area="700" :max-width="120" />
                <template v-else>
                  <UIcon v-if="p.icon" :name="p.icon" class="mk-ico size-4.5 shrink-0" />
                  {{ p.title }}
                </template>
              </span>
              <span class="mt-1 block text-sm leading-relaxed text-muted">{{ p.body }}</span>
            </li>
          </ul>
          <div v-if="links?.length" class="mt-8 flex flex-wrap gap-3">
            <UButton
              v-for="l in links"
              :key="l.to"
              :to="l.to"
              color="neutral"
              variant="outline"
              class="bg-default"
              trailing-icon="i-lucide-arrow-up-right"
            >
              {{ l.label }}
            </UButton>
          </div>
        </div>
        <div
          class="zg-visual relative min-w-0"
          :class="
            bleed ? 'zg-bleed' : 'flex items-center justify-center p-6 pt-0 sm:p-10 sm:pt-0 lg:p-12'
          "
        >
          <div :class="bleed ? 'zg-bleed-in' : 'w-full max-w-[32rem]'">
            <slot />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Rows in a run alternate: boxed, then open (a full-width band between hairlines), so a page
   never stacks the same tinted box three times. */
.zg-sec + .zg-sec .zg-panel {
  border-radius: 0;
  border-inline: 0;
  background: transparent;
}
.zg-sec + .zg-sec + .zg-sec .zg-panel {
  border-radius: 0.75rem;
  border-inline: 1px solid var(--ui-border-muted);
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--mk-mark-soft) 45%, var(--mk-tint)) 0%,
    var(--mk-tint) 100%
  );
}
.zg-sec + .zg-sec + .zg-sec + .zg-sec .zg-panel {
  border-radius: 0;
  border-inline: 0;
  background: transparent;
}
.zg-panel {
  border-radius: 0.75rem;
  border: 1px solid var(--ui-border-muted);
}
.zg-tint {
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--mk-mark-soft) 45%, var(--mk-tint)) 0%,
    var(--mk-tint) 100%
  );
}
.zg-plain {
  background: var(--mk-card);
}
/* The bleed box: from an inset corner to the panel's foot. On a phone it sits under the copy. */
.zg-bleed {
  overflow: hidden;
  padding-left: 1.5rem;
}
.zg-bleed-in {
  height: clamp(15rem, 62vw, 24rem);
}
@media (min-width: 1024px) {
  .zg-flip .zg-visual {
    order: -1;
  }
  .zg-visual:not(.zg-bleed) {
    padding-top: 3rem;
  }
  .zg-bleed {
    min-height: 26rem;
    padding: 0;
  }
  .zg-bleed-in {
    position: absolute;
    inset: 3.5rem 0 0 0;
    height: auto;
  }
  .zg-flip .zg-bleed-in {
    left: 3.5rem;
  }
  /* A flipped row's window ends beside the copy, so its right edge is framed too. */
  .zg-flip .zg-bleed-in :deep(.pb-window) {
    border-top-right-radius: 1.125rem;
  }
  .zg-flip .zg-bleed-in :deep(.pb-window::after) {
    border-right: 1px solid var(--mk-ring);
  }
}
</style>
