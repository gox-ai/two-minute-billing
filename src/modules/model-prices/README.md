# model-prices — the AI model price list and your cost

> Source: `src/modules/model-prices/` · Routes: `src/api/model-price-routes.ts` (OpenAPI `src/api/openapi-model-prices.ts`) · Schema: `db/schema/model-prices.ts`, `reference_data_sources` (`db/schema/geo.ts`)
> Layer: billing (see docs/architecture/architecture.json)

## Purpose
Keeps a dated price list for AI models (model × price kind × unit × tier, USD) in our own table,
filled every hour from two feeds: genai-prices v2 (`data_slim.json`, MIT) for every price, and
LiteLLM's `model_prices_and_context_window.json` (MIT) for media prices only (images, video and
audio seconds, characters). Bills read only this table, so every billed price can be checked
afterwards. Also holds **your cost**: the provider prices an organization negotiated.

## Responsibilities
- Fetch, parse and diff the feeds; merge them into one plan; append dated rows; hold a suspicious run for staff (`sync.ts`).
- Read the media feed (`parse-media.ts`): fields, key-prefix tiers, provider map, alias names.
- Read numbers as source text and store cents per divisor as `numeric(38,12)` (`decimal.ts`, `parse.ts`).
- Map a feed key to kind, unit and divisor (`feedPriceKeyOf`): `_mtok` token / 1M, `_kcount` request / 1K, `_mchars` character / 1M, `_kpages` page / 1K, `_gpixels` pixel / 1B, `[<kind>_]audio_hours` audio_second / 3,600 (bare `audio_hours` is kind `audio`). Units and tiers: `units.ts`.
- Resolve a list price or a cost at an instant, with the row it came from (`resolve.ts`).
- Cost rows: create, end, delete before start; list, history and source state (`service.ts`).
- Price-change events per business and mail per organization (`notices.ts`).

## Data model
`model_price_models` and `model_prices` (0455): platform-global, read-only to the app role,
append-only. `model_cost_overrides` (0456) and `model_price_notices` (0459): organization rows, RLS.
Sync state is the `model_prices` row of `reference_data_sources` (`last_success_at`, `held_batch`:
the merged batch of both feeds) and the `model_prices_media` row (the media feed's own ETag,
`checked_at`, `check_error`, `last_success_at`). No migration: the sync upserts both rows.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `runModelPriceSync` (`sync.ts`) | the `model_prices_sync` cron: fetch, diff, apply or hold |
| `releaseHeldModelPrices` / `dropHeldModelPrices` | apply a held batch from that instant (the sync once it settles, or staff early) / drop it |
| `readModelPriceSource` | the sync state of both feeds (system connection) |
| `parseMediaFeed` / `canonicalMediaModels` (`parse-media.ts`) | the media feed in our shape; its ids named as the first feed names them |
| `planSync` | the pure diff and the hold rules |
| `loadModelPriceBook` → `ModelPriceBook` (`resolve.ts`) | rows for a window, resolved in memory: `listPrice`, `modelCost`, `ownCost`, `changeInstants` |
| `resolveListPrice` / `resolveModelCost` | one-shot forms for screens and projections |
| `createCostOverride` / `endCostOverride` / `deleteCostOverride` / `listCostOverrides` (`service.ts`) | your cost, with an audit row per change |
| `listModelPrices` / `getModelPrice` / `modelPriceHistory` / `modelPriceSourceInfo` | the list as an organization reads it |
| `recordModelPriceChanges` / `runModelPriceNotices` (`notices.ts`) | events in the sync transaction; the `model_price_notices` cron |

## API routes
| Method · Path | Permission |
|---|---|
| `GET /v1/organization/model_prices` (`provider`, `model`, `token_type` or `price_kind`, `unit`, `q`, `has_cost`, `used`, `as_of`, cursor) | `model_prices:view` |
| `GET /v1/organization/model_prices/:id` · `/history` · `/source` | `model_prices:view` |
| `GET /v1/organization/model_cost_overrides` (`model`, `provider`, kind, `unit`, `listed`, cursor) · `/:id` | `model_prices:view` |
| `POST /v1/organization/model_cost_overrides` · `POST …/:id/end` · `DELETE …/:id` | `model_prices:manage` |

## Events emitted
`model_prices_changed` — one per business per sync, when a meter mapped to the list used a changed
model in the last 35 days or a rate card names it. `changes[]` carry `bill_moves` and `cost_moves`.

## Dependencies
- **Upstream (calls into):** platform (egress, fixed, db), events, emails (deployment mailer), audit, metering (JSON source reader).
- **Downstream (called by):** metering rating (`model_price_list` amount source), metrics (margin), back-office alerts.

