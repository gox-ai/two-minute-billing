# docs-site/ — the public documentation site

Nuxt 4 + [Docus](https://docus.dev) 5. Written for
customers and integrators — **not** `docs/`, which is the engineering set written for us.

The product is **Two Minute Billing**; `tmbilling` is the short form and the name the API uses.
Metadata and first mentions carry the full name, body prose uses the short one, and identifiers
(`TMBILLING_URL`, `Tmbilling-Signature`) are never rewritten.

```bash
pnpm --filter tmbilling-docs dev   # serve the committed pages on :4210
pnpm docs-site:dev                 # regenerate changelog + reference first (maintainers only)
pnpm docs-site:build               # regenerate, then nuxt build (maintainers only)
```

Third package in the workspace — install from the **root**, never in here
(`--filter tmbilling-docs`).

## Layout

| Path | What it is |
|---|---|
| `app/pages/**` | The marketing site: `/` (its existence makes Docus release the `/` route), `/pricing`, `/product/*`, `/solutions/*`, `/security`, `/integrations`, `/migrate`, `/open-source`, `/changelog`, `/contact`, and `/compare` + `/compare/[slug]` (data in `app/utils/compare.ts`). Each uses `layout: "marketing"`. |
| `app/layouts/marketing.vue`, `app/components/marketing/` | The marketing header (menus + mobile slideover), footer and `Mk*` sections. Not Docus's chrome. |
| `app/composables/useMarketingSeo.ts` | Every marketing page's head: title, description, canonical, Open Graph and Twitter cards, the social image, and one JSON-LD graph (Organization, WebSite, SoftwareApplication, WebPage or FAQPage, BreadcrumbList). |
| `app/components/OgImage/`, `app/utils/og.ts`, `app/utils/ogImage.ts` | Social cards: `Marketing` for marketing pages, and `Docs`, which replaces Docus's card for docs pages. `/pricing` and `/contact` are server-rendered, so `og.ts` names a prerendered card for each and `nuxt.config.ts` adds it to the prerender list. |
| `app/plugins/seo-head.ts` | Site-wide head fixes: docs JSON-LD as `TechArticle` with git dates and a Home breadcrumb, the brand tile as the fallback social card, `noindex` on error pages, and a docs page's frontmatter `robots` applied to its meta and header. |
| `app/utils/routes.ts` | Every marketing route, from the site map. The sitemap and the prerender list read it. |
| `app/utils/site.ts` | The site map: header, mobile menu, footer and overview pages all read it. `useAppLinks()` builds Sign in / Start for free from `NUXT_PUBLIC_APP_URL`. |
| `app/utils/edition.ts` | `NUXT_PUBLIC_EDITION` (build time): `cloud` is the public site; `self_hosted` (default) drops `app/pages/**`, sends `/` to `/help`, strips links to marketing pages from the docs (`content:file:beforeParse`) and the Changelog tab. |
| `app/components/app/AppHeaderBottom.vue`, `app/components/docs/DocsAsideLeftBody.vue` | Docs tabs (Guides · Developers · API reference · Changelog) and the sidebar narrowed to the active tab. Override Docus's, which tabs by top-level section — all docs sit under `/help`. |
| `server/api/plans.get.ts` | `/pricing`'s plans, read live (cached 10 min) from our own catalogue: the public pricing page of `NUXT_PRICING_BUSINESS` on `NUXT_PRICING_API_URL`. The currency follows the visitor (CDN `cf-ipcountry`). |
| `server/api/contact.post.ts` | The contact form → SMTP (`NUXT_CONTACT_SMTP_URL`, `NUXT_CONTACT_TO`, `NUXT_CONTACT_FROM`), 5 an hour per address, Turnstile when `NUXT_TURNSTILE_SECRET` + `NUXT_PUBLIC_TURNSTILE_SITE_KEY` are set. |
| `server/plugins/root-env.ts`, `server/lib/root-env.ts` | At server start, copies the listed runtime `NUXT_*` keys from the repository's root `.env` (see Environment below). |
| `data/releases.json`, `data/api-stats.json` | Generated before every build: the What's New notes (`scripts/gen-changelog.ts`, from `dashboard/content/releases`) and the endpoint/event counts (the API reference generator). Never typed. |
| `content/help/**.md` | Documentation pages. Numeric prefixes (`01.`, `02.`) set navigation order; each directory carries a `.navigation.yml` with its title and Lucide icon. |
| `app/components/content/` | MDC components available to markdown: `::endpoint{method path}`, `::screenshot{src alt caption}`. |
| `public/product/` | Dashboard screenshots, `<name>-light.webp` + `<name>-dark.webp`. |
| `assets/css/tmbilling.css` | Our visual identity over the Docus shell. |
| `app/app.config.ts` | Docus theme config — brand hue, header, pricing-card wrapping. Nuxt 4 reads it only from `app/`. |
| `nuxt.config.ts` | `extends: ["docus"]`, Studio, llms.txt, prerender, the title template, the social-card render budget, and robots (`noindex` until launch). |

### The documentation splits in two

`/help` has one audience per top-level section, and they are written differently:

| Section | Reader | Voice |
|---|---|---|
| `01.getting-started/`, `02.guides/` | The person running the billing — a founder, a finance lead, an ops team | The dashboard. Screens, buttons and outcomes. No endpoints, no payloads, no jargon. |
| `40.developers/` | The engineer integrating it | HTTP. Requests, responses, signatures, idempotency. |

A page that mixes the two serves neither. When an operator guide has to name something technical,
it links across to `/help/developers/...` rather than explaining it inline.

`40.developers/` is numbered `40.` so `01.`–`39.` stay free for more product sections.

## Generated vs authored

**`content/help/40.developers/50.api-reference/` is generated and is replaced on every build**
by `scripts/gen-api-reference.ts`. Every generated file carries an HTML comment saying so,
because the boundary has to survive someone editing in Studio — where a page looks exactly like
any other. `40.developers/05.webhooks/04.events.md` is generated too, by
`scripts/gen-webhook-reference.ts`.

The API surface comes from `sdk/openapi.json`, the same document the typed SDK is generated from.
Nothing in the generator invents a field, renames one, or supplies a description the engine did
not write: a page that disagrees with the spec is worse than a page that is missing.

## Screenshots

Operator pages carry dashboard screenshots through `::screenshot`:

```mdc
::screenshot
---
src: business-home
alt: "The business home screen"
caption: "Where the business stands now, and what needs attention."
---
::
```

`src` names a **pair** in `public/product/` — `business-home-light.webp` and `business-home-dark.webp` — and
`UColorModeImage` picks the one matching the reader's theme. Both files must exist or the other
theme shows a broken image.

They are captured over CDP at 1920×1080, once per theme, with the Next dev overlay hidden.
Commit them as WebP, not PNG: `ffmpeg -i shot.png -c:v libwebp -quality 90 shot.webp` keeps UI
text indistinguishable at about a third of the size (the site has no image optimizer).
**Capture from the seeded demo organization (`pnpm seed`, the Acme businesses), or from a
business whose owner has cleared its name and figures for publication.** Either way, replace
every customer and person name, email, id, plan code, address and tax id in the rendered page
with same-shape fakes before the capture, and show the signed-in user as "Admin". Before
committing, look at every shot for names, ids and emails. Quote `alt` and `caption` in the
YAML: an unquoted value containing `: ` is a parse error that renders the page as a 500.

## Writing pages

Read `.claude/skills/create-docs/references/mdc-components.md` first. The rule that bites: **Nuxt
UI components need the `u-` prefix in MDC** (`::u-page-card`, not `::page-card`) or they silently
fail to resolve. Callouts (`::note`, `::tip`, `::warning`, `::caution`), `::code-group` and
`::steps` are Nuxt Content's own and take no prefix.

Frontmatter requires `title` and `description` on every page.

**Blog posts** (`content/blog/*.md`, Cloud edition only; not help pages) follow the `blog` schema in `content.config.ts`.
`draft: true` keeps a post out of a production build. `publishAt: "2026-11-10T09:00:00-05:00"`
(always with an offset) hides a post until that time, then it goes live with no deploy
(`server/lib/blog.ts` decides what is live). It gets its social card at the next deploy.

## Conventions

- **Never name a competitor**, except on the comparison pages. This site is public and the repo is
  going open source. State a rule as ours — *"Round half-up to the nearest minor unit"* — not as
  somebody else's behaviour we match. A neutral placeholder ("the incumbent") is not a fix. The one
  exception is `/compare/*` (`app/utils/compare.ts` + `app/pages/compare/**`, user decision
  2026-10-22): every claim there is sourced and dated in the internal
  `docs/references/COMPARISON_SOURCES.md`, and `publish:oss` allows the names in those paths only.
- **Do not document a control that does not exist.** Every endpoint, field and header is checked
  against `sdk/openapi.json` or the engine source. A plausible example that 400s is worse than a
  missing one.

## Deploy

This app owns the whole of **twominutebilling.com**. `/` is the product landing page and the
documentation lives under `/help`.

That split is structural, not a base path. `app/pages/index.vue` exists, so Docus stops defining
the `/` route and hands the root to us; the docs sit at `/help` simply because their markdown
lives in `content/help/`. The reverse proxy therefore passes every path through unchanged — there
is nothing to strip or rewrite.

The two surfaces have different chrome. Docus mounts its header and footer behind `$route.meta`,
so the landing page opts out with `definePageMeta({ layout: false, header: false, footer: false })`
and renders `MarketingHeader` / `MarketingFooter` instead. Docs search, the docs navigation and
the section tabs stay under `/help`, where they belong.

**The build needs a 4 GB heap.** `docs-site/package.json` sets
`NODE_OPTIONS=--max-old-space-size=4096` on `build` and `generate`, because Node sizes its
default heap from total RAM — about 2 GB on a 7.5 GB box, while bundling the Nitro server after
a 1310-route prerender peaks near 4.4 GB. Without the flag the build dies with *"Ineffective
mark-compacts near heap limit"* AFTER the prerender succeeds, which reads like a hang rather
than an error. Do not lower it without re-measuring.

**Never run `nuxt dev` against this checkout while building.** The dev server holds the Nuxt
Content SQLite database, and the build fails partway with `database is locked` — producing a
partial `.output` rather than an error you would notice.

`deploy/pm2/tmbilling-docs.json` follows this repo's pm2 idiom rather than an
`ecosystem.config.js`: `node` on Nitro's real entrypoint with `interpreter: none`, because pm2's
pid must BE the process. `nuxt build` (not `generate`) — Docus serves search and the content
database from Nitro, so the site is prerendered *and* server-backed.

## One workspace note

The root `package.json` pins `vite` for the test toolchain (a security fix: vitest would otherwise
keep a vulnerable vite 5). That override is **scoped to the three vitest edges** rather than
global, because Docus's builder needs vite 8 and fails to load against 6. Widening it back to a
bare `"vite"` key breaks this site; narrowing it further re-opens the advisory.

## Environment (set on the docs host, never committed)

The site runs on the server: `/pricing` reads live prices and `/contact` sends mail. Nothing below
is committed; unset values degrade to a page that says so, never a fake.

**Where they go: the repository's root `.env`.** At start the server (`server/plugins/root-env.ts`)
copies in the runtime keys listed in `server/lib/root-env.ts` and nothing else from that file — so
`node .output/server/index.mjs` from `docs-site/` reads `../.env`, and pm2 needs no env of its own.
The file is `DOTENV_CONFIG_PATH` when set, else `.env` beside the nearest `pnpm-workspace.yaml`.
Precedence: the real environment > `docs-site/.env` (`nuxt dev` and `nuxt build` only) > the root
`.env`. Restart the server after a change. `pnpm verify:env-allowlist` checks the list equals
`runtimeConfig` in `nuxt.config.ts`.

`NUXT_PUBLIC_EDITION` is not on that list: it is fixed when the site is built, and a plain
`pnpm docs-site:build` builds `self_hosted`. `deploy/docs-deploy.sh` builds `cloud` unless told
otherwise. Prerendered pages also fix the `NUXT_PUBLIC_*` values at build time, so the build and
the server must agree on them (`docs-deploy.sh` exports the ones set in
`deploy/docs-deploy.local`).

| Variable | Used by |
|---|---|
| `NUXT_PUBLIC_EDITION` | **Build time.** `cloud` builds our public site (marketing pages, `/pricing`, `/contact`, sign-up links). Unset or `self_hosted` builds the docs alone: `/` opens `/help`, no marketing pages, links to them removed from the docs, `/api/plans` and `/api/contact` answer 404. Any other value fails the build. |
| `NUXT_PUBLIC_APP_URL` | Sign in / Start for free links (the dashboard origin). Default `http://localhost:4100`. |
| `NUXT_PUBLIC_SITE_URL` | The canonical origin the sitemap uses. Default `https://twominutebilling.com`. |
| `NUXT_PRICING_API_URL`, `NUXT_PRICING_BUSINESS` | `/pricing`. The API base and our pricing business (`biz_…`). |
| `NUXT_CONTACT_SMTP_URL`, `NUXT_CONTACT_TO`, `NUXT_CONTACT_FROM` | `/contact`. |
| `NUXT_CONTACT_CHAT_WEBHOOK_URL` | `/contact` also posts to this Google Chat webhook; a message is sent when email or chat takes it. |
| `NUXT_TURNSTILE_SECRET`, `NUXT_PUBLIC_TURNSTILE_SITE_KEY` | `/contact`'s bot check (both or neither). |
