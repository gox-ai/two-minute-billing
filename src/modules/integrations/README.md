# integrations — connect a business to other tools

> Source: `src/modules/integrations/` · Routes: `src/api/integration-routes.ts` · Schema: `db/schema/integrations.ts`
> Layer: foundation (see docs/architecture/architecture.json)

## Purpose
One place every integration plugs into: a catalogue the dashboard renders, one event sink, and
one business-level API. An integration is one of two kinds. A **push** integration turns a
billing event into one partner API call (FirstPromoter). A **sync** integration runs its own
two-way engine over its own tables (HubSpot, `modules/hubspot`).

## Responsibilities
- The catalogue (`catalogue.ts`, no runtime imports) and the runtime registry (`registry.ts`); the
  registry throws at load if the two name different sets.
- The event sink (`sink.ts`): for every business event, each sync integration's `onEvent`, then a
  delivery row per active, enabled push connection whose integration maps the event type.
- Push connections (`connections.ts`): connect, change (enable, credentials, settings), disconnect.
- The push outbox (`outbox.ts`): fan-out in the emit transaction, drain (`integration_outbox_nudge`,
  queue `egress_integration`), synchronous Resend, requeue failed, the delivery log.

## Adding an integration
- **Push:** `providers/<key>-info.ts` (the descriptor: credentials, settings, event types, base URL,
  prerequisite) + `providers/<key>.ts` (`build`, `judge`), then one entry in `catalogue.ts` and
  `registry.ts`. The connect form, the detail page, the API and the delivery log need no change.
- **Sync:** its own module and tables, a `SyncIntegration` adapter (`onEvent`, `status`) registered
  in `registry.ts`, a catalogue entry with `connect.method: "oauth"`, and its own routes and page.

## Data model
- `integration_connections` — one row per (business, provider). `status` active | disconnected,
  `enabled` (paused when false), `credentials_enc` (write-only, cleared on disconnect),
  `config`, `api_base` (the partner URL this row calls), `livemode` copied from the business.
- `integration_deliveries` — one per (event, connection) attempt cycle: pending | delivered |
  failed | skipped | superseded, attempts, backoff, last status, last error.

## Public surface
| Function | What it does |
|---|---|
| `listIntegrations()` | the static catalogue |
| `pushIntegration(key)` / `syncIntegration(key)` | runtime lookups |
| `dispatchIntegrations(tx, event)` | the event sink |
| `connectIntegration` / `updateIntegration` / `disconnectIntegration` | push connection lifecycle |
| `deliverPendingIntegrations(now)` | drain due deliveries |
| `redeliverIntegrationDelivery` / `requeueFailedIntegrationDeliveries` | Resend one / requeue failed |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/integrations` | catalogue |
| `GET /v1/businesses/:biz/integrations` | every integration with this business's status |
| `GET·PATCH·DELETE /v1/businesses/:biz/integrations/:key` | a push connection |
| `POST …/:key/connect` | connect with credentials and settings |
| `GET …/:key/deliveries` · `POST …/deliveries/:id/redeliver` · `POST …/redeliver_failed` | delivery log |

HubSpot's routes stay at `/v1/businesses/:biz/integrations/hubspot*`; static segments win over `:key`.

## Dependencies
- **Upstream:** events (sink), hubspot (adapter), platform (http-delivery, circuit-breaker, secrets, outbound).
- **Downstream:** api, worker.

## Invariants & gotchas
- Shared HTTP primitives live in `platform/http-delivery.ts`: six attempts, the backoff ladder, one
  bounded POST, error clipping. Each outbox owns its claim and how it settles a row.
- A `build` that throws settles the row `failed` (deterministic); `null` settles it `skipped` with
  no attempt counted. `judge` sees the request as well as the status: FirstPromoter's 404 means
  "not referred" on a sale and "bad visitor id" on a signup.
- Credentials are replaced wholesale; every declared key must be sent.
- ⚠️ A partner's API VERSION is not something a mapping test catches. FirstPromoter was first built
  for v1 (one `X-API-KEY`) and every live call came back 401: the account was on v2 (other base,
  `Authorization: Bearer` + `ACCOUNT-ID`). `verify:firstpromoter` pins the v2 headers by value and
  `test/unit/integrations.test.ts` pins the base URL.
- There is no test-send for a push integration: a partner call is built from the real record
  behind an event, and a sample has none. Resend runs the real attempt.
- Breaker key kind `integration`, per business and partner origin.
- Disconnect settles pending deliveries `skipped`; reconnect reuses the row, so history stays.

## Changelog
- **2026-10-29** — `icon.src` points at the official logo files in the dashboard's
  `public/logos/`; the dashboard renders them through `components/partner-logo.tsx`.
- **2026-10-28** — Merged into development: routes take catalogue permissions (reads
  `integrations:view`, writes and redelivers `integrations:manage`), and a delivery to a private or
  reserved address (`postOnce` → `guardedFetch`) is terminal and skips the breaker.
- **2026-10-28** — 0363 drops `legacy_endpoint_id`; the move out of webhooks is complete.
- **2026-10-28** — Deploy bridge removed (`handOverLegacyDelivery`); 0362 deleted the legacy
  partner webhook rows. 0363 drops the unread columns in a later release.
- **2026-10-27** — Module created. FirstPromoter moved out of `webhook_endpoints` (0361 copies the
  connection and its delivery history; a later migration drops the legacy columns). HubSpot joins
  the catalogue and the shared sink. Business-level API and dashboard directory.
