import { sitemapXml } from "../lib/sitemap";

// The whole story is in ../lib/sitemap.ts.
export default defineEventHandler((event) => sitemapXml(event, useRuntimeConfig(event).public));
