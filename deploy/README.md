# tmbilling deploy — pm2 operator run book

Everything here is copy-paste. This file is the ordered command list; the *why* behind each
choice lives as a comment in the file it is about.

> Self-hosting with Docker instead? `deploy/docker/` (Compose, two images, an `init` service) is
> a separate path; its guide is the "Self-host with Docker" page in the developer docs.

**Three long-lived processes, all under pm2, all bound to loopback.** nginx (already on the
box) terminates TLS and proxies to them. There is no Docker and no Caddy — Postgres is a
system service, and nginx's vhost is yours to own; this run book only fixes the contract
between it and the app.

| Process | pm2 config | Command | Socket |
|---|---|---|---|
| **API** | `pm2/tmbilling-api.json` | `pnpm start` | `127.0.0.1:4001` |
| **Dashboard** | `pm2/tmbilling-dashboard.json` | `next start -H 127.0.0.1 -p 4101` | `127.0.0.1:4101` |
| **Billing worker** | `pm2/tmbilling-worker.json` | `pnpm worker` | `127.0.0.1:4002` (probes only) |

**The worker is not optional — it *is* the billing clock.** Nothing renews, duns, sends a
webhook or posts an email without it. An API-only deploy looks perfectly healthy and quietly
bills nobody.

**`billing` is the only worker role.** `pnpm worker` runs the engine's clock and nothing
else. The parallel-run poller (`pnpm worker:shadow`) was removed on 2026-09-07. The role flag survives because it is the seam a
future out-of-band process would use, and because a role you do not deploy schedules
nothing, so no backlog accumulates while it is absent (`src/platform/jobs.ts` §
`WorkerRole`).

## Files

| File | For |
|---|---|
| `pm2/tmbilling-api.json` | API — `pnpm start`, `PORT=4001` + `HOST=127.0.0.1` |
| `pm2/tmbilling-dashboard.json` | Dashboard — `next start -H 127.0.0.1 -p 4101` |
| `pm2/tmbilling-worker.json` | Billing worker — `node --import tsx src/worker.ts`, the clock. `kill_timeout` 35s |
| `create-admin.ts` | Bootstraps the first organization + dashboard login |
| `reload.sh` | **Deploy/reload — one command.** Change-scoped, health-gated, worker last |
| `pm2/tmbilling-api-cluster.json` | Opt-in: API in cluster mode, so `reload` is a real 0-downtime handover |
| `pm2/tmbilling-worker-cluster.json` | Opt-in: worker in cluster mode — the new worker starts before the old one drains (30 min budget) |
| `docs-deploy.sh` | Docs site deploy, run from your machine: build here, ship, swap, reload `tmbilling-docs` only |
| `pm2/tmbilling-docs.json` | Docs site — Nitro on `127.0.0.1:4201` serving `docs-site/.output` |
| `nginx/` | The box's nginx, as templates: `sites/*.conf`, `default`, `00-proxy-only.conf`, `10-proxy-buffers.conf`. Real hostnames come from the gitignored `nginx/nginx.local` |
| `nginx/check.sh` | **Run after any nginx change.** Proxy-only validation, drift against this repo, probes (§ 8) |

> **The paths below are the box's, and `cwd` in the three pm2 configs is the authority** —
> `ba8d2be9` moved the deploy from `/home/webadmin/projects/tmbilling` to
> `/var/www/html/projects/tmbilling` and updated only the configs, leaving this page naming a
> directory that no longer exists for two weeks. `deploy/reload.sh` now refuses to run when the
> checkout it was invoked from is not the one pm2 is running, so that specific lie — pulling
> here and reloading there, a deploy that reports success and ships nothing — cannot recur.

The env template is the repo root's **`.env.example`** — one file, kept beside the schema it
mirrors (`src/platform/config.ts`), so a new knob cannot be documented in one place and
missed in the other.

---

## 1 · Provision the box

Disk encryption on, at minimum for the volume holding Postgres's data directory. The
database holds the customer book and an append-only money ledger.

```bash
apt update && apt install -y postgresql nginx
# Replace the stock default site NOW — it serves /var/www/html (§ 8):
cp deploy/nginx/default /etc/nginx/sites-available/default && nginx -t && systemctl reload nginx
# Node via fnm, then pnpm through corepack (this repo is pnpm-only):
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm add -g pm2
```

## 2 · Postgres — loopback only

```bash
sudo -u postgres createuser --pwprompt tmbilling
sudo -u postgres createdb --owner=tmbilling tmbilling
```

Confirm it answers on loopback and nowhere else. The default Debian/Ubuntu package already
does; verify rather than assume:

```bash
grep -E "^listen_addresses" /etc/postgresql/*/main/postgresql.conf   # 'localhost'
ss -tlnp | grep 5432                                                  # 127.0.0.1:5432 only
```

## 3 · Clone, install, build

```bash
git clone <repo> /var/www/html/projects/tmbilling
cd /var/www/html/projects/tmbilling
pnpm install --frozen-lockfile      # ROOT ONLY — see below
pnpm build                          # builds the dashboard
```

**Never run `pnpm install` inside `dashboard/`.** This is a two-package pnpm workspace with
**one** lockfile at the root; installing in the sub-package resurrects the second lockfile
the workspace exists to remove and lets the two halves drift onto different versions of the
same dependency (`pnpm-workspace.yaml` says why). `pnpm build` is `--filter
tmbilling-dashboard build` and reaches it correctly from the root.

## 4 · `.env`

```bash
cp .env.example /var/www/html/projects/tmbilling/.env && chmod 600 /var/www/html/projects/tmbilling/.env
```

Leave `TMBILLING_EDITION` unset: an install of your own is the self-hosted edition (every feature,
no plans, no public sign-up). `cloud` is only for our hosted service.

Fill it in. Four that decide whether this deploy is correct rather than merely running — and the first three **refuse to boot** if you get them wrong, rather than degrading quietly:

- **`DATABASE_URL`** — the role and database from step 2.
- **`TRUST_PROXY_HOPS=1`** — **required**; `NODE_ENV=production` refuses to boot without it
  (`verify:security` § U gates this). It is how much of `X-Forwarded-For` may be believed, and
  it is load-bearing for every unauthenticated rate limit. `1` is the shape below: exactly one
  reverse proxy. Stating `0` is accepted, inheriting it is not — the parsed value cannot
  otherwise tell an operator's answer from the schema's guess, and the two fail in opposite
  directions (too many hops → the header is attacker-supplied and the limiter is silently a
  no-op; too few → the whole internet shares one counter and everyone gets 429).
