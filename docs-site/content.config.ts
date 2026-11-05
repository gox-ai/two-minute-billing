import { defineCollection, defineContentConfig, z } from "@nuxt/content";
// Aliased: the lint takes any `use*` call for a React hook.
import { useNuxt as currentNuxt } from "nuxt/kit";
import { join } from "node:path";
import { BLOG_CATEGORY_LABELS, BLOG_TONES, BLOG_TYPES } from "./app/utils/blog";
import { blogFiles, isScheduled } from "./server/lib/blog-files";

/**
 * Our collections, by name over the Docus layer's (the app's definition replaces a layer's).
 * `docs` is Docus's own (every file under content/, the help pages) with one change: it leaves
 * out content/blog/. The blog lives there, not in a folder of its own, because Studio edits
 * only files under content/.
 *
 * A production build leaves drafts out of every collection, so no query, feed, sitemap, llms.txt
 * or raw-markdown route can reach one. `nuxt dev` and the Studio build keep them, to preview and
 * edit. A self-hosted build has no blog: both collections stay empty.
 *
 * A post whose `publishAt` is still ahead at build time goes in `blogScheduled`, not `blog`.
 * Only our own server routes read that collection, and only once the time has passed
 * (server/lib/blog.ts); nothing built from `blog` (llms.txt, the prerendered pages) sees it, and
 * server/plugins/content-guard.ts keeps the browser away from both collections' raw data.
 */
const { options } = currentNuxt();
const content = join(options.rootDir, "content");
const dir = join(content, "blog");
const cloud = options.runtimeConfig.public.edition === "cloud";
const editing = options.dev || process.env.DOCS_STUDIO === "1";
const files = blogFiles(dir);
const builtAt = Date.now();
const drafts = editing ? [] : files.filter((f) => f.draft).map((f) => `blog/${f.file}`);
const scheduled = editing
  ? []
  : files.filter((f) => !f.draft && isScheduled(f, builtAt)).map((f) => `blog/${f.file}`);

const blogSchema = z.object({
  /** 140–155 characters: the search snippet and the card line. */
  description: z.string(),
  /** The search title when `title` is too long: at most 39 characters before the suffix. */
  seoTitle: z.string().optional(),
  /** YYYY-MM-DD, quoted in frontmatter. */
  date: z.string(),
  updated: z.string().optional(),
  category: z.enum(BLOG_CATEGORY_LABELS),
  type: z.enum(BLOG_TYPES),
  draft: z.boolean().default(false),
  /** When the post goes live: an ISO date-time with an offset. Unset = live when deployed. */
  publishAt: z.string().optional(),
  /** Minutes, always computed from the body (nuxt.config.ts); a value in the file is ignored. */
  readingTime: z.number().optional(),
  cover: z.object({
    tone: z.enum(BLOG_TONES),
    coverTitle: z.string(),
    cardLabel: z.string(),
    rows: z.array(z.object({ label: z.string(), amount: z.string() })).max(2),
    value: z.string(),
    pill: z.string(),
  }),
  /** Slugs of posts for "Read next". */
  related: z.array(z.string()).optional(),
  /** The "How Two Minute Billing handles …" box after the body. */
  bridge: z
    .object({
      title: z.string(),
      body: z.string(),
      links: z.array(z.object({ label: z.string(), to: z.string() })).optional(),
    })
    .optional(),
  /** Primary sources, each with the day it was checked. */
  sources: z
    .array(z.object({ title: z.string(), url: z.string(), checked: z.string() }))
    .optional(),
  /** Shows "This post is general information, not tax advice." */
  notTaxAdvice: z.boolean().default(false),
  /** The Markdown source, for /blog/<slug>.md. */
  rawbody: z.string(),
});

export default defineContentConfig({
  collections: {
    // Docus's definition (node_modules/docus/content.config.ts), plus the blog's exclusion.
    docs: defineCollection({
      type: "page",
      source: { cwd: content, include: "**", prefix: "/", exclude: ["index.md", "blog/**"] },
      schema: z.object({
        links: z
          .array(
            z.object({
              label: z.string(),
              icon: z.string(),
              to: z.string(),
              target: z.string().optional(),
            }),
          )
          .optional(),
      }),
    }),
    blog: defineCollection({
      type: "page",
      source: {
        cwd: content,
        include: "blog/*.md",
        prefix: "/blog",
        exclude: cloud ? [...drafts, ...scheduled] : ["**"],
      },
      schema: blogSchema,
    }),
    blogScheduled: defineCollection({
      type: "page",
      source: {
        cwd: content,
        include: "blog/*.md",
        prefix: "/blog",
        exclude: cloud
          ? files.map((f) => `blog/${f.file}`).filter((f) => !scheduled.includes(f))
          : ["**"],
      },
      schema: blogSchema,
    }),
  },
});
