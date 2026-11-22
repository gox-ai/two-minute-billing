# storefront-analytics

First-party, cookie-free analytics for the hosted checkout and the customer portal. It feeds
the traffic widgets of the checkout and portal reports: where buyers come from, countries,
devices, browsers, time on each checkout step, portal sections viewed and invoice PDF
downloads.

## Privacy rules (ours, and not negotiable)

1. **No cookie, no browser storage, no fingerprint.** A visit is keyed to the session the buyer
   already has: the checkout session (`cosess_…`) or the portal session (`psess_…`). We add no
   identifier of our own. One row per session (`storefront_visits`, unique on surface + session).
2. **Never store an IP address.** The storefront does not even send one to the engine for these
   events. The country comes from the edge's `CF-IPCountry` header; with no such header the
   country is null. We do no IP lookup of our own.
3. **Never store the full user agent.** It is parsed in memory into three words — device
   category (desktop / mobile / tablet), browser family, OS family — and dropped.
4. **Never store the full referrer.** Only its host, and our own host counts as none.
5. **Global Privacy Control and Do Not Track are honoured.** A request with `Sec-GPC: 1` or
   `DNT: 1` records nothing: the browser beacon does not send, the storefront route does not
   forward, and the engine does not write.
6. **Bots record nothing.** Crawlers, link scanners, previewers and HTTP libraries are dropped
   (`user-agent.ts`), and only a page that ran in a browser counts as a view (`viewed_at`), so
   an email scanner that opens a checkout link adds attribution to nobody's count.
7. **Retention: 13 months**, then deleted by `sweepStorefrontVisits` in the billing clock's
   `sweep_buyer_rejections` pass.

## How a visit is recorded

| Event | Sent by | Writes |
|---|---|---|
| `entry` | the storefront's checkout entry routes (`/checkout/s/<token>`, `/buy/<link>`), after the redirect | `entered_at`, `referrer_host`, `utm_source/medium/campaign` — first touch, written once |
| `view` | the page beacon on load (`storefront-beacon.tsx`) | `viewed_at` (once) |
| `engage` | the page beacon on `visibilitychange`/`pagehide` | adds visible ms per step or section to `step_ms`, and to `engaged_ms` |
| `pdf` | the page beacon on an invoice PDF link click | `pdf_downloads + 1` |

Every event also fills `device_category`, `browser`, `os` and `country` if they are empty.
Engine routes: `POST /checkout/v1/visits` and `POST /portal/v1/visits`, authorised by the
buyer's session token exactly like `client_errors`; 60 events per session per minute, 2 KB
body. Storefront routes: `POST /checkout/visit`, `POST /portal/visit` (cookie → bearer).

Checkout steps: `details`, `confirm`, `card`, `pay`, `done` (the page's `data-checkout-step`).
Portal sections: `plan`, `invoices`, `methods`, `details` (each `.portal-pane[data-pane]` at
least 30% on screen); a section counts as viewed after `SECTION_SEEN_MS` (1 s) in a visit.

## Reports (`reports.ts`)

`checkoutTracking` and `portalTracking` run inside the checkout and portal reports
(`metrics/hosted-page-reports.ts`, `GET /v1/businesses/{biz}/checkout_report` and `/portal_report`),
under those reports' own session filters, window and currency converter. Their output is the
response's `tracking` object. Only visits with `viewed_at` in the window count.

- **Checkout**: views, completed, conversion (basis points) and revenue by channel / source /
  medium / campaign, visitor country, device and browser; median visible time per step. Revenue
  is the report's own: the first paid invoice of the completed session, converted at its day.
- **Portal**: tracked visits, sections viewed, countries, devices, browsers, PDF downloads.
- `since` is the first tracked view. A card whose window starts earlier says "Collecting data
  since <date>" instead of showing figures for days we did not track.
- `country` / `device` query filters (`visitFilterSql`) narrow every figure of both reports to
  sessions with a matching tracked visit (the portal's cancel-flow figures excepted, as with
  `arrived_from`). The Country filter lists the countries tracked for the business.

## Channel grouping (`channels.ts`)

Plain data, first matching rule wins:

1. **Campaign** — `utm_medium` is a paid medium (`cpc`, `ppc`, `paid`, `display`, `affiliate`…),
   or only `utm_campaign` is set.
2. **Email** — `utm_medium` is an email medium, or the referrer is a webmail host.
3. **Organic search** — `utm_medium=organic`, or an untagged referrer from a search engine.
4. **Social** — `utm_medium` is a social medium, or an untagged referrer from a social network.
5. **Referral** — any other referrer or UTM tag.
6. **Direct** — no referrer and no UTM tag.

## Files

| File | What |
|---|---|
| `privacy.ts` | GPC/DNT check, edge country, referrer → host, UTM clean-up |
| `user-agent.ts` | user agent → device, browser, OS; bot filter |
| `channels.ts` | channel rules as data |
| `steps.ts` | the step/section keys and their caps |
| `service.ts` | `recordVisitEvent`: one upsert per event |
| `reports.ts` | `checkoutTracking`, `portalTracking`, `visitFilterSql` (read by the hosted-page reports) |
| `retention.ts` | `sweepStorefrontVisits` (system role; 13 months) |

Verify: `pnpm verify:storefront-analytics` · unit: `test/unit/storefront-analytics.test.ts`.

## Changelog

- **2026-11-19** — Module created: `storefront_visits` (0547, RLS), the two visit routes, the
  storefront beacon and entry recording, reports, 13-month retention. Wired into the checkout and
  portal reports: `tracking` in both responses, `country`/`device` filters, the NEW TRACKING cards.