- **`CLOUD_LOGGING=TRUE`** — **required**; production refuses to boot without it, together with
  `GOOGLE_CLOUD_PROJECT_ID` and `GOOGLE_CLOUD_CREDENTIALS_PATH` (see § Logs below). pm2 keeps
  stdout on the box, which is fine until the box is the thing you cannot reach — and the alert
  evaluator reaches a human *through* this sink, so a deployment without it has monitoring that
  cannot notify anyone. The refusal is about CONFIGURATION only: at runtime an unreachable Google
  logs to stdout and keeps billing.
- **`GATEWAY_CREDENTIALS_KEY`** — encrypts stored gateway credentials. Rotating it needs
  `GATEWAY_CREDENTIALS_KEY_PREVIOUS` set first (see § Rotating); swapping it alone makes every
  stored credential unreadable at once.

**This `.env` is the only settings file on the box.** The dashboard and the docs server read it
too, but copy in only their own keys (`.env.example`'s Dashboard and Docs site sections; the lists
are `dashboard/root-env.mjs` and `docs-site/server/lib/root-env.ts`), so the database URL and the
secrets never reach either process. The dashboard holds **no credential** — it authenticates to
the API as the signed-in operator by forwarding their session cookie. It needs
`TMBILLING_API_URL=http://127.0.0.1:4001` here and nothing secret.

`dashboard/.env.local` is optional and deprecated: if present it wins over `.env` for the
dashboard, and the real environment wins over both. The dashboard's `NEXT_PUBLIC_*` values, its
CSP mode and HSTS are fixed at build, so changing them needs a rebuild (`reload.sh --all`); its
other keys apply on the next start.

## 5 · Migrate, then seed the reference data

```bash
pnpm db:migrate
pnpm geo:seed
```

**`geo:seed` is required, not optional.** The API loads the country/subdivision set into
memory during boot — the address validators are synchronous because they run inside tax
resolution — and `loadGeoReference()` throws `countries table is empty` when the tables have
no rows, so the API *and* the worker refuse to start until it has run. That is deliberate: an
empty cache treated as "no list, accept anything" would leave every address unvalidated and
every `state_code` resolving to no place of supply, i.e. tax silently 0.

It needs no network — it reads the committed `db/seed-data/geo.json` — and it is idempotent,
so re-running is how a refresh is applied. (Refreshing `geo.json` from the upstream dataset is
a development task; never do it on a server.)

## 5b · The app's own login (tenant isolation)

