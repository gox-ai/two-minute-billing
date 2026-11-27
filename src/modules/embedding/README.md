# embedding — which websites may show a business's checkout, portal and usage widget

> Source: `src/modules/embedding/` · Routes: `src/api/embedding-routes.ts` · Schema: `db/schema/tenancy.ts`, `checkout.ts`, `portal.ts`
> Layer: customer (see docs/architecture/architecture.json)

## Purpose
A business can show its hosted checkout and customer portal inside its own app instead of sending
the buyer away. This module owns the one list of websites allowed to do that, and the two checks
that use it: when a session is minted, and before every framed storefront page load.

## Responsibilities
- One allowed-websites list per business (`businesses.embed_origins`), shared with the usage widget.
- Check a session's `embed_origin` on mint: a valid origin, on the list, loopback in a test business only.
- Answer the storefront's frame-ancestor lookup: the session's `embed_origin`, while it is still listed.

## Data model
- `businesses.embed_origins text[]` (0551). Origins only: scheme + host + port, exact match.
  `usage_widget_origins` is written in step until a later migration drops it.
- `checkout_sessions.embed_origin`, `portal_sessions.embed_origin` (0551). Null = hosted only.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `normaliseEmbedOrigin(raw)` | An origin or an error. https only; http on a loopback host. |
| `getEmbedOrigins` / `setEmbedOrigins` | Read and replace the list (also writes `usage_widget_origins`). |
| `checkEmbedOrigin(tx, businessId, raw)` | The mint-time check. Called inside the checkout and portal transactions. |
| `resolveFrameAncestor(credential)` | `cstk_`/`pstk_` token or `cosess_`/`psess_` id → origin or null. System connection. |
| `isAnyEmbedOrigin(origin)` | CORS preflight for the usage widget. |
| `EMBED_SCRIPT` / `EMBED_SCRIPT_INTEGRITY` (`embed-script.ts`) | The loader served at `/js/v1/embed.js`, and its SRI hash. |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/businesses/:biz/settings/embedding` | The list (`settings:view`). |
| `PUT /v1/businesses/:biz/settings/embedding` | Replace the list (`settings:manage`). |
| `GET /storefront/v1/frame_ancestor?credential=` | Public; the storefront proxy asks before a framed page load. |
| `GET /js/v1/embed.js` | Public loader: `TMB.checkout.open({ url })` (overlay), `TMB.checkout.mount(el, { url })` (inline). |

`embed_origin` is a field on `POST …/checkout_sessions` and `POST …/customers/:cus/portal_sessions`
(not on emailed portal links).

## Events emitted
None.

## Dependencies
- **Upstream (calls into):** tenancy (`businesses`).
- **Downstream (called by):** checkout, customer-portal, usage-controls; the dashboard's `proxy.ts`
  over HTTP.

## Invariants & gotchas
- The storefront sends `frame-ancestors <embed_origin>` only when the request is framed
  (`Sec-Fetch-Dest: iframe`), the URL carries the session's credential, and the API confirms the
  origin is still listed. Everything else keeps `'none'`. `X-Frame-Options: DENY` stays on every
  response: browsers that apply `frame-ancestors` ignore it.
- A framed session writes its cookies `SameSite=None; Secure; Partitioned` (`dashboard/lib/storefront-session.ts`).
  A `Lax` cookie never reaches a cross-site frame (measured in Chrome, Firefox and WebKit). Safari
  before 26.2 drops partitioned cookies: the frame reports `cookies_blocked` and the loader offers the
  link in a new tab (checked in WebKitGTK).
- `success` carries `paid`. A payment the gateway holds (PayPal `PENDING_REVIEW`, a debit in
  progress) sends `paid: false` and the overlay stays open on "Payment in progress"; if the frame's
  ~20s poll then sees the invoice paid (the gateway's webhook landed), it sends `success` again with
  `paid: true` and the loader closes. Grant access from the webhook either way.
- The lookup never says whether a credential is valid: unknown, malformed and hosted-only all answer null.
- A gateway page must never be framed. Inside an embed, redirect steps (PayPal approval, bank
  redirects, gateway form posts) open in a new tab with the Continue panel.

## Changelog
- **2026-11-27** — `script_url` is built from `ADVERTISED_API_URL` (this API's one public URL); `WEBHOOK_BASE_URL` is gone.
- **2026-11-26** — Phases 3–4: `TMB.portal.open({ url })` (a 720px overlay; same close button, phone
  sheet and fallback). The portal posts `subscription_changed`, `payment_method_changed`,
  `invoice_paid`; `/portal/v1/me` returns `embed_origin`. In a frame the portal hides Sign out,
  opens provider pages in a new tab (landing `/portal/approved`) and finishes through its own
  stash on Continue after approval; buy-credits and restart offer their checkout in a new tab. The
  portal entry probes the partitioned cookie BEFORE spending the single-use `pstk_` link, so the
  `cookies_blocked` fallback opens a link that still works. Dashboard: Settings → Checkout → "Embed
  on your website" edits the list (saved with the page) and shows the snippet; the usage widget
  card links to it. Docs: recipe "Embed checkout and the portal".
- **2026-11-26** — Phase 2a: the loader (`/js/v1/embed.js`, SRI hash in the settings response) and the
  embedded checkout. The frame posts `loaded`, `resize`, `step`, `success`, `close`, `error` to the
  session's `embed_origin` only (`dashboard/components/embed-bridge.tsx`); the buyer view carries
  `embed_origin`. In a frame: no same-tab redirect after success, provider pages (PayPal, bank
  redirects, form posts) open in a new tab with the Continue panel, a frame with no session cookie
  reports `cookies_blocked` and the loader offers the link in a new tab. The loader draws the close
  button, sizes the overlay to the visible viewport (a full-screen sheet below 600px) and locks the
  page's scroll while open.
- **2026-11-26** — Created (embedded checkout and portal, Phase 1): `embed_origins` absorbs the usage
  widget's list, `embed_origin` on checkout and portal sessions, the frame-ancestor lookup.
  Gate: `verify:embedding`, `verify:security` §C3.
