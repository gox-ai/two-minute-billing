# model-prices — the AI model price list and your cost

> Source: `src/modules/model-prices/` · Routes: `src/api/model-price-routes.ts` (OpenAPI `src/api/openapi-model-prices.ts`) · Schema: `db/schema/model-prices.ts`, `reference_data_sources` (`db/schema/geo.ts`)
> Layer: billing (see docs/architecture/architecture.json)

## Purpose
Keeps a dated price list for AI models (model × token type, USD) in our own table, filled every
hour from genai-prices v2 (`data_slim.json`, MIT). Bills read only this table, so every billed price
can be checked afterwards. Also holds **your cost**: the provider prices an organization negotiated.

## Responsibilities
- Fetch, parse and diff the feed; append dated rows; hold a suspicious run for staff (`sync.ts`).
- Read numbers as source text and store cents per divisor as `numeric(38,12)` (`decimal.ts`, `parse.ts`).
- Resolve a list price or a cost at an instant, with the row it came from (`resolve.ts`).
- Cost rows: create, end, delete before start; list, history and source state (`service.ts`).
- Price-change events per business and mail per organization (`notices.ts`).

## Data model
`model_price_models` and `model_prices` (0455): platform-global, read-only to the app role,
append-only. `model_cost_overrides` (0456) and `model_price_notices` (0459): organization rows, RLS.
Sync state is the `model_prices` row of `reference_data_sources` (`last_success_at`, `held_batch`).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `runModelPriceSync` (`sync.ts`) | the `model_prices_sync` cron: fetch, diff, apply or hold |
| `releaseHeldModelPrices` / `dropHeldModelPrices` | apply a held batch from that instant (the sync once it settles, or staff early) / drop it |
| `readModelPriceSource` | the sync state (system connection) |
| `planSync` | the pure diff and the hold rules |
| `loadModelPriceBook` → `ModelPriceBook` (`resolve.ts`) | rows for a window, resolved in memory: `listPrice`, `modelCost`, `ownCost`, `changeInstants` |
| `resolveListPrice` / `resolveModelCost` | one-shot forms for screens and projections |
| `createCostOverride` / `endCostOverride` / `deleteCostOverride` / `listCostOverrides` (`service.ts`) | your cost, with an audit row per change |
| `listModelPrices` / `getModelPrice` / `modelPriceHistory` / `modelPriceSourceInfo` | the list as an organization reads it |
| `recordModelPriceChanges` / `runModelPriceNotices` (`notices.ts`) | events in the sync transaction; the `model_price_notices` cron |

## API routes
| Method · Path | Permission |
|---|---|
| `GET /v1/organization/model_prices` (`provider`, `model`, `token_type`, `q`, `has_cost`, `used`, `as_of`, cursor) | `model_prices:view` |
| `GET /v1/organization/model_prices/:id` · `/history` · `/source` | `model_prices:view` |
| `GET /v1/organization/model_cost_overrides` · `/:id` | `model_prices:view` |
| `POST /v1/organization/model_cost_overrides` · `POST …/:id/end` · `DELETE …/:id` | `model_prices:manage` |

## Events emitted
`model_prices_changed` — one per business per sync, when a meter mapped to the list used a changed
model in the last 35 days or a rate card names it. `changes[]` carry `bill_moves` and `cost_moves`.

## Dependencies
- **Upstream (calls into):** platform (egress, fixed, db), events, emails (deployment mailer), audit, metering (JSON source reader).
- **Downstream (called by):** metering rating (`model_price_list` amount source), metrics (margin), back-office alerts.

## Invariants & gotchas
- Never a float: numbers are JSON source text → Fixed12; more than 12 places in cents rounds half-up once and sets `rounded`.
- The fetch goes through `guardedFetch` (no private target, no redirect), 20 s, body capped at 5 MB, `If-None-Match`.
- A change applies from the sync instant (or a future source date); the source date is kept in `source_effective_from`. Usage already recorded never reprices.
- Held when > 25 % of known keys change, a price goes to 0, or one moves more than ×10. A held batch writes nothing; a release applies from the release instant.
- The sync never reads or writes `model_cost_overrides`. A cost row starts and ends now or later; a started row is ended, never deleted; overlaps are SQLSTATE 23P01 → 409.
- The list is USD. Another currency resolves only from a row in that currency; a list price is never converted.
- `MODEL_PRICES_SOURCE_URL` (a mirror) and `MODEL_PRICES_SYNC=off` (air-gapped).
- `db:reset` keeps `model_prices` and `model_price_models` (reference data); the source row resets.

## Changelog
- **2026-11-01** — Created (Tier 3 PR 1b): sync with hold and staff release, your cost, resolvers, price-change events and mail. Back-office alerts `model_prices_stale`, `model_prices_held`. Cover: `verify:model-prices`, `test/unit/model-prices.test.ts`, `verify:ops-alerts`.
- **2026-11-01** — Log fields `err` → `error` in the notice sender and the source fetch (`verify:logging`).
- **2026-11-03** — Sync hourly (`10 * * * *`). A held batch settles on its own: it applies once the source has listed the same suspect prices for `SETTLE_MS` (6 h; `suspectFingerprint`), `released_by = settled`; a corrected slip never applies. A failed check no longer moves `checked_at`. A held row records `oldDivisor`. Cover: `verify:model-prices` T7, unit `model-prices.test.ts`, `verify:ops-alerts`.
- **2026-11-04 (0498)** — Price notices go to accepted members only; a pending invite gets none.
