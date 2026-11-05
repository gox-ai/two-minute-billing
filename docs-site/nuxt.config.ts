import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addServerTemplate } from "nuxt/kit";
import { STATIC_OG, staticOgPath } from "./app/utils/og";
import { MARKETING_ROUTES } from "./app/utils/routes";
import { COMPARE } from "./app/utils/compare";
import { SOLUTIONS } from "./app/utils/site";
import { isMarketingPath, parseEdition, stripMarketingLinks } from "./app/utils/edition";
import { COOKIE_CONSENT_KEY } from "./app/utils/cookie-consent";
import { CONSENT_COUNTRIES } from "./app/utils/regions";
import { blogReadingTime } from "./app/utils/blog";
import { blogFiles, isScheduled } from "./server/lib/blog-files";

/** The canonical origin, in one place: site config, llms.txt and the sitemap all use it. */
const SITE_URL = "https://twominutebilling.com";

/**
 * Studio is OFF unless you ask for it: `DOCS_STUDIO=1 pnpm docs-site:dev`.
 *
 * It embeds `repository: { owner, repo, branch, private: true }` in the payload of
 * every page and publishes a 24 MB admin SPA at /_studio-app/. This repository is
 * private, so a public build must carry neither. Turn it on for a local or
 * access-controlled host when someone needs to edit content, not for production.
 */
const STUDIO = process.env.DOCS_STUDIO === "1";

/**
 * Staff pages for the Studio build (docs-site/cms/: the blog posts list). Private: the
 * open-source tree leaves the folder out, so a build there never has them.
 */
const CMS = fileURLToPath(new URL("./cms/", import.meta.url));
const WITH_CMS = STUDIO && existsSync(CMS);

/**
 * The edition, read at BUILD time (NUXT_PUBLIC_EDITION, default `self_hosted`): pages are
 * prerendered, so the host cannot change it later. `cloud` is our public site. A self-hosted
 * build is the docs alone: no marketing pages (app/pages/), `/` opens /help, links to marketing
 * pages are taken out of the docs, and /api/plans + /api/contact answer 404.
 */
const EDITION = parseEdition(process.env.NUXT_PUBLIC_EDITION);
const CLOUD = EDITION === "cloud";
const MARKETING_PAGES = fileURLToPath(new URL("./app/pages/", import.meta.url));

/**
 * Blog posts live at build time, prerendered on a Cloud build. Drafts are never built; a post
 * whose `publishAt` is still ahead renders per request from that time on, until the next
 * deploy prerenders it (content.config.ts, server/lib/blog.ts).
 */
const BLOG_FILES = CLOUD
  ? blogFiles(fileURLToPath(new URL("./content/blog", import.meta.url)))
  : [];
const BUILT_AT = Date.now();
const BLOG_POSTS = BLOG_FILES.filter((f) => !f.draft && !isScheduled(f, BUILT_AT)).map(
  (f) => `/blog/${f.slug}`,
);
const BLOG_UNLISTED = BLOG_FILES.filter((f) => f.draft || isScheduled(f, BUILT_AT)).map(
  (f) => `/blog/${f.slug}`,
);

/**
 * Google Analytics: Cloud production builds only. The ID comes from deploy/docs-deploy.local
 * (gitignored), so dev, test and self-hosted builds never load the tag.
 */
const GA_ID = CLOUD ? (process.env.NUXT_PUBLIC_GA_ID ?? "").trim() : "";
if (GA_ID && !/^G-[A-Z0-9]+$/.test(GA_ID)) {
  throw new Error(`NUXT_PUBLIC_GA_ID must look like G-XXXXXXX, got "${GA_ID}"`);
}

/**
 * Real dates per route, for sitemap `<lastmod>` and the JSON-LD dates: the newest (`m`) and
 * oldest (`p`) commit that touched the page's source file. A build without git history (a
 * tarball) gets none, and nothing invents one. Routes follow Nuxt Content's rule: drop the
 * `NN.` order prefixes and a trailing `index`. A Nitro template (`#tm-content-dates`), not
 * runtimeConfig: no env may override it, and the browser never downloads it.
 */
