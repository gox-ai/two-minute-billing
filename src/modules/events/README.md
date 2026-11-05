# events — typed event registry + events API

> Source: `src/modules/events/` · Routes: `src/api/events-routes.ts` · Schema: `db/schema/platform.ts` (`events`)
> Layer: foundation (see docs/architecture/architecture.json)

## Purpose
The typed catalog of everything that can happen in the system. Defines the ~67-type `EventType`
registry (compile-time exhaustive), builds consistent event payloads, and serves the events list/detail
API. Events are the backbone of the webhook outbox and the operational logs.

## Responsibilities
- Own the `EVENT_TYPES` registry + `EventType` union (narrows `emitEvent`'s `type`).
- Build per-type payload shapes (`buildEventData`) and sample payloads (for webhook test-send).
- Serve filtered events queries + single-event detail (with delivery status).

## Data model
`db/schema/platform.ts` — `events`: immutable log with `type`, `source` (api/dashboard/scheduled_job/
migration/system), `actor`, `resource_type`, `resource_id`, `data` (jsonb, includes
`resource_version`), `created_at`. Indexed by `(business_id, type, created_at)` and `(resource_type,
resource_id)`.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `isEventType` / `resourceTypeOf` | registry membership + resource classification |
| `buildEventData` | consistent `{ <resource>: {…}, resource_version }` payloads |
| `sampleEventData` / `sampleResourceId` | fixture payloads for webhook test-send |
| `listEventsFiltered` | native-events-only filter/cursor list (internal; verify scripts) |
| `listEventsUnified` | native + imported (`ievt_…`) merged, paginated `ListPage<UnifiedEventRow>` — what the API/dashboard actually use |
| `getEventWithDeliveries` | single event + per-endpoint delivery status |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/events` | filtered, paginated event list |
| `GET /v1/events/:evt` | single event + deliveries |
| `GET /v1/businesses/:biz/events` | business-scoped variant |

## Events emitted
None — this module *defines* the taxonomy; `webhooks.emitEvent` writes the rows.

## Dependencies
- **Upstream (calls into):** none.
- **Downstream (called by):** every module that emits (catalog, coupons, credit-notes, customers, gateway, invoicing, payment-intents, payment-methods, payments, refunds, subscriptions, transactions, wallet, webhooks).

## Invariants & gotchas
- **The registry is the source of truth**: `emitEvent`'s `type` is narrowed to `EventType`, so an
  unregistered string fails to typecheck (intentional exhaustiveness).
- **Rule:** no state-changing service function ships without emitting its event (post-Phase-A gate).
- Keep the dashboard's `dashboard/lib/api/event-types.ts` copy in sync with this registry.

## Changelog
- **2026-11-01** — Event type `model_prices_changed` (resource family `model_prices`): one per business per price sync that changed a model it uses (Tier 3 PR 1b, `modules/model-prices/notices.ts`).
- **2026-10-25** — Registry: `receipt_created`, `payment_request_created|paid|payment_failed|canceled|expired`, `dunning_policy_created|updated|archived`; resource types `receipt`, `payment_request`, `dunning_policy`.
- **2026-10-08** — **Changed events cover settings edits and skip no-ops.** `subscription_changed` now fires for settings PATCH (metadata, PO, collection, payment method, custom fields) and for `update_for_items`' metadata; `customer_updated` no longer fires for a re-save of the same values (`platform/effective-patch.ts`). Settings-only `subscription_changed` carries `settings_only: true` on the envelope. Gate: `verify:change-events`.
- **2026-09-14** — **`customer=` scopes a stream to one customer's whole footprint.**
  `resource-scope.ts`'s `ownedByCustomer(col, cus, businessId?)` resolves a customer public id to
  every resource id it owns — subscriptions, invoices, credit notes, transactions, payments, refunds,
  payment methods/intents/attempts, disputes — as a subquery, so `events` and `audit_logs` can both be
  scoped to a customer even though each row points at exactly one resource. Exposed as the bare
  `?customer=` param on `GET /v1/businesses/:biz/events` (and the org-level list) and on
  `GET /v1/businesses/:biz/audit_logs`; native-only, since an imported event carries no resource
  pointer, so it drops the imported side out of the page AND the total. Built for the dashboard's
  customer page, whose Activity Log showed only the ~11 `customer_*` types and none of the invoice,
  subscription or payment events of that customer's life (43 → 501 on one seeded customer).
  `audit` imports the helper rather than keeping a second copy of the ownership map.
- **2026-08-31** — **Filters widened on the unified events list, without breaking the union.** Added
  `id` to BOTH maps (each table has its own `public_id`, and the serializer prints both as `id`), and
  `actor`, `trace_id`, `api_version` as native-only. The native-only set is now one named constant,
  `NATIVE_ONLY_FILTER_FIELDS` — filtering on any of it drops `imported_events` out of the union for
  the page AND for `total`, which is what `resource_type`/`resource_id`/`source` already did
  open-coded. An imported row's actor and source live inside its archived `payload` json, where
  `serializeImportedEvent` digs them out per row with fallbacks; re-deriving those in SQL is how a
  filter starts disagreeing with the renderer, so they are deliberately native-only rather than
  approximated. `source` stays native-only even though `imported_events.source` exists: that column
  names the SYSTEM the row came from, not the serialized `source`. Sorts unchanged (time only — the
  cross-table merge depends on it). Routes pass `EVENT_FILTER_KINDS` as `filterKinds`.
  **Not added, no column on either table:** `webhook_status` (rolled up in JS from
  `webhook_deliveries`, not a column on `events`) and `imported` (a union discriminator, not a field).
- **2026-08-06** — **`source='dashboard'` is real, and its actor is a person** (migrations 0150/0151).
  Requests made with an org's `kind='dashboard'` credential — our own UI — used to enrich as
  `source='api'` with the key's public id as the actor, so every operator click was indistinguishable
  from an integration's call. They now stamp `source='dashboard'` with the signed-in operator's **email**
  as the actor, resolved by `platform/auth` from the session the dashboard forwards (`dashboard` when no
  session came along). `source='system'` keeps its narrow meaning: no human, no request — seeds, verify
  runs. `emitEvent` is unchanged; what changed is what `platform/auth` puts on the ambient
  `EventContext`. `verify:events` asserts all four: an api key stamps `source='api'` + `actor='key_…'`;
  the dashboard credential stamps `source='dashboard'`, with the operator's email when a session is
  forwarded and `dashboard` when not; and a session from ANOTHER organization is ignored rather than
  trusted as the actor.
- **2026-08-01** — **`listEventsUnified` fixed + fully on the shared list-query contract.** Two real
  pagination defects closed: (1) rows dropped/duplicated across pages, root-caused to a JS merge that
  sorted a ms-truncated `Date` — fixed with `keysetCondition` for the seek (cursor cast back
  `::timestamptz` inside SQL) plus a projected microsecond-precision string sort key
  (`to_char(… AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`) for the merge, so `UnifiedEventRow.at`
  is now `string`, not `Date`. A THIRD bug surfaced while fixing it: the JS tiebreak comparison on
  `public_id` (plain `<`) doesn't agree with Postgres's own collation on that column — fixed by making
  the merge a stable sort (return 0 on a tied key) instead of re-deriving a tiebreak in JS, since each
  table's rows already arrive from Postgres pre-ordered correctly. (2) `total` added — counts both
  `events` and `imported_events` on the first page. Filters generalized onto `filterConditions` /
  `opsFromSpecs` (`NATIVE_EVENT_FILTERS`/`IMPORTED_EVENT_FILTERS`, exported as `EVENT_FILTER_OPS`) with
  the legacy flat params folded in alongside, plus free-text search. `GET /v1/events` and
  `GET /v1/businesses/:biz/events` now use `parseListQuery`/`listResponse`. Dashboard: the Events page
  was ported onto `ListPage` server mode (`dashboard/components/events/events-table.tsx`), and
  `listEventsForBusiness`/`listEventsFiltered` return `PagedList<EventRecord>`. `scripts/verify-list-
  pagination.ts` wires `events` into `assertPagedContract` — zero known defects remain in that suite.
- **2026-07-29** — **Enrichment is business-scoped (Bugs #11).** `content.ts` resolved the nested
  `customer`/`subscription` snapshots by public id alone; those ids are now unique per BUSINESS, so
  `buildEventContent` threads `event.businessId` into `loadCustomerSnapshot`/`loadSubscriptionSnapshot`
  via local `cusSnap`/`subSnap` helpers. If an event ever arrives with no business id those two
  enrichments are skipped rather than resolved ambiguously (best-effort contract — never throws). The
  invoice/credit-note/transaction/payment-source loaders need no guard: their public ids are
  engine-minted and stay globally unique.
- **2026-07-27** — **Deferred events** (`emit.ts`): `emitOrDefer(tx, input, buffer?)` emits now, or
  appends to a caller-supplied `DeferredEvents` buffer; `emitDeferred(tx, buf)` replays it inside
  the caller's transaction and `flushDeferredEvents(org, buf)` in one of its own. Opt-in — with no
  buffer `emitOrDefer` IS `emitEvent`. Exists because an operation whose outcome isn't settled yet
  (the auto-collect-ON signup, refused if the first charge declines) must not write events it may
  have to undo: deleting the rows afterwards cannot unsend a webhook already delivered.
  `content.ts`: a payment event with no invoice ref (the refused-signup charge — its invoice was
  never created) now enriches `customer` from the payload's `customer` id, so the envelope always
  says whose money it was.
- **2026-07-14** — `content.ts`: payment events (`payment_succeeded`/`payment_failed`) now
  enrich customer+subscription. Their resource id is a payment (`pay_…`), not a transaction,
  so the shared payment/transaction case's `loadTransactionSnapshot` missed and the envelope
  stayed bare `{payment}`; it now falls back to the invoice ref in the payload.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-09-30** — `webhook_status[is|is_not|in|not_in]` filter over the same worst-wins rollup the list prints (not_configured / pending / failed / delivered), as SQL. Imported events count as not_configured. 0318 indexes `webhook_deliveries(event_id, status)` for the rollup and the filter.
- **2026-10-21** — `prepareEvent` / `insertPreparedEvent`: the event snapshot is built before the invoice number is taken, so the numbering transaction holds the counter for less time. Events list total capped at 10,000.
- **2026-10-24** — Registry: `feature_created`, `feature_updated`, `feature_archived`, `plan_entitlement_set`, `subscription_entitlement_set` (resource types `feature`, `plan_entitlement`, `subscription_entitlement`). Emitted by the entitlements module.
