import { blogPost } from "../../../lib/blog";

/** One live post, whole. A draft, or a post before its `publishAt`, is a 404. */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug") ?? "";
  const post = /^[a-z0-9-]+$/.test(slug) ? await blogPost(event, `/blog/${slug}`) : null;
  if (!post) throw createError({ statusCode: 404, statusMessage: "Page not found" });
  setHeader(event, "cache-control", "public, max-age=60");
  return post;
});
