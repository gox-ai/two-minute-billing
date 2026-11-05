import { eventHandler } from "h3";
import { sitemapXml } from "../lib/sitemap";

/**
 * Serves /sitemap.xml from ../lib/sitemap.ts ahead of every other handler. Docus 5.15 adds
 * @nuxtjs/sitemap, whose handler wins over server/routes/ and lists only the /help pages.
 */
export default defineNitroPlugin((nitroApp) => {
  const handler = eventHandler((event) => {
    if (event.path.split("?")[0] !== "/sitemap.xml") return;
    if (event.method !== "GET" && event.method !== "HEAD") return;
    return sitemapXml(event, useRuntimeConfig(event).public);
  });
  // Index 0 is Nitro's route-rules handler; keep it first.
  nitroApp.h3App.stack.splice(1, 0, { route: "", handler });
});
