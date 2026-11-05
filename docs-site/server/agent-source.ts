import type { H3Event } from "h3";
// The module's built-in @nuxt/content adapter (nuxt.config.ts aliases it).
import builtin from "#tm-agent-builtin-source";
import { blogPost, blogPosts } from "./lib/blog";

/**
 * nuxt-agent-discovery reads every page collection for sitemap.md and the /raw/<page>.md
 * route, `blogScheduled` included. This wraps its adapter so a blog post reaches neither before
 * it is live (lib/blog.ts). Everything else passes through unchanged.
 */
type Source = {
  list: (selector: unknown, event: H3Event) => Promise<{ route: string }[] | null>;
  firstLeaf: (route: string, event: H3Event) => Promise<string | null>;
  get: (route: string, event: H3Event) => Promise<unknown>;
};
const inner = builtin as unknown as Source;
const isBlogPost = (route: string) => /^\/?blog\/[^/]+$/.test(route);

export default {
  async list(selector: unknown, event: H3Event) {
    const pages = await inner.list(selector, event);
    if (!pages?.some((p) => isBlogPost(p.route))) return pages;
    const live = new Set((await blogPosts(event)).map((p) => p.path));
    return pages.filter((p) => !isBlogPost(p.route) || live.has(p.route));
  },
  firstLeaf: (route: string, event: H3Event) => inner.firstLeaf(route, event),
  async get(route: string, event: H3Event) {
    const path = `/${route.replace(/^\//, "")}`;
    if (isBlogPost(path) && !(await blogPost(event, path))) return null;
    return inner.get(route, event);
  },
} satisfies Source;
