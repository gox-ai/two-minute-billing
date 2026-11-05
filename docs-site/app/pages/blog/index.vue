<script setup lang="ts">
/**
 * The blog index: the newest post as a featured card, the rest as a dense list, and a topic hub
 * per category that has posts. `?category=` filters and `?page=` pages, so the page is
 * server-rendered per request, not prerendered (nuxt.config routeRules).
 */
import BlogChip from "~/components/blog/BlogChip.vue";
import BlogCover from "~/components/blog/BlogCover.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import { BLOG_DESCRIPTION, BLOG_TITLE } from "~/utils/blog";

definePageMeta({ layout: "marketing", header: false, footer: false });

const PAGE_SIZE = 20;

const route = useRoute();
const { data: posts } = await useBlogPosts();

const active = computed(() => blogCategoryBySlug(route.query.category));
const page = computed(() => Math.max(1, Number.parseInt(String(route.query.page ?? ""), 10) || 1));
const used = computed(() =>
  BLOG_CATEGORIES.filter((c) => posts.value.some((p) => p.category === c.label)),
);
const shown = computed(() =>
  active.value ? posts.value.filter((p) => p.category === active.value!.label) : posts.value,
);
const featured = computed(() => (page.value === 1 ? shown.value[0] : undefined));
// The featured post leads page 1; the list pages through the rest.
const from = computed(() => 1 + (page.value - 1) * PAGE_SIZE);
const latest = computed(() => shown.value.slice(from.value, from.value + PAGE_SIZE));
const older = computed(() => shown.value.length > from.value + PAGE_SIZE);

const link = (category?: string, p = 1) => ({
  path: "/blog",
  query: { ...(category ? { category } : {}), ...(p > 1 ? { page: String(p) } : {}) },
});

/** One hub per category with posts: its newest guide leads, three more posts follow. */
const hubs = computed(() =>
  used.value.map((c) => {
    const inCat = posts.value.filter((p) => p.category === c.label);
    const lead = inCat.find((p) => p.type === "Guide") ?? inCat[0]!;
    return { ...c, lead, more: inCat.filter((p) => p !== lead).slice(0, 3) };
  }),
);

const readLabel = (type: string) => (type === "Guide" ? "Read the guide" : "Read the post");

useMarketingSeo({
  title: "Blog",
  crumb: "Blog",
  description:
    "Guides, product news and engineering notes on subscription billing: invoicing, payments, tax, pricing and revenue metrics, by the Two Minute Billing team.",
  og: {
    headline: "Blog",
    title: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
  },
  blog: true,
});
useBlogFeedLink();
</script>

