import { createError, eventHandler, setResponseHeader } from "h3";
import { BLOG_AUTHOR, blogDate } from "../../app/utils/blog";
import { blogPost } from "../lib/blog";

/**
 * `/blog/<slug>.md`: a post as Markdown, for AI answer engines. Its source with the header,
 * the product box and the sources written out, links made absolute.
 *
 * Served ahead of every other handler: nuxt-agent-discovery's middleware answers any `*.md`
 * path from the content collection in its own format, and a `[slug].md` route would also match
 * the page's own `/blog/<slug>`.
 */
const MD = /^\/blog\/([a-z0-9-]+)\.md$/;

export default defineNitroPlugin((nitroApp) => {
  const handler = eventHandler(async (event) => {
    const slug = MD.exec(event.path.split("?")[0]!)?.[1];
    if (!slug || (event.method !== "GET" && event.method !== "HEAD")) return;
    const pub = useRuntimeConfig(event).public;
    if (pub.edition !== "cloud") return;

    const post = await blogPost(event, `/blog/${slug}`);
    if (!post) {
      throw createError({ statusCode: 404, statusMessage: "Page not found" });
    }
    const site = String(pub.siteUrl ?? "").replace(/\/+$/, "");
    const url = `${site}${post.path}`;
    const abs = (md: string) => md.replace(/\]\(\//g, `](${site}/`);

    const body = post.rawbody
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
      .replace(/^::in-short\s*$/gm, "**In short**\n")
      .replace(/^::\s*$/gm, "")
      .trim();
    const dates = [
      `Published ${blogDate(post.date)}`,
      ...(post.updated ? [`updated ${blogDate(post.updated)}`] : []),
    ].join(", ");
    const parts = [
      `# ${post.title}`,
      `> ${post.description}`,
      `${BLOG_AUTHOR}. ${dates}. ${post.category}. Source: ${url}`,
      abs(body),
    ];
    if (post.bridge) {
      const links = (post.bridge.links ?? []).map((l) => `- [${l.label}](${l.to})`).join("\n");
      parts.push(
        abs([`## ${post.bridge.title}`, post.bridge.body, links].filter(Boolean).join("\n\n")),
      );
    }
    if (post.sources?.length) {
      const list = post.sources.map(
        (s, i) => `${i + 1}. [${s.title}](${s.url}), checked ${blogDate(s.checked)}`,
      );
      parts.push(["## Sources", ...list].join("\n"));
    }
    if (post.notTaxAdvice) parts.push("This post is general information, not tax advice.");

    setResponseHeader(event, "content-type", "text/markdown; charset=utf-8");
    setResponseHeader(event, "link", `<${url}>; rel="canonical"`);
    return `${parts.join("\n\n")}\n`;
  });
  // Index 0 is Nitro's route-rules handler; keep it first.
  nitroApp.h3App.stack.splice(1, 0, { route: "", handler });
});
