# SETUP.md — local setup, from an empty machine to a dashboard full of data

The one-page runbook: bring up Postgres, build the schema, then **fill the database with
`pnpm seed`** — three demo businesses with over a year of billing history, produced by the real
engine, so every dashboard page and report has something to show.

> Conceptual background lives in the canonical docs — [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
> and [`docs/GUIDE.md`](./docs/GUIDE.md). This file only sequences the commands.
>
> Want to run it, not develop it? `deploy/docker/` installs everything with Docker Compose — see
> the "Self-host with Docker" page in the developer docs.

---

## The short way

```bash
fnm use && pnpm install
pnpm setup:local            # env → schema → geo → seed
```

`scripts/setup.sh` runs every step below in order and stops with a hint on the first failure.
Flags: `--yes` (no prompts), `--reset` (truncate tenant data first), `--small` (a quicker, smaller
seed).

Re-running needs `--reset`: the seed mints a fresh org, and signup refuses the duplicate login, so
a second run otherwise stops at `An account with that email already exists`.

---

## 0. Prerequisites

| Need | Check | Notes |
|---|---|---|
| Node 24 via `fnm` | `fnm use && node -v` → `v24.21.0` | `.node-version` pins it |
| `pnpm` | `pnpm -v` | **Never** npm/yarn/bun — the lockfile is `pnpm-lock.yaml` |
| Postgres 17 | see §1 | must be a **superuser** connection: migration `0001` runs `CREATE ROLE tmbilling_app` |

---

## 1. Postgres

**Option A — the repo's compose file** (fresh machine, nothing on 5432). `docker-compose.yml` has
no credential defaults, so put these in `.env` first (see §2) or the container refuses to start:

```bash
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_PORT=5432
```

```bash
docker compose up -d          # container "tmbilling-postgres", db "tmbilling"
docker compose ps             # wait for (healthy)
```

**Option B — a Postgres you already run.** Create the database and point `DATABASE_URL` at it:

```bash
createdb tmbilling
```

---

## 2. `.env`

```bash
cp .env.example .env
```

Then set, at minimum:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tmbilling
API_KEY_SECRET=$(openssl rand -hex 32)
GATEWAY_CREDENTIALS_KEY=$(openssl rand -hex 32)
PORTAL_BASE_URL=http://localhost:4100
```

`src/platform/config.ts` is the authority on every variable; `.env.example` documents them. An
exported `DATABASE_URL` wins over the file.

This is the only settings file you need. The dashboard and the docs site read it too, and copy in
only the keys in `.env.example`'s Dashboard and Docs site sections — the database URL and the
secrets never reach them. A `dashboard/.env.local` still works as an override but is no longer
needed. In a git worktree, which has no `.env`, prefix commands with
`DOTENV_CONFIG_PATH=<main checkout>/.env`.

`TMBILLING_EDITION` defaults to `self_hosted`, which is what you want: every feature, no plans and
no limits. Leave it unset. (`cloud` is our hosted service; it adds public sign-up, plans and
account billing, and they need services this repository does not run.)

---

## 3. Schema + reference data

```bash
pnpm db:migrate      # db:bootstrap (graphile_worker schema) + drizzle-kit migrate
pnpm geo:seed        # 250 countries + ~4.5k subdivisions
```

- `db:migrate` runs `db:bootstrap` first on purpose: migration `0130` grants on the
  `graphile_worker` schema, which graphile-worker creates at runtime.
- **`pnpm geo:seed` is not optional.** Address validation and tax place-of-supply read these
  tables; the seed fails without them.
- Migrations are hand-written; don't reach for `pnpm db:generate` (its snapshot is stale).

---

## 4. Seed

```bash
pnpm seed                  # load the demo snapshot — seconds; the history ends today
pnpm seed --small          # the smaller snapshot (fewer customers and months)
pnpm seed --write-env      # also write the org API key into dashboard/.env.local (for scripts)
pnpm seed --live           # run the engine generator instead — about 7 minutes
pnpm seed:capture          # regenerate the snapshot (runs --live in a throwaway database)
```

**What you get** — one org (**Demo Org**) with three test-mode businesses:

| Business | Currency / tax | History | Customers |
|---|---|---|---|
| Acme Analytics | USD, US-CA sales tax | ~14 months | ~275 |
| Nimbus Cloud | INR, India GST (intra- and inter-state) | ~12 months | ~75 |
| Fjord Tools | EUR, EU VAT | ~10 months | ~45 |

Each has a full catalog (Starter / Growth / Pro / Enterprise, monthly and yearly; per-seat add-ons;
metered usage; a setup fee; stairstep pricing; entitlements; coupons) and a book that behaves like a
growing SaaS: monthly signups, trials that convert or lapse, upgrades and downgrades with proration,
seat changes, voluntary and involuntary churn, dunning that recovers or gives up, pauses, reactivations,
usage, net-30 invoices with offline payments, credit notes, refunds, a void and a write-off.

**How it's made.** Nothing is inserted behind the engine's back. `pnpm seed:capture` starts each
business's **Time Travel** in the past, performs each day's actions through the API and services,
and drives the real billing tick for that day — renewals, invoices, charges, trial ends, dunning —
in a throwaway database, then dumps the result to `db/seed-data/demo/`. `pnpm seed` creates the org,
login, key and businesses fresh on your machine, loads those rows under them with new ids, moves every
date forward by whole days so the history ends today, and rebuilds the reporting tables. If the
snapshot no longer fits your schema (a migration it predates changed a column it holds) it says so
and falls back to `--live`. A second copy in the same database needs `--admin-email other@example.com`.
Cards are TM Test Gateway test numbers, so no money moves anywhere.

It prints a summary, the **login** (`admin@example.com` / `Sparrow-Lantern-9134`), and an **org API
key** — shown once — for scripts and integrations.

---

## 5. Run it

Three processes, each in its own terminal:

```bash
pnpm dev               # API on :4000  → curl localhost:4000/health
pnpm worker            # billing clock (graphile-worker)
pnpm dev:dashboard     # admin UI on :4100
```

Log in at http://localhost:4100 with the seed's login. The dashboard holds **no credential of its
own**: it forwards the operator's `tmb_session` cookie, so the org it serves is the org of the login.
It reads its settings (`TMBILLING_API_URL`, default `http://localhost:4000`) from the root `.env`;
restart it after changing them.

The engine loads geo reference data once at boot, so **restart the API and worker after
`geo:seed`** or a reseed.

---

## 6. Confirm the install

```bash
pnpm typecheck
pnpm test                     # vitest unit tests (billing math)
pnpm verify:catalog           # one end-to-end suite; needs the API + worker up
```

Every `verify:*` suite writes test data to the database in `DATABASE_URL`; run them against a
database you can throw away.


---

## Starting over

```bash
pnpm db:reset && pnpm seed    # or: pnpm setup:local --reset
```

`db:reset` truncates tenant data but keeps the schema, migration history and geo tables, so there
is no need to re-run `db:migrate` / `geo:seed`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| compose: `POSTGRES_USER must be set in .env` | the compose file has no defaults — §1 Option A |
| `schema "graphile_worker" does not exist` at migration `0130` | ran `drizzle-kit migrate` without `pnpm db:bootstrap`; use `pnpm db:migrate` |
| `Country reference data not loaded` / `GeoNotLoadedError` | `pnpm geo:seed` not run, or the API/worker weren't restarted after it |
| `An account with that email already exists` | the seed already ran on this database — `pnpm db:reset` first |
| seed fails creating a trigger / role | `DATABASE_URL` is not a superuser connection |
| Every dashboard fetch 401s | no `tmb_session` cookie — the login expired, or the API on `TMBILLING_API_URL` isn't the one you signed in against |