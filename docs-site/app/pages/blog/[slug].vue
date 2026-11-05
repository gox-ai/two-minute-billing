<script setup lang="ts">
/**
 * One blog post from the `blog` collection (docs-site/content/blog/*.md): header, cover, the article
 * with its contents aside, the "how we handle it" box, sources, related posts and a closing
 * call to action. A draft, or a post before its `publishAt`, answers 404 outside `nuxt dev`.
 */
import BlogChip from "~/components/blog/BlogChip.vue";
import BlogCover from "~/components/blog/BlogCover.vue";
import MkCta from "~/components/marketing/MkCta.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const route = useRoute();

const { data: post } = await useBlogPost(String(route.params.slug));
if (!post.value) {
  throw createError({ statusCode: 404, statusMessage: "Page not found", fatal: true });
}
const p = post.value;
const category = blogCategory(p.category)!;
const cta = blogCta(p.category);

const { data: posts } = await useBlogPosts();
/** "Read next": the post's own picks, then its category, then the newest posts. */
const readNext = computed(() => {
  const others = posts.value.filter((x) => x.path !== p.path);
  const picked = (p.related ?? [])
    .map((s) => others.find((x) => x.path === `/blog/${s}`))
    .filter((x) => !!x);
  const rest = [
    ...others.filter((x) => x.category === p.category),
    ...others.filter((x) => x.category !== p.category),
  ];
  return [...new Set([...picked, ...rest])].slice(0, 3);
});

/** The parsed headings (h2), plus the box after the body. */
const toc = computed(() => [
  ...(p.body?.toc?.links ?? []).map((l) => ({ id: l.id, text: l.text })),
  ...(p.bridge ? [{ id: "how", text: "How Two Minute Billing handles it" }] : []),
]);

// The heading the reader is in: the last one above the top quarter of the window.
const current = ref(toc.value[0]?.id);
function spy() {
  let at = toc.value[0]?.id;
  for (const { id } of toc.value) {
    const el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top < window.innerHeight * 0.25) at = id;
  }
  current.value = at;
}
onMounted(() => {
  spy();
  window.addEventListener("scroll", spy, { passive: true });
});
onBeforeUnmount(() => window.removeEventListener("scroll", spy));

const site = String(useSiteConfig().url ?? "").replace(/\/+$/, "");
const copied = ref(false);
async function copyLink() {
  try {
    await navigator.clipboard.writeText(`${site}${p.path}`);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // No clipboard permission: the address bar still has the link.
  }
}

useMarketingSeo({
  card: p.prebuilt,
  title: p.seoTitle ?? p.title,
  crumb: p.title,
  parents: [{ name: "Blog", path: "/blog" }],
  description: p.description,
  og: { headline: p.category, title: p.cover.coverTitle, description: p.description },
  article: {
    headline: p.title,
    datePublished: p.date,
    dateModified: p.updated,
    section: p.category,
    citation: p.sources?.map((s) => s.url),
    cover: {
      category: p.category,
      tone: p.cover.tone,
      coverTitle: p.cover.coverTitle,
      cardLabel: p.cover.cardLabel,
      row1: p.cover.rows[0] ? `${p.cover.rows[0].label}|${p.cover.rows[0].amount}` : "",
      row2: p.cover.rows[1] ? `${p.cover.rows[1].label}|${p.cover.rows[1].amount}` : "",
      value: p.cover.value,
      pill: p.cover.pill,
    },
  },
});
useBlogFeedLink();
</script>

