# Implementation guide — build instructions for the coding model

> **Who this is for.** You are the engineer implementing the billing engine backend. This
> document is your **operating manual**: the exact conventions of this codebase, a golden-path
> recipe you copy for every feature, hard rules you must not break, and a per-ticket breakdown
> of what to build. Follow it literally. **Do not invent patterns** — every pattern you need is
> shown here with real code copied from this repo. When unsure, find the nearest existing
> module and mirror it.
>
> **Read order:** this guide top to bottom once, then [`ARCHITECTURE.md`](./ARCHITECTURE.md)
> for *why* each module looks the way it does.

---


## 0. Environment & commands

- **Package manager is `pnpm` (v9.15.4). NEVER use `npm`, `yarn`, or `bun`.** The lockfile of
  record is `pnpm-lock.yaml`.
- **This is a pnpm workspace** (`pnpm-workspace.yaml`): the repo root is the engine package and
  `dashboard/` is the second package. There is ONE lockfile at the root — `dashboard/pnpm-lock.yaml`
  is gone, and a plain `pnpm install` at the root installs both halves. Never run `pnpm install`
  inside `dashboard/`. Reach the dashboard with `--filter tmbilling-dashboard`, or use the
  `dev:dashboard` / `typecheck:dashboard` / `build` scripts that wrap it.
  `sdk/` is deliberately NOT a package — it is plain source compiled by the root tsconfig.
- **Node ≥ 20.18** via `fnm`.
- Runtime: TypeScript executed with `tsx` (no build step for dev/scripts).

Commands you will use constantly:

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` — run after EVERY edit before anything else |
| `pnpm db:generate` | generate a Drizzle migration SQL file from schema changes |
| `pnpm db:migrate` | apply migrations to the local DB |
| `pnpm db:reset` | drop + recreate + re-migrate + reseed the local DB |
| `pnpm seed` | seed demo org/businesses/api-keys |
| `pnpm verify:<name>` | run one verify suite (e.g. `pnpm verify:coupons`) |
| `pnpm sdk:generate` | regenerate the typed SDK from OpenAPI (run after touching routes) |
| `pnpm dev` | run the API server (Fastify) |
| `pnpm dev:dashboard` | run the Next.js dashboard on :4100 |
| `pnpm worker` | run the graphile-worker billing clock |
| `pnpm lint` | oxlint over BOTH packages (add `--quiet` for errors only, as CI runs it) |
| `pnpm lint:fix` | oxlint with autofix |
| `pnpm format` | oxfmt — see the warning below before running this repo-wide |


### Lint, format and git hooks

The toolchain, on pnpm:

| Tool | Config | What it guards |
|---|---|---|
| **oxlint** | `.oxlintrc.json` | eslint + typescript + react + nextjs + import + promise, plus the `oxlint-tailwindcss` JS plugin |
| **oxfmt** | `.oxfmtrc.json` | formatting (ignore list only — the style itself has no options) |
| **lefthook** | `lefthook.yml` | installs the git hooks; run by `prepare` on every `pnpm install` |
| **lint-staged** | `"lint-staged"` in `package.json` | what pre-commit runs over staged files |
| **commitlint** | `"commitlint"` in `package.json` | Conventional Commits on the commit message |

**Errors vs warnings.** `pnpm lint` currently reports ~400 warnings and **0 errors**, and CI
(`pnpm lint --quiet`) fails only on errors. The error set is kept deliberately small and is all
real breakage: `react-hooks/rules-of-hooks`, `tailwindcss/no-conflicting-classes` (two classes
setting the same property, where the winner is decided by Tailwind's output order rather than by
the order you wrote them), and `tailwindcss/no-deprecated-classes`. If you add an error-level
rule, fix the whole repo in the same commit — a red gate that everyone learns to skip is worse
than no gate.

**⚠ Do not run bare `pnpm format` / `pnpm format:check` across the repo.** oxfmt is gofmt-shaped:
no options, and its fixed style (double quotes, semicolons) is not this repo's house style
(single quotes, no semicolons). Repo-wide it rewrites ~1166 of 1188 files. The team decision
(2026-08-29) is to let **lint-staged reformat each file the first time it is touched**, so the
restyle arrives incrementally instead of as one blame-destroying commit. `pnpm format:check` will
therefore report failures repo-wide indefinitely — that is expected, not a regression. Scope it to
what you are working on (`pnpm format:check src/modules/coupons`) or don't run it.

Consequence worth knowing: **the first commit that touches an old file will carry formatting
churn alongside the real change.** That is the accepted cost. If the diff is unreadable, split it
— commit the reformat alone, then the change.

**Commit messages are enforced.** `commit-msg` runs commitlint with
`@commitlint/config-conventional`, matching the shape the history already uses
(`fix(proration): …`, `test(invoicing): …`, `docs(security): …`). A non-conforming message is
rejected at commit time, not at review time.

**Standard loop for any change:**
```
edit → pnpm typecheck → pnpm db:generate && pnpm db:migrate (if schema changed)
  → pnpm verify:<the suite for your change> → pnpm lint → commit-ready
