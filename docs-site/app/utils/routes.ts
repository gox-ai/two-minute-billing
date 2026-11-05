import { COMPARE } from "./compare";
import { COMPANY, DEVELOPERS, PRODUCT, SOLUTIONS } from "./site";

/**
 * Every marketing page, from the site map the menus read. The sitemap and the prerender list
 * use it, so a page in the menus cannot be missing from either. Docs pages (/help) come from
 * the content collection instead.
 */
export const MARKETING_ROUTES: string[] = [
  "/",
  "/product",
  "/compare",
  ...[...PRODUCT, ...SOLUTIONS, ...DEVELOPERS, ...COMPANY, ...COMPARE]
    .map((l) => l.to)
    .filter((to) => !to.startsWith("/help")),
].filter((to, i, all) => all.indexOf(to) === i);
