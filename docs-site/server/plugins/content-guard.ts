import { createError, eventHandler } from "h3";

/**
 * Nuxt Content serves each collection's whole database (`sql_dump.txt`) and a SQL `query`
 * route under /__nuxt_content/<collection>/, for queries made in the browser. The blog's pages
 * never query there (they read /api/blog/*), and `blogScheduled` holds posts that are not live
 * yet, so both are closed to the browser. The server's own calls pass: it loads the database
 * from `sql_dump.txt` and runs our readers and llms.txt through `query`, all in process, on a
 * mock socket a browser connection never has. While prerendering every request is in process,
 * so `sql_dump.txt` stays closed there: a prerender would write it to disk, served as-is.
 * The Studio build and `nuxt dev` keep both open: the editor's preview runs on them.
 */
const BLOG = /^\/__nuxt_content\/blog(Scheduled)?\/([^/?]+)/;

export default defineNitroPlugin((nitroApp) => {
  if (import.meta.dev || process.env.TM_STUDIO_BUILD) return;
  const handler = eventHandler((event) => {
    const route = BLOG.exec(event.path)?.[2];
    if (!route) return;
    const internal = "__unenv__" in (event.node.req.socket ?? {});
    if (internal && (route === "query" || !import.meta.prerender)) return;
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  });
  // Index 0 is Nitro's route-rules handler; keep it first.
  nitroApp.h3App.stack.splice(1, 0, { route: "", handler });
});
