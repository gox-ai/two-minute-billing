# tenancy — organizations, businesses, API keys

> Source: `src/modules/tenancy/` · Routes: `src/api/routes.ts` (business/org/api-key endpoints) · Schema: `db/schema/tenancy.ts`
> Layer: foundation (see docs/architecture/architecture.json)

## Purpose
Owns the top of the account hierarchy: **Organization → Business**. An Organization is the tmbilling
account and the hard RLS isolation boundary (`organization_id`); it holds API keys and has many
independent Businesses (each with its own catalog, currency set, gateways, settings, invoice
numbering, and test/live mode). This module is the tenant substrate every other module scopes to.

## Responsibilities
- Create/update organizations and businesses; resolve a business by public id.
- Mint, list, and revoke API keys (`test` / `live` / `all` partitions; `api` / `system` kinds).
- Authenticate an API key → resolve its organization + livemode + kind for `platform/auth`.
- Hold per-business config: `default_currency`, enabled `currencies`, `exchange_rates` (reporting FX),
  invoice/credit-note numbering, dunning config, billing-rule defaults, `default_gateway_account_id`.

## Data model
`db/schema/tenancy.ts` — `organizations`, `businesses`, `api_keys`. Businesses carry `livemode`
(`live`/`test`, immutable) and, on a test row, `live_business_id` — its live twin (0342), `defaultCurrency`, `currencies` (jsonb), `exchangeRates` (jsonb),
invoice/CN prefixes + `bigint` next-number counters, dunning config, and billing-rule default
columns. API keys are stored **hashed** (HMAC-SHA256); the raw secret is shown once at creation, and
carry a `kind`: `api` (the org's integration keys) or `system` (the credential our own dashboard
authenticates with — see Invariants).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `createOrganization` / `updateOrganization` | org lifecycle |
| `createBusiness` / `updateBusiness` | business lifecycle (creates the live row AND its test twin) + settings patch (with `expectedVersion` OCC) |
| `ensureTestTwin` | the test twin of a live business, created on first use (idempotent) |
| `enableLiveAccess` / `setOrganizationStatus` / `accountStateOf` | the live-mode lock, read-only status + reason and the over-limit notice (0354, 0356), set by account billing (back-office) |
| `businessPairs` | live ↔ test public ids per business, for serialization |
| `getBusinessByPublicId` / `listBusinesses` | resolve/enumerate businesses (mode-scoped) |
| `createApiKey` / `listApiKeys` / `revokeApiKey` | API-key management (create takes an optional expiry) |
| `rotateApiKey` | new key with the same name/mode/scope; the old key expires after an overlap (0374) |
| `markApiKeyUsed` / `writeApiKeyLastUsed` | throttled, fire-and-forget `last_used_at` write from the auth path |
| `authenticateApiKey` | hash + look up a key → organization + livemode (revoked or expired → null) |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/businesses` · `GET /v1/businesses/:biz` | list / fetch businesses |
| `PATCH /v1/businesses/:biz` | update business settings (409 on version mismatch) |
| `POST /v1/businesses/:biz/test_mode` | the business's test twin, created on first call |
| (org + API-key endpoints) | via `routes.ts` / auth flows |

## Events emitted
None (audit-logged instead).

## Dependencies
- **Upstream (calls into):** audit, gateway.
- **Downstream (called by):** auth (and implicitly every module via `withTenant`/`resolveBusiness`).

## Invariants & gotchas
- `organization_id` is the RLS boundary; `business_id` is the sub-scope every query filters on.
- `livemode` is immutable after creation; API-key partition is enforced centrally in `platform/auth`
  (cross-mode `:biz` access → 404).
- **A locked organization cannot change its live businesses** (0354). `organizations.live_access` is
  `locked` / `enabled`; `locked` makes `authenticate` refuse every non-read request whose `:biz` is a
  live business (403 `live_access_required`). Every business-scoped write carries `:biz`, so the one
  check covers routes nobody annotated. A test→live transfer still works (its `:biz` is the test
  source). Since 0356 nothing locks automatically: a Cloud sign-up (SIGNUP_SANDBOX) starts `enabled`
  with `live_access_enabled_by = 'plan:free'`, and `locked` is a staff tool.
- **Read-only has a reason** (0356). `status = 'restricted'` refuses every write (403
  `account_restricted`); `restricted_reason` says why — `unpaid` or `over_limit` — and the message
  says it too. `setOrganizationStatus(org, 'restricted', reason)` requires one. `over_limit_since`
  is account billing's notice (this month's volume above the plan's limit); it restricts nothing.
- **Every live business has a test mode: a second business row (the twin).** The DB enforces the
  shape (0342): one twin per live business (unique index), the parent must be live (composite FK on
  `(live_business_id, 'live')`), only a test row names a parent (CHECK), and deleting the live row
  deletes its twin. A twin starts as a copy of the live settings — minus numbering (restarts at 1),
  gateways (it gets the TM Test Gateway) and the default gateway — and is independent after that;
  Transfer moves configuration between them. Test businesses with a null `live_business_id` are
  legacy standalone ones from before 0342.
- `businesses.resourceVersion` and the invoice/CN next-number counters are Drizzle `bigint` — BigInt
  can't be `JSON.stringify`'d, so audit diffs must convert them to `number` (past 500 bug).
- **An org's bootstrap key is `kind='dashboard'`, and that is not an API key.** It is what the
  dashboard authenticates with, so `platform/auth` records its requests as `source='dashboard'`
  attributed to the **signed-in operator** — not as API traffic by `key_…`. `listApiKeys` filters it
  out and `revokeApiKey` refuses it (route → 404) — the two must agree, since a credential you cannot
  see must not be revocable by id, and revoking it would lock the dashboard out of the org. `POST
  /v1/api_keys` only ever mints `kind='api'`: a caller who could mint a dashboard credential could
  file its own writes as a person's. To re-point a dashboard at a reset DB,
  `scripts/create-api-key.ts --dashboard` (defaults to the `all` partition).
- **The credential says WHICH ORG; the forwarded session says WHICH PERSON.** `dashboard/lib/api.ts`
  sends the operator's `tmb_session` alongside the key on every call; `authenticate` resolves it and
  **checks it belongs to the key's organization** before believing it, so a session leaked from org B
  can never sign an action against org A. A mismatched or absent session is not an auth failure (the
  key already authorised the org) — the actor just falls back to the literal `dashboard`, which says
  "from our UI, person unknown". Never a placeholder human, never the key id.

## Changelog

- **2026-11-04 (0499)** — A business always has a default currency: `businesses.default_currency` is NOT NULL (NULLs backfilled to USD; production had none), `createBusiness` requires it, and `POST /v1/businesses` refuses a request without `default_currency`.

- **2026-11-03** — `businesses.invoice_rules_config` (0486, `PATCH invoice_rules_config`, keys
  merged, null clears). No recommended value for new businesses.

- **2026-11-02** — `businesses.card_payment_limits` (0482, `PATCH card_payment_limits`, null clears)
  and `createBusiness({ invoiceCustomization })`: POST /v1/businesses by a person starts with
  `initialDocumentConfig` (exchange rate on documents); a key keeps the defaults.
- **2026-10-25** — `businesses.receipt_prefix` (default RCPT) and `receipt_next_number` (0387); the prefix is settable on `PATCH business`, the counter is not (batch-numbered). A test twin restarts receipt numbering at 1.
- **2026-10-24** — **API-key hygiene** (migration `0374`). `api_keys.expires_at` (nullable, null =
  never): `authenticateApiKey` refuses an expired key with the same 401 as a revoked one, and
  `POST /v1/api_keys` takes an optional `expires_at`. `POST /v1/api_keys/:id/rotate` (Idempotency-Key,
  secret not stored, 2FA gate as on create) mints a key with the same name/mode/scope and sets the old
  key's expiry to `LEAST(existing, now + overlap_seconds)` (default 86400, range 0–604800). Only
  `kind='api'` keys rotate; the dashboard credential answers 404 like revoke. `last_used_at` is now
  written (B12): `markApiKeyUsed` runs from `platform/auth`, never awaited, at most once per key per
  5 minutes per process (in-process throttle) and across processes (conditional UPDATE). Audit rows
  (B13): `api_key.create`, `api_key.revoke` (first revoke only), `api_key.rotate` — prefix, never the
  secret or hash. `revokeApiKey` now writes through `withTenant` so its audit row is atomic.
  Suite: `verify:api-keys`.

- **2026-10-22** — **Free plan with live billing** (migration `0356`). `restricted_reason`
  (`unpaid` | `over_limit`) and `over_limit_since` on `organizations`; existing read-only rows get
  `unpaid`, and every `locked` organization moves to the Free plan (`enabled`, `plan:free`).
  Cloud sign-ups start `enabled` on `plan:free` (`signupOnFreePlan`, still SIGNUP_SANDBOX).
  `authenticate` names the reason in the `account_restricted` message; `live_access_required` now
  says to contact us. `/auth/me` adds `organization_restricted_reason` and `organization_over_limit`.

- **2026-09-25** — **Reporting calendar** (migration `0293`): `week_start` (`sunday`|`monday`,
  default `sunday`) and `fiscal_year_start_month` (1–12, default 1) on `businesses`, on GET/PATCH
  `/v1/businesses/:biz` and the Business profile screen. Never a billing input. A real change
  enqueues `metric_daily_recompute` with the affected coarse `grains`; re-saving the same value
  enqueues nothing.

- **2026-09-09** — ✅ **An API key can be NAMED** (migration `0248`). A key was identified only by
  its `prefix` and a `key_…` id, which answer "which credential is this" only if you already know.
  The question actually asked — of an audit trail, or when deciding whether revoking something will
  break production — is "what uses it", and nothing in the row said.
  · **Nullable, not unique, no backfill.** Existing keys were never named and inventing one ("Key 1",
  the prefix again) asserts something nobody said, so the screen renders an em dash. Not unique
  because two keys legitimately share a name while one is rotated out — a uniqueness error at mint
  time would block exactly that rotation.
  · **Blank is not a name.** The route trims and maps `""` → `null`; an operator who left the box
  empty gets an unnamed key, not a key named the empty string. Bounded at `LIMITS.name` (255) with a
  400 rather than a silent truncation: a key nobody can recognise is the problem the field exists to
  fix.
  · `createApiKey`'s `name` parameter is **trailing and optional**, so the seed, the importer and ten
  verify scripts keep working unchanged. The dashboard credential minted at organization creation is
  a different call site and stays unnamed.
  · ⚠️ **`scope` had never been in the OpenAPI spec** — the route has always accepted it and the
  serializer has always emitted it. Added alongside `name`; `openapi:coverage` reports "no field
  drift" because it compares routes to the spec, not the spec to the serializer.
  · **Gates:** engine `tsc` 0 · dashboard `tsc` 0 · `verify:ui` 5/5 at 0 · `verify:form-validation`
  PASS (§A holds `LIMITS.name` identical across both files) · `openapi:coverage` 271/271 ·
  `verify:sdk` PASS · unit 1415/1416 with the one failure a pre-existing timeout flake in
  `provider-customer-sync`, which passes alone. Minted a named and an unnamed key through the real
  form over CDP and deleted both.

- **2026-09-06** — ✅ **#100: the organization can issue the invoice.** It had no identity to
  offer — name, status, timezone and nothing else — so 0235 adds `legal_name`, `address` and
  `tax_registration_number`, mirroring the business columns and reusing the same jsonb address
  shape. `legal_name` is separate from `name`: the account is "GoX", the entity on a tax
  document is "GoX Technologies Pvt. Ltd."; null falls back. The switch is
  `businesses.invoice_issuer` (default 'business' = the old behaviour), on the business because
  one account can hold a business trading in its own name beside one billing under the parent.
  It moves the seller's name, address and tax id only — brand, contact and timezone stay with
  the business. An empty entity falls back to the business and logs it; a setting must not be
  able to produce a tax document with no seller. The request's org projection carries the new
  fields too, because `/v1/me` serializes that row and a field missing there reads as "not set"
  whatever was saved.
- **2026-09-04** — ✅ **#37: a rate-source change wrote NO audit row.** `setCurrencyRateSource` and
  `removeCurrency` UPDATEd `businesses` directly instead of going through the audited settings patch,
  so `audit_logs` held nothing for either — verified at the service and at the route. "Who switched
  INR to auto, and when" was unanswerable, on the field that decides what every conversion uses. No
  money moves wrongly, which is why it was an accountability gap rather than a money defect.
  - Both writers now write one audit row **inside the caller's transaction** (`writeAuditLog(input,
    tx)`): `business.set_currency_rate_source` and `business.remove_currency`, `resource_type`
    `business`, `resource_id` the business **public** id — the vocabulary `business.settings_update`
    already uses. Actor and source come from the ambient EventContext; neither is invented here.
  - `before`/`after` are a **changed-fields diff** keyed as the column stores them (`source`, `rate`,
    `updated_at`, `provider`, `last_error`, plus `currencies` when enabling/removing moves the list).
    `currency` rides on both sides although it never changes: `resource_id` is the BUSINESS, so
    without it the row would read "source: manual → auto" of nothing.
  - ⚠️ **An `auto` switch whose inline fetch FAILED records the source change and no `rate` key at
    all.** That case is still a 200 — the currency is auto, the previous rate stands, `last_error`
    says why — so repeating the unchanged number on both sides would imply a rate moved when it did
    not. Absence is the diff's way of saying "unchanged", and it is asserted, along with the
    same-transaction guarantee (`xmin` of the audit row equals `xmin` of the `businesses` row), in
    `pnpm verify:audit`.
  - **`refreshAutoExchangeRates` is deliberately NOT audited.** The daily pass never changes a
    currency's `source` — the accountability question #37 is about — it only moves rates and
    `last_error` on currencies an operator already set to `auto`, and that provenance is already on
    the rate row itself (`updated_at`, `provider`, `last_error`). Auditing it would add one row per
    business per day, actored `system`, describing a decision nobody made.
- **2026-09-02** — **Exchange rates can maintain themselves (0229), and each one now says where it
  came from.** `businesses.exchange_rate_sources` holds per-currency provenance —
  `{source: 'manual'|'auto', updated_at, provider, last_error}` — beside the existing
  `exchange_rates` map rather than reshaping it, so metrics, the importer and `serializeBusiness`
  keep reading what they already read. A currency absent from the map is `manual`, which is what
  every pre-0229 rate is.
  - `exchange-rates.ts`: `currencyRateStates` (resolved rows for the API/screen),
    `setCurrencyRateSource` (one currency, manual-with-rate or auto — auto fetches INLINE so the
    dialog can show the rate it just set), `removeCurrency` (drops the currency AND its rate, both
    halves or neither), `refreshAutoExchangeRates` (the daily pass).
  - The daily pass is CROSS-ORG, so it uses the base `db` handle — the "admin operation that spans
    organizations" case `platform/db.ts` documents — and fetches ONCE PER DISTINCT BASE currency,
    not per business: rates are not tenant-specific, so a hundred USD-base businesses cost one call.
  - **`updated_at` is the provider's PUBLICATION day, not our fetch time.** The ECB publishes on
    weekdays, so a Sunday refresh legitimately holds Friday's rate; a screen reporting the fetch
    time would be describing our request rather than the rate.
  - **A failed refresh leaves the previous rate standing** and records `last_error` on that
    currency. An absent rate breaks the reporting roll-up outright, where a stale one is an
    inaccuracy the screen can label — so the failure is stored rather than allowed to be invisible.
  - Still reporting + the 0228 invoice snapshot only. Nothing in the billing path reads these, and
    nothing may: a fetched number that could move a customer's bill would put a third-party feed
    inside an invoice.

- **2026-08-30** — **`organizations.timezone` (migration 0216): a display zone for org-scoped screens.**
  `/ops`, `/audit` and `/developer` span every business in the account, so no business zone applies and
  every timestamp on them rendered in UTC — for an operator in India, midnight local read as 18:30 the
  *previous day*. The column deliberately mirrors `businesses.timezone` (nullable `text`, no default, no
  CHECK): NULL means UTC, so the migration changes nothing for an org that never sets one.
  **It is not a billing input.** Term boundaries, whole-day proration and calendar analytics all key off
  the BUSINESS zone, because an organization spans many businesses and one zone cannot anchor their
  billing days. Validation reuses the existing `src/platform/timezones.ts` (`normalizeTimezone`), so a
  fixed offset (`+05:30`) and a bare abbreviation are both rejected with 400, and legacy spellings are
  rewritten (`Asia/Calcutta` → `Asia/Kolkata`) — only modern IANA names are ever stored.
  ⚠️ `timezone` had to be added to `updateOrgBody` as well as the service and the route: **zod strips
  unknown keys silently**, so omitting it would have made the setting save, redirect, show a success
  banner and store nothing.
- **2026-08-06** — **`kind='system'` → `kind='dashboard'`, and the actor is now the PERSON (migration
  0151).** 0150 (below) fixed the wrong half: it stopped calling the dashboard's credential an API key,
  but recorded its requests as `source='system'` / `actor='system'` — and `system` means "no human, no
  request", which an operator clicking Void plainly is not. Two changes:
  **(1) The word.** `api_keys.kind` is now `'api' | 'dashboard'`; 0151 renames the value in place (no
  key re-issued — `kind` is a label on the row, never part of the secret). `EventSource` keeps BOTH
  `dashboard` (a person in our UI) and `system` (seeds, verify runs, programmatic contexts); they are
  no longer interchangeable. `currentChannel()` maps the new source to `dashboard`, so a
  dashboard-created invoice no longer reads `system`.
  **(2) The actor.** `dashboard/lib/api.ts` now forwards the operator's `tmb_session` cookie on every
  call (`authHeaders`), and `authenticate` → `dashboardActor` resolves it to their email, **after
  checking the session's org matches the key's**. No session (or a foreign one) falls back to the
  literal `dashboard`. So an event/audit row finally answers "who did this" with a person, and
  `audit_logs.actor_ip` records where they acted from.
  Watch out for one trap this exposed: `lib/api.ts` is imported (type-only) by ~30 client components,
  so its new `next/headers` import broke the client build through the ONE chain that imported a runtime
  value — `payments-analytics-block.tsx` → `lib/api/analytics.ts` → `lib/api.ts`. Fixed by splitting
  the client-safe constants/types into `lib/api/analytics-shape.ts`. `pnpm typecheck` cannot see this;
  only rendering the app can.
- **2026-08-05** — **`api_keys.kind` (`api` | `system`, migration 0150): the dashboard's credential is
  no longer an "API key".** Every organization's bootstrap key was also the key the dashboard
  authenticated with, so every operator click was recorded as `source='api'`, `actor='key_…'` — visually
  identical to a third-party integration, attributed to a credential the Developer page simultaneously
  offered a Revoke button for. Now `createOrganization` mints it as the dashboard credential;
  `listApiKeys`/`revokeApiKey` exclude it; `POST /v1/api_keys` still only mints `kind='api'`. The
  migration backfills each org's oldest live key. It also made the audit log's "Via API key" segment
  mean only integration traffic, so a second segment was added beside it. Superseded in part by 0151
  above, which renamed the kind and replaced `actor='system'` with the operator.
- **2026-08-04** — **`createApiKey` writes through `withTenant`, not the base `db` handle**
  (`service.ts`). The base handle sits outside any tenant transaction, and "writes made through the
  base `db` handle are NOT tracked" is a documented blind spot of the idempotency side-effects tracker
  (`platform/db.ts`, § Known limits) — `withTenant` is what stamps the in-flight `idempotency_keys` row
  `side_effects`, atomically with the write. `POST /v1/api_keys` is an idempotency-keyed route minting a
  LIVE credential, so an untracked insert is the one shape that must not exist there: had any step after
  it ever thrown, the record would have been deleted as "clean" and the retry would have re-executed and
  minted a **second** credential. Nothing can throw between the insert and the send today — this makes
  that a property of the code rather than of the current line ordering. RLS permits the insert unchanged
  (`api_keys`' `org_isolation` policy checks `organization_id = current_setting('app.org_id')`, which
  `withTenant` sets; `tmbilling_app` holds INSERT). `createOrganization` deliberately keeps the base
  handle — it mints the org's first key in the same transaction that CREATES the org, so there is no
  tenant to scope to yet. `revokeApiKey`/`listApiKeys` still use the base handle; revoke is the same
  blind spot but is harmless (its `isNull(revoked_at)` guard makes a re-execution a no-op 404).
- **2026-07-16** — Business `billing_frequencies` setting ("Setup Billing Frequency"):
  a per-business allow-list of `{interval, count}` frequencies for prices. `updateBusiness` accepts it
  (validated/deduped via `normalizeBillingFrequencies`); `isFrequencyAllowed` is enforced in
  `catalog.createPrice`; `null`/empty = unrestricted. Surfaced in `PATCH/GET /v1/businesses/:biz` and
  the dashboard settings page. Cloned on import from the source catalog's distinct frequencies.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H). Includes
  `exchange_rates` reporting-FX column (migration 0111) and business-PATCH optimistic concurrency.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).

- **2026-09-01 · `businesses.credits_flexibility` (0219).** A jsonb settings object controlling
  whether refundable credits and excess payments AUTO-apply to invoices, per credit kind × invoice
  class, each slot `do not auto-apply` / `auto-apply` / `apply up to a limit`. Nullable with no
  column default: `resolveCreditsFlexibility` (`modules/customers/credits-flexibility.ts`) reads
  null/absent/malformed as auto-apply with no ceiling, which is exactly the behaviour every business
  had before the column existed. Same shape and same "only an explicit value opts out" discipline as
  `dunning_config`. Exposed on `PATCH /v1/businesses/:biz` and Settings → Billing LogIQ → Credits
  Flexibility.

- **2026-09-20 · account-level exchange rates, on the existing pass (0269).** `refreshAutoExchangeRates`
  now also maintains `organizations.exchange_rates` for every organization with a `base_currency`:
  the currencies its businesses bill in (each business's default plus its enabled list), quoted
  against the base, from the same provider on the same twice-daily cron — no second job, no second
  feed. 0269 adds `organizations.exchange_rate_sources` in the identical shape to the business
  column, so `manual` means the same thing at both levels and automation never overwrites a pin.
  Two rules the account map holds harder than the business one: the base is never stored (it
  converts at 1), and a currency the feed positively does not quote is REMOVED rather than left
  stale, because the converted total reads presence as truth and names what it excluded in
  `missing_rates`. A base whose FETCH failed is a different case — an outage says nothing about a
  currency, so the rate stands and `last_error` records why. Gate: `pnpm verify:org-fx`.
- **2026-09-30** — `GET /v1/businesses/:biz/currencies` and `GET …/currencies/:currency`: a read over the base currency, the enabled list and `currencyRateStates` (no new state).
- **2026-10-01 (0322)** — `organizations.icon_url`: the sidebar logo. `PATCH /v1/organization { icon_url }` (http(s), null clears), returned by `/v1/me`; uploaded via `POST /v1/organization/brand_images` (`icon` only). Gate: `pnpm verify:org-icon`.
- **2026-10-08 (0329)** — `organizations` gains `require_mfa`, `mfa_required_since`, `mfa_required_by` and
  `mfa_grace_days` (default 7) for "Require two-factor authentication". The rule, the gate and the routes
  live in the auth module (`src/modules/auth/org-two-factor.ts`); see its README.
- **2026-10-09 (0334)** — `businesses.portal_field_config` (jsonb, nullable) on the business PATCH/GET. GET returns it resolved plus `address_field_locks: {country, state_code}` from live tax regions. PATCH refuses `billing.country: hide` on either matrix and, while tax is set up, any non-`mandatory` country (or state_code under GST). Copied by transfer.
- **2026-10-16 (0342)** — Live and test mode per business. `createBusiness` inserts the live row and
  its test twin in one transaction (`livemode: 'test'` now returns the twin of a new live business);
  `ensureTestTwin` + `POST /v1/businesses/:biz/test_mode` create the twin for older live businesses;
  the business object gains `live_business_id` / `test_business_id`. Gated by `verify:testlive`.
- **2026-10-20 (0354)** — Sandbox lock: `organizations.live_access` (+ `_enabled_at`, `_enabled_by`),
  `country`, `signup_answers`; `createOrganization` takes them; `enableLiveAccess` (the org's plan
  starting, or the back-office Enterprise override), `setOrganizationStatus` and `accountStateOf` (`/auth/me`).
  `organizations.status` is now enforced: anything but `active` makes the organization READ-ONLY
  (`authenticate`, 403 `account_restricted`) — account billing sets `restricted` when its plan is unpaid. `live_access` is on the
  organization object. Gate: `pnpm verify:sandbox-signup`.
- **2026-10-22** — Cloud only: on `TMBILLING_EDITION=self_hosted` (the default) `live_access` and
  `status` are never enforced and the API reports them `enabled` / `active`, whatever the row
  holds (`platform/edition.ts`). The stored values and `accountStateOf` are unchanged.
  Gate: `pnpm verify:edition`.
- **2026-10-24** — `businesses.reminder_config` (0376) and `PATCH /v1/businesses/:biz`
  `reminder_config`: reminder lead days per kind. The route merges a partial patch with the
  stored lists and stamps `changed_at` per changed kind (`mergeReminderConfig`, at the
  business's wall clock); `updateBusiness` stores it as given.
- **2026-10-25** — `insertOrganization(tx, …)` and `insertApiKey(tx, …)` split out of
  `createOrganization` and `createApiKey` (unchanged for callers), so the self-host bootstrap
  creates an org, its owner and an operator-chosen API key (audited `api_key.create`) in one
  transaction.
- **2026-10-25 (0391)** — API keys take an optional per-resource `permissions` map
  (`{resource: "read"|"write"}`); NULL = by `scope`, as every existing key. `scope` follows the map.
  `updateApiKey` (name, map; audited `api_key.update`), rotation copies the map,
  `authenticateApiKey` returns it. `AuthContext.operator` carries the member's permission set.
- **2026-11-02** — Test-business limits (0406, `test-limits.ts`): at most N customers and N subscriptions per TEST business. Default 1,000 on Cloud, none on self-hosted; `TEST_BUSINESS_CUSTOMER_LIMIT` / `TEST_BUSINESS_SUBSCRIPTION_LIMIT` set it on any edition; `businesses.test_customer_limit` / `test_subscription_limit` are the staff override (null = default, 0 = no limit). Every row counts (archived customers, cancelled subscriptions); a soft-deleted subscription does not. `assertTestBusinessRoom` runs in the inserting transaction under a per-business advisory lock → 400 `test_business_limit_reached`. `GET /v1/businesses/:biz/test_limits` reports usage. `verify:test-limits`.
- **2026-11-02 (0481)** — `businesses.billing_rules_config` (jsonb). `createBusiness` takes `billingRulesConfig`; `POST /v1/businesses` from a signed-in person pins today's values (`initialBillingRulesConfig`), a key stores nothing. PATCH merges keys (`required_reasons` one level down); null resets. The read returns every key resolved.
- **2026-11-03 (0489)** — `businesses.team_alerts_config` (jsonb): `updateBusiness` takes `teamAlertsConfig` (null = all off). PATCH key `team_alerts_config` replaces the stored value; the read returns it resolved. Behaviour lives in `modules/team-alerts`.
- **2026-11-03 (0489)** — `businesses.tax_settings` (jsonb): `updateBusiness` takes `taxSettings` (the route
  merges with `mergeTaxSettings`). PATCH keys `tax_behavior_by_currency`, `seller_tax_ids`, `tax_rounding`.
- **2026-11-03 (0489, review)** — `insertTestTwin` does not copy `team_alerts_config`.
- **2026-11-05** — `accountStateOf` also returns `country` and `signupGateway` (from
  `signup_answers.gateway`), for the dashboard's first-run presets via `GET /auth/me`.
