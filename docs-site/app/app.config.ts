export default defineAppConfig({
  /**
   * The PUBLIC repository. Docus builds "Edit this page", "Report an issue" and the repo
   * icon links from these; `rootDir` puts the edit link under `docs-site/content/`.
   * nuxt.config.ts re-applies the same values after Docus's git auto-detection, which
   * would otherwise point at the private development repository.
   *
   * The edit link is `<url>/edit/<branch>/docs-site/content/<page stem>.md`, which matches
   * the mirror's layout (`publish:oss` keeps `docs-site/**` at its path). It 404s while
   * the mirror is still empty, i.e. until the first `pnpm release:oss`.
   */
  github: {
    owner: "gox-ai",
    name: "two-minute-billing",
    url: "https://github.com/gox-ai/two-minute-billing",
    branch: "main",
    rootDir: "docs-site",
  },
  header: {
    title: "Two Minute Billing",
  },
  /**
   * Full-text search, which loads the docs database (about 1.1 MB of SQL dump and SQLite WASM)
   * only when someone opens the search. The default section search queried it in the browser on
   * every page, marketing pages included.
   */
  search: { fts: true },
  /**
   * Header tabs (Guides · Developers · API reference · Changelog). Docus would build them from
   * top-level sections, and all our docs sit under /help, so `app/components/app/AppHeaderBottom.vue`
   * supplies the tabs and `docs/DocsAsideLeftBody.vue` narrows the sidebar to the active one.
   */
  navigation: { sub: "header" },
  toc: {
    bottom: {
      title: "Resources",
      links: [
        {
          icon: "i-lucide-book-open",
          label: "API reference",
          to: "/help/developers/api-reference",
        },
        // + Changelog on a Cloud build (nuxt.config.ts): it is a marketing page.
      ],
    },
  },
  ui: {
    /* The hero's default bottom padding left a ~200px void between the buttons
       and the first section. Tightened, and the section padding with it, so the
       landing page reads as one page rather than three screens. */
    pageHero: {
      slots: {
        container: "!pb-16 !pt-20",
        title: "font-medium",
      },
    },
    /* Pricing cards: the theme truncates every feature and the billing lines, which cut off
       half of each plan (and INR prices) at desktop width. Let them wrap. */
    pricingPlan: {
      slots: {
        featureTitle: "whitespace-normal",
        billingCycle: "whitespace-normal",
        billingPeriod: "whitespace-normal",
        priceWrapper: "flex-wrap",
      },
    },
    pageSection: {
      slots: {
        // The default carries `lg:` variants, so an override without them loses
        // at desktop width — measured 128px top and bottom before this.
        container: "py-12 sm:py-14 lg:py-16",
      },
    },
    /* The primary filled button is the flat brand fill (`.mk-btn`, marketing.css), on the docs
       too. Plain fills use the ramp's 500; the radius is the site's 8px. */
    button: {
      slots: { base: "rounded-[8px]" },
      compoundVariants: [{ color: "primary", variant: "solid", class: "mk-btn" }],
    },
    /* Feature icons take the mark colour: neutral, or cyan/lime under a meaning class
       (`mk-billing`, `mk-growth`; marketing.css). Indigo stays on actions and links. */
    pageFeature: { slots: { leadingIcon: "text-(--mk-mark)" } },
    pageCard: { slots: { leadingIcon: "text-(--mk-mark)" } },
    colors: {
      // Our own ramp, `--color-tmb-*` in tmbilling.css (500 = #4e4eda).
      primary: "tmb",
      neutral: "slate",
    },
  },
});
