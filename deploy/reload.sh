#!/usr/bin/env bash
#
# tmbilling deploy — one command: pull, install, build, migrate, then reload ONLY the
# processes whose code actually moved. Ordering and health gates follow deploy/README.md
# § Deploying a new version; the reasoning behind each gate lives there.
#
#   bash deploy/reload.sh                  # change-scoped: reload what the pull touched
#   bash deploy/reload.sh --dry-run        # print the plan, mutate nothing
#   bash deploy/reload.sh --all            # all three, regardless of what changed
#   bash deploy/reload.sh --only worker    # just one, no change detection
#   bash deploy/reload.sh --no-pull --all  # redeploy the tree as it stands (e.g. after an .env edit)
#   bash deploy/reload.sh --no-pull --since HEAD~3 --dry-run   # what would a given range reload?
#
# Exit status: 0 deployed · 1 failed · 3 deployed, but with warnings (listed at the end).
# DEPLOY_SKIP_PATHS (an extended regex) names paths no process here runs, for a wrapper that
# deploys them itself: they are neither reloaded for nor warned about.
# DEPLOY_CHECK_DOMAIN names the domain whose app./portal. hosts are checked THROUGH nginx after
# the reloads: from the environment, else from .env, else DOMAIN in deploy/nginx/nginx.local
# (deploy/README.md § 8).
#
# Three invariants this script exists to hold, each checked rather than assumed:
#
#   1. pm2 ids never change. Every process is `pm2 reload <name>` — never `delete` + `start`,
#      which renumbers. The ids are snapshotted before and compared after.
#   2. The worker is the billing clock. It is reloaded LAST, after the other two are healthy,
#      and ONLY when code it actually runs has changed (see services_for()). "Code it runs"
#      excludes the engine's own markdown and db/migrations/** — neither is opened by a
#      running process, and both used to drag the clock into a docs-only deploy.
#   3. pm2's pid must BE the process, never a launcher. Checked after every reload — that
#      shape is what caused the 46-minute billing outage of 2026-08-29.
#
# On `reload` vs `restart`: for a FORK app they are the same operation. pm2 6.x
# `God.reloadProcessId` (lib/God/Reload.js:225) falls through to `restartProcessId` unless
# `exec_mode == 'cluster_mode'`, so the shipped fork configs get a stop-then-start whichever
# verb you type — measured at 784 connection-refused replies through one reload (2.4s to boot
# past loadGeoReference, 3.6s to drain). `deploy/pm2/tmbilling-api-cluster.json` is the opt-in
# that makes it a real rolling handover (measured: 2277 requests, 0 failures); this script uses
# `reload` throughout so that switching needs no change here. Until then, not reloading a
# process at all when nothing it runs changed is what removes the gap.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
# shellcheck source=lib/pm2-node.sh
. "$REPO/deploy/lib/pm2-node.sh"
use_stable_node

API=tmbilling-api
DASH=tmbilling-dashboard
WORKER=tmbilling-worker

# ── options ──────────────────────────────────────────────────────────────────────
DRY=0; FORCE_ALL=0; ONLY=""; REF=""; PULL=1; SINCE=""
SKIP_INSTALL=0; SKIP_BUILD=0; SKIP_MIGRATE=0; ALLOW_DIRTY=0

usage() { sed -n '3,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)      DRY=1 ;;
    --all)          FORCE_ALL=1 ;;
    --only)         ONLY="${2:?--only needs a list: api,dashboard,worker}"; shift ;;
    --ref)          REF="${2:?--ref needs a git ref}"; shift ;;
    --no-pull)      PULL=0 ;;
    --since)        SINCE="${2:?--since needs a git ref}"; shift ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build)   SKIP_BUILD=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --allow-dirty)  ALLOW_DIRTY=1 ;;
    --)             ;;   # `pnpm run deploy:reload -- --dry-run` forwards the separator itself
    -h|--help)      usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 2 ;;
  esac
  shift
done

# ── output ───────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else B=""; G=""; Y=""; R=""; D=""; N=""; fi

WARNINGS=()
CFG_CHANGED=""   # pm2 config files this deploy touched; set by the scope block, read by preflight
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
dim()  { printf '    %s%s%s\n' "$D" "$*" "$N"; }
warn() { WARNINGS+=("$*"); printf '%s ⚠  %s%s\n' "$Y" "$*" "$N" >&2; }
die()  { printf '\n%s ✗  %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

trap 'st=$?; [ $st -ne 0 ] && printf "\n%s ✗ deploy aborted (exit %s) — nothing further was touched%s\n" "$R" "$st" "$N" >&2; exit $st' ERR

# ── single flight ────────────────────────────────────────────────────────────────
# Two overlapping deploys would interleave an install with a build and reload halves of
# two different commits.
LOCK="$REPO/.deploy.lock"
exec 9>"$LOCK"
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || die "another deploy holds $LOCK — wait for it, or clear it if that process is gone"
else
  printf '    %sflock is not installed — concurrent deploys are NOT prevented%s\n' "$D" "$N"
fi

START_TS=$(date +%s)

# ── pm2 helpers ──────────────────────────────────────────────────────────────────
# `pm2 jlist` can be preceded by a daemon-spawn banner on stdout, so parse from the
# first '[' rather than trusting the whole stream to be JSON.
pm2_snapshot() {
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const i = s.indexOf("[");
      if (i < 0) process.exit(3);
      for (const p of JSON.parse(s.slice(i)))
        console.log([p.name, p.pm_id, p.pid ?? 0, p.pm2_env?.status ?? "?", p.pm2_env?.exec_mode ?? "?"].join(" "));
    });'
}
snap_field() { awk -v n="$2" -v f="$3" '$1==n{print $f; exit}' <<<"$1"; }
snap_ids()   { awk -v n="$2" '$1==n{print $2}' <<<"$1" | sort -n | tr '\n' ' '; }
snap_pids()  { awk -v n="$2" '$1==n{print $3}' <<<"$1" | sort -n | tr '\n' ' '; }
snap_count() { awk -v n="$2" '$1==n' <<<"$1" | grep -c . || true; }