<template>
  <div>
    <section>
      <UContainer class="pt-10">
        <nav aria-label="Breadcrumb" class="flex gap-2 text-sm text-dimmed">
          <NuxtLink to="/blog" class="hover:text-primary">Blog</NuxtLink>
          <span aria-hidden="true">/</span>
          <NuxtLink
            :to="{ path: '/blog', query: { category: category.slug } }"
            class="hover:text-primary"
          >
            {{ p.category }}
          </NuxtLink>
        </nav>
        <div class="max-w-[51.25rem]">
          <div class="mt-6 flex flex-wrap items-center gap-2.5 text-sm text-dimmed">
            <BlogChip :category="p.category" />
            <span>{{ p.type }}</span>
            <UBadge v-if="p.draft" color="warning" variant="subtle">Draft</UBadge>
            <UBadge v-else-if="isScheduledPost(p)" color="info" variant="subtle">
              Scheduled {{ p.publishAt }}
            </UBadge>
          </div>
          <h1 class="blog-title mt-4 text-highlighted">{{ p.title }}</h1>
          <p class="mt-4.5 text-lg leading-relaxed text-pretty text-muted sm:text-[1.1875rem]">
            {{ p.description }}
          </p>
          <div class="mt-5.5 flex flex-wrap gap-x-4.5 gap-y-1.5 text-sm text-dimmed">
            <span class="font-semibold text-toned">{{ BLOG_AUTHOR }}</span>
            <span
              >Published <time :datetime="p.date">{{ blogDate(p.date) }}</time></span
            >
            <span v-if="p.updated">
              Updated <time :datetime="p.updated">{{ blogDate(p.updated) }}</time>
            </span>
            <span>{{ p.readingTime }} min read</span>
          </div>
        </div>
        <BlogCover :cover="p.cover" :category="p.category" class="mt-8" />
      </UContainer>
    </section>

    <section>
      <UContainer class="flex flex-col gap-10 pt-12 pb-6 lg:flex-row lg:items-start lg:gap-12">
        <article class="min-w-0 max-w-[45rem] lg:flex-[999_1_560px]">
          <ContentRenderer :value="p" class="blog-prose" />

          <section v-if="p.bridge" class="blog-bridge">
            <h2 id="how" class="text-highlighted">{{ p.bridge.title }}</h2>
            <p class="mt-3">{{ p.bridge.body }}</p>
            <div v-if="p.bridge.links?.length" class="mt-4 flex flex-wrap gap-2.5">
              <NuxtLink v-for="l in p.bridge.links" :key="l.to" :to="l.to" class="blog-bridge-link">
                {{ l.label }}
                <UIcon name="i-lucide-arrow-right" class="size-3.5" />
              </NuxtLink>
            </div>
          </section>

          <template v-if="p.sources?.length">
            <h2 id="sources" class="mt-10 text-lg font-semibold! text-highlighted">Sources</h2>
            <ol class="mt-2.5 list-decimal space-y-1 ps-5 text-sm leading-relaxed text-muted">
              <li v-for="s in p.sources" :key="s.url">
                <a :href="s.url" class="font-medium text-primary hover:underline">{{ s.title }}</a
                >, checked <time :datetime="s.checked">{{ blogDate(s.checked) }}</time>
              </li>
            </ol>
          </template>
          <p v-if="p.notTaxAdvice" class="mt-6 text-sm text-dimmed">
            This post is general information, not tax advice.
          </p>
        </article>

        <aside
          aria-label="On this page"
          class="order-first min-w-0 text-sm lg:sticky lg:top-[calc(var(--ui-header-height)+1.5rem)] lg:order-none lg:max-w-[17.5rem] lg:flex-[1_1_220px]"
        >
          <template v-if="toc.length">
            <p class="mb-2.5 text-[0.8125rem] font-semibold text-highlighted">On this page</p>
            <ul class="border-s border-default leading-8">
              <li v-for="t in toc" :key="t.id">
                <a
                  :href="`#${t.id}`"
                  class="blog-toc-link"
                  :class="{ on: current === t.id }"
                  :aria-current="current === t.id ? 'location' : undefined"
                >
                  {{ t.text }}
                </a>
              </li>
            </ul>
          </template>
          <div class="mt-6 flex gap-2">
            <UButton color="neutral" variant="outline" size="sm" @click="copyLink">
              {{ copied ? "Link copied." : "Copy link" }}
            </UButton>
            <UButton
              :href="`${p.path}.md`"
              external
              color="neutral"
              variant="outline"
              size="sm"
              :aria-label="`${p.title} as Markdown`"
            >
              Markdown
            </UButton>
          </div>
        </aside>
      </UContainer>
    </section>

    <section v-if="readNext.length" class="mk-tint mt-10">
      <UContainer class="py-12">
        <h2 class="mk-h3 text-highlighted">Read next</h2>
        <div class="mt-5 grid grid-cols-[repeat(auto-fit,minmax(16.25rem,1fr))] gap-4">
          <NuxtLink
            v-for="r in readNext"
            :key="r.path"
            :to="r.path"
            class="mk-card group p-5"
            :class="blogToneClass(blogCategory(r.category)?.tone)"
          >
            <span class="text-xs font-semibold text-(--mk-mark-text)">{{ r.category }}</span>
            <span class="mt-2 font-medium text-highlighted group-hover:text-primary">
              {{ r.title }}
            </span>
            <span class="mt-1.5 text-sm text-muted">{{ r.description }}</span>
          </NuxtLink>
        </div>
      </UContainer>
    </section>

    <MkCta
      :title="cta.title"
      :description="cta.description"
      :shot="cta.shot"
      :secondary="{ label: 'Talk to us', to: '/contact' }"
    />
  </div>
