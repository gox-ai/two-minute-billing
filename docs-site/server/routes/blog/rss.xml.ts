import { createError, setResponseHeader } from "h3";
import { BLOG_DESCRIPTION, BLOG_TITLE } from "../../../app/utils/blog";
import { blogPosts, escapeXml } from "../../lib/blog";

/** RSS 2.0 for the blog: published posts, newest first, absolute URLs. Cloud only. */
export default defineEventHandler(async (event) => {
  const pub = useRuntimeConfig(event).public;
  if (pub.edition !== "cloud") throw createError({ statusCode: 404 });
  const site = String(pub.siteUrl ?? "").replace(/\/+$/, "");
  const posts = await blogPosts(event);

  const rfc822 = (day: string) => new Date(`${day}T00:00:00Z`).toUTCString();
  const items = posts
    .map((p) => {
      const url = `${site}${p.path}`;
      return [
        "    <item>",
        `      <title>${escapeXml(p.title)}</title>`,
        `      <link>${escapeXml(url)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
        `      <pubDate>${rfc822(p.date)}</pubDate>`,
        `      <category>${escapeXml(p.category)}</category>`,
        `      <description>${escapeXml(p.description)}</description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");
  // The newest change, not the build time: the feed only changes when a post does.
  const newest = posts
    .map((p) => p.updated ?? p.date)
    .sort()
    .at(-1);

  setResponseHeader(event, "content-type", "application/rss+xml; charset=utf-8");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(BLOG_TITLE)}</title>`,
    `    <link>${escapeXml(`${site}/blog`)}</link>`,
    `    <description>${escapeXml(BLOG_DESCRIPTION)}</description>`,
    "    <language>en-us</language>",
    `    <atom:link href="${escapeXml(`${site}/blog/rss.xml`)}" rel="self" type="application/rss+xml" />`,
    ...(newest ? [`    <lastBuildDate>${rfc822(newest)}</lastBuildDate>`] : []),
    ...(items ? [items] : []),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
});
