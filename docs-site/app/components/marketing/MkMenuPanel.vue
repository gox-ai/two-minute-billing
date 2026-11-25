<script setup lang="ts">
/**
 * One open header menu on desktop: grouped one-line links, a footer row, and a side panel
 * with a real dashboard piece. Rendered in UNavigationMenu's content slot (MarketingHeader),
 * whose tokens (`--mm-*`) it uses.
 */
import BlogCover from "~/components/blog/BlogCover.vue";
import MkIllustration from "./MkIllustration.vue";
import { COMPARISONS } from "~/utils/compare";
import type { HeaderMenu } from "~/utils/site";

const props = defineProps<{ menu: HeaderMenu }>();
const emit = defineEmits<{ close: [] }>();

// Our own column of the comparison tables, as the comparison pages state it.
const FACTS = ["Price", "Self-hosting", "Gateway"];
const facts = FACTS.map((label) => ({
  label,
  value: COMPARISONS.flatMap((c) => c.glance).find((r) => r.label === label)?.us,
})).filter((f) => f.value);

const id = (i: number, j: number) => `mm-${props.menu.value}-${i}-${j}`;

// Resources: the newest live post, so the panel stays current without an edit here.
// Not awaited: the panel opens at once and the cover appears when the list arrives.
const posts = props.menu.value === "resources" ? useBlogPosts().data : ref([]);
const latest = computed(() => posts.value?.[0] ?? null);
</script>

<template>
  <div class="mm-card" :class="`mm-${menu.value}`" data-cta-location="menu">
    <div class="mm-main">
      <div class="mm-cols">
        <div v-for="(col, i) in menu.columns" :key="i" class="mm-col">
          <div v-for="(g, j) in col" :key="g.label" class="mm-group">
            <p :id="id(i, j)" class="mk-label mm-lbl">{{ g.label }}</p>
            <ul class="mm-list" :aria-labelledby="id(i, j)">
              <li v-for="l in g.items" :key="l.to">
                <NuxtLink
                  :to="l.to"
                  :target="l.external ? '_blank' : undefined"
                  class="mm-it"
                  @click="emit('close')"
                >
                  <span class="mm-l">
                    {{ l.label }}
                    <template v-if="l.external">
                      <UIcon name="i-lucide-arrow-up-right" class="mm-ext" />
                      <span class="sr-only">(opens in a new tab)</span>
                    </template>
                  </span>
                  <span class="mm-d">{{ l.blurb }}</span>
                  <UIcon name="i-lucide-arrow-right" class="mm-ar" />
                </NuxtLink>
              </li>
            </ul>
          </div>
        </div>
      </div>
      <div v-if="menu.footer" class="mm-foot">
        <NuxtLink :to="menu.footer.to" class="mm-go" @click="emit('close')">
          {{ menu.footer.label }}<UIcon name="i-lucide-arrow-right" class="size-4" />
        </NuxtLink>
      </div>
    </div>

    <div class="mm-aside">
      <p class="mk-label">{{ menu.aside.label }}</p>
      <MkIllustration
        v-if="menu.value === 'product'"
        name="IllCardRecovery"
        :width="600"
        :height="320"
        alt="A renewal retried twice and paid on the second retry: $129.00 recovered."
      />
      <NuxtLink
        v-else-if="menu.value === 'resources' && latest?.cover"
        :to="latest.path"
        class="mm-cover"
        tabindex="-1"
        aria-hidden="true"
        @click="emit('close')"
      >
        <BlogCover :cover="latest.cover" :category="latest.category" />
      </NuxtLink>
      <div v-else-if="menu.value === 'solutions'" class="mm-facts">
        <p class="mk-label mm-facts-hd">Two Minute Billing</p>
        <dl>
          <div v-for="f in facts" :key="f.label" class="mm-row">
            <dt>{{ f.label }}</dt>
            <dd>{{ f.value }}</dd>
          </div>
        </dl>
      </div>
      <MkIllustration
        v-else-if="menu.value === 'developers'"
        name="IllPageHubIntegrations"
        :width="600"
        :height="460"
        alt="Payments come in through your gateway accounts: Stripe, PayPal, Adyen, Square, Authorize.net, Razorpay and five more. The billing engine syncs HubSpot, sends events to FirstPromoter, sends an invoice_paid webhook to your endpoint and sends email."
      />
      <div v-if="menu.value === 'resources' && latest">
        <p class="mm-cap-t">{{ latest.title }}</p>
        <p class="mm-cap-d">{{ latest.description }}</p>
      </div>
      <div v-else>
        <p class="mm-cap-t">{{ menu.aside.title }}</p>
        <p v-if="menu.aside.text" class="mm-cap-d">{{ menu.aside.text }}</p>
      </div>
      <NuxtLink
        v-if="menu.value === 'resources' && latest"
        :to="latest.path"
        class="mm-go"
        @click="emit('close')"
      >
        Read the post<UIcon name="i-lucide-arrow-right" class="size-4" />
      </NuxtLink>
      <NuxtLink v-else :to="menu.aside.link.to" class="mm-go" @click="emit('close')">
        {{ menu.aside.link.label }}<UIcon name="i-lucide-arrow-right" class="size-4" />
      </NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.mm-card {
  display: grid;
  width: min(1200px, calc(100vw - 32px));
  grid-template-columns: minmax(0, 1fr) 380px;
  background: var(--mm-card);
  border: 1px solid var(--mm-line);
  border-radius: 16px;
  overflow: hidden;
  color: var(--ui-text-highlighted);
}
.mm-solutions,
.mm-resources {
  width: min(980px, calc(100vw - 32px));
  grid-template-columns: minmax(0, 1fr) 360px;
}
.mm-developers {
  grid-template-columns: minmax(0, 1fr) 440px;
}
/* Narrow desktops: the picture panels give their room to the columns. */
@media (max-width: 1099.98px) {
  .mm-product,
  .mm-developers {
    grid-template-columns: minmax(0, 1fr);
  }
  .mm-product .mm-aside,
  .mm-developers .mm-aside {
    display: none;
  }
  .mm-card .mm-d {
    white-space: normal;
  }
}