## Invariants & gotchas
- Never a float: numbers are JSON source text → Fixed12; more than 12 places in cents rounds half-up once and sets `rounded`.
- The fetch goes through `guardedFetch` (no private target, no redirect), 20 s, body capped at 5 MB, `If-None-Match`. The media feed: 60 s, 12 MB, its own ETag.
- **Two feeds, one plan.** Both are parsed and merged into one wanted state before the diff, so they never fight over a key. A media key (unit not `token`/`request`) both price takes the media feed's price, unless the two are within 1 % (`SAME_PRICE_PERCENT`: one price written two ways, $0.111 per hour vs 3.083e-05 per second): then it stays with the feed whose row is live. Token and request keys come only from genai-prices. Each row records `source` (`genai-prices` / `litellm`) and `source_version`.
- **One feed down.** A feed that fails (or is off) leaves every key it owns (source of the live row) as it is: never read as removed, never taken over. The other feed still applies. When only one feed changed (the other answers 304), the other is read again in full so the plan merges both. A held batch settles on a run where every feed read answers 304. A run where one feed failed replaces the held batch with its own diff: that feed's held rows are held again (new clock) on its next good run.
- **Cross-check.** A key both price more than 25 % apart (`CROSS_CHECK_MARGIN_PERCENT`) is held in the same `held_batch` with reason `sources_disagree`, both prices on the row (`crossCheck`); the rest of the run applies. It settles, releases and drops like any held batch. The share rule (25 % of known keys) counts per feed, by the key's owner, so one feed's new keys never dilute the other's.
- **Media fields.** `output_cost_per_image[_<size>]` (`_1K` → resolution `1k`), `input_cost_per_image`, `output_cost_per_second[_480p…_4k]` and `input_cost_per_second` (unit from `mode`: `video_generation` → `video_second`, `audio_transcription`/`audio_speech` → `audio_second`; any other mode skipped; input seconds are audio only), `{input,output}_cost_per_video_per_second`, `input_cost_per_character`. Divisor 1, USD per unit as JSON text (exponents exact). A 0 is skipped (usually "not known" there). Batch, priority, image-token and "above N" variants are ignored.
- **Key prefixes.** Only segments before the model count: `1024-x-1024` → resolution `1024x1024`; `standard`, `hd`, `low`, `medium`, `high`, `xhigh`, `max`, `auto` → quality; `50-steps` / `max-steps` → quality (they price differently, so they are kept). The provider segment is `litellm_provider` (`vertex_ai` also prefixes `vertex_ai-*`). `max-x-max`, two qualities or two sizes → skipped and counted. Two keys giving one price key different prices → both dropped.
- **Providers.** `MEDIA_PROVIDER_MAP` maps a `litellm_provider` to the first feed's id only for the same seller (bedrock → aws, xai → x-ai, gemini and vertex_ai* → google, azure_ai → azure, …); others keep their own id, lower-cased. A media id that is the first feed's alias under the same provider takes that model's name (`canonicalMediaModels`), so an alias lookup still finds the token prices. A media model never overwrites the first feed's aliases or tiers.
- **Provider with none named.** Resolves when one provider lists the model, or when exactly one has a row in a unit the key tries (any kind). So a model that gains image prices under azure and aws still resolves its tokens; an image price under several providers is `ambiguous_provider` (the meter names the provider). Kinds do not narrow it: that would pick one provider for a kind the feed lists for it alone.
- A change applies from the sync instant (or a future source date); the source date is kept in `source_effective_from`. Usage already recorded never reprices.
- Held when > 25 % of known keys change, a price goes to 0, or one moves more than ×10. A held batch writes nothing; a release applies from the release instant.
- The sync never reads or writes `model_cost_overrides`. A cost row starts and ends now or later; a started row is ended, never deleted; overlaps are SQLSTATE 23P01 → 409.
- The list is USD. Another currency resolves only from a row in that currency; a list price is never converted.
- Key = provider, model, kind (`token_type`), **unit**, **quality**, **resolution** ('' = no tier), currency, `effective_from`. The API also returns `token_type` as `price_kind` and accepts either.
- Unit lookup: a key that names a unit matches only it; a key with none tries `token`, then `request` (the list before 0524), so an old meter mapped to `web_searches` still resolves.
- Tier lookup: exact (quality, resolution); else same quality, no resolution; else same resolution, no quality; else no tier. The first with a row live at the instant wins, for the list and for your cost. The feed has no tiers; your cost rows can.
- A feed that only gains keys never holds (`many_keys_changed` counts changed KNOWN keys) and sends no notice (a new key has no old price). A held batch from before 0524 has no unit: it reads as `request` at divisor 1,000, else `token`.
- `MODEL_PRICES_SOURCE_URL` and `MODEL_PRICES_MEDIA_SOURCE_URL` (mirrors; the media one takes `off`), `MODEL_PRICES_SYNC=off` (both, air-gapped).
- `db:reset` keeps `model_prices` and `model_price_models` (reference data); the source row resets.

