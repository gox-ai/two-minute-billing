/**
 * Blog data comes from the server (/api/blog/*, server/lib/blog.ts): the server decides which
 * posts are live, so a draft or a post before its `publishAt` can never reach a public page.
 *
 * The Studio build is the exception. Studio previews an edit by changing the content database
 * in the browser, so there the pages query it directly, drafts and scheduled posts included.
 */
declare const __TM_STUDIO_BUILD__: boolean;
export const STUDIO_BUILD = __TM_STUDIO_BUILD__;

export const postSlug = (path: string) => path.replace(/^\/blog\//, "");

const CARD_FIELDS = [
  "path",
  "title",
  "description",
  "date",
  "updated",
  "category",
  "type",
  "draft",
  "publishAt",
  "readingTime",
  "cover",
] as const;

/** Every live post's card fields, newest first. */
export function useBlogPosts() {
  return useAsyncData(
    "blog-posts",
    () =>
      STUDIO_BUILD
        ? queryCollection("blog")
            .select(...CARD_FIELDS)
            .order("date", "DESC")
            .all()
        : $fetch("/api/blog/posts"),
    { default: () => [] },
  );
}

/** One post, whole, or null: a draft or a post before its time is not found (except in Studio). */
export function useBlogPost(slug: string) {
  const path = `/blog/${slug}`;
  return useAsyncData(`blog:${path}`, async () => {
    if (STUDIO_BUILD) {
      const post = await queryCollection("blog").path(path).first();
      return post ? { ...post, prebuilt: false } : null;
    }
    try {
      return await $fetch(`/api/blog/posts/${slug}`);
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    }
  });
}

/** The RSS feed's `<link rel="alternate">`, on every blog page. */
export function useBlogFeedLink() {
  const base = String(useSiteConfig().url ?? "").replace(/\/+$/, "");
  useHead({
    link: [
      {
        rel: "alternate",
        type: "application/rss+xml",
        title: BLOG_TITLE,
        href: `${base}/blog/rss.xml`,
      },
    ],
  });
}
