# src/ — the billing engine (modular monolith)

Fastify + TypeScript backend. Entry points: [index.ts](index.ts) (API server, port 4000) and
[worker.ts](worker.ts) (graphile-worker billing clock). Request flow:

```
HTTP → src/api/<domain>-routes.ts (zod validation, auth, idempotency)
     → src/modules/<domain>/service.ts (business logic, ledger postings)
     → db/schema/* via Drizzle (RLS-scoped by organization_id)
     → src/modules/events (outbox) → src/modules/webhooks (delivery)
```

## Layout

- **[api/](api/)** — one route file per domain (`*-routes.ts`) + `routes.ts` (registration),
  `openapi.ts`, `helpers.ts`. Routes stay thin; logic lives in modules. Request bodies and
  zod-parsed queries go through `strict-params.ts` `parseRequest` — unknown keys are a 400.
- **[modules/](modules/)** — 28 domain modules. **Each has a `README.md`** (purpose, data model,
  public surface, routes, invariants, changelog) — read it before touching a module, and append to
  its Changelog when you change it.
- **[platform/](platform/)** — cross-cutting kernel: db, RLS context, idempotency,
  **reply-guard** (`reply-guard.ts` — one send chain per reply; see the Platform changelog), money,
  job queue, crypto ids, and **logging + tracing** (`logger.ts` `createLogger(service)` +
  `trace.ts` one `traceId` per execution + `cloud-logging.ts` the Google Cloud Logging sink,
  off unless `CLOUD_LOGGING=TRUE` — see `docs/GUIDE.md` §4; `console.*` is not allowed
  outside `config.ts`).
- **[providers/](providers/)** — payment gateway adapters (`stripe/`, `razorpay/`, `paypal/`,
  `mock/`, `tmtest/`) behind `types.ts` + `registry.ts`. **Provider SDKs are imported only here** —
  the engine never touches them directly.

## Module index (by layer — graph in [docs/architecture/architecture.json](../docs/architecture/architecture.json))

**Foundation:** [tenancy](modules/tenancy/README.md) · [auth](modules/auth/README.md) · [ledger](modules/ledger/README.md) · [events](modules/events/README.md) · [webhooks](modules/webhooks/README.md) · [emails](modules/emails/README.md) · [hubspot](modules/hubspot/README.md) · [audit](modules/audit/README.md) · [comments](modules/comments/README.md) · [list-views](modules/list-views/README.md) · [ops](modules/ops/README.md) · [request-log](modules/request-log/README.md)
**Catalog & pricing:** [catalog](modules/catalog/README.md) · [coupons](modules/coupons/README.md) · [tax](modules/tax/README.md) · [entitlements](modules/entitlements/README.md)
**Customers & balances:** [customers](modules/customers/README.md) · [wallet](modules/wallet/README.md) · [credit-notes](modules/credit-notes/README.md) · [customer-portal](modules/customer-portal/README.md) · [checkout](modules/checkout/README.md) · [metadata-rules](modules/metadata-rules/README.md)
**Subscriptions & billing:** [subscriptions](modules/subscriptions/README.md) · [dunning-policies](modules/dunning-policies/README.md) · [invoicing](modules/invoicing/README.md) · [metering](modules/metering/README.md) · [model-prices](modules/model-prices/README.md) · [usage-controls](modules/usage-controls/README.md) · [metrics](modules/metrics/README.md) · [team-alerts](modules/team-alerts/README.md)
**Payments & gateway:** [gateway](modules/gateway/README.md) · [payment-methods](modules/payment-methods/README.md) · [payment-intents](modules/payment-intents/README.md) · [transactions](modules/transactions/README.md) · [payments](modules/payments/README.md) · [payment-requests](modules/payment-requests/README.md) · [receipts](modules/receipts/README.md) · [refunds](modules/refunds/README.md) · [disputes](modules/disputes/README.md)
**Ops tooling:** [migration](modules/migration/README.md) · [transfer](modules/transfer/README.md) · [time-travel](modules/time-travel/README.md) · [reason-codes](modules/reason-codes/README.md)

## Hard rules (see [docs/GUIDE.md](../docs/GUIDE.md) for the full list)

