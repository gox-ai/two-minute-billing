# usage-controls

Spend limits, limit tiers, alerts, credit runway, automatic top-up, threshold invoicing, the
price-change preview and the embeddable usage widget (Tier 3 PR 3). Design:
`docs/references/LAGO_SPEC/tier3-design/design-G5.md`.

Every control is off until a business configures one (`businesses.usage_controls_active`).

## Files
| File | What |
|---|---|
| `measure.ts` | The one measure for every control: spend, quantity, live balance, burn, runway. Calendar intervals in the business time zone. |
| `dirty.ts`, `check.ts`, `sink.ts` | The dirty set (fast mark at ingest, fold backstop, config writes) and the `usage_controls_check` cron on its own queue. |
| `limits.ts` | Spend limits and limit tiers: CRUD, nesting rule, buyer limits, the real `SpendLimitEvaluator`, tier evaluation. |
| `alerts.ts`, `alerts-pass.ts` | Alerts: crossing, once per threshold per period, resolve, the per-threshold state read; the `usage_alerts` pass. |
| `auto-topup.ts`, `auto-topup-amount.ts` | Automatic top-up: config, amount, runs, notice duty, lead-time rule, outcomes; the `credit_auto_topups` pass. |
| `threshold-invoicing.ts`, `interim-lines.ts` | Threshold invoicing: config, on-arrival interim invoices, per-line already-billed. |
| `mail.ts` | The usage-control emails. |
| `rate-change-preview.ts` | Re-rates each customer's last closed period under a draft rate card, in a READ ONLY transaction. |
| `widget.ts`, `widget-script.ts` | Usage widget: `uwt_…` tokens (hash stored, 15 minutes, real clock), the per-business origin allowlist, the read, and the served script with its SRI hash. |

## Routes
- Operator: `api/usage-control-routes.ts` (limits, tiers, alerts, runway),
  `api/usage-billing-routes.ts` (automatic top-up, usage invoice thresholds),
  `api/rate-change-preview-routes.ts`, `api/usage-widget-routes.ts` (token mint, origins).
- Portal: `api/portal-usage-control-routes.ts` (buyer limits, runway).
- Widget: `GET /widget/v1/usage` (bearer `uwt_…`), `GET /widget/v1/usage.js`.
- Permissions: `usage_controls:view` / `usage_controls:manage`; the widget token mint takes
  `customers:manage`, like a portal session.

## Invariants
- Usage is never refused at ingest. A hard limit refuses at the access check only.
- A limit tier never goes down (`customer_limit_tier_reached` is append-only).
- Each alert threshold fires at most once per subject and period, and resolves at most once.
- Credit from an automatic top-up is granted only after its payment succeeds. A decline voids
  the invoice and turns automatic top-up off; there is no retry.
- Σ interim subtotals + final subtotal = the single-invoice subtotal, per item, to the minor unit.
- The price-change preview writes nothing (`set transaction read only`).
- A widget token reads one customer only, and no write route accepts it. A browser gets the data
  only from an origin in `businesses.usage_widget_origins` (exact origin match).

## Measure, dirty set and the check (`measure.ts`, `dirty.ts`, `check.ts`)
- Spend = rated usage before tax and credits. Inside the current term an interval's spend is
  rated(term start → to) − rated(term start → from), so tiers and free units land where the
  invoice puts them; the part before the term is rated on its own. `measureOnly` rating: no
  line cost, no late lines.
- A property measure (`where: {key, value}`) reads raw events: rollups do not group by
  `limit_dimensions`.