</template>

<style scoped>
.blog-title {
  font-size: 2.25rem;
  line-height: 1.1;
  font-weight: 500;
  letter-spacing: -0.025em;
  text-wrap: balance;
}
@media (min-width: 640px) {
  .blog-title {
    font-size: 3rem;
  }
}

/* The article: Nuxt UI's prose components, set to the blog's measure. */
.blog-prose {
  font-size: 1.0625rem;
  line-height: 1.75;
  color: var(--ui-text-toned);
}
.blog-prose > :deep(p:first-child) {
  margin-top: 0;
  font-size: 1.1875rem;
  line-height: 1.7;
  color: var(--ui-text-highlighted);
}
.blog-prose :deep(p) {
  margin-block: 0.875rem;
  line-height: inherit;
}
.blog-prose :deep(h2),
.blog-bridge h2,
#sources {
  scroll-margin-top: calc(var(--ui-header-height) + 1.5rem);
}
.blog-prose :deep(h2) {
  margin: 2.5rem 0 0;
  font-size: 1.5rem;
  line-height: 1.25;
  font-weight: 500;
  letter-spacing: -0.015em;
  color: var(--ui-text-highlighted);
}
.blog-prose :deep(h3) {
  margin: 2rem 0 0;
  font-size: 1.25rem;
  line-height: 1.3;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
@media (min-width: 640px) {
  .blog-prose :deep(h2) {
    font-size: 1.75rem;
  }
}
.blog-prose :deep(li) {
  line-height: inherit;
}
/* A table sits in one bordered box that scrolls sideways on a phone; rows are ruled. */
.blog-prose :deep(div:has(> table)) {
  margin-block: 1.125rem;
  overflow-x: auto;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
}
.blog-prose :deep(table) {
  width: 100%;
  min-width: 32.5rem;
  border-collapse: collapse;
  font-size: 0.875rem;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}
.blog-prose :deep(:is(th, td)) {
  padding: 0.625rem 0.875rem;
  border: 0;
  border-radius: 0;
}
.blog-prose :deep(thead) {
  background: var(--mk-tint);
}
.blog-prose :deep(th) {
  font-weight: 600;
  color: var(--ui-text-muted);
}
.blog-prose :deep(tbody tr) {
  border-top: 1px solid var(--ui-border);
}

/* "How Two Minute Billing handles …": an indigo-tint box, our voice after the guide's. */
.blog-bridge {
  margin-top: 2.5rem;
  padding: 1.75rem;
  border-radius: 1rem;
  border: 1px solid var(--mk-indigo-line);
  background: color-mix(in oklab, var(--mk-indigo-wash) 60%, var(--mk-canvas));
  font-size: 1rem;
  line-height: 1.7;
  color: var(--ui-text-toned);
}
.blog-bridge h2 {
  font-size: 1.375rem;
  line-height: 1.3;
  font-weight: 600;
}
.blog-bridge-link {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 2.5rem;
  padding: 0.5rem 0.875rem;
  border-radius: 0.5rem;
  border: 1px solid var(--mk-indigo-line);
  background: var(--mk-card);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ui-primary);
}
.blog-bridge-link:hover {
  border-color: var(--ui-primary);
}

.blog-toc-link {
  display: block;
  margin-inline-start: -1px;
  padding-inline-start: 0.875rem;
  border-inline-start: 1px solid transparent;
  color: var(--ui-text-muted);
}
.blog-toc-link:hover {
  color: var(--ui-text-highlighted);
}
.blog-toc-link.on {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
  font-weight: 500;
}
</style>