- Money = integer **minor units** + currency code. Never floats.
- The ledger is **append-only** — never UPDATE/DELETE a ledger row; post a compensating entry.
- Everything is tenant-scoped (RLS on `organization_id`, sub-scoped by `business_id`).
- Every API write takes an `Idempotency-Key`.
- The engine talks to gateways only through the adapter interface in `providers/types.ts`.
- **A route replies exactly once.** If a helper sends the reply and you exit early, either
  `return` that reply or `await` it — never `helper(reply); return`. On write routes the async
  `idempotencyOnSend` hook keeps the reply un-`sent` while it finalizes the record, and Fastify will
  start a *second* send for a handler that resolves with `undefined` in that window
  (`platform/reply-guard.ts` catches it and logs; don't rely on the net).

## Platform changelog

- **2026-10-25** — **Self-host.** `platform/selfhost/`: `schema.ts` installs a public database
  (graphile_worker, `db/baseline.sql` once, its `-- baseline-cut:` record, then newer migrations);
  `init.ts` is the Docker image's one-shot `init` (roles, schema, grants, geo, first org, under one
  advisory lock); `bootstrap-org.ts` creates the first org/owner/API key from env, idempotently;
  `schema-check.ts` makes the API and worker refuse to boot behind the schema when
  `TMBILLING_REQUIRE_SCHEMA=TRUE`. `config.ts`: the Google logging floor is Cloud-only; self-hosted
  production must STATE `CLOUD_LOGGING`. `object-store.ts`: any S3-compatible store via
  `OBJECT_STORE_ENDPOINT` / `_REGION` / `_FORCE_PATH_STYLE` (unset = R2, unchanged).
