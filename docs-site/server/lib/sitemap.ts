import { queryCollection } from "@nuxt/content/server";
import { setResponseHeader, type H3Event } from "h3";
import dates from "#tm-content-dates";
import { MARKETING_ROUTES } from "../../app/utils/routes";
import { blogPosts, escapeXml } from "./blog";

/**
 * The sitemap. Overrides the Docus layer's.
 *
 * Its version has three problems here, and all three are consequences of this app
 * owning `/` with a Vue page rather than a content file:
 *
 *  1. It pushes a `landing` collection unconditionally. We do not define one — Docus
 *     skips it when `app/pages/index.vue` exists — so every build logged a fatal
 *     `POST /__nuxt_content/landing/query` 404. Its try/catch does not cover that,
 *     because the failure happens at the request layer, not in the query.
 *  2. It takes the base URL from `inferSiteURL()`, which reads only deploy-platform
 *     environment variables (Vercel, Netlify, Cloudflare). We deploy under pm2, so
 *     none are set and every `<loc>` came out RELATIVE — which is invalid in a
 *     sitemap and makes the file useless to a crawler.
 *  3. The landing page and the other marketing pages are Vue pages, so they appear in
 *     no collection and were missing from the sitemap entirely. They come from the
 *     site map the menus read (app/utils/routes.ts).
 *
 * The origin comes from `runtimeConfig.public.siteUrl`, set alongside `site.url` from
 * one constant in nuxt.config — `useSiteConfig` is not auto-imported in Nitro.
 *
 * `<lastmod>` is the last commit that changed the page's source (nuxt.config contentDates), or
 * frontmatter `modifiedAt`; a page with neither gets none. Docus 5.15 adds @nuxtjs/sitemap,
 * whose handler would win over our route, so server/plugins/sitemap-owner.ts serves this one
 * ahead of it. server/routes/sitemap.xml.ts serves it on Docus 5.13.
 *
 * Blog posts are the live ones (lib/blog.ts): no drafts, and a scheduled post from its time on.
 */
interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

/** `pub` is `useRuntimeConfig(event).public`. */
export async function sitemapXml(
  event: H3Event,
  pub: { siteUrl?: string; edition?: string },
): Promise<string> {
  const siteUrl = String(pub.siteUrl ?? "").replace(/\/+$/, "");

  // The marketing pages first, landing page leading: they belong to no collection, so
  // nothing else would ever add them. Cloud only: a self-hosted build has none.
  const cloud = pub.edition === "cloud";
  const urls: SitemapUrl[] = cloud
    ? MARKETING_ROUTES.map((loc) => ({ loc, lastmod: dates[loc]?.m }))
    : [];

  // Published posts (lastmod: updated, else published), and /blog as new as its newest post.
  if (cloud) {
    const posts = await blogPosts(event);
    const newest = posts
      .map((p) => p.updated ?? p.date)
      .sort()
      .at(-1);
    const index = urls.find((u) => u.loc === "/blog");
    if (index && newest && (!index.lastmod || newest > index.lastmod)) index.lastmod = newest;
    for (const p of posts) urls.push({ loc: p.path, lastmod: p.updated ?? p.date });
  }

  const pages = await queryCollection(event, "docs").all();
  for (const page of pages) {
    const path = page.path || "/";
    const meta = (page.meta ?? {}) as Record<string, unknown>;

    if (meta.sitemap === false) continue;
    if (path.endsWith(".navigation") || path.includes("/.navigation/")) continue;

    const entry: SitemapUrl = { loc: path, lastmod: dates[path]?.m };
    if (typeof meta.modifiedAt === "string") entry.lastmod = meta.modifiedAt.split("T")[0];
    urls.push(entry);
  }

  const body = urls
    .map(({ loc, lastmod }) => {
      const absolute = siteUrl ? `${siteUrl}${loc}` : loc;
      const when = lastmod ? `\n    <lastmod>${escapeXml(lastmod)}</lastmod>` : "";
      return `  <url>\n    <loc>${escapeXml(absolute)}</loc>${when}\n  </url>`;
    })
    .join("\n");

  setResponseHeader(event, "content-type", "application/xml");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}