.mm-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 28px 28px 0;
}
.mm-solutions .mm-main,
.mm-resources .mm-main {
  padding-bottom: 24px;
}
.mm-cols {
  display: grid;
  flex: 1;
  gap: 24px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.mm-solutions .mm-cols,
.mm-resources .mm-cols {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
/* The newest post's cover: it sizes itself in container units. */
.mm-cover {
  display: block;
  overflow: hidden;
  border: 1px solid var(--mm-line);
  border-radius: 12px;
}
.mm-group + .mm-group {
  margin-top: 20px;
}
.mm-lbl {
  margin: 0 0 6px;
  padding: 0 12px;
}
.mm-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* One item: label, one-line description; hover fills the row and shows the arrow. */
.mm-it {
  position: relative;
  display: block;
  padding: 10px 12px;
  border-radius: 10px;
  transition: background-color 0.15s ease;
}
.mm-l {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 20px;
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
  color: var(--ui-text-highlighted);
}
.mm-d {
  display: block;
  overflow: hidden;
  font-size: 14px;
  line-height: 20px;
  color: var(--ui-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mm-ext {
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.mm-ar {
  position: absolute;
  top: 13px;
  right: 12px;
  width: 16px;
  height: 16px;
  color: var(--mk-accent);
  opacity: 0;
  transform: translateX(-4px);
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.mm-it:hover,
.mm-it:focus-visible {
  background: var(--mm-tile);
}
.mm-it:hover .mm-l,
.mm-it:focus-visible .mm-l {
  color: var(--mk-accent);
}
.mm-it:hover .mm-ar,
.mm-it:focus-visible .mm-ar {
  opacity: 1;
  transform: none;
}
.mm-it:focus-visible,
.mm-go:focus-visible {
  outline: 2px solid var(--mk-accent);
  outline-offset: 0;
}

.mm-foot {
  display: flex;
  align-items: center;
  margin: 20px -28px 0;
  padding: 14px 40px;
  border-top: 1px solid var(--mm-line2);
}
.mm-go {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  color: var(--mk-accent);
}
.mm-go:hover {
  text-decoration: underline;
}

.mm-aside {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  padding: 28px 24px 24px;
  background: var(--mm-aside);
  border-left: 1px solid var(--mm-line2);
}
.mm-aside p {
  margin: 0;
}
.mm-cap-t {
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
}
.mm-cap-d {
  margin-top: 2px !important;
  font-size: 14px;
  line-height: 20px;
  color: var(--ui-text-muted);
}

/* Our facts from the comparison pages. */
.mm-facts {
  overflow: hidden;
  border: 1px solid var(--mm-line);
  border-radius: 12px;
  background: var(--mm-card);
}
.mm-facts-hd {
  padding: 10px 14px;
  border-bottom: 1px solid var(--mm-line2);
}
.mm-facts dl {
  margin: 0;
}
.mm-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--mm-line2);
  font-size: 13px;
  line-height: 18px;
}
.mm-row:last-child {
  border-bottom: 0;
}
.mm-row dt {
  color: var(--ui-text-muted);
}
.mm-row dd {
  margin: 0;
  font-weight: 500;
  white-space: nowrap;
}
</style>