# Which config file belongs to a running app: a clustered API is served by
# tmbilling-api-cluster.json while still being NAMED tmbilling-api.
cfg_file() {
  local name=$1
  if [ "$(snap_field "${SNAP_BEFORE:-}" "$name" 5)" = "cluster_mode" ] && [ -f "deploy/pm2/$name-cluster.json" ]; then
    printf '%s' "deploy/pm2/$name-cluster.json"
  else
    printf '%s' "deploy/pm2/$name.json"
  fi
}
cfg_key()  { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  process.stdout.write(String(o[process.argv[2]] ?? process.argv[3]))' "$(cfg_file "$1")" "$2" "$3"; }
cfg_env()  { node -e 'const j=require("fs").readFileSync(process.argv[1],"utf8");
  const o=JSON.parse(j); process.stdout.write(String((o.env||{})[process.argv[2]] ?? process.argv[3]))' \
  "$(cfg_file "$1")" "$2" "$3"; }
cfg_port_arg() { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const m=/-p\s+(\d+)/.exec(o.args||""); process.stdout.write(m?m[1]:process.argv[2])' \
  "$(cfg_file "$1")" "$2"; }

# THE deploy failure this guards: `git pull` in one checkout and `pm2 reload` of an app running
# out of another. Every step reports success and nothing ships. `ba8d2be9` moved this deploy
# from /home/webadmin/projects/tmbilling to /var/www/html/projects/tmbilling and updated only
# the pm2 configs, so the two paths were live in the repo at once for two weeks.
#
# The LIVE process's cwd is fatal — that is the actual mismatch. The config file's cwd is a
# warning, because it only takes effect if we reload from the file, and because a dry run on a
# laptop is a legitimate thing to do.
assert_same_checkout() { # name expected_cwd
  local name=$1 want=$2 file cfg pid live
  [ -n "$(snap_field "$SNAP_BEFORE" "$name" 2)" ] || return 0
  file=$(cfg_file "$name")
  cfg=$(cfg_key "$name" cwd "")
  if [ -n "$cfg" ] && [ "$cfg" != "$want" ]; then
    warn "$file says cwd=$cfg but this checkout is $want — reloading from that file would move the app to another directory"
    case " $CFG_CHANGED " in *" $name "*)
      die "$file changed in this deploy AND its cwd ($cfg) is not this checkout ($want). Reloading from it would point $name at a different tree. Fix cwd in that file first." ;;
    esac
  fi
  for pid in $(snap_pids "$SNAP_BEFORE" "$name"); do
    [ "$pid" = "0" ] && continue
    live=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || continue
    [ -n "$live" ] || continue
    if [ "$live" != "$want" ]; then
      die "pm2 is running $name (pid $pid) from $live, but this script was invoked from $want. Pulling here and reloading there is a deploy that reports success and ships nothing. Either run the deploy from $live, or point $name at this checkout and restart it there."
    fi
  done
}

# ── health gates ─────────────────────────────────────────────────────────────────
# A gate that passes on any HTTP answer would pass on the OLD process still draining, so
# each one waits for a specific ready body (the worker's /readyz returns 503 `draining`
# for its whole 25s budget, which curl -sf treats as a failure — exactly right).
wait_ready() { # url want timeout_s label
  local url=$1 want=$2 timeout=$3 label=$4 body="" code=""
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -z "$want" ]; then
      # Any 2xx/3xx means Next is serving: the dashboard root redirects to /login when
      # nobody is signed in, and a 200-only gate would wait out the whole timeout.
      code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null || true)
      case "$code" in 2??|3??) info "$label ready ($url → $code)"; return 0 ;; esac
    else
      body=$(curl -sf -m 5 "$url" 2>/dev/null || true)
      case "$body" in *"$want"*) info "$label ready ($url → $want)"; return 0 ;; esac
    fi
    sleep 1
  done
  printf '%s    last response: %s%s\n' "$D" "${body:-${code:-<no answer>}}" "$N" >&2
  return 1
}

# The outage guard from deploy/README.md, re-checked on every deploy: the pid pm2 tracks
# must be the app itself, with no child underneath it to be treekilled mid-drain.
assert_supervised_pid() { # name pid
  local name=$1 pid=$2 cmd="" kids=""
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then warn "$name has no pid after reload"; return 0; fi
  [ -r "/proc/$pid/cmdline" ] || return 0
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  case "$cmd" in
    *pnpm*|*"npm exec"*|*/bin/sh*|*node_modules/.bin/*)
      warn "$name: pm2 supervises a LAUNCHER, not the app — '$cmd'. This is the 2026-08-29 outage shape; fix $(cfg_file "$name") to exec node directly." ;;
  esac

  # A child only matters if it IS THE APP. That is the dangerous shape: pm2 signals a wrapper
  # and the process doing the work never hears it. Helpers the app spawns for ITSELF are noted
  # and ignored — tsx keeps an `esbuild --service` alive to transform TypeScript (seen on the
  # API, pid 1968642 on the first production deploy), and it holds no locks, no connections and
  # no state, so pm2 reaping it after the app has already drained costs nothing.
  #
  # This used to warn on any child at all, which failed a clean deploy over an esbuild helper.
  for kid in $(pgrep -P "$pid" 2>/dev/null || true); do
    kcmd=$(tr '\0' ' ' < "/proc/$kid/cmdline" 2>/dev/null || true)
    [ -n "$kcmd" ] || continue
    case "$kcmd" in
      *src/index.ts*|*src/server.ts*|*src/worker.ts*|*next/dist/bin/next*)
        warn "$name: THE APP is a CHILD (pid $kid) of pm2's pid $pid — a signal to pm2 will not reach it: $kcmd" ;;
      *)
        first=${kcmd%% *}
        dim "$name: helper child pid $kid (${first##*/}) — not the app, nothing to fix" ;;
    esac
  done
  return 0
}