export type ContentDates = Record<string, { p: string; m: string }>;
function contentDates(): ContentDates {
  const root = fileURLToPath(new URL(".", import.meta.url));
  let log: string;
  try {
    log = execFileSync(
      "git",
      [
        "log",
        "--format=%x00%cs",
        "--name-only",
        "--relative",
        "--",
        "content",
        "app/pages",
        "app/utils/compare.ts",
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return {};
  }
  const files: ContentDates = {};
  for (const commit of log.split("\0").slice(1)) {
    const [date, ...names] = commit.split("\n");
    for (const name of names) {
      if (!name || !date) continue;
      files[name] = { m: files[name]?.m ?? date, p: date }; // log is newest first
    }
  }
  const toRoute = (rel: string) => {
    const segs = rel.split("/").map((s) => s.replace(/^\d+\./, ""));
    if (segs.at(-1) === "index") segs.pop();
    return `/${segs.join("/")}`;
  };
  const dates: ContentDates = {};
  for (const [file, d] of Object.entries(files)) {
    if (!existsSync(join(root, file))) continue; // a deleted or renamed file's old route
    // Blog posts carry their own dates in frontmatter; content/blog/ is not a help page.
    const content = /^content\/(?!blog\/)(.+)\.md$/.exec(file);
    const page = /^app\/pages\/(.+)\.vue$/.exec(file);
    const route = content
      ? toRoute(content[1]!)
      : page && !page[1]!.includes("[")
        ? toRoute(page[1]!)
        : undefined;
    if (route) dates[route] = d;
  }
  // One template and one data file make every comparison page: the newer of the two counts.
  const tpl = files["app/pages/compare/[slug].vue"];
  const data = files["app/utils/compare.ts"];
  for (const { to } of COMPARE) {
    const ms = [tpl?.m, data?.m].filter(Boolean).sort() as string[];
    const ps = [tpl?.p, data?.p].filter(Boolean).sort() as string[];
    if (ms.length) dates[to] = { m: ms.at(-1)!, p: ps[0]! };
  }
  return dates;
}

/** Every folder under public/, as a URL path (`/product`). */
function publicDirs(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => [
      `${prefix}/${e.name}`,
      ...publicDirs(join(dir, e.name), `${prefix}/${e.name}`),
    ]);
}

/**
 * llms.txt sections, without links to marketing pages on a self-hosted build. A section with a
 * `contentCollection` gets its links from Nuxt Content when the file is served.
 */
function llmsSections<T extends { links?: { href: string }[]; contentCollection?: string }>(
  sections: T[],
): T[] {
  if (CLOUD) return sections;
  return sections
    .map((s) =>
      s.links
        ? { ...s, links: s.links.filter((l) => !isMarketingPath(l.href.slice(SITE_URL.length))) }
        : s,
    )
    .filter((s) => s.contentCollection || (s.links?.length ?? 0) > 0);
}

/**
 * A short content hash per exported illustration file. MkIllustration adds it to the URL, so a
 * re-exported file gets a new address and no browser or CDN cache serves the old one.
 */
const ILLUSTRATIONS = fileURLToPath(new URL("./public/illustrations", import.meta.url));
const illustrationVersions: Record<string, string> = existsSync(ILLUSTRATIONS)
  ? Object.fromEntries(
      readdirSync(ILLUSTRATIONS)
        .filter((f) => /\.(webp|mp4)$/.test(f))
        .map((f) => [
          f,
          createHash("sha1")
            .update(readFileSync(join(ILLUSTRATIONS, f)))
            .digest("hex")
            .slice(0, 8),
        ]),
    )
  : {};

export default defineNuxtConfig({
  extends: ["docus"],

  vite: {
    define: {
      __ILL_VERSIONS__: JSON.stringify(illustrationVersions),
      // The blog pages read content in the browser only in the Studio build (composables/useBlog.ts).
      __TM_STUDIO_BUILD__: JSON.stringify(STUDIO),
    },
  },

  modules: [
    ...(STUDIO ? ["nuxt-studio"] : []),
    /**
     * Docus detects the git remote and branch and builds "Edit this page", "Report an
     * issue" and the repo icon links from them. Built from the PRIVATE development repo,
     * that would publish its org, name and working branch on every page — so the public
     * repository is written here instead.
     *
     * It cannot be set from app.config.ts alone: Docus merges with
     * `defu(appConfig.github, detected)` and a value a module writes to
     * `nuxt.options.appConfig` beats the file. `modules:done` runs after Docus, so this
     * is the last word. Verify: grep -rl 'tmbilling' .output/public finds no repo link.
     */
    () => {
      const code = `export default ${JSON.stringify(contentDates())};`;
      addServerTemplate({ filename: "#tm-content-dates", getContents: () => code });
      // For server/plugins/canonical-url.ts: the dev server answers a public/ folder with a slash.
      const dirs = publicDirs(fileURLToPath(new URL("./public", import.meta.url)));
      addServerTemplate({
        filename: "#tm-public-dirs",
        getContents: () => `export default ${JSON.stringify(dirs)};`,
      });
    },
    (_options, nuxt) => {
      nuxt.hook("modules:done", () => {
        nuxt.options.appConfig.github = {
          owner: "gox-ai",
          name: "two-minute-billing",
          url: "https://github.com/gox-ai/two-minute-billing",
          branch: "main",
          rootDir: "docs-site",
        };
        // The Changelog is a marketing page, so only a Cloud build links it. App config merges
        // arrays by appending, so this lands after app.config.ts's API reference link.
        if (CLOUD) {
          nuxt.options.appConfig.toc = {
            ...nuxt.options.appConfig.toc,
            bottom: {
              links: [{ icon: "i-lucide-sparkles", label: "Changelog", to: "/changelog" }],
            },
          };
        }
      });
    },
  ],

  hooks: {
    // Self-hosted: every page in app/pages/ is marketing, so none is built.
    "pages:extend"(pages) {
      if (WITH_CMS)
        pages.push({ name: "cms-posts", path: "/cms/posts", file: join(CMS, "pages/posts.vue") });
      if (CLOUD) return;
      for (let i = pages.length - 1; i >= 0; i--) {
        if (pages[i]!.file?.startsWith(MARKETING_PAGES)) pages.splice(i, 1);
      }
    },
    // sitemap.md and /raw/*.md read every page collection; our wrapper keeps a blog post out of
    // both until it is live (server/agent-source.ts). It sits in front of the module's adapter.
    "nitro:config"(config) {
      const alias = (config.alias ??= {});
      const builtin = alias["#agent-discovery/source"];
      if (!builtin || builtin.endsWith("agent-source.ts")) return;
      alias["#tm-agent-builtin-source"] = builtin;
      alias["#agent-discovery/source"] = fileURLToPath(
        new URL("./server/agent-source.ts", import.meta.url),
      );
    },
    "content:file:beforeParse"({ file }) {
      if (!CLOUD && file.extension === ".md") file.body = stripMarketingLinks(file.body);
    },
    // Blog: the read time from the body; a YAML date as a day.
    "content:file:afterParse"({ file, content, collection }) {
      if (collection.name !== "blog" && collection.name !== "blogScheduled") return;
      // Always from the body: Studio writes the value it shows back into the file, where a
      // fixed number would go stale as the post changes.
      content.readingTime = blogReadingTime(file.body);
      for (const key of ["date", "updated"]) {
        const v = content[key];
        if (v instanceof Date) content[key] = v.toISOString().slice(0, 10);
      }
    },
  },

  content: {
    build: {
      markdown: {
        // A disabled plugin entry: it runs nothing, but it is part of Nuxt Content's parse-cache
        // key, so a build for the other edition re-parses instead of reusing stripped pages.
        remarkPlugins: { [`tmb-edition-${EDITION}`]: false },
      },
    },
  },

  /**
   * The fallback head for any page that sets none, and the one brand suffix every page title
   * gets. Page titles are written keyword first and kept to 39 characters, so a title with the
   * suffix stays within 60. Set here, not in app.config.ts: Docus writes its own `seo` defaults
   * into `nuxt.options.appConfig`, which beats the file but not this.
   */
  appConfig: {
    seo: {
      titleTemplate: "%s | Two Minute Billing",
      title: "Subscription billing documentation",
      description:
        "Guides, recipes and the API reference for Two Minute Billing: subscription billing on your own Stripe, Razorpay or PayPal account, on Cloud or self-hosted.",
    },
  },

  // Our identity on top of the Docus shell — see the file header.
  /**
   * Light unless the visitor picks dark with the toggle: every competing billing site opens
   * light, and following a dark OS setting made first visits look unlike the product.
   */
  colorMode: { preference: "light", fallback: "light" },

  // Never under `nuxt dev`; see GA_ID above. In CONSENT_COUNTRIES analytics storage stays denied
  // until the visitor accepts in CookieBar; elsewhere it is on. Ad storage is always off. The
  // inline script runs before gtag.js, so a saved choice applies on page load.
  $production: GA_ID
    ? {
        app: {
          head: {
            script: [
              {
                innerHTML: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}var c;try{c=localStorage.getItem('${COOKIE_CONSENT_KEY}')}catch(e){}var d={ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'};gtag('consent','default',Object.assign({analytics_storage:'denied',region:${JSON.stringify(CONSENT_COUNTRIES)}},d));gtag('consent','default',Object.assign({analytics_storage:'granted'},d));if(c==='granted'||c==='denied')gtag('consent','update',{analytics_storage:c});gtag('js',new Date());gtag('config','${GA_ID}');`,
              },
              { src: `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`, async: true },
            ],
          },
        },
        runtimeConfig: { public: { gaId: GA_ID } },
      }
    : {},

  // Nuxt UI turns on @nuxt/fonts, which generated two conflicting sets of Inter fallbacks (the
  // wrong one won for Helvetica Neue and Noto Sans). The fonts are self-hosted, and
  // marketing.css owns the fallbacks.
  ui: { fonts: false },

  // Inter's variable build with the optical-size axis, pinned to a text and a display cut.
  css: [
    "@fontsource-variable/inter/opsz.css",
    "~/assets/css/tmbilling.css",
    "~/assets/css/marketing.css",
    "~/assets/css/ill.css",
  ],

  site: {
    name: "Two Minute Billing",
    url: SITE_URL,
    // The Studio build is staff-only: the robots module sends noindex on every page.
    indexable: !STUDIO,
  },

  runtimeConfig: {
    /**
     * Server-only, set on the docs host (never committed): where /pricing reads our plans —
     * the API base and our pricing business — and where /contact delivers.
     */
    pricingApiUrl: "",
    pricingBusiness: "",
    contactTo: "",
    contactFrom: "",
    contactSmtpUrl: "",
    /** SES over HTTPS for /contact; all three set = used instead of the SMTP URL. */
    contactSesRegion: "",
    contactSesKeyId: "",
    contactSesSecret: "",
    /** Google Chat incoming webhook that each /contact message is also posted to. Unset = off. */
    contactChatWebhookUrl: "",
    /** Cloudflare Turnstile for the contact form; both unset = no challenge. */
    turnstileSecret: "",
    public: {
      /** `cloud` | `self_hosted`, fixed at build (see EDITION above). */
      edition: EDITION,
      turnstileSiteKey: "",
      /** Set only by a production build with analytics on (see $production); shows CookieBar. */
      gaId: "",
      /** The dashboard, for Sign in and Start for free. Production sets NUXT_PUBLIC_APP_URL. */
      appUrl: "http://localhost:4100",
      // Our sitemap route reads this. `useSiteConfig` is not auto-imported in the
      // Nitro context, and Docus's own sitemap takes the origin from deploy-platform
      // environment variables that a pm2 host does not set.
      siteUrl: SITE_URL,
    },
  },

  robots: {
    // This app owns the whole domain, so it emits robots.txt. The sitemap is our own
    // route (server/routes/sitemap.xml.ts), so the module cannot discover it.
    sitemap: "/sitemap.xml",
  },

  /**
   * llms.txt and llms-full.txt: what an AI assistant reads first. Every line here is a fact
   * the product holds today; the docs index that follows is generated from content/.
   */
  llms: {
    domain: SITE_URL,
    title: "Two Minute Billing",
    description:
      "Subscription billing software that collects through the merchant's own Stripe, Razorpay or PayPal account. It runs plans, trials, proration, invoices, credit notes, tax, dunning, hosted checkout, a customer portal and MRR reporting, with a documented REST API. Run it on Two Minute Billing Cloud, or self-host the open-source engine (AGPL-3.0).",
    notes: [
      "Two Minute Billing is not a payment gateway. The merchant's own Stripe, Razorpay or PayPal account charges the card and holds the money; Two Minute Billing decides what to charge and when, raises the invoices, retries failed payments and keeps the records.",
      "Two ways to run it. Two Minute Billing Cloud: we host it. The Free plan is free while you make less than $1,000 a month, in live mode, with every feature and no time limit. No credit card required. Above that, flat monthly plans by billing volume (yearly is 20% off) and an Enterprise plan on request. The pricing page shows the current prices and the free band in each currency. Self-hosted: the same engine, open source under the AGPL-3.0, with every feature and no limits. The public repository opens with the v0.1.0 release.",
      "No percentage of revenue and no per-transaction fee. Gateway fees are the gateway's own.",
      "India: GST by place of supply (CGST and SGST inside a state, IGST across states), GSTIN and HSN or SAC codes on invoices, one continuous invoice series, TDS withholding recorded on the invoice, and Razorpay mandates for recurring INR. The same business can also sell in USD and EUR.",
      "Money is an append-only, double-entry ledger. Issued invoices never change; a correction is a credit note. Every API write takes an Idempotency-Key. Webhooks are signed with HMAC-SHA256.",
      "Every business has a test mode with a built-in test gateway, test cards for each failure path, and Time Travel to move the clock forward.",
      "The product name is Two Minute Billing; `tmbilling` is the short form the API, headers and environment variables use.",
    ],
    sections: llmsSections([
      {
        title: "Product",
        description: "What the product does, by area.",
        links: [
          {
            title: "Two Minute Billing",
            href: `${SITE_URL}/`,
            description:
              "Subscription billing software on your own payment gateway, Cloud or self-hosted.",
          },
          {
            title: "Product overview",
            href: `${SITE_URL}/product`,
            description: "The billing lifecycle from trial to paid invoice.",
          },
          {
            title: "Subscription management",
            href: `${SITE_URL}/product/subscriptions`,
            description: "Eight pricing models, trials, proration, pauses and scheduled changes.",
          },
          {
            title: "Recurring invoicing",
            href: `${SITE_URL}/product/invoicing`,
            description: "Invoices, statuses, credit notes and branded PDFs.",
          },
          {
            title: "Payments",
            href: `${SITE_URL}/product/payments`,
            description:
              "Stripe, Razorpay and PayPal on the merchant's own accounts, routed by currency.",
          },
          {
            title: "Dunning and recovery",
            href: `${SITE_URL}/product/recovery`,
            description: "Backup cards, smart retries and recovery emails.",
          },
          {
            title: "Tax",
            href: `${SITE_URL}/product/tax`,
            description:
              "GST by place of supply, VAT reverse charge, inclusive prices and withholding.",
          },
          {
            title: "Hosted checkout and customer portal",
            href: `${SITE_URL}/product/checkout-portal`,
            description: "Branded pages; card details go straight to the gateway.",
          },
          {
            title: "Reporting",
            href: `${SITE_URL}/product/reporting`,
            description: "MRR, churn, cohorts and receivables from the ledger.",
          },
          {
            title: "AI billing",
            href: `${SITE_URL}/solutions/ai-billing`,
            description:
              "Model prices with a markup on list or on cost, prepaid credits checked before each call, spend limits and margin after model cost.",
          },
          {
            title: "Integrations",
            href: `${SITE_URL}/integrations`,
            description:
              "Stripe, Razorpay and PayPal for payments, HubSpot sync, FirstPromoter and webhooks.",
          },
          {
            title: "Changelog",
            href: `${SITE_URL}/changelog`,
            description: "Every release, newest first.",
          },
        ],
      },
      {
        title: "Cloud or self-hosted",
        links: [
          {
            title: "Pricing",
            href: `${SITE_URL}/pricing`,
            description:
              "Free in live mode while you make less than $1,000 a month, then flat monthly Cloud plans. Prices are read live from our catalogue.",
          },
          {
            title: "Self-hosted",
            href: `${SITE_URL}/open-source`,
            description:
              "The open-source engine under the AGPL-3.0, with every feature and no limits.",
          },
          {
            title: "Security",
            href: `${SITE_URL}/security`,
            description:
              "PCI DSS SAQ-A scope, the ledger, roles, two-factor sign-in and the audit log.",
          },
          {
            title: "Contact",
            href: `${SITE_URL}/contact`,
            description: "Enterprise volume, self-hosted support or moving your billing.",
          },
        ],
      },
      {
        title: "Compare",
        description: "How Two Minute Billing differs from other subscription billing platforms.",
        links: [
          {
            title: "Compare subscription billing software",
            href: `${SITE_URL}/compare`,
            description:
              "Pricing model, revenue share, self-hosting, tax and gateways, side by side.",
          },
          ...COMPARE.map((c) => ({
            title: c.label,
            href: `${SITE_URL}${c.to}`,
            description: c.description ?? "",
          })),
        ],
      },
      {
        title: "Solutions",
        description: "The same engine, set up for one kind of business.",
        links: SOLUTIONS.map((l) => ({
          title: l.label,
          href: `${SITE_URL}${l.to}`,
          description: l.description ?? "",
        })),
      },
      // Cloud only: the blog is marketing. Published posts only (content.config.ts); no empty heading.
      ...(BLOG_POSTS.length
        ? [
            {
              title: "Blog",
              description:
                "Guides to subscription billing with worked numbers: tax, failed payments, proration and revenue metrics.",
              contentCollection: "blog",
            },
          ]
        : []),
      {
        title: "Build with the API",
        links: [
          {
            title: "Quickstart",
            href: `${SITE_URL}/help/developers/getting-started/quickstart`,
            description: "A test key, then a paid subscription, in TypeScript or curl.",
          },
          {
            title: "API reference",
            href: `${SITE_URL}/help/developers/api-reference`,
            description: "Every endpoint, generated from the OpenAPI document.",
          },
          {
            title: "Webhooks",
            href: `${SITE_URL}/help/developers/webhooks`,
            description: "Signed, retried events for every state change.",
          },
          {
            title: "India GST invoices",
            href: `${SITE_URL}/help/developers/recipes/india-gst-invoices`,
            description: "CGST, SGST and IGST by place of supply.",
          },
          {
            title: "Recurring INR with mandates",
            href: `${SITE_URL}/help/developers/recipes/india-mandates`,
            description: "Razorpay mandates for off-session renewals.",
          },
        ],
      },
      {
        title: "Documentation",
        description:
          "Guides for running billing in the dashboard, developer concepts, recipes and webhooks.",
        contentCollection: "docs",
        contentFilters: [
          { field: "extension", operator: "=", value: "md" },
          { field: "path", operator: "NOT LIKE", value: "/help/developers/api-reference/%" },
        ],
      },
      {
        // "Optional" is the llms.txt name for links a reader may skip: one page per API operation.
        title: "Optional",
        description: "One page per API operation. The API reference above links them all.",
        contentCollection: "docs",
        contentFilters: [
          { field: "extension", operator: "=", value: "md" },
          { field: "path", operator: "LIKE", value: "/help/developers/api-reference/%" },
        ],
      },
    ]),
    full: {
      title: "Two Minute Billing documentation",
      description:
        "The complete Two Minute Billing documentation: operator guides for running billing in the dashboard, developer concepts and recipes, API essentials, webhooks and the API reference.",
    },
  },

  /**
   * Prices are read live from our catalogue (the fetch is cached, the page is not: the
   * currency follows the visitor), and the contact form posts; both run on the server.
   * Migration pages were removed (we do not offer it); their old URLs redirect.
   */
  routeRules: {
    "/migrate": { redirect: { to: "/", statusCode: 301 } },
    // The ~400 API reference pages are noindex and generated from the OpenAPI file: they render
    // on first request and stay cached, instead of being prerendered. They were 1200 of the
    // build's 2000 routes; the build takes about half as long. (Their social card falls back to
    // the brand image; cards only render while prerendering.)
    "/help/developers/api-reference/**": { prerender: false, swr: 3600 },
    "/help/developers/recipes/migrate-your-billing": {
      redirect: { to: "/help/developers/recipes", statusCode: 301 },
    },
    // Blog post renamed on 2026-11-03.
    "/blog/credit-based-pricing": {
      redirect: { to: "/blog/credit-based-pricing-vs-pay-as-you-go", statusCode: 301 },
    },
    "/blog/credit-based-pricing.md": {
      redirect: { to: "/blog/credit-based-pricing-vs-pay-as-you-go.md", statusCode: 301 },
    },
    ...(CLOUD
      ? {
          "/pricing": { prerender: false },
          "/contact": { prerender: false },
          // `?category=` and `?page=` change the index, so it renders per request.
          "/blog": { prerender: false },
        }
      : { "/": { redirect: "/help" } }),
  },

  /**
   * Social cards render once, while prerendering. The first one also loads the renderer, and
   * with 1300 routes prerendering beside it the default 15 s budget timed out the docs index.
   */
  ogImage: {
    security: { renderTimeout: 60_000 },
  },

  nitro: {
    // Fixed at build, not runtime config: no env on the public host may reopen the blog's
    // raw content routes (server/plugins/content-guard.ts).
    replace: { "process.env.TM_STUDIO_BUILD": JSON.stringify(STUDIO ? "1" : "") },
    handlers: WITH_CMS
      ? [{ route: "/api/cms/posts", method: "get", handler: join(CMS, "server/posts.get.ts") }]
      : [],
    // Studio sign-in from the Cloudflare Access login (cms/server/access-signin.ts).
    plugins: WITH_CMS ? [join(CMS, "server/access-signin.ts")] : [],
    prerender: {
      // Crawling finds the marketing pages too; listing them keeps them prerendered if a link
      // is ever removed. The two server-rendered pages get their social card made here.
      routes: CLOUD
        ? [
            "/",
            ...MARKETING_ROUTES.filter((r) => !(r in STATIC_OG)),
            ...Object.keys(STATIC_OG).map((page) => staticOgPath(page)!),
            ...BLOG_POSTS,
          ]
        : ["/", "/help"],
      crawlLinks: true,
      // The crawler would still find the API reference pages through links; skip them (see
      // routeRules). The index page itself stays prerendered.
      ignore: [
        ...(CLOUD ? ["/pricing", "/contact", /^\/blog(\?|$)/] : []),
        // A draft or a scheduled post must never be written to disk, even if a link leaks.
        ...BLOG_UNLISTED,
        "/help/developers/api-reference/",
      ],
      /**
       * Docus writes `/security.html`, which Nitro's node server never serves: it looks up
       * `/security` and `/security/index.html` only. So every page but `/` was rendered per
       * request, slow and without its social card (cards exist only at prerender).
       * `/security/index.html` is what the server finds.
       */
      autoSubfolderIndex: true,
    },

    /**
     * Nitro's default esbuild target here is es2019, which has no BigInt literal.
     * Dependencies in the server bundle use them, so the build warned "may crash at
     * run-time" on five call sites — a real hazard, not noise. Node 20+ runs
     * es2022 comfortably and the server bundle is the only consumer.
     */
    esbuild: {
      options: {
        target: "es2022",
      },
    },
  },

  /**
   * Studio edits content in the repo through GitHub. The generated trees
   * (`50.api-reference/`, the webhook event reference) are deliberately NOT for
   * editing there — the next `pnpm docs-site:build` overwrites them. That rule is
   * stated in each generated file's own frontmatter and in docs-site/README.md.
   */
  ...(STUDIO && {
    studio: {
      // `nuxt dev` only: edit the files on disk, no sign-in. A production build turns it off.
      dev: true,
      route: "/admin",
      git: {
        commit: {
          messagePrefix: "docs(blog):",
        },
      },
      repository: {
        provider: "github",
        owner: "gox-ai",
        repo: "tmbilling",
        // Studio commits to <rootDir>/content/<file>.
        rootDir: "docs-site",
        // Never main: a post reaches main through a reviewed PR (docs/references/blog-cms-plan.md).
        branch: process.env.DOCS_STUDIO_BRANCH || "blog-drafts",
      },
    },
  }),
});
