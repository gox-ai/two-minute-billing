import type { MaybeRefOrGetter } from "vue";

/**
 * Head tags for one marketing page: title, description, canonical, Open Graph and Twitter
 * cards, the social image, and one JSON-LD graph (Organization, WebSite, SoftwareApplication,
 * the page itself with its breadcrumb, an FAQ when the page shows one, and the Blog or
 * BlogPosting node on blog pages).
 *
 * Docs pages get theirs from Docus (see plugins/seo-head.ts). Nothing here may
 * claim proof we do not have: no ratings, reviews or customer counts.
 */
export const SITE_NAME = "Two Minute Billing";

export interface FaqItem {
  label: string;
  content: string;
}

export interface Crumb {
  name: string;
  path: string;
}

export interface SchemaOffer {
  name: string;
  price: string;
  priceCurrency: string;
  description?: string;
  /** ISO 8601 duration of one billing period, for a recurring price. */
  billingDuration?: "P1M" | "P1Y";
}

export interface MarketingSeoOptions {
  /** The page part of the title. The brand suffix comes from the title template. */
  title: string;
  /** 140–160 characters: the benefit, then the next step. */
  description: string;
  /** The homepage only: a complete title, shown without the suffix. */
  fullTitle?: string;
  /** Text for the social card. */
  og: { headline: string; title: string; description: string };
  /** The trail between Home and this page. A level with no page of its own is left out. */
  parents?: Crumb[];
  /** This page's name in the breadcrumb. Defaults to `title`. */
  crumb?: string;
  /** Questions this page shows. Only visible questions go in the FAQ schema. */
  faq?: FaqItem[];
  /**
   * Offers for the SoftwareApplication node. Only / and /pricing pass them: those pages carry
   * the full node, every other page refers to it by @id so its offers cannot drift.
   */
  offers?: MaybeRefOrGetter<SchemaOffer[] | undefined>;
  /** The blog index: a CollectionPage with a Blog node. */
  blog?: boolean;
  /** A blog post: a BlogPosting node, Open Graph `article` tags and the post's own card. */
  article?: BlogPostingSeo;
  /**
   * False when this render cannot make a card: cards exist only while prerendering, and a
   * scheduled post that went live after the deploy renders per request. It shows the brand
   * icon until the next deploy prerenders it.
   */
  card?: boolean;
}

export interface BlogPostingSeo {
  headline: string;
  datePublished: string;
  dateModified?: string;
  section: string;
  /** Source URLs the post cites. */
  citation?: string[];
  /** The social card: OgImage/BlogCover.takumi.vue with these props, 1200×630. */
  cover: Record<string, unknown>;
}

/** The blog's own node, which every post is part of. */
export const blogId = (base: string) => `${base}/blog#blog`;

/** The one Organization node: the marketing graph and the docs TechArticle both use it. */
export function organizationNode(base: string, repo?: string): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": `${base}/#organization`,
    name: SITE_NAME,
    url: `${base}/`,
    description:
      "Two Minute Billing makes subscription billing software that collects through the merchant's own payment gateway. It runs on Two Minute Billing Cloud or self-hosted.",
    logo: { "@type": "ImageObject", url: `${base}/icon-512.png`, width: 512, height: 512 },
    contactPoint: { "@type": "ContactPoint", contactType: "sales", url: `${base}/contact` },
    ...(repo ? { sameAs: [repo] } : {}),
  };
}