<template>
  <div>
    <section class="mk-hero border-b border-default">
      <UContainer class="pt-14 pb-10 lg:pt-16">
        <h1 class="mk-h1 max-w-[52rem] text-highlighted">{{ BLOG_TITLE }}</h1>
        <p class="mt-5 max-w-[42.5rem] text-lg leading-relaxed text-pretty text-muted">
          {{ BLOG_DESCRIPTION }}
        </p>
        <nav aria-label="Topics" class="mt-7 flex flex-wrap items-center gap-2">
          <template v-if="used.length">
            <NuxtLink
              :to="link()"
              class="blog-pill"
              :class="{ on: !active }"
              :aria-current="!active ? 'page' : undefined"
            >
              All
            </NuxtLink>
            <NuxtLink
              v-for="c in used"
              :key="c.slug"
              :to="link(c.slug)"
              class="blog-pill"
              :class="{ on: active?.slug === c.slug }"
              :aria-current="active?.slug === c.slug ? 'page' : undefined"
            >
              {{ c.label }}
            </NuxtLink>
          </template>
          <a
            href="/blog/rss.xml"
            class="ml-auto inline-flex min-h-9 items-center gap-1.5 text-sm text-muted hover:text-primary"
          >
            <UIcon name="i-lucide-rss" class="size-3.5" />
            RSS feed
          </a>
        </nav>
      </UContainer>
    </section>

    <UContainer v-if="!shown.length" class="py-16 lg:py-20">
      <p class="text-lg text-muted">
        <template v-if="active">
          No posts in {{ active.label }} yet.
          <NuxtLink :to="link()" class="font-medium text-primary hover:underline">
            View all posts
          </NuxtLink>
        </template>
        <template v-else>No posts are published yet.</template>
      </p>
    </UContainer>

    <template v-else>
      <section v-if="featured">
        <UContainer class="pt-12 pb-4">
          <NuxtLink
            :to="featured.path"
            class="mk-card group flex-row! flex-wrap items-center gap-8 p-6"
          >
            <div class="min-w-0 flex-[1_1_380px] p-2">
              <div class="flex flex-wrap items-center gap-2.5 text-sm text-dimmed">
                <BlogChip :category="featured.category" />
                <span>{{ featured.type }}</span>
                <UBadge v-if="featured.draft" color="warning" variant="subtle">Draft</UBadge>
              </div>
              <h2 class="blog-feature-title mt-4 text-highlighted group-hover:text-primary">
                {{ featured.title }}
              </h2>
              <p class="mt-3.5 leading-relaxed text-muted">{{ featured.description }}</p>
              <p class="mt-4 text-sm text-dimmed">
                {{ BLOG_AUTHOR }} ·
                <time :datetime="featured.date">{{ blogDate(featured.date) }}</time> ·
                {{ featured.readingTime }} min read
              </p>
              <p
                class="mt-5 inline-flex items-center gap-1 text-[0.9375rem] font-medium text-primary"
              >
                {{ readLabel(featured.type) }}
                <UIcon name="i-lucide-arrow-right" class="size-4" />
              </p>
            </div>
            <div class="min-w-0 flex-[1_1_420px]">
              <BlogCover :cover="featured.cover" :category="featured.category" />
            </div>
          </NuxtLink>
        </UContainer>
      </section>

      <section v-if="latest.length || page > 1">
        <UContainer class="pt-10 pb-6">
          <h2 class="mb-2 text-[1.375rem] font-medium! text-highlighted">Latest</h2>
          <ul class="border-t border-default">
            <li v-for="p in latest" :key="p.path" class="border-b border-default">
              <NuxtLink
                :to="p.path"
                class="group flex flex-wrap items-baseline gap-x-6 gap-y-1.5 py-4.5"
              >
                <time :datetime="p.date" class="flex-[0_0_8.5rem] text-sm text-dimmed">
                  {{ blogDate(p.date) }}
                </time>
                <span class="min-w-0 flex-[999_1_420px]">
                  <span
                    class="block text-[1.0625rem] font-medium text-highlighted group-hover:text-primary"
                  >
                    {{ p.title }}
                    <UBadge v-if="p.draft" color="warning" variant="subtle" size="sm">
                      Draft
                    </UBadge>
                    <UBadge v-else-if="isScheduledPost(p)" color="info" variant="subtle" size="sm">
                      Scheduled
                    </UBadge>
                  </span>
                  <span class="mt-1 block text-sm text-muted">{{ p.description }}</span>
                </span>
                <BlogChip :category="p.category" class="text-xs!" />
                <span class="flex-[0_0_4rem] text-right text-sm text-dimmed">
                  {{ p.readingTime }} min
                </span>
              </NuxtLink>
            </li>
          </ul>
          <div v-if="older || page > 1" class="mt-6 flex justify-center gap-3">
            <UButton
              v-if="page > 1"
              :to="link(active?.slug, page - 1)"
              color="neutral"
              variant="outline"
              size="lg"
            >
              Newer posts
            </UButton>
            <UButton
              v-if="older"
              :to="link(active?.slug, page + 1)"
              color="neutral"
              variant="outline"
              size="lg"
            >
              Older posts
            </UButton>
          </div>
        </UContainer>
      </section>

      <section v-if="!active && page === 1 && hubs.length" class="mk-tint mt-10">
        <UContainer class="py-14">
          <h2 class="mk-h3 text-highlighted">Start with a topic</h2>
          <p class="mt-2.5 text-muted">
            Each topic opens on one complete guide, with shorter posts around it.
          </p>
          <div class="mt-7 grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-4">
            <div
              v-for="h in hubs"
              :key="h.slug"
              class="rounded-xl border border-default bg-(--mk-card) p-5"
              :class="blogToneClass(h.tone)"
            >
              <NuxtLink
                :to="link(h.slug)"
                class="text-sm font-semibold text-(--mk-mark-text) hover:underline"
              >
                {{ h.label }}
              </NuxtLink>
              <NuxtLink
                :to="h.lead.path"
                class="mt-2.5 block font-medium text-highlighted hover:text-primary"
              >
                {{ h.lead.title }}
              </NuxtLink>
              <ul v-if="h.more.length" class="mt-3 space-y-1.5 text-sm">
                <li v-for="p in h.more" :key="p.path">
                  <NuxtLink :to="p.path" class="text-muted hover:text-primary">
                    {{ p.title }}
                  </NuxtLink>
                </li>
              </ul>
            </div>
          </div>
        </UContainer>
      </section>
    </template>

    <MkCta
      :title="BLOG_CTA.title"
      :description="BLOG_CTA.description"
      :secondary="{ label: 'Talk to us', to: '/contact' }"
    />
  </div>
</template>

<style scoped>
.blog-pill {
  display: inline-flex;
  align-items: center;
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
  border-radius: 999px;
  border: 1px solid var(--ui-border);
  font-size: 0.875rem;
  color: var(--ui-text-toned);
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}
.blog-pill:hover {
  border-color: var(--mk-spoke);
  color: var(--ui-text-highlighted);
}
/* Selected: the one place indigo fills a pill. */
.blog-pill.on {
  border-color: transparent;
  background: var(--mk-accent-soft);
  color: var(--mk-accent);
  font-weight: 600;
}
.blog-feature-title {
  font-size: 1.625rem;
  line-height: 1.15;
  font-weight: 500;
  letter-spacing: -0.02em;
  text-wrap: balance;
  transition: color 0.15s ease;
}
@media (min-width: 640px) {
  .blog-feature-title {
    font-size: 2rem;
  }
}
</style>
