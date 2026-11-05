# time-travel — test-business virtual clock

> Source: `src/modules/time-travel/` · Routes: `src/api/time-travel-routes.ts` · Schema: `db/schema/time-travels.ts`
> Layer: tooling (see docs/architecture/architecture.json)

## Purpose
Time Travel, test businesses only: a per-business virtual clock you can start (wiping the
test business's customer data) and travel forward, running the real billing pipeline (scheduled changes,
renewals, dunning, webhooks, tmtest async behaviors) at each tick so you can rehearse months of billing
in seconds. Live businesses get a 404.

## Responsibilities
- Start (`start_afresh`): pin the virtual clock at a genesis time and wipe customer data (catalog +
  settings kept).
- Travel forward: advance the clock in tick-sized steps, driving `billing_clock_tick` at each step.
- Stop: end the simulation (stop-wipe permanently deletes simulated data).
- Expose `businessNow(businessId)` semantics: real time unless time travel pins it.

## Data model
`db/schema/time-travels.ts` — `time_travels` (one per test business, `status`
not_enabled|in_progress|succeeded|failed, `genesis_time`, `simulated_now`, travel lease, error).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `startTimeTravel` | pin + wipe customer data |
| `travelForward` | advance the virtual clock in ticks (leased, serialized) |
| `stopTimeTravel` | end simulation |
| `getTimeTravel` | status |
| `timeTravelledBusinessIds` | which businesses the real clock must skip |

## API routes
| Method · Path | Purpose |
|---|---|
| `POST /v1/businesses/:biz/time_travel/start` | start_afresh |
| `POST .../time_travel/advance` | travel_forward |
| `GET .../time_travel` | status |
| `POST .../time_travel/stop` | stop |

## Events emitted
None directly (the driven billing passes emit their own events).

## Dependencies
- **Upstream (calls into):** none (reads/pins the clock; engine reads `businessNow`).
- **Downstream (called by):** none (the real billing clock consults `timeTravelledBusinessIds` to skip pinned businesses).

## Invariants & gotchas
- **Test businesses only** — live → 404. Start/stop-wipe are destructive (confirm in UI).
- Travel is **leased + serialized** (15-min self-expiring claim) so two concurrent travels can't
  interleave ticks and double-bill.
- Time-travelled businesses are skipped by the real tick and driven only by `travel_forward`.

## Changelog
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-09-27** — Rows written under a pin record the SIMULATED instant. A pin is a travel step (ALS scope) or an API request whose `:biz` is time-travelled (`resolveBusiness` → `pinRequestClock`, at `simulated_now`). `withTenant` then sets `app.business_now` (tx-local) for the `app_now()` column defaults and `bump_row_version` (0296), and engine code stamps via `stampNow()`. Unpinned paths — service calls, the worker, live businesses — are unchanged. `verify:time-travel-stamps`.
- **2026-10-04** — Renamed to Time Travel: table `time_travels` (0323), routes
  `/v1/businesses/:biz/time_travel` (+ `/start`, `/stop`), and the advance step is
  `POST …/time_travel/advance`. Suites: `verify:time-travel`, `verify:time-travel-stamps`.
- **2026-10-16** — `wipeTestBusinessData` is the stop-wipe on its own, behind
  `DELETE /v1/businesses/:biz/test_data` (all-mode key, test businesses only): deletes customers and
  everything transactional, keeps catalog and settings, and ends Time Travel.
- **2026-10-21** — `wipeTestBusinessData` deletes ledger rows through `app_wipe_test_ledger` (0352, SECURITY DEFINER, refuses a business not in test mode): the app's login has no DELETE on the ledger.
- **2026-10-26** — A travel step re-drives its instant until no clock pass is left capped or
  shed (at most 20 runs; then the travel fails and `simulated_now` stays). Before, a renewal pass
  that ran out of its 15 s budget left the remaining subscriptions unrenewed at that instant,
  which made `verify:current-usage` fail under parallel load. `verify:time-travel-capped`.
- **2026-11-03** — A travel step no longer runs the crash reapers on the simulated instant. `reapStaleIdempotencyKeys` and `reapStuckTransfers` compare wall-clock stamps, so the tick passes them its real start time; before, a step deleted live `in_progress` keys and failed live `side_effects` keys in every organization. `verify:idempotency-race` F5 (branch `feat/cashfree-intl-subscriptions`).
- **2026-11-04 (G3b)** — Each travel step runs the `plan_credit_resets` pass for the travelled business before the tick (the cron skips travelled businesses).