# ── preflight (nothing is mutated above this line) ───────────────────────────────
step "Preflight"
command -v pm2  >/dev/null || die "pm2 is not on PATH"
command -v pnpm >/dev/null || die "pnpm is not on PATH (corepack enable && corepack prepare pnpm@9.15.4 --activate)"
command -v node >/dev/null || die "node is not on PATH"
[ -f "$REPO/.env" ] || die "$REPO/.env is missing — see deploy/README.md § 4"
info "repo:  $REPO"
info "pnpm:  $(pnpm --version)   node: $(node --version) (this shell)   pm2: $(pm2 --version 2>/dev/null | tail -1)"

pm2 ping >/dev/null 2>&1 || die "the pm2 daemon is not answering"
# A daemon started from a shell has nothing to bring it back after a reboot (D2).
daemon_pid=$(cat "${PM2_HOME:-$HOME/.pm2}/pm2.pid" 2>/dev/null || true)
if [ -n "$daemon_pid" ] && ! grep -q "pm2-$(id -un)\.service" "/proc/$daemon_pid/cgroup" 2>/dev/null; then
  warn "the pm2 daemon is not running under pm2-$(id -un).service — a reboot brings no app back. See deploy/README.md § 7."
fi
SNAP_BEFORE=$(pm2_snapshot) || die "could not read the pm2 process list"
# 2026-10-22: the API's recorded node had been deleted, so its reload started nothing.
require_live_node deploy/pm2 "$API" "$DASH" "$WORKER" || die "a pm2 app points at a deleted node — repair it as shown above"
MISSING=()
for app in "$API" "$DASH" "$WORKER"; do
  id=$(snap_field "$SNAP_BEFORE" "$app" 2); st=$(snap_field "$SNAP_BEFORE" "$app" 4)
  if [ -z "$id" ]; then MISSING+=("$app"); warn "$app is not registered with pm2 — it will be STARTED from its config (that mints a new pm2 id)"
  else info "$(printf '%-22s id=%-3s pid=%-8s %s' "$app" "$id" "$(snap_field "$SNAP_BEFORE" "$app" 3)" "$st")"
       [ "$st" = "online" ] || warn "$app is '$st', not online — reloading it will start it"
  fi
done

API_HOST=$(cfg_env "$API" HOST 127.0.0.1);        API_PORT=$(cfg_env "$API" PORT 4001)
WRK_HOST=$(cfg_env "$WORKER" WORKER_HEALTH_HOST 127.0.0.1); WRK_PORT=$(cfg_env "$WORKER" WORKER_HEALTH_PORT 4002)
DASH_PORT=$(cfg_port_arg "$DASH" 4101)
dim "probes: api http://$API_HOST:$API_PORT/readyz · dashboard http://127.0.0.1:$DASH_PORT/ · worker http://$WRK_HOST:$WRK_PORT/readyz"

# The hosts for the through-nginx check. Never hard-coded: this file ships, the hostnames do not.
NGINX_DOMAIN=${DEPLOY_CHECK_DOMAIN:-}
if [ -z "$NGINX_DOMAIN" ]; then
  NGINX_DOMAIN=$(grep -m1 '^[[:space:]]*DEPLOY_CHECK_DOMAIN=' "$REPO/.env" | cut -d= -f2- | sed "s/[[:space:]]*\$//; s/^[\"']//; s/[\"']\$//" || true)
fi
if [ -z "$NGINX_DOMAIN" ] && [ -f deploy/nginx/nginx.local ]; then
  NGINX_DOMAIN=$(sed -nE 's/^[[:space:]]*DOMAIN[[:space:]]*=[[:space:]]*"?([^"#[:space:]]*)"?.*/\1/p' deploy/nginx/nginx.local | head -1)
fi
[ "$NGINX_DOMAIN" = "example.com" ] && NGINX_DOMAIN=""
# host path rule — `ok` = must answer 2xx/3xx; `up` = anything but no answer or 502/503/504.
NGINX_CHECKS=()
if [ -n "$NGINX_DOMAIN" ]; then
  NGINX_CHECKS=("app.$NGINX_DOMAIN /login ok" "portal.$NGINX_DOMAIN /checkout up" "portal.$NGINX_DOMAIN /portal up")
  dim "nginx check: https://app.$NGINX_DOMAIN/login (2xx/3xx) · https://portal.$NGINX_DOMAIN/checkout + /portal (not 502/503/504), via --resolve <host>:443:127.0.0.1"
else
  warn "nginx check SKIPPED: set DEPLOY_CHECK_DOMAIN, or DOMAIN in deploy/nginx/nginx.local. The health gates reach the app directly and cannot see a 502 from nginx (deploy/README.md § 8)."
fi

