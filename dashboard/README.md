# dashboard/ — admin console (Next.js, App Router)

Operator UI for the billing engine. Runs on **:4100**, talks to the API on **:4000** using a
**server-side org API key** (BFF pattern — the key never reaches the browser; all API calls happen
in server components / server actions). Local login creds + seeded key: `.claude/current.md`
(rotates on reseed).

```bash
cd dashboard && pnpm install && pnpm dev      # pnpm only — never npm/yarn/bun
pnpm typecheck && pnpm build                  # the verify gate for UI work
```

## Settings

The repository's root `.env` is the one settings file. `next.config.mjs` first runs
`root-env.mjs`, which copies in only the keys in `ROOT_ENV_KEYS` (the API URL, the edition, the
cookie/CSP switches, the public sign-in values, account billing). The database URL, gateway keys
and every other secret in that file never enter this process. Precedence: the real environment >
`dashboard/.env.local` (optional, deprecated) > the root `.env`; an empty value counts as unset.
`DOTENV_CONFIG_PATH` names another root file (a worktree points it at the main checkout's).

Read a new `process.env.X`? Add it to `ROOT_ENV_KEYS` and `.env.example`'s Dashboard section.
`pnpm verify:env-allowlist` fails on an unlisted read, a dynamic `process.env[name]`, and any
listed name that looks like a secret. `ACCOUNT_BILLING_TOKEN` is the one documented exception:
it opens only `/v1/account_billing/*` and is read server-side. `NEXT_PUBLIC_*` values, the CSP
mode and HSTS are fixed at build; the rest is read when `next start` starts.

## Layout

- **`app/`** — route segments mirror the account hierarchy:
  `businesses/[biz]/{customers,subscriptions,invoices,credit_notes,transactions,payment_intents,gateway_webhooks,catalog,coupons,settings,…}`,
  plus org-level `developer/`, `audit/`, `metrics/`, `ops/`, `team/`, `settings/`, `login/`.
  Server actions live in colocated `actions.ts` files; every list page has a `loading.tsx`.
- **`lib/api/`** — one thin typed wrapper per domain (subscriptions, invoices, coupons, gateways,
  ops, transfer, time-travel, credit-notes, payments, developer, event-types, business-settings)
  over `lib/api.ts` (base fetch + auth + error handling). Add a wrapper here when a new backend
  route needs UI.
- **`components/`** — domain folders (catalog, customers, subscriptions, invoices, payments, …) +
  `ui/` (shadcn), `patterns/` (shared primitives: chips, rails, detail tables), shell
  (AppNav, SideNav, command palette), `data-table` (the shared table: search, `Sort by`, CSV export,
  column chooser, selection, sticky row-menu column).
  **Every list page uses `patterns/list-page` (`ListPage`)** — the whole list archetype
  (segments dropdown, `Filter list` builder, `Import`/`Create` top bar) wrapped around `data-table`;
  declare `columns` + `segments` + `filterFields` and the chrome is free. Cells come from
  `patterns/list-cells` (`InfoCell`, `MoneyCell`, `TextCell`, `TruncateCell`, `IdCell`, `Dash`). Reference
  wiring: `components/customers/customers-table.tsx`. Bare `DataTable` is only for tables
  **embedded** in another page (a detail-page section, a panel) — if it's a list *screen*, it's
  `ListPage`.
  - Create/Import belong to the list, not `PageHeader`: `createAction`/`importAction` for links,
    `createSlot`/`importSlot` when they open a dialog, `topBarExtras` for anything else. Pass
    `page={{ title, breadcrumbs }}` and `ListPage` draws the header itself — count pill beside the
    title, Refresh/Import/Create at its right; without it they end the toolbar row in the card.
  - Don't swap the table for an `EmptyState` when there are no rows — pass `emptyState` and let the
    chrome stay reachable.
  - Lists open **newest-first** automatically (`created_at desc` when such a column exists). Pass
    `defaultSort={{ id, desc }}` for a different anchor, or `null` to open unsorted.
  - **`home/`** — the business dashboard: `kpi-strip` (5 headline KPIs +
    the revenue/signups strip), `dashboard-toolbar` (range segments + currency picker, both driving
    `?range=`/`?currency=` so the server component refetches), `metric-card` (one series widget:
    ⓘ hint, ⋯ → the underlying list, headline + prior-month comparison, `AreaChart`, legend), and
    `plan-mix-card`. All of it renders one `GET /v1/businesses/:biz/analytics` payload — add a metric
    by adding a series there, not by deriving it in the page.
  - **`charts/`** — `AreaChart` (money/count/percent series; compact axis labels, optional
    newest-point dot) and `PieChart`, both over `charts/echart`. Props stay serializable so server
    components can render them directly.
  - **Any list that can grow unbounded must use `ListPage`'s `server` mode** (`server={{ total,
    hasMore, nextCursor, fetchPage }}`): the page server-renders the first page, and search,
    segments, filters, sort and paging all become query params on a paginated endpoint (contract in
    `docs/GUIDE.md` §3.4). Segments then need `filters` (server ops), not `match` (a row predicate),
    and each `filterField` declares `serverOps` so only operators the API implements are offered.
    Later pages are fetched through a route handler under `app/api/lists/<entity>/` — never from the
    browser directly, so the org API key stays server-side.
  - `lib/api.ts` list wrappers that hit a paginated endpoint return `PagedList<T>`
    (`data` + `has_more` + `next_cursor` + `total`). If you only need a count, request `limit: 1`
    and read `total`; if you need "everything" for a picker, pass an explicit `limit` and handle
    `has_more` — the default is 50 rows, not all of them.
  - Paginated today: **customers, subscriptions, invoices, credit notes, transactions**. Their
    pages fetch only the first page (`limit: PAGE_SIZE`) and pass `total`/`hasMore`/`nextCursor`
    into the table; the table builds its fetcher with `lib/list-source.ts`'s `makeListSource`,
    which talks to the generic `app/api/lists/[entity]` route. Add an entity by registering a
    fetcher there — don't add another bespoke route handler.
  - In server mode a segment needs `filters` (server ops) and each filter field needs `serverOps`,
    which must mirror the engine's allow-list for that entity. Anything else would render a
    control that doesn't filter.
  - **The search field is debounced by `DataTable`** (`lib/use-debounced.ts`; 250ms client-side,
    350ms server-backed, override with `searchDebounceMs`). The input is bound to local state so
    typing is never delayed — only the work it triggers is — and a spinner replaces the magnifier
    while the value settles or a request is in flight. Don't add a second debounce upstream:
    `ListPage` receives an already-settled value, so every change it sees is worth a request.
- **`lib/`** — session, format (money/date — always minor units in, formatted out), mode
  (test/live), action-result helpers.
- **`content/releases/`** — the `/whats-new` release notes, one markdown file per note.
  Frontmatter: `title`, `date` (`YYYY-MM-DD`), `type`, `tags`, optional `summary` and `version`.
  `type` is a closed set (Feature / Fix / Improvement / Performance / Security) validated at parse
  time and used by the page's filter — add a value in `lib/release-note-types.ts` rather than
  inventing one in a file. In the repo on purpose: a note ships with the deploy carrying the work
  it describes and is reviewed in the same PR; publishing one needs a deploy, and that is the
  trade. **Write them benefit-first** — a note says what is true and better now, not what used to
  be wrong; the engineering account belongs in `docs/PROGRESS.md`. Parsed by `lib/release-notes.ts`
  (a deliberate markdown subset, no dependency) and rendered by `components/release-note-body.tsx`
  — to React elements, never `dangerouslySetInnerHTML`. ⚠ `lib/release-notes.ts` reads the
  filesystem, so it is **server-only**: the shared shapes live in `lib/release-note-types.ts`, and
  a client component importing the wrong one drags `node:fs` into the browser bundle and fails the
  build. To add a note, drop in a file — nothing else to register.

## Conventions

- Server components fetch; client components only for interactivity. Mutations = server actions
  returning `ActionResult`, surfaced via toast.
- **Every call to the engine carries `forwardedFor()`** (`lib/forwarded-for.ts`), directly or via
  `authHeaders()`. We are a BFF: the engine's socket peer on that hop is this Next process, so
  without the header it records `127.0.0.1` as the caller — which is exactly what shipped to
  production and put the loopback address on every dashboard audit row. Forward the chain
  **untouched**; never append to it. `verify:security` § P reads every call site and fails on an
  omission.
- **A module that imports `next/headers` is server-only.** A client component may take TYPES from
  it (`import type` is erased) but not a runtime value — importing one const drags `next/headers`
  into the browser bundle and `next build` fails. That is why `NO_SESSION` lives in
  `lib/checkout-strings.ts` rather than in `lib/checkout-api.ts`.
- Money is formatted from integer minor units + currency — never parse floats back.
- **Time zone is picked, never typed** — `<TimezoneSelect>` over `Intl.supportedValuesOf('timeZone')`. We store the zone **name** (`Asia/Kolkata`), never an offset (an offset has no DST rule), and only **modern** IANA names: ICU still canonicalizes 18 zones to their old spelling, so `lib/tz.ts`'s `LEGACY_TO_MODERN` (mirrored in `src/platform/timezones.ts`) maps them for display, search and storage. `normalizeTimezone` rejects fixed offsets and bare abbreviations, which `Intl` would otherwise accept.
- **Dates: business timezone in the UI, UTC on the wire.** Display goes through
  `fmtDate`/`fmtDateTime` (`lib/format.ts`) with the zone from `useBusinessTz()` — client
  components read the context, server components resolve it via `businessTz(biz)`
  (`lib/business-tz-server.ts`). Entry goes through **`<DateTimeField>`**
  (`components/form/datetime-field.tsx`), which shows a business-zone wall clock and submits the
  UTC instant; dated server-action fields use `utcDateTime`/`optUtcDateTime`/`assertUtc`
  (`lib/zod-utc.ts`) so a field that skips the component fails loudly instead of shifting silently.
  Never hand-roll either side: a raw `<input type="datetime-local">` posts a **zone-less** string,
  and `new Date()` then resolves it in the server's zone. **This is invisible in local dev when
  your machine's zone happens to match the business's** — it only breaks in production, where
  containers run UTC. Proof + the DST/half-hour-zone cases: `pnpm verify:dashboard-tz`.
- After changing backend routes, regenerate the SDK (`pnpm sdk:generate` in repo root) and update
  the matching `lib/api/` wrapper.
- **Verify UI in a real browser** — renders ≠ works; browser-only bugs have slipped past
  typecheck before (see docs/GUIDE.md § Working process).
