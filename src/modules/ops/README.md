# ops — the instrumentation the billing engine runs on

> Source: `src/modules/ops/` · Schema: `db/schema/platform.ts` (`clock_ticks`, `worker_heartbeats`),
> `db/schema/ops.ts` (`due_work`, `ops_http_stats`) · No API routes.
> Layer: foundation (see docs/architecture/architecture.json)

## Purpose
The records and safety mechanisms the billing clock needs to run correctly, and the evidence an
operator needs to tell whether it is running. This module **writes**; it serves no screen. How
those records are read, judged and alerted on is up to the deployment — every signal is a row
or a log event (see `deploy/README.md` § What to alert on).

## Responsibilities
| File | What it owns |
|---|---|
| `clock-ticks.ts` | Open/close one `clock_ticks` row per clock run: counters, per-item errors, every pass, the trace id, and the overrun / downtime-gap verdict. |
| `heartbeats.ts` | Each worker process's own liveness row (`registerWorker`, `beat`, `markWorkerStopped`), the derived alive/stale/stopped view (`listWorkers`), and `liveGraphileWorkerIds` for the lock sweep. |
| `stranded-locks.ts` | Release a named-queue lock whose holder is proven dead. The fix for the 2026-08-29 outage. |
| `due-work.ts` | The `due_work` index: what the clock owes and when, maintained by triggers; `refreshDueWork` reconciles it with its sources (`dueWorkSources`). |
| `http-stats.ts` | Per-minute request counts and latency histograms per route, buffered in-process and flushed to `ops_http_stats`; `sweepHttpStats` enforces retention. |
| `buyer-rejections.ts` | `recordBuyerRejection`: one `buyer_request_rejections` row per request body `badRequest` refuses on the portal or hosted checkout, values redacted, fire-and-forget; `sweepBuyerRejections` keeps 30 days. |
| `retention.ts` | The nightly retention sweep (D17, cron `retention_sweep` 02:30 UTC). Per organization: events, finished webhook deliveries, gateway calls, gateway webhooks' contents, sent emails' bodies, finished idempotency keys; platform: clock ticks, invariant results, gateway logs with no business. Mode and periods from `retention_defaults` + `organization_retention` (0357), set in the back-office. |
| `api-errors.ts` | `recordApiServerError`: one `api_server_errors` row per 5xx from `setErrorHandler` — route pattern, error name/code, credential-redacted message + 15 stack frames, tenant refs, trace id; capped at 120 rows/min per process. `sweepApiServerErrors` keeps 30 days. |

## Invariants & gotchas
- Both clock tables and `due_work` are **platform-global (no RLS)**: the clock crosses tenants.
- **Liveness is derived, never stored.** A row is `stale` when `last_beat_at` is older than
  `WORKER_STALE_MS` (30s) with no `stopped_at`; `stopped` only on a clean SIGINT/SIGTERM.
- **A gap between ticks is not evidence of lag.** `overran` means the tick ran past
  `TICK_OVERRUN_MS`, or started past `TICK_LAG_MS` while a worker was up for the whole gap
  (`workerAliveThroughout`). A gap no process spanned is `downtime_gap` (restart, deploy).
- `beat` and `markWorkerStopped` **swallow their errors on purpose** — a failed monitoring write
  must not take the clock down. `beat` returns whether the write landed, and the worker's own
  `/readyz` reports it.
- **Retention never touches money records.** `dry_run` (the shipped default) only counts. An event
  outlives every delivery still kept or pending (deliveries cascade from it); a pending email keeps
  its body; a gateway webhook keeps its dedup key, type, outcome and times (only `payload`,
  `headers`, `normalized` and `error` go), so a replayed delivery stays a duplicate forever;
  `in_progress`/`side_effects` idempotency keys belong to `reapStaleIdempotencyKeys`; the
  latest result of each invariant check is kept however old. Events stay ≥ 31 days because the
  yearly renewal reminder dedups on its event.
- **A queue lock is released only once its holder is proven dead**, never by age: breaking a live
  lock lets two ticks renew the same subscription. When any live worker has not reported its ids,
  the sweep abstains.
- The worker passes `events:` into graphile-worker's `run()` explicitly; omitted, the per-worker
  job counters on the heartbeat row stay 0.

## Changelog
- **2026-10-13** — Reduced to the writer side. The read models, the alert evaluator, the
  invariant checks and the HTTP routes that sat on top of these tables are no longer part of the
  engine; `dueWorkSources`, `INF` and `minuteFloor` are exported for readers outside it.
- **2026-10-14** — `job-runs.ts` + `job_runs` (0339): the nightly jobs (`metrics_daily_snapshot`,
  `metric_daily_restate`, `metric_daily_drift_scan`) each record a run, opened at start and closed at
  the end, so a run that never finished stays visible. Recording never fails the job.
- **2026-10-14** — `buyer-rejections.ts` + `buyer_request_rejections` (0340): a request body refused
  on a buyer surface is recorded, so a buyer stuck on a validation error shows in the back-office
  error feed instead of only the log file. Clock pass `sweep_buyer_rejections` keeps 30 days.
- **2026-10-14** — `api-errors.ts` + `api_server_errors` (0341): every unhandled API failure (5xx)
  is recorded for the back-office error feed, which until now never saw one. Clock pass
  `sweep_api_errors` keeps 30 days.
- **2026-10-21** — `refreshDueWork` upserts only rows missing or moved: upserting the whole book locked every `due_work` row for the statement (ON CONFLICT locks even when its WHERE skips), so renewals' `due_work_sync` triggers queued behind it and the refresh could write back a due date a renewal had just moved. `findStrandedQueueLocks` also reports dead workers' locks on jobs outside a named queue. A `clock` worker counts as alive.
- **2026-10-21** — graphile-worker 0.18: a lock's `locked_by` names the worker POOL. The heartbeat publishes pool and in-pool worker ids (`platform/graphile-lock-ids.ts`), so the stranded-lock sweep still tells a live lock from a dead one; with worker ids alone it would release held locks. `verify:stranded-locks` now checks the lock a real 0.18 runner writes (mutation-tested) and runs in `verify:all`.
- **2026-10-22** — `retention.ts` (D17 step 1): the nightly `retention_sweep` (own queue
  `retention`, reports role) removes log-style rows past their period, in batches of 5,000 within
  a 15-minute budget, least recently swept organization first. Per-organization mode
  (`off`/`dry_run`/`on`) and periods in `organization_retention`, defaults in `retention_defaults`
  (0357), each run's counts recorded on the row. `verify:retention`.
- **2026-10-28** — `retention.ts`: a gateway webhook (`provider_events`) past `gateway_logs_days`
  is stripped, not deleted: `payload`, `headers`, `normalized` and `error` set to null; the dedup
  key, type, outcome and times stay. Deleting the row also deleted the only guard against a
  replayed delivery of a body-signed gateway. The count key stays `gateway_webhooks`.
  `verify:retention` checks the strip and that a redelivery is still a `duplicate`.
- **2026-10-25** — `retention.ts`: the API request log (0392) as `api_log_writes` / `api_log_reads`
  (`apiLogDatasets`, periods `api_log_writes_days` 90 / `api_log_reads_days` 30, 0393). A second
  pass after the per-organization loop deletes them in every mode, Off and Dry run too, and merges
  the counts into the organization's `last_run`.
