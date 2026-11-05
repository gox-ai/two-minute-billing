/**
 * Site-wide head fixes, on the server and in the browser (a server-only change would be undone
 * when the browser renders the head again):
 *
 * - Docs JSON-LD: Docus marks docs pages up as an `Article` with a bare publisher name. They
 *   become a `TechArticle` published by our Organization, about our SoftwareApplication, with
 *   the git dates of the page's file. The docs breadcrumb starts at Home, like the marketing one.
 * - A page with no social card gets the brand tile, with the small card that fits a square.
 * - Error pages: the brand suffix on the title, and `noindex`.
 * - A docs page's frontmatter `robots` (e.g. "noindex, follow") becomes its robots meta and
 *   header: Docus reads `sitemap: false` but never `robots`.
 */
interface PageSeo {
  path: string;
  /** First and last commit dates of the page's file. */
  p?: string;
  m?: string;
  robots?: string;
}

const FALLBACK_IMAGE = "/icon-512.png";

export default defineNuxtPlugin(() => {
  const head = injectHead();
  const router = useRouter();
  const site = useSiteConfig();
  const base = String(site.url ?? "").replace(/\/+$/, "");
  const repo = useRepoUrl();
  const fallback = `${base}${FALLBACK_IMAGE}`;

  // Read on the server and copied into the payload, so both renders agree.
  const dates = useState<PageSeo | null>("tm-page-seo", () => null);
  if (import.meta.server) {
    const event = useRequestEvent();
    const all = (event?.context.tmContentDates ?? {}) as Record<string, { p: string; m: string }>;
    addRouteMiddleware(
      "tm-page-seo",
      async (to) => {
        const page: PageSeo = { path: to.path, ...all[to.path] };
        if (to.path === "/help" || to.path.startsWith("/help/")) {
          const doc = await queryCollection("docs").path(to.path).select("meta").first();
          const robots = (doc?.meta as Record<string, unknown> | undefined)?.robots;
          if (typeof robots === "string") {
            page.robots = robots;
            event?.node.res.setHeader("x-robots-tag", robots);
          }
        }
        dates.value = page;
      },
      { global: true },
    );
  }

  // Image only: a width or alt here would attach to a page's own card that sets none. Server
  // only: nuxt-og-image sets its card on the server, so in the browser this would replace it.
  if (import.meta.server) {
    useSeoMeta({ ogImage: fallback, twitterImage: fallback }, { tagPriority: "low" });
  }

  const error = useError();
  if (import.meta.server) {
    // @nuxtjs/robots sent "index, follow" before the page failed.
    const event = useRequestEvent();
    useNuxtApp().hook("app:rendered", () => {
      if (error.value) event?.node.res.setHeader("x-robots-tag", "noindex");
    });
  }
  useHead(() => {
    if (error.value) {
      return {
        titleTemplate: "%s | Two Minute Billing",
        meta: [{ name: "robots", content: "noindex", tagPriority: "high" }],
      };
    }
    const robots = dates.value?.path === router.currentRoute.value.path && dates.value.robots;
    return robots ? { meta: [{ name: "robots", content: robots, tagPriority: "high" }] } : {};
  });

  const home = { "@type": "ListItem", name: "Home", item: `${base}/` };

  /** In a graph the Organization is one node and the article refers to it; alone, it is inline. */
  function fixNode(node: Record<string, unknown>, path: string, graph?: Record<string, unknown>[]) {
    const types = ([] as unknown[]).concat(node["@type"]);
    if (types.includes("Article") || types.includes("TechArticle")) {
      const org = organizationNode(base, repo);
      if (graph && !graph.some((n) => n["@id"] === org["@id"])) graph.push(org);
      const orgRef = graph ? { "@id": org["@id"] } : org;
      node["@type"] = "TechArticle";
      node.inLanguage = "en";
      node.isPartOf = graph
        ? { "@id": `${base}/#website` }
        : { "@type": "WebSite", "@id": `${base}/#website`, name: SITE_NAME, url: `${base}/` };
      node.about = { "@id": `${base}/#software` };
      node.publisher = orgRef;
      node.author = orgRef;
      const d = dates.value?.path === path ? dates.value : null;
      if (d?.p && !node.datePublished) node.datePublished = d.p;
      if (d?.m && !node.dateModified) node.dateModified = d.m;
    } else if (types.includes("BreadcrumbList") && Array.isArray(node.itemListElement)) {
      const items = node.itemListElement as Record<string, unknown>[];
      if (items[0]?.item !== home.item) {
        node.itemListElement = [home, ...items].map((item, i) => ({ ...item, position: i + 1 }));
      }
    }
  }

  head.use({
    key: "tm-seo-head",
    hooks: {
      "tags:resolve": (ctx: {
        tags: { tag: string; key?: string; props: Record<string, string>; innerHTML?: string }[];
      }) => {
        const path = router.currentRoute.value.path;
        // Docus 5.15 adds nuxt-schema-org, whose WebSite + WebPage graph would repeat ours.
        if (ctx.tags.some((t) => t.key === "schema-graph")) {
          ctx.tags = ctx.tags.filter((t) => t.key !== "schema-org-graph");
        }
        const meta = (key: string, value: string) =>
          ctx.tags.find((t) => t.tag === "meta" && t.props[key] === value);
        const image = meta("property", "og:image")?.props.content;
        if (image === fallback) {
          const card = meta("name", "twitter:card");
          if (card) card.props.content = "summary";
        }
        for (const tag of ctx.tags) {
          if (tag.tag !== "script" || tag.props.type !== "application/ld+json" || !tag.innerHTML)
            continue;
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(tag.innerHTML);
          } catch {
            continue;
          }
          // A graph (useMarketingSeo, or nuxt-schema-org on Docus 5.15) or one bare node.
          const nodes = Array.isArray(data["@graph"])
            ? (data["@graph"] as Record<string, unknown>[])
            : [data];
          for (const node of [...nodes]) {
            fixNode(node, path, Array.isArray(data["@graph"]) ? nodes : undefined);
            const article = node["@type"] === "TechArticle" || node["@type"] === "BlogPosting";
            if (article && image && !node.image) node.image = image;
          }
          tag.innerHTML = JSON.stringify(data);
        }
      },
    },
  });
});