The role from step 2 owns every table. Keep it for migrations only and run the app as
`tmbilling_system`: not a superuser, owner of nothing, so the tenant policies apply whenever
`withTenant` switches to `tmbilling_app`, and an injected statement can run no DDL. It bypasses
RLS for `systemDb` work (sign-in, token lookups, the clock's scans, the back-office).

```sql
-- as the owner, once
CREATE ROLE tmbilling_system LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD '…';
```

```bash
# as the owner, after migrations; safe to re-run
DATABASE_URL=<owner url> pnpm tsx scripts/lib/apply-sql.ts scripts/sql/system-role.sql
```

Then in `.env`: `MIGRATION_DATABASE_URL=<owner url>` and `DATABASE_URL=<same host and database,
user tmbilling_system>`, and restart every process (the API, worker, dashboard and back-office
read `.env` once at boot). `deploy/reload.sh` migrates as `MIGRATION_DATABASE_URL`; the
back-office migrator is run by hand, so prefix it the same way. If `pg_hba.conf` lists users,
add the new one. Rollback: point `DATABASE_URL` back at the owner and restart.


## 6 · Firewall

All three app sockets are genuinely loopback-bound, not wildcard sockets relying on the
firewall to look closed. Firewall anyway: it costs nothing and covers you if a process is ever
started without its env.

```bash
ufw default deny incoming
ufw allow 22/tcp         # SSH — adjust if this box uses a different admin port
ufw allow 80/tcp
ufw allow 443/tcp        # nginx
# 4001, 4101, 4002, 5432 intentionally NOT allowed: loopback-only by construction
ufw enable
```

## 7 · Start the three processes

```bash
# pm2 records the node it starts with; use fnm's stable alias, never a shell's temporary one.
export PATH="${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin:$PATH"
pm2 start /var/www/html/projects/tmbilling/deploy/pm2/tmbilling-api.json
pm2 start /var/www/html/projects/tmbilling/deploy/pm2/tmbilling-dashboard.json
pm2 start /var/www/html/projects/tmbilling/deploy/pm2/tmbilling-worker.json
pm2 save
```

Started from a plain shell, pm2 records fnm's per-shell node (`/run/user/<uid>/fnm_multishells/…`).
fnm deletes that directory later, and the next reload starts nothing while pm2 still says
"online". The deploy scripts put the stable alias first and refuse to reload an app whose
recorded node is gone (`deploy/lib/pm2-node.sh`), printing the `pm2 delete` + `pm2 start` repair.

`pm2 save` writes the process list; the unit below is what makes a reboot bring billing back.
Skipping it is how a box comes up with no API and no clock: production ran that way until D2.

### Start pm2 at boot: `deploy/systemd/pm2-webadmin.service`

Use this unit, not `pm2 startup`'s generated one. It runs the daemon on fnm's `default` alias (a
per-shell `fnm_multishells` path is gone after a reboot), sets `MALLOC_ARENA_MAX=2` on the daemon,
and waits up to 120 s for Postgres (`wait-for-db.sh`) before `pm2 resurrect`. Postgres runs in
Docker, so its container needs a restart policy too.

Installing it on a box whose daemon already runs from a shell restarts every app once (the same
gap as `pm2 kill`, below). Pick a quiet window: not 00:20–02:00 UTC, the nightly metric jobs.

```bash
sudo docker inspect -f '{{.Name}} {{.HostConfig.RestartPolicy.Name}}' $(sudo docker ps -q)
sudo docker update --restart unless-stopped <postgres container>   # only if it printed "no"
command -v pg_isready     # without it the gate does not wait (postgresql-client has it)
pm2 save
sudo cp deploy/systemd/pm2-webadmin.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable pm2-webadmin
pm2 kill && sudo systemctl start pm2-webadmin
systemctl is-active pm2-webadmin && pm2 ls
grep pm2-webadmin.service /proc/$(cat ~/.pm2/pm2.pid)/cgroup      # must print
curl -sf http://127.0.0.1:4001/readyz && curl -sf http://127.0.0.1:4002/readyz
```

Prove it with a real `sudo reboot`, then check the apps, the clock and the API. `reload.sh` warns
on every deploy while the daemon is not under this unit. Run `pm2 save` after adding or removing
an app, or the next boot restores the old list.

> ### ⚠ pm2's pid must BE the process — never a launcher
>
> All three configs exec `node` directly (`"script": "node"`). **Do not change any of them back
> to `pnpm <script>`, the `tsx` CLI, or a `node_modules/.bin/*` shim.** That is not a style
> preference; it caused a 46-minute billing outage on 2026-08-29.
>
> pm2 supervises the pid it spawns and nothing below it. With `script: pnpm` the real worker ran
> three levels down — pm2 tracked `185756`, the worker was `185812`. On restart:
>
> ```
> 18:34:00.000  pm2 → SIGINT to pnpm
> 18:34:00.042  the real worker starts its 25s graceful drain
> 18:34:00.114  the in-flight billing tick finishes its work
> 18:34:00.2xx  pnpm exits 0    → pm2 reads "app stopped cleanly"
> 18:34:00.3xx  pm2 treekills 6 pids, taking the still-draining worker with it
> ```
>
> It died between finishing the tick and writing the one statement that deletes the job and
> releases its `billing_clock` queue lock. graphile-worker expires no queue lock, ever, so the
> clock was locked out of its own queue by a dead worker until a human ran `force_unlock_workers`.
> Nothing renewed or dunned for 46 minutes, and every health tile stayed green.
>
> **`kill_timeout` was already 35000 and did not help.** It bounds how long pm2 waits for the pid
> it tracks — and that pid volunteered to exit in milliseconds. A drain budget is only real when
> the supervised process is the one draining.
>
> Check it after any config change:
>
> ```bash
> pm2 jlist | jq -r '.[] | "\(.name)  pid=\(.pid)"'
> tr '\0' ' ' < /proc/<pid>/cmdline     # must show src/worker.ts, not pnpm/sh
> pgrep -P <pid>                        # must be EMPTY — no child process
> ```
>
> The engine still runs TypeScript via `--import tsx` in production (there is no build step for
> it). That is a single in-process loader, not a wrapper, so it does not reintroduce the bug.
>
> Belt and braces, in the engine itself: `ops_release_stranded_locks` (boot + every 5 min) now
> releases any queue lock whose holder is not a beating worker, so an unavoidable hard kill — OOM,
> SIGKILL, host loss — self-heals instead of stopping billing. See `src/modules/ops/stranded-locks.ts`.

Confirm each one:

```bash
curl -sf http://127.0.0.1:4001/health    # {"status":"ok","db":"up",...}
curl -sf http://127.0.0.1:4101           # 200
curl -sf http://127.0.0.1:4002/readyz    # {"status":"ready","db":"up","queue":"up","heartbeat":"up"}
```

### `MALLOC_ARENA_MAX` belongs on the pm2 daemon

glibc reads `MALLOC_ARENA_MAX` once, at exec. A cluster-mode app gets its config's `env` only
afterwards: pm2 forks it with that env as one `pm2_env` JSON string and copies the keys into
`process.env` from JavaScript. So the key in `tmbilling-worker-cluster.json` changes nothing; only
the fork config's copy reaches glibc. A cluster child does inherit the DAEMON's environment, so set
it there (measured 2026-10-12: worker at 1.9 GB RSS, 1.89 GB anonymous, 106 MiB JS heap).

`pm2-webadmin.service` sets it on the daemon. On a box still running the daemon from a shell, the
variable goes on the command that starts it. Every app restarts, in a quiet window (not
00:20–02:00 UTC, the nightly metric jobs):

```bash
pm2 save && pm2 kill && MALLOC_ARENA_MAX=2 pm2 resurrect
tr '\0' '\n' < /proc/$(pm2 pid tmbilling-worker)/environ | grep '^MALLOC_ARENA_MAX='   # must print
curl -sf http://127.0.0.1:4002/readyz
echo 'export MALLOC_ARENA_MAX=2' >> ~/.bashrc    # so the next daemon started from a shell keeps it
```

`pm2 kill` is not a reload: no new worker starts before the old one stops, so it is a billing gap,
and a job cut off mid-run is recovered by the stranded-lock sweep. It can renumber the pm2 ids;
`reload.sh` uses names, so deploys are unaffected. If the resurrect fails, a plain `pm2 resurrect`
restores the apps without the variable. A daemon started without it (`pm2 update`, a reboot
followed by a manual resurrect from a shell lacking the export) loses the setting — check the
`environ` line after any of those.

## 8 · nginx

### Proxy only — the rules

**Why:** Ubuntu's stock `default` site (`listen 80 default_server; root /var/www/html; try_files`)
stayed enabled next to our vhosts, and the checkout lives at `/var/www/html/projects/tmbilling`.
Any request for the bare IP, or for a name no vhost listed (`http://www.<domain>`), was answered
from disk — `.env`, `dashboard/.env.local` and `.git/` included — for about two months, until
2026-10-24. No single line was wrong; four defaults lined up.

1. **nginx never serves files.** No `root`, `alias`, `try_files` or `autoindex` in any vhost.
   `00-proxy-only.conf` points the global `root` at a directory that does not exist, so even a
   forgotten fall-through finds nothing.
2. **Every server block has a catch-all `location /` that proxies or returns.** A block with only
   `location /some-prefix/` falls back to nginx's built-in html root for every other path.
3. **Explicit defaults that refuse.** Port 80: `deploy/nginx/default` (`return 444`). Port 443:
   `ssl_reject_handshake on` in `00-proxy-only.conf`. Without one, nginx answers unknown names
   with the alphabetically first vhost.
4. **Every hostname is listed and proxied by Cloudflare.** Aliases (`www`) go in `server_name`.
   `00-proxy-only.conf` admits only Cloudflare's ranges and loopback, so a grey-cloud (DNS-only)
   hostname gets 403 — and refresh the ranges from cloudflare.com/ips if they ever change.
5. **Secrets are `chmod 600`, owned by the app user.** A misconfigured web server (`www-data`)
   then cannot read them. Never deploy a checkout under `/var/www` on a new box.

**The files are the repo's.** `deploy/nginx/` holds the vhosts as templates; copy
`nginx.local.example` to `nginx.local` (gitignored — the API host and prefix are secret) and:

```bash
python3 deploy/nginx/nginx-tool.py render /tmp/nginx-out   # files as they belong under /etc/nginx
sudo bash deploy/nginx/check.sh                             # after ANY change on the box
bash deploy/nginx/check.sh --outside <box-ip>               # from your machine
```

`check.sh` fails on any rule above, on **drift** (the box's files differ from this repo, comments
and whitespace aside, or a vhost exists that the repo does not have), and on probes: the bare IP
refused on both ports, unknown names refused, every site answering. Change the repo first, then
the box — the same way code ships.

### Response headers — `proxy_buffer_size 16k`

**Why:** nginx holds an upstream's response headers in one `proxy_buffer_size` buffer, 4 KB by
default. On 2026-10-28 the dashboard sent 5.5 KB of headers (its Content-Security-Policy alone
was 4.5 KB, every payment gateway's hosts on every route) and nginx answered **502** "upstream sent
too big header" for the dashboard, portal and checkout. `127.0.0.1:4101` answered fine, so every
health gate passed.

- **The buffer:** `10-proxy-buffers.conf` (http level, `/etc/nginx/conf.d/`) sets
  `proxy_buffer_size 16k; proxy_buffers 8 16k; proxy_busy_buffers_size 32k;`. Keep it.
- **The budget:** `verify:security` § C2 computes each route class's headers from
  `dashboard/next.config.mjs`, adds 2 KB for Next's own, and fails above **8 KB**, half the
  buffer. The gateway hosts are on the storefront routes only (`/checkout`, `/portal`, `/buy`,
  `/pricing`), so the operator dashboard's CSP is under 1 KB.
- **Measure it:** `curl -s -D - -o /dev/null http://127.0.0.1:4101/login | wc -c` (and
  `/checkout`, `/portal`) gives the header bytes nginx must buffer.
- **The deploy checks through nginx.** After its health gates, `reload.sh` requests
  `https://app.<domain>/login` (must be 2xx/3xx) and `https://portal.<domain>/checkout` and
  `/portal` (must not be 502/503/504) with `curl --resolve <host>:443:127.0.0.1`, the path
  Cloudflare's traffic takes. The domain is `DEPLOY_CHECK_DOMAIN` (from the environment, else
  from `.env`), else `DOMAIN` in `nginx/nginx.local`; with neither, the check is skipped with a warning. A failure exits 1 and
  says the nginx path failed, not the app. It also warns when a response's headers pass 8 KB.

### The app contract

The vhost is yours; the contract is not. Two upstreams:

```
  api.example.com   →  http://127.0.0.1:4001
  app.example.com   →  http://127.0.0.1:4101
```

**`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`** is what makes
`TRUST_PROXY_HOPS=1` correct. nginx *appends* the real peer rather than replacing the header,
so a client-forged value survives in front of the true one — trusting exactly one hop reads
the last entry, which is the one nginx wrote. Do not configure it to pass a client-supplied
`X-Forwarded-For` through untouched, and do not raise the hop count to "be safe": more hops
means trusting further left, i.e. further into what the caller invented.

Also forward `X-Forwarded-Proto` (the app builds absolute portal/checkout links) and set
`proxy_read_timeout` above 60s on the API upstream — an import or a long report legitimately
exceeds the 60s default.

**The dashboard upstream is a second hop, and it is invisible to the engine.** A browser
request to `app.example.com` reaches Next, and Next opens its OWN connection to the engine
over `127.0.0.1:4001` — so from the engine's side the caller is the local Next process. The
dashboard therefore passes your `X-Forwarded-For` through UNCHANGED on every engine call
(`dashboard/lib/forwarded-for.ts`), which leaves `TRUST_PROXY_HOPS=1` correct for both
upstreams: one trusted hop, the last entry, the address nginx wrote. Do not raise the hop
count to "account for" the dashboard — Next appends nothing, so there is nothing extra to
trust, and raising it would start believing what the caller typed. Until this existed, every
audit row a dashboard action produced recorded `127.0.0.1`; `verify:security` § P now reads
every dashboard→engine call site and fails if one omits the header.

Rate limiting stays in the app (`RATE_LIMIT_ENABLED`, per-key and per-IP), not in nginx, so
the limit and the 429 envelope agree with the documented API.

Do **not** proxy port 4002. The worker's probes are unauthenticated and name the process's
role, pid and which dependency is down.

### Rate-limiting `/v1/analytics` at the edge

**This is a deploy step, not code — it will not happen unless you add it to the vhost.**
`GET /v1/analytics` will accept a request for twelve months of history, by day, split five ways;
that fan-out is cheap over the `metric_daily` table but it is still a lever a caller can pull
against the database, repeatedly, from one connection. Edge limits at nginx are the accepted
control for the 1.0 cut (`RELEASE.md` B11) — app-level per-key quotas are a follow-up, not a
prerequisite for exposing the endpoint.

Add a zone sized for a dashboard's own polling plus a handful of integrations, and apply it to
both analytics paths on the API upstream:

```nginx
# http{} block — one zone shared by both analytics routes
limit_req_zone $binary_remote_addr zone=analytics:10m rate=5r/s;

server {
    # ... existing api.example.com server block ...

    location ~ ^/v1/(analytics|businesses/[^/]+/analytics)$ {
        limit_req zone=analytics burst=20 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:4001;
        # ... same proxy_set_header lines as the rest of the API upstream ...
    }
}
```

`rate=5r/s` with `burst=20` gives one client room for a dashboard page's own chart requests
(a handful of widgets loading at once) without opening the door to a scripted sweep. Tune per
box: watch `nginx`'s access log for 429s from real dashboard traffic before raising it, and
raise `zone` size (10m ≈ 160k tracked addresses) rather than the rate if it's exhaustion, not
abuse. `$binary_remote_addr` is the client behind nginx — the same trusted hop `TRUST_PROXY_HOPS`
already relies on, so it keys correctly whether the caller is the dashboard's server-side fetch
or a direct integration.

## 9 · Create the first organization + admin

```bash
pnpm tsx deploy/create-admin.ts --email you@example.com --org-name "Your Org"
```

The password is **generated, never typed** — that keeps a strong secret out of shell history
and any deploy script's argv. It is printed once and cannot be recovered afterwards (only
reset through the dashboard's own flow). Copy it into a password manager immediately.

To mint an integration API key later:

```bash
pnpm tsx scripts/create-api-key.ts --org org_…
```

## 10 · Verify from outside the box

```bash
nmap -p 22,80,443,4001,4101,4002,5432 <box-ip>   # only 22, 80, 443 open
curl -I https://api.example.com/health           # 200 over TLS
```

`4001`, `4101`, `4002` and `5432` must be **closed**, not merely unlisted. Then
`bash deploy/nginx/check.sh --outside <box-ip>`: the bare IP must be refused on 80 and 443.

---

## Health probes

Both HTTP processes serve the same pair, and the distinction between them is the whole point.

| Probe | Checks | Point your… |
|---|---|---|
| `GET /healthz` | **nothing external** | liveness / restart policy |
| `GET /readyz` | DB + `graphile_worker` schema | readiness / load-balancer rotation |

**Never point liveness at `/readyz` or `/health`.** Both touch Postgres, so a database blip
would be read as every process being wedged and would restart the whole box at once — with
the simultaneous reconnects finishing the database off. A liveness probe's only correct answer
during a dependency outage is "still alive".

The worker is not an HTTP service, so it serves its own pair on `WORKER_HEALTH_PORT` (4002,
loopback; `0` disables). Without it you can only ask "is the PID there?", which stays true for
a worker that has lost its database and is failing every job it claims. Its `/readyz` adds two
states only it can report:

- **`draining`** — 503 for the whole 25s shutdown budget while `/healthz` stays 200, so a
  supervisor de-routes without also deciding the process is wedged.
- **`heartbeat`** — whether this process's own heartbeat write is still landing. `beat()`
  swallows its errors by design (a monitoring write must never be able to kill the clock),
  which means a worker that can no longer write to Postgres looks perfectly healthy from the
  inside without this.

```bash
curl -s http://127.0.0.1:4002/healthz | jq   # {"status":"ok","role":"billing","jobsActive":0,...}
curl -s http://127.0.0.1:4002/readyz  | jq
curl -s http://127.0.0.1:4001/readyz  | jq   # {"status":"ready","db":"up","queue":"up"}
```

The API's `/readyz` deliberately does **not** report the worker. It would take payments, the
portal and the dashboard offline because a background process died — turning a delayed
renewal into a total outage. Clock liveness is the worker's own probe and its
`worker_heartbeats` row.

## What to alert on

The engine records every signal below; routing them to a pager is yours. Alert on the log
events (any log sink can match them) or query the tables directly.

1. **The clock stopped.** No `alive` billing row in `worker_heartbeats` (10s beat, stale at
   30s), or the newest `clock_ticks` row older than ~3 minutes. Log events:
   `tick_unhealthy` (with `cause` = `run` / `lag` / `run+lag` / `errors`), `tick_failed`.
   `tick_clock_gap` is the deploy/restart case — warn, never page.
2. **The queue is falling behind.** The oldest due row in `graphile_worker.jobs` keeps ageing.
   ⚠ **`failed` is sticky**: cron ticks are `max=1` on purpose (the next tick re-scans, so a
   retry is pure duplication), so a tick killed mid-run leaves a row with
   `attempts = max_attempts` that nothing prunes. **Alert on that count rising, never on it
   being non-zero.**
Capacity, separately: `tick_pass_capped` names a pass that filled `TICK_SCAN_LIMIT` and did
**not** finish its work. One capping every minute means the clock is not keeping up.

Scaling note: **adding worker replicas does not make billing faster.** The tick is
single-flight by construction (`?max=1&queue=billing_clock` — graphile-worker serializes
within a named queue, across processes), so a second worker buys failover, not throughput.
When a tick outgrows its 60s window the fix is to move the slow pass onto its own cron line
and queue, the way the email and webhook drains already are.

## Logs — Google Cloud Logging

**Not optional in production — `NODE_ENV=production` refuses to boot with `CLOUD_LOGGING` unset
or FALSE** (`config.ts`, the production floor; gated by `verify:security` § U). The default is
FALSE for a laptop's sake, and a real host inherits that default by saying nothing: it boots,
serves, and ships nothing, with no error anywhere — the failure you discover during the incident
you have no logs for.

pm2 keeps stdout on the box; that is fine until the box is the thing you cannot reach. Set
these in `.env` and every line **also** goes to Google Cloud Logging — one service account and
one Logs Explorer query can cover several services, and a `traceId` minted upstream lands on
tmbilling's lines too.

```bash
CLOUD_LOGGING=TRUE                                   # off by default; the switch
GOOGLE_CLOUD_PROJECT_ID=<gcp-project>                # REQUIRED when on — config refuses to boot without it
GOOGLE_CLOUD_CREDENTIALS_PATH=/var/www/html/projects/tmbilling/cloudlogging.json
GOOGLE_CLOUD_LOG_NAME=tmbilling                      # the logName you filter on
CLOUD_LOGGING_LEVEL=info                             # sink threshold; stdout still honours LOG_LEVEL
CLOUD_PROVIDER=hetzner                               # free-form label on every entry
```

The service account needs **Logs Writer** (`roles/logging.logWriter`) and nothing else.
`cloudlogging.json` is in `.gitignore` — it had NOT been, while this page told operators to
put a private key at exactly that path, so `git add .` was one keystroke from committing it.
That is now enforced rather than advised.

`GOOGLE_CLOUD_SERVICE_CONTEXT` is set **per process** in `pm2/*.json` (`tmbilling-api` /
`tmbilling-worker`) so Cloud Error Reporting groups an API 500 separately from a worker crash
loop rather than folding them together.

**Verifying delivery.** `pnpm verify:logging` deliberately runs with NO credentials — it
proves the sink degrades safely when it cannot reach Google, so it can never prove the happy
path.

Two things that look wrong and are not: off GCP you get one `MetadataLookupWarning: All
promises were rejected` on startup (the auth library probing for a metadata server that only
exists inside Google; the `keyFilename` path then succeeds), and ingestion is not synchronous —
entries took ~10s to become queryable, so the probe polls rather than asserting once.

Reading them:

- **One execution end to end** — `labels.traceId="api-…"`, or click the trace on any entry.
  The id is also returned as the `x-trace-id` response header, so a failing request can be
  quoted straight into the query.
- **One module** — `labels.service="dunning"` (every module logs under its own name).
- **One tenant** — `labels.organizationId="org_…"` / `labels.businessId="biz_…"`. **Public**
  ids, the ones in URLs and on the dashboard, not row UUIDs.
- **Errors** — Error Reporting groups them; `message` holds the stack, `error_message` the
  clean text.
- **HTTP traffic** — one line per request, `jsonPayload.debug_info.event="http_request"`. The
  summary is `POST /v1/businesses/:biz/subscriptions` — method and route PATTERN, nothing
  else; `status`, `durationMs` and `path` (with the real ids) are fields. Severity follows the
  outcome, so `severity>=WARNING` is every failing request: 5xx error, 4xx warn, the probe
  routes debug, the rest info.

**Writing a log line.** The message is a **constant**; every varying value — id, amount,
count, status, duration — is a field. The message is the only thing a log viewer groups,
counts and alerts on, so a status baked into it makes each line unique and nothing can be
collapsed into "this route, this status, N times". `verify:logging` enforces this over source.

**Volume.** One entry per HTTP request at `CLOUD_LOGGING_LEVEL=info` on top of what the
modules log; probe polling costs nothing above debug. If the bill argues otherwise,
`CLOUD_LOGGING_LEVEL=warn` keeps warnings and errors in Google while stdout (and pm2's files)
keep the full stream on the box.

Failure modes, all deliberate: an unreachable sink logs `[cloud-logging] write failed` to
stdout and keeps serving; a full queue drops entries and says how many; an entry over the
256KB API limit is truncated (`_wasTruncated`, `_truncationMode`, `_originalSizeKB`) rather
than rejected. **Losing logs must never become losing billing.**

## Deploying a new version

One command. It finds the repo from its own location, so it does not care where the checkout
lives:

```bash
bash deploy/reload.sh                # or: pnpm run deploy:reload
bash deploy/reload.sh --dry-run      # print the plan — what changed, what would reload — and stop
```

It does the sequence below, and **reloads only the processes whose code actually moved**: a
dashboard-only commit never touches the API or the clock; a routes-only commit reloads the API
and leaves the clock running. `--all` overrides that, `--only api,dashboard,worker` narrows it,
`--no-pull --since <ref>` asks the question of a range someone already pulled.

**"Code it runs" excludes two things that live in the engine tree but are never opened by a
running process**, and both used to drag the billing clock into deploys that had no business
touching it:

- **The engine's own markdown** (`src/**/*.md`, `db/**/*.md`) — the 35 module READMEs. A bash
  `case` glob crosses `/`, so `src/*` swallowed them into the engine catch-all. Measured over
  134 commits: four reloaded the clock for no reason but a README, and one that changed only
  docs reloaded the API *and* the worker. Every change to a module appends to its README's
  changelog, so this fired on ordinary work rather than rare commits.
- **`db/migrations/**`** — applied by the `pnpm db:migrate` step in this same script and read
  by nothing else (`drizzle.config.ts` is the only thing that points at the directory). A
  migration shipping alone, such as a backfill or an index, needs no reload at all. In practice
  migrations travel with schema and code, which do reload both — that case is unchanged.

⚠ The markdown rules are matched **after** `dashboard/*` on purpose.
`dashboard/content/releases/*.md` is markdown the dashboard *serves* — the `/whats-new` release
notes — not documentation, so a blanket `*.md` rule placed above would stop shipping it.

```
git fetch + merge --ff-only     never a merge commit on the box
pnpm install --frozen-lockfile  only when a manifest or the lockfile moved. ROOT only
pnpm build                      only when dashboard/ moved
pnpm db:migrate                 always — idempotent, and never db:push
pnpm geo:seed                   only when db/seed-data/geo.json moved. BEFORE the reloads
pm2 reload tmbilling-api        then WAIT for 4001/readyz == ready
pm2 reload tmbilling-dashboard  then WAIT for 4101 to answer
pm2 reload tmbilling-worker     LAST, and only once the other two are healthy
curl --resolve … through nginx  app login + portal checkout/portal (§ 8 · Response headers)
```

Each gate blocks: if the API does not come back ready the script stops there and the dashboard
and worker are never touched, so a bad deploy leaves two of three processes on the last good
code. A failed gate prints the `pm2 logs` line to run and the `git reset --hard` to get back.

Three things it checks rather than assumes, printed at the end:

- **pm2 ids do not change.** Every process is `pm2 reload <name>` — never `delete` + `start`,
  which renumbers the whole list. Ids are snapshotted before and compared after.
- **the pid changed** for anything it reloaded, so a "reloaded" that silently did nothing is
  not reported as success.
- **pm2's pid IS the process** — no `pnpm`/`sh`/`.bin` shim in its cmdline, and *the app* is
  not running as a child of it. That is the 2026-08-29 outage shape, re-checked on every deploy
  rather than trusted to stay fixed. Helper children the app spawns for itself are printed as a
  note and otherwise ignored: tsx keeps an `esbuild --service` process alive to transform
  TypeScript (the API has one, the worker sometimes does not), and it holds no locks, no
  connections and no state, so pm2 reaping it after the app has drained costs nothing. The check
  originally warned on *any* child and failed a clean deploy over exactly that helper.

It takes a single-flight lock, so two overlapping deploys cannot interleave an install from one
commit with a build from another, and it refuses to run against a dirty tree (`--allow-dirty`
to override — but never `git stash` on a deploy box).

### `reload` is not 0-downtime while the apps are fork mode

pm2 6.x `God.reloadProcessId` (`lib/God/Reload.js:225`) falls through to `restartProcessId`
unless `exec_mode == 'cluster_mode'`, so for the three shipped configs `reload` and `restart`
are the *same call* — the verb makes no difference. Hammering `/healthz` sequentially through
one reload, measured on this codebase:

| API config | requests | connection-refused |
|---|---|---|
| `tmbilling-api.json` — fork, 1 instance | 1736 | **784** |
| `tmbilling-api-cluster.json` — cluster, 2 instances | 2277 | **0** |

The fork gap is 2.4s to boot past `loadGeoReference()` (which runs *before* `listen`) plus 3.6s
to drain. `deploy/reload.sh` uses `reload` throughout so switching costs no change there, and
**skipping a process whose code did not change** is what removes the gap today.

**To take the 0-downtime option** (`deploy/pm2/tmbilling-api-cluster.json`):

```bash
pm2 delete tmbilling-api
pm2 start  /var/www/html/projects/tmbilling/deploy/pm2/tmbilling-api-cluster.json
pm2 save
```

⚠ `exec_mode` cannot be changed by a reload, so that `delete` is a real stop and it
**renumbers the app's pm2 id, once** — after which the list shows two rows named
`tmbilling-api` and every later deploy is a `reload` that keeps them. Do it in a window.

Three things that config depends on, each measured rather than reasoned about:

- **It runs `src/server.ts`, not `src/index.ts`.** `index.ts` auto-starts only when it owns
  `process.argv[1]`, and under pm2's cluster wrapper argv[1] is pm2's own
  `ProcessContainer.js` — the app loads, logs *nothing*, listens on nothing, and pm2 reports it
  `online` with zero restarts. `src/server.ts` calls `start()` outright.
- **`node_args` must be an ARRAY.** `ClusterMode.js:36` guards on `Array.isArray`, so
  `"node_args": "--import tsx"` is ignored silently and the TypeScript loader is simply absent.
- **Two instances are safe for the API's own state.** Rate-limit counters are in Postgres
  (`platform/rate-limit.ts` is all `db.execute`), so a second instance does not double an
  allowance; and `ops_http_stats` has no unique index while its reader accumulates
  (`acc.requests += r.requests`, latency buckets merged), so two processes flushing the same
  (process, minute, route) cell sum correctly instead of colliding.

It does **not** reintroduce the launcher bug the other configs warn about: in cluster mode pm2
forks the worker itself and loads the app in-process, so the pid pm2 tracks is the pid running
the app (`pgrep -P` on it is empty). The worker stays fork mode — a second clock instance buys
failover, not throughput, and the tick is single-flight by construction.

**The dashboard build no longer touches the live one.** `next build` used to rewrite
`dashboard/.next` in place while the running `next start` was still serving
`/_next/static/<old build id>/…` out of it — 404'd chunks for anyone mid-navigation, for as long
as the build took. `next.config.mjs` now reads `distDir` from `NEXT_DIST_DIR`, so the script
builds into `dashboard/.next.staging` (old build untouched, whole build long) and swaps it in
with two renames immediately before the dashboard reload. The previous build is kept as
`dashboard/.next.prev`.

Verified rather than assumed: `next start` resolves `distDir` from `next.config.mjs` at RUNTIME,
so a tree built as `.next.staging` serves correctly once renamed to `.next` — measured `/` → 307,
`/login` → 200, ready in 291ms — even though `required-server-files.json` still records the
staging name.

**The staging build's cache is seeded from the live one.** Turbopack's compile cache and `tsc`'s
`.tsbuildinfo` both live INSIDE `distDir`, so building into a directory the script has just
deleted threw both away on every deploy — a cold build, every time. The script now copies
`dashboard/.next/cache` into `dashboard/.next.staging/cache` before building, and because the
swap renames staging over `.next`, the cache chains from one deploy to the next. Measured
locally: compile 9.5s → 5.1s and TypeScript 16.3s → 8.5s, from ~190MB of cache. Copied rather
than hardlinked — the old server is still serving out of `.next` and Turbopack rewrites cache
entries in place, which through a hardlink would corrupt the tree under the running process.

The post-build check is `dashboard/.next.staging/BUILD_ID`, not the directory: the cache seed
creates `.next.staging` before the build runs, so a directory test would pass for a build that
produced nothing.

⚠ **The staging build clears `dashboard/.next/types` first, and that line is load-bearing.**
Those are generated, build-time-only files (`next start` never reads them). An in-place
`next build` regenerates that directory and drops entries for routes that no longer exist;
building elsewhere leaves it behind, still matched by `.next/types/**/*.ts` in
`dashboard/tsconfig.json`, so `tsc` type-checks a validator from the PREVIOUS release. Hit on
the first real deploy: a page had moved into a route group, and the build died with
`TS2307: Cannot find module '../../app/(dashboard)/<old path>/page.js'` — a module the new tree
correctly does not have. It cannot reproduce on a dev machine, where `.next` holds *dev* types
under `.next/dev/types` and no production validator exists to go stale.

⚠ **`dashboard/tsconfig.json` carries two committed `.next.staging/types/**` include globs, and
they are load-bearing.** `next build` auto-manages that file: seeing a custom `distDir` it
appends those globs itself. Uncommitted, the first deploy would modify a tracked file and the
*next* deploy would refuse to start against a dirty tree. The script also compares the tree
before and after the build and names any tracked file the build touched, so a future Next
writing something new explains itself at the moment of cause.


**`geo:seed` runs BEFORE the restarts, not after.** The reference set is read once at boot, so
a process started against empty tables dies with `countries table is empty`, and one started
against *stale* tables serves the old data until it is restarted again. When in doubt, run it —
it is idempotent and takes seconds.

**Migrations are an explicit step. Never `db:push` against production.**

Restarting the worker costs a clock gap, not correctness: cron ticks are never retried, but
every pass re-scans for due work, so a missed minute is deferred rather than lost. It logs as
`tick_clock_gap` — a warning, distinct from an overrun, precisely so a deploy does not page.

**`kill_timeout` must stay above `WORKER_SHUTDOWN_TIMEOUT_MS`** (35s vs 25s in the shipped
config). If pm2 SIGKILLs the worker mid-tick, the `clock_ticks` row is left open and reads as
`abandoned`, and the tick job is left in `graphile_worker.jobs` counting as `failed` forever.

### Long jobs and the drain (2026-09-27)

A fork reload is stop-then-start, so the 25 s drain is also a billing gap and cannot grow. Jobs
outrun it: on production `metric_windows_refresh` takes ~46 s every run, `metrics_daily_snapshot`
~60 s, the drift scan ~100 s, a HubSpot connection sync ~10 min. A job cut off mid-run leaves its
named-queue lock behind until the 5-minute stranded-lock sweep proves the holder dead.

`pm2/tmbilling-worker-cluster.json` removes the trade-off: `wait_ready` starts the new worker and
waits for its `ready` message before stopping the old one, which then drains for up to 30 min
while the new process already owns the clock. Overlap is safe — graphile serializes a named queue
with a row lock, and the draining worker keeps heartbeating so the sweep never releases its locks.
Measured locally: old worker drained 29 s with the new one online, stopped unforced.

Switching is one-time and manual (a reload cannot change `exec_mode`); `reload.sh` picks the
cluster file automatically afterwards (`cfg_file`). A deploy then takes as long as the longest
running job, up to the budget.

A cluster child starts in the pm2 **daemon's** cwd, not the app's, and receives the config's
`env` only after preload, so the cluster configs load `deploy/pm2/tsx-preload.mjs` by absolute
path (it registers tsx with an absolute tsconfig). The first switch used a bare `--import tsx`,
crash-looped with no app log and rolled back (2026-09-27). Test a cluster config
with the daemon started from somewhere OTHER than the repo — that is how prod runs. Cluster
children also run on the daemon's node (`/usr/bin/node`), not fnm's.

```
pm2 delete tmbilling-worker
pm2 start  deploy/pm2/tmbilling-worker-cluster.json
pm2 save
```

Before 2026-09-27 no budget mattered: graphile's own SIGINT handler started the shutdown first,
our `runner.stop()` then returned at once, and the worker exited ~0.5 s after the signal whatever
was running. `noHandleSignals: true` (platform/jobs.ts) and `drainJobs` (platform/worker-drain.ts)
fix that for both modes.

### Switching on the renewal pipeline

Off by default, the billing clock renews inline: a share of each one-minute tick, about 0.4
renewals a second on a 4-core box. Three settings turn renewals into a pipeline (renew → number →
charge). They need no new process: the billing worker queues the renewals, numbers the invoices
and runs the charging pump itself. Switch them on one at a time, in this order. Each is an `.env`
edit followed by

```bash
bash deploy/reload.sh --no-pull --only worker
```

| Step | `.env` | What changes | Check after it |
|---|---|---|---|
| 1 | `WORKER_LOCAL_QUEUE_SIZE=<WORKER_CONCURRENCY + 1>` `WORKER_JOB_BATCH_DELAY_MS=250` | graphile fetches jobs in batches and batches their completion writes | ticks finish every minute; no failed jobs; no stranded locks |
| 2 | `RENEWAL_FANOUT=TRUE` | the tick queues one `renew_subscription` job per due subscription; the worker's job slots renew them in parallel | renewals land within minutes of their period end; no `renew_subscription` errors |
| 3 | `RENEWAL_BATCH_NUMBERING=TRUE` | renewal invoices commit unnumbered; `number_invoices` numbers them in batches and the pump charges them | `select count(*) from invoices where awaiting_number` drains to 0 within minutes; renewal charges succeed as before |

`COLLECT_LANES` (default `WORKER_CONCURRENCY`) is how many charges the pump keeps in flight. A
charge mostly waits on the gateway, so raise it when charging falls behind renewing.

**Turning a step off** is the same edit back and the same reload. Work already in the pipeline
still finishes: the clock re-requests numbering for any invoice left unnumbered, and the billing
worker runs the pump (once a minute while batch numbering is off) for any invoice left to charge.

**Measured** (one worker, Postgres on the same 4 cores, 7.5 GB; 240,000 subscriptions due at
once): renewals 0.4/s inline → 2.4/s with step 2 → 10/s renewed, or about 4.5/s renewed and
charged with `COLLECT_LANES=48`, with step 3. One worker process is one core of JavaScript, about
170 ms of worker CPU and 170 ms of Postgres CPU per renewal and charge; worker memory stayed at
about 800–900 MB at every step. A worker killed mid-peak and restarted left nothing charged twice,
renewed twice or unbilled. For more throughput, run another worker process (`collect` charges,
`clock` renews) before anything else.


## Stopping billing

- `pm2 stop tmbilling-worker` — halts the **clock**. Nothing renews, duns, or sends a webhook
  or email until it is back. Nothing accumulates that a restart cannot drain: every pass
  re-scans.
- `pm2 stop tmbilling-api` — stops the public surface; the clock keeps billing.
- The engine owns subscription state, so stopping a process never leaves a provider holding
  state we have forgotten. Anything already charged is already in the ledger.

## Upgrading Node on the box

**The three processes are pinned to the node binary that was on PATH when they were first
started, and no reload will move them.** pm2 resolves `script: "node"` to an ABSOLUTE path at
start and stores it in `pm_exec_path`. Measured with 22.15.1 on PATH against an app started
under 20.18.2:

| action | what the app then ran |
|---|---|
| `pm2 reload <name>` | **v20.18.2** |
| `pm2 update` (restarts the pm2 daemon) | **v20.18.2** |
| `pm2 reload <config.json>` | **v20.18.2** |
| `pm2 delete` + `pm2 start` | v22.15.1 |

So an upgrade that installs a new Node and reloads changes **nothing**, silently. Only
re-creating the app re-resolves the binary — and that renumbers its pm2 id, once.

Worth knowing even if you never upgrade: `next build` and `pnpm db:migrate` run under the
**deploy shell's** node, while the apps run under their own pinned one. A box can build on one
major and serve on another without saying so anywhere. `deploy/reload.sh` prints each process's
real node in preflight and warns when it does not match `.node-version`, precisely because the
pnpm "Unsupported engine" line describes the shell and not the thing serving traffic.

```bash
# 1 · install what the repo asks for, and make it the default for this user
fnm install "$(cat .node-version)" && fnm default "$(cat .node-version)"
node --version                       # this is the shell that will start the apps

# 2 · what production is on RIGHT NOW (the authoritative answer, not `node --version`)
for a in tmbilling-api tmbilling-dashboard tmbilling-worker; do
  p=$(pm2 pid "$a"); printf '%-22s %s\n' "$a" "$(readlink -f /proc/$p/exe)"
done

# 3 · re-create each app so pm2 re-resolves the binary. Worker LAST, ids renumber.
pm2 delete tmbilling-api       && pm2 start deploy/pm2/tmbilling-api.json
curl -sf http://127.0.0.1:4001/readyz | jq -r .status          # ready

pm2 delete tmbilling-dashboard && pm2 start deploy/pm2/tmbilling-dashboard.json
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4101/   # 2xx/3xx

pm2 delete tmbilling-worker    && pm2 start deploy/pm2/tmbilling-worker.json
curl -sf http://127.0.0.1:4002/readyz | jq -r .status          # ready

pm2 save                             # or a reboot restores the OLD ids and configs
```

`pm2 delete` stops the app before removing it, so the worker's drain budget applies the same way
a reload's does — watch for its `worker_shutdown` line before it goes, and do this in a window:
the API is a real stop here, not a rolling reload.

**Then re-note the ids.** They will not be 4 / 5 / 3 any more, and `pm2 save` is what stops a
reboot from resurrecting the old pinned binaries.

## Rotating / rebuilding

- **Backups.** Managed or `pg_dump`, and **rehearse a restore at least once**. The ledger is
  append-only, so a bad restore is unrecoverable money data — an untested backup is not a
  backup.
