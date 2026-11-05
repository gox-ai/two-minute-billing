# hubspot

Keeps a business's records in sync with its HubSpot portal. The billing engine stays the owner
of every record; HubSpot is a mirror we push to (and, from phase 4, read edits back from).

## Pieces

| file | job |
|---|---|
| `oauth.ts` | Scopes, authorize URL, code exchange, refresh, token info, revoke. `REQUIRED_SCOPES` must equal `hubspot-app/src/app/app-hsmeta.json` `requiredScopes` — `verify:hubspot-sync` checks it. |
| `client.ts` | One connection's API: refreshes a minute before expiry (and once on a 401, one refresh at a time), waits out 429s, times out at 20s, flags `reauth_required` when the grant is dead. Paces requests to `*.hubapi.com` per connection: search ≤4/s, everything ≤90 per 10s. |
| `connections.ts` | Connect (code → tokens → portal), settings, disconnect. One row per business; a disconnect keeps links and history. Reconnecting a *different* portal drops the old links. |
| `sink.ts` | Event sink: queues a push in the emitting transaction (outbox), inside a savepoint so a HubSpot fault never rolls back billing. One unclaimed row per record coalesces bursts. |
| `sync/engine.ts` | Claims due rows (`SKIP LOCKED`, 200 at a time), runs the handler per resource type, logs every touched record, backs off retryable failures (1m → 2h, 8 attempts), drops terminal 4xx with the reason on the log. Five or more customer rows go through `pushCustomers` in chunks of 100; alongside that lane, up to 3 more run subscriptions (one customer's in sequence, after its customer row when both are claimed) and prices. The full sweep queues only subscriptions in `deals.statuses` (none when deals are off) and prices only when products are on. |
| `settings.ts` | The whole preference schema (zod 4, `.prefault` so section defaults apply). `parseSettings` never throws; the route validates every write and refuses to turn off shared companies. |
| `discovery.ts` | The portal's own properties per object and its deal pipelines, for the mapping pickers. |
| `sync/handlers.ts` | Queue `resource_type` → push handler (`sync/context.ts` is the contract: one outcome per HubSpot object touched). |
| `sync/customers.ts` | Customer → Contact + Company: search-match on the configured rule, create when missing (409 counts as a match), v4 contact↔company association, `onMatch` (overwrite / fill_empty / link_only), sharing guard, scope, `updates.localChange`. Links are written only after every call succeeded. |
| `sync/customers-batch.ts` | The same push for up to 100 customers: one `IN` search per object (lowercased values), `batch/create` (with `objectWriteTraceId`), `batch/update`, `batch/read` for a 409-named record under `fill_empty`, and one v4 `batch/associate/default`. A duplicate unique value sets that input aside and resends the rest; whatever a batch call cannot place goes through the single path for that object. Customers sharing a match value with an earlier one in the batch run through `pushCustomer` afterwards, so they see its links. |
| `sync/fields.ts` | Local field → HubSpot string: money in major units, booleans, epoch-ms dates (UTC midnight for `date` props), `cf_*` typed by definition. |
| `sync/deals.ts` | Subscription → Deal for the selected statuses. Match order: existing link, then `subscriptionIdProperty`, then the newest OPEN deal on the linked contact not held by another subscription, else create (`mode: create` skips matching). Name from `nameFormat`, amount mrr / arr / next billing (major units), `deal_currency_code`, pipeline + stage only when the status is mapped. Pushes the customer first if it has no contact link, then associates the deal to contact and company. |
| `app/*` + `src/api/hubspot-app-routes.ts` | What the HubSpot app calls: the record card's data, the card's Create subscription (only with `deals.manualCreate`; idempotent on a per-form `requestId`), and the create / edit workflow actions (idempotent on `callbackId` in `hubspot_action_executions`; `dealtype` in `editDealTypes` → edit). Authenticated only by HubSpot's signature — v3 for cards, v2 for workflow actions. Writes carry event source `hubspot`. |
| `sync/pull.ts` / `inbound.ts` / `conflicts.ts` | HubSpot → billing on autosync and Sync Now: per-object watermark (`lastmodifieddate` / `hs_lastmodifieddate`, 2-minute overlap for search lag), linked records only. A property counts as changed only if it differs from `hubspot_links.remote_values` (HubSpot as last seen) AND from ours. Blank contact/company values never overwrite; blank deal values do. Deals pull only `cf_*` and auto-collection. Conflicts follow `updates.conflict`; `flag` holds both directions in `hubspot_conflicts` until resolved. Pull writes carry source `hubspot` and store the pulled state's hash, so they don't echo back. |
| `sync/invoices.ts` | Invoice → a record of the portal's invoice custom object (`invoices.objectType`, `2-…`). HubSpot's own invoice object has no write scope for public apps and its paid status cannot be set over the API, so we write a custom object (Enterprise only). Properties by internal name (`INVOICE_PROPERTIES` in `settings.ts`): `invoice_id` is required and is the retry match key; any other the object lacks is left out and named in the log. Money in major units, dates as the business's local day, `invoice_url` = the buyer portal's invoices tab. Associated to the customer's contact and company and the subscription's deal; a refused association is a note. Drafts never sync. Missing custom-object scopes or a 403 → skipped with "Connect HubSpot again", never retried. |
| `sync/products.ts` | Price → HubSpot product, matched on `hs_sku` = price id. flat/per_unit only (HubSpot holds one unit price); frequencies it cannot express are skipped. Price goes in the portal's `hs_price_<ccy>` property. Archive → DELETE; restore → a new product (the API cannot un-archive). |

## Flow

1. Dashboard `/integrations/hubspot/start` mints `state` (cookie on its own origin) → HubSpot install
   screen → dashboard `/integrations/hubspot/callback` checks `state` → `POST …/integrations/hubspot/connect`
   with the code. The redirect URI is the DASHBOARD's and must be registered on the app; each
   deployment sets its own `HUBSPOT_REDIRECT_URI`.
2. Connect queues a full sweep (`hubspot_sync_connection`, trigger `initial`).
3. Every event on a connected business queues its customer; `hubspot_sync_tick` (every minute) drains
   autosyncing connections, `hubspot_autosync` (every 15 min) reclaims dead claims and drains the rest.
   Both run on the `hubspot_sync` queue, off the billing clock.
4. Sync Now = `hubspot_sync_connection` (trigger `manual`), coalesced per connection by `jobKey`.

⚠️ The sink is registered by import. HubSpot's `onEvent` runs from the shared integrations sink;
the API and the worker import `@/modules/integrations/sink`, and a script that emits events without importing it queues nothing —
run a full resync after such a script.

## Verify

One suite per phase, each in a throwaway database against a local HubSpot stand-in:
`pnpm verify:all:fresh -- --suite <hubspot-sync | hubspot-customers | hubspot-deals | hubspot-products | hubspot-app | hubspot-inbound | hubspot-batch | hubspot-invoices>`.

## The HubSpot app (`hubspot-app/`)

A developer-platform project (2026.09) in the GoX developer account: OAuth app "Two Minute Billing",
the billing card, two workflow actions. `hsprofile.local.json` / `hsprofile.production.json` set
`API_BASE_URL` (production's is a placeholder until the domain is known). Upload with
`hs project upload -p <profile>` from that folder. `WEBHOOK_BASE_URL` on the API must equal the
profile's `API_BASE_URL` host, or HubSpot's signatures will not verify behind a proxy.

## Changelog
- **2026-11-03** — HubSpot API and OAuth calls send `redirect: "manual"`: a 3xx is an error, never
  followed (the token request carries the client secret in its body).
- **2026-11-03** — Deal-driven plan edits follow the business's plan-change rules: 409
  `invoices_unpaid` when gated, 422 `change_timing` when the rule sends the change to the term
  end, and proration by the direction's rule.

- **2026-10-25** — `connectHubSpot` / `disconnectHubSpot` write `integration.hubspot.connect` /
  `.disconnect` audit rows in their tx (portal, status, scopes; never a token or the installer's email).
- **2026-10-24** — Invoices → a custom object (`sync/invoices.ts`, setting `invoices: { enabled, objectType }`,
  off by default; enabling without an object is refused). Created on finalize, updated on payment,
  part-payment, void, write-off and credit note (the sink maps `payment` and `credit_note` events to
  their invoices, only while the sync is on). Invoice rows run after the rest of a batch, in one lane.
  The full sweep queues finalized invoices. New optional scopes `crm.objects.custom.read`,
  `crm.objects.custom.write`, `crm.schemas.custom.read` (also in `app-hsmeta.json`; re-upload the app);
  existing connections reconnect to grant them. `GET …/integrations/hubspot/objects` lists custom
  objects. Dashboard: Invoices section. Suite: `verify:hubspot-invoices`.

- **2026-09-25** — Contacts and companies can map `subscription_id`, `_status`, `_plan_id`,
  `_plan_amount`, `_mrr`, `_currency`: the customer's newest non-cancelled subscription (else its
  newest), resolved by the deal resolver. Deals gain `plan_id` (price public id) and `plan_amount`
  (unit price × quantity).
- **2026-09-25** — `updates.pullAddress` / `updates.pullEmail` (both default off): the pull no
  longer writes the billing address or email unless switched on. Held fields are still baselined in
  `remote_values`, so switching on does not replay old edits.
- **2026-09-25** — Batched customer push (`sync/customers-batch.ts`): 20 customers cost 7 calls
  instead of 100. Engine claims 200 rows and runs up to 4 lanes at a time; client paces search and
  total requests, and refreshes once for concurrent callers. The full sweep no longer queues
  subscriptions or prices that would only be skipped. Suite: `verify:hubspot-batch`.
- **2026-09-24** — Phase 2: companies, matching rules, update policies, customer scope, field
  mappings. Phase 5: products. Turning a sync (products, deals, autosync) back on queues a full resync,
  because changes made while it was off were consumed as skips. Phase 3: deals. Phase 6: the
  HubSpot app's card, Create subscription and workflow actions (migration 0289); event source `hubspot`.
  Phase 4: inbound sync, conflict rules and the conflicts queue (migration 0287).
- **2026-09-24** — Phase 1: OAuth connect/disconnect, links, push queue + sink, sync engine and
  log, customer → contact push, Sync Now, autosync, dashboard page. Migration 0284 (0284–0289 in all; renumbered after main's 0282/0283).
