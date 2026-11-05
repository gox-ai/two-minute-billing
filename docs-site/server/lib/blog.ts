import { queryCollection } from "@nuxt/content/server";
import type { H3Event } from "h3";

/**
 * The one reader of blog posts on the server: the pages (through /api/blog/*), RSS, the
 * Markdown copies and the sitemap all come through here. A post is live when it is not a
 * draft and its `publishAt`, if any, has passed. `blog` holds what was live at build time;
 * `blogScheduled` the posts still waiting then (content.config.ts), which join from their
 * `publishAt` on without a deploy. `nuxt dev` shows drafts and scheduled posts, to preview.
 */
export function isLive(p: { draft?: boolean | null; publishAt?: string | null }, now = Date.now()) {
  if (import.meta.dev) return true;
  if (p.draft) return false;
  return !p.publishAt || Date.parse(p.publishAt) <= now;
}

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
export async function blogPosts(event: H3Event) {
  const [built, scheduled] = await Promise.all([
    queryCollection(event, "blog")
      .select(...CARD_FIELDS)
      .all(),
    queryCollection(event, "blogScheduled")
      .select(...CARD_FIELDS)
      .all(),
  ]);
  const now = Date.now();
  return [...built, ...scheduled]
    .filter((p) => isLive(p, now))
    .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
}

/**
 * One live post, whole. `prebuilt` says whether the deploy prerendered it (and so made its
 * social card): a post that went live after the deploy is rendered per request until the
 * next one.
 */
export async function blogPost(event: H3Event, path: string) {
  const built = await queryCollection(event, "blog").path(path).first();
  const post = built ?? (await queryCollection(event, "blogScheduled").path(path).first());
  if (!post || !isLive(post)) return null;
  return { ...post, prebuilt: !!built };
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