export function useMarketingSeo(o: MarketingSeoOptions) {
  const route = useRoute();
  const site = useSiteConfig();
  const base = String(site.url ?? "").replace(/\/+$/, "");
  const path = route.path === "/" ? "/" : route.path.replace(/\/+$/, "");
  const url = `${base}${path}`;
  const home = `${base}/`;
  const pageTitle = o.fullTitle ?? `${o.title} | ${SITE_NAME}`;
  const repo = useRepoUrl();
  // Filled by plugins/seo-head.ts from the git history of this page's file.
  const dates = useState<{ path: string; m?: string } | null>("tm-page-seo");

  // Pages Nitro does not prerender point at an image the prerender made for them.
  const prebuilt = staticOgPath(path);
  const image = prebuilt ? `${base}${prebuilt}` : undefined;
  // No card can be made for this render (see `card`): the brand icon instead.
  const icon = o.card === false ? `${base}/icon-512.png` : undefined;

  useSeoMeta({
    ...(image
      ? {
          ogImage: image,
          ogImageWidth: 1200,
          ogImageHeight: 600,
          ogImageType: "image/png" as const,
          ogImageAlt: o.og.title,
          twitterImage: image,
          twitterImageAlt: o.og.title,
        }
      : icon
        ? { ogImage: icon, twitterImage: icon }
        : {}),
    title: o.fullTitle ?? o.title,
    titleTemplate: o.fullTitle ? "%s" : undefined,
    description: o.description,
    ogTitle: pageTitle,
    ogDescription: o.description,
    ogType: o.article ? "article" : "website",
    ...(o.article
      ? {
          articlePublishedTime: o.article.datePublished,
          articleModifiedTime: o.article.dateModified ?? o.article.datePublished,
          articleSection: o.article.section,
          articleAuthor: [SITE_NAME],
        }
      : {}),
    ogUrl: url,
    ogSiteName: SITE_NAME,
    ogLocale: "en_US",
    twitterCard: "summary_large_image",
    twitterTitle: pageTitle,
    twitterDescription: o.description,
  });

  if (icon) {
    // Nothing to render.
  } else if (!image && o.article) {
    defineOgImage("BlogCover", o.article.cover, { width: 1200, height: 630, alt: o.og.title });
  } else if (!image) {
    defineOgImage("Marketing", {
      headline: o.og.headline,
      title: o.og.title,
      description: o.og.description,
    });
  }

  const graph = computed(() => {
    const ids = {
      org: `${base}/#organization`,
      website: `${base}/#website`,
      software: `${base}/#software`,
      page: `${url}#webpage`,
      crumbs: `${url}#breadcrumb`,
    };
    const fullSoftware = o.offers !== undefined;
    const offers = (toValue(o.offers) ?? []).map((offer) => ({
      "@type": "Offer",
      name: offer.name,
      price: offer.price,
      priceCurrency: offer.priceCurrency,
      ...(offer.description && { description: offer.description }),
      url: `${base}/pricing`,
      ...(offer.billingDuration && {
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: offer.price,
          priceCurrency: offer.priceCurrency,
          billingDuration: offer.billingDuration,
        },
      }),
    }));

    const nodes: Record<string, unknown>[] = [
      organizationNode(base, repo),
      {
        "@type": "WebSite",
        "@id": ids.website,
        name: SITE_NAME,
        url: home,
        inLanguage: "en",
        publisher: { "@id": ids.org },
      },
      {
        "@type": "SoftwareApplication",
        "@id": ids.software,
        name: SITE_NAME,
        url: home,
        description:
          "Subscription billing software that collects through the merchant's own payment gateway account. Run it on Two Minute Billing Cloud, or self-host the open-source engine.",
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Subscription billing",
        operatingSystem: "Web",
        license: "https://www.gnu.org/licenses/agpl-3.0.html",
        publisher: { "@id": ids.org },
        featureList: [
          "Subscription management with trials and proration",
          "Recurring invoices and credit notes",
          "Your own payment gateway accounts",
          "Dunning and failed payment recovery",
          "GST by place of supply, VAT reverse charge and TDS",
          "Hosted checkout and customer portal",
          "MRR, churn and cohort reporting",
          "REST API for every dashboard screen, and webhooks",
        ],
        offers,
      },
    ].filter((n) => fullSoftware || n["@type"] !== "SoftwareApplication");

    const page: Record<string, unknown> = {
      "@type": o.faq?.length ? ["WebPage", "FAQPage"] : o.blog ? "CollectionPage" : "WebPage",
      "@id": ids.page,
      url,
      name: pageTitle,
      description: o.description,
      inLanguage: "en",
      isPartOf: { "@id": ids.website },
      // A post is about its topic, not the product.
      ...(o.article ? {} : { about: { "@id": ids.software } }),
      ...(dates.value?.path === route.path && dates.value.m ? { dateModified: dates.value.m } : {}),
    };
    if (o.faq?.length) {
      page.mainEntity = o.faq.map((q) => ({
        "@type": "Question",
        name: q.label,
        acceptedAnswer: { "@type": "Answer", text: q.content },
      }));
    }
    if (path !== "/") {
      page.breadcrumb = { "@id": ids.crumbs };
      const trail: Crumb[] = [
        { name: "Home", path: "/" },
        ...(o.parents ?? []),
        { name: o.crumb ?? o.title, path },
      ];
      nodes.push({
        "@type": "BreadcrumbList",
        "@id": ids.crumbs,
        itemListElement: trail.map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: c.name,
          item: c.path === "/" ? home : `${base}${c.path}`,
        })),
      });
    }
    nodes.push(page);
    if (o.blog) {
      page.mainEntity = { "@id": blogId(base) };
      nodes.push({
        "@type": "Blog",
        "@id": blogId(base),
        name: `${SITE_NAME} blog`,
        url: `${base}/blog`,
        description: o.description,
        inLanguage: "en",
        publisher: { "@id": ids.org },
      });
    }
    if (o.article) {
      const a = o.article;
      // `image` is the page's social card, added by plugins/seo-head.ts once it is known.
      nodes.push({
        "@type": "BlogPosting",
        "@id": `${url}#article`,
        headline: a.headline,
        description: o.description,
        datePublished: a.datePublished,
        dateModified: a.dateModified ?? a.datePublished,
        articleSection: a.section,
        inLanguage: "en",
        author: { "@type": "Organization", "@id": ids.org, name: SITE_NAME, url: home },
        publisher: { "@id": ids.org },
        mainEntityOfPage: { "@id": ids.page },
        isPartOf: { "@id": blogId(base) },
        ...(a.citation?.length ? { citation: a.citation } : {}),
      });
    }
    return JSON.stringify({ "@context": "https://schema.org", "@graph": nodes });
  });

  useHead({
    link: [{ rel: "canonical", href: url }],
    script: [{ key: "schema-graph", type: "application/ld+json", innerHTML: graph }],
  });
}
