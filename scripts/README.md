# scripts/ — verify suite, seed, db + migration tooling

All run via pnpm scripts (see `package.json`) with `tsx`. Groups:

## Verify suite (`verify-*.ts`, ~70 scenarios) — the de-facto test strategy

End-to-end scenario verifiers against a **local seeded DB + running services**. Each stands up
real data through the API/services and asserts ledger/invoice/subscription outcomes.

> **`probe-*.ts` are NOT gates.** They print what a flow actually does, end to end over real HTTP,
> so a human can read the outcome — they assert nothing and nothing runs them in CI. Run them
> directly (`tsx scripts/probe-trial-change.ts`); they carry no `pnpm` alias on purpose, so no one
> mistakes one for a verifier. They exist because some defects are only legible once something has
> to render the numbers: `probe-trial-change` is what caught the storefront telling a trialing
> buyer they had been *credited* the new plan's full price. Promote a probe's findings into a
> `verify-*.ts` assertion once you know what to assert — the probe is the investigation, not the
> pin.

- Run one area: `pnpm verify:<name>` — e.g. `verify:ledger`, `verify:renewal`, `verify:proration`,
  `verify:coupons`, `verify:tax`, `verify:subscriptions-v2`, `verify:invoices-v2`, `verify:gateway`,
  `verify:time-travel`, `verify:logging`, `verify:conformance:pricing|usage`. Full list in
  `package.json`.
- Pick the suite(s) matching the module you touched (module READMEs + `docs/GUIDE.md` §3.5 tell
  you which); add a new `verify-<feature>.ts` for every new feature.

**Opt-in LIVE-sandbox suites** (real provider API calls, test keys only, never in the full suite):
`verify:stripe-live` · `verify:paypal-live` · `verify:razorpay-live` · `verify:razorpay-emandate-live` ·
**`verify:razorpay-pro-amounts`**. The last one is the one to reach for when the question is *"can we
bill this plan?"* rather than *"does the rail work?"* — it runs REAL PLAN PRICES (₹56,118 and ₹5,61,180)
across card/UPI/netbanking on both the buyer-present and off-session paths, because every rail passes at
₹50 and the ceilings that decide the answer (RBI ₹15,000 · NPCI ₹1,00,000 · the account's own
per-payment maximum) all sit far above it. Shared checkout-driving helpers:
`scripts/lib/razorpay-checkout.ts`.

## Setup

`pnpm setup:local` (`setup.sh`) — one command from a fresh clone to a seeded dashboard: `.env` +
generated secrets → `db:migrate` → `geo:seed` → `pnpm seed`. Flags `--yes` / `--reset` / `--small`.
Prose runbook: `SETUP.md`.

## Database

`pnpm db:generate` (Drizzle migration from schema diff) · `pnpm db:migrate` · `pnpm db:push` ·
`pnpm db:studio` · `pnpm seed` (Demo Org: three test businesses with 10–14 months of engine-made history, loaded in seconds from the snapshot in `db/seed-data/demo/`; `--small` for the smaller snapshot, `--live` to run the engine generator instead; code in `seed/`) · `pnpm seed:capture` (regenerate that snapshot in a throwaway database) · `pnpm db:reset` (drop + migrate + seed).


Queue repair (same convention): `tsx scripts/purge-redundant-clock-ticks.ts [--write]` — deletes
`billing_clock_tick` jobs backed up on the `billing_clock` queue, keeping every locked row and the
newest pending one. Safe only because a queued tick carries no arrears: every pass scans as of the
instant it RUNS, not the job's `run_at`, so a backlog is N copies of one instruction. Needed once per
deployment that ran a build predating the `jobKey` cron option (2026-09-01); after that the option
caps the queue at one running + one waiting and there is nothing to purge. Refuses to run if
`graphile_worker.jobs` does not have the columns it expects.

## Load test (`loadtest/`) — roadmap D4

A local, production-shaped load harness. Everything runs against the `postgres-load` container
(Postgres 17 on :5433, pinned to 4 cores / 7.5 GB / no swap like the production box; Postgres
settings are stock defaults, as production's are) and refuses any other database
(`guard.ts`: `LOADTEST=1`, a `*_load` database on localhost, the console mailer).

```
docker run -d --name postgres-load --cpuset-cpus=0-3 --memory=7.5g --memory-swap=7.5g --shm-size=1g \
  -p 127.0.0.1:5433:5432 -e POSTGRES_PASSWORD=loadtest -e POSTGRES_DB=tmbilling_load \
  -v tmbilling-load-pg:/var/lib/postgresql/data postgres:17 -c shared_preload_libraries=pg_stat_statements
bash scripts/loadtest/reset.sh                    # empty, migrated, geo rows
. scripts/loadtest/env.sh                         # every command below needs this
pnpm tsx scripts/loadtest/book.ts --customers 1000000          # ~1 h; 200 engine-made templates, cloned
pnpm tsx scripts/loadtest/book.ts --add-business "Shop 2"      # + a small business (2,000) due at the same peak
pnpm tsx scripts/loadtest/run.ts --minutes 30 --label baseline # S1: the worker renews the backlog
pnpm tsx scripts/loadtest/report.ts               # report.md for the latest run
pnpm tsx scripts/loadtest/reads.ts --rps 200      # S3: API read latency (run beside run.ts for "under peak")
pnpm tsx scripts/loadtest/pages.ts                # S3: dashboard page times (needs the dashboard build)
taskset -c 0-3 pnpm tsx scripts/loadtest/nightly.ts            # S4: nightly metrics chain
```

- **Book:** every customer of the main business renews at one instant (calendar billing), an hour
  before the build. Templates are signed up through the real API under Time Travel one month
  earlier, so each copy carries a real paid invoice, payment, ledger and tax rows. Copies skip the
  signup event/audit trail (~75% of a copy's size) unless `--full-history`.
- **Gateway:** tmtest with `TMTEST_LOAD_PROFILE=TRUE` — log-normal response time (P50 2.7 s,
  P99 8 s), production's 30-day decline mix at `TMTEST_DECLINE_RATE`, and a per-process
  `TMTEST_RATE_LIMIT_PER_S` bucket that throws like a 429 after one retry.
- **Outbound:** `run.ts` starts a webhook receiver (~250 ms) subscribed to every event and sets
  `MAILER_CONSOLE_DELAY_MS` (200 ms); `--no-outbound` turns both off. ⚠ The book is a TEST-mode
  business (tmtest and Time Travel need one), and test mode mails only team members, so renewal
  mail is written and skipped — its database cost is measured, its send time is not.
- **Worker:** production's settings (its `.env`, 2026-10-19) unless a flag overrides one;
  `--workers N` and `--kill-worker-at <min>` exercise D4.4. Every run checks no invoice was paid
  twice and no period renewed twice, and reports each business's backlog (fairness).
- While building a book, lift the container limits (`docker update --cpuset-cpus=0-11 --memory=16g
  --memory-swap=16g postgres-load`) and put them back (`--cpuset-cpus=0-3 --memory=7.5g
  --memory-swap=7.5g`) before any measured run. Output lands in `.loadtest/` (gitignored).

## Codegen / docs

`pnpm sdk:generate` (OpenAPI → `sdk/`; run after touching routes).