```


---

## 1. Architecture in one screen

- **Hierarchy:** `Organization → Business → Customer → Subscription`. Org = tenant boundary
  (holds API keys). Business = one billing entity (own catalog, currency, gateways, settings,
  invoice numbering, test/live mode). Everything customer-facing hangs off a Business.
- **Multi-tenancy:** Postgres **RLS**. Every tenant table has `organization_id`; queries run
  inside `withTenant(orgId, tx => …)` which sets the RLS session var. You never manually filter
  by org — RLS does it — but you DO filter by `business_id` in every query.
- **Money:** integer **minor units** (`bigint`), always with a 3-char currency. Never floats.
  Balances are **derived** from an append-only double-entry `ledger_entries` table — never store
  a balance, never `UPDATE`/`DELETE` a ledger row; post a compensating entry.
- **Idempotency:** every write route takes an `Idempotency-Key` header (middleware handles it).
- **Events/outbox:** state changes emit events in the SAME transaction (`emitEvent(tx, …)`),
  which fan out to webhooks. **After Phase A, every mutation must emit its event.**
- **Durable clock:** graphile-worker runs `billing_clock_tick` every minute
  (scheduled-changes → renewals → dunning → webhook delivery).
- **Providers:** the engine never imports a gateway SDK directly — only through the adapter
  interface in `src/providers/types.ts`.

Directory map:
```
db/schema/*.ts        Drizzle table definitions (one file per domain); barrel: db/schema/index.ts
db/migrations/*.sql    generated + hand-written (RLS, triggers) migrations, applied in order
src/platform/*.ts      db, ids, auth, api-key, idempotency, jobs (clock) — the shared kernel
src/modules/<name>/     service.ts (business logic) [+ helpers]; the domain layer
src/api/*-routes.ts     Fastify routes; registered in src/api/routes.ts; helpers in helpers.ts
src/providers/*         gateway adapters + registry; contract in types.ts
scripts/verify-*.ts     one standalone verify suite per feature; aggregated by verify-all.sh
scripts/seed.ts         demo data
sdk/                    generated typed client (drift-checked in CI)
```

---

## 1a. Module map (what lives where)

The backend is a modular monolith: **27 domain modules** under `src/modules/` (business logic),
each fronted by a route file in `src/api/` and backed by tables in `db/schema/`. Cross-cutting
concerns live in `src/platform/`; gateway adapters in `src/providers/`. Find a feature's module
below, then open its `service.ts` (logic), `<domain>-routes.ts` (HTTP), and schema file. When in
doubt about call graphs ("who calls X", "what does Y depend on"), query the **tokensave** code
graph — it's faster and more accurate than grep.

**Request lifecycle:** `src/index.ts` (Fastify bootstrap) → `src/api/routes.ts` registers every
`register*Routes` → a route runs `authenticate` (+ `idempotency` on writes) → calls a module
`service.ts` function inside `withTenant(orgId, tx => …)` → the service mutates tables, posts
ledger entries, and calls `emitEvent(tx, …)` in the same transaction → the outbox delivers
webhooks async via the billing clock.

### Platform kernel (`src/platform/`) — no domain logic
| File | Responsibility |
|---|---|
| `db.ts` | `withTenant()` (RLS tx), raw `db` (clock scans only) |
| `auth.ts` · `api-key.ts` | Bearer auth, org resolution, test/live partition; key gen/hash |
| `idempotency.ts` | `Idempotency-Key` middleware (fingerprint + replay) |
| `ids.ts` | `publicId(prefix)` for transactional resources |
| `clock.ts` · `jobs.ts` | durable billing clock (graphile-worker task list + cron) |
| `event-context.ts` | request-scoped source/actor for events + audit; also opens the request trace |
| `secrets.ts` | AES-256-GCM encrypt/decrypt for gateway credentials |
| `config.ts` · `logger.ts` | env config; pino root + `createLogger(service)` (trace-aware) |
| `trace.ts` | one `traceId` per execution (ALS), inbound-header adoption, job-payload stamping |
| `cloud-logging.ts` · `log-truncation.ts` | Google Cloud Logging sink (off unless `CLOUD_LOGGING=TRUE`) + the 256KB entry budget |

### Domain modules (`src/modules/` → `src/api/` → `db/schema/`)

Each module has a `README.md` next to its code (`src/modules/<name>/README.md`) — purpose, data
model, routes, invariants, changelog. The table below is **generated** from
`docs/architecture/architecture.json` — edit the JSON, not the table.

<!-- BEGIN GENERATED: module-map -->
| Module | Owns | Key service entry points | Route file · schema |
|---|---|---|---|
| [`audit`](../src/modules/audit/README.md) | Append-only actor/diff log of writes (who did what). | `writeAuditLog` `listAuditLogs` | `audit-routes.ts` · `audit-logs` |
| [`auth`](../src/modules/auth/README.md) | Dashboard login, sessions, RBAC, invites. | `login` `signup` `resolveSession` `can` `inviteUser` | `auth-routes.ts` · `users` |
| [`comments`](../src/modules/comments/README.md) | Operator notes pinned to a billing record (invoice, credit note, customer, subscription). | `listComments` `createComment` `updateComment` `deleteComment` | `comment-routes.ts` · `comments` |
| [`emails`](../src/modules/emails/README.md) | Customer billing email outbox: event-sink enqueue + clock-driven delivery via a provider-agnostic mailer adapter (opt-in per business). | `enqueueEmails` `deliverPendingEmails` `renderEmail` `resolveEmailConfig` | `email-routes.ts` · `emails(email_messages)` |
| [`events`](../src/modules/events/README.md) | Typed ~67-event registry, payload builders, events list API. | `listEventsFiltered` `getEventWithDeliveries` `buildEventData` | `events-routes.ts` · `platform(events)` |
| [`hubspot`](../src/modules/hubspot/README.md) | HubSpot CRM sync — OAuth connection per business, record links, the push queue fed by the integrations sink, sync runs and their log. | `connectHubSpot` `disconnectHubSpot` `queueHubSpotSync` `runSync` | `hubspot-routes.ts` · `hubspot` |
| [`integrations`](../src/modules/integrations/README.md) | Integrations catalogue + one event sink: push integrations (partner API call per event, own outbox) and sync adapters (HubSpot); business-level connect API. | `dispatchIntegrations` `connectIntegration` `deliverPendingIntegrations` `redeliverIntegrationDelivery` | `integration-routes.ts` · `integrations(integration_connections, integration_deliveries)` |
| [`ledger`](../src/modules/ledger/README.md) | Append-only double-entry postings; the money truth. Balances derived, never mutated. | `postEntries` `accountBalance` | `-` · `ledger` |
| [`list-views`](../src/modules/list-views/README.md) | Saved list views: named filter sets on every list screen, private or shared. | `listListViews` `validateFilters` `createListView` `updateListView` `deleteListView` | `list-view-routes.ts` · `list-views` |
| [`ops`](../src/modules/ops/README.md) | Instrumentation the engine runs on — billing-clock tick records (counters, per-item errors, overrun guard), worker heartbeats, the stranded queue-lock release, the due-work index, HTTP request stats. | `startClockTick` `finishClockTick` `registerWorker` `beat` `releaseStrandedQueueLocks` `refreshDueWork` `recordHttpRequest` | `-` · `platform(clock_ticks)` `platform(worker_heartbeats)` |
| [`request-log`](../src/modules/request-log/README.md) | API request log: one redacted row per /v1 request an organization's credentials made (API-key reads and writes, dashboard writes), buffered off the request path; Request-Id header. | `registerRequestLog` `listRequestLogsPage` `getRequestLog` `flushRequestLogs` | `request-log-routes.ts` · `request-log` |
| [`tenancy`](../src/modules/tenancy/README.md) | Organizations, businesses, API keys — the tenant + isolation boundary. | `createBusiness` `updateBusiness` `listBusinesses` `createApiKey` `authenticateApiKey` | `(auth)` · `tenancy` |
| [`webhooks`](../src/modules/webhooks/README.md) | Outbox: emitEvent (event+deliveries in one tx), endpoints, delivery, redeliver, test-send, inbound provider events. | `emitEvent` `deliverPending` `createEndpoint` `redeliverDelivery` `testSendEndpoint` `handleProviderEvent` | `webhook-routes.ts` · `platform(webhook_endpoints, webhook_deliveries)` |
| [`catalog`](../src/modules/catalog/README.md) | Product groups, products (plan/addon/charge), prices (all models), differential + attached items, price snapshots. | `createProduct` `createPrice` `snapshotPrice` `resolveDifferential` `resolveMandatoryAddonItems` `setDifferentialPrice` | `catalog-routes.ts` · `catalog` `price_rates` |
| [`coupons`](../src/modules/coupons/README.md) | Coupons, sets, codes; stacked discount computation; item constraints. | `createCoupon` `computeStackedDiscounts` `applyCouponToSubscription` `addCouponSetCodes` `couponStatus` | `coupon-routes.ts` · `coupons` |
| [`custom-fields`](../src/modules/custom-fields/README.md) | Admin-defined typed fields on customers, subscriptions and catalog items, validated on write. | `createDefinition` `listDefinitions` `updateDefinition` `archiveDefinition` `validateAndCoerce` | `custom-field-routes.ts` · `custom-fields` |
| [`entitlements`](../src/modules/entitlements/README.md) | Features + plan/subscription grants + runtime checks. | `createFeature` `setPlanEntitlement` `setSubscriptionEntitlement` `checkEntitlement` | `entitlement-routes.ts` · `entitlements` |
| [`reason-codes`](../src/modules/reason-codes/README.md) | Merchant-managed reason lists an operator picks from, so churn and refund reports group by code. | `listReasonCodes` `resolveOfferedReasons` `createReasonCode` `updateReasonCode` `deleteReasonCode` | `reason-code-routes.ts` · `reason-codes` |
| [`tax`](../src/modules/tax/README.md) | Manual tax-rate table, per-line tax computation, pluggable tax providers. | `computeInvoiceTax` `allocateTaxAcrossLines` `createTaxRate` `getTaxProvider` | `tax-routes.ts` · `tax` |
| [`checkout`](../src/modules/checkout/README.md) | Hosted checkout: operator mints a price-scoped cstk_ token; buyer subscribes at /checkout/<token> via /checkout/v1/* (enter details, vault card, create subscription) — org key never reaches the buyer. mode='change' instead changes an EXISTING subscription's plan (upgrade/downgrade, proration preview, customer pinned at mint). | `createCheckoutSession` `resolveCheckoutSession` `completeCheckout` | `checkout-routes.ts` · `checkout-sessions` |
| [`credit-notes`](../src/modules/credit-notes/README.md) | Adjustment + refundable credit notes, allocations, refunds, void; routes write-off. | `issueAdjustmentCreditNote` `issueRefundableCreditNote` `refundCreditNote` `voidCreditNote` `allocateRefundableDraw` | `credit-note-routes.ts` · `credit-notes` |
| [`credits`](../src/modules/credits/README.md) | Credit units, credit grants and holds (G3/G4a). Promotional and paid grants (paid only through an invoice), drawdown in a fixed order before and after tax, expiry into breakage, restore on invoice void, credit packs and plan credits on prices, the derived live balance, holds with capture and release, and the access check with the blocking policy ladder. | `createCreditUnit` `createPromotionalGrant` `createManualPaidGrant` `voidCreditGrant` `planGrantApplication` `liveBalance` `createCreditHold` `captureCreditHold` `releaseCreditHold` `checkAccess` | `credits-routes.ts + credit-hold-routes.ts` · `credit_units` `credit_grants` `credit_grant_movements` `credit_holds` |
| [`customer-portal`](../src/modules/customer-portal/README.md) | Buyer self-serve portal: customer-scoped pstk_ entry tokens exchanged for psst_ sessions; /portal/v1/* payment-method + invoices + subscriptions surface, and an operator revoke that kills both credentials (org key never reaches the buyer). There is no self-serve way in — an operator or integration mints every link. Usage so far, projected bill and usage by day, each behind its business setting. | `createPortalSession` `resolvePortalSession` `revokePortalSession` | `customer-portal-routes.ts` · `portal-sessions` |
| [`customers`](../src/modules/customers/README.md) | Customer records, contacts, 3-balance wallet (promotional/refundable/excess), VAT status, GDPR clear, ad-hoc collect. | `createCustomer` `getCustomerBalances` `addPromotionalCredits` `recordExcessPayment` `collectPayment` `clearPersonalData` `planCreditApplication` | `customer-routes.ts` · `customers` |
| [`metadata-rules`](../src/modules/metadata-rules/README.md) | Per-business rules for dot paths in customer and subscription metadata: type checks, strict mode and an on/off switch, enforced on every metadata write. | `enforceMetadataRules` `checkMetadataWrite` `createRule` `setRulesConfig` | `metadata-rule-routes.ts` · `metadata_key_rules` `businesses.metadata_rules_config` |
| [`segments`](../src/modules/segments/README.md) | Customer segments: saved populations over customer attributes that reports compare a metric across. | `listSegments` `getSegment` `resolveSegment` `validateSegmentFilters` | `segment-routes.ts` · `segments` |
| [`usage-controls`](../src/modules/usage-controls/README.md) | Spend controls and early billing (G5): spend limits (customer, subscription or usage property; hard limits answer the access check, soft limits notify), limit tiers by lifetime paid, alerts with a state per threshold, credit runway, automatic top-up (threshold or schedule, pre-debit notice on mandate rails, off after a decline), invoices raised when unbilled usage reaches an amount, the price-change preview and the embeddable usage widget. Checked on arrival through a dirty set and a one-minute cron on its own queue. | `evaluateSpendLimits` `measureRunway` `alertStates` `putAutoTopup` `previewRateChange` `mintUsageWidgetToken` `usageWidgetView` | `usage-control-routes.ts + usage-billing-routes.ts + portal-usage-control-routes.ts + rate-change-preview-routes.ts + usage-widget-routes.ts` · `spend_limits` `spend_limit_tiers` `customer_limit_tier_reached` `spend_limit_states` `usage_alerts` `usage_alert_states` `usage_alert_observations` `credit_auto_topups` `credit_auto_topup_runs` `usage_invoice_thresholds` `usage_widget_tokens` `usage_control_cursors` `usage_control_dirty` |
| [`wallet`](../src/modules/wallet/README.md) | Legacy top-up audit trail (folded into customer balances). | `topUpWallet` `walletBalance` | `wallet-routes.ts` · `wallet` |
| [`dunning-policies`](../src/modules/dunning-policies/README.md) | Named dunning configurations; a customer runs its assigned policy, else the business config. | `loadEffectiveDunningConfig` `createDunningPolicy` `listDunningPolicies` `getDunningPolicy` | `dunning-policy-routes.ts` · `dunning-policies` |
| [`invoicing`](../src/modules/invoicing/README.md) | Invoice generation + lifecycle (pending/posted/payment_due/not_paid/paid/voided), dunning transitions, close/void/write-off/regenerate/collect, offline payments, HTML render. | `billSubscriptionPeriod` `createManualInvoice` `closeInvoice` `writeOffInvoice` `collectInvoiceNow` `recordOfflinePayment` `renderInvoiceHtml` `runInvoiceDueTransitions` | `invoice-routes.ts` · `invoices` |
| [`metering`](../src/modules/metering/README.md) | Usage ingestion and rating. Usage records per subscription item (idempotent, add/remove), and usage events (G1a): meters, per-event-key dedup, per-org ingest limit, monthly partitions, 15-minute rollups with an exact-edge live read, late usage, customer usage keys, partition archive. Measurement (sum/max/last/count/min/avg/unique/weighted_sum, recurring levels) and rating (rateMeteredItem; rateMeterItem per group combination from a rate card). Usage by day in the business time zone, and model_price_list rating per price segment (G1b). | `recordUsage` `aggregateMeteredQuantity` `rateMeteredItem` `rateSubscriptionUsage` `createMeter` `ingestUsageEvents` `runUsageFold` `readMeterUsage` `rateMeterItem` `addUsageKey` `customerUsageHistory` `loadModelPriceBook` | `usage-routes.ts (+ subscription usage)` · `usage` `meters` `customer_usage_keys` `usage_events` `usage_event_dedup` `usage_rollups` `usage_rollup_state` `usage_meter_levels` `usage_archives` `ingest_rate_counters` |
| [`metrics`](../src/modules/metrics/README.md) | MRR/ARR/ARPU/churn per currency + converted-to-base FX roll-up. Usage margin (G1b): revenue after discounts and line credit notes, before tax, minus line cost, per customer, model or meter. | `computeBusinessMetrics` `usageMargin` | `metrics-routes.ts` · `(derived)` |
| [`model-prices`](../src/modules/model-prices/README.md) | AI model price list (G1b): a dated, append-only copy of a public price list (genai-prices v2), synced two times a day through guardedFetch with a suspect-batch hold; your cost per organization (model_cost_overrides); resolveListPrice and resolveModelCost, which return the value and the row it came from; price-change notices (webhook + email to price managers). | `runModelPriceSync` `releaseHeldModelPrices` `resolveListPrice` `resolveModelCost` `createCostOverride` `runModelPriceNotices` | `model-price-routes.ts` · `model_price_models` `model_prices` `model_cost_overrides` `model_price_notices` |
| [`subscriptions`](../src/modules/subscriptions/README.md) | The subscription engine + billing clock: create/change/cancel/pause/resume option sets, scheduled changes, dunning, estimates, ad-hoc/unbilled charges, renewals. | `createSubscription` `changeSubscription` `runBillingClockTick` `runDunningPass` `cancelSubscriptionWithOptions` `estimateChange` `scheduleChange` `addAdHocCharge` | `subscription-routes.ts` · `subscriptions` `scheduled-changes` `unbilled-charges` |
| [`team-alerts`](../src/modules/team-alerts/README.md) | Opt-in mail to a business's own staff (team_alerts_config): high-value overdue invoices and failed webhook deliveries every hour, and a daily summary of payments, dunning and expiring cards; hourly cron fan-out to one queued send per business and kind, through the deployment mailer. | `resolveTeamAlertsConfig` `planTeamAlerts` `runTeamAlertsFanout` `sendTeamAlert` | `undefined` · — |
| [`disputes`](../src/modules/disputes/README.md) | Chargebacks from the gateway or recorded by hand, ledgered, with the chargeback policy applied. | `handleDisputeEvent` `recordOperatorDispute` `recordDisputeOutcome` `applyChargebackPolicy` | `dispute-routes.ts` · `disputes` |
| [`gateway`](../src/modules/gateway/README.md) | Gateway accounts (encrypted creds), currency×method router, inbound webhook ingestion + reconciliation. | `selectGatewayAccount` `ingestGatewayWebhook` `listGatewayWebhooks` | `gateway-routes.ts` · `gateway` |
| [`payment-intents`](../src/modules/payment-intents/README.md) | On-session 3DS/SCA intents: create → authorize → consume; expiry sweep. | `createPaymentIntent` `authorizePaymentIntent` `consumePaymentIntent` `expirePaymentIntents` | `payment-intent-routes.ts` · `payment-intents` |
| [`payment-methods`](../src/modules/payment-methods/README.md) | Vaulted payment sources, roles (primary/backup), status lifecycle + expiry sweep. | `vaultPaymentMethod` `assignPaymentMethodRole` `paymentSourceSweep` `detachPaymentMethod` | `payment-method-routes.ts` · `payment-methods` `provider-customers` |
| [`payment-requests`](../src/modules/payment-requests/README.md) | Ask one customer for several open invoices at once: one combined charge or one payment link. | `createPaymentRequest` `loadPaymentRequestView` `requestByCharge` `reverseRequestCharge` | `payment-request-routes.ts` · `payment-requests` |
| [`payments`](../src/modules/payments/README.md) | Charge-outcome settlement: apply gateway success/failure to invoice + ledger + dunning. | `settlePaymentSucceeded` `settlePaymentFailed` `settleTransactionOutcome` | `(via invoicing/gateway)` · `payments` |
| [`receipts`](../src/modules/receipts/README.md) | Numbered, immutable records of money received, with a PDF; not a tax invoice. | `createReceiptForPayment` `createReceiptForRequestSettlement` `numberUnnumberedReceipts` `renderReceiptPdf` | `receipt-routes.ts` · `receipts` |
| [`refunds`](../src/modules/refunds/README.md) | Refund execution (full/partial) through the adapter; ledger + transaction record. | `refundPayment` `listRefunds` | `refund-routes.ts` · `payments` |
| [`transactions`](../src/modules/transactions/README.md) | Gateway-facing money log (auth/payment/refund; succeeded/failed/needs_attention/timeout/late_failed) + reconcile op. | `recordTransaction` `reconcileTransaction` `listTransactions` `findTransactionByGatewayCharge` | `transaction-routes.ts` · `transactions` |
| `migration` | Import from another billing system or generic JSON (idempotent, no double-charge) + reconcile — CLI only. | `importFromSource` | `(CLI)` · `migration` |
| [`time-travel`](../src/modules/time-travel/README.md) | Test-business virtual clock: start_afresh + travel_forward; businessNow() seam. | `startTimeTravel` `travelForward` `stopTimeTravel` `timeTravelledBusinessIds` | `time-travel-routes.ts` · `time-travels` |
| [`transfer`](../src/modules/transfer/README.md) | Transfer Configurations (catalog, settings, company profile, email sending and tax copy between businesses; live = merge-only unless an owner/admin applies the audited live override after a preview) + sample data. | `previewTransfer` `runTransfer` `createSampleData` `deleteSampleData` `getTransfer` | `transfer-routes.ts` · `transfer` |
<!-- END GENERATED: module-map -->

### Providers (`src/providers/`)
Adapter contract in `types.ts`; registry resolves an adapter from a `gateway_accounts` row
(`registry.ts`). Implementations: `tmtest/` (in-house reference gateway — deterministic
instruments, simulated async webhooks; the fixture for verify suites), `stripe.ts`, `paypal.ts`,
`razorpay.ts`, `mock.ts`. **The engine never imports these directly** — only via the contract.

> The API is fully specified in `src/api/openapi.ts` (160 routes, coverage-gated) → served at
> `/docs` → compiled to the typed `sdk/`. That spec is the authoritative endpoint reference; this
> table is the *module* navigation layer above it.

---

## 2. HARD RULES (violating these fails review)

1. **Every DB access goes through `withTenant(organizationId, async (tx) => …)`.** Never use the
   raw `db` export inside a request/service path except the system-wide clock scans (which use
   `db` deliberately to cross tenants, then re-enter `withTenant` per row).
2. **Every query filters by `business_id`** (RLS only scopes org, not business).
3. **Money is `bigint` minor units + currency.** No floats, no `number` for amounts in schema.
4. **Ledger is append-only.** New balance types = new ledger accounts + compensating entries.
   Never mutate a `ledger_entries` row.
5. **Public IDs everywhere at the boundary.** Clients never see UUID PKs. **Two families:** (a) **transactional** resources (customers, subscriptions, invoices,
   transactions, credit notes, events, payment sources) use system-generated
   `publicId('<prefix>')` = `<prefix>_<9-char time><15 random>`; (b) **catalog & coupon** resources (product
   groups, products, prices, coupons, coupon sets) use a **user-provided human-readable slug id**
   — unique per business, immutable, auto-slugged from name if omitted (ticket CAT-0). Do NOT
   use `publicId('prod'|'price'|'cpn'|…)` for catalog/coupons once CAT-0 lands. Look up by
   `(businessId, id)` either way.
6. **Every new tenant table needs three things** (see §3): the columns convention, an RLS policy
   migration, and (if it's mutable) the `bump_row_version` trigger. Add it to `verify:rls`'s
   table list.
7. **Every mutation emits its event** (Phase A onward). If you add a service function that
   changes state and don't call `emitEvent`, the ticket is incomplete.
8. **Keep public field/enum names stable and conventional.** tmbilling is in production: a rename
   is a breaking change and needs a migration + deploy story.
9. **Every ticket ships a verify assertion.** New behavior with no verify coverage = incomplete.
10. **After touching any route, run `pnpm sdk:generate`** and commit the regenerated SDK.
11. **Do not weaken RLS, idempotency, or the ledger invariants to make a test pass.** If a test
    is hard to satisfy, the design is wrong — re-read the architecture doc, don't hack the guard.
12. **No `console.*` in `src/`.** Use `createLogger('<module>')` (§4) so the line carries the
    `traceId`, `service` and `source`/`actor` and is machine-parseable. Sole exception:
    `platform/config.ts`, which fails before a logger can exist.

---

## 3. Golden path: adding a feature (copy this every time)

This is the canonical recipe. Every ticket is a variation of it. Real code, copied from the
`coupons` module — mirror it exactly.

### 3.1 Schema (`db/schema/<domain>.ts`)

```typescript
import {
  pgTable, uuid, text, char, bigint, integer, boolean, timestamp, jsonb,
  uniqueIndex, index,
} from 'drizzle-orm/pg-core'
import { organizations, businesses } from './tenancy'

export const coupons = pgTable(
  'coupons',
  {
    id: uuid('id').default(sql`uuid_v7()`).primaryKey(),                  // internal PK, never exposed; time-ordered
    organizationId: uuid('organization_id').notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    publicId: text('public_id').notNull(),                               // cpn_… — the client-facing id
    code: text('code').notNull(),
    kind: text('kind').notNull(),                                        // enum-as-text: percentage | fixed_amount
    amountOffMinor: bigint('amount_off_minor', { mode: 'bigint' }),      // money = bigint minor units
    currency: char('currency', { length: 3 }),
    active: boolean('active').notNull().default(true),                   // soft-archive flag
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint('resource_version', { mode: 'number' }).notNull().default(1),
  },
  (t) => [
    uniqueIndex('coupons_public_id_uq').on(t.publicId),
    uniqueIndex('coupons_code_uq').on(t.businessId, t.code),             // business-scoped uniqueness
    index('coupons_business_idx').on(t.businessId),
  ],
)
```
Then export it from the barrel `db/schema/index.ts`: `export * from './coupons'`.

**Column conventions (non-negotiable):** `id` uuid PK · `organizationId` + `businessId` FK
cascade · `publicId` text · money as `bigint {mode:'bigint'}` · enums as `text` (validated in
Zod, not a PG enum) · `active` boolean for soft-archive · `createdAt`/`updatedAt` tz timestamps ·
`resourceVersion` bigint default 1 · unique index on `public_id` · unique index on
`(business_id, <natural key>)` where relevant.

### 3.2 Migration + RLS + trigger

1. `pnpm db:generate` → creates `db/migrations/NNNN_*.sql` for the table.
2. **Hand-write a second migration** `db/migrations/NNNN_rls_<table>.sql`:
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON coupons TO tmbilling_app;
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON coupons
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
```
3. **If the table is mutable, attach the version trigger** (same or new migration):
```sql
CREATE TRIGGER bump_row_version BEFORE UPDATE ON coupons
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
```
4. Add the table name to the tenant-table list in `scripts/verify-rls.ts`.
5. `pnpm db:migrate`.

> The `bump_row_version()` function already exists (migration `0057`). INSERT relies on column
> defaults (`resource_version=1`); the trigger bumps `updated_at` + `resource_version` on every
> UPDATE. `provider_events` is the ONLY table intentionally without RLS (platform-global).

### 3.3 Service (`src/modules/<domain>/service.ts`)

```typescript
import { and, desc, eq } from 'drizzle-orm'
import { withTenant } from '@/platform/db'
import { publicId } from '@/platform/ids'
import { emitEvent } from '@/modules/webhooks/outbox'
import { coupons } from '@db/schema'

export class CouponError extends Error {
  constructor(message: string) { super(message); this.name = 'CouponError' }
}

export async function createCoupon(input: {
  organizationId: string; businessId: string; code: string
  kind: 'percentage' | 'fixed_amount'; amountOffMinor?: number; currency?: string
}): Promise<typeof coupons.$inferSelect> {
  if (input.kind === 'fixed_amount' && input.amountOffMinor == null)
    throw new CouponError('fixed_amount coupon requires amount_off_minor')      // validate → throw domain error
  return withTenant(input.organizationId, async (tx) => {
    const [c] = await tx.insert(coupons).values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      publicId: publicId('cpn'),
      code: input.code,
      kind: input.kind,
      amountOffMinor: input.amountOffMinor != null ? BigInt(input.amountOffMinor) : null,
      currency: input.currency?.toUpperCase() ?? null,
    }).returning()
    await emitEvent(tx, {                                                        // event in the SAME tx
      organizationId: input.organizationId, businessId: input.businessId,
      type: 'coupon.created', data: { coupon: { id: c!.publicId } },
    })
    return c!
  })
}

export async function listCoupons(organizationId: string, businessId: string,
  opts?: { includeArchived?: boolean }): Promise<Array<typeof coupons.$inferSelect>> {
  return withTenant(organizationId, async (tx) => {
    const base = eq(coupons.businessId, businessId)
    const where = opts?.includeArchived ? base : and(base, eq(coupons.active, true))
    return tx.select().from(coupons).where(where).orderBy(desc(coupons.createdAt))
  })
}
```

**Update pattern** — build a `set` object with only provided fields; if `expectedVersion` is
passed, check `resourceVersion` first and throw `VersionConflictError` on mismatch (copy from
`src/modules/catalog/service.ts` `updateProduct`). Return `null` when the row doesn't exist so
the route can 404.

### 3.4 Route (`src/api/<domain>-routes.ts`)

**Unknown request keys are refused.** Parse every body and zod-parsed querystring with
`parseRequest(schema, input)` (`src/api/strict-params.ts`), not `schema.safeParse`: a key the
schema does not declare — at any depth, array items included — answers 400
`Unknown parameter: <path>` through `badRequest`. Values under `z.record(...)` (metadata,
custom_fields, credentials, transform_config) are free-form and not checked; `.catchall(cfKeys)`
admits top-level `cf_<name>` keys; `roundTripped(schema)` marks a stored settings object the
dashboard PATCHes back whole. A key a live caller sends that the route does not act on is
declared as `acceptedAndIgnored()` with a comment naming the caller — never silently dropped.
List routes get the same rule from `parseListQuery`. Kill switch: `API_UNKNOWN_PARAMS=warn`
logs `request_unknown_parameters` (route + keys) and ignores the keys instead, as before;
default `reject`. Gate: `verify:strict-params`.

**Every route behind `authenticate` declares one permission.** Put `requirePerm("<resource:action>")`
right after `authenticate` (or `noMemberPermission("<reason>")` for a route open to every caller);
the key comes from the catalogue in `src/modules/auth/permissions.ts`, a GET takes a `read` key and
a write a `write` key. The server refuses to boot on a route without one. A new route is added to
`scripts/fixtures/route-permissions.json` as `{"key": "…"}` in review. Gates:
`verify:permission-coverage`, `verify:permission-parity`.

```typescript
import { z } from 'zod'
import { authenticate } from '@/platform/auth'
import { idempotency, idempotencyOnSend } from '@/platform/idempotency'
import { badRequest, notFound, conflict, resolveBusiness, requirePerm } from './helpers'
import { parseRequest } from './strict-params'
import { createCoupon, CouponError } from '@/modules/coupons/service'

const createBody = z.object({
  code: z.string().min(1).max(100),
  kind: z.enum(['percentage', 'fixed_amount']),
  amount_off_minor: z.number().int().positive().optional(),   // snake_case at the API boundary
  currency: z.string().length(3).optional(),
})

export async function registerCouponRoutes(app) {
  app.post('/v1/businesses/:biz/coupons',
    { preHandler: [authenticate, requirePerm('coupons:manage'), idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply)
      if (!business) return
      const parsed = parseRequest(createBody, req.body)   // never bare .safeParse on input
      if (!parsed.success) return badRequest(reply, parsed.error)
      try {
        const c = await createCoupon({
          organizationId: req.organization!.id, businessId: business.id,
          code: parsed.data.code, kind: parsed.data.kind,
          amountOffMinor: parsed.data.amount_off_minor, currency: parsed.data.currency,
        })
        return reply.code(201).send({ object: 'coupon', id: c.publicId, code: c.code })
      } catch (e) {
        if (e instanceof CouponError) return badRequest(reply, e.message)
        throw e
      }
    })

  app.get('/v1/businesses/:biz/coupons',
    { preHandler: authenticate },                                              // reads: auth only
    async (req, reply) => {
      const business = await resolveBusiness(req, reply)
      if (!business) return
      const data = await listCoupons(req.organization!.id, business.id)
      return { object: 'list', data: data.map(serializeCoupon) }
    })
}
```
Register it in `src/api/routes.ts`: `await registerCouponRoutes(app)`.

**Route conventions:** write routes use `preHandler: [authenticate, idempotency]` +
`onSend: idempotencyOnSend`; reads use `preHandler: authenticate`. Get org via
`req.organization!.id`, business via `resolveBusiness(req, reply)` (returns null + already-sent
404 → just `return`). Validate with Zod (snake_case fields). Map domain errors: `CouponError →
badRequest (400)`, `VersionConflictError → conflict (409)`, missing → `notFound (404)`.
Serialize to snake_case `{ object, id, … }` — never leak internal UUIDs or column names.

**List routes must be paginated** — an unbounded `SELECT` is a latent outage on any table a
customer can grow (a 50k-customer business must not be serialized into one response), and a
*silently capped* one is worse: a toolbar reading "50 Transactions" over 40,000 hides money.
The plumbing is shared — **`src/platform/list-query.ts`** (operators, cursors, page assembly) and
**`parseListQuery` / `listResponse`** in `src/api/helpers.ts`. Live on customers, subscriptions,
invoices, credit notes and transactions; copy any of them:

```
?limit=50                    default 50, max 1000 → 400 outside that
?starting_after=<cursor>     OPAQUE token from the previous page's next_cursor
?offset=<cursor>             the same token under a second name (next_offset)
?q=<text>                    free-text search, in SQL (ILIKE over the identifying columns)
?sort_by[desc]=created_at    or sort_by[asc]=<field>. Unknown field → 400
?<field>[<op>]=<value>       filters: email[contains], created_at[after], tax_exempt[is]…
                             unknown field/op → 400 with the supported set in the message
                             sets/ranges: a,b or a JSON array ["a","b"]; dates: YYYY-MM-DD
                             (a business-zone day) or unix seconds (an exact instant; only
                             on=<unix> means the day holding it)
?include_deleted=true        where the route declares it (`includeDeleted`): honoured where
                             rows hide (customers, subscriptions), a no-op where none can
→ { object: 'list', data: [...], has_more, next_cursor, total, next_offset (while has_more) }
```
- **Keyset, not offset**, for the default sort: order by `(created_at DESC, public_id DESC)` and
  seek past the cursor row, so page N costs page 1 and a concurrent insert can't duplicate a row.
  **Add the matching composite index in the same migration** (`customers_business_created_idx`).
  A sort on another column may fall back to an `o:<n>` offset cursor — the cursor is opaque, so
  that's an internal detail.
- `total` = the filtered count, **first page only** (`starting_after` absent); don't re-count per page.
- A stale cursor (row deleted) degrades to the first page — never to "no filter at all".
- Filters/sorts live in an allow-list next to the service (`CUSTOMER_FILTER_OPS`,
  `CUSTOMER_SORT_FIELDS`, and the same pair per entity) so the route validates instead of
  interpolating query keys into SQL. `opsFromSpecs()` derives the allow-list from the column map,
  so a new filterable column can't be added without its operators.
- **Per-page hydration**: anything the rows need (subscription items, paid totals, credit-note
  items) is loaded for *the page*, after `toPage()` — never for the whole table, and never one
  query per row. `verify:list-pagination` asserts this per entity.
- Filters that need another table use an `EXISTS` sub-query as a *virtual field*
  (e.g. `subscription_status[is]=active`) — a UI segment must narrow the whole set, not one page.
- The dashboard consumes this via `components/patterns/list-page`'s `server` mode, through the generic
  `app/api/lists/[entity]` route so the org key stays server-side; see `dashboard/README.md`.
- New paginated list ⇒ add it to `verify:list-pagination` (`scripts/verify-list-pagination.ts`).
  It asserts the whole contract per entity — tiling, cursor stability under a concurrent insert,
  first-page-only `total`, filters narrowing in SQL, stale-cursor behaviour, business scoping.

### 3.5 Verify suite (`scripts/verify-<name>.ts`)

Standalone `tsx` script. Pattern: set up org/business context, exercise the service and/or HTTP,
push `[label, passed]` into a `checks` array, print, `process.exit(failed ? 1 : 0)`.

```typescript
import { createOrganization } from '@/modules/... '   // or use scripts/seed helpers
const checks: Array<[string, boolean]> = []

// ... create org + business + api key (mirror an existing verify suite's setup) ...
const c = await createCoupon({ organizationId, businessId, code: 'SAVE10', kind: 'percentage' })
checks.push(['coupon created with cpn_ id', c.publicId.startsWith('cpn_')])

// event emitted?
const evs = await listEvents(organizationId, 10)
checks.push(['coupon.created emitted', evs.some(e => e.type === 'coupon.created')])

let failed = 0
for (const [label, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++ }
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
```

Then:
1. Add the script to `package.json`: `"verify:coupons": "tsx scripts/verify-coupons.ts"`.
3. `pnpm verify:coupons`, against a database you can throw away.

**Copy the setup boilerplate from the closest existing suite** (e.g. `verify-coupons.ts`) — do not reinvent org/business/key creation.

---

## 4. Platform helpers reference (exact APIs)

- **`withTenant(organizationId, async (tx) => T): Promise<T>`** (`src/platform/db.ts`) — opens a
  transaction, switches to role `tmbilling_app`, sets `app.org_id`; all queries inside are
  RLS-scoped. `Tx` is the transaction handle type. `db` is the raw drizzle instance (clock scans
  only).
- **`publicId(prefix): string`** (`src/platform/ids.ts`) — `prefix_` + 24 chars: creation ms (9, base36
  lowercase) then 15 random, so it sorts by creation time. **`uuidv7()`** is the app-side twin of
  SQL `uuid_v7()`, for a uuid made before the insert (D4.10).
- **`authenticate(req, reply)`** (`src/platform/auth.ts`) — preHandler; parses `Authorization:
  Bearer <key>`, sets `req.organization` and `req.keyLivemode`; enforces the test/live partition
  on `:biz` routes (404 on cross-mode access). `req.organization!.id` is the org UUID.
- **`generateApiKey(mode)` / `hashApiKey(raw)`** (`src/platform/api-key.ts`) — key format
  `sk_<live|test|all>_<base64url>`; stored hashed (HMAC-SHA256).
- **`idempotency` (preHandler) + `idempotencyOnSend` (onSend)** (`src/platform/idempotency.ts`) —
  fingerprints method+path+body under the `Idempotency-Key`; replays completed 2xx, 409s on
  in-progress or fingerprint mismatch.
- **`emitEvent(tx, { organizationId, businessId?, type, data })`** (`src/modules/webhooks/outbox.ts`)
  — writes the immutable `events` row + a `webhook_deliveries` row per matching enabled endpoint,
  in the caller's transaction. MUST be called inside `withTenant`.
- **`postEntries({ organizationId, businessId, customerId?, sourceType, sourceId, lines }, tx?)`**
  (`src/modules/ledger/service.ts`) — posts balanced double-entry lines
  (`{ account, direction: 'debit'|'credit', amountMinor: bigint, currency, memo? }`); asserts
  Σdebits = Σcredits per currency; returns `{ transactionId }`. Pass `tx` to join the caller's
  transaction. Account names are plain strings (e.g. `accounts_receivable`, `revenue`,
  `customer_balance`).
- **Clock (`src/platform/jobs.ts`)** — `taskList` maps task name → handler; `billing_clock_tick`
  runs every minute (crontab `* * * * *`) and calls, in order: apply-scheduled-changes →
  renewals → dunning → `deliverPending` (webhooks). `enqueue(task, payload)` to add a job.
- **Route helpers (`src/api/helpers.ts`)** — `badRequest(reply, err|string)` (400),
  `notFound(reply, msg)` (404), `conflict(reply, msg)` (409), `resolveBusiness(req, reply)`
  (resolves `:biz` or sends 404 + returns null). `VersionConflictError` for optimistic
  concurrency.
- **Logging (`src/platform/logger.ts`)** — `createLogger('<module>')` → `log`, `info`, `warn`,
  `error`, `debug`, `verbose`, each `(message, debug_info?)`. Every line automatically carries `service`, the active
  `traceId`, and `source`/`actor` from the event context — do NOT pass those by hand.
  `error(e, debug_info?)` takes the Error itself and extracts `error_message` + `stack`.
  `debug_info` is a free-form object; bigints and circular refs are safe, and anything over 64KB is
  truncated to a preview. **`console.*` is not allowed in `src/`** — the only exception is
  `platform/config.ts`, which fails before a logger can exist (it imports config).
  **Every module has one** (`src/modules/<name>/…`); when you add a module, give it a logger and
  use it on the paths that can fail — a swallowed `catch` with no line is the bug this exists to
  prevent. Gate: `pnpm verify:logging`.
- **Google Cloud Logging (`src/platform/cloud-logging.ts`)** — OFF unless `CLOUD_LOGGING=TRUE` +
  `GOOGLE_CLOUD_PROJECT_ID` (the config refuses to boot with one and not the other), so tests,
  scripts and local dev are pino-to-stdout exactly as before. On a deployed box the root logger
  becomes a multistream: stdout (pm2 keeps it) **and** a batching sink that pushes entries to the
  Cloud Logging API — we run under pm2 on a VPS, so nothing is scraping stdout for us. Each entry
  carries `severity`, the GCP-native `trace` field (`projects/<id>/traces/<traceId>`, which is what
  makes Logs Explorer group one execution) and indexed `labels` (service, source, org, business).
  An error's **stack goes in `message`** and rides with `serviceContext` — that is what Cloud Error
  Reporting groups on. Entries over ~170KB JSON are truncated in escalating passes
  (`log-truncation.ts`) because GCP rejects a 256KB LogEntry, and the protobuf encoding runs ~50%
  over the JSON size. The sink can never throw into a caller: a write failure is a `console.error`
  and the line still went to stdout. One service account can cover several services, and a traceId that crosses the boundary lines
  their entries up. Flush on
  shutdown with `flushCloudLogging()` (the API and worker already do); `captureProcessErrors(service)`
  routes uncaught exceptions / unhandled rejections through the logger first.
- **Tracing (`src/platform/trace.ts`)** — one `traceId` per execution, via AsyncLocalStorage.
  `getTraceId()` reads it; `withTraceContext({ traceId? }, fn)` wraps an entry point (prefer this at
  request boundaries — `enterTraceContext` does not reliably reach a Fastify handler from a
  preHandler); `updateTraceContext(patch)` fills in org/business once auth resolves them.
  Established for you at every boundary: API requests (`eventContextHook`), worker tasks
  (`tracedTask`), the billing clock, and the importer. An inbound `x-trace-id` / `x-request-id` /
  W3C `traceparent` is **adopted**, so one execution spanning an upstream service → tmbilling is a
  single trace in both services' logs, and the id is echoed back as `x-trace-id`. Ids are
  `prefix-` + 21 base62. Crossing the job queue needs the payload stamp:
  `enqueue()` calls `stampTracePayload` and `tracedTask` recovers it — an ALS context cannot survive
  a Postgres row.

---


## 6. Cross-cutting, every phase

1. **OpenAPI + SDK:** document new routes with response schemas; `pnpm sdk:generate`; commit the
   regenerated `sdk/`. CI drift-checks it.
3. **Events discipline:** new mutation ⇒ registry event + verify assertion. No exceptions after
   Phase A.

---

## 7. When you get stuck

- **Unsure of a pattern?** Find the nearest existing module (`coupons`, `catalog`,
  `subscriptions`, `invoicing`) and copy its structure. This repo is internally consistent;
  mirroring is correct.
- **A verify suite is hard to pass?** Re-read the relevant architecture-doc section — usually the
  design intent clarifies the expected behavior. Do NOT relax RLS/idempotency/ledger guards to
  pass.
- **Schema change won't migrate?** Check you added the RLS migration and the trigger, and that
  the barrel export exists. `pnpm db:reset` for a clean slate locally.
- **Scope question / conflict between docs?** `BACKEND-IMPLEMENTATION-PLAN.md` is authoritative
  on *what* to build; this guide is authoritative on *how* to build it; `ARCHITECTURE.md`
  explains *why*. If still ambiguous, stop and ask rather than guessing on money-handling logic.
