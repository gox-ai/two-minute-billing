import { eventHandler, getRequestURL, sendRedirect } from "h3";
import publicDirs from "#tm-public-dirs";

/**
 * One URL per page: `/Pricing`, `/pricing/` and `/index.html` answer 301 to `/pricing` and `/`.
 *
 * A route rule cannot match case or a trailing slash, and Nitro's static handler (first in the
 * stack) would serve a prerendered `/security/index.html` for `/security/` before any middleware
 * ran. So this layer goes to the front of the stack, behind only the route-rules handler.
 * Internal paths (`/_nuxt`, `/__nuxt_content`, `/api`) are left alone, and files (a dot in the
 * last segment) keep their case: asset names are hashed in mixed case.
 *
 * Under `nuxt dev` a folder in public/ (`/product`, the screenshots) is answered with a 301 to
 * `/product/` before this runs, so stripping that slash would loop. The built server serves
 * `/product/index.html` for `/product` and has no such redirect, so there the slash goes.
 */
const DEV_FOLDERS = new Set<string>(import.meta.dev ? publicDirs : []);
const INTERNAL = /^\/(_|api\/)/;

function canonicalPath(path: string): string {
  if (INTERNAL.test(path)) return path;
  let p = path.replace(/\/index\.html$/, "/");
  const bare = p.replace(/\/+$/, "") || "/";
  if (!DEV_FOLDERS.has(bare)) p = bare;
  const last = p.slice(p.lastIndexOf("/") + 1);
  return last.includes(".") ? p : p.toLowerCase();
}

export default defineNitroPlugin((nitroApp) => {
  const handler = eventHandler((event) => {
    if (event.method !== "GET" && event.method !== "HEAD") return;
    const url = getRequestURL(event);
    const to = canonicalPath(url.pathname);
    if (to !== url.pathname) return sendRedirect(event, `${to}${url.search}`, 301);
  });
  const { stack } = nitroApp.h3App;
  // Index 0 is Nitro's route-rules handler; keep it first.
  stack.splice(1, 0, { route: "", handler });
});