- **2026-10-24** — `platform/csv.ts` is the engine's one CSV writer: every field quoted, and text a spreadsheet would read as a formula (`= + - @`, tab, CR) prefixed with `'`. Numbers and plain decimals are never prefixed.
- **2026-10-22** — **One edition switch.** `platform/edition.ts` owns `TMBILLING_EDITION=cloud|self_hosted`
  (default `self_hosted`; any other value refuses to boot): `isCloud()`, `signupOffered()`,
  `signupSandbox()`, and `effectiveLiveAccess` / `effectiveOrganizationStatus`, which report
  `enabled` / `active` on self-hosted whatever the row holds. `authenticate` enforces the live lock
  and the read-only state only on Cloud; the API's boot line carries `edition` and warns about
  Cloud-only settings it ignores. Gate: `pnpm verify:edition` (mutation-checked).
- **2026-10-14** — **Error lines are redacted too.** `describeError` (logger) masks emails and
  Luhn-valid card numbers in an Error's message and stack, and in a string or object reported as
  the error — the same backstop `debug_info` already had. `log.error(err)` used to ship both raw.
- **2026-10-14** — **A 400 says what is wrong.** `badRequest`'s `message` is now the issue list
  (`address.phone: … ; email: …`, at most five, `details` unchanged) instead of the constant
  "Invalid request body", and the three routes in `routes.ts` that hand-built that constant go
  through it. A phone with a trunk 0 (`+4407700900123`) is refused with "Remove the 0 after +44".
  `/v1/countries` adds `phone_pattern` + `phone_lengths`, which the dashboard's `PhoneField` uses
  to drop a typed trunk 0 or repeated dial code before it posts (Italy keeps its 0).
- **2026-10-01** — `uploadBrandImage` takes an `owner` (`{ kind: "business" | "organization", publicId }`)
  instead of `businessId`. Business keys are unchanged (`business_assets/<biz>/…`); an organization's
  go under `organization_assets/<org>/…`.
- **2026-09-09** — Two new files for merchant brand images. `platform/image-upload.ts` is an
  image validator: the **leading bytes decide the type**, a declared `Content-Type` and
  a filename are both client claims and neither is consulted, **SVG is refused** (no magic number; an
  XML document that can carry script), 5 MB server-side. Pure — no network, no DB, no config.
  `platform/object-store.ts` is the Cloudflare R2 side (S3 API), and its shape is the interesting
  part: **all six settings are optional and it refuses AT THE DOOR when they are missing**, naming
  the unset ones, so an unconfigured deployment fails on the capability check rather than on the
  first merchant's upload. A PARTIAL configuration counts as unconfigured — four of five set is what
  would otherwise build a client that authenticates with `undefined`. The S3 client is built lazily
  and memoised, so importing the module is never a credential read and the whole suite runs with
  nothing configured (`resetObjectStore()` drops it).
  - **No delete, deliberately.** Keys carry 8 random bytes, so a replacement never reuses a key an
    already-rendered invoice PDF points at. An orphaned object costs storage; a delete racing a
    render costs a document.
  - **`ASSET_ALLOWS` is narrower than the org standard for `logo` and `signature`** — PNG/JPEG only,
    because `invoicing/invoice-pdf.ts`'s `loadLogo` cannot embed GIF or WebP and those two get
    printed. `GET /v1/brand_images/capability` reports the per-asset list so the dashboard's file
    picker cannot drift from it. Read that before widening either line.
- **2026-09-06** — `TICK_PASSES` and the `runPass` call order had diverged since 2026-09-05 and
  were realigned. `orphaned_intents` was declared above `stale_pending_refunds` while its call ran
  below it: one divergence, two red gates (`verify:clock-obs` compares the RECORDED timeline to the
  declaration, `verify:worker` compares the CALL SITES to it). Corrected on the declaration side —
  the execution order is what has run in production, all three passes are in the never-shed group so
  the priority list is unaffected, and moving the call would change behaviour to satisfy a list.
  ⚠️ Note for whoever hits this next: `git log -S` cannot find a change like this, because a MOVE
  preserves occurrence counts. Bisect the file revision by revision.

- **2026-09-06** — **A namespaced error taxonomy** (`platform/error-taxonomy.ts`, #69 stage 4).
  `payments.failure_code` and `transactions.error_code` hold at least four vocabularies at once —
  our canonical decline codes, engine-minted reasons no gateway ever gave (`no_payment_method`, the
  commonest value at 4,680 rows), raw provider codes that reached the passthrough, and an
  imported book's own spellings, which the importer stores verbatim. "How many mandate failures
  last month" was therefore not answerable from the column.
  Every code now resolves to `gateway.<family>.<code>` or `billing.<family>.<code>`. The gateway
  families are **a fixed set of eleven** — that shared vocabulary is what makes an
  imported book aggregate with ours. The `billing.*` half is the sharper half: it separates "we
  stopped this" from "a provider refused this", a distinction the column could not previously make.
  **The stored value does not change, and there is no migration.** The id is DERIVED — `failure_code`
  is public API, 588 literals across 61 files name one, and ~22,000 rows carry one. Renaming that
  vocabulary is a deploy story; deriving an axis over it is not, which is the whole reason this stage
  could ship at all. Measured against the real book: **98.5% of 22,048 stored rows resolve**, the
  remainder being `NA` and fixture debris rather than vocabulary. Gated in
  `verify:decline-overrides` (§10) — every emitted code has a family, every gateway family is one of
  the eleven, ids are always three segments, no code sits in both namespaces, and the resolver
  never rewrites the code it was handed.

- **2026-11-03** — **Operator sessions are rate limited, and side-effect routes have their own
  limits.** A session (the dashboard) counts per user against `RATE_LIMIT_SESSION_PER_MINUTE`
  (1200; scope `session`, public counter table), not the org's API limit. Scoped limits: invites, webhook resend/test sends,
  ad hoc emails, invoice collect/retry, checkout coupon tries — each a `RATE_LIMIT_*` knob.

- **2026-08-19** — **API rate limiting shipped** (`platform/rate-limit.ts`, migration `0180`) — the last
  item on the M1–M14 audit that was both pure code and a stated go-live blocker, deferred by operator
  decision 2026-07-23 and reopened 2026-08-19.
  One **fixed-window counter per (API key, minute)** in Postgres. Postgres and not memory because the
  API runs under pm2 and can be scaled: a per-process bucket multiplies the real ceiling by the
  instance count and resets on every deploy — a limit that quietly is not one. Fixed window and not a
  token bucket because a bucket makes every check a write even when nothing is consumed and needs its
  refill arithmetic in SQL to stay atomic, while a window is one integer whose reset instant is
  derivable — which is what lets `X-RateLimit-Reset` state a fact. The accepted cost is boundary
  burstiness (up to 2× across two adjacent minutes); this is a ceiling on runaway integrations, not a
  traffic shaper.
  **Counted per key, limited per organization.** The counter is per key so an org's runaway script
  cannot lock its own operators out of the dashboard (a separate `kind='dashboard'` credential of the
  same org, with its own budget); the number is an account-level decision, so it lives on
  `organizations.rate_limit_per_minute` (NULL = the `RATE_LIMIT_PER_MINUTE` deployment default, 600).
  `0` is legal and blocks an org's API traffic outright — a softer tool than revoking every key.
  Enforced in `authenticate()` right after the credential resolves and **before** the `dashboardActor`
  and business lookups, so a refused caller costs the least; every input is already on the auth
  context, so there is no extra query. `X-RateLimit-Limit/Remaining/Reset` ride on **every**
  authenticated response (a client can only back off in advance if it can watch the budget drain);
  over the limit is `429` + `Retry-After` with `error.type = 'rate_limit_error'`.
  Two decisions worth keeping: it **fails OPEN** — a counter that cannot be written allows the request
  and logs at error level, because turning a database hiccup into a total API outage is worse than a
  brief unmetered window, and unlike a money path there is nothing to unwind; and an invalid key is
  still **401, never 429**, so the limiter cannot become an oracle for "is this key real" or let
  unauthenticated traffic fill someone else's counter. Spent windows are dropped by a new
  `sweep_rate_limits` clock pass (retention two windows, so it can never delete the window requests are
  landing in). 23 assertions in `pnpm verify:rate-limit`, in `verify:all`'s CORE list.
  **Not covered, stated rather than implied:** the buyer-facing `/portal/v1/*` and `/checkout/v1/*`
  routes. They carry a session token and have no key to count against; a public surface wants an
  IP/session-keyed limiter, which is a different design against a different threat model.
- **2026-08-04** — **`clock.ts` gained two calendar primitives** for day-anchored billing:
  `midnightOnDateInTz(year, month, day, tz)` — the UTC instant of local midnight on a calendar date you
  NAME (the counterpart of `startOfDayInTz`, which needs an instant already inside the day it floors) —
  and `localDatePartsInTz`. They exist because calendar billing anchors were built with `Date.UTC`, so
  "the 15th" meant 05:30 on the 15th in Asia/Kolkata and 20:00 on the 14th in New York; a business's
  billing calendar has to be read in the business's zone. `midnightOnDateInTz` aims at local NOON and
  then floors — twelve hours of slack in both directions, so a DST-straddling offset lookup cannot land
  it on a neighbouring local day, which a midnight guess would at UTC+14 / UTC−11. Callers:
  `subscriptions/service.ts` (`calendarAnchorFor`, `advancePeriod`). Detail:
  `src/modules/subscriptions/README.md` (2026-08-04, day-anchored terms).

- **2026-08-04** — **A protected route can now keep its one-time secret out of
  `idempotency_keys`** (🔶 security). The sweep below
  protected `POST /v1/api_keys`, and `idempotencyOnSend` persists `responseBody` verbatim
  into a plain `jsonb` column. `api_keys` stores only `hashed_key` — the raw `sk_…` is
  shown once, on purpose — so a keyed create made `idempotency_keys.response_body` the
  credential's ONLY plaintext home: same RLS tenant scope, so never a cross-tenant leak,
  but a secret-at-rest downgrade that quietly repealed "shown once". Latent when found
  (no such row existed yet). The trade-off the route's comment documented is **removed,
  not reversed**: new `idempotentNoStore` route `config` (read in `onSend` via
  `request.routeOptions.config`) keeps the route idempotent and swaps the body for a
  secret-free marker. Per-route rather than a global field denylist because a denylist
  cannot see that a session `url` embeds its bearer token, and silently stops covering a
  field added tomorrow — only the route that minted a secret knows it minted one.
  **A replay answers 409 `response_not_replayable`, not a secret-less 2xx.** A 2xx would
  land on the caller's happy path, where an SDK reads `secret` as undefined and carries
  on — the operator never learns the key exists, which is the exact failure protecting the
  route is for. 409 is literally true (it conflicts with an identical completed request)
  and lands in the error path where the message is read; "already created, secret is gone"
  is told from "your request failed" by three signals, not the status alone:
  `Idempotent-Replayed: true`, `created: true`, and `original_response_status: 201`. The
  `failed` half (a durable write, then a non-2xx) instead replays its ORIGINAL non-2xx
  with `created: false`, so the two are never confusable. Everything else is untouched by
  design: the handler still never re-executes, the row still records its real `status` and
  `response_status`, the fingerprint 409, the pre-write delete that keeps a key unspent,
  and the reaper's `in_progress`-vs-`side_effects` asymmetry all behave identically.
  Applied to `POST /v1/api_keys` only. **Three more routes need the same one-line flag and
  do not have it yet** (files owned elsewhere): `POST …/customers/:cus/portal_sessions`
  and `POST …/checkout_sessions` return a raw `pstk_…`/`cstk_…` bearer token (plus a `url`
  embedding it) while their tables store only `token_hash`; `POST
  …/gateway_accounts/:gwa/webhook_endpoint` returns a revealed shared secret that lives
  **encrypted** (`credentials_enc`, AES-256-GCM) — a plaintext copy is strictly worse than
  where it came from. `/v1/webhook_endpoints` + `…/rotate_secret` were re-checked and
  confirmed NOT a downgrade: `webhook_endpoints.signing_secret` is already plaintext in the
  same RLS scope because we HMAC every delivery with it, so the stored body adds no new
  home. The `client_secret` on the three `…/setup` routes is provider-issued, single-use,
  short-lived and designed to be handed to a browser — kept replayable on purpose, since a
  buyer's retry needs the same setup token. `pnpm verify:idempotency-race` grew **axis G**
  (31 checks, 119 total; A–F's 88 unchanged): a matched RED/GREEN pair of probe routes with
  the same handler and the same secret, differing only by the flag — RED reproduces the
  leak live and finds the raw secret in `response_body`, GREEN finds it in zero rows — then
  the real route end to end (secret still authenticates, `api_keys` count +1 across two
  requests, fingerprint 409 intact, pre-write 400 still leaves the key free), the `failed`
  variant, an opt-in control proving ordinary replay is untouched, and a whole-table
  `response_body::text` scan rather than a field check.
- **2026-08-04** — **Idempotency everywhere is now actually everywhere: 62 unprotected
  write routes closed** (✅ severe bug — see the marker legend in
  the module changelogs). Locked decision #5 held
  on 56 of 127 write registrations in `src/api` and nowhere else — the other 71 carried
  neither the `idempotency` preHandler nor `idempotencyOnSend`, so a client retry
  re-executed the write. Nothing was asymmetric, so the pattern was right where it had
  been applied and simply absent elsewhere: this was a coverage failure, not a design
  one. 62 registrations now carry the pair; the remaining 9 are documented
  non-violations (see below). The header stays **optional** — `idempotency` returns
  immediately when no `Idempotency-Key` is present — so this is additive for every
  existing caller, the dashboard and the SDK included; nothing became mandatory.
  The measured damage on the worst one, `POST …/subscriptions/:sub/charges` (the direct
  twin of the `…/items` bug fixed the day before): with `invoice_now` a duplicate
  request took invoices **1→2→3** and, because that path also collects, charged the card
  twice; unbilled charges went **0→1→2**. `…/invoices/:inv/pay` did not double-pay (the
  second call 400'd "already paid") but answered a retried caller with a failure for a
  payment that had in fact succeeded; `…/reactivate` billed a second term; a duplicate
  `DELETE …/discount` 400'd instead of replaying its original 200. All four now replay.
  Buyer surfaces work too, without special-casing: `requestOrgId` already resolves a
  tenant from `portalSession`/`checkoutSession`, so the portal and hosted-checkout
  writes take the same pair as the API-key routes.
  **Deliberately excluded, and why:** `auth-routes` ×5 (signup/login/logout/
  change_password/invite) and `POST /portal/v1/request_link` run before any tenant
  exists, so `requestOrgId` returns null and the middleware no-ops — the pair would be
  decoration; `…/estimate` and `…/subscription_estimate` are POST-shaped **reads** with
  no side effect to deduplicate; `…/usage` deduplicates on the caller's own
  `unique_key`, which is stronger than a generic replay because it holds across
  different keys. `POST /v1/gateway_webhooks/:gateway` is exempt in the spec for the
  same null-tenant reason (it carries a gateway signature, not an org key) and is
  deduplicated by provider event id.
  OpenAPI is no longer hand-maintained here: per-operation documentation is what
  drifted (60 of 127 operations mentioned the header, and that set did not even agree
  with the set of protected routes), so `withIdempotencyDocs` now **derives** the
  `Idempotency-Key` parameter and the `409` response for every write operation except
  the four documented exemptions, never overwriting a hand-written 409. A route added
  tomorrow gets both for free. `pnpm verify:idempotency-race` grew **axis E**: the four
  money routes pinned by name and by table count (one charge, one payment, one billable
  term, one discount removal), pre-write 404s proven to reply once and leave the key
  free, and a **structural lock** that re-derives coverage from the route sources and
  fails if any write registration lacks either hook — the only check that keeps working
  for a route nobody wrote a fixture for.
  Two findings worth carrying forward: replay is value-identical but **not byte-identical**,
  because `response_body` is `jsonb` and Postgres normalizes object key order — assert
  on deep equality, never `JSON.stringify`; and `POST /v1/api_keys` now persists the raw
  secret in `idempotency_keys.response_body` while `api_keys` itself stores only a hash,
  which weakens "shown once" for that one route (kept protected because minting a
  duplicate credential is worse — see the comment on the route; the clean fix is a
  don't-store-the-body opt-out in `platform/idempotency.ts`). **Closed the same day —
  see the `idempotentNoStore` entry above.**
- **2026-08-04** — **A crashed process no longer poisons an Idempotency-Key forever**
  (🟠 bug). A process death mid-request left its record
  stuck at `in_progress`/`side_effects` permanently — safe (it could never re-execute)
  but unrecoverable short of manual DB surgery: every later retry 409'd forever.
  `idempotency_keys.locked_at` existed already, unused; it is now the staleness clock.
  `IDEMPOTENCY_STALE_MS` = 5 minutes — `stripe-node`'s `DEFAULT_TIMEOUT` (80s) is the
  only DOCUMENTED upper bound on a single gateway round trip anywhere in this codebase
  (RazorPay/PayPal's `providerFetch` sets no client-side timeout at all), so 5 minutes
  is ~4x that with room for a few calls plus DB work. The two statuses recover
  OPPOSITELY: a stale `in_progress` (nothing durable written) is reclaimed in place for
  the next attempt; a stale `side_effects` (a write landed before the crash) is NEVER
  freed for re-execution — only converted to a terminal `failed` with a message
  explaining why, which replays forever after. Both on a schedule AND on read: a
  scheduled sweep (`reapStaleIdempotencyKeys`, cross-organization by design like
  `reapStuckTransfers` — same base-`db` rationale) runs once per `billing_clock_tick`
  (the durable Postgres job queue, `platform/jobs.ts` — locked decision #6, no
  `setInterval`), bounding table growth; the `idempotency` preHandler ALSO reaps
  lazily on read, so the caller actually blocked on a dead key gets relief on their own
  retry instead of waiting for the next tick. Every mutation is a guarded UPDATE/DELETE
  keyed on `id` + the very status/staleness just observed, so a concurrent retry and
  the scheduled sweep can never both believe they won. `pnpm verify:idempotency-race`
  grew axis F (RED-then-GREEN: a freshly-locked row still 409s, the identical row once
  stale is reclaimed and its retry actually runs the handler; a stale `side_effects`
  row is proven NEVER re-executed; a fresh row still blocks; the sweep reaches every
  organization's stale rows without touching a fresh one anywhere).
- **2026-08-03** — **A failure that already moved money no longer frees its Idempotency-Key**.
  `idempotencyOnSend` used to delete the in-progress record on ANY
  non-2xx. That is right for a pre-write early return (404/403/400 — a stored record would poison the
  key) and **wrong** once side effects exist: a 500 raised after a gateway charge, or a 402 surfaced
  once the charge had been attempted, also dropped the record, so the client's retry **re-executed**
  instead of replaying — on a billing path, a second charge. The finalize is now **three-way**:
  2xx → `completed` (replay, unchanged) · non-2xx with nothing written → row DELETED, key stays free
  (unchanged) · non-2xx **after** a durable write → `failed` + the stored response, which the retry
  **replays**. A key is spent by the attempt, not by its outcome; a genuinely new attempt (card
  fixed) takes a new key — the dashboard already mints one per request.
  The distinction is never inferred from the status code (a 400/404 out of a `catch` can sit
  downstream of a real write, and guessing wrong here double-charges). `platform/db.ts` asks
  **Postgres**: `pg_current_xact_id_if_assigned()` is null until a transaction writes, so at the end
  of every `withTenant` callback — inside the same transaction, hence atomic with the write it
  describes — a tracked request stamps its record `side_effects`. Read-only tenant transactions (every
  pre-write early return) never assign an xid and so read as clean. The tracking slot is a
  request-scoped `AsyncLocalStorage` established by `writeTrackingHook` (`onRequest`, registered in
  `index.ts`) and filled in by the `idempotency` preHandler, so it costs nothing for the worker,
  seeds, or any request without an `Idempotency-Key`. Status vocabulary is now
  `in_progress | side_effects | completed | failed` — **no migration**, `status` is plain text.
  Known limits, deliberately documented in `platform/db.ts`: writes through the base `db` handle
  (cross-org admin paths) are untracked; a gateway call whose db write never lands is invisible here
  (provider-side idempotency keys are the defence); a write undone by an inner SAVEPOINT still reads
  as dirty — conservative in the safe direction. `pnpm verify:idempotency-race` grew axis D
  (12 checks, 52 total): the post-write 500 keeps its record and its retry runs the handler **once**,
  a pre-write 500 with the same status code still frees the key, a read-then-404 stores nothing, and
  a real declined subscription create (`tok_…0341`, vaults then fails) replays its 402.
- **2026-08-03** — **One reply per request**. New
  `platform/reply-guard.ts`: an instance-wide `onSend` hook, registered in `index.ts` ahead of every
  route-level hook, that lets the first send chain claim a reply and drops any later chain with a
  warning naming the route — plus an `onRoute` wrapper that skips the route handler when a hook has
  already claimed the reply (Fastify's `preHandlerCallback` gates on the same stale flag, so a
  preHandler that replied and bare-returned used to run the handler anyway). It closes a
  **DoS-grade** bug — a write route that replied through a
  helper and then `return`ed bare (`if (!business) return`) double-sent while `idempotencyOnSend`
  awaited its `withTenant` write, and the second `writeHead` threw an uncaught
  `ERR_HTTP_HEADERS_SENT` that killed the process; any authenticated caller could trigger it with a
  bogus id + an `Idempotency-Key`. The three bare-return helpers (`api/helpers.ts` `resolveBusiness`,
  `requireAll` in transfer- and time-travel-routes) now `await` their reply so no duplicate chain
  starts at all. `platform/idempotency.ts` is unchanged in behaviour — 2xx still stored before the
  flush, non-2xx still deletes the placeholder so an early return does not spend the key — but its
  finalize is now scoped by `organization_id` as well as RLS and guarded against re-entry.
  Locked down by `pnpm verify:idempotency-race` (23 checks, in-process).

- **2026-10-21** — Load-test changes (roadmap D4): `afterCommit` in `platform/db.ts`; `platform/list-query.ts` `cappedTotal` (list totals stop at 10,000); worker roles in `worker.ts` / `platform/jobs.ts` — `billing` (everything, the default), `clock`, `collect`, `reports`; `WORKER_CONCURRENCY` max 300; renewal jobs queue below the tick's priority.

- **2026-10-21** — Tenant isolation (D3): `platform/db.ts` exports `systemDb` (the unfiltered connection) instead of `db`; its production importers are an allowlist (`scripts/lib/system-db-allowlist.json`) checked by `verify:rls`, which now reads every table from the catalog. 0352 closes the tables the app role reached with no policy.

- **2026-10-21** — graphile-worker 0.16.6 → 0.18.0: `platform/graphile-lock-ids.ts` publishes pool ids for the stranded-lock sweep; `WORKER_LOCAL_QUEUE_SIZE` and `WORKER_JOB_BATCH_DELAY_MS` turn on batched job fetch and completion (both off by default). Graphile migration 000019 is a breaking marker: a 0.16 worker stops when it lands and cannot start after it.

## Module README template (copy for a new module)

```markdown
# <module> — <one-line purpose>

> Source: `src/modules/<module>/` · Routes: `src/api/<file>-routes.ts` · Schema: `db/schema/<file>.ts`
> Layer: <layer> (see docs/architecture/architecture.json)

## Purpose
What this module owns and why it exists (2–4 sentences).

## Responsibilities
- Bullet list of what it does…

## Data model
Tables it owns + the load-bearing columns / enums / invariants.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `fn(...)` | … |

## API routes
| Method · Path | Purpose |
|---|---|
| `POST /v1/…` | … |

## Events emitted
`event.type` — when.

## Dependencies
- **Upstream (calls into):** modules this one imports.
- **Downstream (called by):** modules that import this one.

## Invariants & gotchas
Money/ledger/RLS rules specific to this module; non-obvious behaviors; known nits.

## Changelog
- **2026-11-04** — Every API response defaults to `Cache-Control: private, no-store` (+ `Pragma: no-cache`) unless the route set its own; the test gateway's loose CSP applies to its HTML page only. The usage widget clears the global CORS grant before applying the business's origin list.

- **YYYY-MM-DD** — change (branch/commit).
```