- Exports for other builders: `measureSpend`, `measureSpendBetween`, `measureQuantity`,
  `measureBalance`, `measureBurn`, `measureRunway`, `runwayFrom`, `calendarWindow`,
  `businessTimeZone`, `newRateCache`; `markDirty`, `setUsageControlsActive`,
  `usageControlsActive`; `claimDirty`, `registerUsageControlStep` (a step run per claimed
  customer, in its tenant transaction); `registerUsageAlertsDailyStep` (the pass's daily part).
- Marks: the ingest fast mark (`markDirtyOnIngest`, one insert per request, only when
  `usage_controls_active`), the fold backstop (`registerFoldHook`), limit/alert writes, grant
  events (`sink.ts`). A time-travel step runs the check itself (the cron skips a travelled
  business). The claim is DELETE … RETURNING, oldest first, SKIP LOCKED; a failed
  customer is marked again.

## Limits and tiers (`limits.ts`)
- The access check refuses when spent + open holds in scope + estimate (default 1) > amount.
  Refused → `limits` holds only the tightest refusing limit; else every limit checked, with a
  property limit the request did not name as `not_checked`.
- Customer scope: the higher of the operator's limit and the reached tier, unless the
  operator changed its limit after the tier was reached (then it wins, even when lower).
- A buyer limit (portal) is hard, customer- or property-scoped, and at most the operator's for
  the same scope and interval; the tighter of the two refuses.
- `spend_limit_reached` fires once per limit, subject and interval start (`spend_limit_states`),
  from the on-arrival check, for hard and soft limits. Mail only when the business switched
  the `spend_limit_reached` email on (`email_config.types`).
- Tiers: lifetime paid = succeeded payments − succeeded refunds; evaluated by the
  `payment_succeeded` sink (in a savepoint) and daily for the last 25 h of payers.

## Alerts and runway (`alerts.ts`, `alerts-pass.ts`)
- Values compare as Fixed12. Rising kinds fire t with prev < t ≤ cur, falling ones
  cur ≤ t < prev; the first observation counts from 0 (rising) or +∞ (falling).
- Period key: the interval start (usage, spend), the calendar month (balance, runway). A state
  row per threshold that triggered; no row = armed. The states read uses the rows only.
- Resolve: `recovered` when the value moves back, `period_ended` from the pass (SQL computes the
  current period start per alert in the business zone).
- Runway = floor(balance × 7 ÷ spend in the last 7 days), plus what an active automatic
  top-up can still add this month; null under 24 h of usage or with no spend.

## Gotchas
- `interval` is a SQL keyword: quote it in raw queries.
- Balance alerts see holds only when a hold event is written (endpoints that list them) or the
  customer is marked for another reason; grant events always mark.
- The widget route answers its own CORS: the preflight is granted to an origin some business
  lists (no token arrives with a preflight); the GET is granted only to the token's business's
  origins.

## Changelog
- 2026-11-03 — Each credit auto top-up runs in its own span (`withSpan` around `chargeRun`),
  so its transaction's gateway-log link shows that top-up, not the whole clock pass.
- 2026-11-02 — Automatic top-up selects its first method for the run's currency
  (`resolveChargeCandidates({ currency })`): a USD run no longer picks an INR mandate first, which
  also decided the notice duty from the wrong method. Cover: `verify:auto-topup`.
- 2026-11-02 — Module created (Tier 3 PR 3): rate-change preview, usage widget. Builders of
  limits, alerts, runway, automatic top-up and threshold invoicing: add your entries here.
- 2026-11-02 — Measure, dirty set, `usage_controls_check` cron (queue `usage_controls`), spend
  limits and tiers with the real `SpendLimitEvaluator`, buyer limits in the portal, alerts with
  the per-threshold state read, runway, the `usage_alerts` pass. Gates: `verify:spend-limits`,
  `verify:usage-alerts`, `test/unit/usage-controls-limits.test.ts`.
- 2026-11-02 — Fixes from the browser and money check: an interim invoice has its own pre-debit
  notice, never replaced by another invoice's (`invoicing/pre-debit.ts`); the rate-change
  preview adds the period's interim lines; limits carry `effective_amount_minor` (tier
  included), `spent_minor`, `reached`, `resets_at`, and the portal lists a tier with no
  provider row; an interim invoice reads usage to now (no fold grace; a later event with an
  earlier time is billed once by the next interim or the final invoice); a declined
  automatic top-up mails only `credit_auto_topup_failed`; a time-travel step runs the check;
  interim lines carry their units and "this invoice"; responses and events give ISO 8601
  times; a grant names its `auto_top_up_run`.