# The node each app ACTUALLY runs, which is not necessarily the one in this shell — and which
# no reload will change. pm2 resolves `script: "node"` to an ABSOLUTE path at first start and
# stores it in pm_exec_path; measured with 22.15.1 on PATH against an app started under 20.18.2,
# `pm2 reload <name>`, `pm2 update` and even `pm2 reload <config.json>` all kept the old binary.
# Only `pm2 delete` + `pm2 start` re-resolves. So a Node upgrade that only reloads changes
# nothing, silently — and the build (next build, tsx for migrations) meanwhile runs under THIS
# shell's node, so a box can build on one major and serve on another without saying so.
check_node_runtime() {
  local want want_major pid bin ver mismatch=0
  want=$(tr -d 'v \n' < .node-version 2>/dev/null || true)
  [ -n "$want" ] || return 0
  want_major=${want%%.*}
  for app in "$API" "$DASH" "$WORKER"; do
    pid=$(snap_field "$SNAP_BEFORE" "$app" 3)
    if [ -z "$pid" ] || [ "$pid" = "0" ]; then continue; fi
    bin=$(readlink -f "/proc/$pid/exe" 2>/dev/null) || continue
    [ -x "$bin" ] || continue
    ver=$("$bin" --version 2>/dev/null) || continue
    local got_major=${ver#v}; got_major=${got_major%%.*}
    if [ "$got_major" != "$want_major" ]; then
      mismatch=1
      printf '    %-22s node %s   ← MAJOR mismatch, .node-version wants v%s\n' "$app" "$ver" "$want"
    elif [ "${ver#v}" != "$want" ]; then
      printf '    %-22s node %s   (patch differs from v%s)\n' "$app" "$ver" "$want"
    else
      printf '    %-22s node %s\n' "$app" "$ver"
    fi
  done
  [ "$mismatch" = 1 ] && warn "a running process is not on the node .node-version asks for (v$want). A reload will NOT change it — pm2 pinned the binary path at first start. See deploy/README.md § Upgrading Node on the box."
  return 0
}
check_node_runtime

assert_same_checkout "$API" "$REPO"
assert_same_checkout "$WORKER" "$REPO"
assert_same_checkout "$DASH" "$REPO/dashboard"

DIRTY_BEFORE=$(git status --porcelain --untracked-files=no || true)
if [ "$ALLOW_DIRTY" = 0 ] && [ -n "$DIRTY_BEFORE" ]; then
  git status --short --untracked-files=no | sed 's/^/    /' >&2
  die "the working tree has local modifications. Commit or discard them, or pass --allow-dirty. (Never stash on a deploy box — a failed scoped stash takes someone else's work.)"
fi

ROLLBACK_TO=$(git rev-parse HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
: "${REF:=$BRANCH}"
info "at $(git log -1 --format='%h %s' HEAD)"

# ── pull ─────────────────────────────────────────────────────────────────────────
if [ "$PULL" = 1 ]; then
  step "Fetch + fast-forward ($REF)"
  # The fetch runs EVEN IN A DRY RUN, and only the merge is withheld. It updates remote refs and
  # nothing else — no working tree, no branch — and without it a preview compares HEAD to HEAD
  # and reports "nothing to reload" while the remote is several commits ahead. That is what the
  # first --dry-run against a moved main did.
  #
  # Let git prompt for credentials only when a human is actually attached. From cron, CI or any
  # detached run there is nobody to type a PAT, and the default behaviour is to block forever on
  # a prompt nothing will ever display — so fail there instead, with a message.
  if [ -t 0 ]; then PROMPT=1; else PROMPT=0; fi
  GIT_TERMINAL_PROMPT=$PROMPT git fetch --quiet origin "$REF" \
    || die "git fetch origin $REF failed$([ "$PROMPT" = 0 ] && echo " (no terminal attached, so git could not ask for credentials)"). If this box talks to GitHub over HTTPS, a deploy should not need a password typed into it — switch the remote to SSH with a deploy key, or configure a credential helper. Check with: git -C $REPO remote -v"
  # --ff-only, never a merge: a deploy box must be a mirror of the ref, and a merge commit
  # created here exists nowhere else.
  if [ "$DRY" = 1 ]; then
    dim "would fast-forward to $(git log -1 --format='%h %s' FETCH_HEAD)"
  else
    git merge --ff-only FETCH_HEAD || die "cannot fast-forward $BRANCH onto origin/$REF — the box has diverged; resolve by hand"
  fi
else
  step "Skipping pull (--no-pull)"
fi
# In a dry run HEAD has not moved, so the range to preview ends at what WOULD be merged.
if [ "$DRY" = 1 ] && [ "$PULL" = 1 ]; then
  AFTER=$(git rev-parse FETCH_HEAD)
  [ "$ROLLBACK_TO" = "$AFTER" ] || info "would land on $(git log -1 --format='%h %s' "$AFTER")"
else
  AFTER=$(git rev-parse HEAD)
  [ "$ROLLBACK_TO" = "$AFTER" ] || info "now at $(git log -1 --format='%h %s' HEAD)"
fi

# Which range decides the scope, kept SEPARATE from where the tree was: --since moves the
# question without moving the rollback target the summary prints.
DIFF_FROM="$ROLLBACK_TO"
if [ -n "$SINCE" ]; then
  DIFF_FROM=$(git rev-parse "$SINCE") || die "--since: unknown ref '$SINCE'"
  info "change detection against --since $SINCE ($(git rev-parse --short "$DIFF_FROM"))"
fi

# ── what changed → what must reload ──────────────────────────────────────────────
# The engine reaches INTO the api layer in a few places (`VersionConflictError` from
# @/api/helpers today), so "src/api/** is API-only" is true of most files and false of
# some. Rather than trust a comment that will rot, read the imports out of the tree we
# just pulled and let the answer be current.
engine_reachable_api_files() {
  # BOTH quote styles. This matched double quotes only, and `src/modules/catalog/service.ts`
  # already imports `VersionConflictError` from '@/api/helpers' single-quoted — masked today
  # purely because three other services import the same file double-quoted. oxfmt is converting
  # the tree incrementally (51 of ~170 engine files are still single-quoted), so the next
  # engine→api dependency written that way would be the only reference and the worker would NOT
  # reload for code it runs. That direction ships a stale billing clock, which is worse than the
  # over-reload this function exists to prevent.
  #
  # Known limit, deliberately not papered over: this is ONE level. If an engine-reachable
  # `src/api/*` file ever imports a sibling out of `src/api/`, a change to that sibling will not
  # be seen here. True today (src/api/helpers.ts imports nothing from src/api) and worth
  # re-checking rather than trusting — `--all` is the answer whenever that is in doubt.
  grep -rhoE "from ['\"]@/api/[A-Za-z0-9_./-]+['\"]" src/modules src/platform src/providers 2>/dev/null \
    | sed -E "s|from ['\"]@/api/([A-Za-z0-9_./-]+)['\"]|src/api/\1.ts|" | sort -u
}
ENGINE_API_FILES=$(engine_reachable_api_files || true)

services_for() { # path → the processes that run this file
  if [ -n "${DEPLOY_SKIP_PATHS:-}" ] && grep -qE "$DEPLOY_SKIP_PATHS" <<<"$1"; then return 0; fi
  case "$1" in
    dashboard/*)                                   echo dashboard ;;
    # Documentation inside the ENGINE tree, and the migrations directory. Both fall into the
    # `src/*|db/*` catch-all below otherwise, because a bash `case` glob crosses `/` — so
    # `src/*` matches `src/modules/auth/README.md` at any depth. That is not theoretical:
    # measured over 134 commits, FOUR reloaded the billing clock for no reason but a README,
    # and `7628d4a7` changed nothing except `docs/PROGRESS.md` and one module README yet
    # reloaded both the API and the worker. CLAUDE.md requires appending to a module's
    # changelog whenever you touch it, so this fires on ordinary work, not rare commits.
    #
    # Migrations are applied by the `pnpm db:migrate` step above and are never opened by a
    # running process — `drizzle.config.ts` is the only thing that points at the directory.
    # A migration shipping alone (a backfill, an index) needs no reload at all.
    #
    # ⚠ ORDER MATTERS: these must stay BELOW `dashboard/*`. `dashboard/content/releases/*.md`
    # is markdown the dashboard SERVES — the /whats-new release notes — not documentation, and
    # a blanket `*.md` rule placed above would stop shipping it.
    src/*.md|db/*.md)                              ;;
    db/migrations/*)                               ;;
    src/index.ts)                                  echo api ;;
    src/worker.ts)                                 echo worker ;;
    src/api/*)  echo api
                grep -qxF "$1" <<<"$ENGINE_API_FILES" && echo worker || true ;;
    sdk/*)                                         echo api ;;          # routes serve openapi.json
    src/*|db/*|drizzle.config.ts|tsconfig.json)    echo api; echo worker ;;
    package.json|pnpm-lock.yaml|pnpm-workspace.yaml) echo api; echo dashboard; echo worker ;;
    deploy/pm2/tmbilling-api.json|deploy/pm2/tmbilling-api-cluster.json) echo api ;;
    deploy/pm2/tmbilling-dashboard.json)           echo dashboard ;;
    deploy/pm2/tmbilling-worker.json|deploy/pm2/tmbilling-worker-cluster.json) echo worker ;;
    # Loaded by both cluster configs at startup; the fork configs never read it.
    deploy/pm2/tsx-preload.mjs)                    echo api; echo worker ;;
    scripts/*|test/*|docs/*|deploy/*|.claude/*|.github/*|.vscode/*|.zed/*|.parity/*) ;;
    *.md|.gitignore|.oxlintrc.json|.oxfmtrc.json|lefthook.yml|vitest.config.ts|.env.example|.node-version|.nvmrc|docker-compose.yml) ;;
    *)  echo unknown ;;
  esac
}

RELOAD_API=0; RELOAD_DASH=0; RELOAD_WORKER=0
NEED_INSTALL=0; NEED_BUILD=0; NEED_GEO=0
CHANGED=""

if [ -n "$ONLY" ]; then
  step "Scope: --only $ONLY"
  IFS=, read -ra picks <<<"$ONLY"
  for p in "${picks[@]}"; do case "${p// /}" in
    api) RELOAD_API=1 ;; dashboard|dash) RELOAD_DASH=1 ;; worker) RELOAD_WORKER=1 ;;
    *) die "--only: unknown service '$p' (api,dashboard,worker)" ;;
  esac; done
  [ "$SKIP_BUILD" = 0 ] && [ "$RELOAD_DASH" = 1 ] && NEED_BUILD=1
elif [ "$FORCE_ALL" = 1 ]; then
  step "Scope: --all"
  RELOAD_API=1; RELOAD_DASH=1; RELOAD_WORKER=1; NEED_INSTALL=1; NEED_BUILD=1; NEED_GEO=1
else
  step "Scope: from the diff $(git rev-parse --short "$DIFF_FROM")..$(git rev-parse --short "$AFTER")"
  CHANGED=$(git diff --name-only "$DIFF_FROM" "$AFTER" || true)
  if [ -z "$CHANGED" ]; then
    info "no files changed — nothing to reload"
    printf '\n%s ✓ already deployed at %s%s\n' "$G" "$(git rev-parse --short HEAD)" "$N"
    info "to reload anyway: bash deploy/reload.sh --no-pull --all"
    exit 0
  fi
  # sed stops printing itself: a `| head` closes the pipe early, and pipefail turns the SIGPIPE into exit 141.
  printf '%s\n' "$CHANGED" | sed -n '1,40s/^/    /p'
  n=$(printf '%s\n' "$CHANGED" | grep -c . || true); [ "$n" -gt 40 ] && dim "… and $((n-40)) more"

  UNKNOWN=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    for svc in $(services_for "$f"); do case "$svc" in
      api) RELOAD_API=1 ;; dashboard) RELOAD_DASH=1 ;; worker) RELOAD_WORKER=1 ;;
      unknown) UNKNOWN="$UNKNOWN $f"; RELOAD_API=1; RELOAD_DASH=1; RELOAD_WORKER=1 ;;
    esac; done
    case "$f" in
      package.json|pnpm-lock.yaml|pnpm-workspace.yaml|dashboard/package.json) NEED_INSTALL=1 ;;
    esac
    case "$f" in dashboard/*) NEED_BUILD=1 ;; esac
    case "$f" in db/seed-data/geo.json) NEED_GEO=1 ;; esac
    # Recorded by APP name: `tmbilling-worker-cluster.json` configures the app `tmbilling-worker`,
    # and every reader matches on the app. Keyed on the file name, a changed cluster config was
    # reloaded by name and its new env silently ignored.
    case "$f" in deploy/pm2/*.json) cfg=$(basename "$f" .json); CFG_CHANGED="$CFG_CHANGED ${cfg%-cluster}" ;; esac
  done <<<"$CHANGED"

  [ -n "$UNKNOWN" ] && warn "unclassified path(s) —$UNKNOWN — reloading all three rather than guessing. Add a rule in services_for() if this recurs."
  [ "$NEED_INSTALL" = 1 ] && NEED_BUILD=1   # new deps can change the dashboard bundle
fi

[ "$SKIP_INSTALL" = 1 ] && NEED_INSTALL=0
[ "$SKIP_BUILD" = 1 ]   && NEED_BUILD=0
# Building without reloading would swap a new .next under a server still serving the old
# build id — the exact failure the staging build exists to avoid. They travel together.
[ "$NEED_BUILD" = 1 ] && RELOAD_DASH=1

plan=""
[ "$NEED_INSTALL" = 1 ] && plan="$plan install"
[ "$NEED_BUILD" = 1 ]   && plan="$plan build"
[ "$SKIP_MIGRATE" = 0 ] && plan="$plan migrate"
[ "$NEED_GEO" = 1 ]     && plan="$plan geo:seed"
[ "$RELOAD_API" = 1 ]   && plan="$plan reload:api"
[ "$RELOAD_DASH" = 1 ]  && plan="$plan reload:dashboard"
[ "$RELOAD_WORKER" = 1 ] && plan="$plan reload:worker"
info "plan:$plan"
# Say WHY a process is being left alone: "nothing changed" and "you excluded it" are
# different facts, and the whole point of this script is that the difference is visible.
if [ -n "$ONLY" ]; then SKIP_WHY="excluded by --only $ONLY"; else SKIP_WHY="nothing it runs changed"; fi
[ "$RELOAD_WORKER" = 0 ] && info "worker: NOT reloaded — $SKIP_WHY (uptime preserved)"
[ "$RELOAD_API" = 0 ]    && info "api: NOT reloaded — $SKIP_WHY"
[ "$RELOAD_DASH" = 0 ]   && info "dashboard: NOT reloaded — $SKIP_WHY"

if [ "$DRY" = 1 ]; then
  printf '\n%s ✓ dry run — nothing was changed%s\n' "$G" "$N"
  exit 0
fi

# ── build the new bits while the old processes keep serving ──────────────────────
if [ "$NEED_INSTALL" = 1 ]; then
  step "pnpm install --frozen-lockfile"
  # ROOT ONLY. Installing inside dashboard/ resurrects the second lockfile this workspace
  # exists to remove (pnpm-workspace.yaml).
  pnpm install --frozen-lockfile
fi

if [ "$NEED_BUILD" = 1 ]; then
  step "pnpm build (dashboard → .next.staging)"
  # Built into a STAGING directory so the live `next start` keeps serving the old .next,
  # untouched, for the whole build. An in-place `next build` deletes the build id the running
  # server is still handing out `/_next/static/<id>/…` for, which 404s chunks for anyone
  # mid-navigation for as long as the build takes — minutes.
  #
  # Verified rather than assumed: `next start` resolves distDir from next.config at RUNTIME,
  # so a tree built as `.next.staging` serves correctly once renamed to `.next` even though
  # `required-server-files.json` still records the staging name (measured: / → 307,
  # /login → 200, ready in 291ms).
  #
  # The swap itself is deferred to the reload step below — after the rename the old server
  # reads the new files by path, so that window must be as short as possible.
  rm -rf dashboard/.next.staging
  # …and the LIVE build's generated types, which are build-time only (`next start` never reads
  # `.next/types`) and are otherwise the one thing a staging build cannot clean up after.
  #
  # An in-place `next build` regenerates that directory and drops entries for routes that no
  # longer exist. Building elsewhere leaves it behind, still matched by
  # `.next/types/**/*.ts` in dashboard/tsconfig.json — so tsc type-checks a validator from the
  # PREVIOUS release. Measured on the box: moving `ops/page.tsx` into `ops/(hub)/page.tsx`
  # failed the build with `TS2307: Cannot find module '../../app/(dashboard)/ops/page.js'`,
  # a module the new tree correctly does not have. Invisible on a dev machine, where `.next`
  # holds dev types under `.next/dev/types` and no production validator exists at all.
  rm -rf dashboard/.next/types

  # CARRY THE CACHE FORWARD. Turbopack's compile cache and tsc's .tsbuildinfo both live
  # INSIDE distDir, so building into a directory we just deleted throws both away every
  # deploy — a cold build, every time, forever. Measured locally: compile 9.5s → 5.1s and
  # TypeScript 16.3s → 8.5s once the cache is there, from ~190MB of it.
  #
  # The live `.next/cache` is the previous deploy's, because the swap below renames staging
  # over `.next` — so seeding from it chains generation to generation. Copied, not hardlinked:
  # the old server is still serving out of `.next` and Turbopack rewrites cache entries in
  # place, which through a hardlink would corrupt the tree under the running process.
  if [ -d dashboard/.next/cache ]; then
    info "seeding the staging build's cache from the live one ($(du -sh dashboard/.next/cache | cut -f1))"
    mkdir -p dashboard/.next.staging
    cp -a dashboard/.next/cache dashboard/.next.staging/cache || warn "cache seed failed — the build will be cold, not wrong"
  fi

  NEXT_DIST_DIR=.next.staging pnpm build
  # BUILD_ID, not the directory: the cache seed above creates `.next.staging` before the build
  # runs, so a directory test would now pass for a build that produced nothing at all.
  [ -f dashboard/.next.staging/BUILD_ID ] || die "the build exited 0 but dashboard/.next.staging/BUILD_ID is not there"

  # `next build` AUTO-MANAGES dashboard/tsconfig.json: seeing a custom distDir it appends
  # `.next.staging/types/**/*.ts` to `include`. Those two lines are committed for exactly this
  # reason — otherwise the first deploy dirties a tracked file and the NEXT deploy refuses to
  # run. If a future Next writes something else, say so here, at the moment of cause, rather
  # than leaving it to look like an unexplained dirty tree tomorrow.
  if [ "$(git status --porcelain --untracked-files=no || true)" != "$DIRTY_BEFORE" ]; then
    warn "the build modified tracked file(s) — commit them or the next deploy will refuse to start:"
    git status --short --untracked-files=no | sed 's/^/      /' >&2
  fi
fi

if [ "$SKIP_MIGRATE" = 0 ]; then
  step "pnpm db:migrate"
  # Idempotent: a no-op when nothing is pending. Never db:push against production.
  # Migrations run as the table owner (`MIGRATION_DATABASE_URL`) when .env names one; the
  # app's own `DATABASE_URL` login owns nothing and cannot run DDL. dotenv never overrides a
  # variable already set, so this one takes precedence for this command only.
  MIGRATION_URL=$(grep -m1 '^[[:space:]]*MIGRATION_DATABASE_URL=' "$REPO/.env" | cut -d= -f2- | sed "s/^[\"']//; s/[\"']\$//" || true)
  if [ -n "$MIGRATION_URL" ]; then
    DATABASE_URL="$MIGRATION_URL" pnpm db:migrate
  else
    pnpm db:migrate
  fi
fi

if [ "$NEED_GEO" = 1 ]; then
  step "pnpm geo:seed"
  # BEFORE the reloads: the reference set is read once at boot, so a process started
  # against stale tables serves stale data until it is restarted again.
  pnpm geo:seed
fi

# ── reload, health-gated, worker last ────────────────────────────────────────────
# `pm2 reload <name>` (not a config file, and no --update-env) so the app keeps the
# environment it was started with: the engine reads .env itself via dotenv, and dotenv does
# not override what is already set — so leaking this shell's variables in would silently
# outrank .env. When the app's own pm2 config changed, reload from the FILE instead, which
# is the only way to pick up a new env key. Both paths keep the pm2 id.
reload_one() { # name
  local name=$1 args=("$1")
  case " $CFG_CHANGED " in *" $name "*) args=("$(cfg_file "$name")"); info "its pm2 config changed — reloading from $(cfg_file "$name")" ;; esac
  if [ -z "$(snap_field "$SNAP_BEFORE" "$name" 2)" ]; then
    pm2 start "$(cfg_file "$name")"
  else
    pm2 reload "${args[@]}"
  fi
}

RELOADED=()

if [ "$RELOAD_API" = 1 ]; then
  step "Reload $API"
  reload_one "$API"
  wait_ready "http://$API_HOST:$API_PORT/readyz" '"ready"' 90 "$API" \
    || die "$API did not come back ready. It is serving the NEW code or nothing at all — check: pm2 logs $API --lines 80 --nostream. Neither the dashboard nor the worker was touched."
  RELOADED+=("$API")
fi

if [ "$RELOAD_DASH" = 1 ]; then
  step "Reload $DASH"
  if [ -d dashboard/.next.staging ]; then
    # Two renames, immediately before the reload: from here until the new server is up the old
    # one is reading the new build's files by path, and that window is what this ordering
    # exists to keep down to milliseconds instead of the length of a build.
    info "swapping in the new build (previous one kept as dashboard/.next.prev)"
    rm -rf dashboard/.next.prev
    if [ -d dashboard/.next ]; then mv dashboard/.next dashboard/.next.prev; fi
    mv dashboard/.next.staging dashboard/.next
  fi
  reload_one "$DASH"
  wait_ready "http://127.0.0.1:$DASH_PORT/" "" 90 "$DASH" \
    || die "$DASH did not answer. Check: pm2 logs $DASH --lines 80 --nostream. The worker was NOT touched."
  RELOADED+=("$DASH")
fi

if [ "$RELOAD_WORKER" = 1 ]; then
  step "Reload $WORKER (last — this is the billing clock)"
  # kill_timeout is 35s against a 25s self-bounded drain, so allow well past both before
  # calling it a failure. The gap logs as tick_clock_gap — a warning by design, not a page:
  # every pass re-scans, so a missed minute is deferred, not lost.
  # In cluster mode (tmbilling-worker-cluster.json) there is no gap: the new worker is ready
  # before the old one is signalled, and `pm2 reload` returns once the old one has drained
  # (up to 30 min for a long job).
  reload_one "$WORKER"
  wait_ready "http://$WRK_HOST:$WRK_PORT/readyz" '"ready"' 150 "$WORKER" \
    || die "$WORKER did not come back ready — BILLING IS STOPPED until it does. Check: pm2 logs $WORKER --lines 80 --nostream, then curl -s http://$WRK_HOST:$WRK_PORT/readyz"
  RELOADED+=("$WORKER")
fi

# ── prove the invariants rather than assume them ─────────────────────────────────
step "Verify"
SNAP_AFTER=$(pm2_snapshot)
for app in "$API" "$DASH" "$WORKER"; do
  before_ids=$(snap_ids "$SNAP_BEFORE" "$app");  after_ids=$(snap_ids "$SNAP_AFTER" "$app")
  before_pids=$(snap_pids "$SNAP_BEFORE" "$app"); after_pids=$(snap_pids "$SNAP_AFTER" "$app")
  count=$(snap_count "$SNAP_AFTER" "$app")
  status=$(snap_field "$SNAP_AFTER" "$app" 4)
  reloaded=no; case " ${RELOADED[*]-} " in *" $app "*) reloaded=yes ;; esac

  # The id set, not one id: a cluster app is N rows under one name.
  if [ -n "$before_ids" ] && [ "$before_ids" != "$after_ids" ]; then
    warn "$app: pm2 id(s) CHANGED [$before_ids] → [$after_ids]. Something deleted and re-added the app; only reload/restart should have run."
  fi

  if [ "$reloaded" = yes ]; then
    # Every pid must be new. A rolling cluster reload replaces them one at a time, so
    # "some pid survived" is the honest test for "the reload did not take" in both modes.
    survivors=""
    for bp in $before_pids; do
      [ "$bp" = "0" ] && continue
      case " $after_pids " in *" $bp "*) survivors="$survivors $bp" ;; esac
    done
    [ -n "$survivors" ] && warn "$app: pid(s)$survivors survived the reload — it did not take for those instances"
    for ap in $after_pids; do assert_supervised_pid "$app" "$ap"; done
  fi

  printf '    %-22s id=%-7s pid=%-18s %-8s %s\n' "$app" "${after_ids% }" "${after_pids% }" "$status" \
    "$([ "$reloaded" = yes ] && echo "reloaded${D}$([ "${count:-1}" -gt 1 ] && echo " · $count instances")${N}" || echo "${D}untouched${N}")"
done

# Only when the process list itself changed shape does the saved dump need rewriting.
if [ ${#MISSING[@]} -gt 0 ] || [ -n "$CFG_CHANGED" ]; then
  step "pm2 save"
  pm2 save
fi

# ── through nginx, as Cloudflare's traffic arrives ───────────────────────────────
# The gates above reach 127.0.0.1 directly. On 2026-10-28 they all passed while nginx answered
# 502: the dashboard's headers had outgrown nginx's proxy_buffer_size (deploy/README.md § 8).
if [ ${#NGINX_CHECKS[@]} -gt 0 ]; then
  step "Check through nginx"
  NGINX_FAILED=()
  for c in "${NGINX_CHECKS[@]}"; do
    read -r host path rule <<<"$c"
    for _ in 1 2 3; do
      out=$(curl -sk -o /dev/null -m 10 -w '%{http_code} %{size_header}' \
        --resolve "$host:443:127.0.0.1" "https://$host$path" 2>/dev/null) || true
      code=${out%% *}; bytes=${out##* }; code=${code:-000}
      case "$rule:$code" in
        ok:2??|ok:3??) pass=1 ;;
        up:000|up:502|up:503|up:504|ok:*) pass=0 ;;
        *) pass=1 ;;
      esac
      [ "$pass" = 1 ] && break
      sleep 2
    done
    if [ "$pass" = 1 ]; then
      info "$(printf '%-44s %s  (%s header bytes)' "https://$host$path" "$code" "${bytes:-?}")"
      # Half of the 16k proxy_buffer_size: the headroom verify:security § C2 holds the config to.
      [ "${bytes:-0}" -gt 8192 ] 2>/dev/null \
        && warn "https://$host$path sent $bytes header bytes, over half of nginx's 16k proxy_buffer_size"
    else
      printf '%s    %-44s %s%s\n' "$R" "https://$host$path" "$code" "$N" >&2
      NGINX_FAILED+=("https://$host$path → $code")
    fi
  done
  if [ ${#NGINX_FAILED[@]} -gt 0 ]; then
    die "the NGINX path failed, not the app: ${NGINX_FAILED[*]}. $DASH answered on 127.0.0.1:$DASH_PORT. Check: sudo tail -n 50 /var/log/nginx/error.log — 'upstream sent too big header' means proxy_buffer_size (deploy/README.md § 8)."
  fi
fi

# ── summary ──────────────────────────────────────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_TS ))
# With --since the tree did not move here, so ROLLBACK_TO is HEAD and printing it twice says
# nothing. The range that was actually deployed — and the state to go back to — is DIFF_FROM.
FROM=$ROLLBACK_TO
[ -n "$SINCE" ] && FROM=$DIFF_FROM
printf '\n%s%s deployed %s → %s in %ss%s\n' "$B" "$G" "$(git rev-parse --short "$FROM")" "$(git rev-parse --short "$AFTER")" "$ELAPSED" "$N"
info "reloaded: ${RELOADED[*]:-nothing}"
[ "$RELOAD_WORKER" = 1 ] && dim "the worker gap logs as tick_clock_gap (warn, not a page) — every pass re-scans, so due work is deferred, not lost"
info "rollback: git -C $REPO reset --hard $FROM && bash deploy/reload.sh --no-pull --all"
[ -d dashboard/.next.prev ] && dim "the previous dashboard build is still on disk (dashboard/.next.prev) if you need it back before a rebuild finishes"
[ "$SKIP_MIGRATE" = 0 ] && dim "note: applied migrations are NOT undone by that rollback — check db/migrations if the diff contained any"

if [ ${#WARNINGS[@]} -gt 0 ]; then
  printf '\n%s%s warning(s):%s\n' "$Y" "${#WARNINGS[@]}" "$N"
  for w in "${WARNINGS[@]}"; do printf '    · %s\n' "$w"; done
  exit 3
fi
