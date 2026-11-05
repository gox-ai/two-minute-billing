# metrics — MRR/ARR/ARPU/churn + FX roll-up + Business Home + payments analytics

> Source: `src/modules/metrics/` · Routes: `src/api/metrics-routes.ts` · Schema: derived (no own table)
> Layer: billing (see docs/architecture/architecture.json)

## Purpose
Computes SaaS metrics from current subscription state: MRR/ARR/ARPU per currency, subscriber counts by
status, 30-day movement (new vs churned + logo churn), and a converted-to-default-currency roll-up
using the business's manual reporting FX rates. Also serves the **Business Home dashboard** payload
(`analytics.ts`): headline KPIs, twelve bucketed time-series, and the plan mix. Read-only, RLS-scoped.

## Responsibilities
- Per-business metrics: per-currency MRR/ARR/ARPU + subscriber mix + 30-day movement.
- Converted (`converted`) roll-up to the default currency via `businesses.exchange_rates`, reporting
  currencies without a rate in `missing_rates`.
- Org-wide roll-up combining per-business metrics by currency.
- Business Home analytics: KPIs, bucketed series, subscriptions-by-plan (see § Analytics).

## Data model
No own table — derived by scanning `subscriptions` + `subscription_items` (+ `prices`). MRR rates from
each item's **`price_snapshot`** (so sub-level overrides count), normalized to monthly, grouped by
currency; never summed across currencies except via the FX `converted` block.

Analytics additionally scans `invoices`, `transactions`, `credit_notes`, `customers` and `products`.
There is **no snapshot table**: everything is derived on read, so no backfill is needed and no job can
drift — at the cost of scanning the business's history per request. See § Scale for where that stops
being true and what to build then.

## Analytics (Business Home)
`computeBusinessAnalytics` returns one payload per dashboard render. `range` picks the bucket shape —
`daily` = 60 daily, `3m` = 13 weekly, `6m` = 26 weekly, `12m` = 12 calendar-month buckets. `currency`
is `ALL` (convert everything into the business default via its FX rates) or a code (scope every figure
to it, including counts).

**Chart bucketing is UTC** — the `daily`/`3m`/`6m` buckets are rolling windows anchored on `now`, where
a wall-clock boundary carries no meaning. The **calendar** windows are not: see § Calendar windows.

**Flow metrics** bucket source rows by timestamp:

| Series | Source |
|---|---|
| `total_billing` | invoices in `posted`/`payment_due`/`not_paid`/`paid`, at `total_minor` |
| `total_new_billing` | each subscription's **first** invoice + invoices with no subscription |
| `voluntary_cancellation_mrr` | MRR of subs canceled with any reason other than dunning's |
| `involuntary_cancellation_mrr` | MRR of subs canceled with `not_paid` / `no_card` (dunning's reasons) |
| `total_payments` / `total_refunds` | successful `transactions` of that type, by `occurred_at` |
| `total_signups` | **customers** created (a signup is an account, not a subscription) |
| `total_activations` | subscriptions' `activated_at` (the trial→active moment) |
| `subscription_churn_rate` | points are cancellations per bucket; the headline is the window rate |
| `total_credit_notes_amount` | credit notes at `total_minor` |

**Stock metrics** are reconstructed from lifecycle timestamps, not stored history:
- `total_mrr` — MRR at each bucket's end: subs whose start ≤ t and (`canceled_at` null or > t).
- `total_cmrr` — MRR we are **committed** to at each future instant: anything booked to cancel is out
  from the moment it is booked, a subscription signed to start later is in already, and finite
  `remaining_billing_cycles` end the commitment at the last cycle. This is the one series that
  projects **forward** (`forward: true`).

Every series carries a `headline`: the window value plus a **previous-calendar-month** comparison
(`prev_label` = `Jun`). The KPI deltas (`change_bps` on
`mrr` / `active_subscriptions`) are also month-over-month, not vs the start of the selected range.

### Calendar windows (the revenue/signup strip)
The strip under the KPI cards, and the month boundaries the month-over-month deltas compare across,
are cut on **calendar** windows — `today`, `yesterday`, `this month`, `last month`, `next month`:

| field | definition |
|---|---|
| `revenue_*.expected_minor` | invoices in `posted`/`payment_due`/`not_paid`/`paid` **created** in the window, at `total_minor` |
| `revenue_*.received_minor` | successful payments **less** successful refunds in the window |
| `revenue_this_month.last_month_minor`, `revenue_today.yesterday_minor` | the same net measure over the comparison window |
| `signups_*` | **customers** created in the window (a signup is an account, not a subscription) |

`Expected` and `Received` are **not** a numerator/denominator pair: Expected counts what was invoiced
in the window (including invoices already paid), while a payment in the window can settle an invoice
raised in an earlier one. Do not read `Received ÷ Expected` as a collection rate.

`Received` is **net of refunds**, the same definition as the `net_payments_minor` KPI directly above
it on the screen — the strip used to report gross there while that card reported net, so one screen
carried two meanings of "received" and a refunded charge stayed booked as revenue. Both comparison
figures net too: netting only the current window would compare against a different measurement.

Every boundary resolves in the **business timezone**, in Postgres, exactly as `calendar-ranges.ts`
resolves the payments ranges below — see `calendarWindows` in `analytics.ts`. These were `utcDay` /
`utcMonth` arithmetic in JS until 2026-08-10, which mislabelled a slice of every day for any business
off UTC; the Changelog entry has the measured symptom.

### Plan mix (`subscriptions_by_plan`)
`active` subscriptions grouped by their **plan item** — the one whose product is `kind='plan'`, falling
back to the first item for a subscription that has none (charges only). Same set as
`active_subscriptions`, i.e. the ACTIVE total — which since 2026-09-17 is the figure under the tile's
headline, the headline itself being `paying_subscriptions` (MRR > 0).

It used to take `items[0]` from a query with **no `ORDER BY`**, which was wrong twice: "first" was
whatever Postgres returned, and an add-on row coming back first filed the whole subscription under the
add-on. On a 251-active-subscription book that listed `platform-additional-connections-v202604` — an add-on — as a plan,
and reported `platform-pro-v202604` at 189 instead of 190. `subscriptions-table.tsx` already resolved
the plan as `items.find(product_kind === 'plan') ?? items[0]`; the panel now uses the same rule, so the
list screen and the dashboard agree on what a subscription's plan is.

Each row's count links to Subscriptions filtered `plan[is]=<product>&status=active` — the same set the
row counts, verified equal row by row. The rolled-up **Others** row and the `Unknown` bucket do not
link: neither names a single plan, so no filter value would open a list that agrees with the number.

#### `windows` — the deep links behind the figures
The highlighted figures on this strip are **clickable**. The payload carries
a `windows` block holding the *list filter values* for each period, as local dates:

```jsonc
"windows": {
  "today":      { "on": "2026-08-10" },
  "yesterday":  { "on": "2026-08-09" },
  "this_month": { "after": "2026-07-31", "before": "2026-09-01" },  // after X = >= X+1d, before Y = < Y
  "last_month": { "after": "2026-06-30", "before": "2026-08-01" }
}
```

They come from the same `calendarWindows` result the KPIs are summed over, so a link and the figure
above it **cannot drift apart**. The client must never recompute them — a browser resolving "today"
from its own clock sends a different day than the figure was counted over, and the list then opens on
a total that contradicts the number just clicked.

| figure | opens | why that column |
|---|---|---|
| Signups (all four) | Customers, `created_at` in the window | the KPI counts the same column; the list's record count **is** the number clicked |
| Revenue → Received (this month, today) | Transactions, `occurred_at` in the window + `status=success` | `occurred_at` is when money moved; `created_at` is when the row was written, and an imported book shares one of those across its whole history |

`occurred_at` was added to the transactions list filters for this (`modules/transactions/service.ts`)
— it had only `created_at`, which no revenue figure is summed over.

The revenue link shows every settled payment **and refund** in the window, i.e. exactly the rows the
net figure is built from. It does not restate the net total: the list has no `type IN (…)` operator, so
it cannot sum one side against the other. `Expected` and the muted comparison figures are deliberately
**not** links — Expected counts invoices rather than transactions, and the muted figures are not
accent-coloured, so linking them would contradict what `--primary` promises.

## Payments analytics (Transactions + Payment Intents dashboards)
`computePaymentsAnalytics` (`payments-analytics.ts`) is the **payments** counterpart to the read above
— the Dashboard tab on `/transactions` and `/payment_intents`. Same series shape
(`headline.value`/`prev_value`/`prev_label` + `points[]`, plus `headline.change_bps` for the
"+63.4% vs Previous Week" delta), so one UI block consumes both reads; entirely different measures.

**Calendar-relative ranges** (`calendar-ranges.ts`) live *alongside* the rolling `daily|3m|6m|12m`
vocabulary — "the last 60 days" and "this month" are different questions and neither can be relabelled
as the other:

| range | window | previous period | buckets |
|---|---|---|---|
| `current_day` | today | yesterday | 24 hourly |
| `yesterday` | yesterday | the day before | 24 hourly |
| `this_week` | Mon→Sun containing now | the week before | 7 daily |
| `previous_week` | the week before that | the week before it | 7 daily |
| `this_month` | calendar month | last month | 28–31 daily |
| `last_month` | the previous calendar month | the month before it | 28–31 daily |

Every boundary resolves in the **business timezone** (`platform/business-tz.ts`), in Postgres:
`date_trunc(unit, now AT TIME ZONE tz) … AT TIME ZONE tz`. Interval arithmetic happens on the *local*
timestamp, so a DST week keeps its wall clock (and is legitimately 23 or 25 hours long as an instant
span) and Postgres owns the DST rules rather than JS. `previous.end === current.start` by construction
— the two windows tile, so February is compared against January and not against "28 days ago", and both
periods are read in ONE index range scan separated by a `CASE` on `occurred_at`.

| Series | Definition |
|---|---|
| `gross_volume` | Σ `transactions.amount_minor` where `type='payment' AND status='succeeded'` |
| `refunds` | Σ where `type='refund' AND status='succeeded'` |
| `chargebacks` | Σ `disputes.amount_minor`, by `opened_at` |
| `net_volume` | `gross_volume − refunds − chargebacks` |
| `transaction_count` | every `transactions` row in the period, any type/status |
| `successful_payments` | count of `type='payment' AND status='succeeded'` |
| `failed_transactions` / `failed_amount` | count/Σ of **failed charge attempts** |
| `failure_rate` | failed ÷ (succeeded + failed) charge attempts, in **basis points** |
| `pending_payment_intents` | intents created in the period still `inited`/`in_progress` |

A **charge attempt** is `type IN ('payment','authorization')` — a failed *refund* is an operational
error, not a decline, so it stays out of the failure family (still inside `transaction_count`). FAILED
is `status IN ('failed','late_failed')`; `timeout` and `needs_attention` are in NEITHER side of the
failure rate because their outcome is unknown and counting an unknown as a decline overstates it.

**Breakdowns** — by error cause (`error_code`), by payment-method type, by `gateway_key`; each carries
the current AND previous period so the "this period vs previous" columns need no second request, and
each sums exactly to the tile above it (`verify:payments-analytics` asserts every sum). **Filters** —
`gateway` + `payment_method`; `unknown` is a real selectable value (offline payments have neither).
Filter *options* are deliberately NOT narrowed by the active filter.

Unlike the Business Home read this one aggregates **in SQL** (7 grouped queries, each bounded by the
distinct dimension combinations present, not by row count) — `transactions` is the fastest-growing
table in the product and loading it into JS was never going to hold.

## Scale
Derived-on-read is a deliberate choice, not an oversight — but it is the part of this module with a
ceiling. Per request the service loads **every** subscription + item, and every invoice, transaction
and credit note the business has ever had (the all-time Net Billing / Net Payments KPIs need the full
history), then reconstructs stock metrics in JS at O(buckets × subscriptions).

Measured on a 205-subscription / 258-invoice / 276-transaction book: **~64 ms** (`daily`), ~42 ms
(`12m`), in-process. That is fine, and Postgres alone stays fine for a long time.

Escalation ladder, cheapest first — take a step only when a measurement says to:
1. **Push the aggregation into SQL.** `date_trunc` + `GROUP BY` for the flow series and running sums
   for the stocks, so Postgres returns ~60 rows instead of shipping the history to Node. Biggest win
   per unit of work; no new infrastructure, no new source of truth.
2. **Cache the response** per (business, range, currency) for a minute or two. The dashboard is
   re-rendered far more often than the numbers change, and `as_of` already tells the user the age.
3. **Materialize the all-time KPIs** — a small per-business running-total row updated on invoice /
   transaction / credit-note write — so the unbounded scans disappear while the windowed series stay
   derived.
4. **Add a daily MRR snapshot table** (see the gotcha below). This one buys correctness, not just
   speed: it is the only way to get *true* historical MRR.
5. A separate analytics store / OLAP engine is only warranted if reporting starts competing with
   billing for the primary's resources, or the product grows cohort/funnel analysis over years of
   history. A read replica pointed at by this module handles the "don't disturb billing" half of that
   without a second data model.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `computeBusinessMetrics(orgId, businessId, now)` | per-currency metrics + `converted` FX roll-up + movement |
| `computeBusinessAnalytics(orgId, businessId, { range, currency, now })` | Business Home KPIs + series + plan mix |
| `computePaymentsAnalytics(orgId, businessId, { range, currency, gateway, paymentMethod, now })` | payments dashboard: volume/refunds/chargebacks/failures + breakdowns |
| `resolveCalendarRange(tx, businessId, range, now)` | a calendar range + its comparable previous period, in the business tz |
| `resolveBuckets(tx, period, tz, granularity)` / `bucketKeySql(col, tz, granularity)` | chart buckets + the matching `GROUP BY` expression |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/businesses/:biz/metrics` | business metrics (per-currency + converted) |
| `GET /v1/businesses/:biz/analytics?range&currency` | Business Home dashboard payload |
| `GET /v1/businesses/:biz/payments_analytics?range&currency&gateway&payment_method` | payments dashboard payload |
| `GET /v1/metrics` | org-wide roll-up by currency |

## Events emitted
None.

## Dependencies
- **Upstream (calls into):** catalog.
- **Downstream (called by):** migration, subscriptions.

## Invariants & gotchas
- **Every source read passes its customer column through `reportableCustomer`** (`reportable.ts`,
  0482). A new read without it counts internal and test accounts the operator excluded.
- MRR must rate from the **item price snapshot**, not the live catalog price (a past bug rated ₹42,415
  instead of the true ₹83,084/mo by ignoring sub-level overrides).
- Money is never summed across currencies; the only cross-currency total is the FX `converted` roll-up,
  and only when rates cover every currency (else `missing_rates` lists the gaps).
- **`total_mrr` at `as_of` must equal the MRR KPI**, which must equal `computeBusinessMetrics`' MRR.
  `verify:metrics` asserts the chain. That constraint is why **paused** subscriptions contribute 0 for
  the entire historical window: the point-in-time definition excludes them and we keep no pause
  history, so pretending they were live in the past would break the identity.
- Historical MRR can't see mid-life plan changes or pauses — a subscription contributes today's MRR for
  its whole life. Real historical MRR needs a daily snapshot table (§ Scale, step 4).
- Currency scoping reaches counts too (active subscriptions, plan mix, cancellations) — but **not
  signups**: a customer's `currency` is only a preference and is usually null, so scoping signups by it
  would zero the series. Signups are always the whole business.
- Churn rate divides by the base **exposed** to churn (live at window start + started during it), not
  by live-at-start alone: on a young business almost every subscription is created inside the window,
  and live-at-start alone reports ~100%.
- Org-level `converted` roll-up on `GET /v1/metrics` is a backlog item (per-business `converted` exists).
- Payments analytics: a currency with no FX rate is dropped from **both** the money and the counts of a
  converted roll-up, so a tile never pairs a partial count with a partial sum. `missing_rates` says so —
  and it must, because that list is the UI's ONLY disclosure. So `available_currencies` unions the
  currencies of all three money sources (`transactions`, `disputes`, `payment_intents`), not just
  transactions: disputes are windowed by `opened_at`, so a chargeback in a rateless currency can be the
  only row of its currency in the period and used to be excluded with no warning at all.
- Payments analytics: `pending_payment_intents` is a *status snapshot over a creation window* — an
  intent created before the period and still pending is not counted, because the period is what the
  dashboard scopes. `payment_intents` has no failed state (`inited|in_progress|authorized|consumed|
  expired`) and `transactions` has no `payment_intent_id`, so **failures cannot be attributed to an
  intent**; `failed_amount`/`failure_rate` are transaction-level, which is the only honest reading.
- Payments analytics weeks start on the business's `week_start` (0293, default **Sunday**):
  `date_trunc('week', t + 1 day) − 1 day` for a Sunday week (`weekTruncShift`).

## MRR movement ledger (`mrr_movements`, 0254)

`subscriptions.mrr` is a **stock**: what a subscription earns now. Every recurring-revenue
report asks a **flow** question instead, and flow is not recoverable from lifecycle timestamps —
an upgrade, a downgrade, a pause and a 100%-off coupon all leave a subscription looking exactly
as live as before. So each change to the stored rate appends a row.

**One writer.** `recomputeSubscriptionMrr` is what every mutation path already funnels through,
so the ledger is written there and nowhere else; a second writer would be a second definition.
`createSubscription` is the single exception and records its own opening move, because it writes
`mrr` in the INSERT that creates the items. The **importer deliberately does not write** — an
imported book is seeded by `scripts/backfill-mrr-movements.ts` instead, at the dates things
actually happened.

**The identity.** A row is appended only when the value moves, so **Σ `delta_minor` over a window
= the change in MRR across it**. `verify:mrr-movements` checks that against `subscriptions.mrr`
itself, not against another reading of the same rows. It is also why `pause`/`resume` are their
own reasons rather than dropped rows: a report may decide a pause is not churn, but a ledger
cannot decide it did not happen.

| reason | when |
|---|---|
| `new` | first revenue this subscription ever carried |
| `expansion` / `contraction` | rate moved up / down while already earning |
| `churn` | fell to 0 **and** the subscription is cancelled |
| `pause` / `resume` | fell to 0 on a pause; came back on a resume |
| `reactivation` | back above 0 after an earlier churn |

Revenue reaching zero on a subscription that is **still running** (a full discount, every paid
item removed) is a **contraction**, not churn — churn would claim a customer we still have.

Append-only is granted, not merely documented: the app role holds `SELECT, INSERT` and nothing
else, exactly as for `ledger_entries`.

### Retention (`kpis.retention`)
Computed over the **last complete calendar month** — not the month in progress, whose churn has
not finished happening, and not the range selector's window, which would make the figure mean
something different each time someone changed the chart above it.

```
GRR = (start − contraction − churn) ÷ start
NRR = (start + expansion + reactivation − contraction − churn) ÷ start
quick ratio = (new + expansion + reactivation) ÷ (contraction + churn)
```

`new` is absent from both retention rates on purpose: they ask what happened to the base we
already had. Every rate is **null** when its denominator is zero — a rate over nothing is
undefined, and 0% would read as total churn. The arithmetic lives in `retentionRates`
(`mrr-movements.ts`) so it can be checked against known numbers rather than through a fixture
staged a month in the past.

Five flow series ride alongside: `total_new_mrr`, `total_expansion_mrr`,
`total_reactivation_mrr`, `total_contraction_mrr`, `total_churn_mrr` (losses carried as positive
magnitudes — every consumer states them as an amount lost).

**Backfill honesty.** History is not stored, so the backfill can write at most two rows per
subscription: `new` at its start and `churn` at its cancellation. Every upgrade, downgrade, pause
and discount before the cutover is invisible, so a backfilled book reports **no** expansion or
contraction for those months and its retention rates there are flattering. The months after the
cutover are the real ones.

## Segmentation: movement by plan (0256/0257)

"Expansion is up" is the beginning of a question. `mrr_movements.plan_product_id` answers it:
each movement stores the plan the subscription was on **when the money moved**, resolved by the
writer.

Stored rather than joined, because a join cannot reproduce it: after an upgrade the subscription
is on a different plan, and that change is exactly the movement being explained. Null for a
charges-only subscription, which groups under "No plan" in the breakdown rather than being
dropped — a breakdown whose parts do not sum to the whole is worse than one with an awkward row.

`resolvePlanProductId` (`plan-of.ts`) is the single rule: the first item whose product is
`kind='plan'`, else the first item, ordered deterministically. Three screens used to answer this
question and one of them answered it differently (see the plan-mix note above).

⚠️ **`createSubscription` records its opening move AFTER the items insert.** The resolver reads
items, so recording earlier files every first sale under "no plan". `verify:mrr-movements` pins
it.

⚠️ **The grant had to be narrowed, not widened.** 0254 grants `SELECT, INSERT` only, and the
backfill for the new column hit `permission denied` — the grant working as intended. 0257 grants
`UPDATE (plan_product_id)` and nothing else: Postgres checks column privileges per column
touched, so the amounts, the reason and the timestamps remain un-writable.

Read as `kpis`-adjacent `mrr_movement_by_plan` on the analytics payload, over the same month as
the retention rates, sorted by **absolute** net — a plan that lost $40K deserves the same place in
the eye as one that gained it.

## Daily stock snapshots (`mrr_snapshots`, 0255)

The reconstruction above is correct by construction and costs the same whether a page asks for
one figure or thirty — which is what stops a report catalogue being affordable. A snapshot pays
that cost **once a day** and leaves the reconstruction in place as the thing snapshots are
checked against.

- **One row per business, per day, per currency**, holding MRR, CMRR, active and paying counts.
  Never converted: FX is a reporting choice made at read time, and a figure stored at yesterday's
  rate is a number nobody can reproduce.
- **Written by `metrics_daily_snapshot`**, cron `20 0 * * *` on its own `metrics_snapshot` queue.
  It walks only businesses that HAVE a subscription — one with none produces nothing, so those
  passes were pure cost (measured on the dev database: 19,945 businesses, 15,744 of them with a
  subscription, ~108s for the pass).
  It writes **yesterday** — a day still in progress would be restated by every later run — and
  each business independently, so one failure does not cost the estate its day.
- **Upserts on (business, day, currency)**, so a re-run after a late backdated change restates
  rather than duplicating. `UPDATE` is granted here, unlike the movement ledger: a snapshot is a
  derived restatement, not a record of something that happened.
- **Read as a cache, never as a replacement.** The `total_mrr` series serves a bucket from the
  stored day when there is one and reconstructs when there is not, so a business whose snapshots
  have not run yet reads exactly as it did before. The KPIs stay on the reconstruction — they are
  two instants, not sixty, and one of them is `now`, which no snapshot describes.

**Both readers share one definition.** `stocks.ts` holds the point-in-time predicates —
`liveAt`, `isActiveAt`, `committedAt`, `commitmentEnd` — and analytics and the snapshot writer
both call them. A second copy is how "MRR" and "MRR as of yesterday" drift apart.

⚠️ **`committedAt` needs `created_at <= at`**, and that guard exists because this predicate is now
evaluated BACKWARDS. A commitment starts when the subscription is signed, not when it starts
billing; without the guard a snapshot of a day before the business had any subscriptions counted
today's whole book as committed then. `verify:mrr-snapshots` is what found it.

⚠️ **A cancelled subscription is re-rated, not read from the column.** `subscriptions.mrr` is
deliberately 0 once a row is cancelled, so summing the column verbatim made every past day lose
the rate a subscription was actually being billed — last year's MRR fell whenever something
churned today. `loadReratedMrr` re-rates those rows through `reportingMrrBySubscription`, the same
rule analytics reads. It is bounded to the cancelled rows LIVE on the day being computed (CMRR
excludes cancelled outright and the active count reduces to `liveAt` for them), and the totals,
plan and country passes share one `SnapshotMrrCache` so the slices cannot disagree with the total.

⚠️ **A backfilled day still carries TODAY's composition.** The re-rating prices a cancelled
subscription from its surviving items, so one whose plan changed before it churned is measured at
its final rate; the customer's country is likewise read as it stands now. We keep no composition
history. Same limit as the movement backfill, same reason.

## The report layer (Phase 3a — `reports/`)

A reporting product is ~100 metrics with several cuts each. Written as one query function and
one route per report that is ~200 files nobody keeps consistent — and the first thing to rot is
what makes them comparable: the window, the conversion, the comparison period. So **a report is
a declaration** (`reports/registry.ts`) and a handful of resolvers (`reports/resolve.ts`) turn
each declaration into an answer.

```
{ key, name, description, category, kind, source, shape, dimensions, reasons?, measure?,
  multiplier?, formula?, variants? }
```

- `source` picks the resolver: **`movement`** (flows from the ledger), **`stock`** (the book at
  an instant, snapshots with reconstruction behind them), **`derived`** (arithmetic over both),
  and then the document sources — `invoice`, `transaction`, `subscription`, `scheduled`,
  `payment_method`, `payment`.
- `shape` decides the window: `flow` sums each bucket, `stock` measures at each bucket's end,
  `forward` projects ahead.
- `multiplier` is how the whole ARR family exists without a second resolver: ARR is MRR × 12.
- `variants` hang the other cuts off the metric, because that is how people look for them.

**The rule to protect: adding a report should be an entry in that file.** When a request cannot
be expressed, widen the declaration — another `source`, another `shape` — rather than writing a
one-off query beside the others, because the one-off is the one that will use a different month
boundary.

**`granularity`** (`day` | `week` | `month`) is independent of `range`. Each preset keeps its own
default (daily→day, 3m/6m→week, 12m→month), so an untouched URL answers exactly as before; an
override re-cuts the preset's own span and CLIPS every bucket to it, so an edge bucket is a partial
week rather than a wider window. It is **refused (400)** — never ignored — on any shape with no
series to re-cut (`buckets`, `cohort`, `periodic`, `derived`, `scheduled`, and any `noSeries`
report), because honouring it silently would let a reader believe a table had been re-cut.
`acceptsGranularity()` in the registry is the predicate, and the gate asserts it is IDENTICAL to
the "owes a series" predicate, so the catalogue can never offer a cut a resolver ignores.

**Cash split by what it paid for** (`source: "payment"`) closes the last asymmetry between the
billing side and the cash side. `payments` is invoice-level, so until now we could say what was
BILLED as recurring and nothing about what was COLLECTED as recurring. Five reports —
`recurring_payments`, `net_recurring_payments`, `non_recurring_payments`, `usage_payments` and
`cash_composition` — place each payment's cash on the invoice lines it settled, via
`modules/payments/attribution.ts`. Nothing is stored: the split is arithmetic over the lines, so
it cannot go stale when an invoice is regenerated and it covers all thirteen `insert(payments)`
sites the day it ships. Allocation is **pro-rata, never a priority rule** (a priority rule makes
the recurring share of a half-paid invoice 100% until the plan line is covered, overstating
recurring cash on exactly the dunning-stressed invoices these reports get asked about), with
largest-remainder rounding so **Σ allocations = the payment, exactly**.

⚠️ **These do not sum to `total_payments`, by construction.** That report sums `transactions` —
what the gateway moved — and these sum `payments` — what was applied to a document. The two agree
on a book this engine billed itself and diverge on a payment with no transaction row and on an
imported transaction that settled several invoices, where the importer deliberately stores the
applied amount on the payment and the full amount on the transaction. Each is right about its own
question; neither is a check on the other, and `verify:payment-allocation` §8 asserts the
composition against the payment rows for that reason. Plan is **not** offered as a dimension: a
plan would be resolved from the subscription's items as they are NOW, so cash collected against a
plan the customer has since left would be filed under the current one — the movement ledger stores
the plan with the row precisely because that is not good enough.

**Segmentation** (`country`, Phase 4c) splits a figure by a bounded, stored customer ATTRIBUTE — a
**dimension** — and narrows it with a **customer filter**, a predicate over those dimensions
(`customer_filter=country:DE`, `country:DE,IN`, `country:unknown`). The two words are kept apart on
purpose: `list_views` already calls a saved filter set over a LIST a "segment", and one word for two
things would make every screen ambiguous. Stocks read `mrr_snapshot_countries` (0263, `NULLS NOT
DISTINCT` so the Unknown bucket upserts); flows join the movement to its customer at read time. **Σ
over the dimension equals the unsegmented figure exactly, NULLs included** — verified on the real
book (INR 1,888,485,650 = IN + Unknown; USD 64,906,322 = US + IN + Unknown). A filter the stored
dimensions cannot express is REFUSED by name, never answered by rebuilding the book per slice on
every read, and a report without the dimension refuses it too. Within one currency the identity is
exact; a converted (`ALL`) report rounds each row on its own conversion, the same pre-existing
property the plan breakdown has.

**Raw-data export** (`export/`, Phase 4e) serves the ROWS behind a figure — movements, invoices,
payments, refunds — each dataset declaring the report key it reconciles with. Its window comes from
`buildBuckets`, the report layer's own bucket builder, so an export and the report it explains
cannot disagree about where the period started. Keyset pagination, CSV streamed a page at a time.
Every row carries its native amount, its currency, the rate used and the converted figure beside it,
and **no field anywhere carries a cross-currency total** — a sum of INR paise and USD cents is
meaningless and the gate asserts the number a naive sum would print appears nowhere. See
`export/README.md`.

**The ageing ladder takes an interval** (`aging_interval=standard|7|15|30|60`), declared and refused
exactly like `granularity`. The rung NAMES carry their own boundaries, so the `ar_bucket` drill-down
parses a rung rather than matching a fixed list and therefore works at every interval — the filter
takes no interval parameter, which is what stops the two definitions drifting. `standard` is the
historical ladder verbatim and is byte-identical to what shipped before; re-bucketing moves rows
between rungs and never changes the total (Σ = 1,859,083 at every interval on the dev book).

**FX decomposition** (0264). `exchange_rate_history` is an append-only log of observed rate changes
(`GRANT SELECT, INSERT` only, `rate` nullable so "no usable rate" stays distinct from parity). The MRR
waterfall converts each period at the rate in force at its close, falling back to the CURRENT rate
where history has nothing earlier — so an empty or freshly-seeded log reproduces today's figures
exactly and nothing is restated. FX is the remainder that makes `opening + net + FX = closing` hold
per row, and it is NOT a movement reason: `mrr_movements.currency` is the subscription's own currency,
in which an FX movement is exactly zero. ⚠️ Historical conversion is applied to the waterfall ONLY —
every other report still converts at the current rate, so once real history accrues an earlier
waterfall opening will legitimately differ from a current-rate conversion of the same instant.

**Account Summary** is a `periodic` report whose row must reconcile:
`net = gross billing − discounts + taxes − credit notes − written off`. Gross billing is DERIVED
per invoice as `document total + discounts − taxes` with each term converted independently, so the
row never rests on an assumption about how a document total was composed and survives FX rounding.
Tax sits inside net because it sits inside both the document total and the credit note. Two columns
were **dropped rather than shipped broken**: *voided* (a voided invoice never entered gross
billing, and voiding can happen months later, so the two would sit on different rows) and *amount
recovered* (a payment settles an earlier month's invoice) — both exist as their own reports. The
gate asserts the identity on every row AND that Σ(gross − discounts + taxes) equals the
`total_billing` report over the same months: two answers to "what did we bill" is what this layer
exists to prevent.

**Customer-grain reports count SETS of customer ids**, rebuilt per window, never sums of
subscription rows. *New* is a customer whose FIRST movement of any kind falls in the window — an
existing customer opening a second subscription is expansion of an account we already had, not a
new one. *Churned* requires a `churn` movement AND that the customer's own running total is still
≤ 0 at the window's end: cancelling one of three subscriptions is not a lost account, and a pause
is suspension rather than departure. ⚠️ A distinct count **does not sum across buckets** — 280
customers churned over a window whose months add to 279, because one churned twice.

**FX is on the record** (0260): `mrr_movements.exchange_rate` + `exchange_rate_base`, stamped in
the same INSERT as the movement from the same resolver the invoice stamp uses, so a movement and an
invoice raised the same minute cannot disagree. The rate is "units of THIS row's currency per 1 unit
of the base", matching `businesses.exchange_rates`'s own convention. An own-currency row stores `1`
(parity is a fact); a currency with no configured rate stores NULL (missing is not parity). No
UPDATE grant, so it cannot be rewritten — and the backfill deliberately does NOT fill it, because
`exchange_rates` holds TODAY's rates and stamping today's number on a two-year-old movement would
manufacture the false provenance the column exists to end. What it does NOT do yet: FX is not a
movement reason of its own, and the reports still convert at read time.

**Per-plan snapshots** (0261, `mrr_snapshot_plans`) are a SEPARATE table, not a nullable column on
`mrr_snapshots`: the total and the breakdown are different grains, and mixing them means a query
that forgets `plan_product_id IS NULL` sums the total AND every plan. `plan_product_id` is a real
bucket (NULL = no plan) so the parts still sum to the whole, and the unique index is
**`NULLS NOT DISTINCT`** — without that, the no-plan bucket duplicates on every write instead of
upserting. **The backfill is bounded by shape, not by a smaller number of days.** It writes every day for
`--dense-days` (60 by default) and then only MONTH-ENDS going back, because the charts bucket by
month beyond about eight weeks (`RANGE_SHAPE`: 3m/6m weekly, 12m monthly) — a daily row from March
answers a question no screen asks, and a stock series is measured at each bucket's END, so a
month-end row is exactly what a monthly bucket reads. `--days 400` therefore visits **71** days,
not 400: measured on the real book, 110 total + 419 per-plan rows instead of the ~2,400 an
unbounded pass would write. `--every-day` restores the old behaviour for anyone who wants it.

**Seven sources.** `payment_method` joined the six for the card-expiry reports, which are counts
about NOW and draw no series: we do not keep the history of a card's status, and a twelve-month
line would imply we did.

Three formulas worth stating, because each has a defensible choice inside it:
- **ARPS** divides MRR by the PAYING count, not the active one — a free subscription drags the
  average down without earning anything.
- **LTV** is ARPS × the average life of a subscription that has ENDED. Only ended ones have a
  life to measure; including the living reports a young book as short-lived. Null until something
  has churned, because a lifetime with no completed lifetime in it is a guess, not an estimate.
- **Upcoming renewal amount** rates each cycle falling due at `mrr × months-per-cycle`, so an
  annual plan renewing once is worth twelve months of it. Before tax, usage and any discount that
  has not started — the invoice the engine raises is the authority and this is a forecast, which
  the report's own description says.

**Total Subscriptions** is the one count that filters by neither status nor time. That is what
makes it different from the active count beside it, and it is why the gate compares it against a
LIVE instant rather than the suite's frozen `now`.

**Categories and tags are different things.** A report has ONE `category` — its home in the
grouped catalogue — and any number of `tags`, because the questions people arrive with cut across
the grouping: "everything about tax" spans billing and receivables; "what is committed" spans
recurring revenue and churn. Tags drive FILTER chips, never a second grouping — a list grouped on
tags prints longer than the number of reports in it, with the same report under five headings.
One chip at a time: "billing AND leakage" is not a question anyone arrives with, and an
intersection that returns nothing looks broken. `TAG_LABELS` is the vocabulary, and the payload
carries each report's tags WITH their labels so the client keeps no copy — a copy is how a
catalogue offers a filter the engine has dropped. `verify:reports` pins that every tag is known,
every declared tag is used, and every tag narrows the catalogue without emptying it.

**Endpoints**: `GET /v1/businesses/:biz/reports` (the catalogue — declarations, so the UI renders
reports it has never heard of) and `GET …/reports/:key?range&currency&group_by`, answering a
uniform `{ headline, points[], rows?, window_label? }` for every key. `/analytics` is untouched.

⚠️ **Two calendars is the failure mode, and it happened on the first run.** The resolver cut its
month in UTC while the dashboard cuts it in the BUSINESS timezone; on an Asia/Kolkata book the
same ledger produced a quick ratio of 5.67× on one screen and 6.09× on the other. Both now call
`calendarWindows`, and `verify:reports` runs its fixture on a non-UTC business so a regression
fails there rather than in someone's board pack.

**Six sources, 60 reports.** `movement` and `stock` were joined by `invoice` (billing, tax,
leakage, ageing, dunning), `transaction` (payments, refunds, error summaries), `subscription`
(counts, trials, conversion, lifetime) and `scheduled` (the forward book). `shape: "buckets"`
answers with ROWS instead of a series — an ageing ladder is a report ABOUT its buckets, so the
bucketing is the report's definition and lives in the resolver, not the client.

**Dimensions**: `plan` (from the ledger's stored plan) and `currency` (wherever rows carry one).
A per-currency breakdown keeps each row in its OWN currency — converting first and labelling the
row with the source code would print dollars under another code. Derived rates take no
dimensions: a rate is already a ratio of converted figures, and splitting it would put four
denominators in one table.

**CSV** comes from the same resolver (`?format=csv`), so a downloaded report and the screen it
came from cannot disagree. The dashboard proxies it as the signed-in operator.

⚠️ **A booked cancellation lives on the SUBSCRIPTION**, not in `scheduled_changes`: this engine
records `cancel_at_period_end` or a dated `cancel_scheduled_at`. Reading only the scheduled-changes
table reported **0** on a book where CMRR was excluding $29.68K/month of exactly those. The report
now uses `isBookedToStop` — the same predicate CMRR uses — and `verify:reports` pins the identity
**scheduled cancellation MRR = MRR − CMRR**.

⚠️ **Upgrade vs expansion needs the from-plan.** A movement with no `previous_plan_product_id`
(written before 0258, or a first sale) is EXCLUDED from the upgrade/downgrade reports rather than
assumed unchanged — counting it as "same plan" would quietly file every historical upgrade as
expansion, which is the confusion the column was added to end.

**The waterfall** (`shape: "periodic"`) answers with a TABLE: a row per month, thirteen columns
from `opening` to `closing`. The movement columns **partition** the ledger — `new`,
`free_to_paid`, `upgrade`, `expansion`, `reactivation`, `resumed`, `downgrade`, `contraction`,
`paused`, `churn` — so every movement lands in exactly one and the row reconciles by
construction. That is why `expansion` means expansion WITHIN a plan: an upgrade is expansion
that also changed plan, and counting it in both would make the book add up to more than it is.
A movement with no from-plan falls to `expansion`/`contraction` rather than being guessed into
`upgrade`/`downgrade`. A first sale on a subscription that ran a trial is `free_to_paid`, not
`new` — a funnel question and an acquisition question are different questions. It is the
report a finance reader actually opens, and it is worthless unless the row adds up, so **every
column comes from the ledger** — opening and closing as the running sum of deltas up to that
instant.

⚠️ The first cut read opening and closing from the SNAPSHOT reader while the middle columns came
from the ledger, and the row was out by **$142.76** on the dev book: those snapshots were
backfilled at today's rates while the deltas are what actually moved. Mixing two sources in one
row is how a waterfall stops adding up. `verify:reports` asserts the identity on every row, that
`net = closing − opening`, that the headline IS that closing figure — it was read by hardcoded
index once, and widening the table from 8 columns to 13 moved the index, so the page showed
$0.00 for a book worth $855K — and that this month's closing equals the MRR KPI — the waterfall and
the dashboard cannot be two different books.

**Cohorts** (`shape: "cohort"`) answer with a GRID: one row per intake month, one column per
month since, cells as basis points of that cohort's opening figure. They are reconstructed from
the ledger — a subscription's MRR at an instant is the sum of its own deltas up to it, which is the
identity the ledger is built on, so a curve is EXACT for anything the writer recorded. Two rules
the table depends on: a month that has not begun is **null**, never 0 (0 reads as total churn on a
cohort that is simply young), and the month in progress is measured as it stands rather than
dropped. A backfilled subscription carries only a start and a cancellation, so its curve is flat
until it churns — the months after the cutover are the real ones.

⚠️ **Scheduled upgrade/downgrade MRR is an ESTIMATE**, taken when the change was scheduled:
gross of discounts, rated from the catalogue at that moment, never restated if the subscription or
catalogue moves before it lands. The report's own description says so — a figure that looks
measured and is not is worse than a missing one.

## Changelog
- **2026-11-03** — **A backdated row restates its own day, however old.** The nightly
  `metric_daily_restate` pass also restates any day older than the 35-day trailing window that
  gained a `transactions` or `mrr_movements` row (by `occurred_at`) after the day was stored
  (`lateDays`): an offline refund or payment with a past date, a backdated cancel or
  reactivation. Writes from the last 30 days are looked at, up to 60 days per business per
  night, with their coarse periods. Before this, such a day stayed stale until a drift-scan
  sample happened to land on it. `verify:metric-maintenance` §3.
- **2026-11-02** — `cancellation_saves`: the share of portal cancel flows that ended in a taken offer (saves ÷ saves + cancellations after offers), one row per offer, from `retention_events` (0483). A cancel of the same subscription within 30 days revokes a save. Reads pass `reportableCustomer`.
- **2026-11-02** — Restatements replace whole measures (`writeMetricDay({ replaceMeasures })`,
  `bulkFill*({ replaceComputed })`): each period's owned measures are deleted and rewritten in
  one transaction, so a group that emptied disappears. Live-state measures (`asOf: computed_at`)
  are owned only for the period in progress. Used by `restateMetricsFrom` and the timezone
  recompute.
- **2026-11-02** — Exclusion review fixes: disputes, saved-card expiry (daily measure and report)
  and scheduled changes read through the reportable predicates too. A flag change restates in
  place from the customer's first day (`reportingSpanStart` → `metric_daily_recompute { since }` →
  `restateMetricsFrom`): days then coarse periods are rewritten, nothing is deleted first, so no
  grain reads empty during the job.
- **2026-11-02** — **A customer can be excluded from reporting (0482).** Every source read passes
  its customer column through `reportableCustomer` (or `reportableSubscription` /
  `reportablePayment` / `reportableInvoice`, `reportable.ts`): analytics, service, snapshots,
  cancellations, payments analytics, usage margin, daily measures, reports and exports, plus
  `payments/attribution.ts`. The movement matview is estate-wide, so a book with an excluded
  customer reads the filtered ledger (`loadMovementCells` → null). A flag change runs
  `restateReportingForBusiness`: series cache dropped, `metric_daily_recompute` for the days and
  for week/month/quarter/year. Checkout funnel and recovery reports are not filtered: a
  checkout session has no customer column. Gate: `verify:settings-invoices-org` D.
- **2026-11-02** — `checkout_conversion` and `checkout_payment_failures` (variants of
  `checkout_funnel`): completion rate and refused-attempt rate in basis points over create and
  purchase checkouts first viewed in the window, one row per layout × device. A segment with no
  base is left out rather than shown as 0%. Source: checkout 0478 tracking columns.
- **2026-11-02** — **Business Home GRR and NRR follow the opening-cohort rule.** `kpis.retention`
  summed every expansion, reactivation, contraction and churn of the last complete month, so a line
  that started mid-month and then upgraded or cancelled moved the rate. The reports' derived path
  and the stored measures already restricted those moves to lines with a ledger balance above zero
  at the previous close; Business Home now does the same (one grouped read over the whole ledger
  for the lines that moved). The quick ratio and the month's flow amounts are unchanged.
  `verify:reports` pins it: a mid-month line that churns read GRR 0% on Business Home and 50% in
  reports; both now read 50%.
- **2026-11-02** — CMRR no longer fills a started subscription's unbooked past with today's rate.
  `committedMrrOf` takes `started` (`startOf(s) <= at`) and uses the `rated` fallback only before
  the start — a future start, as intended. A trial imported without ledger rows, cancelled, then
  reactivated (first movement weeks later) counted its current rate on every day back to creation
  and fired `metric_daily_reproducible`. Stored history needs a CMRR restatement after deploy.
  `test/unit/cmrr-past-days-use-the-ledger.test.ts`.
- **2026-10-24** — A raw-export CSV (`GET …/raw_export/:dataset?format=csv`) writes a `data.export`
  audit row before the file streams. JSON pages are not audited (one export is many pages).
- **2026-10-24** — `monthlyRecurringMinor` excludes every metered price (`isMeteredPrice`):
  usage, and a percentage or graduated percentage price with a usage aggregation.
- **2026-10-24** — **An organization reads every business at the same day.** Org scope cut
  its window on the organization's zone, so once an Asia/Kolkata business had written tomorrow's
  row the last day bucket held that business alone, and the stock total (`last` non-null point)
  read it as the organization's MRR: $3.02K "down 93%" for a true ~$46K. `scopeToday` is now
  the EARLIEST local today of the scope's businesses (`AnalyticsScope.zones`); a named window
  ends on it, and `readMetricSeries({ through })` reads no day row past it, so a period past it
  is `missing` (unknown), never a partial sum. The previous window derives from the same window,
  so the change compares every business at the same local dates. Flows follow the same days: a
  business's in-progress day joins once every business has reached it. `today` is now derived
  from the answer's `now`. Business scope is unchanged. Gate: `verify:metric-daily-tz` §9
  (mutation-tested).
- **2026-10-24** — **Home's net-new row adds up, and the MRR line starts at the opening.** The
  row summed only the four flows while `net_new_mrr` signs every ledger reason (pause, resume),
  and the chart started at the first bucket's END while its header read from the opening.
  `netNewParts` (`home/parts.tsx`) adds Paused and an Other remainder, `—` when the answers'
  `coverage` differs; FX stays out because it is not in `net_new_mrr`. `stockPoints`
  (`series-format.ts`) leads a stock's line with `compare.previous_total`. Both apply to Home,
  the organization Performance zone, and (the line) a board's trend tile.
- **2026-10-16** — `checkout_reminders` (count: reminded → completed after a reminder, `funnel: true`) and `checkout_recovered_revenue` (money: the purchase invoice or the subscription's first paid invoice, converted) — `resolveCheckoutRecovery`, over checkouts created in the window. Gate: `verify:checkout-reminders`.
- **2026-10-16** — **Checkout funnel.** New `checkout` source and `checkout_funnel` bucketing: new-subscription checkout links created in the window, counted at each step reached (created → opened → details entered → payment started → completed). A step counts sessions that went further, so the funnel never rises; plan-change links are excluded. The result carries `funnel: true`, and the report table then measures shares against the first row, not the sum. Gate: `verify:checkout-funnel`.
- **2026-10-13** — **A reactivation at zero MRR still ends the stretch it spent cancelled.** It books no ledger movement, so `loadLapses` had no `reactivation` to pair with the churn and `liveAt` counted the subscription live through the gap; the drift scan reported it as stored history that no longer matched. A live row whose last signed churn has no reactivation after it now lapses from that churn to its `start_date`, which every reactivation path re-stamps (`activated_at` is not). Regression: `verify:metric-maintenance` §2b.
- **2026-10-04** — **A reactivated subscription is not active through the stretch it spent cancelled.** A reactivation clears `canceled_at`, so `liveAt` read the row as live straight through the gap: one USD subscription churned 2026-08-19 and reactivated 2026-10-03 added +1 to the recomputed active count for every day between (the drift scan's 2812 vs 2813 on production; MRR was right, it reads the ledger). `StockRow.lapses` carries each closed `[churn, reactivation)` stretch from `mrr_movements` (`loadLapses`, signed rows only), and `liveAt`/`earningAt` exclude it; every book loader attaches them. Pause → resume gaps are not covered yet. `test/unit/reactivation-gap-not-active.test.ts`.
- **2026-10-03** — **A term-end stop leaves CMRR when it is booked, not at its final term's start.** `cancel_booked_at` was written only by the terminal cancel, so a live subscription booked to stop fell back to the final term's start: a yearly one booked on 2026-10-02 dropped USD 49 from every recomputed day back to 2025-10-22 (the drift scan's 3 × 4,900 on production). Booking a term-end or specific-date cancel now stamps `cancel_booked_at` (an earlier booking stands; a withdrawal clears it unless the row still stops), and `nonRenewingAt` reads it for live rows too. Imported bookings with no event keep the fallback. Production backfilled 35 rows from `subscription_cancel_scheduled` events. `test/unit/cmrr-booking-dated-when-booked.test.ts`.
- **2026-10-02** — Named windows `today` and `yesterday` (one day each, in the reporting
  timezone); business Home offers both as periods.
- **2026-09-30** — The `transaction_status` and `dunning_status` slices use the renamed values
  (`succeeded` / `failed` / `late_failed`; dunning `succeeded`). 0321 rewrote stored
  `metric_daily` / `metric_windows` rows in place, so no rebuild is needed; the goldens and
  `CLOSED_SET_LABELS` keys follow.
- **2026-09-27** — `loadActiveDiscounts` orders by `created_at, id`, the recompute's order, so
  the MRR invariant nets a discount stack exactly as the write did.
- **2026-09-27** — **A quiet period is a stored zero.** The flow measures wrote a row only for a
  reason that moved, so a period with no contraction/pause/expansion had NO row, and the reader
  (`missing`) reported it as unknown: on production Contraction and Paused MRR had 0 rows in a
  year and showed "—". Once a currency has its first movement, every flow now writes its total in
  it, 0 included (`compute.ts`, one standing `min(occurred_at)` read per currency, cached by the
  bulk fill). Book flows write 0 once the currency is held; `customers_created` always writes.
  Existing history needs `backfill-metric-daily --measures` for those measures. The dashboard's
  per-tile "Measured N ago" (the OLDEST row's `computed_at`, so a year of closed history read as
  days stale) is replaced by the page's "Synced" badge on Dashboards and Explore.
- **2026-09-27** — **CMRR keeps the date a stop was booked.** `committedAt` dated a term-end stop
  from `cancel_at_period_end`/`cancel_scheduled_at`, which every cancel clears, so the cancel moved
  the booking to `canceled_at` and a recompute counted the subscription as committed for its whole
  final term. A yearly one did it for a year: the drift scan's 3 × USD 29,083 on production.
  `stopBookedBy`/`nonRenewingAt` now read `cancel_booked_at` (0295) first; every stock select
  carries it. Pinned by `test/unit/cmrr-booking-survives-cancel.test.ts`.
- **2026-09-26** — **Cancellations: plan fallback and an honest cause label.** A largest loss
  whose churn carries no plan (every imported one on production) names the subscription's own
  plan item (`resolvePlanProductIds`). The `voluntary` cause now reads "No payment failure
  recorded": an imported cancellation carries no system reason, so a choice cannot be claimed.
- **2026-09-26** — **Retention: the opening is the previous close, and the cohort is point-in-time.**
  1. An opening stock is read at the previous period's close (`from − 1 ms`, the last instant a
     close reads inclusively), not at `from`. A movement stamped at a window's first instant was
     counted in both its opening and its flows, so closing ≠ opening + net. Both stored ratio
     measures and the reports' derived path.
  2. The reports' gross/net retention (`resolve.ts` derived path) now restricts losses and
     expansions to the opening cohort, as the stored measures already did. Unrestricted, a loss
     from a line that arrived inside the month was taken from an opening it was never in, and
     the published rate could go negative. The quick ratio is unchanged: everything gained over
     everything lost.
  3. A line with ledger rows is in the opening cohort only if its balance then was above zero.
     `earningAt` reads today's status, so a line paused at the opening and resumed since counted
     its resume as the base's growth. The status test stays for lines the ledger never saw.
  - **Suites:** `verify:metric-ratios` (81) and `verify:metric-customers` (53) fixtures now
    book an opening `new` and a closing `churn` per subscription. Their ledger is their book,
    which ledger-read stocks have required since 0271.
- **2026-09-26** — **Cancellation analytics** (`cancellations.ts`,
  `GET /v1/businesses/:biz/cancellation_analytics`). The population is the subscriptions list's
  own WHERE (`subscriptionListConditions`, now exported), so each count matches its drill-down.
  A cancellation is `paying` when the net of its `churn` movements within a day of `canceled_at`
  is a loss, `trial_not_converted` when it never activated, else `no_mrr`. Netting matters: trial
  churns compensated back to zero are not losses. Paying losses split by cause (`not_paid`,
  `no_card` and chargebacks are involuntary; `billing_cycles_exhausted` is `term_ended`; the rest
  `voluntary`), merchant reason (the code, else non-system text an import left in `cancel_reason`),
  tenure, buckets and the ten largest. Money is per currency plus the default currency at each
  day's rate. Gate: `verify:cancellation-analytics` (18; mutation-tested).
- **2026-09-25** — **A rewrite replaces a period's slices** (`daily/write.ts`). `writeMetricDay`
  deletes the keys of each (measure, dim) it carries that the new compute no longer produces,
  in the same transaction as the upsert. Before, an emptied slice value or currency kept its last
  value, so a day's slices could sum past its total. The full production recompute left 31 such
  rows on 2026-09-24/25 (`horizon`, `dunning_status`). Pairs the caller did not write are
  untouched. Gate: `verify:metric-daily-write` (19; mutation-tested).
- **2026-09-25** — **Rolling windows refresh every 30 min** (`5,35 * * * *`, was hourly at :05).
  A window ends today in the business's zone, so after local midnight Home computed it on demand
  (~13 s on production) until the next run: 35 min a night for a half-hour zone. Now 5 min at most.
- **2026-09-25** — **Reporting calendar per business** (0293: `businesses.week_start` sunday|monday,
  default sunday; `fiscal_year_start_month` 1–12, default 1). One helper, `src/platform/business-calendar.ts`
  (`periodEndOf`/`periodStartOf`, `weekEnd`, `fiscalQuarterEnd`/`fiscalYearEnd`, labels), is the only
  place a week/quarter/year is cut: stored coarse keys (`coarsePeriodEnds`), the reader's key
  (`calendarEnd`), API buckets and `this_quarter`/`this_year` (`buildPeriods`, `resolveWindow`), and
  payments "this week". `periodStartDate` derives the start from a canonical END, so it needs no
  calendar. **Weeks were Monday–Sunday; the default is now Sunday–Saturday.** Fiscal labels name the
  year a fiscal year ends in: "Q1 FY2027", "FY2027"; a January start keeps "Q1 2026" / "2026".
  Month windows are calendar months always. Org scope uses the businesses' shared calendar, else the
  default. A change enqueues `metric_daily_recompute` with `grains` (week, or quarter+year), which
  deletes and re-cuts only those rows. Legacy rolling 7-day buckets (`analytics.ts`, report re-cuts)
  are anchored on `now`, not a weekday, and are unaffected. Gate: `verify:business-calendar`.
- **2026-09-25** — **`mrr_fx_impact`: FX is on the waterfall** (`daily/fx-measures.ts`, source
  `read_time`). A converted MRR change moved for two reasons and only one was measured. Per
  period and currency: `C(close) − C(open) − Σ± C(flow) − C_close(R)`, where `C` is the answer's
  own conversion (stock at its day's rate, flows day by day) and `R` is what no stored flow
  explains natively (a `resume`), removed at the closing rate so it is never called FX. So
  opening + new + expansion + reactivation − contraction − churn − paused + FX = closing to the
  minor unit whenever the ledger reconciles. Computed at READ time, not stored: the conversion
  is chosen per answer and must be the same cells the MRR line and the flows are read from. A
  per-currency answer reads 0. **Movement flows are now stated in the book's currency**: an
  INR-only churn on a USD+INR book was answered per currency, unconverted, and Home's waterfall
  added paise to cents; flows (and FX) take the `mrr` answer's currency set. Business Home draws
  Paused, FX and Other (the remainder) only when non-zero, between the MRR stock's own edges.
  Gate: `verify:mrr-fx-impact` (19 checks, mutation-tested).
- **2026-09-25** — **Seven headline measures in the daily layer.** `arr` (MRR × 12, a `stocks`
  measure off the same snapshot rows, so it slices by every `mrr` dimension and converts like it —
  its `dimensions` must stay equal to `mrr`'s). In the derived group (`ratio-measures.ts`):
  `net_new_mrr` (every ledger reason signed, pause and resume included, so it equals the MRR
  change and the growth rate's numerator; `sum`), `gross_mrr_churn_rate` (churn + contraction over
  the opening MRR — the growth rate's `sum`/`opening` fold, money halves; pause excluded),
  `trial_conversion_rate` (activations of trials in the window over trials that ENDED in it — a
  trial ends at the earliest of its end date, activation and cancellation; `sum`/`sum`, counts;
  a late conversion can push a window above 100%) and `subscriber_churn_rate` (stopped ÷ live at
  open + started inside; a trial is a subscriber only once it converts; `aggregate: none`,
  `halves: count`, since opening-plus-flow cannot fold). Both book readers cap at the run's `now`,
  so a trial end later today is not counted. `customers_reactivated` (customer grain,
  `none`): accounts at zero at the window's open, after a churn, that gain revenue inside it — a
  pause alone is not a loss. `mrr_at_risk`: the current `subscriptions.mrr` of the subscriptions
  `dunning_subscriptions` counts (owed invoice, chase `in_progress`/`parked`), each once;
  as-of-now like receivables. Rolling and custom windows serve the two `none` measures through
  `windows.ts` unchanged. Business Home's overview shows ARR and trial conversion.
  `verify:metric-new-measures` (38 checks, each implementation mutation-tested).
- **2026-09-25** — **Four new metric dimensions: `billing_interval`, `region`, `plan_at_start`,
  `signup_cohort`.** Stored in `metric_daily` as `dim`/`dim_value` like `plan` and `country`, with
  a missing value as its own `none` bucket so slices sum to the total; no migration. Rules
  (`dimension-values.ts`, `regions.ts`): `billing_interval` — the subscription's period + unit as
  one closed key (daily · weekly · monthly · quarterly · semiannual · annual · multi_year · other;
  12 months = annual); `region` — the customer's country through a strict UN M49 grouping
  (north_america · latin_america · europe · middle_east_africa · asia_pacific, `other` for an
  unmapped code); `plan_at_start` — the plan on the subscription's earliest plan-bearing ledger
  row, else its current plan; `signup_cohort` — `YYYY-MM` (business calendar) of the customer's
  first MRR-raising ledger row, `none` on a stock read before it. Movements are attributed at READ
  time from the subscription and customer (the ledger is not migrated), so interval and region
  are as they stand now, like `country`. Declared on: mrr (all four), cmrr (interval), active and
  paying subscriptions (interval, region, cohort), renewing (region), the six MRR flows (all four),
  subscription_cancellations (interval). The stock writer now emits only the slices a measure
  declares (`STOCK_SLICES`/`FLOW_SLICES`/`BOOK_FLOW_SLICES` in `compute.ts`, paired by
  `assertRegistryImplemented`), and the four stock slices come off ONE extra pass over the book
  (`computeSnapshotByAttributes`). `verify:metric-dimensions` (new), mutation-tested.
- **2026-09-25** — **Committed MRR is point in time; running periods are found.**
  `committedAt` read today's `cancelled`/cancel flags backwards, so each cancellation removed a
  subscription from every past day back to its creation ($89.83 across 2023–2026 on production).
  A stop now leaves CMRR when it was booked — `canceled_at` for an immediate cancel, the final
  term's start for a stop at term end (the `nonRenewingAt` reading). And non-additive coarse
  reads (GRR, NRR, new/churned/moved customers, customer churn rate) looked for the running week
  or month at TODAY, while the writer keys it at the period's calendar end — every current
  period read null. `calendarEnd` reads it where it is stored. `verify:committed-mrr` (new, 10)
  and a running-month check in `verify:analytics-api`, both mutation-tested.
- **2026-09-25** — **A count denominator is never converted** (`denominatorIsMoney`). The
  money-rate fix above keyed denominator conversion on `hasMoneyHalves`, which is true for any
  money VALUE — so revenue per paying subscription/customer and the lifetime values divided
  money by subscriptions converted at the exchange rate (34 INR subscriptions became 0).
  Denominators now follow `denominatorUnit` alone, in `readMetricSeries` and `collapse`.
- **2026-09-25** — **A rate of money converts both halves before a cross-currency answer.**
  `chooseCurrency` sent every non-money unit down `across_currencies`, so gross/net revenue
  retention, net MRR growth, quick ratio and dunning recovery rate added USD, INR and EUR halves as
  raw minor units — Business Home's movement card opened at $206.17K (INR paise read as cents)
  against a real ~$49K, and the blended rate was weighted by paisa. `hasMoneyHalves` decides it;
  rates with no `RatioFold` declare `halves` (`money` for GRR/NRR, `count` for customer churn),
  and `verify:analytics-api` fails any rate that declares neither.
- **2026-09-24** — **Closed periods are reused for one refresh interval (5 min)**
  (`daily/series-cache.ts`). A one-business read splits into periods that ended before
  yesterday (cached, key includes the conversion) and the rest (read live: today is rewritten
  every 5 minutes, yesterday by the nightly close). Held only in the API serving process —
  `enableSeriesCache()` in `start()`; tests and scripts read uncached. A write in-process
  invalidates the business; a result with gaps is never kept. The rate history is loaded once
  per scope, not once per converted question.
- **2026-09-24** — **Report resolvers filter in SQL.** Transaction and invoice reports bound their
  read by the window and the metric's own conditions and assign rows to buckets in one pass
  (binary search) instead of loading the business's whole table and scanning it once per bucket.
  534 report variants byte-identical before/after; e.g. failed payments 1.8 s → ~17 ms-class,
  ageing reads open invoices only. Migration 0281 indexes `transactions (business_id, occurred_at)`.
  The analytics batch answers 4 questions concurrently; Business Home's failed-payment count reads
  the stored `payment_failures` (business-local days: 283 where the UTC-day report said 276).
- **2026-09-24** — **`GET /v1/analytics/sync`**: when the 5-minute cron last wrote the scope's
  figures (`lastSyncedAt` — latest `computed_at` on current-day rows; org scope reports its
  laggard). Distinct from an answer's `computed_at`, which is the OLDEST row in its range.
  Drives the dashboard's "Synced N minutes ago" pill.
- **2026-09-24** — **`dunning_subscriptions`: the live dunning count.** Business Home's "In dunning"
  summed every `dunning_invoices` slice, and that measure keeps every state an invoice was ever
  left in (`success`, `stopped`, `exhausted` on voided invoices), so the headline only grew. The
  new stock counts DISTINCT subscriptions with an invoice still owed (`posted` / `payment_due` /
  `not_paid`) whose chase is `in_progress` or `parked`; its `dunning_status` split adds
  `exhausted` (retries spent, still unpaid). Home's reading, its "Dunning exhausted" attention row
  and the org roster's Dunning column read it; `dunning_invoices` stays as the history breakdown.
  As-of-now like receivables: written only for the period in progress.
- **2026-09-24** — **Converted figures use the rate held THEN.** Only the movement waterfall
  read `exchange_rate_history`; every other converted figure — `total_mrr`, flows, billing,
  payments, the analytics API, Business Home — divided every past amount by today's rate, so
  2021 INR revenue was stated at a 2026 rate. `ctx.convert(minor, ccy, at)` now takes the
  instant (a stock's point, a movement's `occurred_at`, an invoice's issue/void/paid date, a
  payment's date); the stored-stock reader passes the day it reads; `readMetricSeries` takes
  a per-day converter, so a month's flows sum day by day at their own rates, applied for a
  single-business answer (the organization has no rate history and keeps today's rates).
  Figures about the present — amounts owed now, the current book, renewals ahead — stay at
  today's rate. Also fixed: a converted answer's `compare=previous` kept only the base
  currency's cells. `rateAt` binary-searches (a backfilled currency holds ~1,300
  observations). History comes from `scripts/backfill-exchange-rate-history.ts` (ECB).
  Gated by `verify:fx-history-backfill` (17 checks; each changed reader, reverted alone,
  turns one red).
- **2026-09-24** — **Past MRR is the ledger's, not today's rate projected backwards.** Every
  stock reader (`computeSnapshot*`, the report and per-country reconstructions, the Business
  Home fallback, the ratio instants) valued a past day at the subscription's CURRENT rate
  while `earningAt` held, so an expansion, a downgrade, a discount or a reactivation at a new
  rate restated every earlier day. They now share `earnedAt` (`snapshots.ts`): the
  subscription's `mrr_movements` balance at the instant, with the old rule only for a
  subscription that has no ledger row at all. A row the ledger says was earning also counts
  as active and paying then, since a reactivation resets the row's start. CMRR keeps the
  current rate for a committed row not yet earning. Stock now equals the movements that built
  it, so `total_mrr` and the movement waterfall agree. Gated by `verify:mrr-snapshots`
  (history block, red on the old code); `verify:reports` now creates its history fixture on
  its real dates; five golden payloads restated by one discount no longer dated back to
  February (+500 MRR / +6,000 ARR before 06-01).
- **2026-09-23** — **A trial is not revenue.** Stored stock history (`computeSnapshot*`, the
  report and Business Home reconstructions, the ratio and paying-customer instants) counted a
  subscription from its START, so a trial earned through its trial at the rate it later
  converted to; and a cancelled trial that never activated, with no `last_earning_mrr`, was
  re-rated at LIST price. `earningFrom`/`earningAt` (stocks.ts) start earning at the trial's
  end — the activation that ended it when within a day, else `trial_end` — and a never-activated
  cancelled trial is never re-rated. Active counts are unchanged (a trialing subscription is
  active). The ledger's backfilled `new` rows are moved to the same instant by the repair script's
  second pass, so the store and the ledger agree day by day. `verify:mrr-snapshots` pins both
  rules, each mutation-tested.
- **2026-09-23** — **The analytics store is gone, and two slow reports are fast.** Removed
  `olap/` (ClickHouse sync, gateway, measures, cohorts), `platform/clickhouse.ts`, the
  `ANALYTICS_ENGINE`/`CLICKHOUSE_*` config, the `olap_sync` job, the `verify:olap-*` gates and the
  `@clickhouse/client` dependency (ADR-011). `readMetric` reads `metric_daily` only.
  **`total_mrr`**: a stock report's in-progress bucket is read at NOW; it was read at a month-end
  that had not happened, which no stored day holds, so every load rebuilt the whole book to
  project it (production dump ~1.3 s → ~90 ms, zero book loads). A wholly future bucket still
  projects. **Netted ledger reads** group by `NETTED_KEYS` = (subscription, instant, reason) —
  exactly `mrr_movements_net_idx` (0277) — and carry the other columns, so the netting needs no
  sort: cohorts ~630/520 ms → ~320/360 ms. What remains is scanning 192k rows that net to 5k.
- **2026-09-23** — **A measure for a segment** (`daily/segment-series.ts`). `segment=<seg_…>` on
  `/v1/analytics` and each batch question answers `mrr`, the six MRR flows and the four head counts
  for a saved segment, computed from the movement ledger at read time (`customerPopulationSql`
  joined to `mrr_movements`); every other measure, a split, and an org-wide scope refuse by name.
  Membership is TODAY'S and the answer says so (`segment.note`). The head counts fold one netted
  read in memory for every period (`segmentWindowCounts`), through the same `classifyAccounts`
  the stored path uses. Tiles store `segment_id` (0276); discovery publishes `segmentable`. Gate:
  `verify:segment-analytics` — a segment of everyone must equal the stored answer for every
  accepted measure. Production dump: flows 20–70 ms, MRR ~200 ms, head counts ~300–600 ms.
- **2026-09-23** — **Backfilled movements restated at what the subscription actually earned.**
  `scripts/repair-backfilled-movement-rates.ts` appends a compensating `new`/`churn` pair at the
  original instants for every cancelled subscription the movement backfill valued at list price
  (it ran before `reportingMrrBySubscription` used `last_earning_mrr`). Append-only, idempotent,
  same reasons, so no reader changes for money. The customer head counts (`windowCounts`) now net
  movements per subscription, instant and reason and drop a zero net, so a subscription whose
  rows all cancel — one that never earned — is no account; `verify:metric-customers` §8
  mutation-tests it. The row-level loaders (`loadMovements` in reports, `movementRows` in
  `analytics.ts`) net the same way (`NETTED_KEYS` in `mrr-movements.ts`), because they add
  magnitudes row by row and would count a correction on top of the row it corrects. 0275 nets the
  movement fold too; a restatement written after a refresh cannot net against an original already
  folded, so the waterfall rebuilds from the ledger until the next refresh.
- **2026-09-23** — **The live-book and churn-age reports stop shipping the whole book.**
  `customer_concentration`, `top_customers_by_mrr`, `customers_by_mrr_band` and
  `total_paying_customers` read only `active`/`in_trial` subscriptions, filtered in SQL (the same
  filter `liveMrrByCustomer` applies, so the answer is unchanged). `churn_breakdown_summary` bands
  lifetimes in SQL (`resolveChurnAgeReport`) on millisecond-truncated instants, as the rows read in
  JavaScript. Production book: ~0.5 s → 20–85 ms each, every figure equal to the old path.
- **2026-09-23** — **`shape=totals`: an answer without its periods** (`public-query.ts`, 0274).
  `/v1/analytics` and each batch question take `shape` = `series` (default) | `totals`. Totals
  empties `series` and every split row's `points` AFTER every total is folded, so the figures are
  identical to the series answer's; `shape` is echoed on the result. A split then reads as a
  ranked list, a measure without one as a single figure. Tiles store it
  (`report_dashboard_tiles.shape`, NULL = series); a report-catalogue tile refuses it by name.
- **2026-09-22** — **The movement waterfall reads a pre-grouped ledger** (0273,
  `reports/movement-matview.ts`). `mrr_movement_summary_mv` groups `mrr_movements` by (month,
  currency, column, SIGNED delta) with a count — 1,775 rows for 98,866 on the production book.
  The waterfall reads those cells for complete months written before the matview's cutoff
  (`now() − 1h` at refresh) and the raw ledger for everything else; the two sets are complements.
  Exact, not approximate: `convertAt` rounds per row, and a cell converts its one delta and
  multiplies by the count. Reads go through the definer-rights view `mrr_movement_summary`
  (never `security_invoker` — that shape leaks). Refreshed concurrently by
  `metrics_daily_snapshot`. `waterfallColumn()` is mirrored by the SQL `column_key`; change both.
  Gate: `verify:movement-matview` (24 checks). Production book: ~1.2s → ~130ms, every figure equal.
- **2026-09-21** — **`dunning_recovery_rate` — recovered over what collections FINISHED with.**
  Stored as two halves and divided at read, both flows, so the fold is `sum`/`sum` and a quarter
  is its own arithmetic rather than the mean of its months. The denominator is recovered plus
  exhausted and deliberately NOT everything attempted: an invoice still being retried has no
  outcome yet, and counting it as a loss would make the rate a function of how much is in flight
  — a business that raised a lot of new failures on the last day of the month would read as
  having collapsed. In the INVOICE group rather than `ratio-measures.ts` (which owns the
  MRR-ledger ratios) because both halves come off the SAME grouped read, which is this group's
  rule; assembling it elsewhere from two separately-queried measures is the "two answers" shape
  the group exists to prevent. That needed a new `INVOICE_RATIO_MEASURES` registration — the
  group previously declared only `sum` and `last`. A period where collections finished nothing
  stores 0/0 and publishes null, never 0%: `ratioValue` refuses that division centrally, and 0%
  would claim everything was lost.

- **2026-09-21** — **What collections LOST, dated — so a recovery rate has both halves.**
  `amount_recovered` could always say what dunning saved, because a recovered invoice carries
  `paid_at`. What it gave up on carried no instant at all: `dunning_status='exhausted'` is a
  current fact, which is why `dunning_invoices` is declared `computed_at` and can describe today
  and no earlier day. Two halves that cannot be dated into one period cannot make a rate — and a
  rate is what every decision about retry schedules has to be judged against. 0282 adds
  `invoices.dunning_exhausted_at` (all five exhaustion writers stamp it), and the group gains
  `amount_exhausted`, `dunning_recovered_invoices` and `dunning_exhausted_invoices` — 15 measures
  to 18.
  ⚠️ **NO BACKFILL, and it is the point.** 0232 stamped `now()` on the rows it found because
  `dunning_parked_at` drives a DEADLINE and every parked invoice needed a clock. This drives a
  HISTORY, and the same stamp would invent one — every invoice ever exhausted landing on the deploy
  date, a spike on a day when nothing happened. Historical rows keep NULL, meaning UNKNOWN and
  never "not exhausted", the measures window on the DATE rather than the status, and the series
  begins here and says so in its own description. The fixture pins both halves of that: an invoice
  raised in May and exhausted in June (so the window provably follows the column, not the invoice
  date), and one exhausted with no date that must appear in no period at all — without the second,
  the measure looks identical whether it windows on the date or the status.
  Counts as well as amounts, deliberately: a recovery rate by value and one by invoice come apart
  exactly where it matters, where one large renewal recovered among many small failures reads as a
  triumph by value and a disaster by count.

- **2026-09-21** — **Coarse grains are backfilled, not folded.** Cohort-restricted retention is
  per-grain (`aggregate: "none"`), so a month figure must have been WRITTEN — a subscription that
  starts on day 2 of a quarter and churns on day 20 is in day 20's opening cohort and not in the
  quarter's, so the daily rows cannot fold into the quarterly answer. `backfill-metric-daily.ts`
  was day-only, leaving 14,188 of 14,511 business-months answering "missing". It now takes
  `--grains <all|none|…>`, defaulting to `all`, because a flag you must remember reproduces the
  defect on the next box; `--grains none` restores the old behaviour byte-for-byte and
  `verify:metric-daily-coarse` pins that. Periods come from `coarsePeriodEnds`, imported from
  `daily/cron.ts` rather than copied, so the backfill and the nightly close cannot disagree about
  where a month ends, and the days handed in are already the business's local calendar dates. 400
  days dedupe to 79 periods; measured +10.4% wall clock and 180 rows against ~144k.
- **2026-09-21** — **A churned subscription's rate is STORED, not reconstructed.** The historical
  MRR series re-rated every cancelled row from its surviving items and still-active discounts. The
  items survive a cancellation; THE DISCOUNTS DO NOT — `applied_coupons` rows are consumed, removed
  or end with the subscription, and the load reads only `status = 'active'` — so the netting ran
  against an empty set and returned GROSS LIST PRICE. Measured on the production book: 238 of
  71,755 cancelled subscriptions carry any discount row against 1,545 of 2,495 live ones, and 708
  subscriptions live in one past month re-rated at **$63.4K/month of list against ~$2.7K genuine**.
  That is the whole of a history that read $112.0K where the truth was ~$51.3K in Feb 2026 and
  converged to today's correct ~$48K — the error grows with how far back you look, because more
  since-churned accounts were live then. New column `subscriptions.last_earning_mrr` (0271),
  written by `recomputeSubscriptionMrr` on every recompute that lands in an earning status and
  deliberately NOT touched by the one that zeroes `mrr`, so a pause cannot erase it.
  `reportingMrrBySubscription` reads it; the item re-rate stays as the fallback for rows with
  nothing stored, so an un-backfilled book is no worse than it was. Both readers narrow their item
  query to that fallback set, so a backfilled business stops reading items for this at all.
  Backfill: `scripts/backfill-churned-mrr.ts` — the event stream first (every subscription event
  serialises the engine's own netted `mrr`, so the last one that found the row `active` /
  `non_renewing` IS the figure), invoices second for an imported book that has no lifecycle events
  (last invoice's recurring lines, net of both discount stages, normalized to a month). NOT
  `mrr_movements`: it is incomplete (2,054 of 7,880 cancelled rows on the development book) and its
  seeded churn amounts were themselves produced by the re-rate this repairs. New suite:
  `verify:churned-mrr` (15 checks), mutation-tested four ways. `metric_daily` needs a full
  recompute for this to reach stored days.
- **2026-09-20** — **The public analytics API (Phase 4).** `GET /v1/analytics/measures` serialises the
  registry, `GET /v1/analytics` answers one measure over one window, `POST /v1/analytics/query`
  answers up to 24 in one round trip. New: `daily/public-query.ts` (named windows resolved in the
  business's timezone, period building, currency choice, bounded splits, coverage) and
  `readMetricSeries` in `daily/query.ts` — ONE query per (measure, split) folded into periods in
  memory, rather than `readMetric`'s one query per bucket. Contract points that are gated rather
  than documented: units on the payload, `kind` and `total_basis` echoed, `as_of`/`computed_at`,
  a `coverage` block naming the periods that are unknown-not-zero, 422 refusals carrying a
  sentence, and a split bounded by `split_limit` with an explicit `other` bucket computed as the
  total minus the rows kept. Money is never summed across currencies — a window holding two is
  refused by name. New suite: `verify:analytics-api` (34 checks), mutation-tested.
- **2026-09-20** — **Cancelled rows are re-rated for the WINDOW, not for all time.** Measured on
  production: `cancelled items+prices` was **4,108 ms of an 8,561 ms call — 48%** — reading 71,925
  rows for 71,732 ids. An archive migration had left the book **96% cancelled** (71,456 cancelled
  subscriptions imported overnight), and scoping this read to cancelled subscriptions was itself
  the previous fix here: it assumed cancelled was a small minority of a book, which holds right up
  until an archive lands. Now bounded to those cancelled inside the window. Every consumer is
  window-bounded and each was checked rather than assumed: the cancellation series sum over
  `window`/`lastMonth` and bucket their points; `mrrAt` and cMRR ask `liveAt`/`committedAt` at
  in-window instants, where a subscription cancelled before `since` is live at none of them; and
  `payingAt` excludes cancelled outright. Mutation-tested — narrowing it further turns the two
  cancellation-MRR checks red.
  **Standing lesson:** a bound justified by "that set is small" is a bound that fails on migration
  day. Prefer one justified by what the consumers actually read.
- **2026-09-20** — **The movement read is bounded too, and a stored-count fast path was
  rejected for want of a gate.** `mrr_movements` was read with `where business_id` alone. That
  was 0 rows until the ledger was backfilled and **98,858** the moment it was — a read that grows
  with the age of the book, on a page that only shows a window of it. Every consumer is windowed
  (the series bucket by `occurredAt`; the plan breakdown covers the last complete month), so it
  now carries the same `since` bound as the rest. Mutation-tested: bounding it to `now` instead
  turns four `verify:mrr-movements` checks red.
  **Rejected in the same pass:** routing `activeAt`/`payingAt` through the stored
  `active_subscriptions` / `paying_subscriptions` columns. The columns exist and are unused, but
  **no gate covers that path** — `verify-metrics` writes no snapshots at all, and the one
  assertion that compares a stored count to the KPI reads it at `now`, which never has a snapshot
  because the job writes yesterday's close. A deliberate wrong value in the stored path passed
  every suite. The saving was ~3 filter passes over the book (these are 4 fixed instants, not
  per-bucket), which is milliseconds against a transfer cost measured in seconds — not worth a
  silently wrong subscriber count. Take it when the gate exists.
- **2026-09-20** — **The per-business analytics read is bounded by the window, not by the age
  of the account.** Invoices, transactions, credit notes and customers were each read whole —
  every row the business had ever created, on a page whose longest view is 12 months. They are
  now bounded to the earlier of the chart window and last month's start (less two days for
  timezone skew, since `calendarWindows` works in the business's zone and SQL cannot).
  Three carve-outs, because bounding them naively is wrong:
  **(1)** `net_billing_minor` / `net_payments_minor` say **"all time"** in their own tooltips, so
  they come from `GROUP BY currency` aggregates instead of the bounded rows — nine-odd rows.
  They convert once per currency rather than per row; residuals are ±0.5 minor units and cancel,
  so the two agree to a few minor units, and converting the total is the more accurate of the two.
  Identical whenever one currency is selected, or for the reporting currency, since neither rounds.
  **(2)** Open invoices of any age are read separately — AR is a statement about what is owed, and
  a date bound would drop the oldest and most overdue rows, the ones that matter most. Safe to
  merge into the series input because `bucketMoney` only adds a row that falls inside a bucket.
  **(3)** The currency selector comes from a `DISTINCT`, or a currency billed only before the
  window would vanish from it.
  Gate: `verify:metrics` gained a payment stamped two years before the probe, asserted present in
  the all-time figure and absent from every dated one — **mutation-tested**, it goes red when the
  lifetime total is served from the bounded rows.
- **2026-09-20** — **The per-business analytics read stopped joining every item to every price.**
  `computeBusinessAnalytics` pulled all 76,151 subscription items joined to their full price rows
  (`price_snapshot` JSON included) — ~92 MB into Node on the page `/businesses/:biz` opens with.
  Only two things read them: `reportingMrrBySubscription`, which re-rates CANCELLED rows only,
  and the plan mix. Items are now fetched for cancelled subscriptions alone, and plan mix asks
  `resolvePlanProductIds` — one batched query, the same rule it already applied (first
  `kind='plan'` item, else the first).
  ⚠️ **The other four reads stay unbounded, deliberately.** `net_billing_minor` and
  `net_payments_minor` are LIFETIME totals with no window, and `convert()` rounds PER ROW
  (`Math.round(minor / rate)`) — so bounding invoices or transactions changes those figures, and
  aggregating them in SQL changes them too, by rounding once instead of per row. Bounding the
  reads needs a decision about what those two KPIs mean, not just a `WHERE` clause. Attempted and
  reverted rather than shipped: a windowed read plus open-invoices-of-any-age gives a total that
  is neither lifetime nor windowed.
- **2026-09-20** — **Business Home stopped materializing the whole book.** `computeBusinessMetrics`
  `SELECT *`-ed every subscription, joined EVERY subscription item to its full price row
  (`price_snapshot` JSON included) and loaded every active discount — then assembled the answer in
  JavaScript, on the first page an operator sees, with no cache in front of it. Measured on a
  74,534-subscription book: the three reads cost only ~104 ms of server time but shipped
  **~127 MB in ~152,000 rows** to Node, which is the part `EXPLAIN ANALYZE` does not show and the
  part that cost 11 seconds. The stock half is now one `GROUP BY status, currency` with `FILTER`
  clauses — **9 rows** — and churn reads `mrr_movements`. Same figures: for every status but
  `cancelled`, `reportingMrrBySubscription` returns the cached `subscriptions.mrr` verbatim, and
  `cancelled` is not in `LIVE`, so the stock half never read a recomputed value; the items and
  discounts were fetched whole to serve the 30-day churn window alone. After: **731 rows, ~0.9 MB.**
  ⚠️ The ledger is used only where it HAS the answer — a business with cancellations in the window
  but no churn rows carries an unseeded ledger, and reading it would report zero churn, a silent
  wrong number. That case recomputes from items, scoped to the cancelled-in-window ids. This is what
  runs on a freshly migrated box until `backfill-mrr-movements` has been run.
- **2026-09-19** — **`paying_subscriptions` drops non-renewing subscriptions.** A non-renewing
  subscription is still billing, so it carried MRR and counted as paying — but it is already booked
  to stop at the end of its term, and the headline is read as "the book I can expect to keep
  paying". `payingAt(t)` now also excludes `cancel_at_period_end` and a dated `cancel_scheduled_at`;
  they stay in the active total beneath, and the card's hint names both exclusions. Gate: one more
  check in `verify:metrics` — with a 100%-off subscription and a booked leaver in the same book,
  active 6, paying 4.
- **2026-09-18** — **Five default dashboards.** The Dashboards page opened empty; it now opens on
  Executive Watch, one of five built-ins (Executive Watch, CFO Dashboard, Business Highlights, Churn
  Watch, Finance Watch — 47 tiles, all answering). Declared in code (`dashboards/presets.ts`), never
  seeded: every business has them from the moment it exists, they follow the registry when a report
  is renamed, and `owner: ""` makes them read-only by construction rather than by a permission
  check. Synthesised into row shape so presets and saved dashboards share one render path.
  Gate: `verify:report-dashboards` 91.
- **2026-09-18** — **97 reports, a previous-period comparison, and saved dashboards.**
  `ReportResult.comparison` carries a previous value, its period, the change in basis points and the
  **basis** the pair was cut on; the comparison window is CLIPPED to the same elapsed point as the
  current one, so a partial period can never be compared against a complete one by construction
  (52 of 88 declared `comparable`; the rest refused with reasons). Nine customer-grain reports —
  ARPC, paying customers, account lifetime, customer LTV, disjoint concentration bands, top
  accounts, MRR bands, logo churn — all at ACCOUNT grain, so a customer with three subscriptions
  counts once. Saved dashboards live in their own module (`dashboards/`, tables in 0262). Fixed:
  `total_upcoming_renewal_amount` was `flow` while its measure looks forward, so it reported $685K
  against $1.44M — now `forward`, with a registry invariant pinning it. The AR ageing ladder now has
  ONE definition (`invoicing/ar-aging`), shared with the list filter that drills into it.
  Gates: `verify:reports` 146, `verify:report-dashboards` 71, `verify:bucket-drilldowns` 60.
- **2026-09-18** — **88 reports: cash split by what it paid for.** A `payment` source over
  `modules/payments/attribution.ts` — recurring / net recurring / non-recurring / usage payments
  plus a Cash Composition breakdown. Derived, not stored (no migration). Documented the divergence
  from `total_payments`: `payments` vs `transactions` are two questions, not a cross-check.
  Gate: `verify:payment-allocation` 107 checks (§8 pins the report identities).
- **2026-09-18** — **83 reports, granularity, FX on the record, per-plan snapshots.** Ten more
  reports (subscription churn, payment/refund transaction counts and summaries, failed refunds,
  Account Summary as a reconciling waterfall, new/churned/moved CUSTOMERS); a `granularity`
  parameter refused rather than ignored where there is no series; `exchange_rate` +
  `exchange_rate_base` on every new movement (0260); and `mrr_snapshot_plans` (0261) so MRR by
  plan over time is possible. Gates: `verify:reports` 97, `verify:mrr-movements` 45,
  `verify:mrr-snapshots` 33.
- **2026-09-18** — **Phase 3 complete: 60 reports, six sources, breakdowns and CSV.** Added the
  `invoice`, `transaction`, `subscription` and `scheduled` resolvers; `shape: "buckets"` for
  ageing ladders, status and error summaries and the plan-movement matrix; `currency` as a second
  dimension; `?format=csv` from the same resolver; group-by controls offered only for the
  dimensions a report declares. Schema behind it: `mrr_movements.previous_plan_product_id` (0258,
  with a column-level UPDATE grant) and `scheduled_changes.mrr_delta_minor` (0259). Gate:
  `verify:reports` 50 checks, `verify:mrr-movements` 39.
- **2026-09-18** — **The catalogue closed out at 73 reports**: churn breakdown by age, ARPS, LTV,
  signups, activations, total subscriptions, upcoming renewal amount, and cards expired / due to
  expire (a new `payment_method` source). Nine registry entries, one new resolver, one new
  bucketing.
- **2026-09-18** — **Cross-cutting tags** on the catalogue (billing & taxes, leakage,
  collections, customers, committed, trials, plans, cohorts, annualised), as filter chips with
  counts beside the category grouping. Five checks pin the vocabulary.
- **2026-09-18** — **The movement waterfall** (`shape: "periodic"`): MRR and ARR Movement
  Summary, one row per month with opening, every movement and closing, reconciling by
  construction because every column comes from the ledger. Also: a per-shape carrier contract in
  the gate (buckets → rows, cohort → matrix, periodic → table), after the waterfall's first CSV
  export fell through to an empty file.
- **2026-09-18** — **Cohort retention.** `shape: "cohort"` + MRR and subscription retention
  cohorts, reconstructed from the ledger rather than from today's rate; grids render in the
  report page and export as CSV. The payload says how to format the base column (`base_kind`) so
  the client does not guess from `kind`, which describes the cells.
- **2026-09-18** — **Phase 3a: the report layer.** Registry + three resolvers + catalogue and
  report endpoints + the explorer UI (`/revenue/reports`), covering the recurring-revenue slice
  (20 reports: MRR/ARR/CMRR stocks, the five movement flows and their ARR variants, net growth
  and its rate, GRR/NRR/quick ratio, per-new and per-churned averages, paused MRR). Gate:
  `verify:reports`, 22 checks, including report-vs-dashboard agreement on a non-UTC business.
- **2026-09-18** — **Movement segmentation by plan (0256, grant 0257).** Each movement stores the
  plan it happened on, resolved at write time by the one shared rule (`plan-of.ts`);
  `mrr_movement_by_plan` reports the retention month split by plan and the Revenue page renders
  it. Backfill mode `--plans` fills the column for rows written earlier, batched per plan after
  the row-at-a-time version died against the statement timeout.
- **2026-09-18** — **Daily stock snapshots (`mrr_snapshots`, 0255) + one shared predicate set.**
  `stocks.ts` extracted from `analytics.ts` so the snapshot writer and the live reconstruction
  cannot drift; `metrics_daily_snapshot` cron writes yesterday per business per currency; the MRR
  series reads stored days and falls back to reconstruction for the rest. Backfill script with its
  rate limitation stated. Gate: `verify:mrr-snapshots`, 18 checks — snapshot vs reconstruction
  figure for figure, the upsert, the currency split, the read-path fallback, and an empty day
  storing nothing rather than rows of zeros.
- **2026-09-18** — **`mrr_movements`: the flow behind the stock (Phase 1 of revenue reporting).**
  New append-only table + one writer in `recomputeSubscriptionMrr`, five movement series, and
  `kpis.retention` (GRR, NRR, quick ratio + the components they are made of) on Business Home.
  Backfill script for existing books, with its limits stated above. Gate: `verify:mrr-movements`,
  29 checks — the classifier's ambiguous branches, each mutation path end to end, the
  Σdelta = stored-MRR identity, and the ratio arithmetic against known numbers.
- **2026-09-17** — **CMRR was a second copy of MRR.** `cmrrAt(t)` meant "MRR still live at
  instant t", and at t = now that predicate IS the MRR predicate — so the Business Home tile
  printed the MRR figure twice. Measured across all 12 businesses in the dev org: identical in
  every one. Redefined as **committed** MRR:
  - a booked cancellation (`cancel_at_period_end`, or a dated `cancel_scheduled_at`) leaves CMRR
    **when it is booked**, not when it lands — the decision is already taken, and counting that
    revenue as committed is the optimism the metric exists to remove;
  - a subscription signed to start later (`status='future'`) **counts now**. It was excluded by
    `startOf(s) > at`, which meant the forward projection could only ever fall;
  - finite `remaining_billing_cycles` still end the commitment at their last cycle, so the
    forward series drops there;
  - a trial commits nothing (its cached MRR is 0 — the same rule MRR uses).
  Gate: four checks in `verify:metrics` on a book with $50 leaving and $100/mo arriving →
  MRR 30000, CMRR 35000. The amounts are deliberately unequal, because equal ones are how the
  old defect stayed invisible.
- **2026-09-17** — **`paying_subscriptions` KPI: the active count now says who is PAYING.** A
  fully-discounted, free-tier or usage-only-with-no-usage subscription is active and contributes
  nothing, so the plain count overstates the book it gets read as. `payingAt(t)` is `activeAt(t)`
  restricted to MRR > 0; both figures are in the payload and Business Home shows the paying count
  as the headline with the active total beneath it. Gate: three checks on a 100%-off subscription
  — active 6, paying 5, MRR unchanged.
- **2026-08-10** — **The Business Home revenue/signup strip was cut on UTC days and months, and
  reported "Received" gross.** Both fixed in `analytics.ts`.
  *Timezone*: `today`/`yesterday`/`this month`/`last month`/`next month` came from `utcDay`/`utcMonth`
  arithmetic in JS while `calendar-ranges.ts` — the payments dashboards, same module — resolved every
  boundary in the business timezone. For an `Asia/Kolkata` book (UTC+5:30) the strip read, at 01:30 IST
  on 10-Aug: `signups_today {count: 78, yesterday: 0}` and `revenue_today {received: $24,317.91}` —
  all of it 9-Aug's, filed under "Today" with "Yesterday" zeroed, for the 5h30m between local and UTC
  midnight every day. The same skew put July's figures under "Revenue this month" for the first 5h30m
  of 1-Aug. Now resolved in Postgres in the business timezone (new `calendarWindows`), so DST is
  Postgres's problem and `previous.end === current.start` holds by construction.
  *Gross vs net*: `received_minor` summed payments only, while the `net_payments_minor` KPI directly
  above it on the same screen subtracts refunds — two meanings of "received" on one screen, and a
  refunded charge stayed booked as revenue. It nets now, and so do the `last_month`/`yesterday`
  comparison figures. If "Received" should read gross here instead, revert `receivedIn` to
  `sumMoney(payments, …)` and say so here.
  Also dropped `monthWindow` and `moneySeries`'s dead `forwardLabelOffset` parameter (no caller ever
  passed one). Guarded by 14 new checks in `verify:metrics`, which had **no** coverage of these four
  KPI fields; 9 fail if the timezone resolution is reverted, 6 if the netting is.
  Chart bucketing (`daily`/`3m`/`6m`/`12m`) is still UTC and deliberately so — those are rolling
  windows anchored on `now`, not wall-clock ones. The `12m` calendar-month buckets are the one
  remaining place a wall-clock boundary is cut in UTC; left alone, as moving it shifts every chart axis.
  **The six highlighted figures are now links** (they were accent-blue and inert,
  which is the design system's own definition of a lie — `--primary` means "this navigates"). The
  payload gained `windows`, the list-filter values for each period, so a link always opens on the rows
  its figure counted; `transactions` gained an `occurred_at` filter, without which no revenue figure had
  a date column to link on that agreed with its own arithmetic. Measured over CDP: all six render as
  `<a>`, no runtime errors on any of the three routes, and each list's record count equals the figure —
  87 / 201 / 0 / 78 customers, 109 / 1 transactions. Guarded by 8 more `verify:metrics` checks.
- **2026-08-10** — **The plan mix filed subscriptions under whichever item Postgres returned first, and
  its counts were not clickable.** `items[0]` off an unordered query meant an add-on row arriving first
  attributed the subscription to the add-on: the panel listed `platform-additional-connections-v202604`
  (`kind='addon'`) as a plan with 1 subscription and reported `platform-pro-v202604` at 189 rather than
  190, non-deterministically. Grouping moved to the **plan item**, matching what `subscriptions-table.tsx`
  already called the plan. Each count now links to `plan[is]=…&status=active`; measured over CDP, all six
  rows equal their list (190/59/1/1/1/1). The card's hint claimed "Active and in-trial … first
  subscription item" — both halves untrue (trials left the set on 08-08) — and now describes the real set.
  4 more `verify:metrics` checks, on a book that finally contains an add-on.
- **2026-08-08** — **MRR is now correct, and Total Active Subscriptions excludes trials.**
  Both reads (`analytics.ts`, `service.ts`) re-derived MRR by summing each subscription's items
  through `monthlyRecurringMinor`, using the cached `subscriptions.mrr` column only as a fallback
  for rows with no items. That sum is **gross**: item rows carry no discounts, and it had no trial
  rule — so Business Home reported one book at **$502.30K against the real $48.94K (10.3×)**
  while the subscriptions list, reading the column, showed the real figure. Two rating paths is what
  let them disagree; there is now one. Both reads take the column
  (`recomputeSubscriptionMrr` owns snapshots, discount netting and the in-trial zero), via the new
  `reportingMrrBySubscription` + `loadActiveDiscounts` in `mrr.ts`. The single exception is a
  **cancelled** subscription, whose column is deliberately 0: the historical MRR
  series and the cancellation-MRR series need the rate it carried while live, so those rows — and
  only those — are re-rated from their surviving items through the *same* netting helpers.
  Separately, `activeAt()` and the by-plan breakdown counted `LIVE_STATUSES` (active + in_trial);
  "Total Active Subscriptions" counts active + non_renewing, which we store as `active`
  + `cancel_at_period_end`, so the new `ACTIVE_STATUSES` is `active` alone — 2,972 → the correct
  2,551. Trials remain visible as their own count in `BusinessMetrics.subscribers`.
  Books imported before 2026-08-07 hold gross values in the column and need
  `pnpm mrr:backfill --biz … --write`.
- **2026-08-01** — Fixed a silent-omission hole in payments analytics' FX disclosure:
  `available_currencies` (and therefore `missing_rates`) was derived from `transactions` alone, so a
  rateless currency reaching the read only through `disputes` or `payment_intents` was excluded from
  Chargebacks / Net Volume / pending-intent counts **without** being named in the warning. It now
  unions the currencies of all three sources. `verify:payments-analytics` 80 → 82 checks (a EUR
  chargeback with no rate and no EUR transaction in the window).
- **2026-08-01** — Added `payments-analytics.ts` + `calendar-ranges.ts` +
  `GET /v1/businesses/:biz/payments_analytics` (PROGRESS.md P3, phases 1–3): a calendar-relative range
  vocabulary resolved in the business timezone, the payments-dashboard read (gross volume, refunds,
  chargebacks, net volume, transaction count, successful/failed payments, failure rate, pending
  intents + error-cause/payment-method/gateway breakdowns), and gateway/payment-method filters. First
  read in this module to aggregate in SQL rather than in JS. `SeriesHeadline.change_bps` added as an
  OPTIONAL field, emitted only here — `/analytics`'s response shape is unchanged.
  New suite: `verify:payments-analytics` (82 checks).
- **2026-07-29** — Added `analytics.ts` + `GET /v1/businesses/:biz/analytics`: the Business Home
  dashboard payload (5 KPIs + revenue/signup strip, 12 bucketed series, plan mix), with range/currency
  selection and forward-projected CMRR. `verify:metrics` extended to cover it. § Scale documents the
  derived-on-read ceiling and the escalation ladder.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H), incl. multi-currency FX.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-09-28** — `refreshRollingWindows` logs ONE info line per run (`metric_windows_refresh_run`: businesses, failed, total ms, slowest business); the per-business `metric_windows_refreshed` line is now `debug`. On a database with many businesses (local dev, seeded verify orgs) it was one info line per business every half hour. Per-business failures still log at `error`.
- **2026-09-28** — The 5-minute `metric_daily_today_written` pass logs `metric_daily written` at `debug` when nothing failed; the nightly pass and any failure stay `info`.
- **2026-09-28** — CMRR on a past day no longer reads today's rate for a subscription the ledger has already booked. `committedMrrOf` (snapshots.ts) is the one rule, used by the snapshot, attribute, analytics and report paths: once the ledger has a movement at or before the instant, CMRR is the ledger balance then — 0 on a trial day (booked and reversed at trial start) and during a lapse between churn and reactivation. Only a subscription not yet booked (a future start) is committed at its `rated` rate. Before this, a plan change after conversion rewrote every trial day of that subscription (the `metric_daily_reproducible` drift), and a reactivation re-counted its whole lapse at today's rate — on the production copy, stored CMRR ran up to 46% above MRR on days a year back. MRR is unchanged. Stored history needs a CMRR restatement (`backfill-metric-daily.ts --measures cmrr`). `test/unit/cmrr-past-days-use-the-ledger.test.ts`.
- **2026-09-28** — Business Home figures corrected. `revenue_per_new_subscription` / `revenue_lost_per_churned_subscription` count one per SUBSCRIPTION whose net movement for the reason moved the right way, not ledger rows: a trial books `new` and reverses it at trial start, so every unconverted trial sat in the denominator (prod copy, 30 days, USD: 278 → 14 new, $5.81 → $115.31). `discount_given` — and `total_revenue_leakage` with its coupon split, which the oracle holds equal — leaves out invoices a discount took to zero ($101,440 → $338). `failure_reason` labels go through `failureReasonLabel` (daily/failure-labels.ts): raw provider codes resolve to the canonical refusal, `unspecified` reads "No reason given". Fixtures: an unconverted trial in `verify:metric-ratios`, a 100%-off invoice in `verify:metric-invoices`; both mutation-tested. `test/unit/failure-reason-labels.test.ts`. Stored history needs a restatement of those three measures.
- **2026-09-28** — `expected_renewal_cash` (money) + `expected_renewals` (count of CHARGES) — daily/renewal-measures.ts, in the forward-book group: a reading as at the run, split by the closed `horizon` bands over the next 90 days. Every renewal boundary counts (a weekly plan once per renewal); a trial's first charge is its conversion; stops at a booked cancellation due at/before the boundary and after `remaining_billing_cycles` more charges (the clock charges while > 0, cancels at 0); active + in_trial only. Valued per charge at `computeRecurringAmount` (subscriptions/service.ts); a $0 or cadence-mismatched subscription is left out. A booked plan change is valued at the current rate. `test/unit/expected-renewal-charges.test.ts`; `verify:metric-scheduled` pins the pair to the group's reading contract.
- **2026-09-28** — Four additions for Business Home. `mrr_churn` splits by `churn_kind` (involuntary: not_paid · no_card · chargeback; voluntary: everything else — the Cancellations report's `causeOf`), attributed from the subscription's current `cancel_reason`, so a churn later reactivated reads voluntary. A `disputes` source (daily/dispute-measures.ts): readings `disputes_open` / `disputes_open_amount` (open = needs_response · under_review; `horizon` on the evidence deadline) and flows `disputes_opened` / `_won` / `_lost` with `_amount` twins (won/lost dated by `closed_at`; `closed` is neither). A `gateway` split on `payment_attempts`, `payment_failures` (transactions.gateway_key) and `cash_collected` (payments.provider_key per applied payment). `mrr_top10_share` (bps ratio, per currency, both halves from the same per-customer sums). Gates: churn_kind in verify:metric-dimensions (an involuntary churn), top-10 in verify:metric-ratios, disputes in `test/unit/dispute-measures.test.ts`, delegated from verify:metric-daily.
- **2026-09-28** — `mrr_snapshots`, `mrr_snapshot_plans` and `mrr_snapshot_countries` retired. `metric_daily` holds every day and slice they held, so the nightly `metrics_daily_snapshot` job (name kept — it is the crontab/job key) now only closes yesterday into `metric_daily` and refreshes the movement summary. The two fallback reads are gone: analytics MRR is `metric_daily` → rebuild, and the report stock readers (unsliced and by country) are `metric_daily` → rebuild. `snapshots.ts` keeps only the day-end book compute `metric_daily` is built from. Dropped by migration 0300, shipped in a SEPARATE deploy after the code, because `reload.sh` migrates before it reloads. Also: `verify:metric-daily`'s stored-vs-live MRR check was circular (analytics reads `metric_daily` first); it now deletes the fixture's stored `mrr` rows before asking.
- **2026-10-08** — Cohort ratios combine across businesses. `combinesAcrossBusinesses` (measures.ts) lets a
  non-additive measure stored as two halves (GRR, NRR, customer and subscriber churn rate) be read at
  organization scope at day or month grain: each business's halves are summed, money halves converted
  together at one rate, and divided once — never a mean of percentages. Bare distinct counts, and
  week/quarter/year (business calendars can disagree), stay refused. `windowRows` reads a rolling
  preset across several businesses by `window_name`, each business's own latest window, so a business
  cut in another zone is not dropped for having different dates. The window total re-chooses its
  currency when the window holds one the series did not, so it never adds two currencies' minor units.
  Gated by `verify:metric-windows` § 5 (USD + EUR businesses: 8167 bps, not 6500 / 8545 / 8909).
- **2026-10-14** — One period's compute reads the book once. `computeMetricPeriod` read every
  subscription 11 times (four snapshot slices, `readBook`, the trial book, `readBookWithCustomers`
  twice, the forward book, expected renewals), and the ledger balance at an instant 6 times. The
  per-call `SnapshotMrrCache` now also holds the book (`cachedBook`: the union of the columns, one
  query), the ledger at each instant, the active discounts, lapses, plan-at-start, first-paid and
  `earningRatesAt` per book and instant. Each reader still sees exactly its own columns (`bookAs`
  projects): a missing `activatedAt` or `lapses` reads differently from a present one. Callers
  without a cache are unchanged. A "today" pass over a 3,931-subscription book: 76 → 50 queries,
  103,617 → 38,109 rows, ~3 s → 1.2 s. Output identical to the old code row for row (17,730 rows) on
  the 25 largest dev books: today, yesterday, 45 and 400 days back, week/month/quarter/year, a
  rolling 30 days.
- **2026-10-14** — The rolling windows share their reads. `refreshRollingWindows` computed its five
  presets with five separate caches, so each business's book was read five times. All five end
  today, so `computeMetricPeriod` now takes an optional `cache` for calls with the same
  `periodEnd`, and the refresh passes one per window end. One business's refresh on the largest
  dev book: 95,263 → 60,575 rows, heap growth +107 → +51 MiB; output identical across 125
  windows on the 25 largest dev books. Also `metric_daily_current` and `metric_windows_refresh`
  now share the `metrics_live` queue so they never run together (platform/jobs.ts): at :05/:35
  they did, and glibc kept the summed peak as worker RSS. `verify:worker` asserts the lane.
- **2026-10-16** — The ledger is read once per period, and account lives once per book. With a
  cache, `loadLedgerAt` read the whole `mrr_movements` ledger as a grouped SQL aggregate for every
  instant asked about and kept each answer as a full Map + Set. `readLedgerIndex` now reads it once
  into typed arrays (per subscription, in time order, with a running balance) and answers each
  instant through a get/has view; the uncached path still runs the SQL. Times are epoch
  microseconds, as Postgres compares them. `accountLives` builds its per-customer facts once per
  book (`accountsOf`) and memoizes the result per instant, so callers must not mutate it. On a
  75k-subscription book the rolling-window refresh drops from 2.28 M ledger rows to 201k, ~11.4 →
  ~8.7 s, heap peak ~800 → ~500 MiB. Output identical row for row at five instants.
- **2026-10-17** — Fewer copies of the book. The forward book, expected renewals and the trial
  book read only columns they name, so they now take the cached rows as they are (`bookShared`)
  instead of a `bookAs` copy; the forward book's trial check still reads without lapses.
  `readBook` adds `quantity` to its own copy in place instead of copying it again.
  `readBookWithCustomers` keeps its copy: it reads without `activatedAt`. On a 75k-subscription
  book: rolling-window refresh allocates ~1,300 → ~980 MiB, `metric_daily_current` ~1,312 →
  ~1,228 MiB. Output identical row for row at five instants.
- **2026-10-22** — D4.5, figures byte-identical to before on a 240k-subscription book: plan per
  subscription in one SQL query (`resolveBusinessPlanProductIds`); Business Home sweeps the ledger
  once, buckets by binary search, projects CMRR by interval (`committedWindow`) and is served
  through `cachedBusinessAnalytics` (2-minute single-flight, slow books only). Home 88 s → 18 s,
  one day's metrics 56 s → 30 s.
- **2026-10-22** — D4.5 memory: `computeMetricPeriod` reads the book a slice of 20,000 customers at
  a time (`book-scope.ts`) and sums the slices, so a day's working set no longer grows with the book.
  Loaders take the slice (`SnapshotMrrCache.scope`); `ratioPartial` / `mergeRatioPartials` /
  `ratioRows` split the ratios so they sum across slices; the flows read plan-at-start and first-paid
  for moved rows only. Subscription life is summed in exact milliseconds. Rows identical to before
  (1.34M rows across 3,787 businesses; 240k book). One day at 240k: 3.8 → 0.8 GB peak.
- **2026-10-24** — Sliced books (D4.5) dropped book counts. `bookMeasures` applied "a currency the
  business did not hold yet writes nothing" per slice, so a slice whose subscriptions in a currency
  were all created after the period end lost their stamped counts even though the whole book held
  that currency (a trial or activation dated before the row was created). The slices now return
  their totals and held currencies, and `computeMetricPeriod` applies the rule once over the whole
  book. Moves only books over 20,000 customers: `trials_started`, `activations`,
  `subscription_cancellations`, `trials_cumulative`, `trials_active` and `subscription_quantity`
  were too low on those days and now match the unsliced figure; a recompute corrects stored days.
- **2026-11-01** — `usage-margin.ts` + `GET …/reports/usage_margin` (`usage_margin:view`): revenue = line amount − discount − line-linked credit notes, before tax (inclusive tax backed out); margin = revenue − cost; lines without full cost counted in `lines_without_cost` and left out of both sides. One SQL fold, grouped by customer, model or meter per currency. Cover: `verify:usage-margin`.
- **2026-11-01** — Usage margin grouped by customer adds `customer_name` (name, else email) to each row.
- **2026-11-05** — Revenue mix (phase 0 of `docs/references/billing-model-reports-plan.html`). New measures `revenue_billed` (invoices; slices `revenue_type`, `product`) and `revenue_collected` (payments; slice `revenue_type`). `revenue_type` = recurring (incl. proration) · usage · one_time · credit_pack (a one-time line whose price has `grants_credit.kind = 'pack'`). Before tax and net of discounts: the document-level discount line is shared over the invoice's (or payment's) revenue lines pro rata, so both partitions sum to the total. Identities: billed = taxable base − rounding; collected = cash collected − tax − rounding − other − unattributed buckets. `billing_non_recurring` / `cash_non_recurring` are unchanged (they still include packs). Business Home Overview draws a Revenue mix card when the period has any type other than recurring. Gate: `verify:revenue-mix` (26). History: `pnpm metric-daily:backfill --all --measures revenue_billed,revenue_collected --fast [--write]`.
- **2026-11-05** — Credits (phase 1): `daily/credit-measures.ts`, source `credits`. Flows `credits_granted` (by `credit_category`, `credit_source`), `credits_used` (net of restores), `credits_used_cost`, `credits_expired`, `credit_breakage`, `credit_packs_sold`; stocks `credits_outstanding` (by category, `credit_unit`), `credits_liability`, `credit_customers`, `prepaid_balance` (customer balance ledger accounts, kept apart from grants); reading `credits_expiring` (by `horizon`). All rebuilt from append-only movements, so history is real. `billing-models.ts` `billingModelsPresent` (90 days of stored rows) gates the new Credits preset. Gate: `verify:metric-credits` (26, incl. ledger reconciliation of liability, breakage, promotional balance).
- **2026-11-05** — Usage (phase 2): `daily/usage-measures.ts`, source `usage`. `usage_events` (by `meter`, no currency, from `usage_rollups` — every generation is a different batch, so all are summed), `usage_customers` (distinct, per grain), `usage_cost` (full-cost usage lines, by meter), `usage_revenue_retention` (halves: usage revenue now from customers with usage revenue in the equal window before ÷ theirs then). No summed quantity: meters count different things. `revenue_billed` gains a `meter` slice over usage lines (from `rating.meter`; `none` when absent); meter names resolve in splits. Usage preset; presence also counts `usage_events`. Gate: `verify:metric-usage` (10).
- **2026-11-05** — One-time sales (phase 3): `daily/order-measures.ts`, source `orders`; the order rule is `daily/order-predicate.ts` `isOrder` (billed, no subscription, a one-time line that is not a credit pack), shared with the customer filters and segment facts. `orders`, `order_revenue` (by `product`, before tax, net of discounts), `order_refunds`, `average_order_value` (ratio sum/sum), `buyers`, `returning_buyers`, `returning_buyer_rate` (per grain). Presence of one-time sales is `orders`, not one-time revenue: a setup fee on a subscription is not a sale. One-time sales preset. Gate: `verify:metric-orders` (13).
- **2026-11-05** — Mixed businesses (phase 4): `billed_customers` and `revenue_per_customer` (halves `count`, so only the money half converts), per grain, in the invoice group. Presets: a business without subscriptions lists its model presets first, so Dashboards opens on one. Business Home: presence is its own small batch (the Overview batch is near the 48 cap); with no subscriptions in 90 days but another model, the Overview headline is revenue-led and the subscription-only cards and the Recurring tab are not drawn.