## Changelog
- **2026-11-01** — Created (Tier 3 PR 1b): sync with hold and staff release, your cost, resolvers, price-change events and mail. Back-office alerts `model_prices_stale`, `model_prices_held`. Cover: `verify:model-prices`, `test/unit/model-prices.test.ts`, `verify:ops-alerts`.
- **2026-11-01** — Log fields `err` → `error` in the notice sender and the source fetch (`verify:logging`).
- **2026-11-03** — Sync hourly (`10 * * * *`). A held batch settles on its own: it applies once the source has listed the same suspect prices for `SETTLE_MS` (6 h; `suspectFingerprint`), `released_by = settled`; a corrected slip never applies. A failed check no longer moves `checked_at`. A held row records `oldDivisor`. Cover: `verify:model-prices` T7, unit `model-prices.test.ts`, `verify:ops-alerts`.
- **2026-11-04 (0498)** — Price notices go to accepted members only; a pending invite gets none.
- **2026-11-09 (feat/ai-spend-embeddings)** — `tokensCostFixed12` (`resolve.ts`, pure): tokens at
  a resolved price, truncated. Used by the assistant's usage record and the docs embedding record
  (which prices `text-embedding-3-small` from this list). Cover: `test/unit/embedding-cost.test.ts`.
- **2026-11-13 (feat/media-prices, 0524)** — Media prices. `model_prices` and `model_cost_overrides` gain `unit` (closed set, CHECK), `quality`, `resolution`; the key, lookup indexes and the cost overlap constraint include them. Backfill: rows at divisor 1,000 (the only `_kcount` divisor the sync wrote) → `request`; cost rows stay `token`. The parser keeps audio hours, characters, pages and pixels (`feedPriceKeyOf`); a media-only model is a list model. Sync, held rows, notices (`unit` on each change; email "per hour of audio"), resolver (unit and tier order above) and service carry the unit and tier. API: `unit`, `quality`, `resolution`, `price_kind` on rows and cost create; `unit` filter. Cover: `verify:model-prices` T10, `verify:model-price-billing` T16, `test/unit/model-prices.test.ts`.
- **2026-11-13 (feat/media-prices, review)** — `GET /v1/organization/model_cost_overrides?listed=false` returns the cost rows whose key (model or alias, kind, unit, tier, provider) has no list row now, so the list read cannot show them; `listed=true` the others. The dashboard lists them in "Your costs with no list price", and the history sheet ends a started cost row of any tier. A cost row's quality and resolution are trimmed and lower-cased before the pattern check (`normalizeTier`), in the route and in `createCostOverride`. Cover: `verify:model-prices` T10, `test/unit/model-price-form-helpers.test.ts`.
- **2026-11-13 (feat/media-prices-second-source)** — Second feed for media prices (`parse-media.ts`, `MODEL_PRICES_MEDIA_SOURCE_URL`, state row `model_prices_media`): one merged plan, per-feed failure isolation, cross-check hold `sources_disagree`, per-feed share rule, alias naming. Resolver: with no provider, only providers with a row in a unit the key tries count. API: `source` on rows names the feed; `GET …/model_prices/source` gains `sources[]`. Back office: stale alert per feed; held table shows source and the other feed's price. Cover: `test/unit/model-prices.test.ts`, `verify:model-prices` T11, `verify:model-price-billing` T17, `verify:ops-alerts`.
- **2026-11-13** — Staff release of a held batch moves the media source's `last_success_at` too when the batch has media rows (`verify:model-prices` T11). Both licence strings read "MIT License, Copyright (c) …". Dashboard: tier values render through `TierText` (code font, contextual alternates off), the Model cell shortens, the history shows each list row's tier and a short source version, and "ended" is decided per data load. Back office: singular per-unit words, the version of each held source.
- **2026-11-13 (fix/model-price-first-sync)** — A new key with several past-dated prices stored
  the EARLIEST one as current: every past date applies from the sync instant, so the rows collided
  on the key and `on conflict do nothing` kept the first. `planSync` now writes, for a new key, the
  undated price, the one past entry in effect today, and the future entries. A key stored the old
  way corrects itself on the next changed feed (a normal price change from "now"). Cover:
  `test/unit/model-prices.test.ts`.
- **2026-11-13** — `GET model_cost_overrides` takes `q` (text in the model or provider id), so a paged cost card can follow the price list's search. The history read matches your cost rows as the list does: the model or one of its aliases (of the named provider), and `unit=request` includes `token` costs. Dashboard: each source line shows "Updated" (`last_success_at`) beside "Checked" when they differ; "Set your cost" keeps the tier fields of the row it opened from and scrolls inside the dialog; the cost card pages by cursor (50) and follows the list's search and provider and unit filters. Cover: `verify:model-prices` T10, unit `model-price-form-helpers.test.ts`.
- **2026-11-13** — Dashboard layout only (no engine change): the price list fits its card at 1440 and 1280 with media prices. "per …" is a muted part of each price and wraps under the amount past 160px (`listPriceParts`), the tier is a second line of Price type, and the Starts column is a line under List price (the zone is in its tooltip, as for the Ends line). The card of costs with no list price shows the tier in full and puts its row menu at the top right of a stacked row. Back office: provider under the model and source under the held price, so the held table is at most 1078px wide. Cover: `test/unit/model-price-form-helpers.test.ts`.

## Third-party data
- genai-prices: MIT License, Copyright (c) Pydantic Services Inc. 2025 to present.
- LiteLLM (`model_prices_and_context_window.json`; its `enterprise/` folder is not used): MIT License, Copyright (c) 2023 Berri AI.
The test fixtures keep each notice beside them (`test/unit/fixtures/*.NOTICE`).
